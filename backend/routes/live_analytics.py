"""
Live Visitor Analytics — heartbeat-based real-time visitor monitoring with
geo-location, page history, basket contents, and admin → visitor messaging.

Architecture (intentionally simple, polling-based, zero WebSocket dependency):

  Visitor side
    ─ useVisitorBeacon.js POSTs /heartbeat every 30s with:
        session_id, path, cart_summary (count + value + top items)
    ─ The heartbeat *response* contains pending admin messages, marked as
      delivered server-side once the visitor sees them.
    ─ A floating chat bubble (AdminLiveMessage.jsx) renders messages.

  Admin side
    ─ /admin/live-visitors lists active sessions (cached IP-geo, top page).
    ─ Click a row → detail modal with:
        - UK map pin (lat/lon from cached geo lookup)
        - per-page time-on-page history (from `page_history` array)
        - basket contents (from cart_summary)
        - message composer to send a real-time note to the visitor.

GDPR note: this records IP, country/region/city, and cart contents tied to a
short-lived session. TTL of 90s on `live_visitors` means the data evaporates
quickly. Privacy policy should mention live monitoring for support.
"""
import logging
import math
import re
import asyncio
from datetime import datetime, timezone, timedelta
from typing import Optional, List

import httpx
from fastapi import APIRouter, Depends, Request, HTTPException, BackgroundTasks
from pydantic import BaseModel, Field

from config import get_db
from services import get_current_user

router = APIRouter(prefix="/live-analytics", tags=["Live Visitor Analytics"])
logger = logging.getLogger(__name__)

ACTIVE_WINDOW_SECONDS = 90
GEO_CACHE_TTL_HOURS = 24
MAX_PAGE_HISTORY = 30   # cap per session so docs don't grow unbounded

# Cached showroom coordinates. Built lazily on first access by extracting the
# postcode from each showroom's `address` string and forward-geocoding via
# postcodes.io. Refreshes if the showrooms collection changes.
_showroom_coords_cache: List[dict] = []
_showroom_coords_cache_built_at: Optional[datetime] = None
_SHOWROOM_CACHE_TTL_SECONDS = 60 * 60  # rebuild hourly so admin edits propagate
_SHOWROOM_LOCK = asyncio.Lock()

_ttl_index_ensured = False


async def _ensure_indexes():
    """Idempotently ensure TTL + helper indexes."""
    global _ttl_index_ensured
    if _ttl_index_ensured:
        return
    db = get_db()
    try:
        await db.live_visitors.create_index("last_seen", expireAfterSeconds=ACTIVE_WINDOW_SECONDS)
    except Exception as e:
        logger.warning(f"[live-analytics] live_visitors TTL index: {e}")
    try:
        # Messages auto-purge 5 min after delivery so the collection doesn't grow forever
        await db.live_visitor_messages.create_index("expires_at", expireAfterSeconds=0)
    except Exception as e:
        logger.warning(f"[live-analytics] messages TTL index: {e}")
    try:
        await db.live_visitor_messages.create_index([("session_id", 1), ("delivered", 1)])
    except Exception as e:
        logger.warning(f"[live-analytics] messages compound index: {e}")
    try:
        await db.ip_geo_cache.create_index("cached_at", expireAfterSeconds=GEO_CACHE_TTL_HOURS * 3600)
    except Exception as e:
        logger.warning(f"[live-analytics] ip_geo_cache TTL index: {e}")
    try:
        # Pending precise-locations auto-purge after 10 min if no heartbeat
        # ever drains them (visitor closed tab before sending one).
        await db.pending_precise_locations.create_index("queued_at", expireAfterSeconds=600)
        await db.pending_precise_locations.create_index("session_id", unique=True)
    except Exception as e:
        logger.warning(f"[live-analytics] pending_precise_locations index: {e}")
    # One-time cleanup of orphan live_visitors docs left behind by the bug
    # in the 2026-04-29 deploy where precise-location upserted docs without
    # a `path` field. Filtering them is enough (count_documents excludes
    # them) but deleting also frees the TTL noise. Idempotent.
    try:
        result = await db.live_visitors.delete_many({
            "$or": [
                {"path": {"$exists": False}},
                {"path": None},
                {"path": ""},
            ],
            "user_agent": {"$exists": False},
        })
        if result.deleted_count:
            logger.info(f"[live-analytics] cleaned {result.deleted_count} orphan live_visitors docs")
    except Exception as e:
        logger.warning(f"[live-analytics] orphan cleanup skipped: {e}")
    _ttl_index_ensured = True


class CartSummaryItem(BaseModel):
    name: str = Field("", max_length=200)
    qty: float = Field(0)
    price: float = Field(0)


class CartSummary(BaseModel):
    items_count: int = Field(0)
    value: float = Field(0)
    top_items: List[CartSummaryItem] = Field(default_factory=list)


class HeartbeatPayload(BaseModel):
    session_id: str = Field(..., min_length=4, max_length=64)
    path: str = Field("", max_length=500)
    referrer: Optional[str] = Field(default=None, max_length=500)
    user_agent: Optional[str] = Field(default=None, max_length=500)
    cart_summary: Optional[CartSummary] = None


def _normalise_path(path: str) -> str:
    p = (path or "/").split("?")[0].split("#")[0] or "/"
    if len(p) > 200:
        p = p[:200]
    rules = [
        (r"^/shop/collection/[^/]+/?.*", "/shop/collection/:slug"),
        (r"^/shop/tile/[^/]+/?.*", "/shop/tile/:slug"),
        (r"^/tiles/[^/]+/?$", "/tiles/:slug"),
        (r"^/shop/order-success.*", "/shop/order-success"),
        (r"^/admin/online-orders/[^/]+/?$", "/admin/online-orders/:id"),
    ]
    for pattern, replacement in rules:
        if re.match(pattern, p):
            return replacement
    return p


async def _lookup_geo(ip: str) -> Optional[dict]:
    """
    Look up coarse geo (country, region, city, lat/lon, isp) for an IP.
    Uses ipwho.is — free, HTTPS, no key, ~10k/month limit per server IP.
    Result is cached for 24h in `ip_geo_cache`.
    """
    if not ip or ip.startswith("127.") or ip.startswith("10.") or ip.startswith("192.168."):
        return None  # don't waste lookups on local/private IPs
    db = get_db()
    cached = await db.ip_geo_cache.find_one({"ip": ip}, {"_id": 0})
    if cached and cached.get("data"):
        return cached["data"]
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            r = await client.get(f"https://ipwho.is/{ip}")
            if r.status_code != 200:
                return None
            data = r.json()
            if not data.get("success"):
                return None
            geo = {
                "ip": ip,
                "country": data.get("country", ""),
                "country_code": data.get("country_code", ""),
                "region": data.get("region", ""),
                "city": data.get("city", ""),
                "lat": data.get("latitude"),
                "lon": data.get("longitude"),
                "flag_emoji": data.get("flag", {}).get("emoji", ""),
                "isp": (data.get("connection") or {}).get("isp", ""),
                "timezone": (data.get("timezone") or {}).get("id", ""),
            }
            await db.ip_geo_cache.update_one(
                {"ip": ip},
                {"$set": {"ip": ip, "data": geo, "cached_at": datetime.now(timezone.utc)}},
                upsert=True,
            )
            return geo
    except Exception as e:
        logger.warning(f"[live-analytics] geo lookup failed for {ip}: {e}")
        return None


async def _resolve_geo_background(ip: str):
    """Background task wrapper so heartbeat doesn't block on geo lookup."""
    try:
        await _lookup_geo(ip)
    except Exception:
        pass


@router.post("/heartbeat")
async def heartbeat(payload: HeartbeatPayload, request: Request, background_tasks: BackgroundTasks):
    """
    Public — visitor pings every 30s. Returns:
      { ok, pending_messages: [...] }
    Pending messages are marked as `delivered=true` on the way out so the
    visitor only sees them once.
    """
    await _ensure_indexes()
    db = get_db()
    now = datetime.now(timezone.utc)

    client_ip = (
        request.headers.get("x-forwarded-for", "").split(",")[0].strip()
        or request.headers.get("x-real-ip", "")
        or (request.client.host if request.client else "")
    )[:64]

    # ── UK-ONLY HARD LOCKDOWN (12 May 2026) ─────────────────────────
    # Tile Station is UK-only. Reject non-UK heartbeats at the boundary
    # so they never enter `live_visitors`. Otherwise bots from AWS
    # us-east-1 (Ashburn) keep showing up in the Live Visitors admin
    # panel even though page_views correctly rejects them.
    #
    # Trust CF-IPCountry first (Cloudflare-set, accurate). Fall back to
    # the cached geo's country_code if Cloudflare header is missing.
    cf_country = (request.headers.get("CF-IPCountry") or "").upper().strip()
    if cf_country and cf_country != "GB":
        return {"ok": True, "skipped": True, "reason": "non_uk_visitor",
                "pending_messages": []}

    new_path = payload.path or "/"

    # Attempt to read geo from cache synchronously (fast); kick off lookup in
    # background if missing. So the very first heartbeat per IP has no geo,
    # but the next one does.
    geo = None
    if client_ip:
        cached = await db.ip_geo_cache.find_one({"ip": client_ip}, {"_id": 0, "data": 1})
        if cached:
            geo = cached.get("data")
        else:
            background_tasks.add_task(_resolve_geo_background, client_ip)

    # Secondary UK guard — if Cloudflare didn't set the header but we have
    # cached geo data, use it to reject non-UK heartbeats. Keeps the lock
    # tight for direct-to-backend traffic that bypasses Cloudflare.
    if not cf_country and geo:
        cached_cc = (geo.get("country_code") or "").upper().strip()
        cached_name = (geo.get("country") or "").lower().strip()
        is_uk = (
            cached_cc == "GB"
            or cached_name in (
                "united kingdom", "uk", "great britain",
                "england", "scotland", "wales", "northern ireland",
            )
        )
        if cached_cc and not is_uk:
            return {"ok": True, "skipped": True, "reason": "non_uk_visitor",
                    "pending_messages": []}

    cart_dict = payload.cart_summary.model_dump() if payload.cart_summary else None

    # Same visitor_id formula as analytics.py so admin-tagged "known devices"
    # can be matched across both subsystems.
    import hashlib
    ua_for_id = (payload.user_agent or request.headers.get("user-agent") or "")[:300]
    visitor_id = hashlib.sha256(f"{client_ip}:{ua_for_id}".encode()).hexdigest()[:16] if client_ip else ""

    # Read existing doc to update page_history correctly
    existing = await db.live_visitors.find_one({"session_id": payload.session_id}, {"_id": 0})
    page_history = (existing or {}).get("page_history") or []

    if page_history and page_history[-1].get("path") == new_path:
        # Same page as last entry — just bump its last_seen.
        page_history[-1]["last_seen"] = now.isoformat()
    else:
        # New page — close the previous entry's last_seen (already done) and append.
        page_history.append({
            "path": new_path,
            "path_normalised": _normalise_path(new_path),
            "entered_at": now.isoformat(),
            "last_seen": now.isoformat(),
        })
        if len(page_history) > MAX_PAGE_HISTORY:
            page_history = page_history[-MAX_PAGE_HISTORY:]

    update_doc = {
        "session_id": payload.session_id,
        "visitor_id": visitor_id,
        "path": new_path,
        "path_normalised": _normalise_path(new_path),
        "referrer": payload.referrer or "",
        "user_agent": payload.user_agent or request.headers.get("user-agent", ""),
        "ip": client_ip,
        "geo": geo,
        "cart_summary": cart_dict,
        "page_history": page_history,
        "last_seen": now,
    }
    try:
        await db.live_visitors.update_one(
            {"session_id": payload.session_id},
            {"$set": update_doc, "$setOnInsert": {"first_seen": now}},
            upsert=True,
        )
        # Drain any precise-location that was queued before this heartbeat
        # arrived (e.g. cookie-persist restore from a previous visit).
        try:
            pending = await db.pending_precise_locations.find_one_and_delete(
                {"session_id": payload.session_id},
                {"_id": 0, "geo_precise": 1},
            )
            if pending and pending.get("geo_precise"):
                await db.live_visitors.update_one(
                    {"session_id": payload.session_id},
                    {"$set": {"geo_precise": pending["geo_precise"]}},
                )
        except Exception as e:
            logger.debug(f"[live-analytics] pending precise-location drain skipped: {e}")
    except Exception as e:
        logger.warning(f"[live-analytics] heartbeat upsert failed: {e}")
        return {"ok": False, "pending_messages": []}

    # ── Telegram alert: customer added something to basket ──
    # Fire when cart_count just went UP (delta > 0). Deduped by (session, count)
    # so we don't spam if the same heartbeat hits the endpoint twice.
    # Tagged staff devices (e.g. "Edmonton iPad", "Qasim's laptop") are
    # silently skipped — they're for observing site behavior, not for
    # buzzing the owner's phone every time a colleague clicks "Add to basket".
    try:
        prev_count = ((existing or {}).get("cart_summary") or {}).get("items_count", 0) or 0
        new_count = (cart_dict or {}).get("items_count", 0) or 0
        if new_count > prev_count:
            is_tagged_device = False
            if visitor_id:
                tag_doc = await db.known_devices.find_one(
                    {"visitor_id": visitor_id, "exclude_from_stats": True},
                    {"_id": 0, "label": 1},
                )
                is_tagged_device = bool(tag_doc)
            if not is_tagged_device:
                # UK-only hard lock (12 May 2026) — basket-add alerts
                # must NOT fire for non-UK sessions.
                geo_cc = (geo or {}).get("country_code") or ""
                geo_name = ((geo or {}).get("country") or "").lower()
                is_uk = (
                    geo_cc.upper() == "GB"
                    or geo_name in ("united kingdom", "uk", "great britain",
                                    "england", "scotland", "wales", "northern ireland")
                )
                if is_uk:
                    from services.telegram_notify import fire_and_forget
                    new_value = (cart_dict or {}).get("value", 0) or 0
                    where = (geo or {}).get("city") or (geo or {}).get("country") or "Unknown"
                    page = update_doc.get("path") or "/"
                    text = (
                        "<b>🛒 Item added to basket</b>\n"
                        f"<b>On page:</b> {page}\n"
                        f"<b>Basket now:</b> {new_count} item{'' if new_count == 1 else 's'} · £{new_value:.2f}\n"
                        f"<b>Where:</b> {where}\n"
                        f"<b>Session:</b> {payload.session_id[:10]}…"
                    )
                    dedupe_key = f"basket_add:{payload.session_id}:{new_count}"
                    fire_and_forget("basket_add", text, dedupe_key=dedupe_key)
    except Exception as exc:
        logger.debug(f"[live-analytics] basket_add Telegram skipped: {exc}")

    # Drain pending admin messages for this session
    pending: List[dict] = []
    try:
        cursor = db.live_visitor_messages.find(
            {"session_id": payload.session_id, "delivered": False},
            {"_id": 0, "id": 1, "message": 1, "from_name": 1, "created_at": 1},
        ).sort("created_at", 1)
        async for m in cursor:
            pending.append({
                "id": m.get("id"),
                "message": m.get("message"),
                "from_name": m.get("from_name") or "Tile Station",
                "created_at": m.get("created_at").isoformat() if isinstance(m.get("created_at"), datetime) else m.get("created_at"),
            })
        if pending:
            ids = [m["id"] for m in pending]
            await db.live_visitor_messages.update_many(
                {"id": {"$in": ids}},
                {"$set": {
                    "delivered": True,
                    "delivered_at": now,
                    # Auto-purge 5 minutes after delivery so the collection self-cleans
                    "expires_at": now + timedelta(minutes=5),
                }},
            )
    except Exception as e:
        logger.warning(f"[live-analytics] message drain failed: {e}")

    return {"ok": True, "pending_messages": pending}



# ===== Precise location (browser GPS or postcode form capture) =====
# Free, UK-only, no key. ~10 ms response, infra hosted by .gov.uk.
_POSTCODES_IO_URL = "https://api.postcodes.io"
_UK_POSTCODE_RE = re.compile(
    r"^([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})$",
    re.IGNORECASE,
)


def _normalise_uk_postcode(raw: str) -> Optional[str]:
    """Returns canonical 'AB1 2CD' or None if it doesn't look like a UK postcode."""
    if not raw:
        return None
    m = _UK_POSTCODE_RE.match(str(raw).strip())
    if not m:
        return None
    return f"{m.group(1).upper()} {m.group(2).upper()}"


def _haversine_miles(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in miles between two lat/lon points."""
    R = 3958.7613  # Earth radius in miles
    rlat1, rlat2 = math.radians(lat1), math.radians(lat2)
    dlat = rlat2 - rlat1
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlon / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


async def _build_showroom_coords_cache(db) -> List[dict]:
    """Pulls showrooms from `showrooms` collection (or fallback list), extracts
    the UK postcode from each address, and forward-geocodes via postcodes.io.
    Cached process-locally for an hour so admin edits propagate without a
    backend restart."""
    showrooms_in_db = []
    try:
        async for doc in db.showrooms.find({}, {"_id": 0}):
            showrooms_in_db.append(doc)
    except Exception as e:
        logger.warning(f"[live-analytics] showrooms find failed: {e}")

    # Use the same fallback as `routes/shop.py::get_shop_stores` so the feature
    # works on a fresh DB before any showroom is inserted.
    if not showrooms_in_db:
        showrooms_in_db = [
            {"id": "tonbridge", "name": "Tonbridge", "address": "Unit 2, Cannon Business Park, Cannon Lane, Tonbridge, TN9 1PP", "phone": "01732 424242"},
            {"id": "gravesend", "name": "Gravesend", "address": "Unit 1-2, Imperial Business Estate, Gravesend, DA12 5ND", "phone": "01474 352525"},
            {"id": "chingford", "name": "Chingford", "address": "Unit 1, Chingford Industrial Centre, Hall Lane, London, E4 8DJ", "phone": "020 8527 4747"},
            {"id": "sydenham", "name": "Sydenham", "address": "329-331 Sydenham Road, London, SE26 5EQ", "phone": "020 8778 9797"},
        ]

    out: List[dict] = []
    for s in showrooms_in_db:
        address = s.get("address") or ""
        # Prefer the dedicated `postcode` field if the doc has one (the
        # current production schema does), then fall back to extracting
        # from the address string.
        pc = _normalise_uk_postcode(s.get("postcode") or "")
        if not pc:
            matches = re.findall(r"[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}", address.upper())
            if matches:
                pc = _normalise_uk_postcode(matches[-1])
        if not pc:
            continue
        # Use stored lat/lon if the doc already has them (admin override path),
        # otherwise look up via postcodes.io.
        lat = s.get("lat")
        lon = s.get("lon")
        if not (isinstance(lat, (int, float)) and isinstance(lon, (int, float))):
            geo = await _postcodes_io_lookup_postcode(pc)
            if not geo:
                continue
            lat = geo.get("lat")
            lon = geo.get("lon")
        if lat is None or lon is None:
            continue
        out.append({
            "id": s.get("id") or s.get("name", "").lower(),
            "name": s.get("name"),
            "address": address,
            "phone": s.get("phone"),
            "postcode": pc,
            "lat": float(lat),
            "lon": float(lon),
        })
    return out


async def _get_showroom_coords(db) -> List[dict]:
    """Cached wrapper around `_build_showroom_coords_cache` with a 1h TTL."""
    global _showroom_coords_cache, _showroom_coords_cache_built_at
    now = datetime.now(timezone.utc)
    if _showroom_coords_cache_built_at and (now - _showroom_coords_cache_built_at).total_seconds() < _SHOWROOM_CACHE_TTL_SECONDS:
        return _showroom_coords_cache
    async with _SHOWROOM_LOCK:
        # Double-check after acquiring the lock
        if _showroom_coords_cache_built_at and (now - _showroom_coords_cache_built_at).total_seconds() < _SHOWROOM_CACHE_TTL_SECONDS:
            return _showroom_coords_cache
        _showroom_coords_cache = await _build_showroom_coords_cache(db)
        _showroom_coords_cache_built_at = now
        return _showroom_coords_cache


async def find_nearest_showroom(db, lat: float, lon: float) -> Optional[dict]:
    """Returns the closest showroom to the given lat/lon, including
    `distance_miles`. Returns None if we have no showrooms with coordinates."""
    showrooms = await _get_showroom_coords(db)
    if not showrooms:
        return None
    best: Optional[dict] = None
    best_dist = float("inf")
    for s in showrooms:
        d = _haversine_miles(lat, lon, s["lat"], s["lon"])
        if d < best_dist:
            best_dist = d
            best = {**s, "distance_miles": round(d, 1)}
    return best


async def _postcodes_io_lookup_postcode(postcode: str) -> Optional[dict]:
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            r = await client.get(f"{_POSTCODES_IO_URL}/postcodes/{postcode.replace(' ', '')}")
            if r.status_code != 200:
                return None
            j = r.json() or {}
            res = j.get("result") or {}
            if not res:
                return None
            return {
                "postcode": res.get("postcode"),
                "town": res.get("admin_ward") or res.get("parish") or res.get("admin_district"),
                "district": res.get("admin_district"),
                "county": res.get("admin_county") or res.get("region"),
                "lat": res.get("latitude"),
                "lon": res.get("longitude"),
            }
    except Exception as e:
        logger.warning(f"[live-analytics] postcodes.io postcode lookup failed: {e}")
        return None


async def _postcodes_io_reverse_geo(lat: float, lon: float) -> Optional[dict]:
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            r = await client.get(
                f"{_POSTCODES_IO_URL}/postcodes",
                params={"lat": lat, "lon": lon, "limit": 1, "radius": 2000},
            )
            if r.status_code != 200:
                return None
            j = r.json() or {}
            results = j.get("result") or []
            if not results:
                return None
            res = results[0]
            return {
                "postcode": res.get("postcode"),
                "town": res.get("admin_ward") or res.get("parish") or res.get("admin_district"),
                "district": res.get("admin_district"),
                "county": res.get("admin_county") or res.get("region"),
                "lat": res.get("latitude"),
                "lon": res.get("longitude"),
            }
    except Exception as e:
        logger.warning(f"[live-analytics] postcodes.io reverse-geo failed: {e}")
        return None


class PreciseLocationPayload(BaseModel):
    session_id: str = Field(..., min_length=4, max_length=80)
    # Optional second id from usePageTracking.js (analytics_session_id) so we
    # can also tag the persistent page_views rows used by Visitor History.
    page_tracking_session_id: Optional[str] = Field(None, max_length=80)
    source: str = Field(..., pattern=r"^(browser|form)$")
    lat: Optional[float] = None
    lon: Optional[float] = None
    accuracy_m: Optional[float] = None  # browser-reported accuracy in metres
    postcode: Optional[str] = None


@router.post("/precise-location")
async def precise_location(payload: PreciseLocationPayload):
    """Public — visitor opt-in. Records a precise location for the current
    session, replacing the (often coarse) IP-based geo. Two paths:
      1. Browser GPS — `source='browser'`, lat+lon. Reverse-geocoded to a UK
         postcode/town via postcodes.io (free .gov.uk infra).
      2. Form postcode — `source='form'`, postcode. Validated + forward-geocoded
         to lat/lon/town via postcodes.io.

    Stored on `live_visitors.geo_precise = {town, postcode, lat, lon, source,
    accuracy_m, recorded_at}` so the admin Live Visitors panel can show a
    'precise' badge instead of the misleading 100-mile-off ISP location.
    """
    db = get_db()

    enrichment: Optional[dict] = None
    if payload.source == "browser":
        if payload.lat is None or payload.lon is None:
            raise HTTPException(status_code=400, detail="lat and lon required for source=browser")
        # Reject crazy out-of-UK coords up-front so we don't waste a lookup;
        # postcodes.io will return empty for non-UK anyway.
        enrichment = await _postcodes_io_reverse_geo(float(payload.lat), float(payload.lon))
        if not enrichment:
            return {"ok": False, "reason": "no_uk_match"}
    else:  # form
        normalised = _normalise_uk_postcode(payload.postcode or "")
        if not normalised:
            raise HTTPException(status_code=400, detail="invalid postcode")
        enrichment = await _postcodes_io_lookup_postcode(normalised)
        if not enrichment:
            return {"ok": False, "reason": "postcode_not_found"}

    geo_precise = {
        "town": enrichment.get("town") or "",
        "postcode": enrichment.get("postcode") or "",
        "district": enrichment.get("district") or "",
        "county": enrichment.get("county") or "",
        "lat": enrichment.get("lat"),
        "lon": enrichment.get("lon"),
        "source": payload.source,
        "accuracy_m": float(payload.accuracy_m) if payload.accuracy_m is not None else None,
        "recorded_at": datetime.now(timezone.utc),
    }

    # Apply to the live session if it already exists. If the heartbeat hasn't
    # fired yet (very first beat takes ~30s after page load), park the
    # precise data in `pending_precise_locations` instead of creating an
    # orphan live_visitors doc (which would inflate the headline count
    # without ever showing in the list — the bug we hit on launch day).
    # The heartbeat handler drains this collection on its next tick.
    try:
        now = datetime.now(timezone.utc)
        result = await db.live_visitors.update_one(
            {"session_id": payload.session_id},
            {"$set": {"geo_precise": geo_precise}},
        )
        if result.matched_count == 0:
            await db.pending_precise_locations.update_one(
                {"session_id": payload.session_id},
                {"$set": {
                    "session_id": payload.session_id,
                    "geo_precise": geo_precise,
                    "queued_at": now,
                }},
                upsert=True,
            )
        # Always update page_views (Visitor History reads from these and is
        # unaffected by the live-count issue).
        pv_session_ids = [payload.session_id]
        if payload.page_tracking_session_id and payload.page_tracking_session_id != payload.session_id:
            pv_session_ids.append(payload.page_tracking_session_id)
        await db.page_views.update_many(
            {"session_id": {"$in": pv_session_ids}},
            {"$set": {"geo_precise": geo_precise}},
        )
    except Exception as e:
        logger.warning(f"[live-analytics] precise-location persist failed: {e}")

    return {
        "ok": True,
        "town": geo_precise["town"],
        "postcode": geo_precise["postcode"],
        "source": geo_precise["source"],
    }





@router.get("/visitors")
async def live_visitors(current_user: dict = Depends(get_current_user)):
    """Admin — active visitors snapshot. Tagged staff devices stay VISIBLE in
    the list and count in the headline (so you can observe site behavior),
    but their `known_device_label` flags them so Telegram alerts skip them."""
    if current_user.get("role") not in ["super_admin", "admin", "manager"]:
        return {"total": 0, "by_page": [], "visitors": []}

    await _ensure_indexes()
    db = get_db()
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=ACTIVE_WINDOW_SECONDS)
    # Filter out orphan docs (geo_precise upserts that never received a
    # heartbeat — they have no `path` field and shouldn't count toward
    # the live total). This is defence-in-depth: the new code path
    # writes to `pending_precise_locations` instead, but any orphans
    # still in flight from the previous deploy are excluded here too.
    #
    # Also (12 May 2026 hotfix) — reject non-UK rows that snuck in
    # before the heartbeat-side geo filter shipped. Geo can live at
    # either `geo.country_code` or `geo.country` depending on the cache
    # writer, so we match on BOTH.
    query = {
        "last_seen": {"$gte": cutoff},
        "path": {"$nin": [None, ""], "$exists": True},
        "$or": [
            {"geo.country_code": "GB"},
            {"geo.country_code": "gb"},
            {"geo.country": {"$regex": r"^(united kingdom|uk|great britain|england|scotland|wales|northern ireland)$", "$options": "i"}},
            # Rows with NO geo yet (very first heartbeat per IP — geo
            # resolves in background) are kept so we don't lose real
            # UK visitors during their first 30 seconds. They get
            # naturally cleaned up on the SECOND heartbeat when geo
            # arrives and the country guard runs.
            {"geo": {"$in": [None, {}]}},
            {"geo": {"$exists": False}},
        ],
    }

    total = await db.live_visitors.count_documents(query)

    by_page: List[dict] = []
    try:
        pipe = [
            {"$match": query},
            {"$group": {"_id": "$path_normalised", "count": {"$sum": 1}}},
            {"$sort": {"count": -1}},
            {"$limit": 50},
        ]
        agg = await db.live_visitors.aggregate(pipe).to_list(length=50)
        by_page = [{"path": r["_id"] or "/", "count": r["count"]} for r in agg]
    except Exception as e:
        logger.warning(f"[live-analytics] by_page aggregate failed: {e}")

    visitors: List[dict] = []
    hot_today_count = 0
    hot_sparkline_7d: list = [0] * 7
    try:
        # Pull the known-device map once so we can decorate each visitor
        # without doing N+1 lookups.
        known_map: dict = {}
        async for d in db.known_devices.find({}, {"_id": 0, "visitor_id": 1, "label": 1, "exclude_from_stats": 1}):
            known_map[d.get("visitor_id")] = {"label": d.get("label"), "exclude_from_stats": bool(d.get("exclude_from_stats"))}

        # Pull the hot-session set in one go so each row can show a 🔥 badge
        # without N+1. Hot = Telegram "hot_session" alert was fired in the
        # last 30 min for that session_id.
        hot_cutoff = datetime.now(timezone.utc) - timedelta(minutes=30)
        hot_set: set = set()
        async for h in db.hot_sessions.find(
            {"marked_at": {"$gte": hot_cutoff}},
            {"_id": 0, "session_id": 1},
        ):
            sid = h.get("session_id")
            if sid:
                hot_set.add(sid)

        # Also count hot sessions since 00:00 UTC today — the "Hot today: N"
        # header chip uses this. Cheap count_documents, no aggregate.
        midnight_utc = datetime.now(timezone.utc).replace(
            hour=0, minute=0, second=0, microsecond=0,
        )
        hot_today_count = await db.hot_sessions.count_documents(
            {"marked_at": {"$gte": midnight_utc}},
        )

        # 7-day rolling sparkline — oldest to newest. One $group aggregate
        # bucketed per UTC day. Used by the header chip's mini SVG so the
        # sales team can see whether buying intent is trending up/down.
        seven_days_ago = midnight_utc - timedelta(days=6)
        spark_pipe = [
            {"$match": {"marked_at": {"$gte": seven_days_ago}}},
            {"$group": {
                "_id": {"$dateToString": {"format": "%Y-%m-%d", "date": "$marked_at"}},
                "count": {"$sum": 1},
            }},
        ]
        bucket_map: dict = {}
        async for row in db.hot_sessions.aggregate(spark_pipe):
            bucket_map[row.get("_id")] = int(row.get("count") or 0)
        hot_sparkline_7d: list = []
        for offset in range(6, -1, -1):
            day = (midnight_utc - timedelta(days=offset)).strftime("%Y-%m-%d")
            hot_sparkline_7d.append(bucket_map.get(day, 0))

        # Show all visitors including tagged staff devices — the user wants
        # to observe site behavior with these. Telegram suppression happens
        # separately at the alert callsite.
        cursor = (
            db.live_visitors.find(query, {"_id": 0})
            .sort("last_seen", -1)
            .limit(50)
        )
        async for v in cursor:
            geo = v.get("geo") or {}
            cart = v.get("cart_summary") or {}
            vid = v.get("visitor_id") or ""
            known = known_map.get(vid)
            visitors.append({
                "session_id": v.get("session_id"),
                "visitor_id": vid,
                "is_hot": v.get("session_id") in hot_set,
                "known_device_label": (known or {}).get("label"),
                "known_device_excluded": bool((known or {}).get("exclude_from_stats")),
                "path": v.get("path"),
                "path_normalised": v.get("path_normalised"),
                "referrer": v.get("referrer"),
                "user_agent": (v.get("user_agent") or "")[:200],
                "first_seen": v.get("first_seen").isoformat() if isinstance(v.get("first_seen"), datetime) else v.get("first_seen"),
                "last_seen": v.get("last_seen").isoformat() if isinstance(v.get("last_seen"), datetime) else v.get("last_seen"),
                "geo": {
                    "country": geo.get("country", ""),
                    "country_code": geo.get("country_code", ""),
                    "city": geo.get("city", ""),
                    "region": geo.get("region", ""),
                    "lat": geo.get("lat"),
                    "lon": geo.get("lon"),
                    "flag_emoji": geo.get("flag_emoji", ""),
                } if geo else None,
                "geo_precise": (lambda gp: ({**gp, "recorded_at": gp["recorded_at"].isoformat()} if isinstance(gp.get("recorded_at"), datetime) else gp) if gp else None)(v.get("geo_precise")),
                "cart_count": cart.get("items_count", 0),
                "cart_value": cart.get("value", 0),
                "page_count": len(v.get("page_history") or []),
            })
    except Exception as e:
        logger.warning(f"[live-analytics] visitor list failed: {e}")

    # Last-7-days precise-location coverage — measures whether the new
    # opt-in / postcode capture / cookie-persist / customer auto-tag paths
    # are actually expanding our coverage. A single 7-day stat is the right
    # window: long enough that random fluctuation is dampened, short enough
    # that a recent change is visible within a week.
    precise_coverage = {"total": 0, "precise": 0, "pct": 0}
    try:
        seven_days_ago = datetime.now(timezone.utc) - timedelta(days=7)
        # Distinct visitor_ids over the window
        all_ids = await db.page_views.distinct(
            "visitor_id",
            {"timestamp": {"$gte": seven_days_ago}, "visitor_id": {"$ne": None}},
        )
        precise_ids = await db.page_views.distinct(
            "visitor_id",
            {
                "timestamp": {"$gte": seven_days_ago},
                "visitor_id": {"$ne": None},
                "geo_precise": {"$exists": True},
            },
        )
        coverage_total = len(all_ids)
        coverage_precise = len(precise_ids)
        precise_coverage = {
            "total": coverage_total,
            "precise": coverage_precise,
            "pct": int(round(100 * coverage_precise / coverage_total)) if coverage_total else 0,
        }
    except Exception as e:
        logger.warning(f"[live-analytics] precise coverage calc failed: {e}")

    return {"total": total, "by_page": by_page, "visitors": visitors, "hot_today_count": hot_today_count, "hot_sparkline_7d": hot_sparkline_7d, "precise_coverage": precise_coverage}


@router.get("/visitors/{session_id}")
async def visitor_detail(session_id: str, current_user: dict = Depends(get_current_user)):
    """Admin — full detail for a single session: geo, page history with time spent, cart."""
    if current_user.get("role") not in ["super_admin", "admin", "manager"]:
        raise HTTPException(status_code=403, detail="Not authorized")

    db = get_db()
    v = await db.live_visitors.find_one({"session_id": session_id}, {"_id": 0})
    if not v:
        raise HTTPException(status_code=404, detail="Visitor not found or session expired")

    # Compute time-on-page per entry + total
    history = v.get("page_history") or []
    enriched = []
    total_seconds = 0
    for entry in history:
        try:
            entered = datetime.fromisoformat(entry["entered_at"].replace("Z", "+00:00"))
            seen = datetime.fromisoformat(entry["last_seen"].replace("Z", "+00:00"))
            secs = max(0, int((seen - entered).total_seconds()))
        except Exception:
            secs = 0
        total_seconds += secs
        enriched.append({
            **entry,
            "seconds_on_page": secs,
        })

    # Recent admin messages already sent to this visitor (last 50)
    recent_messages: List[dict] = []
    try:
        async for m in db.live_visitor_messages.find(
            {"session_id": session_id},
            {"_id": 0, "id": 1, "message": 1, "from_name": 1, "delivered": 1, "delivered_at": 1, "created_at": 1},
        ).sort("created_at", -1).limit(50):
            recent_messages.append({
                "id": m.get("id"),
                "message": m.get("message"),
                "from_name": m.get("from_name"),
                "delivered": m.get("delivered", False),
                "created_at": m.get("created_at").isoformat() if isinstance(m.get("created_at"), datetime) else m.get("created_at"),
                "delivered_at": m.get("delivered_at").isoformat() if isinstance(m.get("delivered_at"), datetime) else m.get("delivered_at"),
            })
    except Exception as e:
        logger.warning(f"[live-analytics] recent messages fetch failed: {e}")

    # Serialize geo_precise.recorded_at to ISO so the admin UI gets a clean string
    gp = v.get("geo_precise")
    if gp and isinstance(gp.get("recorded_at"), datetime):
        gp = {**gp, "recorded_at": gp["recorded_at"].isoformat()}

    # Compute nearest showroom from precise lat/lon if available, falling
    # back to coarse IP geo. Helpful for the sales team during follow-up
    # ("you're 12 miles from our Tonbridge showroom — fancy popping in?").
    nearest_showroom = None
    try:
        coord_source = None
        if gp and gp.get("lat") is not None and gp.get("lon") is not None:
            coord_source = (float(gp["lat"]), float(gp["lon"]), "precise")
        elif (v.get("geo") or {}).get("lat") is not None and (v.get("geo") or {}).get("lon") is not None:
            geo = v.get("geo") or {}
            coord_source = (float(geo["lat"]), float(geo["lon"]), "approx")
        if coord_source:
            ns = await find_nearest_showroom(db, coord_source[0], coord_source[1])
            if ns:
                ns["coord_source"] = coord_source[2]
                nearest_showroom = ns
    except Exception as e:
        logger.warning(f"[live-analytics] nearest-showroom calc failed: {e}")

    return {
        "session_id": v.get("session_id"),
        "path": v.get("path"),
        "first_seen": v.get("first_seen").isoformat() if isinstance(v.get("first_seen"), datetime) else v.get("first_seen"),
        "last_seen": v.get("last_seen").isoformat() if isinstance(v.get("last_seen"), datetime) else v.get("last_seen"),
        "user_agent": v.get("user_agent"),
        "referrer": v.get("referrer"),
        "ip": v.get("ip"),
        "geo": v.get("geo"),
        "geo_precise": gp,
        "nearest_showroom": nearest_showroom,
        "cart_summary": v.get("cart_summary"),
        "page_history": list(reversed(enriched)),  # newest first
        "total_seconds": total_seconds,
        "messages": list(reversed(recent_messages)),  # oldest first for chat-style display
    }


class AdminMessagePayload(BaseModel):
    session_id: str = Field(..., min_length=4, max_length=64)
    message: str = Field(..., min_length=1, max_length=500)


@router.post("/admin-message")
async def send_admin_message(
    payload: AdminMessagePayload,
    current_user: dict = Depends(get_current_user),
):
    """Admin → visitor message. Visitor receives it on their next heartbeat."""
    if current_user.get("role") not in ["super_admin", "admin", "manager"]:
        raise HTTPException(status_code=403, detail="Not authorized")

    db = get_db()
    now = datetime.now(timezone.utc)
    msg_id = f"msg-{int(now.timestamp() * 1000)}-{payload.session_id[:8]}"
    doc = {
        "id": msg_id,
        "session_id": payload.session_id,
        "message": payload.message.strip(),
        "from_name": current_user.get("name") or "Tile Station Support",
        "from_email": current_user.get("email"),
        "created_at": now,
        "delivered": False,
        # Auto-purge undelivered messages after 30 minutes
        "expires_at": now + timedelta(minutes=30),
    }
    await _ensure_indexes()
    try:
        await db.live_visitor_messages.insert_one(doc)
    except Exception as e:
        logger.error(f"[live-analytics] admin-message insert failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to queue message")

    return {
        "ok": True,
        "id": msg_id,
        "created_at": now.isoformat(),
        "delivered": False,
        "from_name": doc["from_name"],
    }



# ─────────────────────────────────────────────────────────────────────────────
# Known devices — let admin tag visitors as "Tonbridge iPad", "Qasim's laptop"
# and optionally hide them from analytics so unique-visitor counts reflect
# real customers only.
# ─────────────────────────────────────────────────────────────────────────────
class KnownDevicePayload(BaseModel):
    visitor_id: str
    label: str
    exclude_from_stats: bool = True
    notes: Optional[str] = None


@router.get("/known-devices")
async def list_known_devices(current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["super_admin", "admin", "manager"]:
        raise HTTPException(status_code=403, detail="Not authorized")
    db = get_db()
    out = []
    async for d in db.known_devices.find({}, {"_id": 0}).sort("label", 1):
        for k in ("created_at", "updated_at"):
            if isinstance(d.get(k), datetime):
                d[k] = d[k].isoformat()
        out.append(d)
    return {"devices": out}


@router.post("/purge-non-uk")
async def purge_non_uk_live_visitors(current_user: dict = Depends(get_current_user)):
    """One-shot purge of historical non-UK rows from `live_visitors`.

    Built 12 May 2026 because the heartbeat-side UK guard only catches
    NEW visits — old rows already in the collection (e.g. AWS Ashburn
    bots from before the guard shipped) keep showing in the panel until
    they age out of the 5-min window. This forces them out immediately.

    Matches on `geo.country_code` (Cloudflare-set ISO2) OR the full
    `geo.country` name. Rows with no geo at all are LEFT alone — they
    may be UK visitors mid-resolution.
    """
    if current_user.get("role") not in ["super_admin", "admin"]:
        raise HTTPException(status_code=403, detail="Admin only")
    db = get_db()
    # Inverse of the read-side UK filter: delete anything that has an
    # explicit non-UK geo.
    res = await db.live_visitors.delete_many({
        "$and": [
            {"geo": {"$nin": [None, {}]}},
            {"geo": {"$exists": True}},
            {
                "$nor": [
                    {"geo.country_code": "GB"},
                    {"geo.country_code": "gb"},
                    {"geo.country": {"$regex": r"^(united kingdom|uk|great britain|england|scotland|wales|northern ireland)$", "$options": "i"}},
                ],
            },
        ],
    })
    return {"deleted": res.deleted_count}


@router.put("/known-devices/{visitor_id}")
async def upsert_known_device(
    visitor_id: str,
    payload: KnownDevicePayload,
    current_user: dict = Depends(get_current_user),
):
    if current_user.get("role") not in ["super_admin", "admin"]:
        raise HTTPException(status_code=403, detail="Admin only")
    db = get_db()
    now = datetime.now(timezone.utc)
    label = (payload.label or "").strip()[:80]
    if not label:
        raise HTTPException(status_code=400, detail="Label is required")
    await db.known_devices.update_one(
        {"visitor_id": visitor_id},
        {
            "$set": {
                "visitor_id": visitor_id,
                "label": label,
                "exclude_from_stats": bool(payload.exclude_from_stats),
                "notes": (payload.notes or "")[:300] or None,
                "updated_at": now,
                "tagged_by": current_user.get("email"),
            },
            "$setOnInsert": {"created_at": now},
        },
        upsert=True,
    )
    return {"ok": True, "visitor_id": visitor_id, "label": label}


@router.delete("/known-devices/{visitor_id}")
async def delete_known_device(
    visitor_id: str,
    current_user: dict = Depends(get_current_user),
):
    if current_user.get("role") not in ["super_admin", "admin"]:
        raise HTTPException(status_code=403, detail="Admin only")
    db = get_db()
    res = await db.known_devices.delete_one({"visitor_id": visitor_id})
    return {"ok": True, "deleted": res.deleted_count}

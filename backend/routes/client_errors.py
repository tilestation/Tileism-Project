"""
Client error watch — captures every red `toast.error()`, API 5xx, and JS crash
the customer sees on the storefront, so admins can intervene proactively
("call the user before they bounce").

Storefront pipeline (from `frontend/src/lib/clientErrorWatch.js`):
  toast.error → POST /api/client-errors/log
  axios 4xx/5xx → POST /api/client-errors/log
  window.onerror / unhandledrejection → POST /api/client-errors/log

Each event:
  • Stored in `client_errors` collection (TTL via index on `created_at`).
  • Optionally fires a Telegram alert (`customer_error` toggle, dedupe by
    session+message hash to avoid spam from refresh loops).
  • Surfaced in `/admin/live-visitors` via /recent.
  • Bundled into a daily digest email at 09:00 UTC by the scheduler.
"""
import hashlib
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from config import get_db
from routes.auth import get_current_user
from services.telegram_notify import notify_event

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/client-errors", tags=["Client Errors"])

# Hard ceilings to keep the collection small + protect against abuse
MAX_MESSAGE_LEN = 600
MAX_BREADCRUMB_LEN = 80
MAX_BREADCRUMBS = 5
PUBLIC_RATE_PER_SESSION_PER_MIN = 30  # plenty for a real session, blocks attackers
RECENT_LOOKBACK_HOURS = 24


def _truncate(s: Optional[str], n: int) -> str:
    if not s:
        return ""
    s = str(s)
    return s if len(s) <= n else s[: n - 1] + "…"


def _redact(s: str) -> str:
    """Strips obvious card numbers / CVVs out of error text before storing.
    Belt-and-braces on top of frontend redaction."""
    if not s:
        return s
    # 12-19 digit runs (card numbers)
    s = re.sub(r"\b\d{12,19}\b", "[redacted]", s)
    # 3-4 digit CVVs adjacent to the words cvv/cvc/cv2
    s = re.sub(r"(cvv|cvc|cv2)[^\d]{0,3}\d{3,4}", r"\1 [redacted]", s, flags=re.I)
    return s


class Breadcrumb(BaseModel):
    t: Optional[str] = None  # type: click | input | route | api
    v: Optional[str] = None  # value/label
    ts: Optional[float] = None  # client-side ms timestamp


class ClientErrorPayload(BaseModel):
    session_id: str = Field(..., min_length=1, max_length=80)
    error_type: str = Field(..., max_length=40)  # toast | api | js | unhandled
    message: str = Field(..., min_length=1, max_length=MAX_MESSAGE_LEN)
    page_url: Optional[str] = Field(default=None, max_length=400)
    severity: Optional[str] = Field(default="error", max_length=20)
    status_code: Optional[int] = None
    api_endpoint: Optional[str] = Field(default=None, max_length=200)
    customer_email: Optional[str] = Field(default=None, max_length=200)
    user_agent: Optional[str] = Field(default=None, max_length=300)
    breadcrumbs: List[Breadcrumb] = Field(default_factory=list)
    stack: Optional[str] = Field(default=None, max_length=2000)


@router.post("/log")
async def log_client_error(payload: ClientErrorPayload, request: Request):
    """Public endpoint — heavily rate-limited per session_id."""
    db = get_db()

    # ── Bot / crawler filter ──
    # Bing/Google/etc. crawlers occasionally hit endpoints during cutovers
    # and trigger client-side errors that aren't real customer issues.
    # Drop them silently before we even rate-limit — saves DB writes + alerts.
    ua = (payload.user_agent or request.headers.get("user-agent") or "").lower()
    BOT_PATTERNS = (
        "bot", "crawler", "spider", "slurp", "facebookexternalhit",
        "linkedinbot", "twitterbot", "whatsapp", "telegrambot",
        "headlesschrome", "playwright", "puppeteer", "phantomjs", "lighthouse",
    )
    if any(p in ua for p in BOT_PATTERNS):
        return {"ok": True, "skipped": "bot_traffic"}

    # ── Suppress generic browser-extension noise ──
    # When a cross-origin script (browser extension, ad blocker, page translator)
    # throws an error, browsers redact the message to literally "Script error."
    # for security. These are 99% NOT customer-impacting bugs — they're the
    # customer's own browser extensions misbehaving on our page. Skip them
    # unless they have a stack trace (which would mean it's actually our code).
    msg_lower = (payload.message or "").strip().lower()
    if msg_lower in ("script error.", "script error") and not (payload.stack or "").strip():
        return {"ok": True, "skipped": "cross_origin_browser_extension"}

    # ── Suppress benign browser-internal events ──
    # ServiceWorker update/install fetches occasionally fail mid-flight on
    # mobile networks. The cached SW continues working perfectly; the
    # browser auto-retries on the next visit. Logging these clutters the
    # admin panel without giving any actionable signal.
    # Belt-and-braces filter on top of the front-end's `BENIGN_PATTERNS`
    # so customers running the older JS bundle (cached prior to the
    # Feb 2026 fix) also stop polluting the panel.
    BENIGN_PATTERNS = (
        "failed to update a serviceworker",
        "failed to register a serviceworker",
        "service-worker.js: load failed",
        "service-worker.js load failed",
        "service-worker.js') : an unknown error",
        "service-worker.js'): an unknown error",
        "service worker registration failed",
        # Preview-environment SW noise: the proxy returns the React HTML
        # fallback for /service-worker.js, so the browser bails with
        # "unsupported MIME type ('text/html')". Production serves the
        # real JS file so this never fires there — but admins working
        # on the preview environment shouldn't see it in the Customer
        # Issues panel either.
        "unsupported mime type ('text/html')",
        "unsupported mime type (\"text/html\")",
        "the user aborted a request",
        "networkerror when attempting to fetch resource",
        "resizeobserver loop ",
        # Background admin-poll endpoints that return 404 on preview
        # because those routes aren't deployed there. Production has
        # them. Filter avoids the panel filling up with benign 404s
        # whenever an admin opens DevTools on preview.
        "/api/admin/health/active",
        "/api/shop/admin/online",
        # 3 Jun 2026 — Suppress promo-banner network noise. The
        # banner is OPTIONAL — page renders fine without it. User
        # report: Telegram chat spammed with these false-positives.
        "/api/website/promo-banner",
        # Form validation toasts that aren't bugs. These are NORMAL
        # corrective UX (customer typed a weak password / forgot a
        # field) — sonner showed an amber toast and the customer
        # fixed it. Not actionable for the admin. Defence-in-depth
        # for older cached frontend bundles still in the wild that
        # haven't picked up the same filter at source.
        "password must be at least",
        "email is required",
        "email address is required",
        "please enter a valid email",
        "name is required",
        "phone is required",
        "phone number is required",
        "password is required",
        "please fill all required fields",
        "please fill in all required fields",
        "please complete all required",
        "you must accept the terms",
        "passwords don't match",
        "passwords do not match",
        "this field is required",
    )
    if any(p in msg_lower for p in BENIGN_PATTERNS):
        return {"ok": True, "skipped": "benign_browser_internal"}

    # ── per-session rate limit (last 60s) ──
    one_min_ago = datetime.now(timezone.utc) - timedelta(seconds=60)
    recent_count = await db.client_errors.count_documents({
        "session_id": payload.session_id,
        "created_at": {"$gte": one_min_ago},
    })
    if recent_count >= PUBLIC_RATE_PER_SESSION_PER_MIN:
        return {"ok": True, "skipped": "rate_limited"}

    ip = (
        request.headers.get("cf-connecting-ip")
        or request.headers.get("x-forwarded-for", "").split(",")[0].strip()
        or (request.client.host if request.client else "unknown")
    )

    msg = _redact(_truncate(payload.message, MAX_MESSAGE_LEN))
    crumbs = [
        {
            "t": _truncate(b.t, 12),
            "v": _redact(_truncate(b.v, MAX_BREADCRUMB_LEN)),
            "ts": b.ts,
        }
        for b in (payload.breadcrumbs or [])[-MAX_BREADCRUMBS:]
    ]

    doc = {
        "session_id": payload.session_id,
        "error_type": _truncate(payload.error_type, 40),
        "message": msg,
        "page_url": _truncate(payload.page_url, 400),
        "severity": _truncate(payload.severity or "error", 20),
        "status_code": payload.status_code,
        "api_endpoint": _truncate(payload.api_endpoint, 200),
        "customer_email": _truncate(payload.customer_email, 200),
        "user_agent": _truncate(payload.user_agent or request.headers.get("user-agent") or "", 300),
        "ip_hash": hashlib.sha256(ip.encode()).hexdigest()[:12],
        "breadcrumbs": crumbs,
        "stack": _truncate(payload.stack, 2000),
        "created_at": datetime.now(timezone.utc),
        "digest_sent": False,
    }
    await db.client_errors.insert_one(doc)

    # ── Telegram alert (deduped by session+message hash) ──
    # Skip if this session belongs to a tagged staff device (e.g. owner's
    # laptop hitting console errors while testing).
    try:
        # Use the same hash visitor_id formula so we can match against the
        # known_devices map. We compute it inline so we don't have to import
        # from analytics.py.
        import hashlib as _h
        ip_for_hash = (
            request.headers.get("cf-connecting-ip")
            or request.headers.get("x-forwarded-for", "").split(",")[0].strip()
            or (request.client.host if request.client else "unknown")
        )
        ua_for_hash = (payload.user_agent or request.headers.get("user-agent") or "")[:300]
        guess_visitor_id = _h.sha256(f"{ip_for_hash}:{ua_for_hash}".encode()).hexdigest()[:16]
        is_tagged_device = bool(await db.known_devices.find_one(
            {"visitor_id": guess_visitor_id, "exclude_from_stats": True},
            {"_id": 0},
        ))
        if is_tagged_device:
            return {"ok": True, "skipped_telegram": "tagged_device"}

        msg_hash = hashlib.sha256(f"{payload.session_id}:{msg}".encode()).hexdigest()[:12]
        who = doc["customer_email"] or f"session {payload.session_id[:8]}"
        crumb_trail = " → ".join(
            f"{c['t']}:{c['v']}" for c in crumbs if c.get("v")
        ) or "—"
        text = (
            "<b>⚠️ Customer hit an error on the website</b>\n"
            f"<b>Who:</b> {who}\n"
            f"<b>Page:</b> {doc['page_url'] or '—'}\n"
            f"<b>Type:</b> {doc['error_type']}"
            + (f" ({doc['status_code']})" if doc['status_code'] else "")
            + "\n"
            f"<b>Message:</b> {msg}\n"
            f"<b>Last actions:</b> {crumb_trail}"
        )
        # Don't await — we don't want a slow Telegram POST to delay the
        # storefront. notify_event already short-circuits when disabled.
        import asyncio
        asyncio.create_task(notify_event("customer_error", text, dedupe_key=msg_hash))
    except Exception as exc:
        logger.debug(f"Telegram customer_error skipped: {exc}")

    return {"ok": True}


@router.get("/recent")
async def list_recent_errors(
    hours: int = 24,
    limit: int = 50,
    current_user: dict = Depends(get_current_user),
):
    """Admin feed for the Live Visitors panel."""
    if current_user.get("role") not in {"admin", "super_admin"}:
        raise HTTPException(status_code=403, detail="Admin only")
    db = get_db()
    since = datetime.now(timezone.utc) - timedelta(hours=max(1, min(hours, 720)))
    cursor = db.client_errors.find(
        {"created_at": {"$gte": since}},
        {"_id": 0},
    ).sort("created_at", -1).limit(max(1, min(limit, 200)))
    rows = []
    async for r in cursor:
        if r.get("created_at"):
            r["created_at"] = r["created_at"].isoformat()
        rows.append(r)
    # Lightweight summary so the panel can show a header count
    total_24h = await db.client_errors.count_documents(
        {"created_at": {"$gte": datetime.now(timezone.utc) - timedelta(hours=24)}}
    )
    return {"errors": rows, "total_24h": total_24h}


@router.delete("/clear")
async def clear_errors(current_user: dict = Depends(get_current_user)):
    """Wipe the live feed (super_admin only)."""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super admin only")
    db = get_db()
    res = await db.client_errors.delete_many({})
    return {"deleted": res.deleted_count}


# ─────────────────────────────────────────────────────────────────────────────
# Daily 09:00 digest
# ─────────────────────────────────────────────────────────────────────────────
async def run_customer_errors_digest_tick():
    """Hourly probe — fires the digest only at the configured hour (09 UTC)."""
    db = get_db()
    now = datetime.now(timezone.utc)
    settings = await db.website_settings.find_one({"_id": "client_errors_digest"}) or {}
    target_hour = int(settings.get("hour_utc", 9))
    if not settings.get("enabled", True):
        return
    if now.hour != target_hour:
        return
    # Idempotency — don't send twice on the same day
    today = now.strftime("%Y-%m-%d")
    if settings.get("last_sent_date") == today:
        return

    since = now - timedelta(hours=24)
    cursor = db.client_errors.find(
        {"created_at": {"$gte": since}},
        {"_id": 0},
    ).sort("created_at", -1)
    errors = [r async for r in cursor]
    if not errors:
        await db.website_settings.update_one(
            {"_id": "client_errors_digest"},
            {"$set": {"last_sent_date": today, "last_count": 0}},
            upsert=True,
        )
        return

    # Group by message for the email body
    from collections import Counter
    grouped = Counter((e.get("error_type", "?"), e.get("message", "")) for e in errors)
    top_lines = [
        f"<li><b>{count}×</b> [{etype}] {msg}</li>"
        for (etype, msg), count in grouped.most_common(15)
    ]

    body_html = (
        f"<h2>Customer error digest — last 24h</h2>"
        f"<p><b>{len(errors)}</b> errors across <b>{len({e.get('session_id') for e in errors})}</b> sessions.</p>"
        f"<ol>{''.join(top_lines)}</ol>"
        f"<hr><p style='color:#64748b;font-size:12px'>From the Customer Error Watch — open "
        f"<a href='https://carefree-friendship-production-ee2b.up.railway.app/admin/live-visitors'>Live Visitors</a> "
        f"to see the full feed and breadcrumb trails.</p>"
    )

    try:
        from services.email import send_simple_email_if_possible
        # Pull all admin emails
        recipients = [
            u.get("email") async for u in db.users.find(
                {"role": {"$in": ["admin", "super_admin"]}, "email": {"$ne": None}},
                {"_id": 0, "email": 1},
            )
        ]
        recipients = [r for r in recipients if r]
        if recipients:
            await send_simple_email_if_possible(
                to=recipients,
                subject=f"[Tile Station] {len(errors)} customer errors in the last 24h",
                html=body_html,
            )
    except Exception as exc:
        logger.warning(f"Customer errors digest email failed: {exc}")

    await db.website_settings.update_one(
        {"_id": "client_errors_digest"},
        {"$set": {"last_sent_date": today, "last_count": len(errors)}},
        upsert=True,
    )

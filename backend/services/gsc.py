"""
Google Search Console (GSC) integration service.

Phase 1 — OAuth 2.0 connection only:
  - Build the Google authorisation URL (3-legged web-server flow)
  - Exchange the authorisation code for access + refresh tokens
  - Persist refresh token in MongoDB (one doc per admin user)
  - Reload + auto-refresh credentials before every API call

Phase 2+ (future) layer Search Analytics, URL Inspection and
Sitemaps API on top of the helpers exposed here.

Why one document per admin (rather than one per site)?
  - Different admins may own / verify different GSC properties; we'd
    rather keep the connection scoped to the human who authorised it
    so revocations are clean and audit-able.
  - A single super_admin's connection is enough to power the whole
    organisation's dashboard, so the typical real-world fan-out is 1.

Token storage shape (collection: `gsc_oauth_tokens`):
{
  _id: <admin user id>,
  refresh_token: "1//0g…",
  access_token: "ya29.…",
  access_token_expires_at: ISODate,
  scopes: [...],
  google_account_email: "owner@gmail.com",
  connected_at: ISODate,
  last_refreshed_at: ISODate,
  last_used_at: ISODate
}

Scopes:
  - webmasters.readonly  → Search Analytics + URL Inspection
  - webmasters           → Sitemaps submit/delete
We request both at connection time so Phase 3 sitemap auto-submit
doesn't need a re-auth.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build

from config import get_db

logger = logging.getLogger(__name__)

GSC_SCOPES: list[str] = [
    "https://www.googleapis.com/auth/webmasters.readonly",
    "https://www.googleapis.com/auth/webmasters",
    # OpenID + email so we can capture which Google account the user
    # connected as, useful UX (renders "Connected as you@gmail.com" in
    # the admin panel).
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
]

GOOGLE_AUTH_URI = "https://accounts.google.com/o/oauth2/auth"
GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"

TOKENS_COLLECTION = "gsc_oauth_tokens"


def _settings_from_env() -> dict[str, str]:
    """Read OAuth settings from env at call-time so .env reloads work."""
    client_id = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
    client_secret = os.environ.get("GOOGLE_CLIENT_SECRET", "").strip()
    backend_base = (
        os.environ.get("BACKEND_URL")
        or os.environ.get("PUBLIC_BACKEND_URL")
        or ""
    ).rstrip("/")
    redirect_uri = (
        os.environ.get("GOOGLE_OAUTH_REDIRECT_URI")
        or (f"{backend_base}/api/admin/gsc/callback" if backend_base else "")
    ).strip()
    return {
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": redirect_uri,
    }


def is_configured() -> bool:
    """True only if all three OAuth env vars are populated."""
    s = _settings_from_env()
    return bool(s["client_id"] and s["client_secret"] and s["redirect_uri"])


def _build_flow(state: str | None = None, code_verifier: str | None = None) -> Flow:
    s = _settings_from_env()
    if not s["client_id"] or not s["client_secret"]:
        raise HTTPException(
            status_code=503,
            detail=(
                "Google Search Console OAuth is not configured on the server. "
                "Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and "
                "GOOGLE_OAUTH_REDIRECT_URI in backend env."
            ),
        )
    flow = Flow.from_client_config(
        {
            "web": {
                "client_id": s["client_id"],
                "client_secret": s["client_secret"],
                "auth_uri": GOOGLE_AUTH_URI,
                "token_uri": GOOGLE_TOKEN_URI,
                "redirect_uris": [s["redirect_uri"]],
            }
        },
        scopes=GSC_SCOPES,
        redirect_uri=s["redirect_uri"],
        state=state,
        # Opt OUT of library auto-PKCE. Our stateless callback creates a
        # *new* Flow instance (so it would have no matching code_verifier
        # to send back to Google). For a confidential Web client the
        # secret already authenticates us — PKCE is optional.
        autogenerate_code_verifier=False,
    )
    if code_verifier:
        flow.code_verifier = code_verifier
    return flow


def build_authorization_url(state: str) -> tuple[str, str | None]:
    """Generate the consent URL; admin will be redirected here.
    Returns (auth_url, code_verifier) — code_verifier is None unless
    PKCE is in use (we disable it, so always None today, but keeping
    the shape means a future upgrade doesn't require a route rewrite).
    """
    flow = _build_flow(state=state)
    auth_url, _ = flow.authorization_url(
        access_type="offline",      # required for refresh_token
        include_granted_scopes="true",
        prompt="consent",            # force re-consent so we always get refresh_token
    )
    return auth_url, getattr(flow, "code_verifier", None)


async def exchange_code_and_store(
    *, admin_user_id: str, code: str, state: str, code_verifier: str | None = None
) -> dict[str, Any]:
    """
    Exchange the auth code for tokens and upsert the row in Mongo.
    Returns the slim public-safe token doc (no secrets).
    """
    flow = _build_flow(state=state, code_verifier=code_verifier)
    flow.fetch_token(code=code)
    creds = flow.credentials

    if not creds.refresh_token:
        # Google only returns refresh_token on the FIRST consent for a
        # given (client_id, account) pair unless prompt=consent forced
        # a fresh consent. We force prompt=consent above so this should
        # not happen — but if it does, surface a helpful error.
        raise HTTPException(
            status_code=400,
            detail=(
                "Google did not return a refresh_token. Revoke any previous "
                "Tile Station authorisation at "
                "https://myaccount.google.com/permissions and try again."
            ),
        )

    google_email = await _fetch_google_email(creds)

    db = get_db()
    expires_at = creds.expiry.replace(tzinfo=timezone.utc) if creds.expiry else None
    now = datetime.now(timezone.utc)

    doc = {
        "_id": admin_user_id,
        "refresh_token": creds.refresh_token,
        "access_token": creds.token,
        "access_token_expires_at": expires_at,
        "scopes": list(creds.scopes or GSC_SCOPES),
        "google_account_email": google_email,
        "connected_at": now,
        "last_refreshed_at": now,
        "last_used_at": now,
    }
    await db[TOKENS_COLLECTION].replace_one({"_id": admin_user_id}, doc, upsert=True)

    return {
        "connected": True,
        "google_account_email": google_email,
        "scopes": doc["scopes"],
        "connected_at": now.isoformat(),
    }


async def _fetch_google_email(creds: Credentials) -> str | None:
    """Pull the OIDC email so the admin UI can show 'Connected as ...'."""
    try:
        # We have userinfo.email scope; use the standard OIDC userinfo endpoint.
        import requests
        r = requests.get(
            GOOGLE_USERINFO_URL,
            headers={"Authorization": f"Bearer {creds.token}"},
            timeout=10,
        )
        if r.status_code == 200:
            return (r.json() or {}).get("email")
    except Exception as exc:  # pragma: no cover — non-fatal
        logger.warning("Failed to fetch Google account email: %s", exc)
    return None


async def get_status(admin_user_id: str) -> dict[str, Any]:
    """Connection status for the admin panel."""
    db = get_db()
    doc = await db[TOKENS_COLLECTION].find_one({"_id": admin_user_id}, {"refresh_token": 0, "access_token": 0})
    if not doc:
        return {
            "connected": False,
            "configured": is_configured(),
        }

    # 16 May 2026 — if a previous API call hit `invalid_grant` from Google
    # (refresh token revoked / expired), `get_credentials_for_admin()`
    # marks the doc with `token_invalid=True`. Surface that as
    # `connected=False` here so the admin UI shows the "Reconnect" button
    # instead of a stale "Connected" badge + Disconnect button (which
    # was the trap that left users unable to reconnect on May 15).
    if doc.get("token_invalid"):
        invalidated_at = doc.get("token_invalidated_at")
        if hasattr(invalidated_at, "isoformat"):
            invalidated_at = invalidated_at.isoformat()
        return {
            "connected": False,
            "configured": is_configured(),
            "previously_connected": True,
            "reason": doc.get("token_invalid_reason") or "token_revoked",
            "google_account_email": doc.get("google_account_email"),
            "token_invalidated_at": invalidated_at,
        }

    # Convert datetimes to ISO for JSON payload.
    for k in ("access_token_expires_at", "connected_at", "last_refreshed_at", "last_used_at"):
        if doc.get(k):
            try:
                doc[k] = doc[k].isoformat() if hasattr(doc[k], "isoformat") else str(doc[k])
            except Exception:
                doc[k] = None
    doc.pop("_id", None)
    doc["connected"] = True
    doc["configured"] = True
    return doc


async def disconnect(admin_user_id: str) -> dict[str, Any]:
    db = get_db()
    res = await db[TOKENS_COLLECTION].delete_one({"_id": admin_user_id})
    return {"disconnected": True, "deleted": res.deleted_count}


async def get_credentials_for_admin(admin_user_id: str) -> Credentials:
    """
    Reload Credentials from Mongo and refresh access token if needed.
    Updates `last_used_at` on every call. Used by Phase-2+ data fetchers.
    """
    s = _settings_from_env()
    db = get_db()
    doc = await db[TOKENS_COLLECTION].find_one({"_id": admin_user_id})
    if not doc or not doc.get("refresh_token"):
        raise HTTPException(
            status_code=401,
            detail="Google Search Console is not connected. Connect it in /admin/seo first.",
        )

    creds = Credentials(
        token=doc.get("access_token"),
        refresh_token=doc["refresh_token"],
        token_uri=GOOGLE_TOKEN_URI,
        client_id=s["client_id"],
        client_secret=s["client_secret"],
        scopes=doc.get("scopes", GSC_SCOPES),
    )
    if doc.get("access_token_expires_at"):
        creds.expiry = doc["access_token_expires_at"].replace(tzinfo=None)

    if creds.expired or not creds.valid:
        try:
            creds.refresh(GoogleRequest())
            await db[TOKENS_COLLECTION].update_one(
                {"_id": admin_user_id},
                {
                    "$set": {
                        "access_token": creds.token,
                        "access_token_expires_at": (
                            creds.expiry.replace(tzinfo=timezone.utc) if creds.expiry else None
                        ),
                        "last_refreshed_at": datetime.now(timezone.utc),
                    }
                },
            )
        except Exception as exc:
            logger.error("GSC token refresh failed for %s: %s", admin_user_id, exc)
            # 16 May 2026 — if Google permanently rejected the refresh
            # token (invalid_grant = token revoked / consent withdrawn /
            # 6+ months unused), mark the doc so `get_status()` reports
            # `connected=False` and the admin UI surfaces the
            # "Reconnect Search Console" button. Transient failures
            # (network, 5xx) are left alone so they self-heal next call.
            exc_str = str(exc).lower()
            if "invalid_grant" in exc_str or "token has been expired or revoked" in exc_str:
                try:
                    await db[TOKENS_COLLECTION].update_one(
                        {"_id": admin_user_id},
                        {
                            "$set": {
                                "token_invalid": True,
                                "token_invalid_reason": "token_revoked",
                                "token_invalidated_at": datetime.now(timezone.utc),
                            }
                        },
                    )
                except Exception as mark_exc:  # noqa: BLE001 — best effort
                    logger.warning(
                        "Failed to mark GSC token as invalid for %s: %s",
                        admin_user_id,
                        mark_exc,
                    )
            raise HTTPException(
                status_code=401,
                detail="Google Search Console token refresh failed — please reconnect.",
            ) from exc

    await db[TOKENS_COLLECTION].update_one(
        {"_id": admin_user_id},
        {"$set": {"last_used_at": datetime.now(timezone.utc)}},
    )
    return creds


async def list_sites(admin_user_id: str) -> list[dict[str, Any]]:
    """Return the GSC properties this admin has access to.
    Used in Phase 1 as a smoke-test that the connection works.
    """
    creds = await get_credentials_for_admin(admin_user_id)
    service = build("searchconsole", "v1", credentials=creds, cache_discovery=False)
    resp = service.sites().list().execute()
    sites = resp.get("siteEntry", []) or []
    return [
        {
            "site_url": s.get("siteUrl"),
            "permission_level": s.get("permissionLevel"),
        }
        for s in sites
    ]



# ────────────────────────────────────────────────────────────────────────
# Phase 2 — Search Analytics API helpers
#
# We always query the Domain property (`sc-domain:tilestation.co.uk`) so
# the data covers BOTH www + apex + http + https + any future subdomain.
# The legacy URL-prefix property (https://www.tilestation.co.uk/) holds
# the historical data; we expose it as a fallback only if the Domain
# property has zero rows (should never happen on an established site
# but matters for the launch-week period).
# ────────────────────────────────────────────────────────────────────────

DEFAULT_SITE_URL = "sc-domain:tilestation.co.uk"
LEGACY_SITE_URL = "https://www.tilestation.co.uk/"


def _date_range(days: int) -> tuple[str, str]:
    """Search Analytics is delayed ~2 days. Window the request to land
    on rows that actually exist so the dashboard never shows zeros for
    the wrong reason. End date = today-2, start = end - (days-1).
    """
    days = max(1, min(int(days or 28), 365))
    end = (datetime.now(timezone.utc) - timedelta(days=2)).date()
    start = end - timedelta(days=days - 1)
    return start.isoformat(), end.isoformat()


def _row_to_dict(row: dict[str, Any], dimensions: list[str]) -> dict[str, Any]:
    keys = row.get("keys") or []
    out: dict[str, Any] = {}
    for i, dim in enumerate(dimensions):
        out[dim] = keys[i] if i < len(keys) else None
    out["clicks"] = row.get("clicks", 0) or 0
    out["impressions"] = row.get("impressions", 0) or 0
    out["ctr"] = row.get("ctr", 0.0) or 0.0
    out["position"] = row.get("position", 0.0) or 0.0
    return out


async def _query(
    admin_user_id: str,
    *,
    site_url: str | None = None,
    dimensions: list[str] | None = None,
    days: int = 28,
    row_limit: int = 25,
    dimension_filter_groups: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Thin wrapper around `searchanalytics.query`. Returns dict with
    `rows` (list of normalised dicts) and `totals` (across the rows).
    """
    creds = await get_credentials_for_admin(admin_user_id)
    service = build("searchconsole", "v1", credentials=creds, cache_discovery=False)
    site = site_url or DEFAULT_SITE_URL
    start, end = _date_range(days)
    body: dict[str, Any] = {
        "startDate": start,
        "endDate": end,
        "rowLimit": int(row_limit or 25),
        "dataState": "all",
    }
    if dimensions:
        body["dimensions"] = dimensions
    if dimension_filter_groups:
        body["dimensionFilterGroups"] = dimension_filter_groups

    resp = service.searchanalytics().query(siteUrl=site, body=body).execute()
    raw_rows = resp.get("rows", []) or []
    rows = [_row_to_dict(r, dimensions or []) for r in raw_rows]
    totals = {
        "clicks": sum(r["clicks"] for r in rows),
        "impressions": sum(r["impressions"] for r in rows),
    }
    totals["ctr"] = (totals["clicks"] / totals["impressions"]) if totals["impressions"] else 0.0
    totals["avg_position"] = (
        sum(r["position"] * r["impressions"] for r in rows) / totals["impressions"]
    ) if totals["impressions"] else 0.0
    return {
        "site_url": site,
        "start_date": start,
        "end_date": end,
        "rows": rows,
        "totals": totals,
    }


async def get_overview(admin_user_id: str, *, days: int = 28) -> dict[str, Any]:
    """Site-wide totals (no dimensions) — single row aggregating
    every query/page in the window. Used for the 4 metric cards.
    """
    res = await _query(admin_user_id, dimensions=[], days=days, row_limit=1)
    # Without dimensions GSC returns a single aggregate row. Rebuild
    # totals from that row to get the *true* site-wide CTR + position
    # rather than a recomputed average.
    if res["rows"]:
        r0 = res["rows"][0]
        res["totals"] = {
            "clicks": r0["clicks"],
            "impressions": r0["impressions"],
            "ctr": r0["ctr"],
            "avg_position": r0["position"],
        }
    return {"window_days": days, **res}


async def get_top_queries(admin_user_id: str, *, days: int = 28, limit: int = 25) -> dict[str, Any]:
    return await _query(admin_user_id, dimensions=["query"], days=days, row_limit=limit)


async def get_daily_query_rows(
    admin_user_id: str, *, days: int = 28, limit: int = 10000
) -> dict[str, Any]:
    """Per-query, per-day rows — used by the Keyword Attribution
    timeline to build a daily sparkline for each tracked keyword.
    Each row comes back with `query`, `date`, `clicks`, `impressions`,
    `ctr`, `position` fields.
    """
    return await _query(admin_user_id, dimensions=["query", "date"], days=days, row_limit=limit)


async def get_top_pages(admin_user_id: str, *, days: int = 28, limit: int = 25) -> dict[str, Any]:
    return await _query(admin_user_id, dimensions=["page"], days=days, row_limit=limit)


async def get_page_queries(
    admin_user_id: str, *, page_url: str, days: int = 28, limit: int = 25
) -> dict[str, Any]:
    """Queries that surfaced a specific landing page. Used by Phase 3
    URL-inspection drilldown but exposed now so the city-pages table
    can show the top query per page on hover.
    """
    return await _query(
        admin_user_id,
        dimensions=["query"],
        days=days,
        row_limit=limit,
        dimension_filter_groups=[{
            "filters": [{
                "dimension": "page",
                "operator": "equals",
                "expression": page_url,
            }],
        }],
    )


async def get_city_pages_summary(
    admin_user_id: str, *, days: int = 28, limit: int = 200
) -> dict[str, Any]:
    """Filter the page-dimension query to only URLs that match our
    `/tiles/` city-landing-page pattern. We rely on a `contains`
    filter rather than fetching the slug list from Mongo so this
    endpoint stays self-contained and works the moment GSC has data
    even if our local DB is mid-migration.
    """
    res = await _query(
        admin_user_id,
        dimensions=["page"],
        days=days,
        row_limit=limit,
        dimension_filter_groups=[{
            "filters": [{
                "dimension": "page",
                "operator": "contains",
                "expression": "/tiles/",
            }],
        }],
    )
    # Sort by clicks descending so the most-trafficked city pages
    # surface first in the admin dashboard.
    res["rows"].sort(key=lambda r: (r["clicks"], r["impressions"]), reverse=True)
    return res



# ────────────────────────────────────────────────────────────────────────
# Phase 3 — Sitemaps API + URL Inspection
# ────────────────────────────────────────────────────────────────────────

# How long between auto-submits we honour. Google is fine with 1/day; more
# than that and you risk soft-rate-limiting the property's crawl budget.
AUTO_SUBMIT_MIN_INTERVAL_HOURS = 12

# Public sitemap URL — what we submit to Google. Comes from env so the
# preview environment doesn't accidentally submit
# `feature-verification-7…` to the production property.
def _public_sitemap_url() -> str:
    base = (
        os.environ.get("SHOP_WEBSITE_URL")
        or os.environ.get("PUBLIC_SITE_URL")
        or "https://tilestation.co.uk"
    ).rstrip("/")
    return f"{base}/sitemap.xml"


async def _pick_connected_admin() -> str | None:
    """For background tasks (auto-submit on city-page publish, etc.) we
    don't have a request-scoped admin user. Pick the most-recently
    used admin token in the tokens collection.
    """
    db = get_db()
    doc = await db[TOKENS_COLLECTION].find_one(
        {},
        sort=[("last_used_at", -1)],
        projection={"_id": 1},
    )
    return doc.get("_id") if doc else None


async def list_sitemaps(
    admin_user_id: str, *, site_url: str | None = None
) -> dict[str, Any]:
    creds = await get_credentials_for_admin(admin_user_id)
    service = build("searchconsole", "v1", credentials=creds, cache_discovery=False)
    site = site_url or DEFAULT_SITE_URL
    resp = service.sitemaps().list(siteUrl=site).execute()
    feeds = resp.get("sitemap", []) or []
    return {
        "site_url": site,
        "sitemaps": [
            {
                "path": s.get("path"),
                "last_submitted": s.get("lastSubmitted"),
                "last_downloaded": s.get("lastDownloaded"),
                "is_pending": s.get("isPending", False),
                "is_sitemaps_index": s.get("isSitemapsIndex", False),
                "errors": s.get("errors", 0) or 0,
                "warnings": s.get("warnings", 0) or 0,
                "type": s.get("type"),
                "contents": s.get("contents", []),
            }
            for s in feeds
        ],
    }


async def submit_sitemap(
    admin_user_id: str,
    *,
    feedpath: str | None = None,
    site_url: str | None = None,
) -> dict[str, Any]:
    """Tell Google to (re)download our sitemap. Idempotent — calling
    this multiple times for the same feedpath just refreshes Google's
    download queue entry.
    """
    creds = await get_credentials_for_admin(admin_user_id)
    service = build("searchconsole", "v1", credentials=creds, cache_discovery=False)
    site = site_url or DEFAULT_SITE_URL
    feedpath = feedpath or _public_sitemap_url()

    # Sitemaps API has no real "submit" verb — we PUT against the
    # feedpath; the response body is empty on success.
    service.sitemaps().submit(siteUrl=site, feedpath=feedpath).execute()

    db = get_db()
    now = datetime.now(timezone.utc)
    await db["gsc_sitemap_submits"].insert_one({
        "site_url": site,
        "feedpath": feedpath,
        "submitted_at": now,
        "submitted_by": admin_user_id,
    })
    return {
        "submitted": True,
        "site_url": site,
        "feedpath": feedpath,
        "submitted_at": now.isoformat(),
    }


async def delete_sitemap(
    admin_user_id: str, *, feedpath: str, site_url: str | None = None
) -> dict[str, Any]:
    creds = await get_credentials_for_admin(admin_user_id)
    service = build("searchconsole", "v1", credentials=creds, cache_discovery=False)
    site = site_url or DEFAULT_SITE_URL
    service.sitemaps().delete(siteUrl=site, feedpath=feedpath).execute()
    return {"deleted": True, "feedpath": feedpath, "site_url": site}


async def inspect_url(
    admin_user_id: str, *, url: str, site_url: str | None = None
) -> dict[str, Any]:
    """URL Inspection API — returns indexed-state, last crawl time,
    canonical mismatch, etc. Quota is 2k/day per property so we
    cache on the URL for 6 hours.
    """
    db = get_db()
    cache_col = "gsc_url_inspection_cache"
    cached = await db[cache_col].find_one({"_id": url})
    if cached and (datetime.now(timezone.utc) - cached["fetched_at"].replace(tzinfo=timezone.utc)) < timedelta(hours=6):
        out = dict(cached.get("payload") or {})
        out["from_cache"] = True
        return out

    creds = await get_credentials_for_admin(admin_user_id)
    service = build("searchconsole", "v1", credentials=creds, cache_discovery=False)
    site = site_url or DEFAULT_SITE_URL
    body = {"inspectionUrl": url, "siteUrl": site}
    resp = service.urlInspection().index().inspect(body=body).execute()
    inspection = resp.get("inspectionResult", {}) or {}
    index = inspection.get("indexStatusResult", {}) or {}
    mobile = inspection.get("mobileUsabilityResult", {}) or {}

    payload = {
        "url": url,
        "site_url": site,
        "verdict": index.get("verdict"),  # PASS / NEUTRAL / FAIL / PARTIAL
        "coverage_state": index.get("coverageState"),  # human-readable
        "indexing_state": index.get("indexingState"),
        "robots_txt_state": index.get("robotsTxtState"),
        "page_fetch_state": index.get("pageFetchState"),
        "last_crawl_time": index.get("lastCrawlTime"),
        "google_canonical": index.get("googleCanonical"),
        "user_canonical": index.get("userCanonical"),
        "mobile_friendly": mobile.get("verdict"),
        "inspection_link": inspection.get("inspectionResultLink"),
        "from_cache": False,
    }
    await db[cache_col].replace_one(
        {"_id": url},
        {"_id": url, "fetched_at": datetime.now(timezone.utc), "payload": payload},
        upsert=True,
    )
    return payload


# ───────── Auto-submit hook ─────────

async def maybe_auto_submit_sitemap(reason: str = "auto") -> dict[str, Any]:
    """Submit the public sitemap to Google if:
      • some admin has a connected GSC token, AND
      • we haven't auto-submitted in the last AUTO_SUBMIT_MIN_INTERVAL_HOURS.
    Used on app startup and after city-page publishes. Safe to call
    repeatedly — the throttle prevents abuse.
    """
    db = get_db()
    last = await db["gsc_sitemap_submits"].find_one(
        {"submitted_by": {"$ne": "manual"}},
        sort=[("submitted_at", -1)],
    )
    if last:
        elapsed = datetime.now(timezone.utc) - last["submitted_at"].replace(tzinfo=timezone.utc)
        if elapsed < timedelta(hours=AUTO_SUBMIT_MIN_INTERVAL_HOURS):
            return {"skipped": True, "reason": "throttled", "last_submit": last["submitted_at"].isoformat()}

    admin_id = await _pick_connected_admin()
    if not admin_id:
        return {"skipped": True, "reason": "no_connected_admin"}

    try:
        result = await submit_sitemap(admin_id)
        # Annotate the row so we can distinguish auto vs manual submits.
        await db["gsc_sitemap_submits"].update_one(
            {"site_url": result["site_url"], "submitted_at": {"$gte": datetime.now(timezone.utc) - timedelta(seconds=30)}},
            {"$set": {"trigger": reason}},
        )
        return {"submitted": True, "trigger": reason, **result}
    except HTTPException as exc:
        logger.warning("auto-submit sitemap skipped: %s", exc.detail)
        return {"skipped": True, "reason": str(exc.detail)}
    except Exception as exc:
        logger.exception("auto-submit sitemap failed")
        return {"skipped": True, "reason": f"server_error: {exc}"}

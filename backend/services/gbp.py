"""
Google Business Profile (GBP / GMB) integration — single-tenant.

Mirrors the shape of `services/gsc.py` so the admin UI, OAuth callback
flow, token refresh, and Express proxy rules stay symmetrical with the
already-shipped Search Console integration.

What it does (Phase 1):
  - OAuth connect/disconnect/status for Google Business Profile
  - List of locations on the connected account
  - Reviews + ratings for a location
  - Performance insights (calls, direction requests, website clicks,
    map / search impressions) for the last N days

CRITICAL OPERATIONAL NOTES
--------------------------
1. GBP API requires Google to *explicitly approve* your project before
   the quotas open. Until then EVERY API call returns 403 / quota=0.
   Apply at: https://support.google.com/business/contact/api_default
   This module degrades gracefully: if `is_configured()` is false or
   the project hasn't been allowlisted yet, every endpoint returns a
   503 with an actionable message rather than crashing.

2. We reuse the *same* Google OAuth client as GSC, so the user does
   NOT need a new client_id/secret. They DO need to:
     - Enable these APIs in GCP:
        • Google My Business API (legacy, still required for /reviews)
        • My Business Account Management API
        • My Business Business Information API
        • Business Profile Performance API
     - Add the scope `https://www.googleapis.com/auth/business.manage`
       to the OAuth consent screen.

3. Tokens are stored separately from GSC (collection: gbp_oauth_tokens)
   because the user MAY connect a different Google account for the
   business profile than for Search Console.
"""
from __future__ import annotations

import logging
import os

# Relax oauthlib's strict scope-equality check — see services/gsc.py
# for the full rationale. Google's IdP grants `userinfo.profile` even
# when we only asked for `userinfo.email` (OIDC compliance), and the
# library refuses to complete the token exchange otherwise. Must be
# set before importing google_auth_oauthlib.flow.
os.environ.setdefault("OAUTHLIB_RELAX_TOKEN_SCOPE", "1")

from datetime import datetime, timedelta, timezone
from typing import Any

import requests
from fastapi import HTTPException
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow

from config import get_db

logger = logging.getLogger(__name__)

GBP_SCOPES: list[str] = [
    "https://www.googleapis.com/auth/business.manage",
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
]

GOOGLE_AUTH_URI = "https://accounts.google.com/o/oauth2/auth"
GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"

# GBP API hosts — different from GSC; each is a separate REST API.
ACCOUNT_MGMT_BASE = "https://mybusinessaccountmanagement.googleapis.com/v1"
BUSINESS_INFO_BASE = "https://mybusinessbusinessinformation.googleapis.com/v1"
GMB_LEGACY_BASE = "https://mybusiness.googleapis.com/v4"  # reviews live here
PERFORMANCE_BASE = "https://businessprofileperformance.googleapis.com/v1"

TOKENS_COLLECTION = "gbp_oauth_tokens"


def _settings_from_env() -> dict[str, str]:
    """Same OAuth client as GSC. Redirect URI may be overridden so the
    callback path can differ (we use /api/admin/gbp/callback)."""
    client_id = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
    client_secret = os.environ.get("GOOGLE_CLIENT_SECRET", "").strip()

    backend_base = (
        os.environ.get("BACKEND_URL")
        or os.environ.get("PUBLIC_BACKEND_URL")
        or ""
    ).rstrip("/")

    redirect_uri = (
        os.environ.get("GBP_OAUTH_REDIRECT_URI")
        or (f"{backend_base}/api/admin/gbp/callback" if backend_base else "")
    ).strip()

    # If GBP-specific redirect not set, fall back to deriving from the GSC
    # one (same host) — saves the user setting two env vars on day 1.
    if not redirect_uri:
        gsc_redirect = (os.environ.get("GOOGLE_OAUTH_REDIRECT_URI") or "").strip()
        if gsc_redirect.endswith("/api/admin/gsc/callback"):
            redirect_uri = gsc_redirect.replace(
                "/api/admin/gsc/callback", "/api/admin/gbp/callback"
            )

    return {
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": redirect_uri,
    }


def is_configured() -> bool:
    s = _settings_from_env()
    return bool(s["client_id"] and s["client_secret"] and s["redirect_uri"])


def _build_flow(state: str | None = None) -> Flow:
    s = _settings_from_env()
    if not s["client_id"] or not s["client_secret"]:
        raise HTTPException(
            status_code=503,
            detail=(
                "Google Business Profile OAuth is not configured. "
                "Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and "
                "GBP_OAUTH_REDIRECT_URI in backend env."
            ),
        )
    return Flow.from_client_config(
        {
            "web": {
                "client_id": s["client_id"],
                "client_secret": s["client_secret"],
                "auth_uri": GOOGLE_AUTH_URI,
                "token_uri": GOOGLE_TOKEN_URI,
                "redirect_uris": [s["redirect_uri"]],
            }
        },
        scopes=GBP_SCOPES,
        redirect_uri=s["redirect_uri"],
        state=state,
        autogenerate_code_verifier=False,
    )


def build_authorization_url(state: str) -> tuple[str, str | None]:
    flow = _build_flow(state=state)
    auth_url, _ = flow.authorization_url(
        access_type="offline",
        include_granted_scopes="true",
        prompt="consent",
    )
    return auth_url, getattr(flow, "code_verifier", None)


async def exchange_code_and_store(
    *, admin_user_id: str, code: str, state: str
) -> dict[str, Any]:
    flow = _build_flow(state=state)
    flow.fetch_token(code=code)
    creds = flow.credentials

    if not creds.refresh_token:
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
        "scopes": list(creds.scopes or GBP_SCOPES),
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
    try:
        r = requests.get(
            GOOGLE_USERINFO_URL,
            headers={"Authorization": f"Bearer {creds.token}"},
            timeout=10,
        )
        if r.status_code == 200:
            return (r.json() or {}).get("email")
    except Exception as exc:  # pragma: no cover
        logger.warning("Failed to fetch Google account email: %s", exc)
    return None


async def get_status(admin_user_id: str) -> dict[str, Any]:
    db = get_db()
    doc = await db[TOKENS_COLLECTION].find_one(
        {"_id": admin_user_id},
        {"refresh_token": 0, "access_token": 0},
    )
    if not doc:
        return {"connected": False, "configured": is_configured()}
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
    s = _settings_from_env()
    db = get_db()
    doc = await db[TOKENS_COLLECTION].find_one({"_id": admin_user_id})
    if not doc or not doc.get("refresh_token"):
        raise HTTPException(
            status_code=401,
            detail="Google Business Profile is not connected. Connect it in /admin/gbp first.",
        )
    creds = Credentials(
        token=doc.get("access_token"),
        refresh_token=doc["refresh_token"],
        token_uri=GOOGLE_TOKEN_URI,
        client_id=s["client_id"],
        client_secret=s["client_secret"],
        scopes=doc.get("scopes", GBP_SCOPES),
    )
    if doc.get("access_token_expires_at"):
        creds.expiry = doc["access_token_expires_at"].replace(tzinfo=None)

    if creds.expired or not creds.valid:
        try:
            creds.refresh(GoogleRequest())
            await db[TOKENS_COLLECTION].update_one(
                {"_id": admin_user_id},
                {"$set": {
                    "access_token": creds.token,
                    "access_token_expires_at": (
                        creds.expiry.replace(tzinfo=timezone.utc) if creds.expiry else None
                    ),
                    "last_refreshed_at": datetime.now(timezone.utc),
                }},
            )
        except Exception as exc:
            logger.error("GBP token refresh failed for %s: %s", admin_user_id, exc)
            raise HTTPException(
                status_code=401,
                detail="Google Business Profile token refresh failed — please reconnect.",
            ) from exc

    await db[TOKENS_COLLECTION].update_one(
        {"_id": admin_user_id},
        {"$set": {"last_used_at": datetime.now(timezone.utc)}},
    )
    return creds


# ────────────────────────────────────────────────────────────────────────
# Low-level REST helper.
#
# We use plain `requests` (not the discovery client) because the
# Business Profile APIs split across 4 different services; building a
# discovery client per-call is heavier than the calls themselves, and
# the JSON shape is well-documented and stable.
# ────────────────────────────────────────────────────────────────────────


def _gbp_get(creds: Credentials, url: str, params: dict | None = None) -> dict:
    r = requests.get(
        url,
        headers={"Authorization": f"Bearer {creds.token}"},
        params=params or {},
        timeout=20,
    )
    if r.status_code == 403:
        # Most commonly the project hasn't been allowlisted yet.
        raise HTTPException(
            status_code=503,
            detail=(
                "Google denied access (403). Most likely your project has not "
                "yet been approved for Business Profile API access. Apply at "
                "https://support.google.com/business/contact/api_default and "
                "wait for the approval email before retrying."
            ),
        )
    if r.status_code == 429:
        raise HTTPException(
            status_code=429,
            detail="Google Business Profile API rate-limited — try again in a minute.",
        )
    if not r.ok:
        try:
            err = r.json().get("error", {}).get("message")
        except Exception:
            err = r.text[:200]
        raise HTTPException(
            status_code=502,
            detail=f"Google Business Profile API error ({r.status_code}): {err}",
        )
    return r.json() or {}


# ────────────────────────────────────────────────────────────────────────
# Public service methods (Phase 1)
# ────────────────────────────────────────────────────────────────────────


async def list_locations(admin_user_id: str) -> dict[str, Any]:
    """Return the locations on the first GBP account this admin manages.
    Single-tenant assumption: 1 admin → 1 account → N locations.
    """
    creds = await get_credentials_for_admin(admin_user_id)

    # 1) accounts list
    accs = _gbp_get(creds, f"{ACCOUNT_MGMT_BASE}/accounts")
    accounts = accs.get("accounts", []) or []
    if not accounts:
        return {"accounts": [], "locations": []}

    account_name = accounts[0]["name"]  # "accounts/123"
    # 2) locations list (Business Information API requires readMask)
    read_mask = "name,title,storeCode,phoneNumbers,storefrontAddress,websiteUri,metadata"
    locs = _gbp_get(
        creds,
        f"{BUSINESS_INFO_BASE}/{account_name}/locations",
        params={"readMask": read_mask, "pageSize": 100},
    )
    locations: list[dict[str, Any]] = []
    for loc in locs.get("locations", []) or []:
        loc_name = loc.get("name", "")  # "locations/456"
        loc_id = loc_name.split("/")[-1] if loc_name else None
        addr = loc.get("storefrontAddress", {}) or {}
        locations.append({
            "id": loc_id,
            "resource_name": loc_name,
            "title": loc.get("title"),
            "store_code": loc.get("storeCode"),
            "primary_phone": (loc.get("phoneNumbers", {}) or {}).get("primaryPhone"),
            "website_uri": loc.get("websiteUri"),
            "address_lines": addr.get("addressLines", []),
            "locality": addr.get("locality"),
            "postal_code": addr.get("postalCode"),
            "maps_uri": (loc.get("metadata", {}) or {}).get("mapsUri"),
            "place_uri": (loc.get("metadata", {}) or {}).get("newReviewUri"),
        })

    return {
        "account": {
            "name": account_name,
            "account_name_friendly": accounts[0].get("accountName"),
            "type": accounts[0].get("type"),
        },
        "locations": locations,
    }


async def get_reviews(admin_user_id: str, *, location_id: str, page_size: int = 50) -> dict[str, Any]:
    """Reviews for one location. Uses the legacy v4 endpoint which is
    still the only place reviews are exposed (Sept 2024+).
    """
    creds = await get_credentials_for_admin(admin_user_id)

    accs = _gbp_get(creds, f"{ACCOUNT_MGMT_BASE}/accounts")
    accounts = accs.get("accounts", []) or []
    if not accounts:
        raise HTTPException(status_code=404, detail="No GBP accounts on connected Google account.")
    account_id = accounts[0]["name"].split("/")[-1]

    payload = _gbp_get(
        creds,
        f"{GMB_LEGACY_BASE}/accounts/{account_id}/locations/{location_id}/reviews",
        params={"pageSize": min(max(int(page_size), 1), 50)},
    )

    star_word_to_int = {
        "ONE": 1, "TWO": 2, "THREE": 3, "FOUR": 4, "FIVE": 5,
    }
    reviews = []
    for r in payload.get("reviews", []) or []:
        rating = star_word_to_int.get(r.get("starRating"), None)
        reviews.append({
            "id": r.get("reviewId") or r.get("name", "").split("/")[-1],
            "rating": rating,
            "comment": r.get("comment", ""),
            "reviewer_name": (r.get("reviewer", {}) or {}).get("displayName") or "Anonymous",
            "reviewer_photo": (r.get("reviewer", {}) or {}).get("profilePhotoUrl"),
            "created_at": r.get("createTime"),
            "updated_at": r.get("updateTime"),
            "has_reply": bool(r.get("reviewReply")),
            "reply_text": (r.get("reviewReply", {}) or {}).get("comment"),
        })

    return {
        "reviews": reviews,
        "average_rating": payload.get("averageRating"),
        "total_count": payload.get("totalReviewCount", len(reviews)),
        "next_page_token": payload.get("nextPageToken"),
    }


async def get_insights(admin_user_id: str, *, location_id: str, days: int = 30) -> dict[str, Any]:
    """Last-N-day performance metrics: calls, directions, website clicks
    and map / search impressions. Powered by the Business Profile
    Performance API."""
    creds = await get_credentials_for_admin(admin_user_id)

    days = max(1, min(int(days or 30), 540))  # Performance API supports up to 18 months
    end = (datetime.now(timezone.utc) - timedelta(days=1)).date()
    start = end - timedelta(days=days - 1)

    metrics = [
        "WEBSITE_CLICKS",
        "CALL_CLICKS",
        "BUSINESS_DIRECTION_REQUESTS",
        "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
        "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
        "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
        "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
    ]
    params: list[tuple[str, str]] = [
        ("dailyRange.start_date.year", str(start.year)),
        ("dailyRange.start_date.month", str(start.month)),
        ("dailyRange.start_date.day", str(start.day)),
        ("dailyRange.end_date.year", str(end.year)),
        ("dailyRange.end_date.month", str(end.month)),
        ("dailyRange.end_date.day", str(end.day)),
    ]
    for m in metrics:
        params.append(("dailyMetrics", m))

    url = f"{PERFORMANCE_BASE}/locations/{location_id}:fetchMultiDailyMetricsTimeSeries"
    payload = _gbp_get(creds, url, params=params)

    totals = {m.lower(): 0 for m in metrics}
    daily_by_metric: dict[str, list[dict[str, Any]]] = {m: [] for m in metrics}

    for series in payload.get("multiDailyMetricTimeSeries", []) or []:
        for ts in (series.get("dailyMetricTimeSeries") or []):
            metric = ts.get("dailyMetric")
            if metric not in totals:
                continue
            for dv in ((ts.get("timeSeries") or {}).get("datedValues") or []):
                v = int(dv.get("value", 0) or 0)
                d = dv.get("date") or {}
                date_str = f"{d.get('year', 0):04d}-{d.get('month', 0):02d}-{d.get('day', 0):02d}"
                totals[metric.lower()] += v
                daily_by_metric[metric].append({"date": date_str, "value": v})

    impressions_total = (
        totals["business_impressions_desktop_maps"]
        + totals["business_impressions_desktop_search"]
        + totals["business_impressions_mobile_maps"]
        + totals["business_impressions_mobile_search"]
    )

    return {
        "location_id": location_id,
        "window_days": days,
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "totals": {
            "website_clicks": totals["website_clicks"],
            "calls": totals["call_clicks"],
            "direction_requests": totals["business_direction_requests"],
            "impressions_total": impressions_total,
            "impressions_search": (
                totals["business_impressions_desktop_search"]
                + totals["business_impressions_mobile_search"]
            ),
            "impressions_maps": (
                totals["business_impressions_desktop_maps"]
                + totals["business_impressions_mobile_maps"]
            ),
        },
        "daily": daily_by_metric,
    }

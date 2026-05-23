"""
Google Search Console — admin OAuth connect routes.

All endpoints are admin-gated (super_admin / admin / manager) so that
only the small set of trusted users can bind a Google account to the
Tile Station backend.

Routes (mounted under /api):
  GET  /admin/gsc/status        → connection status + configured flag
  GET  /admin/gsc/connect       → returns the Google consent URL (frontend redirects)
  GET  /admin/gsc/callback      → public OAuth redirect target — exchanges code,
                                   stores refresh_token, redirects back to /admin/seo
  POST /admin/gsc/disconnect    → wipe the stored tokens
  GET  /admin/gsc/sites         → list verified GSC properties for this admin
                                   (smoke-test that the connection actually works)
"""
from __future__ import annotations

import logging
import os
import secrets
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import RedirectResponse

from config import get_db
from services import get_current_user
from services import gsc as gsc_service
logger = logging.getLogger(__name__)
router = APIRouter(prefix="/admin/gsc", tags=["GSC OAuth"])

# Where to send the admin after the OAuth callback completes. We store
# this on the state row so a deep-link admin can be returned to the
# right page (default: /admin/seo).
DEFAULT_RETURN_PATH = "/admin/seo"

# State token TTL — prevents stale callbacks being replayed weeks later.
STATE_TTL_MINUTES = 15

STATE_COLLECTION = "gsc_oauth_states"


def _is_admin(user: dict) -> bool:
    return (user or {}).get("role") in {"super_admin", "admin", "manager"}


def _frontend_origin() -> str:
    """Where the user is redirected to after callback completes.
    Derive from GOOGLE_OAUTH_REDIRECT_URI first (same env as the callback)
    so preview → preview, prod → prod. Env overrides remain available
    for edge cases (e.g. backend on a separate subdomain from frontend).
    """
    # 1. explicit override
    explicit = (
        os.environ.get("GSC_FRONTEND_ORIGIN")
        or os.environ.get("FRONTEND_URL")
        or ""
    ).rstrip("/")
    if explicit:
        return explicit
    # 2. derive from the redirect URI registered with Google
    redirect_uri = (os.environ.get("GOOGLE_OAUTH_REDIRECT_URI") or "").strip()
    if redirect_uri:
        from urllib.parse import urlparse
        parsed = urlparse(redirect_uri)
        if parsed.scheme and parsed.netloc:
            return f"{parsed.scheme}://{parsed.netloc}"
    # 3. last-resort: the public site (useful when backend sits on the
    # same host as the frontend — typical Railway deployment).
    return (
        os.environ.get("SHOP_WEBSITE_URL")
        or os.environ.get("PUBLIC_SITE_URL")
        or ""
    ).rstrip("/")


@router.get("/status")
async def status(current_user: dict = Depends(get_current_user)):
    if not _is_admin(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    admin_id = str(current_user.get("id") or current_user.get("_id") or current_user.get("email"))
    return await gsc_service.get_status(admin_id)


@router.get("/connect")
async def connect(
    return_to: str = Query(DEFAULT_RETURN_PATH, description="Frontend path to redirect to after callback"),
    current_user: dict = Depends(get_current_user),
):
    if not _is_admin(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    if not gsc_service.is_configured():
        raise HTTPException(
            status_code=503,
            detail=(
                "Google Search Console OAuth is not configured. Ask the developer to set "
                "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_OAUTH_REDIRECT_URI in backend .env."
            ),
        )

    admin_id = str(current_user.get("id") or current_user.get("_id") or current_user.get("email"))
    state = secrets.token_urlsafe(32)
    auth_url, code_verifier = gsc_service.build_authorization_url(state=state)

    # Persist state → admin id mapping so the public callback can find it.
    db = get_db()
    await db[STATE_COLLECTION].insert_one({
        "_id": state,
        "admin_user_id": admin_id,
        "return_to": return_to or DEFAULT_RETURN_PATH,
        "code_verifier": code_verifier,
        "created_at": datetime.now(timezone.utc),
        "expires_at": datetime.now(timezone.utc) + timedelta(minutes=STATE_TTL_MINUTES),
    })

    return {"authorization_url": auth_url}


@router.get("/callback", include_in_schema=False)
async def callback(
    request: Request,
    code: str | None = Query(None),
    state: str | None = Query(None),
    error: str | None = Query(None),
):
    """
    Public — Google redirects here after the consent screen.
    No JWT auth (the user is not logged in to our app via JWT in this
    redirect; the state token IS the auth).
    """
    front = _frontend_origin()

    def _redirect(path: str, **params) -> RedirectResponse:
        # If we don't know the frontend origin (e.g. local dev) just
        # render a tiny success page rather than redirecting blindly.
        qs = "&".join(f"{k}={quote(str(v), safe='')}" for k, v in params.items() if v is not None)
        if not front:
            return RedirectResponse(url=f"{path}?{qs}" if qs else path, status_code=303)
        return RedirectResponse(url=f"{front}{path}?{qs}" if qs else f"{front}{path}", status_code=303)

    if error:
        return _redirect(DEFAULT_RETURN_PATH, gsc="error", reason=error)

    if not code or not state:
        return _redirect(DEFAULT_RETURN_PATH, gsc="error", reason="missing_code")

    db = get_db()
    state_row = await db[STATE_COLLECTION].find_one({"_id": state})
    if not state_row:
        return _redirect(DEFAULT_RETURN_PATH, gsc="error", reason="invalid_state")

    # Drop the state row immediately so it can't be replayed.
    await db[STATE_COLLECTION].delete_one({"_id": state})

    expires_at = state_row.get("expires_at")
    if expires_at is not None and expires_at.tzinfo is None:
        # Mongo can strip tzinfo depending on driver version — reattach UTC.
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at and expires_at < datetime.now(timezone.utc):
        return _redirect(DEFAULT_RETURN_PATH, gsc="error", reason="state_expired")

    admin_id = state_row.get("admin_user_id")
    return_to = state_row.get("return_to") or DEFAULT_RETURN_PATH
    code_verifier = state_row.get("code_verifier")

    try:
        result = await gsc_service.exchange_code_and_store(
            admin_user_id=admin_id, code=code, state=state, code_verifier=code_verifier
        )
    except HTTPException as exc:
        # 23 May 2026 — surface the actual exchange failure message in the
        # toast so admins (and us) can diagnose Google OAuth misconfigs
        # without trawling Railway logs. Previously every failure showed
        # "server_error" with zero context. Truncated to 200 chars to fit
        # comfortably in the redirect URL.
        logger.warning("GSC token exchange failed: %s", exc.detail)
        reason = str(exc.detail or "exchange_failed")[:200]
        return _redirect(DEFAULT_RETURN_PATH, gsc="error", reason=reason)
    except Exception as exc:
        logger.exception("GSC token exchange unexpected failure")
        # Same idea — pass the EXCEPTION CLASS name + first line of the
        # message so we can tell apart e.g. `InvalidGrantError`,
        # `MismatchingStateError`, `requests.ConnectionError`, etc.
        msg = f"{type(exc).__name__}: {str(exc).splitlines()[0] if str(exc) else 'no message'}"
        return _redirect(DEFAULT_RETURN_PATH, gsc="error", reason=msg[:200])

    return _redirect(
        return_to,
        gsc="connected",
        email=result.get("google_account_email") or "",
    )


@router.post("/disconnect")
async def disconnect(current_user: dict = Depends(get_current_user)):
    if not _is_admin(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    admin_id = str(current_user.get("id") or current_user.get("_id") or current_user.get("email"))
    return await gsc_service.disconnect(admin_id)


@router.get("/sites")
async def list_sites(current_user: dict = Depends(get_current_user)):
    """Smoke-test that the GSC connection actually works.
    Returns the GSC properties this admin has access to.
    """
    if not _is_admin(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    admin_id = str(current_user.get("id") or current_user.get("_id") or current_user.get("email"))
    sites = await gsc_service.list_sites(admin_id)
    return {"sites": sites, "count": len(sites)}



# ────────────────────────────────────────────────────────────────────────
# Phase 2 — Search Analytics endpoints
# ────────────────────────────────────────────────────────────────────────


def _admin_id(user: dict) -> str:
    return str(user.get("id") or user.get("_id") or user.get("email"))


@router.get("/analytics/overview")
async def analytics_overview(
    days: int = Query(28, ge=1, le=365),
    current_user: dict = Depends(get_current_user),
):
    """Site-wide aggregate clicks/impressions/CTR/avg-position. Powers
    the 4 metric cards in the admin SEO panel.
    """
    if not _is_admin(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    return await gsc_service.get_overview(_admin_id(current_user), days=days)


@router.get("/analytics/top-queries")
async def analytics_top_queries(
    days: int = Query(28, ge=1, le=365),
    limit: int = Query(25, ge=1, le=500),
    current_user: dict = Depends(get_current_user),
):
    if not _is_admin(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    return await gsc_service.get_top_queries(_admin_id(current_user), days=days, limit=limit)


@router.get("/analytics/top-pages")
async def analytics_top_pages(
    days: int = Query(28, ge=1, le=365),
    limit: int = Query(25, ge=1, le=500),
    current_user: dict = Depends(get_current_user),
):
    if not _is_admin(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    return await gsc_service.get_top_pages(_admin_id(current_user), days=days, limit=limit)


@router.get("/analytics/page-queries")
async def analytics_page_queries(
    page: str = Query(..., description="Full URL of the page to filter to"),
    days: int = Query(28, ge=1, le=365),
    limit: int = Query(25, ge=1, le=500),
    current_user: dict = Depends(get_current_user),
):
    if not _is_admin(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    return await gsc_service.get_page_queries(
        _admin_id(current_user), page_url=page, days=days, limit=limit
    )


@router.get("/analytics/city-pages")
async def analytics_city_pages(
    days: int = Query(28, ge=1, le=365),
    limit: int = Query(200, ge=1, le=500),
    current_user: dict = Depends(get_current_user),
):
    """Performance summary for every page matching `/tiles/` —
    our city-landing-page pattern.
    """
    if not _is_admin(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    return await gsc_service.get_city_pages_summary(
        _admin_id(current_user), days=days, limit=limit
    )



# ────────────────────────────────────────────────────────────────────────
# Phase 3 — Sitemaps + URL Inspection endpoints
# ────────────────────────────────────────────────────────────────────────


@router.get("/sitemaps")
async def sitemaps_list(current_user: dict = Depends(get_current_user)):
    if not _is_admin(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    return await gsc_service.list_sitemaps(_admin_id(current_user))


@router.post("/sitemaps/submit")
async def sitemaps_submit(
    feedpath: str | None = None,
    current_user: dict = Depends(get_current_user),
):
    if not _is_admin(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    # Tag manual submits so the auto-submit throttle doesn't count them.
    res = await gsc_service.submit_sitemap(_admin_id(current_user), feedpath=feedpath)
    db = get_db()
    await db["gsc_sitemap_submits"].update_one(
        {"feedpath": res["feedpath"], "submitted_at": {"$gte": datetime.now(timezone.utc) - timedelta(seconds=30)}},
        {"$set": {"trigger": "manual"}},
    )
    return res


@router.delete("/sitemaps")
async def sitemaps_delete(
    feedpath: str = Query(..., description="Sitemap feed URL to remove"),
    current_user: dict = Depends(get_current_user),
):
    if not _is_admin(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    return await gsc_service.delete_sitemap(_admin_id(current_user), feedpath=feedpath)


@router.get("/inspect")
async def inspect_url(
    url: str = Query(..., description="Full URL to inspect"),
    current_user: dict = Depends(get_current_user),
):
    if not _is_admin(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    return await gsc_service.inspect_url(_admin_id(current_user), url=url)


# ────────────────────────────────────────────────────────────────────────
# Phase 4 — manual triggers for the digest + CTR-drop checks
# Useful for "send a test email now" without waiting for Monday.
# ────────────────────────────────────────────────────────────────────────


@router.post("/digest/send-now")
async def digest_send_now(
    force: bool = Query(False, description="Re-send even if already sent this week"),
    current_user: dict = Depends(get_current_user),
):
    if not _is_admin(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    from services.gsc_digest import run_gsc_weekly_digest
    return await run_gsc_weekly_digest(force=force)


@router.post("/ctr-drop/check-now")
async def ctr_drop_check_now(
    force: bool = Query(False, description="Re-fire alerts for already-alerted URLs this week"),
    current_user: dict = Depends(get_current_user),
):
    if not _is_admin(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    from services.gsc_digest import run_gsc_ctr_drop_check
    return await run_gsc_ctr_drop_check(force=force)


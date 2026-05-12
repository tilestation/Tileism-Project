"""
SEO Autopilot Admin Routes
──────────────────────────
Exposes the self-crawler, GSC indexing scanner, and auto-fix tools
to the admin UI. Read-only endpoints for the dashboard + write
endpoints to trigger scans manually (useful for testing + when
the admin wants results NOW instead of waiting for the nightly cron).

All endpoints under /api/admin/seo-autopilot/ require admin auth.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from services import get_current_user
from config import get_db
from services.seo_self_crawler import (
    auto_fix_from_latest_crawl,
    fire_regression_alert,
    get_latest_snapshot,
    list_issues_by_kind,
    run_full_autopilot_cycle,
    run_self_crawl,
)
from services.gsc_indexing_scanner import (
    get_latest_indexing_breakdown,
    run_gsc_indexing_scan,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/admin/seo-autopilot-v2", tags=["Admin · SEO Autopilot v2"])


def _require_admin(user: dict | None) -> None:
    role = (user or {}).get("role")
    if role not in ("admin", "super_admin", "manager"):
        raise HTTPException(status_code=403, detail="Admin only")


# ─── Dashboard summary ─────────────────────────────────────────────


@router.get("/dashboard")
async def autopilot_dashboard(user: dict = Depends(get_current_user)):
    """Single-call summary for the admin dashboard."""
    _require_admin(user)
    snap = await get_latest_snapshot()
    gsc = await get_latest_indexing_breakdown()
    db = get_db()
    redirects_count = await db.seo_redirects.count_documents({})
    recent_actions = []
    cur = db.seo_autopilot_actions.find(
        {}, {"_id": 0},
    ).sort("ts", -1).limit(25)
    async for row in cur:
        ts = row.get("ts")
        if isinstance(ts, datetime):
            row["ts"] = ts.isoformat()
        recent_actions.append(row)

    return {
        "latest_self_crawl": snap,
        "gsc_buckets": gsc.get("buckets") or [],
        "active_redirects": redirects_count,
        "recent_actions": recent_actions,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


@router.get("/issues")
async def autopilot_issues_by_kind(
    kind: str = Query(..., description="e.g. fallback_title, not_found, thin_content"),
    limit: int = 100,
    user: dict = Depends(get_current_user),
):
    """Page-level rows for one issue kind."""
    _require_admin(user)
    return {"kind": kind, "rows": await list_issues_by_kind(kind, limit=limit)}


@router.get("/redirects")
async def autopilot_redirects_list(
    limit: int = 200, user: dict = Depends(get_current_user),
):
    """All active 301 redirects."""
    _require_admin(user)
    db = get_db()
    cursor = db.seo_redirects.find(
        {}, {"_id": 1, "target": 1, "reason": 1, "created_at": 1,
             "hits_at_creation": 1, "status_code": 1},
    ).sort("created_at", -1).limit(limit)
    out = []
    async for row in cursor:
        ts = row.get("created_at")
        out.append({
            "from": row.get("_id"),
            "to": row.get("target"),
            "reason": row.get("reason") or "manual",
            "hits_at_creation": row.get("hits_at_creation", 0),
            "status_code": row.get("status_code", 301),
            "created_at": ts.isoformat() if isinstance(ts, datetime) else None,
        })
    return {"count": len(out), "redirects": out}


@router.delete("/redirects/{path:path}")
async def autopilot_redirect_delete(
    path: str, user: dict = Depends(get_current_user),
):
    """Remove a redirect (one-click revert from admin)."""
    _require_admin(user)
    if not path.startswith("/"):
        path = "/" + path
    db = get_db()
    res = await db.seo_redirects.delete_one({"_id": path})
    return {"deleted": res.deleted_count, "path": path}


# ─── Manual triggers ───────────────────────────────────────────────


@router.post("/run/self-crawl")
async def autopilot_trigger_self_crawl(
    limit: int = Query(None, description="Cap URLs (None=all)"),
    user: dict = Depends(get_current_user),
):
    """Trigger a self-crawl right now (useful for admin testing)."""
    _require_admin(user)
    summary = await run_self_crawl(limit=limit)
    return summary


@router.post("/run/auto-fix")
async def autopilot_trigger_auto_fix(user: dict = Depends(get_current_user)):
    """Apply safe auto-fixes from the latest crawl results."""
    _require_admin(user)
    return await auto_fix_from_latest_crawl()


@router.post("/run/gsc-scan")
async def autopilot_trigger_gsc_scan(
    limit: int = Query(200, ge=10, le=2000),
    user: dict = Depends(get_current_user),
):
    """Inspect a slice of sitemap URLs against the GSC URL Inspection API."""
    _require_admin(user)
    return await run_gsc_indexing_scan(limit=limit)


@router.post("/run/full-cycle")
async def autopilot_trigger_full_cycle(user: dict = Depends(get_current_user)):
    """One-shot: crawl → auto-fix → regression alert. ~50-80s end-to-end."""
    _require_admin(user)
    return await run_full_autopilot_cycle()


@router.post("/run/regression-alert")
async def autopilot_trigger_regression(user: dict = Depends(get_current_user)):
    """Fire the regression Telegram alert if the latest snapshot got worse."""
    _require_admin(user)
    return await fire_regression_alert()

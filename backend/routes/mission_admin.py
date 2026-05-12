"""
Mission: Narrow the Gap to Topps Tiles — admin routes.

Exposes:
  • GET  /api/admin/mission/status     — dashboard payload
  • GET  /api/admin/mission/history    — historical snapshots for charting
  • POST /api/admin/mission/snapshot   — manual snapshot trigger (admin)
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query

from services import get_current_user
from services.competitor_tracker import (
    COMPETITORS,
    OUR_DOMAIN,
    get_history,
    get_latest,
    get_mission_status,
    run_weekly_snapshot,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/admin/mission", tags=["Admin · SEO Mission"])


def _require_admin(user: dict | None) -> None:
    role = (user or {}).get("role")
    if role not in ("admin", "super_admin", "manager"):
        raise HTTPException(status_code=403, detail="Admin only")


@router.get("/status")
async def mission_status(user: dict = Depends(get_current_user)):
    """Full dashboard payload: latest snapshot, milestones, history."""
    _require_admin(user)
    return await get_mission_status()


@router.get("/history")
async def mission_history(
    limit: int = Query(52, ge=4, le=200),
    user: dict = Depends(get_current_user),
):
    """Historical snapshots for line-chart rendering."""
    _require_admin(user)
    rows = await get_history(limit=limit)
    return {"count": len(rows), "snapshots": rows}


@router.get("/latest")
async def mission_latest(user: dict = Depends(get_current_user)):
    """Just the latest snapshot — cheap call for dashboard headline."""
    _require_admin(user)
    return await get_latest() or {"empty": True}


@router.post("/snapshot")
async def mission_run_snapshot(user: dict = Depends(get_current_user)):
    """Trigger a snapshot right now (admin)."""
    _require_admin(user)
    snapshot = await run_weekly_snapshot()
    return {
        "ok": True,
        "snapshot": snapshot,
        "ran_at": datetime.now(timezone.utc).isoformat(),
    }


@router.get("/competitors")
async def mission_competitors(user: dict = Depends(get_current_user)):
    """Static — the list of domains we're tracking."""
    _require_admin(user)
    return {
        "our_domain": OUR_DOMAIN,
        "competitors": COMPETITORS,
    }

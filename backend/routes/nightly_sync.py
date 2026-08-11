"""
Nightly light-sync schedule — status / toggle / manual run.
"""
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from services import get_current_user, has_permission
from services.nightly_sync import (
    get_settings, set_enabled, get_last_run, start_run_in_background, is_running, SUPPLIERS,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/supplier-sync/nightly", tags=["Nightly Sync"])


@router.get("/status")
def nightly_status():
    settings = get_settings()
    next_run = None
    try:
        from services.scheduler import get_scheduler
        job = get_scheduler().get_job("nightly_light_sync")
        if job and job.next_run_time:
            next_run = job.next_run_time.isoformat()
    except Exception:
        pass
    last = get_last_run()
    if last:
        for k in ("started_at", "completed_at"):
            if last.get(k) and hasattr(last[k], "isoformat"):
                last[k] = last[k].isoformat()
    return {
        "enabled": settings["enabled"],
        "schedule": f"{settings['hour']:02d}:{settings['minute']:02d} Europe/London",
        "suppliers": SUPPLIERS,
        "next_run": next_run,
        "is_running": is_running(),
        "last_run": last,
    }


class ToggleRequest(BaseModel):
    enabled: bool


@router.post("/toggle")
def nightly_toggle(payload: ToggleRequest, current_user: dict = Depends(get_current_user)):
    if not has_permission(current_user, "supplier_products"):
        raise HTTPException(403, "You need the Supplier Products permission")
    set_enabled(payload.enabled)
    return {"ok": True, "enabled": payload.enabled}


@router.post("/run-now")
def nightly_run_now(current_user: dict = Depends(get_current_user)):
    if not has_permission(current_user, "supplier_products"):
        raise HTTPException(403, "You need the Supplier Products permission")
    if is_running():
        return {"ok": False, "message": "Nightly sync is already running"}
    start_run_in_background()
    return {"ok": True, "message": "Nightly light sync started for all suppliers"}

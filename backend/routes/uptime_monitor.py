"""
Synthetic uptime monitor with Telegram alerts (May 14, 2026)

Sibling of the existing `routes/uptime.py` which feeds the 30-day
sparkline widget. This file adds the **alerting** layer — Telegram
pings on every UP→DOWN / DOWN→UP transition with deep content
checks (search returns results, homepage contains brand name, etc.).
"""
from fastapi import APIRouter, Depends

from services import get_current_user
from services.uptime_monitor import get_uptime_state, run_uptime_tick

router = APIRouter(prefix="/admin", tags=["Uptime Monitor"])


@router.get("/uptime-monitor")
async def admin_uptime_monitor_status(current_user: dict = Depends(get_current_user)):
    """Latest state of every monitored canary + overall site status."""
    return await get_uptime_state()


@router.post("/uptime-monitor/run")
async def admin_uptime_monitor_run(current_user: dict = Depends(get_current_user)):
    """Force-run all canary checks now. Same code path the scheduler
    hits every 5 minutes — useful for testing the alert wiring without
    waiting 5 minutes for the next tick."""
    return await run_uptime_tick()

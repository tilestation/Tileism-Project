"""
Sync failure alarm API — powers the red alert on the admin dashboard
DataHealthCard and the dismiss/test actions.
"""
import os
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

from services.sync_alerts import (
    record_sync_failure,
    get_active_failures,
    get_stuck_syncs,
    dismiss_failures,
)

router = APIRouter(prefix="/sync-alerts", tags=["Sync Alerts"])


class DismissRequest(BaseModel):
    failure_id: Optional[str] = None
    all: bool = False


@router.get("/status")
def get_sync_alert_status():
    failures = get_active_failures()
    stuck = get_stuck_syncs()
    return {
        "failures": failures,
        "stuck": stuck,
        "has_alerts": bool(failures or stuck),
        "email_configured": bool(os.environ.get("RESEND_API_KEY")),
        "telegram_configured": bool(
            os.environ.get("TELEGRAM_BOT_TOKEN") and os.environ.get("TELEGRAM_CHAT_ID")
        ),
    }


@router.post("/dismiss")
def dismiss_sync_alerts(request: DismissRequest):
    count = dismiss_failures(failure_id=request.failure_id, dismiss_all=request.all)
    return {"dismissed": count}


@router.post("/test")
def send_test_alert():
    """Fire a fake failure so the owner can verify email/Telegram delivery."""
    record_sync_failure(
        "Test Alarm",
        "This is a TEST of the sync failure alarm — no real sync has failed.",
        "test",
    )
    return {
        "recorded": True,
        "email_configured": bool(os.environ.get("RESEND_API_KEY")),
        "telegram_configured": bool(
            os.environ.get("TELEGRAM_BOT_TOKEN") and os.environ.get("TELEGRAM_CHAT_ID")
        ),
    }

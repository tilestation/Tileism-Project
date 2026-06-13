"""
Auto-export schedules (13 Jun 2026).

User request: "Now that big email exports work, can you wire a tiny 'Send
to accountant every month' scheduler? … create a similar for Petty Cash /
Expenses where staff can upload images of expense receipts which can then
be emailed to accountant from each store on 1st of every month."

This module owns the persisted schedules. The hourly cron loop in
`server.py::_auto_exports_cron_loop` reads them and dispatches the
actual jobs (defined in `services.invoice_export_jobs` and
`services.petty_cash_export`).

Schedule shape (`db.auto_export_schedules`):
{
  id: str (uuid),
  kind: 'invoices' | 'petty_cash',
  scope: 'all' (invoices) | 'all_showrooms' | showroom_id (petty cash),
  recipient_emails: List[str] (1-5),
  enabled: bool,
  day_of_month: int (1-28 — cap at 28 so it works in February),
  subject: Optional[str],
  message: Optional[str],
  last_sent_at: Optional[str] (ISO UTC),
  last_sent_status: Optional[str] ('ok' | 'partial' | 'failed'),
  last_sent_note: Optional[str] (human-readable),
  created_by: str (email),
  created_at: str (ISO UTC),
  updated_at: str (ISO UTC),
}

For `kind='invoices'` the scope is always 'all' — invoices are a single
company-wide stream.

For `kind='petty_cash'` the scope is a `showroom_id` (per-store) or the
sentinel string `'all_showrooms'` (one combined email covering every
showroom). One schedule per scope is allowed, so multiple stores each
get their own auto-send going to potentially different accountants.

Super-admin only — these schedules dispatch financial data without
manual approval each month, so we lock them to the highest tier.
"""
import logging
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, EmailStr, Field

from config import get_db
from services import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auto-exports", tags=["AutoExports"])

VALID_KINDS = {"invoices", "petty_cash", "owner_digest"}
MAX_RECIPIENTS = 5
# Cap at 28 so a schedule set for "end of month" still fires every Feb.
# Anyone wanting "last day of month" can use 28 and most months will be
# late by 1-3 days; in practice accountants want the 1st of the month
# anyway, which works for every calendar month.
MAX_DAY_OF_MONTH = 28


class AutoExportScheduleIn(BaseModel):
    """Upsert payload. `scope` is required only for petty_cash.

    For `owner_digest` the recipient list is allowed to be empty —
    delivery is via Telegram (using the global `notification_settings.
    telegram.chat_ids`), so the e-mail recipients box on the UI is
    informational only.
    """
    recipient_emails: List[EmailStr] = Field(default_factory=list, max_length=MAX_RECIPIENTS)
    enabled: bool = True
    day_of_month: int = Field(default=1, ge=1, le=MAX_DAY_OF_MONTH)
    scope: Optional[str] = Field(default=None, max_length=80)
    subject: Optional[str] = Field(default=None, max_length=200)
    message: Optional[str] = Field(default=None, max_length=2000)


class AutoExportScheduleOut(BaseModel):
    id: str
    kind: str
    scope: str
    recipient_emails: List[str]
    enabled: bool
    day_of_month: int
    subject: Optional[str] = None
    message: Optional[str] = None
    last_sent_at: Optional[str] = None
    last_sent_status: Optional[str] = None
    last_sent_note: Optional[str] = None
    created_by: str
    created_at: str
    updated_at: str


def _require_super_admin(user: dict) -> None:
    if (user or {}).get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super admin only")


def _normalise_scope(kind: str, scope: Optional[str]) -> str:
    if kind == "invoices":
        # Invoices are company-wide; ignore any client-provided scope.
        return "all"
    if kind == "owner_digest":
        # The owner digest is a single per-company schedule. Forces
        # scope='global' so we never end up with duplicate rows.
        return "global"
    if kind == "petty_cash":
        if not scope:
            raise HTTPException(400, "petty_cash schedules require a `scope` (showroom_id or 'all_showrooms')")
        return scope
    raise HTTPException(400, f"Unknown kind: {kind}")


def _doc_to_out(doc: dict) -> dict:
    """Strip Mongo _id and force ISO strings."""
    return {
        "id": doc["id"],
        "kind": doc["kind"],
        "scope": doc.get("scope", "all"),
        "recipient_emails": list(doc.get("recipient_emails", [])),
        "enabled": bool(doc.get("enabled", False)),
        "day_of_month": int(doc.get("day_of_month", 1)),
        "subject": doc.get("subject"),
        "message": doc.get("message"),
        "last_sent_at": doc.get("last_sent_at"),
        "last_sent_status": doc.get("last_sent_status"),
        "last_sent_note": doc.get("last_sent_note"),
        "created_by": doc.get("created_by", ""),
        "created_at": doc.get("created_at", ""),
        "updated_at": doc.get("updated_at", ""),
    }


@router.get("")
async def list_auto_exports(current_user: dict = Depends(get_current_user)):
    """Return every schedule across both kinds. The UI filters in the
    browser — there are very few schedules so a single round-trip is
    simpler than two endpoints."""
    _require_super_admin(current_user)
    db = get_db()
    cur = db.auto_export_schedules.find({}, {"_id": 0}).sort("kind", 1)
    docs = await cur.to_list(200)
    return [_doc_to_out(d) for d in docs]


@router.put("/{kind}")
async def upsert_auto_export(
    kind: str,
    payload: AutoExportScheduleIn,
    current_user: dict = Depends(get_current_user),
):
    """Create or update the schedule for a given (kind, scope). Idempotent.

    - kind='invoices' has exactly one schedule (scope is forced to 'all').
    - kind='petty_cash' may have many schedules — one per showroom_id, plus
      optionally the 'all_showrooms' fallback. Each is keyed by
      (kind, scope) so the same showroom can't have two rivalling
      schedules.
    """
    _require_super_admin(current_user)
    if kind not in VALID_KINDS:
        raise HTTPException(400, f"Unknown kind: {kind}. Must be one of {sorted(VALID_KINDS)}")
    # Email-delivering kinds need at least one recipient; owner_digest
    # ships via Telegram so an empty list is fine.
    if kind != "owner_digest" and len(payload.recipient_emails) == 0:
        raise HTTPException(400, f"{kind} schedules require at least one recipient email")
    scope = _normalise_scope(kind, payload.scope)
    db = get_db()
    now_iso = datetime.now(timezone.utc).isoformat()
    existing = await db.auto_export_schedules.find_one({"kind": kind, "scope": scope}, {"_id": 0})
    if existing:
        update = {
            "recipient_emails": list(payload.recipient_emails),
            "enabled": payload.enabled,
            "day_of_month": payload.day_of_month,
            "subject": payload.subject,
            "message": payload.message,
            "updated_at": now_iso,
        }
        await db.auto_export_schedules.update_one(
            {"id": existing["id"]}, {"$set": update}
        )
        doc = {**existing, **update}
    else:
        doc = {
            "id": str(uuid.uuid4()),
            "kind": kind,
            "scope": scope,
            "recipient_emails": list(payload.recipient_emails),
            "enabled": payload.enabled,
            "day_of_month": payload.day_of_month,
            "subject": payload.subject,
            "message": payload.message,
            "last_sent_at": None,
            "last_sent_status": None,
            "last_sent_note": None,
            "created_by": (current_user or {}).get("email", ""),
            "created_at": now_iso,
            "updated_at": now_iso,
        }
        await db.auto_export_schedules.insert_one(dict(doc))
    return _doc_to_out(doc)


@router.delete("/{schedule_id}")
async def delete_auto_export(
    schedule_id: str,
    current_user: dict = Depends(get_current_user),
):
    """Remove a schedule. After deletion the cron loop will never trigger
    that (kind, scope) again."""
    _require_super_admin(current_user)
    db = get_db()
    result = await db.auto_export_schedules.delete_one({"id": schedule_id})
    if result.deleted_count == 0:
        raise HTTPException(404, "Schedule not found")
    return {"ok": True, "deleted": schedule_id}


class RunNowRequest(BaseModel):
    """Optional override of the target month — defaults to the *previous*
    calendar month (the same window the cron uses)."""
    year: Optional[int] = Field(default=None, ge=2020, le=2100)
    month: Optional[int] = Field(default=None, ge=1, le=12)


@router.post("/{schedule_id}/run-now")
async def run_auto_export_now(
    schedule_id: str,
    payload: Optional[RunNowRequest] = None,
    background_tasks: BackgroundTasks = None,  # noqa: B008
    current_user: dict = Depends(get_current_user),
):
    """Manual trigger — useful for the UI's 'Send now' button so the admin
    can preview what next month's cron will do.

    Returns immediately with `queued: true`. The actual send happens in
    a background task (reusing the same job functions the cron calls).
    """
    _require_super_admin(current_user)
    db = get_db()
    schedule = await db.auto_export_schedules.find_one({"id": schedule_id}, {"_id": 0})
    if not schedule:
        raise HTTPException(404, "Schedule not found")

    payload = payload or RunNowRequest()
    if payload.year and payload.month:
        target_year, target_month = payload.year, payload.month
    else:
        # Default to last calendar month (same window the cron sends)
        now = datetime.now(timezone.utc)
        first_of_this_month = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        last_of_last_month = first_of_this_month.replace(day=1)
        # Step back one day to land in the previous month
        from datetime import timedelta
        prev = last_of_last_month - timedelta(days=1)
        target_year, target_month = prev.year, prev.month

    sender_name = (current_user or {}).get("name") or (current_user or {}).get("email") or "Tile Station"
    sender_email = (current_user or {}).get("email")

    # Dispatch the right job. Imported lazily to avoid a circular import
    # with server.py (which in turn imports `routes`).
    if schedule["kind"] == "invoices":
        from services.invoice_export_jobs import run_invoice_monthly_email_job  # noqa: PLC0415
        background_tasks.add_task(
            run_invoice_monthly_email_job,
            target_year, target_month,
            list(schedule["recipient_emails"]),
            schedule.get("subject"),
            schedule.get("message"),
            sender_name, sender_email,
            schedule["id"],
        )
    elif schedule["kind"] == "owner_digest":
        from services.owner_monthly_digest import run_owner_monthly_digest_job  # noqa: PLC0415
        # recipient_emails on owner_digest is informational; the digest
        # uses Telegram (global config). We pass None to use defaults.
        background_tasks.add_task(
            run_owner_monthly_digest_job,
            target_year, target_month, schedule["id"], None,
        )
    else:  # petty_cash
        from services.petty_cash_export import run_petty_cash_monthly_email_job  # noqa: PLC0415
        background_tasks.add_task(
            run_petty_cash_monthly_email_job,
            schedule["scope"], target_year, target_month,
            list(schedule["recipient_emails"]),
            schedule.get("subject"),
            schedule.get("message"),
            sender_name, sender_email,
            schedule["id"],
        )

    if schedule["kind"] == "owner_digest":
        delivery_descr = "delivered to your Telegram chat"
    else:
        delivery_descr = f"emailed to {', '.join(schedule['recipient_emails'])}"

    return {
        "ok": True,
        "queued": True,
        "schedule_id": schedule["id"],
        "kind": schedule["kind"],
        "scope": schedule["scope"],
        "target_year": target_year,
        "target_month": target_month,
        "to": list(schedule["recipient_emails"]),
        "message": (
            f"Queued — auto-export for {target_year}-{target_month:02d} will be "
            f"{delivery_descr} shortly."
        ),
    }


async def mark_schedule_result(
    schedule_id: str, *, status: str, note: str,
) -> None:
    """Helper used by the background jobs to record their outcome on the
    schedule doc. Status is one of 'ok' | 'partial' | 'failed'. Never raises
    (we don't want bookkeeping to break the actual delivery).
    """
    try:
        db = get_db()
        await db.auto_export_schedules.update_one(
            {"id": schedule_id},
            {"$set": {
                "last_sent_at": datetime.now(timezone.utc).isoformat(),
                "last_sent_status": status,
                "last_sent_note": (note or "")[:500],
            }},
        )
    except Exception:
        logger.exception("Failed to write last_sent_status for schedule %s", schedule_id)

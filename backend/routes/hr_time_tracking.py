"""
HR Time & Attendance — clock-in / clock-out (13 Jun 2026).

Two flows:

1. **Web clock-in** — staff hit "Clock in" from their dashboard.
   POST /api/hr/time/clock-in → creates an open entry.
   POST /api/hr/time/clock-out → closes the current entry, computes
   duration_minutes.

2. **QR clock-in** — each showroom has a printed QR code at the door.
   The QR encodes `?token=<showroom_qr_secret>`. When scanned, the
   handler validates the token and records the showroom that was
   physically visited (no spoofing from the couch).

The day-summary endpoint returns the staff's hours-per-day for any
date range — payroll uses this.
"""
import logging
import secrets
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from config import get_db
from services import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/hr/time", tags=["HR"])


class ClockInRequest(BaseModel):
    showroom_id: Optional[str] = Field(None, description="Which showroom they're clocking in at")
    qr_token: Optional[str] = Field(None, description="QR token from showroom door — overrides showroom_id")
    notes: Optional[str] = Field(None, max_length=300)


class ClockOutRequest(BaseModel):
    notes: Optional[str] = Field(None, max_length=300)
    break_minutes: float = Field(default=0, ge=0, le=480)


class ManualEntryIn(BaseModel):
    """HR admin override for forgotten clock-ins."""
    employee_id: str
    showroom_id: Optional[str] = None
    clock_in_at: str = Field(..., description="ISO datetime")
    clock_out_at: str = Field(..., description="ISO datetime")
    break_minutes: float = Field(default=0, ge=0, le=480)
    notes: Optional[str] = Field(None, max_length=300)


def _is_hr_admin(u: dict) -> bool:
    return (u or {}).get("role") in {"super_admin", "hr_admin"}


async def _resolve_my_employee(db, current_user: dict) -> dict:
    user_id = (current_user or {}).get("id") or (current_user or {}).get("_id")
    if not user_id:
        raise HTTPException(401, "Not authenticated")
    emp = await db.hr_employees.find_one({"user_id": user_id, "archived_at": {"$exists": False}}, {"_id": 0})
    if not emp:
        raise HTTPException(404, "No HR record linked to your account")
    return emp


async def _validate_showroom_qr(db, token: str) -> Optional[str]:
    """Returns the showroom_id if the token matches a current QR secret."""
    if not token:
        return None
    sr = await db.hr_showroom_qr_codes.find_one({"qr_secret": token, "active": True}, {"_id": 0, "showroom_id": 1})
    return (sr or {}).get("showroom_id")


# ─── Clock in / out ───────────────────────────────────────────────────
@router.post("/clock-in")
async def clock_in(
    payload: ClockInRequest,
    current_user: dict = Depends(get_current_user),
):
    db = get_db()
    emp = await _resolve_my_employee(db, current_user)
    # Detect double clock-in
    open_entry = await db.hr_time_entries.find_one(
        {"employee_id": emp["id"], "clock_out_at": None},
        {"_id": 0},
    )
    if open_entry:
        raise HTTPException(409, "You are already clocked in — clock out first")
    # Resolve showroom from QR token if provided
    showroom_id = payload.showroom_id
    method = "web"
    if payload.qr_token:
        resolved = await _validate_showroom_qr(db, payload.qr_token)
        if not resolved:
            raise HTTPException(400, "Invalid or expired QR code")
        showroom_id = resolved
        method = "qr_code"
    now = datetime.now(timezone.utc)
    doc = {
        "id": str(uuid.uuid4()),
        "employee_id": emp["id"],
        "employee_name": f"{emp.get('first_name', '')} {emp.get('last_name', '')}".strip(),
        "showroom_id": showroom_id,
        "clock_in_at": now.isoformat(),
        "clock_out_at": None,
        "duration_minutes": None,
        "break_minutes": 0,
        "method": method,
        "notes": (payload.notes or "").strip() or None,
        "created_at": now.isoformat(),
    }
    await db.hr_time_entries.insert_one(dict(doc))
    doc.pop("_id", None)
    return doc


@router.post("/clock-out")
async def clock_out(
    payload: ClockOutRequest,
    current_user: dict = Depends(get_current_user),
):
    db = get_db()
    emp = await _resolve_my_employee(db, current_user)
    entry = await db.hr_time_entries.find_one(
        {"employee_id": emp["id"], "clock_out_at": None},
        {"_id": 0},
    )
    if not entry:
        raise HTTPException(404, "You are not currently clocked in")
    now = datetime.now(timezone.utc)
    clock_in_at = datetime.fromisoformat(entry["clock_in_at"])
    duration_minutes = max(0.0, (now - clock_in_at).total_seconds() / 60.0 - float(payload.break_minutes))
    update = {
        "clock_out_at": now.isoformat(),
        "duration_minutes": round(duration_minutes, 2),
        "break_minutes": payload.break_minutes,
        "notes": (payload.notes or entry.get("notes") or "").strip() or None,
    }
    await db.hr_time_entries.update_one({"id": entry["id"]}, {"$set": update})
    return {**entry, **update}


@router.get("/current")
async def get_current_clock_in(current_user: dict = Depends(get_current_user)):
    """Returns the open clock-in entry for the caller, or null."""
    db = get_db()
    emp = await _resolve_my_employee(db, current_user)
    entry = await db.hr_time_entries.find_one(
        {"employee_id": emp["id"], "clock_out_at": None},
        {"_id": 0},
    )
    return entry or None


@router.get("/my-week")
async def my_timesheet_this_week(current_user: dict = Depends(get_current_user)):
    db = get_db()
    emp = await _resolve_my_employee(db, current_user)
    today = date.today()
    week_start = today - timedelta(days=today.weekday())  # Mon
    week_end = week_start + timedelta(days=7)
    cur = db.hr_time_entries.find({
        "employee_id": emp["id"],
        "clock_in_at": {"$gte": week_start.isoformat(), "$lt": week_end.isoformat()},
    }, {"_id": 0}).sort("clock_in_at", 1)
    rows = await cur.to_list(50)
    total_minutes = sum(float(r.get("duration_minutes") or 0) for r in rows)
    return {
        "week_start": week_start.isoformat(),
        "week_end": (week_end - timedelta(days=1)).isoformat(),
        "entries": rows,
        "total_minutes": round(total_minutes, 2),
        "total_hours": round(total_minutes / 60, 2),
    }


@router.get("/employee/{employee_id}")
async def employee_timesheet(
    employee_id: str,
    from_date: str,
    to_date: str,
    current_user: dict = Depends(get_current_user),
):
    """HR admin OR the employee themselves can see a date-range timesheet."""
    db = get_db()
    emp = await db.hr_employees.find_one({"id": employee_id, "archived_at": {"$exists": False}}, {"_id": 0})
    if not emp:
        raise HTTPException(404, "Employee not found")
    user_id = (current_user or {}).get("id") or (current_user or {}).get("_id")
    if not _is_hr_admin(current_user) and emp.get("user_id") != user_id:
        raise HTTPException(403, "Not authorised")
    try:
        datetime.strptime(from_date, "%Y-%m-%d")
        datetime.strptime(to_date, "%Y-%m-%d")
    except ValueError as e:
        raise HTTPException(400, f"Invalid date — expected YYYY-MM-DD: {e}") from e
    cur = db.hr_time_entries.find({
        "employee_id": employee_id,
        "clock_in_at": {"$gte": from_date, "$lt": f"{to_date}T99"},  # one-day-inclusive
    }, {"_id": 0}).sort("clock_in_at", 1)
    rows = await cur.to_list(2000)
    total_minutes = sum(float(r.get("duration_minutes") or 0) for r in rows)
    return {
        "employee_id": employee_id,
        "from_date": from_date, "to_date": to_date,
        "entries": rows,
        "total_minutes": round(total_minutes, 2),
        "total_hours": round(total_minutes / 60, 2),
    }


@router.post("/manual-entry")
async def manual_entry(
    payload: ManualEntryIn,
    current_user: dict = Depends(get_current_user),
):
    """Backfill a forgotten clock-in. HR admin only — audit-trail
    captures who created the override."""
    if not _is_hr_admin(current_user):
        raise HTTPException(403, "HR admin only")
    try:
        ci = datetime.fromisoformat(payload.clock_in_at)
        co = datetime.fromisoformat(payload.clock_out_at)
    except Exception as e:
        raise HTTPException(400, f"Invalid datetime: {e}") from e
    if co <= ci:
        raise HTTPException(400, "clock_out_at must be after clock_in_at")
    db = get_db()
    emp = await db.hr_employees.find_one({"id": payload.employee_id, "archived_at": {"$exists": False}}, {"_id": 0})
    if not emp:
        raise HTTPException(404, "Employee not found")
    duration_minutes = max(0.0, (co - ci).total_seconds() / 60.0 - float(payload.break_minutes))
    doc = {
        "id": str(uuid.uuid4()),
        "employee_id": payload.employee_id,
        "employee_name": f"{emp.get('first_name', '')} {emp.get('last_name', '')}".strip(),
        "showroom_id": payload.showroom_id,
        "clock_in_at": ci.isoformat(),
        "clock_out_at": co.isoformat(),
        "duration_minutes": round(duration_minutes, 2),
        "break_minutes": payload.break_minutes,
        "method": "manager_override",
        "notes": (payload.notes or "").strip() or None,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "created_by_override": (current_user or {}).get("email", "system"),
    }
    await db.hr_time_entries.insert_one(dict(doc))
    doc.pop("_id", None)
    return doc


# ─── QR code management ───────────────────────────────────────────────
@router.post("/qr/{showroom_id}/rotate")
async def rotate_showroom_qr(
    showroom_id: str,
    current_user: dict = Depends(get_current_user),
):
    """Generate a new QR secret for the showroom and deactivate any
    previous one. HR admin only — print the new QR and replace the
    showroom door sign."""
    if not _is_hr_admin(current_user):
        raise HTTPException(403, "HR admin only")
    db = get_db()
    sr = await db.showrooms.find_one({"id": showroom_id}, {"_id": 0, "id": 1, "name": 1})
    if not sr:
        raise HTTPException(404, "Showroom not found")
    secret = secrets.token_urlsafe(24)
    now_iso = datetime.now(timezone.utc).isoformat()
    # Deactivate prior tokens
    await db.hr_showroom_qr_codes.update_many(
        {"showroom_id": showroom_id, "active": True},
        {"$set": {"active": False, "deactivated_at": now_iso}},
    )
    await db.hr_showroom_qr_codes.insert_one({
        "id": str(uuid.uuid4()),
        "showroom_id": showroom_id,
        "showroom_name": sr.get("name"),
        "qr_secret": secret,
        "active": True,
        "generated_at": now_iso,
        "generated_by": (current_user or {}).get("email", "system"),
    })
    return {
        "ok": True,
        "showroom_id": showroom_id,
        "showroom_name": sr.get("name"),
        "qr_secret": secret,
        "qr_url": f"/clock-in?token={secret}",
    }


@router.get("/qr/active")
async def list_active_qrs(current_user: dict = Depends(get_current_user)):
    """HR admin — see all current QR tokens (so they can re-print)."""
    if not _is_hr_admin(current_user):
        raise HTTPException(403, "HR admin only")
    db = get_db()
    cur = db.hr_showroom_qr_codes.find({"active": True}, {"_id": 0})
    return await cur.to_list(100)


@router.post("/clock-via-qr")
async def public_clock_via_qr(payload: ClockInRequest, current_user: dict = Depends(get_current_user)):
    """Alias for /clock-in when the QR scan flow is in play. Same handler
    semantics but explicit URL for the showroom-door scan link."""
    return await clock_in(payload, current_user)

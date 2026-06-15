"""
HR Leave / Holiday management (13 Jun 2026).

Self-service flow:
    1. Staff submits POST /api/hr/leave/requests (pending)
    2. Their line manager (or HR admin) sees it via GET /requests/pending
    3. Manager approves/rejects via POST /requests/{id}/approve|reject
    4. Calendar view (GET /calendar?year=…&month=…) shows everyone's
       approved leave overlaid with UK bank holidays.
    5. Per-employee balance: entitlement - approved days taken
       (working days only — Sat/Sun + bank holidays aren't deducted).

Roles:
    "hr_admin" / "super_admin" — full power.
    "manager" — sees their own team's pending requests (via
        hr_employees.line_manager_user_id), can approve/reject.
    Anyone else — only their own requests.
"""
import logging
import uuid
from datetime import date, datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from config import get_db
from services import get_current_user
from services.hr_bank_holidays import working_days_between, upcoming_bank_holidays

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/hr/leave", tags=["HR"])

LEAVE_TYPES = {"holiday", "sick", "unpaid", "compassionate", "maternity", "paternity", "other"}
LEAVE_STATUSES = {"pending", "approved", "rejected", "cancelled"}
DEDUCTS_FROM_HOLIDAY = {"holiday"}  # sick/unpaid don't eat into the holiday entitlement


# ─── Models ──────────────────────────────────────────────────────────
class LeaveRequestIn(BaseModel):
    employee_id: Optional[str] = Field(None, description="Defaults to caller's own employee record")
    type: str = Field(...)
    start_date: str = Field(..., description="YYYY-MM-DD")
    end_date: str = Field(..., description="YYYY-MM-DD inclusive")
    reason: Optional[str] = Field(None, max_length=500)


class LeaveDecision(BaseModel):
    note: Optional[str] = Field(None, max_length=500)


# ─── Helpers ─────────────────────────────────────────────────────────
def _is_hr_admin(u: dict) -> bool:
    return (u or {}).get("role") in {"super_admin", "hr_admin"}


def _parse_iso(s: str) -> date:
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except Exception as e:
        raise HTTPException(400, f"Invalid date '{s}' — expected YYYY-MM-DD") from e


async def _resolve_employee(db, employee_id: Optional[str], current_user: dict) -> dict:
    """If `employee_id` is None, look up the caller's own employee record."""
    if employee_id:
        emp = await db.hr_employees.find_one({"id": employee_id, "archived_at": {"$exists": False}}, {"_id": 0})
        if not emp:
            raise HTTPException(404, "Employee not found")
        return emp
    user_id = (current_user or {}).get("id") or (current_user or {}).get("_id")
    emp = await db.hr_employees.find_one({"user_id": user_id, "archived_at": {"$exists": False}}, {"_id": 0})
    if not emp:
        raise HTTPException(404, "No HR record linked to your account — ask HR to set one up.")
    return emp


def _can_view_employee(employee: dict, current_user: dict) -> bool:
    if _is_hr_admin(current_user):
        return True
    user_id = (current_user or {}).get("id") or (current_user or {}).get("_id")
    if employee.get("user_id") == user_id:
        return True
    # Line manager? (set on hr_employees.line_manager_user_id)
    if employee.get("line_manager_user_id") == user_id:
        return True
    return False


def _can_approve(employee: dict, current_user: dict) -> bool:
    if _is_hr_admin(current_user):
        return True
    user_id = (current_user or {}).get("id") or (current_user or {}).get("_id")
    return employee.get("line_manager_user_id") == user_id


async def _sum_approved_holiday_days(db, employee_id: str, year: int) -> float:
    """Sum approved 'holiday'-typed requests' working-day count for the
    given calendar year. Used by the balance endpoint."""
    cur = db.hr_leave_requests.find({
        "employee_id": employee_id,
        "type": "holiday",
        "status": "approved",
        "start_date": {"$gte": f"{year}-01-01", "$lt": f"{year + 1}-01-01"},
    }, {"_id": 0, "working_days": 1})
    total = 0.0
    async for r in cur:
        total += float(r.get("working_days") or 0)
    return round(total, 2)


# ─── Routes — requests ───────────────────────────────────────────────
@router.post("/requests")
async def create_leave_request(
    payload: LeaveRequestIn,
    current_user: dict = Depends(get_current_user),
):
    if payload.type not in LEAVE_TYPES:
        raise HTTPException(400, f"Invalid leave type — must be one of {sorted(LEAVE_TYPES)}")
    start = _parse_iso(payload.start_date)
    end = _parse_iso(payload.end_date)
    if end < start:
        raise HTTPException(400, "end_date must be on or after start_date")
    db = get_db()
    emp = await _resolve_employee(db, payload.employee_id, current_user)
    # Only HR admins may file requests on someone else's behalf
    if payload.employee_id and not _is_hr_admin(current_user):
        user_id = (current_user or {}).get("id") or (current_user or {}).get("_id")
        if emp.get("user_id") != user_id:
            raise HTTPException(403, "Can only request leave for yourself")
    working_days = await working_days_between(start, end)
    doc = {
        "id": str(uuid.uuid4()),
        "employee_id": emp["id"],
        "employee_name": f"{emp.get('first_name', '')} {emp.get('last_name', '')}".strip(),
        "type": payload.type,
        "start_date": payload.start_date,
        "end_date": payload.end_date,
        "working_days": working_days,
        "reason": (payload.reason or "").strip() or None,
        "status": "pending",
        "created_by": (current_user or {}).get("email", "self"),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.hr_leave_requests.insert_one(dict(doc))
    doc.pop("_id", None)
    return doc


@router.get("/requests/my")
async def list_my_leave_requests(current_user: dict = Depends(get_current_user)):
    db = get_db()
    emp = await _resolve_employee(db, None, current_user)
    cur = db.hr_leave_requests.find({"employee_id": emp["id"]}, {"_id": 0}).sort("start_date", -1)
    rows = await cur.to_list(500)
    return rows


@router.get("/requests/pending")
async def list_pending_leave_requests(current_user: dict = Depends(get_current_user)):
    """HR admins see all pending; managers see only their team's."""
    db = get_db()
    q: dict = {"status": "pending"}
    rows = []
    async for r in db.hr_leave_requests.find(q, {"_id": 0}).sort("created_at", 1):
        emp = await db.hr_employees.find_one({"id": r["employee_id"]}, {"_id": 0, "line_manager_user_id": 1, "showroom_id": 1})
        if not _is_hr_admin(current_user):
            user_id = (current_user or {}).get("id") or (current_user or {}).get("_id")
            if (emp or {}).get("line_manager_user_id") != user_id:
                continue
        rows.append({**r, "showroom_id": (emp or {}).get("showroom_id")})
    return rows


@router.post("/requests/{request_id}/approve")
async def approve_leave_request(
    request_id: str,
    decision: LeaveDecision,
    current_user: dict = Depends(get_current_user),
):
    db = get_db()
    req = await db.hr_leave_requests.find_one({"id": request_id})
    if not req:
        raise HTTPException(404, "Leave request not found")
    if req.get("status") != "pending":
        raise HTTPException(400, f"Request is already {req.get('status')}; cannot approve")
    emp = await db.hr_employees.find_one({"id": req["employee_id"]}, {"_id": 0})
    if not emp or not _can_approve(emp, current_user):
        raise HTTPException(403, "Not authorised to approve this request")
    await db.hr_leave_requests.update_one(
        {"id": request_id},
        {"$set": {
            "status": "approved",
            "approver_user_id": (current_user or {}).get("id"),
            "approver_email": (current_user or {}).get("email"),
            "approver_note": (decision.note or "").strip() or None,
            "approved_at": datetime.now(timezone.utc).isoformat(),
        }},
    )
    return {"ok": True, "id": request_id, "status": "approved"}


@router.post("/requests/{request_id}/reject")
async def reject_leave_request(
    request_id: str,
    decision: LeaveDecision,
    current_user: dict = Depends(get_current_user),
):
    db = get_db()
    req = await db.hr_leave_requests.find_one({"id": request_id})
    if not req:
        raise HTTPException(404, "Leave request not found")
    if req.get("status") != "pending":
        raise HTTPException(400, f"Request is already {req.get('status')}; cannot reject")
    emp = await db.hr_employees.find_one({"id": req["employee_id"]}, {"_id": 0})
    if not emp or not _can_approve(emp, current_user):
        raise HTTPException(403, "Not authorised to reject this request")
    await db.hr_leave_requests.update_one(
        {"id": request_id},
        {"$set": {
            "status": "rejected",
            "approver_user_id": (current_user or {}).get("id"),
            "approver_email": (current_user or {}).get("email"),
            "approver_note": (decision.note or "").strip() or None,
            "approved_at": datetime.now(timezone.utc).isoformat(),
        }},
    )
    return {"ok": True, "id": request_id, "status": "rejected"}


@router.post("/requests/{request_id}/cancel")
async def cancel_leave_request(
    request_id: str,
    current_user: dict = Depends(get_current_user),
):
    """Staff can cancel their OWN pending requests. HR admins can
    cancel anyone's even if approved (e.g. when somebody no-shows)."""
    db = get_db()
    req = await db.hr_leave_requests.find_one({"id": request_id})
    if not req:
        raise HTTPException(404, "Leave request not found")
    emp = await db.hr_employees.find_one({"id": req["employee_id"]}, {"_id": 0})
    user_id = (current_user or {}).get("id") or (current_user or {}).get("_id")
    own = emp and emp.get("user_id") == user_id
    if not own and not _is_hr_admin(current_user):
        raise HTTPException(403, "Cannot cancel another person's leave request")
    if own and req.get("status") not in {"pending", "approved"}:
        raise HTTPException(400, f"Cannot cancel a {req.get('status')} request")
    await db.hr_leave_requests.update_one(
        {"id": request_id},
        {"$set": {"status": "cancelled", "cancelled_at": datetime.now(timezone.utc).isoformat()}},
    )
    return {"ok": True, "id": request_id, "status": "cancelled"}


# ─── Routes — balance & calendar ─────────────────────────────────────
@router.get("/balance/me")
async def my_balance(
    year: Optional[int] = None,
    current_user: dict = Depends(get_current_user),
):
    """Returns entitlement, used (working days approved this year), and
    remaining. Counts ONLY 'holiday'-typed requests against the balance —
    sick/unpaid/etc. live separately."""
    db = get_db()
    emp = await _resolve_employee(db, None, current_user)
    y = year or datetime.now(timezone.utc).year
    entitlement = float(emp.get("holiday_entitlement_days") or 28)
    used = await _sum_approved_holiday_days(db, emp["id"], y)
    # Pending requests count as 'soft-booked' so the staff doesn't
    # accidentally double-book themselves out.
    pending_cur = db.hr_leave_requests.find({
        "employee_id": emp["id"],
        "type": "holiday",
        "status": "pending",
        "start_date": {"$gte": f"{y}-01-01", "$lt": f"{y + 1}-01-01"},
    }, {"_id": 0, "working_days": 1})
    pending = 0.0
    async for r in pending_cur:
        pending += float(r.get("working_days") or 0)
    return {
        "employee_id": emp["id"],
        "year": y,
        "entitlement_days": entitlement,
        "used_days": round(used, 2),
        "pending_days": round(pending, 2),
        "remaining_days": round(entitlement - used - pending, 2),
    }


@router.get("/balance/{employee_id}")
async def employee_balance(
    employee_id: str,
    year: Optional[int] = None,
    current_user: dict = Depends(get_current_user),
):
    db = get_db()
    emp = await db.hr_employees.find_one({"id": employee_id, "archived_at": {"$exists": False}}, {"_id": 0})
    if not emp:
        raise HTTPException(404, "Employee not found")
    if not _can_view_employee(emp, current_user):
        raise HTTPException(403, "Not authorised")
    y = year or datetime.now(timezone.utc).year
    used = await _sum_approved_holiday_days(db, employee_id, y)
    return {
        "employee_id": employee_id,
        "year": y,
        "entitlement_days": float(emp.get("holiday_entitlement_days") or 28),
        "used_days": used,
        "remaining_days": round(float(emp.get("holiday_entitlement_days") or 28) - used, 2),
    }


@router.get("/calendar")
async def leave_calendar(
    year: int,
    month: Optional[int] = None,
    current_user: dict = Depends(get_current_user),
):
    """Returns all approved + pending leave that overlaps the given
    month (or full year if no month). Plus the UK bank holidays for the
    year so the UI can render them as a backdrop.

    Available to anyone authenticated — leave calendars are normally
    visible to the whole team so people know who's around."""
    db = get_db()
    if month:
        from calendar import monthrange  # noqa: PLC0415
        start_iso = f"{year:04d}-{month:02d}-01"
        last_day = monthrange(year, month)[1]
        end_iso = f"{year:04d}-{month:02d}-{last_day:02d}"
    else:
        start_iso = f"{year:04d}-01-01"
        end_iso = f"{year:04d}-12-31"
    # Range overlap: request.start_date <= end AND request.end_date >= start
    cur = db.hr_leave_requests.find({
        "status": {"$in": ["approved", "pending"]},
        "start_date": {"$lte": end_iso},
        "end_date": {"$gte": start_iso},
    }, {"_id": 0})
    rows: List[dict] = []
    async for r in cur:
        rows.append({
            "id": r["id"],
            "employee_id": r["employee_id"],
            "employee_name": r.get("employee_name") or "",
            "type": r.get("type"),
            "status": r.get("status"),
            "start_date": r.get("start_date"),
            "end_date": r.get("end_date"),
            "working_days": r.get("working_days"),
        })
    holidays = await upcoming_bank_holidays(year)
    return {
        "year": year, "month": month,
        "leave": rows,
        "bank_holidays": holidays,
    }

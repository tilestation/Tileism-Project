"""
HR Employees — central employee records (13 Jun 2026).

One employee row per real-world person. Linked back to the existing
`users` collection via `user_id` so the staff member can log in to the
self-service portal using their existing app credentials.

Sensitive fields (`ni_number`, `bank.sort_code`, `bank.account_number`)
are encrypted at rest via `services.hr_security`. The list endpoint
NEVER returns these — only the get-one endpoint, and only to HR admins.

Endpoints:
    GET    /api/hr/employees                       — list (HR admin)
    POST   /api/hr/employees                       — create (HR admin)
    GET    /api/hr/employees/{id}                  — full record (HR admin)
    GET    /api/hr/employees/me                    — self-service (logged-in staff)
    PATCH  /api/hr/employees/{id}                  — update (HR admin)
    PATCH  /api/hr/employees/me                    — limited self-edit (own contact)
    DELETE /api/hr/employees/{id}                  — soft-archive (HR admin)

Role gating:
    "hr_admin" — anyone with role in {"hr_admin", "super_admin"}.
    "viewer"   — the employee themselves (matched on user_id).
"""
import logging
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr, Field

from config import get_db
from services import get_current_user
from services.hr_security import encrypt, decrypt, mask

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/hr/employees", tags=["HR"])

VALID_CONTRACT_TYPES = {"full_time", "part_time", "zero_hours", "casual", "contractor"}
VALID_PAY_TYPES = {"salary", "hourly"}
VALID_PAY_FREQ = {"monthly", "weekly", "fortnightly"}
VALID_STATUSES = {"active", "on_leave", "left"}

# Default UK statutory holiday entitlement = 28 days incl. bank holidays
# for full-time. Configurable per employee.
DEFAULT_HOLIDAY_ENTITLEMENT = 28


# ─── Models ──────────────────────────────────────────────────────────
class EmergencyContact(BaseModel):
    name: Optional[str] = None
    relationship: Optional[str] = None
    phone: Optional[str] = None


class HomeAddress(BaseModel):
    line1: Optional[str] = None
    line2: Optional[str] = None
    city: Optional[str] = None
    postcode: Optional[str] = None


class BankDetails(BaseModel):
    account_name: Optional[str] = None
    sort_code: Optional[str] = None
    account_number: Optional[str] = None


class EmployeeCreate(BaseModel):
    user_id: Optional[str] = Field(None, description="Existing users.id to link; null if no app login")
    first_name: str = Field(..., min_length=1, max_length=80)
    last_name: str = Field(..., min_length=1, max_length=80)
    preferred_name: Optional[str] = Field(None, max_length=80)
    dob: Optional[str] = Field(None, description="YYYY-MM-DD")
    gender: Optional[str] = Field(None, max_length=30)
    personal_email: Optional[EmailStr] = None
    personal_phone: Optional[str] = Field(None, max_length=40)
    home_address: Optional[HomeAddress] = None
    ni_number: Optional[str] = Field(None, max_length=20, description="UK NI number — encrypted at rest")
    nationality: Optional[str] = Field(None, max_length=50)
    emergency_contact: Optional[EmergencyContact] = None
    showroom_id: Optional[str] = None
    job_title: Optional[str] = Field(None, max_length=100)
    department: Optional[str] = Field(None, max_length=80)
    start_date: Optional[str] = Field(None, description="YYYY-MM-DD")
    end_date: Optional[str] = None
    contract_type: Optional[str] = None
    hours_per_week: Optional[float] = None
    probation_end_date: Optional[str] = None
    line_manager_user_id: Optional[str] = None
    pay_type: Optional[str] = None
    pay_amount: Optional[float] = None
    pay_frequency: Optional[str] = None
    bank: Optional[BankDetails] = None
    holiday_entitlement_days: float = DEFAULT_HOLIDAY_ENTITLEMENT
    status: str = "active"


class EmployeeUpdate(BaseModel):
    """All fields optional — patch semantics."""
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    preferred_name: Optional[str] = None
    dob: Optional[str] = None
    gender: Optional[str] = None
    personal_email: Optional[EmailStr] = None
    personal_phone: Optional[str] = None
    home_address: Optional[HomeAddress] = None
    ni_number: Optional[str] = None
    nationality: Optional[str] = None
    emergency_contact: Optional[EmergencyContact] = None
    showroom_id: Optional[str] = None
    job_title: Optional[str] = None
    department: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    contract_type: Optional[str] = None
    hours_per_week: Optional[float] = None
    probation_end_date: Optional[str] = None
    line_manager_user_id: Optional[str] = None
    pay_type: Optional[str] = None
    pay_amount: Optional[float] = None
    pay_frequency: Optional[str] = None
    bank: Optional[BankDetails] = None
    holiday_entitlement_days: Optional[float] = None
    status: Optional[str] = None
    user_id: Optional[str] = None


class SelfServiceUpdate(BaseModel):
    """The fields a staff member is allowed to change about themselves
    via /me. Deliberately narrow — pay, role, dates etc. are off-limits."""
    preferred_name: Optional[str] = Field(None, max_length=80)
    personal_email: Optional[EmailStr] = None
    personal_phone: Optional[str] = Field(None, max_length=40)
    home_address: Optional[HomeAddress] = None
    emergency_contact: Optional[EmergencyContact] = None


# ─── Auth helpers ────────────────────────────────────────────────────
def _is_hr_admin(user: dict) -> bool:
    return (user or {}).get("role") in {"super_admin", "hr_admin"}


def _require_hr_admin(user: dict) -> None:
    if not _is_hr_admin(user):
        raise HTTPException(403, "HR admin only")


# ─── Serialisation ───────────────────────────────────────────────────
def _validate_enum(value: Optional[str], allowed: set, field: str) -> None:
    if value is not None and value not in allowed:
        raise HTTPException(400, f"Invalid {field}: must be one of {sorted(allowed)}")


def _to_doc(payload: dict, *, existing: Optional[dict] = None) -> dict:
    """Encrypt sensitive bits before persisting. Pulls existing
    ciphertext through unchanged if the caller didn't send a new value."""
    out = dict(payload)
    # NI number
    if "ni_number" in out:
        if out["ni_number"]:
            out["ni_number_enc"] = encrypt(out["ni_number"])
        else:
            out["ni_number_enc"] = None
        out.pop("ni_number", None)
    elif existing:
        out["ni_number_enc"] = existing.get("ni_number_enc")
    # Bank
    if "bank" in out and out["bank"] is not None:
        b = out["bank"] if isinstance(out["bank"], dict) else out["bank"].model_dump()
        out["bank_enc"] = {
            "account_name": b.get("account_name"),
            "sort_code_enc": encrypt(b.get("sort_code")) if b.get("sort_code") else None,
            "account_number_enc": encrypt(b.get("account_number")) if b.get("account_number") else None,
        }
        out.pop("bank", None)
    elif existing:
        out["bank_enc"] = existing.get("bank_enc")
    return out


def _public_view(doc: dict, *, decrypt_sensitive: bool, mask_sensitive: bool = True) -> dict:
    """Convert a DB doc to API response. Encrypted bits are either
    decrypted (HR admin viewing one employee) or omitted (list views).
    `mask_sensitive`: when True, returned values are masked ('****1234')
    so the UI doesn't accidentally render a NI number in full."""
    if not doc:
        return {}
    out = {k: v for k, v in doc.items() if k not in ("_id", "ni_number_enc", "bank_enc")}
    if decrypt_sensitive:
        ni_plain = decrypt(doc.get("ni_number_enc"))
        out["ni_number"] = mask(ni_plain) if (ni_plain and mask_sensitive) else ni_plain
        bank_enc = doc.get("bank_enc") or {}
        sort_plain = decrypt(bank_enc.get("sort_code_enc"))
        acc_plain = decrypt(bank_enc.get("account_number_enc"))
        out["bank"] = {
            "account_name": bank_enc.get("account_name"),
            "sort_code": mask(sort_plain, 2) if (sort_plain and mask_sensitive) else sort_plain,
            "account_number": mask(acc_plain, 4) if (acc_plain and mask_sensitive) else acc_plain,
            "has_bank_details": bool(sort_plain or acc_plain),
        }
    return out


# ─── Routes ──────────────────────────────────────────────────────────
@router.get("")
async def list_employees(
    showroom_id: Optional[str] = None,
    status: Optional[str] = None,
    current_user: dict = Depends(get_current_user),
):
    _require_hr_admin(current_user)
    db = get_db()
    q: dict = {"archived_at": {"$exists": False}}
    if showroom_id:
        q["showroom_id"] = showroom_id
    if status:
        _validate_enum(status, VALID_STATUSES, "status")
        q["status"] = status
    cur = db.hr_employees.find(q, {"_id": 0}).sort("last_name", 1)
    docs = await cur.to_list(2000)
    # List view: no encrypted-field decryption, no NI / bank surfacing.
    return [_public_view(d, decrypt_sensitive=False) for d in docs]


@router.get("/me")
async def get_my_employee_record(current_user: dict = Depends(get_current_user)):
    """Self-service — anyone with a linked employee record can see their
    own data. Bank + NI are returned MASKED unless the caller is HR admin."""
    db = get_db()
    user_id = (current_user or {}).get("id") or (current_user or {}).get("_id")
    if not user_id:
        raise HTTPException(401, "Not authenticated")
    doc = await db.hr_employees.find_one({"user_id": user_id, "archived_at": {"$exists": False}}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "No HR record linked to your account — ask HR to set one up.")
    return _public_view(doc, decrypt_sensitive=True, mask_sensitive=True)


@router.patch("/me")
async def update_my_employee_record(
    payload: SelfServiceUpdate,
    current_user: dict = Depends(get_current_user),
):
    db = get_db()
    user_id = (current_user or {}).get("id") or (current_user or {}).get("_id")
    if not user_id:
        raise HTTPException(401, "Not authenticated")
    doc = await db.hr_employees.find_one({"user_id": user_id, "archived_at": {"$exists": False}})
    if not doc:
        raise HTTPException(404, "No HR record linked to your account")
    update = payload.model_dump(exclude_unset=True)
    if not update:
        return _public_view(doc, decrypt_sensitive=True, mask_sensitive=True)
    update["updated_at"] = datetime.now(timezone.utc).isoformat()
    update["updated_by"] = "self"
    await db.hr_employees.update_one({"id": doc["id"]}, {"$set": update})
    refreshed = await db.hr_employees.find_one({"id": doc["id"]}, {"_id": 0})
    return _public_view(refreshed, decrypt_sensitive=True, mask_sensitive=True)


@router.get("/{employee_id}")
async def get_employee(
    employee_id: str,
    reveal_sensitive: bool = False,
    current_user: dict = Depends(get_current_user),
):
    """Full record. `reveal_sensitive=true` returns the unmasked NI /
    bank fields — used by the payroll-prep export only."""
    _require_hr_admin(current_user)
    db = get_db()
    doc = await db.hr_employees.find_one({"id": employee_id, "archived_at": {"$exists": False}}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Employee not found")
    return _public_view(doc, decrypt_sensitive=True, mask_sensitive=not reveal_sensitive)


@router.post("")
async def create_employee(
    payload: EmployeeCreate,
    current_user: dict = Depends(get_current_user),
):
    _require_hr_admin(current_user)
    _validate_enum(payload.contract_type, VALID_CONTRACT_TYPES | {None}, "contract_type")
    _validate_enum(payload.pay_type, VALID_PAY_TYPES | {None}, "pay_type")
    _validate_enum(payload.pay_frequency, VALID_PAY_FREQ | {None}, "pay_frequency")
    _validate_enum(payload.status, VALID_STATUSES, "status")
    db = get_db()
    # Enforce one employee row per user
    if payload.user_id:
        clash = await db.hr_employees.find_one(
            {"user_id": payload.user_id, "archived_at": {"$exists": False}},
            {"_id": 0, "id": 1},
        )
        if clash:
            raise HTTPException(409, f"Another employee record is already linked to user {payload.user_id}")
    # Auto employee number TS-001, TS-002, …
    last = await db.hr_employees.find_one({}, sort=[("employee_number_seq", -1)])
    next_seq = (last or {}).get("employee_number_seq", 0) + 1
    employee_number = f"TS-{next_seq:03d}"

    now_iso = datetime.now(timezone.utc).isoformat()
    raw = payload.model_dump(exclude_unset=False)
    doc = _to_doc(raw)
    doc.update({
        "id": str(uuid.uuid4()),
        "employee_number": employee_number,
        "employee_number_seq": next_seq,
        "created_at": now_iso,
        "updated_at": now_iso,
        "created_by": (current_user or {}).get("email", "system"),
    })
    await db.hr_employees.insert_one(dict(doc))
    return _public_view(doc, decrypt_sensitive=True, mask_sensitive=True)


@router.patch("/{employee_id}")
async def update_employee(
    employee_id: str,
    payload: EmployeeUpdate,
    current_user: dict = Depends(get_current_user),
):
    _require_hr_admin(current_user)
    db = get_db()
    existing = await db.hr_employees.find_one({"id": employee_id, "archived_at": {"$exists": False}})
    if not existing:
        raise HTTPException(404, "Employee not found")
    update = payload.model_dump(exclude_unset=True)
    if "contract_type" in update:
        _validate_enum(update["contract_type"], VALID_CONTRACT_TYPES | {None}, "contract_type")
    if "pay_type" in update:
        _validate_enum(update["pay_type"], VALID_PAY_TYPES | {None}, "pay_type")
    if "pay_frequency" in update:
        _validate_enum(update["pay_frequency"], VALID_PAY_FREQ | {None}, "pay_frequency")
    if "status" in update:
        _validate_enum(update["status"], VALID_STATUSES, "status")
    update = _to_doc(update, existing=existing)
    update["updated_at"] = datetime.now(timezone.utc).isoformat()
    update["updated_by"] = (current_user or {}).get("email", "system")
    await db.hr_employees.update_one({"id": employee_id}, {"$set": update})
    refreshed = await db.hr_employees.find_one({"id": employee_id}, {"_id": 0})
    return _public_view(refreshed, decrypt_sensitive=True, mask_sensitive=True)


@router.delete("/{employee_id}")
async def archive_employee(
    employee_id: str,
    current_user: dict = Depends(get_current_user),
):
    """Soft-archive. HMRC requires payroll records be kept for 6 years
    so we never hard-delete employee data."""
    _require_hr_admin(current_user)
    db = get_db()
    existing = await db.hr_employees.find_one({"id": employee_id})
    if not existing:
        raise HTTPException(404, "Employee not found")
    if existing.get("archived_at"):
        return {"ok": True, "already_archived": True}
    now_iso = datetime.now(timezone.utc).isoformat()
    await db.hr_employees.update_one(
        {"id": employee_id},
        {"$set": {"archived_at": now_iso, "status": "left", "archived_by": (current_user or {}).get("email")}},
    )
    return {"ok": True, "archived_at": now_iso}

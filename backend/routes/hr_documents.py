"""
HR Document Vault (13 Jun 2026).

Stores per-employee documents (contracts, P45/P46, right-to-work proofs,
ID copies, certificates) as base64-in-Mongo. Same pattern as
`petty_cash.receipt_image` — keeps the dependency surface small (no S3
setup) and the file size cap modest (~5MB per doc).

Critical compliance feature: each document optionally carries an
`expiry_date` (visa, passport, first-aid cert, etc.) and the hourly
cron in `server.py::_hr_expiry_cron_loop` emails HR admins 30 days
before any document expires.

Endpoints:
    POST   /api/hr/documents                     — upload (HR admin)
    GET    /api/hr/documents/employee/{id}       — list per employee
    GET    /api/hr/documents/me                  — own documents
    GET    /api/hr/documents/{id}/download       — fetch file bytes
    DELETE /api/hr/documents/{id}                — remove (HR admin)
    GET    /api/hr/documents/expiring            — soonest-expiring docs (HR admin)
"""
import base64
import logging
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from config import get_db
from services import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/hr/documents", tags=["HR"])

VALID_CATEGORIES = {
    "contract", "right_to_work", "id", "p45", "p46", "visa",
    "certification", "training", "policy_acknowledgement", "other",
}
MAX_FILE_BYTES = 10 * 1024 * 1024  # 10MB — generous for HR docs


class VisaMeta(BaseModel):
    """Optional structured fields when category is 'visa' or
    'right_to_work'. Recorded so the Visa Compliance report can
    answer the Home Office's "what visa type / what share code" follow-up
    without HR having to dig back into the PDF."""
    visa_type: Optional[str] = Field(None, max_length=80, description="e.g. Skilled Worker, Graduate, ILR")
    share_code: Optional[str] = Field(None, max_length=20, description="9-char Home Office share code")
    cos_number: Optional[str] = Field(None, max_length=30, description="Certificate of Sponsorship number")
    restriction_summary: Optional[str] = Field(None, max_length=500)


class DocumentUploadIn(BaseModel):
    employee_id: str
    category: str = Field(...)
    title: str = Field(..., min_length=1, max_length=200)
    file_name: str = Field(..., max_length=200)
    file_base64: str = Field(..., description="base64-encoded file bytes, with or without data: prefix")
    mime_type: Optional[str] = Field(None, max_length=100)
    expiry_date: Optional[str] = Field(None, description="YYYY-MM-DD if applicable")
    notes: Optional[str] = Field(None, max_length=1000)
    visible_to_employee: bool = True
    visa_meta: Optional[VisaMeta] = None


def _is_hr_admin(u: dict) -> bool:
    return (u or {}).get("role") in {"super_admin", "hr_admin"}


def _strip_data_url(b64: str) -> str:
    """Accept either raw base64 or a data: URL. Returns raw base64."""
    s = (b64 or "").strip()
    if s.startswith("data:"):
        # data:application/pdf;base64,XXXXX
        if ";base64," in s:
            return s.split(";base64,", 1)[1]
    return s


def _public_view(doc: dict, include_bytes: bool = False) -> dict:
    """Strip Mongo + heavy binary by default."""
    out = {k: v for k, v in doc.items() if k not in ("_id", "file_b64")}
    if include_bytes:
        out["file_b64"] = doc.get("file_b64")
    return out


@router.post("")
async def upload_document(
    payload: DocumentUploadIn,
    current_user: dict = Depends(get_current_user),
):
    if not _is_hr_admin(current_user):
        raise HTTPException(403, "HR admin only")
    if payload.category not in VALID_CATEGORIES:
        raise HTTPException(400, f"Invalid category — must be one of {sorted(VALID_CATEGORIES)}")
    db = get_db()
    emp = await db.hr_employees.find_one({"id": payload.employee_id, "archived_at": {"$exists": False}}, {"_id": 0, "id": 1})
    if not emp:
        raise HTTPException(404, "Employee not found")
    raw_b64 = _strip_data_url(payload.file_base64)
    try:
        decoded = base64.b64decode(raw_b64, validate=False)
    except Exception as e:
        raise HTTPException(400, f"Invalid base64 file payload: {e}") from e
    if len(decoded) == 0:
        raise HTTPException(400, "Empty file")
    if len(decoded) > MAX_FILE_BYTES:
        raise HTTPException(413, f"File too large — max {MAX_FILE_BYTES // (1024 * 1024)}MB")
    if payload.expiry_date:
        try:
            datetime.strptime(payload.expiry_date, "%Y-%m-%d")
        except ValueError as e:
            raise HTTPException(400, f"Invalid expiry_date: {e}") from e
    now_iso = datetime.now(timezone.utc).isoformat()
    doc = {
        "id": str(uuid.uuid4()),
        "employee_id": payload.employee_id,
        "category": payload.category,
        "title": payload.title,
        "file_name": payload.file_name,
        "file_b64": raw_b64,
        "file_size": len(decoded),
        "mime_type": payload.mime_type or "application/octet-stream",
        "expiry_date": payload.expiry_date,
        "notes": (payload.notes or "").strip() or None,
        "visible_to_employee": bool(payload.visible_to_employee),
        "visa_meta": payload.visa_meta.model_dump() if payload.visa_meta else None,
        "uploaded_by": (current_user or {}).get("email", "system"),
        "uploaded_at": now_iso,
    }
    await db.hr_documents.insert_one(dict(doc))
    return _public_view(doc)


@router.get("/employee/{employee_id}")
async def list_employee_documents(
    employee_id: str,
    current_user: dict = Depends(get_current_user),
):
    """HR admins see all; the employee themselves sees only those flagged
    `visible_to_employee=True`."""
    db = get_db()
    emp = await db.hr_employees.find_one({"id": employee_id, "archived_at": {"$exists": False}}, {"_id": 0})
    if not emp:
        raise HTTPException(404, "Employee not found")
    is_admin = _is_hr_admin(current_user)
    user_id = (current_user or {}).get("id") or (current_user or {}).get("_id")
    is_self = emp.get("user_id") == user_id
    if not is_admin and not is_self:
        raise HTTPException(403, "Not authorised")
    q: dict = {"employee_id": employee_id}
    if not is_admin:
        q["visible_to_employee"] = True
    cur = db.hr_documents.find(q, {"_id": 0, "file_b64": 0}).sort("uploaded_at", -1)
    return await cur.to_list(500)


@router.get("/me")
async def list_my_documents(current_user: dict = Depends(get_current_user)):
    """Self-service shortcut — uses the caller's linked HR record."""
    db = get_db()
    user_id = (current_user or {}).get("id") or (current_user or {}).get("_id")
    emp = await db.hr_employees.find_one({"user_id": user_id, "archived_at": {"$exists": False}}, {"_id": 0, "id": 1})
    if not emp:
        return []
    cur = db.hr_documents.find(
        {"employee_id": emp["id"], "visible_to_employee": True},
        {"_id": 0, "file_b64": 0},
    ).sort("uploaded_at", -1)
    return await cur.to_list(500)


@router.get("/{document_id}/download")
async def download_document(
    document_id: str,
    current_user: dict = Depends(get_current_user),
):
    """Returns the raw file bytes. HR admin OR the employee themselves
    (if visible_to_employee is True)."""
    db = get_db()
    doc = await db.hr_documents.find_one({"id": document_id})
    if not doc:
        raise HTTPException(404, "Document not found")
    is_admin = _is_hr_admin(current_user)
    if not is_admin:
        if not doc.get("visible_to_employee"):
            raise HTTPException(403, "Not authorised")
        emp = await db.hr_employees.find_one({"id": doc["employee_id"]}, {"_id": 0, "user_id": 1})
        user_id = (current_user or {}).get("id") or (current_user or {}).get("_id")
        if (emp or {}).get("user_id") != user_id:
            raise HTTPException(403, "Not authorised")
    try:
        raw = base64.b64decode(_strip_data_url(doc["file_b64"]), validate=False)
    except Exception as e:
        raise HTTPException(500, f"Stored file is corrupted: {e}") from e
    # Safe filename for Content-Disposition
    safe = "".join(c if c.isalnum() or c in "._-" else "_" for c in (doc.get("file_name") or "document.bin"))
    return Response(
        content=raw,
        media_type=doc.get("mime_type") or "application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{safe}"'},
    )


@router.delete("/{document_id}")
async def delete_document(
    document_id: str,
    current_user: dict = Depends(get_current_user),
):
    if not _is_hr_admin(current_user):
        raise HTTPException(403, "HR admin only")
    db = get_db()
    result = await db.hr_documents.delete_one({"id": document_id})
    if result.deleted_count == 0:
        raise HTTPException(404, "Document not found")
    return {"ok": True, "deleted": document_id}


@router.get("/expiring")
async def list_expiring_documents(
    within_days: int = 30,
    current_user: dict = Depends(get_current_user),
):
    """Anything expiring within `within_days` from today. HR admin only."""
    if not _is_hr_admin(current_user):
        raise HTTPException(403, "HR admin only")
    if within_days < 0 or within_days > 365:
        raise HTTPException(400, "within_days must be between 0 and 365")
    db = get_db()
    today = date.today()
    cutoff = (today + timedelta(days=within_days)).isoformat()
    cur = db.hr_documents.find(
        {
            "expiry_date": {"$ne": None, "$lte": cutoff, "$gte": today.isoformat()},
        },
        {"_id": 0, "file_b64": 0},
    ).sort("expiry_date", 1)
    return await cur.to_list(500)

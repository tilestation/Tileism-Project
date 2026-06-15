"""
HR Settings (Feb 2026).

A small key-value store for HR-portal-wide configuration: company
name, sponsor licence number, the named Authorising Officer (the human
the Home Office holds responsible) and the Level 1 / Level 2 user
mappings.

Used by:
  * the Visa Compliance "Monitoring System Overview & Policy" PDF
    generator (needs the AO's name + title + email to sign the policy
    document the user submits with their Sponsor Licence application).
  * future Sponsor Licence helpers (CoS reporting, etc.).

Stored as a single row in `db.hr_settings` with id="default" — there's
only ever one settings doc per tenant, so we don't bother with
multi-row CRUD.

Endpoints:
    GET  /api/hr/settings                — read (HR admin)
    PUT  /api/hr/settings                — write (super_admin only)

Sensitive fields are NOT encrypted — they're all data the Home Office
already knows about the company, so no extra protection needed.
"""
import logging
from datetime import date, datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr, Field

from config import get_db
from services import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/hr/settings", tags=["HR"])

SETTINGS_ID = "default"


# ─── Models ──────────────────────────────────────────────────────────
class AuthorisingOfficer(BaseModel):
    """The named human listed on the Sponsor Licence as responsible
    for compliance. Required on the policy PDF — signed off as the
    point of contact for the Home Office."""
    name: str = Field("", max_length=120)
    job_title: str = Field("", max_length=120)
    email: Optional[str] = Field(None, max_length=200)
    phone: Optional[str] = Field(None, max_length=40)


class HRSettings(BaseModel):
    company_name: str = Field("", max_length=200)
    company_number: Optional[str] = Field(None, max_length=40,
                                          description="Companies House number (e.g. 12345678)")
    registered_address: Optional[str] = Field(None, max_length=500)
    sponsor_licence_number: Optional[str] = Field(None, max_length=40,
                                                  description="If already issued — leave blank if applying for the first time")
    sponsor_licence_status: str = Field("applying",
                                        description="applying | active | renewed | none")
    authorising_officer: AuthorisingOfficer = Field(default_factory=AuthorisingOfficer)
    level1_user: AuthorisingOfficer = Field(default_factory=AuthorisingOfficer,
                                            description="Level 1 SMS user (day-to-day SMS access)")
    key_contact: AuthorisingOfficer = Field(default_factory=AuthorisingOfficer,
                                            description="UK-based first point of contact for the Home Office")
    policy_effective_date: Optional[str] = Field(None,
                                                 description="YYYY-MM-DD — typically the date the policy was first written / Sponsor Licence baseline review was completed")


VALID_LICENCE_STATUSES = {"applying", "active", "renewed", "none"}


# ─── Auth ────────────────────────────────────────────────────────────
def _is_hr_admin(user: dict) -> bool:
    return (user or {}).get("role") in {"super_admin", "hr_admin"}


def _is_super(user: dict) -> bool:
    return (user or {}).get("role") == "super_admin"


def _require_hr_admin(user: dict) -> None:
    if not _is_hr_admin(user):
        raise HTTPException(403, "HR admin only")


def _require_super(user: dict) -> None:
    if not _is_super(user):
        raise HTTPException(403, "Super admin only")


# ─── Helpers ─────────────────────────────────────────────────────────
def _defaults() -> dict:
    """Empty settings shape (returned when no doc exists yet so the UI
    can render a clean form)."""
    return HRSettings().model_dump()


# ─── Endpoints ───────────────────────────────────────────────────────
@router.get("")
async def get_settings(current_user: dict = Depends(get_current_user)):
    """Returns the current HR settings. Auto-seeds an empty doc on
    first call so the UI always has a stable shape."""
    _require_hr_admin(current_user)
    db = get_db()
    row = await db.hr_settings.find_one({"id": SETTINGS_ID}, {"_id": 0})
    if not row:
        # Seed empty so subsequent reads don't 404; PUT will replace.
        row = {**_defaults(), "id": SETTINGS_ID,
               "created_at": datetime.now(timezone.utc).isoformat(),
               "updated_at": None,
               "updated_by": None}
        return row
    return row


@router.put("")
async def update_settings(payload: HRSettings, current_user: dict = Depends(get_current_user)):
    """Replace the entire settings doc. Super-admin only — these
    fields drive the legal Sponsor Licence policy PDF, so the audit
    of who set them is important."""
    _require_super(current_user)

    if payload.sponsor_licence_status not in VALID_LICENCE_STATUSES:
        raise HTTPException(
            400, f"sponsor_licence_status must be one of {sorted(VALID_LICENCE_STATUSES)}")

    if payload.policy_effective_date:
        try:
            datetime.strptime(payload.policy_effective_date, "%Y-%m-%d")
        except ValueError as e:
            raise HTTPException(400, f"Invalid policy_effective_date: {e}") from e

    db = get_db()
    now_iso = datetime.now(timezone.utc).isoformat()
    existing = await db.hr_settings.find_one({"id": SETTINGS_ID}, {"_id": 0, "created_at": 1}) or {}
    doc = {
        **payload.model_dump(),
        "id": SETTINGS_ID,
        "created_at": existing.get("created_at") or now_iso,
        "updated_at": now_iso,
        "updated_by": (current_user or {}).get("email", "system"),
    }
    # Auto-stamp policy_effective_date to today if it's the first save
    # and the user hasn't supplied one. Honest dating — matches the
    # baseline review's "today" stamp.
    if not doc.get("policy_effective_date"):
        doc["policy_effective_date"] = date.today().isoformat()
    await db.hr_settings.update_one(
        {"id": SETTINGS_ID},
        {"$set": doc},
        upsert=True,
    )
    return doc

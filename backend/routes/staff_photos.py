"""
Staff profile photo upload (13 Jun 2026).

User request: "Add an option to upload staff images to their profile."

Endpoints:
- POST   /api/staff/{user_id}/photo  → upload (super-admin only, or self)
- DELETE /api/staff/{user_id}/photo  → clear

Storage: base64 data-URL stored directly on the user document
(`users.photo_url`). Profile pics are small (target <50KB after the
client compresses), so we avoid the operational cost of a file server
or S3 bucket for this v1. If we need bigger images later (e.g. brand
shots, hero banners) we can graduate to a real object store.

Cap: 500KB raw bytes (so the data URL stays under ~700KB after base64
overhead). Frontend should client-side compress before upload.
"""
import base64
import logging
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from config import get_db
from services import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/staff", tags=["Staff"])

MAX_PHOTO_BYTES = 500_000  # 500KB raw — after base64 ~670KB
DATA_URL_RE = re.compile(r"^data:image/(png|jpeg|jpg|webp|gif);base64,(.+)$", re.IGNORECASE)


class StaffPhotoUpload(BaseModel):
    photo_data_url: str = Field(..., max_length=1_500_000)  # ~1MB worth of base64


def _user_can_edit(current: dict, target_user_id: str, target_email: str) -> bool:
    """Super admins can edit anyone. Other staff can edit only their
    own photo (matched by user id or email)."""
    if (current or {}).get("role") == "super_admin":
        return True
    cur_id = (current or {}).get("id") or ""
    cur_email = ((current or {}).get("email") or "").lower()
    return (
        (cur_id and cur_id == target_user_id)
        or (cur_email and cur_email == (target_email or "").lower())
    )


async def _load_user(user_id: str) -> dict:
    """Resolve a staff user by `id` (app-level uuid). Returns the doc
    or raises 404."""
    user = await get_db().users.find_one({"id": user_id}, {"_id": 0})
    if not user:
        raise HTTPException(404, f"User {user_id} not found")
    return user


@router.post("/{user_id}/photo")
async def upload_staff_photo(
    user_id: str,
    body: StaffPhotoUpload,
    current_user: dict = Depends(get_current_user),
):
    target = await _load_user(user_id)
    if not _user_can_edit(current_user, target.get("id", ""), target.get("email", "")):
        raise HTTPException(403, "You can only edit your own photo. Super admin can edit anyone.")

    match = DATA_URL_RE.match(body.photo_data_url.strip())
    if not match:
        raise HTTPException(400, "photo_data_url must be a data URL: data:image/<png|jpeg|webp|gif>;base64,...")
    encoded = match.group(2)
    try:
        raw = base64.b64decode(encoded, validate=True)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Invalid base64 payload: {e}") from e
    if len(raw) > MAX_PHOTO_BYTES:
        raise HTTPException(
            400,
            f"Photo too large ({len(raw):,} bytes) — max {MAX_PHOTO_BYTES:,} bytes (~500KB). "
            f"Try a smaller image or compress it.",
        )

    await get_db().users.update_one(
        {"id": user_id},
        {"$set": {
            "photo_url": body.photo_data_url,
            "photo_uploaded_at": datetime.now(timezone.utc).isoformat(),
        }},
    )
    return {"ok": True, "user_id": user_id, "size_bytes": len(raw)}


@router.delete("/{user_id}/photo")
async def delete_staff_photo(
    user_id: str,
    current_user: dict = Depends(get_current_user),
):
    target = await _load_user(user_id)
    if not _user_can_edit(current_user, target.get("id", ""), target.get("email", "")):
        raise HTTPException(403, "You can only edit your own photo. Super admin can edit anyone.")
    await get_db().users.update_one(
        {"id": user_id},
        {"$unset": {"photo_url": "", "photo_uploaded_at": ""}},
    )
    return {"ok": True, "user_id": user_id}

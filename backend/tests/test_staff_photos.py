"""
Tests for staff photo upload (13 Jun 2026).
"""
import os
import asyncio
import base64
from unittest.mock import patch, AsyncMock, MagicMock

import pytest


@pytest.fixture(autouse=True)
def _env_setup():
    os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
    os.environ.setdefault("DB_NAME", "test_staff_photos")


def _db(user_doc=None):
    db = MagicMock()
    db.users.find_one = AsyncMock(return_value=user_doc)
    db.users.update_one = AsyncMock()
    return db


SUPER = {"role": "super_admin", "email": "boss@x.co", "id": "boss-id"}
SELF = {"role": "staff", "email": "alice@x.co", "id": "alice-id"}
OTHER_STAFF = {"role": "staff", "email": "bob@x.co", "id": "bob-id"}

# A tiny but valid 1x1 PNG, base64-encoded.
TINY_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB"
    "0C8AAAAASUVORK5CYII="
)
TINY_PNG_DATA_URL = f"data:image/png;base64,{TINY_PNG_B64}"


def test_upload_rejects_missing_user():
    from routes.staff_photos import upload_staff_photo, StaffPhotoUpload
    from fastapi import HTTPException
    db = _db(user_doc=None)
    with patch("routes.staff_photos.get_db", return_value=db):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(upload_staff_photo(
                user_id="missing",
                body=StaffPhotoUpload(photo_data_url=TINY_PNG_DATA_URL),
                current_user=SUPER,
            ))
        assert exc.value.status_code == 404


def test_upload_super_admin_can_edit_anyone():
    from routes.staff_photos import upload_staff_photo, StaffPhotoUpload
    db = _db(user_doc={"id": "alice-id", "email": "alice@x.co"})
    with patch("routes.staff_photos.get_db", return_value=db):
        r = asyncio.run(upload_staff_photo(
            user_id="alice-id",
            body=StaffPhotoUpload(photo_data_url=TINY_PNG_DATA_URL),
            current_user=SUPER,
        ))
    assert r["ok"] is True
    set_doc = db.users.update_one.call_args.args[1]["$set"]
    assert set_doc["photo_url"] == TINY_PNG_DATA_URL
    assert "photo_uploaded_at" in set_doc


def test_upload_self_can_edit_own_photo():
    """Staff can upload their own profile photo (matched by id)."""
    from routes.staff_photos import upload_staff_photo, StaffPhotoUpload
    db = _db(user_doc={"id": "alice-id", "email": "alice@x.co"})
    with patch("routes.staff_photos.get_db", return_value=db):
        r = asyncio.run(upload_staff_photo(
            user_id="alice-id",
            body=StaffPhotoUpload(photo_data_url=TINY_PNG_DATA_URL),
            current_user=SELF,
        ))
    assert r["ok"] is True


def test_upload_staff_cant_edit_other_staffs_photo():
    """Non-super-admin can only edit their own photo."""
    from routes.staff_photos import upload_staff_photo, StaffPhotoUpload
    from fastapi import HTTPException
    db = _db(user_doc={"id": "alice-id", "email": "alice@x.co"})
    with patch("routes.staff_photos.get_db", return_value=db):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(upload_staff_photo(
                user_id="alice-id",
                body=StaffPhotoUpload(photo_data_url=TINY_PNG_DATA_URL),
                current_user=OTHER_STAFF,
            ))
        assert exc.value.status_code == 403


def test_upload_rejects_non_data_url():
    """Plain text / HTTP URLs / random strings are rejected."""
    from routes.staff_photos import upload_staff_photo, StaffPhotoUpload
    from fastapi import HTTPException
    db = _db(user_doc={"id": "alice-id", "email": "alice@x.co"})
    with patch("routes.staff_photos.get_db", return_value=db):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(upload_staff_photo(
                user_id="alice-id",
                body=StaffPhotoUpload(photo_data_url="https://example.com/photo.png"),
                current_user=SUPER,
            ))
        assert exc.value.status_code == 400


def test_upload_rejects_non_image_mime():
    """Only image/* MIME types accepted."""
    from routes.staff_photos import upload_staff_photo, StaffPhotoUpload
    from fastapi import HTTPException
    db = _db(user_doc={"id": "alice-id", "email": "alice@x.co"})
    pdf_data_url = "data:application/pdf;base64," + TINY_PNG_B64
    with patch("routes.staff_photos.get_db", return_value=db):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(upload_staff_photo(
                user_id="alice-id",
                body=StaffPhotoUpload(photo_data_url=pdf_data_url),
                current_user=SUPER,
            ))
        assert exc.value.status_code == 400


def test_upload_rejects_oversized_image():
    """Images bigger than the 500KB cap are rejected (prevents Mongo
    bloat — a 5MB photo on every user adds up fast)."""
    from routes.staff_photos import upload_staff_photo, StaffPhotoUpload, MAX_PHOTO_BYTES
    from fastapi import HTTPException
    # Generate a fake image > MAX_PHOTO_BYTES
    big_bytes = b"\x00" * (MAX_PHOTO_BYTES + 1)
    big_data_url = f"data:image/png;base64,{base64.b64encode(big_bytes).decode()}"
    db = _db(user_doc={"id": "alice-id", "email": "alice@x.co"})
    with patch("routes.staff_photos.get_db", return_value=db):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(upload_staff_photo(
                user_id="alice-id",
                body=StaffPhotoUpload(photo_data_url=big_data_url),
                current_user=SUPER,
            ))
        assert exc.value.status_code == 400
        assert "too large" in exc.value.detail.lower()


def test_delete_clears_photo_fields():
    from routes.staff_photos import delete_staff_photo
    db = _db(user_doc={"id": "alice-id", "email": "alice@x.co"})
    with patch("routes.staff_photos.get_db", return_value=db):
        r = asyncio.run(delete_staff_photo(user_id="alice-id", current_user=SUPER))
    assert r["ok"] is True
    unset_doc = db.users.update_one.call_args.args[1]["$unset"]
    assert "photo_url" in unset_doc
    assert "photo_uploaded_at" in unset_doc


def test_delete_blocks_other_staff():
    from routes.staff_photos import delete_staff_photo
    from fastapi import HTTPException
    db = _db(user_doc={"id": "alice-id", "email": "alice@x.co"})
    with patch("routes.staff_photos.get_db", return_value=db):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(delete_staff_photo(user_id="alice-id", current_user=OTHER_STAFF))
        assert exc.value.status_code == 403

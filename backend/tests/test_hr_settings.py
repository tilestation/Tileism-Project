"""
Tests for HR Settings (Feb 2026) — the small key-value store powering
the Visa Monitoring Policy PDF.
"""
import os
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture(autouse=True)
def _env_setup():
    os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
    os.environ.setdefault("DB_NAME", "test_hr_settings")


HR = {"role": "hr_admin", "id": "u-hr", "email": "hr@x.com"}
SUPER = {"role": "super_admin", "id": "u-su", "email": "su@x.com"}
STAFF = {"role": "staff", "id": "u-mia", "email": "mia@x.com"}


def test_get_settings_returns_defaults_when_none_in_db():
    from routes.hr_settings import get_settings
    db = MagicMock()
    db.hr_settings = MagicMock()
    db.hr_settings.find_one = AsyncMock(return_value=None)
    with patch("routes.hr_settings.get_db", return_value=db):
        out = asyncio.run(get_settings(current_user=HR))
    assert out["company_name"] == ""
    assert out["authorising_officer"]["name"] == ""
    assert out["sponsor_licence_status"] == "applying"
    assert out["id"] == "default"


def test_get_settings_returns_persisted_doc():
    from routes.hr_settings import get_settings
    db = MagicMock()
    db.hr_settings = MagicMock()
    db.hr_settings.find_one = AsyncMock(return_value={
        "id": "default",
        "company_name": "Tile Station Ltd",
        "sponsor_licence_number": "LIC-555",
        "authorising_officer": {"name": "Jane", "job_title": "HR Director",
                                "email": "jane@x.com"},
    })
    with patch("routes.hr_settings.get_db", return_value=db):
        out = asyncio.run(get_settings(current_user=HR))
    assert out["company_name"] == "Tile Station Ltd"
    assert out["authorising_officer"]["name"] == "Jane"


def test_get_settings_rejects_non_hr():
    from routes.hr_settings import get_settings
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc:
        asyncio.run(get_settings(current_user=STAFF))
    assert exc.value.status_code == 403


def test_update_settings_writes_to_db_super_admin_only():
    from routes.hr_settings import update_settings, HRSettings, AuthorisingOfficer
    db = MagicMock()
    db.hr_settings = MagicMock()
    db.hr_settings.find_one = AsyncMock(return_value=None)
    captured_filter = {}
    captured_set = {}
    async def _update(flt, op, upsert=False):
        captured_filter.update(flt)
        captured_set.update(op["$set"])
    db.hr_settings.update_one = AsyncMock(side_effect=_update)
    payload = HRSettings(
        company_name="Tile Station Ltd",
        sponsor_licence_number="LIC-12345",
        authorising_officer=AuthorisingOfficer(
            name="Jane Smith", job_title="HR Director", email="jane@x.com",
        ),
    )
    with patch("routes.hr_settings.get_db", return_value=db):
        out = asyncio.run(update_settings(payload, current_user=SUPER))
    assert out["company_name"] == "Tile Station Ltd"
    assert out["authorising_officer"]["name"] == "Jane Smith"
    assert out["updated_by"] == "su@x.com"
    # Auto-stamps effective date on first save
    assert out["policy_effective_date"]
    # Filter is the singleton id
    assert captured_filter == {"id": "default"}
    # Set carries the full doc
    assert captured_set["company_name"] == "Tile Station Ltd"


def test_update_settings_rejects_hr_admin_role():
    """HR admin can READ but only super_admin can WRITE — settings drive
    the legal Sponsor Licence policy document."""
    from routes.hr_settings import update_settings, HRSettings
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc:
        asyncio.run(update_settings(HRSettings(), current_user=HR))
    assert exc.value.status_code == 403


def test_update_settings_rejects_invalid_licence_status():
    from routes.hr_settings import update_settings, HRSettings
    from fastapi import HTTPException
    payload = HRSettings(sponsor_licence_status="bogus")
    with pytest.raises(HTTPException) as exc:
        asyncio.run(update_settings(payload, current_user=SUPER))
    assert exc.value.status_code == 400


def test_update_settings_rejects_invalid_effective_date():
    from routes.hr_settings import update_settings, HRSettings
    from fastapi import HTTPException
    payload = HRSettings(policy_effective_date="not-a-date")
    with pytest.raises(HTTPException) as exc:
        asyncio.run(update_settings(payload, current_user=SUPER))
    assert exc.value.status_code == 400


def test_update_settings_preserves_created_at_on_overwrite():
    from routes.hr_settings import update_settings, HRSettings
    db = MagicMock()
    db.hr_settings = MagicMock()
    db.hr_settings.find_one = AsyncMock(return_value={"created_at": "2026-01-01T00:00:00+00:00"})
    captured_set = {}
    async def _update(_flt, op, upsert=False):
        captured_set.update(op["$set"])
    db.hr_settings.update_one = AsyncMock(side_effect=_update)
    with patch("routes.hr_settings.get_db", return_value=db):
        asyncio.run(update_settings(HRSettings(company_name="X"), current_user=SUPER))
    assert captured_set["created_at"] == "2026-01-01T00:00:00+00:00"
    # updated_at is newly stamped
    assert captured_set["updated_at"] != "2026-01-01T00:00:00+00:00"


def test_update_settings_keeps_user_supplied_effective_date():
    """If the user explicitly set the policy_effective_date, we don't
    overwrite it with today on subsequent saves."""
    from routes.hr_settings import update_settings, HRSettings
    db = MagicMock()
    db.hr_settings = MagicMock()
    db.hr_settings.find_one = AsyncMock(return_value=None)
    captured = {}
    async def _update(_flt, op, upsert=False):
        captured.update(op["$set"])
    db.hr_settings.update_one = AsyncMock(side_effect=_update)
    payload = HRSettings(company_name="X", policy_effective_date="2025-08-15")
    with patch("routes.hr_settings.get_db", return_value=db):
        out = asyncio.run(update_settings(payload, current_user=SUPER))
    assert out["policy_effective_date"] == "2025-08-15"
    assert captured["policy_effective_date"] == "2025-08-15"

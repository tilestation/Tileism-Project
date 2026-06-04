"""
Tests for `services.staff_attribution.resolve_staff_attribution`
(4 Jun 2026). Verifies that new quotations + invoices stamp the
right `created_by_user_id`, `showroom_id`, and `showroom_name` so
downstream reports remain correct after a staff transfer.
"""
import os
from unittest.mock import patch, AsyncMock, MagicMock

import pytest


@pytest.fixture(autouse=True)
def _env_setup():
    os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
    os.environ.setdefault("DB_NAME", "test_staff_attribution")


def _db(showroom_doc=None):
    db = MagicMock()
    db.showrooms.find_one = AsyncMock(return_value=showroom_doc)
    return db


def test_attribution_from_input_showroom_name():
    """Form passed showroom_name explicitly → stamped as-is."""
    import asyncio
    from services.staff_attribution import resolve_staff_attribution
    with patch("services.staff_attribution.get_db", return_value=_db()):
        out = asyncio.run(resolve_staff_attribution(
            {"id": "u_1", "email": "staff@example.com",
             "showroom_id": "ignored", "showroom_name": "ignored"},
            input_showroom_id="sr_form",
            input_showroom_name="Gravesend",
        ))
    assert out["created_by_user_id"] == "u_1"
    assert out["showroom_id"] == "sr_form"
    assert out["showroom_name"] == "Gravesend"


def test_attribution_falls_back_to_user_profile():
    """No form showroom → use the staff member's profile showroom."""
    import asyncio
    from services.staff_attribution import resolve_staff_attribution
    with patch("services.staff_attribution.get_db", return_value=_db()):
        out = asyncio.run(resolve_staff_attribution(
            {"id": "u_syed", "email": "syed@example.com",
             "showroom_id": "sr_gv", "showroom_name": "Gravesend"},
        ))
    assert out["created_by_user_id"] == "u_syed"
    assert out["showroom_id"] == "sr_gv"
    assert out["showroom_name"] == "Gravesend"


def test_attribution_hydrates_showroom_name_when_user_lacks_it():
    """User profile has showroom_id but no cached name → look up the
    showrooms collection."""
    import asyncio
    from services.staff_attribution import resolve_staff_attribution
    # ObjectId-style lookup will fail (not a real ObjectId), so the
    # helper falls back to {"id": showroom_id} match — provide a doc
    # for that branch.
    db = _db(showroom_doc={"name": "Tonbridge"})
    with patch("services.staff_attribution.get_db", return_value=db):
        out = asyncio.run(resolve_staff_attribution(
            {"id": "u_tom", "email": "tom@example.com",
             "showroom_id": "sr_tonbridge"},  # No showroom_name
        ))
    assert out["showroom_id"] == "sr_tonbridge"
    assert out["showroom_name"] == "Tonbridge"


def test_attribution_handles_missing_user_id():
    """Edge case: current_user dict has no `id` (legacy auth path).
    Returns empty string, not None — downstream code never has to
    handle None on a stamped doc."""
    import asyncio
    from services.staff_attribution import resolve_staff_attribution
    with patch("services.staff_attribution.get_db", return_value=_db()):
        out = asyncio.run(resolve_staff_attribution(
            {"email": "ghost@example.com"},  # no id
        ))
    assert out["created_by_user_id"] == ""
    assert out["showroom_id"] == ""
    assert out["showroom_name"] == ""


def test_attribution_user_profile_overrides_empty_form_input():
    """Form passed empty strings → user profile fills in. Defends
    against the EPOS form passing "" instead of omitting the field."""
    import asyncio
    from services.staff_attribution import resolve_staff_attribution
    with patch("services.staff_attribution.get_db", return_value=_db()):
        out = asyncio.run(resolve_staff_attribution(
            {"id": "u_amy", "showroom_id": "sr_maidstone", "showroom_name": "Maidstone"},
            input_showroom_id="",
            input_showroom_name="",
        ))
    assert out["showroom_name"] == "Maidstone"


def test_attribution_form_input_wins_over_profile():
    """Reality check: if the staff explicitly picks a showroom in the
    form (e.g. they're temporarily covering another store), the form
    value wins over their profile default."""
    import asyncio
    from services.staff_attribution import resolve_staff_attribution
    with patch("services.staff_attribution.get_db", return_value=_db()):
        out = asyncio.run(resolve_staff_attribution(
            {"id": "u_syed", "showroom_id": "sr_gv", "showroom_name": "Gravesend"},
            input_showroom_id="sr_covering",
            input_showroom_name="Tonbridge",
        ))
    assert out["showroom_id"] == "sr_covering"
    assert out["showroom_name"] == "Tonbridge"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

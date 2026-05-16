"""
Tests for the unified permissions system (16 May 2026).

Covers the breaking changes to /api/permissions/me and the new
per-user overrides endpoints, with particular focus on the safety
properties that matter for the production showroom rollout:

  1. Role defaults are returned for normal staff (no overrides).
  2. Adding `extra_pages` to a user union-merges with their role.
  3. Adding `denied_pages` removes them from the effective set.
  4. Super Admin always returns full access, even if overrides are set.
  5. `_ensure_system_roles` additively backfills new default pages
     onto pre-existing role rows without clobbering admin edits.
"""
from __future__ import annotations

import pytest

from config import get_db
from routes.permissions import (
    PAGE_REGISTRY,
    SYSTEM_ROLE_DEFAULTS,
    _ensure_system_roles,
    get_my_permissions,
    get_user_permissions_detail,
    update_user_overrides,
    UserOverridesPayload,
)

pytestmark = pytest.mark.asyncio

# Stable test user identifiers — `replace_one(upsert=True)` semantics
# in the fixture means re-runs are idempotent.
_TEST_STAFF_EMAIL = "pytest-perms-staff@example.com"
_TEST_SUPER_EMAIL = "pytest-perms-super@example.com"


async def _seed_test_users():
    """Idempotently seed two test users — one staff, one super_admin —
    so the override tests have something to mutate."""
    db = get_db()
    for email, role in [(_TEST_STAFF_EMAIL, "staff"), (_TEST_SUPER_EMAIL, "super_admin")]:
        await db.users.replace_one(
            {"email": email},
            {
                "email": email,
                "name": f"Pytest {role}",
                "role": role,
                "showroom_id": None,
                "showroom_name": None,
            },
            upsert=True,
        )


async def _cleanup_test_users():
    db = get_db()
    await db.users.delete_many({"email": {"$in": [_TEST_STAFF_EMAIL, _TEST_SUPER_EMAIL]}})


# ---------------------------------------------------------------------------
# /api/permissions/me — effective permission resolution
# ---------------------------------------------------------------------------

async def test_me_returns_role_defaults_when_no_overrides():
    """A staff user with no overrides should get exactly the staff role
    defaults from SYSTEM_ROLE_DEFAULTS["staff"] (give or take any extra
    pages the super-admin has added to the role via the UI)."""
    await _seed_test_users()
    db = get_db()
    await _ensure_system_roles(db)

    current_user = {"email": _TEST_STAFF_EMAIL, "role": "staff"}
    result = await get_my_permissions(current_user=current_user)

    assert result["role"] == "staff"
    assert result["is_super_admin"] is False
    # Staff defaults include these common showroom pages — verify a
    # representative sample so future expansions don't break the test.
    for expected_page in ["dashboard", "epos", "cash_counter", "showroom_dashboard", "invoice", "orders"]:
        assert expected_page in result["pages"], f"Staff role missing default page '{expected_page}'"

    await _cleanup_test_users()


async def test_me_super_admin_returns_full_registry():
    """Super Admin must always get everything regardless of stored role
    pages — it short-circuits to PAGE_REGISTRY/ACTION_REGISTRY."""
    await _seed_test_users()
    db = get_db()
    await _ensure_system_roles(db)

    current_user = {"email": _TEST_SUPER_EMAIL, "role": "super_admin"}
    result = await get_my_permissions(current_user=current_user)

    assert result["is_super_admin"] is True
    # Full registry — every page key must be present.
    expected = {p["key"] for p in PAGE_REGISTRY}
    assert set(result["pages"]) == expected

    await _cleanup_test_users()


async def test_extra_pages_grant_access_beyond_role():
    """`extra_pages` should additively grant access without affecting
    other staff users (per-user only)."""
    await _seed_test_users()
    db = get_db()
    await _ensure_system_roles(db)

    # Pick a page that's NOT in the staff defaults.
    not_in_role = "permissions_admin"  # admin-only page
    assert not_in_role not in SYSTEM_ROLE_DEFAULTS["staff"]["pages"]

    # Grant it as an extra to one staff user.
    super_user = {"email": _TEST_SUPER_EMAIL, "role": "super_admin"}
    payload = UserOverridesPayload(extra_pages=[not_in_role])
    await update_user_overrides(email=_TEST_STAFF_EMAIL, payload=payload, current_user=super_user)

    # Now the staff user's effective set should include it.
    me = await get_my_permissions(current_user={"email": _TEST_STAFF_EMAIL, "role": "staff"})
    assert not_in_role in me["pages"]

    await _cleanup_test_users()


async def test_denied_pages_remove_role_access():
    """`denied_pages` should remove pages the role would normally grant."""
    await _seed_test_users()
    db = get_db()
    await _ensure_system_roles(db)

    # Pick a page that IS in the staff defaults.
    in_role = "epos"
    assert in_role in SYSTEM_ROLE_DEFAULTS["staff"]["pages"]

    super_user = {"email": _TEST_SUPER_EMAIL, "role": "super_admin"}
    payload = UserOverridesPayload(denied_pages=[in_role])
    await update_user_overrides(email=_TEST_STAFF_EMAIL, payload=payload, current_user=super_user)

    me = await get_my_permissions(current_user={"email": _TEST_STAFF_EMAIL, "role": "staff"})
    assert in_role not in me["pages"]

    await _cleanup_test_users()


async def test_override_validation_drops_unknown_keys():
    """Unknown page keys passed via overrides must be silently dropped
    (not stored) so a typo can't corrupt the DB or persist invalid keys."""
    await _seed_test_users()
    db = get_db()
    await _ensure_system_roles(db)

    super_user = {"email": _TEST_SUPER_EMAIL, "role": "super_admin"}
    payload = UserOverridesPayload(
        extra_pages=["totally_made_up_key", "permissions_admin"],
    )
    result = await update_user_overrides(
        email=_TEST_STAFF_EMAIL, payload=payload, current_user=super_user,
    )
    # The bogus key is dropped; the valid one survives.
    assert "totally_made_up_key" not in result["extra_pages"]
    assert "permissions_admin" in result["extra_pages"]

    await _cleanup_test_users()


async def test_user_detail_breakdown_separates_role_from_overrides():
    """The /users/{email} detail endpoint must surface role_pages and
    extra_pages SEPARATELY so the UI can render which are inherited
    vs which are personal grants."""
    await _seed_test_users()
    db = get_db()
    await _ensure_system_roles(db)

    super_user = {"email": _TEST_SUPER_EMAIL, "role": "super_admin"}
    payload = UserOverridesPayload(extra_pages=["permissions_admin"])
    await update_user_overrides(email=_TEST_STAFF_EMAIL, payload=payload, current_user=super_user)

    detail = await get_user_permissions_detail(email=_TEST_STAFF_EMAIL, current_user=super_user)

    # Role baseline shows the staff defaults; extras show ONLY the override.
    assert "epos" in detail["role_pages"]
    assert "permissions_admin" not in detail["role_pages"]
    assert detail["extra_pages"] == ["permissions_admin"]
    # Effective merges both.
    assert "permissions_admin" in detail["effective_pages"]
    assert "epos" in detail["effective_pages"]

    await _cleanup_test_users()


# ---------------------------------------------------------------------------
# _ensure_system_roles — additive backfill safety
# ---------------------------------------------------------------------------

async def test_ensure_system_roles_additively_backfills_new_defaults():
    """If we extend SYSTEM_ROLE_DEFAULTS["staff"] in code (as we did on
    May 16 2026), pre-existing role rows in production must pick up
    the new pages on next call — without losing pages an admin has
    customised onto the role.
    """
    db = get_db()

    # Seed a "stale" staff role that's missing several modern pages
    # plus has one custom page that an admin added via the UI.
    await db.roles.replace_one(
        {"role_id": "staff"},
        {
            "role_id": "staff",
            "role_name": "Staff",
            "is_system": True,
            "is_super_admin": False,
            "pages": ["dashboard", "epos", "admin_added_custom_page"],
            "actions": [],
            "created_at": None,
            "updated_at": None,
        },
        upsert=True,
    )

    await _ensure_system_roles(db)

    refreshed = await db.roles.find_one({"role_id": "staff"}, {"_id": 0})
    # New defaults should be present…
    assert "cash_counter" in refreshed["pages"]
    assert "showroom_dashboard" in refreshed["pages"]
    # …existing pages preserved…
    assert "dashboard" in refreshed["pages"]
    assert "epos" in refreshed["pages"]
    # …and the admin's custom addition not wiped.
    assert "admin_added_custom_page" in refreshed["pages"]

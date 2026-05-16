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

    # Use a throwaway test role_id so we don't pollute the real `staff`
    # row in the preview DB.
    test_role = "pytest_backfill_test_role"
    try:
        await db.roles.replace_one(
            {"role_id": test_role},
            {
                "role_id": test_role,
                "role_name": "Pytest Test",
                "is_system": True,
                "is_super_admin": False,
                "pages": ["dashboard", "epos", "admin_added_custom_page"],
                "actions": [],
                "created_at": None,
                "updated_at": None,
            },
            upsert=True,
        )

        # Temporarily register this role in SYSTEM_ROLE_IDS / DEFAULTS so
        # `_ensure_system_roles` includes it in the backfill pass.
        from routes import permissions as perms_mod
        perms_mod.SYSTEM_ROLE_IDS.add(test_role)
        perms_mod.SYSTEM_ROLE_DEFAULTS[test_role] = {
            "pages": ["dashboard", "epos", "cash_counter", "showroom_dashboard"],
            "actions": [],
        }

        try:
            await _ensure_system_roles(db)
            refreshed = await db.roles.find_one({"role_id": test_role}, {"_id": 0})
            # New defaults should be present…
            assert "cash_counter" in refreshed["pages"]
            assert "showroom_dashboard" in refreshed["pages"]
            # …existing pages preserved…
            assert "dashboard" in refreshed["pages"]
            assert "epos" in refreshed["pages"]
            # …and the admin's custom addition not wiped.
            assert "admin_added_custom_page" in refreshed["pages"]
        finally:
            perms_mod.SYSTEM_ROLE_IDS.discard(test_role)
            perms_mod.SYSTEM_ROLE_DEFAULTS.pop(test_role, None)
    finally:
        await db.roles.delete_one({"role_id": test_role})


async def test_user_modified_flag_prevents_backfill_re_adding_removed_pages():
    """CRITICAL BUG FIX (May 16 2026):

    When a super-admin opens /admin/permissions and UNTICKS a page from
    the Staff role (e.g. removes Sync Hub), the previous backfill logic
    silently put it back on the next request because the page was still
    listed in SYSTEM_ROLE_DEFAULTS["staff"].

    Fix: PUT /roles/{id} now stamps `user_modified=true`, and
    `_ensure_system_roles` skips the backfill entirely for any role with
    that flag set. The admin's choices become authoritative.

    This test pins that contract so a future refactor can't reintroduce
    the silent re-add bug.
    """
    db = get_db()
    test_role = "pytest_user_modified_role"

    try:
        # Admin's state: removed sync_hub (which IS in defaults) and
        # PUT handler stamped user_modified=true.
        await db.roles.replace_one(
            {"role_id": test_role},
            {
                "role_id": test_role,
                "role_name": "Pytest UM",
                "is_system": True,
                "is_super_admin": False,
                # Note: sync_hub deliberately ABSENT — admin removed it.
                "pages": ["dashboard", "epos", "cash_counter"],
                "actions": [],
                "user_modified": True,    # ← THE flag that protects from backfill
                "created_at": None,
                "updated_at": None,
            },
            upsert=True,
        )

        from routes import permissions as perms_mod
        perms_mod.SYSTEM_ROLE_IDS.add(test_role)
        perms_mod.SYSTEM_ROLE_DEFAULTS[test_role] = {
            "pages": ["dashboard", "epos", "cash_counter", "sync_hub"],  # sync_hub in defaults
            "actions": [],
        }

        try:
            # Run the function that USED to re-add sync_hub.
            await _ensure_system_roles(db)

            # sync_hub must STILL be absent — admin's removal is honoured.
            refreshed = await db.roles.find_one({"role_id": test_role}, {"_id": 0})
            assert "sync_hub" not in refreshed["pages"], (
                "Backfill re-added a page the admin removed. The "
                "user_modified flag is being ignored. This is the "
                "'Sync Hub keeps coming back' bug."
            )
            # Sanity: the pages we kept stay kept.
            assert "dashboard" in refreshed["pages"]
            assert "epos" in refreshed["pages"]
        finally:
            perms_mod.SYSTEM_ROLE_IDS.discard(test_role)
            perms_mod.SYSTEM_ROLE_DEFAULTS.pop(test_role, None)
    finally:
        await db.roles.delete_one({"role_id": test_role})


async def test_revoking_role_page_blocks_user_end_to_end():
    """END-TO-END regression for the "I unticked Sync Hub but staff
    still see it" bug (17 May 2026).

    Pins the full chain:
      1. Staff role contains sync_hub by default → user `/me` returns it
      2. Super-admin PUTs role with sync_hub removed (sets user_modified)
      3. Same staff user calls `/me` → sync_hub is NOT in their pages
      4. `_ensure_system_roles` runs again (e.g. on next request) → still
         doesn't re-add sync_hub because user_modified is honoured
      5. Staff user with stale `permissions: ['products']` legacy array
         doesn't bypass the revocation — `/me` returns pages from the
         role, not from that legacy array (no fallback merge at the
         backend layer)

    If this test fails, the bug is back and showroom admins can't revoke
    permissions from their staff.
    """
    from routes import permissions as perms_mod

    db = get_db()
    test_role = "pytest_e2e_revoke_role"
    test_email = "pytest-e2e-revoke@example.com"

    # Seed the role + a user assigned to it. User also has a stale
    # legacy `permissions: ['products']` array (mimicking pre-migration
    # data) to prove the new system ignores it.
    await db.roles.replace_one(
        {"role_id": test_role},
        {
            "role_id": test_role,
            "role_name": "Pytest E2E",
            "is_system": True,
            "is_super_admin": False,
            "pages": ["dashboard", "epos", "sync_hub"],
            "actions": [],
            "user_modified": False,
        },
        upsert=True,
    )
    await db.users.replace_one(
        {"email": test_email},
        {
            "email": test_email,
            "name": "Pytest E2E User",
            "role": test_role,
            "permissions": ["products", "dashboard"],   # ← legacy stale array
        },
        upsert=True,
    )

    try:
        # Step 1: user sees sync_hub initially.
        me1 = await perms_mod.get_my_permissions(
            current_user={"email": test_email, "role": test_role},
        )
        assert "sync_hub" in me1["pages"], "initial state: sync_hub should be granted by role"

        # Step 2: admin removes sync_hub by editing the role doc directly
        # (mirrors what PUT /roles/{id} does). user_modified=True stamps
        # the row as authoritative so backfill won't fight us.
        await db.roles.update_one(
            {"role_id": test_role},
            {"$set": {
                "pages": ["dashboard", "epos"],   # sync_hub deliberately gone
                "user_modified": True,
            }},
        )

        # Step 3: same user, same JWT — sync_hub must now be hidden.
        # The legacy `permissions: ['products']` array on their doc
        # MUST NOT add anything back at the backend layer.
        me2 = await perms_mod.get_my_permissions(
            current_user={"email": test_email, "role": test_role},
        )
        assert "sync_hub" not in me2["pages"], (
            "After admin removed sync_hub from the role, user `/me` still "
            "returns it. This means revocations don't take effect — the "
            "exact bug reported on 17 May 2026."
        )
        # Sanity: dashboard + epos still granted.
        assert "dashboard" in me2["pages"]
        assert "epos" in me2["pages"]

        # Step 4: trigger the backfill that USED to re-add removed pages.
        # SYSTEM_ROLE_IDS must include our test role for the backfill to
        # consider it.
        perms_mod.SYSTEM_ROLE_IDS.add(test_role)
        perms_mod.SYSTEM_ROLE_DEFAULTS[test_role] = {
            "pages": ["dashboard", "epos", "sync_hub"],   # defaults still want sync_hub
            "actions": [],
        }
        try:
            await perms_mod._ensure_system_roles(db)
        finally:
            perms_mod.SYSTEM_ROLE_IDS.discard(test_role)
            perms_mod.SYSTEM_ROLE_DEFAULTS.pop(test_role, None)

        # Step 5: re-check /me one more time. sync_hub must STILL be gone.
        me3 = await perms_mod.get_my_permissions(
            current_user={"email": test_email, "role": test_role},
        )
        assert "sync_hub" not in me3["pages"], (
            "Backfill silently re-added sync_hub after admin removed it. "
            "user_modified flag is being ignored."
        )
    finally:
        await db.roles.delete_one({"role_id": test_role})
        await db.users.delete_one({"email": test_email})


async def test_default_custom_roles_seeded_once_and_stay_deleted():
    """The Showroom Lead role should auto-seed on first /roles call,
    but if the admin deletes it later, it must STAY deleted (no zombie
    re-seeding on backend restart)."""
    from routes import permissions as perms_mod

    db = get_db()
    test_role = "pytest_custom_role_seed_test"
    marker_id = f"custom_role_seeded:{test_role}"

    # Inject a throwaway custom-role spec to avoid touching the real
    # showroom_lead row.
    perms_mod.DEFAULT_CUSTOM_ROLES[test_role] = {
        "role_name": "Pytest Custom",
        "pages": ["dashboard", "stock_transfers", "reorder_suggestions"],
        "actions": [],
    }

    try:
        # Clean slate.
        await db.roles.delete_one({"role_id": test_role})
        await db.system_state.delete_one({"_id": marker_id})

        await perms_mod._ensure_default_custom_roles(db)

        # First call: role is seeded with our extras.
        seeded = await db.roles.find_one({"role_id": test_role})
        assert seeded is not None
        assert seeded["is_system"] is False
        assert "stock_transfers" in seeded["pages"]
        assert "reorder_suggestions" in seeded["pages"]

        # Admin deletes the role.
        await db.roles.delete_one({"role_id": test_role})

        # Second call: must NOT re-seed.
        await perms_mod._ensure_default_custom_roles(db)
        after = await db.roles.find_one({"role_id": test_role})
        assert after is None, (
            "Custom role re-seeded after deletion — should stay deleted "
            "forever once the admin explicitly removes it."
        )
    finally:
        perms_mod.DEFAULT_CUSTOM_ROLES.pop(test_role, None)
        await db.roles.delete_one({"role_id": test_role})
        await db.system_state.delete_one({"_id": marker_id})

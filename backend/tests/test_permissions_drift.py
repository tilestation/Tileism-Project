"""
Regression test for the GROUPED-vs-LEGACY permission drift bug
(16 May 2026 — Sydenham showroom incident).

Bug: `/api/admin/permissions` used to return the legacy granular slugs
(`create_invoice`, `edit_invoice`, ...) while the admin sidebar checked
for grouped keys (`epos`, `dashboard`, ...). New users created via the
Edit User modal therefore got dead permissions that no sidebar item
matched → empty menu + "Admin access required" banner.

Fix:
  1. `routes/admin.py::AVAILABLE_PERMISSIONS` now uses the canonical
     12 grouped keys (mirroring server.py + invites.py).
  2. `update_user_permissions` accepts BOTH the new grouped keys and
     the legacy slugs (so old users with historical data aren't locked
     out when an admin saves a showroom change).

These tests pin the contract so a future refactor can't silently
re-introduce the drift.
"""
from __future__ import annotations

from routes.admin import (
    ALL_ACCEPTED_PERMISSIONS,
    AVAILABLE_PERMISSIONS,
    LEGACY_PERMISSION_SLUGS,
)

# Canonical grouped permission keys that drive the admin sidebar
# rendering in /app/frontend/src/components/Layout.js. If this list
# changes, the sidebar (Layout.js:150-203), the labels dict
# (UserManagement.js:20-33), and the server.py mirror MUST all be
# updated in lockstep.
EXPECTED_GROUPED_KEYS = {
    "dashboard",
    "products",
    "categories",
    "orders",
    "epos",
    "customer_pricing",
    "customer_invites",
    "bulk_inquiries",
    "marketing",
    "showrooms",
    "reports",
    "user_management",
}


def test_available_permissions_uses_canonical_grouped_keys():
    """The list served by GET /api/admin/permissions must contain the
    grouped keys the sidebar actually checks — not the legacy granular
    slugs that caused the Sydenham incident."""
    assert set(AVAILABLE_PERMISSIONS) == EXPECTED_GROUPED_KEYS

    # And explicitly NOT the old legacy slugs (catches a regression
    # where someone accidentally re-paste-bombs the old list).
    for legacy_key in ("create_invoice", "edit_invoice", "view_reports", "manage_inventory"):
        assert legacy_key not in AVAILABLE_PERMISSIONS, (
            f"Legacy slug '{legacy_key}' must NOT appear in AVAILABLE_PERMISSIONS — "
            f"it doesn't match any sidebar permission check and creating users "
            f"with it gives them an empty admin menu."
        )


def test_legacy_slugs_still_accepted_for_backwards_compat():
    """Existing users (created before this fix) may still have legacy
    slugs stored. The PUT endpoint must accept them so an admin saving
    an unrelated change (e.g. showroom reassignment) doesn't get a 400
    'Invalid permissions' error."""
    assert "create_invoice" in ALL_ACCEPTED_PERMISSIONS
    assert "edit_invoice" in ALL_ACCEPTED_PERMISSIONS
    assert "view_reports" in ALL_ACCEPTED_PERMISSIONS
    # Sanity: the accepted set is the union of both.
    assert ALL_ACCEPTED_PERMISSIONS == (
        set(AVAILABLE_PERMISSIONS) | set(LEGACY_PERMISSION_SLUGS)
    )


def test_invalid_permission_keys_still_rejected():
    """We accept grouped + legacy but nothing else — a typo or rogue
    key must still raise a 400, otherwise the database fills with junk."""
    assert "totally_made_up_key" not in ALL_ACCEPTED_PERMISSIONS
    assert "admin_access" not in ALL_ACCEPTED_PERMISSIONS  # common mis-guess
    assert "all" not in ALL_ACCEPTED_PERMISSIONS

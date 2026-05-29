"""
Regression test for the auto-publish opt-in behaviour
(24 May 2026 — user reported "products are auto publishing to
Website even half attributs are saved. I need to manually publish
the products to Website when I see the products have all attributes").

Root cause:
  `bulk_update_unified` auto-published products to the storefront
  whenever the updates payload contained `sub_categories` or
  `main_category`. Admins setting categories mid-edit (before all
  attributes were filled in) ended up with half-finished products
  going live to customers.

Fixed behaviour:
  Auto-publish is now OPT-IN. The admin must EITHER:
    a. Tick "Show on website" in the bulk editor (which sets
       `updates.show_on_website = true`), OR
    b. Send `auto_publish: true` at the request body root (for
       legacy callers / scripts).
  Just setting categories no longer triggers publication — the admin
  controls when products go live.

Contract pinned (inspecting source — DB ops require live MongoDB):
  1. The auto-publish branch is gated by `explicit_publish_opt_in`.
  2. `explicit_publish_opt_in` honours both legacy `auto_publish` body
     flag AND the existing `updates.show_on_website` toggle.
  3. The implicit trigger (just `has_category_update`) is no longer
     sufficient on its own — the test asserts the conditional is
     `explicit_publish_opt_in AND has_category_update AND product_ids`,
     not the old `has_category_update AND product_ids`.
"""
from __future__ import annotations

import inspect
import re


def _bulk_update_unified_source():
    from routes import supplier_sync
    return inspect.getsource(supplier_sync.bulk_update_unified)


def test_auto_publish_is_gated_by_explicit_opt_in():
    src = _bulk_update_unified_source()
    # The new variable name MUST exist — pins the new contract.
    assert "explicit_publish_opt_in" in src, (
        "bulk_update_unified must compute an `explicit_publish_opt_in` "
        "boolean to decide whether auto-publish fires"
    )


def test_auto_publish_honours_show_on_website_toggle():
    src = _bulk_update_unified_source()
    # The toggle MUST honour the existing "Show on website" admin
    # checkbox so admins don't have to learn a new control.
    assert re.search(
        r"updates\.get\(['\"]show_on_website['\"]\)\s+is\s+True",
        src,
    ), (
        "The existing `updates.show_on_website == True` toggle must "
        "still trigger auto-publish — that's the admin-facing UX that "
        "users already know"
    )


def test_auto_publish_honours_legacy_auto_publish_flag():
    src = _bulk_update_unified_source()
    # Belt-and-braces escape hatch for legacy automation scripts.
    assert re.search(
        r"data\.get\(['\"]auto_publish['\"]",
        src,
    ), (
        "Legacy `auto_publish: true` at request-body root must still "
        "force auto-publish so existing automation scripts keep working"
    )


def test_auto_publish_branch_requires_both_opt_in_and_categories():
    src = _bulk_update_unified_source()
    # The conditional that gates the auto-publish loop must check ALL
    # THREE: opt-in flag, category update present, and product_ids.
    # Missing any one of these would re-introduce the bug.
    assert re.search(
        r"if\s+explicit_publish_opt_in\s+and\s+has_category_update\s+and\s+product_ids:",
        src,
    ), (
        "The auto-publish loop must be gated by "
        "`explicit_publish_opt_in AND has_category_update AND product_ids` "
        "— dropping any of these re-introduces the half-saved-product "
        "auto-publish bug"
    )


def test_implicit_category_only_trigger_is_gone():
    """The OLD code had `if has_category_update and product_ids:` —
    that bare conditional must NOT come back, otherwise the bug
    silently regresses."""
    src = _bulk_update_unified_source()
    # The bare conditional appears nowhere now — only the new gated
    # form survives.
    assert not re.search(
        r"^\s*if\s+has_category_update\s+and\s+product_ids:\s*$",
        src,
        re.MULTILINE,
    ), (
        "The implicit `if has_category_update and product_ids:` "
        "trigger must not return — that was the original bug"
    )

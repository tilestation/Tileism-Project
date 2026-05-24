"""
Regression test for the Daily UI Health Report false-failure fixes
(24 May 2026).

Two bugs flagged by the daily report yesterday:
  1. `homepage_categories` check pointed at /shop, which 301-redirects
     to /tiles where the actual element (data-testid=
     "homepage-category-grid") doesn't exist. The element actually
     lives on the storefront ROOT.
  2. `tile_detail_volume_pricing` graded as a hard FAIL when a
     collection's first product happened not to have tier pricing
     configured — a content choice by the admin, not a regression.

Contract pinned:
  • CRITICAL_UI_CHECKS entry for homepage_categories MUST have url="/".
  • CRITICAL_UI_CHECKS entry for tile_detail_volume_pricing MUST be
    marked severity="warn" so a missing optional table no longer
    sends a red email.
  • The runner's severity-aware grading MUST downgrade soft failures
    to status="warn" (not "fail") and the aggregate return must
    include a `warn_count` separate from `failed_count`.
"""
from __future__ import annotations

import re
import inspect

import pytest


def test_homepage_categories_check_targets_root_not_shop():
    """The category grid lives on `/` (storefront home), not `/shop`
    (which redirects to /tiles)."""
    from routes.website_admin import CRITICAL_UI_CHECKS
    check = next(
        (c for c in CRITICAL_UI_CHECKS if c.get("id") == "homepage_categories"),
        None,
    )
    assert check, "CRITICAL_UI_CHECKS must contain homepage_categories"
    assert check["url"] == "/", (
        f"homepage_categories must probe `/`; got {check['url']!r} "
        "(the storefront's /shop route 301s to /tiles where the grid "
        "isn't expected to live)"
    )


def test_volume_pricing_check_is_soft_failure():
    """Volume pricing absence on a given collection is a CONTENT choice
    (admin hasn't configured bulk discounts on that product line) — not
    a regression. Must be severity=warn so it doesn't trigger the red
    email digest."""
    from routes.website_admin import CRITICAL_UI_CHECKS
    check = next(
        (c for c in CRITICAL_UI_CHECKS if c.get("id") == "tile_detail_volume_pricing"),
        None,
    )
    assert check, "CRITICAL_UI_CHECKS must contain tile_detail_volume_pricing"
    assert check.get("severity") == "warn", (
        f"Volume pricing check must be severity='warn'; got "
        f"{check.get('severity')!r}. A product without tier pricing "
        "configured is an admin choice, not a bug."
    )


def test_runner_grades_soft_failures_as_warn_not_fail():
    """The runner's grading code MUST honour the severity field. Pin
    by inspecting the function source — full Playwright boot just for
    a 4-line conditional is overkill."""
    from services.ui_health_runner import run_ui_health_checks
    src = inspect.getsource(run_ui_health_checks)
    # Must read severity from the check dict (loop variable is `c`).
    assert re.search(
        r'severity\s*=\s*\(\s*c\.get\(\s*["\']severity["\']\s*\)',
        src,
    ), "Runner must read `c.get('severity')` from each check"
    # Must downgrade to "warn" when severity is "warn" and missing>0.
    assert re.search(r'"warn"\s*if\s*severity\s*==\s*["\']warn["\']\s*else\s*"fail"', src)


def test_runner_return_value_includes_warn_count():
    """The summary dict the runner returns MUST include a `warn_count`
    so the email digest can show "0 failures, 1 warning" cleanly."""
    from services.ui_health_runner import run_ui_health_checks
    src = inspect.getsource(run_ui_health_checks)
    assert '"warn_count"' in src, (
        "Runner return value must include warn_count separate from "
        "failed_count so emails distinguish soft vs hard failures"
    )

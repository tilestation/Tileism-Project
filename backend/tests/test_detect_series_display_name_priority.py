"""
Regression test for the Quick-Generate-All-Series-Descriptions
modal grouping bug (24 May 2026 — user reported the modal still
groups 25 "La Dolce" tiles under "Pietra Ligure" even after the
earlier frontend fix).

Root cause:
  Both `detect_series_from_products` and the batch-generate path
  in server.py read the product's renamable name with priority
      our_product_name → display_name → name → product_name
  For legacy products the supplier ingestion writes the supplier's
  original name into `our_product_name`. Admins later rename only
  `display_name` (because that's the field the storefront PDP and
  the bulk-editor product list both render). Result: detect-series
  picked the stale supplier value, not the admin's "La Dolce".

Fixed behaviour:
  The priority chain now starts with `display_name` to match the
  storefront's source of truth.
      display_name → our_product_name → website_name → name → product_name → series
  Both detect-series functions in server.py use the same ordering
  so future grouping never disagrees with the bulk-editor list.
"""
from __future__ import annotations

import inspect
import re

import pytest


def _detect_series_endpoint_source():
    """Read the source of the FastAPI route handler. The function is
    registered with @api_router.post but doesn't survive as a Python
    attribute on the module, so we read the file directly to find
    both detect-series blocks."""
    import server
    src = inspect.getsource(server)
    # Both detect-series blocks live in the route handlers between
    # "@api_router.post(\"/products/detect-series\")" and the next
    # decorator line.
    return src


def test_detect_series_uses_display_name_first():
    """The detect-series grouping logic must read `display_name`
    BEFORE `our_product_name` so admin-renamed products are grouped
    under the storefront-facing collection name, not the supplier's
    original series."""
    src = _detect_series_endpoint_source()
    # Find the priority-chain expression — must list display_name
    # FIRST among the name-source `or` chain.
    matches = re.findall(
        r"p\.get\(['\"]display_name['\"]\)\s*\n?\s*or\s*p\.get\(['\"]our_product_name['\"]\)",
        src,
    )
    assert len(matches) >= 2, (
        "Both detect-series functions must use `p.get('display_name') "
        "or p.get('our_product_name') or ...` ordering so admin-renamed "
        "products group under the storefront-facing name. "
        f"Found {len(matches)} occurrences, expected >= 2."
    )


def test_detect_series_does_not_prefer_our_product_name_first():
    """The OLD priority chain `our_product_name → display_name` was
    the bug — must NOT come back, or 25 La Dolce tiles re-group under
    Pietra Ligure again."""
    src = _detect_series_endpoint_source()
    bad_pattern = re.findall(
        r"p\.get\(['\"]our_product_name['\"]\)\s*or\s*p\.get\(['\"]display_name['\"]\)",
        src,
    )
    assert not bad_pattern, (
        "The pre-bug priority chain `our_product_name -> display_name` "
        "must NOT return — it groups legacy supplier names ahead of "
        "admin-renamed `display_name`"
    )


def test_detect_series_priority_chain_falls_back_through_known_fields():
    """The full priority chain must include all known name sources
    so detect-series doesn't return 'Unknown' for legacy rows where
    only one specific field is populated."""
    src = _detect_series_endpoint_source()
    for field in ("display_name", "our_product_name", "website_name",
                  "name", "product_name"):
        # Each field appears at least twice (both detect-series blocks).
        occurrences = len(re.findall(
            rf"p\.get\(['\"]{re.escape(field)}['\"]\)",
            src,
        ))
        assert occurrences >= 2, (
            f"Field `{field}` must appear at least twice in server.py "
            f"so both detect-series functions fall back through it. "
            f"Found {occurrences}."
        )

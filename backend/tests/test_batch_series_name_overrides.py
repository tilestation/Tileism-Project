"""
Regression test for the inline series-name override in the
batch-series-description generator (24 May 2026 — user reported
multiple times that auto-detection still picks "Pietra Ligure"
instead of "La Dolce" despite earlier priority-chain fixes;
they asked for a definitive "fix once and for all").

Why the priority-chain fix wasn't enough on its own:
  Some legacy products have the supplier's original name written
  into BOTH `display_name` AND `our_product_name` (the supplier
  ingestion job did this in a previous era). No re-ordering of the
  read priority could surface the admin's preferred collection name
  for these rows.

Definitive fix:
  Allow the admin to manually OVERRIDE each auto-detected series
  name in the Quick-Generate modal. The override map flows through
  the API as `series_name_overrides: {auto: edited}` and the backend
  rebuilds the grouping with the renamed labels before generation.

Contract pinned (this file):
  1. `BatchSeriesDescriptionRequest` exposes an optional
     `series_name_overrides: Dict[str, str]` field, defaulting to None.
  2. Empty / missing override map keeps the existing auto-detected
     names — backwards compatible with old admin clients.
  3. The override-application logic merges groups when two
     auto-detected names rename to the same target.
"""
from __future__ import annotations

import inspect
import re


def test_request_model_has_series_name_overrides():
    from server import BatchSeriesDescriptionRequest
    assert "series_name_overrides" in BatchSeriesDescriptionRequest.model_fields, (
        "BatchSeriesDescriptionRequest must expose `series_name_overrides` "
        "so admins can rename auto-detected groups before generation"
    )


def test_series_name_overrides_defaults_to_none():
    """Backwards compatible — old admin clients that don't send the
    field must still get the auto-detected behaviour."""
    from server import BatchSeriesDescriptionRequest
    r = BatchSeriesDescriptionRequest(product_skus=["SKU1"])
    assert r.series_name_overrides is None


def test_series_name_overrides_round_trip():
    """When the field IS sent, it must survive validation verbatim."""
    from server import BatchSeriesDescriptionRequest
    r = BatchSeriesDescriptionRequest(
        product_skus=["SKU1"],
        series_name_overrides={"Pietra Ligure": "La Dolce"},
    )
    assert r.series_name_overrides == {"Pietra Ligure": "La Dolce"}


def test_batch_handler_applies_overrides():
    """The generate-batch-series-descriptions handler must rename the
    series-groups dict using the override map BEFORE generation. The
    rebuilt dict must also merge groups when two source names rename
    to the same target (otherwise admin renaming two supplier series
    to one collection name would generate two duplicate descriptions)."""
    import server
    src = inspect.getsource(server.generate_batch_series_descriptions)
    # Must read the override map from the request.
    assert re.search(
        r"request_data\.series_name_overrides",
        src,
    ), (
        "Handler must read request_data.series_name_overrides "
        "to know what renames the admin wants applied"
    )
    # Must iterate the existing series_groups and produce a renamed dict.
    assert re.search(
        r"overrides\.get\(\s*k\s*,\s*k\s*\)",
        src,
    ), (
        "Handler must use `overrides.get(k, k)` so unknown keys "
        "fall through to the original auto-detected name"
    )
    # Must merge groups that rename to the same target.
    assert re.search(
        r"if\s+new_key\s+in\s+renamed:[\s\S]{0,80}renamed\[new_key\]\.extend",
        src,
    ), (
        "Handler must MERGE groups when two source names rename to "
        "the same target (extend the list, not overwrite it)"
    )

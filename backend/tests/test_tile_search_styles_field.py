"""
Regression test for the missing `styles` field in tile search
(24 May 2026 — user reported "Search don't respond" with 0 results
for "Slate effect" and "Concrete effect" even after saving those
styles via the Bulk Category Editor).

Root cause:
  `services/tile_search.SEARCH_FIELDS` was missing the `styles` array.
  The Bulk Category Editor writes Style values as slugs into
  `tile.styles = ['slate-effect', 'concrete-effect', ...]`. Without
  `styles` in the searchable fields, a customer search for "slate
  effect" tokenised into ['slate', 'effect'] — neither token had a
  field to match against on style-tagged tiles → 0 results.

Contract pinned:
  1. `styles` (array) is in SEARCH_FIELDS.
  2. Common aliases `style`, `attributes.style`, `attributes.styles`
     are also covered so admins who saved style values to the
     attributes sub-doc (legacy / future bulk-editor changes) still
     surface in search.
  3. Top-level mirrors of attribute fields (`color`, `finish`,
     `material`, `suitability`) are searchable too — supplier-sync
     writes BOTH the nested `attributes.color` AND the top-level
     `color`, so missing the top-level was a silent recall gap.
  4. Long-form copy (`description`, `short_description`) is searchable.
  5. Singular legacy fields (`sub_category`, `main_category`) are
     covered for older imported rows.
"""
from __future__ import annotations

from services.tile_search import SEARCH_FIELDS, build_tile_search_query


def test_search_fields_includes_styles_array():
    """Without this, the Bulk Category Editor's primary write path
    (styles=['slate-effect', ...]) is invisible to storefront search."""
    assert "styles" in SEARCH_FIELDS, (
        "`styles` must be in SEARCH_FIELDS so tiles tagged with "
        "'slate-effect' / 'concrete-effect' / 'stone-effect' surface "
        "when customers search for those style names"
    )


def test_search_fields_includes_style_aliases():
    """Defence in depth — admins or supplier-sync can write to a few
    alternate locations for the same data."""
    for alias in ("style", "attributes.style", "attributes.styles"):
        assert alias in SEARCH_FIELDS, (
            f"`{alias}` must be searchable so storefront search doesn't "
            f"miss tiles depending on which write path tagged them"
        )


def test_search_fields_includes_top_level_attribute_mirrors():
    """The supplier-sync writes both `attributes.color` and the top-
    level `color` for compatibility. Searching only the nested copy
    missed rows where only the top-level survived (legacy imports)."""
    for field in ("color", "finish", "material", "suitability"):
        assert field in SEARCH_FIELDS, (
            f"Top-level `{field}` must be searchable — supplier-sync "
            f"writes here as well as attributes.{field}"
        )


def test_search_fields_includes_long_form_copy():
    """Customers type natural descriptive language ('polished
    marble look', 'rustic terracotta'). Without description/copy
    fields, the search would only match short SKU-like names."""
    assert "description" in SEARCH_FIELDS
    assert "short_description" in SEARCH_FIELDS


def test_slate_effect_search_query_targets_styles_field():
    """End-to-end: the constructed Mongo query for 'slate effect'
    must include a regex clause against the `styles` field. Without
    this assertion the contract could silently regress."""
    q = build_tile_search_query("slate effect")
    assert q is not None
    # Walk the query tree and confirm `styles` regex appears somewhere
    import json
    serialised = json.dumps(q, default=str)
    assert '"styles"' in serialised, (
        "Built query must include a `styles` field clause — without it "
        "the Bulk-Editor-tagged tiles cannot be reached by search"
    )
    assert "slate" in serialised.lower(), (
        "Token 'slate' must appear in the constructed regex"
    )
    assert "effect" in serialised.lower(), (
        "Token 'effect' must appear in the constructed regex"
    )

"""
SEO Auto-Fixer — unit tests
Locks in the title/description/JSON-LD generators that turn
self-crawler findings into live SEO repairs.
"""
from __future__ import annotations

import pytest

from services.seo_auto_fixer import (
    _description_for_path,
    _jsonld_for_path,
    _title_for_path,
    _titlecase_slug,
)


def test_titlecase_slug_basic():
    assert _titlecase_slug("brilliant-white") == "Brilliant White"


def test_titlecase_slug_numeric_token_preserved():
    """`60x60cm` should stay `60x60cm`, not `60X60Cm`."""
    assert _titlecase_slug("brilliant-white-60x60cm") == "Brilliant White 60x60cm"


def test_titlecase_slug_empty():
    assert _titlecase_slug("") == ""
    assert _titlecase_slug(None) == ""


def test_titlecase_slug_underscores():
    assert _titlecase_slug("dark_onyx_polish") == "Dark Onyx Polish"


def test_title_for_collection_path():
    assert _title_for_path("/shop/collection/Hartley") == "Hartley Collection · Tile Station"


def test_title_for_collection_with_url_encoded_path():
    """URL-decoded slug should NOT happen here — the route receives a
    path that may still have %20. We titlecase the literal slug; the
    server-seo.js layer handles decoding upstream."""
    res = _title_for_path("/shop/collection/Brilliant-White-60x60cm")
    assert "Brilliant White 60x60cm Collection · Tile Station" == res


def test_title_for_product_path():
    res = _title_for_path("/shop/product/marble-veneto")
    assert res == "Marble Veneto · Tile Station"


def test_title_for_product_path_legacy():
    """/shop/products/<slug> and /shop/tiles/<slug> both work."""
    assert _title_for_path("/shop/products/marble-veneto") == "Marble Veneto · Tile Station"
    assert _title_for_path("/shop/tiles/dark-onyx") == "Dark Onyx · Tile Station"


def test_title_for_info_path():
    assert _title_for_path("/shop/info/privacy") == "Privacy · Tile Station"


def test_title_for_tiles_listing():
    assert _title_for_path("/tiles/spanish-floor") == "Spanish Floor Tiles · Tile Station"


def test_title_for_root():
    assert _title_for_path("/") == "Home · Tile Station"
    assert _title_for_path("") == "Home · Tile Station"


def test_title_fallback_unknown_path():
    """Unknown paths get a slug-only title — better than the brand
    fallback, never empty."""
    res = _title_for_path("/random/unknown-page")
    assert res == "Unknown Page · Tile Station"


def test_description_collection_path():
    title = _title_for_path("/shop/collection/Hartley")
    desc = _description_for_path("/shop/collection/Hartley", title)
    assert "Hartley" in desc
    assert "free UK samples" in desc
    assert 100 <= len(desc) <= 250


def test_description_product_path():
    title = _title_for_path("/shop/product/marble-veneto")
    desc = _description_for_path("/shop/product/marble-veneto", title)
    assert "Marble Veneto" in desc
    assert "Tile Station" in desc
    assert 100 <= len(desc) <= 250


def test_description_info_path():
    title = "Privacy · Tile Station"
    desc = _description_for_path("/shop/info/privacy", title)
    assert "Privacy" in desc
    assert "Tile Station" in desc


def test_description_fallback_path():
    """Unknown path → falls back to title-derived description."""
    title = "Custom Page · Tile Station"
    desc = _description_for_path("/random/page", title)
    assert "Custom Page" in desc or "Tile Station" in desc
    assert 80 <= len(desc) <= 250


# ─── JSON-LD ─────────────────────────────────────────────────────────


def test_jsonld_for_path_shape():
    payload = _jsonld_for_path(
        "/shop/collection/Hartley",
        title="Hartley Collection · Tile Station",
        description="Test description",
    )
    assert payload["@context"] == "https://schema.org"
    assert payload["@type"] == "WebPage"
    assert payload["name"] == "Hartley Collection · Tile Station"
    assert payload["description"] == "Test description"
    assert payload["url"] == "https://www.tilestation.co.uk/shop/collection/Hartley"
    assert payload["isPartOf"]["@type"] == "WebSite"
    assert payload["publisher"]["@type"] == "Organization"
    assert payload["inLanguage"] == "en-GB"

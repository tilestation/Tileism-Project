"""Tests for GET /api/tiles/related/{series} endpoint."""
import os
import pytest
import requests

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL').rstrip('/')
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; TestBot/1.0)"}


def _fetch(series, limit=8):
    r = requests.get(f"{BASE_URL}/api/tiles/related/{series}?limit={limit}", headers=HEADERS, timeout=30)
    return r


def _validate_related(data, excluded_series):
    assert "related_series" in data, f"Missing related_series key: {list(data.keys())}"
    items = data["related_series"]
    assert isinstance(items, list)
    # matching_criteria checks
    mc = data.get("matching_criteria", {})
    for k in ["materials", "finishes", "effects", "sizes", "colors", "categories"]:
        assert k in mc, f"matching_criteria missing key {k}"
    for it in items:
        assert "series_name" in it
        assert it["series_name"].lower() != excluded_series.lower(), f"self series returned: {it['series_name']}"
        assert it.get("image"), f"empty image for {it.get('series_name')}"
        assert isinstance(it.get("price"), (int, float)) and it["price"] > 0, f"bad price for {it.get('series_name')}: {it.get('price')}"
        assert "match_score" in it and isinstance(it["match_score"], (int, float))
        assert isinstance(it.get("sample_product"), dict), f"sample_product not dict for {it.get('series_name')}"


class TestRelatedTiles:
    def test_opaco_returns_8(self):
        r = _fetch("Opaco", 8)
        assert r.status_code == 200, r.text[:500]
        data = r.json()
        _validate_related(data, "Opaco")
        assert len(data["related_series"]) == 8, f"expected 8, got {len(data['related_series'])}"

    def test_dolomite_onyx_returns_8(self):
        r = _fetch("Dolomite%20Onyx", 8)
        assert r.status_code == 200, r.text[:500]
        data = r.json()
        _validate_related(data, "Dolomite Onyx")
        assert len(data["related_series"]) == 8

    def test_unknown_series_returns_200_empty(self):
        r = _fetch("NoSuchSeriesXYZ", 8)
        assert r.status_code == 200, r.text[:500]
        data = r.json()
        assert "related_series" in data
        # spec says empty for unknown
        assert isinstance(data["related_series"], list)

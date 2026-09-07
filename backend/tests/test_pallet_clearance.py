"""Tests for pallet_only + clearance features (bulk-tier-update, tiles serialization)."""
import os
import requests
import pytest

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://feature-verification-7.preview.emergentagent.com").rstrip("/")
HEADERS = {"User-Agent": "Mozilla/5.0 (pytest)"}
SKU = "LP-1132"
SUPPLIER = "LEPORCE"


def _get_lp1132(preview: bool = True):
    # preview=1 bypasses the 60s in-memory cache so we see fresh writes.
    url = f"{BASE_URL}/api/tiles/collection/Dolomite%20Onyx?limit=50"
    if preview:
        url += "&preview=1"
    r = requests.get(url, headers=HEADERS, timeout=30)
    assert r.status_code == 200, r.text
    for p in r.json().get("products", []):
        if p.get("sku") == SKU:
            return p
    pytest.fail("LP-1132 not found in Dolomite Onyx collection")


def _bulk_tier_update(payload):
    r = requests.put(
        f"{BASE_URL}/api/supplier-sync/products/bulk-tier-update",
        json=payload,
        headers={**HEADERS, "Content-Type": "application/json"},
        timeout=30,
    )
    return r


def test_initial_fixture_state():
    p = _get_lp1132()
    assert p.get("pallet_only") is True
    assert "Clearance" in (p.get("labels") or [])


def test_bulk_tier_update_pallet_only_false_then_true():
    base = {
        "products": [{"sku": SKU, "supplier": SUPPLIER}],
        "pallet_enabled": True,
        "pallet_price": 25,
        "half_pallet_price": 27,
        "m2_per_pallet": 40,
        "m2_per_half_pallet": 20,
    }
    # pallet_only false
    r = _bulk_tier_update({**base, "pallet_only": False})
    assert r.status_code == 200, r.text
    assert _get_lp1132().get("pallet_only") is False

    # pallet_only true
    r = _bulk_tier_update({**base, "pallet_only": True})
    assert r.status_code == 200, r.text
    assert _get_lp1132().get("pallet_only") is True


def test_pallet_enabled_false_forces_pallet_only_false():
    r = _bulk_tier_update({
        "products": [{"sku": SKU, "supplier": SUPPLIER}],
        "pallet_enabled": False,
        "pallet_only": True,  # should be forced False
    })
    assert r.status_code == 200, r.text
    p = _get_lp1132()
    assert p.get("pallet_only") is False

    # Restore fixture
    r = _bulk_tier_update({
        "products": [{"sku": SKU, "supplier": SUPPLIER}],
        "pallet_enabled": True,
        "pallet_price": 25,
        "half_pallet_price": 27,
        "m2_per_pallet": 40,
        "m2_per_half_pallet": 20,
        "pallet_only": True,
    })
    assert r.status_code == 200, r.text
    p = _get_lp1132()
    assert p.get("pallet_only") is True


def test_final_state_restored():
    p = _get_lp1132()
    assert p.get("pallet_only") is True
    assert "Clearance" in (p.get("labels") or [])

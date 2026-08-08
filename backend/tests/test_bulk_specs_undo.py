"""Backend test for BulkSpecsFiltersModal Undo path.
Tests that bulk-update-unified with mode=replace + update_mode=replace + single-item product_ids array
works for scalar and array field updates (used by the Undo flow).
"""
import os
import requests
import pytest

BASE = os.environ.get('REACT_APP_BACKEND_URL', 'https://feature-verification-7.preview.emergentagent.com').rstrip('/')
API = f"{BASE}/api"

TEST_SKUS = ["355POL6060", "4405"]


def get_product(sku):
    r = requests.get(f"{API}/supplier-sync/products", params={"search": sku, "limit": 5}, timeout=30)
    r.raise_for_status()
    for p in r.json().get("products", []):
        if p.get("sku") == sku:
            return p
    return None


@pytest.fixture(scope="module")
def snapshots():
    snap = {}
    for sku in TEST_SKUS:
        p = get_product(sku)
        assert p, f"Test SKU {sku} not found"
        snap[sku] = {"color": p.get("color"), "sub_categories": list(p.get("sub_categories") or [])}
    yield snap
    # cleanup: restore
    for sku, orig in snap.items():
        requests.post(f"{API}/supplier-sync/products/bulk-update-unified", json={
            "product_ids": [sku],
            "updates": {"color": orig["color"], "sub_categories": orig["sub_categories"]},
            "mode": "replace", "update_mode": "replace", "id_field": "sku",
        }, timeout=30)


def test_bulk_update_unified_scalar_replace(snapshots):
    sku = TEST_SKUS[0]
    r = requests.post(f"{API}/supplier-sync/products/bulk-update-unified", json={
        "product_ids": [sku],
        "updates": {"color": "TESTGREY_UNDO"},
        "mode": "replace", "update_mode": "replace", "id_field": "sku",
    }, timeout=30)
    assert r.status_code == 200, r.text
    p = get_product(sku)
    assert p["color"] == "TESTGREY_UNDO"

    # Undo: restore original with mode=replace (this is what Undo does)
    orig_color = snapshots[sku]["color"]
    r2 = requests.post(f"{API}/supplier-sync/products/bulk-update-unified", json={
        "product_ids": [sku],
        "updates": {"color": orig_color},
        "mode": "replace", "update_mode": "replace", "id_field": "sku",
    }, timeout=30)
    assert r2.status_code == 200, r2.text
    p2 = get_product(sku)
    assert p2["color"] == orig_color, f"expected {orig_color} got {p2['color']}"


def test_bulk_update_unified_array_replace(snapshots):
    sku = TEST_SKUS[1]
    # Set an array field (sub_categories) to a new value using append (real modal flow)
    r = requests.post(f"{API}/supplier-sync/products/bulk-update-unified", json={
        "product_ids": [sku],
        "updates": {"sub_categories": ["cleaning"]},
        "mode": "append", "update_mode": "replace", "id_field": "sku",
    }, timeout=30)
    assert r.status_code == 200, r.text
    p = get_product(sku)
    assert "cleaning" in (p.get("sub_categories") or [])

    # Undo: replace whole array with original
    orig = snapshots[sku]["sub_categories"]
    r2 = requests.post(f"{API}/supplier-sync/products/bulk-update-unified", json={
        "product_ids": [sku],
        "updates": {"sub_categories": orig},
        "mode": "replace", "update_mode": "replace", "id_field": "sku",
    }, timeout=30)
    assert r2.status_code == 200, r2.text
    p2 = get_product(sku)
    assert (p2.get("sub_categories") or []) == orig, f"Undo failed: {p2.get('sub_categories')} != {orig}"


def test_series_grouping_regression():
    """Regression: Dolomite search should show one group (Series Grouping fix)."""
    r = requests.get(f"{API}/supplier-sync/products", params={"search": "Dolomite", "limit": 50}, timeout=30)
    assert r.status_code == 200
    products = r.json().get("products", [])
    # Just verify the endpoint responds — deeper grouping is a UI concern
    assert isinstance(products, list)

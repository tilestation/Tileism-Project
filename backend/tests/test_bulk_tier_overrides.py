"""
Backend regression + new-schema test for /api/supplier-sync/products/bulk-tier-update.

Covers 3 spec items from iteration 208:
 - LEGACY: payload with only supplier/sku (no per-product override keys) still applies top-level defaults to every row.
 - NEW: per-product override keys (trade_discount / credit_back_rate / disabled) on a single row WIN for that row only.
 - CLEANUP: restore original values on the touched products at end so DB is left clean.
"""
import os
import pytest
import requests

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL').rstrip('/')
API = f"{BASE_URL}/api/supplier-sync"


def _get_product(supplier: str, sku: str):
    r = requests.get(f"{API}/products", params={"supplier": supplier, "search": sku, "limit": 50}, timeout=30)
    assert r.status_code == 200, r.text
    for p in r.json().get('products', []):
        if p.get('sku') == sku or p.get('supplier_code') == sku:
            return p
    return None


@pytest.fixture(scope="module")
def sample_products():
    """Fetch 3 real products to run the round-trip against. Skip if <3 exist."""
    r = requests.get(f"{API}/products", params={"limit": 50}, timeout=30)
    assert r.status_code == 200
    products = r.json().get('products', [])
    picked = [p for p in products if p.get('supplier') and (p.get('sku') or p.get('supplier_code'))][:3]
    if len(picked) < 3:
        pytest.skip("Not enough supplier_products to run bulk-tier-update tests")
    snapshots = []
    for p in picked:
        snapshots.append({
            'supplier': p['supplier'],
            'sku': p.get('sku') or p.get('supplier_code'),
            'orig_trade_discount': p.get('trade_discount'),
            'orig_credit_back_rate': p.get('credit_back_rate'),
            'orig_tier_pricing_disabled': p.get('tier_pricing_disabled', False),
            'orig_has_custom_tier_pricing': p.get('has_custom_tier_pricing', False),
        })
    yield snapshots

    # Teardown — restore originals row-by-row using per-product overrides
    restore_payload = {
        "products": [
            {
                "supplier": s['supplier'],
                "sku": s['sku'],
                "trade_discount": s['orig_trade_discount'] if s['orig_trade_discount'] is not None else 0,
                "credit_back_rate": s['orig_credit_back_rate'] if s['orig_credit_back_rate'] is not None else 0,
                "disabled": bool(s['orig_tier_pricing_disabled']),
            } for s in snapshots
        ],
    }
    requests.put(f"{API}/products/bulk-tier-update", json=restore_payload, timeout=30)


def test_legacy_payload_no_overrides_applies_defaults(sample_products):
    """Regression: legacy payload (supplier+sku only) must still apply top-level defaults to every product."""
    payload = {
        "products": [{"supplier": s['supplier'], "sku": s['sku']} for s in sample_products],
        "tier_thresholds": [10, 50, 100],
        "tier_discounts": [2, 5, 10],
        "trade_discount": 3,
        "credit_back_rate": 1,
        "disabled": False,
    }
    r = requests.put(f"{API}/products/bulk-tier-update", json=payload, timeout=30)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data.get('success') is True
    assert data.get('updated_count', 0) >= 1  # at least some products modified

    # Every product should now carry trade_discount=3
    for s in sample_products:
        p = _get_product(s['supplier'], s['sku'])
        assert p is not None, f"Product {s['supplier']}/{s['sku']} not found"
        assert p.get('trade_discount') == 3, f"Expected trade_discount=3 got {p.get('trade_discount')} for {s['sku']}"
        assert p.get('credit_back_rate') == 1
        assert p.get('tier_pricing_disabled') is False


def test_per_product_override_wins(sample_products):
    """New schema: row 0 carries trade_discount=10 + disabled=True → wins over top-level defaults (5% / False)."""
    row0 = sample_products[0]
    payload = {
        "products": [
            # Row 0 has OVERRIDES
            {
                "supplier": row0['supplier'],
                "sku": row0['sku'],
                "trade_discount": 10,
                "disabled": True,
            },
            # Rows 1..N inherit top-level defaults (no override keys)
            *[{"supplier": s['supplier'], "sku": s['sku']} for s in sample_products[1:]],
        ],
        "tier_thresholds": [10, 50, 100],
        "tier_discounts": [2, 5, 10],
        "trade_discount": 5,
        "credit_back_rate": 2,
        "disabled": False,
    }
    r = requests.put(f"{API}/products/bulk-tier-update", json=payload, timeout=30)
    assert r.status_code == 200, r.text
    assert r.json().get('success') is True

    # Row 0 must show OVERRIDE values
    p0 = _get_product(row0['supplier'], row0['sku'])
    assert p0 is not None
    assert p0.get('trade_discount') == 10, f"row0 trade_discount should be OVERRIDDEN to 10, got {p0.get('trade_discount')}"
    assert p0.get('tier_pricing_disabled') is True, "row0 should be tier-disabled via override"

    # Rows 1..N must show TOP-LEVEL default (5, not 10 and not disabled)
    for s in sample_products[1:]:
        p = _get_product(s['supplier'], s['sku'])
        assert p is not None
        assert p.get('trade_discount') == 5, f"Non-override row {s['sku']} should inherit 5, got {p.get('trade_discount')}"
        assert p.get('tier_pricing_disabled') is False
        assert p.get('credit_back_rate') == 2


def test_partial_override_credit_only(sample_products):
    """Row-level credit_back_rate override wins even without trade_discount override."""
    row0 = sample_products[0]
    payload = {
        "products": [
            {
                "supplier": row0['supplier'],
                "sku": row0['sku'],
                "credit_back_rate": 7.5,
            },
            *[{"supplier": s['supplier'], "sku": s['sku']} for s in sample_products[1:]],
        ],
        "trade_discount": 4,
        "credit_back_rate": 1.5,
        "disabled": False,
    }
    r = requests.put(f"{API}/products/bulk-tier-update", json=payload, timeout=30)
    assert r.status_code == 200, r.text

    p0 = _get_product(row0['supplier'], row0['sku'])
    assert p0.get('credit_back_rate') == 7.5, f"credit override lost, got {p0.get('credit_back_rate')}"
    assert p0.get('trade_discount') == 4  # no override → inherits top-level

    p1 = _get_product(sample_products[1]['supplier'], sample_products[1]['sku'])
    assert p1.get('credit_back_rate') == 1.5

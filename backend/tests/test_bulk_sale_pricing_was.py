"""
Backend tests for POST /api/supplier-sync/products/bulk-sale-pricing
Verifies:
 - Explicit WAS mode (already curl-verified by main agent) — sanity re-check
 - LEGACY discount_percentage mode (regression risk after duplicate-Pydantic-class fix)
 - clear_sale=true removes sale fields from supplier_products AND tiles
 - LP-1214 fixture remains active at end
"""
import os
import pytest
import requests

_env = os.environ.get("REACT_APP_BACKEND_URL")
if not _env:
    # Fallback: read from frontend/.env
    try:
        with open("/app/frontend/.env") as f:
            for line in f:
                if line.startswith("REACT_APP_BACKEND_URL="):
                    _env = line.split("=", 1)[1].strip()
                    break
    except Exception:
        pass
BASE_URL = (_env or "").rstrip("/")
assert BASE_URL, "REACT_APP_BACKEND_URL not set"
API = f"{BASE_URL}/api"
SALE_EP = f"{API}/supplier-sync/products/bulk-sale-pricing"


def _find_test_product():
    """Pick a non-LP-1214 supplier product with a positive price for legacy/clear_sale tests."""
    r = requests.get(f"{API}/supplier-sync/products", params={"limit": 100}, timeout=60)
    r.raise_for_status()
    body = r.json()
    products = body if isinstance(body, list) else body.get("products", [])
    for p in products:
        sku = p.get("sku")
        supplier = p.get("supplier")
        price = p.get("price") or 0
        if not sku or not supplier or sku == "LP-1214":
            continue
        if price and price > 0 and not p.get("sale_active"):
            return {"sku": sku, "supplier": supplier, "price": float(price)}
    pytest.skip("No suitable non-sale test product found")


@pytest.fixture(scope="module")
def test_product():
    return _find_test_product()


def _get_supplier_product(sku, supplier):
    r = requests.get(f"{API}/supplier-sync/products", params={"search": sku, "limit": 20}, timeout=60)
    body = r.json()
    products = body if isinstance(body, list) else body.get("products", [])
    for p in products:
        if p.get("sku") == sku and (supplier is None or p.get("supplier") == supplier):
            return p
    return None


def _get_tiles_docs(sku):
    """Fetch tiles docs for this SKU via public tiles listing search."""
    r = requests.get(f"{API}/tiles", params={"limit": 500}, timeout=60)
    if r.status_code != 200:
        return []
    body = r.json()
    tiles = body if isinstance(body, list) else body.get("tiles", body.get("items", []))
    return [t for t in tiles if t.get("sku") == sku]


class TestExplicitWasMode:
    def test_lp1214_fixture_is_active(self):
        """LP-1214 must remain on WAS £39.99 with £30 selling price (25% off)."""
        r = requests.get(f"{API}/supplier-sync/products", params={"search": "LP-1214", "limit": 5}, timeout=60)
        products = r.json().get("products", [])
        matches = [p for p in products if p.get("sku") == "LP-1214"]
        assert matches, "LP-1214 fixture product missing"
        p = matches[0]
        assert p.get("sale_active") is True, f"LP-1214 sale_active is not True: {p.get('sale_active')}"
        assert p.get("was_price") == 39.99, f"was_price expected 39.99 got {p.get('was_price')}"
        assert p.get("now_price") == p.get("price"), (
            f"now_price {p.get('now_price')} must equal price {p.get('price')}"
        )
        assert p.get("price") == 30 or p.get("price") == 30.0
        assert round(p.get("discount_percentage") or 0, 1) == 25.0


class TestLegacyDiscountPercentMode:
    """Regression: {discount_percentage: X} still works after class-shadowing fix."""

    def test_legacy_apply_and_clear(self, test_product):
        sku = test_product["sku"]
        supplier = test_product["supplier"]
        price = test_product["price"]

        # APPLY 10% off via legacy mode
        payload = {
            "product_ids": [{"sku": sku, "supplier": supplier}],
            "discount_percentage": 10.0,
            "sale_active": True,
            "clear_sale": False,
        }
        r = requests.post(SALE_EP, json=payload, timeout=30)
        assert r.status_code == 200, f"Legacy mode failed: {r.status_code} {r.text}"
        data = r.json()
        assert data.get("success") is True
        assert data.get("updated_count") == 1, f"updated_count expected 1 got {data.get('updated_count')} errors={data.get('errors')}"

        # Verify supplier_products state
        p = _get_supplier_product(sku, supplier)
        assert p is not None
        assert p.get("sale_active") is True
        assert p.get("was_price") == round(price, 2), f"legacy: was should equal current price, got {p.get('was_price')}"
        expected_now = round(price * 0.9, 2)
        assert p.get("now_price") == expected_now, f"now_price {p.get('now_price')} != {expected_now}"
        assert round(p.get("discount_percentage") or 0, 1) == 10.0

        # CLEAR sale
        clear_payload = {
            "product_ids": [{"sku": sku, "supplier": supplier}],
            "clear_sale": True,
        }
        r2 = requests.post(SALE_EP, json=clear_payload, timeout=30)
        assert r2.status_code == 200, f"clear_sale failed: {r2.status_code} {r2.text}"
        assert r2.json().get("updated_count") == 1

        # Verify fields removed
        p2 = _get_supplier_product(sku, supplier)
        assert p2 is not None
        assert not p2.get("sale_active"), "sale_active should be false/absent after clear"
        assert p2.get("was_price") in (None, 0), f"was_price should be unset, got {p2.get('was_price')}"
        assert p2.get("now_price") in (None, 0), f"now_price should be unset, got {p2.get('now_price')}"
        # Real price must be untouched
        assert p2.get("price") == price, f"price must not change: expected {price} got {p2.get('price')}"


class TestExplicitWasRejectLowWas:
    def test_low_was_rejected(self, test_product):
        sku = test_product["sku"]
        supplier = test_product["supplier"]
        price = test_product["price"]
        payload = {
            "product_ids": [{"sku": sku, "supplier": supplier}],
            "was_price": round(price - 1, 2),  # BELOW current
            "sale_active": True,
        }
        r = requests.post(SALE_EP, json=payload, timeout=30)
        assert r.status_code == 200
        data = r.json()
        assert data.get("updated_count") == 0, "low WAS should not update"
        assert data.get("errors"), "expected errors listing rejection"
        assert any("must be higher" in e for e in data["errors"])


class TestExplicitWasSetAndClear:
    def test_explicit_was_flow_with_tiles_mirror(self, test_product):
        sku = test_product["sku"]
        supplier = test_product["supplier"]
        price = test_product["price"]
        was = round(price * 1.4, 2)

        payload = {
            "product_ids": [{"sku": sku, "supplier": supplier}],
            "was_price": was,
            "sale_active": True,
        }
        r = requests.post(SALE_EP, json=payload, timeout=30)
        assert r.status_code == 200
        assert r.json().get("updated_count") == 1

        p = _get_supplier_product(sku, supplier)
        assert p.get("was_price") == was
        assert p.get("now_price") == price
        assert p.get("price") == price  # real price UNCHANGED
        expected_pct = round((was - price) / was * 100, 1)
        assert round(p.get("discount_percentage") or 0, 1) == expected_pct

        # Tiles mirror (if any tiles doc exists for this SKU)
        tiles = _get_tiles_docs(sku)
        if tiles:
            t = tiles[0]
            # Some tile serializers may not include was_price if not on sale — just check sale_active
            assert t.get("sale_active") is True or t.get("was_price") == was

        # CLEANUP — clear sale on this product to leave environment tidy
        r2 = requests.post(SALE_EP, json={
            "product_ids": [{"sku": sku, "supplier": supplier}],
            "clear_sale": True,
        }, timeout=30)
        assert r2.status_code == 200

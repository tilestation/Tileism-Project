"""Regression tests: per-product trade discount (fixed £ / percent), unit products,
credit back rate exposure, and guest checkout delivery zone maths.

Covers review request iteration for TRADE PRICING + UNIT-PRODUCT display changes.
"""
import os

import pytest
import requests
from dotenv import dotenv_values

frontend_env = dotenv_values("/app/frontend/.env")
base_url = os.environ.get("REACT_APP_BACKEND_URL") or frontend_env.get("REACT_APP_BACKEND_URL")
if not base_url:
    raise RuntimeError("REACT_APP_BACKEND_URL missing")
BASE_URL = base_url.rstrip("/")

SKU = "ULT-EC"
SERIES = "Ultra Tile Cleaning & Maintenance"


@pytest.fixture(scope="module")
def client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def ult_ec(client):
    r = client.get(f"{BASE_URL}/api/tiles/collection/{requests.utils.quote(SERIES)}", timeout=60)
    assert r.status_code == 200, r.text[:300]
    data = r.json()
    prod = next((p for p in data.get("products", []) if p.get("sku") == SKU), None)
    assert prod is not None, f"fixture product {SKU} missing from collection"
    return prod


# ---------------- serialize_tile_for_shop fields ----------------
class TestShopSerializer:
    def test_unit_product_fields_present(self, ult_ec):
        assert ult_ec["price"] == 13.10
        assert ult_ec["trade_discount"] == 1.11
        assert ult_ec["trade_discount_type"] == "fixed"
        assert ult_ec["credit_back_rate"] == 2
        assert ult_ec["pallet_qty_unit"] == "unit"
        assert ult_ec["pallet_price"] == 11.50
        assert ult_ec["half_pallet_price"] == 12.25
        assert ult_ec["m2_per_pallet"] == 60
        assert ult_ec["m2_per_half_pallet"] == 30
        assert ult_ec["delivery_charge_required"] is False
        assert ult_ec["display_name"] == "UT EASY CLEAN"

    def test_no_mongo_object_id_leaked(self, ult_ec):
        assert "_id" not in ult_ec


# ---------------- /api/tiles/pricing/calculate ----------------
class TestPricingCalculate:
    def test_fixed_trade_discount_resolved_from_product(self, client):
        """Per-product fixed £1.11 must be applied to trade tier table."""
        r = client.get(
            f"{BASE_URL}/api/tiles/pricing/calculate",
            params={"base_price": 13.10, "quantity": 1, "is_trade": "true", "product_sku": SKU},
            timeout=60,
        )
        assert r.status_code == 200, r.text[:300]
        d = r.json()
        assert d["trade_discount"] == 1.11
        assert d["trade_discount_type"] == "fixed"
        assert d["credit_back_rate"] == 2
        # tier 1 trade price = 13.10 - 1.11 = 11.99 (inc VAT); NOT 13.10*0.95=12.44
        assert d["trade_tiers"][0]["price_per_m2"] == pytest.approx(11.99, abs=0.01)
        assert d["trade_current_price_per_m2"] == pytest.approx(11.99, abs=0.01)
        # ex-VAT equivalent shown on PDP
        assert round(d["trade_tiers"][0]["price_per_m2"] / 1.2, 2) == 9.99

    def test_no_blanket_default_trade_discount(self, client):
        """Trade user on a product WITHOUT a trade_discount gets list price (default 0%)."""
        r = client.get(
            f"{BASE_URL}/api/tiles/pricing/calculate",
            params={"base_price": 100, "quantity": 1, "is_trade": "true"},
            timeout=60,
        )
        assert r.status_code == 200, r.text[:300]
        d = r.json()
        assert d["trade_tiers"][0]["price_per_m2"] == pytest.approx(100.0, abs=0.01), (
            "blanket default trade discount still applied"
        )

    def test_explicit_percent_trade_discount(self, client):
        r = client.get(
            f"{BASE_URL}/api/tiles/pricing/calculate",
            params={
                "base_price": 100,
                "quantity": 1,
                "is_trade": "true",
                "trade_discount": 10,
                "trade_discount_type": "percent",
            },
            timeout=60,
        )
        assert r.status_code == 200
        assert r.json()["trade_tiers"][0]["price_per_m2"] == pytest.approx(90.0, abs=0.01)

    def test_query_param_overrides_product_value(self, client):
        r = client.get(
            f"{BASE_URL}/api/tiles/pricing/calculate",
            params={
                "base_price": 13.10,
                "quantity": 1,
                "is_trade": "true",
                "product_sku": SKU,
                "trade_discount": 2.10,
                "trade_discount_type": "fixed",
            },
            timeout=60,
        )
        assert r.status_code == 200
        assert r.json()["trade_tiers"][0]["price_per_m2"] == pytest.approx(11.00, abs=0.01)

    def test_guest_gets_no_trade_prices(self, client):
        r = client.get(
            f"{BASE_URL}/api/tiles/pricing/calculate",
            params={"base_price": 13.10, "quantity": 1, "is_trade": "false", "product_sku": SKU},
            timeout=60,
        )
        assert r.status_code == 200
        d = r.json()
        assert d["current_price_per_m2"] == pytest.approx(13.10, abs=0.01)
        assert d["total_price"] == pytest.approx(13.10, abs=0.01)


# ---------------- guest checkout delivery maths ----------------
def _mongo_db():
    from pymongo import MongoClient

    cl = MongoClient(os.environ["MONGO_URL"])
    return cl, cl[os.environ["DB_NAME"]]


def _fetch_order(order_id):
    cl, db = _mongo_db()
    try:
        return db.shop_orders.find_one({"$or": [{"order_id": order_id}, {"id": order_id}]}, {"_id": 0})
    finally:
        cl.close()


class TestGuestCheckoutDelivery:
    def test_tn_zone_fee_and_no_congestion(self, client):
        payload = {
            "items": [{"product_id": "TEST_regular_item", "name": "TEST_item", "price": 100, "quantity": 1}],
            "customer": {
                "email": "TEST_qa_trade@example.test",
                "firstName": "TEST",
                "lastName": "QA",
                "phone": "07000000000",
            },
            "delivery": {
                "method": "delivery",
                "postcode": "TN9 1AA",
                "address1": "1 Test St",
                "city": "Tonbridge",
            },
            "payment": {"method": "bank_transfer"},
            "subtotal": 100,
            "total": 100,
        }
        r = client.post(f"{BASE_URL}/api/shop/guest-checkout", json=payload, timeout=90)
        assert r.status_code in (200, 201), r.text[:400]
        d = r.json()
        TestGuestCheckoutDelivery.order_id = d.get("order_id") or d.get("id")
        assert d.get("total") == pytest.approx(129.99, abs=0.01), d
        # verify persisted breakdown in DB
        doc = _fetch_order(TestGuestCheckoutDelivery.order_id)
        assert doc is not None, "order not persisted"
        assert float(doc.get("delivery_fee") or 0) == pytest.approx(29.99, abs=0.01), doc.get("delivery_fee")
        assert float(doc.get("congestion_charge") or 0) == 0
        assert float(doc.get("subtotal") or 0) == pytest.approx(100.0, abs=0.01)


def test_zz_cleanup_test_order():
    """Remove the guest test order created above."""
    oid = getattr(TestGuestCheckoutDelivery, "order_id", None)
    if not oid:
        pytest.skip("no test order created")
    cl, db = _mongo_db()
    try:
        res = db.shop_orders.delete_many({"$or": [{"order_id": oid}, {"id": oid}]})
    finally:
        cl.close()
    assert res.deleted_count >= 1
    assert _fetch_order(oid) is None

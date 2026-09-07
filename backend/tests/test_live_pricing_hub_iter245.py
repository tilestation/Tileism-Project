"""
Tests for iteration 245 - Live Pricing Hub + Sale/Clearance mirroring.
BACKEND 1: GET /api/supplier-sync/products/live-pricing + POST push-live-pricing
BACKEND 2: bulk-sale-pricing (mirror to tiles + Sale label mgmt + errors)
BACKEND 3: bulk-labels (mirror to tiles)
BACKEND 4: quick-update (mirror + unset was_price/discount when clearing sale)
"""
import os
import time
import pytest
import requests
from pymongo import MongoClient

from dotenv import load_dotenv
load_dotenv("/app/frontend/.env")
load_dotenv("/app/backend/.env")
BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017").strip('"')
DB_NAME = os.environ.get("DB_NAME", "tile_station").strip('"')

SKU_A = "LP-1231"   # test target A
SKU_B = "LP-1631"   # test target B
SKU_MISS = "LP-1631"  # for live-pricing bad SKU test we'll add NOPE-xxxx
SUPPLIER = "LEPORCE"


@pytest.fixture(scope="module")
def db():
    return MongoClient(MONGO_URL)[DB_NAME]


@pytest.fixture(scope="module")
def token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": "admin@test.com", "password": "admin123"},
                      timeout=30)
    assert r.status_code == 200, r.text
    return r.json().get("token") or r.json().get("access_token")


@pytest.fixture(scope="module")
def api(token):
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json",
                      "Authorization": f"Bearer {token}"})
    return s


@pytest.fixture(scope="module", autouse=True)
def snapshot_and_restore(db):
    """Snapshot original values, restore after all tests."""
    skus = [SKU_A, SKU_B]
    orig = {}
    for sku in skus:
        orig[sku] = {
            "sp": db.supplier_products.find_one({"sku": sku}),
            "t": db.tiles.find_one({"sku": sku}),
        }
    yield
    for sku, snap in orig.items():
        if snap["sp"]:
            db.supplier_products.replace_one({"sku": sku}, snap["sp"])
        if snap["t"]:
            db.tiles.replace_one({"sku": sku}, snap["t"])


# ---------- BACKEND 1 ----------
class TestLivePricingReport:
    def test_live_pricing_basic(self, api):
        r = api.get(f"{BASE_URL}/api/supplier-sync/products/live-pricing",
                    params={"skus": f"{SKU_A},{SKU_B},NOPE-XYZ"})
        assert r.status_code == 200, r.text
        data = r.json()
        assert "items" in data
        assert "mismatch_count" in data
        assert "not_live_count" in data
        skus_in_resp = {i["sku"] for i in data["items"]}
        assert SKU_A in skus_in_resp
        assert SKU_B in skus_in_resp
        # NOPE-XYZ should be reported as not live
        nope = next((i for i in data["items"] if i["sku"] == "NOPE-XYZ"), None)
        if nope is not None:
            assert nope.get("in_admin") is False or nope.get("live") is False

    def test_live_pricing_pallet_mismatch_and_push(self, api, db):
        # Force a stray tile pallet payload on SKU_A
        db.tiles.update_one({"sku": SKU_A}, {"$set": {
            "pallet_price": 24.99,
            "m2_per_pallet": 51.84,
        }})
        db.supplier_products.update_one({"sku": SKU_A}, {"$set": {"pallet_enabled": False}})

        r = api.get(f"{BASE_URL}/api/supplier-sync/products/live-pricing",
                    params={"skus": SKU_A})
        assert r.status_code == 200
        item = next((i for i in r.json()["items"] if i["sku"] == SKU_A), None)
        assert item is not None, r.text
        mismatches = item.get("mismatches") or []
        assert any("pallet" in str(m).lower() for m in mismatches), f"expected pallet mismatch, got: {mismatches}"
        assert (item.get("website") or {}).get("pallet_price") == 24.99

        # Push
        r2 = api.post(f"{BASE_URL}/api/supplier-sync/products/push-live-pricing",
                      json={"skus": [SKU_A]})
        assert r2.status_code == 200, r2.text
        pushed = r2.json().get("pushed", 0)
        assert pushed >= 1

        # Re-check
        r3 = api.get(f"{BASE_URL}/api/supplier-sync/products/live-pricing",
                     params={"skus": SKU_A})
        item3 = next((i for i in r3.json()["items"] if i["sku"] == SKU_A), None)
        assert not (item3.get("mismatches") or []), f"still mismatched: {item3}"
        t = db.tiles.find_one({"sku": SKU_A})
        assert not t.get("pallet_price"), f"pallet_price still on tile: {t.get('pallet_price')}"

    def test_live_pricing_sale_mismatch_push(self, api, db):
        # tile has sale on but sp has no sale
        db.tiles.update_one({"sku": SKU_B}, {"$set": {
            "was_price": 99.0, "sale_active": True
        }})
        db.supplier_products.update_one({"sku": SKU_B},
                                        {"$set": {"sale_active": False},
                                         "$unset": {"was_price": ""}})
        r = api.get(f"{BASE_URL}/api/supplier-sync/products/live-pricing",
                    params={"skus": SKU_B})
        item = next((i for i in r.json()["items"] if i["sku"] == SKU_B), None)
        mismatches = item.get("mismatches") or []
        assert any("sale" in str(m).lower() for m in mismatches), f"expected sale mismatch: {mismatches}"

        r2 = api.post(f"{BASE_URL}/api/supplier-sync/products/push-live-pricing",
                      json={"skus": [SKU_B]})
        assert r2.status_code == 200
        t = db.tiles.find_one({"sku": SKU_B})
        # After push tile should reflect draft (no sale)
        assert not t.get("sale_active"), t


# ---------- BACKEND 2 ----------
class TestBulkSalePricing:
    def test_bulk_sale_set_and_clear(self, api, db):
        # ensure baseline price
        db.supplier_products.update_one({"sku": SKU_A}, {"$set": {"list_price": 35.99, "price": 35.99}})
        db.tiles.update_one({"sku": SKU_A}, {"$set": {"price": 35.99, "room_lot_price": 35.99}})

        r = api.post(f"{BASE_URL}/api/supplier-sync/products/bulk-sale-pricing", json={
            "product_ids": [{"sku": SKU_A, "supplier": SUPPLIER}],
            "was_price": 45.99, "sale_active": True
        })
        assert r.status_code == 200, r.text
        sp = db.supplier_products.find_one({"sku": SKU_A})
        t = db.tiles.find_one({"sku": SKU_A})
        assert sp.get("was_price") == 45.99, sp
        assert sp.get("sale_active") is True
        assert 21 <= (sp.get("discount_percentage") or 0) <= 22
        assert "Sale" in (sp.get("labels") or [])
        assert t.get("was_price") == 45.99, t
        assert t.get("sale_active") is True
        assert "Sale" in (t.get("labels") or [])

        # clear
        r2 = api.post(f"{BASE_URL}/api/supplier-sync/products/bulk-sale-pricing", json={
            "product_ids": [{"sku": SKU_A, "supplier": SUPPLIER}],
            "clear_sale": True
        })
        assert r2.status_code == 200, r2.text
        sp = db.supplier_products.find_one({"sku": SKU_A})
        t = db.tiles.find_one({"sku": SKU_A})
        assert not sp.get("sale_active")
        assert not sp.get("was_price")
        assert "Sale" not in (sp.get("labels") or [])
        assert not t.get("sale_active")
        assert not t.get("was_price")
        assert "Sale" not in (t.get("labels") or [])

    def test_bulk_sale_was_lower_than_price_errors(self, api, db):
        # ensure baseline higher price
        db.supplier_products.update_one({"sku": SKU_A}, {"$set": {"list_price": 35.99, "price": 35.99}})
        r = api.post(f"{BASE_URL}/api/supplier-sync/products/bulk-sale-pricing", json={
            "product_ids": [{"sku": SKU_A, "supplier": SUPPLIER}],
            "was_price": 10.00, "sale_active": True
        })
        # Endpoint may return 200 with errors[] or 400 - accept either
        assert r.status_code in (200, 400), r.text
        body = r.json()
        errs = body.get("errors") or body.get("detail") or []
        assert errs, f"expected an error message, got {body}"
        # And nothing should have changed to a bogus sale
        sp = db.supplier_products.find_one({"sku": SKU_A})
        assert sp.get("was_price") != 10.00


# ---------- BACKEND 3 ----------
class TestBulkLabels:
    def test_add_remove_new_arrival(self, api, db):
        r = api.post(f"{BASE_URL}/api/supplier-sync/products/bulk-labels", json={
            "product_ids": [{"sku": SKU_A, "supplier": SUPPLIER}],
            "action": "add", "labels": ["New Arrival"]
        })
        assert r.status_code == 200, r.text
        sp = db.supplier_products.find_one({"sku": SKU_A})
        t = db.tiles.find_one({"sku": SKU_A})
        assert "New Arrival" in (sp.get("labels") or [])
        assert "New Arrival" in (t.get("labels") or []), t

        r2 = api.post(f"{BASE_URL}/api/supplier-sync/products/bulk-labels", json={
            "product_ids": [{"sku": SKU_A, "supplier": SUPPLIER}],
            "action": "remove", "labels": ["New Arrival"]
        })
        assert r2.status_code == 200
        sp = db.supplier_products.find_one({"sku": SKU_A})
        t = db.tiles.find_one({"sku": SKU_A})
        assert "New Arrival" not in (sp.get("labels") or [])
        assert "New Arrival" not in (t.get("labels") or [])


# ---------- BACKEND 4 ----------
class TestQuickUpdateMirror:
    def test_quick_update_sale_on_then_clear(self, api, db):
        # SET
        r = api.put(f"{BASE_URL}/api/supplier-sync/products/quick-update", json={
            "supplier": SUPPLIER, "sku": SKU_A,
            "price": 36.99, "sale_active": True, "was_price": 46.99,
            "labels": ["Clearance"]
        })
        assert r.status_code == 200, r.text
        sp = db.supplier_products.find_one({"sku": SKU_A})
        t = db.tiles.find_one({"sku": SKU_A})
        for doc, name in [(sp, "sp"), (t, "t")]:
            assert doc.get("price") == 36.99, f"{name} price {doc.get('price')}"
            assert doc.get("was_price") == 46.99, f"{name} was {doc.get('was_price')}"
            assert doc.get("sale_active") is True
            assert "Clearance" in (doc.get("labels") or [])
        assert sp.get("list_price") == 36.99
        assert sp.get("room_lot_price") == 36.99
        assert t.get("room_lot_price") == 36.99

        # CLEAR sale
        r2 = api.put(f"{BASE_URL}/api/supplier-sync/products/quick-update", json={
            "supplier": SUPPLIER, "sku": SKU_A,
            "price": 35.99, "sale_active": False, "was_price": None,
            "labels": []
        })
        assert r2.status_code == 200, r2.text
        sp = db.supplier_products.find_one({"sku": SKU_A})
        t = db.tiles.find_one({"sku": SKU_A})
        for doc, name in [(sp, "sp"), (t, "t")]:
            assert not doc.get("sale_active"), f"{name} still sale_active"
            assert not doc.get("was_price"), f"{name} still has was_price {doc.get('was_price')}"
            assert not doc.get("discount_percentage"), f"{name} still has discount_percentage"
            assert (doc.get("labels") or []) == [], f"{name} labels {doc.get('labels')}"
            assert doc.get("price") == 35.99
        assert sp.get("room_lot_price") == 35.99
        assert t.get("room_lot_price") == 35.99

"""Clearance Platform backend tests (iteration 240).

Covers:
- GET  /api/clearance/products
- POST /api/clearance/mark (on/off + auto-publish of a draft-only SKU)
- POST /api/clearance/leaflet/generate (poster/compact/invalid)
- PUT  /api/clearance/leaflet/publish + GET config + GET current.pdf
- GET  /api/tiles/collections?group=tiles&clearance=true (+ regression w/o param)
"""
import os
import time

import pytest
import requests
from dotenv import dotenv_values
from pymongo import MongoClient

frontend_env = dotenv_values("/app/frontend/.env")
base_url = os.environ.get("REACT_APP_BACKEND_URL") or frontend_env.get("REACT_APP_BACKEND_URL")
if not base_url:
    raise RuntimeError("REACT_APP_BACKEND_URL missing")
BASE_URL = base_url.rstrip("/")

backend_env = dotenv_values("/app/backend/.env")
MONGO_URL = os.environ.get("MONGO_URL") or backend_env.get("MONGO_URL")
DB_NAME = os.environ.get("DB_NAME") or backend_env.get("DB_NAME")

TEST_SKU = "TEST-CLR-1"
REAL_SKUS = ["LP-6683", "LP-6690"]


@pytest.fixture(scope="session")
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="session")
def db():
    if not MONGO_URL or not DB_NAME:
        pytest.skip("MONGO_URL/DB_NAME unavailable")
    return MongoClient(MONGO_URL)[DB_NAME]


# ---------------- GET /clearance/products ----------------
class TestClearanceProducts:
    def test_list_clearance_products(self, api):
        r = api.get(f"{BASE_URL}/api/clearance/products", timeout=60)
        assert r.status_code == 200, r.text[:400]
        data = r.json()
        assert isinstance(data.get("items"), list)
        assert data["total"] == len(data["items"])
        skus = [i["sku"] for i in data["items"]]
        for s in REAL_SKUS:
            assert s in skus, f"{s} missing from clearance hub list: {skus}"
        item = next(i for i in data["items"] if i["sku"] == REAL_SKUS[0])
        for f in ("sku", "name", "image", "price", "was_price",
                  "discount_percentage", "stock_m2", "published"):
            assert f in item, f"field {f} missing"
        assert isinstance(item["price"], (int, float)) and item["price"] > 0
        assert item["published"] is True
        assert "Dolomite" in " ".join(
            i["name"] for i in data["items"] if i["sku"] in REAL_SKUS)


# ---------------- POST /clearance/mark ----------------
class TestClearanceMark:
    def test_mark_validation_empty(self, api):
        r = api.post(f"{BASE_URL}/api/clearance/mark",
                     json={"product_ids": [], "on": True}, timeout=30)
        assert r.status_code == 400, r.text[:300]

    def test_mark_autopublishes_draft_only_sku(self, api, db):
        # seed a disposable draft that exists ONLY in supplier_products
        db.supplier_products.delete_many({"sku": TEST_SKU})
        db.tiles.delete_many({"sku": TEST_SKU})
        db.supplier_products.insert_one({
            "sku": TEST_SKU,
            "supplier": "TEST_SUPPLIER",
            "supplier_code": TEST_SKU,
            "product_name": "TEST_CLR Draft Tile",
            "our_product_name": "TEST_CLR Draft Tile",
            "list_price": 19.99,
            "was_price": 39.99,
            "size": "600x600mm",
            "product_group": "tiles",
            "stock_m2": 50,
            "pricing_unit": "m2",
            "published_to_website": False,
        })
        try:
            r = api.post(f"{BASE_URL}/api/clearance/mark",
                         json={"product_ids": [{"sku": TEST_SKU,
                                                "supplier": "TEST_SUPPLIER"}],
                               "on": True}, timeout=120)
            assert r.status_code == 200, r.text[:500]
            body = r.json()
            assert body["success"] is True
            assert body["marked"] >= 1

            sp = db.supplier_products.find_one({"sku": TEST_SKU})
            assert "Clearance" in (sp.get("labels") or []), sp.get("labels")

            tile = db.tiles.find_one({"sku": TEST_SKU})
            assert tile is not None, "auto-publish did not create a tiles doc"
            assert "Clearance" in (tile.get("labels") or []), tile.get("labels")
            assert body["auto_published"] >= 1, body

            # appears in hub list as published
            hub = api.get(f"{BASE_URL}/api/clearance/products", timeout=60).json()
            row = next((i for i in hub["items"] if i["sku"] == TEST_SKU), None)
            assert row is not None, "test SKU not in hub list"
            assert row["published"] is True
            assert row["price"] == pytest.approx(19.99, abs=0.5)

            # unmark removes label from BOTH collections
            r2 = api.post(f"{BASE_URL}/api/clearance/mark",
                          json={"product_ids": [{"sku": TEST_SKU}], "on": False},
                          timeout=60)
            assert r2.status_code == 200, r2.text[:300]
            sp2 = db.supplier_products.find_one({"sku": TEST_SKU})
            t2 = db.tiles.find_one({"sku": TEST_SKU})
            assert "Clearance" not in (sp2.get("labels") or [])
            assert "Clearance" not in ((t2 or {}).get("labels") or [])

            hub2 = api.get(f"{BASE_URL}/api/clearance/products", timeout=60).json()
            assert TEST_SKU not in [i["sku"] for i in hub2["items"]]
        finally:
            db.supplier_products.delete_many({"sku": TEST_SKU})
            db.tiles.delete_many({"sku": TEST_SKU})
            db.products.delete_many({"sku": TEST_SKU})


# ---------------- Leaflet PDF ----------------
class TestLeaflet:
    @pytest.mark.parametrize("layout", ["poster", "compact"])
    def test_generate_pdf(self, api, layout):
        r = api.post(f"{BASE_URL}/api/clearance/leaflet/generate",
                     json={"layout": layout}, timeout=120)
        assert r.status_code == 200, r.text[:300]
        assert "application/pdf" in r.headers.get("content-type", "")
        assert r.content[:4] == b"%PDF", r.content[:20]
        assert len(r.content) > 10240, f"PDF only {len(r.content)} bytes"

    def test_generate_invalid_layout(self, api):
        r = api.post(f"{BASE_URL}/api/clearance/leaflet/generate",
                     json={"layout": "bogus"}, timeout=30)
        assert r.status_code == 400, r.text[:300]

    def test_publish_config_and_current_pdf(self, api):
        try:
            r = api.put(f"{BASE_URL}/api/clearance/leaflet/publish",
                        json={"skus": [REAL_SKUS[0]], "layout": "compact"},
                        timeout=60)
            assert r.status_code == 200, r.text[:300]
            assert r.json().get("success") is True

            cfg = api.get(f"{BASE_URL}/api/clearance/leaflet/config", timeout=30)
            assert cfg.status_code == 200
            c = cfg.json()
            assert c["skus"] == [REAL_SKUS[0]], c
            assert c["layout"] == "compact"
            assert c["published_at"]

            pdf = api.get(f"{BASE_URL}/api/clearance/leaflet/current.pdf", timeout=120)
            assert pdf.status_code == 200
            assert "application/pdf" in pdf.headers.get("content-type", "")
            assert pdf.content[:4] == b"%PDF"
            assert len(pdf.content) > 10240, f"only {len(pdf.content)} bytes"
        finally:
            restore = api.put(f"{BASE_URL}/api/clearance/leaflet/publish",
                              json={"skus": REAL_SKUS, "layout": "poster"},
                              timeout=60)
            assert restore.status_code == 200
            back = api.get(f"{BASE_URL}/api/clearance/leaflet/config", timeout=30).json()
            assert back["skus"] == REAL_SKUS and back["layout"] == "poster"

    def test_publish_invalid_layout(self, api):
        r = api.put(f"{BASE_URL}/api/clearance/leaflet/publish",
                    json={"skus": REAL_SKUS, "layout": "nope"}, timeout=30)
        assert r.status_code == 400


# ---------------- Collections clearance filter ----------------
class TestCollectionsClearanceFilter:
    def test_clearance_filter(self, api):
        r = api.get(f"{BASE_URL}/api/tiles/collections",
                    params={"group": "tiles", "clearance": "true",
                            "_cb": str(int(time.time()))}, timeout=120)
        assert r.status_code == 200, r.text[:300]
        data = r.json()
        cols = data if isinstance(data, list) else data.get("collections", data.get("items", []))
        assert isinstance(cols, list)
        assert len(cols) == 1, f"expected 1 clearance collection, got {len(cols)}"
        blob = str(cols[0])
        assert "Dolomite Onyx" in blob or "dolomite-onyx" in blob, sorted(cols[0].keys())
        assert cols[0].get("product_count", 2) == 2, cols[0].get("product_count")

    def test_full_catalogue_regression(self, api):
        r = api.get(f"{BASE_URL}/api/tiles/collections",
                    params={"group": "tiles"}, timeout=120)
        assert r.status_code == 200, r.text[:300]
        data = r.json()
        cols = data if isinstance(data, list) else data.get("collections", data.get("items", []))
        assert len(cols) > 12, f"full catalogue only returned {len(cols)} collections"

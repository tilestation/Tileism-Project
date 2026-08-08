"""Test bulk series assignment - verifies 6 products (including one with
Canopy-style long unique_name) all get merged under one series."""
import os
import uuid
import pytest
import requests
from pymongo import MongoClient

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://feature-verification-7.preview.emergentagent.com").rstrip("/")
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "tile_station")

SUPPLIER = "Ultra Tile"
LONG_UNIQUE = "UT TILE CLEANER 1L - UT ProCleaner Porcelain Tile & Stone Cleaner 1L"
TARGET_SERIES = "Ultra Tile Cleaning & Maintenance"


@pytest.fixture(scope="module")
def db():
    client = MongoClient(MONGO_URL)
    return client[DB_NAME]


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": "admin@test.com", "password": "admin123"})
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    return r.json()["token"]


@pytest.fixture(scope="module")
def fixtures(db):
    # Clean prior
    db.supplier_products.delete_many({"sku": {"$regex": "^SERIES-TEST-"}})
    docs = []
    for i in range(1, 7):
        sku = f"SERIES-TEST-{i}"
        uname = LONG_UNIQUE if i == 6 else "UltrTile Easy Clean"
        docs.append({
            "id": str(uuid.uuid4()),
            "sku": sku,
            "supplier": SUPPLIER,
            "product_name": f"Cleaning & Maintenance - UltrTile Item {i}",
            "unique_name": uname,
            "series": "",
            "range_name": "",
            "price": 10.0,
            "stock": 5,
        })
    db.supplier_products.insert_many(docs)
    yield [d["sku"] for d in docs]
    db.supplier_products.delete_many({"sku": {"$regex": "^SERIES-TEST-"}})


def test_bulk_assign_updates_all_six(admin_token, fixtures, db):
    headers = {"Authorization": f"Bearer {admin_token}"}
    payload = {
        "items": [{"sku": sku, "series": TARGET_SERIES} for sku in fixtures],
        "supplier": SUPPLIER,
    }
    r = requests.post(f"{BASE_URL}/api/admin/series/bulk-assign", json=payload, headers=headers)
    assert r.status_code == 200, f"{r.status_code}: {r.text}"
    data = r.json()
    assert data.get("ok") is True
    assert data.get("updated") == 6, f"expected 6 updated, got {data.get('updated')} failed={data.get('failed')}"

    # DB verify — all three fields overwritten
    for sku in fixtures:
        doc = db.supplier_products.find_one({"sku": sku})
        assert doc is not None
        assert doc.get("series") == TARGET_SERIES, f"{sku} series mismatch: {doc.get('series')}"
        assert doc.get("range_name") == TARGET_SERIES, f"{sku} range_name mismatch"
        assert doc.get("unique_name") == TARGET_SERIES, f"{sku} unique_name mismatch: {doc.get('unique_name')}"


def test_supplier_sync_list_returns_series_and_range(admin_token, fixtures):
    headers = {"Authorization": f"Bearer {admin_token}"}
    r = requests.get(
        f"{BASE_URL}/api/supplier-sync/products",
        params={"supplier": SUPPLIER, "search": "SERIES-TEST", "limit": 50},
        headers=headers,
    )
    assert r.status_code == 200, f"{r.status_code}: {r.text[:400]}"
    body = r.json()
    products = body.get("products") or body.get("items") or (body if isinstance(body, list) else [])
    matches = [p for p in products if (p.get("sku") or "").startswith("SERIES-TEST-")]
    assert len(matches) == 6, f"expected 6 fixture products, got {len(matches)}"
    for p in matches:
        assert p.get("series") == TARGET_SERIES, f"{p.get('sku')} series={p.get('series')}"
        assert p.get("range_name") == TARGET_SERIES, f"{p.get('sku')} range_name={p.get('range_name')}"
        assert p.get("unique_name") == TARGET_SERIES, f"{p.get('sku')} unique_name={p.get('unique_name')}"

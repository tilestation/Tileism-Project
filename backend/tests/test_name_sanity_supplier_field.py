"""Product Name Sanity — independent New name / Supplier name editing (iteration 255).

Uses live SKU 355POL6060 and restores its original values + removes custom_mappings in teardown.
"""
import os
import pytest
import requests
from pymongo import MongoClient

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL').rstrip('/')
API = f"{BASE_URL}/api"
SKU = "355POL6060"
ORIG_PN = "Premium Polished Porcelain 60x60"
ORIG_SPN = "355 Polished 60x60 Grey"

_mongo = MongoClient(os.environ.get('MONGO_URL', 'mongodb://localhost:27017'))
_db = _mongo[os.environ.get('DB_NAME', 'tile_station')]


@pytest.fixture(scope="module")
def s():
    r = requests.post(f"{API}/auth/login", json={"email": "admin@test.com", "password": "admin123"}, timeout=30)
    assert r.status_code == 200
    tok = r.json().get("access_token") or r.json().get("token")
    sess = requests.Session()
    sess.headers.update({"Authorization": f"Bearer {tok}", "Content-Type": "application/json"})
    return sess


@pytest.fixture(scope="module", autouse=True)
def restore():
    snap_sp = _db.supplier_products.find_one({"sku": SKU}, {"product_name": 1, "our_product_name": 1, "display_name": 1,
                                                         "supplier_product_name": 1, "updated_at": 1, "product_name_fixed_by": 1})
    snap_t = _db.tiles.find_one({"sku": SKU}, {"name": 1, "display_name": 1, "website_name": 1, "updated_at": 1})
    yield
    _db.supplier_products.update_one({"_id": snap_sp["_id"]}, {"$set": {k: v for k, v in snap_sp.items() if k != "_id"}})
    if snap_t:
        _db.tiles.update_one({"_id": snap_t["_id"]}, {"$set": {k: v for k, v in snap_t.items() if k != "_id"}})
    _db.custom_mappings.delete_many({"sku": SKU})


def _get(s):
    r = s.get(f"{API}/supplier-sync/products", params={"search": SKU}, timeout=60)
    assert r.status_code == 200
    d = r.json()
    items = d.get("products") or d.get("items") or (d if isinstance(d, list) else [])
    m = [p for p in items if p.get("sku") == SKU]
    assert m, f"SKU not found in search: keys={list(d) if isinstance(d, dict) else 'list'}"
    return m[0]


def _apply(s, **kw):
    r = s.post(f"{API}/product-name-sanity/apply", json={"items": [{"sku": SKU, **kw}]}, timeout=60)
    assert r.status_code == 200, r.text
    return r.json()


# Reset to known baseline
def test_00_baseline(s):
    _apply(s, new_name=ORIG_PN, new_supplier_name=ORIG_SPN)
    p = _get(s)
    assert p["product_name"] == ORIG_PN
    assert p["supplier_product_name"] == ORIG_SPN


# Name-only edit must not clobber supplier name
def test_01_name_only(s):
    d = _apply(s, new_name="TEST_ NameOnly 60x60")
    assert d.get("updated") == 1
    p = _get(s)
    assert p["product_name"] == "TEST_ NameOnly 60x60"
    assert p.get("our_product_name") == "TEST_ NameOnly 60x60"
    assert p["supplier_product_name"] == ORIG_SPN


# Supplier-only edit (new_name = current product_name)
def test_02_supplier_only(s):
    _apply(s, new_name="TEST_ NameOnly 60x60", new_supplier_name="TEST_ Supplier Only")
    p = _get(s)
    assert p["product_name"] == "TEST_ NameOnly 60x60"
    assert p["supplier_product_name"] == "TEST_ Supplier Only"


# Both edited
def test_03_both(s):
    _apply(s, new_name="TEST_ Both Name", new_supplier_name="TEST_ Both Supplier")
    p = _get(s)
    assert p["product_name"] == "TEST_ Both Name"
    assert p["supplier_product_name"] == "TEST_ Both Supplier"


# custom_mappings upserted
def test_04_custom_mapping(s):
    docs = list(_db.custom_mappings.find({"sku": SKU}))
    assert len(docs) == 1, f"expected 1 mapping, got {len(docs)}"
    m = docs[0]
    assert m["custom_name"] == "TEST_ Both Name"
    assert m["supplier_product_name"] == "TEST_ Both Supplier"
    print("mapping supplier field:", repr(m.get("supplier")))


# Mapping supplier key should match a real supplier (sync looks up by supplier+sku)
def test_05_custom_mapping_supplier_not_null(s):
    m = _db.custom_mappings.find_one({"sku": SKU})
    assert m.get("supplier"), "custom_mappings.supplier is null -> sync lookup by supplier+sku will never match"


# Report supplier_name field reads stored supplier_product_name
def test_06_report_supplier_name(s):
    r = s.post(f"{API}/product-name-sanity/report-for-selection", json={"skus": [SKU]}, timeout=60)
    assert r.status_code == 200
    rows = r.json()["rows"]
    assert rows and rows[0]["supplier_name"] == "TEST_ Both Supplier"
    assert rows[0]["product_name"] == "TEST_ Both Name"


def test_07_report_get(s):
    r = s.get(f"{API}/product-name-sanity/report", params={"limit": 50}, timeout=120)
    assert r.status_code == 200
    d = r.json()
    assert "rows" in d and isinstance(d["rows"], list)
    for row in d["rows"][:50]:
        assert "supplier_name" in row and isinstance(row["supplier_name"], str)


# Validation: short name rejected
def test_08_validation(s):
    r = s.post(f"{API}/product-name-sanity/apply", json={"items": [{"sku": SKU, "new_name": "ab"}]}, timeout=30)
    assert r.status_code == 422


def test_09_not_found(s):
    r = s.post(f"{API}/product-name-sanity/apply", json={"items": [{"sku": "TEST_NOPE_SKU_X", "new_name": "Whatever name"}]}, timeout=30)
    assert r.status_code == 200
    assert r.json()["failed"][0]["reason"] == "not_found"
    assert _db.custom_mappings.count_documents({"sku": "TEST_NOPE_SKU_X"}) == 0


def test_10_unauth():
    r = requests.post(f"{API}/product-name-sanity/apply", json={"items": [{"sku": SKU, "new_name": "Whatever"}]}, timeout=30)
    assert r.status_code in (401, 403)

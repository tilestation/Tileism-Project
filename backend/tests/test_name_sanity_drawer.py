"""Name Sanity DRAWER (Supplier Products page) payloads — iteration 256.

The drawer sends `supplier: row.supplier` (from the report row = supplier || supplier_name).
~20% of supplier_products only have `supplier_name`, so /apply must match either field.
Snapshots + restores 355POL6060 and 4405 across supplier_products / tiles / products / custom_mappings.
"""
import os
import pytest
import requests
from pymongo import MongoClient

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL').rstrip('/')
API = f"{BASE_URL}/api"
SKUS = ["355POL6060", "4405"]

_db = MongoClient(os.environ.get('MONGO_URL'))[os.environ.get('DB_NAME')]
FIELDS = ["product_name", "our_product_name", "display_name", "supplier_product_name", "name",
          "website_name", "updated_at", "product_name_fixed_by"]


@pytest.fixture(scope="module")
def s():
    r = requests.post(f"{API}/auth/login", json={"email": "admin@test.com", "password": "admin123"}, timeout=30)
    assert r.status_code == 200
    sess = requests.Session()
    sess.headers.update({"Authorization": f"Bearer {r.json()['token']}", "Content-Type": "application/json"})
    return sess


@pytest.fixture(scope="module", autouse=True)
def restore():
    snaps = {}
    for col in ("supplier_products", "tiles", "products"):
        snaps[col] = list(_db[col].find({"sku": {"$in": SKUS}}, {f: 1 for f in FIELDS}))
    cm = list(_db.custom_mappings.find({"sku": {"$in": SKUS}}))
    yield
    for col, docs in snaps.items():
        for d in docs:
            present = {k: v for k, v in d.items() if k != "_id"}
            missing = {f: "" for f in FIELDS if f not in d}
            upd = {"$set": present}
            if missing:
                upd["$unset"] = missing
            _db[col].update_one({"_id": d["_id"]}, upd)
    _db.custom_mappings.delete_many({"sku": {"$in": SKUS}})
    if cm:
        _db.custom_mappings.insert_many(cm)


def _sp(sku):
    return _db.supplier_products.find_one({"sku": sku}, {"_id": 0})


def _row(s, sku):
    r = s.post(f"{API}/product-name-sanity/report-for-selection", json={"skus": [sku], "include_clean": True}, timeout=60)
    assert r.status_code == 200, r.text
    rows = [x for x in r.json()["rows"] if x["sku"] == sku]
    assert rows
    return rows[0]


# Drawer row exposes supplier from supplier_name fallback
def test_report_row_supplier_field(s):
    row = _row(s, "355POL6060")
    assert row["supplier"] == "Ceramica Impex"
    assert isinstance(row["supplier_name"], str)


# Drawer single-row save WITH supplier key (exact drawer payload) — supplier-only edit
def test_drawer_payload_supplier_only(s):
    row = _row(s, "355POL6060")
    r = s.post(f"{API}/product-name-sanity/apply", json={"items": [{
        "sku": row["sku"], "supplier": row["supplier"], "new_name": row["product_name"],
        "new_supplier_name": "TEST_DrawerSupp"}]}, timeout=60)
    assert r.status_code == 200
    d = r.json()
    assert d["failed"] == [], d
    assert d["updated"] == 1
    doc = _sp("355POL6060")
    assert doc["supplier_product_name"] == "TEST_DrawerSupp"
    assert doc["product_name"] == row["product_name"]


# Drawer 'Save all edited' bulk payload (mix: one name-only, one supplier-only)
def test_drawer_bulk_mixed(s):
    a, b = _row(s, "355POL6060"), _row(s, "4405")
    r = s.post(f"{API}/product-name-sanity/apply", json={"items": [
        {"sku": a["sku"], "supplier": a["supplier"], "new_name": "TEST Bulk Name A 60x60"},
        {"sku": b["sku"], "supplier": b["supplier"], "new_name": b["product_name"], "new_supplier_name": "TEST_Bulk Supp B"},
    ]}, timeout=60)
    assert r.status_code == 200
    d = r.json()
    assert d["updated"] == 2 and d["failed"] == [], d
    da, db_ = _sp("355POL6060"), _sp("4405")
    assert da["product_name"] == "TEST Bulk Name A 60x60"
    assert da["supplier_product_name"] == "TEST_DrawerSupp"  # unchanged from previous test
    assert db_["supplier_product_name"] == "TEST_Bulk Supp B"


# Wrong supplier still rejected (supplier scoping retained)
def test_wrong_supplier_not_found(s):
    r = s.post(f"{API}/product-name-sanity/apply", json={"items": [{
        "sku": "355POL6060", "supplier": "TEST_NoSuchSupplier", "new_name": "TEST X 60x60"}]}, timeout=60)
    assert r.status_code == 200
    assert r.json()["failed"][0]["reason"] == "not_found"

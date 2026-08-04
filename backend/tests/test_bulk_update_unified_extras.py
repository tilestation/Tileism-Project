"""Tests for /api/supplier-sync/products/bulk-update-unified acceptance of arbitrary
Configure-driven field keys (retest of iteration 210 CRITICAL fix)."""
import os
import pytest
import requests
from pymongo import MongoClient

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    # Fallback for backend-side .env location during pytest
    with open("/app/frontend/.env") as f:
        for line in f:
            if line.startswith("REACT_APP_BACKEND_URL"):
                BASE_URL = line.split("=", 1)[1].strip().strip('"').rstrip("/")

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "tile_station")

ADMIN_EMAIL = "admin@test.com"
ADMIN_PASSWORD = "admin123"
TEST_SKU = "ULT-GGI"
TEST_SUPPLIER = "Ultra Tile"  # discovered at fixture time


@pytest.fixture(scope="module")
def db():
    client = MongoClient(MONGO_URL)
    return client[DB_NAME]


@pytest.fixture(scope="module")
def token():
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=15,
    )
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text}"
    return r.json().get("access_token") or r.json().get("token")


@pytest.fixture(scope="module")
def headers(token):
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def test_sku(db):
    # Confirm the SKU exists in supplier_products (module-scope so we know supplier)
    doc = db.supplier_products.find_one({"sku": TEST_SKU})
    if not doc:
        # pick any existing SKU
        doc = db.supplier_products.find_one({})
        assert doc, "no supplier_products in DB"
    return doc["sku"], doc.get("supplier")


def _cleanup(db, sku, keys):
    db.supplier_products.update_one({"sku": sku}, {"$unset": {k: "" for k in keys}})


def test_bulk_update_accepts_arbitrary_configure_keys(headers, db, test_sku):
    sku, supplier = test_sku
    payload = {
        "product_ids": [sku],
        "updates": {
            "bag_weight_kg": 25,
            "coverage_m2_per_bag": 3.5,
            "warranty": "5 years",
            "bag_colour": "White",
        },
        "id_field": "sku",
        "update_mode": "replace",
    }
    r = requests.post(
        f"{BASE_URL}/api/supplier-sync/products/bulk-update-unified",
        json=payload,
        headers=headers,
        timeout=30,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("success") is True, body
    assert body.get("verification_ok") is True, body
    assert body.get("verification_failures") in ([], None), body

    # Direct DB verification
    doc = db.supplier_products.find_one({"sku": sku})
    assert doc.get("bag_weight_kg") == 25, doc.get("bag_weight_kg")
    assert doc.get("coverage_m2_per_bag") == 3.5, doc.get("coverage_m2_per_bag")
    assert doc.get("warranty") == "5 years", doc.get("warranty")
    assert doc.get("bag_colour") == "White", doc.get("bag_colour")

    _cleanup(db, sku, ["bag_weight_kg", "coverage_m2_per_bag", "warranty", "bag_colour"])


def test_bulk_update_blank_clear_unsets_field(headers, db, test_sku):
    sku, _ = test_sku
    # First set
    requests.post(
        f"{BASE_URL}/api/supplier-sync/products/bulk-update-unified",
        json={"product_ids": [sku], "updates": {"warranty": "2 years"}, "id_field": "sku", "update_mode": "replace"},
        headers=headers, timeout=30,
    )
    doc = db.supplier_products.find_one({"sku": sku})
    assert doc.get("warranty") == "2 years"

    # Now blank-clear via empty string
    r = requests.post(
        f"{BASE_URL}/api/supplier-sync/products/bulk-update-unified",
        json={"product_ids": [sku], "updates": {"warranty": ""}, "id_field": "sku", "update_mode": "replace"},
        headers=headers, timeout=30,
    )
    assert r.status_code == 200, r.text
    doc = db.supplier_products.find_one({"sku": sku})
    assert "warranty" not in doc or doc.get("warranty") in (None, ""), f"warranty still present: {doc.get('warranty')}"

    _cleanup(db, sku, ["warranty"])


def test_bulk_update_reserved_keys_blocked(headers, db, test_sku):
    sku, _ = test_sku
    doc_before = db.supplier_products.find_one({"sku": sku})
    is_builtin_before = doc_before.get("is_builtin")

    payload = {
        "product_ids": [sku],
        "updates": {"is_builtin": True, "id": "HACKED", "verification_ok": False, "password_hash": "pwn"},
        "id_field": "sku",
        "update_mode": "replace",
    }
    r = requests.post(
        f"{BASE_URL}/api/supplier-sync/products/bulk-update-unified",
        json=payload, headers=headers, timeout=30,
    )
    assert r.status_code == 200, r.text

    doc_after = db.supplier_products.find_one({"sku": sku})
    assert doc_after.get("is_builtin") == is_builtin_before, "is_builtin was mutated by reserved-key path"
    assert doc_after.get("id") != "HACKED", "id was overwritten via reserved-key path"
    assert doc_after.get("password_hash") != "pwn", "password_hash was written via reserved-key path"

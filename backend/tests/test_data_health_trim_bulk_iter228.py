"""
Iteration 228 tests:
- GET /api/supplier-sync/products/data-health
- POST /api/supplier-sync/products/trim-names (with a stray-space fixture on TEST-DRAFT-PO1)
- Bulk save round-trip of field_label_overrides + custom_specs on TEST-DRAFT-PO1
- Regressions: /api/tiles/collection/{name}?preview=1 and /api/supplier-sync/products/shop-tab-gaps
"""
import os
import time
import requests
import pytest
from pymongo import MongoClient

BASE = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
API = f"{BASE}/api"

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")

SKU = "TEST-DRAFT-PO1"
CLEAN_NAME = "Premium Oak Signature Plank"
STRAY_NAME = "  Premium Oak   Signature Plank "


@pytest.fixture(scope="module")
def mongo():
    client = MongoClient(MONGO_URL)
    db = client[DB_NAME]
    yield db
    client.close()


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{API}/auth/login",
                      json={"email": "admin@test.com", "password": "admin123"},
                      timeout=30)
    if r.status_code != 200:
        pytest.skip(f"admin login failed: {r.status_code} {r.text[:200]}")
    data = r.json()
    tok = data.get("access_token") or data.get("token")
    assert tok, f"No token in: {data}"
    return tok


@pytest.fixture(scope="module")
def hdr(admin_token):
    return {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}


# ---------------- data-health ----------------
def test_data_health_shape(hdr):
    r = requests.get(f"{API}/supplier-sync/products/data-health", headers=hdr, timeout=60)
    assert r.status_code == 200, r.text[:300]
    j = r.json()
    assert "missing_images_total" in j
    assert "total_products" in j
    assert "missing_images_by_group" in j
    assert "untrimmed_names" in j
    assert isinstance(j["missing_images_by_group"], list)
    assert j["missing_images_total"] >= 0
    print("data-health:", {k: j[k] for k in ("missing_images_total", "total_products", "untrimmed_names")})


# ---------------- trim-names with fixture ----------------
def test_trim_names_with_fixture(hdr, mongo):
    col = mongo["supplier_products"]
    # confirm doc exists
    doc = col.find_one({"sku": SKU})
    assert doc, f"fixture doc {SKU} not present"
    # inject stray-space name
    col.update_one({"sku": SKU}, {"$set": {"product_name": STRAY_NAME}})
    try:
        # sanity: data-health should now report at least 1 untrimmed
        r0 = requests.get(f"{API}/supplier-sync/products/data-health", headers=hdr, timeout=60)
        assert r0.status_code == 200
        untrimmed_before = r0.json().get("untrimmed_names", 0)
        assert untrimmed_before >= 1, f"expected untrimmed >=1, got {untrimmed_before}"

        r = requests.post(f"{API}/supplier-sync/products/trim-names", headers=hdr, timeout=90)
        assert r.status_code == 200, r.text[:300]
        j = r.json()
        # counts / examples presence
        assert isinstance(j, dict)
        total = 0
        for k, v in j.items():
            if isinstance(v, int):
                total += v
            elif isinstance(v, dict) and "count" in v:
                total += v["count"]
        assert total >= 1, f"expected trim to count at least 1: {j}"
        print("trim-names response:", j)

        # verify doc got trimmed
        doc2 = col.find_one({"sku": SKU})
        assert doc2["product_name"] == CLEAN_NAME, f"got: {doc2['product_name']!r}"

        # untrimmed_names should be 0 (or at least less)
        r2 = requests.get(f"{API}/supplier-sync/products/data-health", headers=hdr, timeout=60)
        assert r2.status_code == 200
        assert r2.json().get("untrimmed_names", 0) == 0
    finally:
        # ensure clean name restored regardless of assertions
        col.update_one({"sku": SKU}, {"$set": {"product_name": CLEAN_NAME}})


# ---------------- bulk label-override + custom_specs round-trip ----------------
def test_bulk_label_override_and_custom_specs_persist(hdr):
    # Save via unified bulk endpoint (merge mode) simulating the modal
    payload = {
        "id_field": "sku",
        "product_ids": [SKU],
        "updates": {
            "field_label_overrides": {"finish": "Surface Finish"},
            "custom_specs": [{"key": "bottle_volume", "label": "Bottle Volume", "value": "1L"}],
        },
        "mode": "merge",
        "update_mode": "merge",
    }
    r = requests.post(f"{API}/supplier-sync/products/bulk-update-unified",
                      headers=hdr, json=payload, timeout=60)
    assert r.status_code == 200, r.text[:400]
    print("bulk-save resp:", r.json())

    # Read back
    r2 = requests.get(f"{API}/supplier-sync/products",
                      headers=hdr, params={"search": SKU}, timeout=30)
    assert r2.status_code == 200, r2.text[:200]
    body = r2.json()
    items = body.get("items") or body.get("products") or body.get("data") or body
    if isinstance(items, dict):
        items = items.get("items", [])
    match = None
    for it in items:
        if it.get("sku") == SKU:
            match = it
            break
    assert match, f"product {SKU} not in search result"

    flo = match.get("field_label_overrides") or {}
    cs = match.get("custom_specs") or []
    try:
        assert flo.get("finish") == "Surface Finish", f"field_label_overrides={flo}"
        found = any(
            (s.get("key") == "bottle_volume" and s.get("label") == "Bottle Volume" and s.get("value") == "1L")
            for s in cs
        )
        assert found, f"custom_specs missing entry: {cs}"
        print("persisted OK - flo:", flo, "cs:", cs)
    finally:
        # cleanup: reset with replace mode
        cleanup = {
            "id_field": "sku",
            "product_ids": [SKU],
            "updates": {"field_label_overrides": {}, "custom_specs": []},
            "mode": "replace",
            "update_mode": "replace",
        }
        rc = requests.post(f"{API}/supplier-sync/products/bulk-update-unified",
                           headers=hdr, json=cleanup, timeout=60)
        print("cleanup status:", rc.status_code, rc.text[:200])


# ---------------- regressions ----------------
def test_collection_preview_regression(hdr):
    r = requests.get(f"{API}/tiles/collection/Premium Oak",
                     headers=hdr, params={"preview": 1}, timeout=30)
    assert r.status_code == 200, r.text[:200]
    j = r.json()
    assert j.get("draft_count", 0) >= 1, f"draft_count={j.get('draft_count')}"
    # find TEST-DRAFT-PO1 flagged as draft
    tiles = j.get("tiles") or j.get("products") or j.get("items") or []
    found = [t for t in tiles if t.get("sku") == SKU]
    assert found, f"{SKU} not in preview collection response"
    assert found[0].get("is_draft") is True, f"is_draft={found[0].get('is_draft')}"


def test_shop_tab_gaps_regression(hdr):
    r = requests.get(f"{API}/supplier-sync/products/shop-tab-gaps", headers=hdr, timeout=60)
    assert r.status_code == 200, r.text[:200]
    j = r.json()
    assert isinstance(j, (dict, list))

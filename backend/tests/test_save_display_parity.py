"""
Save→Display parity sweep on TestSeries fixture (LP-3611, LP-6611).
For every attribute: save via bulk-update-unified, then read preview API and
assert the field flows to the serialized product. Also validates:
 - price parity both directions (list_price <-> price/room_lot_price)
 - sale display fields
 - draft path (product missing in DB → preview returns is_draft=true)
 - non-preview regression
Always restores fixture to original state at end.
"""
import os
import copy
import pytest
import requests
from pymongo import MongoClient

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://feature-verification-7.preview.emergentagent.com").rstrip("/")
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "tile_station")

SKU_A = "LP-3611"   # 30x60cm, orig price 49.99
SKU_B = "LP-6611"   # 60x60cm


@pytest.fixture(scope="module")
def token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": "admin@test.com", "password": "admin123"}, timeout=15)
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def headers(token):
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def mongo():
    client = MongoClient(MONGO_URL)
    yield client[DB_NAME]
    client.close()


def bulk_update(headers, skus, updates, mode="replace"):
    body = {"id_field": "sku", "product_ids": skus, "updates": updates, "mode": mode}
    r = requests.post(f"{BASE_URL}/api/supplier-sync/products/bulk-update-unified",
                      json=body, headers=headers, timeout=30)
    assert r.status_code == 200, f"bulk-update failed: {r.status_code} {r.text}"
    return r.json()


def get_preview_product(sku):
    r = requests.get(f"{BASE_URL}/api/tiles/collection/TestSeries?limit=100&preview=1", timeout=20)
    assert r.status_code == 200, r.text
    for p in r.json().get("products", []):
        if p.get("sku") == sku:
            return p
    return None


def get_public_product(sku):
    r = requests.get(f"{BASE_URL}/api/tiles/collection/TestSeries?limit=100", timeout=20)
    assert r.status_code == 200, r.text
    for p in r.json().get("products", []):
        if p.get("sku") == sku:
            return p
    return None


# =========================
# ATTRIBUTE PARITY SWEEP
# =========================

@pytest.mark.parametrize("field,value,check_field,check_val", [
    ("color", "Black", "color", "Black"),
    ("finish", "Matt", "finish", "Matt"),
    ("material", "Porcelain", "material", "Porcelain"),
    ("thickness", "9mm", "thickness", "9mm"),
    ("slip_rating", "r10", "slip_rating", "r10"),
    ("suitability", "wall-floor", "suitability", "wall-floor"),
    ("made_in", "Italy", "made_in", "Italy"),
])
def test_scalar_attribute_saves_and_appears_in_preview(headers, field, value, check_field, check_val):
    bulk_update(headers, [SKU_A], {field: value})
    p = get_preview_product(SKU_A)
    assert p is not None, f"{SKU_A} missing from preview"
    got = p.get(check_field)
    assert str(got).lower() == str(check_val).lower(), f"{field}: expected {check_val!r}, got {got!r}"


def test_finishes_array_flows_to_preview(headers):
    bulk_update(headers, [SKU_A], {"finishes": ["Matt", "Semi Polished"]})
    p = get_preview_product(SKU_A)
    assert p is not None
    finishes = p.get("finishes") or []
    assert set(finishes) == {"Matt", "Semi Polished"}, f"finishes got {finishes}"


def test_tiles_per_box_and_sqm_auto_compute(headers):
    # LP-3611 is 30x60cm → 0.18 m² per tile → 6 tiles = 1.08 m²
    bulk_update(headers, [SKU_A], {"tiles_per_box": 6})
    p = get_preview_product(SKU_A)
    assert p is not None
    assert p.get("tiles_per_box") == 6, f"tiles_per_box got {p.get('tiles_per_box')}"
    sqm = p.get("sqm_per_box")
    assert sqm is not None and abs(float(sqm) - 1.08) < 0.02, f"sqm_per_box expected 1.08, got {sqm}"


def test_custom_specs_flow_to_preview(headers):
    spec = [{"key": "frost_proof", "label": "Frost Proof", "value": "Yes"}]
    bulk_update(headers, [SKU_A], {"custom_specs": spec})
    p = get_preview_product(SKU_A)
    assert p is not None
    cs = p.get("custom_specs") or []
    assert any(s.get("key") == "frost_proof" and s.get("value") == "Yes" for s in cs), f"custom_specs got {cs}"


def test_field_label_overrides_flow_to_preview(headers):
    bulk_update(headers, [SKU_A], {"field_label_overrides": {"finish": "Surface"}})
    p = get_preview_product(SKU_A)
    assert p is not None
    flo = p.get("field_label_overrides") or {}
    assert flo.get("finish") == "Surface", f"field_label_overrides got {flo}"


# =========================
# PRICE PARITY (the user's exact complaint)
# =========================

def test_list_price_syncs_to_price_and_room_lot(headers):
    bulk_update(headers, [SKU_A], {"list_price": 42.99, "retail_price": 42.99})
    p = get_preview_product(SKU_A)
    assert p is not None
    assert abs(float(p.get("price")) - 42.99) < 0.01, f"price got {p.get('price')}"
    assert abs(float(p.get("room_lot_price")) - 42.99) < 0.01, f"room_lot_price got {p.get('room_lot_price')}"


def test_price_direction_also_syncs(headers):
    bulk_update(headers, [SKU_A], {"price": 55.99})
    p = get_preview_product(SKU_A)
    assert p is not None
    assert abs(float(p.get("price")) - 55.99) < 0.01, f"price got {p.get('price')}"
    assert abs(float(p.get("room_lot_price")) - 55.99) < 0.01, f"room_lot_price got {p.get('room_lot_price')}"


# =========================
# SALE
# =========================

def test_sale_fields_flow(headers):
    bulk_update(headers, [SKU_A], {"list_price": 42.99, "sale_active": True, "was_price": 52.99})
    p = get_preview_product(SKU_A)
    assert p is not None
    assert p.get("sale_active") is True
    assert abs(float(p.get("was_price")) - 52.99) < 0.01, f"was_price got {p.get('was_price')}"
    # discount % should be computed
    disc = p.get("discount_percentage")
    assert disc is not None and float(disc) > 0, f"discount_percentage got {disc}"


# =========================
# DRAFT PATH — delete LP-6611, ensure preview still returns it as draft with fields
# =========================

def test_draft_path_full_pass_through(headers, mongo):
    # Save a distinctive value first so we can look for it
    bulk_update(headers, [SKU_B], {"color": "Emerald", "finish": "Polished"})

    # BACK UP
    tiles_backup = list(mongo.tiles.find({"sku": SKU_B}))
    products_backup = list(mongo.products.find({"sku": SKU_B}))

    try:
        mongo.tiles.delete_many({"sku": SKU_B})
        mongo.products.delete_many({"sku": SKU_B})

        p = get_preview_product(SKU_B)
        assert p is not None, "LP-6611 not returned as draft in preview"
        assert p.get("is_draft") is True, f"is_draft flag missing: {p.get('is_draft')}"
        assert p.get("color") == "Emerald", f"draft pass-through color got {p.get('color')}"
        assert p.get("finish") == "Polished", f"draft pass-through finish got {p.get('finish')}"
    finally:
        # RESTORE
        for d in tiles_backup:
            d.pop("_id", None)
            mongo.tiles.insert_one(d)
        for d in products_backup:
            d.pop("_id", None)
            mongo.products.insert_one(d)


# =========================
# REGRESSION
# =========================

def test_health_endpoint_fast():
    import time
    t0 = time.time()
    r = requests.get(f"{BASE_URL}/api/health", timeout=5)
    dt = time.time() - t0
    assert r.status_code == 200
    assert dt < 3.0, f"health took {dt:.2f}s"


def test_non_preview_collection_returns_products():
    p = get_public_product(SKU_A)
    assert p is not None
    assert p.get("price") is not None and float(p["price"]) > 0


# =========================
# CLEANUP — restore all mutated fields to spec defaults
# =========================

def test_zzz_cleanup_restore_fixture(headers):
    reset = {
        "color": "", "colors": [],
        "finish": "", "finishes": [],
        "material": "", "materials": [],
        "thickness": "",
        "slip_rating": "",
        "suitability": "",
        "made_in": "", "made_in_countries": [],
        "tiles_per_box": 0, "sqm_per_box": 0,
        "sale_active": False, "was_price": None,
        "custom_specs": [], "field_label_overrides": {},
    }
    # LP-3611 → price 49.99 per spec
    bulk_update(headers, [SKU_A], {**reset, "list_price": 49.99, "price": 49.99, "retail_price": 49.99})
    # LP-6611 → keep prior price (28.99), reset attributes
    bulk_update(headers, [SKU_B], reset)

    p1 = get_preview_product(SKU_A)
    p2 = get_preview_product(SKU_B)
    assert p1 is not None and p2 is not None
    assert abs(float(p1["price"]) - 49.99) < 0.01, f"LP-3611 price restore got {p1['price']}"
    assert (p1.get("color") or "") == "", f"LP-3611 color not reset: {p1.get('color')}"
    assert (p2.get("color") or "") == "", f"LP-6611 color not reset: {p2.get('color')}"

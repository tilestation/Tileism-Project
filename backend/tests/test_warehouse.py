"""Tonbridge Warehouse feature — backend tests.

Covers:
- GET /api/warehouse/info (auto-creates the warehouse showroom row)
- GET /api/warehouse/products (search + warehouse_stock)
- POST /api/warehouse/adjust (set/delta modes, guards, permissions)
- GET /api/warehouse/adjustments (history)
- POST /api/warehouse/request-transfer (creates a pending stock_transfer)
- GET /api/showrooms/public (warehouse must NOT be returned)
- Permission gate: 403 without warehouse_manage; SUCCESS after override
"""

import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
API = f"{BASE_URL}/api"

ADMIN_EMAIL = "admin@test.com"
ADMIN_PASSWORD = "admin123"

# Unique test staff created per test session
TEST_STAFF_EMAIL = f"TEST_warehouse_staff_{uuid.uuid4().hex[:8]}@example.com"
TEST_STAFF_PASSWORD = "TestPass123!"


def _login(email: str, password: str) -> str:
    r = requests.post(f"{API}/auth/login", json={"email": email, "password": password})
    if r.status_code != 200:
        pytest.skip(f"Login failed for {email}: {r.status_code} {r.text}")
    return r.json()["token"]


@pytest.fixture(scope="module")
def admin_token():
    return _login(ADMIN_EMAIL, ADMIN_PASSWORD)


@pytest.fixture(scope="module")
def admin_hdr(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


@pytest.fixture(scope="module")
def warehouse_info(admin_hdr):
    r = requests.get(f"{API}/warehouse/info", headers=admin_hdr)
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture(scope="module")
def a_product(admin_hdr):
    """Grab a product to use in adjust/request tests."""
    r = requests.get(f"{API}/warehouse/products", params={"q": "tile", "limit": 5}, headers=admin_hdr)
    assert r.status_code == 200, r.text
    products = r.json().get("products") or []
    if not products:
        pytest.skip("No products with 'tile' in name — cannot exercise adjust flow")
    return products[0]


@pytest.fixture(scope="module")
def another_showroom(admin_hdr):
    """Return an id of a non-warehouse showroom for request-transfer tests."""
    r = requests.get(f"{API}/showrooms", headers=admin_hdr)
    assert r.status_code == 200, r.text
    for s in r.json():
        if not s.get("is_warehouse") and s.get("id"):
            return s
    pytest.skip("No non-warehouse showroom available for request-transfer tests")


@pytest.fixture(scope="module")
def test_staff(admin_hdr):
    """Create a staff-role test user, yield credentials. Cleanup at end."""
    payload = {
        "email": TEST_STAFF_EMAIL,
        "password": TEST_STAFF_PASSWORD,
        "name": "TEST Warehouse Staff",
        "role": "staff",
    }
    r = requests.post(f"{API}/admin/users", json=payload, headers=admin_hdr)
    assert r.status_code in (200, 201), f"Create user failed: {r.status_code} {r.text}"

    yield {"email": TEST_STAFF_EMAIL, "password": TEST_STAFF_PASSWORD}

    # cleanup — best-effort
    try:
        requests.delete(f"{API}/admin/users/{TEST_STAFF_EMAIL}", headers=admin_hdr)
    except Exception:
        pass


# -----------------------------------------------------------------------------
# PIN fixtures — a live staff_pin doc is required for every warehouse mutation
# (POST /pin-session validates against it and mints a short-lived JWT).
# -----------------------------------------------------------------------------
TEST_PIN_NAME = f"TEST Warehouse PIN {uuid.uuid4().hex[:6]}"


def _random_unused_pin(admin_hdr) -> str:
    """Find a 4-digit numeric PIN that isn't in use."""
    r = requests.get(f"{API}/staff-pins", headers=admin_hdr)
    used = set()
    if r.status_code == 200:
        for row in r.json() or []:
            p = row.get("pin")
            if p:
                used.add(str(p))
    # Deterministic-ish walk starting from a random spot in 4-digit space.
    import random
    start = random.randint(1000, 9990)
    for delta in range(9000):
        candidate = str((start + delta - 1000) % 9000 + 1000)
        if candidate not in used:
            return candidate
    raise RuntimeError("No free 4-digit PIN available")


@pytest.fixture(scope="module")
def staff_pin(admin_hdr):
    """Create a staff_pin doc, yield {pin,id,name}, delete on teardown."""
    pin_value = _random_unused_pin(admin_hdr)
    payload = {
        "name": TEST_PIN_NAME,
        "pin": pin_value,
        "role": "manager",
        "active": True,
    }
    r = requests.post(f"{API}/staff-pins", json=payload, headers=admin_hdr)
    assert r.status_code in (200, 201), f"create staff PIN failed: {r.status_code} {r.text}"
    row = r.json()
    row["pin"] = pin_value  # server hides pin in the response
    yield row
    try:
        requests.delete(f"{API}/staff-pins/{row['id']}", headers=admin_hdr)
    except Exception:
        pass


@pytest.fixture(scope="module")
def admin_pin_token(admin_hdr, staff_pin):
    """Mint a PIN session token as the admin user. Reused across mutations."""
    r = requests.post(
        f"{API}/warehouse/pin-session",
        json={"pin": staff_pin["pin"]},
        headers=admin_hdr,
    )
    assert r.status_code == 200, f"pin-session failed: {r.status_code} {r.text}"
    tok = r.json().get("session_token")
    assert tok
    return tok


def _pin(payload: dict, token: str) -> dict:
    """Return payload with pin_session_token injected. Non-mutating."""
    out = dict(payload)
    out["pin_session_token"] = token
    return out


def _pin_hdr(admin_hdr: dict, token: str) -> dict:
    """Return admin_hdr with X-Warehouse-Pin (used by DELETE /batches/{id})."""
    return {**admin_hdr, "X-Warehouse-Pin": token}


# -----------------------------------------------------------------------------
# /warehouse/info
# -----------------------------------------------------------------------------
class TestWarehouseInfo:
    def test_info_returns_expected_shape(self, warehouse_info):
        assert "warehouse" in warehouse_info
        wh = warehouse_info["warehouse"]
        assert wh.get("name") == "Tonbridge Warehouse"
        assert wh.get("is_warehouse") is True
        assert isinstance(wh.get("id"), str) and len(wh["id"]) > 0

        assert warehouse_info.get("can_manage") is True  # admin
        reasons = warehouse_info.get("reasons")
        assert isinstance(reasons, list) and len(reasons) == 5
        keys = {r["key"] for r in reasons}
        assert keys == {"delivery_received", "stocktake_correction", "damage_writeoff",
                        "transfer_out", "other"}

    def test_info_requires_auth(self):
        r = requests.get(f"{API}/warehouse/info")
        assert r.status_code in (401, 403)


# -----------------------------------------------------------------------------
# /warehouse/products
# -----------------------------------------------------------------------------
class TestWarehouseProducts:
    def test_empty_q_returns_empty_products(self, admin_hdr):
        r = requests.get(f"{API}/warehouse/products", params={"q": ""}, headers=admin_hdr)
        assert r.status_code == 200
        assert r.json().get("products") == []

    def test_search_returns_products_with_warehouse_stock(self, admin_hdr):
        r = requests.get(f"{API}/warehouse/products", params={"q": "tile"}, headers=admin_hdr)
        assert r.status_code == 200
        products = r.json().get("products") or []
        assert len(products) >= 1
        p0 = products[0]
        for key in ("id", "name", "sku", "warehouse_stock"):
            assert key in p0
        assert isinstance(p0["warehouse_stock"], int)

    def test_search_case_insensitive(self, admin_hdr):
        r_lower = requests.get(f"{API}/warehouse/products", params={"q": "tile"}, headers=admin_hdr)
        r_upper = requests.get(f"{API}/warehouse/products", params={"q": "TILE"}, headers=admin_hdr)
        assert r_lower.status_code == 200 and r_upper.status_code == 200
        assert len(r_lower.json()["products"]) == len(r_upper.json()["products"])


# -----------------------------------------------------------------------------
# /warehouse/adjust
# -----------------------------------------------------------------------------
class TestWarehouseAdjust:
    def test_set_mode_updates_stock_to_100(self, admin_hdr, admin_pin_token, a_product):
        payload = {
            "product_id": a_product["id"],
            "mode": "set",
            "quantity": 100,
            "reason": "delivery_received",
            "note": "TEST set 100",
        }
        r = requests.post(f"{API}/warehouse/adjust", json=_pin(payload, admin_pin_token), headers=admin_hdr)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data.get("success") is True
        assert data.get("after_qty") == 100
        adj = data.get("adjustment")
        assert adj and adj.get("mode") == "set" and adj.get("reason") == "delivery_received"

        # Verify persistence via /products search
        r2 = requests.get(f"{API}/warehouse/products", params={"q": a_product["sku"] or a_product["name"]}, headers=admin_hdr)
        assert r2.status_code == 200
        matched = next((p for p in r2.json()["products"] if p["id"] == a_product["id"]), None)
        assert matched and matched["warehouse_stock"] == 100

    def test_delta_mode_subtracts_15(self, admin_hdr, admin_pin_token, a_product):
        # State should be 100 from previous test
        payload = {
            "product_id": a_product["id"],
            "mode": "delta",
            "quantity": -15,
            "reason": "damage_writeoff",
        }
        r = requests.post(f"{API}/warehouse/adjust", json=_pin(payload, admin_pin_token), headers=admin_hdr)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["before_qty"] == 100
        assert data["after_qty"] == 85

    def test_delta_negative_below_zero_returns_400(self, admin_hdr, admin_pin_token, a_product):
        payload = {
            "product_id": a_product["id"],
            "mode": "delta",
            "quantity": -99999,
            "reason": "stocktake_correction",
        }
        r = requests.post(f"{API}/warehouse/adjust", json=_pin(payload, admin_pin_token), headers=admin_hdr)
        assert r.status_code == 400, r.text

    def test_invalid_reason_returns_400(self, admin_hdr, admin_pin_token, a_product):
        payload = {
            "product_id": a_product["id"],
            "mode": "set",
            "quantity": 10,
            "reason": "nope_not_valid",
        }
        r = requests.post(f"{API}/warehouse/adjust", json=_pin(payload, admin_pin_token), headers=admin_hdr)
        assert r.status_code == 400

    def test_missing_product_returns_404(self, admin_hdr, admin_pin_token):
        payload = {
            "product_id": "does-not-exist-xyz-" + uuid.uuid4().hex,
            "mode": "set",
            "quantity": 5,
            "reason": "other",
        }
        r = requests.post(f"{API}/warehouse/adjust", json=_pin(payload, admin_pin_token), headers=admin_hdr)
        assert r.status_code == 404


# -----------------------------------------------------------------------------
# Permission gate: staff WITHOUT then WITH warehouse_manage
# -----------------------------------------------------------------------------
class TestWarehousePermissions:
    def test_staff_without_permission_gets_403(self, admin_hdr, test_staff, a_product):
        # Ensure no override yet
        requests.put(
            f"{API}/permissions/users/{test_staff['email']}/overrides",
            json={"extra_pages": [], "denied_pages": [], "extra_actions": [], "denied_actions": []},
            headers=admin_hdr,
        )
        tok = _login(test_staff["email"], test_staff["password"])
        hdr = {"Authorization": f"Bearer {tok}"}
        payload = {
            "product_id": a_product["id"],
            "mode": "set",
            "quantity": 50,
            "reason": "stocktake_correction",
        }
        r = requests.post(f"{API}/warehouse/adjust", json=payload, headers=hdr)
        assert r.status_code == 403, r.text
        detail = r.json().get("detail", "")
        assert "Warehouse" in detail or "warehouse" in detail.lower()

    def test_staff_with_warehouse_manage_succeeds(self, admin_hdr, admin_pin_token, test_staff, a_product, staff_pin):
        # Grant override
        r_ovr = requests.put(
            f"{API}/permissions/users/{test_staff['email']}/overrides",
            json={"extra_pages": ["warehouse_manage"]},
            headers=admin_hdr,
        )
        assert r_ovr.status_code == 200, r_ovr.text

        tok = _login(test_staff["email"], test_staff["password"])
        hdr = {"Authorization": f"Bearer {tok}"}
        # Staff needs to mint their OWN PIN session (tokens are user-bound)
        r_pin = requests.post(f"{API}/warehouse/pin-session",
                              json={"pin": staff_pin["pin"]}, headers=hdr)
        assert r_pin.status_code == 200, r_pin.text
        staff_pin_token = r_pin.json()["session_token"]

        payload = {
            "product_id": a_product["id"],
            "mode": "set",
            "quantity": 50,
            "reason": "stocktake_correction",
            "note": "TEST staff-with-permission",
        }
        r = requests.post(f"{API}/warehouse/adjust", json=_pin(payload, staff_pin_token), headers=hdr)
        assert r.status_code == 200, f"Expected 200 with warehouse_manage override, got {r.status_code} {r.text}"
        assert r.json().get("after_qty") == 50

    def test_denied_pages_wins_over_extra_pages(self, admin_hdr, test_staff, a_product):
        """Regression: denials must beat grants. Setting both extra_pages and
        denied_pages to ['warehouse_manage'] must result in 403."""
        r_ovr = requests.put(
            f"{API}/permissions/users/{test_staff['email']}/overrides",
            json={
                "extra_pages": ["warehouse_manage"],
                "denied_pages": ["warehouse_manage"],
                "extra_actions": [],
                "denied_actions": [],
            },
            headers=admin_hdr,
        )
        assert r_ovr.status_code == 200, r_ovr.text

        tok = _login(test_staff["email"], test_staff["password"])
        hdr = {"Authorization": f"Bearer {tok}"}
        payload = {
            "product_id": a_product["id"],
            "mode": "set",
            "quantity": 25,
            "reason": "stocktake_correction",
            "note": "TEST denied wins",
        }
        r = requests.post(f"{API}/warehouse/adjust", json=payload, headers=hdr)
        assert r.status_code == 403, f"Expected 403 (denied_pages wins), got {r.status_code} {r.text}"

        # Reset overrides so cleanup order does not affect other runs
        requests.put(
            f"{API}/permissions/users/{test_staff['email']}/overrides",
            json={"extra_pages": [], "denied_pages": [], "extra_actions": [], "denied_actions": []},
            headers=admin_hdr,
        )


# -----------------------------------------------------------------------------
# /warehouse/adjustments history
# -----------------------------------------------------------------------------
class TestWarehouseAdjustments:
    def test_history_returns_recent_first(self, admin_hdr):
        r = requests.get(f"{API}/warehouse/adjustments", headers=admin_hdr)
        assert r.status_code == 200
        rows = r.json().get("adjustments") or []
        assert len(rows) >= 1
        # Sorted desc by created_at
        if len(rows) >= 2:
            assert rows[0]["created_at"] >= rows[1]["created_at"]

    def test_history_product_filter(self, admin_hdr, a_product):
        r = requests.get(
            f"{API}/warehouse/adjustments",
            params={"product_id": a_product["id"]},
            headers=admin_hdr,
        )
        assert r.status_code == 200
        rows = r.json().get("adjustments") or []
        assert len(rows) >= 1
        for row in rows:
            assert row["product_id"] == a_product["id"]


# -----------------------------------------------------------------------------
# /warehouse/request-transfer
# -----------------------------------------------------------------------------
class TestWarehouseRequestTransfer:
    def test_request_creates_pending_transfer(self, admin_hdr, a_product, another_showroom, warehouse_info):
        payload = {
            "to_showroom_id": another_showroom["id"],
            "product_id": a_product["id"],
            "sku": a_product.get("sku") or "SKU",
            "name": a_product.get("name") or "Product",
            "quantity": 3,
            "notes": "TEST request",
        }
        r = requests.post(f"{API}/warehouse/request-transfer", json=payload, headers=admin_hdr)
        assert r.status_code == 200, r.text
        data = r.json()
        t = data.get("transfer")
        assert t is not None
        assert t["status"] == "pending"
        assert t["source"] == "warehouse_request"
        assert t["from_showroom_id"] == warehouse_info["warehouse"]["id"]
        assert t["to_showroom_id"] == another_showroom["id"]
        assert isinstance(t.get("items"), list) and len(t["items"]) == 1
        assert t["items"][0]["product_id"] == a_product["id"]

    def test_rejects_to_warehouse_itself(self, admin_hdr, a_product, warehouse_info):
        payload = {
            "to_showroom_id": warehouse_info["warehouse"]["id"],
            "product_id": a_product["id"],
            "sku": a_product.get("sku") or "SKU",
            "name": a_product.get("name") or "Product",
            "quantity": 1,
        }
        r = requests.post(f"{API}/warehouse/request-transfer", json=payload, headers=admin_hdr)
        assert r.status_code == 400


# -----------------------------------------------------------------------------
# /showrooms/public — warehouse must be filtered out
# -----------------------------------------------------------------------------
class TestPublicShowroomsExcludeWarehouse:
    def test_warehouse_not_in_public_list(self):
        # NOTE: the actual mount path is `/api/website-admin/showrooms/public`
        # because website_admin_router is mounted with prefix `/website-admin`.
        # Review request said `/showrooms/public` but that route is shadowed by
        # PUT /showrooms/{id} in the `showrooms` router.
        r = requests.get(f"{API}/website-admin/showrooms/public")
        assert r.status_code == 200, r.text
        data = r.json()
        showrooms = data.get("showrooms", []) if isinstance(data, dict) else data
        assert len(showrooms) >= 1, "Expected at least one public showroom"
        for s in showrooms:
            assert s.get("name") != "Tonbridge Warehouse"
            assert s.get("is_warehouse") is not True


# =============================================================================
# BATCH TRACKING (Jul 17, 2026) — per-batch stock + quick-add product
# =============================================================================

# Unique SKU per pytest run so 409 duplicate guard doesn't trip across runs
BATCH_RUN_ID = uuid.uuid4().hex[:8]
QUICK_ADD_SKU = f"TEST-WH-QA-{BATCH_RUN_ID}"
QUICK_ADD_NAME = f"TEST Warehouse Batch Product {BATCH_RUN_ID}"


@pytest.fixture(scope="module")
def quick_added_product(admin_hdr, admin_pin_token):
    """Create a fresh product via /warehouse/products/quick-add. Reused
    across the batch tests so we exercise the true real-world flow: quick
    add → create batches → edit → delete."""
    payload = {
        "name": QUICK_ADD_NAME,
        "sku": QUICK_ADD_SKU,
        "category_name": "TEST Warehouse",
        "tile_width": 600,
        "tile_height": 600,
        "tiles_per_box": 4,
        "image_url": "https://example.com/tile.jpg",
    }
    r = requests.post(f"{API}/warehouse/products/quick-add", json=_pin(payload, admin_pin_token), headers=admin_hdr)
    assert r.status_code == 200, f"quick-add failed: {r.status_code} {r.text}"
    product = r.json().get("product")
    assert product and product.get("id")
    yield product
    # NOTE: no product delete endpoint on warehouse router. Leave in DB —
    # SKU includes run-id so subsequent runs won't collide.


class TestQuickAddProduct:
    """POST /api/warehouse/products/quick-add"""

    def test_quick_add_creates_product_with_computed_m2(self, quick_added_product):
        p = quick_added_product
        assert p["name"] == QUICK_ADD_NAME
        assert p["sku"] == QUICK_ADD_SKU
        # (600 * 600) / 1_000_000 = 0.36
        assert p.get("tile_m2_per_piece") == 0.36
        assert p.get("tiles_per_box") == 4
        # box_m2_coverage = 0.36 * 4 = 1.44
        assert p.get("box_m2_coverage") == 1.44
        assert p.get("source") == "warehouse_quick_add"
        assert isinstance(p.get("images"), list) and len(p["images"]) == 1

    def test_quick_add_returns_409_on_duplicate_sku(self, admin_hdr, admin_pin_token, quick_added_product):
        payload = {
            "name": QUICK_ADD_NAME + " duplicate",
            "sku": QUICK_ADD_SKU,  # same SKU as fixture
            "tile_width": 300,
            "tile_height": 300,
            "tiles_per_box": 6,
        }
        r = requests.post(f"{API}/warehouse/products/quick-add", json=_pin(payload, admin_pin_token), headers=admin_hdr)
        assert r.status_code == 409, r.text
        assert QUICK_ADD_SKU in r.json().get("detail", "")

    def test_search_returns_quick_added_product_with_image_and_dimensions(self, admin_hdr, quick_added_product):
        r = requests.get(f"{API}/warehouse/products", params={"q": QUICK_ADD_SKU}, headers=admin_hdr)
        assert r.status_code == 200
        products = r.json().get("products") or []
        matched = next((p for p in products if p["id"] == quick_added_product["id"]), None)
        assert matched, "quick-added product not returned by search"
        assert matched.get("image") == "https://example.com/tile.jpg"
        assert matched.get("tile_width") == 600
        assert matched.get("tile_height") == 600
        assert matched.get("tile_m2_per_piece") == 0.36
        assert matched.get("tiles_per_box") == 4
        assert matched.get("batch_count") == 0
        assert matched.get("batches") == []


class TestBatchCRUD:
    """POST/PUT/DELETE /api/warehouse/batches + GET /products/{id}/batches"""

    # Shared batch IDs across tests in this class
    batch_a_id: str = ""
    batch_b_id: str = ""

    def test_create_first_batch(self, admin_hdr, admin_pin_token, quick_added_product):
        payload = {
            "product_id": quick_added_product["id"],
            "batch_number": f"BATCH-A-{BATCH_RUN_ID}",
            "boxes": 10,
            "tiles_per_box": 4,
            "extra_pieces": 3,
            "notes": "TEST first batch",
        }
        r = requests.post(f"{API}/warehouse/batches", json=_pin(payload, admin_pin_token), headers=admin_hdr)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["success"] is True
        b = data["batch"]
        # 10 * 4 + 3 = 43
        assert b["total_pieces"] == 43
        assert b["is_active"] is True
        assert b["batch_number"] == f"BATCH-A-{BATCH_RUN_ID}"
        assert data["warehouse_total"] == 43
        TestBatchCRUD.batch_a_id = b["id"]

    def test_create_second_batch_same_product(self, admin_hdr, admin_pin_token, quick_added_product):
        payload = {
            "product_id": quick_added_product["id"],
            "batch_number": f"BATCH-B-{BATCH_RUN_ID}",
            "boxes": 5,
            "tiles_per_box": 4,
            "extra_pieces": 0,
        }
        r = requests.post(f"{API}/warehouse/batches", json=_pin(payload, admin_pin_token), headers=admin_hdr)
        assert r.status_code == 200, r.text
        data = r.json()
        # 5*4+0 = 20 ; warehouse total = 43 + 20 = 63
        assert data["batch"]["total_pieces"] == 20
        assert data["warehouse_total"] == 63
        TestBatchCRUD.batch_b_id = data["batch"]["id"]

    def test_duplicate_batch_number_case_insensitive_rejected_409(self, admin_hdr, admin_pin_token, quick_added_product):
        payload = {
            "product_id": quick_added_product["id"],
            "batch_number": f"batch-a-{BATCH_RUN_ID}",  # lowercase clash with BATCH-A
            "boxes": 1,
            "tiles_per_box": 4,
            "extra_pieces": 0,
        }
        r = requests.post(f"{API}/warehouse/batches", json=_pin(payload, admin_pin_token), headers=admin_hdr)
        assert r.status_code == 409, r.text
        assert "already exists" in r.json().get("detail", "").lower()

    def test_get_active_batches_for_product(self, admin_hdr, quick_added_product):
        r = requests.get(f"{API}/warehouse/products/{quick_added_product['id']}/batches", headers=admin_hdr)
        assert r.status_code == 200
        batches = r.json().get("batches") or []
        assert len(batches) == 2
        for b in batches:
            assert b.get("is_active") is not False
            assert b.get("product_id") == quick_added_product["id"]

    def test_search_shows_batches_array_and_coverage(self, admin_hdr, quick_added_product):
        r = requests.get(f"{API}/warehouse/products", params={"q": QUICK_ADD_SKU}, headers=admin_hdr)
        assert r.status_code == 200
        matched = next((p for p in r.json()["products"] if p["id"] == quick_added_product["id"]), None)
        assert matched
        assert matched["warehouse_stock"] == 63
        assert matched["batch_count"] == 2
        assert len(matched["batches"]) == 2
        # coverage_m2 = 63 * 0.36 = 22.68
        assert matched["coverage_m2"] == 22.68

    def test_update_batch_boxes_recomputes_total_and_resyncs_stock(self, admin_hdr, admin_pin_token, quick_added_product):
        assert TestBatchCRUD.batch_a_id, "batch_a_id not set"
        payload = {
            "boxes": 12,  # was 10, +2 boxes = +8 pcs. New total = 12*4+3 = 51
            "reason": "stocktake_correction",
        }
        r = requests.put(f"{API}/warehouse/batches/{TestBatchCRUD.batch_a_id}", json=_pin(payload, admin_pin_token), headers=admin_hdr)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["batch"]["total_pieces"] == 51
        # 51 + 20 (batch B) = 71
        assert data["warehouse_total"] == 71

    def test_update_batch_rename_collision_409(self, admin_hdr, admin_pin_token, quick_added_product):
        assert TestBatchCRUD.batch_a_id and TestBatchCRUD.batch_b_id
        # Try to rename batch B to batch A's number
        payload = {"batch_number": f"BATCH-A-{BATCH_RUN_ID}"}
        r = requests.put(f"{API}/warehouse/batches/{TestBatchCRUD.batch_b_id}", json=_pin(payload, admin_pin_token), headers=admin_hdr)
        assert r.status_code == 409, r.text

    def test_delete_batch_soft_deletes_and_drops_total(self, admin_hdr, admin_pin_token, quick_added_product):
        assert TestBatchCRUD.batch_b_id
        r = requests.delete(
            f"{API}/warehouse/batches/{TestBatchCRUD.batch_b_id}",
            params={"reason": "TEST cleanup"},
            headers=_pin_hdr(admin_hdr, admin_pin_token),
        )
        assert r.status_code == 200, r.text
        data = r.json()
        # Batch B (20 pcs) removed. warehouse_total = 51 (batch A only)
        assert data["warehouse_total"] == 51

        # Verify list_product_batches no longer returns batch B
        r2 = requests.get(f"{API}/warehouse/products/{quick_added_product['id']}/batches", headers=admin_hdr)
        assert r2.status_code == 200
        remaining = r2.json().get("batches") or []
        ids = [b["id"] for b in remaining]
        assert TestBatchCRUD.batch_b_id not in ids
        assert TestBatchCRUD.batch_a_id in ids

    def test_delete_nonexistent_batch_returns_404(self, admin_hdr, admin_pin_token):
        r = requests.delete(
            f"{API}/warehouse/batches/no-such-batch-{uuid.uuid4().hex}",
            headers=_pin_hdr(admin_hdr, admin_pin_token),
        )
        assert r.status_code == 404

    def test_batch_mutations_appear_in_adjustments_audit(self, admin_hdr, quick_added_product):
        r = requests.get(
            f"{API}/warehouse/adjustments",
            params={"product_id": quick_added_product["id"], "limit": 50},
            headers=admin_hdr,
        )
        assert r.status_code == 200
        rows = r.json().get("adjustments") or []
        reasons = [row.get("reason") for row in rows]
        # Should include batch_added (from create), batch_edited/stocktake_correction (from update),
        # and batch_removed (from delete).
        assert "batch_added" in reasons
        assert "batch_removed" in reasons
        # Update used explicit reason=stocktake_correction — the code uses payload.reason
        # or 'batch_edited' as fallback. Both are acceptable here.
        assert ("stocktake_correction" in reasons) or ("batch_edited" in reasons)


# -----------------------------------------------------------------------------
# Permission gates for the 4 new mutations (quick-add + 3 batch mutations)
# -----------------------------------------------------------------------------
class TestBatchPermissionGates:
    """Staff without super_admin AND without warehouse_manage must be 403
    on all 4 batch-related mutations. Then grant warehouse_manage and
    verify they succeed."""

    def _reset_overrides(self, admin_hdr, email):
        requests.put(
            f"{API}/permissions/users/{email}/overrides",
            json={"extra_pages": [], "denied_pages": [], "extra_actions": [], "denied_actions": []},
            headers=admin_hdr,
        )

    def test_staff_without_override_gets_403_on_all_mutations(
        self, admin_hdr, test_staff, quick_added_product,
    ):
        self._reset_overrides(admin_hdr, test_staff["email"])
        tok = _login(test_staff["email"], test_staff["password"])
        hdr = {"Authorization": f"Bearer {tok}"}

        # quick-add
        r = requests.post(
            f"{API}/warehouse/products/quick-add",
            json={"name": f"TEST denied {uuid.uuid4().hex[:6]}", "sku": f"TEST-DENIED-{uuid.uuid4().hex[:6]}"},
            headers=hdr,
        )
        assert r.status_code == 403, f"quick-add expected 403, got {r.status_code} {r.text}"

        # create batch
        r = requests.post(
            f"{API}/warehouse/batches",
            json={"product_id": quick_added_product["id"], "batch_number": f"NO-PERM-{uuid.uuid4().hex[:6]}",
                  "boxes": 1, "tiles_per_box": 1, "extra_pieces": 0},
            headers=hdr,
        )
        assert r.status_code == 403, f"create batch expected 403, got {r.status_code} {r.text}"

        # update batch (need an existing batch id — TestBatchCRUD.batch_a_id)
        if TestBatchCRUD.batch_a_id:
            r = requests.put(
                f"{API}/warehouse/batches/{TestBatchCRUD.batch_a_id}",
                json={"boxes": 99}, headers=hdr,
            )
            assert r.status_code == 403, f"update batch expected 403, got {r.status_code} {r.text}"

            # delete batch
            r = requests.delete(f"{API}/warehouse/batches/{TestBatchCRUD.batch_a_id}", headers=hdr)
            assert r.status_code == 403, f"delete batch expected 403, got {r.status_code} {r.text}"

    def test_staff_with_warehouse_manage_can_mutate_all(
        self, admin_hdr, test_staff, quick_added_product, staff_pin,
    ):
        # Grant override
        r_ovr = requests.put(
            f"{API}/permissions/users/{test_staff['email']}/overrides",
            json={"extra_pages": ["warehouse_manage"]},
            headers=admin_hdr,
        )
        assert r_ovr.status_code == 200

        tok = _login(test_staff["email"], test_staff["password"])
        hdr = {"Authorization": f"Bearer {tok}"}
        # Staff mints their own PIN session (bound to their JWT identity).
        r_pin = requests.post(f"{API}/warehouse/pin-session",
                              json={"pin": staff_pin["pin"]}, headers=hdr)
        assert r_pin.status_code == 200, r_pin.text
        pin_token = r_pin.json()["session_token"]

        # quick-add succeeds
        qa_sku = f"TEST-STAFF-QA-{uuid.uuid4().hex[:8]}"
        r = requests.post(
            f"{API}/warehouse/products/quick-add",
            json=_pin({"name": f"TEST staff qa {qa_sku}", "sku": qa_sku,
                  "tile_width": 300, "tile_height": 300, "tiles_per_box": 8}, pin_token),
            headers=hdr,
        )
        assert r.status_code == 200, f"quick-add w/ perm expected 200, got {r.status_code} {r.text}"
        new_product = r.json()["product"]

        # create batch
        r = requests.post(
            f"{API}/warehouse/batches",
            json=_pin({"product_id": new_product["id"], "batch_number": f"STAFF-B-{uuid.uuid4().hex[:6]}",
                  "boxes": 2, "tiles_per_box": 8, "extra_pieces": 1}, pin_token),
            headers=hdr,
        )
        assert r.status_code == 200, f"create batch w/ perm expected 200, got {r.status_code} {r.text}"
        batch_id = r.json()["batch"]["id"]
        assert r.json()["batch"]["total_pieces"] == 17

        # update batch
        r = requests.put(
            f"{API}/warehouse/batches/{batch_id}",
            json=_pin({"boxes": 3}, pin_token),  # 3*8+1 = 25
            headers=hdr,
        )
        assert r.status_code == 200
        assert r.json()["batch"]["total_pieces"] == 25

        # delete batch — PIN goes in header for DELETE
        r = requests.delete(
            f"{API}/warehouse/batches/{batch_id}",
            params={"reason": "cleanup"},
            headers={**hdr, "X-Warehouse-Pin": pin_token},
        )
        assert r.status_code == 200

        # Cleanup — reset overrides
        self._reset_overrides(admin_hdr, test_staff["email"])



# =============================================================================
# WAREHOUSE LOCATION (Jan, 2026) — product default + per-batch location
# =============================================================================

LOC_RUN_ID = uuid.uuid4().hex[:8]
LOC_SKU = f"TEST-WH-LOC-{LOC_RUN_ID}"
LOC_NAME = f"TEST Warehouse Location Product {LOC_RUN_ID}"
DEFAULT_LOCATION = "Rack A3-12"
OVERRIDE_LOCATION = "Yard - Bay 4"


@pytest.fixture(scope="module")
def loc_product(admin_hdr, admin_pin_token):
    """Quick-add a product WITH warehouse_location set — used across the
    location suite so we can verify inheritance and PUT /location updates."""
    payload = {
        "name": LOC_NAME,
        "sku": LOC_SKU,
        "category_name": "TEST Warehouse Location",
        "tile_width": 300,
        "tile_height": 300,
        "tiles_per_box": 6,
        "warehouse_location": DEFAULT_LOCATION,
    }
    r = requests.post(f"{API}/warehouse/products/quick-add", json=_pin(payload, admin_pin_token), headers=admin_hdr)
    assert r.status_code == 200, f"quick-add w/ location failed: {r.status_code} {r.text}"
    product = r.json().get("product")
    assert product and product.get("id")
    return product


class TestWarehouseLocation:
    """Coverage for the newly added location field.
    - quick-add saves warehouse_location
    - search returns it on product row
    - POST /batches inherits product default when location omitted
    - POST /batches with explicit location overrides the default
    - PUT /batches/{id} updates location
    - PUT /products/{id}/location updates the product default (and 403 for
      non-permitted staff)."""

    inherited_batch_id: str = ""
    explicit_batch_id: str = ""

    def test_quick_add_saves_warehouse_location(self, loc_product):
        assert loc_product.get("warehouse_location") == DEFAULT_LOCATION

    def test_search_returns_warehouse_location_on_product(self, admin_hdr, loc_product):
        r = requests.get(f"{API}/warehouse/products", params={"q": LOC_SKU}, headers=admin_hdr)
        assert r.status_code == 200
        matched = next((p for p in r.json()["products"] if p["id"] == loc_product["id"]), None)
        assert matched, "location product not returned by search"
        assert matched.get("warehouse_location") == DEFAULT_LOCATION

    def test_batch_without_location_inherits_product_default(self, admin_hdr, admin_pin_token, loc_product):
        payload = {
            "product_id": loc_product["id"],
            "batch_number": f"LOC-INHERIT-{LOC_RUN_ID}",
            "boxes": 2,
            "tiles_per_box": 6,
            "extra_pieces": 0,
            # location intentionally omitted
        }
        r = requests.post(f"{API}/warehouse/batches", json=_pin(payload, admin_pin_token), headers=admin_hdr)
        assert r.status_code == 200, r.text
        b = r.json()["batch"]
        assert b.get("location") == DEFAULT_LOCATION, \
            f"batch should inherit default location '{DEFAULT_LOCATION}', got '{b.get('location')}'"
        TestWarehouseLocation.inherited_batch_id = b["id"]

        # Verify via GET /products/{id}/batches
        r2 = requests.get(f"{API}/warehouse/products/{loc_product['id']}/batches", headers=admin_hdr)
        assert r2.status_code == 200
        found = next((x for x in r2.json()["batches"] if x["id"] == b["id"]), None)
        assert found and found.get("location") == DEFAULT_LOCATION

    def test_batch_with_explicit_location_overrides_default(self, admin_hdr, admin_pin_token, loc_product):
        payload = {
            "product_id": loc_product["id"],
            "batch_number": f"LOC-EXPLICIT-{LOC_RUN_ID}",
            "boxes": 1,
            "tiles_per_box": 6,
            "extra_pieces": 0,
            "location": OVERRIDE_LOCATION,
        }
        r = requests.post(f"{API}/warehouse/batches", json=_pin(payload, admin_pin_token), headers=admin_hdr)
        assert r.status_code == 200, r.text
        b = r.json()["batch"]
        assert b.get("location") == OVERRIDE_LOCATION
        TestWarehouseLocation.explicit_batch_id = b["id"]

        # Search should surface location on each batch
        r2 = requests.get(f"{API}/warehouse/products", params={"q": LOC_SKU}, headers=admin_hdr)
        assert r2.status_code == 200
        matched = next((p for p in r2.json()["products"] if p["id"] == loc_product["id"]), None)
        assert matched
        by_id = {x["id"]: x for x in matched.get("batches", [])}
        assert by_id.get(TestWarehouseLocation.inherited_batch_id, {}).get("location") == DEFAULT_LOCATION
        assert by_id.get(TestWarehouseLocation.explicit_batch_id, {}).get("location") == OVERRIDE_LOCATION

    def test_put_batch_updates_location(self, admin_hdr, admin_pin_token):
        assert TestWarehouseLocation.inherited_batch_id, "prior test must create inherited batch"
        new_loc = "Mezzanine - Slot 7"
        r = requests.put(
            f"{API}/warehouse/batches/{TestWarehouseLocation.inherited_batch_id}",
            json=_pin({"location": new_loc}, admin_pin_token),
            headers=admin_hdr,
        )
        assert r.status_code == 200, r.text
        assert r.json()["batch"].get("location") == new_loc

    def test_put_product_default_location(self, admin_hdr, admin_pin_token, loc_product):
        new_default = "Rack B1-05"
        r = requests.put(
            f"{API}/warehouse/products/{loc_product['id']}/location",
            json=_pin({"warehouse_location": new_default}, admin_pin_token),
            headers=admin_hdr,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data.get("success") is True
        assert data.get("warehouse_location") == new_default

        # Verify persistence via search
        r2 = requests.get(f"{API}/warehouse/products", params={"q": LOC_SKU}, headers=admin_hdr)
        assert r2.status_code == 200
        matched = next((p for p in r2.json()["products"] if p["id"] == loc_product["id"]), None)
        assert matched and matched.get("warehouse_location") == new_default

    def test_put_product_location_requires_warehouse_manage(
        self, admin_hdr, test_staff, loc_product,
    ):
        # Ensure staff has no override
        requests.put(
            f"{API}/permissions/users/{test_staff['email']}/overrides",
            json={"extra_pages": [], "denied_pages": [], "extra_actions": [], "denied_actions": []},
            headers=admin_hdr,
        )
        tok = _login(test_staff["email"], test_staff["password"])
        hdr = {"Authorization": f"Bearer {tok}"}
        r = requests.put(
            f"{API}/warehouse/products/{loc_product['id']}/location",
            json={"warehouse_location": "Should-Not-Save"},
            headers=hdr,
        )
        assert r.status_code == 403, f"expected 403 without warehouse_manage, got {r.status_code} {r.text}"


# =============================================================================
# PIN SESSION FLOW (Jan 2026) — POST /pin-session mint / verify / bind
# =============================================================================
class TestPinSession:
    """POST /api/warehouse/pin-session — mint + validate token."""

    def test_valid_pin_returns_session_token(self, admin_hdr, staff_pin):
        r = requests.post(
            f"{API}/warehouse/pin-session",
            json={"pin": staff_pin["pin"]},
            headers=admin_hdr,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        for k in ("session_token", "staff_name", "staff_role", "expires_at"):
            assert k in data, f"missing {k} in response"
        assert isinstance(data["session_token"], str) and len(data["session_token"]) > 40
        assert data["staff_name"] == TEST_PIN_NAME

    def test_invalid_pin_returns_401(self, admin_hdr):
        r = requests.post(
            f"{API}/warehouse/pin-session",
            json={"pin": "000000"},   # 6 digits, almost certainly unused
            headers=admin_hdr,
        )
        assert r.status_code == 401, r.text
        assert "Invalid" in r.json().get("detail", "")

    def test_non_warehouse_manage_user_gets_403_even_with_valid_pin(
        self, admin_hdr, test_staff, staff_pin,
    ):
        # Make sure staff has no override
        requests.put(
            f"{API}/permissions/users/{test_staff['email']}/overrides",
            json={"extra_pages": [], "denied_pages": []},
            headers=admin_hdr,
        )
        tok = _login(test_staff["email"], test_staff["password"])
        hdr = {"Authorization": f"Bearer {tok}"}
        r = requests.post(
            f"{API}/warehouse/pin-session",
            json={"pin": staff_pin["pin"]},
            headers=hdr,
        )
        assert r.status_code == 403, r.text


class TestAdjustPinGate:
    """POST /api/warehouse/adjust — 401 without / with bad token, 200 with fresh."""

    def test_adjust_without_pin_token_returns_401(self, admin_hdr, a_product):
        payload = {
            "product_id": a_product["id"],
            "mode": "set",
            "quantity": 42,
            "reason": "stocktake_correction",
        }
        r = requests.post(f"{API}/warehouse/adjust", json=payload, headers=admin_hdr)
        assert r.status_code == 401, r.text
        assert "PIN" in r.json().get("detail", "")

    def test_adjust_with_tampered_token_returns_401(self, admin_hdr, a_product, admin_pin_token):
        tampered = admin_pin_token[:-4] + "XXXX"
        payload = {
            "product_id": a_product["id"],
            "mode": "set",
            "quantity": 42,
            "reason": "stocktake_correction",
            "pin_session_token": tampered,
        }
        r = requests.post(f"{API}/warehouse/adjust", json=payload, headers=admin_hdr)
        assert r.status_code == 401, r.text

    def test_adjust_with_expired_token_returns_401(self, admin_hdr, a_product):
        # Mint an already-expired token by hand using JWT_SECRET
        import jwt as _jwt
        import sys, os
        sys.path.insert(0, "/app/backend")
        from config import JWT_SECRET
        expired = _jwt.encode(
            {
                "typ": "warehouse_pin",
                "user_email": ADMIN_EMAIL,
                "staff_id": "x", "staff_name": "x", "staff_role": "x",
                "exp": 1,   # 1970
            },
            JWT_SECRET, algorithm="HS256",
        )
        payload = {
            "product_id": a_product["id"],
            "mode": "set", "quantity": 5, "reason": "other",
            "pin_session_token": expired,
        }
        r = requests.post(f"{API}/warehouse/adjust", json=payload, headers=admin_hdr)
        assert r.status_code == 401
        assert "expired" in r.json().get("detail", "").lower()

    def test_adjust_with_fresh_token_writes_authorised_by_pin(
        self, admin_hdr, admin_pin_token, a_product,
    ):
        payload = {
            "product_id": a_product["id"],
            "mode": "delta",
            "quantity": 1,
            "reason": "other",
            "note": "TEST pin-attribution",
            "pin_session_token": admin_pin_token,
        }
        r = requests.post(f"{API}/warehouse/adjust", json=payload, headers=admin_hdr)
        assert r.status_code == 200, r.text
        adj = r.json()["adjustment"]
        assert adj.get("authorised_by_pin") == TEST_PIN_NAME
        assert adj.get("authorised_by_pin_staff_id"), "staff id must be recorded"


class TestPinTokenBinding:
    """A PIN session token minted by user A cannot be used by user B."""

    def test_token_from_admin_rejected_when_used_by_staff(
        self, admin_hdr, admin_pin_token, test_staff, a_product,
    ):
        # Grant staff warehouse_manage so the failure is definitively about
        # the token binding, not the permission gate.
        requests.put(
            f"{API}/permissions/users/{test_staff['email']}/overrides",
            json={"extra_pages": ["warehouse_manage"]},
            headers=admin_hdr,
        )
        tok = _login(test_staff["email"], test_staff["password"])
        hdr = {"Authorization": f"Bearer {tok}"}
        payload = {
            "product_id": a_product["id"],
            "mode": "delta", "quantity": 0, "reason": "other",
            "pin_session_token": admin_pin_token,  # admin's token used by staff
        }
        r = requests.post(f"{API}/warehouse/adjust", json=payload, headers=hdr)
        assert r.status_code == 401, r.text
        assert "match" in r.json().get("detail", "").lower()

        # cleanup
        requests.put(
            f"{API}/permissions/users/{test_staff['email']}/overrides",
            json={"extra_pages": [], "denied_pages": []},
            headers=admin_hdr,
        )


class TestMutationPinGates:
    """Every warehouse mutation endpoint must reject requests without a
    valid PIN token (401 vs 200 with a fresh token). Also confirms
    DELETE /batches/{id} reads the token from the X-Warehouse-Pin HEADER
    (not the body)."""

    def _fresh_product(self, admin_hdr, admin_pin_token):
        sku = f"TEST-PINGATE-{uuid.uuid4().hex[:8]}"
        r = requests.post(
            f"{API}/warehouse/products/quick-add",
            json=_pin({"name": f"TEST pingate {sku}", "sku": sku}, admin_pin_token),
            headers=admin_hdr,
        )
        assert r.status_code == 200, r.text
        return r.json()["product"]

    def test_batches_post_401_without_token(self, admin_hdr, admin_pin_token):
        product = self._fresh_product(admin_hdr, admin_pin_token)
        r = requests.post(
            f"{API}/warehouse/batches",
            json={"product_id": product["id"], "batch_number": "NOPIN-1",
                  "boxes": 1, "tiles_per_box": 1, "extra_pieces": 0},
            headers=admin_hdr,
        )
        assert r.status_code == 401

    def test_batches_put_401_without_token(self, admin_hdr, admin_pin_token):
        product = self._fresh_product(admin_hdr, admin_pin_token)
        # First create a batch to have an id
        r_create = requests.post(
            f"{API}/warehouse/batches",
            json=_pin({"product_id": product["id"], "batch_number": "PIN-PUT-1",
                       "boxes": 1, "tiles_per_box": 1, "extra_pieces": 0}, admin_pin_token),
            headers=admin_hdr,
        )
        assert r_create.status_code == 200
        bid = r_create.json()["batch"]["id"]
        # PUT without token
        r = requests.put(f"{API}/warehouse/batches/{bid}", json={"boxes": 2}, headers=admin_hdr)
        assert r.status_code == 401

    def test_batches_delete_401_without_header(self, admin_hdr, admin_pin_token):
        product = self._fresh_product(admin_hdr, admin_pin_token)
        r_create = requests.post(
            f"{API}/warehouse/batches",
            json=_pin({"product_id": product["id"], "batch_number": "PIN-DEL-1",
                       "boxes": 1, "tiles_per_box": 1, "extra_pieces": 0}, admin_pin_token),
            headers=admin_hdr,
        )
        assert r_create.status_code == 200
        bid = r_create.json()["batch"]["id"]

        # No X-Warehouse-Pin header → 401
        r = requests.delete(f"{API}/warehouse/batches/{bid}", headers=admin_hdr)
        assert r.status_code == 401, r.text

        # WITH header → 200
        r2 = requests.delete(
            f"{API}/warehouse/batches/{bid}",
            headers=_pin_hdr(admin_hdr, admin_pin_token),
        )
        assert r2.status_code == 200, r2.text

    def test_quick_add_401_without_token(self, admin_hdr):
        r = requests.post(
            f"{API}/warehouse/products/quick-add",
            json={"name": "TEST no pin", "sku": f"TEST-NOPIN-{uuid.uuid4().hex[:8]}"},
            headers=admin_hdr,
        )
        assert r.status_code == 401

    def test_product_location_put_401_without_token(self, admin_hdr, admin_pin_token):
        product = self._fresh_product(admin_hdr, admin_pin_token)
        r = requests.put(
            f"{API}/warehouse/products/{product['id']}/location",
            json={"warehouse_location": "No PIN Rack"},
            headers=admin_hdr,
        )
        assert r.status_code == 401


# =============================================================================
# WAREHOUSE_OPERATOR CUSTOM ROLE (Jan 2026) — seeded on GET /roles + can adjust
# =============================================================================
class TestWarehouseOperatorRole:
    """The new `warehouse_operator` custom role must:
      1) Be seeded automatically on GET /api/permissions/roles.
      2) Contain `warehouse_manage` in its pages array.
      3) Allow a user assigned that role (with NO extra_pages) to actually
         adjust warehouse stock — exercising the new async _can_manage_async
         which reads role.pages from the DB."""

    def test_seed_on_list_roles(self, admin_hdr):
        r = requests.get(f"{API}/permissions/roles", headers=admin_hdr)
        assert r.status_code == 200, r.text
        roles = r.json()
        by_id = {row["role_id"]: row for row in roles}
        assert "warehouse_operator" in by_id, "warehouse_operator role not seeded"
        op_role = by_id["warehouse_operator"]
        assert "warehouse_manage" in (op_role.get("pages") or []), \
            f"warehouse_manage missing from warehouse_operator.pages: {op_role.get('pages')}"

    def test_operator_can_mint_pin_and_adjust(self, admin_hdr, staff_pin, a_product):
        # Ensure role exists first
        requests.get(f"{API}/permissions/roles", headers=admin_hdr)

        op_email = f"TEST_warehouse_op_{uuid.uuid4().hex[:8]}@example.com"
        op_password = "OpPass123!"
        r_u = requests.post(
            f"{API}/admin/users",
            json={
                "email": op_email, "password": op_password,
                "name": "TEST Warehouse Operator",
                "role": "staff",  # POST only accepts admin/manager/staff; upgrade below
            },
            headers=admin_hdr,
        )
        assert r_u.status_code in (200, 201), f"create op user: {r_u.status_code} {r_u.text}"
        # Upgrade to warehouse_operator via the permissions endpoint (which
        # accepts custom role_ids, unlike the create endpoint).
        r_up = requests.put(
            f"{API}/admin/users/{op_email}/permissions",
            json={"role": "warehouse_operator"},
            headers=admin_hdr,
        )
        assert r_up.status_code == 200, f"promote op: {r_up.status_code} {r_up.text}"
        try:
            tok = _login(op_email, op_password)
            hdr = {"Authorization": f"Bearer {tok}"}

            # GET /info should report can_manage=True
            r_info = requests.get(f"{API}/warehouse/info", headers=hdr)
            assert r_info.status_code == 200, r_info.text
            assert r_info.json().get("can_manage") is True, \
                "warehouse_operator should have can_manage=True"

            # Mint their own PIN session
            r_pin = requests.post(
                f"{API}/warehouse/pin-session",
                json={"pin": staff_pin["pin"]}, headers=hdr,
            )
            assert r_pin.status_code == 200, f"pin-session for op: {r_pin.status_code} {r_pin.text}"
            op_token = r_pin.json()["session_token"]

            # Adjust stock
            r_adj = requests.post(
                f"{API}/warehouse/adjust",
                json={
                    "product_id": a_product["id"],
                    "mode": "delta", "quantity": 0,
                    "reason": "stocktake_correction",
                    "note": "TEST operator role",
                    "pin_session_token": op_token,
                },
                headers=hdr,
            )
            assert r_adj.status_code == 200, f"operator adjust failed: {r_adj.status_code} {r_adj.text}"
        finally:
            try:
                requests.delete(f"{API}/admin/users/{op_email}", headers=admin_hdr)
            except Exception:
                pass

    def test_plain_staff_without_override_is_403_on_pin_session_and_adjust(
        self, admin_hdr, staff_pin, a_product,
    ):
        # Fresh throwaway staff user
        email = f"TEST_plain_staff_{uuid.uuid4().hex[:8]}@example.com"
        pw = "StaffPass123!"
        r_u = requests.post(
            f"{API}/admin/users",
            json={"email": email, "password": pw, "name": "TEST plain staff", "role": "staff"},
            headers=admin_hdr,
        )
        assert r_u.status_code in (200, 201), r_u.text
        try:
            tok = _login(email, pw)
            hdr = {"Authorization": f"Bearer {tok}"}
            # GET /info → can_manage=False
            r_info = requests.get(f"{API}/warehouse/info", headers=hdr)
            assert r_info.status_code == 200
            assert r_info.json().get("can_manage") is False, \
                "plain staff can_manage must be False"

            # /pin-session → 403
            r_pin = requests.post(
                f"{API}/warehouse/pin-session",
                json={"pin": staff_pin["pin"]}, headers=hdr,
            )
            assert r_pin.status_code == 403, r_pin.text

            # /adjust → 403 (permission check before PIN)
            r_adj = requests.post(
                f"{API}/warehouse/adjust",
                json={"product_id": a_product["id"], "mode": "set",
                      "quantity": 1, "reason": "other"},
                headers=hdr,
            )
            assert r_adj.status_code == 403, r_adj.text

            # /batches → 403
            r_b = requests.post(
                f"{API}/warehouse/batches",
                json={"product_id": a_product["id"], "batch_number": "X-1",
                      "boxes": 1, "tiles_per_box": 1, "extra_pieces": 0},
                headers=hdr,
            )
            assert r_b.status_code == 403, r_b.text
        finally:
            try:
                requests.delete(f"{API}/admin/users/{email}", headers=admin_hdr)
            except Exception:
                pass


# =============================================================================
# INFO CAN_MANAGE MATRIX (super_admin / warehouse_operator / plain staff)
# =============================================================================
class TestInfoCanManageMatrix:
    def test_super_admin_can_manage_true(self, admin_hdr):
        r = requests.get(f"{API}/warehouse/info", headers=admin_hdr)
        assert r.status_code == 200
        assert r.json().get("can_manage") is True


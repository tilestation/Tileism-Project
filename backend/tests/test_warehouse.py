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
    def test_set_mode_updates_stock_to_100(self, admin_hdr, a_product):
        payload = {
            "product_id": a_product["id"],
            "mode": "set",
            "quantity": 100,
            "reason": "delivery_received",
            "note": "TEST set 100",
        }
        r = requests.post(f"{API}/warehouse/adjust", json=payload, headers=admin_hdr)
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

    def test_delta_mode_subtracts_15(self, admin_hdr, a_product):
        # State should be 100 from previous test
        payload = {
            "product_id": a_product["id"],
            "mode": "delta",
            "quantity": -15,
            "reason": "damage_writeoff",
        }
        r = requests.post(f"{API}/warehouse/adjust", json=payload, headers=admin_hdr)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["before_qty"] == 100
        assert data["after_qty"] == 85

    def test_delta_negative_below_zero_returns_400(self, admin_hdr, a_product):
        payload = {
            "product_id": a_product["id"],
            "mode": "delta",
            "quantity": -99999,
            "reason": "stocktake_correction",
        }
        r = requests.post(f"{API}/warehouse/adjust", json=payload, headers=admin_hdr)
        assert r.status_code == 400, r.text

    def test_invalid_reason_returns_400(self, admin_hdr, a_product):
        payload = {
            "product_id": a_product["id"],
            "mode": "set",
            "quantity": 10,
            "reason": "nope_not_valid",
        }
        r = requests.post(f"{API}/warehouse/adjust", json=payload, headers=admin_hdr)
        assert r.status_code == 400

    def test_missing_product_returns_404(self, admin_hdr):
        payload = {
            "product_id": "does-not-exist-xyz-" + uuid.uuid4().hex,
            "mode": "set",
            "quantity": 5,
            "reason": "other",
        }
        r = requests.post(f"{API}/warehouse/adjust", json=payload, headers=admin_hdr)
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

    def test_staff_with_warehouse_manage_succeeds(self, admin_hdr, test_staff, a_product):
        # Grant override
        r_ovr = requests.put(
            f"{API}/permissions/users/{test_staff['email']}/overrides",
            json={"extra_pages": ["warehouse_manage"]},
            headers=admin_hdr,
        )
        assert r_ovr.status_code == 200, r_ovr.text

        tok = _login(test_staff["email"], test_staff["password"])
        hdr = {"Authorization": f"Bearer {tok}"}
        payload = {
            "product_id": a_product["id"],
            "mode": "set",
            "quantity": 50,
            "reason": "stocktake_correction",
            "note": "TEST staff-with-permission",
        }
        r = requests.post(f"{API}/warehouse/adjust", json=payload, headers=hdr)
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

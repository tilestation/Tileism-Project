"""Chingford closure — showroom soft-deactivation tests.

Covers:
- GET /api/showrooms excludes inactive by default; include_inactive=true includes them
- PATCH /api/showrooms/{id}/status (admin 200 + persisted, staff 403, 404 unknown)
- Public consumers: /api/website-admin/showrooms/public, /api/shop/stores
- Regression: Tonbridge/Gravesend/Sydenham/Warehouse still present
- Chingford document still exists (not hard-deleted)
"""
import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
API = f"{BASE_URL}/api"
CHINGFORD_ID = "cd750826-40f2-441e-89a0-af966a0df9be"
ACTIVE_NAMES = {"Tonbridge", "Gravesend", "Sydenham"}

STAFF_EMAIL = f"TEST_showroom_staff_{uuid.uuid4().hex[:8]}@example.com"
STAFF_PW = "TestPass123!"


def _login(email, pw):
    r = requests.post(f"{API}/auth/login", json={"email": email, "password": pw})
    if r.status_code != 200:
        pytest.skip(f"login failed {email}: {r.status_code} {r.text[:200]}")
    return r.json()["token"]


@pytest.fixture(scope="module")
def admin_hdr():
    return {"Authorization": f"Bearer {_login('admin@test.com', 'admin123')}"}


@pytest.fixture(scope="module")
def staff_hdr(admin_hdr):
    r = requests.post(f"{API}/admin/users", headers=admin_hdr, json={
        "email": STAFF_EMAIL, "password": STAFF_PW, "name": "TEST Showroom Staff", "role": "staff"})
    assert r.status_code in (200, 201), r.text
    yield {"Authorization": f"Bearer {_login(STAFF_EMAIL, STAFF_PW)}"}
    requests.delete(f"{API}/admin/users/{STAFF_EMAIL}", headers=admin_hdr)


@pytest.fixture(scope="module", autouse=True)
def ensure_chingford_inactive_after(admin_hdr):
    yield
    requests.patch(f"{API}/showrooms/{CHINGFORD_ID}/status", headers=admin_hdr, json={"is_active": False})


# --- EPOS showrooms list filtering ---
class TestShowroomList:
    def test_default_excludes_chingford(self, admin_hdr):
        r = requests.get(f"{API}/showrooms", headers=admin_hdr)
        assert r.status_code == 200
        names = {s["name"] for s in r.json()}
        ids = {s.get("id") for s in r.json()}
        assert "Chingford" not in names and CHINGFORD_ID not in ids
        assert ACTIVE_NAMES.issubset(names)
        assert "Tonbridge Warehouse" in names

    def test_include_inactive_has_chingford(self, admin_hdr):
        r = requests.get(f"{API}/showrooms", params={"include_inactive": "true"}, headers=admin_hdr)
        assert r.status_code == 200
        ch = [s for s in r.json() if s.get("id") == CHINGFORD_ID]
        assert len(ch) == 1, "Chingford doc must still exist (not hard-deleted)"
        assert ch[0]["is_active"] is False
        assert "_id" not in ch[0]

    def test_staff_default_list_excludes_chingford(self, staff_hdr):
        r = requests.get(f"{API}/showrooms", headers=staff_hdr)
        assert r.status_code == 200
        assert "Chingford" not in {s["name"] for s in r.json()}


# --- PATCH status endpoint ---
class TestStatusToggle:
    def test_staff_forbidden(self, staff_hdr):
        r = requests.patch(f"{API}/showrooms/{CHINGFORD_ID}/status", headers=staff_hdr, json={"is_active": True})
        assert r.status_code == 403

    def test_unauthenticated(self):
        r = requests.patch(f"{API}/showrooms/{CHINGFORD_ID}/status", json={"is_active": True})
        assert r.status_code in (401, 403)

    def test_unknown_id_404(self, admin_hdr):
        r = requests.patch(f"{API}/showrooms/does-not-exist-xyz/status", headers=admin_hdr, json={"is_active": True})
        assert r.status_code == 404

    def test_reactivate_then_deactivate(self, admin_hdr):
        r = requests.patch(f"{API}/showrooms/{CHINGFORD_ID}/status", headers=admin_hdr, json={"is_active": True})
        assert r.status_code == 200 and r.json()["is_active"] is True
        names = {s["name"] for s in requests.get(f"{API}/showrooms", headers=admin_hdr).json()}
        assert "Chingford" in names
        r = requests.patch(f"{API}/showrooms/{CHINGFORD_ID}/status", headers=admin_hdr, json={"is_active": False})
        assert r.status_code == 200 and r.json()["is_active"] is False
        names = {s["name"] for s in requests.get(f"{API}/showrooms", headers=admin_hdr).json()}
        assert "Chingford" not in names


# --- Public website consumers ---
class TestPublic:
    def test_public_showrooms(self):
        r = requests.get(f"{API}/website-admin/showrooms/public")
        assert r.status_code == 200
        data = r.json()
        items = data if isinstance(data, list) else data.get("showrooms", [])
        names = {s.get("name") for s in items}
        assert not any("Chingford" in (n or "") for n in names), names

    def test_shop_stores(self):
        r = requests.get(f"{API}/shop/stores")
        assert r.status_code == 200
        names = {s["name"] for s in r.json()}
        assert "Chingford" not in names
        assert ACTIVE_NAMES.issubset(names)
        assert "Tonbridge Warehouse" not in names

    def test_showrooms_public_endpoint(self):
        r = requests.get(f"{API}/showrooms/public")
        if r.status_code in (404, 405):
            pytest.skip("no /showrooms/public")
        assert r.status_code == 200
        assert "Chingford" not in {s.get("name") for s in r.json()}

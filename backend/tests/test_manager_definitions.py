"""Backend tests for /api/manager-definitions CRUD (Aug 2026 workspace tabs feature)."""
import os
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://feature-verification-7.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"

ADMIN_EMAIL = "admin@test.com"
ADMIN_PASSWORD = "admin123"


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=15)
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text}"
    data = r.json()
    tok = data.get("access_token") or data.get("token")
    assert tok, f"No token in login response: {data}"
    return tok


@pytest.fixture(scope="module")
def auth_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}


TEST_SLUG = "paint-test"


@pytest.fixture(scope="module", autouse=True)
def cleanup(auth_headers):
    # Pre-cleanup any leftover
    requests.delete(f"{API}/manager-definitions/{TEST_SLUG}", headers=auth_headers, timeout=15)
    yield
    requests.delete(f"{API}/manager-definitions/{TEST_SLUG}", headers=auth_headers, timeout=15)


class TestManagerDefinitions:
    def test_list_public_no_auth(self):
        r = requests.get(f"{API}/manager-definitions", timeout=15)
        assert r.status_code == 200
        body = r.json()
        assert "definitions" in body and "count" in body
        assert isinstance(body["definitions"], list)
        assert body["count"] == len(body["definitions"])

    def test_create_requires_auth(self):
        r = requests.post(f"{API}/manager-definitions", json={"name": "NoAuth"}, timeout=15)
        assert r.status_code in (401, 403), f"expected 401/403, got {r.status_code}"

    def test_create_success(self, auth_headers):
        payload = {"name": "Paint Test", "theme": "emerald", "sub_categories": ["paint", "primer"]}
        r = requests.post(f"{API}/manager-definitions", json=payload, headers=auth_headers, timeout=15)
        assert r.status_code == 200, f"{r.status_code} {r.text}"
        doc = r.json()
        assert doc["slug"] == TEST_SLUG
        assert doc["name"] == "Paint Test"
        assert doc["theme"] == "emerald"
        assert doc["product_group"] == TEST_SLUG
        assert "id" in doc and doc["id"]
        assert "created_at" in doc
        assert doc.get("created_by") == ADMIN_EMAIL
        assert doc["sub_categories"] == ["paint", "primer"]

    def test_get_by_slug(self):
        r = requests.get(f"{API}/manager-definitions/{TEST_SLUG}", timeout=15)
        assert r.status_code == 200
        doc = r.json()
        assert doc["slug"] == TEST_SLUG
        assert doc["name"] == "Paint Test"

    def test_duplicate_slug_409(self, auth_headers):
        r = requests.post(f"{API}/manager-definitions", json={"name": "Paint Test"}, headers=auth_headers, timeout=15)
        assert r.status_code == 409, f"{r.status_code} {r.text}"

    def test_patch_update_description(self, auth_headers):
        r = requests.patch(
            f"{API}/manager-definitions/{TEST_SLUG}",
            json={"description": "Updated desc"},
            headers=auth_headers, timeout=15,
        )
        assert r.status_code == 200
        assert r.json()["description"] == "Updated desc"
        # GET verifies persistence
        g = requests.get(f"{API}/manager-definitions/{TEST_SLUG}", timeout=15)
        assert g.json()["description"] == "Updated desc"

    def test_appears_in_list(self):
        r = requests.get(f"{API}/manager-definitions", timeout=15)
        slugs = [d["slug"] for d in r.json()["definitions"]]
        assert TEST_SLUG in slugs

    def test_delete_soft_deletes(self, auth_headers):
        r = requests.delete(f"{API}/manager-definitions/{TEST_SLUG}", headers=auth_headers, timeout=15)
        assert r.status_code == 200
        # GET should now 404
        g = requests.get(f"{API}/manager-definitions/{TEST_SLUG}", timeout=15)
        assert g.status_code == 404
        # And not appear in list
        lst = requests.get(f"{API}/manager-definitions", timeout=15).json()
        slugs = [d["slug"] for d in lst["definitions"]]
        assert TEST_SLUG not in slugs


class TestDeletedAtNoneFilter:
    """Regression: docs with `deleted_at: None` (explicit None, not missing) must
    still be excluded from public GET list. Verifies the new $or filter."""

    SEED_SLUG = "test-deleted-at-none-regression"

    def _get_db(self):
        from pymongo import MongoClient
        mongo_url = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
        db_name = os.environ.get("DB_NAME", "tile_station")
        return MongoClient(mongo_url)[db_name]

    def test_deleted_at_none_alive_and_deleted(self, auth_headers):
        from datetime import datetime, timezone
        import uuid
        db = self._get_db()
        # Cleanup any leftover
        db.manager_definitions.delete_many({"slug": self.SEED_SLUG})

        # 1) Seed an ALIVE doc with deleted_at: None explicitly present
        alive_doc = {
            "id": str(uuid.uuid4()),
            "slug": self.SEED_SLUG,
            "name": "Deleted-At-None Regression",
            "description": None,
            "theme": "purple",
            "icon": "Sparkles",
            "sub_categories": [],
            "field_definitions": [],
            "product_group": self.SEED_SLUG,
            "created_at": datetime.now(timezone.utc),
            "created_by": "seed",
            "updated_at": datetime.now(timezone.utc),
            "deleted_at": None,   # <-- the key point: explicit None, not missing
        }
        db.manager_definitions.insert_one(dict(alive_doc))

        try:
            # It SHOULD appear in list (deleted_at:None is alive)
            r = requests.get(f"{API}/manager-definitions", timeout=15)
            assert r.status_code == 200
            slugs = [d["slug"] for d in r.json()["definitions"]]
            assert self.SEED_SLUG in slugs, "alive doc with deleted_at:None must appear in list"

            # It SHOULD be gettable
            g = requests.get(f"{API}/manager-definitions/{self.SEED_SLUG}", timeout=15)
            assert g.status_code == 200

            # 2) Now flip deleted_at to a real timestamp — should disappear
            db.manager_definitions.update_one(
                {"slug": self.SEED_SLUG},
                {"$set": {"deleted_at": datetime.now(timezone.utc)}},
            )
            r2 = requests.get(f"{API}/manager-definitions", timeout=15)
            slugs2 = [d["slug"] for d in r2.json()["definitions"]]
            assert self.SEED_SLUG not in slugs2, "doc with deleted_at:<ts> must be excluded"

            g2 = requests.get(f"{API}/manager-definitions/{self.SEED_SLUG}", timeout=15)
            assert g2.status_code == 404
        finally:
            db.manager_definitions.delete_many({"slug": self.SEED_SLUG})

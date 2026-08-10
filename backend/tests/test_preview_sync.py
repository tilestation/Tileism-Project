"""Backend tests for /api/supplier-sync/preview-sync/* endpoints.

Covers export whitelist guards, pull auth + self-guard + unreachable, and status.
"""
import os
import pytest
import requests
from pathlib import Path


def _load_frontend_env():
    env_file = Path("/app/frontend/.env")
    for line in env_file.read_text().splitlines():
        if line.startswith("REACT_APP_BACKEND_URL="):
            return line.split("=", 1)[1].strip().strip('"')
    return None


BASE_URL = (os.environ.get("REACT_APP_BACKEND_URL") or _load_frontend_env()).rstrip("/")


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": "admin@test.com", "password": "admin123"},
        timeout=30,
    )
    if r.status_code != 200:
        pytest.skip(f"admin login failed: {r.status_code} {r.text[:120]}")
    tok = r.json().get("access_token") or r.json().get("token")
    if not tok:
        pytest.skip("no token in admin login response")
    return tok


@pytest.fixture(scope="module")
def auth_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}


class TestPreviewSyncExport:
    """Export endpoint whitelist + shape."""

    def test_export_allowed_collection(self):
        r = requests.get(
            f"{BASE_URL}/api/supplier-sync/preview-sync/export",
            params={"collection": "category_groups", "limit": 2},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert "total" in data and isinstance(data["total"], int)
        assert "count" in data and isinstance(data["count"], int)
        assert "docs" in data and isinstance(data["docs"], list)
        assert data["count"] <= 2
        # No mongo _id leakage
        for d in data["docs"]:
            assert "_id" not in d

    def test_export_rejects_non_whitelisted(self):
        r = requests.get(
            f"{BASE_URL}/api/supplier-sync/preview-sync/export",
            params={"collection": "shop_orders", "limit": 1},
            timeout=30,
        )
        assert r.status_code == 400
        assert "not allowed" in r.text.lower() or "choose from" in r.text.lower()

    def test_export_each_whitelisted_collection_returns_200(self):
        for coll in [
            "supplier_products", "tiles", "website_categories",
            "category_groups", "navigation_menus", "page_banners",
        ]:
            r = requests.get(
                f"{BASE_URL}/api/supplier-sync/preview-sync/export",
                params={"collection": coll, "limit": 1},
                timeout=30,
            )
            assert r.status_code == 200, f"{coll} → {r.status_code} {r.text[:100]}"


class TestPreviewSyncPull:
    """Pull endpoint auth + self-guard + unreachable-source."""

    def test_pull_unauthenticated_forbidden(self):
        r = requests.post(
            f"{BASE_URL}/api/supplier-sync/preview-sync/pull",
            json={"source_url": "https://www.tilestation.co.uk"},
            timeout=30,
        )
        # No auth header at all → 401 or 403 depending on middleware
        assert r.status_code in (401, 403), f"expected 401/403, got {r.status_code}"

    def test_pull_refuses_self(self, auth_headers):
        r = requests.post(
            f"{BASE_URL}/api/supplier-sync/preview-sync/pull",
            json={"source_url": BASE_URL},
            headers=auth_headers,
            timeout=30,
        )
        assert r.status_code == 400, r.text
        assert "itself" in r.text.lower() or "same site" in r.text.lower()

    def test_pull_unreachable_source(self, auth_headers):
        r = requests.post(
            f"{BASE_URL}/api/supplier-sync/preview-sync/pull",
            json={"source_url": "https://nonexistent-domain-xyz123.co.uk"},
            headers=auth_headers,
            timeout=60,
        )
        assert r.status_code == 400, r.text
        assert "could not reach" in r.text.lower() or "responded" in r.text.lower()

    def test_pull_bad_scheme(self, auth_headers):
        r = requests.post(
            f"{BASE_URL}/api/supplier-sync/preview-sync/pull",
            json={"source_url": "ftp://example.com"},
            headers=auth_headers,
            timeout=30,
        )
        assert r.status_code == 400


class TestPreviewSyncStatus:
    def test_status_returns_doc(self):
        r = requests.get(
            f"{BASE_URL}/api/supplier-sync/preview-sync/status", timeout=30,
        )
        assert r.status_code == 200
        data = r.json()
        # Either idle or a real status doc
        assert "state" in data
        # If a prior pull ran, expect collections dict
        if data.get("state") in ("done", "running", "error"):
            assert "collections" in data or "error" in data

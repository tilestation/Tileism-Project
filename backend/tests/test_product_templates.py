"""Backend regression tests for Session C: Product Templates + manager-definitions co-existence.

Verifies /api/product-templates CRUD + convenience `from-product` + /use + soft-delete,
and that GET /api/manager-definitions still works (no route collision).
"""
import os
import requests
import pytest
from dotenv import load_dotenv
from pathlib import Path

load_dotenv(Path(__file__).resolve().parents[1] / ".env")
BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/") or os.environ.get("FRONTEND_URL", "https://feature-verification-7.preview.emergentagent.com").rstrip("/")


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": "admin@test.com", "password": "admin123"}, timeout=30)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text[:200]}"
    tok = r.json().get("token") or r.json().get("access_token")
    assert tok, f"no token in {r.json()}"
    return tok


@pytest.fixture(scope="module")
def headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def created_slug():
    return {"slug": None}


class TestProductTemplates:

    def test_list_initial(self, headers):
        r = requests.get(f"{BASE_URL}/api/product-templates", timeout=30)
        assert r.status_code == 200, r.text[:200]
        data = r.json()
        assert "templates" in data and "count" in data
        assert isinstance(data["templates"], list)
        assert data["count"] == len(data["templates"])

    def test_create_template(self, headers, created_slug):
        r = requests.post(f"{BASE_URL}/api/product-templates", headers=headers,
                          json={"name": "TEST Template", "product_group": "tiles",
                                "fields": {"size": "600x600", "material": "Porcelain"}}, timeout=30)
        assert r.status_code == 200, r.text[:300]
        doc = r.json()
        assert doc["slug"] == "test-template" or doc["slug"].startswith("test-template")
        assert doc["name"] == "TEST Template"
        assert doc["product_group"] == "tiles"
        assert doc["fields"].get("size") == "600x600"
        assert doc["fields"].get("material") == "Porcelain"
        assert doc.get("id")
        assert doc.get("created_by") == "admin@test.com"
        assert doc.get("usage_count") == 0
        created_slug["slug"] = doc["slug"]

    def test_get_by_slug(self, headers, created_slug):
        assert created_slug["slug"]
        r = requests.get(f"{BASE_URL}/api/product-templates/{created_slug['slug']}", timeout=30)
        assert r.status_code == 200, r.text[:200]
        assert r.json()["slug"] == created_slug["slug"]

    def test_filter_by_group(self, headers, created_slug):
        r = requests.get(f"{BASE_URL}/api/product-templates?product_group=tiles", timeout=30)
        assert r.status_code == 200
        slugs = [t["slug"] for t in r.json()["templates"]]
        assert created_slug["slug"] in slugs

    def test_from_product_excludes_blocked_fields(self, headers, created_slug):
        # Pick a real SKU
        r = requests.get(f"{BASE_URL}/api/supplier-sync/products?limit=5", headers=headers, timeout=60)
        if r.status_code != 200:
            pytest.skip(f"supplier-sync/products not accessible: {r.status_code}")
        data = r.json()
        products = data.get("products") or data.get("items") or []
        if not products:
            pytest.skip("no products to derive template from")
        sku = products[0].get("sku") or products[0].get("supplier_code")
        assert sku, "no sku on first product"

        r = requests.post(f"{BASE_URL}/api/product-templates/from-product", headers=headers,
                          json={"sku": sku, "name": "TEST From SKU"}, timeout=30)
        assert r.status_code == 200, r.text[:300]
        doc = r.json()
        fields = doc.get("fields") or {}
        for blocked in ("sku", "list_price", "retail_price", "cost_price", "stock", "stock_qty", "images", "_id"):
            assert blocked not in fields, f"blocked field '{blocked}' leaked into template.fields"
        assert doc.get("source_sku") == sku
        # cleanup this second template
        requests.delete(f"{BASE_URL}/api/product-templates/{doc['slug']}", headers=headers, timeout=30)

    def test_use_increments_counter(self, headers, created_slug):
        slug = created_slug["slug"]
        r = requests.post(f"{BASE_URL}/api/product-templates/{slug}/use", headers=headers, timeout=30)
        assert r.status_code == 200, r.text[:200]
        # verify
        r2 = requests.get(f"{BASE_URL}/api/product-templates/{slug}", timeout=30)
        assert r2.json().get("usage_count") == 1

    def test_delete_soft(self, headers, created_slug):
        slug = created_slug["slug"]
        r = requests.delete(f"{BASE_URL}/api/product-templates/{slug}", headers=headers, timeout=30)
        assert r.status_code == 200
        assert r.json().get("ok") is True
        # get should now 404
        r2 = requests.get(f"{BASE_URL}/api/product-templates/{slug}", timeout=30)
        assert r2.status_code == 404
        # list should not include it
        r3 = requests.get(f"{BASE_URL}/api/product-templates", timeout=30)
        slugs = [t["slug"] for t in r3.json()["templates"]]
        assert slug not in slugs

    def test_auth_required_for_create(self):
        r = requests.post(f"{BASE_URL}/api/product-templates",
                          json={"name": "X", "product_group": "tiles", "fields": {}}, timeout=30)
        assert r.status_code in (401, 403)


class TestManagerDefinitionsRegression:
    def test_still_returns_ok(self):
        r = requests.get(f"{BASE_URL}/api/manager-definitions", timeout=30)
        assert r.status_code == 200, r.text[:200]
        data = r.json()
        assert "definitions" in data and "count" in data
        assert isinstance(data["definitions"], list)

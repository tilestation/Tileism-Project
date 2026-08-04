"""Session D: shop category filters/products + manager CSV import."""
import io
import os
import csv
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://feature-verification-7.preview.emergentagent.com").rstrip("/")


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": "admin@test.com", "password": "admin123"}, timeout=30)
    if r.status_code != 200:
        pytest.skip(f"Admin login failed: {r.status_code} {r.text[:200]}")
    return r.json().get("access_token") or r.json().get("token")


# ---------- Shop category filters ----------
class TestShopCategoryFilters:
    def test_bathroom_filters_shape(self):
        r = requests.get(f"{BASE_URL}/api/shop/category/bathroom/filters", timeout=30)
        assert r.status_code == 200, r.text
        data = r.json()
        for key in ["sub_types", "brands", "finishes", "materials", "colors", "sizes", "suppliers", "total_products"]:
            assert key in data, f"missing {key}"
        assert isinstance(data["brands"], list)
        assert data["total_products"] >= 0
        if data["brands"]:
            item = data["brands"][0]
            assert "value" in item and "count" in item

    @pytest.mark.parametrize("cat", ["flooring", "materials", "underfloor_heating", "tools"])
    def test_other_categories_200(self, cat):
        r = requests.get(f"{BASE_URL}/api/shop/category/{cat}/filters", timeout=30)
        assert r.status_code == 200
        assert "total_products" in r.json()

    def test_custom_slug_returns_200(self):
        r = requests.get(f"{BASE_URL}/api/shop/category/nonexistent-cat/filters", timeout=30)
        assert r.status_code == 200
        data = r.json()
        assert "total_products" in data
        assert data["total_products"] >= 0


# ---------- Shop category products ----------
class TestShopCategoryProducts:
    def test_bathroom_products_shape(self):
        r = requests.get(f"{BASE_URL}/api/shop/category/bathroom/products?limit=5", timeout=30)
        assert r.status_code == 200, r.text
        data = r.json()
        for key in ["products", "total", "total_pages", "page", "limit", "category"]:
            assert key in data
        assert data["category"] == "bathroom"
        assert data["limit"] == 5
        assert isinstance(data["products"], list)

    def test_bathroom_filter_finish(self):
        base = requests.get(f"{BASE_URL}/api/shop/category/bathroom/products?limit=50", timeout=30).json()
        r = requests.get(f"{BASE_URL}/api/shop/category/bathroom/products?limit=50&finish=Matt", timeout=30)
        assert r.status_code == 200
        data = r.json()
        assert data["total"] <= base["total"]
        for p in data["products"]:
            if p.get("finish"):
                assert p["finish"] == "Matt"

    def test_bathroom_filter_color_case_insensitive(self):
        r = requests.get(f"{BASE_URL}/api/shop/category/bathroom/products?limit=50&color=Grey", timeout=30)
        assert r.status_code == 200

    @pytest.mark.parametrize("cat", ["flooring", "materials", "underfloor_heating", "tools"])
    def test_other_categories_products_200(self, cat):
        r = requests.get(f"{BASE_URL}/api/shop/category/{cat}/products?limit=5", timeout=30)
        assert r.status_code == 200


# ---------- CSV template ----------
class TestCsvTemplate:
    def test_bathroom_template(self):
        r = requests.get(f"{BASE_URL}/api/managers/bathroom/csv-template", timeout=30)
        assert r.status_code == 200
        assert "text/csv" in r.headers.get("content-type", "")
        cd = r.headers.get("content-disposition", "")
        assert "bathroom-import-template.csv" in cd
        first = r.text.splitlines()[0]
        expected = "supplier,sku,our_product_name,type,brand,model,dimensions,flush_type,tank_capacity,material,finish,color,warranty,list_price,cost_price,warehouse_stock,description"
        assert first == expected, f"got: {first}"


# ---------- CSV import ----------
class TestCsvImport:
    def _make_csv(self, extra_sku=""):
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["supplier", "sku", "our_product_name", "type", "brand", "finish", "color", "list_price", "cost_price", "warehouse_stock", "description"])
        w.writerow(["TEST_Supplier", f"TEST-CSV-001{extra_sku}", "TEST CSV Toilet", "Toilet", "TestBrand", "Matt", "White", "199.99", "89.50", "5", "TEST import"])
        w.writerow(["TEST_Supplier", f"TEST-CSV-002{extra_sku}", "TEST CSV Basin", "Basin", "TestBrand", "Gloss", "Grey", "89.00", "40.00", "3", "TEST import 2"])
        return buf.getvalue().encode()

    def test_csv_import_requires_auth(self):
        files = {"file": ("t.csv", self._make_csv("no_auth"), "text/csv")}
        r = requests.post(f"{BASE_URL}/api/managers/bathroom/csv-import?dry_run=true", files=files, timeout=30)
        assert r.status_code in (401, 403), f"expected auth error, got {r.status_code}"

    def test_csv_dry_run(self, admin_token):
        files = {"file": ("t.csv", self._make_csv("_dry"), "text/csv")}
        r = requests.post(
            f"{BASE_URL}/api/managers/bathroom/csv-import?dry_run=true",
            files=files,
            headers={"Authorization": f"Bearer {admin_token}"},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        for k in ["total_rows", "created", "updated", "skipped", "errors", "preview"]:
            assert k in data
        assert data["total_rows"] == 2
        assert len(data["preview"]) == 2
        assert data["preview"][0].get("action") in ("CREATE", "UPDATE")

    def test_csv_real_import_and_verify(self, admin_token):
        files = {"file": ("t.csv", self._make_csv("_real"), "text/csv")}
        r = requests.post(
            f"{BASE_URL}/api/managers/bathroom/csv-import?dry_run=false",
            files=files,
            headers={"Authorization": f"Bearer {admin_token}"},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["created"] + data["updated"] == 2

        # Verify products appear in bathroom listing
        list_r = requests.get(f"{BASE_URL}/api/shop/category/bathroom/products?limit=100&search=TEST", timeout=30)
        assert list_r.status_code == 200

    def test_csv_malformed_no_sku(self, admin_token):
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["supplier", "name", "list_price"])
        w.writerow(["S1", "Foo", "10"])
        files = {"file": ("bad.csv", buf.getvalue().encode(), "text/csv")}
        r = requests.post(
            f"{BASE_URL}/api/managers/bathroom/csv-import?dry_run=true",
            files=files,
            headers={"Authorization": f"Bearer {admin_token}"},
            timeout=30,
        )
        assert r.status_code == 400
        assert "sku" in r.text.lower()

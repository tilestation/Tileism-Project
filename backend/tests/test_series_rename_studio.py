"""Series Rename Studio backend tests — series-list, series-products, apply (with restore)."""
import os

import pytest
import requests
from dotenv import dotenv_values

frontend_env = dotenv_values("/app/frontend/.env")
base_url = os.environ.get("REACT_APP_BACKEND_URL") or frontend_env.get("REACT_APP_BACKEND_URL")
if not base_url:
    raise RuntimeError("REACT_APP_BACKEND_URL missing")
BASE_URL = base_url.rstrip("/")
PNS = f"{BASE_URL}/api/product-name-sanity"

ADMIN_EMAIL = "admin@test.com"
ADMIN_PASSWORD = "admin123"


@pytest.fixture(scope="module")
def client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    r = s.post(f"{BASE_URL}/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=60)
    if r.status_code != 200:
        pytest.fail(f"Admin login failed {r.status_code}: {r.text[:300]}")
    token = r.json().get("token")
    if not token:
        pytest.fail(f"No 'token' in login response: {r.text[:300]}")
    s.headers.update({"Authorization": f"Bearer {token}"})
    return s


# ---------- series-list ----------
class TestSeriesList:
    def test_requires_auth(self):
        r = requests.get(f"{PNS}/series-list", timeout=60)
        assert r.status_code in (401, 403), f"unauthenticated call returned {r.status_code}"

    def test_series_list_sorted_desc(self, client):
        r = client.get(f"{PNS}/series-list", timeout=120)
        assert r.status_code == 200, r.text[:300]
        data = r.json()
        assert "series" in data and isinstance(data["series"], list)
        series = data["series"]
        assert len(series) > 0
        counts = [s["count"] for s in series]
        assert counts == sorted(counts, reverse=True), "not sorted by count desc"
        for s in series[:5]:
            assert isinstance(s["name"], str) and s["name"].strip() != ""
            assert isinstance(s["count"], int)
        names = [s["name"] for s in series]
        assert "Dolomite Onyx" in names
        assert series[0]["name"] == "Dolomite Onyx", f"top series is {series[0]}"
        assert series[0]["count"] == 23, f"Dolomite Onyx count={series[0]['count']}"

    def test_series_list_query_filter(self, client):
        r = client.get(f"{PNS}/series-list", params={"q": "dolomite"}, timeout=120)
        assert r.status_code == 200, r.text[:300]
        rows = r.json()["series"]
        assert len(rows) > 0
        assert all("dolomite" in s["name"].lower() for s in rows)


# ---------- series-products ----------
class TestSeriesProducts:
    def test_dolomite_onyx_rows(self, client):
        r = client.get(f"{PNS}/series-products", params={"series": "Dolomite Onyx"}, timeout=120)
        assert r.status_code == 200, r.text[:300]
        data = r.json()
        assert data["series"] == "Dolomite Onyx"
        assert data["count"] == 23, f"count={data['count']}"
        rows = data["rows"]
        assert len(rows) == 23
        for row in rows:
            assert row["sku"], f"row missing sku: {row}"
            assert "supplier" in row
            assert "product_name" in row
            assert isinstance(row["parts"], dict)
            assert set(["color", "size", "finish"]).issubset(row["parts"].keys())
            assert isinstance(row["standardised_name"], str)
            assert "_id" not in row

    def test_name_first_extraction_lp3631(self, client):
        r = client.get(f"{PNS}/series-products", params={"series": "Dolomite Onyx"}, timeout=120)
        assert r.status_code == 200
        by_sku = {row["sku"]: row for row in r.json()["rows"]}
        assert "LP-3631" in by_sku, f"LP-3631 missing; skus={list(by_sku)[:25]}"
        row = by_sku["LP-3631"]
        assert row["product_name"] == "Dolomite Onyx Blanco 30x60cm Polished", row["product_name"]
        assert row["parts"]["color"] == "Blanco", row["parts"]
        assert row["parts"]["size"] == "30x60cm", row["parts"]
        assert row["parts"]["finish"] == "Polished", row["parts"]
        # DB attribute is stale ('bianco') but name wins
        assert (row.get("attr_color") or "").lower() == "bianco", row.get("attr_color")
        assert row["standardised_name"] == "Dolomite Onyx Blanco 30x60cm Polished"

    def test_missing_series_param_422(self, client):
        r = client.get(f"{PNS}/series-products", timeout=60)
        assert r.status_code == 422, r.status_code

    def test_unknown_series_returns_empty(self, client):
        r = client.get(f"{PNS}/series-products", params={"series": "TEST_NoSuchSeries_ZZZ"}, timeout=60)
        assert r.status_code == 200
        assert r.json()["count"] == 0


# ---------- apply (rename + restore) ----------
class TestApplyRename:
    TARGET_SKU = "LP-1132"

    def _get_row(self, client, sku):
        r = client.get(f"{PNS}/series-products", params={"series": "Dolomite Onyx"}, timeout=120)
        assert r.status_code == 200, r.text[:300]
        return {row["sku"]: row for row in r.json()["rows"]}.get(sku)

    def test_apply_rename_and_restore(self, client):
        original = self._get_row(client, self.TARGET_SKU)
        assert original is not None, f"{self.TARGET_SKU} not found in Dolomite Onyx"
        orig_name = original["product_name"]
        supplier = original["supplier"]
        new_name = f"{orig_name} TESTRENAME_API"

        try:
            r = client.post(f"{PNS}/apply", json={"items": [
                {"sku": self.TARGET_SKU, "supplier": supplier, "new_name": new_name}
            ]}, timeout=120)
            assert r.status_code == 200, r.text[:300]
            body = r.json()
            assert body["ok"] is True
            assert body["updated"] == 1, body
            assert body["failed"] == [], body

            # verify persistence via re-fetch
            after = self._get_row(client, self.TARGET_SKU)
            assert after["product_name"] == new_name, after["product_name"]
        finally:
            # RESTORE original name
            r2 = client.post(f"{PNS}/apply", json={"items": [
                {"sku": self.TARGET_SKU, "supplier": supplier, "new_name": orig_name}
            ]}, timeout=120)
            assert r2.status_code == 200, r2.text[:300]
            assert r2.json()["updated"] == 1
            restored = self._get_row(client, self.TARGET_SKU)
            assert restored["product_name"] == orig_name, "FAILED TO RESTORE ORIGINAL NAME"

    def test_apply_unknown_sku_reports_failed(self, client):
        r = client.post(f"{PNS}/apply", json={"items": [
            {"sku": "TEST_NOPE_SKU_ZZZ", "new_name": "TEST_Some Name"}
        ]}, timeout=60)
        assert r.status_code == 200, r.text[:300]
        body = r.json()
        assert body["updated"] == 0
        assert body["failed"] and body["failed"][0]["reason"] == "not_found"

    def test_apply_validation_short_name(self, client):
        r = client.post(f"{PNS}/apply", json={"items": [
            {"sku": self.TARGET_SKU, "new_name": "ab"}
        ]}, timeout=60)
        assert r.status_code == 422, r.status_code

    def test_apply_requires_auth(self):
        r = requests.post(f"{PNS}/apply", json={"items": []}, timeout=60)
        assert r.status_code in (401, 403), r.status_code


# ---------- regression: flagged names report ----------
class TestFlaggedReportRegression:
    def test_report_loads(self, client):
        r = client.get(f"{PNS}/report", params={"limit": 50}, timeout=180)
        assert r.status_code == 200, r.text[:300]
        data = r.json()
        for key in ("rows", "total_scanned", "total_flagged", "issue_counts", "supplier_counts"):
            assert key in data, f"missing {key}"
        assert isinstance(data["rows"], list)

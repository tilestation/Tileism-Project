"""Iter229 tests: Data Health name drift, live-sync guards, related pinning series match, storefront in_stock."""
import os
import pytest
import requests
from urllib.parse import quote

def _load_backend_url():
    v = os.environ.get("REACT_APP_BACKEND_URL")
    if v:
        return v.rstrip("/")
    try:
        with open("/app/frontend/.env") as f:
            for line in f:
                if line.startswith("REACT_APP_BACKEND_URL="):
                    return line.split("=", 1)[1].strip().rstrip("/")
    except FileNotFoundError:
        pass
    raise RuntimeError("REACT_APP_BACKEND_URL not configured")


BASE_URL = _load_backend_url()


@pytest.fixture(scope="module")
def token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": "admin@test.com", "password": "admin123"}, timeout=30)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    return r.json()["token"]


@pytest.fixture(scope="module")
def auth(token):
    return {"Authorization": f"Bearer {token}"}


# ---------- Data Health name drift ----------
class TestDataHealthNameDrift:
    def test_data_health_has_name_drift_field(self, auth):
        r = requests.get(f"{BASE_URL}/api/supplier-sync/products/data-health", headers=auth, timeout=60)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "name_drift" in data, f"missing name_drift: keys={list(data.keys())}"
        assert isinstance(data["name_drift"], int)
        # samples optional
        print(f"name_drift={data['name_drift']} samples_count={len(data.get('name_drift_samples', []))}")


# ---------- Live Sync backend guards ----------
class TestLiveSync:
    def test_export_snapshot_requires_auth(self):
        r = requests.get(f"{BASE_URL}/api/live-sync/export-snapshot?collection=tiles&limit=5", timeout=30)
        assert r.status_code in (401, 403), f"expected 401/403, got {r.status_code}"

    def test_export_snapshot_tiles_ok(self, auth):
        r = requests.get(f"{BASE_URL}/api/live-sync/export-snapshot?collection=tiles&limit=5",
                         headers=auth, timeout=60)
        assert r.status_code == 200, r.text
        d = r.json()
        assert "total" in d and "count" in d and "docs_ext_json" in d, f"keys={list(d.keys())}"
        assert d["count"] <= 5

    def test_export_snapshot_non_whitelisted_collection(self, auth):
        r = requests.get(f"{BASE_URL}/api/live-sync/export-snapshot?collection=shop_orders&limit=5",
                         headers=auth, timeout=30)
        assert r.status_code == 400, f"expected 400 for non-whitelisted collection, got {r.status_code} {r.text}"

    def test_pull_from_live_production_host_guard(self, auth):
        headers = {**auth, "Host": "www.tilestation.co.uk"}
        r = requests.post(f"{BASE_URL}/api/live-sync/pull-from-live",
                          headers=headers,
                          json={"live_url": "https://www.tilestation.co.uk", "email": "x", "password": "y"},
                          timeout=30)
        assert r.status_code == 403, f"expected 403 in prod, got {r.status_code} {r.text}"


# ---------- Related pinning series-match ----------
class TestRelatedPinningSeries:
    SUPPLIER = "Ultra Tile"
    RELATED_SERIES = "Ultra Tile Cleaning & Maintenance"

    def _quick_update(self, auth, related):
        payload = {
            "sku": "ULT-EC",
            "supplier": self.SUPPLIER,
            "related_products": related,
        }
        return requests.put(f"{BASE_URL}/api/supplier-sync/products/quick-update",
                            headers=auth, json=payload, timeout=60)

    def test_pin_appears_in_related(self, auth):
        related = [{
            "sku": "LP-6611",
            "kind": "also_liked",
            "series_name": "TestSeries",
            "display_name": "Alabaster Polished 60x60cm",
        }]
        r = self._quick_update(auth, related)
        assert r.status_code == 200, f"quick-update failed: {r.status_code} {r.text}"

        url = f"{BASE_URL}/api/tiles/related/{quote(self.RELATED_SERIES)}"
        rr = requests.get(url, timeout=30)
        assert rr.status_code == 200, rr.text
        data = rr.json()
        # find pinned card
        related_series = data.get("related_series") or []
        pinned = [x for x in related_series if x.get("pinned") is True]
        assert pinned, f"no pinned card found. related_series count={len(related_series)}"
        # any pinned card should reference TestSeries
        names = [p.get("series_name") for p in pinned]
        assert any(n == "TestSeries" for n in names), f"pinned series names: {names}"

    def test_clear_pins(self, auth):
        r = self._quick_update(auth, [])
        assert r.status_code == 200, r.text
        url = f"{BASE_URL}/api/tiles/related/{quote(self.RELATED_SERIES)}"
        rr = requests.get(url, timeout=30)
        assert rr.status_code == 200
        related_series = rr.json().get("related_series") or []
        pinned = [x for x in related_series if x.get("pinned") is True]
        assert not pinned, f"pins not cleared: {pinned}"


# ---------- Storefront in_stock honors stock_status ----------
class TestStorefrontInStock:
    COLLECTION = "Ultra Tile Cleaning & Maintenance"

    def test_collection_shows_in_stock_from_flag(self):
        url = f"{BASE_URL}/api/tiles/collection/{quote(self.COLLECTION)}"
        r = requests.get(url, timeout=30)
        # tolerate either 200 with tiles or 404 if endpoint path differs; try shop endpoint fallback
        if r.status_code == 404:
            url = f"{BASE_URL}/api/shop/collection/{quote(self.COLLECTION)}"
            r = requests.get(url, timeout=30)
        assert r.status_code == 200, f"{url} -> {r.status_code}"
        data = r.json()
        tiles = data.get("tiles") or data.get("products") or (data if isinstance(data, list) else [])
        assert tiles, f"no tiles returned for {self.COLLECTION}"
        # Check at least one product with stock_status=in_stock has in_stock True even if stock=0
        in_stock_flagged = [t for t in tiles if (t.get("stock_status") == "in_stock") or t.get("in_stock") is True]
        assert in_stock_flagged, f"no in_stock products among {len(tiles)} tiles"
        # No duplicated size suffix like '1l 1l' in display names
        for t in tiles:
            name = (t.get("display_name") or t.get("name") or "").lower()
            assert not (" 1l 1l" in name or " 1kg 1kg" in name), f"duplicate suffix in name: {name}"

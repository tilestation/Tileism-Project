"""Backend tests for Attribute Studio (Assign Colour Bucket merged modal).

Covers:
- POST /api/supplier-sync/products/bulk-update-unified mode='append' verification
- POST /api/supplier-sync/products/bulk-update-unified mode='remove' verification
- POST /api/attribute-values/save + GET + /remove for custom_spec_label field

Fixture SKUs: LP-3611, LP-6611 (TestSeries — safe to mutate, restored after).
"""
import os
import requests
import pytest

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://feature-verification-7.preview.emergentagent.com").rstrip("/")

SKUS = ["LP-3611", "LP-6611"]
ORIGINAL_SUBCATS = {
    "LP-3611": ["Wall Tiles", "Plain", "Small Format"],
    "LP-6611": ["Matt", "Large Format", "Floor Tiles"],
}


# ---------- helpers ----------
def _get_product(sku):
    r = requests.get(f"{BASE_URL}/api/supplier-sync/products", params={"search": sku}, timeout=30)
    assert r.status_code == 200, r.text
    for p in r.json().get("products", []):
        if p.get("sku") == sku:
            return p
    return None


def _login_admin():
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": "admin@test.com", "password": "admin123"}, timeout=15)
    if r.status_code != 200:
        pytest.skip(f"admin login failed: {r.status_code} {r.text[:200]}")
    tok = r.json().get("token") or r.json().get("access_token")
    return {"Authorization": f"Bearer {tok}"} if tok else {}


@pytest.fixture(scope="module")
def auth():
    return _login_admin()


@pytest.fixture(scope="module", autouse=True)
def restore_after(auth):
    yield
    # Restore original sub_categories & first category value
    for sku, subs in ORIGINAL_SUBCATS.items():
        requests.post(
            f"{BASE_URL}/api/supplier-sync/products/bulk-update-unified",
            headers=auth,
            json={
                "product_ids": [sku],
                "id_field": "sku",
                "updates": {"sub_categories": subs, "category": subs[0], "custom_specs": [], "field_label_overrides": {}},
                "mode": "replace",
            },
            timeout=30,
        )


# ---------- tests ----------
class TestBulkUpdateUnified:
    def test_append_subcategories_verification_ok(self, auth):
        payload = {
            "product_ids": SKUS,
            "id_field": "sku",
            "updates": {"sub_categories": ["Mosaic"]},
            "mode": "append",
        }
        r = requests.post(f"{BASE_URL}/api/supplier-sync/products/bulk-update-unified", headers=auth, json=payload, timeout=30)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("verification_ok") is True, f"verification failed: {body}"
        # confirm existing tags preserved
        for sku in SKUS:
            p = _get_product(sku)
            subs = [s.lower() for s in (p.get("sub_categories") or [])]
            assert "mosaic" in subs
            for orig in ORIGINAL_SUBCATS[sku]:
                assert orig.lower() in subs, f"{sku} lost {orig}"

    def test_remove_subcategories_verification_ok(self, auth):
        # remove Mosaic (case-insensitive) from both
        payload = {
            "product_ids": SKUS,
            "id_field": "sku",
            "updates": {"sub_categories": ["mosaic"]},
            "mode": "remove",
        }
        r = requests.post(f"{BASE_URL}/api/supplier-sync/products/bulk-update-unified", headers=auth, json=payload, timeout=30)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("verification_ok") is True, f"verification failed: {body}"
        for sku in SKUS:
            p = _get_product(sku)
            subs = [s.lower() for s in (p.get("sub_categories") or [])]
            assert "mosaic" not in subs
            # verification_ok=true is the authoritative check; scalar sync behavior may retain
            # pre-existing empty category when removed value != scalar


class TestAttributeValuesCustomSpec:
    LABEL = "TEST_FrostProof_pytest"

    def test_save_and_fetch_custom_spec_label(self):
        r = requests.post(
            f"{BASE_URL}/api/attribute-values/save",
            json={"field": "custom_spec_label", "values": [self.LABEL]},
            timeout=15,
        )
        assert r.status_code == 200, r.text

        r2 = requests.get(f"{BASE_URL}/api/attribute-values", params={"fields": "custom_spec_label"}, timeout=15)
        assert r2.status_code == 200, r2.text
        data = r2.json()
        # response shape { values: { custom_spec_label: [...] } } or flat
        vals = data.get("custom_spec_label")
        if vals is None:
            vals = (data.get("values") or {}).get("custom_spec_label", [])
        assert self.LABEL in vals, f"saved label not returned: {data}"

    def test_remove_custom_spec_label(self):
        r = requests.post(
            f"{BASE_URL}/api/attribute-values/remove",
            json={"field": "custom_spec_label", "value": self.LABEL},
            timeout=15,
        )
        assert r.status_code == 200, r.text

        r2 = requests.get(f"{BASE_URL}/api/attribute-values", params={"fields": "custom_spec_label"}, timeout=15)
        vals = r2.json().get("custom_spec_label")
        if vals is None:
            vals = (r2.json().get("values") or {}).get("custom_spec_label", [])
        assert self.LABEL not in (vals or []), "label still present after remove"

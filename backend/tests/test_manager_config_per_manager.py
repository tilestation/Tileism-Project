"""Backend tests for Per-Manager Configurable Filters / Sub-Tabs / Spec Fields
feature (Jan 2026). Verifies:
- GET /api/manager-definitions/{slug}?with_defaults=true seeds hardcoded defaults
  for all 6 built-in slugs
- PATCH updates filter_facets / sub_tabs / spec_fields with strict isolation
  between managers
- PATCH requires supplier_products permission
- PATCH on unknown slug returns 404
"""
import os
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
API = f"{BASE_URL}/api"

ADMIN_EMAIL = "admin@test.com"
ADMIN_PASSWORD = "admin123"

BUILTIN_SLUGS = ["tiles", "materials", "flooring", "bathroom", "underfloor_heating", "tools"]


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


class TestBuiltinDefaultsSeeding:
    """GET with_defaults=true must seed non-empty config for all built-in slugs."""

    @pytest.mark.parametrize("slug", BUILTIN_SLUGS)
    def test_builtin_returns_non_empty_config(self, slug):
        r = requests.get(f"{API}/manager-definitions/{slug}?with_defaults=true", timeout=15)
        assert r.status_code == 200, f"[{slug}] {r.status_code} {r.text}"
        doc = r.json()
        assert doc["slug"] == slug
        assert isinstance(doc.get("filter_facets"), list) and len(doc["filter_facets"]) > 0, \
            f"[{slug}] filter_facets empty: {doc.get('filter_facets')}"
        assert isinstance(doc.get("sub_tabs"), list) and len(doc["sub_tabs"]) > 0, \
            f"[{slug}] sub_tabs empty"
        assert isinstance(doc.get("spec_fields"), list) and len(doc["spec_fields"]) > 0, \
            f"[{slug}] spec_fields empty"


class TestPatchIsolation:
    """PATCH must only update the target slug; other managers untouched."""

    NEW_FACET = {"key": "warranty", "label": "Warranty", "field": "warranty", "type": "text"}

    def test_patch_materials_does_not_affect_tiles(self, auth_headers):
        # Seed both first (idempotent)
        mat_before = requests.get(f"{API}/manager-definitions/materials?with_defaults=true", timeout=15).json()
        tiles_before = requests.get(f"{API}/manager-definitions/tiles?with_defaults=true", timeout=15).json()
        mat_facets_before = mat_before["filter_facets"]
        tiles_facets_before = tiles_before["filter_facets"]
        tiles_labels_before = sorted([f.get("label") for f in tiles_facets_before])

        # PATCH materials: append Warranty
        new_facets = list(mat_facets_before) + [self.NEW_FACET]
        r = requests.patch(
            f"{API}/manager-definitions/materials",
            json={"filter_facets": new_facets},
            headers=auth_headers, timeout=15,
        )
        assert r.status_code == 200, r.text
        try:
            updated = r.json()
            updated_labels = [f.get("label") for f in updated["filter_facets"]]
            assert "Warranty" in updated_labels, f"Warranty not present after PATCH: {updated_labels}"

            # Verify persistence
            mat_after = requests.get(f"{API}/manager-definitions/materials?with_defaults=true", timeout=15).json()
            assert "Warranty" in [f.get("label") for f in mat_after["filter_facets"]]

            # Isolation: tiles must NOT have Warranty
            tiles_after = requests.get(f"{API}/manager-definitions/tiles?with_defaults=true", timeout=15).json()
            tiles_labels_after = sorted([f.get("label") for f in tiles_after["filter_facets"]])
            assert "Warranty" not in tiles_labels_after, f"ISOLATION VIOLATED: {tiles_labels_after}"
            assert tiles_labels_before == tiles_labels_after, "tiles facets changed after materials PATCH"
        finally:
            # Cleanup - restore materials
            requests.patch(
                f"{API}/manager-definitions/materials",
                json={"filter_facets": mat_facets_before},
                headers=auth_headers, timeout=15,
            )
            check = requests.get(f"{API}/manager-definitions/materials?with_defaults=true", timeout=15).json()
            assert "Warranty" not in [f.get("label") for f in check["filter_facets"]], "cleanup failed"


class TestPatchPersistSubTabsAndSpecs:
    def test_patch_sub_tabs_persists(self, auth_headers):
        before = requests.get(f"{API}/manager-definitions/tools?with_defaults=true", timeout=15).json()
        original = before["sub_tabs"]
        new_tab = {"key": "test_tab", "label": "TEST_Tab", "value": "test_tab"}
        try:
            r = requests.patch(
                f"{API}/manager-definitions/tools",
                json={"sub_tabs": list(original) + [new_tab]},
                headers=auth_headers, timeout=15,
            )
            assert r.status_code == 200, r.text
            after = requests.get(f"{API}/manager-definitions/tools?with_defaults=true", timeout=15).json()
            labels = [t.get("label") for t in after["sub_tabs"]]
            assert "TEST_Tab" in labels
        finally:
            requests.patch(
                f"{API}/manager-definitions/tools",
                json={"sub_tabs": original},
                headers=auth_headers, timeout=15,
            )

    def test_patch_spec_fields_persists(self, auth_headers):
        before = requests.get(f"{API}/manager-definitions/flooring?with_defaults=true", timeout=15).json()
        original = before["spec_fields"]
        new_spec = {"key": "test_spec", "label": "TEST_Spec", "field": "test_spec", "type": "text"}
        try:
            r = requests.patch(
                f"{API}/manager-definitions/flooring",
                json={"spec_fields": list(original) + [new_spec]},
                headers=auth_headers, timeout=15,
            )
            assert r.status_code == 200, r.text
            after = requests.get(f"{API}/manager-definitions/flooring?with_defaults=true", timeout=15).json()
            labels = [s.get("label") for s in after["spec_fields"]]
            assert "TEST_Spec" in labels
        finally:
            requests.patch(
                f"{API}/manager-definitions/flooring",
                json={"spec_fields": original},
                headers=auth_headers, timeout=15,
            )


class TestPatchAuthAndNotFound:
    def test_patch_without_auth_returns_401_or_403(self):
        r = requests.patch(
            f"{API}/manager-definitions/materials",
            json={"filter_facets": []},
            timeout=15,
        )
        assert r.status_code in (401, 403), f"expected 401/403 got {r.status_code} {r.text}"

    def test_patch_unknown_slug_returns_404(self, auth_headers):
        r = requests.patch(
            f"{API}/manager-definitions/does-not-exist-slug-xyz-9999",
            json={"filter_facets": []},
            headers=auth_headers, timeout=15,
        )
        assert r.status_code == 404, f"expected 404 got {r.status_code} {r.text}"

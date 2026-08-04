"""Manager Config Templates + CSV Import parity feature verification.

Backend tests for /api/manager-config-templates and materials filter_facets restoration.
"""
import os
import pytest
import requests

def _load_backend_url():
    url = os.environ.get('REACT_APP_BACKEND_URL')
    if not url:
        # Fallback: read from frontend/.env
        try:
            with open('/app/frontend/.env') as f:
                for line in f:
                    if line.startswith('REACT_APP_BACKEND_URL='):
                        url = line.split('=', 1)[1].strip()
                        break
        except Exception:
            pass
    return (url or '').rstrip('/')

BASE_URL = _load_backend_url()
API = f"{BASE_URL}/api"

ADMIN_EMAIL = "admin@test.com"
ADMIN_PASS = "admin123"

TEST_PRESET_SLUG = "test-hardware"
TEST_PRESET_NAME = "Test Hardware"

MATERIALS_DEFAULT_FACETS = [
    {"key": "color", "label": "Colour", "field": "color", "array_field": "colors"},
    {"key": "bag_colour", "label": "Bag Colour", "field": "bag_colour", "array_field": None},
    {"key": "suitability", "label": "Suitability", "field": "suitability", "array_field": None},
    {"key": "supplier", "label": "Supplier", "field": "supplier", "array_field": None},
]


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASS})
    if r.status_code != 200:
        pytest.skip(f"Admin login failed: {r.status_code} {r.text[:200]}")
    return r.json().get("access_token") or r.json().get("token")


@pytest.fixture(scope="module")
def auth_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def original_materials_snapshot():
    """Snapshot original materials config (all 3 arrays) so we restore fully."""
    r = requests.get(f"{API}/manager-definitions/materials")
    if r.status_code == 200:
        d = r.json()
        return {
            "filter_facets": d.get("filter_facets") or [],
            "sub_tabs": d.get("sub_tabs") or [],
            "spec_fields": d.get("spec_fields") or [],
        }
    return {"filter_facets": MATERIALS_DEFAULT_FACETS, "sub_tabs": [], "spec_fields": []}


# --- Section 1: list ---
def test_list_templates_ok():
    r = requests.get(f"{API}/manager-config-templates")
    assert r.status_code == 200
    data = r.json()
    assert "templates" in data
    assert "count" in data
    assert isinstance(data["templates"], list)


# --- Section 2: unauthenticated writes ---
def test_create_requires_auth():
    r = requests.post(f"{API}/manager-config-templates", json={"name": "NoAuth"})
    assert r.status_code in (401, 403)


def test_apply_requires_auth():
    r = requests.post(f"{API}/manager-config-templates/anything/apply", json={"target_slug": "materials"})
    assert r.status_code in (401, 403)


def test_delete_requires_auth():
    r = requests.delete(f"{API}/manager-config-templates/anything")
    assert r.status_code in (401, 403)


# --- Section 3: create + counts ---
def test_create_from_tools(auth_headers, original_materials_snapshot):
    # first cleanup any leftover
    requests.delete(f"{API}/manager-config-templates/{TEST_PRESET_SLUG}", headers=auth_headers)

    payload = {"name": TEST_PRESET_NAME, "theme": "slate", "source_slug": "tools"}
    r = requests.post(f"{API}/manager-config-templates", json=payload, headers=auth_headers)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["slug"] == TEST_PRESET_SLUG
    assert data["source_slug"] == "tools"
    # Tools defaults documented as 4 filter_facets / 6 sub_tabs / 8 spec_fields
    assert len(data.get("filter_facets") or []) == 4, f"filter_facets={len(data.get('filter_facets') or [])}"
    assert len(data.get("sub_tabs") or []) == 6, f"sub_tabs={len(data.get('sub_tabs') or [])}"
    assert len(data.get("spec_fields") or []) == 8, f"spec_fields={len(data.get('spec_fields') or [])}"


def test_create_duplicate_slug_409(auth_headers):
    payload = {"name": TEST_PRESET_NAME, "theme": "slate", "source_slug": "tools"}
    r = requests.post(f"{API}/manager-config-templates", json=payload, headers=auth_headers)
    assert r.status_code == 409, r.text


# --- Section 4: apply replace + materials pollution + restore ---
def test_apply_replace_to_materials(auth_headers):
    body = {"target_slug": "materials", "mode": "replace"}
    r = requests.post(f"{API}/manager-config-templates/{TEST_PRESET_SLUG}/apply", json=body, headers=auth_headers)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["mode"] == "replace"
    assert data["target_slug"] == "materials"

    # verify via GET
    m = requests.get(f"{API}/manager-definitions/materials")
    assert m.status_code == 200
    mat = m.json()
    assert len(mat.get("filter_facets") or []) == 4  # Tools has 4 facets too
    # These should be Tools facets — not the original materials keys (color, bag_colour, suitability, supplier)
    keys = {f.get("key") for f in mat.get("filter_facets") or []}
    materials_default_keys = {"color", "bag_colour", "suitability", "supplier"}
    assert keys != materials_default_keys, f"facets weren't overwritten, still: {keys}"


def test_apply_append_idempotent(auth_headers):
    # After replace above, append should be a no-op since all keys already there
    body = {"target_slug": "materials", "mode": "append"}
    r = requests.post(f"{API}/manager-config-templates/{TEST_PRESET_SLUG}/apply", json=body, headers=auth_headers)
    assert r.status_code == 200, r.text
    data = r.json()
    # counts still 4 after append idempotent
    tgt = data.get("target") or {}
    assert len(tgt.get("filter_facets") or []) == 4


def test_apply_ghost_slug_404(auth_headers):
    body = {"target_slug": "ghost-nonexistent-slug-xyz", "mode": "replace"}
    r = requests.post(f"{API}/manager-config-templates/{TEST_PRESET_SLUG}/apply", json=body, headers=auth_headers)
    assert r.status_code == 404


# --- Section 5: delete ---
def test_delete_soft(auth_headers, original_materials_snapshot):
    # RESTORE materials FULL config (facets + sub_tabs + spec_fields) first
    restore = requests.patch(
        f"{API}/manager-definitions/materials",
        json=original_materials_snapshot,
        headers=auth_headers,
    )
    assert restore.status_code in (200, 204), f"Failed to restore materials: {restore.status_code} {restore.text[:200]}"

    # Verify restore
    m = requests.get(f"{API}/manager-definitions/materials")
    assert m.status_code == 200
    keys = {f.get("key") for f in m.json().get("filter_facets") or []}
    assert keys == {"color", "bag_colour", "suitability", "supplier"}, f"Restore incomplete: {keys}"

    # Now delete the test preset
    r = requests.delete(f"{API}/manager-config-templates/{TEST_PRESET_SLUG}", headers=auth_headers)
    assert r.status_code == 200, r.text

    # Verify not in list
    lst = requests.get(f"{API}/manager-config-templates").json()
    slugs = [t.get("slug") for t in lst.get("templates", [])]
    assert TEST_PRESET_SLUG not in slugs


def test_delete_nonexistent_404(auth_headers):
    r = requests.delete(f"{API}/manager-config-templates/never-existed-xyz", headers=auth_headers)
    assert r.status_code == 404

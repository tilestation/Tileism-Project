"""
Tests for admin manager Preview/Publish/Unpublish flow (iteration 227).
Covers:
  - preview=1 merging unpublished supplier_products as drafts
  - derived published flag on GET /api/supplier-sync/products
  - publish-to-website / unpublish-from-website round-trip
  - regression: existing collection endpoints
Fixture: supplier_product SKU TEST-DRAFT-PO1 (series 'Premium Oak') must be left UNPUBLISHED at the end.
"""
import os
import pytest
import requests
from urllib.parse import quote

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
API = f"{BASE_URL}/api"

ADMIN_EMAIL = "admin@test.com"
ADMIN_PASSWORD = "admin123"
DRAFT_SKU = "TEST-DRAFT-PO1"
DRAFT_SERIES = "Premium Oak"
LIVE_SKU = "355POL6060"


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{API}/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
                      timeout=30)
    if r.status_code != 200:
        pytest.skip(f"admin login failed: {r.status_code} {r.text[:200]}")
    tok = r.json().get("access_token") or r.json().get("token")
    if not tok:
        pytest.skip("no token in login response")
    return tok


@pytest.fixture(scope="module")
def auth_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


# ---------- Draft merge ----------

def test_preview_shows_draft_for_unpublished_sp():
    url = f"{API}/tiles/collection/{quote(DRAFT_SERIES)}?preview=1"
    r = requests.get(url, timeout=30)
    assert r.status_code == 200, r.text[:300]
    body = r.json()
    assert body.get("draft_count", 0) >= 1, f"expected draft_count>=1, body={body}"
    products = body.get("products", [])
    drafts = [p for p in products if p.get("is_draft")]
    assert any(p.get("sku") == DRAFT_SKU for p in drafts), \
        f"TEST-DRAFT-PO1 not shown as draft. drafts={[p.get('sku') for p in drafts]}"


def test_no_preview_hides_draft():
    url = f"{API}/tiles/collection/{quote(DRAFT_SERIES)}"
    r = requests.get(url, timeout=30)
    # Could be 200 with no drafts, or 404 if no live products yet. Accept both.
    if r.status_code == 200:
        products = r.json().get("products", [])
        assert not any(p.get("is_draft") for p in products)
        assert not any(p.get("sku") == DRAFT_SKU for p in products)
    else:
        assert r.status_code in (404,)


# ---------- Derived published flag ----------

def test_supplier_products_derived_published_for_live_sku(auth_headers):
    r = requests.get(f"{API}/supplier-sync/products",
                     params={"search": LIVE_SKU},
                     headers=auth_headers, timeout=30)
    assert r.status_code == 200, r.text[:300]
    body = r.json()
    items = body.get("products") or body.get("items") or body
    if isinstance(items, dict):
        items = items.get("products", [])
    match = next((p for p in items if p.get("sku") == LIVE_SKU), None)
    assert match, f"{LIVE_SKU} not found in supplier_products search"
    assert match.get("published") is True, f"expected published True, got {match.get('published')}"
    assert match.get("live_on_website") is True, f"expected live_on_website True, got {match.get('live_on_website')}"
    assert match.get("live_slug") == "premium-polished-porcelain-60x60", \
        f"live_slug mismatch: {match.get('live_slug')}"


# ---------- Publish / Unpublish round-trip ----------

def test_publish_then_unpublish_draft_sku(auth_headers):
    # PUBLISH
    r = requests.post(f"{API}/supplier-sync/publish-to-website",
                      params={"skus": DRAFT_SKU},
                      headers=auth_headers, timeout=60)
    assert r.status_code == 200, f"publish failed: {r.status_code} {r.text[:300]}"

    # Verify no longer draft in preview
    prev = requests.get(f"{API}/tiles/collection/{quote(DRAFT_SERIES)}?preview=1", timeout=30).json()
    draft_skus_now = [p.get("sku") for p in prev.get("products", []) if p.get("is_draft")]
    assert DRAFT_SKU not in draft_skus_now, f"still draft after publish: {draft_skus_now}"

    # Confirm supplier_products flag
    sp = requests.get(f"{API}/supplier-sync/products",
                      params={"search": DRAFT_SKU},
                      headers=auth_headers, timeout=30).json()
    items = sp.get("products") if isinstance(sp, dict) else sp
    if isinstance(items, dict):
        items = items.get("products", [])
    match = next((p for p in items if p.get("sku") == DRAFT_SKU), None)
    assert match and match.get("published") is True, f"published flag not True: {match}"
    assert match.get("live_slug"), f"live_slug not set: {match}"

    # UNPUBLISH (cleanup so fixture is left unpublished)
    r2 = requests.delete(f"{API}/supplier-sync/unpublish-from-website",
                         params={"skus": DRAFT_SKU},
                         headers=auth_headers, timeout=60)
    assert r2.status_code == 200, f"unpublish failed: {r2.status_code} {r2.text[:300]}"

    # Verify back to draft in preview
    prev2 = requests.get(f"{API}/tiles/collection/{quote(DRAFT_SERIES)}?preview=1", timeout=30).json()
    draft_skus_after = [p.get("sku") for p in prev2.get("products", []) if p.get("is_draft")]
    assert DRAFT_SKU in draft_skus_after, f"not draft again after unpublish: {draft_skus_after}"

    # supplier_products flag back to False
    sp2 = requests.get(f"{API}/supplier-sync/products",
                       params={"search": DRAFT_SKU},
                       headers=auth_headers, timeout=30).json()
    items2 = sp2.get("products") if isinstance(sp2, dict) else sp2
    if isinstance(items2, dict):
        items2 = items2.get("products", [])
    match2 = next((p for p in items2 if p.get("sku") == DRAFT_SKU), None)
    assert match2 and match2.get("published") is False, f"published flag not False after unpublish: {match2}"


# ---------- Regression ----------

def test_regression_60x60_porcelain_no_preview():
    url = f"{API}/tiles/collection/{quote('60x60 Porcelain')}?limit=3"
    r = requests.get(url, timeout=30)
    assert r.status_code == 200, r.text[:300]
    assert len(r.json().get("products", [])) > 0


def test_regression_60x60_porcelain_preview():
    url = f"{API}/tiles/collection/{quote('60x60 Porcelain')}?limit=3&preview=1"
    r = requests.get(url, timeout=30)
    assert r.status_code == 200, r.text[:300]


def test_regression_collections_list():
    r = requests.get(f"{API}/tiles/collections?limit=5", timeout=30)
    assert r.status_code == 200
    body = r.json()
    coll = body.get("collections") if isinstance(body, dict) else body
    assert coll and len(coll) > 0

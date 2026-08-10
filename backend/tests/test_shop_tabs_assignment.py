"""Tests for Shop Tabs bulk assignment (Managers workspace) — iteration 224."""
import os
import time
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://feature-verification-7.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"
TEST_SKU = "LP-6611"
BASELINE_SUBCATS = ["Large Format", "Floor Tiles", "Matt"]  # per E1


@pytest.fixture(scope="module")
def s():
    return requests.Session()


# ---------- GET destinations ----------
def test_get_shop_tab_destinations(s):
    r = s.get(f"{API}/supplier-sync/shop-tab-destinations", timeout=30)
    assert r.status_code == 200, r.text
    data = r.json()
    assert "pages" in data and isinstance(data["pages"], list)
    pages = {p["group_slug"]: p for p in data["pages"]}
    assert "tiles" in pages, f"Expected 'tiles' page. Got: {list(pages.keys())}"

    tiles_tabs = pages["tiles"]["tabs"]
    labels = [t["label"] for t in tiles_tabs]
    assert len(tiles_tabs) == 7, f"Expected 7 tiles tabs, got {len(tiles_tabs)}: {labels}"

    # Assignable count: WALL TILES, FLOOR TILES, PORCELAIN => 3
    assignable = [t for t in tiles_tabs if t["assignable"]]
    assert len(assignable) == 3, f"Expected 3 assignable tabs, got {[t['label'] for t in assignable]}"

    # Verify category name mapping
    by_label = {t["label"]: t for t in tiles_tabs}
    assert by_label["WALL TILES"]["category_name"] == "Wall Tiles"
    assert by_label["FLOOR TILES"]["category_name"] == "Floor Tiles"
    assert by_label["PORCELAIN"]["category_name"] == "Porcelain"
    for lbl in ["ALL TILES", "POLISHED", "MATT", "SALE"]:
        assert by_label[lbl]["assignable"] is False, f"{lbl} should be non-assignable"

    # Flooring page — VINYL + LAMINATE assignable
    if "flooring" in pages:
        flooring_by_label = {t["label"]: t for t in pages["flooring"]["tabs"]}
        for lbl in ["VINYL", "LAMINATE"]:
            if lbl in flooring_by_label:
                assert flooring_by_label[lbl]["assignable"] is True
                assert flooring_by_label[lbl]["category_name"] in (lbl.title(), "Vinyl", "Laminate")


# ---------- POST assign — validation ----------
def test_assign_empty_products_returns_400(s):
    r = s.post(f"{API}/supplier-sync/products/assign-shop-tabs",
               json={"skus": [], "supplier_codes": [], "add_categories": ["Porcelain"]}, timeout=15)
    assert r.status_code == 400


def test_assign_no_changes_returns_400(s):
    r = s.post(f"{API}/supplier-sync/products/assign-shop-tabs",
               json={"skus": [TEST_SKU], "add_categories": [], "remove_categories": []}, timeout=15)
    assert r.status_code == 400


# ---------- Full round-trip add+remove ----------
def _get_subcats(s, sku):
    # Use the products query endpoint if available, or hit tiles/collections indirect check
    r = s.get(f"{API}/supplier-sync/products", params={"search": sku, "limit": 5}, timeout=30)
    if r.status_code == 200:
        for p in r.json().get("products", []):
            if p.get("sku") == sku:
                return p.get("sub_categories") or []
    return None


def test_assign_add_and_remove_roundtrip(s):
    before = _get_subcats(s, TEST_SKU)

    # ADD
    r = s.post(f"{API}/supplier-sync/products/assign-shop-tabs",
               json={"skus": [TEST_SKU], "add_categories": ["Porcelain"], "remove_categories": []}, timeout=30)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("success") is True
    assert body.get("updated", 0) >= 1, f"Expected updated>=1, got {body}"

    after_add = _get_subcats(s, TEST_SKU)
    if after_add is not None:
        assert "Porcelain" in after_add, f"'Porcelain' not appended. sub_categories={after_add}"

    # REMOVE (restore)
    r = s.post(f"{API}/supplier-sync/products/assign-shop-tabs",
               json={"skus": [TEST_SKU], "add_categories": [], "remove_categories": ["Porcelain"]}, timeout=30)
    assert r.status_code == 200, r.text
    assert r.json().get("success") is True

    after_remove = _get_subcats(s, TEST_SKU)
    if after_remove is not None:
        assert "Porcelain" not in after_remove, f"'Porcelain' still present after remove: {after_remove}"


# ---------- Restore baseline exactly ----------
def test_restore_baseline_subcategories(s):
    """Ensure LP-6611 sub_categories are restored to baseline (idempotent no-op if already correct)."""
    current = _get_subcats(s, TEST_SKU)
    if current is None:
        pytest.skip("Cannot read current sub_categories")
    extras = [c for c in current if c not in BASELINE_SUBCATS]
    missing = [c for c in BASELINE_SUBCATS if c not in current]
    if extras:
        s.post(f"{API}/supplier-sync/products/assign-shop-tabs",
               json={"skus": [TEST_SKU], "remove_categories": extras}, timeout=30)
    if missing:
        s.post(f"{API}/supplier-sync/products/assign-shop-tabs",
               json={"skus": [TEST_SKU], "add_categories": missing}, timeout=30)
    final = _get_subcats(s, TEST_SKU)
    if final is not None:
        assert set(final) >= set(BASELINE_SUBCATS), f"Baseline not restored: {final}"

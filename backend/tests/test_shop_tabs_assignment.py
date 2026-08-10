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


# ==========================================================
# Iteration 225 — CREATE TAB endpoint (POST /shop-tab-destinations/create)
# ==========================================================
E2E_LABEL = "E2E Test Tab"
E2E_SLUG = "e2e-test-tab"
FLOORING_GROUP = "flooring"


def _get_flooring_tabs(s):
    r = s.get(f"{API}/supplier-sync/shop-tab-destinations", timeout=30)
    assert r.status_code == 200
    pages = {p["group_slug"]: p for p in r.json()["pages"]}
    return pages.get(FLOORING_GROUP, {}).get("tabs", [])


def _mongo():
    """Return live mongo db handle using backend env (for restore)."""
    from pymongo import MongoClient
    from dotenv import dotenv_values
    env = dotenv_values("/app/backend/.env")
    client = MongoClient(env["MONGO_URL"])
    return client[env["DB_NAME"]], client


def _restore_flooring_baseline():
    """Restore navigation_menus shop_flooring to exactly the original 3 tabs
    (ALL FLOORING / VINYL / LAMINATE) and delete e2e-test-tab category."""
    db, client = _mongo()
    try:
        menu = db.navigation_menus.find_one({"menu_type": "shop_flooring"})
        if menu:
            items = [it for it in (menu.get("items") or [])
                     if (it.get("label") or "").strip().upper() != E2E_LABEL.upper()
                     and E2E_SLUG not in (it.get("link_url") or "")]
            db.navigation_menus.update_one(
                {"menu_type": "shop_flooring"},
                {"$set": {"items": items}},
            )
        db.website_categories.delete_many({"slug": E2E_SLUG})
    finally:
        client.close()


def test_create_shop_tab_flow(s):
    """POST create → verify tab in GET → duplicate 409 → restore."""
    # Pre-clean in case previous run left artefacts
    _restore_flooring_baseline()

    tabs_before = _get_flooring_tabs(s)
    labels_before = [t["label"] for t in tabs_before]
    assert set(labels_before) == {"ALL FLOORING", "VINYL", "LAMINATE"}, \
        f"Flooring baseline drift: {labels_before}"

    try:
        # CREATE
        r = s.post(f"{API}/supplier-sync/shop-tab-destinations/create",
                   json={"group_slug": FLOORING_GROUP, "label": E2E_LABEL}, timeout=30)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("success") is True
        tab = body["tab"]
        assert tab["label"] == E2E_LABEL.upper()
        assert tab["url"] == f"/tiles?group={FLOORING_GROUP}&category={E2E_SLUG}"
        assert tab["category_slug"] == E2E_SLUG
        assert tab["category_name"] == "E2E Test Tab"
        assert tab["assignable"] is True

        # Verify via mongo: website_categories doc + nav item appended
        db, client = _mongo()
        try:
            cat = db.website_categories.find_one({"slug": E2E_SLUG})
            assert cat is not None
            assert cat["group_slug"] == FLOORING_GROUP
            menu = db.navigation_menus.find_one({"menu_type": "shop_flooring"})
            assert menu is not None
            labels = [(it.get("label") or "").upper() for it in menu["items"]]
            assert E2E_LABEL.upper() in labels
            assert len(menu["items"]) == 4  # 3 baseline + new
        finally:
            client.close()

        # Verify GET destinations shows new tab
        tabs_after = _get_flooring_tabs(s)
        labels_after = [t["label"] for t in tabs_after]
        assert E2E_LABEL.upper() in labels_after, f"New tab not in GET: {labels_after}"

        # Duplicate → 409
        r_dup = s.post(f"{API}/supplier-sync/shop-tab-destinations/create",
                       json={"group_slug": FLOORING_GROUP, "label": E2E_LABEL}, timeout=15)
        assert r_dup.status_code == 409, r_dup.text
    finally:
        _restore_flooring_baseline()

    # Post-restore assertions
    tabs_final = _get_flooring_tabs(s)
    assert set(t["label"] for t in tabs_final) == {"ALL FLOORING", "VINYL", "LAMINATE"}
    db, client = _mongo()
    try:
        assert db.website_categories.find_one({"slug": E2E_SLUG}) is None
    finally:
        client.close()


def test_create_shop_tab_empty_label_returns_400(s):
    r = s.post(f"{API}/supplier-sync/shop-tab-destinations/create",
               json={"group_slug": FLOORING_GROUP, "label": "   "}, timeout=15)
    assert r.status_code == 400


def test_create_shop_tab_unknown_group_returns_404(s):
    r = s.post(f"{API}/supplier-sync/shop-tab-destinations/create",
               json={"group_slug": "nonexistent-group-xyz", "label": "Whatever"}, timeout=15)
    assert r.status_code == 404

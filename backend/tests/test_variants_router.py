"""Tests for /api/supplier-sync/variants/* router (iteration 221)."""
import os
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://feature-verification-7.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api/supplier-sync/variants"

# Two real SKUs from local preview DB (found via supplier-sync/products?search=Oak)
SKU_A = "5445"          # Laminate Premium Oak
SKU_B = "LFLAM573"      # AGT Mood 10mm Maple Oak White Marbled ...


@pytest.fixture(scope="module")
def sess():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    yield s
    # Best-effort teardown — dissolve any test group left over.
    try:
        s.post(f"{API}/ungroup", json={"skus": [SKU_A, SKU_B], "clear_axes": True}, timeout=15)
    except Exception:
        pass


# --- candidates -----------------------------------------------------------
def test_candidates_unknown_sku_returns_404(sess):
    r = sess.get(f"{API}/candidates", params={"sku": "TEST_DOES_NOT_EXIST_XYZ"}, timeout=15)
    assert r.status_code == 404, r.text
    assert "not found" in r.json().get("detail", "").lower()


def test_candidates_real_sku_returns_200_with_list(sess):
    r = sess.get(f"{API}/candidates", params={"sku": SKU_A}, timeout=15)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("sku") == SKU_A
    assert isinstance(body.get("candidates"), list)


# --- auto-group-from-series ----------------------------------------------
def test_auto_group_dry_run_shape(sess):
    r = sess.post(f"{API}/auto-group-from-series",
                  json={"series": "Premium Oak", "dry_run": True}, timeout=30)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("dry_run") is True
    assert "clusters_found" in body
    assert "products_grouped" in body
    assert isinstance(body.get("clusters"), list)


# --- create-group + get-group -------------------------------------------
def test_create_group_and_verify_persistence(sess):
    payload = {
        "items": [
            {"sku": SKU_A, "color": "Grey"},
            {"sku": SKU_B, "color": "White"},
        ]
    }
    r = sess.post(f"{API}/create-group", json=payload, timeout=15)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("success") is True
    assert body.get("updated") == 2, body
    group_id = body.get("group_id")
    assert isinstance(group_id, str) and len(group_id) >= 8

    # Verify GET group returns both SKUs
    g = sess.get(f"{API}/group/{group_id}", timeout=15)
    assert g.status_code == 200, g.text
    gbody = g.json()
    assert gbody.get("member_count") == 2
    member_skus = {m.get("sku") for m in gbody.get("members", [])}
    assert member_skus == {SKU_A, SKU_B}, member_skus

    # Store for chained tests via env
    os.environ["_VARIANTS_TEST_GROUP_ID"] = group_id


def test_set_axes_updates_color(sess):
    r = sess.put(f"{API}/set-axes", json={"sku": SKU_A, "color": "Charcoal"}, timeout=15)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("sku") == SKU_A
    assert body.get("variant_axes", {}).get("color") == "Charcoal"

    # Verify persistence via the group GET
    group_id = os.environ.get("_VARIANTS_TEST_GROUP_ID")
    if group_id:
        g = sess.get(f"{API}/group/{group_id}", timeout=15).json()
        m_a = next((m for m in g.get("members", []) if m.get("sku") == SKU_A), None)
        assert m_a is not None
        assert (m_a.get("variant_axes") or {}).get("color") == "Charcoal"


def test_set_axes_unknown_sku_returns_404(sess):
    r = sess.put(f"{API}/set-axes", json={"sku": "TEST_UNKNOWN_ZZZ", "color": "X"}, timeout=15)
    assert r.status_code == 404, r.text


def test_ungroup_removes_group_id(sess):
    r = sess.post(f"{API}/ungroup",
                  json={"skus": [SKU_A, SKU_B], "clear_axes": True}, timeout=15)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("success") is True
    assert body.get("modified") >= 2

    # Verify by trying to fetch group; it should now be empty
    group_id = os.environ.get("_VARIANTS_TEST_GROUP_ID")
    if group_id:
        g = sess.get(f"{API}/group/{group_id}", timeout=15)
        assert g.status_code == 200
        assert g.json().get("member_count") == 0


def test_create_group_empty_items_returns_400(sess):
    r = sess.post(f"{API}/create-group", json={"items": []}, timeout=15)
    assert r.status_code == 400


def test_ungroup_empty_skus_returns_400(sess):
    r = sess.post(f"{API}/ungroup", json={"skus": []}, timeout=15)
    assert r.status_code == 400

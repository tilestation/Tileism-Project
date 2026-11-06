# Tests for GET /api/supplier-sync/products?skus= (View selected feature) + backward compat
import os
import pytest
import requests

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL').rstrip('/')
EP = f"{BASE_URL}/api/supplier-sync/products"


@pytest.fixture(scope="module")
def sample_products():
    r = requests.get(EP, params={"skip": 0, "limit": 60}, timeout=60)
    assert r.status_code == 200
    prods = [p for p in r.json()["products"] if p.get("sku")]
    assert len(prods) >= 10
    return prods


# Backward compat: no skus param
def test_default_listing_unchanged():
    r = requests.get(EP, params={"skip": 0, "limit": 50}, timeout=60)
    assert r.status_code == 200
    d = r.json()
    assert len(d["products"]) == 50
    assert d["total"] > 50
    assert d["skip"] == 0 and d["limit"] == 50


def test_pagination_still_works():
    a = requests.get(EP, params={"skip": 0, "limit": 20}, timeout=60).json()["products"]
    b = requests.get(EP, params={"skip": 20, "limit": 20}, timeout=60).json()["products"]
    ka = {p["_id"] for p in a}
    kb = {p["_id"] for p in b}
    assert ka.isdisjoint(kb)


def test_search_still_works():
    r = requests.get(EP, params={"search": "splendour", "limit": 50}, timeout=60)
    assert r.status_code == 200
    d = r.json()
    assert d["total"] >= 1
    for p in d["products"]:
        blob = " ".join(str(p.get(k, "")) for k in ("name", "product_name", "sku", "category", "supplier_product_name", "series", "range_name", "original_series")).lower()
        assert "splendour" in blob


# skus param: exact set
def test_skus_returns_exact_set(sample_products):
    chosen = [sample_products[i]["sku"] for i in (0, 7, 15, 30, 45)]
    r = requests.get(EP, params={"skus": ",".join(chosen), "limit": len(chosen)}, timeout=60)
    assert r.status_code == 200
    got = {p["sku"] for p in r.json()["products"]}
    assert set(chosen).issubset(got)
    # extras only allowed if they match by supplier_code / duplicate sku across suppliers
    for p in r.json()["products"]:
        assert p.get("sku") in chosen or p.get("supplier_code") in chosen


def test_skus_ignores_small_limit(sample_products):
    chosen = [p["sku"] for p in sample_products[:8]]
    r = requests.get(EP, params={"skus": ",".join(chosen), "limit": 2}, timeout=60)
    assert r.status_code == 200
    got = {p["sku"] for p in r.json()["products"]}
    assert set(chosen).issubset(got)


def test_skus_ignores_default_skip_limit_with_far_products():
    # pick products far down the catalogue (page 20+)
    far = requests.get(EP, params={"skip": 1000, "limit": 5}, timeout=60).json()["products"]
    chosen = [p["sku"] for p in far if p.get("sku")]
    assert chosen
    r = requests.get(EP, params={"skus": ",".join(chosen)}, timeout=60)
    got = {p["sku"] for p in r.json()["products"]}
    assert set(chosen).issubset(got)


def test_skus_match_by_supplier_code():
    prods = requests.get(EP, params={"skip": 0, "limit": 200}, timeout=60).json()["products"]
    cand = [p for p in prods if p.get("supplier_code") and p.get("supplier_code") != p.get("sku")]
    if not cand:
        pytest.skip("No product with distinct supplier_code")
    code = cand[0]["supplier_code"]
    r = requests.get(EP, params={"skus": code}, timeout=60)
    assert r.status_code == 200
    assert any(p.get("supplier_code") == code for p in r.json()["products"])


def test_skus_unknown_returns_empty():
    r = requests.get(EP, params={"skus": "TEST_NOPE_123,TEST_NOPE_456"}, timeout=60)
    assert r.status_code == 200
    assert r.json()["products"] == []
    assert r.json()["total"] == 0


def test_skus_whitespace_and_empty_entries(sample_products):
    s1, s2 = sample_products[0]["sku"], sample_products[1]["sku"]
    r = requests.get(EP, params={"skus": f" {s1} , ,{s2},"}, timeout=60)
    got = {p["sku"] for p in r.json()["products"]}
    assert {s1, s2}.issubset(got)


def test_skus_single(sample_products):
    s1 = sample_products[0]["sku"]
    prods = requests.get(EP, params={"skus": s1}, timeout=60).json()["products"]
    assert any(p["sku"] == s1 for p in prods)

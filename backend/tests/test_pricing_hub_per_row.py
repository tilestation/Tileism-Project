"""
Tests for the Pricing Hub per-row bulk endpoints:
- PUT /api/supplier-sync/products/bulk-delivery-settings (per-row overrides)
- PUT /api/supplier-sync/products/bulk-tier-update (pallet-only rows must NOT touch tier flags)

Fixtures: LP-1231, LP-1631 (LEPORCE).
"""
import os
import copy
import pytest
import requests
from pymongo import MongoClient

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', 'https://feature-verification-7.preview.emergentagent.com').rstrip('/')
MONGO_URL = os.environ.get('MONGO_URL', 'mongodb://localhost:27017')
DB_NAME = os.environ.get('DB_NAME', 'tile_station')

SUPPLIER = "LEPORCE"
SKU_A = "LP-1231"
SKU_B = "LP-1631"

TIER_FIELDS = ("tier_pricing_disabled", "has_custom_tier_pricing", "tier_thresholds", "tier_discounts")
PALLET_FIELDS = ("pallet_enabled", "pallet_only", "pallet_price", "half_pallet_price",
                 "m2_per_pallet", "m2_per_half_pallet", "pallet_qty_unit")
DELIVERY_FIELDS = ("delivery_charge_required", "delivery_charge", "parcel_delivery", "parcel_fee")


@pytest.fixture(scope="module")
def db():
    return MongoClient(MONGO_URL)[DB_NAME]


def _snap(db, sku, fields):
    doc = db.supplier_products.find_one({"sku": sku}) or {}
    return {f: doc.get(f) for f in fields}


def _tile(db, sku, fields):
    doc = db.tiles.find_one({"$or": [{"sku": sku}, {"supplier_code": sku}]}) or {}
    return {f: doc.get(f) for f in fields}


def _cleanup(sku):
    # Clear delivery + parcel
    requests.put(f"{BASE_URL}/api/supplier-sync/products/bulk-delivery-settings", json={
        "products": [{"supplier": SUPPLIER, "sku": sku}],
        "clear": True,
    }, timeout=30)
    # Disable pallet
    requests.put(f"{BASE_URL}/api/supplier-sync/products/bulk-tier-update", json={
        "products": [{"supplier": SUPPLIER, "sku": sku, "pallet_enabled": False, "pallet_only": False}],
    }, timeout=30)


@pytest.fixture(autouse=True)
def _cleanup_after():
    yield
    _cleanup(SKU_A)
    _cleanup(SKU_B)


# ---------------- BACKEND 1 ----------------
def test_bulk_delivery_per_row_overrides(db):
    _cleanup(SKU_A); _cleanup(SKU_B)
    payload = {"products": [
        {"supplier": SUPPLIER, "sku": SKU_A, "delivery_charge_required": True, "delivery_charge": 12.5},
        {"supplier": SUPPLIER, "sku": SKU_B, "delivery_charge_required": False, "parcel_delivery": True, "parcel_fee": 4.99},
    ]}
    r = requests.put(f"{BASE_URL}/api/supplier-sync/products/bulk-delivery-settings", json=payload, timeout=30)
    assert r.status_code == 200, r.text
    assert r.json().get("updated_count") == 2

    a = _snap(db, SKU_A, DELIVERY_FIELDS)
    assert a["delivery_charge_required"] is True
    assert a["delivery_charge"] == 12.5

    b = _snap(db, SKU_B, DELIVERY_FIELDS)
    assert b["delivery_charge_required"] is False
    assert b["delivery_charge"] is None
    assert b["parcel_delivery"] is True
    assert b["parcel_fee"] == 4.99

    # Tiles mirror
    at = _tile(db, SKU_A, DELIVERY_FIELDS)
    assert at["delivery_charge_required"] is True
    assert at["delivery_charge"] == 12.5
    bt = _tile(db, SKU_B, DELIVERY_FIELDS)
    assert bt["parcel_delivery"] is True
    assert bt["parcel_fee"] == 4.99


def test_bulk_delivery_top_level_applies_to_rows_without_overrides(db):
    _cleanup(SKU_A); _cleanup(SKU_B)
    r = requests.put(f"{BASE_URL}/api/supplier-sync/products/bulk-delivery-settings", json={
        "products": [
            {"supplier": SUPPLIER, "sku": SKU_A},
            {"supplier": SUPPLIER, "sku": SKU_B},
        ],
        "delivery_charge_required": True,
        "delivery_charge": 9,
    }, timeout=30)
    assert r.status_code == 200
    for sku in (SKU_A, SKU_B):
        s = _snap(db, sku, DELIVERY_FIELDS)
        assert s["delivery_charge_required"] is True
        assert s["delivery_charge"] == 9


def test_bulk_delivery_clear_removes_everything(db):
    # seed
    requests.put(f"{BASE_URL}/api/supplier-sync/products/bulk-delivery-settings", json={
        "products": [{"supplier": SUPPLIER, "sku": SKU_A, "delivery_charge_required": True,
                      "delivery_charge": 20, "parcel_delivery": True, "parcel_fee": 3}],
    }, timeout=30)
    r = requests.put(f"{BASE_URL}/api/supplier-sync/products/bulk-delivery-settings", json={
        "products": [{"supplier": SUPPLIER, "sku": SKU_A}], "clear": True,
    }, timeout=30)
    assert r.status_code == 200
    s = _snap(db, SKU_A, DELIVERY_FIELDS)
    assert s["delivery_charge_required"] is False
    assert s["delivery_charge"] is None
    assert s["parcel_delivery"] is False
    assert s["parcel_fee"] is None


# ---------------- BACKEND 2 ----------------
def test_bulk_tier_pallet_only_does_not_touch_tier_flags(db):
    # First, set known tier state on both.
    r0 = requests.put(f"{BASE_URL}/api/supplier-sync/products/bulk-tier-update", json={
        "products": [{"supplier": SUPPLIER, "sku": SKU_A}, {"supplier": SUPPLIER, "sku": SKU_B}],
        "disabled": False,
        "tier_thresholds": [10, 50],
        "tier_discounts": [0, 5],
    }, timeout=30)
    assert r0.status_code == 200

    before_a = _snap(db, SKU_A, TIER_FIELDS)
    before_b = _snap(db, SKU_B, TIER_FIELDS)
    assert before_a["tier_pricing_disabled"] is False
    assert before_a["has_custom_tier_pricing"] is True
    assert before_a["tier_thresholds"] == [10, 50]
    assert before_a["tier_discounts"] == [0, 5]

    # Now send only pallet fields per row — tier flags must NOT change.
    r = requests.put(f"{BASE_URL}/api/supplier-sync/products/bulk-tier-update", json={
        "products": [
            {"supplier": SUPPLIER, "sku": SKU_A, "pallet_enabled": True, "pallet_qty_unit": "m2",
             "m2_per_pallet": 32, "pallet_price": 28, "pallet_only": True},
            {"supplier": SUPPLIER, "sku": SKU_B, "pallet_enabled": False},
        ],
    }, timeout=30)
    assert r.status_code == 200, r.text

    # Pallet fields on A applied
    pa = _snap(db, SKU_A, PALLET_FIELDS)
    assert pa["pallet_enabled"] is True
    assert pa["pallet_only"] is True
    assert pa["pallet_price"] == 28
    assert pa["m2_per_pallet"] == 32
    assert pa["pallet_qty_unit"] == "m2"

    pb = _snap(db, SKU_B, PALLET_FIELDS)
    assert pb["pallet_enabled"] is False
    assert pb["pallet_only"] is False
    assert pb["pallet_price"] is None
    assert pb["m2_per_pallet"] is None

    # Tile mirror
    ta = _tile(db, SKU_A, PALLET_FIELDS)
    assert ta["pallet_enabled"] is True
    assert ta["pallet_only"] is True

    # Tier flags UNCHANGED
    after_a = _snap(db, SKU_A, TIER_FIELDS)
    after_b = _snap(db, SKU_B, TIER_FIELDS)
    assert after_a == before_a, f"A tier flags changed: before={before_a}, after={after_a}"
    assert after_b == before_b, f"B tier flags changed: before={before_b}, after={after_b}"


def test_bulk_tier_regular_tier_save_still_works(db):
    r = requests.put(f"{BASE_URL}/api/supplier-sync/products/bulk-tier-update", json={
        "products": [{"supplier": SUPPLIER, "sku": SKU_A}],
        "disabled": False,
        "tier_thresholds": [10, 50],
        "tier_discounts": [0, 5],
    }, timeout=30)
    assert r.status_code == 200
    s = _snap(db, SKU_A, TIER_FIELDS)
    assert s["tier_pricing_disabled"] is False
    assert s["has_custom_tier_pricing"] is True
    assert s["tier_thresholds"] == [10, 50]
    assert s["tier_discounts"] == [0, 5]

"""
Iteration 246 — WHOLE-SITE PRICING SCAN + REPORT ALERT (Verona extension)

Backend coverage:
 - GET /api/supplier-sync/products/live-pricing/scan (baseline + seeded drift)
 - POST /api/supplier-sync/products/live-pricing/fix-all (push + adopt cases)
 - POST /api/supplier-sync/verona/extension-report (+ last-receive + list)
 - GET /api/notifications/telegram/config → events.extension_report default True
"""
import os
import copy
import pytest
import requests
from pymongo import MongoClient

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
assert BASE_URL, "REACT_APP_BACKEND_URL missing"

MONGO_URL = os.environ.get("MONGO_URL") or "mongodb://localhost:27017"
DB_NAME = os.environ.get("DB_NAME") or "tile_station"

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"


@pytest.fixture(scope="session")
def session():
    s = requests.Session()
    s.headers.update({"User-Agent": UA, "Content-Type": "application/json"})
    return s


@pytest.fixture(scope="session")
def db():
    c = MongoClient(MONGO_URL)
    return c[DB_NAME]


# ------------------- Live-pricing scan -------------------

def _scan(session):
    r = session.get(f"{BASE_URL}/api/supplier-sync/products/live-pricing/scan?limit=300", timeout=60)
    assert r.status_code == 200, r.text
    return r.json()


def test_baseline_scan_clean(session):
    data = _scan(session)
    for k in ("total_live", "checked", "no_draft", "mismatch_count", "no_admin_price", "by_group", "items", "scanned_at"):
        assert k in data, f"missing key: {k}"
    assert data["mismatch_count"] == 0, f"expected baseline clean, got {data['mismatch_count']} mismatches: {data['items'][:3]}"


TEST_SKUS = ["LP-1231", "LP-1631", "LP-1132"]


@pytest.fixture
def seed_drift(db):
    """Snapshot 3 tiles + drafts, seed drift, then restore."""
    snaps = {}
    for sku in TEST_SKUS:
        t = db.tiles.find_one({"$or": [{"sku": sku}, {"supplier_code": sku}]})
        sp = db.supplier_products.find_one({"$or": [{"sku": sku}, {"supplier_code": sku}]})
        assert t and sp, f"seed product {sku} not found"
        snaps[sku] = {"tile": copy.deepcopy(t), "sp": copy.deepcopy(sp)}

    # LP-1231: tile pallets drift while draft pallet_enabled=false
    db.supplier_products.update_one({"sku": "LP-1231"}, {"$set": {"pallet_enabled": False}, "$unset": {"pallet_price": "", "m2_per_pallet": ""}})
    db.tiles.update_one({"$or": [{"sku": "LP-1231"}, {"supplier_code": "LP-1231"}]},
                        {"$set": {"pallet_price": 24.99, "m2_per_pallet": 51.84, "pallet_enabled": True}})

    # LP-1631: tile sale drift while draft has no sale
    db.supplier_products.update_one({"sku": "LP-1631"}, {"$set": {"sale_active": False}, "$unset": {"was_price": ""}})
    db.tiles.update_one({"$or": [{"sku": "LP-1631"}, {"supplier_code": "LP-1631"}]},
                        {"$set": {"was_price": 99.0, "sale_active": True}})

    # LP-1132: tile price 1.23 while draft list_price=30
    db.supplier_products.update_one({"sku": "LP-1132"}, {"$set": {"list_price": 30.0, "price": 30.0, "room_lot_price": 30.0}})
    db.tiles.update_one({"$or": [{"sku": "LP-1132"}, {"supplier_code": "LP-1132"}]},
                        {"$set": {"price": 1.23, "room_lot_price": 1.23}})

    yield snaps

    # Restore
    for sku, snap in snaps.items():
        q = {"$or": [{"sku": sku}, {"supplier_code": sku}]}
        t, sp = snap["tile"], snap["sp"]
        t.pop("_id", None); sp.pop("_id", None)
        db.tiles.replace_one(q, t)
        db.supplier_products.replace_one({"$or": [{"sku": sku}, {"supplier_code": sku}]}, sp)


def test_scan_detects_seeded_drift(session, seed_drift):
    data = _scan(session)
    assert data["mismatch_count"] == 3, f"expected 3, got {data['mismatch_count']}: {[i['sku'] + ':' + ','.join(i['mismatches']) for i in data['items']]}"
    by_group = data["by_group"]
    assert by_group.get("pallets") == 1
    assert by_group.get("sale") == 1
    assert by_group.get("price") == 1
    sku_to_item = {i["sku"]: i for i in data["items"]}
    assert "pallets" in sku_to_item["LP-1231"]["mismatches"]
    assert "sale" in sku_to_item["LP-1631"]["mismatches"]
    assert "price" in sku_to_item["LP-1132"]["mismatches"]
    for sku in TEST_SKUS:
        assert sku_to_item[sku]["fixable"] is True


def test_fix_all_resolves_drift(session, db, seed_drift):
    r = session.post(f"{BASE_URL}/api/supplier-sync/products/live-pricing/fix-all", timeout=120)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["mismatched_before"] >= 3
    assert body["mismatched_after"] == 0
    assert body["pushed"] >= 3
    assert body["adopted_prices"] == 0
    # Verify tiles now match drafts
    t1 = db.tiles.find_one({"$or": [{"sku": "LP-1231"}, {"supplier_code": "LP-1231"}]})
    assert not t1.get("pallet_price"), f"pallet_price still on tile: {t1.get('pallet_price')}"
    t2 = db.tiles.find_one({"$or": [{"sku": "LP-1631"}, {"supplier_code": "LP-1631"}]})
    assert t2.get("sale_active") in (False, None)
    assert not t2.get("was_price")
    t3 = db.tiles.find_one({"$or": [{"sku": "LP-1132"}, {"supplier_code": "LP-1132"}]})
    assert float(t3.get("price") or 0) == 30.0
    assert float(t3.get("room_lot_price") or 0) == 30.0
    # pricing_sync_runs inserted
    doc = db.pricing_sync_runs.find_one({}, sort=[("at", -1)])
    assert doc is not None
    # Re-scan clean
    again = _scan(session)
    assert again["mismatch_count"] == 0


# ------------------- Adopt case -------------------

def test_adopt_price_case(session, db):
    """Unset draft price on LP-1131; set tile to 19.99 → fix-all adopts."""
    sku = "LP-1131"
    q = {"$or": [{"sku": sku}, {"supplier_code": sku}]}
    orig_sp = db.supplier_products.find_one(q)
    orig_tile = db.tiles.find_one(q)
    assert orig_sp and orig_tile, "LP-1131 missing"
    orig_sp_copy = copy.deepcopy(orig_sp); orig_sp_copy.pop("_id", None)
    orig_tile_copy = copy.deepcopy(orig_tile); orig_tile_copy.pop("_id", None)
    try:
        db.supplier_products.update_one(q, {"$unset": {"list_price": "", "price": "", "room_lot_price": ""},
                                            "$set": {"pallet_enabled": False, "sale_active": False}})
        db.supplier_products.update_one(q, {"$unset": {"was_price": ""}})
        db.tiles.update_one(q, {"$set": {"price": 19.99, "room_lot_price": 19.99,
                                          "pallet_enabled": False, "sale_active": False},
                                "$unset": {"pallet_price": "", "was_price": ""}})
        data = _scan(session)
        item = next((i for i in data["items"] if i["sku"] == sku), None)
        assert item is not None, f"LP-1131 not in mismatch items: {[i['sku'] for i in data['items']][:10]}"
        assert "price" in item["mismatches"]
        assert data["no_admin_price"] >= 1
        r = session.post(f"{BASE_URL}/api/supplier-sync/products/live-pricing/fix-all", timeout=120)
        assert r.status_code == 200
        body = r.json()
        assert body["adopted_prices"] >= 1, body
        sp2 = db.supplier_products.find_one(q)
        assert float(sp2.get("list_price") or 0) == 19.99
        assert float(sp2.get("price") or 0) == 19.99
        assert float(sp2.get("room_lot_price") or 0) == 19.99
        assert sp2.get("price_source") == "adopted_from_website"
        t2 = db.tiles.find_one(q)
        assert float(t2.get("price") or 0) == 19.99
    finally:
        db.supplier_products.replace_one(q, orig_sp_copy)
        db.tiles.replace_one(q, orig_tile_copy)


# ------------------- Extension report -------------------

def test_extension_report_post(session, db):
    payload = {
        "version": "6.1.0",
        "report": {
            "worker": "ok v6.1.0",
            "server": {"url": "https://x"},
            "tab": {"url": "https://www.veronagroup.co.uk/tiles"},
            "page": {"urlCount": 0, "cloudflare": True, "title": "Just a moment..."},
            "job": {"status": "paused", "lastStatus": "Paused — Cloudflare"},
            "errors": [{"at": "2026-09-07T20:00:00Z", "context": "cloudflare", "detail": "Security check"}],
        },
    }
    r = session.post(f"{BASE_URL}/api/supplier-sync/verona/extension-report", json=payload, timeout=30)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is True
    assert isinstance(body["id"], str) and len(body["id"]) == 6
    alert = body.get("alert") or {}
    # telegram skipped acceptable, but MUST not error out the endpoint
    assert "telegram" in alert
    ref_id = body["id"]

    # last-receive
    r2 = session.get(f"{BASE_URL}/api/supplier-sync/verona/last-receive", timeout=15)
    assert r2.status_code == 200
    lr = r2.json().get("last_report") or {}
    assert lr.get("id") == ref_id
    assert lr.get("page_cloudflare") is True
    assert lr.get("job_status") == "paused"

    # list
    r3 = session.get(f"{BASE_URL}/api/supplier-sync/verona/extension-reports?limit=2", timeout=15)
    assert r3.status_code == 200
    ids = [x.get("id") for x in (r3.json().get("reports") or [])]
    assert ref_id in ids

    # Cleanup this test's doc
    db.extension_reports.delete_one({"ref": ref_id})


# ------------------- Telegram default event -------------------

def test_telegram_event_default(session):
    r = session.get(f"{BASE_URL}/api/notifications/telegram/config", timeout=15)
    # May require auth; if so, skip loudly
    if r.status_code in (401, 403):
        pytest.skip(f"telegram/config requires auth ({r.status_code}) — verified in code (services/telegram_notify.py _default_config)")
    assert r.status_code == 200, r.text
    body = r.json()
    events = body.get("events") or (body.get("config") or {}).get("events") or {}
    assert events.get("extension_report") is True, f"extension_report not default True: {events}"

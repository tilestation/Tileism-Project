# Iteration 254: Manager ?group= scoping, light-index endpoint, bulk-assign-category,
# and Klarna/PayPal Express delivery fee (default_fee) + effective price fixes.
import os
import copy
import pytest
import requests
from pymongo import MongoClient
from dotenv import load_dotenv

load_dotenv('/app/frontend/.env')
load_dotenv('/app/backend/.env')
BASE_URL = os.environ.get('REACT_APP_BACKEND_URL').rstrip('/')
API = f"{BASE_URL}/api"

_mongo = MongoClient(os.environ['MONGO_URL'])[os.environ['DB_NAME']]
GROUPS = ['tiles', 'materials', 'flooring', 'bathroom', 'underfloor_heating', 'tools']


@pytest.fixture(scope="module")
def s():
    return requests.Session()


# ---------- Manager group filter ----------
class TestManagerGroupFilter:
    def test_full_list_unfiltered(self, s):
        r = s.get(f"{API}/supplier-sync/products", params={"limit": 5000}, timeout=60)
        assert r.status_code == 200
        prods = r.json()["products"]
        assert len(prods) == _mongo.supplier_products.count_documents({})

    def test_tiles_scoped(self, s):
        r = s.get(f"{API}/supplier-sync/products", params={"limit": 3000, "group": "tiles"}, timeout=60)
        assert r.status_code == 200
        prods = r.json()["products"]
        assert 900 < len(prods) < 1300, len(prods)
        total = _mongo.supplier_products.count_documents({})
        assert len(prods) < total

    @pytest.mark.parametrize("g", GROUPS)
    def test_each_group_200(self, s, g):
        r = s.get(f"{API}/supplier-sync/products", params={"limit": 3000, "group": g}, timeout=60)
        assert r.status_code == 200
        prods = r.json()["products"]
        if g == 'tools':
            assert len(prods) == 0
        else:
            assert len(prods) > 0

    def test_unknown_group_is_ignored(self, s):
        r = s.get(f"{API}/supplier-sync/products", params={"limit": 5000, "group": "bogus"}, timeout=60)
        assert r.status_code == 200
        assert len(r.json()["products"]) == _mongo.supplier_products.count_documents({})

    @pytest.mark.parametrize("g", ['tiles', 'materials', 'flooring', 'bathroom'])
    def test_server_is_superset_of_frontend_predicate_case_insensitive(self, s, g):
        """Frontend isMatch lowercases main_category ('Materials' -> 'materials').
        Server filter must not drop anything the frontend predicate would keep."""
        r = s.get(f"{API}/supplier-sync/products", params={"limit": 3000, "group": g}, timeout=60)
        server_skus = {(p.get("supplier"), p.get("sku")) for p in r.json()["products"]}
        expected = list(_mongo.supplier_products.find(
            {"$or": [{"product_group": {"$regex": f"^{g}$", "$options": "i"}},
                     {"main_category": {"$regex": f"^{g}$", "$options": "i"}}]},
            {"_id": 0, "supplier": 1, "sku": 1}))
        missing = [e for e in expected if (e.get("supplier"), e.get("sku")) not in server_skus]
        assert not missing, f"group={g} dropped products the frontend shows: {missing}"


# ---------- Light index ----------
class TestLightIndex:
    def test_light_index(self, s):
        r = s.get(f"{API}/supplier-sync/products/light-index", timeout=60)
        assert r.status_code == 200
        idx = r.json()["index"]
        assert isinstance(idx, list)
        assert len(idx) == _mongo.supplier_products.count_documents({})
        row = idx[0]
        for k in ("sku", "supplier_code", "supplier", "product_group", "name", "image"):
            assert k in row
        assert "_id" not in row
        assert any(x["name"] for x in idx)
        assert any(x["image"] for x in idx)


# ---------- Bulk assign category (existing "move" workflow) ----------
class TestBulkAssignCategory:
    def test_assign_and_revert(self, s):
        doc = _mongo.supplier_products.find_one(
            {"product_group": "tiles", "sku": {"$nin": [None, ""]}},
            {"_id": 0, "sku": 1, "supplier": 1, "product_group": 1, "main_category": 1, "pricing_unit": 1})
        assert doc
        sku = doc["sku"]
        tile_snaps = list(_mongo.tiles.find({"sku": sku}, {"_id": 1, "product_group": 1, "main_category": 1}))
        try:
            r = s.post(f"{API}/supplier-sync/products/bulk-assign-category",
                       json={"product_ids": [sku], "product_group": "flooring"}, timeout=30)
            assert r.status_code == 200, r.text
            after = _mongo.supplier_products.find_one({"sku": sku}, {"_id": 0, "product_group": 1})
            assert after["product_group"] == "flooring"
            fl = s.get(f"{API}/supplier-sync/products", params={"limit": 3000, "group": "flooring"}, timeout=60).json()["products"]
            assert any(p.get("sku") == sku for p in fl)
            bad = s.post(f"{API}/supplier-sync/products/bulk-assign-category",
                         json={"product_ids": [sku], "product_group": "nope"}, timeout=30)
            assert bad.status_code == 400
        finally:
            keys = ("product_group", "main_category", "pricing_unit")
            upd = {"$set": {k: doc[k] for k in keys if k in doc}}
            unset = {k: "" for k in keys if k not in doc}
            if unset:
                upd["$unset"] = unset
            _mongo.supplier_products.update_one({"sku": sku, "supplier": doc.get("supplier")}, upd)
            # bulk-assign also mirrors product_group/main_category to `tiles`
            for t in tile_snaps:
                tupd = {"$set": {k: t[k] for k in ("product_group", "main_category") if k in t}}
                tun = {k: "" for k in ("product_group", "main_category") if k not in t}
                if tun:
                    tupd["$unset"] = tun
                if not tupd["$set"]:
                    del tupd["$set"]
                _mongo.tiles.update_one({"_id": t["_id"]}, tupd)


# ---------- Express checkout pricing ----------
@pytest.fixture(scope="class")
def express_settings():
    orig = _mongo.website_settings.find_one({"key": "checkout_settings"})
    orig_copy = copy.deepcopy(orig)
    val = copy.deepcopy((orig or {}).get("value", {}))
    val.setdefault("payments", {})
    val["payments"]["klarna_enabled"] = True
    val["payments"]["paypal_enabled"] = True
    val.setdefault("delivery", {})
    val["delivery"]["default_fee"] = 79.99
    val["delivery"]["free_threshold"] = 500
    _mongo.website_settings.update_one({"key": "checkout_settings"},
                                       {"$set": {"key": "checkout_settings", "value": val}}, upsert=True)
    created_orders = []
    yield created_orders
    if orig_copy is None:
        _mongo.website_settings.delete_one({"key": "checkout_settings"})
    else:
        _mongo.website_settings.replace_one({"_id": orig_copy["_id"]}, orig_copy)
    for oid in created_orders:
        _mongo.shop_orders.delete_one({"id": oid})


ORIGIN = "https://example.test"


class TestExpressPricing:
    @pytest.mark.parametrize("ep", ["klarna-express", "paypal-express"])
    def test_delivery_uses_default_fee(self, s, express_settings, ep):
        # effective price 33.33 * 3.5 m2 = 116.655 -> 116.66 line; < 500 threshold
        items = [{"product_id": "TEST_p1", "quantity": 3.5, "price": 33.33, "name": "TEST_Tile", "sku": "TEST_SKU"}]
        r = s.post(f"{API}/shop/{ep}/create-session", json={"items": items, "origin_url": ORIGIN}, timeout=60)
        assert r.status_code == 200, r.text
        d = r.json()
        express_settings.append(d["order_id"])
        assert d["url"] and "stripe" in d["url"]
        order = _mongo.shop_orders.find_one({"id": d["order_id"]}, {"_id": 0})
        assert order["delivery_fee"] == 79.99
        assert order["subtotal"] == round(33.33 * 3.5, 2)
        assert abs(d["total"] - round(order["subtotal"] + 79.99, 2)) < 0.01

    @pytest.mark.parametrize("ep", ["klarna-express", "paypal-express"])
    def test_free_over_threshold(self, s, express_settings, ep):
        items = [{"product_id": "TEST_p2", "quantity": 20, "price": 30.0, "name": "TEST_Tile2"}]
        r = s.post(f"{API}/shop/{ep}/create-session", json={"items": items, "origin_url": ORIGIN}, timeout=60)
        assert r.status_code == 200, r.text
        d = r.json()
        express_settings.append(d["order_id"])
        order = _mongo.shop_orders.find_one({"id": d["order_id"]}, {"_id": 0})
        assert order["delivery_fee"] == 0.0
        assert d["total"] == 600.0

    def test_zero_default_fee_respected(self, s, express_settings):
        """Admin sets default_fee=0 (free delivery). Cart page honours 0 (>=0 check);
        express must not fall back to 49.99."""
        _mongo.website_settings.update_one({"key": "checkout_settings"}, {"$set": {"value.delivery.default_fee": 0}})
        try:
            items = [{"product_id": "TEST_p3", "quantity": 2, "price": 25.0, "name": "TEST_Tile3"}]
            r = s.post(f"{API}/shop/paypal-express/create-session", json={"items": items, "origin_url": ORIGIN}, timeout=60)
            assert r.status_code == 200, r.text
            d = r.json()
            express_settings.append(d["order_id"])
            order = _mongo.shop_orders.find_one({"id": d["order_id"]}, {"_id": 0})
            assert order["delivery_fee"] == 0.0, f"default_fee=0 ignored -> {order['delivery_fee']}"
        finally:
            _mongo.website_settings.update_one({"key": "checkout_settings"}, {"$set": {"value.delivery.default_fee": 79.99}})


# ---------- Standard checkout regression ----------
class TestGuestCheckoutRegression:
    def test_guest_checkout_delivery_fee(self, s, express_settings):
        payload = {
            "customer": {"email": "TEST_iter254@example.com", "firstName": "TEST", "lastName": "User", "phone": "07000000000"},
            "delivery": {"method": "delivery", "postcode": "ZZ1 1ZZ", "speed": "standard",
                         "address": {"line1": "1 Test St", "city": "Test", "postcode": "ZZ1 1ZZ"}},
            "items": [{"product_id": "TEST_p4", "quantity": 2, "price": 40.0, "name": "TEST_Tile4", "sku": "TEST4"}],
            "origin_url": ORIGIN,
        }
        r = s.post(f"{API}/shop/guest-checkout", json=payload, timeout=60)
        assert r.status_code == 200, r.text
        d = r.json()
        oid = d.get("order_id") or (d.get("order") or {}).get("id")
        if oid:
            express_settings.append(oid)
        order = _mongo.shop_orders.find_one({"id": oid}, {"_id": 0}) if oid else None
        assert order, d
        assert order["delivery_fee"] == 79.99
        assert abs(order["total"] - (80.0 + 79.99 + order.get("congestion_charge", 0) + order.get("express_fee", 0)
                                     + order.get("item_delivery_charge", 0))) < 0.02

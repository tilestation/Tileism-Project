# Klarna/PayPal Express: real item names, KE-/PE- order numbers, Stripe address collection,
# and webhook capture of customer_details/shipping_details onto shop_orders.
import os
import json
import time
import uuid
import pytest
import requests
import pymongo
import stripe
from dotenv import load_dotenv

load_dotenv("/app/frontend/.env")
load_dotenv("/app/backend/.env")
BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
db = pymongo.MongoClient(os.environ["MONGO_URL"])[os.environ["DB_NAME"]]
stripe.api_key = os.environ.get("STRIPE_API_KEY")
if "sk_test_emergent" in (stripe.api_key or ""):
    stripe.api_base = "https://integrations.emergentagent.com/stripe"

ITEM_NAME = "TEST_Carrara Marble Effect Tile 600x600"
ITEMS = [{"product_id": "TEST_prod_1", "quantity": 12.5, "price": 29.99, "name": ITEM_NAME, "sku": "TEST-CAR"}]
CREATED = []


@pytest.fixture(scope="module", autouse=True)
def toggle_flags():
    before = db.website_settings.find_one({"key": "checkout_settings"}, {"_id": 0}) or {}
    payments_before = (before.get("value") or {}).get("payments")
    db.website_settings.update_one(
        {"key": "checkout_settings"},
        {"$set": {"value.payments.klarna_enabled": True, "value.payments.paypal_enabled": True}},
        upsert=True,
    )
    yield
    if payments_before is None:
        db.website_settings.update_one({"key": "checkout_settings"}, {"$unset": {"value.payments": ""}})
    else:
        db.website_settings.update_one({"key": "checkout_settings"}, {"$set": {"value.payments": payments_before}})
    for oid in CREATED:
        db.shop_orders.delete_one({"id": oid})


@pytest.fixture(scope="module")
def admin_headers():
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": "admin@test.com", "password": "admin123"})
    if r.status_code != 200:
        pytest.skip(f"admin login failed {r.status_code}")
    return {"Authorization": f"Bearer {r.json()['token']}"}


def _create(kind):
    r = requests.post(f"{BASE_URL}/api/shop/{kind}-express/create-session",
                      json={"items": ITEMS, "origin_url": BASE_URL})
    assert r.status_code == 200, r.text
    d = r.json()
    CREATED.append(d["order_id"])
    return d


def _webhook(session_id, order_id, ship=True, ship_key="shipping_details"):
    obj = {
        "id": session_id, "object": "checkout.session", "payment_status": "paid",
        "metadata": {"order_id": order_id},
        "customer_details": {
            "email": "test_express@example.com", "name": "Jane Billing", "phone": "+447700900123",
            "address": {"line1": "1 Billing St", "line2": "Flat 2", "city": "London",
                        "state": "", "postal_code": "SW1A 1AA", "country": "GB"},
        },
    }
    if ship:
        obj[ship_key] = {"name": "Jane Shipping",
                         "address": {"line1": "99 Ship Rd", "line2": "", "city": "Tonbridge",
                                     "state": "Kent", "postal_code": "TN9 1AA", "country": "GB"}}
    if ship_key == "collected_information":
        obj["collected_information"] = {"shipping_details": obj.pop("collected_information")}
    ev = {"id": f"evt_TEST_{uuid.uuid4().hex[:8]}", "type": "checkout.session.completed", "data": {"object": obj}}
    return requests.post(f"{BASE_URL}/api/webhook/stripe", data=json.dumps(ev),
                         headers={"Content-Type": "application/json"})


class TestKlarnaExpress:
    def test_create_session_and_order_doc(self):
        d = _create("klarna")
        assert d["session_id"].startswith("cs_") and "checkout.stripe.com" in d["url"]
        o = db.shop_orders.find_one({"id": d["order_id"]}, {"_id": 0})
        assert o["order_number"].startswith("KE-") and len(o["order_number"]) == 13
        assert o["items"][0]["name"] == ITEM_NAME
        assert o["stripe_session_id"] == d["session_id"]

    def test_webhook_populates_customer(self, admin_headers):
        d = _create("klarna")
        r = _webhook(d["session_id"], d["order_id"])
        assert r.status_code == 200, r.text
        time.sleep(1)
        o = db.shop_orders.find_one({"id": d["order_id"]}, {"_id": 0})
        assert o["payment_status"] == "paid"
        assert o["customer_name"] == "Jane Billing"
        assert o["customer_email"] == "test_express@example.com"
        assert o["customer_phone"] == "+447700900123"
        assert o["delivery_address"]["address1"] == "99 Ship Rd"
        assert o["delivery_address"]["postcode"] == "TN9 1AA"
        assert o["billing_address"]["address1"] == "1 Billing St"
        # admin detail endpoint
        a = requests.get(f"{BASE_URL}/api/shop/admin/online-orders/{d['order_id']}", headers=admin_headers)
        assert a.status_code == 200, a.text
        aj = a.json()
        aj = aj.get("order", aj)
        assert aj["customer_name"] == "Jane Billing"
        assert aj["items"][0]["name"] == ITEM_NAME

    def test_webhook_new_api_collected_information(self):
        # Stripe API >= 2025-03-31 (basil) moved shipping_details -> collected_information.shipping_details
        d = _create("klarna")
        _webhook(d["session_id"], d["order_id"], ship_key="collected_information")
        time.sleep(1)
        o = db.shop_orders.find_one({"id": d["order_id"]}, {"_id": 0})
        assert o["delivery_address"].get("address1") == "99 Ship Rd", \
            f"delivery_address fell back to billing: {o['delivery_address']}"

    def test_webhook_after_success_page_flip(self):
        # Simulates /guest-checkout/status (success page) flipping paid BEFORE webhook arrives
        d = _create("klarna")
        db.shop_orders.update_one({"id": d["order_id"]}, {"$set": {"payment_status": "paid", "status": "confirmed"}})
        _webhook(d["session_id"], d["order_id"])
        time.sleep(1)
        o = db.shop_orders.find_one({"id": d["order_id"]}, {"_id": 0})
        assert o["customer_name"] == "Jane Billing", "customer data lost when success page wins the race"


class TestPaypalExpress:
    def test_create_session_and_webhook(self):
        # stripe_pm_sync on backend startup may flip paypal_enabled off if PayPal isn't active on Stripe
        db.website_settings.update_one({"key": "checkout_settings"}, {"$set": {"value.payments.paypal_enabled": True}})
        r = requests.post(f"{BASE_URL}/api/shop/paypal-express/create-session",
                          json={"items": ITEMS, "origin_url": BASE_URL})
        if r.status_code == 502 and "paypal" in r.text.lower():
            pytest.skip(f"PayPal not activated on Stripe test account: {r.text[:200]}")
        assert r.status_code == 200, r.text
        d = r.json()
        CREATED.append(d["order_id"])
        o = db.shop_orders.find_one({"id": d["order_id"]}, {"_id": 0})
        assert o["order_number"].startswith("PE-")
        assert o["items"][0]["name"] == ITEM_NAME
        _webhook(d["session_id"], d["order_id"])
        time.sleep(1)
        o = db.shop_orders.find_one({"id": d["order_id"]}, {"_id": 0})
        assert o["customer_name"] == "Jane Billing"
        assert o["delivery_address"]["city"] == "Tonbridge"
        assert o["billing_address"]["city"] == "London"


class TestGuards:
    def test_empty_basket(self):
        r = requests.post(f"{BASE_URL}/api/shop/klarna-express/create-session", json={"items": [], "origin_url": BASE_URL})
        assert r.status_code == 400

    def test_below_klarna_min(self):
        r = requests.post(f"{BASE_URL}/api/shop/klarna-express/create-session",
                          json={"items": [{**ITEMS[0], "quantity": 0.1, "price": 1}], "origin_url": BASE_URL})
        # subtotal 0.1 + delivery 49.99 > 30, so allowed; just ensure no 500
        assert r.status_code in (200, 400), r.text
        if r.status_code == 200:
            CREATED.append(r.json()["order_id"])

    def test_admin_online_orders_list(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/shop/admin/online-orders", headers=admin_headers)
        assert r.status_code == 200, r.text

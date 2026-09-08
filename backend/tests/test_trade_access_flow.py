"""Trade access flow — admin-created accounts, set-password links, dual
collection password reset, case-insensitive login, ordering at trade prices."""
import os
import uuid
import pytest
import requests
from pymongo import MongoClient

BASE_URL = (os.environ.get("REACT_APP_BACKEND_URL") or "http://localhost:8001").rstrip("/")
MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]
UNIQ = uuid.uuid4().hex[:8]
TRADE_EMAIL = f"test_trade_{UNIQ}@example.com"


@pytest.fixture(scope="module")
def db():
    return MongoClient(MONGO_URL)[DB_NAME]


@pytest.fixture(scope="module")
def admin():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": "admin@test.com", "password": "admin123"}, timeout=30)
    assert r.status_code == 200, r.text
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {r.json().get('token') or r.json().get('access_token')}"})
    return s


@pytest.fixture(scope="module")
def account(admin, db):
    payload = {
        "business_name": f"Test Trade Co {UNIQ}", "contact_name": "Testy McTrade",
        "contact_phone": "07700900123", "contact_email": TRADE_EMAIL.upper(),
        "address_line1": "1 Test St", "city": "London", "postcode": "SE26 5EQ",
        "trade_type": "Tiler",
    }
    r = admin.post(f"{BASE_URL}/api/trade-accounts", json=payload, timeout=60)
    assert r.status_code == 200, r.text
    yield r.json()
    db.shop_customers.delete_many({"email": TRADE_EMAIL})
    db.password_resets.delete_many({"email": TRADE_EMAIL})
    db.shop_orders.delete_many({"customer_email": TRADE_EMAIL})
    db.trade_credits.delete_many({"customer_id": r.json().get("id")})


class TestAdminCreatedAccount:
    def test_requires_staff_login(self):
        assert requests.get(f"{BASE_URL}/api/trade-accounts", timeout=30).status_code in (401, 403)

    def test_created_with_reference_and_setup_link(self, account, db):
        assert account["contact_email"] == TRADE_EMAIL  # lower-cased
        assert account["trade_account_number"].startswith("T-")
        ll = account["login_link"]
        assert "/reset-password?token=" in ll["link"] and "for=trade" in ll["link"]
        doc = db.shop_customers.find_one({"email": TRADE_EMAIL})
        assert doc["is_trade"] is True and doc.get("login_link_sent_at")
        rec = db.password_resets.find_one({"email": TRADE_EMAIL})
        assert rec["account_type"] == "shop" and rec["purpose"] == "setup" and rec["is_trade"] is True

    def test_duplicate_email_rejected(self, admin, account):
        r = admin.post(f"{BASE_URL}/api/trade-accounts", json={
            "business_name": "Dup", "contact_name": "Dup Person", "contact_phone": "07700900123",
            "contact_email": TRADE_EMAIL, "address_line1": "x", "city": "y", "postcode": "z", "trade_type": "Tiler",
        }, timeout=30)
        assert r.status_code == 400

    def test_no_temp_password_login(self, account):
        r = requests.post(f"{BASE_URL}/api/shop/auth/login",
                          json={"email": TRADE_EMAIL, "password": "TempPass123!"}, timeout=30)
        assert r.status_code == 401


class TestSetPasswordAndLogin:
    def test_verify_setup_token(self, account):
        token = account["login_link"]["link"].split("token=")[1].split("&")[0]
        r = requests.get(f"{BASE_URL}/api/auth/verify-reset-token", params={"token": token}, timeout=30)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["email"] == TRADE_EMAIL and body["account_type"] == "shop"
        assert body["is_trade"] is True and body["purpose"] == "setup"
        assert body["login_path"] == "/shop/trade/login"

    def test_set_password_returns_session(self, account, db):
        token = account["login_link"]["link"].split("token=")[1].split("&")[0]
        r = requests.post(f"{BASE_URL}/api/auth/reset-password",
                          json={"token": token, "new_password": "NewTradePass1!"}, timeout=30)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["account_type"] == "shop" and body["is_trade"] is True
        assert body["token"] and body["customer"]["trade_account_number"].startswith("T-")
        me = requests.get(f"{BASE_URL}/api/shop/auth/me",
                          headers={"Authorization": f"Bearer {body['token']}"}, timeout=30)
        assert me.status_code == 200 and me.json()["is_trade"] is True
        # token single-use
        again = requests.post(f"{BASE_URL}/api/auth/reset-password",
                              json={"token": token, "new_password": "NewTradePass1!"}, timeout=30)
        assert again.status_code == 400
        assert db.shop_customers.find_one({"email": TRADE_EMAIL}).get("password_set_at")

    def test_login_case_insensitive(self, account, db):
        r = requests.post(f"{BASE_URL}/api/shop/auth/login",
                          json={"email": TRADE_EMAIL.upper(), "password": "NewTradePass1!"}, timeout=30)
        assert r.status_code == 200, r.text
        c = r.json()["customer"]
        assert c["is_trade"] is True and c["trade_account_number"].startswith("T-")
        me = requests.get(f"{BASE_URL}/api/shop/auth/me",
                          headers={"Authorization": f"Bearer {r.json()['token']}"}, timeout=30)
        assert me.status_code == 200
        assert db.shop_customers.find_one({"email": TRADE_EMAIL}).get("last_login_at")

    def test_email_exists_case_insensitive(self, account):
        r = requests.post(f"{BASE_URL}/api/shop/auth/email-exists", json={"email": TRADE_EMAIL.upper()}, timeout=30)
        assert r.json()["exists"] is True


class TestForgotPasswordForCustomers:
    def test_forgot_creates_shop_reset(self, account, db):
        r = requests.post(f"{BASE_URL}/api/auth/forgot-password", json={"email": TRADE_EMAIL.upper()}, timeout=30)
        assert r.status_code == 200
        rec = db.password_resets.find_one({"email": TRADE_EMAIL})
        assert rec and rec["account_type"] == "shop" and rec["purpose"] == "reset"
        # reset via that token changes the shop_customers password
        r2 = requests.post(f"{BASE_URL}/api/auth/reset-password",
                           json={"token": rec["token"], "new_password": "ResetPass22!"}, timeout=30)
        assert r2.status_code == 200, r2.text
        assert requests.post(f"{BASE_URL}/api/shop/auth/login",
                             json={"email": TRADE_EMAIL, "password": "ResetPass22!"}, timeout=30).status_code == 200
        assert requests.post(f"{BASE_URL}/api/shop/auth/login",
                             json={"email": TRADE_EMAIL, "password": "NewTradePass1!"}, timeout=30).status_code == 401

    def test_forgot_unknown_email_is_silent(self, db):
        r = requests.post(f"{BASE_URL}/api/auth/forgot-password", json={"email": f"nobody_{UNIQ}@example.com"}, timeout=30)
        assert r.status_code == 200
        assert db.password_resets.find_one({"email": f"nobody_{UNIQ}@example.com"}) is None

    def test_staff_reset_still_targets_users(self, db):
        r = requests.post(f"{BASE_URL}/api/auth/forgot-password", json={"email": "admin@test.com"}, timeout=30)
        assert r.status_code == 200
        rec = db.password_resets.find_one({"email": "admin@test.com"})
        assert rec and rec["account_type"] == "staff"
        v = requests.get(f"{BASE_URL}/api/auth/verify-reset-token", params={"token": rec["token"]}, timeout=30).json()
        assert v["login_path"] == "/admin/login"
        db.password_resets.delete_many({"email": "admin@test.com"})


class TestAdminSendLoginLink:
    def test_send_login_link(self, admin, account, db):
        r = admin.post(f"{BASE_URL}/api/trade-accounts/{account['id']}/send-login-link", timeout=60)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["success"] and body["email"] == TRADE_EMAIL and "for=trade" in body["link"]
        rec = db.password_resets.find_one({"email": TRADE_EMAIL})
        assert rec["purpose"] == "setup" and rec["token"] in body["link"]

    def test_list_exposes_login_status(self, admin, account):
        r = admin.get(f"{BASE_URL}/api/trade-accounts", params={"search": TRADE_EMAIL}, timeout=30)
        assert r.status_code == 200
        row = next(a for a in r.json()["accounts"] if a["id"] == account["id"])
        assert row["login_link_sent_at"] and row["password_set_at"] and row["last_login_at"]

    def test_unknown_account_404(self, admin):
        assert admin.post(f"{BASE_URL}/api/trade-accounts/nope/send-login-link", timeout=30).status_code == 404


class TestDualAccountEmail:
    """Same email as a staff login AND a trade account — the reset must hit
    the account the page was opened from (or both when unknown)."""

    STAFF_PW = "StaffOld123!"
    TRADE_PW = "TradeOld123!"

    @pytest.fixture(scope="class")
    def dual(self, db):
        import bcrypt
        email = f"dual_{UNIQ}@example.com"
        db.users.insert_one({"id": str(uuid.uuid4()), "email": email, "name": "Dual Staff", "role": "staff", "is_active": True,
                             "password": bcrypt.hashpw(self.STAFF_PW.encode(), bcrypt.gensalt()).decode()})
        db.shop_customers.insert_one({"id": str(uuid.uuid4()), "email": email, "name": "Dual Trader", "is_trade": True,
                                      "trade_account_number": "T-DUAL", "credit_balance": 0,
                                      "password": bcrypt.hashpw(self.TRADE_PW.encode(), bcrypt.gensalt()).decode()})
        yield email
        db.users.delete_many({"email": email})
        db.shop_customers.delete_many({"email": email})
        db.password_resets.delete_many({"email": email})

    def _reset_with(self, db, email, account_type, new_pw):
        r = requests.post(f"{BASE_URL}/api/auth/forgot-password", json={"email": email, "account_type": account_type}, timeout=30)
        assert r.status_code == 200
        rec = db.password_resets.find_one({"email": email})
        assert rec, "no reset record"
        r2 = requests.post(f"{BASE_URL}/api/auth/reset-password", json={"token": rec["token"], "new_password": new_pw}, timeout=30)
        assert r2.status_code == 200, r2.text
        return rec, r2.json()

    def test_shop_page_resets_trade_not_staff(self, db, dual):
        rec, body = self._reset_with(db, dual, "shop", "TradeNew123!")
        assert rec["account_type"] == "shop" and body["login_path"] == "/shop/trade/login" and body.get("token")
        assert requests.post(f"{BASE_URL}/api/shop/auth/login", json={"email": dual, "password": "TradeNew123!"}, timeout=30).status_code == 200
        assert requests.post(f"{BASE_URL}/api/shop/auth/login", json={"email": dual, "password": self.TRADE_PW}, timeout=30).status_code == 401
        # staff login untouched
        assert requests.post(f"{BASE_URL}/api/auth/login", json={"email": dual, "password": self.STAFF_PW}, timeout=30).status_code == 200

    def test_staff_page_resets_staff_not_trade(self, db, dual):
        rec, body = self._reset_with(db, dual, "staff", "StaffNew123!")
        assert rec["account_type"] == "staff" and body["login_path"] == "/admin/login"
        assert requests.post(f"{BASE_URL}/api/auth/login", json={"email": dual, "password": "StaffNew123!"}, timeout=30).status_code == 200
        assert requests.post(f"{BASE_URL}/api/shop/auth/login", json={"email": dual, "password": "TradeNew123!"}, timeout=30).status_code == 200

    def test_no_hint_resets_both(self, db, dual):
        rec, body = self._reset_with(db, dual, None, "BothNew123!")
        assert rec["account_type"] == "both"
        assert requests.post(f"{BASE_URL}/api/auth/login", json={"email": dual, "password": "BothNew123!"}, timeout=30).status_code == 200
        assert requests.post(f"{BASE_URL}/api/shop/auth/login", json={"email": dual, "password": "BothNew123!"}, timeout=30).status_code == 200



class TestTradeOrderLinking:
    """Checkout orders placed with the storefront token belong to the trade
    account: dashboard orders, T-number on the order, credit-back on paid."""

    def _login(self):
        r = requests.post(f"{BASE_URL}/api/shop/auth/login",
                          json={"email": TRADE_EMAIL, "password": "ResetPass22!"}, timeout=30)
        assert r.status_code == 200, r.text
        return r.json()["token"], r.json()["customer"]

    def _order_payload(self):
        return {
            "items": [{"product_id": f"test-prod-{UNIQ}", "name": "Test Tile", "price": 20.0, "quantity": 5, "image": ""}],
            "customer": {"email": TRADE_EMAIL.upper(), "firstName": "Testy", "lastName": "McTrade", "phone": "07700900123"},
            "delivery": {"method": "collect", "collect_store_id": None},
            "billing": {"same_as_delivery": True},
            "payment": {"method": "card"},
            "subtotal": 100.0, "total": 100.0,
        }

    def test_guest_order_stays_unlinked(self, account, db):
        r = requests.post(f"{BASE_URL}/api/shop/guest-checkout", json=self._order_payload(), timeout=60)
        assert r.status_code == 200, r.text
        doc = db.shop_orders.find_one({"id": r.json()["order_id"]})
        assert doc["customer_id"] is None and not doc.get("trade_account_number")
        assert doc["customer_email"] == TRADE_EMAIL  # normalised

    def test_signed_in_order_is_linked_and_earns_credit(self, account, db):
        token, customer = self._login()
        r = requests.post(f"{BASE_URL}/api/shop/guest-checkout", json=self._order_payload(),
                          headers={"Authorization": f"Bearer {token}"}, timeout=60)
        assert r.status_code == 200, r.text
        order_id = r.json()["order_id"]
        doc = db.shop_orders.find_one({"id": order_id})
        assert doc["customer_id"] == customer["id"] and doc["is_trade"] is True
        assert doc["trade_account_number"] == customer["trade_account_number"]

        # shows up in the trade dashboard orders list
        mine = requests.get(f"{BASE_URL}/api/shop/orders", headers={"Authorization": f"Bearer {token}"}, timeout=30)
        assert mine.status_code == 200
        body = mine.json()
        ids = [o.get("id") for o in (body if isinstance(body, list) else body.get("orders", []))]
        assert order_id in ids

        # simulate the paid flip via the shared helper
        before = db.shop_customers.find_one({"email": TRADE_EMAIL})
        db.shop_orders.update_one({"id": order_id}, {"$set": {"payment_status": "paid", "status": "confirmed"}})
        import asyncio
        import sys
        sys.path.insert(0, "/app/backend")
        from motor.motor_asyncio import AsyncIOMotorClient
        from routes.shop import _record_paid_order_for_customer

        async def run():
            adb = AsyncIOMotorClient(MONGO_URL)[DB_NAME]
            await _record_paid_order_for_customer(adb, order_id)
        asyncio.run(run())
        after = db.shop_customers.find_one({"email": TRADE_EMAIL})
        assert after["total_spent"] == pytest.approx((before.get("total_spent") or 0) + 100.0)
        assert after["order_count"] == (before.get("order_count") or 0) + 1
        assert after["credit_balance"] > (before.get("credit_balance") or 0)
        assert db.shop_orders.find_one({"id": order_id}).get("credits_awarded")
        assert db.trade_credits.find_one({"order_id": order_id, "type": "earn"})

    def test_stale_token_does_not_block_checkout(self, account, db):
        r = requests.post(f"{BASE_URL}/api/shop/guest-checkout", json=self._order_payload(),
                          headers={"Authorization": "Bearer not-a-real-token"}, timeout=60)
        assert r.status_code == 200, r.text
        assert db.shop_orders.find_one({"id": r.json()["order_id"]})["customer_id"] is None


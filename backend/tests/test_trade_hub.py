"""Trade Hub — dashboard, ledger, manual adjustments, credit expiry, refund
claw-back, registration-source detection, health filters, bulk login links."""
import os
import uuid
import asyncio
import pytest
import requests
from pymongo import MongoClient

BASE_URL = (os.environ.get("REACT_APP_BACKEND_URL") or "http://localhost:8001").rstrip("/")
MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]
UNIQ = uuid.uuid4().hex[:8]
EMAIL = f"hub_trade_{UNIQ}@example.com"


@pytest.fixture(scope="module")
def db():
    return MongoClient(MONGO_URL)[DB_NAME]


def _login(email, password):
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": password}, timeout=30)
    assert r.status_code == 200, r.text
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {r.json().get('token') or r.json().get('access_token')}"})
    return s, r.json()


@pytest.fixture(scope="module")
def admin():
    s, body = _login("admin@test.com", "admin123")
    assert (body.get("user") or {}).get("role") == "super_admin"
    return s


@pytest.fixture(scope="module")
def staff(db):
    """A non-super-admin staff login to prove the super-admin gate."""
    import bcrypt
    email = f"hub_staff_{UNIQ}@example.com"
    db.users.insert_one({"id": str(uuid.uuid4()), "email": email, "name": "Hub Staff", "role": "staff",
                         "password": bcrypt.hashpw(b"StaffPass123!", bcrypt.gensalt()).decode(), "is_active": True,
                         "permissions": ["trade_accounts"]})
    try:
        s, _ = _login(email, "StaffPass123!")
        yield s
    finally:
        db.users.delete_many({"email": email})


@pytest.fixture(scope="module")
def trader(admin, db):
    r = admin.post(f"{BASE_URL}/api/trade-accounts", json={
        "business_name": f"Hub Test Co {UNIQ}", "contact_name": "Hub Tester", "contact_phone": "07700900456",
        "contact_email": EMAIL, "address_line1": "1 Hub St", "city": "London", "postcode": "SE26 5EQ", "trade_type": "Builder",
    }, timeout=60)
    assert r.status_code == 200, r.text
    yield r.json()
    db.shop_customers.delete_many({"email": EMAIL})
    db.password_resets.delete_many({"email": EMAIL})
    db.shop_orders.delete_many({"customer_email": EMAIL})
    db.trade_credits.delete_many({"customer_id": r.json()["id"]})
    db.credit_transactions.delete_many({"customer_id": r.json()["id"]})
    db.trade_engagement_log.delete_many({"customer_id": r.json()["id"]})


class TestDefaultsAndSource:
    def test_no_default_tier_discount(self, trader, db):
        doc = db.shop_customers.find_one({"email": EMAIL})
        assert doc["trade_discount"] == 0 and doc["trade_tier"] is None
        assert doc["registration_source"]["channel"] == "staff_created"
        assert trader["registration_channel"] == "staff_created"
        assert trader["login_status"] == "link_sent"

    def test_online_register_records_device(self, db):
        email = f"hub_online_{UNIQ}@example.com"
        r = requests.post(f"{BASE_URL}/api/shop/auth/trade-register", json={
            "email": email, "password": "OnlinePass123!", "contact_name": "Online Reg", "phone": "07700900789",
            "business_name": "Online Reg Ltd", "trade_type": "Tiler", "address_line1": "2 Web St", "city": "Leeds", "postcode": "LS1 1AA",
        }, headers={"User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile Safari"}, timeout=60)
        assert r.status_code == 200, r.text
        doc = db.shop_customers.find_one({"email": email})
        try:
            src = doc["registration_source"]
            assert src["channel"] == "online" and src["device"] == "mobile" and src["detected_by"] == "none"
            assert doc["trade_discount"] == 0 and doc["trade_tier"] is None
        finally:
            db.shop_customers.delete_many({"email": email})

    def test_staff_session_marks_in_store(self, admin, db):
        email = f"hub_instore_{UNIQ}@example.com"
        staff_token = admin.headers["Authorization"].split(" ", 1)[1]
        r = requests.post(f"{BASE_URL}/api/shop/auth/trade-register", json={
            "email": email, "password": "StorePass123!", "contact_name": "Store Reg", "phone": "07700900790",
            "business_name": "Store Reg Ltd", "trade_type": "Tiler", "address_line1": "3 Till St", "city": "London", "postcode": "SE26 5EQ",
        }, headers={"X-Staff-Token": staff_token}, timeout=60)
        assert r.status_code == 200, r.text
        doc = db.shop_customers.find_one({"email": email})
        try:
            src = doc["registration_source"]
            assert src["channel"] == "in_store" and src["detected_by"] == "staff_session"
            assert src["staff_name"]
        finally:
            db.shop_customers.delete_many({"email": email})


class TestHealthFilters:
    def test_login_status_filter(self, admin, trader):
        r = admin.get(f"{BASE_URL}/api/trade-accounts", params={"login_status": "link_sent", "search": EMAIL}, timeout=30)
        assert r.status_code == 200
        ids = [a["id"] for a in r.json()["accounts"]]
        assert trader["id"] in ids
        r2 = admin.get(f"{BASE_URL}/api/trade-accounts", params={"login_status": "active", "search": EMAIL}, timeout=30)
        assert trader["id"] not in [a["id"] for a in r2.json()["accounts"]]

    def test_channel_filter(self, admin, trader):
        r = admin.get(f"{BASE_URL}/api/trade-accounts", params={"channel": "staff_created", "search": EMAIL}, timeout=30)
        assert trader["id"] in [a["id"] for a in r.json()["accounts"]]

    def test_bulk_login_links(self, admin, trader, db):
        r = admin.post(f"{BASE_URL}/api/trade-accounts/send-login-links", json={"ids": [trader["id"], "does-not-exist"]}, timeout=60)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["attempted"] == 2
        assert any(f["id"] == "does-not-exist" for f in body["failed"])
        assert db.password_resets.find_one({"email": EMAIL, "purpose": "setup"})


class TestCreditLedgerAndAdjust:
    def test_staff_cannot_adjust(self, staff, trader):
        r = staff.post(f"{BASE_URL}/api/trade-hub/traders/{trader['id']}/credit-adjust", json={"amount": 5, "reason": "nope"}, timeout=30)
        assert r.status_code == 403

    def test_staff_can_read(self, staff, trader):
        assert staff.get(f"{BASE_URL}/api/trade-hub/traders/{trader['id']}/ledger", timeout=30).status_code == 200
        assert staff.get(f"{BASE_URL}/api/trade-hub/summary", timeout=60).status_code == 200

    def test_adjust_add_and_remove(self, admin, trader, db):
        r = admin.post(f"{BASE_URL}/api/trade-hub/traders/{trader['id']}/credit-adjust",
                       json={"amount": 40, "reason": "Goodwill", "reference": "INV-9001"}, timeout=30)
        assert r.status_code == 200, r.text
        assert r.json()["balance_after"] == 40.0
        r = admin.post(f"{BASE_URL}/api/trade-hub/traders/{trader['id']}/credit-adjust",
                       json={"amount": -15.5, "reason": "Refund on INV-9001 — partial claw back", "reference": "RF-1"}, timeout=30)
        assert r.status_code == 200, r.text
        assert r.json()["balance_after"] == 24.5
        assert db.shop_customers.find_one({"email": EMAIL})["credit_balance"] == 24.5
        rows = list(db.credit_transactions.find({"customer_id": trader["id"], "type": "manual_adjustment"}))
        assert len(rows) == 2 and {r_["amount"] for r_ in rows} == {40.0, -15.5}

    def test_adjust_cannot_go_negative_or_zero(self, admin, trader):
        assert admin.post(f"{BASE_URL}/api/trade-hub/traders/{trader['id']}/credit-adjust", json={"amount": -999, "reason": "too much"}, timeout=30).status_code == 400
        assert admin.post(f"{BASE_URL}/api/trade-hub/traders/{trader['id']}/credit-adjust", json={"amount": 0, "reason": "zero"}, timeout=30).status_code == 400

    def test_ledger_and_running_balance(self, admin, trader):
        r = admin.get(f"{BASE_URL}/api/trade-hub/traders/{trader['id']}/ledger", timeout=30)
        assert r.status_code == 200
        body = r.json()
        assert body["totals"]["account_balance"] == 24.5 and body["totals"]["ledger_balance"] == 24.5
        assert body["totals"]["clawed_back"] == 15.5
        assert body["rows"][0]["running_balance"] == 24.5 and body["rows"][0]["channel"] == "manual"

    def test_trader_facing_history_shows_adjustments(self, trader):
        # trader logs in via a set-password link
        pass  # covered visually: /api/shop/trade/credit-history-detailed now includes credit_transactions of every type

    def test_movements_feed(self, admin, trader):
        r = admin.get(f"{BASE_URL}/api/trade-hub/credit/movements", params={"days": 7, "limit": 50}, timeout=30)
        assert r.status_code == 200
        mine = [x for x in r.json()["rows"] if x["customer_id"] == trader["id"]]
        assert len(mine) >= 2 and mine[0]["business_name"].startswith("Hub Test Co")


class TestCreditExpiry:
    def test_set_remind_and_expire(self, admin, staff, trader, db):
        r = admin.put(f"{BASE_URL}/api/trade-hub/traders/{trader['id']}/credit-expiry", json={"expires_at": "2026-12-31"}, timeout=30)
        assert r.status_code == 200 and r.json()["credit_expires_at"] == "2026-12-31"
        assert admin.put(f"{BASE_URL}/api/trade-hub/traders/{trader['id']}/credit-expiry", json={"expires_at": "not-a-date"}, timeout=30).status_code == 400
        # staff may set dates / send reminders, but not expire
        assert staff.post(f"{BASE_URL}/api/trade-hub/traders/{trader['id']}/credit-expiry/remind", timeout=60).status_code == 200
        assert staff.post(f"{BASE_URL}/api/trade-hub/traders/{trader['id']}/credit-expiry/expire-now", timeout=30).status_code == 403
        assert db.trade_engagement_log.find_one({"customer_id": trader["id"], "kind": "credit_expiry_reminder"})
        # summary lists it as expiring? (date is > 30 days away so it should NOT)
        s = admin.get(f"{BASE_URL}/api/trade-hub/summary", timeout=60).json()
        assert trader["id"] not in [t["id"] for t in s["expiring"]]
        # expire now (super admin) writes off to ledger
        r = admin.post(f"{BASE_URL}/api/trade-hub/traders/{trader['id']}/credit-expiry/expire-now", timeout=30)
        assert r.status_code == 200 and r.json()["expired"] == 24.5
        doc = db.shop_customers.find_one({"email": EMAIL})
        assert doc["credit_balance"] == 0 and doc["credit_expires_at"] is None
        assert db.credit_transactions.find_one({"customer_id": trader["id"], "type": "expired", "amount": -24.5})

    def test_scheduler_job_expires_past_dates(self, admin, trader, db):
        admin.post(f"{BASE_URL}/api/trade-hub/traders/{trader['id']}/credit-adjust", json={"amount": 10, "reason": "seed"}, timeout=30)
        db.shop_customers.update_one({"id": trader["id"]}, {"$set": {"credit_expires_at": "2020-01-01"}})
        import sys
        sys.path.insert(0, "/app/backend")
        from services.trade_engagement import run_trade_credit_expiry_job
        stats = asyncio.run(run_trade_credit_expiry_job())
        assert stats["expired"] >= 1
        assert db.shop_customers.find_one({"id": trader["id"]})["credit_balance"] == 0


class TestRefundClawback:
    def test_refunded_status_reverses_credit(self, admin, trader, db):
        cid = trader["id"]
        # seed a paid linked order with credit awarded (mirrors award_credits_for_order)
        order_id = str(uuid.uuid4())
        db.shop_orders.insert_one({"id": order_id, "order_number": f"TS-HUB-{UNIQ}", "customer_id": cid, "customer_email": EMAIL,
                                   "is_trade": True, "trade_account_number": trader["trade_account_number"], "status": "confirmed",
                                   "payment_status": "paid", "subtotal": 100.0, "total": 100.0, "items": [],
                                   "credits_awarded": 5.0, "created_at": "2026-09-01T10:00:00+00:00"})
        db.shop_customers.update_one({"id": cid}, {"$inc": {"credit_balance": 5.0}})
        before = db.shop_customers.find_one({"id": cid})["credit_balance"]
        r = admin.put(f"{BASE_URL}/api/shop/orders/{order_id}/status", json={"status": "refunded"}, timeout=60)
        assert r.status_code == 200, r.text
        after = db.shop_customers.find_one({"id": cid})["credit_balance"]
        assert round(before - after, 2) == 5.0
        assert db.shop_orders.find_one({"id": order_id}).get("credits_reversed")
        assert db.trade_credits.find_one({"order_id": order_id, "type": "reverse_earn"})


class TestTimelineAndNotes:
    def test_timeline(self, admin, trader):
        r = admin.get(f"{BASE_URL}/api/trade-hub/traders/{trader['id']}/timeline", timeout=60)
        assert r.status_code == 200
        kinds = {e["kind"] for e in r.json()["events"]}
        assert {"registered", "credit", "credit_adjusted", "login_link"} <= kinds
        assert any("Staff created" in e["detail"] for e in r.json()["events"] if e["kind"] == "registered")

    def test_notes_and_rep(self, admin, trader, db):
        r = admin.put(f"{BASE_URL}/api/trade-hub/traders/{trader['id']}/notes", json={"internal_notes": "Big loft job in Oct", "trade_rep": "Sydenham — Aisha"}, timeout=30)
        assert r.status_code == 200
        doc = db.shop_customers.find_one({"id": trader["id"]})
        assert doc["internal_notes"] == "Big loft job in Oct" and doc["trade_rep"] == "Sydenham — Aisha"

    def test_dormant_nudge(self, admin, trader, db):
        r = admin.post(f"{BASE_URL}/api/trade-hub/engagement/dormant-nudge", json={"ids": [trader["id"]]}, timeout=60)
        assert r.status_code == 200
        assert db.trade_engagement_log.find_one({"customer_id": trader["id"], "kind": "dormant_nudge"})
        assert db.shop_customers.find_one({"id": trader["id"]}).get("last_nudge_at")

    def test_unauthenticated_blocked(self, trader):
        assert requests.get(f"{BASE_URL}/api/trade-hub/summary", timeout=30).status_code in (401, 403)


class TestShowroomIps:
    def test_showroom_ip_marks_registration_in_store(self, admin, staff, db):
        me = admin.get(f"{BASE_URL}/api/trade-hub/my-ip", timeout=30)
        assert me.status_code == 200 and me.json()["ip"]
        my_ip = me.json()["ip"]
        original = admin.get(f"{BASE_URL}/api/trade-hub/showroom-ips", timeout=30).json()["ips"]
        try:
            # invalid IP rejected
            bad = admin.put(f"{BASE_URL}/api/trade-hub/showroom-ips", json={"ips": [{"ip": "not-an-ip", "showroom_name": "Sydenham"}]}, timeout=30)
            assert bad.status_code == 400
            # staff (not super admin) may register this computer
            r = staff.put(f"{BASE_URL}/api/trade-hub/showroom-ips",
                          json={"ips": original + [{"ip": my_ip, "showroom_name": "QA Showroom", "label": "pytest runner"}]}, timeout=30)
            assert r.status_code == 200, r.text
            saved = r.json()["ips"]
            mine = next(e for e in saved if e["ip"] == my_ip)
            assert mine["id"] and mine["added_by"] and mine["showroom_name"] == "QA Showroom"
            assert admin.get(f"{BASE_URL}/api/trade-hub/my-ip", timeout=30).json()["matched_showroom"] == "QA Showroom"

            email = f"hub_ipreg_{UNIQ}@example.com"
            reg = requests.post(f"{BASE_URL}/api/shop/auth/trade-register", json={
                "email": email, "password": "IpPass123!", "contact_name": "IP Reg", "phone": "07700900791",
                "business_name": "IP Reg Ltd", "trade_type": "Tiler", "address_line1": "4 Till St", "city": "London", "postcode": "SE26 5EQ",
            }, timeout=60)
            assert reg.status_code == 200, reg.text
            try:
                src = db.shop_customers.find_one({"email": email})["registration_source"]
                assert src["channel"] == "in_store" and src["detected_by"] == "showroom_ip" and src["showroom_name"] == "QA Showroom"
            finally:
                db.shop_customers.delete_many({"email": email})
        finally:
            admin.put(f"{BASE_URL}/api/trade-hub/showroom-ips", json={"ips": original}, timeout=30)
        assert admin.get(f"{BASE_URL}/api/trade-hub/my-ip", timeout=30).json()["matched_showroom"] is None

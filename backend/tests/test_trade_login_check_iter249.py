"""Trade login hardening + Login-check diagnostic + login-status taxonomy (iteration 249).
Run: cd /app/backend && python -m pytest tests/test_trade_login_check_iter249.py -q
Needs MONGO_URL, DB_NAME, REACT_APP_BACKEND_URL (falls back to frontend/.env)."""
import os
import uuid

import pytest
import requests
from pymongo import MongoClient

from dotenv import load_dotenv
load_dotenv("/app/backend/.env")
load_dotenv("/app/frontend/.env")

API = os.environ["REACT_APP_BACKEND_URL"].rstrip("/") + "/api"
db = MongoClient(os.environ["MONGO_URL"])[os.environ["DB_NAME"]]

TAG = uuid.uuid4().hex[:8]
EMAIL = f"iter249.trader.{TAG}@example.com"
PASSWORD = "OwnPass123!"
DUP_PASSWORD = "OtherPass456!"


def _admin_token():
    r = requests.post(f"{API}/auth/login", json={"email": "admin@test.com", "password": "admin123"}, timeout=30)
    assert r.status_code == 200, r.text
    return r.json().get("token") or r.json().get("access_token")


@pytest.fixture(scope="module")
def ctx():
    r = requests.post(f"{API}/shop/auth/trade-register", json={
        "email": EMAIL, "password": PASSWORD, "contact_name": "Iter Trader", "phone": "07000000249",
        "business_name": f"Iter249 {TAG} Ltd", "business_type": "sole_trader", "trade_type": "Tiler",
        "address_line1": "1 Test St", "city": "London", "postcode": "E1 1AA", "is_trade": True}, timeout=30)
    assert r.status_code == 200, r.text
    trader = db.shop_customers.find_one({"email": EMAIL})
    assert trader and trader["password"].startswith("$2"), "registration must store a bcrypt hash"
    # Legacy duplicate: same email, different case, older record, different password → sits FIRST in natural order? no —
    # inserted later, so we also insert a *bad-hash* record to prove unreadable hashes are skipped, not 500s.
    dup_id = str(uuid.uuid4())
    from services import hash_password
    db.shop_customers.insert_one({"id": dup_id, "email": EMAIL.upper(), "password": hash_password(DUP_PASSWORD),
                                  "name": "Dup Retail", "created_at": "2025-01-01T00:00:00+00:00", "wishlist": [], "cart": []})
    bad_id = str(uuid.uuid4())
    db.shop_customers.insert_one({"id": bad_id, "email": EMAIL, "password": "plaintext-not-a-hash", "name": "Bad Hash",
                                  "created_at": "2024-01-01T00:00:00+00:00"})
    staff_id = str(uuid.uuid4())
    db.shop_customers.insert_one({"id": staff_id, "email": f"iter249.staff.{TAG}@example.com", "password": hash_password(uuid.uuid4().hex),
                                  "name": "Staff Made", "is_trade": True, "trade_account_number": f"T-X{TAG[:5]}", "status": "active",
                                  "registration_source": {"channel": "staff_created"}, "created_at": "2026-09-01T00:00:00+00:00"})
    nopw_id = str(uuid.uuid4())
    db.shop_customers.insert_one({"id": nopw_id, "email": f"iter249.nopw.{TAG}@example.com", "name": "No Password", "is_trade": True,
                                  "trade_account_number": f"T-Y{TAG[:5]}", "status": "active", "created_at": "2026-05-01T00:00:00+00:00"})
    yield {"trader": trader, "dup_id": dup_id, "bad_id": bad_id, "staff_id": staff_id, "nopw_id": nopw_id, "admin": _admin_token()}
    db.shop_customers.delete_many({"id": {"$in": [trader["id"], dup_id, bad_id, staff_id, nopw_id]}})
    db.customer_logins.delete_many({"customer_id": trader["id"]})
    db.trade_engagement_log.delete_many({"customer_id": trader["id"]})
    db.password_resets.delete_many({"email": {"$regex": f"iter249.*{TAG}", "$options": "i"}})


def test_login_with_own_password_despite_duplicates(ctx):
    """Three records share the email (bad hash, other-password retail, the trader). The trader's password must get in."""
    r = requests.post(f"{API}/shop/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=30)
    assert r.status_code == 200, r.text
    assert r.json()["customer"]["id"] == ctx["trader"]["id"]
    assert r.json()["customer"]["is_trade"] is True


def test_login_duplicate_password_reaches_its_own_record(ctx):
    r = requests.post(f"{API}/shop/auth/login", json={"email": EMAIL.upper(), "password": DUP_PASSWORD}, timeout=30)
    assert r.status_code == 200, r.text
    assert r.json()["customer"]["id"] == ctx["dup_id"]


def test_login_wrong_password_is_401_not_500(ctx):
    r = requests.post(f"{API}/shop/auth/login", json={"email": EMAIL, "password": "nope-nope-nope"}, timeout=30)
    assert r.status_code == 401


def test_login_records_last_login_and_customer_logins(ctx):
    doc = db.shop_customers.find_one({"id": ctx["trader"]["id"]})
    assert doc.get("last_login_at")
    assert db.customer_logins.count_documents({"customer_id": ctx["trader"]["id"]}) >= 1


def test_login_check_endpoint_green_for_self_registered(ctx):
    H = {"Authorization": f"Bearer {ctx['admin']}"}
    r = requests.get(f"{API}/trade-hub/traders/{ctx['trader']['id']}/login-check", headers=H, timeout=30)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["has_password"] is True and d["password_format_ok"] is True
    assert d["staff_created"] is False
    assert d["login_status"] == "active"
    assert d["online_orders"] == 0
    assert len(d["duplicates"]) == 2 and {x["id"] for x in d["duplicates"]} == {ctx["dup_id"], ctx["bad_id"]}
    assert d["verdict"]["level"] == "amber" and "share this email" in d["verdict"]["headline"]
    assert "password" not in {k.lower() for k in d.keys()} or "password" not in d  # hash never leaks
    assert len(d["recent_logins"]) >= 1


def test_login_check_staff_created_and_no_password(ctx):
    H = {"Authorization": f"Bearer {ctx['admin']}"}
    d = requests.get(f"{API}/trade-hub/traders/{ctx['staff_id']}/login-check", headers=H, timeout=30).json()
    assert d["staff_created"] is True and d["login_status"] == "never"
    assert d["verdict"]["level"] == "amber" and "Staff-created" in d["verdict"]["headline"]
    d = requests.get(f"{API}/trade-hub/traders/{ctx['nopw_id']}/login-check", headers=H, timeout=30).json()
    assert d["has_password"] is False and d["login_status"] == "never"
    assert d["verdict"]["level"] == "red" and "No password" in d["verdict"]["headline"]


def test_login_check_404_and_auth(ctx):
    H = {"Authorization": f"Bearer {ctx['admin']}"}
    assert requests.get(f"{API}/trade-hub/traders/does-not-exist/login-check", headers=H, timeout=30).status_code == 404
    assert requests.get(f"{API}/trade-hub/traders/{ctx['trader']['id']}/login-check", timeout=30).status_code in (401, 403)


def test_trade_accounts_list_status_taxonomy(ctx):
    H = {"Authorization": f"Bearer {ctx['admin']}"}
    def status_of(cid):
        r = requests.get(f"{API}/trade-accounts/{cid}", headers=H, timeout=30)
        assert r.status_code == 200, r.text
        return r.json()
    a = status_of(ctx["trader"]["id"])
    assert a["login_status"] == "active" and a["has_password"] is True and "password" not in a
    assert status_of(ctx["staff_id"])["login_status"] == "never"
    assert status_of(ctx["nopw_id"])["login_status"] == "never"
    # a self-registered trader with no tracked login → ready
    db.shop_customers.update_one({"id": ctx["trader"]["id"]}, {"$unset": {"last_login_at": ""}})
    assert status_of(ctx["trader"]["id"])["login_status"] == "ready"
    # filters
    for st in ("ready", "never", "link_sent", "active"):
        r = requests.get(f"{API}/trade-accounts", params={"login_status": st, "search": f"iter249", "limit": 50}, headers=H, timeout=30)
        assert r.status_code == 200, r.text
        ids = {x["id"] for x in r.json()["accounts"]}
        if st == "ready":
            assert ctx["trader"]["id"] in ids and ctx["staff_id"] not in ids and ctx["nopw_id"] not in ids
        if st == "never":
            assert ctx["staff_id"] in ids and ctx["nopw_id"] in ids and ctx["trader"]["id"] not in ids
        if st in ("link_sent", "active"):
            assert not ({ctx["trader"]["id"], ctx["staff_id"], ctx["nopw_id"]} & ids)


def test_summary_counts_no_login_correctly(ctx):
    H = {"Authorization": f"Bearer {ctx['admin']}"}
    r = requests.get(f"{API}/trade-hub/summary", headers=H, timeout=60)
    assert r.status_code == 200, r.text
    d = r.json()
    assert "login_ready" in d["kpis"] and "logged_in" in d["kpis"] and d["login_tracking_since"] == "2026-09-08"
    listed = {t["id"] for t in d["never_logged_in"]}
    assert ctx["staff_id"] in listed and ctx["nopw_id"] in listed
    assert ctx["trader"]["id"] not in listed, "self-registered trader with own password must NOT be in the send-links list"
    assert all(t["login_status"] in ("never", "link_sent") for t in d["never_logged_in"])


def test_telegram_event_registered():
    from services.telegram_notify import _default_config
    assert _default_config()["events"]["trade_login"] is True


def test_first_login_welcome_logged_once(ctx):
    import time
    for _ in range(20):
        doc = db.shop_customers.find_one({"id": ctx["trader"]["id"]})
        if doc.get("first_login_email_sent_at"):
            break
        time.sleep(0.5)
    assert doc.get("first_login_email_sent_at"), "first sign-in must claim first_login_email_sent_at"
    # second sign-in → no second welcome
    r = requests.post(f"{API}/shop/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=30)
    assert r.status_code == 200
    time.sleep(1.5)
    events = list(db.trade_engagement_log.find({"customer_id": ctx["trader"]["id"], "kind": "first_login_welcome"}))
    assert len(events) == 1, f"expected exactly one first_login_welcome event, got {len(events)}"
    assert events[0]["meta"]["returning"] is False  # registered after tracking began
    assert "trade ref" in events[0]["summary"].lower()


def test_logins_30d_and_engaged_sort(ctx):
    H = {"Authorization": f"Bearer {ctx['admin']}"}
    r = requests.get(f"{API}/trade-accounts", params={"search": "iter249", "sort": "engaged", "limit": 50}, headers=H, timeout=30)
    assert r.status_code == 200, r.text
    rows = r.json()["accounts"]
    ids = [x["id"] for x in rows]
    assert ids[0] == ctx["trader"]["id"], "trader with sign-ins must sort first under 'engaged'"
    me = rows[0]
    assert me["logins_30d"] >= 2 and me["last_login_at"]
    assert all(x["logins_30d"] == 0 for x in rows if x["id"] in (ctx["staff_id"], ctx["nopw_id"]))
    r = requests.get(f"{API}/trade-accounts", params={"search": "iter249", "limit": 50}, headers=H, timeout=30)
    assert "logins_30d" in r.json()["accounts"][0]


def test_timeline_shows_first_login_welcome(ctx):
    H = {"Authorization": f"Bearer {ctx['admin']}"}
    r = requests.get(f"{API}/trade-hub/traders/{ctx['trader']['id']}/timeline", headers=H, timeout=30)
    assert r.status_code == 200, r.text
    kinds = [e["kind"] for e in r.json()["events"]]
    assert "first_login_welcome" in kinds and "login" in kinds

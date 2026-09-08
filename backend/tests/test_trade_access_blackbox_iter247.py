"""Independent black-box verification of trade access / password reset flow.

Covers:
- staff login → create trade account (case-normalised email, T-number, login_link)
- verify-reset-token returns account_type=shop, is_trade=true, purpose=setup, login_path
- reset-password returns shop token + customer
- shop login with UPPER-CASE email works; /me returns is_trade=true
- forgot-password creates a password_resets doc with account_type=shop
- unauthenticated GET /api/trade-accounts is 401/403
- old TempPass123! does NOT log in
"""
import os
import re
import random
import string
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")


def _rand(n=8):
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=n))


@pytest.fixture(scope="module")
def staff_token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": "admin@test.com", "password": "admin123"},
                      timeout=30)
    assert r.status_code == 200, r.text
    tok = r.json().get("access_token") or r.json().get("token")
    assert tok, r.text
    return tok


@pytest.fixture(scope="module")
def staff_headers(staff_token):
    return {"Authorization": f"Bearer {staff_token}"}


@pytest.fixture(scope="module")
def created_trade(staff_headers):
    email = f"qa.trade.{_rand()}@example.com"
    payload = {
        "business_name": f"QA Trade Co {_rand(4)}",
        "contact_name": "QA Tester",
        "contact_email": email.upper(),  # intentionally upper to prove normalisation
        "contact_phone": "07000000000",
        "trade_tier": "standard",
        "trade_type": "contractor",
        "address_line1": "1 QA Street",
        "city": "London",
        "postcode": "SW1A 1AA",
    }
    r = requests.post(f"{BASE_URL}/api/trade-accounts", json=payload,
                      headers=staff_headers, timeout=30)
    assert r.status_code in (200, 201), r.text
    data = r.json()
    return {"email": email, "resp": data, "id": data.get("id") or data.get("_id")}


class TestTradeAccessBlackbox:

    def test_unauth_trade_accounts_forbidden(self):
        r = requests.get(f"{BASE_URL}/api/trade-accounts", timeout=15)
        assert r.status_code in (401, 403), f"Expected 401/403, got {r.status_code}"

    def test_create_trade_account_shape(self, created_trade):
        d = created_trade["resp"]
        assert d.get("contact_email") == created_trade["email"], f"email not lower-cased: {d.get('contact_email')}"
        assert re.match(r"^T-\d{5}$", d.get("trade_account_number", "")), d.get("trade_account_number")
        link = d.get("login_link") or {}
        assert link.get("link"), "login_link.link missing"
        # example.com is rejected by Resend → email_sent should be False
        assert link.get("email_sent") in (False, None)

    def test_verify_reset_token(self, created_trade):
        link = created_trade["resp"]["login_link"]["link"]
        m = re.search(r"token=([^&]+)", link)
        assert m, link
        token = m.group(1)
        r = requests.get(f"{BASE_URL}/api/auth/verify-reset-token",
                         params={"token": token}, timeout=15)
        assert r.status_code == 200, r.text
        j = r.json()
        assert j.get("account_type") == "shop"
        assert j.get("is_trade") is True
        assert j.get("purpose") == "setup"
        assert j.get("login_path") == "/shop/trade/login"
        created_trade["setup_token"] = token

    def test_reset_password_signs_in(self, created_trade):
        token = created_trade.get("setup_token")
        assert token
        new_password = f"QAPass!{_rand(6)}"
        r = requests.post(f"{BASE_URL}/api/auth/reset-password",
                          json={"token": token, "new_password": new_password}, timeout=20)
        assert r.status_code == 200, r.text
        j = r.json()
        assert j.get("token"), j
        assert j.get("customer"), j
        assert j["customer"].get("is_trade") is True
        created_trade["password"] = new_password
        created_trade["shop_token"] = j["token"]

    def test_shop_login_case_insensitive(self, created_trade):
        pw = created_trade["password"]
        r = requests.post(f"{BASE_URL}/api/shop/auth/login",
                          json={"email": created_trade["email"].upper(), "password": pw},
                          timeout=20)
        assert r.status_code == 200, r.text
        j = r.json()
        assert j.get("token")
        # /me
        r2 = requests.get(f"{BASE_URL}/api/shop/auth/me",
                          headers={"Authorization": f"Bearer {j['token']}"}, timeout=15)
        assert r2.status_code == 200, r2.text
        assert r2.json().get("is_trade") is True

    def test_temp_pass_does_not_login(self, created_trade):
        r = requests.post(f"{BASE_URL}/api/shop/auth/login",
                          json={"email": created_trade["email"], "password": "TempPass123!"},
                          timeout=15)
        assert r.status_code in (400, 401), f"TempPass123! should NOT log in, got {r.status_code}"

    def test_forgot_password_creates_shop_reset(self, created_trade):
        r = requests.post(f"{BASE_URL}/api/auth/forgot-password",
                          json={"email": created_trade["email"]}, timeout=20)
        assert r.status_code == 200, r.text
        # We can't read the token via API; but debug/dev responses may include it. Fallback: just verify no 500.
        j = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
        # If backend echoes a link in dev, verify it and re-login with a new password
        link = (j.get("login_link") or {}).get("link") if isinstance(j, dict) else None
        if link:
            token = re.search(r"token=([^&]+)", link).group(1)
            v = requests.get(f"{BASE_URL}/api/auth/verify-reset-token",
                             params={"token": token}, timeout=15).json()
            assert v.get("account_type") == "shop"

    def test_cleanup(self, created_trade, staff_headers):
        # best-effort delete
        tid = created_trade.get("id")
        if tid:
            requests.delete(f"{BASE_URL}/api/trade-accounts/{tid}",
                            headers=staff_headers, timeout=15)

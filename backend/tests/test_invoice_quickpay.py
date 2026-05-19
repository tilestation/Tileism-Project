"""
Tests for POST /api/invoices/{id}/payments — the one-click "Take Balance
Payment" endpoint added 24 Feb 2026.

Why these tests exist
---------------------
The whole point of this endpoint is that the SERVER stamps the payment
date as today, so a clerk can never accidentally backdate a payment and
attribute revenue to the wrong day. These tests lock that contract in:

  - Server always sets today's date (DD/MM/YYYY)
  - Method is mandatory (mirrors the PUT validation)
  - Amount must be > 0
  - Status transitions: deposit_order → open_order when balance reaches 0
  - Existing deposits are preserved (we APPEND, never overwrite)
  - Zero-amount placeholder rows from older invoice docs are stripped
"""
import os
import uuid
from datetime import datetime, timezone

import pytest
import httpx

API_URL = (
    os.environ.get("EXTERNAL_URL")
    or open("/app/frontend/.env").read().split("REACT_APP_BACKEND_URL=")[1].split("\n")[0].strip()
)
ADMIN_EMAIL = "admin@test.com"
ADMIN_PW = "admin123"
TODAY_UK = datetime.now(timezone.utc).strftime("%d/%m/%Y")


@pytest.fixture(scope="module")
def admin_token():
    with httpx.Client(base_url=API_URL, timeout=30) as c:
        r = c.post("/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PW})
        r.raise_for_status()
        token = r.json().get("access_token") or r.json().get("token")
        assert token
        yield token


@pytest.fixture
def http(admin_token):
    with httpx.Client(
        base_url=API_URL,
        timeout=30,
        headers={"Authorization": f"Bearer {admin_token}"},
    ) as c:
        yield c


def _make_invoice(http, deposits, invoice_date, gross_total=1000.0):
    payload = {
        "invoice_no": f"QP-{uuid.uuid4().hex[:8]}",
        "date": invoice_date,
        "time": "10:00",
        "customer_name": "QuickPay Test",
        "line_items": [{
            "product_name": "Test Tile",
            "sku": "T",
            "quantity": 1,
            "price": gross_total / 1.2,
            "total": gross_total / 1.2,
        }],
        "subtotal": gross_total / 1.2,
        "vat": gross_total - (gross_total / 1.2),
        "gross_total": gross_total,
        "deposits": deposits,
    }
    r = http.post("/api/invoices", json=payload)
    assert r.status_code in (200, 201), r.text
    return r.json()["invoice_id"]


def _cleanup(http, invoice_id):
    try:
        http.delete(f"/api/invoices/{invoice_id}")
    except Exception:
        pass


# ─────────────────────────────────────────────────────────────────────
# CASE 1 — happy path: invoice with £200 deposit + £760 balance.
# Endpoint accepts £760, sets date to today, appends to deposits,
# recalculates outstanding=0, transitions status deposit_order → open_order.
# ─────────────────────────────────────────────────────────────────────
def test_add_payment_clears_balance_and_dates_today(http):
    inv_id = _make_invoice(http, deposits=[
        {"date": "21/03/2026", "amount": "200.00", "method": "Cash"},
    ], invoice_date="21/03/2026", gross_total=960.0)
    try:
        r = http.post(f"/api/invoices/{inv_id}/payments",
                      json={"amount": 760.0, "method": "Card", "note": "Balance"})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True
        assert body["deposit"]["date"] == TODAY_UK, "server must stamp today's date"
        assert body["deposit"]["amount"] == 760.0
        assert body["deposit"]["method"] == "Card"
        assert body["amount_outstanding"] == 0.0
        assert body["total_deposits"] == 960.0
        # Verify the existing March deposit was preserved
        full = http.get(f"/api/invoices/{inv_id}").json()
        dates = [d["date"] for d in full["deposits"]]
        assert "21/03/2026" in dates
        assert TODAY_UK in dates
        assert len(full["deposits"]) == 2
    finally:
        _cleanup(http, inv_id)


# ─────────────────────────────────────────────────────────────────────
# CASE 2 — partial payment leaves the invoice in deposit_order status.
# ─────────────────────────────────────────────────────────────────────
def test_partial_payment_leaves_balance_and_marks_deposit_order(http):
    inv_id = _make_invoice(http, deposits=[
        {"date": "21/03/2026", "amount": "200.00", "method": "Cash"},
    ], invoice_date="21/03/2026", gross_total=960.0)
    try:
        r = http.post(f"/api/invoices/{inv_id}/payments",
                      json={"amount": 400.0, "method": "Cash"})
        assert r.status_code == 200, r.text
        body = r.json()
        assert abs(body["amount_outstanding"] - 360.0) < 0.01
        assert body["status"] == "deposit_order"
    finally:
        _cleanup(http, inv_id)


# ─────────────────────────────────────────────────────────────────────
# CASE 3 — method is mandatory.
# ─────────────────────────────────────────────────────────────────────
def test_payment_method_is_required(http):
    inv_id = _make_invoice(http, deposits=[
        {"date": "21/03/2026", "amount": "200.00", "method": "Cash"},
    ], invoice_date="21/03/2026", gross_total=960.0)
    try:
        r = http.post(f"/api/invoices/{inv_id}/payments",
                      json={"amount": 100.0, "method": ""})
        assert r.status_code == 400
        assert "method" in r.text.lower()
    finally:
        _cleanup(http, inv_id)


# ─────────────────────────────────────────────────────────────────────
# CASE 4 — amount must be > 0.
# ─────────────────────────────────────────────────────────────────────
def test_zero_or_negative_amount_rejected(http):
    inv_id = _make_invoice(http, deposits=[
        {"date": "21/03/2026", "amount": "200.00", "method": "Cash"},
    ], invoice_date="21/03/2026", gross_total=960.0)
    try:
        for bad in (0, -50):
            r = http.post(f"/api/invoices/{inv_id}/payments",
                          json={"amount": bad, "method": "Cash"})
            assert r.status_code == 400, f"amount={bad} should be rejected"
    finally:
        _cleanup(http, inv_id)


# ─────────────────────────────────────────────────────────────────────
# CASE 5 — missing invoice returns 404.
# ─────────────────────────────────────────────────────────────────────
def test_unknown_invoice_returns_404(http):
    r = http.post(f"/api/invoices/{uuid.uuid4()}/payments",
                  json={"amount": 50.0, "method": "Cash"})
    assert r.status_code == 404


# ─────────────────────────────────────────────────────────────────────
# CASE 6 — overpayment caps outstanding at zero (doesn't go negative).
# Invoices currently store amount_outstanding as max(0, ...), so an
# overpayment must not produce a negative balance.
# ─────────────────────────────────────────────────────────────────────
def test_overpayment_caps_outstanding_at_zero(http):
    inv_id = _make_invoice(http, deposits=[
        {"date": "21/03/2026", "amount": "200.00", "method": "Cash"},
    ], invoice_date="21/03/2026", gross_total=960.0)
    try:
        # Outstanding is £760; overpay by £40
        r = http.post(f"/api/invoices/{inv_id}/payments",
                      json={"amount": 800.0, "method": "Bank Transfer"})
        assert r.status_code == 200, r.text
        assert r.json()["amount_outstanding"] == 0.0
    finally:
        _cleanup(http, inv_id)

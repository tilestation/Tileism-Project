"""
Tests for GET /api/invoices/outstanding-balances and the refunds_today
field added to /api/invoices/reconciliation/daily on 24 Feb 2026.

Context
-------
The user spotted a £273 discrepancy between Sales & EPOS "Today's
Numbers" (£12,047.91) and Invoice History "Daily Revenue" (£11,774.91)
for the same 31 invoices. Root cause: Invoice History subtracted today's
refunds; the reconciliation endpoint didn't. Both should match — both
represent "what should be in the till".

We also added GET /outstanding-balances to power the new Outstanding
Balances widget shown above the EPOS tab content.
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
        "invoice_no": f"OUT-{uuid.uuid4().hex[:8]}",
        "date": invoice_date,
        "customer_name": "Outstanding Test Customer",
        "line_items": [{
            "product_name": "Test", "sku": "T", "quantity": 1,
            "price": gross_total / 1.2, "total": gross_total / 1.2,
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
# Outstanding balances endpoint
# ─────────────────────────────────────────────────────────────────────
def test_outstanding_balances_lists_unpaid_invoices(http):
    """An invoice with £200 deposit / £800 outstanding shows up at the top."""
    inv_id = _make_invoice(http, deposits=[
        {"date": TODAY_UK, "amount": "200.00", "method": "Cash"},
    ], invoice_date=TODAY_UK, gross_total=1000.0)
    try:
        r = http.get("/api/invoices/outstanding-balances?limit=5")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["count"] >= 1
        ids = [i["id"] for i in body["invoices"]]
        assert inv_id in ids
        my_row = next(i for i in body["invoices"] if i["id"] == inv_id)
        assert my_row["amount_outstanding"] == 800.0
        assert my_row["total_deposits"] == 200.0
        assert my_row["gross_total"] == 1000.0
        assert my_row["invoice_no"].startswith("OUT-")
    finally:
        _cleanup(http, inv_id)


def test_fully_paid_invoice_does_not_appear(http):
    """Once balance reaches 0, the invoice should drop off the list."""
    inv_id = _make_invoice(http, deposits=[
        {"date": TODAY_UK, "amount": "1000.00", "method": "Cash"},
    ], invoice_date=TODAY_UK, gross_total=1000.0)
    try:
        r = http.get("/api/invoices/outstanding-balances?limit=20")
        assert r.status_code == 200
        ids = [i["id"] for i in r.json()["invoices"]]
        assert inv_id not in ids
    finally:
        _cleanup(http, inv_id)


def test_outstanding_balances_sorted_oldest_first(http):
    """Older invoice should appear before newer one."""
    old_id = _make_invoice(http, deposits=[
        {"date": "01/01/2026", "amount": "100.00", "method": "Cash"},
    ], invoice_date="01/01/2026", gross_total=500.0)
    new_id = _make_invoice(http, deposits=[
        {"date": TODAY_UK, "amount": "100.00", "method": "Cash"},
    ], invoice_date=TODAY_UK, gross_total=500.0)
    try:
        r = http.get("/api/invoices/outstanding-balances?limit=50")
        assert r.status_code == 200
        invs = r.json()["invoices"]
        old_pos = next((i for i, inv in enumerate(invs) if inv["id"] == old_id), -1)
        new_pos = next((i for i, inv in enumerate(invs) if inv["id"] == new_id), -1)
        assert old_pos >= 0 and new_pos >= 0
        assert old_pos < new_pos, "Older outstanding invoice must appear before newer one"
    finally:
        _cleanup(http, old_id)
        _cleanup(http, new_id)


def test_outstanding_balances_limit_caps_results(http):
    """`limit` param caps the returned `invoices` list but `count` is the full total."""
    created = []
    try:
        for i in range(3):
            created.append(_make_invoice(http, deposits=[
                {"date": TODAY_UK, "amount": "10.00", "method": "Cash"},
            ], invoice_date=TODAY_UK, gross_total=100.0))
        r = http.get("/api/invoices/outstanding-balances?limit=1")
        assert r.status_code == 200
        body = r.json()
        assert len(body["invoices"]) == 1
        assert body["count"] >= 3, "count must reflect ALL matching, not just returned"
    finally:
        for c in created:
            _cleanup(http, c)


# ─────────────────────────────────────────────────────────────────────
# Reconciliation endpoint now subtracts refunds (£273 bug fix)
# ─────────────────────────────────────────────────────────────────────
def test_reconciliation_response_has_refund_fields(http):
    """New refunds_today + refund_count fields must be present."""
    r = http.get("/api/invoices/reconciliation/daily")
    assert r.status_code == 200, r.text
    body = r.json()
    # Type checks — these MUST exist after the 24 Feb 2026 change
    assert "refunds_today" in body, "refunds_today field missing from reconciliation"
    assert "refund_count" in body, "refund_count field missing from reconciliation"
    assert isinstance(body["refunds_today"], (int, float))
    assert isinstance(body["refund_count"], int)
    # Net takings formula: gross_invoiced − credit_redeemed − refunds_today
    expected_net = round(
        body["gross_invoiced"] - body["credit_redeemed"] - body["refunds_today"], 2,
    )
    assert abs(body["net_takings"] - expected_net) < 0.01, (
        f"net_takings ({body['net_takings']}) must equal gross_invoiced − credit_redeemed − refunds_today ({expected_net})"
    )

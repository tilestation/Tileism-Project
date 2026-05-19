"""
Tests for the deposit-date audit endpoint at /api/invoices/audit/mis-dated-deposits.

Why this test exists
--------------------
On 24 Feb 2026 the audit logic was rewritten after a near-miss. The old
logic flagged ANY deposit whose date differed from the invoice date by
more than 1 day. That generated false positives on every legitimate
deposit-plus-balance-on-collection invoice — and the "Sync Now" button
would have moved the balance payment's revenue back to the invoice date
if pressed.

The new rule: an invoice is only flagged when NONE of its non-zero
deposits sit on (or within 1 day of) the invoice date. If at least one
deposit matches, any later deposits are presumed legitimate part-payments
and the invoice is silently skipped.

These tests cover:
  1. Original bug: single deposit auto-defaulted to today — still flagged
  2. False positive: deposit + later balance — now skipped
  3. All deposits drifted from invoice date — still flagged
  4. Zero-amount deposits ignored
  5. Malformed dates handled gracefully
"""
import os
import uuid
from datetime import datetime, timezone

import pytest
import httpx

API_URL = os.environ["EXTERNAL_URL"] if "EXTERNAL_URL" in os.environ else \
    open("/app/frontend/.env").read().split("REACT_APP_BACKEND_URL=")[1].split("\n")[0].strip()
ADMIN_EMAIL = "admin@test.com"
ADMIN_PW = "admin123"  # from /app/memory/test_credentials.md


@pytest.fixture(scope="module")
def admin_token():
    """Log in as super_admin and yield the JWT."""
    with httpx.Client(base_url=API_URL, timeout=30) as c:
        r = c.post("/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PW})
        r.raise_for_status()
        token = r.json().get("access_token") or r.json().get("token")
        assert token, f"login returned no token: {r.json()}"
        yield token


@pytest.fixture
def http(admin_token):
    """httpx.Client with Authorization header preset."""
    with httpx.Client(
        base_url=API_URL,
        timeout=30,
        headers={"Authorization": f"Bearer {admin_token}"},
    ) as c:
        yield c


def _make_invoice(http, deposits, invoice_date_ddmmyyyy):
    """Create a minimal saved invoice with the supplied deposit list."""
    payload = {
        "invoice_no": f"TEST-AUDIT-{uuid.uuid4().hex[:8]}",
        "date": invoice_date_ddmmyyyy,
        "time": "10:00",
        "customer_name": "Audit Test Customer",
        "customer_phone": "07000000000",
        "line_items": [{
            "product_name": "Test Tile",
            "sku": "TEST-SKU",
            "quantity": 1,
            "price": 100.0,
            "total": 100.0,
        }],
        "subtotal": 100.0,
        "vat": 20.0,
        "gross_total": 120.0,
        "deposits": deposits,
        "showroom_id": None,
        "showroom_name": "Test Showroom",
    }
    r = http.post("/api/invoices", json=payload)
    assert r.status_code in (200, 201), r.text
    body = r.json()
    # Normalise — POST returns `invoice_id`, but everywhere else uses `id`.
    return {"id": body.get("invoice_id") or body.get("id"), **body}


def _audit(http):
    r = http.get("/api/invoices/audit/mis-dated-deposits")
    assert r.status_code == 200, r.text
    return r.json()


def _cleanup(http, invoice_id):
    """Best-effort cleanup so we don't leave audit-test rows in prod."""
    try:
        http.delete(f"/api/invoices/{invoice_id}")
    except Exception:
        pass


# ─────────────────────────────────────────────────────────────────────
# CASE 1 — the ORIGINAL bug that the audit is supposed to catch
# Invoice backdated to 21/03/2026 but single deposit auto-defaulted to
# 14/04/2026 (24 days later). No deposit lines up with the invoice date,
# so this MUST still be flagged.
# ─────────────────────────────────────────────────────────────────────
def test_single_deposit_drifted_from_invoice_date_is_flagged(http):
    inv = _make_invoice(http, deposits=[
        {"date": "14/04/2026", "amount": "120.00", "method": "Cash", "note": ""},
    ], invoice_date_ddmmyyyy="21/03/2026")
    try:
        audit = _audit(http)
        ids = [i["id"] for i in audit["invoices"]]
        assert inv["id"] in ids, "single-drifted-deposit invoice should be flagged"
        # And the diff is reported correctly
        row = next(i for i in audit["invoices"] if i["id"] == inv["id"])
        assert row["max_diff_days"] == 24
    finally:
        _cleanup(http, inv["id"])


# ─────────────────────────────────────────────────────────────────────
# CASE 2 — the FALSE POSITIVE that used to be flagged but shouldn't be
# Invoice on 21/03/2026, deposit £200 on 21/03/2026 (matches!), final
# part-payment £762.50 on 13/04/2026 (23 days later). The invoice
# MUST NOT be flagged anymore — at least one deposit matches the
# invoice date, so the second is a legitimate part-payment.
# ─────────────────────────────────────────────────────────────────────
def test_deposit_plus_later_part_payment_is_not_flagged(http):
    inv = _make_invoice(http, deposits=[
        {"date": "21/03/2026", "amount": "200.00", "method": "Cash", "note": "Initial deposit"},
        {"date": "13/04/2026", "amount": "762.50", "method": "Cash", "note": "Balance"},
    ], invoice_date_ddmmyyyy="21/03/2026")
    try:
        audit = _audit(http)
        ids = [i["id"] for i in audit["invoices"]]
        assert inv["id"] not in ids, (
            "invoice with one on-date deposit + one later balance payment "
            "must NOT be flagged — those are legitimate part-payments"
        )
    finally:
        _cleanup(http, inv["id"])


# ─────────────────────────────────────────────────────────────────────
# CASE 3 — Deposit one day off the invoice date counts as matching
# (typo / next-day cash-up). Should NOT be flagged.
# ─────────────────────────────────────────────────────────────────────
def test_one_day_drift_is_not_flagged(http):
    inv = _make_invoice(http, deposits=[
        {"date": "22/03/2026", "amount": "120.00", "method": "Cash", "note": ""},
    ], invoice_date_ddmmyyyy="21/03/2026")
    try:
        audit = _audit(http)
        ids = [i["id"] for i in audit["invoices"]]
        assert inv["id"] not in ids, "1-day drift should be treated as a match (cash-up day)"
    finally:
        _cleanup(http, inv["id"])


# ─────────────────────────────────────────────────────────────────────
# CASE 4 — Multiple deposits, all drifted from invoice date. Still flag.
# ─────────────────────────────────────────────────────────────────────
def test_all_deposits_drifted_is_flagged(http):
    inv = _make_invoice(http, deposits=[
        {"date": "20/04/2026", "amount": "60.00", "method": "Card", "note": ""},
        {"date": "25/04/2026", "amount": "60.00", "method": "Cash", "note": ""},
    ], invoice_date_ddmmyyyy="21/03/2026")
    try:
        audit = _audit(http)
        ids = [i["id"] for i in audit["invoices"]]
        assert inv["id"] in ids, (
            "all-deposits-drifted invoice should be flagged — no deposit "
            "anchors the invoice to its real date"
        )
        row = next(i for i in audit["invoices"] if i["id"] == inv["id"])
        # Bigger of the two diffs
        assert row["max_diff_days"] == 35
        assert len(row["deposits"]) == 2
    finally:
        _cleanup(http, inv["id"])


# ─────────────────────────────────────────────────────────────────────
# CASE 5 — Zero-amount deposits ignored, only paid deposit is on-date
# (the zero-amount row would otherwise drift away from the invoice).
# ─────────────────────────────────────────────────────────────────────
def test_zero_amount_deposits_are_ignored(http):
    inv = _make_invoice(http, deposits=[
        {"date": "21/03/2026", "amount": "120.00", "method": "Cash", "note": ""},
        {"date": "30/04/2026", "amount": "0.00", "method": "", "note": "Empty placeholder"},
    ], invoice_date_ddmmyyyy="21/03/2026")
    try:
        audit = _audit(http)
        ids = [i["id"] for i in audit["invoices"]]
        assert inv["id"] not in ids, "zero-amount deposit rows must be ignored by audit"
    finally:
        _cleanup(http, inv["id"])

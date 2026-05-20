"""
Smoke test for the trade-credit rows added to the invoice PDF on
24 Feb 2026.

We create a real invoice with both `credit_redeemed` and
`trade_credit_earned` set, hit `GET /api/invoices/{id}/pdf`, extract
the raw text from the returned PDF, and assert the new rows appear.

This guards against future regression — e.g. someone refactors the
summary_data list and accidentally drops the trade-credit block.
"""
import io
import os
import uuid
from datetime import datetime, timezone

import pytest
import httpx
from pymongo import MongoClient
from pypdf import PdfReader

API_URL = (
    os.environ.get("EXTERNAL_URL")
    or open("/app/frontend/.env").read().split("REACT_APP_BACKEND_URL=")[1].split("\n")[0].strip()
)
ADMIN_EMAIL = "admin@test.com"
ADMIN_PW = "admin123"
TODAY_UK = datetime.now(timezone.utc).strftime("%d/%m/%Y")


def _db():
    """Open the same Mongo the backend uses."""
    env = open("/app/backend/.env").read()
    mongo = next(l for l in env.split("\n") if l.startswith("MONGO_URL")).split("=", 1)[1].strip().strip('"')
    dbn = next(l for l in env.split("\n") if l.startswith("DB_NAME")).split("=", 1)[1].strip().strip('"')
    return MongoClient(mongo)[dbn]


@pytest.fixture(scope="module")
def admin_token():
    with httpx.Client(base_url=API_URL, timeout=30) as c:
        r = c.post("/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PW})
        r.raise_for_status()
        yield r.json().get("access_token") or r.json().get("token")


@pytest.fixture
def http(admin_token):
    with httpx.Client(
        base_url=API_URL, timeout=60,
        headers={"Authorization": f"Bearer {admin_token}"},
    ) as c:
        yield c


def _extract_pdf_text(pdf_bytes: bytes) -> str:
    reader = PdfReader(io.BytesIO(pdf_bytes))
    return "\n".join((p.extract_text() or "") for p in reader.pages)


def _seed_invoice(**overrides):
    """Write a minimal invoice doc to Mongo directly so we can exercise
    PDF rendering with arbitrary trade-credit fields set."""
    db = _db()
    inv_id = str(uuid.uuid4())
    doc = {
        "id": inv_id,
        "invoice_no": f"PDF-CRED-{uuid.uuid4().hex[:8]}",
        "date": TODAY_UK,
        "customer_name": "PDF Credit Test Customer",
        "line_items": [{
            "product_name": "Test Tile", "sku": "T",
            "quantity": 1, "price": 100.0, "total": 100.0,
        }],
        "subtotal": 100.0,
        "vat": 20.0,
        "gross_total": 120.0,
        "deposits": [{"date": TODAY_UK, "amount": 120.0, "method": "Card"}],
        "total_deposits": 120.0,
        "amount_outstanding": 0.0,
        "status": "open_order",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    # Pop our optional balance-seeding sidecar so it doesn't end up
    # on the invoice doc itself.
    balance_after = overrides.pop("__seed_balance_after__", None)
    doc.update(overrides)
    db.invoices.insert_one(doc)
    # Optionally seed a credit_transactions row so PDF generation can
    # look up the post-invoice balance.
    if balance_after is not None:
        db.credit_transactions.insert_one({
            "id": str(uuid.uuid4()),
            "invoice_id": inv_id,
            "type": "earned_in_store",
            "amount": float(doc.get("trade_credit_earned") or 0),
            "balance_after": float(balance_after),
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
    return inv_id


def _cleanup(inv_id):
    db = _db()
    db.invoices.delete_one({"id": inv_id})
    db.credit_transactions.delete_many({"invoice_id": inv_id})


def test_pdf_includes_trade_credit_earned_row(http):
    inv_id = _seed_invoice(
        trade_account_number="T-TEST-EARN",
        trade_credit_earned=4.50,
    )
    try:
        r = http.get(f"/api/invoices/{inv_id}/pdf")
        assert r.status_code == 200, r.text
        text = _extract_pdf_text(r.content)
        assert "Trade Credit Earned" in text, \
            "PDF must show 'Trade Credit Earned' row when invoice issued credit"
        assert "4.50" in text, "Earned amount must be rendered in PDF"
        assert "T-TEST-EARN" in text, "Trade account number must appear when credit was earned"
    finally:
        _cleanup(inv_id)


def test_pdf_includes_trade_credit_used_row(http):
    inv_id = _seed_invoice(
        credit_redeemed=10.0,
        credit_redeemed_account="T-TEST-USE",
    )
    try:
        r = http.get(f"/api/invoices/{inv_id}/pdf")
        assert r.status_code == 200, r.text
        text = _extract_pdf_text(r.content)
        assert "Trade Credit Used" in text, \
            "PDF must show 'Trade Credit Used' row when invoice used credit"
        assert "10.00" in text, "Redeemed amount must be rendered"
        assert "T-TEST-USE" in text, "Trade account number must appear when credit was used"
    finally:
        _cleanup(inv_id)


def test_pdf_omits_trade_credit_rows_for_retail_invoice(http):
    """No trade credit → no clutter. The PDF must NOT render the rows."""
    inv_id = _seed_invoice()  # no credit fields
    try:
        r = http.get(f"/api/invoices/{inv_id}/pdf")
        assert r.status_code == 200, r.text
        text = _extract_pdf_text(r.content)
        assert "Trade Credit Earned" not in text
        assert "Trade Credit Used" not in text
        # But the regular totals still appear
        assert "TOTAL" in text or "Subtotal" in text
    finally:
        _cleanup(inv_id)


def test_pdf_shows_both_rows_when_invoice_earns_and_uses_credit(http):
    """Edge case: a trader pays partly with stored credit AND earns
    new credit on the residual purchase. Both rows must appear."""
    inv_id = _seed_invoice(
        credit_redeemed=15.0,
        credit_redeemed_account="T-TEST-BOTH",
        trade_credit_earned=2.25,
        trade_account_number="T-TEST-BOTH",
    )
    try:
        r = http.get(f"/api/invoices/{inv_id}/pdf")
        assert r.status_code == 200, r.text
        text = _extract_pdf_text(r.content)
        assert "Trade Credit Used" in text
        assert "Trade Credit Earned" in text
        assert "15.00" in text
        assert "2.25" in text
        assert "T-TEST-BOTH" in text
    finally:
        _cleanup(inv_id)


def test_pdf_shows_balance_after_invoice_when_credit_txn_logged(http):
    """When a credit_transactions row exists for the invoice, the PDF
    should render a 'Balance After Invoice' line using its `balance_after`
    field. This is the post-settlement snapshot from the trader's POV."""
    inv_id = _seed_invoice(
        trade_account_number="T-TEST-BAL",
        trade_credit_earned=4.50,
        __seed_balance_after__=127.50,  # what's left on the trader's account
    )
    try:
        r = http.get(f"/api/invoices/{inv_id}/pdf")
        assert r.status_code == 200, r.text
        text = _extract_pdf_text(r.content)
        assert "Balance After Invoice" in text, \
            "PDF must show 'Balance After Invoice' when credit_transactions has balance_after"
        assert "127.50" in text


    finally:
        _cleanup(inv_id)


def test_pdf_omits_balance_row_when_no_credit_txn(http):
    """If the invoice had no credit activity, the balance row must NOT
    render (we don't surface stale balances for retail invoices)."""
    inv_id = _seed_invoice()  # no credit fields, no seeded txn
    try:
        r = http.get(f"/api/invoices/{inv_id}/pdf")
        assert r.status_code == 200, r.text
        text = _extract_pdf_text(r.content)
        assert "Balance After Invoice" not in text
    finally:
        _cleanup(inv_id)

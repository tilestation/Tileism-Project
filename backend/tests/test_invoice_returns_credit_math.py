"""
Regression tests for the partially-refunded-invoice credit math bug
reported 24 Feb 2026: credit earned was being calculated on the
pre-refund total instead of the final amount paid.

Two paths covered:
  1) Refund Note path — `reverse_credits_for_refund()` must subtract the
     proportional credit from the invoice's `trade_credit_earned` field
     so the PDF prints the NET, not the original gross. Original is
     preserved on `trade_credit_earned_original`.
  2) Inline-edit path — `PUT /api/invoices/{id}` with line items where
     one or more are flagged `isReturn: true` must recompute credit and
     reverse the delta from the trader's `credit_balance` (logging a
     `reversed_earned_via_invoice_edit` row).
"""
import io
import os
import sys
import uuid
import asyncio
from datetime import datetime, timezone

import pytest
import httpx
from pymongo import MongoClient
from motor.motor_asyncio import AsyncIOMotorClient

# Make backend importable
sys.path.insert(0, "/app/backend")
from routes.refunds import reverse_credits_for_refund  # noqa: E402

API_URL = (
    os.environ.get("EXTERNAL_URL")
    or open("/app/frontend/.env").read().split("REACT_APP_BACKEND_URL=")[1].split("\n")[0].strip()
)
ADMIN_EMAIL = "admin@test.com"
ADMIN_PW = "admin123"
TODAY_UK = datetime.now(timezone.utc).strftime("%d/%m/%Y")


def _read_env(key):
    env = open("/app/backend/.env").read()
    return next(ln for ln in env.split("\n") if ln.startswith(key)).split("=", 1)[1].strip().strip('"')


def _db_sync():
    return MongoClient(_read_env("MONGO_URL"))[_read_env("DB_NAME")]


def _db_async():
    return AsyncIOMotorClient(_read_env("MONGO_URL"))[_read_env("DB_NAME")]


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


# ============ Path 1: reverse_credits_for_refund retroactively updates trade_credit_earned ===


def _seed_credit_earning_invoice(
    trade_credit_earned: float = 10.0,
    credit_redeemed: float = 0.0,
    trade_ref: str = "T-RET-TEST",
    gross_total: float = 200.0,
) -> str:
    """Insert an invoice doc straight into Mongo simulating one that
    already accrued in-store credit. Returns the invoice id."""
    db = _db_sync()
    inv_id = str(uuid.uuid4())
    db.invoices.insert_one({
        "id": inv_id,
        "invoice_no": f"RET-{uuid.uuid4().hex[:8]}",
        "date": TODAY_UK,
        "customer_name": "Returns Credit Test",
        "line_items": [{
            "product_name": "Test Tile", "sku": "T", "product_id": None,
            "quantity": 1, "price": gross_total / 1.2, "due_price": gross_total / 1.2,
            "total": gross_total / 1.2,
        }],
        "subtotal": gross_total / 1.2,
        "vat": gross_total - gross_total / 1.2,
        "gross_total": gross_total,
        "trade_credit_earned": trade_credit_earned,
        "trade_account_number": trade_ref,
        "credit_redeemed": credit_redeemed,
        "credit_redeemed_account": trade_ref if credit_redeemed > 0 else None,
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    # Seed the customer too so balance updates land somewhere
    db.shop_customers.update_one(
        {"trade_account_number": trade_ref},
        {"$setOnInsert": {
            "id": str(uuid.uuid4()),
            "trade_account_number": trade_ref,
            "email": "trader-returns@test.local",
            "is_trade": True,
            "credit_balance": 100.0,
            "credit_rate": 5.0,
        }},
        upsert=True,
    )
    return inv_id


def _cleanup_invoice(inv_id: str, trade_ref: str = "T-RET-TEST"):
    db = _db_sync()
    db.invoices.delete_one({"id": inv_id})
    db.refunds.delete_many({"original_invoice_id": inv_id})
    db.credit_transactions.delete_many({"invoice_id": inv_id})
    db.shop_customers.delete_one({"trade_account_number": trade_ref})


def _build_refund_doc(invoice_id: str, net_refund: float, trade_ref: str | None = None):
    """Minimal refund dict sufficient for reverse_credits_for_refund."""
    return {
        "id": str(uuid.uuid4()),
        "refund_no": f"R-{uuid.uuid4().hex[:8]}",
        "original_invoice_id": invoice_id,
        "net_refund": net_refund,
        "gross_total": net_refund,
        "showroom_id": None,
        "showroom_name": None,
    }


def test_partial_refund_reduces_trade_credit_earned_on_invoice():
    """A 50% refund must reduce `trade_credit_earned` by 50% on the invoice
    doc itself, while preserving the original on `trade_credit_earned_original`."""
    trade_ref = f"T-RET-{uuid.uuid4().hex[:6]}"
    inv_id = _seed_credit_earning_invoice(trade_credit_earned=10.0, trade_ref=trade_ref, gross_total=200.0)
    try:
        async def _run():
            db = _db_async()
            refund_doc = _build_refund_doc(inv_id, net_refund=100.0)  # 50% of £200
            summary = await reverse_credits_for_refund(db, refund_doc)
            assert abs(summary["earned_reversed"] - 5.0) < 0.01, summary

        asyncio.run(_run())

        db = _db_sync()
        inv = db.invoices.find_one({"id": inv_id}, {"_id": 0})
        assert inv is not None
        assert abs(float(inv.get("trade_credit_earned_original") or 0) - 10.0) < 0.01, \
            f"trade_credit_earned_original must equal the gross 10.0, got {inv.get('trade_credit_earned_original')}"
        assert abs(float(inv.get("trade_credit_earned") or 0) - 5.0) < 0.01, \
            f"trade_credit_earned must be £5.00 (NET) after 50% refund, got {inv.get('trade_credit_earned')}"
        assert abs(float(inv.get("credit_earned_already_reversed") or 0) - 5.0) < 0.01
    finally:
        _cleanup_invoice(inv_id, trade_ref)


def test_full_refund_zeros_trade_credit_earned():
    """A 100% refund must reduce `trade_credit_earned` to £0.00 on the invoice."""
    trade_ref = f"T-RET-{uuid.uuid4().hex[:6]}"
    inv_id = _seed_credit_earning_invoice(trade_credit_earned=8.0, trade_ref=trade_ref, gross_total=160.0)
    try:
        async def _run():
            db = _db_async()
            refund_doc = _build_refund_doc(inv_id, net_refund=160.0)  # 100%
            await reverse_credits_for_refund(db, refund_doc)

        asyncio.run(_run())

        db = _db_sync()
        inv = db.invoices.find_one({"id": inv_id}, {"_id": 0})
        assert abs(float(inv.get("trade_credit_earned") or 0) - 0.0) < 0.01, \
            f"trade_credit_earned must be £0.00 after full refund, got {inv.get('trade_credit_earned')}"
        assert abs(float(inv.get("trade_credit_earned_original") or 0) - 8.0) < 0.01
        assert abs(float(inv.get("credit_earned_already_reversed") or 0) - 8.0) < 0.01
    finally:
        _cleanup_invoice(inv_id, trade_ref)


def test_two_partial_refunds_dont_over_reverse_credit():
    """Two 50% refunds must reverse the FULL credit, not 100% of original each."""
    trade_ref = f"T-RET-{uuid.uuid4().hex[:6]}"
    inv_id = _seed_credit_earning_invoice(trade_credit_earned=12.0, trade_ref=trade_ref, gross_total=240.0)
    try:
        async def _run():
            db = _db_async()
            for _ in range(2):
                refund_doc = _build_refund_doc(inv_id, net_refund=120.0)
                await reverse_credits_for_refund(db, refund_doc)

        asyncio.run(_run())

        db = _db_sync()
        inv = db.invoices.find_one({"id": inv_id}, {"_id": 0})
        assert abs(float(inv.get("trade_credit_earned") or 0) - 0.0) < 0.01, \
            f"trade_credit_earned must hit £0.00 after 2x 50% refunds, got {inv.get('trade_credit_earned')}"
        assert abs(float(inv.get("credit_earned_already_reversed") or 0) - 12.0) < 0.01, \
            f"already_reversed must equal original gross (12), got {inv.get('credit_earned_already_reversed')}"
    finally:
        _cleanup_invoice(inv_id, trade_ref)


def test_refund_with_credit_redeemed_reverses_both_lanes():
    """A refund on an invoice that BOTH earned credit AND redeemed credit
    must reverse both proportionally."""
    trade_ref = f"T-RET-{uuid.uuid4().hex[:6]}"
    inv_id = _seed_credit_earning_invoice(
        trade_credit_earned=10.0,
        credit_redeemed=20.0,
        trade_ref=trade_ref,
        gross_total=200.0,
    )
    try:
        async def _run():
            db = _db_async()
            refund_doc = _build_refund_doc(inv_id, net_refund=100.0)  # 50%
            await reverse_credits_for_refund(db, refund_doc)

        asyncio.run(_run())

        db = _db_sync()
        inv = db.invoices.find_one({"id": inv_id}, {"_id": 0})
        # Earned: 10 → 5 (50% reversed)
        assert abs(float(inv.get("trade_credit_earned") or 0) - 5.0) < 0.01
        # Redeemed: 20 → 10 (50% returned to balance)
        assert abs(float(inv.get("credit_redeemed") or 0) - 10.0) < 0.01
        # Originals preserved
        assert abs(float(inv.get("trade_credit_earned_original") or 0) - 10.0) < 0.01
        assert abs(float(inv.get("credit_redeemed_original") or 0) - 20.0) < 0.01
    finally:
        _cleanup_invoice(inv_id, trade_ref)


# ============ Path 2: Inline-edit isReturn recomputes credit ============


def _seed_invoice_with_credit_for_edit(trade_ref: str, earned: float = 10.0) -> str:
    """Force-create an invoice that has accrued credit on a known trade ref.
    Bypasses the EPOS save flow so we have full control over the starting state."""
    db = _db_sync()
    inv_id = str(uuid.uuid4())
    db.invoices.insert_one({
        "id": inv_id,
        "invoice_no": f"EDIT-{uuid.uuid4().hex[:8]}",
        "date": TODAY_UK,
        "customer_name": "Edit Credit Test",
        "line_items": [
            {"product_name": "Tile A", "sku": "A", "quantity": 1, "price": 100.0, "due_price": 100.0, "total": 100.0},
            {"product_name": "Tile B", "sku": "B", "quantity": 1, "price": 100.0, "due_price": 100.0, "total": 100.0},
        ],
        "subtotal": 200.0,
        "vat": 40.0,
        "gross_total": 240.0,
        "deposits": [{"date": TODAY_UK, "amount": 240.0, "method": "Card"}],
        "total_deposits": 240.0,
        "amount_outstanding": 0.0,
        "status": "open_order",
        "trade_credit_earned": earned,
        "trade_account_number": trade_ref,
        "trade_credit_rate": 5.0,
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    db.shop_customers.update_one(
        {"trade_account_number": trade_ref},
        {"$set": {
            "id": str(uuid.uuid4()),
            "trade_account_number": trade_ref,
            "email": f"edit-{uuid.uuid4().hex[:6]}@test.local",
            "is_trade": True,
            "credit_balance": 50.0,
            "credit_rate": 5.0,
            "business_name": "Test Trader",
        }},
        upsert=True,
    )
    return inv_id


def test_marking_line_as_isreturn_on_edit_reverses_credit_delta(http):
    """PUT the invoice with one line flagged isReturn=true. Recompute
    should reduce trade_credit_earned proportionally (the kept line is
    £100 ex-VAT × 5% = £5)."""
    trade_ref = f"T-EDIT-{uuid.uuid4().hex[:6]}"
    db = _db_sync()
    inv_id = _seed_invoice_with_credit_for_edit(trade_ref, earned=10.0)
    try:
        r = http.put(f"/api/invoices/{inv_id}", json={
            "line_items": [
                {"product_name": "Tile A", "sku": "A", "quantity": 1, "price": 100.0, "due_price": 100.0, "total": 100.0, "isReturn": False},
                {"product_name": "Tile B", "sku": "B", "quantity": 1, "price": 100.0, "due_price": 100.0, "total": 100.0, "isReturn": True},
            ],
            "subtotal": 100.0,
            "vat": 20.0,
            "gross_total": 120.0,
            "deposits": [{"date": TODAY_UK, "amount": 120.0, "method": "Card"}],
        })
        assert r.status_code == 200, r.text

        inv_after = db.invoices.find_one({"id": inv_id}, {"_id": 0})
        new_earned = float(inv_after.get("trade_credit_earned") or 0)
        # Recompute: only Tile A (£100 net) × 5% (default trade rate) = £5
        # Original was £10 → reversal of £5
        assert new_earned < 10.0, (
            f"Edit with isReturn should reduce credit from £10, got {new_earned}"
        )
        assert new_earned <= 5.01, (
            f"Recomputed credit should be ~£5 (1 line × 5%), got {new_earned}"
        )

        # A reversal txn must have landed
        rev = db.credit_transactions.find_one({
            "invoice_id": inv_id,
            "type": "reversed_earned_via_invoice_edit",
        })
        assert rev is not None, "Expected reversed_earned_via_invoice_edit credit_transactions row"
        # Original must be preserved
        assert abs(float(inv_after.get("trade_credit_earned_original") or 0) - 10.0) < 0.01
    finally:
        db.invoices.delete_many({"id": inv_id})
        db.credit_transactions.delete_many({"invoice_id": inv_id})
        db.shop_customers.delete_many({"trade_account_number": trade_ref})


def test_edit_without_line_items_change_is_credit_noop(http):
    """Editing just the notes (no line_items change) must NOT log a
    reversal — only line-items edits trigger the credit reconcile."""
    trade_ref = f"T-EDIT-{uuid.uuid4().hex[:6]}"
    db = _db_sync()
    inv_id = _seed_invoice_with_credit_for_edit(trade_ref, earned=8.0)
    try:
        r = http.put(f"/api/invoices/{inv_id}", json={"notes": "Updated notes only"})
        assert r.status_code == 200, r.text

        rev = db.credit_transactions.find_one({
            "invoice_id": inv_id,
            "type": "reversed_earned_via_invoice_edit",
        })
        assert rev is None, "Notes-only edit must NOT log a reversal"

        inv_after = db.invoices.find_one({"id": inv_id}, {"_id": 0})
        assert abs(float(inv_after.get("trade_credit_earned") or 0) - 8.0) < 0.01, \
            f"Notes-only edit must keep trade_credit_earned unchanged, got {inv_after.get('trade_credit_earned')}"
    finally:
        db.invoices.delete_many({"id": inv_id})
        db.credit_transactions.delete_many({"invoice_id": inv_id})
        db.shop_customers.delete_many({"trade_account_number": trade_ref})


# ============ PDF Marking: returned lines render with (RETURNED) prefix ===


def test_pdf_line_items_show_returned_marker(http):
    """When an invoice has `isReturn: true` lines, the PDF must include
    the '(RETURNED)' marker so the trader/staff can see what was returned."""
    db = _db_sync()
    inv_id = str(uuid.uuid4())
    db.invoices.insert_one({
        "id": inv_id,
        "invoice_no": f"PDF-RET-{uuid.uuid4().hex[:6]}",
        "date": TODAY_UK,
        "customer_name": "PDF Return Test",
        "line_items": [
            {"product_name": "Kept Tile", "sku": "K", "quantity": 1, "price": 50.0, "due_price": 50.0, "total": 50.0},
            {"product_name": "Returned Tile", "sku": "R", "quantity": 1, "price": 50.0, "due_price": 50.0, "total": 50.0, "isReturn": True},
        ],
        "subtotal": 0.0,
        "vat": 0.0,
        "gross_total": 0.0,
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    try:
        from pypdf import PdfReader
        r = http.get(f"/api/invoices/{inv_id}/pdf")
        assert r.status_code == 200, r.text
        text = "\n".join((p.extract_text() or "") for p in PdfReader(io.BytesIO(r.content)).pages)
        assert "(RETURNED)" in text, (
            f"PDF must show (RETURNED) marker on isReturn lines, full text:\n{text[:600]}"
        )
        assert "Returned Tile" in text, "Returned product name must still appear"
        assert "Kept Tile" in text, "Non-returned product must still appear"
    finally:
        db.invoices.delete_one({"id": inv_id})

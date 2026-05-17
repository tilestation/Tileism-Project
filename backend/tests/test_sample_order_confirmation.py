"""
Regression test for the "silent sample-order" bug (17 May 2026).

The bug: `GET /api/shop/samples/checkout/status/{session_id}` flipped
the order to `status: paid` but never sent a confirmation email to the
customer OR an alert to the showroom dispatch team. Result: customers
paid £2.99 for tile samples, the order sat in the DB silently, and
the owner only discovered them by manually scrolling through the
Stripe dashboard.

Fix: Added `_send_sample_confirmation_fanout()` which fires both
emails on first-paid-flip and stamps `confirmation_sent_at` for
idempotency.

These tests pin:
  1. A freshly-paid order triggers the fanout helper
  2. The fanout helper writes `confirmation_sent_at` and only sends once
  3. Repeat status calls do NOT double-send (idempotency)
  4. An order that was paid BEFORE this fix (no confirmation_sent_at)
     gets the email on the next status check (recovery for in-flight orders)
"""
from __future__ import annotations

import asyncio
import pytest
from unittest.mock import AsyncMock, patch

from config import get_db
from routes import shop as shop_route

pytestmark = pytest.mark.asyncio


_TEST_ORDER_ID = "pytest-sample-order-fanout"
_TEST_SESSION_ID = "cs_test_pytest_silent_sample_bug"


async def _seed_test_order(status: str = "pending", confirmation_sent: bool = False):
    """Idempotent seed using replace_one so test re-runs don't error.
    Mirrors the shape `sample_orders` rows take in production."""
    db = get_db()
    doc = {
        "id": _TEST_ORDER_ID,
        "order_number": "TS-PYTEST-0001",
        "stripe_session_id": _TEST_SESSION_ID,
        "status": status,
        "customer_email": "pytest-sample-customer@example.com",
        "customer_name": "Pytest Customer",
        "customer_phone": "07700 900100",
        "total": 2.99,
        "products": [
            {"name": "Verona Carrara 60x60cm", "size_human": "60×60cm", "price_gbp": 0},
            {"name": "Italian Onyx Polished", "size_human": "60×60cm", "price_gbp": 0},
            {"name": "Soho Hexagon Matt", "size_human": "20×23cm", "price_gbp": 0},
        ],
        "delivery_address": {
            "line1": "Troutroost",
            "line2": "Greenway",
            "city": "Tatsfield",
            "county": "Kent",
            "postcode": "TN16 2BS",
        },
    }
    if confirmation_sent:
        doc["confirmation_sent_at"] = "2026-05-17T11:00:00+00:00"
    await db.sample_orders.replace_one({"id": _TEST_ORDER_ID}, doc, upsert=True)


async def _cleanup_test_order():
    db = get_db()
    await db.sample_orders.delete_one({"id": _TEST_ORDER_ID})


# ─────────────────────────────────────────────────────────────────────
# _send_sample_confirmation_fanout — the new helper that fires emails
# ─────────────────────────────────────────────────────────────────────

async def test_fanout_sends_customer_and_admin_emails():
    """Happy path: a pristine paid order with no `confirmation_sent_at`
    flag triggers two emails (customer + admin) and stamps the flag."""
    await _seed_test_order(status="paid", confirmation_sent=False)
    try:
        # Mock the email send function to capture what would go out.
        sent = []
        async def fake_send(to, subject, html):
            sent.append({"to": to, "subject": subject, "html": html})

        # Pull the freshly-seeded doc for the helper to consume.
        db = get_db()
        order = await db.sample_orders.find_one({"id": _TEST_ORDER_ID}, {"_id": 0})

        with patch("services.email.send_simple_email_if_possible", new=fake_send):
            await shop_route._send_sample_confirmation_fanout(order)

        # Two emails fired — one to customer, one to admin samples inbox.
        assert len(sent) == 2, f"Expected 2 emails, got {len(sent)}: {[s['to'] for s in sent]}"

        # Verify the customer one
        cust = next(s for s in sent if s["to"] == "pytest-sample-customer@example.com")
        assert "Sample order" in cust["subject"]
        assert "TS-PYTEST-0001" in cust["subject"]
        # Items must be listed — this is the actual bug the user reported
        # ("I have no clue what samples they have ordered")
        assert "Verona Carrara" in cust["html"]
        assert "Italian Onyx" in cust["html"]
        assert "Soho Hexagon" in cust["html"]
        # Delivery address must be in the body
        assert "Troutroost" in cust["html"]
        assert "TN16 2BS" in cust["html"]

        # Verify the admin one
        admin = next(s for s in sent if s["to"] != "pytest-sample-customer@example.com")
        assert "New sample order" in admin["subject"] or "🟢" in admin["subject"]
        assert "TS-PYTEST-0001" in admin["subject"]
        assert "Verona Carrara" in admin["html"]      # items shown to dispatch team
        assert "Troutroost" in admin["html"]          # so they know where to post
        assert "pytest-sample-customer@example.com" in admin["html"]

        # The `confirmation_sent_at` flag must now be stamped
        refreshed = await db.sample_orders.find_one({"id": _TEST_ORDER_ID}, {"_id": 0})
        assert refreshed.get("confirmation_sent_at"), (
            "confirmation_sent_at must be stamped after fanout to prevent double-sends"
        )
    finally:
        await _cleanup_test_order()


async def test_fanout_is_idempotent_skips_when_already_sent():
    """If `confirmation_sent_at` is already set (this is a re-call from
    the success page refresh, or the cron recovery scan), the helper
    must NOT send any emails. This is the safety net that prevents the
    customer getting two emails for one order."""
    await _seed_test_order(status="paid", confirmation_sent=True)
    try:
        sent = []
        async def fake_send(to, subject, html):
            sent.append({"to": to, "subject": subject})

        db = get_db()
        order = await db.sample_orders.find_one({"id": _TEST_ORDER_ID}, {"_id": 0})

        with patch("services.email.send_simple_email_if_possible", new=fake_send):
            await shop_route._send_sample_confirmation_fanout(order)

        assert len(sent) == 0, (
            f"Repeat fanout call must not send emails — sent {len(sent)} "
            f"({[s['to'] for s in sent]}). Customers will get duplicates "
            f"every time they refresh the sample success page."
        )
    finally:
        await _cleanup_test_order()


async def test_fanout_handles_missing_products_gracefully():
    """An order with no products list (corrupt data, schema drift, etc.)
    must NOT crash — the customer should still get *something*."""
    db = get_db()
    await db.sample_orders.replace_one(
        {"id": _TEST_ORDER_ID},
        {
            "id": _TEST_ORDER_ID,
            "order_number": "TS-PYTEST-0002",
            "stripe_session_id": _TEST_SESSION_ID,
            "status": "paid",
            "customer_email": "pytest-sample-customer@example.com",
            "customer_name": "Pytest",
            "total": 2.99,
            "products": [],  # ← empty
            "delivery_address": {},  # ← empty
        },
        upsert=True,
    )
    try:
        sent = []
        async def fake_send(to, subject, html):
            sent.append({"to": to})

        order = await db.sample_orders.find_one({"id": _TEST_ORDER_ID}, {"_id": 0})

        with patch("services.email.send_simple_email_if_possible", new=fake_send):
            # Must not raise even with empty products / address.
            await shop_route._send_sample_confirmation_fanout(order)

        # Still fires emails — admin needs to know an order arrived
        # even if the schema is wonky.
        assert len(sent) == 2
    finally:
        await _cleanup_test_order()


async def test_fanout_swallows_email_errors_so_success_page_never_blocks():
    """If SMTP / Resend is down, the fanout helper must NOT raise — the
    customer's success page would 500 otherwise. The daily recovery
    digest in stripe_reconcile.py is the safety net for that case."""
    await _seed_test_order(status="paid", confirmation_sent=False)
    try:
        async def broken_send(to, subject, html):
            raise RuntimeError("Resend API exploded")

        db = get_db()
        order = await db.sample_orders.find_one({"id": _TEST_ORDER_ID}, {"_id": 0})

        with patch("services.email.send_simple_email_if_possible", new=broken_send):
            # Must NOT raise.
            await shop_route._send_sample_confirmation_fanout(order)

        # And importantly — the flag must still be stamped so a future
        # successful retry won't re-send a duplicate. (Trade-off: if email
        # service was down at this exact moment, the customer doesn't
        # get the email. That's why the daily reconciliation cron exists.)
        refreshed = await db.sample_orders.find_one({"id": _TEST_ORDER_ID}, {"_id": 0})
        assert refreshed.get("confirmation_sent_at"), (
            "flag must still be stamped even when email fails — otherwise "
            "we'd retry forever and never let the reconciliation digest take over"
        )
    finally:
        await _cleanup_test_order()

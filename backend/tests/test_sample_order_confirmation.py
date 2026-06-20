"""
Regression test for the "silent sample-order" bug (17 May 2026)
+ the 20 Jun 2026 follow-up fix for the silent-email-failure variant
(SMP-260620-FFC920 — Tracy Batchelor only got the Telegram alert,
not the customer/admin confirmation email).

The fanout now:
  - Captures the actual Resend / Telegram per-channel result.
  - Persists `confirmation_send_result` to the order doc so the admin
    drawer can show what really happened.
  - Uses `confirmation_attempted_at` (not `_sent_at`) as the idempotency
    claim — so a transient failure can still be manually retried via
    the admin Resend button instead of being permanently locked out.
  - Only stamps `confirmation_sent_at` after at least one email
    actually succeeded.

The `_send_sample_confirmation_fanout(order, force=True)` overload is
used by the admin "Resend confirmation" endpoint to bypass idempotency
and force a retry.
"""
from __future__ import annotations

import pytest
from unittest.mock import patch

from config import get_db
from routes import shop as shop_route

pytestmark = pytest.mark.asyncio


_TEST_ORDER_ID = "pytest-sample-order-fanout"
_TEST_SESSION_ID = "cs_test_pytest_silent_sample_bug"


async def _seed_test_order(
    status: str = "pending",
    *,
    confirmation_attempted: bool = False,
    confirmation_sent: bool = False,
):
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
    if confirmation_attempted:
        doc["confirmation_attempted_at"] = "2026-05-17T11:00:00+00:00"
    if confirmation_sent:
        doc["confirmation_sent_at"] = "2026-05-17T11:00:00+00:00"
    await db.sample_orders.replace_one({"id": _TEST_ORDER_ID}, doc, upsert=True)


async def _cleanup_test_order():
    db = get_db()
    await db.sample_orders.delete_one({"id": _TEST_ORDER_ID})


def _make_capture(success: bool = True, error: str | None = None):
    """Build a fake `send_simple_email_if_possible` that records every
    call and returns the dict-shape the real function uses.

    The new fanout reads `success` / `resend_id` / `error` off the
    returned dict and bubbles them up into `confirmation_send_result`
    — so the fake MUST mirror that shape, otherwise the assertions
    about persisted state lie."""
    sent = []

    async def fake_send(to, subject, html, *, from_override=None, attachments=None):
        sent.append({
            "to": to, "subject": subject, "html": html, "from": from_override,
        })
        if success:
            return {"success": True, "resend_id": f"resend-{len(sent)}"}
        return {"success": False, "error": error or "Simulated failure"}

    return fake_send, sent


# ─────────────────────────────────────────────────────────────────────
# _send_sample_confirmation_fanout — happy path
# ─────────────────────────────────────────────────────────────────────

async def test_fanout_sends_customer_and_admin_emails():
    """Happy path: a pristine paid order with no `confirmation_attempted_at`
    flag triggers two emails (customer + admin) and stamps both the
    attempted + sent flags."""
    await _seed_test_order(status="paid")
    try:
        fake_send, sent = _make_capture(success=True)
        db = get_db()
        order = await db.sample_orders.find_one({"id": _TEST_ORDER_ID}, {"_id": 0})

        with patch("services.email.send_simple_email_if_possible", new=fake_send):
            result = await shop_route._send_sample_confirmation_fanout(order)

        # Two emails fired — one to customer, one to admin samples inbox.
        assert len(sent) == 2, f"Expected 2 emails, got {len(sent)}: {[s['to'] for s in sent]}"
        assert result["customer_email"]["success"] is True
        assert result["admin_email"]["success"] is True
        assert result["skipped"] is False

        # Verify the customer one
        cust = next(s for s in sent if s["to"] == "pytest-sample-customer@example.com")
        assert "Sample order" in cust["subject"]
        assert "TS-PYTEST-0001" in cust["subject"]
        assert "Verona Carrara" in cust["html"]
        assert "Italian Onyx" in cust["html"]
        assert "Soho Hexagon" in cust["html"]
        assert "Troutroost" in cust["html"]
        assert "TN16 2BS" in cust["html"]
        # 20 Jun 2026 — the customer email must come from samples@,
        # not online@ (online@ is the proven-broken from-address used
        # before the SMP-260620 incident).
        assert "samples@tilestation.co.uk" in (cust["from"] or "")

        # Verify the admin one
        admin = next(s for s in sent if s["to"] != "pytest-sample-customer@example.com")
        assert "🟢" in admin["subject"] or "New sample order" in admin["subject"]
        assert "TS-PYTEST-0001" in admin["subject"]
        assert "Verona Carrara" in admin["html"]
        assert "Troutroost" in admin["html"]
        assert "pytest-sample-customer@example.com" in admin["html"]

        # Both idempotency flags + the forensic result must be persisted
        refreshed = await db.sample_orders.find_one({"id": _TEST_ORDER_ID}, {"_id": 0})
        assert refreshed.get("confirmation_attempted_at")
        assert refreshed.get("confirmation_sent_at")
        persisted = refreshed.get("confirmation_send_result") or {}
        assert persisted.get("customer_email", {}).get("success") is True
        assert persisted.get("admin_email", {}).get("success") is True
    finally:
        await _cleanup_test_order()


async def test_fanout_is_idempotent_skips_when_already_attempted():
    """If `confirmation_attempted_at` is already set, repeat calls
    (e.g. cron recovery, success-page refresh) must NOT send a second
    set of emails — that would spam the customer."""
    await _seed_test_order(status="paid", confirmation_attempted=True)
    try:
        fake_send, sent = _make_capture(success=True)
        db = get_db()
        order = await db.sample_orders.find_one({"id": _TEST_ORDER_ID}, {"_id": 0})

        with patch("services.email.send_simple_email_if_possible", new=fake_send):
            result = await shop_route._send_sample_confirmation_fanout(order)

        assert len(sent) == 0, (
            f"Repeat fanout call must not send emails — sent {len(sent)}"
        )
        assert result["skipped"] is True
    finally:
        await _cleanup_test_order()


# ─────────────────────────────────────────────────────────────────────
# The bug we're actually fixing — silent Resend failure on first attempt
# ─────────────────────────────────────────────────────────────────────

async def test_silent_failure_does_not_set_confirmation_sent_at():
    """SMP-260620-FFC920 incident — `send_simple_email_if_possible`
    returned `{"success": False}` instead of raising. The old code
    happily stamped `confirmation_sent_at` anyway and moved on, which
    permanently marked the order as "customer notified" and blocked
    the recovery cron from retrying.

    Now: `confirmation_sent_at` must NOT be set on full failure.
    `confirmation_attempted_at` IS set (so we don't re-fire on every
    refresh of the success page), but the admin Resend button can
    bypass that with force=True."""
    await _seed_test_order(status="paid")
    try:
        fake_send, sent = _make_capture(
            success=False, error="recipient_bounced: previously hard bounced",
        )
        db = get_db()
        order = await db.sample_orders.find_one({"id": _TEST_ORDER_ID}, {"_id": 0})

        with patch("services.email.send_simple_email_if_possible", new=fake_send):
            result = await shop_route._send_sample_confirmation_fanout(order)

        assert result["customer_email"]["success"] is False
        assert result["admin_email"]["success"] is False
        # The actual Resend error must surface — the whole point of
        # the persistence layer is so admin sees WHY it failed.
        assert "bounced" in result["customer_email"]["error"]

        refreshed = await db.sample_orders.find_one({"id": _TEST_ORDER_ID}, {"_id": 0})
        # Attempted is set (idempotency anchor)
        assert refreshed.get("confirmation_attempted_at")
        # CRITICAL: sent_at must NOT be set on total failure
        assert not refreshed.get("confirmation_sent_at"), (
            "confirmation_sent_at must NOT be stamped when every email "
            "failed — otherwise the admin Resend button + recovery cron "
            "will never know the customer is still unreached."
        )
        # Forensic record persisted with the error message
        persisted = refreshed.get("confirmation_send_result") or {}
        assert "bounced" in (persisted.get("customer_email") or {}).get("error", "")
    finally:
        await _cleanup_test_order()


async def test_partial_failure_customer_ok_admin_fails_still_marks_sent():
    """If the customer received their email but the admin alert
    failed, the order is fundamentally OK from the customer's POV
    — so `confirmation_sent_at` IS set, but the admin_email error
    is still persisted so staff can see they need to chase the
    admin-side notification problem separately."""
    await _seed_test_order(status="paid")
    try:
        calls = {"n": 0}
        async def selective_send(to, subject, html, *, from_override=None, attachments=None):
            calls["n"] += 1
            # First call (customer) succeeds, second (admin) fails.
            if calls["n"] == 1:
                return {"success": True, "resend_id": "resend-cust"}
            return {"success": False, "error": "domain_not_verified: notifications@"}

        db = get_db()
        order = await db.sample_orders.find_one({"id": _TEST_ORDER_ID}, {"_id": 0})

        with patch("services.email.send_simple_email_if_possible", new=selective_send):
            result = await shop_route._send_sample_confirmation_fanout(order)

        assert result["customer_email"]["success"] is True
        assert result["admin_email"]["success"] is False

        refreshed = await db.sample_orders.find_one({"id": _TEST_ORDER_ID}, {"_id": 0})
        assert refreshed.get("confirmation_sent_at"), (
            "customer was notified — sent_at must be stamped even though "
            "admin alert failed (customer's notification is what counts)"
        )
    finally:
        await _cleanup_test_order()


# ─────────────────────────────────────────────────────────────────────
# force=True — the admin "Resend confirmation" button entry point
# ─────────────────────────────────────────────────────────────────────

async def test_force_bypasses_idempotency_for_admin_resend():
    """The admin Resend button calls `_send_sample_confirmation_fanout(
    order, force=True)`. That must skip the `confirmation_attempted_at`
    check and actually fire the emails, even on a previously-attempted
    order."""
    await _seed_test_order(status="paid", confirmation_attempted=True)
    try:
        fake_send, sent = _make_capture(success=True)
        db = get_db()
        order = await db.sample_orders.find_one({"id": _TEST_ORDER_ID}, {"_id": 0})

        with patch("services.email.send_simple_email_if_possible", new=fake_send):
            result = await shop_route._send_sample_confirmation_fanout(
                order, force=True,
            )

        # Both emails must have fired
        assert len(sent) == 2
        assert result["customer_email"]["success"] is True
        assert result["admin_email"]["success"] is True
        assert result["skipped"] is False
    finally:
        await _cleanup_test_order()


async def test_admin_resend_endpoint_fires_fanout_and_writes_audit_note():
    """Integration test of the HTTP endpoint
    `POST /admin/sample-orders/{id}/resend-confirmation` — checks:
      • Auth gate enforced (manager/admin/super_admin only)
      • Fanout runs in force mode
      • Audit `admin_notes` entry is appended
      • Response carries the per-channel result for the admin UI to render
    """
    await _seed_test_order(status="paid", confirmation_attempted=True)
    try:
        fake_send, sent = _make_capture(success=True)
        async def noop_notify(event, text, dedupe_key=None):
            return None
        admin_user = {"email": "manager@tilestation.co.uk", "role": "manager"}

        with patch("services.email.send_simple_email_if_possible", new=fake_send), \
             patch("services.telegram_notify.notify_event", new=noop_notify):
            resp = await shop_route.admin_resend_sample_confirmation(
                order_id=_TEST_ORDER_ID, current_user=admin_user,
            )

        # Emails actually fired (force=True bypassed idempotency)
        assert len(sent) == 2
        # Response shape the frontend depends on
        assert resp["message"] == "Confirmation re-sent"
        assert resp["result"]["customer_email"]["success"] is True
        assert resp["result"]["admin_email"]["success"] is True
        # Audit note appended so we can prove who clicked Resend & when
        db = get_db()
        refreshed = await db.sample_orders.find_one({"id": _TEST_ORDER_ID}, {"_id": 0})
        notes = refreshed.get("admin_notes") or []
        assert any("Resent confirmation" in (n.get("note") or "") for n in notes)
        assert any(n.get("by") == "manager@tilestation.co.uk" for n in notes)
    finally:
        await _cleanup_test_order()


async def test_admin_resend_endpoint_rejects_non_admin():
    """A staff/customer role MUST NOT be able to trigger resend —
    that would let any logged-in user spam customer inboxes."""
    from fastapi import HTTPException as _HTTPException
    await _seed_test_order(status="paid", confirmation_attempted=True)
    try:
        non_admin = {"email": "shopper@example.com", "role": "customer"}
        with pytest.raises(_HTTPException) as excinfo:
            await shop_route.admin_resend_sample_confirmation(
                order_id=_TEST_ORDER_ID, current_user=non_admin,
            )
        assert excinfo.value.status_code == 403
    finally:
        await _cleanup_test_order()


async def test_admin_resend_endpoint_rejects_unpaid_order():
    """The customer hasn't actually been charged for a `pending_payment`
    order — sending them a 'thanks for paying ✅' email would be a lie.
    The endpoint must guard against this."""
    from fastapi import HTTPException as _HTTPException
    await _seed_test_order(status="pending_payment")
    try:
        admin_user = {"email": "manager@tilestation.co.uk", "role": "manager"}
        with pytest.raises(_HTTPException) as excinfo:
            await shop_route.admin_resend_sample_confirmation(
                order_id=_TEST_ORDER_ID, current_user=admin_user,
            )
        assert excinfo.value.status_code == 400
        assert "Cannot resend" in excinfo.value.detail
    finally:
        await _cleanup_test_order()


# ─────────────────────────────────────────────────────────────────────
# Resilience — exceptions inside the email service must never propagate
# ─────────────────────────────────────────────────────────────────────

async def test_fanout_swallows_email_exceptions():
    """If Resend itself throws (not just returns a failure dict — e.g.
    network reset, library crash), the helper must catch it. The
    success page must always render."""
    await _seed_test_order(status="paid")
    try:
        async def broken_send(to, subject, html, *, from_override=None, attachments=None):
            raise RuntimeError("Resend API exploded")

        db = get_db()
        order = await db.sample_orders.find_one({"id": _TEST_ORDER_ID}, {"_id": 0})

        with patch("services.email.send_simple_email_if_possible", new=broken_send):
            result = await shop_route._send_sample_confirmation_fanout(order)

        assert result["customer_email"]["success"] is False
        assert "Resend API exploded" in (result["customer_email"]["error"] or "")
        # No partial success → no confirmation_sent_at
        refreshed = await db.sample_orders.find_one({"id": _TEST_ORDER_ID}, {"_id": 0})
        assert not refreshed.get("confirmation_sent_at")
    finally:
        await _cleanup_test_order()


async def test_fanout_handles_missing_products_gracefully():
    """An order with no products list (corrupt data, schema drift) must
    NOT crash — the customer should still get *something*."""
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
            "products": [],
            "delivery_address": {},
        },
        upsert=True,
    )
    try:
        fake_send, sent = _make_capture(success=True)
        order = await db.sample_orders.find_one({"id": _TEST_ORDER_ID}, {"_id": 0})

        with patch("services.email.send_simple_email_if_possible", new=fake_send):
            await shop_route._send_sample_confirmation_fanout(order)

        assert len(sent) == 2
    finally:
        await _cleanup_test_order()


# ─────────────────────────────────────────────────────────────────────
# Telegram alert fanout
# ─────────────────────────────────────────────────────────────────────

async def test_sample_fanout_fires_telegram_new_order_alert():
    """A paid sample order must trigger a Telegram alert via
    notify_event("new_order", ...)."""
    await _seed_test_order(status="paid")
    try:
        tg_calls = []
        async def fake_notify(event, text, dedupe_key=None):
            tg_calls.append({"event": event, "text": text, "dedupe_key": dedupe_key})

        fake_send, _ = _make_capture(success=True)
        db = get_db()
        order = await db.sample_orders.find_one({"id": _TEST_ORDER_ID}, {"_id": 0})

        with patch("services.telegram_notify.notify_event", new=fake_notify), \
             patch("services.email.send_simple_email_if_possible", new=fake_send):
            await shop_route._send_sample_confirmation_fanout(order)

        assert len(tg_calls) == 1
        call = tg_calls[0]
        assert call["event"] == "new_order"
        assert call["dedupe_key"] == f"sample:{order['order_number']}"
        text = call["text"]
        assert "TS-PYTEST-0001" in text
        assert "£2.99" in text
        assert "Pytest Customer" in text
        assert "Verona Carrara" in text
        assert "Troutroost" in text
    finally:
        await _cleanup_test_order()


async def test_force_resend_bypasses_telegram_dedupe():
    """When the admin clicks Resend, the Telegram alert should ALSO
    fire again (no dedupe_key) — they're actively asking for it.
    Without bypassing dedupe, the Telegram service would silently
    swallow the retry too."""
    await _seed_test_order(status="paid", confirmation_attempted=True)
    try:
        tg_calls = []
        async def fake_notify(event, text, dedupe_key=None):
            tg_calls.append({"event": event, "dedupe_key": dedupe_key})

        fake_send, _ = _make_capture(success=True)
        db = get_db()
        order = await db.sample_orders.find_one({"id": _TEST_ORDER_ID}, {"_id": 0})

        with patch("services.telegram_notify.notify_event", new=fake_notify), \
             patch("services.email.send_simple_email_if_possible", new=fake_send):
            await shop_route._send_sample_confirmation_fanout(order, force=True)

        assert len(tg_calls) == 1
        # dedupe_key must be None on force-resend so Telegram fires
        # again even if the original alert already used the natural key.
        assert tg_calls[0]["dedupe_key"] is None
    finally:
        await _cleanup_test_order()


# ─────────────────────────────────────────────────────────────────────
# Shop-order Telegram fanout (separate code path, same bug class)
# ─────────────────────────────────────────────────────────────────────

async def test_shop_order_fanout_fires_telegram_with_dedupe():
    tg_calls = []
    async def fake_notify(event, text, dedupe_key=None):
        tg_calls.append({"event": event, "text": text, "dedupe_key": dedupe_key})

    async def noop_email(to, subject, html, *, from_override=None, attachments=None):
        return {"success": True}

    shop_order = {
        "id": "pytest-shop-order-1",
        "order_number": "TS-2026-0042",
        "stripe_session_id": "cs_test_shop_pytest",
        "customer_name": "Test Shopper",
        "customer_email": "shopper@example.com",
        "customer_phone": "07000 000001",
        "total": 612.50,
        "delivery_method": "delivery",
        "items": [
            {"name": "Verona Carrara 60x60cm", "size": "60×60cm",
             "quantity": 32, "line_total": 580.00},
            {"name": "Tile Trim Black 2.4m", "size": "2.4m",
             "quantity": 4, "line_total": 32.50},
        ],
        "delivery_address": {
            "line1": "10 Test Lane", "city": "London",
            "postcode": "SW1A 1AA",
        },
    }

    with patch("services.telegram_notify.notify_event", new=fake_notify), \
         patch("services.email.send_simple_email_if_possible", new=noop_email):
        await shop_route._send_shop_order_alert_fanout(shop_order)

    # The shop fanout fires TWO Telegram events: `new_order` (the
    # headline alert) and `new_order_email_status` (an audit ping
    # confirming the admin email went out). We only care about the
    # headline here.
    new_order_calls = [c for c in tg_calls if c["event"] == "new_order"]
    assert len(new_order_calls) == 1
    call = new_order_calls[0]
    assert call["dedupe_key"] == "order:TS-2026-0042"
    text = call["text"]
    assert "TS-2026-0042" in text
    assert "£612.50" in text
    assert "Test Shopper" in text
    assert "Verona Carrara" in text
    assert "Tile Trim" in text
    assert "SW1A 1AA" in text


async def test_shop_order_fanout_swallows_telegram_errors():
    async def exploding_notify(event, text, dedupe_key=None):
        raise RuntimeError("Telegram API down")

    async def noop_email(to, subject, html, *, from_override=None, attachments=None):
        return {"success": True}

    shop_order = {
        "id": "pytest-shop-order-2",
        "order_number": "TS-2026-0099",
        "customer_email": "x@y.com",
        "total": 100.0,
        "items": [],
    }

    with patch("services.telegram_notify.notify_event", new=exploding_notify), \
         patch("services.email.send_simple_email_if_possible", new=noop_email):
        # MUST NOT RAISE
        await shop_route._send_shop_order_alert_fanout(shop_order)

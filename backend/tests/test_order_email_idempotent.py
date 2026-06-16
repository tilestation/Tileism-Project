"""
Tests for the idempotent order-confirmation email dispatcher
(`send_order_confirmation_emails_idempotent`).

Built to fix the 16 Jun 2026 P0 incident where Carolina Santiago paid
£834.63 but no confirmation email fired — neither to her nor to the
owner. Root cause: the polling endpoint sent the customer email but
the Stripe webhook did not, and there was no owner-notification
email anywhere. These tests pin the new behaviour so it can never
regress.
"""
import os
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture(autouse=True)
def _env_setup():
    os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
    os.environ.setdefault("DB_NAME", "test_order_emails")
    os.environ.setdefault("RESEND_API_KEY", "re_test_FAKE")
    os.environ.setdefault("ADMIN_EMAIL", "owner@x.com")
    os.environ.setdefault("ONLINE_ORDERS_INBOX", "online@x.com")


ORDER_DOC = {
    "id": "ord-1",
    "order_number": "TS-260616-30E725",
    "customer_email": "carolss.cs@gmail.com",
    "customer_name": "Carolina Santiago",
    "total": 834.63,
    "status": "confirmed",
    "items": [
        {"name": "Marble 60x60", "quantity": 3, "subtotal": 600.00},
        {"name": "Adhesive 20kg", "quantity": 1, "subtotal": 26.09},
    ],
}


def _build_db(order_doc=None, claim_returns=None):
    """Build a Motor-like mock that lets the dispatcher claim the row."""
    db = MagicMock()
    db.shop_orders = MagicMock()
    # Default: claim succeeds → returns the order doc
    db.shop_orders.find_one_and_update = AsyncMock(
        return_value=claim_returns if claim_returns is not None else (order_doc or ORDER_DOC).copy()
    )
    db.shop_orders.find_one = AsyncMock(return_value=order_doc or ORDER_DOC)
    db.shop_orders.update_one = AsyncMock()
    return db


def test_idempotent_dispatcher_sends_customer_and_owner_emails_on_first_call():
    from services.email import send_order_confirmation_emails_idempotent
    db = _build_db()
    customer_send = AsyncMock(return_value={"success": True, "email_id": "e-cust"})
    owner_send = AsyncMock(return_value={"success": True, "email_id": "e-owner"})
    with patch("config.get_db", return_value=db), \
         patch("services.email.send_shop_order_confirmation", customer_send), \
         patch("services.email._send_owner_order_notification", owner_send):
        out = asyncio.run(send_order_confirmation_emails_idempotent("ord-1"))
    assert out["already_sent"] is False
    assert out["customer"]["success"] is True
    assert out["owner"]["success"] is True
    customer_send.assert_awaited_once()
    owner_send.assert_awaited_once()


def test_idempotent_dispatcher_short_circuits_on_second_call():
    """When two webhook deliveries race in, the second one MUST NOT
    re-send. The atomic claim returns None and we exit early."""
    from services.email import send_order_confirmation_emails_idempotent
    db = MagicMock()
    db.shop_orders = MagicMock()
    # First call returns the doc (claim wins)
    # Second call returns None (already claimed). With two `find_one_and_update`
    # in the implementation (one for None/empty, one for $exists=False
    # fallback), we need both to return None.
    db.shop_orders.find_one_and_update = AsyncMock(return_value=None)
    db.shop_orders.find_one = AsyncMock(return_value={
        "id": "ord-1",
        "confirmation_email_sent_at": "2026-06-16T13:21:00+00:00",
    })
    db.shop_orders.update_one = AsyncMock()
    customer_send = AsyncMock()
    owner_send = AsyncMock()
    with patch("config.get_db", return_value=db), \
         patch("services.email.send_shop_order_confirmation", customer_send), \
         patch("services.email._send_owner_order_notification", owner_send):
        out = asyncio.run(send_order_confirmation_emails_idempotent("ord-1"))
    assert out["already_sent"] is True
    customer_send.assert_not_awaited()
    owner_send.assert_not_awaited()


def test_idempotent_dispatcher_unsets_marker_when_both_emails_fail():
    """If BOTH customer + owner sends fail, we MUST unset the
    `confirmation_email_sent_at` marker so a retry can actually try
    again. Otherwise we'd be stuck never sending."""
    from services.email import send_order_confirmation_emails_idempotent
    db = _build_db()
    customer_send = AsyncMock(return_value={"success": False, "error": "Resend 500"})
    owner_send = AsyncMock(return_value={"success": False, "error": "Resend 500"})
    with patch("config.get_db", return_value=db), \
         patch("services.email.send_shop_order_confirmation", customer_send), \
         patch("services.email._send_owner_order_notification", owner_send):
        out = asyncio.run(send_order_confirmation_emails_idempotent("ord-1"))
    assert out["customer"]["success"] is False
    assert out["owner"]["success"] is False
    # Should have called $unset on the marker — find the call
    found_unset = False
    for call in db.shop_orders.update_one.await_args_list:
        args, _ = call
        if len(args) >= 2 and "$unset" in args[1]:
            assert "confirmation_email_sent_at" in args[1]["$unset"]
            found_unset = True
            break
    assert found_unset, "Marker was not unset on dual failure"


def test_idempotent_dispatcher_keeps_marker_when_only_owner_fails():
    """Customer-success-only is enough to keep the row claimed (customer
    has been told). Owner can be resent manually."""
    from services.email import send_order_confirmation_emails_idempotent
    db = _build_db()
    customer_send = AsyncMock(return_value={"success": True, "email_id": "e-cust"})
    owner_send = AsyncMock(return_value={"success": False, "error": "Resend 500"})
    with patch("config.get_db", return_value=db), \
         patch("services.email.send_shop_order_confirmation", customer_send), \
         patch("services.email._send_owner_order_notification", owner_send):
        asyncio.run(send_order_confirmation_emails_idempotent("ord-1"))
    # NO $unset call should have happened
    for call in db.shop_orders.update_one.await_args_list:
        args, _ = call
        if len(args) >= 2 and "$unset" in args[1]:
            assert "confirmation_email_sent_at" not in args[1]["$unset"]


def test_idempotent_dispatcher_writes_audit_email_log_row():
    from services.email import send_order_confirmation_emails_idempotent
    db = _build_db()
    with patch("config.get_db", return_value=db), \
         patch("services.email.send_shop_order_confirmation",
               AsyncMock(return_value={"success": True})), \
         patch("services.email._send_owner_order_notification",
               AsyncMock(return_value={"success": True})):
        asyncio.run(send_order_confirmation_emails_idempotent("ord-1"))
    # Find the $push email_log call
    found = False
    for call in db.shop_orders.update_one.await_args_list:
        args, _ = call
        if len(args) >= 2 and "$push" in args[1] and "email_log" in args[1]["$push"]:
            row = args[1]["$push"]["email_log"]
            assert row["kind"] == "order_confirmation"
            assert row["customer_ok"] is True
            assert row["owner_ok"] is True
            assert "sent_at" in row
            found = True
            break
    assert found, "No audit row was written to email_log"


def test_idempotent_dispatcher_survives_exception_in_one_send():
    """If `send_shop_order_confirmation` raises, the owner notification
    MUST still fire — and vice versa. asyncio.gather(return_exceptions=True)
    is the contract."""
    from services.email import send_order_confirmation_emails_idempotent
    db = _build_db()

    async def boom_customer(_o): raise RuntimeError("boom")
    owner_send = AsyncMock(return_value={"success": True, "email_id": "e-owner"})
    with patch("config.get_db", return_value=db), \
         patch("services.email.send_shop_order_confirmation", boom_customer), \
         patch("services.email._send_owner_order_notification", owner_send):
        out = asyncio.run(send_order_confirmation_emails_idempotent("ord-1"))
    assert out["customer"]["success"] is False
    assert "boom" in out["customer"]["error"]
    assert out["owner"]["success"] is True
    owner_send.assert_awaited_once()


# ─── Owner notification email ────────────────────────────────────────
def test_owner_notification_sends_to_admin_and_online_inboxes():
    from services.email import _send_owner_order_notification
    with patch("services.email.resend") as rs, \
         patch("services.email.ADMIN_EMAIL", "owner@x.com"), \
         patch("services.email.ONLINE_ORDERS_INBOX", "online@x.com"):
        rs.Emails = MagicMock()
        rs.Emails.send = MagicMock(return_value={"id": "owner-123"})
        out = asyncio.run(_send_owner_order_notification(ORDER_DOC))
    assert out["success"] is True
    payload = rs.Emails.send.call_args[0][0]
    # Both online@ and ADMIN_EMAIL appear
    assert set(payload["to"]) == {"online@x.com", "owner@x.com"}
    # Subject embeds the order number + total
    assert "TS-260616-30E725" in payload["subject"]
    assert "£834.63" in payload["subject"]
    # HTML has item rows
    assert "Marble 60x60" in payload["html"]
    assert "Adhesive 20kg" in payload["html"]
    # reply_to is set to the customer's email so the owner can hit Reply
    assert payload["reply_to"] == ["carolss.cs@gmail.com"]


def test_owner_notification_skips_when_no_recipients():
    """If both ADMIN_EMAIL and ONLINE_ORDERS_INBOX are blank, we don't
    crash — we return a clean failure."""
    from services.email import _send_owner_order_notification
    with patch("services.email.ADMIN_EMAIL", ""), \
         patch("services.email.ONLINE_ORDERS_INBOX", ""):
        out = asyncio.run(_send_owner_order_notification(ORDER_DOC))
    assert out["success"] is False
    assert "No owner recipients" in out["error"]

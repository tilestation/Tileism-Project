"""
Stripe Reconciliation Unit Tests
─────────────────────────────────
Pure-function tests for the orphan-payment recovery flow built in
response to the 2 May 2026 Zoe Ward incident (customer paid £2.99 for
a sample, Stripe captured the money, but the order stayed at
status='pending' because the browser closed before the success page
poll fired).

Covers:
  • `_resolve_webhook_url` helper — picks SITE_URL > BACKEND_URL > req
  • `recover_order_by_session` — idempotent, no double-flip on paid
  • `recover_order_by_session` — flips sample_orders to paid when
    Stripe says paid
  • `recover_order_by_session` — leaves the order untouched when
    Stripe says unpaid
  • `recover_order_by_session` — returns error when order not found
  • `recover_order_by_session` — handles shop_orders too
  • `run_auto_recovery_scan` — batches across both collections

Marker: @pytest.mark.asyncio — async tests.
"""
import os
from unittest.mock import AsyncMock, MagicMock, patch
from datetime import datetime, timezone

import pytest


# ─── _resolve_webhook_url helper ─────────────────────────────────────


def test_resolve_webhook_url_uses_site_url_first(monkeypatch):
    """SITE_URL wins over BACKEND_URL when both are set."""
    monkeypatch.setenv("SITE_URL", "https://api.tilestation.co.uk")
    monkeypatch.setenv("BACKEND_URL", "https://other.example.com")
    # Re-import inside the test so the env vars take effect
    from routes.shop import _resolve_webhook_url
    assert _resolve_webhook_url(None) == "https://api.tilestation.co.uk/api/webhook/stripe"


def test_resolve_webhook_url_falls_back_to_backend_url(monkeypatch):
    """BACKEND_URL is used when SITE_URL is missing."""
    monkeypatch.delenv("SITE_URL", raising=False)
    monkeypatch.setenv("BACKEND_URL", "https://tile-station-production.up.railway.app")
    from routes.shop import _resolve_webhook_url
    assert (
        _resolve_webhook_url(None)
        == "https://tile-station-production.up.railway.app/api/webhook/stripe"
    )


def test_resolve_webhook_url_strips_trailing_slash(monkeypatch):
    monkeypatch.setenv("SITE_URL", "https://api.tilestation.co.uk/")
    monkeypatch.delenv("BACKEND_URL", raising=False)
    from routes.shop import _resolve_webhook_url
    assert _resolve_webhook_url(None) == "https://api.tilestation.co.uk/api/webhook/stripe"


def test_resolve_webhook_url_uses_request_when_env_missing(monkeypatch):
    """Last-resort fallback uses request.base_url."""
    monkeypatch.delenv("SITE_URL", raising=False)
    monkeypatch.delenv("BACKEND_URL", raising=False)
    from routes.shop import _resolve_webhook_url
    req = MagicMock()
    req.base_url = "https://preview.example.com/"
    assert _resolve_webhook_url(req) == "https://preview.example.com/api/webhook/stripe"


def test_resolve_webhook_url_raises_when_nothing_configured(monkeypatch):
    """HTTPException raised when neither env vars NOR request available."""
    from fastapi import HTTPException
    monkeypatch.delenv("SITE_URL", raising=False)
    monkeypatch.delenv("BACKEND_URL", raising=False)
    from routes.shop import _resolve_webhook_url
    with pytest.raises(HTTPException) as exc_info:
        _resolve_webhook_url(None)
    assert exc_info.value.status_code == 500
    assert "mis-configured" in exc_info.value.detail.lower()


# ─── recover_order_by_session ────────────────────────────────────────


@pytest.fixture
def fake_db():
    """A faux Mongo db with the methods we use.

    The reconcile module also indexes the db by collection name
    (`db[coll_name]`), so we wire up __getitem__ to dispatch to the
    matching collection mock.
    """
    sample_orders = MagicMock()
    sample_orders.find_one = AsyncMock(return_value=None)
    sample_orders.update_one = AsyncMock()

    shop_orders = MagicMock()
    shop_orders.find_one = AsyncMock(return_value=None)
    shop_orders.update_one = AsyncMock()

    abandoned = MagicMock()
    abandoned.update_many = AsyncMock()

    audit = MagicMock()
    audit.insert_one = AsyncMock()

    db = MagicMock()
    db.sample_orders = sample_orders
    db.shop_orders = shop_orders
    db.abandoned_sample_baskets = abandoned
    db.audit_logs = audit
    db.__getitem__ = MagicMock(side_effect=lambda key: {
        "sample_orders": sample_orders,
        "shop_orders": shop_orders,
        "abandoned_sample_baskets": abandoned,
        "audit_logs": audit,
    }[key])
    return db


def _stripe_session(*, payment_status="paid", amount=299, email="zoe@example.com"):
    """Minimal Stripe Session mock matching the attributes our code reads."""
    sess = MagicMock()
    sess.payment_status = payment_status
    sess.amount_total = amount
    sess.customer_email = email
    return sess


@pytest.mark.asyncio
async def test_recover_returns_error_when_order_not_found(fake_db, monkeypatch):
    monkeypatch.setenv("STRIPE_API_KEY", "sk_test_dummy")
    from routes import stripe_reconcile as sr_mod
    # Force STRIPE_API_KEY to be truthy
    monkeypatch.setattr(sr_mod, "STRIPE_API_KEY", "sk_test_dummy")
    res = await sr_mod.recover_order_by_session(
        fake_db, session_id="cs_test_nonexistent",
        send_email=False, fire_alerts=False,
    )
    assert res["error"] == "order_not_found"


@pytest.mark.asyncio
async def test_recover_idempotent_when_already_paid(fake_db, monkeypatch):
    """If the order is already 'paid', short-circuit without calling Stripe."""
    fake_db.sample_orders.find_one = AsyncMock(return_value={
        "id": "sample-1", "stripe_session_id": "cs_test_x", "status": "paid",
        "customer_email": "zoe@example.com", "total": 2.99,
    })
    from routes import stripe_reconcile as sr_mod
    monkeypatch.setattr(sr_mod, "STRIPE_API_KEY", "sk_test_dummy")
    res = await sr_mod.recover_order_by_session(
        fake_db, session_id="cs_test_x",
        send_email=False, fire_alerts=False,
    )
    assert res["recovered"] is False
    assert res["reason"] == "already_paid"
    assert res["before_status"] == "paid"
    assert res["after_status"] == "paid"
    fake_db.sample_orders.update_one.assert_not_called()


@pytest.mark.asyncio
async def test_recover_flips_sample_order_when_stripe_paid(fake_db, monkeypatch):
    """Happy path — Stripe returns 'paid', sample order flips."""
    fake_db.sample_orders.find_one = AsyncMock(return_value={
        "id": "sample-1", "stripe_session_id": "cs_test_x", "status": "pending",
        "customer_email": "zoe@example.com", "total": 2.99,
    })
    from routes import stripe_reconcile as sr_mod
    monkeypatch.setattr(sr_mod, "STRIPE_API_KEY", "sk_test_dummy")
    # Patch the Stripe session retrieve via the module's stripe import
    with patch.object(
        sr_mod.stripe.checkout.Session, "retrieve",
        return_value=_stripe_session(payment_status="paid", amount=299),
    ):
        res = await sr_mod.recover_order_by_session(
            fake_db, session_id="cs_test_x",
            send_email=False, fire_alerts=False,
        )
    assert res["recovered"] is True
    assert res["after_status"] == "paid"
    assert res["amount_paid"] == 2.99
    fake_db.sample_orders.update_one.assert_awaited_once()
    # Audit log written
    fake_db.audit_logs.insert_one.assert_awaited_once()


@pytest.mark.asyncio
async def test_recover_no_op_when_stripe_says_unpaid(fake_db, monkeypatch):
    """Stripe returns 'unpaid' → we don't flip the order."""
    fake_db.sample_orders.find_one = AsyncMock(return_value={
        "id": "sample-1", "stripe_session_id": "cs_test_x", "status": "pending",
        "customer_email": "zoe@example.com", "total": 2.99,
    })
    from routes import stripe_reconcile as sr_mod
    monkeypatch.setattr(sr_mod, "STRIPE_API_KEY", "sk_test_dummy")
    with patch.object(
        sr_mod.stripe.checkout.Session, "retrieve",
        return_value=_stripe_session(payment_status="unpaid"),
    ):
        res = await sr_mod.recover_order_by_session(
            fake_db, session_id="cs_test_x",
            send_email=False, fire_alerts=False,
        )
    assert res["recovered"] is False
    assert res["reason"] == "stripe_not_paid"
    fake_db.sample_orders.update_one.assert_not_called()


@pytest.mark.asyncio
async def test_recover_flips_shop_order_when_sample_not_found(fake_db, monkeypatch):
    """If sample_orders has no match, fall through to shop_orders."""
    fake_db.sample_orders.find_one = AsyncMock(return_value=None)
    fake_db.shop_orders.find_one = AsyncMock(return_value={
        "id": "shop-1", "stripe_session_id": "cs_test_shop", "status": "pending",
        "customer_email": "bob@example.com", "total": 199.99,
    })
    from routes import stripe_reconcile as sr_mod
    monkeypatch.setattr(sr_mod, "STRIPE_API_KEY", "sk_test_dummy")
    with patch.object(
        sr_mod.stripe.checkout.Session, "retrieve",
        return_value=_stripe_session(payment_status="paid", amount=19999),
    ):
        res = await sr_mod.recover_order_by_session(
            fake_db, session_id="cs_test_shop",
            send_email=False, fire_alerts=False,
        )
    assert res["recovered"] is True
    assert res["amount_paid"] == 199.99
    fake_db.shop_orders.update_one.assert_awaited_once()


@pytest.mark.asyncio
async def test_recover_returns_error_when_stripe_retrieve_fails(fake_db, monkeypatch):
    """Network / API errors from Stripe surface as a structured error."""
    fake_db.sample_orders.find_one = AsyncMock(return_value={
        "id": "sample-1", "stripe_session_id": "cs_test_x", "status": "pending",
        "customer_email": "zoe@example.com", "total": 2.99,
    })
    from routes import stripe_reconcile as sr_mod
    monkeypatch.setattr(sr_mod, "STRIPE_API_KEY", "sk_test_dummy")
    with patch.object(
        sr_mod.stripe.checkout.Session, "retrieve",
        side_effect=RuntimeError("Stripe API timeout"),
    ):
        res = await sr_mod.recover_order_by_session(
            fake_db, session_id="cs_test_x",
            send_email=False, fire_alerts=False,
        )
    assert "stripe_retrieve_failed" in res["error"]
    fake_db.sample_orders.update_one.assert_not_called()


# ─── run_auto_recovery_scan ──────────────────────────────────────────


class _AsyncIter:
    """Helper to mock Mongo's async cursor (`async for order in ...`)."""
    def __init__(self, items):
        self._items = items
    def __aiter__(self):
        async def gen():
            for item in self._items:
                yield item
        return gen()


@pytest.mark.asyncio
async def test_scan_dry_run_doesnt_call_stripe(monkeypatch):
    """Dry-run mode iterates orders but never hits Stripe / never writes."""
    pending_sample = {
        "id": "sample-1", "stripe_session_id": "cs_a",
        "status": "pending", "created_at": "2026-02-08T10:00:00+00:00",
    }
    pending_shop = {
        "id": "shop-1", "stripe_session_id": "cs_b",
        "status": "pending", "created_at": "2026-02-08T11:00:00+00:00",
    }
    sample_orders = MagicMock()
    sample_orders.find = MagicMock(return_value=_AsyncIter([pending_sample]))
    shop_orders = MagicMock()
    shop_orders.find = MagicMock(return_value=_AsyncIter([pending_shop]))

    db = MagicMock()
    db.sample_orders = sample_orders
    db.shop_orders = shop_orders
    db.__getitem__ = MagicMock(side_effect=lambda key: {
        "sample_orders": sample_orders,
        "shop_orders": shop_orders,
    }[key])

    from routes import stripe_reconcile as sr_mod
    monkeypatch.setattr(sr_mod, "get_db", lambda: db)
    monkeypatch.setattr(sr_mod, "STRIPE_API_KEY", "sk_test_dummy")

    res = await sr_mod.run_auto_recovery_scan(dry_run=True, days_back=7)
    assert res["scanned"] == 2
    assert res["recovered"] == 0
    assert all(d.get("dry_run") for d in res["details"])

"""
Tests for the orphaned-orders sweep — the safety-net cron that catches
paid orders whose confirmation emails never fired.
"""
import os
import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture(autouse=True)
def _env_setup():
    os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
    os.environ.setdefault("DB_NAME", "test_orphan_sweep")


class _Cursor:
    def __init__(self, items): self.items = list(items)
    def sort(self, *a, **k): return self
    def limit(self, *a, **k): return self
    async def to_list(self, _n=None): return list(self.items)


def _build_db(orphans):
    db = MagicMock()
    db.shop_orders = MagicMock()
    db.shop_orders.find = MagicMock(return_value=_Cursor(orphans))
    db.shop_orders.update_one = AsyncMock()
    return db


def test_sweep_returns_empty_summary_when_no_orphans():
    from services.orphaned_orders_sweep import run_orphaned_orders_sweep
    db = _build_db([])
    with patch("config.get_db", return_value=db):
        out = asyncio.run(run_orphaned_orders_sweep())
    assert out == {"scanned": 0, "recovered": 0, "failed": 0, "order_numbers": []}
    db.shop_orders.find.assert_called_once()


def test_sweep_recovers_orphans_via_idempotent_dispatcher():
    from services.orphaned_orders_sweep import run_orphaned_orders_sweep
    paid_15m_ago = (datetime.now(timezone.utc) - timedelta(minutes=15)).isoformat()
    orphans = [
        {"id": "ord-1", "order_number": "TS-1", "total": 100, "paid_at": paid_15m_ago},
        {"id": "ord-2", "order_number": "TS-2", "total": 200, "paid_at": paid_15m_ago},
    ]
    db = _build_db(orphans)
    dispatcher = AsyncMock(return_value={
        "already_sent": False,
        "customer": {"success": True}, "owner": {"success": True},
    })
    tg_mock = MagicMock()
    with patch("config.get_db", return_value=db), \
         patch("services.email.send_order_confirmation_emails_idempotent", dispatcher), \
         patch("services.telegram_notify.fire_and_forget", tg_mock):
        out = asyncio.run(run_orphaned_orders_sweep())
    assert out["scanned"] == 2
    assert out["recovered"] == 2
    assert out["failed"] == 0
    assert set(out["order_numbers"]) == {"TS-1", "TS-2"}
    # Dispatcher called once per orphan
    assert dispatcher.await_count == 2
    # Telegram fired exactly once (per pass, not per order)
    assert tg_mock.call_count == 1
    msg = tg_mock.call_args[0][1]
    assert "2" in msg
    assert "TS-1" in msg or "TS-2" in msg


def test_sweep_counts_already_sent_as_recovered():
    """If another path claims the email between query + dispatch, the
    dispatcher returns already_sent=True. That's still a successful
    recovery (the order is no longer an orphan) — count it."""
    from services.orphaned_orders_sweep import run_orphaned_orders_sweep
    paid_15m_ago = (datetime.now(timezone.utc) - timedelta(minutes=15)).isoformat()
    db = _build_db([{"id": "ord-1", "order_number": "TS-1", "paid_at": paid_15m_ago}])
    dispatcher = AsyncMock(return_value={
        "already_sent": True,
        "customer": {"success": True, "skipped": True},
        "owner": {"success": True, "skipped": True},
    })
    with patch("config.get_db", return_value=db), \
         patch("services.email.send_order_confirmation_emails_idempotent", dispatcher), \
         patch("services.telegram_notify.fire_and_forget", MagicMock()):
        out = asyncio.run(run_orphaned_orders_sweep())
    assert out["recovered"] == 1
    assert out["failed"] == 0


def test_sweep_counts_dual_failure_as_failed():
    from services.orphaned_orders_sweep import run_orphaned_orders_sweep
    paid_15m_ago = (datetime.now(timezone.utc) - timedelta(minutes=15)).isoformat()
    db = _build_db([{"id": "ord-1", "order_number": "TS-1", "paid_at": paid_15m_ago}])
    dispatcher = AsyncMock(return_value={
        "already_sent": False,
        "customer": {"success": False, "error": "Resend 500"},
        "owner": {"success": False, "error": "Resend 500"},
    })
    tg_mock = MagicMock()
    with patch("config.get_db", return_value=db), \
         patch("services.email.send_order_confirmation_emails_idempotent", dispatcher), \
         patch("services.telegram_notify.fire_and_forget", tg_mock):
        out = asyncio.run(run_orphaned_orders_sweep())
    assert out["recovered"] == 0
    assert out["failed"] == 1
    # Telegram alert fires the failure variant
    assert tg_mock.call_count == 1
    msg = tg_mock.call_args[0][1]
    assert "failed" in msg.lower() or "⚠️" in msg


def test_sweep_query_filters_grace_window_and_max_age():
    """Verify the Mongo query uses both the grace cutoff (paid_at <= now-10m)
    and the max-age cutoff (paid_at >= now-72h) to avoid resurfacing
    ancient orders."""
    from services.orphaned_orders_sweep import (
        run_orphaned_orders_sweep, ORPHAN_GRACE_MINUTES, ORPHAN_MAX_AGE_HOURS,
    )
    db = _build_db([])
    with patch("config.get_db", return_value=db):
        asyncio.run(run_orphaned_orders_sweep())
    query = db.shop_orders.find.call_args[0][0]
    assert query["payment_status"] == "paid"
    assert "paid_at" in query
    grace_str = query["paid_at"]["$lte"]
    age_str = query["paid_at"]["$gte"]
    grace_dt = datetime.fromisoformat(grace_str)
    age_dt = datetime.fromisoformat(age_str)
    delta_grace = (datetime.now(timezone.utc) - grace_dt).total_seconds() / 60
    delta_age = (datetime.now(timezone.utc) - age_dt).total_seconds() / 3600
    # Should be within ±1 minute of the configured grace window
    assert abs(delta_grace - ORPHAN_GRACE_MINUTES) < 1
    assert abs(delta_age - ORPHAN_MAX_AGE_HOURS) < 1
    # The $or clause covers the three legacy shapes of the missing marker
    or_clauses = query["$or"]
    keys = [list(c.keys())[0] for c in or_clauses]
    assert all(k == "confirmation_email_sent_at" for k in keys)


def test_sweep_silent_when_no_orphans_and_no_failures():
    """No orphans + no failures → NO Telegram message (silent success)."""
    from services.orphaned_orders_sweep import run_orphaned_orders_sweep
    db = _build_db([])
    tg_mock = MagicMock()
    with patch("config.get_db", return_value=db), \
         patch("services.telegram_notify.fire_and_forget", tg_mock):
        asyncio.run(run_orphaned_orders_sweep())
    tg_mock.assert_not_called()


def test_sweep_swallows_dispatcher_exceptions():
    """If the dispatcher raises (e.g. Mongo blip), one orphan can fail
    without taking the whole pass down."""
    from services.orphaned_orders_sweep import run_orphaned_orders_sweep
    paid_15m_ago = (datetime.now(timezone.utc) - timedelta(minutes=15)).isoformat()
    db = _build_db([
        {"id": "ord-1", "order_number": "TS-1", "paid_at": paid_15m_ago},
        {"id": "ord-2", "order_number": "TS-2", "paid_at": paid_15m_ago},
    ])
    async def dispatcher(order_id):
        if order_id == "ord-1":
            raise RuntimeError("mongo blip")
        return {"already_sent": False, "customer": {"success": True}, "owner": {"success": True}}
    with patch("config.get_db", return_value=db), \
         patch("services.email.send_order_confirmation_emails_idempotent", dispatcher), \
         patch("services.telegram_notify.fire_and_forget", MagicMock()):
        out = asyncio.run(run_orphaned_orders_sweep())
    assert out["scanned"] == 2
    assert out["recovered"] == 1
    assert out["failed"] == 1

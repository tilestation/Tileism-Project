"""Uptime monitor de-bouncer tests.

Verifies that the false-positive guard added on 31 May 2026 actually
works: a single failed check must NOT page Telegram. Only N consecutive
failures (default 2) trigger the UP→DOWN alert.

The Telegram send itself is mocked so tests don't fire real messages.
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import AsyncMock, patch

import pytest

os.environ.setdefault("DB_NAME", "test_db_uptime_debounce")

from config import get_db  # noqa: E402
from services import uptime_monitor as um  # noqa: E402


def _make_result(check_id: str, ok: bool, *, error: str = "status 502") -> dict:
    return {
        "id": check_id,
        "label": "Homepage",
        "url": "https://example.test/",
        "ok": ok,
        "status_code": 200 if ok else 502,
        "latency_ms": 250,
        "slow": False,
        "error": None if ok else error,
        "checked_at": "2026-05-31T10:00:00+00:00",
    }


@pytest.fixture
def mock_telegram():
    """Stub `send_telegram` inside the uptime monitor module so
    nothing actually leaves the box."""
    with patch.object(um, "send_telegram", new=AsyncMock(return_value={"sent": True})) as m:
        yield m


@pytest.fixture
def isolated_check_id():
    """Per-test check_id so concurrent test runs don't trash each
    other's state."""
    cid = f"test-check-{uuid.uuid4().hex[:8]}"
    yield cid
    # cleanup
    import asyncio
    async def _wipe():
        db = get_db()
        await db.uptime_check_state.delete_many({"_id": cid})
    try:
        asyncio.get_event_loop().run_until_complete(_wipe())
    except Exception:
        pass


@pytest.mark.asyncio
async def test_single_failure_does_not_alert(mock_telegram, isolated_check_id):
    """The whole point: one failed check during a Railway reboot
    must not page Telegram."""
    db = get_db()
    # Seed prior healthy state (the legacy "first-run failure" path
    # has its own behaviour — this test covers the steady-state case).
    await db.uptime_check_state.update_one(
        {"_id": isolated_check_id},
        {"$set": {
            "_id": isolated_check_id,
            "ok": True,
            "consecutive_failures": 0,
            "label": "Homepage",
        }},
        upsert=True,
    )
    res = _make_result(isolated_check_id, ok=False)
    alert = await um._alert_on_transition(db, res)
    assert alert is None, "Single failure must NOT alert"
    assert mock_telegram.await_count == 0
    # State stays "ok" so a recovery on the next tick is silent
    state = await db.uptime_check_state.find_one({"_id": isolated_check_id}, {"_id": 0})
    assert state["ok"] is True, "Within grace, state.ok should remain True"
    assert state["consecutive_failures"] == 1
    assert state["last_observation_ok"] is False


@pytest.mark.asyncio
async def test_two_consecutive_failures_alert_once(mock_telegram, isolated_check_id):
    """Two consecutive failures → one Telegram (default
    FAILURES_BEFORE_ALERT=2)."""
    db = get_db()
    await db.uptime_check_state.update_one(
        {"_id": isolated_check_id},
        {"$set": {
            "_id": isolated_check_id,
            "ok": True,
            "consecutive_failures": 0,
            "label": "Homepage",
        }},
        upsert=True,
    )
    # First failure — silent
    await um._alert_on_transition(db, _make_result(isolated_check_id, ok=False))
    assert mock_telegram.await_count == 0
    # Second failure — fires
    await um._alert_on_transition(db, _make_result(isolated_check_id, ok=False))
    assert mock_telegram.await_count == 1, "Second consecutive failure must alert"
    state = await db.uptime_check_state.find_one({"_id": isolated_check_id}, {"_id": 0})
    assert state["ok"] is False
    assert state["consecutive_failures"] == 2
    assert state.get("failed_since") is not None
    # Third failure — no re-alert (already in down state)
    await um._alert_on_transition(db, _make_result(isolated_check_id, ok=False))
    assert mock_telegram.await_count == 1


@pytest.mark.asyncio
async def test_recovery_after_confirmed_down_alerts_once(mock_telegram, isolated_check_id):
    """Recovery still fires on the FIRST success after confirmed
    down — false 'back up' is harmless, missing real recovery isn't."""
    db = get_db()
    # Seed confirmed-down state
    await db.uptime_check_state.update_one(
        {"_id": isolated_check_id},
        {"$set": {
            "_id": isolated_check_id,
            "ok": False,
            "consecutive_failures": 3,
            "failed_since": "2026-05-31T09:55:00+00:00",
            "label": "Homepage",
        }},
        upsert=True,
    )
    await um._alert_on_transition(db, _make_result(isolated_check_id, ok=True))
    assert mock_telegram.await_count == 1
    args = mock_telegram.await_args[0]
    assert "RECOVERED" in args[0], "Recovery message expected"
    state = await db.uptime_check_state.find_one({"_id": isolated_check_id}, {"_id": 0})
    assert state["ok"] is True
    assert state["consecutive_failures"] == 0


@pytest.mark.asyncio
async def test_recovery_inside_grace_window_is_silent(mock_telegram, isolated_check_id):
    """Failure → success in two ticks → ZERO Telegrams. This is the
    Railway-reboot scenario the user complained about."""
    db = get_db()
    await db.uptime_check_state.update_one(
        {"_id": isolated_check_id},
        {"$set": {
            "_id": isolated_check_id,
            "ok": True,
            "consecutive_failures": 0,
            "label": "Homepage",
        }},
        upsert=True,
    )
    # tick 1: failure (silent — within grace)
    await um._alert_on_transition(db, _make_result(isolated_check_id, ok=False))
    # tick 2: success (silent — state.ok was preserved as True so no recovery either)
    await um._alert_on_transition(db, _make_result(isolated_check_id, ok=True))
    assert mock_telegram.await_count == 0, "Transient blip must not alert"
    state = await db.uptime_check_state.find_one({"_id": isolated_check_id}, {"_id": 0})
    assert state["ok"] is True
    assert state["consecutive_failures"] == 0


@pytest.mark.asyncio
async def test_first_run_failure_is_silent(mock_telegram, isolated_check_id):
    """No prior state + failing check → silent, NOT 'first-run DOWN'.
    Cold-start race conditions shouldn't page on boot."""
    db = get_db()
    # No prior state
    await db.uptime_check_state.delete_many({"_id": isolated_check_id})
    await um._alert_on_transition(db, _make_result(isolated_check_id, ok=False))
    assert mock_telegram.await_count == 0
    state = await db.uptime_check_state.find_one({"_id": isolated_check_id}, {"_id": 0})
    # State persists as down with 1 strike — next tick will alert if still down
    assert state["ok"] is False
    assert state["consecutive_failures"] == 1


@pytest.mark.asyncio
async def test_threshold_env_override(mock_telegram, isolated_check_id, monkeypatch):
    """MONITOR_FAILURES_BEFORE_ALERT=3 → need three consecutive
    failures before alerting. (Module-level constant means we need
    to reload the module; instead we patch the constant in place.)"""
    db = get_db()
    await db.uptime_check_state.update_one(
        {"_id": isolated_check_id},
        {"$set": {
            "_id": isolated_check_id,
            "ok": True,
            "consecutive_failures": 0,
            "label": "Homepage",
        }},
        upsert=True,
    )
    monkeypatch.setattr(um, "FAILURES_BEFORE_ALERT", 3)
    for _ in range(2):
        await um._alert_on_transition(db, _make_result(isolated_check_id, ok=False))
    assert mock_telegram.await_count == 0, "Threshold=3 should suppress 2 failures"
    await um._alert_on_transition(db, _make_result(isolated_check_id, ok=False))
    assert mock_telegram.await_count == 1, "Third failure fires at threshold=3"

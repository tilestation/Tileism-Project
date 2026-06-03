"""Radio off-air alerter — state-machine tests.

Verifies the off-air → on-air state machine + idempotency. The
Telegram send itself is mocked so we don't hit the wire.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest

os.environ.setdefault("DB_NAME", "test_db_radio_offair")

from config import get_db  # noqa: E402
from services import radio_offair_alerts as roa  # noqa: E402


def _iso(seconds_ago: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=seconds_ago)).isoformat()


@pytest.fixture
def force_opening_hours():
    """Pretend it's always inside opening hours for the duration of
    the test. _is_within_opening_hours otherwise short-circuits the
    whole tick when run at e.g. 03:00 UTC."""
    with patch.object(roa, "_is_within_opening_hours", return_value=True):
        yield


@pytest.fixture
def mock_telegram():
    """Stub out the actual Telegram HTTP call so tests don't fire
    real messages. Returns the AsyncMock so assertions can inspect
    how many times / with what args it was called."""
    with patch.object(
        roa, "notify_event", new=AsyncMock(return_value={"sent": True})
    ) as m:
        yield m


@pytest.mark.asyncio
async def test_skips_outside_opening_hours():
    """Outside 09:00-18:00 local time the tick is a no-op."""
    with patch.object(roa, "_is_within_opening_hours", return_value=False):
        res = await roa.run_radio_offair_tick()
    assert res.get("skipped") == "outside_opening_hours"


@pytest.mark.asyncio
async def test_fires_alert_when_labelled_device_drops_off_air(force_opening_hours, mock_telegram):
    """Labelled device that hasn't pinged in 10 min → one Telegram fired."""
    db = get_db()
    dev_id = f"test-offair-{uuid.uuid4().hex[:8]}"
    await db.radio_offair_alerts.delete_many({"device_id": dev_id})
    await db.radio_tune_in_heartbeats.delete_many({"device_id": dev_id})
    await db.radio_tune_in_heartbeats.insert_one({
        "device_id": dev_id,
        "device_label": "Tonbridge front of house",
        "last_seen_at": _iso(10 * 60),  # 10 min ago — past 5-min threshold
        "first_seen_at": _iso(60 * 60),
    })
    try:
        res = await roa.run_radio_offair_tick()
        assert res["fired"] == 1
        assert mock_telegram.await_count == 1
        # alert collection now has a marker row
        marker = await db.radio_offair_alerts.find_one(
            {"device_id": dev_id}, {"_id": 0}
        )
        assert marker is not None
        assert marker["device_label"] == "Tonbridge front of house"
    finally:
        await db.radio_offair_alerts.delete_many({"device_id": dev_id})
        await db.radio_tune_in_heartbeats.delete_many({"device_id": dev_id})


@pytest.mark.asyncio
async def test_does_not_re_alert_on_subsequent_ticks(force_opening_hours, mock_telegram):
    """Second tick on the SAME dropout → no new Telegram (idempotency)."""
    db = get_db()
    dev_id = f"test-noredup-{uuid.uuid4().hex[:8]}"
    await db.radio_offair_alerts.delete_many({"device_id": dev_id})
    await db.radio_tune_in_heartbeats.delete_many({"device_id": dev_id})
    await db.radio_tune_in_heartbeats.insert_one({
        "device_id": dev_id,
        "device_label": "Tonbridge FOH",
        "last_seen_at": _iso(10 * 60),
        "first_seen_at": _iso(60 * 60),
    })
    try:
        await roa.run_radio_offair_tick()
        assert mock_telegram.await_count == 1
        # Second tick — nothing changed about the device
        await roa.run_radio_offair_tick()
        assert mock_telegram.await_count == 1, "Second tick must not re-alert"
    finally:
        await db.radio_offair_alerts.delete_many({"device_id": dev_id})
        await db.radio_tune_in_heartbeats.delete_many({"device_id": dev_id})


@pytest.mark.asyncio
async def test_fires_recovery_when_device_returns(force_opening_hours, mock_telegram):
    """Device was off-air (marker row exists), then heartbeat lands
    fresh → recovery Telegram fired and marker row removed."""
    db = get_db()
    dev_id = f"test-recov-{uuid.uuid4().hex[:8]}"
    await db.radio_offair_alerts.delete_many({"device_id": dev_id})
    await db.radio_tune_in_heartbeats.delete_many({"device_id": dev_id})
    # Pre-seed the alert marker as if we'd already paged about this device
    await db.radio_offair_alerts.insert_one({
        "device_id": dev_id,
        "device_label": "Maidstone showroom",
        "alerted_at": _iso(15 * 60),
        "last_seen_at_alert": _iso(20 * 60),
    })
    # Fresh heartbeat (30 s ago) — device is back
    await db.radio_tune_in_heartbeats.insert_one({
        "device_id": dev_id,
        "device_label": "Maidstone showroom",
        "last_seen_at": _iso(30),
        "first_seen_at": _iso(60 * 60),
    })
    try:
        res = await roa.run_radio_offair_tick()
        assert res["recovered"] == 1
        assert mock_telegram.await_count == 1
        # Marker row cleared
        leftover = await db.radio_offair_alerts.count_documents({"device_id": dev_id})
        assert leftover == 0
    finally:
        await db.radio_offair_alerts.delete_many({"device_id": dev_id})
        await db.radio_tune_in_heartbeats.delete_many({"device_id": dev_id})


@pytest.mark.asyncio
async def test_fires_alert_for_unlabelled_devices_with_id_fallback(force_opening_hours, mock_telegram):
    """3 Jun 2026 — Behaviour change. Previously unlabelled devices
    were skipped (rationale: "alerting on a UUID is useless noise").
    User report: "I receive telegram notification but it doesn't
    show which store it is from". To make alerts ALWAYS actionable
    even when the admin forgot to label a device, the message body
    now falls back to "Device <8-char id> (IP …)" — short enough to
    paste into the admin Tuned-In Stores panel and find which row
    just dropped off-air."""
    db = get_db()
    dev_id = f"test-anon-{uuid.uuid4().hex[:8]}"
    await db.radio_offair_alerts.delete_many({"device_id": dev_id})
    await db.radio_tune_in_heartbeats.delete_many({"device_id": dev_id})
    await db.radio_tune_in_heartbeats.insert_one({
        "device_id": dev_id,
        # No device_label
        "last_seen_at": _iso(10 * 60),
        "first_seen_at": _iso(60 * 60),
        "last_ip": "10.99.0.1",
    })
    try:
        res = await roa.run_radio_offair_tick()
        assert res["fired"] == 1, \
            "Unlabelled devices must now fire alerts (with fallback identifier)"
        assert mock_telegram.await_count == 1
        # Inspect the message body — it must include the fallback ID
        # so the admin can identify the store.
        call = mock_telegram.await_args
        msg = call.args[1] if len(call.args) > 1 else call.kwargs.get("message", "")
        assert f"Device {dev_id[:8]}" in msg
        assert "10.99.0.1" in msg
    finally:
        await db.radio_offair_alerts.delete_many({"device_id": dev_id})
        await db.radio_tune_in_heartbeats.delete_many({"device_id": dev_id})


@pytest.mark.asyncio
async def test_ignores_long_silent_devices(force_opening_hours, mock_telegram):
    """A device that's been silent for >1 hour is treated as 'not in
    use today' and skipped — we don't want to keep alerting on a
    laptop someone closed and never reopened."""
    db = get_db()
    dev_id = f"test-longsilent-{uuid.uuid4().hex[:8]}"
    await db.radio_offair_alerts.delete_many({"device_id": dev_id})
    await db.radio_tune_in_heartbeats.delete_many({"device_id": dev_id})
    await db.radio_tune_in_heartbeats.insert_one({
        "device_id": dev_id,
        "device_label": "Closed laptop",
        "last_seen_at": _iso(3 * 60 * 60),  # 3 hours ago
        "first_seen_at": _iso(48 * 60 * 60),
    })
    try:
        res = await roa.run_radio_offair_tick()
        assert res["fired"] == 0
        assert mock_telegram.await_count == 0
    finally:
        await db.radio_offair_alerts.delete_many({"device_id": dev_id})
        await db.radio_tune_in_heartbeats.delete_many({"device_id": dev_id})


@pytest.mark.asyncio
async def test_does_not_fire_when_device_is_actively_pinging(force_opening_hours, mock_telegram):
    """A device that's pinging RIGHT NOW (30s ago) and has no prior
    alert is a no-op — no fire, no recovery, no DB write."""
    db = get_db()
    dev_id = f"test-live-{uuid.uuid4().hex[:8]}"
    await db.radio_offair_alerts.delete_many({"device_id": dev_id})
    await db.radio_tune_in_heartbeats.delete_many({"device_id": dev_id})
    await db.radio_tune_in_heartbeats.insert_one({
        "device_id": dev_id,
        "device_label": "Active store",
        "last_seen_at": _iso(30),
        "first_seen_at": _iso(60 * 60),
    })
    try:
        res = await roa.run_radio_offair_tick()
        assert res["fired"] == 0
        assert res["recovered"] == 0
        assert mock_telegram.await_count == 0
    finally:
        await db.radio_offair_alerts.delete_many({"device_id": dev_id})
        await db.radio_tune_in_heartbeats.delete_many({"device_id": dev_id})

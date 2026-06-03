"""
Tests for the per-store visibility upgrade (3 Jun 2026).

User report: "How do I know which store is playing radio and which
store has paused. I receive telegram notification but it doesn't show
which store it is from".

Changes verified here:
1. /tune-in/heartbeat accepts and stores `is_playing` so the admin
   dashboard can distinguish active playback from a paused-but-
   tuned-in tab.
2. /tune-in/status returns each device's `state` ('playing' or
   'paused') + a `display_name` (label OR fallback to "Device <id8>"
   so unlabelled devices are still actionable) + counts grouped by
   state.
3. Radio off-air alerts now fire for UNLABELLED devices too, using
   the fallback identifier so the Telegram message always carries
   enough context for the admin to match the alert to a store.
"""

import os
import time
from datetime import datetime, timezone, timedelta
from unittest.mock import patch, AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _env_setup():
    os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
    os.environ.setdefault("DB_NAME", "test_radio_per_store_status")


@pytest.fixture
def client():
    from server import app
    return TestClient(app)


# ---------------------------------------------------------------------
# 1. /tune-in/heartbeat accepts and stores is_playing
# ---------------------------------------------------------------------
def test_heartbeat_stores_is_playing_true(client):
    db = MagicMock()
    db.radio_tune_in_heartbeats.update_one = AsyncMock()
    with patch("routes.radio_studio.get_db", return_value=db):
        r = client.post(
            "/api/radio-studio/tune-in/heartbeat",
            json={"device_id": "abc12345", "device_label": "Tonbridge", "is_playing": True},
        )
    assert r.status_code == 200, r.text
    call = db.radio_tune_in_heartbeats.update_one.call_args
    setter = call[0][1]["$set"]
    assert setter["is_playing"] is True
    assert "is_playing_changed_at" in setter
    assert setter["device_label"] == "Tonbridge"


def test_heartbeat_stores_is_playing_false(client):
    """A paused tab MUST mark is_playing=False so the admin panel
    flips to "⏸ Paused" within one heartbeat cycle."""
    db = MagicMock()
    db.radio_tune_in_heartbeats.update_one = AsyncMock()
    with patch("routes.radio_studio.get_db", return_value=db):
        r = client.post(
            "/api/radio-studio/tune-in/heartbeat",
            json={"device_id": "abc12345", "is_playing": False},
        )
    assert r.status_code == 200
    setter = db.radio_tune_in_heartbeats.update_one.call_args[0][1]["$set"]
    assert setter["is_playing"] is False


def test_heartbeat_legacy_payload_without_is_playing_still_works(client):
    """Pre-3-Jun-2026 frontends don't send is_playing. They must
    still upsert successfully, just without touching the flag —
    the status endpoint treats absent as 'playing' for legacy
    devices so we don't paint the dashboard amber on a deploy."""
    db = MagicMock()
    db.radio_tune_in_heartbeats.update_one = AsyncMock()
    with patch("routes.radio_studio.get_db", return_value=db):
        r = client.post(
            "/api/radio-studio/tune-in/heartbeat",
            json={"device_id": "legacy01", "device_label": "Old Tab"},
        )
    assert r.status_code == 200
    setter = db.radio_tune_in_heartbeats.update_one.call_args[0][1]["$set"]
    assert "is_playing" not in setter, \
        "Legacy payload (no is_playing key) must NOT overwrite the field"


# ---------------------------------------------------------------------
# 2. /tune-in/status returns play/paused state + display_name
# ---------------------------------------------------------------------
def _async_iter(items):
    class _It:
        def __init__(self, items): self._items = list(items)
        def __aiter__(self): self._iter = iter(self._items); return self
        async def __anext__(self):
            try: return next(self._iter)
            except StopIteration as e: raise StopAsyncIteration from e
        def sort(self, *a, **kw): return self
        def limit(self, *a, **kw): return self
    return _It(items)


def _admin_token_headers(client):
    """Helper: log in with the seeded admin and return Bearer headers."""
    r = client.post(
        "/api/auth/login",
        json={"email": "admin@test.com", "password": "admin123"},
    )
    if r.status_code != 200:
        pytest.skip(f"Admin login unavailable in test env: {r.status_code}")
    return {"Authorization": f"Bearer {r.json()['token']}"}


def test_status_returns_playing_state_for_active_device():
    """When is_playing=True, .state must be 'playing' and there's a
    matching playing_count of 1."""
    import asyncio
    from routes.radio_studio import radio_tune_in_status

    now_iso = datetime.now(timezone.utc).isoformat()
    db = MagicMock()
    db.radio_tune_in_heartbeats.find = MagicMock(return_value=_async_iter([
        {"device_id": "dev-aaaaaaaa-bbbb", "device_label": "Tonbridge",
         "last_seen_at": now_iso, "last_ip": "10.0.0.1",
         "is_playing": True, "first_seen_at": now_iso},
    ]))
    db.radio_studio_playlists.find_one = AsyncMock(return_value=None)
    db.radio_studio_ads.find = MagicMock(return_value=_async_iter([]))
    db.radio_studio_music.find = MagicMock(return_value=_async_iter([]))

    user = {"role": "super_admin", "email": "x@test"}
    with patch("routes.radio_studio.get_db", return_value=db):
        data = asyncio.run(radio_tune_in_status(current_user=user))

    assert data["playing_count"] == 1
    assert data["paused_count"] == 0
    assert data["devices"][0]["state"] == "playing"
    assert data["devices"][0]["display_name"] == "Tonbridge"


def test_status_returns_paused_state_when_audio_is_paused():
    """is_playing=False → state='paused' and paused_count increments."""
    import asyncio
    from routes.radio_studio import radio_tune_in_status

    now_iso = datetime.now(timezone.utc).isoformat()
    db = MagicMock()
    db.radio_tune_in_heartbeats.find = MagicMock(return_value=_async_iter([
        {"device_id": "paused-dev-01", "device_label": "Maidstone",
         "last_seen_at": now_iso, "last_ip": "10.0.0.2",
         "is_playing": False, "first_seen_at": now_iso},
    ]))
    db.radio_studio_playlists.find_one = AsyncMock(return_value=None)
    db.radio_studio_ads.find = MagicMock(return_value=_async_iter([]))
    db.radio_studio_music.find = MagicMock(return_value=_async_iter([]))

    user = {"role": "super_admin", "email": "x@test"}
    with patch("routes.radio_studio.get_db", return_value=db):
        data = asyncio.run(radio_tune_in_status(current_user=user))

    assert data["playing_count"] == 0
    assert data["paused_count"] == 1
    assert data["devices"][0]["state"] == "paused"
    assert data["devices"][0]["display_name"] == "Maidstone"


def test_status_falls_back_to_device_id_when_label_missing():
    """The whole point of this change: unlabelled devices must STILL
    be identifiable in the admin UI."""
    import asyncio
    from routes.radio_studio import radio_tune_in_status

    now_iso = datetime.now(timezone.utc).isoformat()
    db = MagicMock()
    db.radio_tune_in_heartbeats.find = MagicMock(return_value=_async_iter([
        {"device_id": "abcdef0123456789", "device_label": "",
         "last_seen_at": now_iso, "last_ip": "10.0.0.3",
         "is_playing": True, "first_seen_at": now_iso},
    ]))
    db.radio_studio_playlists.find_one = AsyncMock(return_value=None)
    db.radio_studio_ads.find = MagicMock(return_value=_async_iter([]))
    db.radio_studio_music.find = MagicMock(return_value=_async_iter([]))

    user = {"role": "super_admin", "email": "x@test"}
    with patch("routes.radio_studio.get_db", return_value=db):
        data = asyncio.run(radio_tune_in_status(current_user=user))

    assert data["devices"][0]["display_name"] == "Device abcdef01", \
        "Unlabelled device must get a short-id fallback display name"


def test_status_treats_legacy_devices_as_playing():
    """Heartbeats from pre-3-Jun-2026 frontends don't carry is_playing.
    Status MUST default them to 'playing' so the panel doesn't
    spuriously paint every old tab as paused on first deploy."""
    import asyncio
    from routes.radio_studio import radio_tune_in_status

    now_iso = datetime.now(timezone.utc).isoformat()
    db = MagicMock()
    db.radio_tune_in_heartbeats.find = MagicMock(return_value=_async_iter([
        {"device_id": "legacy-tab-01", "device_label": "Legacy",
         "last_seen_at": now_iso, "last_ip": "10.0.0.4",
         # NO is_playing field
         "first_seen_at": now_iso},
    ]))
    db.radio_studio_playlists.find_one = AsyncMock(return_value=None)
    db.radio_studio_ads.find = MagicMock(return_value=_async_iter([]))
    db.radio_studio_music.find = MagicMock(return_value=_async_iter([]))

    user = {"role": "super_admin", "email": "x@test"}
    with patch("routes.radio_studio.get_db", return_value=db):
        data = asyncio.run(radio_tune_in_status(current_user=user))

    assert data["devices"][0]["state"] == "playing"
    assert data["playing_count"] == 1


# ---------------------------------------------------------------------
# 3. Off-air alerts fire for UNLABELLED devices with fallback ID
# ---------------------------------------------------------------------
def test_offair_alert_fires_for_unlabelled_device():
    """Previously the filter required device_label. Now unlabelled
    devices ALSO produce alerts — the message uses 'Device <id8>
    (IP …)' so the admin can still identify which store dropped."""
    import asyncio
    from services import radio_offair_alerts as roa

    # Force opening hours
    with patch.object(roa, "_is_within_opening_hours", return_value=True):
        db = MagicMock()
        ten_min_ago = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
        db.radio_tune_in_heartbeats.find = MagicMock(return_value=_async_iter([
            {"device_id": "stale-dev-01", "device_label": "",
             "last_seen_at": ten_min_ago, "last_ip": "10.0.0.5"},
        ]))
        db.radio_offair_alerts.find_one = AsyncMock(return_value=None)
        db.radio_offair_alerts.update_one = AsyncMock()
        sent_messages = []

        async def _fake_notify(event, message, dedupe_key=None):
            sent_messages.append({"event": event, "message": message, "dedupe_key": dedupe_key})

        with patch.object(roa, "get_db", return_value=db), \
             patch.object(roa, "notify_event", side_effect=_fake_notify):
            result = asyncio.run(roa.run_radio_offair_tick())

        assert result.get("fired", 0) == 1, \
            f"Off-air tick must fire for unlabelled device too (got {result})"
        assert len(sent_messages) == 1
        msg = sent_messages[0]["message"]
        # Must include the fallback identifier so the admin knows
        # which store to check.
        assert "Device stale-de" in msg, \
            f"Message must include short-id fallback. Got: {msg}"
        assert "IP 10.0.0.5" in msg, \
            f"Message must include last-known IP for unlabelled device. Got: {msg}"


def test_offair_alert_uses_label_when_present():
    """Labelled devices should still get the friendly label in the
    Telegram message (regression guard)."""
    import asyncio
    from services import radio_offair_alerts as roa

    with patch.object(roa, "_is_within_opening_hours", return_value=True):
        db = MagicMock()
        ten_min_ago = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
        db.radio_tune_in_heartbeats.find = MagicMock(return_value=_async_iter([
            {"device_id": "labelled-d-01", "device_label": "Tonbridge FOH",
             "last_seen_at": ten_min_ago, "last_ip": "10.0.0.6"},
        ]))
        db.radio_offair_alerts.find_one = AsyncMock(return_value=None)
        db.radio_offair_alerts.update_one = AsyncMock()
        sent_messages = []

        async def _fake_notify(event, message, dedupe_key=None):
            sent_messages.append({"event": event, "message": message})

        with patch.object(roa, "get_db", return_value=db), \
             patch.object(roa, "notify_event", side_effect=_fake_notify):
            asyncio.run(roa.run_radio_offair_tick())

        assert len(sent_messages) == 1
        msg = sent_messages[0]["message"]
        assert "Tonbridge FOH dropped off-air" in msg
        # When label is present, do NOT add the IP/device fallback —
        # the message stays clean.
        assert "Device labelled-d" not in msg
        assert "IP 10.0.0.6" not in msg


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

"""
Regression test for the 22 Jun 2026 fix — per-event silent-mode on
Telegram notifications.

Bug request (owner):
    "I've disabled the notification for 'New Visitor land on website'.
    What I want is to stay quiet instead of being bombarded with
    notifications for that feature but still want to see when I open
    Telegram manually. How do I do that?"

Telegram's Bot API has a native `disable_notification` parameter
exactly for that: the message lands in the chat history but produces
no sound, vibration, or lock-screen banner. The owner only sees it
when they manually open the app.

Three states per event:
    Off    — events[key]=False                → no send at all
    Silent — events[key]=True + key in
             silent_events                    → send with disable_notification=True
    Loud   — events[key]=True + key NOT in
             silent_events                    → normal send (default)

These tests assert the data plumbing — that `notify_event` calls
`send_telegram` with the right `silent` arg based on the config.
"""
from __future__ import annotations

import asyncio
import pytest
from unittest.mock import patch

from services import telegram_notify

pytestmark = pytest.mark.asyncio


@pytest.fixture(autouse=True)
def _ensure_event_loop(event_loop):
    """Bind the conftest's session-scoped event_loop to the thread for
    every test in this file. Required because none of the tests here
    touch the DB / fixtures that would otherwise pull the loop in
    automatically — without this autouse glue, running the file AFTER
    suites that DO use DB fixtures leaves pytest-asyncio with a
    closed loop and every test errors with
    `RuntimeError: There is no current event loop in thread`."""
    asyncio.set_event_loop(event_loop)
    yield


def _make_cfg(*, enabled=True, events=None, silent_events=None):
    """Plain-dict config matching the shape `get_config()` returns."""
    return {
        "enabled": enabled,
        "bot_token": "test-token",
        "chat_ids": ["123"],
        "events": {
            "visitor_landed": False,
            "new_order": True,
            **(events or {}),
        },
        "silent_events": list(silent_events or []),
        "abandoned_basket_threshold_gbp": 100,
    }


class _SendCapture:
    """Plain async-callable replacement for `send_telegram` — captures
    each call's positional and keyword args so the tests can assert
    the `silent=` flag was set correctly. Avoids `AsyncMock` (which
    interacts poorly with the session-scoped event_loop fixture in
    this repo's conftest.py)."""

    def __init__(self, result=None):
        self.calls = []
        self._result = result or {"sent": 1, "errors": []}

    async def __call__(self, *args, **kwargs):
        self.calls.append({"args": args, "kwargs": kwargs})
        return self._result

    @property
    def call_count(self):
        return len(self.calls)


# ─────────────────────────────────────────────────────────────────────
# The three states — Off, Silent, Loud
# ─────────────────────────────────────────────────────────────────────

async def test_event_off_does_not_send_at_all():
    """Off state: events[key] is False → notify_event short-circuits
    before calling send_telegram. The Bot API is never hit."""
    cap = _SendCapture()
    cfg = _make_cfg(events={"visitor_landed": False})

    async def fake_get_config():
        return cfg

    with patch.object(telegram_notify, "get_config", fake_get_config), \
         patch.object(telegram_notify, "send_telegram", cap):
        result = await telegram_notify.notify_event("visitor_landed", "hi")

    assert cap.call_count == 0
    assert "skipped" in result and "event_disabled" in result["skipped"]


async def test_event_silent_sends_with_disable_notification_true():
    """Silent state: events[key]=True AND key in silent_events →
    send_telegram is called with silent=True, which propagates to
    Telegram's `disable_notification` flag in the payload."""
    cap = _SendCapture()
    cfg = _make_cfg(
        events={"visitor_landed": True},
        silent_events=["visitor_landed"],
    )

    async def fake_get_config():
        return cfg

    with patch.object(telegram_notify, "get_config", fake_get_config), \
         patch.object(telegram_notify, "send_telegram", cap):
        await telegram_notify.notify_event("visitor_landed", "visitor 🚶")

    assert cap.call_count == 1
    assert cap.calls[0]["kwargs"].get("silent") is True


async def test_event_loud_sends_with_silent_false():
    """Loud state (default): events[key]=True AND key NOT in
    silent_events → send_telegram is called with silent=False, the
    Bot API gets the normal payload, sound + banner fire as today."""
    cap = _SendCapture()
    cfg = _make_cfg(events={"new_order": True}, silent_events=[])

    async def fake_get_config():
        return cfg

    with patch.object(telegram_notify, "get_config", fake_get_config), \
         patch.object(telegram_notify, "send_telegram", cap):
        await telegram_notify.notify_event("new_order", "🛒 new order")

    assert cap.call_count == 1
    assert cap.calls[0]["kwargs"].get("silent") is False


async def test_silent_only_applies_to_named_event_not_others():
    """An event listed in silent_events stays silent, but other
    enabled events keep firing loud. Critical: a typo in
    silent_events must NOT accidentally mute every alert."""
    cap = _SendCapture()
    cfg = _make_cfg(
        events={"visitor_landed": True, "new_order": True},
        silent_events=["visitor_landed"],
    )

    async def fake_get_config():
        return cfg

    with patch.object(telegram_notify, "get_config", fake_get_config), \
         patch.object(telegram_notify, "send_telegram", cap):
        await telegram_notify.notify_event("visitor_landed", "v")
        await telegram_notify.notify_event("new_order", "o")

    assert cap.call_count == 2
    assert cap.calls[0]["kwargs"].get("silent") is True   # visitor → silent
    assert cap.calls[1]["kwargs"].get("silent") is False  # order   → loud


# ─────────────────────────────────────────────────────────────────────
# Wire-level — `send_telegram` actually puts the flag on the payload
# ─────────────────────────────────────────────────────────────────────

async def test_send_telegram_payload_includes_disable_notification_when_silent():
    """The wire payload sent to the Telegram Bot API must include
    `disable_notification: true` when silent=True. Without this, the
    config flips silent-mode on but the message still pings the
    phone — silent-mode would be a UI-only lie."""
    captured = {}

    class FakeResp:
        status_code = 200
        text = ""
        def json(self):
            return {"ok": True}

    class FakeClient:
        def __init__(self, *_a, **_k):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *_a, **_k):
            return False
        async def post(self, _url, json=None):
            captured["payload"] = json
            return FakeResp()

    cfg = _make_cfg()

    async def fake_get_config():
        return cfg

    with patch.object(telegram_notify, "get_config", fake_get_config), \
         patch("services.telegram_notify.httpx.AsyncClient", FakeClient):
        await telegram_notify.send_telegram("hi", silent=True)

    assert captured["payload"]["disable_notification"] is True
    assert captured["payload"]["text"] == "hi"


async def test_send_telegram_payload_omits_disable_notification_when_loud():
    """Backwards-compat guarantee: the wire payload for loud sends
    is byte-identical to before this change. `disable_notification`
    must NOT appear at all (not even as false) so any reverse-proxy
    or audit log compare-against-baseline diff doesn't light up."""
    captured = {}

    class FakeResp:
        status_code = 200
        text = ""
        def json(self):
            return {"ok": True}

    class FakeClient:
        def __init__(self, *_a, **_k):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *_a, **_k):
            return False
        async def post(self, _url, json=None):
            captured["payload"] = json
            return FakeResp()

    cfg = _make_cfg()

    async def fake_get_config():
        return cfg

    with patch.object(telegram_notify, "get_config", fake_get_config), \
         patch("services.telegram_notify.httpx.AsyncClient", FakeClient):
        await telegram_notify.send_telegram("hi")  # silent defaults to False

    assert "disable_notification" not in captured["payload"]


# ─────────────────────────────────────────────────────────────────────
# Config persistence — silent_events list survives the merge layer
# ─────────────────────────────────────────────────────────────────────

async def test_merge_defaults_preserves_silent_events_list():
    """The Mongo doc loader must keep the silent_events list intact
    so a save → reload round-trip doesn't lose the owner's choice."""
    merged = telegram_notify._merge_defaults({
        "silent_events": ["visitor_landed", "basket_add"],
    })
    assert "visitor_landed" in merged["silent_events"]
    assert "basket_add" in merged["silent_events"]


async def test_merge_defaults_filters_unknown_event_keys_from_silent_events():
    """Stale entries for deprecated event keys must be silently
    dropped at load time so we don't accidentally try to mute an
    event that no longer exists. Keeps the config self-cleaning."""
    merged = telegram_notify._merge_defaults({
        "silent_events": ["visitor_landed", "deprecated_old_event", "new_order"],
    })
    assert "visitor_landed" in merged["silent_events"]
    assert "new_order" in merged["silent_events"]
    assert "deprecated_old_event" not in merged["silent_events"]


async def test_merge_defaults_handles_missing_silent_events_list():
    """Old configs (created before this feature shipped) have no
    silent_events field at all — they must merge cleanly into an
    empty list so every event reads as Loud by default."""
    merged = telegram_notify._merge_defaults({
        "enabled": True, "bot_token": "x", "chat_ids": ["1"],
    })
    assert merged["silent_events"] == []

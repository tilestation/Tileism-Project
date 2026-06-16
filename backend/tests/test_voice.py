"""
Tests for the Twilio Voice call-centre module.
"""
import os
import asyncio
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture(autouse=True)
def _env():
    os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
    os.environ.setdefault("DB_NAME", "test_voice")
    os.environ["VOICE_REQUIRE_SIGNATURE"] = "0"


ADMIN = {"role": "super_admin", "id": "u-su", "email": "admin@x.com"}
MGR = {"role": "manager", "id": "u-mg", "email": "mgr@x.com"}
STAFF = {"role": "staff", "id": "u-st", "email": "st@x.com"}


class _Cursor:
    def __init__(self, items): self.items = list(items)
    def sort(self, *a, **k): return self
    def limit(self, *a, **k): return self
    async def to_list(self, _n=None): return list(self.items)


# ─── Settings ────────────────────────────────────────────────────────
def test_get_settings_returns_defaults_when_missing():
    from routes.voice import admin_get_voice_settings
    db = MagicMock()
    db.voice_settings = MagicMock()
    db.voice_settings.find_one = AsyncMock(return_value=None)
    with patch("routes.voice.get_db", return_value=db):
        out = asyncio.run(admin_get_voice_settings(current_user=ADMIN))
    assert out["enabled"] is True
    assert out["ads_source"] == "radio_studio"
    assert out["max_hold_ads"] == 2
    assert out["recording_enabled"] is True
    assert out["welcome_message_text"].startswith("Welcome to Tile Station")


def test_put_settings_requires_super_admin():
    from routes.voice import admin_put_voice_settings, VoiceSettings
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc:
        asyncio.run(admin_put_voice_settings(VoiceSettings(), current_user=MGR))
    assert exc.value.status_code == 403


def test_put_settings_persists_doc():
    from routes.voice import admin_put_voice_settings, VoiceSettings
    db = MagicMock()
    db.voice_settings = MagicMock()
    db.voice_settings.update_one = AsyncMock()
    payload = VoiceSettings(divert_mobile_number="+447379562631",
                            twilio_phone_number="+441474000001")
    with patch("routes.voice.get_db", return_value=db):
        out = asyncio.run(admin_put_voice_settings(payload, current_user=ADMIN))
    assert out["divert_mobile_number"] == "+447379562631"
    assert out["twilio_phone_number"] == "+441474000001"
    assert out["updated_by"] == "admin@x.com"
    db.voice_settings.update_one.assert_awaited_once()


# ─── Incoming TwiML ──────────────────────────────────────────────────
class _MockForm(dict):
    """Looks like a FormData object — supports both dict-style access
    AND the iteration the Twilio validator does."""
    async def __call__(self):
        return self


def _mock_request(form_data: dict, path: str = "/api/voice/incoming"):
    req = MagicMock()
    req.url = MagicMock(scheme="https", path=path, netloc="x.com")
    req.headers = {}
    async def _form():
        return form_data
    req.form = _form
    return req


def test_incoming_twiml_includes_welcome_and_dial():
    from routes.voice import voice_incoming
    db = MagicMock()
    db.voice_settings = MagicMock()
    db.voice_settings.find_one = AsyncMock(return_value=None)  # use defaults
    db.voice_calls = MagicMock()
    db.voice_calls.insert_one = AsyncMock()
    db.radio_ads = MagicMock()
    db.radio_ads.find = MagicMock(return_value=_Cursor([
        {"audio_url": "https://r2.example.com/ad1.mp3", "name": "Ad 1"},
    ]))
    req = _mock_request({"From": "+447111000000", "CallSid": "CAtest",
                          "To": "+441474000001"})
    with patch("routes.voice.get_db", return_value=db), \
         patch("routes.voice.OWNER_MOBILE_NUMBER", "+447379562631"):
        resp = asyncio.run(voice_incoming(req))
    body = resp.body.decode() if isinstance(resp.body, bytes) else str(resp.body)
    assert resp.media_type == "application/xml"
    assert "<Response>" in body
    assert "<Say" in body or "<Play>" in body
    assert "<Dial" in body
    assert "+447379562631" in body  # mobile fallback used
    assert "ad1.mp3" in body  # hold ad included
    assert 'record="record-from-answer-dual"' in body
    # Pre-logged the inbound call
    db.voice_calls.insert_one.assert_awaited_once()


def test_incoming_twiml_when_disabled_returns_hangup_message():
    from routes.voice import voice_incoming
    db = MagicMock()
    db.voice_settings = MagicMock()
    db.voice_settings.find_one = AsyncMock(return_value={"enabled": False, "id": "default"})
    db.voice_calls = MagicMock()
    db.voice_calls.insert_one = AsyncMock()
    req = _mock_request({"From": "+447", "CallSid": "C1", "To": "+441"})
    with patch("routes.voice.get_db", return_value=db):
        resp = asyncio.run(voice_incoming(req))
    body = resp.body.decode()
    assert "<Hangup/>" in body
    assert "<Dial" not in body
    assert "unavailable" in body.lower()


def test_incoming_twiml_uses_play_when_welcome_audio_url_set():
    from routes.voice import voice_incoming
    db = MagicMock()
    db.voice_settings = MagicMock()
    db.voice_settings.find_one = AsyncMock(return_value={
        "id": "default", "enabled": True,
        "welcome_audio_url": "https://r2.example.com/welcome.mp3",
        "welcome_message_text": "fallback text",
        "divert_mobile_number": "+447379562631",
        "twilio_phone_number": "+441474000001",
        "ads_source": "none", "max_hold_ads": 0,
        "recording_enabled": True, "ring_timeout_seconds": 25,
        "business_hours_enabled": False,
        "inbound_call_telegram_alerts": False,
    })
    db.voice_calls = MagicMock()
    db.voice_calls.insert_one = AsyncMock()
    req = _mock_request({"From": "+447", "CallSid": "C2", "To": "+441"})
    with patch("routes.voice.get_db", return_value=db):
        resp = asyncio.run(voice_incoming(req))
    body = resp.body.decode()
    assert "<Play>https://r2.example.com/welcome.mp3</Play>" in body
    assert "fallback text" not in body  # Play wins over Say


def test_incoming_escapes_xml_special_chars_in_say_text():
    """Welcome text with `&` and `<` MUST be XML-escaped or Twilio
    will reject the response."""
    from routes.voice import voice_incoming
    db = MagicMock()
    db.voice_settings = MagicMock()
    db.voice_settings.find_one = AsyncMock(return_value={
        "id": "default", "enabled": True,
        "welcome_message_text": "Welcome to Tile & Stone <Premium>",
        "divert_mobile_number": "+447",
        "ads_source": "none", "max_hold_ads": 0,
        "recording_enabled": False, "ring_timeout_seconds": 25,
        "business_hours_enabled": False,
        "inbound_call_telegram_alerts": False,
    })
    db.voice_calls = MagicMock()
    db.voice_calls.insert_one = AsyncMock()
    req = _mock_request({"From": "+447", "CallSid": "C3", "To": "+441"})
    with patch("routes.voice.get_db", return_value=db):
        resp = asyncio.run(voice_incoming(req))
    body = resp.body.decode()
    assert "Tile &amp; Stone" in body
    assert "&lt;Premium&gt;" in body
    assert "Tile & Stone <Premium>" not in body  # not raw


# ─── Status webhook ──────────────────────────────────────────────────
def test_status_webhook_marks_missed_and_telegrams():
    from routes.voice import voice_status
    db = MagicMock()
    db.voice_calls = MagicMock()
    db.voice_calls.update_one = AsyncMock()
    db.voice_settings = MagicMock()
    db.voice_settings.find_one = AsyncMock(return_value={"missed_call_telegram_alerts": True})
    tg = MagicMock()
    req = _mock_request({
        "CallSid": "CAtest", "DialCallStatus": "no-answer",
        "DialCallDuration": "0", "From": "+447111000000",
    }, path="/api/voice/status")
    with patch("routes.voice.get_db", return_value=db), \
         patch("services.telegram_notify.fire_and_forget", tg):
        asyncio.run(voice_status(req))
    args, _ = db.voice_calls.update_one.await_args
    assert args[0] == {"call_sid": "CAtest"}
    update = args[1]["$set"]
    assert update["dial_status"] == "no-answer"
    assert update["missed"] is True
    # Telegram fired with "Missed call" subject
    assert tg.call_count == 1
    msg = tg.call_args[0][1]
    assert "Missed" in msg or "missed" in msg


def test_status_webhook_skips_telegram_when_disabled():
    from routes.voice import voice_status
    db = MagicMock()
    db.voice_calls = MagicMock()
    db.voice_calls.update_one = AsyncMock()
    db.voice_settings = MagicMock()
    db.voice_settings.find_one = AsyncMock(return_value={"missed_call_telegram_alerts": False})
    tg = MagicMock()
    req = _mock_request({
        "CallSid": "CAtest", "DialCallStatus": "no-answer",
        "DialCallDuration": "0", "From": "+447",
    }, path="/api/voice/status")
    with patch("routes.voice.get_db", return_value=db), \
         patch("services.telegram_notify.fire_and_forget", tg):
        asyncio.run(voice_status(req))
    tg.assert_not_called()


def test_status_webhook_does_not_alert_on_answered_calls():
    from routes.voice import voice_status
    db = MagicMock()
    db.voice_calls = MagicMock()
    db.voice_calls.update_one = AsyncMock()
    db.voice_settings = MagicMock()
    db.voice_settings.find_one = AsyncMock(return_value={"missed_call_telegram_alerts": True})
    tg = MagicMock()
    req = _mock_request({
        "CallSid": "CAtest", "DialCallStatus": "completed",
        "DialCallDuration": "42", "From": "+447",
    }, path="/api/voice/status")
    with patch("routes.voice.get_db", return_value=db), \
         patch("services.telegram_notify.fire_and_forget", tg):
        asyncio.run(voice_status(req))
    tg.assert_not_called()
    update = db.voice_calls.update_one.await_args[0][1]["$set"]
    assert update["missed"] is False
    assert update["duration_seconds"] == 42


# ─── Recording status ────────────────────────────────────────────────
def test_recording_status_writes_url():
    from routes.voice import voice_recording_status
    db = MagicMock()
    db.voice_calls = MagicMock()
    db.voice_calls.update_one = AsyncMock()
    req = _mock_request({
        "CallSid": "CAtest",
        "RecordingUrl": "https://api.twilio.com/2010/.../Recordings/REabc",
        "RecordingSid": "REabc",
        "RecordingDuration": "60",
    }, path="/api/voice/recording-status")
    with patch("routes.voice.get_db", return_value=db):
        asyncio.run(voice_recording_status(req))
    args, _ = db.voice_calls.update_one.await_args
    set_doc = args[1]["$set"]
    assert set_doc["recording_url"].endswith("REabc")
    assert set_doc["recording_sid"] == "REabc"
    assert set_doc["recording_duration"] == 60


# ─── Token endpoint ──────────────────────────────────────────────────
def test_token_returns_503_when_keys_missing():
    from routes.voice import voice_token
    from fastapi import HTTPException
    with patch("routes.voice.TWILIO_API_KEY", ""):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(voice_token(current_user=ADMIN))
    assert exc.value.status_code == 503
    assert "click-to-call" in exc.value.detail.lower()


def test_token_rejects_non_admin():
    from routes.voice import voice_token
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc:
        asyncio.run(voice_token(current_user=STAFF))
    assert exc.value.status_code == 403


# ─── Stats ───────────────────────────────────────────────────────────
def test_stats_aggregates_today_week_month_and_daily():
    from routes.voice import admin_voice_stats
    db = MagicMock()

    summary_cursor = MagicMock()
    async def _summary_list(_n):
        return [{"_id": None, "count": 3, "total_duration": 180, "missed": 1}]
    summary_cursor.to_list = _summary_list

    daily_cursor = MagicMock()
    async def _daily_to_list(_n):
        # Mongo returns only days that have activity — verify the
        # endpoint pads the missing days itself.
        from datetime import date as _date
        today = _date.today().isoformat()
        return [{"_id": today, "count": 5, "missed": 1}]
    daily_cursor.to_list = _daily_to_list

    def _aggregate(pipeline):
        if any("$project" in s for s in pipeline):
            return daily_cursor
        return summary_cursor

    db.voice_calls = MagicMock()
    db.voice_calls.aggregate = _aggregate
    with patch("routes.voice.get_db", return_value=db):
        out = asyncio.run(admin_voice_stats(current_user=ADMIN))
    assert out["today"]["count"] == 3
    assert out["week"]["count"] == 3
    assert out["month"]["count"] == 3
    # The daily array MUST be exactly 7 entries — even when most days
    # had no calls — so the front-end chart always renders a full week.
    assert len(out["daily"]) == 7
    counts = [d["count"] for d in out["daily"]]
    assert counts.count(0) == 6  # 6 zero-filled days
    assert counts.count(5) == 1  # 1 active day
    # Days are ordered oldest → newest
    days = [d["day"] for d in out["daily"]]
    assert days == sorted(days)
    assert "generated_at" in out


# ─── Call log list/get ───────────────────────────────────────────────
def test_calls_list_filters_direction_and_missed():
    from routes.voice import admin_list_calls
    db = MagicMock()
    db.voice_calls = MagicMock()
    db.voice_calls.find = MagicMock(return_value=_Cursor([
        {"id": "c1", "direction": "inbound", "missed": True, "from_number": "+447"},
    ]))
    with patch("routes.voice.get_db", return_value=db):
        out = asyncio.run(admin_list_calls(direction="inbound", missed_only=True,
                                            limit=50, current_user=ADMIN))
    args, _ = db.voice_calls.find.call_args
    query = args[0]
    assert query["direction"] == "inbound"
    assert query["missed"] is True
    assert len(out) == 1


def test_calls_list_rejects_non_admin():
    from routes.voice import admin_list_calls
    from fastapi import HTTPException
    with pytest.raises(HTTPException):
        asyncio.run(admin_list_calls(current_user=STAFF))


# ─── Business hours ─────────────────────────────────────────────────
def test_business_hours_closed_returns_closed_message():
    from routes.voice import voice_incoming
    db = MagicMock()
    db.voice_settings = MagicMock()
    db.voice_settings.find_one = AsyncMock(return_value={
        "id": "default", "enabled": True,
        "welcome_message_text": "Welcome",
        "divert_mobile_number": "+447",
        "ads_source": "none", "max_hold_ads": 0,
        "recording_enabled": False, "ring_timeout_seconds": 25,
        "business_hours_enabled": True,
        "business_hours_open": "09:00", "business_hours_close": "17:30",
        "business_hours_days": [],  # NEVER open
        "closed_message_text": "We're closed right now.",
        "inbound_call_telegram_alerts": False,
    })
    db.voice_calls = MagicMock()
    db.voice_calls.insert_one = AsyncMock()
    req = _mock_request({"From": "+447", "CallSid": "Cclosed", "To": "+441"})
    with patch("routes.voice.get_db", return_value=db):
        resp = asyncio.run(voice_incoming(req))
    body = resp.body.decode()
    assert "We&apos;re closed right now." in body
    assert "<Hangup/>" in body
    assert "<Dial" not in body

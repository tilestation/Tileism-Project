"""
Tests for per-showroom voice routing (Feb 2026).
"""
import os
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture(autouse=True)
def _env():
    os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
    os.environ.setdefault("DB_NAME", "test_voice_rooms")
    os.environ["VOICE_REQUIRE_SIGNATURE"] = "0"


SUPER = {"role": "super_admin", "id": "u-su", "email": "su@x.com"}
HR = {"role": "manager", "id": "u-mg", "email": "mg@x.com"}
STAFF = {"role": "staff", "id": "u-st", "email": "st@x.com"}


class _Cursor:
    def __init__(self, items): self.items = list(items)
    def sort(self, *a, **k): return self
    def limit(self, *a, **k): return self
    async def to_list(self, _n=None): return list(self.items)


# ─── Number normalisation ───────────────────────────────────────────
@pytest.mark.parametrize("inp,expected", [
    ("07379562631",     "+447379562631"),
    ("+447379562631",   "+447379562631"),
    ("0044 7379 562631", "+447379562631"),
    ("01474 878989",    "+441474878989"),
    ("",                ""),
])
def test_normalize_to_e164(inp, expected):
    from routes.voice_showroom_routes import _normalize_to_e164
    assert _normalize_to_e164(inp) == expected


# ─── List endpoint ──────────────────────────────────────────────────
def test_list_routes_returns_routes_plus_showrooms():
    from routes.voice_showroom_routes import list_routes
    db = MagicMock()
    db.voice_showroom_routes = MagicMock()
    db.voice_showroom_routes.find = MagicMock(return_value=_Cursor([
        {"showroom_name": "Gravesend", "twilio_number": "+441474000001"},
    ]))
    db.showrooms = MagicMock()
    db.showrooms.find = MagicMock(return_value=_Cursor([
        {"id": "1", "name": "Gravesend", "phone": "01474 878989"},
        {"id": "2", "name": "Tonbridge", "phone": "01732 914 374"},
    ]))
    with patch("routes.voice_showroom_routes.get_db", return_value=db):
        out = asyncio.run(list_routes(current_user=SUPER))
    assert len(out["routes"]) == 1
    assert len(out["showrooms"]) == 2
    assert {s["name"] for s in out["showrooms"]} == {"Gravesend", "Tonbridge"}


def test_list_routes_allows_manager_role():
    """Manager role can VIEW routes — only super_admin can WRITE."""
    from routes.voice_showroom_routes import list_routes
    db = MagicMock()
    db.voice_showroom_routes = MagicMock()
    db.voice_showroom_routes.find = MagicMock(return_value=_Cursor([]))
    db.showrooms = MagicMock()
    db.showrooms.find = MagicMock(return_value=_Cursor([]))
    with patch("routes.voice_showroom_routes.get_db", return_value=db):
        out = asyncio.run(list_routes(current_user=HR))
    assert out is not None


def test_list_routes_rejects_non_admin():
    from routes.voice_showroom_routes import list_routes
    from fastapi import HTTPException
    with pytest.raises(HTTPException):
        asyncio.run(list_routes(current_user=STAFF))


# ─── Upsert endpoint ────────────────────────────────────────────────
def test_upsert_route_requires_super_admin():
    from routes.voice_showroom_routes import upsert_route, ShowroomRoute
    from fastapi import HTTPException
    payload = ShowroomRoute(showroom_name="Gravesend", twilio_number="+441474000001")
    with pytest.raises(HTTPException) as exc:
        asyncio.run(upsert_route("Gravesend", payload, current_user=HR))
    assert exc.value.status_code == 403


def test_upsert_route_normalises_phone_numbers():
    from routes.voice_showroom_routes import upsert_route, ShowroomRoute
    db = MagicMock()
    db.voice_showroom_routes = MagicMock()
    db.voice_showroom_routes.find_one = AsyncMock(return_value=None)
    db.voice_showroom_routes.update_one = AsyncMock()
    payload = ShowroomRoute(showroom_name="Gravesend",
                            twilio_number="01474 878989",  # local format
                            divert_mobile="07379562631")
    with patch("routes.voice_showroom_routes.get_db", return_value=db):
        out = asyncio.run(upsert_route("Gravesend", payload, current_user=SUPER))
    assert out["twilio_number"] == "+441474878989"
    assert out["divert_mobile"] == "+447379562631"


def test_upsert_route_rejects_duplicate_twilio_number():
    """The same Twilio number can't be wired to two showrooms — they'd
    both fight for the same TwiML response."""
    from routes.voice_showroom_routes import upsert_route, ShowroomRoute
    from fastapi import HTTPException
    db = MagicMock()
    db.voice_showroom_routes = MagicMock()
    db.voice_showroom_routes.find_one = AsyncMock(return_value={
        "showroom_name": "Tonbridge",
    })
    payload = ShowroomRoute(showroom_name="Gravesend",
                            twilio_number="+441474000001",
                            divert_mobile="+447379562631")
    with patch("routes.voice_showroom_routes.get_db", return_value=db):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(upsert_route("Gravesend", payload, current_user=SUPER))
    assert exc.value.status_code == 409
    assert "Tonbridge" in exc.value.detail


def test_upsert_route_url_name_wins_over_payload_name():
    """The URL is the canonical identifier — payload.showroom_name is
    ignored to prevent rename via PUT confusion."""
    from routes.voice_showroom_routes import upsert_route, ShowroomRoute
    db = MagicMock()
    db.voice_showroom_routes = MagicMock()
    db.voice_showroom_routes.find_one = AsyncMock(return_value=None)
    captured = {}
    async def _update(flt, op, upsert=False):
        captured["filter"] = flt
        captured["doc"] = op["$set"]
    db.voice_showroom_routes.update_one = AsyncMock(side_effect=_update)
    payload = ShowroomRoute(showroom_name="WRONG", twilio_number="+441474")
    with patch("routes.voice_showroom_routes.get_db", return_value=db):
        out = asyncio.run(upsert_route("Gravesend", payload, current_user=SUPER))
    assert out["showroom_name"] == "Gravesend"
    assert captured["filter"] == {"showroom_name": "Gravesend"}
    assert captured["doc"]["showroom_name"] == "Gravesend"


# ─── match_showroom_route_for_call ──────────────────────────────────
def test_match_returns_none_when_no_route():
    from routes.voice_showroom_routes import match_showroom_route_for_call
    db = MagicMock()
    db.voice_showroom_routes = MagicMock()
    db.voice_showroom_routes.find_one = AsyncMock(return_value=None)
    with patch("routes.voice_showroom_routes.get_db", return_value=db):
        out = asyncio.run(match_showroom_route_for_call("+441474000001"))
    assert out is None


def test_match_returns_route_and_resolves_placeholders():
    from routes.voice_showroom_routes import match_showroom_route_for_call
    db = MagicMock()
    db.voice_showroom_routes = MagicMock()
    db.voice_showroom_routes.find_one = AsyncMock(return_value={
        "showroom_name": "Gravesend",
        "twilio_number": "+441474000001",
        "welcome_message_text": "Welcome to Tile Station, {showroom_name} showroom.",
        "use_showroom_hours": False,
    })
    db.showrooms = MagicMock()
    db.showrooms.find_one = AsyncMock(return_value={
        "name": "Gravesend",
        "opening_hours": {"monday": "8:00 - 18:00"},
    })
    with patch("routes.voice_showroom_routes.get_db", return_value=db):
        out = asyncio.run(match_showroom_route_for_call("+441474000001"))
    assert out is not None
    assert "{showroom_name}" not in out["welcome_message_text"]
    assert "Gravesend showroom" in out["welcome_message_text"]


def test_match_attaches_resolved_hours_when_use_showroom_hours_true():
    from routes.voice_showroom_routes import match_showroom_route_for_call
    db = MagicMock()
    db.voice_showroom_routes = MagicMock()
    db.voice_showroom_routes.find_one = AsyncMock(return_value={
        "showroom_name": "Gravesend",
        "twilio_number": "+441474000001",
        "use_showroom_hours": True,
        "welcome_message_text": "",
    })
    db.showrooms = MagicMock()
    db.showrooms.find_one = AsyncMock(return_value={
        "opening_hours": {"monday": "8:00 - 18:00", "sunday": "10 - 16"},
    })
    with patch("routes.voice_showroom_routes.get_db", return_value=db):
        out = asyncio.run(match_showroom_route_for_call("+441474000001"))
    assert out["_resolved_opening_hours"]["monday"] == "8:00 - 18:00"


# ─── Delete endpoint ────────────────────────────────────────────────
def test_delete_route_requires_super_admin():
    from routes.voice_showroom_routes import delete_route
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc:
        asyncio.run(delete_route("Gravesend", current_user=HR))
    assert exc.value.status_code == 403


def test_delete_route_returns_deletion_count():
    from routes.voice_showroom_routes import delete_route
    db = MagicMock()
    db.voice_showroom_routes = MagicMock()
    delete_result = MagicMock()
    delete_result.deleted_count = 1
    db.voice_showroom_routes.delete_one = AsyncMock(return_value=delete_result)
    with patch("routes.voice_showroom_routes.get_db", return_value=db):
        out = asyncio.run(delete_route("Gravesend", current_user=SUPER))
    assert out == {"deleted": 1}


# ─── Integration: voice_incoming applies the per-showroom overrides ─
def _build_voice_db(showroom_route=None):
    """Mock DB used by routes.voice.voice_incoming."""
    db = MagicMock()
    db.voice_settings = MagicMock()
    db.voice_settings.find_one = AsyncMock(return_value={
        "id": "default", "enabled": True,
        "welcome_message_text": "Global welcome",
        "divert_mobile_number": "+447000000000",  # global fallback
        "twilio_phone_number": "+441000000000",
        "ads_source": "none", "max_hold_ads": 0,
        "recording_enabled": True, "ring_timeout_seconds": 25,
        "business_hours_enabled": False,
        "inbound_call_telegram_alerts": False,
    })
    db.voice_calls = MagicMock()
    db.voice_calls.insert_one = AsyncMock()
    db.radio_ads = MagicMock()
    db.radio_ads.find = MagicMock(return_value=_Cursor([]))
    db.voice_showroom_routes = MagicMock()
    db.voice_showroom_routes.find_one = AsyncMock(return_value=showroom_route)
    db.showrooms = MagicMock()
    db.showrooms.find_one = AsyncMock(return_value=None)
    return db


def _mock_request(form_data):
    req = MagicMock()
    req.url = MagicMock(scheme="https", path="/api/voice/incoming", netloc="x.com")
    req.headers = {}
    async def _form():
        return form_data
    req.form = _form
    return req


def test_incoming_falls_back_to_global_settings_when_no_route():
    from routes.voice import voice_incoming
    db = _build_voice_db(showroom_route=None)
    req = _mock_request({"From": "+447", "CallSid": "CAX", "To": "+449999999999"})
    with patch("routes.voice.get_db", return_value=db), \
         patch("routes.voice_showroom_routes.get_db", return_value=db), \
         patch("services.voice_customer_match.match_caller",
               AsyncMock(return_value={"matched": False})):
        resp = asyncio.run(voice_incoming(req))
    body = resp.body.decode()
    # Used the global welcome + global divert mobile
    assert "Global welcome" in body
    assert "+447000000000" in body


def test_incoming_applies_per_showroom_route():
    from routes.voice import voice_incoming
    route = {
        "showroom_name": "Gravesend",
        "twilio_number": "+441474000001",
        "divert_mobile": "+447379562631",
        "welcome_message_text": "Welcome to Tile Station, Gravesend showroom.",
        "use_showroom_hours": False,
        "enabled": True,
    }
    db = _build_voice_db(showroom_route=route)
    req = _mock_request({"From": "+447", "CallSid": "CAY",
                          "To": "+441474000001"})
    with patch("routes.voice.get_db", return_value=db), \
         patch("routes.voice_showroom_routes.get_db", return_value=db), \
         patch("services.voice_customer_match.match_caller",
               AsyncMock(return_value={"matched": False})):
        resp = asyncio.run(voice_incoming(req))
    body = resp.body.decode()
    # Gravesend's welcome + Gravesend's mobile
    assert "Gravesend showroom" in body
    assert "+447379562631" in body
    # Global mobile NOT used
    assert "+447000000000" not in body


def test_incoming_uses_showroom_hours_when_route_says_so():
    """When `use_showroom_hours=True` + Gravesend is closed today, the
    closed message MUST be returned instead of dialling."""
    from routes.voice import voice_incoming
    route = {
        "showroom_name": "Gravesend",
        "twilio_number": "+441474000001",
        "divert_mobile": "+447379562631",
        "welcome_message_text": "Welcome to Gravesend.",
        "use_showroom_hours": True,
        "_resolved_opening_hours": {},  # NOTHING open → forces closed
        "enabled": True,
    }
    db = _build_voice_db(showroom_route=route)
    req = _mock_request({"From": "+447", "CallSid": "CAZ",
                          "To": "+441474000001"})
    with patch("routes.voice.get_db", return_value=db), \
         patch("routes.voice_showroom_routes.get_db", return_value=db), \
         patch("services.voice_customer_match.match_caller",
               AsyncMock(return_value={"matched": False})):
        resp = asyncio.run(voice_incoming(req))
    body = resp.body.decode()
    # No Dial — we're closed
    assert "<Dial" not in body
    assert "<Hangup/>" in body

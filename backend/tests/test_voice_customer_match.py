"""
Tests for voice customer auto-recognition (Feb 2026).
"""
import os
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture(autouse=True)
def _env():
    os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
    os.environ.setdefault("DB_NAME", "test_voice_match")


class _Cursor:
    def __init__(self, items): self.items = list(items)
    def sort(self, *a, **k): return self
    def limit(self, *a, **k): return self
    async def to_list(self, _n=None): return list(self.items)


# ─── Phone normalisation ─────────────────────────────────────────────
@pytest.mark.parametrize("inp,expected", [
    ("+447379562631", "7379562631"),
    ("07379562631",   "7379562631"),
    ("07379 562631",  "7379562631"),
    ("+44 7379 562631", "7379562631"),
    ("(+44) 7379 562631", "7379562631"),
    ("7379562631",    "7379562631"),
    ("",              ""),
    (None,            ""),
    ("not-a-phone",   ""),
])
def test_normalize_phone(inp, expected):
    from services.voice_customer_match import normalize_phone
    assert normalize_phone(inp) == expected


def test_phone_variants_covers_common_uk_shapes():
    from services.voice_customer_match import phone_variants
    variants = phone_variants("+447379562631")
    assert "+447379562631" in variants
    assert "07379562631" in variants
    assert "7379562631" in variants
    assert any(v.startswith("+44 ") for v in variants)
    assert any(v.startswith("07379 ") for v in variants)


def test_phone_variants_empty_for_blank():
    from services.voice_customer_match import phone_variants
    assert phone_variants("") == []
    assert phone_variants(None) == []


# ─── Matching against DB ─────────────────────────────────────────────
def _build_db_with_shop_orders(orders):
    db = MagicMock()
    db.shop_orders = MagicMock()
    db.shop_orders.find = MagicMock(return_value=_Cursor(orders))
    db.sample_orders = MagicMock()
    db.sample_orders.find_one = AsyncMock(return_value=None)
    db.users = MagicMock()
    db.users.find_one = AsyncMock(return_value=None)
    db.list_collection_names = AsyncMock(return_value=[])
    return db


def test_match_caller_returns_unmatched_for_unknown_number():
    from services.voice_customer_match import match_caller
    db = _build_db_with_shop_orders([])
    out = asyncio.run(match_caller(db, "+449999000000"))
    assert out["matched"] is False
    assert out["name"] is None
    assert out["last_order"] is None


def test_match_caller_finds_shop_orders_customer():
    from services.voice_customer_match import match_caller
    orders = [
        {"order_number": "TS-260616-30E725", "customer_name": "Carolina Santiago",
         "customer_email": "carolss.cs@gmail.com",
         "total": 834.63, "payment_status": "paid", "status": "processing",
         "created_at": "2026-06-16T14:04:00", "items": [{"x": 1}, {"y": 1}]},
        {"order_number": "TS-260101-AAA111", "customer_name": "Carolina Santiago",
         "total": 200.00, "payment_status": "paid",
         "created_at": "2026-01-01T10:00:00", "items": []},
    ]
    db = _build_db_with_shop_orders(orders)
    out = asyncio.run(match_caller(db, "+447379562631"))
    assert out["matched"] is True
    assert out["name"] == "Carolina Santiago"
    assert out["email"] == "carolss.cs@gmail.com"
    assert out["match_type"] == "shop_orders"
    assert out["order_count"] == 2
    # Lifetime value sums PAID orders only
    assert out["lifetime_value"] == 1034.63
    # Last order is the most recent (sorted desc by created_at by the find().sort())
    assert out["last_order"]["order_number"] == "TS-260616-30E725"
    assert out["last_order"]["items_count"] == 2


def test_match_caller_uses_phone_variants_in_query():
    """The Mongo query MUST include several phone shapes so we don't
    miss matches when the order was saved with `07...` vs the call
    arrives as `+447...`"""
    from services.voice_customer_match import match_caller
    db = _build_db_with_shop_orders([])
    asyncio.run(match_caller(db, "+447379562631"))
    args, _ = db.shop_orders.find.call_args
    query = args[0]
    assert "customer_phone" in query
    variants = query["customer_phone"]["$in"]
    assert "+447379562631" in variants
    assert "07379562631" in variants
    assert "7379562631" in variants


def test_match_caller_falls_back_to_sample_orders():
    from services.voice_customer_match import match_caller
    db = MagicMock()
    db.shop_orders = MagicMock()
    db.shop_orders.find = MagicMock(return_value=_Cursor([]))
    db.sample_orders = MagicMock()
    db.sample_orders.find_one = AsyncMock(return_value={
        "id": "samp-1", "customer_name": "John Test", "customer_email": "j@x.com",
        "created_at": "2026-05-01T00:00:00",
    })
    db.users = MagicMock()
    db.users.find_one = AsyncMock(return_value=None)
    db.list_collection_names = AsyncMock(return_value=[])
    out = asyncio.run(match_caller(db, "+447111000000"))
    assert out["matched"] is True
    assert out["match_type"] == "sample_order"
    assert out["name"] == "John Test"
    assert out["last_order"]["order_number"] == "samp-1"


def test_match_caller_falls_back_to_user_record():
    from services.voice_customer_match import match_caller
    db = MagicMock()
    db.shop_orders = MagicMock()
    db.shop_orders.find = MagicMock(return_value=_Cursor([]))
    db.sample_orders = MagicMock()
    db.sample_orders.find_one = AsyncMock(return_value=None)
    db.users = MagicMock()
    db.users.find_one = AsyncMock(return_value={
        "name": "Jane Returns", "email": "jane@x.com",
    })
    db.list_collection_names = AsyncMock(return_value=[])
    out = asyncio.run(match_caller(db, "+447333222111"))
    assert out["matched"] is True
    assert out["match_type"] == "user"
    assert out["name"] == "Jane Returns"


def test_match_caller_returns_unmatched_when_phone_is_empty():
    from services.voice_customer_match import match_caller
    db = _build_db_with_shop_orders([])
    out = asyncio.run(match_caller(db, ""))
    assert out["matched"] is False


# ─── Telegram summary formatting ─────────────────────────────────────
def test_telegram_summary_unknown_caller():
    from services.voice_customer_match import telegram_caller_summary
    out = telegram_caller_summary({"matched": False}, "+447999000000")
    assert "+447999000000" in out
    assert "unknown" in out.lower()


def test_telegram_summary_returning_customer_includes_ltv_and_last_order():
    from services.voice_customer_match import telegram_caller_summary
    match = {
        "matched": True, "name": "Carolina Santiago",
        "match_type": "shop_orders", "order_count": 3, "lifetime_value": 2100.00,
        "last_order": {"order_number": "TS-260616-30E725", "total": 834.63,
                       "status": "paid", "created_at": "2026-06-16T14:04:00"},
    }
    out = telegram_caller_summary(match, "+447379562631")
    assert "Carolina Santiago" in out
    assert "3 order(s)" in out
    assert "£2,100" in out
    assert "TS-260616-30E725" in out
    assert "£834.63" in out
    assert "2026-06-16" in out


def test_telegram_summary_handles_missing_last_order():
    """Match exists (e.g. via users collection) but no last_order row."""
    from services.voice_customer_match import telegram_caller_summary
    match = {"matched": True, "name": "Jane", "match_type": "user"}
    out = telegram_caller_summary(match, "+447")
    assert "Jane" in out
    # Doesn't crash even with no last_order
    assert "+447" in out


# ─── Live endpoint /admin/voice/incoming-now ─────────────────────────
ADMIN = {"role": "super_admin", "id": "u-su", "email": "su@x.com"}
STAFF = {"role": "staff", "id": "u-st", "email": "st@x.com"}


def test_incoming_now_returns_only_ringing_inbound_within_window():
    from routes.voice import admin_incoming_now
    db = MagicMock()
    db.voice_calls = MagicMock()
    db.voice_calls.find = MagicMock(return_value=_Cursor([
        {"id": "c1", "direction": "inbound", "status": "ringing",
         "from_number": "+447379562631",
         "customer_match": {"matched": True, "name": "Carolina"}},
    ]))
    with patch("routes.voice.get_db", return_value=db):
        out = asyncio.run(admin_incoming_now(current_user=ADMIN))
    assert "calls" in out
    assert len(out["calls"]) == 1
    assert out["calls"][0]["customer_match"]["name"] == "Carolina"
    # Verify the query restricts to direction+status+90s window
    args, _ = db.voice_calls.find.call_args
    q = args[0]
    assert q["direction"] == "inbound"
    assert q["status"] == "ringing"
    assert "started_at" in q


def test_incoming_now_rejects_non_admin():
    from routes.voice import admin_incoming_now
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc:
        asyncio.run(admin_incoming_now(current_user=STAFF))
    assert exc.value.status_code == 403


# ─── voice_incoming stores customer_match on the call row ───────────
def test_incoming_persists_customer_match_on_call_row():
    """When the matcher returns a hit, the pre-logged call row MUST
    carry the customer_match dict so the screen pop-up can show it."""
    from routes.voice import voice_incoming
    db = MagicMock()
    db.voice_settings = MagicMock()
    db.voice_settings.find_one = AsyncMock(return_value={
        "id": "default", "enabled": True,
        "welcome_message_text": "Welcome",
        "divert_mobile_number": "+447",
        "ads_source": "none", "max_hold_ads": 0,
        "recording_enabled": False, "ring_timeout_seconds": 25,
        "business_hours_enabled": False,
        "inbound_call_telegram_alerts": False,
    })
    db.voice_calls = MagicMock()
    db.voice_calls.insert_one = AsyncMock()

    req = MagicMock()
    req.url = MagicMock(scheme="https", path="/api/voice/incoming", netloc="x.com")
    req.headers = {}
    async def _form():
        return {"From": "+447379562631", "CallSid": "CAtestX", "To": "+441"}
    req.form = _form

    expected_match = {"matched": True, "name": "Carolina Santiago",
                      "match_type": "shop_orders", "order_count": 2,
                      "lifetime_value": 1034.63}

    with patch("routes.voice.get_db", return_value=db), \
         patch("services.voice_customer_match.match_caller",
               AsyncMock(return_value=expected_match)):
        asyncio.run(voice_incoming(req))

    insert_args = db.voice_calls.insert_one.await_args[0][0]
    assert insert_args["customer_match"] == expected_match
    assert insert_args["from_number"] == "+447379562631"

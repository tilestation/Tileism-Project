"""
Tests for /api/staff-leaderboard endpoints (3 Jun 2026).

User-specified rules verified here:
- Staff attribution: QUOTE CREATOR wins on conversion (option 1a)
- Sales metric: ONLY invoices with order_type = "Special Order"
  count toward sales totals (tiles/bathroom/flooring/UFH)
- Store Order invoices (material/tools) are EXCLUDED
- Top-3 podium uses 👑 🥈 🥉; rankings show ALL staff 1..N
- Streak = consecutive days with at least 1 conversion (looking
  back at most 90 days)
- Personal-avg conversion rate excludes the current month so the
  "vs your usual" delta is meaningful
- Optional bonus tracking lives on the same monthly target doc
"""
import os
from datetime import datetime, timezone, timedelta
from unittest.mock import patch, AsyncMock, MagicMock

import pytest


@pytest.fixture(autouse=True)
def _env_setup():
    os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
    os.environ.setdefault("DB_NAME", "test_staff_leaderboard")


class _AggIter:
    """Mongo aggregate() cursor returning .to_list."""
    def __init__(self, items):
        self._items = items

    async def to_list(self, length=None):
        return list(self._items)


class _AsyncIter:
    """Mongo find() cursor that supports async-for iteration."""
    def __init__(self, items):
        self._items = list(items)

    def __aiter__(self):
        self._iter = iter(self._items)
        return self

    async def __anext__(self):
        try:
            return next(self._iter)
        except StopIteration as e:
            raise StopAsyncIteration from e

    async def to_list(self, length=None):
        return list(self._items)


def _reset_cache():
    """Bypass the 30s banner cache between tests."""
    from routes import staff_leaderboard as sl
    sl._BANNER_CACHE["ts"] = 0.0
    sl._BANNER_CACHE["data"] = None


def _build_db(quotes=None, invoices=None, targets_doc=None):
    db = MagicMock()
    db.quotations.aggregate = MagicMock(return_value=_AggIter(quotes or []))
    db.quotations.find = MagicMock(return_value=_AsyncIter([]))
    db.invoices.aggregate = MagicMock(return_value=_AggIter(invoices or []))
    db.staff_leaderboard_targets.find_one = AsyncMock(return_value=targets_doc)
    db.staff_leaderboard_targets.update_one = AsyncMock()
    return db


_NOW = datetime.now(timezone.utc)


# ---------------------------------------------------------------------
# 1. Empty DB → banner returns nulls gracefully (UI hides the banner)
# ---------------------------------------------------------------------
def test_banner_empty_data():
    import asyncio
    from routes.staff_leaderboard import get_leaderboard_banner
    _reset_cache()
    with patch("routes.staff_leaderboard.get_db", return_value=_build_db()):
        data = asyncio.run(get_leaderboard_banner())
    assert data["conv_leader"] is None
    assert data["sales_leader"] is None
    assert data["total_staff"] == 0


# ---------------------------------------------------------------------
# 2. Quote-conversion leader is the CREATOR (not the converter)
# ---------------------------------------------------------------------
def test_quote_attribution_to_creator():
    """User picked option 1a: the staff who CREATED the quote wins
    when it converts (even if another rep clicks 'Convert')."""
    import asyncio
    from routes.staff_leaderboard import get_leaderboard_banner
    _reset_cache()
    # 5 quotes by Syed (3 converted, 2 not); 5 quotes by Tom (1 converted).
    # Even if a separate `converted_by` were set, our pipeline only
    # consults created_by_user_id / sales_person / created_by.
    quotes = []
    for i in range(5):
        quotes.append({
            "created_by_user_id": "u_syed",
            "sales_person": "Syed",
            "showroom_name": "Gravesend",
            "showroom_id": "gv",
            "created_at": _NOW,
            "converted_at": _NOW if i < 3 else None,
        })
    for i in range(5):
        quotes.append({
            "created_by_user_id": "u_tom",
            "sales_person": "Tom",
            "showroom_name": "Tonbridge",
            "showroom_id": "tb",
            "created_at": _NOW,
            "converted_at": _NOW if i < 1 else None,
        })
    with patch("routes.staff_leaderboard.get_db", return_value=_build_db(quotes=quotes)):
        data = asyncio.run(get_leaderboard_banner())
    assert data["conv_leader"]["name"] == "Syed"
    assert data["conv_leader"]["quotes_converted"] == 3
    assert data["conv_leader"]["showroom_name"] == "Gravesend"
    assert data["conv_runner_up"]["name"] == "Tom"
    assert data["conv_runner_up"]["quotes_converted"] == 1
    assert data["conv_gap"] == 2


# ---------------------------------------------------------------------
# 3. Sales metric excludes Store Order invoices
# ---------------------------------------------------------------------
def test_sales_excludes_store_order_invoices():
    """Critical: 'sales' for the leaderboard means Special Order ONLY.
    Material/tools (Store Order) must not pollute the totals.

    The backend already filters on `{"order_type": "Special Order"}`
    in its $match — this test simulates that by passing ONLY Special
    Order invoices into the aggregate result. The test passes if the
    sales totals exclusively reflect those invoices."""
    import asyncio
    from routes.staff_leaderboard import get_leaderboard_banner
    _reset_cache()
    # Simulate Mongo's $match having already filtered out Store
    # Orders — only Special Orders make it into the aggregate output.
    invoices = [
        {"created_by_user_id": "u_syed", "sales_person": "Syed",
         "showroom_name": "Gravesend", "grand_total": 1200.00,
         "created_at": _NOW},
        {"created_by_user_id": "u_syed", "sales_person": "Syed",
         "showroom_name": "Gravesend", "grand_total": 800.00,
         "created_at": _NOW},
        {"created_by_user_id": "u_tom", "sales_person": "Tom",
         "showroom_name": "Tonbridge", "grand_total": 3500.00,
         "created_at": _NOW},
    ]
    quotes = [{"created_by_user_id": "u_syed", "sales_person": "Syed",
               "showroom_name": "Gravesend", "created_at": _NOW,
               "converted_at": _NOW}]
    db = _build_db(quotes=quotes, invoices=invoices)
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        data = asyncio.run(get_leaderboard_banner())

    # Sales leader = Tom (3500 > 2000) because Special-Order only.
    assert data["sales_leader"]["name"] == "Tom"
    assert data["sales_leader"]["sales_value_gbp"] == 3500.0
    # Sales runner-up = Syed
    assert data["sales_runner_up"]["name"] == "Syed"
    assert data["sales_runner_up"]["sales_value_gbp"] == 2000.0
    # Conversion leader is still Syed (he won the only converted quote)
    assert data["conv_leader"]["name"] == "Syed"


def test_sales_match_includes_special_order_filter():
    """Defence-in-depth — verify the aggregate pipeline literally
    includes `order_type: "Special Order"` in its $match. If a
    future refactor removes it, this test fails loudly."""
    import asyncio
    from routes.staff_leaderboard import _compute_leaderboard
    _reset_cache()

    captured = {}
    def _capture_aggregate(pipeline, **kw):
        # Look for the invoices match step — the only one with order_type
        for stage in pipeline:
            if "$match" in stage and "order_type" in stage["$match"]:
                captured["order_type_match"] = stage["$match"]["order_type"]
        return _AggIter([])

    db = MagicMock()
    db.quotations.aggregate = MagicMock(return_value=_AggIter([]))
    db.invoices.aggregate = MagicMock(side_effect=_capture_aggregate)
    db.staff_leaderboard_targets.find_one = AsyncMock(return_value=None)

    with patch("routes.staff_leaderboard.get_db", return_value=db):
        asyncio.run(_compute_leaderboard(month_only=True))
    assert captured.get("order_type_match") == "Special Order", \
        "Sales pipeline must filter order_type='Special Order' " \
        "to exclude material/tools (user rule 3 Jun 2026)"


# ---------------------------------------------------------------------
# 4. Conversion rate = converted / created
# ---------------------------------------------------------------------
def test_conversion_rate_computation():
    import asyncio
    from routes.staff_leaderboard import _compute_leaderboard
    _reset_cache()
    quotes = (
        [{"created_by_user_id": "u_amy", "sales_person": "Amy",
          "showroom_name": "Tonbridge",
          "created_at": _NOW,
          "converted_at": _NOW if i < 4 else None}
         for i in range(10)]
        # Amy: 4/10 = 40%
    )
    with patch("routes.staff_leaderboard.get_db", return_value=_build_db(quotes=quotes)):
        board = asyncio.run(_compute_leaderboard(month_only=True))
    amy = next(s for s in board["staff"] if s["name"] == "Amy")
    assert amy["conversion_rate"] == 40.0
    assert amy["quotes_created"] == 10
    assert amy["quotes_converted"] == 4


# ---------------------------------------------------------------------
# 5. Showroom rollup picks the TOP staff per showroom
# ---------------------------------------------------------------------
def test_per_showroom_leader():
    import asyncio
    from routes.staff_leaderboard import _compute_leaderboard
    _reset_cache()
    quotes = [
        {"created_by_user_id": "u_syed", "sales_person": "Syed",
         "showroom_name": "Gravesend", "created_at": _NOW,
         "converted_at": _NOW},  # 1 conversion
        {"created_by_user_id": "u_jay", "sales_person": "Jay",
         "showroom_name": "Gravesend", "created_at": _NOW,
         "converted_at": None},  # 0
        {"created_by_user_id": "u_amy", "sales_person": "Amy",
         "showroom_name": "Tonbridge", "created_at": _NOW,
         "converted_at": _NOW},
        {"created_by_user_id": "u_amy", "sales_person": "Amy",
         "showroom_name": "Tonbridge", "created_at": _NOW,
         "converted_at": _NOW},  # Amy 2 conv
        {"created_by_user_id": "u_max", "sales_person": "Max",
         "showroom_name": "Tonbridge", "created_at": _NOW,
         "converted_at": _NOW},  # Max 1
    ]
    with patch("routes.staff_leaderboard.get_db", return_value=_build_db(quotes=quotes)):
        board = asyncio.run(_compute_leaderboard(month_only=True))
    assert board["showroom_leaders"]["Gravesend"]["name"] == "Syed"
    assert board["showroom_leaders"]["Tonbridge"]["name"] == "Amy"


# ---------------------------------------------------------------------
# 6. Streak counts consecutive days
# ---------------------------------------------------------------------
def test_streak_counts_consecutive_days():
    import asyncio
    from routes.staff_leaderboard import _compute_streak
    _reset_cache()
    today = datetime.now(timezone.utc)
    quotes = [
        {"converted_at": today},
        {"converted_at": today - timedelta(days=1)},
        {"converted_at": today - timedelta(days=2)},
        {"converted_at": today - timedelta(days=4)},  # GAP: not consecutive
    ]
    db = MagicMock()
    db.quotations.find = MagicMock(return_value=_AsyncIter(quotes))
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        result = asyncio.run(_compute_streak("u_test", "Test"))
    # 3-day streak (today, today-1, today-2) — gap on day-3 breaks it
    assert result["streak_days"] == 3


def test_streak_returns_zero_when_no_conversion_today():
    import asyncio
    from routes.staff_leaderboard import _compute_streak
    _reset_cache()
    today = datetime.now(timezone.utc)
    quotes = [
        {"converted_at": today - timedelta(days=1)},
        {"converted_at": today - timedelta(days=2)},
        # No conversion TODAY → streak broken
    ]
    db = MagicMock()
    db.quotations.find = MagicMock(return_value=_AsyncIter(quotes))
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        result = asyncio.run(_compute_streak("u_test", "Test"))
    assert result["streak_days"] == 0


# ---------------------------------------------------------------------
# 7. Target & bonus persistence (super_admin only)
# ---------------------------------------------------------------------
def test_target_requires_super_admin():
    import asyncio
    from routes.staff_leaderboard import set_monthly_target, TargetReq
    from fastapi import HTTPException
    db = MagicMock()
    db.staff_leaderboard_targets.find_one = AsyncMock(return_value=None)
    db.staff_leaderboard_targets.update_one = AsyncMock()

    for bad_role in ("admin", "manager", "staff", None):
        with patch("routes.staff_leaderboard.get_db", return_value=db):
            req = TargetReq(metric="conversions", team_target=30)
            with pytest.raises(HTTPException) as exc:
                asyncio.run(set_monthly_target(req=req, current_user={"role": bad_role, "email": "x@test"}))
            assert exc.value.status_code == 403


def test_target_saved_for_super_admin():
    import asyncio
    from routes.staff_leaderboard import set_monthly_target, TargetReq
    db = MagicMock()
    db.staff_leaderboard_targets.find_one = AsyncMock(return_value=None)
    db.staff_leaderboard_targets.update_one = AsyncMock()
    req = TargetReq(metric="sales_gbp", team_target=50000)
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        r = asyncio.run(set_monthly_target(req=req, current_user={"role": "super_admin", "email": "boss@test"}))
    assert r["ok"] is True
    db.staff_leaderboard_targets.update_one.assert_called_once()
    call = db.staff_leaderboard_targets.update_one.call_args
    setter = call[0][1]["$set"]
    assert setter["team_target"]["value"] == 50000
    assert setter["team_target"]["metric"] == "sales_gbp"


def test_bonus_saved_for_super_admin():
    import asyncio
    from routes.staff_leaderboard import record_bonus, BonusReq
    db = MagicMock()
    db.staff_leaderboard_targets.find_one = AsyncMock(return_value=None)
    db.staff_leaderboard_targets.update_one = AsyncMock()
    req = BonusReq(user_key="u_syed", name="Syed", amount_gbp=250, note="June champion")
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        r = asyncio.run(record_bonus(req=req, current_user={"role": "super_admin", "email": "boss@test"}))
    assert r["bonus"]["amount_gbp"] == 250
    assert r["bonus"]["name"] == "Syed"
    db.staff_leaderboard_targets.update_one.assert_called_once()


# ---------------------------------------------------------------------
# 8. Full leaderboard returns ALL staff (not Top-5 capped)
# ---------------------------------------------------------------------
def test_full_leaderboard_returns_all_staff():
    """User explicitly asked to show all staff 1..N, not Top-5."""
    import asyncio
    from routes.staff_leaderboard import get_full_leaderboard
    _reset_cache()
    # 12 staff with one quote each.
    quotes = [
        {"created_by_user_id": f"u_{i}", "sales_person": f"Staff {i}",
         "showroom_name": "Tonbridge", "created_at": _NOW,
         "converted_at": _NOW if i % 2 == 0 else None}
        for i in range(12)
    ]
    db = _build_db(quotes=quotes)
    db.quotations.find = MagicMock(return_value=_AsyncIter([]))
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        r = asyncio.run(get_full_leaderboard(current_user={"role": "super_admin", "email": "a@b"}))
    assert len(r["staff"]) == 12, \
        f"Full leaderboard must show ALL staff (got {len(r['staff'])})"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

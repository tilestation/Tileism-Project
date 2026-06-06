"""
Tests for the Staff Competition dashboard endpoints (3 Jun 2026):
- GET /api/staff-leaderboard/competition (multi-section payload)
- GET /api/staff-leaderboard/hall-of-fame (past-month archive)
- POST /api/staff-leaderboard/highlight (manual broadcast)
- snapshot_previous_month() (month-end Hall-of-Fame snapshot)
"""
import os
from datetime import datetime, timezone, timedelta
from unittest.mock import patch, AsyncMock, MagicMock

import pytest


@pytest.fixture(autouse=True)
def _env_setup():
    os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
    os.environ.setdefault("DB_NAME", "test_staff_competition")


class _AggIter:
    def __init__(self, items): self._items = items
    async def to_list(self, length=None): return list(self._items)


class _AsyncIter:
    def __init__(self, items): self._items = list(items)
    def __aiter__(self): self._iter = iter(self._items); return self
    async def __anext__(self):
        try: return next(self._iter)
        except StopIteration as e: raise StopAsyncIteration from e
    def sort(self, *a, **kw): return self
    def limit(self, *a, **kw): return self
    async def to_list(self, length=None): return list(self._items)


def _reset_cache():
    from routes import staff_leaderboard as sl
    sl._BANNER_CACHE["ts"] = 0.0
    sl._BANNER_CACHE["data"] = None


_NOW = datetime.now(timezone.utc)


def _db(quotes=None, invoices=None, hof_docs=None, highlight=None, target_doc=None, users=None, showrooms=None):
    db = MagicMock()
    db.quotations.aggregate = MagicMock(return_value=_AggIter(quotes or []))
    db.quotations.find = MagicMock(return_value=_AsyncIter([]))
    db.invoices.aggregate = MagicMock(return_value=_AggIter(invoices or []))
    db.staff_leaderboard_targets.find_one = AsyncMock(return_value=target_doc)
    db.staff_leaderboard_targets.update_one = AsyncMock()
    db.staff_leaderboard_history.find = MagicMock(return_value=_AsyncIter(hof_docs or []))
    db.staff_leaderboard_history.find_one = AsyncMock(return_value=None)
    db.staff_leaderboard_history.update_one = AsyncMock()
    db.staff_highlight_broadcasts.find_one = AsyncMock(return_value=highlight)
    db.staff_highlight_broadcasts.update_one = AsyncMock()
    db.staff_highlight_broadcasts.delete_many = AsyncMock()
    # 4 Jun 2026 — leaderboard resolves missing showroom_name via the
    # users + showrooms collections; tests without staff still need
    # these stubbed to avoid `MagicMock can't be used in 'await'`.
    db.users.find = MagicMock(return_value=_AsyncIter(users or []))
    db.users.find_one = AsyncMock(return_value=None)
    db.showrooms.find = MagicMock(return_value=_AsyncIter(showrooms or []))
    return db


# ---------------------------------------------------------------------
# 1. /competition returns all sections, even with no data
# ---------------------------------------------------------------------
def test_competition_empty_returns_all_sections():
    """Even with no activity, the response must contain every section
    key so the dashboard renders the empty-states gracefully."""
    import asyncio
    from routes.staff_leaderboard import get_competition_dashboard
    _reset_cache()
    user = {"role": "super_admin", "email": "a@b"}
    with patch("routes.staff_leaderboard.get_db", return_value=_db()):
        r = asyncio.run(get_competition_dashboard(current_user=user))
    for key in (
        "month", "days_elapsed", "days_total", "days_left",
        "champion", "target", "progress", "head_to_head",
        "showrooms", "showroom_winners", "active_streaks",
        "personal_best_chasers", "comebacks", "active_highlight",
    ):
        assert key in r, f"Section '{key}' missing from response"


# ---------------------------------------------------------------------
# 2. Champion is correctly identified
# ---------------------------------------------------------------------
def test_competition_identifies_champion():
    import asyncio
    from routes.staff_leaderboard import get_competition_dashboard
    _reset_cache()
    quotes = (
        [{"created_by_user_id": "u_syed", "sales_person": "Syed",
          "showroom_name": "Gravesend", "created_at": _NOW,
          "converted_at": _NOW if i < 5 else None} for i in range(8)]
        + [{"created_by_user_id": "u_tom", "sales_person": "Tom",
            "showroom_name": "Tonbridge", "created_at": _NOW,
            "converted_at": _NOW if i < 2 else None} for i in range(4)]
    )
    user = {"role": "super_admin", "email": "a@b"}
    with patch("routes.staff_leaderboard.get_db", return_value=_db(quotes=quotes)):
        r = asyncio.run(get_competition_dashboard(current_user=user))
    assert r["champion"]["name"] == "Syed"
    assert r["champion"]["quotes_converted"] == 5
    assert len(r["head_to_head"]) == 2


# ---------------------------------------------------------------------
# 3. Race-to-target projection
# ---------------------------------------------------------------------
def test_competition_projection_at_pace():
    """Linear projection: if Syed has 5 conversions on day 10 of a
    30-day month, projected EOM = 5 * 30/10 = 15."""
    import asyncio
    from routes.staff_leaderboard import get_competition_dashboard

    # 30-day month — pick a fixed test date that's definitely day 10
    _reset_cache()
    quotes = [
        {"created_by_user_id": "u_syed", "sales_person": "Syed",
         "showroom_name": "Gravesend", "created_at": _NOW,
         "converted_at": _NOW if i < 5 else None}
        for i in range(5)
    ]
    target_doc = {"month": "_", "team_target": {"metric": "conversions", "value": 20}}
    user = {"role": "super_admin", "email": "a@b"}
    db = _db(quotes=quotes, target_doc=target_doc)
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        r = asyncio.run(get_competition_dashboard(current_user=user))
    assert len(r["progress"]) == 1
    p = r["progress"][0]
    # current=5, days_elapsed = today's day-of-month (varies); we
    # don't pin a specific projection because that depends on real
    # clock. Assert the fields exist and are sane.
    assert p["current"] == 5
    assert p["target"] == 20
    assert p["pct"] == 25.0
    assert "projected_eom" in p


# ---------------------------------------------------------------------
# 3b. Sales leaderboard works WITHOUT a team target (6 Jun 2026)
# User report: "Sales leaderboard is not working. There are plenty
# invoices saved under Special Order. But none showing." Banner +
# head-to-head card showed Syed's £9,607 sales but the Sales table
# was empty. Root cause: the table read `data.progress`, which is
# only populated when a team target is set. Fix: response now also
# exposes `staff` containing the FULL decorated list regardless of
# target state.
# ---------------------------------------------------------------------
def test_competition_exposes_full_staff_list_without_target():
    """Even when there's NO team_target set, the response must
    expose `staff` so the Sales / Conversion leaderboards can render."""
    import asyncio
    from routes.staff_leaderboard import get_competition_dashboard
    _reset_cache()
    quotes = [
        {"created_by_user_id": "u_syed", "sales_person": "Syed",
         "showroom_name": "Gravesend", "created_at": _NOW,
         "converted_at": _NOW if i < 4 else None}
        for i in range(6)
    ]
    invoices = [
        {"created_by_user_id": "u_syed", "sales_person": "Syed",
         "order_type": "Special Order", "gross_total": 9607.50,
         "created_at": _NOW},
    ]
    user = {"role": "super_admin", "email": "a@b"}
    # NO target_doc passed — this is the real-world case the bug hit
    db = _db(quotes=quotes, invoices=invoices, target_doc=None)
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        r = asyncio.run(get_competition_dashboard(current_user=user))

    # `staff` MUST be populated even without a target
    assert "staff" in r, "Response must expose `staff` field"
    assert len(r["staff"]) >= 1, "staff list must include the user with sales"
    syed = next((s for s in r["staff"] if s["name"] == "Syed"), None)
    assert syed is not None, f"Syed not in staff list — got {[s['name'] for s in r['staff']]}"
    # The sales £ MUST be visible in the staff row (the whole point
    # of this fix — the bug was the table showed £0).
    assert syed["sales_value_gbp"] == 9607.50
    assert syed["quotes_converted"] == 4
    # `progress` should still be empty when there's no target (correct
    # historical behaviour — that's NOT the bug).
    assert r.get("progress") == []


def test_competition_staff_list_populated_when_target_is_set_too():
    """When a target IS set, the response continues to expose
    `progress` (for the race-to-target card) AND `staff` (for the
    leaderboard tables). They overlap but serve different sections."""
    import asyncio
    from routes.staff_leaderboard import get_competition_dashboard
    _reset_cache()
    invoices = [
        {"created_by_user_id": "u_syed", "sales_person": "Syed",
         "order_type": "Special Order", "gross_total": 1000.0,
         "created_at": _NOW},
        {"created_by_user_id": "u_amy", "sales_person": "Amy",
         "order_type": "Special Order", "gross_total": 800.0,
         "created_at": _NOW},
    ]
    target_doc = {"month": "_", "team_target": {"metric": "sales_gbp", "value": 5000}}
    user = {"role": "super_admin", "email": "a@b"}
    db = _db(invoices=invoices, target_doc=target_doc)
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        r = asyncio.run(get_competition_dashboard(current_user=user))

    # Both arrays must be populated
    assert len(r["staff"]) == 2
    assert len(r["progress"]) == 2
    # Both list the same staff (same source data)
    staff_names = {s["name"] for s in r["staff"]}
    progress_names = {p["name"] for p in r["progress"]}
    assert staff_names == progress_names == {"Syed", "Amy"}


# ---------------------------------------------------------------------
# 4. Showroom totals + winners
# ---------------------------------------------------------------------
def test_showroom_vs_showroom_winners():
    import asyncio
    from routes.staff_leaderboard import get_competition_dashboard
    _reset_cache()
    quotes = [
        {"created_by_user_id": "u_a", "sales_person": "A",
         "showroom_name": "Gravesend", "created_at": _NOW,
         "converted_at": _NOW},
        {"created_by_user_id": "u_b", "sales_person": "B",
         "showroom_name": "Gravesend", "created_at": _NOW,
         "converted_at": _NOW},
        {"created_by_user_id": "u_c", "sales_person": "C",
         "showroom_name": "Tonbridge", "created_at": _NOW,
         "converted_at": _NOW},
    ]
    invoices = [
        {"created_by_user_id": "u_c", "sales_person": "C",
         "showroom_name": "Tonbridge", "grand_total": 25000,
         "created_at": _NOW},  # Tonbridge has more £
    ]
    user = {"role": "super_admin", "email": "a@b"}
    with patch("routes.staff_leaderboard.get_db", return_value=_db(quotes=quotes, invoices=invoices)):
        r = asyncio.run(get_competition_dashboard(current_user=user))
    assert r["showroom_winners"]["conversions"]["showroom_name"] == "Gravesend"
    assert r["showroom_winners"]["sales_gbp"]["showroom_name"] == "Tonbridge"


# ---------------------------------------------------------------------
# 5. Active highlight surfaces in /competition and banner
# ---------------------------------------------------------------------
def test_active_highlight_surfaces_in_competition():
    import asyncio
    from routes.staff_leaderboard import get_competition_dashboard
    _reset_cache()
    highlight = {
        "name": "Maria",
        "message": "just closed her biggest quote ever — £18,420!",
        "expires_at": (datetime.now(timezone.utc) + timedelta(hours=20)).isoformat(),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    user = {"role": "super_admin", "email": "a@b"}
    with patch("routes.staff_leaderboard.get_db", return_value=_db(highlight=highlight)):
        r = asyncio.run(get_competition_dashboard(current_user=user))
    assert r["active_highlight"] is not None
    assert r["active_highlight"]["name"] == "Maria"


def test_highlight_appears_in_banner_payload():
    import asyncio
    from routes.staff_leaderboard import get_leaderboard_banner
    _reset_cache()
    highlight = {
        "name": "Maria",
        "message": "just closed her biggest quote ever",
        "expires_at": (datetime.now(timezone.utc) + timedelta(hours=20)).isoformat(),
        "showroom_name": "Tonbridge",
    }
    with patch("routes.staff_leaderboard.get_db", return_value=_db(highlight=highlight)):
        r = asyncio.run(get_leaderboard_banner())
    assert "highlight" in r
    assert r["highlight"]["name"] == "Maria"


# ---------------------------------------------------------------------
# 6. Highlight requires super_admin; replaces previous broadcast
# ---------------------------------------------------------------------
def test_highlight_requires_super_admin():
    import asyncio
    from routes.staff_leaderboard import broadcast_highlight, HighlightReq
    from fastapi import HTTPException
    db = _db()
    req = HighlightReq(name="Maria", message="great work today!")
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        for bad_role in ("admin", "manager", "staff", None):
            with pytest.raises(HTTPException) as exc:
                asyncio.run(broadcast_highlight(req=req, current_user={"role": bad_role, "email": "x@y"}))
            assert exc.value.status_code == 403


def test_highlight_saves_for_super_admin():
    import asyncio
    from routes.staff_leaderboard import broadcast_highlight, HighlightReq
    db = _db()
    req = HighlightReq(name="Maria", message="🎉 huge sale", duration_hours=48)
    user = {"role": "super_admin", "email": "boss@test"}
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        r = asyncio.run(broadcast_highlight(req=req, current_user=user))
    assert r["ok"] is True
    db.staff_highlight_broadcasts.update_one.assert_called_once()


# ---------------------------------------------------------------------
# 7. Snapshot of previous month
# ---------------------------------------------------------------------
def test_snapshot_no_activity_returns_noop():
    import asyncio
    from routes.staff_leaderboard import snapshot_previous_month
    db = _db()  # No quotes or invoices last month
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        r = asyncio.run(snapshot_previous_month())
    assert r["ok"] is False
    assert r["reason"] == "no_activity"


def test_snapshot_captures_champion():
    import asyncio
    from routes.staff_leaderboard import snapshot_previous_month
    # Quotes/invoices dated in the previous month
    last_month = datetime.now(timezone.utc).replace(day=1) - timedelta(days=10)
    quotes = [
        {"created_by_user_id": "u_winner", "sales_person": "Winner",
         "showroom_name": "Gravesend",
         "converted_at": last_month, "converted_to_invoice_id": "inv-1"},
        {"created_by_user_id": "u_winner", "sales_person": "Winner",
         "showroom_name": "Gravesend",
         "converted_at": last_month, "converted_to_invoice_id": "inv-2"},
        {"created_by_user_id": "u_runnerup", "sales_person": "Runner Up",
         "showroom_name": "Tonbridge",
         "converted_at": last_month, "converted_to_invoice_id": "inv-3"},
    ]
    db = _db(quotes=quotes)
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        r = asyncio.run(snapshot_previous_month())
    assert r["ok"] is True
    db.staff_leaderboard_history.update_one.assert_called_once()
    snap_arg = db.staff_leaderboard_history.update_one.call_args[0][1]["$set"]
    assert snap_arg["champion"]["name"] == "Winner"
    assert snap_arg["champion"]["quotes_converted"] == 2


def test_snapshot_trigger_requires_super_admin():
    import asyncio
    from routes.staff_leaderboard import trigger_snapshot
    from fastapi import HTTPException
    with patch("routes.staff_leaderboard.get_db", return_value=_db()):
        for bad_role in ("admin", "manager", None):
            with pytest.raises(HTTPException) as exc:
                asyncio.run(trigger_snapshot(current_user={"role": bad_role, "email": "x@y"}))
            assert exc.value.status_code == 403


# ---------------------------------------------------------------------
# 8. Hall-of-Fame archive endpoint
# ---------------------------------------------------------------------
def test_hall_of_fame_returns_history():
    import asyncio
    from routes.staff_leaderboard import get_hall_of_fame
    snapshots = [
        {"month": "May 2026", "champion": {"name": "Maria", "showroom_name": "Tonbridge", "quotes_converted": 47, "conversion_rate": 73.0}},
        {"month": "April 2026", "champion": {"name": "Syed", "showroom_name": "Gravesend", "quotes_converted": 38, "conversion_rate": 64.5}},
    ]
    db = _db(hof_docs=snapshots)
    user = {"role": "super_admin", "email": "a@b"}
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        r = asyncio.run(get_hall_of_fame(limit=24, current_user=user))
    assert r["count"] == 2
    assert r["history"][0]["champion"]["name"] == "Maria"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

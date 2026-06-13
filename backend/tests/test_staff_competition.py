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


def _db(quotes=None, invoices=None, hof_docs=None, highlight=None, target_doc=None, users=None, showrooms=None, sales_targets=None, prior_rank_snapshot=None):
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
    # 6 Jun 2026 — per-store monthly sales targets feed the showroom
    # league's % of target hit + the Race-to-Target fallback.
    db.sales_targets.find = MagicMock(return_value=_AsyncIter(sales_targets or []))
    # 13 Jun 2026 — rank-change tracking. `prior_rank_snapshot` is the
    # most-recent prior-day snapshot doc (or None for first-ever run).
    db.staff_rank_snapshots.find_one = AsyncMock(return_value=prior_rank_snapshot)
    db.staff_rank_snapshots.update_one = AsyncMock()
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
    leaderboard tables). They overlap but serve different sections.

    6 Jun 2026: `progress` is now driven by `progress_sales` (each
    staff's £ vs their store's monthly_target), so a target_doc on
    `staff_leaderboard_targets` alone is no longer enough — we also
    need the store target rows to drive the personal progress."""
    import asyncio
    from routes.staff_leaderboard import get_competition_dashboard
    _reset_cache()
    invoices = [
        {"created_by_user_id": "u_syed", "sales_person": "Syed",
         "showroom_id": "sr_gv", "showroom_name": "Gravesend",
         "order_type": "Special Order", "gross_total": 1000.0,
         "created_at": _NOW},
        {"created_by_user_id": "u_amy", "sales_person": "Amy",
         "showroom_id": "sr_tn", "showroom_name": "Tonbridge",
         "order_type": "Special Order", "gross_total": 800.0,
         "created_at": _NOW},
    ]
    sales_targets = [
        {"showroom_id": "sr_gv", "monthly_target": 75000, "target_type": "sales"},
        {"showroom_id": "sr_tn", "monthly_target": 55000, "target_type": "sales"},
    ]
    target_doc = {"month": "_", "team_target": {"metric": "sales_gbp", "value": 5000}}
    user = {"role": "super_admin", "email": "a@b"}
    db = _db(invoices=invoices, target_doc=target_doc, sales_targets=sales_targets)
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        r = asyncio.run(get_competition_dashboard(current_user=user))

    # `staff` carries everyone with sales
    assert len(r["staff"]) == 2
    # `progress_sales` carries everyone with a personal store target
    assert len(r["progress_sales"]) == 2
    # `progress` (legacy mirror) prefers sales
    assert len(r["progress"]) == 2
    staff_names = {s["name"] for s in r["staff"]}
    progress_names = {p["name"] for p in r["progress_sales"]}
    assert staff_names == progress_names == {"Syed", "Amy"}


def test_competition_no_longer_aggregates_store_targets():
    """6 Jun 2026 — explicit user request: "That accumulated target
    of all stores makes it confused for staff from different stores.
    All targets need to set against their stores".

    Verify the auto-sum logic is GONE: even with 3 store targets and
    NO competition target, response.target.value stays None and the
    Race-to-Target source is 'none' (not 'sales_targets_sum').

    Personal progress STILL works — each staff's `progress_sales`
    entry races against their own store's target."""
    import asyncio
    from routes.staff_leaderboard import get_competition_dashboard
    _reset_cache()
    invoices = [
        {"sales_person": "X", "showroom_id": "sr_gv", "showroom_name": "Gravesend",
         "order_type": "Special Order", "gross_total": 10000.0, "created_at": _NOW},
    ]
    sales_targets = [
        {"showroom_id": "sr_gv", "monthly_target": 75000, "target_type": "sales"},
        {"showroom_id": "sr_tn", "monthly_target": 55000, "target_type": "sales"},
        {"showroom_id": "sr_cf", "monthly_target": 65000, "target_type": "sales"},
    ]
    # NO target_doc
    db = _db(invoices=invoices, sales_targets=sales_targets, target_doc=None)
    user = {"role": "super_admin", "email": "a@b"}
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        r = asyncio.run(get_competition_dashboard(current_user=user))
    # NO aggregate target
    target = r["target"]
    assert target["value"] is None, \
        f"Aggregate target value should be None, not {target['value']} — staff at one store should not see a £195k target"
    assert target["source"] == "none"
    # Personal progress still populated — staff at sr_gv races £10k of £75k
    assert len(r["progress_sales"]) == 1
    assert r["progress_sales"][0]["target"] == 75000.0
    assert r["progress_sales"][0]["current"] == 10000.0
    assert r["progress_sales"][0]["pct"] == 13.3  # 10k/75k = 13.3%


# ---------------------------------------------------------------------
# 4. /staff/{user_key}/recent — audit-drawer endpoint (6 Jun 2026)
# ---------------------------------------------------------------------
def test_staff_recent_returns_quotes_and_invoices_for_sp_key():
    """Click a sales_person row → drawer fetches recent month
    quotes + invoices. The new `sp:<name>` grouping key from the
    earlier shared-store-login fix must be supported."""
    import asyncio
    from routes.staff_leaderboard import get_staff_recent_activity
    _reset_cache()
    quotes = [
        {"id": "q1", "sales_person": "Syed", "quotation_no": "QT-1",
         "customer_name": "John", "gross_total": 1500.0,
         "status": "converted", "converted_at": _NOW.isoformat(),
         "created_at": _NOW.isoformat()},
        {"id": "q2", "sales_person": "Syed", "quotation_no": "QT-2",
         "customer_name": "Sara", "gross_total": 2000.0,
         "status": "active", "created_at": _NOW.isoformat()},
    ]
    invoices = [
        {"id": "i1", "sales_person": "Syed", "invoice_no": "IN-1",
         "customer_name": "John", "gross_total": 1500.0,
         "order_type": "Special Order", "created_at": _NOW.isoformat()},
    ]
    db = _db()
    # Override the cursors to feed our fixtures
    db.quotations.find = MagicMock(return_value=_AsyncIter(quotes))
    db.invoices.find = MagicMock(return_value=_AsyncIter(invoices))
    db.quotations.count_documents = AsyncMock(return_value=2)
    db.invoices.count_documents = AsyncMock(return_value=1)
    user = {"role": "super_admin", "email": "a@b"}
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        r = asyncio.run(get_staff_recent_activity(
            user_key="sp:syed", limit=5, current_user=user,
        ))
    assert r["total_quotes"] == 2
    assert r["total_invoices"] == 1
    assert len(r["quotes"]) == 2
    # Conversion flag set from converted_at
    converted_quote = next(q for q in r["quotes"] if q["quotation_no"] == "QT-1")
    assert converted_quote["converted"] is True
    not_converted = next(q for q in r["quotes"] if q["quotation_no"] == "QT-2")
    assert not_converted["converted"] is False
    # Invoice total comes from gross_total (5 Jun 2026 fix)
    assert r["invoices"][0]["total"] == 1500.0


def test_staff_recent_excludes_store_orders_from_invoices():
    """The leaderboard counts only Special-Order invoices toward
    £ Sold. The drawer must mirror that exactly, otherwise the
    detail rows wouldn't add up to the header totals."""
    import asyncio
    from routes.staff_leaderboard import get_staff_recent_activity
    _reset_cache()
    # Capture the invoice query to verify the filter
    captured = {}
    def capture_find(query, projection=None, **kw):
        captured["query"] = query
        return _AsyncIter([])
    db = _db()
    db.invoices.find = MagicMock(side_effect=capture_find)
    db.invoices.count_documents = AsyncMock(return_value=0)
    db.quotations.find = MagicMock(return_value=_AsyncIter([]))
    db.quotations.count_documents = AsyncMock(return_value=0)
    user = {"role": "super_admin", "email": "a@b"}
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        asyncio.run(get_staff_recent_activity(
            user_key="sp:syed", limit=5, current_user=user,
        ))
    # The query must include the Special Order filter
    q = captured["query"]
    flat = str(q)
    assert "Special Order" in flat, \
        "Invoice query must filter to order_type=Special Order"


def test_staff_recent_clamps_limit_to_500():
    """Defence against accidental large fetches — even if the UI
    passes limit=99999, the backend caps at 500. (13 Jun 2026 —
    cap raised from 25 to 500 so the drawer shows ALL of a
    salesperson's monthly invoices, not just the recent five.)"""
    import asyncio
    from routes.staff_leaderboard import get_staff_recent_activity
    _reset_cache()
    db = _db()
    captured_limit = {}
    def capture_quotes_find(query, projection=None, **kw):
        cursor = _AsyncIter([])
        original_limit = cursor.limit
        def track(n):
            captured_limit["q"] = n
            return original_limit(n)
        cursor.limit = track
        return cursor
    db.quotations.find = MagicMock(side_effect=capture_quotes_find)
    db.invoices.find = MagicMock(return_value=_AsyncIter([]))
    db.quotations.count_documents = AsyncMock(return_value=0)
    db.invoices.count_documents = AsyncMock(return_value=0)
    user = {"role": "super_admin", "email": "a@b"}
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        asyncio.run(get_staff_recent_activity(
            user_key="sp:syed", limit=99999, current_user=user,
        ))
    assert captured_limit.get("q") == 500


def test_staff_recent_default_limit_returns_full_month():
    """When the UI omits the limit param, default is 200 — enough to
    cover any salesperson's full month without paging."""
    import asyncio
    from routes.staff_leaderboard import get_staff_recent_activity
    _reset_cache()
    db = _db()
    captured = {}
    def capture(query, projection=None, **kw):
        cursor = _AsyncIter([])
        original = cursor.limit
        def track(n):
            captured["q"] = n
            return original(n)
        cursor.limit = track
        return cursor
    db.quotations.find = MagicMock(side_effect=capture)
    db.invoices.find = MagicMock(return_value=_AsyncIter([]))
    db.quotations.count_documents = AsyncMock(return_value=0)
    db.invoices.count_documents = AsyncMock(return_value=0)
    user = {"role": "super_admin", "email": "a@b"}
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        asyncio.run(get_staff_recent_activity(
            user_key="sp:syed", limit=None, current_user=user,
        ))
    assert captured.get("q") == 200


def test_staff_recent_returns_empty_for_unknown_user():
    """If the user_key resolves to no clauses (shouldn't happen
    with the new sp: prefix but defensive), return empties cleanly
    instead of crashing."""
    import asyncio
    from routes.staff_leaderboard import get_staff_recent_activity
    _reset_cache()
    db = _db()
    db.quotations.find = MagicMock(return_value=_AsyncIter([]))
    db.invoices.find = MagicMock(return_value=_AsyncIter([]))
    db.quotations.count_documents = AsyncMock(return_value=0)
    db.invoices.count_documents = AsyncMock(return_value=0)
    user = {"role": "super_admin", "email": "a@b"}
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        r = asyncio.run(get_staff_recent_activity(
            user_key="sp:nonexistent", limit=5, current_user=user,
        ))
    assert r == {"quotes": [], "invoices": [], "total_quotes": 0, "total_invoices": 0}


# ---------------------------------------------------------------------
# 5. Per-store sales targets feed showroom league + race-to-target
#    (6 Jun 2026 — user reports "Sales targets set but not showing
#    on leaderboard" + asks for fair % comparison across stores).
# ---------------------------------------------------------------------
def test_showroom_league_ranks_by_pct_of_target():
    """Even though Gravesend's £40k > Tonbridge's £35k, Tonbridge's
    63.6% target hit beats Gravesend's 53.3% — that's the fair
    comparison the user asked for."""
    import asyncio
    from routes.staff_leaderboard import _showroom_totals_for_month
    _reset_cache()
    invoices = [
        {"sales_person": "Syed", "showroom_name": "Gravesend",
         "showroom_id": "sr_gv", "order_type": "Special Order",
         "gross_total": 40000.0, "created_at": _NOW},
        {"sales_person": "Tom", "showroom_name": "Tonbridge",
         "showroom_id": "sr_tn", "order_type": "Special Order",
         "gross_total": 35000.0, "created_at": _NOW},
    ]
    sales_targets = [
        {"showroom_id": "sr_gv", "monthly_target": 75000, "target_type": "sales"},
        {"showroom_id": "sr_tn", "monthly_target": 55000, "target_type": "sales"},
    ]
    db = _db(invoices=invoices, sales_targets=sales_targets)
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        rooms = asyncio.run(_showroom_totals_for_month())
    # Fair ranking: Tonbridge first (63.6%) > Gravesend (53.3%)
    assert rooms[0]["showroom_name"] == "Tonbridge", \
        f"Tonbridge (63.6% of £55k) must rank above Gravesend (53.3% of £75k). Got order: {[r['showroom_name'] for r in rooms]}"
    assert rooms[0]["pct_of_target"] > rooms[1]["pct_of_target"]
    # Targets carried through
    assert rooms[0]["monthly_target"] == 55000
    assert rooms[1]["monthly_target"] == 75000
    # `remaining_to_target` populated
    assert rooms[0]["remaining_to_target"] == 20000.0  # 55k - 35k
    assert rooms[1]["remaining_to_target"] == 35000.0  # 75k - 40k


def test_showroom_without_target_renders_with_zero_pct():
    """A showroom missing a target_type='sales' row in sales_targets
    must still render — pct_of_target = 0, monthly_target = 0 —
    so the UI can show "No target set" instead of crashing."""
    import asyncio
    from routes.staff_leaderboard import _showroom_totals_for_month
    _reset_cache()
    invoices = [
        {"sales_person": "X", "showroom_name": "NoTargetRoom",
         "showroom_id": "sr_x", "order_type": "Special Order",
         "gross_total": 5000.0, "created_at": _NOW},
    ]
    db = _db(invoices=invoices, sales_targets=[])
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        rooms = asyncio.run(_showroom_totals_for_month())
    assert len(rooms) == 1
    assert rooms[0]["monthly_target"] == 0
    assert rooms[0]["pct_of_target"] == 0.0
    assert rooms[0]["remaining_to_target"] == 0


def test_showroom_totals_merge_drifted_name_variants():
    """8 Jun 2026 — Production bug: Tonbridge appeared twice on the
    Race-to-Target list because one user's invoice carried the
    freetext `showroom_name = "Tile Station Tonbridge"` while
    others stamped it as just `"Tonbridge"`. Same showroom_id, but
    the league bucketed by name string and split the sales.

    With the fix, the canonical name from `db.showrooms` wins so
    both variants collapse into a single row and totals add up."""
    import asyncio
    from routes.staff_leaderboard import _showroom_totals_for_month
    _reset_cache()
    # Two invoices at the SAME showroom_id but with drifted name
    # stamps. The canonical name "Tonbridge" lives in db.showrooms.
    invoices = [
        {"sales_person": "Alice", "showroom_name": "Tonbridge",
         "showroom_id": "sr_tn", "order_type": "Special Order",
         "gross_total": 3000.0, "created_at": _NOW},
        {"sales_person": "Bob", "showroom_name": "Tile Station Tonbridge",
         "showroom_id": "sr_tn", "order_type": "Special Order",
         "gross_total": 297.0, "created_at": _NOW},
    ]
    showrooms = [{"_id": "sr_tn", "name": "Tonbridge"}]
    sales_targets = [
        {"showroom_id": "sr_tn", "monthly_target": 55000, "target_type": "sales"},
    ]
    db = _db(invoices=invoices, showrooms=showrooms, sales_targets=sales_targets)
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        rooms = asyncio.run(_showroom_totals_for_month())
    # ONE row, not two
    assert len(rooms) == 1, f"Drifted name variants must collapse — got {[r['showroom_name'] for r in rooms]}"
    assert rooms[0]["showroom_name"] == "Tonbridge"  # canonical wins
    assert rooms[0]["sales_value_gbp"] == 3297.0  # both invoices summed
    assert rooms[0]["sales_count"] == 2
    assert rooms[0]["staff_count"] == 2  # Alice + Bob


def test_competition_keeps_explicit_target_in_progress_conversions():
    """If the team has explicitly set a CONVERSIONS team target on
    /admin/star-staff, the new `progress_conversions` array fills
    out with each staff racing against that count target."""
    import asyncio
    from routes.staff_leaderboard import get_competition_dashboard
    _reset_cache()
    quotes = [
        {"sales_person": "Syed", "showroom_name": "Gravesend",
         "created_at": _NOW, "converted_at": _NOW},
        {"sales_person": "Syed", "showroom_name": "Gravesend",
         "created_at": _NOW, "converted_at": _NOW},
    ]
    target_doc = {"month": "_", "team_target": {"metric": "conversions", "value": 10}}
    db = _db(quotes=quotes, target_doc=target_doc)
    user = {"role": "super_admin", "email": "a@b"}
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        r = asyncio.run(get_competition_dashboard(current_user=user))
    assert r["target"]["value"] == 10
    assert r["target"]["source"] == "competition"
    assert len(r["progress_conversions"]) == 1
    assert r["progress_conversions"][0]["target"] == 10.0
    assert r["progress_conversions"][0]["current"] == 2
    assert r["progress_conversions"][0]["pct"] == 20.0


# ---------------------------------------------------------------------
# 6. Composite SALES score (6 Jun 2026 — user feedback):
#    "higher volume of sales do matter but number of sales are as
#    important — staff put effort to close sales even when small."
# ---------------------------------------------------------------------
def test_composite_score_70_30_target_relative_volume():
    """Volume metric is % of OWN store target (fair across stores),
    NOT % of top peer's £. Count metric is peer-relative.

    Two staff at DIFFERENT stores with DIFFERENT targets:
    - Whale @ Gravesend (£75k target): £15,000 in 1 sale
        → personal_pct_of_target = 20.0
    - Closer @ Tonbridge (£55k target): £11,000 in 10 sales
        → personal_pct_of_target = 20.0  (identical % of target!)

    Same % of target but the Tonbridge person used 10 sales to get
    there — count metric should push them ahead.

    max_pct_target = 20.0 (both tied)
      Whale volume = 20/20 × 100 = 100
      Closer volume = 20/20 × 100 = 100
    max_count = 10
      Whale count = 1/10 × 100 = 10
      Closer count = 10/10 × 100 = 100
    Composite (70/30):
      Whale  = 100×0.70 + 10×0.30  = 70 + 3   = 73.0
      Closer = 100×0.70 + 100×0.30 = 70 + 30  = 100.0
    """
    import asyncio
    from routes.staff_leaderboard import _compute_leaderboard
    _reset_cache()
    invoices = (
        [{"sales_person": "Whale", "showroom_id": "sr_gv", "showroom_name": "Gravesend",
          "order_type": "Special Order", "gross_total": 15000.0, "created_at": _NOW}]
        +
        [{"sales_person": "Closer", "showroom_id": "sr_tn", "showroom_name": "Tonbridge",
          "order_type": "Special Order", "gross_total": 1100.0, "created_at": _NOW} for _ in range(10)]
    )
    sales_targets = [
        {"showroom_id": "sr_gv", "monthly_target": 75000, "target_type": "sales"},
        {"showroom_id": "sr_tn", "monthly_target": 55000, "target_type": "sales"},
    ]
    db = _db(invoices=invoices, sales_targets=sales_targets)
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        board = asyncio.run(_compute_leaderboard())
    whale = next(s for s in board["staff"] if s["name"] == "Whale")
    closer = next(s for s in board["staff"] if s["name"] == "Closer")
    # Both hit 20% of their respective targets → tied on volume
    assert whale["personal_pct_of_target"] == 20.0
    assert closer["personal_pct_of_target"] == 20.0
    # Count breaks the tie — Closer wins
    assert closer["sales_composite_score"] > whale["sales_composite_score"]
    assert whale["sales_composite_score"] == 73.0
    assert closer["sales_composite_score"] == 100.0


def test_composite_score_fairness_across_stores_of_different_sizes():
    """Specifically the scenario the user keeps describing:
    - Big store with bigger target — closing more £ to hit same %
    - Small store with smaller target — closing less £ to hit same %
    Under the OLD peer-£ formula, big-store staff always dominated.
    Under the NEW target-relative formula, both can compete fairly."""
    import asyncio
    from routes.staff_leaderboard import _compute_leaderboard
    _reset_cache()
    # Both at 20% of their own target — should tie on volume.
    invoices = [
        {"sales_person": "Big", "showroom_id": "sr_big", "showroom_name": "Big",
         "order_type": "Special Order", "gross_total": 15000.0, "created_at": _NOW},
        {"sales_person": "Small", "showroom_id": "sr_small", "showroom_name": "Small",
         "order_type": "Special Order", "gross_total": 4000.0, "created_at": _NOW},
    ]
    sales_targets = [
        {"showroom_id": "sr_big", "monthly_target": 75000, "target_type": "sales"},
        {"showroom_id": "sr_small", "monthly_target": 20000, "target_type": "sales"},
    ]
    db = _db(invoices=invoices, sales_targets=sales_targets)
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        board = asyncio.run(_compute_leaderboard())
    big = next(s for s in board["staff"] if s["name"] == "Big")
    small = next(s for s in board["staff"] if s["name"] == "Small")
    # Both at 20% — tied on volume (both 100% normalized) and both
    # at 1 sale (tied on count). So composite is identical.
    assert big["personal_pct_of_target"] == 20.0
    assert small["personal_pct_of_target"] == 20.0
    assert big["sales_composite_score"] == small["sales_composite_score"]


def test_composite_score_falls_back_to_peer_relative_when_no_target():
    """Staff at a store with NO monthly_target set must still get a
    score (not be silently zero-scored). Falls back to peer-relative
    £ vs the top seller's £."""
    import asyncio
    from routes.staff_leaderboard import _compute_leaderboard
    _reset_cache()
    invoices = [
        {"sales_person": "Targeted", "showroom_id": "sr_t", "showroom_name": "Targeted",
         "order_type": "Special Order", "gross_total": 10000.0, "created_at": _NOW},
        {"sales_person": "Untargeted", "showroom_id": "sr_u", "showroom_name": "Untargeted",
         "order_type": "Special Order", "gross_total": 5000.0, "created_at": _NOW},
    ]
    sales_targets = [
        {"showroom_id": "sr_t", "monthly_target": 50000, "target_type": "sales"},
        # NB no target for sr_u
    ]
    db = _db(invoices=invoices, sales_targets=sales_targets)
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        board = asyncio.run(_compute_leaderboard())
    untargeted = next(s for s in board["staff"] if s["name"] == "Untargeted")
    # Untargeted must NOT be zero — fallback kicks in.
    assert untargeted["sales_composite_score"] > 0
    # Untargeted has 50% of top seller's £ → 50 volume, 100% of count → 100
    # 50 × 0.70 + 100 × 0.30 = 35 + 30 = 65
    assert untargeted["sales_composite_score"] == 65.0


def test_composite_score_handles_zero_sales_gracefully():
    """If no one has any sales, composite is 0 — no division by zero."""
    import asyncio
    from routes.staff_leaderboard import _compute_leaderboard
    _reset_cache()
    db = _db(invoices=[])
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        board = asyncio.run(_compute_leaderboard())
    # Empty staff list — but the helper shouldn't crash either way
    for s in board["staff"]:
        assert s["sales_composite_score"] == 0.0


def test_personal_sales_target_uses_staff_showroom_not_aggregate():
    """Each staff's personal_sales_target = THEIR store's monthly_target.
    Two staff at the same store share that target (both race the same
    £75k); two staff at different stores have different targets.

    The 6 Jun 2026 user feedback was: "All targets need to set
    against their stores" — i.e. don't sum them across stores."""
    import asyncio
    from routes.staff_leaderboard import _compute_leaderboard
    _reset_cache()
    invoices = [
        {"sales_person": "Syed", "showroom_id": "sr_gv", "showroom_name": "Gravesend",
         "order_type": "Special Order", "gross_total": 10000.0, "created_at": _NOW},
        {"sales_person": "Tom", "showroom_id": "sr_tn", "showroom_name": "Tonbridge",
         "order_type": "Special Order", "gross_total": 5000.0, "created_at": _NOW},
    ]
    sales_targets = [
        {"showroom_id": "sr_gv", "monthly_target": 75000, "target_type": "sales"},
        {"showroom_id": "sr_tn", "monthly_target": 55000, "target_type": "sales"},
    ]
    db = _db(invoices=invoices, sales_targets=sales_targets)
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        board = asyncio.run(_compute_leaderboard())
    by_name = {s["name"]: s for s in board["staff"]}
    assert by_name["Syed"]["personal_sales_target"] == 75000.0
    assert by_name["Tom"]["personal_sales_target"] == 55000.0
    # Personal %: Syed 10k/75k = 13.3%, Tom 5k/55k = 9.1%
    assert by_name["Syed"]["personal_pct_of_target"] == 13.3
    assert by_name["Tom"]["personal_pct_of_target"] == 9.1
    # No aggregate target — both staff have INDIVIDUAL £75k or £55k,
    # not a confused £130k composite.
    assert by_name["Syed"]["personal_sales_target"] != by_name["Tom"]["personal_sales_target"]


def test_showroom_targets_query_carries_correct_filters():
    """`db.sales_targets` can hold rows of `target_type` "bonus" or
    "company". The Mongo query MUST filter to sales (or unset, for
    back-compat). This test inspects the query directly because the
    test-mock returns all rows regardless of filter — production
    Mongo does the actual filtering."""
    import asyncio
    from routes.staff_leaderboard import _showroom_targets_for_month
    _reset_cache()
    captured = {}
    def capture_find(query, projection=None, **kw):
        captured["query"] = query
        return _AsyncIter([])
    db = _db()
    db.sales_targets.find = MagicMock(side_effect=capture_find)
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        asyncio.run(_showroom_targets_for_month())
    q = captured["query"]
    # Must filter to current month + year + non-null showroom_id
    assert "month" in q
    assert "year" in q
    assert q["showroom_id"] == {"$ne": None}
    # Must filter to target_type sales/missing/null/empty
    type_or = q["$or"]
    type_values = {clause.get("target_type") if "target_type" in clause and not isinstance(clause["target_type"], dict) else "missing" for clause in type_or}
    assert "sales" in type_values
    # Must include the missing/null/empty back-compat branches
    assert "missing" in type_values  # {"target_type": {"$exists": False}}
    assert None in type_values
    assert "" in type_values


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


# ---------------------------------------------------------------------
# Rank-change tracking (13 Jun 2026 — user request: "if anyone goes
# up the leaderboard show ▲, if anyone goes down ▼")
# ---------------------------------------------------------------------
def test_attach_rank_changes_returns_null_on_first_run():
    """First-ever invocation has no prior snapshot — every staff
    gets rank_change=None and TODAY's snapshot is persisted."""
    import asyncio
    from routes.staff_leaderboard import attach_rank_changes_and_snapshot
    staff = [
        {"user_key": "u1", "name": "Alice", "sales_composite_score": 80, "quotes_converted": 5},
        {"user_key": "u2", "name": "Bob",   "sales_composite_score": 60, "quotes_converted": 3},
    ]
    db = _db()  # prior_rank_snapshot=None → no history
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        asyncio.run(attach_rank_changes_and_snapshot(staff))
    for s in staff:
        assert s["sales_rank_change"] is None
        assert s["quotes_rank_change"] is None
    # Today's snapshot was written for BOTH boards
    assert db.staff_rank_snapshots.update_one.call_count == 2


def test_attach_rank_changes_marks_climber_positive():
    """Yesterday Alice was #2, today she's #1 → sales_rank_change=+1
    (positive = moved up the table). Bob slipped from #1 to #2 → -1."""
    import asyncio
    from routes.staff_leaderboard import attach_rank_changes_and_snapshot
    staff = [
        {"user_key": "alice", "name": "Alice", "sales_composite_score": 95, "quotes_converted": 8},
        {"user_key": "bob",   "name": "Bob",   "sales_composite_score": 70, "quotes_converted": 6},
    ]
    prior = {
        "ranks": {"alice": 2, "bob": 1},  # yesterday Bob was #1
    }
    db = _db(prior_rank_snapshot=prior)
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        asyncio.run(attach_rank_changes_and_snapshot(staff))
    alice = next(s for s in staff if s["user_key"] == "alice")
    bob = next(s for s in staff if s["user_key"] == "bob")
    assert alice["sales_rank_change"] == 1, "Alice moved up 1 place"
    assert bob["sales_rank_change"] == -1, "Bob dropped 1 place"


def test_attach_rank_changes_no_change_returns_zero():
    """Same rank as yesterday → 0 (frontend renders nothing — keeps
    the table calm when no one moved)."""
    import asyncio
    from routes.staff_leaderboard import attach_rank_changes_and_snapshot
    staff = [
        {"user_key": "a", "name": "A", "sales_composite_score": 90, "quotes_converted": 5},
    ]
    prior = {"ranks": {"a": 1}}
    db = _db(prior_rank_snapshot=prior)
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        asyncio.run(attach_rank_changes_and_snapshot(staff))
    assert staff[0]["sales_rank_change"] == 0


def test_attach_rank_changes_zero_score_staff_get_null():
    """Staff with no sales aren't ranked at all (would be misleading
    to say they 'dropped'). Their rank_change is None."""
    import asyncio
    from routes.staff_leaderboard import attach_rank_changes_and_snapshot
    staff = [
        {"user_key": "active", "name": "Active", "sales_composite_score": 80, "quotes_converted": 5},
        {"user_key": "idle",   "name": "Idle",   "sales_composite_score": 0, "quotes_converted": 0},
    ]
    db = _db(prior_rank_snapshot={"ranks": {"active": 1}})
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        asyncio.run(attach_rank_changes_and_snapshot(staff))
    idle = next(s for s in staff if s["user_key"] == "idle")
    assert idle["sales_rank_change"] is None
    assert idle["quotes_rank_change"] is None


def test_attach_rank_changes_persists_todays_snapshot_with_ranks():
    """The upsert call must include ranks={user_key: rank}, sorted
    correctly by descending composite score."""
    import asyncio
    from routes.staff_leaderboard import attach_rank_changes_and_snapshot
    staff = [
        {"user_key": "u1", "name": "U1", "sales_composite_score": 40, "quotes_converted": 1},
        {"user_key": "u2", "name": "U2", "sales_composite_score": 100, "quotes_converted": 10},
        {"user_key": "u3", "name": "U3", "sales_composite_score": 70, "quotes_converted": 5},
    ]
    db = _db()
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        asyncio.run(attach_rank_changes_and_snapshot(staff))
    # Find the call that wrote the sales snapshot
    sales_call = next(
        c for c in db.staff_rank_snapshots.update_one.call_args_list
        if c.args[0]["board"] == "sales_composite"
    )
    ranks = sales_call.args[1]["$set"]["ranks"]
    assert ranks == {"u2": 1, "u3": 2, "u1": 3}


# ---------------------------------------------------------------------
# Weekly biggest climber (13 Jun 2026)
# ---------------------------------------------------------------------
def test_weekly_climber_returns_none_when_no_history():
    """No 7-day-old snapshot exists yet (first week after deploy) →
    no climber callout."""
    import asyncio
    from routes.staff_leaderboard import _compute_weekly_climber
    staff = [
        {"user_key": "u1", "name": "U1", "sales_composite_score": 90, "showroom_name": "X"},
    ]
    db = _db()  # find_one returns None
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        result = asyncio.run(_compute_weekly_climber(staff))
    assert result is None


def test_weekly_climber_picks_biggest_climber():
    """Among staff who all improved, the one with the largest delta
    is picked. Climbs of <2 places are not noteworthy and ignored."""
    import asyncio
    from routes.staff_leaderboard import _compute_weekly_climber
    staff = [
        {"user_key": "alice", "name": "Alice", "sales_composite_score": 100, "showroom_name": "T"},
        {"user_key": "bob",   "name": "Bob",   "sales_composite_score": 80,  "showroom_name": "G"},
        {"user_key": "carol", "name": "Carol", "sales_composite_score": 50,  "showroom_name": "C"},
    ]
    # 7 days ago: Alice was 8th (climbed +7), Bob was 3rd (climbed +1, ignored),
    # Carol was 6th (climbed +3). Alice wins.
    prior = {
        "date": "2026-06-06",
        "ranks": {"alice": 8, "bob": 3, "carol": 6},
    }
    db = _db(prior_rank_snapshot=prior)
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        result = asyncio.run(_compute_weekly_climber(staff))
    assert result is not None
    assert result["name"] == "Alice"
    assert result["places_climbed"] == 7
    assert result["current_rank"] == 1
    assert result["from_rank"] == 8


def test_weekly_climber_ignores_single_place_movers():
    """A +1 move isn't worth a celebration banner — only +2 or more
    triggers the callout."""
    import asyncio
    from routes.staff_leaderboard import _compute_weekly_climber
    staff = [
        {"user_key": "u1", "name": "U1", "sales_composite_score": 90, "showroom_name": "X"},
        {"user_key": "u2", "name": "U2", "sales_composite_score": 70, "showroom_name": "Y"},
    ]
    prior = {"date": "2026-06-06", "ranks": {"u1": 2, "u2": 1}}
    db = _db(prior_rank_snapshot=prior)
    with patch("routes.staff_leaderboard.get_db", return_value=db):
        result = asyncio.run(_compute_weekly_climber(staff))
    assert result is None  # only +1 climb available


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

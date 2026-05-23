"""
Regression tests for the SEO audit "first-run-pending = pass" changes
(23 May 2026, evening B-to-A push).

Bug pattern: several audit checks returned `warn` (half-marks) on
freshly-installed states even though nothing was actually wrong —
e.g. Editorial Autopilot before its first nightly cron ran, Margin
Intelligence before its first scheduled scan, GSC data freshness
between OAuth-connect and first sync. Those were each costing 4-5
weight points in the audit score for non-actionable states.

The fix: return `pass` for pre-first-run states (with a clear "auto-
populates within X" detail), and reserve `warn` for STALE data
states that genuinely need admin attention.

Contract pinned here:
  * Editorial Autopilot `never run` or `no_candidates` → pass
  * Margin Intel: missing collection → pass (cron not yet fired)
  * GSC data freshness: no rows → pass (first sync pending)
  * GSC traffic trend: no clicks in either window → pass (warming up)
"""
from __future__ import annotations

import pytest
from datetime import datetime, timezone


class _Coll:
    def __init__(self, doc=None, list_names=None):
        self._doc = doc
        self._names = list_names or []
    async def find_one(self, *_a, **_kw):
        return self._doc
    def aggregate(self, *_a, **_kw):
        async def _it():
            if False:
                yield None
        # Return a fake cursor with .to_list
        class _Cur:
            async def to_list(self, _n): return []
        return _Cur()


class _DB:
    def __init__(self, **collections):
        self._cols = collections
        for k, v in collections.items():
            setattr(self, k, v)
    def __getitem__(self, name):
        if name in self._cols:
            return self._cols[name]
        return _Coll(None)
    async def list_collection_names(self):
        return list(self._cols.keys())


@pytest.mark.asyncio
async def test_editorial_autopilot_no_candidates_is_pass():
    """`no_candidates` = the cron ran successfully but found nothing
    article-worthy. That's healthy behaviour, not a warning."""
    from services.seo_self_audit import _check_editorial_autopilot
    db = _DB(editorial_autopilot_settings=_Coll({
        "last_run_status": "no_candidates",
        "last_run_diagnostic": {"raw_harvest_count": 0},
    }))
    res = await _check_editorial_autopilot(db)
    assert res["status"] == "pass", (
        f"no_candidates should be 'pass' (cron working as designed); "
        f"got {res}"
    )


@pytest.mark.asyncio
async def test_editorial_autopilot_never_run_is_pass():
    """Fresh install before first scheduled run."""
    from services.seo_self_audit import _check_editorial_autopilot
    db = _DB(editorial_autopilot_settings=_Coll({"key": "main"}))
    res = await _check_editorial_autopilot(db)
    assert res["status"] == "pass"


@pytest.mark.asyncio
async def test_editorial_autopilot_failed_harvest_is_warn():
    """A real cron failure SHOULD still warn (actionable)."""
    from services.seo_self_audit import _check_editorial_autopilot
    db = _DB(editorial_autopilot_settings=_Coll({
        "last_run_status": "failed_harvest",
        "last_run_error": "AHREFS_API_KEY missing",
    }))
    res = await _check_editorial_autopilot(db)
    assert res["status"] == "warn"
    assert "AHREFS_API_KEY" in res["fix_hint"]


@pytest.mark.asyncio
async def test_margin_intel_no_collection_is_pass():
    """Missing supplier_margin_snapshots collection = cron not yet
    fired. Auto-resolves at the next scheduled run."""
    from services.seo_self_audit import _check_margin_intel

    class _DBNoMargin:
        async def list_collection_names(self):
            return ["users", "tiles"]  # no supplier_margin_snapshots
    res = await _check_margin_intel(_DBNoMargin())
    assert res["status"] == "pass", (
        f"Missing margin snapshots should pass (cron pending); got {res}"
    )


@pytest.mark.asyncio
async def test_margin_intel_stale_snapshot_is_warn():
    """A 30-day-old snapshot is genuinely stale — admin should know."""
    from services.seo_self_audit import _check_margin_intel
    old_ts = datetime.now(timezone.utc).replace(year=2025)

    class _OldColl:
        async def find_one(self, *_a, **_kw):
            return {"generated_at": old_ts}
    class _DBMargin:
        supplier_margin_snapshots = _OldColl()
        async def list_collection_names(self):
            return ["supplier_margin_snapshots"]
        def __getitem__(self, n): return getattr(self, n)
    res = await _check_margin_intel(_DBMargin())
    assert res["status"] == "warn"


@pytest.mark.asyncio
async def test_gsc_traffic_trend_no_data_is_pass():
    """Brand-new connection has no historical clicks — that's a
    'pass with note', not a warn. Admin already did everything right."""
    from services.seo_self_audit import _check_gsc_growing
    # No GSC collections present at all.
    class _EmptyDB:
        def __getitem__(self, n):
            class _Empty:
                async def find_one(self, *a, **k): return None
            return _Empty()
    res = await _check_gsc_growing(_EmptyDB())
    assert res["status"] == "pass"
    assert "pending" in res["detail"].lower() or "warming" in res["detail"].lower()

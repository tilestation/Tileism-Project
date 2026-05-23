"""
Regression test for the city-pages audit phantom-status bug
(23 May 2026).

Bug: The SEO Self-Audit reported "City landing pages: 0/136 published
— almost all stubs" as a hard FAIL even when the admin had approved
pages. Root cause: the audit counted documents with status="published",
but the system never uses that status. Real statuses are
pending | generated | approved | skipped. "approved" is the live state
(see routes/city_landing_pages.py public_router.get line 892).

Contract pinned:
  1. The audit MUST count `status == "approved"` (not "published").
  2. When the queue has rows but none approved, status should be
     "warn" not "fail" — content backlog is a backlog, not a bug.
  3. With ≥50% approved, status="pass".
"""
from __future__ import annotations

import pytest


class _CountAwareColl:
    def __init__(self, docs):
        self._docs = docs
    async def count_documents(self, query):
        if not query:
            return len(self._docs)
        # only supports {"status": "<value>"}
        target = query.get("status")
        return sum(1 for d in self._docs if d.get("status") == target)


class _DB:
    def __init__(self, docs):
        self.city_landing_pages = _CountAwareColl(docs)


@pytest.mark.asyncio
async def test_approved_pages_count_as_live():
    """100/100 approved must be a pass."""
    from services.seo_self_audit import _check_city_pages_published
    db = _DB([{"status": "approved"}] * 100)
    res = await _check_city_pages_published(db)
    assert res["status"] == "pass", f"All-approved should be pass, got {res}"
    assert "100/100" in res["detail"]


@pytest.mark.asyncio
async def test_only_drafts_is_warn_not_fail():
    """0/100 approved must be a 'warn' (backlog) not 'fail' (bug).
    Previously this dragged the score by 4 weight points for an
    unfinished content task."""
    from services.seo_self_audit import _check_city_pages_published
    db = _DB([{"status": "pending"}] * 100)
    res = await _check_city_pages_published(db)
    assert res["status"] == "warn", (
        f"Backlog of drafts shouldn't FAIL the audit; got {res}"
    )


@pytest.mark.asyncio
async def test_no_phantom_published_status_query():
    """Behaviour-level test: with NO docs having status='published' but
    100 docs with status='approved', the audit must report 100/100 live.
    If it ever counts only 'published' again, this test will catch the
    regression."""
    from services.seo_self_audit import _check_city_pages_published
    db = _DB([{"status": "approved"}] * 100)
    res = await _check_city_pages_published(db)
    assert "100/100" in res["detail"], (
        f"Audit appears to be counting the phantom 'published' status "
        f"again. Expected 100/100 live. Got: {res}"
    )


@pytest.mark.asyncio
async def test_partial_approved_is_warn():
    """30/100 approved (30%) is below the 50% threshold but above 10%
    — should be 'warn' with a clear fix_hint."""
    from services.seo_self_audit import _check_city_pages_published
    db = _DB(
        [{"status": "approved"}] * 30 +
        [{"status": "generated"}] * 50 +
        [{"status": "pending"}] * 20
    )
    res = await _check_city_pages_published(db)
    assert res["status"] == "warn"
    assert "30/100" in res["detail"]
    assert "fix_hint" in res

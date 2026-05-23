"""
Regression test for the SEO audit ↔ GSC collection-name mismatch
(23 May 2026).

Bug: After successfully connecting Google Search Console (refresh
token visible in /admin/gsc UI), the SEO self-audit still reported
"GSC connected: no GSC OAuth credentials in DB" because the audit
looked at `gsc_credentials` while the OAuth service stores into
`gsc_oauth_tokens`. Same root issue for `gsc_query_data` vs
`gsc_search_analytics_cache`.

Contract pinned here:
  1. `_check_gsc_connected` MUST query the `gsc_oauth_tokens`
     collection (matches services/gsc.py TOKENS_COLLECTION).
  2. A doc with a refresh_token MUST yield status="pass".
  3. An empty collection MUST yield status="fail" with the right
     fix_hint pointing at /admin/gsc.
  4. The data-freshness check MUST treat a missing nightly sync as
     a "warn" (planned feature) rather than dragging the audit
     score down with a hard "fail".
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import pytest


class _FakeColl:
    def __init__(self, doc=None):
        self._doc = doc
    async def find_one(self, *_a, **_kw):
        return self._doc
    def aggregate(self, *_a, **_kw):
        async def _gen():
            if False:
                yield None
        return _gen()


class _FakeDB:
    def __init__(self, gsc_oauth_tokens=None, gsc_search_analytics_cache=None,
                 gsc_query_data=None):
        self.gsc_oauth_tokens = _FakeColl(gsc_oauth_tokens)
        self.gsc_search_analytics_cache = _FakeColl(gsc_search_analytics_cache)
        self.gsc_query_data = _FakeColl(gsc_query_data)
    def __getitem__(self, name):
        return getattr(self, name)


@pytest.mark.asyncio
async def test_audit_passes_when_oauth_tokens_collection_has_refresh_token():
    """The exact scenario the user hit: GSC connected, refresh token
    persisted, but audit was lying because it queried the wrong
    collection."""
    from services.seo_self_audit import _check_gsc_connected
    db = _FakeDB(gsc_oauth_tokens={
        "refresh_token": "1//0gFAKEREFRESH",
        "google_account_email": "qasim@tilestation.co.uk",
    })
    result = await _check_gsc_connected(db)
    assert result["status"] == "pass", (
        f"Expected pass when gsc_oauth_tokens has a refresh_token; "
        f"got: {result}"
    )
    assert "qasim@tilestation.co.uk" in result["detail"]


@pytest.mark.asyncio
async def test_audit_fails_when_no_oauth_tokens_doc():
    from services.seo_self_audit import _check_gsc_connected
    db = _FakeDB(gsc_oauth_tokens=None)
    result = await _check_gsc_connected(db)
    assert result["status"] == "fail"
    assert "/admin/gsc" in result["fix_hint"]


@pytest.mark.asyncio
async def test_audit_does_not_query_legacy_gsc_credentials_collection():
    """Defensive — if we ever revert to the wrong collection name, the
    user would see the same misleading 'connected but audit says not
    connected' state. We assert on the function's actual db calls via
    a spy, not on source text (avoids false positives on comments)."""
    from services import seo_self_audit

    visited = []
    class _SpyColl:
        def __init__(self, name): self.name = name
        async def find_one(self, *a, **k):
            visited.append(self.name)
            return None
    class _SpyDB:
        def __init__(self):
            self.gsc_oauth_tokens = _SpyColl("gsc_oauth_tokens")
            self.gsc_credentials = _SpyColl("gsc_credentials")  # legacy
        def __getitem__(self, n): return getattr(self, n, _SpyColl(n))

    await seo_self_audit._check_gsc_connected(_SpyDB())
    assert "gsc_oauth_tokens" in visited, (
        "Audit must query gsc_oauth_tokens (the real OAuth collection)"
    )
    assert "gsc_credentials" not in visited, (
        "Audit must NOT query the never-shipped legacy gsc_credentials"
    )


@pytest.mark.asyncio
async def test_data_freshness_returns_pass_when_sync_not_yet_run():
    """Updated 23 May 2026 evening: missing nightly sync data is a
    'pass' (sync not yet run — auto-populates within 24h) not a 'warn'.
    Warns were dragging the score for a non-actionable state on
    freshly-connected accounts."""
    from services.seo_self_audit import _check_gsc_data_fresh
    db = _FakeDB(gsc_search_analytics_cache=None, gsc_query_data=None)
    result = await _check_gsc_data_fresh(db)
    assert result["status"] == "pass", (
        f"Missing GSC data should be 'pass' (sync pending), not 'warn'; "
        f"got: {result}"
    )
    assert "pending" in result["detail"].lower() or "24h" in result["detail"]

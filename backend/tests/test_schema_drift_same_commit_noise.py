"""Unit test for the 20 May 2026 fix to `_check_schema_drift`:

When the production fingerprint flips but the git_sha is IDENTICAL to
the baseline, it must NOT page Telegram (noisy-hash false positive).
It must silently update the baseline and increment `noise_flip_count`.

Regression test for the real user incident where Telegram fired two
schema-drift alerts 5 minutes apart, both with the same git_sha
`b8787e9c0148`, where the fingerprint just flipped back and forth.
"""
import sys
import asyncio
from unittest.mock import AsyncMock, patch

sys.path.insert(0, "/app/backend")

from services.uptime_monitor import _check_schema_drift  # noqa: E402


class _FakeCollection:
    def __init__(self, initial_doc):
        self._doc = dict(initial_doc) if initial_doc else None
        self.updates = []

    async def find_one(self, query):
        return dict(self._doc) if self._doc else None

    async def update_one(self, query, update, upsert=False):
        self.updates.append({"query": query, "update": update, "upsert": upsert})
        if self._doc is None and upsert:
            self._doc = {}
        if self._doc is None:
            return
        for k, v in (update.get("$set") or {}).items():
            self._doc[k] = v
        for k, v in (update.get("$inc") or {}).items():
            self._doc[k] = (self._doc.get(k) or 0) + v


class _FakeDb:
    def __init__(self, initial_baseline):
        self.schema_baselines = _FakeCollection(initial_baseline)


def _mock_httpx_response(payload):
    """Patch httpx.AsyncClient so .get() returns a stubbed response."""
    class _Resp:
        status_code = 200

        def json(self):
            return payload

    class _Client:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            pass

        async def get(self, url):
            return _Resp()

    return _Client


def test_same_git_sha_with_flipped_fingerprint_does_not_alert(monkeypatch):
    """The real bug: prod returned fingerprint A → B → A across 3 checks
    while git_sha never moved. The detector previously paged Telegram
    every cycle. After the fix it must update baseline silently."""

    baseline = {
        "_id": "prod",
        "fingerprint": "849e03eb42ebfaa6",
        "per_endpoint": {},
        "git_sha": "b8787e9c0148",
        "captured_at": "2026-05-20T22:18:00+00:00",
    }
    db = _FakeDb(baseline)

    # Prod backend returns NEW fingerprint but SAME git_sha
    prod_payload = {
        "schema_fingerprint": "2584e8cdd5386b50",
        "schema_endpoints": {},
        "git_sha": "b8787e9c0148",
    }

    telegram_calls = []

    async def _fake_telegram(msg, parse_mode=None):
        telegram_calls.append(msg)

    monkeypatch.setattr(
        "services.uptime_monitor.send_telegram",
        AsyncMock(side_effect=_fake_telegram),
    )
    monkeypatch.setattr(
        "httpx.AsyncClient",
        _mock_httpx_response(prod_payload),
    )

    result = asyncio.run(_check_schema_drift(db))

    # CRITICAL: must NOT have paged Telegram
    assert telegram_calls == [], (
        f"Telegram must NOT be paged when git_sha is unchanged. "
        f"Got {len(telegram_calls)} calls: {telegram_calls}"
    )
    # Result should report not-drifted, but flag the noise
    assert result is not None
    assert result.get("drifted") is False
    assert result.get("same_commit_noise") is True
    # Baseline must have been updated to the new (noisy) fingerprint
    # so we don't repeatedly hit this same branch.
    assert db.schema_baselines._doc["fingerprint"] == "2584e8cdd5386b50"
    # And noise_flip_count must have been incremented for observability
    assert db.schema_baselines._doc.get("noise_flip_count") == 1


def test_real_git_sha_change_with_flipped_fingerprint_still_alerts(monkeypatch):
    """The REAL drift scenario must still page Telegram — only the
    noisy same-commit case is suppressed."""

    baseline = {
        "_id": "prod",
        "fingerprint": "849e03eb42ebfaa6",
        "per_endpoint": {},
        "git_sha": "e3449ac7d8c1",
        "captured_at": "2026-05-20T22:00:00+00:00",
    }
    db = _FakeDb(baseline)

    # New commit deployed AND fingerprint changed
    prod_payload = {
        "schema_fingerprint": "2584e8cdd5386b50",
        "schema_endpoints": {"products.list": {"fp": "newhash"}},
        "git_sha": "b8787e9c0148",
    }

    telegram_calls = []

    async def _fake_telegram(msg, parse_mode=None):
        telegram_calls.append(msg)

    monkeypatch.setattr(
        "services.uptime_monitor.send_telegram",
        AsyncMock(side_effect=_fake_telegram),
    )
    monkeypatch.setattr(
        "httpx.AsyncClient",
        _mock_httpx_response(prod_payload),
    )

    result = asyncio.run(_check_schema_drift(db))

    assert len(telegram_calls) == 1, (
        f"Real drift (git_sha changed) MUST page Telegram. Calls: {telegram_calls}"
    )
    assert "schema drift detected" in telegram_calls[0]
    assert result is not None
    assert result.get("drifted") is True

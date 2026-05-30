"""
Tests for the ElevenLabs cost-tracking dashboard (30 May 2026 —
user request: "I need a clear breakdown on Radio Studio dashboard
of total I am spending on these ad generations").

Architecture:
  • Every successful TTS call (generate + test_voice) writes a tiny
    doc to `radio_studio_tts_usage`.
  • GET /api/admin/radio-studio/usage aggregates the docs into
    today/30d/lifetime totals + per-ad leaderboard + 20 most recent.
"""
from __future__ import annotations

import inspect
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    from server import app
    return TestClient(app)


@pytest.fixture
def admin_override():
    from server import app
    from routes.radio_studio import get_current_user
    app.dependency_overrides[get_current_user] = lambda: {
        "email": "admin@test.com", "role": "super_admin",
    }
    yield
    app.dependency_overrides.pop(get_current_user, None)


# ---------------------------------------------------------------
# Cost formula
# ---------------------------------------------------------------

def test_chars_to_gbp_zero_is_zero():
    from routes.radio_studio import _chars_to_gbp
    assert _chars_to_gbp(0) == 0.0
    assert _chars_to_gbp(-5) == 0.0


def test_chars_to_gbp_default_rate():
    """Default rate = $0.30 / 1k chars × £0.79 / $ = £0.000237 / char.
    1000 chars → ~£0.237. Within float-rounding tolerance."""
    from routes.radio_studio import _chars_to_gbp, _TTS_USD_PER_1K_CHARS, _GBP_PER_USD
    expected = round((1000 / 1000.0) * _TTS_USD_PER_1K_CHARS * _GBP_PER_USD, 6)
    assert _chars_to_gbp(1000) == expected
    assert abs(_chars_to_gbp(1000) - 0.237) < 0.001  # default config


def test_chars_to_gbp_scales_linearly():
    from routes.radio_studio import _chars_to_gbp
    one = _chars_to_gbp(500)
    two = _chars_to_gbp(1000)
    four = _chars_to_gbp(2000)
    assert abs(two - 2 * one) < 0.0001
    assert abs(four - 4 * one) < 0.0001


# ---------------------------------------------------------------
# _log_tts_usage
# ---------------------------------------------------------------

@pytest.mark.asyncio
async def test_log_usage_writes_expected_fields():
    from routes import radio_studio
    fake_db = MagicMock()
    fake_db.radio_studio_tts_usage.insert_one = AsyncMock()

    await radio_studio._log_tts_usage(
        db=fake_db,
        ad_id="ad-1",
        ad_name="Sale ad",
        endpoint="generate",
        chars=400,
        voice_id="vid",
        voice_name="Rachel",
        model_id="eleven_multilingual_v2",
        triggered_by="admin@test.com",
    )
    fake_db.radio_studio_tts_usage.insert_one.assert_awaited_once()
    doc = fake_db.radio_studio_tts_usage.insert_one.call_args.args[0]
    assert doc["ad_id"] == "ad-1"
    assert doc["ad_name"] == "Sale ad"
    assert doc["endpoint"] == "generate"
    assert doc["chars"] == 400
    assert doc["voice_id"] == "vid"
    assert doc["voice_name"] == "Rachel"
    assert doc["model_id"] == "eleven_multilingual_v2"
    assert doc["triggered_by"] == "admin@test.com"
    assert "cost_gbp_estimate" in doc
    assert doc["cost_gbp_estimate"] > 0
    # Snapshot the rate the cost was computed at — so if the admin
    # changes their ELEVENLABS_USD_PER_1K_CHARS env var, historical
    # records remain faithful to what they were billed.
    assert "usd_per_1k_chars" in doc
    assert "gbp_per_usd" in doc
    assert "created_at" in doc


@pytest.mark.asyncio
async def test_log_usage_swallows_db_errors():
    """Cost logging is best-effort — a Mongo wedge MUST NOT take
    down a TTS call. Verify the helper catches and absorbs."""
    from routes import radio_studio
    fake_db = MagicMock()
    fake_db.radio_studio_tts_usage.insert_one = AsyncMock(
        side_effect=RuntimeError("Mongo wedged"),
    )
    # Should NOT raise.
    await radio_studio._log_tts_usage(
        db=fake_db,
        ad_id="ad-1", ad_name="x", endpoint="generate", chars=10,
        voice_id="v", voice_name="V", model_id="m", triggered_by="u",
    )


# ---------------------------------------------------------------
# generate_ad_audio + test_ad_voice both call the logger
# ---------------------------------------------------------------

def test_generate_handler_logs_tts_usage():
    from routes import radio_studio
    src = inspect.getsource(radio_studio.generate_ad_audio)
    assert "_log_tts_usage(" in src, (
        "generate_ad_audio must log TTS usage so the cost dashboard "
        "reflects each generation."
    )
    assert 'endpoint="generate"' in src


def test_test_voice_handler_logs_tts_usage():
    from routes import radio_studio
    src = inspect.getsource(radio_studio.test_ad_voice)
    assert "_log_tts_usage(" in src
    assert 'endpoint="test_voice"' in src


# ---------------------------------------------------------------
# GET /usage endpoint
# ---------------------------------------------------------------

def test_usage_empty_state(client, admin_override):
    from routes import radio_studio

    fake_db = MagicMock()
    # Each aggregate call returns an empty async iterator.
    def _empty_cursor(*_args, **_kwargs):
        cursor = MagicMock()
        async def _gen():
            return
            yield  # pragma: no cover
        cursor.__aiter__ = lambda self: _gen()
        return cursor
    fake_db.radio_studio_tts_usage.aggregate = MagicMock(side_effect=_empty_cursor)
    fake_db.radio_studio_tts_usage.find = MagicMock(return_value=_empty_cursor())

    # `find` returns a cursor that supports .sort().limit() chaining
    # → re-build a stub that returns itself on those.
    chain_cursor = MagicMock()
    chain_cursor.sort = MagicMock(return_value=chain_cursor)
    chain_cursor.limit = MagicMock(return_value=chain_cursor)
    async def _empty_recent():
        return
        yield  # pragma: no cover
    chain_cursor.__aiter__ = lambda self: _empty_recent()
    fake_db.radio_studio_tts_usage.find = MagicMock(return_value=chain_cursor)

    with patch.object(radio_studio, "get_db", return_value=fake_db):
        r = client.get("/api/admin/radio-studio/usage")

    body = r.json()
    assert r.status_code == 200
    assert body["today"] == {"calls": 0, "chars": 0, "gbp": 0.0}
    assert body["last_30_days"] == {"calls": 0, "chars": 0, "gbp": 0.0}
    assert body["lifetime"] == {"calls": 0, "chars": 0, "gbp": 0.0}
    assert body["by_ad"] == []
    assert body["recent"] == []
    assert "rate" in body
    assert body["rate"]["gbp_per_1k_chars"] > 0


def test_usage_with_data(client, admin_override):
    """When there's actual usage, the endpoint aggregates the
    `today` / `30d` / `lifetime` totals correctly."""
    from routes import radio_studio

    # Aggregation pipeline mock — return canned results per pipeline.
    # Match the three "$group only" totals + by_ad pipeline by shape.
    total_doc = {"_id": None, "calls": 12, "chars": 4800, "gbp": 1.14}
    thirty_doc = {"_id": None, "calls": 8, "chars": 3200, "gbp": 0.76}
    today_doc = {"_id": None, "calls": 2, "chars": 800, "gbp": 0.19}

    by_ad_docs = [
        {"_id": {"ad_id": "ad-1", "ad_name": "Sale ad"},
         "calls": 7, "chars": 2800, "gbp": 0.66,
         "generate_calls": 5, "test_calls": 2,
         "last_generated_at": "2026-05-30T10:00:00+00:00"},
        {"_id": {"ad_id": "ad-2", "ad_name": "Catalogue ad"},
         "calls": 3, "chars": 1200, "gbp": 0.28,
         "generate_calls": 2, "test_calls": 1,
         "last_generated_at": "2026-05-30T09:00:00+00:00"},
    ]
    recent_docs = [
        {"ad_name": "Sale ad", "endpoint": "generate",
         "chars": 400, "cost_gbp_estimate": 0.095,
         "voice_name": "Rachel", "triggered_by": "admin@test.com",
         "created_at": "2026-05-30T10:00:00+00:00"},
    ]

    # Tracker so each aggregate() call returns a fresh cursor with
    # the right canned data (FastAPI awaits them in sequence).
    call_count = {"n": 0}
    canned_results = [total_doc, thirty_doc, today_doc, *by_ad_docs]

    def _make_aggregate_cursor(pipe):
        # 4th+ call is the by_ad pipeline (it has $sort/$limit).
        is_by_ad = any("$sort" in stage for stage in pipe)
        cursor = MagicMock()
        async def _gen():
            if is_by_ad:
                for d in by_ad_docs:
                    yield d
            else:
                # First three calls = lifetime/30d/today in order.
                idx = call_count["n"]
                call_count["n"] += 1
                if idx < 3:
                    yield canned_results[idx]
        cursor.__aiter__ = lambda self: _gen()
        return cursor

    chain_cursor = MagicMock()
    chain_cursor.sort = MagicMock(return_value=chain_cursor)
    chain_cursor.limit = MagicMock(return_value=chain_cursor)
    async def _recent_gen():
        for d in recent_docs:
            yield d
    chain_cursor.__aiter__ = lambda self: _recent_gen()

    fake_db = MagicMock()
    fake_db.radio_studio_tts_usage.aggregate = MagicMock(side_effect=_make_aggregate_cursor)
    fake_db.radio_studio_tts_usage.find = MagicMock(return_value=chain_cursor)

    with patch.object(radio_studio, "get_db", return_value=fake_db):
        r = client.get("/api/admin/radio-studio/usage")

    assert r.status_code == 200
    body = r.json()
    assert body["lifetime"] == {"calls": 12, "chars": 4800, "gbp": 1.14}
    assert body["last_30_days"] == {"calls": 8, "chars": 3200, "gbp": 0.76}
    assert body["today"] == {"calls": 2, "chars": 800, "gbp": 0.19}
    # Per-ad leaderboard sorted by spend (highest first).
    assert len(body["by_ad"]) == 2
    assert body["by_ad"][0]["ad_name"] == "Sale ad"
    assert body["by_ad"][0]["gbp"] == 0.66
    assert body["by_ad"][0]["generate_calls"] == 5
    assert body["by_ad"][0]["test_calls"] == 2
    assert body["by_ad"][1]["ad_name"] == "Catalogue ad"
    # Recent activity in reverse-chronological order.
    assert len(body["recent"]) == 1
    assert body["recent"][0]["ad_name"] == "Sale ad"
    assert body["recent"][0]["chars"] == 400


def test_usage_admin_only():
    """Source check — _require_admin runs before any DB read."""
    from routes import radio_studio
    src = inspect.getsource(radio_studio.get_tts_usage)
    body = src.split("):\n", 1)[1].split("\n")
    require_idx = next(
        (i for i, ln in enumerate(body) if "_require_admin(" in ln), -1,
    )
    db_idx = next(
        (i for i, ln in enumerate(body) if "aggregate(" in ln or "find(" in ln), 9999,
    )
    assert require_idx != -1
    assert require_idx < db_idx

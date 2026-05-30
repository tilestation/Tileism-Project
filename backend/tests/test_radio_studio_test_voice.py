"""
Tests for the "Test voice" endpoint (30 May 2026, user request:
sanity-check pronunciations before burning a full ElevenLabs
generation, especially after the £ + URL normalisation fixes).

POST /api/admin/radio-studio/ads/{id}/test-voice
  → synthesises the first ~180 normalised chars of the ad's script
  → streams audio/mpeg bytes back inline
  → does NOT apply the music bed (admin needs to hear voice clearly)
  → does NOT touch the stored audio_blob
  → admin-only
"""
from __future__ import annotations

import inspect
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
# Endpoint contract
# ---------------------------------------------------------------

def test_test_voice_returns_audio_mpeg_bytes(client, admin_override):
    from routes import radio_studio

    fake_ad = {
        "id": "ad-1",
        "script": "This weekend at Tile Station: porcelain from £19.99 m².",
        "voice_id": "voice-1",
        "stability": 0.5, "similarity_boost": 0.75, "style": 0.0,
        "model_id": "eleven_multilingual_v2",
    }
    fake_db = MagicMock()
    fake_db.radio_studio_ads.find_one = AsyncMock(return_value=fake_ad)
    fake_bytes = b"ID3\x04" + b"\xff\xfb\x90\x00" * 200

    # Mock the ElevenLabs client to return our fake bytes.
    fake_client = MagicMock()
    fake_client.text_to_speech.convert.return_value = iter([fake_bytes])

    with patch.object(radio_studio, "get_db", return_value=fake_db), \
         patch.object(radio_studio, "_get_eleven_client", return_value=fake_client):
        r = client.post("/api/admin/radio-studio/ads/ad-1/test-voice")

    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/mpeg"
    assert r.content == fake_bytes
    # No-store: every preview is a fresh ElevenLabs call so the
    # admin sees the latest voice tuning.
    assert "no-store" in r.headers["cache-control"]


def test_test_voice_uses_normalised_script(client, admin_override):
    """The TTS call must receive the NORMALISED text (£ words,
    URLs spelled out), not the raw script — same fix as the full
    generate endpoint. Captures the exact text= argument."""
    from routes import radio_studio

    fake_ad = {
        "id": "ad-x",
        "script": "Visit www.tilestation.co.uk/sale for £42.99 deals!",
        "voice_id": "voice-1",
        "stability": 0.5, "similarity_boost": 0.75, "style": 0.0,
        "model_id": "eleven_multilingual_v2",
    }
    fake_db = MagicMock()
    fake_db.radio_studio_ads.find_one = AsyncMock(return_value=fake_ad)
    captured = {}

    def fake_convert(**kwargs):
        captured.update(kwargs)
        return iter([b"AUDIO"])

    fake_client = MagicMock()
    fake_client.text_to_speech.convert = fake_convert

    with patch.object(radio_studio, "get_db", return_value=fake_db), \
         patch.object(radio_studio, "_get_eleven_client", return_value=fake_client):
        r = client.post("/api/admin/radio-studio/ads/ad-x/test-voice")

    assert r.status_code == 200
    sent = captured["text"]
    # The pound sign and the URL must have been swapped out before
    # going to ElevenLabs.
    assert "£" not in sent
    assert "www.tilestation" not in sent
    assert "42 pounds 99" in sent
    assert "tile station dot co dot uk slash sale" in sent


def test_test_voice_truncates_long_script_to_budget(client, admin_override):
    """A long script is truncated to ~180 chars near a sentence
    boundary so the preview ends cleanly (avoids mid-word cuts)
    AND so cost is bounded (~£0.0002 per preview)."""
    from routes import radio_studio

    long_script = (
        "Sentence one is here. "
        "Sentence two continues the message. "
        "Sentence three goes on and on. "
        "Sentence four keeps going. "
        "Sentence five is even more verbose. "
        "Sentence six trails off into the distance."
    )
    fake_ad = {
        "id": "ad-long",
        "script": long_script,
        "voice_id": "v",
        "stability": 0.5, "similarity_boost": 0.75, "style": 0.0,
        "model_id": "eleven_multilingual_v2",
    }
    fake_db = MagicMock()
    fake_db.radio_studio_ads.find_one = AsyncMock(return_value=fake_ad)
    captured = {}

    def fake_convert(**kwargs):
        captured.update(kwargs)
        return iter([b"X" * 1000])

    fake_client = MagicMock()
    fake_client.text_to_speech.convert = fake_convert

    with patch.object(radio_studio, "get_db", return_value=fake_db), \
         patch.object(radio_studio, "_get_eleven_client", return_value=fake_client):
        r = client.post("/api/admin/radio-studio/ads/ad-long/test-voice")

    assert r.status_code == 200
    sent = captured["text"]
    # Under-or-equal to the budget, NOT the full script.
    assert len(sent) <= radio_studio._TEST_VOICE_CHAR_BUDGET
    assert len(sent) < len(long_script)
    # Ends at a natural boundary (full-stop) — not mid-word.
    assert sent.rstrip().endswith(".")


def test_test_voice_does_not_touch_stored_audio(client, admin_override):
    """The test-voice endpoint MUST NOT call update_one on the ad
    doc — preview is throwaway. Source-level check."""
    from routes import radio_studio
    src = inspect.getsource(radio_studio.test_ad_voice)
    assert "update_one" not in src, (
        "test_ad_voice must not modify the ad doc — it's a preview."
    )
    assert "insert_one" not in src


def test_test_voice_does_not_apply_music_bed(client, admin_override):
    """Preview is voice-only so the admin can hear pronunciations
    clearly without a bed dipping under. Source check."""
    from routes import radio_studio
    src = inspect.getsource(radio_studio.test_ad_voice)
    assert "_mix_voice_with_bed" not in src
    assert "bed_music_id" not in src


def test_test_voice_400_when_no_script(client, admin_override):
    """An empty script means there's nothing to preview — surface
    a clear 400 rather than a vague ElevenLabs 'empty input' 502."""
    from routes import radio_studio
    fake_db = MagicMock()
    fake_db.radio_studio_ads.find_one = AsyncMock(return_value={
        "id": "ad-empty", "script": "", "voice_id": "v",
    })
    with patch.object(radio_studio, "get_db", return_value=fake_db):
        r = client.post("/api/admin/radio-studio/ads/ad-empty/test-voice")
    assert r.status_code == 400
    assert "script" in r.json()["detail"].lower()


def test_test_voice_400_when_no_voice_selected(client, admin_override):
    from routes import radio_studio
    fake_db = MagicMock()
    fake_db.radio_studio_ads.find_one = AsyncMock(return_value={
        "id": "ad-no-voice", "script": "Hello world.", "voice_id": "",
    })
    with patch.object(radio_studio, "get_db", return_value=fake_db):
        r = client.post("/api/admin/radio-studio/ads/ad-no-voice/test-voice")
    assert r.status_code == 400
    assert "voice" in r.json()["detail"].lower()


def test_test_voice_404_when_ad_missing(client, admin_override):
    from routes import radio_studio
    fake_db = MagicMock()
    fake_db.radio_studio_ads.find_one = AsyncMock(return_value=None)
    with patch.object(radio_studio, "get_db", return_value=fake_db):
        r = client.post("/api/admin/radio-studio/ads/does-not-exist/test-voice")
    assert r.status_code == 404


def test_test_voice_502_on_elevenlabs_failure(client, admin_override):
    from routes import radio_studio

    fake_ad = {
        "id": "ad-1",
        "script": "Hello.",
        "voice_id": "v",
        "stability": 0.5, "similarity_boost": 0.75, "style": 0.0,
        "model_id": "eleven_multilingual_v2",
    }
    fake_db = MagicMock()
    fake_db.radio_studio_ads.find_one = AsyncMock(return_value=fake_ad)

    fake_client = MagicMock()
    fake_client.text_to_speech.convert.side_effect = RuntimeError("Quota exceeded")

    with patch.object(radio_studio, "get_db", return_value=fake_db), \
         patch.object(radio_studio, "_get_eleven_client", return_value=fake_client):
        r = client.post("/api/admin/radio-studio/ads/ad-1/test-voice")
    assert r.status_code == 502
    assert "Quota exceeded" in r.json()["detail"]


def test_test_voice_admin_only():
    """Source check — _require_admin gate must be the first call."""
    from routes import radio_studio
    src = inspect.getsource(radio_studio.test_ad_voice)
    body = src.split("):\n", 1)[1].split("\n")
    # Find the first non-docstring, non-comment line that calls
    # _require_admin. It must appear before any db lookup.
    require_idx = next(
        (i for i, ln in enumerate(body) if "_require_admin(" in ln), -1,
    )
    db_idx = next(
        (i for i, ln in enumerate(body) if "find_one(" in ln), 9999,
    )
    assert require_idx != -1, "test_ad_voice MUST call _require_admin"
    assert require_idx < db_idx, "_require_admin must be called BEFORE db lookup"

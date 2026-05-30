"""
Regression tests for the Radio Studio backend (24 May 2026, user-
requested in-store AI radio feature for 4 showrooms).

Smoke-tests the contract — the actual ElevenLabs API call is NOT
hit here (network + cost) but the route registration, request models,
auth gates, and storage scaffolding are all covered.
"""
from __future__ import annotations

import inspect

import pytest


def test_radio_studio_router_registered():
    """The router is exposed under /api/admin/radio-studio and the
    public stream router under /api/radio-studio."""
    from routes import radio_studio_router, radio_studio_public_router
    assert radio_studio_router.prefix == "/admin/radio-studio"
    assert radio_studio_public_router.prefix == "/radio-studio"


def test_create_ad_request_model_validates():
    from routes.radio_studio import AdCreate
    # Happy path
    a = AdCreate(name="Sale", script="Test", voice_id="abc")
    assert a.model_id == "eleven_multilingual_v2"
    assert a.stability == 0.5
    assert a.similarity_boost == 0.75
    assert a.style == 0.0
    # Voice settings are clamped 0..1
    with pytest.raises(Exception):
        AdCreate(name="x", script="x", voice_id="x", stability=1.5)
    with pytest.raises(Exception):
        AdCreate(name="x", script="x", voice_id="x", stability=-0.1)
    # Script length capped at 4000 (sanity — ElevenLabs charges per char)
    with pytest.raises(Exception):
        AdCreate(name="x", script="A" * 4001, voice_id="x")


def test_playlist_item_types_restricted():
    from routes.radio_studio import PlaylistItem
    PlaylistItem(type="ad", ref_id="x")
    PlaylistItem(type="music", ref_id="x")
    with pytest.raises(Exception):
        PlaylistItem(type="podcast", ref_id="x")


def test_admin_required_helper_blocks_non_admins():
    from fastapi import HTTPException
    from routes.radio_studio import _require_admin
    # Allow
    _require_admin({"role": "super_admin"})
    _require_admin({"role": "admin"})
    _require_admin({"role": "manager"})
    # Block
    for bad in ({"role": "customer"}, {"role": None}, {}, None):
        with pytest.raises(HTTPException) as exc:
            _require_admin(bad)
        assert exc.value.status_code == 403


def test_generate_endpoint_calls_elevenlabs_with_correct_settings():
    """Inspect the source to confirm the generate endpoint:
      • passes the script as `text=`
      • uses the saved voice_id
      • forwards stability/similarity_boost/style into VoiceSettings
      • requests mp3_44100_128 output (the in-store-speaker friendly format)"""
    from routes import radio_studio
    src = inspect.getsource(radio_studio.generate_ad_audio)
    assert "client.text_to_speech.convert" in src
    assert "text=ad" in src
    assert 'voice_id=ad["voice_id"]' in src
    assert 'output_format="mp3_44100_128"' in src
    assert "VoiceSettings(" in src
    assert "stability=" in src
    assert "similarity_boost=" in src


def test_storage_dirs_exist():
    """The filesystem storage dirs are created at import time so the
    very first ad generation doesn't crash with FileNotFoundError."""
    from routes.radio_studio import ADS_DIR, MUSIC_DIR
    assert ADS_DIR.is_dir(), f"Ads dir missing: {ADS_DIR}"
    assert MUSIC_DIR.is_dir(), f"Music dir missing: {MUSIC_DIR}"


def test_delete_ad_strips_from_playlists():
    """Deleting an ad must remove it from any saved playlist so the
    stream loop doesn't 404 on a dangling reference."""
    from routes import radio_studio
    src = inspect.getsource(radio_studio.delete_ad)
    # Pulls the matching item from the items array on every playlist.
    assert "radio_studio_playlists" in src
    assert "$pull" in src
    assert '"type": "ad"' in src


def test_delete_music_strips_from_playlists():
    from routes import radio_studio
    src = inspect.getsource(radio_studio.delete_music)
    assert "radio_studio_playlists" in src
    assert "$pull" in src
    assert '"type": "music"' in src


def test_voice_sync_returns_all_voices():
    """24 May 2026 — was English-filtered, but the heuristic was too
    aggressive and rejected accounts whose voice labels had no
    `language` field or used unusual values. The backend now returns
    ALL voices from ElevenLabs; the frontend groups by accent so UK
    English surfaces first naturally."""
    from routes import radio_studio
    src = inspect.getsource(radio_studio.sync_voices)
    # No English filter loop short-circuit anymore.
    assert "is_english" not in src
    # But the voice DOES still carry its language label so the
    # frontend can show that info in the dropdown.
    assert '"language":' in src


def test_voice_sync_avoids_objectid_leak():
    """24 May 2026 — PyMongo's insert_many MUTATES the input dicts
    to add `_id: ObjectId(...)`. If we then `return {'voices': cached}`
    using the same list, that ObjectId trips FastAPI's JSON encoder
    → 500. We must copy each dict before inserting.

    This bug silently killed the FIRST voice sync on every fresh
    deployment, leaving the dropdown empty — root cause of the
    user-reported 'It doesn't give me any option to pick a voice'
    bug on production (24 May 2026 evening)."""
    from routes import radio_studio
    src = inspect.getsource(radio_studio.sync_voices)
    # The insert_many call must use a shallow copy of each dict
    # (dict(c) for c in cached) — not the cached list directly.
    assert "dict(c) for c in cached" in src, (
        "insert_many must take a shallow copy of each cached dict "
        "to avoid PyMongo mutating the originals with ObjectId"
    )


def test_public_stream_endpoint_does_not_require_auth():
    """The public stream router must NOT call get_current_user. If it
    did, the in-store speakers (which run unauthenticated) would 401."""
    from routes import radio_studio
    src = inspect.getsource(radio_studio.stream_ad)
    assert "current_user" not in src
    src2 = inspect.getsource(radio_studio.stream_music)
    assert "current_user" not in src2

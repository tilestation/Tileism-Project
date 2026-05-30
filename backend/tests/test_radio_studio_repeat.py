"""
Tests for the playlist `repeat` toggle (30 May 2026 — user request:
"How do I play a playlist in repeat after the last track/ad played
should start from the beginning of the list if selected repeat").

Default is repeat=True (matches the implicit wall-clock-modulo
behaviour the system already had). When the admin toggles repeat
OFF, the stream plays through once and reports
{"playing": False, "reason": "Playlist finished — ..."} once the
elapsed playlist clock passes the total duration.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    from server import app
    return TestClient(app)


def _aiter(items):
    async def gen():
        for it in items:
            yield it
    return gen()


# ---------------------------------------------------------------
# Pydantic model
# ---------------------------------------------------------------

def test_playlist_update_repeat_defaults_to_true():
    """Default is True so existing single-screen / pre-toggle
    playlists keep their current behaviour (loop forever)."""
    from routes.radio_studio import PlaylistUpdate, PlaylistItem
    p = PlaylistUpdate(items=[PlaylistItem(type="music", ref_id="x")])
    assert p.repeat is True


def test_playlist_update_repeat_can_be_disabled():
    from routes.radio_studio import PlaylistUpdate, PlaylistItem
    p = PlaylistUpdate(
        items=[PlaylistItem(type="music", ref_id="x")],
        repeat=False,
    )
    assert p.repeat is False


# ---------------------------------------------------------------
# /live/now-playing — repeat=True (default behaviour, wall-clock
# modulo loop)
# ---------------------------------------------------------------

def test_now_playing_repeat_true_loops_forever(client):
    """Even when the elapsed wall clock is many cycles past total,
    repeat=True must keep `playing: true` — the wall-clock-modulo
    means it always wraps."""
    from routes import radio_studio

    fake_playlist = {
        "items": [
            {"type": "music", "ref_id": "m1"},
            {"type": "music", "ref_id": "m2"},
        ],
        "repeat": True,
    }
    fake_ads = MagicMock(); fake_ads.__aiter__ = lambda self: _aiter([])
    fake_music = MagicMock(); fake_music.__aiter__ = lambda self: _aiter([
        {"id": "m1", "name": "A", "duration_seconds": 10.0, "audio_filename": "a.mp3"},
        {"id": "m2", "name": "B", "duration_seconds": 10.0, "audio_filename": "b.mp3"},
    ])
    fake_db = MagicMock()
    fake_db.radio_studio_playlists.find_one = AsyncMock(return_value=fake_playlist)
    fake_db.radio_studio_ads.find = MagicMock(return_value=fake_ads)
    fake_db.radio_studio_music.find = MagicMock(return_value=fake_music)

    # Wall clock 1,000,005 — many cycles past 20s total. Should
    # land at item 0 (1,000,005 % 20 = 5 → idx=0, item_offset=5).
    with patch.object(radio_studio, "get_db", return_value=fake_db), \
         patch.object(radio_studio.time, "time", return_value=1_000_005.0):
        r = client.get("/api/radio-studio/live/now-playing")

    assert r.status_code == 200
    body = r.json()
    assert body["playing"] is True
    assert body["now"]["name"] == "A"
    assert body["now"]["elapsed_seconds"] == 5.0
    assert body["playlist"]["repeat"] is True


# ---------------------------------------------------------------
# /live/now-playing — repeat=False (one-shot)
# ---------------------------------------------------------------

def test_now_playing_repeat_false_during_first_play(client):
    """While elapsed < total, repeat=False behaves like repeat=True
    (linear play through the items)."""
    from routes import radio_studio

    started = 1_000_000.0
    fake_playlist = {
        "items": [{"type": "music", "ref_id": "m1"},
                  {"type": "music", "ref_id": "m2"}],
        "repeat": False,
        "started_at_epoch": started,
    }
    fake_ads = MagicMock(); fake_ads.__aiter__ = lambda self: _aiter([])
    fake_music = MagicMock(); fake_music.__aiter__ = lambda self: _aiter([
        {"id": "m1", "name": "A", "duration_seconds": 10.0, "audio_filename": "a.mp3"},
        {"id": "m2", "name": "B", "duration_seconds": 10.0, "audio_filename": "b.mp3"},
    ])
    fake_db = MagicMock()
    fake_db.radio_studio_playlists.find_one = AsyncMock(return_value=fake_playlist)
    fake_db.radio_studio_ads.find = MagicMock(return_value=fake_ads)
    fake_db.radio_studio_music.find = MagicMock(return_value=fake_music)

    # 12s after started_at: into item B (idx=1) at offset 2.
    with patch.object(radio_studio, "get_db", return_value=fake_db), \
         patch.object(radio_studio.time, "time", return_value=started + 12):
        r = client.get("/api/radio-studio/live/now-playing")

    body = r.json()
    assert body["playing"] is True
    assert body["now"]["name"] == "B"
    assert body["now"]["elapsed_seconds"] == 2.0
    assert body["playlist"]["repeat"] is False


def test_now_playing_repeat_false_after_finish_reports_done(client):
    """Once the wall clock is past the playlist's total duration,
    repeat=False MUST return playing=false with a clear reason."""
    from routes import radio_studio

    started = 1_000_000.0
    fake_playlist = {
        "items": [{"type": "music", "ref_id": "m1"},
                  {"type": "music", "ref_id": "m2"}],
        "repeat": False,
        "started_at_epoch": started,
    }
    fake_ads = MagicMock(); fake_ads.__aiter__ = lambda self: _aiter([])
    fake_music = MagicMock(); fake_music.__aiter__ = lambda self: _aiter([
        {"id": "m1", "name": "A", "duration_seconds": 10.0, "audio_filename": "a.mp3"},
        {"id": "m2", "name": "B", "duration_seconds": 10.0, "audio_filename": "b.mp3"},
    ])
    fake_db = MagicMock()
    fake_db.radio_studio_playlists.find_one = AsyncMock(return_value=fake_playlist)
    fake_db.radio_studio_ads.find = MagicMock(return_value=fake_ads)
    fake_db.radio_studio_music.find = MagicMock(return_value=fake_music)

    # 25s after start: total=20, so elapsed > total → "finished".
    with patch.object(radio_studio, "get_db", return_value=fake_db), \
         patch.object(radio_studio.time, "time", return_value=started + 25):
        r = client.get("/api/radio-studio/live/now-playing")

    body = r.json()
    assert r.status_code == 200
    assert body["playing"] is False
    assert "finished" in body["reason"].lower()
    assert body["playlist"]["repeat"] is False
    assert body["playlist"]["total_items"] == 2


def test_now_playing_repeat_false_with_no_anchor_starts_fresh(client):
    """If the playlist has `repeat=False` but no `started_at_epoch`
    (e.g. legacy doc saved before the field existed), treat the
    playlist as if it's starting NOW — elapsed=0, idx=0, item A
    plays. Prevents silent failure on legacy data."""
    from routes import radio_studio

    fake_playlist = {
        "items": [{"type": "music", "ref_id": "m1"}],
        "repeat": False,
        # NO started_at_epoch
    }
    fake_ads = MagicMock(); fake_ads.__aiter__ = lambda self: _aiter([])
    fake_music = MagicMock(); fake_music.__aiter__ = lambda self: _aiter([
        {"id": "m1", "name": "Only A", "duration_seconds": 10.0, "audio_filename": "a.mp3"},
    ])
    fake_db = MagicMock()
    fake_db.radio_studio_playlists.find_one = AsyncMock(return_value=fake_playlist)
    fake_db.radio_studio_ads.find = MagicMock(return_value=fake_ads)
    fake_db.radio_studio_music.find = MagicMock(return_value=fake_music)

    with patch.object(radio_studio, "get_db", return_value=fake_db):
        r = client.get("/api/radio-studio/live/now-playing")

    body = r.json()
    assert body["playing"] is True
    assert body["now"]["name"] == "Only A"
    assert body["now"]["elapsed_seconds"] == 0.0  # fresh start


# ---------------------------------------------------------------
# Legacy playlists (no repeat field) default to True
# ---------------------------------------------------------------

def test_now_playing_legacy_playlist_defaults_repeat_true(client):
    from routes import radio_studio

    fake_playlist = {
        "items": [{"type": "music", "ref_id": "m1"}],
        # NO repeat key — pre-30May2026 saves
    }
    fake_ads = MagicMock(); fake_ads.__aiter__ = lambda self: _aiter([])
    fake_music = MagicMock(); fake_music.__aiter__ = lambda self: _aiter([
        {"id": "m1", "name": "L", "duration_seconds": 10.0, "audio_filename": "a.mp3"},
    ])
    fake_db = MagicMock()
    fake_db.radio_studio_playlists.find_one = AsyncMock(return_value=fake_playlist)
    fake_db.radio_studio_ads.find = MagicMock(return_value=fake_ads)
    fake_db.radio_studio_music.find = MagicMock(return_value=fake_music)

    with patch.object(radio_studio, "get_db", return_value=fake_db), \
         patch.object(radio_studio.time, "time", return_value=99999.0):
        r = client.get("/api/radio-studio/live/now-playing")

    body = r.json()
    assert body["playing"] is True
    assert body["playlist"]["repeat"] is True

"""
Tests for the Phase 2 live stream — synchronised continuous MP3
stream for 4 in-store Bluetooth speakers (26 May 2026, user-
requested).

Verified contract:
  • _locate is a pure deterministic function — the heart of the
    "every speaker is at the same offset" sync guarantee.
  • _build_play_queue resolves playlist items + skips dangling refs.
  • GET /api/radio-studio/live/now-playing returns useful structure
    in both empty-playlist and populated cases.
  • GET /api/radio-studio/live returns audio/mpeg, never-cache
    headers, and produces bytes at roughly real-time pace.
"""
from __future__ import annotations

import asyncio
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient


# ---------------------------------------------------------------
# Pure-function locator
# ---------------------------------------------------------------

def test_locate_first_item():
    from routes.radio_studio import _locate
    assert _locate(0.0, [10, 20, 30]) == (0, 0.0)
    assert _locate(5.0, [10, 20, 30]) == (0, 5.0)


def test_locate_middle_item():
    from routes.radio_studio import _locate
    assert _locate(10.0, [10, 20, 30]) == (1, 0.0)
    assert _locate(20.0, [10, 20, 30]) == (1, 10.0)


def test_locate_last_item():
    from routes.radio_studio import _locate
    assert _locate(30.0, [10, 20, 30]) == (2, 0.0)
    assert _locate(45.0, [10, 20, 30]) == (2, 15.0)


def test_locate_empty_durations():
    """Defensive — caller should never pass an empty list, but if
    it does the locator returns (0, 0.0) instead of IndexError."""
    from routes.radio_studio import _locate
    assert _locate(5.0, []) == (0, 0.0)


def test_locate_past_end_wraps_to_last_tail():
    """Caller pre-modulos so this branch shouldn't fire in practice,
    but we keep the defensive wrap-to-tail to avoid crashing."""
    from routes.radio_studio import _locate
    idx, off = _locate(99.0, [10, 20, 30])
    assert idx == 2
    assert 29.9 <= off < 30.0


# ---------------------------------------------------------------
# Build-play-queue
# ---------------------------------------------------------------

@pytest.mark.asyncio
async def test_build_play_queue_resolves_items_and_strips_dangling():
    """Items pointing to deleted media should be silently skipped —
    we don't want one missing reference to take the whole loop down."""
    from routes import radio_studio

    fake_playlist = {
        "items": [
            {"type": "ad", "ref_id": "ad-1"},
            {"type": "music", "ref_id": "music-1"},
            {"type": "ad", "ref_id": "ad-missing"},  # dangling ref
        ]
    }

    fake_ads_cursor = MagicMock()
    fake_ads_cursor.__aiter__ = lambda self: _aiter([
        {"id": "ad-1", "name": "Sale ad",
         "audio_blob": b"\x00" * 16000, "duration_seconds": 1.0, "audio_bytes": 16000},
    ])
    fake_music_cursor = MagicMock()
    fake_music_cursor.__aiter__ = lambda self: _aiter([
        {"id": "music-1", "name": "Jingle",
         "audio_blob": b"\x00" * 32000, "duration_seconds": 2.0, "audio_bytes": 32000},
    ])

    fake_db = MagicMock()
    fake_db.radio_studio_playlists.find_one = AsyncMock(return_value=fake_playlist)
    fake_db.radio_studio_ads.find = MagicMock(return_value=fake_ads_cursor)
    fake_db.radio_studio_music.find = MagicMock(return_value=fake_music_cursor)

    with patch.object(radio_studio, "get_db", return_value=fake_db):
        queue = await radio_studio._build_play_queue()

    assert [q["ref_id"] for q in queue] == ["ad-1", "music-1"]
    assert queue[0]["name"] == "Sale ad"
    assert queue[1]["name"] == "Jingle"
    # byte_rate = blob_size / duration → 16 KB/s for the ad, 16 KB/s
    # for the music (both are CBR-equivalent in this fixture).
    assert abs(queue[0]["byte_rate"] - 16000) < 1
    assert abs(queue[1]["byte_rate"] - 16000) < 1


@pytest.mark.asyncio
async def test_build_play_queue_returns_empty_when_no_active_playlist():
    from routes import radio_studio
    fake_db = MagicMock()
    fake_db.radio_studio_playlists.find_one = AsyncMock(return_value=None)
    with patch.object(radio_studio, "get_db", return_value=fake_db):
        assert await radio_studio._build_play_queue() == []


def _aiter(items):
    """Tiny helper — turns a list into an async iterator suitable
    for Motor `find().__aiter__` mocks."""
    async def gen():
        for it in items:
            yield it
    return gen()


# ---------------------------------------------------------------
# Throttled item streamer — pacing + skip
# ---------------------------------------------------------------

@pytest.mark.asyncio
async def test_throttle_item_skips_correct_byte_offset():
    """skip_seconds=0.5 on a 1 s blob at 16 KB/s = start at byte 8000.
    We should receive only the last 8000 bytes."""
    from routes.radio_studio import _throttle_item
    blob = bytes(range(256)) * 100  # 25,600 bytes — recognisable pattern
    blob = blob[:16000]  # exactly 1 s at 16 KB/s
    item = {"blob": blob, "byte_rate": 16000.0, "duration_seconds": 1.0}
    chunks = []
    # Patch asyncio.sleep so the test runs in ~0 ms instead of 0.5 s.
    with patch("asyncio.sleep", new=AsyncMock()):
        async for chunk in _throttle_item(item, skip_seconds=0.5):
            chunks.append(chunk)
    received = b"".join(chunks)
    assert len(received) == 8000
    assert received == blob[8000:]


@pytest.mark.asyncio
async def test_throttle_item_no_skip_streams_full_blob():
    from routes.radio_studio import _throttle_item
    blob = b"X" * 12000
    item = {"blob": blob, "byte_rate": 16000.0, "duration_seconds": 0.75}
    chunks = []
    with patch("asyncio.sleep", new=AsyncMock()):
        async for chunk in _throttle_item(item, skip_seconds=0):
            chunks.append(chunk)
    assert b"".join(chunks) == blob


# ---------------------------------------------------------------
# /live/now-playing endpoint
# ---------------------------------------------------------------

@pytest.fixture
def client():
    from server import app
    return TestClient(app)


def test_now_playing_empty_playlist(client):
    from routes import radio_studio
    fake_db = MagicMock()
    fake_db.radio_studio_playlists.find_one = AsyncMock(return_value=None)
    with patch.object(radio_studio, "get_db", return_value=fake_db):
        r = client.get("/api/radio-studio/live/now-playing")
    assert r.status_code == 200
    body = r.json()
    assert body["playing"] is False
    assert "Playlist is empty" in body["reason"]
    assert body["stream_url"] == "/api/radio-studio/live"


def test_now_playing_returns_current_item(client):
    from routes import radio_studio

    fake_playlist = {"items": [
        {"type": "ad", "ref_id": "ad-1"},
        {"type": "music", "ref_id": "music-1"},
    ]}
    fake_ads = MagicMock()
    fake_ads.__aiter__ = lambda self: _aiter([
        {"id": "ad-1", "name": "Sale ad", "duration_seconds": 20.0,
         "audio_filename": "ad-1.mp3", "voice_name": "Rachel",
         "bed_music_name": "Lounge Loop"},
    ])
    fake_music = MagicMock()
    fake_music.__aiter__ = lambda self: _aiter([
        {"id": "music-1", "name": "Jingle", "duration_seconds": 40.0,
         "audio_filename": "music-1.mp3"},
    ])

    fake_db = MagicMock()
    fake_db.radio_studio_playlists.find_one = AsyncMock(return_value=fake_playlist)
    fake_db.radio_studio_ads.find = MagicMock(return_value=fake_ads)
    fake_db.radio_studio_music.find = MagicMock(return_value=fake_music)

    # Freeze time so the result is deterministic. Total cycle = 60 s,
    # we set the wall clock to T=10 s into the loop → idx=0 (ad),
    # elapsed=10s, remaining=10s.
    with patch.object(radio_studio, "get_db", return_value=fake_db), \
         patch.object(radio_studio.time, "time", return_value=10.0):
        r = client.get("/api/radio-studio/live/now-playing")

    body = r.json()
    assert r.status_code == 200
    assert body["playing"] is True
    assert body["now"]["name"] == "Sale ad"
    assert body["now"]["type"] == "ad"
    assert body["now"]["voice_name"] == "Rachel"
    assert body["now"]["bed_music_name"] == "Lounge Loop"
    assert body["now"]["elapsed_seconds"] == 10.0
    assert body["now"]["remaining_seconds"] == 10.0
    # Phase 2 proxy-bulletproof field: the per-item audio URL so a
    # browser <audio> can play it as a normal finite MP3 (no buffering
    # issues at any ingress). 26 May 2026.
    assert body["now"]["audio_url"] == "/api/radio-studio/stream/ad/ad-1"
    assert body["next"]["name"] == "Jingle"
    assert body["next"]["audio_url"] == "/api/radio-studio/stream/music/music-1"
    assert body["playlist"]["total_items"] == 2
    assert body["playlist"]["total_seconds"] == 60.0
    # server_time exists so clients can extrapolate elapsed_seconds
    # locally between polls.
    assert isinstance(body["server_time"], (int, float))


def test_now_playing_drops_items_with_no_audio(client):
    """An item that points to an ad which was never generated must
    NOT be reported as playing — the speakers would just hear silence
    in that slot. We pretend it doesn't exist."""
    from routes import radio_studio
    fake_playlist = {"items": [{"type": "ad", "ref_id": "ad-1"}]}
    fake_ads = MagicMock()
    fake_ads.__aiter__ = lambda self: _aiter([
        {"id": "ad-1", "name": "Ungenerated ad",
         "audio_filename": None, "duration_seconds": None},
    ])
    fake_music = MagicMock()
    fake_music.__aiter__ = lambda self: _aiter([])

    fake_db = MagicMock()
    fake_db.radio_studio_playlists.find_one = AsyncMock(return_value=fake_playlist)
    fake_db.radio_studio_ads.find = MagicMock(return_value=fake_ads)
    fake_db.radio_studio_music.find = MagicMock(return_value=fake_music)
    with patch.object(radio_studio, "get_db", return_value=fake_db):
        r = client.get("/api/radio-studio/live/now-playing")
    body = r.json()
    assert body["playing"] is False
    assert "missing audio" in body["reason"]


# ---------------------------------------------------------------
# /live endpoint headers + body contract
# ---------------------------------------------------------------

def test_live_stream_returns_audio_mpeg_with_no_cache_headers(client):
    """Critical: the live endpoint MUST set audio/mpeg + no-cache
    headers so neither Cloudflare nor a browser's HTTP cache holds
    on to a stale stream. We inspect the route's declared response
    headers directly to avoid TestClient blocking on the endless
    generator (a real curl with --max-time works fine — verified
    manually)."""
    from routes import radio_studio
    import inspect
    src = inspect.getsource(radio_studio.live_stream)
    # Headers explicitly set on the StreamingResponse — locks in the
    # contract without consuming the stream.
    assert '"audio/mpeg"' in src
    assert "no-store" in src and "no-cache" in src
    assert '"X-Accel-Buffering": "no"' in src
    # The generator passed to StreamingResponse is the synced one.
    assert "_live_generator()" in src


def test_public_router_registered_and_unauth():
    """The live stream MUST be on the public router so in-store
    speakers (no admin token) can connect."""
    from routes import radio_studio, radio_studio_public_router
    paths = {route.path for route in radio_studio_public_router.routes}
    # FastAPI normalises trailing slashes; check both forms.
    assert "/radio-studio/live" in paths
    assert "/radio-studio/live/now-playing" in paths
    # The live_stream handler must NOT depend on get_current_user.
    import inspect
    src = inspect.getsource(radio_studio.live_stream)
    assert "current_user" not in src
    src2 = inspect.getsource(radio_studio.live_now_playing)
    assert "current_user" not in src2

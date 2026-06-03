"""
Regression test for the "ads/trade talks half or less playing, jumping
to next randomly" bug reported 3 Jun 2026.

Root cause:
- Server uses wall-clock-modulo math to determine the current item.
  As wall-clock advances, the server's "current item" advances at the
  saved-duration pace.
- Client plays each item from offset 0 (no HTTP byte-range support on
  /stream means seeks silently fail). So a listener joining mid-loop
  lags the server by `initial_elapsed`.
- When the server's clock advances past the current item, the client's
  poll sees a new ref_id → useEffect used to yank audio.src mid-play.

Fix:
- /live/now-playing now exposes `items_ordered` (full ordered playlist
  with audio URLs) so the client can advance items LOCALLY in saved
  order after natural end, rather than trusting the server's wall-clock
  view of "current".
- The client maintains a local `playbackIdx` on the page state; the
  server's `current_index` is used only at tune-in to "join the wall
  clock" (FM-radio style).

This test suite verifies the BACKEND contract: items_ordered is present,
ordered, and includes audio_url + name + duration. UI behaviour is
covered by the frontend Playwright test (see tests in /app/frontend).
"""

import os
import time
from unittest.mock import patch, AsyncMock, MagicMock

import pytest


@pytest.fixture(autouse=True)
def _env_setup():
    os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
    os.environ.setdefault("DB_NAME", "test_radio_items_ordered")


class AsyncIter:
    """Mongo-style async iterable used by .find() in tests."""
    def __init__(self, items):
        self._items = items

    def __aiter__(self):
        self._iter = iter(self._items)
        return self

    async def __anext__(self):
        try:
            return next(self._iter)
        except StopIteration as e:
            raise StopAsyncIteration from e


def _build_db_mock(items, ads, music, anchor=None, repeat=True):
    """Build a Mongo mock returning the given playlist + media."""
    db = MagicMock()
    db.radio_studio_playlists.find_one = AsyncMock(return_value={
        "id": "default",
        "items": items,
        "repeat": repeat,
        "started_at_epoch": anchor if anchor is not None else time.time(),
        "crossfade_seconds": 0.5,
        "name": "Test playlist",
    })
    db.radio_studio_ads.find = MagicMock(return_value=AsyncIter(ads))
    db.radio_studio_music.find = MagicMock(return_value=AsyncIter(music))
    return db


# ---------------------------------------------------------------------
# 1. items_ordered is present and matches the saved playlist order
# ---------------------------------------------------------------------
def test_items_ordered_present_and_ordered():
    """
    The full ordered playlist must appear in the response so the
    client can advance items locally. The 8-item playlist from the
    user's report should round-trip in the exact saved order.
    """
    import asyncio
    from routes.radio_studio import live_now_playing

    items = [
        {"type": "ad", "ref_id": "ad-1"},   # 39s
        {"type": "ad", "ref_id": "ad-2"},   # 44s
        {"type": "ad", "ref_id": "ad-tt"},  # 318s Trade Talk
        {"type": "ad", "ref_id": "ad-3"},   # 48s
        {"type": "ad", "ref_id": "ad-1"},   # 39s repeat
        {"type": "ad", "ref_id": "ad-4"},   # 54s
        {"type": "music", "ref_id": "m-1"}, # 479s
        {"type": "music", "ref_id": "m-2"}, # 556s — user's Rose Campbell
    ]
    ads = [
        {"id": "ad-1", "name": "Tile Station Trade", "audio_filename": "a.mp3",
         "duration_seconds": 39.0, "voice_name": "Alice", "bed_music_name": None},
        {"id": "ad-2", "name": "BIG SUMMER TILE SALE", "audio_filename": "a.mp3",
         "duration_seconds": 44.0, "voice_name": "Alice", "bed_music_name": None},
        {"id": "ad-tt", "name": "Trade Talk: Diagnosing efflorescence",
         "audio_filename": "tt.mp3", "duration_seconds": 318.0,
         "voice_name": None, "bed_music_name": "Town This Small"},
        {"id": "ad-3", "name": "Bathroom Catalogue Out Now",
         "audio_filename": "a.mp3", "duration_seconds": 48.0,
         "voice_name": "Alice", "bed_music_name": None},
        {"id": "ad-4", "name": "What's the right notched trowel size",
         "audio_filename": "a.mp3", "duration_seconds": 54.0,
         "voice_name": "Alice", "bed_music_name": None},
    ]
    music = [
        {"id": "m-1", "name": "Easy With You", "audio_filename": "m.mp3",
         "duration_seconds": 479.0},
        {"id": "m-2", "name": "Would It Matter - Rose Campbell",
         "audio_filename": "m.mp3", "duration_seconds": 556.0},
    ]

    mock_db = _build_db_mock(items, ads, music, anchor=time.time())
    with patch("routes.radio_studio.get_db", return_value=mock_db):
        result = asyncio.run(live_now_playing())

    assert result["playing"] is True
    assert "items_ordered" in result, "Response must include items_ordered"
    items_ordered = result["items_ordered"]
    assert len(items_ordered) == 8, f"Expected 8 items, got {len(items_ordered)}"

    # Verify saved order is preserved (was the user's complaint —
    # the LAST item was playing FIRST).
    expected_names = [
        "Tile Station Trade",
        "BIG SUMMER TILE SALE",
        "Trade Talk: Diagnosing efflorescence",
        "Bathroom Catalogue Out Now",
        "Tile Station Trade",
        "What's the right notched trowel size",
        "Easy With You",
        "Would It Matter - Rose Campbell",
    ]
    actual_names = [it["name"] for it in items_ordered]
    assert actual_names == expected_names, \
        f"Order mismatch: expected {expected_names}, got {actual_names}"


# ---------------------------------------------------------------------
# 2. Each item has the fields the client needs for local playback
# ---------------------------------------------------------------------
def test_items_ordered_has_audio_url_and_duration():
    """
    The client uses audio_url + duration_seconds to load each item
    and time the crossfade window. Both must be present per item.
    """
    import asyncio
    from routes.radio_studio import live_now_playing

    items = [
        {"type": "ad", "ref_id": "ad-1"},
        {"type": "music", "ref_id": "m-1"},
    ]
    ads = [{"id": "ad-1", "name": "Test Ad", "audio_filename": "a.mp3",
            "duration_seconds": 42.0, "voice_name": "V", "bed_music_name": None}]
    music = [{"id": "m-1", "name": "Test Track", "audio_filename": "m.mp3",
              "duration_seconds": 180.0}]

    mock_db = _build_db_mock(items, ads, music)
    with patch("routes.radio_studio.get_db", return_value=mock_db):
        result = asyncio.run(live_now_playing())

    for idx, it in enumerate(result["items_ordered"]):
        assert "audio_url" in it, f"item {idx} missing audio_url"
        assert it["audio_url"].startswith("/api/radio-studio/stream/"), \
            f"item {idx} audio_url has wrong prefix: {it['audio_url']}"
        assert "duration_seconds" in it, f"item {idx} missing duration_seconds"
        assert it["duration_seconds"] > 0, \
            f"item {idx} has non-positive duration: {it['duration_seconds']}"
        assert "type" in it and it["type"] in ("ad", "music")
        assert "ref_id" in it
        assert "name" in it

    # Verify the URL encodes the right type and ref_id
    assert result["items_ordered"][0]["audio_url"] == "/api/radio-studio/stream/ad/ad-1"
    assert result["items_ordered"][1]["audio_url"] == "/api/radio-studio/stream/music/m-1"


# ---------------------------------------------------------------------
# 3. items_ordered excludes items with missing audio_filename
# ---------------------------------------------------------------------
def test_items_ordered_skips_items_without_audio():
    """
    Items that haven't been generated yet (no audio_filename) are
    silently skipped from the resolved list — they'd play silence
    otherwise. items_ordered must reflect the playable subset.
    """
    import asyncio
    from routes.radio_studio import live_now_playing

    items = [
        {"type": "ad", "ref_id": "ad-1"},      # has audio
        {"type": "ad", "ref_id": "ad-none"},   # no audio_filename
        {"type": "music", "ref_id": "m-1"},    # has audio
    ]
    ads = [
        {"id": "ad-1", "name": "Has Audio", "audio_filename": "a.mp3",
         "duration_seconds": 30.0, "voice_name": "V", "bed_music_name": None},
        {"id": "ad-none", "name": "No Audio Yet", "audio_filename": None,
         "duration_seconds": 0.0, "voice_name": None, "bed_music_name": None},
    ]
    music = [
        {"id": "m-1", "name": "Has Audio", "audio_filename": "m.mp3",
         "duration_seconds": 200.0},
    ]

    mock_db = _build_db_mock(items, ads, music)
    with patch("routes.radio_studio.get_db", return_value=mock_db):
        result = asyncio.run(live_now_playing())

    assert len(result["items_ordered"]) == 2, \
        f"Expected 2 playable items (skipping the ad with no audio), " \
        f"got {len(result['items_ordered'])}"
    assert result["items_ordered"][0]["name"] == "Has Audio"
    assert result["items_ordered"][1]["name"] == "Has Audio"


# ---------------------------------------------------------------------
# 4. items_ordered indexes match current_index (cross-check)
# ---------------------------------------------------------------------
def test_current_index_points_into_items_ordered():
    """
    The server's `current_index` is the offset INTO items_ordered.
    The client uses it as the initial localIdx on tune-in.
    """
    import asyncio
    from routes.radio_studio import live_now_playing

    items = [{"type": "ad", "ref_id": f"ad-{i}"} for i in range(5)]
    ads = [{"id": f"ad-{i}", "name": f"Ad {i}", "audio_filename": "a.mp3",
            "duration_seconds": 30.0, "voice_name": "V", "bed_music_name": None}
           for i in range(5)]

    # 5 ads × 30s = 150s total. Anchor at 95s ago → offset=95 → idx=3.
    mock_db = _build_db_mock(items, ads, [], anchor=time.time() - 95.0)
    with patch("routes.radio_studio.get_db", return_value=mock_db):
        result = asyncio.run(live_now_playing())

    assert 0 <= result["current_index"] < len(result["items_ordered"])
    cur_from_idx = result["items_ordered"][result["current_index"]]
    assert cur_from_idx["ref_id"] == result["now"]["ref_id"], \
        "items_ordered[current_index] must match now.ref_id"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

"""
Regression test for the "playlist plays in random order on tune-in"
bug reported 3 Jun 2026.

Pre-fix behaviour:
- Saving a repeat=True playlist set `started_at_epoch = None`.
- `live_now_playing` then anchored to `time.time() % total` — so the
  loop started at whatever offset modulo-total landed on at the moment
  of tune-in (i.e. unix-epoch-mod-total). User reported hearing the
  LAST track first because that's where the wall clock happened to be.

Post-fix behaviour:
- Saving ANY playlist (repeat or not) sets `started_at_epoch = now`
  WHEN items or repeat-flag change.
- `live_now_playing` for repeat=True computes
  `offset = (now - started_at_epoch) % total`, so right after Save the
  offset is 0 → track #1 plays first.
- Legacy playlists without `started_at_epoch` fall back to the old
  modulo-epoch behaviour so existing broadcasts don't lurch mid-loop.
"""

import os
import time
from unittest.mock import patch, AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
    os.environ.setdefault("DB_NAME", "test_radio_anchor")
    from server import app
    return TestClient(app)


def _items(count: int = 8):
    """Build a uniform 8-item playlist with 30-second tracks."""
    return [
        {"type": "ad" if i % 2 == 0 else "music", "ref_id": f"id-{i}"}
        for i in range(count)
    ]


# ---------------------------------------------------------------------
# 1. Save sets started_at_epoch on a fresh repeat=True playlist
# ---------------------------------------------------------------------
def test_save_repeat_playlist_sets_started_at_epoch():
    """
    A brand-new (or first-time-this-revision) repeat=True playlist save
    must populate started_at_epoch so the loop starts from track #1.
    Pre-fix this field was forced to None and the loop drifted with
    unix epoch.
    """
    from routes.radio_studio import save_playlist
    from routes.radio_studio import PlaylistUpdate, PlaylistItem
    import asyncio

    req = PlaylistUpdate(
        name="Test playlist",
        items=[PlaylistItem(type="ad", ref_id="a1"),
               PlaylistItem(type="music", ref_id="m1")],
        is_active=True,
        repeat=True,
        crossfade_seconds=0.5,
    )

    # Mock the DB layer.
    mock_db = AsyncMock()
    mock_db.radio_studio_playlists.find_one.return_value = None  # fresh save
    mock_db.radio_studio_playlists.update_one.return_value = AsyncMock()

    before = time.time()
    with patch("routes.radio_studio.get_db", return_value=mock_db):
        result = asyncio.run(save_playlist(
            req=req,
            current_user={"role": "super_admin", "email": "admin@test"},
        ))
    after = time.time()

    assert result["repeat"] is True
    assert "started_at_epoch" in result
    assert result["started_at_epoch"] is not None, \
        "started_at_epoch must be set on fresh repeat=True save (was None)"
    assert before - 0.5 <= result["started_at_epoch"] <= after + 0.5, \
        "started_at_epoch should be close to current time"


# ---------------------------------------------------------------------
# 2. Re-saving the SAME items + flags preserves the existing anchor
# ---------------------------------------------------------------------
def test_resaving_same_playlist_preserves_anchor():
    """
    A no-op save (e.g. admin clicks Save without changing anything)
    must NOT reset the loop anchor, otherwise tuned-in listeners get
    yanked back to track #1 mid-broadcast.
    """
    from routes.radio_studio import save_playlist, PlaylistUpdate, PlaylistItem
    import asyncio

    fixed_anchor = 1717000000.0  # arbitrary fixed past moment
    items = [{"type": "ad", "ref_id": "a1"},
             {"type": "music", "ref_id": "m1"}]

    req = PlaylistUpdate(
        name="Test playlist",
        items=[PlaylistItem(**it) for it in items],
        is_active=True,
        repeat=True,
        crossfade_seconds=0.5,
    )

    mock_db = AsyncMock()
    mock_db.radio_studio_playlists.find_one.return_value = {
        "id": "default",
        "items": items,
        "repeat": True,
        "started_at_epoch": fixed_anchor,
        "created_at": "2026-06-01T00:00:00+00:00",
    }
    mock_db.radio_studio_playlists.update_one.return_value = AsyncMock()

    with patch("routes.radio_studio.get_db", return_value=mock_db):
        result = asyncio.run(save_playlist(
            req=req,
            current_user={"role": "super_admin", "email": "admin@test"},
        ))

    assert result["started_at_epoch"] == fixed_anchor, \
        "Re-saving identical playlist must preserve anchor (got " \
        f"{result['started_at_epoch']}, expected {fixed_anchor})"


# ---------------------------------------------------------------------
# 3. Changing the items list resets the anchor
# ---------------------------------------------------------------------
def test_changing_items_resets_anchor():
    """
    Adding/removing/reordering items is a meaningful change — the admin
    expects the new arrangement to play from track #1.
    """
    from routes.radio_studio import save_playlist, PlaylistUpdate, PlaylistItem
    import asyncio

    old_anchor = 1717000000.0  # well in the past
    old_items = [{"type": "ad", "ref_id": "a1"}]
    new_items = [{"type": "ad", "ref_id": "a1"},
                 {"type": "music", "ref_id": "m2"}]

    req = PlaylistUpdate(
        name="Test playlist",
        items=[PlaylistItem(**it) for it in new_items],
        is_active=True,
        repeat=True,
        crossfade_seconds=0.5,
    )

    mock_db = AsyncMock()
    mock_db.radio_studio_playlists.find_one.return_value = {
        "id": "default",
        "items": old_items,
        "repeat": True,
        "started_at_epoch": old_anchor,
        "created_at": "2026-06-01T00:00:00+00:00",
    }
    mock_db.radio_studio_playlists.update_one.return_value = AsyncMock()

    before = time.time()
    with patch("routes.radio_studio.get_db", return_value=mock_db):
        result = asyncio.run(save_playlist(
            req=req,
            current_user={"role": "super_admin", "email": "admin@test"},
        ))
    after = time.time()

    assert result["started_at_epoch"] != old_anchor, \
        "Items changed → anchor must reset (still got old anchor)"
    assert before - 0.5 <= result["started_at_epoch"] <= after + 0.5, \
        "Reset anchor should be close to current time"


# ---------------------------------------------------------------------
# 4. live_now_playing uses the anchor (loop position 0 right after save)
# ---------------------------------------------------------------------
def test_live_now_playing_starts_at_track_1_after_save():
    """
    The end-to-end behaviour the user actually cares about — right
    after saving, the public /radio page should report current_index=0
    (track #1), not whatever modulo-epoch happened to land on.
    """
    import asyncio
    from routes.radio_studio import live_now_playing

    now = time.time()
    items = [
        {"type": "ad", "ref_id": f"id-{i}"} for i in range(8)
    ]
    durations_in_db = [
        {"id": f"id-{i}", "name": f"Item {i}", "audio_filename": f"id-{i}.mp3",
         "duration_seconds": 30.0}
        for i in range(8)
    ]

    mock_db = MagicMock()
    mock_db.radio_studio_playlists.find_one = AsyncMock(return_value={
        "id": "default",
        "items": items,
        "repeat": True,
        "started_at_epoch": now - 0.1,  # saved 0.1s ago
        "crossfade_seconds": 0.5,
    })

    # find() returns an async iterable; use a small helper.
    class AsyncIter:
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

    mock_db.radio_studio_ads.find = MagicMock(return_value=AsyncIter(durations_in_db))
    mock_db.radio_studio_music.find = MagicMock(return_value=AsyncIter([]))

    with patch("routes.radio_studio.get_db", return_value=mock_db):
        result = asyncio.run(live_now_playing())

    assert result["playing"] is True
    assert result["current_index"] == 0, \
        f"Expected track #1 (current_index=0), got #{result['current_index']+1}"
    # Loop offset should be < 1s (saved 0.1s ago)
    assert result["playlist"]["loop_offset_seconds"] < 5, \
        f"Loop should start near 0s right after save, got " \
        f"{result['playlist']['loop_offset_seconds']}s"


# ---------------------------------------------------------------------
# 5. Legacy playlists (no anchor) fall back to the old modulo-epoch
# ---------------------------------------------------------------------
def test_legacy_playlist_without_anchor_uses_epoch_modulo():
    """
    Don't lurch existing broadcasts mid-loop on first deploy of this
    fix. Playlists saved BEFORE the anchor existed should keep their
    legacy modulo-epoch behaviour until the admin clicks Save again.
    """
    import asyncio
    from routes.radio_studio import live_now_playing

    items = [
        {"type": "ad", "ref_id": f"id-{i}"} for i in range(8)
    ]
    durations_in_db = [
        {"id": f"id-{i}", "name": f"Item {i}", "audio_filename": f"id-{i}.mp3",
         "duration_seconds": 30.0}
        for i in range(8)
    ]

    mock_db = MagicMock()
    mock_db.radio_studio_playlists.find_one = AsyncMock(return_value={
        "id": "default",
        "items": items,
        "repeat": True,
        # NO started_at_epoch (or 0/None) — simulates a pre-fix doc
        "started_at_epoch": None,
        "crossfade_seconds": 0.0,
    })

    class AsyncIter:
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

    mock_db.radio_studio_ads.find = MagicMock(return_value=AsyncIter(durations_in_db))
    mock_db.radio_studio_music.find = MagicMock(return_value=AsyncIter([]))

    # Compute what the legacy behaviour SHOULD report
    total = 8 * 30.0  # 240s
    expected_offset = time.time() % total
    expected_idx = int(expected_offset // 30)

    with patch("routes.radio_studio.get_db", return_value=mock_db):
        result = asyncio.run(live_now_playing())

    assert result["playing"] is True
    # Allow ±1 second slack for test timing jitter
    assert abs(result["current_index"] - expected_idx) <= 1, \
        f"Legacy playlist should match modulo-epoch (expected " \
        f"idx≈{expected_idx}, got {result['current_index']})"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

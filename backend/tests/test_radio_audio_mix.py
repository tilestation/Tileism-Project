"""
Tests for the music-vs-ads balance fader (3 Jun 2026).

User request: "I am still struggling to find the volume control system
between music and ads". Built two persistent gain sliders (-12 dB to
0 dB) on the playlist doc:
- music_gain_db: applied to music-type items via audio.volume
- ads_gain_db: applied to ad-type items via audio.volume

Stored on the playlist doc, exposed in /live/now-playing.playlist, and
applied client-side in PublicRadioPage via `audio.volume = 10^(db/20)`.

These tests verify the backend contract: the fields save, round-trip,
and appear in /live/now-playing.playlist.
"""

import os
import time
from unittest.mock import patch, AsyncMock, MagicMock

import pytest


@pytest.fixture(autouse=True)
def _env_setup():
    os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
    os.environ.setdefault("DB_NAME", "test_radio_audio_mix")


# ---------------------------------------------------------------------
# 1. PlaylistUpdate accepts the new gain fields
# ---------------------------------------------------------------------
def test_playlist_update_accepts_gain_fields():
    """The Pydantic model must round-trip music_gain_db + ads_gain_db
    without raising. -12 to 0 is the valid range."""
    from routes.radio_studio import PlaylistUpdate, PlaylistItem
    req = PlaylistUpdate(
        name="Test",
        items=[PlaylistItem(type="ad", ref_id="ad-1")],
        is_active=True,
        repeat=True,
        crossfade_seconds=0.5,
        music_gain_db=-6.0,
        ads_gain_db=-1.5,
    )
    assert req.music_gain_db == -6.0
    assert req.ads_gain_db == -1.5


# ---------------------------------------------------------------------
# 2. PlaylistUpdate rejects out-of-range gains
# ---------------------------------------------------------------------
@pytest.mark.parametrize("bad_value", [-12.5, -100, 0.5, 6, 1.0])
def test_playlist_update_rejects_out_of_range_gains(bad_value):
    """Defensive: gains > 0 (boost) or < -12 (excessive cut) must
    fail validation. Boost gain could clip; deep cut is functionally
    mute and risks the user thinking the radio is broken."""
    from routes.radio_studio import PlaylistUpdate, PlaylistItem
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        PlaylistUpdate(
            name="Test",
            items=[PlaylistItem(type="ad", ref_id="ad-1")],
            is_active=True,
            repeat=True,
            crossfade_seconds=0.0,
            music_gain_db=bad_value,
            ads_gain_db=0.0,
        )


# ---------------------------------------------------------------------
# 3. PlaylistUpdate defaults gains to 0 dB
# ---------------------------------------------------------------------
def test_playlist_update_defaults_gains_to_zero_db():
    """Legacy admin code that doesn't know about gains must still
    succeed — defaults to unity (0 dB)."""
    from routes.radio_studio import PlaylistUpdate, PlaylistItem
    req = PlaylistUpdate(
        name="Test",
        items=[PlaylistItem(type="ad", ref_id="ad-1")],
    )
    assert req.music_gain_db == 0.0
    assert req.ads_gain_db == 0.0


# ---------------------------------------------------------------------
# 4. save_playlist persists the gain fields
# ---------------------------------------------------------------------
def test_save_playlist_persists_gains():
    """POST /admin/radio-studio/playlist with music_gain_db + ads_gain_db
    must write them to the playlist doc."""
    import asyncio
    from routes.radio_studio import save_playlist, PlaylistUpdate, PlaylistItem

    mock_db = AsyncMock()
    mock_db.radio_studio_playlists.find_one.return_value = None
    mock_db.radio_studio_playlists.update_one.return_value = AsyncMock()

    req = PlaylistUpdate(
        name="Test",
        items=[PlaylistItem(type="ad", ref_id="ad-1")],
        is_active=True,
        repeat=True,
        crossfade_seconds=0.0,
        music_gain_db=-4.5,
        ads_gain_db=-1.0,
    )
    user = {"role": "super_admin", "email": "admin@test"}
    with patch("routes.radio_studio.get_db", return_value=mock_db):
        result = asyncio.run(save_playlist(req=req, current_user=user))
    assert result["music_gain_db"] == -4.5
    assert result["ads_gain_db"] == -1.0
    # Confirm Mongo write captured them
    call_args = mock_db.radio_studio_playlists.update_one.call_args
    update_set = call_args[0][1]["$set"]
    assert update_set["music_gain_db"] == -4.5
    assert update_set["ads_gain_db"] == -1.0


# ---------------------------------------------------------------------
# 5. get_playlist returns defaults for legacy docs without gains
# ---------------------------------------------------------------------
def test_get_playlist_defaults_legacy_gains_to_zero():
    """Playlist docs saved before 3 Jun 2026 don't have the gain
    fields. Endpoint must fill them with 0 dB so the admin UI
    doesn't blow up on `undefined` reads."""
    import asyncio
    from routes.radio_studio import get_playlist

    mock_db = AsyncMock()
    mock_db.radio_studio_playlists.find_one.return_value = {
        "id": "default",
        "name": "Legacy Playlist",
        "items": [{"type": "ad", "ref_id": "ad-1"}],
        "is_active": True,
        "repeat": True,
        "crossfade_seconds": 0.5,
        # NO music_gain_db / ads_gain_db — pre-fix doc
        "created_at": "2026-05-30T00:00:00+00:00",
        "updated_at": "2026-05-30T00:00:00+00:00",
    }
    user = {"role": "super_admin", "email": "admin@test"}
    with patch("routes.radio_studio.get_db", return_value=mock_db):
        result = asyncio.run(get_playlist(current_user=user))
    assert result["music_gain_db"] == 0.0
    assert result["ads_gain_db"] == 0.0


# ---------------------------------------------------------------------
# 6. /live/now-playing exposes gains in the playlist sub-object
# ---------------------------------------------------------------------
def test_now_playing_exposes_gains_in_playlist():
    """Clients read .playlist.music_gain_db / .ads_gain_db from
    /live/now-playing to apply the balance client-side. Both must
    be present on every response."""
    import asyncio
    from routes.radio_studio import live_now_playing

    class AsyncIter:
        def __init__(self, items): self._items = items
        def __aiter__(self): self._iter = iter(self._items); return self
        async def __anext__(self):
            try: return next(self._iter)
            except StopIteration as e: raise StopAsyncIteration from e

    db = MagicMock()
    db.radio_studio_playlists.find_one = AsyncMock(return_value={
        "id": "default",
        "items": [{"type": "ad", "ref_id": "ad-1"}],
        "repeat": True,
        "started_at_epoch": time.time(),
        "crossfade_seconds": 0.0,
        "music_gain_db": -3.5,
        "ads_gain_db": -1.0,
        "name": "Test",
    })
    db.radio_studio_ads.find = MagicMock(return_value=AsyncIter([
        {"id": "ad-1", "name": "Test Ad", "audio_filename": "a.mp3",
         "duration_seconds": 30.0, "voice_name": "V", "bed_music_name": None},
    ]))
    db.radio_studio_music.find = MagicMock(return_value=AsyncIter([]))

    with patch("routes.radio_studio.get_db", return_value=db):
        result = asyncio.run(live_now_playing())

    assert result["playlist"]["music_gain_db"] == -3.5, \
        "Frontend reads .playlist.music_gain_db to apply music balance"
    assert result["playlist"]["ads_gain_db"] == -1.0, \
        "Frontend reads .playlist.ads_gain_db to apply ad balance"


# ---------------------------------------------------------------------
# 7. /live/now-playing defaults gains to 0 dB for legacy playlists
# ---------------------------------------------------------------------
def test_now_playing_defaults_legacy_gains_to_zero():
    """Listeners of legacy playlists (no gain fields) get 0 dB — same
    behaviour as before this feature shipped (unity gain)."""
    import asyncio
    from routes.radio_studio import live_now_playing

    class AsyncIter:
        def __init__(self, items): self._items = items
        def __aiter__(self): self._iter = iter(self._items); return self
        async def __anext__(self):
            try: return next(self._iter)
            except StopIteration as e: raise StopAsyncIteration from e

    db = MagicMock()
    db.radio_studio_playlists.find_one = AsyncMock(return_value={
        "id": "default",
        "items": [{"type": "ad", "ref_id": "ad-1"}],
        "repeat": True,
        "started_at_epoch": time.time(),
        "crossfade_seconds": 0.0,
        # NO music_gain_db / ads_gain_db
        "name": "Legacy",
    })
    db.radio_studio_ads.find = MagicMock(return_value=AsyncIter([
        {"id": "ad-1", "name": "Test Ad", "audio_filename": "a.mp3",
         "duration_seconds": 30.0, "voice_name": "V", "bed_music_name": None},
    ]))
    db.radio_studio_music.find = MagicMock(return_value=AsyncIter([]))

    with patch("routes.radio_studio.get_db", return_value=db):
        result = asyncio.run(live_now_playing())

    assert result["playlist"]["music_gain_db"] == 0.0
    assert result["playlist"]["ads_gain_db"] == 0.0


# ---------------------------------------------------------------------
# 8. Round-trip: save then load returns the same gains
# ---------------------------------------------------------------------
def test_save_then_load_round_trips_gains():
    """End-to-end: save with custom gains → load → values match."""
    import asyncio
    from routes.radio_studio import save_playlist, get_playlist, PlaylistUpdate, PlaylistItem

    # Shared mock DB: update_one writes into our dict; find_one
    # reads from it (with the new fields applied).
    state = {
        "id": "default",
        "name": "Test",
        "items": [{"type": "ad", "ref_id": "ad-1"}],
        "is_active": True,
        "repeat": True,
        "crossfade_seconds": 0.0,
        "music_gain_db": 0.0,
        "ads_gain_db": 0.0,
        "created_at": "2026-06-03T00:00:00+00:00",
        "updated_at": "2026-06-03T00:00:00+00:00",
    }
    db = MagicMock()
    async def _find_one(*a, **kw): return dict(state)
    db.radio_studio_playlists.find_one = AsyncMock(side_effect=_find_one)
    async def _update_one(q, u, **kw):
        for k, v in u["$set"].items():
            state[k] = v
        return MagicMock()
    db.radio_studio_playlists.update_one = AsyncMock(side_effect=_update_one)

    user = {"role": "super_admin", "email": "admin@test"}
    req = PlaylistUpdate(
        name="Test",
        items=[PlaylistItem(type="ad", ref_id="ad-1")],
        is_active=True,
        repeat=True,
        crossfade_seconds=0.0,
        music_gain_db=-6.0,
        ads_gain_db=-2.5,
    )
    with patch("routes.radio_studio.get_db", return_value=db):
        asyncio.run(save_playlist(req=req, current_user=user))
        loaded = asyncio.run(get_playlist(current_user=user))

    assert loaded["music_gain_db"] == -6.0
    assert loaded["ads_gain_db"] == -2.5


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

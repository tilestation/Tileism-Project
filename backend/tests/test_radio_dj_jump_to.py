"""
Tests for the DJ-mode super-admin "jump to track" override (3 Jun 2026).

Behaviour:
- POST /api/admin/radio-studio/live/jump-to with {idx: N} is super-admin only.
- It resets `started_at_epoch` so the wall-clock places the loop at the
  start of item N (item_offset = 0).
- It bumps `jump_token` (unique uuid hex) so every tuned-in client can
  detect the change and resync its local playback index.
- /live/now-playing exposes the current `jump_token` so clients can
  notice changes without polling a separate endpoint.
"""

import os
import time
from unittest.mock import patch, AsyncMock, MagicMock

import pytest


@pytest.fixture(autouse=True)
def _env_setup():
    os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
    os.environ.setdefault("DB_NAME", "test_radio_dj_jump")


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


def _items_5(durations):
    """Build a 5-item playlist whose ads have the given durations."""
    items = [{"type": "ad", "ref_id": f"ad-{i}"} for i in range(len(durations))]
    ads = [
        {"id": f"ad-{i}", "name": f"Ad {i}", "audio_filename": "a.mp3",
         "duration_seconds": float(d), "voice_name": "V", "bed_music_name": None}
        for i, d in enumerate(durations)
    ]
    return items, ads


def _mock_db(items, ads, music=None, started_at=None, jump_token=None):
    db = MagicMock()
    playlist_doc = {
        "id": "default",
        "items": items,
        "repeat": True,
        "started_at_epoch": started_at if started_at is not None else time.time(),
        "crossfade_seconds": 0.0,
        "name": "Test",
    }
    if jump_token:
        playlist_doc["jump_token"] = jump_token
    db.radio_studio_playlists.find_one = AsyncMock(return_value=playlist_doc)
    db.radio_studio_playlists.update_one = AsyncMock()
    db.radio_studio_ads.find = MagicMock(return_value=AsyncIter(ads))
    db.radio_studio_music.find = MagicMock(return_value=AsyncIter(music or []))
    return db


# ---------------------------------------------------------------------
# 1. Non-super-admin (manager) cannot DJ
# ---------------------------------------------------------------------
def test_jump_rejects_non_super_admin():
    """Only super_admin role can jump the live broadcast. Managers
    and regular admins must get a 403."""
    import asyncio
    from routes.radio_studio import jump_to_item, JumpToReq
    from fastapi import HTTPException

    items, ads = _items_5([30, 30, 30, 30, 30])
    mock_db = _mock_db(items, ads)
    with patch("routes.radio_studio.get_db", return_value=mock_db):
        for bad_role in ("admin", "manager", "staff", None, ""):
            user = {"role": bad_role, "email": "x@test"}
            with pytest.raises(HTTPException) as exc:
                asyncio.run(jump_to_item(JumpToReq(idx=2), current_user=user))
            assert exc.value.status_code == 403, \
                f"Role={bad_role} must get 403, got {exc.value.status_code}"


# ---------------------------------------------------------------------
# 2. Super admin can jump to a valid idx
# ---------------------------------------------------------------------
def test_super_admin_can_jump_to_valid_idx():
    """Super admin POSTing {idx: 2} should succeed and the response
    should carry the new jump_token + computed anchor."""
    import asyncio
    from routes.radio_studio import jump_to_item, JumpToReq

    items, ads = _items_5([30, 45, 60, 75, 90])  # cumulative: 0, 30, 75, 135, 210
    mock_db = _mock_db(items, ads, started_at=time.time() - 1000)

    user = {"role": "super_admin", "email": "boss@test"}
    before = time.time()
    with patch("routes.radio_studio.get_db", return_value=mock_db):
        result = asyncio.run(jump_to_item(JumpToReq(idx=2), current_user=user))
    after = time.time()

    assert result["idx"] == 2
    assert result["name"] == "Ad 2"
    assert result["type"] == "ad"
    assert "jump_token" in result and len(result["jump_token"]) == 32, \
        "jump_token must be a uuid4 hex (32 chars)"
    # cumulative duration BEFORE idx=2 is 30 + 45 = 75s. So anchor
    # should be ~now - 75s.
    expected_anchor = time.time() - 75
    assert abs(result["started_at_epoch"] - expected_anchor) < 1.0, \
        f"Expected anchor ~{expected_anchor}, got {result['started_at_epoch']}"
    # And the DB write happened.
    mock_db.radio_studio_playlists.update_one.assert_called_once()
    call_args = mock_db.radio_studio_playlists.update_one.call_args
    update_set = call_args[0][1]["$set"]
    assert update_set["jump_token"] == result["jump_token"]
    assert update_set["jumped_by"] == "boss@test"
    assert update_set["jumped_to_idx"] == 2
    # anchor = now - cumulative_before(75s) → falls 75s in the past
    assert (before - 75 - 1) <= update_set["started_at_epoch"] <= (after - 75 + 1)


# ---------------------------------------------------------------------
# 3. Each jump produces a NEW token (so clients detect the change)
# ---------------------------------------------------------------------
def test_each_jump_generates_unique_token():
    """Two jumps in a row must produce different tokens — otherwise
    clients wouldn't notice the second jump."""
    import asyncio
    from routes.radio_studio import jump_to_item, JumpToReq

    items, ads = _items_5([30, 30, 30, 30, 30])
    mock_db = _mock_db(items, ads)

    user = {"role": "super_admin", "email": "boss@test"}
    with patch("routes.radio_studio.get_db", return_value=mock_db):
        r1 = asyncio.run(jump_to_item(JumpToReq(idx=1), current_user=user))
        r2 = asyncio.run(jump_to_item(JumpToReq(idx=3), current_user=user))

    assert r1["jump_token"] != r2["jump_token"], \
        "Two distinct jumps must yield distinct tokens"


# ---------------------------------------------------------------------
# 4. Out-of-range idx → 400
# ---------------------------------------------------------------------
def test_jump_rejects_out_of_range_idx():
    """idx >= playlist length must 400 (not silently wrap)."""
    import asyncio
    from routes.radio_studio import jump_to_item, JumpToReq
    from fastapi import HTTPException

    items, ads = _items_5([30, 30, 30, 30, 30])
    mock_db = _mock_db(items, ads)
    user = {"role": "super_admin", "email": "boss@test"}

    with patch("routes.radio_studio.get_db", return_value=mock_db):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(jump_to_item(JumpToReq(idx=5), current_user=user))
        assert exc.value.status_code == 400
        assert "out of range" in exc.value.detail.lower()


# ---------------------------------------------------------------------
# 5. Empty playlist → 400
# ---------------------------------------------------------------------
def test_jump_rejects_empty_playlist():
    import asyncio
    from routes.radio_studio import jump_to_item, JumpToReq
    from fastapi import HTTPException

    mock_db = _mock_db([], [])
    user = {"role": "super_admin", "email": "boss@test"}

    with patch("routes.radio_studio.get_db", return_value=mock_db):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(jump_to_item(JumpToReq(idx=0), current_user=user))
        assert exc.value.status_code == 400


# ---------------------------------------------------------------------
# 6. jump_token is exposed in /live/now-playing
# ---------------------------------------------------------------------
def test_now_playing_exposes_jump_token():
    """Clients need to see jump_token in the polling response so they
    can resync without polling a separate endpoint."""
    import asyncio
    from routes.radio_studio import live_now_playing

    items, ads = _items_5([30, 30, 30, 30, 30])
    mock_db = _mock_db(items, ads, jump_token="abc123def456")

    with patch("routes.radio_studio.get_db", return_value=mock_db):
        result = asyncio.run(live_now_playing())

    assert result["jump_token"] == "abc123def456", \
        "now-playing must expose jump_token at top level"


# ---------------------------------------------------------------------
# 7. After jump, the wall-clock places the loop at the chosen idx
# ---------------------------------------------------------------------
def test_after_jump_now_playing_reports_chosen_idx():
    """End-to-end: jump_to(idx=3), then call /live/now-playing and
    verify current_index == 3 with item_offset ~ 0."""
    import asyncio
    from routes.radio_studio import jump_to_item, live_now_playing, JumpToReq

    items, ads = _items_5([30, 45, 60, 75, 90])
    # Use a SHARED mock DB so the jump's update propagates to the
    # subsequent now-playing read.
    db = MagicMock()
    playlist_state = {
        "id": "default",
        "items": items,
        "repeat": True,
        "started_at_epoch": time.time() - 1000,
        "crossfade_seconds": 0.0,
        "name": "Test",
    }
    async def _find_one(*args, **kwargs):
        # Return a fresh copy each call so the test mimics Mongo
        # semantics (we mutate `playlist_state` between calls).
        return dict(playlist_state)
    db.radio_studio_playlists.find_one = AsyncMock(side_effect=_find_one)

    async def _update_one(query, update, **kwargs):
        for k, v in update["$set"].items():
            playlist_state[k] = v
        return MagicMock()
    db.radio_studio_playlists.update_one = AsyncMock(side_effect=_update_one)

    db.radio_studio_ads.find = MagicMock(side_effect=lambda *a, **kw: AsyncIter(ads))
    db.radio_studio_music.find = MagicMock(side_effect=lambda *a, **kw: AsyncIter([]))

    user = {"role": "super_admin", "email": "boss@test"}
    with patch("routes.radio_studio.get_db", return_value=db):
        asyncio.run(jump_to_item(JumpToReq(idx=3), current_user=user))
        # Microscopic delay so item_offset isn't exactly 0 (which
        # would be brittle). After 0.05s, idx should still be 3.
        time.sleep(0.05)
        now = asyncio.run(live_now_playing())

    assert now["current_index"] == 3, \
        f"After jump to idx=3, now-playing should report current_index=3 (got {now['current_index']})"
    assert now["now"]["name"] == "Ad 3"
    assert now["now"]["elapsed_seconds"] < 2.0, \
        f"item_offset should be ~0 right after jump, got {now['now']['elapsed_seconds']}"
    assert now["jump_token"] == playlist_state["jump_token"]


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

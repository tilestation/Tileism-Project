"""Solo-preview + upcoming-list tests.

Verifies the 31 May 2026 UX expansion:

  1. /live/now-playing returns the `upcoming` list (next 3 items)
     and `current_index` + `playlist.playlist_name` so the public
     /radio page can render the queue.
  2. /live/playlist-preview is a separate solo endpoint that
     returns the WHOLE resolved playlist in order, flagged with
     `mode: "solo"`, so the admin's "Solo preview from #1" link
     can play sequentially without wall-clock sync.
"""
from __future__ import annotations

import os
import uuid

import pytest
from httpx import ASGITransport, AsyncClient

os.environ.setdefault("DB_NAME", "test_db_radio_solo")

from server import app  # noqa: E402
from config import get_db  # noqa: E402


@pytest.mark.asyncio
async def test_now_playing_returns_upcoming_list_and_current_index():
    db = get_db()
    # Seed 4 ads so the playlist has enough to expose an upcoming[3]
    ad_ids = []
    for i in range(4):
        aid = f"test_up_{uuid.uuid4().hex}"
        ad_ids.append(aid)
        await db.radio_studio_ads.insert_one({
            "id": aid,
            "name": f"Upcoming-test ad {i + 1}",
            "audio_filename": f"{aid}.mp3",
            "audio_blob": b"\xff\xfb\x90\x00" + b"\x00" * 5000,
            "audio_bytes": 5004,
            "duration_seconds": 30.0,
        })
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            login = await client.post(
                "/api/auth/login",
                json={"email": "admin@test.com", "password": "admin123"},
            )
            token = login.json()["token"]
            await client.post(
                "/api/admin/radio-studio/playlist",
                headers={"Authorization": f"Bearer {token}"},
                json={
                    "name": "Upcoming test",
                    "items": [{"type": "ad", "ref_id": aid} for aid in ad_ids],
                    "is_active": True,
                    "repeat": True,
                    "crossfade_seconds": 0,
                },
            )
            r = await client.get("/api/radio-studio/live/now-playing")
            assert r.status_code == 200, r.text
            data = r.json()
            assert data["playing"] is True
            assert "upcoming" in data, "upcoming field must be exposed"
            assert isinstance(data["upcoming"], list)
            # 4 items → 3 upcoming
            assert len(data["upcoming"]) == 3
            for entry in data["upcoming"]:
                assert "name" in entry
                assert "type" in entry
                assert "duration_seconds" in entry
            assert "current_index" in data
            assert isinstance(data["current_index"], int)
            assert data["playlist"]["playlist_name"] == "Upcoming test"
    finally:
        await db.radio_studio_ads.delete_many({"id": {"$in": ad_ids}})


@pytest.mark.asyncio
async def test_playlist_preview_returns_full_resolved_playlist_with_solo_mode():
    db = get_db()
    ad_ids = []
    for i in range(2):
        aid = f"test_solo_{uuid.uuid4().hex}"
        ad_ids.append(aid)
        await db.radio_studio_ads.insert_one({
            "id": aid,
            "name": f"Solo-preview test ad {i + 1}",
            "audio_filename": f"{aid}.mp3",
            "audio_blob": b"\xff\xfb\x90\x00" + b"\x00" * 5000,
            "audio_bytes": 5004,
            "duration_seconds": 20.0,
        })
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            login = await client.post(
                "/api/auth/login",
                json={"email": "admin@test.com", "password": "admin123"},
            )
            token = login.json()["token"]
            await client.post(
                "/api/admin/radio-studio/playlist",
                headers={"Authorization": f"Bearer {token}"},
                json={
                    "name": "Solo preview test",
                    "items": [{"type": "ad", "ref_id": aid} for aid in ad_ids],
                    "is_active": True,
                    "repeat": True,
                    "crossfade_seconds": 0,
                },
            )

            r = await client.get("/api/radio-studio/live/playlist-preview")
            assert r.status_code == 200, r.text
            data = r.json()
            assert data["playing"] is True
            assert data["mode"] == "solo"
            assert isinstance(data["items"], list)
            assert len(data["items"]) == 2
            for entry in data["items"]:
                assert "audio_url" in entry
                assert entry["audio_url"].startswith("/api/radio-studio/stream/")
                assert "name" in entry
                assert "duration_seconds" in entry
            assert data["playlist"]["playlist_name"] == "Solo preview test"
            assert data["playlist"]["total_items"] == 2
    finally:
        await db.radio_studio_ads.delete_many({"id": {"$in": ad_ids}})


@pytest.mark.asyncio
async def test_playlist_preview_empty_playlist_returns_helpful_reason():
    """No active playlist → 200 with {playing: false, mode: solo}
    and a human-readable `reason`. The admin's Solo preview button
    relies on this to render an empty-state instead of crashing."""
    db = get_db()
    await db.radio_studio_playlists.delete_many({"id": "default"})
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        r = await client.get("/api/radio-studio/live/playlist-preview")
        assert r.status_code == 200
        data = r.json()
        assert data["playing"] is False
        assert data["mode"] == "solo"
        assert "reason" in data

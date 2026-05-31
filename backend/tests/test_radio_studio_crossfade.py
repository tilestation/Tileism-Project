"""Crossfade seconds field — round-trip + surface in /live/now-playing.

The actual fade is client-side (browser gain-ramps the two audio
elements via cosine equal-power). The backend's job is simply to:

  1. Accept `crossfade_seconds` on POST /api/admin/radio-studio/playlist
  2. Echo it on GET /api/admin/radio-studio/playlist
  3. Echo it inside `playlist.crossfade_seconds` on the public
     /api/radio-studio/live/now-playing payload so each speaker
     knows when to start fading.
"""
from __future__ import annotations

import os
import uuid

import pytest
from httpx import ASGITransport, AsyncClient

os.environ.setdefault("DB_NAME", "test_db_radio_crossfade")

from server import app  # noqa: E402
from config import get_db  # noqa: E402


@pytest.mark.asyncio
async def test_playlist_crossfade_seconds_round_trip():
    db = get_db()
    # Seed two ad docs so the playlist has something resolvable —
    # otherwise live/now-playing short-circuits to "Every item is
    # missing audio" and never exposes playlist.crossfade_seconds.
    ad_ids = []
    for _ in range(2):
        aid = f"test_xfade_{uuid.uuid4().hex}"
        ad_ids.append(aid)
        await db.radio_studio_ads.insert_one({
            "id": aid,
            "name": f"Crossfade test ad {aid[-6:]}",
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
            assert login.status_code == 200, login.text
            token = login.json()["token"]
            headers = {"Authorization": f"Bearer {token}"}

            # Save playlist WITH crossfade=1.5
            r = await client.post(
                "/api/admin/radio-studio/playlist",
                headers=headers,
                json={
                    "name": "Crossfade test",
                    "items": [
                        {"type": "ad", "ref_id": ad_ids[0]},
                        {"type": "ad", "ref_id": ad_ids[1]},
                    ],
                    "is_active": True,
                    "repeat": True,
                    "crossfade_seconds": 1.5,
                },
            )
            assert r.status_code == 200, r.text
            doc = r.json()
            assert doc["crossfade_seconds"] == 1.5

            # GET round-trip
            r2 = await client.get("/api/admin/radio-studio/playlist", headers=headers)
            assert r2.status_code == 200
            assert r2.json()["crossfade_seconds"] == 1.5

            # Public now-playing surfaces it
            r3 = await client.get("/api/radio-studio/live/now-playing")
            assert r3.status_code == 200
            np = r3.json()
            assert np["playing"] is True, np
            assert np["playlist"]["crossfade_seconds"] == 1.5

            # Update to 0 — disables crossfade
            r4 = await client.post(
                "/api/admin/radio-studio/playlist",
                headers=headers,
                json={
                    "name": "Crossfade test",
                    "items": [
                        {"type": "ad", "ref_id": ad_ids[0]},
                        {"type": "ad", "ref_id": ad_ids[1]},
                    ],
                    "is_active": True,
                    "repeat": True,
                    "crossfade_seconds": 0,
                },
            )
            assert r4.status_code == 200
            assert r4.json()["crossfade_seconds"] == 0

            r5 = await client.get("/api/radio-studio/live/now-playing")
            assert r5.json()["playlist"]["crossfade_seconds"] == 0
    finally:
        await db.radio_studio_ads.delete_many({"id": {"$in": ad_ids}})


@pytest.mark.asyncio
async def test_playlist_crossfade_seconds_clamped_to_3():
    """Schema caps crossfade at 3 s — Pydantic rejects bigger
    values with a 422 so the UI's 0-3 s slider is the source of truth."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        login = await client.post(
            "/api/auth/login",
            json={"email": "admin@test.com", "password": "admin123"},
        )
        token = login.json()["token"]
        headers = {"Authorization": f"Bearer {token}"}
        r = await client.post(
            "/api/admin/radio-studio/playlist",
            headers=headers,
            json={
                "name": "Bad",
                "items": [],
                "is_active": True,
                "repeat": True,
                "crossfade_seconds": 99,
            },
        )
        assert r.status_code == 422, r.text


@pytest.mark.asyncio
async def test_playlist_legacy_doc_defaults_crossfade_to_zero():
    """A pre-existing playlist doc without `crossfade_seconds`
    should be returned with the field defaulted to 0 (hard cut).
    Protects the 4 stores currently running production from getting
    a `None` and breaking the slider on first edit."""
    db = get_db()
    # Wipe + insert a legacy-shaped doc (no crossfade_seconds key)
    legacy_id = "default"
    await db.radio_studio_playlists.delete_many({"id": legacy_id})
    await db.radio_studio_playlists.insert_one({
        "id": legacy_id,
        "name": "Legacy",
        "items": [],
        "is_active": True,
        "repeat": True,
        # Deliberately NO crossfade_seconds
    })
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            login = await client.post(
                "/api/auth/login",
                json={"email": "admin@test.com", "password": "admin123"},
            )
            token = login.json()["token"]
            headers = {"Authorization": f"Bearer {token}"}
            r = await client.get("/api/admin/radio-studio/playlist", headers=headers)
            assert r.status_code == 200
            assert r.json()["crossfade_seconds"] == 0.0
    finally:
        await db.radio_studio_playlists.delete_many({"id": legacy_id})

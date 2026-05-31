"""Loudness normalisation tests — Radio Studio.

Goal: verify that

  1. _normalize_loudness() returns valid MP3 bytes (not empty, MP3
     frame header) for a real input, and falls back to the input
     unchanged on bogus/empty input.
  2. The /music/normalize-existing endpoint backfills old docs and
     is idempotent (re-running it skips already-marked docs).

We don't audit the actual measured LUFS — ffmpeg's loudnorm filter
is the source of truth there and is well-tested upstream. We DO
audit that the doc was marked `loudnorm_applied=True` and that the
bytes changed (proves ffmpeg actually re-encoded the audio).
"""
from __future__ import annotations

import os
import subprocess
import uuid

import pytest
from httpx import ASGITransport, AsyncClient

os.environ.setdefault("DB_NAME", "test_db_radio_loudnorm")

from server import app  # noqa: E402
from routes.radio_studio import _normalize_loudness  # noqa: E402
from config import get_db  # noqa: E402


def _make_tone_mp3(seconds: float = 1.5) -> bytes:
    """Generate a real MP3 of a 220 Hz sine wave at low volume so the
    normaliser has something to push UP. Pure-silence MP3s can confuse
    loudnorm into returning identical bytes which would defeat the
    'bytes changed' assertion below.
    """
    out = f"/tmp/tone_{uuid.uuid4().hex}.mp3"
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi",
            "-i", f"sine=frequency=220:duration={seconds}",
            "-filter:a", "volume=0.05",          # -26 dBFS → quiet
            "-ar", "44100", "-ac", "2",
            "-c:a", "libmp3lame", "-b:a", "128k",
            out,
        ],
        check=True,
        capture_output=True,
    )
    with open(out, "rb") as f:
        return f.read()


def test_normalize_loudness_returns_valid_mp3_and_changes_bytes():
    src = _make_tone_mp3()
    out = _normalize_loudness(src)
    # MP3 frame header (0xFFFB / 0xFFE3 / etc) or ID3 tag — accept both
    assert out and (out[:3] == b"ID3" or out[0] == 0xFF), "Not a valid MP3"
    # Quiet input → normaliser should produce different bytes (audio
    # got louder + re-encoded).
    assert out != src, "Normaliser returned identical bytes for a quiet input"


def test_normalize_loudness_empty_input_passes_through():
    assert _normalize_loudness(b"") == b""


def test_normalize_loudness_failsafe_on_bogus_input():
    # Garbage bytes — ffmpeg will fail to decode. Helper must NOT
    # raise; must return original bytes so callers stay running.
    bogus = b"not an mp3" * 100
    assert _normalize_loudness(bogus) == bogus


@pytest.mark.asyncio
async def test_normalize_existing_endpoint_backfills_only_unmarked_docs():
    db = get_db()
    src_a = _make_tone_mp3()
    src_b = _make_tone_mp3()

    # Seed: one unmarked track (should be processed) + one already
    # marked (should be skipped). IDs are namespaced so the test
    # can find/delete them safely.
    unmarked_id = f"test_loud_unmarked_{uuid.uuid4().hex}"
    marked_id = f"test_loud_marked_{uuid.uuid4().hex}"

    await db.radio_studio_music.insert_many([
        {
            "id": unmarked_id,
            "name": "Unmarked tone",
            "audio_blob": src_a,
            "audio_filename": f"{unmarked_id}.mp3",
            "audio_bytes": len(src_a),
            "uploaded_at": "2026-05-30T00:00:00+00:00",
        },
        {
            "id": marked_id,
            "name": "Already marked",
            "audio_blob": src_b,
            "audio_filename": f"{marked_id}.mp3",
            "audio_bytes": len(src_b),
            "loudnorm_applied": True,
            "loudnorm_target_lufs": -16.0,
            "uploaded_at": "2026-05-30T00:00:00+00:00",
        },
    ])

    # Login as super admin
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

            r = await client.post(
                "/api/admin/radio-studio/music/normalize-existing",
                headers=headers,
            )
            assert r.status_code == 200, r.text
            data = r.json()
            assert data["ok"] is True
            assert data["music_normalised"] >= 1, data
            assert data["target_lufs"] == -16.0

        # Verify the unmarked doc now has the flag + different bytes
        new_unmarked = await db.radio_studio_music.find_one(
            {"id": unmarked_id}, {"_id": 0}
        )
        assert new_unmarked["loudnorm_applied"] is True
        assert new_unmarked["loudnorm_target_lufs"] == -16.0
        assert "loudnorm_applied_at" in new_unmarked
        # bytes changed (audio actually re-encoded)
        assert bytes(new_unmarked["audio_blob"]) != src_a

        # Verify the already-marked doc was NOT touched (idempotency)
        old_marked = await db.radio_studio_music.find_one(
            {"id": marked_id}, {"_id": 0}
        )
        assert bytes(old_marked["audio_blob"]) == src_b
        assert "loudnorm_applied_at" not in old_marked
    finally:
        await db.radio_studio_music.delete_many({
            "id": {"$in": [unmarked_id, marked_id]}
        })

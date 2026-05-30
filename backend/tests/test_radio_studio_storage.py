"""
End-to-end regression tests for the Radio Studio MP3 → MongoDB storage
migration (24 May 2026 — Railway ephemeral disk wiped uploaded audio
on every deploy → migrated to BSON Binary in MongoDB Atlas).

These tests do NOT hit ElevenLabs. They mock `get_db` for the
`routes.radio_studio` module and assert the public stream endpoints
return the stored bytes, that list endpoints exclude the audio blob
projection, and that the 15 MB cap is enforced.
"""
from __future__ import annotations

import io
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def app_client():
    """A TestClient against the real FastAPI app (so routing prefixes
    are honoured — public stream sits under /api/radio-studio/...)."""
    from server import app
    return TestClient(app)


# ---------------------------------------------------------------
# stream/ad/{id}
# ---------------------------------------------------------------

def test_stream_ad_returns_stored_bytes(app_client):
    """The public stream endpoint reads `audio_blob` straight out of
    MongoDB and ships it back as the response body with `audio/mpeg`
    content type. No filesystem read involved."""
    from routes import radio_studio

    fake_bytes = b"ID3\x03\x00\x00\x00" + b"\xff" * 1024  # bogus but non-empty MP3
    fake_db = MagicMock()
    fake_db.radio_studio_ads.find_one = AsyncMock(return_value={
        "audio_blob": fake_bytes,
        "audio_bytes": len(fake_bytes),
        "name": "Test ad",
    })

    with patch.object(radio_studio, "get_db", return_value=fake_db):
        r = app_client.get("/api/radio-studio/stream/ad/abc123")

    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/mpeg"
    assert r.content == fake_bytes
    # Cache header set so Cloudflare can edge-cache for in-store loops.
    assert "max-age" in r.headers.get("cache-control", "")


def test_stream_ad_404_when_blob_missing(app_client):
    """If a stale doc exists with no `audio_blob` (e.g. legacy
    pre-migration ad whose file path is dead), the stream endpoint
    must 404 — not 500 — so the admin sees a clear regenerate prompt."""
    from routes import radio_studio

    fake_db = MagicMock()
    fake_db.radio_studio_ads.find_one = AsyncMock(return_value={"name": "Legacy ad"})

    with patch.object(radio_studio, "get_db", return_value=fake_db):
        r = app_client.get("/api/radio-studio/stream/ad/legacy-id")

    assert r.status_code == 404
    assert "regenerate" in r.json()["detail"].lower()


def test_stream_ad_404_when_not_found(app_client):
    from routes import radio_studio

    fake_db = MagicMock()
    fake_db.radio_studio_ads.find_one = AsyncMock(return_value=None)

    with patch.object(radio_studio, "get_db", return_value=fake_db):
        r = app_client.get("/api/radio-studio/stream/ad/does-not-exist")

    assert r.status_code == 404


# ---------------------------------------------------------------
# stream/music/{id}
# ---------------------------------------------------------------

def test_stream_music_returns_stored_bytes(app_client):
    from routes import radio_studio

    fake_bytes = b"RIFF\x00\x00\x00\x00WAVEfmt " + b"\x00" * 2048
    fake_db = MagicMock()
    fake_db.radio_studio_music.find_one = AsyncMock(return_value={
        "audio_blob": fake_bytes,
        "audio_bytes": len(fake_bytes),
        "name": "Lounge Loop",
    })

    with patch.object(radio_studio, "get_db", return_value=fake_db):
        r = app_client.get("/api/radio-studio/stream/music/track-1")

    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/mpeg"
    assert r.content == fake_bytes


def test_stream_music_404_when_blob_missing(app_client):
    from routes import radio_studio

    fake_db = MagicMock()
    fake_db.radio_studio_music.find_one = AsyncMock(return_value={"name": "Legacy"})

    with patch.object(radio_studio, "get_db", return_value=fake_db):
        r = app_client.get("/api/radio-studio/stream/music/legacy-music")

    assert r.status_code == 404
    assert "re-upload" in r.json()["detail"].lower()


# ---------------------------------------------------------------
# List endpoints MUST exclude `audio_blob` so /ads + /music stay tiny.
# ---------------------------------------------------------------

def test_list_ads_projection_excludes_audio_blob():
    """The list endpoint MUST project out `audio_blob: 0` or each
    response would carry every MP3 ever generated (megabytes per
    item)."""
    import inspect
    from routes import radio_studio
    src = inspect.getsource(radio_studio.list_ads)
    assert '"audio_blob": 0' in src, (
        "list_ads must explicitly exclude audio_blob from projection — "
        "otherwise the response payload would carry every MP3 byte"
    )


def test_list_music_projection_excludes_audio_blob():
    import inspect
    from routes import radio_studio
    src = inspect.getsource(radio_studio.list_music)
    assert '"audio_blob": 0' in src


def test_update_ad_response_excludes_audio_blob():
    """`PUT /admin/radio-studio/ads/{id}` returns the updated doc.
    That return MUST exclude the audio blob so the admin UI's
    auto-refresh after a script edit doesn't re-download MBs of audio."""
    import inspect
    from routes import radio_studio
    src = inspect.getsource(radio_studio.update_ad)
    assert '"audio_blob": 0' in src


def test_generate_ad_audio_response_excludes_audio_blob():
    """Same — the regen handler returns the ad doc; that response
    must NOT echo the freshly-stored bytes back to the admin client."""
    import inspect
    from routes import radio_studio
    src = inspect.getsource(radio_studio.generate_ad_audio)
    # Two projections in this handler — the initial fetch + the
    # final fetch after the $set. Both must exclude audio_blob.
    assert src.count('"audio_blob": 0') >= 2


def test_upload_music_response_excludes_audio_blob():
    """The upload handler builds a `doc` containing the bytes then
    inserts. Before returning to the client it MUST pop `audio_blob`
    so the response payload is small."""
    import inspect
    from routes import radio_studio
    src = inspect.getsource(radio_studio.upload_music)
    assert 'doc.pop("audio_blob", None)' in src, (
        "upload_music must pop audio_blob from the response dict — "
        "the admin UI doesn't need the bytes echoed back, that's "
        "what the stream endpoint is for"
    )


# ---------------------------------------------------------------
# 15 MB cap (BSON document limit is 16 MB — we leave 1 MB headroom)
# ---------------------------------------------------------------

def test_max_audio_bytes_is_15mb():
    from routes import radio_studio
    assert radio_studio.MAX_AUDIO_BYTES == 15 * 1024 * 1024


def test_upload_music_rejects_oversized_file(app_client):
    """A 16 MB upload must be rejected with 413 (Payload Too Large)
    BEFORE we insert it — otherwise we'd hit MongoDB's 16 MB BSON
    limit and lose the whole insert mid-flight."""
    from routes import radio_studio

    fake_db = MagicMock()
    fake_db.radio_studio_music.insert_one = AsyncMock()

    oversized = b"\x00" * (16 * 1024 * 1024)
    files = {"file": ("big.mp3", io.BytesIO(oversized), "audio/mpeg")}
    data = {"name": "Too big"}

    with patch.object(radio_studio, "get_db", return_value=fake_db):
        # Bypass auth by overriding the FastAPI dependency.
        from server import app
        from routes.radio_studio import get_current_user as _gcu
        app.dependency_overrides[_gcu] = lambda: {
            "email": "admin@test.com", "role": "super_admin"
        }
        try:
            r = app_client.post(
                "/api/admin/radio-studio/music/upload",
                files=files,
                data=data,
            )
        finally:
            app.dependency_overrides.pop(_gcu, None)

    assert r.status_code == 413, r.text
    detail = r.json()["detail"].lower()
    assert "15 mb" in detail or "exceeds" in detail
    fake_db.radio_studio_music.insert_one.assert_not_awaited()


# ---------------------------------------------------------------
# Module-level constants — make sure the old filesystem helpers
# didn't sneak back.
# ---------------------------------------------------------------

def test_no_legacy_filesystem_helpers():
    from routes import radio_studio
    # The old filesystem migration removed these; they MUST stay gone.
    for legacy in ("ADS_DIR", "MUSIC_DIR", "STORAGE_ROOT", "_audio_path"):
        assert not hasattr(radio_studio, legacy), (
            f"Legacy filesystem-storage helper '{legacy}' leaked back "
            f"into routes/radio_studio.py — Railway ephemeral disk "
            f"will wipe these files on every deploy."
        )

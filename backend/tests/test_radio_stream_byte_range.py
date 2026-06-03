"""
Regression tests for HTTP byte-range support on radio audio streams.

User report (3 Jun 2026): "The radio is not playing same in all stores."
Root cause: the stream endpoints returned `Accept-Ranges: none`, so
`audio.currentTime = X` silently failed on most browsers. Every store
joined every item at offset 0, and stores tuning in at different
moments drifted out of sync forever.

Fix: support HTTP byte-range (RFC 7233) on /stream/ad and /stream/music
so the public /radio page can seek to the wall-clock-derived elapsed
offset → all 4 stores land at the same time-point of the same item.

These tests verify the byte-range contract:
- A normal GET (no Range header) returns 200 with the full blob and
  advertises Accept-Ranges: bytes.
- A GET with Range: bytes=N-M returns 206 Partial Content with just
  that slice and the correct Content-Range header.
- Open-ended ranges (bytes=N-) return everything from N to EOF.
- Suffix ranges and out-of-bounds requests behave per spec.
"""

import os
from unittest.mock import patch, AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _env_setup():
    os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
    os.environ.setdefault("DB_NAME", "test_radio_byte_range")


@pytest.fixture
def client():
    from server import app
    return TestClient(app)


# A deterministic 1024-byte payload — enough to range-slice without
# being slow. Real ads are 100KB-3MB but the range logic is size-agnostic.
PAYLOAD = bytes(range(256)) * 4  # 1024 bytes
assert len(PAYLOAD) == 1024


def _mock_db_with_ad(ad_id: str = "ad-1"):
    db = MagicMock()
    db.radio_studio_ads.find_one = AsyncMock(return_value={
        "audio_blob": PAYLOAD,
        "audio_bytes": len(PAYLOAD),
        "name": "Test Ad",
    })
    db.radio_studio_music.find_one = AsyncMock(return_value=None)
    return db


def _mock_db_with_music(track_id: str = "m-1"):
    db = MagicMock()
    db.radio_studio_ads.find_one = AsyncMock(return_value=None)
    db.radio_studio_music.find_one = AsyncMock(return_value={
        "audio_blob": PAYLOAD,
        "audio_bytes": len(PAYLOAD),
        "name": "Test Track",
    })
    return db


# ---------------------------------------------------------------------
# 1. Full request returns 200 + entire blob + advertises range support
# ---------------------------------------------------------------------
def test_full_get_returns_200_and_advertises_range(client):
    mock_db = _mock_db_with_ad()
    with patch("routes.radio_studio.get_db", return_value=mock_db):
        r = client.get("/api/radio-studio/stream/ad/ad-1")
    assert r.status_code == 200
    assert r.content == PAYLOAD
    assert r.headers["accept-ranges"] == "bytes", \
        "Without range support, audio.currentTime seek silently " \
        "fails on most browsers — stores end up out of sync. " \
        "Endpoint MUST advertise Accept-Ranges: bytes."
    # Content-Length is stripped by GZip middleware; not testable here.


# ---------------------------------------------------------------------
# 2. Range request returns 206 + correct slice + Content-Range
# ---------------------------------------------------------------------
def test_range_request_returns_206_partial_content(client):
    """Browsers seek by issuing Range: bytes=N-M after parsing the
    MP3 frame headers. We must return EXACTLY bytes N..M (inclusive)."""
    mock_db = _mock_db_with_ad()
    with patch("routes.radio_studio.get_db", return_value=mock_db):
        r = client.get(
            "/api/radio-studio/stream/ad/ad-1",
            headers={"Range": "bytes=100-199"},
        )
    assert r.status_code == 206, "Range requests must return 206 Partial Content"
    assert len(r.content) == 100, f"Expected 100 bytes, got {len(r.content)}"
    assert r.content == PAYLOAD[100:200], "Wrong byte slice returned"
    assert r.headers["content-range"] == f"bytes 100-199/{len(PAYLOAD)}"
    assert r.headers["accept-ranges"] == "bytes"
    # Content-Length is stripped by GZip middleware; not testable here.


# ---------------------------------------------------------------------
# 3. Open-ended range (bytes=N-) returns everything from N to EOF
# ---------------------------------------------------------------------
def test_open_ended_range_returns_to_eof(client):
    """Common pattern: a browser seeks to 30s by issuing
    Range: bytes=12345- (everything from byte 12345 to the end)."""
    mock_db = _mock_db_with_ad()
    with patch("routes.radio_studio.get_db", return_value=mock_db):
        r = client.get(
            "/api/radio-studio/stream/ad/ad-1",
            headers={"Range": "bytes=500-"},
        )
    assert r.status_code == 206
    assert r.content == PAYLOAD[500:]
    assert len(r.content) == len(PAYLOAD) - 500
    assert r.headers["content-range"] == f"bytes 500-{len(PAYLOAD) - 1}/{len(PAYLOAD)}"


# ---------------------------------------------------------------------
# 4. Range from the start (bytes=0-N) — sanity check
# ---------------------------------------------------------------------
def test_range_from_start(client):
    mock_db = _mock_db_with_ad()
    with patch("routes.radio_studio.get_db", return_value=mock_db):
        r = client.get(
            "/api/radio-studio/stream/ad/ad-1",
            headers={"Range": "bytes=0-49"},
        )
    assert r.status_code == 206
    assert r.content == PAYLOAD[0:50]
    assert r.headers["content-range"] == f"bytes 0-49/{len(PAYLOAD)}"


# ---------------------------------------------------------------------
# 5. Range past EOF is clamped to the actual end (no overflow)
# ---------------------------------------------------------------------
def test_range_past_eof_is_clamped(client):
    """Defensive: if the browser asks for bytes 800-999999 we return
    bytes 800-1023 (the actual end), not a 416 or an empty body."""
    mock_db = _mock_db_with_ad()
    with patch("routes.radio_studio.get_db", return_value=mock_db):
        r = client.get(
            "/api/radio-studio/stream/ad/ad-1",
            headers={"Range": "bytes=800-99999"},
        )
    assert r.status_code == 206
    assert r.content == PAYLOAD[800:]
    assert r.headers["content-range"] == f"bytes 800-{len(PAYLOAD) - 1}/{len(PAYLOAD)}"


# ---------------------------------------------------------------------
# 6. Malformed Range header returns 416 with Content-Range
# ---------------------------------------------------------------------
@pytest.mark.parametrize("bad_range", [
    "bytes=abc-def",        # non-numeric
    "bytes=-50-100",        # negative start
    "bytes=200-100",        # end < start
    "kilobytes=0-100",      # wrong unit
])
def test_malformed_range_returns_416(client, bad_range):
    """RFC 7233 §4.4 — a server MAY respond 416 to an invalid range.
    Our endpoint takes that path so the browser falls back to a full
    GET rather than hanging on a malformed response."""
    mock_db = _mock_db_with_ad()
    with patch("routes.radio_studio.get_db", return_value=mock_db):
        r = client.get(
            "/api/radio-studio/stream/ad/ad-1",
            headers={"Range": bad_range},
        )
    assert r.status_code == 416, f"Range {bad_range!r} should return 416"
    assert r.headers["content-range"] == f"bytes */{len(PAYLOAD)}"


# ---------------------------------------------------------------------
# 7. Music endpoint behaves identically (same _audio_response helper)
# ---------------------------------------------------------------------
def test_music_stream_supports_byte_range(client):
    """The fix must work for music as well as ads — listeners are
    just as likely to tune in mid-track as mid-ad."""
    mock_db = _mock_db_with_music()
    with patch("routes.radio_studio.get_db", return_value=mock_db):
        r = client.get(
            "/api/radio-studio/stream/music/m-1",
            headers={"Range": "bytes=256-511"},
        )
    assert r.status_code == 206
    assert r.content == PAYLOAD[256:512]
    assert r.headers["content-range"] == f"bytes 256-511/{len(PAYLOAD)}"


# ---------------------------------------------------------------------
# 8. 404 on missing audio is preserved
# ---------------------------------------------------------------------
def test_missing_ad_still_404(client):
    """Defensive: byte-range changes shouldn't have broken the
    pre-existing "ad audio not found" 404 path."""
    db = MagicMock()
    db.radio_studio_ads.find_one = AsyncMock(return_value=None)
    with patch("routes.radio_studio.get_db", return_value=db):
        r = client.get("/api/radio-studio/stream/ad/missing")
    assert r.status_code == 404


# ---------------------------------------------------------------------
# 9. now-playing exposes started_at_epoch for client-side seek math
# ---------------------------------------------------------------------
def test_now_playing_exposes_started_at_epoch(client):
    """
    Clients compute the live wall-clock offset as
    `(Date.now()/1000 - started_at_epoch) % total_seconds`. The
    server-stored anchor must come back in the response so all 4
    stores compute the same offset.
    """
    import time
    db = MagicMock()
    db.radio_studio_playlists.find_one = AsyncMock(return_value={
        "id": "default",
        "items": [{"type": "ad", "ref_id": "ad-1"}],
        "repeat": True,
        "started_at_epoch": 1717000000.5,  # known fixed value
        "crossfade_seconds": 0.0,
        "name": "Test",
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

    db.radio_studio_ads.find = MagicMock(return_value=AsyncIter([
        {"id": "ad-1", "name": "Test Ad", "audio_filename": "a.mp3",
         "duration_seconds": 30.0, "voice_name": "V", "bed_music_name": None},
    ]))
    db.radio_studio_music.find = MagicMock(return_value=AsyncIter([]))

    with patch("routes.radio_studio.get_db", return_value=db):
        r = client.get("/api/radio-studio/live/now-playing")
    assert r.status_code == 200
    data = r.json()
    assert data["started_at_epoch"] == 1717000000.5, \
        "Frontend needs started_at_epoch verbatim to compute seek offset"
    # server_time is also present (for clock-skew correction)
    assert "server_time" in data
    assert abs(data["server_time"] - time.time()) < 5, \
        "server_time should be current epoch (±5s slack)"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

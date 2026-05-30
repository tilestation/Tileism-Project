"""
Tests for the bulk "import music from URL" endpoint (26 May 2026 —
user request: "Bulk import from URL field that accepts YouTube
Audio Library / Bensound links").

The endpoint downloads + transcodes via yt-dlp's Python API and
stores the resulting MP3 bytes in MongoDB just like a normal
upload. We don't hit real internet sources in tests — we mock
`yt_dlp.YoutubeDL` so the suite stays fast + deterministic.
"""
from __future__ import annotations

import inspect
import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    from server import app
    return TestClient(app)


@pytest.fixture
def admin_override():
    """Bypass the admin auth dependency for these tests so we can
    POST without minting a real JWT every time."""
    from server import app
    from routes.radio_studio import get_current_user
    app.dependency_overrides[get_current_user] = lambda: {
        "email": "admin@test.com", "role": "super_admin",
    }
    yield
    app.dependency_overrides.pop(get_current_user, None)


# ---------------------------------------------------------------
# Pydantic model
# ---------------------------------------------------------------

def test_import_request_validates_url_length():
    from routes.radio_studio import MusicImportFromUrlReq
    # OK.
    MusicImportFromUrlReq(url="https://www.youtube.com/watch?v=abc")
    # Too short.
    with pytest.raises(Exception):
        MusicImportFromUrlReq(url="http")
    # Too long.
    with pytest.raises(Exception):
        MusicImportFromUrlReq(url="https://" + "x" * 5000)


def test_import_request_name_optional_and_capped():
    from routes.radio_studio import MusicImportFromUrlReq
    a = MusicImportFromUrlReq(url="https://x.com/y.mp3")
    assert a.name is None
    # 120-char ceiling.
    with pytest.raises(Exception):
        MusicImportFromUrlReq(url="https://x.com/y.mp3", name="A" * 150)


# ---------------------------------------------------------------
# URL scheme validation
# ---------------------------------------------------------------

def test_import_rejects_non_http_schemes(client, admin_override):
    """ftp://, file://, javascript: etc must be rejected up-front —
    yt-dlp can in principle hit any HTTP(S) URL but file:// would
    let an admin read local files off the backend."""
    for bad in ("file:///etc/passwd", "ftp://example.com/track.mp3", "javascript:alert(1)//"):
        r = client.post("/api/admin/radio-studio/music/import-url", json={"url": bad})
        assert r.status_code == 400, f"{bad} should be rejected"
        assert "http://" in r.json()["detail"]


# ---------------------------------------------------------------
# Happy path — mock yt-dlp and ffmpeg
# ---------------------------------------------------------------

def _make_fake_ydl(tmpdir_marker, audio_bytes, title="Mock Title"):
    """Build a fake yt_dlp.YoutubeDL class whose extract_info writes
    `audio_bytes` to <outtmpl-dir>/out.mp3 and returns a stub info
    dict. The endpoint then reads that file off disk just like with
    real yt-dlp."""
    class _FakeYDL:
        def __init__(self, opts):
            self._opts = opts
        def __enter__(self):
            return self
        def __exit__(self, *args):
            return False
        def extract_info(self, url, download=True):
            # outtmpl is e.g. /tmp/radio_import_xxx/out.%(ext)s — the
            # endpoint scans the directory for an .mp3, so we just
            # need to drop one in there.
            tmpl = self._opts["outtmpl"]
            tmpdir_marker["dir"] = os.path.dirname(tmpl)
            mp3_path = os.path.join(os.path.dirname(tmpl), "out.mp3")
            with open(mp3_path, "wb") as f:
                f.write(audio_bytes)
            return {"title": title, "url": url}
    return _FakeYDL


def test_import_happy_path_uses_metadata_title(client, admin_override):
    """When the admin doesn't supply a name, the backend uses the
    title returned by yt-dlp's `extract_info`."""
    from routes import radio_studio

    fake_bytes = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x00" * 200
    tmpdir_marker = {}
    fake_ydl = _make_fake_ydl(tmpdir_marker, fake_bytes, title="Smooth Jazz Bed")

    fake_db = MagicMock()
    fake_db.radio_studio_music.insert_one = AsyncMock()

    with patch.object(radio_studio, "get_db", return_value=fake_db), \
         patch.object(radio_studio, "_has_ytdlp_library", return_value=True), \
         patch.object(radio_studio, "_ffmpeg_bin", return_value="/usr/bin/ffmpeg"), \
         patch("yt_dlp.YoutubeDL", fake_ydl):
        r = client.post(
            "/api/admin/radio-studio/music/import-url",
            json={"url": "https://example.com/track.mp3"},
        )

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"] == "Smooth Jazz Bed"
    assert body["audio_bytes"] == len(fake_bytes)
    assert body["source_url"] == "https://example.com/track.mp3"
    assert body["imported_via"] == "yt-dlp"
    assert body["audio_filename"].endswith(".mp3")
    # Response must NOT echo the audio bytes — keeps the wire payload
    # tiny (admin UI just refreshes the music list afterwards).
    assert "audio_blob" not in body
    assert "_id" not in body
    fake_db.radio_studio_music.insert_one.assert_awaited_once()


def test_import_admin_supplied_name_wins(client, admin_override):
    """If the admin renames the track in the queue before clicking
    Upload, their value beats the source's metadata title."""
    from routes import radio_studio

    fake_bytes = b"ID3\x04" + b"\xff\xfb" * 500
    tmpdir_marker = {}
    fake_ydl = _make_fake_ydl(tmpdir_marker, fake_bytes, title="Boring Default")

    fake_db = MagicMock()
    fake_db.radio_studio_music.insert_one = AsyncMock()

    with patch.object(radio_studio, "get_db", return_value=fake_db), \
         patch.object(radio_studio, "_has_ytdlp_library", return_value=True), \
         patch.object(radio_studio, "_ffmpeg_bin", return_value="/usr/bin/ffmpeg"), \
         patch("yt_dlp.YoutubeDL", fake_ydl):
        r = client.post(
            "/api/admin/radio-studio/music/import-url",
            json={"url": "https://example.com/x.mp3", "name": "Custom store name"},
        )

    assert r.status_code == 200
    assert r.json()["name"] == "Custom store name"


# ---------------------------------------------------------------
# Size cap — applies AFTER transcode
# ---------------------------------------------------------------

def test_import_rejects_oversized_result(client, admin_override):
    """A source that transcodes to >15 MB must be rejected with 413
    BEFORE the Mongo insert — same cap as manual upload."""
    from routes import radio_studio

    oversize = b"\x00" * (16 * 1024 * 1024)  # 16 MB > 15 MB cap
    tmpdir_marker = {}
    fake_ydl = _make_fake_ydl(tmpdir_marker, oversize)

    fake_db = MagicMock()
    fake_db.radio_studio_music.insert_one = AsyncMock()

    with patch.object(radio_studio, "get_db", return_value=fake_db), \
         patch.object(radio_studio, "_has_ytdlp_library", return_value=True), \
         patch.object(radio_studio, "_ffmpeg_bin", return_value="/usr/bin/ffmpeg"), \
         patch("yt_dlp.YoutubeDL", fake_ydl):
        r = client.post(
            "/api/admin/radio-studio/music/import-url",
            json={"url": "https://example.com/big.mp3"},
        )

    assert r.status_code == 413
    detail = r.json()["detail"].lower()
    assert "15 mb" in detail or "exceeds" in detail
    fake_db.radio_studio_music.insert_one.assert_not_awaited()


# ---------------------------------------------------------------
# Error surfaces
# ---------------------------------------------------------------

def test_import_503_when_ytdlp_missing(client, admin_override):
    """Dev box without yt-dlp gets a clean 500 with an explanatory
    message instead of an OSError stack trace."""
    from routes import radio_studio
    with patch.object(radio_studio, "_has_ytdlp_library", return_value=False):
        r = client.post(
            "/api/admin/radio-studio/music/import-url",
            json={"url": "https://example.com/x.mp3"},
        )
    assert r.status_code == 500
    assert "yt-dlp" in r.json()["detail"]


def test_import_504_on_timeout(client, admin_override):
    """If yt-dlp hangs (network wedge), the endpoint times out at
    _IMPORT_TIMEOUT_SECONDS rather than holding the worker forever."""
    import asyncio
    from routes import radio_studio

    async def _hang(*a, **kw):
        await asyncio.sleep(99999)

    with patch.object(radio_studio, "_has_ytdlp_library", return_value=True), \
         patch.object(radio_studio, "_ffmpeg_bin", return_value="/usr/bin/ffmpeg"), \
         patch.object(radio_studio.asyncio, "to_thread", side_effect=_hang), \
         patch.object(radio_studio, "_IMPORT_TIMEOUT_SECONDS", 0.05):
        r = client.post(
            "/api/admin/radio-studio/music/import-url",
            json={"url": "https://example.com/x.mp3"},
        )
    assert r.status_code == 504
    assert "too long" in r.json()["detail"].lower()


def test_import_502_on_ytdlp_download_error(client, admin_override):
    """A geofenced video or removed track should bubble up yt-dlp's
    DownloadError message as a 502 so the admin sees a real reason
    in the toast."""
    from routes import radio_studio
    import yt_dlp

    class _FailingYDL:
        def __init__(self, opts): pass
        def __enter__(self): return self
        def __exit__(self, *args): return False
        def extract_info(self, url, download=True):
            raise yt_dlp.utils.DownloadError("Video unavailable")

    with patch.object(radio_studio, "_has_ytdlp_library", return_value=True), \
         patch.object(radio_studio, "_ffmpeg_bin", return_value="/usr/bin/ffmpeg"), \
         patch("yt_dlp.YoutubeDL", _FailingYDL):
        r = client.post(
            "/api/admin/radio-studio/music/import-url",
            json={"url": "https://www.youtube.com/watch?v=removed"},
        )
    assert r.status_code == 502
    assert "Video unavailable" in r.json()["detail"]


# ---------------------------------------------------------------
# Admin-only gate
# ---------------------------------------------------------------

def test_import_requires_admin_role():
    """Source check — the route uses _require_admin(current_user)."""
    from routes import radio_studio
    src = inspect.getsource(radio_studio.import_music_from_url)
    assert "_require_admin(current_user)" in src


def test_import_response_excludes_audio_blob():
    """Pop both `_id` and `audio_blob` from the returned dict so the
    admin client never sees the raw MP3 bytes (could be MBs)."""
    from routes import radio_studio
    src = inspect.getsource(radio_studio.import_music_from_url)
    assert 'doc.pop("_id", None)' in src
    assert 'doc.pop("audio_blob", None)' in src

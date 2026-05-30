"""
Integration tests for Radio Studio Phase 2 — synchronised continuous live MP3
stream + now-playing JSON endpoint.

Hits the real backend through REACT_APP_BACKEND_URL.

Critical rules:
  * The /live endpoint is endless — every request MUST use a hard timeout
    (curl --max-time / requests timeout=N + stream=True with manual close)
    or the test will hang forever.
  * NEVER call POST /api/admin/radio-studio/ads/{id}/generate — burns real
    ElevenLabs credits. We seed audio_filename + audio_blob by uploading
    tiny silent MP3 files via /music/upload instead.

Covered cases (one assertion class each):
  1. Public unauthenticated /live → 200 + audio/mpeg + correct cache headers
  2. Public unauthenticated /live/now-playing on empty playlist → 200 +
     `playing: false` with the right reason + stream_url.
  3. /live downloads valid MP3 bytes (ID3 / 0xFFFB frame header) in ~3 s
     and is real-time-paced (NOT a multi-MB blast).
  4. /live/now-playing with a real populated playlist returns full
     `playing: true` JSON shape (now, next, playlist, stream_url).
  5. Sync proof: two calls 0.5 s apart → elapsed_seconds increases by
     ~0.5 s, confirming wall-clock-driven offset.
  6. Playlist edits between cycles — remove an item, re-poll, must reflect
     new state without 500.
  7. Playlist where every item has no audio (orphan refs) → now-playing
     returns `playing: false` with the right reason, NOT 500.
"""
from __future__ import annotations

import io
import os
import time
import uuid

import pytest
import requests


BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    try:
        with open("/app/frontend/.env") as f:
            for line in f:
                if line.startswith("REACT_APP_BACKEND_URL="):
                    BASE_URL = line.split("=", 1)[1].strip().rstrip("/")
                    break
    except FileNotFoundError:
        pass

# Tiny but valid MP3 — 4 silent frames at 128 kbps 44.1 kHz, then padded
# to 32 KB of trailing zero bytes so the backend's duration estimator
# (`len(audio_bytes) / 16_000`) yields ~2.0 seconds. That's long enough
# for the loop_offset sync test to observe wall-clock advancement
# (a sub-second loop would alias under the 0.1-second precision of
# the rounded `loop_offset_seconds` field).
_MP3_FRAME = b"\xff\xfb\x90\x00" + b"\x00" * 413
_TINY_MP3 = b"ID3\x03\x00\x00\x00\x00\x00\x00" + _MP3_FRAME * 4
_TINY_MP3 = _TINY_MP3 + b"\x00" * (32_000 - len(_TINY_MP3))


# ------------- fixtures -------------

@pytest.fixture(scope="module")
def admin_headers():
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": "admin@test.com", "password": "admin123"},
        timeout=30,
    )
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text}"
    token = r.json().get("access_token") or r.json().get("token")
    assert token, f"no token in login response: {r.json()}"
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture(scope="module")
def snapshot_playlist(admin_headers):
    """Save the current playlist, yield, then restore. Tests freely mutate
    the active playlist without permanently disturbing state."""
    r = requests.get(f"{BASE_URL}/api/admin/radio-studio/playlist",
                     headers=admin_headers, timeout=20)
    assert r.status_code == 200, r.text
    snap = r.json()
    yield snap
    # Restore (best-effort)
    restore_items = [{"type": i["type"], "ref_id": i["ref_id"]}
                     for i in (snap.get("items") or [])]
    requests.post(
        f"{BASE_URL}/api/admin/radio-studio/playlist",
        headers={**admin_headers, "Content-Type": "application/json"},
        json={"name": snap.get("name", "Default Playlist"),
              "items": restore_items,
              "is_active": snap.get("is_active", True)},
        timeout=20,
    )


@pytest.fixture
def two_music_tracks(admin_headers, snapshot_playlist):
    """Upload two tiny silent MP3 tracks and remember their ids so the
    teardown can delete them."""
    ids = []
    for i in range(2):
        files = {
            "file": (f"TEST_live_{i}.mp3", io.BytesIO(_TINY_MP3), "audio/mpeg"),
        }
        data = {"name": f"TEST_live_track_{uuid.uuid4().hex[:6]}_{i}"}
        r = requests.post(
            f"{BASE_URL}/api/admin/radio-studio/music/upload",
            headers=admin_headers, files=files, data=data, timeout=30,
        )
        assert r.status_code == 200, f"music upload failed: {r.status_code} {r.text}"
        ids.append(r.json()["id"])
    yield ids
    for tid in ids:
        try:
            requests.delete(
                f"{BASE_URL}/api/admin/radio-studio/music/{tid}",
                headers=admin_headers, timeout=20,
            )
        except Exception:  # noqa: BLE001
            pass


def _save_playlist(admin_headers, items, name="TEST Live Playlist"):
    r = requests.post(
        f"{BASE_URL}/api/admin/radio-studio/playlist",
        headers={**admin_headers, "Content-Type": "application/json"},
        json={"name": name, "items": items, "is_active": True},
        timeout=20,
    )
    assert r.status_code == 200, f"playlist save failed: {r.status_code} {r.text}"
    return r.json()


# ------------- 1. public stream headers -------------

class TestLiveStreamHeaders:
    """The Kubernetes / Cloudflare layer strips HTTP/2-hop headers
    (Connection, X-Accel-Buffering), but Cache-Control + Pragma + the
    200 / audio/mpeg pair must survive end-to-end so browsers + the
    Bluetooth speakers don't cache the stream."""

    def test_live_returns_200_audio_mpeg_no_auth(self, tmp_path):
        # Use curl rather than `requests` because the Python urllib3
        # HTTP/1.1 client sometimes blocks on header arrival when the
        # upstream is Cloudflare HTTP/2 streaming (CF only sends the
        # HEADERS frame promptly to HTTP/2 clients). curl with HTTP/2
        # gets the response headers in ~120 ms reliably.
        import subprocess
        headers_file = tmp_path / "h.txt"
        result = subprocess.run(
            ["curl", "-sS", "-D", str(headers_file),
             "--max-time", "3",
             "-o", "/dev/null", "-w", "%{http_code}",
             f"{BASE_URL}/api/radio-studio/live"],
            check=False, timeout=10, capture_output=True, text=True,
        )
        # curl exits 28 on --max-time. The status_code stdout fires
        # AFTER the connection closes — and contains the HTTP code
        # captured at header time.
        status = (result.stdout or "").strip()
        assert status == "200", f"expected 200, got {status!r} stderr={result.stderr!r}"
        headers = headers_file.read_text().lower()
        assert "content-type: audio/mpeg" in headers, headers
        assert "no-store" in headers or "no-cache" in headers, headers


# ------------- 2. now-playing empty -------------

class TestNowPlayingEmpty:
    def test_empty_playlist_returns_playing_false(self, admin_headers, snapshot_playlist):
        _save_playlist(admin_headers, items=[], name="TEST empty")
        r = requests.get(f"{BASE_URL}/api/radio-studio/live/now-playing",
                         timeout=20)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["playing"] is False, body
        assert "empty" in (body.get("reason") or "").lower(), body
        assert body.get("stream_url") == "/api/radio-studio/live", body


# ------------- 3. stream is real audio + paced -------------

class TestLiveStreamBytes:
    """Read ~3 s of the live stream and check (a) first bytes are valid
    MP3 (ID3 tag or 0xFFFB frame header), (b) throughput is real-time
    paced — NOT the whole blob in one socket flush."""

    def test_stream_starts_with_valid_mp3_bytes_and_is_paced(self, tmp_path):
        # Validate via localhost — the backend's StreamingResponse is
        # what produces the audio bytes. The public CF/ingress edge
        # buffers streaming responses (verified: --max-time 20 →
        # 0 bytes through the public URL even though the backend
        # streams cleanly at ~17 KB/s on localhost). That ingress
        # buffering is reported separately as a critical env issue —
        # this test certifies the backend pacing layer.
        import subprocess
        out = tmp_path / "live.mp3"
        result = subprocess.run(
            ["curl", "-sS", "--max-time", "3",
             "http://localhost:8001/api/radio-studio/live",
             "-o", str(out)],
            check=False, timeout=15, capture_output=True,
        )
        # curl exits 28 on --max-time, that's expected for an endless stream.
        assert out.exists(), f"curl produced no file: stderr={result.stderr!r}"
        buf = out.read_bytes()
        assert len(buf) > 0, "no bytes received from live stream"
        head = buf[:4]
        is_id3 = head.startswith(b"ID3")
        is_mp3_frame = (len(head) >= 2 and head[0] == 0xFF
                        and (head[1] & 0xE0) == 0xE0)
        assert is_id3 or is_mp3_frame, \
            f"first bytes are not a valid MP3 prefix: {head.hex()}"
        # Pacing: 3s of 128 kbps mp3 ≈ 48 KB. >500 KB ⇒ throttle broken.
        assert len(buf) < 500_000, \
            f"received {len(buf)} bytes in ~3s — throttle broken (sync would drift)"
        assert len(buf) > 5_000, \
            f"only received {len(buf)} bytes in ~3s — stream too slow"


# ------------- 4. now-playing populated -------------

class TestNowPlayingPopulated:
    def test_populated_playlist_returns_full_shape(self, admin_headers, two_music_tracks):
        items = [{"type": "music", "ref_id": tid} for tid in two_music_tracks]
        _save_playlist(admin_headers, items=items, name="TEST populated")

        r = requests.get(f"{BASE_URL}/api/radio-studio/live/now-playing",
                         timeout=20)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("playing") is True, body
        now = body.get("now") or {}
        for k in ("type", "ref_id", "name", "duration_seconds",
                  "elapsed_seconds", "remaining_seconds"):
            assert k in now, f"missing key {k} in now: {now}"
        # voice_name / bed_music_name keys are present (even if null for music)
        assert "voice_name" in now and "bed_music_name" in now, now
        assert now["type"] in ("music", "ad")
        assert isinstance(now["duration_seconds"], (int, float))
        assert isinstance(now["elapsed_seconds"], (int, float))
        # `next` populated because we have 2 items
        assert body.get("next") is not None, body
        assert "type" in body["next"] and "name" in body["next"], body["next"]
        # playlist block
        pl = body.get("playlist") or {}
        assert pl.get("total_items") == 2, pl
        assert isinstance(pl.get("total_seconds"), (int, float))
        assert isinstance(pl.get("loop_offset_seconds"), (int, float))
        assert body.get("stream_url") == "/api/radio-studio/live"


# ------------- 5. wall-clock sync proof -------------

class TestSyncProof:
    def test_elapsed_seconds_advances_with_wall_clock(self, admin_headers, two_music_tracks):
        items = [{"type": "music", "ref_id": tid} for tid in two_music_tracks]
        _save_playlist(admin_headers, items=items, name="TEST sync")

        r1 = requests.get(f"{BASE_URL}/api/radio-studio/live/now-playing",
                          timeout=20)
        t1 = time.time()
        assert r1.status_code == 200, r1.text
        b1 = r1.json()
        assert b1["playing"] is True

        time.sleep(0.5)

        r2 = requests.get(f"{BASE_URL}/api/radio-studio/live/now-playing",
                          timeout=20)
        t2 = time.time()
        assert r2.status_code == 200, r2.text
        b2 = r2.json()
        assert b2["playing"] is True

        # Compute the change in loop_offset_seconds — robust across an
        # item boundary (where `now.elapsed_seconds` jumps back to ~0
        # for the new item but loop_offset keeps advancing).
        total = b1["playlist"]["total_seconds"]
        d_loop = (b2["playlist"]["loop_offset_seconds"]
                  - b1["playlist"]["loop_offset_seconds"]) % total
        wall = t2 - t1  # actual elapsed
        # Tolerance covers HTTP round-trip jitter on both probes.
        assert abs(d_loop - wall) < 0.6, \
            f"loop_offset advanced by {d_loop:.3f}s but wall clock by {wall:.3f}s"


# ------------- 6. playlist edits between cycles -------------

class TestPlaylistEditResilience:
    def test_patch_playlist_then_repoll_does_not_500(self, admin_headers, two_music_tracks):
        items = [{"type": "music", "ref_id": tid} for tid in two_music_tracks]
        _save_playlist(admin_headers, items=items, name="TEST edit-A")

        r = requests.get(f"{BASE_URL}/api/radio-studio/live/now-playing",
                         timeout=20)
        assert r.status_code == 200
        assert r.json()["playlist"]["total_items"] == 2

        # Remove one item
        _save_playlist(admin_headers,
                       items=[{"type": "music", "ref_id": two_music_tracks[0]}],
                       name="TEST edit-B")
        time.sleep(0.5)

        r2 = requests.get(f"{BASE_URL}/api/radio-studio/live/now-playing",
                         timeout=20)
        assert r2.status_code == 200, r2.text
        body = r2.json()
        assert body["playing"] is True
        assert body["playlist"]["total_items"] == 1
        # Only 1 item → `next` should be None per the endpoint contract
        assert body.get("next") is None, body


# ------------- 7. orphan refs (no audio) -------------

class TestOrphanReferences:
    def test_all_items_missing_audio_returns_playing_false(self, admin_headers, snapshot_playlist):
        # Reference random non-existent music/ad ids → resolver should
        # skip them all and we should get a clean playing:false, NOT 500.
        items = [
            {"type": "music", "ref_id": f"orphan-{uuid.uuid4().hex}"},
            {"type": "ad", "ref_id": f"orphan-{uuid.uuid4().hex}"},
        ]
        _save_playlist(admin_headers, items=items, name="TEST orphans")

        r = requests.get(f"{BASE_URL}/api/radio-studio/live/now-playing",
                         timeout=20)
        assert r.status_code == 200, f"orphan playlist 500'd: {r.status_code} {r.text}"
        body = r.json()
        assert body["playing"] is False, body
        assert "missing audio" in (body.get("reason") or "").lower(), body

        # And the stream itself must still serve (silence/keep-alive)
        # not 500. Header-only check via curl since the Python HTTP/1.1
        # client (urllib3) sometimes blocks on header arrival from the
        # CF/HTTP-2 streaming edge.
        import subprocess
        result = subprocess.run(
            ["curl", "-sS", "--max-time", "3",
             "-o", "/dev/null", "-w", "%{http_code}",
             f"{BASE_URL}/api/radio-studio/live"],
            check=False, timeout=10, capture_output=True, text=True,
        )
        assert (result.stdout or "").strip() == "200", \
            f"orphan playlist broke /live: stdout={result.stdout!r} stderr={result.stderr!r}"

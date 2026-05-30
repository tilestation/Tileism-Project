"""
Live integration tests for the Radio Studio MP3 → MongoDB storage migration.

Hits the real backend through REACT_APP_BACKEND_URL (Kubernetes ingress).
Does NOT touch ElevenLabs (the /generate endpoint is the only path that
costs real money and is explicitly excluded). Instead it covers:

  - admin ad CRUD without audio generation
  - music upload + listing + streaming round-trip
  - 15 MB cap enforcement (413 BEFORE insert)
  - non-audio content-type rejection (400)
  - public unauthenticated stream endpoints (ad + music)
  - 404 paths (missing doc / missing blob)
  - playlist round-trip
  - admin role gating (403 for non-admin)
  - audio_blob never leaks in any list/CRUD response

Cleanup: every doc created here is deleted in test fixture teardown.
"""
from __future__ import annotations

import io
import os
import uuid

import pytest
import requests


BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    # Fallback for local box where REACT_APP_BACKEND_URL is in frontend/.env
    try:
        with open("/app/frontend/.env") as f:
            for line in f:
                if line.startswith("REACT_APP_BACKEND_URL="):
                    BASE_URL = line.split("=", 1)[1].strip().rstrip("/")
                    break
    except FileNotFoundError:
        pass


# ------------- fixtures -------------

@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": "admin@test.com", "password": "admin123"},
        timeout=30,
    )
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text}"
    token = r.json().get("access_token") or r.json().get("token")
    assert token, f"no token in login response: {r.json()}"
    return token


@pytest.fixture(scope="module")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


@pytest.fixture
def tiny_mp3_bytes():
    # Bogus but non-empty "mp3" — backend only checks content-type + size.
    return b"ID3\x03\x00\x00\x00" + os.urandom(4096)


# Track created ids per test for teardown
_created = {"ads": [], "music": []}


@pytest.fixture(autouse=True)
def _cleanup(admin_headers):
    yield
    for ad_id in list(_created["ads"]):
        try:
            requests.delete(f"{BASE_URL}/api/admin/radio-studio/ads/{ad_id}",
                            headers=admin_headers, timeout=20)
        except Exception:
            pass
        _created["ads"].remove(ad_id)
    for tid in list(_created["music"]):
        try:
            requests.delete(f"{BASE_URL}/api/admin/radio-studio/music/{tid}",
                            headers=admin_headers, timeout=20)
        except Exception:
            pass
        _created["music"].remove(tid)


# ------------- ad CRUD -------------

class TestAds:
    def test_create_ad_returns_id_no_id_leak(self, admin_headers):
        payload = {
            "name": "TEST_ad_create",
            "script": "Hello showroom listeners.",
            "voice_id": "21m00Tcm4TlvDq8ikWAM",
            "voice_name": "Rachel",
        }
        r = requests.post(f"{BASE_URL}/api/admin/radio-studio/ads",
                          json=payload, headers=admin_headers, timeout=20)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "id" in data and isinstance(data["id"], str) and len(data["id"]) > 0
        assert "_id" not in data  # Mongo internal must not leak
        assert "audio_blob" not in data
        assert data["name"] == "TEST_ad_create"
        assert data["script"] == "Hello showroom listeners."
        _created["ads"].append(data["id"])

    def test_update_ad_excludes_audio_blob(self, admin_headers):
        # create
        r = requests.post(f"{BASE_URL}/api/admin/radio-studio/ads",
                          json={"name": "TEST_ad_upd", "script": "x", "voice_id": "v1"},
                          headers=admin_headers, timeout=20)
        ad_id = r.json()["id"]; _created["ads"].append(ad_id)
        # update
        r = requests.put(f"{BASE_URL}/api/admin/radio-studio/ads/{ad_id}",
                         json={"name": "TEST_ad_upd_v2"},
                         headers=admin_headers, timeout=20)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["name"] == "TEST_ad_upd_v2"
        assert "audio_blob" not in data
        assert "_id" not in data

    def test_list_ads_excludes_audio_blob(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/admin/radio-studio/ads",
                         headers=admin_headers, timeout=20)
        assert r.status_code == 200
        data = r.json()
        assert "ads" in data and "count" in data
        for ad in data["ads"]:
            assert "audio_blob" not in ad, "audio_blob leaked into list response"
            assert "_id" not in ad

    def test_update_ad_404(self, admin_headers):
        r = requests.put(f"{BASE_URL}/api/admin/radio-studio/ads/does-not-exist-{uuid.uuid4().hex}",
                         json={"name": "x"}, headers=admin_headers, timeout=20)
        assert r.status_code == 404

    def test_delete_ad_strips_from_playlist(self, admin_headers):
        # create ad
        r = requests.post(f"{BASE_URL}/api/admin/radio-studio/ads",
                          json={"name": "TEST_ad_del", "script": "x", "voice_id": "v1"},
                          headers=admin_headers, timeout=20)
        ad_id = r.json()["id"]
        # save playlist referencing it
        pl = {"name": "TEST_pl", "items": [{"type": "ad", "ref_id": ad_id}], "is_active": True}
        rp = requests.post(f"{BASE_URL}/api/admin/radio-studio/playlist",
                           json=pl, headers=admin_headers, timeout=20)
        assert rp.status_code == 200, rp.text
        # delete the ad
        rd = requests.delete(f"{BASE_URL}/api/admin/radio-studio/ads/{ad_id}",
                             headers=admin_headers, timeout=20)
        assert rd.status_code == 200
        # confirm not in playlist anymore
        rg = requests.get(f"{BASE_URL}/api/admin/radio-studio/playlist",
                          headers=admin_headers, timeout=20)
        assert rg.status_code == 200
        refs = [i["ref_id"] for i in rg.json().get("items", [])]
        assert ad_id not in refs


# ------------- music upload + stream -------------

class TestMusic:
    def test_upload_music_returns_metadata_no_blob(self, admin_headers, tiny_mp3_bytes):
        files = {"file": ("tiny.mp3", io.BytesIO(tiny_mp3_bytes), "audio/mpeg")}
        data = {"name": "TEST_music_upload"}
        r = requests.post(f"{BASE_URL}/api/admin/radio-studio/music/upload",
                          files=files, data=data, headers=admin_headers, timeout=30)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["name"] == "TEST_music_upload"
        assert "id" in body
        assert "audio_blob" not in body, "audio_blob leaked into upload response"
        assert "_id" not in body
        assert body.get("audio_bytes") == len(tiny_mp3_bytes)
        _created["music"].append(body["id"])

    def test_list_music_excludes_audio_blob(self, admin_headers, tiny_mp3_bytes):
        # ensure at least one
        files = {"file": ("tiny.mp3", io.BytesIO(tiny_mp3_bytes), "audio/mpeg")}
        r = requests.post(f"{BASE_URL}/api/admin/radio-studio/music/upload",
                          files=files, data={"name": "TEST_music_list"},
                          headers=admin_headers, timeout=30)
        _created["music"].append(r.json()["id"])

        r = requests.get(f"{BASE_URL}/api/admin/radio-studio/music",
                         headers=admin_headers, timeout=20)
        assert r.status_code == 200
        data = r.json()
        assert "tracks" in data and "count" in data
        # Response should be tiny — without blobs each entry is well under 1KB.
        assert len(r.content) < 200_000, (
            f"music list response is {len(r.content)} bytes — audio_blob is leaking"
        )
        for t in data["tracks"]:
            assert "audio_blob" not in t

    def test_upload_rejects_oversized(self, admin_headers):
        # 16 MB → must be rejected with 413 BEFORE the insert.
        big = b"\x00" * (16 * 1024 * 1024)
        files = {"file": ("big.mp3", io.BytesIO(big), "audio/mpeg")}
        r = requests.post(f"{BASE_URL}/api/admin/radio-studio/music/upload",
                          files=files, data={"name": "TEST_too_big"},
                          headers=admin_headers, timeout=120)
        assert r.status_code == 413, f"expected 413, got {r.status_code}: {r.text[:200]}"
        detail = r.json().get("detail", "").lower()
        assert "15 mb" in detail or "exceeds" in detail or "limit" in detail

    def test_upload_rejects_non_audio_content_type(self, admin_headers):
        files = {"file": ("doc.pdf", io.BytesIO(b"%PDF-1.4 fake"), "application/pdf")}
        r = requests.post(f"{BASE_URL}/api/admin/radio-studio/music/upload",
                          files=files, data={"name": "TEST_not_audio"},
                          headers=admin_headers, timeout=30)
        assert r.status_code == 400, r.text
        assert "audio" in r.json().get("detail", "").lower()

    def test_delete_music_strips_from_playlist(self, admin_headers, tiny_mp3_bytes):
        # upload
        files = {"file": ("tiny.mp3", io.BytesIO(tiny_mp3_bytes), "audio/mpeg")}
        r = requests.post(f"{BASE_URL}/api/admin/radio-studio/music/upload",
                          files=files, data={"name": "TEST_music_del"},
                          headers=admin_headers, timeout=30)
        track_id = r.json()["id"]
        # add to playlist
        pl = {"name": "TEST_pl_m", "items": [{"type": "music", "ref_id": track_id}], "is_active": True}
        requests.post(f"{BASE_URL}/api/admin/radio-studio/playlist",
                      json=pl, headers=admin_headers, timeout=20)
        # delete
        rd = requests.delete(f"{BASE_URL}/api/admin/radio-studio/music/{track_id}",
                             headers=admin_headers, timeout=20)
        assert rd.status_code == 200
        # gone from playlist
        rg = requests.get(f"{BASE_URL}/api/admin/radio-studio/playlist",
                          headers=admin_headers, timeout=20).json()
        assert track_id not in [i["ref_id"] for i in rg.get("items", [])]


# ------------- public streaming (unauthenticated) -------------

class TestStreaming:
    def test_stream_music_round_trip_unauthenticated(self, admin_headers, tiny_mp3_bytes):
        # Upload as admin
        files = {"file": ("tiny.mp3", io.BytesIO(tiny_mp3_bytes), "audio/mpeg")}
        up = requests.post(f"{BASE_URL}/api/admin/radio-studio/music/upload",
                           files=files, data={"name": "TEST_stream_music"},
                           headers=admin_headers, timeout=30)
        assert up.status_code == 200, up.text
        track_id = up.json()["id"]; _created["music"].append(track_id)

        # Fetch publicly — NO auth header
        r = requests.get(f"{BASE_URL}/api/radio-studio/stream/music/{track_id}", timeout=30)
        assert r.status_code == 200, r.text
        assert r.headers.get("content-type") == "audio/mpeg"
        assert r.content == tiny_mp3_bytes, (
            f"bytes mismatch: stored={len(tiny_mp3_bytes)}, got={len(r.content)}"
        )

    def test_stream_music_404_when_missing(self):
        r = requests.get(f"{BASE_URL}/api/radio-studio/stream/music/nope-{uuid.uuid4().hex}", timeout=20)
        assert r.status_code == 404

    def test_stream_ad_404_when_missing(self):
        r = requests.get(f"{BASE_URL}/api/radio-studio/stream/ad/nope-{uuid.uuid4().hex}", timeout=20)
        assert r.status_code == 404

    def test_stream_ad_404_when_no_audio_blob(self, admin_headers):
        # Create ad without generating audio → no audio_blob field.
        r = requests.post(f"{BASE_URL}/api/admin/radio-studio/ads",
                          json={"name": "TEST_ad_no_audio", "script": "x", "voice_id": "v1"},
                          headers=admin_headers, timeout=20)
        ad_id = r.json()["id"]; _created["ads"].append(ad_id)
        s = requests.get(f"{BASE_URL}/api/radio-studio/stream/ad/{ad_id}", timeout=20)
        assert s.status_code == 404
        assert "regenerate" in s.json().get("detail", "").lower()


# ------------- playlist round-trip -------------

class TestPlaylist:
    def test_playlist_round_trip(self, admin_headers, tiny_mp3_bytes):
        # Set up an ad + music to reference
        ad = requests.post(f"{BASE_URL}/api/admin/radio-studio/ads",
                           json={"name": "TEST_pl_ad", "script": "x", "voice_id": "v1"},
                           headers=admin_headers, timeout=20).json()
        _created["ads"].append(ad["id"])
        files = {"file": ("tiny.mp3", io.BytesIO(tiny_mp3_bytes), "audio/mpeg")}
        mu = requests.post(f"{BASE_URL}/api/admin/radio-studio/music/upload",
                           files=files, data={"name": "TEST_pl_music"},
                           headers=admin_headers, timeout=30).json()
        _created["music"].append(mu["id"])

        items = [
            {"type": "ad", "ref_id": ad["id"]},
            {"type": "music", "ref_id": mu["id"]},
        ]
        sp = requests.post(f"{BASE_URL}/api/admin/radio-studio/playlist",
                           json={"name": "TEST_playlist_rt", "items": items, "is_active": True},
                           headers=admin_headers, timeout=20)
        assert sp.status_code == 200, sp.text

        gp = requests.get(f"{BASE_URL}/api/admin/radio-studio/playlist",
                          headers=admin_headers, timeout=20)
        assert gp.status_code == 200
        body = gp.json()
        assert body["is_active"] is True
        # Items round-trip with same type+ref_id pairs
        round_pairs = [(i["type"], i["ref_id"]) for i in body["items"]]
        for item in items:
            assert (item["type"], item["ref_id"]) in round_pairs


# ------------- auth gating -------------

class TestAuthGating:
    def test_admin_endpoints_require_auth(self):
        r = requests.get(f"{BASE_URL}/api/admin/radio-studio/ads", timeout=20)
        assert r.status_code in (401, 403), f"expected 401/403, got {r.status_code}"

    def test_admin_endpoints_reject_customer(self):
        # Register a fresh non-admin user
        email = f"TEST_cust_{uuid.uuid4().hex[:8]}@example.com"
        reg = requests.post(f"{BASE_URL}/api/auth/register",
                            json={"email": email, "password": "pass1234", "name": "TestCust"},
                            timeout=20)
        if reg.status_code not in (200, 201):
            # fallback: try login if user already exists
            pytest.skip(f"register endpoint unavailable: {reg.status_code}")
        token = reg.json().get("access_token") or reg.json().get("token")
        if not token:
            li = requests.post(f"{BASE_URL}/api/auth/login",
                               json={"email": email, "password": "pass1234"}, timeout=20)
            token = li.json().get("access_token") or li.json().get("token")
        assert token, "could not obtain customer token"
        h = {"Authorization": f"Bearer {token}"}
        r = requests.get(f"{BASE_URL}/api/admin/radio-studio/ads", headers=h, timeout=20)
        assert r.status_code == 403, f"customer should be 403, got {r.status_code}: {r.text[:200]}"

    def test_public_stream_does_not_require_auth(self, admin_headers, tiny_mp3_bytes):
        files = {"file": ("tiny.mp3", io.BytesIO(tiny_mp3_bytes), "audio/mpeg")}
        up = requests.post(f"{BASE_URL}/api/admin/radio-studio/music/upload",
                           files=files, data={"name": "TEST_stream_noauth"},
                           headers=admin_headers, timeout=30)
        track_id = up.json()["id"]; _created["music"].append(track_id)
        # request WITHOUT Authorization header
        r = requests.get(f"{BASE_URL}/api/radio-studio/stream/music/{track_id}",
                         headers={}, timeout=20)
        assert r.status_code == 200
        assert r.content == tiny_mp3_bytes

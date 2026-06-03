"""
LIVE integration tests for the Radio Studio DJ-mode super-admin "jump to track"
override against the deployed preview URL.

Validates the review request:
  - 403 when no/forged token hits /api/admin/radio-studio/live/jump-to
  - 200 with jump_token (32-char hex) + started_at_epoch when super_admin posts {idx: 0}
  - GET /api/radio-studio/live/now-playing reflects current_index=0 + same jump_token
  - {idx: 999} when playlist has fewer items → 400
"""

import os
import re
import time
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://feature-verification-7.preview.emergentagent.com").rstrip("/")
ADMIN_EMAIL = "admin@test.com"
ADMIN_PASSWORD = "admin123"
HEX32 = re.compile(r"^[0-9a-f]{32}$")


@pytest.fixture(scope="module")
def super_admin_token():
    """Log in as super_admin and return the bearer token."""
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=15,
    )
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    data = r.json()
    token = data.get("access_token") or data.get("token")
    assert token, f"no token in login response: {data}"
    # Sanity-check role
    role = (data.get("user") or {}).get("role") or data.get("role")
    assert role == "super_admin", f"expected super_admin, got role={role!r} (creds may be stale)"
    return token


@pytest.fixture(scope="module")
def ensure_playlist(super_admin_token):
    """Make sure there is an active playlist with at least 1 item so that
    jump_to(idx=0) is meaningful. Returns (playlist_id, items_len)."""
    h = {"Authorization": f"Bearer {super_admin_token}"}

    # Seed starter content (idempotent) so we have ads to reference.
    requests.post(f"{BASE_URL}/api/admin/radio-studio/seed-starter-content",
                  headers=h, timeout=120)

    # Grab ads
    ads_resp = requests.get(f"{BASE_URL}/api/admin/radio-studio/ads", headers=h, timeout=15)
    assert ads_resp.status_code == 200, ads_resp.text
    payload = ads_resp.json() or []
    if isinstance(payload, dict):
        ads = payload.get("ads") or payload.get("items") or payload.get("results") or []
    else:
        ads = payload
    assert ads, "no ads available"

    def _has_audio(a):
        return bool(a.get("audio_filename") or a.get("audio_blob") or (a.get("duration_seconds") or 0) > 0)
    ads_with_audio = [a for a in ads if _has_audio(a)]
    audio_ids = {a.get("id") or a.get("_id") for a in ads_with_audio}

    # Look at existing playlist — if it already has an audio-bearing item, keep it.
    pl = requests.get(f"{BASE_URL}/api/admin/radio-studio/playlist", headers=h, timeout=15)
    existing_items = []
    if pl.status_code == 200:
        existing_items = (pl.json() or {}).get("items") or []
    existing_has_audio = any((it.get("ref_id") in audio_ids) for it in existing_items)
    if existing_items and existing_has_audio:
        return len(existing_items)

    # Otherwise (re-)save a playlist that points at an audio-bearing ad.
    if not ads_with_audio:
        pytest.skip("starter content seeded but no ads have generated audio yet — "
                    "cannot exercise live jump-to round-trip without audio")
    first_ad_id = ads_with_audio[0].get("id") or ads_with_audio[0].get("_id")
    assert first_ad_id

    # Save a 1-item active playlist
    body = {
        "name": "TEST_DJ_JUMP_PLAYLIST",
        "items": [{"type": "ad", "ref_id": first_ad_id}],
        "is_active": True,
        "repeat": True,
        "crossfade_seconds": 0.5,
    }
    save = requests.post(f"{BASE_URL}/api/admin/radio-studio/playlist",
                         headers=h, json=body, timeout=30)
    assert save.status_code in (200, 201), f"save playlist failed: {save.status_code} {save.text}"
    return 1


# --- 403: no token ----------------------------------------------------------
def test_jump_to_no_token_is_403():
    """Anonymous POST must be rejected by auth — 401 or 403 both acceptable
    (FastAPI's HTTPBearer returns 403 by default, custom deps return 401)."""
    r = requests.post(f"{BASE_URL}/api/admin/radio-studio/live/jump-to",
                      json={"idx": 0}, timeout=15)
    assert r.status_code in (401, 403), f"expected 401/403, got {r.status_code}: {r.text}"


# --- 403: forged token ------------------------------------------------------
def test_jump_to_forged_token_is_401_or_403():
    h = {"Authorization": "Bearer this.is.a.totally.fake.jwt"}
    r = requests.post(f"{BASE_URL}/api/admin/radio-studio/live/jump-to",
                      headers=h, json={"idx": 0}, timeout=15)
    assert r.status_code in (401, 403), f"expected 401/403 for forged token, got {r.status_code}"


# --- 200: super_admin jump-to idx=0 returns jump_token + started_at_epoch ---
def test_super_admin_jump_to_idx_0_returns_jump_token(super_admin_token, ensure_playlist):
    h = {"Authorization": f"Bearer {super_admin_token}"}
    r = requests.post(f"{BASE_URL}/api/admin/radio-studio/live/jump-to",
                      headers=h, json={"idx": 0}, timeout=15)
    assert r.status_code == 200, f"super_admin jump-to expected 200, got {r.status_code}: {r.text}"
    body = r.json()

    # jump_token must be a 32-char lowercase hex (uuid4 hex)
    assert "jump_token" in body, f"no jump_token in response: {body}"
    assert HEX32.match(body["jump_token"]), f"jump_token not 32-char hex: {body['jump_token']!r}"

    # started_at_epoch must be a float ~now
    assert "started_at_epoch" in body, f"no started_at_epoch in response: {body}"
    assert isinstance(body["started_at_epoch"], (int, float))
    assert abs(body["started_at_epoch"] - time.time()) < 60, \
        f"started_at_epoch should be ~now, got {body['started_at_epoch']} vs {time.time()}"

    # idx echo
    assert body.get("idx") == 0

    # --- Now GET /live/now-playing and verify it reflects the jump ---
    np = requests.get(f"{BASE_URL}/api/radio-studio/live/now-playing", timeout=15)
    assert np.status_code == 200, np.text
    np_body = np.json()
    assert np_body.get("current_index") == 0, \
        f"after jump-to(0), current_index should be 0, got {np_body.get('current_index')}"
    assert np_body.get("jump_token") == body["jump_token"], \
        f"jump_token mismatch: now-playing={np_body.get('jump_token')!r} vs jump={body['jump_token']!r}"


# --- 400: idx out of range --------------------------------------------------
def test_super_admin_jump_to_idx_out_of_range_is_400(super_admin_token, ensure_playlist):
    h = {"Authorization": f"Bearer {super_admin_token}"}
    r = requests.post(f"{BASE_URL}/api/admin/radio-studio/live/jump-to",
                      headers=h, json={"idx": 999}, timeout=15)
    assert r.status_code == 400, f"expected 400 for idx=999, got {r.status_code}: {r.text}"
    detail = (r.json() or {}).get("detail", "")
    assert "range" in detail.lower() or "out" in detail.lower(), \
        f"detail should mention out-of-range, got {detail!r}"


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])

"""
End-to-end LIVE integration tests for Radio Studio's two new content
kinds (Jan 2026 — "finish it all" run):

  * kind="qa"          — single-voice Q&A render
  * kind="trade_talk"  — 2-turn host/guest dialogue with ffmpeg concat

These tests hit the REAL FastAPI service via REACT_APP_BACKEND_URL,
log in as admin, call ElevenLabs end-to-end, then fetch the served
MP3 over the public stream endpoint and validate its byte signature.

Tests are skipped (not failed) when ElevenLabs credits are absent so
they remain safe for CI when the API key gates are off.

NOTE: The starter-content endpoint is `/seed-starter-content` (NOT
/starter-content as written in the review request) and the public
stream is `/radio-studio/stream/ad/{id}` (NOT /audio/{id}).
"""
from __future__ import annotations

import os
import time
import uuid

import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/") or \
    pytest.fail("REACT_APP_BACKEND_URL missing")

ADMIN_EMAIL = "admin@test.com"
ADMIN_PASSWORD = "admin123"
TIMEOUT = 120  # ElevenLabs convert + ffmpeg concat can be slow


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def admin_token() -> str:
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=30,
    )
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text}"
    tok = r.json().get("access_token") or r.json().get("token")
    assert tok, f"No token in login response: {r.json()}"
    return tok


@pytest.fixture(scope="module")
def auth_headers(admin_token: str) -> dict:
    return {"Authorization": f"Bearer {admin_token}"}


@pytest.fixture(scope="module")
def voices(auth_headers) -> list[dict]:
    r = requests.get(
        f"{BASE_URL}/api/admin/radio-studio/voices",
        headers=auth_headers, timeout=30,
    )
    assert r.status_code == 200, f"voices fetch failed: {r.status_code} {r.text}"
    body = r.json()
    items = body if isinstance(body, list) else body.get("voices") or body.get("items") or []
    if not items:
        pytest.skip("No ElevenLabs voices configured — can't run live TTS")
    return items


# Track created ads for teardown
_created_ad_ids: list[str] = []


@pytest.fixture(scope="module", autouse=True)
def _cleanup_created_ads(auth_headers):
    yield
    for ad_id in _created_ad_ids:
        try:
            requests.delete(
                f"{BASE_URL}/api/admin/radio-studio/ads/{ad_id}",
                headers=auth_headers, timeout=15,
            )
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _is_valid_mp3(data: bytes) -> bool:
    """ID3v2 header or MPEG frame-sync (0xFFFB / 0xFFF3 / 0xFFFA / 0xFFF2)."""
    if len(data) < 4:
        return False
    if data[:3] == b"ID3":
        return True
    if data[0] == 0xFF and (data[1] & 0xE0) == 0xE0:
        return True
    return False


def _create_ad(payload: dict, headers: dict) -> str:
    r = requests.post(
        f"{BASE_URL}/api/admin/radio-studio/ads",
        json=payload, headers=headers, timeout=30,
    )
    assert r.status_code in (200, 201), f"create ad failed: {r.status_code} {r.text}"
    ad = r.json()
    ad_id = ad.get("id") or ad.get("_id") or ad.get("ad_id")
    assert ad_id, f"No id in create response: {ad}"
    _created_ad_ids.append(ad_id)
    return ad_id


def _generate(ad_id: str, headers: dict) -> dict:
    r = requests.post(
        f"{BASE_URL}/api/admin/radio-studio/ads/{ad_id}/generate",
        headers=headers, timeout=TIMEOUT,
    )
    assert r.status_code == 200, f"generate failed: {r.status_code} {r.text}"
    return r.json()


def _fetch_audio(ad_id: str) -> requests.Response:
    return requests.get(
        f"{BASE_URL}/api/radio-studio/stream/ad/{ad_id}",
        timeout=60,
    )


# ---------------------------------------------------------------------------
# Q&A end-to-end (real ElevenLabs)
# ---------------------------------------------------------------------------

def test_qa_end_to_end_generates_playable_mp3(auth_headers, voices):
    voice_id = voices[0].get("voice_id") or voices[0].get("id")
    assert voice_id, f"No voice_id field: {voices[0]}"

    ad_id = _create_ad({
        "name": f"TEST_QA_{uuid.uuid4().hex[:8]}",
        "kind": "qa",
        "question": "Can I tile straight onto plasterboard in a shower?",
        "script": "Short answer: no. You need a tile backer board.",
        "voice_id": voice_id,
        "narrate_question": True,
    }, auth_headers)

    _generate(ad_id, auth_headers)

    r = _fetch_audio(ad_id)
    assert r.status_code == 200, f"stream fetch failed: {r.status_code} {r.text[:200]}"
    assert r.headers.get("content-type", "").startswith("audio/mpeg"), \
        f"wrong content-type: {r.headers.get('content-type')}"
    assert len(r.content) > 5000, f"audio too small: {len(r.content)} bytes"
    assert _is_valid_mp3(r.content), \
        f"not a valid MP3 (first bytes: {r.content[:4].hex()})"


# ---------------------------------------------------------------------------
# Trade Talk end-to-end (real ElevenLabs + ffmpeg concat)
# ---------------------------------------------------------------------------

def test_trade_talk_end_to_end_generates_concatenated_mp3(auth_headers, voices):
    if len(voices) < 2:
        pytest.skip("Need at least 2 voices for host/guest Trade Talk")
    host_voice = voices[0].get("voice_id") or voices[0].get("id")
    guest_voice = voices[1].get("voice_id") or voices[1].get("id")
    assert host_voice and guest_voice and host_voice != guest_voice

    ad_id = _create_ad({
        "name": f"TEST_TT_{uuid.uuid4().hex[:8]}",
        "kind": "trade_talk",
        "host_voice_id": host_voice,
        "guest_voice_id": guest_voice,
        "turns": [
            {"speaker": "host", "text": "Welcome back to Trade Talk."},
            {"speaker": "guest", "text": "Hi Mark, quick porcelain question."},
        ],
    }, auth_headers)

    _generate(ad_id, auth_headers)

    r = _fetch_audio(ad_id)
    assert r.status_code == 200, f"stream fetch failed: {r.status_code} {r.text[:200]}"
    assert r.headers.get("content-type", "").startswith("audio/mpeg")
    assert len(r.content) > 10000, \
        f"trade_talk audio suspiciously small for 2 turns + gap: {len(r.content)}"
    assert _is_valid_mp3(r.content), \
        f"not a valid MP3 (first bytes: {r.content[:4].hex()})"


# ---------------------------------------------------------------------------
# Script generators (real Claude via Emergent LLM key)
# ---------------------------------------------------------------------------

def test_generate_qa_script_returns_well_formed_json(auth_headers):
    r = requests.post(
        f"{BASE_URL}/api/admin/radio-studio/scripts/generate-qa",
        json={"question": "What underlayment for porcelain over UFH?"},
        headers=auth_headers, timeout=60,
    )
    assert r.status_code == 200, f"qa script gen failed: {r.status_code} {r.text}"
    body = r.json()
    assert "question" in body
    assert "answer" in body
    assert isinstance(body["answer"], str) and len(body["answer"].strip()) > 20
    assert body.get("approx_words", 0) > 0


def test_generate_trade_talk_script_returns_turns_array(auth_headers):
    r = requests.post(
        f"{BASE_URL}/api/admin/radio-studio/scripts/generate-trade-talk",
        json={"topic": "Choosing the right adhesive for large-format porcelain"},
        headers=auth_headers, timeout=90,
    )
    assert r.status_code == 200, f"trade-talk script gen failed: {r.status_code} {r.text}"
    body = r.json()
    assert "turns" in body
    turns = body["turns"]
    assert isinstance(turns, list) and len(turns) >= 4, f"too few turns: {turns}"
    speakers = {t["speaker"] for t in turns}
    assert speakers == {"host", "guest"}, f"unexpected speakers: {speakers}"
    for t in turns:
        assert t.get("text", "").strip(), f"empty turn: {t}"


# ---------------------------------------------------------------------------
# Starter seed endpoint
# ---------------------------------------------------------------------------

def test_seed_starter_content_returns_counts(auth_headers):
    r = requests.post(
        f"{BASE_URL}/api/admin/radio-studio/seed-starter-content",
        headers=auth_headers, timeout=30,
    )
    assert r.status_code == 200, f"seed failed: {r.status_code} {r.text}"
    body = r.json()
    assert body.get("success") is True
    qa = body.get("inserted_qa", 0)
    tt = body.get("inserted_trade_talk", 0)
    skipped = body.get("skipped", 0)
    # idempotent: a fresh DB inserts 20+10=30; a previously-seeded
    # DB skips all 30. Either way the total must == 30.
    assert qa + tt + skipped == 30, \
        f"unexpected seed counts: qa={qa} tt={tt} skipped={skipped}"


# ---------------------------------------------------------------------------
# Public stream 404 on missing audio (regression — non-generated ad)
# ---------------------------------------------------------------------------

def test_public_stream_404_when_audio_not_generated(auth_headers, voices):
    voice_id = voices[0].get("voice_id") or voices[0].get("id")
    ad_id = _create_ad({
        "name": f"TEST_NOAUDIO_{uuid.uuid4().hex[:8]}",
        "kind": "qa",
        "question": "test?",
        "script": "test answer",
        "voice_id": voice_id,
    }, auth_headers)
    r = _fetch_audio(ad_id)
    assert r.status_code == 404, \
        f"expected 404 for un-generated ad, got {r.status_code}"

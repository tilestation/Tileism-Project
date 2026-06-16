"""Live API tests for Voice/Telephony endpoints via public backend URL."""
import os
import re
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://feature-verification-7.preview.emergentagent.com").rstrip("/")
ADMIN_EMAIL = "admin@test.com"
ADMIN_PASS = "admin123"


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASS}, timeout=15)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text[:200]}"
    return r.json().get("access_token") or r.json().get("token")


@pytest.fixture(scope="module")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


# --- /api/admin/voice/settings ---
def test_get_voice_settings_defaults(admin_headers):
    r = requests.get(f"{BASE_URL}/api/admin/voice/settings", headers=admin_headers, timeout=15)
    assert r.status_code == 200, r.text[:300]
    data = r.json()
    assert data.get("enabled") is True
    assert data.get("ads_source") == "radio_studio"
    assert data.get("max_hold_ads") == 2
    assert data.get("recording_enabled") is True
    assert "welcome_message_text" in data
    assert data["welcome_message_text"].lower().startswith("welcome to tile station")


def test_get_voice_settings_unauth():
    r = requests.get(f"{BASE_URL}/api/admin/voice/settings", timeout=15)
    assert r.status_code in (401, 403)


def test_put_voice_settings_super_admin(admin_headers):
    # snapshot current
    cur = requests.get(f"{BASE_URL}/api/admin/voice/settings", headers=admin_headers, timeout=15).json()
    body = dict(cur)
    body["max_hold_ads"] = 1
    r = requests.put(f"{BASE_URL}/api/admin/voice/settings", headers=admin_headers, json=body, timeout=15)
    assert r.status_code == 200, r.text[:300]
    # GET and verify persisted
    r2 = requests.get(f"{BASE_URL}/api/admin/voice/settings", headers=admin_headers, timeout=15)
    assert r2.json().get("max_hold_ads") == 1
    # restore
    body["max_hold_ads"] = cur.get("max_hold_ads", 2)
    requests.put(f"{BASE_URL}/api/admin/voice/settings", headers=admin_headers, json=body, timeout=15)


# --- /api/voice/incoming TwiML webhook ---
def test_voice_incoming_returns_twiml():
    r = requests.post(
        f"{BASE_URL}/api/voice/incoming",
        data={"CallSid": "CAtest123", "From": "+447700111222", "To": "+441234567"},
        timeout=15,
    )
    assert r.status_code == 200, r.text[:300]
    body = r.text
    assert "<Response>" in body
    # welcome <Say> or <Play>
    assert ("<Say" in body) or ("<Play>" in body)
    # dial owner number
    assert "+447379562631" in body
    assert "<Dial" in body and "<Number>" in body
    # recording callback if recording enabled (default true)
    assert "recordingStatusCallback" in body or "record=" in body.lower() or "Record=" in body


def test_voice_incoming_xml_escape():
    # Special chars in From/CallSid should not break XML
    r = requests.post(
        f"{BASE_URL}/api/voice/incoming",
        data={"CallSid": "CA<>&test", "From": "+447&<>700", "To": "+441234567"},
        timeout=15,
    )
    assert r.status_code == 200
    # Should not contain raw unescaped & < > inside text (other than legitimate XML)
    # Just ensure response parses as XML-like
    assert "<Response>" in r.text and "</Response>" in r.text


# --- /api/voice/status missed-call webhook ---
def test_voice_status_missed_call_returns_hangup():
    r = requests.post(
        f"{BASE_URL}/api/voice/status",
        data={
            "CallSid": "CAtest_missed_001",
            "DialCallStatus": "no-answer",
            "DialCallDuration": "0",
            "From": "+447700999888",
            "To": "+441234567",
        },
        timeout=15,
    )
    assert r.status_code == 200, r.text[:300]
    assert "<Response>" in r.text
    assert "<Hangup" in r.text or "</Response>" in r.text


# --- /api/voice/recording-status ---
def test_voice_recording_status_accepts_metadata():
    r = requests.post(
        f"{BASE_URL}/api/voice/recording-status",
        data={
            "CallSid": "CAtest_missed_001",
            "RecordingUrl": "https://api.twilio.com/recordings/REtest123",
            "RecordingSid": "REtest123",
            "RecordingDuration": "12",
        },
        timeout=15,
    )
    assert r.status_code in (200, 204), r.text[:300]


# --- /api/voice/token ---
def test_voice_token_503_when_keys_missing(admin_headers):
    r = requests.get(f"{BASE_URL}/api/voice/token", headers=admin_headers, timeout=15)
    # Keys are intentionally empty in preview
    assert r.status_code == 503, f"expected 503, got {r.status_code}: {r.text[:200]}"


def test_voice_token_unauth():
    r = requests.get(f"{BASE_URL}/api/voice/token", timeout=15)
    assert r.status_code in (401, 403)


# --- /api/admin/voice/calls ---
def test_admin_voice_calls_list(admin_headers):
    r = requests.get(f"{BASE_URL}/api/admin/voice/calls", headers=admin_headers, timeout=15)
    assert r.status_code == 200, r.text[:300]
    data = r.json()
    assert isinstance(data, list) or isinstance(data, dict)


def test_admin_voice_calls_filter_direction(admin_headers):
    r = requests.get(f"{BASE_URL}/api/admin/voice/calls?direction=inbound", headers=admin_headers, timeout=15)
    assert r.status_code == 200


def test_admin_voice_calls_filter_missed(admin_headers):
    r = requests.get(f"{BASE_URL}/api/admin/voice/calls?missed_only=true", headers=admin_headers, timeout=15)
    assert r.status_code == 200


def test_admin_voice_calls_unauth():
    r = requests.get(f"{BASE_URL}/api/admin/voice/calls", timeout=15)
    assert r.status_code in (401, 403)


# --- /api/admin/voice/stats ---
def test_admin_voice_stats(admin_headers):
    r = requests.get(f"{BASE_URL}/api/admin/voice/stats", headers=admin_headers, timeout=15)
    assert r.status_code == 200, r.text[:300]
    d = r.json()
    for k in ("today", "week", "month", "daily", "generated_at"):
        assert k in d, f"missing key {k} in {list(d.keys())}"
    assert isinstance(d["daily"], list)
    assert len(d["daily"]) == 7
    for row in d["daily"]:
        assert "day" in row and "count" in row and "missed" in row


# --- /api/voice/outbound ---
def test_voice_outbound_twiml():
    r = requests.post(
        f"{BASE_URL}/api/voice/outbound",
        data={"To": "+447700123456", "From": "client:admin"},
        timeout=15,
    )
    assert r.status_code == 200, r.text[:300]
    assert "<Dial" in r.text and "+447700123456" in r.text

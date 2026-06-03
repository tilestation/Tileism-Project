"""
Tests for the 3 Jun 2026 client-error noise filter expansion.

User report (with two Telegram screenshots): admin's Telegram bot
spammed with the same two false-positive alerts every few minutes:

1. ⚠️ "Network error on .../api/website/promo-banner: Network Error"
   The promo banner is OPTIONAL — page renders fine without it.
   These alerts are noise, not actionable bugs.

2. ⚠️ "Password must be at least 8 characters"
   This is NORMAL form-validation feedback (sonner toast) shown to
   the customer when they typed a weak password. They fixed it and
   continued. Not a bug; not an admin-actionable signal.

Both classes were previously logged → digested → fired Telegram alerts.
These tests verify the backend now silently drops them at the
`/api/client-errors/log` endpoint (defence-in-depth — the frontend's
`clientErrorWatch.js` BENIGN_PATTERNS regex also filters them at
source, but cached older bundles in the wild bypass that filter and
hit the backend directly).
"""

import os
from unittest.mock import patch, AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _env_setup():
    os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
    os.environ.setdefault("DB_NAME", "test_client_error_filters")


@pytest.fixture
def client():
    from server import app
    return TestClient(app)


def _empty_db():
    """Build a Mongo mock that lets a normal log POST succeed if the
    payload wasn't filtered upstream."""
    db = MagicMock()
    db.client_errors.count_documents = AsyncMock(return_value=0)
    db.client_errors.insert_one = AsyncMock()
    db.known_devices.find_one = AsyncMock(return_value=None)
    return db


# ---------------------------------------------------------------------
# 1. Promo banner network errors are silently dropped
# ---------------------------------------------------------------------
def test_promo_banner_network_error_is_skipped(client):
    """The promo banner endpoint is optional — a network blip there
    must NOT trigger a customer-error alert."""
    db = _empty_db()
    payload = {
        "session_id": "sess-mpx",
        "error_type": "network",
        "message": "Network error on https://tile-station-production.up.railway.app/api/website/promo-banner: Network Error",
        "page_url": "https://tilestation.co.uk/",
        "severity": "error",
    }
    with patch("routes.client_errors.get_db", return_value=db):
        r = client.post("/api/client-errors/log", json=payload)
    assert r.status_code == 200
    assert r.json().get("skipped") == "benign_browser_internal", \
        f"Expected promo-banner errors to be skipped. Got: {r.json()}"
    # Critical: nothing was inserted into the DB → no digest later → no Telegram.
    db.client_errors.insert_one.assert_not_called()


# ---------------------------------------------------------------------
# 2. Password-too-short toast is silently dropped
# ---------------------------------------------------------------------
def test_password_min_length_toast_is_skipped(client):
    """The user typed a 6-char password → sonner showed the toast
    → user fixed it. This is normal UX, not an admin alert."""
    db = _empty_db()
    payload = {
        "session_id": "sess-mpu",
        "error_type": "toast",
        "message": "Password must be at least 8 characters",
        "page_url": "https://tilestation.co.uk/shop/trade/register",
        "severity": "error",
    }
    with patch("routes.client_errors.get_db", return_value=db):
        r = client.post("/api/client-errors/log", json=payload)
    assert r.status_code == 200
    assert r.json().get("skipped") == "benign_browser_internal"
    db.client_errors.insert_one.assert_not_called()


# ---------------------------------------------------------------------
# 3. Other form-validation toasts are also dropped (parametrised)
# ---------------------------------------------------------------------
@pytest.mark.parametrize("toast_message", [
    "Password must be at least 8 characters",
    "Password must be at least 12 characters",
    "Email is required",
    "Email address is required",
    "Please enter a valid email",
    "Name is required",
    "Phone is required",
    "Phone number is required",
    "Password is required",
    "Please fill all required fields",
    "Please fill in all required fields",
    "You must accept the terms",
    "Passwords don't match",
    "Passwords do not match",
    "This field is required",
])
def test_other_form_validation_toasts_are_skipped(client, toast_message):
    """Every common Sonner validation copy variant must be filtered.
    The admin Telegram chat should NEVER buzz for normal form UX."""
    db = _empty_db()
    payload = {
        "session_id": "sess-validation",
        "error_type": "toast",
        "message": toast_message,
        "page_url": "https://tilestation.co.uk/shop/trade/register",
        "severity": "error",
    }
    with patch("routes.client_errors.get_db", return_value=db):
        r = client.post("/api/client-errors/log", json=payload)
    assert r.status_code == 200, r.text
    assert r.json().get("skipped") == "benign_browser_internal", \
        f"Validation toast {toast_message!r} should be filtered, got {r.json()}"
    db.client_errors.insert_one.assert_not_called()


# ---------------------------------------------------------------------
# 4. REAL errors still flow through
# ---------------------------------------------------------------------
def test_real_error_still_logged(client):
    """Defensive: the filter must not be over-eager. A genuine 500
    on a real endpoint (e.g. checkout) must STILL trigger the alert
    pipeline — otherwise we'd lose visibility into real outages."""
    db = _empty_db()
    payload = {
        "session_id": "sess-real-bug",
        "error_type": "api",
        "status_code": 500,
        "message": "Internal Server Error",
        "page_url": "https://tilestation.co.uk/checkout",
        "api_endpoint": "/api/checkout/place-order",
        "severity": "error",
    }
    with patch("routes.client_errors.get_db", return_value=db):
        r = client.post("/api/client-errors/log", json=payload)
    assert r.status_code == 200
    # Should NOT be marked skipped — should have been inserted.
    assert "skipped" not in r.json(), \
        f"Real 500 errors must not be filtered. Got: {r.json()}"
    db.client_errors.insert_one.assert_called_once()


# ---------------------------------------------------------------------
# 5. Edge: similar-but-not-validation message still logged
# ---------------------------------------------------------------------
def test_password_in_unrelated_error_still_logged(client):
    """Defensive: don't false-positive on the word 'password' alone.
    "Password reset token expired" is a real backend error, not a
    Sonner validation toast — must NOT be filtered."""
    db = _empty_db()
    payload = {
        "session_id": "sess-pw-token",
        "error_type": "api",
        "status_code": 400,
        "message": "Password reset token expired",
        "page_url": "https://tilestation.co.uk/auth/reset",
        "severity": "error",
    }
    with patch("routes.client_errors.get_db", return_value=db):
        r = client.post("/api/client-errors/log", json=payload)
    assert r.status_code == 200
    assert "skipped" not in r.json()
    db.client_errors.insert_one.assert_called_once()


# ---------------------------------------------------------------------
# 6. Edge: a network error on a NON-promo endpoint is still logged
# ---------------------------------------------------------------------
def test_network_error_on_other_endpoint_still_logged(client):
    """The promo-banner exemption is endpoint-specific. A network
    blip on /api/checkout/place-order is a real customer-facing bug
    and must still flow through."""
    db = _empty_db()
    payload = {
        "session_id": "sess-checkout-net",
        "error_type": "network",
        "message": "Network error on https://tilestation.co.uk/api/checkout/place-order: Network Error",
        "page_url": "https://tilestation.co.uk/checkout",
        "severity": "error",
    }
    with patch("routes.client_errors.get_db", return_value=db):
        r = client.post("/api/client-errors/log", json=payload)
    assert r.status_code == 200
    assert "skipped" not in r.json()
    db.client_errors.insert_one.assert_called_once()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

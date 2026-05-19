"""
Tests for one-click device-approval magic links (24 Feb 2026).

User intent: same flow as no-invoice refunds — receive an email with
embedded ✓ Approve / ✗ Deny buttons; clicking either button decides
the request without needing to log in to admin.

Workflow:
  1. User signs in from a new device → `device_approvals.insert_one(...)`
     fires (server.py login route). Email goes out to all super admins.
  2. Super Admin clicks Approve in email →
     `GET /api/device-approvals/{id}/approve?token=...`
     → approval doc flips to `status=approved`, approved_devices row
       created, audit row written. HTML "Approved" page renders.
  3. Re-click → "Already approved" page (idempotent).
  4. Tampered token → "Invalid link" page (no info leak).
"""
import os
import uuid
import hmac
import hashlib
from datetime import datetime, timezone

import pytest
import httpx

API_URL = (
    os.environ.get("EXTERNAL_URL")
    or open("/app/frontend/.env").read().split("REACT_APP_BACKEND_URL=")[1].split("\n")[0].strip()
)
ADMIN_EMAIL = "admin@test.com"
ADMIN_PW = "admin123"


def _jwt_secret():
    """Read JWT_SECRET from backend/.env so signed tokens match the running server."""
    try:
        for line in open("/app/backend/.env").read().splitlines():
            if line.startswith("JWT_SECRET"):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return os.environ.get("JWT_SECRET", "your-secret-key-change-in-production")


def _sign(approval_id: str, action: str) -> str:
    """Mirror the backend's _sign_device_approval_token logic."""
    secret = _jwt_secret()
    msg = f"device_approval:{approval_id}:{action}".encode()
    return hmac.new(secret.encode(), msg, hashlib.sha256).hexdigest()[:32]


@pytest.fixture(scope="module")
def admin_token():
    with httpx.Client(base_url=API_URL, timeout=30) as c:
        r = c.post("/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PW})
        r.raise_for_status()
        yield r.json().get("access_token") or r.json().get("token")


@pytest.fixture
def http(admin_token):
    with httpx.Client(
        base_url=API_URL, timeout=30,
        headers={"Authorization": f"Bearer {admin_token}"},
    ) as c:
        yield c


def _seed_pending_approval(http):
    """Create a pending device_approvals row directly via Mongo so we
    don't have to mock the entire login flow."""
    from pymongo import MongoClient
    env = open("/app/backend/.env").read()
    mongo = next(l for l in env.split("\n") if l.startswith("MONGO_URL")).split("=", 1)[1].strip().strip('"')
    dbn = next(l for l in env.split("\n") if l.startswith("DB_NAME")).split("=", 1)[1].strip().strip('"')
    client = MongoClient(mongo)
    approval_id = str(uuid.uuid4())
    client[dbn].device_approvals.insert_one({
        "id": approval_id,
        "user_email": "qasim+test@tilestation.co.uk",
        "device_id": str(uuid.uuid4()),
        "device_name": "iPhone 15 Pro Max",
        "device_type": "mobile",
        "ip_address": "203.0.113.42",
        "status": "pending",
        "requested_at": datetime.now(timezone.utc).isoformat(),
    })
    return approval_id, client[dbn]


# ─── Approve path ────────────────────────────────────────────────────
def test_magic_link_approve_creates_approved_device(http):
    approval_id, db = _seed_pending_approval(http)
    try:
        # ✓ Approve via magic link (no auth header needed)
        token = _sign(approval_id, "approve")
        anon = httpx.Client(base_url=API_URL, timeout=30)
        r = anon.get(f"/api/device-approvals/{approval_id}/approve?token={token}")
        assert r.status_code == 200, r.text
        assert "approved" in r.text.lower()
        # DB checks
        approval = db.device_approvals.find_one({"id": approval_id})
        assert approval["status"] == "approved"
        # approved_devices row created
        device = db.approved_devices.find_one({"user_email": "qasim+test@tilestation.co.uk"})
        assert device
        assert device["device_name"] == "iPhone 15 Pro Max"
    finally:
        db.device_approvals.delete_one({"id": approval_id})
        db.approved_devices.delete_many({"user_email": "qasim+test@tilestation.co.uk"})


# ─── Deny path ───────────────────────────────────────────────────────
def test_magic_link_deny_does_not_create_approved_device(http):
    approval_id, db = _seed_pending_approval(http)
    try:
        token = _sign(approval_id, "deny")
        anon = httpx.Client(base_url=API_URL, timeout=30)
        r = anon.get(f"/api/device-approvals/{approval_id}/deny?token={token}")
        assert r.status_code == 200, r.text
        assert "denied" in r.text.lower()
        approval = db.device_approvals.find_one({"id": approval_id})
        assert approval["status"] == "rejected"
        # No approved_devices row
        assert db.approved_devices.find_one({"user_email": "qasim+test@tilestation.co.uk"}) is None
    finally:
        db.device_approvals.delete_one({"id": approval_id})


# ─── Tamper protection ───────────────────────────────────────────────
def test_magic_link_tampered_token_rejected(http):
    approval_id, db = _seed_pending_approval(http)
    try:
        anon = httpx.Client(base_url=API_URL, timeout=30)
        r = anon.get(f"/api/device-approvals/{approval_id}/approve?token=NOT-A-REAL-TOKEN-XYZ")
        assert r.status_code == 200  # rendered as HTML error page, not 401
        assert "tampered" in r.text.lower() or "invalid" in r.text.lower()
        # Approval must STILL be pending
        approval = db.device_approvals.find_one({"id": approval_id})
        assert approval["status"] == "pending"
    finally:
        db.device_approvals.delete_one({"id": approval_id})


# ─── Replay protection ───────────────────────────────────────────────
def test_magic_link_re_click_is_idempotent(http):
    approval_id, db = _seed_pending_approval(http)
    try:
        token = _sign(approval_id, "approve")
        anon = httpx.Client(base_url=API_URL, timeout=30)
        r1 = anon.get(f"/api/device-approvals/{approval_id}/approve?token={token}")
        assert r1.status_code == 200
        r2 = anon.get(f"/api/device-approvals/{approval_id}/approve?token={token}")
        assert r2.status_code == 200
        assert "already" in r2.text.lower()
        # Only ONE approved_devices row even after re-click
        rows = list(db.approved_devices.find({"user_email": "qasim+test@tilestation.co.uk"}))
        assert len(rows) == 1
    finally:
        db.device_approvals.delete_one({"id": approval_id})
        db.approved_devices.delete_many({"user_email": "qasim+test@tilestation.co.uk"})


# ─── Token-namespace separation ──────────────────────────────────────
def test_refund_token_cannot_approve_device(http):
    """A token signed for a REFUND request must not work on a device
    approval endpoint. Different namespaces in the HMAC message."""
    approval_id, db = _seed_pending_approval(http)
    try:
        # Forge a token using the refund namespace (no "device_approval:" prefix)
        secret = _jwt_secret()
        wrong = hmac.new(secret.encode(), f"{approval_id}:approve".encode(), hashlib.sha256).hexdigest()[:32]
        anon = httpx.Client(base_url=API_URL, timeout=30)
        r = anon.get(f"/api/device-approvals/{approval_id}/approve?token={wrong}")
        assert "invalid" in r.text.lower() or "tampered" in r.text.lower()
        approval = db.device_approvals.find_one({"id": approval_id})
        assert approval["status"] == "pending", "Refund-namespace token must NOT approve a device"
    finally:
        db.device_approvals.delete_one({"id": approval_id})


# ─── Invalid action ──────────────────────────────────────────────────
def test_magic_link_unknown_action_rejected(http):
    approval_id, db = _seed_pending_approval(http)
    try:
        # Pretend the email got mangled to /delete instead of /approve|deny
        anon = httpx.Client(base_url=API_URL, timeout=30)
        r = anon.get(f"/api/device-approvals/{approval_id}/delete?token=anything")
        # FastAPI's routing rejects the literal "delete" doesn't match path
        # template — but Approve/Deny case is OK. Just verify pending stays.
        approval = db.device_approvals.find_one({"id": approval_id})
        assert approval["status"] == "pending"
    finally:
        db.device_approvals.delete_one({"id": approval_id})

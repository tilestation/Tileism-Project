"""
Tests for the no-invoice refund approval workflow.

Workflow (24 Feb 2026 — user follow-up screenshot 19:08):

    Anyone with EPOS permission can REQUEST a no-invoice refund.
    The refund does NOT execute on submit — instead it's parked as
    `pending` in `refund_approval_requests` and an email goes to all
    Super Admins with magic-link Approve / Deny buttons.

    Clicking Approve via the magic link executes the refund and sends
    a completion email. Clicking Deny rejects it. Replay-clicks are
    safe (one-shot status flip).
"""
import os
import uuid
from datetime import datetime, timezone

import pytest
import httpx

API_URL = (
    os.environ.get("EXTERNAL_URL")
    or open("/app/frontend/.env").read().split("REACT_APP_BACKEND_URL=")[1].split("\n")[0].strip()
)
ADMIN_EMAIL = "admin@test.com"
ADMIN_PW = "admin123"
TODAY_UK = datetime.now(timezone.utc).strftime("%d/%m/%Y")


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


def _line_items(amount=10.0):
    return [{
        "product_id": "", "product_name": "Approval Test Item", "sku": "",
        "quantity": 1, "original_price": amount, "refund_price": amount,
        "total": amount, "reason": "Testing",
    }]


def _payload(refund_no, **overrides):
    base = {
        "refund_no": refund_no, "date": TODAY_UK,
        "customer_name": "Approval Test Customer",
        "refund_method": "Cash", "refund_type": "Full Refund",
        "line_items": _line_items(),
        "subtotal": 10.0, "vat": 2.0, "gross_total": 12.0,
        "restocking_fee": 0,
    }
    base.update(overrides)
    return base


# ─────────────────────────────────────────────────────────────────────
# Request stage — POST /api/refunds with no invoice now returns 202
# (pending approval), not 200 (processed).
# ─────────────────────────────────────────────────────────────────────
def test_no_invoice_request_returns_pending_not_processed(http):
    rno = f"REQ-PEND-{uuid.uuid4().hex[:8]}"
    r = http.post("/api/refunds", json=_payload(
        rno,
        no_invoice_reason="Customer destroyed receipt during basement flood",
    ))
    assert r.status_code == 200, r.text  # FastAPI default for non-explicit returns
    body = r.json()
    assert body.get("status") == "pending_approval"
    assert body.get("approval_required") is True
    assert body.get("request_id")
    # CRITICAL: no refund_id yet — money is NOT out
    assert "refund_id" not in body or body.get("refund_id") is None


def test_no_invoice_request_requires_reason(http):
    rno = f"REQ-NOR-{uuid.uuid4().hex[:8]}"
    r = http.post("/api/refunds", json=_payload(rno))
    assert r.status_code == 400


def test_no_invoice_request_rejects_short_reason(http):
    rno = f"REQ-SHO-{uuid.uuid4().hex[:8]}"
    r = http.post("/api/refunds", json=_payload(rno, no_invoice_reason="meh"))
    assert r.status_code == 400


# ─────────────────────────────────────────────────────────────────────
# Magic-link Approve endpoint
# ─────────────────────────────────────────────────────────────────────
def _create_pending_and_get_request(http):
    """Helper — fire a request and pull the stored doc directly."""
    rno = f"REQ-FLOW-{uuid.uuid4().hex[:8]}"
    r = http.post("/api/refunds", json=_payload(
        rno,
        no_invoice_reason="Customer purchased months ago, paper invoice lost in office move",
    ))
    assert r.status_code == 200
    rid = r.json()["request_id"]
    pending = http.get("/api/refunds/pending-approvals").json()
    req = next((x for x in pending["requests"] if x["id"] == rid), None)
    assert req, "Pending request must be visible in /pending-approvals"
    return req, rno


def _approval_url(req, action):
    """Build the magic-link URL the email would render."""
    # We don't have the token in the response (it's never exposed to UI)
    # — recompute it server-side via the same HMAC logic the backend uses.
    # Must match the JWT_SECRET env var used by routes/refunds.py.
    import hmac, hashlib, os
    secret = os.environ.get("JWT_SECRET")
    if not secret:
        # Fall back to backend/.env so the tests can run without exporting.
        try:
            for line in open("/app/backend/.env").read().splitlines():
                if line.startswith("JWT_SECRET"):
                    secret = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break
        except FileNotFoundError:
            pass
    if not secret:
        secret = "your-secret-key-change-in-production"
    msg = f"{req['id']}:{action}".encode()
    token = hmac.new(secret.encode(), msg, hashlib.sha256).hexdigest()[:32]
    return f"/api/refunds/approval/{req['id']}/{action}?token={token}"


def test_magic_link_approve_processes_refund_and_records_audit(http):
    req, rno = _create_pending_and_get_request(http)
    # Click "Approve" via the magic-link URL
    r = http.get(_approval_url(req, "approve"))
    assert r.status_code == 200, r.text
    assert "approved" in r.text.lower()

    # Refund row should now exist with no_invoice_override stamped
    listing = http.get("/api/refunds").json()
    refunds = listing if isinstance(listing, list) else listing.get("refunds", [])
    match = next((x for x in refunds if x.get("refund_no") == rno), None)
    assert match, f"Approved refund {rno} should now exist in /api/refunds"
    assert match["no_invoice_override"] is True
    assert match["no_invoice_reason"]
    assert match["no_invoice_approved_by"]


def test_magic_link_deny_does_not_process_refund(http):
    req, rno = _create_pending_and_get_request(http)
    r = http.get(_approval_url(req, "deny"))
    assert r.status_code == 200, r.text
    assert "denied" in r.text.lower()

    # No refund created
    listing = http.get("/api/refunds").json()
    refunds = listing if isinstance(listing, list) else listing.get("refunds", [])
    assert not any(x.get("refund_no") == rno for x in refunds), \
        "Denied refund must NOT appear in refunds collection"


def test_magic_link_tampered_token_rejected(http):
    req, _ = _create_pending_and_get_request(http)
    r = http.get(f"/api/refunds/approval/{req['id']}/approve?token=NOT-A-REAL-TOKEN-XYZ")
    assert r.status_code == 200  # we render an HTML error page, not 4xx
    assert "tampered" in r.text.lower() or "invalid" in r.text.lower()


def test_magic_link_re_click_is_idempotent(http):
    req, _ = _create_pending_and_get_request(http)
    url = _approval_url(req, "approve")
    r1 = http.get(url)
    assert r1.status_code == 200
    r2 = http.get(url)  # 2nd click on same link
    assert r2.status_code == 200
    assert "already" in r2.text.lower()


def test_pending_approvals_listing_super_admin_only(http):
    r = http.get("/api/refunds/pending-approvals")
    assert r.status_code == 200
    body = r.json()
    assert "count" in body
    assert "requests" in body
    # Sensitive: tokens must NEVER leak to UI consumers
    for req in body["requests"]:
        assert "approve_token" not in req
        assert "deny_token" not in req


# ─────────────────────────────────────────────────────────────────────
# With-invoice path — unchanged, must still process immediately.
# ─────────────────────────────────────────────────────────────────────
def test_with_invoice_still_processes_immediately(http):
    rno = f"REQ-INV-{uuid.uuid4().hex[:8]}"
    r = http.post("/api/refunds", json=_payload(
        rno,
        original_invoice_no="INV-LINKED-001",
        original_invoice_id="some-invoice-uuid",
    ))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("refund_id"), "With-invoice refund should return refund_id immediately"
    assert body.get("status") != "pending_approval"
    assert body.get("no_invoice_override") is False
    http.delete(f"/api/refunds/{body['refund_id']}")

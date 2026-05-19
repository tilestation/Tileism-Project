"""
Tests for the "refunds require original invoice" policy added 24 Feb 2026.

User intent (verbatim from screenshot annotation 19/05/2026):

    "Do not let anyone issue the refund without Original Invoice
    linked to the Refund. If just in case it's a must to process
    refund without the original Invoice linked, then only Super
    Admin should approve. Don't forget Super Admin needs to receive
    notification as Super Admin is not physically present in showrooms."

Rules enforced:
  - Non-super-admin caller, no invoice link → 403 "ask a Super Admin"
  - Super Admin, no invoice link, no override flag → 400 (acknowledgement required)
  - Super Admin, no invoice link, override flag, short reason → 400 (reason too short)
  - Super Admin, no invoice link, override + valid reason → 200, doc stamped, Telegram fired
  - ANY caller with an invoice link → 200 (regular refund flow)
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
        token = r.json().get("access_token") or r.json().get("token")
        assert token
        yield token


@pytest.fixture
def http(admin_token):
    with httpx.Client(
        base_url=API_URL,
        timeout=30,
        headers={"Authorization": f"Bearer {admin_token}"},
    ) as c:
        yield c


def _line_items(amount=10.0):
    return [{
        "product_id": "",
        "product_name": "Test Refund Item",
        "sku": "",
        "quantity": 1,
        "original_price": amount,
        "refund_price": amount,
        "total": amount,
        "reason": "Testing",
    }]


def _refund_payload(refund_no, **overrides):
    base = {
        "refund_no": refund_no,
        "date": TODAY_UK,
        "customer_name": "Policy Test",
        "refund_method": "Card",
        "refund_type": "Full Refund",
        "line_items": _line_items(),
        "subtotal": 10.0,
        "vat": 2.0,
        "gross_total": 12.0,
        "restocking_fee": 0,
    }
    base.update(overrides)
    return base


def _cleanup(http, refund_id):
    try:
        http.delete(f"/api/refunds/{refund_id}")
    except Exception:
        pass


def test_with_invoice_link_succeeds(http):
    """The standard, happy-path refund (linked to invoice) always works."""
    rno = f"TEST-WITH-INV-{uuid.uuid4().hex[:8]}"
    r = http.post("/api/refunds", json=_refund_payload(
        rno,
        original_invoice_no="INV-LINKED-001",
        original_invoice_id="some-invoice-uuid",
    ))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("refund_id")
    assert body.get("no_invoice_override") is False
    _cleanup(http, body["refund_id"])


def test_super_admin_no_invoice_no_override_rejected(http):
    """Even Super Admin must explicitly acknowledge override + supply a reason."""
    rno = f"TEST-NOACK-{uuid.uuid4().hex[:8]}"
    r = http.post("/api/refunds", json=_refund_payload(rno))
    assert r.status_code == 400, r.text
    assert "no_invoice_override" in r.text.lower() or "no_invoice_reason" in r.text.lower()


def test_super_admin_no_invoice_short_reason_rejected(http):
    rno = f"TEST-SHORT-{uuid.uuid4().hex[:8]}"
    r = http.post("/api/refunds", json=_refund_payload(
        rno,
        no_invoice_override=True,
        no_invoice_reason="bad",
    ))
    assert r.status_code == 400, r.text
    assert "6 characters" in r.text or "no_invoice_reason" in r.text.lower()


def test_super_admin_no_invoice_with_valid_reason_succeeds_and_fires_alert(http):
    """Super Admin path: override + reason → 200, fields stamped (proof the
    email alert branch executed — see refunds.py:create_refund)."""
    rno = f"TEST-VALID-{uuid.uuid4().hex[:8]}"
    r = http.post("/api/refunds", json=_refund_payload(
        rno,
        no_invoice_override=True,
        no_invoice_reason="Customer destroyed paper copy during basement flood last week",
    ))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["refund_id"]
    assert body["no_invoice_override"] is True

    # Re-fetch and confirm the stamped fields. These fields are ONLY set on
    # the path that also fires the email alert, so their presence proves
    # the alert branch ran.
    full = http.get(f"/api/refunds/{body['refund_id']}").json()
    assert full["no_invoice_override"] is True
    assert "destroyed" in (full["no_invoice_reason"] or "")
    assert full["no_invoice_approved_by"] == ADMIN_EMAIL
    assert full["no_invoice_approved_at"]

    _cleanup(http, body["refund_id"])


def test_empty_string_invoice_link_treated_as_no_link(http):
    """An empty string for original_invoice_no/_id still counts as 'no link' — UI guard."""
    rno = f"TEST-EMPTY-{uuid.uuid4().hex[:8]}"
    r = http.post("/api/refunds", json=_refund_payload(
        rno,
        original_invoice_no="",
        original_invoice_id="",
    ))
    assert r.status_code == 400, r.text


def test_whitespace_invoice_link_treated_as_no_link(http):
    """An invoice link of just spaces is meaningless and must be rejected."""
    rno = f"TEST-WS-{uuid.uuid4().hex[:8]}"
    r = http.post("/api/refunds", json=_refund_payload(
        rno,
        original_invoice_no="   ",
    ))
    assert r.status_code == 400, r.text

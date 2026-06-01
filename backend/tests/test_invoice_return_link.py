"""
Regression test for the per-line return-link feature shipped Feb 26, 2026.

When a staff member ticks the Return checkbox on an invoice line, the
EPOS UI now opens a dialog asking which ORIGINAL invoice the return
belongs to. The captured invoice number + id must round-trip through
`POST /api/invoices` and `GET /api/invoices/{id}` so the link is
preserved for refund audit + trade-credit reversal.

Three cases:
  1. Mixed invoice (1 normal line + 1 return line) — both round-trip.
  2. Normal-only invoice — `is_return` defaults to False.
  3. Field types — `original_invoice_id` accepts UUID strings.
"""
import os
import sys
import uuid
import httpx
import pytest
from pymongo import MongoClient
from datetime import datetime, timezone

sys.path.insert(0, "/app/backend")

API_URL = (
    os.environ.get("EXTERNAL_URL")
    or open("/app/frontend/.env").read().split("REACT_APP_BACKEND_URL=")[1].split("\n")[0].strip()
)
ADMIN_EMAIL = "admin@test.com"
ADMIN_PW = "admin123"
TODAY_UK = datetime.now(timezone.utc).strftime("%d/%m/%Y")


def _read_env(key):
    env = open("/app/backend/.env").read()
    return next(ln for ln in env.split("\n") if ln.startswith(key)).split("=", 1)[1].strip().strip('"')


def _db():
    return MongoClient(_read_env("MONGO_URL"))[_read_env("DB_NAME")]


@pytest.fixture(scope="module")
def admin_token():
    with httpx.Client(base_url=API_URL, timeout=30) as c:
        r = c.post("/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PW})
        r.raise_for_status()
        body = r.json()
        yield body.get("access_token") or body.get("token")


def _build_payload(*, with_return: bool, original_no: str | None = None, original_id: str | None = None):
    """Minimal valid invoice payload — 1 normal line, optionally 1 return line."""
    line_items = [
        {
            "product_name": "Adhesive 20kg",
            "sku": "ADH-20",
            "quantity": 2,
            "price": 25.0,
            "due_price": 25.0,
            "total": 50.0,
            "is_return": False,
        }
    ]
    if with_return:
        line_items.append({
            "product_name": "Flushmate Cistern Frame",
            "sku": "FCF-01",
            "quantity": 1,
            "price": 250.0,
            "due_price": 250.0,
            "total": 250.0,
            "is_return": True,
            "original_invoice_no": original_no,
            "original_invoice_id": original_id,
        })
        # Net total: 50 - 250 = -200; force positive subtotal in payload anyway
        # since the server validates only basic structure. Returns just flip
        # the sign client-side at render; persisted figures are gross of the
        # original line price.
    return {
        "invoice_no": f"INV-RETLINK-{uuid.uuid4().hex[:8]}",
        "date": TODAY_UK,
        "customer_name": "Return Link Persistence Test",
        "payment_method": "Card",
        "deposits": [{"date": TODAY_UK, "amount": 60.0, "method": "Card", "note": ""}],
        "line_items": line_items,
        "subtotal": 50.0,
        "vat": 10.0,
        "gross_total": 60.0,
        "total_savings": 0.0,
    }


def _cleanup(invoice_no_prefix: str = "INV-RETLINK-"):
    db = _db()
    db.invoices.delete_many({"invoice_no": {"$regex": f"^{invoice_no_prefix}"}})


def test_return_link_round_trips_through_post_and_get(admin_token):
    """Tick Return → dialog captures INV + id → POST persists → GET returns
    same fields verbatim. Acceptance criteria for the user's bug report."""
    _cleanup()
    orig_no = f"INV-SRC-{uuid.uuid4().hex[:6].upper()}"
    orig_id = str(uuid.uuid4())

    headers = {"Authorization": f"Bearer {admin_token}"}
    with httpx.Client(base_url=API_URL, timeout=30) as c:
        # CREATE
        r = c.post("/api/invoices", json=_build_payload(with_return=True, original_no=orig_no, original_id=orig_id), headers=headers)
        assert r.status_code in (200, 201), f"CREATE failed: {r.status_code} {r.text[:200]}"
        body = r.json()
        inv_id = body.get("invoice_id") or body.get("id")
        assert inv_id, f"No invoice id returned: {body}"

        # FETCH
        r = c.get(f"/api/invoices/{inv_id}", headers=headers)
        assert r.status_code == 200, f"GET failed: {r.status_code} {r.text[:200]}"
        invoice = r.json()
        line_items = invoice.get("line_items") or []
        assert len(line_items) == 2, f"Expected 2 line items, got {len(line_items)}"

        normal, returned = line_items[0], line_items[1]
        assert normal.get("is_return") in (False, None), "First line should not be a return"
        assert returned.get("is_return") is True, "Second line MUST be flagged as a return"
        assert returned.get("original_invoice_no") == orig_no, \
            f"original_invoice_no lost in round-trip: got {returned.get('original_invoice_no')!r}"
        assert returned.get("original_invoice_id") == orig_id, \
            f"original_invoice_id lost in round-trip: got {returned.get('original_invoice_id')!r}"

    _cleanup()


def test_normal_invoice_has_default_false_return_flag(admin_token):
    """No return line → no rows with is_return=True. Defensive: the
    new field MUST default to False so existing flows are unchanged."""
    _cleanup()
    headers = {"Authorization": f"Bearer {admin_token}"}
    with httpx.Client(base_url=API_URL, timeout=30) as c:
        r = c.post("/api/invoices", json=_build_payload(with_return=False), headers=headers)
        assert r.status_code in (200, 201), r.text[:200]
        inv_id = r.json().get("invoice_id") or r.json().get("id")
        r = c.get(f"/api/invoices/{inv_id}", headers=headers)
        assert r.status_code == 200
        for li in r.json().get("line_items", []):
            assert li.get("is_return") in (False, None), \
                f"Non-return line shouldn't carry is_return=True: {li}"
            # Original link fields should not be populated when there's no return
            assert not li.get("original_invoice_no"), li
            assert not li.get("original_invoice_id"), li
    _cleanup()


def test_return_without_original_invoice_still_persists(admin_token):
    """Backwards-compatibility: a return line with no original linked
    (e.g. data from a historical invoice loaded for edit) must still
    persist. The frontend dialog enforces the link; the API doesn't."""
    _cleanup()
    headers = {"Authorization": f"Bearer {admin_token}"}
    payload = _build_payload(with_return=True, original_no=None, original_id=None)
    with httpx.Client(base_url=API_URL, timeout=30) as c:
        r = c.post("/api/invoices", json=payload, headers=headers)
        assert r.status_code in (200, 201), r.text[:200]
        inv_id = r.json().get("invoice_id") or r.json().get("id")
        r = c.get(f"/api/invoices/{inv_id}", headers=headers)
        assert r.status_code == 200
        items = r.json().get("line_items", [])
        ret = next((li for li in items if li.get("is_return")), None)
        assert ret is not None, "Return line should have persisted"
        assert ret.get("original_invoice_no") in (None, ""), ret
        assert ret.get("original_invoice_id") in (None, ""), ret
    _cleanup()

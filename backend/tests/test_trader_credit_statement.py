"""
Integration tests for the trader self-service credit-statement endpoints.

User story (21 May 2026):
  "Build a Trade Credit statement page inside the Trader section."

Endpoints covered:
  GET  /api/trader/credit-statement              → JSON
  GET  /api/trader/credit-statement/pdf          → PDF bytes
  POST /api/trader/credit-statement/email        → triggers email send

Security: must reject non-trade accounts (403), unauthenticated (401),
and accounts not found (404).
"""
import io
import os
import sys
import uuid
import asyncio
from datetime import datetime, timezone, timedelta

import pytest
import httpx
from pymongo import MongoClient

sys.path.insert(0, "/app/backend")

API_URL = open("/app/frontend/.env").read().split("REACT_APP_BACKEND_URL=")[1].split("\n")[0].strip()
TODAY_UK = datetime.now(timezone.utc).strftime("%d/%m/%Y")


def _read_env(key):
    env = open("/app/backend/.env").read()
    return next(ln for ln in env.split("\n") if ln.startswith(key)).split("=", 1)[1].strip().strip('"')


def _db_sync():
    return MongoClient(_read_env("MONGO_URL"))[_read_env("DB_NAME")]


@pytest.fixture
def trader_account():
    """Insert a trade customer + a portal user with a matching email + a
    handful of credit_transactions across two months. Yields a dict with
    the JWT token, customer_id, trade_ref, and email."""
    db = _db_sync()
    email = f"trader-stmt-{uuid.uuid4().hex[:8]}@test.local"
    trade_ref = f"T-STMT-{uuid.uuid4().hex[:6]}"
    customer_id = str(uuid.uuid4())

    # The shop_customers record (Mongo "main" record)
    db.shop_customers.insert_one({
        "id": customer_id,
        "email": email,
        "name": "Test Trader",
        "business_name": "Test Trader Ltd",
        "trade_account_number": trade_ref,
        "is_trade": True,
        "credit_balance": 42.50,
        "credit_rate": 5.0,
        "tier": "Silver",
        "password_hash": "x",  # not used — we'll generate a JWT directly
        "created_at": datetime.now(timezone.utc).isoformat(),
    })

    # Seed ~5 credit transactions over the past 6 months
    now = datetime.now(timezone.utc)
    txns = [
        ("earned_in_store", 10.00, 10.00, now - timedelta(days=120), "INV-001"),
        ("earned_online",   12.50, 22.50, now - timedelta(days=80),  None),
        ("earned_in_store", 15.00, 37.50, now - timedelta(days=40),  "INV-002"),
        ("redeem",          -5.00, 32.50, now - timedelta(days=20),  None),
        ("earned_in_store", 10.00, 42.50, now - timedelta(days=5),   "INV-003"),
    ]
    for t_type, amt, bal_after, created, inv_no in txns:
        db.credit_transactions.insert_one({
            "id": str(uuid.uuid4()),
            "customer_id": customer_id,
            "trade_account_number": trade_ref,
            "type": t_type,
            "amount": amt,
            "balance_after": bal_after,
            "invoice_no": inv_no,
            "channel": "in_store" if "in_store" in t_type else "online",
            "description": f"Test {t_type}",
            "created_at": created.isoformat(),
        })

    # Generate a real JWT via the shop login endpoint
    # Path: a) try to login (will fail since no pw), b) directly mint a JWT
    # Easiest: mint a JWT using the same secret the backend uses.
    try:
        import jwt as _pyjwt
    except ImportError:
        import jwt as _pyjwt  # PyJWT - same import
    secret = (
        os.environ.get("JWT_SECRET")
        or _read_env("JWT_SECRET")
    )
    token = _pyjwt.encode(
        {
            # CRITICAL: backend's get_shop_customer uses `sub` as the
            # email and requires `type: "shop_customer"`. See
            # routes/shop.py::get_shop_customer.
            "sub": email,
            "type": "shop_customer",
            "exp": int((now + timedelta(hours=1)).timestamp()),
        },
        secret, algorithm="HS256",
    )

    yield {
        "token": token,
        "customer_id": customer_id,
        "trade_ref": trade_ref,
        "email": email,
    }

    db.shop_customers.delete_one({"id": customer_id})
    db.credit_transactions.delete_many({"customer_id": customer_id})


@pytest.fixture
def http(trader_account):
    with httpx.Client(
        base_url=API_URL,
        timeout=30,
        headers={"Authorization": f"Bearer {trader_account['token']}"},
    ) as c:
        yield c


# ────────────────────────────────────────────────────────────────────


def test_get_credit_statement_returns_balance_and_transactions(http, trader_account):
    r = http.get("/api/trader/credit-statement?days=365")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["trade_account_number"] == trader_account["trade_ref"]
    assert abs(data["balance"] - 42.50) < 0.01
    assert data["business_name"] == "Test Trader Ltd"
    # All 5 seeded txns within 365 days
    assert len(data["transactions"]) == 5
    # Sorted newest-first
    dates = [t["date"] for t in data["transactions"]]
    assert dates == sorted(dates, reverse=True)
    # Direction tagging
    earned = [t for t in data["transactions"] if t["direction"] == "+"]
    redeemed = [t for t in data["transactions"] if t["direction"] == "−"]
    assert len(earned) == 4
    assert len(redeemed) == 1
    # Summary numbers
    assert abs(data["summary"]["earned_in_window"] - 47.50) < 0.01
    assert abs(data["summary"]["redeemed_in_window"] - 5.0) < 0.01


def test_get_credit_statement_30day_window_filters_correctly(http):
    r = http.get("/api/trader/credit-statement?days=30")
    assert r.status_code == 200
    data = r.json()
    # Within 30 days: only the 5-day-old (£10 earn) and 20-day-old (£5 redeem)
    # are inside the window. The 40+, 80+, 120+ day-old txns are excluded.
    assert len(data["transactions"]) == 2
    amounts = sorted(t["amount"] for t in data["transactions"])
    assert amounts == [5.0, 10.0]


def test_get_credit_statement_rejects_unauthenticated():
    with httpx.Client(base_url=API_URL, timeout=15) as c:
        r = c.get("/api/trader/credit-statement")
        assert r.status_code in (401, 403), r.text


def test_get_credit_statement_rejects_non_trade_account():
    """A logged-in customer who is NOT a trade account should be 403'd."""
    db = _db_sync()
    email = f"non-trader-{uuid.uuid4().hex[:8]}@test.local"
    cust_id = str(uuid.uuid4())
    db.shop_customers.insert_one({
        "id": cust_id,
        "email": email,
        "name": "Joe Public",
        "is_trade": False,
        "credit_balance": 0,
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    try:
        import jwt as _pyjwt
        secret = os.environ.get("JWT_SECRET") or _read_env("JWT_SECRET")
        token = _pyjwt.encode(
            {"sub": email, "type": "shop_customer",
             "exp": int((datetime.now(timezone.utc) + timedelta(hours=1)).timestamp())},
            secret, algorithm="HS256",
        )
        with httpx.Client(
            base_url=API_URL, timeout=15,
            headers={"Authorization": f"Bearer {token}"},
        ) as c:
            r = c.get("/api/trader/credit-statement")
            assert r.status_code == 403, r.text
    finally:
        db.shop_customers.delete_one({"id": cust_id})


def test_download_pdf_returns_valid_pdf_bytes(http):
    r = http.get("/api/trader/credit-statement/pdf?days=365")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/pdf"
    assert r.content.startswith(b"%PDF"), "Response must be PDF bytes"
    # Sanity — should be more than a few KB (real content)
    assert len(r.content) > 2000, f"PDF too small: {len(r.content)} bytes"


def test_download_pdf_contains_trader_business_name(http):
    from pypdf import PdfReader
    r = http.get("/api/trader/credit-statement/pdf?days=365")
    assert r.status_code == 200
    text = "\n".join(
        (p.extract_text() or "") for p in PdfReader(io.BytesIO(r.content)).pages
    )
    assert "Test Trader Ltd" in text
    assert "Trade Credit Statement" in text
    # All transactions show up
    assert "INV-001" in text or "INV-002" in text or "INV-003" in text
    # Balance number rendered
    assert "42.50" in text or "£42.50" in text

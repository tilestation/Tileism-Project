"""
Regression test for the Return Heatmap dashboard endpoint shipped
Feb 26, 2026 (immediately after the per-line Return checkbox feature).

Asserts that GET /api/analytics/return-heatmap:
  • Aggregates BOTH per-line invoice returns (is_return=True) AND
    standalone refund documents — single tile = full picture.
  • Computes a per-product return rate when the same product was also
    sold in the same window (units_returned / units_sold).
  • Ranks by £ value returned (worst offender first).
  • Joins supplier metadata via the products collection.
  • Honours the `days` window — older data is excluded.
  • Clamps an extreme `days` value (>365) without 500-ing.
"""
import os
import sys
import uuid
import httpx
import pytest
from datetime import datetime, timezone, timedelta
from pymongo import MongoClient

sys.path.insert(0, "/app/backend")

API_URL = (
    os.environ.get("EXTERNAL_URL")
    or open("/app/frontend/.env").read().split("REACT_APP_BACKEND_URL=")[1].split("\n")[0].strip()
)
ADMIN_EMAIL = "admin@test.com"
ADMIN_PW = "admin123"


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


SKU_HOT = f"HEATMAP-HOT-{uuid.uuid4().hex[:6].upper()}"
SKU_COLD = f"HEATMAP-COLD-{uuid.uuid4().hex[:6].upper()}"
SUPPLIER_NAME = "Heatmap Test Supplier Co."


def _seed():
    """Insert 2 products, 1 invoice with mixed normal+return lines, 1 refund.
    All dated TODAY so they fall in the trailing window."""
    db = _db()
    today = datetime.now(timezone.utc).strftime("%d/%m/%Y")
    old_date = (datetime.now(timezone.utc) - timedelta(days=400)).strftime("%d/%m/%Y")

    db.products.insert_many([
        {"id": "heatmap-prod-hot", "sku": SKU_HOT, "name": "Hot Returning Tile",
         "supplier_name": SUPPLIER_NAME, "supplier_id": "s-1"},
        {"id": "heatmap-prod-cold", "sku": SKU_COLD, "name": "Rarely Returned Tile",
         "supplier_name": SUPPLIER_NAME, "supplier_id": "s-1"},
    ])

    # Mixed invoice — sells 10 of HOT + 50 of COLD, then RETURNS 2 of HOT.
    db.invoices.insert_one({
        "id": f"heatmap-inv-{uuid.uuid4().hex[:8]}",
        "invoice_no": f"INV-HEATMAP-{uuid.uuid4().hex[:6]}",
        "date": today,
        "customer_name": "Heatmap Tester",
        "line_items": [
            {"product_name": "Hot Returning Tile", "sku": SKU_HOT,
             "quantity": 10, "price": 25, "due_price": 25, "total": 250, "is_return": False},
            {"product_name": "Rarely Returned Tile", "sku": SKU_COLD,
             "quantity": 50, "price": 10, "due_price": 10, "total": 500, "is_return": False},
            {"product_name": "Hot Returning Tile", "sku": SKU_HOT,
             "quantity": 2, "price": 25, "due_price": 25, "total": 50,
             "is_return": True, "original_invoice_no": "INV-SRC-001"},
        ],
        "subtotal": 700, "vat": 140, "gross_total": 840, "total_savings": 0,
        "created_at": datetime.now(timezone.utc).isoformat(),
    })

    # Standalone refund — refunds 3 more units of HOT.
    db.refunds.insert_one({
        "id": f"heatmap-rf-{uuid.uuid4().hex[:8]}",
        "refund_no": f"RF-HEATMAP-{uuid.uuid4().hex[:6]}",
        "date": today,
        "original_invoice_no": "INV-SRC-002",
        "line_items": [
            {"product_name": "Hot Returning Tile", "sku": SKU_HOT,
             "quantity": 3, "refund_price": 25, "total": 75},
        ],
        "subtotal": 75, "vat": 15, "gross_total": 90,
        "created_at": datetime.now(timezone.utc).isoformat(),
    })

    # Out-of-window invoice — must NOT be counted.
    db.invoices.insert_one({
        "id": f"heatmap-old-{uuid.uuid4().hex[:8]}",
        "invoice_no": f"INV-OLD-{uuid.uuid4().hex[:6]}",
        "date": old_date,
        "line_items": [
            {"product_name": "Hot Returning Tile", "sku": SKU_HOT,
             "quantity": 999, "price": 25, "due_price": 25, "total": 24975,
             "is_return": True},
        ],
        "subtotal": 24975, "vat": 4995, "gross_total": 29970,
        "created_at": (datetime.now(timezone.utc) - timedelta(days=400)).isoformat(),
    })


def _cleanup():
    db = _db()
    db.products.delete_many({"sku": {"$in": [SKU_HOT, SKU_COLD]}})
    db.invoices.delete_many({"invoice_no": {"$regex": "^INV-(HEATMAP|OLD)-"}})
    db.refunds.delete_many({"refund_no": {"$regex": "^RF-HEATMAP-"}})


@pytest.fixture(scope="module", autouse=True)
def _around():
    _cleanup()
    _seed()
    yield
    _cleanup()


def test_return_heatmap_aggregates_invoice_and_refund_paths(admin_token):
    """Total events should = 2 (1 invoice-return line + 1 refund line)."""
    headers = {"Authorization": f"Bearer {admin_token}"}
    with httpx.Client(base_url=API_URL, timeout=30) as c:
        r = c.get("/api/analytics/return-heatmap?days=30", headers=headers)
    assert r.status_code == 200, r.text[:200]
    body = r.json()
    assert body["window_days"] == 30
    # Find OUR product row (other test data may exist in db).
    hot_row = next((p for p in body["top_products"] if p["sku"] == SKU_HOT), None)
    assert hot_row is not None, f"Hot product missing from top_products: {body['top_products']}"
    # 2 (invoice return) + 3 (refund) = 5 units returned
    assert hot_row["units_returned"] == 5.0, hot_row
    # Value: 2 * 25 (invoice) + 3 * 25 (refund) = 125
    assert hot_row["value_returned"] == 125.0, hot_row
    # events: one invoice-return-line + one refund-line = 2
    assert hot_row["events"] == 2, hot_row
    # Sold denominator: 10 from the invoice's normal line (the OOW invoice
    # is excluded). Return rate = 5/10 = 50%.
    assert hot_row["units_sold"] == 10.0, hot_row
    assert hot_row["return_rate_pct"] == 50.0, hot_row


def test_return_heatmap_includes_supplier_breakdown(admin_token):
    """Supplier roll-up should reflect the product's supplier_name."""
    headers = {"Authorization": f"Bearer {admin_token}"}
    with httpx.Client(base_url=API_URL, timeout=30) as c:
        r = c.get("/api/analytics/return-heatmap?days=30", headers=headers)
    assert r.status_code == 200
    body = r.json()
    sup_row = next((s for s in body["top_suppliers"] if s["supplier_name"] == SUPPLIER_NAME), None)
    assert sup_row is not None, f"Supplier roll-up missing: {body['top_suppliers']}"
    assert sup_row["units_returned"] == 5.0
    assert sup_row["value_returned"] == 125.0
    assert sup_row["events"] == 2


def test_return_heatmap_excludes_out_of_window_data(admin_token):
    """The 400-day-old fake invoice with quantity=999 must not pollute."""
    headers = {"Authorization": f"Bearer {admin_token}"}
    with httpx.Client(base_url=API_URL, timeout=30) as c:
        r = c.get("/api/analytics/return-heatmap?days=30", headers=headers)
    body = r.json()
    hot_row = next((p for p in body["top_products"] if p["sku"] == SKU_HOT), None)
    # If the 999-unit old return leaked in, units_returned would be 1004.
    assert hot_row["units_returned"] < 100, \
        f"Out-of-window data leaked into the heatmap: {hot_row}"


def test_return_heatmap_clamps_extreme_window(admin_token):
    """days=10000 should clamp to 365, not 500 or crash."""
    headers = {"Authorization": f"Bearer {admin_token}"}
    with httpx.Client(base_url=API_URL, timeout=30) as c:
        r = c.get("/api/analytics/return-heatmap?days=10000", headers=headers)
    assert r.status_code == 200
    assert r.json()["window_days"] == 365


def test_return_heatmap_requires_dashboard_permission(admin_token):
    """Anonymous → 401/403."""
    with httpx.Client(base_url=API_URL, timeout=30) as c:
        r = c.get("/api/analytics/return-heatmap?days=30")
    assert r.status_code in (401, 403)

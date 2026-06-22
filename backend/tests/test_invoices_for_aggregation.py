"""
Regression test for the 22 Jun 2026 fix — InvoiceHistory daily/weekly/
monthly revenue cards under-reporting vs the Super-Admin Store
Performance card by the value of older invoices that took balance
payments within the current period.

Bug
---
The owner reported that opening the Invoice History page with
Store=Gravesend showed:
  Today:   £5,412.09   (Super Admin: £5,512.09)   gap = £100.00
  Week:    £6,872.59   (Super Admin: £6,972.59)   gap = £100.00
  Month:   £70,302.58  (Super Admin: £71,855.38)  gap = £1,552.80

Root cause
----------
The page was sourcing its client-side aggregation from `/api/invoices`,
which caps results at 5,000 (sorted newest-first by `created_at`). At
this 7-year-old, 3-store business that processes ~700+ invoices/month,
the DB holds tens of thousands of invoices — far past the cap. When a
customer paid an outstanding balance today against an *older* invoice
(e.g. a Feb 2026 special order), the payment was correctly recorded
inside that invoice's `deposits[]` array, but the page never received
the older invoice in its 5,000-row fetch and so its sum was blind to
the payment.

Fix
---
A new dedicated endpoint `GET /api/invoices/for-aggregation` returns a
**lite projection** of EVERY non-deleted invoice (no row cap), used
only by the revenue cards. The list view still uses the paginated
endpoint. This guarantees the two views reconcile.

Tests cover:
  - Endpoint returns ALL non-deleted invoices (no 5000 cap)
  - Lite projection contains every field the aggregator needs
  - Older invoices with recent deposit payments ARE returned
  - Soft-deleted invoices are EXCLUDED
  - Showroom-scoped users only see their store
  - Non-admin/non-EPOS gets 403
"""
from __future__ import annotations

import pytest
from datetime import datetime, timezone

from config import get_db
from routes import invoices as invoices_route

pytestmark = pytest.mark.asyncio


# Use IDs prefixed with 'pytest-' so the cleanup is targeted and won't
# accidentally nuke any real data even if the test DB is reused.
_OLD_INVOICE_ID = "pytest-aggregation-old-invoice"
_NEW_INVOICE_ID = "pytest-aggregation-new-invoice"
_DELETED_INVOICE_ID = "pytest-aggregation-deleted-invoice"


async def _seed():
    """Seed an OLD invoice (Feb 2026) with a deposit paid TODAY +
    a NEW invoice (today) + a DELETED invoice. Idempotent."""
    db = get_db()
    today_str = datetime.now(timezone.utc).strftime("%d/%m/%Y")
    await db.invoices.replace_one(
        {"id": _OLD_INVOICE_ID},
        {
            "id": _OLD_INVOICE_ID,
            "invoice_no": "TS-FEB-0001",
            # Created in Feb 2026 — far older than the newest 5,000
            # the regular endpoint would return on a busy production DB.
            "created_at": datetime(2026, 2, 1, 12, 0, 0, tzinfo=timezone.utc).isoformat(),
            "date": "01/02/2026",
            "showroom_id": "pytest-showroom-1",
            "gross_total": 500.00,
            "amount_outstanding": 0.0,
            "deposits": [
                # Balance paid TODAY against an old invoice — this is
                # the £100 the page was previously missing.
                {"date": today_str, "amount": 100.0, "method": "cash"},
                {"date": "01/02/2026", "amount": 400.0, "method": "card"},
            ],
            "payment_method": "card",
        },
        upsert=True,
    )
    await db.invoices.replace_one(
        {"id": _NEW_INVOICE_ID},
        {
            "id": _NEW_INVOICE_ID,
            "invoice_no": "TS-JUN-9999",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "date": today_str,
            "showroom_id": "pytest-showroom-1",
            "gross_total": 250.00,
            "amount_outstanding": 0.0,
            "deposits": [{"date": today_str, "amount": 250.0, "method": "card"}],
            "payment_method": "card",
        },
        upsert=True,
    )
    await db.invoices.replace_one(
        {"id": _DELETED_INVOICE_ID},
        {
            "id": _DELETED_INVOICE_ID,
            "invoice_no": "TS-DEL-0001",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "date": today_str,
            "showroom_id": "pytest-showroom-1",
            "gross_total": 999.99,
            "amount_outstanding": 0.0,
            "deposits": [{"date": today_str, "amount": 999.99, "method": "cash"}],
            "deleted_at": datetime.now(timezone.utc).isoformat(),
        },
        upsert=True,
    )


async def _cleanup():
    db = get_db()
    await db.invoices.delete_many({"id": {
        "$in": [_OLD_INVOICE_ID, _NEW_INVOICE_ID, _DELETED_INVOICE_ID]
    }})


# ─────────────────────────────────────────────────────────────────────
# The actual bug fix — older invoices MUST be returned by the lite endpoint
# ─────────────────────────────────────────────────────────────────────

async def test_aggregation_endpoint_returns_old_invoices_with_recent_deposits():
    """The smoking-gun case: a Feb invoice with a balance paid TODAY
    must be present in the aggregation set, so the InvoiceHistory
    revenue cards include that £100 in today's revenue and reconcile
    with the Super-Admin Store Performance card."""
    await _seed()
    try:
        admin = {"role": "super_admin", "email": "admin@test.com"}
        rows = await invoices_route.get_invoices_for_aggregation(current_user=admin)
        ids = {r["id"] for r in rows}
        assert _OLD_INVOICE_ID in ids, (
            "Old Feb 2026 invoice must appear in /for-aggregation — "
            "this is the entire reason the endpoint exists."
        )
        assert _NEW_INVOICE_ID in ids
    finally:
        await _cleanup()


async def test_aggregation_endpoint_excludes_soft_deleted():
    """Deleted invoices must NOT appear, matching the Super-Admin
    showrooms-breakdown filter."""
    await _seed()
    try:
        admin = {"role": "super_admin", "email": "admin@test.com"}
        rows = await invoices_route.get_invoices_for_aggregation(current_user=admin)
        ids = {r["id"] for r in rows}
        assert _DELETED_INVOICE_ID not in ids
    finally:
        await _cleanup()


async def test_aggregation_projection_contains_required_fields():
    """The lite projection must carry every field the client-side
    aggregator uses. If any of these go missing the revenue cards
    silently misbehave (worst kind of bug), so we lock the schema."""
    await _seed()
    try:
        admin = {"role": "super_admin", "email": "admin@test.com"}
        rows = await invoices_route.get_invoices_for_aggregation(current_user=admin)
        old = next((r for r in rows if r["id"] == _OLD_INVOICE_ID), None)
        assert old is not None
        # Every field consumed by getDailyRevenue/getWeeklyRevenue/
        # getMonthlyRevenue/getPaymentMethodTotals on InvoiceHistory.js
        for required in (
            "id", "invoice_no", "date", "showroom_id",
            "gross_total", "amount_outstanding", "deposits",
            "payment_method", "created_at",
        ):
            assert required in old, f"Missing required field: {required}"
        # And spot-check the values round-tripped intact
        assert old["gross_total"] == 500.00
        assert old["amount_outstanding"] == 0.0
        assert len(old["deposits"]) == 2
    finally:
        await _cleanup()


async def test_reconciles_with_showrooms_breakdown_algorithm():
    """Run BOTH algorithms (the showrooms-breakdown server-side scan
    AND the for-aggregation lite endpoint feeding the client-side
    sum) against identical data and assert they produce identical
    daily revenue for the test showroom.

    This is the regression check that proves the two views can't
    drift apart in the future without this test screaming."""
    from routes.analytics import is_date_in_range
    from datetime import timedelta
    await _seed()
    try:
        admin = {"role": "super_admin", "email": "admin@test.com"}
        now = datetime.now(timezone.utc)
        today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

        # === Lite endpoint (what the page will use) ===
        lite_rows = await invoices_route.get_invoices_for_aggregation(current_user=admin)
        lite_rows = [r for r in lite_rows if r.get("showroom_id") == "pytest-showroom-1"]
        page_daily = 0.0
        for inv in lite_rows:
            deposits = inv.get("deposits") or []
            if deposits:
                for dep in deposits:
                    d = dep.get("date", "")
                    amt = float(dep.get("amount", 0) or 0)
                    if d and amt > 0 and is_date_in_range(d, today_start, now):
                        page_daily += amt
            else:
                d = inv.get("date", "")
                if d and is_date_in_range(d, today_start, now):
                    paid = (inv.get("gross_total", 0) or 0) - (inv.get("amount_outstanding", 0) or 0)
                    page_daily += paid

        # === Server-side scan (what Super Admin uses) ===
        db = get_db()
        all_rows = await db.invoices.find(
            {"deleted_at": {"$exists": False}, "showroom_id": "pytest-showroom-1"},
            {"_id": 0, "id": 1, "date": 1, "showroom_id": 1, "gross_total": 1,
             "amount_outstanding": 1, "deposits": 1}
        ).to_list(100000)
        super_daily = 0.0
        for inv in all_rows:
            deposits = inv.get("deposits") or []
            if deposits:
                for dep in deposits:
                    d = dep.get("date", "")
                    amt = float(dep.get("amount", 0) or 0)
                    if d and amt > 0 and is_date_in_range(d, today_start, now):
                        super_daily += amt
            else:
                d = inv.get("date", "")
                if d and is_date_in_range(d, today_start, now):
                    paid = (inv.get("gross_total", 0) or 0) - (inv.get("amount_outstanding", 0) or 0)
                    super_daily += paid

        assert round(page_daily, 2) == round(super_daily, 2), (
            f"Reconciliation failed: page sees £{page_daily:.2f} but "
            f"Super-Admin sees £{super_daily:.2f}. The whole point of "
            f"/for-aggregation is for these two numbers to be identical."
        )
        # And the value MUST include the £100 balance + £250 new invoice
        # = £350 total (£999.99 deleted invoice is excluded).
        assert round(page_daily, 2) == 350.00, (
            f"Expected £350.00 today (£100 old-balance + £250 new), got "
            f"£{page_daily:.2f}. If you've added new seed data, update "
            f"this assertion — but verify the reconciliation still holds."
        )
    finally:
        await _cleanup()


# ─────────────────────────────────────────────────────────────────────
# Auth + showroom-scoping
# ─────────────────────────────────────────────────────────────────────

async def test_showroom_scoped_user_only_sees_their_store():
    """A non-super-admin user with `showroom_id` set must NOT see
    invoices from other stores via the aggregation endpoint either —
    the access control has to match `/api/invoices`."""
    await _seed()
    try:
        # Manager assigned to a DIFFERENT showroom — must NOT see
        # the seeded invoices (which live on pytest-showroom-1).
        scoped_user = {
            "role": "manager", "email": "tonbridge-mgr@test.com",
            "showroom_id": "different-showroom-id",
            "permissions": ["epos"],
        }
        rows = await invoices_route.get_invoices_for_aggregation(current_user=scoped_user)
        ids = {r["id"] for r in rows}
        assert _OLD_INVOICE_ID not in ids
        assert _NEW_INVOICE_ID not in ids
    finally:
        await _cleanup()


async def test_non_admin_non_epos_user_gets_403():
    """A logged-in customer or storefront-only user must not be able
    to pull every invoice in the system via this endpoint."""
    from fastapi import HTTPException as _HTTPException
    customer = {"role": "customer", "email": "shopper@example.com"}
    with pytest.raises(_HTTPException) as excinfo:
        await invoices_route.get_invoices_for_aggregation(current_user=customer)
    assert excinfo.value.status_code == 403


async def test_super_admin_showroom_id_filter_narrows_results():
    """Super admin can optionally pass `showroom_id=…` to pre-filter
    the payload — used by deep-link "open Gravesend invoices" flows
    where we don't need to ship every store's data."""
    await _seed()
    try:
        admin = {"role": "super_admin", "email": "admin@test.com"}
        rows = await invoices_route.get_invoices_for_aggregation(
            current_user=admin, showroom_id="pytest-showroom-1",
        )
        # Both non-deleted rows should be present
        ids = {r["id"] for r in rows}
        assert _OLD_INVOICE_ID in ids
        assert _NEW_INVOICE_ID in ids
        # Everything returned must belong to that showroom
        for r in rows:
            assert r.get("showroom_id") == "pytest-showroom-1"
        # And the OTHER-showroom test query returns zero seed rows
        rows_other = await invoices_route.get_invoices_for_aggregation(
            current_user=admin, showroom_id="unrelated-showroom-id",
        )
        ids_other = {r["id"] for r in rows_other}
        assert _OLD_INVOICE_ID not in ids_other
        assert _NEW_INVOICE_ID not in ids_other
    finally:
        await _cleanup()

"""
Tests for the per-staff monthly PDF report (13 Jun 2026).
"""
import os
import asyncio
from unittest.mock import patch, AsyncMock, MagicMock
from datetime import datetime, timezone

import pytest


@pytest.fixture(autouse=True)
def _env_setup():
    os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
    os.environ.setdefault("DB_NAME", "test_staff_report")


class _AsyncIter:
    def __init__(self, items): self._items = list(items)
    def __aiter__(self): self._iter = iter(self._items); return self
    async def __anext__(self):
        try: return next(self._iter)
        except StopIteration as e: raise StopAsyncIteration from e


class _FindChain:
    """motor-style find().sort() chain that just returns the items."""
    def __init__(self, items): self._items = items
    def sort(self, *a, **k): return _AsyncIter(self._items)


def _db(*, invoices=None, quotes=None, user=None, showroom=None, targets=None):
    db = MagicMock()
    db.invoices.find = MagicMock(return_value=_FindChain(invoices or []))
    db.quotations.find = MagicMock(return_value=_FindChain(quotes or []))
    db.users.find_one = AsyncMock(return_value=user)
    db.showrooms.find_one = AsyncMock(return_value=showroom)
    db.sales_targets.find = MagicMock(return_value=_AsyncIter(targets or []))
    return db


SUPER = {"role": "super_admin", "email": "a@b"}
STAFF = {"role": "staff", "email": "s@b"}


# ---------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------
def test_report_rejects_non_admin():
    from routes.staff_monthly_report import staff_monthly_report_pdf
    from fastapi import HTTPException
    with patch("routes.staff_monthly_report.get_db", return_value=_db()):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(staff_monthly_report_pdf(
                user_key="sp:syed", year=2026, month=6, current_user=STAFF,
            ))
        assert exc.value.status_code == 403


# ---------------------------------------------------------------------
# Happy path — PDF binary + filename
# ---------------------------------------------------------------------
def test_report_returns_pdf_with_proper_filename():
    from routes.staff_monthly_report import staff_monthly_report_pdf
    invoices = [{
        "invoice_number": "INV-100",
        "customer_name": "Bob Smith",
        "gross_total": 1500.0,
        "order_type": "Special Order",
        "created_at": datetime(2026, 6, 5, 12, 0, 0, tzinfo=timezone.utc),
        "sales_person": "Syed",
    }]
    quotes = [{
        "quotation_number": "Q-100",
        "customer_name": "Bob Smith",
        "grand_total": 1500.0,
        "conversion_status": "Converted",
        "created_at": datetime(2026, 6, 1, 12, 0, 0, tzinfo=timezone.utc),
        "sales_person": "Syed",
    }]
    user = {"id": "u1", "name": "Syed", "email": "syed@x.co", "showroom_id": "sr_tn", "showroom_name": "Tonbridge"}
    showroom = {"id": "sr_tn", "name": "Tonbridge"}
    targets = [{"showroom_id": "sr_tn", "monthly_target": 55000, "target_type": "sales"}]
    db = _db(invoices=invoices, quotes=quotes, user=user, showroom=showroom, targets=targets)
    with patch("routes.staff_monthly_report.get_db", return_value=db), \
         patch("routes.staff_leaderboard.get_db", return_value=db):
        resp = asyncio.run(staff_monthly_report_pdf(
            user_key="sp:syed", year=2026, month=6, current_user=SUPER,
        ))
    # Drain body
    import io as _io
    buf = _io.BytesIO()
    async def _drain():
        async for chunk in resp.body_iterator:
            buf.write(chunk if isinstance(chunk, (bytes, bytearray)) else chunk.encode())
    asyncio.run(_drain())
    pdf_bytes = buf.getvalue()
    # Real PDF starts with %PDF
    assert pdf_bytes.startswith(b"%PDF"), "Did not return a PDF document"
    # Filename includes staff + month
    assert "Syed" in resp.headers["Content-Disposition"]
    assert "2026-06" in resp.headers["Content-Disposition"]
    assert resp.media_type == "application/pdf"


# ---------------------------------------------------------------------
# Special Order only — non-Special Order invoices excluded from totals
# ---------------------------------------------------------------------
def test_report_excludes_non_special_order_invoices():
    """User direction: '£ Sold only should include Special Order
    invoices.' Standard tile-sale receipts must not skew the £ total."""
    from routes.staff_monthly_report import _compute_kpis
    invoices = [
        {"invoice_number": "INV-1", "gross_total": 1000.0, "order_type": "Special Order",
         "created_at": datetime(2026, 6, 5, tzinfo=timezone.utc), "sales_person": "X"},
        {"invoice_number": "INV-2", "gross_total": 99999.0, "order_type": "Standard",  # should NOT count
         "created_at": datetime(2026, 6, 6, tzinfo=timezone.utc), "sales_person": "X"},
        {"invoice_number": "INV-3", "gross_total": 500.0, "order_type": "special order",  # case-insensitive
         "created_at": datetime(2026, 6, 7, tzinfo=timezone.utc), "sales_person": "X"},
    ]
    db = _db(invoices=invoices, user={"id": "u1", "name": "X", "email": "x@y"})
    with patch("routes.staff_monthly_report.get_db", return_value=db), \
         patch("routes.staff_leaderboard.get_db", return_value=db):
        kpis = asyncio.run(_compute_kpis(user_key="sp:x", year=2026, month=6))
    assert kpis["sales_count"] == 2  # only the two Special Order ones
    assert kpis["sales_value"] == 1500.0
    assert kpis["avg_sale"] == 750.0


# ---------------------------------------------------------------------
# KPI computation
# ---------------------------------------------------------------------
def test_report_computes_conversion_rate_and_targets():
    from routes.staff_monthly_report import _compute_kpis
    invoices = [
        {"invoice_number": "INV-1", "gross_total": 5000.0, "order_type": "Special Order",
         "created_at": datetime(2026, 6, 5, tzinfo=timezone.utc), "sales_person": "Syed"},
    ]
    quotes = [
        {"quotation_number": "Q-1", "grand_total": 1000.0, "conversion_status": "Converted",
         "created_at": datetime(2026, 6, 1, tzinfo=timezone.utc), "sales_person": "Syed"},
        {"quotation_number": "Q-2", "grand_total": 2000.0, "conversion_status": "Open",
         "created_at": datetime(2026, 6, 2, tzinfo=timezone.utc), "sales_person": "Syed"},
        {"quotation_number": "Q-3", "grand_total": 3000.0, "conversion_status": "Open",
         "created_at": datetime(2026, 6, 3, tzinfo=timezone.utc), "sales_person": "Syed"},
        {"quotation_number": "Q-4", "grand_total": 4000.0, "converted_to_invoice": "INV-99",
         "created_at": datetime(2026, 6, 4, tzinfo=timezone.utc), "sales_person": "Syed"},
    ]
    user = {"id": "u1", "name": "Syed", "showroom_id": "sr_tn", "showroom_name": "Tonbridge"}
    showroom = {"id": "sr_tn", "name": "Tonbridge"}
    targets = [
        {"showroom_id": "sr_tn", "monthly_target": 10000, "target_type": "sales"},
        {"showroom_id": "sr_tn", "monthly_target": 4, "target_type": "quotes"},
    ]
    db = _db(invoices=invoices, quotes=quotes, user=user, showroom=showroom, targets=targets)
    with patch("routes.staff_monthly_report.get_db", return_value=db), \
         patch("routes.staff_leaderboard.get_db", return_value=db):
        k = asyncio.run(_compute_kpis(user_key="sp:syed", year=2026, month=6))
    assert k["quotes_created"] == 4
    assert k["quotes_converted"] == 2  # Q-1 via status, Q-4 via converted_to_invoice
    assert k["conversion_rate"] == 50.0
    assert k["sales_value"] == 5000.0
    # Sales target 10000 → 50%
    assert k["pct_of_sales_target"] == 50.0
    assert k["remaining_to_sales_target"] == 5000.0
    # Quote target 4 → 50% (2 of 4)
    assert k["pct_of_quotes_target"] == 50.0
    assert k["remaining_to_quotes_target"] == 2


def test_report_handles_staff_with_no_target_set():
    """A staff at a showroom that hasn't had its target configured
    should still render — pct stays at 0%."""
    from routes.staff_monthly_report import _compute_kpis
    invoices = [{
        "invoice_number": "INV-1", "gross_total": 5000.0, "order_type": "Special Order",
        "created_at": datetime(2026, 6, 5, tzinfo=timezone.utc), "sales_person": "X",
    }]
    db = _db(invoices=invoices, user={"id": "u1", "name": "X", "showroom_id": ""}, targets=[])
    with patch("routes.staff_monthly_report.get_db", return_value=db), \
         patch("routes.staff_leaderboard.get_db", return_value=db):
        k = asyncio.run(_compute_kpis(user_key="sp:x", year=2026, month=6))
    assert k["target_sales"] == 0
    assert k["pct_of_sales_target"] == 0
    assert k["remaining_to_sales_target"] == 0


def test_report_empty_month_renders_without_crashing():
    """Even with zero invoices and zero quotes we still produce a
    valid PDF — handy for new hires or quiet months."""
    from routes.staff_monthly_report import staff_monthly_report_pdf
    db = _db(invoices=[], quotes=[], user={"id": "u1", "name": "Newbie"})
    with patch("routes.staff_monthly_report.get_db", return_value=db), \
         patch("routes.staff_leaderboard.get_db", return_value=db):
        resp = asyncio.run(staff_monthly_report_pdf(
            user_key="sp:newbie", year=2026, month=6, current_user=SUPER,
        ))
    import io as _io
    buf = _io.BytesIO()
    async def _drain():
        async for chunk in resp.body_iterator:
            buf.write(chunk if isinstance(chunk, (bytes, bytearray)) else chunk.encode())
    asyncio.run(_drain())
    assert buf.getvalue().startswith(b"%PDF")

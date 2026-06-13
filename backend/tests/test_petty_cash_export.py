"""
Tests for the petty cash monthly export + email job
(13 Jun 2026).
"""
import os
import asyncio
import base64
import io
import zipfile
from datetime import datetime, timezone
from unittest.mock import patch, AsyncMock, MagicMock

import pytest


@pytest.fixture(autouse=True)
def _env_setup():
    os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
    os.environ.setdefault("DB_NAME", "test_petty_cash_export")


# A tiny 1x1 PNG, base64-encoded — stands in for a phone-photo'd receipt
# in tests without dragging a real image file into the repo.
_PNG_1x1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)
_PNG_DATA_URL = f"data:image/png;base64,{base64.b64encode(_PNG_1x1).decode()}"


def _patch_db(db):
    """Patch the source `config.get_db` since petty_cash_export imports
    it lazily inside its functions (not at module top)."""
    return patch("config.get_db", return_value=db)


class _CursorChain:
    def __init__(self, items):
        self._items = list(items)
    def sort(self, *a, **k): return self
    async def to_list(self, _n): return list(self._items)


def _db_with_txns(txns, showroom_doc=None):
    db = MagicMock()
    db.petty_cash.find = MagicMock(return_value=_CursorChain(txns))
    db.showrooms.find_one = AsyncMock(return_value=showroom_doc or {"id": "sr-1", "name": "Tonbridge"})
    return db


# ---------------------------------------------------------------------
# ZIP builder
# ---------------------------------------------------------------------
def test_build_zip_includes_image_csv_and_txt_summaries():
    """Happy path — three transactions, each with a receipt image. The
    ZIP should contain three image entries and the two summary files."""
    from services.petty_cash_export import build_petty_cash_monthly_zip
    txns = [
        {
            "id": "tx-001", "showroom_id": "sr-1", "amount": 12.50,
            "category": "Parking", "description": "Customer site visit",
            "recorded_by": "Mia",
            "receipt_image": _PNG_DATA_URL,
            "created_at": datetime(2026, 5, 3, 9, 30, tzinfo=timezone.utc),
        },
        {
            "id": "tx-002", "showroom_id": "sr-1", "amount": 6.00,
            "category": "Staff Meals/Refreshments", "description": "Coffee for fitter",
            "recorded_by": "Mia",
            "receipt_image": _PNG_DATA_URL,
            "created_at": datetime(2026, 5, 7, 11, 15, tzinfo=timezone.utc),
        },
        {
            "id": "tx-003", "showroom_id": "sr-1", "amount": 4.99,
            "category": "Office Supplies", "description": "Receipt rolls",
            "recorded_by": "John",
            "receipt_image": _PNG_DATA_URL,
            "created_at": datetime(2026, 5, 18, 16, 0, tzinfo=timezone.utc),
        },
    ]
    db = _db_with_txns(txns)
    with patch("config.get_db", return_value=db):
        zip_bytes, summary = asyncio.run(
            build_petty_cash_monthly_zip("sr-1", 2026, 5)
        )
    assert zip_bytes.startswith(b"PK")
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        names = zf.namelist()
        # 3 image files under receipts/ + 2 summaries
        image_files = [n for n in names if n.startswith("receipts/")]
        assert len(image_files) == 3
        assert "summary.csv" in names
        assert "summary.txt" in names
        csv_data = zf.read("summary.csv").decode("utf-8")
        # Header + 3 rows
        assert csv_data.count("\n") >= 3
        assert "Parking" in csv_data
        assert "Coffee for fitter" in csv_data
        assert "12.50" in csv_data
        txt_data = zf.read("summary.txt").decode("utf-8")
        assert "Tonbridge" in txt_data
        assert "May 2026" in txt_data
        assert "£23.49" in txt_data  # total
        assert "by Mia" in txt_data
    # Summary metadata
    assert summary["showroom_name"] == "Tonbridge"
    assert summary["month_label"] == "May 2026"
    assert summary["txn_count"] == 3
    assert summary["total_amount"] == 23.49
    assert summary["missing_receipts"] == 0
    assert summary["categories"]["Parking"] == 12.50


def test_build_zip_records_transactions_without_receipts():
    """Missing receipt images don't break the build — they're flagged
    in summary and counted toward `missing_receipts`."""
    from services.petty_cash_export import build_petty_cash_monthly_zip
    txns = [
        {
            "id": "tx-1", "showroom_id": "sr-1", "amount": 10.00,
            "category": "Other", "description": "no receipt",
            "recorded_by": "Mia", "receipt_image": None,
            "created_at": datetime(2026, 5, 3, tzinfo=timezone.utc),
        },
        {
            "id": "tx-2", "showroom_id": "sr-1", "amount": 5.00,
            "category": "Other", "description": "with receipt",
            "recorded_by": "Mia", "receipt_image": _PNG_DATA_URL,
            "created_at": datetime(2026, 5, 4, tzinfo=timezone.utc),
        },
    ]
    db = _db_with_txns(txns)
    with patch("config.get_db", return_value=db):
        _, summary = asyncio.run(build_petty_cash_monthly_zip("sr-1", 2026, 5))
    assert summary["txn_count"] == 2
    assert summary["missing_receipts"] == 1
    assert summary["total_amount"] == 15.00


def test_build_zip_aggregates_by_category():
    from services.petty_cash_export import build_petty_cash_monthly_zip
    txns = [
        {"id": "a", "showroom_id": "sr-1", "amount": 10.0, "category": "Parking",
         "description": "", "recorded_by": "", "receipt_image": None,
         "created_at": datetime(2026, 5, 1, tzinfo=timezone.utc)},
        {"id": "b", "showroom_id": "sr-1", "amount": 12.5, "category": "Parking",
         "description": "", "recorded_by": "", "receipt_image": None,
         "created_at": datetime(2026, 5, 2, tzinfo=timezone.utc)},
        {"id": "c", "showroom_id": "sr-1", "amount": 5.0, "category": "Office Supplies",
         "description": "", "recorded_by": "", "receipt_image": None,
         "created_at": datetime(2026, 5, 3, tzinfo=timezone.utc)},
    ]
    db = _db_with_txns(txns)
    with patch("config.get_db", return_value=db):
        _, summary = asyncio.run(build_petty_cash_monthly_zip("sr-1", 2026, 5))
    assert summary["categories"]["Parking"] == 22.50
    assert summary["categories"]["Office Supplies"] == 5.00


def test_build_zip_raises_value_error_when_window_empty():
    """Empty window → caller should swallow and skip the email."""
    from services.petty_cash_export import build_petty_cash_monthly_zip
    db = _db_with_txns([])
    with patch("config.get_db", return_value=db):
        with pytest.raises(ValueError):
            asyncio.run(build_petty_cash_monthly_zip("sr-1", 2026, 5))


def test_build_zip_uses_all_showrooms_label_for_global_scope():
    """scope='all_showrooms' should NOT filter by showroom_id — accountant
    gets one combined report covering every store."""
    from services.petty_cash_export import build_petty_cash_monthly_zip
    txns = [
        {"id": "x", "showroom_id": "sr-a", "amount": 5.0, "category": "Other",
         "description": "", "recorded_by": "", "receipt_image": None,
         "created_at": datetime(2026, 5, 1, tzinfo=timezone.utc)},
        {"id": "y", "showroom_id": "sr-b", "amount": 7.0, "category": "Other",
         "description": "", "recorded_by": "", "receipt_image": None,
         "created_at": datetime(2026, 5, 2, tzinfo=timezone.utc)},
    ]
    db = MagicMock()
    db.petty_cash.find = MagicMock(return_value=_CursorChain(txns))
    with patch("config.get_db", return_value=db):
        _, summary = asyncio.run(build_petty_cash_monthly_zip("all_showrooms", 2026, 5))
    # Both showrooms' txns counted
    assert summary["showroom_name"] == "All showrooms"
    assert summary["txn_count"] == 2
    # The query passed to .find() should NOT scope by showroom_id
    call_args = db.petty_cash.find.call_args
    query = call_args.args[0]
    assert "showroom_id" not in query


# ---------------------------------------------------------------------
# Email orchestrator
# ---------------------------------------------------------------------
def test_email_job_sends_zip_and_marks_schedule_ok():
    from services.petty_cash_export import run_petty_cash_monthly_email_job
    txns = [
        {"id": "tx", "showroom_id": "sr-1", "amount": 10.0, "category": "Other",
         "description": "x", "recorded_by": "Mia", "receipt_image": _PNG_DATA_URL,
         "created_at": datetime(2026, 5, 1, tzinfo=timezone.utc)},
    ]
    db = _db_with_txns(txns)
    fake_send = AsyncMock(return_value={"success": True, "resend_id": "r_xyz"})
    fake_mark = AsyncMock()
    with patch("config.get_db", return_value=db), \
         patch("services.email.send_simple_email_if_possible", fake_send), \
         patch("routes.auto_exports.mark_schedule_result", fake_mark):
        asyncio.run(run_petty_cash_monthly_email_job(
            "sr-1", 2026, 5, ["accountant@x.com"], None, None,
            "Admin", "admin@tilestation.co.uk", "sched-1",
        ))
    fake_send.assert_awaited()
    sent = fake_send.call_args.kwargs
    assert "Tonbridge" in sent["subject"]
    assert "May 2026" in sent["subject"]
    assert sent["attachments"][0]["filename"].startswith("petty_cash_sr-1_2026-05")
    assert sent["attachments"][0]["content_type"] == "application/zip"
    # Schedule marked ok with a useful note
    fake_mark.assert_awaited_once()
    kwargs = fake_mark.await_args.kwargs
    assert kwargs["status"] == "ok"
    assert "May 2026" in kwargs["note"]


def test_email_job_skips_empty_window_without_sending():
    """No transactions → no email, schedule still marked 'ok' so the
    UI shows it ran."""
    from services.petty_cash_export import run_petty_cash_monthly_email_job
    db = _db_with_txns([])
    fake_send = AsyncMock(return_value={"success": True})
    fake_mark = AsyncMock()
    with patch("config.get_db", return_value=db), \
         patch("services.email.send_simple_email_if_possible", fake_send), \
         patch("routes.auto_exports.mark_schedule_result", fake_mark):
        asyncio.run(run_petty_cash_monthly_email_job(
            "sr-1", 2026, 5, ["a@b.com"], None, None,
            "Admin", "admin@x.com", "sched-1",
        ))
    # No email when there's nothing to send
    fake_send.assert_not_awaited()
    fake_mark.assert_awaited_once()
    assert fake_mark.await_args.kwargs["status"] == "ok"
    assert "No petty cash" in fake_mark.await_args.kwargs["note"]


def test_email_job_marks_failed_and_notifies_sender_on_resend_error():
    from services.petty_cash_export import run_petty_cash_monthly_email_job
    txns = [
        {"id": "tx", "showroom_id": "sr-1", "amount": 10.0, "category": "Other",
         "description": "", "recorded_by": "", "receipt_image": _PNG_DATA_URL,
         "created_at": datetime(2026, 5, 1, tzinfo=timezone.utc)},
    ]
    db = _db_with_txns(txns)
    # First send (to accountant) fails; second send (to sender heads-up) ok
    fake_send = AsyncMock(side_effect=[
        {"success": False, "error": "API key rejected"},
        {"success": True},
    ])
    fake_mark = AsyncMock()
    with patch("config.get_db", return_value=db), \
         patch("services.email.send_simple_email_if_possible", fake_send), \
         patch("routes.auto_exports.mark_schedule_result", fake_mark):
        asyncio.run(run_petty_cash_monthly_email_job(
            "sr-1", 2026, 5, ["a@b.com"], None, None,
            "Admin", "admin@tilestation.co.uk", "sched-1",
        ))
    assert fake_send.call_count == 2
    notify = fake_send.call_args_list[1].kwargs
    assert notify["to"] == ["admin@tilestation.co.uk"]
    assert "needs attention" in notify["subject"].lower()
    fake_mark.assert_awaited_once()
    assert fake_mark.await_args.kwargs["status"] == "failed"


# ---------------------------------------------------------------------
# ZIP-too-big graceful fallback
# ---------------------------------------------------------------------
def test_email_job_strips_images_when_zip_exceeds_resend_cap(monkeypatch):
    """If the full ZIP would breach Resend's 40MB cap we send only the
    CSV/TXT summaries instead of failing the whole month."""
    from services.petty_cash_export import run_petty_cash_monthly_email_job
    # Force the cap to 1 byte so any real ZIP exceeds it
    monkeypatch.setattr("services.petty_cash_export.RESEND_ATTACHMENT_CAP_BYTES", 1)
    txns = [
        {"id": "tx", "showroom_id": "sr-1", "amount": 10.0, "category": "Other",
         "description": "", "recorded_by": "", "receipt_image": _PNG_DATA_URL,
         "created_at": datetime(2026, 5, 1, tzinfo=timezone.utc)},
    ]
    db = _db_with_txns(txns)
    fake_send = AsyncMock(return_value={"success": True})
    fake_mark = AsyncMock()
    with patch("config.get_db", return_value=db), \
         patch("services.email.send_simple_email_if_possible", fake_send), \
         patch("routes.auto_exports.mark_schedule_result", fake_mark):
        asyncio.run(run_petty_cash_monthly_email_job(
            "sr-1", 2026, 5, ["a@b.com"], None, None,
            "Admin", "admin@x.com", "sched-1",
        ))
    sent = fake_send.call_args.kwargs
    # Slim ZIP — only summary files, no receipts/ folder entries
    with zipfile.ZipFile(io.BytesIO(sent["attachments"][0]["content"])) as zf:
        names = zf.namelist()
        assert all(n.startswith("summary") for n in names)
    assert "summary_only" in sent["attachments"][0]["filename"]


# ---------------------------------------------------------------------
# Invoice export job wrapper
# ---------------------------------------------------------------------
def test_invoice_monthly_job_dispatches_full_month_range():
    """The invoice job derives a proper YYYY-MM-01 .. YYYY-MM-DD range
    and delegates to _run_bulk_email_job."""
    from services.invoice_export_jobs import run_invoice_monthly_email_job
    fake_inner = AsyncMock()
    fake_mark = AsyncMock()
    with patch("routes.invoice_bulk_pdf._run_bulk_email_job", fake_inner), \
         patch("routes.auto_exports.mark_schedule_result", fake_mark):
        asyncio.run(run_invoice_monthly_email_job(
            2026, 5, ["a@b.com"], None, None,
            "Admin", "admin@x.com", "sched-1",
        ))
    fake_inner.assert_awaited_once()
    req = fake_inner.await_args.args[0]
    assert req.from_date == "2026-05-01"
    assert req.to_date == "2026-05-31"
    assert req.to_emails == ["a@b.com"]
    assert "May 2026" in req.subject
    fake_mark.assert_awaited_once()
    assert fake_mark.await_args.kwargs["status"] == "ok"


def test_invoice_monthly_job_marks_failed_when_inner_raises():
    from services.invoice_export_jobs import run_invoice_monthly_email_job
    fake_inner = AsyncMock(side_effect=RuntimeError("boom"))
    fake_mark = AsyncMock()
    with patch("routes.invoice_bulk_pdf._run_bulk_email_job", fake_inner), \
         patch("routes.auto_exports.mark_schedule_result", fake_mark):
        with pytest.raises(RuntimeError):
            asyncio.run(run_invoice_monthly_email_job(
                2026, 5, ["a@b.com"], None, None,
                "Admin", "admin@x.com", "sched-1",
            ))
    fake_mark.assert_awaited_once()
    assert fake_mark.await_args.kwargs["status"] == "failed"
    assert "boom" in fake_mark.await_args.kwargs["note"]

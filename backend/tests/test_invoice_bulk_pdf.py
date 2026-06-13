"""
Tests for bulk invoice PDF ZIP export (13 Jun 2026).
"""
import os
import asyncio
import io
import zipfile
from unittest.mock import patch, AsyncMock, MagicMock

import pytest


@pytest.fixture(autouse=True)
def _env_setup():
    os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
    os.environ.setdefault("DB_NAME", "test_bulk_pdf")


async def _drain(resp) -> bytes:
    """Drain a StreamingResponse body (async iterator) to bytes."""
    buf = io.BytesIO()
    async for chunk in resp.body_iterator:
        buf.write(chunk if isinstance(chunk, (bytes, bytearray)) else chunk.encode())
    return buf.getvalue()


class _AsyncIter:
    def __init__(self, items): self._items = list(items)
    def __aiter__(self): self._iter = iter(self._items); return self
    async def __anext__(self):
        try: return next(self._iter)
        except StopIteration as e: raise StopAsyncIteration from e


class _FindChain:
    """Mimic motor's chained find().sort().to_list() — returns whatever
    list of dicts the test provided."""
    def __init__(self, items):
        self._items = items
    def sort(self, *a, **k): return self
    async def to_list(self, _n): return list(self._items)


def _db(invoices=None, showrooms=None):
    db = MagicMock()
    db.invoices.find = MagicMock(return_value=_FindChain(invoices or []))
    db.invoices.count_documents = AsyncMock(return_value=len(invoices or []))
    db.showrooms.find = MagicMock(return_value=_AsyncIter(showrooms or []))
    return db


SUPER = {"role": "super_admin", "email": "a@b"}
ADMIN = {"role": "admin", "email": "a@b"}
STAFF = {"role": "staff", "email": "s@b"}


# ---------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------
def test_bulk_zip_rejects_non_admin():
    from routes.invoice_bulk_pdf import bulk_invoice_pdf_zip
    from fastapi import HTTPException
    with patch("routes.invoice_bulk_pdf.get_db", return_value=_db()):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(bulk_invoice_pdf_zip(
                from_date="2026-06-01", to_date="2026-06-13", current_user=STAFF,
            ))
        assert exc.value.status_code == 403


def test_bulk_zip_rejects_admin_role_now_super_only():
    """13 Jun 2026 — Bulk export is super-admin ONLY. Plain admin /
    manager were previously allowed (mirroring the per-invoice PDF
    route) but were locked out at the user's request because bulk
    export is materially riskier (a whole month's financial data in
    one click)."""
    from routes.invoice_bulk_pdf import bulk_invoice_pdf_zip
    from fastapi import HTTPException
    with patch("routes.invoice_bulk_pdf.get_db", return_value=_db()):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(bulk_invoice_pdf_zip(
                from_date="2026-06-01", to_date="2026-06-13", current_user=ADMIN,
            ))
        assert exc.value.status_code == 403
    # Manager too
    MANAGER = {"role": "manager", "email": "m@b"}
    with patch("routes.invoice_bulk_pdf.get_db", return_value=_db()):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(bulk_invoice_pdf_zip(
                from_date="2026-06-01", to_date="2026-06-13", current_user=MANAGER,
            ))
        assert exc.value.status_code == 403


def test_bulk_zip_rejects_malformed_dates():
    from routes.invoice_bulk_pdf import bulk_invoice_pdf_zip
    from fastapi import HTTPException
    with patch("routes.invoice_bulk_pdf.get_db", return_value=_db()):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(bulk_invoice_pdf_zip(
                from_date="01/06/2026", to_date="13/06/2026", current_user=SUPER,
            ))
        assert exc.value.status_code == 400
        assert "YYYY-MM-DD" in exc.value.detail


def test_bulk_zip_rejects_reversed_dates():
    from routes.invoice_bulk_pdf import bulk_invoice_pdf_zip
    from fastapi import HTTPException
    with patch("routes.invoice_bulk_pdf.get_db", return_value=_db()):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(bulk_invoice_pdf_zip(
                from_date="2026-06-13", to_date="2026-06-01", current_user=SUPER,
            ))
        assert exc.value.status_code == 400


def test_bulk_zip_rejects_oversized_range():
    """A range >1 year is almost always a mistake — short-circuit
    before we even query."""
    from routes.invoice_bulk_pdf import bulk_invoice_pdf_zip
    from fastapi import HTTPException
    with patch("routes.invoice_bulk_pdf.get_db", return_value=_db()):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(bulk_invoice_pdf_zip(
                from_date="2024-01-01", to_date="2026-06-13", current_user=SUPER,
            ))
        assert exc.value.status_code == 400


def test_bulk_zip_404_when_no_invoices():
    from routes.invoice_bulk_pdf import bulk_invoice_pdf_zip
    from fastapi import HTTPException
    with patch("routes.invoice_bulk_pdf.get_db", return_value=_db(invoices=[])):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(bulk_invoice_pdf_zip(
                from_date="2026-06-01", to_date="2026-06-13", current_user=SUPER,
            ))
        assert exc.value.status_code == 404


def test_bulk_zip_rejects_over_cap():
    """If the query returns more than MAX_INVOICES_PER_ZIP rows,
    refuse with 400 rather than start an enormous render."""
    from routes.invoice_bulk_pdf import bulk_invoice_pdf_zip, MAX_INVOICES_PER_ZIP
    from fastapi import HTTPException
    too_many = [{"id": f"i{i}", "invoice_number": f"INV-{i}"} for i in range(MAX_INVOICES_PER_ZIP + 1)]
    with patch("routes.invoice_bulk_pdf.get_db", return_value=_db(invoices=too_many)):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(bulk_invoice_pdf_zip(
                from_date="2026-06-01", to_date="2026-06-13", current_user=SUPER,
            ))
        assert exc.value.status_code == 400
        assert "narrow" in exc.value.detail.lower()


# ---------------------------------------------------------------------
# Happy path — actual ZIP build
# ---------------------------------------------------------------------
def test_bulk_zip_returns_streaming_zip_with_each_invoice_pdf():
    """Two real invoices → ZIP with two PDF entries named after each
    invoice_number. PDF bytes are produced by the existing renderer
    (mocked here so we don't pull in reportlab)."""
    from routes.invoice_bulk_pdf import bulk_invoice_pdf_zip
    invoices = [
        {"id": "i1", "invoice_number": "INV-100", "showroom_id": "sr_a"},
        {"id": "i2", "invoice_number": "INV-101", "showroom_id": "sr_a"},
    ]
    showrooms = [{"id": "sr_a", "name": "Tonbridge"}]
    db = _db(invoices=invoices, showrooms=showrooms)
    fake_render = AsyncMock(side_effect=[b"%PDF-fake-1", b"%PDF-fake-2"])
    with patch("routes.invoice_bulk_pdf.get_db", return_value=db), \
         patch("server.generate_invoice_pdf_bytes", fake_render):
        resp = asyncio.run(bulk_invoice_pdf_zip(
            from_date="2026-06-01", to_date="2026-06-13", current_user=SUPER,
        ))
    zip_bytes = asyncio.run(_drain(resp))
    assert zip_bytes.startswith(b"PK"), "Output is not a valid ZIP file"
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        names = sorted(zf.namelist())
        assert names == ["INV-100.pdf", "INV-101.pdf"]
        assert zf.read("INV-100.pdf") == b"%PDF-fake-1"
        assert zf.read("INV-101.pdf") == b"%PDF-fake-2"
    assert resp.headers["X-Invoice-Count"] == "2"
    assert resp.headers["X-Invoice-Failed"] == "0"


def test_bulk_zip_continues_past_a_failing_invoice_and_writes_manifest():
    """One bad invoice doesn't poison the whole ZIP — the good ones
    still come back, and a `_failed_manifest.txt` row inside lists
    the failures."""
    from routes.invoice_bulk_pdf import bulk_invoice_pdf_zip
    invoices = [
        {"id": "g", "invoice_number": "GOOD-1"},
        {"id": "b", "invoice_number": "BAD-1"},
    ]
    async def _render(inv, _showroom):
        if inv["id"] == "b":
            raise RuntimeError("template missing")
        return b"%PDF-good"
    db = _db(invoices=invoices)
    with patch("routes.invoice_bulk_pdf.get_db", return_value=db), \
         patch("server.generate_invoice_pdf_bytes", side_effect=_render):
        resp = asyncio.run(bulk_invoice_pdf_zip(
            from_date="2026-06-01", to_date="2026-06-13", current_user=SUPER,
        ))
    zip_bytes = asyncio.run(_drain(resp))
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        assert "GOOD-1.pdf" in zf.namelist()
        assert "_failed_manifest.txt" in zf.namelist()
        manifest = zf.read("_failed_manifest.txt").decode("utf-8")
        assert "BAD-1" in manifest
        assert "template missing" in manifest


def test_bulk_zip_sanitises_unsafe_filenames():
    """Invoice number with slashes / spaces must be sanitised so the
    ZIP entry can't break filesystem rules on extract."""
    from routes.invoice_bulk_pdf import bulk_invoice_pdf_zip
    invoices = [{"id": "x", "invoice_number": "INV/2026/06 #001"}]
    db = _db(invoices=invoices)
    with patch("routes.invoice_bulk_pdf.get_db", return_value=db), \
         patch("server.generate_invoice_pdf_bytes", AsyncMock(return_value=b"%PDF")):
        resp = asyncio.run(bulk_invoice_pdf_zip(
            from_date="2026-06-01", to_date="2026-06-13", current_user=SUPER,
        ))
    zip_bytes = asyncio.run(_drain(resp))
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        name = zf.namelist()[0]
        # No / or space should remain in the safe filename
        assert "/" not in name
        assert " " not in name
        assert name.endswith(".pdf")


# ---------------------------------------------------------------------
# Count endpoint
# ---------------------------------------------------------------------
def test_count_endpoint_returns_within_limit_flag():
    from routes.invoice_bulk_pdf import bulk_invoice_pdf_zip_count
    db = _db(invoices=[{"id": "i", "invoice_number": "X"} for _ in range(3)])
    with patch("routes.invoice_bulk_pdf.get_db", return_value=db):
        r = asyncio.run(bulk_invoice_pdf_zip_count(
            from_date="2026-06-01", to_date="2026-06-13", current_user=SUPER,
        ))
    assert r["count"] == 3
    assert r["within_limit"] is True
    assert r["max_per_zip"] >= 3


def test_count_endpoint_flags_over_limit():
    from routes.invoice_bulk_pdf import bulk_invoice_pdf_zip_count, MAX_INVOICES_PER_ZIP
    db = _db()
    db.invoices.count_documents = AsyncMock(return_value=MAX_INVOICES_PER_ZIP + 50)
    with patch("routes.invoice_bulk_pdf.get_db", return_value=db):
        r = asyncio.run(bulk_invoice_pdf_zip_count(
            from_date="2026-01-01", to_date="2026-06-13", current_user=SUPER,
        ))
    assert r["within_limit"] is False
    assert r["count"] > r["max_per_zip"]


# ---------------------------------------------------------------------
# Email endpoint
# ---------------------------------------------------------------------
def _bt():
    """Fresh FastAPI BackgroundTasks instance for each test."""
    from fastapi import BackgroundTasks
    return BackgroundTasks()


def test_email_rejects_non_super_admin():
    """Plain admin and manager can't email bulk invoice exports."""
    from routes.invoice_bulk_pdf import bulk_invoice_pdf_zip_email, BulkEmailRequest
    from fastapi import HTTPException
    req = BulkEmailRequest(
        from_date="2026-06-01", to_date="2026-06-13",
        to_emails=["accountant@example.com"],
    )
    for user in (ADMIN, STAFF, {"role": "manager"}, {}):
        with patch("routes.invoice_bulk_pdf.get_db", return_value=_db()):
            with pytest.raises(HTTPException) as exc:
                asyncio.run(bulk_invoice_pdf_zip_email(req, background_tasks=_bt(), current_user=user))
            assert exc.value.status_code == 403


def test_email_queues_background_job_for_small_range():
    """Happy path — endpoint validates + counts synchronously, schedules
    the heavy build+send as a BackgroundTask, returns `queued: true`
    immediately. The actual Resend call happens later (and is covered
    by `test_email_background_job_*` below)."""
    from routes.invoice_bulk_pdf import bulk_invoice_pdf_zip_email, BulkEmailRequest
    db = _db()
    db.invoices.count_documents = AsyncMock(return_value=5)
    req = BulkEmailRequest(
        from_date="2026-06-01", to_date="2026-06-13",
        to_emails=["accountant@example.com", "owner@tilestation.co.uk"],
        subject="Custom subject for June",
        message="Cheers — let me know if anything's missing.",
    )
    bt = _bt()
    with patch("routes.invoice_bulk_pdf.get_db", return_value=db):
        r = asyncio.run(bulk_invoice_pdf_zip_email(req, background_tasks=bt, current_user=SUPER))
    assert r["ok"] is True
    assert r["queued"] is True
    assert r["count"] == 5
    assert sorted(r["to"]) == ["accountant@example.com", "owner@tilestation.co.uk"]
    assert r["likely_email_count"] == 1  # small range → one email
    assert "Queued" in r["message"]
    # Background task was actually scheduled
    assert len(bt.tasks) == 1


def test_email_warns_about_monthly_split_for_large_range():
    """When the range will exceed the per-email Resend cap, the
    response previews how many emails the accountant will receive
    so the admin isn't surprised."""
    from routes.invoice_bulk_pdf import bulk_invoice_pdf_zip_email, BulkEmailRequest
    db = _db()
    db.invoices.count_documents = AsyncMock(return_value=2267)
    req = BulkEmailRequest(
        from_date="2026-03-13", to_date="2026-06-13",
        to_emails=["accountant@example.com"],
    )
    with patch("routes.invoice_bulk_pdf.get_db", return_value=db):
        r = asyncio.run(bulk_invoice_pdf_zip_email(req, background_tasks=_bt(), current_user=SUPER))
    assert r["queued"] is True
    assert r["count"] == 2267
    # 4 calendar months touched: Mar / Apr / May / Jun
    assert r["likely_email_count"] == 4
    assert "4 separate emails" in r["message"]


def test_email_rejects_over_email_cap():
    """Even the email path has a sanity cap. A range returning more
    than MAX_INVOICES_PER_EMAIL should 400 before scheduling the job."""
    from routes.invoice_bulk_pdf import bulk_invoice_pdf_zip_email, BulkEmailRequest, MAX_INVOICES_PER_EMAIL
    from fastapi import HTTPException
    db = _db()
    db.invoices.count_documents = AsyncMock(return_value=MAX_INVOICES_PER_EMAIL + 1)
    req = BulkEmailRequest(
        from_date="2026-06-01", to_date="2026-06-13",
        to_emails=["x@y.com"],
    )
    with patch("routes.invoice_bulk_pdf.get_db", return_value=db):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(bulk_invoice_pdf_zip_email(req, background_tasks=_bt(), current_user=SUPER))
        assert exc.value.status_code == 400
        assert str(MAX_INVOICES_PER_EMAIL) in exc.value.detail


def test_email_rejects_empty_range():
    """No invoices → 404, no background task scheduled."""
    from routes.invoice_bulk_pdf import bulk_invoice_pdf_zip_email, BulkEmailRequest
    from fastapi import HTTPException
    db = _db()
    db.invoices.count_documents = AsyncMock(return_value=0)
    req = BulkEmailRequest(
        from_date="2026-06-01", to_date="2026-06-13",
        to_emails=["x@y.com"],
    )
    bt = _bt()
    with patch("routes.invoice_bulk_pdf.get_db", return_value=db):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(bulk_invoice_pdf_zip_email(req, background_tasks=bt, current_user=SUPER))
        assert exc.value.status_code == 404
        assert len(bt.tasks) == 0


def test_email_background_job_sends_single_email_when_under_cap():
    """The background orchestrator should ship ONE email when the ZIP
    fits inside Resend's 40MB attachment cap."""
    from routes.invoice_bulk_pdf import _run_bulk_email_job, BulkEmailRequest
    invoices = [{"id": "i1", "invoice_number": "INV-200"}]
    db = _db(invoices=invoices)
    req = BulkEmailRequest(
        from_date="2026-06-01", to_date="2026-06-13",
        to_emails=["accountant@example.com"],
        subject="Custom subject",
        message="Cheers — let me know if anything's missing.",
    )
    fake_send = AsyncMock(return_value={"success": True, "resend_id": "resend_xyz"})
    with patch("routes.invoice_bulk_pdf.get_db", return_value=db), \
         patch("server.generate_invoice_pdf_bytes", AsyncMock(return_value=b"%PDF-fake")), \
         patch("services.email.send_simple_email_if_possible", fake_send):
        asyncio.run(_run_bulk_email_job(req, "Admin User", "admin@x.com"))
    # Exactly one Resend call — under the cap so no monthly split.
    assert fake_send.call_count == 1
    sent = fake_send.call_args.kwargs
    assert sent["subject"] == "Custom subject"
    assert sent["to"] == ["accountant@example.com"]
    assert sent["attachments"][0]["filename"] == "invoices_2026-06-01_to_2026-06-13.zip"
    assert sent["attachments"][0]["content"].startswith(b"PK")
    assert "Cheers" in sent["html"]


def test_email_background_job_notifies_sender_on_resend_failure():
    """If Resend rejects the single-email send, the sender (admin) gets
    a heads-up email so they're not left guessing."""
    from routes.invoice_bulk_pdf import _run_bulk_email_job, BulkEmailRequest
    invoices = [{"id": "i1", "invoice_number": "INV-1"}]
    db = _db(invoices=invoices)
    req = BulkEmailRequest(
        from_date="2026-06-01", to_date="2026-06-13",
        to_emails=["x@y.com"],
    )
    # First call (the accountant email) fails; second call (sender
    # heads-up) succeeds.
    fake_send = AsyncMock(side_effect=[
        {"success": False, "error": "API key rejected"},
        {"success": True},
    ])
    with patch("routes.invoice_bulk_pdf.get_db", return_value=db), \
         patch("server.generate_invoice_pdf_bytes", AsyncMock(return_value=b"%PDF")), \
         patch("services.email.send_simple_email_if_possible", fake_send):
        asyncio.run(_run_bulk_email_job(req, "Admin", "admin@tilestation.co.uk"))
    assert fake_send.call_count == 2
    # Second call was the sender notification
    notify = fake_send.call_args_list[1].kwargs
    assert notify["to"] == ["admin@tilestation.co.uk"]
    assert "needs attention" in notify["subject"].lower()
    assert "api key rejected" in notify["html"].lower()


def test_email_background_job_splits_by_month_when_over_resend_cap():
    """When the single ZIP would exceed Resend's 40MB cap, the
    background orchestrator should split the range into calendar
    months and send one email per month."""
    from routes.invoice_bulk_pdf import _run_bulk_email_job, BulkEmailRequest
    # Six invoices, two per "month" in our 3-month range.
    invoices = [{"id": f"i{i}", "invoice_number": f"INV-{i}"} for i in range(6)]
    db = _db(invoices=invoices)
    req = BulkEmailRequest(
        from_date="2026-04-01", to_date="2026-06-13",
        to_emails=["accountant@example.com"],
    )
    # First build (the probe) returns a "big" ZIP that exceeds the cap.
    # Subsequent per-month builds return small ZIPs that send fine.
    # Simulate this by patching the size threshold.
    fake_send = AsyncMock(return_value={"success": True, "resend_id": "rid"})
    big_zip = b"PK" + b"X" * (40 * 1024 * 1024)  # 40MB+ → triggers split
    fake_build = AsyncMock(side_effect=[
        # 1st call: probe full range → return >cap to trigger split
        (big_zip, 6, []),
        # subsequent per-month calls: small enough to send
        (b"PK-small-april", 2, []),
        (b"PK-small-may", 2, []),
        (b"PK-small-june", 2, []),
    ])
    with patch("routes.invoice_bulk_pdf.get_db", return_value=db), \
         patch("routes.invoice_bulk_pdf._build_invoice_zip", fake_build), \
         patch("services.email.send_simple_email_if_possible", fake_send):
        asyncio.run(_run_bulk_email_job(req, "Admin", "admin@x.com"))
    # April / May / June = 3 chunks, so 3 emails
    assert fake_send.call_count == 3
    # Each email's subject names the month so the accountant can file them
    subjects = [c.kwargs["subject"] for c in fake_send.call_args_list]
    assert any("April 2026" in s for s in subjects)
    assert any("May 2026" in s for s in subjects)
    assert any("June 2026" in s for s in subjects)


def test_email_rejects_too_many_recipients():
    """Hard cap on recipients keeps a typo from spamming a 30-name
    distribution list with sensitive financial data."""
    from routes.invoice_bulk_pdf import BulkEmailRequest, MAX_EMAIL_RECIPIENTS
    from pydantic import ValidationError
    too_many = [f"user{i}@x.com" for i in range(MAX_EMAIL_RECIPIENTS + 1)]
    with pytest.raises(ValidationError):
        BulkEmailRequest(
            from_date="2026-06-01", to_date="2026-06-13",
            to_emails=too_many,
        )


def test_month_chunks_handles_single_month():
    from routes.invoice_bulk_pdf import _month_chunks
    chunks = _month_chunks("2026-06-05", "2026-06-20")
    assert chunks == [("2026-06-05", "2026-06-20")]


def test_month_chunks_handles_multi_month_range():
    """A 3-month spread should produce 3 chunks, each spanning its own
    calendar month and clipped at the user-supplied range edges."""
    from routes.invoice_bulk_pdf import _month_chunks
    chunks = _month_chunks("2026-03-15", "2026-06-13")
    assert chunks == [
        ("2026-03-15", "2026-03-31"),
        ("2026-04-01", "2026-04-30"),
        ("2026-05-01", "2026-05-31"),
        ("2026-06-01", "2026-06-13"),
    ]


def test_count_endpoint_returns_both_caps():
    """13 Jun 2026 — count response now exposes the EMAIL cap as well
    so the UI can enable the Email button for ranges that exceed the
    sync-download cap but still fit the background-task cap."""
    from routes.invoice_bulk_pdf import bulk_invoice_pdf_zip_count
    db = _db()
    db.invoices.count_documents = AsyncMock(return_value=1500)
    with patch("routes.invoice_bulk_pdf.get_db", return_value=db):
        r = asyncio.run(bulk_invoice_pdf_zip_count(
            from_date="2026-03-01", to_date="2026-06-13", current_user=SUPER,
        ))
    assert r["count"] == 1500
    assert r["max_per_zip"] == 500
    assert r["max_per_email"] == 3000
    assert r["within_limit"] is False        # over sync-download cap
    assert r["within_email_limit"] is True   # fits in the email cap

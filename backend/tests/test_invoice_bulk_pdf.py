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

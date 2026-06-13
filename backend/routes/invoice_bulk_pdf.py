"""
Bulk invoice PDF export (13 Jun 2026).

User request: "Allow me to filter invoices between two different dates
and bulk download them in PDF in a zip folder."

Endpoints (all SUPER-ADMIN ONLY — bulk export of monthly invoices is
a financially sensitive operation):
    GET  /api/invoices/bulk-pdf-zip?from_date=…&to_date=…       — download
    GET  /api/invoices/bulk-pdf-zip/count?from_date=…&to_date=… — pre-check
    POST /api/invoices/bulk-pdf-zip/email                       — email ZIP

Behaviour:
- Resolves invoices via `created_at` (ISO string, indexed) — same
  field the Store Dashboard uses for date-range analytics.
- Generates each PDF using the existing `generate_invoice_pdf_bytes`
  helper (single source of truth — emails + per-invoice download +
  this bulk endpoint all share one renderer).
- Hard cap: 500 invoices per ZIP. Larger ranges return 400 with a
  message asking the admin to narrow the range. This keeps each
  download under ~50MB and bounds the request time.
- ZIP filename mirrors the date range so multiple downloads stay
  organised in the admin's Downloads folder.
"""
import io
import logging
import zipfile
import re
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, EmailStr, Field

from config import get_db
from services import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/invoices", tags=["Invoices"])

# Hard cap — keeps the ZIP under ~50MB and avoids 60s gateway timeouts.
MAX_INVOICES_PER_ZIP = 500
# A sensible UX guardrail on the date range itself — beyond 1 year
# the admin almost certainly meant a narrower window.
MAX_DAYS_RANGE = 366
# Resend's per-email attachment cap is 40MB. Same ~50MB ZIP cap as the
# direct-download path, but a soft warning if it's bigger.
MAX_EMAIL_RECIPIENTS = 5

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_INVALID_FILENAME = re.compile(r"[^A-Za-z0-9._-]+")


def _safe_filename(s: str) -> str:
    """Strip anything that could break inside a ZIP entry / filesystem.
    Falls back to 'invoice' if the result is empty."""
    cleaned = _INVALID_FILENAME.sub("_", (s or "").strip())
    return cleaned or "invoice"


def _require_super_admin(user: dict) -> None:
    """Super admin only — bulk PDF export is a financially sensitive
    operation (entire month's invoices in one click), so we lock it
    tighter than the per-invoice download (which allows admin /
    manager). Same gate applied to the email-out path."""
    if (user or {}).get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super admin only")


def _validate_date_range(from_date: str, to_date: str) -> tuple:
    """Parse + validate the from/to range. Returns (start_iso, end_exclusive_iso)."""
    if not _DATE_RE.match(from_date) or not _DATE_RE.match(to_date):
        raise HTTPException(400, "from_date and to_date must be YYYY-MM-DD")
    try:
        start = datetime.strptime(from_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        end_exclusive = datetime.strptime(to_date, "%Y-%m-%d").replace(tzinfo=timezone.utc) + timedelta(days=1)
    except ValueError as e:
        raise HTTPException(400, f"Invalid date: {e}") from e
    if end_exclusive <= start:
        raise HTTPException(400, "to_date must be on or after from_date")
    if (end_exclusive - start).days > MAX_DAYS_RANGE:
        raise HTTPException(400, f"Date range too wide (>{MAX_DAYS_RANGE} days). Please narrow it down.")
    return start.isoformat(), end_exclusive.isoformat()


async def _build_invoice_zip(from_date: str, to_date: str) -> tuple:
    """Shared logic for both /download and /email paths.

    Returns (zip_bytes, succeeded_count, failed_list). Raises
    HTTPException on validation failure, no invoices, or over-cap.
    """
    start_iso, end_iso = _validate_date_range(from_date, to_date)
    db = get_db()
    query = {"created_at": {"$gte": start_iso, "$lt": end_iso}}

    invoices = await db.invoices.find(query, {"_id": 0}).sort("created_at", 1).to_list(MAX_INVOICES_PER_ZIP + 1)
    if not invoices:
        raise HTTPException(404, f"No invoices found between {from_date} and {to_date}.")
    if len(invoices) > MAX_INVOICES_PER_ZIP:
        raise HTTPException(
            400,
            f"Too many invoices ({len(invoices)}) — capped at {MAX_INVOICES_PER_ZIP} per ZIP. "
            f"Please narrow the date range and try again.",
        )

    showroom_ids = list({inv.get("showroom_id") for inv in invoices if inv.get("showroom_id")})
    showrooms_map: dict = {}
    if showroom_ids:
        async for sr in db.showrooms.find({"id": {"$in": showroom_ids}}, {"_id": 0}):
            showrooms_map[sr["id"]] = sr

    # Lazy-import the renderer to avoid a circular import (server.py imports
    # `routes`, and the renderer lives in server.py).
    from server import generate_invoice_pdf_bytes  # noqa: PLC0415

    buf = io.BytesIO()
    failed: list = []
    succeeded = 0
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for inv in invoices:
            inv_no = inv.get("invoice_number") or inv.get("id") or "invoice"
            try:
                pdf_bytes = await generate_invoice_pdf_bytes(
                    inv,
                    showrooms_map.get(inv.get("showroom_id")),
                )
                zf.writestr(f"{_safe_filename(inv_no)}.pdf", pdf_bytes)
                succeeded += 1
            except Exception as exc:  # noqa: BLE001 — keep going on a single bad invoice
                logger.warning("bulk-pdf-zip: failed for invoice %s: %s", inv_no, exc)
                failed.append({"invoice": inv_no, "error": str(exc)[:120]})
        if failed:
            manifest_lines = [
                f"Bulk PDF export · {from_date} → {to_date}",
                f"Successful: {succeeded}",
                f"Failed: {len(failed)}",
                "",
                "Failed invoices:",
                *[f"  - {f['invoice']}: {f['error']}" for f in failed],
            ]
            zf.writestr("_failed_manifest.txt", "\n".join(manifest_lines).encode("utf-8"))

    if succeeded == 0:
        raise HTTPException(500, "PDF generation failed for every invoice in the selected range.")

    return buf.getvalue(), succeeded, failed


@router.get("/bulk-pdf-zip")
async def bulk_invoice_pdf_zip(
    from_date: str = Query(..., description="YYYY-MM-DD inclusive"),
    to_date: str = Query(..., description="YYYY-MM-DD inclusive"),
    current_user: dict = Depends(get_current_user),
):
    _require_super_admin(current_user)
    zip_bytes, succeeded, failed = await _build_invoice_zip(from_date, to_date)
    filename = f"invoices_{from_date}_to_{to_date}.zip"
    return StreamingResponse(
        io.BytesIO(zip_bytes),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Invoice-Count": str(succeeded),
            "X-Invoice-Failed": str(len(failed)),
        },
    )


class BulkEmailRequest(BaseModel):
    from_date: str = Field(..., description="YYYY-MM-DD inclusive")
    to_date: str = Field(..., description="YYYY-MM-DD inclusive")
    to_emails: List[EmailStr] = Field(..., min_length=1, max_length=MAX_EMAIL_RECIPIENTS)
    subject: Optional[str] = Field(default=None, max_length=200)
    message: Optional[str] = Field(default=None, max_length=2000)


@router.post("/bulk-pdf-zip/email")
async def bulk_invoice_pdf_zip_email(
    req: BulkEmailRequest,
    current_user: dict = Depends(get_current_user),
):
    """Build the same ZIP as the /download endpoint, attach it to an
    email, and dispatch via Resend. Useful for sending a month's
    invoices straight to the accountant in one click.

    Super-admin only — staff can't send bulk financial data to
    external addresses."""
    _require_super_admin(current_user)
    zip_bytes, succeeded, failed = await _build_invoice_zip(req.from_date, req.to_date)
    zip_filename = f"invoices_{req.from_date}_to_{req.to_date}.zip"

    sender_name = (current_user or {}).get("name") or (current_user or {}).get("email") or "Tile Station"
    default_subject = f"Tile Station invoices {req.from_date} → {req.to_date} ({succeeded} PDF{'s' if succeeded != 1 else ''})"
    subject = req.subject or default_subject
    body_message = (req.message or "").strip()
    html_parts = [
        "<p>Hi,</p>",
        f"<p>Attached: {succeeded} Tile Station invoice PDF{'s' if succeeded != 1 else ''} "
        f"covering <strong>{req.from_date}</strong> to <strong>{req.to_date}</strong>.</p>",
    ]
    if failed:
        html_parts.append(
            f"<p><em>{len(failed)} invoice(s) couldn't be rendered — see "
            f"<code>_failed_manifest.txt</code> inside the ZIP.</em></p>"
        )
    if body_message:
        # Preserve line breaks from the admin's free-text note
        safe_message = body_message.replace("\n", "<br/>")
        html_parts.append(f"<p>{safe_message}</p>")
    html_parts.append(f"<p>Best regards,<br/>{sender_name}<br/>Tile Station</p>")
    html = "".join(html_parts)

    # Dispatch via the existing Resend helper (which base64-encodes
    # binary attachments under the hood).
    from services.email import send_simple_email_if_possible  # noqa: PLC0415
    result = await send_simple_email_if_possible(
        to=list(req.to_emails),
        subject=subject,
        html=html,
        attachments=[{
            "filename": zip_filename,
            "content": zip_bytes,
            "content_type": "application/zip",
        }],
    )
    if not result.get("success"):
        raise HTTPException(502, f"Email failed: {result.get('error', 'unknown')}")
    return {
        "ok": True,
        "succeeded": succeeded,
        "failed": len(failed),
        "to": list(req.to_emails),
        "subject": subject,
        "resend_id": result.get("resend_id"),
    }


@router.get("/bulk-pdf-zip/count")
async def bulk_invoice_pdf_zip_count(
    from_date: str = Query(...),
    to_date: str = Query(...),
    current_user: dict = Depends(get_current_user),
):
    """Lightweight count endpoint — frontend hits this BEFORE the
    download so the admin sees 'X invoices will be exported' upfront
    and we never start a 500-PDF render the user can't actually use."""
    _require_super_admin(current_user)
    start_iso, end_iso = _validate_date_range(from_date, to_date)
    db = get_db()
    count = await db.invoices.count_documents({"created_at": {"$gte": start_iso, "$lt": end_iso}})
    return {
        "count": count,
        "max_per_zip": MAX_INVOICES_PER_ZIP,
        "within_limit": count <= MAX_INVOICES_PER_ZIP,
        "from_date": from_date,
        "to_date": to_date,
    }

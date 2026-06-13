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
- Two caps:
    * Sync DOWNLOAD: 500 invoices per ZIP (~50MB, well under 60s
      gateway timeout). Larger ranges must use the email path.
    * Async EMAIL: 3000 invoices total — runs in a FastAPI
      BackgroundTask so no gateway timeout applies. If the ZIP
      would exceed Resend's 40MB attachment cap, the background
      task auto-splits the range into calendar months and sends
      ONE email per month (typical accountant-friendly layout).
- ZIP filename mirrors the date range so multiple downloads stay
  organised in the admin's Downloads folder.
"""
import io
import logging
import zipfile
import re
from datetime import datetime, timedelta, timezone
from calendar import monthrange
from typing import List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, EmailStr, Field

from config import get_db
from services import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/invoices", tags=["Invoices"])

# Synchronous DOWNLOAD cap — keeps each ZIP under ~50MB and avoids
# the 60s gateway timeout. Anything over this should use the email
# path which runs in a background task.
MAX_INVOICES_PER_ZIP = 500
# Background EMAIL cap — much higher because the heavy lift runs
# out-of-band. Sanity-bounded so a typo in a date picker can't fire
# off a million-invoice render.
MAX_INVOICES_PER_EMAIL = 3000
# Resend's hard attachment cap. If a single ZIP would exceed this we
# auto-split by calendar month so the accountant still gets every
# PDF, just spread across several emails.
RESEND_ATTACHMENT_CAP_BYTES = 35 * 1024 * 1024  # 35MB, 5MB headroom under Resend's 40MB
# A sensible UX guardrail on the date range itself — beyond 1 year
# the admin almost certainly meant a narrower window.
MAX_DAYS_RANGE = 366
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


async def _build_invoice_zip(from_date: str, to_date: str, *, cap: int = MAX_INVOICES_PER_ZIP) -> tuple:
    """Shared logic for both /download and /email paths.

    Returns (zip_bytes, succeeded_count, failed_list). Raises
    HTTPException on validation failure, no invoices, or over-cap.
    `cap` lets the email path raise the limit since it runs in a
    background task and isn't bound by the 60s gateway timeout.
    """
    start_iso, end_iso = _validate_date_range(from_date, to_date)
    db = get_db()
    query = {"created_at": {"$gte": start_iso, "$lt": end_iso}}

    invoices = await db.invoices.find(query, {"_id": 0}).sort("created_at", 1).to_list(cap + 1)
    if not invoices:
        raise HTTPException(404, f"No invoices found between {from_date} and {to_date}.")
    if len(invoices) > cap:
        raise HTTPException(
            400,
            f"Too many invoices ({len(invoices)}) — capped at {cap} per ZIP. "
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


def _month_chunks(from_date: str, to_date: str) -> List[tuple]:
    """Split [from_date, to_date] into one (from, to) pair per calendar
    month so each chunk's ZIP stays under Resend's 40MB attachment cap.

    Returns a list of (chunk_from_iso, chunk_to_iso) tuples in order.
    For ranges already inside a single month the list has one entry.
    """
    start = datetime.strptime(from_date, "%Y-%m-%d").date()
    end = datetime.strptime(to_date, "%Y-%m-%d").date()
    chunks: list = []
    cursor = start
    while cursor <= end:
        last_day_of_month = monthrange(cursor.year, cursor.month)[1]
        month_end = cursor.replace(day=last_day_of_month)
        chunk_end = min(month_end, end)
        chunks.append((cursor.strftime("%Y-%m-%d"), chunk_end.strftime("%Y-%m-%d")))
        # Move to first of next month
        if chunk_end >= end:
            break
        cursor = (chunk_end + timedelta(days=1))
    return chunks


def _compose_email_html(*, from_date: str, to_date: str, succeeded: int,
                        failed: int, message: str, sender_name: str,
                        chunk_label: Optional[str] = None) -> str:
    """Render the HTML body shared by single + multi-chunk email sends."""
    s = "s" if succeeded != 1 else ""
    bits = ["<p>Hi,</p>"]
    if chunk_label:
        bits.append(
            f"<p>Attached: {succeeded} Tile Station invoice PDF{s} for "
            f"<strong>{chunk_label}</strong> (part of the {from_date} → {to_date} range).</p>"
        )
    else:
        bits.append(
            f"<p>Attached: {succeeded} Tile Station invoice PDF{s} "
            f"covering <strong>{from_date}</strong> to <strong>{to_date}</strong>.</p>"
        )
    if failed:
        bits.append(
            f"<p><em>{failed} invoice(s) couldn't be rendered — see "
            f"<code>_failed_manifest.txt</code> inside the ZIP.</em></p>"
        )
    if (message or "").strip():
        bits.append(f"<p>{message.strip().replace(chr(10), '<br/>')}</p>")
    bits.append(f"<p>Best regards,<br/>{sender_name}<br/>Tile Station</p>")
    return "".join(bits)


async def _build_and_email_one_chunk(
    *, req: BulkEmailRequest, chunk_from: str, chunk_to: str,
    sender_name: str, total_chunks: int, chunk_index: int,
) -> dict:
    """Build a ZIP for one chunk of dates and email it. Returns a small
    result dict so the orchestrator can log a per-chunk summary."""
    zip_bytes, succeeded, failed = await _build_invoice_zip(
        chunk_from, chunk_to, cap=MAX_INVOICES_PER_EMAIL,
    )
    # Subject — if the orchestrator split into multiple chunks we
    # include "(part X/Y · month name)" so the accountant can sort
    # the emails into the right month at a glance.
    month_label = datetime.strptime(chunk_from, "%Y-%m-%d").strftime("%B %Y")
    if total_chunks > 1:
        chunk_label = f"{month_label} (part {chunk_index}/{total_chunks})"
        default_subject = (
            f"Tile Station invoices — {month_label} "
            f"({succeeded} PDF{'s' if succeeded != 1 else ''}, part {chunk_index}/{total_chunks})"
        )
    else:
        chunk_label = None
        default_subject = (
            f"Tile Station invoices {req.from_date} → {req.to_date} "
            f"({succeeded} PDF{'s' if succeeded != 1 else ''})"
        )
    subject = req.subject or default_subject
    if total_chunks > 1 and req.subject:
        subject = f"{req.subject} — {month_label} (part {chunk_index}/{total_chunks})"

    html = _compose_email_html(
        from_date=req.from_date, to_date=req.to_date,
        succeeded=succeeded, failed=len(failed),
        message=req.message or "", sender_name=sender_name,
        chunk_label=chunk_label,
    )

    from services.email import send_simple_email_if_possible  # noqa: PLC0415
    zip_filename = f"invoices_{chunk_from}_to_{chunk_to}.zip"
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
    return {
        "chunk_from": chunk_from, "chunk_to": chunk_to,
        "succeeded": succeeded, "failed": len(failed),
        "size_bytes": len(zip_bytes),
        "send_ok": bool(result.get("success")),
        "send_error": result.get("error"),
        "resend_id": result.get("resend_id"),
    }


async def _run_bulk_email_job(req: BulkEmailRequest, sender_name: str, sender_email: Optional[str]) -> None:
    """Background-task orchestrator.

    1. Probe the full-range ZIP size by building it once.
    2. If it fits under Resend's attachment cap → one email, done.
    3. Otherwise auto-split into calendar months and send N emails.
    4. On any failure, log + send a sender-notification email so the
       admin isn't left wondering what happened.
    """
    try:
        # Probe size cheaply by building once — if it fits Resend's cap
        # we send one big email; if not we tear it down and rebuild per
        # month. Building twice is fine because the PDF render is the
        # expensive bit, not the zip wrapping, and we want a single
        # email path whenever possible.
        zip_bytes, succeeded, failed = await _build_invoice_zip(
            req.from_date, req.to_date, cap=MAX_INVOICES_PER_EMAIL,
        )
        if len(zip_bytes) <= RESEND_ATTACHMENT_CAP_BYTES:
            from services.email import send_simple_email_if_possible  # noqa: PLC0415
            subject = req.subject or (
                f"Tile Station invoices {req.from_date} → {req.to_date} "
                f"({succeeded} PDF{'s' if succeeded != 1 else ''})"
            )
            html = _compose_email_html(
                from_date=req.from_date, to_date=req.to_date,
                succeeded=succeeded, failed=len(failed),
                message=req.message or "", sender_name=sender_name,
            )
            result = await send_simple_email_if_possible(
                to=list(req.to_emails),
                subject=subject,
                html=html,
                attachments=[{
                    "filename": f"invoices_{req.from_date}_to_{req.to_date}.zip",
                    "content": zip_bytes,
                    "content_type": "application/zip",
                }],
            )
            if not result.get("success"):
                logger.error("bulk-email background: Resend failed: %s", result.get("error"))
                await _notify_sender_of_failure(
                    sender_email=sender_email,
                    sender_name=sender_name,
                    reason=f"Resend rejected the email: {result.get('error', 'unknown')}",
                    req=req,
                )
            else:
                logger.info("bulk-email background: sent %s invoices, resend_id=%s",
                            succeeded, result.get("resend_id"))
            return

        # Too big for a single email — split by calendar month and
        # send N emails.
        chunks = _month_chunks(req.from_date, req.to_date)
        logger.info("bulk-email background: ZIP %dMB > Resend cap — splitting into %d monthly emails",
                    len(zip_bytes) // (1024 * 1024), len(chunks))
        results = []
        for i, (cf, ct) in enumerate(chunks, start=1):
            try:
                r = await _build_and_email_one_chunk(
                    req=req, chunk_from=cf, chunk_to=ct,
                    sender_name=sender_name,
                    total_chunks=len(chunks), chunk_index=i,
                )
                results.append(r)
                if not r["send_ok"]:
                    logger.error("bulk-email background: chunk %s→%s failed: %s",
                                 cf, ct, r["send_error"])
            except HTTPException as e:
                # e.g. a chunk with no invoices — skip and continue.
                logger.info("bulk-email background: skipping chunk %s→%s: %s", cf, ct, e.detail)
                results.append({"chunk_from": cf, "chunk_to": ct, "skipped": True, "reason": e.detail})
            except Exception:
                logger.exception("bulk-email background: chunk %s→%s crashed", cf, ct)

        # Sender summary — only when something went sideways. Successful
        # multi-chunk runs are self-evident (the recipients see the emails).
        any_failed = any(not r.get("send_ok") and not r.get("skipped") for r in results)
        if any_failed:
            await _notify_sender_of_failure(
                sender_email=sender_email,
                sender_name=sender_name,
                reason="Some monthly emails failed to send — check the server log for details.",
                req=req,
            )
    except HTTPException as e:
        logger.error("bulk-email background: refused: %s", e.detail)
        await _notify_sender_of_failure(
            sender_email=sender_email,
            sender_name=sender_name,
            reason=str(e.detail),
            req=req,
        )
    except Exception as e:  # noqa: BLE001
        logger.exception("bulk-email background: crashed")
        await _notify_sender_of_failure(
            sender_email=sender_email,
            sender_name=sender_name,
            reason=f"Unexpected error: {type(e).__name__}",
            req=req,
        )


async def _notify_sender_of_failure(
    *, sender_email: Optional[str], sender_name: str,
    reason: str, req: BulkEmailRequest,
) -> None:
    """Best-effort heads-up to the admin who clicked Email — never raises."""
    if not sender_email:
        return
    try:
        from services.email import send_simple_email_if_possible  # noqa: PLC0415
        html = (
            "<p>Hi,</p>"
            "<p>Your recent bulk-invoice email export <strong>didn't fully succeed</strong>:</p>"
            f"<p><strong>Range:</strong> {req.from_date} → {req.to_date}<br/>"
            f"<strong>Recipients:</strong> {', '.join(req.to_emails)}<br/>"
            f"<strong>Reason:</strong> {reason}</p>"
            "<p>Try narrowing the date range, or contact support.</p>"
            f"<p>— Tile Station</p>"
        )
        await send_simple_email_if_possible(
            to=[sender_email],
            subject=f"⚠️ Bulk invoice email export needs attention ({req.from_date} → {req.to_date})",
            html=html,
        )
    except Exception:
        logger.exception("Failed to send bulk-email failure notification")


@router.post("/bulk-pdf-zip/email")
async def bulk_invoice_pdf_zip_email(
    req: BulkEmailRequest,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(get_current_user),
):
    """Queue a bulk invoice ZIP email job.

    Validates + counts synchronously (fast), then schedules the heavy
    PDF-render and Resend dispatch as a FastAPI BackgroundTask so the
    HTTP request returns immediately (large ranges of 1000+ invoices
    would otherwise blow through the 60s gateway timeout).

    If the resulting ZIP would exceed Resend's 40MB attachment cap,
    the background task auto-splits the range into calendar months
    and sends ONE email per month — accountant-friendly and avoids
    the size limit.

    Super-admin only — staff can't send bulk financial data to
    external addresses.
    """
    _require_super_admin(current_user)
    # Validate the range + count cheaply BEFORE accepting the job so
    # the admin gets immediate feedback if it's impossible. The heavy
    # render is deferred to the background task.
    start_iso, end_iso = _validate_date_range(req.from_date, req.to_date)
    db = get_db()
    count = await db.invoices.count_documents({"created_at": {"$gte": start_iso, "$lt": end_iso}})
    if count == 0:
        raise HTTPException(404, f"No invoices found between {req.from_date} and {req.to_date}.")
    if count > MAX_INVOICES_PER_EMAIL:
        raise HTTPException(
            400,
            f"Too many invoices ({count}) — email cap is {MAX_INVOICES_PER_EMAIL}. "
            f"Please narrow the date range and try again.",
        )

    sender_name = (current_user or {}).get("name") or (current_user or {}).get("email") or "Tile Station"
    sender_email = (current_user or {}).get("email")
    background_tasks.add_task(_run_bulk_email_job, req, sender_name, sender_email)

    # Estimate whether we'll split — purely informational so the admin
    # knows what to expect in their accountant's inbox.
    likely_chunks = len(_month_chunks(req.from_date, req.to_date)) if count > 600 else 1

    return {
        "ok": True,
        "queued": True,
        "count": count,
        "to": list(req.to_emails),
        "likely_email_count": likely_chunks,
        "message": (
            f"Queued — {count} invoice{'s' if count != 1 else ''} will be emailed to "
            f"{', '.join(req.to_emails)} shortly. This usually takes 1–5 minutes."
            + (f" Large batch — your accountant will receive {likely_chunks} separate emails "
               f"(one per month) to keep attachment sizes manageable." if likely_chunks > 1 else "")
        ),
    }


@router.get("/bulk-pdf-zip/count")
async def bulk_invoice_pdf_zip_count(
    from_date: str = Query(...),
    to_date: str = Query(...),
    current_user: dict = Depends(get_current_user),
):
    """Lightweight count endpoint — frontend hits this BEFORE the
    download so the admin sees 'X invoices will be exported' upfront
    and we never start a 500-PDF render the user can't actually use.

    Returns both caps so the UI can show "Download up to X · Email up
    to Y" and enable the right buttons.
    """
    _require_super_admin(current_user)
    start_iso, end_iso = _validate_date_range(from_date, to_date)
    db = get_db()
    count = await db.invoices.count_documents({"created_at": {"$gte": start_iso, "$lt": end_iso}})
    return {
        "count": count,
        "max_per_zip": MAX_INVOICES_PER_ZIP,
        "max_per_email": MAX_INVOICES_PER_EMAIL,
        "within_limit": count <= MAX_INVOICES_PER_ZIP,
        "within_email_limit": count <= MAX_INVOICES_PER_EMAIL,
        "from_date": from_date,
        "to_date": to_date,
    }

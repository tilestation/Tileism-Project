"""
Invoice monthly auto-email job (13 Jun 2026).

Thin wrapper around the existing bulk-pdf-zip email machinery in
`routes/invoice_bulk_pdf.py`. Exposes a single async function the
auto-exports cron + the /run-now endpoint can call, so the same
build-+-send pipeline (chunk-by-month when needed, sender heads-up
on failure, etc.) is used everywhere.
"""
import logging
from calendar import monthrange
from typing import List, Optional

logger = logging.getLogger(__name__)


def _month_range(year: int, month: int) -> tuple:
    """Return (from_date, to_date) as YYYY-MM-DD strings covering the
    full calendar month."""
    last_day = monthrange(year, month)[1]
    return (
        f"{year:04d}-{month:02d}-01",
        f"{year:04d}-{month:02d}-{last_day:02d}",
    )


async def run_invoice_monthly_email_job(
    year: int,
    month: int,
    recipient_emails: List[str],
    subject_override: Optional[str],
    message_override: Optional[str],
    sender_name: str,
    sender_email: Optional[str],
    schedule_id: Optional[str] = None,
) -> None:
    """Build last-month's invoice ZIP and email it to the accountant.

    Delegates to `_run_bulk_email_job` so it inherits the monthly-
    chunking, Resend size handling, and sender-failure notification.

    On completion, writes a status note back onto the schedule doc
    (via `mark_schedule_result`) so the UI shows "Last sent: …".
    """
    # Lazy imports to avoid circulars with server.py + routes/__init__.py
    from routes.invoice_bulk_pdf import BulkEmailRequest, _run_bulk_email_job  # noqa: PLC0415
    from routes.auto_exports import mark_schedule_result  # noqa: PLC0415

    from_date, to_date = _month_range(year, month)
    # Default subject names the month explicitly so accountants can file
    # the email straight away.
    from datetime import date
    month_label = date(year, month, 1).strftime("%B %Y")
    default_subject = f"Tile Station invoices — {month_label}"
    req = BulkEmailRequest(
        from_date=from_date,
        to_date=to_date,
        to_emails=list(recipient_emails),
        subject=subject_override or default_subject,
        message=message_override,
    )
    try:
        await _run_bulk_email_job(req, sender_name, sender_email)
        if schedule_id:
            await mark_schedule_result(
                schedule_id, status="ok",
                note=f"{month_label} invoices sent to {', '.join(recipient_emails)}",
            )
    except Exception as exc:  # noqa: BLE001
        logger.exception("invoice monthly auto-email failed for %s-%s", year, month)
        if schedule_id:
            await mark_schedule_result(
                schedule_id, status="failed",
                note=f"{month_label} send failed: {type(exc).__name__}: {str(exc)[:200]}",
            )
        # Re-raise so the caller (cron) can log it too; no impact on
        # any other schedules because each runs in its own task.
        raise

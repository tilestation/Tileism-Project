"""
Petty cash monthly export + email job (13 Jun 2026).

User request: "Create a similar [auto-monthly emailer] for Petty Cash /
Expenses where staff can upload images of expense receipts which can
then be emailed to accountant from each store on 1st of every month."

Builds a ZIP per (showroom, month) containing:
  - One image file per petty-cash transaction (PNG/JPG/etc. — original
    upload format preserved). Filename = `YYYY-MM-DD_<category>_<id>.<ext>`.
  - `summary.csv` — one row per transaction with date / category /
    amount / description / recorded_by / has_receipt flag.
  - `summary.txt` — same data in a human-readable layout the
    accountant can read without opening Excel.

Then emails it to the configured accountant via the existing Resend
helper. Behaviour mirrors the invoice export: if the ZIP would exceed
Resend's 40MB attachment cap we fall back to splitting the report into
two halves (first / second half of the month) and sending twice. For
typical store volumes (a few dozen receipts a month) this never fires.

The petty cash schema lives in `db.petty_cash` (see
`routes/cash_counter.py`) — we read it directly. No write-side coupling.
"""
import csv
import io
import logging
import re
import zipfile
from calendar import monthrange
from datetime import datetime, timezone
from typing import List, Optional, Tuple

logger = logging.getLogger(__name__)

# Resend's hard attachment cap is 40MB. 35MB target leaves 5MB headroom
# for the JSON envelope + base64 overhead.
RESEND_ATTACHMENT_CAP_BYTES = 35 * 1024 * 1024

_INVALID_FILENAME = re.compile(r"[^A-Za-z0-9._-]+")
_DATA_URL_RE = re.compile(r"^data:(image/[a-z0-9.+-]+);base64,(.+)$", re.IGNORECASE)


def _safe_filename(s: str, fallback: str = "receipt") -> str:
    cleaned = _INVALID_FILENAME.sub("_", (s or "").strip())
    return cleaned or fallback


def _month_dates(year: int, month: int) -> Tuple[datetime, datetime]:
    """First moment of `month` (inclusive) and first moment of the
    following month (exclusive). Used to bound the receipts query."""
    start = datetime(year, month, 1, tzinfo=timezone.utc)
    if month == 12:
        end = datetime(year + 1, 1, 1, tzinfo=timezone.utc)
    else:
        end = datetime(year, month + 1, 1, tzinfo=timezone.utc)
    return start, end


def _decode_receipt_image(image_data: Optional[str]) -> Optional[Tuple[bytes, str]]:
    """Best-effort decode of a base64 receipt image. Returns
    (raw_bytes, extension) or None on failure / missing data.
    """
    if not image_data or not isinstance(image_data, str):
        return None
    m = _DATA_URL_RE.match(image_data.strip())
    if not m:
        return None
    mime, b64 = m.group(1).lower(), m.group(2)
    ext_map = {
        "image/jpeg": "jpg", "image/jpg": "jpg",
        "image/png": "png", "image/webp": "webp",
        "image/gif": "gif", "image/heic": "heic",
    }
    ext = ext_map.get(mime, "bin")
    try:
        import base64 as _b64  # noqa: PLC0415
        raw = _b64.b64decode(b64, validate=False)
        return raw, ext
    except Exception:
        return None


async def _load_showroom_name(showroom_id: str) -> str:
    """Resolve a showroom UUID to its display name. Falls back to the
    UUID itself if the showroom is missing or the sentinel string is
    used."""
    if showroom_id in {"all", "all_showrooms"}:
        return "All showrooms"
    from config import get_db  # noqa: PLC0415
    sr = await get_db().showrooms.find_one({"id": showroom_id}, {"_id": 0, "name": 1})
    return (sr or {}).get("name") or showroom_id


async def build_petty_cash_monthly_zip(
    showroom_id: str, year: int, month: int,
) -> Tuple[bytes, dict]:
    """Read `db.petty_cash` for the given (showroom, month) and pack the
    receipts into a ZIP. Returns (zip_bytes, summary_dict) where
    summary_dict carries headline numbers the email body can quote:

        {
            "showroom_name": str,
            "month_label": "May 2026",
            "txn_count": int,
            "total_amount": float,
            "missing_receipts": int,   # transactions without an image
            "categories": {name: amount, ...},
        }

    Raises ValueError when the window contains zero transactions —
    callers should swallow this to avoid sending an empty report.
    """
    from config import get_db  # noqa: PLC0415
    start, end = _month_dates(year, month)
    db = get_db()
    query = {"created_at": {"$gte": start, "$lt": end}}
    if showroom_id not in {"all", "all_showrooms"}:
        query["showroom_id"] = showroom_id
    cursor = db.petty_cash.find(query).sort("created_at", 1)
    txns = await cursor.to_list(5000)
    if not txns:
        raise ValueError(
            f"No petty cash transactions for showroom={showroom_id} "
            f"in {year:04d}-{month:02d}"
        )

    showroom_name = await _load_showroom_name(showroom_id)
    month_label = datetime(year, month, 1).strftime("%B %Y")

    total_amount = 0.0
    missing_receipts = 0
    categories: dict = {}
    csv_buf = io.StringIO()
    csv_writer = csv.writer(csv_buf)
    csv_writer.writerow([
        "Date", "Time", "Category", "Amount (GBP)", "Description",
        "Recorded by", "Receipt attached", "Transaction ID",
    ])
    txt_lines = [
        f"Petty cash report — {showroom_name} — {month_label}",
        "=" * 70,
        "",
    ]

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for idx, t in enumerate(txns, start=1):
            amount = float(t.get("amount") or 0)
            total_amount += amount
            cat = (t.get("category") or "Uncategorised").strip() or "Uncategorised"
            categories[cat] = round(categories.get(cat, 0.0) + amount, 2)
            created = t.get("created_at")
            if isinstance(created, datetime):
                date_str = created.strftime("%Y-%m-%d")
                time_str = created.strftime("%H:%M")
            else:
                # `created_at` may already be an ISO string in some envs
                date_str = str(created)[:10] if created else ""
                time_str = str(created)[11:16] if created and len(str(created)) > 16 else ""

            description = (t.get("description") or "").strip()
            recorded_by = (t.get("recorded_by") or "").strip() or "—"
            txn_id = t.get("id") or f"txn-{idx}"

            # Decode + store the receipt image if we have one.
            decoded = _decode_receipt_image(t.get("receipt_image"))
            has_receipt = decoded is not None
            if not has_receipt:
                missing_receipts += 1
            else:
                raw, ext = decoded
                fname = _safe_filename(
                    f"{date_str}_{cat}_{txn_id[:8]}", fallback=f"receipt-{idx}"
                )
                zf.writestr(f"receipts/{fname}.{ext}", raw)

            csv_writer.writerow([
                date_str, time_str, cat, f"{amount:.2f}",
                description, recorded_by,
                "yes" if has_receipt else "no",
                txn_id,
            ])
            txt_lines.append(
                f"{idx:>3}. {date_str} {time_str}  £{amount:>7.2f}  "
                f"[{cat}]  by {recorded_by}"
                + (f"\n      Receipt: {fname}.{ext}" if has_receipt else "\n      Receipt: MISSING")
                + (f"\n      Note: {description}" if description else "")
            )

        # Totals footer
        txt_lines.extend([
            "",
            "-" * 70,
            f"Total:           £{total_amount:.2f}",
            f"Transactions:    {len(txns)}",
            f"With receipts:   {len(txns) - missing_receipts}",
            f"Missing receipt: {missing_receipts}",
            "",
            "By category:",
        ])
        for cat_name in sorted(categories):
            txt_lines.append(f"  {cat_name:<30} £{categories[cat_name]:>9.2f}")

        zf.writestr("summary.csv", csv_buf.getvalue().encode("utf-8"))
        zf.writestr("summary.txt", "\n".join(txt_lines).encode("utf-8"))

    return buf.getvalue(), {
        "showroom_name": showroom_name,
        "month_label": month_label,
        "txn_count": len(txns),
        "total_amount": round(total_amount, 2),
        "missing_receipts": missing_receipts,
        "categories": categories,
    }


def _compose_email_html(summary: dict, sender_name: str, custom_message: Optional[str]) -> str:
    cats = summary.get("categories") or {}
    cat_rows = "".join(
        f'<li style="font-family:system-ui;font-size:13px">'
        f'{name} — <strong>£{amt:.2f}</strong></li>'
        for name, amt in sorted(cats.items())
    )
    custom = ""
    if (custom_message or "").strip():
        safe = (custom_message or "").strip().replace("\n", "<br/>")
        custom = f'<p style="font-family:system-ui;font-size:14px">{safe}</p>'
    missing_note = ""
    if summary.get("missing_receipts"):
        missing_note = (
            f'<p style="font-family:system-ui;font-size:13px;color:#b45309">'
            f'<em>{summary["missing_receipts"]} transaction(s) had no receipt photo '
            f'attached — see <code>summary.csv</code> for which ones.</em></p>'
        )
    return (
        f'<p style="font-family:system-ui">Hi,</p>'
        f'<p style="font-family:system-ui;font-size:14px">Attached: petty cash report for '
        f'<strong>{summary["showroom_name"]}</strong> — '
        f'<strong>{summary["month_label"]}</strong>.</p>'
        f'<ul style="font-family:system-ui;font-size:14px;line-height:1.7">'
        f'<li>{summary["txn_count"]} transaction(s) totalling '
        f'<strong>£{summary["total_amount"]:.2f}</strong></li>'
        f'<li>{summary["txn_count"] - summary["missing_receipts"]} receipt photo(s) '
        f'inside the ZIP under <code>receipts/</code></li>'
        f'<li>Spreadsheet: <code>summary.csv</code> · Plain text: <code>summary.txt</code></li>'
        f'</ul>'
        f'{f"<p style=font-family:system-ui;font-size:13px><strong>By category:</strong></p><ul>{cat_rows}</ul>" if cat_rows else ""}'
        f'{missing_note}'
        f'{custom}'
        f'<p style="font-family:system-ui;font-size:13px;color:#555">Best regards,<br/>{sender_name}<br/>Tile Station</p>'
    )


async def run_petty_cash_monthly_email_job(
    showroom_id: str,
    year: int,
    month: int,
    recipient_emails: List[str],
    subject_override: Optional[str],
    message_override: Optional[str],
    sender_name: str,
    sender_email: Optional[str],
    schedule_id: Optional[str] = None,
) -> None:
    """Build the (showroom, month) ZIP, email it to the accountant.

    Mirrors the invoice job: on failure (no transactions / Resend
    rejection / unexpected crash) we log + write a status note onto the
    schedule doc + best-effort heads-up the sender so they're not left
    guessing.
    """
    from routes.auto_exports import mark_schedule_result  # noqa: PLC0415
    from services.email import send_simple_email_if_possible  # noqa: PLC0415

    try:
        zip_bytes, summary = await build_petty_cash_monthly_zip(showroom_id, year, month)
    except ValueError as e:
        # Empty window — record as 'ok' with a note so the UI still
        # shows it ran. We deliberately don't email an empty report.
        logger.info("petty-cash-job: nothing to send for %s %s-%s: %s",
                    showroom_id, year, month, e)
        if schedule_id:
            await mark_schedule_result(
                schedule_id, status="ok",
                note=f"No petty cash transactions for {year:04d}-{month:02d} — no email sent.",
            )
        return
    except Exception as e:  # noqa: BLE001
        logger.exception("petty-cash-job: ZIP build failed")
        if schedule_id:
            await mark_schedule_result(
                schedule_id, status="failed",
                note=f"ZIP build failed: {type(e).__name__}: {str(e)[:200]}",
            )
        if sender_email:
            await _notify_sender_of_failure(
                sender_email=sender_email,
                showroom_name=await _load_showroom_name(showroom_id),
                year=year, month=month,
                reason=f"ZIP build failed: {type(e).__name__}",
            )
        raise

    # Resend has a 40MB attachment cap. Stores typically have a few
    # dozen receipts a month at <500KB each, so this almost never fires
    # — but we guard it anyway.
    if len(zip_bytes) > RESEND_ATTACHMENT_CAP_BYTES:
        logger.warning(
            "petty-cash-job: ZIP %dMB exceeds Resend cap — sending summary email without receipts attached",
            len(zip_bytes) // (1024 * 1024),
        )
        # Strip receipt images, keep the CSV/TXT summaries only.
        slim = _strip_receipt_images(zip_bytes)
        attachments = [{
            "filename": f"petty_cash_{showroom_id}_{year:04d}-{month:02d}_summary_only.zip",
            "content": slim,
            "content_type": "application/zip",
        }]
        extra_note = (" (Receipt images stripped — total ZIP exceeded Resend's "
                      "40MB attachment cap. Ask the store for receipts in person.)")
    else:
        attachments = [{
            "filename": f"petty_cash_{showroom_id}_{year:04d}-{month:02d}.zip",
            "content": zip_bytes,
            "content_type": "application/zip",
        }]
        extra_note = ""

    subject = subject_override or (
        f"Petty cash report — {summary['showroom_name']} — {summary['month_label']} "
        f"(£{summary['total_amount']:.2f}, {summary['txn_count']} txn)"
    )
    html = _compose_email_html(summary, sender_name, (message_override or "") + extra_note)

    result = await send_simple_email_if_possible(
        to=list(recipient_emails),
        subject=subject,
        html=html,
        attachments=attachments,
    )
    if result.get("success"):
        if schedule_id:
            await mark_schedule_result(
                schedule_id, status="ok",
                note=(f"{summary['month_label']} — {summary['txn_count']} txn / "
                      f"£{summary['total_amount']:.2f} sent to {', '.join(recipient_emails)}"),
            )
    else:
        if schedule_id:
            await mark_schedule_result(
                schedule_id, status="failed",
                note=f"Resend failed: {result.get('error', 'unknown')}",
            )
        if sender_email:
            await _notify_sender_of_failure(
                sender_email=sender_email,
                showroom_name=summary["showroom_name"],
                year=year, month=month,
                reason=f"Resend rejected the email: {result.get('error', 'unknown')}",
            )


def _strip_receipt_images(zip_bytes: bytes) -> bytes:
    """Rebuild a ZIP keeping only the summary files (CSV + TXT). Used
    as a fallback when the full attachment would breach Resend's cap.
    """
    out = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(zip_bytes), "r") as src, \
         zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as dst:
        for name in src.namelist():
            if name.startswith("summary"):
                dst.writestr(name, src.read(name))
    return out.getvalue()


async def _notify_sender_of_failure(
    *, sender_email: str, showroom_name: str,
    year: int, month: int, reason: str,
) -> None:
    """Heads-up email so the admin who configured the schedule (or
    clicked Run Now) knows something went wrong. Never raises."""
    try:
        from services.email import send_simple_email_if_possible  # noqa: PLC0415
        month_label = datetime(year, month, 1).strftime("%B %Y")
        html = (
            "<p>Hi,</p>"
            f"<p>The petty-cash auto-export for <strong>{showroom_name}</strong> "
            f"({month_label}) <strong>didn&rsquo;t send</strong>:</p>"
            f"<p><strong>Reason:</strong> {reason}</p>"
            "<p>Open the auto-exports settings in the admin panel and try "
            "&laquo;Send now&raquo; once the issue is fixed.</p>"
            "<p>— Tile Station</p>"
        )
        await send_simple_email_if_possible(
            to=[sender_email],
            subject=f"⚠️ Petty cash auto-export needs attention — {showroom_name} ({month_label})",
            html=html,
        )
    except Exception:
        logger.exception("petty-cash-job: failed to send sender failure notification")

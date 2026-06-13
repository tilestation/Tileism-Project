"""
Bulk invoice PDF export (13 Jun 2026).

User request: "Allow me to filter invoices between two different dates
and bulk download them in PDF in a zip folder."

Endpoint:
    GET /api/invoices/bulk-pdf-zip?from_date=YYYY-MM-DD&to_date=YYYY-MM-DD

Behaviour:
- Admin / super-admin only (uses the same auth gate as the per-invoice
  PDF endpoint).
- Resolves invoices via `created_at` (ISO string, indexed) — the same
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

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse

from config import get_db
from services import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/invoices", tags=["Invoices"])

# Hard cap — keeps the ZIP under ~50MB and avoids 60s gateway timeouts.
MAX_INVOICES_PER_ZIP = 500
# A sensible UX guardrail on the date range itself — beyond 1 year
# the admin almost certainly meant a narrower window.
MAX_DAYS_RANGE = 366

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_INVALID_FILENAME = re.compile(r"[^A-Za-z0-9._-]+")


def _safe_filename(s: str) -> str:
    """Strip anything that could break inside a ZIP entry / filesystem.
    Falls back to 'invoice' if the result is empty."""
    cleaned = _INVALID_FILENAME.sub("_", (s or "").strip())
    return cleaned or "invoice"


def _require_admin(user: dict) -> None:
    """Match `is_admin_user` in server.py — super_admin / admin / manager."""
    role = (user or {}).get("role")
    if role not in ("super_admin", "admin", "manager"):
        raise HTTPException(status_code=403, detail="Admin access required")


@router.get("/bulk-pdf-zip")
async def bulk_invoice_pdf_zip(
    from_date: str = Query(..., description="YYYY-MM-DD inclusive"),
    to_date: str = Query(..., description="YYYY-MM-DD inclusive"),
    current_user: dict = Depends(get_current_user),
):
    _require_admin(current_user)

    # ---- Validate inputs --------------------------------------------------
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

    # ---- Showroom restriction for non-super-admin -------------------------
    db = get_db()
    query: dict = {"created_at": {"$gte": start.isoformat(), "$lt": end_exclusive.isoformat()}}
    role = (current_user or {}).get("role")
    if role != "super_admin":
        sid = (current_user or {}).get("showroom_id")
        if sid:
            query["showroom_id"] = sid

    # ---- Fetch + safety cap ------------------------------------------------
    invoices = await db.invoices.find(query, {"_id": 0}).sort("created_at", 1).to_list(MAX_INVOICES_PER_ZIP + 1)
    if not invoices:
        raise HTTPException(404, f"No invoices found between {from_date} and {to_date}.")
    if len(invoices) > MAX_INVOICES_PER_ZIP:
        raise HTTPException(
            400,
            f"Too many invoices ({len(invoices)}) — capped at {MAX_INVOICES_PER_ZIP} per ZIP. "
            f"Please narrow the date range and try again.",
        )

    # ---- Showroom hydration (one lookup, all invoices) ---------------------
    showroom_ids = list({inv.get("showroom_id") for inv in invoices if inv.get("showroom_id")})
    showrooms_map: dict = {}
    if showroom_ids:
        async for sr in db.showrooms.find({"id": {"$in": showroom_ids}}, {"_id": 0}):
            showrooms_map[sr["id"]] = sr

    # ---- Generate ZIP in memory -------------------------------------------
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

        # If anything failed, include a small manifest so the admin
        # can chase the missing ones manually.
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

    buf.seek(0)
    filename = f"invoices_{from_date}_to_{to_date}.zip"
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Invoice-Count": str(succeeded),
            "X-Invoice-Failed": str(len(failed)),
        },
    )


@router.get("/bulk-pdf-zip/count")
async def bulk_invoice_pdf_zip_count(
    from_date: str = Query(...),
    to_date: str = Query(...),
    current_user: dict = Depends(get_current_user),
):
    """Lightweight count endpoint — frontend hits this BEFORE the
    download so the admin sees 'X invoices will be exported' upfront
    and we never start a 500-PDF render the user can't actually use."""
    _require_admin(current_user)
    if not _DATE_RE.match(from_date) or not _DATE_RE.match(to_date):
        raise HTTPException(400, "from_date and to_date must be YYYY-MM-DD")
    start = datetime.strptime(from_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    end_exclusive = datetime.strptime(to_date, "%Y-%m-%d").replace(tzinfo=timezone.utc) + timedelta(days=1)
    if end_exclusive <= start:
        raise HTTPException(400, "to_date must be on or after from_date")

    db = get_db()
    query: dict = {"created_at": {"$gte": start.isoformat(), "$lt": end_exclusive.isoformat()}}
    role = (current_user or {}).get("role")
    if role != "super_admin":
        sid = (current_user or {}).get("showroom_id")
        if sid:
            query["showroom_id"] = sid

    count = await db.invoices.count_documents(query)
    return {
        "count": count,
        "max_per_zip": MAX_INVOICES_PER_ZIP,
        "within_limit": count <= MAX_INVOICES_PER_ZIP,
        "from_date": from_date,
        "to_date": to_date,
    }

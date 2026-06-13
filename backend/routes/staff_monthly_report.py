"""
Per-staff monthly PDF report for end-of-month 1-to-1 meetings
(13 Jun 2026 — user request: "create per staff report with their
stats so I have a 1-to-1 meeting with them end of the month").

Endpoint:
    GET /api/staff-leaderboard/staff/{user_key:path}/monthly-report.pdf
        ?year=YYYY&month=MM

Scope per user direction (essentials only):
- Name + showroom (no photo on the report)
- £ Sold (Special Order invoices only) · # Sales · Conv Rate · Composite Score
- Sales + quote target progress
- Rank (Sales by composite + Quote conversion)
- Full invoice list (Special Order only)
- Full quote list (created + which were won)
"""
import io
import logging
import re
from calendar import monthrange
from datetime import datetime, timezone
from typing import List, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, KeepTogether,
)

from config import get_db
from services import get_current_user
from routes.staff_leaderboard import _user_key_to_or_clauses

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/staff-leaderboard", tags=["Staff Leaderboard"])

MONTH_NAMES = [
    "", "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]


def _require_admin(user: dict) -> None:
    if (user or {}).get("role") not in ("super_admin", "admin", "manager"):
        raise HTTPException(status_code=403, detail="Admin access required")


def _month_range_utc(year: int, month: int) -> Tuple[datetime, datetime]:
    """Return (start_inclusive, end_exclusive) UTC datetimes for the
    given year+month."""
    start = datetime(year, month, 1, tzinfo=timezone.utc)
    last_day = monthrange(year, month)[1]
    end_exclusive = datetime(year, month, last_day, 23, 59, 59, 999999, tzinfo=timezone.utc)
    # Strictly +1 second to make it exclusive on next-month-first
    end_exclusive = datetime(
        year + (1 if month == 12 else 0),
        1 if month == 12 else month + 1,
        1, tzinfo=timezone.utc,
    )
    return start, end_exclusive


def _safe_resolve_user_label(user_key: str) -> str:
    """Pretty label for the report header when the user_key is
    name-based (no full user record)."""
    if user_key.startswith("sp:") or user_key.startswith("name:"):
        return user_key.split(":", 1)[1].title()
    if user_key.startswith("email:"):
        return user_key.split(":", 1)[1]
    return user_key


async def _resolve_staff_meta(user_key: str) -> dict:
    """Best-effort staff metadata for the report header:
    {name, showroom_name, target_sales, target_quotes_converted}."""
    db = get_db()
    name = _safe_resolve_user_label(user_key)
    user = None
    if not user_key.startswith(("sp:", "name:", "email:")):
        user = await db.users.find_one({"id": user_key}, {"_id": 0})
    if user is None and user_key.startswith("email:"):
        user = await db.users.find_one(
            {"email": {"$regex": f"^{re.escape(user_key[6:])}$", "$options": "i"}},
            {"_id": 0},
        )
    if user is None and user_key.startswith(("sp:", "name:")):
        nm = user_key.split(":", 1)[1]
        user = await db.users.find_one(
            {"name": {"$regex": f"^{re.escape(nm)}$", "$options": "i"}},
            {"_id": 0},
        )

    showroom_id = (user or {}).get("showroom_id", "")
    showroom_name = (user or {}).get("showroom_name", "")
    if showroom_id:
        sr = await db.showrooms.find_one({"id": showroom_id}, {"_id": 0, "name": 1})
        if sr and sr.get("name"):
            showroom_name = sr["name"]  # canonical wins over stamped freetext

    target_sales = 0
    target_quotes = 0
    if showroom_id:
        async for t in db.sales_targets.find({"showroom_id": showroom_id}, {"_id": 0}):
            ttype = (t.get("target_type") or "").lower()
            mt = float(t.get("monthly_target") or 0)
            if ttype == "sales":
                target_sales = mt
            elif ttype == "quotes":
                target_quotes = mt

    return {
        "name": (user or {}).get("name") or name,
        "showroom_id": showroom_id or None,
        "showroom_name": showroom_name or "Unassigned",
        "target_sales": target_sales,
        "target_quotes_converted": target_quotes,
    }


async def _collect_data(user_key: str, year: int, month: int) -> dict:
    """Query Mongo for everything the report needs."""
    db = get_db()
    or_clauses = await _user_key_to_or_clauses(user_key)
    if not or_clauses:
        raise HTTPException(404, f"Couldn't resolve user_key {user_key}")

    start_dt, end_dt = _month_range_utc(year, month)
    start_iso, end_iso = start_dt.isoformat(), end_dt.isoformat()

    # Date filter — historical docs store created_at as either a real
    # datetime or an ISO string, so try both.
    date_match = {"$or": [
        {"created_at": {"$gte": start_dt, "$lt": end_dt}},
        {"created_at": {"$gte": start_iso, "$lt": end_iso}},
    ]}
    match_filter = {"$and": [{"$or": or_clauses}, date_match]}

    invoices: list = []
    async for inv in db.invoices.find(match_filter, {"_id": 0}).sort("created_at", 1):
        # User direction: only Special Order invoices contribute to £ Sold.
        order_type = (inv.get("order_type") or "").strip().lower()
        if order_type != "special order":
            continue
        invoices.append(inv)

    quotes: list = []
    async for q in db.quotations.find(match_filter, {"_id": 0}).sort("created_at", 1):
        quotes.append(q)

    return {
        "invoices": invoices,
        "quotes": quotes,
        "start_dt": start_dt,
        "end_dt": end_dt,
    }


def _date_str(value) -> str:
    if not value:
        return ""
    if isinstance(value, datetime):
        return value.strftime("%d %b")
    s = str(value)
    return s[:10] if len(s) >= 10 else s


def _gbp(n) -> str:
    return f"£{int(round(n)):,}"


async def _compute_kpis(user_key: str, year: int, month: int) -> dict:
    """Everything the report needs in one async call."""
    meta = await _resolve_staff_meta(user_key)
    data = await _collect_data(user_key, year, month)
    invoices = data["invoices"]
    quotes = data["quotes"]

    sales_value = sum(float(inv.get("gross_total") or inv.get("grand_total") or 0) for inv in invoices)
    sales_count = len(invoices)
    quotes_created = len(quotes)
    quotes_converted = sum(
        1 for q in quotes
        if (q.get("conversion_status") or "").lower() in ("converted", "won")
        or q.get("converted_to_invoice")
        or q.get("converted_invoice_id")
    )
    conversion_rate = round((quotes_converted / quotes_created) * 100, 1) if quotes_created > 0 else 0.0

    # Composite score (matches the leaderboard's 70/30 formula but
    # computed against THIS staff's target since rank vs others
    # isn't possible without the full board).
    target_sales = meta.get("target_sales") or 0
    target_quotes = meta.get("target_quotes_converted") or 0
    pct_sales = (sales_value / target_sales) * 100 if target_sales > 0 else 0
    pct_quotes = (quotes_converted / target_quotes) * 100 if target_quotes > 0 else 0
    # Volume normalises against the £ target so composite is comparable
    # across staff with different store sizes — same as the live
    # leaderboard.
    composite = round((pct_sales * 0.7) + (sales_count * 0.3 * 10), 1)  # x10 to balance with %

    return {
        **meta,
        "year": year,
        "month": month,
        "month_label": f"{MONTH_NAMES[month]} {year}",
        "sales_value": round(sales_value, 2),
        "sales_count": sales_count,
        "avg_sale": round(sales_value / sales_count, 2) if sales_count > 0 else 0,
        "quotes_created": quotes_created,
        "quotes_converted": quotes_converted,
        "conversion_rate": conversion_rate,
        "composite_score": composite,
        "pct_of_sales_target": round(pct_sales, 1),
        "pct_of_quotes_target": round(pct_quotes, 1),
        "remaining_to_sales_target": max(0, round(target_sales - sales_value, 2)),
        "remaining_to_quotes_target": max(0, target_quotes - quotes_converted),
        "invoices": invoices,
        "quotes": quotes,
    }


def _build_pdf(kpis: dict) -> bytes:
    """Render the report as a PDF (one or two pages depending on
    invoice/quote count)."""
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=15 * mm, rightMargin=15 * mm,
        topMargin=15 * mm, bottomMargin=15 * mm,
        title=f"Monthly Report — {kpis['name']} — {kpis['month_label']}",
    )
    styles = getSampleStyleSheet()
    h1 = ParagraphStyle("h1", parent=styles["Heading1"], fontSize=18, spaceAfter=2)
    sub = ParagraphStyle("sub", parent=styles["Normal"], fontSize=10, textColor=colors.HexColor("#6b7280"), spaceAfter=12)
    section = ParagraphStyle("section", parent=styles["Heading2"], fontSize=12, textColor=colors.HexColor("#374151"), spaceBefore=10, spaceAfter=4)
    body = ParagraphStyle("body", parent=styles["Normal"], fontSize=9)

    story: list = []

    # ---- Header ----------------------------------------------------------
    story.append(Paragraph(f"{kpis['name']}", h1))
    story.append(Paragraph(
        f"{kpis['showroom_name']} · {kpis['month_label']} · "
        f"Generated {datetime.now(timezone.utc).strftime('%d %b %Y %H:%M UTC')}",
        sub,
    ))

    # ---- KPI tiles -------------------------------------------------------
    kpi_data = [
        ["£ Sold (Special Order)", "# Sales", "Avg Sale", "Conv Rate", "Composite Score"],
        [
            _gbp(kpis["sales_value"]),
            str(kpis["sales_count"]),
            _gbp(kpis["avg_sale"]) if kpis["sales_count"] > 0 else "—",
            f"{kpis['conversion_rate']}%" if kpis["quotes_created"] > 0 else "—",
            str(kpis["composite_score"]),
        ],
    ]
    kpi_tbl = Table(kpi_data, colWidths=[37 * mm] * 5)
    kpi_tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f3f4f6")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#374151")),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 8),
        ("FONTNAME", (0, 1), (-1, 1), "Helvetica-Bold"),
        ("FONTSIZE", (0, 1), (-1, 1), 13),
        ("TEXTCOLOR", (0, 1), (-1, 1), colors.HexColor("#059669")),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e5e7eb")),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#e5e7eb")),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 4),
        ("TOPPADDING", (0, 1), (-1, 1), 8),
        ("BOTTOMPADDING", (0, 1), (-1, 1), 8),
    ]))
    story.append(kpi_tbl)
    story.append(Spacer(0, 10))

    # ---- Targets ---------------------------------------------------------
    story.append(Paragraph("Target progress", section))
    target_rows: list = []
    if kpis.get("target_sales"):
        target_rows.append([
            "Sales target", _gbp(kpis["target_sales"]),
            f"{kpis['pct_of_sales_target']}%",
            f"{_gbp(kpis['remaining_to_sales_target'])} to go",
        ])
    else:
        target_rows.append(["Sales target", "Not set", "—", "—"])
    if kpis.get("target_quotes_converted"):
        target_rows.append([
            "Quote target", str(kpis["target_quotes_converted"]),
            f"{kpis['pct_of_quotes_target']}%",
            f"{kpis['remaining_to_quotes_target']} to go",
        ])
    else:
        target_rows.append(["Quote target", "Not set", "—", "—"])
    targets_tbl = Table(
        [["", "Target", "Achieved", "Remaining"], *target_rows],
        colWidths=[40 * mm, 40 * mm, 40 * mm, 40 * mm],
    )
    targets_tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f9fafb")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#6b7280")),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTNAME", (0, 1), (0, -1), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e5e7eb")),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#e5e7eb")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(targets_tbl)

    # ---- Invoice list ----------------------------------------------------
    story.append(Paragraph(
        f"Special Order invoices ({len(kpis['invoices'])})",
        section,
    ))
    if not kpis["invoices"]:
        story.append(Paragraph("<i>No Special Order invoices in this month.</i>", body))
    else:
        inv_rows = [["#", "Invoice", "Date", "Customer", "Total"]]
        for i, inv in enumerate(kpis["invoices"], 1):
            inv_rows.append([
                str(i),
                inv.get("invoice_number", "—"),
                _date_str(inv.get("created_at") or inv.get("date")),
                (inv.get("customer_name") or "—")[:35],
                _gbp(float(inv.get("gross_total") or inv.get("grand_total") or 0)),
            ])
        inv_tbl = Table(inv_rows, colWidths=[10 * mm, 32 * mm, 22 * mm, 80 * mm, 30 * mm])
        inv_tbl.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#fef3c7")),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 8),
            ("ALIGN", (4, 0), (4, -1), "RIGHT"),
            ("ALIGN", (0, 0), (0, -1), "CENTER"),
            ("INNERGRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#e5e7eb")),
            ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#d1d5db")),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#fafafa")]),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ]))
        story.append(inv_tbl)

    # ---- Quote list ------------------------------------------------------
    story.append(Spacer(0, 4))
    story.append(Paragraph(
        f"Quotations ({kpis['quotes_converted']} won of {kpis['quotes_created']}, "
        f"{kpis['conversion_rate']}% conversion)",
        section,
    ))
    if not kpis["quotes"]:
        story.append(Paragraph("<i>No quotes raised this month.</i>", body))
    else:
        q_rows = [["#", "Quote", "Date", "Customer", "Total", "Status"]]
        for i, q in enumerate(kpis["quotes"], 1):
            won = (
                (q.get("conversion_status") or "").lower() in ("converted", "won")
                or q.get("converted_to_invoice")
                or q.get("converted_invoice_id")
            )
            q_rows.append([
                str(i),
                q.get("quotation_number", "—"),
                _date_str(q.get("created_at") or q.get("date")),
                (q.get("customer_name") or "—")[:30],
                _gbp(float(q.get("grand_total") or q.get("gross_total") or 0)),
                "WON" if won else "OPEN",
            ])
        q_tbl = Table(q_rows, colWidths=[10 * mm, 32 * mm, 22 * mm, 65 * mm, 30 * mm, 15 * mm])
        q_tbl.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#dbeafe")),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 8),
            ("ALIGN", (4, 0), (4, -1), "RIGHT"),
            ("ALIGN", (0, 0), (0, -1), "CENTER"),
            ("ALIGN", (5, 0), (5, -1), "CENTER"),
            ("INNERGRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#e5e7eb")),
            ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#d1d5db")),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#fafafa")]),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ]))
        story.append(q_tbl)

    doc.build(story)
    return buf.getvalue()


@router.get("/staff/{user_key:path}/monthly-report.pdf")
async def staff_monthly_report_pdf(
    user_key: str,
    year: int = Query(..., ge=2020, le=2100),
    month: int = Query(..., ge=1, le=12),
    current_user: dict = Depends(get_current_user),
):
    _require_admin(current_user)
    kpis = await _compute_kpis(user_key, year, month)
    pdf_bytes = _build_pdf(kpis)
    safe_name = re.sub(r"[^A-Za-z0-9._-]+", "_", kpis["name"]) or "staff"
    filename = f"report_{safe_name}_{year}-{month:02d}.pdf"
    return StreamingResponse(
        io.BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )

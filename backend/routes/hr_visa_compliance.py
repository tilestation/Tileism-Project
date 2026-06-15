"""
HR Visa Compliance (13 Jun 2026).

Built in response to a UK Home Office sponsor-licence compliance
request: "Please also provide evidence of how you monitor the length
of their visa(s)."

This module turns the HR Documents store into audit-grade evidence:

    GET  /api/hr/visa-compliance/report                — JSON for UI
    GET  /api/hr/visa-compliance/report.pdf            — printable PDF for HO submission
    POST /api/hr/visa-compliance/{employee_id}/review  — log a right-to-work re-check
    GET  /api/hr/visa-compliance/{employee_id}/reviews — review history

The report covers every employee who has at least one document with
category in {"visa", "right_to_work"}. For each:

    - Most recent visa/right-to-work doc + expiry date + days_until_expiry
    - Status: VALID / EXPIRING_SOON / EXPIRED / NO_EXPIRY_RECORDED
    - Last review entry (when, by whom, share code used, notes)
    - Reminder thresholds already crossed (so the audit shows we noticed)

Reviewed-at log lives in `db.hr_visa_reviews`. One row per check; never
deleted (compliance history must be permanent).
"""
import io
import logging
import uuid
from datetime import date, datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from config import get_db
from services import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/hr/visa-compliance", tags=["HR"])

VISA_DOC_CATEGORIES = {"visa", "right_to_work"}
EXPIRING_SOON_DAYS = 90
CRITICAL_DAYS = 30


# ─── Models ──────────────────────────────────────────────────────────
class VisaReviewIn(BaseModel):
    """A right-to-work re-check by the HR team."""
    review_method: str = Field(
        ...,
        description="One of: in_person | share_code | passport_inspection | other",
    )
    share_code: Optional[str] = Field(None, max_length=20, description="9-char share code if used")
    visa_type: Optional[str] = Field(None, max_length=80, description="e.g. Skilled Worker, Graduate, ILR")
    valid_until: Optional[str] = Field(None, description="YYYY-MM-DD — when the Home Office said the right-to-work expires")
    notes: Optional[str] = Field(None, max_length=1000)


VALID_REVIEW_METHODS = {"in_person", "share_code", "passport_inspection", "other"}


# ─── Auth ────────────────────────────────────────────────────────────
def _is_hr_admin(user: dict) -> bool:
    return (user or {}).get("role") in {"super_admin", "hr_admin"}


def _require_hr_admin(user: dict) -> None:
    if not _is_hr_admin(user):
        raise HTTPException(403, "HR admin only")


# ─── Helpers ─────────────────────────────────────────────────────────
def _classify(expiry_iso: Optional[str]) -> tuple:
    """Return (status_label, days_until_expiry_or_None)."""
    if not expiry_iso:
        return ("NO_EXPIRY_RECORDED", None)
    try:
        d = datetime.strptime(expiry_iso, "%Y-%m-%d").date()
    except ValueError:
        return ("NO_EXPIRY_RECORDED", None)
    days = (d - date.today()).days
    if days < 0:
        return ("EXPIRED", days)
    if days <= CRITICAL_DAYS:
        return ("EXPIRING_SOON", days)
    if days <= EXPIRING_SOON_DAYS:
        return ("WATCH", days)
    return ("VALID", days)


async def _most_recent_visa_doc(db, employee_id: str) -> Optional[dict]:
    """Pick the most-recently-uploaded visa/right-to-work doc per employee.
    The newest one is the one that's currently in effect."""
    cur = db.hr_documents.find(
        {"employee_id": employee_id, "category": {"$in": list(VISA_DOC_CATEGORIES)}},
        {"_id": 0, "file_b64": 0},
    ).sort("uploaded_at", -1)
    rows = await cur.to_list(1)
    return rows[0] if rows else None


async def _latest_review(db, employee_id: str) -> Optional[dict]:
    rev = await db.hr_visa_reviews.find_one(
        {"employee_id": employee_id},
        {"_id": 0},
        sort=[("reviewed_at", -1)],
    )
    return rev


async def _alerts_sent_for_doc(db, document_id: str) -> List[dict]:
    """Threshold-alert log for a given visa document — proof we acted
    each time the doc crossed 90/60/30/7 days."""
    cur = db.hr_visa_alerts.find(
        {"document_id": document_id},
        {"_id": 0},
    ).sort("alerted_at", 1)
    return await cur.to_list(50)


# ─── Endpoints ───────────────────────────────────────────────────────
@router.get("/report")
async def visa_compliance_report(
    include_unsponsored: bool = False,
    current_user: dict = Depends(get_current_user),
):
    """Returns the full audit-grade view: every employee who needs a
    visa check, their current status, last review and alert history.

    Set `include_unsponsored=True` to include employees with no visa
    documents at all (rare — only for completeness checks)."""
    _require_hr_admin(current_user)
    db = get_db()

    # Active employees
    employees = await db.hr_employees.find(
        {"archived_at": {"$exists": False}},
        {"_id": 0, "id": 1, "first_name": 1, "last_name": 1,
         "employee_number": 1, "job_title": 1, "showroom_id": 1, "nationality": 1},
    ).sort("last_name", 1).to_list(2000)

    rows: List[dict] = []
    summary = {
        "total_sponsored": 0,
        "valid": 0, "watch": 0, "expiring_soon": 0, "expired": 0,
        "no_expiry_recorded": 0, "never_reviewed": 0,
    }
    today_iso = date.today().isoformat()

    for emp in employees:
        doc = await _most_recent_visa_doc(db, emp["id"])
        review = await _latest_review(db, emp["id"])
        if not doc and not review and not include_unsponsored:
            continue
        if doc:
            summary["total_sponsored"] += 1
        status, days = _classify(doc.get("expiry_date") if doc else None)
        if doc:
            summary[status.lower()] = summary.get(status.lower(), 0) + 1
        if not review:
            summary["never_reviewed"] += 1

        alerts = await _alerts_sent_for_doc(db, doc["id"]) if doc else []
        rows.append({
            "employee_id": emp["id"],
            "employee_number": emp.get("employee_number"),
            "name": f"{emp.get('first_name', '')} {emp.get('last_name', '')}".strip(),
            "job_title": emp.get("job_title"),
            "nationality": emp.get("nationality"),
            "showroom_id": emp.get("showroom_id"),
            "document": {
                "id": doc.get("id") if doc else None,
                "title": doc.get("title") if doc else None,
                "category": doc.get("category") if doc else None,
                "uploaded_at": doc.get("uploaded_at") if doc else None,
                "uploaded_by": doc.get("uploaded_by") if doc else None,
                "expiry_date": doc.get("expiry_date") if doc else None,
                "visa_type": (doc.get("visa_meta") or {}).get("visa_type") if doc else None,
                "share_code": (doc.get("visa_meta") or {}).get("share_code") if doc else None,
                "cos_number": (doc.get("visa_meta") or {}).get("cos_number") if doc else None,
            },
            "status": status,
            "days_until_expiry": days,
            "last_review": review,
            "alerts_sent": alerts,
        })
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "generated_for": today_iso,
        "summary": summary,
        "employees": rows,
        "policy_statement": (
            "Tile Station Ltd maintains an automated monitoring system for all sponsored "
            "workers' right-to-work documents. The system records each visa document's "
            "expiry date and issues reminder alerts to HR at 90, 60, 30 and 7 calendar "
            "days before expiry. HR is required to physically re-verify each sponsored "
            "worker's status at each renewal point and at minimum every 12 months. All "
            "checks are recorded in a permanent audit log (this report is generated from "
            "that log)."
        ),
    }


@router.get("/report.pdf")
async def visa_compliance_report_pdf(current_user: dict = Depends(get_current_user)):
    """Single-click audit-evidence PDF for Home Office submission.

    Includes:
      • Cover with policy statement + generated date + generated by
      • Summary stats
      • Per-employee table (name + employee # + visa type + expiry + status + last review)
      • Per-employee expanded panels for those EXPIRED or EXPIRING_SOON
      • Generated-by signature line at the foot
    """
    _require_hr_admin(current_user)
    # Render same data as /report but feed it through ReportLab.
    report = await visa_compliance_report(current_user=current_user)

    # Lazy-import reportlab — heavy module + not needed for the JSON route.
    from reportlab.lib.pagesizes import A4  # noqa: PLC0415
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle  # noqa: PLC0415
    from reportlab.lib.units import mm  # noqa: PLC0415
    from reportlab.lib import colors  # noqa: PLC0415
    from reportlab.platypus import (  # noqa: PLC0415
        SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak,
    )

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=15 * mm, rightMargin=15 * mm,
        topMargin=15 * mm, bottomMargin=15 * mm,
        title="Visa Compliance Report — Tile Station Ltd",
    )
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "Title", parent=styles["Heading1"], fontSize=18,
        textColor=colors.HexColor("#1e293b"), spaceAfter=4,
    )
    sub_style = ParagraphStyle(
        "Sub", parent=styles["Normal"], fontSize=9,
        textColor=colors.HexColor("#64748b"), spaceAfter=12,
    )
    body_style = ParagraphStyle(
        "Body", parent=styles["Normal"], fontSize=9, leading=13,
    )
    h2_style = ParagraphStyle(
        "H2", parent=styles["Heading2"], fontSize=12,
        textColor=colors.HexColor("#1e293b"), spaceBefore=10, spaceAfter=6,
    )

    story = []
    story.append(Paragraph("Visa Compliance Report", title_style))
    story.append(Paragraph(
        f"Tile Station Ltd &nbsp;·&nbsp; Generated {datetime.now(timezone.utc).strftime('%d %b %Y, %H:%M UTC')} "
        f"by {(current_user or {}).get('email', 'system')}",
        sub_style,
    ))

    # Policy statement
    story.append(Paragraph("Monitoring Policy Statement", h2_style))
    story.append(Paragraph(report["policy_statement"], body_style))

    # Summary
    story.append(Paragraph("Summary", h2_style))
    s = report["summary"]
    summary_data = [
        ["Total monitored workers", str(s["total_sponsored"])],
        ["Valid (>90 days remaining)", str(s.get("valid", 0))],
        ["Watch (31–90 days)", str(s.get("watch", 0))],
        ["Expiring soon (≤30 days)", str(s.get("expiring_soon", 0))],
        ["Expired", str(s.get("expired", 0))],
        ["No expiry date on file", str(s.get("no_expiry_recorded", 0))],
        ["Never reviewed (no audit entry)", str(s["never_reviewed"])],
    ]
    summary_tbl = Table(summary_data, colWidths=[90 * mm, 40 * mm])
    summary_tbl.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("ROWBACKGROUNDS", (0, 0), (-1, -1), [colors.HexColor("#f1f5f9"), colors.white]),
        ("LINEBELOW", (0, 0), (-1, -1), 0.25, colors.HexColor("#cbd5e1")),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(summary_tbl)

    # Employee table
    story.append(Paragraph("Sponsored Workers — Current Status", h2_style))
    headers = ["#", "Name", "Visa type", "Expiry", "Status", "Last check"]
    table_rows = [headers]
    for emp in report["employees"]:
        d = emp.get("document") or {}
        rev = emp.get("last_review") or {}
        last_review_str = (
            (rev.get("reviewed_at") or "")[:10]
            + (f" — {rev.get('reviewer_email', '?')}" if rev else "")
        )
        days = emp.get("days_until_expiry")
        days_str = "—" if days is None else f"{days} days"
        table_rows.append([
            emp.get("employee_number", "—"),
            emp.get("name", "—"),
            d.get("visa_type") or "—",
            (d.get("expiry_date") or "—") + (f"\n({days_str})" if days is not None else ""),
            emp.get("status", "—").replace("_", " "),
            last_review_str or "NEVER",
        ])
    emp_tbl = Table(table_rows, colWidths=[18 * mm, 38 * mm, 30 * mm, 28 * mm, 30 * mm, 36 * mm], repeatRows=1)
    style_cmds = [
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1e293b")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEBELOW", (0, 0), (-1, -1), 0.25, colors.HexColor("#cbd5e1")),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]
    # Status-coloured rows
    for idx, emp in enumerate(report["employees"], start=1):
        status = emp.get("status")
        if status == "EXPIRED":
            style_cmds.append(("BACKGROUND", (4, idx), (4, idx), colors.HexColor("#fecaca")))
        elif status == "EXPIRING_SOON":
            style_cmds.append(("BACKGROUND", (4, idx), (4, idx), colors.HexColor("#fde68a")))
        elif status == "WATCH":
            style_cmds.append(("BACKGROUND", (4, idx), (4, idx), colors.HexColor("#fef3c7")))
        elif status == "VALID":
            style_cmds.append(("BACKGROUND", (4, idx), (4, idx), colors.HexColor("#d1fae5")))
    emp_tbl.setStyle(TableStyle(style_cmds))
    story.append(emp_tbl)

    # Detail pages for any at-risk visas
    at_risk = [e for e in report["employees"] if e.get("status") in {"EXPIRED", "EXPIRING_SOON"}]
    if at_risk:
        story.append(PageBreak())
        story.append(Paragraph("Detail — workers requiring action", h2_style))
        for emp in at_risk:
            story.append(Paragraph(
                f"<b>{emp['name']}</b> ({emp['employee_number']}) — {emp.get('job_title') or ''}",
                body_style,
            ))
            d = emp.get("document") or {}
            story.append(Paragraph(
                f"Document: {d.get('title') or '—'} · "
                f"Uploaded {d.get('uploaded_at', '')[:10]} by {d.get('uploaded_by', '')}",
                body_style,
            ))
            story.append(Paragraph(
                f"Expires: <b>{d.get('expiry_date') or '—'}</b> "
                f"({emp.get('days_until_expiry')} days) · "
                f"Status: <b>{emp.get('status', '').replace('_', ' ')}</b>",
                body_style,
            ))
            alerts = emp.get("alerts_sent") or []
            if alerts:
                story.append(Paragraph("Reminder alerts already issued:", body_style))
                for a in alerts:
                    story.append(Paragraph(
                        f"&nbsp;&nbsp;• {a.get('threshold_days')}-day notice on "
                        f"{a.get('alerted_at', '')[:10]} → {a.get('recipients', '')}",
                        body_style,
                    ))
            rev = emp.get("last_review")
            if rev:
                story.append(Paragraph(
                    f"Last review: {rev.get('reviewed_at', '')[:10]} by "
                    f"{rev.get('reviewer_email', '?')} — method: {rev.get('review_method', '?')}"
                    + (f", share code {rev.get('share_code')}" if rev.get('share_code') else ""),
                    body_style,
                ))
            else:
                story.append(Paragraph("Last review: NEVER", body_style))
            story.append(Spacer(1, 6))

    # Sign-off footer
    story.append(Spacer(1, 24))
    story.append(Paragraph(
        f"Generated by: {(current_user or {}).get('email', 'system')}<br/>"
        f"Date: {datetime.now(timezone.utc).strftime('%d %b %Y, %H:%M UTC')}<br/>"
        f"Tile Station Ltd — sponsor licence holder",
        sub_style,
    ))

    doc.build(story)
    pdf_bytes = buf.getvalue()
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": 'attachment; filename="visa_compliance_report.pdf"'},
    )


@router.post("/{employee_id}/review")
async def record_visa_review(
    employee_id: str,
    payload: VisaReviewIn,
    current_user: dict = Depends(get_current_user),
):
    """Log a right-to-work re-check. Append-only — the row is never
    edited or deleted (compliance history must be permanent)."""
    _require_hr_admin(current_user)
    if payload.review_method not in VALID_REVIEW_METHODS:
        raise HTTPException(400, f"review_method must be one of {sorted(VALID_REVIEW_METHODS)}")
    db = get_db()
    emp = await db.hr_employees.find_one({"id": employee_id, "archived_at": {"$exists": False}}, {"_id": 0})
    if not emp:
        raise HTTPException(404, "Employee not found")
    if payload.valid_until:
        try:
            datetime.strptime(payload.valid_until, "%Y-%m-%d")
        except ValueError as e:
            raise HTTPException(400, f"Invalid valid_until: {e}") from e
    now_iso = datetime.now(timezone.utc).isoformat()
    doc = {
        "id": str(uuid.uuid4()),
        "employee_id": employee_id,
        "reviewed_at": now_iso,
        "reviewer_user_id": (current_user or {}).get("id"),
        "reviewer_email": (current_user or {}).get("email", "system"),
        "review_method": payload.review_method,
        "share_code": (payload.share_code or "").strip().upper() or None,
        "visa_type": (payload.visa_type or "").strip() or None,
        "valid_until": payload.valid_until,
        "notes": (payload.notes or "").strip() or None,
    }
    await db.hr_visa_reviews.insert_one(dict(doc))
    return doc


@router.get("/{employee_id}/reviews")
async def list_visa_reviews(
    employee_id: str,
    current_user: dict = Depends(get_current_user),
):
    _require_hr_admin(current_user)
    db = get_db()
    cur = db.hr_visa_reviews.find(
        {"employee_id": employee_id},
        {"_id": 0},
    ).sort("reviewed_at", -1)
    return await cur.to_list(200)

"""
HR Visa Compliance (13 Jun 2026).

Built in response to a UK Home Office sponsor-licence compliance
request: "Please also provide evidence of how you monitor the length
of their visa(s)."

This module turns the HR Documents store into audit-grade evidence:

    GET  /api/hr/visa-compliance/report                — JSON for UI
    GET  /api/hr/visa-compliance/report.pdf            — printable PDF for HO submission
    GET  /api/hr/visa-compliance/policy.pdf            — Monitoring System Overview + Written HR Policy
    GET  /api/hr/visa-compliance/baseline/status       — has a baseline review been completed?
    POST /api/hr/visa-compliance/baseline              — bulk-log today's right-to-work re-check for every employee
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


# ─── Baseline review (Feb 2026) ──────────────────────────────────────
# For sponsor-licence applicants who DIDN'T have a formal monitoring
# system before. The baseline lets them honestly attest "as of TODAY,
# we've checked every existing worker's right-to-work and started the
# audit clock" — no backdating. Each employee gets a single permanent
# `hr_visa_reviews` row stamped with TODAY (not historical dates), so
# the audit trail starts cleanly with full transparency.

class BaselineEmployeeEntry(BaseModel):
    employee_id: str
    review_method: str
    share_code: Optional[str] = Field(None, max_length=20)
    visa_type: Optional[str] = Field(None, max_length=80)
    valid_until: Optional[str] = None
    notes: Optional[str] = Field(None, max_length=1000)


class BaselineReviewIn(BaseModel):
    """Bulk attestation. The user clicks one button after walking
    through the wizard and a single review row is inserted PER
    entry — all timestamped now (UTC), all stamped with the same
    `baseline_session_id` so they can be retrieved as a group."""
    entries: List[BaselineEmployeeEntry] = Field(..., min_length=1)
    overview_acknowledged: bool = Field(
        ...,
        description="The reviewer has read and accepts the Monitoring System Overview",
    )


@router.get("/baseline/status")
async def baseline_status(current_user: dict = Depends(get_current_user)):
    """Lightweight status check: has a baseline review session ever
    been recorded? Used by the wizard to decide which step to land
    on (intro vs. already-completed summary)."""
    _require_hr_admin(current_user)
    db = get_db()
    latest = await db.hr_baseline_reviews.find_one(
        {},
        {"_id": 0},
        sort=[("completed_at", -1)],
    )
    # Also count current sponsored workers so the UI can show "X of Y
    # employees verified in the baseline" without a second round trip.
    total_active = await db.hr_employees.count_documents({"archived_at": {"$exists": False}})
    employees_with_visa = await db.hr_documents.distinct(
        "employee_id",
        {"category": {"$in": list(VISA_DOC_CATEGORIES)}},
    )
    return {
        "completed": latest is not None,
        "latest": latest,
        "active_employee_count": total_active,
        "sponsored_employee_count": len(employees_with_visa),
    }


@router.post("/baseline")
async def record_baseline_review(
    payload: BaselineReviewIn,
    current_user: dict = Depends(get_current_user),
):
    """One-shot endpoint that:
      1. Validates the reviewer has acknowledged the Monitoring System Overview.
      2. Inserts ONE `hr_visa_reviews` row per entry (permanent — same as
         the regular re-check audit row).
      3. Inserts ONE `hr_baseline_reviews` summary row tying them all
         together. This row is what `baseline/status` reads from.

    All timestamps are NOW — never backdated. The endpoint refuses to
    accept any `reviewed_at` field from the client to enforce that.
    """
    _require_hr_admin(current_user)
    if not payload.overview_acknowledged:
        raise HTTPException(
            400,
            "You must acknowledge the Monitoring System Overview before recording the baseline.",
        )
    db = get_db()

    # Validate every entry references an existing, non-archived employee.
    employee_ids = [e.employee_id for e in payload.entries]
    employees = await db.hr_employees.find(
        {"id": {"$in": employee_ids}, "archived_at": {"$exists": False}},
        {"_id": 0, "id": 1, "first_name": 1, "last_name": 1, "employee_number": 1},
    ).to_list(len(employee_ids))
    by_id = {e["id"]: e for e in employees}
    missing = [eid for eid in employee_ids if eid not in by_id]
    if missing:
        raise HTTPException(404, f"Unknown / archived employee_id(s): {missing[:5]}")

    now_iso = datetime.now(timezone.utc).isoformat()
    session_id = str(uuid.uuid4())
    review_docs = []
    for entry in payload.entries:
        if entry.review_method not in VALID_REVIEW_METHODS:
            raise HTTPException(
                400,
                f"entry {entry.employee_id}: review_method must be one of {sorted(VALID_REVIEW_METHODS)}",
            )
        if entry.valid_until:
            try:
                datetime.strptime(entry.valid_until, "%Y-%m-%d")
            except ValueError as e:
                raise HTTPException(
                    400, f"entry {entry.employee_id}: invalid valid_until: {e}") from e
        review_docs.append({
            "id": str(uuid.uuid4()),
            "employee_id": entry.employee_id,
            "reviewed_at": now_iso,
            "reviewer_user_id": (current_user or {}).get("id"),
            "reviewer_email": (current_user or {}).get("email", "system"),
            "review_method": entry.review_method,
            "share_code": (entry.share_code or "").strip().upper() or None,
            "visa_type": (entry.visa_type or "").strip() or None,
            "valid_until": entry.valid_until,
            "notes": (entry.notes or "").strip() or None,
            "baseline_session_id": session_id,
        })

    if review_docs:
        await db.hr_visa_reviews.insert_many([dict(d) for d in review_docs])

    summary = {
        "id": session_id,
        "completed_at": now_iso,
        "completed_by_user_id": (current_user or {}).get("id"),
        "completed_by_email": (current_user or {}).get("email", "system"),
        "employees_reviewed": len(review_docs),
        "employee_ids": employee_ids,
        "overview_acknowledged": True,
    }
    await db.hr_baseline_reviews.insert_one(dict(summary))

    return {
        "session": summary,
        "reviews": review_docs,
    }


# ─── Monitoring System Overview + Written HR Policy PDF ──────────────
# A standalone audit-safe document — the artefact the user attaches to
# their Sponsor Licence application as "evidence of how you monitor the
# length of their visa(s)". Contrast with the existing `report.pdf`
# which is a *historical* alert log; this PDF describes the SYSTEM and
# is signed by the named Authorising Officer.

@router.get("/policy.pdf")
async def visa_monitoring_policy_pdf(current_user: dict = Depends(get_current_user)):
    """Returns the "Visa Monitoring System Overview & Written HR
    Policy" PDF.

    Structure:
      1. Cover — company name, sponsor licence #, AO signature line, effective date.
      2. Policy statement — the written commitment.
      3. Monitoring methodology — the technical 90/60/30/7 day ladder.
      4. Baseline review attestation — if completed, when + by whom + count.
      5. Current sponsored worker snapshot — name + visa expiry + last review.
      6. Sign-off footer — generated date + Authorising Officer name/email.
    """
    _require_hr_admin(current_user)
    db = get_db()

    # Pull settings, baseline status, and current report.
    settings_doc = await db.hr_settings.find_one({"id": "default"}, {"_id": 0}) or {}
    baseline = await db.hr_baseline_reviews.find_one(
        {},
        {"_id": 0},
        sort=[("completed_at", -1)],
    )
    report = await visa_compliance_report(current_user=current_user)

    company_name = (settings_doc.get("company_name") or "Tile Station Ltd").strip()
    licence_no = (settings_doc.get("sponsor_licence_number") or "").strip() or "— (application pending)"
    licence_status = (settings_doc.get("sponsor_licence_status") or "applying").replace("_", " ")
    address = (settings_doc.get("registered_address") or "").strip()
    ao = settings_doc.get("authorising_officer") or {}
    ao_name = (ao.get("name") or "").strip() or "— (not configured)"
    ao_title = (ao.get("job_title") or "").strip() or "Authorising Officer"
    ao_email = (ao.get("email") or "").strip()
    effective_date = (settings_doc.get("policy_effective_date") or date.today().isoformat())

    from reportlab.lib.pagesizes import A4  # noqa: PLC0415
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle  # noqa: PLC0415
    from reportlab.lib.units import mm  # noqa: PLC0415
    from reportlab.lib import colors  # noqa: PLC0415
    from reportlab.platypus import (  # noqa: PLC0415
        SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, KeepTogether,
    )

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=18 * mm, rightMargin=18 * mm,
        topMargin=18 * mm, bottomMargin=18 * mm,
        title=f"Visa Monitoring Policy — {company_name}",
        author=ao_name,
    )
    styles = getSampleStyleSheet()
    cover_title = ParagraphStyle(
        "CoverTitle", parent=styles["Heading1"], fontSize=22,
        textColor=colors.HexColor("#0f172a"), spaceAfter=6, leading=28,
    )
    cover_sub = ParagraphStyle(
        "CoverSub", parent=styles["Normal"], fontSize=11,
        textColor=colors.HexColor("#475569"), spaceAfter=4, leading=15,
    )
    h2 = ParagraphStyle(
        "H2", parent=styles["Heading2"], fontSize=13,
        textColor=colors.HexColor("#1e293b"), spaceBefore=12, spaceAfter=6,
    )
    body = ParagraphStyle(
        "Body", parent=styles["Normal"], fontSize=10, leading=14,
        textColor=colors.HexColor("#0f172a"),
    )
    quote = ParagraphStyle(
        "Quote", parent=body, fontSize=10, leftIndent=12, rightIndent=12,
        textColor=colors.HexColor("#1e293b"), spaceBefore=6, spaceAfter=6,
        backColor=colors.HexColor("#eef2ff"), borderPadding=8,
    )
    foot = ParagraphStyle(
        "Foot", parent=styles["Normal"], fontSize=9,
        textColor=colors.HexColor("#64748b"), leading=13,
    )

    story = []
    # ─── Cover ───────────────────────────────────────────────────────
    story.append(Paragraph("Visa Monitoring System Overview &amp; Written HR Policy", cover_title))
    story.append(Paragraph(company_name, cover_sub))
    if address:
        story.append(Paragraph(address.replace("\n", "<br/>"), cover_sub))
    story.append(Spacer(1, 8))
    cover_data = [
        ["Sponsor Licence #", licence_no],
        ["Sponsor Licence status", licence_status.capitalize()],
        ["Policy effective from", effective_date],
        ["Authorising Officer", f"{ao_name} — {ao_title}"],
        ["AO contact", ao_email or "—"],
        ["Generated", datetime.now(timezone.utc).strftime("%d %b %Y, %H:%M UTC")],
    ]
    cover_tbl = Table(cover_data, colWidths=[55 * mm, 110 * mm])
    cover_tbl.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("TEXTCOLOR", (0, 0), (0, -1), colors.HexColor("#334155")),
        ("ROWBACKGROUNDS", (0, 0), (-1, -1), [colors.HexColor("#f8fafc"), colors.white]),
        ("LINEBELOW", (0, 0), (-1, -1), 0.25, colors.HexColor("#e2e8f0")),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    story.append(cover_tbl)

    # ─── 1. Policy statement ─────────────────────────────────────────
    story.append(Paragraph("1. Policy Statement", h2))
    story.append(Paragraph(
        f"{company_name} (\"the Company\") is committed to complying fully with its "
        f"duties as a sponsor under the UK&rsquo;s points-based immigration system. "
        f"The Company will only employ workers who hold valid permission to work in the "
        f"United Kingdom and will actively monitor the duration of every sponsored "
        f"worker&rsquo;s permission to remain.",
        body,
    ))
    story.append(Paragraph(
        "The Authorising Officer named above is responsible for ensuring this policy is "
        "implemented and reviewed on at least an annual basis.",
        body,
    ))

    # ─── 2. Monitoring methodology ───────────────────────────────────
    story.append(Paragraph("2. Monitoring Methodology", h2))
    story.append(Paragraph(
        "Each worker&rsquo;s right-to-work documentation is uploaded to the Company&rsquo;s "
        "HR system at the point of hire. The system records the document&rsquo;s expiry date "
        "and runs an automated check once per UTC day. Where a document is approaching "
        "expiry, the system issues escalating reminder e-mails to HR at the following "
        "thresholds:",
        body,
    ))
    threshold_data = [
        ["Threshold", "Days before expiry", "Recipient", "Action triggered"],
        ["First reminder", "90 days", "HR admin team", "HR diary entry to re-check share code"],
        ["Second reminder", "60 days", "HR admin team", "Begin RTW renewal conversation with worker"],
        ["Urgent reminder", "30 days", "HR admin + Authorising Officer", "Schedule in-person RTW re-check"],
        ["Final reminder", "7 days", "HR admin + Authorising Officer", "Re-check completed or work paused"],
        ["Expired", "Day 0", "All HR + Authorising Officer", "Worker suspended pending re-verification"],
    ]
    th_tbl = Table(threshold_data, colWidths=[26 * mm, 26 * mm, 50 * mm, 70 * mm], repeatRows=1)
    th_tbl.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 8.5),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1e40af")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.HexColor("#f1f5f9"), colors.white]),
        ("LINEBELOW", (0, 0), (-1, -1), 0.25, colors.HexColor("#cbd5e1")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(th_tbl)
    story.append(Spacer(1, 6))
    story.append(Paragraph(
        "Every alert is recorded in a permanent <b>hr_visa_alerts</b> audit log and every "
        "human re-check is recorded in a permanent <b>hr_visa_reviews</b> audit log. "
        "Neither log permits editing or deletion of historical rows.",
        body,
    ))

    # ─── 3. Right-to-work re-check procedure ─────────────────────────
    story.append(Paragraph("3. Right-to-Work Re-check Procedure", h2))
    story.append(Paragraph(
        "On receipt of any reminder above, HR will arrange a re-check using one of the "
        "Home Office&rsquo;s permitted methods:",
        body,
    ))
    procedure_items = [
        ("<b>Online check</b> via the Home Office Right to Work Service using a 9-character share code provided by the worker, where the worker holds a Biometric Residence Permit (BRP), Biometric Residence Card (BRC), Frontier Worker Permit, or eVisa."),
        ("<b>In-person inspection</b> of the worker&rsquo;s passport, BRP or other prescribed document; the document is photocopied, dated and signed by the inspecting HR officer."),
        ("Both methods produce a permanent audit row in <b>hr_visa_reviews</b> recording who performed the check, the method used, the share code (if applicable), and the resulting permitted-to-work-until date."),
    ]
    for item in procedure_items:
        story.append(Paragraph(f"&bull; {item}", body))

    # ─── 4. Baseline review attestation ──────────────────────────────
    story.append(Paragraph("4. Baseline Review Attestation", h2))
    if baseline:
        baseline_block = (
            f"A baseline review of every existing worker was completed on "
            f"<b>{baseline.get('completed_at', '')[:10]}</b> by "
            f"<b>{baseline.get('completed_by_email', '—')}</b>. "
            f"{baseline.get('employees_reviewed', 0)} worker(s) were re-verified during "
            f"this session. From this date forward, every right-to-work re-check is "
            f"recorded as it occurs and the automated alert ladder above is live."
        )
    else:
        baseline_block = (
            "<b>Pending</b> &mdash; a baseline review of all current workers has not yet "
            "been recorded in this system. The named HR Authorising Officer will complete "
            "the baseline review within 14 days of policy effective date and the result "
            "will be appended to this document."
        )
    story.append(Paragraph(baseline_block, quote))

    # ─── 5. Current sponsored worker snapshot ─────────────────────────
    story.append(Paragraph("5. Current Sponsored Worker Snapshot", h2))
    employees = report.get("employees") or []
    if employees:
        headers = ["#", "Name", "Visa type", "Expiry", "Status", "Last check"]
        snapshot_rows = [headers]
        for emp in employees:
            d = emp.get("document") or {}
            rev = emp.get("last_review") or {}
            last_review_str = (
                ((rev.get("reviewed_at") or "")[:10] +
                 f"\n{rev.get('reviewer_email', '?')}") if rev else "—"
            )
            snapshot_rows.append([
                emp.get("employee_number", "—"),
                emp.get("name", "—"),
                d.get("visa_type") or "—",
                d.get("expiry_date") or "—",
                (emp.get("status") or "—").replace("_", " "),
                last_review_str,
            ])
        snap_tbl = Table(snapshot_rows,
                         colWidths=[18 * mm, 38 * mm, 30 * mm, 25 * mm, 28 * mm, 36 * mm],
                         repeatRows=1)
        snap_style = [
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
        for idx, emp in enumerate(employees, start=1):
            status = emp.get("status")
            if status == "EXPIRED":
                snap_style.append(("BACKGROUND", (4, idx), (4, idx), colors.HexColor("#fecaca")))
            elif status == "EXPIRING_SOON":
                snap_style.append(("BACKGROUND", (4, idx), (4, idx), colors.HexColor("#fde68a")))
            elif status == "WATCH":
                snap_style.append(("BACKGROUND", (4, idx), (4, idx), colors.HexColor("#fef3c7")))
            elif status == "VALID":
                snap_style.append(("BACKGROUND", (4, idx), (4, idx), colors.HexColor("#d1fae5")))
        snap_tbl.setStyle(TableStyle(snap_style))
        story.append(snap_tbl)
    else:
        story.append(Paragraph(
            "<i>No sponsored workers are currently on the system. This section will "
            "auto-populate as visa documents are uploaded.</i>", body,
        ))

    # ─── 6. Sign-off ─────────────────────────────────────────────────
    story.append(PageBreak())
    story.append(Paragraph("Signed for and on behalf of " + company_name, h2))
    story.append(Spacer(1, 24))
    sign_data = [
        ["", ""],
        ["Signature", "Date"],
    ]
    sign_tbl = Table(sign_data, colWidths=[100 * mm, 60 * mm], rowHeights=[28 * mm, 8 * mm])
    sign_tbl.setStyle(TableStyle([
        ("LINEBELOW", (0, 0), (-1, 0), 0.75, colors.HexColor("#1e293b")),
        ("FONTNAME", (0, 1), (-1, 1), "Helvetica-Bold"),
        ("FONTSIZE", (0, 1), (-1, 1), 9),
        ("TEXTCOLOR", (0, 1), (-1, 1), colors.HexColor("#475569")),
        ("VALIGN", (0, 1), (-1, 1), "TOP"),
    ]))
    story.append(sign_tbl)
    story.append(Spacer(1, 8))
    story.append(Paragraph(
        f"<b>Name:</b> {ao_name}<br/>"
        f"<b>Title:</b> {ao_title}<br/>"
        f"<b>Email:</b> {ao_email or '—'}",
        body,
    ))

    story.append(Spacer(1, 32))
    story.append(Paragraph(
        f"Generated automatically by the {company_name} HR System on "
        f"{datetime.now(timezone.utc).strftime('%d %b %Y at %H:%M UTC')} "
        f"by {(current_user or {}).get('email', 'system')}. "
        f"This document is reproducible at any time from the HR Portal &gt; Visa Compliance tab.",
        foot,
    ))

    doc.build(story)
    pdf_bytes = buf.getvalue()
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": 'attachment; filename="visa_monitoring_policy.pdf"',
        },
    )

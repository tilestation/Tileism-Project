"""
HR Personnel File Compliance Checklist (Feb 2026).

Built for UK Home Office Sponsor Licence audits. The Home Office can
visit (or request a paper-trail of) any Sponsor's premises and expects
to see — for EVERY worker — a complete personnel file containing
specific documents that depend on the worker's right-to-work status.

This module determines, per worker:
  1. Which "compliance profile" they fall into:
       sponsored_worker | settled_worker | british_worker
     (auto-detected from their uploaded document set OR overridden
      manually on their employee record).
  2. The required document set for that profile.
  3. The current state of each requirement on the worker's file:
       ok | expiring | expired | missing | optional_missing

The same data is rendered:
  • as JSON via GET /api/hr/compliance/checklist (for the matrix UI)
  • as a printable PDF via GET /api/hr/compliance/checklist.pdf

Doc requirements are drawn from Appendix D of the Home Office sponsor
guidance plus the standard UK employment-law personnel file. Wide
enough to satisfy auditors, narrow enough that admins don't have to
upload 47 things per worker.
"""
import io
import logging
from datetime import date, datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response

from config import get_db
from services import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/hr/compliance", tags=["HR"])

EXPIRING_DAYS = 30  # ≤ this = ⚠ amber on the matrix


# ─── Requirements per profile ────────────────────────────────────────
# `category` matches the values in DocumentsTab.jsx so click-to-upload
# can pre-seed the upload modal.
#
# `expires` = True → the most-recent doc must have a future expiry_date.
# `expires` = False → presence of any doc in the category is enough.
#
# `required` = True → counts against compliance; missing/expired/expiring
#                     bumps the worker out of "fully compliant".
# `required` = False → "optional / recommended" — renders gray on the
#                      matrix and doesn't break compliance.
REQUIREMENTS = {
    "sponsored_worker": [
        {"category": "contract",       "label": "Signed contract",                   "required": True,  "expires": False},
        {"category": "right_to_work",  "label": "RTW share-code check (gov.uk)",     "required": True,  "expires": True},
        {"category": "visa",           "label": "Visa document (BRP / eVisa)",       "required": True,  "expires": True},
        {"category": "id",             "label": "Photo ID (passport)",               "required": True,  "expires": True},
        {"category": "certification",  "label": "Qualifications evidence / CV",      "required": True,  "expires": False},
        {"category": "p45",            "label": "P45 / starter declaration",          "required": False, "expires": False},
        {"category": "policy_acknowledgement", "label": "Policy acknowledgement",     "required": False, "expires": False},
    ],
    "settled_worker": [
        {"category": "contract",       "label": "Signed contract",                   "required": True,  "expires": False},
        {"category": "right_to_work",  "label": "RTW evidence (ILR / EUSS / eVisa)", "required": True,  "expires": False},
        {"category": "id",             "label": "Photo ID (passport / DL)",          "required": True,  "expires": True},
        {"category": "p45",            "label": "P45 / starter declaration",          "required": False, "expires": False},
        {"category": "policy_acknowledgement", "label": "Policy acknowledgement",     "required": False, "expires": False},
    ],
    "british_worker": [
        {"category": "contract",       "label": "Signed contract",                   "required": True,  "expires": False},
        {"category": "right_to_work",  "label": "RTW evidence (UK passport copy)",   "required": True,  "expires": False},
        {"category": "id",             "label": "Photo ID",                          "required": True,  "expires": True},
        {"category": "p45",            "label": "P45 / starter declaration",          "required": False, "expires": False},
        {"category": "policy_acknowledgement", "label": "Policy acknowledgement",     "required": False, "expires": False},
    ],
}

PROFILE_LABELS = {
    "sponsored_worker": "Sponsored Worker (visa)",
    "settled_worker":   "Settled / ILR / EUSS",
    "british_worker":   "British / Irish",
}


# ─── Auth ────────────────────────────────────────────────────────────
def _is_hr_admin(user: dict) -> bool:
    return (user or {}).get("role") in {"super_admin", "hr_admin"}


def _require_hr_admin(user: dict) -> None:
    if not _is_hr_admin(user):
        raise HTTPException(403, "HR admin only")


# ─── Helpers ─────────────────────────────────────────────────────────
def _infer_profile(emp: dict, doc_categories: set) -> str:
    """Decide which compliance profile a worker falls into. Manual
    override on the employee record wins. Otherwise: visa doc → sponsored,
    RTW-only → settled, no docs → british."""
    explicit = (emp.get("compliance_profile") or "").strip()
    if explicit in REQUIREMENTS:
        return explicit
    if "visa" in doc_categories:
        return "sponsored_worker"
    if "right_to_work" in doc_categories:
        return "settled_worker"
    return "british_worker"


def _classify_doc(latest_doc: Optional[dict], expires: bool) -> str:
    """Return 'ok' / 'expiring' / 'expired' / 'missing' for ONE requirement.
    `latest_doc` is the most-recently uploaded doc in that category, or
    None if nothing's been uploaded yet."""
    if not latest_doc:
        return "missing"
    if not expires:
        return "ok"  # presence is enough
    expiry = latest_doc.get("expiry_date")
    if not expiry:
        # Required to have an expiry but none recorded — flag as expiring
        # rather than expired/missing to draw attention without screaming.
        return "expiring"
    try:
        d = datetime.strptime(expiry, "%Y-%m-%d").date()
    except ValueError:
        return "expiring"
    days = (d - date.today()).days
    if days < 0:
        return "expired"
    if days <= EXPIRING_DAYS:
        return "expiring"
    return "ok"


async def _docs_by_employee(db) -> dict:
    """Returns {employee_id: {category: latest_doc_dict}} for every
    active uploaded document. Only one round trip."""
    by_emp: dict = {}
    cur = db.hr_documents.find(
        {},
        {"_id": 0, "file_b64": 0},
    ).sort("uploaded_at", -1)  # newest first → first one wins per (emp,cat)
    async for d in cur:
        eid = d.get("employee_id")
        cat = d.get("category")
        if not eid or not cat:
            continue
        by_emp.setdefault(eid, {}).setdefault(cat, d)
    return by_emp


def _summarise_status(rows: List[dict]) -> dict:
    """Per-employee summary: counts + an overall compliance verdict."""
    required_total = sum(1 for r in rows if r["required"])
    required_ok = sum(1 for r in rows if r["required"] and r["status"] == "ok")
    required_expiring = sum(1 for r in rows if r["required"] and r["status"] == "expiring")
    required_expired = sum(1 for r in rows if r["required"] and r["status"] == "expired")
    required_missing = sum(1 for r in rows if r["required"] and r["status"] == "missing")
    if required_missing or required_expired:
        verdict = "non_compliant"
    elif required_expiring:
        verdict = "action_needed"
    else:
        verdict = "compliant"
    return {
        "required_total": required_total,
        "required_ok": required_ok,
        "required_expiring": required_expiring,
        "required_expired": required_expired,
        "required_missing": required_missing,
        "verdict": verdict,
    }


# ─── Endpoints ───────────────────────────────────────────────────────
@router.get("/checklist")
async def compliance_checklist(current_user: dict = Depends(get_current_user)):
    """Returns the per-employee × requirement matrix used by the
    Documents-tab compliance modal. One Mongo round-trip per
    collection — cheap to call on tab open."""
    _require_hr_admin(current_user)
    db = get_db()

    employees = await db.hr_employees.find(
        {"archived_at": {"$exists": False}},
        {"_id": 0, "id": 1, "first_name": 1, "last_name": 1,
         "employee_number": 1, "job_title": 1, "showroom_id": 1,
         "nationality": 1, "start_date": 1, "compliance_profile": 1},
    ).sort("last_name", 1).to_list(2000)

    docs_by_emp = await _docs_by_employee(db)

    rows = []
    overall = {"compliant": 0, "action_needed": 0, "non_compliant": 0}
    profile_counts = {k: 0 for k in REQUIREMENTS}

    for emp in employees:
        emp_docs = docs_by_emp.get(emp["id"], {})
        profile = _infer_profile(emp, set(emp_docs.keys()))
        profile_counts[profile] = profile_counts.get(profile, 0) + 1

        reqs_out = []
        for req in REQUIREMENTS[profile]:
            latest = emp_docs.get(req["category"])
            status = _classify_doc(latest, req["expires"])
            reqs_out.append({
                "category": req["category"],
                "label": req["label"],
                "required": req["required"],
                "expires": req["expires"],
                "status": status,
                "document": ({
                    "id": latest.get("id"),
                    "title": latest.get("title"),
                    "expiry_date": latest.get("expiry_date"),
                    "uploaded_at": latest.get("uploaded_at"),
                } if latest else None),
            })
        summary = _summarise_status(reqs_out)
        overall[summary["verdict"]] = overall.get(summary["verdict"], 0) + 1
        rows.append({
            "employee_id": emp["id"],
            "employee_number": emp.get("employee_number"),
            "name": f"{emp.get('first_name', '')} {emp.get('last_name', '')}".strip(),
            "job_title": emp.get("job_title"),
            "nationality": emp.get("nationality"),
            "start_date": emp.get("start_date"),
            "profile": profile,
            "profile_label": PROFILE_LABELS[profile],
            "requirements": reqs_out,
            **summary,
        })

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "categories_in_use": sorted({r["category"] for reqs in REQUIREMENTS.values() for r in reqs}),
        "profile_counts": profile_counts,
        "overall_counts": overall,
        "rows": rows,
    }


@router.get("/checklist.pdf")
async def compliance_checklist_pdf(current_user: dict = Depends(get_current_user)):
    """Printable Personnel File Completeness Report — Home Office
    audit-ready summary of every worker's document set, with a
    traffic-light matrix per requirement."""
    _require_hr_admin(current_user)
    db = get_db()
    settings_doc = await db.hr_settings.find_one({"id": "default"}, {"_id": 0}) or {}
    data = await compliance_checklist(current_user=current_user)
    company_name = (settings_doc.get("company_name") or "Tile Station Ltd").strip()
    licence_no = (settings_doc.get("sponsor_licence_number") or "").strip() or "—"

    from reportlab.lib.pagesizes import A4, landscape  # noqa: PLC0415
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle  # noqa: PLC0415
    from reportlab.lib.units import mm  # noqa: PLC0415
    from reportlab.lib import colors  # noqa: PLC0415
    from reportlab.platypus import (  # noqa: PLC0415
        SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak,
    )

    # Landscape — the matrix is wide.
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=landscape(A4),
        leftMargin=12 * mm, rightMargin=12 * mm,
        topMargin=12 * mm, bottomMargin=12 * mm,
        title=f"Personnel File Completeness — {company_name}",
    )
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "Title", parent=styles["Heading1"], fontSize=16,
        textColor=colors.HexColor("#0f172a"), spaceAfter=4,
    )
    sub_style = ParagraphStyle(
        "Sub", parent=styles["Normal"], fontSize=9,
        textColor=colors.HexColor("#475569"), spaceAfter=10, leading=13,
    )
    h2 = ParagraphStyle(
        "H2", parent=styles["Heading2"], fontSize=12,
        textColor=colors.HexColor("#1e293b"), spaceBefore=10, spaceAfter=6,
    )
    body = ParagraphStyle(
        "Body", parent=styles["Normal"], fontSize=9, leading=13,
    )

    story = []
    story.append(Paragraph("Personnel File Completeness Report", title_style))
    story.append(Paragraph(
        f"{company_name} &nbsp;·&nbsp; Sponsor Licence: <b>{licence_no}</b> "
        f"&nbsp;·&nbsp; Generated {datetime.now(timezone.utc).strftime('%d %b %Y, %H:%M UTC')}"
        f" by {(current_user or {}).get('email', 'system')}",
        sub_style,
    ))
    story.append(Paragraph(
        "<b>Legend.</b> "
        "<font color='#065f46'>✓ OK</font> &nbsp; "
        "<font color='#92400e'>⚠ Expiring (≤30d) or no expiry on file</font> &nbsp; "
        "<font color='#9f1239'>✗ Expired</font> &nbsp; "
        "<font color='#7f1d1d'>✗ Missing</font> &nbsp; "
        "<font color='#475569'>— Optional / Not required</font>",
        sub_style,
    ))

    # ─── Top-level summary ────────────────────────────────────────────
    o = data["overall_counts"]
    p = data["profile_counts"]
    summary_data = [
        ["Total active workers", str(len(data["rows"]))],
        ["✓ Fully compliant", str(o.get("compliant", 0))],
        ["⚠ Action needed (expiring)", str(o.get("action_needed", 0))],
        ["✗ Non-compliant (missing / expired)", str(o.get("non_compliant", 0))],
        ["— Sponsored Worker profile", str(p.get("sponsored_worker", 0))],
        ["— Settled / ILR / EUSS profile", str(p.get("settled_worker", 0))],
        ["— British / Irish profile", str(p.get("british_worker", 0))],
    ]
    summary_tbl = Table(summary_data, colWidths=[80 * mm, 30 * mm])
    summary_tbl.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("ROWBACKGROUNDS", (0, 0), (-1, -1), [colors.HexColor("#f1f5f9"), colors.white]),
        ("LINEBELOW", (0, 0), (-1, -1), 0.25, colors.HexColor("#cbd5e1")),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(summary_tbl)

    # ─── Per-profile matrix ──────────────────────────────────────────
    for profile_key in ("sponsored_worker", "settled_worker", "british_worker"):
        profile_rows = [r for r in data["rows"] if r["profile"] == profile_key]
        if not profile_rows:
            continue
        story.append(Paragraph(PROFILE_LABELS[profile_key] + f" &nbsp;({len(profile_rows)})", h2))
        reqs = REQUIREMENTS[profile_key]
        headers = ["#", "Name"] + [r["label"].replace(" / ", "\n/ ") for r in reqs] + ["Status"]
        table_rows = [headers]
        for r in profile_rows:
            cells = [r.get("employee_number") or "—", r.get("name") or "—"]
            req_states = {req["category"]: req for req in r["requirements"]}
            for req_def in reqs:
                state = req_states.get(req_def["category"])
                if not state:
                    cells.append("—")
                    continue
                cells.append(_glyph_for(state))
            verdict_map = {
                "compliant":     "✓ OK",
                "action_needed": "⚠ Action",
                "non_compliant": "✗ Fail",
            }
            cells.append(verdict_map.get(r.get("verdict"), "—"))
            table_rows.append(cells)
        col_widths = ([18 * mm, 35 * mm]
                       + [22 * mm] * len(reqs)
                       + [22 * mm])
        tbl = Table(table_rows, colWidths=col_widths, repeatRows=1)
        styles_cmds = [
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 7.5),
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1e293b")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("ALIGN", (2, 0), (-1, -1), "CENTER"),
            ("LINEBELOW", (0, 0), (-1, -1), 0.25, colors.HexColor("#cbd5e1")),
            ("LEFTPADDING", (0, 0), (-1, -1), 3),
            ("RIGHTPADDING", (0, 0), (-1, -1), 3),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]
        # Status-cell colouring
        for r_idx, r in enumerate(profile_rows, start=1):
            req_states = {req["category"]: req for req in r["requirements"]}
            for c_idx, req_def in enumerate(reqs, start=2):
                state = req_states.get(req_def["category"])
                if not state:
                    continue
                bg = _bg_for(state)
                if bg:
                    styles_cmds.append(("BACKGROUND", (c_idx, r_idx), (c_idx, r_idx), bg))
            # Verdict column
            v_bg = {
                "compliant":     colors.HexColor("#d1fae5"),
                "action_needed": colors.HexColor("#fef3c7"),
                "non_compliant": colors.HexColor("#fecaca"),
            }.get(r.get("verdict"))
            if v_bg:
                styles_cmds.append(("BACKGROUND", (len(headers) - 1, r_idx), (len(headers) - 1, r_idx), v_bg))
        tbl.setStyle(TableStyle(styles_cmds))
        story.append(tbl)
        story.append(Spacer(1, 8))

    # ─── Detailed per-worker action list ─────────────────────────────
    action_rows = [r for r in data["rows"] if r["verdict"] != "compliant"]
    if action_rows:
        story.append(PageBreak())
        story.append(Paragraph(f"Action list — {len(action_rows)} worker(s) need attention", h2))
        for r in action_rows:
            issues = []
            for req in r["requirements"]:
                if not req["required"]:
                    continue
                if req["status"] == "missing":
                    issues.append(f"• <b>MISSING</b> &mdash; {req['label']}")
                elif req["status"] == "expired":
                    exp = (req.get("document") or {}).get("expiry_date") or "?"
                    issues.append(f"• <b>EXPIRED</b> &mdash; {req['label']} (expired {exp})")
                elif req["status"] == "expiring":
                    exp = (req.get("document") or {}).get("expiry_date") or "no date on file"
                    issues.append(f"• <b>EXPIRING</b> &mdash; {req['label']} ({exp})")
            if not issues:
                continue
            story.append(Paragraph(
                f"<b>{r['name']}</b> ({r.get('employee_number') or '—'}) &mdash; "
                f"{PROFILE_LABELS[r['profile']]}",
                body,
            ))
            for line in issues:
                story.append(Paragraph(f"&nbsp;&nbsp;{line}", body))
            story.append(Spacer(1, 6))
    else:
        story.append(Spacer(1, 8))
        story.append(Paragraph(
            "<b>All workers are fully compliant.</b> No outstanding actions.", body))

    doc.build(story)
    pdf_bytes = buf.getvalue()
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": 'attachment; filename="personnel_file_completeness.pdf"',
        },
    )


def _glyph_for(state: dict) -> str:
    if not state.get("required") and state.get("status") == "missing":
        return "—"
    return {
        "ok":       "✓",
        "expiring": "⚠",
        "expired":  "✗",
        "missing":  "✗",
    }.get(state.get("status"), "—")


def _bg_for(state: dict):
    from reportlab.lib import colors  # noqa: PLC0415
    if not state.get("required") and state.get("status") == "missing":
        return colors.HexColor("#f1f5f9")
    return {
        "ok":       colors.HexColor("#d1fae5"),
        "expiring": colors.HexColor("#fef3c7"),
        "expired":  colors.HexColor("#fecaca"),
        "missing":  colors.HexColor("#fecaca"),
    }.get(state.get("status"))

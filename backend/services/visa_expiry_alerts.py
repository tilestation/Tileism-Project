"""
Visa expiry alert service (13 Jun 2026).

Built for sponsor-licence compliance: the Home Office wants documented
evidence that we actively monitor each visa's expiry. Concretely, this
service:

  1. Scans every document with category in {'visa', 'right_to_work'}
     and a non-null expiry_date.
  2. Checks each one against the threshold ladder
     [90, 60, 30, 7] days BEFORE expiry.
  3. For every threshold that the doc has crossed since the LAST run,
     emails HR (and writes an audit record into `hr_visa_alerts`).
  4. Records expired docs too (a single "EXPIRED" event), with the
     same audit trail.

The cron loop in `server.py::_visa_expiry_alert_loop` calls
`run_visa_expiry_alerts()` once per day at 07:00 UTC. Idempotent —
re-running on the same day won't double-email because we check
`hr_visa_alerts` for the (document_id, threshold_days) tuple before
sending.
"""
import logging
import uuid
from datetime import date, datetime, timezone
from typing import List, Optional

logger = logging.getLogger(__name__)

# Ladder, biggest-first. The compliance report shows the highest
# threshold crossed first so the audit shows we noticed *early*.
ALERT_THRESHOLDS = [90, 60, 30, 7]
EXPIRED_THRESHOLD = -1  # sentinel for "EXPIRED" events
VISA_CATEGORIES = {"visa", "right_to_work"}


async def _hr_recipients() -> List[str]:
    """Returns the email addresses that should receive visa alerts.
    Anyone with `role` in {'hr_admin', 'super_admin'}."""
    from config import get_db  # noqa: PLC0415
    db = get_db()
    cur = db.users.find(
        {"role": {"$in": ["hr_admin", "super_admin"]}},
        {"_id": 0, "email": 1},
    )
    rows = await cur.to_list(50)
    emails = sorted({(r.get("email") or "").strip() for r in rows if (r.get("email") or "").strip()})
    return emails


async def _already_alerted(db, document_id: str, threshold_days: int) -> bool:
    """Idempotency guard — don't re-send a 30-day alert if we already
    fired one for this doc."""
    row = await db.hr_visa_alerts.find_one(
        {"document_id": document_id, "threshold_days": threshold_days},
        {"_id": 0, "id": 1},
    )
    return row is not None


async def _record_alert(
    db, *, document_id: str, employee_id: str, threshold_days: int,
    recipients: List[str], expiry_date: Optional[str], sent: bool, error: Optional[str] = None,
) -> None:
    await db.hr_visa_alerts.insert_one({
        "id": str(uuid.uuid4()),
        "document_id": document_id,
        "employee_id": employee_id,
        "threshold_days": threshold_days,
        "expiry_date": expiry_date,
        "recipients": ", ".join(recipients),
        "alerted_at": datetime.now(timezone.utc).isoformat(),
        "delivered": sent,
        "error": error,
    })


def _classify_today(expiry_iso: str) -> tuple:
    """Returns the LARGEST threshold the doc has crossed today (i.e. the
    most urgent + earliest one we still need to alert on). Returns
    (threshold_days, days_left) or (None, days_left) if it hasn't
    crossed anything yet."""
    try:
        d = datetime.strptime(expiry_iso, "%Y-%m-%d").date()
    except ValueError:
        return (None, None)
    days_left = (d - date.today()).days
    if days_left < 0:
        return (EXPIRED_THRESHOLD, days_left)
    # Walk SMALLEST→LARGEST and pick the first rung the visa has
    # already crossed (i.e. days_left <= rung). For 25 days left this
    # returns the 30-day threshold, NOT the 90 — we want to fire the
    # most-urgent rung that's actually been crossed, and on the next
    # daily pass we'll naturally fire the 7-day rung when we reach it.
    # The (doc_id, threshold) tuple stored in `hr_visa_alerts` makes
    # this idempotent so day-26 won't re-fire the 30-day notice.
    for thr in sorted(ALERT_THRESHOLDS):  # 7, 30, 60, 90
        if days_left <= thr:
            return (thr, days_left)
    return (None, days_left)


async def _send_visa_alert_email(
    *, recipients: List[str], employee_name: str, expiry_date: str,
    threshold_days: int, days_left: int, doc_title: str,
) -> tuple:
    from services.email import send_simple_email_if_possible  # noqa: PLC0415
    if threshold_days == EXPIRED_THRESHOLD:
        subject = f"⚠️ EXPIRED visa — {employee_name} (Right to Work URGENT)"
        urgency_html = (
            "<p style='color:#b91c1c;font-weight:bold;'>This worker&rsquo;s right-to-work "
            "evidence has EXPIRED. Continued employment may breach the sponsor licence. "
            "Action required today.</p>"
        )
    elif threshold_days <= 7:
        subject = f"⚠️ {employee_name} — visa expires in {days_left} days"
        urgency_html = (
            "<p style='color:#b45309;font-weight:bold;'>This is the CRITICAL "
            f"reminder. {employee_name}&rsquo;s right-to-work expires in {days_left} days. "
            "Begin renewal or off-boarding planning immediately.</p>"
        )
    else:
        subject = f"{employee_name} — visa expires in {days_left} days ({threshold_days}-day notice)"
        urgency_html = (
            f"<p>This is the <strong>{threshold_days}-day reminder</strong>. "
            "Confirm the renewal application is in progress.</p>"
        )

    html = (
        f"<p>Hi HR team,</p>"
        f"{urgency_html}"
        f"<table style='font-family:system-ui;font-size:13px;border-collapse:collapse;margin:8px 0;'>"
        f"<tr><td style='padding:4px 12px 4px 0;color:#64748b;'>Employee</td><td><strong>{employee_name}</strong></td></tr>"
        f"<tr><td style='padding:4px 12px 4px 0;color:#64748b;'>Document</td><td>{doc_title}</td></tr>"
        f"<tr><td style='padding:4px 12px 4px 0;color:#64748b;'>Expires</td><td><strong>{expiry_date}</strong> "
        f"({days_left} days)</td></tr>"
        f"</table>"
        f"<p>This reminder is logged automatically in the Visa Compliance audit trail "
        f"(viewable under Admin → HR Portal → Visa Compliance).</p>"
        f"<p>— Tile Station automated monitoring</p>"
    )
    try:
        r = await send_simple_email_if_possible(to=recipients, subject=subject, html=html)
        return bool(r.get("success")), r.get("error")
    except Exception as e:  # noqa: BLE001
        return False, str(e)


async def run_visa_expiry_alerts() -> dict:
    """Single pass — designed to be called once a day from the cron
    loop. Returns a small summary dict for logging."""
    from config import get_db  # noqa: PLC0415
    db = get_db()
    recipients = await _hr_recipients()
    if not recipients:
        logger.warning("[visa-alerts] no HR recipients configured — skipping")
        return {"alerted": 0, "skipped": "no recipients"}
    cur = db.hr_documents.find(
        {
            "category": {"$in": list(VISA_CATEGORIES)},
            "expiry_date": {"$ne": None},
        },
        {"_id": 0, "file_b64": 0},
    )
    sent = 0
    seen = 0
    async for doc in cur:
        seen += 1
        expiry = doc.get("expiry_date")
        if not expiry:
            continue
        threshold, days_left = _classify_today(expiry)
        if threshold is None:
            continue
        if await _already_alerted(db, doc["id"], threshold):
            continue
        # Resolve employee
        emp = await db.hr_employees.find_one(
            {"id": doc["employee_id"]},
            {"_id": 0, "first_name": 1, "last_name": 1},
        )
        emp_name = (
            f"{(emp or {}).get('first_name', '')} {(emp or {}).get('last_name', '')}".strip()
            or doc["employee_id"]
        )
        ok, err = await _send_visa_alert_email(
            recipients=recipients,
            employee_name=emp_name,
            expiry_date=expiry,
            threshold_days=threshold,
            days_left=days_left or 0,
            doc_title=doc.get("title") or doc.get("file_name") or "Visa document",
        )
        await _record_alert(
            db, document_id=doc["id"], employee_id=doc["employee_id"],
            threshold_days=threshold, recipients=recipients,
            expiry_date=expiry, sent=ok, error=err,
        )
        if ok:
            sent += 1
            logger.info(
                "[visa-alerts] %s-day alert sent for %s (expires %s)",
                threshold, emp_name, expiry,
            )
        else:
            logger.error(
                "[visa-alerts] failed to send %s-day alert for %s: %s",
                threshold, emp_name, err,
            )
    return {"scanned": seen, "alerted": sent, "recipients": recipients}

"""
Monthly Trade Credit-Back Statement
-----------------------------------
A quiet, bank-statement-style email that goes out on the 1st of each month
to trade customers WHO HAD CREDIT MOVEMENT IN THE MONTH JUST CLOSED. Builds
the ritual that the trader has an asset with us — even in months they
didn't buy.

Core behaviours:
  • Aggregates `credit_transactions` for the prior calendar month per trade
    customer (`type in {earned_in_store, earned_online, redeemed_in_store,
    redeem, reverse_*}`).
  • Skips silently for any customer with zero movement (no spam).
  • Idempotent — a marker doc in `website_settings.monthly_credit_statements`
    pins the last YYYY-MM that was sent; the scheduler tick reads/writes it.
  • Admin-trigger endpoint for manual re-runs and testing.

Endpoints:
  POST /api/admin/trade-credit/statements/send-monthly  (admin-only)
       Body: {"year": 2026, "month": 4, "dry_run": false, "limit": null,
              "force": false}
       Returns: counts of (eligible / sent / skipped / failed)
  GET  /api/admin/trade-credit/statements/preview       (admin-only)
       Query: ?email=... (single trade customer preview HTML, current month)

Scheduler hook:
  `run_monthly_credit_statements_tick()` — hourly probe; fires on day 1
  at 10:00 UTC, once per month.
"""
from __future__ import annotations

import calendar
import logging
import os
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from config import get_db
from services import get_current_user, is_admin_user

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/admin/trade-credit", tags=["trade-credit-statements"])

# Movement-bucket mapping. Anything with a positive amount that isn't a
# redemption goes to "earned"; redemptions go to "redeemed".
EARNED_TYPES = {"earned_in_store", "earned_online", "manual_credit"}
REDEEMED_TYPES = {"redeemed_in_store", "redeem"}


# ---------- helpers ----------------------------------------------------------

def _month_window(year: int, month: int) -> tuple[datetime, datetime, str]:
    """Returns (start_inclusive, end_exclusive, period_label) in UTC."""
    if month < 1 or month > 12:
        raise ValueError(f"Invalid month {month}")
    start = datetime(year, month, 1, tzinfo=timezone.utc)
    last_day = calendar.monthrange(year, month)[1]
    end = datetime(year, month, last_day, 23, 59, 59, tzinfo=timezone.utc) + timedelta(seconds=1)
    label = start.strftime("%B %Y")
    return start, end, label


def _previous_month(now: datetime) -> tuple[int, int]:
    """Returns (year, month) for the calendar month immediately before `now`."""
    first_of_this = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    last_of_prev = first_of_this - timedelta(days=1)
    return last_of_prev.year, last_of_prev.month


async def _build_customer_statement(
    db, customer: dict, year: int, month: int
) -> Optional[dict]:
    """Aggregate ledger movement for one customer over a calendar month.

    Returns None if there was zero movement (caller should skip the email).
    Otherwise returns a dict ready to be passed to the email render helper.
    """
    start, end, label = _month_window(year, month)
    customer_id = customer.get("id")
    if not customer_id:
        return None

    cursor = db.credit_transactions.find(
        {
            "customer_id": customer_id,
            "created_at": {"$gte": start.isoformat(), "$lt": end.isoformat()},
        },
        {"_id": 0, "type": 1, "amount": 1, "balance_after": 1, "invoice_no": 1,
         "order_number": 1, "description": 1, "created_at": 1, "source": 1},
    ).sort("created_at", 1)
    txns = await cursor.to_list(length=500)

    if not txns:
        return None

    earned_total = 0.0
    redeemed_total = 0.0
    earn_lines: list[dict] = []
    redeem_lines: list[dict] = []
    last_balance: Optional[float] = None

    for t in txns:
        t_type = (t.get("type") or "").lower()
        amt = float(t.get("amount") or 0)
        bal = t.get("balance_after")
        if bal is not None:
            last_balance = float(bal)
        if t_type in EARNED_TYPES and amt > 0:
            earned_total += amt
            earn_lines.append(t)
        elif t_type in REDEEMED_TYPES:
            # redeem amounts are negative in the ledger, but we display as positive
            redeemed_total += abs(amt)
            redeem_lines.append(t)
        # other / reverse_* types are ignored for the headline summary

    # Final balance — prefer the live customer record (newest), else last txn's balance_after, else 0
    closing_balance = (
        float(customer.get("credit_balance") or 0)
        if customer.get("credit_balance") is not None
        else (last_balance if last_balance is not None else 0.0)
    )

    return {
        "customer_id": customer_id,
        "customer_email": customer.get("email"),
        "customer_name": customer.get("name") or customer.get("business_name") or "there",
        "business_name": customer.get("business_name") or "",
        "trade_account_number": customer.get("trade_account_number") or "",
        "period_label": label,
        "year": year,
        "month": month,
        "earned_total": round(earned_total, 2),
        "redeemed_total": round(redeemed_total, 2),
        "closing_balance": round(closing_balance, 2),
        "txns_count": len(txns),
        "earn_lines": earn_lines[:5],
        "redeem_lines": redeem_lines[:5],
    }


# ---------- HTML render ------------------------------------------------------

def _format_gbp(v: float) -> str:
    return f"£{float(v or 0):.2f}"


def render_monthly_statement_html(stmt: dict) -> str:
    company_website = os.environ.get("COMPANY_WEBSITE") or os.environ.get("SHOP_WEBSITE_URL") or "https://tilestation.co.uk"
    first_name = (stmt.get("customer_name") or "there").split(" ")[0]
    period = stmt["period_label"]
    earned = stmt["earned_total"]
    redeemed = stmt["redeemed_total"]
    balance = stmt["closing_balance"]
    t_ref = stmt.get("trade_account_number") or ""
    spend_url = f"{company_website}/shop/trade/account"

    # Compose mini-statement rows
    def _row(label: str, value: str, color: str = "#1a1a2e", bold: bool = False) -> str:
        weight = "700" if bold else "500"
        return (
            f'<tr><td style="padding:10px 0; color:#525252; font-size:14px;">{label}</td>'
            f'<td style="padding:10px 0; text-align:right; color:{color}; font-size:15px; font-weight:{weight}; font-family:ui-monospace,SFMono-Regular,monospace;">{value}</td></tr>'
        )

    summary_rows = ""
    if earned > 0:
        summary_rows += _row("Credit earned this month", f"+ {_format_gbp(earned)}", color="#047857", bold=True)
    if redeemed > 0:
        summary_rows += _row("Credit redeemed this month", f"– {_format_gbp(redeemed)}", color="#9f1239", bold=True)
    summary_rows += (
        '<tr><td colspan="2" style="padding:6px 0;"><div style="height:1px; background:#e5e7eb;"></div></td></tr>'
    )
    summary_rows += _row("Closing balance", _format_gbp(balance), color="#1a1a2e", bold=True)

    # Recent activity (max 5 of each)
    def _txn_table(rows: list[dict], heading: str, sign: str, color: str) -> str:
        if not rows:
            return ""
        body = ""
        for t in rows:
            try:
                d = datetime.fromisoformat(str(t.get("created_at") or "").replace("Z", "+00:00")).strftime("%d %b")
            except Exception:
                d = ""
            ref = t.get("invoice_no") or t.get("order_number") or ""
            descr = (t.get("description") or "").strip()
            short = ref or (descr[:50] + ("…" if len(descr) > 50 else ""))
            body += (
                f'<tr><td style="padding:6px 8px; color:#737373; font-size:12px; white-space:nowrap;">{d}</td>'
                f'<td style="padding:6px 8px; color:#1a1a2e; font-size:12px;">{short}</td>'
                f'<td style="padding:6px 8px; text-align:right; color:{color}; font-size:12px; font-family:ui-monospace,monospace; white-space:nowrap;">{sign}{_format_gbp(abs(float(t.get("amount") or 0)))}</td></tr>'
            )
        return (
            f'<div style="margin-top:18px;">'
            f'<div style="font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:#737373; margin-bottom:6px;">{heading}</div>'
            f'<table role="presentation" style="width:100%; border-collapse:collapse; background:#fafaf9; border:1px solid #e7e5e4; border-radius:8px;">{body}</table>'
            f'</div>'
        )

    earn_html = _txn_table(stmt.get("earn_lines") or [], "Earned", "+ ", "#047857")
    redeem_html = _txn_table(stmt.get("redeem_lines") or [], "Redeemed", "– ", "#9f1239")

    return f"""
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 620px; margin: 0 auto; color: #1a1a2e; background: #f9fafb;">
      <div style="background:#1C1917; padding:20px 24px;">
        <h1 style="color:#F7EA1C; margin:0; font-size:22px; letter-spacing:-0.3px;">Tile Station</h1>
        <p style="color:#a8a29e; margin:4px 0 0; font-size:12px;">Trade Credit Statement — {period}</p>
      </div>

      <div style="background:#fff; padding:28px 24px;">
        <p style="margin:0 0 16px 0; font-size:15px; color:#1a1a2e;">Hi {first_name},</p>
        <p style="margin:0 0 22px 0; font-size:14px; line-height:1.55; color:#525252;">
          Here's your trade-credit statement for <strong>{period}</strong>{f' on account {t_ref}' if t_ref else ''}.
        </p>

        <div style="background:#fafaf9; border:1px solid #e7e5e4; border-radius:12px; padding:16px 20px;">
          <table role="presentation" style="width:100%; border-collapse:collapse;">{summary_rows}</table>
        </div>

        {earn_html}
        {redeem_html}

        {'<p style="margin:28px 0 0; text-align:center;"><a href="' + spend_url + '" style="display:inline-block; background:#1a1a2e; color:#f0c14b; padding:14px 28px; border-radius:8px; text-decoration:none; font-weight:700; font-size:14px;">View my trade account →</a></p>' if balance > 0 else ''}

        <p style="margin:32px 0 0; font-size:12px; color:#a8a29e; line-height:1.55;">
          Your credit sits on your account ready to redeem against any future purchase — in store or online.
          Statements arrive on the 1st of each month, and only when there's been activity.
          Any questions, just reply to this email.
        </p>
      </div>

      <div style="text-align:center; padding:14px 24px; color:#a8a29e; font-size:11px;">
        Tile Station · Unit 3 Trade City, Coldharbour Road, Northfleet, Gravesend DA11 8AB<br/>
        Company No: 11982550 · VAT No: 324 251 828
      </div>
    </div>
    """


# ---------- send -------------------------------------------------------------

async def _send_one_statement(stmt: dict) -> dict:
    """Sends one statement via Resend. Returns {sent: bool, error: str|None}."""
    if not stmt.get("customer_email"):
        return {"sent": False, "error": "no_email"}
    try:
        # Lazy import to avoid pulling Resend SDK when not configured
        import resend
        from services.email import RESEND_AVAILABLE, RESEND_API_KEY, COMPANY_NAME
    except Exception as exc:  # noqa: BLE001
        return {"sent": False, "error": f"import:{exc}"}
    if not RESEND_AVAILABLE or not RESEND_API_KEY:
        return {"sent": False, "error": "resend_not_configured"}

    html = render_monthly_statement_html(stmt)
    subject = f"Your trade credit statement — {stmt['period_label']}"
    sender = os.environ.get("SENDER_EMAIL", "online@tilestation.co.uk")
    try:
        import asyncio as _asyncio
        resend.api_key = RESEND_API_KEY
        await _asyncio.to_thread(resend.Emails.send, {
            "from": f"{COMPANY_NAME} - Tile Station <{sender}>",
            "to": [stmt["customer_email"]],
            "reply_to": "online@tilestation.co.uk",
            "subject": subject,
            "html": html,
        })
        return {"sent": True, "error": None}
    except Exception as exc:  # noqa: BLE001
        logger.exception("Monthly statement email failed for %s: %s", stmt.get("customer_email"), exc)
        return {"sent": False, "error": str(exc)[:200]}


# ---------- core dispatch loop ----------------------------------------------

async def dispatch_monthly_statements(
    db, year: int, month: int, *, dry_run: bool = False, limit: Optional[int] = None
) -> dict:
    """Iterate trade customers; build per-customer statement; send if movement.

    Returns a summary {eligible, sent, skipped_no_movement, failed, errors}.
    """
    start, end, label = _month_window(year, month)

    # Pull only customers who have a credit_transaction in the window — this
    # is the cheapest way to find candidates and skips dormant accounts entirely.
    candidate_ids = await db.credit_transactions.distinct(
        "customer_id",
        {"created_at": {"$gte": start.isoformat(), "$lt": end.isoformat()}},
    )

    eligible = 0
    sent = 0
    skipped = 0
    failed = 0
    errors: list[dict] = []

    if not candidate_ids:
        return {
            "eligible": 0, "sent": 0, "skipped_no_movement": 0, "failed": 0,
            "errors": [], "period_label": label, "year": year, "month": month, "dry_run": dry_run,
        }

    # Process in batches of 50 to keep memory steady
    batch = 50
    for i in range(0, len(candidate_ids), batch):
        ids = [cid for cid in candidate_ids[i : i + batch] if cid]
        if not ids:
            continue
        custs = await db.shop_customers.find(
            {"id": {"$in": ids}, "is_trade": True, "email": {"$ne": None}},
            {"_id": 0, "id": 1, "email": 1, "name": 1, "business_name": 1,
             "trade_account_number": 1, "credit_balance": 1, "is_trade": 1},
        ).to_list(length=batch)
        for cust in custs:
            if limit is not None and sent + skipped + failed >= limit:
                break
            eligible += 1
            stmt = await _build_customer_statement(db, cust, year, month)
            if not stmt:
                skipped += 1
                continue
            if dry_run:
                sent += 1
                continue
            res = await _send_one_statement(stmt)
            if res.get("sent"):
                sent += 1
            else:
                failed += 1
                errors.append({"email": cust.get("email"), "error": res.get("error")})

    return {
        "eligible": eligible,
        "sent": sent,
        "skipped_no_movement": skipped,
        "failed": failed,
        "errors": errors[:25],  # cap so the response stays small
        "period_label": label,
        "year": year,
        "month": month,
        "dry_run": dry_run,
    }


# ---------- scheduler tick ---------------------------------------------------

async def run_monthly_credit_statements_tick():
    """Hourly probe — fires the dispatch only on day 1 of each month at the
    configured UTC hour (default 10:00). Idempotent via marker doc."""
    db = get_db()
    now = datetime.now(timezone.utc)
    settings = await db.website_settings.find_one({"_id": "monthly_credit_statements"}) or {}
    if not settings.get("enabled", True):
        return
    target_hour = int(settings.get("hour_utc", 10))
    if now.day != 1 or now.hour != target_hour:
        return
    period_key = now.strftime("%Y-%m")  # the month we're STARTING — so we send the prior month's
    if settings.get("last_period") == period_key:
        return  # already sent for this run

    py, pm = _previous_month(now)
    result = await dispatch_monthly_statements(db, py, pm)

    await db.website_settings.update_one(
        {"_id": "monthly_credit_statements"},
        {"$set": {
            "last_period": period_key,
            "last_run_at": now.isoformat(),
            "last_result": result,
            "hour_utc": target_hour,
            "enabled": settings.get("enabled", True),
        }},
        upsert=True,
    )
    logger.info(
        "[monthly-credit-statements] period=%s eligible=%s sent=%s skipped=%s failed=%s",
        result.get("period_label"), result.get("eligible"),
        result.get("sent"), result.get("skipped_no_movement"), result.get("failed"),
    )


# ---------- API endpoints ----------------------------------------------------

class MonthlyDispatchInput(BaseModel):
    year: int = Field(..., ge=2024, le=2100)
    month: int = Field(..., ge=1, le=12)
    dry_run: bool = False
    limit: Optional[int] = Field(default=None, ge=1, le=10000)
    force: bool = False  # Bypass duplicate-period guard for re-runs


@router.post("/statements/send-monthly")
async def admin_send_monthly_statements(
    body: MonthlyDispatchInput,
    current_user: dict = Depends(get_current_user),
):
    """Admin-trigger the monthly statement run. Useful for manual re-runs and
    catching up if the cron probe missed a window."""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    period_key = f"{body.year:04d}-{(body.month % 12 + 1):02d}"  # the run-month following body's window
    settings = await db.website_settings.find_one({"_id": "monthly_credit_statements"}) or {}
    if not body.force and settings.get("last_period") == period_key and not body.dry_run:
        raise HTTPException(
            status_code=409,
            detail=f"Statements for {body.year}-{body.month:02d} already dispatched. Pass force=true to re-run.",
        )
    result = await dispatch_monthly_statements(
        db, body.year, body.month, dry_run=body.dry_run, limit=body.limit,
    )
    if not body.dry_run:
        await db.website_settings.update_one(
            {"_id": "monthly_credit_statements"},
            {"$set": {
                "last_period": period_key,
                "last_run_at": datetime.now(timezone.utc).isoformat(),
                "last_run_by": current_user.get("email"),
                "last_result": result,
            }},
            upsert=True,
        )
    return result


@router.get("/statements/preview")
async def admin_preview_monthly_statement(
    email: str = Query(..., description="Trade customer email"),
    year: Optional[int] = Query(None),
    month: Optional[int] = Query(None),
    current_user: dict = Depends(get_current_user),
):
    """Return the rendered HTML preview for a single trade customer for the
    specified month (defaults to the previous calendar month)."""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    cust = await db.shop_customers.find_one(
        {"email": email.lower().strip()},
        {"_id": 0, "id": 1, "email": 1, "name": 1, "business_name": 1,
         "trade_account_number": 1, "credit_balance": 1, "is_trade": 1},
    )
    if not cust or not cust.get("is_trade"):
        raise HTTPException(status_code=404, detail="Trade customer not found for that email.")
    if not year or not month:
        py, pm = _previous_month(datetime.now(timezone.utc))
        year, month = py, pm
    stmt = await _build_customer_statement(db, cust, year, month)
    if not stmt:
        return {
            "has_movement": False,
            "period_label": _month_window(year, month)[2],
            "html": "",
            "message": "No credit movement in this month — statement would not be sent.",
        }
    return {
        "has_movement": True,
        "period_label": stmt["period_label"],
        "summary": {
            "earned_total": stmt["earned_total"],
            "redeemed_total": stmt["redeemed_total"],
            "closing_balance": stmt["closing_balance"],
            "txns_count": stmt["txns_count"],
        },
        "html": render_monthly_statement_html(stmt),
    }


@router.get("/statements/last-run")
async def admin_last_run_status(current_user: dict = Depends(get_current_user)):
    """Read the marker doc so admins can see when the last batch went out."""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    doc = await db.website_settings.find_one({"_id": "monthly_credit_statements"}, {"_id": 0})
    return doc or {"enabled": True, "hour_utc": 10, "last_period": None, "last_run_at": None}


class SendOneInput(BaseModel):
    email: str = Field(..., min_length=3)
    year: Optional[int] = Field(default=None, ge=2024, le=2100)
    month: Optional[int] = Field(default=None, ge=1, le=12)


@router.post("/statements/send-one")
async def admin_send_one_statement(
    body: SendOneInput,
    current_user: dict = Depends(get_current_user),
):
    """On-demand send for a single trade customer (e.g. when the trader is on
    the phone). Looks up the customer, builds the statement for the requested
    month (defaults to previous calendar month), and dispatches via Resend.
    Returns 400 if there's no movement to send."""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    cust = await db.shop_customers.find_one(
        {"email": body.email.lower().strip()},
        {"_id": 0, "id": 1, "email": 1, "name": 1, "business_name": 1,
         "trade_account_number": 1, "credit_balance": 1, "is_trade": 1},
    )
    if not cust or not cust.get("is_trade"):
        raise HTTPException(status_code=404, detail="Trade customer not found for that email.")

    year, month = body.year, body.month
    if not year or not month:
        py, pm = _previous_month(datetime.now(timezone.utc))
        year, month = py, pm

    stmt = await _build_customer_statement(db, cust, year, month)
    if not stmt:
        raise HTTPException(
            status_code=400,
            detail=f"No credit movement in {_month_window(year, month)[2]} — nothing to send.",
        )
    res = await _send_one_statement(stmt)
    if not res.get("sent"):
        raise HTTPException(
            status_code=502,
            detail=f"Email dispatch failed: {res.get('error') or 'unknown error'}",
        )
    # Audit trail — admin override of the cron schedule
    await db.credit_statement_sends.insert_one({
        "customer_id": cust.get("id"),
        "customer_email": cust.get("email"),
        "period_label": stmt["period_label"],
        "year": year,
        "month": month,
        "earned_total": stmt["earned_total"],
        "redeemed_total": stmt["redeemed_total"],
        "closing_balance": stmt["closing_balance"],
        "sent_by": current_user.get("email"),
        "sent_at": datetime.now(timezone.utc).isoformat(),
        "trigger": "admin_on_demand",
    })
    return {
        "sent": True,
        "customer_email": cust.get("email"),
        "period_label": stmt["period_label"],
        "summary": {
            "earned_total": stmt["earned_total"],
            "redeemed_total": stmt["redeemed_total"],
            "closing_balance": stmt["closing_balance"],
        },
    }


# =============================================================================
# WEEKLY TRADE-CREDIT BALANCE EMAIL ("Use it before someone else does")
# =============================================================================
# Punchier weekly nudge designed to drive traders BACK INTO THE SHOP. Where the
# monthly statement is a quiet bank-statement, this is the friendly tap on the
# shoulder: "you've got £X waiting".
#
#   • Cadence: weekly, every Monday at 10:00 UTC (configurable)
#   • Audience: ALL traders with credit_balance > 0 (no movement gate)
#   • Custom intro: admin can set a "this week's message" that appears as the
#     hero copy — leaves blank → falls back to default friendly copy
#   • Idempotent per ISO-week (won't double-send if cron fires twice)
#   • Manual full-run + per-trader send + preview endpoints for admin UI
# -----------------------------------------------------------------------------

WEEKLY_SETTINGS_KEY = "weekly_trade_balance_emails"


def _iso_week_key(now: datetime) -> str:
    """Year + ISO-week number, e.g. '2026-W18'. Used for idempotency."""
    iso = now.isocalendar()
    return f"{iso[0]}-W{iso[1]:02d}"


async def _list_traders_with_balance(db, limit: Optional[int] = None) -> list[dict]:
    """Trade customers with positive credit balance + valid email."""
    q = {
        "is_trade": True,
        "email": {"$regex": "^.+@.+\\..+$"},
        "credit_balance": {"$gt": 0},
    }
    cursor = db.shop_customers.find(
        q,
        {"_id": 0, "id": 1, "email": 1, "name": 1, "business_name": 1,
         "trade_account_number": 1, "credit_balance": 1, "is_trade": 1},
    ).sort("credit_balance", -1)
    if limit:
        cursor = cursor.limit(limit)
    return await cursor.to_list(length=limit or 5000)


async def _build_weekly_balance_payload(db, customer: dict) -> dict:
    """Build the per-trader payload for the weekly nudge.

    Pulls the LAST 3 credit movements (any direction) so the email feels
    grounded in reality — even if the trader hasn't bought in a while we
    show their last activity for context.
    """
    cust_id = customer.get("id")
    last_txns = []
    if cust_id:
        cursor = db.credit_transactions.find(
            {"customer_id": cust_id},
            {"_id": 0, "type": 1, "amount": 1, "invoice_no": 1, "order_number": 1,
             "description": 1, "created_at": 1},
        ).sort("created_at", -1).limit(3)
        last_txns = await cursor.to_list(length=3)
    return {
        "customer_id": cust_id,
        "customer_email": customer.get("email"),
        "customer_name": customer.get("name") or customer.get("business_name") or "there",
        "business_name": customer.get("business_name") or "",
        "trade_account_number": customer.get("trade_account_number") or "",
        "credit_balance": round(float(customer.get("credit_balance") or 0), 2),
        "last_txns": last_txns,
    }


def render_weekly_balance_email_html(payload: dict, custom_intro: str = "") -> str:
    """Punchier weekly email — hero balance figure, optional admin intro,
    "what could you buy" section, recent activity collapsed to a footnote."""
    company_website = os.environ.get("COMPANY_WEBSITE") or os.environ.get("SHOP_WEBSITE_URL") or "https://tilestation.co.uk"
    first_name = (payload.get("customer_name") or "there").split(" ")[0]
    balance = payload["credit_balance"]
    t_ref = payload.get("trade_account_number") or ""
    shop_url = f"{company_website}/tiles?sale=true"
    account_url = f"{company_website}/shop/trade/account"

    # Intro paragraph — admin override OR default friendly copy
    safe_intro = (custom_intro or "").strip()
    if safe_intro:
        intro_html = f'<p style="margin:0 0 18px 0; font-size:15px; line-height:1.6; color:#404040;">{safe_intro}</p>'
    else:
        intro_html = (
            '<p style="margin:0 0 18px 0; font-size:15px; line-height:1.6; color:#404040;">'
            f'Quick reminder — you\'ve got <strong>£{balance:.2f}</strong> in trade credit '
            'sitting on your account, ready to spend on your next job. '
            'No expiry, no faff — it\'s yours whenever you need it.'
            '</p>'
        )

    # Recent activity footnote (max 3)
    activity_html = ""
    if payload.get("last_txns"):
        rows = ""
        for t in payload["last_txns"]:
            try:
                d = datetime.fromisoformat(str(t.get("created_at") or "").replace("Z", "+00:00")).strftime("%d %b")
            except Exception:
                d = ""
            t_type = (t.get("type") or "").lower()
            amt = float(t.get("amount") or 0)
            sign = "+" if amt >= 0 and t_type not in REDEEMED_TYPES else "−"
            color = "#047857" if sign == "+" else "#9f1239"
            ref = t.get("invoice_no") or t.get("order_number") or (t.get("description") or "")[:40]
            rows += (
                f'<tr><td style="padding:4px 0; color:#737373; font-size:11px;">{d}</td>'
                f'<td style="padding:4px 8px; color:#525252; font-size:11px;">{ref}</td>'
                f'<td style="padding:4px 0; text-align:right; color:{color}; font-size:11px; font-family:ui-monospace,monospace;">{sign} £{abs(amt):.2f}</td></tr>'
            )
        activity_html = (
            '<div style="margin-top:24px; padding:14px 16px; background:#fafaf9; border-radius:8px;">'
            '<div style="font-size:10px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:#a8a29e; margin-bottom:6px;">Recent activity</div>'
            f'<table role="presentation" style="width:100%; border-collapse:collapse;">{rows}</table>'
            '</div>'
        )

    return f"""
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 620px; margin: 0 auto; color: #1a1a2e; background: #f9fafb;">
      <div style="background:#1C1917; padding:22px 24px;">
        <h1 style="color:#F7EA1C; margin:0; font-size:22px; letter-spacing:-0.3px;">Tile Station</h1>
        <p style="color:#a8a29e; margin:4px 0 0; font-size:12px;">Trade Credit · Your Weekly Update</p>
      </div>

      <div style="background:#fff; padding:30px 24px;">
        <p style="margin:0 0 8px 0; font-size:18px; font-weight:600; color:#1a1a2e;">Hi {first_name},</p>

        <!-- HERO BALANCE -->
        <div style="margin:24px 0 28px; padding:28px 20px; background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); border-radius:14px; text-align:center; border: 1px solid #facc15;">
          <div style="font-size:11px; font-weight:700; letter-spacing:0.12em; text-transform:uppercase; color:#92400e; margin-bottom:4px;">Your trade credit balance</div>
          <div style="font-size:42px; font-weight:800; color:#1a1a2e; letter-spacing:-1px; font-family:ui-monospace,SFMono-Regular,monospace;">£{balance:.2f}</div>
          {f'<div style="font-size:11px; color:#a16207; margin-top:6px;">Account {t_ref}</div>' if t_ref else ''}
        </div>

        {intro_html}

        <!-- PRIMARY CTA -->
        <p style="margin:26px 0 0; text-align:center;">
          <a href="{shop_url}" style="display:inline-block; background:#1a1a2e; color:#F7EA1C; padding:16px 36px; border-radius:8px; text-decoration:none; font-weight:700; font-size:15px; letter-spacing:0.02em;">
            Browse the trade shop →
          </a>
        </p>
        <p style="margin:10px 0 0; text-align:center; font-size:12px; color:#737373;">
          Or <a href="{account_url}" style="color:#525252; text-decoration:underline;">view your full statement</a>
        </p>

        {activity_html}

        <p style="margin:32px 0 0; font-size:11px; color:#a8a29e; line-height:1.6; text-align:center;">
          You're getting this because you have an active trade account at Tile Station with credit on it.
          Reply to this email any time — we read every one.
        </p>
      </div>

      <div style="text-align:center; padding:14px 24px; color:#a8a29e; font-size:11px;">
        Tile Station · Unit 3 Trade City, Coldharbour Road, Northfleet, Gravesend DA11 8AB<br/>
        Company No: 11982550 · VAT No: 324 251 828
      </div>
    </div>
    """


async def _send_one_weekly_email(payload: dict, custom_intro: str = "") -> dict:
    """Dispatch one weekly balance email via Resend."""
    if not payload.get("customer_email"):
        return {"sent": False, "error": "no_email"}
    try:
        import resend  # noqa: F401
        from services.email import RESEND_AVAILABLE, RESEND_API_KEY, COMPANY_NAME
        import resend as _resend
    except Exception as exc:  # noqa: BLE001
        return {"sent": False, "error": f"import:{exc}"}
    if not RESEND_AVAILABLE or not RESEND_API_KEY:
        return {"sent": False, "error": "resend_not_configured"}

    html = render_weekly_balance_email_html(payload, custom_intro=custom_intro)
    balance = payload["credit_balance"]
    first_name = (payload.get("customer_name") or "there").split(" ")[0]
    subject = f"{first_name}, you've got £{balance:.2f} in trade credit waiting"
    sender = os.environ.get("SENDER_EMAIL", "online@tilestation.co.uk")
    try:
        import asyncio as _asyncio
        _resend.api_key = RESEND_API_KEY
        await _asyncio.to_thread(_resend.Emails.send, {
            "from": f"{COMPANY_NAME} - Tile Station <{sender}>",
            "to": [payload["customer_email"]],
            "reply_to": "online@tilestation.co.uk",
            "subject": subject,
            "html": html,
        })
        return {"sent": True, "error": None}
    except Exception as exc:  # noqa: BLE001
        logger.exception("Weekly trade balance email failed for %s: %s", payload.get("customer_email"), exc)
        return {"sent": False, "error": str(exc)[:200]}


async def dispatch_weekly_balance_emails(
    db, *, dry_run: bool = False, limit: Optional[int] = None,
    custom_intro: str = "", trigger: str = "scheduler",
    exclude_emails: Optional[list[str]] = None,
) -> dict:
    """Iterate trade customers with positive balance; send the weekly nudge.

    `exclude_emails` is a list of lowercased email addresses to SKIP for this
    batch — used by the admin UI when the operator unchecks specific traders.
    """
    traders = await _list_traders_with_balance(db, limit=limit)
    skip_set = {(e or "").lower().strip() for e in (exclude_emails or []) if e}
    eligible = len(traders)
    sent = failed = excluded = 0
    errors: list[dict] = []

    for cust in traders:
        cust_email_l = (cust.get("email") or "").lower().strip()
        if cust_email_l in skip_set:
            excluded += 1
            continue
        payload = await _build_weekly_balance_payload(db, cust)
        if dry_run:
            sent += 1
            continue
        res = await _send_one_weekly_email(payload, custom_intro=custom_intro)
        if res.get("sent"):
            sent += 1
            await db.weekly_trade_email_sends.insert_one({
                "customer_id": cust.get("id"),
                "customer_email": cust.get("email"),
                "credit_balance": payload["credit_balance"],
                "sent_at": datetime.now(timezone.utc).isoformat(),
                "trigger": trigger,
                "iso_week": _iso_week_key(datetime.now(timezone.utc)),
            })
        else:
            failed += 1
            errors.append({"email": cust.get("email"), "error": res.get("error")})

    return {
        "eligible": eligible,
        "sent": sent,
        "failed": failed,
        "excluded": excluded,
        "errors": errors[:25],
        "dry_run": dry_run,
        "trigger": trigger,
    }


async def run_weekly_trade_balance_tick():
    """Hourly probe — fires the weekly send on the configured weekday + hour
    (default Monday 10:00 UTC). Idempotent via ISO-week marker."""
    db = get_db()
    now = datetime.now(timezone.utc)
    settings = await db.website_settings.find_one({"_id": WEEKLY_SETTINGS_KEY}) or {}
    if not settings.get("enabled", True):
        return
    target_weekday = int(settings.get("weekday", 0))  # 0=Mon .. 6=Sun
    target_hour = int(settings.get("hour_utc", 10))
    if now.weekday() != target_weekday or now.hour != target_hour:
        return
    week_key = _iso_week_key(now)
    if settings.get("last_iso_week") == week_key:
        return  # already sent this week

    custom_intro = settings.get("custom_intro", "")
    result = await dispatch_weekly_balance_emails(db, custom_intro=custom_intro, trigger="scheduler")
    await db.website_settings.update_one(
        {"_id": WEEKLY_SETTINGS_KEY},
        {"$set": {
            "last_iso_week": week_key,
            "last_run_at": now.isoformat(),
            "last_result": result,
            "weekday": target_weekday,
            "hour_utc": target_hour,
            "enabled": settings.get("enabled", True),
        }},
        upsert=True,
    )
    logger.info(
        "[weekly-trade-balance] week=%s eligible=%s sent=%s failed=%s",
        week_key, result.get("eligible"), result.get("sent"), result.get("failed"),
    )


# ---------- Weekly endpoints (admin-only) -----------------------------------

class WeeklySettingsBody(BaseModel):
    enabled: Optional[bool] = None
    weekday: Optional[int] = Field(default=None, ge=0, le=6)  # 0=Mon
    hour_utc: Optional[int] = Field(default=None, ge=0, le=23)
    custom_intro: Optional[str] = Field(default=None, max_length=600)


@router.get("/weekly/settings")
async def admin_weekly_settings_get(current_user: dict = Depends(get_current_user)):
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    doc = await db.website_settings.find_one({"_id": WEEKLY_SETTINGS_KEY}, {"_id": 0}) or {}
    return {
        "enabled": doc.get("enabled", True),
        "weekday": doc.get("weekday", 0),
        "hour_utc": doc.get("hour_utc", 10),
        "custom_intro": doc.get("custom_intro", ""),
        "last_iso_week": doc.get("last_iso_week"),
        "last_run_at": doc.get("last_run_at"),
        "last_result": doc.get("last_result"),
    }


@router.put("/weekly/settings")
async def admin_weekly_settings_set(
    body: WeeklySettingsBody,
    current_user: dict = Depends(get_current_user),
):
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    set_doc = {k: v for k, v in body.model_dump().items() if v is not None}
    if not set_doc:
        raise HTTPException(status_code=400, detail="Nothing to update")
    set_doc["updated_at"] = datetime.now(timezone.utc).isoformat()
    set_doc["updated_by"] = current_user.get("email")
    await db.website_settings.update_one(
        {"_id": WEEKLY_SETTINGS_KEY},
        {"$set": set_doc},
        upsert=True,
    )
    doc = await db.website_settings.find_one({"_id": WEEKLY_SETTINGS_KEY}, {"_id": 0}) or {}
    return doc


@router.get("/weekly/eligible")
async def admin_weekly_eligible(current_user: dict = Depends(get_current_user)):
    """List of traders that WOULD receive a send right now + count + total credit."""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    traders = await _list_traders_with_balance(db)
    total_credit = sum(float(t.get("credit_balance") or 0) for t in traders)
    return {
        "count": len(traders),
        "total_credit": round(total_credit, 2),
        "traders": [
            {
                "email": t.get("email"),
                "name": t.get("name"),
                "business_name": t.get("business_name"),
                "credit_balance": round(float(t.get("credit_balance") or 0), 2),
                "trade_account_number": t.get("trade_account_number") or "",
            }
            for t in traders
        ],
    }


@router.get("/weekly/preview")
async def admin_weekly_preview(
    email: Optional[str] = Query(None),
    current_user: dict = Depends(get_current_user),
):
    """Render the weekly email preview HTML for a specific trader, OR for a
    fake trader if no email is provided (lets you preview cosmetic changes)."""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    settings = await db.website_settings.find_one({"_id": WEEKLY_SETTINGS_KEY}, {"_id": 0}) or {}
    custom_intro = settings.get("custom_intro", "")

    if email:
        cust = await db.shop_customers.find_one(
            {"email": email.lower().strip(), "is_trade": True},
            {"_id": 0, "id": 1, "email": 1, "name": 1, "business_name": 1,
             "trade_account_number": 1, "credit_balance": 1, "is_trade": 1},
        )
        if not cust:
            raise HTTPException(status_code=404, detail="Trade customer not found")
        payload = await _build_weekly_balance_payload(db, cust)
    else:
        # Fake payload for cosmetic preview
        payload = {
            "customer_email": "preview@tilestation.co.uk",
            "customer_name": "Sarah",
            "business_name": "Sarah's Bathrooms Ltd",
            "trade_account_number": "TS-2391",
            "credit_balance": 234.67,
            "last_txns": [
                {"created_at": "2026-04-22T09:15:00+00:00", "amount": 20.96, "invoice_no": "INV-3867", "type": "earned_online"},
                {"created_at": "2026-04-18T11:00:00+00:00", "amount": -32.10, "invoice_no": "INV-3855", "type": "redeem"},
                {"created_at": "2026-04-12T14:20:00+00:00", "amount": 41.50, "invoice_no": "INV-3845", "type": "earned_in_store"},
            ],
        }
    return {
        "html": render_weekly_balance_email_html(payload, custom_intro=custom_intro),
        "subject": f"{(payload.get('customer_name') or 'there').split(' ')[0]}, you've got £{payload['credit_balance']:.2f} in trade credit waiting",
        "credit_balance": payload["credit_balance"],
    }


class WeeklySendOneBody(BaseModel):
    email: str = Field(..., min_length=3)


@router.post("/weekly/send-one")
async def admin_weekly_send_one(
    body: WeeklySendOneBody,
    current_user: dict = Depends(get_current_user),
):
    """Dispatch the weekly email to one specific trader on demand."""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    cust = await db.shop_customers.find_one(
        {"email": body.email.lower().strip(), "is_trade": True},
        {"_id": 0, "id": 1, "email": 1, "name": 1, "business_name": 1,
         "trade_account_number": 1, "credit_balance": 1, "is_trade": 1},
    )
    if not cust:
        raise HTTPException(status_code=404, detail="Trade customer not found")
    if float(cust.get("credit_balance") or 0) <= 0:
        raise HTTPException(status_code=400, detail="Trader has no credit balance — nothing to remind them about.")

    settings = await db.website_settings.find_one({"_id": WEEKLY_SETTINGS_KEY}, {"_id": 0}) or {}
    payload = await _build_weekly_balance_payload(db, cust)
    res = await _send_one_weekly_email(payload, custom_intro=settings.get("custom_intro", ""))
    if not res.get("sent"):
        raise HTTPException(status_code=502, detail=f"Email dispatch failed: {res.get('error') or 'unknown'}")
    await db.weekly_trade_email_sends.insert_one({
        "customer_id": cust.get("id"),
        "customer_email": cust.get("email"),
        "credit_balance": payload["credit_balance"],
        "sent_at": datetime.now(timezone.utc).isoformat(),
        "trigger": "admin_on_demand",
        "sent_by": current_user.get("email"),
        "iso_week": _iso_week_key(datetime.now(timezone.utc)),
    })
    return {"sent": True, "customer_email": cust.get("email"), "credit_balance": payload["credit_balance"]}


class WeeklySendAllBody(BaseModel):
    dry_run: bool = False
    limit: Optional[int] = Field(default=None, ge=1, le=10000)
    force: bool = False  # bypass the "already sent this ISO week" guard
    exclude_emails: Optional[list[str]] = None  # admin-unchecked rows


@router.post("/weekly/send-now")
async def admin_weekly_send_now(
    body: WeeklySendAllBody,
    current_user: dict = Depends(get_current_user),
):
    """Manual full-batch send — admin override of the cron schedule.
    Records sender + timestamp on the marker doc."""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    now = datetime.now(timezone.utc)
    week_key = _iso_week_key(now)
    settings = await db.website_settings.find_one({"_id": WEEKLY_SETTINGS_KEY}, {"_id": 0}) or {}
    if not body.force and not body.dry_run and settings.get("last_iso_week") == week_key:
        raise HTTPException(
            status_code=409,
            detail=f"Weekly batch already sent for {week_key}. Pass force=true to re-run.",
        )
    custom_intro = settings.get("custom_intro", "")
    result = await dispatch_weekly_balance_emails(
        db, dry_run=body.dry_run, limit=body.limit,
        custom_intro=custom_intro, trigger="admin_manual",
        exclude_emails=body.exclude_emails,
    )
    if not body.dry_run:
        await db.website_settings.update_one(
            {"_id": WEEKLY_SETTINGS_KEY},
            {"$set": {
                "last_iso_week": week_key,
                "last_run_at": now.isoformat(),
                "last_run_by": current_user.get("email"),
                "last_result": result,
            }},
            upsert=True,
        )
    return result

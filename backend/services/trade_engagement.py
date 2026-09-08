"""Trade engagement: credit expiry, dormant win-back nudges, engagement log.

All emails go through the same Resend pipeline as the rest of the app and
every send is written to `trade_engagement_log` so the Trader 360 timeline
shows exactly what the customer has received."""
import logging
import uuid
from datetime import datetime, timezone, timedelta

from services.email import send_simple_email_if_possible, COMPANY_NAME, SENDER_EMAIL
from services.password_links import frontend_base_url

logger = logging.getLogger(__name__)

REMINDER_STEPS = (30, 7)  # days before expiry


def _now():
    return datetime.now(timezone.utc)


def _iso(dt):
    return dt.isoformat()


def parse_date(value):
    """Accepts 'YYYY-MM-DD' or ISO datetime → aware UTC datetime (end of day for bare dates)."""
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    s = str(value).strip()
    try:
        if len(s) == 10:
            return datetime.fromisoformat(s).replace(hour=23, minute=59, second=59, tzinfo=timezone.utc)
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


async def log_event(db, customer_id: str, kind: str, summary: str, *, meta: dict = None, actor: str = None):
    doc = {
        "id": str(uuid.uuid4()),
        "customer_id": customer_id,
        "kind": kind,
        "summary": summary,
        "meta": meta or {},
        "actor": actor,
        "created_at": _iso(_now()),
    }
    await db.trade_engagement_log.insert_one(doc)
    doc.pop("_id", None)
    return doc


def _shell(title: str, body_html: str, cta_label: str, cta_href: str) -> str:
    return f"""
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9fafb;">
      <div style="background:#333333;padding:28px 20px;text-align:center;">
        <h1 style="color:#F7EA1C;margin:0;font-size:24px;">{COMPANY_NAME}</h1>
        <p style="color:#ccc;margin:8px 0 0;font-size:14px;">Trade Account</p>
      </div>
      <div style="background:#fff;padding:30px 20px;">
        <h2 style="color:#333;margin:0 0 12px;">{title}</h2>
        {body_html}
        <p style="text-align:center;margin:28px 0;">
          <a href="{cta_href}" style="background:#333333;color:#F7EA1C;padding:14px 32px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;">{cta_label}</a>
        </p>
      </div>
      <div style="background:#f3f4f6;padding:16px;text-align:center;">
        <p style="color:#9ca3af;font-size:12px;margin:0;">&copy; {_now().year} {COMPANY_NAME}</p>
      </div>
    </div>"""


def _first_name(customer: dict) -> str:
    return (customer.get("name") or "").strip().split(" ")[0] or "there"


async def send_credit_expiry_reminder(db, customer: dict, *, actor: str = None) -> dict:
    balance = float(customer.get("credit_balance") or 0)
    expires = parse_date(customer.get("credit_expires_at"))
    if balance <= 0 or not expires:
        return {"success": False, "error": "No credit balance or no expiry date set"}
    days_left = max(0, (expires - _now()).days)
    when = expires.strftime("%d %B %Y")
    ref = customer.get("trade_account_number") or ""
    body = (f"<p style=\"color:#666;line-height:1.6;\">Hi {_first_name(customer)}, you have "
            f"<strong>£{balance:.2f} trade credit</strong> on account <strong>{ref}</strong> that expires on "
            f"<strong>{when}</strong>{' — that is ' + str(days_left) + ' days away' if days_left else ' — today'}.</p>"
            f"<p style=\"color:#666;line-height:1.6;\">Use it against your next order online or in any showroom — "
            f"just quote your trade reference at the till.</p>")
    html = _shell("Your trade credit is about to expire", body, "Use my credit", f"{frontend_base_url()}/shop/trade/login")
    result = await send_simple_email_if_possible(
        customer["email"], f"£{balance:.2f} trade credit expires {when} — {COMPANY_NAME}", html,
        from_override=f"{COMPANY_NAME} <{SENDER_EMAIL}>")
    await log_event(db, customer["id"], "credit_expiry_reminder",
                    f"Credit expiry reminder emailed (£{balance:.2f}, expires {when})",
                    meta={"days_left": days_left, "email_sent": bool(result.get("success")), "error": result.get("error")},
                    actor=actor)
    return {"success": bool(result.get("success")), "error": result.get("error"), "days_left": days_left}


async def send_dormant_nudge(db, customer: dict, *, actor: str = None) -> dict:
    balance = float(customer.get("credit_balance") or 0)
    ref = customer.get("trade_account_number") or ""
    hook = (f"<p style=\"color:#666;line-height:1.6;\">You still have <strong>£{balance:.2f} trade credit</strong> "
            f"waiting on account <strong>{ref}</strong>.</p>") if balance > 0 else ""
    body = (f"<p style=\"color:#666;line-height:1.6;\">Hi {_first_name(customer)}, it's been a while since your last "
            f"order with {COMPANY_NAME}. Your trade account is still live — trade prices show as soon as you sign in, "
            f"and you earn credit back on every purchase online or in store.</p>{hook}"
            f"<p style=\"color:#666;line-height:1.6;\">Got a job coming up? Reply to this email or drop into your local "
            f"showroom and we'll price it up for you.</p>")
    html = _shell("We've missed you", body, "See trade prices", f"{frontend_base_url()}/shop/trade/login")
    result = await send_simple_email_if_possible(
        customer["email"], f"Your trade account is waiting — {COMPANY_NAME}", html,
        from_override=f"{COMPANY_NAME} <{SENDER_EMAIL}>")
    await db.shop_customers.update_one({"id": customer["id"]}, {"$set": {"last_nudge_at": _iso(_now())}})
    await log_event(db, customer["id"], "dormant_nudge", "Win-back email sent",
                    meta={"credit_balance": balance, "email_sent": bool(result.get("success")), "error": result.get("error")},
                    actor=actor)
    return {"success": bool(result.get("success")), "error": result.get("error")}


async def expire_customer_credit(db, customer: dict, *, actor: str = None, reason: str = "Credit expired") -> dict:
    balance = round(float(customer.get("credit_balance") or 0), 2)
    if balance <= 0:
        await db.shop_customers.update_one({"id": customer["id"]}, {"$set": {"credit_expires_at": None}})
        return {"success": True, "expired": 0.0}
    now = _iso(_now())
    await db.credit_transactions.insert_one({
        "id": str(uuid.uuid4()),
        "customer_id": customer["id"],
        "trade_account_number": customer.get("trade_account_number"),
        "type": "expired",
        "amount": -balance,
        "balance_after": 0.0,
        "source": "credit_expiry",
        "description": reason,
        "actor": actor,
        "created_at": now,
    })
    await db.shop_customers.update_one(
        {"id": customer["id"]},
        {"$set": {"credit_balance": 0.0, "credit_expired_at": now, "credit_expires_at": None, "credit_expiry_reminders": {}}})
    await log_event(db, customer["id"], "credit_expired", f"£{balance:.2f} trade credit expired", meta={"amount": balance}, actor=actor)
    return {"success": True, "expired": balance}


async def run_trade_credit_expiry_job() -> dict:
    """Daily: remind at 30 / 7 days before expiry, expire on the day."""
    from server import db
    now = _now()
    stats = {"reminded": 0, "expired": 0, "errors": 0}
    cursor = db.shop_customers.find(
        {"is_trade": True, "credit_expires_at": {"$nin": [None, ""]}, "credit_balance": {"$gt": 0}},
        {"_id": 0, "password": 0})
    async for customer in cursor:
        try:
            expires = parse_date(customer.get("credit_expires_at"))
            if not expires:
                continue
            if expires <= now:
                await expire_customer_credit(db, customer, actor="scheduler")
                stats["expired"] += 1
                continue
            days_left = (expires - now).days
            sent = customer.get("credit_expiry_reminders") or {}
            for step in REMINDER_STEPS:
                if days_left <= step and str(step) not in sent:
                    await send_credit_expiry_reminder(db, customer, actor="scheduler")
                    await db.shop_customers.update_one(
                        {"id": customer["id"]}, {"$set": {f"credit_expiry_reminders.{step}": _iso(now)}})
                    stats["reminded"] += 1
                    break
        except Exception:  # noqa: BLE001 — one bad account must not stop the sweep
            logger.exception("credit expiry job failed for %s", customer.get("id"))
            stats["errors"] += 1
    logger.info("Trade credit expiry job: %s", stats)
    return stats


def dormant_cutoff(days: int = 60) -> str:
    return _iso(_now() - timedelta(days=days))

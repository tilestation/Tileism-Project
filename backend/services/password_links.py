"""Password reset / first-time setup links shared by staff (`users`) and
storefront customers (`shop_customers`). One token store: `password_resets`."""
import os
import re
import secrets
import logging
from datetime import datetime, timezone, timedelta

from services.email import send_simple_email_if_possible, COMPANY_NAME, SENDER_EMAIL

SHOP_LOGIN_PATH = "/shop/tile-login"
TRADE_LOGIN_PATH = "/shop/trade/login"
STAFF_LOGIN_PATH = "/admin/login"


def frontend_base_url() -> str:
    url = (os.environ.get("FRONTEND_URL") or os.environ.get("SHOP_WEBSITE_URL")
           or os.environ.get("REACT_APP_BACKEND_URL") or "https://tilestation.co.uk")
    return url.rstrip("/").replace("/api", "")


def normalize_email(email: str) -> str:
    return (email or "").strip().lower()


def email_query(email: str) -> dict:
    """Exact, case-insensitive match — legacy docs may hold mixed-case addresses."""
    return {"email": {"$regex": f"^{re.escape(normalize_email(email))}$", "$options": "i"}}


def login_path_for(account_type: str, is_trade: bool) -> str:
    if account_type == "staff":
        return STAFF_LOGIN_PATH
    return TRADE_LOGIN_PATH if is_trade else SHOP_LOGIN_PATH


async def find_account(db, email: str):
    """Returns (account_type, doc) for whichever collection owns the email."""
    q = email_query(email)
    staff = await db.users.find_one(q, {"_id": 0, "password": 0})
    if staff:
        return "staff", staff
    customer = await db.shop_customers.find_one(q, {"_id": 0, "password": 0})
    if customer:
        return "shop", customer
    return None, None


async def create_password_link(db, *, email: str, account_type: str, account_id: str = None,
                               is_trade: bool = False, purpose: str = "reset", hours: int = 1) -> dict:
    email = normalize_email(email)
    token = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(hours=hours)
    await db.password_resets.delete_many({"email": email})
    await db.password_resets.insert_one({
        "email": email,
        "account_type": account_type,
        "account_id": account_id,
        "is_trade": bool(is_trade),
        "purpose": purpose,
        "token": token,
        "expires_at": expires_at.isoformat(),
        "created_at": now.isoformat(),
    })
    kind = "staff" if account_type == "staff" else ("trade" if is_trade else "shop")
    link = f"{frontend_base_url()}/reset-password?token={token}&for={kind}"
    return {"token": token, "link": link, "expires_at": expires_at.isoformat()}


def _link_email_html(*, name: str, link: str, purpose: str, is_trade: bool,
                     trade_account_number: str = "", hours: int = 1) -> str:
    first = (name or "").strip().split(" ")[0] or "there"
    if purpose == "setup":
        title = "Set up your online Trade account" if is_trade else "Set up your online account"
        ref = f'<p style="color:#666;line-height:1.6;">Your trade reference is <strong>{trade_account_number}</strong>.</p>' if trade_account_number else ""
        body = (f"<p style=\"color:#666;line-height:1.6;\">Hi {first}, your {'Trade ' if is_trade else ''}account with "
                f"{COMPANY_NAME} is ready for online ordering. Choose a password to get started — "
                f"{'you will see your trade prices as soon as you sign in' if is_trade else 'you can then track orders and reorder in a couple of clicks'}.</p>{ref}")
        cta = "Choose my password"
    else:
        title = "Reset your password"
        body = (f"<p style=\"color:#666;line-height:1.6;\">Hi {first}, we received a request to reset the password for your "
                f"{COMPANY_NAME}{' Trade' if is_trade else ''} account. Click below to choose a new one.</p>")
        cta = "Reset password"
    expiry = f"{hours} hour{'s' if hours != 1 else ''}" if hours < 48 else f"{hours // 24} days"
    return f"""
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9fafb;">
      <div style="background:#333333;padding:28px 20px;text-align:center;">
        <h1 style="color:#F7EA1C;margin:0;font-size:24px;">{COMPANY_NAME}</h1>
        <p style="color:#ccc;margin:8px 0 0;font-size:14px;">{'Trade Account' if is_trade else 'Online Account'}</p>
      </div>
      <div style="background:#fff;padding:30px 20px;">
        <h2 style="color:#333;margin:0 0 12px;">{title}</h2>
        {body}
        <p style="text-align:center;margin:28px 0;">
          <a href="{link}" style="background:#333333;color:#F7EA1C;padding:14px 32px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;">{cta}</a>
        </p>
        <p style="color:#666;font-size:13px;">Or paste this link into your browser:</p>
        <p style="word-break:break-all;color:#666;font-size:13px;">{link}</p>
        <p style="color:#999;font-size:13px;">This link expires in {expiry}. If you didn't expect this email you can safely ignore it.</p>
      </div>
      <div style="background:#f3f4f6;padding:16px;text-align:center;">
        <p style="color:#9ca3af;font-size:12px;margin:0;">&copy; {datetime.now().year} {COMPANY_NAME}</p>
      </div>
    </div>"""


async def send_password_link_email(*, to: str, name: str, link: str, purpose: str = "reset",
                                   is_trade: bool = False, trade_account_number: str = "",
                                   hours: int = 1) -> dict:
    if purpose == "setup":
        subject = f"Set up your online {'Trade ' if is_trade else ''}account — {COMPANY_NAME}"
    else:
        subject = f"Reset your password — {COMPANY_NAME}"
    html = _link_email_html(name=name, link=link, purpose=purpose, is_trade=is_trade,
                            trade_account_number=trade_account_number, hours=hours)
    result = await send_simple_email_if_possible(
        to, subject, html, from_override=f"{COMPANY_NAME} <{SENDER_EMAIL}>")
    if not result.get("success"):
        logging.warning("Password link email to %s not sent: %s", to, result.get("error"))
    return result

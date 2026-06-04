"""
Expired-Quote Recovery — admin tool to win back lapsed quotes
via a personalised email + a one-off discount code.

User flow (3 Jun 2026):
1. Admin opens an "Expired Quotes" tab → sees the 103 expired quotes
2. Selects one (or many) → picks a % from a dropdown (admin-set per
   code, per user choice 2c)
3. System mints a `shop_discount_codes` entry locked to that customer
   email, then sends a Resend email with the code + a one-click link
4. Recovery attempts are logged on the quote doc so we can measure
   win-back rate later

The discount-code persistence reuses the existing `shop_discount_codes`
collection (handled in /api/shop/discount-codes — see shop.py:2468).
This module only adds:
  - GET /api/quote-recovery/expired-quotes — listing endpoint
  - POST /api/quote-recovery/send-recovery — mint code + email

Reasoning: lifting these into a dedicated route keeps quote-recovery
analytics isolated from the much larger shop.py file, and the
expired-quote query can be tuned independently as our definition of
"expired" evolves.
"""
import logging
import os
import re
from datetime import datetime, timezone, timedelta
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, EmailStr

from config import get_db
from services import get_current_user

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/quote-recovery", tags=["Quote Recovery"])

# A quote is considered EXPIRED 30 days after issue. Adjust here if
# the business changes its quote validity policy.
EXPIRY_DAYS = 30


def _is_expired(quote: dict, now: datetime) -> bool:
    """Return True iff quote.created_at is > EXPIRY_DAYS old AND it
    hasn't already been converted to an invoice."""
    if quote.get("converted_at") or quote.get("converted_to_invoice") or quote.get("converted_to_invoice_id"):
        return False
    created = quote.get("created_at")
    if not created:
        return False
    if isinstance(created, str):
        try:
            created = datetime.fromisoformat(created.replace("Z", "+00:00"))
        except ValueError:
            return False
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    return (now - created).days >= EXPIRY_DAYS


@router.get("/expired-quotes")
async def list_expired_quotes(
    limit: int = Query(default=200, ge=1, le=1000),
    current_user: dict = Depends(get_current_user),
):
    """List quotations older than EXPIRY_DAYS that haven't been
    converted to an invoice. Admin-only."""
    if (current_user or {}).get("role") not in {"super_admin", "admin", "manager"}:
        raise HTTPException(status_code=403, detail="Admin role required.")
    db = get_db()
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=EXPIRY_DAYS)

    # Pull everything that's old enough; filter the "not converted"
    # case in Python so the query catches both string & datetime
    # created_at variants the codebase uses.
    cursor = db.quotations.find(
        {
            "$or": [
                {"created_at": {"$lte": cutoff}},
                {"created_at": {"$lte": cutoff.isoformat()}},
            ],
            "$nor": [
                {"converted_at": {"$exists": True, "$ne": None}},
                {"converted_to_invoice": {"$exists": True, "$ne": None}},
                {"converted_to_invoice_id": {"$exists": True, "$ne": None}},
            ],
        },
        {
            "_id": 0,
            "id": 1,
            "quote_number": 1,
            "customer_name": 1,
            "customer_email": 1,
            "customer_phone": 1,
            "grand_total": 1,
            "total": 1,
            "sales_person": 1,
            "showroom_name": 1,
            "created_at": 1,
            "recovery_attempts": 1,
        },
    ).sort("created_at", -1).limit(int(limit))
    quotes = []
    async for q in cursor:
        if not _is_expired(q, now):
            continue
        created = q.get("created_at")
        if isinstance(created, datetime):
            q["created_at"] = created.isoformat()
        # Convenience: age in days for display.
        try:
            ts = datetime.fromisoformat(str(q["created_at"]).replace("Z", "+00:00"))
            q["age_days"] = (now - ts).days if ts else None
        except (ValueError, TypeError):
            q["age_days"] = None
        quotes.append(q)
    return {"total": len(quotes), "quotes": quotes}


class SendRecoveryReq(BaseModel):
    quote_id: str = Field(min_length=1)
    percent_off: int = Field(ge=1, le=50, description="Admin-picked discount %, 1-50")
    expires_days: int = Field(default=14, ge=1, le=90)
    custom_message: Optional[str] = Field(default=None, max_length=500)


def _generate_code(quote_number: Optional[str], percent_off: int) -> str:
    """Build a unique-ish, branded code: WB10-Q1234-ABCDE."""
    import secrets
    qn = re.sub(r"[^A-Z0-9]", "", (quote_number or "").upper())[:6] or "QT"
    tail = secrets.token_hex(3).upper()
    return f"WB{percent_off}-{qn}-{tail}"


@router.post("/send-recovery")
async def send_recovery_email(
    req: SendRecoveryReq,
    current_user: dict = Depends(get_current_user),
):
    """Mint a personalised discount code + send a recovery email."""
    if (current_user or {}).get("role") not in {"super_admin", "admin", "manager"}:
        raise HTTPException(status_code=403, detail="Admin role required.")

    db = get_db()
    quote = await db.quotations.find_one({"id": req.quote_id}, {"_id": 0})
    if not quote:
        raise HTTPException(status_code=404, detail="Quote not found.")
    customer_email = (quote.get("customer_email") or "").strip().lower()
    if not customer_email or "@" not in customer_email:
        raise HTTPException(status_code=400, detail="Quote has no valid customer email.")

    customer_name = quote.get("customer_name") or "there"
    quote_number = quote.get("quote_number") or req.quote_id[:8]
    grand_total = float(quote.get("grand_total") or quote.get("total") or 0)
    discount_amount = round(grand_total * (req.percent_off / 100), 2)

    # Mint the code on shop_discount_codes — same collection the
    # storefront's coupon-validate endpoint already understands, so
    # the customer can paste the code at checkout without any extra
    # backend work.
    now = datetime.now(timezone.utc)
    code = _generate_code(quote_number, req.percent_off)
    # Tiny retry loop in the (very unlikely) case of collision.
    for _ in range(3):
        existing = await db.shop_discount_codes.find_one({"code": code})
        if not existing:
            break
        code = _generate_code(quote_number, req.percent_off)
    code_doc = {
        "code": code,
        "percent_off": req.percent_off,
        "max_uses": 1,
        "used_count": 0,
        "email": customer_email,
        "source": "quote_recovery",
        "source_quote_id": req.quote_id,
        "source_quote_number": quote_number,
        "expires_at": now + timedelta(days=req.expires_days),
        "min_subtotal": 0,
        "active": True,
        "created_at": now,
        "updated_at": now,
        "created_by": (current_user or {}).get("email"),
    }
    await db.shop_discount_codes.insert_one(code_doc)

    # Compose & send email via Resend (mirroring the existing
    # cash_quotations / abandoned_carts pattern).
    site_url = os.environ.get("SHOP_URL", "https://tilestation.co.uk")
    redeem_url = f"{site_url}/shop?promo={code}"
    custom_block = (
        f"<p style='margin:16px 0 8px;font-size:15px'>{req.custom_message}</p>"
        if req.custom_message else ""
    )
    html_body = f"""
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:auto;padding:24px;color:#111">
      <p style="font-size:16px;margin:0 0 12px">Hi {customer_name},</p>
      <p style="font-size:15px;margin:0 0 12px">
        We're reaching out about quote <strong>{quote_number}</strong>
        — we'd love to get it across the line for you.
      </p>
      {custom_block}
      <p style="font-size:15px;margin:16px 0 12px">
        As a thank-you for your patience, here's a one-time
        <strong>{req.percent_off}% off</strong> code valid for the next {req.expires_days} days:
      </p>
      <div style="background:linear-gradient(135deg,#0d3b2e,#1a6a52);color:#fff;padding:24px;border-radius:12px;text-align:center;margin:16px 0">
        <div style="font-size:13px;opacity:.85;letter-spacing:0.15em;text-transform:uppercase">Your code</div>
        <div style="font-size:32px;font-weight:800;letter-spacing:0.08em;margin:8px 0">{code}</div>
        <div style="font-size:13px;opacity:.85">Saves you ~£{discount_amount:.2f} on quote {quote_number}</div>
      </div>
      <p style="margin:16px 0 8px;text-align:center">
        <a href="{redeem_url}" style="display:inline-block;background:#0d6efd;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600">Reactivate &amp; shop now &rarr;</a>
      </p>
      <p style="font-size:12px;color:#666;margin-top:24px">
        Tile Station · One-time use · expires {(now + timedelta(days=req.expires_days)).strftime('%d %b %Y')}.
      </p>
    </div>
    """
    sent_ok = False
    send_error: Optional[str] = None
    try:
        import resend
        api_key = os.environ.get("RESEND_API_KEY")
        if not api_key:
            send_error = "RESEND_API_KEY is not configured."
        else:
            resend.api_key = api_key
            resend.Emails.send({
                "from": os.environ.get("RESEND_FROM_EMAIL", "Tile Station <hello@tilestation.co.uk>"),
                "to": customer_email,
                "subject": f"Your quote {quote_number} — here's {req.percent_off}% off",
                "html": html_body,
                "tags": [
                    {"name": "type", "value": "quote_recovery"},
                    {"name": "quote_number", "value": quote_number},
                    {"name": "percent_off", "value": str(req.percent_off)},
                ],
            })
            sent_ok = True
    except Exception as e:
        send_error = f"{type(e).__name__}: {e}"
        logger.warning("Quote recovery email send failed for %s: %s", customer_email, e)

    # Log the recovery attempt on the quote doc.
    attempt = {
        "code": code,
        "percent_off": req.percent_off,
        "expires_days": req.expires_days,
        "customer_email": customer_email,
        "sent_at": now.isoformat(),
        "sent_ok": sent_ok,
        "sent_error": send_error,
        "sent_by": (current_user or {}).get("email"),
    }
    await db.quotations.update_one(
        {"id": req.quote_id},
        {"$push": {"recovery_attempts": attempt}},
    )

    return {
        "ok": sent_ok,
        "code": code,
        "percent_off": req.percent_off,
        "customer_email": customer_email,
        "redeem_url": redeem_url,
        "expires_at": code_doc["expires_at"].isoformat(),
        "email_send_error": send_error,
    }

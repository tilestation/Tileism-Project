"""
Abandoned Cart Recovery System.

Two-step sequence:
  - day_0_reminder  → sent ~3 hours after the cart was last touched (gentle reminder)
  - day_1_promo     → sent ~24 hours after the cart was last touched (10% off, single-use)

Settings live in `website_settings.abandoned_cart_settings` (super_admin can flip):
    enabled: bool                  default True
    day_0_hours: int               default 3
    day_1_hours: int               default 24
    discount_percent: int          default 10
    expires_days: int              default 7
"""
import uuid
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional, List
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, EmailStr

from config import get_db
from services import get_current_user
from services.email import send_email_notification
from services.promo_codes import generate_promo_code_for_email

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/abandoned-carts", tags=["Abandoned Carts"])

# ============ MODELS ============

class CartItem(BaseModel):
    product_id: str
    name: str
    price: float
    quantity: float
    image: Optional[str] = ""
    sku: Optional[str] = ""


class SaveCartRequest(BaseModel):
    customer_email: EmailStr
    customer_name: Optional[str] = ""
    customer_phone: Optional[str] = ""
    items: List[CartItem]
    cart_total: float


# ============ SETTINGS HELPER ============

DEFAULTS = {
    "enabled": True,
    "day_0_hours": 3,
    "day_1_hours": 24,
    "discount_percent": 10,
    "expires_days": 7,
    # Final "last chance, code expires tomorrow" nudge — only fires if the promo is still unused.
    "last_chance_enabled": True,
    "last_chance_hours_before_expiry": 24,
    # WhatsApp day-1 augmentation
    "whatsapp_enabled": False,
    "whatsapp_template_name": "abandoned_cart_promo",
    "whatsapp_language_code": "en",
}


async def _get_settings(db) -> dict:
    doc = await db.website_settings.find_one({"key": "abandoned_cart_settings"}, {"_id": 0})
    settings = dict(DEFAULTS)
    if doc and isinstance(doc.get("value"), dict):
        settings.update(doc["value"])
    return settings


def _require_admin(current_user: dict):
    if (current_user or {}).get("role") not in {"super_admin", "admin", "manager"}:
        raise HTTPException(status_code=403, detail="Admin access required")


def _require_super_admin(current_user: dict):
    if (current_user or {}).get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super Admin access required")


# ============ ROUTES ============

@router.post("/save")
async def save_abandoned_cart(cart_data: SaveCartRequest):
    """Save or update an abandoned cart. Called by the storefront whenever
    we have a customer email and a non-empty cart (typed at checkout, or a
    logged-in customer modifies their cart)."""
    db = get_db()

    cart_doc = {
        "customer_email": cart_data.customer_email.lower(),
        "customer_name": cart_data.customer_name,
        "customer_phone": (cart_data.customer_phone or "").strip(),
        "items": [item.dict() for item in cart_data.items],
        "cart_total": float(cart_data.cart_total),
        "updated_at": datetime.now(timezone.utc),
        "status": "abandoned",
    }

    existing = await db.abandoned_carts.find_one({
        "customer_email": cart_data.customer_email.lower(),
        "status": "abandoned",
    })

    if existing:
        # Reset reminder flags whenever cart contents change so a fresh sequence runs.
        cart_doc["reminder_sent_day_0"] = False
        cart_doc["reminder_sent_day_1"] = False
        cart_doc["reminder_sent_last_chance"] = False
        cart_doc["promo_code"] = None
        await db.abandoned_carts.update_one({"_id": existing["_id"]}, {"$set": cart_doc})
        return {"status": "updated", "id": existing.get("id")}

    cart_doc.update({
        "id": str(uuid.uuid4()),
        "created_at": datetime.now(timezone.utc),
        "reminder_sent_day_0": False,
        "reminder_sent_day_1": False,
        "reminder_sent_last_chance": False,
        "promo_code": None,
    })
    await db.abandoned_carts.insert_one(cart_doc)
    return {"status": "created", "id": cart_doc["id"]}


@router.post("/mark-recovered/{email}")
async def mark_cart_recovered(email: str):
    """Mark all abandoned carts for this email as recovered (called after a successful order)."""
    db = get_db()
    res = await db.abandoned_carts.update_many(
        {"customer_email": email.lower(), "status": "abandoned"},
        {"$set": {"status": "recovered", "recovered_at": datetime.now(timezone.utc)}},
    )
    return {"status": "success", "carts_recovered": res.modified_count}


# ============ EMAIL TEMPLATES ============

def _items_html(items: list) -> str:
    rows = []
    for item in items:
        name = (item.get("name") or "Product").replace("<", "&lt;")
        qty = item.get("quantity") or 1
        try:
            qty_str = f"{float(qty):.1f}".rstrip("0").rstrip(".")
        except Exception:
            qty_str = str(qty)
        try:
            price_str = f"£{float(item.get('price') or 0):.2f}"
        except Exception:
            price_str = "—"
        rows.append(f"""
        <tr>
          <td style="padding:12px;border-bottom:1px solid #eee;">
            <strong>{name}</strong><br>
            <small style="color:#777;">Qty: {qty_str}</small>
          </td>
          <td style="padding:12px;border-bottom:1px solid #eee;text-align:right;">{price_str}</td>
        </tr>""")
    return "".join(rows)


def _day_0_html(name: str, items: list, total: float) -> str:
    return f"""
<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;background:#fff;">
  <div style="background:#111;color:#F7EA1C;padding:24px;text-align:center;">
    <h1 style="margin:0;font-size:22px;letter-spacing:1px;">TILE STATION</h1>
  </div>
  <div style="padding:32px;">
    <h2 style="margin:0 0 8px 0;">Hi {name or 'there'},</h2>
    <p style="color:#444;line-height:1.5;">You left some lovely tiles in your basket. We've saved them for you — pick up exactly where you left off.</p>
    <table style="width:100%;border-collapse:collapse;margin:20px 0;">
      <thead>
        <tr style="background:#f6f6f6;">
          <th style="padding:10px;text-align:left;font-size:13px;color:#666;">Item</th>
          <th style="padding:10px;text-align:right;font-size:13px;color:#666;">Price</th>
        </tr>
      </thead>
      <tbody>{_items_html(items)}</tbody>
      <tfoot>
        <tr><td style="padding:14px;font-weight:bold;">Total</td>
            <td style="padding:14px;font-weight:bold;text-align:right;">£{total:.2f}</td></tr>
      </tfoot>
    </table>
    <div style="text-align:center;margin:28px 0;">
      <a href="https://tilestation.co.uk/shop/tile-cart"
         style="background:#F7EA1C;color:#111;padding:14px 36px;text-decoration:none;font-weight:bold;border-radius:6px;display:inline-block;">
        Return to my basket
      </a>
    </div>
    <p style="color:#777;font-size:13px;">Need help? Reply to this email or call us on <strong>01474 247 145</strong>.</p>
  </div>
</div>"""


def _share_block_html(referrer_email: str) -> str:
    share_url = f"https://tilestation.co.uk/shop/refer?ref={referrer_email}"
    return f"""
<div style="margin-top:28px;padding:20px;background:#F0FDF4;border:1px solid #BBF7D0;border-radius:8px;">
  <p style="margin:0 0 8px 0;font-weight:bold;color:#166534;">Know someone shopping for tiles?</p>
  <p style="margin:0 0 14px 0;font-size:14px;color:#166534;">Share a 10% off code with a friend. They save, and you'll be the legend who hooked them up.</p>
  <a href="{share_url}"
     style="background:#16A34A;color:#fff;padding:10px 22px;text-decoration:none;font-weight:bold;border-radius:6px;display:inline-block;font-size:14px;">
    Get my friend's code →
  </a>
</div>"""


def _day_1_html(name: str, items: list, total: float, code: str, percent: int, expires_at_iso: str, referrer_email: str = "") -> str:
    expires_str = ""
    try:
        if expires_at_iso:
            expires_str = datetime.fromisoformat(expires_at_iso.replace("Z", "+00:00")).strftime("%d %b %Y")
    except Exception:
        pass
    return f"""
<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;background:#fff;">
  <div style="background:#111;color:#F7EA1C;padding:24px;text-align:center;">
    <h1 style="margin:0;font-size:22px;letter-spacing:1px;">TILE STATION</h1>
  </div>
  <div style="padding:32px;">
    <h2 style="margin:0 0 8px 0;">Still thinking it over, {name or 'there'}?</h2>
    <p style="color:#444;line-height:1.5;">Here's <strong>{percent}% off</strong> to help you decide. Single-use code, just for you{(' — expires ' + expires_str) if expires_str else ''}.</p>

    <div style="background:#FFFBE6;border:2px dashed #F7EA1C;border-radius:8px;padding:18px;margin:20px 0;text-align:center;">
      <div style="font-size:13px;color:#666;letter-spacing:1px;text-transform:uppercase;">Your code</div>
      <div style="font-size:26px;font-weight:bold;letter-spacing:2px;color:#111;margin:6px 0;">{code}</div>
      <div style="font-size:13px;color:#666;">Apply at checkout</div>
    </div>

    <table style="width:100%;border-collapse:collapse;margin:20px 0;">
      <thead><tr style="background:#f6f6f6;">
        <th style="padding:10px;text-align:left;font-size:13px;color:#666;">Item</th>
        <th style="padding:10px;text-align:right;font-size:13px;color:#666;">Price</th>
      </tr></thead>
      <tbody>{_items_html(items)}</tbody>
      <tfoot><tr>
        <td style="padding:14px;font-weight:bold;">Total before discount</td>
        <td style="padding:14px;font-weight:bold;text-align:right;">£{total:.2f}</td>
      </tr></tfoot>
    </table>

    <div style="text-align:center;margin:28px 0;">
      <a href="https://tilestation.co.uk/shop/tile-cart?promo={code}"
         style="background:#F7EA1C;color:#111;padding:14px 36px;text-decoration:none;font-weight:bold;border-radius:6px;display:inline-block;">
        Apply discount &amp; checkout
      </a>
    </div>
    <p style="color:#777;font-size:13px;">Code is single-use and tied to this email.</p>
    {_share_block_html(referrer_email) if referrer_email else ""}
  </div>
</div>"""


# ============ SEND ============

async def _send_day_0(cart: dict) -> bool:
    """Route the day-0 reminder through the marketing outbox.

    22 Jun 2026 — every promotional email now flows through
    `services.marketing_outbox.queue_email` so the owner can review
    each one in `/admin/marketing/pending-emails` before it goes out
    (manual mode = default post-Luke incident). When manual mode is
    off, the outbox dispatches immediately — behaviour identical to
    the pre-outbox code. Either way, the "recipient has a paid order
    in the last 7 days" safety net kicks in before sending, so the
    Luke incident (10% off email to a fresh paying customer) can't
    recur regardless of race conditions in the cart-recovery hook.
    """
    from services.marketing_outbox import queue_email, CAT_ABANDONED_DAY_0
    html = _day_0_html(cart.get("customer_name") or "", cart.get("items") or [], float(cart.get("cart_total") or 0))
    result = await queue_email(
        category=CAT_ABANDONED_DAY_0,
        to=cart["customer_email"],
        subject="You left something in your basket — your tiles are waiting",
        html=html,
        recipient_name=cart.get("customer_name") or "",
        source_ref=cart.get("id"),
        preview=f"Reminder to {cart.get('customer_name') or 'customer'} — cart worth £{float(cart.get('cart_total') or 0):.2f}",
    )
    return bool(result.get("queued"))


def _last_chance_html(name: str, code: str, percent: int, expires_at_iso: str, referrer_email: str = "") -> str:
    expires_str = ""
    try:
        if expires_at_iso:
            expires_str = datetime.fromisoformat(expires_at_iso.replace("Z", "+00:00")).strftime("%d %b %Y")
    except Exception:
        pass
    return f"""
<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;background:#fff;">
  <div style="background:#111;color:#F7EA1C;padding:24px;text-align:center;">
    <h1 style="margin:0;font-size:22px;letter-spacing:1px;">TILE STATION</h1>
  </div>
  <div style="padding:32px;">
    <h2 style="margin:0 0 8px 0;color:#B91C1C;">Last chance, {name or 'there'}!</h2>
    <p style="color:#444;line-height:1.5;">Your <strong>{percent}% off</strong> code expires{(' on ' + expires_str) if expires_str else ' soon'}. Don't miss out.</p>

    <div style="background:#FEF2F2;border:2px dashed #B91C1C;border-radius:8px;padding:18px;margin:20px 0;text-align:center;">
      <div style="font-size:13px;color:#666;letter-spacing:1px;text-transform:uppercase;">Your code</div>
      <div style="font-size:26px;font-weight:bold;letter-spacing:2px;color:#111;margin:6px 0;">{code}</div>
      <div style="font-size:13px;color:#B91C1C;font-weight:bold;">Expires{(' ' + expires_str) if expires_str else ' tomorrow'}</div>
    </div>

    <div style="text-align:center;margin:28px 0;">
      <a href="https://tilestation.co.uk/shop/tile-cart?promo={code}"
         style="background:#F7EA1C;color:#111;padding:14px 36px;text-decoration:none;font-weight:bold;border-radius:6px;display:inline-block;">
        Use my code now
      </a>
    </div>
    <p style="color:#777;font-size:13px;">Single-use. Tied to this email.</p>
    {_share_block_html(referrer_email) if referrer_email else ""}
  </div>
</div>"""


async def _send_last_chance(db, cart: dict) -> bool:
    """Resend the cart's existing promo with an urgency message. Code is NOT regenerated.

    Routes through the marketing outbox (see `_send_day_0` docstring for
    the full rationale — manual review + recent-order safety net)."""
    from services.marketing_outbox import queue_email, CAT_ABANDONED_LAST_CHANCE
    code = cart.get("promo_code")
    if not code:
        return False
    promo_doc = await db.shop_discount_codes.find_one({"code": code})
    if not promo_doc:
        return False
    expires_at = promo_doc.get("expires_at")
    expires_iso = expires_at.isoformat() if isinstance(expires_at, datetime) else ""
    percent = int(promo_doc.get("percent_off") or 0)

    html = _last_chance_html(cart.get("customer_name") or "", code, percent, expires_iso, cart.get("customer_email") or "")
    result = await queue_email(
        category=CAT_ABANDONED_LAST_CHANCE,
        to=cart["customer_email"],
        subject=f"Last chance — your {percent}% off code expires soon",
        html=html,
        recipient_name=cart.get("customer_name") or "",
        source_ref=cart.get("id"),
        preview=f"Last-chance nudge on code {code} ({percent}% off) — expires {expires_iso[:10]}",
    )
    return bool(result.get("queued"))


async def _send_day_1(db, cart: dict, settings: dict) -> Optional[str]:
    """Mint a single-use promo and queue the day-1 email (and optionally WhatsApp).
    Returns the code on queue success, None otherwise.

    22 Jun 2026 — routes through the marketing outbox (`services.
    marketing_outbox.queue_email`) so the owner reviews the email
    before it goes to Resend. The promo code IS still minted here
    even in manual mode, so it's ready when the admin clicks Send in
    the outbox UI. WhatsApp still fires immediately when enabled
    (WhatsApp templates have their own approval flow at Meta's end)."""
    from services.marketing_outbox import queue_email, CAT_ABANDONED_DAY_1
    promo = await generate_promo_code_for_email(
        db,
        email=cart["customer_email"],
        percent_off=int(settings.get("discount_percent", 10)),
        expires_days=int(settings.get("expires_days", 7)),
        source="abandoned_cart",
        prefix="BACK",
    )
    html = _day_1_html(
        cart.get("customer_name") or "",
        cart.get("items") or [],
        float(cart.get("cart_total") or 0),
        promo["code"],
        promo["percent_off"],
        promo.get("expires_at", ""),
        cart.get("customer_email") or "",
    )
    result = await queue_email(
        category=CAT_ABANDONED_DAY_1,
        to=cart["customer_email"],
        subject=f"Here's {promo['percent_off']}% off your tiles — code inside",
        html=html,
        recipient_name=cart.get("customer_name") or "",
        source_ref=cart.get("id"),
        preview=f"Code {promo['code']} ({promo['percent_off']}% off) for cart £{float(cart.get('cart_total') or 0):.2f}",
        extra={"promo_code": promo["code"], "percent_off": promo["percent_off"]},
    )

    # Optional WhatsApp augmentation — same code, different channel.
    if settings.get("whatsapp_enabled") and (cart.get("customer_phone") or "").strip():
        try:
            from services.whatsapp_service import send_whatsapp_template_message
            phone = _normalize_phone(cart["customer_phone"])
            wa_result = await send_whatsapp_template_message(
                recipient_phone=phone,
                template_name=settings.get("whatsapp_template_name") or "abandoned_cart_promo",
                language_code=settings.get("whatsapp_language_code") or "en",
                parameters=[
                    (cart.get("customer_name") or "there").split(" ")[0] or "there",
                    str(promo["percent_off"]),
                    promo["code"],
                ],
            )
            await db.abandoned_carts.update_one(
                {"_id": cart["_id"]},
                {"$set": {
                    "whatsapp_sent": bool(wa_result.get("success")),
                    "whatsapp_sent_at": datetime.now(timezone.utc) if wa_result.get("success") else None,
                    "whatsapp_error": None if wa_result.get("success") else wa_result.get("error"),
                }},
            )
        except Exception as wa_err:
            logger.exception(f"WhatsApp augment failed for {cart.get('customer_email')}: {wa_err}")

    return promo["code"] if result.get("queued") else None


def _normalize_phone(phone: str) -> str:
    """UK-friendly E.164 normalisation. '07123 456 789' → '+447123456789'."""
    digits = "".join(ch for ch in (phone or "") if ch.isdigit() or ch == "+")
    if digits.startswith("+"):
        return digits
    if digits.startswith("00"):
        return "+" + digits[2:]
    if digits.startswith("0"):
        return "+44" + digits[1:]
    return "+" + digits


@router.post("/send-reminders")
async def trigger_reminders(current_user: dict = Depends(get_current_user)):
    """Manual admin trigger for the day-0/day-1 sweep. (The scheduler calls
    `process_reminders()` directly without going through this route.)"""
    _require_admin(current_user)
    return await process_reminders()


async def process_reminders():
    """Idempotent worker — sends pending day-0 and day-1 emails. Safe to call from a
    scheduler tick or from the admin trigger above. Returns counts."""
    db = get_db()
    settings = await _get_settings(db)
    if not settings.get("enabled", True):
        return {"status": "disabled", "day_0_sent": 0, "day_1_sent": 0}

    now = datetime.now(timezone.utc)
    day_0_threshold = now - timedelta(hours=int(settings.get("day_0_hours", 3)))
    day_1_threshold = now - timedelta(hours=int(settings.get("day_1_hours", 24)))

    day_0_sent = 0
    day_1_sent = 0
    last_chance_sent = 0

    # --- Day 0 ---
    cursor = db.abandoned_carts.find({
        "status": "abandoned",
        "reminder_sent_day_0": {"$ne": True},
        "updated_at": {"$lt": day_0_threshold},
    }).limit(100)
    async for cart in cursor:
        try:
            ok = await _send_day_0(cart)
            await db.abandoned_carts.update_one(
                {"_id": cart["_id"]},
                {"$set": {
                    "reminder_sent_day_0": True,
                    "day_0_sent_at": now,
                    "day_0_send_ok": ok,
                }},
            )
            if ok:
                day_0_sent += 1
        except Exception as e:
            logger.exception(f"[abandoned] day_0 send failed for {cart.get('customer_email')}: {e}")

    # --- Day 1 ---
    cursor = db.abandoned_carts.find({
        "status": "abandoned",
        "reminder_sent_day_0": True,
        "reminder_sent_day_1": {"$ne": True},
        "updated_at": {"$lt": day_1_threshold},
    }).limit(100)
    async for cart in cursor:
        try:
            code = await _send_day_1(db, cart, settings)
            await db.abandoned_carts.update_one(
                {"_id": cart["_id"]},
                {"$set": {
                    "reminder_sent_day_1": True,
                    "day_1_sent_at": now,
                    "promo_code": code,
                }},
            )
            if code:
                day_1_sent += 1
        except Exception as e:
            logger.exception(f"[abandoned] day_1 send failed for {cart.get('customer_email')}: {e}")

    # --- Last chance (24h before code expiry by default; only if promo still unused) ---
    if settings.get("last_chance_enabled", True):
        hours_before = int(settings.get("last_chance_hours_before_expiry", 24) or 24)
        send_window_top = now + timedelta(hours=hours_before)
        cursor = db.abandoned_carts.find({
            "status": "abandoned",
            "reminder_sent_day_1": True,
            "reminder_sent_last_chance": {"$ne": True},
            "promo_code": {"$nin": [None, ""]},
        }).limit(100)
        async for cart in cursor:
            try:
                code = cart.get("promo_code")
                promo_doc = await db.shop_discount_codes.find_one({"code": code})
                if not promo_doc or promo_doc.get("used_count", 0) >= promo_doc.get("max_uses", 1):
                    # Already used — mark this cart so we never revisit it.
                    await db.abandoned_carts.update_one(
                        {"_id": cart["_id"]},
                        {"$set": {"reminder_sent_last_chance": True, "last_chance_skipped_reason": "code_used"}},
                    )
                    continue
                expires_at = promo_doc.get("expires_at")
                if isinstance(expires_at, datetime) and expires_at.tzinfo is None:
                    expires_at = expires_at.replace(tzinfo=timezone.utc)
                if not isinstance(expires_at, datetime) or expires_at <= now:
                    await db.abandoned_carts.update_one(
                        {"_id": cart["_id"]},
                        {"$set": {"reminder_sent_last_chance": True, "last_chance_skipped_reason": "code_expired"}},
                    )
                    continue
                # Wait until we're within `hours_before` of expiry.
                if expires_at > send_window_top:
                    continue

                ok = await _send_last_chance(db, cart)
                await db.abandoned_carts.update_one(
                    {"_id": cart["_id"]},
                    {"$set": {
                        "reminder_sent_last_chance": True,
                        "last_chance_sent_at": now,
                        "last_chance_send_ok": ok,
                    }},
                )
                if ok:
                    last_chance_sent += 1
            except Exception as e:
                logger.exception(f"[abandoned] last_chance send failed for {cart.get('customer_email')}: {e}")

    return {"status": "ok", "day_0_sent": day_0_sent, "day_1_sent": day_1_sent, "last_chance_sent": last_chance_sent}


# ============ ADMIN ENDPOINTS ============

@router.get("/stats")
async def get_abandoned_cart_stats(current_user: dict = Depends(get_current_user)):
    _require_admin(current_user)
    db = get_db()
    total_abandoned = await db.abandoned_carts.count_documents({"status": "abandoned"})
    recovered = await db.abandoned_carts.count_documents({"status": "recovered"})

    abandoned_value = await db.abandoned_carts.aggregate([
        {"$match": {"status": "abandoned"}},
        {"$group": {"_id": None, "total": {"$sum": "$cart_total"}}},
    ]).to_list(1)
    recovered_value = await db.abandoned_carts.aggregate([
        {"$match": {"status": "recovered"}},
        {"$group": {"_id": None, "total": {"$sum": "$cart_total"}}},
    ]).to_list(1)

    pending = await db.abandoned_carts.count_documents({
        "status": "abandoned",
        "$or": [
            {"reminder_sent_day_0": {"$ne": True}},
            {"reminder_sent_day_1": {"$ne": True}},
            {"$and": [{"reminder_sent_day_1": True}, {"reminder_sent_last_chance": {"$ne": True}}, {"promo_code": {"$nin": [None, ""]}}]},
        ],
    })

    total = total_abandoned + recovered
    conversion_rate = (recovered / total * 100) if total > 0 else 0

    # Recovered THIS MONTH (calendar month, UTC)
    now = datetime.now(timezone.utc)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    recovered_month_pipeline = await db.abandoned_carts.aggregate([
        {"$match": {"status": "recovered", "recovered_at": {"$gte": month_start}}},
        {"$group": {
            "_id": None,
            "value": {"$sum": "$cart_total"},
            "count": {"$sum": 1},
            "with_promo": {"$sum": {"$cond": [{"$ifNull": ["$promo_code", False]}, 1, 0]}},
        }},
    ]).to_list(1)
    rm = recovered_month_pipeline[0] if recovered_month_pipeline else {}

    return {
        "total_abandoned": total_abandoned,
        "total_value": round((abandoned_value[0]["total"] if abandoned_value else 0) or 0, 2),
        "recovered": recovered,
        "recovered_value": round((recovered_value[0]["total"] if recovered_value else 0) or 0, 2),
        "pending_reminders": pending,
        "conversion_rate": round(conversion_rate, 1),
        "recovered_this_month": {
            "value": round(rm.get("value") or 0, 2),
            "count": int(rm.get("count") or 0),
            "codes_used": int(rm.get("with_promo") or 0),
            "month": month_start.strftime("%B %Y"),
        },
    }


@router.get("/list")
async def list_abandoned_carts(
    status: Optional[str] = "abandoned",
    limit: int = 50,
    skip: int = 0,
    current_user: dict = Depends(get_current_user),
):
    _require_admin(current_user)
    db = get_db()
    query = {"status": status} if status else {}
    carts = await db.abandoned_carts.find(query, {"_id": 0}).sort("updated_at", -1).skip(skip).limit(limit).to_list(limit)
    total = await db.abandoned_carts.count_documents(query)
    return {"carts": carts, "total": total, "page": skip // limit + 1, "pages": (total + limit - 1) // limit}


@router.get("/settings")
async def get_settings_endpoint():
    """Public read so the storefront knows whether tracking is enabled."""
    db = get_db()
    settings = await _get_settings(db)
    return settings


@router.put("/settings")
async def update_settings_endpoint(body: dict, current_user: dict = Depends(get_current_user)):
    """Update sequence settings. Super-admin only."""
    _require_super_admin(current_user)
    db = get_db()
    allowed = {
        "enabled", "day_0_hours", "day_1_hours", "discount_percent", "expires_days",
        "last_chance_enabled", "last_chance_hours_before_expiry",
        "whatsapp_enabled", "whatsapp_template_name", "whatsapp_language_code",
    }
    clean = {k: v for k, v in (body or {}).items() if k in allowed}
    await db.website_settings.update_one(
        {"key": "abandoned_cart_settings"},
        {"$set": {"value": clean, "updated_at": datetime.now(timezone.utc)}},
        upsert=True,
    )
    return await _get_settings(db)

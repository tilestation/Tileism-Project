"""
Notifications admin — config + test + visitor-landed webhook.

Endpoints:
  GET  /api/notifications/telegram/config         — read config (super_admin)
  PUT  /api/notifications/telegram/config         — save config (super_admin)
  POST /api/notifications/telegram/test           — send a test message (super_admin)
  POST /api/notifications/visitor-landed          — public, fires "new visitor"
                                                    notification (rate-limited
                                                    per IP) — called from
                                                    ShopLayout once per session.
"""
import logging
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from routes.auth import get_current_user
from services.telegram_notify import (
    get_config, send_telegram, notify_event, _db,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/notifications", tags=["Notifications"])


class TelegramEventToggles(BaseModel):
    visitor_landed: bool = False
    new_order: bool = True
    new_inquiry: bool = True
    abandoned_basket: bool = True
    failed_payment: bool = True
    customer_error: bool = True
    basket_add: bool = False
    new_customer: bool = True


class TelegramConfig(BaseModel):
    enabled: bool = False
    bot_token: str = ""
    chat_ids: List[str] = Field(default_factory=list)
    events: TelegramEventToggles = Field(default_factory=TelegramEventToggles)
    # 22 Jun 2026 — event keys that should be sent with Telegram's
    # `disable_notification=true` (silent log): message appears in
    # the chat but produces no sound / banner / vibration. The owner's
    # exact ask: "I want to stay quiet instead of being bombarded but
    # still want to see the event when I open Telegram manually."
    silent_events: List[str] = Field(default_factory=list)
    abandoned_basket_threshold_gbp: int = 100


@router.get("/telegram/config")
async def read_config(current_user: dict = Depends(get_current_user)):
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super admin only")
    cfg = await get_config()
    # Mask the bot token in responses so admins know one's set without exposing it.
    masked = dict(cfg)
    token = masked.get("bot_token") or ""
    if token:
        masked["bot_token_masked"] = f"{token[:6]}…{token[-4:]}"
    return masked


@router.put("/telegram/config")
async def save_config(
    payload: TelegramConfig,
    current_user: dict = Depends(get_current_user),
):
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super admin only")

    # Light validation — Telegram tokens look like "1234567890:AA..."
    token = (payload.bot_token or "").strip()
    if token and ":" not in token:
        raise HTTPException(
            status_code=400,
            detail="Bot token doesn't look right — should be like 1234567890:AA…",
        )

    update = {
        "enabled": payload.enabled,
        "bot_token": token,
        "chat_ids": [str(c).strip() for c in payload.chat_ids if str(c).strip()],
        "events": payload.events.dict(),
        # De-dupe + drop blanks so a sloppy frontend payload can't
        # corrupt the silent-events list.
        "silent_events": list(dict.fromkeys(
            k for k in payload.silent_events if k
        )),
        "abandoned_basket_threshold_gbp": int(payload.abandoned_basket_threshold_gbp),
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "updated_by": current_user.get("email"),
    }
    await _db.notification_settings.update_one(
        {"_id": "telegram"}, {"$set": update}, upsert=True,
    )
    return {"success": True}


class TestSendBody(BaseModel):
    text: Optional[str] = None


@router.get("/telegram/chat-ids/discover")
async def discover_chat_ids(current_user: dict = Depends(get_current_user)):
    """One-click chat-ID finder — uses the saved bot token to call
    Telegram's getUpdates and returns every chat that has messaged the
    bot recently. Saves the user from having to paste the token into a
    browser URL.
    """
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super admin only")
    cfg = await get_config()
    token = cfg.get("bot_token") or ""
    if not token:
        raise HTTPException(
            status_code=400,
            detail="Save the bot token first, then send any message to the bot from each chat that should receive alerts.",
        )

    import httpx
    url = f"https://api.telegram.org/bot{token}/getUpdates"
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            r = await client.get(url)
        if r.status_code == 401 or (r.status_code == 200 and not r.json().get("ok")):
            raise HTTPException(
                status_code=400,
                detail="Telegram rejected the bot token. Double-check it with @BotFather and re-save.",
            )
        if r.status_code != 200:
            raise HTTPException(
                status_code=502,
                detail=f"Telegram returned HTTP {r.status_code}",
            )
        updates = r.json().get("result", []) or []
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Could not reach Telegram: {exc}")

    # Collapse to unique chats with a friendly title
    seen: dict = {}
    for upd in updates:
        # Telegram puts the chat under several update kinds — message is by far the most common.
        msg = upd.get("message") or upd.get("channel_post") or upd.get("edited_message") or {}
        chat = msg.get("chat") or {}
        chat_id = chat.get("id")
        if not chat_id:
            continue
        if chat_id in seen:
            continue
        ctype = chat.get("type", "private")
        if ctype == "private":
            name = " ".join(filter(None, [chat.get("first_name"), chat.get("last_name")])) or chat.get("username") or "Direct message"
        else:
            name = chat.get("title") or chat.get("username") or "Group chat"
        seen[chat_id] = {
            "id": str(chat_id),
            "name": name,
            "type": ctype,
        }

    # Mark which ones are already configured
    configured = set(str(c) for c in (cfg.get("chat_ids") or []))
    for c in seen.values():
        c["already_added"] = c["id"] in configured

    return {
        "found": list(seen.values()),
        "instructions": (
            "Send any message (e.g. 'hi') to your bot from each chat or group "
            "that should receive alerts, then click 'Auto-detect' again. "
            "Telegram only remembers the last 24h of messages — if your list "
            "is empty, just send a fresh 'hi' from your phone."
        ) if not seen else None,
    }


@router.post("/telegram/test")
async def test_send(
    body: TestSendBody,
    current_user: dict = Depends(get_current_user),
):
    """Fires a test message to all configured chat_ids. Useful right after
    pasting a new bot token to confirm chat_id is correct."""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super admin only")

    cfg = await get_config()
    if not cfg.get("bot_token") or not cfg.get("chat_ids"):
        raise HTTPException(
            status_code=400,
            detail="Bot token and at least one chat ID must be saved first.",
        )
    text = body.text or (
        "<b>✅ Tile Station — Telegram test</b>\n"
        f"Sent at {datetime.now(timezone.utc).strftime('%H:%M:%S UTC')}\n"
        f"Triggered by {current_user.get('email')}\n\n"
        "If you see this, your notifications are working. 🎉"
    )
    return await send_telegram(text)


@router.post("/telegram/test-new-order")
async def test_new_order(current_user: dict = Depends(get_current_user)):
    """Fires a *simulated* '🛒 New order' notification through the same
    code path real orders use — `notify_event('new_order', ...)` —
    so the admin can verify the wire-up end-to-end without creating
    a real order on production."""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super admin only")
    cfg = await get_config()
    if not cfg.get("enabled"):
        raise HTTPException(status_code=400, detail="Telegram notifications are disabled in config.")
    if not cfg.get("events", {}).get("new_order"):
        raise HTTPException(status_code=400, detail="The 'new_order' event toggle is OFF — turn it on first.")
    if not cfg.get("bot_token") or not cfg.get("chat_ids"):
        raise HTTPException(status_code=400, detail="Bot token and at least one chat ID must be saved first.")

    # Realistic-shaped payload so the test mirrors what a real order
    # would produce. Order number includes today's date code so the
    # admin can tell test pings apart in the channel history.
    fake_order = (
        f"TS-{datetime.now(timezone.utc).strftime('%y%m%d')}-TEST"
    )
    text = (
        f"🛒 <b>New order</b> {fake_order} · TEST\n"
        f"Smoke-test customer\n"
        f"£123.45 · 3 items\n"
        f"Triggered by {current_user.get('email')}"
    )
    result = await notify_event(
        "new_order", text, dedupe_key=f"new-order-test:{fake_order}",
    )
    return {"ok": True, "result": result, "preview_text": text}


@router.post("/telegram/test-failed-payment")
async def test_failed_payment(current_user: dict = Depends(get_current_user)):
    """Fires a *simulated* '🚨 Payment failed' notification through the
    same `notify_event('failed_payment', ...)` code path the Stripe
    webhook uses for real declines."""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super admin only")
    cfg = await get_config()
    if not cfg.get("enabled"):
        raise HTTPException(status_code=400, detail="Telegram notifications are disabled in config.")
    if not cfg.get("events", {}).get("failed_payment"):
        raise HTTPException(status_code=400, detail="The 'failed_payment' event toggle is OFF — turn it on first.")
    if not cfg.get("bot_token") or not cfg.get("chat_ids"):
        raise HTTPException(status_code=400, detail="Bot token and at least one chat ID must be saved first.")

    fake_order = f"TS-{datetime.now(timezone.utc).strftime('%y%m%d')}-TEST"
    text = (
        f"🚨 <b>Payment failed</b> {fake_order} · TEST\n"
        f"Smoke-test customer · test@tilestation.co.uk\n"
        f"📞 07700 900000\n"
        f"£123.45 · card_declined\n"
        f"<i>Your card was declined.</i>\n"
        f"Triggered by {current_user.get('email')}"
    )
    result = await notify_event(
        "failed_payment", text, dedupe_key=f"failed-payment-test:{fake_order}",
    )
    return {"ok": True, "result": result, "preview_text": text}


class TestRecoveryEmailBody(BaseModel):
    to: str  # email address to send the test recovery email to


@router.post("/telegram/test-recovery-email")
async def test_recovery_email(
    body: TestRecoveryEmailBody,
    current_user: dict = Depends(get_current_user),
):
    """Sends a *real* recovery email to the address provided, using a
    synthetic in-memory order doc — does NOT touch the database, does
    NOT mint a usable token, doesn't depend on Telegram. Lets the
    super_admin preview the email's wording, branding and CTA in their
    own inbox before flipping anything on for live customers.

    Uses the recovery email's render helper but swaps in a placeholder
    recovery URL so the user can't accidentally hijack a real cart by
    clicking the test email's button."""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super admin only")

    to = (body.to or "").strip()
    if not to or "@" not in to:
        raise HTTPException(status_code=400, detail="Provide a valid email address to send the test to.")

    from services.payment_recovery import _render_html, _shop_url  # noqa: PLC0415
    from services.email import RESEND_AVAILABLE, RESEND_API_KEY  # noqa: PLC0415
    if not RESEND_AVAILABLE or not RESEND_API_KEY:
        raise HTTPException(status_code=400, detail="Resend isn't configured — set RESEND_API_KEY first.")

    import asyncio  # noqa: PLC0415
    import resend  # noqa: PLC0415

    html = _render_html(
        customer_name="there",
        recovery_url=f"{_shop_url()}/shop/checkout/recover/PREVIEW-TOKEN-NOT-USABLE",
        total=123.45,
        decline_message="Your card was declined.",
        items_count=3,
    )
    resend.api_key = RESEND_API_KEY
    payload = {
        "from": "Tile Station <orders@tilestation.co.uk>",
        "to": [to],
        "subject": "[TEST] Your payment didn't go through — your cart is saved",
        "html": html,
        "reply_to": ["orders@tilestation.co.uk"],
    }
    try:
        await asyncio.to_thread(resend.Emails.send, payload)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Resend send failed: {e}")
    return {"ok": True, "sent_to": to}


# ─────────────────────────────────────────────────────────────────────────────
# PUBLIC visitor-landed webhook — called from the storefront once per session.
# ─────────────────────────────────────────────────────────────────────────────
class VisitorPing(BaseModel):
    page: Optional[str] = None
    referrer: Optional[str] = None
    user_agent: Optional[str] = None


@router.post("/visitor-landed")
async def visitor_landed(payload: VisitorPing, request: Request):
    """Fires a 'new visitor' Telegram alert. Public endpoint, but heavily
    rate-limited per-IP-per-hour so refreshers can't spam the channel."""
    # Best-effort IP extraction (Cloudflare/Railway proxies set this)
    ip = (
        request.headers.get("cf-connecting-ip")
        or request.headers.get("x-forwarded-for", "").split(",")[0].strip()
        or (request.client.host if request.client else "unknown")
    )
    page = (payload.page or "/").strip()[:120]
    referrer = (payload.referrer or "").strip()[:200] or "—"
    user_agent = (payload.user_agent or request.headers.get("user-agent") or "—")[:160]

    text = (
        "<b>👋 New visitor on tilestation.co.uk</b>\n"
        f"<b>Page:</b> {page}\n"
        f"<b>Referrer:</b> {referrer}\n"
        f"<b>IP:</b> <code>{ip}</code>\n"
        f"<b>UA:</b> {user_agent}"
    )
    result = await notify_event(
        "visitor_landed", text, dedupe_key=ip,
    )
    return {"ok": True, "result": result}

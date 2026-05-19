"""
Telegram Notifications — sends short alerts to a configured chat
when interesting events happen (new visitor, new order, new contact form,
abandoned basket above threshold).

Why direct httpx instead of python-telegram-bot?
- Zero new dependencies (httpx already in env)
- Simpler async surface — single function call
- We're only sending, never receiving (no webhook/polling needed)

Config is stored in MongoDB collection `notification_settings` (singleton
doc with _id="telegram") so a super-admin can paste the bot token + chat
IDs in the admin UI without touching env vars.
"""
import asyncio
import logging
import os
import time
from typing import Iterable, Optional

import httpx
from motor.motor_asyncio import AsyncIOMotorClient

logger = logging.getLogger(__name__)

_mongo_url = os.environ.get("MONGO_URL")
_db_name = os.environ.get("DB_NAME")
_client = AsyncIOMotorClient(_mongo_url) if _mongo_url else None
_db = _client[_db_name] if _client and _db_name else None

TELEGRAM_API = "https://api.telegram.org/bot{token}/sendMessage"
SEND_TIMEOUT_S = 6
# Rate limit: at most one alert per (event_type, dedupe_key) per this window.
# Stops a single bot or refresher from spamming the channel.
DEDUPE_WINDOW_S = 60 * 60  # 1 hour

# In-process dedupe ledger. Keys look like "visitor:1.2.3.4". Reset on restart
# but that's fine — Telegram is for live events, not historical replay.
_dedupe: dict[str, float] = {}


async def get_config() -> dict:
    """Returns the current Telegram config or sensible defaults."""
    if _db is None:
        return _default_config()
    doc = await _db.notification_settings.find_one({"_id": "telegram"})
    return _merge_defaults(doc or {})


def _default_config() -> dict:
    return {
        "enabled": False,
        "bot_token": "",
        "chat_ids": [],
        # Per-event toggles — on by default for high-value events,
        # off by default for noisy ones (visitor landed = potentially every refresh).
        "events": {
            "visitor_landed": False,
            "new_order": True,
            "new_inquiry": True,
            "abandoned_basket": True,
            "failed_payment": True,
            "customer_error": True,
            "basket_add": False,
            "new_customer": True,
            # 🔥 Hot session — fires once per session when a visitor views ≥3
            # PDPs and stays >2 min. High-signal alert for the sales team:
            # filters out drive-by visits, only flags genuine buying intent.
            "hot_session": True,
            # 🚨 Ribbon leak — fires from the nightly APScheduler job if a
            # test file published a TEST_* / _E1_TEST_* string to the live
            # announcement ribbon. Low-frequency, very high-signal.
            "ribbon_leak": True,
            # 🏆 City page A/B winner — fires when the daily auto-promotion
            # job picks a winner between Variant A and Variant B for an
            # AI city landing page. Low-frequency (one per page once
            # impressions threshold met), high-signal.
            "city_page_ab_winner": True,
            # 🚨 Missing credentials — fires once per backend restart if
            # any required env var (admin password, supplier portal
            # passwords) is missing or empty. Critical for prod safety.
            "missing_credentials": True,
        },
        "abandoned_basket_threshold_gbp": 100,
    }


def _merge_defaults(doc: dict) -> dict:
    base = _default_config()
    base.update({k: v for k, v in doc.items() if k != "_id"})
    base["events"] = {**_default_config()["events"], **(doc.get("events") or {})}
    return base


def _is_dedupe_window_open(key: str) -> bool:
    """Returns True if we should send (no recent dedupe hit), False if suppressed."""
    now = time.time()
    last = _dedupe.get(key, 0)
    if now - last < DEDUPE_WINDOW_S:
        return False
    _dedupe[key] = now
    # Trim old entries lazily so the dict doesn't grow forever
    if len(_dedupe) > 5000:
        cutoff = now - DEDUPE_WINDOW_S
        for k, t in list(_dedupe.items()):
            if t < cutoff:
                _dedupe.pop(k, None)
    return True


async def send_telegram(
    text: str,
    *,
    chat_ids: Optional[Iterable[str]] = None,
    bot_token: Optional[str] = None,
    parse_mode: str = "HTML",
) -> dict:
    """Send a message. Reads config from DB unless explicit token/chat_ids given.
    Returns {"sent": int, "errors": list[str]} — never raises.
    """
    cfg = await get_config()
    token = bot_token or cfg.get("bot_token") or ""
    targets = list(chat_ids or cfg.get("chat_ids") or [])
    if not token or not targets:
        return {"sent": 0, "errors": ["bot_token or chat_ids not configured"]}

    sent = 0
    errors = []
    url = TELEGRAM_API.format(token=token)
    async with httpx.AsyncClient(timeout=SEND_TIMEOUT_S) as client:
        for chat_id in targets:
            try:
                r = await client.post(
                    url,
                    json={
                        "chat_id": chat_id,
                        "text": text,
                        "parse_mode": parse_mode,
                        "disable_web_page_preview": True,
                    },
                )
                if r.status_code == 200 and r.json().get("ok"):
                    sent += 1
                else:
                    errors.append(f"chat {chat_id}: HTTP {r.status_code} {r.text[:120]}")
            except Exception as exc:
                errors.append(f"chat {chat_id}: {exc}")

    if errors:
        logger.warning(f"Telegram send had errors: {errors}")
    return {"sent": sent, "errors": errors}


async def notify_event(
    event_type: str,
    text: str,
    *,
    dedupe_key: Optional[str] = None,
) -> dict:
    """Convenience wrapper used by the rest of the app. Honours the per-event
    toggle and the in-memory dedupe window."""
    cfg = await get_config()
    if not cfg.get("enabled"):
        return {"skipped": "telegram_disabled"}
    if not cfg.get("events", {}).get(event_type, False):
        return {"skipped": f"event_disabled:{event_type}"}
    if dedupe_key and not _is_dedupe_window_open(f"{event_type}:{dedupe_key}"):
        return {"skipped": "dedupe_window"}

    return await send_telegram(text)


def fire_and_forget(event_type: str, text: str, *, dedupe_key: Optional[str] = None):
    """Fires notify_event without blocking the caller. Use from request
    handlers where we don't want a slow Telegram response to delay the user."""
    try:
        asyncio.create_task(notify_event(event_type, text, dedupe_key=dedupe_key))
    except RuntimeError:
        # No running loop (rare — e.g. test contexts)
        pass

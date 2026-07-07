"""
Marketing Email Outbox — 22 Jun 2026
════════════════════════════════════

Central queue + review layer for every automatic *promotional* email
the platform used to fire straight into customer inboxes:

    - Abandoned cart day-0 reminder
    - Abandoned cart day-1 promo (10% off)
    - Abandoned cart last-chance nudge
    - Lead welcome voucher (5% off)
    - Sample follow-up (with or without voucher)

Bug that triggered this refactor
────────────────────────────────
A customer (Luke) placed an order and then received an "Automatic
reply: External: Here's 10% off your tiles — code inside" email from
us. That day-1 promo was queued 24h before he ordered, and the
cart-to-order matching missed the recovery flag (Stripe webhook race
/ different email casing / who knows). The moment the promo fires
after a paid order, the customer feels ripped off — "I could've had
this 10% off if I'd waited a day".

Design
──────
1. Every promo email now goes through this outbox instead of directly
   to Resend. `queue_email()` writes a `marketing_email_outbox` doc
   with the fully-rendered HTML + subject + recipient.
2. A master flag `settings/manual_marketing_emails` (in
   `website_settings`, default TRUE post-Luke) decides whether:
     - TRUE  → the doc sits with status='pending' until an admin
               reviews it and clicks Send from the admin UI at
               /admin/marketing/pending-emails.
     - FALSE → the queue module immediately dispatches it via the
               existing email service (unchanged behaviour).
3. Belt-and-braces safety net: `has_recent_completed_order(email)`
   returns True if the recipient placed a paid order in the last N
   days. Every promo email — even in auto mode — checks this before
   firing, so Luke-style incidents can't recur regardless of
   abandoned-cart-recovery race conditions.

Public API
──────────
    queue_email(category, to, subject, html, *, source_ref=None,
                recipient_name=None, preview=None, scheduled_for=None,
                extra=None) → dict
        Returns {"queued": True/False, "sent": True/False,
                 "outbox_id": str|None, "skipped_reason": str|None}

    is_manual_mode(db) → bool
        Read the master flag from `website_settings` doc key
        `manual_marketing_emails`. Default: True.

    has_recent_completed_order(db, email, days=7) → bool

    send_from_outbox(db, outbox_id, actor_email) → dict
    skip_from_outbox(db, outbox_id, actor_email, reason="") → dict
"""
from __future__ import annotations

import uuid
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional, Any

from config import get_db as _get_db_shim

logger = logging.getLogger(__name__)

# ── Categories ───────────────────────────────────────────────────────
# Kept as string constants (not an Enum) so the values remain
# JSON-serialisable to the DB without gymnastics and stay stable
# across future schema evolution.
CAT_ABANDONED_DAY_0 = "abandoned_day_0"
CAT_ABANDONED_DAY_1 = "abandoned_day_1"          # ← the Luke email
CAT_ABANDONED_LAST_CHANCE = "abandoned_last_chance"
CAT_LEAD_WELCOME = "lead_welcome"
CAT_SAMPLE_FOLLOWUP = "sample_followup"

ALL_CATEGORIES = {
    CAT_ABANDONED_DAY_0,
    CAT_ABANDONED_DAY_1,
    CAT_ABANDONED_LAST_CHANCE,
    CAT_LEAD_WELCOME,
    CAT_SAMPLE_FOLLOWUP,
}

# Human-facing labels — used by the admin UI. Kept here so new
# categories only need one file update.
CATEGORY_LABELS = {
    CAT_ABANDONED_DAY_0: "Abandoned cart — reminder",
    CAT_ABANDONED_DAY_1: "Abandoned cart — 10% off promo",
    CAT_ABANDONED_LAST_CHANCE: "Abandoned cart — last chance",
    CAT_LEAD_WELCOME: "Lead welcome — 5% off voucher",
    CAT_SAMPLE_FOLLOWUP: "Sample follow-up",
}

# ── Status values ────────────────────────────────────────────────────
STATUS_PENDING = "pending"
STATUS_SENT = "sent"                 # admin approved + Resend accepted
STATUS_SKIPPED = "skipped"           # admin dismissed
STATUS_AUTO_SENT = "auto_sent"       # manual-mode was OFF at queue time
STATUS_BLOCKED_RECENT_ORDER = "blocked_recent_order"  # safety net fired
STATUS_FAILED = "failed"             # Resend rejected
STATUS_CATEGORY_DISABLED = "category_disabled"  # per-category kill-switch

# ── Per-category delivery modes ──────────────────────────────────────
# Owner asked (23 Jun 2026) for granular control so they can, e.g.,
# turn off the 10%-off abandoned-cart email ENTIRELY while keeping
# the sample follow-up in manual-review, and let the lead welcome
# still auto-send. Three modes per category (mirrors the Telegram
# silent-mode 3-way control we already ship):
#
#   MODE_OFF    — Email is never generated. Queue skips it entirely
#                 with status='category_disabled' so the admin can
#                 still see WHAT would have gone out and confirm the
#                 kill-switch is working. The cart-recovery / lead-
#                 signup / sample-order pipelines keep running; only
#                 the outbound email is suppressed.
#   MODE_MANUAL — Email lands in the outbox with status='pending'
#                 for admin review. This is the safe default after
#                 the Luke incident.
#   MODE_AUTO   — Legacy behaviour: fire immediately via the email
#                 service, log with status='auto_sent'. Recent-order
#                 safety net still runs.
MODE_OFF = "off"
MODE_MANUAL = "manual"
MODE_AUTO = "auto"
ALL_MODES = {MODE_OFF, MODE_MANUAL, MODE_AUTO}

# Default recent-order look-back for the safety net.
DEFAULT_RECENT_ORDER_DAYS = 7

# Settings doc key inside `website_settings`.
_SETTINGS_KEY = "manual_marketing_emails"
# Per-category-mode settings doc key inside `website_settings`.
# Value shape:  {"abandoned_day_1": "off", "lead_welcome": "manual", ...}
# Any category NOT in this dict falls back to the master flag
# (`is_manual_mode`) — so the new per-category controls are purely
# additive and don't disturb existing behaviour until the owner
# explicitly changes a category.
_CATEGORY_MODES_KEY = "marketing_email_category_modes"


# ─────────────────────────────────────────────────────────────────────
# Settings — master flag
# ─────────────────────────────────────────────────────────────────────

async def is_manual_mode(db=None) -> bool:
    """Is the manual-approval outbox enabled?

    Default: **True** (post-Luke incident). Anyone can flip this off
    via `PUT /api/marketing-outbox/settings` if they later want the
    old fire-and-forget behaviour back — no code change required.
    """
    if db is None:
        db = _get_db_shim()
    doc = await db.website_settings.find_one({"key": _SETTINGS_KEY}, {"_id": 0})
    if not doc:
        return True
    # Explicit `false` = auto mode. Everything else (missing, truthy) = manual.
    return bool(doc.get("value", True))


async def set_manual_mode(db, enabled: bool, actor_email: str = "") -> None:
    await db.website_settings.update_one(
        {"key": _SETTINGS_KEY},
        {"$set": {
            "key": _SETTINGS_KEY,
            "value": bool(enabled),
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "updated_by": actor_email or "system",
        }},
        upsert=True,
    )


# ─────────────────────────────────────────────────────────────────────
# Per-category delivery mode — the granular kill-switch
# ─────────────────────────────────────────────────────────────────────

async def get_category_modes(db) -> dict[str, str]:
    """Return the {category → mode} dict as saved by the admin.
    Categories the owner hasn't explicitly configured are ABSENT
    from the dict — the caller (`_resolve_category_mode`) falls back
    to the master manual-mode flag for those.

    Adding a fresh category to `ALL_CATEGORIES` therefore requires
    zero data migration; it just inherits the master flag until the
    owner picks a specific mode for it.
    """
    doc = await db.website_settings.find_one({"key": _CATEGORY_MODES_KEY}, {"_id": 0})
    if not doc:
        return {}
    raw = doc.get("value") or {}
    # Guard against stale entries (deprecated categories) + invalid modes.
    return {
        k: v for k, v in raw.items()
        if k in ALL_CATEGORIES and v in ALL_MODES
    }


async def set_category_mode(
    db, category: str, mode: str, actor_email: str = "",
) -> None:
    if category not in ALL_CATEGORIES:
        raise ValueError(f"Unknown category: {category}")
    if mode not in ALL_MODES:
        raise ValueError(f"Invalid mode (must be off/manual/auto): {mode}")
    current = await get_category_modes(db)
    current[category] = mode
    await db.website_settings.update_one(
        {"key": _CATEGORY_MODES_KEY},
        {"$set": {
            "key": _CATEGORY_MODES_KEY,
            "value": current,
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "updated_by": actor_email or "system",
        }},
        upsert=True,
    )


async def _resolve_category_mode(db, category: str) -> str:
    """Return the effective mode for `category`.
    Precedence:
      1. Explicit per-category setting saved by the admin.
      2. Master flag: manual_mode ON → MODE_MANUAL, OFF → MODE_AUTO.
    """
    per_cat = await get_category_modes(db)
    if category in per_cat:
        return per_cat[category]
    return MODE_MANUAL if await is_manual_mode(db) else MODE_AUTO


# ─────────────────────────────────────────────────────────────────────
# Safety net — has the recipient placed a paid order recently?
# ─────────────────────────────────────────────────────────────────────

async def has_recent_completed_order(
    db,
    email: str,
    days: int = DEFAULT_RECENT_ORDER_DAYS,
) -> bool:
    """Returns True if we have a paid order (shop or sample) from this
    email within the given look-back window. Case-insensitive match on
    the customer_email field.

    This is the belt-and-braces guard against the Luke incident: even
    if the abandoned-cart-to-order recovery hook missed for any
    reason (Stripe webhook race, different email casing, admin-created
    invoice, in-store EPOS purchase paired to the same email), we
    won't blast a discount email to someone who's freshly paid full
    price.
    """
    if not email:
        return False
    lowered = email.lower().strip()
    cutoff_iso = (
        datetime.now(timezone.utc) - timedelta(days=days)
    ).isoformat()

    # Shop orders — flip to "paid" is the meaningful signal, we don't
    # care about pending_payment carts here.
    shop_hit = await db.shop_orders.find_one(
        {
            "customer_email": {"$regex": f"^{lowered}$", "$options": "i"},
            "payment_status": "paid",
            "$or": [
                {"paid_at": {"$gte": cutoff_iso}},
                {"created_at": {"$gte": cutoff_iso}},
            ],
        },
        {"_id": 1},
    )
    if shop_hit:
        return True

    # Sample orders — free samples don't count for this guard (a £2.99
    # sample order isn't "already paid full price"), only paid ones.
    sample_hit = await db.sample_orders.find_one(
        {
            "customer_email": {"$regex": f"^{lowered}$", "$options": "i"},
            "status": {"$in": ["paid", "shipped", "delivered", "completed"]},
            "$or": [
                {"paid_at": {"$gte": cutoff_iso}},
                {"created_at": {"$gte": cutoff_iso}},
            ],
        },
        {"_id": 1},
    )
    return bool(sample_hit)


# ─────────────────────────────────────────────────────────────────────
# Queue — the main entry point every promo-email caller now uses
# ─────────────────────────────────────────────────────────────────────

async def queue_email(
    *,
    category: str,
    to: str,
    subject: str,
    html: str,
    source_ref: Optional[str] = None,
    recipient_name: Optional[str] = None,
    preview: Optional[str] = None,
    scheduled_for: Optional[datetime] = None,
    extra: Optional[dict[str, Any]] = None,
    from_override: Optional[str] = None,
    skip_recent_order_guard: bool = False,
) -> dict:
    """Route a promotional email through the outbox.

    Two possible outcomes:
      • Manual mode ON  → doc lands with status='pending', admin will
        review it in the UI. Nothing sent to Resend.
      • Manual mode OFF → doc lands with status='auto_sent' *after*
        successful Resend send. Legacy behaviour, kept for anyone who
        wants zero-touch marketing.

    In BOTH modes: `has_recent_completed_order()` gates the send —
    if the recipient has a paid order in the last 7 days, the queue
    record is stamped `blocked_recent_order` and nothing goes out.

    Returns a status dict rather than a bool so callers can log
    exactly what happened without re-querying the DB.
    """
    db = _get_db_shim()
    if category not in ALL_CATEGORIES:
        raise ValueError(f"Unknown marketing-email category: {category}")

    now = datetime.now(timezone.utc)
    lowered_to = (to or "").lower().strip()

    doc: dict = {
        "id": str(uuid.uuid4()),
        "category": category,
        "recipient_email": lowered_to,
        "recipient_name": recipient_name or "",
        "subject": subject,
        "html": html,
        # Short teaser used by the admin list view. Falls back to the
        # subject so we always have *something* to render even when
        # the caller doesn't bother providing a preview.
        "preview": (preview or subject)[:280],
        "source_ref": source_ref,
        "from_override": from_override,
        "scheduled_for": scheduled_for.isoformat() if scheduled_for else None,
        "created_at": now.isoformat(),
        "acted_by": None,
        "acted_at": None,
        "status": STATUS_PENDING,   # updated below
        "extra": extra or {},
    }

    # ── Resolve per-category delivery mode (Off / Manual / Auto) ──
    # Runs BEFORE the recent-order guard so that a fully-off category
    # doesn't even generate an outbox record for someone with a fresh
    # paid order (which would just be double-noise in the "Blocked"
    # bucket). Ordering: category-mode → paid-order guard → dispatch.
    effective_mode = await _resolve_category_mode(db, category)

    if effective_mode == MODE_OFF:
        doc["status"] = STATUS_CATEGORY_DISABLED
        doc["acted_at"] = now.isoformat()
        doc["acted_by"] = "category-off"
        await db.marketing_email_outbox.insert_one(doc)
        logger.info(
            "[outbox] %s to %s skipped — category set to OFF",
            category, lowered_to,
        )
        return {
            "queued": True, "sent": False,
            "outbox_id": doc["id"],
            "skipped_reason": "category_disabled",
        }

    # ── Safety net: skip anyone with a paid order in the last week ──
    if not skip_recent_order_guard and category in {
        CAT_ABANDONED_DAY_0, CAT_ABANDONED_DAY_1, CAT_ABANDONED_LAST_CHANCE,
        CAT_LEAD_WELCOME, CAT_SAMPLE_FOLLOWUP,
    }:
        try:
            if await has_recent_completed_order(db, lowered_to):
                doc["status"] = STATUS_BLOCKED_RECENT_ORDER
                doc["acted_at"] = now.isoformat()
                await db.marketing_email_outbox.insert_one(doc)
                logger.info(
                    "[outbox] Blocked %s to %s — recent completed order",
                    category, lowered_to,
                )
                return {
                    "queued": True, "sent": False,
                    "outbox_id": doc["id"],
                    "skipped_reason": "recent_completed_order",
                }
        except Exception:
            logger.exception(
                "[outbox] recent-order guard errored — proceeding with queue",
            )

    # ── Manual mode: park it for admin review ──
    if effective_mode == MODE_MANUAL:
        await db.marketing_email_outbox.insert_one(doc)
        logger.info(
            "[outbox] Queued %s to %s for manual review (id=%s)",
            category, lowered_to, doc["id"],
        )
        return {
            "queued": True, "sent": False,
            "outbox_id": doc["id"], "skipped_reason": None,
        }

    # ── Auto mode: fire it through Resend now (legacy behaviour) ──
    send_ok = await _dispatch_via_email_service(
        to=lowered_to, subject=subject, html=html,
        from_override=from_override,
    )
    doc["status"] = STATUS_AUTO_SENT if send_ok else STATUS_FAILED
    doc["acted_at"] = now.isoformat()
    doc["acted_by"] = "auto-mode"
    await db.marketing_email_outbox.insert_one(doc)
    return {
        "queued": True, "sent": bool(send_ok),
        "outbox_id": doc["id"], "skipped_reason": None,
    }


# ─────────────────────────────────────────────────────────────────────
# Admin actions — send / skip
# ─────────────────────────────────────────────────────────────────────

async def send_from_outbox(
    db, outbox_id: str, actor_email: str = "",
    *, skip_recent_order_guard: bool = False,
) -> dict:
    doc = await db.marketing_email_outbox.find_one({"id": outbox_id}, {"_id": 0})
    if not doc:
        return {"ok": False, "error": "outbox_id_not_found"}
    if doc["status"] not in (STATUS_PENDING, STATUS_FAILED):
        return {"ok": False, "error": f"cannot_send_from_status_{doc['status']}"}

    # Even on manual send we protect against the "customer already
    # paid" case (admin might not know they placed an order 20 minutes
    # ago). `skip_recent_order_guard=True` on the endpoint lets a
    # senior admin override if they *really* want to send anyway.
    if not skip_recent_order_guard:
        if await has_recent_completed_order(db, doc.get("recipient_email") or ""):
            await db.marketing_email_outbox.update_one(
                {"id": outbox_id},
                {"$set": {
                    "status": STATUS_BLOCKED_RECENT_ORDER,
                    "acted_by": actor_email or "admin",
                    "acted_at": datetime.now(timezone.utc).isoformat(),
                }},
            )
            return {
                "ok": False,
                "error": "blocked_recent_order",
                "hint": "Recipient placed a paid order in the last 7 days. "
                        "Pass ?force=true to override.",
            }

    ok = await _dispatch_via_email_service(
        to=doc["recipient_email"], subject=doc["subject"], html=doc["html"],
        from_override=doc.get("from_override"),
    )
    await db.marketing_email_outbox.update_one(
        {"id": outbox_id},
        {"$set": {
            "status": STATUS_SENT if ok else STATUS_FAILED,
            "acted_by": actor_email or "admin",
            "acted_at": datetime.now(timezone.utc).isoformat(),
        }},
    )
    return {"ok": bool(ok), "status": STATUS_SENT if ok else STATUS_FAILED}


async def skip_from_outbox(
    db, outbox_id: str, actor_email: str = "", reason: str = "",
) -> dict:
    doc = await db.marketing_email_outbox.find_one({"id": outbox_id}, {"_id": 0})
    if not doc:
        return {"ok": False, "error": "outbox_id_not_found"}
    if doc["status"] != STATUS_PENDING:
        return {"ok": False, "error": f"cannot_skip_from_status_{doc['status']}"}
    await db.marketing_email_outbox.update_one(
        {"id": outbox_id},
        {"$set": {
            "status": STATUS_SKIPPED,
            "acted_by": actor_email or "admin",
            "acted_at": datetime.now(timezone.utc).isoformat(),
            "skip_reason": reason[:280] if reason else None,
        }},
    )
    return {"ok": True}


# ─────────────────────────────────────────────────────────────────────
# Internals — wrap the existing email service so callers only import us
# ─────────────────────────────────────────────────────────────────────

async def _dispatch_via_email_service(
    *, to: str, subject: str, html: str, from_override: Optional[str] = None,
) -> bool:
    """Thin wrapper over `services.email.send_email_notification` so
    the queue module has a single dispatch point + we can swap the
    underlying email backend without touching every promo template."""
    try:
        from services.email import send_email_notification
        # `send_email_notification` returns True/False.
        return bool(await send_email_notification(
            to_emails=[to],
            subject=subject,
            html_content=html,
            from_name="Tile Station",
        ))
    except Exception:
        logger.exception("[outbox] dispatch failed for %s", to)
        return False

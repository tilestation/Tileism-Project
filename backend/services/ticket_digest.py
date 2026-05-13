"""
Weekly Telegram digest of price-ticket activity (May 13, 2026)

Aggregates `ticket_print_events` over the last 7 days and posts a
punchy summary to the configured Telegram chats:

    🖨 Price tickets — this week
    47 tickets across 12 print runs · 5 admins
    Top: Dolomite Blanco (×8), Marble Carrara (×6), …
    Top printer: qasim@tilestation.co.uk (32 tickets)

Idempotency:
    Marker doc in `digest_run_markers` keyed by ISO week — running the
    tick twice in the same week is a no-op (unless `force=True`).

Failure modes:
    All network calls (Telegram) and DB calls are wrapped — this is a
    purely-informational notification and must never break the
    scheduler.
"""
from __future__ import annotations

import logging
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from config import get_db
from services.telegram_notify import send_telegram

logger = logging.getLogger(__name__)

MARKER_PREFIX = "ticket_digest_weekly"
DEFAULT_WINDOW_DAYS = 7
TOP_PRODUCTS_LIMIT = 5
TOP_PRINTERS_LIMIT = 3


async def compute_ticket_digest(days: int = DEFAULT_WINDOW_DAYS) -> Dict[str, Any]:
    """Aggregate ticket-print activity over the last `days` days.

    Returns a dict with totals + top-N lists. Pure read; safe to call
    standalone (e.g. from an admin preview endpoint)."""
    db = get_db()
    now = datetime.now(timezone.utc)
    since = (now - timedelta(days=days)).isoformat()

    events = await db.ticket_print_events.find(
        {"printed_at": {"$gte": since}}, {"_id": 0}
    ).to_list(10000)

    total_runs = len(events)
    total_tickets = 0
    product_counter: Counter = Counter()
    printer_counter: Counter = Counter()
    manual_count = 0

    for ev in events:
        items = ev.get("items") or []
        # Count each ticket once per item in the run. We don't multiply
        # by `copies` because that's a print-time multiplier we don't
        # log per-event (and admins typically reset it).
        total_tickets += len(items)
        printer_counter[ev.get("printed_by") or "unknown"] += len(items)
        for it in items:
            if it.get("is_manual"):
                manual_count += 1
                continue
            name = (it.get("name") or "").strip()
            if name:
                product_counter[name] += 1

    return {
        "window_days": days,
        "since": since,
        "until": now.isoformat(),
        "total_runs": total_runs,
        "total_tickets": total_tickets,
        "manual_tickets": manual_count,
        "unique_admins": len(printer_counter),
        "top_products": product_counter.most_common(TOP_PRODUCTS_LIMIT),
        "top_printers": printer_counter.most_common(TOP_PRINTERS_LIMIT),
    }


def build_digest_message(stats: Dict[str, Any]) -> str:
    """Format the digest as a Telegram HTML message. Returns '' if the
    window had zero activity (caller may choose to skip sending)."""
    if stats.get("total_runs", 0) == 0:
        return ""

    lines: List[str] = []
    lines.append("🖨 <b>Price tickets — this week</b>")
    runs = stats["total_runs"]
    tickets = stats["total_tickets"]
    admins = stats["unique_admins"]
    lines.append(
        f"{tickets} ticket{'s' if tickets != 1 else ''} across "
        f"{runs} print run{'s' if runs != 1 else ''} · "
        f"{admins} admin{'s' if admins != 1 else ''}"
    )
    if stats.get("manual_tickets"):
        lines.append(f"({stats['manual_tickets']} manual / one-off)")

    top_products = stats.get("top_products") or []
    if top_products:
        top_str = ", ".join(f"{name} (×{count})" for name, count in top_products)
        lines.append(f"<b>Top items:</b> {top_str}")

    top_printers = stats.get("top_printers") or []
    if top_printers:
        printer_lines = ", ".join(
            f"{email} ({n})" for email, n in top_printers
        )
        lines.append(f"<b>Top printer{'s' if len(top_printers) != 1 else ''}:</b> {printer_lines}")

    return "\n".join(lines)


async def run_ticket_digest_tick(force: bool = False) -> Dict[str, Any]:
    """Idempotent weekly tick — sends the digest at most once per ISO
    week unless `force=True`. Safe to call from APScheduler."""
    db = get_db()
    now = datetime.now(timezone.utc)
    iso_year, iso_week, _ = now.isocalendar()
    marker_id = f"{MARKER_PREFIX}:{iso_year}-{iso_week:02d}"

    if not force:
        existing = await db.digest_run_markers.find_one(
            {"_id": marker_id}, {"_id": 1}
        )
        if existing:
            return {"skipped": "already_sent_this_week", "marker": marker_id}

    stats = await compute_ticket_digest(days=DEFAULT_WINDOW_DAYS)
    msg = build_digest_message(stats)

    if not msg:
        # Don't burn Telegram quota on a silent week — but still set the
        # marker so we don't retry every minute via the misfire-grace.
        if not force:
            await db.digest_run_markers.update_one(
                {"_id": marker_id},
                {"$set": {"_id": marker_id, "sent_at": now.isoformat(), "skipped": "empty_week"}},
                upsert=True,
            )
        return {"skipped": "no_activity", "stats": stats}

    try:
        result = await send_telegram(msg, parse_mode="HTML")
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"ticket_digest send_telegram failed: {exc}")
        result = {"sent": 0, "errors": [str(exc)]}

    sent = int(result.get("sent", 0))
    if sent > 0 and not force:
        await db.digest_run_markers.update_one(
            {"_id": marker_id},
            {"$set": {"_id": marker_id, "sent_at": now.isoformat(), "telegram": result}},
            upsert=True,
        )

    return {
        "sent_to": sent,
        "errors": result.get("errors", []),
        "stats": stats,
        "marker": marker_id,
    }

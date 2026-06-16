"""
Orphaned-Orders Sweep (Feb 2026).

Safety-net cron that catches paid orders whose confirmation emails
never fired. Runs every 5 minutes and finds any shop_order where:

  • payment_status == "paid"
  • paid_at is older than ORPHAN_GRACE_MINUTES (default 10)
  • confirmation_email_sent_at is missing/null
  • the order itself isn't ancient (we cap the look-back to
    ORPHAN_MAX_AGE_HOURS, default 72h, so a one-off 2-year-old bug
    can't suddenly mass-mail customers who long ago stopped caring).

For each orphan it:
  1. Calls `send_order_confirmation_emails_idempotent(order_id)` —
     same path the webhook + poll use, so the audit row + email
     log are written identically.
  2. Fires ONE Telegram alert per pass (not per order) telling the
     owner how many orphans were caught and recovered. If zero, no
     ping — silent success.

Built in response to the 16 Jun 2026 incident (Carolina Santiago paid
£834.63 but never received a confirmation because she closed the tab
before the success-page poll fired). The fix in
`send_order_confirmation_emails_idempotent` plugs the hole going
forward; this sweep guarantees that any future regression of the
email path is caught within minutes — not days.
"""
import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone

logger = logging.getLogger(__name__)

# Tunables — env-overridable
ORPHAN_GRACE_MINUTES = int(os.environ.get("ORPHAN_ORDER_GRACE_MINUTES", "10"))
ORPHAN_MAX_AGE_HOURS = int(os.environ.get("ORPHAN_ORDER_MAX_AGE_HOURS", "72"))
ORPHAN_SWEEP_INTERVAL_SECONDS = int(os.environ.get("ORPHAN_ORDER_SWEEP_INTERVAL_S", "300"))
ORPHAN_MAX_PER_PASS = int(os.environ.get("ORPHAN_ORDER_MAX_PER_PASS", "50"))


async def run_orphaned_orders_sweep() -> dict:
    """One pass. Returns a summary dict for logging / tests.

    Returns:
        {
          "scanned": int,
          "recovered": int,
          "failed": int,
          "order_numbers": [str],  # the orders we processed
        }
    """
    from config import get_db
    db = get_db()
    now = datetime.now(timezone.utc)
    grace_cutoff = (now - timedelta(minutes=ORPHAN_GRACE_MINUTES)).isoformat()
    age_cutoff = (now - timedelta(hours=ORPHAN_MAX_AGE_HOURS)).isoformat()

    # Mongo query — find paid orders whose marker is missing AND whose
    # paid_at is in the recovery window. `$in: [None, "", missing]`
    # is expressed via a `$or` covering all three legacy shapes.
    cursor = db.shop_orders.find(
        {
            "payment_status": "paid",
            "$or": [
                {"confirmation_email_sent_at": {"$exists": False}},
                {"confirmation_email_sent_at": None},
                {"confirmation_email_sent_at": ""},
            ],
            "paid_at": {"$lte": grace_cutoff, "$gte": age_cutoff},
        },
        {"_id": 0, "id": 1, "order_number": 1, "customer_email": 1, "total": 1,
         "paid_at": 1},
    ).sort("paid_at", 1).limit(ORPHAN_MAX_PER_PASS)
    orphans = await cursor.to_list(ORPHAN_MAX_PER_PASS)

    if not orphans:
        return {"scanned": 0, "recovered": 0, "failed": 0, "order_numbers": []}

    # Process serially so one slow Resend call doesn't pile up dozens
    # of in-flight tasks on the cron loop.
    from services.email import send_order_confirmation_emails_idempotent
    recovered = 0
    failed = 0
    processed_numbers: list = []
    for orphan in orphans:
        order_id = orphan["id"]
        order_number = orphan.get("order_number") or order_id
        processed_numbers.append(order_number)
        try:
            result = await send_order_confirmation_emails_idempotent(order_id)
            if result.get("already_sent"):
                # Race: another path claimed it between query + send.
                # Count as recovered (it's no longer an orphan).
                recovered += 1
                continue
            customer_ok = result.get("customer", {}).get("success")
            owner_ok = result.get("owner", {}).get("success")
            if customer_ok or owner_ok:
                recovered += 1
            else:
                failed += 1
        except Exception:
            logger.exception("[orphan-orders] failed to recover %s", order_number)
            failed += 1

    # Single Telegram alert per pass — owner sees a clear "🚨 N orphan
    # orders auto-recovered" line. We deliberately fire ONE message per
    # pass, not per order, so a backlog can't spam the chat.
    try:
        from services.telegram_notify import fire_and_forget as _tg_ff
        if recovered:
            sample = ", ".join(processed_numbers[:5])
            tail = f" (+{len(processed_numbers) - 5} more)" if len(processed_numbers) > 5 else ""
            _tg_ff(
                "alert",
                f"🚨 <b>Orphan-orders sweep</b>\n"
                f"Recovered <b>{recovered}</b> paid order(s) whose confirmation "
                f"emails never fired.\n"
                f"Examples: {sample}{tail}\n"
                f"Failures this pass: {failed}",
                dedupe_key=f"orphan-sweep:{now.isoformat()[:13]}",  # one alert per hour bucket
            )
        elif failed:
            _tg_ff(
                "alert",
                f"⚠️ <b>Orphan-orders sweep</b>\n"
                f"{failed} order(s) detected but recovery emails failed. Check Resend logs.",
                dedupe_key=f"orphan-sweep-fail:{now.isoformat()[:13]}",
            )
    except Exception:
        logger.exception("[orphan-orders] Telegram alert failed")

    summary = {
        "scanned": len(orphans),
        "recovered": recovered,
        "failed": failed,
        "order_numbers": processed_numbers,
    }
    logger.info("[orphan-orders] pass complete: %s", summary)
    return summary


async def orphan_orders_sweep_loop():
    """Long-running background loop. Wrap with the same try/sleep
    pattern as the visa-alerts loop so a single exception in one pass
    can't kill the loop."""
    # Let the boot settle so we don't compete with startup work
    await asyncio.sleep(120)
    while True:
        try:
            await run_orphaned_orders_sweep()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("[orphan-orders] outer loop pass crashed; continuing")
        await asyncio.sleep(ORPHAN_SWEEP_INTERVAL_SECONDS)

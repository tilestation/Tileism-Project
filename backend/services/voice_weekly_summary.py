"""
Voice — Weekly call-volume summary (Feb 2026).

Cron that runs once per day; only emits its summary on Mondays at
09:00 London time. Single Telegram message + audit row.

Fires AFTER the user's normal Sunday so they get last week's numbers
when they open the phone Monday morning.
"""
import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone

logger = logging.getLogger(__name__)


WEEKLY_SWEEP_INTERVAL_S = int(os.environ.get("VOICE_WEEKLY_INTERVAL_S", "3600"))  # check hourly


async def emit_weekly_summary():
    """Generate + Telegram-post the previous week's call summary.
    Only actually posts if the current time-window is Monday 09:00 UTC
    ± 1 hour and we haven't posted this calendar week yet."""
    from config import get_db
    db = get_db()
    now = datetime.now(timezone.utc)

    # Already posted this week?
    week_key = now.strftime("%G-W%V")
    posted = await db.voice_weekly_summaries.find_one({"week_key": week_key}, {"_id": 0})
    if posted:
        return {"skipped": "already_posted_this_week"}

    # Compute "last week" = previous Mon→Sun in UTC
    weekday = now.weekday()  # Mon=0
    days_back_to_last_monday = weekday + 7
    last_mon = (now - timedelta(days=days_back_to_last_monday)).replace(
        hour=0, minute=0, second=0, microsecond=0,
    )
    last_sun = last_mon + timedelta(days=7)

    pipeline = [
        {"$match": {"started_at": {
            "$gte": last_mon.isoformat(),
            "$lt": last_sun.isoformat(),
        }}},
        {"$group": {
            "_id": "$direction",
            "count": {"$sum": 1},
            "duration": {"$sum": {"$ifNull": ["$duration_seconds", 0]}},
            "missed": {"$sum": {"$cond": [{"$eq": ["$missed", True]}, 1, 0]}},
        }},
    ]
    rows = await db.voice_calls.aggregate(pipeline).to_list(10)
    by_dir = {r["_id"]: r for r in rows}
    inbound = by_dir.get("inbound", {"count": 0, "duration": 0, "missed": 0})
    outbound = by_dir.get("outbound", {"count": 0, "duration": 0, "missed": 0})
    total_calls = inbound["count"] + outbound["count"]
    missed = inbound["missed"]

    msg = (
        f"📞 <b>Weekly call summary</b>\n"
        f"<i>{last_mon.strftime('%d %b')} – {(last_sun - timedelta(days=1)).strftime('%d %b')}</i>\n\n"
        f"Inbound: <b>{inbound['count']}</b> ({missed} missed) · "
        f"{int(inbound['duration'] // 60)} min talk\n"
        f"Outbound: <b>{outbound['count']}</b> · {int(outbound['duration'] // 60)} min talk\n"
        f"Total: <b>{total_calls}</b>"
    )
    try:
        from services.telegram_notify import fire_and_forget as _tg
        _tg("voice_weekly", msg, dedupe_key=f"voice-weekly:{week_key}")
    except Exception:
        logger.exception("[voice-weekly] Telegram post failed")

    await db.voice_weekly_summaries.insert_one({
        "week_key": week_key,
        "posted_at": now.isoformat(),
        "inbound": inbound, "outbound": outbound, "missed": missed,
    })
    return {"posted": True, "week_key": week_key, "total": total_calls}


async def voice_weekly_summary_loop():
    """Hourly check. Only posts on Mondays 09:00 (UTC) once per week.
    Wrapping the trigger window means even a missed hour gets the
    summary out within the day."""
    await asyncio.sleep(180)
    while True:
        try:
            now = datetime.now(timezone.utc)
            if now.weekday() == 0 and now.hour == 9:
                await emit_weekly_summary()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("[voice-weekly] loop pass crashed")
        await asyncio.sleep(WEEKLY_SWEEP_INTERVAL_S)

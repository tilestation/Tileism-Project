"""Radio off-air Telegram alerts.

Pages the super-admin when a showroom's radio drops off-air during
opening hours, then again when it returns. Uses the same
`telegram_notify.notify_event` mechanism as every other alerting
subsystem so the per-event toggle + dedupe window are honoured.

State machine per device:

    on-air  ─────(5 min no heartbeat during opening hours)──→ off-air
                                                                  │
                                                          (heartbeat
                                                           seen again)
                                                                  ↓
                                                              on-air

Both transitions fire a single Telegram per state change. We don't
ping every minute that a device is still off-air — only at the
boundary. The `radio_offair_alerts` collection stores one row per
currently-off-air device so we know who NOT to re-page and who to
send a "back on-air" message about when they return.

Designed to integrate with the existing apscheduler tick model in
`services/scheduler.py`. See the new job registration there.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo

from config import get_db
from services.telegram_notify import notify_event

logger = logging.getLogger(__name__)

# ------------------------------------------------------------------
# Tunables — kept in code (rather than DB settings) for v1 simplicity.
# If the admin wants to override either, expose a small admin endpoint
# later; the alert path already reads `last_seen_at` cutoffs from
# these constants every tick so it's a one-line change to swap to a
# settings-collection lookup.
# ------------------------------------------------------------------

# How long after the LAST heartbeat we declare a device off-air.
# Public radio page pings every 30 s, so 5 minutes = 10 missed pings.
# Generous enough to ride out a corporate WiFi blip + a tab reload.
OFFAIR_THRESHOLD_SECONDS = 5 * 60

# How far back to look when deciding "this device WAS active recently
# enough that going silent matters". If a device hasn't pinged in
# over an hour we treat it as "long gone" and don't fire (avoids
# alerting on every closed laptop indefinitely).
RECENT_ACTIVE_WINDOW_SECONDS = 60 * 60

# Opening hours during which we care. Outside these hours the radio
# is expected to be off — no Telegram. Configurable later.
OPENING_HOUR_LOCAL = 9
CLOSING_HOUR_LOCAL = 18
LOCAL_TZ = "Europe/London"


# ------------------------------------------------------------------
# Internal helpers
# ------------------------------------------------------------------

def _is_within_opening_hours(now_utc: Optional[datetime] = None) -> bool:
    """True if the current local time is inside the configured
    opening window. We use Europe/London which auto-handles BST/GMT
    via zoneinfo."""
    now_utc = now_utc or datetime.now(timezone.utc)
    try:
        local = now_utc.astimezone(ZoneInfo(LOCAL_TZ))
    except Exception:  # noqa: BLE001 — bad tz data; fail open so we DO alert
        local = now_utc
    return OPENING_HOUR_LOCAL <= local.hour < CLOSING_HOUR_LOCAL


def _format_local_time(iso_str: str) -> str:
    """Pretty-print an ISO timestamp into "HH:MM" local time for the
    Telegram message body. Never raises — falls back to the raw
    string if parsing fails."""
    try:
        dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        local = dt.astimezone(ZoneInfo(LOCAL_TZ))
        return local.strftime("%H:%M")
    except Exception:  # noqa: BLE001
        return iso_str[:16].replace("T", " ")


# ------------------------------------------------------------------
# Public tick
# ------------------------------------------------------------------

async def run_radio_offair_tick() -> dict:
    """Scheduler entry point. Returns a small summary dict for log
    consumption. Designed to be safe to call from any interval; the
    alert collection is the source of truth for what's already been
    paged, so duplicate ticks are no-ops.

    Workflow:
      1. Skip entirely if we're outside opening hours.
      2. For each device with a label AND a last_seen within the
         recent-active window:
           a. last_seen older than the off-air threshold → if we
              haven't already alerted for THIS dropout, send a
              Telegram and record the alert.
           b. last_seen newer than the threshold → if we previously
              alerted, send a "back on-air" Telegram and clear the
              alert record.
    """
    now_utc = datetime.now(timezone.utc)
    if not _is_within_opening_hours(now_utc):
        return {"skipped": "outside_opening_hours", "tz": LOCAL_TZ}

    db = get_db()
    # Only consider labelled devices — unlabelled UUIDs would page
    # the admin with "abc12345... dropped off-air" which is useless.
    cursor = db.radio_tune_in_heartbeats.find(
        {"device_label": {"$exists": True, "$ne": ""}},
        {"_id": 0, "device_id": 1, "device_label": 1, "last_seen_at": 1},
    )
    devices = [d async for d in cursor]
    if not devices:
        return {"checked": 0, "fired": 0, "recovered": 0}

    offair_cutoff = (now_utc - timedelta(seconds=OFFAIR_THRESHOLD_SECONDS)).isoformat()
    recent_cutoff = (now_utc - timedelta(seconds=RECENT_ACTIVE_WINDOW_SECONDS)).isoformat()

    fired = 0
    recovered = 0
    for d in devices:
        device_id = d.get("device_id")
        label = (d.get("device_label") or "").strip()
        last_seen = d.get("last_seen_at") or ""
        if not device_id or not label or not last_seen:
            continue

        existing_alert = await db.radio_offair_alerts.find_one(
            {"device_id": device_id}, {"_id": 0}
        )

        # ---- Off-air branch -----------------------------------------
        if last_seen < offair_cutoff:
            # Skip devices that have been gone for ages — they're
            # not "dropped off-air today", they're "not in use".
            if last_seen < recent_cutoff:
                # If we previously alerted on this device and they
                # never came back, leave the alert record in place
                # but don't ping again. Keeps the marker so a future
                # heartbeat triggers the "back on-air" message.
                continue
            if existing_alert:
                # Already paged the admin about THIS dropout.
                continue
            try:
                await notify_event(
                    "radio_offair",
                    (
                        f"📻 <b>{label} dropped off-air</b>\n"
                        f"Last heartbeat at {_format_local_time(last_seen)}.\n"
                        f"Check the showroom radio tab — it may have closed "
                        f"or the device lost WiFi."
                    ),
                    dedupe_key=device_id,
                )
            except Exception:  # noqa: BLE001
                logger.exception("Telegram off-air ping failed for %s", label)
                continue
            await db.radio_offair_alerts.update_one(
                {"device_id": device_id},
                {"$set": {
                    "device_id": device_id,
                    "device_label": label,
                    "alerted_at": now_utc.isoformat(),
                    "last_seen_at_alert": last_seen,
                }},
                upsert=True,
            )
            fired += 1
            continue

        # ---- Recovery branch ----------------------------------------
        # Device IS within the threshold (i.e. on-air right now). If
        # we previously alerted about it being off-air, send the
        # "back on-air" ping and clear the marker.
        if existing_alert:
            try:
                await notify_event(
                    "radio_offair",
                    (
                        f"📻 ✅ <b>{label} back on-air</b>\n"
                        f"Heartbeat resumed at {_format_local_time(last_seen)}."
                    ),
                    dedupe_key=f"{device_id}:recovered",
                )
            except Exception:  # noqa: BLE001
                logger.exception("Telegram back-on-air ping failed for %s", label)
            await db.radio_offair_alerts.delete_one({"device_id": device_id})
            recovered += 1

    return {"checked": len(devices), "fired": fired, "recovered": recovered}

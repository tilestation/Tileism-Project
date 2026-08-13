"""
Sync failure alerting.

Records scraper/sync failures to the `sync_failures` collection and notifies
the owner by email (Resend) and Telegram (when TELEGRAM_BOT_TOKEN +
TELEGRAM_CHAT_ID are configured). Also detects "stuck" syncs that have been
running for hours — a scraper that died mid-run without reporting an error.
"""
import logging
import os
import threading
import uuid
from datetime import datetime, timezone, timedelta

from pymongo import MongoClient

logger = logging.getLogger(__name__)

DEDUP_MINUTES = 30  # don't re-alert the same supplier within this window
STUCK_AFTER_HOURS = 3.0


def _db():
    mongo_url = os.environ.get("MONGO_URL")
    return MongoClient(mongo_url)[os.environ.get("DB_NAME", "tile_station")]


def record_sync_failure(supplier: str, error: str, sync_type: str = "server"):
    """Log a sync failure + fire owner notifications in the background. Never raises."""
    try:
        db = _db()
        cutoff = (datetime.now(timezone.utc) - timedelta(minutes=DEDUP_MINUTES)).isoformat()
        recent = db.sync_failures.find_one({
            "supplier": supplier,
            "dismissed": False,
            "occurred_at": {"$gte": cutoff},
        })
        if recent:
            logger.info(f"[SYNC ALERT] {supplier} already alerted within {DEDUP_MINUTES}m — skipping duplicate")
            return
        doc = {
            "id": str(uuid.uuid4()),
            "supplier": supplier,
            "error": (error or "Unknown error")[:500],
            "sync_type": sync_type or "server",
            "occurred_at": datetime.now(timezone.utc).isoformat(),
            "dismissed": False,
            "email_sent": False,
            "telegram_sent": False,
        }
        db.sync_failures.insert_one(doc)
        doc.pop("_id", None)
        logger.warning(f"[SYNC ALERT] Recorded failure for {supplier}: {doc['error'][:120]}")
        threading.Thread(target=_notify, args=(doc,), daemon=True).start()
    except Exception:
        logger.exception("[SYNC ALERT] Failed to record sync failure")


def _notify(doc: dict):
    updates = {}
    try:
        if _send_email(doc):
            updates["email_sent"] = True
    except Exception as e:
        logger.warning(f"[SYNC ALERT] Email notification failed: {e}")
    try:
        if _send_telegram(doc):
            updates["telegram_sent"] = True
    except Exception as e:
        logger.warning(f"[SYNC ALERT] Telegram notification failed: {e}")
    if updates:
        try:
            _db().sync_failures.update_one({"id": doc["id"]}, {"$set": updates})
        except Exception:
            pass


def _send_email(doc: dict) -> bool:
    api_key = os.environ.get("RESEND_API_KEY")
    if not api_key:
        return False
    import resend
    resend.api_key = api_key
    sender = os.environ.get("SENDER_EMAIL", "online@tilestation.co.uk")
    to_addr = os.environ.get("ADMIN_EMAIL", "qasim@tilestation.co.uk")
    when = doc["occurred_at"][:16].replace("T", " ") + " UTC"
    html = f"""
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #dc2626; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0; font-size: 22px;">🔴 SYNC FAILURE</h1>
            <p style="margin: 5px 0 0 0; font-size: 14px;">Tile Station — Supplier Sync Monitor</p>
        </div>
        <div style="padding: 28px; background: #fef2f2;">
            <p style="font-size: 15px; color: #7f1d1d; margin: 0 0 18px 0;">
                A supplier sync <strong>died or failed to log in</strong>. Stock and cost prices
                from this supplier may now be <strong>stale</strong> until the sync runs cleanly.
            </p>
            <div style="background: white; border: 1px solid #fecaca; border-left: 4px solid #dc2626; border-radius: 8px; padding: 18px;">
                <table style="width:100%; font-size:14px; color:#1a1a2e;">
                    <tr><td style="padding:5px 0; color:#991b1b; width:110px;"><strong>Supplier</strong></td><td style="padding:5px 0; font-weight:700;">{doc['supplier']}</td></tr>
                    <tr><td style="padding:5px 0; color:#991b1b;"><strong>Sync type</strong></td><td style="padding:5px 0;">{doc['sync_type']}</td></tr>
                    <tr><td style="padding:5px 0; color:#991b1b;"><strong>When</strong></td><td style="padding:5px 0;">{when}</td></tr>
                    <tr><td style="padding:5px 0; color:#991b1b; vertical-align:top;"><strong>Error</strong></td><td style="padding:5px 0; font-family:monospace; font-size:13px;">{doc['error']}</td></tr>
                </table>
            </div>
            <p style="text-align:center; margin: 24px 0 0 0;">
                <a href="https://www.tilestation.co.uk/admin/sync-hub" style="background:#1a1a2e; color:#f0c14b; padding:12px 26px; text-decoration:none; border-radius:8px; font-weight:bold; display:inline-block;">
                    Open Sync Hub →
                </a>
            </p>
        </div>
        <div style="background: #1a1a2e; color: #888; padding: 12px; text-align: center; font-size: 11px;">
            Automated alert from the Tile Station sync monitor.
        </div>
    </div>
    """
    resend.Emails.send({
        "from": f"Tile Station Sync Monitor <{sender}>",
        "to": [to_addr],
        "subject": f"🔴 {doc['supplier']} sync FAILED — stock/prices may be stale",
        "html": html,
    })
    logger.info(f"[SYNC ALERT] Failure email sent to {to_addr} for {doc['supplier']}")
    return True


def _send_telegram(doc: dict) -> bool:
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        return False
    import requests
    text = (
        f"🔴 SYNC FAILURE\n\n"
        f"Supplier: {doc['supplier']}\n"
        f"Type: {doc['sync_type']}\n"
        f"Error: {doc['error']}\n\n"
        f"Stock & prices may be stale — check the Sync Hub."
    )
    r = requests.post(
        f"https://api.telegram.org/bot{token}/sendMessage",
        json={"chat_id": chat_id, "text": text},
        timeout=15,
    )
    if r.ok:
        logger.info(f"[SYNC ALERT] Telegram alert sent for {doc['supplier']}")
    return r.ok


def get_active_failures(hours: int = 72) -> list:
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    return list(_db().sync_failures.find(
        {"dismissed": False, "occurred_at": {"$gte": cutoff}},
        {"_id": 0},
    ).sort("occurred_at", -1).limit(20))


def dismiss_failures(failure_id: str = None, dismiss_all: bool = False) -> int:
    db = _db()
    now = datetime.now(timezone.utc).isoformat()
    if dismiss_all:
        res = db.sync_failures.update_many(
            {"dismissed": False}, {"$set": {"dismissed": True, "dismissed_at": now}}
        )
        return res.modified_count
    if failure_id:
        res = db.sync_failures.update_one(
            {"id": failure_id}, {"$set": {"dismissed": True, "dismissed_at": now}}
        )
        return res.modified_count
    return 0


def get_stuck_syncs(max_hours: float = STUCK_AFTER_HOURS) -> list:
    """A sync claiming to be 'running' for hours has almost certainly died mid-run."""
    stuck = []
    try:
        from services import splendour_sync, ceramica_impex_sync, wallcano_sync
        runners = [
            ("Splendour", splendour_sync),
            ("Ceramica Impex", ceramica_impex_sync),
            ("Wallcano", wallcano_sync),
        ]
        now = datetime.now(timezone.utc)
        for name, mod in runners:
            state = mod.get_sync_state()
            if not state.get("is_running"):
                continue
            started = state.get("started_at")
            if not started:
                continue
            try:
                started_dt = datetime.fromisoformat(str(started).replace("Z", "+00:00"))
                if started_dt.tzinfo is None:
                    started_dt = started_dt.replace(tzinfo=timezone.utc)
            except (ValueError, TypeError):
                continue
            running_hours = (now - started_dt).total_seconds() / 3600
            if running_hours >= max_hours:
                stuck.append({
                    "supplier": name,
                    "running_hours": round(running_hours, 1),
                    "phase": state.get("phase"),
                    "message": state.get("message"),
                })
    except Exception:
        logger.exception("[SYNC ALERT] stuck-sync check failed")
    return stuck

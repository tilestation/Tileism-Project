"""
Nightly light-sync runner.

Runs a LIGHT sync (stock & prices only) for every supplier with a server-side
sync — Splendour, Ceramica Impex, Wallcano — one after another. Results are
only STAGED in the Sync Hub for morning review; nothing is auto-applied.
"""
import asyncio
import logging
import os
from datetime import datetime, timezone

from pymongo import MongoClient

logger = logging.getLogger(__name__)

SETTINGS_ID = "nightly_light_sync"
SUPPLIERS = ["Splendour", "Ceramica Impex", "Wallcano"]

_run_lock = False


def _db():
    mongo_url = os.environ.get("MONGO_URL")
    if not mongo_url:
        raise ValueError("MONGO_URL environment variable is required")
    return MongoClient(mongo_url)[os.environ.get("DB_NAME", "tile_station")]


def get_settings(db=None):
    db = db if db is not None else _db()
    doc = db.scheduler_settings.find_one({"_id": SETTINGS_ID}) or {}
    return {
        "enabled": doc.get("enabled", True),
        "hour": doc.get("hour", 1),
        "minute": doc.get("minute", 0),
    }


def set_enabled(enabled: bool):
    _db().scheduler_settings.update_one(
        {"_id": SETTINGS_ID},
        {"$set": {"enabled": enabled, "updated_at": datetime.now(timezone.utc)}},
        upsert=True,
    )


def get_last_run(db=None):
    db = db if db is not None else _db()
    doc = db.nightly_sync_log.find_one({}, sort=[("started_at", -1)])
    if not doc:
        return None
    doc.pop("_id", None)
    return doc


def _runners():
    from services import splendour_sync, ceramica_impex_sync, wallcano_sync
    return [
        ("Splendour", splendour_sync.run_quick_sync, splendour_sync.get_sync_state),
        ("Ceramica Impex", ceramica_impex_sync.run_light_sync, ceramica_impex_sync.get_sync_state),
        ("Wallcano", wallcano_sync.run_light_sync, wallcano_sync.get_sync_state),
    ]


async def run_nightly_light_syncs(manual: bool = False):
    """Sequential light sync for all suppliers. Stages updates only — no auto-apply."""
    global _run_lock
    if _run_lock:
        logger.info("[NIGHTLY SYNC] Already running — skipping")
        return {"error": "Nightly sync already running"}

    db = _db()
    settings = get_settings(db)
    if not settings["enabled"] and not manual:
        logger.info("[NIGHTLY SYNC] Disabled — skipping scheduled run")
        return {"skipped": "disabled"}

    _run_lock = True
    started = datetime.now(timezone.utc)
    results = {}
    try:
        for name, runner, get_state in _runners():
            try:
                if get_state().get("is_running"):
                    results[name] = {"skipped": True, "reason": "a sync was already running for this supplier"}
                    continue
                logger.info(f"[NIGHTLY SYNC] Starting light sync for {name}...")
                ret = await runner(db)
                state = get_state()
                results[name] = {
                    "synced": state.get("products_synced", 0),
                    "failed": state.get("products_failed", 0),
                    "skipped_products": state.get("products_skipped", 0),
                    "phase": state.get("phase"),
                    "message": state.get("message"),
                }
                if isinstance(ret, dict) and ret.get("error"):
                    results[name]["error"] = str(ret["error"])[:300]
                logger.info(f"[NIGHTLY SYNC] {name} done: {results[name]}")
            except Exception as e:
                logger.exception(f"[NIGHTLY SYNC] {name} crashed")
                results[name] = {"error": str(e)[:300]}
    finally:
        _run_lock = False

    finished = datetime.now(timezone.utc)
    total_synced = sum(r.get("synced", 0) for r in results.values() if isinstance(r, dict))
    log_doc = {
        "started_at": started,
        "completed_at": finished,
        "duration_seconds": int((finished - started).total_seconds()),
        "trigger": "manual" if manual else "schedule",
        "total_synced": total_synced,
        "results": results,
    }
    db.nightly_sync_log.insert_one(log_doc)
    logger.info(f"[NIGHTLY SYNC] Complete — {total_synced} products refreshed across {len(results)} suppliers")
    log_doc.pop("_id", None)
    return log_doc


def is_running() -> bool:
    return _run_lock


def start_run_in_background():
    """Manual trigger — runs the full nightly cycle in a background thread."""
    import threading

    def _run():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(run_nightly_light_syncs(manual=True))
        except Exception:
            logger.exception("[NIGHTLY SYNC] manual run crashed")
        finally:
            loop.close()

    threading.Thread(target=_run, daemon=True).start()
    return {"started": True}

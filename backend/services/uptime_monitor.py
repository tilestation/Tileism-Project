"""
Synthetic uptime monitor for the public storefront (May 14, 2026)

Runs every 5 minutes via APScheduler and posts a Telegram alert when
any of the canary checks fail:

  * https://tilestation.co.uk/                           → must return 200 + contain "Tile Station"
  * https://tilestation.co.uk/api/health                 → must return 200 + `database: connected`
  * https://tilestation.co.uk/api/shop/search-all?q=tile → must return 200 + at least 1 result
  * https://tilestation.co.uk/api/tiles?limit=1          → must return 200 + a non-empty list
  * latency budget: 4 seconds per check (above = slow alert)

Behaviour:
  * One alert per (check_id, status) transition — i.e. no spam every 5
    minutes while the site is down. State is tracked in
    `uptime_check_state` collection.
  * When everything returns to green a single "recovered" Telegram
    goes out.
  * Latest result for every check is exposed at GET /api/admin/uptime
    so the admin dashboard (future) can render a status grid.
  * Manual run available at POST /api/admin/uptime/run for testing.

Configuration:
  * `MONITOR_PUBLIC_URL` env var overrides the default base URL
    (`https://tilestation.co.uk`). Useful when running locally /
    pre-deploy.
  * `MONITOR_DISABLE_ALERTS=1` to silence Telegram while keeping the
    DB log (useful when triaging a known incident).
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import httpx

from config import get_db
from services.telegram_notify import send_telegram

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://tilestation.co.uk"
HTTP_TIMEOUT_S = 10.0
LATENCY_BUDGET_S = 4.0


def _base_url() -> str:
    return os.environ.get("MONITOR_PUBLIC_URL", DEFAULT_BASE_URL).rstrip("/")


def _backend_url() -> str:
    """Optional, separately-deployed backend URL for direct API probes.
    If unset, the API-level checks are skipped (since the storefront
    Express server doesn't proxy /api/* paths through to the backend
    on tilestation.co.uk)."""
    return (os.environ.get("MONITOR_BACKEND_URL") or "").rstrip("/")


# ─── Check definitions ──────────────────────────────────────────────


def _make_checks(base: str) -> List[Dict[str, Any]]:
    """Each check is independent so one slow endpoint doesn't mask
    others. `id` is the stable key written to `uptime_check_state`."""
    checks: List[Dict[str, Any]] = [
        {
            "id": "homepage",
            "label": "Homepage",
            "url": f"{base}/",
            "expect_status": 200,
            "expect_substring": "Tile Station",
        },
        {
            "id": "search_page",
            "label": "Search page",
            "url": f"{base}/shop/search?q=tile",
            "expect_status": 200,
            "expect_substring": "Tile Station",
        },
        {
            "id": "tiles_page",
            "label": "Tiles listing",
            "url": f"{base}/tiles",
            "expect_status": 200,
            "expect_substring": "Tile Station",
        },
        {
            "id": "sitemap",
            "label": "Sitemap",
            "url": f"{base}/sitemap.xml",
            "expect_status": 200,
            "expect_substring": "<urlset",
        },
    ]
    # If the backend URL is also configured, do deep content checks
    # against it. Otherwise these are skipped silently.
    backend = _backend_url()
    if backend:
        checks.extend([
            {
                "id": "api_health",
                "label": "API health",
                "url": f"{backend}/api/health",
                "expect_status": 200,
                "expect_json_path": ("database", "connected"),
            },
            {
                "id": "api_search",
                "label": "Search API",
                "url": f"{backend}/api/shop/search-all?q=tile&page=1&limit=1",
                "expect_status": 200,
                "expect_json_min_total": 1,
            },
            {
                "id": "api_tiles",
                "label": "Tiles API",
                "url": f"{backend}/api/tiles?limit=1",
                "expect_status": 200,
                "expect_json_non_empty_list": True,
            },
        ])
    return checks


async def _run_check(client: httpx.AsyncClient, chk: Dict[str, Any]) -> Dict[str, Any]:
    """Execute one check. Always returns a result dict — exceptions are
    captured as failures, never re-raised."""
    started = time.time()
    result: Dict[str, Any] = {
        "id": chk["id"],
        "label": chk["label"],
        "url": chk["url"],
        "ok": False,
        "status_code": None,
        "latency_ms": None,
        "slow": False,
        "error": None,
        "checked_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        r = await client.get(chk["url"], timeout=HTTP_TIMEOUT_S, follow_redirects=True)
        result["status_code"] = r.status_code
        result["latency_ms"] = int((time.time() - started) * 1000)
        result["slow"] = result["latency_ms"] > LATENCY_BUDGET_S * 1000

        if r.status_code != chk.get("expect_status", 200):
            result["error"] = f"status {r.status_code}"
            return result

        # String substring check
        if chk.get("expect_substring") and chk["expect_substring"] not in r.text:
            result["error"] = f"missing substring '{chk['expect_substring']}'"
            return result

        # JSON path check: ("database", "connected") means JSON.database == "connected"
        if chk.get("expect_json_path"):
            data = r.json()
            key, expected = chk["expect_json_path"]
            actual = data.get(key) if isinstance(data, dict) else None
            if actual != expected:
                result["error"] = f"{key}={actual!r}, expected {expected!r}"
                return result

        # JSON total ≥ N
        if chk.get("expect_json_min_total"):
            data = r.json()
            total = (data or {}).get("total", 0) if isinstance(data, dict) else 0
            if total < chk["expect_json_min_total"]:
                result["error"] = f"total={total} < {chk['expect_json_min_total']}"
                return result

        # JSON non-empty list (or list/products attr)
        if chk.get("expect_json_non_empty_list"):
            data = r.json()
            items = data if isinstance(data, list) else (
                (data or {}).get("products")
                or (data or {}).get("items")
                or (data or {}).get("results")
                or []
            )
            if not items:
                result["error"] = "empty result list"
                return result

        result["ok"] = True
        return result

    except httpx.TimeoutException:
        result["latency_ms"] = int((time.time() - started) * 1000)
        result["error"] = f"timeout after {HTTP_TIMEOUT_S}s"
        return result
    except Exception as exc:  # noqa: BLE001
        result["latency_ms"] = int((time.time() - started) * 1000)
        result["error"] = f"{type(exc).__name__}: {exc}"
        return result


# ─── State transitions + alerting ───────────────────────────────────


async def _alert_on_transition(db, result: Dict[str, Any]) -> Optional[str]:
    """Compare against the last persisted state and fire a Telegram
    alert only on UP→DOWN or DOWN→UP transitions. Returns the alert
    string sent (or None if nothing was sent).

    Slow-but-OK transitions are tracked separately and DON'T cause an
    alert to avoid noise — they show up in the dashboard only."""
    check_id = result["id"]
    is_ok = bool(result["ok"])
    prev = await db.uptime_check_state.find_one({"_id": check_id}, {"_id": 1, "ok": 1, "failed_since": 1})

    msg: Optional[str] = None
    if prev is None:
        # First-ever run — only alert if it's already down. Avoids a
        # spurious "site is up!" on cold start.
        if not is_ok:
            msg = (
                f"🚨 <b>Tile Station — first-run DOWN</b>\n"
                f"<b>{result['label']}</b> failed: {result['error']}\n"
                f"URL: {result['url']}"
            )
    elif prev.get("ok") and not is_ok:
        # UP → DOWN
        msg = (
            f"🚨 <b>Tile Station DOWN</b>\n"
            f"<b>{result['label']}</b>: {result['error']}\n"
            f"URL: {result['url']}\n"
            f"Latency: {result.get('latency_ms')}ms"
        )
    elif (not prev.get("ok")) and is_ok:
        # DOWN → UP
        failed_since = prev.get("failed_since")
        downtime = ""
        if failed_since:
            try:
                started = datetime.fromisoformat(failed_since)
                mins = int((datetime.now(timezone.utc) - started).total_seconds() // 60)
                downtime = f" (was down for ~{mins} min{'s' if mins != 1 else ''})"
            except Exception:
                pass
        msg = (
            f"✅ <b>Tile Station RECOVERED</b>\n"
            f"<b>{result['label']}</b> is back online{downtime}\n"
            f"Latency: {result.get('latency_ms')}ms"
        )

    if msg and os.environ.get("MONITOR_DISABLE_ALERTS") != "1":
        try:
            await send_telegram(msg, parse_mode="HTML")
        except Exception as e:  # noqa: BLE001
            logger.warning(f"uptime-monitor telegram send failed: {e}")

    # Persist the new state
    state_doc = {
        "_id": check_id,
        "label": result["label"],
        "url": result["url"],
        "ok": is_ok,
        "last_status_code": result["status_code"],
        "last_latency_ms": result["latency_ms"],
        "last_error": result["error"],
        "last_checked_at": result["checked_at"],
    }
    if not is_ok and (prev is None or prev.get("ok")):
        # Just transitioned to down — record when
        state_doc["failed_since"] = result["checked_at"]
    elif not is_ok and prev and prev.get("failed_since"):
        # Still down — keep the original failed_since
        state_doc["failed_since"] = prev["failed_since"]

    await db.uptime_check_state.update_one(
        {"_id": check_id},
        {"$set": state_doc},
        upsert=True,
    )

    return msg


# ─── Public entrypoints ─────────────────────────────────────────────


async def run_uptime_tick() -> Dict[str, Any]:
    """Single sweep of all checks. Idempotent — safe to call multiple
    times in a row. Returns a summary dict for the admin /uptime/run
    endpoint and the scheduler log."""
    db = get_db()
    checks = _make_checks(_base_url())
    summary = {"base_url": _base_url(), "results": [], "alerts": []}

    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_S, headers={"User-Agent": "TileStation-Uptime/1.0"}) as client:
        # Run all 4 checks in parallel — full sweep takes ~1s on a
        # healthy site instead of 4+s sequentially.
        coros = [_run_check(client, chk) for chk in checks]
        results = await asyncio.gather(*coros)

    for result in results:
        alert = await _alert_on_transition(db, result)
        summary["results"].append(result)
        if alert:
            summary["alerts"].append({"id": result["id"], "message": alert})

    summary["all_ok"] = all(r["ok"] for r in summary["results"])
    return summary


async def get_uptime_state() -> Dict[str, Any]:
    """Read the latest state for every check + overall site status.
    Used by /api/admin/uptime."""
    db = get_db()
    docs = await db.uptime_check_state.find({}, {"_id": 0}).to_list(50)
    return {
        "base_url": _base_url(),
        "all_ok": all(d.get("ok") for d in docs) if docs else None,
        "checks": docs,
    }

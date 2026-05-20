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
    others. `id` is the stable key written to `uptime_check_state`.

    Optional `latency_budget_s` per check overrides the default. The
    sitemap is intrinsically slower (560 URLs, 6 DB collections, dynamic
    rebuild) so it gets a 15s budget instead of the global 4s default."""
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
            # 14 May 2026 — bumped from default 4s. The sitemap rebuilds
            # from 6 DB collections (~600 docs total) on cache miss, so
            # the first request after the 5-min TTL expires can take 4-8s
            # legitimately. False alarms here would teach the team to
            # ignore the monitor — kill the false alarm instead.
            "latency_budget_s": 15.0,
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
        # Per-check timeout: use the latency budget so the request only
        # aborts when it's *truly* hung. Without this, a slow-but-OK
        # sitemap (4-12s legit response time on a 560-URL rebuild) got
        # treated as a timeout failure even though it was still serving
        # correct content. 14 May 2026 — was a single global 10s.
        request_timeout = chk.get("latency_budget_s", HTTP_TIMEOUT_S) + 5.0
        r = await client.get(chk["url"], timeout=request_timeout, follow_redirects=True)
        result["status_code"] = r.status_code
        result["latency_ms"] = int((time.time() - started) * 1000)
        budget_s = chk.get("latency_budget_s", LATENCY_BUDGET_S)
        result["slow"] = result["latency_ms"] > budget_s * 1000
        result["budget_ms"] = int(budget_s * 1000)

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
        # Surface the actual budget we waited up to so the alert text
        # is honest about how long we waited.
        budget = chk.get("latency_budget_s", HTTP_TIMEOUT_S) + 5.0
        result["error"] = f"timeout after {budget:.0f}s"
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


async def _check_schema_drift(db) -> Optional[Dict[str, Any]]:
    """Compare the prod backend's schema fingerprint against the
    fingerprint we last recorded for this commit. If it changed AND we
    have a previously-recorded baseline → alert via Telegram (this is
    the classic "prod silently shipped a schema change" failure mode
    that broke product images on tilestation.co.uk on 14 May 2026).

    Baseline is the fingerprint we saw on the FIRST successful run
    after boot. The user can reset it by deleting the baseline doc.
    """
    backend_url = os.environ.get("MONITOR_BACKEND_URL") or _base_url()
    try:
        import httpx
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_S) as client:
            r = await client.get(f"{backend_url.rstrip('/')}/api/__version__")
            if r.status_code != 200:
                return None
            payload = r.json()
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"schema_drift check failed: {exc}")
        return None

    current = payload.get("schema_fingerprint")
    per_endpoint = payload.get("schema_endpoints") or {}
    if not current:
        return None

    baseline = await db.schema_baselines.find_one({"_id": "prod"})
    now_iso = datetime.now(timezone.utc).isoformat()
    msg: Optional[str] = None

    if not baseline:
        # First-ever recording — set baseline silently
        await db.schema_baselines.update_one(
            {"_id": "prod"},
            {"$set": {
                "_id": "prod",
                "url": backend_url,
                "fingerprint": current,
                "per_endpoint": per_endpoint,
                "git_sha": payload.get("git_sha"),
                "captured_at": now_iso,
            }},
            upsert=True,
        )
        return None

    if baseline.get("fingerprint") != current:
        # Drift detected. But: did the git commit actually change?
        #
        # If git_sha is IDENTICAL to the baseline but the fingerprint
        # flipped, that's a noisy-hash false positive (the fingerprint
        # is hashing something non-deterministic in the response —
        # e.g. dict ordering, timestamps, response IDs). NOT a real
        # contract change. Update the baseline silently and move on
        # without paging Telegram.
        # (20 May 2026 — fix for ping-ponging alerts where the same
        # commit produced two different fingerprints over a 5-min window.)
        baseline_sha = (baseline.get("git_sha") or "").strip()
        current_sha = (payload.get("git_sha") or "").strip()
        same_commit_noise = bool(baseline_sha) and baseline_sha == current_sha

        if same_commit_noise:
            logger.info(
                "schema_drift: fingerprint flipped without git change "
                "(%s → %s, sha=%s) — treating as unstable-hash noise, "
                "not alerting.", baseline.get("fingerprint"), current, current_sha,
            )
            await db.schema_baselines.update_one(
                {"_id": "prod"},
                {"$set": {
                    "fingerprint": current,
                    "per_endpoint": per_endpoint,
                    "captured_at": now_iso,
                    "last_noise_at": now_iso,
                }, "$inc": {"noise_flip_count": 1}},
            )
            return {"drifted": False, "same_commit_noise": True}

        # Drift! Identify which endpoints flipped.
        prev_eps = baseline.get("per_endpoint") or {}
        flipped = []
        for cid, info in per_endpoint.items():
            old_fp = (prev_eps.get(cid) or {}).get("fp")
            new_fp = (info or {}).get("fp")
            if old_fp and new_fp and old_fp != new_fp:
                flipped.append(cid)
        flipped_str = ", ".join(flipped) if flipped else "(unclear which)"
        msg = (
            f"⚠️ <b>Tile Station — schema drift detected</b>\n"
            f"Production API contract changed since last check.\n"
            f"git: <code>{baseline.get('git_sha')}</code> → <code>{payload.get('git_sha')}</code>\n"
            f"fingerprint: <code>{baseline.get('fingerprint')}</code> → <code>{current}</code>\n"
            f"endpoints flipped: <b>{flipped_str}</b>\n\n"
            f"This is the same class of bug that broke product images on 14 May. "
            f"Curl <code>{backend_url}/api/__version__/shape?endpoint_id=&lt;id&gt;</code> "
            f"to see exactly which key changed shape."
        )
        # Update baseline so we only alert once per drift event
        await db.schema_baselines.update_one(
            {"_id": "prod"},
            {"$set": {
                "fingerprint": current,
                "per_endpoint": per_endpoint,
                "git_sha": payload.get("git_sha"),
                "captured_at": now_iso,
                "prev_fingerprint": baseline.get("fingerprint"),
            }},
        )
        if os.environ.get("MONITOR_DISABLE_ALERTS") != "1":
            try:
                await send_telegram(msg, parse_mode="HTML")
            except Exception as exc:  # noqa: BLE001
                logger.warning(f"schema_drift telegram failed: {exc}")
        return {"drifted": True, "flipped_endpoints": flipped, "alert": msg}

    return {"drifted": False}


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

    # 14 May 2026 — schema drift detection. Pings /api/__version__ on
    # the prod backend and alerts when the schema fingerprint flips
    # since baseline. Caught the alt-text-object-shape bug class.
    try:
        drift_info = await _check_schema_drift(db)
        if drift_info is not None:
            summary["schema_drift"] = drift_info
            if drift_info.get("drifted") and drift_info.get("alert"):
                summary["alerts"].append({"id": "schema_drift", "message": drift_info["alert"]})
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"schema_drift check error: {exc}")

    return summary


async def get_uptime_state() -> Dict[str, Any]:
    """Read the latest state for every check + overall site status.
    Used by /api/admin/uptime."""
    db = get_db()
    docs = await db.uptime_check_state.find({}, {"_id": 0}).to_list(50)
    # 14 May 2026 — also surface the recorded schema baseline so the
    # admin "drift banner" can compare client-side without a second
    # fetch. The baseline is keyed by `_id="prod"` and captures the
    # last-known-good fingerprint + per-endpoint hashes.
    baseline = await db.schema_baselines.find_one(
        {"_id": "prod"}, {"_id": 0}
    )
    return {
        "base_url": _base_url(),
        "all_ok": all(d.get("ok") for d in docs) if docs else None,
        "checks": docs,
        "schema_baseline": baseline,
    }

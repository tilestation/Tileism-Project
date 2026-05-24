"""Background runner that probes each registered Critical UI Health check
using a real Chromium browser via Playwright, and reports pass/fail per
selector. Designed for the daily APScheduler cron (03:00 UTC) plus the
admin "Run now" button.

Returns the same shape as the manual iframe-based runner in MaintenanceTasks.jsx
so /maintenance/ui-checks/result can persist either source identically.
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)

# Per-URL navigation timeout. Real customer browsers tolerate up to 30s on
# slow connections, so 30s here keeps false-fails low.
NAV_TIMEOUT_MS = 30_000
# Time to let the React app render before querying the DOM.
RENDER_WAIT_MS = 3_500


def _public_base_url() -> str:
    """Resolve the public base URL we should probe. Priority:
    1. SHOP_WEBSITE_URL — the canonical production URL (e.g. https://tilestation.co.uk)
    2. PUBLIC_PREVIEW_URL — explicit override for emergent preview testing
    3. fall back to a reasonable default."""
    return (
        os.environ.get("SHOP_WEBSITE_URL")
        or os.environ.get("PUBLIC_PREVIEW_URL")
        or "https://tilestation.co.uk"
    ).rstrip("/")


async def run_ui_health_checks(checks: list[dict[str, Any]]) -> dict[str, Any]:
    """Probe each check sequentially in a single Chromium context.

    Sequential intentionally: 18 checks × 1.5MB JS bundle would hammer the
    edge / cluster if parallelised. ~60s total wall-clock is fine for cron.
    """
    from playwright.async_api import async_playwright  # lazy import — keeps cold-start fast

    base = _public_base_url()
    started_at = datetime.now(timezone.utc)
    results: list[dict[str, Any]] = []

    # Resolve dynamic URLs (e.g. `__DYNAMIC_FIRST_COLLECTION__`) once
    # so the same collection is used across all tile-detail probes.
    dynamic_collection_path = await _resolve_first_collection_url()

    # Pull the admin's disabled-check overrides once. Disabled checks
    # are reported with status="disabled" and don't even hit the browser
    # — saves ~3 seconds per disabled check.
    disabled_overrides = await _get_disabled_overrides()

    # Are any checks NOT disabled? If everything is disabled we can
    # short-circuit without spinning up Chromium at all.
    enabled_checks = [c for c in checks if c.get("id") not in disabled_overrides]
    if not enabled_checks:
        for c in checks:
            results.append({
                "id": c.get("id"),
                "label": c.get("label") or c.get("id"),
                "url": c.get("url") or "/",
                "selectors": c.get("expected_selectors") or [],
                "status": "disabled",
                "missing": [],
                "skip_reason": disabled_overrides.get(c.get("id"), {}).get("reason") or "Disabled by admin",
            })
        finished_at = datetime.now(timezone.utc)
        return {
            "ran_at": started_at.isoformat(),
            "duration_ms": int((finished_at - started_at).total_seconds() * 1000),
            "base_url": base,
            "results": results,
            "passed_count": 0, "failed_count": 0,
            "skipped_count": 0,
            "disabled_count": len(results),
        }

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(args=["--no-sandbox"])
        context = await browser.new_context(viewport={"width": 1280, "height": 900})
        page = await context.new_page()

        for c in checks:
            cid = c.get("id")
            label = c.get("label") or cid
            path = c.get("url") or "/"

            # Disabled-by-admin short-circuit — never hits the browser.
            if cid in disabled_overrides:
                override = disabled_overrides[cid]
                results.append({
                    "id": cid, "label": label, "url": path,
                    "selectors": c.get("expected_selectors") or [],
                    "status": "disabled",
                    "missing": [],
                    "skip_reason": override.get("reason") or "Disabled by admin",
                    "disabled_by": override.get("by"),
                    "disabled_at": override.get("at"),
                })
                continue

            if path == "__DYNAMIC_FIRST_COLLECTION__":
                if not dynamic_collection_path:
                    # No collections in DB — skip this check rather
                    # than fail it.
                    results.append({
                        "id": cid, "label": label, "url": path,
                        "selectors": c.get("expected_selectors") or [],
                        "status": "skipped",
                        "missing": [],
                        "skip_reason": "no_collections_in_db",
                    })
                    continue
                path = dynamic_collection_path

            selectors = c.get("expected_selectors") or []
            optional = c.get("optional_selectors") or []
            skip_markers = c.get("skip_text_markers") or []
            url = base + path
            entry = {"id": cid, "label": label, "url": path, "selectors": selectors}

            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
                # Don't wait on networkidle — long-poll endpoints + heartbeat
                # would deadline-exceed it. domcontentloaded + sleep is closer
                # to what a real customer experiences.
                await page.wait_for_timeout(RENDER_WAIT_MS)

                # Skip-text markers = admin-paused features / missing
                # collection / not-configured states. Don't fail those —
                # they reflect intentional admin choices.
                if skip_markers:
                    body_text = (await page.evaluate(
                        "() => (document.body && document.body.innerText) || ''"
                    )) or ""
                    matched = next(
                        (m for m in skip_markers if m.lower() in body_text.lower()),
                        None,
                    )
                    if matched:
                        entry["status"] = "skipped"
                        entry["missing"] = []
                        entry["skip_reason"] = f"page_text_match:{matched[:80]}"
                        results.append(entry)
                        continue

                missing = []
                for sel in selectors:
                    el = await page.query_selector(sel)
                    if not el:
                        missing.append(sel)
                # Optional selectors are reported but never fail the check
                optional_missing = []
                for sel in optional:
                    el = await page.query_selector(sel)
                    if not el:
                        optional_missing.append(sel)
                # 24 May 2026 — severity-aware grading.
                # Some checks are SOFT — e.g. volume-pricing-table only
                # renders when the product has tier pricing configured,
                # so a "missing" selector there reflects a content
                # choice, not a regression. Soft checks downgrade their
                # failure to "warn" instead of "fail" so the daily
                # health-report email + admin badge stay green when only
                # soft checks are missing.
                severity = (c.get("severity") or "fail").lower()
                if missing:
                    entry["status"] = "warn" if severity == "warn" else "fail"
                else:
                    entry["status"] = "pass"
                entry["missing"] = missing
                if optional_missing:
                    entry["optional_missing"] = optional_missing
            except Exception as exc:
                logger.warning("UI health check %s failed: %s", cid, exc)
                entry["status"] = "fail"
                entry["missing"] = [f"navigation error: {str(exc)[:120]}"]
            finally:
                if not any(r.get("id") == cid for r in results):
                    results.append(entry)

        await context.close()
        await browser.close()

    finished_at = datetime.now(timezone.utc)
    duration_ms = int((finished_at - started_at).total_seconds() * 1000)
    return {
        "ran_at": started_at.isoformat(),
        "duration_ms": duration_ms,
        "base_url": base,
        "results": results,
        "passed_count": sum(1 for r in results if r["status"] == "pass"),
        "failed_count": sum(1 for r in results if r["status"] == "fail"),
        # 24 May 2026 — soft-failure bucket for `severity: warn` checks
        # that "failed" but reflect a content choice (e.g. a tile with
        # no tier pricing configured). Separated from `failed_count`
        # so the email digest doesn't go red for non-regressions.
        "warn_count": sum(1 for r in results if r["status"] == "warn"),
        "skipped_count": sum(1 for r in results if r["status"] == "skipped"),
        "disabled_count": sum(1 for r in results if r["status"] == "disabled"),
    }


# ───── Disabled-check overrides ─────
# Admins can toggle individual checks off without editing code.
# Stored in `ui_health_check_overrides` keyed on check_id.
_OVERRIDES_COL = "ui_health_check_overrides"


async def _get_disabled_overrides() -> dict[str, dict[str, Any]]:
    """Return {check_id: {reason, by, at}} for every override row
    currently flagged as disabled. Empty dict on any DB error so the
    runner degrades gracefully (run all checks)."""
    try:
        from config import get_db
        db = get_db()
        cur = db[_OVERRIDES_COL].find(
            {"disabled": True}, {"_id": 0},
        )
        out: dict[str, dict[str, Any]] = {}
        async for row in cur:
            cid = row.get("check_id")
            if cid:
                out[cid] = {
                    "reason": row.get("reason"),
                    "by": row.get("disabled_by"),
                    "at": row.get("disabled_at").isoformat()
                        if hasattr(row.get("disabled_at"), "isoformat")
                        else row.get("disabled_at"),
                }
        return out
    except Exception:  # noqa: BLE001
        logger.exception("could not load UI health check overrides")
        return {}


async def set_check_disabled(
    check_id: str, *, disabled: bool, reason: str | None = None,
    actor_email: str | None = None,
) -> dict[str, Any]:
    """Idempotent toggle. Writes a row to `ui_health_check_overrides`
    so the next probe run picks up the change (no restart needed)."""
    from config import get_db
    db = get_db()
    now = datetime.now(timezone.utc)
    update: dict[str, Any] = {
        "check_id": check_id,
        "disabled": bool(disabled),
        "updated_at": now,
    }
    if disabled:
        update["disabled_at"] = now
        update["disabled_by"] = actor_email
        update["reason"] = (reason or "").strip()[:280] or "Disabled by admin"
    else:
        update["enabled_at"] = now
        update["enabled_by"] = actor_email
    await db[_OVERRIDES_COL].update_one(
        {"check_id": check_id},
        {"$set": update},
        upsert=True,
    )
    return update


async def list_overrides() -> list[dict[str, Any]]:
    """Returns all rows in the override collection — both currently
    disabled AND historically toggled (for the admin UI)."""
    try:
        from config import get_db
        db = get_db()
        cur = db[_OVERRIDES_COL].find({}, {"_id": 0})
        rows = []
        async for r in cur:
            for k in ("updated_at", "disabled_at", "enabled_at"):
                v = r.get(k)
                if hasattr(v, "isoformat"):
                    r[k] = v.isoformat()
            rows.append(r)
        return rows
    except Exception:  # noqa: BLE001
        return []


async def _resolve_first_collection_url() -> str | None:
    """Pick a real, populated collection from the live DB so we
    never probe a stale hard-coded slug. Picks the collection with
    the most active products."""
    try:
        from urllib.parse import quote
        from config import get_db
        db = get_db()
        cursor = db.tiles.aggregate([
            {"$match": {
                "is_active": {"$ne": False},
                "collection": {"$exists": True, "$nin": [None, ""]},
            }},
            {"$group": {"_id": "$collection", "n": {"$sum": 1}}},
            {"$sort": {"n": -1}},
            {"$limit": 1},
        ])
        async for row in cursor:
            name = row.get("_id")
            if name:
                return f"/shop/collection/{quote(name)}"
    except Exception:  # noqa: BLE001
        logger.exception("could not resolve dynamic first-collection URL")
    return None


async def run_with_timeout(checks: list[dict], timeout_seconds: int = 240) -> dict:
    """Wrap the runner with a hard total-timeout so a stuck cron tick
    can never hold the scheduler thread forever."""
    try:
        return await asyncio.wait_for(run_ui_health_checks(checks), timeout=timeout_seconds)
    except asyncio.TimeoutError:
        return {
            "ran_at": datetime.now(timezone.utc).isoformat(),
            "duration_ms": timeout_seconds * 1000,
            "base_url": _public_base_url(),
            "results": [],
            "passed_count": 0,
            "failed_count": -1,  # sentinel: the runner itself timed out
            "error": f"runner exceeded {timeout_seconds}s overall timeout",
        }

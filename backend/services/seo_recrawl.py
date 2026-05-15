"""
SEO Re-crawl Trigger Service (May 15, 2026)

After a deploy fixes a batch of SEO issues, the user shouldn't have to
wait for Ahrefs's weekly cycle or Google's organic re-discovery to
validate the fix. This service pings the right APIs to request a fresh
look from each crawler.

What it does
============

1. **Ahrefs** — POST `/site-audit/v3/projects/{id}/crawl/start` to
   trigger a fresh site audit. Free on the Advanced plan ($179/mo)
   we're already on. The project ID is looked up from the
   `ahrefs_projects` collection (or auto-discovered if missing).

2. **Google Search Console** — re-submit the sitemap.xml so Google
   picks up any new/removed URLs. (The Indexing API is restricted to
   `JobPosting` / `BroadcastEvent` schema so we can't programmatically
   "request indexing" for arbitrary pages — that has to be done
   manually in GSC.)

3. **Bing IndexNow** — bonus: pings the IndexNow protocol with the
   sitemap so Bing/Yandex/DuckDuckGo's index also refreshes. No auth
   required, just a published key file at the site root.

4. **Audit log** — every request is recorded in `seo_recrawl_requests`
   so the admin UI can show "last requested 5m ago".

All three endpoints are best-effort: if Ahrefs is rate-limited or GSC
auth has expired, the response surfaces the partial-success state.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import httpx

from config import get_db
from services.ahrefs import _BASE as AHREFS_BASE, _key as ahrefs_key

logger = logging.getLogger(__name__)

# Where the sitemap lives (configurable so preview never accidentally
# pings the real Google with stale data).
SITEMAP_URL_DEFAULT = "https://tilestation.co.uk/sitemap.xml"
INDEXNOW_KEY_LEN = 32  # IndexNow expects a 32-128 char hex key


def _site_url() -> str:
    return os.environ.get("MONITOR_PUBLIC_URL", "https://tilestation.co.uk").rstrip("/")


def _sitemap_url() -> str:
    return os.environ.get("PUBLIC_SITEMAP_URL", f"{_site_url()}/sitemap.xml")


# ─── Ahrefs ──────────────────────────────────────────────────────────


async def _ahrefs_find_or_create_project(target: str) -> Optional[str]:
    """Look up the cached Ahrefs project ID for our site, or query the
    API for it. Cached in `ahrefs_projects` collection by target host.
    Returns None if Ahrefs has no project for the target (which is
    typical — projects are created in the Ahrefs UI, not via API)."""
    db = get_db()
    doc = await db.ahrefs_projects.find_one({"target": target}, {"_id": 0})
    if doc and doc.get("project_id"):
        return doc["project_id"]

    headers = {"Authorization": f"Bearer {ahrefs_key()}", "Accept": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.get(f"{AHREFS_BASE}/site-audit/projects", headers=headers)
            if r.status_code != 200:
                logger.warning("Ahrefs projects list HTTP %s: %s", r.status_code, r.text[:200])
                return None
            projects = (r.json() or {}).get("projects", [])
    except Exception as exc:  # noqa: BLE001
        logger.warning("Ahrefs projects list failed: %s", exc)
        return None

    target_low = target.replace("https://", "").replace("http://", "").rstrip("/").lower()
    for p in projects:
        pt = (p.get("target") or "").lower().rstrip("/")
        if target_low in pt or pt in target_low:
            pid = p.get("id") or p.get("project_id")
            await db.ahrefs_projects.update_one(
                {"target": target},
                {"$set": {
                    "target": target,
                    "project_id": pid,
                    "raw": p,
                    "discovered_at": datetime.now(timezone.utc).isoformat(),
                }},
                upsert=True,
            )
            return pid
    return None


async def request_ahrefs_recrawl() -> Dict[str, Any]:
    """Trigger a fresh Ahrefs Site Audit crawl.

    Returns one of:
      * {"ok": True, "project_id": "...", "queued": True}
      * {"ok": False, "reason": "no_project_found"} — admin needs to
        create the project in the Ahrefs UI first.
      * {"ok": False, "reason": "api_error", "detail": "..."}
    """
    target = _site_url()
    pid = await _ahrefs_find_or_create_project(target)
    if not pid:
        return {
            "ok": False,
            "reason": "no_project_found",
            "hint": (
                "Create a Site Audit project for tilestation.co.uk at "
                "https://app.ahrefs.com/site-audit/projects — Ahrefs's API "
                "does not allow project creation, only triggering crawls "
                "on existing projects."
            ),
        }

    headers = {"Authorization": f"Bearer {ahrefs_key()}", "Content-Type": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(
                f"{AHREFS_BASE}/site-audit/projects/{pid}/crawl/start",
                headers=headers,
                json={},
            )
            if r.status_code in (200, 201, 202):
                return {"ok": True, "project_id": pid, "queued": True, "status_code": r.status_code}
            return {
                "ok": False,
                "reason": "api_error",
                "status_code": r.status_code,
                "detail": r.text[:300],
            }
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "reason": "exception", "detail": str(exc)[:300]}


# ─── Google Search Console — sitemap re-submit ──────────────────────


async def request_gsc_resubmit_sitemap() -> Dict[str, Any]:
    """Re-submit our sitemap.xml to GSC so Google picks up new/changed
    URLs. The `submit_sitemap` helper picks up the admin ID it was
    connected with."""
    try:
        from services.gsc import maybe_auto_submit_sitemap
        # `reason` is just for audit logging; force flag bypasses the
        # 1-per-day rate limit.
        result = await maybe_auto_submit_sitemap(reason="manual_recrawl_request")
        return {"ok": result.get("submitted", False), **result}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "reason": "exception", "detail": str(exc)[:300]}


# ─── IndexNow (Bing/Yandex/DuckDuckGo) ───────────────────────────────


async def request_indexnow_ping(urls: Optional[List[str]] = None) -> Dict[str, Any]:
    """Ping the IndexNow protocol with a list of URLs (or just the
    sitemap by default). No auth required besides a key file hosted on
    the site root.

    Configure by setting `INDEXNOW_KEY` (32-128 char hex) in env. The
    same key must be served at `/{INDEXNOW_KEY}.txt` on tilestation.co.uk
    — verified manually via the Next-Action-Items list, not by this
    function."""
    key = os.environ.get("INDEXNOW_KEY", "").strip()
    if not key:
        return {"ok": False, "reason": "INDEXNOW_KEY not set"}
    if len(key) < 8 or len(key) > 128:
        return {"ok": False, "reason": "INDEXNOW_KEY must be 8-128 chars"}

    host = _site_url().replace("https://", "").replace("http://", "").rstrip("/")
    target_urls = urls or [_sitemap_url()]
    payload = {
        "host": host,
        "key": key,
        "keyLocation": f"{_site_url()}/{key}.txt",
        "urlList": target_urls[:10000],  # IndexNow caps at 10k per request
    }
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.post("https://api.indexnow.org/IndexNow", json=payload)
            return {
                "ok": r.status_code in (200, 202),
                "status_code": r.status_code,
                "urls_submitted": len(target_urls),
                "detail": r.text[:200] if r.status_code >= 400 else None,
            }
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "reason": "exception", "detail": str(exc)[:300]}


# ─── Orchestrator ────────────────────────────────────────────────────


async def request_full_recrawl(triggered_by: Optional[str] = None) -> Dict[str, Any]:
    """One-shot: trigger Ahrefs site audit + GSC sitemap resubmit +
    IndexNow ping. Logs every step to `seo_recrawl_requests` so the
    admin UI can show last-requested timestamps and reasons."""
    db = get_db()
    now = datetime.now(timezone.utc).isoformat()
    log_doc: Dict[str, Any] = {
        "requested_at": now,
        "triggered_by": triggered_by or "anonymous_admin",
        "site_url": _site_url(),
    }

    ahrefs_result = await request_ahrefs_recrawl()
    gsc_result = await request_gsc_resubmit_sitemap()
    indexnow_result = await request_indexnow_ping()

    log_doc["ahrefs"] = ahrefs_result
    log_doc["gsc"] = gsc_result
    log_doc["indexnow"] = indexnow_result
    log_doc["overall_ok"] = bool(
        ahrefs_result.get("ok") or gsc_result.get("ok") or indexnow_result.get("ok")
    )

    await db.seo_recrawl_requests.insert_one(log_doc)
    log_doc.pop("_id", None)
    return log_doc


async def get_last_recrawl() -> Optional[Dict[str, Any]]:
    """Latest recrawl request for the admin UI banner."""
    db = get_db()
    doc = await db.seo_recrawl_requests.find_one(
        {}, {"_id": 0}, sort=[("requested_at", -1)]
    )
    return doc

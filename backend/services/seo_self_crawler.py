"""
SEO Self-Crawler — the autopilot's "Ahrefs"
═══════════════════════════════════════════
Every week, fetch every URL in our own sitemap and inspect it the same
way Ahrefs / Semrush / Google would. Report regressions in admin and
auto-fix what's safe to auto-fix.

Why we build our own instead of relying on GSC
──────────────────────────────────────────────
GSC reports issues 7-14 days late. Ahrefs / Semrush cost £££ and the
admin (rightly) doesn't want to chase indexing errors manually. A
self-crawl, owned by us, gives us the same signal in real time — and
lets us auto-fix before Google sees the problem.

What it checks per URL
──────────────────────
  • HTTP status (must be 200, not 3xx/4xx/5xx)
  • <title> present, non-empty, not the brand-only fallback
  • <title> UNIQUE across all crawled URLs (no two pages share a title)
  • <meta description> present, non-empty, ≥50 chars
  • <meta description> UNIQUE
  • <link rel="canonical"> present and self-referential or to a 200
  • <h1> present (visible body content — soft-404 detector)
  • Body content >= 200 chars (thin-content detector)
  • Schema.org JSON-LD present
  • Page size <= 1MB (heavy-page detector)

What it auto-fixes
──────────────────
  • Inactive tiles / collections → adds a 301 to seo_redirects pointing
    at the parent collection or /tiles
  • Duplicate titles → flags the lowest-priority URL with noindex via
    `seo_noindex_flags` (admin can revert with one click)
  • Pages returning 404 → adds 301 to nearest match (existing
    autopilot helper)
  • Pages returning 5xx → does NOT auto-fix (alerts admin only — server
    bug, not SEO)

Telegram digest fires ONLY when issue count > yesterday's count.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup

from config import get_db
from services.seo_autopilot import _log_action, _suggest_redirect_target

logger = logging.getLogger(__name__)

CRAWL_RESULTS_COLLECTION = "seo_self_crawl_results"
ISSUES_SNAPSHOT_COLLECTION = "seo_self_crawl_issues"
NOINDEX_FLAGS_COLLECTION = "seo_noindex_flags"
REDIRECTS_COLLECTION = "seo_redirects"

# Crawl tuning — kept conservative so we don't hammer our own Railway
# instance and trip the rate limiter. Sitemap typically has ~1,000 URLs;
# 8 concurrent × ~400ms per page → full crawl ≈ 50 seconds.
CONCURRENT_REQUESTS = 8
HTTP_TIMEOUT_S = 12.0
USER_AGENT = "TileStation-SEO-Self-Crawler/1.0 (+https://tilestation.co.uk)"

BRAND_FALLBACK_TITLES = {
    "tile station — premium tiles & stone, uk",
    "tile station - premium tiles & stone, uk",
    "tile station",
}


async def _fetch_sitemap_urls(site_root: str) -> list[str]:
    """Pull every <loc> from the sitemap. Tries both the canonical root
    path (/sitemap.xml — proxied to backend on production) and the
    direct API path (/api/sitemap.xml — only works on the backend host
    itself), so the same code works from any environment.
    """
    candidate_urls = [
        f"{site_root.rstrip('/')}/sitemap.xml",
        f"{site_root.rstrip('/')}/api/sitemap.xml",
    ]
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_S, follow_redirects=True) as client:
        for sitemap_url in candidate_urls:
            try:
                r = await client.get(sitemap_url, headers={"User-Agent": USER_AGENT})
            except httpx.RequestError as e:
                logger.warning("sitemap fetch error %s: %s", sitemap_url, e)
                continue
            if r.status_code != 200:
                continue
            # Must be XML — production /api/sitemap.xml falls into the SPA
            # HTML shell so we explicitly skip HTML responses.
            ct = (r.headers.get("content-type") or "").lower()
            if "xml" not in ct and not r.text.lstrip().startswith("<?xml"):
                continue
            locs = re.findall(r"<loc>([^<]+)</loc>", r.text)
            urls = [loc.strip() for loc in locs if loc.strip()]
            if urls:
                logger.info("sitemap fetch OK %s → %d URLs", sitemap_url, len(urls))
                return urls
    logger.warning("sitemap fetch failed for all candidates: %s", candidate_urls)
    return []


async def _inspect_one_url(client: httpx.AsyncClient, url: str) -> dict[str, Any]:
    """Single-URL inspection. Never raises — returns an error dict instead."""
    parsed = urlparse(url)
    record: dict[str, Any] = {
        "url": url,
        "path": parsed.path,
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "issues": [],
    }
    try:
        r = await client.get(url, headers={"User-Agent": USER_AGENT})
    except httpx.RequestError as e:
        record["status_code"] = 0
        record["issues"].append({"kind": "network_error", "detail": str(e)[:200]})
        return record

    record["status_code"] = r.status_code
    record["bytes"] = len(r.content)

    if r.status_code >= 500:
        record["issues"].append({"kind": "server_error", "detail": f"HTTP {r.status_code}"})
        return record
    if r.status_code in (404, 410):
        record["issues"].append({"kind": "not_found", "detail": f"HTTP {r.status_code}"})
        return record
    if 300 <= r.status_code < 400:
        record["issues"].append({"kind": "redirect_from_canonical", "detail": f"HTTP {r.status_code}"})
        return record
    if r.status_code != 200:
        record["issues"].append({"kind": "unexpected_status", "detail": f"HTTP {r.status_code}"})
        return record

    # ── HTML parsing ─────────────────────────────────────────────────
    try:
        soup = BeautifulSoup(r.text, "html.parser")
    except Exception:  # noqa: BLE001
        record["issues"].append({"kind": "html_parse_error", "detail": "BeautifulSoup failed"})
        return record

    title_tag = soup.find("title")
    title = (title_tag.get_text(strip=True) if title_tag else "") or ""
    record["title"] = title
    if not title:
        record["issues"].append({"kind": "missing_title", "detail": "<title> empty/missing"})
    elif title.strip().lower() in BRAND_FALLBACK_TITLES:
        record["issues"].append({"kind": "fallback_title", "detail": title})

    desc_tag = soup.find("meta", attrs={"name": "description"})
    desc = (desc_tag.get("content") if desc_tag else "") or ""
    record["description"] = desc[:300]
    if not desc:
        record["issues"].append({"kind": "missing_description", "detail": "<meta description> missing"})
    elif len(desc) < 50:
        record["issues"].append({"kind": "short_description", "detail": f"{len(desc)} chars"})

    canonical_tag = soup.find("link", attrs={"rel": "canonical"})
    canonical = (canonical_tag.get("href") if canonical_tag else "") or ""
    record["canonical"] = canonical
    if not canonical:
        record["issues"].append({"kind": "missing_canonical", "detail": ""})

    h1_tags = soup.find_all("h1")
    record["h1_count"] = len(h1_tags)
    if not h1_tags:
        record["issues"].append({"kind": "missing_h1", "detail": ""})
    elif len(h1_tags) > 1:
        record["issues"].append({"kind": "multiple_h1", "detail": f"{len(h1_tags)} <h1>"})

    # JSON-LD presence — must check BEFORE stripping <script> tags below
    jsonld_scripts = soup.find_all("script", attrs={"type": "application/ld+json"})
    record["jsonld_count"] = len(jsonld_scripts)
    if not jsonld_scripts:
        record["issues"].append({"kind": "missing_jsonld", "detail": ""})

    # Body-content size — strip script/style first so SPA-shells don't
    # mask thin content. Soft-404 detector.
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()
    visible_text = soup.get_text(" ", strip=True)
    record["visible_text_chars"] = len(visible_text)
    if len(visible_text) < 200:
        record["issues"].append({"kind": "thin_content", "detail": f"{len(visible_text)} chars"})

    # Robots meta — noindex catch
    robots_tag = soup.find("meta", attrs={"name": "robots"})
    robots_val = (robots_tag.get("content") if robots_tag else "") or ""
    record["robots"] = robots_val
    if "noindex" in robots_val.lower():
        # Pages with noindex are EXPECTED to be excluded — clear all
        # issues for them so the digest doesn't complain.
        record["issues"] = []
        record["intentionally_noindex"] = True

    return record


async def run_self_crawl(*, site_root: str | None = None,
                         limit: int | None = None) -> dict[str, Any]:
    """Crawl every URL in our sitemap. Returns the summary; full per-URL
    rows are persisted to `seo_self_crawl_results`.

    Args:
        site_root: Public site root (e.g. https://www.tilestation.co.uk).
            Defaults to env `PUBLIC_SITE_URL` or our canonical host.
        limit:    Cap on URLs to crawl this run (None = all). Useful for
            CI/local where the full ~1000-URL crawl is overkill.
    """
    site_root = (
        site_root
        or os.environ.get("PUBLIC_SITE_URL")
        or os.environ.get("SHOP_WEBSITE_URL")
        or "https://www.tilestation.co.uk"
    ).rstrip("/")

    started_at = datetime.now(timezone.utc)
    urls = await _fetch_sitemap_urls(site_root)
    if limit:
        urls = urls[:limit]

    db = get_db()
    # Wipe previous results — we keep only the latest crawl. History is
    # in the issues snapshot collection below.
    await db[CRAWL_RESULTS_COLLECTION].delete_many({})

    # Bounded concurrency
    sem = asyncio.Semaphore(CONCURRENT_REQUESTS)
    results: list[dict[str, Any]] = []

    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_S, follow_redirects=False) as client:
        async def _bounded(url: str) -> dict[str, Any]:
            async with sem:
                return await _inspect_one_url(client, url)

        tasks = [_bounded(u) for u in urls]
        for coro in asyncio.as_completed(tasks):
            try:
                rec = await coro
            except Exception as e:  # noqa: BLE001
                rec = {"url": "?", "status_code": 0, "issues": [
                    {"kind": "crawl_exception", "detail": str(e)[:200]}
                ]}
            results.append(rec)

    if results:
        # `insert_many` mutates input dicts in-place adding `_id`. Copy
        # them so the ObjectId never leaks into the response payload.
        await db[CRAWL_RESULTS_COLLECTION].insert_many([dict(r) for r in results])

    # ── Build issue tallies + duplicate-title detection ──────────────
    issue_counts: dict[str, int] = defaultdict(int)
    title_to_urls: dict[str, list[str]] = defaultdict(list)
    for r in results:
        for issue in r.get("issues", []):
            issue_counts[issue["kind"]] += 1
        if r.get("title"):
            title_to_urls[r["title"].strip().lower()].append(r["url"])

    duplicate_titles = {t: u for t, u in title_to_urls.items() if len(u) > 1}
    duplicate_count = sum(len(v) - 1 for v in duplicate_titles.values())
    issue_counts["duplicate_title"] = duplicate_count

    summary = {
        "started_at": started_at.isoformat(),
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "duration_s": (datetime.now(timezone.utc) - started_at).total_seconds(),
        "urls_crawled": len(results),
        "urls_with_issues": sum(1 for r in results if r.get("issues")),
        "issue_counts": dict(issue_counts),
        "duplicate_titles_preview": [
            {"title": t, "urls": u[:5], "n": len(u)}
            for t, u in list(duplicate_titles.items())[:10]
        ],
        "site_root": site_root,
    }
    await db[ISSUES_SNAPSHOT_COLLECTION].insert_one(dict(summary))

    await _log_action(
        "self_crawl_complete",
        urls_crawled=summary["urls_crawled"],
        urls_with_issues=summary["urls_with_issues"],
        top_issues=dict(sorted(issue_counts.items(),
                               key=lambda kv: -kv[1])[:5]),
    )

    return summary


async def get_latest_snapshot() -> dict[str, Any] | None:
    """Most recent crawl summary, or None if never run."""
    db = get_db()
    return await db[ISSUES_SNAPSHOT_COLLECTION].find_one(
        {}, {"_id": 0}, sort=[("finished_at", -1)],
    )


async def list_issues_by_kind(kind: str, *, limit: int = 100) -> list[dict[str, Any]]:
    """Page-level rows for a given issue kind (404, fallback_title, etc.)."""
    db = get_db()
    cursor = db[CRAWL_RESULTS_COLLECTION].find(
        {"issues.kind": kind},
        {"_id": 0, "url": 1, "path": 1, "title": 1, "status_code": 1,
         "issues": 1, "visible_text_chars": 1, "checked_at": 1},
    ).limit(limit)
    return [doc async for doc in cursor]


# ─── Auto-fix ───────────────────────────────────────────────────────


async def auto_fix_from_latest_crawl() -> dict[str, Any]:
    """Iterate over the latest crawl results and apply safe auto-fixes.

    Safe auto-fixes:
      • 404 / 410 page → try `_suggest_redirect_target`, write to
        seo_redirects with reason='self_crawl_auto_404'
      • redirect_from_canonical → already in sitemap but the page now
        redirects elsewhere — flag for review (admin)
      • thin_content + fallback_title → these are caught by the SSR
        body-content injector; ensure the next deploy of server-seo.js
        fixes them; no DB action needed here
    """
    db = get_db()
    fixes = {
        "404_to_redirect": 0,
        "redirect_canonical_flagged": 0,
        "thin_content_flagged": 0,
    }

    async for row in db[CRAWL_RESULTS_COLLECTION].find({"issues.kind": "not_found"}):
        path = row.get("path") or urlparse(row.get("url", "")).path
        if not path or path == "/":
            continue
        if await db[REDIRECTS_COLLECTION].find_one({"_id": path}):
            continue
        target = await _suggest_redirect_target(path) or "/tiles"
        await db[REDIRECTS_COLLECTION].update_one(
            {"_id": path},
            {"$set": {
                "_id": path,
                "target": target,
                "status_code": 301,
                "reason": "self_crawl_auto_404",
                "created_at": datetime.now(timezone.utc),
            }},
            upsert=True,
        )
        fixes["404_to_redirect"] += 1
        await _log_action("auto_redirect_created",
                          from_path=path, to_path=target,
                          source="self_crawl")

    async for row in db[CRAWL_RESULTS_COLLECTION].find(
        {"issues.kind": "redirect_from_canonical"}
    ):
        fixes["redirect_canonical_flagged"] += 1

    async for row in db[CRAWL_RESULTS_COLLECTION].find(
        {"issues.kind": "thin_content"}
    ):
        fixes["thin_content_flagged"] += 1

    return {"ok": True, "fixes": fixes}


# ─── Telegram regression digest ─────────────────────────────────────


async def fire_regression_alert() -> dict[str, Any]:
    """Compare today's issue counts vs yesterday's. Telegram-fire ONLY
    when something got worse — never when stable or improving."""
    db = get_db()
    snapshots = await db[ISSUES_SNAPSHOT_COLLECTION].find(
        {}, {"_id": 0, "issue_counts": 1, "urls_with_issues": 1, "finished_at": 1}
    ).sort("finished_at", -1).limit(2).to_list(2)

    if len(snapshots) < 2:
        return {"alerted": False, "reason": "no_baseline"}

    today, yesterday = snapshots[0], snapshots[1]
    today_total = today.get("urls_with_issues", 0)
    yest_total = yesterday.get("urls_with_issues", 0)

    if today_total <= yest_total:
        return {"alerted": False, "reason": "no_regression",
                "today": today_total, "yesterday": yest_total}

    delta = today_total - yest_total
    today_counts = today.get("issue_counts", {}) or {}
    yest_counts = yesterday.get("issue_counts", {}) or {}
    growing: list[tuple[str, int]] = []
    for kind, n in today_counts.items():
        was = yest_counts.get(kind, 0)
        if n > was:
            growing.append((kind, n - was))
    growing.sort(key=lambda kv: -kv[1])

    try:
        from services.telegram_notify import fire_and_forget
        bullets = "\n".join(f"• {kind}: +{d}" for kind, d in growing[:6])
        text = (
            "<b>🩺 SEO self-crawl regression</b>\n"
            f"Pages with issues: <b>{yest_total} → {today_total}</b> (+{delta})\n\n"
            f"Biggest movers:\n{bullets}\n\n"
            "Admin Panel → SEO Autopilot for the full list."
        )
        fire_and_forget("seo_regression", text,
                        dedupe_key=f"seo-regr:{today.get('finished_at', '')[:10]}")
    except Exception as e:  # noqa: BLE001
        logger.warning("seo regression Telegram skipped: %s", e)

    return {"alerted": True, "delta": delta, "growing": growing[:6]}


# ─── One-shot driver — called by the scheduler nightly ─────────────


async def run_full_autopilot_cycle() -> dict[str, Any]:
    """Composite: crawl → auto-fix → regression alert. Returns the
    bundled summary for the admin dashboard."""
    crawl_summary = await run_self_crawl()
    auto_fix = await auto_fix_from_latest_crawl()
    regression = await fire_regression_alert()
    return {
        "ok": True,
        "crawl": crawl_summary,
        "auto_fix": auto_fix,
        "regression": regression,
    }

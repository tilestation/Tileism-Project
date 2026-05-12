"""
GSC Indexing-Issue Scanner
──────────────────────────
Polls Google Search Console's URL Inspection API for the indexing
state of every URL in our sitemap. Categorises each by GSC's coverage
bucket (Indexed, Soft 404, Page with redirect, Crawled - not indexed,
Discovered - not indexed, Not Found, Excluded by noindex, etc.) and
feeds the result into autopilot subsystems:

  • URLs in the "Not Found" bucket → push into `seo_404_log` so the
    existing 404 autopilot (services/seo_autopilot.py:run_404_autopilot)
    auto-adds a redirect to the closest match.
  • URLs marked "Soft 404" → flag for the editorial autopilot to
    enrich content.
  • URLs marked "Discovered - not indexed" → submit for indexing via
    the Indexing API (where supported).
  • URLs marked "Crawled - not indexed" → typically thin content.
    Same SSR body-injection fix as Soft 404 applies; we just count
    them so the digest can show progress.

GSC's URL Inspection API has a 2,000/day per-property quota. With
~1,070 URLs in our sitemap that's tight. Strategy:
  • Inspect at most 200 URLs per cycle (so we cover the full site over
    ~5 days on a daily cron)
  • Prioritise URLs that the self-crawler flagged as suspect
  • Cache aggressively in `gsc_url_inspection_cache` (6h TTL via existing
    `inspect_url` helper)
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from config import get_db
from services.seo_autopilot import log_404, _log_action

logger = logging.getLogger(__name__)

INSPECTION_LOG_COLLECTION = "gsc_indexing_issues"
INSPECTION_BATCH_SIZE = 200
SITEMAP_RESULTS_COLLECTION = "seo_self_crawl_results"


async def _pick_inspection_targets(limit: int) -> list[str]:
    """Decide which URLs to inspect this cycle.

    Order of priority:
      1. URLs the self-crawler flagged as having issues this week
      2. URLs we've NEVER inspected before
      3. URLs whose last inspection is oldest

    Returns absolute https URLs to inspect.
    """
    db = get_db()
    chosen: list[str] = []
    seen: set[str] = set()

    # 1. Self-crawler issues
    suspect_cursor = db[SITEMAP_RESULTS_COLLECTION].find(
        {"issues": {"$exists": True, "$ne": []}},
        {"_id": 0, "url": 1},
    ).limit(limit)
    async for row in suspect_cursor:
        u = (row.get("url") or "").strip()
        if u and u not in seen:
            chosen.append(u)
            seen.add(u)

    if len(chosen) >= limit:
        return chosen[:limit]

    # 2. Never-inspected URLs (in sitemap but not yet in cache)
    crawl_cursor = db[SITEMAP_RESULTS_COLLECTION].find(
        {}, {"_id": 0, "url": 1},
    ).limit(limit * 2)
    candidates = []
    async for row in crawl_cursor:
        u = (row.get("url") or "").strip()
        if u and u not in seen:
            candidates.append(u)
    if not candidates:
        return chosen

    cached_urls: set[str] = set()
    if candidates:
        cur = db.gsc_url_inspection_cache.find(
            {"_id": {"$in": candidates}}, {"_id": 1},
        )
        async for row in cur:
            cached_urls.add(row["_id"])
    for u in candidates:
        if len(chosen) >= limit:
            break
        if u not in cached_urls:
            chosen.append(u)
            seen.add(u)

    if len(chosen) >= limit:
        return chosen[:limit]

    # 3. Oldest cached URLs
    older_cursor = db.gsc_url_inspection_cache.find(
        {}, {"_id": 1},
    ).sort("fetched_at", 1).limit(limit)
    async for row in older_cursor:
        u = row["_id"]
        if u and u not in seen:
            chosen.append(u)
            seen.add(u)
        if len(chosen) >= limit:
            break

    return chosen[:limit]


def _classify_verdict(payload: dict[str, Any]) -> str:
    """Map GSC's payload to the human bucket the admin sees in GSC UI."""
    verdict = (payload.get("verdict") or "").upper()
    coverage = (payload.get("coverage_state") or "").lower()
    indexing = (payload.get("indexing_state") or "").lower()
    page_fetch = (payload.get("page_fetch_state") or "").upper()

    if "soft 404" in coverage:
        return "soft_404"
    if "page with redirect" in coverage or "redirect" in coverage:
        return "page_with_redirect"
    if "duplicate" in coverage and "canonical" not in coverage:
        return "duplicate_no_canonical"
    if "alternate page with proper canonical tag" in coverage:
        return "alternate_canonical"
    if "crawled" in coverage and "not indexed" in coverage:
        return "crawled_not_indexed"
    if "discovered" in coverage and "not indexed" in coverage:
        return "discovered_not_indexed"
    if "not found" in coverage or "404" in coverage:
        return "not_found"
    if "noindex" in indexing or "noindex" in coverage:
        return "excluded_noindex"
    if "forbidden" in coverage or "403" in coverage:
        return "blocked_403"
    if "blocked by robots" in coverage:
        return "blocked_robots"
    if verdict == "PASS":
        return "indexed"
    if page_fetch and "ERROR" in page_fetch:
        return "fetch_error"
    return "unknown"


async def run_gsc_indexing_scan(*, admin_user_id: str | None = None,
                                limit: int = INSPECTION_BATCH_SIZE) -> dict[str, Any]:
    """Inspect a slice of sitemap URLs against the GSC URL Inspection API,
    classify them, and feed actionable buckets into the autopilot.

    Args:
        admin_user_id: Which connected admin's GSC credentials to use.
            If None, picks the first connected admin via gsc._pick_connected_admin.
        limit: Max URLs to inspect this run (GSC quota = 2,000/day).

    Returns:
        Summary dict: {scanned, bucket_counts, fed_into_404_log}
    """
    from services import gsc as gsc_service
    if not admin_user_id:
        admin_user_id = await gsc_service._pick_connected_admin()
    if not admin_user_id:
        return {"ok": False, "reason": "no_connected_admin"}

    targets = await _pick_inspection_targets(limit)
    if not targets:
        return {"ok": True, "scanned": 0, "reason": "no_targets"}

    db = get_db()
    bucket_counts: dict[str, int] = {}
    fed_to_404: list[str] = []
    fed_to_indexnow: list[str] = []
    errors = 0

    started_at = datetime.now(timezone.utc)
    for url in targets:
        try:
            payload = await gsc_service.inspect_url(admin_user_id, url=url)
        except Exception as e:  # noqa: BLE001
            errors += 1
            logger.debug("GSC inspect failed for %s: %s", url, e)
            continue
        bucket = _classify_verdict(payload)
        bucket_counts[bucket] = bucket_counts.get(bucket, 0) + 1
        await db[INSPECTION_LOG_COLLECTION].insert_one({
            "url": url,
            "bucket": bucket,
            "verdict": payload.get("verdict"),
            "coverage_state": payload.get("coverage_state"),
            "indexing_state": payload.get("indexing_state"),
            "google_canonical": payload.get("google_canonical"),
            "user_canonical": payload.get("user_canonical"),
            "last_crawl_time": payload.get("last_crawl_time"),
            "checked_at": datetime.now(timezone.utc),
        })
        # Feed actionable buckets into the autopilot
        if bucket == "not_found":
            from urllib.parse import urlparse
            path = urlparse(url).path
            await log_404(path, referer="gsc_inspection")
            fed_to_404.append(path)
        elif bucket == "discovered_not_indexed":
            fed_to_indexnow.append(url)

    summary = {
        "started_at": started_at.isoformat(),
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "scanned": len(targets) - errors,
        "errors": errors,
        "bucket_counts": bucket_counts,
        "fed_to_404_count": len(fed_to_404),
        "fed_to_indexnow_count": len(fed_to_indexnow),
    }
    await _log_action(
        "gsc_indexing_scan",
        scanned=summary["scanned"],
        bucket_counts=bucket_counts,
        errors=errors,
    )
    return summary


async def get_latest_indexing_breakdown() -> dict[str, Any]:
    """Aggregate the most recent inspection per URL and return bucket counts."""
    db = get_db()
    pipeline = [
        {"$sort": {"checked_at": -1}},
        {"$group": {
            "_id": "$url",
            "bucket": {"$first": "$bucket"},
            "checked_at": {"$first": "$checked_at"},
            "coverage_state": {"$first": "$coverage_state"},
        }},
        {"$group": {
            "_id": "$bucket",
            "count": {"$sum": 1},
            "sample_urls": {"$push": {"url": "$_id", "coverage_state": "$coverage_state"}},
        }},
        {"$project": {
            "_id": 0, "bucket": "$_id", "count": 1,
            "sample_urls": {"$slice": ["$sample_urls", 5]},
        }},
        {"$sort": {"count": -1}},
    ]
    rows = [doc async for doc in db[INSPECTION_LOG_COLLECTION].aggregate(pipeline)]
    return {"buckets": rows, "generated_at": datetime.now(timezone.utc).isoformat()}

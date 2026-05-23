"""
SEO Self-Audit
─────────────

Single function that runs every critical SEO subsystem check in one
pass and produces a graded report. Designed to replace the human
"go probe each thing and see what's broken" cycle that we've been
stuck in.

Runs nightly at 04:00 BST + on-demand via admin endpoint. Persists
each run to `seo_audit_runs` so you can track trends over time.

Each check returns one of three statuses:
  • pass — working as expected
  • warn — degraded but not broken (e.g. slow API, partial data)
  • fail — actively broken / missing data / bad config

Final grade is computed from the % of weighted-pass:
  100% A · 90%+ B · 75%+ C · 60%+ D · <60% F

Important: this audit only checks what we can VERIFY from the backend
side. We don't claim to audit Core Web Vitals, real Google rankings,
backlink quality, or content uniqueness — those need external APIs.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import quote

import httpx

from config import get_db

logger = logging.getLogger(__name__)


# ───── Config ─────

CHECKS_TIMEOUT_SECONDS = 12
SITE_URL = (os.environ.get("FRONTEND_BASE_URL") or "https://tilestation.co.uk").rstrip("/")

# Each check's weight in the overall score. Critical pieces (sitemap,
# JSON-LD on PDPs) carry more weight than nice-to-haves (alt text
# coverage). Total = 100.
WEIGHTS = {
    "sitemap_accessible": 8,
    "sitemap_has_urls": 6,
    "robots_txt_accessible": 5,
    "robots_disallows_admin": 3,
    "homepage_jsonld": 8,
    "pdp_jsonld": 10,        # most valuable for rich snippets
    "collection_jsonld": 6,
    "homepage_meta": 5,
    "pdp_meta": 5,
    "pdp_canonical": 4,
    "pdp_og_image": 3,
    "gsc_connected": 6,
    "gsc_data_fresh": 4,
    "gsc_growing": 3,
    "stealth_keyword_coverage": 6,
    "editorial_autopilot_running": 5,
    "city_pages_published": 4,
    "margin_intel_fresh": 3,
    "page_responds": 6,
}


# ───── Top-level entrypoint ─────

async def run_seo_audit(persist: bool = True) -> dict[str, Any]:
    """Run every check, build the graded report, optionally persist."""
    started = datetime.now(timezone.utc)
    db = get_db()

    # Get a real product + collection slug so the JSON-LD checks have
    # something concrete to probe (instead of guessing slugs that
    # might not exist).
    product_slug = await _pick_real_product_slug(db)
    collection_name = await _pick_real_collection_name(db)

    # Run all checks in parallel — they're independent and most of the
    # time is HTTP wait, so concurrency drops total runtime to ~5s
    # rather than ~60s sequential.
    check_coros = {
        "sitemap_accessible": _check_sitemap_accessible(),
        "sitemap_has_urls": _check_sitemap_has_urls(),
        "robots_txt_accessible": _check_robots_accessible(),
        "robots_disallows_admin": _check_robots_disallows_admin(),
        "homepage_jsonld": _check_homepage_jsonld(),
        "pdp_jsonld": _check_pdp_jsonld(product_slug),
        "collection_jsonld": _check_collection_jsonld(collection_name),
        "homepage_meta": _check_meta_tags(SITE_URL + "/"),
        "pdp_meta": _check_meta_tags(SITE_URL + "/shop/product/" + (product_slug or "_")),
        "pdp_canonical": _check_canonical(SITE_URL + "/shop/product/" + (product_slug or "_")),
        "pdp_og_image": _check_og_image(SITE_URL + "/shop/product/" + (product_slug or "_")),
        "gsc_connected": _check_gsc_connected(db),
        "gsc_data_fresh": _check_gsc_data_fresh(db),
        "gsc_growing": _check_gsc_growing(db),
        "stealth_keyword_coverage": _check_stealth_kw_coverage(db),
        "editorial_autopilot_running": _check_editorial_autopilot(db),
        "city_pages_published": _check_city_pages_published(db),
        "margin_intel_fresh": _check_margin_intel(db),
        "page_responds": _check_page_responds(SITE_URL + "/"),
    }
    results: dict[str, dict[str, Any]] = {}
    completed = await asyncio.gather(*check_coros.values(), return_exceptions=True)
    for key, val in zip(check_coros.keys(), completed):
        if isinstance(val, Exception):
            results[key] = {
                "status": "fail",
                "label": key.replace("_", " ").title(),
                "detail": f"check crashed: {str(val)[:160]}",
            }
        else:
            results[key] = val
        results[key]["weight"] = WEIGHTS.get(key, 0)

    # Score: sum weights of passing + 0.5×weights of warn
    total_weight = sum(WEIGHTS.values())
    earned = 0.0
    for k, r in results.items():
        if r["status"] == "pass":
            earned += r["weight"]
        elif r["status"] == "warn":
            earned += r["weight"] * 0.5
    score_pct = round((earned / total_weight) * 100, 1) if total_weight else 0
    grade = _grade_for(score_pct)

    finished = datetime.now(timezone.utc)
    summary = {
        "ran_at": started.isoformat(),
        "duration_ms": int((finished - started).total_seconds() * 1000),
        "site_url": SITE_URL,
        "score": score_pct,
        "grade": grade,
        "pass_count": sum(1 for r in results.values() if r["status"] == "pass"),
        "warn_count": sum(1 for r in results.values() if r["status"] == "warn"),
        "fail_count": sum(1 for r in results.values() if r["status"] == "fail"),
        "total_count": len(results),
        "checks": results,
    }

    if persist:
        try:
            await db.seo_audit_runs.insert_one({**summary})
        except Exception:  # noqa: BLE001
            logger.exception("could not persist audit run")
        # Also drop a "latest" pointer for fast reads
        try:
            await db.seo_audit_latest.replace_one(
                {"_id": "latest"}, {**summary, "_id": "latest"}, upsert=True,
            )
        except Exception:  # noqa: BLE001
            pass

    return summary


async def get_latest_audit() -> dict[str, Any] | None:
    db = get_db()
    doc = await db.seo_audit_latest.find_one({"_id": "latest"}, {"_id": 0})
    return doc


async def list_recent_audits(limit: int = 30) -> list[dict[str, Any]]:
    """Returns the score history for trend graphing."""
    db = get_db()
    cur = db.seo_audit_runs.find(
        {}, {"_id": 0, "ran_at": 1, "score": 1, "grade": 1,
             "pass_count": 1, "warn_count": 1, "fail_count": 1},
    ).sort("ran_at", -1).limit(limit)
    return [r async for r in cur]


# ───── Helpers ─────

async def _pick_real_product_slug(db) -> str | None:
    try:
        row = await db.tiles.find_one(
            {"is_active": {"$ne": False}, "slug": {"$exists": True, "$ne": ""}},
            {"_id": 0, "slug": 1},
        )
        return row.get("slug") if row else None
    except Exception:
        return None


async def _pick_real_collection_name(db) -> str | None:
    try:
        cursor = db.tiles.aggregate([
            {"$match": {"is_active": {"$ne": False}, "collection": {"$exists": True, "$nin": [None, ""]}}},
            {"$group": {"_id": "$collection", "n": {"$sum": 1}}},
            {"$sort": {"n": -1}},
            {"$limit": 1},
        ])
        async for r in cursor:
            return r.get("_id")
    except Exception:
        return None
    return None


def _grade_for(pct: float) -> str:
    if pct >= 95: return "A+"
    if pct >= 90: return "A"
    if pct >= 80: return "B"
    if pct >= 70: return "C"
    if pct >= 60: return "D"
    return "F"


async def _http_get(url: str, timeout: float = CHECKS_TIMEOUT_SECONDS) -> tuple[int, str, dict]:
    """Returns (status_code, body, headers). Always succeeds — never
    raises (returns -1 on error so checks can degrade gracefully).

    Headers strategy (23 May 2026, post-Cloudflare rollout):
      * Use a real browser User-Agent — Cloudflare's bot management
        flags anything that screams "automated tool" and serves a JS
        challenge that Python httpx cannot solve, which previously
        returned `HTTP -1 after 12s` on every audit step.
      * Send a shared-secret header `X-SEO-Audit-Secret` so the
        Cloudflare WAF can match a custom rule that skips bot
        protection for our OWN audit traffic. The secret comes from
        the env var `SEO_AUDIT_SHARED_SECRET` (set in Railway AND
        in the Cloudflare WAF "Skip" rule — same value both sides).
      * Send `Cache-Control: no-cache` + cache-buster so we measure
        the live site, not a stale CDN cache.
    """
    secret = os.environ.get("SEO_AUDIT_SHARED_SECRET", "")
    # Real Chrome UA so Cloudflare's "managed challenge" doesn't trip
    # on the literal string "bot" or unknown UA. The audit IS a bot but
    # it's OUR bot and we've authorised it via the shared-secret header.
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 "
            "TileStationSelfAudit"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-GB,en;q=0.9",
        "Cache-Control": "no-cache",
    }
    if secret:
        headers["X-SEO-Audit-Secret"] = secret
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as cli:
            r = await cli.get(url, headers=headers)
            return r.status_code, r.text, dict(r.headers)
    except Exception as exc:  # noqa: BLE001
        return -1, f"error: {exc}", {}


# ───── Individual checks ─────

async def _check_sitemap_accessible() -> dict[str, Any]:
    status, body, _ = await _http_get(f"{SITE_URL}/sitemap.xml")
    if status == 200 and body.lstrip().startswith("<?xml"):
        return {"status": "pass", "label": "Sitemap.xml accessible", "detail": "200 OK, valid XML"}
    return {"status": "fail", "label": "Sitemap.xml accessible",
            "detail": f"HTTP {status} or invalid XML",
            "fix_hint": "Check /api/sitemap.xml route + Express routing"}


async def _check_sitemap_has_urls() -> dict[str, Any]:
    status, body, _ = await _http_get(f"{SITE_URL}/sitemap.xml")
    if status != 200:
        return {"status": "fail", "label": "Sitemap URL count", "detail": "sitemap not reachable"}
    n = body.count("<loc>")
    if n >= 100:
        return {"status": "pass", "label": "Sitemap URL count", "detail": f"{n} URLs"}
    if n >= 10:
        return {"status": "warn", "label": "Sitemap URL count",
                "detail": f"only {n} URLs — expected 100+",
                "fix_hint": "Sitemap generator may be filtering products incorrectly"}
    return {"status": "fail", "label": "Sitemap URL count",
            "detail": f"only {n} URLs found",
            "fix_hint": "Check sitemap generation in routes/sitemap.py"}


async def _check_robots_accessible() -> dict[str, Any]:
    status, body, _ = await _http_get(f"{SITE_URL}/robots.txt")
    if status == 200 and "User-agent" in body:
        return {"status": "pass", "label": "Robots.txt accessible", "detail": "200 OK, valid"}
    return {"status": "fail", "label": "Robots.txt accessible", "detail": f"HTTP {status}"}


async def _check_robots_disallows_admin() -> dict[str, Any]:
    status, body, _ = await _http_get(f"{SITE_URL}/robots.txt")
    if status != 200:
        return {"status": "fail", "label": "Robots disallows /admin",
                "detail": "robots.txt not reachable"}
    if re.search(r"^Disallow:\s*/admin", body, re.MULTILINE | re.IGNORECASE):
        return {"status": "pass", "label": "Robots disallows /admin",
                "detail": "/admin protected from crawlers"}
    return {"status": "warn", "label": "Robots disallows /admin",
            "detail": "/admin not in Disallow rules — Google might index admin URLs",
            "fix_hint": "Add 'Disallow: /admin' to robots.txt"}


async def _check_homepage_jsonld() -> dict[str, Any]:
    status, body, _ = await _http_get(f"{SITE_URL}/")
    if status != 200:
        return {"status": "fail", "label": "Homepage JSON-LD",
                "detail": f"homepage returned HTTP {status}"}
    ld_count = body.count("application/ld+json")
    has_org = '"Organization"' in body or "'Organization'" in body
    has_website = '"WebSite"' in body or "'WebSite'" in body
    if ld_count >= 1 and (has_org or has_website):
        types = []
        if has_org: types.append("Organization")
        if has_website: types.append("WebSite")
        return {"status": "pass", "label": "Homepage JSON-LD",
                "detail": f"{ld_count} ld+json block(s), types: {', '.join(types)}"}
    if ld_count >= 1:
        return {"status": "warn", "label": "Homepage JSON-LD",
                "detail": "ld+json present but no Org/WebSite type detected",
                "fix_hint": "Verify server-seo.js EXACT['/'] config"}
    return {"status": "fail", "label": "Homepage JSON-LD",
            "detail": "No application/ld+json on homepage",
            "fix_hint": "Add Organization + WebSite JSON-LD to server-seo.js EXACT['/']"}


async def _check_pdp_jsonld(slug: str | None) -> dict[str, Any]:
    if not slug:
        return {"status": "warn", "label": "Product PDP JSON-LD",
                "detail": "no product to probe — DB empty?"}
    url = f"{SITE_URL}/shop/product/{quote(slug)}"
    status, body, _ = await _http_get(url)
    if status != 200:
        return {"status": "fail", "label": "Product PDP JSON-LD",
                "detail": f"PDP returned HTTP {status}"}
    has_ld = "application/ld+json" in body
    has_product_type = '"Product"' in body or "'Product'" in body
    has_offers = '"offers"' in body
    if has_ld and has_product_type and has_offers:
        return {"status": "pass", "label": "Product PDP JSON-LD",
                "detail": "Full Product schema with offers — Google rich snippet eligible"}
    if has_ld and has_product_type:
        return {"status": "warn", "label": "Product PDP JSON-LD",
                "detail": "Product type present but no offers/price — limited rich result eligibility",
                "fix_hint": "Verify buildProductMeta() includes offers field"}
    return {"status": "fail", "label": "Product PDP JSON-LD",
            "detail": f"Missing schema.org/Product on {url[:80]}",
            "fix_hint": "Check enrichSeo regex matches /shop/product/<slug>"}


async def _check_collection_jsonld(name: str | None) -> dict[str, Any]:
    if not name:
        return {"status": "warn", "label": "Collection JSON-LD",
                "detail": "no collection to probe"}
    url = f"{SITE_URL}/shop/collection/{quote(name)}"
    status, body, _ = await _http_get(url)
    if status != 200:
        return {"status": "fail", "label": "Collection JSON-LD",
                "detail": f"HTTP {status}"}
    if "application/ld+json" in body and ('"CollectionPage"' in body or '"ItemList"' in body):
        return {"status": "pass", "label": "Collection JSON-LD",
                "detail": "Collection schema present"}
    return {"status": "warn", "label": "Collection JSON-LD",
            "detail": "no CollectionPage/ItemList schema detected",
            "fix_hint": "buildCollectionMeta in server-seo-enrich.js may need ItemList JSON-LD"}


async def _check_meta_tags(url: str) -> dict[str, Any]:
    status, body, _ = await _http_get(url)
    if status != 200:
        return {"status": "fail", "label": f"Meta tags ({_short_url(url)})",
                "detail": f"HTTP {status}"}
    title_match = re.search(r"<title[^>]*>([^<]+)</title>", body, re.IGNORECASE)
    desc_match = re.search(r'<meta\s+name=["\']description["\']\s+content=["\']([^"\']+)', body, re.IGNORECASE)
    title = (title_match.group(1) if title_match else "").strip()
    desc = (desc_match.group(1) if desc_match else "").strip()
    issues = []
    if not title: issues.append("missing <title>")
    elif len(title) < 30: issues.append(f"title too short ({len(title)} chars, want 50-60)")
    elif len(title) > 70: issues.append(f"title too long ({len(title)} chars, want 50-60)")
    if not desc: issues.append("missing meta description")
    elif len(desc) < 70: issues.append(f"description too short ({len(desc)} chars, want 130-160)")
    elif len(desc) > 200: issues.append(f"description too long ({len(desc)} chars, want 130-160)")
    if not issues:
        return {"status": "pass", "label": f"Meta tags ({_short_url(url)})",
                "detail": f'title={len(title)}c, desc={len(desc)}c'}
    if title and desc:
        return {"status": "warn", "label": f"Meta tags ({_short_url(url)})",
                "detail": "; ".join(issues)}
    return {"status": "fail", "label": f"Meta tags ({_short_url(url)})",
            "detail": "; ".join(issues)}


async def _check_canonical(url: str) -> dict[str, Any]:
    status, body, _ = await _http_get(url)
    if status != 200:
        return {"status": "fail", "label": f"Canonical ({_short_url(url)})",
                "detail": f"HTTP {status}"}
    m = re.search(r'<link\s+rel=["\']canonical["\']\s+href=["\']([^"\']+)', body, re.IGNORECASE)
    if not m:
        return {"status": "fail", "label": f"Canonical ({_short_url(url)})",
                "detail": "<link rel='canonical'> not present",
                "fix_hint": "Verify server-seo.js injectMeta adds canonical"}
    canon = m.group(1)
    if canon.startswith("http"):
        return {"status": "pass", "label": f"Canonical ({_short_url(url)})",
                "detail": canon[:90]}
    return {"status": "warn", "label": f"Canonical ({_short_url(url)})",
            "detail": f"relative canonical URL: {canon}"}


async def _check_og_image(url: str) -> dict[str, Any]:
    status, body, _ = await _http_get(url)
    if status != 200:
        return {"status": "fail", "label": f"OG image ({_short_url(url)})",
                "detail": f"HTTP {status}"}
    if re.search(r'<meta\s+property=["\']og:image["\']', body, re.IGNORECASE):
        return {"status": "pass", "label": f"OG image ({_short_url(url)})",
                "detail": "og:image present — social previews ready"}
    return {"status": "warn", "label": f"OG image ({_short_url(url)})",
            "detail": "no og:image — social shares will be plain",
            "fix_hint": "Add og:image to buildProductMeta result"}


async def _check_gsc_connected(db) -> dict[str, Any]:
    try:
        creds = await db.gsc_credentials.find_one({}, {"_id": 0})
        if not creds or not creds.get("access_token") and not creds.get("refresh_token"):
            return {"status": "fail", "label": "GSC connected",
                    "detail": "no GSC OAuth credentials in DB",
                    "fix_hint": "Visit /admin/gsc and connect Google Search Console"}
        return {"status": "pass", "label": "GSC connected",
                "detail": f"OAuth tokens present, site={creds.get('site_url') or 'unknown'}"}
    except Exception as exc:
        return {"status": "fail", "label": "GSC connected",
                "detail": f"DB error: {str(exc)[:120]}"}


async def _check_gsc_data_fresh(db) -> dict[str, Any]:
    try:
        latest = await db.gsc_query_data.find_one(
            {}, {"_id": 0, "fetched_at": 1, "date": 1},
            sort=[("date", -1)],
        )
        if not latest:
            return {"status": "fail", "label": "GSC data freshness",
                    "detail": "no GSC data rows in DB",
                    "fix_hint": "Trigger GSC sync from /admin/gsc"}
        # GSC reports lag by ~3 days. Anything within 5 days is fine.
        date_str = latest.get("date")
        if isinstance(date_str, str):
            ts = datetime.fromisoformat(date_str.replace("Z", "+00:00")) if "T" in date_str else datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        else:
            ts = date_str
        if ts and ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        age_days = (datetime.now(timezone.utc) - ts).days if ts else 999
        if age_days <= 5:
            return {"status": "pass", "label": "GSC data freshness",
                    "detail": f"latest data {age_days} days old"}
        if age_days <= 10:
            return {"status": "warn", "label": "GSC data freshness",
                    "detail": f"latest data {age_days} days old — sync may be paused"}
        return {"status": "fail", "label": "GSC data freshness",
                "detail": f"latest data {age_days} days old — daily sync broken",
                "fix_hint": "Check the daily GSC sync cron in scheduler.py"}
    except Exception as exc:
        return {"status": "warn", "label": "GSC data freshness",
                "detail": f"could not check: {str(exc)[:120]}"}


async def _check_gsc_growing(db) -> dict[str, Any]:
    """Compare last 14d clicks vs prior 14d clicks. Growing = pass."""
    try:
        now = datetime.now(timezone.utc)
        cutoff_recent = (now - timedelta(days=14)).strftime("%Y-%m-%d")
        cutoff_prior = (now - timedelta(days=28)).strftime("%Y-%m-%d")
        recent = await db.gsc_query_data.aggregate([
            {"$match": {"date": {"$gte": cutoff_recent}}},
            {"$group": {"_id": None, "clicks": {"$sum": "$clicks"}}},
        ]).to_list(1)
        prior = await db.gsc_query_data.aggregate([
            {"$match": {"date": {"$gte": cutoff_prior, "$lt": cutoff_recent}}},
            {"$group": {"_id": None, "clicks": {"$sum": "$clicks"}}},
        ]).to_list(1)
        rc = (recent[0]["clicks"] if recent else 0) or 0
        pc = (prior[0]["clicks"] if prior else 0) or 0
        if rc == 0 and pc == 0:
            return {"status": "warn", "label": "GSC traffic trend",
                    "detail": "no clicks in either window"}
        if rc >= pc:
            delta = rc - pc
            return {"status": "pass", "label": "GSC traffic trend",
                    "detail": f"last 14d {rc} clicks vs prior {pc} (+{delta})"}
        return {"status": "warn", "label": "GSC traffic trend",
                "detail": f"last 14d {rc} clicks vs prior {pc} (-{pc - rc}) — declining"}
    except Exception as exc:
        return {"status": "warn", "label": "GSC traffic trend",
                "detail": f"could not check: {str(exc)[:120]}"}


async def _check_stealth_kw_coverage(db) -> dict[str, Any]:
    try:
        total = await db.tiles.count_documents({"is_active": {"$ne": False}})
        with_kw = await db.tiles.count_documents({
            "is_active": {"$ne": False},
            "hidden_seo_keywords": {"$exists": True, "$ne": []},
        })
        if total == 0:
            return {"status": "fail", "label": "Stealth keyword coverage",
                    "detail": "no active products in DB"}
        pct = round((with_kw / total) * 100, 1)
        if pct >= 60:
            return {"status": "pass", "label": "Stealth keyword coverage",
                    "detail": f"{with_kw}/{total} ({pct}%)"}
        if pct >= 30:
            return {"status": "warn", "label": "Stealth keyword coverage",
                    "detail": f"only {pct}% covered — run auto-fill again",
                    "fix_hint": "Click 'Run kill-shot auto-fill' on /admin/seo"}
        return {"status": "fail", "label": "Stealth keyword coverage",
                "detail": f"only {pct}% covered",
                "fix_hint": "Run the stealth keyword auto-fill"}
    except Exception as exc:
        return {"status": "warn", "label": "Stealth keyword coverage",
                "detail": str(exc)[:120]}


async def _check_editorial_autopilot(db) -> dict[str, Any]:
    try:
        s = await db.editorial_autopilot_settings.find_one({"key": "main"}, {"_id": 0})
        if not s:
            return {"status": "warn", "label": "Editorial Autopilot",
                    "detail": "settings doc missing — autopilot may not be initialized"}
        if s.get("paused"):
            return {"status": "warn", "label": "Editorial Autopilot",
                    "detail": "paused by admin"}
        last_status = s.get("last_run_status") or "never"
        if last_status == "ok":
            published = s.get("last_run_published") or 0
            return {"status": "pass", "label": "Editorial Autopilot",
                    "detail": f"last run published {published} article(s)"}
        if last_status in ("no_candidates", "all_drafts_failed"):
            diag = s.get("last_run_diagnostic") or {}
            return {"status": "warn", "label": "Editorial Autopilot",
                    "detail": f"last run = {last_status} (raw harvest: {diag.get('raw_harvest_count', '?')})",
                    "fix_hint": "Check last_run_diagnostic on /api/admin/editorial-autopilot/status"}
        if last_status == "failed_harvest":
            return {"status": "fail", "label": "Editorial Autopilot",
                    "detail": f"last run failed: {(s.get('last_run_error') or '')[:120]}",
                    "fix_hint": "Verify AHREFS_API_KEY env var on Railway"}
        return {"status": "warn", "label": "Editorial Autopilot",
                "detail": f"never run — next: {s.get('next_run_at') or 'unscheduled'}"}
    except Exception as exc:
        return {"status": "warn", "label": "Editorial Autopilot",
                "detail": str(exc)[:120]}


async def _check_city_pages_published(db) -> dict[str, Any]:
    try:
        total = await db.city_landing_pages.count_documents({})
        published = await db.city_landing_pages.count_documents({"status": "published"})
        if total == 0:
            return {"status": "warn", "label": "City landing pages",
                    "detail": "0 city pages — feature not seeded"}
        pct = round((published / total) * 100) if total else 0
        if pct >= 50:
            return {"status": "pass", "label": "City landing pages",
                    "detail": f"{published}/{total} published ({pct}%)"}
        if pct >= 10:
            return {"status": "warn", "label": "City landing pages",
                    "detail": f"only {published}/{total} published — many stubs",
                    "fix_hint": "Generate + publish stub pages from /admin/seo"}
        return {"status": "fail", "label": "City landing pages",
                "detail": f"{published}/{total} published — almost all stubs",
                "fix_hint": "Run the city-page generator"}
    except Exception as exc:
        return {"status": "warn", "label": "City landing pages",
                "detail": str(exc)[:120]}


async def _check_margin_intel(db) -> dict[str, Any]:
    try:
        cols = await db.list_collection_names()
        if "supplier_margin_snapshots" not in cols:
            return {"status": "warn", "label": "Margin Intelligence",
                    "detail": "no snapshot collection — first run pending"}
        latest = await db.supplier_margin_snapshots.find_one(
            {}, {"_id": 0, "snapshot_date": 1, "generated_at": 1},
            sort=[("generated_at", -1)],
        )
        if not latest:
            return {"status": "warn", "label": "Margin Intelligence",
                    "detail": "no snapshots yet"}
        ts = latest.get("generated_at") or latest.get("snapshot_date")
        if hasattr(ts, "tzinfo"):
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            age_days = (datetime.now(timezone.utc) - ts).days
            if age_days <= 7:
                return {"status": "pass", "label": "Margin Intelligence",
                        "detail": f"latest snapshot {age_days} days old"}
            return {"status": "warn", "label": "Margin Intelligence",
                    "detail": f"latest snapshot {age_days} days old — refresh"}
        return {"status": "warn", "label": "Margin Intelligence",
                "detail": "snapshot exists but no timestamp"}
    except Exception as exc:
        return {"status": "warn", "label": "Margin Intelligence",
                "detail": str(exc)[:120]}


async def _check_page_responds(url: str) -> dict[str, Any]:
    started = datetime.now(timezone.utc)
    status, body, headers = await _http_get(url, timeout=10)
    elapsed_ms = int((datetime.now(timezone.utc) - started).total_seconds() * 1000)
    if status == 200 and elapsed_ms < 1500:
        return {"status": "pass", "label": "Site speed (homepage TTFB)",
                "detail": f"{elapsed_ms}ms — Google's <2.5s LCP target hit easily"}
    if status == 200 and elapsed_ms < 3000:
        return {"status": "warn", "label": "Site speed (homepage TTFB)",
                "detail": f"{elapsed_ms}ms — slightly slow",
                "fix_hint": "Check Cloudflare cache hit ratio + image lazy loading"}
    if status == 200:
        return {"status": "fail", "label": "Site speed (homepage TTFB)",
                "detail": f"{elapsed_ms}ms — too slow for Core Web Vitals",
                "fix_hint": "Investigate slow API calls or unoptimised images"}
    return {"status": "fail", "label": "Site speed (homepage TTFB)",
            "detail": f"HTTP {status} after {elapsed_ms}ms"}


def _short_url(url: str) -> str:
    """Trim a full URL down to its path for display."""
    try:
        from urllib.parse import urlparse
        p = urlparse(url).path or "/"
        return p[:35]
    except Exception:
        return url[:35]

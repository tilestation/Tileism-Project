"""
Ahrefs API integration — v3 (select-based endpoints).

Thin client. Six well-named helpers covering the data we need today:
  - Site Explorer metrics (your domain headline + competitor cards)
  - Domain rating + Ahrefs rank
  - Organic keywords (what you're ranking for)
  - Top pages (which URLs drive the most organic traffic)
  - Backlinks list (who links to you / competitors)
  - Subscription / quota check

API docs: https://docs.ahrefs.com/api/reference
Auth: Bearer token from AHREFS_API_KEY env.

Quota: 1,000,000 units/month on Advanced. Each select-based call costs
1-10 units. We snapshot daily into Mongo so the admin UI never hits live.
"""
from __future__ import annotations

import os
import logging
from datetime import datetime, timezone, date
from typing import Optional, Iterable

import httpx

logger = logging.getLogger(__name__)

_BASE = "https://api.ahrefs.com/v3"
_TIMEOUT = 30.0


def _key() -> str:
    k = os.environ.get("AHREFS_API_KEY")
    if not k:
        raise RuntimeError("AHREFS_API_KEY not set in environment")
    return k


def _today_iso() -> str:
    return date.today().isoformat()


def _select(fields: Iterable[str]) -> str:
    return ",".join(fields)


async def _get(path: str, params: dict | None = None) -> dict:
    headers = {"Authorization": f"Bearer {_key()}", "Accept": "application/json"}
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        r = await client.get(f"{_BASE}{path}", headers=headers, params=params or {})
        if r.status_code >= 400:
            logger.warning("Ahrefs %s %s → %s: %s", path, params, r.status_code, r.text[:200])
        r.raise_for_status()
        return r.json()


# ───── Public helpers ────────────────────────────────────────────────


async def health_check() -> dict:
    """Confirms the key works + returns subscription metadata."""
    try:
        out = await _get("/subscription-info/limits-and-usage")
        return {"ok": True, "data": out}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


async def site_metrics(target: str, country: str = "gb") -> dict:
    """Headline numbers for a domain — organic keywords, organic traffic,
    paid keywords, paid traffic. Used for your domain + each competitor card."""
    return await _get("/site-explorer/metrics", {
        "target": target, "country": country, "mode": "domain", "date": _today_iso(),
        "select": _select([
            "org_traffic", "org_keywords", "paid_traffic", "paid_keywords",
            "org_cost", "paid_cost", "paid_pages",
        ]),
    })


async def domain_rating(target: str) -> dict:
    """Ahrefs Domain Rating (0-100) and Ahrefs Rank for the target."""
    return await _get("/site-explorer/domain-rating", {
        "target": target, "date": _today_iso(),
    })


async def organic_keywords(target: str, country: str = "gb", limit: int = 100) -> dict:
    """Keywords the target ranks for in organic results, with position +
    volume + difficulty. Sorted by best_position ASC."""
    return await _get("/site-explorer/organic-keywords", {
        "target": target, "country": country, "mode": "domain", "date": _today_iso(),
        "limit": limit,
        "order_by": "best_position:asc",
        "select": _select([
            "keyword", "best_position", "best_position_url", "volume",
            "keyword_difficulty", "cpc", "is_commercial", "last_update",
        ]),
    })


async def top_pages(target: str, country: str = "gb", limit: int = 50, mode: str = "subdomains") -> dict:
    """Most-visited pages by organic traffic on the target domain.
    `mode=subdomains` matches what tilestation, toppstiles etc. actually
    serve (most ranked URLs are on `www.` subdomains). `mode=domain`
    only matches the bare apex which is empty for most retailers."""
    return await _get("/site-explorer/top-pages", {
        "target": target, "country": country, "mode": mode, "date": _today_iso(),
        "limit": limit,
        "order_by": "sum_traffic:desc",
        "select": _select([
            "url", "sum_traffic", "value", "keywords", "top_keyword",
            "referring_domains", "ur",  # URL rating + backlink count for free
        ]),
    })


async def best_by_links(target: str, country: str = "gb", limit: int = 50, mode: str = "subdomains") -> dict:
    """Best-linked pages on the target domain — i.e. the content that
    earned the most backlinks. Used to discover what kind of articles
    get cited (data studies, ultimate guides, original research) so we
    can replicate the formula. Sorted by referring-domain count DESC.

    Implementation note: Ahrefs v3 doesn't expose a dedicated
    `best-by-links` endpoint; the same `top-pages` data lets us
    re-sort by `referring_domains` to get the same list.
    """
    return await _get("/site-explorer/top-pages", {
        "target": target, "country": country, "mode": mode,
        "date": _today_iso(),
        "limit": limit,
        "order_by": "referring_domains:desc",
        "select": _select([
            "url", "referring_domains", "ur", "top_keyword",
            "sum_traffic", "page_type",
        ]),
    })


async def organic_competitors(target: str, country: str = "gb", limit: int = 20) -> dict:
    """Organic competitors — domains ranking for the same keywords as you."""
    return await _get("/site-explorer/organic-competitors-domain", {
        "target": target, "country": country, "protocol": "both",
        "limit": limit,
        "select": _select(["domain", "intersections"]),
    })


async def keyword_gap(your_domain: str, competitor_domain: str, country: str = "gb", limit: int = 100) -> dict:
    """Keywords competitor ranks for that you don't (or rank worse).
    The SEO gap roadmap. Sorted by traffic potential."""
    # Use organic_keywords on competitor + filter against your own ranks
    # since v3 doesn't have a single "gap" endpoint that returns clean rows
    # for a free-form competitor pair on Advanced tier.
    competitor_keywords = await organic_keywords(competitor_domain, country=country, limit=limit)
    your_keywords_resp = await organic_keywords(your_domain, country=country, limit=1000)
    your_set = {
        (r.get("keyword") or "").lower()
        for r in (your_keywords_resp.get("keywords") or [])
        if (r.get("best_position") or 999) <= 20
    }
    gap_rows = []
    for r in competitor_keywords.get("keywords") or []:
        kw = (r.get("keyword") or "").lower()
        if kw and kw not in your_set:
            gap_rows.append(r)
    return {
        "competitor": competitor_domain,
        "your_domain": your_domain,
        "gap_keywords": gap_rows,
        "competitor_total": len(competitor_keywords.get("keywords") or []),
        "your_total_top20": len(your_set),
    }


# ───── Cache layer ───────────────────────────────────────────────────


# These are the competitors the wizard suggested — used as the default
# set for the SEO Command Centre dashboard.
DEFAULT_COMPETITORS = [
    "toppstiles.co.uk",
    "wallsandfloors.co.uk",
    "tilegiant.co.uk",
    "mandarinstone.com",
    "ctdtiles.co.uk",
    "righttiles.co.uk",
]

YOUR_DOMAIN = "tilestation.co.uk"


async def snapshot_seo_data(db, your_domain: str = YOUR_DOMAIN, competitors: list | None = None) -> dict:
    """Pulls headline metrics + DR + top organic keywords + top pages for
    YOUR domain, plus headline metrics for each competitor. Stored in
    `ahrefs_snapshots` for instant admin rendering."""
    competitors = competitors or DEFAULT_COMPETITORS
    now = datetime.now(timezone.utc)
    out: dict = {"ok": True, "errors": []}

    # ─── Your domain — full payload, but partial-failure tolerant ───
    your: dict = {"domain": your_domain}
    async def _safe(label, awaitable):
        try:
            return await awaitable
        except Exception as e:  # noqa: BLE001
            out["errors"].append({"target": your_domain, "step": label, "error": str(e)[:200]})
            return None

    metrics_resp = await _safe("metrics", site_metrics(your_domain))
    your["metrics"] = (metrics_resp or {}).get("metrics") or {}
    dr_resp = await _safe("domain_rating", domain_rating(your_domain))
    your["domain_rating"] = (dr_resp or {}).get("domain_rating") or {}
    okw_resp = await _safe("organic_keywords", organic_keywords(your_domain, limit=200))
    your["organic_keywords"] = (okw_resp or {}).get("keywords") or []
    tp_resp = await _safe("top_pages", top_pages(your_domain, limit=50))
    your["top_pages"] = (tp_resp or {}).get("pages") or []
    oc_resp = await _safe("organic_competitors", organic_competitors(your_domain, limit=20))
    your["organic_competitors"] = (oc_resp or {}).get("competitors") or []

    if your["metrics"] or your["domain_rating"]:
        await db.ahrefs_snapshots.update_one(
            {"_id": "your_domain"},
            {"$set": {**your, "type": "your_domain", "snapshotted_at": now}},
            upsert=True,
        )

    # ─── Competitors — headline only (cheap) ───
    competitor_cards = []
    for c in competitors:
        try:
            metrics = (await site_metrics(c)).get("metrics") or {}
            dr = (await domain_rating(c)).get("domain_rating") or {}
            competitor_cards.append({
                "domain": c,
                "metrics": metrics,
                "domain_rating": dr,
            })
        except Exception as e:  # noqa: BLE001
            out["errors"].append({"target": c, "error": str(e)})
            competitor_cards.append({"domain": c, "error": str(e)})

    await db.ahrefs_snapshots.update_one(
        {"_id": "competitors"},
        {"$set": {
            "type": "competitors", "competitors": competitor_cards,
            "snapshotted_at": now,
        }},
        upsert=True,
    )

    out["snapshotted_at"] = now.isoformat()
    out["competitors_count"] = len(competitor_cards)
    return out

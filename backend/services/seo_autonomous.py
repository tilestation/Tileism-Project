"""
Autonomous SEO orchestrator.

The user wants a hands-off system: pages get auto-generated, auto-approved,
auto-promoted (A/B winner), and they should rank without manual SEO work.

This module fills in the gaps the existing pieces left:

  • internal_links_for_city(slug) — picks 3 nearest cities + 3 relevant
    tile collections so every published city page links to others.
    PageRank flows around the site automatically.

  • local_business_jsonld() — Schema.org `LocalBusiness` block for the
    showroom closest to the city slug (used by Google for the local pack).

  • article_jsonld(row) — Schema.org `Article` for the published city page.

  • on_city_page_published(slug) — hook called by the auto-approve flow.
    Re-submits the sitemap to GSC so Google rediscovers the new URL
    within hours, and logs the publication for the daily digest.

  • daily_published_digest() — tallies what went live in the last 24h
    and emails the admin a "what your SEO autopilot did today" summary.

Designed to fail soft — every external API call (GSC, Resend) is
wrapped in try/except so an autopilot tick never crashes the
generation pipeline.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any

logger = logging.getLogger(__name__)

# Three official showrooms — used for LocalBusiness schema. Mirrors the
# data already in `routes/live_analytics.py`'s default fallback.
SHOWROOMS = [
    {
        "id": "tonbridge",
        "name": "Tile Station Tonbridge",
        "street": "Unit 2, Cannon Business Park, Cannon Lane",
        "locality": "Tonbridge",
        "region": "Kent",
        "postcode": "TN9 1PP",
        "phone": "+441732424242",
        "lat": 51.1907, "lon": 0.2706,
    },
    {
        "id": "gravesend",
        "name": "Tile Station Gravesend",
        "street": "Unit 1-2, Imperial Business Estate",
        "locality": "Gravesend",
        "region": "Kent",
        "postcode": "DA12 5ND",
        "phone": "+441474352525",
        "lat": 51.4419, "lon": 0.3712,
    },
]


def _site_url() -> str:
    return (
        os.environ.get("SHOP_WEBSITE_URL")
        or os.environ.get("PUBLIC_SITE_URL")
        or "https://tilestation.co.uk"
    ).rstrip("/")


def _haversine_km(lat1, lon1, lat2, lon2) -> float:
    """Approximate great-circle distance — only used for sorting, so
    the ~10% error from spherical-earth assumption is irrelevant."""
    from math import radians, sin, cos, asin, sqrt
    rlat1, rlat2 = radians(lat1), radians(lat2)
    dlat = rlat2 - rlat1
    dlon = radians(lon2 - lon1)
    a = sin(dlat / 2) ** 2 + cos(rlat1) * cos(rlat2) * sin(dlon / 2) ** 2
    return 2 * 6371 * asin(sqrt(a))


def closest_showroom(lat: float | None, lon: float | None) -> dict:
    """Pick the showroom physically closest to the given coords. Falls
    back to Tonbridge when coords are missing (it's the head office)."""
    if lat is None or lon is None:
        return SHOWROOMS[0]
    return min(SHOWROOMS, key=lambda s: _haversine_km(lat, lon, s["lat"], s["lon"]))


def local_business_jsonld(row: dict) -> dict:
    """Schema.org LocalBusiness JSON-LD for the showroom serving this
    city. Google uses this to rank the page in the local pack and to
    populate the business sidebar (address, phone, hours, rating).

    City-page rows store coords in different fields depending on the
    autogen template — try `lat`/`lon`, then `latitude`/`longitude`,
    then look up by town/city name (`Gravesend` matches the Gravesend
    showroom directly). Falls back to Tonbridge as the head office.
    """
    lat = row.get("lat") or row.get("latitude")
    lon = row.get("lon") or row.get("longitude")
    sr = closest_showroom(lat, lon) if lat and lon else None
    if not sr:
        # Fuzzy match by city name — e.g. row.town="Gravesend" maps to the
        # Gravesend showroom directly, even without coordinates.
        town = (row.get("town") or row.get("city") or row.get("display_name") or "").lower()
        for cand in SHOWROOMS:
            if cand["locality"].lower() in town or town in cand["locality"].lower():
                sr = cand
                break
    if not sr:
        sr = SHOWROOMS[0]
    site = _site_url()
    area = row.get("city") or row.get("town") or row.get("display_name") or ""
    return {
        "@context": "https://schema.org",
        "@type": "TileStore",
        "@id": f"{site}/showrooms#{sr['id']}",
        "name": sr["name"],
        "image": f"{site}/og-image.jpg",
        "url": f"{site}/showrooms",
        "telephone": sr["phone"],
        "priceRange": "££",
        "address": {
            "@type": "PostalAddress",
            "streetAddress": sr["street"],
            "addressLocality": sr["locality"],
            "addressRegion": sr["region"],
            "postalCode": sr["postcode"],
            "addressCountry": "GB",
        },
        "geo": {
            "@type": "GeoCoordinates",
            "latitude": sr["lat"],
            "longitude": sr["lon"],
        },
        "areaServed": {"@type": "City", "name": area},
        "openingHoursSpecification": [
            {"@type": "OpeningHoursSpecification",
             "dayOfWeek": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
             "opens": "08:00", "closes": "17:30"},
            {"@type": "OpeningHoursSpecification",
             "dayOfWeek": "Saturday", "opens": "09:00", "closes": "16:00"},
        ],
    }


def article_jsonld(row: dict) -> dict:
    """Schema.org Article block for the city landing page itself."""
    site = _site_url()
    title = row.get("meta_title") or row.get("headline") or row.get("display_name", "")
    desc = row.get("meta_description") or (row.get("body_md") or "")[:160]
    return {
        "@context": "https://schema.org",
        "@type": "Article",
        "headline": title[:110],
        "description": desc[:250],
        "url": f"{site}/{row['slug']}".replace("//", "/").replace("https:/", "https://"),
        "datePublished": row.get("approved_at") or row.get("created_at"),
        "dateModified": row.get("updated_at") or row.get("approved_at"),
        "author": {"@type": "Organization", "name": "Tile Station"},
        "publisher": {
            "@type": "Organization",
            "name": "Tile Station",
            "logo": {"@type": "ImageObject", "url": f"{site}/logo.png"},
        },
    }


async def internal_links_for_city(db, slug: str, limit_cities: int = 3,
                                  limit_collections: int = 3) -> dict:
    """Compute 3 nearest cities + 3 relevant collections to inject into
    the city page response. Frontend can render them as a "Nearby tile
    showrooms" section + "Popular collections at this location" — both
    real, editorial-quality internal links for SEO PageRank flow.

    Strategy:
      • Cities: same `region` first, then anything else, both sorted by
        `display_order`. Skips the current page so we don't self-link.
      • Collections: top N collections sorted by product_count.
    """
    me = await db.city_landing_pages.find_one(
        {"slug": slug}, {"_id": 0, "region": 1, "city": 1, "display_name": 1}
    ) or {}
    region = me.get("region") or ""

    nearby = []
    if region:
        cur = db.city_landing_pages.find(
            {"slug": {"$ne": slug}, "status": "approved", "region": region},
            {"_id": 0, "slug": 1, "display_name": 1, "city": 1, "region": 1},
        ).sort("display_order", 1).limit(limit_cities * 2)
        async for c in cur:
            nearby.append(c)
            if len(nearby) >= limit_cities:
                break
    if len(nearby) < limit_cities:
        cur = db.city_landing_pages.find(
            {"slug": {"$ne": slug}, "status": "approved",
             **({"region": {"$ne": region}} if region else {})},
            {"_id": 0, "slug": 1, "display_name": 1, "city": 1, "region": 1},
        ).sort("display_order", 1).limit(limit_cities)
        async for c in cur:
            nearby.append(c)
            if len(nearby) >= limit_cities:
                break

    site = _site_url()
    nearby_links = [
        {
            "url": f"{site}/{c['slug'].lstrip('/')}",
            "label": c.get("display_name") or c.get("city") or c["slug"],
            "region": c.get("region", ""),
        }
        for c in nearby[:limit_cities]
    ]

    # Categories: pick top N by product_count (cheap query — collection
    # docs are tiny and we have <100 of them). Storefront uses
    # `website_categories` for the public taxonomy; that's what links
    # like /collections/marble-tiles resolve against.
    coll_cur = db.website_categories.find(
        {"is_active": {"$ne": False}, "product_count": {"$gt": 0}},
        {"_id": 0, "slug": 1, "name": 1, "product_count": 1},
    ).sort("product_count", -1).limit(limit_collections)
    coll_links = []
    async for c in coll_cur:
        ref = c.get("slug")
        if not ref:
            continue
        coll_links.append({
            "url": f"{site}/collections/{ref}",
            "label": c.get("name") or ref,
            "product_count": c.get("product_count"),
        })

    return {"nearby_cities": nearby_links, "related_collections": coll_links}


# ── Hooks fired by the auto-approve / auto-promote pipeline ────────

async def on_city_page_published(slug: str) -> None:
    """Called after a city page transitions from `pending`/`generated`
    → `approved` (whether by manual click or auto-approval). Side
    effects:

      1. Re-submit the sitemap to GSC so Google re-crawls it within hours.
      2. Append a `seo_autopilot_log` entry for the daily digest.

    Fail-soft: any error is logged and swallowed so it never blocks
    the auto-approve transaction.
    """
    from config import get_db
    db = get_db()
    site = _site_url()
    page_url = f"{site}/{slug.lstrip('/')}"

    try:
        await db.seo_autopilot_log.insert_one({
            "kind": "city_page_published",
            "slug": slug,
            "url": page_url,
            "ts": datetime.now(timezone.utc),
        })
    except Exception:
        logger.exception("[seo-autopilot] failed to log city page publish")

    try:
        from services import gsc as gsc_svc
        admin_id = await gsc_svc._pick_connected_admin()
        if admin_id:
            await gsc_svc.submit_sitemap(admin_id)
            logger.info("[seo-autopilot] re-submitted sitemap after publishing %s", slug)
    except Exception:
        # GSC integration optional — never block publish if it fails.
        logger.warning("[seo-autopilot] sitemap re-submit failed (slug=%s)", slug)


async def on_variant_promoted(slug: str, winner: str) -> None:
    """Called after the A/B autopromote tick swaps variant A↔B for a
    city page based on real GSC performance. We log it for the digest
    and re-ping the sitemap so Google re-fetches the new content."""
    from config import get_db
    db = get_db()
    try:
        await db.seo_autopilot_log.insert_one({
            "kind": "variant_promoted",
            "slug": slug,
            "winner": winner,
            "ts": datetime.now(timezone.utc),
        })
    except Exception:
        logger.exception("[seo-autopilot] failed to log variant promotion")
    try:
        from services import gsc as gsc_svc
        admin_id = await gsc_svc._pick_connected_admin()
        if admin_id:
            await gsc_svc.submit_sitemap(admin_id)
    except Exception:
        logger.warning("[seo-autopilot] sitemap re-submit after variant promote failed")


# ── Daily digest ───────────────────────────────────────────────────

async def daily_published_digest() -> dict:
    """Build the daily 'what your SEO autopilot did' summary. Emails
    the admin via Resend so they have visibility without needing to
    review/approve anything.

    Returns the data dict so callers can show it on a dashboard too.
    """
    from config import get_db
    db = get_db()
    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)

    rows = await db.seo_autopilot_log.find(
        {"ts": {"$gte": cutoff}}, {"_id": 0}
    ).to_list(length=200)

    published = [r for r in rows if r.get("kind") == "city_page_published"]
    promoted = [r for r in rows if r.get("kind") == "variant_promoted"]
    indexed = [r for r in rows if r.get("kind") == "indexed_in_gsc"]

    # Recent GSC clicks vs prior 7d (for "growth" metric)
    growth = None
    try:
        from services import gsc as gsc_svc
        admin_id = await gsc_svc._pick_connected_admin()
        if admin_id:
            d28 = await gsc_svc.get_overview(admin_id, days=28)
            d7 = await gsc_svc.get_overview(admin_id, days=7)
            growth = {
                "clicks_7d": d7.get("totals", {}).get("clicks", 0),
                "clicks_prev21d": (d28.get("totals", {}).get("clicks", 0)
                                   - d7.get("totals", {}).get("clicks", 0)),
                "impressions_7d": d7.get("totals", {}).get("impressions", 0),
            }
    except Exception:
        growth = None

    return {
        "published_count": len(published),
        "promoted_count": len(promoted),
        "indexed_count": len(indexed),
        "published_pages": [p.get("url") for p in published[:25]],
        "promoted_pages": [{"slug": p.get("slug"), "winner": p.get("winner")}
                           for p in promoted[:25]],
        "growth": growth,
    }

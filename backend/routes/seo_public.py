"""
Public, crawler-facing SEO endpoints — sitemap.xml + robots.txt.

Why these live in their own module
----------------------------------
Everything else under `/api/...` is JSON for our own frontend. These two
endpoints are different:
  • content-types are XML/text, not JSON
  • response shape is fixed by Google's spec (sitemaps.org / robotstxt.org)
  • zero auth — Googlebot must reach them anonymously

The Vercel-served storefront rewrites the public URLs:
    tilestation.co.uk/sitemap.xml  →  <backend>/api/sitemap.xml
    tilestation.co.uk/robots.txt   →  <backend>/api/robots.txt

so Googlebot sees them at the canonical document-root paths it expects.

URLs we surface
---------------
1. Static landing routes        (/, /tiles, /clearance, /new-collection,
                                 /showroom-signup, /shop, /shop/cart)
2. Static info pages            (/shop/info/<slug>) — read from `info_pages`
3. Approved AI city pages       (/tiles/<slug>)     — read from `city_landing_pages`
                                                       where status='approved'
4. Active product pages         (/tiles/<slug>)     — read from `tiles`
                                                       where is_active=True
                                                       and `slug` is set

We DELIBERATELY exclude: cart, checkout, customer account, admin, auth.
None of those should ever be indexed.

Canonical host
--------------
Always emits absolute URLs against `SHOP_WEBSITE_URL` (default
`https://tilestation.co.uk`). Never the Railway sub-domain or the preview
URL — Google would treat those as duplicate content.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from xml.sax.saxutils import escape as xml_escape

from fastapi import APIRouter, Response

from config import get_db

logger = logging.getLogger(__name__)
router = APIRouter(tags=["SEO · Public"])


# ─── Hand-curated static URLs ─────────────────────────────────────────
# Anything not data-driven lives here. Each entry is (path, priority,
# changefreq). Keep the priority spread sane — the homepage gets the
# highest weight, info pages the lowest.
STATIC_URLS: list[tuple[str, str, str]] = [
    ("/",                   "1.0", "weekly"),
    ("/tiles",              "0.9", "daily"),
    ("/clearance",          "0.8", "weekly"),
    ("/new-collection",     "0.8", "weekly"),
    ("/showroom-signup",    "0.6", "monthly"),
    ("/shop",               "0.7", "weekly"),
    ("/shop/cart",          "0.4", "weekly"),
    # 12 May 2026 — added so the collections-index page (which links
    # to every collection PDP) is in the sitemap. Closes the orphan
    # loop reported by Ahrefs for /shop/collection/<name> URLs.
    ("/collections",        "0.85", "weekly"),
    ("/shop/all-tiles",     "0.85", "weekly"),
    ("/shop/bathroom",      "0.75", "weekly"),
    ("/shop/track",         "0.5", "monthly"),
    ("/shop/refer",         "0.5", "monthly"),
    ("/shop/info/faq",      "0.6", "monthly"),
    ("/shop/info/privacy",  "0.3", "yearly"),
    ("/shop/info/terms",    "0.3", "yearly"),
    ("/shop/info/returns",  "0.5", "monthly"),
    ("/shop/info/delivery", "0.5", "monthly"),
    ("/shop/info/reviews",  "0.7", "weekly"),
]


def _canonical_host() -> str:
    return (
        os.environ.get("SHOP_WEBSITE_URL")
        or os.environ.get("PUBLIC_SITE_URL")
        or "https://tilestation.co.uk"
    ).rstrip("/")


def _iso_for_sitemap(value) -> str:
    """Return a YYYY-MM-DD lastmod string. Sitemaps.org permits full
    W3C datetimes too, but the date-only form is shorter and equally
    well understood by Google."""
    if isinstance(value, datetime):
        dt = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return dt.strftime("%Y-%m-%d")
    if isinstance(value, str):
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return dt.strftime("%Y-%m-%d")
        except Exception:  # noqa: BLE001
            return datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _url_xml(loc: str, *, lastmod: str, priority: str, changefreq: str) -> str:
    """One <url> entry. We escape the loc because slugs *should* be
    safe ASCII but a future product name with `&` would break the XML
    parser otherwise."""
    return (
        "  <url>\n"
        f"    <loc>{xml_escape(loc)}</loc>\n"
        f"    <lastmod>{lastmod}</lastmod>\n"
        f"    <changefreq>{changefreq}</changefreq>\n"
        f"    <priority>{priority}</priority>\n"
        "  </url>\n"
    )


@router.api_route("/sitemap.xml", methods=["GET", "HEAD"], include_in_schema=False)
async def sitemap_xml() -> Response:
    """Return a real XML sitemap covering every URL Google should index.

    Refreshed on every request — these are cheap reads (≤ ~1500 product
    rows, all indexed) and avoiding a cron means the sitemap is always
    fresh after a product/page approval.
    """
    db = get_db()
    host = _canonical_host()
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    parts: list[str] = [
        '<?xml version="1.0" encoding="UTF-8"?>\n',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n',
    ]

    # 1. Static URLs
    for path, priority, changefreq in STATIC_URLS:
        parts.append(_url_xml(
            f"{host}{path}",
            lastmod=today,
            priority=priority,
            changefreq=changefreq,
        ))

    # 2. Info pages (delivery, returns, faq, privacy, terms, …)
    info_cursor = db.info_pages.find(
        {}, {"_id": 0, "slug": 1, "updated_at": 1, "title": 1}
    )
    async for row in info_cursor:
        slug = (row.get("slug") or "").strip()
        if not slug:
            continue
        parts.append(_url_xml(
            f"{host}/shop/info/{slug}",
            lastmod=_iso_for_sitemap(row.get("updated_at")),
            priority="0.5",
            changefreq="monthly",
        ))

    # 3. Approved AI city landing pages
    city_cursor = db.city_landing_pages.find(
        {"status": "approved"},
        {"_id": 0, "slug": 1, "updated_at": 1, "approved_at": 1},
    )
    async for row in city_cursor:
        slug = (row.get("slug") or "").strip()
        if not slug:
            continue
        # Prefer approved_at for lastmod — otherwise the cron's daily
        # writes to confidence_score etc would noise up the sitemap.
        lastmod_src = row.get("approved_at") or row.get("updated_at")
        parts.append(_url_xml(
            f"{host}/tiles/{slug}",
            lastmod=_iso_for_sitemap(lastmod_src),
            priority="0.85",  # high — these are the SEO bet
            changefreq="weekly",
        ))

    # 4. Active product/tile pages
    tile_cursor = db.tiles.find(
        {"is_active": True, "slug": {"$exists": True, "$nin": [None, ""]}},
        {"_id": 0, "slug": 1, "updated_at": 1},
    )
    async for row in tile_cursor:
        slug = (row.get("slug") or "").strip()
        if not slug:
            continue
        parts.append(_url_xml(
            f"{host}/tiles/{slug}",
            lastmod=_iso_for_sitemap(row.get("updated_at")),
            priority="0.7",
            changefreq="weekly",
        ))

    # 5. Editorial Autopilot blog index + articles. Blog content is the
    # link-magnet half of our SEO strategy — we want Google to discover
    # new posts within minutes of the Monday cron firing.
    parts.append(_url_xml(
        f"{host}/blog",
        lastmod=today,
        priority="0.7",
        changefreq="weekly",
    ))
    blog_cursor = db.blog_articles.find(
        {"$or": [{"status": "published"}, {"status": {"$exists": False}}]},
        {"_id": 0, "slug": 1, "published_at": 1, "updated_at": 1},
    )
    async for row in blog_cursor:
        slug = (row.get("slug") or "").strip()
        if not slug:
            continue
        parts.append(_url_xml(
            f"{host}/blog/{slug}",
            lastmod=_iso_for_sitemap(row.get("updated_at") or row.get("published_at")),
            priority="0.75",
            changefreq="monthly",
        ))

    # 6. Collection PDPs — /shop/collection/<series_name>
    # ───────────────────────────────────────────────────────────────
    # Each tile belongs to a "series" (e.g. Hartley, Fossil, Amalfi
    # Flat). The storefront builds collection PDPs at
    # /shop/collection/<URL-encoded series_name>. Ahrefs flagged
    # /shop/collection/Brilliant%20White as an orphan on 12 May 2026
    # because every collection PDP was missing from the sitemap and
    # had no internal links pointing to it from a crawler-friendly
    # surface. This step enumerates every distinct series_name from
    # active tiles and emits a sitemap entry per collection.
    # ───────────────────────────────────────────────────────────────
    import urllib.parse  # localised import — only used by this block
    try:
        # Aggregate distinct series names + a representative lastmod
        # so the sitemap entries get a real updated_at, not today's date.
        series_pipeline = [
            {"$match": {
                "is_active": True,
                "$or": [
                    {"series": {"$exists": True, "$nin": [None, ""]}},
                    {"series_name": {"$exists": True, "$nin": [None, ""]}},
                    {"original_series": {"$exists": True, "$nin": [None, ""]}},
                ],
            }},
            {"$project": {
                "_id": 0,
                "series_name": {
                    "$ifNull": [
                        "$original_series",
                        {"$ifNull": ["$series_name", "$series"]},
                    ],
                },
                "updated_at": 1,
            }},
            {"$match": {"series_name": {"$nin": [None, ""]}}},
            {"$group": {
                "_id": "$series_name",
                "last_updated": {"$max": "$updated_at"},
                "product_count": {"$sum": 1},
            }},
            # Only emit collections with ≥ 1 active products. The
            # group above already filters by is_active, so this is
            # belt-and-braces — protects against the 1-product
            # collections that exist only for testing.
            {"$match": {"product_count": {"$gte": 1}}},
            {"$sort": {"_id": 1}},
        ]
        async for row in db.tiles.aggregate(series_pipeline):
            series_name = (row.get("_id") or "").strip()
            if not series_name:
                continue
            # URL-encode the series name to match exactly how the
            # frontend builds collection URLs (CollectionDetailPage.js
            # uses encodeURIComponent). Spaces → %20, ampersands → %26.
            encoded = urllib.parse.quote(series_name, safe="")
            parts.append(_url_xml(
                f"{host}/shop/collection/{encoded}",
                lastmod=_iso_for_sitemap(row.get("last_updated") or today),
                priority="0.8",
                changefreq="weekly",
            ))
    except Exception as e:  # noqa: BLE001
        # Never fail the whole sitemap if the collection aggregation
        # fails — the existing entries are still useful.
        logger.warning(f"[sitemap] collection aggregation failed: {e}")

    parts.append("</urlset>\n")
    body = "".join(parts)

    return Response(
        content=body,
        media_type="application/xml",
        headers={
            # Tell CDNs / Cloudflare it's safe to cache for a few mins,
            # but never longer than that — admin approves new pages all
            # day and we want them in within minutes.
            "Cache-Control": "public, max-age=300, s-maxage=600",
        },
    )


@router.api_route("/robots.txt", methods=["GET", "HEAD"], include_in_schema=False)
async def robots_txt() -> Response:
    """Crawl directives + sitemap pointer. Disallows admin/auth/checkout
    so Google doesn't waste crawl budget there."""
    host = _canonical_host()
    body = (
        "# Tile Station robots — refreshed by FastAPI on every request.\n"
        "User-agent: *\n"
        "Allow: /\n"
        "\n"
        "# Don't index private flows or noisy parameter URLs.\n"
        "Disallow: /admin\n"
        "Disallow: /api/\n"
        "Disallow: /shop/cart\n"
        "Disallow: /shop/checkout\n"
        "Disallow: /shop/account\n"
        "Disallow: /shop/wishlist\n"
        "Disallow: /shop/order/\n"
        "Disallow: /customer\n"
        "Disallow: /staff-register\n"
        "Disallow: /reset-password\n"
        "Disallow: /forgot-password\n"
        "Disallow: /register\n"
        "\n"
        f"Sitemap: {host}/sitemap.xml\n"
    )
    return Response(
        content=body,
        media_type="text/plain",
        headers={"Cache-Control": "public, max-age=3600, s-maxage=3600"},
    )


# ─────────────────────────────────────────────────────────────────────
# /api/seo/redirects — dynamic 301 map for the Express SSR layer.
#
# Consumed by frontend/server.js on a 5-minute timer. The 404 autopilot
# + self-crawler write into `seo_redirects`; this endpoint exposes that
# collection so server.js can serve real HTTP 301s without a code deploy.
#
# Why dynamic > static
# --------------------
# Hard-coded redirects in server.js need a Railway deploy to take effect.
# Auto-fix needs to be instant — a customer hitting a 404 right after a
# product slug change should immediately get a 301 to the new URL, not
# wait for the next deploy cycle.
#
# Response shape: small JSON object that server.js can cache cheaply.
#   { "redirects": { "/old/path": "/new/path", ... }, "version": "<iso>" }
# Public, no auth. Capped at 5,000 redirects to bound payload size.
# ─────────────────────────────────────────────────────────────────────
@router.get("/seo/redirects")
async def public_redirects_map():
    """Return the full dynamic 301 map for the Express SSR layer to consume.

    No auth — the storefront's own server.js calls this on a 5-minute
    timer. Payload is intentionally small (path → target, no metadata)
    so 5-min polling stays cheap.
    """
    db = get_db()
    out: dict[str, str] = {}
    latest = datetime(2020, 1, 1, tzinfo=timezone.utc)
    cursor = db.seo_redirects.find(
        {},
        {"_id": 1, "target": 1, "created_at": 1, "status_code": 1},
    ).limit(5000)
    async for row in cursor:
        path = row.get("_id") or ""
        target = row.get("target") or ""
        if not path or not target:
            continue
        if not path.startswith("/"):
            continue
        # Skip non-301 redirects (e.g. 410 Gone we may add later)
        if row.get("status_code", 301) != 301:
            continue
        out[path] = target
        created = row.get("created_at")
        if isinstance(created, datetime) and created > latest:
            latest = created
    return {
        "redirects": out,
        "count": len(out),
        "version": latest.isoformat(),
    }

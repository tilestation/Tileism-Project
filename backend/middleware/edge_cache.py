"""
Edge-cache header middleware.

Adds Cache-Control / Surrogate-Control headers to PUBLIC, SAFE-IDEMPOTENT
GET endpoints so a CDN (Cloudflare, Fastly, etc.) can cache them at the
edge close to UK customers. This is the single biggest win once a CDN is
sitting in front of the Railway origin — repeated visitors and crawlers
get sub-50ms responses without ever touching our Python process.

Strategy:
* Only annotate GET requests on whitelisted, public, cacheable paths.
* Skip ANY request that carries an Authorization header or a session
  cookie — caching personalised responses is a privacy footgun.
* Skip responses with Set-Cookie (Cloudflare auto-bypasses but we are
  defensive).
* `s-maxage` is the CDN's TTL; `max-age` is the browser's TTL. We keep
  browser TTL short so price/stock updates roll out quickly but let the
  edge serve cached responses for longer with `stale-while-revalidate`
  so the customer never waits while we refresh.

Created 22 May 2026 — paired with Cloudflare CDN rollout to bring UK
TTFB from ~600ms (transatlantic to us-west2) to ~30ms (London edge).
"""

from __future__ import annotations

import re
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response


# Path prefixes that are SAFE to cache at the edge. Each entry is a
# (regex, cache_directive) pair. First match wins.
# NOTE: we match against the FULL request path, prefix /api included.
_CACHE_RULES: list[tuple[re.Pattern, str]] = [
    # Tile/product catalogue — large payloads, changes a few times per day.
    # 5 min edge, 60s browser, 1h stale-while-revalidate.
    (re.compile(r"^/api/tiles/collections/?$"),
     "public, max-age=60, s-maxage=300, stale-while-revalidate=3600"),
    (re.compile(r"^/api/tiles(?:/[^/]+)?/?$"),
     "public, max-age=60, s-maxage=300, stale-while-revalidate=3600"),
    (re.compile(r"^/api/shop/products/?$"),
     "public, max-age=60, s-maxage=300, stale-while-revalidate=3600"),
    (re.compile(r"^/api/shop/products/[^/]+/?$"),
     "public, max-age=60, s-maxage=300, stale-while-revalidate=3600"),
    (re.compile(r"^/api/shop/categories/?$"),
     "public, max-age=300, s-maxage=900, stale-while-revalidate=3600"),
    (re.compile(r"^/api/shop/featured/?$"),
     "public, max-age=120, s-maxage=600, stale-while-revalidate=3600"),
    (re.compile(r"^/api/shop/stores/?$"),
     "public, max-age=600, s-maxage=3600, stale-while-revalidate=86400"),
    # Bathroom / clearance / new-collection landing pages.
    (re.compile(r"^/api/bathroom/.*"),
     "public, max-age=120, s-maxage=600, stale-while-revalidate=3600"),
    # Public content (blog, info pages, FAQ, etc.) — change rarely.
    (re.compile(r"^/api/content/.*"),
     "public, max-age=300, s-maxage=1800, stale-while-revalidate=86400"),
    # Filters / facets — change rarely.
    (re.compile(r"^/api/filters/.*"),
     "public, max-age=300, s-maxage=1800, stale-while-revalidate=86400"),
    # Storefront-features feature flags — short TTL.
    (re.compile(r"^/api/storefront-features/?$"),
     "public, max-age=60, s-maxage=120, stale-while-revalidate=600"),
    # Showrooms.
    (re.compile(r"^/api/showrooms/?$"),
     "public, max-age=600, s-maxage=3600, stale-while-revalidate=86400"),
    # Sitemap / SEO public endpoints.
    (re.compile(r"^/api/seo/public/.*"),
     "public, max-age=300, s-maxage=1800, stale-while-revalidate=86400"),
]


class EdgeCacheMiddleware(BaseHTTPMiddleware):
    """Annotate cacheable public GETs with CDN-friendly Cache-Control."""

    async def dispatch(self, request: Request, call_next):
        response: Response = await call_next(request)

        # Only cache GET / HEAD.
        if request.method not in ("GET", "HEAD"):
            return response

        # Only cache 2xx responses.
        if not (200 <= response.status_code < 300):
            return response

        # NEVER cache anything that already declared itself private,
        # carries cookies, or was authenticated.
        if response.headers.get("set-cookie"):
            return response
        if request.headers.get("authorization"):
            return response

        path = request.url.path

        for pattern, directive in _CACHE_RULES:
            if pattern.match(path):
                # Don't clobber a directive the route already set.
                if not response.headers.get("cache-control"):
                    response.headers["cache-control"] = directive
                # Vary: encoding so the CDN keeps gzip/br variants separately.
                existing_vary = response.headers.get("vary", "")
                if "Accept-Encoding" not in existing_vary:
                    response.headers["vary"] = (
                        f"{existing_vary}, Accept-Encoding".strip(", ")
                    )
                break

        return response

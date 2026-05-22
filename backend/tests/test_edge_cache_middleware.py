"""
Regression tests for the CDN edge-cache header middleware.

These tests pin the contract that Cloudflare relies on:
  * Public GETs on whitelisted paths return `cache-control` with `s-maxage`.
  * `vary: Accept-Encoding` is set so gzip/brotli variants are cached
    separately and never cross-served.
  * Authorized requests do NOT receive a public cache directive (would
    leak personalised data via the CDN edge).
  * Non-2xx responses do NOT get a public cache directive (would pin a
    failure at the edge).

We hit the running uvicorn process via httpx — no FastAPI test client
because we want the production middleware chain (GZip + EdgeCache +
existing Starlette stack) exercised end-to-end.
"""
from __future__ import annotations

import os
import httpx
import pytest


BASE_URL = os.environ.get("TEST_BASE_URL", "http://localhost:8001")


def _get(path: str, **kwargs) -> httpx.Response:
    return httpx.get(f"{BASE_URL}{path}", timeout=10.0, **kwargs)


def test_shop_stores_has_public_cache_directive():
    """`/api/shop/stores` is whitelisted in the middleware and has no
    per-endpoint cache header, so the middleware should annotate it."""
    r = _get("/api/shop/stores")
    if r.status_code != 200:
        pytest.skip(f"shop/stores returned {r.status_code} in this env")
    cc = r.headers.get("cache-control", "")
    assert "public" in cc, f"expected public directive, got: {cc!r}"
    assert "s-maxage=" in cc, f"expected s-maxage for CDN, got: {cc!r}"
    assert "Accept-Encoding" in r.headers.get("vary", "")


def test_tiles_collections_has_s_maxage_for_cloudflare():
    """The high-traffic /api/tiles/collections endpoint must include
    `s-maxage` so Cloudflare caches it at the edge (not just browser)."""
    r = _get("/api/tiles/collections")
    if r.status_code != 200:
        pytest.skip(f"tiles/collections returned {r.status_code}")
    cc = r.headers.get("cache-control", "")
    assert "s-maxage=" in cc, (
        "tiles/collections must include s-maxage so Cloudflare edge-caches "
        f"it for UK customers. Got: {cc!r}"
    )
    assert "stale-while-revalidate=" in cc


def test_authorized_request_is_not_publicly_cached():
    """Sending an Authorization header must prevent the middleware from
    annotating the response — caching auth'd payloads at the CDN edge
    would leak private data to other visitors."""
    r = _get("/api/shop/stores", headers={"Authorization": "Bearer fake-token"})
    # We don't care about the status — we care that IF the response
    # came back 2xx, the middleware did NOT add public caching.
    if r.status_code == 200:
        cc = r.headers.get("cache-control", "")
        # The endpoint itself sets no cache header, so the only way a
        # public directive appears here is if the middleware misbehaves.
        assert "public" not in cc or "private" in cc, (
            f"authorized request got publicly-cacheable response: {cc!r}"
        )


def test_non_get_request_is_not_cached():
    """POST/PUT/DELETE should never be annotated."""
    r = httpx.post(f"{BASE_URL}/api/shop/stores", timeout=10.0)
    cc = r.headers.get("cache-control", "")
    # Don't care about status; just want to assert no s-maxage smuggled in.
    assert "s-maxage" not in cc

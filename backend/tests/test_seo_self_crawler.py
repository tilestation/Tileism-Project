"""
SEO Self-Crawler — unit tests
─────────────────────────────
Lock in the classification logic for `_inspect_one_url` (pure function
of httpx response + URL) and the `_classify_verdict` mapping from
GSC payload → bucket name.

Lives at /app/backend/tests/test_seo_self_crawler.py.
Run: cd /app/backend && python -m pytest tests/test_seo_self_crawler.py
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from services.seo_self_crawler import BRAND_FALLBACK_TITLES, _inspect_one_url
from services.gsc_indexing_scanner import _classify_verdict


def _mock_response(*, status: int = 200, html: str = "",
                   content_type: str = "text/html") -> MagicMock:
    r = MagicMock()
    r.status_code = status
    r.text = html
    r.content = html.encode("utf-8")
    r.headers = {"content-type": content_type}
    return r


@pytest.mark.asyncio
async def test_inspect_url_flags_404():
    client = MagicMock()
    client.get = AsyncMock(return_value=_mock_response(status=404, html=""))
    res = await _inspect_one_url(client, "https://example.com/missing")
    assert res["status_code"] == 404
    assert any(i["kind"] == "not_found" for i in res["issues"])


@pytest.mark.asyncio
async def test_inspect_url_flags_500():
    client = MagicMock()
    client.get = AsyncMock(return_value=_mock_response(status=500, html=""))
    res = await _inspect_one_url(client, "https://example.com/boom")
    assert any(i["kind"] == "server_error" for i in res["issues"])


@pytest.mark.asyncio
async def test_inspect_url_flags_3xx_as_redirect():
    client = MagicMock()
    client.get = AsyncMock(return_value=_mock_response(status=301, html=""))
    res = await _inspect_one_url(client, "https://example.com/old")
    assert any(i["kind"] == "redirect_from_canonical" for i in res["issues"])


@pytest.mark.asyncio
async def test_inspect_url_flags_fallback_title():
    html = """<!doctype html><html><head>
        <title>Tile Station — Premium Tiles & Stone, UK</title>
        <meta name="description" content="UK tile retailer with showrooms across Kent and Essex selling premium ceramic.">
        <link rel="canonical" href="https://example.com/p">
        </head><body><h1>Hello</h1>
        <script type="application/ld+json">{"@type":"Product"}</script>
        <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Some longer text
        to push above 200 chars so we don't trip the thin content flag. Lorem ipsum
        dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt
        ut labore et dolore magna aliqua. Lorem ipsum dolor sit amet.</p>
        </body></html>"""
    client = MagicMock()
    client.get = AsyncMock(return_value=_mock_response(status=200, html=html))
    res = await _inspect_one_url(client, "https://example.com/p")
    kinds = {i["kind"] for i in res["issues"]}
    assert "fallback_title" in kinds
    # description is 80+ chars so should NOT flag short
    assert "short_description" not in kinds
    # H1 + canonical + jsonld + 200-char body all present
    assert "missing_h1" not in kinds
    assert "missing_canonical" not in kinds
    assert "missing_jsonld" not in kinds
    assert "thin_content" not in kinds


@pytest.mark.asyncio
async def test_inspect_url_flags_thin_content():
    html = "<!doctype html><html><head><title>Real Title · Tile Station</title></head><body></body></html>"
    client = MagicMock()
    client.get = AsyncMock(return_value=_mock_response(status=200, html=html))
    res = await _inspect_one_url(client, "https://example.com/thin")
    kinds = {i["kind"] for i in res["issues"]}
    assert "thin_content" in kinds
    assert "missing_h1" in kinds
    assert "missing_description" in kinds


@pytest.mark.asyncio
async def test_inspect_url_clears_issues_on_noindex():
    """Pages with <meta robots="noindex"> are EXPECTED to be excluded.
    The crawler must not complain about them."""
    html = """<!doctype html><html><head>
        <title>Tile Station — Premium Tiles & Stone, UK</title>
        <meta name="robots" content="noindex,follow">
        </head><body></body></html>"""
    client = MagicMock()
    client.get = AsyncMock(return_value=_mock_response(status=200, html=html))
    res = await _inspect_one_url(client, "https://example.com/private")
    assert res["intentionally_noindex"] is True
    assert res["issues"] == []


# ─── _classify_verdict mapping ────────────────────────────────────────


def test_classify_verdict_indexed():
    payload = {
        "verdict": "PASS",
        "coverage_state": "Submitted and indexed",
        "indexing_state": "INDEXING_ALLOWED",
    }
    assert _classify_verdict(payload) == "indexed"


def test_classify_verdict_soft_404():
    payload = {"verdict": "NEUTRAL", "coverage_state": "Soft 404"}
    assert _classify_verdict(payload) == "soft_404"


def test_classify_verdict_page_with_redirect():
    payload = {"coverage_state": "Page with redirect"}
    assert _classify_verdict(payload) == "page_with_redirect"


def test_classify_verdict_crawled_not_indexed():
    payload = {"coverage_state": "Crawled - currently not indexed"}
    assert _classify_verdict(payload) == "crawled_not_indexed"


def test_classify_verdict_discovered_not_indexed():
    payload = {"coverage_state": "Discovered - currently not indexed"}
    assert _classify_verdict(payload) == "discovered_not_indexed"


def test_classify_verdict_not_found():
    payload = {"coverage_state": "Not found (404)"}
    assert _classify_verdict(payload) == "not_found"


def test_classify_verdict_alternate_canonical():
    payload = {"coverage_state": "Alternate page with proper canonical tag"}
    assert _classify_verdict(payload) == "alternate_canonical"


def test_classify_verdict_unknown_falls_through():
    """Unknown payloads return 'unknown' — never crash."""
    assert _classify_verdict({}) == "unknown"
    assert _classify_verdict({"foo": "bar"}) == "unknown"


# ─── BRAND_FALLBACK_TITLES sanity check ───────────────────────────────


def test_brand_fallback_titles_includes_canonical():
    """Regression — must contain the exact title produced by server-seo.js
    FALLBACK so the crawler keeps detecting it."""
    assert "tile station — premium tiles & stone, uk" in BRAND_FALLBACK_TITLES

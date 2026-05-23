"""
Regression test: SEO self-audit HTTP requests must carry headers that
Cloudflare's bot management lets through.

Background (23 May 2026):
  After putting Cloudflare in front of tilestation.co.uk the nightly
  SEO self-audit started reporting `HTTP -1 after 12220ms` on every
  external fetch (sitemap, robots, homepage, PDPs). Root cause:
  Cloudflare's "managed challenge" serves a JS puzzle that Python
  httpx cannot solve, so requests timed out.

Contract:
  • _http_get MUST send a User-Agent that looks like a real browser
    (NOT the literal string "Bot" or the old "TileStation-SeoAudit"
    UA, both of which Cloudflare flags).
  • If SEO_AUDIT_SHARED_SECRET is set, _http_get MUST include it as
    `X-SEO-Audit-Secret` so the Cloudflare WAF allow-rule can match.
  • No header should be sent when the secret env var is missing — we
    don't want to leak an empty header that might confuse downstream.
"""
from __future__ import annotations

import asyncio
import os

import pytest


@pytest.mark.asyncio
async def test_http_get_uses_browser_useragent(monkeypatch):
    """The audit MUST identify as a browser, not as our old bot UA."""
    from services import seo_self_audit

    captured = {}

    class _StubResponse:
        status_code = 200
        text = "<html></html>"
        headers = {}

    class _StubClient:
        def __init__(self, *a, **k):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *a):
            return False
        async def get(self, url, headers=None):
            captured["headers"] = headers
            return _StubResponse()

    monkeypatch.setattr(seo_self_audit.httpx, "AsyncClient", _StubClient)

    await seo_self_audit._http_get("https://example.com/")

    ua = captured["headers"]["User-Agent"]
    assert "Mozilla/5.0" in ua, f"audit UA must start like a real browser; got: {ua!r}"
    assert "Chrome/" in ua, f"audit UA must include a Chrome version; got: {ua!r}"
    # The new UA still includes our brand for log forensics — but only
    # at the END so Cloudflare's regex matchers don't trip on it.
    assert ua.endswith("TileStationSelfAudit"), (
        f"audit UA should still carry our brand for log forensics; got: {ua!r}"
    )
    # Sanity: NOT the old broken UA.
    assert "TileStation-SeoAudit/1.0" not in ua


@pytest.mark.asyncio
async def test_http_get_attaches_shared_secret_when_set(monkeypatch):
    """When the env var is set, send it as a custom header so Cloudflare
    WAF can allow-list it."""
    from services import seo_self_audit

    captured = {}

    class _StubResponse:
        status_code = 200
        text = ""
        headers = {}
    class _StubClient:
        def __init__(self, *a, **k): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def get(self, url, headers=None):
            captured["headers"] = headers
            return _StubResponse()

    monkeypatch.setattr(seo_self_audit.httpx, "AsyncClient", _StubClient)
    monkeypatch.setenv("SEO_AUDIT_SHARED_SECRET", "abc-very-secret-xyz")

    await seo_self_audit._http_get("https://example.com/")

    assert captured["headers"].get("X-SEO-Audit-Secret") == "abc-very-secret-xyz"


@pytest.mark.asyncio
async def test_http_get_omits_secret_header_when_unset(monkeypatch):
    """When the env var is empty, do NOT send an empty secret header."""
    from services import seo_self_audit

    captured = {}

    class _StubResponse:
        status_code = 200
        text = ""
        headers = {}
    class _StubClient:
        def __init__(self, *a, **k): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def get(self, url, headers=None):
            captured["headers"] = headers
            return _StubResponse()

    monkeypatch.setattr(seo_self_audit.httpx, "AsyncClient", _StubClient)
    monkeypatch.delenv("SEO_AUDIT_SHARED_SECRET", raising=False)

    await seo_self_audit._http_get("https://example.com/")

    assert "X-SEO-Audit-Secret" not in captured["headers"]

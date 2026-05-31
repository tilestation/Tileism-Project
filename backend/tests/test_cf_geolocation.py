"""Mobile-NAT geo-resolution fix — verifies Cloudflare CF-IPCity is
preferred over ip-api when present.

Bug context: EE/Vodafone/Three mobile traffic all NATs through a
Manchester GGSN. ip-api.com sees that IP and reports "Manchester"
for every mobile visitor. Cloudflare's CF-IPCity is resolved at the
edge using the visitor's *carrier breakout location*, which is much
closer to the actual handset. This test pins that priority order.
"""
from __future__ import annotations

import os
from unittest.mock import AsyncMock, patch

import pytest
from starlette.datastructures import Headers
from starlette.requests import Request

os.environ.setdefault("DB_NAME", "test_db_cf_geo")

from routes import live_chat  # noqa: E402


def _make_request(headers: dict) -> Request:
    """Spin up a minimal Starlette Request carrying the headers we
    want to test. Scope is the documented contract for Request(...)."""
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/",
        "headers": Headers(headers).raw,
        "client": ("1.2.3.4", 12345),
        "query_string": b"",
        "server": ("testserver", 80),
        "scheme": "http",
    }
    return Request(scope)


@pytest.mark.asyncio
async def test_cf_ipcity_takes_precedence_over_ip_api():
    """Mobile carrier NAT scenario: ip-api would return Manchester
    but CF-IPCity says Tonbridge → we must report Tonbridge."""
    req = _make_request({
        "CF-IPCountry": "GB",
        "CF-IPCity": "Tonbridge",
        "CF-Region": "Kent",
    })
    # ip-api should NOT be hit when CF headers are present
    with patch("httpx.AsyncClient") as mock_client:
        loc = await live_chat.get_visitor_location("212.140.99.99", request=req)
    assert loc["city"] == "Tonbridge"
    assert loc["country_code"] == "GB"
    assert loc["region"] == "Kent"
    mock_client.assert_not_called()


@pytest.mark.asyncio
async def test_cf_country_only_leaves_city_unknown_not_manchester():
    """Free Cloudflare tier — country header present, city header
    absent. Must NOT fall back to ip-api (which would mangle mobile
    traffic to Manchester). City stays Unknown."""
    req = _make_request({"CF-IPCountry": "GB"})
    with patch("httpx.AsyncClient") as mock_client:
        loc = await live_chat.get_visitor_location("212.140.99.99", request=req)
    assert loc["country_code"] == "GB"
    assert loc["city"] == "Unknown"
    mock_client.assert_not_called()


@pytest.mark.asyncio
async def test_falls_back_to_ip_api_when_no_cf_headers():
    """Backend hit directly (preview env, internal probe) — no
    Cloudflare in front → must still resolve via ip-api."""
    req = _make_request({})
    # Mock the httpx call
    mock_response = type("R", (), {
        "status_code": 200,
        "json": lambda self: {
            "country": "United Kingdom",
            "city": "Brighton",
            "regionName": "England",
            "countryCode": "GB",
        },
    })()

    class _MockClient:
        def __init__(self, *a, **kw): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def get(self, *a, **kw): return mock_response

    with patch("httpx.AsyncClient", _MockClient):
        loc = await live_chat.get_visitor_location("8.8.8.8", request=req)
    assert loc["city"] == "Brighton"
    assert loc["country"] == "United Kingdom"


@pytest.mark.asyncio
async def test_local_ip_short_circuits():
    """Localhost/private network IPs always return Local, never
    touching the network."""
    loc = await live_chat.get_visitor_location("127.0.0.1")
    assert loc == {"country": "Local", "city": "Local", "country_code": "LC"}


@pytest.mark.asyncio
async def test_invalid_cf_country_is_ignored():
    """A bogus 3-char or empty CF-IPCountry must not propagate as a
    fake country code — fall back to ip-api instead."""
    req = _make_request({"CF-IPCountry": "XXXX"})  # not 2 chars
    mock_response = type("R", (), {
        "status_code": 200,
        "json": lambda self: {
            "country": "Ireland",
            "city": "Dublin",
            "regionName": "Leinster",
            "countryCode": "IE",
        },
    })()

    class _MockClient:
        def __init__(self, *a, **kw): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def get(self, *a, **kw): return mock_response

    with patch("httpx.AsyncClient", _MockClient):
        loc = await live_chat.get_visitor_location("82.165.0.0", request=req)
    assert loc["country_code"] == "IE"
    assert loc["city"] == "Dublin"

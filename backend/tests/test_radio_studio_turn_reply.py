"""Single-turn AI-reply endpoint tests.

The LLM call itself is stubbed via `unittest.mock` so we don't burn
Claude tokens on CI. We validate: contract shape, speaker alternation
default, label/quote stripping, and the empty-input guard.
"""
from __future__ import annotations

import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

os.environ.setdefault("DB_NAME", "test_db_radio_turn_reply")
os.environ.setdefault("EMERGENT_LLM_KEY", "test_key_dummy")

from server import app  # noqa: E402


async def _login_admin(client: AsyncClient) -> str:
    r = await client.post(
        "/api/auth/login",
        json={"email": "admin@test.com", "password": "admin123"},
    )
    return r.json()["token"]


@pytest.mark.asyncio
async def test_generate_turn_reply_requires_input():
    """No prior turns AND no topic → 422 (we need SOMETHING to
    generate from)."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        token = await _login_admin(client)
        r = await client.post(
            "/api/admin/radio-studio/scripts/generate-turn-reply",
            headers={"Authorization": f"Bearer {token}"},
            json={"prior_turns": [], "reply_speaker": "host"},
        )
        assert r.status_code == 422
        assert "prior turn" in r.text.lower() or "topic" in r.text.lower()


@pytest.mark.asyncio
async def test_generate_turn_reply_returns_clean_text():
    """Happy path — stubbed LLM returns a reply with a stray label
    + wrapping quotes; endpoint must strip both. Verifies the
    speaker echoes the request and word/duration counts are sane."""
    transport = ASGITransport(app=app)

    fake_chat = MagicMock()
    fake_chat.with_model = MagicMock(return_value=None)
    fake_chat.send_message = AsyncMock(
        return_value='HOST: "You\'ll want Mapei Keraflex Maxi S1 for that one — it grips heated screeds nicely."'
    )

    with patch("emergentintegrations.llm.chat.LlmChat", return_value=fake_chat):
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            token = await _login_admin(client)
            r = await client.post(
                "/api/admin/radio-studio/scripts/generate-turn-reply",
                headers={"Authorization": f"Bearer {token}"},
                json={
                    "prior_turns": [
                        {"speaker": "guest", "text": "Best adhesive for 60x120 porcelain on UFH?"}
                    ],
                    "reply_speaker": "host",
                    "host_name": "Mark",
                    "guest_name": "Dave",
                },
            )
            assert r.status_code == 200, r.text
            data = r.json()
            assert data["speaker"] == "host"
            # Wrapping quotes + "HOST:" prefix should be stripped
            assert not data["text"].startswith("HOST:")
            assert not data["text"].startswith('"')
            assert not data["text"].endswith('"')
            assert "Mapei" in data["text"]
            assert data["approx_words"] > 0
            assert data["approx_seconds"] > 0


@pytest.mark.asyncio
async def test_generate_turn_reply_rejects_bogus_speaker():
    """`reply_speaker` must be host|guest — anything else 422s
    BEFORE we burn an LLM call."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        token = await _login_admin(client)
        r = await client.post(
            "/api/admin/radio-studio/scripts/generate-turn-reply",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "prior_turns": [{"speaker": "host", "text": "Welcome to Trade Talk."}],
                "reply_speaker": "narrator",
            },
        )
        assert r.status_code == 422


@pytest.mark.asyncio
async def test_generate_turn_reply_requires_auth():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        r = await client.post(
            "/api/admin/radio-studio/scripts/generate-turn-reply",
            json={
                "prior_turns": [{"speaker": "host", "text": "..."}],
                "reply_speaker": "guest",
            },
        )
        assert r.status_code in (401, 403)

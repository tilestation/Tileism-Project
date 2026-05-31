"""Q&A generator tone selector — verifies the three tones round-trip
through to the LLM system prompt as expected.

The LlmChat itself is stubbed; we assert on the constructor args
(system_message string) to confirm each tone produces the right
register hint without making a real Claude call.
"""
from __future__ import annotations

import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

os.environ.setdefault("DB_NAME", "test_db_radio_qa_tone")
os.environ.setdefault("EMERGENT_LLM_KEY", "test_key_dummy")

from server import app  # noqa: E402


async def _login_admin(client: AsyncClient) -> str:
    r = await client.post(
        "/api/auth/login",
        json={"email": "admin@test.com", "password": "admin123"},
    )
    return r.json()["token"]


def _stub_chat(reply: str):
    """Return a (LlmChat-class-mock, last_system_seen_holder) pair so
    each test can inspect what system_message landed in the LLM."""
    holder = {"system_message": None}

    def _ctor(**kw):
        holder["system_message"] = kw.get("system_message", "")
        chat = MagicMock()
        chat.with_model = MagicMock(return_value=None)
        chat.send_message = AsyncMock(return_value=reply)
        return chat

    return _ctor, holder


@pytest.mark.asyncio
@pytest.mark.parametrize("tone,marker", [
    ("friendly", "neighbour"),     # the friendly directive talks about a "helpful neighbour"
    ("expert", "senior tile-fitter"),  # expert directive
    ("trade", "professional builders"),  # trade directive
])
async def test_generate_qa_each_tone_lands_in_system_prompt(tone, marker):
    """Each tone produces a distinct directive in the LLM system
    prompt. Catches the regression where someone re-hardcodes 'expert'
    behind the frontend selector."""
    ctor, holder = _stub_chat(
        "Short answer: yes — Mapei Keraflex Maxi S1 is the spec for that. "
        "Spread it 6 mm with a notched trowel and key it well into the screed."
    )
    transport = ASGITransport(app=app)
    with patch("emergentintegrations.llm.chat.LlmChat", side_effect=ctor):
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            token = await _login_admin(client)
            r = await client.post(
                "/api/admin/radio-studio/scripts/generate-qa",
                headers={"Authorization": f"Bearer {token}"},
                json={
                    "question": "Best adhesive for 60x120 porcelain on heated screed?",
                    "tone": tone,
                },
            )
            assert r.status_code == 200, r.text
            data = r.json()
            assert "Mapei" in data["answer"]
            assert data["approx_words"] > 5
    # Verify the right tone directive made it into the prompt
    sys_msg = holder["system_message"] or ""
    assert marker.lower() in sys_msg.lower(), (
        f"Tone='{tone}' should produce a system prompt mentioning '{marker}'. Got:\n{sys_msg}"
    )


@pytest.mark.asyncio
async def test_generate_qa_rejects_unknown_tone():
    """Pydantic Literal["friendly","expert","trade"] → 422 on
    anything else. The frontend never sends a bad value, but we
    don't want an admin curl-test bricking the API surface."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        token = await _login_admin(client)
        r = await client.post(
            "/api/admin/radio-studio/scripts/generate-qa",
            headers={"Authorization": f"Bearer {token}"},
            json={"question": "What is the best grout?", "tone": "shouty"},
        )
        assert r.status_code == 422


@pytest.mark.asyncio
async def test_generate_qa_strips_answer_label_and_quotes():
    """Common LLM-defect: wraps the answer in `Answer: "..."`. Both
    must be stripped client-side BEFORE the frontend renders it."""
    ctor, _holder = _stub_chat(
        'Answer: "Short answer: no — use HardieBacker on plasterboard in wet zones."'
    )
    transport = ASGITransport(app=app)
    with patch("emergentintegrations.llm.chat.LlmChat", side_effect=ctor):
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            token = await _login_admin(client)
            r = await client.post(
                "/api/admin/radio-studio/scripts/generate-qa",
                headers={"Authorization": f"Bearer {token}"},
                json={"question": "Can I tile onto plasterboard in a shower?", "tone": "expert"},
            )
            assert r.status_code == 200
            ans = r.json()["answer"]
            assert not ans.startswith("Answer:")
            assert not ans.startswith('"')
            assert not ans.endswith('"')
            assert "HardieBacker" in ans

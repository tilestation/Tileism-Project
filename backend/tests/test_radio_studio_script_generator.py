"""
Regression test for the AI auto-generate script endpoint
(24 May 2026 — user-requested: "Could you give an option to auto
generate ads (by adding few keywords) as well as manual").

The actual LLM call is NOT hit here (network + cost). This file
pins the contract:
  • Request model validates input bounds (keywords, duration, tone)
  • Endpoint computes the target word budget from duration
  • Endpoint strips common LLM defects (code fences, "Script:"
    prefix, surrounding quotes) before returning
  • System prompt enforces the in-store narration rules
"""
from __future__ import annotations

import inspect

import pytest


def test_generate_script_request_validates():
    from routes.radio_studio import GenerateScriptReq
    # Happy path — defaults are sensible.
    r = GenerateScriptReq(keywords="sale")
    assert r.duration_seconds == 20
    assert r.tone == "friendly"
    assert r.audience == "both"
    assert r.call_to_action is None
    # Tone is constrained to the 5 documented values.
    with pytest.raises(Exception):
        GenerateScriptReq(keywords="x", tone="sarcastic")
    # Duration is clamped 10..60.
    with pytest.raises(Exception):
        GenerateScriptReq(keywords="x", duration_seconds=5)
    with pytest.raises(Exception):
        GenerateScriptReq(keywords="x", duration_seconds=120)
    # Audience whitelist.
    with pytest.raises(Exception):
        GenerateScriptReq(keywords="x", audience="children")
    # Keywords required.
    with pytest.raises(Exception):
        GenerateScriptReq(keywords="")


def test_generate_script_system_prompt_pins_narration_rules():
    """The system prompt must include the rules that prevent the LLM
    from producing read-on-a-page copy (which sounds awful when
    spoken). Specifically:
      - 'STRICT RULES:' header so the model takes them seriously
      - No stage directions / markdown
      - Spell out numbers (so the TTS narrator says 'twenty percent'
        not 'two zero percent')
      - UK English spellings
      - Brand name 'Tile Station' as two words
      - No invented prices"""
    from routes import radio_studio
    src = inspect.getsource(radio_studio.generate_script)
    for needle in (
        "STRICT RULES",
        "no markdown",
        "Spell out numbers",
        "UK English",
        "'Tile Station'",
        "Never invent prices",
    ):
        assert needle in src, f"System prompt must include: {needle}"


def test_generate_script_strips_llm_defects():
    """The endpoint post-processes the LLM output to strip the most
    common defects: code fences, leading/trailing double quotes,
    'Script:' or 'AD:' prefixes the model adds despite instructions."""
    from routes import radio_studio
    src = inspect.getsource(radio_studio.generate_script)
    assert 'script.startswith("```")' in src
    assert "script.startswith(\"'\") and script.endswith(\"'\")" in src \
        or 'script.startswith(\'"\') and script.endswith(\'"\')' in src
    for prefix in ("Script:", "SCRIPT:", "Ad:", "AD:"):
        assert f'"{prefix}"' in src, f"Must strip leading '{prefix}' prefix"


def test_generate_script_word_budget_scales_with_duration():
    """Eyeball check on the words-per-second budget. 20s of UK English
    narration ≈ 46 words; 60s ≈ 138 words. The endpoint uses a
    rate of ~2.3 wps."""
    from routes import radio_studio
    src = inspect.getsource(radio_studio.generate_script)
    # The exact rate is documented for future tuning.
    assert "2.3" in src, "Word budget calc must use the 2.3 wps rate"


def test_generate_script_uses_claude_haiku_via_emergent_key():
    """Auto-generate must NOT call OpenAI / Gemini directly — that
    bypasses the Emergent LLM key billing. Must use the same pattern
    as marketing_studio (LlmChat + Claude Haiku)."""
    from routes import radio_studio
    src = inspect.getsource(radio_studio.generate_script)
    assert "EMERGENT_LLM_KEY" in src
    assert "LlmChat" in src
    assert "claude-haiku-4-5" in src


def test_endpoint_is_admin_only():
    """Script generation hits the LLM (which costs credits) so it
    must require admin auth — _require_admin is the first line of
    business in the handler."""
    from routes import radio_studio
    src = inspect.getsource(radio_studio.generate_script)
    first_real_line = next(
        (ln.strip() for ln in src.split("\n")
         if ln.strip() and not ln.strip().startswith(('"', '#', '@', "'", "async ", "def "))),
        "",
    )
    assert "_require_admin(current_user)" in src
    # And it appears BEFORE any LLM call.
    require_idx = src.index("_require_admin(current_user)")
    llm_idx = src.index("LlmChat(")
    assert require_idx < llm_idx, "Admin gate must run before LLM call"

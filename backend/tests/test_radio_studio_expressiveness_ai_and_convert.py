"""
Regression tests for the two features shipped 2 Jun 2026:
  • Trade Talk generator now returns a `suggested_expressiveness`
    + `expressiveness_reason` parsed from a trailing `EXPRESSIVENESS:`
    line in Claude's output.
  • New `POST /scripts/convert` endpoint promotes a saved Q&A into
    a Trade Talk dialogue OR collapses a saved Trade Talk into a
    single Q&A — preserves the technical content while changing
    the format.
"""
import sys
from unittest.mock import AsyncMock, patch

import pytest

sys.path.insert(0, "/app/backend")

from routes import radio_studio


# ────────────────────────────────────────────────────────────────────
# Helper — fake LLM client that returns a canned dialogue + optional
# EXPRESSIVENESS line so we can test parsing without burning tokens.
# ────────────────────────────────────────────────────────────────────
class FakeLlmChat:
    def __init__(self, *args, **kwargs):
        self.system_message = kwargs.get("system_message", "")

    def with_model(self, *args, **kwargs):
        return self

    @staticmethod
    def _factory(canned_output: str):
        class _Chat:
            def __init__(self, *_a, **_kw): pass
            def with_model(self, *_a, **_kw): return self
            async def send_message(self, _msg): return canned_output
        return _Chat


# ─── Feature 1: suggested_expressiveness parsing ─────────────────────

@pytest.mark.asyncio
async def test_trade_talk_generator_parses_expressiveness_hint(monkeypatch):
    """If Claude appends `EXPRESSIVENESS: 0.30 — reason`, the response
    should surface those values to the frontend so the slider can
    pre-populate."""
    monkeypatch.setenv("EMERGENT_LLM_KEY", "test-key")
    canned = """HOST: Welcome back to Trade Talk on Tile Station Radio.
GUEST: Right, yeah — hi mate. Got a quick one for you.
HOST: Go for it.
GUEST: Cracking screed under porcelain — what's going on?
HOST: Ah, classic one this. Two things normally.
GUEST: Mmm, gotcha. Like what?
HOST: Curing time and decoupling membrane. Top causes.
GUEST: Right, fair enough.
HOST: Cheers, Dave — Trade Talk's back tomorrow.
EXPRESSIVENESS: 0.30 — technical safety detail, calm delivery"""

    with patch("emergentintegrations.llm.chat.LlmChat", FakeLlmChat._factory(canned)), \
         patch("emergentintegrations.llm.chat.UserMessage", new=lambda **kw: kw):
        req = radio_studio.GenerateTradeTalkReq(
            topic="Cracking screed under porcelain", target_duration_seconds=180,
        )
        result = await radio_studio.generate_trade_talk_script(
            req, {"role": "super_admin", "email": "a@b"},
        )
    assert result["suggested_expressiveness"] == 0.30
    assert "technical" in result["expressiveness_reason"].lower()
    # The EXPRESSIVENESS line MUST NOT leak into the turns list.
    for t in result["turns"]:
        assert "EXPRESSIVENESS" not in t["text"].upper()


@pytest.mark.asyncio
async def test_trade_talk_generator_defaults_to_natural_when_hint_missing(monkeypatch):
    """If Claude trims the EXPRESSIVENESS line under length pressure,
    we still return 0.5 + a default reason so the frontend doesn't
    crash on a missing field."""
    monkeypatch.setenv("EMERGENT_LLM_KEY", "test-key")
    canned = """HOST: Welcome back.
GUEST: Hi mate, got a question.
HOST: Go for it.
GUEST: How thick should adhesive be?
HOST: Five to ten mil for floor tiles.
GUEST: Right, gotcha.
HOST: Cheers."""

    with patch("emergentintegrations.llm.chat.LlmChat", FakeLlmChat._factory(canned)), \
         patch("emergentintegrations.llm.chat.UserMessage", new=lambda **kw: kw):
        req = radio_studio.GenerateTradeTalkReq(topic="x" * 10)
        result = await radio_studio.generate_trade_talk_script(
            req, {"role": "super_admin", "email": "a@b"},
        )
    assert result["suggested_expressiveness"] == 0.5
    assert result["expressiveness_reason"]  # non-empty default copy


@pytest.mark.asyncio
async def test_expressiveness_hint_with_various_dash_formats(monkeypatch):
    """Em-dash, en-dash, plain dash and missing-dash all parse correctly."""
    monkeypatch.setenv("EMERGENT_LLM_KEY", "test-key")
    base = """HOST: Welcome back.
GUEST: Hi mate.
HOST: Go for it.
GUEST: How thick should adhesive be?
HOST: Five to ten mil for floor tiles.
GUEST: Right, fair enough.
HOST: Cheers."""
    for hint_line, expected_val in [
        ("EXPRESSIVENESS: 0.85 — promo, energetic", 0.85),
        ("EXPRESSIVENESS: 0.45 - troubleshooting", 0.45),
        ("EXPRESSIVENESS: 0.20 – safety", 0.20),
        ("EXPRESSIVENESS: 0.6", 0.6),
    ]:
        canned = base + "\n" + hint_line
        with patch("emergentintegrations.llm.chat.LlmChat", FakeLlmChat._factory(canned)), \
             patch("emergentintegrations.llm.chat.UserMessage", new=lambda **kw: kw):
            req = radio_studio.GenerateTradeTalkReq(topic="x" * 10)
            result = await radio_studio.generate_trade_talk_script(
                req, {"role": "super_admin", "email": "a@b"},
            )
        assert result["suggested_expressiveness"] == expected_val, \
            f"Failed for line: {hint_line!r}"


# ─── Feature 2: convert Q&A ↔ Trade Talk ─────────────────────────────

class _FakeDB:
    """Minimal Mongo stub for the convert endpoint tests."""
    def __init__(self, source_doc):
        class _Coll:
            def __init__(self, doc): self._doc = doc
            async def find_one(self, query, projection=None):
                return self._doc
        self.radio_studio_ads = _Coll(source_doc)


@pytest.mark.asyncio
async def test_convert_qa_to_trade_talk(monkeypatch):
    """A saved Q&A doc → Trade Talk multi-turn dialogue that EXPANDS
    on (doesn't replace) the original authoritative answer."""
    monkeypatch.setenv("EMERGENT_LLM_KEY", "test-key")
    qa_doc = {
        "id": "qa-1",
        "kind": "qa",
        "name": "Cracking screed Q&A",
        "customer_question": "Why is my screed cracking under porcelain tiles?",
        "answer": "Usually one of two things: screed wasn't fully cured (28-day rule), "
                  "or you laid on a flexible surface without a decoupling membrane.",
    }
    captured_topic = {}
    canned_tt = """HOST: Welcome back to Trade Talk.
GUEST: Right, yeah — got a question for ya.
HOST: Go for it.
GUEST: Cracking screed under porcelain — what gives?
HOST: Mmm. Two things. Curing time, decoupling membrane.
EXPRESSIVENESS: 0.35 — technical, measured delivery"""

    class _CaptureChat:
        def __init__(self, *_a, **kw):
            self.system = kw.get("system_message", "")
        def with_model(self, *_a, **_kw):
            return self
        async def send_message(self, msg):
            # `msg` is a UserMessage. We capture its text to assert
            # the Q&A answer was passed in as authoritative context.
            captured_topic["text"] = getattr(msg, "text", str(msg))
            return canned_tt

    fake_db = _FakeDB(qa_doc)
    with patch.object(radio_studio, "get_db", return_value=fake_db), \
         patch("emergentintegrations.llm.chat.LlmChat", _CaptureChat), \
         patch("emergentintegrations.llm.chat.UserMessage", new=lambda text="": type("M", (), {"text": text})()):
        req = radio_studio.ConvertSegmentReq(source_id="qa-1", target_kind="trade_talk")
        result = await radio_studio.convert_segment(
            req, {"role": "super_admin", "email": "a@b"},
        )
    assert result["turns"]
    assert result["suggested_expressiveness"] == 0.35
    # The original answer must appear in the prompt sent to Claude
    # so the dialogue stays factually consistent.
    assert "28-day rule" in captured_topic["text"] or "decoupling membrane" in captured_topic["text"]


@pytest.mark.asyncio
async def test_convert_trade_talk_to_qa(monkeypatch):
    """A saved Trade Talk → single Q&A pair, fillers stripped."""
    monkeypatch.setenv("EMERGENT_LLM_KEY", "test-key")
    tt_doc = {
        "id": "tt-1",
        "kind": "trade_talk",
        "name": "Trade Talk: Screed cracking",
        "turns": [
            {"speaker": "host", "text": "Welcome back to Trade Talk."},
            {"speaker": "guest", "text": "Right, yeah — got cracking screed under porcelain."},
            {"speaker": "host", "text": "Mmm, classic one. Two causes: curing time and missing decoupling membrane."},
            {"speaker": "guest", "text": "Ah, gotcha — so 28 days?"},
            {"speaker": "host", "text": "Yeah, 28-day rule. We stock Mapei Mapelastic if you need a decoupler."},
        ],
    }
    canned_qa = """QUESTION: Why is my screed cracking under porcelain tiles?
ANSWER: Two causes. First, the screed wasn't cured for the full 28 days before tiling — the classic mistake. Second, you may have skipped a decoupling membrane on a flexible substrate. We stock Mapei Mapelastic for that exact problem."""

    fake_db = _FakeDB(tt_doc)
    with patch.object(radio_studio, "get_db", return_value=fake_db), \
         patch("emergentintegrations.llm.chat.LlmChat", FakeLlmChat._factory(canned_qa)), \
         patch("emergentintegrations.llm.chat.UserMessage", new=lambda text="": type("M", (), {"text": text})()):
        req = radio_studio.ConvertSegmentReq(source_id="tt-1", target_kind="qa")
        result = await radio_studio.convert_segment(
            req, {"role": "super_admin", "email": "a@b"},
        )
    assert result["question"].endswith("?")
    assert "screed" in result["question"].lower()
    assert "28-day" in result["answer"] or "decoupling" in result["answer"]
    # Filler words from the dialogue must be stripped
    for filler in ["mmm", "right, yeah", "ah, gotcha"]:
        assert filler not in result["answer"].lower(), f"Filler {filler!r} leaked into Q&A answer"


@pytest.mark.asyncio
async def test_convert_rejects_same_kind(monkeypatch):
    """Can't convert a Trade Talk to a Trade Talk (or Q&A to Q&A)."""
    monkeypatch.setenv("EMERGENT_LLM_KEY", "test-key")
    tt_doc = {"id": "tt-1", "kind": "trade_talk", "turns": [{"speaker": "host", "text": "Hi"}]}
    fake_db = _FakeDB(tt_doc)
    with patch.object(radio_studio, "get_db", return_value=fake_db):
        req = radio_studio.ConvertSegmentReq(source_id="tt-1", target_kind="trade_talk")
        with pytest.raises(Exception) as exc:
            await radio_studio.convert_segment(req, {"role": "super_admin", "email": "a@b"})
        assert "already a Trade Talk" in str(exc.value)


@pytest.mark.asyncio
async def test_convert_missing_source_returns_404(monkeypatch):
    """Convert against a non-existent id → 404."""
    monkeypatch.setenv("EMERGENT_LLM_KEY", "test-key")
    fake_db = _FakeDB(None)  # find_one returns None
    with patch.object(radio_studio, "get_db", return_value=fake_db):
        req = radio_studio.ConvertSegmentReq(source_id="nope", target_kind="qa")
        with pytest.raises(Exception) as exc:
            await radio_studio.convert_segment(req, {"role": "super_admin", "email": "a@b"})
        assert "not found" in str(exc.value).lower()

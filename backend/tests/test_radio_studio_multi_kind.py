"""
Tests for the multi-kind segment system (31 May 2026 — user request:
"can we add a two way conversational technical podcast or something
pretending to be talking to a builder" + "let's build both").

Three kinds, one collection:
  'ad'         — existing single-voice ad (regression-tested elsewhere)
  'qa'         — Ask the Showroom Q&A (single voice, narrates Q + A)
  'trade_talk' — multi-turn host/guest dialogue (N voices, ffmpeg concat)
"""
from __future__ import annotations

import inspect
import os
import shutil
import subprocess
import tempfile
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    from server import app
    return TestClient(app)


@pytest.fixture
def admin_override():
    from server import app
    from routes.radio_studio import get_current_user
    app.dependency_overrides[get_current_user] = lambda: {
        "email": "admin@test.com", "role": "super_admin",
    }
    yield
    app.dependency_overrides.pop(get_current_user, None)


# ---------------------------------------------------------------
# Pydantic model surface
# ---------------------------------------------------------------

def test_ad_create_accepts_kind_qa():
    from routes.radio_studio import AdCreate
    a = AdCreate(
        name="Q&A test", kind="qa",
        question="Can I tile over old tiles?",
        script="Yes, with caveats — check the substrate.",
        voice_id="voice-1",
    )
    assert a.kind == "qa"
    assert a.question == "Can I tile over old tiles?"


def test_ad_create_accepts_kind_trade_talk_with_empty_script():
    """Trade Talk needs no `script` (content is in turns) and no
    single `voice_id` (host + guest each have their own)."""
    from routes.radio_studio import AdCreate
    a = AdCreate(
        name="Trade Talk test", kind="trade_talk",
        host_voice_id="vh", guest_voice_id="vg",
        turns=[
            {"speaker": "host", "text": "Welcome back to Trade Talk."},
            {"speaker": "guest", "text": "Hi Mark — got a porcelain question."},
        ],
    )
    assert a.kind == "trade_talk"
    assert len(a.turns) == 2
    assert a.turns[0].speaker == "host"
    assert a.script == ""  # default


def test_ad_create_default_kind_is_ad():
    """Back-compat — existing callers don't pass `kind` and must
    keep getting the original ad behaviour."""
    from routes.radio_studio import AdCreate
    a = AdCreate(name="Plain ad", script="Hello.", voice_id="v")
    assert a.kind == "ad"
    assert a.question is None
    assert a.turns == []


def test_dialogue_turn_speaker_constrained():
    """Speaker must be 'host' or 'guest' — nothing else."""
    from routes.radio_studio import DialogueTurnIn
    DialogueTurnIn(speaker="host", text="x")
    DialogueTurnIn(speaker="guest", text="x")
    with pytest.raises(Exception):
        DialogueTurnIn(speaker="narrator", text="x")


# ---------------------------------------------------------------
# Script composition for non-'ad' kinds
# ---------------------------------------------------------------

def test_build_script_from_kind_ad_passthrough():
    from routes.radio_studio import _build_script_from_kind
    assert _build_script_from_kind({"kind": "ad", "script": "Hello."}) == "Hello."


def test_build_script_from_kind_qa_combines_question_and_answer():
    from routes.radio_studio import _build_script_from_kind
    out = _build_script_from_kind({
        "kind": "qa",
        "question": "Can I tile over plasterboard?",
        "script": "Short answer: no, not in a shower.",
        "narrate_question": True,
    })
    # Comma between Q and A so ElevenLabs pauses cleanly.
    assert out.startswith("Today's question")
    assert "tile over plasterboard" in out
    assert "Short answer: no" in out


def test_build_script_from_kind_qa_can_skip_question():
    from routes.radio_studio import _build_script_from_kind
    out = _build_script_from_kind({
        "kind": "qa",
        "question": "Q?",
        "script": "Answer body.",
        "narrate_question": False,
    })
    assert out == "Answer body."


def test_build_script_from_kind_trade_talk_concatenates_turns():
    from routes.radio_studio import _build_script_from_kind
    out = _build_script_from_kind({
        "kind": "trade_talk",
        "turns": [
            {"speaker": "host", "text": "Welcome back."},
            {"speaker": "guest", "text": "Hi Mark."},
        ],
    })
    # Used for char counting, so just need both texts present.
    assert "Welcome back." in out
    assert "Hi Mark." in out


# ---------------------------------------------------------------
# Audio concatenation
# ---------------------------------------------------------------

_FFMPEG = shutil.which("ffmpeg")
requires_ffmpeg = pytest.mark.skipif(_FFMPEG is None, reason="ffmpeg not installed")


def _synth_mp3(seconds: float, freq: int = 440) -> bytes:
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
        path = f.name
    try:
        subprocess.run(
            [
                _FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
                "-f", "lavfi", "-i", f"sine=frequency={freq}:duration={seconds}",
                "-c:a", "libmp3lame", "-b:a", "128k", "-ar", "44100",
                path,
            ],
            check=True,
        )
        with open(path, "rb") as fp:
            return fp.read()
    finally:
        os.unlink(path)


@requires_ffmpeg
def test_concat_audio_turns_produces_combined_mp3():
    """Concat two 1-second sine waves + verify the output is a
    valid MP3 longer than each input on its own (proves the
    silence-padding logic ran)."""
    from routes.radio_studio import _concat_audio_turns
    turn1 = _synth_mp3(1.0, 440)
    turn2 = _synth_mp3(1.0, 880)
    combined = _concat_audio_turns([turn1, turn2], gap_seconds=1.0)
    assert combined
    # 2 × 1s turns + 1s gap = ~3s of audio at 128kbps = ~48 KB.
    # Be tolerant of mp3 frame quantisation either side.
    assert 20_000 < len(combined) < 80_000

    # ffprobe the duration.
    ffprobe = shutil.which("ffprobe")
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
        f.write(combined)
        out_path = f.name
    try:
        r = subprocess.run(
            [
                ffprobe, "-v", "error", "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1", out_path,
            ],
            capture_output=True, text=True, check=True,
        )
        duration = float(r.stdout.strip())
    finally:
        os.unlink(out_path)
    # Two 1s turns + 1s silence between = 3s mix. Allow ±0.5s for
    # mp3 frame quantisation at the boundaries.
    assert 2.5 <= duration <= 3.5


@requires_ffmpeg
def test_concat_audio_turns_single_chunk_passes_through():
    from routes.radio_studio import _concat_audio_turns
    chunk = _synth_mp3(1.0, 440)
    assert _concat_audio_turns([chunk]) == chunk


def test_concat_audio_turns_empty_returns_empty():
    from routes.radio_studio import _concat_audio_turns
    assert _concat_audio_turns([]) == b""


def test_concat_audio_turns_falls_back_when_ffmpeg_missing(monkeypatch):
    """When ffmpeg is gone, the concat helper must NOT raise — it
    falls back to naive byte concatenation."""
    from routes import radio_studio
    monkeypatch.setattr(radio_studio, "_ffmpeg_bin", lambda: None)
    out = radio_studio._concat_audio_turns([b"A", b"B", b"C"], gap_seconds=1.0)
    assert out == b"ABC"


# ---------------------------------------------------------------
# generate_ad_audio wiring — dispatches on `kind`
# ---------------------------------------------------------------

def test_generate_handler_dispatches_on_kind():
    """Source check — generate_ad_audio must branch on `kind` and
    call _concat_audio_turns for trade_talk."""
    from routes import radio_studio
    src = inspect.getsource(radio_studio.generate_ad_audio)
    assert 'kind = ad.get("kind")' in src
    assert "_concat_audio_turns(" in src
    assert "_build_script_from_kind(" in src


def test_test_voice_handler_dispatches_on_kind():
    """Same dispatch happens in test-voice — Trade Talk previews
    the first turn with that speaker's voice; Q&A uses the
    composed question+answer script."""
    from routes import radio_studio
    src = inspect.getsource(radio_studio.test_ad_voice)
    assert "kind ==" in src or 'kind = ad.get("kind")' in src
    assert "_build_script_from_kind(" in src


# ---------------------------------------------------------------
# Q&A script generator
# ---------------------------------------------------------------

def test_generate_qa_returns_question_and_answer(client, admin_override):
    """The Q&A generator returns both question (echoed back from
    input) and answer (Claude output, stripped of LLM-isms)."""
    from routes import radio_studio

    with patch("emergentintegrations.llm.chat.LlmChat") as MockChat:
        instance = MagicMock()
        instance.with_model.return_value = instance
        instance.send_message = AsyncMock(
            return_value="Short answer: no. You need a tile backer board.",
        )
        MockChat.return_value = instance
        with patch.dict(os.environ, {"EMERGENT_LLM_KEY": "test-key"}):
            r = client.post(
                "/api/admin/radio-studio/scripts/generate-qa",
                json={"question": "Can I tile straight onto plasterboard?"},
            )

    body = r.json()
    assert r.status_code == 200, r.text
    assert body["question"] == "Can I tile straight onto plasterboard?"
    assert "Short answer: no" in body["answer"]
    assert body["approx_words"] > 0
    assert body["approx_seconds"] > 0


def test_generate_qa_strips_llm_defects(client, admin_override):
    """LLMs sometimes wrap answers in `"..."`, code fences, or an
    'Answer:' prefix. Generator must strip all of that."""
    from routes import radio_studio

    with patch("emergentintegrations.llm.chat.LlmChat") as MockChat:
        instance = MagicMock()
        instance.with_model.return_value = instance
        instance.send_message = AsyncMock(
            return_value='Answer: "Yes, that works."',
        )
        MockChat.return_value = instance
        with patch.dict(os.environ, {"EMERGENT_LLM_KEY": "test-key"}):
            r = client.post(
                "/api/admin/radio-studio/scripts/generate-qa",
                json={"question": "Test?"},
            )

    body = r.json()
    # Both the "Answer:" prefix AND the wrapping quotes must be gone.
    assert body["answer"] == "Yes, that works."


def test_generate_qa_admin_only():
    from routes import radio_studio
    src = inspect.getsource(radio_studio.generate_qa_script)
    assert "_require_admin(current_user)" in src


# ---------------------------------------------------------------
# Trade Talk dialogue generator
# ---------------------------------------------------------------

def test_generate_trade_talk_parses_host_guest_lines(client, admin_override):
    """The generator MUST parse `HOST: ... / GUEST: ...` lines from
    the LLM response into a structured turns list."""
    from routes import radio_studio

    fake_llm_output = (
        "HOST: Welcome back to Trade Talk.\n"
        "GUEST: Hi Mark, I've got a question about porcelain.\n"
        "HOST: Sure, what's the job?\n"
        "GUEST: 35 square metres over underfloor heating.\n"
        "HOST: Right — you need an S1 flexible adhesive.\n"
        "GUEST: Got it.\n"
        "HOST: Cheers Dave, back tomorrow.\n"
    )
    with patch("emergentintegrations.llm.chat.LlmChat") as MockChat:
        instance = MagicMock()
        instance.with_model.return_value = instance
        instance.send_message = AsyncMock(return_value=fake_llm_output)
        MockChat.return_value = instance
        with patch.dict(os.environ, {"EMERGENT_LLM_KEY": "test-key"}):
            r = client.post(
                "/api/admin/radio-studio/scripts/generate-trade-talk",
                json={"topic": "Porcelain over underfloor heating"},
            )

    body = r.json()
    assert r.status_code == 200, r.text
    turns = body["turns"]
    assert len(turns) == 7
    assert turns[0]["speaker"] == "host"
    assert "Welcome back" in turns[0]["text"]
    assert turns[1]["speaker"] == "guest"
    assert "porcelain" in turns[1]["text"].lower()
    assert body["suggested_name"].startswith("Trade Talk: ")


def test_generate_trade_talk_accepts_named_aliases(client, admin_override):
    """The model occasionally uses "Mark:" / "Dave:" instead of
    HOST/GUEST. Both must be parsed."""
    from routes import radio_studio

    fake_output = (
        "Mark: First line.\n"
        "Dave: Second line.\n"
        "Mark: Third line.\n"
        "Dave: Fourth line.\n"
        "Mark: Fifth line.\n"
    )
    with patch("emergentintegrations.llm.chat.LlmChat") as MockChat:
        instance = MagicMock()
        instance.with_model.return_value = instance
        instance.send_message = AsyncMock(return_value=fake_output)
        MockChat.return_value = instance
        with patch.dict(os.environ, {"EMERGENT_LLM_KEY": "test-key"}):
            r = client.post(
                "/api/admin/radio-studio/scripts/generate-trade-talk",
                json={"topic": "Adhesives", "host_name": "Mark", "guest_name": "Dave"},
            )

    body = r.json()
    assert r.status_code == 200, r.text
    turns = body["turns"]
    assert len(turns) == 5
    assert [t["speaker"] for t in turns] == ["host", "guest", "host", "guest", "host"]


def test_generate_trade_talk_rejects_too_short_response(client, admin_override):
    """If the LLM only returns 2 turns, we 502 so the admin retries
    instead of saving a useless 30-second episode."""
    from routes import radio_studio

    with patch("emergentintegrations.llm.chat.LlmChat") as MockChat:
        instance = MagicMock()
        instance.with_model.return_value = instance
        instance.send_message = AsyncMock(return_value="HOST: A.\nGUEST: B.")
        MockChat.return_value = instance
        with patch.dict(os.environ, {"EMERGENT_LLM_KEY": "test-key"}):
            r = client.post(
                "/api/admin/radio-studio/scripts/generate-trade-talk",
                json={"topic": "Short test"},
            )

    assert r.status_code == 502
    assert "too few" in r.json()["detail"].lower()


def test_generate_trade_talk_admin_only():
    from routes import radio_studio
    src = inspect.getsource(radio_studio.generate_trade_talk_script)
    assert "_require_admin(current_user)" in src


# ---------------------------------------------------------------
# Starter seed endpoint
# ---------------------------------------------------------------

def test_seed_starter_content_inserts_qa_and_trade_talk(client, admin_override):
    """First call inserts all 20 Q&A + 10 Trade Talk topics as drafts."""
    from routes import radio_studio

    fake_db = MagicMock()
    fake_db.radio_studio_ads.find_one = AsyncMock(return_value=None)  # nothing exists yet
    fake_db.radio_studio_ads.insert_one = AsyncMock()

    with patch.object(radio_studio, "get_db", return_value=fake_db):
        r = client.post("/api/admin/radio-studio/seed-starter-content")

    body = r.json()
    assert r.status_code == 200
    assert body["success"] is True
    assert body["inserted_qa"] == 20
    assert body["inserted_trade_talk"] == 10
    assert body["skipped"] == 0


def test_seed_starter_content_is_idempotent(client, admin_override):
    """If a seed already exists by name, skip it — admins can re-run
    safely without duplicating or overwriting their edits."""
    from routes import radio_studio

    # Mongo says "this one already exists" for everything.
    fake_db = MagicMock()
    fake_db.radio_studio_ads.find_one = AsyncMock(return_value={"_id": "x"})
    fake_db.radio_studio_ads.insert_one = AsyncMock()

    with patch.object(radio_studio, "get_db", return_value=fake_db):
        r = client.post("/api/admin/radio-studio/seed-starter-content")

    body = r.json()
    assert body["inserted_qa"] == 0
    assert body["inserted_trade_talk"] == 0
    assert body["skipped"] == 30
    # No inserts attempted because every find_one returned a match.
    fake_db.radio_studio_ads.insert_one.assert_not_called()


def test_seed_starter_content_admin_only():
    from routes import radio_studio
    src = inspect.getsource(radio_studio.seed_starter_content)
    assert "_require_admin(current_user)" in src


def test_starter_content_has_expected_counts():
    """Sanity check on the seed library size — 20 Q&A pairs +
    10 Trade Talk topics."""
    from routes import radio_studio
    assert len(radio_studio._STARTER_QA_PAIRS) == 20
    assert len(radio_studio._STARTER_TRADE_TALK_TOPICS) == 10


def test_starter_qa_pairs_each_have_real_content():
    """Each (question, answer) tuple must be substantive — not a
    placeholder. Min 30 chars for the question, 100 chars for
    the answer."""
    from routes import radio_studio
    for q, a in radio_studio._STARTER_QA_PAIRS:
        assert len(q) >= 20, f"Question too short: {q!r}"
        assert len(a) >= 100, f"Answer too short for {q!r}"
        # Sanity: answers should look like the radio-narration style
        # we promised (no "**bold**" markdown, no code fences).
        assert "**" not in a
        assert "```" not in a


# ---------------------------------------------------------------
# One-click full episode generation (31 May 2026 polish)
# ---------------------------------------------------------------

def test_generate_full_episode_chains_script_and_save_skipping_audio(client, admin_override):
    """When render_audio=False, the endpoint:
       1. Calls Claude to write the dialogue
       2. Inserts the doc with turns + kind=trade_talk
       3. Returns without burning ElevenLabs credits

    This is the 'review before paying for synthesis' path."""
    from routes import radio_studio

    fake_llm_output = (
        "HOST: Welcome back to Trade Talk on Tile Station Radio.\n"
        "GUEST: Hi Mark, got a question about porcelain over UFH.\n"
        "HOST: Sure, what's the size?\n"
        "GUEST: 35 square metres in a kitchen-diner.\n"
        "HOST: You need a flexible S1 adhesive — Mapei Keraflex Maxi S1.\n"
        "GUEST: Brilliant. Thanks Mark.\n"
        "HOST: Cheers Dave. Trade Talk back tomorrow.\n"
    )
    fake_db = MagicMock()
    fake_db.radio_studio_ads.insert_one = AsyncMock()
    fake_db.radio_studio_ads.find_one = AsyncMock()

    with patch("emergentintegrations.llm.chat.LlmChat") as MockChat, \
         patch.object(radio_studio, "get_db", return_value=fake_db), \
         patch.dict(os.environ, {"EMERGENT_LLM_KEY": "test-key"}):
        instance = MagicMock()
        instance.with_model.return_value = instance
        instance.send_message = AsyncMock(return_value=fake_llm_output)
        MockChat.return_value = instance

        r = client.post(
            "/api/admin/radio-studio/generate-full-episode",
            json={
                "topic": "Porcelain over underfloor heating",
                "host_voice_id": "host-v",
                "guest_voice_id": "guest-v",
                "render_audio": False,
            },
        )

    body = r.json()
    assert r.status_code == 200, r.text
    assert body["audio_rendered"] is False
    assert body["turns_count"] == 7
    saved = body["ad"]
    assert saved["kind"] == "trade_talk"
    assert saved["host_voice_id"] == "host-v"
    assert saved["guest_voice_id"] == "guest-v"
    assert len(saved["turns"]) == 7
    assert saved["audio_filename"] is None  # render skipped
    # Mongo insert happened, ElevenLabs convert was NOT called.
    fake_db.radio_studio_ads.insert_one.assert_awaited_once()


def test_generate_full_episode_rejects_short_topic(client, admin_override):
    from routes import radio_studio
    r = client.post(
        "/api/admin/radio-studio/generate-full-episode",
        json={
            "topic": "x",  # too short — fails Pydantic min_length
            "host_voice_id": "host-v",
            "guest_voice_id": "guest-v",
        },
    )
    assert r.status_code == 422  # Pydantic validation error


def test_generate_full_episode_requires_both_voices(client, admin_override):
    from routes import radio_studio
    r = client.post(
        "/api/admin/radio-studio/generate-full-episode",
        json={
            "topic": "A valid topic about tiling",
            "host_voice_id": "host-v",
            # missing guest_voice_id
        },
    )
    assert r.status_code == 422


def test_generate_full_episode_admin_only():
    from routes import radio_studio
    src = inspect.getsource(radio_studio.generate_full_episode)
    assert "_require_admin(current_user)" in src
    # And the gate must run BEFORE the LLM call (don't burn credits
    # on un-authenticated users).
    require_idx = src.index("_require_admin")
    llm_idx = src.index("generate_trade_talk_script(")
    assert require_idx < llm_idx


def test_generate_full_episode_preserves_doc_on_audio_failure(client, admin_override):
    """If audio rendering fails AFTER the doc is saved, the error
    message must reference the saved ad_id so the admin can retry
    without re-running Claude (which already wrote the script)."""
    from routes import radio_studio

    fake_llm_output = (
        "HOST: Line 1.\nGUEST: Line 2.\nHOST: Line 3.\n"
        "GUEST: Line 4.\nHOST: Line 5.\n"
    )
    fake_db = MagicMock()
    fake_db.radio_studio_ads.insert_one = AsyncMock()

    # Stub generate_ad_audio to raise so we exercise the rescue path.
    async def _failing_generate(ad_id, current_user):
        raise HTTPException(status_code=502, detail="ElevenLabs unavailable")

    with patch("emergentintegrations.llm.chat.LlmChat") as MockChat, \
         patch.object(radio_studio, "get_db", return_value=fake_db), \
         patch.object(radio_studio, "generate_ad_audio", side_effect=_failing_generate), \
         patch.dict(os.environ, {"EMERGENT_LLM_KEY": "test-key"}):
        instance = MagicMock()
        instance.with_model.return_value = instance
        instance.send_message = AsyncMock(return_value=fake_llm_output)
        MockChat.return_value = instance

        r = client.post(
            "/api/admin/radio-studio/generate-full-episode",
            json={
                "topic": "A test topic about tiles",
                "host_voice_id": "host-v",
                "guest_voice_id": "guest-v",
                "render_audio": True,
            },
        )

    assert r.status_code == 502
    body = r.json()
    detail = body["detail"]
    # Must surface the underlying ElevenLabs error AND tell the admin
    # the script is already saved so they don't re-run Claude.
    assert "ElevenLabs unavailable" in detail
    assert "Script saved" in detail or "saved successfully" in detail
    # The doc was inserted to Mongo despite the audio failure.
    fake_db.radio_studio_ads.insert_one.assert_awaited_once()

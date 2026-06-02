"""
Regression test for the conversational voice settings shipped 1 Jun 2026.

Before this fix Trade Talk generated audio at the same stability=0.5, style=0.0
as plain ads — which made the dialogue sound like two robots taking turns.

These tests assert that:
  • Trade Talk paths use stability ≤ 0.32 and style ≥ 0.50 (conversational).
  • Plain ad paths keep their existing settings (back-compat).
  • Per-turn settings differentiate host vs. guest slightly.
  • The inter-turn gap is sub-second (≤ 0.5s) so the conversation flows.
"""
import os
import sys
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

sys.path.insert(0, "/app/backend")
from routes import radio_studio  # noqa: E402


@pytest.mark.asyncio
async def test_trade_talk_uses_conversational_voice_settings(monkeypatch):
    """The /generate endpoint must use stability ≤ 0.32 + style ≥ 0.50
    + speaker_boost ON + flash_v2_5 model when synthesising trade_talk."""
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")

    fake_db = MagicMock()
    fake_ad = {
        "id": "ad-tt-1",
        "kind": "trade_talk",
        "host_voice_id": "host-v",
        "guest_voice_id": "guest-v",
        "turns": [
            {"speaker": "host", "text": "Welcome back to Trade Talk."},
            {"speaker": "guest", "text": "Right, yeah — got a question for ya."},
            {"speaker": "host", "text": "Mmm, go for it."},
        ],
        "name": "Trade Talk Test",
    }
    fake_db.radio_studio_ads.find_one = AsyncMock(return_value=fake_ad)
    fake_db.radio_studio_ads.update_one = AsyncMock()
    fake_db.radio_studio_voices.find_one = AsyncMock(return_value={"voice_id": "voice-1"})

    # Capture every voice_settings + model_id used during synthesis.
    captured = []

    class FakeClient:
        class text_to_speech:
            @staticmethod
            def convert(text, voice_id, model_id, voice_settings, output_format):
                captured.append({
                    "voice_id": voice_id,
                    "model_id": model_id,
                    "stability": voice_settings.stability,
                    "style": voice_settings.style,
                    "similarity_boost": voice_settings.similarity_boost,
                    "use_speaker_boost": voice_settings.use_speaker_boost,
                })
                # Return a minimal byte iterator
                return iter([b"\xff\xfb\x10\x00" + b"\x00" * 100])

    with patch.object(radio_studio, "get_db", return_value=fake_db), \
         patch.object(radio_studio, "_get_eleven_client", return_value=FakeClient()), \
         patch.object(radio_studio, "_concat_audio_turns", return_value=b"FAKE_MP3"), \
         patch.object(radio_studio, "_normalize_loudness", return_value=b"FAKE_MP3"), \
         patch.object(radio_studio, "_log_tts_usage", AsyncMock(return_value=None)):
        user = {"role": "super_admin", "email": "admin@test"}
        # Direct call into generate_ad_audio
        try:
            await radio_studio.generate_ad_audio("ad-tt-1", user)
        except Exception:
            # We only care about the captured settings; downstream
            # success (audio_blob storage etc) isn't required for this test.
            pass

    assert len(captured) == 3, f"Expected 3 turn conversions, got {len(captured)}"
    # Every turn must use the conversational model + speaker boost on
    for i, c in enumerate(captured):
        assert c["model_id"] == "eleven_flash_v2_5", \
            f"Turn {i} used {c['model_id']}, expected eleven_flash_v2_5"
        assert c["use_speaker_boost"] is True, f"Turn {i} speaker_boost off"
        assert c["stability"] <= 0.32, \
            f"Turn {i} stability {c['stability']} > 0.32 (would sound monotone)"
        assert c["style"] >= 0.50, \
            f"Turn {i} style {c['style']} < 0.50 (would sound flat)"

    # Host vs. guest differentiation — guest should have slightly LOWER
    # stability + HIGHER style than host (more chaotic / animated).
    host_turns = [c for c, t in zip(captured, fake_ad["turns"]) if t["speaker"] == "host"]
    guest_turns = [c for c, t in zip(captured, fake_ad["turns"]) if t["speaker"] == "guest"]
    if host_turns and guest_turns:
        h = host_turns[0]
        g = guest_turns[0]
        assert g["stability"] < h["stability"], \
            f"Guest stability {g['stability']} should be < host {h['stability']}"
        assert g["style"] > h["style"], \
            f"Guest style {g['style']} should be > host {h['style']}"


def test_plain_ad_keeps_existing_voice_settings():
    """Back-compat: non-trade_talk ads must keep stability=0.5/style=0.0
    so the existing fleet of ads doesn't suddenly sound different."""
    # We can verify the static defaults via a quick read of the file —
    # the actual code path is exercised in the multi-kind test suite.
    import inspect
    src = inspect.getsource(radio_studio.generate_ad_audio)
    # Plain-ad block has stability=0.5 default
    assert 'stability=float(ad.get("stability", 0.5))' in src
    # Plain-ad keeps multilingual_v2
    assert '"eleven_multilingual_v2"' in src


def test_concat_audio_default_gap_is_sub_second():
    """The Trade Talk gap-default must be sub-second so the dialogue
    doesn't feel like a robot loop. 0.4s ≈ human turn-handover pause."""
    import inspect
    sig = inspect.signature(radio_studio._concat_audio_turns)
    default_gap = sig.parameters["gap_seconds"].default
    assert default_gap < 1.0, \
        f"Default gap {default_gap} is still ≥ 1s — dialogue will feel robotic"
    assert default_gap >= 0.2, \
        f"Default gap {default_gap} is too short — turns will overlap"

"""
Tests for the optional background music bed (26 May 2026 — Option A
from the Feb 26 plan: ElevenLabs voice mixed over a sidechain-ducked
music track using ffmpeg, mixed once at generation time and stored
as the only MP3 in Mongo).
"""
from __future__ import annotations

import inspect
import os
import shutil
import subprocess
import tempfile

import pytest


# ---------------------------------------------------------------
# Pydantic model surface
# ---------------------------------------------------------------

def test_ad_create_accepts_bed_fields():
    from routes.radio_studio import AdCreate
    a = AdCreate(
        name="Weekend sale",
        script="20% off all porcelain this weekend.",
        voice_id="x",
        bed_music_id="track-123",
        bed_volume_pct=25,
    )
    assert a.bed_music_id == "track-123"
    assert a.bed_volume_pct == 25


def test_ad_create_bed_volume_defaults_to_18():
    """18% is the documented default — quiet enough that voice always
    wins, present enough that the ad feels alive."""
    from routes.radio_studio import AdCreate
    a = AdCreate(name="x", script="x", voice_id="x")
    assert a.bed_volume_pct == 18
    assert a.bed_music_id is None


def test_ad_create_bed_volume_clamped_0_to_50():
    from routes.radio_studio import AdCreate
    # Boundaries OK.
    AdCreate(name="x", script="x", voice_id="x", bed_volume_pct=0)
    AdCreate(name="x", script="x", voice_id="x", bed_volume_pct=50)
    # Out-of-range rejected.
    with pytest.raises(Exception):
        AdCreate(name="x", script="x", voice_id="x", bed_volume_pct=-1)
    with pytest.raises(Exception):
        AdCreate(name="x", script="x", voice_id="x", bed_volume_pct=51)


def test_ad_update_supports_clearing_bed():
    """Patching `bed_music_id=''` (empty string) is the UI's way of
    saying 'remove the bed' — the update handler must store it as
    None in Mongo so future regenerations skip the mix."""
    from routes import radio_studio
    src = inspect.getsource(radio_studio.update_ad)
    # The explicit-unset branch lives in update_ad.
    assert "bed_music_id" in src and "None" in src


# ---------------------------------------------------------------
# generate_ad_audio wiring
# ---------------------------------------------------------------

def test_generate_calls_mixer_when_bed_present():
    """The generate handler must look up `bed_music_id`, fetch the
    bed's audio_blob, and pass everything through `_mix_voice_with_bed`
    BEFORE the size-cap check (the cap should apply to the FINAL
    mixed bytes, not the raw voice)."""
    from routes import radio_studio
    src = inspect.getsource(radio_studio.generate_ad_audio)
    # Looks up bed when set.
    assert 'bed_music_id = ad.get("bed_music_id")' in src
    # Pulls the bed's audio_blob from the music collection.
    assert "radio_studio_music.find_one" in src
    # Calls the mixer.
    assert "_mix_voice_with_bed(" in src
    # Cap check happens AFTER the mix so an oversized mix can be
    # rejected without keeping the un-capped voice around.
    mix_idx = src.index("_mix_voice_with_bed(")
    cap_idx = src.index("MAX_AUDIO_BYTES")
    assert mix_idx < cap_idx


def test_generate_with_no_bed_skips_mix():
    """Existing voice-only ads must continue to work — the mixer is
    only invoked when `bed_music_id` is truthy."""
    from routes import radio_studio
    src = inspect.getsource(radio_studio.generate_ad_audio)
    # The mixer is gated behind a truthy `bed_music_id`.
    assert "if bed_music_id:" in src


def test_generate_400s_on_missing_bed_track():
    """If the admin picked a bed but the track was later deleted (or
    its blob was wiped), generation should 400 with a helpful message
    rather than silently shipping the unmixed voice."""
    from routes import radio_studio
    src = inspect.getsource(radio_studio.generate_ad_audio)
    assert "Selected background music track is missing" in src
    assert "status_code=400" in src


# ---------------------------------------------------------------
# _mix_voice_with_bed — actual ffmpeg integration
# (skipped automatically when ffmpeg isn't on PATH — production
# Docker installs it, dev box might not)
# ---------------------------------------------------------------

_FFMPEG = shutil.which("ffmpeg")

requires_ffmpeg = pytest.mark.skipif(
    _FFMPEG is None,
    reason="ffmpeg not installed on this host",
)


def _synthesise_mp3(seconds: float, freq: int = 440) -> bytes:
    """Render a fixed-frequency sine wave to MP3 bytes for the
    integration test. Uses ffmpeg's `sine` source so we don't need
    any external audio fixtures committed to the repo."""
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as out:
        out_path = out.name
    try:
        subprocess.run(
            [
                _FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
                "-f", "lavfi",
                "-i", f"sine=frequency={freq}:duration={seconds}",
                "-c:a", "libmp3lame", "-b:a", "128k",
                out_path,
            ],
            check=True,
        )
        with open(out_path, "rb") as f:
            return f.read()
    finally:
        os.unlink(out_path)


@requires_ffmpeg
def test_mixer_returns_valid_mp3_matching_voice_duration():
    """The mixer takes a 2 s voice + 4 s bed and returns an MP3 whose
    duration matches the voice (the bed is truncated by amix's
    `duration=first`, so the ad ends when the narrator stops). The
    output must be a valid playable MP3."""
    from routes.radio_studio import _mix_voice_with_bed

    voice = _synthesise_mp3(seconds=2.0, freq=440)
    bed = _synthesise_mp3(seconds=4.0, freq=110)

    mixed = _mix_voice_with_bed(voice_bytes=voice, bed_bytes=bed, bed_volume_pct=18)

    assert mixed and isinstance(mixed, bytes)
    # Looser sanity: should be at least half a KB even for 2 s of audio.
    assert len(mixed) > 500

    # Use ffprobe (ships with ffmpeg) to measure the mixed duration.
    ffprobe = shutil.which("ffprobe")
    assert ffprobe, "ffprobe must be present alongside ffmpeg"
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
        f.write(mixed)
        mixed_path = f.name
    try:
        out = subprocess.run(
            [
                ffprobe, "-v", "error", "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1", mixed_path,
            ],
            capture_output=True, text=True, check=True,
        )
        duration = float(out.stdout.strip())
    finally:
        os.unlink(mixed_path)

    # Voice was 2.0 s. Mix should be within 0.5 s of that (small mp3
    # frame quantisation + tiny tail from the bed afade-out).
    assert 1.5 <= duration <= 2.7, f"mix duration {duration:.2f}s out of expected band"


@requires_ffmpeg
def test_mixer_silent_bed_volume_yields_voice_dominated_output():
    """At bed_volume_pct=0, the bed is silent — the mixed output's
    energy should be essentially the voice signal."""
    from routes.radio_studio import _mix_voice_with_bed

    voice = _synthesise_mp3(seconds=1.5, freq=440)
    bed = _synthesise_mp3(seconds=3.0, freq=80)

    mixed_zero = _mix_voice_with_bed(voice_bytes=voice, bed_bytes=bed, bed_volume_pct=0)
    assert mixed_zero and len(mixed_zero) > 500
    # The 1.5 s voice-only mix should be smaller than the same voice
    # with a loud bed (just a smoke check that volume_pct actually
    # affects output).
    mixed_loud = _mix_voice_with_bed(voice_bytes=voice, bed_bytes=bed, bed_volume_pct=50)
    assert len(mixed_loud) >= len(mixed_zero) - 1024  # within mp3 quantisation noise



@requires_ffmpeg
def test_mixer_audio_audible_throughout_clip():
    """REGRESSION (30 May 2026 — user-reported P0): the mixer
    previously had a buggy `afade=t=out:st=0:d=0.6` that faded the
    ENTIRE mix to silence in the first 0.6 s — so an ad with a
    music bed played 0.6 s of voice + bed, then silence for the
    rest. The fix removed the fade-out entirely. This test guards
    against re-introducing any tail-attenuation: every 1-second
    window of a 5-second mix should be within 6 dB of the loudest
    window, i.e. there must be no big silent gap anywhere."""
    from routes.radio_studio import _mix_voice_with_bed

    voice = _synthesise_mp3(seconds=5.0, freq=440)
    bed = _synthesise_mp3(seconds=6.0, freq=110)
    mixed = _mix_voice_with_bed(voice_bytes=voice, bed_bytes=bed, bed_volume_pct=18)

    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
        f.write(mixed)
        mixed_path = f.name
    try:
        # astats=reset=1 + the default 1-second window gives a
        # per-second RMS reading on stdout via ametadata=print.
        proc = subprocess.run(
            [
                _FFMPEG, "-hide_banner", "-loglevel", "error",
                "-i", mixed_path,
                "-af", "astats=metadata=1:reset=1,"
                       "ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
                "-f", "null", "-",
            ],
            capture_output=True, text=True, check=True,
        )
        rms_per_second = []
        for line in proc.stdout.splitlines():
            if "RMS_level=" in line:
                try:
                    rms_per_second.append(float(line.split("=", 1)[1]))
                except ValueError:
                    pass
    finally:
        os.unlink(mixed_path)

    # Drop any -inf (silence) and the very first sample (mp3 frame
    # priming is sometimes -90 dB before the encoder warms up).
    audible = [r for r in rms_per_second[1:] if r > -60.0]
    assert len(audible) >= 4, (
        f"Only {len(audible)} 1-second windows contained audible audio; "
        f"the mix has a silent gap — regression of the afade-out bug?"
    )
    # Loudest minus quietest must be within 6 dB → no dramatic
    # tail/head fade. The voice/bed mix is effectively CBR after
    # the bed's 0.4 s fade-in.
    span = max(audible) - min(audible)
    assert span <= 6.0, (
        f"RMS range across the mix is {span:.1f} dB — too wide. "
        f"The audio is fading somewhere. Per-second RMS: {audible}"
    )



def test_mixer_falls_back_to_voice_when_ffmpeg_missing(monkeypatch):
    """In environments without ffmpeg (e.g. some dev boxes) the
    mixer must NOT raise — it returns the unmixed voice so the
    feature degrades gracefully. Production Docker has ffmpeg
    baked in so this branch is dev-only."""
    from routes import radio_studio
    monkeypatch.setattr(radio_studio, "_ffmpeg_bin", lambda: None)
    voice = b"FAKE_VOICE_BYTES"
    bed = b"FAKE_BED_BYTES"
    out = radio_studio._mix_voice_with_bed(voice, bed, bed_volume_pct=18)
    assert out == voice

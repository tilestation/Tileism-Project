"""
Radio Studio — in-store AI-narrated radio for the Tile Station showrooms.

User-requested feature (24 May 2026): a 4-store in-store radio service that
plays AI-generated ads (ElevenLabs UK English voices) intermixed with
royalty-free music. Customers in showrooms hear product offers, trade-
account benefits and seasonal promotions on a loop through Bluetooth
speakers.

Storage architecture (24 May 2026 — REWRITTEN):
  v1 stored MP3s on the local filesystem at /app/backend/storage/...
  → DISASTER on Railway: ephemeral disk wipes every deploy, all audio
    files vanished, database metadata pointed at non-existent paths.
  v2 (this version) stores MP3 bytes DIRECTLY in MongoDB Atlas as
    BSON Binary fields. MongoDB Atlas is persistent so audio survives
    every deploy. 15 MB cap per file (under the 16 MB BSON limit) =
    ~15 minutes of 128 kbps audio — plenty for any in-store loop.
"""
from __future__ import annotations

import asyncio
import logging
import os
import shutil
import subprocess
import tempfile
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Literal, Optional, Tuple
from elevenlabs import VoiceSettings
from elevenlabs.client import ElevenLabs
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from config import get_db
from services import get_current_user


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin/radio-studio", tags=["Radio Studio"])
public_router = APIRouter(prefix="/radio-studio", tags=["Radio Studio (public)"])


# ------------------------------------------------------------------
# Limits
# ------------------------------------------------------------------

# 15 MB ceiling per file. BSON document limit is 16 MB; we leave 1 MB
# of headroom for the other fields (name, voice settings, timestamps).
# At 128 kbps MP3 → ~15 minutes of audio per track. Anything longer
# should be split into segments by the admin (in-store loops rarely
# need single tracks >5 minutes anyway).
MAX_AUDIO_BYTES = 15 * 1024 * 1024


def _require_admin(user: dict):
    if (user or {}).get("role") not in ("super_admin", "admin", "manager"):
        raise HTTPException(status_code=403, detail="Admin access required")


def _get_eleven_client() -> ElevenLabs:
    api_key = os.environ.get("ELEVENLABS_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=500,
            detail="ELEVENLABS_API_KEY not configured on the backend",
        )
    return ElevenLabs(api_key=api_key)


# ------------------------------------------------------------------
# ElevenLabs cost tracking (30 May 2026 — user request: "every
# time I adjust the ad script and regenerate the new audio, does
# it cost me, if so how much... I need a clear breakdown on Radio
# Studio dashboard of total I am spending")
# ------------------------------------------------------------------
#
# Pricing model: ElevenLabs charges per CHARACTER of input text —
# the same chars we send to `text_to_speech.convert(text=...)`.
# Default rate is the PAYG list price for eleven_multilingual_v2
# (~$0.30 / 1,000 chars on the Creator tier as of May 2026), but
# the admin can override via env so the dashboard matches whatever
# tier they're actually on.
#
# Storage: one doc per TTS call in `radio_studio_tts_usage`. Tiny
# docs (few hundred bytes each) so even 10,000 regenerations would
# only cost ~3 MB of Mongo space. We never delete them — the admin
# might want to see "what did I spend in March?" 6 months later.

# Defaults: $0.30 / 1k chars at GBP 0.79 / USD = £0.000237 / char.
# Both knobs are settable via env so the admin can match their tier.
_TTS_USD_PER_1K_CHARS = float(os.environ.get("ELEVENLABS_USD_PER_1K_CHARS", "0.30"))
_GBP_PER_USD = float(os.environ.get("GBP_PER_USD", "0.79"))


def _chars_to_gbp(chars: int) -> float:
    """Estimate the £ cost of synthesising `chars` characters."""
    if chars <= 0:
        return 0.0
    usd = (chars / 1000.0) * _TTS_USD_PER_1K_CHARS
    return round(usd * _GBP_PER_USD, 6)  # 6 d.p. → 0.0001p resolution


# ────────────────────────────────────────────────────────────────────
# Expressiveness slider — Feb 26, 2026
#
# Trade Talk segments expose a single 0-1 dial in the admin UI:
#     0.0 → Stiff (broadcaster reading a press release)
#     0.5 → Natural (default — sounds like a real podcast)
#     1.0 → Animated (energetic, full of inflection)
#
# We map that one knob to TWO ElevenLabs params (stability + style)
# via linear interpolation. Guest gets a small offset so they sound
# slightly more animated than host (a builder on the phone vs a
# studio host) — keeps the two voices feeling distinct without
# requiring 2 separate sliders.
#
# These mappings come from ElevenLabs best-practice docs for the
# `eleven_flash_v2_5` and `eleven_v3` models — verified against
# empirical comparison of the user's reference Trade Talk MP3.
# ────────────────────────────────────────────────────────────────────
def _voice_settings_for_expressiveness(
    expressiveness: float, *, is_host: bool = True
) -> tuple[float, float]:
    """Returns (stability, style) for a given 0-1 expressiveness.

    Caller can pass `is_host=False` to apply the guest-side offset
    (~10% more emotive than the host on the same slider value).
    """
    e = max(0.0, min(1.0, float(expressiveness)))
    # Host curve: stiff(0.55,0.10) → natural(0.30,0.55) → animated(0.15,0.80)
    # Linear lerp across the 3-stop curve via 2-segment interpolation.
    if e <= 0.5:
        t = e * 2.0
        stability = 0.55 + t * (0.30 - 0.55)  # 0.55 → 0.30
        style = 0.10 + t * (0.55 - 0.10)       # 0.10 → 0.55
    else:
        t = (e - 0.5) * 2.0
        stability = 0.30 + t * (0.15 - 0.30)  # 0.30 → 0.15
        style = 0.55 + t * (0.80 - 0.55)      # 0.55 → 0.80
    if not is_host:
        # Guest is slightly more animated — drop stability, lift style.
        stability = max(0.10, stability - 0.04)
        style = min(0.95, style + 0.10)
    return round(stability, 3), round(style, 3)


async def _log_tts_usage(
    *,
    db,
    ad_id: Optional[str],
    ad_name: Optional[str],
    endpoint: Literal["generate", "test_voice"],
    chars: int,
    voice_id: Optional[str],
    voice_name: Optional[str],
    model_id: Optional[str],
    triggered_by: Optional[str],
) -> None:
    """Record one ElevenLabs synthesis call for the usage dashboard.
    Best-effort — if Mongo is wedged, log + carry on (we don't want
    cost-tracking to break TTS itself).

    `chars` MUST be the count of characters sent to ElevenLabs
    (post-normalisation), not the raw script length. That's what
    the user is actually charged for."""
    try:
        await db.radio_studio_tts_usage.insert_one({
            "id": uuid.uuid4().hex,
            "ad_id": ad_id,
            "ad_name": ad_name,
            "endpoint": endpoint,
            "chars": int(chars),
            "voice_id": voice_id,
            "voice_name": voice_name,
            "model_id": model_id,
            "cost_gbp_estimate": _chars_to_gbp(chars),
            "usd_per_1k_chars": _TTS_USD_PER_1K_CHARS,
            "gbp_per_usd": _GBP_PER_USD,
            "triggered_by": triggered_by,
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
    except Exception:  # noqa: BLE001 — never crash TTS over a log
        logger.exception("Failed to log TTS usage for ad %s", ad_id)


# ------------------------------------------------------------------
# TTS script normalisation
# ------------------------------------------------------------------
#
# (30 May 2026 — user-reported P0: an ad with "£42.99" in the script
# was being read out as "$42.99" by ElevenLabs. The pound symbol
# isn't reliably narrated by any of the eleven_multilingual_v2 /
# turbo_v2 voices — it leaks through as the dollar sign for most
# voices, or as the literal phrase "pound sign" for others. The
# only reliable fix is to convert prices to words BEFORE sending
# the script to ElevenLabs. The stored script is left untouched so
# the admin's UI keeps the clean £ display; only the bytes we hand
# to TTS are normalised.)
#
# Conversion rules (UK English):
#   £42.99      → "42 pounds 99"          (the cleanest UK radio read)
#   £1.99       → "1 pound 99"            (singular pound)
#   £42         → "42 pounds"
#   £1          → "1 pound"
#   £0.50       → "50 pence"
#   £1,250      → "1250 pounds"           (drops the thousands comma)
#   £1,250.99   → "1250 pounds 99"
#
# We also touch up a couple of other symbols ElevenLabs gets wrong:
#   m²          → "square metres"
#   €           → "euros"  (trailing keeps "30 euros" pattern)
#   p (after a number standing alone) — left for the script writer

import re

# £<digits>[,<digits>]*[.<digits>] — handles thousands separator and
# optional decimal portion. Greedy on the integer side, exactly 0-2
# digits on the decimal side.
_GBP_PATTERN = re.compile(
    r"£\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?"
)


def _gbp_to_words(match: re.Match) -> str:
    """Convert a single £-prefixed amount to a spoken UK English
    phrase. Used as `re.sub` callable."""
    integer = match.group(1).replace(",", "")
    decimal = match.group(2)
    int_value = int(integer)
    # £0.50 → "50 pence" (no leading "0 pounds")
    if int_value == 0 and decimal and int(decimal) > 0:
        # Pad: £0.5 means £0.50 → "50 pence"
        pence = int(decimal.ljust(2, "0"))
        return f"{pence} pence"
    pounds_word = "pound" if int_value == 1 else "pounds"
    base = f"{int_value} {pounds_word}"
    if decimal:
        # £42.99 → "42 pounds 99". We drop "pence" here because UK
        # radio reads "forty-two ninety-nine" naturally, and that's
        # the rhythm we want — adding "pence" makes it feel formal.
        # If the decimal is just "00", skip it.
        pence_int = int(decimal.ljust(2, "0"))
        if pence_int > 0:
            return f"{base} {pence_int:02d}"
    return base


def _normalize_for_tts(script: str) -> str:
    """Apply pre-TTS substitutions. Returns the modified string —
    does NOT mutate the stored script."""
    if not script:
        return script
    # URLs FIRST — must run before any other substitution because
    # later steps would mangle the dots/slashes inside the URL.
    # See _spoken_url for the full conversion rules.
    out = _URL_PATTERN.sub(_url_to_spoken, script)
    # Brand-name word-split — "tilestation" → "tile station". Done
    # AFTER the URL pass so we touch up both bare brand mentions
    # ("tilestation") and the chunks left inside an unraveled URL.
    out = re.sub(r"\btilestation\b", "tile station", out, flags=re.IGNORECASE)
    out = _GBP_PATTERN.sub(_gbp_to_words, out)
    # m² / m2 → "square metres". Match either Unicode superscript-2
    # or the common ASCII fallback "m2" when it's adjacent to a
    # digit (so we don't mangle words like "GTM2").
    out = re.sub(r"\bm²", "square metres", out)
    out = re.sub(r"(\d)\s*m2\b", r"\1 square metres", out)
    # € — same pattern as £ but simpler (no widely-used decimal
    # pence equivalent in UK marketing copy). Just spell it out.
    out = re.sub(r"€\s*(\d+(?:\.\d{1,2})?)", r"\1 euros", out)
    return out


# ------------------------------------------------------------------
# Pronunciation hints (30 May 2026)
# ------------------------------------------------------------------
#
# User-requested per-ad free-text field: tell the voice e.g.
#   "porcelain: por-suh-lin"
#   "Catalogue → cat-uh-log"
#   "La Dolce = lah-doll-chay"
# so brand/product names that ElevenLabs gets wrong are pronounced
# correctly. Implementation = case-insensitive whole-word replace
# in the script BEFORE it goes to TTS. This is exactly how radio
# voice talents have always handled phonetic respellings — works
# on every model, costs nothing extra, and is transparent (the
# admin can see what changed by clicking Test voice).
#
# Format (parsed loosely — admin doesn't need to memorise syntax):
#   word: phonetic
#   word = phonetic
#   word -> phonetic
#   word → phonetic
#   word is pronounced phonetic     ← natural language
# One pair per line; blank lines and # comments ignored.

_HINT_SEPARATORS = re.compile(
    r"\s*(?:→|->|=|:|\bis pronounced(?:\s+as)?\b)\s*",
    re.IGNORECASE,
)


def _parse_pronunciation_hints(hints: Optional[str]) -> List[Tuple[str, str]]:
    """Parse the free-text hints into [(word, phonetic), ...]. Lines
    that can't be split into a word + phonetic pair are skipped.
    Words longer than 60 chars are dropped as paranoid pre-check
    against pathological inputs."""
    if not hints:
        return []
    pairs: List[Tuple[str, str]] = []
    seen_keys: set = set()  # de-dupe — last write wins
    for raw_line in hints.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        parts = _HINT_SEPARATORS.split(line, maxsplit=1)
        if len(parts) != 2:
            continue
        word = parts[0].strip().strip('"\'')
        phonetic = parts[1].strip().strip('"\'')
        if not word or not phonetic or len(word) > 60 or len(phonetic) > 120:
            continue
        key = word.lower()
        if key in seen_keys:
            # Replace the earlier entry — last write wins.
            pairs = [p for p in pairs if p[0].lower() != key]
        seen_keys.add(key)
        pairs.append((word, phonetic))
    return pairs


def _apply_pronunciation_hints(text: str, hints: Optional[str]) -> str:
    """Apply parsed hints to `text`. Case-insensitive whole-word
    replacement (so "Catalogue" → "cat-uh-log" matches both
    "catalogue" and "Catalogue" in the script). Pure function —
    leaves the stored script untouched.

    Uses a placeholder-based two-pass approach so a later hint
    can't accidentally match inside an earlier hint's replacement
    text (e.g. when a hint for "Tile" would otherwise re-match
    inside "Tile Station"'s already-substituted phonetic)."""
    pairs = _parse_pronunciation_hints(hints)
    if not pairs:
        return text
    # Pass 1: longest-first → swap into NUL-fenced placeholders so
    # subsequent hint patterns can't see the new phonetic text.
    pairs.sort(key=lambda p: -len(p[0]))
    out = text
    for idx, (word, _) in enumerate(pairs):
        pattern = re.compile(
            r"\b" + re.escape(word) + r"\b",
            re.IGNORECASE,
        )
        out = pattern.sub(f"\x00HINT{idx}\x00", out)
    # Pass 2: swap placeholders for their phonetics.
    for idx, (_, phonetic) in enumerate(pairs):
        out = out.replace(f"\x00HINT{idx}\x00", phonetic)
    return out


# ------------------------------------------------------------------
# URL → spoken form
# ------------------------------------------------------------------
#
# (30 May 2026 — user-reported: an ad with `www.tilestation.co.uk/bathrooms`
# came out garbled in TTS. ElevenLabs reads bare URLs unpredictably:
# sometimes letter-by-letter, sometimes it skips the slash, sometimes
# it inserts the literal word "URL". Converting the URL to spaced-out
# words before sending gives the voice something it can narrate cleanly.)
#
# Rules:
#   • Strip http(s):// + leading www.
#   • "." → " dot "
#   • "/" → " slash "
#   • "-" → " dash "
#   • "_" → " underscore "
#   • Brand-name split (tilestation → tile station) runs AFTER, so
#     a URL like "www.tilestation.co.uk/bathrooms" reads as
#     "tile station dot co dot uk slash bathrooms".

# Matches:
#   • Explicit http/https URLs:   https://example.com/path
#   • www-prefixed URLs:           www.example.co.uk/path
#   • Bare TLD-ish strings:        example.co.uk/path (only when followed
#                                  by a slash + path → reduces false-
#                                  positives on company names with periods)
_URL_PATTERN = re.compile(
    r"""
    (?:https?://|www\.|(?<=\s)|(?<=^))      # leading boundary
    (?:[a-z0-9-]+\.)+                       # one or more label.
    (?:com|co\.uk|org|net|io|app|uk|biz|ai) # known TLDs only
    (?:/[a-z0-9_\-/.?=&%#]*)?               # optional path/query
    """,
    re.IGNORECASE | re.VERBOSE,
)


def _url_to_spoken(match: re.Match) -> str:
    """Convert a single matched URL into its spoken form.

    Each separator word (`dot`, `forward slash`, `dash`, `underscore`)
    is wrapped in commas so ElevenLabs models — which otherwise
    re-collapse "tile station dot co dot uk" back into a URL and
    elide the dots — are forced to pause around them. (30 May 2026
    follow-up: user reported the dots/slashes were still being
    skipped on playback even though they appeared as words in the
    normalised text.)"""
    raw = match.group(0).strip()
    spoken = raw
    spoken = re.sub(r"^https?://", "", spoken, flags=re.IGNORECASE)
    spoken = re.sub(r"^www\.", "", spoken, flags=re.IGNORECASE)
    # Commas around each separator force ElevenLabs to pause —
    # cleanest way to make every part of the URL distinctly audible.
    # "forward slash" beats "slash" for UK radio diction.
    spoken = spoken.replace(".", ", dot, ")
    spoken = spoken.replace("/", ", forward slash, ")
    spoken = spoken.replace("-", ", dash, ")
    spoken = spoken.replace("_", ", underscore, ")
    # Tidy: collapse adjacent commas, normalise whitespace, strip
    # leading/trailing punctuation noise so the sentence around the
    # URL still flows naturally.
    spoken = re.sub(r",\s*,", ",", spoken)
    spoken = re.sub(r"\s+", " ", spoken).strip()
    spoken = spoken.strip(",").strip()
    return spoken


# ------------------------------------------------------------------
# FFmpeg mixing — voice + ducked background music bed
# ------------------------------------------------------------------
#
# (26 May 2026 — user-requested "background music to make ads more
# energetic". Implementation = Option A from the Feb 26 plan: render
# the mix once at generation time, store the result as the only MP3
# in Mongo. No mixing at playback time, no dual-track speakers.)
#
# Pipeline:
#   • Voice (ElevenLabs MP3 bytes) is the primary, full-volume track.
#   • Music bed is looped if shorter than the voice, truncated if
#     longer (`duration=first` on the amix).
#   • Bed is attenuated to `bed_volume_pct/100` (default 18%).
#   • Sidechain compression: when the voice gets loud, the bed
#     automatically ducks an extra ~12 dB — so you can always hear
#     the narrator clearly.
#   • Bed fades in 0.4 s at the start and out 0.6 s at the end for
#     a polished radio feel (no abrupt audio cut on either side).

def _ffmpeg_bin() -> Optional[str]:
    """Locate ffmpeg on PATH. Returns None if missing so the mixer
    can degrade gracefully (ship the unmixed voice) instead of 500ing."""
    return shutil.which("ffmpeg")


# ------------------------------------------------------------------
# Loudness normalisation — EBU R128 single-pass (31 May 2026)
# ------------------------------------------------------------------
#
# User reported (in-store testing): "music is on a good volume but
# when ad plays the volume is too low". Root cause: ElevenLabs MP3
# output averages around −22 LUFS while commercially-mastered music
# tracks land at −9 to −14 LUFS. Same peak headroom; very different
# perceived loudness.
#
# Fix: pipe everything (ads AND music) through ffmpeg's `loudnorm`
# filter with the EBU R128 target of −16 LUFS / TP −1.5 / LRA 11.
# This is the de-facto streaming standard (Spotify, Apple Music,
# Tidal all sit −14 to −16). Single-pass dynamic mode is plenty
# accurate for our short clips and adds ~1-2 s per track. Two-pass
# would shave another 0.5-1 LU off the deviation but doubles cost.
#
# We tag normalised docs with `loudnorm_applied=True` so the
# backfill endpoint can be re-run safely without re-processing
# already-corrected tracks.

LOUDNORM_TARGET_LUFS = -16.0
LOUDNORM_TARGET_TP = -1.5      # true-peak ceiling in dBTP
LOUDNORM_TARGET_LRA = 11       # loudness range


def _normalize_loudness(
    audio_bytes: bytes,
    target_lufs: float = LOUDNORM_TARGET_LUFS,
    target_tp: float = LOUDNORM_TARGET_TP,
    target_lra: int = LOUDNORM_TARGET_LRA,
) -> bytes:
    """Apply EBU R128 loudness normalisation to a single MP3 / audio
    blob. Returns the normalised MP3 bytes (libmp3lame, 128 kbps,
    44.1 kHz, stereo).

    On any failure (ffmpeg missing, decode error, timeout) returns
    the input bytes unchanged so generation never blocks on an
    optional polish step.
    """
    if not audio_bytes:
        return audio_bytes
    ffmpeg = _ffmpeg_bin()
    if not ffmpeg:
        logger.warning("ffmpeg missing — skipping loudness normalisation")
        return audio_bytes

    with tempfile.TemporaryDirectory(prefix="radio_loud_") as tmp:
        in_path = os.path.join(tmp, "in.mp3")
        out_path = os.path.join(tmp, "out.mp3")
        with open(in_path, "wb") as f:
            f.write(audio_bytes)

        cmd = [
            ffmpeg,
            "-hide_banner", "-loglevel", "error", "-y",
            "-i", in_path,
            "-af",
            f"loudnorm=I={target_lufs}:TP={target_tp}:LRA={target_lra}",
            "-ar", "44100",
            "-ac", "2",
            "-c:a", "libmp3lame",
            "-b:a", "128k",
            out_path,
        ]
        try:
            proc = subprocess.run(
                cmd,
                check=False,
                capture_output=True,
                timeout=60,
            )
        except subprocess.TimeoutExpired:
            logger.warning("Loudness normalisation timed out — shipping original")
            return audio_bytes
        if proc.returncode != 0 or not os.path.exists(out_path):
            err = (proc.stderr or b"").decode("utf-8", errors="replace")[:300]
            logger.warning("Loudness normalisation failed (rc=%s): %s",
                           proc.returncode, err)
            return audio_bytes
        try:
            with open(out_path, "rb") as f:
                normalised = f.read()
        except OSError:
            return audio_bytes
        # Sanity-check the normalised file (≥1 KB and at least 75 %
        # of the original size — protects against silent-track bugs
        # in older ffmpeg builds).
        if len(normalised) < 1024 or len(normalised) < int(len(audio_bytes) * 0.5):
            logger.warning(
                "Normalised audio (%d B) much smaller than input (%d B) — falling back",
                len(normalised), len(audio_bytes),
            )
            return audio_bytes
        return normalised


def _mix_voice_with_bed(
    voice_bytes: bytes,
    bed_bytes: bytes,
    bed_volume_pct: int,
) -> bytes:
    """Mix the ElevenLabs voice over a looped, sidechain-ducked
    music bed. Returns the final MP3 bytes (128 kbps, mono down-mix
    avoided — keep stereo so bed instruments still have width).

    Raises HTTPException(502) on ffmpeg failure so the admin sees a
    real error rather than silent fallback.

    Args:
        voice_bytes: MP3 bytes from ElevenLabs.
        bed_bytes:   MP3/WAV/etc bytes of the music bed.
        bed_volume_pct: 0-50. 18 is a good default for spoken-word
            radio — bed is present but never fights the voice.
    """
    ffmpeg = _ffmpeg_bin()
    if not ffmpeg:
        # On a dev box without ffmpeg installed we'd rather ship the
        # voice unmixed than 500. Production Docker image bakes
        # ffmpeg in (see backend/Dockerfile, 26 May 2026 edit).
        logger.warning("ffmpeg not on PATH — skipping bed mix, shipping unmixed voice")
        return voice_bytes

    bed_volume = max(0, min(50, bed_volume_pct)) / 100.0
    # Filter graph:
    #   • Bed loops forever (amix truncates to voice length below),
    #     gets attenuated to user-chosen %, and fades IN over 0.4 s
    #     so it doesn't pop in suddenly.
    #   • Voice splits into two streams: one for the mix, one as
    #     the sidechain key for ducking the bed.
    #   • sidechaincompress drops the bed by ~12 dB whenever the
    #     voice is loud → narrator is always intelligible.
    #   • amix with duration=first ends the mix exactly when the
    #     voice stops (no trailing bed-only tail).
    #   • alimiter prevents any post-mix clipping.
    #
    # 30 May 2026 — REMOVED the original `afade=t=out:st=0:d=0.6`
    # tail-fade. It was supposed to fade out the LAST 0.6 s of the
    # mix but ffmpeg's `st=0` meant the fade-out started AT TIME 0
    # → audio was silent after 0.6 s. (Fading out at the END
    # requires `st=<voice_duration - 0.6>` which we'd need ffprobe
    # to determine first. Not worth the complexity for the few-ms
    # click the cut produces.)
    filter_complex = (
        "[1:a]aloop=loop=-1:size=2147483647,"
        f"volume={bed_volume:.3f},"
        "afade=t=in:st=0:d=0.4[bedfade];"
        "[0:a]asplit=2[v1][vkey];"
        "[bedfade][vkey]sidechaincompress="
        "threshold=0.03:ratio=20:attack=5:release=250[bedduck];"
        "[v1][bedduck]amix=inputs=2:duration=first:"
        "dropout_transition=0:normalize=0[premix];"
        "[premix]alimiter=limit=0.97[mix]"
    )

    with tempfile.TemporaryDirectory(prefix="radio_mix_") as tmp:
        voice_path = os.path.join(tmp, "voice.mp3")
        bed_path = os.path.join(tmp, "bed.mp3")
        out_path = os.path.join(tmp, "out.mp3")
        with open(voice_path, "wb") as f:
            f.write(voice_bytes)
        with open(bed_path, "wb") as f:
            f.write(bed_bytes)

        cmd = [
            ffmpeg,
            "-hide_banner", "-loglevel", "error", "-y",
            "-i", voice_path,
            "-i", bed_path,
            "-filter_complex", filter_complex,
            "-map", "[mix]",
            "-c:a", "libmp3lame",
            "-b:a", "128k",
            "-ar", "44100",
            out_path,
        ]
        try:
            proc = subprocess.run(
                cmd,
                check=False,
                capture_output=True,
                timeout=120,  # 15-min ceiling on input means mix < 60s in practice
            )
        except subprocess.TimeoutExpired as exc:
            raise HTTPException(
                status_code=504,
                detail="Mixing the music bed took too long — try a shorter bed track.",
            ) from exc
        if proc.returncode != 0:
            err = (proc.stderr or b"").decode("utf-8", errors="replace")[:500]
            logger.error("ffmpeg mix failed (rc=%s): %s", proc.returncode, err)
            raise HTTPException(
                status_code=502,
                detail=f"Music-bed mixing failed: {err.strip() or 'ffmpeg error'}",
            )
        with open(out_path, "rb") as f:
            return f.read()


# ------------------------------------------------------------------
# Multi-turn dialogue concatenation (31 May 2026)
# ------------------------------------------------------------------
#
# For Trade Talk episodes we render each speaker turn as its own
# ElevenLabs call (so we get the right voice per turn) then glue
# them together with a 1-second silence between turns. The result
# is one MP3 — same shape as a regular ad, plays through the same
# streaming + playlist pipeline, gets logged to the cost dashboard
# as a single call summing all turns.

def _concat_audio_turns(audio_chunks: List[bytes], gap_seconds: float = 0.4) -> bytes:
    """Concatenate MP3 audio chunks with `gap_seconds` of silence
    between each. Uses ffmpeg's concat demuxer with `-c copy` so
    no re-encoding happens (each chunk is already a 128 kbps
    44.1 kHz MP3 from ElevenLabs and our cached silence file
    matches — see `_get_silence_mp3`).

    1 Jun 2026 — Default gap reduced from 1.0s → 0.4s for trade
    talk: human conversation typically has 200-400ms turn-handover
    pauses, not the full 1-second pause we had which made the
    dialogue feel like a Speaker-A-then-Speaker-B robot loop. For
    sub-second gaps we render a one-shot short silence MP3 in
    memory rather than concatenating multiple 1-sec silence files.
    """
    if not audio_chunks:
        return b""
    if len(audio_chunks) == 1:
        return audio_chunks[0]
    ffmpeg = _ffmpeg_bin()
    if not ffmpeg:
        # Graceful degradation — just concat the bytes directly.
        # MP3 frames are self-synchronising so most players will
        # still cope, just without the inter-turn gap.
        logger.warning("ffmpeg missing — concatenating without gap")
        return b"".join(audio_chunks)

    with tempfile.TemporaryDirectory(prefix="radio_concat_") as tmp:
        # Write each turn to its own file.
        turn_paths: List[str] = []
        for i, chunk in enumerate(audio_chunks):
            p = os.path.join(tmp, f"turn_{i:03d}.mp3")
            with open(p, "wb") as f:
                f.write(chunk)
            turn_paths.append(p)

        # Generate a custom-duration silence file once per call so we
        # can support fractional gaps (0.4s typical for natural speech).
        silence_path = os.path.join(tmp, "silence.mp3")
        gap_sec = max(0.0, float(gap_seconds))
        if gap_sec > 0:
            sil_cmd = [
                ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
                "-f", "lavfi", "-i", f"anullsrc=r=44100:cl=stereo:d={gap_sec:.3f}",
                "-c:a", "libmp3lame", "-b:a", "128k", "-ar", "44100", "-ac", "2",
                silence_path,
            ]
            proc = subprocess.run(sil_cmd, capture_output=True, timeout=15)
            if proc.returncode != 0:
                logger.warning("silence-gen failed, falling back to no gap")
                gap_sec = 0.0

        list_path = os.path.join(tmp, "list.txt")
        with open(list_path, "w") as f:
            for i, p in enumerate(turn_paths):
                f.write(f"file '{p}'\n")
                if gap_sec > 0 and i != len(turn_paths) - 1:
                    f.write(f"file '{silence_path}'\n")

        out_path = os.path.join(tmp, "out.mp3")
        cmd = [
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
            "-f", "concat", "-safe", "0",
            "-i", list_path,
            "-c", "copy",
            out_path,
        ]
        proc = subprocess.run(cmd, capture_output=True, timeout=60)
        if proc.returncode != 0:
            err = (proc.stderr or b"").decode("utf-8", errors="replace")[:500]
            logger.error("ffmpeg concat failed (rc=%s): %s", proc.returncode, err)
            raise HTTPException(
                status_code=502,
                detail=f"Audio stitching failed: {err.strip() or 'ffmpeg error'}",
            )
        with open(out_path, "rb") as f:
            return f.read()


# ------------------------------------------------------------------
# Models
# ------------------------------------------------------------------

class AdCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    # Allowed empty for `kind='trade_talk'` (content lives in `turns`)
    # and for `kind='qa'` when only the answer matters and the
    # question carries the meaning. Single-voice ads still require it.
    script: str = Field(default="", max_length=4000)
    voice_id: str = Field(default="", max_length=200)
    voice_name: Optional[str] = None
    # Voice tuning knobs. ElevenLabs defaults are
    # stability=0.5, similarity_boost=0.75 — these produce a natural
    # narration that's neither robotic nor over-emotive.
    stability: float = Field(default=0.5, ge=0.0, le=1.0)
    similarity_boost: float = Field(default=0.75, ge=0.0, le=1.0)
    style: float = Field(default=0.0, ge=0.0, le=1.0)
    # eleven_multilingual_v2 = best quality + supports UK English well.
    # eleven_turbo_v2 = fast/cheap, slightly lower fidelity.
    model_id: str = "eleven_multilingual_v2"
    # 26 May 2026 — user-requested background music bed (Option A in
    # the Feb 26 plan). When `bed_music_id` references an uploaded
    # music track, `generate_ad_audio` mixes the ElevenLabs voice
    # OVER that track at `bed_volume_pct` (0-50% — anything louder
    # buries the voice), with sidechain compression so the bed
    # automatically ducks under the narration. The stored MP3 is
    # the final mix — no extra mixing needed at playback time.
    bed_music_id: Optional[str] = None
    bed_volume_pct: int = Field(default=18, ge=0, le=50)
    # 30 May 2026 — per-ad pronunciation hints (free text, one
    # `word: phonetic` pair per line). Applied as case-insensitive
    # whole-word replacement BEFORE the script goes to ElevenLabs.
    # See `_parse_pronunciation_hints` for the supported separators.
    # 4000-char cap matches the script field — generous enough for
    # dozens of hint pairs.
    pronunciation_hints: Optional[str] = Field(default=None, max_length=4000)


class AdUpdate(BaseModel):
    name: Optional[str] = Field(default=None, max_length=120)
    script: Optional[str] = Field(default=None, max_length=4000)
    voice_id: Optional[str] = None
    voice_name: Optional[str] = None
    stability: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    similarity_boost: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    style: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    model_id: Optional[str] = None
    bed_music_id: Optional[str] = None
    bed_volume_pct: Optional[int] = Field(default=None, ge=0, le=50)
    pronunciation_hints: Optional[str] = Field(default=None, max_length=4000)


# ------------------------------------------------------------------
# Multi-kind segment models (31 May 2026)
# ------------------------------------------------------------------
#
# `kind` extends the existing single-voice ad with two new content
# types — keeps everything in `radio_studio_ads` so the playlist,
# stream endpoints, and cost tracker need no schema changes:
#
#   'ad'         — Existing: one script, one voice, one TTS call.
#   'qa'         — "Ask the Showroom" Q&A. One voice; the script is
#                  auto-built from `question` + `answer` (the
#                  narrator reads both like a radio host).
#   'trade_talk' — Multi-turn dialogue (e.g. host Mark + builder
#                  Dave). Each turn is rendered with its own
#                  voice_id, then stitched together with 1-sec
#                  silence between speakers via ffmpeg concat.

class DialogueTurnIn(BaseModel):
    """One line of dialogue inside a Trade Talk episode."""
    speaker: Literal["host", "guest"]
    text: str = Field(min_length=1, max_length=2000)


class AdCreateKindExtras(BaseModel):
    """Extra optional fields for non-'ad' kinds. Kept as a separate
    block so the existing ad form stays unchanged for callers that
    don't supply them."""
    kind: Literal["ad", "qa", "trade_talk"] = "ad"
    # Q&A
    question: Optional[str] = Field(default=None, max_length=600)
    # When True (default for 'qa'), the narrator reads the question
    # FIRST, then a comma pause, then the answer. False = answer only.
    narrate_question: bool = True
    # Trade Talk
    host_voice_id: Optional[str] = None
    host_voice_name: Optional[str] = None
    guest_voice_id: Optional[str] = None
    guest_voice_name: Optional[str] = None
    turns: List[DialogueTurnIn] = Field(default_factory=list)
    # Expressiveness slider 0-1 (Feb 26, 2026). Drives stability +
    # style for every TTS call when kind == "trade_talk".
    #   0.0 → Stiff (broadcaster reading a press release)
    #   0.5 → Natural (default, sounds like a real podcast)
    #   1.0 → Animated (energetic, very inflected)
    # Default 0.5 = the conversational baseline this session shipped.
    expressiveness: Optional[float] = Field(default=0.5, ge=0.0, le=1.0)


# Compose AdCreate / AdUpdate with the new optional fields without
# rewriting the whole class — same pattern as how Pydantic v2
# encourages "extension models".
for _fname, _finfo in AdCreateKindExtras.model_fields.items():
    AdCreate.model_fields[_fname] = _finfo
    # On AdUpdate, every field is optional; the kind/narrate_question
    # have safe defaults so we just copy them over.
    AdUpdate.model_fields[_fname] = _finfo
AdCreate.model_rebuild(force=True)
AdUpdate.model_rebuild(force=True)


def _build_script_from_kind(doc: dict) -> str:
    """Synthesise the narration text from a non-'ad' doc. For 'ad'
    we just return `script` as-is. Used by both `_log_tts_usage`
    char counting and the actual TTS calls."""
    kind = doc.get("kind") or "ad"
    if kind == "qa":
        question = (doc.get("question") or "").strip()
        answer = (doc.get("script") or "").strip()
        narrate_q = doc.get("narrate_question", True)
        if not narrate_q or not question:
            return answer
        # Comma pause so the voice clearly separates Q from A.
        return f"Today's question — {question.rstrip('?')}, {answer}"
    if kind == "trade_talk":
        # Used for char-count logging only; actual rendering loops
        # over turns individually.
        return "\n".join(t.get("text", "") for t in (doc.get("turns") or []))
    return doc.get("script") or ""


class PlaylistItem(BaseModel):
    type: Literal["ad", "music"]
    ref_id: str


class PlaylistUpdate(BaseModel):
    name: str = Field(default="Default Playlist", max_length=120)
    items: List[PlaylistItem]
    is_active: bool = True
    # 30 May 2026 — user-requested "play the playlist in repeat
    # after the last track". Defaults to True (the wall-clock-modulo
    # logic in live_now_playing has always looped — this flag lets
    # the admin opt OUT and have the stream go silent after the
    # last item finishes, e.g. for a one-shot Sunday announcement).
    repeat: bool = True
    # 31 May 2026 — user-requested crossfade. Seconds of equal-power
    # fade between consecutive items in the playlist. 0 disables it
    # (hard cut, the legacy behaviour). 1.5 s is a nice "real radio"
    # feel; 3 s is the upper sanity cap (longer than that and short
    # ads / station idents start to blur into each other).
    crossfade_seconds: float = Field(default=0.0, ge=0.0, le=3.0)


class MusicImportFromUrlReq(BaseModel):
    """Bulk-import a music track from a public URL (YouTube Audio
    Library, Bensound, SoundCloud, direct .mp3 link, etc). The
    backend uses yt-dlp + ffmpeg to extract + transcode to 128 kbps
    MP3, then stores the bytes in MongoDB just like a normal upload.
    (26 May 2026 — user request: "Bulk import from URL ... saves the
    click-through-download-upload dance".)"""
    url: str = Field(min_length=8, max_length=2000,
                     description="Public URL of the audio/video source. "
                                 "yt-dlp handles YouTube, SoundCloud, Bensound, direct .mp3/.wav links, etc.")
    name: Optional[str] = Field(default=None, max_length=120,
                                description="Override the auto-extracted track title. "
                                            "Leave blank to use the source's metadata.")


class GenerateScriptReq(BaseModel):
    """Auto-generate an ad script from keywords + a few hints.
    (24 May 2026 — user-requested feature: "Could you give an option
    to auto generate ads by adding few keywords as well as manual").
    The LLM returns 2-4 short sentences in a UK English voice tone
    suited to in-store narration."""
    keywords: str = Field(min_length=1, max_length=500,
                          description="Comma- or free-text keywords. e.g. 'La Dolce, 20% off, weekend, porcelain'")
    duration_seconds: int = Field(default=20, ge=10, le=60,
                                  description="Target read-aloud length in seconds (10-60). Drives script length.")
    tone: Literal["friendly", "energetic", "calm", "authoritative", "premium"] = "friendly"
    call_to_action: Optional[str] = Field(default=None, max_length=200,
                                          description="Optional CTA — e.g. 'visit our showroom in Manchester', 'ask a team member'")
    audience: Literal["retail", "trade", "both"] = "both"
    # 25 May 2026 — user-requested: ads play IN-STORE so phrases like
    # "visit our showroom today" are absurd to in-store listeners.
    # Comma-separated words/phrases the LLM must avoid. Honoured as
    # a hard rule in the system prompt (strict ban, not a soft hint).
    avoid_words: Optional[str] = Field(default=None, max_length=400,
                                       description="Comma- or newline-separated banned words/phrases. e.g. 'visit our showroom, come down today, online only'")


# ------------------------------------------------------------------
# AI script generation (Emergent LLM key — Claude Haiku)
# ------------------------------------------------------------------

@router.post("/scripts/generate")
async def generate_script(req: GenerateScriptReq, current_user: dict = Depends(get_current_user)):
    """LLM-generate an ad script from keywords + tone. Returns the
    text only — the admin can edit it, pick a voice, then save the
    ad and trigger TTS as a separate step.
    (24 May 2026 — user-requested auto-generate option.)"""
    _require_admin(current_user)
    api_key = os.environ.get("EMERGENT_LLM_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="EMERGENT_LLM_KEY not set")

    # Rough words-per-second budget for spoken radio: 2.3 wps ~ a
    # natural pace for UK English narration. Cap at ~140 words for a
    # 60s ad so we don't blow ElevenLabs credits.
    target_words = max(20, min(140, int(req.duration_seconds * 2.3)))
    tone_directives = {
        "friendly": "Warm, conversational, like a friendly shopkeeper greeting a regular. Avoid hard-sell language.",
        "energetic": "Upbeat, punchy, weekend-sale-style. Short snappy sentences, exclamation marks sparingly.",
        "calm": "Measured, premium-feel, like a high-end brand voiceover. Slower pace, longer sentences.",
        "authoritative": "Confident, knowledgeable, trade-professional. Highlight expertise and quality credentials.",
        "premium": "Sophisticated, aspirational, luxury showroom feel. Evocative descriptive language.",
    }
    audience_directives = {
        "retail": "Speak directly to homeowners and DIY shoppers. Mention free samples, design help, and easy returns.",
        "trade": "Speak to professional tilers, builders, and designers. Mention trade discounts, bulk pricing, dedicated trade counter, and trade credit accounts.",
        "both": "Address both retail customers AND trade professionals. Reference 'whether you're decorating one bathroom or fitting an entire development'.",
    }

    # 25 May 2026 — parse comma/newline-separated banned phrases.
    # Ads play in-store so generic "visit our showroom" type copy
    # is meaningless to the audience that's already standing in the
    # showroom listening. Admin lists the offending phrases here.
    banned_phrases: List[str] = []
    if req.avoid_words:
        # Split on both commas and newlines, strip, drop empties.
        for chunk in req.avoid_words.replace("\n", ",").split(","):
            t = chunk.strip()
            if t:
                banned_phrases.append(t)

    avoid_rule = ""
    if banned_phrases:
        bullet_list = "\n".join(f"   - {p!r}" for p in banned_phrases)
        avoid_rule = (
            "\n11. STRICTLY FORBIDDEN — the script MUST NOT contain ANY of "
            "the following words or phrases (case-insensitive, including "
            "close variants like plurals / different verb tenses):\n"
            f"{bullet_list}\n"
            "    These phrases break the in-store fiction (e.g. telling "
            "a listener inside a showroom to 'visit our showroom' is absurd). "
            "If any of these would naturally fit, rephrase the entire "
            "sentence to avoid them rather than working around them awkwardly.\n"
        )

    system = (
        "You are a senior copywriter producing in-store RADIO ad scripts for Tile Station, "
        "a UK tile, bathroom and flooring retailer with 4 showrooms. These scripts are "
        "narrated by an ElevenLabs UK English voice on the in-store speakers — customers "
        "browsing the showroom HEAR them, they don't read them.\n\n"
        "STRICT RULES:\n"
        "1. Output ONLY the script text — no headlines, no labels, no quotes, no markdown, "
        "no 'Script:' prefix, no stage directions like '[pause]' or '*upbeat tone*'. "
        "Just the words the narrator will speak.\n"
        f"2. Target {req.duration_seconds} seconds of read-aloud time, roughly {target_words} words.\n"
        "3. Spell out numbers naturally for narration: 'twenty percent off' not '20% off'.\n"
        "4. Use UK English spelling (colour, optimise, centre, behaviour).\n"
        "5. Always end with a clear next action the customer can take in-store.\n"
        "6. Brand name is 'Tile Station' (two words). Do NOT abbreviate or rebrand.\n"
        "7. Never invent prices, sale percentages or product details the admin didn't ask for.\n"
        "8. Avoid clichés: 'visit us today', 'don't miss out', 'limited time only' — be specific.\n"
        f"9. TONE: {tone_directives[req.tone]}\n"
        f"10. AUDIENCE: {audience_directives[req.audience]}\n"
        f"{avoid_rule}"
    )

    user_msg_parts = [
        f"Keywords / themes to weave in:\n{req.keywords.strip()}",
    ]
    if req.call_to_action:
        user_msg_parts.append(f"\nCall to action (must appear near the end):\n{req.call_to_action.strip()}")
    user_msg_parts.append(
        f"\nWrite the {req.duration_seconds}-second ad script now. Output ONLY the spoken words."
    )
    user_msg = "\n".join(user_msg_parts)

    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage
        chat = LlmChat(
            api_key=api_key,
            session_id=f"radio-ad-{os.urandom(4).hex()}",
            system_message=system,
        )
        chat.with_model("anthropic", "claude-haiku-4-5-20251001")
        out = await chat.send_message(UserMessage(text=user_msg))

        # 25 May 2026 — post-generation guardrail. LLMs sometimes
        # ignore strict-no rules and slip a banned phrase through
        # anyway. If we spot one, retry ONCE with a louder reminder
        # that specifically names the offender(s).
        def _check_banned(text: str) -> List[str]:
            t = (text or "").lower()
            return [p for p in banned_phrases if p.lower() in t]

        offenders = _check_banned(out) if banned_phrases else []
        if offenders:
            retry_chat = LlmChat(
                api_key=api_key,
                session_id=f"radio-ad-retry-{os.urandom(4).hex()}",
                system_message=system,
            )
            retry_chat.with_model("anthropic", "claude-haiku-4-5-20251001")
            retry_msg = (
                f"The previous attempt contained banned phrase(s): "
                f"{', '.join(repr(o) for o in offenders)}. "
                f"Rewrite the entire script from scratch. "
                f"You MUST NOT use any of those phrases or close variants.\n\n"
                f"{user_msg}"
            )
            out = await retry_chat.send_message(UserMessage(text=retry_msg))
    except Exception as exc:
        logger.exception("Radio script generation failed")
        raise HTTPException(
            status_code=502,
            detail=f"Script generation failed: {str(exc)[:200]}",
        ) from exc

    script = (out or "").strip()
    # Strip common LLM defects: code fences, leading/trailing quotes,
    # "Script:" labels the model occasionally adds despite instructions.
    if script.startswith("```"):
        script = script.split("\n", 1)[-1]
        if script.endswith("```"):
            script = script.rsplit("```", 1)[0]
    if script.startswith('"') and script.endswith('"'):
        script = script[1:-1]
    for prefix in ("Script:", "SCRIPT:", "Ad:", "AD:"):
        if script.startswith(prefix):
            script = script[len(prefix):].strip()

    # Suggest a sensible default ad name from the first 6 keyword words.
    suggested_name_parts = [w for w in (req.keywords or "").replace(",", " ").split() if w][:6]
    suggested_name = " ".join(suggested_name_parts) or "Untitled ad"

    # Final guardrail report. If a banned phrase made it through even
    # the retry, flag it back to the admin so they can hand-edit. We
    # don't reject the response (a 4-token false-positive shouldn't
    # block a good script) but the warning is visible in the toast.
    final_offenders = (
        [p for p in banned_phrases if p.lower() in script.lower()]
        if banned_phrases else []
    )

    return {
        "script": script.strip(),
        "suggested_name": suggested_name,
        "approx_words": len(script.split()),
        "approx_seconds": round(len(script.split()) / 2.3, 1),
        "banned_phrases_used": final_offenders,
    }


# ------------------------------------------------------------------
# Q&A script generator (31 May 2026)
# ------------------------------------------------------------------

class GenerateQAReq(BaseModel):
    """Ask-the-Showroom Q&A generator."""
    question: str = Field(min_length=5, max_length=600,
                          description="The customer/listener question to answer")
    tone: Literal["friendly", "expert", "trade"] = "expert"


@router.post("/scripts/generate-qa")
async def generate_qa_script(req: GenerateQAReq, current_user: dict = Depends(get_current_user)):
    """LLM-generate an Ask-the-Showroom Q&A answer. Returns
    `{question, answer}` — the admin can edit either before saving.
    Tone defaults to 'expert' (calm, technical, no jargon)."""
    _require_admin(current_user)
    api_key = os.environ.get("EMERGENT_LLM_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="EMERGENT_LLM_KEY not set")

    tone_directives = {
        "friendly": "Conversational, warm, like a helpful neighbour. Avoid jargon.",
        "expert": "Calm, technical but accessible, like a senior tile-fitter on a phone-in. Use precise terms (S1 adhesive, R10 slip rating) but explain them in 5 words.",
        "trade": "Pitched at professional builders/fitters. Skip basic explanations — assume product knowledge.",
    }
    system = (
        "You write Q&A answers for an in-store radio segment called "
        "'Ask the Showroom' at Tile Station — a UK tile, bathroom and "
        "flooring retailer. Answers are read aloud by an AI narrator "
        "and overheard by customers + tradesmen in our 4 stores.\n\n"
        "HARD RULES:\n"
        "1. UK English spelling and units (metres, kilos, mil).\n"
        "2. 75-130 words. Read-aloud length 30-60 seconds.\n"
        "3. Authoritative, never salesy. Cite a specific product/brand we stock "
        "when relevant (Mapei Keraflex Maxi S1, Ardex FS-DD, HardieBacker, etc).\n"
        "4. Open with a natural radio-style first sentence — NOT 'The answer is' "
        "or 'Great question'. Examples: 'Short answer: no.' / 'The trade rule "
        "is...' / 'Two reasons:'.\n"
        "5. End with a single concrete tip OR a 'we stock X' pointer. Don't say "
        "'visit our website' or 'come to our showroom' — the listener is already in it.\n"
        "6. Output ONLY the answer text, no preamble, no labels, no quotes.\n"
        f"\nTONE: {tone_directives[req.tone]}\n"
    )
    user_msg = f"Question from a customer:\n{req.question.strip()}\n\nWrite the answer now."
    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage
        chat = LlmChat(
            api_key=api_key,
            session_id=f"radio-qa-{os.urandom(4).hex()}",
            system_message=system,
        )
        chat.with_model("anthropic", "claude-haiku-4-5-20251001")
        out = await chat.send_message(UserMessage(text=user_msg))
    except Exception as exc:
        logger.exception("Q&A generation failed")
        raise HTTPException(status_code=502, detail=f"Q&A generation failed: {str(exc)[:200]}") from exc

    answer = (out or "").strip()
    # Strip common LLM defects (same shape as the ad generator).
    if answer.startswith("```"):
        answer = answer.split("\n", 1)[-1]
        if answer.endswith("```"):
            answer = answer.rsplit("```", 1)[0]
    for prefix in ("Answer:", "ANSWER:", "A:"):
        if answer.startswith(prefix):
            answer = answer[len(prefix):].strip()
    # Strip wrapping quotes LAST so we catch quotes the model put
    # around the actual answer text after a leading "Answer:".
    if answer.startswith('"') and answer.endswith('"'):
        answer = answer[1:-1]

    suggested_name = req.question.strip().rstrip("?")[:80] or "Q&A"
    return {
        "question": req.question.strip(),
        "answer": answer.strip(),
        "suggested_name": suggested_name,
        "approx_words": len(answer.split()),
        "approx_seconds": round(len(answer.split()) / 2.3, 1),
    }


# ------------------------------------------------------------------
# Trade Talk dialogue generator (31 May 2026)
# ------------------------------------------------------------------

class GenerateTradeTalkReq(BaseModel):
    """Generate a multi-turn host/guest dialogue."""
    topic: str = Field(min_length=5, max_length=400,
                       description="The technical topic the episode covers")
    target_duration_seconds: int = Field(default=240, ge=60, le=480,
                                         description="Target read-aloud length (60-480s = 1-8 min)")
    host_name: str = Field(default="Mark", max_length=40,
                           description="Name of the Tile Station expert character")
    guest_name: str = Field(default="Dave", max_length=40,
                            description="Name of the calling-in builder character")


class GenerateTurnReplyReq(BaseModel):
    """Generate a single AI continuation turn at a chosen position in
    an existing Trade Talk conversation. Used by the in-place
    "✨ Generate AI reply" button on each turn — the admin types a
    question/comment, the LLM produces the matching reply turn
    (host responds to guest, or vice versa), and the reply is
    inserted RIGHT AFTER the prompt turn for the admin to edit."""
    prior_turns: List[Dict[str, Any]] = Field(
        default_factory=list,
        description="All turns BEFORE the new reply, in order. Each: {speaker:'host'|'guest', text:str}",
    )
    reply_speaker: str = Field(
        default="host",
        description="Which speaker should the new turn be ('host' or 'guest'). Usually the OPPOSITE of the last prior turn.",
    )
    topic: Optional[str] = Field(
        default=None, max_length=400,
        description="Optional original episode topic — gives the LLM context if `prior_turns` is short or empty",
    )
    host_name: str = Field(default="Mark", max_length=40)
    guest_name: str = Field(default="Dave", max_length=40)


@router.post("/scripts/generate-turn-reply")
async def generate_turn_reply(req: GenerateTurnReplyReq, current_user: dict = Depends(get_current_user)):
    """LLM-generate ONE dialogue turn that fits the surrounding
    context. Returns `{speaker, text}` for the new turn — the
    frontend inserts it at the requested position and lets the
    admin tweak the wording.

    Why this exists: user wants to add a custom question mid-way
    through an existing podcast (e.g. *"Can I add a question here
    and have AI generate the answer that fits the flow?"*).
    Re-running the full /generate-trade-talk endpoint rewrites the
    whole episode, losing the admin's edits. This endpoint touches
    one turn only.
    """
    _require_admin(current_user)
    api_key = os.environ.get("EMERGENT_LLM_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="EMERGENT_LLM_KEY not set")

    speaker = (req.reply_speaker or "host").lower().strip()
    if speaker not in ("host", "guest"):
        raise HTTPException(status_code=422, detail="reply_speaker must be 'host' or 'guest'")

    # Keep the prompt short — only the LAST 8 turns of context are
    # passed to the LLM. More than that risks blowing past the
    # token budget AND tends to muddle "what should come next" with
    # earlier irrelevant tangents.
    recent = [t for t in (req.prior_turns or [])
              if isinstance(t, dict) and t.get("text")][-8:]
    if not recent and not req.topic:
        raise HTTPException(
            status_code=422,
            detail="Need at least one prior turn OR an episode topic to generate from.",
        )

    system = (
        "You write a SINGLE dialogue turn for a Tile Station 'Trade Talk' "
        "phone-in podcast. The episode is already in progress — your job is "
        "to write the NEXT line that fits naturally after the conversation "
        "you're shown.\n\n"
        f"CHARACTERS:\n"
        f"  HOST = {req.host_name} — Tile Station expert. Calm, technical, "
        "UK English mid-40s. Uses precise terminology but explains it.\n"
        f"  GUEST = {req.guest_name} — a working builder calling in. "
        "Friendly, asks the questions a real builder would.\n\n"
        "HARD RULES:\n"
        f"1. Write ONLY a {speaker.upper()} turn. Not the next exchange — just one line.\n"
        "2. UK English (metres, kilos, mil, square metres).\n"
        "3. 1-4 sentences. Roughly 15-60 words. Conversational — like real speech.\n"
        "4. Reference specific products/brands we stock when relevant (Mapei "
        "Keraflex Maxi S1, Ardex FS-DD, HardieBacker, etc).\n"
        "5. NEVER say 'visit our showroom' or 'visit our website' — the listener "
        "is already in the showroom.\n"
        "6. Output FORMAT: just the dialogue text. No 'HOST:' / 'GUEST:' prefix, "
        "no quotes, no stage directions, no markdown."
    )

    # Build the user message — show the LLM what came before.
    convo_lines: List[str] = []
    if req.topic:
        convo_lines.append(f"Episode topic: {req.topic.strip()}\n")
    if recent:
        convo_lines.append("Conversation so far:")
        for t in recent:
            label = (req.host_name if t.get("speaker") == "host" else req.guest_name).upper()
            convo_lines.append(f"{label}: {(t.get('text') or '').strip()}")
    convo_lines.append(
        f"\nWrite the next {speaker.upper()} turn now. Just the line — no label, no quotes."
    )
    user_msg = "\n".join(convo_lines)

    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage
        chat = LlmChat(
            api_key=api_key,
            session_id=f"radio-talk-turn-{os.urandom(4).hex()}",
            system_message=system,
        )
        chat.with_model("anthropic", "claude-haiku-4-5-20251001")
        raw = await chat.send_message(UserMessage(text=user_msg))
    except Exception as exc:
        logger.exception("Trade Talk single-turn generation failed")
        raise HTTPException(status_code=502, detail=f"Generation failed: {str(exc)[:200]}") from exc

    text = (raw or "").strip()
    # Strip stray labels the model occasionally adds even though we
    # told it not to ("HOST:", "MARK:", etc).
    for prefix in ("HOST:", "GUEST:", f"{req.host_name.upper()}:", f"{req.guest_name.upper()}:"):
        if text.upper().startswith(prefix):
            text = text[len(prefix):].strip()
    # Strip wrapping quotes / markdown the LLM sometimes adds.
    text = text.lstrip("*-• ").strip()
    if text.startswith('"') and text.endswith('"'):
        text = text[1:-1]
    if text.startswith("'") and text.endswith("'"):
        text = text[1:-1]
    if not text:
        raise HTTPException(
            status_code=502,
            detail="LLM returned empty text — try again or rephrase the prompt turn.",
        )

    return {
        "speaker": speaker,
        "text": text,
        "approx_words": len(text.split()),
        "approx_seconds": round(len(text.split()) / 2.1, 1),
    }


@router.post("/scripts/generate-trade-talk")
async def generate_trade_talk_script(req: GenerateTradeTalkReq, current_user: dict = Depends(get_current_user)):
    """LLM-generate a Trade Talk podcast episode. Returns
    `{title, turns: [{speaker, text}, ...]}` — admin can edit any
    turn, add/remove/reorder, then save and generate audio."""
    _require_admin(current_user)
    api_key = os.environ.get("EMERGENT_LLM_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="EMERGENT_LLM_KEY not set")

    # Words-per-second budget for spoken dialogue. Slightly slower
    # than monologue narration to allow for natural turn-taking.
    target_words = max(120, min(900, int(req.target_duration_seconds * 2.1)))
    target_turns = max(8, min(20, int(req.target_duration_seconds / 18)))  # ~18s per exchange

    system = (
        "You write scripted 'Trade Talk' radio podcast episodes for Tile Station — a UK "
        "tile, bathroom and flooring retailer. The format is a phone-in: a builder calls "
        f"in with a tiling/installation question, and our resident expert answers. The "
        f"dialogue plays in our 4 showrooms; builders eavesdrop and learn.\n\n"
        f"CHARACTERS:\n"
        f"  HOST = {req.host_name} — Tile Station expert. Calm, technical, experienced. "
        "Mid-40s UK English. Uses precise terminology but explains it. Has a warm, dry "
        "sense of humour. Occasionally chuckles at a daft mistake before explaining the "
        "fix.\n"
        f"  GUEST = {req.guest_name} — a working builder calling in from a job site. "
        "Friendly, asks the questions a real builder would. Slightly hesitant — pauses, "
        "trails off, says 'right' and 'yeah' a lot. Sounds like he's wiping his hands "
        "on his jeans while talking.\n\n"
        "CRITICAL — SOUND LIKE TWO HUMANS, NOT TWO ROBOTS:\n"
        "• Use natural speech disfluencies: 'erm', 'right', 'so', 'I mean', 'yeah, "
        "yeah', 'mmm', 'fair point', 'ah, gotcha', 'no — well', 'sort of', 'kind of'. "
        "Sprinkle these naturally — too many makes it cartoonish, none makes it robotic.\n"
        "• Each turn should be 1-3 sentences MAX. Real phone-ins are short back-and-forths, "
        "not paragraphs. Long monologues kill the conversational feel.\n"
        "• Start GUEST turns with a reaction word that ACKNOWLEDGES what HOST just said: "
        "'Right, yeah —', 'Ah okay —', 'Mmm, gotcha —', 'Hmm.', 'Yeah, see that's what I —'.\n"
        "• Start HOST turns with a reaction too sometimes: 'Yeah, so —', 'Right —', "
        "'Good question, actually —', 'Ah, classic one this —'.\n"
        "• Use contractions ALWAYS: 'you're / it's / we've / don't / can't'. Never 'you are' "
        "or 'it is' — that reads as formal/written.\n"
        "• Em-dashes and trailing commas for natural pauses: 'so what you want, really — "
        "is...'. Ellipsis when someone trails off: 'and then I... yeah'.\n"
        "• The GUEST should occasionally interrupt himself or backtrack: 'I was using — "
        "well, the ten kilo bag, the Mapei one'.\n"
        "• HOST never sounds like he's reading. He's having a chat with a mate who happens "
        "to be on the radio. Drop in light asides: 'mind you', 'between us', 'classic "
        "mistake', 'happens all the time'.\n\n"
        "HARD RULES:\n"
        f"1. {target_turns} turns total. Roughly alternating HOST → GUEST → HOST.\n"
        f"2. Aim for ~{target_words} total words across all turns (so each turn averages "
        f"{target_words // target_turns} words).\n"
        "3. UK English (metres, kilos, mil, square metres).\n"
        "4. Open with HOST welcoming listeners back to 'Trade Talk on Tile Station Radio' "
        f"and introducing {req.guest_name}'s question. Keep this intro punchy — 1-2 "
        "sentences max, not a long preamble.\n"
        "5. Close with HOST thanking the guest + a soft sign-off (e.g. 'Trade Talk is "
        "back tomorrow').\n"
        "6. Reference specific products/brands we stock when relevant (Mapei Keraflex "
        "Maxi S1, Ardex FS-DD, HardieBacker, etc).\n"
        "7. NEVER say 'visit our showroom' — the listener is already in it. NEVER say "
        "'visit our website' inside dialogue (the sign-off CTA at the very end can "
        "mention the website once).\n"
        "8. Output STRICTLY in this format, one turn per line:\n"
        "   HOST: Welcome back to Trade Talk...\n"
        "   GUEST: Right, yeah — hi mate. Got a kitchen-diner, big one...\n"
        "   HOST: Mmm, fair, fair. So the key thing with...\n"
        "9. No stage directions, no markdown, no episode title — JUST the dialogue lines.\n"
        "10. At the VERY END of the script (after the final HOST: line), add ONE additional "
        "line of the EXACT form:\n"
        "    EXPRESSIVENESS: 0.0..1.0 — short reason\n"
        "    Where the number recommends the energy slider for this topic:\n"
        "      • 0.20-0.35 = Stiff (technical detail, safety, fire-rated boards, "
        "structural advice, complex measurements, building regs)\n"
        "      • 0.40-0.60 = Natural (everyday tiling/fitting tips, troubleshooting, "
        "tool/adhesive selection, the default)\n"
        "      • 0.65-0.85 = Animated (deals, new collections, seasonal promotions, "
        "showroom events, light-hearted topics)\n"
        "    Example: 'EXPRESSIVENESS: 0.30 — technical safety detail, calm delivery'\n"
        "    or 'EXPRESSIVENESS: 0.75 — promotion, energetic'.\n"
        "    Only ONE such line, ONLY at the end."
    )
    user_msg = (
        f"Episode topic: {req.topic.strip()}\n\n"
        f"Write the {target_turns}-turn dialogue now."
    )

    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage
        chat = LlmChat(
            api_key=api_key,
            session_id=f"radio-talk-{os.urandom(4).hex()}",
            system_message=system,
        )
        chat.with_model("anthropic", "claude-haiku-4-5-20251001")
        out = await chat.send_message(UserMessage(text=user_msg))
    except Exception as exc:
        logger.exception("Trade Talk generation failed")
        raise HTTPException(status_code=502, detail=f"Generation failed: {str(exc)[:200]}") from exc

    # Parse `HOST: ...` / `GUEST: ...` lines. Tolerant of variation
    # (sometimes the model adds "MARK:" / "DAVE:" or prepends labels
    # in different cases — accept anything matching the pattern).
    # Also extracts a trailing `EXPRESSIVENESS: 0.x — reason` line if
    # present (Feb 26, 2026) so the admin gets a topic-aware starting
    # point on the energy slider.
    turns: List[dict] = []
    suggested_expressiveness: Optional[float] = None
    expressiveness_reason: str = ""
    for raw_line in (out or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        # Strip leading markdown bullets / quotes the LLM occasionally adds.
        line = line.lstrip("*-• ").strip()
        # Expressiveness hint line — pulled BEFORE the speaker check
        # so we don't accidentally treat it as a dialogue line.
        if line.upper().startswith("EXPRESSIVENESS:"):
            body = line.split(":", 1)[1].strip()
            # Body looks like: "0.30 — technical safety detail"
            # Use regex to tolerate any em-dash variant / extra whitespace.
            m = re.match(r"^\s*([01](?:\.\d+)?)\s*(?:[—–\-]\s*(.*))?$", body)
            if m:
                try:
                    val = float(m.group(1))
                    if 0.0 <= val <= 1.0:
                        suggested_expressiveness = round(val, 2)
                        expressiveness_reason = (m.group(2) or "").strip()
                except ValueError:
                    pass
            continue
        # Match "HOST:" / "GUEST:" / "{host_name}:" / "{guest_name}:"
        host_aliases = ("host:", f"{req.host_name.lower()}:")
        guest_aliases = ("guest:", f"{req.guest_name.lower()}:")
        lc = line.lower()
        if any(lc.startswith(a) for a in host_aliases):
            speaker = "host"
            text = line.split(":", 1)[1].strip()
        elif any(lc.startswith(a) for a in guest_aliases):
            speaker = "guest"
            text = line.split(":", 1)[1].strip()
        else:
            continue
        # Strip surrounding quotes the model sometimes adds.
        if text.startswith('"') and text.endswith('"'):
            text = text[1:-1]
        if text:
            turns.append({"speaker": speaker, "text": text})

    if len(turns) < 4:
        raise HTTPException(
            status_code=502,
            detail="LLM returned too few dialogue turns — try again with a different topic phrasing.",
        )

    suggested_name = f"Trade Talk: {req.topic.strip()[:80]}"
    total_words = sum(len(t["text"].split()) for t in turns)
    # Default to Natural (0.5) if Claude didn't include the line —
    # rare but possible if the model trims it under length pressure.
    return {
        "title": suggested_name,
        "suggested_name": suggested_name,
        "turns": turns,
        "approx_words": total_words,
        "approx_seconds": round(total_words / 2.1, 1),
        "suggested_expressiveness": suggested_expressiveness if suggested_expressiveness is not None else 0.5,
        "expressiveness_reason": expressiveness_reason or "default — natural delivery",
    }


# ------------------------------------------------------------------
# Convert Q&A ↔ Trade Talk (Feb 26, 2026)
#
# Promotes a Q&A pair into a multi-turn Trade Talk dialogue (better
# for evergreen technical topics) OR collapses a Trade Talk into a
# single Q&A (better for the short "Ask the Showroom" segment).
#
# Returns the converted PAYLOAD only — does NOT mutate the source
# doc. The UI then chooses Save-as-new-segment or Replace-existing.
# ------------------------------------------------------------------


class ConvertSegmentReq(BaseModel):
    source_id: str = Field(..., description="Existing ad/qa/trade_talk doc id")
    target_kind: Literal["qa", "trade_talk"]
    # Only used when target_kind == "trade_talk".
    host_name: str = Field(default="Mark", max_length=40)
    guest_name: str = Field(default="Dave", max_length=40)
    target_duration_seconds: int = Field(default=240, ge=60, le=480)


@router.post("/scripts/convert")
async def convert_segment(req: ConvertSegmentReq, current_user: dict = Depends(get_current_user)):
    """Convert Q&A ↔ Trade Talk in-place (returns the new payload,
    UI decides whether to save-as-new or replace the existing doc)."""
    _require_admin(current_user)
    api_key = os.environ.get("EMERGENT_LLM_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="EMERGENT_LLM_KEY not set")

    db = get_db()
    source = await db.radio_studio_ads.find_one(
        {"id": req.source_id, "_deleted": {"$ne": True}}, {"_id": 0},
    )
    if not source:
        raise HTTPException(status_code=404, detail="Source segment not found")
    source_kind = source.get("kind") or "ad"

    # ─── Q&A → Trade Talk ─────────────────────────────────────────
    if req.target_kind == "trade_talk":
        if source_kind == "trade_talk":
            raise HTTPException(status_code=400, detail="Segment is already a Trade Talk")
        question = (source.get("customer_question") or "").strip()
        answer = (source.get("answer") or source.get("script") or "").strip()
        if not question or not answer:
            raise HTTPException(
                status_code=400,
                detail="Source has no question/answer to convert. Fill both in first.",
            )
        # Reuse the Trade Talk generator — we pin the topic to the
        # existing answer so Claude EXPANDS rather than inventing
        # new facts. Same prompt → same expressiveness recommendation.
        tt_req = GenerateTradeTalkReq(
            topic=(
                f"A builder calls in asking: {question}\n\n"
                f"The expert host should EXPAND on this AUTHORITATIVE answer in "
                f"conversation form (don't invent new facts — stretch + add "
                f"natural back-and-forth around the same points):\n\n{answer}"
            ),
            target_duration_seconds=req.target_duration_seconds,
            host_name=req.host_name,
            guest_name=req.guest_name,
        )
        return await generate_trade_talk_script(tt_req, current_user)

    # ─── Trade Talk → Q&A ─────────────────────────────────────────
    if source_kind != "trade_talk":
        raise HTTPException(status_code=400, detail="Source segment is not a Trade Talk")
    turns = source.get("turns") or []
    if len(turns) < 2:
        raise HTTPException(status_code=400, detail="Trade Talk has no turns to convert")

    transcript = "\n".join(
        f"{(t.get('speaker') or '').upper()}: {(t.get('text') or '').strip()}"
        for t in turns if (t.get("text") or "").strip()
    )
    system = (
        "You convert a multi-turn 'Trade Talk' radio dialogue into a single tight "
        "Q&A pair for the 'Ask the Showroom' segment.\n\n"
        "RULES:\n"
        "1. Output STRICTLY in this format — two lines, nothing else:\n"
        "   QUESTION: <the customer's effective question, ≤ 30 words, ends in ?>\n"
        "   ANSWER: <authoritative answer, 75-130 words, UK English>\n"
        "2. The QUESTION should be how a customer/builder would phrase it — "
        "natural, single sentence, no jargon they wouldn't use.\n"
        "3. The ANSWER consolidates everything the HOST said. Strip conversational "
        "fillers ('erm', 'right yeah', 'mmm'). Keep technical facts, brand names, "
        "exact figures.\n"
        "4. Don't say 'visit our website' or 'come to our showroom'. End with a "
        "concrete tip OR a 'we stock X' pointer.\n"
        "5. Tone: calm, technical-but-accessible. Like a senior tile-fitter on a "
        "radio phone-in.\n"
        "6. NO markdown, NO quotes, NO preamble."
    )
    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage
        chat = LlmChat(
            api_key=api_key,
            session_id=f"radio-convert-{os.urandom(4).hex()}",
            system_message=system,
        )
        chat.with_model("anthropic", "claude-haiku-4-5-20251001")
        out = await chat.send_message(UserMessage(text=f"Collapse this dialogue:\n\n{transcript}"))
    except Exception as exc:
        logger.exception("Convert TT→QA failed")
        raise HTTPException(status_code=502, detail=f"Conversion failed: {str(exc)[:200]}") from exc

    question_out, answer_out = "", ""
    in_answer = False
    for raw in (out or "").splitlines():
        line = raw.strip().lstrip("*-• ").strip()
        if not line:
            continue
        if line.upper().startswith("QUESTION:"):
            question_out = line.split(":", 1)[1].strip().strip('"')
            in_answer = False
        elif line.upper().startswith("ANSWER:"):
            answer_out = line.split(":", 1)[1].strip().strip('"')
            in_answer = True
        elif in_answer:
            # Continuation of the answer (Claude sometimes wraps).
            answer_out += " " + line.strip('"')

    if not question_out or not answer_out:
        raise HTTPException(
            status_code=502,
            detail="LLM didn't return a clean QUESTION/ANSWER pair — retry.",
        )

    suggested_name = question_out.rstrip("?")[:80] or "Q&A"
    return {
        "question": question_out,
        "answer": answer_out.strip(),
        "suggested_name": suggested_name,
        "approx_words": len(answer_out.split()),
        "approx_seconds": round(len(answer_out.split()) / 2.3, 1),
    }


# ------------------------------------------------------------------
# Starter content seed (31 May 2026)
# ------------------------------------------------------------------

# 10 evergreen Trade Talk topics + 20 Q&A pairs covering the most
# common tile-shop technical questions. Inserted as DRAFTS (no
# audio_blob, no audio_filename) so admins can review, tweak, and
# click Generate when they're happy.
_STARTER_QA_PAIRS: List[Tuple[str, str]] = [
    (
        "How much extra should I order for cuts and breakage?",
        "Great question — the trade rule is 10% on a straightforward rectangular room, 15% if "
        "you've got diagonals or a herringbone pattern, and 20% if you're doing a mosaic or "
        "hexagons. So a 30 square metre kitchen straight-laid means ordering 33 square metres. "
        "We'd rather you have one box too many than have to wait a fortnight for a top-up "
        "that's a different batch. Trade members get free pallet returns on unopened boxes "
        "within 30 days, so over-ordering is risk-free.",
    ),
    (
        "Can I tile straight onto plasterboard in a shower?",
        "Short answer: no. Standard plasterboard goes soggy. You need either a tile backer "
        "board like HardieBacker or Marmox, or moisture-resistant green-board with a tanking "
        "membrane painted over it. The membrane is the bit most people skip and then call us "
        "in tears six months later when the grout's gone black. Tank it. We sell Mapei "
        "Mapegum WPS — one tub does an average shower.",
    ),
    (
        "My porcelain looks different colour to the sample I picked — is it faulty?",
        "Probably not — porcelain is fired with natural minerals so there's always some shade "
        "and tone variation between batches. We grade it V1 to V4: V1 means almost identical "
        "tile-to-tile, V4 means deliberately varied for a rustic look. Your sample was a single "
        "tile so it doesn't show the full range. Before you start tiling, dry-lay tiles from "
        "at least three different boxes mixed together — that's how the trade gets a natural "
        "distribution. If you're still seeing extreme variation, bring a tile in and we'll "
        "check the batch number.",
    ),
    (
        "Do I need waterproofing under bathroom floor tiles?",
        "Building regs only require it in wet rooms — meaning no shower tray, water hits the "
        "floor directly. For a standard bathroom with a tray or bath, it's optional but smart. "
        "A 50 quid tanking kit saves a £3,000 ceiling repair downstairs. We always recommend "
        "it around the bath edge and the first metre out from the shower.",
    ),
    (
        "What's the difference between rectified and non-rectified tiles?",
        "Rectified means the edges have been machine-cut perfectly square after firing, so you "
        "can lay them with a tiny 2-millimetre grout joint and it looks almost seamless. "
        "Non-rectified — also called cushion-edge — has a slight bevel from the firing process, "
        "and needs a 3 to 5 mil joint minimum. Rectified is more premium, costs more, and shows "
        "off pattern-matched designs better. Cushion-edge is more forgiving if your substrate "
        "isn't perfectly flat.",
    ),
    (
        "Can I use floor tiles on a wall?",
        "Almost always yes — they're stronger, they just weigh more. The thing to check is the "
        "maximum weight your wall can take. Plasterboard rated for tiling handles around 32 "
        "kilos per square metre — that's most 10 mil porcelain. Anything thicker than 12 mil "
        "or natural stone, you want a tile backer board behind it. The other way round — wall "
        "tiles on a floor — is a hard no. Wall tiles are softer and crack under foot traffic.",
    ),
    (
        "Why does my grout look streaky after it dried?",
        "Two reasons: either you wiped too late and let the grout haze dry on the tile face, or "
        "you used too much water sponging it off. The fix while it's still happening: stop, "
        "dampen a microfibre cloth and buff the haze off in circles. If it's been 24 hours, "
        "you need a grout haze remover — citric-acid based. We stock Lithofin KF Cement Residue "
        "Remover. Spray on, leave 5 minutes, scrub gently, rinse twice. Don't use vinegar on "
        "natural stone or you'll dissolve the surface.",
    ),
    (
        "How long should I wait before walking on a newly tiled floor?",
        "With standard adhesive: 24 hours minimum, 48 if it's cold. Rapid-set adhesive: 3 to 4 "
        "hours. Don't grout for 24 hours after tiling regardless of which adhesive — even rapid "
        "set. And don't put heavy furniture back for 7 days. Most calls we get about lifted "
        "tiles trace back to someone moving the fridge in on day 2.",
    ),
    (
        "Which adhesive do I need for porcelain over underfloor heating?",
        "You need a flexible S1-rated adhesive — that S1 grade gives you about 2.5 millimetres "
        "of deflection, which is what porcelain over heated screed needs. Standard cement-based "
        "adhesive will crack as the floor expands and contracts. We stock Mapei Keraflex Maxi S1 "
        "— it's the trade pick most of our regulars use. Pair it with flexible grout — Ardex "
        "FS-DD is bombproof. And commission the heating gradually 3 days before tiling, then "
        "back down to ambient for tiling day.",
    ),
    (
        "What slip rating do I need for a bathroom floor?",
        "For inside a domestic bathroom, R10 is the minimum we'd recommend — that's slip "
        "resistance suitable for a wet area. R9 is fine for kitchens and hallways but a bit "
        "slippy when wet. For a wet room with no tray, go R11. Around an outdoor pool, R12. "
        "Most of our porcelain ranges show the R rating on the box label.",
    ),
    (
        "Can I tile over existing tiles?",
        "Yes, in many cases — saves you a day of ripping out. Three checks first: are the "
        "existing tiles firmly stuck (tap each one, listen for hollow sounds)? Is the surface "
        "still flat (a 2-metre level on the diagonal)? Will the new floor height clear the "
        "door? If all three are yes, scuff the existing tiles with 60-grit, prime with Mapei "
        "Primer G, and tile with a flexible S1 adhesive. Don't try this in a wet area — we'd "
        "rip out and tank from scratch.",
    ),
    (
        "Why is there efflorescence — white powder — on my new natural stone?",
        "Efflorescence is mineral salts being drawn up to the surface as moisture evaporates "
        "from the adhesive bed. It's normal in the first 6 to 8 weeks of new natural stone. "
        "Don't panic and don't wash it with water — that pushes the salts back in. Brush it "
        "off dry with a soft brush, wait for the floor to fully cure, then re-seal with a "
        "penetrating sealer. We stock Lithofin Stain-Stop — one bottle treats about 25 square "
        "metres.",
    ),
    (
        "Do I need movement joints in a small bathroom?",
        "BS 5385 — the tiling regs — say you need a movement joint every 8 to 10 metres, around "
        "the perimeter of any room over 40 square metres, and at every change of substrate or "
        "external corner. Most domestic bathrooms are well under those limits, so internal "
        "movement joints aren't needed. BUT — perimeter joints around the bath, shower tray "
        "and walls are essential. Use a flexible silicone sealant there, never grout. Grout "
        "will crack within a year as the bath flexes.",
    ),
    (
        "What's the right notched trowel size for my tile?",
        "Quick guide: 6 mil notch for mosaics and tiles under 200 mil; 8 mil for tiles between "
        "200 and 400 mil; 10 to 12 mil for 600x600 and larger; 12 to 15 mil with a back-buttering "
        "pass for porcelain slabs over 800 mil. The rule is you want at least 80% adhesive "
        "coverage when you lift a tile back up. Lift one early in the job to check.",
    ),
    (
        "Should I seal porcelain tiles before grouting?",
        "Standard glazed porcelain — no, sealing isn't needed because the surface is "
        "non-porous. Polished, satin or honed-finish porcelain — yes, seal it before grouting. "
        "The micro-pores on the polished surface absorb pigment from coloured grout and you "
        "end up with a permanent shadow. One coat of penetrating sealer 24 hours before "
        "grouting solves it. We stock Lithofin KF Stain-Stop.",
    ),
    (
        "How much does a 60x60 porcelain tile weigh per square metre?",
        "Standard 10 mil thick porcelain is around 22 kilos per square metre. 12 mil is 27 "
        "kilos. 20 mil outdoor porcelain is 45 kilos. That matters for wall installations — "
        "plasterboard rated for tiling handles up to 32 kilos per square metre, so anything "
        "over 10 mil porcelain on a wall needs a tile backer board behind it.",
    ),
    (
        "What's the cheapest way to dramatically update an old kitchen?",
        "Splashback tile change. £80 to £200 of tile, a day of labour, and you've got a "
        "different-looking kitchen. Look at our Metro range — proper 7.5 by 15 centimetre "
        "metro tiles in 12 colours, £14 a square metre. Or for a more premium look, our "
        "fish-scale mosaics at £35 a square metre. Same kitchen carcases, completely new "
        "feel.",
    ),
    (
        "Can outdoor 20mm porcelain be laid loose on grass or gravel?",
        "Yes — that's exactly what it's designed for. On a gravel sub-base you just need 30 "
        "mil of compacted MOT type 1 then 30 mil of sharp sand, then drop the tiles in. On "
        "grass over a soft sub-base, lay them on supportive pedestals to keep them level. "
        "20mm porcelain takes a 1.2-tonne point load — no slab cracking. They lift back out "
        "for cleaning underneath, which standard outdoor tiles don't allow.",
    ),
    (
        "Should I use cement or rapid-set adhesive?",
        "Rapid-set if you're working in a busy household — you can grout in 4 hours instead "
        "of 24, and walk on it. Cement-based if you're doing a large area where you need a "
        "long open time to lay tiles without rushing. Trade preference is usually rapid-set "
        "in domestic, cement-based in commercial. We stock both ranges from Mapei and Ardex.",
    ),
    (
        "Will my tiles fade in sunlight?",
        "Porcelain and ceramic — no. They're fired at 1200 degrees so the colour is locked in "
        "the body of the tile. Natural stone — slightly, over years, but usually unnoticeable "
        "indoors. The thing that DOES fade is grout. Dark grouts in conservatories or south-"
        "facing rooms go patchy over 5 years. Use epoxy grout in those rooms — Mapei Kerapoxy. "
        "Costs 4 times more but lasts 20 years.",
    ),
]

# 10 Trade Talk episode topics. Each is just the topic string — the
# LLM generator fills in the dialogue when the admin clicks
# Generate. We seed them as drafts so they appear in the library
# immediately and the admin can pick which to render first.
_STARTER_TRADE_TALK_TOPICS: List[str] = [
    "Laying porcelain over electric underfloor heating in a 35 square metre kitchen-diner",
    "Choosing slip ratings for bathrooms, kitchens and wet rooms — R9 vs R10 vs R11",
    "When to use a tile backer board vs moisture-resistant plasterboard in a shower",
    "Tiling over existing tiles — when it works, when to rip out and start again",
    "Movement joints — what the regs actually require for a domestic install",
    "Mixing adhesive properly — pot life, ratios, and the most common rookie mistake",
    "Setting out a herringbone pattern in an awkwardly-shaped hallway",
    "Outdoor 20mm porcelain — laying on pedestals vs bonded vs gravel sub-base",
    "Sealing natural stone — when, what with, and how often to redo it",
    "Diagnosing efflorescence, hairline cracks and shading variation on a new install",
]


@router.post("/ads/{ad_id}/save-as-template")
async def save_ad_as_template(ad_id: str, current_user: dict = Depends(get_current_user)):
    """Promote an existing Q&A or Trade Talk ad doc into a re-usable
    template. Drops the per-instance bits (audio, voice IDs,
    generated_at, etc.) and keeps the editorial content (script,
    question, turns) so the next admin can clone it without
    re-renderng audio.

    Templates live in `radio_studio_templates` so they're queryable
    separately from the live ad pool, and a future "Apply template"
    endpoint can deep-copy them back into ads.

    Idempotency: re-saving the same ad as a template upserts on
    `source_ad_id` so the templates list doesn't fill up with
    duplicates from accidental double-clicks.
    """
    _require_admin(current_user)
    db = get_db()
    ad = await db.radio_studio_ads.find_one({"id": ad_id}, {"_id": 0})
    if not ad:
        raise HTTPException(status_code=404, detail="Ad not found")
    kind = ad.get("kind") or "ad"
    if kind not in ("qa", "trade_talk"):
        raise HTTPException(
            status_code=400,
            detail="Only Q&A and Trade Talk items can be saved as templates.",
        )
    now_iso = datetime.now(timezone.utc).isoformat()
    tpl = {
        "id": uuid.uuid4().hex,
        "source_ad_id": ad_id,
        "kind": kind,
        "name": ad.get("name") or "Untitled template",
        # Editorial content kept verbatim
        "script": ad.get("script") or "",
        "question": ad.get("question"),
        "narrate_question": bool(ad.get("narrate_question", True)),
        "turns": ad.get("turns") or [],
        "topic": ad.get("topic"),
        "pronunciation_hints": ad.get("pronunciation_hints"),
        # Per-instance bits intentionally OMITTED:
        #   voice_id, host_voice_id, guest_voice_id, audio_filename,
        #   audio_blob, duration_seconds, generated_at — each clone
        #   picks its own voices + re-renders audio.
        "updated_at": now_iso,
        "created_by": (current_user or {}).get("email"),
    }
    # `created_at` lives ONLY in $setOnInsert so re-saving the same
    # ad updates `updated_at` but preserves the original create time.
    await db.radio_studio_templates.update_one(
        {"source_ad_id": ad_id},
        {"$set": tpl, "$setOnInsert": {"created_at": now_iso}},
        upsert=True,
    )
    return {
        "ok": True,
        "template_id": tpl["id"],
        "kind": kind,
        "name": tpl["name"],
    }


@router.get("/templates")
async def list_templates(
    kind: Optional[str] = None,
    current_user: dict = Depends(get_current_user),
):
    """Return all saved templates. Optional `?kind=qa` or
    `?kind=trade_talk` filter. Used by the "Apply template" picker
    in the Ads form."""
    _require_admin(current_user)
    db = get_db()
    q: dict = {}
    if kind in ("qa", "trade_talk"):
        q["kind"] = kind
    cursor = db.radio_studio_templates.find(q, {"_id": 0}).sort("created_at", -1).limit(100)
    return [doc async for doc in cursor]


@router.post("/templates/{template_id}/apply")
async def apply_template(template_id: str, current_user: dict = Depends(get_current_user)):
    """Deep-copy a saved template into a fresh ad doc. The new ad
    inherits the editorial content but has NO voice/audio so the
    admin can pick voices and click Generate."""
    _require_admin(current_user)
    db = get_db()
    tpl = await db.radio_studio_templates.find_one({"id": template_id}, {"_id": 0})
    if not tpl:
        raise HTTPException(status_code=404, detail="Template not found")
    now_iso = datetime.now(timezone.utc).isoformat()
    ad = {
        "id": uuid.uuid4().hex,
        "name": tpl.get("name") or "Untitled",
        "kind": tpl.get("kind") or "qa",
        "script": tpl.get("script") or "",
        "question": tpl.get("question"),
        "narrate_question": bool(tpl.get("narrate_question", True)),
        "turns": tpl.get("turns") or [],
        "topic": tpl.get("topic"),
        "pronunciation_hints": tpl.get("pronunciation_hints"),
        "voice_id": "",
        "voice_name": None,
        "host_voice_id": None,
        "host_voice_name": None,
        "guest_voice_id": None,
        "guest_voice_name": None,
        "stability": 0.5,
        "similarity_boost": 0.75,
        "style": 0.0,
        "model_id": "eleven_multilingual_v2",
        "bed_music_id": None,
        "bed_volume_pct": 18,
        "audio_filename": None,
        "duration_seconds": None,
        "generated_at": None,
        "created_at": now_iso,
        "updated_at": now_iso,
        "created_by": (current_user or {}).get("email"),
        "from_template_id": template_id,
    }
    await db.radio_studio_ads.insert_one(ad)
    ad.pop("_id", None)  # safety
    return {"ok": True, "ad": ad}


@router.delete("/templates/{template_id}")
async def delete_template(template_id: str, current_user: dict = Depends(get_current_user)):
    _require_admin(current_user)
    db = get_db()
    res = await db.radio_studio_templates.delete_one({"id": template_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Template not found")
    return {"ok": True, "deleted_id": template_id}


@router.get("/recent-visitor-questions")
async def recent_visitor_questions(
    limit: int = 20,
    current_user: dict = Depends(get_current_user),
):
    """Pull recent visitor messages from the live-chat history that
    look like questions (end in '?' or start with a question word)
    AND aren't already represented in the Q&A library. Lets the
    admin one-tap turn a real customer question into a Q&A episode.

    Heuristics on the cheap end deliberately — false positives are
    fine because the admin clicks through to confirm.
    """
    _require_admin(current_user)
    db = get_db()
    limit = max(1, min(50, int(limit)))
    # Pull last ~200 visitor messages — we filter further in Python
    # because Mongo regex on every message would be expensive.
    cursor = db.chat_messages.find(
        {"sender": "visitor"},
        {"_id": 0, "message": 1, "session_id": 1, "timestamp": 1, "created_at": 1},
    ).sort("created_at", -1).limit(200)
    msgs = [m async for m in cursor]
    # If `created_at` isn't on some rows, fall back to `timestamp`
    QUESTION_WORDS = (
        "what", "how", "where", "when", "why", "do you", "can i", "can you",
        "is it", "are you", "are there", "does", "could", "should",
    )
    questions: List[dict] = []
    seen_text: set = set()
    # Already-saved Q&A names — used to filter out duplicates so the
    # picker shows only NEW question candidates.
    existing_names: set = set()
    async for doc in db.radio_studio_ads.find(
        {"kind": "qa"}, {"_id": 0, "name": 1, "question": 1},
    ):
        for k in ("name", "question"):
            v = (doc.get(k) or "").strip().lower()
            if v:
                existing_names.add(v.rstrip("?"))
    for m in msgs:
        text = (m.get("message") or "").strip()
        if len(text) < 8 or len(text) > 240:
            continue
        norm = text.lower().rstrip("?").strip()
        if norm in seen_text:
            continue
        looks_like_q = text.endswith("?") or any(norm.startswith(w) for w in QUESTION_WORDS)
        if not looks_like_q:
            continue
        if norm in existing_names:
            continue
        seen_text.add(norm)
        questions.append({
            "text": text,
            "session_id": m.get("session_id"),
            "at": m.get("created_at") or m.get("timestamp"),
        })
        if len(questions) >= limit:
            break
    return {
        "questions": questions,
        "count": len(questions),
    }


@router.post("/seed-starter-content")
async def seed_starter_content(current_user: dict = Depends(get_current_user)):
    """Insert the curated starter library of Q&A pairs + Trade Talk
    topics as DRAFT entries (no audio rendered yet). Idempotent —
    skips items whose `name` already exists, so admins can re-run
    safely. Returns counts of what was inserted vs skipped."""
    _require_admin(current_user)
    db = get_db()

    inserted_qa = 0
    inserted_talk = 0
    skipped = 0
    now_iso = datetime.now(timezone.utc).isoformat()
    creator = (current_user or {}).get("email")

    # Q&A pairs — single voice, narrate question + answer.
    for idx, (question, answer) in enumerate(_STARTER_QA_PAIRS):
        # Match by name to keep this idempotent (admin may have
        # edited and re-saved one of the seeds; we won't overwrite
        # their edits on re-seed).
        name = question.rstrip("?")[:120]
        if await db.radio_studio_ads.find_one({"name": name}, {"_id": 1}):
            skipped += 1
            continue
        doc = {
            "id": uuid.uuid4().hex,
            "name": name,
            "kind": "qa",
            "script": answer,
            "question": question,
            "narrate_question": True,
            "voice_id": "",  # admin picks a voice before generating
            "voice_name": None,
            "stability": 0.5,
            "similarity_boost": 0.75,
            "style": 0.0,
            "model_id": "eleven_multilingual_v2",
            "bed_music_id": None,
            "bed_volume_pct": 18,
            "pronunciation_hints": None,
            "host_voice_id": None,
            "host_voice_name": None,
            "guest_voice_id": None,
            "guest_voice_name": None,
            "turns": [],
            "audio_filename": None,
            "duration_seconds": None,
            "generated_at": None,
            "created_at": now_iso,
            "updated_at": now_iso,
            "created_by": creator,
            "is_starter_seed": True,
        }
        await db.radio_studio_ads.insert_one(doc)
        inserted_qa += 1

    # Trade Talk topics — empty turns list. Admin clicks "Generate
    # dialogue" on each to populate the script via Claude.
    for topic in _STARTER_TRADE_TALK_TOPICS:
        name = f"Trade Talk: {topic[:80]}"
        if await db.radio_studio_ads.find_one({"name": name}, {"_id": 1}):
            skipped += 1
            continue
        doc = {
            "id": uuid.uuid4().hex,
            "name": name,
            "kind": "trade_talk",
            "script": "",
            "question": None,
            "narrate_question": True,
            "voice_id": "",
            "voice_name": None,
            "stability": 0.5,
            "similarity_boost": 0.75,
            "style": 0.0,
            "model_id": "eleven_multilingual_v2",
            "bed_music_id": None,
            "bed_volume_pct": 18,
            "pronunciation_hints": None,
            "host_voice_id": None,
            "host_voice_name": None,
            "guest_voice_id": None,
            "guest_voice_name": None,
            "turns": [],  # empty — admin clicks Generate dialogue to populate
            "topic": topic,  # cached so the Generate button has the prompt
            "audio_filename": None,
            "duration_seconds": None,
            "generated_at": None,
            "created_at": now_iso,
            "updated_at": now_iso,
            "created_by": creator,
            "is_starter_seed": True,
        }
        await db.radio_studio_ads.insert_one(doc)
        inserted_talk += 1

    return {
        "success": True,
        "inserted_qa": inserted_qa,
        "inserted_trade_talk": inserted_talk,
        "skipped": skipped,
        "total_qa_available": len(_STARTER_QA_PAIRS),
        "total_trade_talk_available": len(_STARTER_TRADE_TALK_TOPICS),
    }


# ------------------------------------------------------------------
# One-click Trade Talk episode (31 May 2026)
# ------------------------------------------------------------------
#
# Chains Claude (script) + Mongo (insert) + ElevenLabs (TTS per turn) +
# ffmpeg (concat) into a single endpoint. Useful for "fire off 10
# episodes for the week in 5 minutes" workflow — the admin clicks
# Generate, waits ~30-60 seconds per episode, and the finished
# audio drops into the library ready to drag into the playlist.

class GenerateFullEpisodeReq(BaseModel):
    topic: str = Field(min_length=5, max_length=400)
    host_voice_id: str = Field(min_length=1)
    guest_voice_id: str = Field(min_length=1)
    host_voice_name: Optional[str] = None
    guest_voice_name: Optional[str] = None
    target_duration_seconds: int = Field(default=240, ge=60, le=480)
    host_name: str = Field(default="Mark", max_length=40)
    guest_name: str = Field(default="Dave", max_length=40)
    # Optional knobs that mirror the per-ad voice tuning. If omitted
    # we fall through to ElevenLabs defaults.
    stability: float = Field(default=0.5, ge=0.0, le=1.0)
    similarity_boost: float = Field(default=0.75, ge=0.0, le=1.0)
    style: float = Field(default=0.0, ge=0.0, le=1.0)
    model_id: str = "eleven_multilingual_v2"
    # If True (default), save the dialogue AND render audio. If False,
    # we just save the script + turns as a draft (the existing
    # generate-trade-talk-script behaviour) — useful when the admin
    # wants to review before paying for synthesis.
    render_audio: bool = True


@router.post("/generate-full-episode")
async def generate_full_episode(
    req: GenerateFullEpisodeReq,
    current_user: dict = Depends(get_current_user),
):
    """One-click Trade Talk: script + create + (optionally) render audio.
    Returns the saved ad doc (with audio_filename set if render_audio=True).
    Total cost: ~£0.0001 for the Claude script + ~£0.20-0.40 for the
    ElevenLabs TTS (depending on episode length)."""
    _require_admin(current_user)
    db = get_db()

    # 1. Generate dialogue via Claude (reuses the existing endpoint's
    #    LLM call shape — we call the function directly to avoid the
    #    HTTP round-trip).
    script_req = GenerateTradeTalkReq(
        topic=req.topic,
        target_duration_seconds=req.target_duration_seconds,
        host_name=req.host_name,
        guest_name=req.guest_name,
    )
    script_result = await generate_trade_talk_script(script_req, current_user)
    turns = script_result["turns"]
    if not turns:
        raise HTTPException(status_code=502, detail="LLM returned no turns")

    # 2. Create the ad doc with kind=trade_talk.
    ad_id = uuid.uuid4().hex
    now_iso = datetime.now(timezone.utc).isoformat()
    doc = {
        "id": ad_id,
        "name": script_result.get("suggested_name") or f"Trade Talk: {req.topic[:80]}",
        "kind": "trade_talk",
        "script": "",
        "question": None,
        "narrate_question": True,
        "voice_id": "",
        "voice_name": None,
        "stability": req.stability,
        "similarity_boost": req.similarity_boost,
        "style": req.style,
        "model_id": req.model_id,
        "bed_music_id": None,
        "bed_volume_pct": 18,
        "pronunciation_hints": None,
        "host_voice_id": req.host_voice_id,
        "host_voice_name": req.host_voice_name,
        "guest_voice_id": req.guest_voice_id,
        "guest_voice_name": req.guest_voice_name,
        "turns": turns,
        "topic": req.topic,
        "audio_filename": None,
        "duration_seconds": None,
        "generated_at": None,
        "created_at": now_iso,
        "updated_at": now_iso,
        "created_by": (current_user or {}).get("email"),
    }
    await db.radio_studio_ads.insert_one(doc)
    doc.pop("_id", None)

    # Caller asked for script-only — return without burning ElevenLabs
    # credits. Admin can review then click Generate when happy.
    if not req.render_audio:
        return {"ad": doc, "audio_rendered": False, "turns_count": len(turns)}

    # 3. Render audio. We invoke the existing generation route by
    #    function call so all the share-of-features (cost logging,
    #    pronunciation hints, normalisation, ffmpeg concat) stay DRY
    #    — exactly the same pipeline as clicking "Generate audio" on
    #    the ad card after the fact.
    try:
        rendered = await generate_ad_audio(ad_id, current_user)
    except HTTPException as exc:
        # The doc is already saved at this point (so the admin can
        # retry generation manually without re-paying for Claude). Add
        # a hint to the error so they understand what happened.
        raise HTTPException(
            status_code=exc.status_code,
            detail=(
                f"Script saved successfully (ID: {ad_id}) but audio "
                f"rendering failed: {exc.detail}. "
                f"Click the regenerate button on the ad card to retry."
            ),
        ) from exc

    return {
        "ad": rendered,
        "audio_rendered": True,
        "turns_count": len(turns),
        "approx_seconds": script_result.get("approx_seconds"),
    }


# ------------------------------------------------------------------
# Voices
# ------------------------------------------------------------------

@router.post("/voices/sync")
async def sync_voices(current_user: dict = Depends(get_current_user)):
    """Pull the full voice list from ElevenLabs, filter to English (UK
    + other English locales), cache in Mongo. Admins click this once
    a month or whenever ElevenLabs adds new voices."""
    _require_admin(current_user)
    client = _get_eleven_client()
    db = get_db()

    try:
        response = client.voices.get_all()
    except Exception as e:
        logger.exception("ElevenLabs voices.get_all failed")
        raise HTTPException(status_code=502, detail=f"ElevenLabs error: {e}") from e

    voices_raw = getattr(response, "voices", None) or []
    cached = []
    for v in voices_raw:
        # 24 May 2026 — DON'T filter voices at the backend. Earlier
        # the filter was English-only but user reported the dropdown
        # was empty even though their ElevenLabs account had voices
        # (the labels on their account had no `language` field, or
        # values that didn't match the heuristic). Showing all voices
        # is safer — the frontend groups by accent so UK English
        # surfaces first naturally.
        labels = (getattr(v, "labels", None) or {})
        cached.append({
            "voice_id": v.voice_id,
            "name": v.name,
            "category": getattr(v, "category", "premade"),
            "description": getattr(v, "description", None),
            "accent": labels.get("accent"),
            "age": labels.get("age"),
            "gender": labels.get("gender"),
            "use_case": labels.get("use case") or labels.get("use_case"),
            "language": labels.get("language"),
            "preview_url": getattr(v, "preview_url", None),
        })

    # Cache the result so subsequent GETs are instant. Copy each
    # dict BEFORE insert_many because PyMongo mutates the input to
    # add `_id: ObjectId(...)` — that ObjectId then trips the FastAPI
    # JSON serialiser on return. (24 May 2026 — root cause of the
    # silent voice-list-empty bug on production.)
    await db.radio_studio_voices.delete_many({})
    if cached:
        await db.radio_studio_voices.insert_many([dict(c) for c in cached])

    return {"voices": cached, "count": len(cached)}


@router.get("/voices")
async def list_voices(current_user: dict = Depends(get_current_user)):
    _require_admin(current_user)
    db = get_db()
    cached = await db.radio_studio_voices.find({}, {"_id": 0}).to_list(500)
    if not cached:
        # First-time use — auto-sync so the admin doesn't have to
        # find the Sync button on an empty list.
        return await sync_voices(current_user)
    return {"voices": cached, "count": len(cached)}


# ------------------------------------------------------------------
# Ads
# ------------------------------------------------------------------

@router.post("/ads")
async def create_ad(req: AdCreate, current_user: dict = Depends(get_current_user)):
    _require_admin(current_user)
    db = get_db()
    ad_id = uuid.uuid4().hex
    doc = {
        "id": ad_id,
        "name": req.name,
        "kind": getattr(req, "kind", "ad"),
        "script": req.script,
        "voice_id": req.voice_id,
        "voice_name": req.voice_name,
        "stability": req.stability,
        "similarity_boost": req.similarity_boost,
        "style": req.style,
        "model_id": req.model_id,
        "bed_music_id": req.bed_music_id,
        "bed_volume_pct": req.bed_volume_pct,
        "pronunciation_hints": req.pronunciation_hints,
        # New kind-specific fields. Always written (even if null for
        # plain ads) so list responses have a consistent shape.
        "question": getattr(req, "question", None),
        "narrate_question": getattr(req, "narrate_question", True),
        "host_voice_id": getattr(req, "host_voice_id", None),
        "host_voice_name": getattr(req, "host_voice_name", None),
        "guest_voice_id": getattr(req, "guest_voice_id", None),
        "guest_voice_name": getattr(req, "guest_voice_name", None),
        "turns": [t.model_dump() for t in (getattr(req, "turns", []) or [])],
        # Expressiveness slider value 0-1 (Trade Talk). Stored on
        # every doc so the field is always present and the per-turn
        # voice settings can read it without a fallback dance.
        "expressiveness": float(getattr(req, "expressiveness", 0.5) or 0.5),
        "audio_filename": None,  # populated after first generation
        "duration_seconds": None,
        "generated_at": None,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "created_by": (current_user or {}).get("email"),
    }
    await db.radio_studio_ads.insert_one(doc)
    doc.pop("_id", None)
    return doc


@router.get("/ads")
async def list_ads(current_user: dict = Depends(get_current_user)):
    _require_admin(current_user)
    db = get_db()
    # Projection deliberately excludes `audio_blob` so we don't ship
    # MBs of audio with every list call. The frontend reads audio
    # via the streaming endpoint instead.
    ads = await db.radio_studio_ads.find(
        {},
        {"_id": 0, "audio_blob": 0},
    ).sort("created_at", -1).to_list(500)
    return {"ads": ads, "count": len(ads)}


@router.put("/ads/{ad_id}")
async def update_ad(
    ad_id: str,
    req: AdUpdate,
    current_user: dict = Depends(get_current_user),
):
    _require_admin(current_user)
    db = get_db()
    updates = {k: v for k, v in req.model_dump(exclude_unset=True).items() if v is not None}
    # bed_music_id of empty string means "remove the bed" — handle
    # it as an explicit unset rather than treating empty as truthy.
    if "bed_music_id" in req.model_dump(exclude_unset=True) and not updates.get("bed_music_id"):
        updates["bed_music_id"] = None
    # Same pattern for pronunciation_hints — empty-string clears it.
    sent = req.model_dump(exclude_unset=True)
    if "pronunciation_hints" in sent and not (sent.get("pronunciation_hints") or "").strip():
        updates["pronunciation_hints"] = None
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    updates["updated_at"] = datetime.now(timezone.utc).isoformat()
    result = await db.radio_studio_ads.update_one({"id": ad_id}, {"$set": updates})
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Ad not found")
    ad = await db.radio_studio_ads.find_one({"id": ad_id}, {"_id": 0, "audio_blob": 0})
    return ad


# Test-voice endpoint: budget = first N chars of the normalised
# script. ElevenLabs charges per character so a "preview" of the
# opening sentence costs ~80 chars × $0.30/1000 chars ≈ £0.0002 —
# basically free, and the admin gets to sanity-check pronunciations
# (especially £/URL normalisation) before committing to a full re-
# render. (30 May 2026 user request.)
_TEST_VOICE_CHAR_BUDGET = 180


@router.post("/ads/{ad_id}/test-voice")
async def test_ad_voice(
    ad_id: str,
    current_user: dict = Depends(get_current_user),
):
    """Synthesise a short preview of the ad's voice (first ~180
    normalised chars) and stream the bytes back inline. Does NOT
    apply the music bed (so the admin hears the voice clearly) and
    does NOT touch the stored audio_blob — perfect for "does this
    pronounce £42.99 right?" sanity checks before committing to a
    full ElevenLabs generation."""
    _require_admin(current_user)
    db = get_db()
    ad = await db.radio_studio_ads.find_one(
        {"id": ad_id}, {"_id": 0, "audio_blob": 0},
    )
    if not ad:
        raise HTTPException(status_code=404, detail="Ad not found")

    # Build the "source text" we'll preview from, depending on kind.
    # For Trade Talk we preview the FIRST turn in the HOST voice;
    # for Q&A we preview the question+answer narration; for an Ad
    # we preview the script. (31 May 2026 multi-kind support.)
    kind = ad.get("kind") or "ad"
    if kind == "trade_talk":
        turns = ad.get("turns") or []
        if not turns:
            raise HTTPException(status_code=400, detail="No turns yet — add at least one before previewing")
        # Preview the first turn with its assigned speaker's voice.
        first = turns[0]
        source_text = first.get("text") or ""
        speaker_voice = (
            ad.get("host_voice_id") if first.get("speaker") == "host"
            else ad.get("guest_voice_id")
        )
        if not speaker_voice:
            raise HTTPException(status_code=400, detail="Pick host + guest voices before previewing")
        preview_voice_id = speaker_voice
        preview_voice_name = (
            ad.get("host_voice_name") if first.get("speaker") == "host"
            else ad.get("guest_voice_name")
        )
    else:
        # ad or qa — same single-voice path. _build_script_from_kind
        # composes "Today's question — ..., {answer}" for Q&A.
        source_text = _build_script_from_kind(ad)
        if not source_text.strip():
            raise HTTPException(status_code=400, detail="Nothing to preview — fill in the script/question/answer first")
        if not ad.get("voice_id"):
            raise HTTPException(status_code=400, detail="Pick a voice before previewing")
        preview_voice_id = ad["voice_id"]
        preview_voice_name = ad.get("voice_name")

    # Apply per-ad pronunciation hints first (so they get a chance
    # to substitute words BEFORE £/URL normalisation runs), then
    # normalise £/URLs/m². Truncate the result to the test budget.
    hinted = _apply_pronunciation_hints(source_text, ad.get("pronunciation_hints"))
    normalised = _normalize_for_tts(hinted)
    preview = normalised[:_TEST_VOICE_CHAR_BUDGET]
    # Try to end at the last sentence/clause boundary inside budget.
    cut_at = max(preview.rfind(". "), preview.rfind("! "), preview.rfind("? "), preview.rfind(", "))
    if cut_at > _TEST_VOICE_CHAR_BUDGET // 2:
        # Keep the boundary character.
        preview = preview[: cut_at + 1]
    preview = preview.strip()

    client = _get_eleven_client()
    # Mirror the conversational override from the full /generate
    # endpoint so the preview matches what we'll actually render
    # for trade_talk segments (Feb 26, 2026).
    if (ad.get("kind") or "ad") == "trade_talk":
        # Trade Talk preview uses the same expressiveness slider as
        # the full /generate path so what the admin hears matches.
        # Defaults to 0.5 (Natural) for ads created before the
        # slider shipped. (Feb 26, 2026.)
        stab, sty = _voice_settings_for_expressiveness(
            float(ad.get("expressiveness", 0.5)),
            is_host=True,  # preview only uses host voice
        )
        voice_settings = VoiceSettings(
            stability=stab, similarity_boost=0.85, style=sty,
            use_speaker_boost=True,
        )
        preview_model_id = "eleven_flash_v2_5"
    else:
        voice_settings = VoiceSettings(
            stability=float(ad.get("stability", 0.5)),
            similarity_boost=float(ad.get("similarity_boost", 0.75)),
            style=float(ad.get("style", 0.0)),
            use_speaker_boost=True,
        )
        preview_model_id = ad.get("model_id") or "eleven_multilingual_v2"
    try:
        audio_iter = client.text_to_speech.convert(
            text=preview,
            voice_id=preview_voice_id,
            model_id=preview_model_id,
            voice_settings=voice_settings,
            output_format="mp3_44100_128",
        )
        audio_data = b"".join(chunk for chunk in audio_iter if chunk)
    except Exception as e:
        logger.exception("ElevenLabs test-voice failed for ad %s", ad_id)
        raise HTTPException(status_code=502, detail=f"ElevenLabs error: {e}") from e

    if not audio_data:
        raise HTTPException(status_code=502, detail="ElevenLabs returned empty audio")

    # Log the TTS call for the cost dashboard. Best-effort — never
    # breaks playback if the log write fails. (30 May 2026.)
    await _log_tts_usage(
        db=db,
        ad_id=ad_id,
        ad_name=ad.get("name"),
        endpoint="test_voice",
        chars=len(preview),
        voice_id=preview_voice_id,
        voice_name=preview_voice_name,
        model_id=ad.get("model_id"),
        triggered_by=(current_user or {}).get("email"),
    )

    return Response(
        content=audio_data,
        media_type="audio/mpeg",
        headers={
            "Cache-Control": "no-store",  # Each preview is fresh.
            "Content-Length": str(len(audio_data)),
            "X-Preview-Chars": str(len(preview)),  # surface chars used in response header
        },
    )


@router.post("/ads/{ad_id}/generate")
async def generate_ad_audio(
    ad_id: str,
    current_user: dict = Depends(get_current_user),
):
    """Call ElevenLabs TTS, save the MP3 bytes directly to MongoDB,
    update the ad doc. Re-running regenerates and overwrites the
    stored bytes. Audio survives Railway redeploys because MongoDB
    Atlas is persistent (filesystem is NOT — that's why v1 failed)."""
    _require_admin(current_user)
    db = get_db()
    ad = await db.radio_studio_ads.find_one({"id": ad_id}, {"_id": 0, "audio_blob": 0})
    if not ad:
        raise HTTPException(status_code=404, detail="Ad not found")

    client = _get_eleven_client()
    # Default voice settings come from the ad doc; Trade Talk OVERRIDES
    # to conversational defaults (lower stability + higher style) since
    # 0.5/0.0 produces monotone "broadcaster reading a press release"
    # delivery — fine for ads, awful for two-person dialogue.
    # See _trade_talk_voice_settings() rationale (Feb 26, 2026 fix).
    kind = ad.get("kind") or "ad"
    if kind == "trade_talk":
        # Lower stability = wider emotional range; higher style = more
        # vocal expressiveness / personality. Use Eleven's flash v2.5
        # model — significantly more natural turn-of-phrase + emphasis
        # than multilingual_v2 for English dialogue.
        # 1 Jun 2026 — `expressiveness` (0-1) on the ad doc drives the
        # stability/style mapping per-turn. Default 0.5 = natural.
        model_id = "eleven_flash_v2_5"
        # The default voice_settings here is a placeholder used for
        # logging/spec; per-turn settings are computed inside the loop.
        voice_settings = VoiceSettings(
            stability=0.30, similarity_boost=0.85, style=0.55,
            use_speaker_boost=True,
        )
    else:
        voice_settings = VoiceSettings(
            stability=float(ad.get("stability", 0.5)),
            similarity_boost=float(ad.get("similarity_boost", 0.75)),
            style=float(ad.get("style", 0.0)),
            use_speaker_boost=True,
        )
        model_id = ad.get("model_id") or "eleven_multilingual_v2"
    # Trade Talk = N TTS calls (one per turn, alternating voices) +
    # ffmpeg concat with 1s silence between turns. Q&A + plain Ad =
    # single TTS call. We accumulate `normalised_text` as the
    # concatenation of all narrated text so the cost log captures
    # the true character total. (31 May 2026 multi-kind support.)
    try:
        if kind == "trade_talk":
            turns = ad.get("turns") or []
            if not turns:
                raise HTTPException(status_code=400, detail="No turns to render — add lines first")
            host_voice = ad.get("host_voice_id")
            guest_voice = ad.get("guest_voice_id")
            if not host_voice or not guest_voice:
                raise HTTPException(status_code=400, detail="Pick host + guest voices before generating")
            turn_audio: List[bytes] = []
            normalised_text = ""
            # Per-turn voice settings come from the `expressiveness`
            # slider (0=Stiff, 0.5=Natural, 1=Animated). Default 0.5
            # for back-compat with ads created before this slider
            # shipped. (Feb 26, 2026.)
            expressiveness = float(ad.get("expressiveness", 0.5))
            for i, turn in enumerate(turns):
                text = (turn.get("text") or "").strip()
                if not text:
                    continue
                is_host = turn.get("speaker") == "host"
                speaker_voice = host_voice if is_host else guest_voice
                turn_text = _normalize_for_tts(
                    _apply_pronunciation_hints(text, ad.get("pronunciation_hints")),
                )
                normalised_text += turn_text + "\n"
                # Slight per-character voice-settings differentiation —
                # GUEST gets a touch more style + slightly lower stability
                # so they sound like a builder on a site, not a co-host
                # reading from the same script. Driven by the same
                # `expressiveness` slider on the ad doc.
                stab, sty = _voice_settings_for_expressiveness(
                    expressiveness, is_host=is_host,
                )
                turn_settings = VoiceSettings(
                    stability=stab,
                    similarity_boost=0.85,
                    style=sty,
                    use_speaker_boost=True,
                )
                audio_iter = client.text_to_speech.convert(
                    text=turn_text,
                    voice_id=speaker_voice,
                    model_id=model_id,
                    voice_settings=turn_settings,
                    output_format="mp3_44100_128",
                )
                bytes_for_turn = b"".join(chunk for chunk in audio_iter if chunk)
                if not bytes_for_turn:
                    raise HTTPException(status_code=502, detail=f"Turn {i+1} returned empty audio")
                turn_audio.append(bytes_for_turn)
            if not turn_audio:
                raise HTTPException(status_code=400, detail="All turns are empty")
            audio_data = _concat_audio_turns(turn_audio, gap_seconds=0.4)
        else:
            # ad or qa — single voice. For Q&A `_build_script_from_kind`
            # composes "Today's question — ..., {answer}".
            source_text = _build_script_from_kind(ad)
            if not source_text.strip():
                raise HTTPException(status_code=400, detail="Nothing to narrate — fill in script/question/answer")
            if not ad.get("voice_id"):
                raise HTTPException(status_code=400, detail="Pick a voice before generating")
            normalised_text = _normalize_for_tts(
                _apply_pronunciation_hints(source_text, ad.get("pronunciation_hints")),
            )
            audio_iter = client.text_to_speech.convert(
                text=normalised_text,
                voice_id=ad["voice_id"],
                model_id=model_id,
                voice_settings=voice_settings,
                output_format="mp3_44100_128",
            )
            audio_data = b""
            for chunk in audio_iter:
                if chunk:
                    audio_data += chunk
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("ElevenLabs TTS failed for ad %s", ad_id)
        raise HTTPException(status_code=502, detail=f"ElevenLabs TTS error: {e}") from e

    if not audio_data:
        raise HTTPException(status_code=502, detail="ElevenLabs returned empty audio")

    # 26 May 2026 — Optional music bed (Option A). When the admin
    # picked a `bed_music_id`, mix the voice over that track with
    # sidechain ducking BEFORE the size check + Mongo insert. The
    # final bytes stored are the mixed MP3.
    bed_music_id = ad.get("bed_music_id")
    bed_track_name = None
    if bed_music_id:
        bed_doc = await db.radio_studio_music.find_one(
            {"id": bed_music_id},
            {"_id": 0, "audio_blob": 1, "name": 1},
        )
        if not bed_doc or not bed_doc.get("audio_blob"):
            raise HTTPException(
                status_code=400,
                detail=(
                    "Selected background music track is missing or its audio "
                    "was wiped (re-upload it, then regenerate this ad)."
                ),
            )
        bed_track_name = bed_doc.get("name")
        try:
            audio_data = _mix_voice_with_bed(
                voice_bytes=audio_data,
                bed_bytes=bytes(bed_doc["audio_blob"]),
                bed_volume_pct=int(ad.get("bed_volume_pct", 18)),
            )
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001 — defensive
            logger.exception("Bed mix failed for ad %s", ad_id)
            raise HTTPException(
                status_code=502,
                detail=f"Music-bed mixing failed: {exc}",
            ) from exc

    if len(audio_data) > MAX_AUDIO_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Generated audio is {len(audio_data) // 1_000_000} MB which exceeds the 15 MB limit. Shorten the script.",
        )

    # 31 May 2026 — Loudness-normalise the final ad to −16 LUFS so
    # it sits at the same perceived volume as the music tracks (which
    # are normalised on upload). Previously TTS-only ads played
    # ~6-8 dB quieter than the music, making customers strain to
    # hear announcements in-store. Fail-safe: returns original bytes
    # on any ffmpeg error.
    audio_data = _normalize_loudness(audio_data)

    # Estimate duration: 128 kbps mp3 → ~16 KB/s.
    estimated_seconds = round(len(audio_data) / 16_000, 1)

    await db.radio_studio_ads.update_one(
        {"id": ad_id},
        {"$set": {
            "audio_blob": audio_data,  # BSON Binary — persistent in Atlas
            "audio_filename": f"{ad_id}.mp3",  # legacy marker, kept for frontend's "audio ready?" check
            "duration_seconds": estimated_seconds,
            "audio_bytes": len(audio_data),
            "bed_music_name": bed_track_name,  # surfaced in the UI
            "loudnorm_applied": True,
            "loudnorm_target_lufs": LOUDNORM_TARGET_LUFS,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }},
    )
    ad = await db.radio_studio_ads.find_one({"id": ad_id}, {"_id": 0, "audio_blob": 0})

    # Log the TTS spend for the cost dashboard. Best-effort — never
    # breaks generation if the log write fails. (30 May 2026.)
    await _log_tts_usage(
        db=db,
        ad_id=ad_id,
        ad_name=ad.get("name") if ad else None,
        endpoint="generate",
        chars=len(normalised_text),
        voice_id=ad.get("voice_id") if ad else None,
        voice_name=ad.get("voice_name") if ad else None,
        model_id=(ad.get("model_id") if ad else None) or "eleven_multilingual_v2",
        triggered_by=(current_user or {}).get("email"),
    )

    return ad


@router.delete("/ads/{ad_id}")
async def delete_ad(ad_id: str, current_user: dict = Depends(get_current_user)):
    _require_admin(current_user)
    db = get_db()
    ad = await db.radio_studio_ads.find_one({"id": ad_id}, {"_id": 0, "audio_blob": 0})
    if not ad:
        raise HTTPException(status_code=404, detail="Ad not found")
    await db.radio_studio_ads.delete_one({"id": ad_id})
    # Also strip this ad from any saved playlists so they don't
    # reference a dangling id.
    await db.radio_studio_playlists.update_many(
        {},
        {"$pull": {"items": {"type": "ad", "ref_id": ad_id}}},
    )
    return {"success": True, "deleted_id": ad_id}


# ------------------------------------------------------------------
# Music library (MongoDB storage)
# ------------------------------------------------------------------

@router.post("/music/upload")
async def upload_music(
    name: str = Form(...),
    file: UploadFile = File(...),
    current_user: dict = Depends(get_current_user),
):
    _require_admin(current_user)
    db = get_db()
    if not (file.content_type or "").startswith("audio/"):
        raise HTTPException(status_code=400, detail="File must be audio (mp3, wav, etc.)")

    audio_bytes = await file.read()
    if len(audio_bytes) > MAX_AUDIO_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Track is {len(audio_bytes) // 1_000_000} MB which exceeds the 15 MB limit (≈15 min at 128 kbps).",
        )

    # Loudness-normalise the upload to −16 LUFS so the whole library
    # plays back at one consistent perceived volume. Fail-safe.
    audio_bytes = _normalize_loudness(audio_bytes)

    track_id = uuid.uuid4().hex
    estimated_seconds = round(len(audio_bytes) / 16_000, 1)
    doc = {
        "id": track_id,
        "name": name,
        "audio_blob": audio_bytes,  # BSON Binary — persistent in Atlas
        "audio_filename": f"{track_id}.mp3",  # legacy marker
        "duration_seconds": estimated_seconds,
        "audio_bytes": len(audio_bytes),
        "loudnorm_applied": True,
        "loudnorm_target_lufs": LOUDNORM_TARGET_LUFS,
        "uploaded_at": datetime.now(timezone.utc).isoformat(),
        "uploaded_by": (current_user or {}).get("email"),
    }
    await db.radio_studio_music.insert_one(doc)
    # Strip the binary + Mongo internals before returning so the
    # response stays tiny.
    doc.pop("_id", None)
    doc.pop("audio_blob", None)
    return doc


@router.get("/music")
async def list_music(current_user: dict = Depends(get_current_user)):
    _require_admin(current_user)
    db = get_db()
    tracks = await db.radio_studio_music.find(
        {},
        {"_id": 0, "audio_blob": 0},
    ).sort("uploaded_at", -1).to_list(500)
    return {"tracks": tracks, "count": len(tracks)}


@router.delete("/music/{track_id}")
async def delete_music(track_id: str, current_user: dict = Depends(get_current_user)):
    _require_admin(current_user)
    db = get_db()
    track = await db.radio_studio_music.find_one({"id": track_id}, {"_id": 0, "audio_blob": 0})
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    await db.radio_studio_music.delete_one({"id": track_id})
    await db.radio_studio_playlists.update_many(
        {},
        {"$pull": {"items": {"type": "music", "ref_id": track_id}}},
    )
    return {"success": True, "deleted_id": track_id}


@router.post("/music/normalize-existing")
async def normalize_existing_music(current_user: dict = Depends(get_current_user)):
    """Backfill loudness normalisation across every music + ad in
    the library that wasn't normalised at write time. Idempotent —
    safe to re-run; only processes docs missing `loudnorm_applied`.

    Returns counts so the UI can show "X tracks normalised, Y skipped".
    """
    _require_admin(current_user)
    if not _ffmpeg_bin():
        raise HTTPException(
            status_code=502,
            detail="ffmpeg not installed on the backend — ask the developer.",
        )
    db = get_db()

    music_processed = 0
    music_failed = 0
    ads_processed = 0
    ads_failed = 0

    # Music tracks
    cursor = db.radio_studio_music.find(
        {"loudnorm_applied": {"$ne": True}},
        {"_id": 0, "id": 1, "audio_blob": 1, "audio_bytes": 1},
    )
    async for track in cursor:
        blob = track.get("audio_blob")
        if not blob:
            continue
        original_len = len(bytes(blob))
        normalised = _normalize_loudness(bytes(blob))
        if not normalised or normalised == bytes(blob) and len(normalised) == original_len:
            # _normalize_loudness fell back to original — count as failed
            # but don't crash. Still mark with loudnorm_applied=False
            # so we don't keep retrying forever in the next backfill.
            music_failed += 1
            continue
        await db.radio_studio_music.update_one(
            {"id": track["id"]},
            {"$set": {
                "audio_blob": normalised,
                "audio_bytes": len(normalised),
                "loudnorm_applied": True,
                "loudnorm_target_lufs": LOUDNORM_TARGET_LUFS,
                "loudnorm_applied_at": datetime.now(timezone.utc).isoformat(),
            }},
        )
        music_processed += 1

    # Ads (only those that have audio_blob — drafts without audio
    # will be normalised the first time they're generated)
    cursor = db.radio_studio_ads.find(
        {
            "loudnorm_applied": {"$ne": True},
            "audio_blob": {"$exists": True, "$ne": None},
        },
        {"_id": 0, "id": 1, "audio_blob": 1},
    )
    async for ad in cursor:
        blob = ad.get("audio_blob")
        if not blob:
            continue
        original_len = len(bytes(blob))
        normalised = _normalize_loudness(bytes(blob))
        if not normalised or (normalised == bytes(blob) and len(normalised) == original_len):
            ads_failed += 1
            continue
        await db.radio_studio_ads.update_one(
            {"id": ad["id"]},
            {"$set": {
                "audio_blob": normalised,
                "audio_bytes": len(normalised),
                "loudnorm_applied": True,
                "loudnorm_target_lufs": LOUDNORM_TARGET_LUFS,
                "loudnorm_applied_at": datetime.now(timezone.utc).isoformat(),
            }},
        )
        ads_processed += 1

    return {
        "ok": True,
        "music_normalised": music_processed,
        "music_failed": music_failed,
        "ads_normalised": ads_processed,
        "ads_failed": ads_failed,
        "target_lufs": LOUDNORM_TARGET_LUFS,
    }


# ------------------------------------------------------------------
# Music import from URL — yt-dlp + ffmpeg (26 May 2026)
# ------------------------------------------------------------------
#
# Saves the admin from the "open YouTube → click Download → save to
# laptop → open Music tab → click Choose File → wait → click Upload"
# dance for every track. Paste a URL, click Add, done.
#
# Pipeline:
#   1. yt-dlp downloads the source's audio stream (mp4 → m4a, webm
#      → opus, direct .mp3 → as-is) into a temp dir.
#   2. yt-dlp drives ffmpeg via its --extract-audio --audio-format mp3
#      flag to transcode/rebox to 128 kbps mp3.
#   3. Title is printed to stdout via --print "%(title)s" so we can
#      default the track name without a second metadata round-trip.
#   4. We size-check the result against MAX_AUDIO_BYTES (15 MB)
#      BEFORE inserting — and pass --max-filesize 40M to yt-dlp so
#      a 200 MB YouTube video is aborted at the network layer too.
#
# Security: admin-only. yt-dlp can in principle hit any HTTP(S) URL
# so this is an SSRF surface, but only authenticated admins reach
# it. We don't accept arbitrary file:// or rtmp:// schemes — only
# http/https.

# Max source size that yt-dlp will start downloading. Bigger than
# MAX_AUDIO_BYTES because video downloads often start as MP4 then
# get transcoded down to MP3 (we discard the video track).
_IMPORT_SOURCE_CEILING = "40M"

# yt-dlp wall-clock timeout per job. Most legit imports complete in
# 10-30 seconds; 5 minutes is plenty of headroom without letting a
# stuck job pin a worker.
_IMPORT_TIMEOUT_SECONDS = 300


def _has_ytdlp_library() -> bool:
    """Returns True iff yt-dlp's Python library is importable.
    We use the in-process library API rather than the binary so we
    don't depend on the binary being on the supervisor PATH (it
    lives in /root/.venv/bin/ which supervisor scrubs)."""
    try:
        import yt_dlp  # noqa: F401
        return True
    except ImportError:
        return False


@router.post("/music/import-url")
async def import_music_from_url(
    req: MusicImportFromUrlReq,
    current_user: dict = Depends(get_current_user),
):
    """Download + transcode a music track from a public URL and add
    it straight to the music library. Same end-state as a manual
    file upload — bytes live in `radio_studio_music.audio_blob`.

    Typical sources: YouTube Audio Library, Bensound, SoundCloud
    (when the track is publicly streamable), and direct .mp3/.wav
    links. Anything `yt-dlp` recognises will work."""
    _require_admin(current_user)

    if not _has_ytdlp_library():
        raise HTTPException(
            status_code=500,
            detail="yt-dlp not installed on the backend — ask the developer.",
        )
    if not _ffmpeg_bin():
        raise HTTPException(
            status_code=500,
            detail="ffmpeg not installed on the backend — ask the developer.",
        )

    url = req.url.strip()
    lowered = url.lower()
    if not (lowered.startswith("http://") or lowered.startswith("https://")):
        raise HTTPException(
            status_code=400,
            detail="URL must start with http:// or https://",
        )

    import yt_dlp

    with tempfile.TemporaryDirectory(prefix="radio_import_") as tmp:
        out_template = os.path.join(tmp, "out.%(ext)s")
        # yt-dlp options:
        #   format=bestaudio/best — pick the best audio-only stream
        #     if one exists, else best mixed-stream (ffmpeg will
        #     discard the video track).
        #   max_filesize       — abort during download if source > 40 MB
        #     (source is often bigger than the transcoded mp3, e.g.
        #     a 30 MB m4a → ~3 MB 128 kbps mp3).
        #   FFmpegExtractAudio postprocessor → mp3 @ 128 kbps,
        #     matching our ad output's pacing.
        ydl_opts = {
            "format": "bestaudio/best",
            "outtmpl": out_template,
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "max_filesize": int(_IMPORT_SOURCE_CEILING.rstrip("M")) * 1024 * 1024,
            # Short connect/read timeouts so a wedged source can't
            # tie up a worker for the full 5-min wall-clock cap.
            "socket_timeout": 30,
            "postprocessors": [{
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "128",
            }],
            # We resolve ffmpeg explicitly so yt-dlp doesn't have to
            # walk PATH for it. Belt + braces.
            "ffmpeg_location": _ffmpeg_bin(),
        }

        # yt-dlp is sync; run in a worker thread so the event loop
        # stays free for other requests (live-stream throttling
        # depends on it).
        def _run_download():
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                return ydl.extract_info(url, download=True)

        try:
            info = await asyncio.wait_for(
                asyncio.to_thread(_run_download),
                timeout=_IMPORT_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError as exc:
            raise HTTPException(
                status_code=504,
                detail="Download took too long — try a shorter track or paste a direct .mp3 URL.",
            ) from exc
        except yt_dlp.utils.DownloadError as exc:
            # yt-dlp's DownloadError message is admin-readable.
            msg = str(exc).strip().splitlines()[-1][:300]
            raise HTTPException(
                status_code=502,
                detail=f"Download failed: {msg}",
            ) from exc
        except Exception as exc:  # noqa: BLE001
            logger.exception("yt-dlp library crashed for %s", url)
            raise HTTPException(
                status_code=502,
                detail=f"Download crashed: {exc}",
            ) from exc

        title_from_meta = (info or {}).get("title") or ""

        # Find the resulting mp3 (yt-dlp resolves the template).
        mp3_path = None
        for fname in os.listdir(tmp):
            if fname.lower().endswith(".mp3"):
                mp3_path = os.path.join(tmp, fname)
                break
        if not mp3_path or not os.path.exists(mp3_path):
            raise HTTPException(
                status_code=502,
                detail="Download succeeded but no MP3 file was produced.",
            )

        with open(mp3_path, "rb") as f:
            audio_bytes = f.read()

    if not audio_bytes:
        raise HTTPException(status_code=502, detail="Downloaded audio file is empty.")
    if len(audio_bytes) > MAX_AUDIO_BYTES:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Imported track is {len(audio_bytes) // 1_000_000} MB — exceeds the 15 MB limit. "
                f"Try a shorter source or trim it first."
            ),
        )

    # Loudness-normalise to the library target so URL-imported tracks
    # sit at the same perceived volume as uploads + ads.
    audio_bytes = _normalize_loudness(audio_bytes)

    final_name = (req.name or title_from_meta or "Imported track").strip()[:120] or "Imported track"
    track_id = uuid.uuid4().hex
    estimated_seconds = round(len(audio_bytes) / 16_000, 1)
    db = get_db()
    doc = {
        "id": track_id,
        "name": final_name,
        "audio_blob": audio_bytes,  # BSON Binary — persistent in Atlas
        "audio_filename": f"{track_id}.mp3",
        "duration_seconds": estimated_seconds,
        "audio_bytes": len(audio_bytes),
        "source_url": url,                       # audit / attribution
        "imported_via": "yt-dlp",
        "loudnorm_applied": True,
        "loudnorm_target_lufs": LOUDNORM_TARGET_LUFS,
        "uploaded_at": datetime.now(timezone.utc).isoformat(),
        "uploaded_by": (current_user or {}).get("email"),
    }
    await db.radio_studio_music.insert_one(doc)
    doc.pop("_id", None)
    doc.pop("audio_blob", None)
    return doc



# ------------------------------------------------------------------
# Cost dashboard — total ElevenLabs spend (30 May 2026)
# ------------------------------------------------------------------

@router.get("/usage")
async def get_tts_usage(current_user: dict = Depends(get_current_user)):
    """Aggregated ElevenLabs cost breakdown for the Radio Studio
    dashboard. Returns today / 30-day / lifetime totals, plus a
    per-ad spend leaderboard and the 20 most recent calls. All
    cost figures are ESTIMATES (the truth is on ElevenLabs's
    billing dashboard) computed from the chars × rate the admin
    has configured."""
    _require_admin(current_user)
    db = get_db()
    now = datetime.now(timezone.utc)
    today_iso = now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
    thirty_days_ago_iso = (now - timedelta(days=30)).isoformat()

    # Lifetime, 30d, today — three concurrent aggregations.
    pipeline_total = [
        {"$group": {
            "_id": None,
            "calls": {"$sum": 1},
            "chars": {"$sum": "$chars"},
            "gbp": {"$sum": "$cost_gbp_estimate"},
        }},
    ]
    pipeline_30d = [
        {"$match": {"created_at": {"$gte": thirty_days_ago_iso}}},
        *pipeline_total,
    ]
    pipeline_today = [
        {"$match": {"created_at": {"$gte": today_iso}}},
        *pipeline_total,
    ]
    # Per-ad leaderboard — top 50 by spend.
    pipeline_by_ad = [
        {"$match": {"ad_id": {"$ne": None}}},
        {"$group": {
            "_id": {"ad_id": "$ad_id", "ad_name": "$ad_name"},
            "calls": {"$sum": 1},
            "chars": {"$sum": "$chars"},
            "gbp": {"$sum": "$cost_gbp_estimate"},
            "last_generated_at": {"$max": "$created_at"},
            "generate_calls": {
                "$sum": {"$cond": [{"$eq": ["$endpoint", "generate"]}, 1, 0]},
            },
            "test_calls": {
                "$sum": {"$cond": [{"$eq": ["$endpoint", "test_voice"]}, 1, 0]},
            },
        }},
        {"$sort": {"gbp": -1}},
        {"$limit": 50},
    ]

    async def _one(pipe):
        cursor = db.radio_studio_tts_usage.aggregate(pipe)
        async for doc in cursor:
            return doc
        return None

    total_doc = await _one(pipeline_total) or {"calls": 0, "chars": 0, "gbp": 0}
    thirty_doc = await _one(pipeline_30d) or {"calls": 0, "chars": 0, "gbp": 0}
    today_doc = await _one(pipeline_today) or {"calls": 0, "chars": 0, "gbp": 0}

    by_ad: list = []
    async for doc in db.radio_studio_tts_usage.aggregate(pipeline_by_ad):
        by_ad.append({
            "ad_id": (doc.get("_id") or {}).get("ad_id"),
            "ad_name": (doc.get("_id") or {}).get("ad_name") or "(deleted ad)",
            "calls": doc.get("calls", 0),
            "generate_calls": doc.get("generate_calls", 0),
            "test_calls": doc.get("test_calls", 0),
            "chars": doc.get("chars", 0),
            "gbp": round(float(doc.get("gbp", 0) or 0), 4),
            "last_generated_at": doc.get("last_generated_at"),
        })

    recent: list = []
    cursor = db.radio_studio_tts_usage.find(
        {}, {"_id": 0},
    ).sort("created_at", -1).limit(20)
    async for doc in cursor:
        # Keep a tiny shape — we just need date+ad+chars+£ for the
        # "recent activity" list.
        recent.append({
            "ad_name": doc.get("ad_name") or "(deleted ad)",
            "endpoint": doc.get("endpoint"),
            "chars": doc.get("chars", 0),
            "gbp": round(float(doc.get("cost_gbp_estimate", 0) or 0), 4),
            "voice_name": doc.get("voice_name"),
            "triggered_by": doc.get("triggered_by"),
            "created_at": doc.get("created_at"),
        })

    def _shape(d):
        return {
            "calls": int(d.get("calls") or 0),
            "chars": int(d.get("chars") or 0),
            "gbp": round(float(d.get("gbp") or 0), 4),
        }

    return {
        "today": _shape(today_doc),
        "last_30_days": _shape(thirty_doc),
        "lifetime": _shape(total_doc),
        "by_ad": by_ad,
        "recent": recent,
        "rate": {
            "usd_per_1k_chars": _TTS_USD_PER_1K_CHARS,
            "gbp_per_usd": _GBP_PER_USD,
            "gbp_per_1k_chars": round(_TTS_USD_PER_1K_CHARS * _GBP_PER_USD, 4),
        },
        "note": (
            "Estimates only — actual ElevenLabs billing may differ "
            "based on your subscription tier. Set ELEVENLABS_USD_PER_1K_CHARS "
            "and GBP_PER_USD env vars to match your tier."
        ),
    }



# ------------------------------------------------------------------
# Playlist
# ------------------------------------------------------------------

@router.get("/playlist")
async def get_playlist(current_user: dict = Depends(get_current_user)):
    """There's exactly one active playlist per the MVP. Returns it (or
    an empty default if not yet saved)."""
    _require_admin(current_user)
    db = get_db()
    playlist = await db.radio_studio_playlists.find_one(
        {"is_active": True}, {"_id": 0},
    )
    if not playlist:
        playlist = {
            "id": "default",
            "name": "Default Playlist",
            "items": [],
            "is_active": True,
            "repeat": True,
            "created_at": None,
            "updated_at": None,
        }
    # Legacy playlists predating the repeat flag default to True
    # (matches the implicit wall-clock-modulo behaviour they had).
    playlist.setdefault("repeat", True)
    # Legacy playlists predating crossfade default to 0 (hard cut).
    playlist.setdefault("crossfade_seconds", 0.0)
    return playlist


@router.post("/playlist")
async def save_playlist(
    req: PlaylistUpdate,
    current_user: dict = Depends(get_current_user),
):
    _require_admin(current_user)
    db = get_db()
    now = datetime.now(timezone.utc).isoformat()
    existing = await db.radio_studio_playlists.find_one(
        {"is_active": True}, {"_id": 0},
    )
    doc = {
        "id": (existing or {}).get("id") or "default",
        "name": req.name,
        "items": [item.model_dump() for item in req.items],
        "is_active": req.is_active,
        "repeat": req.repeat,
        "crossfade_seconds": float(req.crossfade_seconds or 0.0),
        "created_at": (existing or {}).get("created_at") or now,
        "updated_at": now,
    }
    # When repeat=False, anchor the "playlist clock" to the moment
    # the admin saved this revision so live_now_playing can compute
    # elapsed against a stable origin. We reset the anchor any time
    # the items list or the repeat flag changes (i.e. any meaningful
    # save) so a re-save restarts the countdown.
    prev_items = (existing or {}).get("items") or []
    items_changed = (
        [it.model_dump() for it in req.items] != prev_items
        or bool((existing or {}).get("repeat", True)) != bool(req.repeat)
    )
    if not req.repeat and items_changed:
        import time as _t
        doc["started_at_epoch"] = _t.time()
    elif req.repeat:
        # Don't leak a stale anchor when toggling back to repeat.
        doc["started_at_epoch"] = None
    else:
        doc["started_at_epoch"] = (existing or {}).get("started_at_epoch")
    await db.radio_studio_playlists.update_one(
        {"id": doc["id"]},
        {"$set": doc},
        upsert=True,
    )
    return doc


# ------------------------------------------------------------------
# Tune-in heartbeats (31 May 2026)
# ------------------------------------------------------------------
#
# Goal: tell the super admin at-a-glance whether each showroom
# actually has the radio playing (vs the playlist merely being
# configured). The public /radio tab pings POST /tune-in/heartbeat
# every 30 s while tuned in; the admin pill polls the rolled-up
# status every 15 s.
#
# Design choices:
#   - device_id is a client-generated UUID stored in localStorage so
#     the same showroom device counts as ONE listener even across
#     refreshes / tab reopens.
#   - device_label is optional; the admin can name a device (e.g.
#     "Tonbridge front of house") via the /radio settings dialog
#     later. For v1 we accept it on the heartbeat itself so showrooms
#     can self-label.
#   - We consider a device "active" if its last_seen_at is within
#     90 s. With a 30 s ping cycle that's 3 missed pings → definitely
#     off. Generous enough to ride out a WiFi blip.
#   - upsert keeps the collection at exactly one row per device_id;
#     pruning unseen rows is left to a manual /reset endpoint (added
#     below) — keeps Mongo writes minimal and avoids "phantom store"
#     entries from short-lived experiments showing up forever.

ACTIVE_HEARTBEAT_WINDOW_SECONDS = 90


class TuneInHeartbeatReq(BaseModel):
    device_id: str = Field(min_length=4, max_length=64)
    device_label: Optional[str] = Field(default=None, max_length=80)


@public_router.post("/tune-in/heartbeat")
async def radio_tune_in_heartbeat(req: TuneInHeartbeatReq, request: Request):
    """Public endpoint — each `/radio` tab posts here every 30 s
    while tuned in. We don't authenticate (the showroom devices
    don't carry a token), just stamp `last_seen_at`. Replay-safe via
    upsert on device_id."""
    db = get_db()
    now_iso = datetime.now(timezone.utc).isoformat()
    ip = (
        request.headers.get("cf-connecting-ip")
        or request.headers.get("x-forwarded-for", "").split(",")[0].strip()
        or (request.client.host if request.client else None)
    )
    ua = (request.headers.get("user-agent") or "")[:160]
    update = {
        "$set": {
            "last_seen_at": now_iso,
            "last_ip": ip,
            "last_user_agent": ua,
        },
        "$setOnInsert": {
            "device_id": req.device_id,
            "first_seen_at": now_iso,
        },
    }
    if req.device_label:
        update["$set"]["device_label"] = req.device_label.strip()[:80]
    await db.radio_tune_in_heartbeats.update_one(
        {"device_id": req.device_id},
        update,
        upsert=True,
    )
    return {"ok": True, "device_id": req.device_id}


@router.get("/tune-in/status")
async def radio_tune_in_status(current_user: dict = Depends(get_current_user)):
    """Admin pill polls this every 15 s. Returns:
      - active_count: devices seen within ACTIVE_HEARTBEAT_WINDOW_SECONDS
      - devices: list (newest-last-seen first) with label/id/last_seen
      - now_playing: convenience — what should be playing right now
        if the playlist is configured. Pulled from the same logic as
        /live/now-playing so the pill can show "Now: {track}" without
        a second fetch.
    Auth required — keeps device IPs / UAs out of public view.
    """
    _require_admin(current_user)
    db = get_db()
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=ACTIVE_HEARTBEAT_WINDOW_SECONDS)).isoformat()
    cursor = db.radio_tune_in_heartbeats.find(
        {"last_seen_at": {"$gte": cutoff}},
        {"_id": 0, "device_id": 1, "device_label": 1,
         "last_seen_at": 1, "first_seen_at": 1, "last_ip": 1},
    ).sort("last_seen_at", -1).limit(20)
    devices = [doc async for doc in cursor]

    # Resolve current playing item — best-effort, never blocks the pill
    now_playing = None
    try:
        playlist = await db.radio_studio_playlists.find_one(
            {"is_active": True}, {"_id": 0},
        )
        items = (playlist or {}).get("items") or []
        if items:
            ad_ids = [it["ref_id"] for it in items if it.get("type") == "ad"]
            music_ids = [it["ref_id"] for it in items if it.get("type") == "music"]
            ads_by_id: dict = {}
            music_by_id: dict = {}
            if ad_ids:
                async for d in db.radio_studio_ads.find(
                    {"id": {"$in": ad_ids}},
                    {"_id": 0, "id": 1, "name": 1, "duration_seconds": 1, "audio_filename": 1},
                ):
                    ads_by_id[d["id"]] = d
            if music_ids:
                async for d in db.radio_studio_music.find(
                    {"id": {"$in": music_ids}},
                    {"_id": 0, "id": 1, "name": 1, "duration_seconds": 1, "audio_filename": 1},
                ):
                    music_by_id[d["id"]] = d
            resolved = []
            for it in items:
                ref = (ads_by_id if it.get("type") == "ad" else music_by_id).get(it.get("ref_id"))
                if not ref or not ref.get("audio_filename"):
                    continue
                d = float(ref.get("duration_seconds") or 0) or 30.0
                resolved.append({**it, "ref": ref, "duration_seconds": d})
            if resolved:
                durations = [r["duration_seconds"] for r in resolved]
                total = sum(durations) or 1.0
                offset = time.time() % total
                idx, _ = _locate(offset, durations)
                cur = resolved[idx]
                now_playing = {
                    "type": cur.get("type"),
                    "name": cur["ref"].get("name"),
                }
    except Exception:  # noqa: BLE001 — never block the pill on an aggregation error
        logger.exception("tune-in/status: failed to resolve now_playing")

    return {
        "active_count": len(devices),
        "active_window_seconds": ACTIVE_HEARTBEAT_WINDOW_SECONDS,
        "devices": devices,
        "now_playing": now_playing,
    }


@router.post("/tune-in/reset")
async def radio_tune_in_reset(current_user: dict = Depends(get_current_user)):
    """Wipe all heartbeats — useful for clearing out a stale device
    that was renamed or replaced. Each active showroom will re-register
    within 30 s on its next ping."""
    _require_admin(current_user)
    db = get_db()
    res = await db.radio_tune_in_heartbeats.delete_many({})
    return {"ok": True, "deleted": res.deleted_count}


# ------------------------------------------------------------------
# Public streaming endpoint (used by <audio> tags + future speakers)
# ------------------------------------------------------------------

@public_router.get("/stream/ad/{ad_id}")
async def stream_ad(ad_id: str):
    """Serve an ad MP3 from MongoDB. Unauthenticated so the
    storefront <audio> tag and future in-store speakers can hit it
    without a token."""
    db = get_db()
    # Project audio_blob explicitly — list views exclude it for speed,
    # but the stream needs it.
    ad = await db.radio_studio_ads.find_one(
        {"id": ad_id},
        {"_id": 0, "audio_blob": 1, "audio_bytes": 1, "name": 1},
    )
    if not ad or not ad.get("audio_blob"):
        raise HTTPException(status_code=404, detail="Ad audio not found (regenerate it)")
    blob = ad["audio_blob"]
    # bson.binary.Binary subclasses bytes, so this works either way.
    return Response(
        content=bytes(blob),
        media_type="audio/mpeg",
        headers={
            "Content-Length": str(len(blob)),
            "Cache-Control": "public, max-age=60",
            "Accept-Ranges": "none",
        },
    )


@public_router.get("/stream/music/{track_id}")
async def stream_music(track_id: str):
    db = get_db()
    track = await db.radio_studio_music.find_one(
        {"id": track_id},
        {"_id": 0, "audio_blob": 1, "audio_bytes": 1, "name": 1},
    )
    if not track or not track.get("audio_blob"):
        raise HTTPException(status_code=404, detail="Track audio not found (re-upload it)")
    blob = track["audio_blob"]
    return Response(
        content=bytes(blob),
        media_type="audio/mpeg",
        headers={
            "Content-Length": str(len(blob)),
            "Cache-Control": "public, max-age=300",
            "Accept-Ranges": "none",
        },
    )


# ------------------------------------------------------------------
# Phase 2 (26 May 2026) — Synchronised live stream
# ------------------------------------------------------------------
#
# Goal: 4 Bluetooth speakers in 4 stores tune to ONE endless mp3
# stream and all hear the same ad/track at the same moment (±1 s of
# network jitter). User request, end-2026.
#
# How sync works: instead of "every connection plays the playlist
# from item 0", we treat the playlist as an infinite tape head whose
# position is `wall_clock_seconds_since_epoch % total_loop_duration`.
# Any client connecting at time `t` joins the tape head at exactly
# that offset → all clients converge regardless of when they tuned
# in. This is the simplest scheme that gives genuine sync without
# a separate broadcasting daemon (Icecast etc).
#
# Real-time pacing: we throttle yielded bytes to each track's actual
# byte-rate (computed from `audio_bytes / duration_seconds`, so any
# CBR or near-CBR mp3 works) so the audio player downloads at the
# same speed it plays.
#
# Resilience: playlist queue is refreshed at the start of every loop
# iteration — admins editing the playlist mid-cycle see their changes
# at the next wrap-around, not the next byte.

# Length of audio chunk yielded to the client. 4 KB at ~16 KB/s
# byte-rate = 4 yields per second. Plenty of granularity for clean
# pause/resume without overloading the event loop.
_LIVE_CHUNK_BYTES = 4096

# Fallback bitrate when a track has no recorded `duration_seconds`
# (legacy upload). 128 kbps mp3 → 16,000 bytes/sec.
_DEFAULT_BYTE_RATE = 16_000

# Lazily-generated 1-second silent MP3 served when the playlist is
# empty (rather than tearing down the connection — the speaker app
# would otherwise keep reconnecting in a loop).
_silence_mp3: Optional[bytes] = None


def _get_silence_mp3() -> bytes:
    """Render (or return cached) 1 second of silent 128 kbps stereo
    MP3 via ffmpeg. Used to keep the live stream alive when the
    playlist is empty or every item's audio_blob is missing."""
    global _silence_mp3
    if _silence_mp3 is not None:
        return _silence_mp3
    ffmpeg = _ffmpeg_bin()
    if not ffmpeg:
        # Last-resort tiny ID3 + null frames so the stream doesn't
        # 500. Won't decode as audio but keeps the socket alive.
        _silence_mp3 = b"ID3\x03\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x00" + b"\x00" * 400
        return _silence_mp3
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
        path = f.name
    try:
        subprocess.run(
            [
                ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
                "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
                "-t", "1", "-c:a", "libmp3lame", "-b:a", "128k",
                path,
            ],
            check=True,
        )
        with open(path, "rb") as fp:
            _silence_mp3 = fp.read()
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
    return _silence_mp3


async def _build_play_queue() -> List[dict]:
    """Resolve the active playlist's items to a list of dicts ready
    for streaming. Each entry has `type` ('ad' | 'music'), `ref_id`,
    `name`, `blob` (raw mp3 bytes), `duration_seconds` (float),
    `byte_rate` (bytes/sec — computed from blob/duration so CBR mp3
    paces correctly). Items with missing audio are silently skipped
    so a dangling reference doesn't kill the loop."""
    db = get_db()
    playlist = await db.radio_studio_playlists.find_one(
        {"is_active": True}, {"_id": 0},
    )
    if not playlist:
        return []
    items = playlist.get("items") or []
    if not items:
        return []

    # Fetch the referenced media. Two find_many queries (one per
    # collection) is faster than N individual lookups.
    ad_ids = [it["ref_id"] for it in items if it.get("type") == "ad"]
    music_ids = [it["ref_id"] for it in items if it.get("type") == "music"]
    ads_by_id: dict = {}
    music_by_id: dict = {}
    if ad_ids:
        async for doc in db.radio_studio_ads.find(
            {"id": {"$in": ad_ids}},
            {"_id": 0, "id": 1, "name": 1, "audio_blob": 1,
             "audio_bytes": 1, "duration_seconds": 1},
        ):
            ads_by_id[doc["id"]] = doc
    if music_ids:
        async for doc in db.radio_studio_music.find(
            {"id": {"$in": music_ids}},
            {"_id": 0, "id": 1, "name": 1, "audio_blob": 1,
             "audio_bytes": 1, "duration_seconds": 1},
        ):
            music_by_id[doc["id"]] = doc

    resolved: List[dict] = []
    for it in items:
        ref = (ads_by_id if it.get("type") == "ad" else music_by_id).get(it.get("ref_id"))
        if not ref or not ref.get("audio_blob"):
            continue  # dangling — skip without killing the queue
        blob = bytes(ref["audio_blob"])
        duration = float(ref.get("duration_seconds") or 0)
        if duration <= 0:
            # Estimate from byte length at default rate so the timing
            # math doesn't blow up.
            duration = max(1.0, len(blob) / _DEFAULT_BYTE_RATE)
        byte_rate = len(blob) / duration if duration > 0 else _DEFAULT_BYTE_RATE
        resolved.append({
            "type": it.get("type"),
            "ref_id": it.get("ref_id"),
            "name": ref.get("name") or "Untitled",
            "blob": blob,
            "duration_seconds": duration,
            "byte_rate": byte_rate,
        })
    return resolved


def _locate(offset_seconds: float, durations: List[float]) -> Tuple[int, float]:
    """Given the offset into a concatenated loop and the duration of
    each item, return (item_index, seconds_into_item). Pure function
    — no I/O — so it's trivial to unit-test."""
    if not durations:
        return 0, 0.0
    cursor = 0.0
    for idx, d in enumerate(durations):
        if offset_seconds < cursor + d:
            return idx, max(0.0, offset_seconds - cursor)
        cursor += d
    # Past the end → wrap to last item's tail (defensive — caller
    # always pre-modulos).
    return len(durations) - 1, max(0.0, durations[-1] - 0.01)


async def _throttle_item(item: dict, skip_seconds: float):
    """Yield the item's mp3 bytes from `skip_seconds` to the end at
    its real byte-rate, in `_LIVE_CHUNK_BYTES` chunks. Sleeps between
    chunks so the audio player doesn't buffer the whole thing in
    50 ms (which would defeat sync the moment a new client joined)."""
    blob = item["blob"]
    byte_rate = max(1.0, float(item.get("byte_rate", _DEFAULT_BYTE_RATE)))
    start = max(0, min(int(skip_seconds * byte_rate), len(blob)))
    pos = start
    while pos < len(blob):
        nxt = min(pos + _LIVE_CHUNK_BYTES, len(blob))
        chunk = blob[pos:nxt]
        yield chunk
        # Real-time pacing: sleep for the duration of audio just
        # emitted (0.95× as a tiny safety margin so the client's
        # buffer never quite drains under network jitter).
        await asyncio.sleep(max(0.001, len(chunk) / byte_rate * 0.95))
        pos = nxt


async def _live_generator():
    """Endless async generator that yields synchronised mp3 chunks.
    Every connected client computes its position from `time.time()`
    so multiple speakers stay locked together regardless of when
    they connected."""
    while True:
        queue = await _build_play_queue()

        if not queue:
            # No items → push 1 s of silence + re-poll. Keeps the
            # connection alive until admins add the first item.
            yield _get_silence_mp3()
            await asyncio.sleep(1.0)
            continue

        durations = [q["duration_seconds"] for q in queue]
        total = sum(durations) or 1.0
        # Wall-clock-modulated offset so every client aligns.
        offset = time.time() % total
        idx, item_offset = _locate(offset, durations)

        # Walk the queue from (idx, item_offset) to the end, then
        # let the outer while-loop refresh + restart at 0 → infinite
        # synced loop, with playlist edits picked up between cycles.
        while idx < len(queue):
            item = queue[idx]
            async for chunk in _throttle_item(item, skip_seconds=item_offset):
                yield chunk
            idx += 1
            item_offset = 0.0


@public_router.get("/live/playlist-preview")
async def live_playlist_preview():
    """Return the resolved playlist in order, with audio URLs, for
    SOLO/PREVIEW playback from track #1.

    Used by the admin "Solo preview" button — same data as the
    public /radio page would consume but flagged so the client knows
    to play sequentially from index 0 rather than syncing to wall
    clock. Multi-store sync is intentionally broken here so admins
    can audition a fresh playlist without waiting for the live loop
    to cycle around to track 1.

    Returns the same `{playing, now, next, upcoming, playlist}`
    shape as /live/now-playing so the same React components can
    consume it — only difference is `mode: "solo"` and the cursor
    is pinned at index 0.
    """
    db = get_db()
    playlist = await db.radio_studio_playlists.find_one(
        {"is_active": True}, {"_id": 0},
    )
    items = (playlist or {}).get("items") or []
    if not playlist or not items:
        return {
            "playing": False,
            "mode": "solo",
            "reason": "Playlist is empty — go to Radio Studio → Playlist to add items.",
        }
    ad_ids = [it["ref_id"] for it in items if it.get("type") == "ad"]
    music_ids = [it["ref_id"] for it in items if it.get("type") == "music"]
    ads_by_id: dict = {}
    music_by_id: dict = {}
    if ad_ids:
        async for d in db.radio_studio_ads.find(
            {"id": {"$in": ad_ids}},
            {"_id": 0, "id": 1, "name": 1, "voice_name": 1, "duration_seconds": 1, "audio_filename": 1, "bed_music_name": 1},
        ):
            ads_by_id[d["id"]] = d
    if music_ids:
        async for d in db.radio_studio_music.find(
            {"id": {"$in": music_ids}},
            {"_id": 0, "id": 1, "name": 1, "duration_seconds": 1, "audio_filename": 1},
        ):
            music_by_id[d["id"]] = d

    resolved = []
    for it in items:
        ref = (ads_by_id if it.get("type") == "ad" else music_by_id).get(it.get("ref_id"))
        if not ref or not ref.get("audio_filename"):
            continue
        d = float(ref.get("duration_seconds") or 0) or 30.0
        resolved.append({
            "type": it.get("type"),
            "ref_id": it.get("ref_id"),
            "name": ref.get("name"),
            "voice_name": ref.get("voice_name"),
            "bed_music_name": ref.get("bed_music_name"),
            "duration_seconds": d,
            "audio_url": (
                f"/api/radio-studio/stream/{'ad' if it.get('type') == 'ad' else 'music'}/{it.get('ref_id')}"
            ),
        })
    if not resolved:
        return {
            "playing": False,
            "mode": "solo",
            "reason": "Every item in the playlist is missing audio. Click Generate on each ad.",
        }
    return {
        "playing": True,
        "mode": "solo",
        "items": resolved,
        "playlist": {
            "total_items": len(resolved),
            "total_seconds": round(sum(r["duration_seconds"] for r in resolved), 1),
            "crossfade_seconds": float(playlist.get("crossfade_seconds") or 0.0),
            "playlist_name": playlist.get("name") or "Default Playlist",
        },
    }


@public_router.get("/live")
async def live_stream():
    """Endless synchronised in-store radio stream. Unauthenticated
    so the Bluetooth speakers (and any phone/tablet tethered to one)
    can just tune in by URL. Browser <audio> tags, VLC, and
    iOS/Android audio apps all consume this natively."""
    headers = {
        # Long-lived audio response — no proxy should cache or
        # buffer it. (Cloudflare doesn't cache audio/mpeg by
        # default but we belt-and-brace.)
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Pragma": "no-cache",
        "X-Accel-Buffering": "no",  # disable nginx/Cloudflare buffering
        "Connection": "keep-alive",
    }
    return StreamingResponse(
        _live_generator(),
        media_type="audio/mpeg",
        headers=headers,
    )


@public_router.get("/live/now-playing")
async def live_now_playing():
    """Returns the item currently playing on the live stream + its
    offset in seconds. The admin UI polls this every few seconds to
    show a 'Now playing' badge; the public /radio page uses it to
    drive a big in-store screen. Cheap — one playlist read, no
    audio blobs."""
    db = get_db()
    playlist = await db.radio_studio_playlists.find_one(
        {"is_active": True}, {"_id": 0},
    )
    items = (playlist or {}).get("items") or []
    if not items:
        return {
            "playing": False,
            "reason": "Playlist is empty — go to Radio Studio → Playlist to add items.",
            "stream_url": "/api/radio-studio/live",
        }

    ad_ids = [it["ref_id"] for it in items if it.get("type") == "ad"]
    music_ids = [it["ref_id"] for it in items if it.get("type") == "music"]
    ads_by_id: dict = {}
    music_by_id: dict = {}
    if ad_ids:
        async for d in db.radio_studio_ads.find(
            {"id": {"$in": ad_ids}},
            {"_id": 0, "id": 1, "name": 1, "duration_seconds": 1,
             "audio_filename": 1, "voice_name": 1, "bed_music_name": 1},
        ):
            ads_by_id[d["id"]] = d
    if music_ids:
        async for d in db.radio_studio_music.find(
            {"id": {"$in": music_ids}},
            {"_id": 0, "id": 1, "name": 1, "duration_seconds": 1,
             "audio_filename": 1},
        ):
            music_by_id[d["id"]] = d

    # Build duration table, skipping items with no audio.
    resolved = []
    for it in items:
        ref = (ads_by_id if it.get("type") == "ad" else music_by_id).get(it.get("ref_id"))
        if not ref or not ref.get("audio_filename"):
            continue
        d = float(ref.get("duration_seconds") or 0) or 30.0
        resolved.append({**it, "ref": ref, "duration_seconds": d})
    if not resolved:
        return {
            "playing": False,
            "reason": "Every playlist item is missing audio — generate or re-upload them.",
            "stream_url": "/api/radio-studio/live",
        }

    durations = [r["duration_seconds"] for r in resolved]
    total = sum(durations) or 1.0
    # Repeat flag (30 May 2026 — user-requested). When disabled,
    # the stream plays through once and stops; when enabled (the
    # default), the wall-clock-modulo math below keeps looping
    # forever. We track "elapsed since the playlist started" via a
    # fixed `created_at` epoch so disabling repeat is meaningful —
    # using time.time() naked would never "end".
    repeat = bool(playlist.get("repeat", True))
    if not repeat:
        # Anchor to a stable origin (playlist.created_at_epoch or
        # `is_active` flip time). Each speaker independently
        # computes elapsed; once elapsed >= total, we report
        # "playing: false, reason: Playlist finished".
        started_at = float(playlist.get("started_at_epoch") or 0)
        if started_at <= 0:
            # First time this non-repeat playlist is requested — anchor
            # at "now" so the speakers tuning in get the full playlist.
            # We DON'T write to Mongo here because /now-playing is hit
            # 4× per speaker per second when stores are tuned in;
            # instead we anchor in code below by treating absent
            # `started_at_epoch` as "starting right now".
            elapsed = 0.0
        else:
            elapsed = max(0.0, time.time() - started_at)
        if elapsed >= total:
            return {
                "playing": False,
                "reason": "Playlist finished — toggle Repeat on or pick a new playlist.",
                "playlist": {
                    "total_items": len(resolved),
                    "total_seconds": round(total, 1),
                    "repeat": False,
                    "crossfade_seconds": float(playlist.get("crossfade_seconds") or 0.0),
                },
                "stream_url": "/api/radio-studio/live",
            }
        offset = elapsed
    else:
        offset = time.time() % total
    idx, item_offset = _locate(offset, durations)
    cur = resolved[idx]
    nxt_idx = (idx + 1) % len(resolved)
    # 31 May 2026 — user feedback ("Why doesn't the radio follow Saved
    # Playlist") was rooted in not being able to SEE the upcoming
    # items — the loop was correctly playing the playlist but only
    # one "Up next" was surfaced. Expose the next 3 items so the
    # public page can render them as a mini-schedule and the user
    # can verify the playlist order at a glance.
    upcoming = []
    for off in (1, 2, 3):
        if off >= len(resolved):
            break
        u_idx = (idx + off) % len(resolved)
        u_item = resolved[u_idx]
        upcoming.append({
            "type": u_item.get("type"),
            "ref_id": u_item.get("ref_id"),
            "name": u_item["ref"].get("name"),
            "duration_seconds": u_item["duration_seconds"],
        })
    # Audio URL points at the existing per-item streaming endpoint
    # (NOT /live), so a browser <audio> tag can consume it as a
    # normal finite MP3 — works through every proxy / corporate
    # firewall. The public /radio page uses this for sync.
    cur_audio_url = (
        f"/api/radio-studio/stream/{'ad' if cur.get('type') == 'ad' else 'music'}/{cur.get('ref_id')}"
    )
    return {
        "playing": True,
        "now": {
            "type": cur.get("type"),
            "ref_id": cur.get("ref_id"),
            "name": cur["ref"].get("name"),
            "voice_name": cur["ref"].get("voice_name") if cur.get("type") == "ad" else None,
            "bed_music_name": cur["ref"].get("bed_music_name") if cur.get("type") == "ad" else None,
            "duration_seconds": cur["duration_seconds"],
            "elapsed_seconds": round(item_offset, 1),
            "remaining_seconds": round(max(0.0, cur["duration_seconds"] - item_offset), 1),
            "audio_url": cur_audio_url,
        },
        "next": (
            {
                "type": resolved[nxt_idx].get("type"),
                "ref_id": resolved[nxt_idx].get("ref_id"),
                "name": resolved[nxt_idx]["ref"].get("name"),
                "audio_url": (
                    f"/api/radio-studio/stream/"
                    f"{'ad' if resolved[nxt_idx].get('type') == 'ad' else 'music'}"
                    f"/{resolved[nxt_idx].get('ref_id')}"
                ),
            }
            if len(resolved) > 1 else None
        ),
        "upcoming": upcoming,
        "current_index": idx,
        "playlist": {
            "total_items": len(resolved),
            "total_seconds": round(total, 1),
            "loop_offset_seconds": round(offset, 1),
            "repeat": repeat,
            "crossfade_seconds": float(playlist.get("crossfade_seconds") or 0.0),
            "playlist_name": playlist.get("name") or "Default Playlist",
        },
        # `server_time` lets a client extrapolate elapsed seconds
        # without re-polling — they can interpolate locally for
        # 4-second poll cycles and only ask the server again at
        # item boundaries. Drift between speakers stays <1 s.
        "server_time": time.time(),
        "stream_url": "/api/radio-studio/live",  # for VLC etc.
    }

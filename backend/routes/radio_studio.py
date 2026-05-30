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
from typing import List, Literal, Optional, Tuple
from elevenlabs import VoiceSettings
from elevenlabs.client import ElevenLabs
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, Response
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
# Models
# ------------------------------------------------------------------

class AdCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    script: str = Field(min_length=1, max_length=4000)
    voice_id: str = Field(min_length=1)
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
    if not ad.get("script", "").strip():
        raise HTTPException(status_code=400, detail="Ad has no script — write one first")
    if not ad.get("voice_id"):
        raise HTTPException(status_code=400, detail="Ad has no voice selected")

    # Apply per-ad pronunciation hints first (so they get a chance
    # to substitute words BEFORE £/URL normalisation runs), then
    # normalise £/URLs/m². Truncate the result to the test budget.
    hinted = _apply_pronunciation_hints(ad["script"], ad.get("pronunciation_hints"))
    normalised = _normalize_for_tts(hinted)
    preview = normalised[:_TEST_VOICE_CHAR_BUDGET]
    # Try to end at the last sentence/clause boundary inside budget.
    cut_at = max(preview.rfind(". "), preview.rfind("! "), preview.rfind("? "), preview.rfind(", "))
    if cut_at > _TEST_VOICE_CHAR_BUDGET // 2:
        # Keep the boundary character.
        preview = preview[: cut_at + 1]
    preview = preview.strip()

    client = _get_eleven_client()
    voice_settings = VoiceSettings(
        stability=float(ad.get("stability", 0.5)),
        similarity_boost=float(ad.get("similarity_boost", 0.75)),
        style=float(ad.get("style", 0.0)),
        use_speaker_boost=True,
    )
    try:
        audio_iter = client.text_to_speech.convert(
            text=preview,
            voice_id=ad["voice_id"],
            model_id=ad.get("model_id") or "eleven_multilingual_v2",
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
        voice_id=ad.get("voice_id"),
        voice_name=ad.get("voice_name"),
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
    voice_settings = VoiceSettings(
        stability=float(ad.get("stability", 0.5)),
        similarity_boost=float(ad.get("similarity_boost", 0.75)),
        style=float(ad.get("style", 0.0)),
        use_speaker_boost=True,
    )

    try:
        # Pre-compute the normalised text so we can log the EXACT
        # char count ElevenLabs will charge for.
        normalised_text = _normalize_for_tts(
            _apply_pronunciation_hints(
                ad["script"], ad.get("pronunciation_hints"),
            ),
        )
        audio_iter = client.text_to_speech.convert(
            text=normalised_text,
            voice_id=ad["voice_id"],
            model_id=ad.get("model_id") or "eleven_multilingual_v2",
            voice_settings=voice_settings,
            output_format="mp3_44100_128",
        )
        audio_data = b""
        for chunk in audio_iter:
            if chunk:
                audio_data += chunk
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

    track_id = uuid.uuid4().hex
    estimated_seconds = round(len(audio_bytes) / 16_000, 1)
    doc = {
        "id": track_id,
        "name": name,
        "audio_blob": audio_bytes,  # BSON Binary — persistent in Atlas
        "audio_filename": f"{track_id}.mp3",  # legacy marker
        "duration_seconds": estimated_seconds,
        "audio_bytes": len(audio_bytes),
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
                },
                "stream_url": "/api/radio-studio/live",
            }
        offset = elapsed
    else:
        offset = time.time() % total
    idx, item_offset = _locate(offset, durations)
    cur = resolved[idx]
    nxt_idx = (idx + 1) % len(resolved)
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
        "playlist": {
            "total_items": len(resolved),
            "total_seconds": round(total, 1),
            "loop_offset_seconds": round(offset, 1),
            "repeat": repeat,
        },
        # `server_time` lets a client extrapolate elapsed seconds
        # without re-polling — they can interpolate locally for
        # 4-second poll cycles and only ask the server again at
        # item boundaries. Drift between speakers stays <1 s.
        "server_time": time.time(),
        "stream_url": "/api/radio-studio/live",  # for VLC etc.
    }

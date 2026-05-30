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

import logging
import os
import uuid
from datetime import datetime, timezone
from typing import List, Literal, Optional

from elevenlabs import VoiceSettings
from elevenlabs.client import ElevenLabs
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, Response
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


class AdUpdate(BaseModel):
    name: Optional[str] = Field(default=None, max_length=120)
    script: Optional[str] = Field(default=None, max_length=4000)
    voice_id: Optional[str] = None
    voice_name: Optional[str] = None
    stability: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    similarity_boost: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    style: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    model_id: Optional[str] = None


class PlaylistItem(BaseModel):
    type: Literal["ad", "music"]
    ref_id: str


class PlaylistUpdate(BaseModel):
    name: str = Field(default="Default Playlist", max_length=120)
    items: List[PlaylistItem]
    is_active: bool = True


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
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    updates["updated_at"] = datetime.now(timezone.utc).isoformat()
    result = await db.radio_studio_ads.update_one({"id": ad_id}, {"$set": updates})
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Ad not found")
    ad = await db.radio_studio_ads.find_one({"id": ad_id}, {"_id": 0, "audio_blob": 0})
    return ad


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
        audio_iter = client.text_to_speech.convert(
            text=ad["script"],
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
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }},
    )
    ad = await db.radio_studio_ads.find_one({"id": ad_id}, {"_id": 0, "audio_blob": 0})
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
            "created_at": None,
            "updated_at": None,
        }
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
        "created_at": (existing or {}).get("created_at") or now,
        "updated_at": now,
    }
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

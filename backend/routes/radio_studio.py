"""
Radio Studio — in-store AI-narrated radio for the Tile Station showrooms.

User-requested feature (24 May 2026): a 4-store in-store radio service that
plays AI-generated ads (ElevenLabs UK English voices) intermixed with
royalty-free music. Customers in showrooms hear product offers, trade-
account benefits and seasonal promotions on a loop through Bluetooth
speakers.

This route module exposes:
  • POST /api/admin/radio-studio/voices/sync     — refresh the cached
    ElevenLabs voice list (UK English filter applied)
  • GET  /api/admin/radio-studio/voices          — list cached voices
  • POST /api/admin/radio-studio/ads             — create an ad script
  • PUT  /api/admin/radio-studio/ads/{id}        — update script/voice
  • POST /api/admin/radio-studio/ads/{id}/generate
                                                 — generate the MP3 via
                                                   ElevenLabs TTS
  • GET  /api/admin/radio-studio/ads             — list all ads
  • DELETE /api/admin/radio-studio/ads/{id}      — delete an ad
  • POST /api/admin/radio-studio/music/upload    — upload a royalty-free
                                                   music track
  • GET  /api/admin/radio-studio/music           — list music tracks
  • DELETE /api/admin/radio-studio/music/{id}    — delete a track
  • POST /api/admin/radio-studio/playlist        — save/update the active
                                                   playlist
  • GET  /api/admin/radio-studio/playlist        — read active playlist
  • GET  /api/radio-studio/stream/{filename}     — public MP3 stream
                                                   (used by admin <audio>
                                                   preview AND the
                                                   future in-store
                                                   speakers — no auth so
                                                   speakers can hit it
                                                   without a token)

Storage layout (filesystem, not GridFS — MP3s are small but binary, and
serving them via FastAPI StreamingResponse is faster than streaming a
base64 string from Mongo):

  /app/backend/storage/radio_studio/ads/{ad_id}.mp3
  /app/backend/storage/radio_studio/music/{track_id}.mp3

The DB just holds metadata pointing at the files.
"""
from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Literal, Optional

from elevenlabs import VoiceSettings
from elevenlabs.client import ElevenLabs
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from config import get_db
from services import get_current_user


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin/radio-studio", tags=["Radio Studio"])
public_router = APIRouter(prefix="/radio-studio", tags=["Radio Studio (public)"])


# ------------------------------------------------------------------
# Storage helpers
# ------------------------------------------------------------------

STORAGE_ROOT = Path("/app/backend/storage/radio_studio")
ADS_DIR = STORAGE_ROOT / "ads"
MUSIC_DIR = STORAGE_ROOT / "music"

for _dir in (ADS_DIR, MUSIC_DIR):
    _dir.mkdir(parents=True, exist_ok=True)


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
        labels = (getattr(v, "labels", None) or {})
        # Filter to English-language voices (UK accent preferred but
        # we keep all English so admins can mix in a few neutral ones).
        accent = (labels.get("accent") or "").lower()
        language = (labels.get("language") or "").lower()
        description = (getattr(v, "description", "") or "").lower()

        is_english = (
            "english" in language
            or "british" in accent
            or "british" in description
            or accent in {"american", "australian", "irish"}
            or not language  # premade voices often lack a language label
        )
        if not is_english:
            continue

        cached.append({
            "voice_id": v.voice_id,
            "name": v.name,
            "category": getattr(v, "category", "premade"),
            "description": getattr(v, "description", None),
            "accent": labels.get("accent"),
            "age": labels.get("age"),
            "gender": labels.get("gender"),
            "use_case": labels.get("use case") or labels.get("use_case"),
            "preview_url": getattr(v, "preview_url", None),
        })

    # Cache the result so subsequent GETs are instant.
    await db.radio_studio_voices.delete_many({})
    if cached:
        await db.radio_studio_voices.insert_many(cached)

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
    ads = await db.radio_studio_ads.find({}, {"_id": 0}).sort("created_at", -1).to_list(500)
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
    ad = await db.radio_studio_ads.find_one({"id": ad_id}, {"_id": 0})
    return ad


@router.post("/ads/{ad_id}/generate")
async def generate_ad_audio(
    ad_id: str,
    current_user: dict = Depends(get_current_user),
):
    """Call ElevenLabs TTS, save the MP3 to disk, update the DB doc.
    Re-running this regenerates and overwrites the existing file
    (useful when the admin tweaks the script or voice settings)."""
    _require_admin(current_user)
    db = get_db()
    ad = await db.radio_studio_ads.find_one({"id": ad_id}, {"_id": 0})
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

    filename = f"{ad_id}.mp3"
    file_path = ADS_DIR / filename
    file_path.write_bytes(audio_data)

    # Estimate duration: 128 kbps mp3 → ~16 KB/s. Good enough for a
    # playlist-length estimate; the admin sees the real duration when
    # the player loads metadata.
    estimated_seconds = round(len(audio_data) / 16_000, 1)

    await db.radio_studio_ads.update_one(
        {"id": ad_id},
        {"$set": {
            "audio_filename": filename,
            "duration_seconds": estimated_seconds,
            "audio_bytes": len(audio_data),
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }},
    )
    ad = await db.radio_studio_ads.find_one({"id": ad_id}, {"_id": 0})
    return ad


@router.delete("/ads/{ad_id}")
async def delete_ad(ad_id: str, current_user: dict = Depends(get_current_user)):
    _require_admin(current_user)
    db = get_db()
    ad = await db.radio_studio_ads.find_one({"id": ad_id}, {"_id": 0})
    if not ad:
        raise HTTPException(status_code=404, detail="Ad not found")
    if ad.get("audio_filename"):
        try:
            (ADS_DIR / ad["audio_filename"]).unlink(missing_ok=True)
        except Exception:
            logger.exception("Failed to delete ad audio file")
    await db.radio_studio_ads.delete_one({"id": ad_id})
    # Also strip this ad from any saved playlists so they don't
    # reference a dangling id.
    await db.radio_studio_playlists.update_many(
        {},
        {"$pull": {"items": {"type": "ad", "ref_id": ad_id}}},
    )
    return {"success": True, "deleted_id": ad_id}


# ------------------------------------------------------------------
# Music library
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
    if len(audio_bytes) > 30 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Music track exceeds 30 MB limit")

    track_id = uuid.uuid4().hex
    filename = f"{track_id}.mp3"
    file_path = MUSIC_DIR / filename
    file_path.write_bytes(audio_bytes)

    estimated_seconds = round(len(audio_bytes) / 16_000, 1)
    doc = {
        "id": track_id,
        "name": name,
        "audio_filename": filename,
        "duration_seconds": estimated_seconds,
        "audio_bytes": len(audio_bytes),
        "uploaded_at": datetime.now(timezone.utc).isoformat(),
        "uploaded_by": (current_user or {}).get("email"),
    }
    await db.radio_studio_music.insert_one(doc)
    doc.pop("_id", None)
    return doc


@router.get("/music")
async def list_music(current_user: dict = Depends(get_current_user)):
    _require_admin(current_user)
    db = get_db()
    tracks = await db.radio_studio_music.find({}, {"_id": 0}).sort("uploaded_at", -1).to_list(500)
    return {"tracks": tracks, "count": len(tracks)}


@router.delete("/music/{track_id}")
async def delete_music(track_id: str, current_user: dict = Depends(get_current_user)):
    _require_admin(current_user)
    db = get_db()
    track = await db.radio_studio_music.find_one({"id": track_id}, {"_id": 0})
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    if track.get("audio_filename"):
        try:
            (MUSIC_DIR / track["audio_filename"]).unlink(missing_ok=True)
        except Exception:
            logger.exception("Failed to delete music file")
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
    """Serve an ad MP3. Unauthenticated so the storefront <audio> tag
    and future in-store speakers can hit it without a token."""
    db = get_db()
    ad = await db.radio_studio_ads.find_one({"id": ad_id}, {"_id": 0})
    if not ad or not ad.get("audio_filename"):
        raise HTTPException(status_code=404, detail="Ad audio not found")
    file_path = ADS_DIR / ad["audio_filename"]
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="Audio file missing on disk")
    return FileResponse(
        str(file_path),
        media_type="audio/mpeg",
        filename=f"{ad['name']}.mp3",
    )


@public_router.get("/stream/music/{track_id}")
async def stream_music(track_id: str):
    db = get_db()
    track = await db.radio_studio_music.find_one({"id": track_id}, {"_id": 0})
    if not track or not track.get("audio_filename"):
        raise HTTPException(status_code=404, detail="Track audio not found")
    file_path = MUSIC_DIR / track["audio_filename"]
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="Audio file missing on disk")
    return FileResponse(
        str(file_path),
        media_type="audio/mpeg",
        filename=f"{track['name']}.mp3",
    )

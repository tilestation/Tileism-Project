"""
Voice — Per-Showroom Routing (Feb 2026).

Multi-location call centre on top of the base voice module. Each
showroom can have its own Twilio number, divert mobile, welcome
message, recording toggle and opening hours, while sharing the
global ads + recording + GDPR plumbing.

The inbound webhook calls `match_showroom_route_for_call(to_number)`
to pick the right route; if none match it falls back to the global
defaults.

Data model: `db.voice_showroom_routes` — one document per showroom
that has been wired into Twilio.
"""
import logging
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from config import get_db
from services import get_current_user
from routes.voice import _require_admin

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin/voice/showroom-routes", tags=["Voice"])


# ─── Model ──────────────────────────────────────────────────────────
class ShowroomRoute(BaseModel):
    showroom_name: str = Field(..., max_length=80)
    twilio_number: str = Field("", description="E.164 — the Twilio landline customers will be diverted to")
    divert_mobile: str = Field("", description="E.164 — the manager / showroom team mobile")
    welcome_message_text: Optional[str] = Field(
        None,
        description="Override of the global welcome. Supports {showroom_name} + {showroom_hours_today} placeholders.",
    )
    welcome_audio_url: Optional[str] = None
    welcome_audio_generated_at: Optional[str] = None
    recording_enabled: Optional[bool] = None
    ring_timeout_seconds: Optional[int] = None
    use_showroom_hours: bool = True
    enabled: bool = True
    notes: Optional[str] = Field(None, max_length=500)


# ─── Helpers ────────────────────────────────────────────────────────
def _normalize_to_e164(num: str) -> str:
    """Loose UK normaliser — strip spaces, prepend +44 if leading 0."""
    if not num:
        return ""
    s = "".join(ch for ch in str(num) if ch.isdigit() or ch == "+")
    if s.startswith("00"):
        s = "+" + s[2:]
    if s.startswith("0"):
        s = "+44" + s[1:]
    return s


async def _route_doc_to_response(doc: dict) -> dict:
    if not doc:
        return {}
    doc.pop("_id", None)
    return doc


# ─── Endpoints ──────────────────────────────────────────────────────
@router.get("")
async def list_routes(current_user: dict = Depends(get_current_user)):
    """List every per-showroom route plus the list of available
    showrooms (so the UI can prompt the user to wire up any showroom
    that doesn't have a route yet)."""
    _require_admin(current_user)
    db = get_db()
    routes = await db.voice_showroom_routes.find({}, {"_id": 0}).to_list(50)
    showrooms = await db.showrooms.find(
        {}, {"_id": 0, "id": 1, "name": 1, "phone": 1,
             "postcode": 1, "opening_hours": 1, "address": 1},
    ).sort("name", 1).to_list(50)
    return {"routes": routes, "showrooms": showrooms}


@router.put("/{showroom_name}")
async def upsert_route(
    showroom_name: str,
    payload: ShowroomRoute,
    current_user: dict = Depends(get_current_user),
):
    if (current_user or {}).get("role") != "super_admin":
        raise HTTPException(403, "Super admin only — telephony routes drive call billing.")
    payload.showroom_name = showroom_name  # URL is canonical
    # Normalise phone numbers so a customer can paste "0747..." or "+44747..."
    payload.twilio_number = _normalize_to_e164(payload.twilio_number)
    payload.divert_mobile = _normalize_to_e164(payload.divert_mobile)
    db = get_db()
    # Uniqueness check — same Twilio number can't be on two showrooms
    if payload.twilio_number:
        clash = await db.voice_showroom_routes.find_one({
            "twilio_number": payload.twilio_number,
            "showroom_name": {"$ne": showroom_name},
        }, {"_id": 0, "showroom_name": 1})
        if clash:
            raise HTTPException(
                409,
                f"Twilio number {payload.twilio_number} is already wired to "
                f"{clash['showroom_name']}.",
            )
    doc = {
        **payload.model_dump(),
        "id": showroom_name,  # name is the natural key
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "updated_by": (current_user or {}).get("email", "system"),
    }
    await db.voice_showroom_routes.update_one(
        {"showroom_name": showroom_name}, {"$set": doc}, upsert=True,
    )
    return doc


@router.delete("/{showroom_name}")
async def delete_route(
    showroom_name: str,
    current_user: dict = Depends(get_current_user),
):
    if (current_user or {}).get("role") != "super_admin":
        raise HTTPException(403, "Super admin only")
    db = get_db()
    result = await db.voice_showroom_routes.delete_one({"showroom_name": showroom_name})
    return {"deleted": result.deleted_count}


@router.post("/{showroom_name}/regenerate-welcome")
async def regenerate_welcome(
    showroom_name: str,
    current_user: dict = Depends(get_current_user),
):
    """Generate the welcome MP3 for this showroom's specific message
    via ElevenLabs + upload to R2. Resolves {showroom_name} and
    {showroom_hours_today} placeholders before synthesis."""
    if (current_user or {}).get("role") != "super_admin":
        raise HTTPException(403, "Super admin only")
    db = get_db()
    route = await db.voice_showroom_routes.find_one({"showroom_name": showroom_name}, {"_id": 0})
    if not route:
        raise HTTPException(404, "Route not found — save the showroom route first.")
    text = (route.get("welcome_message_text") or "").strip()
    if not text:
        # Fall back to a sensible per-showroom default
        text = (
            f"Welcome to Tile Station, {showroom_name} showroom. "
            f"This call may be recorded for quality and training. "
            f"Please hold while we connect you to our team."
        )
    # Resolve placeholders
    text = await _resolve_placeholders(db, text, showroom_name)

    # Re-use the global TTS + R2 plumbing
    from routes.voice import _upload_audio_to_r2  # noqa: PLC0415
    import os  # noqa: PLC0415
    try:
        from elevenlabs import VoiceSettings as EVS  # noqa: PLC0415
        from elevenlabs.client import ElevenLabs  # noqa: PLC0415
    except ImportError as e:
        raise HTTPException(503, f"ElevenLabs SDK missing: {e}") from e
    api_key = os.environ.get("ELEVENLABS_API_KEY")
    if not api_key:
        raise HTTPException(503, "ELEVENLABS_API_KEY not set")
    client = ElevenLabs(api_key=api_key)
    # Pull voice_id from global voice_settings
    gs = await db.voice_settings.find_one({"id": "default"}, {"_id": 0}) or {}
    voice_id = gs.get("welcome_voice_id") or "21m00Tcm4TlvDq8ikWAM"
    try:
        audio_iter = client.text_to_speech.convert(
            text=text, voice_id=voice_id,
            model_id="eleven_multilingual_v2",
            voice_settings=EVS(stability=0.55, similarity_boost=0.85,
                               style=0.0, use_speaker_boost=True),
            output_format="mp3_44100_128",
        )
        audio_bytes = b"".join(chunk for chunk in audio_iter if chunk)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"ElevenLabs error: {e}") from e
    if not audio_bytes:
        raise HTTPException(502, "ElevenLabs returned empty audio")
    safe_name = "".join(c if c.isalnum() else "_" for c in showroom_name)
    url = await _upload_audio_to_r2(
        audio_bytes,
        key=f"voice/welcome_{safe_name}_{int(datetime.now(timezone.utc).timestamp())}.mp3",
    )
    if not url:
        raise HTTPException(503, "R2 upload failed")
    await db.voice_showroom_routes.update_one(
        {"showroom_name": showroom_name},
        {"$set": {
            "welcome_audio_url": url,
            "welcome_audio_generated_at": datetime.now(timezone.utc).isoformat(),
            "welcome_message_text": route.get("welcome_message_text") or text,
        }},
    )
    return {"audio_url": url, "bytes": len(audio_bytes), "rendered_text": text}


# ─── Placeholder resolution ──────────────────────────────────────────
async def _resolve_placeholders(db, text: str, showroom_name: str) -> str:
    """Substitute {showroom_name} and {showroom_hours_today} from
    the showrooms collection."""
    sr = await db.showrooms.find_one(
        {"name": showroom_name},
        {"_id": 0, "opening_hours": 1, "name": 1},
    ) or {}
    out = text.replace("{showroom_name}", sr.get("name") or showroom_name)
    if "{showroom_hours_today}" in out:
        from datetime import datetime as _dt
        try:
            day = _dt.now().strftime("%A").lower()
            hours = (sr.get("opening_hours") or {}).get(day, "")
        except Exception:  # noqa: BLE001
            hours = ""
        out = out.replace("{showroom_hours_today}", hours or "9 to 5")
    return out


# ─── Public helper used by routes/voice.py's incoming webhook ───────
async def match_showroom_route_for_call(to_number: str) -> Optional[dict]:
    """Given the incoming `To` number from Twilio, return the matching
    showroom route or None if there's no per-showroom override."""
    if not to_number:
        return None
    db = get_db()
    norm = _normalize_to_e164(to_number)
    # Try exact + normalised match — be forgiving about formatting.
    route = await db.voice_showroom_routes.find_one(
        {"$or": [
            {"twilio_number": to_number},
            {"twilio_number": norm},
        ], "enabled": True},
        {"_id": 0},
    )
    if not route:
        return None
    # Resolve placeholders in welcome text NOW so the webhook is fast
    text = route.get("welcome_message_text") or ""
    if text and ("{" in text):
        route["welcome_message_text"] = await _resolve_placeholders(
            db, text, route["showroom_name"],
        )
    # If use_showroom_hours, copy the hours into the route
    if route.get("use_showroom_hours"):
        sr = await db.showrooms.find_one(
            {"name": route["showroom_name"]},
            {"_id": 0, "opening_hours": 1},
        ) or {}
        route["_resolved_opening_hours"] = sr.get("opening_hours") or {}
    return route

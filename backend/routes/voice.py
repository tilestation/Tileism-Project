"""
Twilio Voice — Full Call Centre (Feb 2026).

Inbound flow:
  Customer dials our UK Twilio landline
    → /voice/incoming TwiML responds with:
      • Welcome message (TTS or pre-recorded, on R2)
      • 1–2 hold ads (latest published Radio Studio ads)
      • <Dial> owner mobile with `record="record-from-answer-dual"`
    → On call end, Twilio POSTs /voice/status with DialCallStatus.
       • If missed (no-answer/busy/failed/canceled) → Telegram alert.
       • Log row written to db.voice_calls.
    → When recording is ready, /voice/recording-status POST updates row.

Outbound (click-to-call from admin browser):
  Browser uses Twilio Voice SDK + access token from /voice/token
    → Calls dial-out endpoint /voice/outbound which returns TwiML
    → <Dial callerId={landline}> pre-pends the landline as caller ID

Settings live in db.voice_settings (single doc id="default").
"""
import io
import logging
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import List, Optional

import aiohttp
from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

from config import get_db
from services import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Voice"])

# ─── Env / constants ─────────────────────────────────────────────────
TWILIO_ACCOUNT_SID = os.environ.get("TWILIO_ACCOUNT_SID", "")
TWILIO_AUTH_TOKEN = os.environ.get("TWILIO_AUTH_TOKEN", "")
TWILIO_PHONE_NUMBER = os.environ.get("TWILIO_PHONE_NUMBER", "")
TWILIO_API_KEY = os.environ.get("TWILIO_API_KEY", "")
TWILIO_API_SECRET = os.environ.get("TWILIO_API_SECRET", "")
TWILIO_TWIML_APP_SID = os.environ.get("TWILIO_TWIML_APP_SID", "")
OWNER_MOBILE_NUMBER = os.environ.get("OWNER_MOBILE_NUMBER", "")
PUBLIC_BACKEND_URL = os.environ.get("PUBLIC_BACKEND_URL", "")

SETTINGS_ID = "default"
DEFAULT_WELCOME = (
    "Welcome to Tile Station, the home of premium tiles in Kent. "
    "This call may be recorded for quality and training. "
    "Please hold while we connect you to our team."
)


# ─── Auth helpers ────────────────────────────────────────────────────
def _is_admin(user: dict) -> bool:
    return (user or {}).get("role") in {"super_admin", "admin", "manager"}


def _require_admin(user: dict) -> None:
    if not _is_admin(user):
        raise HTTPException(403, "Admin only")


# ─── Settings model ──────────────────────────────────────────────────
class VoiceSettings(BaseModel):
    enabled: bool = True
    divert_mobile_number: str = ""               # E.164 e.g. +447379562631
    twilio_phone_number: str = ""                # E.164 e.g. +442012345678
    welcome_message_text: str = DEFAULT_WELCOME
    welcome_audio_url: Optional[str] = None      # R2 URL of TTS-generated welcome
    welcome_audio_generated_at: Optional[str] = None
    welcome_voice_id: str = "21m00Tcm4TlvDq8ikWAM"  # ElevenLabs Rachel — UK female
    ads_source: str = "radio_studio"             # radio_studio | manual | none
    manual_ad_urls: List[str] = Field(default_factory=list)
    max_hold_ads: int = 2                        # how many ads to play before dialling
    recording_enabled: bool = True
    missed_call_telegram_alerts: bool = True
    inbound_call_telegram_alerts: bool = False   # noisy by default OFF
    ring_timeout_seconds: int = 25
    business_hours_enabled: bool = False
    business_hours_open: str = "09:00"
    business_hours_close: str = "17:30"
    business_hours_days: List[int] = Field(default_factory=lambda: [0, 1, 2, 3, 4, 5])  # Mon–Sat (0=Mon)
    closed_message_text: str = (
        "Thanks for calling Tile Station. We're closed right now. "
        "Our opening hours are Monday to Saturday, 9am to 5:30pm. "
        "Please call back or visit tilestation dot co dot uk."
    )


def _defaults_doc() -> dict:
    return {**VoiceSettings().model_dump(), "id": SETTINGS_ID}


async def _get_settings() -> dict:
    db = get_db()
    row = await db.voice_settings.find_one({"id": SETTINGS_ID}, {"_id": 0})
    if not row:
        row = _defaults_doc()
    return row


# ─── Signature validation ────────────────────────────────────────────
def _validate_signature(request: Request, form_data: dict) -> bool:
    """Verify the X-Twilio-Signature header so only real Twilio
    webhooks reach us. Returns True if valid, False otherwise.

    We deliberately DON'T raise on failure during early setup — we
    log and allow, so the user can test from the Twilio Console
    debugger. Once live, flip VOICE_REQUIRE_SIGNATURE=1 in .env.
    """
    if not TWILIO_AUTH_TOKEN:
        return True  # No token => can't validate, accept
    try:
        from twilio.request_validator import RequestValidator  # noqa: PLC0415
    except ImportError:
        return True  # Twilio SDK not installed yet — let it through
    validator = RequestValidator(TWILIO_AUTH_TOKEN)
    signature = request.headers.get("X-Twilio-Signature", "")
    # Public URL must match what Twilio is hitting. Honour the
    # X-Forwarded-* headers Railway/Nginx send so https is preserved.
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    url = f"{proto}://{host}{request.url.path}"
    return validator.validate(url, form_data, signature)


def _require_signature(request: Request, form_data: dict) -> None:
    if os.environ.get("VOICE_REQUIRE_SIGNATURE", "1") != "1":
        return  # Test mode
    if _validate_signature(request, form_data):
        return
    logger.warning("Twilio webhook signature failed for %s", request.url.path)
    raise HTTPException(403, "Invalid Twilio signature")


# ─── TwiML helpers ───────────────────────────────────────────────────
def _voice_response_xml(body: str) -> Response:
    return Response(content=body, media_type="application/xml")


async def _build_hold_ad_urls(settings: dict) -> List[str]:
    """Pick the URLs of the hold ads to play before dialling.

    Sources:
      • "radio_studio" → most recent published Radio Studio ads
      • "manual"        → settings.manual_ad_urls (admin-uploaded)
      • "none"          → []
    """
    src = settings.get("ads_source", "radio_studio")
    max_n = max(0, int(settings.get("max_hold_ads", 2)))
    if max_n == 0 or src == "none":
        return []
    if src == "manual":
        return [u for u in (settings.get("manual_ad_urls") or []) if u][:max_n]
    # Default: pull from Radio Studio
    db = get_db()
    try:
        cur = db.radio_ads.find(
            {"audio_url": {"$exists": True, "$ne": ""}, "status": {"$in": ["published", "ready"]}},
            {"_id": 0, "audio_url": 1, "name": 1},
        ).sort("updated_at", -1).limit(max_n)
        ads = await cur.to_list(max_n)
    except Exception:  # noqa: BLE001
        logger.exception("Failed to fetch hold ads from radio_ads")
        return []
    return [a["audio_url"] for a in ads if a.get("audio_url")]


def _is_business_hours_now(settings: dict) -> bool:
    if not settings.get("business_hours_enabled"):
        return True
    try:
        from zoneinfo import ZoneInfo  # noqa: PLC0415
        now = datetime.now(ZoneInfo("Europe/London"))
    except Exception:  # noqa: BLE001
        now = datetime.now(timezone.utc)
    days = settings.get("business_hours_days")
    if days is None:
        days = [0, 1, 2, 3, 4, 5]
    if now.weekday() not in days:
        return False
    try:
        open_h, open_m = (int(p) for p in (settings.get("business_hours_open") or "09:00").split(":"))
        close_h, close_m = (int(p) for p in (settings.get("business_hours_close") or "17:30").split(":"))
    except (ValueError, AttributeError):
        return True
    current_minutes = now.hour * 60 + now.minute
    open_minutes = open_h * 60 + open_m
    close_minutes = close_h * 60 + close_m
    return open_minutes <= current_minutes < close_minutes


# ─── Inbound webhook ─────────────────────────────────────────────────
@router.post("/voice/incoming")
async def voice_incoming(request: Request):
    """TwiML for an incoming call. Welcome + ads + dial owner mobile."""
    form = dict(await request.form())
    _require_signature(request, form)

    settings = await _get_settings()
    from_number = form.get("From", "unknown")
    to_number = form.get("To", "")
    call_sid = form.get("CallSid", "")

    # Pre-log the call so missed-calls have a row even before /status fires
    db = get_db()
    try:
        await db.voice_calls.insert_one({
            "id": str(uuid.uuid4()),
            "call_sid": call_sid,
            "direction": "inbound",
            "from_number": from_number,
            "to_number": to_number,
            "status": "ringing",
            "dial_status": None,
            "duration_seconds": 0,
            "recording_url": None,
            "recording_sid": None,
            "started_at": datetime.now(timezone.utc).isoformat(),
            "completed_at": None,
        })
    except Exception:  # noqa: BLE001
        logger.exception("Failed to pre-log voice_calls row for %s", call_sid)

    # Telegram heads-up if enabled
    if settings.get("inbound_call_telegram_alerts"):
        try:
            from services.telegram_notify import fire_and_forget as _tg  # noqa: PLC0415
            _tg("voice_inbound", f"📞 Incoming call from <code>{from_number}</code>",
                dedupe_key=f"voice-in:{call_sid}")
        except Exception:  # noqa: BLE001
            pass

    # Build TwiML
    twiml_parts = ['<?xml version="1.0" encoding="UTF-8"?>', "<Response>"]

    # If telephony master switch is off → tell caller and hang up
    if not settings.get("enabled", True):
        twiml_parts.append(
            '<Say voice="alice" language="en-GB">We\'re sorry, our phone system '
            'is currently unavailable. Please email online at tile station dot co dot uk.</Say>'
            "<Hangup/>"
        )
        twiml_parts.append("</Response>")
        return _voice_response_xml("\n".join(twiml_parts))

    # Out-of-hours? → play closed message + hang up
    if not _is_business_hours_now(settings):
        closed = settings.get("closed_message_text", "")
        if closed:
            twiml_parts.append(
                f'<Say voice="alice" language="en-GB">{_xml_escape(closed)}</Say>'
            )
        twiml_parts.append("<Hangup/></Response>")
        return _voice_response_xml("\n".join(twiml_parts))

    # Welcome — pre-recorded TTS if available, else <Say>
    welcome_url = (settings.get("welcome_audio_url") or "").strip()
    if welcome_url:
        twiml_parts.append(f"<Play>{_xml_escape(welcome_url)}</Play>")
    else:
        twiml_parts.append(
            f'<Say voice="alice" language="en-GB">'
            f'{_xml_escape(settings.get("welcome_message_text") or DEFAULT_WELCOME)}'
            f"</Say>"
        )

    # Hold ads (each ad is <Play>; Twilio plays them sequentially)
    ad_urls = await _build_hold_ad_urls(settings)
    for url in ad_urls:
        twiml_parts.append(f"<Play>{_xml_escape(url)}</Play>")

    # Dial owner mobile
    mobile = (settings.get("divert_mobile_number") or OWNER_MOBILE_NUMBER or "").strip()
    if not mobile:
        twiml_parts.append(
            '<Say voice="alice" language="en-GB">We\'re unable to connect your call '
            'right now. Please email online at tile station dot co dot uk.</Say>'
            "<Hangup/></Response>"
        )
        return _voice_response_xml("\n".join(twiml_parts))

    record_attr = ' record="record-from-answer-dual"' if settings.get("recording_enabled") else ""
    recording_cb = ""
    if settings.get("recording_enabled"):
        cb_url = _public_url("/api/voice/recording-status")
        recording_cb = f' recordingStatusCallback="{_xml_escape(cb_url)}" recordingStatusCallbackEvent="completed"'
    timeout = int(settings.get("ring_timeout_seconds", 25))
    caller_id = (settings.get("twilio_phone_number") or TWILIO_PHONE_NUMBER or to_number).strip()
    status_cb = _public_url("/api/voice/status")
    twiml_parts.append(
        f'<Dial action="{_xml_escape(status_cb)}" method="POST" '
        f'timeout="{timeout}"'
        f' callerId="{_xml_escape(caller_id)}"'
        f"{record_attr}{recording_cb}>"
        f"<Number>{_xml_escape(mobile)}</Number>"
        f"</Dial>"
    )
    twiml_parts.append("</Response>")
    return _voice_response_xml("\n".join(twiml_parts))


# ─── Status (post-Dial) webhook ──────────────────────────────────────
@router.post("/voice/status")
async def voice_status(request: Request):
    form = dict(await request.form())
    _require_signature(request, form)

    call_sid = form.get("CallSid", "")
    dial_status = form.get("DialCallStatus", "")
    duration_str = form.get("DialCallDuration") or form.get("CallDuration") or "0"
    try:
        duration = int(duration_str)
    except ValueError:
        duration = 0
    from_number = form.get("From", "")
    is_missed = dial_status in {"no-answer", "busy", "failed", "canceled"}

    db = get_db()
    update = {
        "status": "completed",
        "dial_status": dial_status,
        "duration_seconds": duration,
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "missed": is_missed,
    }
    await db.voice_calls.update_one({"call_sid": call_sid}, {"$set": update})

    settings = await _get_settings()
    if is_missed and settings.get("missed_call_telegram_alerts"):
        try:
            from services.telegram_notify import fire_and_forget as _tg  # noqa: PLC0415
            _tg(
                "voice_missed",
                f"🚨 <b>Missed call</b> from <code>{from_number}</code>\n"
                f"Status: {dial_status} · duration: {duration}s",
                dedupe_key=f"voice-missed:{call_sid}",
            )
        except Exception:  # noqa: BLE001
            logger.exception("Telegram missed-call alert failed")

    return _voice_response_xml(
        '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>'
    )


# ─── Recording-ready webhook ─────────────────────────────────────────
@router.post("/voice/recording-status")
async def voice_recording_status(request: Request):
    form = dict(await request.form())
    _require_signature(request, form)
    call_sid = form.get("CallSid", "")
    recording_url = form.get("RecordingUrl", "")
    recording_sid = form.get("RecordingSid", "")
    recording_duration = form.get("RecordingDuration", "0")
    db = get_db()
    await db.voice_calls.update_one(
        {"call_sid": call_sid},
        {"$set": {
            "recording_url": recording_url,
            "recording_sid": recording_sid,
            "recording_duration": int(recording_duration) if str(recording_duration).isdigit() else 0,
        }},
    )
    return Response(status_code=204)


# ─── Click-to-call outbound webhook (Browser → Twilio → customer) ────
@router.post("/voice/outbound")
async def voice_outbound(request: Request):
    """Twilio hits this when the Browser SDK initiates an outbound call.
    Wraps the target number in <Dial callerId={landline}> so the
    customer sees the landline, not Twilio's default."""
    form = dict(await request.form())
    _require_signature(request, form)
    to = form.get("To", "").strip()
    if not to:
        return _voice_response_xml(
            '<?xml version="1.0" encoding="UTF-8"?><Response>'
            '<Say>No destination provided.</Say><Hangup/></Response>'
        )
    settings = await _get_settings()
    caller_id = (settings.get("twilio_phone_number") or TWILIO_PHONE_NUMBER).strip()
    record_attr = ' record="record-from-answer-dual"' if settings.get("recording_enabled") else ""
    recording_cb = ""
    if settings.get("recording_enabled"):
        recording_cb = f' recordingStatusCallback="{_xml_escape(_public_url("/api/voice/recording-status"))}" recordingStatusCallbackEvent="completed"'
    db = get_db()
    try:
        await db.voice_calls.insert_one({
            "id": str(uuid.uuid4()),
            "call_sid": form.get("CallSid", ""),
            "direction": "outbound",
            "from_number": caller_id,
            "to_number": to,
            "status": "ringing",
            "started_at": datetime.now(timezone.utc).isoformat(),
        })
    except Exception:  # noqa: BLE001
        pass
    twiml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n<Response>'
        f'<Dial callerId="{_xml_escape(caller_id)}"{record_attr}{recording_cb}>'
        f"<Number>{_xml_escape(to)}</Number>"
        "</Dial></Response>"
    )
    return _voice_response_xml(twiml)


# ─── Voice access token (for Browser SDK click-to-call) ──────────────
@router.get("/voice/token")
async def voice_token(current_user: dict = Depends(get_current_user)):
    _require_admin(current_user)
    if not (TWILIO_ACCOUNT_SID and TWILIO_API_KEY and TWILIO_API_SECRET and TWILIO_TWIML_APP_SID):
        raise HTTPException(
            503,
            "Click-to-call not configured. Set TWILIO_API_KEY, TWILIO_API_SECRET, "
            "and TWILIO_TWIML_APP_SID in .env (see Settings → Telephony → Setup).",
        )
    try:
        from twilio.jwt.access_token import AccessToken  # noqa: PLC0415
        from twilio.jwt.access_token.grants import VoiceGrant  # noqa: PLC0415
    except ImportError as e:
        raise HTTPException(503, f"twilio SDK not installed: {e}") from e
    identity = (current_user.get("email") or "admin").split("@")[0][:30]
    token = AccessToken(
        TWILIO_ACCOUNT_SID, TWILIO_API_KEY, TWILIO_API_SECRET,
        identity=identity, ttl=3600,
    )
    grant = VoiceGrant(
        outgoing_application_sid=TWILIO_TWIML_APP_SID,
        incoming_allow=True,
    )
    token.add_grant(grant)
    return {"token": token.to_jwt(), "identity": identity}


# ─── Settings admin API ──────────────────────────────────────────────
@router.get("/admin/voice/settings")
async def admin_get_voice_settings(current_user: dict = Depends(get_current_user)):
    _require_admin(current_user)
    return await _get_settings()


@router.put("/admin/voice/settings")
async def admin_put_voice_settings(payload: VoiceSettings,
                                   current_user: dict = Depends(get_current_user)):
    if (current_user or {}).get("role") != "super_admin":
        raise HTTPException(403, "Super admin only — telephony settings drive call routing.")
    db = get_db()
    doc = {**payload.model_dump(), "id": SETTINGS_ID,
           "updated_at": datetime.now(timezone.utc).isoformat(),
           "updated_by": current_user.get("email", "system")}
    await db.voice_settings.update_one({"id": SETTINGS_ID}, {"$set": doc}, upsert=True)
    return doc


@router.post("/admin/voice/settings/regenerate-welcome")
async def admin_regenerate_welcome(current_user: dict = Depends(get_current_user)):
    """Re-generate the welcome audio MP3 from the current
    `welcome_message_text` using ElevenLabs and upload to R2.
    Returns the new public URL + duration."""
    if (current_user or {}).get("role") != "super_admin":
        raise HTTPException(403, "Super admin only")
    settings = await _get_settings()
    text = (settings.get("welcome_message_text") or DEFAULT_WELCOME).strip()
    voice_id = settings.get("welcome_voice_id") or "21m00Tcm4TlvDq8ikWAM"
    try:
        from elevenlabs import VoiceSettings as EVS  # noqa: PLC0415
        from elevenlabs.client import ElevenLabs  # noqa: PLC0415
    except ImportError as e:
        raise HTTPException(503, f"ElevenLabs SDK not installed: {e}") from e
    api_key = os.environ.get("ELEVENLABS_API_KEY")
    if not api_key:
        raise HTTPException(503, "ELEVENLABS_API_KEY not set.")
    client = ElevenLabs(api_key=api_key)
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
        logger.exception("Welcome TTS failed")
        raise HTTPException(502, f"ElevenLabs error: {e}") from e
    if not audio_bytes:
        raise HTTPException(502, "ElevenLabs returned empty audio")

    # Upload to R2
    public_url = await _upload_audio_to_r2(
        audio_bytes, key=f"voice/welcome_{int(datetime.now(timezone.utc).timestamp())}.mp3"
    )
    if not public_url:
        raise HTTPException(503, "R2 upload failed — check R2_* env vars")

    db = get_db()
    update = {
        "welcome_audio_url": public_url,
        "welcome_audio_generated_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.voice_settings.update_one({"id": SETTINGS_ID}, {"$set": update}, upsert=True)
    return {"audio_url": public_url, "char_count": len(text), "bytes": len(audio_bytes)}


@router.post("/admin/voice/settings/upload-ad")
async def admin_upload_manual_ad(request: Request,
                                 current_user: dict = Depends(get_current_user)):
    """Accept an MP3 (base64 in JSON body) to use as a manual hold ad."""
    if (current_user or {}).get("role") != "super_admin":
        raise HTTPException(403, "Super admin only")
    payload = await request.json()
    b64 = (payload.get("file_base64") or "").strip()
    if not b64:
        raise HTTPException(400, "file_base64 required")
    import base64  # noqa: PLC0415
    try:
        audio_bytes = base64.b64decode(b64)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Invalid base64: {e}") from e
    if len(audio_bytes) > 5 * 1024 * 1024:
        raise HTTPException(413, "Ad MP3 must be ≤ 5 MB")
    key = f"voice/ad_{uuid.uuid4().hex[:8]}.mp3"
    url = await _upload_audio_to_r2(audio_bytes, key=key)
    if not url:
        raise HTTPException(503, "R2 upload failed")
    return {"audio_url": url, "key": key}


# ─── Call log admin API ──────────────────────────────────────────────
@router.get("/admin/voice/calls")
async def admin_list_calls(
    direction: Optional[str] = None,
    missed_only: bool = False,
    limit: int = 100,
    current_user: dict = Depends(get_current_user),
):
    _require_admin(current_user)
    db = get_db()
    q: dict = {}
    if direction in {"inbound", "outbound"}:
        q["direction"] = direction
    if missed_only:
        q["missed"] = True
    cur = db.voice_calls.find(q, {"_id": 0}).sort("started_at", -1).limit(max(1, min(500, limit)))
    return await cur.to_list(limit)


@router.get("/admin/voice/calls/{call_id}")
async def admin_get_call(call_id: str, current_user: dict = Depends(get_current_user)):
    _require_admin(current_user)
    db = get_db()
    row = await db.voice_calls.find_one({"id": call_id}, {"_id": 0})
    if not row:
        row = await db.voice_calls.find_one({"call_sid": call_id}, {"_id": 0})
    if not row:
        raise HTTPException(404, "Call not found")
    return row


@router.get("/admin/voice/recording/{call_id}")
async def admin_stream_recording(call_id: str,
                                 current_user: dict = Depends(get_current_user)):
    """Streams the Twilio recording (Basic Auth) through our backend so
    the admin browser doesn't need to hold Twilio credentials. Returns
    an audio/mpeg blob the <audio> tag can play."""
    _require_admin(current_user)
    db = get_db()
    row = await db.voice_calls.find_one({"$or": [{"id": call_id}, {"call_sid": call_id}]},
                                        {"_id": 0, "recording_url": 1})
    if not row or not row.get("recording_url"):
        raise HTTPException(404, "No recording available")
    url = row["recording_url"]
    if not url.endswith(".mp3"):
        url = url + ".mp3"
    auth = aiohttp.BasicAuth(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    try:
        async with aiohttp.ClientSession(auth=auth) as s:
            async with s.get(url, timeout=aiohttp.ClientTimeout(total=30)) as resp:
                if resp.status != 200:
                    raise HTTPException(502, f"Twilio responded {resp.status}")
                blob = await resp.read()
    except aiohttp.ClientError as e:
        raise HTTPException(502, f"Twilio fetch failed: {e}") from e
    return Response(content=blob, media_type="audio/mpeg",
                    headers={"Cache-Control": "private, max-age=600"})


# ─── Stats ────────────────────────────────────────────────────────────
@router.get("/admin/voice/stats")
async def admin_voice_stats(current_user: dict = Depends(get_current_user)):
    _require_admin(current_user)
    db = get_db()
    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
    week_start = (now - timedelta(days=7)).isoformat()
    month_start = (now - timedelta(days=30)).isoformat()

    async def _count_and_duration(filter_dict: dict):
        pipeline = [
            {"$match": filter_dict},
            {"$group": {
                "_id": None,
                "count": {"$sum": 1},
                "total_duration": {"$sum": {"$ifNull": ["$duration_seconds", 0]}},
                "missed": {"$sum": {"$cond": [{"$eq": ["$missed", True]}, 1, 0]}},
            }},
        ]
        agg = await db.voice_calls.aggregate(pipeline).to_list(1)
        if not agg:
            return {"count": 0, "total_duration": 0, "missed": 0}
        return agg[0]

    today = await _count_and_duration({"started_at": {"$gte": today_start}})
    week = await _count_and_duration({"started_at": {"$gte": week_start}})
    month = await _count_and_duration({"started_at": {"$gte": month_start}})

    # Per-day breakdown for the last 7 days
    pipeline = [
        {"$match": {"started_at": {"$gte": week_start}}},
        {"$project": {"day": {"$substr": ["$started_at", 0, 10]},
                      "missed": {"$cond": [{"$eq": ["$missed", True]}, 1, 0]}}},
        {"$group": {
            "_id": "$day",
            "count": {"$sum": 1},
            "missed": {"$sum": "$missed"},
        }},
        {"$sort": {"_id": 1}},
    ]
    daily = [
        {"day": row["_id"], "count": row["count"], "missed": row["missed"]}
        for row in await db.voice_calls.aggregate(pipeline).to_list(31)
    ]

    return {
        "today": today, "week": week, "month": month, "daily": daily,
        "generated_at": now.isoformat(),
    }


# ─── Helpers ──────────────────────────────────────────────────────────
def _xml_escape(value) -> str:
    if value is None:
        return ""
    s = str(value)
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
             .replace('"', "&quot;").replace("'", "&apos;"))


def _public_url(path: str) -> str:
    """Return absolute https URL for a backend path. Honours
    PUBLIC_BACKEND_URL env (set on Railway in prod) so Twilio calls
    back the right host even when we're behind a CDN."""
    base = (PUBLIC_BACKEND_URL or "").rstrip("/")
    if not base:
        base = "https://www.tilestation.co.uk"  # sensible fallback for prod
    return f"{base}{path}"


async def _upload_audio_to_r2(audio_bytes: bytes, key: str) -> Optional[str]:
    """Upload mp3 bytes to R2 and return the public URL. Mirrors the
    pattern in services/storage/r2_uploader.py but with audio/mpeg
    content-type."""
    try:
        from services.storage.r2_uploader import R2ImageUploader  # noqa: PLC0415
    except ImportError:
        return None
    client = R2ImageUploader.get_client()
    if not client:
        logger.error("R2 client not configured")
        return None
    bucket = R2ImageUploader.get_bucket_name()
    try:
        client.put_object(
            Bucket=bucket,
            Key=key,
            Body=io.BytesIO(audio_bytes).getvalue(),
            ContentType="audio/mpeg",
            CacheControl="public, max-age=2592000",  # 30 days
        )
        public_base = R2ImageUploader.get_public_url()
        return f"{public_base}/{key}"
    except Exception:  # noqa: BLE001
        logger.exception("R2 audio upload failed")
        return None

"""
Live Chat routes - Customer support chat with AI and human agents
"""
import uuid
import hashlib
import json
import logging
import os
from datetime import datetime, timezone, timedelta
from typing import Optional, List
from fastapi import APIRouter, HTTPException, Depends, Request, WebSocket, WebSocketDisconnect, Query
from pydantic import BaseModel

from config import get_db
from services import get_current_user, is_admin_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/live-chat", tags=["Live Chat"])

# Active WebSocket connections
_visitor_connections = {}  # visitor_id -> WebSocket
_admin_connections = []  # List of admin WebSockets


# ============ MODELS ============

class ChatSettings(BaseModel):
    """Chat widget configuration"""
    enabled: bool = True
    welcome_message: str = "Hi! How can we help you today?"
    offline_message: str = "We're currently offline. Leave us a message and we'll get back to you!"
    connecting_message: str = "Please wait while we connect you to our customer service team member."
    ai_enabled: bool = True
    ai_first_response: bool = True
    theme_color: str = "#1a1a1a"
    position: str = "bottom-right"
    # Online hours (UK time)
    online_hours_start: str = "08:00"
    online_hours_end: str = "18:00"
    no_response_timeout: int = 2  # minutes before showing contact form
    # Page-specific messages
    page_messages: dict = {}
    # Email notification settings
    notification_enabled: bool = True
    notification_threshold_minutes: int = 5
    notification_emails: List[str] = ["notifications@tilestation.co.uk"]
    # Browser notification
    browser_notification_sound: bool = True


class ChatMessageCreate(BaseModel):
    """Message from visitor"""
    session_id: str
    message: str
    visitor_name: Optional[str] = None
    visitor_email: Optional[str] = None


class AdminReplyCreate(BaseModel):
    """Reply from admin"""
    session_id: str
    message: str


class ChatSessionUpdate(BaseModel):
    """Update chat session"""
    status: Optional[str] = None  # open, resolved, escalated
    assigned_to: Optional[str] = None
    tags: Optional[List[str]] = None
    notes: Optional[str] = None


# ============ HELPER FUNCTIONS ============

def generate_session_id(ip: str, user_agent: str) -> str:
    """Generate a unique session ID"""
    combined = f"{ip}:{user_agent}:{datetime.now().strftime('%Y%m%d')}"
    return hashlib.sha256(combined.encode()).hexdigest()[:16]


async def get_visitor_location(ip: str, request: Optional["Request"] = None) -> dict:
    """Get visitor location.

    Priority order (most accurate first):
      1. Cloudflare `CF-IPCity` + `CF-IPCountry` headers — set by the
         "Add visitor location headers" Transform Rule. Avoids the
         mobile-carrier-NAT inaccuracy where every EE/Vodafone/Three
         visitor resolves to Manchester (30 May 2026 bug).
      2. `CF-IPCountry` alone (Free CF tier default) — country only,
         city left blank rather than falling back to IP-API which
         mangles mobile traffic.
      3. IP-API HTTP lookup — last resort, only used when no CF
         headers are present (preview env, direct backend hits).
    """
    import httpx

    # Skip for local/private IPs
    if ip in ["127.0.0.1", "localhost", "unknown"] or ip.startswith("192.168.") or ip.startswith("10."):
        return {"country": "Local", "city": "Local", "country_code": "LC"}

    if request is not None:
        cf_country = (request.headers.get("CF-IPCountry") or "").upper()
        cf_country = cf_country if len(cf_country) == 2 else ""
        cf_city = (request.headers.get("CF-IPCity") or "").strip()
        cf_region = (request.headers.get("CF-Region") or "").strip()
        if cf_country and cf_city:
            return {
                "country": cf_country,  # ISO2; chat UI tolerates code or name
                "city": cf_city,
                "region": cf_region,
                "country_code": cf_country,
            }
        if cf_country:
            return {
                "country": cf_country,
                "city": "Unknown",
                "region": cf_region,
                "country_code": cf_country,
            }

    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            response = await client.get(f"http://ip-api.com/json/{ip}?fields=country,city,countryCode,regionName")
            if response.status_code == 200:
                data = response.json()
                return {
                    "country": data.get("country", "Unknown"),
                    "city": data.get("city", "Unknown"),
                    "region": data.get("regionName", ""),
                    "country_code": data.get("countryCode", "XX")
                }
    except Exception as e:
        logger.debug(f"Geolocation lookup failed: {e}")
    
    return {"country": "Unknown", "city": "Unknown", "region": "", "country_code": "XX"}


async def get_ai_response(message: str, context: List[dict], db) -> Optional[str]:
    """Generate AI response using Gemini via Emergent Integration"""
    try:
        # Get store info for context
        showrooms = await db.showroom_pages.find({"active": True}, {"_id": 0, "name": 1, "phone": 1, "address": 1}).to_list(10)
        
        # Build context
        system_context = f"""You are a helpful customer support assistant for Tile Station, a premium tile retailer in the UK.

Store Information:
- We have {len(showrooms)} showrooms across the UK
- Showrooms: {', '.join([s.get('name', 'Unknown') for s in showrooms])}
- We offer free samples, free delivery on orders over £300
- Trade accounts available with discounts

Your role:
- Answer questions about products, delivery, samples, and showrooms
- Be helpful, friendly, and professional
- Keep responses concise (1-3 sentences when possible)
- If you can't answer something, suggest they contact a showroom or leave their details
- Never make up information about specific products or prices

Recent conversation context:
"""
        
        for msg in context[-5:]:  # Last 5 messages for context
            role = "Customer" if msg.get("sender") == "visitor" else "Assistant"
            system_context += f"\n{role}: {msg.get('message', '')}"
        
        user_prompt = f"Customer's message: {message}\n\nProvide a helpful, concise response:"

        # Use Emergent Integration
        from emergentintegrations.llm.chat import LlmChat, UserMessage
        import os
        from dotenv import load_dotenv
        
        load_dotenv()
        api_key = os.environ.get("EMERGENT_LLM_KEY")
        if not api_key:
            logger.warning("No EMERGENT_LLM_KEY for AI chat response")
            return None
        
        # Create chat instance
        chat = LlmChat(
            api_key=api_key,
            session_id=f"livechat-{uuid.uuid4().hex[:8]}",
            system_message=system_context
        ).with_model("gemini", "gemini-3-flash-preview")
        
        # Send message
        user_message = UserMessage(text=user_prompt)
        response = await chat.send_message(user_message)
        
        return response.strip() if response else None
        
    except Exception as e:
        logger.error(f"AI response error: {e}")
        return None


async def broadcast_to_admins(message: dict):
    """Broadcast message to all connected admin sockets"""
    for ws in _admin_connections[:]:
        try:
            await ws.send_json(message)
        except Exception:
            if ws in _admin_connections:
                _admin_connections.remove(ws)


async def send_to_visitor(visitor_id: str, message: dict):
    """Send message to a specific visitor"""
    ws = _visitor_connections.get(visitor_id)
    if ws:
        try:
            await ws.send_json(message)
        except Exception:
            if visitor_id in _visitor_connections:
                del _visitor_connections[visitor_id]


async def send_unanswered_chat_notification(session: dict, db):
    """Send email notification for unanswered chat"""
    try:
        import resend
        import os
        
        resend_api_key = os.environ.get("RESEND_API_KEY")
        if not resend_api_key:
            logger.warning("RESEND_API_KEY not configured for chat notifications")
            return False
        
        resend.api_key = resend_api_key
        
        # Get settings
        settings = await db.chat_settings.find_one({"type": "widget"}, {"_id": 0})
        if not settings or not settings.get("notification_enabled", True):
            return False
        
        notification_emails = settings.get("notification_emails", ["notifications@tilestation.co.uk"])
        if not notification_emails:
            return False
        
        # Get recent messages for context
        messages = await db.chat_messages.find(
            {"session_id": session["session_id"]},
            {"_id": 0}
        ).sort("timestamp", -1).limit(5).to_list(5)
        
        # Build message preview
        visitor_messages = [m for m in messages if m.get("sender") == "visitor"]
        last_message = visitor_messages[0] if visitor_messages else None
        
        visitor_name = session.get("visitor_name") or "Anonymous Visitor"
        visitor_email = session.get("visitor_email") or "Not provided"
        message_preview = last_message.get("message", "No message")[:200] if last_message else "No message"
        
        # Calculate wait time
        last_activity = session.get("last_activity")
        if last_activity:
            if isinstance(last_activity, str):
                last_time = datetime.fromisoformat(last_activity.replace('Z', '+00:00'))
            else:
                last_time = last_activity
            wait_mins = int((datetime.now(timezone.utc) - last_time).total_seconds() / 60)
        else:
            wait_mins = "Unknown"
        
        # Send email
        email_html = f"""
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: #1a1a1a; color: #F7EA1C; padding: 20px; text-align: center;">
                <h1 style="margin: 0;">Tile Station Live Chat</h1>
            </div>
            <div style="padding: 20px; background: #f9f9f9;">
                <h2 style="color: #e74c3c; margin-top: 0;">⚠️ Unanswered Chat Alert</h2>
                <p>A customer has been waiting <strong>{wait_mins} minutes</strong> for a response.</p>
                
                <div style="background: white; padding: 15px; border-radius: 8px; margin: 15px 0;">
                    <h3 style="margin-top: 0; color: #333;">Customer Details</h3>
                    <p><strong>Name:</strong> {visitor_name}</p>
                    <p><strong>Email:</strong> {visitor_email}</p>
                    <p><strong>Session ID:</strong> {session.get('session_id', 'N/A')}</p>
                </div>
                
                <div style="background: white; padding: 15px; border-radius: 8px; margin: 15px 0;">
                    <h3 style="margin-top: 0; color: #333;">Last Message</h3>
                    <p style="color: #666; font-style: italic;">"{message_preview}"</p>
                </div>
                
                <a href="https://tilestation.co.uk/admin/live-chat" 
                   style="display: inline-block; background: #1a1a1a; color: #F7EA1C; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin-top: 10px;">
                    Open Live Chat Dashboard →
                </a>
            </div>
            <div style="padding: 15px; text-align: center; color: #888; font-size: 12px;">
                This is an automated notification from Tile Station Live Chat
            </div>
        </div>
        """
        
        await asyncio.to_thread(
            resend.Emails.send,
            {
                "from": "Tile Station <notifications@tilestation.co.uk>",
                "to": notification_emails,
                "subject": f"⚠️ Unanswered Chat - {visitor_name} waiting {wait_mins} mins",
                "html": email_html
            }
        )
        
        # Mark notification sent
        await db.chat_sessions.update_one(
            {"session_id": session["session_id"]},
            {"$set": {"notification_sent": True, "notification_sent_at": datetime.now(timezone.utc).isoformat()}}
        )
        
        logger.info(f"Sent unanswered chat notification for session {session['session_id']}")
        return True
        
    except Exception as e:
        logger.error(f"Failed to send chat notification: {e}")
        return False


# 18 Jun 2026 — Customer-side missed-chat email.
# Previously, admin replies were ONLY pushed via WebSocket. If the visitor
# had closed the page (which is what "missed chat" means in practice),
# the WS broadcast went nowhere — so the customer never saw the reply.
# This helper emails the reply to the visitor whenever:
#   • we have a visitor_email on file (from the offline form or live chat)
#   • AND the visitor isn't actively connected via WebSocket
# It is rate-limited to 1 email per session per 60s so back-to-back admin
# replies coalesce instead of spamming the customer's inbox.
async def send_admin_reply_to_visitor_email(
    session: dict,
    admin_msg: dict,
    db,
    *,
    force: bool = False,
):
    """Email an admin chat reply to the visitor.

    `force=True` skips the online/rate-limit guards (used by the manual
    "Resend by email" admin button)."""
    session_id = session.get("session_id")
    visitor_email = (session.get("visitor_email") or "").strip()
    if not visitor_email or "@" not in visitor_email:
        return {"sent": False, "reason": "no_visitor_email"}

    # Skip if visitor is actively connected (the WS already delivered it).
    if not force and _visitor_connections.get(session_id) is not None:
        return {"sent": False, "reason": "visitor_online"}

    # Rate-limit: one email per session per 60s.
    if not force:
        last_sent = session.get("last_email_reply_at")
        if last_sent:
            try:
                last_dt = datetime.fromisoformat(str(last_sent).replace("Z", "+00:00"))
                if (datetime.now(timezone.utc) - last_dt).total_seconds() < 60:
                    return {"sent": False, "reason": "rate_limited"}
            except Exception:
                pass  # malformed timestamp — just send

    try:
        import resend
        resend_api_key = os.environ.get("RESEND_API_KEY")
        if not resend_api_key:
            logger.warning("RESEND_API_KEY not configured — visitor reply email skipped")
            return {"sent": False, "reason": "no_api_key"}
        resend.api_key = resend_api_key

        visitor_name = (session.get("visitor_name") or "").strip() or "there"
        sender_name = admin_msg.get("sender_name") or "Tile Station Support"
        reply_text = (admin_msg.get("message") or "").strip()
        reply_html = (
            reply_text
            .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace("\n", "<br/>")
        )

        # Pull the visitor's last question for context.
        last_visitor = await db.chat_messages.find_one(
            {"session_id": session_id, "sender": "visitor"},
            {"_id": 0, "message": 1},
            sort=[("timestamp", -1)],
        )
        last_q = (last_visitor or {}).get("message", "").strip()
        last_q_html = (
            last_q.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        ) if last_q else ""

        storefront = (
            os.environ.get("STOREFRONT_PUBLIC_URL")
            or "https://tilestation.co.uk"
        ).rstrip("/")
        # Deep link back so the visitor can resume the conversation in the
        # same session — the widget restores from localStorage by default,
        # so just sending them to the home page is enough in practice.
        resume_url = f"{storefront}/?utm_source=chat-reply&utm_medium=email"

        email_html = f"""
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: #1a1a1a; color: #F7EA1C; padding: 20px; text-align: center;">
                <h1 style="margin: 0; font-size: 22px;">Tile Station</h1>
                <p style="margin: 6px 0 0; font-size: 13px; opacity: 0.85;">Reply from our support team</p>
            </div>
            <div style="padding: 22px; background: #f9f9f9;">
                <p style="margin-top: 0;">Hi {visitor_name},</p>
                <p>Sorry we missed you on live chat — here's our reply to your question:</p>

                {f'<div style="background:#fff;border-left:3px solid #ccc;padding:10px 14px;margin:12px 0;color:#555;font-size:13px;"><em>You asked:</em><br/>{last_q_html}</div>' if last_q_html else ''}

                <div style="background:#fff;border-left:3px solid #F7EA1C;padding:14px 16px;margin:12px 0;border-radius:4px;">
                    <p style="margin:0 0 6px;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">{sender_name} replied:</p>
                    <p style="margin:0;color:#222;line-height:1.5;">{reply_html}</p>
                </div>

                <p style="margin-top:18px;">Just reply to this email if you'd like to carry on the conversation — it goes straight to our team.</p>
                <p style="margin-top:6px;">Or pop back to the site and re-open the chat:</p>
                <p style="text-align:center;margin:18px 0;">
                    <a href="{resume_url}"
                       style="display:inline-block;background:#1a1a1a;color:#F7EA1C;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:600;">
                        Continue the chat →
                    </a>
                </p>
            </div>
            <div style="padding:14px;text-align:center;color:#888;font-size:12px;">
                Tile Station · 4 showrooms in Kent &amp; London ·
                <a href="{storefront}" style="color:#888;">tilestation.co.uk</a>
            </div>
        </div>
        """

        # Use sender's email as reply-to so the customer can reply directly
        # to the team member who answered them.
        reply_to = admin_msg.get("sender_email") or "hello@tilestation.co.uk"

        await asyncio.to_thread(
            resend.Emails.send,
            {
                "from": "Tile Station Support <support@tilestation.co.uk>",
                "to": [visitor_email],
                "reply_to": reply_to,
                "subject": "Reply from Tile Station — sorry we missed you on chat",
                "html": email_html,
            }
        )

        await db.chat_sessions.update_one(
            {"session_id": session_id},
            {"$set": {
                "last_email_reply_at": datetime.now(timezone.utc).isoformat(),
            }, "$inc": {"reply_emails_sent": 1}},
        )
        logger.info(
            f"Visitor reply email sent to {visitor_email} for session {session_id}"
        )
        return {"sent": True}

    except Exception as e:
        logger.exception(f"Failed to email admin reply to visitor: {e}")
        return {"sent": False, "reason": "exception", "error": str(e)[:200]}


async def check_unanswered_chats():
    """Background task to check for unanswered chats and send notifications"""
    try:
        db = get_db()
        
        # Get settings
        settings = await db.chat_settings.find_one({"type": "widget"}, {"_id": 0})
        if not settings or not settings.get("notification_enabled", True):
            return
        
        threshold_minutes = settings.get("notification_threshold_minutes", 5)
        threshold_time = datetime.now(timezone.utc) - timedelta(minutes=threshold_minutes)
        
        # Find sessions that:
        # 1. Are open
        # 2. Have visitor messages
        # 3. Last admin reply is older than threshold OR no admin reply at all
        # 4. Notification not already sent
        open_sessions = await db.chat_sessions.find({
            "status": "open",
            "notification_sent": {"$ne": True}
        }, {"_id": 0}).to_list(100)
        
        for session in open_sessions:
            # Get last messages
            messages = await db.chat_messages.find(
                {"session_id": session["session_id"]},
                {"_id": 0}
            ).sort("timestamp", -1).limit(20).to_list(20)
            
            if not messages:
                continue
            
            # Find last visitor message
            visitor_messages = [m for m in messages if m.get("sender") == "visitor"]
            if not visitor_messages:
                continue
            
            last_visitor_msg = visitor_messages[0]
            last_visitor_time = last_visitor_msg.get("timestamp")
            if isinstance(last_visitor_time, str):
                last_visitor_time = datetime.fromisoformat(last_visitor_time.replace('Z', '+00:00'))
            
            # Find last admin reply after that visitor message
            admin_messages = [m for m in messages if m.get("sender") == "admin"]
            has_recent_admin_reply = False
            
            for admin_msg in admin_messages:
                admin_time = admin_msg.get("timestamp")
                if isinstance(admin_time, str):
                    admin_time = datetime.fromisoformat(admin_time.replace('Z', '+00:00'))
                if admin_time > last_visitor_time:
                    has_recent_admin_reply = True
                    break
            
            # If no admin reply and visitor message is old enough, send notification
            if not has_recent_admin_reply and last_visitor_time < threshold_time:
                await send_unanswered_chat_notification(session, db)
                
    except Exception as e:
        logger.error(f"Error checking unanswered chats: {e}")


import asyncio

# ============ PUBLIC ENDPOINTS (No Auth) ============

@router.get("/settings/public")
async def get_public_settings():
    """Get chat widget settings for public website"""
    db = get_db()
    
    settings = await db.chat_settings.find_one({"type": "widget"}, {"_id": 0})
    
    if not settings:
        # Return defaults
        return {
            "enabled": True,
            "welcome_message": "Hi! How can we help you today?",
            "offline_message": "We're currently offline. Leave a message and we'll get back to you!",
            "connecting_message": "Please wait while we connect you to our customer service team member.",
            "ai_enabled": True,
            "theme_color": "#1a1a1a",
            "position": "bottom-right",
            "online_hours_start": "08:00",
            "online_hours_end": "18:00",
            "no_response_timeout": 2,
            "page_messages": {
                "/shop/tiles": "Looking for the perfect tile? I can help!",
                "/shop/contact": "Want to visit a showroom? I can help you find one!",
                "/shop/sample-service": "Need free samples? I can explain how it works!"
            }
        }
    
    # Ensure new fields have defaults
    settings.setdefault("connecting_message", "Please wait while we connect you to our customer service team member.")
    settings.setdefault("online_hours_start", "08:00")
    settings.setdefault("online_hours_end", "18:00")
    settings.setdefault("no_response_timeout", 2)
    
    return settings


@router.post("/session/start")
async def start_chat_session(request: Request):
    """Start a new chat session (public endpoint)"""
    db = get_db()
    
    # Get visitor info
    ip = request.headers.get("X-Forwarded-For", request.client.host if request.client else "unknown")
    if "," in ip:
        ip = ip.split(",")[0].strip()
    user_agent = request.headers.get("User-Agent", "")
    
    # Generate or retrieve session
    session_id = generate_session_id(ip, user_agent)
    
    # Check for existing session
    existing = await db.chat_sessions.find_one({"session_id": session_id}, {"_id": 0})
    
    if existing:
        # Get messages
        messages = await db.chat_messages.find(
            {"session_id": session_id},
            {"_id": 0}
        ).sort("timestamp", 1).to_list(100)
        
        return {
            "session_id": session_id,
            "is_new": False,
            "messages": messages
        }
    
    # Get visitor location
    location = await get_visitor_location(ip, request=request)
    
    # Create new session
    session = {
        "session_id": session_id,
        "status": "open",
        "visitor_ip_hash": hashlib.sha256(ip.encode()).hexdigest()[:12],
        "user_agent": user_agent[:200],
        "location": location,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "last_activity": datetime.now(timezone.utc).isoformat(),
        "visitor_name": None,
        "visitor_email": None,
        "assigned_to": None,
        "tags": [],
        "notes": "",
        "message_count": 0
    }
    
    await db.chat_sessions.insert_one(session)
    
    # Get welcome message
    settings = await db.chat_settings.find_one({"type": "widget"}, {"_id": 0})
    welcome_msg = settings.get("welcome_message", "Hi! How can we help you today?") if settings else "Hi! How can we help you today?"
    
    # Add welcome message
    welcome = {
        "id": str(uuid.uuid4()),
        "session_id": session_id,
        "sender": "system",
        "sender_name": "Tile Station",
        "message": welcome_msg,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }
    await db.chat_messages.insert_one(welcome)
    
    # Notify admins
    await broadcast_to_admins({
        "type": "new_session",
        "session": {k: v for k, v in session.items() if k != "_id"}
    })
    
    return {
        "session_id": session_id,
        "is_new": True,
        "messages": [{k: v for k, v in welcome.items() if k != "_id"}]
    }


async def send_instant_email_notification(session_id: str, visitor_name: str, message: str, db):
    """Send instant email notification when a visitor sends a message"""
    try:
        import resend
        import os
        
        resend_api_key = os.environ.get("RESEND_API_KEY")
        if not resend_api_key:
            logger.warning("RESEND_API_KEY not configured for instant notifications")
            return
        
        resend.api_key = resend_api_key
        
        settings = await db.chat_settings.find_one({"type": "widget"}, {"_id": 0})
        if not settings or not settings.get("notification_enabled", True):
            return
        
        notification_emails = settings.get("notification_emails", ["notifications@tilestation.co.uk"])
        if not notification_emails:
            return
        
        # Rate limit: don't email more than once per minute per session
        session = await db.chat_sessions.find_one({"session_id": session_id})
        last_notified = session.get("last_email_notified") if session else None
        if last_notified:
            try:
                last_time = datetime.fromisoformat(last_notified.replace('Z', '+00:00'))
                if (datetime.now(timezone.utc) - last_time).total_seconds() < 60:
                    return
            except Exception:
                pass
        
        # Mark as notified
        await db.chat_sessions.update_one(
            {"session_id": session_id},
            {"$set": {"last_email_notified": datetime.now(timezone.utc).isoformat()}}
        )
        
        email_html = f"""
        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto;">
            <div style="background: #1a1a1a; color: #F7EA1C; padding: 15px 20px; border-radius: 8px 8px 0 0;">
                <h2 style="margin: 0; font-size: 16px;">New Live Chat Message</h2>
            </div>
            <div style="border: 1px solid #e5e7eb; border-top: none; padding: 20px; border-radius: 0 0 8px 8px;">
                <p style="margin: 0 0 8px; color: #6b7280; font-size: 13px;">From: <strong style="color: #111;">{visitor_name}</strong></p>
                <div style="background: #f3f4f6; padding: 12px 16px; border-radius: 8px; margin: 12px 0;">
                    <p style="margin: 0; color: #111; font-size: 14px;">{message[:500]}</p>
                </div>
                <a href="https://tilestation.co.uk/admin/live-chat" 
                   style="display: inline-block; background: #1a1a1a; color: #F7EA1C; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-size: 13px; margin-top: 12px;">
                    Reply Now
                </a>
            </div>
        </div>
        """
        
        await asyncio.to_thread(
            resend.Emails.send,
            {
                "from": "Tile Station <notifications@tilestation.co.uk>",
                "to": notification_emails,
                "subject": f"Live Chat: {visitor_name} sent a message",
                "html": email_html
            }
        )
        logger.info(f"Instant email notification sent for session {session_id}")
    except Exception as e:
        logger.error(f"Error sending instant email notification: {e}")


@router.post("/message")
async def send_visitor_message(data: ChatMessageCreate, request: Request):
    """Send a message from visitor (public endpoint)"""
    db = get_db()
    
    # Verify session exists
    session = await db.chat_sessions.find_one({"session_id": data.session_id})
    if not session:
        raise HTTPException(status_code=404, detail="Chat session not found")
    
    # Update visitor info if provided
    update_data = {"last_activity": datetime.now(timezone.utc).isoformat()}
    if data.visitor_name:
        update_data["visitor_name"] = data.visitor_name
    if data.visitor_email:
        update_data["visitor_email"] = data.visitor_email
    
    await db.chat_sessions.update_one(
        {"session_id": data.session_id},
        {"$set": update_data, "$inc": {"message_count": 1}}
    )
    
    # Save visitor message
    visitor_msg = {
        "id": str(uuid.uuid4()),
        "session_id": data.session_id,
        "sender": "visitor",
        "sender_name": data.visitor_name or "Visitor",
        "message": data.message,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }
    await db.chat_messages.insert_one(visitor_msg)
    
    # Notify admins via WebSocket
    await broadcast_to_admins({
        "type": "new_message",
        "session_id": data.session_id,
        "message": {k: v for k, v in visitor_msg.items() if k != "_id"}
    })
    
    # Send instant email notification
    asyncio.create_task(send_instant_email_notification(
        session_id=data.session_id,
        visitor_name=data.visitor_name or session.get("visitor_name", "Visitor"),
        message=data.message,
        db=db
    ))

    # 24 May 2026 — fire an INSTANT Telegram alert too. Email
    # notifications get lost in support inboxes and the "unanswered
    # chat" cron only runs every few minutes — the team kept missing
    # live customers (Lenard Kuklis, 24 May 2026: "I don't get any
    # messages on telegram which is annoying as customer waits"). The
    # dedupe_key is the message_id so every new visitor message
    # comes through, even within the same session, even within the
    # 1-hour dedupe window.
    try:
        from services.telegram_notify import fire_and_forget
        import html as _html
        _visitor_label = data.visitor_name or session.get("visitor_name") or "Visitor"
        _visitor_email = data.visitor_email or session.get("visitor_email") or ""
        _location = session.get("visitor_city") or session.get("visitor_country") or ""
        _location_line = f"\n📍 <i>{_html.escape(_location)}</i>" if _location else ""
        _email_line = f"\n✉️ <i>{_html.escape(_visitor_email)}</i>" if _visitor_email else ""
        _msg_preview = data.message if len(data.message) <= 400 else data.message[:400] + "…"
        _admin_url = (
            os.environ.get("STOREFRONT_PUBLIC_URL")
            or "https://tilestation.co.uk"
        ).rstrip("/") + "/admin/live-chat"
        _tg_text = (
            f"💬 <b>New chat message</b>\n"
            f"<b>{_html.escape(_visitor_label)}</b>"
            f"{_email_line}"
            f"{_location_line}\n\n"
            f"{_html.escape(_msg_preview)}\n\n"
            f"<a href=\"{_admin_url}\">Reply now →</a>"
        )
        fire_and_forget(
            "new_chat_message",
            _tg_text,
            dedupe_key=visitor_msg["id"],
        )
    except Exception:
        # Never let a Telegram hiccup break the customer's message flow
        logger.exception("Telegram notify for chat message failed (non-fatal)")
    
    # Check if AI response is enabled and no admin is assigned
    settings = await db.chat_settings.find_one({"type": "widget"}, {"_id": 0})
    ai_enabled = settings.get("ai_enabled", True) if settings else True
    ai_first = settings.get("ai_first_response", True) if settings else True
    
    ai_response = None
    if ai_enabled and (ai_first or not session.get("assigned_to")):
        # Get conversation context
        messages = await db.chat_messages.find(
            {"session_id": data.session_id},
            {"_id": 0}
        ).sort("timestamp", 1).to_list(10)
        
        ai_response = await get_ai_response(data.message, messages, db)
        
        if ai_response:
            ai_msg = {
                "id": str(uuid.uuid4()),
                "session_id": data.session_id,
                "sender": "ai",
                "sender_name": "Tile Station Assistant",
                "message": ai_response,
                "timestamp": datetime.now(timezone.utc).isoformat()
            }
            await db.chat_messages.insert_one(ai_msg)
            
            # Send to visitor and admins
            await send_to_visitor(data.session_id, {
                "type": "message",
                "message": {k: v for k, v in ai_msg.items() if k != "_id"}
            })
            await broadcast_to_admins({
                "type": "ai_response",
                "session_id": data.session_id,
                "message": {k: v for k, v in ai_msg.items() if k != "_id"}
            })
    
    return {
        "success": True,
        "message": {k: v for k, v in visitor_msg.items() if k != "_id"},
        "ai_response": {k: v for k, v in ai_msg.items() if k != "_id"} if ai_response else None
    }


@router.get("/messages/{session_id}")
async def get_session_messages(session_id: str):
    """Get all messages for a chat session (public endpoint)"""
    db = get_db()
    
    messages = await db.chat_messages.find(
        {"session_id": session_id},
        {"_id": 0}
    ).sort("timestamp", 1).to_list(200)
    
    return {"messages": messages}



@router.post("/offline-message")
async def submit_offline_message(data: dict):
    """Submit contact details when no agent responds within timeout"""
    db = get_db()
    
    session_id = data.get("session_id")
    name = data.get("name", "")
    email = data.get("email", "")
    message = data.get("message", "")
    
    # Store offline message
    offline_msg = {
        "id": str(uuid.uuid4()),
        "session_id": session_id,
        "name": name,
        "email": email,
        "message": message,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "type": "offline_contact",
        "followed_up": False
    }
    await db.offline_messages.insert_one(offline_msg)
    
    # Update session with contact info
    if session_id:
        await db.chat_sessions.update_one(
            {"session_id": session_id},
            {"$set": {
                "visitor_name": name,
                "visitor_email": email,
                "has_offline_message": True,
                "last_activity": datetime.now(timezone.utc).isoformat()
            }}
        )
    
    # Add a system message to the chat
    sys_msg = {
        "id": str(uuid.uuid4()),
        "session_id": session_id,
        "sender": "system",
        "sender_name": "System",
        "message": f"Visitor left contact details - Name: {name}, Email: {email}" + (f", Message: {message}" if message else ""),
        "timestamp": datetime.now(timezone.utc).isoformat()
    }
    await db.chat_messages.insert_one(sys_msg)
    
    # Notify admins
    await broadcast_to_admins({
        "type": "offline_message",
        "session_id": session_id,
        "name": name,
        "email": email,
        "message": message
    })

    # 24 May 2026 — also fire Telegram for offline messages. These are
    # high-signal: visitor cared enough to leave email + a question,
    # team should jump in faster than the email cron allows.
    try:
        from services.telegram_notify import fire_and_forget
        import html as _html
        _msg_preview = message if len(message) <= 400 else message[:400] + "…"
        _admin_url = (
            os.environ.get("STOREFRONT_PUBLIC_URL")
            or "https://tilestation.co.uk"
        ).rstrip("/") + "/admin/live-chat"
        _tg_text = (
            f"📝 <b>Visitor left contact details</b>\n"
            f"<b>{_html.escape(name or 'Anonymous')}</b>"
            + (f"\n✉️ <i>{_html.escape(email)}</i>" if email else "")
            + (f"\n\n{_html.escape(_msg_preview)}" if message else "")
            + f"\n\n<a href=\"{_admin_url}\">Reply now →</a>"
        )
        fire_and_forget(
            "new_chat_message",
            _tg_text,
            dedupe_key=offline_msg["id"],
        )
    except Exception:
        logger.exception("Telegram notify for offline message failed (non-fatal)")

    return {"success": True}


# ============ ADMIN ENDPOINTS (Auth Required) ============

@router.get("/sessions")
async def get_chat_sessions(
    status: Optional[str] = None,
    limit: int = 50,
    current_user: dict = Depends(get_current_user)
):
    """Get all chat sessions (admin only)"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    
    query = {}
    if status:
        query["status"] = status
    
    sessions = await db.chat_sessions.find(query, {"_id": 0}).sort("last_activity", -1).to_list(limit)
    
    # Get unread count for each session
    for session in sessions:
        unread = await db.chat_messages.count_documents({
            "session_id": session["session_id"],
            "sender": "visitor",
            "read_by_admin": {"$ne": True}
        })
        session["unread_count"] = unread
    
    return {"sessions": sessions}


@router.get("/sessions/{session_id}")
async def get_session_detail(session_id: str, current_user: dict = Depends(get_current_user)):
    """Get session detail with messages (admin only)"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    
    session = await db.chat_sessions.find_one({"session_id": session_id}, {"_id": 0})
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    
    messages = await db.chat_messages.find(
        {"session_id": session_id},
        {"_id": 0}
    ).sort("timestamp", 1).to_list(200)
    
    # Mark messages as read
    await db.chat_messages.update_many(
        {"session_id": session_id, "sender": "visitor"},
        {"$set": {"read_by_admin": True}}
    )
    
    return {"session": session, "messages": messages}


@router.post("/reply")
async def admin_reply(data: AdminReplyCreate, current_user: dict = Depends(get_current_user)):
    """Send a reply from admin"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    
    # Verify session exists
    session = await db.chat_sessions.find_one({"session_id": data.session_id})
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    
    # Update session
    await db.chat_sessions.update_one(
        {"session_id": data.session_id},
        {
            "$set": {
                "last_activity": datetime.now(timezone.utc).isoformat(),
                "assigned_to": current_user.get("email")
            },
            "$inc": {"message_count": 1}
        }
    )
    
    # Save admin message
    admin_msg = {
        "id": str(uuid.uuid4()),
        "session_id": data.session_id,
        "sender": "admin",
        "sender_name": current_user.get("name", "Support"),
        "sender_email": current_user.get("email"),
        "message": data.message,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }
    await db.chat_messages.insert_one(admin_msg)
    
    # Send to visitor
    await send_to_visitor(data.session_id, {
        "type": "message",
        "message": {k: v for k, v in admin_msg.items() if k not in ["_id", "sender_email"]}
    })

    # 18 Jun 2026 — Also email the reply if the visitor isn't actively
    # connected and we have their email on file. `send_admin_reply_to_visitor_email`
    # is fully guarded (no-op if visitor is online, rate-limited to 60s).
    # Fire-and-forget so the admin's HTTP request returns immediately.
    fresh_session = await db.chat_sessions.find_one(
        {"session_id": data.session_id}, {"_id": 0}
    ) or session
    asyncio.create_task(send_admin_reply_to_visitor_email(fresh_session, admin_msg, db))

    # Notify other admins
    await broadcast_to_admins({
        "type": "admin_reply",
        "session_id": data.session_id,
        "message": {k: v for k, v in admin_msg.items() if k != "_id"}
    })
    
    return {"success": True, "message": {k: v for k, v in admin_msg.items() if k != "_id"}}


@router.put("/sessions/{session_id}")
async def update_session(
    session_id: str,
    data: ChatSessionUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Update chat session (admin only)"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    
    update_data = {"updated_at": datetime.now(timezone.utc).isoformat()}
    if data.status:
        update_data["status"] = data.status
    if data.assigned_to is not None:
        update_data["assigned_to"] = data.assigned_to
    if data.tags is not None:
        update_data["tags"] = data.tags
    if data.notes is not None:
        update_data["notes"] = data.notes
    
    result = await db.chat_sessions.update_one(
        {"session_id": session_id},
        {"$set": update_data}
    )
    
    if result.modified_count == 0:
        raise HTTPException(status_code=404, detail="Session not found")
    
    return {"success": True}


@router.get("/settings")
async def get_chat_settings(current_user: dict = Depends(get_current_user)):
    """Get chat settings (admin only)"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    
    settings = await db.chat_settings.find_one({"type": "widget"}, {"_id": 0})
    
    if not settings:
        # Return defaults
        settings = {
            "type": "widget",
            "enabled": True,
            "welcome_message": "Hi! How can we help you today?",
            "offline_message": "We're currently offline. Leave a message and we'll get back to you!",
            "connecting_message": "Please wait while we connect you to our customer service team member.",
            "ai_enabled": True,
            "ai_first_response": True,
            "theme_color": "#1a1a1a",
            "position": "bottom-right",
            "online_hours_start": "08:00",
            "online_hours_end": "18:00",
            "no_response_timeout": 2,
            "browser_notification_sound": True,
            "notification_enabled": True,
            "notification_emails": ["notifications@tilestation.co.uk"],
            "page_messages": {
                "/shop/tiles": "Looking for the perfect tile? I can help!",
                "/shop/contact": "Want to visit a showroom? I can help you find one!",
                "/shop/sample-service": "Need free samples? I can explain how it works!"
            }
        }
    
    # Ensure new fields have defaults
    settings.setdefault("connecting_message", "Please wait while we connect you to our customer service team member.")
    settings.setdefault("online_hours_start", "08:00")
    settings.setdefault("online_hours_end", "18:00")
    settings.setdefault("no_response_timeout", 2)
    settings.setdefault("browser_notification_sound", True)
    
    return settings


@router.put("/settings")
async def update_chat_settings(settings: ChatSettings, current_user: dict = Depends(get_current_user)):
    """Update chat settings (admin only)"""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super Admin access required")
    
    db = get_db()
    
    settings_dict = settings.dict()
    settings_dict["type"] = "widget"
    settings_dict["updated_at"] = datetime.now(timezone.utc).isoformat()
    settings_dict["updated_by"] = current_user.get("email")
    
    await db.chat_settings.update_one(
        {"type": "widget"},
        {"$set": settings_dict},
        upsert=True
    )
    
    return {"success": True}


@router.get("/stats")
async def get_chat_stats(current_user: dict = Depends(get_current_user)):
    """Get chat statistics (admin only)"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    
    # Today's stats
    today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    
    total_sessions = await db.chat_sessions.count_documents({})
    open_sessions = await db.chat_sessions.count_documents({"status": "open"})
    today_sessions = await db.chat_sessions.count_documents({
        "started_at": {"$gte": today.isoformat()}
    })
    
    total_messages = await db.chat_messages.count_documents({})
    visitor_messages = await db.chat_messages.count_documents({"sender": "visitor"})
    ai_messages = await db.chat_messages.count_documents({"sender": "ai"})
    admin_messages = await db.chat_messages.count_documents({"sender": "admin"})
    
    return {
        "total_sessions": total_sessions,
        "open_sessions": open_sessions,
        "today_sessions": today_sessions,
        "total_messages": total_messages,
        "visitor_messages": visitor_messages,
        "ai_messages": ai_messages,
        "admin_messages": admin_messages
    }


@router.post("/check-notifications")
async def trigger_notification_check(current_user: dict = Depends(get_current_user)):
    """Manually trigger check for unanswered chats (admin only)"""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super Admin access required")
    
    await check_unanswered_chats()
    return {"success": True, "message": "Notification check completed"}


@router.post("/test-notification/{session_id}")
async def test_send_notification(session_id: str, current_user: dict = Depends(get_current_user)):
    """Test send notification for a specific session (admin only)"""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super Admin access required")
    
    db = get_db()
    session = await db.chat_sessions.find_one({"session_id": session_id}, {"_id": 0})
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    
    result = await send_unanswered_chat_notification(session, db)
    return {"success": result, "message": "Notification sent" if result else "Failed to send notification"}


@router.post("/sessions/{session_id}/email-last-reply")
async def email_last_admin_reply_to_visitor(
    session_id: str,
    current_user: dict = Depends(get_current_user),
):
    """Manually resend the most recent admin reply to the visitor's email.

    Used by the admin chat-detail panel when the team wants to be sure the
    customer received a reply (e.g. for a chat the visitor closed before
    seeing it). Honours rate-limit unless visitor has no live WebSocket.
    """
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")

    db = get_db()
    session = await db.chat_sessions.find_one({"session_id": session_id}, {"_id": 0})
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if not (session.get("visitor_email") or "").strip():
        raise HTTPException(
            status_code=400,
            detail="No visitor email on file for this chat (the customer never left one).",
        )

    last_admin_msg = await db.chat_messages.find_one(
        {"session_id": session_id, "sender": "admin"},
        {"_id": 0},
        sort=[("timestamp", -1)],
    )
    if not last_admin_msg:
        raise HTTPException(
            status_code=400,
            detail="No admin reply has been sent for this chat yet.",
        )

    result = await send_admin_reply_to_visitor_email(
        session, last_admin_msg, db, force=True
    )
    return {
        "success": bool(result.get("sent")),
        "visitor_email": session.get("visitor_email"),
        "detail": result,
    }


# ============ WEBSOCKET ENDPOINTS ============

@router.websocket("/ws/visitor/{session_id}")
async def websocket_visitor(websocket: WebSocket, session_id: str):
    """WebSocket connection for visitor real-time chat"""
    await websocket.accept()
    _visitor_connections[session_id] = websocket
    
    try:
        while True:
            data = await websocket.receive_json()
            
            if data.get("type") == "message":
                # Process message through the regular endpoint logic
                db = get_db()
                
                visitor_msg = {
                    "id": str(uuid.uuid4()),
                    "session_id": session_id,
                    "sender": "visitor",
                    "sender_name": data.get("visitor_name", "Visitor"),
                    "message": data.get("message"),
                    "timestamp": datetime.now(timezone.utc).isoformat()
                }
                await db.chat_messages.insert_one(visitor_msg)
                
                await db.chat_sessions.update_one(
                    {"session_id": session_id},
                    {
                        "$set": {"last_activity": datetime.now(timezone.utc).isoformat()},
                        "$inc": {"message_count": 1}
                    }
                )
                
                # Notify admins
                await broadcast_to_admins({
                    "type": "new_message",
                    "session_id": session_id,
                    "message": {k: v for k, v in visitor_msg.items() if k != "_id"}
                })
                
                # Check for AI response
                settings = await db.chat_settings.find_one({"type": "widget"}, {"_id": 0})
                if settings and settings.get("ai_enabled"):
                    messages = await db.chat_messages.find(
                        {"session_id": session_id},
                        {"_id": 0}
                    ).sort("timestamp", 1).to_list(10)
                    
                    ai_response = await get_ai_response(data.get("message"), messages, db)
                    
                    if ai_response:
                        ai_msg = {
                            "id": str(uuid.uuid4()),
                            "session_id": session_id,
                            "sender": "ai",
                            "sender_name": "Tile Station Assistant",
                            "message": ai_response,
                            "timestamp": datetime.now(timezone.utc).isoformat()
                        }
                        await db.chat_messages.insert_one(ai_msg)
                        
                        await websocket.send_json({
                            "type": "message",
                            "message": {k: v for k, v in ai_msg.items() if k != "_id"}
                        })
                        
                        await broadcast_to_admins({
                            "type": "ai_response",
                            "session_id": session_id,
                            "message": {k: v for k, v in ai_msg.items() if k != "_id"}
                        })
            
            elif data.get("type") == "typing":
                # Broadcast typing indicator to admins
                await broadcast_to_admins({
                    "type": "visitor_typing",
                    "session_id": session_id
                })
    
    except WebSocketDisconnect:
        pass
    finally:
        if session_id in _visitor_connections:
            del _visitor_connections[session_id]


@router.websocket("/ws/admin")
async def websocket_admin(websocket: WebSocket):
    """WebSocket connection for admin real-time updates"""
    # Note: In production, add token verification here
    await websocket.accept()
    _admin_connections.append(websocket)
    
    try:
        while True:
            data = await websocket.receive_json()
            
            if data.get("type") == "reply":
                # Admin sending a reply
                session_id = data.get("session_id")
                message = data.get("message")
                admin_name = data.get("admin_name", "Support")
                admin_email = data.get("admin_email")
                
                db = get_db()
                
                admin_msg = {
                    "id": str(uuid.uuid4()),
                    "session_id": session_id,
                    "sender": "admin",
                    "sender_name": admin_name,
                    "sender_email": admin_email,
                    "message": message,
                    "timestamp": datetime.now(timezone.utc).isoformat()
                }
                await db.chat_messages.insert_one(admin_msg)
                
                await db.chat_sessions.update_one(
                    {"session_id": session_id},
                    {
                        "$set": {
                            "last_activity": datetime.now(timezone.utc).isoformat(),
                            "assigned_to": admin_email
                        },
                        "$inc": {"message_count": 1}
                    }
                )
                
                # Send to visitor
                await send_to_visitor(session_id, {
                    "type": "message",
                    "message": {k: v for k, v in admin_msg.items() if k not in ["_id", "sender_email"]}
                })

                # 18 Jun 2026 — Mirror the HTTP /reply path: also email the
                # visitor if they're offline + we have their address on file.
                ws_fresh_session = await db.chat_sessions.find_one(
                    {"session_id": session_id}, {"_id": 0}
                )
                if ws_fresh_session:
                    asyncio.create_task(
                        send_admin_reply_to_visitor_email(ws_fresh_session, admin_msg, db)
                    )

                # Notify other admins
                await broadcast_to_admins({
                    "type": "admin_reply",
                    "session_id": session_id,
                    "message": {k: v for k, v in admin_msg.items() if k != "_id"}
                })
            
            elif data.get("type") == "typing":
                # Admin typing indicator
                session_id = data.get("session_id")
                await send_to_visitor(session_id, {
                    "type": "admin_typing"
                })
    
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in _admin_connections:
            _admin_connections.remove(websocket)

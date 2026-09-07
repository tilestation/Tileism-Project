"""
SMS Order Status Updates - Twilio-ready Backend
Sends SMS notifications to customers about order status changes.
Note: Requires Twilio credentials to be configured in environment variables.
"""
import os
import uuid
import logging
from datetime import datetime, timezone
from typing import Optional, List
from fastapi import APIRouter, HTTPException, Query, Depends, Body
from pydantic import BaseModel

from config import get_db
from routes.auth import get_current_user

router = APIRouter(prefix="/sms-updates", tags=["SMS Updates"])

# ============ CONFIGURATION ============

# Check if Twilio is available
try:
    from twilio.rest import Client as TwilioClient
    TWILIO_AVAILABLE = True
except ImportError:
    TWILIO_AVAILABLE = False
    TwilioClient = None

# Load Twilio credentials from environment
TWILIO_ACCOUNT_SID = os.environ.get("TWILIO_ACCOUNT_SID")
TWILIO_AUTH_TOKEN = os.environ.get("TWILIO_AUTH_TOKEN")
TWILIO_PHONE_NUMBER = os.environ.get("TWILIO_PHONE_NUMBER")

# Initialize Twilio client if credentials are available
twilio_client = None
if TWILIO_AVAILABLE and TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN:
    try:
        twilio_client = TwilioClient(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
        logging.info("Twilio client initialized successfully")
    except Exception as e:
        logging.warning(f"Failed to initialize Twilio client: {e}")

# SMS Templates
SMS_TEMPLATES = {
    "order_confirmed": "Tile Station: Your order #{order_no} has been confirmed! Total: £{total}. We'll notify you when it ships. Questions? Call 01234 567890",
    "order_processing": "Tile Station: Good news! Your order #{order_no} is being prepared. We'll notify you when it's ready for delivery/collection.",
    "order_shipped": "Tile Station: Your order #{order_no} is on its way! Expected delivery: {delivery_date}. Track at: {tracking_url}",
    "order_out_for_delivery": "Tile Station: Your order #{order_no} is out for delivery today! Please ensure someone is available to receive it.",
    "order_delivered": "Tile Station: Your order #{order_no} has been delivered! Thank you for shopping with us. Questions? Call 01234 567890",
    "order_ready_collection": "Tile Station: Your order #{order_no} is ready for collection at {showroom}. Please bring ID and order confirmation.",
    "delivery_reminder": "Tile Station Reminder: Your delivery for order #{order_no} is scheduled for tomorrow, {delivery_date}. Any questions? Call 01234 567890",
    "quote_ready": "Tile Station: Your quote #{quote_no} is ready! Total: £{total}. Valid for 30 days. View it at: {quote_url}"
}

# ============ MODELS ============

class SMSRequest(BaseModel):
    phone_number: str  # E.164 format: +447123456789
    template: str  # Template key from SMS_TEMPLATES
    variables: dict  # Variables to substitute in template
    order_id: Optional[str] = None
    customer_id: Optional[str] = None

class BulkSMSRequest(BaseModel):
    recipients: List[dict]  # List of {phone_number, variables}
    template: str

class SMSSettings(BaseModel):
    enabled: bool = True
    auto_send_on_status_change: bool = True
    send_delivery_reminders: bool = True
    reminder_hours_before: int = 24

# ============ HELPER FUNCTIONS ============

def format_phone_number(phone: str) -> str:
    """Format phone number to E.164 format (UK)"""
    if not phone:
        return None
    
    # Remove all non-digit characters
    phone = ''.join(filter(str.isdigit, phone))
    
    # Handle UK numbers
    if phone.startswith('44'):
        return f'+{phone}'
    elif phone.startswith('0'):
        return f'+44{phone[1:]}'
    elif len(phone) == 10 or len(phone) == 11:
        return f'+44{phone}'
    
    return None

def render_template(template_key: str, variables: dict) -> str:
    """Render SMS template with variables"""
    template = SMS_TEMPLATES.get(template_key)
    if not template:
        raise ValueError(f"Unknown template: {template_key}")
    
    try:
        return template.format(**variables)
    except KeyError as e:
        raise ValueError(f"Missing variable in template: {e}")

async def send_sms(phone: str, message: str, db, order_id: str = None) -> dict:
    """Send SMS via Twilio (or simulate if not configured)"""
    formatted_phone = format_phone_number(phone)
    if not formatted_phone:
        return {"success": False, "error": "Invalid phone number format"}
    
    result = {
        "id": str(uuid.uuid4()),
        "phone": formatted_phone,
        "message": message[:160],  # SMS limit
        "sent_at": datetime.now(timezone.utc).isoformat(),
        "order_id": order_id,
        "success": False
    }
    
    if twilio_client and TWILIO_PHONE_NUMBER:
        try:
            sms = twilio_client.messages.create(
                body=message[:160],
                from_=TWILIO_PHONE_NUMBER,
                to=formatted_phone
            )
            result["success"] = True
            result["twilio_sid"] = sms.sid
            result["status"] = sms.status
        except Exception as e:
            result["error"] = str(e)
            logging.error(f"Twilio SMS failed: {e}")
    else:
        # Simulation mode - log and save but don't actually send
        result["success"] = True
        result["status"] = "simulated"
        result["note"] = "Twilio not configured - SMS logged but not sent"
        logging.info(f"[SMS SIMULATION] To: {formatted_phone}, Message: {message[:50]}...")
    
    # Log SMS to database
    await db.sms_logs.insert_one({**result})
    
    return result

# ============ ROUTES ============

@router.get("/status")
async def get_sms_status():
    """Check SMS service status and configuration"""
    return {
        "twilio_available": TWILIO_AVAILABLE,
        "twilio_configured": bool(twilio_client),
        "phone_number_configured": bool(TWILIO_PHONE_NUMBER),
        "ready_to_send": bool(twilio_client and TWILIO_PHONE_NUMBER),
        "templates_available": list(SMS_TEMPLATES.keys()),
        "note": "Configure TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER to enable SMS"
    }


@router.get("/templates")
async def get_sms_templates(current_user: dict = Depends(get_current_user)):
    """Get available SMS templates"""
    return {
        "templates": [
            {"key": k, "template": v, "preview": v[:100] + "..."}
            for k, v in SMS_TEMPLATES.items()
        ]
    }


@router.post("/send")
async def send_sms_notification(
    request: SMSRequest,
    current_user: dict = Depends(get_current_user)
):
    """Send SMS notification to a customer"""
    db = get_db()
    
    try:
        message = render_template(request.template, request.variables)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    
    result = await send_sms(
        phone=request.phone_number,
        message=message,
        db=db,
        order_id=request.order_id
    )
    
    return result


@router.post("/send-order-update")
async def send_order_status_update(
    order_id: str = Body(...),
    status: str = Body(...),
    phone_override: Optional[str] = Body(None),
    current_user: dict = Depends(get_current_user)
):
    """Send SMS update for order status change"""
    db = get_db()
    
    # Get order details
    order = await db.invoices.find_one({"id": order_id}, {"_id": 0})
    if not order:
        order = await db.quotations.find_one({"id": order_id}, {"_id": 0})
    
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    
    phone = phone_override or order.get("customer_phone")
    if not phone:
        raise HTTPException(status_code=400, detail="No phone number for customer")
    
    # Map status to template
    template_map = {
        "confirmed": "order_confirmed",
        "processing": "order_processing",
        "shipped": "order_shipped",
        "out_for_delivery": "order_out_for_delivery",
        "delivered": "order_delivered",
        "ready_for_collection": "order_ready_collection"
    }
    
    template_key = template_map.get(status)
    if not template_key:
        raise HTTPException(status_code=400, detail=f"No template for status: {status}")
    
    # Build variables
    variables = {
        "order_no": order.get("invoice_no") or order.get("quotation_no") or order_id[:8],
        "total": f"{order.get('gross_total', 0):.2f}",
        "showroom": order.get("showroom_name", "our store"),
        "delivery_date": "TBD",
        "tracking_url": f"https://tilestation.co.uk/track?order={order_id[:8]}"
    }
    
    try:
        message = render_template(template_key, variables)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    
    result = await send_sms(
        phone=phone,
        message=message,
        db=db,
        order_id=order_id
    )
    
    return {
        "success": result.get("success"),
        "status": status,
        "template": template_key,
        "message_preview": message[:50] + "...",
        "sms_result": result
    }


@router.post("/bulk-send")
async def send_bulk_sms(
    request: BulkSMSRequest,
    current_user: dict = Depends(get_current_user)
):
    """Send SMS to multiple recipients"""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super Admin only")
    
    db = get_db()
    results = []
    
    for recipient in request.recipients[:100]:  # Limit to 100
        phone = recipient.get("phone_number")
        variables = recipient.get("variables", {})
        
        try:
            message = render_template(request.template, variables)
            result = await send_sms(phone=phone, message=message, db=db)
            results.append(result)
        except Exception as e:
            results.append({
                "phone": phone,
                "success": False,
                "error": str(e)
            })
    
    return {
        "total": len(results),
        "successful": sum(1 for r in results if r.get("success")),
        "failed": sum(1 for r in results if not r.get("success")),
        "results": results
    }


@router.get("/logs")
async def get_sms_logs(
    limit: int = Query(50, le=500),
    order_id: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    """Get SMS sending logs"""
    db = get_db()
    
    query = {}
    if order_id:
        query["order_id"] = order_id
    
    logs = await db.sms_logs.find(query, {"_id": 0}).sort("sent_at", -1).limit(limit).to_list(limit)
    
    return {
        "logs": logs,
        "count": len(logs)
    }


@router.get("/settings")
async def get_sms_settings(current_user: dict = Depends(get_current_user)):
    """Get SMS notification settings"""
    db = get_db()
    
    settings = await db.settings.find_one({"type": "sms_settings"}, {"_id": 0})
    
    if not settings:
        settings = {
            "enabled": True,
            "auto_send_on_status_change": True,
            "send_delivery_reminders": True,
            "reminder_hours_before": 24
        }
    
    return settings


@router.put("/settings")
async def update_sms_settings(
    settings: SMSSettings,
    current_user: dict = Depends(get_current_user)
):
    """Update SMS notification settings"""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super Admin only")
    
    db = get_db()
    
    await db.settings.update_one(
        {"type": "sms_settings"},
        {"$set": {
            **settings.dict(),
            "type": "sms_settings",
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "updated_by": current_user.get("email")
        }},
        upsert=True
    )
    
    return {"message": "SMS settings updated", "settings": settings.dict()}


@router.post("/test")
async def send_test_sms(
    phone_number: str = Body(..., embed=True),
    current_user: dict = Depends(get_current_user)
):
    """Send a test SMS to verify configuration"""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super Admin only")
    
    db = get_db()
    
    test_message = f"Tile Station SMS Test: This is a test message sent by {current_user.get('name', 'Admin')} at {datetime.now().strftime('%H:%M')}. If you received this, SMS is working!"
    
    result = await send_sms(
        phone=phone_number,
        message=test_message,
        db=db
    )
    
    return {
        "test_result": result,
        "configuration": {
            "twilio_configured": bool(twilio_client),
            "phone_number": TWILIO_PHONE_NUMBER[:4] + "***" if TWILIO_PHONE_NUMBER else None
        }
    }

"""
Order Management routes with calendar support
"""
import io
import uuid
import logging
from datetime import datetime, timezone, timedelta
from typing import List, Optional
from fastapi import APIRouter, HTTPException, Depends, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from config import get_db
from models import Order, OrderStatusUpdate
from services import get_current_user, is_admin_user, log_audit

# PDF generation
try:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import mm, inch
    from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, Image
    from reportlab.lib.enums import TA_CENTER, TA_RIGHT, TA_LEFT
    REPORTLAB_AVAILABLE = True
except ImportError:
    REPORTLAB_AVAILABLE = False

router = APIRouter(prefix="/orders", tags=["Order Management"])

# Order statuses with colors
ORDER_STATUSES = {
    "pending": {"label": "Pending", "color": "#fbbf24"},  # yellow
    "confirmed": {"label": "Confirmed", "color": "#3b82f6"},  # blue
    "processing": {"label": "Processing", "color": "#8b5cf6"},  # purple
    "ready": {"label": "Ready for Collection", "color": "#06b6d4"},  # cyan
    "out_for_delivery": {"label": "Out for Delivery", "color": "#f97316"},  # orange
    "completed": {"label": "Completed", "color": "#22c55e"},  # green
    "cancelled": {"label": "Cancelled", "color": "#ef4444"},  # red
}


class OrderCalendarEvent(BaseModel):
    id: str
    title: str
    start: datetime
    end: datetime
    status: str
    status_color: str
    customer_name: str
    customer_phone: str
    total: float
    showroom_id: Optional[str] = None
    showroom_name: Optional[str] = None
    delivery_date: Optional[datetime] = None
    is_overdue: bool = False
    source: str = "order"  # "order" or "invoice"
    order_type: Optional[str] = None  # "Store Order" or "Special Order"
    invoice_no: Optional[str] = None
    delivery_type: Optional[str] = None  # "collection" or "delivery"
    delivery_address: Optional[str] = None


class OrderReschedule(BaseModel):
    delivery_date: datetime
    notes: Optional[str] = None


class OrderUpdate(BaseModel):
    status: Optional[str] = None
    delivery_date: Optional[datetime] = None
    delivery_address: Optional[str] = None
    notes: Optional[str] = None
    showroom_id: Optional[str] = None


@router.get("/statuses")
async def get_order_statuses(current_user: dict = Depends(get_current_user)):
    """Get all available order statuses with colors"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    return ORDER_STATUSES


@router.get("/calendar")
async def get_orders_for_calendar(
    start_date: str = Query(..., description="Start date in ISO format"),
    end_date: str = Query(..., description="End date in ISO format"),
    showroom_id: Optional[str] = None,
    status: Optional[str] = None,
    include_special_orders: bool = True,
    current_user: dict = Depends(get_current_user)
):
    """Get orders and special order invoices formatted for calendar view"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    
    # Parse dates
    try:
        start = datetime.fromisoformat(start_date.replace("Z", "+00:00"))
        end = datetime.fromisoformat(end_date.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format")
    
    # Build query for orders
    query = {}
    
    # Filter by showroom if specified or if user is assigned to one
    if showroom_id:
        query["showroom_id"] = showroom_id
    elif current_user.get("showroom_id") and current_user["role"] not in ["super_admin", "admin"]:
        query["showroom_id"] = current_user["showroom_id"]
    
    if status:
        query["status"] = status
    
    # Get orders in date range (by created_at or delivery_date)
    query["$or"] = [
        {"created_at": {"$gte": start.isoformat(), "$lte": end.isoformat()}},
        {"delivery_date": {"$gte": start.isoformat(), "$lte": end.isoformat()}}
    ]
    
    orders = await db.orders.find(query, {"_id": 0}).to_list(10000)
    
    # Get showroom names
    showrooms = {s["id"]: s["name"] for s in await db.showrooms.find({}, {"_id": 0, "id": 1, "name": 1}).to_list(100)}
    
    # Convert to calendar events
    events = []
    now = datetime.now(timezone.utc)
    
    for order in orders:
        # Use delivery_date if set, otherwise use created_at
        event_date = order.get("delivery_date") or order.get("created_at")
        if isinstance(event_date, str):
            event_date = datetime.fromisoformat(event_date.replace("Z", "+00:00"))
        
        status_info = ORDER_STATUSES.get(order.get("status", "pending"), ORDER_STATUSES["pending"])
        
        # Check if overdue (pending/confirmed orders past delivery date)
        is_overdue = False
        if order.get("delivery_date") and order.get("status") in ["pending", "confirmed", "processing"]:
            delivery = order.get("delivery_date")
            if isinstance(delivery, str):
                delivery = datetime.fromisoformat(delivery.replace("Z", "+00:00"))
            # Ensure delivery is timezone-aware for comparison
            if delivery.tzinfo is None:
                delivery = delivery.replace(tzinfo=timezone.utc)
            if delivery < now:
                is_overdue = True
        
        # Get items summary
        items = order.get("items", [])
        items_count = sum(item.get("quantity", 1) for item in items)
        
        event = OrderCalendarEvent(
            id=order["id"],
            title=f"#{order['id'][:8]} - {order.get('customer_name', 'Unknown')} ({items_count} items)",
            start=event_date,
            end=event_date + timedelta(hours=1),  # 1 hour duration for display
            status=order.get("status", "pending"),
            status_color=status_info["color"],
            customer_name=order.get("customer_name", "Unknown"),
            customer_phone=order.get("customer_phone", ""),
            total=order.get("total", order.get("total_amount", 0)),
            showroom_id=order.get("showroom_id"),
            showroom_name=showrooms.get(order.get("showroom_id"), ""),
            delivery_date=order.get("delivery_date"),
            is_overdue=is_overdue,
            source="order"
        )
        events.append(event.model_dump())
    
    # Also fetch Special Order invoices if requested
    if include_special_orders:
        invoice_query = {
            "order_type": "Special Order",
            "status": {"$in": ["open_order", "deposit_order", "processing"]}
        }
        
        # Apply showroom filter
        if showroom_id:
            invoice_query["showroom_id"] = showroom_id
        elif current_user.get("showroom_id") and current_user["role"] not in ["super_admin", "admin"]:
            invoice_query["showroom_id"] = current_user["showroom_id"]
        
        # Filter by status if applicable
        if status:
            # Map order status to invoice status
            status_mapping = {
                "pending": "open_order",
                "confirmed": "deposit_order",
                "processing": "processing",
                "completed": "completed"
            }
            if status in status_mapping:
                invoice_query["status"] = status_mapping[status]
        
        # Note: We fetch all special orders and filter by date in Python
        # because invoice dates can be in different formats (DD/MM/YYYY or YYYY-MM-DD)
        
        invoices = await db.invoices.find(invoice_query, {"_id": 0}).to_list(10000)
        
        for invoice in invoices:
            # Use delivery_date if set, otherwise use invoice date
            event_date = invoice.get("delivery_date") or invoice.get("date")
            if isinstance(event_date, str):
                try:
                    if "T" in event_date:
                        event_date = datetime.fromisoformat(event_date.replace("Z", "+00:00"))
                    elif "/" in event_date:
                        # Handle DD/MM/YYYY format
                        event_date = datetime.strptime(event_date, "%d/%m/%Y").replace(tzinfo=timezone.utc)
                    else:
                        event_date = datetime.strptime(event_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
                except Exception:
                    event_date = datetime.now(timezone.utc)
            
            # Filter by date range in Python (since date formats vary)
            if event_date < start or event_date > end:
                continue
            
            # Map invoice status to order status
            invoice_status = invoice.get("status", "open_order")
            status_map = {
                "open_order": "pending",
                "deposit_order": "confirmed",
                "processing": "processing",
                "completed": "completed",
                "cancelled": "cancelled"
            }
            mapped_status = status_map.get(invoice_status, "pending")
            status_info = ORDER_STATUSES.get(mapped_status, ORDER_STATUSES["pending"])
            
            # Check if overdue
            is_overdue = False
            if invoice.get("delivery_date") and invoice_status in ["open_order", "deposit_order", "processing"]:
                delivery = invoice.get("delivery_date")
                if isinstance(delivery, str):
                    try:
                        delivery = datetime.fromisoformat(delivery.replace("Z", "+00:00"))
                        if delivery.tzinfo is None:
                            delivery = delivery.replace(tzinfo=timezone.utc)
                        if delivery < now:
                            is_overdue = True
                    except Exception:
                        pass
            
            # Get items summary
            line_items = invoice.get("line_items", [])
            items_count = sum(item.get("quantity", 1) for item in line_items)
            
            # Determine delivery type
            delivery_type = invoice.get("delivery_type", "collection")
            type_label = "🚚" if delivery_type == "delivery" else "📦"
            
            event = OrderCalendarEvent(
                id=invoice["id"],
                title=f"{type_label} {invoice.get('invoice_no', 'INV')} - {invoice.get('customer_name', 'Unknown')} ({items_count} items)",
                start=event_date,
                end=event_date + timedelta(hours=1),
                status=mapped_status,
                status_color=status_info["color"],
                customer_name=invoice.get("customer_name", "Unknown"),
                customer_phone=invoice.get("customer_phone", ""),
                total=invoice.get("gross_total", 0),
                showroom_id=invoice.get("showroom_id"),
                showroom_name=invoice.get("showroom_name") or showrooms.get(invoice.get("showroom_id"), ""),
                delivery_date=invoice.get("delivery_date"),
                is_overdue=is_overdue,
                source="invoice",
                order_type="Special Order",
                invoice_no=invoice.get("invoice_no"),
                delivery_type=delivery_type,
                delivery_address=invoice.get("customer_address")
            )
            events.append(event.model_dump())
    
    return events
    
    return events


@router.get("/summary")
async def get_orders_summary(
    showroom_id: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    """Get today's orders summary and overdue orders count"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    
    # Build base query
    base_query = {}
    if showroom_id:
        base_query["showroom_id"] = showroom_id
    elif current_user.get("showroom_id") and current_user["role"] not in ["super_admin", "admin"]:
        base_query["showroom_id"] = current_user["showroom_id"]
    
    # Today's date range
    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    today_end = today_start + timedelta(days=1)
    
    # Today's orders (by delivery_date or created_at)
    today_query = {
        **base_query,
        "$or": [
            {"delivery_date": {"$gte": today_start.isoformat(), "$lt": today_end.isoformat()}},
            {"created_at": {"$gte": today_start.isoformat(), "$lt": today_end.isoformat()}}
        ]
    }
    todays_orders = await db.orders.find(today_query, {"_id": 0}).to_list(1000)
    
    # Count by status
    status_counts = {}
    for order in todays_orders:
        status = order.get("status", "pending")
        status_counts[status] = status_counts.get(status, 0) + 1
    
    # Overdue orders (past delivery date, not completed/cancelled)
    overdue_query = {
        **base_query,
        "delivery_date": {"$lt": now.isoformat()},
        "status": {"$nin": ["completed", "cancelled"]}
    }
    overdue_count = await db.orders.count_documents(overdue_query)
    
    # This week's orders (Sunday to Saturday)
    days_since_sunday = (today_start.weekday() + 1) % 7
    week_start = today_start - timedelta(days=days_since_sunday)
    week_end = week_start + timedelta(days=7)
    week_query = {
        **base_query,
        "$or": [
            {"delivery_date": {"$gte": week_start.isoformat(), "$lt": week_end.isoformat()}},
            {"created_at": {"$gte": week_start.isoformat(), "$lt": week_end.isoformat()}}
        ]
    }
    weeks_orders_count = await db.orders.count_documents(week_query)
    
    # Total revenue today
    today_revenue = sum(order.get("total", order.get("total_amount", 0)) for order in todays_orders)
    
    return {
        "today": {
            "total": len(todays_orders),
            "by_status": status_counts,
            "revenue": today_revenue
        },
        "this_week": weeks_orders_count,
        "overdue": overdue_count,
        "statuses": ORDER_STATUSES
    }


@router.get("/{order_id}")
async def get_order_details(order_id: str, current_user: dict = Depends(get_current_user)):
    """Get detailed order information"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    order = await db.orders.find_one({"id": order_id}, {"_id": 0})
    
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    
    # Get showroom name
    if order.get("showroom_id"):
        showroom = await db.showrooms.find_one({"id": order["showroom_id"]}, {"_id": 0, "name": 1})
        order["showroom_name"] = showroom["name"] if showroom else None
    
    # Get customer details
    if order.get("customer_email"):
        customer = await db.users.find_one({"email": order["customer_email"]}, {"_id": 0, "name": 1, "phone": 1, "address": 1})
        if customer:
            order["customer_details"] = customer
    
    return order


@router.put("/{order_id}")
async def update_order(
    order_id: str,
    update: OrderUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Update order details (status, delivery date, notes, etc.)"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    
    # Get existing order
    existing = await db.orders.find_one({"id": order_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Order not found")
    
    # Build update data
    update_data = {"updated_at": datetime.now(timezone.utc).isoformat()}
    
    if update.status is not None:
        if update.status not in ORDER_STATUSES:
            raise HTTPException(status_code=400, detail=f"Invalid status. Valid statuses: {list(ORDER_STATUSES.keys())}")
        update_data["status"] = update.status
    
    if update.delivery_date is not None:
        update_data["delivery_date"] = update.delivery_date.isoformat()
    
    if update.delivery_address is not None:
        update_data["delivery_address"] = update.delivery_address
    
    if update.notes is not None:
        update_data["notes"] = update.notes
    
    if update.showroom_id is not None:
        update_data["showroom_id"] = update.showroom_id
        # Get showroom name
        showroom = await db.showrooms.find_one({"id": update.showroom_id}, {"_id": 0, "name": 1})
        update_data["showroom_name"] = showroom["name"] if showroom else None
    
    await db.orders.update_one({"id": order_id}, {"$set": update_data})
    
    # Send customer notifications on status change
    if update.status is not None and update.status != existing.get("status"):
        try:
            from services.email import send_order_status_notification
            tracking_number = existing.get("tracking", {}).get("number") if existing.get("tracking") else None
            tracking_url = existing.get("tracking", {}).get("url") if existing.get("tracking") else None
            await send_order_status_notification(
                order=existing,
                new_status=update.status,
                tracking_number=tracking_number,
                tracking_url=tracking_url,
                notes=update.notes
            )
        except Exception as e:
            logging.warning(f"Failed to send order status email: {e}")
        
        try:
            from services.whatsapp_service import send_whatsapp_template_message
            customer_phone = existing.get("customer_phone") or existing.get("phone")
            if customer_phone:
                phone = customer_phone.strip().replace(" ", "").replace("-", "")
                if not phone.startswith("+"):
                    phone = "+44" + phone.lstrip("0") if phone.startswith("0") else "+" + phone
                
                status_labels = {
                    "confirmed": "confirmed", "processing": "being prepared",
                    "shipped": "shipped", "delivered": "delivered",
                    "ready_for_collection": "ready for collection",
                    "collected": "collected", "cancelled": "cancelled",
                }
                status_text = status_labels.get(update.status, update.status)
                order_num = existing.get("order_number", order_id[:8])
                msg = f"Hi! Your Tile Station order #{order_num} is now {status_text}."
                if tracking_number:
                    msg += f" Tracking: {tracking_number}"
                if tracking_url:
                    msg += f" Track here: {tracking_url}"
                
                wa_result = await send_whatsapp_template_message(
                    recipient_phone=phone, template_name="custom_message",
                    language_code="en", parameters=[msg],
                )
                if wa_result.get("success"):
                    import uuid as _uuid
                    await db.whatsapp_queue.insert_one({
                        "id": str(_uuid.uuid4()),
                        "customer_name": existing.get("customer_name"),
                        "customer_email": existing.get("customer_email"),
                        "phone": phone, "status": "sent",
                        "queued_at": datetime.now(timezone.utc).isoformat(),
                        "sent_at": datetime.now(timezone.utc).isoformat(),
                        "message_id": wa_result.get("message_id"),
                        "is_custom": True, "custom_message": msg,
                        "template_name": "custom_message", "retry_count": 0,
                    })
        except Exception as e:
            logging.warning(f"Failed to send order status WhatsApp: {e}")
    
    # Audit log
    await log_audit(
        action="UPDATE",
        entity_type="order",
        user=current_user,
        entity_id=order_id,
        entity_name=f"Order #{order_id[:8]}",
        before_data={"status": existing.get("status"), "delivery_date": existing.get("delivery_date")},
        after_data=update_data,
        details=f"Order updated: {', '.join(f'{k}={v}' for k, v in update_data.items() if k != 'updated_at')}"
    )
    
    # Return updated order
    order = await db.orders.find_one({"id": order_id}, {"_id": 0})
    return order


@router.post("/{order_id}/reschedule")
async def reschedule_order(
    order_id: str,
    reschedule: OrderReschedule,
    current_user: dict = Depends(get_current_user)
):
    """Reschedule an order to a new delivery date"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    
    # Get existing order
    existing = await db.orders.find_one({"id": order_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Order not found")
    
    old_date = existing.get("delivery_date")
    
    # Update delivery date
    update_data = {
        "delivery_date": reschedule.delivery_date.isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat()
    }
    
    if reschedule.notes:
        # Append to existing notes
        existing_notes = existing.get("notes", "")
        new_note = f"\n[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M')}] Rescheduled: {reschedule.notes}"
        update_data["notes"] = existing_notes + new_note
    
    await db.orders.update_one({"id": order_id}, {"$set": update_data})
    
    # Audit log
    await log_audit(
        action="UPDATE",
        entity_type="order",
        user=current_user,
        entity_id=order_id,
        entity_name=f"Order #{order_id[:8]}",
        before_data={"delivery_date": old_date},
        after_data={"delivery_date": reschedule.delivery_date.isoformat()},
        details=f"Order rescheduled from {old_date} to {reschedule.delivery_date.isoformat()}"
    )
    
    order = await db.orders.find_one({"id": order_id}, {"_id": 0})
    return {"message": "Order rescheduled successfully", "order": order}


@router.get("/overdue/list")
async def get_overdue_orders(
    showroom_id: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    """Get list of overdue orders"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    now = datetime.now(timezone.utc)
    
    query = {
        "delivery_date": {"$lt": now.isoformat()},
        "status": {"$nin": ["completed", "cancelled"]}
    }
    
    if showroom_id:
        query["showroom_id"] = showroom_id
    elif current_user.get("showroom_id") and current_user["role"] not in ["super_admin", "admin"]:
        query["showroom_id"] = current_user["showroom_id"]
    
    orders = await db.orders.find(query, {"_id": 0}).sort("delivery_date", 1).to_list(100)
    
    # Add showroom names and calculate days overdue
    showrooms = {s["id"]: s["name"] for s in await db.showrooms.find({}, {"_id": 0, "id": 1, "name": 1}).to_list(100)}
    
    for order in orders:
        if order.get("showroom_id"):
            order["showroom_name"] = showrooms.get(order["showroom_id"], "")
        
        if order.get("delivery_date"):
            delivery = order["delivery_date"]
            if isinstance(delivery, str):
                delivery = datetime.fromisoformat(delivery.replace("Z", "+00:00"))
            # Ensure delivery is timezone-aware for comparison
            if delivery.tzinfo is None:
                delivery = delivery.replace(tzinfo=timezone.utc)
            order["days_overdue"] = (now - delivery).days
    
    return orders


# ============ PDF GENERATION ENDPOINTS ============

def generate_note_pdf(data: dict, note_type: str = "collection") -> io.BytesIO:
    """Generate Collection Note or Delivery Note PDF"""
    if not REPORTLAB_AVAILABLE:
        raise HTTPException(status_code=500, detail="PDF generation not available")
    
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4, topMargin=20*mm, bottomMargin=20*mm)
    
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(
        name='TitleStyle',
        parent=styles['Heading1'],
        fontSize=24,
        alignment=TA_CENTER,
        spaceAfter=10*mm,
        textColor=colors.HexColor("#1e3a5f")
    ))
    styles.add(ParagraphStyle(
        name='SubtitleStyle',
        parent=styles['Normal'],
        fontSize=14,
        alignment=TA_CENTER,
        spaceAfter=5*mm,
        textColor=colors.HexColor("#666666")
    ))
    styles.add(ParagraphStyle(
        name='SectionHeader',
        parent=styles['Heading2'],
        fontSize=12,
        spaceBefore=5*mm,
        spaceAfter=3*mm,
        textColor=colors.HexColor("#1e3a5f")
    ))
    styles.add(ParagraphStyle(
        name='NoteBodyText',
        parent=styles['Normal'],
        fontSize=10,
        spaceBefore=2*mm
    ))
    
    elements = []
    
    # Header - Title
    title = "COLLECTION NOTE" if note_type == "collection" else "DELIVERY NOTE"
    elements.append(Paragraph(title, styles['TitleStyle']))
    
    # Store info
    showroom_name = data.get("showroom_name", "Tile Station")
    elements.append(Paragraph(showroom_name, styles['SubtitleStyle']))
    elements.append(Spacer(1, 5*mm))
    
    # Reference & Date row
    ref_no = data.get("invoice_no") or data.get("id", "")[:8]
    date_str = data.get("date") or datetime.now().strftime("%d/%m/%Y")
    if isinstance(date_str, str) and "T" in date_str:
        try:
            date_str = datetime.fromisoformat(date_str.replace("Z", "+00:00")).strftime("%d/%m/%Y")
        except Exception:
            pass
    
    ref_data = [
        ["Reference:", ref_no, "Date:", date_str]
    ]
    ref_table = Table(ref_data, colWidths=[60, 150, 60, 150])
    ref_table.setStyle(TableStyle([
        ('FONTNAME', (0, 0), (-1, -1), 'Helvetica-Bold'),
        ('FONTSIZE', (0, 0), (-1, -1), 10),
        ('ALIGN', (0, 0), (0, -1), 'RIGHT'),
        ('ALIGN', (2, 0), (2, -1), 'RIGHT'),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
    ]))
    elements.append(ref_table)
    elements.append(Spacer(1, 8*mm))
    
    # Customer Details Section
    elements.append(Paragraph("CUSTOMER DETAILS", styles['SectionHeader']))
    
    customer_data = [
        ["Name:", data.get("customer_name", "")],
        ["Phone:", data.get("customer_phone", "")],
        ["Email:", data.get("customer_email", "")],
    ]
    
    if note_type == "delivery":
        customer_data.append(["Delivery Address:", data.get("customer_address") or data.get("delivery_address", "")])
    else:
        customer_data.append(["Collection From:", showroom_name])
    
    customer_table = Table(customer_data, colWidths=[100, 360])
    customer_table.setStyle(TableStyle([
        ('FONTNAME', (0, 0), (0, -1), 'Helvetica-Bold'),
        ('FONTSIZE', (0, 0), (-1, -1), 10),
        ('ALIGN', (0, 0), (0, -1), 'RIGHT'),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
    ]))
    elements.append(customer_table)
    elements.append(Spacer(1, 8*mm))
    
    # Collection/Delivery Date & Time
    delivery_date = data.get("delivery_date")
    if delivery_date:
        if isinstance(delivery_date, str):
            try:
                dt = datetime.fromisoformat(delivery_date.replace("Z", "+00:00"))
                delivery_date = dt.strftime("%d/%m/%Y at %H:%M")
            except Exception:
                pass
        date_label = "Collection Date:" if note_type == "collection" else "Delivery Date:"
        elements.append(Paragraph(f"<b>{date_label}</b> {delivery_date}", styles['NoteBodyText']))
        elements.append(Spacer(1, 5*mm))
    
    # Items Section
    elements.append(Paragraph("ITEMS", styles['SectionHeader']))
    
    # Get items from either order items or invoice line_items
    items = data.get("items") or data.get("line_items", [])
    
    items_header = ["#", "Description", "SKU", "Qty", "m²"]
    items_data = [items_header]
    
    total_qty = 0
    total_m2 = 0
    
    # Style for product names to allow wrapping
    product_name_style = ParagraphStyle('ProductNameCell', fontSize=9, leading=11)
    
    for idx, item in enumerate(items, 1):
        qty = item.get("quantity", 1)
        m2 = item.get("m2", 0)
        total_qty += qty
        total_m2 += m2
        
        # Wrap product name in Paragraph for proper text wrapping
        product_name = item.get("product_name", "")
        product_para = Paragraph(product_name, product_name_style)
        
        items_data.append([
            str(idx),
            product_para,
            item.get("sku", "-"),
            str(qty),
            f"{m2:.2f}" if m2 else "-"
        ])
    
    # Add totals row
    items_data.append(["", "", "TOTAL:", str(total_qty), f"{total_m2:.2f}" if total_m2 else "-"])
    
    items_table = Table(items_data, colWidths=[25, 260, 75, 45, 55])
    items_table.setStyle(TableStyle([
        # Header row
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor("#1e3a5f")),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTSIZE', (0, 0), (-1, 0), 10),
        ('ALIGN', (0, 0), (-1, 0), 'CENTER'),
        # Body rows
        ('FONTNAME', (0, 1), (-1, -2), 'Helvetica'),
        ('FONTSIZE', (0, 1), (-1, -1), 9),
        ('ALIGN', (0, 1), (0, -1), 'CENTER'),
        ('ALIGN', (3, 1), (-1, -1), 'CENTER'),
        # Total row
        ('FONTNAME', (0, -1), (-1, -1), 'Helvetica-Bold'),
        ('LINEABOVE', (2, -1), (-1, -1), 1, colors.black),
        # Grid
        ('GRID', (0, 0), (-1, -2), 0.5, colors.grey),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
        ('TOPPADDING', (0, 0), (-1, -1), 5),
    ]))
    elements.append(items_table)
    elements.append(Spacer(1, 10*mm))
    
    # Notes Section
    notes = data.get("notes", "")
    if notes:
        elements.append(Paragraph("NOTES", styles['SectionHeader']))
        elements.append(Paragraph(notes, styles['NoteBodyText']))
        elements.append(Spacer(1, 8*mm))
    
    # Delivery Instructions (for delivery notes)
    if note_type == "delivery":
        elements.append(Paragraph("DELIVERY INSTRUCTIONS", styles['SectionHeader']))
        instructions = data.get("delivery_instructions", "Handle with care. Please inspect items before signing.")
        elements.append(Paragraph(instructions, styles['NoteBodyText']))
        elements.append(Spacer(1, 8*mm))
    
    # Signature Section
    elements.append(Spacer(1, 10*mm))
    elements.append(Paragraph("CONFIRMATION", styles['SectionHeader']))
    
    sig_label = "Customer Signature" if note_type == "collection" else "Received By"
    
    sig_data = [
        [sig_label + ":", "_" * 40, "Date:", "_" * 20],
        ["", "", "", ""],
        ["Print Name:", "_" * 40, "Time:", "_" * 20],
    ]
    
    if note_type == "delivery":
        sig_data.append(["", "", "", ""])
        sig_data.append(["Driver Signature:", "_" * 40, "Driver Name:", "_" * 20])
    
    sig_table = Table(sig_data, colWidths=[100, 180, 60, 120])
    sig_table.setStyle(TableStyle([
        ('FONTNAME', (0, 0), (-1, -1), 'Helvetica'),
        ('FONTSIZE', (0, 0), (-1, -1), 9),
        ('ALIGN', (0, 0), (0, -1), 'RIGHT'),
        ('ALIGN', (2, 0), (2, -1), 'RIGHT'),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
    ]))
    elements.append(sig_table)
    
    # Footer
    elements.append(Spacer(1, 15*mm))
    elements.append(Paragraph(
        "<i>Please retain this note for your records. For queries, contact us at the showroom.</i>",
        ParagraphStyle('Footer', parent=styles['Normal'], fontSize=8, alignment=TA_CENTER, textColor=colors.grey)
    ))
    
    doc.build(elements)
    buffer.seek(0)
    return buffer


@router.get("/{order_id}/collection-note")
async def generate_collection_note(order_id: str, current_user: dict = Depends(get_current_user)):
    """Generate Collection Note PDF for an order or invoice"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    
    # Try to find as order first
    data = await db.orders.find_one({"id": order_id}, {"_id": 0})
    source = "order"
    
    # If not found, try as invoice
    if not data:
        data = await db.invoices.find_one({"id": order_id}, {"_id": 0})
        source = "invoice"
    
    if not data:
        raise HTTPException(status_code=404, detail="Order/Invoice not found")
    
    # Generate PDF
    pdf_buffer = generate_note_pdf(data, "collection")
    
    ref = data.get("invoice_no") or order_id[:8]
    filename = f"collection_note_{ref}_{datetime.now().strftime('%Y%m%d')}.pdf"
    
    return StreamingResponse(
        pdf_buffer,
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )


@router.get("/{order_id}/delivery-note")
async def generate_delivery_note(order_id: str, current_user: dict = Depends(get_current_user)):
    """Generate Delivery Note PDF for an order or invoice"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    
    # Try to find as order first
    data = await db.orders.find_one({"id": order_id}, {"_id": 0})
    source = "order"
    
    # If not found, try as invoice
    if not data:
        data = await db.invoices.find_one({"id": order_id}, {"_id": 0})
        source = "invoice"
    
    if not data:
        raise HTTPException(status_code=404, detail="Order/Invoice not found")
    
    # Generate PDF
    pdf_buffer = generate_note_pdf(data, "delivery")
    
    ref = data.get("invoice_no") or order_id[:8]
    filename = f"delivery_note_{ref}_{datetime.now().strftime('%Y%m%d')}.pdf"
    
    return StreamingResponse(
        pdf_buffer,
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )


# Endpoint to update invoice with delivery details
class InvoiceDeliveryUpdate(BaseModel):
    delivery_type: str  # "collection" or "delivery"
    delivery_date: Optional[datetime] = None
    delivery_address: Optional[str] = None
    delivery_instructions: Optional[str] = None


@router.put("/invoice/{invoice_id}/delivery")
async def update_invoice_delivery(
    invoice_id: str,
    update: InvoiceDeliveryUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Update invoice with delivery/collection details"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    
    invoice = await db.invoices.find_one({"id": invoice_id}, {"_id": 0})
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
    
    update_data = {
        "delivery_type": update.delivery_type,
        "updated_at": datetime.now(timezone.utc).isoformat()
    }
    
    if update.delivery_date:
        update_data["delivery_date"] = update.delivery_date.isoformat()
    if update.delivery_address:
        update_data["delivery_address"] = update.delivery_address
    if update.delivery_instructions:
        update_data["delivery_instructions"] = update.delivery_instructions
    
    await db.invoices.update_one({"id": invoice_id}, {"$set": update_data})
    
    # Audit log
    await log_audit(
        action="UPDATE",
        entity_type="invoice_delivery",
        user=current_user,
        entity_id=invoice_id,
        entity_name=f"Invoice {invoice.get('invoice_no')}",
        after_data=update_data,
        details=f"Delivery details updated: {update.delivery_type}"
    )
    
    return {"message": "Delivery details updated", "delivery_type": update.delivery_type}


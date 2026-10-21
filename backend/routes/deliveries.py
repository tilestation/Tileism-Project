"""
Delivery Management routes with map support
"""
import uuid
import math
from datetime import datetime, timezone, timedelta
from typing import List, Optional
from fastapi import APIRouter, HTTPException, Depends, Query
from pydantic import BaseModel

from config import get_db
from services import get_current_user, is_admin_user, log_audit

router = APIRouter(prefix="/deliveries", tags=["Delivery Management"])

# Delivery statuses
DELIVERY_STATUSES = {
    "pending": {"label": "Pending", "color": "#fbbf24"},
    "assigned": {"label": "Assigned", "color": "#3b82f6"},
    "in_transit": {"label": "In Transit", "color": "#8b5cf6"},
    "arrived": {"label": "Arrived", "color": "#06b6d4"},
    "delivered": {"label": "Delivered", "color": "#22c55e"},
    "failed": {"label": "Failed", "color": "#ef4444"},
    "rescheduled": {"label": "Rescheduled", "color": "#f97316"},
}

# Time slots
TIME_SLOTS = [
    {"id": "morning", "label": "Morning (8AM - 12PM)", "start": "08:00", "end": "12:00"},
    {"id": "afternoon", "label": "Afternoon (12PM - 4PM)", "start": "12:00", "end": "16:00"},
    {"id": "evening", "label": "Evening (4PM - 8PM)", "start": "16:00", "end": "20:00"},
]


class DeliveryCreate(BaseModel):
    order_id: Optional[str] = None
    invoice_id: Optional[str] = None
    customer_name: str
    customer_phone: str
    customer_email: Optional[str] = None
    delivery_address: str
    delivery_lat: Optional[float] = None
    delivery_lng: Optional[float] = None
    delivery_date: str
    time_slot: Optional[str] = "morning"
    showroom_id: str
    driver_id: Optional[str] = None
    notes: Optional[str] = None
    items_summary: Optional[str] = None


class DeliveryUpdate(BaseModel):
    status: Optional[str] = None
    driver_id: Optional[str] = None
    delivery_date: Optional[str] = None
    time_slot: Optional[str] = None
    notes: Optional[str] = None
    delivery_lat: Optional[float] = None
    delivery_lng: Optional[float] = None
    actual_delivery_time: Optional[str] = None
    signature_name: Optional[str] = None
    delivery_notes: Optional[str] = None


class DriverCreate(BaseModel):
    name: str
    phone: str
    email: Optional[str] = None
    vehicle_reg: Optional[str] = None
    showroom_id: Optional[str] = None


class DriverUpdate(BaseModel):
    name: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    vehicle_reg: Optional[str] = None
    showroom_id: Optional[str] = None
    active: Optional[bool] = None


# ============ DELIVERY ENDPOINTS ============

# ============ STOCK CHECK-IN ENDPOINTS ============

class StockCheckInItem(BaseModel):
    product_id: str
    quantity: int

class StockCheckInRequest(BaseModel):
    showroom_id: str
    items: List[StockCheckInItem]
    supplier_reference: Optional[str] = ""
    notes: Optional[str] = ""
    checked_in_by: Optional[str] = ""

@router.post("/check-in")
async def check_in_stock_delivery(
    request: StockCheckInRequest,
    current_user: dict = Depends(get_current_user)
):
    """Check in a stock delivery and update inventory for the specified showroom"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    
    # Validate showroom exists
    showroom = await db.showrooms.find_one({"id": request.showroom_id})
    if not showroom:
        raise HTTPException(status_code=404, detail="Showroom not found")
    
    # Process each item
    processed_items = []
    total_items = 0
    
    for item in request.items:
        # Get product
        product = await db.products.find_one({"id": item.product_id})
        if not product:
            continue
        
        # Update product stock
        current_stock = product.get("stock", 0)
        new_stock = current_stock + item.quantity
        
        # Update showroom_stock
        showroom_stock = product.get("showroom_stock", {})
        current_showroom_qty = showroom_stock.get(request.showroom_id, 0)
        showroom_stock[request.showroom_id] = current_showroom_qty + item.quantity
        
        # Update product in database
        await db.products.update_one(
            {"id": item.product_id},
            {"$set": {
                "stock": new_stock,
                "showroom_stock": showroom_stock,
                "updated_at": datetime.now(timezone.utc).isoformat()
            }}
        )
        
        processed_items.append({
            "product_id": item.product_id,
            "product_name": product.get("name"),
            "sku": product.get("sku"),
            "quantity": item.quantity,
            "previous_stock": current_stock,
            "new_stock": new_stock,
            "previous_showroom_stock": current_showroom_qty,
            "new_showroom_stock": current_showroom_qty + item.quantity
        })
        
        total_items += item.quantity
    
    # Create stock receipt record
    receipt_id = str(uuid.uuid4())
    receipt_record = {
        "id": receipt_id,
        "type": "stock_check_in",
        "showroom_id": request.showroom_id,
        "showroom_name": showroom.get("name"),
        "items": processed_items,
        "total_items": total_items,
        "supplier_reference": request.supplier_reference,
        "notes": request.notes,
        "checked_in_by": request.checked_in_by or current_user.get("name") or current_user.get("email"),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "created_by_user_id": current_user.get("id")
    }
    
    await db.stock_receipts.insert_one(receipt_record)
    
    # Log audit trail
    await log_audit(
        action="CREATE",
        entity_type="stock_receipt",
        user=current_user,
        entity_id=receipt_id,
        entity_name=f"Stock Check-In at {showroom.get('name')}",
        after_data={
            "showroom": showroom.get("name"),
            "total_items": total_items,
            "products_count": len(processed_items),
            "supplier_reference": request.supplier_reference
        },
        details=f"Stock check-in: {total_items} items across {len(processed_items)} products"
    )
    
    return {
        "id": receipt_id,
        "showroom_id": request.showroom_id,
        "showroom_name": showroom.get("name"),
        "items": processed_items,
        "total_items": total_items,
        "supplier_reference": request.supplier_reference,
        "notes": request.notes,
        "checked_in_by": receipt_record["checked_in_by"],
        "created_at": receipt_record["created_at"]
    }

@router.get("/recent")
async def get_recent_stock_receipts(
    limit: int = 20,
    showroom_id: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    """Get recent stock check-in receipts"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    
    query = {"type": "stock_check_in"}
    if showroom_id:
        query["showroom_id"] = showroom_id
    
    cursor = db.stock_receipts.find(query, {"_id": 0}).sort("created_at", -1).limit(limit)
    receipts = await cursor.to_list(length=limit)
    
    return receipts

# ============ DELIVERY STATUS ENDPOINTS ============

@router.get("/statuses")
async def get_delivery_statuses(current_user: dict = Depends(get_current_user)):
    """Get all delivery statuses"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    return DELIVERY_STATUSES


@router.get("/time-slots")
async def get_time_slots(current_user: dict = Depends(get_current_user)):
    """Get available time slots"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    return TIME_SLOTS


@router.get("")
async def get_deliveries(
    date: Optional[str] = None,
    status: Optional[str] = None,
    showroom_id: Optional[str] = None,
    driver_id: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    """Get deliveries with optional filters"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    query = {}
    
    if date:
        query["delivery_date"] = date
    
    if status:
        query["status"] = status
    
    if showroom_id:
        query["showroom_id"] = showroom_id
    elif current_user.get("showroom_id") and current_user["role"] not in ["super_admin", "admin"]:
        query["showroom_id"] = current_user["showroom_id"]
    
    if driver_id:
        query["driver_id"] = driver_id
    
    deliveries = await db.deliveries.find(query, {"_id": 0}).sort("delivery_date", 1).to_list(10000)
    
    # Get showroom and driver names — guard against legacy docs missing `id`
    showrooms = {s["id"]: s for s in await db.showrooms.find({}, {"_id": 0}).to_list(100) if s.get("id")}
    drivers = {d["id"]: d for d in await db.drivers.find({}, {"_id": 0}).to_list(100) if d.get("id")}
    
    for delivery in deliveries:
        if delivery.get("showroom_id"):
            showroom = showrooms.get(delivery["showroom_id"], {})
            delivery["showroom_name"] = showroom.get("name", "")
            delivery["showroom_address"] = showroom.get("address", "")
            delivery["showroom_lat"] = showroom.get("lat")
            delivery["showroom_lng"] = showroom.get("lng")
        if delivery.get("driver_id"):
            driver = drivers.get(delivery["driver_id"], {})
            delivery["driver_name"] = driver.get("name", "")
            delivery["driver_phone"] = driver.get("phone", "")
    
    return deliveries


@router.get("/today")
async def get_todays_deliveries(
    showroom_id: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    """Get today's deliveries"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return await get_deliveries(date=today, showroom_id=showroom_id, current_user=current_user)


@router.get("/summary")
async def get_delivery_summary(
    date: Optional[str] = None,
    showroom_id: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    """Get delivery summary statistics"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    today = date or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    
    query = {"delivery_date": today}
    if showroom_id:
        query["showroom_id"] = showroom_id
    elif current_user.get("showroom_id") and current_user["role"] not in ["super_admin", "admin"]:
        query["showroom_id"] = current_user["showroom_id"]
    
    deliveries = await db.deliveries.find(query, {"_id": 0}).to_list(10000)
    
    # Count by status
    status_counts = {}
    for d in deliveries:
        status = d.get("status", "pending")
        status_counts[status] = status_counts.get(status, 0) + 1
    
    # Count by time slot
    slot_counts = {}
    for d in deliveries:
        slot = d.get("time_slot", "morning")
        slot_counts[slot] = slot_counts.get(slot, 0) + 1
    
    # Count by driver
    driver_counts = {}
    unassigned = 0
    for d in deliveries:
        driver_id = d.get("driver_id")
        if driver_id:
            driver_counts[driver_id] = driver_counts.get(driver_id, 0) + 1
        else:
            unassigned += 1
    
    return {
        "date": today,
        "total": len(deliveries),
        "by_status": status_counts,
        "by_time_slot": slot_counts,
        "by_driver": driver_counts,
        "unassigned": unassigned,
        "completed": status_counts.get("delivered", 0),
        "pending": status_counts.get("pending", 0) + status_counts.get("assigned", 0),
        "in_progress": status_counts.get("in_transit", 0) + status_counts.get("arrived", 0),
    }


@router.post("")
async def create_delivery(
    delivery: DeliveryCreate,
    current_user: dict = Depends(get_current_user)
):
    """Create a new delivery"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    
    # Get showroom details
    showroom = await db.showrooms.find_one({"id": delivery.showroom_id}, {"_id": 0})
    if not showroom:
        raise HTTPException(status_code=404, detail="Store not found")
    
    delivery_id = str(uuid.uuid4())
    delivery_dict = {
        "id": delivery_id,
        "order_id": delivery.order_id,
        "invoice_id": delivery.invoice_id,
        "customer_name": delivery.customer_name,
        "customer_phone": delivery.customer_phone,
        "customer_email": delivery.customer_email,
        "delivery_address": delivery.delivery_address,
        "delivery_lat": delivery.delivery_lat,
        "delivery_lng": delivery.delivery_lng,
        "delivery_date": delivery.delivery_date,
        "time_slot": delivery.time_slot,
        "showroom_id": delivery.showroom_id,
        "showroom_name": showroom.get("name"),
        "driver_id": delivery.driver_id,
        "notes": delivery.notes,
        "items_summary": delivery.items_summary,
        "status": "assigned" if delivery.driver_id else "pending",
        "created_by": current_user["email"],
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    
    await db.deliveries.insert_one(delivery_dict)
    
    # Audit log
    await log_audit(
        action="CREATE",
        entity_type="delivery",
        user=current_user,
        entity_id=delivery_id,
        entity_name=f"Delivery to {delivery.customer_name}",
        after_data={"customer": delivery.customer_name, "address": delivery.delivery_address, "date": delivery.delivery_date},
        details=f"Delivery created for {delivery.customer_name}"
    )
    
    result = await db.deliveries.find_one({"id": delivery_id}, {"_id": 0})
    return result


# ============ MAP DATA (must be before /{delivery_id} to avoid route conflict) ============

@router.get("/map-data")
async def get_map_data(
    date: Optional[str] = None,
    showroom_id: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    """Get all data needed for map display"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    today = date or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    
    # Get showrooms with coordinates (exclude closed/inactive showrooms from the map)
    showrooms = await db.showrooms.find({"is_active": {"$ne": False}}, {"_id": 0}).to_list(100)
    
    # Get deliveries
    query = {"delivery_date": today}
    if showroom_id:
        query["showroom_id"] = showroom_id
    elif current_user.get("showroom_id") and current_user["role"] not in ["super_admin", "admin"]:
        query["showroom_id"] = current_user["showroom_id"]
    
    deliveries = await db.deliveries.find(query, {"_id": 0}).to_list(1000)
    
    # Get drivers
    drivers = await db.drivers.find({"active": True}, {"_id": 0}).to_list(100)
    
    return {
        "date": today,
        "showrooms": showrooms,
        "deliveries": deliveries,
        "drivers": drivers,
        "statuses": DELIVERY_STATUSES,
        "time_slots": TIME_SLOTS
    }


@router.get("/{delivery_id}")
async def get_delivery(delivery_id: str, current_user: dict = Depends(get_current_user)):
    """Get delivery details"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    delivery = await db.deliveries.find_one({"id": delivery_id}, {"_id": 0})
    if not delivery:
        raise HTTPException(status_code=404, detail="Delivery not found")
    
    # Get related order/invoice details
    if delivery.get("order_id"):
        order = await db.orders.find_one({"id": delivery["order_id"]}, {"_id": 0})
        if order:
            delivery["order_details"] = order
    
    if delivery.get("invoice_id"):
        invoice = await db.invoices.find_one({"id": delivery["invoice_id"]}, {"_id": 0})
        if invoice:
            delivery["invoice_details"] = invoice
    
    # Get driver details
    if delivery.get("driver_id"):
        driver = await db.drivers.find_one({"id": delivery["driver_id"]}, {"_id": 0})
        if driver:
            delivery["driver_details"] = driver
    
    return delivery


@router.put("/{delivery_id}")
async def update_delivery(
    delivery_id: str,
    update: DeliveryUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Update delivery details"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    
    existing = await db.deliveries.find_one({"id": delivery_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Delivery not found")
    
    update_data = {"updated_at": datetime.now(timezone.utc).isoformat()}
    
    if update.status is not None:
        if update.status not in DELIVERY_STATUSES:
            raise HTTPException(status_code=400, detail=f"Invalid status. Valid: {list(DELIVERY_STATUSES.keys())}")
        update_data["status"] = update.status
        
        # Set actual delivery time if delivered
        if update.status == "delivered" and not existing.get("actual_delivery_time"):
            update_data["actual_delivery_time"] = datetime.now(timezone.utc).isoformat()
    
    if update.driver_id is not None:
        update_data["driver_id"] = update.driver_id
        if update.driver_id and existing.get("status") == "pending":
            update_data["status"] = "assigned"
    
    if update.delivery_date is not None:
        update_data["delivery_date"] = update.delivery_date
    
    if update.time_slot is not None:
        update_data["time_slot"] = update.time_slot
    
    if update.notes is not None:
        update_data["notes"] = update.notes
    
    if update.delivery_lat is not None:
        update_data["delivery_lat"] = update.delivery_lat
    
    if update.delivery_lng is not None:
        update_data["delivery_lng"] = update.delivery_lng
    
    if update.actual_delivery_time is not None:
        update_data["actual_delivery_time"] = update.actual_delivery_time
    
    if update.signature_name is not None:
        update_data["signature_name"] = update.signature_name
    
    if update.delivery_notes is not None:
        update_data["delivery_notes"] = update.delivery_notes
    
    await db.deliveries.update_one({"id": delivery_id}, {"$set": update_data})
    
    # Audit log
    await log_audit(
        action="UPDATE",
        entity_type="delivery",
        user=current_user,
        entity_id=delivery_id,
        entity_name=f"Delivery {delivery_id[:8]}",
        before_data={"status": existing.get("status"), "driver_id": existing.get("driver_id")},
        after_data=update_data,
        details=f"Delivery updated: {', '.join(f'{k}={v}' for k, v in update_data.items() if k != 'updated_at')}"
    )
    
    result = await db.deliveries.find_one({"id": delivery_id}, {"_id": 0})
    return result


@router.delete("/{delivery_id}")
async def delete_delivery(delivery_id: str, current_user: dict = Depends(get_current_user)):
    """Delete a delivery"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    result = await db.deliveries.delete_one({"id": delivery_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Delivery not found")
    
    return {"message": "Delivery deleted"}


# ============ DRIVER ENDPOINTS ============

@router.get("/drivers/list")
async def get_drivers(
    showroom_id: Optional[str] = None,
    active_only: bool = True,
    current_user: dict = Depends(get_current_user)
):
    """Get all drivers"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    query = {}
    
    if active_only:
        query["active"] = True
    
    if showroom_id:
        query["$or"] = [{"showroom_id": showroom_id}, {"showroom_id": None}]
    
    drivers = await db.drivers.find(query, {"_id": 0}).sort("name", 1).to_list(1000)
    
    # Get today's delivery count for each driver
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    for driver in drivers:
        count = await db.deliveries.count_documents({
            "driver_id": driver["id"],
            "delivery_date": today
        })
        driver["todays_deliveries"] = count
    
    return drivers


@router.post("/drivers")
async def create_driver(driver: DriverCreate, current_user: dict = Depends(get_current_user)):
    """Create a new driver"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    
    driver_id = str(uuid.uuid4())
    driver_dict = {
        "id": driver_id,
        "name": driver.name,
        "phone": driver.phone,
        "email": driver.email,
        "vehicle_reg": driver.vehicle_reg,
        "showroom_id": driver.showroom_id,
        "active": True,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    
    await db.drivers.insert_one(driver_dict)
    
    result = await db.drivers.find_one({"id": driver_id}, {"_id": 0})
    return result


@router.put("/drivers/{driver_id}")
async def update_driver(
    driver_id: str,
    update: DriverUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Update driver details"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    
    existing = await db.drivers.find_one({"id": driver_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Driver not found")
    
    update_data = {}
    if update.name is not None:
        update_data["name"] = update.name
    if update.phone is not None:
        update_data["phone"] = update.phone
    if update.email is not None:
        update_data["email"] = update.email
    if update.vehicle_reg is not None:
        update_data["vehicle_reg"] = update.vehicle_reg
    if update.showroom_id is not None:
        update_data["showroom_id"] = update.showroom_id
    if update.active is not None:
        update_data["active"] = update.active
    
    if update_data:
        await db.drivers.update_one({"id": driver_id}, {"$set": update_data})
    
    result = await db.drivers.find_one({"id": driver_id}, {"_id": 0})
    return result


@router.delete("/drivers/{driver_id}")
async def delete_driver(driver_id: str, current_user: dict = Depends(get_current_user)):
    """Delete a driver"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    result = await db.drivers.delete_one({"id": driver_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Driver not found")
    
    return {"message": "Driver deleted"}


# ============ ROUTE OPTIMIZATION ============

def haversine_distance(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Calculate distance between two points in km"""
    R = 6371  # Earth's radius in km
    
    lat1_rad = math.radians(lat1)
    lat2_rad = math.radians(lat2)
    delta_lat = math.radians(lat2 - lat1)
    delta_lng = math.radians(lng2 - lng1)
    
    a = math.sin(delta_lat/2)**2 + math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(delta_lng/2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))
    
    return R * c


def optimize_route(start_lat: float, start_lng: float, deliveries: list) -> list:
    """Simple nearest neighbor route optimization"""
    if not deliveries:
        return []
    
    # Filter deliveries with coordinates
    valid_deliveries = [d for d in deliveries if d.get("delivery_lat") and d.get("delivery_lng")]
    if not valid_deliveries:
        return deliveries  # Return original order if no coordinates
    
    optimized = []
    remaining = valid_deliveries.copy()
    current_lat, current_lng = start_lat, start_lng
    
    while remaining:
        # Find nearest delivery
        nearest = min(remaining, key=lambda d: haversine_distance(
            current_lat, current_lng, d["delivery_lat"], d["delivery_lng"]
        ))
        
        # Calculate distance and add to route
        distance = haversine_distance(current_lat, current_lng, nearest["delivery_lat"], nearest["delivery_lng"])
        nearest["distance_from_prev"] = round(distance, 2)
        
        optimized.append(nearest)
        remaining.remove(nearest)
        current_lat, current_lng = nearest["delivery_lat"], nearest["delivery_lng"]
    
    # Add sequence numbers
    for i, d in enumerate(optimized, 1):
        d["route_sequence"] = i
    
    # Calculate total distance
    total_distance = sum(d.get("distance_from_prev", 0) for d in optimized)
    
    return optimized


@router.post("/optimize-route")
async def optimize_delivery_route(
    date: str,
    showroom_id: str,
    driver_id: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    """Optimize delivery route for a given date and showroom"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    
    # Get showroom coordinates
    showroom = await db.showrooms.find_one({"id": showroom_id}, {"_id": 0})
    if not showroom:
        raise HTTPException(status_code=404, detail="Store not found")
    
    # Default showroom coordinates (can be updated in showroom settings)
    start_lat = showroom.get("lat", 51.5074)  # Default to London
    start_lng = showroom.get("lng", -0.1278)
    
    # Get deliveries for the date
    query = {
        "delivery_date": date,
        "showroom_id": showroom_id,
        "status": {"$nin": ["delivered", "failed", "rescheduled"]}
    }
    
    if driver_id:
        query["driver_id"] = driver_id
    
    deliveries = await db.deliveries.find(query, {"_id": 0}).to_list(100)
    
    if not deliveries:
        return {"optimized_route": [], "total_distance": 0, "message": "No deliveries found"}
    
    # Optimize route
    optimized = optimize_route(start_lat, start_lng, deliveries)
    total_distance = sum(d.get("distance_from_prev", 0) for d in optimized)
    
    return {
        "optimized_route": optimized,
        "total_distance": round(total_distance, 2),
        "start_location": {"lat": start_lat, "lng": start_lng, "name": showroom.get("name")},
        "delivery_count": len(optimized)
    }


# ============ CREATE DELIVERY FROM INVOICE ============

@router.post("/from-invoice/{invoice_id}")
async def create_delivery_from_invoice(
    invoice_id: str,
    delivery_date: str,
    time_slot: str = "morning",
    driver_id: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    """Create a delivery from an existing invoice"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    
    # Get invoice
    invoice = await db.invoices.find_one({"id": invoice_id}, {"_id": 0})
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
    
    # Check if delivery already exists
    existing = await db.deliveries.find_one({"invoice_id": invoice_id})
    if existing:
        raise HTTPException(status_code=400, detail="Delivery already exists for this invoice")
    
    # Get items summary
    items = invoice.get("line_items", [])
    items_summary = ", ".join([f"{i.get('product_name', 'Item')} x{i.get('quantity', 1)}" for i in items[:3]])
    if len(items) > 3:
        items_summary += f" +{len(items) - 3} more"
    
    # Create delivery
    delivery = DeliveryCreate(
        invoice_id=invoice_id,
        customer_name=invoice.get("customer_name", ""),
        customer_phone=invoice.get("customer_phone", ""),
        customer_email=invoice.get("customer_email"),
        delivery_address=invoice.get("customer_address") or invoice.get("delivery_address", ""),
        delivery_date=delivery_date,
        time_slot=time_slot,
        showroom_id=invoice.get("showroom_id", ""),
        driver_id=driver_id,
        notes=invoice.get("notes", ""),
        items_summary=items_summary,
    )
    
    return await create_delivery(delivery, current_user)

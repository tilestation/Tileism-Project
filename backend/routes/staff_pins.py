"""
Staff PIN management routes
"""
import uuid
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Depends

from config import get_db
from models import StaffPinCreate, StaffPinUpdate, StaffPinVerify
from services import get_current_user, is_admin_user, log_audit

router = APIRouter(prefix="/staff-pins", tags=["Staff PINs"])


@router.post("")
async def create_staff_pin(input: StaffPinCreate, current_user: dict = Depends(get_current_user)):
    """Create a new staff PIN (admin only)"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    
    # Validate PIN format (4-6 digits)
    if not input.pin.isdigit() or len(input.pin) < 4 or len(input.pin) > 6:
        raise HTTPException(status_code=400, detail="PIN must be 4-6 digits")
    
    # Check if PIN already exists
    existing = await db.staff_pins.find_one({"pin": input.pin})
    if existing:
        raise HTTPException(status_code=400, detail="This PIN is already in use")
    
    # Get showroom name if showroom_id provided
    showroom_name = None
    if input.showroom_id:
        showroom = await db.showrooms.find_one({"id": input.showroom_id}, {"_id": 0})
        if showroom:
            showroom_name = showroom["name"]
    
    staff_id = str(uuid.uuid4())
    staff_pin = {
        "id": staff_id,
        "name": input.name,
        "pin": input.pin,
        "role": input.role,
        "active": input.active,
        "showroom_id": input.showroom_id,
        "showroom_name": showroom_name,
        # 22 Jul 2026 — Warehouse edit authorization now lives on the PIN.
        # Default False so freshly-created PINs cannot accidentally adjust
        # stock — super_admin must explicitly tick the toggle.
        "can_manage_warehouse": bool(input.can_manage_warehouse),
        "created_by": current_user["email"],
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat()
    }
    
    await db.staff_pins.insert_one(staff_pin)
    
    # Audit log
    await log_audit(
        action="CREATE",
        entity_type="staff_pin",
        user=current_user,
        entity_id=staff_id,
        entity_name=input.name,
        after_data={"name": input.name, "role": input.role, "store": showroom_name, "can_manage_warehouse": staff_pin["can_manage_warehouse"]},
        details=f"Staff PIN created: {input.name}"
    )
    
    # Return without pin for security
    return {
        "id": staff_pin["id"],
        "name": staff_pin["name"],
        "role": staff_pin["role"],
        "active": staff_pin["active"],
        "showroom_id": staff_pin["showroom_id"],
        "showroom_name": staff_pin["showroom_name"],
        "can_manage_warehouse": staff_pin["can_manage_warehouse"],
        "created_at": staff_pin["created_at"]
    }


@router.get("")
async def get_staff_pins(current_user: dict = Depends(get_current_user)):
    """Get all staff PINs (admin only) - Full PINs visible only to Super Admin"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    staff_pins = await db.staff_pins.find({}, {"_id": 0}).sort("name", 1).to_list(100000)
    
    # Check if user is Super Admin - only they can see full PINs
    is_super_admin = current_user.get("role") == "super_admin"
    
    # Get showroom names
    showrooms = {s["id"]: s["name"] for s in await db.showrooms.find({}, {"_id": 0}).to_list(100000)}
    
    for staff in staff_pins:
        if "pin" in staff:
            if is_super_admin:
                # Super Admin can see FULL PINs
                staff["pin_display"] = staff["pin"]
            # Always remove the raw pin field from response
            del staff["pin"]
        # Update showroom name in case it changed
        if staff.get("showroom_id"):
            staff["showroom_name"] = showrooms.get(staff["showroom_id"], "Unknown")
    
    return staff_pins


@router.get("/{staff_id}")
async def get_staff_pin(staff_id: str, current_user: dict = Depends(get_current_user)):
    """Get a specific staff PIN (admin only) - Full PIN visible only to Super Admin"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    staff = await db.staff_pins.find_one({"id": staff_id}, {"_id": 0})
    if not staff:
        raise HTTPException(status_code=404, detail="Staff member not found")
    
    # Only Super Admin can see full PINs
    is_super_admin = current_user.get("role") == "super_admin"
    if "pin" in staff:
        if is_super_admin:
            staff["pin_display"] = staff["pin"]
        del staff["pin"]
    
    return staff


@router.put("/{staff_id}")
async def update_staff_pin(staff_id: str, input: StaffPinUpdate, current_user: dict = Depends(get_current_user)):
    """Update a staff PIN (admin only)"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    staff = await db.staff_pins.find_one({"id": staff_id})
    if not staff:
        raise HTTPException(status_code=404, detail="Staff member not found")
    
    update_data = {"updated_at": datetime.now(timezone.utc).isoformat()}
    
    if input.name is not None:
        update_data["name"] = input.name
    if input.role is not None:
        update_data["role"] = input.role
    if input.active is not None:
        update_data["active"] = input.active
    if input.showroom_id is not None:
        update_data["showroom_id"] = input.showroom_id
        # Get showroom name
        if input.showroom_id:
            showroom = await db.showrooms.find_one({"id": input.showroom_id}, {"_id": 0})
            update_data["showroom_name"] = showroom["name"] if showroom else None
        else:
            update_data["showroom_name"] = None
    if input.pin is not None:
        # Validate new PIN
        if not input.pin.isdigit() or len(input.pin) < 4 or len(input.pin) > 6:
            raise HTTPException(status_code=400, detail="PIN must be 4-6 digits")
        # Check if new PIN already exists (excluding current staff)
        existing = await db.staff_pins.find_one({"pin": input.pin, "id": {"$ne": staff_id}})
        if existing:
            raise HTTPException(status_code=400, detail="This PIN is already in use")
        update_data["pin"] = input.pin
    if input.can_manage_warehouse is not None:
        update_data["can_manage_warehouse"] = bool(input.can_manage_warehouse)
    
    await db.staff_pins.update_one({"id": staff_id}, {"$set": update_data})
    
    return {"message": "Staff PIN updated successfully"}


@router.delete("/{staff_id}")
async def delete_staff_pin(staff_id: str, current_user: dict = Depends(get_current_user)):
    """Delete a staff PIN (admin only)"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    result = await db.staff_pins.delete_one({"id": staff_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Staff member not found")
    
    return {"message": "Staff PIN deleted successfully"}


@router.post("/verify")
async def verify_staff_pin(input: StaffPinVerify, current_user: dict = Depends(get_current_user)):
    """Verify a staff PIN and return staff details (any authenticated user can verify)"""
    # Allow any authenticated user to verify PINs (needed for day lock and invoice save)
    db = get_db()
    
    # Build query - PIN is required
    query = {"pin": input.pin, "active": True}
    
    staff = await db.staff_pins.find_one(query, {"_id": 0})
    if not staff:
        raise HTTPException(status_code=401, detail="Invalid PIN or access denied")
    
    # Return staff details without PIN
    return {
        "id": staff["id"],
        "name": staff["name"],
        "role": staff.get("role", "staff"),
        "showroom_id": staff.get("showroom_id"),
        "showroom_name": staff.get("showroom_name"),
        "verified": True
    }

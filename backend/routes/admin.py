"""
Admin user management routes (Super Admin Only)
"""
import uuid
from datetime import datetime, timezone
from typing import Optional, List
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

from config import get_db
from models import UserRegister, UserPermissionsUpdate
from services import get_current_user, is_admin_user, log_audit, hash_password

router = APIRouter(prefix="/admin", tags=["Admin"])

# Canonical permission keys — must match the grouped keys checked by the
# admin sidebar (`/app/frontend/src/components/Layout.js`) and rendered
# with labels by `PERMISSION_LABELS` in
# `/app/frontend/src/pages/admin/UserManagement.js`.
#
# 16 May 2026 — Fixed permission-drift bug: this list used to contain the
# legacy granular slugs (`create_invoice`, `edit_invoice`, ...) which
# never matched the grouped keys the sidebar checks for. Result: any user
# created via the Edit User modal got dead permissions and an empty
# sidebar (see Sydenham showroom incident). We now share the same set
# server.py and the invite flow already use.
#
# Legacy slugs are still accepted by the invite flow (`routes/invites.py`)
# for backwards compatibility with old DB records, but new users must use
# these grouped keys.
AVAILABLE_PERMISSIONS = [
    "dashboard",
    "products",
    "categories",
    "orders",
    "epos",
    "customer_pricing",
    "customer_invites",
    "bulk_inquiries",
    "marketing",
    "showrooms",
    "reports",
    "user_management",
]

# Legacy slugs we still accept on PUT (so existing users with old data
# don't get locked out), but we never offer them as new checkboxes.
LEGACY_PERMISSION_SLUGS = [
    "create_invoice",
    "edit_invoice",
    "delete_invoice",
    "view_reports",
    "manage_inventory",
    "manage_categories",
    "manage_customers",
    "manage_orders",
    "export_data",
    "view_analytics",
    "manage_showrooms",
    "send_marketing",
    "view_cost_price",
    "manage_pricing",
    "view_audit_logs",
    "manage_staff_pins",
]
ALL_ACCEPTED_PERMISSIONS = set(AVAILABLE_PERMISSIONS) | set(LEGACY_PERMISSION_SLUGS)


@router.get("/users")
async def get_admin_users(current_user: dict = Depends(get_current_user)):
    """Get all admin/staff users (super_admin only)"""
    if current_user["role"] != "super_admin":
        raise HTTPException(status_code=403, detail="Super Admin access required")
    
    db = get_db()
    
    # Get users who are not customers
    users = await db.users.find(
        {"role": {"$in": ["super_admin", "admin", "manager", "staff"]}},
        {"_id": 0, "password": 0}
    ).to_list(100000)
    
    # Add showroom names
    showrooms = {s["id"]: s["name"] for s in await db.showrooms.find({}, {"_id": 0}).to_list(100000)}
    for user in users:
        if user.get("showroom_id"):
            user["showroom_name"] = showrooms.get(user["showroom_id"], "Unknown")
    
    return users


@router.get("/permissions")
async def get_available_permissions(current_user: dict = Depends(get_current_user)):
    """Get list of available permissions (super_admin only)"""
    if current_user["role"] != "super_admin":
        raise HTTPException(status_code=403, detail="Super Admin access required")
    
    return {
        "permissions": AVAILABLE_PERMISSIONS,
        "roles": ["super_admin", "admin", "manager", "staff"]
    }


@router.put("/users/{user_email}/permissions")
async def update_user_permissions(
    user_email: str,
    input: UserPermissionsUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Update user role and permissions (super_admin only)"""
    if current_user["role"] != "super_admin":
        raise HTTPException(status_code=403, detail="Super Admin access required")
    
    db = get_db()
    
    # Prevent modifying own super_admin role
    if user_email == current_user["email"] and input.role and input.role != "super_admin":
        raise HTTPException(status_code=400, detail="Cannot demote yourself from Super Admin")
    
    user = await db.users.find_one({"email": user_email}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    
    # Store old values for audit
    old_role = user.get("role")
    old_permissions = user.get("permissions", [])
    old_showroom = user.get("showroom_name")
    
    update_data = {}
    if input.role is not None:
        update_data["role"] = input.role
    if input.permissions is not None:
        # Validate permissions. Accept both the canonical grouped keys
        # (what the modal now offers) AND the legacy slugs (for any
        # historical users whose docs still hold old keys — we don't
        # want to lock them out when an admin tweaks their showroom).
        invalid = [p for p in input.permissions if p not in ALL_ACCEPTED_PERMISSIONS]
        if invalid:
            raise HTTPException(status_code=400, detail=f"Invalid permissions: {invalid}")
        update_data["permissions"] = input.permissions
    if input.showroom_id is not None:
        update_data["showroom_id"] = input.showroom_id
        # Get showroom name
        if input.showroom_id:
            showroom = await db.showrooms.find_one({"id": input.showroom_id}, {"_id": 0})
            update_data["showroom_name"] = showroom["name"] if showroom else None
        else:
            update_data["showroom_name"] = None
    
    if update_data:
        await db.users.update_one({"email": user_email}, {"$set": update_data})
        
        # Audit log
        await log_audit(
            action="UPDATE",
            entity_type="user_permissions",
            user=current_user,
            entity_id=user.get("id", ""),
            entity_name=user.get("name", user_email),
            before_data={"role": old_role, "permissions": old_permissions, "store": old_showroom},
            after_data={"role": update_data.get("role", old_role), "permissions": update_data.get("permissions", old_permissions), "store": update_data.get("showroom_name", old_showroom)},
            details=f"User permissions updated: {user_email} - Role: {old_role} -> {update_data.get('role', old_role)}"
        )
    
    return {"message": "User permissions updated successfully"}


@router.post("/users")
async def create_admin_user(input: UserRegister, current_user: dict = Depends(get_current_user)):
    """Create a new admin/staff user (super_admin only)"""
    if current_user["role"] != "super_admin":
        raise HTTPException(status_code=403, detail="Super Admin access required")
    
    db = get_db()
    
    # Check if email already exists
    existing = await db.users.find_one({"email": input.email})
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
    
    # Validate role
    if input.role not in ["admin", "manager", "staff"]:
        raise HTTPException(status_code=400, detail="Invalid role. Use: admin, manager, or staff")
    
    # Get showroom name if provided
    showroom_name = None
    if input.showroom_id:
        showroom = await db.showrooms.find_one({"id": input.showroom_id}, {"_id": 0})
        if showroom:
            showroom_name = showroom["name"]
    
    user_dict = {
        "id": str(uuid.uuid4()),
        "email": input.email,
        "password": hash_password(input.password),
        "name": input.name,
        "role": input.role,
        "phone": input.phone,
        "showroom_id": input.showroom_id,
        "showroom_name": showroom_name,
        "permissions": [],  # Empty by default, super admin will set
        "created_at": datetime.now(timezone.utc).isoformat()
    }
    
    await db.users.insert_one(user_dict)
    
    return {
        "message": "User created successfully",
        "email": input.email,
        "role": input.role
    }


@router.delete("/users/{user_email}")
async def delete_admin_user(user_email: str, current_user: dict = Depends(get_current_user)):
    """Delete an admin/staff user (super_admin only)"""
    if current_user["role"] != "super_admin":
        raise HTTPException(status_code=403, detail="Super Admin access required")
    
    db = get_db()
    
    # Prevent self-deletion
    if user_email == current_user["email"]:
        raise HTTPException(status_code=400, detail="Cannot delete your own account")
    
    user = await db.users.find_one({"email": user_email}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    
    # Prevent deleting other super admins
    if user.get("role") == "super_admin":
        raise HTTPException(status_code=400, detail="Cannot delete Super Admin accounts")
    
    result = await db.users.delete_one({"email": user_email})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="User not found")
    
    return {"message": "User deleted successfully"}

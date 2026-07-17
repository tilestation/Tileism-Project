"""
Authentication and authorization services
"""
import os
import jwt
import bcrypt
import random
import string
from datetime import datetime, timedelta, timezone
from fastapi import HTTPException, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from config import get_db, JWT_SECRET

security = HTTPBearer()

def generate_otp():
    """Generate a 6-digit OTP"""
    return ''.join(random.choices(string.digits, k=6))


def hash_password(password: str) -> str:
    """Hash a password using bcrypt"""
    salt = bcrypt.gensalt()
    return bcrypt.hashpw(password.encode('utf-8'), salt).decode('utf-8')


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify a password against a hash"""
    return bcrypt.checkpw(plain_password.encode('utf-8'), hashed_password.encode('utf-8'))


def create_access_token(data: dict):
    """Create a JWT access token"""
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + timedelta(days=30)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, JWT_SECRET, algorithm="HS256")


async def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)):
    """Get the current user from the JWT token"""
    try:
        token = credentials.credentials
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
        email = payload.get("sub")
        if not email:
            raise HTTPException(status_code=401, detail="Invalid token")
        
        db = get_db()
        user = await db.users.find_one({"email": email}, {"_id": 0})
        if not user:
            raise HTTPException(status_code=401, detail="User not found")
        return user
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")


def is_admin_user(user: dict) -> bool:
    """Check if user has admin privileges"""
    return user.get("role") in ["super_admin", "admin", "manager", "staff"]


def require_admin_access(user: dict):
    """Require admin access, raise exception if not"""
    if not is_admin_user(user):
        raise HTTPException(status_code=403, detail="Admin access required")


def has_permission(user: dict, permission: str) -> bool:
    """Check if a user has a specific permission.

    Resolution order (matches /api/permissions/me):
      1. Super admins bypass all checks.
      2. Explicit denial via user.denied_pages → False.
      3. Explicit grant via user.extra_pages → True.
      4. Legacy user.permissions list (still used by older seed data).

    Role default permissions ARE NOT checked here because roles carry
    dozens of default pages, and callers that need role-level access
    should use is_admin_user() or a role check instead. This function
    exists to gate action-level permissions like `warehouse_manage`.
    """
    if user.get("role") == "super_admin":
        return True
    if permission in (user.get("denied_pages") or []):
        return False
    if permission in (user.get("extra_pages") or []):
        return True
    return permission in (user.get("permissions") or [])


def require_permission(user: dict, permission: str):
    """Require a specific permission, raise exception if not"""
    if not has_permission(user, permission):
        raise HTTPException(status_code=403, detail=f"Permission required: {permission}")

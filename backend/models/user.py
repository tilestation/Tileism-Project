"""
Pydantic models for Users and Authentication
"""
from pydantic import BaseModel, EmailStr, Field
from typing import Optional, List
from datetime import datetime, timezone
from enum import Enum


class UserRole(str, Enum):
    SUPER_ADMIN = "super_admin"
    ADMIN = "admin"
    MANAGER = "manager"
    STAFF = "staff"
    CUSTOMER = "customer"


class Address(BaseModel):
    line1: str = ""
    line2: str = ""
    city: str = ""
    postcode: str = ""
    country: str = "United Kingdom"


class UserRegister(BaseModel):
    email: EmailStr
    password: str
    name: str
    phone: str = ""
    address: Optional[Address] = None
    invite_code: Optional[str] = None
    role: str = "customer"
    # Admin-created users (POST /api/admin/users) can be assigned to a
    # showroom at creation time. Customer self-registration leaves this
    # blank. Added 12 May 2026 — previously routes/admin.py:create_admin_user
    # read input.showroom_id which AttributeError'd because the model
    # didn't define it, causing every admin user-create attempt to 500.
    showroom_id: Optional[str] = None


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class User(BaseModel):
    id: str
    email: str
    name: str
    phone: str = ""
    address: Optional[Address] = None
    role: str = "customer"
    permissions: List[str] = []
    showroom_id: Optional[str] = None
    showroom_name: Optional[str] = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class UserPermissionsUpdate(BaseModel):
    permissions: Optional[List[str]] = None
    role: Optional[str] = None
    showroom_id: Optional[str] = None


class StaffRegistration(BaseModel):
    email: EmailStr
    password: str
    name: str
    phone: str = ""


class TokenResponse(BaseModel):
    token: str
    user: User


class StaffPinCreate(BaseModel):
    name: str
    pin: str  # 4-6 digit PIN
    role: str = "staff"  # staff, manager, admin
    active: bool = True
    showroom_id: Optional[str] = None


class StaffPinUpdate(BaseModel):
    name: Optional[str] = None
    pin: Optional[str] = None
    role: Optional[str] = None
    active: Optional[bool] = None
    showroom_id: Optional[str] = None


class StaffPinVerify(BaseModel):
    pin: str

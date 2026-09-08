from fastapi import FastAPI, APIRouter, HTTPException, Depends, UploadFile, File, Body, Request, BackgroundTasks, Query
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.responses import StreamingResponse, FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.gzip import GZipMiddleware
from middleware import EdgeCacheMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
import io
import csv
import asyncio
import uuid
import shutil
from pathlib import Path
from pydantic import BaseModel, Field, ConfigDict, EmailStr, field_validator
from typing import List, Optional, Dict
from datetime import datetime, timezone, timedelta
from passlib.context import CryptContext
import bcrypt
import jwt
import secrets
import re

# Create uploads directory
UPLOAD_DIR = Path("/app/backend/uploads")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# Optional imports
try:
    from twilio.rest import Client as TwilioClient
    TWILIO_AVAILABLE = True
except ImportError:
    TWILIO_AVAILABLE = False
    TwilioClient = None

try:
    import resend
    RESEND_AVAILABLE = True
except ImportError:
    RESEND_AVAILABLE = False
    resend = None

# PDF generation
try:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
    from reportlab.lib.enums import TA_CENTER, TA_RIGHT, TA_LEFT
    REPORTLAB_AVAILABLE = True
except ImportError:
    REPORTLAB_AVAILABLE = False

ROOT_DIR = Path(__file__).parent
env_file = ROOT_DIR / '.env'
if env_file.exists():
    load_dotenv(env_file)

mongo_url = os.environ.get('MONGO_URL')
if not mongo_url:
    raise ValueError("MONGO_URL environment variable is required")
client = AsyncIOMotorClient(mongo_url)
db_name = os.environ.get('DB_NAME', 'tile_station')
db = client[db_name]

# Twilio configuration
TWILIO_ACCOUNT_SID = os.environ.get("TWILIO_ACCOUNT_SID")
TWILIO_AUTH_TOKEN = os.environ.get("TWILIO_AUTH_TOKEN")
TWILIO_VERIFY_SERVICE_SID = os.environ.get("TWILIO_VERIFY_SERVICE_SID")
TWILIO_PHONE_NUMBER = os.environ.get("TWILIO_PHONE_NUMBER")

# Initialize Twilio client if credentials are available
twilio_client = None
if TWILIO_AVAILABLE and TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN:
    try:
        twilio_client = TwilioClient(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    except Exception as e:
        logging.warning(f"Failed to initialize Twilio client: {e}")

# Resend configuration
RESEND_API_KEY = os.environ.get("RESEND_API_KEY")
SENDER_EMAIL = os.environ.get("SENDER_EMAIL", "gravesend@tilestation.co.uk")
if RESEND_AVAILABLE and RESEND_API_KEY:
    try:
        resend.api_key = RESEND_API_KEY
    except Exception as e:
        logging.warning(f"Failed to initialize Resend: {e}")

app = FastAPI()

# Initialize Sentry as early as possible — captures startup errors too.
# No-op when SENTRY_DSN isn't set, so safe to call unconditionally.
try:
    from utils.sentry_config import init_sentry
    init_sentry()
except Exception as _sentry_err:
    logging.warning(f"Sentry initialization skipped: {_sentry_err}")

# OWASP security headers (CSP, HSTS, X-Frame-Options, etc.) — safe defaults.
# Toggle off via SECURITY_HEADERS_ENABLED=false if needed for debugging.
try:
    from middleware.security_headers import install_security_headers
    install_security_headers(app)
except Exception as _sec_err:
    logging.warning(f"Security headers middleware not installed: {_sec_err}")

# Ensure storefront DB indexes exist — biggest single perf win for the slow
# /api/tiles/collections endpoint. Idempotent; only creates missing indexes.
try:
    from utils.ensure_indexes import ensure_storefront_indexes
    _idx_result = ensure_storefront_indexes()
    if _idx_result.get("created"):
        logging.info(f"Storefront indexes created: {_idx_result['created']}")
except Exception as _idx_err:
    logging.warning(f"Could not ensure storefront indexes: {_idx_err}")

# Add CORS middleware immediately after app creation
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)

# PERFORMANCE — Gzip compression for every response > 500 bytes.
# (21 May 2026: enabled to fix slow loading on /tiles, EPOS, admin
# dashboard. Production was previously shipping JSON uncompressed —
# `/api/tiles/collections` was 120 KB per request. With gzip the same
# response is ~22 KB, a 5× reduction on every API call across the site.
# compresslevel=6 is the sweet spot: compression ratio of 9 with ~1/3
# the CPU cost. The 500 B threshold skips compressing tiny responses
# where the gzip overhead is bigger than the saving.)
app.add_middleware(GZipMiddleware, minimum_size=500, compresslevel=6)

# PERFORMANCE — CDN edge-cache headers (22 May 2026).
# Adds Cache-Control / Vary headers to PUBLIC GET endpoints so Cloudflare
# (or any CDN sitting in front of the origin) can serve responses from the
# London/Manchester edge — sub-50ms TTFB for UK customers vs ~600ms hitting
# our us-west2 Railway origin. See middleware/edge_cache.py for the
# whitelist and TTLs. Auth'd / cookied requests are skipped automatically.
app.add_middleware(EdgeCacheMiddleware)

api_router = APIRouter(prefix="/api")

# Import and include modular routes
from routes import api_router as modular_router
api_router.include_router(modular_router)

security = HTTPBearer()
SECRET_KEY = os.environ.get("JWT_SECRET", "your-secret-key-change-in-production")
ALGORITHM = "HS256"

# OTP storage (in production, use Redis or database with TTL)
otp_storage = {}

def generate_otp():
    """Generate a 6-digit OTP"""
    return ''.join([str(secrets.randbelow(10)) for _ in range(6)])

def hash_password(password: str) -> str:
    """Hash a password using bcrypt"""
    salt = bcrypt.gensalt()
    hashed = bcrypt.hashpw(password.encode('utf-8'), salt)
    return hashed.decode('utf-8')

def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify a password against its bcrypt hash"""
    return bcrypt.checkpw(plain_password.encode('utf-8'), hashed_password.encode('utf-8'))

def create_access_token(data: dict):
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + timedelta(days=30)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt

async def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)):
    token = credentials.credentials
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        email = payload.get("sub")
        if email is None:
            raise HTTPException(status_code=401, detail="Invalid authentication")
        user = await db.users.find_one({"email": email}, {"_id": 0})
        if user is None:
            raise HTTPException(status_code=401, detail="User not found")
        return user
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

class Address(BaseModel):
    line1: str
    line2: Optional[str] = None
    city: str
    postcode: str
    country: str = "United Kingdom"

class UserRegister(BaseModel):
    email: EmailStr
    password: str
    name: str
    role: str = "customer"
    phone: Optional[str] = None
    invite_code: Optional[str] = None
    company_name: Optional[str] = None
    company_reg_number: Optional[str] = None
    vat_number: Optional[str] = None
    address: Optional[Address] = None
    showroom_id: Optional[str] = None
    marketing_opt_in: bool = True

class UserLogin(BaseModel):
    email: EmailStr
    password: str
    device_id: Optional[str] = None  # Unique device identifier
    device_name: Optional[str] = None  # Browser/device name
    device_type: Optional[str] = None  # desktop, mobile, tablet

class DeviceApprovalRequest(BaseModel):
    id: str
    user_email: str
    user_name: str
    user_role: str
    device_id: str
    device_name: str
    device_type: str
    ip_address: Optional[str] = None
    requested_at: str
    status: str = "pending"  # pending, approved, rejected

# Available permissions
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
    "user_management"
]

class User(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: Optional[str] = None  # User ID from database
    email: EmailStr
    name: str
    role: str  # super_admin, admin, manager, staff, customer
    phone: Optional[str] = None
    company_name: Optional[str] = None
    company_reg_number: Optional[str] = None
    vat_number: Optional[str] = None
    address: Optional[dict] = None
    showroom_id: Optional[str] = None
    showroom_name: Optional[str] = None
    permissions: List[str] = []  # List of permission keys
    marketing_opt_in: bool = True
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

class UserPermissionsUpdate(BaseModel):
    role: Optional[str] = None
    permissions: Optional[List[str]] = None
    showroom_id: Optional[str] = None

class StaffRegistration(BaseModel):
    name: str
    email: EmailStr
    password: str

class TokenResponse(BaseModel):
    token: str
    user: User

# Store Models
class Store(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    name: str
    address: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

class StoreCreate(BaseModel):
    name: str
    address: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None

# Sales Target Models
class SalesTarget(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    showroom_id: Optional[str] = None  # None = all showrooms
    month: int  # 1-12
    year: int
    monthly_target: float
    daily_target: float  # Auto-calculated
    weekly_target: float  # Auto-calculated
    created_by: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

# NOTE: SalesTargetCreate and SalesTargetUpdate models moved to routes/analytics.py

# Marketing Campaign Models
class MarketingCampaign(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    name: str
    subject: str
    content: str
    campaign_type: str  # promotional, newsletter, custom
    target_audience: str  # all, showroom, opted_in
    target_showroom_id: Optional[str] = None
    status: str = "draft"  # draft, sent
    sent_count: int = 0
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    sent_at: Optional[datetime] = None

class MarketingCampaignCreate(BaseModel):
    name: str
    subject: str
    content: str
    campaign_type: str = "promotional"
    target_audience: str = "all"
    target_showroom_id: Optional[str] = None

class Category(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    name: str
    description: Optional[str] = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

class CategoryCreate(BaseModel):
    name: str
    description: Optional[str] = None

class Product(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    name: str
    supplier_product_name: Optional[str] = None  # Secondary name from supplier (not shown on invoices)
    sku: Optional[str] = None  # Made optional - some products may not have SKU
    description: Optional[str] = None
    category_id: Optional[str] = None
    category_name: Optional[str] = None
    colors: List[str] = []  # Available color options for this product
    # New stocktake fields
    finish: Optional[str] = None  # e.g., Matt, Gloss, Polished
    material: Optional[str] = None  # e.g., Porcelain, Ceramic, Natural Stone
    type: Optional[str] = None  # e.g., Floor Tile, Wall Tile, Mosaic
    edge: Optional[str] = None  # e.g., Rectified, Non-Rectified, Bevelled
    slip_rating: Optional[str] = None  # e.g., R9, R10, R11
    size: Optional[str] = None  # e.g., 60x60, 30x60
    series: Optional[str] = None  # Product series name (shown on website)
    rectified_edges: Optional[bool] = None  # Rectified edges?
    underfloor_heating: Optional[bool] = None  # Suitable for underfloor heating?
    suitability: Optional[str] = None  # e.g., Wall, Floor, Wall & Floor
    thickness: Optional[float] = None  # Thickness in mm
    stock: int = 0  # Default to 0 if missing
    
    # Validator to parse thickness from strings like "9mm" to float
    @field_validator('thickness', mode='before')
    @classmethod
    def parse_thickness(cls, v):
        if v is None:
            return None
        if isinstance(v, (int, float)):
            return float(v)
        if isinstance(v, str):
            # Remove 'mm' suffix and any whitespace
            v = v.lower().replace('mm', '').strip()
            try:
                return float(v)
            except ValueError:
                return None
        return None
    
    # Validator to ensure stock is never None
    @field_validator('stock', mode='before')
    @classmethod
    def parse_stock(cls, v):
        if v is None:
            return 0
        try:
            return int(v)
        except (ValueError, TypeError):
            return 0
    m2_quantity: Optional[float] = None
    # Tile size for m² calculation (e.g., "30x60" for 30cm x 60cm)
    tile_width: Optional[float] = None  # Width in cm
    tile_height: Optional[float] = None  # Height in cm
    tile_m2_per_piece: Optional[float] = None  # Calculated m² per piece
    # Box configuration
    tiles_per_box: Optional[int] = None  # Number of tiles in a box
    box_m2_coverage: Optional[float] = None  # m² coverage per box (auto-calculated)
    price: float = 0.0  # Default to 0 if missing
    cost: Optional[float] = None  # Cost price for profit calculation
    # Room lot pricing
    room_lot_enabled: bool = False
    room_lot_quantity: Optional[int] = None  # Minimum quantity for room lot price
    room_lot_price: Optional[float] = None   # Price per piece when buying room lot
    # Pallet pricing
    pallet_enabled: bool = False
    pallet_quantity: Optional[int] = None    # Minimum quantity for pallet price
    pallet_price: Optional[float] = None     # Price per piece when buying full pallet
    # Clearance
    clearance: bool = False
    clearance_price: Optional[float] = None
    # Maximum discount allowed (percentage, e.g., 20 means 20% max discount)
    max_discount: Optional[float] = None
    reorder_level: int = 10
    images: List[str] = []
    # Showroom stock allocation (added for multi-store inventory)
    showroom_stock: Dict[str, int] = {}  # {showroom_id: quantity}
    # Supplier stock levels (for e-commerce and availability checking)
    supplier_stock: Dict[str, int] = {}  # {supplier_id: quantity}
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

class ProductCreate(BaseModel):
    name: str
    supplier_product_name: Optional[str] = None  # Secondary name from supplier
    sku: str
    description: Optional[str] = None
    category_id: Optional[str] = None
    colors: List[str] = []  # Available color options
    # New stocktake fields
    finish: Optional[str] = None
    material: Optional[str] = None
    type: Optional[str] = None
    edge: Optional[str] = None
    slip_rating: Optional[str] = None
    size: Optional[str] = None
    series: Optional[str] = None  # Product series name (shown on website)
    rectified_edges: Optional[bool] = None
    underfloor_heating: Optional[bool] = None
    suitability: Optional[str] = None
    thickness: Optional[float] = None
    stock: int = 0
    m2_quantity: Optional[float] = None
    # Tile size for m² calculation
    tile_width: Optional[float] = None  # Width in cm
    tile_height: Optional[float] = None  # Height in cm
    # Box configuration
    tiles_per_box: Optional[int] = None  # Number of tiles in a box
    price: float = 0.0
    cost: Optional[float] = None  # Cost price for profit calculation
    # Room lot pricing
    room_lot_enabled: bool = False
    room_lot_quantity: Optional[int] = None
    room_lot_price: Optional[float] = None
    # Pallet pricing
    pallet_enabled: bool = False
    pallet_quantity: Optional[int] = None
    pallet_price: Optional[float] = None
    # Clearance
    clearance: bool = False
    clearance_price: Optional[float] = None
    # Maximum discount allowed (percentage, e.g., 20 means 20% max discount)
    max_discount: Optional[float] = None
    reorder_level: int = 10
    images: List[str] = []
    
    @field_validator('thickness', mode='before')
    @classmethod
    def parse_thickness(cls, v):
        if v is None:
            return None
        if isinstance(v, (int, float)):
            return float(v)
        if isinstance(v, str):
            v = v.lower().replace('mm', '').strip()
            try:
                return float(v)
            except ValueError:
                return None
        return None
    
    @field_validator('stock', mode='before')
    @classmethod
    def parse_stock(cls, v):
        if v is None:
            return 0
        try:
            return int(v)
        except (ValueError, TypeError):
            return 0

class ProductUpdate(BaseModel):
    name: Optional[str] = None
    supplier_product_name: Optional[str] = None  # Secondary name from supplier
    sku: Optional[str] = None
    description: Optional[str] = None
    category_id: Optional[str] = None
    colors: Optional[List[str]] = None  # Available color options
    # Visibility & Status
    visibility: Optional[str] = None  # draft, published
    status: Optional[str] = None  # pending_approval, approved, active
    show_on_website: Optional[bool] = None
    show_in_epos: Optional[bool] = None
    epos_visible: Optional[bool] = None
    # New stocktake fields
    finish: Optional[str] = None
    material: Optional[str] = None
    type: Optional[str] = None
    edge: Optional[str] = None
    slip_rating: Optional[str] = None
    size: Optional[str] = None
    series: Optional[str] = None  # Product series name (replaces Collection)
    rectified_edges: Optional[bool] = None
    underfloor_heating: Optional[bool] = None
    suitability: Optional[str] = None
    thickness: Optional[float] = None
    stock: Optional[int] = None
    m2_quantity: Optional[float] = None
    # Tile size for m² calculation
    tile_width: Optional[float] = None
    tile_height: Optional[float] = None
    # Box configuration
    tiles_per_box: Optional[int] = None
    price: Optional[float] = None
    cost: Optional[float] = None  # Cost price for profit calculation
    # Room lot pricing
    room_lot_enabled: Optional[bool] = None
    room_lot_quantity: Optional[int] = None
    room_lot_price: Optional[float] = None
    # Pallet pricing
    pallet_enabled: Optional[bool] = None
    pallet_quantity: Optional[int] = None
    pallet_price: Optional[float] = None
    # Half + Full Pallet pricing (Feb 2026) — minimum m² + half rate.
    # MUST be present here too — the active PUT /api/products/{id} handler
    # in server.py validates against THIS local model, not models/product.py.
    # Pydantic silently drops unknown fields → without these lines, admin
    # form saves never reach $set and the new fields disappear on round-trip.
    m2_per_pallet: Optional[float] = None
    m2_per_half_pallet: Optional[float] = None
    half_pallet_price: Optional[float] = None
    pallet_price_per_m2: Optional[float] = None
    half_pallet_price_per_m2: Optional[float] = None
    # Clearance
    clearance: Optional[bool] = None
    clearance_price: Optional[float] = None
    # Maximum discount allowed (percentage, e.g., 20 means 20% max discount)
    max_discount: Optional[float] = None
    reorder_level: Optional[int] = None
    images: Optional[List[str]] = None
    
    @field_validator('thickness', mode='before')
    @classmethod
    def parse_thickness(cls, v):
        if v is None:
            return None
        if isinstance(v, (int, float)):
            return float(v)
        if isinstance(v, str):
            v = v.lower().replace('mm', '').strip()
            try:
                return float(v)
            except ValueError:
                return None
        return None
    
    @field_validator('stock', mode='before')
    @classmethod
    def parse_stock(cls, v):
        if v is None:
            return None  # Keep as None for updates (don't overwrite)
        try:
            return int(v)
        except (ValueError, TypeError):
            return None

class OrderItem(BaseModel):
    product_id: str
    product_name: str
    quantity: int
    price: float

class BulkInquiry(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    customer_email: str
    customer_name: str
    customer_phone: Optional[str] = None
    product_id: str
    product_name: str
    product_sku: str
    quantity_needed: int
    message: Optional[str] = None
    status: str = "pending"  # pending, contacted, quoted, closed
    admin_notes: Optional[str] = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

class BulkInquiryCreate(BaseModel):
    product_id: str
    quantity_needed: int
    phone: Optional[str] = None
    message: Optional[str] = None

class BulkInquiryUpdate(BaseModel):
    status: Optional[str] = None
    admin_notes: Optional[str] = None

# Invoice Models
class InvoiceLineItem(BaseModel):
    product_id: Optional[str] = None  # Optional for manual entries
    product_name: str
    sku: Optional[str] = None
    quantity: float
    m2: Optional[float] = 0
    price: float              # Original/List price
    due_price: Optional[float] = None  # Custom/Negotiated/Due price (if different from price)
    total: Optional[float] = None  # Total for this line item
    discount: float = 0
    cost_price: Optional[float] = None  # Cost price for profit calculation (Super Admin only)

class DepositEntry(BaseModel):
    date: str
    amount: float
    note: Optional[str] = None

class InvoiceCreate(BaseModel):
    invoice_no: str
    date: str
    time: str
    customer_name: Optional[str] = None
    customer_phone: Optional[str] = None
    customer_email: Optional[str] = None
    customer_address: Optional[str] = None
    notes: Optional[str] = None
    sales_person: Optional[str] = None
    payment_method: str = "Card"
    order_type: str = "Store Order"  # "Store Order" or "Special Order"
    showroom_id: Optional[str] = None
    showroom_name: Optional[str] = None
    deposits: List[DepositEntry] = []  # Multiple deposits on different days
    line_items: List[InvoiceLineItem]
    subtotal: float
    vat: float
    gross_total: float
    total_savings: float = 0
    staff_pin: Optional[str] = None  # PIN verification for staff
    # Order status: open_order -> processing -> completed
    # If paid in full (no outstanding) -> status follows normal flow
    # If deposit taken with outstanding -> deposit_order status
    status: str = "open_order"  # open_order, deposit_order, processing, completed

class InvoiceUpdate(BaseModel):
    invoice_no: Optional[str] = None
    date: Optional[str] = None
    time: Optional[str] = None
    customer_name: Optional[str] = None
    customer_phone: Optional[str] = None
    customer_email: Optional[str] = None
    customer_address: Optional[str] = None
    notes: Optional[str] = None
    sales_person: Optional[str] = None
    payment_method: Optional[str] = None
    order_type: Optional[str] = None  # "Store Order" or "Special Order"
    showroom_id: Optional[str] = None
    showroom_name: Optional[str] = None
    deposits: Optional[List[DepositEntry]] = None  # Multiple deposits
    line_items: Optional[List[InvoiceLineItem]] = None
    subtotal: Optional[float] = None
    vat: Optional[float] = None
    gross_total: Optional[float] = None
    total_savings: Optional[float] = None
    staff_pin: Optional[str] = None  # PIN verification for edit
    status: Optional[str] = None  # open_order, deposit_order, processing, completed

# Staff PIN Models
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

class CustomerInvite(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    code: str
    created_by: str
    note: Optional[str] = None
    used: bool = False
    used_by: Optional[str] = None
    used_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    expires_at: Optional[datetime] = None

# Staff/Admin Invite Models
class StaffInviteCreate(BaseModel):
    role: str = "staff"  # staff, manager, admin
    showroom_id: Optional[str] = None
    permissions: List[str] = []
    note: Optional[str] = None
    expires_days: int = 7  # Link expires in X days

class StaffInvite(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    code: str
    role: str
    showroom_id: Optional[str] = None
    showroom_name: Optional[str] = None
    permissions: List[str] = []
    note: Optional[str] = None
    created_by: str
    used: bool = False
    used_by: Optional[str] = None
    used_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    expires_at: Optional[datetime] = None

class InviteCreate(BaseModel):
    note: Optional[str] = None
    expires_in_days: Optional[int] = 30

class InviteEmailRequest(BaseModel):
    recipient_email: EmailStr
    recipient_name: Optional[str] = None
    note: Optional[str] = None
    expires_in_days: Optional[int] = 30

class Order(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    customer_email: str
    customer_name: str
    items: List[OrderItem]
    total_amount: float
    status: str = "pending"
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

class OrderCreate(BaseModel):
    items: List[OrderItem]

class OrderStatusUpdate(BaseModel):
    status: str

class CustomerPricing(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    customer_email: str
    product_id: str
    custom_price: float
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

class CustomerPricingCreate(BaseModel):
    customer_email: str
    product_id: str
    custom_price: float

class BulkPricingItem(BaseModel):
    customer_email: str
    product_id: str
    custom_price: float

class BulkPricingImport(BaseModel):
    items: List[BulkPricingItem]

class BulkImportResult(BaseModel):
    total: int
    successful: int
    failed: int
    errors: List[str]

class OTPRequest(BaseModel):
    order_data: OrderCreate
    phone_number: str  # Phone number in E.164 format (e.g., +44XXXXXXXXXX)

class OTPVerification(BaseModel):
    order_data: OrderCreate
    otp: str
    phone_number: str  # Phone number used for OTP verification

class DashboardStats(BaseModel):
    total_products: int
    low_stock_count: int
    total_orders: int
    pending_orders: int
    total_revenue: float

class StoreAnalytics(BaseModel):
    showroom_id: str
    showroom_name: str
    total_revenue: float
    invoice_count: int
    average_order_value: float
    top_products: List[dict]
    percentage_of_total: float

class AnalyticsResponse(BaseModel):
    period: str
    start_date: str
    end_date: str
    total_revenue: float
    total_invoices: int
    average_order_value: float
    showroom_analytics: List[StoreAnalytics]
    daily_trends: List[dict]

class InvoiceEmailRequest(BaseModel):
    email: EmailStr
    message: Optional[str] = None
    # Optional staff-name override for the email signature. If omitted,
    # we auto-fill from current_user.get("name"). Frontend can let the
    # admin type a custom name (e.g. "Sarah from Tile Station Tonbridge")
    # if they want different branding for that one email.
    sender_name: Optional[str] = None

class AuditLogEntry(BaseModel):
    id: str
    action: str  # CREATE, UPDATE, DELETE, LOGIN, LOGOUT, STATUS_CHANGE
    entity_type: str  # invoice, product, order, user, showroom, price, auth
    entity_id: Optional[str] = None
    entity_name: Optional[str] = None
    user_email: str
    user_name: Optional[str] = None
    user_role: Optional[str] = None
    before_data: Optional[dict] = None
    after_data: Optional[dict] = None
    changes: Optional[List[dict]] = None  # List of field changes
    ip_address: Optional[str] = None
    showroom_id: Optional[str] = None
    showroom_name: Optional[str] = None
    timestamp: str
    details: Optional[str] = None

# Audit logging helper
async def log_audit(
    action: str,
    entity_type: str,
    user: dict,
    entity_id: str = None,
    entity_name: str = None,
    before_data: dict = None,
    after_data: dict = None,
    details: str = None,
    request = None
):
    """Log an action to the audit trail"""
    from uuid import uuid4
    
    # Calculate changes if before and after data provided
    changes = []
    if before_data and after_data:
        all_keys = set(before_data.keys()) | set(after_data.keys())
        for key in all_keys:
            if key in ['_id', 'password', 'created_at', 'updated_at']:
                continue
            old_val = before_data.get(key)
            new_val = after_data.get(key)
            if old_val != new_val:
                changes.append({
                    "field": key,
                    "old_value": old_val,
                    "new_value": new_val
                })
    
    audit_entry = {
        "id": str(uuid4()),
        "action": action,
        "entity_type": entity_type,
        "entity_id": entity_id,
        "entity_name": entity_name,
        "user_email": user.get("email", "system"),
        "user_name": user.get("name"),
        "user_role": user.get("role"),
        "before_data": before_data,
        "after_data": after_data,
        "changes": changes if changes else None,
        "showroom_id": user.get("showroom_id"),
        "showroom_name": user.get("showroom_name"),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "details": details
    }
    
    await db.audit_logs.insert_one(audit_entry)
    return audit_entry

# Helper function to check admin access (admin or super_admin)
def is_admin_user(user: dict) -> bool:
    """Check if user has admin-level access (admin, super_admin, manager with permissions)"""
    return user.get("role") in ["admin", "super_admin", "manager", "staff"]

def require_admin_access(user: dict):
    """Raise 403 if user doesn't have admin access"""
    if not is_admin_user(user):
        raise HTTPException(status_code=403, detail="Admin access required")

def has_permission(user: dict, permission: str) -> bool:
    """Check if user has a specific permission"""
    if user.get("role") == "super_admin":
        return True
    return permission in (user.get("permissions") or [])

def require_permission(user: dict, permission: str):
    """Raise 403 if user doesn't have the required permission"""
    if not has_permission(user, permission):
        raise HTTPException(status_code=403, detail=f"Permission '{permission}' required")

@api_router.post("/auth/register", response_model=TokenResponse)
async def register(input: UserRegister):
    existing_user = await db.users.find_one({"email": input.email})
    if existing_user:
        raise HTTPException(status_code=400, detail="Email already registered")
    
    # If invite code provided, validate and mark as used
    if input.invite_code:
        invite = await db.invites.find_one({"code": input.invite_code}, {"_id": 0})
        if not invite:
            raise HTTPException(status_code=400, detail="Invalid invite code")
        if invite.get("used"):
            raise HTTPException(status_code=400, detail="This invite has already been used")
        if invite.get("expires_at"):
            expires_at = invite["expires_at"]
            if isinstance(expires_at, str):
                expires_at = datetime.fromisoformat(expires_at)
            if datetime.now(timezone.utc) > expires_at:
                raise HTTPException(status_code=400, detail="This invite has expired")
        
        # Mark invite as used
        await db.invites.update_one(
            {"code": input.invite_code},
            {"$set": {
                "used": True,
                "used_by": input.email,
                "used_at": datetime.now(timezone.utc).isoformat()
            }}
        )
    
    hashed_pwd = hash_password(input.password)
    
    # Prepare address data
    address_data = None
    if input.address:
        address_data = {
            "line1": input.address.line1,
            "line2": input.address.line2,
            "city": input.address.city,
            "postcode": input.address.postcode,
            "country": input.address.country
        }
    
    user_dict = {
        "email": input.email,
        "password": hashed_pwd,
        "name": input.name,
        "role": input.role,
        "phone": input.phone,
        "company_name": input.company_name,
        "company_reg_number": input.company_reg_number,
        "vat_number": input.vat_number,
        "address": address_data,
        "invite_code": input.invite_code,
        "created_at": datetime.now(timezone.utc).isoformat()
    }
    
    await db.users.insert_one(user_dict)
    
    user_obj = User(
        email=input.email, 
        name=input.name, 
        role=input.role, 
        phone=input.phone,
        company_name=input.company_name,
        company_reg_number=input.company_reg_number,
        vat_number=input.vat_number,
        address=address_data
    )
    token = create_access_token({"sub": input.email, "role": input.role})
    
    # Send notification for new customer registration
    if input.role == "customer":
        try:
            from services.notifications import notify_new_customer
            await notify_new_customer(db, user_dict)
        except Exception as e:
            logging.error(f"Failed to send new customer notification: {e}")
    
    return TokenResponse(token=token, user=user_obj)


@api_router.delete("/auth/user/{email}")
async def delete_user_by_email(email: str, current_user: dict = Depends(get_current_user)):
    """Delete a user by email (Super Admin only)"""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super Admin access required")
    
    # Don't allow deleting yourself
    if current_user.get("email") == email:
        raise HTTPException(status_code=400, detail="Cannot delete your own account")
    
    result = await db.users.delete_one({"email": email})
    
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="User not found")
    
    # Log audit trail
    await log_audit(
        action="DELETE_USER",
        entity_type="user",
        user=current_user,
        entity_id=None,
        entity_name=email,
        details=f"Deleted user: {email}"
    )
    
    return {"message": f"User {email} deleted successfully"}


@api_router.get("/auth/users")
async def list_users(current_user: dict = Depends(get_current_user)):
    """List all users (Admin only)"""
    if current_user.get("role") not in ["super_admin", "admin"]:
        raise HTTPException(status_code=403, detail="Admin access required")
    
    users = await db.users.find({}, {"_id": 0, "password": 0}).to_list(1000)
    return users


@api_router.post("/auth/login", response_model=TokenResponse)
async def login(input: UserLogin, request: Request):
    user = await db.users.find_one({"email": input.email}, {"_id": 0})
    if not user or not verify_password(input.password, user["password"]):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    
    # Super Admin bypasses device approval
    if user.get("role") != "super_admin" and input.device_id:
        # Check if this device is approved for this user
        approved_device = await db.approved_devices.find_one({
            "user_email": input.email,
            "device_id": input.device_id
        })
        
        if not approved_device:
            # Check if there's already a pending request for this device
            pending_request = await db.device_approvals.find_one({
                "user_email": input.email,
                "device_id": input.device_id,
                "status": "pending"
            })
            
            if not pending_request:
                # Create a new device approval request
                approval_request = {
                    "id": str(uuid.uuid4()),
                    "user_email": input.email,
                    "user_name": user.get("name", "Unknown"),
                    "user_role": user.get("role", "staff"),
                    "device_id": input.device_id,
                    "device_name": input.device_name or "Unknown Device",
                    "device_type": input.device_type or "unknown",
                    "ip_address": request.client.host if request.client else None,
                    "requested_at": datetime.now(timezone.utc).isoformat(),
                    "status": "pending"
                }
                await db.device_approvals.insert_one(approval_request)
                
                # Log audit trail
                await log_audit(
                    action="DEVICE_APPROVAL_REQUEST",
                    entity_type="auth",
                    user=user,
                    entity_id=approval_request["id"],
                    entity_name=input.email,
                    details=f"New device login request from {input.device_name or 'Unknown Device'}"
                )

                # Email super admins with one-click Approve / Deny magic-
                # link buttons embedded right in the email body.
                # 24 Feb 2026 — extended (per user request) from the
                # deep-link-only version to match the refund-approval
                # pattern in routes/refunds.py. Same HMAC token scheme
                # (separate namespace so a refund token cannot approve
                # a device), same one-shot replay protection.
                #
                # Super Admin isn't in the showroom; from the inbox they
                # can approve a known device without opening the admin
                # panel at all. Sent fire-and-forget so a slow email
                # provider can't make the login itself slower.
                import asyncio as _asyncio_da
                async def _email_device_approval_request():
                    try:
                        from services.email import send_super_admin_alert, COMPANY_WEBSITE
                        # Build BOTH magic links — embedded directly in
                        # the email body so the admin acts in one click.
                        approve_token = _sign_device_approval_token(approval_request["id"], "approve")
                        deny_token = _sign_device_approval_token(approval_request["id"], "deny")
                        approve_url = (
                            f"{COMPANY_WEBSITE.rstrip('/')}"
                            f"/api/device-approvals/{approval_request['id']}/approve?token={approve_token}"
                        )
                        deny_url = (
                            f"{COMPANY_WEBSITE.rstrip('/')}"
                            f"/api/device-approvals/{approval_request['id']}/deny?token={deny_token}"
                        )
                        await send_super_admin_alert(
                            title="New device requesting login",
                            summary=(
                                f"A new device is trying to sign in as "
                                f"<strong>{user.get('name') or input.email}</strong>. "
                                f"Click <strong>Approve</strong> only if you recognise "
                                f"both the user AND the device + IP below. Otherwise click "
                                f"<strong>Deny</strong> and ask them to reset their password."
                            ),
                            fields=[
                                ("User", f"<strong>{user.get('name') or '—'}</strong><br><span style='color:#737373;font-size:12px;'>{input.email} · {user.get('role') or '—'}</span>"),
                                ("Device", input.device_name or "Unknown Device"),
                                ("Device type", input.device_type or "unknown"),
                                ("IP address", approval_request.get("ip_address") or "—"),
                                ("Requested at", approval_request["requested_at"]),
                                ("Request ref", f"<code>{approval_request['id']}</code>"),
                                # ── One-click action buttons ──
                                ("Action", (
                                    f'<a href="{approve_url}" '
                                    f'style="display:inline-block;padding:11px 22px;background:#15803d;'
                                    f'color:#fff;text-decoration:none;border-radius:8px;font-weight:600;'
                                    f'font-size:14px;margin-right:8px;">✓ Approve device</a>'
                                    f'<a href="{deny_url}" '
                                    f'style="display:inline-block;padding:11px 22px;background:#b91c1c;'
                                    f'color:#fff;text-decoration:none;border-radius:8px;font-weight:600;'
                                    f'font-size:14px;">✗ Deny</a>'
                                )),
                            ],
                            cta_label="Or review all device requests",
                            cta_path="/admin/settings#device-approvals",
                            accent_colour="#b45309",
                            icon="🔐",
                            subject_prefix="[Tile Station] Action required —",
                            footer_note=(
                                "If you do NOT recognise this device or IP, deny the request "
                                "and ask the user to reset their password — their credentials "
                                "may have been compromised."
                            ),
                        )
                    except Exception as e:
                        logging.warning(f"Device-approval email failed: {e}")
                try:
                    _asyncio_da.create_task(_email_device_approval_request())
                except RuntimeError:
                    pass
            
            raise HTTPException(
                status_code=403, 
                detail="This device is not approved for login. A request has been sent to the administrator for approval."
            )
    
    if user.get('created_at') and isinstance(user['created_at'], str):
        user['created_at'] = datetime.fromisoformat(user['created_at'])
    
    user_obj = User(**{k: v for k, v in user.items() if k != 'password'})
    token = create_access_token({"sub": user["email"], "role": user["role"]})
    
    # Log audit trail for login
    await log_audit(
        action="LOGIN",
        entity_type="auth",
        user=user,
        entity_id=user.get("id"),
        entity_name=user.get("email"),
        details=f"User '{user.get('name')}' ({user.get('role')}) logged in"
    )
    
    return TokenResponse(token=token, user=user_obj)

# Health check endpoint (no auth required)
@api_router.get("/health")
async def health_check():
    """Health check endpoint to verify the backend is ready.
    Must respond FAST — Railway's deploy healthcheck probes this and a
    hanging Mongo ping (30s server-selection default) fails the deadline."""
    try:
        await asyncio.wait_for(db.command("ping"), timeout=2)
        return {
            "status": "healthy",
            "database": "connected",
            "timestamp": datetime.now(timezone.utc).isoformat()
        }
    except Exception as e:
        return {
            "status": "unhealthy",
            "database": "disconnected",
            "error": str(e),
            "timestamp": datetime.now(timezone.utc).isoformat()
        }


# Version endpoint for deployment verification (no auth required)
@api_router.get("/version")
async def get_version():
    """
    Returns deployment version info to verify the production environment 
    is running the latest code. Use this after each deployment to confirm.
    """
    import subprocess
    
    # Get git commit info
    try:
        commit_hash = subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"], 
            cwd="/app", 
            stderr=subprocess.DEVNULL
        ).decode().strip()
    except Exception:
        commit_hash = "unknown"
    
    try:
        commit_date = subprocess.check_output(
            ["git", "log", "-1", "--format=%ci"], 
            cwd="/app", 
            stderr=subprocess.DEVNULL
        ).decode().strip()
    except Exception:
        commit_date = "unknown"
    
    return {
        "version": "1.0.0",
        "commit": commit_hash,
        "commit_date": commit_date,
        "build_timestamp": "2025-12-10T12:00:00Z",  # Update this with each major release
        "server_time": datetime.now(timezone.utc).isoformat()
    }


# ============ SEO HELPERS ============

def generate_seo_alternate_names(product_data: dict) -> List[str]:
    """
    Generate SEO alternate names from supplier product data.
    These are used for search engine indexing while keeping them hidden from customers.
    
    Collects:
    - Supplier product name
    - Supplier SKU
    - Original supplier code
    - Any keywords from the supplier name
    """
    alternate_names = []
    
    # Get supplier product name
    supplier_name = product_data.get('supplier_product_name', '')
    if supplier_name:
        alternate_names.append(supplier_name)
        # Extract key words from supplier name (remove common words)
        stop_words = {'the', 'and', 'or', 'a', 'an', 'cm', 'mm', 'x', 'for', 'with', 'in', 'on'}
        words = supplier_name.replace('/', ' ').replace('-', ' ').split()
        for word in words:
            word_clean = word.strip().lower()
            if len(word_clean) > 2 and word_clean not in stop_words and not word_clean.isdigit():
                if word_clean.title() not in alternate_names:
                    alternate_names.append(word_clean.title())
    
    # Get supplier SKU
    supplier_sku = product_data.get('supplier_sku', '')
    if supplier_sku and supplier_sku not in alternate_names:
        alternate_names.append(supplier_sku)
    
    # Get original supplier code
    original_code = product_data.get('original_supplier_code', '')
    if original_code and original_code not in alternate_names:
        alternate_names.append(original_code)
    
    # Get supplier name (company)
    supplier_company = product_data.get('supplier_name', '')
    if supplier_company and supplier_company not in alternate_names:
        alternate_names.append(supplier_company)
    
    return alternate_names


def generate_seo_meta_tags(product: dict) -> dict:
    """
    Generate SEO meta tags for a product.
    Returns a dictionary with all SEO-related data for website rendering.
    """
    # Get the display name (what customers see)
    display_name = product.get('name', '')
    
    # Get alternate names (for search indexing)
    alternate_names = product.get('seo_alternate_names', [])
    if not alternate_names:
        alternate_names = generate_seo_alternate_names(product)
    
    # Build keywords list
    keywords = [display_name]
    keywords.extend(alternate_names)
    
    # Add category
    category = product.get('category_name', product.get('category', ''))
    if category:
        keywords.append(category)
    
    # Add SEO keywords from product
    seo_keywords = product.get('seo_keywords', '')
    if seo_keywords:
        keywords.extend([k.strip() for k in seo_keywords.split(',') if k.strip()])
    
    # Add material, finish, size
    if product.get('material'):
        keywords.append(product['material'])
    if product.get('finish'):
        keywords.append(product['finish'])
    if product.get('size'):
        keywords.append(product['size'])
    
    # Remove duplicates while preserving order
    seen = set()
    unique_keywords = []
    for k in keywords:
        k_lower = k.lower() if isinstance(k, str) else str(k).lower()
        if k_lower not in seen and k:
            seen.add(k_lower)
            unique_keywords.append(k)
    
    # Generate description
    description = product.get('description', '')
    if not description:
        description = f"{display_name} - Quality tiles from Tile Station. {category} available for delivery."
    
    # Schema.org Product markup
    schema_markup = {
        "@context": "https://schema.org",
        "@type": "Product",
        "name": display_name,
        "description": description[:160] if description else "",
        "sku": product.get('sku', ''),
        "brand": {
            "@type": "Brand",
            "name": "Tile Station"
        },
        "offers": {
            "@type": "Offer",
            "price": product.get('price', 0),
            "priceCurrency": "GBP",
            "availability": "https://schema.org/InStock" if product.get('stock', 0) > 0 else "https://schema.org/OutOfStock"
        }
    }
    
    # Add alternate names for SEO (search engines index these)
    if alternate_names:
        schema_markup["alternateName"] = alternate_names
    
    # Add images
    if product.get('images'):
        schema_markup["image"] = product['images']
    
    return {
        "title": f"{display_name} | Tile Station",
        "meta_description": description[:160] if description else f"Buy {display_name} from Tile Station",
        "meta_keywords": ", ".join(unique_keywords),
        "canonical_url": f"/products/{product.get('id', '')}",
        "og_title": display_name,
        "og_description": description[:200] if description else "",
        "og_image": product.get('images', [None])[0],
        "schema_markup": schema_markup,
        "alternate_names": alternate_names,  # For hidden SEO text
        "hidden_seo_text": f"Also known as: {', '.join(alternate_names)}" if alternate_names else ""
    }


# Trash/Deleted Documents API
@api_router.get("/trash")
async def get_all_deleted_documents(current_user: dict = Depends(get_current_user)):
    """Get all deleted documents from trash (Super Admin only)"""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Only Super Admin can view trash")
    
    deleted_docs = {
        "invoices": [],
        "quotations": [],
        "cash_quotations": [],
        "refunds": [],
        "credit_notes": [],
        "total_count": 0
    }
    
    # Get deleted documents from each collection
    collections = [
        ("invoices", "invoice_no"),
        ("quotations", "quotation_no"),
        ("cash_quotations", "quotation_no"),
        ("refunds", "refund_no"),
        ("credit_notes", "credit_note_no")
    ]
    
    for collection_name, doc_no_field in collections:
        collection = db[collection_name]
        docs = await collection.find(
            {"deleted_at": {"$exists": True}},
            {"_id": 0}
        ).sort("deleted_at", -1).to_list(1000)
        
        # Add days remaining and document type info
        for doc in docs:
            deleted_at = datetime.fromisoformat(doc["deleted_at"].replace("Z", "+00:00"))
            days_elapsed = (datetime.now(timezone.utc) - deleted_at).days
            doc["days_remaining"] = max(0, 30 - days_elapsed)
            doc["document_type"] = collection_name
            doc["document_no"] = doc.get(doc_no_field, "N/A")
        
        deleted_docs[collection_name] = docs
        deleted_docs["total_count"] += len(docs)
    
    return deleted_docs


@api_router.post("/trash/cleanup")
async def cleanup_old_deleted_documents(current_user: dict = Depends(get_current_user)):
    """Manually trigger cleanup of documents deleted more than 30 days ago (Super Admin only)"""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Only Super Admin can trigger cleanup")
    
    cutoff_date = datetime.now(timezone.utc) - timedelta(days=30)
    deleted_counts = {}
    
    collections = ["invoices", "quotations", "cash_quotations", "refunds", "credit_notes"]
    
    for collection_name in collections:
        collection = db[collection_name]
        # Find documents deleted more than 30 days ago
        old_deleted = await collection.find({
            "deleted_at": {"$exists": True, "$lt": cutoff_date.isoformat()}
        }).to_list(None)
        
        # Permanently delete them
        if old_deleted:
            result = await collection.delete_many({
                "deleted_at": {"$exists": True, "$lt": cutoff_date.isoformat()}
            })
            deleted_counts[collection_name] = result.deleted_count
        else:
            deleted_counts[collection_name] = 0
    
    # Log audit
    await log_audit(
        action="TRASH_CLEANUP",
        entity_type="system",
        user=current_user,
        details=f"Manual trash cleanup performed. Deleted counts: {deleted_counts}"
    )
    
    return {
        "message": "Trash cleanup completed",
        "deleted_counts": deleted_counts,
        "total_deleted": sum(deleted_counts.values())
    }

@api_router.get("/auth/me", response_model=User)
async def get_me(current_user: dict = Depends(get_current_user)):
    created_at = current_user.get('created_at')
    if isinstance(created_at, str):
        current_user['created_at'] = datetime.fromisoformat(created_at)
    elif created_at is None:
        current_user['created_at'] = datetime.now(timezone.utc)
    return User(**{k: v for k, v in current_user.items() if k != 'password'})


@api_router.post("/auth/refresh-token", response_model=TokenResponse)
async def refresh_token(current_user: dict = Depends(get_current_user)):
    """Refresh the access token - returns a new token with extended expiry.
    Call this endpoint periodically to keep the session alive."""
    new_token = create_access_token({"sub": current_user["email"], "role": current_user.get("role", "customer")})
    
    created_at = current_user.get('created_at')
    if isinstance(created_at, str):
        created_at = datetime.fromisoformat(created_at)
    elif created_at is None:
        created_at = datetime.now(timezone.utc)
    
    user_response = User(
        id=current_user.get("id", str(current_user.get("_id", ""))),
        email=current_user["email"],
        name=current_user.get("name", ""),
        phone=current_user.get("phone", ""),
        role=current_user.get("role", "customer"),
        permissions=current_user.get("permissions", []),
        showroom_id=current_user.get("showroom_id"),
        showroom_name=current_user.get("showroom_name"),
        created_at=created_at
    )
    
    return TokenResponse(token=new_token, user=user_response)


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


@api_router.post("/auth/change-password")
async def change_password(data: ChangePasswordRequest, current_user: dict = Depends(get_current_user)):
    """Change user's password - Super Admin only"""
    # Only Super Admin can change passwords
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Only Super Admin can change passwords")
    
    # Get user with password from database
    user = await db.users.find_one({"email": current_user["email"]})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    
    # Verify current password
    if not verify_password(data.current_password, user["password"]):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    
    # Validate new password
    if len(data.new_password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")
    
    # Hash new password and update
    new_hashed_password = hash_password(data.new_password)
    await db.users.update_one(
        {"email": current_user["email"]},
        {"$set": {"password": new_hashed_password}}
    )
    
    # Log audit
    await log_audit(
        action="UPDATE",
        entity_type="auth",
        user=current_user,
        entity_id=current_user.get("id", current_user["email"]),
        entity_name=current_user["email"],
        details="Password changed"
    )
    
    return {"message": "Password changed successfully"}


# Device Approval Endpoints
@api_router.get("/device-approvals")
async def get_device_approvals(current_user: dict = Depends(get_current_user)):
    """Get all pending device approval requests - Super Admin only"""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Only Super Admin can view device approvals")
    
    approvals = await db.device_approvals.find(
        {"status": "pending"},
        {"_id": 0}
    ).sort("requested_at", -1).to_list(100)
    
    return approvals


@api_router.post("/device-approvals/{approval_id}/approve")
async def approve_device(approval_id: str, current_user: dict = Depends(get_current_user)):
    """Approve a device login request - Super Admin only"""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Only Super Admin can approve devices")
    
    approval = await db.device_approvals.find_one({"id": approval_id})
    if not approval:
        raise HTTPException(status_code=404, detail="Approval request not found")
    
    if approval["status"] != "pending":
        raise HTTPException(status_code=400, detail="This request has already been processed")
    
    # Add device to approved devices
    approved_device = {
        "id": str(uuid.uuid4()),
        "user_email": approval["user_email"],
        "device_id": approval["device_id"],
        "device_name": approval["device_name"],
        "device_type": approval["device_type"],
        "approved_by": current_user["email"],
        "approved_at": datetime.now(timezone.utc).isoformat()
    }
    await db.approved_devices.insert_one(approved_device)
    
    # Update approval status
    await db.device_approvals.update_one(
        {"id": approval_id},
        {"$set": {
            "status": "approved",
            "processed_by": current_user["email"],
            "processed_at": datetime.now(timezone.utc).isoformat()
        }}
    )
    
    # Log audit
    await log_audit(
        action="DEVICE_APPROVED",
        entity_type="auth",
        user=current_user,
        entity_id=approval_id,
        entity_name=approval["user_email"],
        details=f"Device '{approval['device_name']}' approved for {approval['user_email']}"
    )
    
    return {"message": f"Device approved for {approval['user_email']}"}


@api_router.post("/device-approvals/{approval_id}/reject")
async def reject_device(approval_id: str, current_user: dict = Depends(get_current_user)):
    """Reject a device login request - Super Admin only"""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Only Super Admin can reject devices")
    
    approval = await db.device_approvals.find_one({"id": approval_id})
    if not approval:
        raise HTTPException(status_code=404, detail="Approval request not found")
    
    if approval["status"] != "pending":
        raise HTTPException(status_code=400, detail="This request has already been processed")
    
    # Update approval status
    await db.device_approvals.update_one(
        {"id": approval_id},
        {"$set": {
            "status": "rejected",
            "processed_by": current_user["email"],
            "processed_at": datetime.now(timezone.utc).isoformat()
        }}
    )
    
    # Log audit
    await log_audit(
        action="DEVICE_REJECTED",
        entity_type="auth",
        user=current_user,
        entity_id=approval_id,
        entity_name=approval["user_email"],
        details=f"Device '{approval['device_name']}' rejected for {approval['user_email']}"
    )
    
    return {"message": f"Device rejected for {approval['user_email']}"}


# ─── Magic-link device approval endpoints ────────────────────────────
# Same HMAC pattern as refunds (see backend/routes/refunds.py). These
# endpoints are PUBLIC — token gates access. Anyone with a valid token
# in the URL can act (the whole point of email magic links). Replay
# protection comes from the approval doc's `status` field flipping
# from `pending` to `approved`/`rejected` on first use.

def _sign_device_approval_token(approval_id: str, action: str) -> str:
    """HMAC-SHA256 over `device_approval:{id}:{action}` — distinct from
    the refund token namespace so a leaked refund token can't approve
    a device (and vice-versa)."""
    import hmac as _hmac
    import hashlib as _hashlib
    secret = os.environ.get("JWT_SECRET", "your-secret-key-change-in-production")
    msg = f"device_approval:{approval_id}:{action}".encode()
    return _hmac.new(secret.encode(), msg, _hashlib.sha256).hexdigest()[:32]


def _verify_device_approval_token(approval_id: str, action: str, token: str) -> bool:
    import hmac as _hmac
    expected = _sign_device_approval_token(approval_id, action)
    return _hmac.compare_digest(expected, token or "")


def _device_result_page(*, success: bool, title: str, message: str, secondary: str = "") -> HTMLResponse:
    """Self-contained HTML response page for device-approval magic links.

    Mirrors the refund-approval result page (`backend/routes/refunds.py`
    `_approval_result_page`) so both flows feel consistent in the inbox.
    """
    colour = "#15803d" if success else "#b91c1c"
    icon = "✓" if success else "✗"
    return HTMLResponse(content=f"""\
<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>{title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f5f5f4;color:#111;margin:0;padding:48px 16px;}}.card{{max-width:480px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:32px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.04)}}.icon{{width:64px;height:64px;border-radius:50%;background:{colour};color:#fff;font-size:36px;line-height:64px;margin:0 auto 18px;}}h1{{font-size:22px;margin:0 0 8px;color:{colour}}}p{{font-size:15px;line-height:1.5;color:#374151;margin:0 0 14px}}a.btn{{display:inline-block;margin-top:18px;padding:11px 22px;background:#111;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px}}small{{color:#737373;font-size:12px;display:block;margin-top:14px}}</style>
</head><body><div class="card">
<div class="icon">{icon}</div>
<h1>{title}</h1>
<p>{message}</p>
{f'<p style="color:#737373;font-size:13px;">{secondary}</p>' if secondary else ''}
<a class="btn" href="/admin/settings#device-approvals">Open Device Approvals</a>
<small>Tile Station Admin — this is an automated response page.</small>
</div></body></html>""")


@api_router.get("/device-approvals/{approval_id}/{action}", response_class=HTMLResponse)
async def device_approval_magic_link(approval_id: str, action: str, request: Request):
    """One-click Approve / Deny for a device login request, via email.

    No auth header required — the HMAC token in the URL IS the auth.
    Idempotent: re-clicking the same link shows an "already done" page
    instead of failing or duplicating side effects.
    """
    if action not in ("approve", "deny"):
        return _device_result_page(
            success=False,
            title="Invalid action",
            message="The link in your email is malformed. Please open the admin panel to act manually.",
        )

    token = (request.query_params.get("token") or "").strip()
    if not _verify_device_approval_token(approval_id, action, token):
        return _device_result_page(
            success=False,
            title="Invalid or tampered link",
            message="This approval link is not valid. It may have been copied incorrectly, expired, or been altered.",
        )

    approval = await db.device_approvals.find_one({"id": approval_id})
    if not approval:
        return _device_result_page(
            success=False,
            title="Request not found",
            message="This device-approval request no longer exists. The user may have already retried and a fresh one is in your inbox.",
        )

    # Re-click protection
    if approval.get("status") != "pending":
        already = approval.get("status")
        is_ok = already == "approved"
        return _device_result_page(
            success=is_ok,
            title=f"Already {already}",
            message=(
                f"This device request has already been {already} (on "
                f"{approval.get('processed_at') or '—'})."
            ),
            secondary=f"Decided by: {approval.get('processed_by') or '—'}",
        )

    # Token doesn't carry an identity (only super admins receive the
    # email, so we record "<via magic link>" as the approver). If you
    # later want a real email here, sign a longer token that includes
    # the recipient's address.
    approver_email = "super_admin@magic-link"
    decided_at = datetime.now(timezone.utc).isoformat()

    if action == "deny":
        await db.device_approvals.update_one(
            {"id": approval_id},
            {"$set": {
                "status": "rejected",
                "processed_by": approver_email,
                "processed_at": decided_at,
            }},
        )
        await log_audit(
            action="DEVICE_REJECTED",
            entity_type="auth",
            user={"email": approver_email, "name": "Super Admin (magic link)"},
            entity_id=approval_id,
            entity_name=approval["user_email"],
            details=(
                f"Device '{approval.get('device_name') or '—'}' DENIED for "
                f"{approval['user_email']} via email magic link"
            ),
        )
        return _device_result_page(
            success=False,
            title="Device denied",
            message=(
                f"The login request from {approval.get('device_name') or 'this device'} "
                f"for <strong>{approval['user_email']}</strong> has been denied. "
                f"They will see a 'denied' message on their device."
            ),
            secondary="If you suspect their credentials are compromised, ask them to reset their password.",
        )

    # action == "approve"
    approved_device = {
        "id": str(uuid.uuid4()),
        "user_email": approval["user_email"],
        "device_id": approval["device_id"],
        "device_name": approval.get("device_name"),
        "device_type": approval.get("device_type"),
        "approved_by": approver_email,
        "approved_at": decided_at,
    }
    await db.approved_devices.insert_one(approved_device)

    await db.device_approvals.update_one(
        {"id": approval_id},
        {"$set": {
            "status": "approved",
            "processed_by": approver_email,
            "processed_at": decided_at,
        }},
    )
    await log_audit(
        action="DEVICE_APPROVED",
        entity_type="auth",
        user={"email": approver_email, "name": "Super Admin (magic link)"},
        entity_id=approval_id,
        entity_name=approval["user_email"],
        details=(
            f"Device '{approval.get('device_name') or '—'}' approved for "
            f"{approval['user_email']} via email magic link"
        ),
    )

    return _device_result_page(
        success=True,
        title="Device approved",
        message=(
            f"<strong>{approval['user_email']}</strong> can now sign in from "
            f"{approval.get('device_name') or 'this device'}. They may need to "
            f"refresh their login page."
        ),
        secondary=f"Approved at {decided_at}",
    )





@api_router.get("/approved-devices")
async def get_approved_devices(current_user: dict = Depends(get_current_user)):
    """Get all approved devices - Super Admin sees all, others see their own"""
    if current_user.get("role") == "super_admin":
        devices = await db.approved_devices.find({}, {"_id": 0}).to_list(1000)
    else:
        devices = await db.approved_devices.find(
            {"user_email": current_user["email"]},
            {"_id": 0}
        ).to_list(100)
    
    return devices


@api_router.delete("/approved-devices/{device_id}")
async def revoke_device(device_id: str, current_user: dict = Depends(get_current_user)):
    """Revoke an approved device - Super Admin only"""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Only Super Admin can revoke devices")
    
    device = await db.approved_devices.find_one({"id": device_id})
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    
    await db.approved_devices.delete_one({"id": device_id})
    
    # Log audit
    await log_audit(
        action="DEVICE_REVOKED",
        entity_type="auth",
        user=current_user,
        entity_id=device_id,
        entity_name=device["user_email"],
        details=f"Device '{device['device_name']}' revoked for {device['user_email']}"
    )
    
    return {"message": "Device access revoked"}


# Password Reset Models
class ForgotPasswordRequest(BaseModel):
    email: str

class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str


@api_router.post("/auth/forgot-password")
async def forgot_password(data: ForgotPasswordRequest):
    """Request a password reset — works for staff (`users`) AND storefront /
    trade customers (`shop_customers`). Always answers 200 to avoid enumeration."""
    from services.password_links import (find_account, create_password_link,
                                         send_password_link_email, normalize_email)
    generic = {"message": "If an account exists with this email, you will receive a password reset link."}
    email = normalize_email(data.email)
    if not email or "@" not in email:
        return generic

    account_type, account = await find_account(db, email)
    if not account:
        return generic

    is_trade = bool(account.get("is_trade") or account.get("trade_account_status") == "approved")
    link = await create_password_link(
        db, email=account.get("email") or email, account_type=account_type,
        account_id=account.get("id"), is_trade=is_trade, purpose="reset", hours=1)
    asyncio.create_task(send_password_link_email(
        to=account.get("email") or email, name=account.get("name") or "", link=link["link"],
        purpose="reset", is_trade=is_trade,
        trade_account_number=account.get("trade_account_number") or "", hours=1))
    return generic


async def _load_valid_reset_record(token: str) -> dict:
    reset_record = await db.password_resets.find_one({"token": token})
    if not reset_record:
        raise HTTPException(status_code=400, detail="Invalid or expired reset token")
    expires_at = datetime.fromisoformat(reset_record["expires_at"].replace('Z', '+00:00'))
    if datetime.now(timezone.utc) > expires_at:
        await db.password_resets.delete_one({"token": token})
        raise HTTPException(status_code=400, detail="Reset token has expired. Please request a new one.")
    return reset_record


@api_router.post("/auth/reset-password")
async def reset_password(data: ResetPasswordRequest):
    """Set a new password from an emailed link. Staff tokens update `users`;
    customer tokens update `shop_customers` and hand back a storefront session
    so the customer lands straight in their account."""
    from services.password_links import email_query, login_path_for
    reset_record = await _load_valid_reset_record(data.token)

    if len(data.new_password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")

    account_type = reset_record.get("account_type") or "staff"
    collection = db.shop_customers if account_type == "shop" else db.users
    new_hashed_password = hash_password(data.new_password)
    result = await collection.update_one(
        email_query(reset_record["email"]),
        {"$set": {"password": new_hashed_password,
                  "password_set_at": datetime.now(timezone.utc).isoformat()}}
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="User not found")

    await db.password_resets.delete_one({"token": data.token})

    account = await collection.find_one(email_query(reset_record["email"]), {"_id": 0, "password": 0})
    is_trade = bool(account and (account.get("is_trade") or account.get("trade_account_status") == "approved"))
    response = {
        "message": "Password set successfully. You can now log in with your new password.",
        "account_type": account_type,
        "is_trade": is_trade,
        "login_path": login_path_for(account_type, is_trade),
        "purpose": reset_record.get("purpose") or "reset",
    }

    if account_type == "staff" and account:
        await log_audit(
            action="UPDATE",
            entity_type="auth",
            user=account,
            entity_id=account.get("id", reset_record["email"]),
            entity_name=reset_record["email"],
            details="Password reset via email link"
        )
    elif account:
        response["token"] = create_access_token({"sub": account["email"], "type": "shop_customer"})
        response["customer"] = {
            "id": account.get("id"),
            "email": account.get("email"),
            "name": account.get("name", ""),
            "phone": account.get("phone", ""),
            "address": account.get("address", {}),
            "is_trade": is_trade,
            "trade_discount": account.get("trade_discount", 0),
            "trade_tier": account.get("trade_tier", ""),
            "trade_account_number": account.get("trade_account_number", ""),
            "credit_balance": account.get("credit_balance", 0),
            "business_name": account.get("business_name", ""),
        }
    return response


@api_router.get("/auth/verify-reset-token")
async def verify_reset_token(token: str):
    """Verify a reset/setup token and tell the page which login it belongs to."""
    from services.password_links import login_path_for
    reset_record = await _load_valid_reset_record(token)
    account_type = reset_record.get("account_type") or "staff"
    is_trade = bool(reset_record.get("is_trade"))
    return {
        "valid": True,
        "email": reset_record["email"],
        "account_type": account_type,
        "is_trade": is_trade,
        "purpose": reset_record.get("purpose") or "reset",
        "login_path": login_path_for(account_type, is_trade),
    }


@api_router.post("/categories", response_model=Category)
async def create_category(input: CategoryCreate, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super Admin access required")
    
    from uuid import uuid4
    category_id = str(uuid4())
    category_dict = {
        "id": category_id,
        "name": input.name,
        "description": input.description,
        "created_at": datetime.now(timezone.utc).isoformat()
    }
    
    await db.categories.insert_one(category_dict)
    
    # Audit log
    await log_audit(
        action="CREATE",
        entity_type="category",
        user=current_user,
        entity_id=category_id,
        entity_name=input.name,
        after_data={"name": input.name, "description": input.description},
        details=f"Category created: {input.name}"
    )
    
    if 'created_at' in category_dict and isinstance(category_dict['created_at'], str):
        category_dict['created_at'] = datetime.fromisoformat(category_dict['created_at'])
    elif 'created_at' not in category_dict:
        category_dict['created_at'] = datetime.now(timezone.utc)
    return Category(**category_dict)

@api_router.get("/categories", response_model=List[Category])
async def get_categories(
    current_user: dict = Depends(get_current_user),
    limit: int = 500,
    skip: int = 0
):
    # Reasonable limit for categories (typically not many)
    max_limit = min(limit, 1000)
    categories = await db.categories.find({}, {"_id": 0}).skip(skip).limit(max_limit).to_list(max_limit)
    for cat in categories:
        if 'created_at' in cat and isinstance(cat['created_at'], str):
            cat['created_at'] = datetime.fromisoformat(cat['created_at'])
        elif 'created_at' not in cat:
            cat['created_at'] = datetime.now(timezone.utc)
    return categories

# ============ IMAGE UPLOAD ENDPOINT ============

@api_router.post("/upload-image")
async def upload_image(file: UploadFile = File(...), current_user: dict = Depends(get_current_user)):
    """Upload an image file to Cloudflare R2 storage (with local fallback)"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    # Validate file type
    allowed_types = ["image/jpeg", "image/png", "image/gif", "image/webp"]
    if file.content_type not in allowed_types:
        raise HTTPException(status_code=400, detail="Invalid file type. Allowed: JPEG, PNG, GIF, WEBP")
    
    # Validate file size (max 10MB)
    MAX_SIZE = 10 * 1024 * 1024  # 10MB
    contents = await file.read()
    if len(contents) > MAX_SIZE:
        raise HTTPException(status_code=400, detail="File too large. Maximum size is 10MB")
    
    # Generate unique filename
    ext = Path(file.filename).suffix.lower() if file.filename else ".jpg"
    if ext not in [".jpg", ".jpeg", ".png", ".gif", ".webp"]:
        ext = ".jpg"
    unique_filename = f"{uuid.uuid4()}{ext}"
    
    # Try to upload to R2 first
    try:
        from services.storage.r2_uploader import R2ImageUploader, optimize_image, upload_to_r2
        
        if R2ImageUploader.is_configured():
            # Optimize the image before upload
            optimized_contents = optimize_image(contents)
            
            # Upload to R2
            r2_key = f"uploads/{unique_filename}"
            r2_url = upload_to_r2(optimized_contents, r2_key)
            
            if r2_url:
                logger.info(f"Image uploaded to R2: {r2_url}")
                return {"url": r2_url, "filename": unique_filename, "storage": "r2"}
    except Exception as e:
        logger.error(f"R2 upload failed: {e}")
    
    raise HTTPException(status_code=503, detail="Cloud image storage is unavailable. Please try again shortly.")

@api_router.post("/products", response_model=Product)
async def create_product(input: ProductCreate, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super Admin access required")
    
    from uuid import uuid4
    product_id = str(uuid4())
    
    category_name = None
    if input.category_id:
        category = await db.categories.find_one({"id": input.category_id}, {"_id": 0})
        if category:
            category_name = category["name"]
    
    # Calculate m² per piece from tile dimensions (cm to m²)
    tile_m2_per_piece = None
    if input.tile_width and input.tile_height:
        # Convert cm to meters and calculate area
        tile_m2_per_piece = (input.tile_width / 100) * (input.tile_height / 100)
    
    # Calculate box m² coverage
    box_m2_coverage = None
    if tile_m2_per_piece and input.tiles_per_box:
        box_m2_coverage = round(tile_m2_per_piece * input.tiles_per_box, 3)
    
    now = datetime.now(timezone.utc)
    product_dict = {
        "id": product_id,
        "name": input.name,
        "sku": input.sku,
        "description": input.description,
        "category_id": input.category_id,
        "category_name": category_name,
        "stock": input.stock,
        "m2_quantity": input.m2_quantity,
        # Tile size fields
        "tile_width": input.tile_width,
        "tile_height": input.tile_height,
        "tile_m2_per_piece": tile_m2_per_piece,
        # Box configuration
        "tiles_per_box": input.tiles_per_box,
        "box_m2_coverage": box_m2_coverage,
        "price": input.price,
        "cost": input.cost,  # Cost price for profit calculation
        # Room lot pricing
        "room_lot_enabled": input.room_lot_enabled,
        "room_lot_quantity": input.room_lot_quantity,
        "room_lot_price": input.room_lot_price,
        # Pallet pricing
        "pallet_enabled": input.pallet_enabled,
        "pallet_quantity": input.pallet_quantity,
        "pallet_price": input.pallet_price,
        # Clearance
        "clearance": input.clearance,
        "clearance_price": input.clearance_price,
        "max_discount": input.max_discount,
        "reorder_level": input.reorder_level,
        "images": input.images if input.images else [],
        "created_at": now.isoformat(),
        "updated_at": now.isoformat()
    }
    
    await db.products.insert_one(product_dict)
    
    # Log audit trail
    await log_audit(
        action="CREATE",
        entity_type="product",
        user=current_user,
        entity_id=product_id,
        entity_name=input.name,
        after_data={
            "name": input.name,
            "sku": input.sku,
            "price": input.price,
            "cost": input.cost,
            "stock": input.stock,
            "category": category_name
        },
        details=f"Product '{input.name}' (SKU: {input.sku}) created"
    )
    
    if 'created_at' in product_dict and isinstance(product_dict['created_at'], str):
        product_dict['created_at'] = datetime.fromisoformat(product_dict['created_at'])
    elif 'created_at' not in product_dict:
        product_dict['created_at'] = datetime.now(timezone.utc)
    if 'updated_at' in product_dict and isinstance(product_dict['updated_at'], str):
        product_dict['updated_at'] = datetime.fromisoformat(product_dict['updated_at'])
    elif 'updated_at' not in product_dict:
        product_dict['updated_at'] = datetime.now(timezone.utc)
    return Product(**product_dict)

@api_router.get("/products")
async def get_products(
    search: Optional[str] = None,
    category_id: Optional[str] = None,
    low_stock: Optional[bool] = None,
    limit: int = 5000,
    skip: int = 0,
    current_user: dict = Depends(get_current_user)
):
    try:
        query = {}
        if search:
            query["$or"] = [
                {"name": {"$regex": search, "$options": "i"}},
                {"sku": {"$regex": search, "$options": "i"}}
            ]
        if category_id:
            query["category_id"] = category_id
        
        # Use reasonable limit with pagination support
        max_limit = min(limit, 5000) if limit else 5000
        products = await db.products.find(query, {"_id": 0}).skip(skip).limit(max_limit).to_list(max_limit)
        
        # Hide cost field for non-super-admin users
        is_super_admin = current_user.get("role") == "super_admin"
        
        for prod in products:
            if 'created_at' in prod and isinstance(prod['created_at'], str):
                try:
                    prod['created_at'] = datetime.fromisoformat(prod['created_at'])
                except (ValueError, TypeError):
                    prod['created_at'] = datetime.now(timezone.utc)
            if 'updated_at' in prod and isinstance(prod['updated_at'], str):
                try:
                    prod['updated_at'] = datetime.fromisoformat(prod['updated_at'])
                except (ValueError, TypeError):
                    prod['updated_at'] = datetime.now(timezone.utc)
            # Remove cost for non-super-admin
            if not is_super_admin:
                prod['cost'] = None
        
        if low_stock:
            products = [p for p in products if (p.get('stock') or 0) <= (p.get('reorder_level') or 10)]
        
        return products
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        logger.error(f"get_products crash: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Failed to load products: {str(e)}")


# SEO Endpoint - Get SEO metadata for a product (public, for website)
@api_router.get("/products/{product_id}/seo")
async def get_product_seo(product_id: str):
    """
    Get SEO metadata for a product. This endpoint is PUBLIC (no auth required)
    as it's used by the e-commerce website for meta tags and structured data.
    
    Returns:
    - title, meta_description, meta_keywords
    - Schema.org Product markup with alternateName (for supplier name SEO)
    - Hidden SEO text (alternate names that search engines index but customers don't see)
    """
    from bson import ObjectId
    
    # Try to find by ObjectId first
    product = None
    try:
        product = await db.products.find_one({"_id": ObjectId(product_id)}, {"_id": 0})
    except Exception:
        pass
    
    # Fallback to finding by 'id' field
    if not product:
        product = await db.products.find_one({"id": product_id}, {"_id": 0})
    
    # Try by SKU
    if not product:
        product = await db.products.find_one({"sku": product_id}, {"_id": 0})
    
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    
    # Generate SEO metadata
    seo_data = generate_seo_meta_tags(product)
    
    return seo_data


# Bulk SEO endpoint for sitemap generation
@api_router.get("/products/seo/all")
async def get_all_products_seo():
    """
    Get SEO metadata for all products. Used for sitemap generation
    and bulk meta tag preparation. PUBLIC endpoint.
    """
    products = await db.products.find(
        {"show_on_website": True},
        {"_id": 0, "id": 1, "name": 1, "sku": 1, "supplier_product_name": 1, 
         "supplier_sku": 1, "category_name": 1, "description": 1, "price": 1, 
         "stock": 1, "images": 1, "seo_keywords": 1, "seo_alternate_names": 1,
         "material": 1, "finish": 1, "size": 1}
    ).to_list(10000)
    
    seo_list = []
    for product in products:
        seo_data = generate_seo_meta_tags(product)
        seo_data["product_id"] = product.get("id", "")
        seo_data["product_name"] = product.get("name", "")
        seo_list.append(seo_data)
    
    return {"products": seo_list, "count": len(seo_list)}


# Update product to regenerate SEO alternate names
@api_router.post("/products/{product_id}/regenerate-seo")
async def regenerate_product_seo(product_id: str, current_user: dict = Depends(get_current_user)):
    """
    Regenerate SEO alternate names for a product based on its supplier data.
    """
    from bson import ObjectId
    
    # Find the product
    product = None
    query_field = None
    try:
        product = await db.products.find_one({"_id": ObjectId(product_id)})
        if product:
            query_field = {"_id": ObjectId(product_id)}
    except Exception:
        pass
    
    if not product:
        product = await db.products.find_one({"id": product_id})
        if product:
            query_field = {"id": product_id}
    
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    
    # Generate new SEO alternate names
    alternate_names = generate_seo_alternate_names(product)
    
    # Update the product
    await db.products.update_one(
        query_field,
        {"$set": {"seo_alternate_names": alternate_names, "updated_at": datetime.now(timezone.utc).isoformat()}}
    )
    
    return {
        "success": True,
        "product_id": product_id,
        "seo_alternate_names": alternate_names
    }


# Bulk regenerate SEO for all products
@api_router.post("/products/regenerate-seo/all")
async def regenerate_all_products_seo(current_user: dict = Depends(get_current_user)):
    """
    Regenerate SEO alternate names for ALL products.
    Useful after importing products or updating supplier data.
    """
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super Admin access required")
    
    updated_count = 0
    products = await db.products.find({}).to_list(10000)
    
    for product in products:
        alternate_names = generate_seo_alternate_names(product)
        if alternate_names:
            await db.products.update_one(
                {"id": product.get("id")},
                {"$set": {"seo_alternate_names": alternate_names}}
            )
            updated_count += 1
    
    return {
        "success": True,
        "total_products": len(products),
        "updated_count": updated_count,
        "message": f"Regenerated SEO data for {updated_count} products"
    }


@api_router.get("/products/epos/top-sellers")
async def epos_top_sellers(
    days: int = Query(90, ge=1, le=3650, description="Look-back window in days"),
    limit: int = Query(200, ge=1, le=500),
    current_user: dict = Depends(get_current_user),
):
    """Return a ranking of the most-sold SKUs across the given window. Used to
    sort the EPOS product search modal when the query is empty so staff see
    the shop's bestsellers first. Aggregates `invoices.line_items[]` and
    `shop_orders.items[]`.
    """
    from datetime import timedelta
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)

    counts: dict = {}

    # 1) Invoices — sum quantities keyed by sku on line_items.
    try:
        async for inv in db.invoices.find(
            {"created_at": {"$gte": cutoff}},
            {"line_items": 1, "_id": 0},
        ):
            for li in (inv.get("line_items") or []):
                sku = str(li.get("sku") or "").strip()
                if not sku:
                    continue
                qty = float(li.get("quantity") or 0)
                if qty <= 0:
                    continue
                counts[sku] = counts.get(sku, 0) + qty
    except Exception:
        pass

    # 2) Shop orders — items keyed by sku or product_id (which usually equals sku).
    try:
        async for so in db.shop_orders.find(
            {"created_at": {"$gte": cutoff}},
            {"items": 1, "_id": 0},
        ):
            for it in (so.get("items") or []):
                sku = str(it.get("sku") or it.get("product_id") or "").strip()
                if not sku:
                    continue
                qty = float(it.get("quantity") or 0)
                if qty <= 0:
                    continue
                counts[sku] = counts.get(sku, 0) + qty
    except Exception:
        pass

    ranked = sorted(counts.items(), key=lambda kv: -kv[1])[:limit]
    return {
        "window_days": days,
        "total_ranked": len(ranked),
        "ranking": [{"sku": sku, "units_sold": qty} for sku, qty in ranked],
    }


@api_router.get("/products/epos/search")
async def epos_product_search(
    search: str = Query(..., description="Search term"),
    current_user: dict = Depends(get_current_user)
):
    """
    EPOS-specific product search that allows searching by BOTH:
    - Internal product name (e.g., "Sparta White")
    - Original supplier product name (e.g., "Tenby White")
    
    Results always show the internal product name for customer-facing display.
    This allows staff to search using supplier terminology but display internal names.
    """
    results = []
    seen_skus = set()  # Avoid duplicates
    
    # First, search the main products collection
    product_query = {
        "$or": [
            {"name": {"$regex": search, "$options": "i"}},
            {"sku": {"$regex": search, "$options": "i"}},
            {"barcode": {"$regex": search, "$options": "i"}},
            {"supplier_product_name": {"$regex": search, "$options": "i"}}
        ]
    }
    
    products = await db.products.find(product_query, {"_id": 0}).to_list(100)
    for p in products:
        if p.get("sku") not in seen_skus:
            seen_skus.add(p.get("sku"))
            results.append({
                "id": p.get("id"),
                "name": p.get("name"),  # Always show internal name
                "sku": p.get("sku"),
                "barcode": p.get("barcode", ""),
                "price": p.get("price", 0),
                "cost_price": p.get("cost_price", 0),
                "stock": p.get("stock", 0),
                "description": p.get("description", ""),
                "supplier_name": p.get("supplier") or p.get("supplier_name", ""),
                "supplier_product_name": p.get("supplier_product_name"),  # Original name for reference
                "tile_m2_per_piece": p.get("tile_m2_per_piece"),
                "tiles_per_box": p.get("tiles_per_box"),
                "box_m2_coverage": p.get("box_m2_coverage"),
                "max_discount": p.get("max_discount"),
                "images": p.get("images", []),
                "showroom_stock": p.get("showroom_stock", {}),
                "source": "products"
            })
    
    # Then, search supplier_products by original name
    # Only include those that have a product_name (unique internal name)
    supplier_query = {
        "$or": [
            {"name": {"$regex": search, "$options": "i"}},  # Original supplier name
            {"product_name": {"$regex": search, "$options": "i"}},  # Unique internal name
            {"sku": {"$regex": search, "$options": "i"}}
        ],
        "product_name": {"$exists": True, "$ne": None}  # Must have unique name
    }
    
    supplier_products = await db.supplier_products.find(supplier_query, {"_id": 0}).to_list(100)
    for sp in supplier_products:
        sku = sp.get("sku")
        if sku and sku not in seen_skus:
            seen_skus.add(sku)
            results.append({
                "id": sp.get("products_db_id") or f"sp_{sku}",  # Use products_db_id if synced
                "name": sp.get("product_name"),  # Always show unique internal name
                "sku": sku,
                "barcode": "",
                "price": sp.get("price") or sp.get("trade_price", 0),
                "cost_price": sp.get("cost_price", 0),
                "stock": sp.get("stock_quantity", 0),
                "description": sp.get("description", ""),
                "supplier_name": sp.get("supplier", ""),
                "supplier_product_name": sp.get("name"),  # Original supplier name
                "tile_m2_per_piece": None,
                "tiles_per_box": None,
                "box_m2_coverage": None,
                "max_discount": None,
                "images": sp.get("images", []),
                "showroom_stock": {},
                "source": "supplier_products",
                "in_products_db": sp.get("in_products_db", False)
            })
    
    return {
        "products": results[:100],  # Limit results
        "total": len(results),
        "search_term": search
    }


@api_router.get("/products/{product_id}")
async def get_product(product_id: str, current_user: dict = Depends(get_current_user)):
    from bson import ObjectId
    
    # Try to find by ObjectId first (from supplier_products.products_db_id)
    product = None
    try:
        product = await db.products.find_one({"_id": ObjectId(product_id)})
        if product:
            product["id"] = str(product.pop("_id"))
    except Exception:
        pass
    
    # Fallback to finding by 'id' field (UUID format)
    if not product:
        product = await db.products.find_one({"id": product_id}, {"_id": 0})
    
    # Also try by SKU as last resort
    if not product:
        product = await db.products.find_one({"sku": product_id}, {"_id": 0})
    
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    
    if 'created_at' in product and isinstance(product['created_at'], str):
        try:
            product['created_at'] = datetime.fromisoformat(product['created_at'])
        except (ValueError, TypeError):
            product['created_at'] = datetime.now(timezone.utc)
    elif 'created_at' not in product:
        product['created_at'] = datetime.now(timezone.utc)
    if 'updated_at' in product and isinstance(product['updated_at'], str):
        try:
            product['updated_at'] = datetime.fromisoformat(product['updated_at'])
        except (ValueError, TypeError):
            product['updated_at'] = datetime.now(timezone.utc)
    elif 'updated_at' not in product:
        product['updated_at'] = datetime.now(timezone.utc)
    
    # Ensure required fields have defaults to prevent validation errors
    # Use explicit check for None since setdefault won't work if key exists with None value
    if product.get('price') is None:
        product['price'] = 0.0
    if product.get('stock') is None:
        product['stock'] = 0
    if not product.get('sku'):
        product['sku'] = product.get('id', 'UNKNOWN')
    if not product.get('name'):
        product['name'] = 'Unnamed Product'
    if product.get('reorder_level') is None:
        product['reorder_level'] = 10
    
    # Hide cost field for non-super-admin users
    is_super_admin = current_user.get("role") == "super_admin"
    if not is_super_admin:
        product['cost'] = None
    
    # Return dict directly instead of using response_model to ensure all fields are included
    # This is needed for category fields (main_category, sub_categories, rooms, styles, etc.)
    return product


# AI Description Generator
class ProductDescriptionRequest(BaseModel):
    name: str = ""
    sku: str = ""
    category: str = ""
    seo_keywords: str = ""
    material: str = ""
    finish: str = ""
    type: str = ""
    size: str = ""
    colors: List[str] = []
    suitability: str = ""
    slip_rating: str = ""
    edge: str = ""
    website_categories: dict = {}
    mode: str = "generate"  # generate, regenerate, shorter, longer
    current_description: str = ""
    # Bulk mode settings
    bulk_mode: bool = False  # When True, generate description with placeholders like {name}, {color}
    selected_count: int = 1  # Number of products being updated in bulk
    length_hint: str = "standard"  # brief, standard, long

@api_router.post("/products/generate-description")
async def generate_product_description(
    product_context: ProductDescriptionRequest,
    current_user: dict = Depends(get_current_user)
):
    """
    Generate an SEO-friendly product description using AI.
    Takes product context including name, category, keywords, specifications.
    Fetches category descriptions from the database to enrich the content.
    """
    try:
        # Check for API key - support both OPENAI_API_KEY and EMERGENT_LLM_KEY
        api_key = os.environ.get('OPENAI_API_KEY') or os.environ.get('EMERGENT_LLM_KEY')
        if not api_key:
            print("ERROR: Neither OPENAI_API_KEY nor EMERGENT_LLM_KEY environment variable is set")
            raise HTTPException(
                status_code=500, 
                detail="OpenAI API key not configured. Please set OPENAI_API_KEY environment variable."
            )
        
        # Use OpenAI directly
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=api_key)
        
        # Extract product details
        name = product_context.name or 'Tile'
        category = product_context.category or ''
        seo_keywords = product_context.seo_keywords or ''
        material = product_context.material or ''
        finish = product_context.finish or ''
        size = product_context.size or ''
        colors = product_context.colors or []
        suitability = product_context.suitability or ''
        slip_rating = product_context.slip_rating or ''
        
        # Get website categories for additional context
        website_cats = product_context.website_categories or {}
        rooms = website_cats.get('rooms', [])
        materials = website_cats.get('materials', [])
        styles = website_cats.get('styles', [])
        features = website_cats.get('features', [])
        finishes = website_cats.get('finishes', [])
        
        # Fetch category descriptions from database
        category_descriptions = []
        
        # Fetch main category description
        if category:
            main_cat = await db.website_categories.find_one(
                {"$or": [{"name": category}, {"slug": category.lower().replace(' ', '-')}]},
                {"_id": 0, "name": 1, "description": 1, "seo_description": 1}
            )
            if main_cat:
                desc = main_cat.get('seo_description') or main_cat.get('description', '')
                if desc:
                    category_descriptions.append(f"Main Category ({main_cat.get('name', category)}): {desc}")
        
        # Fetch website category descriptions (sub-categories)
        all_category_ids = rooms + materials + styles + features + finishes
        if all_category_ids:
            # Get descriptions from supplier_sync categories
            supplier_cats = await db.supplier_sync_categories.find(
                {"$or": [{"slug": {"$in": all_category_ids}}, {"name": {"$in": all_category_ids}}]},
                {"_id": 0, "name": 1, "description": 1}
            ).to_list(50)
            
            for cat in supplier_cats:
                if cat.get('description'):
                    category_descriptions.append(f"{cat.get('name', 'Category')}: {cat.get('description')}")
            
            # Also check website_categories for descriptions
            website_sub_cats = await db.website_categories.find(
                {"slug": {"$in": [c.lower().replace('_', '-') for c in all_category_ids]}},
                {"_id": 0, "name": 1, "description": 1, "seo_description": 1}
            ).to_list(50)
            
            for cat in website_sub_cats:
                desc = cat.get('seo_description') or cat.get('description', '')
                if desc and desc not in [c.split(': ', 1)[-1] for c in category_descriptions]:
                    category_descriptions.append(f"{cat.get('name', 'Sub-Category')}: {desc}")
        
        category_context = '\n'.join(category_descriptions) if category_descriptions else ''
        
        # Build context for AI
        product_details = []
        if material:
            product_details.append(f"Material: {material}")
        if finish:
            product_details.append(f"Finish: {finish}")
        if size:
            product_details.append(f"Size: {size}")
        if colors:
            product_details.append(f"Available colors: {', '.join(colors)}")
        if suitability:
            product_details.append(f"Suitable for: {suitability}")
        if slip_rating:
            product_details.append(f"Slip rating: {slip_rating}")
        
        # Add website category context (names for reference)
        if rooms:
            product_details.append(f"Room types: {', '.join(rooms)}")
        if materials:
            product_details.append(f"Material types: {', '.join(materials)}")
        if styles:
            product_details.append(f"Style/Effect: {', '.join(styles)}")
        if features:
            product_details.append(f"Features: {', '.join(features)}")
        if finishes:
            product_details.append(f"Finishes: {', '.join(finishes)}")
        
        details_text = '\n'.join(product_details) if product_details else 'No additional details provided'
        
        # Build the category content section
        category_section = ""
        if category_context:
            category_section = f"""
Category & Sub-Category Context (use this information to enrich the description):
{category_context}
"""
        
        # Get mode and current description
        mode = product_context.mode or "generate"
        current_description = product_context.current_description or ""
        bulk_mode = getattr(product_context, 'bulk_mode', False)
        selected_count = getattr(product_context, 'selected_count', 1)
        
        # Check if current description contains placeholders (for modifications)
        has_placeholders = any(p in current_description for p in ['{name}', '{color}', '{material}', '{finish}', '{size}', '{series}'])
        
        # Placeholder instruction for bulk mode
        placeholder_instruction = """
IMPORTANT: Preserve any placeholders like {name}, {color}, {material}, {finish}, {size}, {series} in the description.
These will be replaced with each product's actual values.""" if has_placeholders or (bulk_mode and selected_count > 1) else ""
        
        # Create the prompt based on mode
        if mode == "shorter":
            prompt = f"""You are given a product description that needs to be shortened while keeping the key information and SEO keywords.

Current Description:
{current_description}

Product: {name}
SEO Keywords to keep: {seo_keywords or 'tiles, quality'}
{placeholder_instruction}

Requirements:
1. Reduce the description to 1-2 short paragraphs (80-120 words)
2. Keep the most important features and benefits
3. Maintain the SEO keywords naturally
4. Keep the professional tone
5. Do NOT add new information, only condense existing content
{"6. PRESERVE all placeholders like {name}, {color}, {material}, {finish}, {size} - do not replace them with actual values" if has_placeholders else ""}

Write the shortened description now:"""

        elif mode == "longer":
            prompt = f"""You are given a product description that needs to be expanded with more detail while staying relevant.

Current Description:
{current_description}

Product: {name}
Category: {category or 'Tiles'}
Product Details:
{details_text}
{category_section}
SEO Keywords: {seo_keywords or 'tiles, quality, home improvement'}
{placeholder_instruction}

Requirements:
1. Expand the description to 3-4 paragraphs (250-350 words)
2. Add more details about features, benefits, and applications
3. Include information about installation, maintenance, or design tips
4. Incorporate more SEO keywords naturally
5. Maintain the existing tone and style
6. Do NOT repeat the same information multiple times
{"7. PRESERVE all placeholders like {name}, {color}, {material}, {finish}, {size} - do not replace them with actual values" if has_placeholders else ""}

Write the expanded description now:"""

        elif mode == "regenerate":
            if has_placeholders or (bulk_mode and selected_count > 1):
                # Regenerate with placeholders for bulk mode
                prompt = f"""Write a COMPLETELY DIFFERENT product description TEMPLATE for tiles. Take a fresh approach with different opening, structure, and emphasis.

IMPORTANT: Use these EXACT placeholders where appropriate:
- {{name}} - for the product name
- {{color}} - for the color
- {{size}} - for the size dimensions
- {{material}} - for the material type
- {{finish}} - for the finish type
- {{series}} - for the series name

Example Product (for context - use placeholders NOT this name):
Name: {name}
Category: {category or 'Tiles'}

Product Details:
{details_text}
{category_section}
SEO Keywords: {seo_keywords or 'tiles, quality, home improvement'}

Previous description (write something DIFFERENT):
{current_description}

Requirements:
1. Write 2-3 paragraphs (150-200 words)
2. Use {{name}} placeholder for the product name - DO NOT hardcode any specific name
3. Use other placeholders where natural
4. Use a DIFFERENT opening and angle than the previous description
5. Write in a professional but engaging tone
6. Do NOT start with "Introducing" or similar clichés

Write a fresh, different description template now:"""
            else:
                prompt = f"""Write a COMPLETELY DIFFERENT product description for this tile. Take a fresh approach with different opening, structure, and emphasis.

Product Name: {name}
Category: {category or 'Tiles'}

Product Details:
{details_text}
{category_section}
SEO Keywords to include: {seo_keywords or 'tiles, quality, home improvement'}

Previous description (write something DIFFERENT from this):
{current_description}

Requirements:
1. Write 2-3 paragraphs (150-200 words)
2. Use a DIFFERENT opening and angle than the previous description
3. Highlight DIFFERENT aspects or benefits
4. Use the SEO keywords naturally
5. Write in a professional but engaging tone
6. Do NOT copy phrases from the previous description
7. Do NOT start with "Introducing" or similar clichés

Write a fresh, different description now:"""

        else:  # generate (default)
            # Check if bulk_mode - generate with placeholders
            bulk_mode = getattr(product_context, 'bulk_mode', False)
            selected_count = getattr(product_context, 'selected_count', 1)
            length_hint = getattr(product_context, 'length_hint', 'standard')
            
            # Determine target word count based on length_hint
            if length_hint == 'brief':
                word_range = "50-80 words"
                para_range = "1 paragraph"
            elif length_hint == 'long':
                word_range = "250-350 words"
                para_range = "3-4 paragraphs"
            else:  # standard
                word_range = "150-200 words"
                para_range = "2-3 paragraphs"
            
            if bulk_mode and selected_count > 1:
                # BULK MODE: Generate description with placeholders
                prompt = f"""Write a compelling, SEO-friendly product description TEMPLATE for tiles. This will be applied to {selected_count} products.

IMPORTANT: Use these EXACT placeholders where appropriate (they will be replaced with each product's actual values):
- {{name}} - for the product name
- {{color}} - for the color
- {{size}} - for the size dimensions
- {{material}} - for the material type
- {{finish}} - for the finish type
- {{series}} - for the series name (if applicable)

Example Product (for context only - use placeholders, NOT this specific name):
Name: {name}
Material: {material or 'Not specified'}
Finish: {finish or 'Not specified'}
Size: {size or 'Not specified'}
Color: {colors[0] if colors else 'Not specified'}

Category: {category or 'Tiles'}
{category_section}
SEO Keywords to include (naturally): {seo_keywords or 'tiles, quality, home improvement'}

Requirements:
1. Write {para_range} ({word_range} total)
2. Use {{name}} placeholder for the product name - DO NOT hardcode "{name}"
3. Use other placeholders like {{color}}, {{material}}, {{finish}}, {{size}} where natural
4. Highlight key features and benefits
5. Write in a professional but engaging tone suitable for an e-commerce website
6. DO NOT start with "Introducing" or similar clichés
7. The description should work for any tile product when placeholders are replaced

Write the description template now:"""
            else:
                # SINGLE PRODUCT MODE: Generate specific description
                prompt = f"""Write a compelling, SEO-friendly product description for this tile:

Product Name: {name}
Category: {category or 'Tiles'}

Product Details:
{details_text}
{category_section}
SEO Keywords to include (naturally): {seo_keywords or 'tiles, quality, home improvement'}

Requirements:
1. Write {para_range} ({word_range} total)
2. Highlight key features and benefits
3. Use the SEO keywords naturally throughout
4. Incorporate relevant information from the category descriptions provided
5. Include mention of the material, finish, and suitable applications
6. Write in a professional but engaging tone suitable for an e-commerce website
7. Do NOT include any placeholder text or brackets
8. Do NOT start with "Introducing" or similar clichés

Write the description now:"""

        # Route via emergentintegrations LlmChat so the EMERGENT_LLM_KEY works through the Emergent LLM proxy
        # (calling OpenAI directly with sk-emergent-* returns 401 because it's not a real OpenAI key).
        from emergentintegrations.llm.chat import LlmChat, UserMessage
        system_message = "You are an expert copywriter specializing in tile and home improvement product descriptions. Write compelling, SEO-friendly descriptions that highlight product features and benefits."
        chat = LlmChat(
            api_key=api_key,
            session_id=f"product-desc-{uuid.uuid4()}",
            system_message=system_message,
        ).with_model("openai", "gpt-4o")

        description = await chat.send_message(UserMessage(text=prompt))

        return {
            "success": True,
            "description": description.strip(),
            "mode": mode
        }
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Failed to generate description: {str(e)}")


class SeriesDescriptionRequest(BaseModel):
    """Request model for unified series description generation"""
    series_name: Optional[str] = None
    product_skus: Optional[List[str]] = None
    seo_keywords: Optional[str] = None
    length: Optional[str] = "standard"  # brief, standard, detailed


@api_router.get("/products/missing-descriptions/count")
async def missing_descriptions_count(current_user: dict = Depends(get_current_user)):
    """How many products still need an SEO description across the three
    storefront-facing product collections? Powers the
    `Marketing & SEO → SEO` admin badges."""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")

    from services.ai_descriptions import (
        ALLOWED_PRODUCT_COLLECTIONS,
        missing_description_filter,
    )
    out = {}
    for col in ALLOWED_PRODUCT_COLLECTIONS:
        total = await db[col].count_documents({})
        missing = await db[col].count_documents(missing_description_filter())
        out[col] = {"total": total, "missing": missing, "with_description": total - missing}
    return out


@api_router.post("/products/bulk-generate-descriptions")
async def bulk_generate_product_descriptions(
    request_data: dict,
    current_user: dict = Depends(get_current_user),
):
    """Bulk-fill missing SEO descriptions across storefront product
    collections — `products`, `tiles`, or `supplier_products`.

    Thin route: all prompt-building, sibling-context, LLM-call and save
    logic lives in `services/ai_descriptions.py` (shared module — so the
    day the legacy per-product editor endpoint is migrated away from its
    direct OpenAI dependency, it calls the same helper).

    Complements (does NOT replace) the existing per-series tool in
    *Bulk Edit Categories → AI Series Description* which generates one
    description per detected series — richer, cross-referenced copy.

    Body params:
      • collection: one of `products` / `tiles` / `supplier_products`
      • limit: default 25, max 50 (keeps response under ingress timeout)
      • dry_run: preview without calling the LLM or saving
    """
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")

    from dotenv import load_dotenv
    load_dotenv()
    from services.ai_descriptions import (
        ALLOWED_PRODUCT_COLLECTIONS, generate_one, save_generated_description,
        siblings_for, product_display_name, missing_description_filter,
    )

    api_key = os.environ.get("EMERGENT_LLM_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="LLM API key not configured")

    limit = max(1, min(int(request_data.get("limit", 25)), 50))
    dry_run = bool(request_data.get("dry_run", False))
    collection = request_data.get("collection", "products")
    if collection not in ALLOWED_PRODUCT_COLLECTIONS:
        raise HTTPException(
            status_code=400,
            detail=f"collection must be one of {sorted(ALLOWED_PRODUCT_COLLECTIONS)}",
        )

    cursor = db[collection].find(missing_description_filter(), {"_id": 0}).limit(limit)
    candidates = await cursor.to_list(limit)

    if dry_run:
        return {
            "dry_run": True,
            "collection": collection,
            "would_process": len(candidates),
            "samples": [
                {
                    "id": p.get("id") or p.get("sku") or "",
                    "name": product_display_name(p),
                    "category": p.get("category", ""),
                }
                for p in candidates[:5]
            ],
        }

    if not candidates:
        remaining = await db[collection].count_documents(missing_description_filter())
        return {
            "processed": 0, "succeeded": 0, "failed": 0,
            "remaining": remaining, "collection": collection, "samples": [],
        }

    sem = asyncio.Semaphore(4)
    sibling_cache: dict = {}

    async def _one(prod):
        async with sem:
            siblings = await siblings_for(db, collection, prod, sibling_cache)
            result = await generate_one(api_key=api_key, product=prod, siblings=siblings)
            if not result["ok"]:
                return {
                    "id": prod.get("id") or prod.get("sku"),
                    "name": product_display_name(prod),
                    "ok": False, "error": result["error"],
                }
            await save_generated_description(db, collection, prod, result["description"])
            return {
                "id": prod.get("id") or prod.get("sku"),
                "name": product_display_name(prod),
                "ok": True, "preview": result["description"][:140],
            }

    results = await asyncio.gather(*[_one(p) for p in candidates])
    succeeded = sum(1 for r in results if r.get("ok"))
    failed = len(results) - succeeded
    remaining = await db[collection].count_documents(missing_description_filter())
    return {
        "processed": len(results),
        "succeeded": succeeded,
        "failed": failed,
        "remaining": remaining,
        "collection": collection,
        "samples": [r for r in results if r.get("ok")][:5],
        "errors": [r for r in results if not r.get("ok")][:5],
    }


@api_router.post("/products/generate-series-description")
async def generate_series_description(
    request_data: SeriesDescriptionRequest,
    current_user: dict = Depends(get_current_user)
):
    """
    Generate a unified, comprehensive description for an entire product series.
    This creates one description that covers ALL variants (colors, sizes, finishes)
    in the series, perfect for collection pages.
    """
    try:
        # Use emergentintegrations for Emergent LLM key
        from emergentintegrations.llm.chat import LlmChat, UserMessage
        import uuid as uuid_module
        
        api_key = os.environ.get('EMERGENT_LLM_KEY') or os.environ.get('OPENAI_API_KEY')
        if not api_key:
            raise HTTPException(status_code=500, detail="API key not configured")
        
        series_name = request_data.series_name or ''
        product_skus = request_data.product_skus or []
        seo_keywords = request_data.seo_keywords or ''
        length = request_data.length or 'standard'
        
        if not series_name and not product_skus:
            raise HTTPException(status_code=400, detail="Either series_name or product_skus must be provided")
        
        # Query products - either by SKU list or by series name
        if product_skus:
            query = {"sku": {"$in": product_skus}}
        else:
            # Match products whose name starts with series
            import re
            query = {
                "$or": [
                    {"product_name": {"$regex": f"^{re.escape(series_name)}", "$options": "i"}},
                    {"name": {"$regex": f"^{re.escape(series_name)}", "$options": "i"}},
                    {"series": {"$regex": f"^{re.escape(series_name)}", "$options": "i"}}
                ]
            }
        
        # Try supplier_products first, then tiles collection
        products = await db.supplier_products.find(query).to_list(500)
        
        if not products:
            products = await db.tiles.find(query).to_list(500)
        
        if not products:
            raise HTTPException(status_code=404, detail=f"No products found for series '{series_name}'")
        
        # Aggregate all unique attributes
        all_colors = set()
        all_sizes = set()
        all_finishes = set()
        all_materials = set()
        all_suitabilities = set()
        all_slip_ratings = set()
        all_thicknesses = set()
        all_features = set()
        all_rooms = set()
        all_styles = set()
        
        for p in products:
            color = p.get('color') or p.get('attributes', {}).get('color', '')
            if color:
                all_colors.add(color)
            
            size = p.get('size') or p.get('attributes', {}).get('size', '')
            if size:
                all_sizes.add(size)
            
            finish = p.get('finish') or p.get('attributes', {}).get('finish', '')
            if finish:
                all_finishes.add(finish)
            
            material = p.get('material') or p.get('attributes', {}).get('material', '')
            if material:
                all_materials.add(material)
            
            suitability = p.get('suitability', '')
            if suitability:
                all_suitabilities.add(suitability)
            
            slip_rating = p.get('slip_rating', '')
            if slip_rating:
                all_slip_ratings.add(slip_rating)
            
            thickness = p.get('thickness', '')
            if thickness:
                all_thicknesses.add(str(thickness))
            
            features = p.get('features', [])
            if isinstance(features, list):
                all_features.update(features)
            
            rooms = p.get('rooms', [])
            if isinstance(rooms, list):
                all_rooms.update(rooms)
            
            styles = p.get('styles', [])
            if isinstance(styles, list):
                all_styles.update(styles)
        
        # Build comprehensive details for AI prompt
        details_parts = []
        
        if all_colors:
            color_list = sorted(list(all_colors))
            details_parts.append(f"Available Colors ({len(color_list)}): {', '.join(color_list)}")
        
        if all_sizes:
            size_list = sorted(list(all_sizes))
            details_parts.append(f"Available Sizes ({len(size_list)}): {', '.join(size_list)}")
        
        if all_finishes:
            finish_list = sorted(list(all_finishes))
            details_parts.append(f"Finishes: {', '.join(finish_list)}")
        
        if all_materials:
            material_list = sorted(list(all_materials))
            details_parts.append(f"Material: {', '.join(material_list)}")
        
        if all_suitabilities:
            details_parts.append(f"Suitable for: {', '.join(sorted(list(all_suitabilities)))}")
        
        if all_slip_ratings:
            details_parts.append(f"Slip Rating: {', '.join(sorted(list(all_slip_ratings)))}")
        
        if all_thicknesses:
            thickness_list = sorted(list(all_thicknesses))
            details_parts.append(f"Thickness options: {', '.join(thickness_list)}")
        
        if all_rooms:
            details_parts.append(f"Ideal for: {', '.join(sorted(list(all_rooms)))}")
        
        if all_styles:
            details_parts.append(f"Style: {', '.join(sorted(list(all_styles)))}")
        
        if all_features:
            details_parts.append(f"Features: {', '.join(sorted(list(all_features)))}")
        
        details_text = '\n'.join(details_parts) if details_parts else 'Premium tile collection'
        
        # Determine length requirements
        if length == 'brief':
            length_instruction = "Write 1-2 paragraphs (80-120 words). Be concise but comprehensive."
        elif length == 'detailed':
            length_instruction = "Write 4-5 detailed paragraphs (300-400 words). Include comprehensive details about all variants, features, benefits, and applications."
        else:
            length_instruction = "Write 2-3 paragraphs (150-250 words). Balance detail with readability."
        
        # Create the unified series prompt
        prompt = f"""Write a compelling, unified product collection description for the "{series_name}" tile series.

This is a COLLECTION description that should cover ALL variants in one cohesive text. Do NOT write separate descriptions for each color/size - write ONE unified description that mentions the variety available.

Collection Overview:
- Series Name: {series_name}
- Total Variants: {len(products)} products in this collection

{details_text}

SEO Keywords to weave in naturally: {seo_keywords or 'tiles, porcelain tiles, interior design, home renovation'}

Length Requirements:
{length_instruction}

Writing Guidelines:
1. Start with a compelling opening about the {series_name} collection's overall aesthetic/appeal
2. Mention the variety of colors available (list them naturally in the text)
3. Reference the size options available for different project needs
4. Include the finishes and what look they create
5. Mention suitable applications (rooms, wall/floor use)
6. End with why this collection is a great choice
7. Write in a professional but engaging e-commerce tone
8. Do NOT use bullet points or headings - flowing paragraphs only
9. Do NOT use placeholder text or brackets
10. Make it sound premium and aspirational

Write the unified collection description now:"""

        # Generate description using emergentintegrations
        chat = LlmChat(
            api_key=api_key,
            session_id=f"series-desc-{uuid_module.uuid4()}",
            system_message="You are an expert copywriter specializing in tile and home improvement product collections. Write compelling, SEO-friendly collection descriptions that showcase the full range of options."
        ).with_model("openai", "gpt-4o")
        
        user_message = UserMessage(text=prompt)
        description = await chat.send_message(user_message)
        description = description.strip()
        
        # Save the generated description to the tracking collection
        await db.series_description_tracking.update_one(
            {"series_name": series_name},
            {"$set": {
                "series_name": series_name,
                "last_description": description,
                "last_generated_at": datetime.now(timezone.utc).isoformat(),
                "last_product_count": len(products),
                "generated_by": current_user.get("email")
            }},
            upsert=True
        )
        
        return {
            "success": True,
            "series_name": series_name,
            "product_count": len(products),
            "description": description,
            "aggregated_data": {
                "colors": sorted(list(all_colors)),
                "sizes": sorted(list(all_sizes)),
                "finishes": sorted(list(all_finishes)),
                "materials": sorted(list(all_materials)),
                "suitabilities": sorted(list(all_suitabilities)),
                "rooms": sorted(list(all_rooms)),
                "styles": sorted(list(all_styles)),
                "features": sorted(list(all_features))
            }
        }
        
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Failed to generate series description: {str(e)}")


class BatchSeriesDescriptionRequest(BaseModel):
    """Request model for batch series description generation"""
    product_skus: List[str] = Field(..., description="List of product SKUs to analyze and group by series")
    seo_keywords: Optional[str] = None
    length: Optional[str] = "standard"
    # 24 May 2026 — manual override for auto-detected series names.
    # Admin can rename "Pietra Ligure" → "La Dolce" in the modal before
    # generating. Map is { auto_detected_name: user_edited_name }.
    # Auto-detection still runs; this just renames the resulting groups.
    series_name_overrides: Optional[Dict[str, str]] = None


class SeriesInfo(BaseModel):
    """Info about a detected series"""
    series_name: str
    product_count: int
    skus: List[str]
    colors: List[str]
    sizes: List[str]
    finishes: List[str]


# Series name extraction matching website_admin.py extract_series_name()
# Must stay in sync with the frontend and backend collections endpoint
_SERIES_COLOR_WORDS = {
    'white', 'black', 'grey', 'gray', 'beige', 'cream', 'ivory', 'brown', 'blue',
    'green', 'red', 'yellow', 'orange', 'pink', 'purple', 'gold', 'silver',
    'charcoal', 'anthracite', 'taupe', 'sand', 'bone', 'pearl', 'light', 'dark',
    'natural', 'almond', 'crema', 'bianco', 'grigio', 'nero', 'avorio',
    'decor', 'feature', 'border', 'mosaic', 'listello'
}

def _extract_series_name(product_name: str) -> str:
    """Extract series name from product name (matching website_admin.py logic exactly)."""
    if not product_name:
        return "Unknown"
    parts = product_name.strip().split()
    series_parts = []
    for part in parts:
        if re.match(r'^\d+[xX]\d+', part):
            break
        series_parts.append(part)
    while series_parts and series_parts[-1].lower() in _SERIES_COLOR_WORDS:
        series_parts.pop()
    if not series_parts:
        return ' '.join(product_name.strip().split()[:2]) if product_name.strip() else "Unknown"
    return ' '.join(series_parts)



@api_router.post("/products/detect-series")
async def detect_series_from_products(
    request_data: BatchSeriesDescriptionRequest,
    current_user: dict = Depends(get_current_user)
):
    """
    Detect and group products by series from a list of SKUs.
    Returns the series found with their product counts and attributes.
    """
    try:
        product_skus = request_data.product_skus
        
        if not product_skus:
            raise HTTPException(status_code=400, detail="product_skus list is required")
        
        # Query products by SKU
        products = await db.supplier_products.find({"sku": {"$in": product_skus}}).to_list(1000)
        
        if not products:
            products = await db.tiles.find({"sku": {"$in": product_skus}}).to_list(1000)
        
        if not products:
            raise HTTPException(status_code=404, detail="No products found for the provided SKUs")
        
        # Group products by series (extract series name matching backend logic)
        series_groups = {}
        
        for p in products:
            # 24 May 2026 — priority chain rewrite. Previously
            # `our_product_name` won — but for legacy products that
            # value is the supplier's original name (e.g. "Pietra
            # Ligure Sabbia 60x120cm"), while the admin's renamed
            # "La Dolce" lives only in `display_name`. User reported
            # the Quick-Generate-All modal grouped 25 La Dolce tiles
            # under "Pietra Ligure" because of this. Storefront and
            # the bulk-editor product list both read `display_name`
            # first, so we match that source-of-truth here.
            # Priority: display_name → our_product_name → website_name
            #         → name → product_name → series field
            product_name = (
                p.get('display_name')
                or p.get('our_product_name')
                or p.get('website_name')
                or p.get('name')
                or p.get('product_name')
                or ''
            )
            if product_name:
                series_name = _extract_series_name(product_name)
            else:
                # Last resort: stored series field
                series_name = p.get('series') or 'Unknown'

            if not series_name:
                series_name = 'Unknown'

            if series_name not in series_groups:
                series_groups[series_name] = {
                    'products': [],
                    'colors': set(),
                    'sizes': set(),
                    'finishes': set()
                }

            series_groups[series_name]['products'].append(p)

            # Collect attributes
            color = p.get('color') or p.get('attributes', {}).get('color', '')
            if color:
                series_groups[series_name]['colors'].add(color)

            size = p.get('size') or p.get('attributes', {}).get('size', '')
            if size:
                series_groups[series_name]['sizes'].add(size)

            finish = p.get('finish') or p.get('attributes', {}).get('finish', '')
            if finish:
                series_groups[series_name]['finishes'].add(finish)
        
        # Build response
        series_list = []
        for series_name, data in series_groups.items():
            series_list.append({
                'series_name': series_name,
                'product_count': len(data['products']),
                'skus': [p.get('sku') for p in data['products']],
                'colors': sorted(list(data['colors'])),
                'sizes': sorted(list(data['sizes'])),
                'finishes': sorted(list(data['finishes']))
            })
        
        # Sort by product count descending
        series_list.sort(key=lambda x: x['product_count'], reverse=True)
        
        return {
            'success': True,
            'total_products': len(products),
            'series_count': len(series_list),
            'series': series_list
        }
        
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Failed to detect series: {str(e)}")


@api_router.post("/products/generate-batch-series-descriptions")
async def generate_batch_series_descriptions(
    request_data: BatchSeriesDescriptionRequest,
    current_user: dict = Depends(get_current_user)
):
    """
    Generate unified descriptions for multiple series at once.
    Auto-detects series from the provided SKUs and generates a description for each.
    """
    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage
        import uuid as uuid_module
        
        api_key = os.environ.get('EMERGENT_LLM_KEY') or os.environ.get('OPENAI_API_KEY')
        if not api_key:
            raise HTTPException(status_code=500, detail="API key not configured")
        
        product_skus = request_data.product_skus
        seo_keywords = request_data.seo_keywords or ''
        length = request_data.length or 'standard'
        
        if not product_skus:
            raise HTTPException(status_code=400, detail="product_skus list is required")
        
        # Query products by SKU
        products = await db.supplier_products.find({"sku": {"$in": product_skus}}).to_list(1000)
        
        if not products:
            products = await db.tiles.find({"sku": {"$in": product_skus}}).to_list(1000)
        
        if not products:
            raise HTTPException(status_code=404, detail="No products found for the provided SKUs")
        
        # Group products by series
        series_groups = {}
        
        for p in products:
            # 24 May 2026 — same priority chain as detect_series_from_products.
            # display_name wins because that's what the storefront PDP
            # and the bulk-editor product list both render.
            product_name = (
                p.get('display_name')
                or p.get('our_product_name')
                or p.get('website_name')
                or p.get('name')
                or p.get('product_name')
                or ''
            )
            if product_name:
                series_name = _extract_series_name(product_name)
            else:
                series_name = p.get('series') or 'Unknown'

            if not series_name:
                series_name = 'Unknown'

            if series_name not in series_groups:
                series_groups[series_name] = []
            series_groups[series_name].append(p)

        # 24 May 2026 — apply admin-provided series-name overrides so
        # the user sees the renamed group label (e.g. "La Dolce")
        # instead of the supplier auto-detected name (e.g. "Pietra
        # Ligure"). The override map is { auto: edited }, so we rename
        # every key found in it.
        overrides = (request_data.series_name_overrides or {})
        if overrides:
            renamed = {}
            for k, v in series_groups.items():
                new_key = overrides.get(k, k) or k  # honour rename, ignore empty
                if new_key in renamed:
                    renamed[new_key].extend(v)
                else:
                    renamed[new_key] = v
            series_groups = renamed
        if length == 'brief':
            length_instruction = "Write 1-2 paragraphs (80-120 words). Be concise but comprehensive."
        elif length == 'detailed':
            length_instruction = "Write 4-5 detailed paragraphs (300-400 words). Include comprehensive details."
        else:
            length_instruction = "Write 2-3 paragraphs (150-250 words). Balance detail with readability."
        
        # Generate descriptions for each series
        results = []
        
        for series_name, series_products in series_groups.items():
            # Aggregate attributes for this series
            all_colors = set()
            all_sizes = set()
            all_finishes = set()
            all_materials = set()
            all_suitabilities = set()
            all_rooms = set()
            
            for p in series_products:
                color = p.get('color') or p.get('attributes', {}).get('color', '')
                if color:
                    all_colors.add(color)
                
                size = p.get('size') or p.get('attributes', {}).get('size', '')
                if size:
                    all_sizes.add(size)
                
                finish = p.get('finish') or p.get('attributes', {}).get('finish', '')
                if finish:
                    all_finishes.add(finish)
                
                material = p.get('material') or p.get('attributes', {}).get('material', '')
                if material:
                    all_materials.add(material)
                
                suitability = p.get('suitability', '')
                if suitability:
                    all_suitabilities.add(suitability)
                
                rooms = p.get('rooms', [])
                if isinstance(rooms, list):
                    all_rooms.update(rooms)
            
            # Build details text
            details_parts = []
            if all_colors:
                details_parts.append(f"Available Colors ({len(all_colors)}): {', '.join(sorted(all_colors))}")
            if all_sizes:
                details_parts.append(f"Available Sizes ({len(all_sizes)}): {', '.join(sorted(all_sizes))}")
            if all_finishes:
                details_parts.append(f"Finishes: {', '.join(sorted(all_finishes))}")
            if all_materials:
                details_parts.append(f"Material: {', '.join(sorted(all_materials))}")
            if all_suitabilities:
                details_parts.append(f"Suitable for: {', '.join(sorted(all_suitabilities))}")
            if all_rooms:
                details_parts.append(f"Ideal for: {', '.join(sorted(all_rooms))}")
            
            details_text = '\n'.join(details_parts) if details_parts else 'Premium tile collection'
            
            # Create prompt
            prompt = f"""Write a compelling, unified product collection description for the "{series_name}" tile series.

This is a COLLECTION description covering ALL variants in one cohesive text.

Collection Overview:
- Series Name: {series_name}
- Total Variants: {len(series_products)} products

{details_text}

SEO Keywords: {seo_keywords or 'tiles, porcelain tiles, interior design'}

{length_instruction}

Guidelines:
1. Start with compelling opening about the collection's aesthetic
2. Mention the variety of colors, sizes, finishes naturally
3. Include suitable applications
4. Professional e-commerce tone, flowing paragraphs only
5. No bullet points, headings, or placeholders

Write the description now:"""

            # Generate with LLM
            chat = LlmChat(
                api_key=api_key,
                session_id=f"batch-series-{uuid_module.uuid4()}",
                system_message="You are an expert tile copywriter. Write compelling collection descriptions."
            ).with_model("openai", "gpt-4o")
            
            user_message = UserMessage(text=prompt)
            description = await chat.send_message(user_message)
            description = description.strip()
            
            # Save the generated description to the tracking collection
            await db.series_description_tracking.update_one(
                {"series_name": series_name},
                {"$set": {
                    "series_name": series_name,
                    "last_description": description,
                    "last_generated_at": datetime.now(timezone.utc).isoformat(),
                    "last_product_count": len(series_products),
                    "generated_by": current_user.get("email")
                }},
                upsert=True
            )
            
            results.append({
                'series_name': series_name,
                'product_count': len(series_products),
                'description': description,
                'skus': [p.get('sku') for p in series_products],
                'aggregated_data': {
                    'colors': sorted(list(all_colors)),
                    'sizes': sorted(list(all_sizes)),
                    'finishes': sorted(list(all_finishes)),
                    'materials': sorted(list(all_materials)),
                    'suitabilities': sorted(list(all_suitabilities)),
                    'rooms': sorted(list(all_rooms))
                }
            })
        
        # Sort results by product count descending
        results.sort(key=lambda x: x['product_count'], reverse=True)
        
        return {
            'success': True,
            'total_products': len(products),
            'series_count': len(results),
            'results': results
        }
        
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Failed to generate batch descriptions: {str(e)}")


# ============================================================================
# SERIES DESCRIPTION AUTO-REGENERATION ENDPOINTS
# ============================================================================

class DescriptionRegenSettings(BaseModel):
    """Settings for automatic series description regeneration"""
    enabled: bool = False
    frequency_hours: int = 6  # How often to check for updates
    default_length: str = "standard"  # brief, standard, detailed
    default_seo_keywords: str = ""
    notify_on_regeneration: bool = True


@api_router.get("/products/description-regen/settings")
async def get_description_regen_settings(current_user: dict = Depends(get_current_user)):
    """Get auto-regeneration settings"""
    if current_user.get("role") not in ["super_admin", "admin"]:
        raise HTTPException(status_code=403, detail="Admin access required")
    
    settings = await db.description_regen_settings.find_one({"_id": "global"})
    
    if not settings:
        settings = {
            "enabled": False,
            "frequency_hours": 6,
            "default_length": "standard",
            "default_seo_keywords": "",
            "notify_on_regeneration": True,
            "last_run": None,
            "last_run_regenerated": 0
        }
    
    # Remove MongoDB _id
    settings.pop("_id", None)
    
    return settings


@api_router.post("/products/description-regen/settings")
async def update_description_regen_settings(
    settings: DescriptionRegenSettings,
    current_user: dict = Depends(get_current_user)
):
    """Update auto-regeneration settings"""
    if current_user.get("role") not in ["super_admin", "admin"]:
        raise HTTPException(status_code=403, detail="Admin access required")
    
    await db.description_regen_settings.update_one(
        {"_id": "global"},
        {"$set": {
            "enabled": settings.enabled,
            "frequency_hours": settings.frequency_hours,
            "default_length": settings.default_length,
            "default_seo_keywords": settings.default_seo_keywords,
            "notify_on_regeneration": settings.notify_on_regeneration,
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "updated_by": current_user.get("email")
        }},
        upsert=True
    )
    
    return {"success": True, "message": "Settings updated"}


@api_router.get("/products/description-regen/tracked-series")
async def get_tracked_series(current_user: dict = Depends(get_current_user)):
    """Get all series being tracked for auto-regeneration"""
    if current_user.get("role") not in ["super_admin", "admin"]:
        raise HTTPException(status_code=403, detail="Admin access required")
    
    tracked = await db.series_description_tracking.find({}).to_list(500)
    
    # Clean up MongoDB _id
    for item in tracked:
        item.pop("_id", None)
    
    return {
        "success": True,
        "count": len(tracked),
        "series": tracked
    }


class TrackSeriesRequest(BaseModel):
    """Request to add a series for tracking"""
    series_name: str
    auto_regenerate: bool = True


@api_router.post("/products/description-regen/track-series")
async def track_series_for_regeneration(
    request: TrackSeriesRequest,
    current_user: dict = Depends(get_current_user)
):
    """Add a series to be tracked for auto-regeneration"""
    if current_user.get("role") not in ["super_admin", "admin"]:
        raise HTTPException(status_code=403, detail="Admin access required")
    
    series_name = request.series_name
    
    # Check if series exists
    query = {
        "$or": [
            {"our_product_name": {"$regex": f"^{re.escape(series_name)}", "$options": "i"}},
            {"product_name": {"$regex": f"^{re.escape(series_name)}", "$options": "i"}},
            {"display_name": {"$regex": f"^{re.escape(series_name)}", "$options": "i"}},
            {"name": {"$regex": f"^{re.escape(series_name)}", "$options": "i"}},
            {"series": {"$regex": f"^{re.escape(series_name)}", "$options": "i"}}
        ]
    }
    
    product_count = await db.supplier_products.count_documents(query)
    if product_count == 0:
        product_count = await db.tiles.count_documents(query)
    
    if product_count == 0:
        raise HTTPException(status_code=404, detail=f"No products found for series '{series_name}'")
    
    # Add or update tracking
    await db.series_description_tracking.update_one(
        {"series_name": series_name},
        {"$set": {
            "series_name": series_name,
            "auto_regenerate": request.auto_regenerate,
            "product_count": product_count,
            "added_at": datetime.now(timezone.utc).isoformat(),
            "added_by": current_user.get("email")
        }},
        upsert=True
    )
    
    return {
        "success": True,
        "message": f"Series '{series_name}' is now being tracked ({product_count} products)"
    }


@api_router.delete("/products/description-regen/track-series/{series_name}")
async def untrack_series(
    series_name: str,
    current_user: dict = Depends(get_current_user)
):
    """Remove a series from auto-regeneration tracking"""
    if current_user.get("role") not in ["super_admin", "admin"]:
        raise HTTPException(status_code=403, detail="Admin access required")
    
    result = await db.series_description_tracking.delete_one({"series_name": series_name})
    
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail=f"Series '{series_name}' was not being tracked")
    
    return {"success": True, "message": f"Series '{series_name}' removed from tracking"}


@api_router.post("/products/description-regen/track-batch")
async def track_multiple_series(
    request_data: dict,
    current_user: dict = Depends(get_current_user)
):
    """Add multiple series to tracking at once (from batch description results)"""
    if current_user.get("role") not in ["super_admin", "admin"]:
        raise HTTPException(status_code=403, detail="Admin access required")
    
    series_list = request_data.get("series", [])
    auto_regenerate = request_data.get("auto_regenerate", True)
    
    if not series_list:
        raise HTTPException(status_code=400, detail="No series provided")
    
    added_count = 0
    
    for series_info in series_list:
        series_name = series_info if isinstance(series_info, str) else series_info.get("series_name")
        product_count = series_info.get("product_count", 0) if isinstance(series_info, dict) else 0
        
        if series_name:
            await db.series_description_tracking.update_one(
                {"series_name": series_name},
                {"$set": {
                    "series_name": series_name,
                    "auto_regenerate": auto_regenerate,
                    "product_count": product_count,
                    "added_at": datetime.now(timezone.utc).isoformat(),
                    "added_by": current_user.get("email")
                }},
                upsert=True
            )
            added_count += 1
    
    return {
        "success": True,
        "message": f"Added {added_count} series to tracking"
    }


@api_router.get("/products/description-regen/history")
async def get_regeneration_history(current_user: dict = Depends(get_current_user)):
    """Get recent auto-regeneration history"""
    if current_user.get("role") not in ["super_admin", "admin"]:
        raise HTTPException(status_code=403, detail="Admin access required")
    
    # Import from scheduler
    try:
        from services.scheduler import description_regeneration_history
        return {
            "success": True,
            "count": len(description_regeneration_history),
            "history": description_regeneration_history[-50:]  # Last 50 entries
        }
    except ImportError:
        return {
            "success": True,
            "count": 0,
            "history": []
        }


@api_router.post("/products/description-regen/run-now")
async def run_regeneration_now(current_user: dict = Depends(get_current_user)):
    """Manually trigger description regeneration check"""
    if current_user.get("role") not in ["super_admin", "admin"]:
        raise HTTPException(status_code=403, detail="Admin access required")
    
    try:
        from services.scheduler import check_and_regenerate_series_descriptions
        import asyncio
        
        # Run in background
        asyncio.create_task(check_and_regenerate_series_descriptions())
        
        return {
            "success": True,
            "message": "Regeneration check started in background"
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to start regeneration: {str(e)}")


@api_router.get("/products/description-regen/pending")
async def get_pending_regenerations(current_user: dict = Depends(get_current_user)):
    """Get series that need description regeneration (have new products)"""
    if current_user.get("role") not in ["super_admin", "admin"]:
        raise HTTPException(status_code=403, detail="Admin access required")
    
    tracked_series = await db.series_description_tracking.find({
        "auto_regenerate": True
    }).to_list(500)
    
    pending = []
    
    for series_info in tracked_series:
        series_name = series_info.get("series_name")
        last_generated = series_info.get("last_generated")
        
        if not series_name:
            continue
        
        import re
        
        # Count total products in series
        query = {
            "$or": [
                {"product_name": {"$regex": f"^{re.escape(series_name)}", "$options": "i"}},
                {"name": {"$regex": f"^{re.escape(series_name)}", "$options": "i"}},
                {"series": {"$regex": f"^{re.escape(series_name)}", "$options": "i"}}
            ]
        }
        
        total_count = await db.supplier_products.count_documents(query)
        
        # Count new products since last generation
        new_count = 0
        if last_generated:
            new_query = {
                "$and": [
                    {"$or": [
                        {"product_name": {"$regex": f"^{re.escape(series_name)}", "$options": "i"}},
                        {"name": {"$regex": f"^{re.escape(series_name)}", "$options": "i"}},
                        {"series": {"$regex": f"^{re.escape(series_name)}", "$options": "i"}}
                    ]},
                    {"$or": [
                        {"created_at": {"$gt": last_generated}},
                        {"updated_at": {"$gt": last_generated}},
                        {"last_imported": {"$gt": last_generated}}
                    ]}
                ]
            }
            new_count = await db.supplier_products.count_documents(new_query)
        else:
            new_count = total_count  # Never generated, all are "new"
        
        if new_count > 0:
            pending.append({
                "series_name": series_name,
                "total_products": total_count,
                "new_products": new_count,
                "last_generated": last_generated,
                "needs_regeneration": True
            })
    
    return {
        "success": True,
        "count": len(pending),
        "pending_series": pending
    }


class BulkProductUpdate(BaseModel):
    """Bulk update model for products"""
    product_ids: List[str] = Field(..., description="List of product IDs to update")
    # Fields to update (all optional)
    price: Optional[float] = None
    cost_price: Optional[float] = None
    price_per_sqm: Optional[float] = None
    stock: Optional[int] = None
    stock_sqm: Optional[float] = None
    reorder_level: Optional[int] = None
    category_id: Optional[str] = None
    is_active: Optional[bool] = None
    is_featured: Optional[bool] = None
    clearance: Optional[bool] = None
    # Markup percentage (alternative to setting price directly)
    markup_percentage: Optional[float] = Field(None, description="Apply markup to cost_price to set price")


@api_router.put("/products/bulk-update")
async def bulk_update_products(
    update: BulkProductUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Bulk update multiple products at once"""
    if current_user.get("role") not in ["super_admin", "admin"]:
        raise HTTPException(status_code=403, detail="Admin access required")
    
    if not update.product_ids:
        raise HTTPException(status_code=400, detail="No products selected")
    
    if len(update.product_ids) > 500:
        raise HTTPException(status_code=400, detail="Maximum 500 products per bulk update")
    
    # Build update data
    update_data = {}
    update_dict = update.model_dump(exclude={'product_ids', 'markup_percentage'})
    
    for key, value in update_dict.items():
        if value is not None:
            update_data[key] = value
    
    # Handle category name lookup
    if update.category_id:
        category = await db.categories.find_one({"id": update.category_id}, {"_id": 0})
        if category:
            update_data["category_name"] = category.get("name")
    
    if not update_data and update.markup_percentage is None:
        raise HTTPException(status_code=400, detail="No fields to update")
    
    update_data["updated_at"] = datetime.now(timezone.utc)
    
    updated_count = 0
    errors = []
    
    for product_id in update.product_ids:
        try:
            product = await db.products.find_one({"id": product_id})
            if not product:
                errors.append({"id": product_id, "error": "Not found"})
                continue
            
            # Calculate price from markup if provided
            product_update = update_data.copy()
            if update.markup_percentage is not None:
                cost = product_update.get("cost_price") or product.get("cost_price") or 0
                if cost > 0:
                    product_update["price"] = round(cost * (1 + update.markup_percentage / 100), 2)
                    product_update["price_per_sqm"] = product_update["price"]
            
            await db.products.update_one(
                {"id": product_id},
                {"$set": product_update}
            )
            updated_count += 1
            
            # Sync to tiles if name fields changed
            sku = product.get("sku")
            if sku:
                tiles_sync_fields = ['name', 'display_name', 'product_name', 'price', 'description', 'images']
                tiles_update = {k: v for k, v in product_update.items() if k in tiles_sync_fields}
                if tiles_update:
                    # Add slug update if name changed
                    new_name = tiles_update.get('name') or tiles_update.get('display_name') or tiles_update.get('product_name')
                    if new_name:
                        import re
                        tiles_update['slug'] = re.sub(r'[^a-z0-9]+', '-', new_name.lower()).strip('-')
                    tiles_update['updated_at'] = datetime.now(timezone.utc)
                    await db.tiles.update_one({"sku": sku}, {"$set": tiles_update})
            
        except Exception as e:
            errors.append({"id": product_id, "error": str(e)})
    
    # Log audit trail
    await log_audit(
        action="bulk_update",
        entity_type="product",
        user=current_user,
        entity_id=None,
        entity_name=f"{updated_count} products",
        before_data={"product_count": len(update.product_ids)},
        after_data={"updated_count": updated_count, "fields": list(update_data.keys())},
        details=f"Bulk updated {updated_count} products"
    )
    
    return {
        "message": f"Updated {updated_count} products",
        "updated_count": updated_count,
        "error_count": len(errors),
        "errors": errors[:10] if errors else []  # Return first 10 errors max
    }


class BulkDeleteRequest(BaseModel):
    product_ids: List[str]


@api_router.post("/products/bulk-delete")
async def bulk_delete_products(
    request: BulkDeleteRequest,
    current_user: dict = Depends(get_current_user)
):
    """Bulk delete multiple products at once"""
    if current_user.get("role") not in ["super_admin", "admin"]:
        raise HTTPException(status_code=403, detail="Admin access required")
    
    if not request.product_ids:
        raise HTTPException(status_code=400, detail="No products selected")
    
    if len(request.product_ids) > 200:
        raise HTTPException(status_code=400, detail="Maximum 200 products per bulk delete")
    
    deleted_count = 0
    errors = []
    deleted_names = []
    
    for product_id in request.product_ids:
        try:
            product = await db.products.find_one({"id": product_id})
            if not product:
                errors.append({"id": product_id, "error": "Not found"})
                continue
            
            deleted_names.append(product.get("name", product_id))
            await db.products.delete_one({"id": product_id})
            deleted_count += 1
            
        except Exception as e:
            errors.append({"id": product_id, "error": str(e)})
    
    # Log audit trail
    await log_audit(
        action="bulk_delete",
        entity_type="product",
        user=current_user,
        entity_id=None,
        entity_name=f"{deleted_count} products",
        before_data={"product_count": len(request.product_ids), "names": deleted_names[:10]},
        after_data={"deleted_count": deleted_count},
        details=f"Bulk deleted {deleted_count} products"
    )
    
    return {
        "message": f"Deleted {deleted_count} products",
        "deleted_count": deleted_count,
        "error_count": len(errors),
        "errors": errors[:10] if errors else []
    }


@api_router.put("/products/{product_id}")
async def update_product(product_id: str, input: ProductUpdate, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super Admin access required")
    
    from bson import ObjectId
    
    # Try to find by 'id' field first (UUID format)
    product = await db.products.find_one({"id": product_id}, {"_id": 0})
    lookup_field = "id"
    
    # Fallback to finding by ObjectId
    if not product:
        try:
            product = await db.products.find_one({"_id": ObjectId(product_id)})
            if product:
                lookup_field = "_id"
                product_id = ObjectId(product_id)  # Use ObjectId for updates
                product.pop("_id", None)  # Remove _id from product dict
        except Exception:
            pass
    
    # Also try by SKU as last resort
    if not product:
        product = await db.products.find_one({"sku": product_id}, {"_id": 0})
        if product:
            lookup_field = "sku"
    
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    
    # Get all non-None fields, but also include explicitly set boolean fields
    update_data = {}
    input_dict = input.model_dump()
    for k, v in input_dict.items():
        # Include field if it's not None, OR if it's a boolean (to allow setting False)
        if v is not None or (k in ['room_lot_enabled', 'pallet_enabled', 'clearance'] and v is not None):
            update_data[k] = v
    
    if "category_id" in update_data and update_data["category_id"]:
        category = await db.categories.find_one({"id": update_data["category_id"]}, {"_id": 0})
        if category:
            update_data["category_name"] = category["name"]
    
    # Recalculate m² per piece if tile dimensions are updated
    tile_width = update_data.get("tile_width", product.get("tile_width"))
    tile_height = update_data.get("tile_height", product.get("tile_height"))
    
    # VALIDATION: Auto-convert mm to cm if values are too large (>200)
    if tile_width and tile_width > 200:
        tile_width = tile_width / 10
        update_data["tile_width"] = tile_width
        logging.info(f"Auto-converted tile_width from {tile_width * 10}mm to {tile_width}cm")
    if tile_height and tile_height > 200:
        tile_height = tile_height / 10
        update_data["tile_height"] = tile_height
        logging.info(f"Auto-converted tile_height from {tile_height * 10}mm to {tile_height}cm")
    
    # VALIDATION: Reject unrealistic dimensions (> 200cm = 2 meters)
    if tile_width and tile_width > 200:
        raise HTTPException(status_code=400, detail=f"Tile width {tile_width}cm exceeds maximum (200cm). Did you enter mm instead of cm?")
    if tile_height and tile_height > 200:
        raise HTTPException(status_code=400, detail=f"Tile height {tile_height}cm exceeds maximum (200cm). Did you enter mm instead of cm?")
    
    if tile_width and tile_height:
        m2_per_piece = (tile_width / 100) * (tile_height / 100)
        # VALIDATION: Sanity check - single tile > 4m² is almost certainly wrong
        if m2_per_piece > 4:
            raise HTTPException(
                status_code=400, 
                detail=f"Calculated {m2_per_piece:.2f}m² per tile is unrealistic. A {tile_width}x{tile_height}cm tile would be {tile_width/100:.1f}m × {tile_height/100:.1f}m. Please check dimensions."
            )
        update_data["tile_m2_per_piece"] = m2_per_piece
    elif "tile_width" in update_data or "tile_height" in update_data:
        # If one dimension is being cleared, clear the calculation
        if not tile_width or not tile_height:
            update_data["tile_m2_per_piece"] = None
    
    # Recalculate box m² coverage if tiles_per_box or tile dimensions are updated
    tiles_per_box = update_data.get("tiles_per_box", product.get("tiles_per_box"))
    tile_m2_per_piece = update_data.get("tile_m2_per_piece", product.get("tile_m2_per_piece"))
    if tile_m2_per_piece and tiles_per_box:
        update_data["box_m2_coverage"] = round(tile_m2_per_piece * tiles_per_box, 3)
    elif "tiles_per_box" in update_data or "tile_m2_per_piece" in update_data:
        if not tile_m2_per_piece or not tiles_per_box:
            update_data["box_m2_coverage"] = None
    
    update_data["updated_at"] = datetime.now(timezone.utc).isoformat()
    
    # Use the correct lookup field determined earlier
    await db.products.update_one({lookup_field: product_id}, {"$set": update_data})
    
    # SYNC category fields AND specification fields to supplier_products and tiles collections
    sku = product.get("sku")
    sync_fields = [
        # Name fields
        'name', 'product_name', 'display_name',
        # Visibility & Status
        'visibility', 'status', 'show_on_website', 'epos_visible', 'show_in_epos',
        # Description & SEO
        'description', 'seo_keywords', 'hidden_seo_keywords',
        # Categories
        'main_category', 'sub_categories', 'rooms', 'styles', 
        'colors', 'features', 'materials', 'finishes',
        # Specifications (product attributes)
        'material', 'finish', 'edge', 'slip_rating', 'thickness', 
        'suitability', 'underfloor_heating', 'rectified_edges',
        # Size & dimensions
        'size', 'tile_width', 'tile_height', 'tiles_per_box',
        # Series (replaces Collection)
        'series',
        # Pricing
        'price', 'cost_price', 'clearance', 'clearance_price',
        # Half + Full Pallet pricing (Feb 2026)
        # Must propagate to tiles + supplier_products so storefront PDP picks
        # them up. Without these, admin saves only update db.products and the
        # storefront chip selector never sees the new rates.
        'pallet_enabled', 'pallet_quantity', 'pallet_price',
        'half_pallet_price', 'm2_per_pallet', 'm2_per_half_pallet',
    ]
    sync_data = {k: update_data[k] for k in sync_fields if k in update_data}
    
    if sync_data and sku:
        try:
            sync_data["updated_at"] = datetime.now(timezone.utc).isoformat()
            supplier = product.get("supplier")
            
            # Build query - use both SKU and supplier for more precise matching
            query = {"sku": sku}
            if supplier:
                query["supplier"] = supplier
            
            # Sync to supplier_products
            result = await db.supplier_products.update_one(query, {"$set": sync_data})
            if result.modified_count == 0:
                # Fallback to SKU-only match
                await db.supplier_products.update_one({"sku": sku}, {"$set": sync_data})
            
            # Sync to tiles - include slug update if name changed
            tiles_sync_data = sync_data.copy()
            if 'name' in sync_data or 'display_name' in sync_data or 'product_name' in sync_data:
                new_name = sync_data.get('name') or sync_data.get('display_name') or sync_data.get('product_name')
                if new_name:
                    import re
                    new_slug = re.sub(r'[^a-z0-9]+', '-', new_name.lower()).strip('-')
                    tiles_sync_data['slug'] = new_slug
            
            await db.tiles.update_one({"sku": sku}, {"$set": tiles_sync_data})
            
            logging.info(f"Synced product {sku} changes to supplier_products and tiles")
        except Exception as e:
            logging.warning(f"Sync to supplier_products/tiles failed (non-critical): {e}")
    
    # Log audit trail
    before_summary = {
        "name": product.get("name"),
        "sku": product.get("sku"),
        "price": product.get("price"),
        "stock": product.get("stock")
    }
    after_summary = {
        "name": update_data.get("name", product.get("name")),
        "sku": update_data.get("sku", product.get("sku")),
        "price": update_data.get("price", product.get("price")),
        "stock": update_data.get("stock", product.get("stock"))
    }
    await log_audit(
        action="UPDATE",
        entity_type="product",
        user=current_user,
        entity_id=product_id,
        entity_name=product.get("name"),
        before_data=before_summary,
        after_data=after_summary,
        details=f"Product '{product.get('name')}' updated"
    )
    
    updated_product = await db.products.find_one({lookup_field: product_id}, {"_id": 0})
    
    # If still not found (edge case), convert ObjectId back to string for id lookup
    if not updated_product and lookup_field == "_id":
        updated_product = await db.products.find_one({"_id": product_id})
        if updated_product:
            updated_product["id"] = str(updated_product.pop("_id", ""))
    
    if not updated_product:
        # This shouldn't happen but handle gracefully
        return {"success": True, "message": "Product updated"}
    
    # Check for stock notifications
    new_stock = updated_product.get("stock", 0)
    if new_stock <= 0:
        try:
            from services.notifications import notify_out_of_stock
            await notify_out_of_stock(db, updated_product)
        except Exception as e:
            logging.error(f"Failed to send out of stock notification: {e}")
    else:
        # Check low stock threshold
        try:
            from services.notifications import notify_low_stock, get_notification_settings
            settings = await get_notification_settings(db)
            threshold = settings.get("low_stock_threshold", 10)
            if new_stock <= threshold and product.get("stock", 0) > threshold:
                await notify_low_stock(db, updated_product, new_stock, threshold)
        except Exception as e:
            logging.error(f"Failed to send low stock notification: {e}")
    
    if 'created_at' in updated_product and isinstance(updated_product['created_at'], str):
        updated_product['created_at'] = datetime.fromisoformat(updated_product['created_at'])
    elif 'created_at' not in updated_product:
        updated_product['created_at'] = datetime.now(timezone.utc)
    if 'updated_at' in updated_product and isinstance(updated_product['updated_at'], str):
        updated_product['updated_at'] = datetime.fromisoformat(updated_product['updated_at'])
    elif 'updated_at' not in updated_product:
        updated_product['updated_at'] = datetime.now(timezone.utc)
    
    # Ensure required fields have defaults to prevent validation errors
    if updated_product.get('price') is None:
        updated_product['price'] = 0.0
    if updated_product.get('stock') is None:
        updated_product['stock'] = 0
    if not updated_product.get('sku'):
        updated_product['sku'] = updated_product.get('id', 'UNKNOWN')
    if not updated_product.get('name'):
        updated_product['name'] = 'Unnamed Product'
    if updated_product.get('reorder_level') is None:
        updated_product['reorder_level'] = 10
    
    # Return dict directly to ensure all fields are included (including category fields)
    return updated_product


@api_router.delete("/products/{product_id}")
async def delete_product(product_id: str, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super Admin access required")
    
    product = await db.products.find_one({"id": product_id}, {"_id": 0})
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    
    result = await db.products.delete_one({"id": product_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Product not found")
    
    # Log audit trail
    await log_audit(
        action="DELETE",
        entity_type="product",
        user=current_user,
        entity_id=product_id,
        entity_name=product.get("name"),
        before_data={
            "name": product.get("name"),
            "sku": product.get("sku"),
            "price": product.get("price"),
            "stock": product.get("stock")
        },
        details=f"Product '{product.get('name')}' (SKU: {product.get('sku')}) deleted"
    )
    
    return {"message": "Product deleted successfully"}

# Product Ticket Settings
class ProductTicketSettings(BaseModel):
    product_id: str
    suitability: Optional[str] = None
    finish: Optional[str] = None
    material: Optional[str] = None
    sizes: Optional[List[str]] = None
    country_of_origin: Optional[str] = None
    price_unit: Optional[str] = "m2"
    # 13 May 2026 — remember which paper-size template the admin last
    # used for this product so the next print of the same product
    # auto-loads the same paper size (A6, A5, custom 100x150mm, etc.).
    template_name: Optional[str] = None

@api_router.put("/products/{product_id}/ticket-settings")
async def save_product_ticket_settings(
    product_id: str,
    settings: ProductTicketSettings,
    current_user: dict = Depends(get_current_user)
):
    """Save ticket printing settings for a product"""
    product = await db.products.find_one({"id": product_id})
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    
    # Update product with ticket settings
    ticket_settings = {
        "ticket_suitability": settings.suitability,
        "ticket_finish": settings.finish,
        "ticket_material": settings.material,
        "ticket_sizes": settings.sizes,
        "ticket_country_of_origin": settings.country_of_origin,
        "ticket_price_unit": settings.price_unit,
        "ticket_template_name": settings.template_name,
    }
    
    await db.products.update_one(
        {"id": product_id},
        {"$set": ticket_settings}
    )
    
    return {"message": "Ticket settings saved", "settings": ticket_settings}

@api_router.get("/products/{product_id}/ticket-settings")
async def get_product_ticket_settings(
    product_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Get ticket printing settings for a product"""
    product = await db.products.find_one({"id": product_id}, {"_id": 0})
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    
    return {
        "product_id": product_id,
        "suitability": product.get("ticket_suitability"),
        "finish": product.get("ticket_finish"),
        "material": product.get("ticket_material"),
        "sizes": product.get("ticket_sizes"),
        "country_of_origin": product.get("ticket_country_of_origin"),
        "price_unit": product.get("ticket_price_unit", "m2"),
        "template_name": product.get("ticket_template_name"),
    }

# Store Stock Allocation
class StoreStockAllocation(BaseModel):
    showroom_id: str
    quantity: int

class StoreStockUpdate(BaseModel):
    allocations: List[StoreStockAllocation]

@api_router.get("/products/{product_id}/showroom-stock")
async def get_product_showroom_stock(
    product_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Get stock allocation for a product across showrooms"""
    product = await db.products.find_one({"id": product_id}, {"_id": 0})
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    
    showroom_stock = product.get("showroom_stock", {})
    total_stock = product.get("stock", 0)
    
    # Get showroom names
    showrooms = await db.showrooms.find({}, {"_id": 0, "id": 1, "name": 1}).to_list(100)
    showroom_map = {s["id"]: s["name"] for s in showrooms}
    
    allocations = []
    allocated_total = 0
    for showroom_id, qty in showroom_stock.items():
        allocations.append({
            "showroom_id": showroom_id,
            "showroom_name": showroom_map.get(showroom_id, "Unknown"),
            "quantity": qty
        })
        allocated_total += qty
    
    return {
        "product_id": product_id,
        "product_name": product.get("name"),
        "total_stock": total_stock,
        "allocated_stock": allocated_total,
        "unallocated_stock": total_stock - allocated_total,
        "allocations": allocations
    }

@api_router.put("/products/{product_id}/showroom-stock")
async def update_product_showroom_stock(
    product_id: str,
    input: StoreStockUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Update stock allocation for a product across showrooms (Super Admin only)"""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super Admin access required")
    
    product = await db.products.find_one({"id": product_id}, {"_id": 0})
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    
    # Build showroom_stock dict
    showroom_stock = {}
    total_allocated = 0
    for alloc in input.allocations:
        if alloc.quantity > 0:
            showroom_stock[alloc.showroom_id] = alloc.quantity
            total_allocated += alloc.quantity
    
    # Validate total doesn't exceed stock
    total_stock = product.get("stock", 0)
    if total_allocated > total_stock:
        raise HTTPException(
            status_code=400, 
            detail=f"Total allocated ({total_allocated}) exceeds available stock ({total_stock})"
        )
    
    # Update product
    await db.products.update_one(
        {"id": product_id},
        {"$set": {"showroom_stock": showroom_stock, "updated_at": datetime.now(timezone.utc)}}
    )
    
    # Log audit trail
    await log_audit(
        action="UPDATE",
        entity_type="product_stock_allocation",
        user=current_user,
        entity_id=product_id,
        entity_name=product.get("name"),
        after_data={"showroom_stock": showroom_stock},
        details=f"Stock allocation updated for '{product.get('name')}'"
    )
    
    return {
        "message": "Stock allocation updated",
        "product_id": product_id,
        "showroom_stock": showroom_stock,
        "total_allocated": total_allocated,
        "unallocated": total_stock - total_allocated
    }

@api_router.post("/products/{product_id}/transfer-stock")
async def transfer_stock_between_showrooms(
    product_id: str,
    from_showroom_id: str = Body(...),
    to_showroom_id: str = Body(...),
    quantity: int = Body(...),
    current_user: dict = Depends(get_current_user)
):
    """Transfer stock from one showroom to another (Super Admin only)"""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super Admin access required")
    
    product = await db.products.find_one({"id": product_id}, {"_id": 0})
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    
    showroom_stock = product.get("showroom_stock", {})
    from_qty = showroom_stock.get(from_showroom_id, 0)
    
    if quantity > from_qty:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot transfer {quantity} units. Source showroom only has {from_qty}"
        )
    
    # Update stock
    showroom_stock[from_showroom_id] = from_qty - quantity
    showroom_stock[to_showroom_id] = showroom_stock.get(to_showroom_id, 0) + quantity
    
    # Remove zero allocations
    showroom_stock = {k: v for k, v in showroom_stock.items() if v > 0}
    
    await db.products.update_one(
        {"id": product_id},
        {"$set": {"showroom_stock": showroom_stock, "updated_at": datetime.now(timezone.utc)}}
    )
    
    # Get showroom names for audit
    from_showroom = await db.showrooms.find_one({"id": from_showroom_id}, {"_id": 0, "name": 1})
    to_showroom = await db.showrooms.find_one({"id": to_showroom_id}, {"_id": 0, "name": 1})
    
    await log_audit(
        action="TRANSFER",
        entity_type="stock_transfer",
        user=current_user,
        entity_id=product_id,
        entity_name=product.get("name"),
        details=f"Transferred {quantity} units from {from_showroom.get('name', from_showroom_id)} to {to_showroom.get('name', to_showroom_id)}"
    )
    
    return {
        "message": "Stock transferred successfully",
        "product_id": product_id,
        "quantity_transferred": quantity,
        "from_showroom": from_showroom_id,
        "to_showroom": to_showroom_id,
        "updated_stock": showroom_stock
    }

# ==================== SUPPLIER MANAGEMENT ====================

class SupplierCreate(BaseModel):
    name: str
    code: Optional[str] = None  # Short code for display
    contact_name: Optional[str] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None
    website: Optional[str] = None
    has_portal: bool = False  # Whether this supplier has online portal for scraping
    portal_url: Optional[str] = None
    notes: Optional[str] = None
    active: bool = True

class SupplierUpdate(BaseModel):
    name: Optional[str] = None
    code: Optional[str] = None
    contact_name: Optional[str] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None
    website: Optional[str] = None
    has_portal: Optional[bool] = None
    portal_url: Optional[str] = None
    notes: Optional[str] = None
    active: Optional[bool] = None

class SupplierStockAllocation(BaseModel):
    supplier_id: str
    quantity: int  # Stock in m² or units

class SupplierStockUpdate(BaseModel):
    allocations: List[SupplierStockAllocation]

@api_router.get("/suppliers")
async def get_suppliers(
    active_only: bool = True,
    current_user: dict = Depends(get_current_user)
):
    """Get all suppliers"""
    query = {"active": True} if active_only else {}
    suppliers = await db.suppliers.find(query, {"_id": 0}).sort("name", 1).to_list(1000)
    return suppliers

@api_router.post("/suppliers")
async def create_supplier(
    supplier: SupplierCreate,
    current_user: dict = Depends(get_current_user)
):
    """Create a new supplier (Admin/Super Admin only)"""
    if current_user.get("role") not in ["admin", "super_admin"]:
        raise HTTPException(status_code=403, detail="Admin access required")
    
    supplier_data = supplier.model_dump()
    supplier_data["id"] = str(uuid.uuid4())
    supplier_data["created_at"] = datetime.now(timezone.utc)
    supplier_data["updated_at"] = datetime.now(timezone.utc)
    
    await db.suppliers.insert_one(supplier_data)
    
    # Log audit
    await log_audit(
        action="supplier_created",
        entity_type="supplier",
        user=current_user,
        entity_id=supplier_data["id"],
        entity_name=supplier_data["name"],
        after_data={"name": supplier_data["name"]}
    )
    
    return {**supplier_data, "_id": None}

@api_router.put("/suppliers/{supplier_id}")
async def update_supplier(
    supplier_id: str,
    supplier: SupplierUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Update a supplier (Admin/Super Admin only)"""
    if current_user.get("role") not in ["admin", "super_admin"]:
        raise HTTPException(status_code=403, detail="Admin access required")
    
    existing = await db.suppliers.find_one({"id": supplier_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Supplier not found")
    
    update_data = {k: v for k, v in supplier.model_dump().items() if v is not None}
    update_data["updated_at"] = datetime.now(timezone.utc)
    
    await db.suppliers.update_one(
        {"id": supplier_id},
        {"$set": update_data}
    )
    
    return {"message": "Supplier updated", "id": supplier_id}

@api_router.delete("/suppliers/{supplier_id}")
async def delete_supplier(
    supplier_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Soft delete a supplier (Admin/Super Admin only)"""
    if current_user.get("role") not in ["admin", "super_admin"]:
        raise HTTPException(status_code=403, detail="Admin access required")
    
    result = await db.suppliers.update_one(
        {"id": supplier_id},
        {"$set": {"active": False, "updated_at": datetime.now(timezone.utc)}}
    )
    
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Supplier not found")
    
    return {"message": "Supplier deactivated", "id": supplier_id}

@api_router.get("/products/{product_id}/supplier-stock")
async def get_product_supplier_stock(
    product_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Get supplier stock levels for a product"""
    product = await db.products.find_one({"id": product_id}, {"_id": 0, "supplier_stock": 1, "name": 1})
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    
    supplier_stock = product.get("supplier_stock", {})
    
    # Get supplier names
    suppliers = await db.suppliers.find({}, {"_id": 0, "id": 1, "name": 1, "code": 1}).to_list(100)
    supplier_map = {s["id"]: {"name": s["name"], "code": s.get("code", "")} for s in suppliers}
    
    stock_details = []
    for supplier_id, qty in supplier_stock.items():
        supplier_info = supplier_map.get(supplier_id, {"name": "Unknown", "code": ""})
        stock_details.append({
            "supplier_id": supplier_id,
            "supplier_name": supplier_info["name"],
            "supplier_code": supplier_info["code"],
            "quantity": qty
        })
    
    return {
        "product_id": product_id,
        "product_name": product.get("name"),
        "supplier_stock": stock_details,
        "total_supplier_stock": sum(supplier_stock.values())
    }

@api_router.put("/products/{product_id}/supplier-stock")
async def update_product_supplier_stock(
    product_id: str,
    data: SupplierStockUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Update supplier stock levels for a product (Admin/Super Admin only)"""
    if current_user.get("role") not in ["admin", "super_admin"]:
        raise HTTPException(status_code=403, detail="Admin access required")
    
    product = await db.products.find_one({"id": product_id}, {"_id": 0})
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    
    # Build supplier_stock dict
    supplier_stock = {}
    for alloc in data.allocations:
        if alloc.quantity > 0:
            supplier_stock[alloc.supplier_id] = alloc.quantity
    
    await db.products.update_one(
        {"id": product_id},
        {"$set": {"supplier_stock": supplier_stock, "updated_at": datetime.now(timezone.utc)}}
    )
    
    # Log audit
    await log_audit(
        action="supplier_stock_updated",
        entity_type="product",
        user=current_user,
        entity_id=product_id,
        entity_name=product.get("name"),
        after_data={"supplier_stock": supplier_stock}
    )
    
    total_supplier_stock = sum(supplier_stock.values())
    
    return {
        "message": "Supplier stock updated",
        "product_id": product_id,
        "supplier_stock": supplier_stock,
        "total_supplier_stock": total_supplier_stock
    }

# ==================== END SUPPLIER MANAGEMENT ====================

@api_router.post("/orders/request-otp")
async def request_otp(input: OTPRequest, current_user: dict = Depends(get_current_user)):
    """Generate and send OTP via SMS for order verification"""
    
    # Validate phone number format (should start with +)
    if not input.phone_number.startswith('+'):
        raise HTTPException(status_code=400, detail="Phone number must be in international format (e.g., +44XXXXXXXXXX)")
    
    # Store order data for later verification
    otp_key = f"{current_user['email']}_order_otp"
    otp_storage[otp_key] = {
        "phone_number": input.phone_number,
        "expires_at": datetime.now(timezone.utc) + timedelta(minutes=5),
        "order_data": input.order_data.model_dump()
    }
    
    # Send OTP via Twilio Verify
    if twilio_client and TWILIO_VERIFY_SERVICE_SID:
        try:
            verification = twilio_client.verify.v2.services(TWILIO_VERIFY_SERVICE_SID) \
                .verifications.create(to=input.phone_number, channel="sms")
            
            return {
                "message": "OTP sent successfully via SMS",
                "status": verification.status,
                "expires_in_minutes": 5,
                "sms_sent": True
            }
        except Exception as e:
            # Log the error but fall back to demo mode
            logging.error(f"Twilio error: {str(e)}")
            # Fall back to demo mode
            otp = generate_otp()
            otp_storage[otp_key]["otp"] = otp
            return {
                "message": "OTP generated (SMS service unavailable)",
                "otp": otp,
                "expires_in_minutes": 5,
                "sms_sent": False,
                "error": str(e)
            }
    else:
        # Demo mode - generate OTP locally
        otp = generate_otp()
        otp_storage[otp_key]["otp"] = otp
        return {
            "message": "OTP generated (demo mode)",
            "otp": otp,
            "expires_in_minutes": 5,
            "sms_sent": False
        }

@api_router.post("/orders/verify-otp", response_model=Order)
async def verify_otp_and_create_order(input: OTPVerification, current_user: dict = Depends(get_current_user)):
    """Verify OTP and create order"""
    otp_key = f"{current_user['email']}_order_otp"
    
    if otp_key not in otp_storage:
        raise HTTPException(status_code=400, detail="No OTP request found")
    
    stored_otp_data = otp_storage[otp_key]
    
    # Check if OTP expired
    if datetime.now(timezone.utc) > stored_otp_data["expires_at"]:
        del otp_storage[otp_key]
        raise HTTPException(status_code=400, detail="OTP expired")
    
    # Verify OTP using Twilio Verify or local storage
    otp_valid = False
    
    if twilio_client and TWILIO_VERIFY_SERVICE_SID and "otp" not in stored_otp_data:
        # Verify with Twilio
        try:
            verification_check = twilio_client.verify.v2.services(TWILIO_VERIFY_SERVICE_SID) \
                .verification_checks.create(to=input.phone_number, code=input.otp)
            otp_valid = verification_check.status == "approved"
        except Exception as e:
            logging.error(f"Twilio verification error: {str(e)}")
            raise HTTPException(status_code=400, detail=f"OTP verification failed: {str(e)}")
    else:
        # Verify with local storage (demo mode)
        otp_valid = input.otp == stored_otp_data.get("otp")
    
    if not otp_valid:
        raise HTTPException(status_code=400, detail="Invalid OTP")
    
    # OTP verified, create order
    from uuid import uuid4
    order_id = str(uuid4())
    
    # Use the order data from OTP request
    order_items = [OrderItem(**item) for item in stored_otp_data["order_data"]["items"]]
    total_amount = sum(item.quantity * item.price for item in order_items)
    
    now = datetime.now(timezone.utc)
    order_dict = {
        "id": order_id,
        "customer_email": current_user["email"],
        "customer_name": current_user["name"],
        "phone_number": input.phone_number,
        "items": [item.model_dump() for item in order_items],
        "total_amount": total_amount,
        "status": "pending",
        "created_at": now.isoformat(),
        "updated_at": now.isoformat()
    }
    
    await db.orders.insert_one(order_dict)
    
    # Update product stock
    for item in order_items:
        await db.products.update_one(
            {"id": item.product_id},
            {"$inc": {"stock": -item.quantity}, "$set": {"updated_at": now.isoformat()}}
        )
    
    # Clean up OTP
    del otp_storage[otp_key]
    
    if 'created_at' in order_dict and isinstance(order_dict['created_at'], str):
        order_dict['created_at'] = datetime.fromisoformat(order_dict['created_at'])
    elif 'created_at' not in order_dict:
        order_dict['created_at'] = datetime.now(timezone.utc)
    if 'updated_at' in order_dict and isinstance(order_dict['updated_at'], str):
        order_dict['updated_at'] = datetime.fromisoformat(order_dict['updated_at'])
    elif 'updated_at' not in order_dict:
        order_dict['updated_at'] = datetime.now(timezone.utc)
    return Order(**order_dict)

@api_router.post("/orders", response_model=Order)
async def create_order(input: OrderCreate, current_user: dict = Depends(get_current_user)):
    from uuid import uuid4
    order_id = str(uuid4())
    
    total_amount = sum(item.quantity * item.price for item in input.items)
    
    now = datetime.now(timezone.utc)
    order_dict = {
        "id": order_id,
        "customer_email": current_user["email"],
        "customer_name": current_user["name"],
        "items": [item.model_dump() for item in input.items],
        "total_amount": total_amount,
        "status": "pending",
        "created_at": now.isoformat(),
        "updated_at": now.isoformat()
    }
    
    await db.orders.insert_one(order_dict)
    
    for item in input.items:
        await db.products.update_one(
            {"id": item.product_id},
            {"$inc": {"stock": -item.quantity}, "$set": {"updated_at": now.isoformat()}}
        )
    
    # Send notification for new order
    try:
        from services.notifications import notify_new_order
        await notify_new_order(db, order_dict)
    except Exception as e:
        logging.error(f"Failed to send new order notification: {e}")
    
    if 'created_at' in order_dict and isinstance(order_dict['created_at'], str):
        order_dict['created_at'] = datetime.fromisoformat(order_dict['created_at'])
    elif 'created_at' not in order_dict:
        order_dict['created_at'] = datetime.now(timezone.utc)
    if 'updated_at' in order_dict and isinstance(order_dict['updated_at'], str):
        order_dict['updated_at'] = datetime.fromisoformat(order_dict['updated_at'])
    elif 'updated_at' not in order_dict:
        order_dict['updated_at'] = datetime.now(timezone.utc)
    return Order(**order_dict)

@api_router.get("/orders", response_model=List[Order])
async def get_orders(current_user: dict = Depends(get_current_user)):
    query = {}
    
    if current_user["role"] == "customer":
        # Customers see only their orders
        query["customer_email"] = current_user["email"]
    elif current_user.get("role") != "super_admin" and current_user.get("showroom_id"):
        # Staff assigned to a showroom can only see their showroom's orders
        query["showroom_id"] = current_user["showroom_id"]
    # Super admin and unassigned admins see all orders
    
    orders = await db.orders.find(query, {"_id": 0}).sort("created_at", -1).to_list(100000)
    
    for order in orders:
        if isinstance(order['created_at'], str):
            order['created_at'] = datetime.fromisoformat(order['created_at'])
        if isinstance(order['updated_at'], str):
            order['updated_at'] = datetime.fromisoformat(order['updated_at'])
    
    return orders

@api_router.put("/orders/{order_id}/status", response_model=Order)
async def update_order_status(order_id: str, input: OrderStatusUpdate, current_user: dict = Depends(get_current_user)):
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    # Get current order for notification
    old_order = await db.orders.find_one({"id": order_id}, {"_id": 0})
    old_status = old_order.get("status") if old_order else "unknown"
    
    update_data = {
        "status": input.status,
        "updated_at": datetime.now(timezone.utc).isoformat()
    }
    
    result = await db.orders.update_one({"id": order_id}, {"$set": update_data})
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Order not found")
    
    order = await db.orders.find_one({"id": order_id}, {"_id": 0})
    
    # Send notification for status change
    if old_status != input.status:
        try:
            from services.notifications import notify_order_status_change
            await notify_order_status_change(db, order, old_status, input.status)
        except Exception as e:
            logging.error(f"Failed to send order status notification: {e}")
    
    if isinstance(order['created_at'], str):
        order['created_at'] = datetime.fromisoformat(order['created_at'])
    if isinstance(order['updated_at'], str):
        order['updated_at'] = datetime.fromisoformat(order['updated_at'])
    
    return Order(**order)

@api_router.get("/dashboard/stats", response_model=DashboardStats)
async def get_dashboard_stats(current_user: dict = Depends(get_current_user)):
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    # Build showroom filter for non-super-admin users
    showroom_filter = {}
    user_showroom_id = current_user.get("showroom_id")
    if current_user.get("role") != "super_admin" and user_showroom_id:
        showroom_filter["showroom_id"] = user_showroom_id
    
    total_products = await db.products.count_documents({})
    
    products = await db.products.find({}, {"_id": 0, "stock": 1, "reorder_level": 1}).to_list(100000)
    low_stock_count = sum(1 for p in products if p.get('stock', 0) <= p.get('reorder_level', 10))
    
    # Filter orders by showroom
    total_orders = await db.orders.count_documents(showroom_filter)
    pending_orders = await db.orders.count_documents({**showroom_filter, "status": "pending"})
    
    orders = await db.orders.find(showroom_filter, {"_id": 0, "total_amount": 1}).to_list(100000)
    total_revenue = sum(order.get('total_amount', 0) for order in orders)
    
    # Also include invoice revenue for the showroom
    invoices = await db.invoices.find(showroom_filter, {"_id": 0, "gross_total": 1}).to_list(100000)
    invoice_revenue = sum(inv.get('gross_total', 0) for inv in invoices)
    total_revenue = max(total_revenue, invoice_revenue)  # Use the higher value
    
    return DashboardStats(
        total_products=total_products,
        low_stock_count=low_stock_count,
        total_orders=total_orders,
        pending_orders=pending_orders,
        total_revenue=total_revenue
    )

@api_router.get("/dashboard/best-sellers")
async def get_best_selling_products(
    period: str = "month",
    limit: int = 5,
    current_user: dict = Depends(get_current_user)
):
    """Get best selling products based on invoice data"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    from collections import defaultdict
    
    # Check if user is super admin (only super admin can see cost/profit)
    is_super_admin = current_user.get("role") == "super_admin"
    
    # Build showroom filter for non-super-admin users
    user_showroom_id = current_user.get("showroom_id")
    showroom_filter = {}
    if not is_super_admin and user_showroom_id:
        showroom_filter["showroom_id"] = user_showroom_id
    
    # Calculate date range
    now = datetime.now(timezone.utc)
    if period == "today":
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    elif period == "week":
        start = now - timedelta(days=7)
    elif period == "month":
        start = now - timedelta(days=30)
    elif period == "year":
        start = now - timedelta(days=365)
    else:
        start = now - timedelta(days=30)
    
    start_str = start.isoformat()
    
    # Get invoices in date range with showroom filter
    query = {"created_at": {"$gte": start_str}, **showroom_filter}
    invoices = await db.invoices.find(
        query,
        {"_id": 0, "line_items": 1}
    ).to_list(100000)
    
    # Aggregate product sales
    product_sales = defaultdict(lambda: {"quantity": 0, "revenue": 0, "name": "", "sku": ""})
    
    for invoice in invoices:
        for item in invoice.get("line_items", []):
            product_id = item.get("product_id")
            if product_id:
                qty = item.get("quantity", 0)
                price = item.get("price", 0)
                discount = item.get("discount", 0)
                item_revenue = qty * price * (1 - discount / 100)
                
                product_sales[product_id]["quantity"] += qty
                product_sales[product_id]["revenue"] += item_revenue
                product_sales[product_id]["name"] = item.get("product_name", "Unknown")
                product_sales[product_id]["sku"] = item.get("sku", "")
    
    # Sort by quantity sold (or revenue)
    top_by_quantity = sorted(
        [{"product_id": pid, **data} for pid, data in product_sales.items()],
        key=lambda x: x["quantity"],
        reverse=True
    )[:limit]
    
    top_by_revenue = sorted(
        [{"product_id": pid, **data} for pid, data in product_sales.items()],
        key=lambda x: x["revenue"],
        reverse=True
    )[:limit]
    
    # Get product details (images, cost) and calculate profit for top sellers (super admin only)
    total_profit = 0
    total_cost = 0
    
    for product in top_by_quantity + top_by_revenue:
        prod = await db.products.find_one({"id": product["product_id"]}, {"_id": 0, "images": 1, "cost": 1})
        product["image"] = prod.get("images", [None])[0] if prod else None
        product["revenue"] = round(product["revenue"], 2)
        
        # Calculate profit (only for super admin)
        if is_super_admin:
            cost = prod.get("cost", 0) if prod else 0
            product["cost"] = cost
            product["total_cost"] = round(cost * product["quantity"], 2)
            product["profit"] = round(product["revenue"] - product["total_cost"], 2)
            product["margin"] = round((product["profit"] / product["revenue"] * 100), 1) if product["revenue"] > 0 else 0
    
    # Calculate overall totals (only for super admin)
    if is_super_admin:
        for pid, data in product_sales.items():
            prod = await db.products.find_one({"id": pid}, {"_id": 0, "cost": 1})
            cost = prod.get("cost", 0) if prod else 0
            item_cost = cost * data["quantity"]
            total_cost += item_cost
            total_profit += data["revenue"] - item_cost
        
        overall_margin = round((total_profit / sum(p["revenue"] for p in product_sales.values()) * 100), 1) if product_sales else 0
    else:
        overall_margin = None
    
    response = {
        "period": period,
        "top_by_quantity": top_by_quantity,
        "top_by_revenue": top_by_revenue,
        "total_products_sold": sum(p["quantity"] for p in product_sales.values()),
        "total_revenue": round(sum(p["revenue"] for p in product_sales.values()), 2),
    }
    
    # Include profit data only for super admin
    if is_super_admin:
        response["total_cost"] = round(total_cost, 2)
        response["total_profit"] = round(total_profit, 2)
        response["overall_margin"] = overall_margin
        response["show_profit"] = True
    else:
        response["show_profit"] = False
    
    return response

@api_router.get("/analytics/showrooms")
async def get_showroom_analytics(
    period: str = "month",  # today, week, month, quarter, year, custom
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    """Get showroom-level sales analytics with time filters.
    Super Admins see all showrooms, other users only see their assigned showroom."""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    from collections import defaultdict
    
    # Check if user is restricted to their showroom
    is_super_admin = current_user.get("role") == "super_admin"
    user_showroom_id = current_user.get("showroom_id")
    
    # Calculate date range based on period
    now = datetime.now(timezone.utc)
    
    if period == "today":
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        end = now
    elif period == "week":
        start = now - timedelta(days=7)
        end = now
    elif period == "month":
        start = now - timedelta(days=30)
        end = now
    elif period == "quarter":
        start = now - timedelta(days=90)
        end = now
    elif period == "year":
        start = now - timedelta(days=365)
        end = now
    elif period == "custom" and start_date and end_date:
        try:
            start = datetime.fromisoformat(start_date.replace("Z", "+00:00"))
            end = datetime.fromisoformat(end_date.replace("Z", "+00:00"))
        except Exception:
            start = now - timedelta(days=30)
            end = now
    else:
        start = now - timedelta(days=30)
        end = now
    
    # Format dates for query (using string comparison since dates are stored as ISO strings)
    start_str = start.isoformat()
    end_str = end.isoformat()
    
    # Build invoice query - filter by showroom for non-super-admin users
    invoice_query = {"created_at": {"$gte": start_str, "$lte": end_str}}
    
    if not is_super_admin and user_showroom_id:
        # Staff/Manager can only see their showroom's data
        invoice_query["showroom_id"] = user_showroom_id
    
    # Get invoices based on user's access level
    invoices = await db.invoices.find(invoice_query, {"_id": 0}).to_list(100000)
    
    # Get all showrooms
    showrooms = await db.showrooms.find({}, {"_id": 0}).to_list(10000)
    showroom_map = {s["id"]: s["name"] for s in showrooms}
    
    # Aggregate data by showroom
    showroom_data = defaultdict(lambda: {
        "revenue": 0,  # Gross total (inc VAT) for display
        "revenue_ex_vat": 0,  # Ex VAT for profit calculation
        "cost": 0,
        "count": 0,
        "total_m2": 0,  # Total square meters sold
        "products": defaultdict(lambda: {"quantity": 0, "m2": 0, "revenue": 0, "revenue_ex_vat": 0, "cost": 0, "name": "", "product_id": ""})
    })
    
    # Daily trends
    daily_data = defaultdict(lambda: {"revenue": 0, "revenue_ex_vat": 0, "cost": 0, "count": 0, "total_m2": 0})
    
    # Cache product costs for super admin profit calculation
    product_costs = {}
    if is_super_admin:
        products = await db.products.find({}, {"_id": 0, "id": 1, "cost": 1}).to_list(100000)
        product_costs = {p["id"]: p.get("cost", 0) or 0 for p in products}
    
    total_revenue = 0
    total_revenue_ex_vat = 0
    total_cost = 0
    total_invoices = len(invoices)
    
    for invoice in invoices:
        showroom_id = invoice.get("showroom_id", "unassigned")
        showroom_name = invoice.get("showroom_name") or showroom_map.get(showroom_id, "Unassigned")
        gross_total = invoice.get("gross_total", 0)
        subtotal = invoice.get("subtotal", 0)  # Ex VAT amount
        
        showroom_data[showroom_id]["revenue"] += gross_total
        showroom_data[showroom_id]["revenue_ex_vat"] += subtotal
        showroom_data[showroom_id]["count"] += 1
        showroom_data[showroom_id]["name"] = showroom_name
        total_revenue += gross_total
        total_revenue_ex_vat += subtotal
        
        # Aggregate top products and calculate cost
        for item in invoice.get("line_items", []):
            product_id = item.get("product_id", "unknown")
            qty = item.get("quantity", 0)
            item_m2 = item.get("m2", 0) or 0  # Square meters for this line item
            price = item.get("price", 0)
            discount = item.get("discount", 0)
            item_revenue = qty * price * (1 - discount / 100)  # This is ex-VAT (line item total)
            
            # Calculate cost for super admin
            item_cost = 0
            if is_super_admin and product_id in product_costs:
                item_cost = qty * product_costs[product_id]
                showroom_data[showroom_id]["cost"] += item_cost
                total_cost += item_cost
            
            # Track m² sold
            showroom_data[showroom_id]["total_m2"] += item_m2
            
            showroom_data[showroom_id]["products"][product_id]["quantity"] += qty
            showroom_data[showroom_id]["products"][product_id]["m2"] += item_m2
            showroom_data[showroom_id]["products"][product_id]["revenue"] += item_revenue  # Ex-VAT revenue
            showroom_data[showroom_id]["products"][product_id]["revenue_ex_vat"] += item_revenue
            showroom_data[showroom_id]["products"][product_id]["cost"] += item_cost
            showroom_data[showroom_id]["products"][product_id]["name"] = item.get("product_name", "Unknown")
            showroom_data[showroom_id]["products"][product_id]["product_id"] = product_id
        
        # Daily trends
        invoice_date = invoice.get("date", "")[:10]  # Get YYYY-MM-DD
        if invoice_date:
            daily_data[invoice_date]["revenue"] += gross_total
            daily_data[invoice_date]["revenue_ex_vat"] += subtotal
            daily_data[invoice_date]["count"] += 1
            # Track daily m² sold
            for item in invoice.get("line_items", []):
                daily_data[invoice_date]["total_m2"] += item.get("m2", 0) or 0
            if is_super_admin:
                # Calculate daily cost
                for item in invoice.get("line_items", []):
                    pid = item.get("product_id", "")
                    qty = item.get("quantity", 0)
                    if pid in product_costs:
                        daily_data[invoice_date]["cost"] += qty * product_costs[pid]
    
    # Build response
    showroom_analytics = []
    for showroom_id, data in showroom_data.items():
        # Get top 5 products by revenue
        top_products = sorted(
            [{"product_id": pid, **pdata} for pid, pdata in data["products"].items()],
            key=lambda x: x["revenue"],
            reverse=True
        )[:5]
        
        # Add profit to top products for super admin (using ex-VAT revenue)
        if is_super_admin:
            for prod in top_products:
                # Profit = Ex-VAT Revenue - Cost
                prod["profit"] = round(prod["revenue_ex_vat"] - prod["cost"], 2)
                prod["margin"] = round((prod["profit"] / prod["revenue_ex_vat"] * 100), 1) if prod["revenue_ex_vat"] > 0 else 0
                prod["cost_per_unit"] = round(prod["cost"] / prod["quantity"], 2) if prod["quantity"] > 0 else 0
                prod["profit_per_unit"] = round(prod["profit"] / prod["quantity"], 2) if prod["quantity"] > 0 else 0
                # Profit per m² - key metric for tiles
                prod["profit_per_m2"] = round(prod["profit"] / prod["m2"], 2) if prod["m2"] > 0 else 0
                prod["revenue_per_m2"] = round(prod["revenue_ex_vat"] / prod["m2"], 2) if prod["m2"] > 0 else 0
                prod["cost_per_m2"] = round(prod["cost"] / prod["m2"], 2) if prod["m2"] > 0 else 0
        
        avg_order = data["revenue"] / data["count"] if data["count"] > 0 else 0
        pct_of_total = (data["revenue"] / total_revenue * 100) if total_revenue > 0 else 0
        
        showroom_entry = {
            "showroom_id": showroom_id,
            "showroom_name": data["name"],
            "total_revenue": round(data["revenue"], 2),  # Gross (inc VAT) for display
            "total_revenue_ex_vat": round(data["revenue_ex_vat"], 2),  # Ex VAT
            "total_m2": round(data["total_m2"], 2),  # Total m² sold
            "invoice_count": data["count"],
            "average_order_value": round(avg_order, 2),
            "top_products": top_products,
            "percentage_of_total": round(pct_of_total, 1)
        }
        
        # Add profit data for super admin (using ex-VAT revenue)
        if is_super_admin:
            showroom_entry["total_cost"] = round(data["cost"], 2)
            # Profit = Ex VAT Revenue - Cost
            showroom_profit = data["revenue_ex_vat"] - data["cost"]
            showroom_entry["total_profit"] = round(showroom_profit, 2)
            showroom_entry["profit_margin"] = round((showroom_profit / data["revenue_ex_vat"] * 100), 1) if data["revenue_ex_vat"] > 0 else 0
            # Profit per m² for the showroom
            showroom_entry["profit_per_m2"] = round(showroom_profit / data["total_m2"], 2) if data["total_m2"] > 0 else 0
        
        showroom_analytics.append(showroom_entry)
    
    # Sort by revenue descending (handle None values)
    showroom_analytics.sort(key=lambda x: x.get("total_revenue") or 0, reverse=True)
    
    # Build daily trends (last 30 days or period)
    daily_trends = []
    for date in sorted(daily_data.keys()):
        trend_entry = {
            "date": date,
            "revenue": round(daily_data[date]["revenue"], 2),
            "revenue_ex_vat": round(daily_data[date]["revenue_ex_vat"], 2),
            "total_m2": round(daily_data[date]["total_m2"], 2),
            "invoices": daily_data[date]["count"]
        }
        if is_super_admin:
            trend_entry["cost"] = round(daily_data[date]["cost"], 2)
            # Profit = Ex VAT Revenue - Cost
            daily_profit = daily_data[date]["revenue_ex_vat"] - daily_data[date]["cost"]
            trend_entry["profit"] = round(daily_profit, 2)
            trend_entry["profit_per_m2"] = round(daily_profit / daily_data[date]["total_m2"], 2) if daily_data[date]["total_m2"] > 0 else 0
            # VAT for this day
            trend_entry["vat"] = round(daily_data[date]["revenue"] - daily_data[date]["revenue_ex_vat"], 2)
        daily_trends.append(trend_entry)
    
    # Calculate total m² sold
    total_m2 = sum(data["total_m2"] for data in showroom_data.values())
    
    # Calculate VAT amount
    total_vat = total_revenue - total_revenue_ex_vat
    
    avg_order_value = total_revenue / total_invoices if total_invoices > 0 else 0
    
    # Get user's showroom name if restricted
    user_showroom_name = None
    if not is_super_admin and user_showroom_id:
        showroom = await db.showrooms.find_one({"id": user_showroom_id}, {"_id": 0, "name": 1})
        user_showroom_name = showroom.get("name") if showroom else None
    
    response = {
        "period": period,
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "total_revenue": round(total_revenue, 2),  # Inc VAT (Gross)
        "total_revenue_ex_vat": round(total_revenue_ex_vat, 2),  # Ex VAT (Net)
        "total_vat": round(total_vat, 2),  # VAT amount
        "total_m2": round(total_m2, 2),
        "total_invoices": total_invoices,
        "average_order_value": round(avg_order_value, 2),
        "showroom_analytics": showroom_analytics,
        "daily_trends": daily_trends,
        "access_level": "all" if is_super_admin else "store",
        "user_showroom_id": user_showroom_id if not is_super_admin else None,
        "user_showroom_name": user_showroom_name
    }
    
    # Add overall profit metrics for super admin (using ex-VAT revenue)
    if is_super_admin:
        total_profit = total_revenue_ex_vat - total_cost
        avg_margin = round((total_profit / total_revenue_ex_vat * 100), 1) if total_revenue_ex_vat > 0 else 0
        response["total_cost"] = round(total_cost, 2)
        response["total_profit"] = round(total_profit, 2)
        response["average_margin"] = avg_margin
        response["profit_per_m2"] = round(total_profit / total_m2, 2) if total_m2 > 0 else 0
        response["show_profit"] = True
    else:
        response["show_profit"] = False
    
    return response

# NOTE: Sales Target Endpoints are now handled by routes/analytics.py
# Duplicate endpoints removed on 2026-01-30 to prevent confusion

# Customer Pricing Endpoints
@api_router.post("/customer-pricing", response_model=CustomerPricing)
async def create_customer_pricing(input: CustomerPricingCreate, current_user: dict = Depends(get_current_user)):
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    from uuid import uuid4
    pricing_id = str(uuid4())
    
    # Check if pricing already exists for this customer-product combination
    existing = await db.customer_pricing.find_one({
        "customer_email": input.customer_email,
        "product_id": input.product_id
    })
    
    if existing:
        old_price = existing.get("custom_price")
        # Update existing pricing
        await db.customer_pricing.update_one(
            {"customer_email": input.customer_email, "product_id": input.product_id},
            {"$set": {"custom_price": input.custom_price}}
        )
        pricing = await db.customer_pricing.find_one({
            "customer_email": input.customer_email,
            "product_id": input.product_id
        }, {"_id": 0})
        
        # Log audit for update
        await log_audit(
            action="UPDATE",
            entity_type="customer_pricing",
            user=current_user,
            entity_id=existing.get("id"),
            entity_name=f"{input.customer_email} - {input.product_id}",
            before_data={"custom_price": old_price},
            after_data={"custom_price": input.custom_price},
            details=f"Updated custom price for {input.customer_email}: £{old_price} -> £{input.custom_price}"
        )
    else:
        # Create new pricing
        pricing_dict = {
            "id": pricing_id,
            "customer_email": input.customer_email,
            "product_id": input.product_id,
            "custom_price": input.custom_price,
            "created_at": datetime.now(timezone.utc).isoformat()
        }
        await db.customer_pricing.insert_one(pricing_dict)
        pricing = pricing_dict
        
        # Log audit for create
        await log_audit(
            action="CREATE",
            entity_type="customer_pricing",
            user=current_user,
            entity_id=pricing_id,
            entity_name=f"{input.customer_email} - {input.product_id}",
            after_data={"customer_email": input.customer_email, "product_id": input.product_id, "custom_price": input.custom_price},
            details=f"Created custom price £{input.custom_price} for {input.customer_email}"
        )
    
    if isinstance(pricing['created_at'], str):
        pricing['created_at'] = datetime.fromisoformat(pricing['created_at'])
    
    return CustomerPricing(**pricing)

@api_router.get("/customer-pricing/template")
async def get_pricing_template(current_user: dict = Depends(get_current_user)):
    """Get list of products for CSV template"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    products = await db.products.find({}, {"_id": 0, "id": 1, "name": 1, "sku": 1, "price": 1}).to_list(100000)
    
    return {
        "products": products,
        "csv_headers": ["customer_email", "product_id", "custom_price"],
        "example_row": ["customer@example.com", products[0]["id"] if products else "product-id-here", "19.99"]
    }


@api_router.get("/customer-pricing/{customer_email}", response_model=List[CustomerPricing])
async def get_customer_pricing(customer_email: str, current_user: dict = Depends(get_current_user)):
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    pricing_list = await db.customer_pricing.find(
        {"customer_email": customer_email},
        {"_id": 0}
    ).to_list(100000)
    
    for pricing in pricing_list:
        if isinstance(pricing['created_at'], str):
            pricing['created_at'] = datetime.fromisoformat(pricing['created_at'])
    
    return pricing_list

@api_router.delete("/customer-pricing/{pricing_id}")
async def delete_customer_pricing(pricing_id: str, current_user: dict = Depends(get_current_user)):
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    # Get pricing info before deleting for audit
    pricing = await db.customer_pricing.find_one({"id": pricing_id}, {"_id": 0})
    
    result = await db.customer_pricing.delete_one({"id": pricing_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Pricing not found")
    
    # Log audit for delete
    if pricing:
        await log_audit(
            action="DELETE",
            entity_type="customer_pricing",
            user=current_user,
            entity_id=pricing_id,
            entity_name=f"{pricing.get('customer_email')} - {pricing.get('product_id')}",
            before_data={"customer_email": pricing.get("customer_email"), "product_id": pricing.get("product_id"), "custom_price": pricing.get("custom_price")},
            details=f"Deleted custom price for {pricing.get('customer_email')}"
        )
    
    return {"message": "Customer pricing deleted successfully"}

@api_router.post("/customer-pricing/bulk-import", response_model=BulkImportResult)
async def bulk_import_customer_pricing(input: BulkPricingImport, current_user: dict = Depends(get_current_user)):
    """Bulk import customer-specific pricing from CSV data"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    from uuid import uuid4
    
    total = len(input.items)
    successful = 0
    failed = 0
    errors = []
    
    # Get all valid product IDs
    products = await db.products.find({}, {"_id": 0, "id": 1}).to_list(100000)
    valid_product_ids = {p["id"] for p in products}
    
    for idx, item in enumerate(input.items, 1):
        try:
            # Validate product exists
            if item.product_id not in valid_product_ids:
                errors.append(f"Row {idx}: Product ID '{item.product_id}' not found")
                failed += 1
                continue
            
            # Validate price
            if item.custom_price < 0:
                errors.append(f"Row {idx}: Invalid price '{item.custom_price}' (must be >= 0)")
                failed += 1
                continue
            
            # Validate email format (basic check)
            if '@' not in item.customer_email:
                errors.append(f"Row {idx}: Invalid email '{item.customer_email}'")
                failed += 1
                continue
            
            # Check if pricing already exists
            existing = await db.customer_pricing.find_one({
                "customer_email": item.customer_email,
                "product_id": item.product_id
            })
            
            if existing:
                # Update existing pricing
                await db.customer_pricing.update_one(
                    {"customer_email": item.customer_email, "product_id": item.product_id},
                    {"$set": {"custom_price": item.custom_price}}
                )
            else:
                # Create new pricing
                pricing_dict = {
                    "id": str(uuid4()),
                    "customer_email": item.customer_email,
                    "product_id": item.product_id,
                    "custom_price": item.custom_price,
                    "created_at": datetime.now(timezone.utc).isoformat()
                }
                await db.customer_pricing.insert_one(pricing_dict)
            
            successful += 1
            
        except Exception as e:
            errors.append(f"Row {idx}: {str(e)}")
            failed += 1
    
    return BulkImportResult(
        total=total,
        successful=successful,
        failed=failed,
        errors=errors[:20]  # Limit errors to first 20
    )

@api_router.get("/products-with-custom-pricing", response_model=List[Product])
async def get_products_with_custom_pricing(current_user: dict = Depends(get_current_user)):
    """Get products with custom pricing applied for the current customer"""
    products = await db.products.find({}, {"_id": 0}).to_list(100000)
    
    for prod in products:
        if isinstance(prod['created_at'], str):
            prod['created_at'] = datetime.fromisoformat(prod['created_at'])
        if isinstance(prod['updated_at'], str):
            prod['updated_at'] = datetime.fromisoformat(prod['updated_at'])
    
    # If customer, check for custom pricing
    if current_user["role"] == "customer":
        custom_pricing = await db.customer_pricing.find(
            {"customer_email": current_user["email"]},
            {"_id": 0}
        ).to_list(100000)
        
        # Create a map of product_id to custom_price
        custom_price_map = {cp["product_id"]: cp["custom_price"] for cp in custom_pricing}
        
        # Apply custom pricing to products
        for product in products:
            if product["id"] in custom_price_map:
                product["price"] = custom_price_map[product["id"]]
    
    return products

# Bulk Inquiry Endpoints
@api_router.post("/bulk-inquiries", response_model=BulkInquiry)
async def create_bulk_inquiry(
    input: BulkInquiryCreate, 
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(get_current_user)
):
    """Submit a bulk order inquiry"""
    from uuid import uuid4
    
    # Get product details
    product = await db.products.find_one({"id": input.product_id}, {"_id": 0})
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    
    inquiry_id = str(uuid4())
    now = datetime.now(timezone.utc)
    
    inquiry_dict = {
        "id": inquiry_id,
        "customer_email": current_user["email"],
        "customer_name": current_user["name"],
        "customer_phone": input.phone,
        "product_id": input.product_id,
        "product_name": product["name"],
        "product_sku": product["sku"],
        "quantity_needed": input.quantity_needed,
        "message": input.message,
        "status": "pending",
        "admin_notes": None,
        "created_at": now.isoformat()
    }
    
    await db.bulk_inquiries.insert_one(inquiry_dict)
    inquiry_dict['created_at'] = now
    
    # Log audit for create
    await log_audit(
        action="CREATE",
        entity_type="bulk_inquiry",
        user=current_user,
        entity_id=inquiry_id,
        entity_name=f"{product['name']} - {input.quantity_needed} units",
        after_data={"product_name": product["name"], "quantity_needed": input.quantity_needed, "customer_email": current_user["email"]},
        details=f"Bulk inquiry submitted for {input.quantity_needed} units of {product['name']}"
    )
    
    # Send email notification to admins
    try:
        # Get all super_admin and admin users' emails
        admin_users = await db.users.find(
            {"role": {"$in": ["super_admin", "admin"]}},
            {"_id": 0, "email": 1}
        ).to_list(10000)
        admin_emails = [u["email"] for u in admin_users if u.get("email")]
        
        if admin_emails:
            from services.email import send_bulk_inquiry_notification
            background_tasks.add_task(
                send_bulk_inquiry_notification,
                admin_emails=admin_emails,
                inquiry_data=inquiry_dict,
                showroom_name=None  # Use default email
            )
    except Exception as e:
        logging.error(f"Failed to queue bulk inquiry notification: {e}")
    
    return BulkInquiry(**inquiry_dict)

@api_router.get("/bulk-inquiries", response_model=List[BulkInquiry])
async def get_bulk_inquiries(
    status: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    """Get bulk inquiries - admin sees all, customer sees their own"""
    query = {}
    
    if not is_admin_user(current_user):
        query["customer_email"] = current_user["email"]
    
    if status:
        query["status"] = status
    
    inquiries = await db.bulk_inquiries.find(query, {"_id": 0}).sort("created_at", -1).to_list(100000)
    
    for inquiry in inquiries:
        if isinstance(inquiry.get('created_at'), str):
            inquiry['created_at'] = datetime.fromisoformat(inquiry['created_at'])
    
    return inquiries

@api_router.put("/bulk-inquiries/{inquiry_id}", response_model=BulkInquiry)
async def update_bulk_inquiry(
    inquiry_id: str,
    input: BulkInquiryUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Update bulk inquiry status (admin only)"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    inquiry = await db.bulk_inquiries.find_one({"id": inquiry_id}, {"_id": 0})
    if not inquiry:
        raise HTTPException(status_code=404, detail="Inquiry not found")
    
    old_status = inquiry.get("status")
    update_data = {k: v for k, v in input.model_dump().items() if v is not None}
    
    if update_data:
        await db.bulk_inquiries.update_one({"id": inquiry_id}, {"$set": update_data})
    
    updated_inquiry = await db.bulk_inquiries.find_one({"id": inquiry_id}, {"_id": 0})
    if isinstance(updated_inquiry.get('created_at'), str):
        updated_inquiry['created_at'] = datetime.fromisoformat(updated_inquiry['created_at'])
    
    # Log audit for update
    await log_audit(
        action="UPDATE",
        entity_type="bulk_inquiry",
        user=current_user,
        entity_id=inquiry_id,
        entity_name=f"{inquiry.get('product_name')} - {inquiry.get('customer_name')}",
        before_data={"status": old_status},
        after_data=update_data,
        details=f"Bulk inquiry status updated: {old_status} -> {update_data.get('status', old_status)}"
    )
    
    return BulkInquiry(**updated_inquiry)

@api_router.delete("/bulk-inquiries/{inquiry_id}")
async def delete_bulk_inquiry(inquiry_id: str, current_user: dict = Depends(get_current_user)):
    """Delete bulk inquiry (admin only)"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    # Get inquiry info before deleting for audit
    inquiry = await db.bulk_inquiries.find_one({"id": inquiry_id}, {"_id": 0})
    
    result = await db.bulk_inquiries.delete_one({"id": inquiry_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Inquiry not found")
    
    # Log audit for delete
    if inquiry:
        await log_audit(
            action="DELETE",
            entity_type="bulk_inquiry",
            user=current_user,
            entity_id=inquiry_id,
            entity_name=f"{inquiry.get('product_name')} - {inquiry.get('customer_name')}",
            before_data={"product_name": inquiry.get("product_name"), "customer_email": inquiry.get("customer_email"), "quantity_needed": inquiry.get("quantity_needed")},
            details=f"Deleted bulk inquiry for {inquiry.get('quantity_needed')} units of {inquiry.get('product_name')}"
        )
    
    return {"message": "Inquiry deleted successfully"}

# Customer Invite Endpoints
# Moved to /routes/invites.py

# Export Endpoints
@api_router.get("/export/inventory/csv")
async def export_inventory_csv(current_user: dict = Depends(get_current_user)):
    """Export inventory to CSV"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    products = await db.products.find({}, {"_id": 0}).to_list(100000)
    
    output = io.StringIO()
    writer = csv.writer(output)
    
    # Header row
    writer.writerow([
        'SKU', 'Name', 'Category', 'Stock', 'm² per Piece', 'Price (£/m²)',
        'Room Lot Qty', 'Room Lot Price', 'Pallet Qty', 'Pallet Price',
        'Clearance', 'Clearance Price', 'Reorder Level', 'Status'
    ])
    
    # Data rows
    for p in products:
        status = 'Low Stock' if p.get('stock', 0) <= p.get('reorder_level', 10) else 'OK'
        writer.writerow([
            p.get('sku', ''),
            p.get('name', ''),
            p.get('category_name', ''),
            p.get('stock', 0),
            p.get('m2_quantity', ''),
            p.get('price', 0),
            p.get('room_lot_quantity', '') if p.get('room_lot_enabled') else '',
            p.get('room_lot_price', '') if p.get('room_lot_enabled') else '',
            p.get('pallet_quantity', '') if p.get('pallet_enabled') else '',
            p.get('pallet_price', '') if p.get('pallet_enabled') else '',
            'Yes' if p.get('clearance') else 'No',
            p.get('clearance_price', '') if p.get('clearance') else '',
            p.get('reorder_level', 10),
            status
        ])
    
    output.seek(0)
    
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={
            "Content-Disposition": f"attachment; filename=inventory_export_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
        }
    )

@api_router.get("/export/inventory/pdf")
async def export_inventory_pdf(current_user: dict = Depends(get_current_user)):
    """Export inventory to PDF"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import inch
    from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
    
    products = await db.products.find({}, {"_id": 0}).to_list(100000)
    
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=landscape(A4), topMargin=0.5*inch, bottomMargin=0.5*inch)
    
    elements = []
    styles = getSampleStyleSheet()
    
    # Title
    title_style = ParagraphStyle(
        'CustomTitle',
        parent=styles['Heading1'],
        fontSize=18,
        spaceAfter=20
    )
    elements.append(Paragraph("Tile Station - Inventory Report", title_style))
    elements.append(Paragraph(f"Generated: {datetime.now().strftime('%d %B %Y, %H:%M')}", styles['Normal']))
    elements.append(Spacer(1, 20))
    
    # Summary stats
    total_products = len(products)
    low_stock = len([p for p in products if p.get('stock', 0) <= p.get('reorder_level', 10)])
    total_stock = sum(p.get('stock', 0) for p in products)
    
    summary_data = [
        ['Total Products', 'Low Stock Items', 'Total Stock Pieces'],
        [str(total_products), str(low_stock), str(total_stock)]
    ]
    summary_table = Table(summary_data, colWidths=[2*inch, 2*inch, 2*inch])
    summary_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#1e40af')),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTSIZE', (0, 0), (-1, 0), 10),
        ('FONTSIZE', (0, 1), (-1, 1), 14),
        ('BOTTOMPADDING', (0, 0), (-1, 0), 10),
        ('TOPPADDING', (0, 1), (-1, 1), 10),
        ('GRID', (0, 0), (-1, -1), 1, colors.HexColor('#e5e7eb')),
    ]))
    elements.append(summary_table)
    elements.append(Spacer(1, 30))
    
    # Products table
    elements.append(Paragraph("Product Inventory", styles['Heading2']))
    elements.append(Spacer(1, 10))
    
    # Table header
    table_data = [['SKU', 'Product Name', 'Category', 'Stock', 'Price (£/m²)', 'Reorder', 'Status']]
    
    for p in products:
        status = 'LOW STOCK' if p.get('stock', 0) <= p.get('reorder_level', 10) else 'OK'
        table_data.append([
            p.get('sku', '')[:15],
            p.get('name', '')[:30],
            (p.get('category_name', '') or '-')[:15],
            str(p.get('stock', 0)),
            f"£{p.get('price', 0):.2f}",
            str(p.get('reorder_level', 10)),
            status
        ])
    
    col_widths = [1.2*inch, 2.5*inch, 1.3*inch, 0.8*inch, 1*inch, 0.8*inch, 0.9*inch]
    table = Table(table_data, colWidths=col_widths)
    
    table_style = TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#1e40af')),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
        ('ALIGN', (3, 0), (5, -1), 'CENTER'),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTSIZE', (0, 0), (-1, 0), 9),
        ('FONTSIZE', (0, 1), (-1, -1), 8),
        ('BOTTOMPADDING', (0, 0), (-1, 0), 8),
        ('TOPPADDING', (0, 1), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 1), (-1, -1), 4),
        ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#d1d5db')),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#f9fafb')]),
    ])
    
    # Highlight low stock rows
    for i, p in enumerate(products, start=1):
        if p.get('stock', 0) <= p.get('reorder_level', 10):
            table_style.add('BACKGROUND', (6, i), (6, i), colors.HexColor('#fee2e2'))
            table_style.add('TEXTCOLOR', (6, i), (6, i), colors.HexColor('#dc2626'))
            table_style.add('FONTNAME', (6, i), (6, i), 'Helvetica-Bold')
    
    table.setStyle(table_style)
    elements.append(table)
    
    # Low stock section if any
    low_stock_products = [p for p in products if p.get('stock', 0) <= p.get('reorder_level', 10)]
    if low_stock_products:
        elements.append(Spacer(1, 30))
        elements.append(Paragraph("⚠️ Low Stock Alert", styles['Heading2']))
        elements.append(Spacer(1, 10))
        
        alert_data = [['SKU', 'Product Name', 'Current Stock', 'Reorder Level', 'Shortage']]
        for p in low_stock_products:
            shortage = p.get('reorder_level', 10) - p.get('stock', 0)
            alert_data.append([
                p.get('sku', ''),
                p.get('name', '')[:35],
                str(p.get('stock', 0)),
                str(p.get('reorder_level', 10)),
                str(max(0, shortage))
            ])
        
        alert_table = Table(alert_data, colWidths=[1.2*inch, 3*inch, 1.2*inch, 1.2*inch, 1*inch])
        alert_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#dc2626')),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
            ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
            ('ALIGN', (2, 0), (-1, -1), 'CENTER'),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 0), (-1, -1), 9),
            ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#fecaca')),
            ('BACKGROUND', (0, 1), (-1, -1), colors.HexColor('#fef2f2')),
        ]))
        elements.append(alert_table)
    
    doc.build(elements)
    buffer.seek(0)
    
    return StreamingResponse(
        buffer,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f"attachment; filename=inventory_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.pdf"
        }
    )

@api_router.get("/export/orders/csv")
async def export_orders_csv(current_user: dict = Depends(get_current_user)):
    """Export orders to CSV"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    orders = await db.orders.find({}, {"_id": 0}).sort("created_at", -1).to_list(100000)
    
    output = io.StringIO()
    writer = csv.writer(output)
    
    # Header row
    writer.writerow([
        'Order ID', 'Date', 'Customer Name', 'Customer Email', 'Phone',
        'Items', 'Total Amount (£)', 'Status'
    ])
    
    # Data rows
    for o in orders:
        items_str = '; '.join([f"{i.get('product_name', '')} x{i.get('quantity', 0)}" for i in o.get('items', [])])
        created_at = o.get('created_at', '')
        if isinstance(created_at, str):
            try:
                created_at = datetime.fromisoformat(created_at).strftime('%d/%m/%Y %H:%M')
            except Exception:
                pass
        
        writer.writerow([
            o.get('id', '')[-8:].upper(),
            created_at,
            o.get('customer_name', ''),
            o.get('customer_email', ''),
            o.get('phone_number', ''),
            items_str,
            f"{o.get('total_amount', 0):.2f}",
            o.get('status', 'pending').title()
        ])
    
    output.seek(0)
    
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={
            "Content-Disposition": f"attachment; filename=orders_export_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
        }
    )

@api_router.get("/export/orders/pdf")
async def export_orders_pdf(current_user: dict = Depends(get_current_user)):
    """Export orders to PDF"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import inch
    from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
    
    orders = await db.orders.find({}, {"_id": 0}).sort("created_at", -1).to_list(100000)
    
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=landscape(A4), topMargin=30, bottomMargin=30)
    elements = []
    styles = getSampleStyleSheet()
    
    # Title
    title_style = ParagraphStyle(
        'CustomTitle',
        parent=styles['Heading1'],
        fontSize=18,
        textColor=colors.HexColor('#1e40af'),
        spaceAfter=20
    )
    elements.append(Paragraph("Tile Station - Orders Report", title_style))
    elements.append(Paragraph(f"Generated: {datetime.now().strftime('%d %B %Y, %H:%M')}", styles['Normal']))
    elements.append(Spacer(1, 20))
    
    # Summary stats
    total_orders = len(orders)
    pending_orders = len([o for o in orders if o.get('status') == 'pending'])
    completed_orders = len([o for o in orders if o.get('status') == 'completed'])
    total_revenue = sum(o.get('total_amount', 0) for o in orders)
    
    summary_data = [
        ['Total Orders', 'Pending', 'Completed', 'Total Revenue'],
        [str(total_orders), str(pending_orders), str(completed_orders), f"£{total_revenue:.2f}"]
    ]
    summary_table = Table(summary_data, colWidths=[1.8*inch, 1.5*inch, 1.5*inch, 1.8*inch])
    summary_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#1e40af')),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTSIZE', (0, 0), (-1, 0), 10),
        ('FONTSIZE', (0, 1), (-1, 1), 14),
        ('BOTTOMPADDING', (0, 0), (-1, 0), 10),
        ('TOPPADDING', (0, 1), (-1, 1), 10),
        ('GRID', (0, 0), (-1, -1), 1, colors.HexColor('#e5e7eb')),
    ]))
    elements.append(summary_table)
    elements.append(Spacer(1, 30))
    
    # Orders table
    elements.append(Paragraph("Order Details", styles['Heading2']))
    elements.append(Spacer(1, 10))
    
    # Table header
    table_data = [['Order ID', 'Date', 'Customer', 'Items', 'Total', 'Status']]
    
    for o in orders:
        created_at = o.get('created_at', '')
        if isinstance(created_at, str):
            try:
                created_at = datetime.fromisoformat(created_at).strftime('%d/%m/%Y')
            except Exception:
                created_at = ''
        elif hasattr(created_at, 'strftime'):
            created_at = created_at.strftime('%d/%m/%Y')
        
        items_list = o.get('items', [])
        items_str = ', '.join([f"{i.get('product_name', '')[:20]} x{i.get('quantity', 0)}" for i in items_list[:3]])
        if len(items_list) > 3:
            items_str += f" +{len(items_list) - 3} more"
        
        status = o.get('status', 'pending').title()
        
        table_data.append([
            o.get('id', '')[-8:].upper(),
            created_at,
            o.get('customer_name', '')[:25],
            items_str[:40],
            f"£{o.get('total_amount', 0):.2f}",
            status
        ])
    
    col_widths = [1.1*inch, 0.9*inch, 2*inch, 3*inch, 1*inch, 1*inch]
    table = Table(table_data, colWidths=col_widths)
    
    table_style = TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#1e40af')),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
        ('ALIGN', (4, 0), (5, -1), 'CENTER'),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTSIZE', (0, 0), (-1, 0), 9),
        ('FONTSIZE', (0, 1), (-1, -1), 8),
        ('BOTTOMPADDING', (0, 0), (-1, 0), 8),
        ('TOPPADDING', (0, 1), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 1), (-1, -1), 4),
        ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#d1d5db')),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#f9fafb')]),
    ])
    
    # Color code status column
    for i, o in enumerate(orders, start=1):
        status = o.get('status', 'pending')
        if status == 'pending':
            table_style.add('BACKGROUND', (5, i), (5, i), colors.HexColor('#fef3c7'))
            table_style.add('TEXTCOLOR', (5, i), (5, i), colors.HexColor('#92400e'))
        elif status == 'completed':
            table_style.add('BACKGROUND', (5, i), (5, i), colors.HexColor('#d1fae5'))
            table_style.add('TEXTCOLOR', (5, i), (5, i), colors.HexColor('#065f46'))
        elif status == 'cancelled':
            table_style.add('BACKGROUND', (5, i), (5, i), colors.HexColor('#fee2e2'))
            table_style.add('TEXTCOLOR', (5, i), (5, i), colors.HexColor('#dc2626'))
        elif status == 'processing':
            table_style.add('BACKGROUND', (5, i), (5, i), colors.HexColor('#dbeafe'))
            table_style.add('TEXTCOLOR', (5, i), (5, i), colors.HexColor('#1e40af'))
    
    table.setStyle(table_style)
    elements.append(table)
    
    doc.build(elements)
    buffer.seek(0)
    
    return StreamingResponse(
        buffer,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f"attachment; filename=orders_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.pdf"
        }
    )

# ============ SHOWROOM ENDPOINTS ============
# Moved to /routes/showrooms.py

# ============ CUSTOMER MANAGEMENT ENDPOINTS ============
# Moved to /routes/customers.py

# ============ USER MANAGEMENT ENDPOINTS (Super Admin Only) ============
# Moved to /routes/admin.py

# ============ AUDIT LOG ENDPOINTS (Super Admin Only) ============
# Moved to /routes/audit.py

# ============ STAFF INVITE ENDPOINTS (Super Admin Only) ============
# Moved to /routes/invites.py


class EmailAttachment(BaseModel):
    name: str
    type: str
    size: int
    content: str  # Base64 encoded content

class ManualEmailRequest(BaseModel):
    to_emails: List[str]  # Multiple recipients
    to_name: Optional[str] = None
    cc_emails: Optional[List[str]] = None  # CC recipients
    bcc_emails: Optional[List[str]] = None  # BCC recipients
    subject: str
    body: str
    showroom_id: str
    showroom_name: Optional[str] = None
    attachments: Optional[List[EmailAttachment]] = None


@api_router.post("/emails/send")
async def send_manual_email(
    data: ManualEmailRequest,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(get_current_user)
):
    """Send a manual email (admin only)"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    from services.email import get_showroom_email, RESEND_AVAILABLE, RESEND_API_KEY
    
    if not RESEND_AVAILABLE or not RESEND_API_KEY:
        raise HTTPException(status_code=503, detail="Email service not configured")
    
    # Get showroom info
    showroom = await db.showrooms.find_one({"id": data.showroom_id}, {"_id": 0})
    if not showroom:
        raise HTTPException(status_code=404, detail="Store not found")
    
    showroom_name = showroom.get("name", "Tile Station")
    from_email = get_showroom_email(showroom_name)
    
    # Convert plain text body to HTML
    html_body = data.body.replace('\n', '<br>')
    
    html_content = f"""
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #1a1a2e; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0; color: #f0c14b;">TILE STATION</h1>
            <p style="margin: 5px 0 0 0; font-size: 14px;">{showroom_name}</p>
        </div>
        
        <div style="padding: 30px; background: #f9f9f9;">
            {html_body}
        </div>
        
        <div style="background: #1a1a2e; color: #888; padding: 15px; text-align: center; font-size: 12px;">
            <p style="margin: 0;">{showroom_name} - Tile Station</p>
            <p style="margin: 5px 0 0 0;">Tel: 01474 878 989 | Email: {from_email}</p>
        </div>
    </div>
    """
    
    import resend
    resend.api_key = RESEND_API_KEY
    
    try:
        email_params = {
            "from": f"{showroom_name} - Tile Station <{from_email}>",
            "to": data.to_emails,  # Multiple recipients
            "subject": data.subject,
            "html": html_content
        }
        
        # Add CC recipients if provided
        if data.cc_emails and len(data.cc_emails) > 0:
            email_params["cc"] = data.cc_emails
        
        # Add BCC recipients if provided
        if data.bcc_emails and len(data.bcc_emails) > 0:
            email_params["bcc"] = data.bcc_emails
        
        # Add attachments if provided
        if data.attachments and len(data.attachments) > 0:
            import base64
            attachments_list = []
            for att in data.attachments:
                attachments_list.append({
                    "filename": att.name,
                    "content": att.content,  # Already base64 encoded
                    "content_type": att.type
                })
            email_params["attachments"] = attachments_list
        
        await asyncio.to_thread(resend.Emails.send, email_params)
    except Exception as e:
        logging.error(f"Failed to send manual email: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to send email: {str(e)}")
    
    # Format recipient list for display
    to_emails_str = ", ".join(data.to_emails)
    
    # Store email in history
    email_record = {
        "id": str(uuid.uuid4()),
        "to_email": to_emails_str,  # Comma-separated for display
        "to_emails": data.to_emails,  # Full list
        "to_name": data.to_name,
        "cc_emails": data.cc_emails or [],
        "bcc_emails": data.bcc_emails or [],
        "subject": data.subject,
        "body": data.body,
        "showroom_id": data.showroom_id,
        "showroom_name": showroom_name,
        "from_email": from_email,
        "sent_by": current_user["email"],
        "sent_by_name": current_user.get("name"),
        "has_attachments": data.attachments is not None and len(data.attachments) > 0,
        "attachment_count": len(data.attachments) if data.attachments else 0,
        "attachment_names": [att.name for att in data.attachments] if data.attachments else [],
        "sent_at": datetime.now(timezone.utc).isoformat()
    }
    await db.email_history.insert_one(email_record)
    
    # Log audit
    await log_audit(
        action="CREATE",
        entity_type="email",
        user=current_user,
        entity_id=email_record["id"],
        entity_name=f"Email to {to_emails_str}",
        details=f"Manual email sent to {to_emails_str}: {data.subject}"
    )
    
    return {
        "message": f"Email sent to {len(data.to_emails)} recipient(s)",
        "email_id": email_record["id"]
    }


@api_router.get("/emails/history")
async def get_email_history(
    limit: int = 100,
    current_user: dict = Depends(get_current_user)
):
    """Get email history (admin only)"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    emails = await db.email_history.find({}, {"_id": 0}).sort("sent_at", -1).to_list(limit)
    return emails


# ============ NOTIFICATION SETTINGS ENDPOINTS ============

from services.notifications import NOTIFICATION_TYPES, get_default_settings

class NotificationSettingsUpdate(BaseModel):
    enabled: Optional[bool] = None
    recipients: Optional[List[str]] = None
    notifications: Optional[Dict[str, bool]] = None
    low_stock_threshold: Optional[int] = None
    showroom_specific: Optional[bool] = None


@api_router.get("/notifications/settings")
async def get_notification_settings(current_user: dict = Depends(get_current_user)):
    """Get notification settings (super admin only)"""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super Admin access required")
    
    settings = await db.notification_settings.find_one({"type": "global"}, {"_id": 0})
    if not settings:
        settings = get_default_settings()
        settings["type"] = "global"
        settings["id"] = str(uuid.uuid4())
        await db.notification_settings.insert_one({**settings})
    
    return {
        "settings": settings,
        "notification_types": NOTIFICATION_TYPES
    }


@api_router.patch("/notifications/settings")
async def update_notification_settings(
    data: NotificationSettingsUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Update notification settings (super admin only)"""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super Admin access required")
    
    updates = {}
    if data.enabled is not None:
        updates["enabled"] = data.enabled
    if data.recipients is not None:
        updates["recipients"] = data.recipients
    if data.notifications is not None:
        # Merge with existing notifications
        existing = await db.notification_settings.find_one({"type": "global"}, {"_id": 0})
        if existing and "notifications" in existing:
            merged = {**existing["notifications"], **data.notifications}
            updates["notifications"] = merged
        else:
            updates["notifications"] = data.notifications
    if data.low_stock_threshold is not None:
        updates["low_stock_threshold"] = data.low_stock_threshold
    if data.showroom_specific is not None:
        updates["showroom_specific"] = data.showroom_specific
    
    if updates:
        await db.notification_settings.update_one(
            {"type": "global"},
            {"$set": updates},
            upsert=True
        )
        
        # Log audit
        await log_audit(
            action="UPDATE",
            entity_type="notification_settings",
            user=current_user,
            entity_id="global",
            entity_name="Notification Settings",
            details=f"Updated notification settings: {list(updates.keys())}"
        )
    
    return {"message": "Settings updated successfully"}


@api_router.get("/notifications/logs")
async def get_notification_logs(
    limit: int = 100,
    current_user: dict = Depends(get_current_user)
):
    """Get notification logs (super admin only)"""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super Admin access required")
    
    logs = await db.notification_logs.find({}, {"_id": 0}).sort("sent_at", -1).to_list(limit)
    return logs


@api_router.post("/notifications/test")
async def send_test_notification(current_user: dict = Depends(get_current_user)):
    """Send a test notification email (super admin only)"""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super Admin access required")
    
    from services.notifications import send_notification_email, get_notification_html
    
    settings = await db.notification_settings.find_one({"type": "global"}, {"_id": 0})
    if not settings or not settings.get("enabled"):
        raise HTTPException(status_code=400, detail="Notifications are disabled")
    
    recipients = settings.get("recipients", [])
    if not recipients:
        raise HTTPException(status_code=400, detail="No recipients configured")
    
    content = """
    <p>This is a test notification from Tile Station.</p>
    <p>If you received this email, your notification settings are configured correctly!</p>
    <table style="width: 100%; border-collapse: collapse; margin: 15px 0;">
        <tr style="background: #dcfce7;">
            <td style="padding: 10px; border: 1px solid #ddd;"><strong>Status</strong></td>
            <td style="padding: 10px; border: 1px solid #ddd; color: #16a34a;">✓ Working</td>
        </tr>
    </table>
    """
    
    success = await send_notification_email(
        db,
        "test",
        "🧪 Test Notification - Tile Station",
        get_notification_html("Test Notification", content),
        None
    )
    
    if success:
        return {"message": f"Test notification sent to {len(recipients)} recipient(s)"}
    else:
        raise HTTPException(status_code=500, detail="Failed to send test notification")


# ============ EMAIL INBOX ENDPOINTS ============

class InboxEmailReply(BaseModel):
    subject: str
    body: str
    showroom_id: Optional[str] = None


@api_router.post("/emails/webhook")
async def email_webhook(request: Request):
    """Webhook endpoint to receive incoming emails from Resend.
    Configure this URL in Resend dashboard: https://resend.com/webhooks
    """
    try:
        payload = await request.json()
        
        # Resend sends different event types
        event_type = payload.get("type", "")
        
        if event_type == "email.received" or "from" in payload:
            # Extract email data - handle both direct payload and nested data
            email_data = payload.get("data", payload)
            
            from_email = email_data.get("from", "")
            from_name = ""
            
            # Parse "Name <email>" format
            if isinstance(from_email, str) and "<" in from_email:
                parts = from_email.split("<")
                from_name = parts[0].strip().strip('"')
                from_email = parts[1].rstrip(">").strip()
            elif isinstance(from_email, dict):
                from_name = from_email.get("name", "")
                from_email = from_email.get("email", "")
            
            to_email = email_data.get("to", [])
            if isinstance(to_email, list) and len(to_email) > 0:
                to_email = to_email[0] if isinstance(to_email[0], str) else to_email[0].get("email", "")
            
            # Determine which showroom received the email
            showroom_id = None
            showroom_name = None
            showroom_emails = {
                "gravesend@tilestation.co.uk": ("gravesend", "Gravesend"),
                "tonbridge@tilestation.co.uk": ("tonbridge", "Tonbridge"),
                "chingford@tilestation.co.uk": ("chingford", "Chingford"),
                "sydenham@tilestation.co.uk": ("sydenham", "Sydenham"),
            }
            
            to_lower = to_email.lower() if isinstance(to_email, str) else ""
            for email, (sid, sname) in showroom_emails.items():
                if email in to_lower:
                    # Look up showroom ID from database
                    showroom = await db.showrooms.find_one({"name": {"$regex": sname, "$options": "i"}}, {"_id": 0})
                    if showroom:
                        showroom_id = showroom.get("id")
                        showroom_name = showroom.get("name")
                    else:
                        showroom_name = sname
                    break
            
            # Create inbox record
            inbox_email = {
                "id": str(uuid.uuid4()),
                "from_email": from_email,
                "from_name": from_name,
                "to_email": to_email,
                "subject": email_data.get("subject", "(No Subject)"),
                "body_text": email_data.get("text", ""),
                "body_html": email_data.get("html", ""),
                "showroom_id": showroom_id,
                "showroom_name": showroom_name,
                "is_read": False,
                "is_starred": False,
                "is_archived": False,
                "thread_id": email_data.get("thread_id") or email_data.get("in_reply_to"),
                "message_id": email_data.get("message_id") or email_data.get("id"),
                "received_at": datetime.now(timezone.utc).isoformat(),
                "attachments": email_data.get("attachments", [])
            }
            
            await db.email_inbox.insert_one(inbox_email)
            
            logging.info(f"Email received from {from_email}: {inbox_email['subject']}")
            
        return {"status": "ok"}
        
    except Exception as e:
        logging.error(f"Email webhook error: {e}")
        return {"status": "error", "message": str(e)}


@api_router.get("/emails/inbox")
async def get_inbox(
    showroom_id: Optional[str] = None,
    is_read: Optional[bool] = None,
    is_starred: Optional[bool] = None,
    is_archived: Optional[bool] = None,
    search: Optional[str] = None,
    limit: int = 50,
    skip: int = 0,
    current_user: dict = Depends(get_current_user)
):
    """Get inbox emails (admin only)"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    # Build query
    query = {}
    
    if showroom_id:
        query["showroom_id"] = showroom_id
    
    if is_read is not None:
        query["is_read"] = is_read
    
    if is_starred is not None:
        query["is_starred"] = is_starred
    
    if is_archived is not None:
        query["is_archived"] = is_archived
    else:
        # By default, don't show archived
        query["is_archived"] = False
    
    if search:
        query["$or"] = [
            {"from_email": {"$regex": search, "$options": "i"}},
            {"from_name": {"$regex": search, "$options": "i"}},
            {"subject": {"$regex": search, "$options": "i"}},
            {"body_text": {"$regex": search, "$options": "i"}}
        ]
    
    # Get total count
    total = await db.email_inbox.count_documents(query)
    
    # Get emails
    emails = await db.email_inbox.find(query, {"_id": 0}).sort("received_at", -1).skip(skip).limit(limit).to_list(limit)
    
    # Get unread count
    unread_count = await db.email_inbox.count_documents({"is_read": False, "is_archived": False})
    
    return {
        "emails": emails,
        "total": total,
        "unread_count": unread_count,
        "skip": skip,
        "limit": limit
    }


@api_router.get("/emails/inbox/stats")
async def get_inbox_stats(current_user: dict = Depends(get_current_user)):
    """Get inbox statistics"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    total = await db.email_inbox.count_documents({"is_archived": False})
    unread = await db.email_inbox.count_documents({"is_read": False, "is_archived": False})
    starred = await db.email_inbox.count_documents({"is_starred": True, "is_archived": False})
    archived = await db.email_inbox.count_documents({"is_archived": True})
    
    # Get counts by showroom
    pipeline = [
        {"$match": {"is_archived": False}},
        {"$group": {"_id": "$showroom_name", "count": {"$sum": 1}}}
    ]
    by_showroom = await db.email_inbox.aggregate(pipeline).to_list(10000)
    
    return {
        "total": total,
        "unread": unread,
        "starred": starred,
        "archived": archived,
        "by_showroom": {item["_id"] or "Unknown": item["count"] for item in by_showroom}
    }


@api_router.get("/emails/inbox/{email_id}")
async def get_inbox_email(
    email_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Get a single inbox email and mark as read"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    email = await db.email_inbox.find_one({"id": email_id}, {"_id": 0})
    if not email:
        raise HTTPException(status_code=404, detail="Email not found")
    
    # Mark as read
    if not email.get("is_read"):
        await db.email_inbox.update_one(
            {"id": email_id},
            {"$set": {"is_read": True, "read_at": datetime.now(timezone.utc).isoformat()}}
        )
        email["is_read"] = True
    
    return email


@api_router.patch("/emails/inbox/bulk")
async def bulk_update_inbox(
    email_ids: List[str] = Body(...),
    is_read: Optional[bool] = None,
    is_starred: Optional[bool] = None,
    is_archived: Optional[bool] = None,
    current_user: dict = Depends(get_current_user)
):
    """Bulk update multiple inbox emails"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    update_data = {}
    if is_read is not None:
        update_data["is_read"] = is_read
    if is_starred is not None:
        update_data["is_starred"] = is_starred
    if is_archived is not None:
        update_data["is_archived"] = is_archived
    
    if update_data:
        result = await db.email_inbox.update_many(
            {"id": {"$in": email_ids}},
            {"$set": update_data}
        )
        return {"message": f"Updated {result.modified_count} emails"}
    
    return {"message": "No updates provided"}


@api_router.patch("/emails/inbox/{email_id}")
async def update_inbox_email(
    email_id: str,
    is_read: Optional[bool] = None,
    is_starred: Optional[bool] = None,
    is_archived: Optional[bool] = None,
    current_user: dict = Depends(get_current_user)
):
    """Update inbox email status (read, starred, archived)"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    email = await db.email_inbox.find_one({"id": email_id})
    if not email:
        raise HTTPException(status_code=404, detail="Email not found")
    
    update_data = {}
    if is_read is not None:
        update_data["is_read"] = is_read
        if is_read:
            update_data["read_at"] = datetime.now(timezone.utc).isoformat()
    if is_starred is not None:
        update_data["is_starred"] = is_starred
    if is_archived is not None:
        update_data["is_archived"] = is_archived
        if is_archived:
            update_data["archived_at"] = datetime.now(timezone.utc).isoformat()
    
    if update_data:
        await db.email_inbox.update_one({"id": email_id}, {"$set": update_data})
    
    return {"message": "Email updated", "email_id": email_id}


@api_router.delete("/emails/inbox/{email_id}")
async def delete_inbox_email(
    email_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Permanently delete an inbox email"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    result = await db.email_inbox.delete_one({"id": email_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Email not found")
    
    return {"message": "Email deleted"}


@api_router.post("/emails/inbox/{email_id}/reply")
async def reply_to_inbox_email(
    email_id: str,
    reply: InboxEmailReply,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(get_current_user)
):
    """Reply to an inbox email"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    from services.email import get_showroom_email, RESEND_AVAILABLE, RESEND_API_KEY
    
    if not RESEND_AVAILABLE or not RESEND_API_KEY:
        raise HTTPException(status_code=503, detail="Email service not configured")
    
    # Get original email
    original = await db.email_inbox.find_one({"id": email_id}, {"_id": 0})
    if not original:
        raise HTTPException(status_code=404, detail="Email not found")
    
    # Determine showroom to send from
    showroom_id = reply.showroom_id or original.get("showroom_id")
    showroom_name = original.get("showroom_name", "Tile Station")
    
    if showroom_id:
        showroom = await db.showrooms.find_one({"id": showroom_id}, {"_id": 0})
        if showroom:
            showroom_name = showroom.get("name", showroom_name)
    
    from_email = get_showroom_email(showroom_name)
    
    # Convert plain text to HTML
    html_body = reply.body.replace('\n', '<br>')
    
    html_content = f"""
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #1a1a2e; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0; color: #f0c14b;">TILE STATION</h1>
            <p style="margin: 5px 0 0 0; font-size: 14px;">{showroom_name}</p>
        </div>
        
        <div style="padding: 30px; background: #f9f9f9;">
            {html_body}
        </div>
        
        <div style="padding: 20px; background: #e9e9e9; border-left: 4px solid #1a1a2e;">
            <p style="margin: 0 0 10px 0; color: #666; font-size: 12px;">
                <strong>On {original.get('received_at', '')[:10]}, {original.get('from_name') or original.get('from_email')} wrote:</strong>
            </p>
            <div style="color: #666; font-size: 13px;">
                {original.get('body_html') or original.get('body_text', '').replace(chr(10), '<br>')}
            </div>
        </div>
        
        <div style="background: #1a1a2e; color: #888; padding: 15px; text-align: center; font-size: 12px;">
            <p style="margin: 0;">{showroom_name} - Tile Station</p>
            <p style="margin: 5px 0 0 0;">Tel: 01474 878 989 | Email: {from_email}</p>
        </div>
    </div>
    """
    
    import resend
    resend.api_key = RESEND_API_KEY
    
    try:
        await asyncio.to_thread(resend.Emails.send, {
            "from": f"{showroom_name} - Tile Station <{from_email}>",
            "to": [original.get("from_email")],
            "subject": reply.subject,
            "html": html_content,
            "reply_to": from_email
        })
    except Exception as e:
        logging.error(f"Failed to send reply: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to send reply: {str(e)}")
    
    # Store reply in email history
    reply_record = {
        "id": str(uuid.uuid4()),
        "to_email": original.get("from_email"),
        "to_name": original.get("from_name"),
        "subject": reply.subject,
        "body": reply.body,
        "showroom_id": showroom_id,
        "showroom_name": showroom_name,
        "from_email": from_email,
        "sent_by": current_user["email"],
        "sent_by_name": current_user.get("name"),
        "sent_at": datetime.now(timezone.utc).isoformat(),
        "in_reply_to": email_id,
        "original_subject": original.get("subject")
    }
    await db.email_history.insert_one(reply_record)
    
    # Mark original as read if not already
    await db.email_inbox.update_one(
        {"id": email_id},
        {"$set": {"is_read": True, "replied_at": datetime.now(timezone.utc).isoformat()}}
    )
    
    return {
        "message": f"Reply sent to {original.get('from_email')}",
        "reply_id": reply_record["id"]
    }


# Staff Invites Send Email - Moved to /routes/invites.py

# ============ MARKETING CAMPAIGN ENDPOINTS ============

@api_router.get("/marketing/campaigns")
async def get_campaigns(current_user: dict = Depends(get_current_user)):
    """Get all marketing campaigns (admin only)"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    campaigns = await db.marketing_campaigns.find({}, {"_id": 0}).sort("created_at", -1).to_list(100000)
    return campaigns

@api_router.post("/marketing/campaigns")
async def create_campaign(input: MarketingCampaignCreate, current_user: dict = Depends(get_current_user)):
    """Create a new marketing campaign (admin only)"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    from uuid import uuid4
    campaign_id = str(uuid4())
    
    campaign_dict = {
        "id": campaign_id,
        "name": input.name,
        "subject": input.subject,
        "content": input.content,
        "campaign_type": input.campaign_type,
        "target_audience": input.target_audience,
        "target_showroom_id": input.target_showroom_id,
        "status": "draft",
        "sent_count": 0,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "sent_at": None
    }
    
    await db.marketing_campaigns.insert_one({**campaign_dict})
    return campaign_dict

@api_router.post("/marketing/campaigns/{campaign_id}/send")
async def send_campaign(campaign_id: str, current_user: dict = Depends(get_current_user)):
    """Send a marketing campaign to targeted customers (admin only)"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    campaign = await db.marketing_campaigns.find_one({"id": campaign_id}, {"_id": 0})
    if not campaign:
        raise HTTPException(status_code=404, detail="Campaign not found")
    
    if campaign.get("status") == "sent":
        raise HTTPException(status_code=400, detail="Campaign already sent")
    
    # Build query for target customers
    query = {"role": "customer"}
    
    if campaign.get("target_audience") == "opted_in":
        query["marketing_opt_in"] = True
    elif campaign.get("target_audience") == "store" and campaign.get("target_showroom_id"):
        query["showroom_id"] = campaign["target_showroom_id"]
        query["marketing_opt_in"] = True
    
    customers = await db.users.find(query, {"_id": 0, "email": 1, "name": 1}).to_list(100000)
    
    if not customers:
        raise HTTPException(status_code=400, detail="No customers match the target criteria")
    
    # Send emails using Resend
    sent_count = 0
    failed_count = 0
    
    if RESEND_AVAILABLE and RESEND_API_KEY:
        for customer in customers:
            try:
                params = {
                    "from": SENDER_EMAIL,
                    "to": [customer["email"]],
                    "subject": campaign["subject"],
                    "html": f"""
                    <!DOCTYPE html>
                    <html>
                    <head><meta charset="utf-8"></head>
                    <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                        <div style="text-align: center; margin-bottom: 30px;">
                            <h1 style="color: #1e40af;">Tile Station</h1>
                        </div>
                        <p>Dear {customer.get('name', 'Valued Customer')},</p>
                        <div style="margin: 20px 0;">
                            {campaign['content']}
                        </div>
                        <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
                        <p style="color: #888; font-size: 12px; text-align: center;">
                            You received this email because you opted in to marketing communications from Tile Station.
                            <br>To unsubscribe, please contact us.
                        </p>
                    </body>
                    </html>
                    """
                }
                
                await asyncio.to_thread(resend.Emails.send, params)
                sent_count += 1
            except Exception as e:
                logging.error(f"Failed to send email to {customer['email']}: {e}")
                failed_count += 1
    else:
        # Demo mode - just count customers
        sent_count = len(customers)
    
    # Update campaign status
    await db.marketing_campaigns.update_one(
        {"id": campaign_id},
        {"$set": {
            "status": "sent",
            "sent_count": sent_count,
            "sent_at": datetime.now(timezone.utc).isoformat()
        }}
    )
    
    return {
        "message": f"Campaign sent successfully",
        "sent_count": sent_count,
        "failed_count": failed_count,
        "total_recipients": len(customers)
    }

@api_router.delete("/marketing/campaigns/{campaign_id}")
async def delete_campaign(campaign_id: str, current_user: dict = Depends(get_current_user)):
    """Delete a marketing campaign (admin only)"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    result = await db.marketing_campaigns.delete_one({"id": campaign_id})
    
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Campaign not found")
    
    return {"message": "Campaign deleted successfully"}

@api_router.get("/marketing/stats")
async def get_marketing_stats(current_user: dict = Depends(get_current_user)):
    """Get marketing statistics (admin only)"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    total_customers = await db.users.count_documents({"role": "customer"})
    opted_in_customers = await db.users.count_documents({"role": "customer", "marketing_opt_in": True})
    total_campaigns = await db.marketing_campaigns.count_documents({})
    sent_campaigns = await db.marketing_campaigns.count_documents({"status": "sent"})
    
    # Get customers by showroom
    showrooms = await db.showrooms.find({}, {"_id": 0}).to_list(100000)
    showroom_stats = []
    for showroom in showrooms:
        count = await db.users.count_documents({"role": "customer", "showroom_id": showroom["id"]})
        showroom_stats.append({
            "showroom_id": showroom["id"],
            "showroom_name": showroom["name"],
            "customer_count": count
        })
    
    return {
        "total_customers": total_customers,
        "opted_in_customers": opted_in_customers,
        "total_campaigns": total_campaigns,
        "sent_campaigns": sent_campaigns,
        "showroom_stats": showroom_stats
    }

# ============ INVOICE ENDPOINTS ============

@api_router.post("/invoices")
async def save_invoice(input: InvoiceCreate, current_user: dict = Depends(get_current_user)):
    """Save invoice and update product stock (admin only)"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    from uuid import uuid4
    
    # Verify staff PIN if provided
    staff_member = None
    if input.staff_pin:
        staff_member = await db.staff_pins.find_one({"pin": input.staff_pin, "active": True}, {"_id": 0})
        if not staff_member:
            raise HTTPException(status_code=401, detail="Invalid staff PIN")
    
    # Update stock for each item and fetch cost prices
    # Skip stock update for manual products (not in database)
    line_items_with_cost = []
    total_cost = 0
    
    for item in input.line_items:
        item_dict = item.model_dump()
        if item.product_id and item.product_id.strip():
            product = await db.products.find_one({"id": item.product_id}, {"_id": 0})
            if product:
                new_stock = product.get("stock", 0) - int(item.quantity)
                # Allow negative stock - just update it
                
                # Update product stock
                await db.products.update_one(
                    {"id": item.product_id},
                    {"$set": {"stock": new_stock}}
                )
                
                # Store cost_price from product for profit calculation
                cost_price = product.get("cost_price")
                if cost_price:
                    item_dict["cost_price"] = cost_price
                    total_cost += cost_price * item.quantity
            # If product not found, it's a manual entry - skip stock update
        line_items_with_cost.append(item_dict)
    
    # Calculate profit metrics
    net_profit = None
    profit_margin = None
    if total_cost > 0:
        net_profit = input.subtotal - total_cost  # Profit before VAT
        profit_margin = round((net_profit / input.subtotal) * 100, 1) if input.subtotal > 0 else 0
    
    # Save invoice
    invoice_dict = {
        "id": str(uuid4()),
        "invoice_no": input.invoice_no,
        "date": input.date,
        "time": input.time,
        "customer_name": input.customer_name,
        "customer_phone": input.customer_phone,
        "customer_email": input.customer_email,
        "customer_address": input.customer_address,
        "notes": input.notes,
        "sales_person": staff_member["name"] if staff_member else input.sales_person,
        "staff_id": staff_member["id"] if staff_member else None,
        "staff_name": staff_member["name"] if staff_member else None,
        "payment_method": input.payment_method,
        "order_type": input.order_type,
        "showroom_id": input.showroom_id,
        "showroom_name": input.showroom_name,
        "deposits": [d.model_dump() for d in input.deposits] if input.deposits else [],
        "line_items": line_items_with_cost,
        "subtotal": input.subtotal,
        "vat": input.vat,
        "gross_total": input.gross_total,
        "total_savings": input.total_savings,
        "total_cost": total_cost if total_cost > 0 else None,
        "net_profit": net_profit,
        "profit_margin": profit_margin,
        "created_by": current_user["email"],
        "created_at": datetime.now(timezone.utc).isoformat()
    }
    
    # Calculate status based on payment
    # If deposits exist, calculate total deposits and outstanding
    total_deposits = sum(d.amount for d in input.deposits) if input.deposits else 0
    amount_outstanding = input.gross_total - total_deposits
    
    # Determine status:
    # - If paid in full (no outstanding) -> "open_order" (can progress to processing -> completed)
    # - If deposit taken with outstanding amount -> "deposit_order"
    if total_deposits > 0 and amount_outstanding > 0.01:  # Small threshold for float comparison
        invoice_dict["status"] = "deposit_order"
    else:
        invoice_dict["status"] = "open_order"
    
    # Store calculated values
    invoice_dict["total_deposits"] = total_deposits
    invoice_dict["amount_outstanding"] = max(0, amount_outstanding)
    
    await db.invoices.insert_one(invoice_dict)
    
    # Log audit trail
    await log_audit(
        action="CREATE",
        entity_type="invoice",
        user=current_user,
        entity_id=invoice_dict["id"],
        entity_name=invoice_dict["invoice_no"],
        after_data={
            "invoice_no": invoice_dict["invoice_no"],
            "customer_name": invoice_dict.get("customer_name"),
            "gross_total": invoice_dict["gross_total"],
            "showroom_name": invoice_dict.get("showroom_name"),
            "items_count": len(invoice_dict["line_items"])
        },
        details=f"Invoice {invoice_dict['invoice_no']} created for £{invoice_dict['gross_total']:.2f}"
    )
    
    # Send order confirmation email if customer email is provided
    email_sent = False
    if input.customer_email and RESEND_AVAILABLE and RESEND_API_KEY:
        try:
            await send_order_confirmation_email(invoice_dict)
            email_sent = True
        except Exception as e:
            logging.error(f"Failed to send order confirmation email: {e}")
    
    return {
        "message": "Invoice saved and stock updated",
        "invoice_id": invoice_dict["id"],
        "invoice_no": invoice_dict["invoice_no"],
        "staff_name": staff_member["name"] if staff_member else None,
        "email_sent": email_sent
    }

@api_router.get("/invoices")
async def get_invoices(
    current_user: dict = Depends(get_current_user),
    search: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    staff_id: Optional[str] = None,
    showroom_id: Optional[str] = None
):
    """Get all invoices with optional search and filters (admin only)"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    # Build query
    query = {}
    
    # Filter by showroom for non-super-admin users
    user_showroom_id = current_user.get("showroom_id")
    if current_user.get("role") != "super_admin" and user_showroom_id:
        # Staff assigned to a showroom can only see their showroom's invoices
        query["showroom_id"] = user_showroom_id
    elif showroom_id:
        # Optional showroom filter (for super admin filtering)
        query["showroom_id"] = showroom_id
    
    if search:
        # Search in invoice_no, customer_name, customer_phone, customer_email, staff_name
        search_query = [
            {"invoice_no": {"$regex": search, "$options": "i"}},
            {"customer_name": {"$regex": search, "$options": "i"}},
            {"customer_phone": {"$regex": search, "$options": "i"}},
            {"customer_email": {"$regex": search, "$options": "i"}},
            {"staff_name": {"$regex": search, "$options": "i"}},
        ]
        if "$or" not in query:
            query["$or"] = search_query
        else:
            query = {"$and": [query, {"$or": search_query}]}
    
    if staff_id:
        query["staff_id"] = staff_id
    
    invoices = await db.invoices.find(query, {"_id": 0}).sort("created_at", -1).to_list(100000)
    return invoices

@api_router.get("/invoices/{invoice_id}")
async def get_invoice(invoice_id: str, current_user: dict = Depends(get_current_user)):
    """Get single invoice (admin only)"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    invoice = await db.invoices.find_one({"id": invoice_id}, {"_id": 0})
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
    
    # Check showroom access for non-super-admin users
    user_showroom_id = current_user.get("showroom_id")
    if current_user.get("role") != "super_admin" and user_showroom_id:
        if invoice.get("showroom_id") != user_showroom_id:
            raise HTTPException(status_code=403, detail="You can only view invoices from your showroom")
    
    return invoice

@api_router.put("/invoices/{invoice_id}")
async def update_invoice(invoice_id: str, input: InvoiceUpdate, current_user: dict = Depends(get_current_user)):
    """Update an existing invoice (admin only)"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    # Get existing invoice
    existing = await db.invoices.find_one({"id": invoice_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Invoice not found")
    
    # Verify staff PIN if provided
    staff_member = None
    if input.staff_pin:
        staff_member = await db.staff_pins.find_one({"pin": input.staff_pin, "active": True}, {"_id": 0})
        if not staff_member:
            raise HTTPException(status_code=401, detail="Invalid staff PIN")
    
    # Handle stock adjustments if line items changed
    if input.line_items is not None:
        old_items = {item["product_id"]: item["quantity"] for item in existing.get("line_items", []) if item.get("product_id")}
        new_items = {item.product_id: item.quantity for item in input.line_items if item.product_id}
        
        # Restore old stock and apply new stock (only for products in database)
        for product_id, old_qty in old_items.items():
            if product_id and product_id.strip():
                await db.products.update_one(
                    {"id": product_id},
                    {"$inc": {"stock": int(old_qty)}}  # Restore old quantity
                )
        
        for item in input.line_items:
            if item.product_id and item.product_id.strip():
                product = await db.products.find_one({"id": item.product_id}, {"_id": 0})
                if product:
                    new_stock = product.get("stock", 0) - int(item.quantity)
                    # Allow negative stock
                    
                    await db.products.update_one(
                        {"id": item.product_id},
                        {"$set": {"stock": new_stock}}
                    )
                # Skip stock update for manual products not in database
    
    # Build update data
    update_data = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "updated_by": current_user["email"]
    }
    
    if input.invoice_no is not None:
        update_data["invoice_no"] = input.invoice_no
    if input.date is not None:
        update_data["date"] = input.date
    if input.time is not None:
        update_data["time"] = input.time
    if input.customer_name is not None:
        update_data["customer_name"] = input.customer_name
    if input.customer_phone is not None:
        update_data["customer_phone"] = input.customer_phone
    if input.customer_email is not None:
        update_data["customer_email"] = input.customer_email
    if input.customer_address is not None:
        update_data["customer_address"] = input.customer_address
    if input.notes is not None:
        update_data["notes"] = input.notes
    if input.payment_method is not None:
        update_data["payment_method"] = input.payment_method
    if input.line_items is not None:
        update_data["line_items"] = [item.model_dump() for item in input.line_items]
    if input.subtotal is not None:
        update_data["subtotal"] = input.subtotal
    if input.vat is not None:
        update_data["vat"] = input.vat
    if input.gross_total is not None:
        update_data["gross_total"] = input.gross_total
    if input.total_savings is not None:
        update_data["total_savings"] = input.total_savings
    if input.deposits is not None:
        update_data["deposits"] = [d.model_dump() for d in input.deposits]
    
    # Update staff info if PIN provided
    if staff_member:
        update_data["sales_person"] = staff_member["name"]
        update_data["staff_id"] = staff_member["id"]
        update_data["staff_name"] = staff_member["name"]
    elif input.sales_person is not None:
        update_data["sales_person"] = input.sales_person
    
    # Handle status update
    if input.status is not None:
        # Validate status transitions
        valid_statuses = ["open_order", "deposit_order", "processing", "completed"]
        if input.status in valid_statuses:
            update_data["status"] = input.status
    
    # Recalculate status based on deposits if deposits are being updated
    if input.deposits is not None:
        total_deposits = sum(d.amount for d in input.deposits) if input.deposits else 0
        gross_total = input.gross_total if input.gross_total is not None else existing.get("gross_total", 0)
        amount_outstanding = gross_total - total_deposits
        
        update_data["total_deposits"] = total_deposits
        update_data["amount_outstanding"] = max(0, amount_outstanding)
        
        # Auto-update status based on payment if not explicitly set
        if input.status is None:
            current_status = existing.get("status", "open_order")
            # If was deposit_order and now paid in full, move to open_order
            if current_status == "deposit_order" and amount_outstanding <= 0.01:
                update_data["status"] = "open_order"
            # If deposits taken with outstanding, set to deposit_order
            elif total_deposits > 0 and amount_outstanding > 0.01:
                update_data["status"] = "deposit_order"
    
    await db.invoices.update_one({"id": invoice_id}, {"$set": update_data})
    
    # Log audit trail
    before_summary = {
        "invoice_no": existing.get("invoice_no"),
        "customer_name": existing.get("customer_name"),
        "gross_total": existing.get("gross_total"),
        "payment_method": existing.get("payment_method")
    }
    after_summary = {
        "invoice_no": update_data.get("invoice_no", existing.get("invoice_no")),
        "customer_name": update_data.get("customer_name", existing.get("customer_name")),
        "gross_total": update_data.get("gross_total", existing.get("gross_total")),
        "payment_method": update_data.get("payment_method", existing.get("payment_method"))
    }
    await log_audit(
        action="UPDATE",
        entity_type="invoice",
        user=current_user,
        entity_id=invoice_id,
        entity_name=existing.get("invoice_no"),
        before_data=before_summary,
        after_data=after_summary,
        details=f"Invoice {existing.get('invoice_no')} updated"
    )
    
    return {
        "message": "Invoice updated successfully",
        "invoice_id": invoice_id,
        "staff_name": staff_member["name"] if staff_member else None
    }

@api_router.delete("/invoices/{invoice_id}")
async def delete_invoice(invoice_id: str, current_user: dict = Depends(get_current_user)):
    """Delete an invoice and restore stock (admin only)"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    # Get existing invoice
    invoice = await db.invoices.find_one({"id": invoice_id})
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
    
    # Restore stock for all line items (only for products in database)
    for item in invoice.get("line_items", []):
        product_id = item.get("product_id")
        if product_id and product_id.strip():
            await db.products.update_one(
                {"id": product_id},
                {"$inc": {"stock": int(item["quantity"])}}
            )
    
    # Delete the invoice
    await db.invoices.delete_one({"id": invoice_id})
    
    # Log audit trail
    await log_audit(
        action="DELETE",
        entity_type="invoice",
        user=current_user,
        entity_id=invoice_id,
        entity_name=invoice.get("invoice_no"),
        before_data={
            "invoice_no": invoice.get("invoice_no"),
            "customer_name": invoice.get("customer_name"),
            "gross_total": invoice.get("gross_total"),
            "items_count": len(invoice.get("line_items", []))
        },
        details=f"Invoice {invoice.get('invoice_no')} deleted, stock restored"
    )
    
    return {"message": "Invoice deleted and stock restored"}

@api_router.patch("/invoices/{invoice_id}/status")
async def update_invoice_status(
    invoice_id: str, 
    status: str,
    current_user: dict = Depends(get_current_user)
):
    """Update invoice status (admin only).
    Status flow: open_order -> processing -> completed
    Or if deposit: deposit_order -> (paid in full) -> open_order -> processing -> completed
    """
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    valid_statuses = ["open_order", "deposit_order", "processing", "completed"]
    if status not in valid_statuses:
        raise HTTPException(status_code=400, detail=f"Invalid status. Must be one of: {valid_statuses}")
    
    invoice = await db.invoices.find_one({"id": invoice_id})
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
    
    old_status = invoice.get("status", "open_order")
    
    # Update status
    await db.invoices.update_one(
        {"id": invoice_id},
        {"$set": {
            "status": status,
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "updated_by": current_user["email"]
        }}
    )
    
    # Log audit trail
    await log_audit(
        action="UPDATE",
        entity_type="invoice",
        user=current_user,
        entity_id=invoice_id,
        entity_name=invoice.get("invoice_no"),
        before_data={"status": old_status},
        after_data={"status": status},
        details=f"Invoice {invoice.get('invoice_no')} status changed: {old_status} -> {status}"
    )
    
    return {
        "message": f"Invoice status updated to {status}",
        "invoice_id": invoice_id,
        "old_status": old_status,
        "new_status": status
    }


# ============ REFUNDS ENDPOINTS - MOVED TO /routes/refunds.py ============
# The refund functionality has been modularized to /app/backend/routes/refunds.py
# All refund endpoints (GET, POST, PUT, DELETE) are now handled there


class InvoiceStoreUpdate(BaseModel):
    showroom_id: Optional[str] = None
    showroom_name: Optional[str] = None

class BulkInvoiceTransfer(BaseModel):
    invoice_ids: List[str]
    target_showroom_id: str
    target_showroom_name: str


@api_router.patch("/invoices/{invoice_id}/showroom")
async def update_invoice_showroom(
    invoice_id: str, 
    data: InvoiceStoreUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Update invoice showroom assignment (Super Admin only).
    This allows transferring invoices between showrooms for accurate analytics.
    """
    # Restrict to Super Admin only
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super Admin access required for showroom transfers")
    
    invoice = await db.invoices.find_one({"id": invoice_id})
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
    
    old_showroom_id = invoice.get("showroom_id")
    old_showroom_name = invoice.get("showroom_name", "Unassigned")
    
    # Update showroom
    await db.invoices.update_one(
        {"id": invoice_id},
        {"$set": {
            "showroom_id": data.showroom_id,
            "showroom_name": data.showroom_name,
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "updated_by": current_user["email"]
        }}
    )
    
    # Log audit trail for transfer
    await log_audit(
        action="TRANSFER",
        entity_type="invoice",
        user=current_user,
        entity_id=invoice_id,
        entity_name=invoice.get("invoice_no"),
        before_data={"showroom_id": old_showroom_id, "showroom_name": old_showroom_name},
        after_data={"showroom_id": data.showroom_id, "showroom_name": data.showroom_name},
        details=f"Invoice {invoice.get('invoice_no')} transferred: {old_showroom_name or 'Unassigned'} -> {data.showroom_name or 'Unassigned'}"
    )
    
    return {
        "message": f"Invoice transferred to {data.showroom_name or 'Unassigned'}",
        "invoice_id": invoice_id,
        "old_showroom": old_showroom_name,
        "new_showroom": data.showroom_name
    }


@api_router.post("/invoices/bulk-transfer")
async def bulk_transfer_invoices(
    data: BulkInvoiceTransfer,
    current_user: dict = Depends(get_current_user)
):
    """Bulk transfer multiple invoices to a showroom (Super Admin only).
    This transfers all selected invoices and their associated revenue to the target showroom.
    """
    # Restrict to Super Admin only
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super Admin access required for bulk transfers")
    
    if not data.invoice_ids:
        raise HTTPException(status_code=400, detail="No invoices selected")
    
    # Get all selected invoices
    invoices = await db.invoices.find(
        {"id": {"$in": data.invoice_ids}},
        {"_id": 0}
    ).to_list(len(data.invoice_ids))
    
    if not invoices:
        raise HTTPException(status_code=404, detail="No invoices found")
    
    # Track results
    transferred = []
    failed = []
    total_revenue = 0
    
    for invoice in invoices:
        try:
            old_showroom_id = invoice.get("showroom_id")
            old_showroom_name = invoice.get("showroom_name", "Unassigned")
            
            # Update showroom
            await db.invoices.update_one(
                {"id": invoice["id"]},
                {"$set": {
                    "showroom_id": data.target_showroom_id,
                    "showroom_name": data.target_showroom_name,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                    "updated_by": current_user["email"]
                }}
            )
            
            # Log audit trail for each transfer
            await log_audit(
                action="TRANSFER",
                entity_type="invoice",
                user=current_user,
                entity_id=invoice["id"],
                entity_name=invoice.get("invoice_no"),
                before_data={"showroom_id": old_showroom_id, "showroom_name": old_showroom_name},
                after_data={"showroom_id": data.target_showroom_id, "showroom_name": data.target_showroom_name},
                details=f"Bulk transfer: Invoice {invoice.get('invoice_no')} transferred from {old_showroom_name or 'Unassigned'} to {data.target_showroom_name}"
            )
            
            transferred.append({
                "invoice_id": invoice["id"],
                "invoice_no": invoice.get("invoice_no"),
                "old_showroom": old_showroom_name,
                "gross_total": invoice.get("gross_total", 0)
            })
            total_revenue += invoice.get("gross_total", 0)
            
        except Exception as e:
            failed.append({
                "invoice_id": invoice["id"],
                "invoice_no": invoice.get("invoice_no"),
                "error": str(e)
            })
    
    return {
        "message": f"Transferred {len(transferred)} invoice(s) to {data.target_showroom_name}",
        "transferred_count": len(transferred),
        "failed_count": len(failed),
        "total_revenue_transferred": round(total_revenue, 2),
        "transferred": transferred,
        "failed": failed
    }


@api_router.get("/invoices/{invoice_id}/pdf")
async def generate_invoice_pdf(invoice_id: str, current_user: dict = Depends(get_current_user)):
    """Generate PDF for an invoice - matches frontend print preview exactly"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    if not REPORTLAB_AVAILABLE:
        raise HTTPException(status_code=500, detail="PDF generation not available")
    
    # Get the invoice
    invoice = await db.invoices.find_one({"id": invoice_id}, {"_id": 0})
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
    
    # Get showroom details for the invoice
    showroom_id = invoice.get("showroom_id")
    showroom = None
    if showroom_id:
        showroom = await db.showrooms.find_one({"id": showroom_id}, {"_id": 0})

    # ── Trade-credit balance lookup (24 Feb 2026 follow-up) ──────────
    # Resolve the trader's credit balance AT THE TIME this invoice was
    # processed (not the customer's current balance, which would be
    # misleading for old invoices). We read `balance_after` from the
    # credit_transactions row(s) linked to this invoice and take the
    # LATEST by created_at — that's the post-settlement snapshot for
    # this invoice's earn / redeem activity.
    #
    # If neither earn nor redeem happened on this invoice we leave the
    # value None and the PDF skips the row, so retail invoices stay clean.
    trade_balance_after_pdf = None
    try:
        credit_redeemed_val = float(invoice.get("credit_redeemed") or 0)
        credit_earned_val = float(invoice.get("trade_credit_earned") or 0)
        if credit_redeemed_val > 0 or credit_earned_val > 0:
            latest_txn = await db.credit_transactions.find_one(
                {"invoice_id": invoice_id, "balance_after": {"$exists": True}},
                {"_id": 0, "balance_after": 1, "created_at": 1},
                sort=[("created_at", -1)],
            )
            if latest_txn and latest_txn.get("balance_after") is not None:
                trade_balance_after_pdf = round(float(latest_txn["balance_after"]), 2)
    except Exception:  # never fail PDF generation on a balance lookup
        trade_balance_after_pdf = None

    # Default showroom info (Gravesend as fallback)
    showroom_name = "Tile Station - Gravesend"
    showroom_address = "Unit 3 Trade City Coldharbour Road"
    showroom_city = "Northfleet Gravesend DA11 8AB"
    showroom_phone = "01474 878 989"
    showroom_email = "gravesend@tilestation.co.uk"
    
    if showroom:
        showroom_name = f"Tile Station - {showroom.get('name', 'Gravesend')}"
        full_address = showroom.get("address", "")
        address_parts = full_address.split(',') if full_address else []
        if len(address_parts) >= 2:
            showroom_address = address_parts[0].strip()
            showroom_city = ', '.join(address_parts[1:]).strip()
        else:
            showroom_address = full_address
            showroom_city = ""
        showroom_phone = showroom.get("phone", showroom_phone)
        showroom_name_lower = showroom.get("name", "gravesend").lower().replace(" ", "")
        showroom_email = f"{showroom_name_lower}@tilestation.co.uk"
    
    # Create PDF in memory - A4 is 210mm x 297mm
    buffer = io.BytesIO()
    page_width = 210*mm
    left_margin = 10*mm
    right_margin = 10*mm
    available_width = page_width - left_margin - right_margin  # 190mm
    
    doc = SimpleDocTemplate(buffer, pagesize=A4, topMargin=8*mm, bottomMargin=8*mm, leftMargin=left_margin, rightMargin=right_margin)
    
    elements = []
    styles = getSampleStyleSheet()
    
    # ========== HEADER SECTION ==========
    invoice_title_style = ParagraphStyle('InvoiceTitle', fontSize=24, fontName='Times-Bold')
    invoice_no_style = ParagraphStyle('InvoiceNo', fontSize=11, fontName='Helvetica-Bold')
    company_style = ParagraphStyle('Company', fontSize=7, alignment=TA_RIGHT, leading=9)
    
    # Left side: Invoice title and number
    left_content = Paragraph("Invoice", invoice_title_style)
    left_no = Paragraph(f"<b>No: {invoice.get('invoice_no', 'N/A')}</b>", invoice_no_style)
    
    # Right side: Company details
    company_text = f"""<b>{invoice.get('date', '')} {invoice.get('time', '')}</b><br/>
<b>{showroom_name}</b><br/>
{showroom_address}<br/>
{showroom_city}<br/>
Tel: {showroom_phone}<br/>
{showroom_email}<br/>
Co. 11982550 / VAT 324 251 828"""
    right_content = Paragraph(company_text, company_style)
    
    # Create header table with two columns
    header_data = [
        [left_content, right_content],
        [left_no, '']
    ]
    header_table = Table(header_data, colWidths=[95*mm, 95*mm])
    header_table.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('ALIGN', (1, 0), (1, -1), 'RIGHT'),
    ]))
    elements.append(header_table)
    elements.append(Spacer(1, 2*mm))
    
    # TILE STATION logo text
    logo_style = ParagraphStyle('Logo', fontSize=22, fontName='Helvetica-Bold', spaceAfter=2*mm)
    elements.append(Paragraph("TILE STATION", logo_style))
    elements.append(Spacer(1, 4*mm))  # Increased spacing to avoid overlap with table
    
    # ========== LINE ITEMS TABLE ==========
    line_items = invoice.get("line_items", [])
    subtotal = invoice.get("subtotal", 0)
    vat = invoice.get("vat", 0)
    gross_total = invoice.get("gross_total", 0)
    
    # Column widths for line items (total = 190mm)
    col_widths = [12*mm, 12*mm, 68*mm, 18*mm, 18*mm, 14*mm, 16*mm, 18*mm]  # = 176mm, leaving some padding
    
    # Header row
    table_data = [["Qty", "m²", "Product", "List £", "Due £", "Disc%", "Save", "Total"]]
    
    # Style for returned-item paragraphs (red + strikethrough)
    return_cell_style = ParagraphStyle('ReturnCell', fontSize=7, leading=9, textColor=colors.red)
    
    for item in line_items:
        qty = item.get("quantity", 0)
        if not qty and not item.get("product_name"):
            continue
        m2 = item.get("m2", 0)
        list_price = item.get("price", 0)
        discount = item.get("discount", 0)
        
        # Use item's total if available, otherwise calculate
        item_total = item.get("total", 0)
        if not item_total and qty and list_price:
            line_subtotal = qty * list_price
            discount_amount = line_subtotal * (discount / 100) if discount else 0
            item_total = line_subtotal - discount_amount
        
        # Use stored due_price if available, otherwise calculate from discount
        due_price = item.get("due_price")
        if due_price is None:
            due_price = list_price * (1 - discount/100) if discount else list_price
        
        # Calculate savings based on actual due price difference
        savings = (list_price - due_price) * qty if qty and list_price and due_price else 0
        
        # Calculate discount percentage if due_price differs from list_price
        if list_price and due_price and list_price != due_price and not discount:
            discount = ((list_price - due_price) / list_price) * 100
        
        # Mark returned items with a red strikethrough + "(RETURNED)" prefix.
        # The display total flips to negative since this line is a credit.
        is_return = bool(item.get("isReturn") or item.get("is_return"))
        raw_name = (item.get("product_name", "") or "")[:40]
        if is_return:
            display_total = -abs(float(item_total or 0))
            product_cell = Paragraph(
                f"<strike>(RETURNED) {raw_name}</strike>",
                return_cell_style,
            )
            total_cell = Paragraph(
                f"<font color='red'>−£{abs(display_total):.2f}</font>",
                ParagraphStyle('ReturnTotal', fontSize=7, leading=9, alignment=2),  # 2=right
            )
        else:
            product_cell = raw_name
            total_cell = f"£{item_total:.2f}" if item_total else ""
        
        table_data.append([
            str(int(qty)) if qty and qty == int(qty) else (f"{qty:.1f}" if qty else ""),
            f"{m2:.2f}" if m2 else "",
            product_cell,
            f"£{list_price:.2f}" if list_price else "",
            f"£{due_price:.2f}" if due_price else "",
            f"{discount:.0f}%" if discount else "",
            f"£{savings:.2f}" if savings > 0 else "",
            total_cell,
        ])
    
    # Add empty rows (fewer rows to fit better)
    filled_rows = len(table_data) - 1
    for _ in range(max(0, 8 - filled_rows)):
        table_data.append(["", "", "", "", "", "", "", ""])
    
    items_table = Table(table_data, colWidths=col_widths)
    items_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.black),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTSIZE', (0, 0), (-1, 0), 7),
        ('FONTSIZE', (0, 1), (-1, -1), 7),
        ('ALIGN', (0, 0), (1, -1), 'CENTER'),
        ('ALIGN', (3, 0), (-1, -1), 'RIGHT'),
        ('ALIGN', (5, 0), (5, -1), 'CENTER'),
        ('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
        ('TOPPADDING', (0, 0), (-1, -1), 2),
        ('LEFTPADDING', (0, 0), (-1, -1), 2),
        ('RIGHTPADDING', (0, 0), (-1, -1), 2),
    ]))
    elements.append(items_table)
    elements.append(Spacer(1, 3*mm))
    
    # ========== BOTTOM SECTION ==========
    # Left: Customer details, Right: Payment & Totals
    
    # Customer details
    customer_style = ParagraphStyle('Customer', fontSize=8, leading=10)
    customer_bold = ParagraphStyle('CustomerBold', fontSize=8, fontName='Helvetica-Bold')
    
    customer_data = [
        [Paragraph("<b>Name:</b>", customer_bold), invoice.get("customer_name", "")],
        [Paragraph("<b>Phone:</b>", customer_bold), invoice.get("customer_phone", "")],
        [Paragraph("<b>Address:</b>", customer_bold), invoice.get("customer_address", "")],
        [Paragraph("<b>Email:</b>", customer_bold), invoice.get("customer_email", "")],
        [Paragraph("<b>Sales:</b>", customer_bold), invoice.get("sales_person") or invoice.get("staff_name", "")]
    ]
    customer_table = Table(customer_data, colWidths=[18*mm, 65*mm])
    customer_table.setStyle(TableStyle([
        ('FONTSIZE', (0, 0), (-1, -1), 8),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
        ('TOPPADDING', (0, 0), (-1, -1), 2),
    ]))
    
    # Order type badge
    order_type = invoice.get("order_type", "Store Order")
    
    # Payment summary
    payment_methods = invoice.get("payment_methods", [])
    valid_pms = [pm for pm in payment_methods if pm.get("method")]
    
    summary_data = []
    if valid_pms:
        for pm in valid_pms:
            summary_data.append([pm.get("method", ""), f"£{float(pm.get('amount', 0)):.2f}"])
    else:
        pm = invoice.get("payment_method", "Cash")
        summary_data.append([pm, ""])
    
    summary_data.append(["Subtotal", f"£{subtotal:.2f}"])
    summary_data.append(["VAT (20%)", f"£{vat:.2f}"])

    # ── Trade credit rows (24 Feb 2026) ──
    # Show "Trade Credit Used" (negative — was used to pay the invoice)
    # and "Trade Credit Earned on this purchase" (positive — given back to
    # the trader's account). Both lines only appear when applicable so we
    # don't clutter the PDF for retail customers. Inserted BEFORE the
    # TOTAL row so TOTAL stays last (the table style targets `-1` for
    # the bold/line-above formatting).
    credit_redeemed_pdf = float(invoice.get("credit_redeemed") or 0)
    credit_earned_pdf = float(invoice.get("trade_credit_earned") or 0)
    trade_ref_pdf = (
        invoice.get("trade_account_number")
        or invoice.get("credit_redeemed_account")
        or ""
    ).strip()
    if credit_redeemed_pdf > 0:
        summary_data.append(["Trade Credit Used", f"−£{credit_redeemed_pdf:.2f}"])
    if credit_earned_pdf > 0:
        summary_data.append(["Trade Credit Earned", f"+£{credit_earned_pdf:.2f}"])
    if trade_ref_pdf and (credit_redeemed_pdf > 0 or credit_earned_pdf > 0):
        summary_data.append(["Trade Account", trade_ref_pdf])
    if trade_balance_after_pdf is not None:
        summary_data.append(["Balance After Invoice", f"£{trade_balance_after_pdf:.2f}"])

    summary_data.append(["TOTAL", f"£{gross_total:.2f}"])
    
    summary_table = Table(summary_data, colWidths=[35*mm, 25*mm])
    summary_table.setStyle(TableStyle([
        ('FONTSIZE', (0, 0), (-1, -1), 8),
        ('ALIGN', (1, 0), (1, -1), 'RIGHT'),
        ('FONTNAME', (0, -1), (-1, -1), 'Helvetica-Bold'),
        ('LINEABOVE', (0, -3), (-1, -3), 0.5, colors.grey),
        ('LINEABOVE', (0, -1), (-1, -1), 1, colors.black),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
        ('TOPPADDING', (0, 0), (-1, -1), 2),
    ]))
    
    # Deposits/Payments table
    deposits = invoice.get("deposits", [])
    valid_deposits = [d for d in deposits if d.get("amount") and float(d.get("amount", 0)) > 0]
    
    if valid_deposits:
        deposit_data = [["Date", "Method", "Paid", "Due"]]
        running = gross_total
        for dep in valid_deposits:
            amt = float(dep.get("amount", 0))
            running -= amt
            deposit_data.append([
                dep.get("date", "")[:10],
                (dep.get("method") or dep.get("note") or "")[:10],
                f"£{amt:.2f}",
                f"£{running:.2f}"
            ])
        
        deposit_table = Table(deposit_data, colWidths=[22*mm, 22*mm, 18*mm, 18*mm])
        deposit_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#333333')),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 0), (-1, -1), 7),
            ('ALIGN', (2, 0), (-1, -1), 'RIGHT'),
            ('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
            ('TOPPADDING', (0, 0), (-1, -1), 2),
        ]))
    else:
        deposit_table = Spacer(1, 1*mm)
    
    # Combine right side
    right_col = [[Paragraph(f"<b>{order_type}</b>", ParagraphStyle('OrderType', fontSize=9, alignment=TA_CENTER))],
                 [Spacer(1, 2*mm)],
                 [summary_table],
                 [Spacer(1, 2*mm)],
                 [deposit_table]]
    right_table = Table(right_col, colWidths=[85*mm])
    
    # Bottom layout - two columns
    bottom_data = [[customer_table, right_table]]
    bottom_table = Table(bottom_data, colWidths=[95*mm, 95*mm])
    bottom_table.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
    ]))
    elements.append(bottom_table)
    
    # Outstanding balance warning
    total_paid = sum(float(d.get("amount", 0)) for d in valid_deposits)
    outstanding = gross_total - total_paid
    if outstanding > 0.01 and total_paid > 0:
        elements.append(Spacer(1, 2*mm))
        warning = ParagraphStyle('Warning', fontSize=9, textColor=colors.HexColor('#b45309'), alignment=TA_RIGHT)
        elements.append(Paragraph(f"<b>DEPOSIT ORDER - Balance Due: £{outstanding:.2f}</b>", warning))
    
    elements.append(Spacer(1, 4*mm))
    
    # Tagline
    tagline = ParagraphStyle('Tagline', fontSize=9, alignment=TA_CENTER, fontName='Helvetica-Bold')
    elements.append(Paragraph("Amazing Tiles - Beautiful Bathrooms - Excellent Service", tagline))
    elements.append(Spacer(1, 3*mm))
    
    # Terms
    terms_title = ParagraphStyle('TermsTitle', fontSize=7, fontName='Helvetica-Bold')
    terms_text = ParagraphStyle('TermsText', fontSize=5, textColor=colors.grey, leading=6)
    elements.append(Paragraph("Terms and Conditions:", terms_title))
    default_terms = """TERMS &amp; CONDITIONS - PLEASE READ REFUNDS • Any unwanted Full packs of STOCKED TILES will occur a 20% restocking charge. Only 10% of total tiles purchased will be refunded within 28 days from collection or delivery date. • Any unwanted Full packs of SPECIAL-ORDER TILES will occur a 50% restocking charge. Only 10% of total tiles purchased will be refunded within 28 days from collection or delivery date. • BATHROOM PRODUCTS are non-refundable. • Powered and chemical base products are non-refundable. • Refunds will not be processed without original invoice. CANCELLATIONS POLICY • Any cancellations of STOCKED TILES will occur 20% cancellation charge within 28 days of invoice date. • Any cancellation of SPECIAL-ORDER TILES will occur a 30% cancellation charge within 28 days of invoice. • Any cancellations of BATHROOM PRODUCTS will occur a 50% restocking charge within 28 days of invoice. DELIVERY INFORMATION We offer a delivery service; charges vary based on location. • All deliveries are KERBSIDE DELIVERY only, delivery driver(s) are not insured to go into properties. • Assistance required to unload. • Re-delivery will occur additional charges. • Any broken tiles need to be Reported within 48 hours of delivery or collection with photo proof to be replaced. BY PURCHASING A PRODUCT FROM TILE STATION, YOU AGREE TO THESE TERMS &amp; CONDITIONS."""
    terms = invoice.get("terms_and_conditions") or default_terms
    elements.append(Paragraph(terms, terms_text))
    
    # Build PDF
    doc.build(elements)
    buffer.seek(0)
    
    filename = f"Invoice_{invoice.get('invoice_no', 'unknown')}.pdf"
    return StreamingResponse(
        buffer,
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )

# Helper function to generate PDF bytes (reused by email endpoint)
async def generate_invoice_pdf_bytes(invoice: dict, showroom: dict = None) -> bytes:
    """Generate PDF bytes for an invoice - matches frontend print preview"""
    if not REPORTLAB_AVAILABLE:
        raise HTTPException(status_code=500, detail="PDF generation not available")

    # ── Trade-credit balance lookup (24 Feb 2026 follow-up) ──────────
    # Mirrors `generate_invoice_pdf`. We read `balance_after` from the
    # credit_transactions row(s) linked to this invoice and take the
    # LATEST by created_at — that's the post-settlement snapshot. The
    # PDF skips the row if neither earn nor redeem happened, so retail
    # invoices stay clean.
    trade_balance_after_pdf = None
    try:
        credit_redeemed_val = float(invoice.get("credit_redeemed") or 0)
        credit_earned_val = float(invoice.get("trade_credit_earned") or 0)
        if (credit_redeemed_val > 0 or credit_earned_val > 0) and invoice.get("id"):
            latest_txn = await db.credit_transactions.find_one(
                {"invoice_id": invoice["id"], "balance_after": {"$exists": True}},
                {"_id": 0, "balance_after": 1, "created_at": 1},
                sort=[("created_at", -1)],
            )
            if latest_txn and latest_txn.get("balance_after") is not None:
                trade_balance_after_pdf = round(float(latest_txn["balance_after"]), 2)
    except Exception:  # never fail PDF generation on a balance lookup
        trade_balance_after_pdf = None
    
    # Default showroom info
    showroom_name = "Tile Station - Gravesend"
    showroom_address = "Unit 3 Trade City Coldharbour Road"
    showroom_city = "Northfleet Gravesend DA11 8AB"
    showroom_phone = "01474 878 989"
    showroom_email = "gravesend@tilestation.co.uk"
    
    if showroom:
        showroom_name = f"Tile Station - {showroom.get('name', 'Gravesend')}"
        full_address = showroom.get("address", "")
        address_parts = full_address.split(',') if full_address else []
        if len(address_parts) >= 2:
            showroom_address = address_parts[0].strip()
            showroom_city = ', '.join(address_parts[1:]).strip()
        else:
            showroom_address = full_address
            showroom_city = ""
        showroom_phone = showroom.get("phone", showroom_phone)
        showroom_name_lower = showroom.get("name", "gravesend").lower().replace(" ", "")
        showroom_email = f"{showroom_name_lower}@tilestation.co.uk"
    
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4, topMargin=8*mm, bottomMargin=8*mm, leftMargin=10*mm, rightMargin=10*mm)
    
    elements = []
    
    # Header
    invoice_title_style = ParagraphStyle('InvoiceTitle', fontSize=24, fontName='Times-Bold')
    invoice_no_style = ParagraphStyle('InvoiceNo', fontSize=11, fontName='Helvetica-Bold')
    company_style = ParagraphStyle('Company', fontSize=7, alignment=TA_RIGHT, leading=9)
    
    left_content = Paragraph("Invoice", invoice_title_style)
    left_no = Paragraph(f"<b>No: {invoice.get('invoice_no', 'N/A')}</b>", invoice_no_style)
    
    company_text = f"""<b>{invoice.get('date', '')} {invoice.get('time', '')}</b><br/>
<b>{showroom_name}</b><br/>
{showroom_address}<br/>
{showroom_city}<br/>
Tel: {showroom_phone}<br/>
{showroom_email}<br/>
Co. 11982550 / VAT 324 251 828"""
    right_content = Paragraph(company_text, company_style)
    
    header_data = [[left_content, right_content], [left_no, '']]
    header_table = Table(header_data, colWidths=[95*mm, 95*mm])
    header_table.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('ALIGN', (1, 0), (1, -1), 'RIGHT'),
    ]))
    elements.append(header_table)
    elements.append(Spacer(1, 2*mm))
    
    logo_style = ParagraphStyle('Logo', fontSize=22, fontName='Helvetica-Bold', spaceAfter=2*mm)
    elements.append(Paragraph("TILE STATION", logo_style))
    elements.append(Spacer(1, 4*mm))  # Increased spacing to avoid overlap with table
    
    # Line items
    line_items = invoice.get("line_items", [])
    subtotal = invoice.get("subtotal", 0)
    vat = invoice.get("vat", 0)
    gross_total = invoice.get("gross_total", 0)
    
    col_widths = [12*mm, 12*mm, 68*mm, 18*mm, 18*mm, 14*mm, 16*mm, 18*mm]
    table_data = [["Qty", "m²", "Product", "List £", "Due £", "Disc%", "Save", "Total"]]
    
    # Style for product names to allow wrapping
    product_cell_style = ParagraphStyle('ProductCell', fontSize=7, leading=9)
    # Style for returned items (red + strikethrough)
    return_cell_style = ParagraphStyle('ReturnCell', fontSize=7, leading=9, textColor=colors.red)
    
    for item in line_items:
        qty = item.get("quantity", 0)
        if not qty and not item.get("product_name"):
            continue
        m2 = item.get("m2", 0)
        list_price = item.get("price", 0)
        discount = item.get("discount", 0)
        item_total = item.get("total", 0)
        if not item_total and qty and list_price:
            line_subtotal = qty * list_price
            discount_amount = line_subtotal * (discount / 100) if discount else 0
            item_total = line_subtotal - discount_amount
        
        # Use stored due_price if available, otherwise calculate from discount
        due_price = item.get("due_price")
        if due_price is None:
            due_price = list_price * (1 - discount/100) if discount else list_price
        
        # Calculate savings based on actual due price difference
        savings = (list_price - due_price) * qty if qty and list_price and due_price else 0
        
        # Calculate discount percentage if due_price differs from list_price
        if list_price and due_price and list_price != due_price and not discount:
            discount = ((list_price - due_price) / list_price) * 100
        
        # Mark returned items with red + strikethrough + "(RETURNED)" prefix.
        is_return = bool(item.get("isReturn") or item.get("is_return"))
        product_name = item.get("product_name", "") or ""
        if is_return:
            product_para = Paragraph(
                f"<strike>(RETURNED) {product_name}</strike>",
                return_cell_style,
            )
            total_cell = Paragraph(
                f"<font color='red'>−£{abs(float(item_total or 0)):.2f}</font>",
                ParagraphStyle('ReturnTotal', fontSize=7, leading=9, alignment=2),  # 2=right
            )
        else:
            product_para = Paragraph(product_name, product_cell_style)
            total_cell = f"£{item_total:.2f}" if item_total else ""
        
        table_data.append([
            str(int(qty)) if qty and qty == int(qty) else (f"{qty:.1f}" if qty else ""),
            f"{m2:.2f}" if m2 else "",
            product_para,
            f"£{list_price:.2f}" if list_price else "",
            f"£{due_price:.2f}" if due_price else "",
            f"{discount:.0f}%" if discount else "",
            f"£{savings:.2f}" if savings > 0 else "",
            total_cell,
        ])
    
    filled_rows = len(table_data) - 1
    for _ in range(max(0, 8 - filled_rows)):
        table_data.append(["", "", "", "", "", "", "", ""])
    
    items_table = Table(table_data, colWidths=col_widths)
    items_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.black),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTSIZE', (0, 0), (-1, -1), 7),
        ('ALIGN', (0, 0), (1, -1), 'CENTER'),
        ('ALIGN', (3, 0), (-1, -1), 'RIGHT'),
        ('ALIGN', (5, 0), (5, -1), 'CENTER'),
        ('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
        ('TOPPADDING', (0, 0), (-1, -1), 2),
        ('LEFTPADDING', (0, 0), (-1, -1), 2),
        ('RIGHTPADDING', (0, 0), (-1, -1), 2),
    ]))
    elements.append(items_table)
    elements.append(Spacer(1, 3*mm))
    
    # Bottom section
    customer_bold = ParagraphStyle('CustomerBold', fontSize=8, fontName='Helvetica-Bold')
    customer_data = [
        [Paragraph("<b>Name:</b>", customer_bold), invoice.get("customer_name", "")],
        [Paragraph("<b>Phone:</b>", customer_bold), invoice.get("customer_phone", "")],
        [Paragraph("<b>Address:</b>", customer_bold), invoice.get("customer_address", "")],
        [Paragraph("<b>Email:</b>", customer_bold), invoice.get("customer_email", "")],
        [Paragraph("<b>Sales:</b>", customer_bold), invoice.get("sales_person") or invoice.get("staff_name", "")]
    ]
    customer_table = Table(customer_data, colWidths=[18*mm, 65*mm])
    customer_table.setStyle(TableStyle([
        ('FONTSIZE', (0, 0), (-1, -1), 8),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
        ('TOPPADDING', (0, 0), (-1, -1), 2),
    ]))
    
    order_type = invoice.get("order_type", "Store Order")
    payment_methods = invoice.get("payment_methods", [])
    valid_pms = [pm for pm in payment_methods if pm.get("method")]
    
    summary_data = []
    if valid_pms:
        for pm in valid_pms:
            summary_data.append([pm.get("method", ""), f"£{float(pm.get('amount', 0)):.2f}"])
    else:
        pm = invoice.get("payment_method", "Cash")
        summary_data.append([pm, ""])
    summary_data.append(["Subtotal", f"£{subtotal:.2f}"])
    summary_data.append(["VAT (20%)", f"£{vat:.2f}"])

    # Trade credit rows (24 Feb 2026) — duplicated from page-1 block
    # because the PDF assembles two independent summary tables. Inserted
    # BEFORE TOTAL so TOTAL stays last (table style uses `-1` for bold).
    credit_redeemed_pdf = float(invoice.get("credit_redeemed") or 0)
    credit_earned_pdf = float(invoice.get("trade_credit_earned") or 0)
    trade_ref_pdf = (
        invoice.get("trade_account_number")
        or invoice.get("credit_redeemed_account")
        or ""
    ).strip()
    if credit_redeemed_pdf > 0:
        summary_data.append(["Trade Credit Used", f"−£{credit_redeemed_pdf:.2f}"])
    if credit_earned_pdf > 0:
        summary_data.append(["Trade Credit Earned", f"+£{credit_earned_pdf:.2f}"])
    if trade_ref_pdf and (credit_redeemed_pdf > 0 or credit_earned_pdf > 0):
        summary_data.append(["Trade Account", trade_ref_pdf])
    if trade_balance_after_pdf is not None:
        summary_data.append(["Balance After Invoice", f"£{trade_balance_after_pdf:.2f}"])

    summary_data.append(["TOTAL", f"£{gross_total:.2f}"])
    
    summary_table = Table(summary_data, colWidths=[35*mm, 25*mm])
    summary_table.setStyle(TableStyle([
        ('FONTSIZE', (0, 0), (-1, -1), 8),
        ('ALIGN', (1, 0), (1, -1), 'RIGHT'),
        ('FONTNAME', (0, -1), (-1, -1), 'Helvetica-Bold'),
        ('LINEABOVE', (0, -3), (-1, -3), 0.5, colors.grey),
        ('LINEABOVE', (0, -1), (-1, -1), 1, colors.black),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
        ('TOPPADDING', (0, 0), (-1, -1), 2),
    ]))
    
    deposits = invoice.get("deposits", [])
    valid_deposits = [d for d in deposits if d.get("amount") and float(d.get("amount", 0)) > 0]
    
    if valid_deposits:
        deposit_data = [["Date", "Method", "Paid", "Due"]]
        running = gross_total
        for dep in valid_deposits:
            amt = float(dep.get("amount", 0))
            running -= amt
            deposit_data.append([
                dep.get("date", "")[:10],
                (dep.get("method") or dep.get("note") or "")[:10],
                f"£{amt:.2f}",
                f"£{running:.2f}"
            ])
        deposit_table = Table(deposit_data, colWidths=[22*mm, 22*mm, 18*mm, 18*mm])
        deposit_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#333333')),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 0), (-1, -1), 7),
            ('ALIGN', (2, 0), (-1, -1), 'RIGHT'),
            ('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
            ('TOPPADDING', (0, 0), (-1, -1), 2),
        ]))
    else:
        deposit_table = Spacer(1, 1*mm)
    
    right_col = [[Paragraph(f"<b>{order_type}</b>", ParagraphStyle('OrderType', fontSize=9, alignment=TA_CENTER))],
                 [Spacer(1, 2*mm)], [summary_table], [Spacer(1, 2*mm)], [deposit_table]]
    right_table = Table(right_col, colWidths=[85*mm])
    
    bottom_data = [[customer_table, right_table]]
    bottom_table = Table(bottom_data, colWidths=[95*mm, 95*mm])
    bottom_table.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'TOP')]))
    elements.append(bottom_table)
    
    total_paid = sum(float(d.get("amount", 0)) for d in valid_deposits)
    outstanding = gross_total - total_paid
    if outstanding > 0.01 and total_paid > 0:
        elements.append(Spacer(1, 2*mm))
        warning = ParagraphStyle('Warning', fontSize=9, textColor=colors.HexColor('#b45309'), alignment=TA_RIGHT)
        elements.append(Paragraph(f"<b>DEPOSIT ORDER - Balance Due: £{outstanding:.2f}</b>", warning))
    
    elements.append(Spacer(1, 4*mm))
    tagline = ParagraphStyle('Tagline', fontSize=9, alignment=TA_CENTER, fontName='Helvetica-Bold')
    elements.append(Paragraph("Amazing Tiles - Beautiful Bathrooms - Excellent Service", tagline))
    elements.append(Spacer(1, 3*mm))
    
    terms_title = ParagraphStyle('TermsTitle', fontSize=7, fontName='Helvetica-Bold')
    terms_text = ParagraphStyle('TermsText', fontSize=5, textColor=colors.grey, leading=6)
    elements.append(Paragraph("Terms and Conditions:", terms_title))
    default_terms = """TERMS &amp; CONDITIONS - PLEASE READ REFUNDS • Any unwanted Full packs of STOCKED TILES will occur a 20% restocking charge. Only 10% of total tiles purchased will be refunded within 28 days from collection or delivery date. • Any unwanted Full packs of SPECIAL-ORDER TILES will occur a 50% restocking charge. Only 10% of total tiles purchased will be refunded within 28 days from collection or delivery date. • BATHROOM PRODUCTS are non-refundable. • Powered and chemical base products are non-refundable. • Refunds will not be processed without original invoice. CANCELLATIONS POLICY • Any cancellations of STOCKED TILES will occur 20% cancellation charge within 28 days of invoice date. • Any cancellation of SPECIAL-ORDER TILES will occur a 30% cancellation charge within 28 days of invoice. • Any cancellations of BATHROOM PRODUCTS will occur a 50% restocking charge within 28 days of invoice. DELIVERY INFORMATION We offer a delivery service; charges vary based on location. • All deliveries are KERBSIDE DELIVERY only, delivery driver(s) are not insured to go into properties. • Assistance required to unload. • Re-delivery will occur additional charges. • Any broken tiles need to be Reported within 48 hours of delivery or collection with photo proof to be replaced. BY PURCHASING A PRODUCT FROM TILE STATION, YOU AGREE TO THESE TERMS &amp; CONDITIONS."""
    terms = invoice.get("terms_and_conditions") or default_terms
    elements.append(Paragraph(terms, terms_text))
    
    doc.build(elements)
    buffer.seek(0)
    return buffer.getvalue()


async def send_order_confirmation_email(invoice: dict):
    """Send order confirmation email to customer after invoice creation"""
    customer_email = invoice.get("customer_email")
    if not customer_email:
        return
    
    invoice_no = invoice.get("invoice_no", "N/A")
    customer_name = invoice.get("customer_name", "Customer")
    gross_total = invoice.get("gross_total", 0)
    showroom_name = invoice.get("showroom_name", "Tile Station")
    line_items = invoice.get("line_items", [])

    # Resolve per-showroom contact (phone/email/address) so confirmation
    # emails come from the showroom that actually took the order — not
    # always Gravesend. (20 May 2026 — user-reported.)
    from services.email import get_showroom_contact, render_email_signature
    showroom_doc = None
    sid = invoice.get("showroom_id")
    if sid:
        try:
            showroom_doc = await db.showrooms.find_one({"id": sid}, {"_id": 0})
        except Exception:
            showroom_doc = None
    contact = get_showroom_contact(showroom_doc or showroom_name)
    signature_html = render_email_signature(showroom_doc or showroom_name)
    
    # Calculate deposits and outstanding
    deposits = invoice.get("deposits", [])
    total_deposits = sum(float(d.get("amount", 0)) for d in deposits if d.get("amount"))
    outstanding = gross_total - total_deposits
    
    # Build items table HTML
    items_html = ""
    for item in line_items:
        items_html += f"""
        <tr>
            <td style="padding: 8px; border-bottom: 1px solid #eee;">{item.get('product_name', '')}</td>
            <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: center;">{item.get('quantity', 0)}</td>
            <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: right;">£{item.get('total', 0):.2f}</td>
        </tr>
        """
    
    html_content = f"""
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #1a1a2e; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0; color: #f0c14b;">TILE STATION</h1>
            <p style="margin: 5px 0 0 0; font-size: 14px;">Amazing Tiles - Beautiful Bathrooms - Excellent Service</p>
        </div>
        
        <div style="padding: 30px; background: #f9f9f9;">
            <h2 style="color: #1a1a2e; margin-top: 0;">Order Confirmation</h2>
            <p>Dear {customer_name},</p>
            
            <p>Thank you for your order! We're pleased to confirm that we have received your order <strong>#{invoice_no}</strong>.</p>
            
            <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #f0c14b;">
                <h3 style="margin-top: 0; color: #1a1a2e;">Order Summary</h3>
                <table style="width: 100%; border-collapse: collapse;">
                    <thead>
                        <tr style="background: #f5f5f5;">
                            <th style="padding: 10px; text-align: left;">Product</th>
                            <th style="padding: 10px; text-align: center;">Qty</th>
                            <th style="padding: 10px; text-align: right;">Total</th>
                        </tr>
                    </thead>
                    <tbody>
                        {items_html}
                    </tbody>
                </table>
                
                <div style="margin-top: 15px; padding-top: 15px; border-top: 2px solid #1a1a2e;">
                    <table style="width: 100%;">
                        <tr>
                            <td style="padding: 5px 0;"><strong>Order Total:</strong></td>
                            <td style="text-align: right; font-size: 18px; color: #1a1a2e;"><strong>£{gross_total:.2f}</strong></td>
                        </tr>
                        {'<tr><td style="padding: 5px 0;">Amount Paid:</td><td style="text-align: right;">£' + f'{total_deposits:.2f}' + '</td></tr>' if total_deposits > 0 else ''}
                        {'<tr style="color: #d97706;"><td style="padding: 5px 0;"><strong>Outstanding:</strong></td><td style="text-align: right;"><strong>£' + f'{outstanding:.2f}' + '</strong></td></tr>' if outstanding > 0.01 else ''}
                    </table>
                </div>
            </div>
            
            <div style="background: #e8f4e8; padding: 15px; border-radius: 8px; margin: 20px 0;">
                <p style="margin: 0; color: #2d5a2d;"><strong>What's Next?</strong></p>
                <p style="margin: 10px 0 0 0; color: #2d5a2d;">Our team at <strong>{showroom_name}</strong> will process your order shortly. We'll be in touch if we need any additional information.</p>
            </div>
            
            <p>If you have any questions about your order, please don't hesitate to contact us.</p>
            
            <p style="margin-top: 20px;color:#374151;">Best regards,<br><strong>The {contact['name']} Team</strong></p>
            
            {signature_html}
        </div>
        
        <div style="background: #1a1a2e; color: #888; padding: 15px; text-align: center; font-size: 11px;">
            <p style="margin: 0;">Tile Station Group · Company No: 11982550 · VAT No: 324 251 828</p>
        </div>
    </div>
    """
    
    resend.api_key = RESEND_API_KEY
    # Per-showroom direct send — tilestation.co.uk is domain-verified
    # in Resend, so every showroom address is a valid sender.
    await asyncio.to_thread(resend.Emails.send, {
        "from": f"{contact['name']} <{contact['email']}>",
        "to": [customer_email],
        "reply_to": [contact['email']],
        "subject": f"Order Confirmation #{invoice_no} - {contact['name']}",
        "html": html_content
    })


@api_router.post("/invoices/{invoice_id}/email")
async def email_invoice_pdf(invoice_id: str, request: InvoiceEmailRequest, current_user: dict = Depends(get_current_user)):
    """Send invoice PDF via email"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    if not RESEND_AVAILABLE:
        raise HTTPException(status_code=500, detail="Email service not available")
    
    # Get the invoice
    invoice = await db.invoices.find_one({"id": invoice_id}, {"_id": 0})
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
    
    # Get showroom details for the invoice
    showroom_id = invoice.get("showroom_id")
    showroom = None
    if showroom_id:
        showroom = await db.showrooms.find_one({"id": showroom_id}, {"_id": 0})

    # Resolve the per-showroom contact card so Tonbridge invoices show
    # the Tonbridge phone / postal address / reply-to inbox — NOT the
    # Gravesend defaults that were previously hardcoded.
    # (20 May 2026 — user-reported bug: "When Tonbridge staff sends a copy
    # of invoice to customer, it goes to customer via gravesend@.")
    from services.email import get_showroom_contact, render_email_signature
    contact = get_showroom_contact(showroom or invoice.get("showroom_name"))
    # Sender name: explicit override (frontend can pass `sender_name` on
    # the request) → otherwise the logged-in staff member's name → otherwise
    # nothing (just the showroom name in the signature). 21 May 2026 user
    # request: "Is the name in Email Signature editable? Confirm".
    effective_sender = (
        (getattr(request, "sender_name", None) or "").strip()
        or (current_user.get("name") or "").strip()
        or None
    )
    signature_html = render_email_signature(
        showroom or invoice.get("showroom_name"),
        sender_name=effective_sender,
    )
    
    # Generate PDF
    try:
        pdf_bytes = await generate_invoice_pdf_bytes(invoice, showroom)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate PDF: {str(e)}")
    
    # Send email with attachment
    import base64
    
    invoice_no = invoice.get("invoice_no", "N/A")
    customer_name = invoice.get("customer_name", "Customer")
    gross_total = invoice.get("gross_total", 0)
    
    # Calculate outstanding
    deposits = invoice.get("deposits", [])
    total_deposits = sum(float(d.get("amount", 0)) for d in deposits if d.get("amount"))
    outstanding = gross_total - total_deposits
    
    custom_message = request.message or ""
    if custom_message:
        custom_message = f"<p style='margin-bottom: 20px;'>{custom_message}</p>"
    
    html_content = f"""
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #1a1a2e; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0;">TILE STATION</h1>
            <p style="margin: 5px 0 0 0; font-size: 14px;">Amazing Tiles - Beautiful Bathrooms - Excellent Service</p>
        </div>
        
        <div style="padding: 30px; background: #f9f9f9;">
            {custom_message}
            <p>Dear {customer_name},</p>
            
            <p>Please find attached your invoice <strong>#{invoice_no}</strong> from Tile Station.</p>
            
            <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
                <table style="width: 100%;">
                    <tr>
                        <td style="padding: 8px 0;"><strong>Invoice No:</strong></td>
                        <td style="text-align: right;">{invoice_no}</td>
                    </tr>
                    <tr>
                        <td style="padding: 8px 0;"><strong>Total Amount:</strong></td>
                        <td style="text-align: right;">£{gross_total:.2f}</td>
                    </tr>
                    <tr>
                        <td style="padding: 8px 0;"><strong>Amount Paid:</strong></td>
                        <td style="text-align: right;">£{total_deposits:.2f}</td>
                    </tr>
                    <tr style="{'color: #d97706; font-weight: bold;' if outstanding > 0 else ''}">
                        <td style="padding: 8px 0;"><strong>Outstanding:</strong></td>
                        <td style="text-align: right;">£{outstanding:.2f}</td>
                    </tr>
                </table>
            </div>
            
            <p>If you have any questions about this invoice, please don't hesitate to contact us.</p>
            
            <p>Thank you for choosing Tile Station!</p>
            
            <p style="margin-top: 20px;color:#374151;">Best regards,<br><strong>The {contact['name']} Team</strong></p>
            
            {signature_html}
        </div>
        
        <div style="background: #1a1a2e; color: #888; padding: 15px; text-align: center; font-size: 11px;">
            <p style="margin: 0;">Tile Station Group · Company No: 11982550 · VAT No: 324 251 828</p>
        </div>
    </div>
    """
    
    try:
        resend.api_key = os.environ.get("RESEND_API_KEY")
        # Per-showroom send-from. The tilestation.co.uk domain is verified
        # in Resend at the DOMAIN level, so every <showroom>@tilestation.co.uk
        # is a valid sender out of the box. Tonbridge invoices come from
        # tonbridge@, Chingford from chingford@, etc. — no exceptions.
        from_header = f"{contact['name']} <{contact['email']}>"
        
        response = resend.Emails.send({
            "from": from_header,
            "to": [request.email],
            "reply_to": [contact['email']],
            "subject": f"Invoice #{invoice_no} from {contact['name']}",
            "html": html_content,
            "attachments": [
                {
                    "filename": f"Invoice_{invoice_no}.pdf",
                    "content": base64.b64encode(pdf_bytes).decode("utf-8")
                }
            ]
        })
        
        return {"message": "Invoice sent successfully", "email": request.email, "from": from_header}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to send email: {str(e)}")

# ============ STAFF PIN ENDPOINTS ============
# Moved to /routes/staff_pins.py

# ============ EXPORT ENDPOINTS ============

@api_router.get("/export/customer-pricing/csv")
async def export_customer_pricing_csv(current_user: dict = Depends(get_current_user)):
    """Export all customer-specific pricing to CSV"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    # Get all customer pricing
    pricing_list = await db.customer_pricing.find({}, {"_id": 0}).to_list(100000)
    
    # Get product details for enriching the export
    products = await db.products.find({}, {"_id": 0, "id": 1, "name": 1, "sku": 1, "price": 1}).to_list(100000)
    product_map = {p["id"]: p for p in products}
    
    output = io.StringIO()
    writer = csv.writer(output)
    
    # Header row
    writer.writerow([
        'Customer Email', 'Product ID', 'Product Name', 'Product SKU',
        'Regular Price (£)', 'Custom Price (£)', 'Discount (%)', 'Created At'
    ])
    
    # Data rows
    for p in pricing_list:
        product = product_map.get(p.get('product_id'), {})
        regular_price = product.get('price', 0)
        custom_price = p.get('custom_price', 0)
        discount_pct = round((1 - custom_price / regular_price) * 100, 1) if regular_price > 0 else 0
        
        writer.writerow([
            p.get('customer_email', ''),
            p.get('product_id', ''),
            product.get('name', 'Unknown'),
            product.get('sku', ''),
            f"{regular_price:.2f}",
            f"{custom_price:.2f}",
            f"{discount_pct}%",
            p.get('created_at', '')[:10] if p.get('created_at') else ''
        ])
    
    output.seek(0)
    
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={
            "Content-Disposition": f"attachment; filename=customer_pricing_export_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
        }
    )

@api_router.get("/export/audit-logs/csv")
async def export_audit_logs_csv(
    entity_type: Optional[str] = None,
    action: Optional[str] = None,
    user_email: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    """Export audit logs to CSV (Super Admin only)"""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super Admin access required")
    
    # Build query based on filters
    query = {}
    if entity_type:
        query["entity_type"] = entity_type
    if action:
        query["action"] = action
    if user_email:
        query["user_email"] = {"$regex": user_email, "$options": "i"}
    if start_date or end_date:
        query["timestamp"] = {}
        if start_date:
            query["timestamp"]["$gte"] = start_date
        if end_date:
            query["timestamp"]["$lte"] = end_date
    
    # Get audit logs
    logs = await db.audit_logs.find(query, {"_id": 0}).sort("timestamp", -1).to_list(100000)
    
    output = io.StringIO()
    writer = csv.writer(output)
    
    # Header row
    writer.writerow([
        'Timestamp', 'User Email', 'User Name', 'User Role', 
        'Action', 'Entity Type', 'Entity ID', 'Entity Name',
        'Store', 'Details', 'Changes Summary'
    ])
    
    # Data rows
    for log in logs:
        # Summarize changes
        changes_summary = ""
        if log.get("changes"):
            changes = []
            for change in log.get("changes", []):
                field = change.get("field", "")
                old_val = str(change.get("old_value", ""))[:30]
                new_val = str(change.get("new_value", ""))[:30]
                changes.append(f"{field}: {old_val} -> {new_val}")
            changes_summary = "; ".join(changes[:5])  # Limit to 5 changes
            if len(log.get("changes", [])) > 5:
                changes_summary += f" (+{len(log['changes']) - 5} more)"
        
        writer.writerow([
            log.get('timestamp', ''),
            log.get('user_email', ''),
            log.get('user_name', ''),
            log.get('user_role', ''),
            log.get('action', ''),
            log.get('entity_type', ''),
            log.get('entity_id', ''),
            log.get('entity_name', ''),
            log.get('showroom_name', ''),
            log.get('details', ''),
            changes_summary
        ])
    
    output.seek(0)
    
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={
            "Content-Disposition": f"attachment; filename=audit_logs_export_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
        }
    )

@api_router.get("/export/profit-report/csv")
async def export_profit_report_csv(
    period: str = "month",
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    """Export profit report to CSV (Super Admin only)"""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super Admin access required")
    
    from collections import defaultdict
    
    # Calculate date range based on period
    now = datetime.now(timezone.utc)
    
    if period == "today":
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        end = now
    elif period == "week":
        start = now - timedelta(days=7)
        end = now
    elif period == "month":
        start = now - timedelta(days=30)
        end = now
    elif period == "quarter":
        start = now - timedelta(days=90)
        end = now
    elif period == "year":
        start = now - timedelta(days=365)
        end = now
    elif period == "custom" and start_date and end_date:
        try:
            start = datetime.fromisoformat(start_date.replace("Z", "+00:00"))
            end = datetime.fromisoformat(end_date.replace("Z", "+00:00"))
        except Exception:
            start = now - timedelta(days=30)
            end = now
    else:
        start = now - timedelta(days=30)
        end = now
    
    start_str = start.isoformat()
    end_str = end.isoformat()
    
    # Get invoices in date range
    invoices = await db.invoices.find(
        {"created_at": {"$gte": start_str, "$lte": end_str}},
        {"_id": 0}
    ).to_list(100000)
    
    # Get all showrooms
    showrooms = await db.showrooms.find({}, {"_id": 0}).to_list(10000)
    showroom_map = {s["id"]: s["name"] for s in showrooms}
    
    # Get product costs
    products = await db.products.find({}, {"_id": 0, "id": 1, "name": 1, "sku": 1, "cost": 1}).to_list(100000)
    product_costs = {p["id"]: p for p in products}
    
    output = io.StringIO()
    writer = csv.writer(output)
    
    # Write report header info
    writer.writerow(['PROFIT REPORT'])
    writer.writerow([f'Period: {start.strftime("%d/%m/%Y")} to {end.strftime("%d/%m/%Y")}'])
    writer.writerow([f'Generated: {now.strftime("%d/%m/%Y %H:%M")}'])
    writer.writerow([])
    
    # Summary section
    writer.writerow(['=== SUMMARY ==='])
    
    total_revenue_ex_vat = 0
    total_cost = 0
    total_invoices = len(invoices)
    
    # Store data aggregation
    showroom_data = defaultdict(lambda: {"revenue_ex_vat": 0, "cost": 0, "count": 0, "m2_sold": 0})
    
    # Product data aggregation
    product_data = defaultdict(lambda: {"qty": 0, "m2": 0, "revenue": 0, "cost": 0})
    
    for invoice in invoices:
        showroom_id = invoice.get("showroom_id", "unassigned")
        showroom_name = invoice.get("showroom_name") or showroom_map.get(showroom_id, "Unassigned")
        subtotal = invoice.get("subtotal", 0)  # Ex VAT
        
        showroom_data[showroom_name]["revenue_ex_vat"] += subtotal
        showroom_data[showroom_name]["count"] += 1
        total_revenue_ex_vat += subtotal
        
        for item in invoice.get("line_items", []):
            product_id = item.get("product_id", "")
            qty = item.get("quantity", 0)
            item_m2 = item.get("m2", 0) or 0
            price = item.get("price", 0)
            discount = item.get("discount", 0)
            item_revenue = qty * price * (1 - discount / 100)
            
            product_info = product_costs.get(product_id, {})
            unit_cost = product_info.get("cost", 0) or 0
            item_cost = qty * unit_cost
            
            showroom_data[showroom_name]["cost"] += item_cost
            showroom_data[showroom_name]["m2_sold"] += item_m2
            total_cost += item_cost
            
            # Track per-product
            product_name = item.get("product_name", "Unknown")
            product_data[product_name]["qty"] += qty
            product_data[product_name]["m2"] += item_m2
            product_data[product_name]["revenue"] += item_revenue
            product_data[product_name]["cost"] += item_cost
    
    total_profit = total_revenue_ex_vat - total_cost
    overall_margin = round((total_profit / total_revenue_ex_vat * 100), 1) if total_revenue_ex_vat > 0 else 0
    
    writer.writerow(['Metric', 'Value'])
    writer.writerow(['Total Invoices', total_invoices])
    writer.writerow(['Total Revenue (Ex VAT)', f'£{total_revenue_ex_vat:,.2f}'])
    writer.writerow(['Total Cost', f'£{total_cost:,.2f}'])
    writer.writerow(['Total Profit', f'£{total_profit:,.2f}'])
    writer.writerow(['Overall Margin', f'{overall_margin}%'])
    writer.writerow([])
    
    # Store breakdown
    writer.writerow(['=== PROFIT BY SHOWROOM ==='])
    writer.writerow(['Store', 'Invoices', 'm² Sold', 'Revenue (Ex VAT)', 'Cost', 'Profit', 'Margin %'])
    
    for showroom_name, data in sorted(showroom_data.items(), key=lambda x: x[1]["revenue_ex_vat"], reverse=True):
        profit = data["revenue_ex_vat"] - data["cost"]
        margin = round((profit / data["revenue_ex_vat"] * 100), 1) if data["revenue_ex_vat"] > 0 else 0
        writer.writerow([
            showroom_name,
            data["count"],
            f'{data["m2_sold"]:.2f}',
            f'£{data["revenue_ex_vat"]:,.2f}',
            f'£{data["cost"]:,.2f}',
            f'£{profit:,.2f}',
            f'{margin}%'
        ])
    
    writer.writerow([])
    
    # Product breakdown
    writer.writerow(['=== PROFIT BY PRODUCT (Top 50) ==='])
    writer.writerow(['Product', 'Qty Sold', 'm² Sold', 'Revenue (Ex VAT)', 'Cost', 'Profit', 'Margin %', 'Profit/m²'])
    
    sorted_products = sorted(product_data.items(), key=lambda x: x[1]["revenue"] - x[1]["cost"], reverse=True)[:50]
    
    for product_name, data in sorted_products:
        profit = data["revenue"] - data["cost"]
        margin = round((profit / data["revenue"] * 100), 1) if data["revenue"] > 0 else 0
        profit_per_m2 = round(profit / data["m2"], 2) if data["m2"] > 0 else 0
        writer.writerow([
            product_name,
            data["qty"],
            f'{data["m2"]:.2f}',
            f'£{data["revenue"]:,.2f}',
            f'£{data["cost"]:,.2f}',
            f'£{profit:,.2f}',
            f'{margin}%',
            f'£{profit_per_m2}'
        ])
    
    output.seek(0)
    
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={
            "Content-Disposition": f"attachment; filename=profit_report_{period}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
        }
    )

# Health check endpoint for Kubernetes
@app.get("/health")
async def root_health_check():
    try:
        # Test MongoDB connection
        await client.admin.command('ping')
        return {"status": "healthy", "database": "connected"}
    except Exception as e:
        return {"status": "unhealthy", "database": str(e)}


# Stripe Webhook Handler
@api_router.post("/webhook/stripe")
async def stripe_webhook(request: Request):
    """Handle Stripe webhook events for payment status updates"""
    try:
        import stripe
        
        stripe_api_key = os.environ.get("STRIPE_SECRET_KEY") or os.environ.get("STRIPE_API_KEY")
        stripe_webhook_secret = os.environ.get("STRIPE_WEBHOOK_SECRET")
        
        if not stripe_api_key:
            logging.error("Stripe API key not configured")
            return {"status": "error", "message": "Payment service not configured"}
        
        stripe.api_key = stripe_api_key
        
        # Get raw body for signature verification
        body = await request.body()
        signature = request.headers.get("Stripe-Signature")
        
        try:
            if stripe_webhook_secret and signature:
                event = stripe.Webhook.construct_event(body, signature, stripe_webhook_secret)
            else:
                import json
                event = json.loads(body)
            
            # Process webhook event
            event_type = event.get("type", "")
            
            if event_type == "checkout.session.completed":
                session = event.get("data", {}).get("object", {})
                session_id = session.get("id")
                payment_status = session.get("payment_status")
                session_metadata = session.get("metadata") or {}

                if payment_status == "paid":
                    # ────────────────────────────────────────────────────────
                    # SAMPLE ORDERS — flip status to paid via the webhook so
                    # we don't depend on the customer reaching the success
                    # page. Built in response to the 2 May 2026 Zoe Ward
                    # incident where a sample customer paid £2.99, closed
                    # the tab before the success-page poll fired, and the
                    # sample order silently stayed at status='pending'.
                    # ────────────────────────────────────────────────────────
                    if (session_metadata.get("order_type") or "").lower() == "sample":
                        sample_order_id = session_metadata.get("order_id")
                        if sample_order_id:
                            sample_order = await db.sample_orders.find_one(
                                {"id": sample_order_id}, {"_id": 0}
                            )
                            if sample_order and sample_order.get("status") not in (
                                "paid", "shipped", "delivered", "completed"
                            ):
                                now = datetime.now(timezone.utc).isoformat()
                                await db.sample_orders.update_one(
                                    {"id": sample_order_id},
                                    {"$set": {
                                        "status": "paid",
                                        "paid_at": now,
                                        "webhook_paid": True,
                                        "webhook_event_id": event.get("id"),
                                        "stripe_session_id": session_id,
                                    }},
                                )
                                logging.info(
                                    f"[webhook] sample_order paid via webhook: "
                                    f"{sample_order_id} session={session_id}"
                                )
                                # Sweep abandoned-basket capture for this email
                                cust_email = (
                                    sample_order.get("customer_email")
                                    or session.get("customer_email")
                                    or ""
                                ).lower()
                                if cust_email:
                                    try:
                                        await db.abandoned_sample_baskets.update_many(
                                            {"customer_email": cust_email},
                                            {"$set": {"status": "recovered", "recovered_at": now}},
                                        )
                                    except Exception:
                                        pass
                                # Telegram alert
                                try:
                                    from services.telegram_notify import fire_and_forget as _tg_ff
                                    total_str = f"£{float(sample_order.get('total', 0)):.2f}"
                                    customer_name = sample_order.get("customer_name") or "Customer"
                                    order_number = sample_order.get("order_number") or sample_order_id
                                    sample_count = sample_order.get("sample_count", 0)
                                    _tg_ff(
                                        "new_order",
                                        f"🧪 <b>New sample order</b> {order_number}\n"
                                        f"{customer_name}\n"
                                        f"{total_str} · {sample_count} sample(s)",
                                        dedupe_key=f"new-sample-order:{sample_order_id}",
                                    )
                                except Exception as e:  # noqa: BLE001
                                    logging.warning(f"Telegram new sample-order alert failed: {e}")

                    # Update payment transaction
                    transaction = await db.payment_transactions.find_one({"session_id": session_id})

                    # ────────────────────────────────────────────────────────
                    # ORPHAN-RESILIENCE — Klarna Express / PayPal Express do
                    # NOT create a payment_transactions row, only stamp the
                    # session_id on the order doc itself. Fallback: locate
                    # the shop_order directly by session_id (or by metadata
                    # order_id) so those flows also flip to paid via webhook
                    # without depending on the customer reaching success page.
                    # ────────────────────────────────────────────────────────
                    if not transaction:
                        fallback_order_id = session_metadata.get("order_id")
                        fallback_order = None
                        if fallback_order_id:
                            fallback_order = await db.shop_orders.find_one(
                                {"id": fallback_order_id}, {"_id": 0}
                            )
                        if not fallback_order:
                            fallback_order = await db.shop_orders.find_one(
                                {"stripe_session_id": session_id}, {"_id": 0}
                            )
                        if fallback_order and fallback_order.get("payment_status") != "paid":
                            now = datetime.now(timezone.utc).isoformat()
                            await db.shop_orders.update_one(
                                {"id": fallback_order["id"]},
                                {"$set": {
                                    "status": "confirmed",
                                    "payment_status": "paid",
                                    "paid_at": now,
                                    "updated_at": now,
                                    "webhook_paid": True,
                                    "webhook_event_id": event.get("id"),
                                    "stripe_session_id": session_id,
                                }},
                            )
                            # Deduct stock
                            for item in fallback_order.get("items", []):
                                pid = item.get("product_id")
                                if pid:
                                    try:
                                        await db.products.update_one(
                                            {"id": pid},
                                            {"$inc": {"stock": -int(item.get("quantity", 0))}},
                                        )
                                    except Exception:
                                        pass
                            logging.info(
                                f"[webhook] shop_order paid via webhook fallback "
                                f"(no payment_transactions row): "
                                f"{fallback_order['id']} session={session_id}"
                            )
                            # Telegram alert for express checkout
                            try:
                                from services.telegram_notify import fire_and_forget as _tg_ff
                                items_count = len(fallback_order.get("items") or [])
                                total_str = f"£{float(fallback_order.get('total', 0)):.2f}"
                                customer_name = fallback_order.get("customer_name") or "Customer"
                                order_number = fallback_order.get("order_number") or fallback_order["id"]
                                source = fallback_order.get("source") or "express"
                                _tg_ff(
                                    "new_order",
                                    f"🛒 <b>New order</b> {order_number} · {source}\n"
                                    f"{customer_name}\n"
                                    f"{total_str} · {items_count} item(s)",
                                    dedupe_key=f"new-order:{fallback_order['id']}",
                                )
                            except Exception as e:  # noqa: BLE001
                                logging.warning(f"Telegram new_order alert (fallback) failed: {e}")

                            # 📧 Customer + owner order confirmation emails
                            # for Express checkouts (Klarna/PayPal) — these
                            # never hit the polling path, so without this the
                            # customer would never get an email.
                            try:
                                from services.email import send_order_confirmation_emails_idempotent
                                asyncio.create_task(send_order_confirmation_emails_idempotent(fallback_order["id"]))
                            except Exception as e:  # noqa: BLE001
                                logging.error(f"Order confirmation email dispatch failed (fallback): {e}")

                    if transaction and transaction.get("payment_status") != "paid":
                        now = datetime.now(timezone.utc).isoformat()
                        
                        await db.payment_transactions.update_one(
                            {"session_id": session_id},
                            {"$set": {
                                "payment_status": "paid",
                                "webhook_event_id": event.get("id"),
                                "paid_at": now
                            }}
                        )
                        
                        # Update order
                        order_id = transaction.get("order_id")
                        if order_id:
                            order = await db.shop_orders.find_one({"id": order_id}, {"_id": 0})
                            
                            if order and order.get("payment_status") != "paid":
                                await db.shop_orders.update_one(
                                    {"id": order_id},
                                    {"$set": {
                                        "status": "confirmed",
                                        "payment_status": "paid",
                                        "paid_at": now,
                                        "updated_at": now
                                    }}
                                )
                                
                                # Deduct stock
                                for item in order.get("items", []):
                                    await db.products.update_one(
                                        {"id": item["product_id"]},
                                        {"$inc": {"stock": -int(item["quantity"])}}
                                    )
                                
                                # Clear cart
                                customer_id = order.get("customer_id")
                                if customer_id:
                                    await db.shop_customers.update_one(
                                        {"id": customer_id},
                                        {"$set": {"cart": []}}
                                    )

                                # 🛒 Telegram alert — fire-and-forget so a slow
                                # Telegram response never blocks Stripe's
                                # webhook. Honours the per-event toggle and
                                # the dedupe window. Dedupe-keyed on order_id
                                # so a webhook retry from Stripe doesn't
                                # double-ping.
                                try:
                                    from services.telegram_notify import fire_and_forget as _tg_ff
                                    items_count = len(order.get("items") or [])
                                    total_str = f"£{float(order.get('total', 0)):.2f}"
                                    customer_name = order.get("customer_name") or "Customer"
                                    order_number = order.get("order_number") or order_id
                                    is_trade = bool(order.get("trade_metadata"))
                                    badge = " · TRADE" if is_trade else ""
                                    _tg_ff(
                                        "new_order",
                                        f"🛒 <b>New order</b> {order_number}{badge}\n"
                                        f"{customer_name}\n"
                                        f"{total_str} · {items_count} item{'s' if items_count != 1 else ''}",
                                        dedupe_key=f"new-order:{order_id}",
                                    )
                                except Exception as e:  # noqa: BLE001
                                    logging.warning(f"Telegram new_order alert failed (webhook): {e}")

                                # 📧 Customer + owner order confirmation emails —
                                # idempotent so the poll path can't re-fire them.
                                # This is the fix for the 16 Jun 2026 incident
                                # where Carolina Santiago paid £834.63 but nobody
                                # got an email because she closed the tab before
                                # the success page poll ran.
                                try:
                                    from services.email import send_order_confirmation_emails_idempotent
                                    asyncio.create_task(send_order_confirmation_emails_idempotent(order_id))
                                except Exception as e:  # noqa: BLE001
                                    logging.error(f"Order confirmation email dispatch failed (webhook): {e}")
                        
                        logging.info(f"Payment confirmed for session {session_id}")

            # Wallet Express (Apple Pay / Google Pay) uses PaymentIntents, not
            # Checkout Sessions — handle that event shape separately here.
            elif event_type == "payment_intent.succeeded":
                pi = event.get("data", {}).get("object", {})
                pi_id = pi.get("id")
                metadata = pi.get("metadata") or {}
                order_id = metadata.get("order_id")
                if order_id:
                    order = await db.shop_orders.find_one({"id": order_id}, {"_id": 0})
                    if order and order.get("payment_status") != "paid":
                        now = datetime.now(timezone.utc).isoformat()
                        await db.shop_orders.update_one(
                            {"id": order_id},
                            {"$set": {
                                "status": "confirmed",
                                "payment_status": "paid",
                                "paid_at": now,
                                "updated_at": now,
                                "stripe_payment_intent_status": pi.get("status", "succeeded"),
                            }},
                        )
                        logging.info(f"[webhook] Wallet Express PaymentIntent paid: {pi_id} → order {order_id}")

                        # 🛒 Telegram alert — same payload shape as the
                        # checkout-session path so the admin can't tell
                        # whether the order came in via Apple/Google Pay
                        # express or the standard checkout. Dedupe on
                        # order_id so retries don't double-fire.
                        try:
                            from services.telegram_notify import fire_and_forget as _tg_ff
                            fresh = await db.shop_orders.find_one({"id": order_id}, {"_id": 0}) or order
                            items_count = len(fresh.get("items") or [])
                            total_str = f"£{float(fresh.get('total', 0)):.2f}"
                            customer_name = fresh.get("customer_name") or "Customer"
                            order_number = fresh.get("order_number") or order_id
                            is_trade = bool(fresh.get("trade_metadata"))
                            badge = " · TRADE" if is_trade else ""
                            _tg_ff(
                                "new_order",
                                f"🛒 <b>New order</b> {order_number}{badge}\n"
                                f"{customer_name} · Wallet Express\n"
                                f"{total_str} · {items_count} item{'s' if items_count != 1 else ''}",
                                dedupe_key=f"new-order:{order_id}",
                            )
                        except Exception as e:  # noqa: BLE001
                            logging.warning(f"Telegram new_order alert failed (wallet express): {e}")

                        # 📧 Customer + owner order confirmation emails
                        # for Wallet Express (Apple Pay / Google Pay) —
                        # same idempotent dispatcher as the other paths.
                        try:
                            from services.email import send_order_confirmation_emails_idempotent
                            asyncio.create_task(send_order_confirmation_emails_idempotent(order_id))
                        except Exception as e:  # noqa: BLE001
                            logging.error(f"Order confirmation email dispatch failed (wallet express): {e}")

            # ────────────────────────────────────────────────────────────
            # 🚨 Failed-payment branches — fire the `failed_payment`
            # Telegram alert so the admin can phone the customer back
            # within minutes. Recovery rate on a personal call after a
            # card decline on a furniture/home-improvement basket is
            # 30-40%, so this directly recovers revenue.
            #
            # Two Stripe event shapes to handle:
            #   • payment_intent.payment_failed — fires for every PI
            #     decline (Wallet Express + standard checkout). This is
            #     the most reliable signal.
            #   • checkout.session.async_payment_failed — only fires for
            #     async methods (BACS / SEPA / Klarna later-pay). Most
            #     UK card declines come through PI.
            # ────────────────────────────────────────────────────────────
            elif event_type in ("payment_intent.payment_failed",
                                "checkout.session.async_payment_failed"):
                obj = event.get("data", {}).get("object", {}) or {}

                # Resolve order_id via metadata first, then fall back to
                # the payment_transactions table (set during checkout).
                order_id = (obj.get("metadata") or {}).get("order_id")
                if not order_id and event_type == "checkout.session.async_payment_failed":
                    sess_id = obj.get("id")
                    if sess_id:
                        tx = await db.payment_transactions.find_one(
                            {"session_id": sess_id}, {"_id": 0, "order_id": 1, "order_number": 1}
                        )
                        order_id = (tx or {}).get("order_id")
                order = (
                    await db.shop_orders.find_one({"id": order_id}, {"_id": 0})
                    if order_id else None
                ) or {}

                # Decline detail — Stripe puts the human-readable reason
                # on last_payment_error (PI) or last_setup_error (rare).
                err = obj.get("last_payment_error") or obj.get("last_setup_error") or {}
                decline_code = err.get("decline_code") or err.get("code") or "—"
                decline_msg = (err.get("message") or "Payment failed")[:160]

                # Best-effort amount — PI has amount_received/amount in
                # cents; checkout.session has amount_total. Both in the
                # smallest currency unit per Stripe's API contract.
                amount_minor = (
                    obj.get("amount") or obj.get("amount_total") or 0
                )
                amount_str = f"£{(int(amount_minor) / 100.0):.2f}" if amount_minor else "—"

                customer_name = (
                    order.get("customer_name")
                    or (obj.get("billing_details") or {}).get("name")
                    or (obj.get("customer_details") or {}).get("name")
                    or "Customer"
                )
                customer_email = (
                    order.get("customer_email")
                    or (obj.get("billing_details") or {}).get("email")
                    or (obj.get("customer_details") or {}).get("email")
                    or "—"
                )
                customer_phone = (
                    order.get("customer_phone")
                    or (obj.get("billing_details") or {}).get("phone")
                    or "—"
                )
                order_number_display = order.get("order_number") or order_id or "—"

                # Persist the failure on the order so the admin UI can
                # filter / show a "decline reason" badge later. Stamps
                # `payment_failed_at` once — repeats from Stripe retries
                # don't overwrite the original decline timestamp.
                if order_id:
                    await db.shop_orders.update_one(
                        {"id": order_id, "payment_failed_at": {"$exists": False}},
                        {"$set": {
                            "payment_status": "failed",
                            "payment_failed_at": datetime.now(timezone.utc).isoformat(),
                            "payment_failed_reason": decline_msg,
                            "payment_failed_code": decline_code,
                            "updated_at": datetime.now(timezone.utc).isoformat(),
                        }},
                    )

                # Telegram fire-and-forget. Dedupe on order_id (or PI id
                # when no order is mapped) so Stripe retries don't spam.
                try:
                    from services.telegram_notify import fire_and_forget as _tg_ff
                    dedupe = order_id or obj.get("id") or "anon"
                    _tg_ff(
                        "failed_payment",
                        (
                            f"🚨 <b>Payment failed</b> {order_number_display}\n"
                            f"{customer_name} · {customer_email}\n"
                            f"📞 {customer_phone}\n"
                            f"{amount_str} · {decline_code}\n"
                            f"<i>{decline_msg}</i>"
                        ),
                        dedupe_key=f"failed-payment:{dedupe}",
                    )
                except Exception as e:  # noqa: BLE001
                    logging.warning(f"Telegram failed_payment alert failed: {e}")

                logging.info(
                    f"[webhook] Payment failed event={event_type} "
                    f"order={order_number_display} code={decline_code}"
                )

                # 📧 Recovery email — fire AFTER the order has been
                # stamped with payment_failed_reason so the email can
                # quote the bank's decline message verbatim. Re-fetches
                # the row inside the service so the persisted decline
                # reason is always present. Idempotent on order_id —
                # Stripe retries can't double-send.
                if order_id:
                    try:
                        from services.payment_recovery import send_payment_recovery_email
                        fresh_order = await db.shop_orders.find_one({"id": order_id}, {"_id": 0})
                        if fresh_order:
                            res = await send_payment_recovery_email(db, fresh_order)
                            if not res.get("ok"):
                                logging.warning(
                                    f"[webhook] payment-recovery email skip/fail for {order_id}: {res}"
                                )
                    except Exception as e:  # noqa: BLE001
                        logging.warning(f"Payment recovery email failed: {e}")
            
            return {"status": "ok", "event_type": event_type}
            
        except Exception as e:
            logging.error(f"Stripe webhook processing error: {e}")
            return {"status": "error", "message": str(e)}
        
    except Exception as e:
        logging.error(f"Stripe webhook error: {e}")
        return {"status": "error", "message": str(e)}

# Simple root endpoint for testing
@app.get("/")
async def root():
    return {"message": "Tile Station API is running"}


# Apple Pay domain verification — Stripe fetches this file during
# ApplePayDomain.create() to verify the merchant controls the domain.
# MUST be served at exactly this path (not under /api/...).
from routes.wallet_express import serve_apple_pay_association

@app.get("/.well-known/apple-developer-merchantid-domain-association", include_in_schema=False)
async def _apple_pay_domain_association():
    return await serve_apple_pay_association()

# Downloads directory for browser extensions  
DOWNLOADS_DIR = Path(__file__).parent / "downloads"
DOWNLOADS_DIR.mkdir(exist_ok=True)

# API endpoint for downloading extensions
@api_router.get("/extension-download/{filename}")
async def download_extension(filename: str):
    """Download browser extension ZIP files"""
    file_path = DOWNLOADS_DIR / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(
        path=str(file_path),
        filename=filename,
        media_type="application/zip"
    )

# API endpoint for extension preview HTML
@api_router.get("/extension-preview/{supplier}")
async def extension_preview(supplier: str):
    """Serve extension popup.html for preview"""
    ext_dirs = {
        "verona": "/app/verona-extension-v3/browser-extension",
        "wallcano": "/app/wallcano-ext-new",
        "splendour": "/app/splendour-ext-new",
        "ceramica": "/app/ceramica-ext-new"
    }
    
    if supplier not in ext_dirs:
        raise HTTPException(status_code=404, detail="Extension not found")
    
    file_path = Path(ext_dirs[supplier]) / "popup.html"
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Popup file not found")
    
    return FileResponse(
        path=str(file_path),
        media_type="text/html"
    )

# ============================================
# ADMIN DATABASE FIX ENDPOINTS  
# ============================================

@api_router.post("/admin/fix-tile-dimensions")
async def fix_tile_dimensions_endpoint(
    dry_run: bool = True,
    supplier: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    """
    Fix tile dimensions that were entered in mm instead of cm.
    
    Args:
        dry_run: If True, only preview changes without applying (default: True)
        supplier: Optional supplier filter (e.g., "LEPORCE")
    
    Returns:
        Summary of fixes applied or to be applied
    """
    # Only allow super_admin or admin to run this
    if current_user.get("role") not in ["super_admin", "admin"]:
        raise HTTPException(status_code=403, detail="Admin access required")
    
    from pymongo import MongoClient
    sync_client = MongoClient(os.environ.get("MONGO_URL"))
    sync_db = sync_client[os.environ.get("DB_NAME", "tile_station")]
    
    collections = ['products', 'supplier_products', 'tiles']
    results = {
        "mode": "dry_run" if dry_run else "applied",
        "supplier_filter": supplier,
        "collections": {},
        "total_found": 0,
        "total_fixed": 0
    }
    
    try:
        for collection_name in collections:
            collection = sync_db[collection_name]
            
            # Build query for suspicious dimensions (> 200cm = likely mm)
            query = {
                "$or": [
                    {"tile_width": {"$gt": 200}},
                    {"tile_height": {"$gt": 200}}
                ]
            }
            
            if supplier:
                query["$or"] = [
                    {"$and": [{"tile_width": {"$gt": 200}}, {"$or": [{"supplier": supplier}, {"supplier_name": supplier}]}]},
                    {"$and": [{"tile_height": {"$gt": 200}}, {"$or": [{"supplier": supplier}, {"supplier_name": supplier}]}]}
                ]
            
            products = list(collection.find(query))
            collection_results = []
            
            for product in products:
                sku = product.get('sku') or product.get('supplier_product_code') or str(product.get('_id'))
                name = product.get('name') or product.get('display_name') or 'Unknown'
                
                old_width = product.get('tile_width')
                old_height = product.get('tile_height')
                tiles_per_box = product.get('tiles_per_box')
                
                # Calculate new values
                new_width = old_width / 10 if old_width and old_width > 200 else old_width
                new_height = old_height / 10 if old_height and old_height > 200 else old_height
                
                new_m2_per_piece = None
                if new_width and new_height:
                    new_m2_per_piece = round((new_width / 100) * (new_height / 100), 4)
                
                new_box_coverage = None
                if tiles_per_box and new_m2_per_piece:
                    new_box_coverage = round(new_m2_per_piece * tiles_per_box, 4)
                
                fix_info = {
                    "sku": sku,
                    "name": name[:50],
                    "old_dimensions": f"{old_width}x{old_height}cm",
                    "new_dimensions": f"{new_width}x{new_height}cm",
                    "old_m2_per_piece": round((old_width / 100) * (old_height / 100), 4) if old_width and old_height else None,
                    "new_m2_per_piece": new_m2_per_piece,
                    "new_box_coverage": new_box_coverage
                }
                
                if not dry_run:
                    # Apply the fix
                    update_fields = {
                        "updated_at": datetime.now(timezone.utc),
                        "dimension_fix_applied": True,
                        "dimension_fix_date": datetime.now(timezone.utc)
                    }
                    
                    if old_width and old_width > 200:
                        update_fields["tile_width"] = new_width
                    if old_height and old_height > 200:
                        update_fields["tile_height"] = new_height
                    if new_m2_per_piece:
                        update_fields["tile_m2_per_piece"] = new_m2_per_piece
                        if new_box_coverage:
                            update_fields["sqm_per_box"] = new_box_coverage
                            update_fields["box_m2_coverage"] = new_box_coverage
                    
                    collection.update_one(
                        {"_id": product["_id"]},
                        {"$set": update_fields}
                    )
                    fix_info["status"] = "fixed"
                    results["total_fixed"] += 1
                else:
                    fix_info["status"] = "would_be_fixed"
                
                collection_results.append(fix_info)
            
            results["collections"][collection_name] = {
                "count": len(products),
                "products": collection_results[:20]  # Limit to first 20 for response size
            }
            results["total_found"] += len(products)
        
        sync_client.close()
        
        return results
        
    except Exception as e:
        sync_client.close()
        raise HTTPException(status_code=500, detail=f"Fix failed: {str(e)}")


# Include the router in the main app
app.include_router(api_router)


@api_router.post("/admin/mark-recently-updated")
async def mark_recently_updated_endpoint(
    current_user: dict = Depends(get_current_user)
):
    """
    Mark all supplier_products that have been synced with products as recently updated.
    This sets the 'recently_updated' and 'updated_at' fields.
    """
    if current_user.get("role") not in ["super_admin", "admin"]:
        raise HTTPException(status_code=403, detail="Admin access required")
    
    from pymongo import MongoClient
    sync_client = MongoClient(os.environ.get("MONGO_URL"))
    sync_db = sync_client[os.environ.get("DB_NAME", "tile_station")]
    
    try:
        # Find supplier_products that have a products_db_id (synced products)
        # and mark them as recently updated
        result = sync_db.supplier_products.update_many(
            {"products_db_id": {"$exists": True, "$ne": None}},
            {
                "$set": {
                    "recently_updated": True,
                    "updated_at": datetime.now(timezone.utc)
                }
            }
        )
        
        sync_client.close()
        
        return {
            "success": True,
            "matched": result.matched_count,
            "modified": result.modified_count,
            "message": f"Marked {result.modified_count} products as recently updated"
        }
    except Exception as e:
        sync_client.close()
        raise HTTPException(status_code=500, detail=str(e))

# Mount static files for uploaded images - use /api/uploads to go through ingress
app.mount("/api/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")

# Mount static files for extension previews
STATIC_DIR = Path("/app/backend/static")
STATIC_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/api/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

@app.on_event("startup")
async def startup_scheduler():
    """Initialize the import scheduler on server startup"""
    try:
        from services.scheduler import initialize_scheduler
        await initialize_scheduler()
        logger.info("Import scheduler initialized successfully")
    except Exception as e:
        logger.error(f"Failed to initialize scheduler: {e}")
    
    # Create database indexes for performance
    try:
        await create_database_indexes()
        logger.info("Database indexes created/verified")
    except Exception as e:
        logger.error(f"Failed to create indexes: {e}")
    
    # Run NonexNone cleanup in background (don't block startup)
    import asyncio
    asyncio.create_task(safe_cleanup_on_startup())

    # Self-heal Playwright browsers — Railway rebuilds can lose the chromium
    # download, which killed all supplier syncs (19 Aug). Idempotent, background.
    try:
        from services.playwright_guard import ensure_chromium_background
        ensure_chromium_background()
    except Exception as e:
        logger.warning(f"[pw-guard] startup check failed: {e}")

    # One-shot repair (19 Aug incident): the old Set Series bulk-assign stamped
    # the series into original_series/unique_name, clobbering supplier product
    # names. Unstamp any remaining rows in the background. Idempotent.
    async def _repair_series_stamps():
        try:
            from routes.series_manager import repair_stamped_supplier_name_fields
            from config import get_db as _get_series_db
            res = await repair_stamped_supplier_name_fields(_get_series_db())
            if res.get("original_series_restored") or res.get("unique_name_restored"):
                print(f"[series-repair] restored supplier-name fields: {res}", flush=True)
        except Exception:
            logger.exception("[series-repair] startup repair failed")
    asyncio.create_task(_repair_series_stamps())

    # 26 Aug 2026 — one-shot size format migration: every product size becomes
    # mm format ("30x60cm" → "300x600mm") so the storefront size filter is
    # uniform. Guarded by a migration flag; backups in size_migration_backup.
    async def _migrate_sizes_mm():
        try:
            from services.size_migration import run_size_migration_once
            from routes.tiles import get_tile_db
            res = await asyncio.to_thread(run_size_migration_once, get_tile_db())
            if res:
                print(f"[size-mm] migration ran: {res['collections']}", flush=True)
        except Exception:
            logger.exception("[size-mm] startup migration failed")
        # Then rebuild the Size filter values from live products so the
        # storefront sidebar options match the mm product sizes (one-shot).
        try:
            from routes.tiles import get_tile_db
            sdb = get_tile_db()
            if not sdb.migration_flags.find_one({"key": "sizes_mm_filters_v1"}):
                from routes.filters import rebuild_filters_from_live_products
                fres = await rebuild_filters_from_live_products(filter_name="Size", preserve_manual=False)
                sdb.migration_flags.update_one(
                    {"key": "sizes_mm_filters_v1"},
                    {"$set": {"key": "sizes_mm_filters_v1",
                              "done_at": datetime.now(timezone.utc).isoformat(),
                              "message": fres.get("message")}},
                    upsert=True,
                )
                print(f"[size-mm] filter rebuild: {fres.get('message')}", flush=True)
        except Exception:
            logger.exception("[size-mm] size filter rebuild failed")
    asyncio.create_task(_migrate_sizes_mm())

    # Size filter auto-sync: whenever products are published/edited/synced,
    # the sidebar size options follow automatically — no buttons to click.
    async def _size_filter_autosync_loop():
        await asyncio.sleep(180)
        while True:
            try:
                from routes.filters import auto_sync_size_filter
                res = await auto_sync_size_filter()
                if res and res.get("changed"):
                    print(f"[size-filter-autosync] refreshed: {res.get('values')} values", flush=True)
            except Exception:
                logger.exception("[size-filter-autosync] failed")
            await asyncio.sleep(600)
    asyncio.create_task(_size_filter_autosync_loop())

    # 5 Jun 2026 — purge stale noindex flags on safe-listed paths so
    # the homepage / new-collection / clearance etc. can never stay
    # stuck noindex'd between deploys. One-shot, idempotent, runs in
    # the background so it never blocks startup.
    try:
        from services.seo_auto_fixer import purge_safelist_noindex_flags
        asyncio.create_task(purge_safelist_noindex_flags())
    except Exception as e:
        logger.warning(f"Failed to schedule noindex safelist purge: {e}")

    # Credential health check — verifies required env vars (admin +
    # supplier portal passwords) are set. Fires a Telegram alert if
    # anything is missing so the admin can patch Railway env vars
    # before customers feel it. Never blocks startup. We hold a
    # strong reference on `app.state` to prevent the asyncio task
    # from being garbage-collected mid-flight (Python 3.11 quirk).
    try:
        from services.credential_check import run_credential_check_on_startup
        app.state.credential_check_task = asyncio.create_task(
            run_credential_check_on_startup()
        )
    except Exception as e:
        logger.warning(f"Failed to schedule credential check: {e}")

    # Health monitor — pings every customer-facing endpoint every 60s
    # and fires email + Telegram + admin-banner alerts on 2 consecutive
    # failures. Never blocks startup. Disable with DISABLE_HEALTH_MONITOR=1.
    try:
        from services.health_monitor import start_health_monitor
        start_health_monitor()
        logger.info("Health monitor background task started")
    except Exception as e:
        logger.warning(f"Failed to start health monitor: {e}")

    # Phase 3 — Nudge Google Search Console to re-fetch our sitemap
    # on every backend boot. The helper is internally throttled
    # (12 hours minimum gap) so a Railway redeploy storm doesn't spam
    # Google. Runs in background — never blocks startup or fails the
    # boot if GSC isn't connected yet.
    async def _gsc_kickstart():
        try:
            from services.gsc import maybe_auto_submit_sitemap
            res = await maybe_auto_submit_sitemap(reason="startup")
            if res.get("submitted"):
                logger.info("[gsc] sitemap auto-submitted on startup: %s", res.get("feedpath"))
            elif res.get("skipped"):
                logger.info("[gsc] startup auto-submit skipped: %s", res.get("reason"))
        except Exception as e:
            logger.warning("[gsc] startup auto-submit failed: %s", e)
    asyncio.create_task(_gsc_kickstart())

    # Autonomous SEO daily digest — emails the admin a summary of what
    # the autopilot did in the last 24h (pages auto-published, A/B
    # winners promoted, sitemap re-submissions, GSC growth). Fires once
    # a day at 08:00 UTC. Mirrors the gsc_digest pattern.
    async def _seo_autopilot_digest_loop():
        from datetime import datetime, timezone, timedelta
        await asyncio.sleep(60)  # let everything else boot
        while True:
            try:
                now = datetime.now(timezone.utc)
                # Next 08:00 UTC
                target = now.replace(hour=8, minute=0, second=0, microsecond=0)
                if target <= now:
                    target = target + timedelta(days=1)
                wait = (target - now).total_seconds()
                logger.info("[seo-autopilot] next digest at %s (in %ds)", target.isoformat(), int(wait))
                await asyncio.sleep(wait)
                try:
                    from services.seo_autonomous import daily_published_digest
                    summary = await daily_published_digest()
                    # Only email when something actually happened — no point
                    # spamming the admin with empty digests on quiet days.
                    if summary.get("published_count") or summary.get("promoted_count"):
                        try:
                            from services.email import send_email
                            from services.seo_autonomous import _site_url
                            site = _site_url()
                            html_lines = [
                                "<h2 style=\"margin:0 0 12px;font-family:system-ui\">SEO Autopilot — last 24h</h2>",
                                "<p style=\"font-family:system-ui;font-size:14px\">Your SEO autopilot kept growing the site overnight. Here's what happened:</p>",
                                "<ul style=\"font-family:system-ui;font-size:14px;line-height:1.7\">",
                                f"<li><b>{summary.get('published_count', 0)} city pages</b> auto-published and submitted to Google Search Console</li>",
                                f"<li><b>{summary.get('promoted_count', 0)} A/B winners</b> swapped in based on real GSC clicks</li>",
                            ]
                            growth = summary.get("growth") or {}
                            if growth.get("clicks_7d") is not None:
                                html_lines.append(
                                    f"<li><b>{growth['clicks_7d']} clicks</b> from Google in the last 7 days · "
                                    f"<b>{growth.get('impressions_7d', 0)} impressions</b></li>"
                                )
                            html_lines.append("</ul>")
                            if summary.get("published_pages"):
                                html_lines.append('<h3 style="font-family:system-ui">Pages published today</h3><ul style="font-family:system-ui;font-size:13px">')
                                for u in summary["published_pages"][:10]:
                                    html_lines.append(f'<li><a href="{u}">{u}</a></li>')
                                html_lines.append("</ul>")
                            html_lines.append(f'<p style="font-family:system-ui;font-size:12px;color:#888">Nothing for you to do — the autopilot handles everything. Visit <a href="{site}/admin/seo">{site}/admin/seo</a> if you want to peek behind the curtain.</p>')
                            await send_email(
                                to=os.environ.get("DIGEST_RECIPIENT_EMAIL", "qasim@tilestation.co.uk"),
                                subject=f"🚀 SEO autopilot · {summary['published_count']} pages live, {summary['promoted_count']} winners promoted",
                                html="\n".join(html_lines),
                            )
                            logger.info("[seo-autopilot] digest emailed (%d published, %d promoted)",
                                        summary["published_count"], summary["promoted_count"])
                        except Exception:
                            logger.exception("[seo-autopilot] digest email send failed")
                    else:
                        logger.info("[seo-autopilot] digest skipped — nothing happened in last 24h")
                except Exception:
                    logger.exception("[seo-autopilot] digest tick crashed")
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("[seo-autopilot] digest loop iteration crashed; retrying in 1h")
                await asyncio.sleep(3600)
    asyncio.create_task(_seo_autopilot_digest_loop())

    # ──────────────────────────────────────────────────────────────
    # Auto-exports cron — 13 Jun 2026.
    # User request: "Send to accountant every month" for invoices and
    # petty cash. Hourly tick that fires the configured monthly emails
    # on each schedule's `day_of_month` (1st by default). The schedules
    # live in `db.auto_export_schedules` (see routes/auto_exports.py);
    # the per-kind background jobs are in services/invoice_export_jobs
    # and services/petty_cash_export.
    #
    # Design: we tick HOURLY (not daily) so that if the pod sleeps /
    # restarts during the scheduled hour we still catch up the same
    # day. Each schedule has its own `last_sent_at`, so we never
    # double-send within the same calendar month.
    async def _auto_exports_cron_loop():
        from datetime import datetime as _dt, timezone as _tz, timedelta as _td  # noqa: PLC0415
        await asyncio.sleep(120)  # let the rest of the boot settle
        while True:
            try:
                now = _dt.now(_tz.utc)
                # Find every enabled schedule whose day-of-month == today
                # AND that hasn't already been sent this calendar month.
                try:
                    from config import get_db  # noqa: PLC0415
                    db = get_db()
                    cur = db.auto_export_schedules.find(
                        {"enabled": True, "day_of_month": now.day},
                        {"_id": 0},
                    )
                    todo = await cur.to_list(200)
                except Exception:
                    logger.exception("[auto-exports] failed to read schedules")
                    todo = []

                # Last calendar month (the window we email about each cycle)
                first_of_this_month = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
                last_month_anchor = first_of_this_month - _td(days=1)
                target_year, target_month = last_month_anchor.year, last_month_anchor.month
                this_month_key = f"{now.year:04d}-{now.month:02d}"

                for sched in todo:
                    # Skip if we already fired this calendar month — guards
                    # against double-send when the loop ticks again on the
                    # same day or on a pod restart.
                    last_sent = sched.get("last_sent_at") or ""
                    if last_sent[:7] == this_month_key:
                        continue
                    sched_id = sched.get("id")
                    kind = sched.get("kind")
                    recipients = list(sched.get("recipient_emails") or [])
                    # owner_digest delivers via Telegram, not email — so
                    # an empty recipients list is fine for that kind.
                    if not recipients and kind != "owner_digest":
                        continue
                    sender_name = "Tile Station Auto-Exports"
                    sender_email = sched.get("created_by")
                    try:
                        if kind == "invoices":
                            from services.invoice_export_jobs import run_invoice_monthly_email_job  # noqa: PLC0415
                            await run_invoice_monthly_email_job(
                                target_year, target_month,
                                recipients,
                                sched.get("subject"), sched.get("message"),
                                sender_name, sender_email, sched_id,
                            )
                        elif kind == "petty_cash":
                            from services.petty_cash_export import run_petty_cash_monthly_email_job  # noqa: PLC0415
                            await run_petty_cash_monthly_email_job(
                                sched.get("scope", "all_showrooms"),
                                target_year, target_month,
                                recipients,
                                sched.get("subject"), sched.get("message"),
                                sender_name, sender_email, sched_id,
                            )
                        elif kind == "owner_digest":
                            from services.owner_monthly_digest import run_owner_monthly_digest_job  # noqa: PLC0415
                            await run_owner_monthly_digest_job(
                                target_year, target_month, sched_id, None,
                            )
                        else:
                            logger.warning("[auto-exports] unknown kind on schedule %s: %s", sched_id, kind)
                        logger.info("[auto-exports] dispatched %s for %s-%s (schedule %s)",
                                    kind, target_year, target_month, sched_id)
                    except Exception:
                        # The job itself already records `last_sent_status=failed`
                        # and emails a heads-up; we just log here so the loop survives.
                        logger.exception("[auto-exports] schedule %s job raised", sched_id)

                # Sleep until the top of the next hour
                next_hour = (now + _td(hours=1)).replace(minute=0, second=5, microsecond=0)
                sleep_s = max(60, (next_hour - now).total_seconds())
                await asyncio.sleep(sleep_s)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("[auto-exports] cron iteration crashed; retrying in 5m")
                await asyncio.sleep(300)
    asyncio.create_task(_auto_exports_cron_loop())

    # ──────────────────────────────────────────────────────────────
    # Visa expiry alerter — 13 Jun 2026.
    # Sponsor-licence compliance: scan every visa/RTW document, fire
    # 90 / 60 / 30 / 7-day alerts (and an EXPIRED alert) to HR. Each
    # alert is recorded in `hr_visa_alerts` so we never re-send the
    # same threshold + so the Visa Compliance audit report can show
    # the Home Office exactly when each notice went out.
    async def _visa_expiry_alert_loop():
        from datetime import datetime as _dt, timezone as _tz, timedelta as _td  # noqa: PLC0415
        await asyncio.sleep(180)  # let the rest of the boot settle
        while True:
            try:
                now = _dt.now(_tz.utc)
                try:
                    from services.visa_expiry_alerts import run_visa_expiry_alerts  # noqa: PLC0415
                    summary = await run_visa_expiry_alerts()
                    logger.info("[visa-alerts] pass complete: %s", summary)
                except Exception:
                    logger.exception("[visa-alerts] pass crashed; continuing")
                # Schedule the next run for tomorrow 07:00 UTC
                next_run = (now + _td(days=1)).replace(hour=7, minute=0, second=0, microsecond=0)
                if next_run <= now:
                    next_run = next_run + _td(days=1)
                sleep_s = max(60, (next_run - now).total_seconds())
                await asyncio.sleep(sleep_s)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("[visa-alerts] outer loop crashed; retrying in 1h")
                await asyncio.sleep(3600)
    asyncio.create_task(_visa_expiry_alert_loop())

    # ──────────────────────────────────────────────────────────────
    # Orphaned-orders sweep — 16 Jun 2026.
    # Safety net for the order-confirmation email path. Runs every
    # 5 min, finds any paid order whose confirmation_email_sent_at
    # marker is missing (paid_at > 10 min ago, ≤ 72h ago) and fires
    # the idempotent dispatcher. One Telegram alert per pass so a
    # future regression of the email path gets caught in minutes,
    # not days like the Carolina Santiago £834.63 incident.
    async def _orphan_orders_sweep_kickstart():
        try:
            from services.orphaned_orders_sweep import orphan_orders_sweep_loop  # noqa: PLC0415
            await orphan_orders_sweep_loop()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("[orphan-orders] sweep loop crashed on boot")
    asyncio.create_task(_orphan_orders_sweep_kickstart())

    # Voice — Weekly call-volume summary (Mondays 09:00 UTC)
    async def _voice_weekly_kickstart():
        try:
            from services.voice_weekly_summary import voice_weekly_summary_loop  # noqa: PLC0415
            await voice_weekly_summary_loop()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("[voice-weekly] loop crashed on boot")
    asyncio.create_task(_voice_weekly_kickstart())

    # Marketing Studio orphan-blob sweep — runs nightly at 03:00 UTC.
    # Probes each marketing_asset's image_url, soft-deletes any that's
    # been 404 on R2 for ≥48h. 7 safety rails (see
    # services/marketing_storage_sweep.py) prevent accidental deletion
    # of published or recent assets. Audit log for full recovery.
    async def _orphan_sweep_kickstart():
        try:
            from services.marketing_storage_sweep import nightly_loop
            await nightly_loop()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("[orphan-sweep] nightly task crashed on boot")
    asyncio.create_task(_orphan_sweep_kickstart())

    # Auto-seed the Tile Visualizer sample rooms on boot if the
    # collection is empty. This means a fresh Railway deploy gets
    # the 10 curated rooms automatically — the live `/visualizer` page
    # never shows a blank "pick a room" grid (the May 3 2026 production
    # incident). Idempotent: skips when any rooms already exist so
    # admin edits aren't overwritten.
    async def _visualizer_rooms_kickstart():
        try:
            from services.visualizer_seed import seed_visualizer_rooms_if_empty
            res = await seed_visualizer_rooms_if_empty(db)
            if res.get("seeded"):
                logger.info("[visualizer] auto-seeded %d sample rooms on boot", res["seeded"])
            else:
                logger.info("[visualizer] sample rooms already populated (%d) — skipped seed", res.get("existing", 0))
        except Exception as e:
            logger.warning("[visualizer] startup auto-seed failed: %s", e)
    asyncio.create_task(_visualizer_rooms_kickstart())

    # Marketing Studio orphan-slide auto-cleanup on boot. Removes any
    # `hero_slides` row whose linked marketing_asset has been deleted
    # or unpublished — covers legacy data inserted before May 3 2026
    # (when we started tagging slides with asset_id + source). Means
    # the BANK HOLIDAY incident self-heals on the next deploy without
    # any admin intervention. Idempotent — does nothing when there are
    # no orphans.
    async def _orphan_slides_cleanup_kickstart():
        try:
            await asyncio.sleep(20)  # wait for index loaders / connections
            removed = 0
            try:
                async for slide in db.hero_slides.find({}, {"_id": 0}):
                    is_orphan = False
                    if slide.get("source") == "marketing_studio":
                        aid = slide.get("asset_id")
                        if not aid:
                            is_orphan = True
                        else:
                            a = await db.marketing_assets.find_one({"id": aid})
                            if not a or a.get("deleted") or not a.get("published_to"):
                                is_orphan = True
                    elif slide.get("image"):
                        # Untagged legacy slides — check if the image matches a
                        # deleted/unpublished marketing_studio asset. This catches
                        # the May 3 BANK HOLIDAY incident (slides created before
                        # we started tagging with asset_id).
                        a = await db.marketing_assets.find_one({"image_url": slide["image"]})
                        if a and (a.get("deleted") or not a.get("published_to")):
                            is_orphan = True
                    if is_orphan:
                        await db.hero_slides.delete_one({
                            "image": slide.get("image", ""),
                            "title": slide.get("title", ""),
                        })
                        removed += 1
                if removed:
                    logger.info("[orphan-slides] auto-cleaned %d orphan slides on boot", removed)
                    try:
                        from utils.endpoint_cache import endpoint_cache
                        endpoint_cache.invalidate("public_hero_slides")
                    except Exception:
                        pass
            except Exception:
                logger.exception("[orphan-slides] startup cleanup pass crashed")
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("[orphan-slides] kickstart crashed")
    asyncio.create_task(_orphan_slides_cleanup_kickstart())

    # Marketing-studio scheduled-unpublish loop. Every 60s it scans for
    # promo banners / homepage heroes whose `scheduled_end` is in the
    # past and flips them to enabled=False (busting the storefront cache
    # so the homepage updates immediately). Solves the May 3 2026
    # incident where Bank Holiday banners stayed live past their end time.
    async def _auto_unpublish_kickstart():
        try:
            from services.auto_unpublish import auto_unpublish_loop
            await auto_unpublish_loop(db)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("[auto-unpublish] background task crashed")
    asyncio.create_task(_auto_unpublish_kickstart())

    # Stripe ↔ DB payment-method capability auto-sync. Catches drift like
    # paypal_enabled=True in our admin DB but PayPal never activated on
    # Stripe (the May 2 2026 sample-orders incident). Background task,
    # cannot block startup.
    async def _stripe_pm_sync_kickstart():
        try:
            from services.stripe_pm_sync import sync_stripe_payment_methods_to_db
            res = await sync_stripe_payment_methods_to_db(db)
            if res.get("changes"):
                logger.warning("[stripe-pm-sync] startup result: %s", res)
            else:
                logger.info("[stripe-pm-sync] startup result: %s", res)
        except Exception as e:
            logger.warning("[stripe-pm-sync] startup sync failed: %s", e)
    asyncio.create_task(_stripe_pm_sync_kickstart())

    # Start WhatsApp message scheduler
    try:
        from services.whatsapp_scheduler import start_whatsapp_scheduler
        start_whatsapp_scheduler(db)
        logger.info("WhatsApp message scheduler started")
    except Exception as e:
        logger.error(f"Failed to start WhatsApp scheduler: {e}")

    # Ensure filter_groups have group_slugs for group-level matching
    try:
        await db.filter_groups.update_one(
            {"slug": "tiles", "group_slugs": {"$exists": False}},
            {"$set": {"group_slugs": ["tiles"]}}
        )
        await db.filter_groups.update_one(
            {"slug": "tiles", "group_slugs": {"$size": 0}},
            {"$set": {"group_slugs": ["tiles"]}}
        )
        logger.info("Filter groups group_slugs migration verified")
    except Exception as e:
        logger.error(f"Failed to migrate filter groups: {e}")

    # Recalculate WAS prices: old formula used markup (NOW * 1.20 = 17% off)
    # New formula uses discount (NOW / 0.80 = 20% off)
    import math
    try:
        migration_flag = await db.migrations.find_one({"name": "was_price_discount_formula_v1"})
        if not migration_flag:
            products = await db.tiles.find(
                {"was_markup_percent": {"$gt": 0}, "was_price": {"$gt": 0}},
                {"_id": 1, "was_markup_percent": 1, "was_price": 1, "price": 1, "room_lot_price": 1}
            ).to_list(10000)
            updated = 0
            for p in products:
                pct = p.get("was_markup_percent", 0)
                selling = p.get("price") or p.get("room_lot_price") or 0
                if pct > 0 and pct < 100 and selling > 0:
                    new_was = math.ceil(selling / (1 - pct / 100)) - 0.01
                    old_was = p.get("was_price", 0)
                    if abs(new_was - old_was) > 0.02:
                        await db.tiles.update_one(
                            {"_id": p["_id"]},
                            {"$set": {"was_price": new_was}}
                        )
                        updated += 1
            await db.migrations.insert_one({"name": "was_price_discount_formula_v1", "updated": updated, "ran_at": datetime.utcnow()})
            logger.info(f"WAS price migration complete: {updated} products recalculated")
        else:
            logger.info("WAS price migration already applied")
    except Exception as e:
        logger.error(f"Failed to run WAS price migration: {e}")

    # Sync discount_percentage with was_markup_percent (user's entered value)
    # Previously discount_percentage was recalculated from rounded was_price, causing drift (e.g., 24% instead of 25%)
    try:
        migration_flag = await db.migrations.find_one({"name": "sync_discount_percentage_v1"})
        if not migration_flag:
            for coll_name in ["tiles", "supplier_products"]:
                coll = db[coll_name]
                products = await coll.find(
                    {"was_markup_percent": {"$gt": 0}},
                    {"_id": 1, "was_markup_percent": 1, "discount_percentage": 1}
                ).to_list(10000)
                synced = 0
                for p in products:
                    wmp = p.get("was_markup_percent", 0)
                    dp = p.get("discount_percentage", 0)
                    if wmp > 0 and abs(wmp - (dp or 0)) > 0.01:
                        await coll.update_one(
                            {"_id": p["_id"]},
                            {"$set": {"discount_percentage": wmp}}
                        )
                        synced += 1
                logger.info(f"Synced {synced} discount_percentages in {coll_name}")
            await db.migrations.insert_one({"name": "sync_discount_percentage_v1", "synced_at": datetime.utcnow()})
            logger.info("discount_percentage sync migration complete")
        else:
            logger.info("discount_percentage sync migration already applied")
    except Exception as e:
        logger.error(f"Failed to sync discount_percentage: {e}")

    # Fix product_group routing: sync product_group from supplier_products to tiles
    # Products published with default "tiles" group should inherit their actual product_group
    try:
        migration_flag = await db.migrations.find_one({"name": "fix_product_group_routing_v1"})
        if not migration_flag:
            fixed = 0
            # Find all tiles that have product_group = "tiles" but their supplier_products counterpart has a different group
            tiles_cursor = db.tiles.find(
                {"product_group": "tiles"},
                {"_id": 1, "sku": 1}
            )
            async for tile in tiles_cursor:
                sku = tile.get("sku")
                if not sku:
                    continue
                sp = await db.supplier_products.find_one(
                    {"sku": sku},
                    {"product_group": 1, "main_category": 1}
                )
                if sp:
                    sp_group = sp.get("product_group")
                    if sp_group and sp_group != "tiles":
                        await db.tiles.update_one(
                            {"_id": tile["_id"]},
                            {"$set": {"product_group": sp_group}}
                        )
                        fixed += 1
                    elif not sp_group and sp.get("main_category"):
                        # Derive product_group from main_category
                        main_cat = sp["main_category"]
                        pg_slug = main_cat.lower().strip().replace(' ', '-').replace('&', 'and')
                        pg_slug = ''.join(c if c.isalnum() or c == '-' else '' for c in pg_slug)
                        if pg_slug and pg_slug != "tiles":
                            await db.tiles.update_one(
                                {"_id": tile["_id"]},
                                {"$set": {"product_group": pg_slug}}
                            )
                            await db.supplier_products.update_one(
                                {"sku": sku},
                                {"$set": {"product_group": pg_slug}}
                            )
                            fixed += 1
            await db.migrations.insert_one({"name": "fix_product_group_routing_v1", "fixed": fixed, "ran_at": datetime.utcnow()})
            logger.info(f"Product group routing migration complete: {fixed} products fixed")
        else:
            logger.info("Product group routing migration already applied")
    except Exception as e:
        logger.error(f"Failed to fix product group routing: {e}")

    # Comprehensive sync: tier_pricing_disabled + product_group from supplier_products → tiles
    # This fixes the collection card pricing issue where cleaning products show tier-discounted prices
    try:
        migration_flag = await db.migrations.find_one({"name": "comprehensive_tile_sync_v1"})
        if not migration_flag:
            synced_tier = 0
            synced_group = 0
            
            # Non-tile product indicators (cleaning, adhesive, grout, sealer, etc.)
            non_tile_keywords = [
                'clean', 'grout', 'sealer', 'adhesive', 'primer', 'protector',
                'remover', 'stripper', 'polish', 'wax', 'sealant', 'silicone',
                'caulk', 'spacer', 'trowel', 'cutter', 'nipper', 'level',
                'screed', 'membrane', 'matting', 'underlay', 'insulation',
                'easy clean', 'proclean', 'xtreme', 'tile guard', 'grout aid',
                'haze remover', 'tile cleaner', 'epoxy', 'levelling',
                'bottle', 'litre', '1l', '5l', '10l', '1ltr', '5ltr',
            ]
            
            # Get all tiles
            tiles_cursor = db.tiles.find(
                {},
                {"_id": 1, "sku": 1, "name": 1, "tier_pricing_disabled": 1, "product_group": 1, "is_surface_product": 1}
            )
            async for tile in tiles_cursor:
                sku = tile.get("sku")
                if not sku:
                    continue
                
                updates = {}
                
                # Look up supplier_products for the real tier_pricing_disabled value
                sp = await db.supplier_products.find_one(
                    {"sku": sku},
                    {"tier_pricing_disabled": 1, "has_custom_tier_pricing": 1,
                     "product_group": 1, "main_category": 1, "tier_discounts": 1,
                     "tier_thresholds": 1, "trade_discount": 1, "credit_back_rate": 1}
                )
                
                if sp:
                    # Sync tier_pricing_disabled
                    sp_tier_disabled = sp.get("tier_pricing_disabled", False)
                    tile_tier_disabled = tile.get("tier_pricing_disabled", False)
                    if sp_tier_disabled and not tile_tier_disabled:
                        updates["tier_pricing_disabled"] = True
                        synced_tier += 1
                    
                    # Sync has_custom_tier_pricing flag only (NOT tier_discounts/thresholds - those affect pricing)
                    if sp.get("has_custom_tier_pricing"):
                        updates["has_custom_tier_pricing"] = True
                    
                    # Sync product_group
                    sp_group = sp.get("product_group")
                    if sp_group and sp_group != tile.get("product_group"):
                        updates["product_group"] = sp_group
                        synced_group += 1
                
                # Auto-detect non-tile products and set product_group to "materials"
                current_group = updates.get("product_group") or tile.get("product_group") or "tiles"
                if current_group == "tiles":
                    tile_name = (tile.get("name") or "").lower()
                    is_surface = tile.get("is_surface_product")
                    
                    # Check if product name contains non-tile keywords
                    if is_surface == False or any(kw in tile_name for kw in non_tile_keywords):
                        updates["product_group"] = "materials"
                        # Also set tier_pricing_disabled if not already set
                        if not updates.get("tier_pricing_disabled") and not tile.get("tier_pricing_disabled"):
                            updates["tier_pricing_disabled"] = True
                        synced_group += 1
                        # Also sync to supplier_products
                        await db.supplier_products.update_one(
                            {"sku": sku},
                            {"$set": {"product_group": "materials"}}
                        )
                
                if updates:
                    updates["updated_at"] = datetime.utcnow()
                    await db.tiles.update_one({"_id": tile["_id"]}, {"$set": updates})
            
            await db.migrations.insert_one({
                "name": "comprehensive_tile_sync_v1",
                "synced_tier": synced_tier,
                "synced_group": synced_group,
                "ran_at": datetime.utcnow()
            })
            logger.info(f"Comprehensive tile sync: {synced_tier} tier flags, {synced_group} product groups fixed")
        else:
            logger.info("Comprehensive tile sync migration already applied")
    except Exception as e:
        logger.error(f"Failed comprehensive tile sync: {e}")

    # Tier discounts are intentionally NOT reverted - they reflect actual configured values

    # --- Migration: Fix corrupted finish values and recalculate WAS prices ---
    try:
        migration_flag = await db.migrations.find_one({"name": "fix_finish_and_wasprice_v1"})
        if not migration_flag:
            import math
            logger.info("Running finish + WAS price fix migration...")
            
            fixed_finish = 0
            fixed_wasprice = 0
            
            for coll in [db.supplier_products, db.tiles, db.sync_staging, db.products]:
                # Fix 1: Products with "20mm outdoor" in name → finish = "20MM Outdoor"
                result = await coll.update_many(
                    {
                        "$or": [
                            {"product_name": {"$regex": "20mm.*outdoor", "$options": "i"}},
                            {"name": {"$regex": "20mm.*outdoor", "$options": "i"}}
                        ],
                        "finish": {"$ne": "20MM Outdoor"}
                    },
                    {"$set": {"finish": "20MM Outdoor"}}
                )
                fixed_finish += result.modified_count
                
                # Fix 2: Products with "Decor" in name → finish = "Matt Decor"
                result = await coll.update_many(
                    {
                        "$or": [
                            {"product_name": {"$regex": "\\bDecor\\b", "$options": "i"}},
                            {"name": {"$regex": "\\bDecor\\b", "$options": "i"}}
                        ],
                        "finish": {"$ne": "Matt Decor"}
                    },
                    {"$set": {"finish": "Matt Decor"}}
                )
                fixed_finish += result.modified_count
                
                # Fix 3: Recalculate WAS prices using correct discount formula
                # was = now / (1 - markup/100) so 25% markup = 25% discount shown
                cursor = coll.find({
                    "sale_active": True,
                    "was_markup_percent": {"$exists": True, "$gt": 0}
                })
                async for doc in cursor:
                    list_price = doc.get("price") or doc.get("list_price", 0)
                    markup_pct = doc.get("was_markup_percent", 0)
                    if list_price and markup_pct and markup_pct < 100:
                        new_was = math.ceil(list_price / (1 - markup_pct / 100)) - 0.01
                        new_savings = round(new_was - list_price, 2)
                        await coll.update_one(
                            {"_id": doc["_id"]},
                            {"$set": {
                                "was_price": new_was,
                                "discount_percentage": markup_pct,
                                "sale_savings": new_savings
                            }}
                        )
                        fixed_wasprice += 1
            
            await db.migrations.insert_one({
                "name": "fix_finish_and_wasprice_v1",
                "applied_at": datetime.now(timezone.utc).isoformat()
            })
            logger.info(f"Fix migration: {fixed_finish} finish corrections, {fixed_wasprice} WAS price recalculations")
        else:
            logger.info("Finish + WAS price fix migration already applied")
    except Exception as e:
        logger.error(f"Failed finish/WAS price migration: {e}")

    # Fix null SKU: Copy supplier_code → sku for products where sku is null but supplier_code exists
    # This is the ROOT FIX for RSA Tiles and other suppliers whose products only have supplier_code
    try:
        migration_flag = await db.migrations.find_one({"name": "populate_null_sku_from_supplier_code_v1"})
        if not migration_flag:
            fixed_count = 0
            for coll_name in ["supplier_products", "tiles", "products"]:
                coll = db[coll_name]
                # Find products with null/missing sku but valid supplier_code
                null_sku_products = await coll.find(
                    {"$and": [
                        {"$or": [{"sku": None}, {"sku": ""}, {"sku": {"$exists": False}}]},
                        {"supplier_code": {"$exists": True, "$nin": [None, ""]}}
                    ]},
                    {"_id": 1, "supplier_code": 1}
                ).to_list(10000)
                
                for p in null_sku_products:
                    sc = p.get("supplier_code")
                    if sc:
                        await coll.update_one(
                            {"_id": p["_id"]},
                            {"$set": {"sku": sc}}
                        )
                        fixed_count += 1
                
                if null_sku_products:
                    logger.info(f"Populated {len(null_sku_products)} null SKUs from supplier_code in {coll_name}")
            
            await db.migrations.insert_one({
                "name": "populate_null_sku_from_supplier_code_v1",
                "fixed_count": fixed_count,
                "applied_at": datetime.now(timezone.utc).isoformat()
            })
            logger.info(f"Null SKU migration complete: {fixed_count} products fixed across all collections")
        else:
            logger.info("Null SKU migration already applied")
    except Exception as e:
        logger.error(f"Failed null SKU migration: {e}")

    # Sync series/original_series from supplier_products to tiles
    try:
        migration_flag = await db.migrations.find_one({"name": "sync_series_to_tiles_v2"})
        if not migration_flag:
            tiles_missing_series = await db.tiles.find(
                {"$or": [{"series": None}, {"series": {"$exists": False}}, {"series": ""}]},
                {"_id": 1, "sku": 1, "supplier_code": 1, "name": 1, "collection": 1}
            ).to_list(10000)
            
            synced = 0
            for tile in tiles_missing_series:
                update = {}
                
                # Strategy 1: Match by SKU
                sku = tile.get("sku") or tile.get("supplier_code")
                if sku:
                    sp = await db.supplier_products.find_one(
                        {"sku": sku},
                        {"series": 1, "original_series": 1, "_id": 0}
                    )
                    if sp:
                        if sp.get("series"):
                            update["series"] = sp["series"]
                        if sp.get("original_series"):
                            update["original_series"] = sp["original_series"]
                
                # Strategy 2: Match by exact name
                if not update and tile.get("name"):
                    sp = await db.supplier_products.find_one(
                        {"$or": [
                            {"name": tile["name"]},
                            {"product_name": tile["name"]}
                        ]},
                        {"series": 1, "original_series": 1, "_id": 0}
                    )
                    if sp:
                        if sp.get("series"):
                            update["series"] = sp["series"]
                        if sp.get("original_series"):
                            update["original_series"] = sp["original_series"]
                
                # Strategy 3: Use the existing "collection" field as series
                if not update and tile.get("collection"):
                    update["series"] = tile["collection"]
                    update["original_series"] = tile["collection"]
                
                if update:
                    await db.tiles.update_one({"_id": tile["_id"]}, {"$set": update})
                    synced += 1
            
            await db.migrations.insert_one({
                "name": "sync_series_to_tiles_v2",
                "synced": synced,
                "applied_at": datetime.now(timezone.utc).isoformat()
            })
            logger.info(f"Series sync migration v2: synced {synced} tiles with series data")
        else:
            logger.info("Series sync migration v2 already applied")
    except Exception as e:
        logger.error(f"Failed series sync migration v2: {e}")



    # Auto-cleanup: Remove misspelled "Modis Callacata" tiles from storefront
    # These are duplicates of "Modis Calacatta" caused by a spelling error in product names
    try:
        callacata_count = await db.tiles.count_documents({
            "$or": [
                {"display_name": {"$regex": "Callacata", "$options": "i"}},
                {"name": {"$regex": "Callacata", "$options": "i"}}
            ]
        })
        if callacata_count > 0:
            result = await db.tiles.delete_many({
                "$or": [
                    {"display_name": {"$regex": "Callacata", "$options": "i"}},
                    {"name": {"$regex": "Callacata", "$options": "i"}}
                ]
            })
            logger.info(f"Auto-cleanup: Removed {result.deleted_count} misspelled 'Callacata' tiles from storefront")
    except Exception as e:
        logger.error(f"Failed Callacata cleanup: {e}")






async def create_database_indexes():
    """Create indexes to prevent MongoDB query targeting alerts"""
    from pymongo import MongoClient, ASCENDING, DESCENDING
    
    sync_client = MongoClient(os.environ.get('MONGO_URL'))
    db = sync_client[os.environ.get('DB_NAME', 'epos_db')]
    
    def safe_index(coll, keys):
        try:
            coll.create_index(keys, background=True)
        except Exception:
            pass
    
    # Critical indexes for sync operations
    safe_index(db.sync_staging, [("supplier", ASCENDING)])
    safe_index(db.sync_staging, [("supplier", ASCENDING), ("sku", ASCENDING)])
    safe_index(db.sync_staging, [("supplier", ASCENDING), ("status", ASCENDING)])
    safe_index(db.sync_staging, [("synced_at", DESCENDING)])
    
    safe_index(db.supplier_products, [("supplier", ASCENDING)])
    safe_index(db.supplier_products, [("supplier", ASCENDING), ("sku", ASCENDING)])
    safe_index(db.supplier_products, [("supplier", ASCENDING), ("name", ASCENDING)])
    
    safe_index(db.sync_jobs, [("supplier", ASCENDING), ("status", ASCENDING)])
    safe_index(db.scrape_progress, [("supplier", ASCENDING), ("status", ASCENDING)])
    safe_index(db.sync_logs, [("timestamp", DESCENDING)])
    safe_index(db.products, [("sku", ASCENDING)])
    
    # Fix missing synced_at field in sync_staging (copy from last_synced)
    try:
        from datetime import datetime, timezone
        db.sync_staging.update_many(
            {"synced_at": {"$exists": False}, "last_synced": {"$exists": True}},
            [{"$set": {"synced_at": "$last_synced"}}]
        )
        # Fix missing stock fields for scraped products
        db.sync_staging.update_many(
            {"supplier": {"$in": ["Wallcano", "Ceramica Impex"]}, "stock_m2": {"$exists": False}},
            {"$set": {"stock_sqm": 100, "stock_m2": 100, "stock_quantity": 100, "stock_status": "In Stock", "in_stock": True}}
        )
        
        # Fix invoices converted from cash quotations that have VAT but shouldn't
        # These have notes containing "Cash Quotation" but vat > 0
        import re
        cash_quotation_invoices = list(db.invoices.find({
            "notes": {"$regex": "cash quotation", "$options": "i"},
            "apply_vat": {"$ne": False},
            "vat": {"$gt": 0}
        }))
        
        for inv in cash_quotation_invoices:
            # Recalculate with 0 VAT
            subtotal = inv.get("subtotal", 0)
            gross_total = subtotal  # No VAT
            total_deposits = sum(d.get("amount", 0) for d in inv.get("deposits", []))
            amount_outstanding = max(0, gross_total - total_deposits)
            
            db.invoices.update_one(
                {"id": inv["id"]},
                {"$set": {
                    "apply_vat": False,
                    "vat": 0,
                    "gross_total": gross_total,
                    "amount_outstanding": amount_outstanding
                }}
            )
            logger.info(f"Fixed cash quotation invoice {inv.get('invoice_no')} - removed VAT")
    except Exception:
        pass
    
    sync_client.close()


async def safe_cleanup_on_startup():
    """Run cleanup in background after a short delay"""
    try:
        await asyncio.sleep(5)  # Wait for server to be ready
        await cleanup_nonexnone_on_startup()
    except Exception as e:
        logger.error(f"Background cleanup failed: {e}")


async def cleanup_nonexnone_on_startup():
    """
    COMPREHENSIVE cleanup of ALL 'None' patterns from product names on server startup.
    Cleans both supplier_products AND products collections.
    """
    import re
    
    try:
        # Use sync client for startup cleanup
        from pymongo import MongoClient
        sync_client = MongoClient(os.environ.get('MONGO_URL'))
        db = sync_client[os.environ.get('DB_NAME', 'epos_db')]
        
        # Comprehensive patterns to remove
        patterns_to_remove = [
            r'\s*NonexNone\s*',         # NonexNone
            r'\s*NoneXNone\s*',         # NoneXNone  
            r'\s*NoneXNone$',           # NoneXNone at end
            r'\s*NonexNone$',           # NonexNone at end
            r'\s*Nonex\s*None\s*',      # Nonex None
            r'\s+xNone\b',              # xNone
            r'\bxNone\s*',              # xNone at start of word
            r'\s+Nonex$',               # Nonex at end
            r'\s*\bNone\s*x\s*None\b\s*',  # None x None
            r'\s*\(None\)\s*',          # (None)
            r'\s*\[None\]\s*',          # [None]
            r'\s*\(None[Kk]g\)\s*',     # (NoneKg)
            r'\s*\(\d*None\)\s*',       # (20None) etc
            r'\s*\(None\d*[Kk]?g?\)\s*', # (None20Kg)
            r'\s*\bNone\s*[Kk]g\b',     # None Kg
            r'\s+None\s*$',             # None at end
            r'\s*\(None\s*[xX]\s*None\)', # (None x None)
            r'\s*\(\s*None\s*\)',       # ( None )
            r'\s*None\s*x\s*None\s*',   # None x None anywhere
        ]
        
        collections_to_clean = ['supplier_products', 'products']
        total_cleaned = 0
        
        for collection_name in collections_to_clean:
            collection = db[collection_name]
            
            # Find products with any None patterns in name fields
            products = list(collection.find({
                "$or": [
                    {"name": {"$regex": "None", "$options": "i"}},
                    {"product_name": {"$regex": "None", "$options": "i"}}
                ]
            }))
            
            for product in products:
                original_name = product.get("name", "") or ""
                original_product_name = product.get("product_name", "") or ""
                
                new_name = original_name
                new_product_name = original_product_name
                
                # Apply all cleanup patterns
                for pattern in patterns_to_remove:
                    if new_name:
                        new_name = re.sub(pattern, ' ', new_name, flags=re.IGNORECASE)
                    if new_product_name:
                        new_product_name = re.sub(pattern, ' ', new_product_name, flags=re.IGNORECASE)
                
                # Clean up multiple spaces and trim
                if new_name:
                    new_name = re.sub(r'\s+', ' ', new_name).strip()
                if new_product_name:
                    new_product_name = re.sub(r'\s+', ' ', new_product_name).strip()
                
                # Update if changed
                if new_name != original_name or new_product_name != original_product_name:
                    update_fields = {}
                    if new_name != original_name:
                        update_fields["name"] = new_name
                    if new_product_name != original_product_name:
                        update_fields["product_name"] = new_product_name
                    
                    collection.update_one(
                        {"_id": product["_id"]},
                        {"$set": update_fields}
                    )
                    total_cleaned += 1
        
        if total_cleaned > 0:
            logger.info(f"Startup cleanup: Removed 'None' patterns from {total_cleaned} product names")
        
        sync_client.close()
        
    except Exception as e:
        logger.error(f"NonexNone cleanup error: {e}")

@app.on_event("shutdown")
async def shutdown_db_client():
    """Shutdown scheduler and database connection"""
    try:
        from services.scheduler import shutdown_scheduler
        await shutdown_scheduler()
    except Exception as e:
        logger.error(f"Failed to shutdown scheduler: {e}")
    client.close()


# ============================================================================
# FIX CORRUPTED DIMENSION NAMES (e.g., 30x6cm0cm -> 30x60cm)
# ============================================================================
@app.post("/api/admin/fix-dimension-names")
async def fix_dimension_names(current_user: dict = Depends(get_current_user)):
    """
    Fix corrupted dimension names in product_name field.
    Example: "30x6cm0cm" -> "30x60cm"
    """
    import re
    
    user_role = current_user.get("role", "").lower()
    if user_role != "super_admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    
    try:
        # Pattern to find corrupted dimensions like "30x6cm0cm" or "60x12cm0cm"
        # This captures: digits + x + digit(s) + cm + remaining digits + cm
        corrupt_pattern = re.compile(r'(\d+)[xX](\d+)cm(\d+)cm')
        
        fixed_count = 0
        fixed_products = []
        
        # Check both products and supplier_products collections
        for collection_name in ['products', 'supplier_products']:
            collection = db[collection_name]
            
            # Find products with corrupted names
            cursor = collection.find({
                "$or": [
                    {"product_name": {"$regex": r"\d+[xX]\d+cm\d+cm"}},
                    {"display_name": {"$regex": r"\d+[xX]\d+cm\d+cm"}},
                    {"name": {"$regex": r"\d+[xX]\d+cm\d+cm"}}
                ]
            })
            
            async for product in cursor:
                updates = {}
                
                for field in ['product_name', 'display_name', 'name']:
                    if field in product and product[field]:
                        original = product[field]
                        # Fix the corrupted pattern: 30x6cm0cm -> 30x60cm
                        fixed = corrupt_pattern.sub(r'\1x\2\3cm', original)
                        if fixed != original:
                            updates[field] = fixed
                
                if updates:
                    await collection.update_one(
                        {"_id": product["_id"]},
                        {"$set": updates}
                    )
                    fixed_count += 1
                    fixed_products.append({
                        "collection": collection_name,
                        "sku": product.get("sku", "N/A"),
                        "changes": updates
                    })
        
        return {
            "success": True,
            "fixed_count": fixed_count,
            "fixed_products": fixed_products[:50]  # Return first 50 examples
        }
        
    except Exception as e:
        logger.error(f"Error fixing dimension names: {e}")
        raise HTTPException(status_code=500, detail=str(e))




# ============================================================================
# SYNC NAMES BETWEEN COLLECTIONS
# ============================================================================
@app.post("/api/admin/sync-product-names")
async def sync_product_names(current_user: dict = Depends(get_current_user)):
    """
    Sync product names from supplier_products to products collection.
    Syncs both display name (product_name) and supplier_product_name.
    """
    user_role = current_user.get("role", "").lower()
    if user_role != "super_admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    
    try:
        synced_count = 0
        synced_products = []
        
        # Get all supplier_products
        cursor = db.supplier_products.find({})
        
        async for sp in cursor:
            sku = sp.get("sku")
            if not sku:
                continue
            
            sp_product_name = sp.get("product_name") or sp.get("display_name")
            sp_supplier_product_name = sp.get("supplier_product_name")
            
            # Find matching product in products collection
            product = await db.products.find_one({"sku": sku})
            
            if product:
                updates = {}
                changes = {}
                
                # Sync display name (product_name -> name)
                if sp_product_name:
                    current_name = product.get("name", "")
                    if current_name != sp_product_name:
                        updates["name"] = sp_product_name
                        updates["display_name"] = sp_product_name
                        changes["name"] = {"old": current_name, "new": sp_product_name}
                
                # Sync supplier_product_name
                if sp_supplier_product_name:
                    current_spn = product.get("supplier_product_name", "")
                    if current_spn != sp_supplier_product_name:
                        updates["supplier_product_name"] = sp_supplier_product_name
                        changes["supplier_product_name"] = {"old": current_spn, "new": sp_supplier_product_name}
                
                if updates:
                    updates["updated_at"] = datetime.now(timezone.utc)
                    await db.products.update_one(
                        {"sku": sku},
                        {"$set": updates}
                    )
                    synced_count += 1
                    synced_products.append({
                        "sku": sku,
                        "changes": changes
                    })
        
        return {
            "success": True,
            "synced_count": synced_count,
            "synced_products": synced_products[:100]
        }
        
    except Exception as e:
        logger.error(f"Error syncing product names: {e}")
        raise HTTPException(status_code=500, detail=str(e))



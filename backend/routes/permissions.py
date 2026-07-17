"""
Role-based permissions management.

Super Admin always has full access.
Other roles (system: admin/manager/staff, plus custom roles) have explicit page + action permissions stored in the `roles` collection.
"""
from datetime import datetime, timezone
from typing import List, Optional, Dict
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, Field

from config import get_db
from services import get_current_user

router = APIRouter(prefix="/permissions", tags=["Permissions"])


# ---------------------------------------------------------------------------
# Permission registry — single source of truth for what can be controlled.
# ---------------------------------------------------------------------------

PAGE_REGISTRY: List[Dict] = [
    # Sales & EPOS
    {"key": "dashboard", "label": "Dashboard", "group": "Main"},
    {"key": "epos", "label": "EPOS", "group": "Sales & EPOS"},
    {"key": "cash_counter", "label": "Cash Counter", "group": "Sales & EPOS"},
    {"key": "showroom_dashboard", "label": "Store Dashboard", "group": "Sales & EPOS"},
    {"key": "sales_hub", "label": "Sales Hub", "group": "Sales & EPOS"},
    {"key": "invoice", "label": "Invoice (Create)", "group": "Sales & EPOS"},
    {"key": "invoice_history", "label": "Invoice History", "group": "Sales & EPOS"},
    {"key": "quotation", "label": "Quotation (Create)", "group": "Sales & EPOS"},
    {"key": "quotation_history", "label": "Quotation History", "group": "Sales & EPOS"},
    {"key": "cash_quotation", "label": "Cash Quotation", "group": "Sales & EPOS"},
    {"key": "cash_quotation_history", "label": "Cash Quotation History", "group": "Sales & EPOS"},
    {"key": "refund", "label": "Refund", "group": "Sales & EPOS"},
    {"key": "refund_history", "label": "Refund History", "group": "Sales & EPOS"},
    {"key": "credit_note", "label": "Credit Note", "group": "Sales & EPOS"},
    {"key": "credit_note_history", "label": "Credit Note History", "group": "Sales & EPOS"},
    {"key": "orders", "label": "Orders", "group": "Sales & EPOS"},
    {"key": "order_management", "label": "Order Management", "group": "Sales & EPOS"},
    {"key": "delivery_management", "label": "Delivery Management", "group": "Sales & EPOS"},
    {"key": "online_orders", "label": "Online Orders", "group": "Sales & EPOS"},

    # Products & Suppliers
    {"key": "products_hub", "label": "Products Hub", "group": "Products & Suppliers"},
    {"key": "supplier_products", "label": "Supplier Products", "group": "Products & Suppliers"},
    {"key": "supplier_health", "label": "Supplier Health", "group": "Products & Suppliers"},
    {"key": "sync_hub", "label": "Sync Hub", "group": "Products & Suppliers"},
    {"key": "suppliers", "label": "Supplier Contacts", "group": "Products & Suppliers"},
    {"key": "supplier_sync", "label": "Supplier Sync Dashboard", "group": "Products & Suppliers"},
    {"key": "categories", "label": "Categories", "group": "Products & Suppliers"},
    {"key": "manage_categories", "label": "Product Categories", "group": "Products & Suppliers"},
    {"key": "scraping_portal", "label": "Scraping Portal", "group": "Products & Suppliers"},
    {"key": "image_scraper", "label": "Image Scraper", "group": "Products & Suppliers"},
    {"key": "image_migration", "label": "Image Migration", "group": "Products & Suppliers"},
    {"key": "product_documents", "label": "Product Documents", "group": "Products & Suppliers"},

    # Stock
    {"key": "stock_hub", "label": "Stock Hub", "group": "Stock"},
    {"key": "stock_allocation", "label": "Stock Allocation", "group": "Stock"},
    {"key": "warehouse", "label": "Tonbridge Warehouse", "group": "Stock"},
    {"key": "warehouse_manage", "label": "Warehouse — Adjust Stock", "group": "Stock"},
    {"key": "bulk_stock", "label": "Bulk Stock Edit", "group": "Stock"},
    {"key": "stock_import", "label": "Stock Import", "group": "Stock"},
    {"key": "delivery_check_in", "label": "Delivery Check-In", "group": "Stock"},
    {"key": "stock_transfers", "label": "Stock Transfers", "group": "Stock"},
    {"key": "reorder_suggestions", "label": "Reorder Suggestions", "group": "Stock"},
    {"key": "batch_tracking", "label": "Batch Tracking", "group": "Stock"},
    {"key": "to_order_report", "label": "To Order Report", "group": "Stock"},
    {"key": "stock_cost", "label": "Stock Value", "group": "Stock"},
    {"key": "stocktake_report", "label": "Stocktake Report", "group": "Stock"},
    {"key": "clearance_products", "label": "Clearance Products", "group": "Stock"},
    {"key": "new_collection_products", "label": "New Collection Products", "group": "Stock"},

    # Customers
    {"key": "customers_hub", "label": "Customers Hub", "group": "Customers"},
    {"key": "trade_accounts", "label": "Trade Accounts", "group": "Customers"},
    {"key": "customer_pricing", "label": "Customer Pricing", "group": "Customers"},
    {"key": "customer_invites", "label": "Invite Customers", "group": "Customers"},
    {"key": "bulk_inquiries", "label": "Bulk Inquiries", "group": "Customers"},
    {"key": "trade_list", "label": "Trade List (Legacy)", "group": "Customers"},
    {"key": "loyalty", "label": "Loyalty Dashboard", "group": "Customers"},
    {"key": "quote_requests", "label": "Quote Requests", "group": "Customers"},

    # Communication
    {"key": "communication_hub", "label": "Communication Hub", "group": "Communication"},
    {"key": "staff_chat", "label": "Staff Chat", "group": "Communication"},
    {"key": "tasks", "label": "Tasks & Notes", "group": "Communication"},
    {"key": "inbox", "label": "Inbox", "group": "Communication"},
    {"key": "email_composer", "label": "Send Email", "group": "Communication"},
    {"key": "marketing", "label": "Marketing", "group": "Communication"},
    {"key": "notifications", "label": "Notifications", "group": "Communication"},
    {"key": "live_chat", "label": "Live Chat (Customer)", "group": "Communication"},
    {"key": "live_visitors", "label": "Live Visitors", "group": "Communication"},
    {"key": "whatsapp", "label": "WhatsApp", "group": "Communication"},

    # Reports
    {"key": "reports_hub", "label": "Reports Hub", "group": "Reports"},
    {"key": "analytics", "label": "Analytics", "group": "Reports"},
    {"key": "reports", "label": "Sales Reports", "group": "Reports"},
    {"key": "audit_trail", "label": "Audit Trail", "group": "Reports"},
    {"key": "staff_performance", "label": "Staff Performance", "group": "Reports"},
    {"key": "website_analytics", "label": "Website Analytics", "group": "Reports"},
    {"key": "website_sales_dashboard", "label": "Website Sales Dashboard", "group": "Reports"},

    # Admin Settings
    {"key": "settings_hub", "label": "Settings Hub", "group": "Admin Settings"},
    {"key": "showrooms", "label": "Stores", "group": "Admin Settings"},
    {"key": "user_management", "label": "User Management", "group": "Admin Settings"},
    {"key": "permissions_admin", "label": "Permissions", "group": "Admin Settings"},
    {"key": "staff_pins", "label": "Staff PINs", "group": "Admin Settings"},
    {"key": "staff_invites", "label": "Staff Invites", "group": "Admin Settings"},
    {"key": "trash", "label": "Trash", "group": "Admin Settings"},
    {"key": "general_settings", "label": "General Settings", "group": "Admin Settings"},
    {"key": "security_settings", "label": "Security Settings", "group": "Admin Settings"},
    {"key": "pricing_settings", "label": "Pricing Settings", "group": "Admin Settings"},

    # Website
    {"key": "website_hub", "label": "Website Hub", "group": "Website"},
    {"key": "website_preview", "label": "Preview Website", "group": "Website"},
    {"key": "homepage_content", "label": "Homepage Content", "group": "Website"},
    {"key": "homepage_manager", "label": "Homepage Manager", "group": "Website"},
    {"key": "collections", "label": "Collections", "group": "Website"},
    {"key": "collection_manager", "label": "Collection Manager", "group": "Website"},
    {"key": "trade_account_settings", "label": "Trade Account Page", "group": "Website"},
    {"key": "customer_account_settings", "label": "Customer Account Page", "group": "Website"},
    {"key": "checkout_settings", "label": "Checkout Page", "group": "Website"},
    {"key": "navigation_menu", "label": "Navigation Menu", "group": "Website"},
    {"key": "navigation_structure", "label": "Navigation Structure", "group": "Website"},
    {"key": "website_categories", "label": "Website Categories", "group": "Website"},
    {"key": "website_filters", "label": "Filters", "group": "Website"},
    {"key": "website_products", "label": "Website Products Editor", "group": "Website"},
    {"key": "publish_products", "label": "Publish Products", "group": "Website"},
    {"key": "sample_service_content", "label": "Sample Service Content", "group": "Website"},
    {"key": "website_settings", "label": "Settings & Branding", "group": "Website"},
    {"key": "page_maintenance", "label": "Page Maintenance", "group": "Website"},
    {"key": "welcome_popup", "label": "Welcome Popup", "group": "Website"},
    {"key": "tile_calculator_settings", "label": "Tile Calculator Settings", "group": "Website"},
    {"key": "bathroom_page", "label": "Bathroom Page", "group": "Website"},
    {"key": "sitemap", "label": "Sitemap", "group": "Website"},
]

ACTION_REGISTRY: List[Dict] = [
    # Supplier Products page — granular control (matches the recently added super-admin gates)
    {"key": "supplier_products.cost_column", "label": "View Cost column", "page": "supplier_products"},
    {"key": "supplier_products.live_column", "label": "View Live column", "page": "supplier_products"},
    {"key": "supplier_products.status_column", "label": "View Status column", "page": "supplier_products"},
    {"key": "supplier_products.checkbox_column", "label": "Bulk select checkbox column", "page": "supplier_products"},
    {"key": "supplier_products.action.visibility", "label": "Set product visibility (online / in-store / hidden)", "page": "supplier_products"},
    {"key": "supplier_products.action.always_in_stock", "label": "Toggle Always In Stock", "page": "supplier_products"},
    {"key": "supplier_products.action.add_to_db", "label": "Add product to database", "page": "supplier_products"},
    {"key": "supplier_products.action.quick_edit", "label": "Quick Edit (popup)", "page": "supplier_products"},
    {"key": "supplier_products.action.sale_labels", "label": "Manage Sale & Labels", "page": "supplier_products"},
    {"key": "supplier_products.action.full_edit", "label": "Edit product (full page)", "page": "supplier_products"},
    {"key": "supplier_products.action.pdf_documents", "label": "Manage PDF documents", "page": "supplier_products"},
    {"key": "supplier_products.action.preview", "label": "Preview on website (eye icon)", "page": "supplier_products"},
    {"key": "supplier_products.action.copy", "label": "Copy product (creates draft)", "page": "supplier_products"},
    {"key": "supplier_products.action.delete", "label": "Delete product", "page": "supplier_products"},
]


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class RolePayload(BaseModel):
    role_id: str = Field(..., min_length=1, max_length=64)
    role_name: str = Field(..., min_length=1, max_length=80)
    pages: List[str] = []
    actions: List[str] = []
    is_super_admin: bool = False


class RoleUpdate(BaseModel):
    role_name: Optional[str] = None
    pages: Optional[List[str]] = None
    actions: Optional[List[str]] = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

SYSTEM_ROLE_IDS = {"super_admin", "admin", "manager", "staff"}

# Default page+action grants for system roles (preserves current observed behaviour).
# super_admin is special and bypasses all checks regardless of this seed.
SYSTEM_ROLE_DEFAULTS: Dict[str, Dict[str, List[str]]] = {
    "super_admin": {
        "pages": [p["key"] for p in PAGE_REGISTRY],
        "actions": [a["key"] for a in ACTION_REGISTRY],
    },
    "admin": {
        "pages": [
            p["key"] for p in PAGE_REGISTRY
            if p["key"] not in {"audit_trail", "permissions_admin", "user_management", "staff_pins", "staff_invites", "trash", "stock_import", "notifications", "warehouse_manage"}
        ],
        # Admin keeps preview only by default — matches the recently-shipped restriction
        "actions": ["supplier_products.action.preview"],
    },
    "manager": {
        "pages": [
            "dashboard", "epos", "cash_counter", "showroom_dashboard", "sales_hub",
            "invoice", "invoice_history", "quotation", "quotation_history",
            "cash_quotation", "cash_quotation_history", "refund", "refund_history",
            "credit_note", "credit_note_history", "orders", "order_management",
            "delivery_management", "online_orders",
            "products_hub", "supplier_products", "stock_hub", "stock_allocation",
            "bulk_stock", "delivery_check_in", "stock_transfers", "reorder_suggestions",
            "batch_tracking", "to_order_report", "warehouse",
            "customers_hub", "trade_accounts", "customer_pricing", "bulk_inquiries",
            "communication_hub", "staff_chat", "tasks", "inbox",
            "reports_hub", "analytics", "reports",
        ],
        "actions": ["supplier_products.action.preview"],
    },
    "staff": {
        # 16 May 2026 — EXPANDED to cover everything showrooms currently
        # see in the legacy sidebar (Tonbridge/Gravesend/Chingford/Sydenham
        # had grouped keys `dashboard, epos, products, orders, customers,
        # customer_pricing` — these expanded to many sub-pages). The
        # granular keys below preserve that exact surface so no showroom
        # user loses anything when the sidebar switches to role-based
        # gating. Super-admin-only items (audit, user_management, etc.)
        # are intentionally excluded.
        "pages": [
            # Main
            "dashboard",
            # Sales & EPOS
            "epos", "cash_counter", "showroom_dashboard", "sales_hub",
            "invoice", "invoice_history",
            "quotation", "quotation_history",
            "cash_quotation", "cash_quotation_history",
            "refund", "refund_history",
            "credit_note", "credit_note_history",
            "orders", "order_management", "delivery_management", "online_orders",
            # Products & Suppliers
            "products_hub", "supplier_products", "supplier_health", "sync_hub",
            "suppliers", "supplier_sync",
            # Stock
            "stock_hub", "stock_allocation", "bulk_stock",
            "delivery_check_in", "stock_transfers", "reorder_suggestions",
            "batch_tracking", "to_order_report", "stock_cost", "stocktake_report",
            "warehouse",
            # Customers
            "customers_hub", "trade_accounts", "customer_pricing",
            "customer_invites", "bulk_inquiries", "trade_list",
            # Communication
            "communication_hub", "staff_chat", "tasks", "inbox", "email_composer",
            # Reports (basic — analytics/audit are admin+)
            "reports_hub", "analytics", "reports",
            # Settings (basic — full settings_hub is admin+)
            "general_settings",
        ],
        "actions": ["supplier_products.action.preview"],
    },
}

# Custom roles that ship pre-configured for convenience but can be
# freely edited or deleted by the super-admin. Seeded ONCE on first
# backend boot (marker doc in `system_state`). If admin deletes them
# they stay deleted — no zombie re-seeding on restart.
DEFAULT_CUSTOM_ROLES = {
    "showroom_lead": {
        "role_name": "Showroom Lead",
        # Staff baseline + senior responsibilities: reporting,
        # transfer authority, reorder decisions. Excludes anything
        # commercial-sensitive (pricing changes, user mgmt, marketing).
        "pages": [
            # Everything Staff sees…
            "dashboard",
            "epos", "cash_counter", "showroom_dashboard", "sales_hub",
            "invoice", "invoice_history",
            "quotation", "quotation_history",
            "cash_quotation", "cash_quotation_history",
            "refund", "refund_history",
            "credit_note", "credit_note_history",
            "orders", "order_management", "delivery_management", "online_orders",
            "products_hub", "supplier_products", "supplier_health", "sync_hub",
            "suppliers", "supplier_sync",
            "stock_hub", "stock_allocation", "bulk_stock",
            "delivery_check_in", "batch_tracking",
            "warehouse",
            "customers_hub", "trade_accounts",
            "customer_invites", "bulk_inquiries", "trade_list",
            "communication_hub", "staff_chat", "tasks", "inbox", "email_composer",
            "reports_hub",
            "general_settings",
            # …PLUS the senior extras: stock transfers between showrooms,
            # reorder visibility, and the three big inventory reports.
            "stock_transfers", "reorder_suggestions",
            "to_order_report", "stock_cost", "stocktake_report",
            "analytics", "reports",
        ],
        "actions": [],
    },
}


def _serialize_role(doc: dict) -> dict:
    return {
        "role_id": doc.get("role_id"),
        "role_name": doc.get("role_name"),
        "is_system": doc.get("is_system", False),
        "is_super_admin": doc.get("is_super_admin", False),
        # `user_modified` is True once a super-admin has saved the role
        # via PUT /roles/{id} — prevents the additive backfill from
        # silently re-adding pages they removed. Exposed here so the
        # admin UI can render an "Edited" indicator.
        "user_modified": bool(doc.get("user_modified", False)),
        "pages": doc.get("pages", []),
        "actions": doc.get("actions", []),
        "created_at": (doc.get("created_at").isoformat() if isinstance(doc.get("created_at"), datetime) else doc.get("created_at")),
        "updated_at": (doc.get("updated_at").isoformat() if isinstance(doc.get("updated_at"), datetime) else doc.get("updated_at")),
    }


async def _ensure_default_custom_roles(db) -> None:
    """Seed DEFAULT_CUSTOM_ROLES exactly once per database.

    Uses a marker doc in `system_state` to track which custom roles
    have already been offered. If the admin deletes the role, it stays
    deleted — no zombie re-seeding on backend restart.
    """
    now = datetime.now(timezone.utc)
    for role_id, spec in DEFAULT_CUSTOM_ROLES.items():
        marker_id = f"custom_role_seeded:{role_id}"
        marker = await db.system_state.find_one({"_id": marker_id})
        if marker:
            continue  # already seeded once, never again
        # Only seed if the role isn't already present (covers manual
        # creation by admin before this code ran).
        existing = await db.roles.find_one({"role_id": role_id})
        if not existing:
            await db.roles.insert_one({
                "role_id": role_id,
                "role_name": spec["role_name"],
                "is_system": False,         # admin can rename + delete
                "is_super_admin": False,
                "pages": list(spec["pages"]),
                "actions": list(spec["actions"]),
                "created_at": now,
                "updated_at": now,
            })
        await db.system_state.update_one(
            {"_id": marker_id},
            {"$set": {"seeded_at": now, "role_id": role_id}},
            upsert=True,
        )


async def _ensure_system_roles(db) -> None:
    """Seed system roles on first read, and additively backfill any new
    default pages/actions on subsequent reads.

    The first pass inserts the row if missing. On every subsequent call
    we *add* any default pages/actions that are present in the code
    constants but missing from the stored doc — without ever removing
    pages a super-admin has explicitly toggled on. This means when we
    extend `SYSTEM_ROLE_DEFAULTS` (e.g. May 16 2026 staff expansion),
    existing production rows pick up the new grants automatically.

    Super Admin defaults are always re-synced to match the current
    PAGE/ACTION_REGISTRY so a fresh page/action ships with super-admin
    access immediately.
    """
    now = datetime.now(timezone.utc)
    for role_id in SYSTEM_ROLE_IDS:
        defaults = SYSTEM_ROLE_DEFAULTS.get(role_id, {"pages": [], "actions": []})
        existing = await db.roles.find_one({"role_id": role_id})

        if not existing:
            await db.roles.insert_one({
                "role_id": role_id,
                "role_name": role_id.replace("_", " ").title(),
                "is_system": True,
                "is_super_admin": role_id == "super_admin",
                "pages": list(defaults["pages"]),
                "actions": list(defaults["actions"]),
                "created_at": now,
                "updated_at": now,
            })
            continue

        # Super Admin: always full access — re-sync to current registry
        # in case new pages were added since seed.
        if role_id == "super_admin":
            full_pages = [p["key"] for p in PAGE_REGISTRY]
            full_actions = [a["key"] for a in ACTION_REGISTRY]
            if set(existing.get("pages", [])) != set(full_pages) or set(existing.get("actions", [])) != set(full_actions):
                await db.roles.update_one(
                    {"role_id": role_id},
                    {"$set": {"pages": full_pages, "actions": full_actions, "updated_at": now}},
                )
            continue

        # Other system roles: additively backfill missing defaults so
        # extending the defaults list in code propagates automatically
        # — BUT only if a super-admin hasn't yet touched the role via
        # the UI. Once `user_modified=true` is stamped (set by the PUT
        # /roles/{id} handler), we treat the admin's choices as
        # authoritative and never auto-add pages back. This is the fix
        # for the "I unticked Sync Hub but it keeps coming back" bug:
        # the previous behaviour silently re-introduced any page the
        # admin removed if it still appeared in SYSTEM_ROLE_DEFAULTS.
        if existing.get("user_modified"):
            continue

        current_pages = set(existing.get("pages", []))
        current_actions = set(existing.get("actions", []))
        missing_pages = [p for p in defaults["pages"] if p not in current_pages]
        missing_actions = [a for a in defaults["actions"] if a not in current_actions]
        if missing_pages or missing_actions:
            await db.roles.update_one(
                {"role_id": role_id},
                {
                    "$addToSet": {
                        "pages": {"$each": missing_pages} if missing_pages else {"$each": []},
                        "actions": {"$each": missing_actions} if missing_actions else {"$each": []},
                    },
                    "$set": {"updated_at": now},
                },
            )


def _require_super_admin(current_user: dict):
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super Admin access required")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/registry")
async def get_registry(current_user: dict = Depends(get_current_user)):
    """Return the catalogue of pages + actions (any logged-in admin user)."""
    return {"pages": PAGE_REGISTRY, "actions": ACTION_REGISTRY}


@router.get("/me")
async def get_my_permissions(current_user: dict = Depends(get_current_user)):
    """Return the current user's effective pages + actions.

    Effective set = role defaults
                  + user.extra_pages   (super_admin grants beyond role)
                  − user.denied_pages  (super_admin removals below role)

    Same merge applies to actions. Super Admin role short-circuits to
    full access regardless of overrides (you cannot demote a super_admin
    via an override).
    """
    db = get_db()
    await _ensure_system_roles(db)
    role_id = current_user.get("role") or "staff"

    if role_id == "super_admin":
        return {
            "role": role_id,
            "is_super_admin": True,
            "pages": [p["key"] for p in PAGE_REGISTRY],
            "actions": [a["key"] for a in ACTION_REGISTRY],
        }

    role = await db.roles.find_one({"role_id": role_id}, {"_id": 0})
    role_pages = list(role.get("pages", [])) if role else []
    role_actions = list(role.get("actions", [])) if role else []

    # Pull per-user overrides from the user doc. Missing fields default
    # to empty lists — only super_admins can edit these via the new
    # `/permissions/users/{email}/overrides` endpoint.
    user_doc = await db.users.find_one(
        {"email": current_user.get("email")},
        {"_id": 0, "extra_pages": 1, "denied_pages": 1, "extra_actions": 1, "denied_actions": 1},
    ) or {}
    extra_pages = set(user_doc.get("extra_pages") or [])
    denied_pages = set(user_doc.get("denied_pages") or [])
    extra_actions = set(user_doc.get("extra_actions") or [])
    denied_actions = set(user_doc.get("denied_actions") or [])

    effective_pages = [p for p in role_pages if p not in denied_pages]
    for p in extra_pages:
        if p not in effective_pages:
            effective_pages.append(p)

    effective_actions = [a for a in role_actions if a not in denied_actions]
    for a in extra_actions:
        if a not in effective_actions:
            effective_actions.append(a)

    return {
        "role": role_id,
        "is_super_admin": role.get("is_super_admin", False) if role else False,
        "pages": effective_pages,
        "actions": effective_actions,
        # Surface the breakdown for the admin UI to show "inherited from role"
        # vs "personal grant" without an extra round-trip.
        "_breakdown": {
            "role_pages": role_pages,
            "role_actions": role_actions,
            "extra_pages": sorted(extra_pages),
            "denied_pages": sorted(denied_pages),
            "extra_actions": sorted(extra_actions),
            "denied_actions": sorted(denied_actions),
        },
    }


@router.get("/roles")
async def list_roles(current_user: dict = Depends(get_current_user)):
    _require_super_admin(current_user)
    db = get_db()
    await _ensure_system_roles(db)
    await _ensure_default_custom_roles(db)
    roles = await db.roles.find({}, {"_id": 0}).sort("role_id", 1).to_list(1000)
    return [_serialize_role(r) for r in roles]


@router.post("/roles")
async def create_role(payload: RolePayload, current_user: dict = Depends(get_current_user)):
    _require_super_admin(current_user)
    db = get_db()
    await _ensure_system_roles(db)

    role_id = payload.role_id.strip().lower().replace(" ", "_")
    if not role_id:
        raise HTTPException(status_code=400, detail="role_id is required")
    if await db.roles.find_one({"role_id": role_id}):
        raise HTTPException(status_code=409, detail=f"Role '{role_id}' already exists")

    valid_pages = {p["key"] for p in PAGE_REGISTRY}
    valid_actions = {a["key"] for a in ACTION_REGISTRY}

    now = datetime.now(timezone.utc)
    doc = {
        "role_id": role_id,
        "role_name": payload.role_name.strip(),
        "is_system": False,
        "is_super_admin": False,
        "pages": [p for p in payload.pages if p in valid_pages],
        "actions": [a for a in payload.actions if a in valid_actions],
        "created_at": now,
        "updated_at": now,
    }
    await db.roles.insert_one(doc)
    return _serialize_role(doc)


@router.put("/roles/{role_id}")
async def update_role(role_id: str, payload: RoleUpdate, current_user: dict = Depends(get_current_user)):
    _require_super_admin(current_user)
    db = get_db()
    await _ensure_system_roles(db)

    existing = await db.roles.find_one({"role_id": role_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Role not found")
    if existing.get("is_super_admin"):
        raise HTTPException(status_code=400, detail="Super Admin role cannot be edited")

    valid_pages = {p["key"] for p in PAGE_REGISTRY}
    valid_actions = {a["key"] for a in ACTION_REGISTRY}

    update_doc = {"updated_at": datetime.now(timezone.utc)}
    # 16 May 2026 — Stamp `user_modified=true` so the additive backfill
    # in `_ensure_system_roles` knows the admin is now in charge of
    # this role's pages and never silently re-adds defaults that the
    # admin explicitly removed.
    update_doc["user_modified"] = True
    if payload.role_name is not None and not existing.get("is_system", False):
        update_doc["role_name"] = payload.role_name.strip()
    if payload.pages is not None:
        update_doc["pages"] = [p for p in payload.pages if p in valid_pages]
    if payload.actions is not None:
        update_doc["actions"] = [a for a in payload.actions if a in valid_actions]

    await db.roles.update_one({"role_id": role_id}, {"$set": update_doc})
    updated = await db.roles.find_one({"role_id": role_id}, {"_id": 0})
    return _serialize_role(updated)


@router.delete("/roles/{role_id}")
async def delete_role(role_id: str, current_user: dict = Depends(get_current_user)):
    _require_super_admin(current_user)
    db = get_db()

    existing = await db.roles.find_one({"role_id": role_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Role not found")
    if existing.get("is_system"):
        raise HTTPException(status_code=400, detail="System roles cannot be deleted")

    in_use = await db.users.count_documents({"role": role_id})
    if in_use > 0:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot delete role '{role_id}' — {in_use} user(s) currently assigned to it. Reassign them first.",
        )

    await db.roles.delete_one({"role_id": role_id})
    return {"success": True, "role_id": role_id}


# ---------------------------------------------------------------------------
# Per-user overrides (16 May 2026 — unification of permissions admin)
#
# Lets a super-admin grant extra pages/actions to ONE user beyond their
# role's defaults, or deny specific pages/actions just for that user.
# All admin/staff/manager users share the same role defaults — these
# overrides exist for one-off cases (e.g. one Sydenham staffer needing
# Stock Transfers access without bumping the whole Staff role).
# ---------------------------------------------------------------------------

class UserOverridesPayload(BaseModel):
    extra_pages: Optional[List[str]] = None
    denied_pages: Optional[List[str]] = None
    extra_actions: Optional[List[str]] = None
    denied_actions: Optional[List[str]] = None


@router.get("/users")
async def list_admin_users_with_perms(
    showroom_id: Optional[str] = None,
    role: Optional[str] = None,
    search: Optional[str] = None,
    current_user: dict = Depends(get_current_user),
):
    """List all admin/staff users with their effective permission summary.

    Filters:
      - `showroom_id`: only users assigned to this showroom
      - `role`: only users with this role_id
      - `search`: case-insensitive substring match against name OR email

    Returns minimal data (no full role page list — call /users/{email} for that)
    so the picker UI is fast even with hundreds of users.
    """
    _require_super_admin(current_user)
    db = get_db()
    await _ensure_system_roles(db)

    q: dict = {"role": {"$in": ["super_admin", "admin", "manager", "staff"]}}
    if showroom_id:
        q["showroom_id"] = showroom_id
    if role:
        q["role"] = role
    if search:
        # Case-insensitive on name/email — MongoDB $regex with `i` flag.
        rx = {"$regex": search.strip(), "$options": "i"}
        q["$or"] = [{"email": rx}, {"name": rx}]

    cursor = db.users.find(
        q,
        {
            "_id": 0, "email": 1, "name": 1, "role": 1,
            "showroom_id": 1, "showroom_name": 1,
            "extra_pages": 1, "denied_pages": 1,
            "extra_actions": 1, "denied_actions": 1,
        },
    ).sort("email", 1).limit(500)

    users = []
    async for u in cursor:
        users.append({
            "email": u.get("email"),
            "name": u.get("name"),
            "role": u.get("role"),
            "showroom_id": u.get("showroom_id"),
            "showroom_name": u.get("showroom_name"),
            "override_count": (
                len(u.get("extra_pages") or [])
                + len(u.get("denied_pages") or [])
                + len(u.get("extra_actions") or [])
                + len(u.get("denied_actions") or [])
            ),
        })
    return users


@router.get("/users/{email}")
async def get_user_permissions_detail(email: str, current_user: dict = Depends(get_current_user)):
    """Full permission breakdown for ONE user — role defaults +
    per-user overrides + effective merged set. Powers the User
    Overrides tab on /admin/permissions."""
    _require_super_admin(current_user)
    db = get_db()
    await _ensure_system_roles(db)

    user_doc = await db.users.find_one({"email": email}, {"_id": 0, "password": 0})
    if not user_doc:
        raise HTTPException(status_code=404, detail="User not found")

    role_id = user_doc.get("role") or "staff"

    # Super Admin: full access, no overrides allowed.
    if role_id == "super_admin":
        return {
            "email": email,
            "name": user_doc.get("name"),
            "role": role_id,
            "showroom_id": user_doc.get("showroom_id"),
            "showroom_name": user_doc.get("showroom_name"),
            "is_super_admin": True,
            "role_pages": [p["key"] for p in PAGE_REGISTRY],
            "role_actions": [a["key"] for a in ACTION_REGISTRY],
            "extra_pages": [], "denied_pages": [],
            "extra_actions": [], "denied_actions": [],
            "effective_pages": [p["key"] for p in PAGE_REGISTRY],
            "effective_actions": [a["key"] for a in ACTION_REGISTRY],
        }

    role = await db.roles.find_one({"role_id": role_id}, {"_id": 0})
    role_pages = list(role.get("pages", [])) if role else []
    role_actions = list(role.get("actions", [])) if role else []

    extra_pages = list(user_doc.get("extra_pages") or [])
    denied_pages = list(user_doc.get("denied_pages") or [])
    extra_actions = list(user_doc.get("extra_actions") or [])
    denied_actions = list(user_doc.get("denied_actions") or [])

    effective_pages = [p for p in role_pages if p not in denied_pages]
    for p in extra_pages:
        if p not in effective_pages:
            effective_pages.append(p)

    effective_actions = [a for a in role_actions if a not in denied_actions]
    for a in extra_actions:
        if a not in effective_actions:
            effective_actions.append(a)

    return {
        "email": email,
        "name": user_doc.get("name"),
        "role": role_id,
        "showroom_id": user_doc.get("showroom_id"),
        "showroom_name": user_doc.get("showroom_name"),
        "is_super_admin": False,
        "role_pages": role_pages,
        "role_actions": role_actions,
        "extra_pages": extra_pages,
        "denied_pages": denied_pages,
        "extra_actions": extra_actions,
        "denied_actions": denied_actions,
        "effective_pages": effective_pages,
        "effective_actions": effective_actions,
    }


@router.put("/users/{email}/overrides")
async def update_user_overrides(
    email: str,
    payload: UserOverridesPayload,
    current_user: dict = Depends(get_current_user),
):
    """Set per-user permission overrides. Pass `None` for any field you
    don't want to touch — to clear an override, pass an empty list `[]`.

    All values are validated against PAGE_REGISTRY / ACTION_REGISTRY;
    unknown keys are silently dropped so a typo in the UI can't poison
    the DB."""
    _require_super_admin(current_user)
    db = get_db()

    user_doc = await db.users.find_one({"email": email}, {"_id": 0, "role": 1, "email": 1})
    if not user_doc:
        raise HTTPException(status_code=404, detail="User not found")
    if user_doc.get("role") == "super_admin":
        raise HTTPException(status_code=400, detail="Super Admin permissions cannot be overridden")

    valid_pages = {p["key"] for p in PAGE_REGISTRY}
    valid_actions = {a["key"] for a in ACTION_REGISTRY}

    update_doc: Dict = {"updated_at": datetime.now(timezone.utc)}
    if payload.extra_pages is not None:
        update_doc["extra_pages"] = [p for p in payload.extra_pages if p in valid_pages]
    if payload.denied_pages is not None:
        update_doc["denied_pages"] = [p for p in payload.denied_pages if p in valid_pages]
    if payload.extra_actions is not None:
        update_doc["extra_actions"] = [a for a in payload.extra_actions if a in valid_actions]
    if payload.denied_actions is not None:
        update_doc["denied_actions"] = [a for a in payload.denied_actions if a in valid_actions]

    await db.users.update_one({"email": email}, {"$set": update_doc})

    # Return the recomputed breakdown so the UI doesn't need a follow-up GET.
    return await get_user_permissions_detail(email, current_user)

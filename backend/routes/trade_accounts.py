"""
Trade Account management routes for builders and tradespeople
Now reads from shop_customers collection (is_trade: True) for web-registered accounts
"""
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime, timezone
import secrets
import uuid

from services import get_current_user

SETUP_LINK_HOURS = 24 * 7

router = APIRouter(prefix="/trade-accounts", tags=["trade-accounts"],
                   dependencies=[Depends(get_current_user)])

TRADE_TYPES = [
    "Builder", "Tiler", "Plumber", "Contractor", "Interior Designer",
    "Architect", "Property Developer", "Landlord", "Kitchen Fitter",
    "Bathroom Fitter", "Flooring Specialist", "Other"
]

PRICING_TIERS = {
    "bronze": {"name": "Bronze", "min_spend": 0, "discount": 5, "color": "#CD7F32"},
    "silver": {"name": "Silver", "min_spend": 5000, "discount": 10, "color": "#C0C0C0"},
    "gold": {"name": "Gold", "min_spend": 15000, "discount": 15, "color": "#FFD700"},
    "platinum": {"name": "Platinum", "min_spend": 50000, "discount": 20, "color": "#E5E4E2"}
}


class TradeAccountCreate(BaseModel):
    business_name: str = Field(..., min_length=2)
    trading_name: Optional[str] = None
    contact_name: str = Field(..., min_length=2)
    contact_phone: str = Field(..., min_length=10)
    contact_email: str = Field(..., min_length=5)
    address_line1: str
    address_line2: Optional[str] = None
    city: str
    county: Optional[str] = None
    postcode: str
    vat_number: Optional[str] = None
    company_reg_number: Optional[str] = None
    trade_type: str
    notes: Optional[str] = None


class TradeAccountUpdate(BaseModel):
    business_name: Optional[str] = None
    trading_name: Optional[str] = None
    contact_name: Optional[str] = None
    contact_phone: Optional[str] = None
    contact_email: Optional[str] = None
    address_line1: Optional[str] = None
    address_line2: Optional[str] = None
    city: Optional[str] = None
    county: Optional[str] = None
    postcode: Optional[str] = None
    vat_number: Optional[str] = None
    company_reg_number: Optional[str] = None
    trade_type: Optional[str] = None
    notes: Optional[str] = None
    pricing_tier: Optional[str] = None
    active: Optional[bool] = None
    custom_discount: Optional[float] = None  # Override tier discount for special tradesmen
    status: Optional[str] = None  # active, pending, suspended


def get_tier_from_spend(total_spend: float) -> dict:
    tier = {**PRICING_TIERS["bronze"], "key": "bronze"}
    for tier_key, tier_data in PRICING_TIERS.items():
        if total_spend >= tier_data["min_spend"]:
            tier = {**tier_data, "key": tier_key}
    return tier


def normalize_shop_customer(doc: dict) -> dict:
    """Convert shop_customers document to trade-accounts format for the frontend"""
    address = doc.get("address", {})
    tier_key = doc.get("trade_tier", "bronze") or "bronze"
    tier_info = {**PRICING_TIERS.get(tier_key, PRICING_TIERS["bronze"]), "key": tier_key}
    total_spend = doc.get("total_spent", 0) or 0

    return {
        "id": doc.get("id", ""),
        "business_name": doc.get("business_name", ""),
        "trading_name": doc.get("trading_name", ""),
        "contact_name": doc.get("name", doc.get("contact_name", "")),
        "contact_phone": doc.get("phone", ""),
        "contact_email": doc.get("email", ""),
        "address_line1": address.get("line1", "") if isinstance(address, dict) else "",
        "address_line2": address.get("line2", "") if isinstance(address, dict) else "",
        "city": address.get("city", "") if isinstance(address, dict) else "",
        "county": address.get("county", "") if isinstance(address, dict) else "",
        "postcode": address.get("postcode", "") if isinstance(address, dict) else "",
        "vat_number": doc.get("vat_number", ""),
        "company_reg_number": doc.get("company_reg_number", ""),
        "trade_type": (doc.get("trade_type", "") or "").capitalize(),
        "notes": doc.get("notes", ""),
        "pricing_tier": tier_key,
        "pricing_tier_info": tier_info,
        "pricing_tier_override": doc.get("pricing_tier_override", False),
        "custom_discount": doc.get("custom_discount"),
        "account_number": doc.get("account_number", ""),
        "trade_account_number": doc.get("trade_account_number", ""),
        "password_set_at": doc.get("password_set_at"),
        "login_link_sent_at": doc.get("login_link_sent_at"),
        "last_login_at": doc.get("last_login_at"),
        "total_spend": total_spend,
        "order_count": doc.get("order_count", 0) or 0,
        "credit_balance": doc.get("credit_balance", 0) or 0,
        "trade_discount": doc.get("trade_discount", 5),
        "status": doc.get("status", "active"),
        "active": doc.get("status", "active") == "active",
        "source": "web_registration",
        "created_at": doc.get("created_at", ""),
        "estimated_monthly_spend": doc.get("estimated_monthly_spend", ""),
        "how_heard": doc.get("how_heard", ""),
    }


@router.get("")
async def get_trade_accounts(
    search: Optional[str] = None,
    trade_type: Optional[str] = None,
    tier: Optional[str] = None,
    active_only: bool = False,
    skip: int = 0,
    limit: int = 100
):
    """Get all trade accounts from shop_customers"""
    from server import db

    query = {"is_trade": True}

    if active_only:
        query["status"] = "active"

    if search:
        # Strip leading "T-" / "#" if the user pasted the formatted reference, so
        # `T-00042`, `#T-00042`, and `00042` all match the same record.
        bare = search.lstrip("#").strip()
        if bare.lower().startswith("t-"):
            bare = bare[2:]
        query["$or"] = [
            {"business_name": {"$regex": search, "$options": "i"}},
            {"trading_name": {"$regex": search, "$options": "i"}},
            {"name": {"$regex": search, "$options": "i"}},
            {"email": {"$regex": search, "$options": "i"}},
            {"phone": {"$regex": search, "$options": "i"}},
            # Match either the auto-minted T-NNNNN reference or any legacy
            # admin-entered account_number — both with and without the T- prefix.
            {"trade_account_number": {"$regex": search, "$options": "i"}},
            {"trade_account_number": {"$regex": bare, "$options": "i"}},
            {"account_number": {"$regex": search, "$options": "i"}},
        ]

    if trade_type:
        query["trade_type"] = {"$regex": trade_type, "$options": "i"}

    if tier:
        query["trade_tier"] = tier

    docs = await db.shop_customers.find(
        query, {"_id": 0, "password": 0}
    ).sort("created_at", -1).skip(skip).limit(limit).to_list(limit)

    accounts = [normalize_shop_customer(doc) for doc in docs]
    total = await db.shop_customers.count_documents(query)

    return {
        "accounts": accounts,
        "total": total,
        "skip": skip,
        "limit": limit
    }


@router.get("/trade-types")
async def get_trade_types():
    return TRADE_TYPES


@router.get("/pricing-tiers")
async def get_pricing_tiers():
    return PRICING_TIERS


@router.get("/{account_id}")
async def get_trade_account(account_id: str):
    """Get a specific trade account"""
    from server import db

    doc = await db.shop_customers.find_one(
        {"id": account_id, "is_trade": True}, {"_id": 0, "password": 0}
    )
    if not doc:
        raise HTTPException(status_code=404, detail="Trade account not found")

    account = normalize_shop_customer(doc)

    orders = await db.shop_orders.find(
        {"customer_id": account_id},
        {"_id": 0, "id": 1, "order_number": 1, "created_at": 1, "total": 1}
    ).sort("created_at", -1).limit(10).to_list(10)
    account["recent_orders"] = orders

    return account


async def _issue_login_link(db, customer: dict) -> dict:
    """Create a 7-day set-password link for an admin-created / locked-out
    trade customer and email it. Returns the link so staff can also pass it
    on by phone/WhatsApp."""
    from services.password_links import create_password_link, send_password_link_email
    link = await create_password_link(
        db, email=customer["email"], account_type="shop", account_id=customer.get("id"),
        is_trade=True, purpose="setup", hours=SETUP_LINK_HOURS)
    sent = await send_password_link_email(
        to=customer["email"], name=customer.get("name") or "", link=link["link"],
        purpose="setup", is_trade=True,
        trade_account_number=customer.get("trade_account_number") or "", hours=SETUP_LINK_HOURS)
    await db.shop_customers.update_one(
        {"id": customer["id"]},
        {"$set": {"login_link_sent_at": datetime.now(timezone.utc).isoformat()}})
    return {"link": link["link"], "expires_at": link["expires_at"],
            "email_sent": bool(sent.get("success")), "email_error": sent.get("error")}


@router.post("")
async def create_trade_account(account: TradeAccountCreate):
    """Create a new trade account (staff-created via admin). The customer gets
    a set-your-password email so they can order online straight away."""
    from server import db
    from services import hash_password
    from services.password_links import normalize_email, email_query
    from routes.shop import _mint_trade_account_number

    email = normalize_email(account.contact_email)
    if "@" not in email:
        raise HTTPException(status_code=400, detail="A valid contact email is required")
    existing = await db.shop_customers.find_one(email_query(email), {"_id": 0, "id": 1})
    if existing:
        raise HTTPException(status_code=400, detail="A customer with this email already exists — search for it and use 'Send login link' instead")

    customer_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)

    doc = {
        "id": customer_id,
        "email": email,
        "password": hash_password(secrets.token_urlsafe(24)),
        "trade_account_number": await _mint_trade_account_number(db),
        "name": account.contact_name,
        "business_name": account.business_name,
        "trading_name": account.trading_name,
        "trade_type": account.trade_type,
        "phone": account.contact_phone,
        "address": {
            "line1": account.address_line1,
            "line2": account.address_line2 or "",
            "city": account.city,
            "county": account.county or "",
            "postcode": account.postcode,
            "country": "United Kingdom"
        },
        "vat_number": account.vat_number,
        "company_reg_number": account.company_reg_number,
        "notes": account.notes,
        "is_trade": True,
        "trade_tier": "bronze",
        "trade_discount": 5,
        "credit_balance": 0.0,
        "total_spent": 0.0,
        "order_count": 0,
        "status": "active",
        "created_at": now.isoformat(),
        "wishlist": [],
        "cart": [],
    }

    await db.shop_customers.insert_one(doc)
    result = normalize_shop_customer(doc)
    result["login_link"] = await _issue_login_link(db, doc)
    return result


@router.post("/{account_id}/send-login-link")
async def send_trade_login_link(account_id: str):
    """Email a set-password link to a trade customer who can't get in
    (in-store accounts, forgotten passwords, mixed-up emails)."""
    from server import db
    from routes.shop import _ensure_trade_account_number

    customer = await db.shop_customers.find_one(
        {"id": account_id, "is_trade": True}, {"_id": 0, "password": 0})
    if not customer:
        raise HTTPException(status_code=404, detail="Trade account not found")
    if not customer.get("email") or "@" not in customer["email"]:
        raise HTTPException(status_code=400, detail="This account has no valid email address — add one first")
    customer = await _ensure_trade_account_number(db, customer)
    result = await _issue_login_link(db, customer)
    return {"success": True, "email": customer["email"],
            "trade_account_number": customer.get("trade_account_number"), **result}


@router.put("/{account_id}")
async def update_trade_account(account_id: str, account: TradeAccountUpdate):
    """Update a trade account"""
    from server import db

    existing = await db.shop_customers.find_one(
        {"id": account_id, "is_trade": True}, {"_id": 0}
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Trade account not found")

    update_data = {}
    data = account.model_dump(exclude_none=True)

    # Map frontend field names to shop_customers field names
    field_map = {
        "contact_name": "name",
        "contact_phone": "phone",
        "contact_email": "email",
        "pricing_tier": "trade_tier",
    }

    for key, value in data.items():
        if key == "active":
            update_data["status"] = "active" if value else "inactive"
        elif key == "status":
            update_data["status"] = value
        elif key == "custom_discount":
            if value is not None:
                update_data["custom_discount"] = value
                update_data["trade_discount"] = value
                update_data["pricing_tier_override"] = True
            else:
                update_data.pop("custom_discount", None)
        elif key in ("address_line1", "address_line2", "city", "county", "postcode"):
            addr_key = key.replace("address_", "")
            if addr_key == "line1":
                addr_key = "line1"
            elif addr_key == "line2":
                addr_key = "line2"
            update_data[f"address.{addr_key}"] = value
        elif key in field_map:
            update_data[field_map[key]] = value
            if key == "pricing_tier":
                # Only auto-set discount if no custom discount
                if "custom_discount" not in data:
                    update_data["pricing_tier_override"] = True
                    tier_info = PRICING_TIERS.get(value, PRICING_TIERS["bronze"])
                    update_data["trade_discount"] = tier_info["discount"]
        else:
            update_data[key] = value

    if update_data:
        update_data["updated_at"] = datetime.now(timezone.utc).isoformat()
        await db.shop_customers.update_one(
            {"id": account_id}, {"$set": update_data}
        )

    return {"message": "Trade account updated", "id": account_id}


@router.delete("/{account_id}")
async def delete_trade_account(account_id: str):
    """Deactivate a trade account"""
    from server import db

    existing = await db.shop_customers.find_one(
        {"id": account_id, "is_trade": True}, {"_id": 0}
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Trade account not found")

    await db.shop_customers.update_one(
        {"id": account_id},
        {"$set": {"status": "inactive", "updated_at": datetime.now(timezone.utc).isoformat()}}
    )

    return {"message": "Trade account deactivated", "id": account_id}


@router.get("/{account_id}/orders")
async def get_account_orders(account_id: str, skip: int = 0, limit: int = 50):
    """Get order history for a trade account"""
    from server import db

    account = await db.shop_customers.find_one(
        {"id": account_id, "is_trade": True}, {"_id": 0, "business_name": 1}
    )
    if not account:
        raise HTTPException(status_code=404, detail="Trade account not found")

    orders = await db.shop_orders.find(
        {"customer_id": account_id}, {"_id": 0}
    ).sort("created_at", -1).skip(skip).limit(limit).to_list(limit)

    total = await db.shop_orders.count_documents({"customer_id": account_id})

    return {
        "orders": orders,
        "total": total,
        "business_name": account.get("business_name")
    }


@router.get("/by-number/{number}/orders")
async def get_orders_by_account_number(number: str, skip: int = 0, limit: int = 50):
    """Look up orders directly by the customer-facing trade reference (e.g. T-00042).
    Accepts the bare digits ('00042') or the full reference ('T-00042') or
    with a leading hash ('#T-00042'). Useful for admin phone lookups."""
    from server import db

    cleaned = number.strip().lstrip("#").strip()
    if cleaned.lower().startswith("t-"):
        normalized = "T-" + cleaned[2:]
    else:
        normalized = "T-" + cleaned.zfill(5)

    account = await db.shop_customers.find_one(
        {"trade_account_number": normalized, "is_trade": True},
        {"_id": 0, "id": 1, "business_name": 1, "trade_account_number": 1, "email": 1},
    )
    if not account:
        raise HTTPException(status_code=404, detail=f"No trade account found for {normalized}")

    # Match by either the explicit field on the order or the customer_id (legacy
    # orders that predate the field — backfilled via the savings endpoint flow).
    query = {"$or": [
        {"trade_account_number": normalized},
        {"customer_id": account["id"]},
    ]}
    orders = await db.shop_orders.find(query, {"_id": 0}).sort("created_at", -1).skip(skip).limit(limit).to_list(limit)
    total = await db.shop_orders.count_documents(query)

    return {
        "account": account,
        "orders": orders,
        "total": total,
    }

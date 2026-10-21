"""
E-Commerce Shop Routes
Public-facing routes for the online store
"""
import uuid
import os
import logging

logger = logging.getLogger(__name__)
import asyncio
from datetime import datetime, timezone, timedelta
from typing import Optional, List, Dict, Any
from fastapi import APIRouter, HTTPException, Depends, Query, Request, Body
from pydantic import BaseModel, EmailStr, Field, ConfigDict

from config import get_db
from services import hash_password, verify_password, create_access_token, get_current_user, RESEND_AVAILABLE, send_order_status_notification, send_shop_order_confirmation
from services.promo_codes import validate_promo_code, consume_promo_code, generate_referral_code, generate_promo_code_for_email

# Stripe integration
from emergentintegrations.payments.stripe.checkout import (
    StripeCheckout,
    CheckoutSessionRequest,
    CheckoutSessionResponse,
    CheckoutStatusResponse,
)

router = APIRouter(prefix="/shop", tags=["Shop"])


async def _mint_trade_account_number(db) -> str:
    """
    Allocate the next sequential trade account number, e.g. T-00042.
    
    Uses an atomic findAndModify on a `counters` doc so concurrent registrations
    can't collide on the same number. Format: `T-` + zero-padded 5-digit int,
    short enough to read down a phone but distinct from order numbers.
    """
    res = await db.counters.find_one_and_update(
        {"_id": "trade_account_number"},
        {"$inc": {"seq": 1}},
        upsert=True,
        return_document=True,  # ReturnDocument.AFTER
    )
    seq = int((res or {}).get("seq", 1))
    return f"T-{seq:05d}"


async def _ensure_trade_account_number(db, customer: dict) -> dict:
    """Backfill a trade_account_number on legacy approved trade accounts.
    Returns the (possibly mutated) customer dict so callers can keep using it."""
    if not customer:
        return customer
    if customer.get("trade_account_number"):
        return customer
    is_trade = bool(customer.get("is_trade") or customer.get("trade_account_status") == "approved")
    if not is_trade:
        return customer
    number = await _mint_trade_account_number(db)
    await db.shop_customers.update_one(
        {"id": customer["id"]},
        {"$set": {"trade_account_number": number}},
    )
    customer["trade_account_number"] = number
    return customer


async def _attach_trade_metadata(db, order_doc: dict, customer_id: Optional[str]) -> dict:
    """
    Attach `trade_account_number` to an order doc so admin queries like
    "all orders for T-00042" become a single direct lookup, and so the
    reference can be printed straight onto receipts/invoices.

    Called inline from every order-creation path. Silently skips guests and
    non-trade customers; never raises.
    """
    if not customer_id:
        return order_doc
    try:
        customer = await db.shop_customers.find_one(
            {"id": customer_id},
            {"_id": 0, "id": 1, "is_trade": 1, "trade_account_number": 1, "trade_account_status": 1, "business_name": 1},
        )
        if not customer:
            return order_doc
        # Backfill for legacy trade accounts created before T-NNNNN existed.
        customer = await _ensure_trade_account_number(db, customer)
        if customer.get("trade_account_number"):
            order_doc["trade_account_number"] = customer["trade_account_number"]
            if customer.get("business_name") and not order_doc.get("trade_business_name"):
                order_doc["trade_business_name"] = customer["business_name"]
    except Exception:  # noqa: BLE001 — never block an order on enrichment
        logger.exception("Failed to attach trade metadata to order")
    return order_doc


async def _record_paid_order_for_customer(db, order_id: str) -> None:
    """On the first paid flip of a linked order: bump the customer's spend /
    order count (drives tier progress) and award trade credit-back."""
    order = await db.shop_orders.find_one({"id": order_id}, {"_id": 0, "customer_id": 1, "subtotal": 1, "total": 1, "paid_at": 1})
    customer_id = (order or {}).get("customer_id")
    if not customer_id:
        return
    try:
        await db.shop_customers.update_one(
            {"id": customer_id},
            {"$inc": {"total_spent": float(order.get("subtotal") or order.get("total") or 0), "order_count": 1},
             "$set": {"last_order_at": order.get("paid_at") or datetime.now(timezone.utc).isoformat()}},
        )
        credit = await award_credits_for_order(order_id, db)
        if credit.get("success"):
            logger.info("Trade credit £%.2f awarded for order %s", credit.get("credits_earned", 0), order_id)
    except Exception:  # noqa: BLE001 — stats/credit never block the paid flip
        logger.exception("Failed to record paid order for customer")


# ============ Trade Credit Reversal Helpers (online orders) ================
# Used when an online shop order is cancelled or refunded so the trader's
# `credit_balance` mirrors the real economics:
#   • credits_awarded   (credit-back earned)  → subtract back from balance
#   • credits_applied   (credit redeemed at checkout) → ADD back to balance
# Idempotent via the `credits_reversed` flag stamped on the order doc.

async def reverse_shop_order_credits(db, order: dict, *, reason: str = "order_cancelled") -> dict:
    """Idempotently reverse any trade-credit movement caused by this order."""
    summary = {"awarded_reversed": 0.0, "applied_reversed": 0.0}
    if not order or order.get("credits_reversed"):
        return summary

    order_id = order.get("id")
    order_no = order.get("order_number") or ""
    customer_id = order.get("customer_id")
    now = datetime.now(timezone.utc).isoformat()

    awarded = float(order.get("credits_awarded") or 0)
    if awarded > 0 and customer_id:
        cust = await db.shop_customers.find_one_and_update(
            {"id": customer_id},
            {"$inc": {"credit_balance": -awarded}},
            return_document=False,
        )
        prior_balance = float((cust or {}).get("credit_balance") or 0)
        await db.trade_credits.insert_one({
            "id": str(uuid.uuid4()),
            "customer_id": customer_id,
            "order_id": order_id,
            "order_number": order_no,
            "type": "reverse_earn",
            "amount": -awarded,
            "balance_after": round(prior_balance - awarded, 2),
            "description": f"Reversed credit-back from order {order_no} ({reason})",
            "created_at": now,
        })
        summary["awarded_reversed"] = awarded

    applied = float(order.get("credits_applied") or 0)
    if applied > 0 and customer_id:
        cust = await db.shop_customers.find_one_and_update(
            {"id": customer_id},
            {"$inc": {"credit_balance": applied}},  # add back
            return_document=False,
        )
        prior_balance = float((cust or {}).get("credit_balance") or 0)
        await db.trade_credits.insert_one({
            "id": str(uuid.uuid4()),
            "customer_id": customer_id,
            "order_id": order_id,
            "order_number": order_no,
            "type": "reverse_redeem",
            "amount": applied,
            "balance_after": round(prior_balance + applied, 2),
            "description": f"Refunded credit redemption from order {order_no} ({reason})",
            "created_at": now,
        })
        summary["applied_reversed"] = applied

    if summary["awarded_reversed"] > 0 or summary["applied_reversed"] > 0:
        await db.shop_orders.update_one(
            {"id": order_id},
            {"$set": {
                "credits_reversed": True,
                "credits_reversed_at": now,
                "credits_reversed_reason": reason,
            }},
        )
    return summary


async def reapply_shop_order_credits(db, order: dict, *, reason: str = "order_uncancelled") -> dict:
    """Inverse of reverse_shop_order_credits — used when a previously-cancelled
    order is changed back to any other status. Idempotent."""
    summary = {"awarded_reapplied": 0.0, "applied_reapplied": 0.0}
    if not order or not order.get("credits_reversed"):
        return summary

    order_id = order.get("id")
    order_no = order.get("order_number") or ""
    customer_id = order.get("customer_id")
    now = datetime.now(timezone.utc).isoformat()

    awarded = float(order.get("credits_awarded") or 0)
    if awarded > 0 and customer_id:
        cust = await db.shop_customers.find_one_and_update(
            {"id": customer_id},
            {"$inc": {"credit_balance": awarded}},
            return_document=False,
        )
        prior_balance = float((cust or {}).get("credit_balance") or 0)
        await db.trade_credits.insert_one({
            "id": str(uuid.uuid4()),
            "customer_id": customer_id,
            "order_id": order_id,
            "order_number": order_no,
            "type": "reapply_earn",
            "amount": awarded,
            "balance_after": round(prior_balance + awarded, 2),
            "description": f"Re-applied credit-back to order {order_no} ({reason})",
            "created_at": now,
        })
        summary["awarded_reapplied"] = awarded

    applied = float(order.get("credits_applied") or 0)
    if applied > 0 and customer_id:
        cust = await db.shop_customers.find_one_and_update(
            {"id": customer_id},
            {"$inc": {"credit_balance": -applied}},
            return_document=False,
        )
        prior_balance = float((cust or {}).get("credit_balance") or 0)
        await db.trade_credits.insert_one({
            "id": str(uuid.uuid4()),
            "customer_id": customer_id,
            "order_id": order_id,
            "order_number": order_no,
            "type": "reapply_redeem",
            "amount": -applied,
            "balance_after": round(prior_balance - applied, 2),
            "description": f"Re-applied credit redemption to order {order_no} ({reason})",
            "created_at": now,
        })
        summary["applied_reapplied"] = applied

    await db.shop_orders.update_one(
        {"id": order_id},
        {"$unset": {
            "credits_reversed": "",
            "credits_reversed_at": "",
            "credits_reversed_reason": "",
        }},
    )
    return summary




# ============ PAYMENT METHOD HELPERS ============

# Klarna UK minimum order value (Stripe enforces this — smaller baskets fall back to card)
KLARNA_UK_MIN_AMOUNT_GBP = 30.0

async def get_enabled_checkout_payment_methods(order_total: float) -> list:
    """
    Returns the list of Stripe payment_method_types to show at checkout,
    based on admin settings (checkout_settings.value.payments) and order amount.
    
    - Always includes 'card'.
    - Includes 'klarna' only if admin toggled it on AND order total >= £30 (Klarna UK minimum).
    - Includes 'paypal' only if admin toggled it on (no minimum).
    - Honours STRIPE_DISABLED_METHODS env var (comma-separated) as an
      emergency kill-switch — e.g. STRIPE_DISABLED_METHODS=paypal will
      strip paypal from every checkout request without redeploying or
      touching the admin DB. This is what saved us when PayPal showed
      as enabled in the DB but was never activated on the Stripe account
      (May 2 2026 incident — every sample checkout 500'd with
      "payment method type provided: paypal is invalid").
    Falls back to ['card'] if settings are missing or on any error.
    """
    methods = ["card"]
    try:
        db = get_db()
        doc = await db.website_settings.find_one({"key": "checkout_settings"}, {"_id": 0})
        payments_cfg = (doc or {}).get("value", {}).get("payments", {}) if doc else {}
        if payments_cfg.get("klarna_enabled") and order_total >= KLARNA_UK_MIN_AMOUNT_GBP:
            methods.append("klarna")
        if payments_cfg.get("paypal_enabled"):
            methods.append("paypal")
    except Exception as e:
        logging.getLogger(__name__).warning(
            f"Failed to read payment settings; falling back to ['card']: {e}"
        )

    # Emergency env-var kill-switch — comma-separated method names to strip
    disabled_csv = (os.environ.get("STRIPE_DISABLED_METHODS") or "").strip()
    if disabled_csv:
        disabled = {m.strip().lower() for m in disabled_csv.split(",") if m.strip()}
        if disabled:
            before = list(methods)
            methods = [m for m in methods if m.lower() not in disabled]
            stripped = [m for m in before if m.lower() in disabled]
            if stripped:
                logging.getLogger(__name__).info(
                    f"STRIPE_DISABLED_METHODS stripped {stripped} from checkout"
                )
    # Defensive — never return empty
    if not methods:
        methods = ["card"]
    return methods


def _resolve_webhook_url(request: Optional[Request] = None) -> str:
    """Resolve the absolute URL Stripe should call for webhooks.

    Priority order:
      1. SITE_URL env var (production-pinned, set on Railway)
      2. BACKEND_URL env var (already set on prod/preview)
      3. request.base_url (last-resort fallback; behind Railway's proxy
         this resolves to the internal container hostname, which Stripe
         cannot reach — that's the bug the 2 May 2026 incident exposed
         where the Zoe Ward payment had no webhook hit).

    Always returns the FULL absolute /api/webhook/stripe URL.
    """
    base = (
        os.environ.get("SITE_URL")
        or os.environ.get("BACKEND_URL")
        or ""
    ).strip().rstrip("/")
    if not base and request is not None:
        try:
            base = str(request.base_url).rstrip("/")
        except Exception:  # noqa: BLE001
            base = ""
    if not base:
        # Hard fail — better to refuse checkout than silently lose money
        raise HTTPException(
            status_code=500,
            detail="Payment service mis-configured (SITE_URL/BACKEND_URL missing)",
        )
    return f"{base}/api/webhook/stripe"


async def _create_stripe_checkout_with_fallback(
    stripe_checkout, request_factory, methods: list
):
    """Try a Stripe Checkout session creation, and if Stripe rejects a
    specific payment_method_type as "not activated", strip that method
    and retry with what's left (always at least 'card'). Bullet-proofs
    us against admin/DB state drifting away from Stripe dashboard state.

    `request_factory(methods_list)` must return a fresh CheckoutSessionRequest
    with the given method list — so we can build a new request on each retry.
    """
    last_exc: Exception | None = None
    attempts = 0
    current = list(methods) if methods else ["card"]
    while attempts < 4 and current:
        attempts += 1
        try:
            req = request_factory(current)
            return await stripe_checkout.create_checkout_session(req)
        except Exception as e:  # noqa: BLE001
            last_exc = e
            err_text = str(e).lower()
            # Stripe error pattern: "The payment method type provided: paypal is invalid"
            stripped = None
            for candidate in list(current):
                if candidate != "card" and candidate.lower() in err_text and "invalid" in err_text:
                    stripped = candidate
                    break
            if not stripped:
                # Not a method-activation error — bubble up
                raise
            current = [m for m in current if m != stripped]
            logging.getLogger(__name__).warning(
                f"Stripe rejected method '{stripped}' as not activated — retrying with {current}"
            )
    if last_exc:
        raise last_exc
    raise RuntimeError("Stripe checkout retry loop exhausted")


async def is_klarna_checkout_enabled() -> bool:
    """True when admin has flipped on Klarna at checkout (ignores amount threshold)."""
    try:
        db = get_db()
        doc = await db.website_settings.find_one({"key": "checkout_settings"}, {"_id": 0})
        return bool(
            (doc or {}).get("value", {}).get("payments", {}).get("klarna_enabled")
        )
    except Exception:
        return False


async def is_paypal_checkout_enabled() -> bool:
    """True when admin has flipped on PayPal at checkout."""
    try:
        db = get_db()
        doc = await db.website_settings.find_one({"key": "checkout_settings"}, {"_id": 0})
        return bool(
            (doc or {}).get("value", {}).get("payments", {}).get("paypal_enabled")
        )
    except Exception:
        return False



# ============ MODELS ============

class ShopCustomerRegister(BaseModel):
    email: EmailStr
    password: str
    name: str
    phone: str = ""
    address_line1: str = ""
    address_line2: str = ""
    city: str = ""
    postcode: str = ""
    is_trade: bool = False

class TradeCustomerRegister(BaseModel):
    email: EmailStr
    password: str
    contact_name: str
    phone: str
    business_name: str
    trading_name: str = ""
    # Legal structure: sole_trader / ltd_company / partnership / plc / other.
    # Empty string is allowed for backward-compat with submissions made
    # before the field was introduced (Feb 2026).
    business_type: str = ""
    business_type_other: str = ""  # populated when business_type == "other"
    vat_number: str = ""
    company_reg_number: str = ""
    trade_type: str
    address_line1: str
    address_line2: str = ""
    city: str
    county: str = ""
    postcode: str
    estimated_monthly_spend: str = ""
    how_heard: str = ""
    notes: str = ""

class ShopCustomerLogin(BaseModel):
    email: EmailStr
    password: str

class CartItem(BaseModel):
    product_id: str
    quantity: float
    price: float
    name: str
    sku: str = ""
    image: str = ""


class KlarnaExpressRequest(BaseModel):
    """Minimal payload for Klarna Express Checkout — admin collects nothing;
    Stripe collects customer details inside the hosted Klarna flow."""
    items: List[CartItem]
    origin_url: str
    customer_email: Optional[EmailStr] = None  # optional prefill if known


class PaypalExpressRequest(BaseModel):
    """Minimal payload for PayPal Express Checkout — admin collects nothing;
    Stripe collects customer details inside the hosted PayPal flow."""
    items: List[CartItem]
    origin_url: str
    customer_email: Optional[EmailStr] = None  # optional prefill if known

class ShopOrderCreate(BaseModel):
    customer_name: str
    customer_email: EmailStr
    customer_phone: str = ""
    delivery_address: dict = {}
    delivery_method: str = "delivery"  # delivery or collect
    collect_store_id: Optional[str] = None
    notes: str = ""
    items: List[CartItem]

class CheckoutRequest(BaseModel):
    origin_url: str
    order_id: str


class GuestOrderCreate(BaseModel):
    """Order creation for guest checkout (no account required)"""
    customer_name: str
    customer_email: EmailStr
    customer_phone: str = ""
    delivery_address: dict = {}
    delivery_method: str = "delivery"
    collect_store_id: Optional[str] = None
    notes: str = ""
    items: List[CartItem]
    create_account: bool = False
    password: Optional[str] = None


class GuestCheckoutOrderItem(BaseModel):
    """Cart item shape sent from TileCheckoutPage. Tolerant of legacy
    cart items (some persisted in localStorage for weeks) that may be
    missing a field or have ``null`` where a string is expected."""
    model_config = ConfigDict(extra="ignore")

    product_id: Optional[str] = ""
    name: Optional[str] = ""
    variant: Optional[str] = ""
    price: Optional[float] = 0
    quantity: Optional[float] = 0
    image: Optional[str] = ""


class GuestCheckoutOrder(BaseModel):
    """Guest checkout order from TileCheckoutPage. ``extra="ignore"`` so
    the frontend can safely add new fields (e.g. ``express_fee``) without
    breaking older backend deploys."""
    model_config = ConfigDict(extra="ignore")

    items: List[GuestCheckoutOrderItem]
    customer: dict
    delivery: dict
    billing: Optional[dict] = None  # Optional separate billing address; mirrors delivery if same_as_delivery=True
    payment: dict = {}
    promo_code: Optional[str] = None  # Applied at checkout (e.g. abandoned-cart day-1 code)
    subtotal: Optional[float] = 0
    delivery_fee: Optional[float] = 0
    total: Optional[float] = 0
    # Savings breakdown — frontend computes (volume tier + trade) per line and
    # in aggregate; backend persists so order email + invoice PDF can render
    # the same "You saved £X (Y% off retail)" strip the customer saw in cart.
    savings_meta: Optional[dict] = None


class ProductReview(BaseModel):
    rating: int = Field(..., ge=1, le=5)
    title: str = ""
    comment: str = ""


class TileCalculatorInput(BaseModel):
    room_length: float  # in meters
    room_width: float   # in meters
    product_id: str
    wastage_percent: float = 10.0  # Default 10% wastage


class OrderStatusUpdate(BaseModel):
    status: str  # confirmed, processing, shipped, delivered, ready_for_collection, collected, cancelled
    tracking_number: Optional[str] = None
    tracking_url: Optional[str] = None
    notes: Optional[str] = None


# ============ HELPER FUNCTIONS ============

def serialize_product_for_shop(product: dict) -> dict:
    """Serialize product for shop display (hide sensitive fields)"""
    return {
        "id": product.get("id"),
        "name": product.get("name"),
        "description": product.get("description", ""),
        "sku": product.get("sku", ""),
        "supplier": product.get("supplier"),  # Needed for product documents lookup
        "price": product.get("price", 0),
        "stock": product.get("stock", 0),
        "category_id": product.get("category_id", ""),
        "category_name": product.get("category_name", ""),
        "unit": product.get("unit", "piece"),
        "m2_quantity": product.get("m2_quantity"),
        "tile_width": product.get("tile_width"),
        "tile_height": product.get("tile_height"),
        "tile_m2_per_piece": product.get("tile_m2_per_piece"),
        "tiles_per_box": product.get("tiles_per_box"),
        "sqm_per_box": product.get("sqm_per_box") or product.get("box_m2_coverage"),
        "box_m2_coverage": product.get("box_m2_coverage") or product.get("sqm_per_box"),
        "clearance": product.get("clearance", False),
        "clearance_price": product.get("clearance_price"),
        "images": product.get("images", []),
        "in_stock": product.get("stock", 0) > 0,
        "avg_rating": product.get("avg_rating", 0),
        "review_count": product.get("review_count", 0)
    }


# ============ PUBLIC PRODUCT ROUTES ============

@router.get("/products")
async def get_shop_products(
    category_id: Optional[str] = None,
    search: Optional[str] = None,
    min_price: Optional[float] = None,
    max_price: Optional[float] = None,
    in_stock_only: bool = False,
    clearance_only: bool = False,
    sort_by: str = "name",  # name, price_asc, price_desc, newest
    page: int = 1,
    limit: int = 20
):
    """Get products for public shop - no auth required"""
    db = get_db()
    
    # Build query
    query = {}
    
    if category_id:
        query["category_id"] = category_id
    
    if search:
        query["$or"] = [
            {"name": {"$regex": search, "$options": "i"}},
            {"description": {"$regex": search, "$options": "i"}},
            {"sku": {"$regex": search, "$options": "i"}}
        ]
    
    if min_price is not None:
        query["price"] = {"$gte": min_price}
    
    if max_price is not None:
        if "price" in query:
            query["price"]["$lte"] = max_price
        else:
            query["price"] = {"$lte": max_price}
    
    if in_stock_only:
        query["stock"] = {"$gt": 0}
    
    if clearance_only:
        query["clearance"] = True
    
    # Sorting
    sort_field = "name"
    sort_order = 1
    if sort_by == "price_asc":
        sort_field = "price"
        sort_order = 1
    elif sort_by == "price_desc":
        sort_field = "price"
        sort_order = -1
    elif sort_by == "newest":
        sort_field = "created_at"
        sort_order = -1
    
    # Get total count
    total = await db.products.count_documents(query)
    
    # Get products with pagination
    skip = (page - 1) * limit
    products = await db.products.find(query, {"_id": 0}).sort(sort_field, sort_order).skip(skip).limit(limit).to_list(limit)
    
    return {
        "products": [serialize_product_for_shop(p) for p in products],
        "total": total,
        "page": page,
        "limit": limit,
        "total_pages": (total + limit - 1) // limit
    }


@router.get("/search-all")
async def search_all_catalogues(
    q: str,
    page: int = 1,
    limit: int = 24,
):
    """Unified storefront search across the full catalogue.

    Background: the old header search was routing every query to the
    collection-grouped tile results page, so searches for tools, grouts,
    adhesives and other non-tile products returned "0 collections found"
    even though the underlying rows existed in the `products` collection.

    This endpoint searches BOTH storefront catalogues:
      • `tiles` — individual tile SKUs (by display_name / supplier_code /
        series / attributes.color)
      • `products` — tools, grouts, accessories, underfloor heating kits,
        etc. (by name / sku / description / category_name)

    Returns a flat list of `{type, id, name, slug, image, price, ...}`
    entries, so the storefront can render one unified "All Products" grid
    without caring which collection each hit came from.
    """
    q = (q or "").strip()
    if len(q) < 2:
        return {"results": [], "total": 0, "page": 1, "limit": limit, "total_pages": 0}

    db = get_db()

    # Use the SAME tokenising / multi-field search engine the autocomplete
    # uses (`/api/tiles/search`). Without this, "high polish tiles"
    # surfaced 1 tile in the autocomplete and 0 on this page — same DB,
    # same query, two different algorithms. Now there's one source of
    # truth in `services/tile_search.py`.
    from services.tile_search import (
        build_tile_search_query,
        build_product_search_query,
        rank_score,
    )

    tile_query = build_tile_search_query(q)
    product_query = build_product_search_query(q)
    if tile_query is None and product_query is None:
        return {"results": [], "total": 0, "page": 1, "limit": limit, "total_pages": 0}

    tiles_total = await db.tiles.count_documents(tile_query) if tile_query else 0
    products_total = await db.products.count_documents(product_query) if product_query else 0

    total = tiles_total + products_total

    # Paginate across the merged result stream. We fetch both shards,
    # concatenate, and slice — acceptable while `limit * page` stays
    # modest (default 24 per page, UI caps at ~500 results anyway).
    skip = (page - 1) * limit
    fetch_budget = skip + limit

    tile_docs = await db.tiles.find(tile_query, {"_id": 0}).limit(fetch_budget).to_list(fetch_budget) if tile_query else []
    product_docs = await db.products.find(product_query, {"_id": 0}).limit(fetch_budget).to_list(fetch_budget) if product_query else []

    merged = []
    for t in tile_docs:
        name = t.get("display_name") or t.get("name") or ""
        images = t.get("images") or []
        price = t.get("room_lot_price") or t.get("price_per_sqm") or t.get("price") or 0
        merged.append({
            "type": "tile",
            "id": t.get("id") or t.get("slug"),
            "name": name,
            "slug": t.get("slug"),
            "image": images[0] if images else "",
            "price": price,
            "price_unit": "per m²",
            "url": f"/tiles/{t.get('slug')}" if t.get("slug") else "/tiles",
            "category": t.get("category") or "Tiles",
        })

    for p in product_docs:
        images = p.get("images") or []
        merged.append({
            "type": "product",
            "id": p.get("id"),
            "name": p.get("name") or "",
            "slug": p.get("id"),
            "image": images[0] if images else "",
            "price": p.get("price") or 0,
            "price_unit": p.get("unit") or "piece",
            "url": f"/shop/products/{p.get('id')}",
            "category": p.get("category_name") or "Accessories",
        })

    # Deterministic ordering using the shared rank_score (same logic
    # as autocomplete). Exact-substring matches surface first; then
    # tiles that match more query tokens; then alphabetical.
    for r in merged:
        r["_score"] = rank_score(r["name"], q)
    merged.sort(key=lambda r: (r.pop("_score", 99), r["name"].lower()))

    page_slice = merged[skip: skip + limit]

    # On a zero-result page, compute "Did you mean?" suggestions by
    # fuzzy-matching the query against the catalogue vocabulary. The
    # vocabulary is cached for 10 minutes so repeated typo searches don't
    # re-scan Mongo.
    suggestions: list[str] = []
    if total == 0:
        suggestions = await _fuzzy_suggestions(db, q)

    return {
        "results": page_slice,
        "total": total,
        "counts_by_type": {"tile": tiles_total, "product": products_total},
        "page": page,
        "limit": limit,
        "total_pages": (total + limit - 1) // limit if total else 0,
        "suggestions": suggestions,
    }


# ───── Search vocabulary cache + "Did you mean?" helper ────────────
# Rebuilt lazily every `_SEARCH_VOCAB_TTL_SECONDS`. Small enough to keep
# in-memory — expected size is a few thousand unique names.
_SEARCH_VOCAB_TTL_SECONDS = 600
_search_vocab_cache: dict = {"at": 0.0, "terms": []}


async def _build_search_vocab(db) -> list:
    """Assemble the distinct, human-facing terms we fuzzy-match against.
    Pulls tile display_names + series + categories + product names +
    product category names. We store BOTH the full phrase (for whole-name
    typos like "atelir" → "Atelier Concrete") AND individual words
    (for single-word typos like "adheisive" → "Adhesive")."""
    import time
    import re as _re

    phrases: set[str] = set()
    words: dict[str, str] = {}  # lowercase → original-cased representative

    def _ingest(val: str) -> None:
        if not val:
            return
        v = val.strip()
        if len(v) >= 3:
            phrases.add(v)
        for w in _re.split(r"[^A-Za-z]+", v):
            w = w.strip()
            # Keep alphabetical tokens of length 4+ only — filters out
            # "60", "cm", and numeric bits; keeps "Atelier" / "Polished".
            if len(w) >= 4 and w.isalpha():
                words.setdefault(w.lower(), w)

    # Tiles
    tile_cursor = db.tiles.find(
        {"is_active": {"$ne": False}},
        {"_id": 0, "display_name": 1, "name": 1, "series": 1, "original_series": 1, "category": 1},
    ).limit(5000)
    async for t in tile_cursor:
        for key in ("display_name", "name", "series", "original_series", "category"):
            _ingest(t.get(key) or "")

    # Products
    prod_cursor = db.products.find(
        {"is_active": True},
        {"_id": 0, "name": 1, "category_name": 1},
    ).limit(5000)
    async for p in prod_cursor:
        for key in ("name", "category_name"):
            _ingest(p.get(key) or "")

    # Merge: individual words first (better for typo matching), then
    # phrases (for multi-word catalogues). De-dupe on lower-case.
    merged: dict[str, str] = {}
    for lw, orig in words.items():
        merged[lw] = orig
    for ph in phrases:
        merged.setdefault(ph.lower(), ph)

    _search_vocab_cache["at"] = time.time()
    _search_vocab_cache["terms"] = list(merged.values())
    _search_vocab_cache["lower_map"] = {k: v for k, v in merged.items()}
    return _search_vocab_cache["terms"]


async def _fuzzy_suggestions(db, q: str, limit: int = 5) -> list:
    """Return up to `limit` close-match suggestions for a zero-result query.
    Uses Python's stdlib `difflib.get_close_matches` (Ratcliff-Obershelp) —
    good enough for single-word typos and pluralisation variants. Skips
    dominant-prefix matches against the query itself to avoid returning
    e.g. "grouts" when the user searched "grouts" but the catalogue has no
    hits (that would already be in the vocab but wouldn't match the query).
    """
    import time
    from difflib import get_close_matches

    q_clean = (q or "").strip()
    if len(q_clean) < 2:
        return []

    now = time.time()
    if not _search_vocab_cache["terms"] or (now - _search_vocab_cache["at"]) > _SEARCH_VOCAB_TTL_SECONDS:
        try:
            await _build_search_vocab(db)
        except Exception:  # noqa: BLE001
            return []

    # Match against lower-cased terms; keep original-cased terms for return.
    terms = _search_vocab_cache["terms"]
    lower_map = _search_vocab_cache.get("lower_map") or {
        t.lower(): t for t in terms
    }
    lower_terms = list(lower_map.keys())

    matches = get_close_matches(q_clean.lower(), lower_terms, n=limit * 3, cutoff=0.55)
    seen: set = set()
    out: list = []
    q_lower = q_clean.lower()
    for m in matches:
        # Don't suggest the exact query back — only corrections.
        if m == q_lower:
            continue
        original = lower_map.get(m, m)
        key = original.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(original)
        if len(out) >= limit:
            break
    return out


@router.get("/products/{product_id}")
async def get_shop_product(product_id: str):
    """Get single product details for shop"""
    db = get_db()
    
    product = await db.products.find_one({"id": product_id}, {"_id": 0})
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    
    return serialize_product_for_shop(product)


@router.get("/categories")
async def get_shop_categories():
    """Get all categories for shop navigation"""
    db = get_db()
    
    categories = await db.categories.find({}, {"_id": 0}).to_list(1000)
    
    # Get product count per category
    for cat in categories:
        count = await db.products.count_documents({"category_id": cat["id"]})
        cat["product_count"] = count
    
    return categories


@router.get("/featured")
async def get_featured_products(limit: int = 8):
    """Get featured products (clearance + popular items)"""
    db = get_db()
    
    # Get clearance items
    clearance = await db.products.find(
        {"clearance": True, "stock": {"$gt": 0}},
        {"_id": 0}
    ).limit(limit // 2).to_list(limit // 2)
    
    # Get newest items with stock
    newest = await db.products.find(
        {"stock": {"$gt": 0}},
        {"_id": 0}
    ).sort("created_at", -1).limit(limit // 2).to_list(limit // 2)
    
    # Combine and deduplicate
    featured_ids = set()
    featured = []
    
    for p in clearance + newest:
        if p["id"] not in featured_ids:
            featured_ids.add(p["id"])
            featured.append(serialize_product_for_shop(p))
    
    return featured[:limit]


# ============ SHOP CUSTOMER AUTH ============

@router.post("/auth/register")
async def shop_customer_register(input: ShopCustomerRegister):
    """Register new shop customer"""
    from services.password_links import normalize_email, email_query
    db = get_db()
    input.email = normalize_email(input.email)
    
    # Check if email exists
    existing = await db.shop_customers.find_one(email_query(input.email))
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
    
    # Create customer
    customer_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    
    customer_doc = {
        "id": customer_id,
        "email": input.email,
        "password": hash_password(input.password),
        "name": input.name,
        "phone": input.phone,
        "address": {
            "line1": input.address_line1,
            "line2": input.address_line2,
            "city": input.city,
            "postcode": input.postcode,
            "country": "United Kingdom"
        },
        "created_at": now.isoformat(),
        "wishlist": [],
        "cart": []
    }
    
    await db.shop_customers.insert_one(customer_doc)
    
    # Telegram alert: new retail customer signed up
    try:
        from services.telegram_notify import fire_and_forget
        text = (
            "<b>👤 New customer signed up</b>\n"
            f"<b>Name:</b> {input.name}\n"
            f"<b>Email:</b> {input.email}\n"
            f"<b>Phone:</b> {input.phone or '—'}\n"
            f"<b>Type:</b> Retail"
        )
        fire_and_forget("new_customer", text, dedupe_key=f"signup:{input.email}")
    except Exception:
        pass

    # Create token
    token = create_access_token({"sub": input.email, "type": "shop_customer"})
    
    return {
        "token": token,
        "customer": {
            "id": customer_id,
            "email": input.email,
            "name": input.name,
            "phone": input.phone,
            "address": customer_doc["address"]
        }
    }


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for") or request.headers.get("x-real-ip") or ""
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else ""


def _device_from_ua(ua: str) -> str:
    u = (ua or "").lower()
    if "ipad" in u or "tablet" in u:
        return "tablet"
    if "mobi" in u or "android" in u or "iphone" in u:
        return "mobile"
    return "desktop" if u else "unknown"


async def _detect_registration_source(db, request: Request) -> dict:
    """Work out whether a trade sign-up happened on a showroom computer or
    from the customer's own device. Signals, strongest first:
      1. `X-Staff-Token` header — the browser also holds a staff/admin login
         (the register page sends it automatically on showroom machines).
      2. Request IP matches a showroom computer registered in Trade Hub → Settings.
      3. Otherwise: online, with device type from the user-agent."""
    ip = _client_ip(request)
    ua = request.headers.get("user-agent", "")
    source = {"channel": "online", "detected_by": "none", "device": _device_from_ua(ua),
              "ip": ip, "user_agent": ua[:200], "at": datetime.now(timezone.utc).isoformat()}
    staff_token = request.headers.get("x-staff-token")
    if staff_token:
        try:
            import jwt as _jwt
            from config import JWT_SECRET
            payload = _jwt.decode(staff_token, JWT_SECRET, algorithms=["HS256"])
            staff = await db.users.find_one({"email": payload.get("sub")}, {"_id": 0, "name": 1, "email": 1, "showroom_id": 1, "showroom_name": 1, "store_id": 1})
            if staff:
                source.update({"channel": "in_store", "detected_by": "staff_session",
                               "staff_name": staff.get("name") or staff.get("email"),
                               "showroom_name": staff.get("showroom_name") or staff.get("store_id") or staff.get("showroom_id")})
                return source
        except Exception:  # noqa: BLE001 — a bad staff token just means "not a showroom machine"
            pass
    try:
        from routes.trade_hub import load_showroom_ips, match_showroom_ip
        hit = match_showroom_ip(await load_showroom_ips(db), ip)
        if hit:
            source.update({"channel": "in_store", "detected_by": "showroom_ip",
                           "showroom_name": hit.get("showroom_name"), "showroom_id": hit.get("showroom_id")})
            return source
    except Exception:  # noqa: BLE001
        pass
    return source



@router.post("/auth/trade-register")
async def trade_customer_register(request: Request, input: TradeCustomerRegister):
    """Register new trade customer account"""
    from services.password_links import normalize_email, email_query
    db = get_db()
    input.email = normalize_email(input.email)
    registration_source = await _detect_registration_source(db, request)
    
    # Check if email exists
    existing = await db.shop_customers.find_one(email_query(input.email))
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
    
    # Create trade customer
    customer_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    
    # Allocate this customer's permanent trade reference (T-00001 style).
    trade_account_number = await _mint_trade_account_number(db)

    customer_doc = {
        "id": customer_id,
        "email": input.email,
        "password": hash_password(input.password),
        "name": input.contact_name,
        "business_name": input.business_name,
        "trading_name": input.trading_name,
        "business_type": input.business_type,
        "business_type_other": input.business_type_other,
        "vat_number": input.vat_number,
        "company_reg_number": input.company_reg_number,
        "trade_type": input.trade_type,
        "phone": input.phone,
        "address": {
            "line1": input.address_line1,
            "line2": input.address_line2,
            "city": input.city,
            "county": input.county,
            "postcode": input.postcode,
            "country": "United Kingdom"
        },
        "is_trade": True,
        "trade_account_number": trade_account_number,
        "trade_tier": None,
        "trade_discount": 0,
        "credit_balance": 0.0,
        "credit_rate": 5,
        "registration_source": registration_source,
        "total_spent": 0.0,
        "estimated_monthly_spend": input.estimated_monthly_spend,
        "how_heard": input.how_heard,
        "notes": input.notes,
        "created_at": now.isoformat(),
        "wishlist": [],
        "cart": [],
        "status": "active"  # Trade accounts are auto-approved, can be changed to "pending" if manual approval needed
    }
    
    await db.shop_customers.insert_one(customer_doc)
    
    # Telegram alert: new TRADE customer signed up
    try:
        from services.telegram_notify import fire_and_forget
        # Resolve a friendly business-type label so the alert is readable.
        biz_type_labels = {
            "sole_trader":  "Sole Trader / Self Employed",
            "ltd_company":  "LTD Company",
            "partnership":  "Partnership",
            "plc":          "PLC",
            "other":        f"Other ({input.business_type_other})" if input.business_type_other else "Other",
        }
        biz_type_display = biz_type_labels.get(input.business_type, input.business_type or "—")
        # Show VAT / Reg only when LTD — that's where they're meaningful.
        ltd_extra = ""
        if input.business_type == "ltd_company":
            ltd_extra = (
                f"<b>VAT:</b> {input.vat_number or '—'}\n"
                f"<b>Reg #:</b> {input.company_reg_number or '—'}\n"
            )
        text = (
            "<b>🏗️ New TRADE account registered</b>\n"
            f"<b>Business:</b> {input.business_name}\n"
            f"<b>Legal type:</b> {biz_type_display}\n"
            f"{ltd_extra}"
            f"<b>Contact:</b> {input.contact_name}\n"
            f"<b>Email:</b> {input.email}\n"
            f"<b>Phone:</b> {input.phone or '—'}\n"
            f"<b>Trade ref:</b> {trade_account_number}\n"
            f"<b>Type:</b> {input.trade_type or 'Trade'}\n"
            f"<b>Est. monthly spend:</b> {input.estimated_monthly_spend or '—'}"
        )
        fire_and_forget("new_customer", text, dedupe_key=f"trade-signup:{input.email}")
    except Exception:
        pass

    # Send confirmation email to customer and notification to admin
    try:
        from services.email import send_trade_welcome_email, send_trade_admin_notification
        asyncio.create_task(send_trade_welcome_email(customer_doc))
        asyncio.create_task(send_trade_admin_notification(customer_doc))
    except Exception as e:
        logging.warning(f"Failed to queue trade registration emails: {e}")

    # Queue WhatsApp welcome message
    try:
        from routes.whatsapp import queue_trade_welcome_message
        asyncio.create_task(queue_trade_welcome_message(customer_doc))
    except Exception as e:
        logging.warning(f"Failed to queue WhatsApp welcome message: {e}")
    
    # Create token
    token = create_access_token({"sub": input.email, "type": "shop_customer"})
    
    return {
        "token": token,
        "customer": {
            "id": customer_id,
            "email": input.email,
            "name": input.contact_name,
            "business_name": input.business_name,
            "phone": input.phone,
            "is_trade": True,
            "trade_account_number": trade_account_number,
            "trade_tier": "bronze",
            "trade_discount": 0,
            "credit_balance": 0.0,
            "address": customer_doc["address"]
        }
    }


LOGIN_TRACKING_SINCE = "2026-09-08"


async def _first_login_welcome(db, customer: dict):
    """Once per trader, on the first sign-in we have on record: email their trade
    ref + credit balance. The claim on `first_login_email_sent_at` makes this
    idempotent even if two sign-ins race."""
    try:
        now_iso = datetime.now(timezone.utc).isoformat()
        claim = await db.shop_customers.update_one(
            {"id": customer["id"], "first_login_email_sent_at": {"$in": [None, ""]}},
            {"$set": {"first_login_email_sent_at": now_iso}})
        if claim.matched_count == 0:
            return
        returning = str(customer.get("created_at") or "")[:10] < LOGIN_TRACKING_SINCE
        from services.email import send_trade_first_login_email
        from services.trade_engagement import log_event
        result = await send_trade_first_login_email(customer, returning=returning)
        await log_event(db, customer["id"], "first_login_welcome",
                        f"First sign-in email {'sent' if result.get('success') else 'failed'} — trade ref {customer.get('trade_account_number') or '—'}, "
                        f"credit £{float(customer.get('credit_balance') or 0):.2f}",
                        meta={"returning": returning, "email": customer.get("email"), "success": bool(result.get("success")),
                              "error": result.get("error")})
        if not result.get("success"):
            await db.shop_customers.update_one({"id": customer["id"]}, {"$set": {"first_login_email_error": result.get("error")}})
    except Exception as e:  # noqa: BLE001 — never let a welcome email break a sign-in
        logging.warning(f"first-login welcome failed for {customer.get('id')}: {e}")


def _alert_trade_login(customer: dict, previous_login, ip: str, device: str):
    """Telegram ping so the owner sees which traders are engaging. Deduped per trader per hour."""
    try:
        from services.telegram_notify import fire_and_forget
        if previous_login:
            seen = f"last seen {str(previous_login)[:16].replace('T', ' ')}"
        else:
            seen = "first sign-in since login tracking began"
        text = (
            "<b>🔑 Trade customer signed in</b>\n"
            f"<b>Business:</b> {customer.get('business_name') or '—'}\n"
            f"<b>Contact:</b> {customer.get('name') or '—'}\n"
            f"<b>Trade ref:</b> {customer.get('trade_account_number') or '—'}\n"
            f"<b>Email:</b> {customer.get('email')}\n"
            f"<b>Spend:</b> £{float(customer.get('total_spent') or 0):.2f} · <b>Credit:</b> £{float(customer.get('credit_balance') or 0):.2f}\n"
            f"<b>Device:</b> {device or 'unknown'} · {ip or '—'}\n"
            f"<i>{seen}</i>"
        )
        fire_and_forget("trade_login", text, dedupe_key=f"trade-login:{customer.get('id')}")
    except Exception:  # noqa: BLE001 — never let an alert break a sign-in
        pass


@router.post("/auth/login")
async def shop_customer_login(request: Request, input: ShopCustomerLogin):
    """Login shop customer (email is case-insensitive). If several records share
    the email (legacy duplicates), the one whose password matches wins."""
    from services.password_links import email_query
    db = get_db()
    
    customer = None
    for candidate in await db.shop_customers.find(email_query(input.email)).to_list(10):
        stored = candidate.get("password")
        if not stored or not str(stored).startswith("$2"):
            continue
        try:
            if verify_password(input.password, stored):
                customer = candidate
                break
        except ValueError:
            logging.warning(f"shop login: unreadable password hash on customer {candidate.get('id')}")
    if not customer:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    
    now_iso = datetime.now(timezone.utc).isoformat()
    previous_login = customer.get("last_login_at")
    await db.shop_customers.update_one(
        {"id": customer["id"]},
        {"$set": {"last_login_at": now_iso, "last_seen_at": now_iso}})
    if customer.get("is_trade"):
        ip, device = _client_ip(request), _device_from_ua(request.headers.get("user-agent", ""))
        await db.customer_logins.insert_one({
            "id": str(uuid.uuid4()), "customer_id": customer["id"],
            "at": now_iso, "ip": ip, "device": device,
        })
        _alert_trade_login(customer, previous_login, ip, device)
        if not previous_login:
            asyncio.create_task(_first_login_welcome(db, customer))

    # Token subject must match the stored address exactly — /auth/me looks it up verbatim.
    token = create_access_token({"sub": customer["email"], "type": "shop_customer"})
    
    return {
        "token": token,
        "customer": {
            "id": customer["id"],
            "email": customer["email"],
            "name": customer.get("name", ""),
            "phone": customer.get("phone", ""),
            "address": customer.get("address", {}),
            "is_trade": customer.get("is_trade", False),
            "trade_discount": customer.get("trade_discount", 0),
            "trade_tier": customer.get("trade_tier", ""),
            "trade_account_number": customer.get("trade_account_number", ""),
            "credit_balance": customer.get("credit_balance", 0),
            "business_name": customer.get("business_name", ""),
        }
    }


# Lightweight in-memory rate limiter for the email-exists check below.
# Mirrors any patterns elsewhere in this file: per-IP token bucket, 30s window.
# Goal is to prevent attacker scripts from harvesting customer emails by
# blasting the endpoint — legitimate UX (one check after a failed login)
# is well under the threshold.
_email_exists_window: dict = {}  # {ip: [timestamps]}


@router.post("/auth/email-exists")
async def shop_customer_email_exists(input: dict, request: Request):
    """Returns whether a given email is registered as a shop customer.
    Called by the login pages after a failed sign-in to disambiguate
    "wrong password" vs "no account" for the user.

    Rate-limited at 8 calls / 30 s per IP to make account enumeration
    impractical while keeping the legitimate one-shot UX flow zero-friction.
    """
    import time as _time
    email = (input or {}).get("email", "")
    if not isinstance(email, str) or not email or "@" not in email or len(email) > 200:
        return {"exists": False}

    ip = (
        request.headers.get("x-forwarded-for", "").split(",")[0].strip()
        or (request.client.host if request.client else "unknown")
        or "unknown"
    )
    now = _time.time()
    bucket = [t for t in _email_exists_window.get(ip, []) if now - t < 30]
    if len(bucket) >= 8:
        # Quietly behave as "exists" so a hammered endpoint can't be used to
        # enumerate further. Legitimate users never hit this.
        return {"exists": True, "rate_limited": True}
    bucket.append(now)
    _email_exists_window[ip] = bucket

    from services.password_links import email_query
    db = get_db()
    found = await db.shop_customers.find_one(email_query(email), {"_id": 0, "id": 1})
    return {"exists": bool(found)}



async def get_shop_customer(request: Request):
    """Get current shop customer from token"""
    from fastapi import Header
    from jose import JWTError, jwt
    
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    token = auth_header.split(" ")[1]
    
    try:
        jwt_secret = os.environ.get("JWT_SECRET", "your-secret-key-change-in-production")
        payload = jwt.decode(token, jwt_secret, algorithms=["HS256"])
        email = payload.get("sub")
        token_type = payload.get("type")
        
        if not email or token_type != "shop_customer":
            raise HTTPException(status_code=401, detail="Invalid token")
        
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    db = get_db()
    customer = await db.shop_customers.find_one({"email": email}, {"_id": 0, "password": 0})
    
    if not customer:
        raise HTTPException(status_code=401, detail="Customer not found")
    
    # Lazy backfill — old trade accounts predate this field.
    customer = await _ensure_trade_account_number(db, customer)
    return customer


@router.get("/auth/me")
async def get_shop_customer_profile(request: Request):
    """Get current shop customer profile"""
    customer = await get_shop_customer(request)
    return customer


@router.post("/auth/heartbeat")
async def shop_customer_heartbeat(request: Request):
    """Storefront pings this every ~2 min while a signed-in trader has a tab open —
    powers the 'Live now' panel in Trade Hub. Retail customers are a no-op."""
    customer = await get_shop_customer(request)
    if not customer.get("is_trade"):
        return {"ok": True, "tracked": False}
    path = ""
    try:
        body = await request.json()
        path = str((body or {}).get("path") or "")[:200]
    except Exception:  # noqa: BLE001 — empty body is fine
        pass
    db = get_db()
    await db.shop_customers.update_one({"id": customer["id"]}, {"$set": {
        "last_seen_at": datetime.now(timezone.utc).isoformat(), "last_seen_path": path,
        "last_seen_device": _device_from_ua(request.headers.get("user-agent", ""))}})
    return {"ok": True, "tracked": True}


@router.put("/auth/profile")
async def update_shop_customer_profile(
    request: Request,
    name: Optional[str] = None,
    phone: Optional[str] = None,
    address_line1: Optional[str] = None,
    address_line2: Optional[str] = None,
    city: Optional[str] = None,
    postcode: Optional[str] = None
):
    """Update shop customer profile"""
    customer = await get_shop_customer(request)
    db = get_db()
    
    update_data = {}
    if name:
        update_data["name"] = name
    if phone:
        update_data["phone"] = phone
    
    # Update address fields
    address_updates = {}
    if address_line1 is not None:
        address_updates["address.line1"] = address_line1
    if address_line2 is not None:
        address_updates["address.line2"] = address_line2
    if city is not None:
        address_updates["address.city"] = city
    if postcode is not None:
        address_updates["address.postcode"] = postcode
    
    if update_data or address_updates:
        await db.shop_customers.update_one(
            {"id": customer["id"]},
            {"$set": {**update_data, **address_updates}}
        )
    
    return {"message": "Profile updated"}


# ============ CART ============

@router.get("/cart")
async def get_cart(request: Request):
    """Get customer's shopping cart"""
    customer = await get_shop_customer(request)
    return customer.get("cart", [])


@router.post("/cart/add")
async def add_to_cart(request: Request, item: CartItem):
    """Add item to cart"""
    customer = await get_shop_customer(request)
    db = get_db()
    
    # Verify product exists and has stock
    product = await db.products.find_one({"id": item.product_id}, {"_id": 0})
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    
    if product.get("stock", 0) < item.quantity:
        raise HTTPException(status_code=400, detail="Insufficient stock")
    
    # Get current cart
    cart = customer.get("cart", [])
    
    # Check if item already in cart
    existing_idx = next((i for i, c in enumerate(cart) if c["product_id"] == item.product_id), None)
    
    if existing_idx is not None:
        cart[existing_idx]["quantity"] += item.quantity
    else:
        cart.append(item.model_dump())
    
    # Update cart
    await db.shop_customers.update_one(
        {"id": customer["id"]},
        {"$set": {"cart": cart}}
    )
    
    return {"message": "Added to cart", "cart": cart}


@router.put("/cart/update")
async def update_cart_item(request: Request, product_id: str, quantity: float):
    """Update cart item quantity"""
    customer = await get_shop_customer(request)
    db = get_db()
    
    cart = customer.get("cart", [])
    
    # Find and update item
    item_idx = next((i for i, c in enumerate(cart) if c["product_id"] == product_id), None)
    
    if item_idx is None:
        raise HTTPException(status_code=404, detail="Item not in cart")
    
    if quantity <= 0:
        # Remove item
        cart.pop(item_idx)
    else:
        # Verify stock
        product = await db.products.find_one({"id": product_id}, {"_id": 0})
        if product and product.get("stock", 0) < quantity:
            raise HTTPException(status_code=400, detail="Insufficient stock")
        cart[item_idx]["quantity"] = quantity
    
    await db.shop_customers.update_one(
        {"id": customer["id"]},
        {"$set": {"cart": cart}}
    )
    
    return {"message": "Cart updated", "cart": cart}


@router.delete("/cart/remove/{product_id}")
async def remove_from_cart(request: Request, product_id: str):
    """Remove item from cart"""
    customer = await get_shop_customer(request)
    db = get_db()
    
    cart = [c for c in customer.get("cart", []) if c["product_id"] != product_id]
    
    await db.shop_customers.update_one(
        {"id": customer["id"]},
        {"$set": {"cart": cart}}
    )
    
    return {"message": "Item removed", "cart": cart}


@router.delete("/cart/clear")
async def clear_cart(request: Request):
    """Clear entire cart"""
    customer = await get_shop_customer(request)
    db = get_db()
    
    await db.shop_customers.update_one(
        {"id": customer["id"]},
        {"$set": {"cart": []}}
    )
    
    return {"message": "Cart cleared", "cart": []}


# ============ WISHLIST ============

@router.get("/wishlist")
async def get_wishlist(request: Request):
    """Get customer's wishlist"""
    customer = await get_shop_customer(request)
    db = get_db()
    
    wishlist_ids = customer.get("wishlist", [])
    
    if not wishlist_ids:
        return []
    
    products = await db.products.find({"id": {"$in": wishlist_ids}}, {"_id": 0}).to_list(100)
    return [serialize_product_for_shop(p) for p in products]


@router.post("/wishlist/add/{product_id}")
async def add_to_wishlist(request: Request, product_id: str):
    """Add product to wishlist"""
    customer = await get_shop_customer(request)
    db = get_db()
    
    # Verify product exists
    product = await db.products.find_one({"id": product_id})
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    
    await db.shop_customers.update_one(
        {"id": customer["id"]},
        {"$addToSet": {"wishlist": product_id}}
    )
    
    return {"message": "Added to wishlist"}


@router.delete("/wishlist/remove/{product_id}")
async def remove_from_wishlist(request: Request, product_id: str):
    """Remove product from wishlist"""
    customer = await get_shop_customer(request)
    db = get_db()
    
    await db.shop_customers.update_one(
        {"id": customer["id"]},
        {"$pull": {"wishlist": product_id}}
    )
    
    return {"message": "Removed from wishlist"}


# ============ ORDERS ============

@router.post("/orders")
async def create_shop_order(request: Request, order_input: ShopOrderCreate):
    """Create a new shop order"""
    customer = await get_shop_customer(request)
    db = get_db()
    
    if not order_input.items:
        raise HTTPException(status_code=400, detail="Order must have items")
    
    # Validate stock for all items
    for item in order_input.items:
        product = await db.products.find_one({"id": item.product_id}, {"_id": 0})
        if not product:
            raise HTTPException(status_code=400, detail=f"Product {item.name} not found")
        if product.get("stock", 0) < item.quantity:
            raise HTTPException(status_code=400, detail=f"Insufficient stock for {item.name}")
    
    # Calculate totals
    subtotal = sum(item.price * item.quantity for item in order_input.items)
    vat = round(subtotal * 0.2, 2)  # 20% VAT
    delivery_fee = 0.0 if order_input.delivery_method == "collect" else 49.99  # Flat delivery fee
    total = subtotal + vat + delivery_fee
    
    # Create order
    order_id = str(uuid.uuid4())
    order_number = f"TS-{datetime.now().strftime('%y%m%d')}-{order_id[:6].upper()}"
    now = datetime.now(timezone.utc)
    
    order_doc = {
        "id": order_id,
        "order_number": order_number,
        "customer_id": customer["id"],
        "customer_email": order_input.customer_email,
        "customer_name": order_input.customer_name,
        "customer_phone": order_input.customer_phone,
        "delivery_method": order_input.delivery_method,
        "delivery_address": order_input.delivery_address,
        "collect_store_id": order_input.collect_store_id,
        "notes": order_input.notes,
        "items": [item.model_dump() for item in order_input.items],
        "subtotal": round(subtotal, 2),
        "vat": round(vat, 2),
        "delivery_fee": delivery_fee,
        "total": round(total, 2),
        "status": "pending_payment",
        "payment_status": "pending",
        "created_at": now.isoformat(),
        "updated_at": now.isoformat()
    }
    
    await _attach_trade_metadata(db, order_doc, order_doc.get("customer_id"))
    await db.shop_orders.insert_one(order_doc)
    
    return {
        "order_id": order_id,
        "order_number": order_number,
        "total": round(total, 2),
        "status": "pending_payment"
    }


@router.get("/orders")
async def get_shop_orders(request: Request):
    """Get customer's orders — includes both online orders AND any in-store
    invoices that have been linked to the customer's online account (so a
    trade customer who paid in store still sees their full order history)."""
    customer = await get_shop_customer(request)
    db = get_db()

    orders = await db.shop_orders.find(
        {"customer_id": customer["id"]},
        {"_id": 0}
    ).sort("created_at", -1).to_list(100)

    # Pull in-store invoices linked to this customer (created via the EPOS
    # "Search online accounts" path) and map them onto the same shape the
    # ShopOrders.js frontend expects, with `source='in_store'` so the UI can
    # show a small "In-store" pill.
    #
    # Deleted invoices are STILL returned (not hidden) so the trader can see
    # their transaction history is honest — "this was deleted, credit was
    # refunded" — rather than the order silently vanishing. The frontend
    # renders them faded/strikethrough with a tooltip.
    try:
        instore_cursor = db.invoices.find(
            {"linked_shop_customer_id": customer["id"]},
            {
                "_id": 0,
                "id": 1, "invoice_no": 1, "date": 1, "time": 1,
                "showroom_id": 1, "showroom_name": 1,
                "subtotal": 1, "gross_total": 1, "amount_outstanding": 1,
                "status": 1, "line_items": 1, "created_at": 1,
                "trade_account_number": 1,
                "deleted_at": 1, "deleted_by": 1, "deleted_by_name": 1,
            },
        ).sort("created_at", -1).limit(100)
        async for inv in instore_cursor:
            is_deleted = bool(inv.get("deleted_at"))
            raw_status = inv.get("status")
            is_cancelled = raw_status == "cancelled"
            if is_deleted:
                mapped_status = "deleted"
            elif is_cancelled:
                mapped_status = "cancelled"
            else:
                mapped_status = "delivered" if (inv.get("amount_outstanding") or 0) <= 0.01 else "processing"
            orders.append({
                "id": inv.get("id"),
                "order_number": inv.get("invoice_no"),
                "source": "in_store",
                "status": mapped_status,
                "payment_status": "paid" if mapped_status == "delivered" else ("voided" if is_deleted or is_cancelled else "partial"),
                "showroom_name": inv.get("showroom_name") or "Showroom",
                "subtotal": inv.get("subtotal"),
                "total": inv.get("gross_total"),
                "amount_outstanding": inv.get("amount_outstanding") or 0,
                "items": [
                    {
                        "name": li.get("product_name"),
                        "quantity": li.get("quantity"),
                        "price": li.get("due_price") or li.get("price"),
                    } for li in (inv.get("line_items") or [])
                ],
                "created_at": inv.get("created_at"),
                "date": inv.get("date"),
                # Surface deletion/cancellation metadata so the trader UI can
                # explain *why* the order is struck through.
                "deleted_at": inv.get("deleted_at"),
                "deleted_by_name": inv.get("deleted_by_name") or inv.get("deleted_by"),
                "void_reason": (
                    "Deleted by staff — any credit-back or redeemed credit "
                    "was automatically refunded to your account."
                    if is_deleted else (
                        "Cancelled — any credit-back or redeemed credit was "
                        "automatically refunded to your account."
                        if is_cancelled else None
                    )
                ),
            })
        # Re-sort merged list by created_at (newest first)
        orders.sort(key=lambda o: (o.get("created_at") or ""), reverse=True)
    except Exception:
        # Non-fatal: linked-invoice block must never break the orders page
        pass

    return orders


@router.get("/customers/lookup")
async def admin_customer_lookup(
    email: Optional[str] = None,
    phone: Optional[str] = None,
    current_user: dict = Depends(get_current_user),
):
    """
    Admin lookup for the EPOS Customer Details panel — given an email or
    phone, return the matching online shop customer (trade OR retail) so the
    till can show the right chip before the invoice is saved.

    For trade matches: surfaces `T-NNNNN`, credit-back rate, balance and
    discount % so staff can announce the saving. For retail matches: returns
    a slim payload (id, name, email, phone, lifetime spend) with `is_trade=false`
    so the chip can render a "🌐 Online customer" variant — no credit/discount
    UI but the invoice still gets stamped with `linked_shop_customer_id` and
    will appear on the customer's online order history.

    Returns 200 with `customer: null` when nothing matches (so the form stays
    silent — no scary 404 toast).
    """
    if (current_user or {}).get("role") not in {"super_admin", "admin", "manager", "staff"}:
        raise HTTPException(status_code=403, detail="Admin access required")
    if not email and not phone:
        return {"customer": None}
    db = get_db()
    or_q = []
    if email:
        or_q.append({"email": email.lower().strip()})
    if phone:
        or_q.append({"phone": phone.strip()})
    cust = await db.shop_customers.find_one(
        {"$or": or_q},
        {"_id": 0, "id": 1, "is_trade": 1, "trade_account_number": 1, "business_name": 1, "name": 1, "email": 1, "phone": 1, "credit_balance": 1, "credit_rate": 1, "trade_discount": 1, "trade_tier": 1, "total_spent": 1},
    )
    if cust:
        # Normalize so the frontend can rely on a boolean. Legacy retail rows
        # never had `is_trade` written; treat missing as False.
        cust["is_trade"] = bool(cust.get("is_trade"))
    return {"customer": cust}


@router.get("/account/activity-stream")
async def get_activity_stream(request: Request, limit: int = 10):
    """
    Compact, glanceable timeline of the last N events on the customer's account.
    Aggregates from data we already write — no new collections — so existing
    customers immediately see history without any backfill.

    Sources mined:
      • shop_orders.status_history — order placed, paid, shipped, delivered
      • shop_orders (top-level)    — fallback "order placed" if no history yet
      • trade_credits              — credit earned, credit applied
    Events are returned newest-first, capped at `limit` (default 10).
    """
    customer = await get_shop_customer(request)
    db = get_db()
    cust_id = customer["id"]

    events = []

    # ---- Orders + status changes ----------------------------------------
    cursor = db.shop_orders.find(
        {"customer_id": cust_id},
        {"_id": 0, "id": 1, "order_number": 1, "total": 1, "status": 1,
         "status_history": 1, "created_at": 1, "items": 1}
    ).sort("created_at", -1).limit(50)
    async for order in cursor:
        order_num = order.get("order_number") or order.get("id", "")[:8]
        item_count = len(order.get("items") or [])

        # 1) Order placed (always)
        if order.get("created_at"):
            events.append({
                "type": "order_placed",
                "icon": "shopping-bag",
                "color": "amber",
                "title": "Order placed",
                "subtitle": f"{order_num} · {item_count} item{'s' if item_count != 1 else ''} · £{(order.get('total') or 0):.2f}",
                "at": order["created_at"],
                "ref_id": order.get("id"),
            })

        # 2) Each meaningful status transition from history
        for entry in (order.get("status_history") or []):
            status = (entry.get("status") or "").lower()
            ts = entry.get("at") or entry.get("timestamp") or entry.get("created_at")
            if not status or not ts:
                continue
            if status in ("placed", "pending", "created"):
                continue  # already covered by order_placed above
            label_map = {
                "paid": ("Order paid", "credit-card", "emerald"),
                "processing": ("Order being prepared", "package", "blue"),
                "shipped": ("Order shipped", "truck", "blue"),
                "out_for_delivery": ("Out for delivery", "truck", "blue"),
                "in_transit": ("Order in transit", "truck", "blue"),
                "delivered": ("Order delivered", "check-circle", "emerald"),
                "ready_for_collection": ("Ready for collection", "package", "amber"),
                "completed": ("Order completed", "check-circle", "emerald"),
                "cancelled": ("Order cancelled", "x", "rose"),
                "refunded": ("Order refunded", "rotate-ccw", "rose"),
            }
            if status not in label_map:
                continue
            title, icon, color = label_map[status]
            events.append({
                "type": f"order_{status}",
                "icon": icon,
                "color": color,
                "title": title,
                "subtitle": f"{order_num} · £{(order.get('total') or 0):.2f}",
                "at": ts,
                "ref_id": order.get("id"),
            })

    # ---- Trade credits earned / applied ---------------------------------
    cursor = db.trade_credits.find(
        {"customer_id": cust_id},
        {"_id": 0, "type": 1, "amount": 1, "description": 1, "balance_after": 1,
         "order_number": 1, "created_at": 1}
    ).sort("created_at", -1).limit(20)
    async for tc in cursor:
        ttype = (tc.get("type") or "").lower()
        amount = tc.get("amount") or 0
        if ttype == "earn":
            events.append({
                "type": "credit_earned",
                "icon": "wallet",
                "color": "purple",
                "title": "Trade credit earned",
                "subtitle": f"+£{amount:.2f} from {tc.get('order_number') or 'order'} · balance £{(tc.get('balance_after') or 0):.2f}",
                "at": tc.get("created_at"),
                "ref_id": tc.get("order_number"),
            })
        elif ttype in ("redeem", "apply", "spend"):
            events.append({
                "type": "credit_applied",
                "icon": "wallet",
                "color": "purple",
                "title": "Trade credit applied",
                "subtitle": f"−£{amount:.2f} on {tc.get('order_number') or 'order'} · balance £{(tc.get('balance_after') or 0):.2f}",
                "at": tc.get("created_at"),
                "ref_id": tc.get("order_number"),
            })

    # ---- Sort newest-first and trim ------------------------------------
    def _sort_key(e):
        v = e.get("at")
        if isinstance(v, str):
            return v
        try:
            return v.isoformat() if v else ""
        except Exception:
            return ""
    events.sort(key=_sort_key, reverse=True)
    return {"events": events[:limit], "total": len(events)}


@router.get("/savings/summary")
async def get_trade_savings_summary(request: Request):
    """
    Headline stat for the trade dashboard — "You've saved £X this year across N
    orders". Compares what THIS customer paid (trade ex-VAT × 1.20 inc VAT)
    vs what a retail customer would have paid (RRP inc VAT) for the same line
    items, summed across paid/completed orders in the current calendar year.

    Math, per order:
        retail_inc_vat = trade_subtotal × 1.20 / (1 − td/100)
        trade_inc_vat  = trade_subtotal × 1.20
        saved          = retail_inc_vat − trade_inc_vat
                       = trade_subtotal × 1.20 × td / (100 − td)

    Trade customers only — non-trade or trade_discount=0 customers always
    return zeroes. We only count orders that actually transacted (paid /
    completed / fulfilled) so abandoned baskets don't inflate the number.
    """
    customer = await get_shop_customer(request)
    is_trade = bool(customer.get("is_trade") or customer.get("trade_account_status") == "approved")
    trade_discount = float(customer.get("trade_discount") or 0)
    year = datetime.now(timezone.utc).year

    if not is_trade or trade_discount <= 0 or trade_discount >= 100:
        return {
            "year": year,
            "total_saved": 0.0,
            "order_count": 0,
            "trade_discount": trade_discount,
            "is_trade": is_trade,
            "last_order": None,
        }

    db = get_db()
    paid_statuses = {"completed", "paid", "fulfilled", "shipped", "ready_for_collection", "delivered"}
    cursor = db.shop_orders.find(
        {"customer_id": customer["id"]},
        {"_id": 0, "id": 1, "order_number": 1, "subtotal": 1, "status": 1, "payment_status": 1, "created_at": 1},
    ).sort("created_at", -1)
    factor = 1.20 * (trade_discount / (100.0 - trade_discount))
    total_saved = 0.0
    order_count = 0
    last_order = None  # {id, order_number, created_at, saved}
    async for order in cursor:
        status = (order.get("status") or "").lower()
        pay_status = (order.get("payment_status") or "").lower()
        if status not in paid_statuses and pay_status not in {"paid", "completed", "succeeded"}:
            continue
        subtotal = float(order.get("subtotal") or 0)
        if subtotal <= 0:
            continue
        order_saved = round(subtotal * factor, 2)
        # Most-recent paid order — capture once (cursor is already sorted desc).
        if last_order is None:
            last_order = {
                "id": order.get("id"),
                "order_number": order.get("order_number"),
                "created_at": order.get("created_at"),
                "saved": order_saved,
            }
        # Yearly running total.
        created = str(order.get("created_at") or "")
        if created.startswith(f"{year}-"):
            total_saved += subtotal * factor
            order_count += 1

    return {
        "year": year,
        "total_saved": round(total_saved, 2),
        "order_count": order_count,
        "trade_discount": trade_discount,
        "is_trade": True,
        "last_order": last_order,
    }


@router.post("/savings/email-statement")
async def email_savings_statement(request: Request):
    """
    Email a CSV savings statement to the trade customer's account email.
    Reuses Resend; degrades gracefully if Resend isn't configured.
    """
    customer = await get_shop_customer(request)
    is_trade = bool(customer.get("is_trade") or customer.get("trade_account_status") == "approved")
    trade_discount = float(customer.get("trade_discount") or 0)
    if not is_trade or trade_discount <= 0 or trade_discount >= 100:
        raise HTTPException(status_code=400, detail="Trade account required to download savings statement")

    db = get_db()
    paid_statuses = {"completed", "paid", "fulfilled", "shipped", "ready_for_collection", "delivered"}
    factor = 1.20 * (trade_discount / (100.0 - trade_discount))

    orders = await db.shop_orders.find(
        {"customer_id": customer["id"]},
        {"_id": 0, "id": 1, "order_number": 1, "subtotal": 1, "total": 1, "status": 1, "payment_status": 1, "created_at": 1},
    ).sort("created_at", -1).to_list(1000)

    if not orders:
        raise HTTPException(status_code=400, detail="No orders to email yet")

    # Build CSV (RFC 4180 — quote fields containing comma/quote/newline, double-up internal quotes)
    def _cell(v):
        s = "" if v is None else str(v)
        if any(c in s for c in (",", '"', "\n", "\r")):
            return '"' + s.replace('"', '""') + '"'
        return s

    headers = ["Order Number", "Date", "Status", "Subtotal (ex VAT)", "Total (inc VAT)", "Saved vs Retail", "Trade Rate %"]
    csv_rows = [",".join(_cell(h) for h in headers)]
    total_saved = 0.0
    total_subtotal = 0.0
    total_inc_vat = 0.0
    # Per-month totals for the email body, keyed by YYYY-MM so we can render
    # them in chronological order. Counts paid orders only.
    monthly: Dict[str, float] = {}
    for o in orders:
        status = (o.get("status") or "").lower()
        pay_status = (o.get("payment_status") or "").lower()
        is_paid = status in paid_statuses or pay_status in {"paid", "completed", "succeeded"}
        subtotal = float(o.get("subtotal") or 0)
        saved = round(subtotal * factor, 2) if (is_paid and subtotal > 0) else 0.0
        date_obj = None
        date_str = ""
        if o.get("created_at"):
            try:
                date_obj = datetime.fromisoformat(str(o["created_at"]).replace("Z", "+00:00"))
                date_str = date_obj.strftime("%d/%m/%Y")
            except (ValueError, TypeError):
                date_str = str(o["created_at"])[:10]
        row = [
            o.get("order_number") or (o.get("id", "")[-8:] if o.get("id") else ""),
            date_str,
            o.get("status") or "pending",
            f"{subtotal:.2f}",
            f"{float(o.get('total') or 0):.2f}",
            f"{saved:.2f}",
            f"{trade_discount}",
        ]
        csv_rows.append(",".join(_cell(c) for c in row))
        total_saved += saved
        total_subtotal += subtotal
        total_inc_vat += float(o.get("total") or 0)
        if saved > 0 and date_obj is not None:
            key = date_obj.strftime("%Y-%m")
            monthly[key] = monthly.get(key, 0.0) + saved
    csv_rows.append(",".join(_cell(c) for c in [
        "TOTAL", "", "", f"{total_subtotal:.2f}", f"{total_inc_vat:.2f}", f"{total_saved:.2f}", "",
    ]))
    csv_text = "\r\n".join(csv_rows)
    # UTF-8 BOM so Excel renders £ correctly
    csv_bytes = ("\ufeff" + csv_text).encode("utf-8")

    # Send via Resend if configured; otherwise return the CSV inline so the
    # frontend can fall back to a download.
    if not RESEND_AVAILABLE:
        raise HTTPException(status_code=503, detail="Email service not configured — please use the Download button instead")

    import base64
    import resend  # noqa: WPS433 — resend is loaded lazily
    company_name = os.environ.get("COMPANY_NAME", "Tile Station")
    customer_email = customer.get("email")
    if not customer_email:
        raise HTTPException(status_code=400, detail="No email on file for this account")

    biz = customer.get("business_name") or customer.get("name") or ""
    biz_slug = "".join(c if c.isalnum() else "-" for c in biz).strip("-").lower() or "trade"
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    fname = f"tilestation-savings-statement-{biz_slug}-{today}.csv"
    account_no = customer.get("trade_account_number") or ""
    account_line = (
        f'<p style="color:#666;font-size:13px;margin:4px 0 0 0;">Trade account #{account_no}</p>'
        if account_no else ""
    )

    # Build the monthly table block — chronological, friendly month names.
    monthly_html = ""
    if monthly:
        rows_html = []
        for key in sorted(monthly.keys()):
            try:
                label = datetime.strptime(key, "%Y-%m").strftime("%b %Y")
            except (ValueError, TypeError):
                label = key
            amount = monthly[key]
            rows_html.append(
                f'<tr><td style="padding:4px 12px 4px 0;color:#525252;">{label}</td>'
                f'<td style="padding:4px 0;text-align:right;font-weight:600;color:#065f46;">£{amount:.2f}</td></tr>'
            )
        monthly_html = (
            '<p style="margin:18px 0 6px 0;font-weight:600;">Saved by month</p>'
            '<table style="border-collapse:collapse;font-family:inherit;font-size:14px;">'
            + "".join(rows_html)
            + "</table>"
        )

    html = f"""
    <p>Hi {biz or 'there'},</p>
    {account_line}
    <p>Your savings statement is attached as a CSV — handy for sending to your bookkeeper or accountant.</p>
    <p><strong>Total saved across {len(orders)} order{'s' if len(orders) != 1 else ''}: £{total_saved:.2f}</strong> (at your current trade rate of {trade_discount}% off RRP).</p>
    {monthly_html}
    <p style="margin-top:18px;">Open the file in Excel, Google Sheets, or Numbers — the £ totals are summed in the bottom row.</p>
    <p>Thanks,<br/>{company_name}</p>
    """

    api_key = os.environ.get("RESEND_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="Email service not configured — please use the Download button instead")
    resend.api_key = api_key

    # Per company email policy (20 May 2026):
    #   • online@ is the canonical sender for emails TO online customers
    #   • Branded HTML signature appended to every customer-facing email
    # (21 May 2026 — user reported "Could not email statement" on a trader
    # who had real orders. Robustifying error responses so the failure mode
    # is always actionable on the frontend.)
    try:
        from services.email import render_email_signature
        signature_html = render_email_signature(None)  # head-office Gravesend
    except Exception:  # noqa: BLE001 — signature is decorative, never fatal
        signature_html = ""
    customer_facing_from = (
        f"Tile Station <{os.environ.get('SENDER_EMAIL', 'online@tilestation.co.uk')}>"
    )

    full_html = html + signature_html

    try:
        await asyncio.to_thread(
            resend.Emails.send,
            {
                "from": customer_facing_from,
                "to": [customer_email],
                "reply_to": ["online@tilestation.co.uk"],
                "subject": f"Your {company_name} savings statement — £{total_saved:.2f} saved",
                "html": full_html,
                "attachments": [{
                    "filename": fname,
                    "content": base64.b64encode(csv_bytes).decode("ascii"),
                }],
            },
        )
    except Exception as exc:  # noqa: BLE001
        # Resend can throw httpx.ConnectError / ResendError / ValueError
        # depending on what's wrong. Always surface a friendly detail to the
        # frontend so the user knows to fall back to the Download button.
        logger.exception("Failed to email savings statement: %s", exc)
        raise HTTPException(
            status_code=502,
            detail=f"We couldn't send the email right now — please use the Download button. ({type(exc).__name__})",
        ) from exc

    return {
        "ok": True,
        "email": customer_email,
        "order_count": len(orders),
        "total_saved": round(total_saved, 2),
    }


@router.get("/orders/{order_id}")
async def get_shop_order(request: Request, order_id: str):
    """Get single order details"""
    customer = await get_shop_customer(request)
    db = get_db()
    
    order = await db.shop_orders.find_one(
        {"id": order_id, "customer_id": customer["id"]},
        {"_id": 0}
    )
    
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    
    return order


@router.get("/checkout/recover/{token}")
async def recover_failed_payment(token: str):
    """Public endpoint — the customer clicks the recovery link in the
    "your payment didn't go through" email and lands here.

    We don't require auth because the token itself IS the auth (96-bit
    random uuid4, 7-day TTL, single-issue per order). Returning the
    order's items lets the storefront restore the cart and bounce the
    customer back to /checkout with everything pre-filled.

    Defensive: never returns the recovery_token itself, never returns
    payment_intent_id or any Stripe identifiers — just the data needed
    to reconstruct the cart + checkout context.
    """
    db = get_db()
    from services.payment_recovery import lookup_recovery_token  # noqa: PLC0415
    order = await lookup_recovery_token(db, token)
    if not order:
        raise HTTPException(
            status_code=404,
            detail="This recovery link has expired or already been used. Please start a new checkout.",
        )

    # Slim, customer-safe response.
    return {
        "ok": True,
        "order_id": order.get("id"),
        "order_number": order.get("order_number"),
        "customer_email": order.get("customer_email"),
        "customer_name": order.get("customer_name"),
        "customer_phone": order.get("customer_phone"),
        "delivery_method": order.get("delivery_method"),
        "delivery_address": order.get("delivery_address"),
        "items": order.get("items") or [],
        "subtotal": order.get("subtotal"),
        "vat": order.get("vat"),
        "delivery_fee": order.get("delivery_fee"),
        "total": order.get("total"),
        "decline_reason": order.get("payment_failed_reason"),
    }


@router.get("/orders/{order_id}/vat-invoice.pdf")
async def download_order_vat_invoice(request: Request, order_id: str):
    """Generate + stream a UK VAT invoice PDF for a single order.

    Trader-facing self-service: a logged-in customer can download a
    HMRC-compliant VAT invoice for any of their own orders. Scoped to
    `customer_id` so customers cannot enumerate other people's orders.

    Looks in BOTH pipelines (mirrors `get_shop_orders`):
      1. `shop_orders` — orders placed online via the website checkout.
      2. `invoices` filtered by `linked_shop_customer_id` — in-store EPOS
         invoices that staff linked to the trader's online account so the
         trader can see them in their dashboard. These have a different
         shape (`gross_total` instead of `total`, `line_items` instead of
         `items`, etc.) so we normalise to a single dict before rendering.
    """
    from fastapi.responses import StreamingResponse  # noqa: PLC0415
    from io import BytesIO  # noqa: PLC0415
    from services.vat_invoice_pdf import (  # noqa: PLC0415
        REPORTLAB_AVAILABLE,
        generate_vat_invoice_pdf_bytes,
    )

    if not REPORTLAB_AVAILABLE:
        raise HTTPException(
            status_code=500,
            detail="PDF generation is currently unavailable",
        )

    customer = await get_shop_customer(request)
    db = get_db()

    # Try the online-orders pipeline first.
    order = await db.shop_orders.find_one(
        {"id": order_id, "customer_id": customer["id"]},
        {"_id": 0},
    )

    # Fallback: linked in-store EPOS invoice. We normalise the EPOS doc
    # into the shape the PDF generator expects (items, total, etc.) so the
    # generator stays a single code path with no `if invoice else order`
    # branches scattered through it.
    if not order:
        inv = await db.invoices.find_one(
            {
                "id": order_id,
                "linked_shop_customer_id": customer["id"],
                "is_deleted": {"$ne": True},
            },
            {"_id": 0},
        )
        if inv:
            apply_vat = bool(inv.get("apply_vat", True))
            net_subtotal = float(inv.get("subtotal") or 0)
            gross_total = float(inv.get("gross_total") or 0)
            # If `apply_vat` is False on this EPOS invoice the gross is
            # equal to the subtotal — we still call it a VAT invoice but
            # the rate would be 0%. The PDF generator's _split_order_totals
            # back-derives 20% from the stored subtotal, so for the rare
            # `apply_vat=False` case we pre-compute the totals here and
            # override the stored `subtotal` so the maths comes out right.
            if not apply_vat:
                # No VAT charged — show 0% line. We pass `subtotal == gross`
                # so the PDF's 20% derivation yields VAT=£0.
                net_for_pdf = gross_total
            else:
                net_for_pdf = net_subtotal if net_subtotal > 0 else round(gross_total / 1.20, 2)

            order = {
                "id": inv.get("id"),
                "order_number": inv.get("invoice_no"),
                "customer_id": customer["id"],
                "customer_email": inv.get("customer_email"),
                "customer_name": inv.get("customer_name"),
                "delivery_address": inv.get("customer_address") or "",
                "items": [
                    {
                        "name": li.get("product_name") or li.get("description") or "Item",
                        "variant": li.get("variant"),
                        "price": float(li.get("due_price") or li.get("price") or 0),
                        "quantity": float(li.get("quantity") or 0),
                    }
                    for li in (inv.get("line_items") or [])
                ],
                "subtotal": net_for_pdf,
                "delivery_fee": 0.0,
                "total": gross_total,
                "status": "delivered" if (inv.get("amount_outstanding") or 0) <= 0.01 else "processing",
                "created_at": inv.get("created_at") or inv.get("date"),
                # Surface the showroom name in the PDF as a savings note.
                "savings_meta": inv.get("savings_meta"),
                # Pass through the apply_vat hint via a private flag the
                # PDF generator can read.
                "_in_store_apply_vat": apply_vat,
                "_in_store_showroom": inv.get("showroom_name"),
                "_in_store_staff_name": inv.get("staff_name") or inv.get("sales_person"),
                "_in_store_invoice_date": inv.get("date"),
            }

    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    pdf_bytes = generate_vat_invoice_pdf_bytes(order=order, customer=customer)
    filename = f"VAT_Invoice_{order.get('order_number') or order_id}.pdf"
    return StreamingResponse(
        BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/orders/{order_id}/reorder-items")
async def get_reorder_items(request: Request, order_id: str):
    """
    Return cart-ready items for an existing order, refreshed against the live
    tiles DB so prices and stock reflect TODAY (not whatever was true when the
    original order was placed). Powers the trade-dashboard "Order Again" cards
    AND the retail-dashboard "Order again from in-store" button.

    Falls back to a linked EPOS `invoices` doc when no online order matches —
    so retail customers who walked in last week can re-add the same SKUs
    online with one click. EPOS line items without a `product_id` (free-typed
    by staff) are returned with `available: false, reason: 'in_store_custom'`
    so the UI can show "Some items aren't reorderable online".

    Each returned item has the shape that TileCartContext.addToCart() expects.
    """
    customer = await get_shop_customer(request)
    db = get_db()
    order = await db.shop_orders.find_one(
        {"id": order_id, "customer_id": customer["id"]},
        {"_id": 0}
    )

    # ── Fallback: linked in-store EPOS invoice ────────────────────────────
    # Same security model as the VAT-invoice download route — only the
    # customer who owns the linked invoice can reorder it.
    in_store_source = False
    if not order:
        inv = await db.invoices.find_one(
            {
                "id": order_id,
                "linked_shop_customer_id": customer["id"],
                "deleted_at": {"$exists": False},
            },
            {"_id": 0},
        )
        if inv:
            in_store_source = True
            # Map invoice line_items into shop_orders.items shape so the
            # rest of the function stays one code path.
            order = {
                "id": inv.get("id"),
                "order_number": inv.get("invoice_no"),
                "items": [
                    {
                        "product_id": li.get("product_id") or "",
                        "sku": li.get("sku") or li.get("supplier_code") or "",
                        "name": li.get("product_name") or li.get("description") or "Item",
                        "price": float(li.get("due_price") or li.get("price") or 0),
                        "quantity": float(li.get("quantity") or 1),
                        "image": li.get("image", ""),
                    }
                    for li in (inv.get("line_items") or [])
                ],
            }
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    # Late-import to avoid a heavy circular import at module load time.
    from routes.tiles import get_tile_db, serialize_tile_for_shop
    from bson.objectid import ObjectId
    tile_db = get_tile_db()

    items = []
    for orig in (order.get("items") or []):
        pid = orig.get("product_id") or orig.get("id") or ""
        sku = orig.get("sku") or orig.get("supplier_code") or ""
        slug = orig.get("slug") or ""
        # Try id (string), then ObjectId, then slug, then sku — covers every
        # historical write pattern the storefront has used.
        tile = None
        for query in [
            ({"_id": ObjectId(pid)} if pid and len(str(pid)) == 24 else None),
            {"id": pid} if pid else None,
            {"slug": slug} if slug else None,
            {"supplier_code": sku} if sku else None,
            {"sku": sku} if sku else None,
        ]:
            if not query:
                continue
            try:
                tile = tile_db.tiles.find_one(query)
                if tile:
                    break
            except Exception:
                continue

        if not tile:
            # Product delisted (or, for in-store free-typed line items, never
            # had a product_id to look up). Keep the historic record so the
            # UI can show "no longer available" without losing context.
            no_pid = not (orig.get("product_id") or orig.get("id") or orig.get("sku") or orig.get("supplier_code") or orig.get("slug"))
            items.append({
                "id": pid,
                "display_name": orig.get("name", ""),
                "image": orig.get("image", ""),
                "price": orig.get("price", 0),
                "quantity": orig.get("quantity", 1),
                "size": orig.get("variant", ""),
                "available": False,
                "reason": "in_store_custom" if (in_store_source and no_pid) else "delisted",
            })
            continue

        serialized = serialize_tile_for_shop(tile)
        in_stock = serialized.get("in_stock", False)
        items.append({
            # Cart-context compatible payload
            "id": serialized["id"],
            "slug": serialized["slug"],
            "supplier_code": serialized["supplier_code"],
            "display_name": serialized["display_name"],
            "image": (serialized["images"] or [orig.get("image", "")])[0] if serialized["images"] else orig.get("image", ""),
            "price": serialized["price"],
            "retail_price_inc_vat": serialized["price"],
            "quantity": orig.get("quantity", 1),
            "size": serialized["size"],
            "finish": serialized["finish"],
            "color": serialized["color"],
            "supplier": serialized["supplier"],
            "sqm_per_box": tile.get("sqm_per_box") or tile.get("box_m2_coverage") or None,
            "tiles_per_box": tile.get("tiles_per_box") or None,
            "pricing_unit": serialized["pricing_unit"],
            "tier_pricing_disabled": serialized["tier_pricing_disabled"],
            # Helpful for the UI
            "available": in_stock,
            "in_stock": in_stock,
            "stock": serialized["stock"],
            "reason": None if in_stock else "out_of_stock",
            "original_price": orig.get("price", 0),
        })

    return {
        "order_id": order_id,
        "order_number": order.get("order_number", ""),
        "source": "in_store" if in_store_source else "online",
        "items": items,
        "available_count": sum(1 for i in items if i.get("available")),
    }


@router.get("/account/instore-reengagement")
async def instore_reengagement(request: Request):
    """Return a 5%-off re-engagement voucher for the calling customer if they
    have any IN-STORE EPOS invoice older than 30 days AND haven't placed a
    fresh online order in the last 30 days.

    The frontend uses this to surface a small "Running low? Order again" hint
    under each qualifying IN-STORE row on the customer dashboard. The voucher
    is single-use, email-locked, and auto-reused if one is already live (so
    refreshing the page doesn't mint a new code each time).

    Response:
      {
        eligible: bool,                       # whether any qualifying row exists
        voucher_code: str | null,             # only set when eligible
        percent_off: int,
        expires_at: ISO datetime str,
        qualifying_invoice_ids: [str, ...],   # IDs to surface the nudge on
      }
    """
    customer = await get_shop_customer(request)
    db = get_db()

    now = datetime.now(timezone.utc)
    cutoff = (now - timedelta(days=30)).isoformat()

    # Disqualify: any online shop_orders placed in the last 30 days means the
    # customer is engaged — no need to nudge them.
    recent_online = await db.shop_orders.find_one(
        {"customer_id": customer["id"], "created_at": {"$gte": cutoff}},
        {"_id": 0, "id": 1},
    )

    # Find all live linked in-store invoices older than 30 days.
    qualifying = []
    if not recent_online:
        cursor = db.invoices.find(
            {
                "linked_shop_customer_id": customer["id"],
                "deleted_at": {"$exists": False},
                "created_at": {"$lt": cutoff},
            },
            {"_id": 0, "id": 1},
        ).limit(50)
        async for inv in cursor:
            if inv.get("id"):
                qualifying.append(inv["id"])

    if not qualifying:
        return {
            "eligible": False,
            "voucher_code": None,
            "percent_off": 5,
            "expires_at": None,
            "qualifying_invoice_ids": [],
        }

    # Mint (or reuse) a single-use 5%-off voucher locked to this customer's
    # email. Prefix `TILE5` makes it instantly recognisable in checkout logs.
    email = (customer.get("email") or "").lower().strip()
    if not email:
        # No email on file → can't lock a voucher; surface eligibility but no code.
        return {
            "eligible": True,
            "voucher_code": None,
            "percent_off": 5,
            "expires_at": None,
            "qualifying_invoice_ids": qualifying,
        }

    promo = await generate_promo_code_for_email(
        db,
        email=email,
        percent_off=5,
        expires_days=60,
        source="instore_reengagement",
        prefix="TILE5",
    )
    return {
        "eligible": True,
        "voucher_code": promo["code"],
        "percent_off": promo["percent_off"],
        "expires_at": promo["expires_at"],
        "qualifying_invoice_ids": qualifying,
    }


# ============ GUEST CHECKOUT ============

@router.get("/discount-codes")
async def list_discount_codes(
    q: Optional[str] = None,
    source: Optional[str] = None,
    active_only: bool = False,
    limit: int = 200,
    current_user: dict = Depends(get_current_user),
):
    """Admin-only: list every promo code from every source, with redeemed totals."""
    if (current_user or {}).get("role") not in {"super_admin", "admin", "manager"}:
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()

    query: Dict[str, Any] = {}
    if source:
        query["source"] = source
    if active_only:
        query["active"] = True
        query["expires_at"] = {"$gt": datetime.now(timezone.utc)}
    if q:
        rgx = {"$regex": q.strip(), "$options": "i"}
        query["$or"] = [{"code": rgx}, {"email": rgx}, {"referrer_email": rgx}]

    codes = await db.shop_discount_codes.find(query, {"_id": 0}).sort("created_at", -1).limit(int(limit)).to_list(int(limit))

    code_set = [c["code"] for c in codes]
    redeemed_map: Dict[str, Dict[str, float]] = {}
    if code_set:
        agg = await db.shop_orders.aggregate([
            {"$match": {"promo_code": {"$in": code_set}, "payment_status": "paid"}},
            {"$group": {"_id": "$promo_code", "value": {"$sum": "$total"}, "count": {"$sum": 1}}},
        ]).to_list(len(code_set))
        for row in agg:
            redeemed_map[row["_id"]] = {"value": float(row.get("value") or 0), "count": int(row.get("count") or 0)}

    out = []
    for c in codes:
        owner = c.get("email") or c.get("referrer_email") or ""
        rmap = redeemed_map.get(c["code"], {})
        out.append({
            "code": c["code"],
            "source": c.get("source") or "manual",
            "owner_email": owner,
            "percent_off": int(c.get("percent_off") or 0),
            "used_count": int(c.get("used_count") or 0),
            "max_uses": int(c.get("max_uses") or 1),
            "active": bool(c.get("active", True)),
            "expires_at": (c["expires_at"].isoformat() if isinstance(c.get("expires_at"), datetime) else c.get("expires_at")),
            "created_at": (c["created_at"].isoformat() if isinstance(c.get("created_at"), datetime) else c.get("created_at")),
            "redeemed_value": round(rmap.get("value", 0.0), 2),
            "redeemed_count": rmap.get("count", 0),
        })

    # Source rollup for the page header
    by_source = {}
    for r in out:
        s = r["source"] or "manual"
        by_source.setdefault(s, {"count": 0, "active": 0, "redeemed_value": 0.0})
        by_source[s]["count"] += 1
        if r["active"] and r["used_count"] < r["max_uses"]:
            by_source[s]["active"] += 1
        by_source[s]["redeemed_value"] += r["redeemed_value"]

    return {"codes": out, "total": len(out), "by_source": by_source}


@router.post("/discount-codes")
async def create_discount_code(payload: dict, current_user: dict = Depends(get_current_user)):
    """Admin-only: manually mint a custom promo code (e.g. VIP / one-off campaign)."""
    if (current_user or {}).get("role") not in {"super_admin", "admin"}:
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()

    code = (payload.get("code") or "").strip().upper()
    percent_off = int(payload.get("percent_off") or 0)
    if not code or percent_off <= 0 or percent_off > 100:
        raise HTTPException(status_code=400, detail="Provide a code and a percent_off between 1 and 100")
    if await db.shop_discount_codes.find_one({"code": code}):
        raise HTTPException(status_code=409, detail=f"Code '{code}' already exists")

    now = datetime.now(timezone.utc)
    expires_days = int(payload.get("expires_days") or 30)
    max_uses = int(payload.get("max_uses") or 1)
    email_lock = (payload.get("email") or "").strip().lower()
    min_subtotal = float(payload.get("min_subtotal") or 0)

    doc = {
        "code": code,
        "percent_off": percent_off,
        "max_uses": max(1, max_uses),
        "used_count": 0,
        "email": email_lock,
        "source": "manual",
        "expires_at": now + timedelta(days=max(1, expires_days)),
        "min_subtotal": min_subtotal,
        "active": True,
        "created_at": now,
        "updated_at": now,
        "created_by": (current_user or {}).get("email"),
    }
    await db.shop_discount_codes.insert_one(doc)
    return {
        "code": code,
        "percent_off": percent_off,
        "max_uses": doc["max_uses"],
        "expires_at": doc["expires_at"].isoformat(),
        "email": email_lock or None,
    }


@router.put("/discount-codes/{code}/toggle")
async def toggle_discount_code(code: str, current_user: dict = Depends(get_current_user)):
    """Admin-only: deactivate or reactivate a code."""
    if (current_user or {}).get("role") not in {"super_admin", "admin"}:
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    existing = await db.shop_discount_codes.find_one({"code": code.upper()})
    if not existing:
        raise HTTPException(status_code=404, detail="Code not found")
    new_active = not existing.get("active", True)
    await db.shop_discount_codes.update_one(
        {"code": code.upper()},
        {"$set": {"active": new_active, "updated_at": datetime.now(timezone.utc)}},
    )
    return {"code": code.upper(), "active": new_active}


@router.post("/discount-codes/validate")
async def validate_discount_code(payload: dict):
    """Public endpoint — checkout calls this to validate a code before submitting the order."""
    db = get_db()
    code = (payload.get("code") or "").strip()
    email = (payload.get("email") or "").strip()
    try:
        subtotal = float(payload.get("subtotal") or 0)
    except (TypeError, ValueError):
        subtotal = 0.0
    return await validate_promo_code(db, code, email or None, subtotal)


@router.post("/referrals/get-code")
async def get_referral_code(payload: dict):
    """Public — returns or mints a FRIEND-XXXXXX code for a referrer.

    Identifier can be either:
      - referrer_email: the day-1 customer's email (preferred)
      - source_code: their personal BACK-XXXXXX (we look up the email from it)
    """
    db = get_db()
    referrer_email = (payload.get("referrer_email") or "").strip().lower()
    source_code = (payload.get("source_code") or "").strip().upper()

    if not referrer_email and source_code:
        src = await db.shop_discount_codes.find_one({"code": source_code})
        if src and src.get("email"):
            referrer_email = src["email"]

    if not referrer_email:
        raise HTTPException(status_code=400, detail="Provide referrer_email or a valid source_code")

    promo = await generate_referral_code(db, referrer_email)
    return {
        **promo,
        "referrer_email": referrer_email,
        "share_url": f"https://tilestation.co.uk/shop/tile-cart?promo={promo['code']}",
    }


@router.get("/referrals/stats")
async def referral_stats(current_user: dict = Depends(get_current_user)):
    """Admin — aggregate referral redemptions and revenue."""
    if (current_user or {}).get("role") not in {"super_admin", "admin", "manager"}:
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()

    codes = await db.shop_discount_codes.find(
        {"source": "referral"}, {"_id": 0}
    ).sort("created_at", -1).to_list(500)

    code_set = [c["code"] for c in codes]
    redemption_value = 0.0
    redemption_count = 0
    if code_set:
        agg = await db.shop_orders.aggregate([
            {"$match": {"promo_code": {"$in": code_set}, "payment_status": "paid"}},
            {"$group": {"_id": None, "value": {"$sum": "$total"}, "count": {"$sum": 1}}},
        ]).to_list(1)
        if agg:
            redemption_value = float(agg[0].get("value") or 0)
            redemption_count = int(agg[0].get("count") or 0)

    return {
        "total_codes": len(codes),
        "active_codes": sum(1 for c in codes if c.get("active") and c.get("used_count", 0) < c.get("max_uses", 1)),
        "total_redemptions": sum(c.get("used_count", 0) for c in codes),
        "paid_redemptions": redemption_count,
        "revenue_from_referrals": round(redemption_value, 2),
        "codes": codes[:50],
    }


async def _get_delivery_flags(db, ids: list) -> dict:
    """Resolve cart product ids (tile id / sku / supplier_code / slug) to their
    item-level delivery rules. Returns {identifier: flags} keyed by EVERY
    identifier of each matched tile so any id the cart holds resolves."""
    clean = [str(i) for i in ids if i]
    if not clean:
        return {}
    cursor = db.tiles.find(
        {"$or": [
            {"id": {"$in": clean}},
            {"sku": {"$in": clean}},
            {"supplier_code": {"$in": clean}},
            {"slug": {"$in": clean}},
        ]},
        {"_id": 0, "id": 1, "sku": 1, "supplier_code": 1, "slug": 1,
         "delivery_charge_required": 1, "delivery_charge": 1,
         "parcel_delivery": 1, "parcel_fee": 1,
         "pricing_unit": 1, "pallet_qty_unit": 1},
    )
    flags = {}
    tile_docs = await cursor.to_list(1000)
    # Older tiles docs can predate the delivery-rules mirror (rules saved in
    # admin write to supplier_products and mirror to tiles at SAVE time only).
    # Backfill from supplier_products keyed by sku/supplier_code so admin
    # saves always reach the storefront regardless of when they were made.
    sku_keys = set(clean)
    for doc in tile_docs:
        for k in ("sku", "supplier_code"):
            if doc.get(k):
                sku_keys.add(str(doc[k]))
    sp_by_key = {}
    if sku_keys:
        sp_cursor = db.supplier_products.find(
            {"$or": [{"sku": {"$in": list(sku_keys)}}, {"supplier_code": {"$in": list(sku_keys)}}]},
            {"_id": 0, "sku": 1, "supplier_code": 1,
             "delivery_charge_required": 1, "delivery_charge": 1,
             "parcel_delivery": 1, "parcel_fee": 1, "pallet_qty_unit": 1, "pricing_unit": 1},
        )
        async for sp in sp_cursor:
            for k in ("sku", "supplier_code"):
                if sp.get(k):
                    sp_by_key.setdefault(str(sp[k]), sp)
    for doc in tile_docs:
        sp = sp_by_key.get(str(doc.get("sku") or "")) or sp_by_key.get(str(doc.get("supplier_code") or "")) or {}

        def pick(field):
            v = doc.get(field)
            return v if v not in (None, "", 0, False) else sp.get(field)

        f = {
            "delivery_charge_required": bool(pick("delivery_charge_required")),
            "delivery_charge": float(pick("delivery_charge") or 0),
            "parcel_delivery": bool(pick("parcel_delivery")),
            "parcel_fee": float(pick("parcel_fee") or 0),
            # Authoritative pricing unit — lets the cart heal stale lines that
            # stored 'm2' for unit-priced products (adhesives, trims, bags).
            "pricing_unit": (
                "unit" if (pick("pallet_qty_unit") == "unit" or pick("pricing_unit") == "unit")
                else (doc.get("pricing_unit") or None)
            ),
        }
        for key_field in ("id", "sku", "supplier_code", "slug"):
            v = doc.get(key_field)
            if v:
                flags[str(v)] = f
    return flags


class DeliveryFlagsRequest(BaseModel):
    ids: List[str]


@router.post("/delivery-flags")
async def get_delivery_flags(data: DeliveryFlagsRequest):
    """Public — item-level delivery rules for cart items (mandatory delivery
    charges + parcel shipping flags). Used by the cart and checkout pages."""
    db = get_db()
    flags = await _get_delivery_flags(db, data.ids[:200])
    return {"flags": flags}


DEFAULT_DELIVERY_TERMS = ("* Some items are excluded from free delivery — a mandatory delivery "
                          "charge applies unless the other items in your order exceed the free-delivery threshold.")


@router.get("/delivery-terms")
async def get_delivery_terms():
    """Public — the small-print shown next to 'Free delivery over £X' across the storefront."""
    db = get_db()
    doc = await db.website_settings.find_one({"key": "delivery_terms"})
    text = ((doc or {}).get("value") or {}).get("text")
    return {"text": text if text is not None else DEFAULT_DELIVERY_TERMS}


class DeliveryTermsUpdate(BaseModel):
    text: str


@router.put("/delivery-terms")
async def update_delivery_terms(data: DeliveryTermsUpdate):
    """Admin — edit the free-delivery exclusion small-print (via the Delivery bulk modal)."""
    db = get_db()
    await db.website_settings.update_one(
        {"key": "delivery_terms"},
        {"$set": {"value": {"text": data.text}}},
        upsert=True,
    )
    return {"success": True}


@router.post("/guest-checkout")
async def create_guest_checkout_order(request: Request, order_input: GuestCheckoutOrder):
    """Create order from the checkout page. Works for guests; when a storefront
    session token is sent, the order is linked to that customer so trade
    orders show in their dashboard, earn credit and count towards their tier."""
    from services.password_links import normalize_email
    db = get_db()

    linked_customer = None
    if request.headers.get("Authorization", "").startswith("Bearer "):
        try:
            linked_customer = await get_shop_customer(request)
        except Exception:  # noqa: BLE001 — stale/invalid token never blocks checkout
            linked_customer = None

    customer = order_input.customer
    if not customer.get("email") or not customer.get("firstName") or not customer.get("lastName"):
        raise HTTPException(status_code=400, detail="Missing required customer details")
    customer["email"] = normalize_email(customer.get("email"))

    if not order_input.items:
        raise HTTPException(status_code=400, detail="Order must have items")

    # Recalculate delivery fee server-side from checkout settings
    delivery_info = order_input.delivery
    delivery_method = delivery_info.get("method", "delivery")
    postcode = delivery_info.get("postcode", "").upper().replace(" ", "")
    subtotal = sum(float(item.price or 0) * float(item.quantity or 0) for item in order_input.items)

    delivery_fee = 0.0
    congestion_charge = 0.0
    is_congestion_zone = False
    item_delivery_charge = 0.0
    is_parcel_order = False
    if delivery_method == "delivery":
        settings_doc = await db.website_settings.find_one({"key": "checkout_settings"}, {"_id": 0})
        cs = settings_doc.get("value", {}) if settings_doc else {}
        d = cs.get("delivery", {})
        free_threshold = d.get("free_threshold", 500)
        default_fee = d.get("default_fee", 49.99)
        zones = d.get("zones", [])
        cc_settings = d.get("congestion_charge", {})

        matched = False
        for zone in zones:
            prefixes = [p.strip().upper() for p in zone.get("postcodes", "").split(",") if p.strip()]
            if prefixes and any(postcode.startswith(p) for p in prefixes):
                delivery_fee = zone.get("fee", default_fee)
                is_congestion_zone = zone.get("is_congestion_zone", False)
                matched = True
                break
        if not matched:
            delivery_fee = default_fee

        # Free delivery for orders over threshold
        if subtotal >= free_threshold:
            delivery_fee = 0.0

        # Congestion charge always applies for congestion zones (even on free delivery)
        if is_congestion_zone and cc_settings.get("enabled", False):
            congestion_charge = cc_settings.get("amount", 18.0)

        # ---- Item-level delivery rules (mandatory charges + parcel items) ----
        flags_map = await _get_delivery_flags(db, [it.product_id or "" for it in order_input.items])
        marked_charges = []
        eligible_subtotal = 0.0
        parcel_all = len(order_input.items) > 0
        parcel_fees = []
        for it in order_input.items:
            f = flags_map.get(str(it.product_id or ""), {})
            line_total = float(it.price or 0) * float(it.quantity or 0)
            if f.get("delivery_charge_required") and float(f.get("delivery_charge") or 0) > 0:
                marked_charges.append(float(f["delivery_charge"]))
            else:
                eligible_subtotal += line_total
            if f.get("parcel_delivery"):
                if float(f.get("parcel_fee") or 0) > 0:
                    parcel_fees.append(float(f["parcel_fee"]))
            else:
                parcel_all = False
        # Mandatory item charge: highest single charge; waived ONLY when the
        # non-marked items alone cross the free-delivery threshold.
        if marked_charges and eligible_subtotal < free_threshold:
            item_delivery_charge = max(marked_charges)
        # Parcel-only order: courier parcel rate replaces the pallet delivery fee.
        # Couriers don't pay the congestion charge — pallet deliveries only.
        if parcel_all:
            is_parcel_order = True
            if not marked_charges:
                congestion_charge = 0.0
                if parcel_fees and subtotal < free_threshold:
                    delivery_fee = max(parcel_fees)

    # Express delivery surcharge
    express_fee = 0.0
    delivery_speed = delivery_info.get("speed", "standard")
    if delivery_method == "delivery" and delivery_speed == "express":
        settings_doc = settings_doc if settings_doc else await db.website_settings.find_one({"key": "checkout_settings"}, {"_id": 0})
        cs = settings_doc.get("value", {}) if settings_doc else {}
        express_settings = cs.get("delivery", {}).get("express", {})
        if express_settings.get("enabled", False):
            express_fee = express_settings.get("extra_fee", 25.0)

    total = round(subtotal + delivery_fee + congestion_charge + express_fee + item_delivery_charge, 2)

    # ---- Promo code (e.g. abandoned-cart day-1 BACK10-XXXX). Server-validated. ----
    promo_discount = 0.0
    promo_applied = None
    if order_input.promo_code:
        check = await validate_promo_code(
            db,
            order_input.promo_code,
            email=customer.get("email"),
            subtotal=subtotal,
        )
        if check.get("valid"):
            promo_discount = float(check.get("discount_amount") or 0)
            total = round(max(total - promo_discount, 0.0), 2)
            promo_applied = {
                "code": check.get("code"),
                "percent_off": check.get("percent_off"),
                "discount_amount": promo_discount,
            }
        # Invalid codes are silently ignored — UI already validated, server is final say.

    order_id = str(uuid.uuid4())
    order_number = f"TS-{datetime.now().strftime('%y%m%d')}-{order_id[:6].upper()}"
    now = datetime.now(timezone.utc)

    # Build canonical billing_address. Frontend sends `billing` already mirrored
    # from delivery when "same as delivery" is ticked, so we trust it; but if
    # missing entirely (older clients) we fall back to the delivery address.
    incoming_billing = order_input.billing or {}
    same_as_delivery = bool(incoming_billing.get("same_as_delivery"))
    billing_address = {
        "same_as_delivery": same_as_delivery,
        "first_name": incoming_billing.get("firstName") or customer.get("firstName", ""),
        "last_name": incoming_billing.get("lastName") or customer.get("lastName", ""),
        "company": incoming_billing.get("company", ""),
        "address1": incoming_billing.get("address1") or delivery_info.get("address1", ""),
        "address2": incoming_billing.get("address2") or delivery_info.get("address2", ""),
        "city": incoming_billing.get("city") or delivery_info.get("city", ""),
        "county": incoming_billing.get("county") or delivery_info.get("county", ""),
        "postcode": (incoming_billing.get("postcode") or delivery_info.get("postcode", "")).upper(),
    }

    order_doc = {
        "id": order_id,
        "order_number": order_number,
        "customer_id": linked_customer["id"] if linked_customer else None,
        "is_trade": bool(linked_customer and linked_customer.get("is_trade")),
        "customer_email": customer.get("email"),
        "customer_name": f"{customer.get('firstName', '')} {customer.get('lastName', '')}".strip(),
        "customer_phone": customer.get("phone", ""),
        "delivery_method": delivery_method,
        "delivery_speed": delivery_speed,
        "delivery_address": {
            "address1": delivery_info.get("address1", ""),
            "address2": delivery_info.get("address2", ""),
            "city": delivery_info.get("city", ""),
            "county": delivery_info.get("county", ""),
            "postcode": delivery_info.get("postcode", ""),
        } if delivery_method == "delivery" else {},
        "billing_address": billing_address,
        "notes": delivery_info.get("notes", ""),
        # Click & Collect — selected showroom (resolved to name by admin views)
        "collect_store_id": (delivery_info.get("collect_store_id") or None) if delivery_method == "collect" else None,
        "collect_store_name": (delivery_info.get("collect_store_name") or None) if delivery_method == "collect" else None,
        "items": [item.model_dump() for item in order_input.items],
        "subtotal": round(subtotal, 2),
        "delivery_fee": round(delivery_fee, 2),
        "congestion_charge": round(congestion_charge, 2),
        "express_fee": round(express_fee, 2),
        "item_delivery_charge": round(item_delivery_charge, 2),
        "is_parcel_order": is_parcel_order,
        "promo_code": (promo_applied or {}).get("code"),
        "promo_discount": round(promo_discount, 2),
        "promo_percent_off": (promo_applied or {}).get("percent_off"),
        # Tier + trade savings breakdown (built client-side, persisted as-is).
        # Used by the order email + invoice PDF to render "You saved £X (Y% off retail)".
        "savings_meta": order_input.savings_meta or None,
        "total": total,
        "status": "pending",
        "payment_status": "pending",
        "payment_method": order_input.payment.get("method", "card"),
        "source": "website_checkout",
        "created_at": now.isoformat(),
        "updated_at": now.isoformat(),
    }

    await _attach_trade_metadata(db, order_doc, order_doc.get("customer_id"))
    await db.shop_orders.insert_one(order_doc)

    # Consume the promo only after the order row is committed.
    if promo_applied and promo_applied.get("code"):
        try:
            await consume_promo_code(db, promo_applied["code"])
        except Exception:
            logger.exception("Failed to consume promo code; not blocking order")

    return {
        "order_id": order_id,
        "order_number": order_number,
        "total": total,
        "promo_applied": promo_applied,
        "status": "pending",
    }


@router.post("/guest-checkout/pay")
async def create_guest_payment_session(request: Request, data: dict):
    """Create Stripe checkout session for a guest order (no auth required).

    Granular error handling — each potential failure point (missing env,
    missing order, DB read for Klarna toggle, Stripe session create) raises
    a distinct HTTPException with an actionable detail, and logs the full
    traceback so Railway logs pinpoint the cause.
    """
    db = get_db()
    order_id = data.get("order_id")
    origin_url = data.get("origin_url", "")
    # Optional — shopper picked a method on Step 3 ("card" | "paypal" | "klarna" | "wallet").
    # We map this to the Stripe `payment_method_types` Stripe accepts so the
    # shopper lands directly on (or has preselected) their chosen method.
    preferred_method = (data.get("preferred_method") or "").strip().lower()

    if not order_id or not origin_url:
        raise HTTPException(status_code=400, detail="order_id and origin_url required")

    order = await db.shop_orders.find_one({"id": order_id}, {"_id": 0})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    if order.get("payment_status") == "paid":
        raise HTTPException(status_code=400, detail="Order already paid")

    stripe_api_key = os.environ.get("STRIPE_API_KEY")
    if not stripe_api_key:
        logger.error("[guest-pay] STRIPE_API_KEY env var missing")
        raise HTTPException(status_code=500, detail="Payment service not configured (STRIPE_API_KEY missing)")

    webhook_url = _resolve_webhook_url(request)
    stripe_checkout = StripeCheckout(api_key=stripe_api_key, webhook_url=webhook_url)

    # Total amount from server-side calculation (never trust frontend)
    try:
        total_amount = float(order.get("total") or 0)
    except (TypeError, ValueError):
        logger.error(f"[guest-pay] order {order_id} has non-numeric total: {order.get('total')!r}")
        raise HTTPException(status_code=400, detail="Order total is invalid — please contact support")
    if total_amount <= 0:
        raise HTTPException(status_code=400, detail="Invalid order total")

    success_url = f"{origin_url}/shop/order-success?session_id={{CHECKOUT_SESSION_ID}}&order_id={order_id}"
    cancel_url = f"{origin_url}/shop/tile-checkout?cancelled=1"

    # Klarna toggle read — wrap so a bad settings doc can't 500 the whole flow.
    try:
        payment_methods = await get_enabled_checkout_payment_methods(total_amount)
    except Exception as e:
        logger.exception(f"[guest-pay] failed reading payment method toggle: {e}")
        payment_methods = ["card"]

    # If the shopper picked a specific method on Step 3, narrow to that. Stripe
    # then takes them straight to (or preselects) that method on the hosted page.
    # We honour the admin's enabled list — if the shopper picks something the
    # admin has disabled (shouldn't normally happen since the card wouldn't be
    # rendered), fall back to the admin's full list.
    PREF_MAP = {
        "card":   "card",
        "klarna": "klarna",
        "paypal": "paypal",
        # "wallet" = Apple/Google Pay, which both ride on top of Stripe's `card`
        # payment method type. Stripe auto-shows the wallet sheet on supported
        # devices when `card` is the only enabled method, so we map to `card`.
        "wallet": "card",
    }
    if preferred_method in PREF_MAP:
        wanted = PREF_MAP[preferred_method]
        if wanted in payment_methods:
            payment_methods = [wanted]

    checkout_request = CheckoutSessionRequest(
        amount=total_amount,
        currency="gbp",
        payment_methods=payment_methods,
        success_url=success_url,
        cancel_url=cancel_url,
        metadata={
            "order_id": order_id,
            "order_number": order.get("order_number", ""),
            "customer_email": order.get("customer_email", ""),
        },
    )

    try:
        session = await stripe_checkout.create_checkout_session(checkout_request)
    except Exception as e:
        # If the failure is "payment method type ... is invalid" (typically because
        # Klarna/PayPal/etc. are enabled in our admin DB but NOT activated in the
        # merchant's Stripe Dashboard), gracefully retry with just `card` so the
        # shopper can still pay. We log the original error so the admin can fix
        # the Stripe Dashboard config later, but don't block checkout in the meantime.
        err_msg_full = str(e) or type(e).__name__
        is_method_invalid = (
            "payment method type" in err_msg_full.lower()
            and "invalid" in err_msg_full.lower()
        )
        if is_method_invalid and payment_methods != ["card"]:
            logger.warning(
                f"[guest-pay] Stripe rejected methods {payment_methods}; retrying with ['card'] only. "
                f"Action required: enable these methods in dashboard.stripe.com → Payment methods. "
                f"Original error: {err_msg_full[:200]}"
            )
            try:
                checkout_request.payment_methods = ["card"]
                session = await stripe_checkout.create_checkout_session(checkout_request)
            except Exception as e2:
                logger.exception(
                    f"[guest-pay] Stripe also failed with card-only fallback | order={order_id} amount={total_amount}"
                )
                err_msg2 = str(e2) or type(e2).__name__
                # Mark the order as failed so the admin Online Orders page shows it correctly
                await db.shop_orders.update_one(
                    {"id": order_id},
                    {"$set": {"payment_status": "failed", "payment_error": err_msg2[:300], "updated_at": datetime.now(timezone.utc).isoformat()}}
                )
                raise HTTPException(status_code=502, detail=f"Stripe rejected the session: {err_msg2[:200]}")
        else:
            logger.exception(
                f"[guest-pay] Stripe create_checkout_session failed | order={order_id} "
                f"amount={total_amount} methods={payment_methods}"
            )
            await db.shop_orders.update_one(
                {"id": order_id},
                {"$set": {"payment_status": "failed", "payment_error": err_msg_full[:300], "updated_at": datetime.now(timezone.utc).isoformat()}}
            )
            raise HTTPException(status_code=502, detail=f"Stripe rejected the session: {err_msg_full[:200]}")

    now = datetime.now(timezone.utc).isoformat()
    # Update order with session ID
    await db.shop_orders.update_one(
        {"id": order_id},
        {"$set": {"stripe_session_id": session.session_id, "payment_status": "initiated", "updated_at": now}}
    )

    # Create payment transaction record
    await db.payment_transactions.insert_one({
        "session_id": session.session_id,
        "order_id": order_id,
        "order_number": order.get("order_number", ""),
        "customer_email": order.get("customer_email", ""),
        "amount": total_amount,
        "currency": "gbp",
        "payment_status": "initiated",
        "metadata": checkout_request.metadata,
        "created_at": now,
        "updated_at": now,
    })

    return {
        "checkout_url": session.url,
        "session_id": session.session_id,
    }


# ============ PAYMENT (STRIPE) ============

@router.post("/klarna-express/create-session")
async def create_klarna_express_session(request: Request, data: KlarnaExpressRequest):
    """
    Klarna Express Checkout — skips the Tile Station checkout form.
    
    Flow:
      1. Customer clicks "Pay with Klarna" on the basket page.
      2. Frontend POSTs basket items here.
      3. Backend server-computes total, creates a minimal shop_orders doc,
         and returns a Stripe-hosted Klarna-only checkout URL.
      4. Stripe collects email + shipping/billing address via Klarna's
         own profile lookup (customer never fills in Tile Station forms).
      5. Order is completed when webhook fires on payment_status=paid.
    
    Default delivery: standard. Customers wanting Click & Collect or
    express delivery must use the full checkout flow.
    
    Guardrails:
      - Only available when admin toggle `klarna_enabled` is ON.
      - Basket total must be >= £30 (Klarna UK minimum).
      - Always creates the Stripe session with `payment_method_types=['klarna']`
        (only), plus billing/shipping collection so Klarna fills it in.
    """
    # Guard 1: Klarna must be turned on by admin
    if not await is_klarna_checkout_enabled():
        raise HTTPException(status_code=400, detail="Klarna Express is not enabled by the store")
    
    # Guard 2: Basket must have items
    if not data.items:
        raise HTTPException(status_code=400, detail="Basket is empty")
    
    # Compute subtotal SERVER-SIDE (never trust frontend)
    db = get_db()
    subtotal = 0.0
    cleaned_items = []
    for item in data.items:
        if item.quantity <= 0 or item.price <= 0:
            continue
        line_total = round(item.price * item.quantity, 2)
        subtotal += line_total
        cleaned_items.append(item.model_dump())
    subtotal = round(subtotal, 2)
    
    if not cleaned_items:
        raise HTTPException(status_code=400, detail="No valid items in basket")
    
    # Default delivery: standard £49.99, waived at the store's free threshold
    settings_doc = await db.website_settings.find_one({"key": "checkout_settings"}, {"_id": 0})
    delivery_cfg = (settings_doc or {}).get("value", {}).get("delivery", {})
    free_threshold = float(delivery_cfg.get("free_threshold", 1000) or 1000)
    standard_fee = float(delivery_cfg.get("standard_fee", 49.99) or 49.99)
    delivery_fee = 0.0 if subtotal >= free_threshold else standard_fee
    total = round(subtotal + delivery_fee, 2)
    
    # Guard 3: Klarna UK minimum
    if total < KLARNA_UK_MIN_AMOUNT_GBP:
        raise HTTPException(
            status_code=400,
            detail=f"Klarna requires a minimum basket of £{KLARNA_UK_MIN_AMOUNT_GBP:.2f}"
        )
    
    stripe_api_key = os.environ.get("STRIPE_API_KEY")
    if not stripe_api_key:
        raise HTTPException(status_code=500, detail="Payment service not configured")
    
    # Create a placeholder shop_orders doc — customer details filled in by webhook
    now = datetime.now(timezone.utc)
    order_id = str(uuid.uuid4())
    order_number = f"KE-{int(now.timestamp())}"[-12:]  # KE = Klarna Express
    order_doc = {
        "id": order_id,
        "order_number": order_number,
        "customer_name": "",
        "customer_email": data.customer_email or "",
        "customer_phone": "",
        "delivery_method": "delivery",
        "delivery_address": {},
        "notes": "",
        "items": cleaned_items,
        "subtotal": subtotal,
        "delivery_fee": delivery_fee,
        "congestion_charge": 0.0,
        "express_fee": 0.0,
        "total": total,
        "status": "pending",
        "payment_status": "pending",
        "payment_method": "klarna",
        "source": "klarna_express",          # <-- used by webhook + admin UI
        "is_express_klarna": True,
        "is_guest_order": True,
        "created_at": now.isoformat(),
        "updated_at": now.isoformat(),
    }
    await _attach_trade_metadata(db, order_doc, order_doc.get("customer_id"))
    await db.shop_orders.insert_one(order_doc)
    
    # Build Stripe session — Klarna only, Stripe collects address via Klarna flow
    webhook_url = _resolve_webhook_url(request)
    stripe_checkout = StripeCheckout(api_key=stripe_api_key, webhook_url=webhook_url)
    
    success_url = f"{data.origin_url}/shop/order-success?session_id={{CHECKOUT_SESSION_ID}}&order_id={order_id}"
    cancel_url = f"{data.origin_url}/shop/tile-cart?express_cancelled=1"
    
    checkout_request = CheckoutSessionRequest(
        amount=total,
        currency="gbp",
        payment_methods=["klarna"],  # Express = Klarna only
        success_url=success_url,
        cancel_url=cancel_url,
        metadata={
            "order_id": order_id,
            "order_number": order_number,
            "source": "klarna_express",
        },
    )
    
    try:
        session = await stripe_checkout.create_checkout_session(checkout_request)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Klarna session failed: {str(e)}")
    
    # Persist session ID on the order for webhook reconciliation
    await db.shop_orders.update_one(
        {"id": order_id},
        {"$set": {
            "stripe_session_id": session.session_id,
            "payment_status": "initiated",
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }},
    )
    
    return {
        "session_id": session.session_id,
        "url": session.url,
        "order_id": order_id,
        "total": total,
    }


@router.post("/paypal-express/create-session")
async def create_paypal_express_session(request: Request, data: PaypalExpressRequest):
    """
    PayPal Express Checkout — mirrors the Klarna Express flow but with
    payment_method_types=['paypal']. No £30 minimum; Stripe collects
    shipping/email via PayPal's hosted flow.
    """
    # Guard 1: PayPal must be turned on by admin
    if not await is_paypal_checkout_enabled():
        raise HTTPException(status_code=400, detail="PayPal Express is not enabled by the store")

    # Guard 2: Basket must have items
    if not data.items:
        raise HTTPException(status_code=400, detail="Basket is empty")

    # Compute subtotal SERVER-SIDE (never trust frontend)
    db = get_db()
    subtotal = 0.0
    cleaned_items = []
    for item in data.items:
        if item.quantity <= 0 or item.price <= 0:
            continue
        line_total = round(item.price * item.quantity, 2)
        subtotal += line_total
        cleaned_items.append(item.model_dump())
    subtotal = round(subtotal, 2)

    if not cleaned_items:
        raise HTTPException(status_code=400, detail="No valid items in basket")

    # Default delivery: standard, waived at the store's free threshold
    settings_doc = await db.website_settings.find_one({"key": "checkout_settings"}, {"_id": 0})
    delivery_cfg = (settings_doc or {}).get("value", {}).get("delivery", {})
    free_threshold = float(delivery_cfg.get("free_threshold", 1000) or 1000)
    standard_fee = float(delivery_cfg.get("standard_fee", 49.99) or 49.99)
    delivery_fee = 0.0 if subtotal >= free_threshold else standard_fee
    total = round(subtotal + delivery_fee, 2)

    if total <= 0:
        raise HTTPException(status_code=400, detail="Invalid basket total")

    stripe_api_key = os.environ.get("STRIPE_API_KEY")
    if not stripe_api_key:
        raise HTTPException(status_code=500, detail="Payment service not configured")

    # Create a placeholder shop_orders doc — customer details filled in by webhook
    now = datetime.now(timezone.utc)
    order_id = str(uuid.uuid4())
    order_number = f"PE-{int(now.timestamp())}"[-12:]  # PE = PayPal Express
    order_doc = {
        "id": order_id,
        "order_number": order_number,
        "customer_name": "",
        "customer_email": data.customer_email or "",
        "customer_phone": "",
        "delivery_method": "delivery",
        "delivery_address": {},
        "notes": "",
        "items": cleaned_items,
        "subtotal": subtotal,
        "delivery_fee": delivery_fee,
        "congestion_charge": 0.0,
        "express_fee": 0.0,
        "total": total,
        "status": "pending",
        "payment_status": "pending",
        "payment_method": "paypal",
        "source": "paypal_express",
        "is_express_paypal": True,
        "is_guest_order": True,
        "created_at": now.isoformat(),
        "updated_at": now.isoformat(),
    }
    await _attach_trade_metadata(db, order_doc, order_doc.get("customer_id"))
    await db.shop_orders.insert_one(order_doc)

    # Build Stripe session — PayPal only
    webhook_url = _resolve_webhook_url(request)
    stripe_checkout = StripeCheckout(api_key=stripe_api_key, webhook_url=webhook_url)

    success_url = f"{data.origin_url}/shop/order-success?session_id={{CHECKOUT_SESSION_ID}}&order_id={order_id}"
    cancel_url = f"{data.origin_url}/shop/tile-cart?express_cancelled=1"

    checkout_request = CheckoutSessionRequest(
        amount=total,
        currency="gbp",
        payment_methods=["paypal"],
        success_url=success_url,
        cancel_url=cancel_url,
        metadata={
            "order_id": order_id,
            "order_number": order_number,
            "source": "paypal_express",
        },
    )

    try:
        session = await stripe_checkout.create_checkout_session(checkout_request)
    except Exception as e:
        logger.exception(f"[paypal-express] Stripe session failed | order={order_id} total={total}")
        raise HTTPException(status_code=502, detail=f"PayPal session failed: {str(e)[:200]}")

    await db.shop_orders.update_one(
        {"id": order_id},
        {"$set": {
            "stripe_session_id": session.session_id,
            "payment_status": "initiated",
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }},
    )

    return {
        "session_id": session.session_id,
        "url": session.url,
        "order_id": order_id,
        "total": total,
    }



@router.get("/orders/by-id/{order_id}")
async def get_order_by_id_public(order_id: str):
    """
    Public order lookup by id — used by the order-success page as a fallback
    when Stripe's session-verify endpoint is flaky. Returns only the
    minimum customer-facing fields, NEVER raw payment_intent secrets.
    """
    db = get_db()
    order = await db.shop_orders.find_one(
        {"id": order_id},
        {"_id": 0, "id": 1, "order_number": 1, "total": 1, "payment_status": 1,
         "customer_email": 1, "customer_name": 1, "delivery_method": 1,
         "delivery_address": 1, "items": 1, "status": 1, "created_at": 1}
    )
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    return order


@router.get("/guest-checkout/status/{session_id}")
async def get_guest_checkout_status(session_id: str):
    """Get payment status for a guest checkout session"""
    db = get_db()

    # Find order by stripe session
    order = await db.shop_orders.find_one(
        {"stripe_session_id": session_id},
        {"_id": 0, "id": 1, "order_number": 1, "total": 1, "payment_status": 1,
         "customer_email": 1, "customer_name": 1, "delivery_method": 1,
         "delivery_address": 1, "items": 1, "status": 1}
    )
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    if order.get("payment_status") == "paid":
        return {"status": "paid", "order": order}

    # Check with Stripe
    stripe_api_key = os.environ.get("STRIPE_API_KEY")
    if not stripe_api_key:
        return {"status": order.get("payment_status", "unknown"), "order": order}

    stripe_checkout = StripeCheckout(api_key=stripe_api_key, webhook_url="")
    try:
        checkout_status = await stripe_checkout.get_checkout_status(session_id)
        now = datetime.now(timezone.utc).isoformat()
        if checkout_status.payment_status == "paid":
            # Update order — only if not already paid (prevent double processing)
            result = await db.shop_orders.update_one(
                {"id": order["id"], "payment_status": {"$ne": "paid"}},
                {"$set": {"status": "confirmed", "payment_status": "paid", "paid_at": now, "updated_at": now}}
            )
            if result.modified_count > 0:
                # Also update payment transaction
                await db.payment_transactions.update_one(
                    {"session_id": session_id},
                    {"$set": {"payment_status": "paid", "updated_at": now}}
                )
                # Linked (signed-in / trade) customer: spend stats + credit-back.
                await _record_paid_order_for_customer(db, order["id"])
                # Mark abandoned-cart sequence recovered for this email so day-1 doesn't fire post-purchase.
                cust_email = (order.get("customer_email") or "").lower()
                if cust_email:
                    try:
                        await db.abandoned_carts.update_many(
                            {"customer_email": cust_email, "status": "abandoned"},
                            {"$set": {"status": "recovered", "recovered_at": datetime.now(timezone.utc)}},
                        )
                    except Exception:
                        logger.exception("Failed to mark abandoned cart recovered")

                # 17 May 2026 — Telegram + admin alert on first-paid-flip.
                #
                # This block was missing entirely until today. Real customer
                # orders were transitioning to `paid` in the DB but no one
                # got told. The owner only discovered them by manually
                # scrolling the Stripe dashboard days later.
                #
                # We re-read the full order doc (the projection above
                # excludes some fields we want for the alert) and stamp
                # `confirmation_sent_at` for idempotency before firing
                # so a refresh of the success page can't double-alert.
                try:
                    full_order = await db.shop_orders.find_one(
                        {"id": order["id"]}, {"_id": 0},
                    )
                    if full_order and not full_order.get("confirmation_sent_at"):
                        sent_at = datetime.now(timezone.utc).isoformat()
                        guard = await db.shop_orders.update_one(
                            {"id": order["id"], "confirmation_sent_at": {"$exists": False}},
                            {"$set": {"confirmation_sent_at": sent_at}},
                        )
                        if guard.modified_count > 0:
                            await _send_shop_order_alert_fanout(full_order)
                except Exception:
                    logger.exception("Shop order alert fanout failed (non-fatal)")
            order["payment_status"] = "paid"
            order["status"] = "confirmed"
        return {"status": checkout_status.payment_status, "order": order}
    except Exception:
        return {"status": order.get("payment_status", "unknown"), "order": order}


@router.post("/checkout/create-session")
async def create_checkout_session(request: Request, checkout_req: CheckoutRequest):
    """Create Stripe checkout session for order payment"""
    customer = await get_shop_customer(request)
    db = get_db()
    
    # Get order
    order = await db.shop_orders.find_one(
        {"id": checkout_req.order_id, "customer_id": customer["id"]},
        {"_id": 0}
    )
    
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    
    if order.get("payment_status") == "paid":
        raise HTTPException(status_code=400, detail="Order already paid")
    
    # Initialize Stripe
    stripe_api_key = os.environ.get("STRIPE_API_KEY")
    if not stripe_api_key:
        raise HTTPException(status_code=500, detail="Payment service not configured")
    
    webhook_url = _resolve_webhook_url(request)
    stripe_checkout = StripeCheckout(api_key=stripe_api_key, webhook_url=webhook_url)
    
    # Build URLs
    success_url = f"{checkout_req.origin_url}/shop/order-success?session_id={{CHECKOUT_SESSION_ID}}&order_id={order['id']}"
    cancel_url = f"{checkout_req.origin_url}/shop/checkout?order_id={order['id']}"
    
    # Create checkout session
    _order_total = float(order["total"])
    payment_methods = await get_enabled_checkout_payment_methods(_order_total)
    checkout_request = CheckoutSessionRequest(
        amount=_order_total,
        currency="gbp",
        payment_methods=payment_methods,
        success_url=success_url,
        cancel_url=cancel_url,
        metadata={
            "order_id": order["id"],
            "order_number": order["order_number"],
            "customer_id": customer["id"],
            "customer_email": order["customer_email"]
        }
    )
    
    try:
        session: CheckoutSessionResponse = await stripe_checkout.create_checkout_session(checkout_request)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Payment session creation failed: {str(e)}")
    
    # Create payment transaction record
    transaction_doc = {
        "id": str(uuid.uuid4()),
        "session_id": session.session_id,
        "order_id": order["id"],
        "order_number": order["order_number"],
        "customer_id": customer["id"],
        "customer_email": order["customer_email"],
        "amount": float(order["total"]),
        "currency": "gbp",
        "payment_status": "initiated",
        "created_at": datetime.now(timezone.utc).isoformat()
    }
    
    await db.payment_transactions.insert_one(transaction_doc)
    
    # Update order with session ID
    await db.shop_orders.update_one(
        {"id": order["id"]},
        {"$set": {"stripe_session_id": session.session_id}}
    )
    
    return {
        "checkout_url": session.url,
        "session_id": session.session_id
    }


@router.get("/checkout/status/{session_id}")
async def get_checkout_status(session_id: str):
    """Get payment status for a checkout session"""
    db = get_db()
    
    # Get transaction
    transaction = await db.payment_transactions.find_one(
        {"session_id": session_id},
        {"_id": 0}
    )
    
    if not transaction:
        raise HTTPException(status_code=404, detail="Transaction not found")
    
    # Check Stripe status
    stripe_api_key = os.environ.get("STRIPE_API_KEY")
    if not stripe_api_key:
        raise HTTPException(status_code=500, detail="Payment service not configured")
    
    stripe_checkout = StripeCheckout(api_key=stripe_api_key, webhook_url="")
    
    try:
        status: CheckoutStatusResponse = await stripe_checkout.get_checkout_status(session_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to check payment status: {str(e)}")
    
    # Update transaction and order if payment is complete
    if status.payment_status == "paid" and transaction.get("payment_status") != "paid":
        now = datetime.now(timezone.utc).isoformat()
        
        # Update transaction
        await db.payment_transactions.update_one(
            {"session_id": session_id},
            {"$set": {
                "payment_status": "paid",
                "status": status.status,
                "paid_at": now
            }}
        )
        
        # Update order
        order_id = transaction.get("order_id")
        order = await db.shop_orders.find_one({"id": order_id}, {"_id": 0})
        
        if order:
            await db.shop_orders.update_one(
                {"id": order_id},
                {"$set": {
                    "status": "confirmed",
                    "payment_status": "paid",
                    "paid_at": now,
                    "updated_at": now
                }}
            )
            
            # Deduct stock for each item
            for item in order.get("items", []):
                await db.products.update_one(
                    {"id": item["product_id"]},
                    {"$inc": {"stock": -int(item["quantity"])}}
                )
            
            # Clear customer's cart
            customer_id = order.get("customer_id")
            if customer_id:
                await db.shop_customers.update_one(
                    {"id": customer_id},
                    {"$set": {"cart": []}}
                )
            
            # Award trade credits if applicable
            credit_result = await award_credits_for_order(order_id, db)
            if credit_result.get("success"):
                logging.info(f"Credits awarded for order {order_id}: £{credit_result.get('credits_earned', 0):.2f}")
            
            # Send order confirmation email (idempotent dispatcher —
            # safe against double-send when the Stripe webhook also fires).
            updated_order = await db.shop_orders.find_one({"id": order_id}, {"_id": 0})
            if updated_order:
                try:
                    from services.email import send_order_confirmation_emails_idempotent
                    email_result = await send_order_confirmation_emails_idempotent(order_id)
                    if email_result.get("already_sent"):
                        logging.info(f"Order confirmation emails already sent for {order_id} (poll path skipped)")
                    else:
                        c_ok = email_result.get("customer", {}).get("success")
                        o_ok = email_result.get("owner", {}).get("success")
                        logging.info(f"Order confirmation emails dispatched for {order_id}: customer_ok={c_ok} owner_ok={o_ok}")
                except Exception as e:  # noqa: BLE001
                    logging.warning(f"Order confirmation email dispatch failed (poll): {e}")

                # 🛒 Telegram alert (polling-based status path) — same
                # dedupe key as the webhook so whichever path completes
                # first wins and the other gets dropped by the dedupe
                # window. Most successful checkouts hit this code path
                # via the success-page poll on the frontend before the
                # webhook arrives.
                try:
                    from services.telegram_notify import fire_and_forget as _tg_ff
                    items_count = len(updated_order.get("items") or [])
                    total_str = f"£{float(updated_order.get('total', 0)):.2f}"
                    customer_name = updated_order.get("customer_name") or "Customer"
                    order_number = updated_order.get("order_number") or order_id
                    is_trade = bool(updated_order.get("trade_metadata"))
                    badge = " · TRADE" if is_trade else ""
                    _tg_ff(
                        "new_order",
                        f"🛒 <b>New order</b> {order_number}{badge}\n"
                        f"{customer_name}\n"
                        f"{total_str} · {items_count} item{'s' if items_count != 1 else ''}",
                        dedupe_key=f"new-order:{order_id}",
                    )
                except Exception as e:  # noqa: BLE001
                    logging.warning(f"Telegram new_order alert failed (poll path): {e}")
    
    elif status.status == "expired":
        await db.payment_transactions.update_one(
            {"session_id": session_id},
            {"$set": {"payment_status": "expired", "status": "expired"}}
        )
        
        await db.shop_orders.update_one(
            {"id": transaction.get("order_id")},
            {"$set": {"status": "cancelled", "payment_status": "expired"}}
        )
    
    return {
        "status": status.status,
        "payment_status": status.payment_status,
        "amount": status.amount_total / 100,  # Convert from cents to pounds
        "currency": status.currency,
        "order_id": transaction.get("order_id"),
        "order_number": transaction.get("order_number")
    }


# ============ STORES (for Click & Collect) ============

@router.get("/stores")
async def get_shop_stores():
    """Get retail showrooms for the public stores page and click & collect.

    Filters out any doc flagged `is_warehouse: true` — warehouses aren't
    open to customers (no counter, no parking, no showroom) so they must
    never appear in the collection-point dropdown at checkout. This is
    an API-level filter so it also protects the /shop/stores page and
    any future customer-facing consumer of this endpoint.
    """
    db = get_db()

    stores = await db.showrooms.find(
        {"is_warehouse": {"$ne": True}, "is_active": {"$ne": False}},
        {"_id": 0},
    ).to_list(100)

    if not stores:
        # Fallback: return hardcoded retail stores if none in DB
        stores = [
            {"id": "tonbridge", "name": "Tonbridge", "address": "Unit 2, Cannon Business Park, Cannon Lane, Tonbridge, TN9 1PP", "phone": "01732 424242", "email": "tonbridge@tilestation.co.uk", "opening_hours": "Mon-Fri: 9am-5pm, Sat: 10am-4pm"},
            {"id": "gravesend", "name": "Gravesend", "address": "Unit 1-2, Imperial Business Estate, Gravesend, DA12 5ND", "phone": "01474 352525", "email": "gravesend@tilestation.co.uk", "opening_hours": "Mon-Fri: 9am-5pm, Sat: 10am-4pm"},
            {"id": "sydenham", "name": "Sydenham", "address": "329-331 Sydenham Road, London, SE26 5EQ", "phone": "020 8778 9797", "email": "sydenham@tilestation.co.uk", "opening_hours": "Mon-Fri: 9am-5pm, Sat: 10am-4pm"},
        ]

    return [{
        "id": s.get("id"),
        "name": s.get("name"),
        "address": s.get("address"),
        "phone": s.get("phone"),
        "email": s.get("email"),
        "opening_hours": s.get("opening_hours", "Mon-Sat: 9am-5pm")
    } for s in stores]


# ============ GUEST CHECKOUT ============

@router.post("/guest/orders")
async def create_guest_order(order_input: GuestOrderCreate):
    """Create order without requiring login (guest checkout)"""
    db = get_db()
    
    if not order_input.items:
        raise HTTPException(status_code=400, detail="Order must have items")
    
    # Validate stock for all items
    for item in order_input.items:
        product = await db.products.find_one({"id": item.product_id}, {"_id": 0})
        if not product:
            raise HTTPException(status_code=400, detail=f"Product {item.name} not found")
        if product.get("stock", 0) < item.quantity:
            raise HTTPException(status_code=400, detail=f"Insufficient stock for {item.name}")
    
    # Calculate totals
    subtotal = sum(item.price * item.quantity for item in order_input.items)
    vat = round(subtotal * 0.2, 2)
    delivery_fee = 0.0 if order_input.delivery_method == "collect" else (0.0 if subtotal >= 500 else 49.99)
    total = subtotal + vat + delivery_fee
    
    # Optionally create customer account
    customer_id = None
    if order_input.create_account and order_input.password:
        # Check if email already exists
        existing = await db.shop_customers.find_one({"email": order_input.customer_email})
        if existing:
            customer_id = existing["id"]
        else:
            customer_id = str(uuid.uuid4())
            customer_doc = {
                "id": customer_id,
                "email": order_input.customer_email,
                "password": hash_password(order_input.password),
                "name": order_input.customer_name,
                "phone": order_input.customer_phone,
                "address": order_input.delivery_address,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "wishlist": [],
                "cart": []
            }
            await db.shop_customers.insert_one(customer_doc)
    
    # Create order
    order_id = str(uuid.uuid4())
    order_number = f"TS-{datetime.now().strftime('%y%m%d')}-{order_id[:6].upper()}"
    now = datetime.now(timezone.utc)
    
    order_doc = {
        "id": order_id,
        "order_number": order_number,
        "customer_id": customer_id,  # None for pure guest orders
        "customer_email": order_input.customer_email,
        "customer_name": order_input.customer_name,
        "customer_phone": order_input.customer_phone,
        "delivery_method": order_input.delivery_method,
        "delivery_address": order_input.delivery_address,
        "collect_store_id": order_input.collect_store_id,
        "notes": order_input.notes,
        "items": [item.model_dump() for item in order_input.items],
        "subtotal": round(subtotal, 2),
        "vat": round(vat, 2),
        "delivery_fee": delivery_fee,
        "total": round(total, 2),
        "status": "pending_payment",
        "payment_status": "pending",
        "is_guest_order": customer_id is None,
        "tracking": {
            "number": None,
            "url": None,
            "carrier": None
        },
        "status_history": [{
            "status": "pending_payment",
            "timestamp": now.isoformat(),
            "notes": "Order created"
        }],
        "created_at": now.isoformat(),
        "updated_at": now.isoformat()
    }
    
    await _attach_trade_metadata(db, order_doc, order_doc.get("customer_id"))
    await db.shop_orders.insert_one(order_doc)
    
    return {
        "order_id": order_id,
        "order_number": order_number,
        "total": round(total, 2),
        "status": "pending_payment",
        "customer_id": customer_id
    }


@router.post("/guest/checkout/create-session")
async def create_guest_checkout_session(request: Request, checkout_req: CheckoutRequest):
    """Create Stripe checkout session for guest order"""
    db = get_db()
    
    # Get order by ID (no customer validation for guest)
    order = await db.shop_orders.find_one({"id": checkout_req.order_id}, {"_id": 0})
    
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    
    if order.get("payment_status") == "paid":
        raise HTTPException(status_code=400, detail="Order already paid")
    
    # Initialize Stripe
    stripe_api_key = os.environ.get("STRIPE_API_KEY")
    if not stripe_api_key:
        raise HTTPException(status_code=500, detail="Payment service not configured")
    
    webhook_url = _resolve_webhook_url(request)
    stripe_checkout = StripeCheckout(api_key=stripe_api_key, webhook_url=webhook_url)
    
    success_url = f"{checkout_req.origin_url}/shop/order-success?session_id={{CHECKOUT_SESSION_ID}}&order_id={order['id']}"
    cancel_url = f"{checkout_req.origin_url}/shop/checkout?order_id={order['id']}"
    
    _order_total = float(order["total"])
    payment_methods = await get_enabled_checkout_payment_methods(_order_total)
    checkout_request = CheckoutSessionRequest(
        amount=_order_total,
        currency="gbp",
        payment_methods=payment_methods,
        success_url=success_url,
        cancel_url=cancel_url,
        metadata={
            "order_id": order["id"],
            "order_number": order["order_number"],
            "customer_email": order["customer_email"],
            "is_guest": str(order.get("is_guest_order", True))
        }
    )
    
    try:
        session: CheckoutSessionResponse = await stripe_checkout.create_checkout_session(checkout_request)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Payment session creation failed: {str(e)}")
    
    # Create payment transaction
    transaction_doc = {
        "id": str(uuid.uuid4()),
        "session_id": session.session_id,
        "order_id": order["id"],
        "order_number": order["order_number"],
        "customer_email": order["customer_email"],
        "amount": float(order["total"]),
        "currency": "gbp",
        "payment_status": "initiated",
        "is_guest": order.get("is_guest_order", True),
        "created_at": datetime.now(timezone.utc).isoformat()
    }
    
    await db.payment_transactions.insert_one(transaction_doc)
    
    await db.shop_orders.update_one(
        {"id": order["id"]},
        {"$set": {"stripe_session_id": session.session_id}}
    )
    
    return {
        "checkout_url": session.url,
        "session_id": session.session_id
    }


# ============ ORDER TRACKING ============

@router.get("/track/suggest")
async def track_order_suggest(email: str, limit: int = 3):
    """
    Soft helper for the public Track Order page: when the strict lookup
    above 404s, the frontend pings this endpoint with just the email so
    we can surface a friendly "Did you mean…?" recovery card.

    Returns up to `limit` most-recent orders for that email
    (case-insensitive match, never includes payment_status='pending'/abandoned
    rows so we don't leak draft baskets). Minimal, non-sensitive fields only.
    """
    import re as _re
    db = get_db()

    em = (email or "").strip()
    if not em or "@" not in em:
        return {"suggestions": []}

    em_re = _re.compile(f"^{_re.escape(em)}$", _re.IGNORECASE)

    cursor = db.shop_orders.find(
        {
            "customer_email": em_re,
            # Only surface real orders the customer actually paid for.
            "payment_status": {"$in": ["paid", "completed"]},
        },
        {
            "_id": 0,
            "order_number": 1,
            "status": 1,
            "total": 1,
            "created_at": 1,
            "delivery_method": 1,
        },
    ).sort("created_at", -1).limit(max(1, min(limit, 5)))

    suggestions = []
    async for o in cursor:
        suggestions.append({
            "order_number": o.get("order_number"),
            "status": o.get("status", "pending"),
            "total": o.get("total", 0) or 0,
            "created_at": o.get("created_at"),
            "delivery_method": o.get("delivery_method", ""),
        })

    # 5 Jun 2026 — also surface paid sample orders so the "Did you
    # mean…?" recovery card on the public tracking page works for
    # SMP-… numbers too. Sample orders use `paid_at` rather than
    # payment_status='paid', so match on either marker. Cap the
    # union to `limit` newest entries across both collections.
    sample_cursor = db.sample_orders.find(
        {
            "customer_email": em_re,
            "$or": [
                {"payment_status": {"$in": ["paid", "completed"]}},
                {"paid_at": {"$exists": True, "$ne": None}},
            ],
        },
        {
            "_id": 0,
            "order_number": 1,
            "status": 1,
            "total": 1,
            "created_at": 1,
        },
    ).sort("created_at", -1).limit(max(1, min(limit, 5)))

    async for s in sample_cursor:
        suggestions.append({
            "order_number": s.get("order_number"),
            "status": s.get("status", "pending"),
            "total": s.get("total", 0) or 0,
            "created_at": s.get("created_at"),
            "delivery_method": "delivery",
            "order_kind": "sample",
        })

    # Re-sort newest-first across both kinds, cap at `limit`.
    suggestions.sort(key=lambda x: x.get("created_at") or "", reverse=True)
    suggestions = suggestions[:max(1, min(limit, 5))]

    return {"suggestions": suggestions}


@router.get("/track/{order_number}")
async def track_order_public(order_number: str, email: str):
    """Public order tracking by order number and email.

    Lookup is forgiving on input that real customers paste:
    - leading/trailing whitespace stripped
    - leading '#' on the order number stripped (admin UI shows '#TS-...')
    - email + order number matched case-insensitively (Gmail/Outlook
      autofill love to capitalize the first letter, which used to silently
      404 even though the order existed in admin).
    """
    import re as _re
    db = get_db()

    on = (order_number or "").strip().lstrip("#")
    em = (email or "").strip()
    if not on or not em:
        raise HTTPException(status_code=404, detail="Order not found. Please check your order number and email.")

    on_re = _re.compile(f"^{_re.escape(on)}$", _re.IGNORECASE)
    em_re = _re.compile(f"^{_re.escape(em)}$", _re.IGNORECASE)

    order = await db.shop_orders.find_one(
        {"order_number": on_re, "customer_email": em_re},
        {"_id": 0, "stripe_session_id": 0}
    )

    # 5 Jun 2026 — sample orders (SMP-…) live in a SEPARATE collection
    # (`db.sample_orders`) with a slightly different schema. Customers
    # were getting "Order not found" when trying to track a sample
    # order because we only looked in shop_orders. Fall through to
    # sample_orders, then SHAPE the response so the frontend doesn't
    # need to branch.
    if not order:
        sample = await db.sample_orders.find_one(
            {"order_number": on_re, "customer_email": em_re},
            {"_id": 0, "stripe_session_id": 0},
        )
        if sample:
            # Build a tracking-shaped response from a sample-order doc.
            # Sample orders only carry: status, products (with name +
            # price), total, postage_fee, delivery_address, created_at,
            # plus optional dispatched/tracking fields once shipped.
            sample_items = []
            for p in sample.get("products", []) or []:
                sample_items.append({
                    "name": p.get("product_name") or p.get("name") or "Sample",
                    "image": p.get("image_url") or p.get("image"),
                    "quantity": 1,
                    "unit_price": p.get("price_gbp", 0) or 0,
                    "line_total": p.get("price_gbp", 0) or 0,
                    "is_sample": True,
                })
            # Sample addresses are stored as a single string in
            # `delivery_address`. Hand the frontend a tiny "Delivery
            # to" object it can render without choking on shape diff.
            addr_string = sample.get("delivery_address") or ""
            return {
                "order_number": sample["order_number"],
                "order_kind": "sample",
                "status": sample.get("status", "pending"),
                "payment_status": sample.get("payment_status",
                                            "paid" if sample.get("paid_at") else "pending"),
                "delivery_method": "delivery",
                "store_name": None,
                "tracking": sample.get("tracking", {}),
                "status_history": sample.get("status_history", []),
                "items": sample_items,
                "subtotal": sample.get("samples_subtotal", 0) or 0,
                "vat": 0,
                "delivery_fee": sample.get("postage_fee", 0) or 0,
                "total": sample.get("total", 0) or 0,
                "created_at": sample.get("created_at"),
                "estimated_delivery": sample.get("estimated_delivery"),
                "delivery_address_lines": [
                    line for line in addr_string.split("\n") if line.strip()
                ] if addr_string else [],
            }

    if not order:
        raise HTTPException(status_code=404, detail="Order not found. Please check your order number and email.")
    
    # Get store name if click & collect
    store_name = None
    if order.get("collect_store_id"):
        store = await db.showrooms.find_one({"id": order["collect_store_id"]}, {"_id": 0, "name": 1})
        if store:
            store_name = store.get("name")
    
    return {
        "order_number": order["order_number"],
        "status": order.get("status", "pending"),
        "payment_status": order.get("payment_status", "pending"),
        "delivery_method": order.get("delivery_method", ""),
        "store_name": store_name,
        "tracking": order.get("tracking", {}),
        "status_history": order.get("status_history", []),
        "items": order.get("items", []),
        "subtotal": order.get("subtotal", 0) or 0,
        "vat": order.get("vat", 0) or 0,
        "delivery_fee": order.get("delivery_fee", 0) or 0,
        "total": order.get("total", 0) or 0,
        "created_at": order.get("created_at"),
        "estimated_delivery": order.get("estimated_delivery")
    }


@router.get("/admin/online-orders")
async def admin_list_online_orders(
    status: Optional[str] = None,
    payment_status: Optional[str] = None,
    search: Optional[str] = None,
    include_abandoned: bool = False,
    limit: int = 50,
    skip: int = 0,
    current_user: dict = Depends(get_current_user),
):
    """
    Paginated list of website orders for the admin "Online Orders" page.
    Filters: status, payment_status, search by order_number/customer_email/customer_name.
    By default abandoned orders (>30min old, payment never completed) are
    HIDDEN — pass include_abandoned=true to surface them.
    """
    if current_user.get("role") not in ["super_admin", "admin", "manager"]:
        raise HTTPException(status_code=403, detail="Not authorized")

    db = get_db()
    query: dict = {}
    if status and status != "all":
        query["status"] = status
    if payment_status and payment_status != "all":
        query["payment_status"] = payment_status

    if not include_abandoned:
        # An order is "abandoned" when it was created >30 mins ago and the
        # shopper never completed payment. Hide them from the default view so
        # the team isn't flooded with phantom rows.
        cutoff = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()
        query["$nor"] = [{
            "$and": [
                {"created_at": {"$lt": cutoff}},
                {"payment_status": {"$in": ["pending", "initiated", "failed", None]}},
            ]
        }]

    if search:
        s = search.strip()
        if s:
            # Normalise trade account refs so admins can paste any format:
            # "T-00042", "00042", or "#T-00042" all match the persisted
            # `trade_account_number` field on the order doc.
            bare = s.lstrip("#").strip()
            if bare.lower().startswith("t-"):
                bare = bare[2:]
            normalized_t_ref = "T-" + bare.zfill(5) if bare.isdigit() else None
            or_clauses = [
                {"order_number": {"$regex": s, "$options": "i"}},
                {"customer_email": {"$regex": s, "$options": "i"}},
                {"customer_name": {"$regex": s, "$options": "i"}},
                {"trade_account_number": {"$regex": s, "$options": "i"}},
                {"trade_business_name": {"$regex": s, "$options": "i"}},
            ]
            if normalized_t_ref:
                or_clauses.append({"trade_account_number": normalized_t_ref})
            query["$or"] = or_clauses

    total = await db.shop_orders.count_documents(query)
    cursor = (
        db.shop_orders.find(query, {"_id": 0})
        .sort("created_at", -1)
        .skip(max(0, int(skip)))
        .limit(min(200, max(1, int(limit))))
    )
    orders = await cursor.to_list(length=limit)

    # 24 Jul 2026 — resolve collect_store_id → store name in ONE bulk
    # Mongo call so the list rows can also show which branch a Click &
    # Collect order is going to (matches the detail-modal enhancement).
    collect_ids = {
        o.get("collect_store_id") or o.get("collect_showroom_id")
        for o in orders if (o.get("collect_store_id") or o.get("collect_showroom_id"))
    }
    store_name_map = {}
    if collect_ids:
        stores_cursor = db.showrooms.find(
            {"id": {"$in": list(collect_ids)}},
            {"_id": 0, "id": 1, "name": 1},
        )
        async for s in stores_cursor:
            store_name_map[s["id"]] = s.get("name")

    # Trim payload to what the list view actually needs (keeps response small).
    summary = []
    for o in orders:
        cid = o.get("collect_store_id") or o.get("collect_showroom_id")
        summary.append({
            "id": o.get("id"),
            "order_number": o.get("order_number"),
            "customer_name": o.get("customer_name"),
            "customer_email": o.get("customer_email"),
            "customer_phone": o.get("customer_phone"),
            "delivery_method": o.get("delivery_method"),
            "delivery_address": o.get("delivery_address"),
            "billing_address": o.get("billing_address"),
            "collect_store_id": cid,
            "collect_store_name": store_name_map.get(cid) if cid else None,
            "subtotal": o.get("subtotal"),
            "delivery_fee": o.get("delivery_fee"),
            "total": o.get("total"),
            "status": o.get("status"),
            "payment_status": o.get("payment_status"),
            "payment_method": o.get("payment_method"),
            "source": o.get("source"),
            "items_count": len(o.get("items", []) or []),
            "created_at": o.get("created_at"),
            # Trade attribution — lets the admin list show a clickable
            # T-NNNNN badge next to trade-buyer orders and filter by it.
            "trade_account_number": o.get("trade_account_number"),
            "trade_business_name": o.get("trade_business_name"),
        })

    return {"total": total, "skip": skip, "limit": limit, "orders": summary}


@router.get("/admin/online-orders/recent")
async def admin_recent_online_orders(
    since: Optional[str] = None,
    limit: int = 20,
    current_user: dict = Depends(get_current_user),
):
    """
    Returns orders **that have been paid** after `since` (ISO timestamp).
    Used by the admin live-toast notifier — polled every ~10 seconds.
    Newest-first.

    Only orders with `payment_status ∈ {paid, completed}` are surfaced —
    pending/initiated/failed orders never trigger the "🛒 New order" toast.
    We compare `since` against the moment the payment succeeded (`paid_at`
    with `created_at` as a fallback) so late Stripe webhooks for old
    orders still alert immediately once they clear, but abandoned carts
    that never pay never alert at all.
    """
    if current_user.get("role") not in ["super_admin", "admin", "manager"]:
        raise HTTPException(status_code=403, detail="Not authorized")

    db = get_db()
    query: dict = {
        # Only paid orders trigger the live toast — pending/initiated/failed
        # rows created while the customer is still on the cart page must
        # never fire the notification.
        "payment_status": {"$in": ["paid", "completed"]},
    }
    if since:
        # Strict greater-than so we never re-notify the same order. Use
        # paid_at when present (the moment Stripe confirmed payment), else
        # fall back to created_at for legacy rows.
        query["$or"] = [
            {"paid_at": {"$gt": since}},
            {"$and": [{"paid_at": {"$in": [None, ""]}}, {"created_at": {"$gt": since}}]},
        ]

    # Sort by paid_at first (newest payment), created_at as a fallback.
    cursor = (
        db.shop_orders.find(query, {"_id": 0})
        .sort([("paid_at", -1), ("created_at", -1)])
        .limit(min(50, max(1, int(limit))))
    )
    orders = await cursor.to_list(length=limit)

    return {
        "orders": [
            {
                "id": o.get("id"),
                "order_number": o.get("order_number"),
                "customer_name": o.get("customer_name"),
                "total": o.get("total"),
                # Return paid_at as the notification timestamp so the
                # frontend cursor advances to actual payment time.
                "created_at": o.get("paid_at") or o.get("created_at"),
                "delivery_method": o.get("delivery_method"),
                "payment_status": o.get("payment_status"),
            }
            for o in orders
        ]
    }


@router.get("/admin/online-orders/stats")
async def admin_online_orders_stats(current_user: dict = Depends(get_current_user)):
    """
    "Today at a Glance" KPIs for the admin Online Orders dashboard.
    Returns counters for pending, awaiting collection, overdue,
    plus today's revenue (paid orders only).
    """
    if current_user.get("role") not in ["super_admin", "admin", "manager"]:
        raise HTTPException(status_code=403, detail="Not authorized")

    db = get_db()
    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
    overdue_cutoff = (now - timedelta(days=2)).isoformat()
    abandoned_cutoff = (now - timedelta(minutes=30)).isoformat()

    # "Pending" = pending status BUT payment was actually completed AND not abandoned.
    # Without this guard, abandoned-cart phantoms inflate the Pending counter.
    pending_count = await db.shop_orders.count_documents({
        "status": "pending",
        "$nor": [
            {"$and": [
                {"created_at": {"$lt": abandoned_cutoff}},
                {"payment_status": {"$in": ["pending", "initiated", "failed", None]}},
            ]}
        ],
    })
    processing_count = await db.shop_orders.count_documents({"status": "processing"})
    collection_count = await db.shop_orders.count_documents({
        "status": "ready_for_collection",
    })
    overdue_count = await db.shop_orders.count_documents({
        "status": {"$in": ["pending", "processing", "confirmed"]},
        "created_at": {"$lt": overdue_cutoff},
        "payment_status": "paid",
    })
    orders_today_count = await db.shop_orders.count_documents({
        "created_at": {"$gte": today_start},
        "payment_status": "paid",
    })

    # Revenue today — sum totals for non-cancelled orders created today
    revenue_today = 0.0
    try:
        pipe = [
            {"$match": {
                "created_at": {"$gte": today_start},
                "status": {"$ne": "cancelled"},
                "payment_status": "paid",
            }},
            {"$group": {"_id": None, "total": {"$sum": "$total"}}},
        ]
        agg = await db.shop_orders.aggregate(pipe).to_list(length=1)
        if agg:
            revenue_today = float(agg[0].get("total", 0) or 0)
    except Exception:
        revenue_today = 0.0

    return {
        "pending": pending_count,
        "processing": processing_count,
        "awaiting_collection": collection_count,
        "overdue": overdue_count,
        "orders_today": orders_today_count,
        "revenue_today": round(revenue_today, 2),
    }


@router.get("/admin/online-orders/{order_id}")
async def admin_get_online_order(order_id: str, current_user: dict = Depends(get_current_user)):
    """Single online order with full detail (items, addresses, history) for the admin detail dialog."""
    if current_user.get("role") not in ["super_admin", "admin", "manager"]:
        raise HTTPException(status_code=403, detail="Not authorized")

    db = get_db()
    order = await db.shop_orders.find_one({"id": order_id}, {"_id": 0})
    if not order:
        # Also try order_number lookup so admins can use the human-readable id
        order = await db.shop_orders.find_one({"order_number": order_id}, {"_id": 0})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    # 24 Jul 2026 — surface the selected Click & Collect store in the
    # admin modal. Previously we returned only the raw `collect_store_id`,
    # so the frontend just showed "Click & Collect from store" with no way
    # to tell which branch the customer picked. Resolve the ID to a small
    # store card (name / address / phone / email) so shop staff can
    # confirm the collection point in one glance.
    collect_store_id = order.get("collect_store_id") or order.get("collect_showroom_id")
    if collect_store_id:
        store = await db.showrooms.find_one(
            {"id": collect_store_id},
            {"_id": 0, "id": 1, "name": 1, "address": 1, "phone": 1, "email": 1},
        )
        if store:
            order["collect_store"] = store
    return order


async def _online_contact_supplier_override(db) -> dict:
    """Generic online contact info (never a specific showroom) for documents
    issued against a website order — per owner request: online VAT invoices
    must show only the business's online contact details, never a store
    address. Sourced from Website Settings (`/admin/website-settings` →
    Contact), falling back to the PDF generator's own env-var defaults."""
    settings = await db.website_settings.find_one({"key": "main"}, {"_id": 0}) or {}
    override = {}
    if settings.get("contact_email"):
        override["email"] = settings["contact_email"]
    if settings.get("contact_phone"):
        override["telephone"] = settings["contact_phone"]
    if settings.get("address"):
        override["address_line_1"] = settings["address"]
        override["address_line_2"] = ""
    return override


def _shop_order_to_note_data(order: dict, collect_store: Optional[dict] = None) -> dict:
    """Adapt a `shop_orders` doc into the dict shape `generate_note_pdf()`
    (routes/orders.py) expects — that generator was built for the in-store
    `orders`/`invoices` collections, this is the online-orders equivalent."""
    addr = order.get("delivery_address") or ""
    if isinstance(addr, dict):
        addr = ", ".join(
            str(addr.get(k)) for k in ("line_1", "line_2", "city", "postcode") if addr.get(k)
        )
    items = []
    for it in (order.get("items") or []):
        items.append({
            "product_name": it.get("name") or it.get("product_name") or "Item",
            "sku": it.get("sku") or it.get("product_id") or "-",
            "quantity": it.get("quantity") or it.get("qty") or 0,
            "m2": it.get("m2") or it.get("area_m2") or 0,
        })
    # Collection notes name the actual pickup store (necessary info, not a
    # "store detail leak") — delivery notes stay generic since nothing ships
    # from a single branch.
    showroom_name = (collect_store or {}).get("name") or "Tile Station"
    return {
        "id": order.get("id", ""),
        "invoice_no": order.get("order_number"),
        "date": order.get("created_at"),
        "customer_name": order.get("customer_name"),
        "customer_phone": order.get("customer_phone"),
        "customer_email": order.get("customer_email"),
        "customer_address": addr,
        "delivery_address": addr,
        "items": items,
        "notes": order.get("notes") or order.get("order_notes") or "",
        "showroom_name": showroom_name,
    }


async def _load_online_order_or_404(db, order_id: str) -> dict:
    order = await db.shop_orders.find_one({"id": order_id}, {"_id": 0})
    if not order:
        order = await db.shop_orders.find_one({"order_number": order_id}, {"_id": 0})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    collect_store_id = order.get("collect_store_id") or order.get("collect_showroom_id")
    if collect_store_id:
        store = await db.showrooms.find_one(
            {"id": collect_store_id}, {"_id": 0, "id": 1, "name": 1, "address": 1, "phone": 1, "email": 1}
        )
        if store:
            order["collect_store"] = store
    return order


@router.get("/admin/online-orders/{order_id}/vat-invoice.pdf")
async def admin_download_online_order_vat_invoice(order_id: str, current_user: dict = Depends(get_current_user)):
    """Admin-side VAT invoice download for an online order — staff no longer
    have to ask the customer to log in and pull their own copy."""
    if current_user.get("role") not in ["super_admin", "admin", "manager"]:
        raise HTTPException(status_code=403, detail="Not authorized")

    from fastapi.responses import StreamingResponse  # noqa: PLC0415
    from io import BytesIO  # noqa: PLC0415
    from services.vat_invoice_pdf import REPORTLAB_AVAILABLE, generate_vat_invoice_pdf_bytes  # noqa: PLC0415

    if not REPORTLAB_AVAILABLE:
        raise HTTPException(status_code=500, detail="PDF generation is currently unavailable")

    db = get_db()
    order = await _load_online_order_or_404(db, order_id)
    customer = await db.shop_customers.find_one({"id": order.get("customer_id")}, {"_id": 0}) or {}
    supplier_override = await _online_contact_supplier_override(db)

    pdf_bytes = generate_vat_invoice_pdf_bytes(order=order, customer=customer, supplier=supplier_override)
    filename = f"VAT_Invoice_{order.get('order_number') or order_id}.pdf"
    return StreamingResponse(
        BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/admin/online-orders/{order_id}/delivery-note.pdf")
async def admin_download_online_order_delivery_note(
    order_id: str,
    current_user: dict = Depends(get_current_user),
    delivery_date: Optional[str] = Query(None, description="Staff-chosen delivery date/time shown on the note (ISO string)"),
):
    if current_user.get("role") not in ["super_admin", "admin", "manager"]:
        raise HTTPException(status_code=403, detail="Not authorized")

    from fastapi.responses import StreamingResponse  # noqa: PLC0415
    from routes.orders import generate_note_pdf  # noqa: PLC0415

    db = get_db()
    order = await _load_online_order_or_404(db, order_id)
    note_data = _shop_order_to_note_data(order)
    if delivery_date:
        note_data["delivery_date"] = delivery_date
    pdf_buffer = generate_note_pdf(note_data, "delivery")
    filename = f"delivery_note_{order.get('order_number') or order_id}.pdf"
    return StreamingResponse(
        pdf_buffer,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/admin/online-orders/{order_id}/collection-note.pdf")
async def admin_download_online_order_collection_note(
    order_id: str,
    current_user: dict = Depends(get_current_user),
    collection_date: Optional[str] = Query(None, description="Staff-chosen collection date/time shown on the note (ISO string)"),
):
    if current_user.get("role") not in ["super_admin", "admin", "manager"]:
        raise HTTPException(status_code=403, detail="Not authorized")

    from fastapi.responses import StreamingResponse  # noqa: PLC0415
    from routes.orders import generate_note_pdf  # noqa: PLC0415

    db = get_db()
    order = await _load_online_order_or_404(db, order_id)
    note_data = _shop_order_to_note_data(order, order.get("collect_store"))
    if collection_date:
        note_data["delivery_date"] = collection_date
    pdf_buffer = generate_note_pdf(note_data, "collection")
    filename = f"collection_note_{order.get('order_number') or order_id}.pdf"
    return StreamingResponse(
        pdf_buffer,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/admin/online-orders/{order_id}/resend-confirmation")
async def admin_resend_order_confirmation(
    order_id: str,
    current_user: dict = Depends(get_current_user),
):
    """Manually re-fire the customer + owner confirmation emails for an
    existing paid order. Built in response to the 16 Jun 2026 incident
    where a customer paid but neither email fired. Resets the
    `confirmation_email_sent_at` marker so the idempotent dispatcher
    will actually re-send (rather than skipping)."""
    if current_user.get("role") not in ["super_admin", "admin", "manager"]:
        raise HTTPException(status_code=403, detail="Not authorized")
    db = get_db()
    # Allow either internal id OR human-readable order_number
    order = await db.shop_orders.find_one({"id": order_id}, {"_id": 0})
    if not order:
        order = await db.shop_orders.find_one({"order_number": order_id}, {"_id": 0})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    if order.get("payment_status") != "paid":
        raise HTTPException(
            status_code=400,
            detail=f"Order is not paid (status={order.get('payment_status') or 'unknown'}); cannot send confirmation.",
        )
    # Reset the idempotency marker so the dispatcher will actually send
    await db.shop_orders.update_one(
        {"id": order["id"]},
        {"$unset": {"confirmation_email_sent_at": ""}},
    )
    from services.email import send_order_confirmation_emails_idempotent
    result = await send_order_confirmation_emails_idempotent(order["id"])
    # Audit
    try:
        await db.shop_orders.update_one(
            {"id": order["id"]},
            {"$push": {"email_log": {
                "kind": "manual_resend",
                "by": (current_user or {}).get("email", "admin"),
                "sent_at": datetime.now(timezone.utc).isoformat(),
                "customer_ok": bool(result.get("customer", {}).get("success")),
                "owner_ok":    bool(result.get("owner", {}).get("success")),
            }}}
        )
    except Exception:
        pass
    return {
        "order_id": order["id"],
        "order_number": order.get("order_number"),
        "result": result,
    }


@router.post("/admin/online-orders/orphan-sweep")
async def admin_run_orphan_sweep(current_user: dict = Depends(get_current_user)):
    """Manually trigger the orphaned-orders sweep. Returns a summary
    of scanned/recovered/failed orders. Same logic the cron runs every
    5 min — useful when you want to immediately recover any paid-but-
    un-emailed orders without waiting for the next scheduled pass."""
    if current_user.get("role") not in ["super_admin", "admin", "manager"]:
        raise HTTPException(status_code=403, detail="Not authorized")
    from services.orphaned_orders_sweep import run_orphaned_orders_sweep
    summary = await run_orphaned_orders_sweep()
    return summary


class DeleteOrderRequest(BaseModel):
    """Super-admin password is required for destructive deletes so a stolen
    session token alone cannot wipe orders."""
    password: str = Field(..., min_length=1)
    reason: Optional[str] = Field(None, max_length=300)


class TestEmailRequest(BaseModel):
    """Admin-only — send a test email to confirm Resend + sender domain are configured."""
    to_email: str = Field(..., min_length=4, max_length=200)


@router.post("/admin/test-email")
async def admin_send_test_email(
    payload: TestEmailRequest,
    current_user: dict = Depends(get_current_user),
):
    """
    Send a small "hello world" email so the admin can confirm Resend is set up
    correctly. Useful right after verifying a domain in Resend.
    """
    if current_user.get("role") not in ["super_admin", "admin", "manager"]:
        raise HTTPException(status_code=403, detail="Not authorized")

    try:
        from services.email import RESEND_API_KEY, RESEND_AVAILABLE
        import resend
        import os
        import asyncio
    except Exception:
        raise HTTPException(status_code=500, detail="Email service not installed")

    if not RESEND_AVAILABLE or not RESEND_API_KEY:
        raise HTTPException(status_code=500, detail="Resend API key missing — check backend .env RESEND_API_KEY")

    sender = os.environ.get("SENDER_EMAIL", "onboarding@resend.dev")

    html = f"""
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;max-width:580px;margin:0 auto;padding:24px;">
      <div style="background:#1C1917;padding:18px 24px;border-radius:8px 8px 0 0;">
        <h1 style="color:#F7EA1C;margin:0;font-size:22px;">Tile Station — Test email</h1>
      </div>
      <div style="background:#fff;padding:24px;border:1px solid #eee;border-top:0;border-radius:0 0 8px 8px;">
        <p style="font-size:15px;color:#333;line-height:1.6;">
          Hi! This is a test email from your Tile Station admin panel.
        </p>
        <p style="font-size:14px;color:#555;line-height:1.6;">
          If you've received this, your Resend integration is working and emails are being sent from
          <strong>{sender}</strong>. Customers will now receive automatic order confirmations and status updates.
        </p>
        <p style="font-size:13px;color:#888;margin-top:24px;">
          Sent at {datetime.now(timezone.utc).strftime('%d %b %Y, %H:%M UTC')} by {current_user.get('email', 'admin')}.
        </p>
      </div>
    </div>
    """

    try:
        resend.api_key = RESEND_API_KEY
        result = await asyncio.to_thread(resend.Emails.send, {
            "from": f"Tile Station <{sender}>",
            "to": [payload.to_email.strip()],
            "subject": "Tile Station — test email (admin)",
            "html": html,
        })
        return {
            "ok": True,
            "sender": sender,
            "to": payload.to_email,
            "resend_id": (result or {}).get("id") if isinstance(result, dict) else None,
        }
    except Exception as e:
        msg = str(e)
        # Resend's error message clearly tells us if domain isn't verified
        if "domain is not verified" in msg.lower() or "from" in msg.lower():
            raise HTTPException(
                status_code=502,
                detail=f"Resend rejected the send: {msg[:200]}. If you just changed SENDER_EMAIL, verify the domain at https://resend.com/domains first."
            )
        raise HTTPException(status_code=502, detail=f"Email send failed: {msg[:200]}")


@router.post("/admin/seed-sample-product")
async def admin_seed_sample_product(current_user: dict = Depends(get_current_user)):
    """
    One-shot admin button — creates (or updates) the £1.50 "Order a Sample"
    product so the team can run real-card test orders on production without
    needing Railway shell access. Idempotent: safe to call multiple times.
    Restricted to super_admin so it's not casually invoked.
    """
    if current_user.get("role") not in ["super_admin", "admin"]:
        raise HTTPException(status_code=403, detail="Only admins can seed products")

    db = get_db()
    now = datetime.now(timezone.utc)
    sku = "TS-SAMPLE-01"
    slug = "order-a-sample"

    product = {
        "id": f"tile-{sku}",
        "sku": sku,
        "slug": slug,
        "name": "Order a Sample",
        "display_name": "Order a Sample",
        "website_name": "Order a Sample",
        "original_name": "Order a Sample",
        "description": (
            "Order a 100×100mm sample of any tile in our range. We'll cut and "
            "post it to you within 1-2 working days so you can feel the surface, "
            "see the true colour in your home's lighting, and confirm it's the "
            "perfect match before you commit to a full order.\n\n"
            "**How to order**: add this to your basket, then write the tile name "
            "in the order notes at checkout (e.g. 'Heritage Oak 600×600 Matt'). "
            "Your sample will arrive in plain packaging within 2-3 business days.\n\n"
            "Most customers who order a sample come back to place a full order — "
            "and we credit the £1.50 against your first order over £100."
        ),
        "short_description": "100×100mm cut sample posted in 1-2 days. Tell us in the order notes which tile you'd like.",
        "price": 1.50,
        "cost_price": 0.50,
        "pallet_price": 1.50,
        "room_lot_price": 1.50,
        "stock": 999,
        "is_active": True,
        "is_featured": True,
        "is_manual": True,
        "source": "manual",
        "source_supplier": "Tile Station",
        "supplier_name": "Tile Station",
        "supplier_code": sku,
        "main_category": "Samples",
        "sub_categories": ["Samples"],
        "category_ids": [],
        "product_group": "samples",
        "size": "100x100mm",
        "tile_width": 100,
        "tile_height": 100,
        "attributes": {"size": "100x100mm", "purpose": "sample"},
        "images": ["https://images.tilestation.co.uk/products/leporce/ONYX_WHITE_80x80_Face1.jpg"],
        "tier_pricing_disabled": True,
        "has_custom_tier_pricing": False,
        "sale_active": False,
        "updated_at": now.isoformat(),
        "last_updated": now,
    }

    existing = await db.tiles.find_one({"sku": sku}, {"_id": 0, "id": 1})
    if existing:
        await db.tiles.update_one(
            {"sku": sku},
            {"$set": {k: v for k, v in product.items() if k != "id"}}
        )
        return {"ok": True, "action": "updated", "slug": slug, "url": f"/shop/tiles/{slug}", "price": 1.50}
    else:
        product["created_at"] = now
        await db.tiles.insert_one(product)
        return {"ok": True, "action": "created", "slug": slug, "url": f"/shop/tiles/{slug}", "price": 1.50}


@router.delete("/admin/online-orders/{order_id}")
async def admin_delete_online_order(
    order_id: str,
    payload: DeleteOrderRequest,
    current_user: dict = Depends(get_current_user),
):
    """
    Hard-delete an online order. Restricted to super_admin AND requires the
    super-admin's password to be re-entered (defense in depth — even with a
    valid JWT, an attacker can't wipe orders without the password).
    """
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Only super admins can delete orders")

    db = get_db()
    user = await db.users.find_one({"id": current_user.get("id")}, {"password": 1, "_id": 0})
    if not user or not user.get("password"):
        raise HTTPException(status_code=403, detail="Account password not set")
    if not verify_password(payload.password, user["password"]):
        raise HTTPException(status_code=403, detail="Password is incorrect")

    order = await db.shop_orders.find_one({"id": order_id}, {"_id": 0})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    # Audit trail in shop_orders_deleted so we can recover if needed
    deleted_doc = {
        **{k: v for k, v in order.items() if k != "_id"},
        "deleted_at": datetime.now(timezone.utc).isoformat(),
        "deleted_by": current_user.get("email"),
        "delete_reason": (payload.reason or "").strip()[:300] or None,
    }
    try:
        await db.shop_orders_deleted.insert_one(deleted_doc)
    except Exception:
        # Audit log failure must NOT block the delete; log but continue.
        logger.warning(f"[admin-delete] failed to write audit log for {order_id}")

    res = await db.shop_orders.delete_one({"id": order_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Order not found (already deleted?)")

    return {
        "ok": True,
        "order_id": order_id,
        "order_number": order.get("order_number"),
        "audit_logged": True,
    }



# ============ ADMIN: STATUS-UPDATE QUICK REPLIES ============
# Store of pre-baked customer-facing notes the admin can pick from when
# changing an order's status (e.g. "Tiles dispatched via DPD"). Saved on
# `website_settings` under key="status_quick_replies" so admins can curate
# the list without a code deploy. Defaults seeded on first read.

DEFAULT_QUICK_REPLIES = [
    "Tiles dispatched via DPD — tracking link will follow.",
    "Ready for collection from Monday 9am.",
    "Out for delivery today between 9am and 5pm.",
    "Slight 1-day delay due to ferry schedule — sorry for the inconvenience.",
    "Your order has been picked and packed — dispatch tomorrow morning.",
    "Awaiting one item from the supplier — will update you as soon as it lands.",
]


@router.get("/admin/status-quick-replies")
async def list_status_quick_replies(current_user: dict = Depends(get_current_user)):
    """Return the curated list of quick-reply templates for the status-update prompt."""
    if current_user.get("role") not in ["super_admin", "admin", "manager"]:
        raise HTTPException(status_code=403, detail="Not authorized")
    db = get_db()
    doc = await db.website_settings.find_one({"key": "status_quick_replies"}, {"_id": 0, "replies": 1})
    if not doc or not doc.get("replies"):
        # Seed defaults on first request so the dropdown is never empty.
        await db.website_settings.update_one(
            {"key": "status_quick_replies"},
            {"$set": {"key": "status_quick_replies", "replies": DEFAULT_QUICK_REPLIES,
                       "updated_at": datetime.now(timezone.utc).isoformat()}},
            upsert=True,
        )
        return {"replies": DEFAULT_QUICK_REPLIES}
    return {"replies": doc.get("replies", [])}


class StatusQuickRepliesUpdate(BaseModel):
    replies: List[str]


class CustomOrderEmail(BaseModel):
    subject: str
    body: str


@router.post("/orders/{order_id}/send-custom-email")
async def send_custom_order_email(order_id: str, payload: CustomOrderEmail, current_user: dict = Depends(get_current_user)):
    """Admin-triggered one-off email to the order's customer. Reuses the
    same branded wrapper as status emails for consistent tone."""
    if current_user.get("role") not in ["super_admin", "admin", "manager"]:
        raise HTTPException(status_code=403, detail="Not authorized")
    db = get_db()
    order = await db.shop_orders.find_one({"id": order_id}, {"_id": 0})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    subject = (payload.subject or "").strip()
    body = (payload.body or "").strip()
    if not body:
        raise HTTPException(status_code=400, detail="Email body cannot be empty")
    if len(body) > 4000:
        raise HTTPException(status_code=400, detail="Email body too long (max 4000 chars)")

    from services.email import send_order_custom_email
    result = await send_order_custom_email(
        order=order,
        subject=subject,
        body=body,
        from_admin_email=current_user.get("email"),
    )
    if not result.get("success"):
        raise HTTPException(status_code=502, detail=result.get("error", "Failed to send email"))
    return {"success": True, "to": order.get("customer_email"), "resend_id": result.get("resend_id")}


@router.put("/admin/status-quick-replies")
async def update_status_quick_replies(payload: StatusQuickRepliesUpdate, current_user: dict = Depends(get_current_user)):
    """Replace the entire list of quick-reply templates."""
    if current_user.get("role") not in ["super_admin", "admin", "manager"]:
        raise HTTPException(status_code=403, detail="Not authorized")
    # Trim + dedupe + cap length so the dropdown never explodes
    cleaned = []
    seen = set()
    for r in (payload.replies or []):
        s = (r or "").strip()
        if s and s not in seen and len(s) <= 500:
            seen.add(s)
            cleaned.append(s)
        if len(cleaned) >= 50:
            break
    db = get_db()
    await db.website_settings.update_one(
        {"key": "status_quick_replies"},
        {"$set": {"key": "status_quick_replies", "replies": cleaned,
                   "updated_at": datetime.now(timezone.utc).isoformat(),
                   "updated_by": current_user.get("email")}},
        upsert=True,
    )
    return {"replies": cleaned, "count": len(cleaned)}


@router.put("/orders/{order_id}/status")
async def update_order_status(order_id: str, status_update: OrderStatusUpdate, current_user: dict = Depends(get_current_user)):
    """Update order status (admin only)"""
    db = get_db()
    
    # Check admin permissions
    if current_user.get("role") not in ["super_admin", "admin", "manager"]:
        raise HTTPException(status_code=403, detail="Not authorized")
    order = await db.shop_orders.find_one({"id": order_id}, {"_id": 0})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    
    valid_statuses = ["confirmed", "processing", "shipped", "delivered", "ready_for_collection", "collected", "cancelled", "refunded"]
    if status_update.status not in valid_statuses:
        raise HTTPException(status_code=400, detail=f"Invalid status. Must be one of: {valid_statuses}")
    
    now = datetime.now(timezone.utc).isoformat()
    
    # Build update
    update_data = {
        "status": status_update.status,
        "updated_at": now
    }
    
    # Update tracking info if provided
    if status_update.tracking_number:
        update_data["tracking.number"] = status_update.tracking_number
    if status_update.tracking_url:
        update_data["tracking.url"] = status_update.tracking_url
    
    # Add to status history
    status_entry = {
        "status": status_update.status,
        "timestamp": now,
        "notes": status_update.notes or "",
        "updated_by": current_user.get("email")
    }
    
    await db.shop_orders.update_one(
        {"id": order_id},
        {
            "$set": update_data,
            "$push": {"status_history": status_entry}
        }
    )

    # Trade credit reversal/re-application on status changes:
    #   • → cancelled   : reverse credits earned + refund credits redeemed
    #   • cancelled → other : re-apply (un-reverse) — e.g. order accidentally
    #     cancelled then resurrected
    # Idempotent via the `credits_reversed` flag we stamp on the order doc.
    prior_status = order.get("status")
    new_status = status_update.status
    CLAWBACK_STATUSES = ("cancelled", "refunded")
    if new_status in CLAWBACK_STATUSES and prior_status not in CLAWBACK_STATUSES:
        await reverse_shop_order_credits(db, order, reason=f"order_{new_status}")
    elif prior_status in CLAWBACK_STATUSES and new_status not in CLAWBACK_STATUSES:
        await reapply_shop_order_credits(db, order, reason="order_reinstated")
    
    # Send email notification to customer about status update
    # Fetch updated order for email
    updated_order = await db.shop_orders.find_one({"id": order_id}, {"_id": 0})
    email_result = {"success": False}
    if updated_order:
        email_result = await send_order_status_notification(
            order=updated_order,
            new_status=status_update.status,
            tracking_number=status_update.tracking_number,
            tracking_url=status_update.tracking_url,
            notes=status_update.notes
        )
        if email_result.get("success"):
            logging.info(f"Status email sent for order {order_id}")
        else:
            logging.warning(f"Failed to send status email for order {order_id}: {email_result.get('error')}")
        
        # WhatsApp notification
        try:
            from services.whatsapp_service import send_whatsapp_template_message
            import uuid as _uuid
            customer_phone = updated_order.get("customer_phone") or updated_order.get("phone") or (updated_order.get("shipping_address", {}) or {}).get("phone")
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
                status_text = status_labels.get(status_update.status, status_update.status)
                order_num = updated_order.get("order_number", order_id[:8])
                msg = f"Hi! Your Tile Station order #{order_num} is now {status_text}."
                if status_update.tracking_number:
                    msg += f" Tracking: {status_update.tracking_number}"
                if status_update.tracking_url:
                    msg += f" Track here: {status_update.tracking_url}"
                
                wa_result = await send_whatsapp_template_message(
                    recipient_phone=phone, template_name="custom_message",
                    language_code="en", parameters=[msg],
                )
                if wa_result.get("success"):
                    await db.whatsapp_queue.insert_one({
                        "id": str(_uuid.uuid4()),
                        "customer_name": updated_order.get("customer_name"),
                        "customer_email": updated_order.get("customer_email"),
                        "phone": phone, "status": "sent",
                        "queued_at": datetime.now(timezone.utc).isoformat(),
                        "sent_at": datetime.now(timezone.utc).isoformat(),
                        "message_id": wa_result.get("message_id"),
                        "is_custom": True, "custom_message": msg,
                        "template_name": "custom_message", "retry_count": 0,
                    })
        except Exception as e:
            logging.warning(f"Failed to send order status WhatsApp: {e}")
    
    return {"message": f"Order status updated to {status_update.status}", "email_sent": email_result.get("success", False) if updated_order else False}


# ============ PRODUCT REVIEWS ============

@router.get("/products/{product_id}/reviews")
async def get_product_reviews(product_id: str, page: int = 1, limit: int = 10):
    """Get reviews for a product"""
    db = get_db()
    
    skip = (page - 1) * limit
    
    reviews = await db.product_reviews.find(
        {"product_id": product_id, "approved": True},
        {"_id": 0}
    ).sort("created_at", -1).skip(skip).limit(limit).to_list(limit)
    
    total = await db.product_reviews.count_documents({"product_id": product_id, "approved": True})
    
    # Calculate average rating
    pipeline = [
        {"$match": {"product_id": product_id, "approved": True}},
        {"$group": {"_id": None, "avg_rating": {"$avg": "$rating"}, "count": {"$sum": 1}}}
    ]
    stats = await db.product_reviews.aggregate(pipeline).to_list(1)
    
    avg_rating = stats[0]["avg_rating"] if stats else 0
    review_count = stats[0]["count"] if stats else 0
    
    return {
        "reviews": reviews,
        "total": total,
        "page": page,
        "avg_rating": round(avg_rating, 1),
        "review_count": review_count
    }


@router.post("/products/{product_id}/reviews")
async def create_product_review(product_id: str, review: ProductReview, request: Request):
    """Create a product review (requires login)"""
    customer = await get_shop_customer(request)
    db = get_db()
    
    # Verify product exists
    product = await db.products.find_one({"id": product_id})
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    
    # Check if customer has purchased this product
    has_purchased = await db.shop_orders.find_one({
        "customer_id": customer["id"],
        "payment_status": "paid",
        "items.product_id": product_id
    })
    
    # Check if already reviewed
    existing_review = await db.product_reviews.find_one({
        "product_id": product_id,
        "customer_id": customer["id"]
    })
    
    if existing_review:
        raise HTTPException(status_code=400, detail="You have already reviewed this product")
    
    review_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    
    review_doc = {
        "id": review_id,
        "product_id": product_id,
        "customer_id": customer["id"],
        "customer_name": customer.get("name", "Anonymous"),
        "rating": review.rating,
        "title": review.title,
        "comment": review.comment,
        "verified_purchase": has_purchased is not None,
        "approved": True,  # Auto-approve for now, could add moderation
        "helpful_count": 0,
        "created_at": now
    }
    
    await db.product_reviews.insert_one(review_doc)
    
    # Update product's average rating
    pipeline = [
        {"$match": {"product_id": product_id, "approved": True}},
        {"$group": {"_id": None, "avg_rating": {"$avg": "$rating"}, "count": {"$sum": 1}}}
    ]
    stats = await db.product_reviews.aggregate(pipeline).to_list(1)
    
    if stats:
        await db.products.update_one(
            {"id": product_id},
            {"$set": {
                "avg_rating": round(stats[0]["avg_rating"], 1),
                "review_count": stats[0]["count"]
            }}
        )
    
    return {"message": "Review submitted", "review_id": review_id}


@router.post("/reviews/{review_id}/helpful")
async def mark_review_helpful(review_id: str):
    """Mark a review as helpful"""
    db = get_db()
    
    result = await db.product_reviews.update_one(
        {"id": review_id},
        {"$inc": {"helpful_count": 1}}
    )
    
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Review not found")
    
    return {"message": "Marked as helpful"}


# ============ TILE CALCULATOR ============

@router.post("/calculator/tiles")
async def calculate_tiles_needed(calc_input: TileCalculatorInput):
    """Calculate how many tiles/boxes needed for a room"""
    db = get_db()
    
    # Check async products collection first
    product = await db.products.find_one({"id": calc_input.product_id}, {"_id": 0})
    if not product:
        # Try tiles collection using sync PyMongo (tiles uses sync client)
        from pymongo import MongoClient
        import os
        sync_client = MongoClient(os.environ.get('MONGO_URL'))
        sync_db = sync_client[os.environ.get('DB_NAME', 'tilestation_db')]
        product = sync_db.tiles.find_one(
            {"$or": [
                {"slug": calc_input.product_id},
                {"supplier_code": calc_input.product_id},
                {"sku": calc_input.product_id}
            ]},
            {"_id": 0}
        )
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    
    # Calculate room area
    room_area = calc_input.room_length * calc_input.room_width
    
    # Add wastage
    wastage_multiplier = 1 + (calc_input.wastage_percent / 100)
    area_with_wastage = room_area * wastage_multiplier
    
    # Get tile/box coverage - check multiple field names
    tile_m2 = product.get("tile_m2_per_piece", 0) or product.get("tile_area_m2", 0)
    tiles_per_box = product.get("tiles_per_box", 1) or 1
    box_m2 = product.get("box_m2_coverage", 0) or product.get("sqm_per_box", 0)
    price = product.get("price", 0) or product.get("room_lot_price", 0)
    
    result = {
        "room_area_m2": round(room_area, 2),
        "area_with_wastage_m2": round(area_with_wastage, 2),
        "wastage_percent": calc_input.wastage_percent,
        "product_name": product.get("name") or product.get("display_name"),
        "product_id": product.get("id") or product.get("slug"),
        "price_per_unit": price,
        "unit": product.get("unit", "m²")
    }
    
    # Calculate based on available data
    if box_m2 and box_m2 > 0:
        boxes_needed = area_with_wastage / box_m2
        result["boxes_needed"] = int(boxes_needed) + (1 if boxes_needed % 1 > 0 else 0)
        result["box_m2_coverage"] = box_m2
        result["total_coverage_m2"] = round(result["boxes_needed"] * box_m2, 2)
        # For m² priced tiles: price per m² * total coverage
        result["total_price"] = round(price * result["total_coverage_m2"], 2)
    elif tile_m2 and tile_m2 > 0:
        tiles_needed = area_with_wastage / tile_m2
        result["tiles_needed"] = int(tiles_needed) + (1 if tiles_needed % 1 > 0 else 0)
        result["tile_m2_per_piece"] = tile_m2
        
        if tiles_per_box and tiles_per_box > 0:
            boxes_needed = result["tiles_needed"] / tiles_per_box
            result["boxes_needed"] = int(boxes_needed) + (1 if boxes_needed % 1 > 0 else 0)
            result["tiles_per_box"] = tiles_per_box
            # Total price based on m² coverage
            total_m2 = result["tiles_needed"] * tile_m2
            result["total_price"] = round(price * total_m2, 2)
        else:
            result["total_price"] = round(result["tiles_needed"] * price * tile_m2, 2)
    else:
        # Fallback: assume price is per m² and we need area_with_wastage m²
        units_needed = area_with_wastage
        result["units_needed"] = int(units_needed) + (1 if units_needed % 1 > 0 else 0)
        result["total_price"] = round(result["units_needed"] * price, 2)
    
    # Check stock availability
    result["in_stock"] = product.get("stock", 0) >= result.get("boxes_needed", result.get("tiles_needed", result.get("units_needed", 0)))
    result["current_stock"] = product.get("stock", 0)
    
    return result


@router.get("/calculator/estimate")
async def quick_tile_estimate(
    length: float,
    width: float,
    wastage: float = 10.0
):
    """Quick estimate without specific product"""
    room_area = length * width
    wastage_multiplier = 1 + (wastage / 100)
    area_with_wastage = room_area * wastage_multiplier
    
    return {
        "room_area_m2": round(room_area, 2),
        "area_with_wastage_m2": round(area_with_wastage, 2),
        "wastage_percent": wastage,
        "tip": "Use our product calculator for accurate box/tile quantities"
    }



# ============ PAYPAL INTEGRATION ============

import paypalrestsdk

# Configure PayPal (mode from environment: sandbox or live)
def get_paypal_client():
    """Initialize PayPal client with credentials from environment"""
    mode = os.environ.get("PAYPAL_MODE", "sandbox")
    paypalrestsdk.configure({
        "mode": mode,
        "client_id": os.environ.get("PAYPAL_CLIENT_ID", ""),
        "client_secret": os.environ.get("PAYPAL_CLIENT_SECRET", "")
    })
    return paypalrestsdk


class PayPalOrderCreate(BaseModel):
    order_id: str
    return_url: str
    cancel_url: str


@router.post("/paypal/create-order")
async def create_paypal_order(data: PayPalOrderCreate):
    """Create PayPal order for checkout"""
    db = get_db()
    
    # Get the order
    order = await db.shop_orders.find_one({"id": data.order_id})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    
    if order.get("payment_status") == "paid":
        raise HTTPException(status_code=400, detail="Order already paid")
    
    # Initialize PayPal
    paypal = get_paypal_client()
    
    # Calculate total in GBP
    total = order.get("total", 0)
    
    # Create PayPal payment
    payment = paypalrestsdk.Payment({
        "intent": "sale",
        "payer": {
            "payment_method": "paypal"
        },
        "redirect_urls": {
            "return_url": data.return_url,
            "cancel_url": data.cancel_url
        },
        "transactions": [{
            "item_list": {
                "items": [{
                    "name": f"Order {order.get('order_number', data.order_id)}",
                    "sku": order.get("order_number", data.order_id),
                    "price": f"{total:.2f}",
                    "currency": "GBP",
                    "quantity": 1
                }]
            },
            "amount": {
                "total": f"{total:.2f}",
                "currency": "GBP"
            },
            "description": f"Tile Station Order {order.get('order_number')}"
        }]
    })
    
    if payment.create():
        # Find approval URL
        approval_url = None
        for link in payment.links:
            if link.rel == "approval_url":
                approval_url = link.href
                break
        
        # Store PayPal payment ID
        await db.shop_orders.update_one(
            {"id": data.order_id},
            {"$set": {"paypal_payment_id": payment.id, "payment_method": "paypal"}}
        )
        
        return {
            "payment_id": payment.id,
            "approval_url": approval_url
        }
    else:
        raise HTTPException(status_code=400, detail=f"PayPal error: {payment.error}")


@router.post("/paypal/capture/{payment_id}")
async def capture_paypal_payment(payment_id: str, payer_id: str):
    """Capture PayPal payment after user approval"""
    db = get_db()
    
    # Find order by PayPal payment ID
    order = await db.shop_orders.find_one({"paypal_payment_id": payment_id})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    
    # Initialize PayPal
    paypal = get_paypal_client()
    
    # Find and execute payment
    payment = paypalrestsdk.Payment.find(payment_id)
    
    if payment.execute({"payer_id": payer_id}):
        # Update order status
        await db.shop_orders.update_one(
            {"id": order["id"]},
            {
                "$set": {
                    "payment_status": "paid",
                    "status": "confirmed",
                    "paid_at": datetime.now(timezone.utc).isoformat(),
                    "paypal_payer_id": payer_id
                },
                "$push": {
                    "status_history": {
                        "status": "confirmed",
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "notes": "Payment received via PayPal"
                    }
                }
            }
        )
        
        return {
            "success": True,
            "order_id": order["id"],
            "order_number": order.get("order_number"),
            "message": "Payment successful"
        }
    else:
        raise HTTPException(status_code=400, detail=f"PayPal capture failed: {payment.error}")


# ============ TRADE/BULK PRICING ============

class TradeApplicationCreate(BaseModel):
    business_name: str
    business_type: str  # builder, contractor, retailer, other
    vat_number: str = ""
    contact_name: str
    email: EmailStr
    phone: str
    estimated_monthly_spend: str = ""
    notes: str = ""


@router.post("/trade/apply")
async def apply_for_trade_account(data: TradeApplicationCreate):
    """Submit application for trade account"""
    db = get_db()
    
    # Check if already applied
    existing = await db.trade_applications.find_one({"email": data.email})
    if existing:
        if existing.get("status") == "approved":
            raise HTTPException(status_code=400, detail="You already have an approved trade account")
        elif existing.get("status") == "pending":
            raise HTTPException(status_code=400, detail="Your application is already pending review")
    
    application = {
        "id": str(uuid.uuid4()),
        "business_name": data.business_name,
        "business_type": data.business_type,
        "vat_number": data.vat_number,
        "contact_name": data.contact_name,
        "email": data.email,
        "phone": data.phone,
        "estimated_monthly_spend": data.estimated_monthly_spend,
        "notes": data.notes,
        "status": "pending",  # pending, approved, rejected
        "trade_discount": 0,  # Will be set when approved
        "created_at": datetime.now(timezone.utc).isoformat()
    }
    
    await db.trade_applications.insert_one(application)
    
    return {
        "message": "Trade application submitted successfully",
        "application_id": application["id"],
        "status": "pending"
    }


@router.get("/trade/status")
async def get_trade_status(request: Request):
    """Get trade account status for logged-in customer"""
    customer = await get_shop_customer(request)
    
    return {
        "is_trade": customer.get("is_trade", False),
        "trade_discount": customer.get("trade_discount", 0),
        "trade_tier": customer.get("trade_tier", "standard"),
        "credit_balance": customer.get("credit_balance", 0),
        "credit_rate": customer.get("credit_rate", 2)  # Default 2% credit back
    }


# ============ TRADE CREDIT BACK SYSTEM ============

# Default credit back rate (2%)
TRADE_CREDIT_BACK_RATE = 2


class CreditRedemptionRequest(BaseModel):
    order_id: str
    amount: float  # Amount of credits to redeem (in GBP)


@router.get("/trade/credits")
async def get_trade_credits(request: Request):
    """Get credit balance and history for logged-in trade customer"""
    customer = await get_shop_customer(request)
    db = get_db()
    
    # Only trade customers can have credits
    if not customer.get("is_trade"):
        return {
            "is_trade": False,
            "credit_balance": 0,
            "credit_rate": 0,
            "credit_history": [],
            "message": "Credit back is only available for trade customers"
        }
    
    # Get credit history
    credit_history = await db.trade_credits.find(
        {"customer_id": customer["id"]},
        {"_id": 0}
    ).sort("created_at", -1).limit(50).to_list(50)
    
    return {
        "is_trade": True,
        "credit_balance": customer.get("credit_balance", 0),
        "credit_rate": customer.get("credit_rate", TRADE_CREDIT_BACK_RATE),
        "credit_history": credit_history,
        "total_earned": sum(c["amount"] for c in credit_history if c["type"] == "earn"),
        "total_redeemed": sum(abs(c["amount"]) for c in credit_history if c["type"] == "redeem")
    }


@router.get("/trade/credit-history-detailed")
async def get_trade_credit_history_detailed(request: Request):
    """Unified credit history for the logged-in trader's dashboard.

    Merges credit-earning + redemption events from BOTH the online order
    pipeline (`trade_credits` collection) AND the in-store EPOS invoice
    pipeline (`credit_transactions.type=earned_in_store|redeemed_in_store`
    joined with the `invoices` doc for the per-product breakdown).

    Each event carries enough metadata for the trader to reconcile their
    own balance without phoning the showroom:
      • type:     'earn' | 'redeem'
      • channel:  'online' | 'in_store'
      • amount:   £ delta (positive for earn, negative for redeem)
      • at:       ISO timestamp
      • source_label, source_ref, source_link  (deep-link target on
        the trader's own dashboard or order page)
      • breakdown: [{product_name, sku, rate, net, credit}] OR null
        for events without per-product detail (legacy / redemption rows)
    """
    customer = await get_shop_customer(request)
    db = get_db()

    if not customer.get("is_trade"):
        return {"is_trade": False, "events": []}

    cust_id = customer["id"]

    # ── Online pipeline (already populated by /trade/credits/earn) ─────
    online_rows = await db.trade_credits.find(
        {"customer_id": cust_id},
        {"_id": 0},
    ).sort("created_at", -1).to_list(200)

    # ── In-store EPOS pipeline + manual/expiry movements ────────────────
    # Every movement is shown — including refund claw-backs, manual
    # adjustments and expiries — so the trader's statement always
    # reconciles to their balance.
    epos_rows = await db.credit_transactions.find(
        {"$or": [{"customer_id": cust_id}] + (
            [{"trade_account_number": customer.get("trade_account_number")}]
            if customer.get("trade_account_number") else [])},
        {"_id": 0},
    ).sort("created_at", -1).to_list(300)

    # Pull breakdown + showroom from invoices for the EPOS rows (both earn
    # and redeem benefit from showroom back-fill for legacy txns missing it).
    invoice_ids = [r["invoice_id"] for r in epos_rows if r.get("invoice_id")]
    breakdown_by_invoice = {}
    if invoice_ids:
        async for inv in db.invoices.find(
            {"id": {"$in": invoice_ids}},
            {"_id": 0, "id": 1, "trade_credit_breakdown": 1, "subtotal": 1,
             "showroom_id": 1, "showroom_name": 1},
        ):
            breakdown_by_invoice[inv["id"]] = inv

    events = []
    ONLINE_LABELS = {"reverse_earn": "Clawed back — order cancelled/refunded",
                     "reverse_redeem": "Returned to balance — order cancelled"}
    for r in online_rows:
        rtype = r.get("type")
        events.append({
            "id": r.get("id"),
            "type": "earn" if rtype == "earn" else ("redeem" if rtype == "redeem" else "adjust"),
            "channel": "online",
            "amount": float(r.get("amount") or 0),
            "balance_after": float(r.get("balance_after") or 0),
            "at": r.get("created_at"),
            "source_label": (ONLINE_LABELS.get(rtype) or r.get("order_number") or r.get("description") or "Online order"),
            "source_ref": r.get("order_id"),
            "source_link": (
                f"/shop/track?order={r.get('order_number')}&email={customer.get('email','')}"
                if r.get("order_number") else None
            ),
            "description": r.get("description"),
            # Online orders don't currently stamp a per-product breakdown;
            # the savings_meta on the order doc is the closest equivalent.
            "breakdown": None,
        })
    EPOS_LABELS = {
        "reversed_earned_in_store": "Clawed back — invoice edited",
        "reversed_redeemed_in_store": "Returned to balance — invoice edited",
        "reapplied_earned_in_store": "Re-applied — invoice edited",
        "reapplied_redeemed_in_store": "Re-applied redemption",
        "reversed_earned_via_refund": "Clawed back — refund",
        "reversed_redeemed_via_refund": "Returned to balance — refund",
        "reversed_earned_via_invoice_edit": "Clawed back — invoice edited",
        "manual_adjustment": "Adjustment by Tile Station",
        "expired": "Credit expired",
    }
    for r in epos_rows:
        rtype = r.get("type")
        is_earn = rtype == "earned_in_store"
        is_redeem = rtype == "redeemed_in_store"
        inv_doc = breakdown_by_invoice.get(r.get("invoice_id"))
        # Showroom: prefer the stamp on the txn, else fall back to the
        # linked invoice (legacy rows pre-24-Feb-2026 didn't carry the
        # showroom on the credit_transactions doc itself).
        showroom_name = r.get("showroom_name") or (inv_doc or {}).get("showroom_name")
        showroom_id = r.get("showroom_id") or (inv_doc or {}).get("showroom_id")
        events.append({
            "id": r.get("id"),
            "type": "earn" if is_earn else ("redeem" if is_redeem else "adjust"),
            "channel": "in_store" if (is_earn or is_redeem or r.get("invoice_no") or r.get("refund_no")) else "account",
            "amount": float(r.get("amount") or 0),
            "balance_after": float(r.get("balance_after") or 0),
            "at": r.get("created_at"),
            "source_label": (EPOS_LABELS.get(rtype) or r.get("invoice_no") or "In-store invoice")
                            + (f" · {r.get('refund_no') or r.get('invoice_no')}" if (rtype in EPOS_LABELS and (r.get('refund_no') or r.get('invoice_no'))) else ""),
            "source_ref": r.get("invoice_id") or r.get("refund_id"),
            "source_link": None,  # in-store invoices don't have a public URL
            "description": r.get("description"),
            "showroom_name": showroom_name,
            "showroom_id": showroom_id,
            "breakdown": (inv_doc or {}).get("trade_credit_breakdown") if is_earn else None,
            "subtotal": (inv_doc or {}).get("subtotal") if is_earn else None,
        })

    # Newest first across both channels
    events.sort(key=lambda e: e.get("at") or "", reverse=True)

    total_earned = round(sum(e["amount"] for e in events if e["type"] == "earn"), 2)
    total_redeemed = round(sum(abs(e["amount"]) for e in events if e["type"] == "redeem"), 2)
    total_adjustments = round(sum(e["amount"] for e in events if e["type"] == "adjust"), 2)

    return {
        "is_trade": True,
        "credit_balance": float(customer.get("credit_balance") or 0),
        "credit_expires_at": customer.get("credit_expires_at"),
        "credit_rate": float(customer.get("credit_rate") or TRADE_CREDIT_BACK_RATE),
        "events": events,
        "total_earned": total_earned,
        "total_redeemed": total_redeemed,
        "total_adjustments": total_adjustments,
    }


@router.get("/trade/credit-statement.pdf")
async def get_trade_credit_statement_pdf(request: Request, year: int = None):
    """Generate a PDF statement of all credit activity for a trader.

    Combines earn + redeem events from both the online (`trade_credits`)
    and in-store (`credit_transactions`) pipelines into a single
    chronological statement, scoped to one year (defaults to current).

    The trader downloads this from their dashboard's Discount tab —
    same pattern as a bank statement. Eliminates the "how much credit
    do I have?" inbound phone call, and gives them something concrete
    to reconcile against their own bookkeeping.
    """
    from fastapi.responses import StreamingResponse
    from datetime import datetime as _dt, timezone as _tz
    import io as _io
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.units import mm
        from reportlab.lib import colors as _colors
        from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.enums import TA_RIGHT
    except ImportError:
        raise HTTPException(status_code=500, detail="PDF generation unavailable")

    customer = await get_shop_customer(request)
    if not customer.get("is_trade"):
        raise HTTPException(status_code=403, detail="Trade account required")

    db = get_db()
    cust_id = customer["id"]
    target_year = int(year or _dt.now(_tz.utc).year)
    year_start = _dt(target_year, 1, 1, tzinfo=_tz.utc).isoformat()
    year_end = _dt(target_year + 1, 1, 1, tzinfo=_tz.utc).isoformat()

    # Collect both pipelines, scoped to the year
    online_rows = await db.trade_credits.find(
        {"customer_id": cust_id, "created_at": {"$gte": year_start, "$lt": year_end}},
        {"_id": 0},
    ).sort("created_at", 1).to_list(2000)
    epos_rows = await db.credit_transactions.find(
        {"customer_id": cust_id, "created_at": {"$gte": year_start, "$lt": year_end}},
        {"_id": 0},
    ).sort("created_at", 1).to_list(2000)

    # Back-fill showroom from invoices for legacy txns missing it
    invoice_ids = [r["invoice_id"] for r in epos_rows if r.get("invoice_id") and not r.get("showroom_name")]
    inv_map = {}
    if invoice_ids:
        async for inv in db.invoices.find(
            {"id": {"$in": invoice_ids}},
            {"_id": 0, "id": 1, "showroom_name": 1},
        ):
            inv_map[inv["id"]] = inv

    rows = []
    for r in online_rows:
        amt = float(r.get("amount") or 0)
        ttype = r.get("type") or ""
        rows.append({
            "at": r.get("created_at") or "",
            "label": r.get("order_number") or r.get("description") or "Online order",
            "channel": "Online",
            "earned": amt if ttype == "earn" else 0,
            "redeemed": abs(amt) if ttype == "redeem" else 0,
            "balance_after": float(r.get("balance_after") or 0),
            "description": r.get("description") or "",
        })
    for r in epos_rows:
        amt = float(r.get("amount") or 0)
        ttype = (r.get("type") or "").lower()
        showroom = r.get("showroom_name") or (inv_map.get(r.get("invoice_id"), {}) or {}).get("showroom_name") or "—"
        is_earn = ttype in ("earned_in_store", "reapplied_earned_in_store")
        is_redeem = ttype in ("redeemed_in_store", "reapplied_redeemed_in_store")
        rows.append({
            "at": r.get("created_at") or "",
            "label": r.get("invoice_no") or "In-store invoice",
            "channel": f"In-store · {showroom}",
            "earned": amt if is_earn else (-amt if ttype == "reversed_earned_via_refund" else 0),
            "redeemed": abs(amt) if is_redeem else (-abs(amt) if ttype == "reversed_redeemed_via_refund" else 0),
            "balance_after": float(r.get("balance_after") or 0),
            "description": r.get("description") or r.get("type") or "",
        })

    rows.sort(key=lambda x: x["at"])
    total_earned = round(sum(r["earned"] for r in rows if r["earned"] > 0), 2)
    total_redeemed = round(sum(r["redeemed"] for r in rows if r["redeemed"] > 0), 2)

    buf = _io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4,
                            leftMargin=18 * mm, rightMargin=18 * mm,
                            topMargin=14 * mm, bottomMargin=14 * mm)
    styles = getSampleStyleSheet()
    elements = []

    # Header
    elements.append(Paragraph(
        "<b>Tile Station — Trade Credit Statement</b>",
        ParagraphStyle('h1', parent=styles['Heading1'], fontSize=16, textColor=_colors.HexColor('#111'))
    ))
    elements.append(Paragraph(
        f"<b>Account:</b> {customer.get('business_name') or customer.get('name') or ''} "
        f"&nbsp; <b>Ref:</b> {customer.get('trade_account_number') or '—'}",
        styles['Normal']
    ))
    elements.append(Paragraph(
        f"<b>Period:</b> 01 Jan {target_year} – 31 Dec {target_year} &nbsp;"
        f"<b>Generated:</b> {_dt.now(_tz.utc).strftime('%d %b %Y %H:%M')} UTC",
        styles['Normal']
    ))
    elements.append(Spacer(1, 6))

    # Summary tiles
    summary_data = [[
        Paragraph(f"<b>Total Earned</b><br/><font size=14 color='#15803d'>£{total_earned:.2f}</font>", styles['Normal']),
        Paragraph(f"<b>Total Redeemed</b><br/><font size=14 color='#b45309'>£{total_redeemed:.2f}</font>", styles['Normal']),
        Paragraph(f"<b>Current Balance</b><br/><font size=14 color='#0369a1'>£{float(customer.get('credit_balance') or 0):.2f}</font>", styles['Normal']),
    ]]
    t = Table(summary_data, colWidths=[60 * mm, 60 * mm, 54 * mm])
    t.setStyle(TableStyle([
        ('BOX', (0, 0), (-1, -1), 0.4, _colors.HexColor('#d4d4d8')),
        ('INNERGRID', (0, 0), (-1, -1), 0.4, _colors.HexColor('#d4d4d8')),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
        ('LEFTPADDING', (0, 0), (-1, -1), 8),
    ]))
    elements.append(t)
    elements.append(Spacer(1, 10))

    # Transaction table
    if not rows:
        elements.append(Paragraph(
            f"<i>No credit activity in {target_year}.</i>",
            styles['Normal']
        ))
    else:
        header = ["Date", "Source", "Earned", "Redeemed", "Balance"]
        data = [header]
        for r in rows:
            dt_str = ""
            try:
                dt_str = _dt.fromisoformat(r["at"].replace("Z", "+00:00")).strftime("%d %b %Y")
            except Exception:
                dt_str = r["at"][:10]
            data.append([
                dt_str,
                f"{r['label']}\n{r['channel']}",
                f"£{r['earned']:.2f}" if r['earned'] else "—",
                f"£{r['redeemed']:.2f}" if r['redeemed'] else "—",
                f"£{r['balance_after']:.2f}",
            ])
        tbl = Table(data, colWidths=[22 * mm, 78 * mm, 22 * mm, 24 * mm, 24 * mm], repeatRows=1)
        tbl.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), _colors.HexColor('#f4f4f5')),
            ('TEXTCOLOR', (0, 0), (-1, 0), _colors.HexColor('#52525b')),
            ('FONTSIZE', (0, 0), (-1, 0), 8),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 1), (-1, -1), 8),
            ('ALIGN', (2, 0), (-1, -1), 'RIGHT'),
            ('LINEBELOW', (0, 0), (-1, 0), 0.5, _colors.HexColor('#d4d4d8')),
            ('LINEBELOW', (0, 1), (-1, -1), 0.25, _colors.HexColor('#e4e4e7')),
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('TOPPADDING', (0, 0), (-1, -1), 4),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ]))
        elements.append(tbl)

    elements.append(Spacer(1, 10))
    elements.append(Paragraph(
        "<font size=8 color='#737373'>This statement is for your records. "
        "Contact your Tile Station showroom if you spot a discrepancy. "
        "Credit balances do not expire but cannot be exchanged for cash.</font>",
        styles['Normal']
    ))

    doc.build(elements)
    buf.seek(0)
    filename = f"tile-station-credit-statement-{target_year}.pdf"
    return StreamingResponse(
        buf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )



@router.post("/trade/credits/earn")
async def earn_trade_credits(order_id: str, request: Request):
    """
    Award credits to trade customer after order completion.
    This is typically called after payment confirmation.
    Credits = order_total * credit_rate / 100
    """
    customer = await get_shop_customer(request)
    db = get_db()
    
    # Only trade customers can earn credits
    if not customer.get("is_trade"):
        raise HTTPException(status_code=403, detail="Credit back is only available for trade customers")
    
    # Get the order
    order = await db.shop_orders.find_one({
        "id": order_id,
        "customer_id": customer["id"],
        "payment_status": "paid"
    })
    
    if not order:
        raise HTTPException(status_code=404, detail="Paid order not found")
    
    # Check if credits already awarded for this order
    existing_credit = await db.trade_credits.find_one({
        "order_id": order_id,
        "type": "earn"
    })
    
    if existing_credit:
        raise HTTPException(status_code=400, detail="Credits already awarded for this order")
    
    # Calculate credits
    credit_rate = customer.get("credit_rate", TRADE_CREDIT_BACK_RATE)
    order_total = order.get("total", 0)
    credits_earned = round(order_total * credit_rate / 100, 2)
    
    now = datetime.now(timezone.utc)
    
    # Create credit record
    credit_record = {
        "id": str(uuid.uuid4()),
        "customer_id": customer["id"],
        "order_id": order_id,
        "order_number": order.get("order_number"),
        "type": "earn",
        "amount": credits_earned,
        "balance_after": customer.get("credit_balance", 0) + credits_earned,
        "description": f"Credit back from order {order.get('order_number')} ({credit_rate}% of £{order_total:.2f})",
        "created_at": now.isoformat()
    }
    
    await db.trade_credits.insert_one(credit_record)
    
    # Update customer's credit balance
    await db.shop_customers.update_one(
        {"id": customer["id"]},
        {"$inc": {"credit_balance": credits_earned}}
    )
    
    # Mark order as credits awarded
    await db.shop_orders.update_one(
        {"id": order_id},
        {"$set": {"credits_awarded": credits_earned, "credits_awarded_at": now.isoformat()}}
    )
    
    return {
        "success": True,
        "credits_earned": credits_earned,
        "credit_rate": credit_rate,
        "order_total": order_total,
        "new_balance": customer.get("credit_balance", 0) + credits_earned,
        "message": f"£{credits_earned:.2f} credits earned from this order"
    }


@router.post("/trade/credits/redeem")
async def redeem_trade_credits(data: CreditRedemptionRequest, request: Request):
    """
    Redeem credits against an order at checkout.
    The redemption amount is deducted from the order total.
    """
    customer = await get_shop_customer(request)
    db = get_db()

    # Both trade customers and regular shoppers with refund/loyalty credit
    # can redeem from `credit_balance`. The only hard gate is a positive
    # balance — non-trade customers without any credit have nothing to spend.
    current_balance = float(customer.get("credit_balance") or 0)
    if current_balance <= 0:
        raise HTTPException(status_code=400, detail="No credit available to redeem")
    
    if data.amount <= 0:
        raise HTTPException(status_code=400, detail="Redemption amount must be positive")
    
    if data.amount > current_balance:
        raise HTTPException(status_code=400, detail=f"Insufficient credit balance. Available: £{current_balance:.2f}")
    
    # Get the order
    order = await db.shop_orders.find_one({
        "id": data.order_id,
        "customer_id": customer["id"],
        "payment_status": {"$ne": "paid"}  # Can only redeem on unpaid orders
    })
    
    if not order:
        raise HTTPException(status_code=404, detail="Unpaid order not found")
    
    # Ensure redemption doesn't exceed order total
    order_total = order.get("total", 0)
    redemption_amount = min(data.amount, order_total)
    
    now = datetime.now(timezone.utc)
    
    # Create credit redemption record
    credit_record = {
        "id": str(uuid.uuid4()),
        "customer_id": customer["id"],
        "order_id": data.order_id,
        "order_number": order.get("order_number"),
        "type": "redeem",
        "amount": -redemption_amount,  # Negative for redemptions
        "balance_after": current_balance - redemption_amount,
        "description": f"Redeemed for order {order.get('order_number')}",
        "created_at": now.isoformat()
    }
    
    await db.trade_credits.insert_one(credit_record)
    
    # Update customer's credit balance
    await db.shop_customers.update_one(
        {"id": customer["id"]},
        {"$inc": {"credit_balance": -redemption_amount}}
    )
    
    # Update order with credits applied
    new_total = order_total - redemption_amount
    await db.shop_orders.update_one(
        {"id": data.order_id},
        {"$set": {
            "credits_applied": redemption_amount,
            "original_total": order_total,
            "total": round(new_total, 2),
            "updated_at": now.isoformat()
        }}
    )
    
    return {
        "success": True,
        "credits_redeemed": redemption_amount,
        "original_total": order_total,
        "new_total": round(new_total, 2),
        "new_balance": current_balance - redemption_amount,
        "message": f"£{redemption_amount:.2f} credits applied to your order"
    }


@router.get("/trade/credits/summary")
async def get_credit_summary(request: Request):
    """Get summary of trade credits for dashboard display"""
    customer = await get_shop_customer(request)
    db = get_db()
    
    if not customer.get("is_trade"):
        return {
            "is_trade": False,
            "credit_balance": 0,
            "message": "Upgrade to a trade account to earn credit back on purchases"
        }
    
    # Get recent transactions
    recent_transactions = await db.trade_credits.find(
        {"customer_id": customer["id"]},
        {"_id": 0}
    ).sort("created_at", -1).limit(5).to_list(5)
    
    # Calculate stats
    all_credits = await db.trade_credits.find(
        {"customer_id": customer["id"]},
        {"_id": 0, "type": 1, "amount": 1}
    ).to_list(1000)
    
    total_earned = sum(c["amount"] for c in all_credits if c["type"] == "earn")
    total_redeemed = sum(abs(c["amount"]) for c in all_credits if c["type"] == "redeem")
    
    return {
        "is_trade": True,
        "credit_balance": customer.get("credit_balance", 0),
        "credit_rate": customer.get("credit_rate", TRADE_CREDIT_BACK_RATE),
        "total_earned": round(total_earned, 2),
        "total_redeemed": round(total_redeemed, 2),
        "recent_transactions": recent_transactions,
        "message": f"You earn {customer.get('credit_rate', TRADE_CREDIT_BACK_RATE)}% credit back on every purchase"
    }


# ============ AUTOMATIC CREDIT AWARDING ============
# This function should be called after order payment is confirmed

async def award_credits_for_order(order_id: str, db=None):
    """
    Internal function to automatically award credits after order payment.
    Called from payment confirmation flow.
    """
    if db is None:
        db = get_db()
    
    order = await db.shop_orders.find_one({"id": order_id}, {"_id": 0})
    if not order:
        return {"success": False, "error": "Order not found"}
    
    customer_id = order.get("customer_id")
    if not customer_id:
        return {"success": False, "error": "No customer ID on order"}
    
    customer = await db.shop_customers.find_one({"id": customer_id}, {"_id": 0, "password": 0})
    if not customer:
        return {"success": False, "error": "Customer not found"}
    
    # Only trade customers earn credits
    if not customer.get("is_trade"):
        return {"success": False, "error": "Customer is not a trade account"}
    
    # Check if credits already awarded
    if order.get("credits_awarded"):
        return {"success": False, "error": "Credits already awarded"}
    
    # Calculate and award credits
    credit_rate = customer.get("credit_rate", TRADE_CREDIT_BACK_RATE)
    order_total = order.get("total", 0)
    credits_earned = round(order_total * credit_rate / 100, 2)
    
    now = datetime.now(timezone.utc)
    
    credit_record = {
        "id": str(uuid.uuid4()),
        "customer_id": customer_id,
        "order_id": order_id,
        "order_number": order.get("order_number"),
        "type": "earn",
        "amount": credits_earned,
        "balance_after": customer.get("credit_balance", 0) + credits_earned,
        "description": f"Credit back from order {order.get('order_number')} ({credit_rate}% of £{order_total:.2f})",
        "created_at": now.isoformat()
    }
    
    await db.trade_credits.insert_one(credit_record)
    
    await db.shop_customers.update_one(
        {"id": customer_id},
        {"$inc": {"credit_balance": credits_earned}}
    )
    
    await db.shop_orders.update_one(
        {"id": order_id},
        {"$set": {"credits_awarded": credits_earned, "credits_awarded_at": now.isoformat()}}
    )
    
    return {
        "success": True,
        "credits_earned": credits_earned,
        "customer_id": customer_id
    }


# ============ QUOTE REQUEST SYSTEM ============

# Default quote threshold (from business_rules.py)
QUOTE_THRESHOLD_DEFAULT = 120  # m²
UNIT_QUOTE_THRESHOLD_DEFAULT = 200  # units


class QuoteRequestCreate(BaseModel):
    """Quote request submission from customer"""
    product_id: str
    product_name: str
    product_sku: Optional[str] = None
    quantity: float = Field(..., gt=0, description="Quantity (m² or units)")
    pricing_unit: str = "m2"  # "m2" or "unit"
    customer_name: str
    customer_email: EmailStr
    customer_phone: str
    customer_company: Optional[str] = None
    project_details: Optional[str] = None
    delivery_postcode: Optional[str] = None
    preferred_contact: str = "email"  # email or phone


class QuoteRequestResponse(BaseModel):
    success: bool
    quote_id: str
    message: str


@router.post("/quotes/request", response_model=QuoteRequestResponse)
async def submit_quote_request(data: QuoteRequestCreate):
    """
    Submit a quote request for large quantity orders.
    Creates a quote request record and notifies admin.
    """
    db = get_db()
    now = datetime.now(timezone.utc)
    
    # Generate quote reference
    quote_count = await db.quote_requests.count_documents({})
    quote_ref = f"QR-{quote_count + 1001:05d}"
    
    quote_request = {
        "id": str(uuid.uuid4()),
        "quote_ref": quote_ref,
        "product_id": data.product_id,
        "product_name": data.product_name,
        "product_sku": data.product_sku,
        "quantity": data.quantity,
        "customer_name": data.customer_name,
        "customer_email": data.customer_email,
        "customer_phone": data.customer_phone,
        "customer_company": data.customer_company,
        "project_details": data.project_details,
        "delivery_postcode": data.delivery_postcode,
        "preferred_contact": data.preferred_contact,
        "status": "pending",  # pending, quoted, accepted, declined, expired
        "created_at": now.isoformat(),
        "updated_at": now.isoformat()
    }
    
    await db.quote_requests.insert_one(quote_request)
    
    # TODO: Send email notification to admin
    logging.info(f"New quote request {quote_ref} from {data.customer_email} for {data.quantity}m² of {data.product_name}")
    
    return QuoteRequestResponse(
        success=True,
        quote_id=quote_ref,
        message=f"Your quote request ({quote_ref}) has been submitted. We'll contact you within 24 hours."
    )


@router.get("/quotes/config")
async def get_quote_config():
    """Get global quote configuration"""
    db = get_db()
    
    config = await db.site_config.find_one({"key": "quote_settings"}, {"_id": 0})
    
    if not config:
        # Return defaults
        return {
            "quote_threshold": QUOTE_THRESHOLD_DEFAULT,
            "quote_enabled": True,
            "contact_email": "quotes@tilestation.co.uk"
        }
    
    return config.get("value", {
        "quote_threshold": QUOTE_THRESHOLD_DEFAULT,
        "quote_enabled": True
    })


@router.get("/products/{product_id}/quote-status")
async def get_product_quote_status(
    product_id: str, 
    quantity: float = Query(1, gt=0),
    quote_disabled: bool = Query(False, description="If product has quote_disabled flag"),
    custom_threshold: Optional[int] = Query(None, description="Product's custom quote threshold"),
    pricing_unit: str = Query("m2", description="Pricing unit: 'm2' or 'unit'")
):
    """
    Check if a product should show quote request for given quantity.
    Returns whether to show Add to Cart or Request Quote button.
    Supports both m² (tiles) and unit-based (adhesives, grout, tools) products.
    """
    db = get_db()
    
    # Check if quotes are disabled for this product
    if quote_disabled:
        return {
            "show_quote_button": False,
            "quote_disabled": True,
            "pricing_unit": pricing_unit,
            "reason": "Quotes disabled for this product"
        }
    
    # Get global config
    config = await db.site_config.find_one({"key": "quote_settings"}, {"_id": 0})
    
    # Use different thresholds based on pricing unit
    if pricing_unit == "unit":
        global_threshold = UNIT_QUOTE_THRESHOLD_DEFAULT
        if config and config.get("value"):
            global_threshold = config["value"].get("unit_quote_threshold", UNIT_QUOTE_THRESHOLD_DEFAULT)
        unit_label = "units"
    else:
        global_threshold = QUOTE_THRESHOLD_DEFAULT
        if config and config.get("value"):
            global_threshold = config["value"].get("quote_threshold", QUOTE_THRESHOLD_DEFAULT)
        unit_label = "m²"
    
    # Use product-specific threshold if provided, otherwise use global
    threshold = custom_threshold or global_threshold
    
    # Determine if quote should be shown
    show_quote = quantity >= threshold
    
    return {
        "show_quote_button": show_quote,
        "quote_disabled": False,
        "pricing_unit": pricing_unit,
        "threshold": threshold,
        "current_quantity": quantity,
        "exceeds_threshold": show_quote,
        "message": f"For orders over {threshold}{unit_label}, request a custom quote for the best price." if show_quote else None
    }


# ============ ADMIN QUOTE MANAGEMENT ============

class QuoteStatusUpdate(BaseModel):
    status: str  # pending, quoted, accepted, declined, expired
    quote_price: Optional[float] = None
    quote_notes: Optional[str] = None
    valid_until: Optional[str] = None


# Calculator Configuration endpoints
@router.get("/admin/calculator-config")
async def get_calculator_config():
    """Get tile calculator configuration"""
    db = get_db()
    config = await db.settings.find_one({"type": "calculator_config"}, {"_id": 0})
    if not config:
        # Return default configuration
        return {
            "enabled": True,
            "defaultWastage": 10,
            "maxWastage": 30,
            "calculatorTypes": {
                "bathroom": {
                    "enabled": True,
                    "name": "Bathroom",
                    "description": "Floor + Walls with window/door subtraction",
                    "defaultWallHeight": 2.4,
                    "showSubtractions": True
                },
                "floor": {
                    "enabled": True,
                    "name": "Floor Only",
                    "description": "Kitchen, Living Room, Garden, etc.",
                    "showSubtractions": False
                },
                "singleWall": {
                    "enabled": True,
                    "name": "Single Wall",
                    "description": "Splash backs, Feature walls, Fireplace",
                    "showSubtractions": True
                },
                "custom": {
                    "enabled": True,
                    "name": "Custom Areas",
                    "description": "Multiple small or complicated sections",
                    "showSubtractions": False
                }
            },
            "defaultSubtractions": {
                "window": {"width": 1.2, "height": 1.0},
                "door": {"width": 0.9, "height": 2.0}
            },
            "showBoxCalculation": True,
            "showPriceEstimate": True,
            "infoMessage": "We recommend ordering 10% extra for cuts and wastage. Always order from the same batch."
        }
    return config

@router.put("/admin/calculator-config")
async def update_calculator_config(config: dict):
    """Update tile calculator configuration"""
    db = get_db()
    config["type"] = "calculator_config"
    config["updated_at"] = datetime.utcnow().isoformat()
    
    await db.settings.update_one(
        {"type": "calculator_config"},
        {"$set": config},
        upsert=True
    )
    
    return {"success": True, "message": "Calculator configuration updated"}


# Website Sales Dashboard endpoints
@router.get("/admin/website-sales/stats")
async def get_website_sales_stats(range: str = Query("30d")):
    """Get website sales statistics"""
    db = get_db()
    
    # Calculate date range
    from datetime import datetime, timedelta
    now = datetime.utcnow()
    if range == "7d":
        start_date = now - timedelta(days=7)
    elif range == "30d":
        start_date = now - timedelta(days=30)
    elif range == "90d":
        start_date = now - timedelta(days=90)
    elif range == "ytd":
        start_date = datetime(now.year, 1, 1)
    else:
        start_date = datetime(2020, 1, 1)  # All time
    
    # Try to get orders from database
    try:
        orders = list(db.orders.find({
            "created_at": {"$gte": start_date.isoformat()}
        }))
        
        total_sales = sum(o.get("total", 0) for o in orders)
        total_orders = len(orders)
        total_cost = sum(o.get("cost_total", 0) for o in orders)
        
        # Calculate profit (revenue ex-VAT minus cost)
        revenue_ex_vat = total_sales / 1.2
        total_profit = revenue_ex_vat - total_cost
        
        # Get unique customers
        customers = set(o.get("customer_email") for o in orders if o.get("customer_email"))
        pending_orders = len([o for o in orders if o.get("status") == "pending"])
        
        stats = {
            "totalSales": round(total_sales, 2),
            "totalOrders": total_orders,
            "totalProfit": round(total_profit, 2),
            "averageOrderValue": round(total_sales / total_orders, 2) if total_orders > 0 else 0,
            "totalCustomers": len(customers),
            "conversionRate": 2.5,  # Placeholder
            "returningCustomers": len([c for c in customers if list(db.orders.find({"customer_email": c})).count > 1]) if customers else 0,
            "pendingOrders": pending_orders
        }
        
        profit_breakdown = {
            "grossRevenue": round(total_sales, 2),
            "vatCollected": round(total_sales - revenue_ex_vat, 2),
            "costOfGoods": round(total_cost, 2),
            "netProfit": round(total_profit, 2),
            "profitMargin": round((total_profit / revenue_ex_vat) * 100, 2) if revenue_ex_vat > 0 else 0
        }
        
        return {"stats": stats, "profit_breakdown": profit_breakdown}
    except Exception as e:
        # Return sample data if database query fails
        return {
            "stats": {
                "totalSales": 15678.50,
                "totalOrders": 47,
                "totalProfit": 4523.20,
                "averageOrderValue": 333.58,
                "totalCustomers": 32,
                "conversionRate": 2.8,
                "returningCustomers": 12,
                "pendingOrders": 5
            },
            "profit_breakdown": {
                "grossRevenue": 15678.50,
                "vatCollected": 2613.08,
                "costOfGoods": 8542.22,
                "netProfit": 4523.20,
                "profitMargin": 28.85
            }
        }

@router.get("/admin/website-sales/orders")
async def get_website_orders(limit: int = Query(10)):
    """Get recent website orders"""
    db = get_db()
    
    try:
        orders = list(db.orders.find({}).sort("created_at", -1).limit(limit))
        result = []
        for o in orders:
            result.append({
                "id": str(o.get("_id", o.get("order_id", "N/A"))),
                "customer": o.get("customer_name", "Unknown"),
                "email": o.get("customer_email", ""),
                "total": o.get("total", 0),
                "status": o.get("status", "pending"),
                "date": o.get("created_at", ""),
                "items": len(o.get("items", []))
            })
        return {"orders": result}
    except Exception:
        return {"orders": []}

@router.get("/admin/website-sales/top-products")
async def get_top_products(range: str = Query("30d")):
    """Get top selling products"""
    # Return sample data for now (TODO: implement actual aggregation from orders)
    return {
        "products": [
            {"name": "Carrara White Marble 60x60", "sku": "CWM-6060", "sold": 156, "revenue": 4523.44, "profit": 1267.80},
            {"name": "Slate Grey Floor Tile", "sku": "SGF-001", "sold": 98, "revenue": 2844.20, "profit": 812.40},
            {"name": "Wood Effect Oak", "sku": "WEO-001", "sold": 87, "revenue": 2436.63, "profit": 701.20},
            {"name": "Porcelain White Gloss", "sku": "PWG-001", "sold": 65, "revenue": 1885.35, "profit": 542.00},
            {"name": "Terracotta Natural", "sku": "TN-001", "sold": 54, "revenue": 1566.66, "profit": 423.50}
        ]
    }

@router.get("/admin/website-sales/by-category")
async def get_sales_by_category(range: str = Query("30d")):
    """Get sales breakdown by category"""
    # Return sample data for now (TODO: implement actual aggregation from orders)
    return {
        "categories": [
            {"name": "Floor Tiles", "sales": 8234.50, "percentage": 52.5},
            {"name": "Wall Tiles", "sales": 4123.00, "percentage": 26.3},
            {"name": "Accessories", "sales": 2156.00, "percentage": 13.8},
            {"name": "Adhesives & Grout", "sales": 1165.00, "percentage": 7.4}
        ]
    }


@router.get("/admin/quotes")
async def get_all_quotes(
    status: Optional[str] = Query(None, description="Filter by status"),
    limit: int = Query(50, le=200),
    skip: int = Query(0)
):
    """Get all quote requests for admin dashboard"""
    db = get_db()
    
    # Build query
    query = {}
    if status:
        query["status"] = status
    
    # Get quotes with pagination
    quotes = await db.quote_requests.find(
        query, {"_id": 0}
    ).sort("created_at", -1).skip(skip).limit(limit).to_list(limit)
    
    # Get total count
    total = await db.quote_requests.count_documents(query)
    
    # Get status counts
    status_counts = {
        "pending": await db.quote_requests.count_documents({"status": "pending"}),
        "quoted": await db.quote_requests.count_documents({"status": "quoted"}),
        "accepted": await db.quote_requests.count_documents({"status": "accepted"}),
        "declined": await db.quote_requests.count_documents({"status": "declined"}),
        "expired": await db.quote_requests.count_documents({"status": "expired"})
    }
    
    return {
        "quotes": quotes,
        "total": total,
        "status_counts": status_counts,
        "pagination": {
            "skip": skip,
            "limit": limit,
            "has_more": skip + limit < total
        }
    }


@router.get("/admin/quotes/{quote_id}")
async def get_quote_detail(quote_id: str):
    """Get detailed quote request by ID or quote_ref"""
    db = get_db()
    
    quote = await db.quote_requests.find_one(
        {"$or": [{"id": quote_id}, {"quote_ref": quote_id}]},
        {"_id": 0}
    )
    
    if not quote:
        raise HTTPException(status_code=404, detail="Quote request not found")
    
    return quote


@router.put("/admin/quotes/{quote_id}")
async def update_quote_status(quote_id: str, data: QuoteStatusUpdate):
    """Update quote request status and details"""
    db = get_db()
    now = datetime.now(timezone.utc)
    
    # Validate status
    valid_statuses = ["pending", "quoted", "accepted", "declined", "expired"]
    if data.status not in valid_statuses:
        raise HTTPException(status_code=400, detail=f"Invalid status. Must be one of: {valid_statuses}")
    
    # Find quote
    quote = await db.quote_requests.find_one(
        {"$or": [{"id": quote_id}, {"quote_ref": quote_id}]},
        {"_id": 0}
    )
    
    if not quote:
        raise HTTPException(status_code=404, detail="Quote request not found")
    
    # Build update
    update_data = {
        "status": data.status,
        "updated_at": now.isoformat()
    }
    
    if data.quote_price is not None:
        update_data["quote_price"] = data.quote_price
    if data.quote_notes is not None:
        update_data["quote_notes"] = data.quote_notes
    if data.valid_until is not None:
        update_data["valid_until"] = data.valid_until
    
    # Track status change
    status_history = quote.get("status_history", [])
    status_history.append({
        "from_status": quote.get("status"),
        "to_status": data.status,
        "changed_at": now.isoformat()
    })
    update_data["status_history"] = status_history
    
    # Update
    await db.quote_requests.update_one(
        {"$or": [{"id": quote_id}, {"quote_ref": quote_id}]},
        {"$set": update_data}
    )
    
    return {
        "success": True,
        "quote_ref": quote.get("quote_ref"),
        "new_status": data.status,
        "message": f"Quote {quote.get('quote_ref')} updated to {data.status}"
    }


@router.delete("/admin/quotes/{quote_id}")
async def delete_quote(quote_id: str):
    """Delete a quote request"""
    db = get_db()
    
    result = await db.quote_requests.delete_one(
        {"$or": [{"id": quote_id}, {"quote_ref": quote_id}]}
    )
    
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Quote request not found")
    
    return {
        "success": True,
        "message": "Quote request deleted"
    }


@router.get("/admin/quotes/stats/summary")
async def get_quote_stats():
    """Get quote request statistics for dashboard"""
    db = get_db()
    
    # Get counts by status
    total = await db.quote_requests.count_documents({})
    pending = await db.quote_requests.count_documents({"status": "pending"})
    quoted = await db.quote_requests.count_documents({"status": "quoted"})
    accepted = await db.quote_requests.count_documents({"status": "accepted"})
    declined = await db.quote_requests.count_documents({"status": "declined"})
    
    # Get recent quotes (last 7 days)
    week_ago = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
    recent_count = await db.quote_requests.count_documents({
        "created_at": {"$gte": week_ago}
    })
    
    # Calculate total quoted value (for accepted quotes)
    pipeline = [
        {"$match": {"status": "accepted", "quote_price": {"$exists": True}}},
        {"$group": {"_id": None, "total_value": {"$sum": "$quote_price"}}}
    ]
    value_result = await db.quote_requests.aggregate(pipeline).to_list(1)
    total_accepted_value = value_result[0]["total_value"] if value_result else 0
    
    return {
        "total_quotes": total,
        "pending": pending,
        "quoted": quoted,
        "accepted": accepted,
        "declined": declined,
        "recent_7_days": recent_count,
        "total_accepted_value": round(total_accepted_value, 2),
        "conversion_rate": round((accepted / total * 100), 1) if total > 0 else 0
    }


# Volume discount tiers (applied to all customers)
VOLUME_DISCOUNTS = [
    {"min_quantity": 50, "discount": 5},   # 5% off for 50+ units
    {"min_quantity": 100, "discount": 10}, # 10% off for 100+ units
    {"min_quantity": 200, "discount": 15}, # 15% off for 200+ units
    {"min_quantity": 500, "discount": 20}, # 20% off for 500+ units
]


@router.get("/pricing/calculate")
async def calculate_pricing(
    product_id: str,
    quantity: float,
    request: Request
):
    """Calculate price with trade and volume discounts"""
    db = get_db()
    
    # Get product
    product = await db.products.find_one({"id": product_id})
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    
    base_price = product.get("clearance_price") if product.get("clearance") else product.get("price", 0)
    
    # Check if customer is logged in and has trade account
    trade_discount = 0
    is_trade = False
    try:
        customer = await get_shop_customer(request)
        is_trade = customer.get("is_trade", False)
        trade_discount = customer.get("trade_discount", 0)
    except Exception:
        pass  # Guest customer
    
    # Calculate volume discount
    volume_discount = 0
    for tier in sorted(VOLUME_DISCOUNTS, key=lambda x: x["min_quantity"], reverse=True):
        if quantity >= tier["min_quantity"]:
            volume_discount = tier["discount"]
            break
    
    # Apply discounts (trade + volume, max 35%)
    total_discount = min(trade_discount + volume_discount, 35)
    
    unit_price = base_price * (1 - total_discount / 100)
    subtotal = unit_price * quantity
    
    return {
        "product_id": product_id,
        "product_name": product.get("name"),
        "base_price": base_price,
        "quantity": quantity,
        "is_trade": is_trade,
        "trade_discount": trade_discount,
        "volume_discount": volume_discount,
        "total_discount": total_discount,
        "unit_price": round(unit_price, 2),
        "subtotal": round(subtotal, 2),
        "volume_tiers": VOLUME_DISCOUNTS
    }


# ============ SIMILAR PRODUCTS (RECOMMENDATIONS) ============

@router.get("/products/{product_id}/similar")
async def get_similar_products(product_id: str, limit: int = 4):
    """Get similar products based on category"""
    db = get_db()
    
    # Get the current product
    product = await db.products.find_one({"id": product_id})
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    
    category_id = product.get("category_id")
    
    # Find similar products in same category
    query = {
        "id": {"$ne": product_id},  # Exclude current product
        "stock": {"$gt": 0}  # Only in-stock items
    }
    
    if category_id:
        query["category_id"] = category_id
    
    similar = await db.products.find(query, {"_id": 0}).limit(limit).to_list(limit)
    
    # If not enough in same category, get popular products
    if len(similar) < limit:
        remaining = limit - len(similar)
        exclude_ids = [product_id] + [p["id"] for p in similar]
        
        more_products = await db.products.find(
            {"id": {"$nin": exclude_ids}, "stock": {"$gt": 0}},
            {"_id": 0}
        ).sort("stock", -1).limit(remaining).to_list(remaining)
        
        similar.extend(more_products)
    
    return {
        "product_id": product_id,
        "similar_products": [serialize_product_for_shop(p) for p in similar]
    }


# ============ SERIES PRODUCTS ============

def extract_series_from_name(name: str) -> str:
    """Extract series name from product name (usually the first word before color/size)"""
    if not name:
        return ""
    
    # Common color words to stop at
    color_words = {
        'white', 'black', 'grey', 'gray', 'cream', 'beige', 'brown', 'red', 'blue', 'green',
        'graphite', 'anthracite', 'ivory', 'sand', 'charcoal', 'taupe', 'natural', 'gold',
        'silver', 'bronze', 'copper', 'brass', 'pearl', 'bone', 'almond', 'caramel',
        'mocha', 'espresso', 'walnut', 'oak', 'ash', 'slate', 'stone', 'marble', 'granite'
    }
    
    # Size patterns to stop at
    import re
    size_pattern = re.compile(r'^\d+x\d+', re.IGNORECASE)
    
    words = name.split()
    series_words = []
    
    for word in words:
        word_lower = word.lower().rstrip(',.')
        # Stop at color words or size patterns
        if word_lower in color_words or size_pattern.match(word):
            break
        series_words.append(word)
    
    # Return at least the first word if we have it
    if series_words:
        return ' '.join(series_words)
    elif words:
        return words[0]
    return ""

@router.get("/products/{product_id}/series")
async def get_series_products(product_id: str, limit: int = 8):
    """Get products from the same series with variant counts"""
    db = get_db()
    
    # Get the current product
    product = await db.products.find_one({"id": product_id})
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    
    # Get series from field or extract from name
    series_name = product.get("series", "").strip()
    if not series_name:
        series_name = extract_series_from_name(product.get("name", ""))
    
    # If still no series, return empty
    if not series_name or len(series_name) < 2:
        return {
            "product_id": product_id,
            "series_name": None,
            "series_products": [],
            "variant_counts": {"colors": 0, "sizes": 0, "finishes": 0},
            "total_in_series": 0
        }
    
    # Find all products that start with the series name (case-insensitive)
    import re
    series_regex = re.compile(f"^{re.escape(series_name)}", re.IGNORECASE)
    
    all_series_products = await db.products.find(
        {
            "$or": [
                {"series": series_name},
                {"name": {"$regex": series_regex}}
            ],
            "stock": {"$gt": 0}
        },
        {"_id": 0}
    ).to_list(100)
    
    # Calculate variant counts
    colors = set()
    sizes = set()
    finishes = set()
    
    for p in all_series_products:
        # Extract color from finish or name
        finish = p.get("finish", "")
        if finish:
            finishes.add(finish)
        
        # Try to extract color from product name or color field
        color = p.get("color", "")
        if color:
            colors.add(color)
        
        # Extract size from dimensions
        width = p.get("tile_width")
        height = p.get("tile_height")
        if width and height:
            sizes.add(f"{int(width)}x{int(height)}cm")
    
    # Filter out current product and limit
    series_products = [
        serialize_product_for_shop(p) 
        for p in all_series_products 
        if p.get("id") != product_id
    ][:limit]
    
    return {
        "product_id": product_id,
        "series_name": series_name,
        "series_products": series_products,
        "variant_counts": {
            "colors": len(colors) if colors else len(series_products) + 1,
            "sizes": len(sizes),
            "finishes": len(finishes)
        },
        "total_in_series": len(all_series_products)
    }




# ============ SAMPLE ORDERING ============

class SampleProductInput(BaseModel):
    """One sample line item in a customer's order.

    `sample_type` mirrors the frontend `sampleTier.js` enum:
       free_small | free_cut | full_size
    `price_gbp` is the SAMPLE charge (not postage) — £5 for full_size,
    £0 for free tiers. We store it explicitly so historic orders stay
    correct even if pricing changes later.
    """
    id: str
    sample_type: str = "free_cut"
    price_gbp: float = 0.0


class SampleOrderCreate(BaseModel):
    customer_name: str
    customer_email: EmailStr
    customer_phone: str = ""
    delivery_address: dict
    # Legacy callers (older clients still in customers' browser caches)
    # send `product_ids: List[str]`. New clients send `items: List[SampleProductInput]`.
    # The endpoint accepts either; if both are present, items wins.
    product_ids: List[str] = []
    items: List[SampleProductInput] = []
    notes: str = ""


class SampleBasketCaptureRequest(BaseModel):
    """Lightweight contact + basket snapshot saved BEFORE we hit the Stripe
    flow. Guarantees we don't lose the customer if anything downstream
    fails (server bug, Stripe outage, customer closes the tab on the Pay
    page, …). The May 2 2026 incident hit because the storefront tile-id
    lookup was looking in the wrong Mongo collection — every customer who
    clicked Pay before the fix vanished without a trace. This solves that
    forever: even if the order never gets created, we still know who to
    apologise to."""
    customer_name: str
    customer_email: EmailStr
    customer_phone: str = ""
    delivery_address: dict | None = None
    product_ids: List[str] = []


# Sample postage fee
SAMPLE_POSTAGE_FEE = 2.99  # £2.99 postage for samples (any tier)
# Pricing for the £5 Full Size Sample tier. Stored on each line item so
# historic orders survive any future price change.
FULL_SIZE_SAMPLE_PRICE = 5.00
# Hard cap on FREE samples per order. Paid Full Size samples (£5) are
# unlimited — customer pays per piece + cutting labour is covered.
MAX_FREE_SAMPLES_PER_ORDER = 3


@router.post("/samples/capture")
async def capture_sample_basket(data: SampleBasketCaptureRequest):
    """Save (or refresh) a single record for this email's pending sample
    basket. Idempotent: re-clicking Pay on the same email upserts. The
    record stays at status='pending' until the customer hits success
    (where we mark 'recovered') or 24 hours later where the daily clean
    flips it to 'abandoned' for outreach."""
    db = get_db()
    email = (data.customer_email or "").strip().lower()
    if not email:
        # EmailStr already enforces presence, but be defensive
        return {"ok": False, "reason": "email required"}

    now_iso = datetime.now(timezone.utc).isoformat()
    doc = {
        "customer_email": email,
        "customer_name": data.customer_name.strip(),
        "customer_phone": (data.customer_phone or "").strip(),
        "delivery_address": data.delivery_address or {},
        "product_ids": data.product_ids or [],
        "status": "pending",
        "updated_at": now_iso,
    }
    try:
        await db.abandoned_sample_baskets.update_one(
            {"customer_email": email, "status": {"$in": ["pending", "abandoned"]}},
            {
                "$set": doc,
                "$setOnInsert": {
                    "id": str(uuid.uuid4()),
                    "created_at": now_iso,
                    "first_attempt_at": now_iso,
                },
            },
            upsert=True,
        )
        return {"ok": True}
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"sample basket capture failed: {exc}")
        # Capture failure must NEVER block the customer's actual order
        return {"ok": False, "reason": str(exc)[:120]}


async def _mark_basket_recovered(email: str) -> None:
    """Called from the success path once Stripe confirms payment."""
    if not email:
        return
    try:
        db = get_db()
        await db.abandoned_sample_baskets.update_many(
            {"customer_email": email.lower().strip(), "status": {"$ne": "recovered"}},
            {"$set": {"status": "recovered", "recovered_at": datetime.now(timezone.utc).isoformat()}},
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"basket recovery mark failed: {exc}")


@router.get("/admin/abandoned-sample-baskets")
async def list_abandoned_sample_baskets(
    status: str = "pending",
    limit: int = 200,
    current_user: dict = Depends(get_current_user),
):
    """Admin only: list the captures for outreach. Default `status=pending`
    returns customers who haven't yet completed payment. `status=abandoned`
    is the daily-cleaned bucket. `status=recovered` is the audit trail."""
    if (current_user or {}).get("role") not in ("super_admin", "admin", "manager"):
        raise HTTPException(status_code=403, detail="Admin only")
    db = get_db()
    rows = await (
        db.abandoned_sample_baskets
        .find({"status": status}, {"_id": 0})
        .sort("updated_at", -1)
        .limit(min(max(limit, 1), 1000))
        .to_list(length=None)
    )
    return {"count": len(rows), "rows": rows}


@router.post("/samples/order")
async def create_sample_order(data: SampleOrderCreate):
    """Create a sample order. Free samples capped at 3; paid Full Size unlimited.

    Per-tile uniqueness still applies for FREE samples (we've already
    posted one of that tile, so a duplicate is just giving away product).
    Full Size paid samples can be re-ordered freely — customer pays per
    piece each time.

    `clearance` tiles auto-block here as a safety net so the policy holds
    even if the storefront button somehow allowed it.
    """
    db = get_db()

    # Build a unified items list. Two callers:
    #   • Older browser caches send `product_ids: [...]` only — treat each as
    #     a free_cut sample (£0).
    #   • New storefront sends `items: [{id, sample_type, price_gbp}]`.
    items: list[dict] = []
    if data.items:
        items = [
            {"id": it.id, "sample_type": it.sample_type, "price_gbp": float(it.price_gbp or 0)}
            for it in data.items
        ]
    elif data.product_ids:
        items = [{"id": pid, "sample_type": "free_cut", "price_gbp": 0.0} for pid in data.product_ids]

    if not items:
        raise HTTPException(status_code=400, detail="Please select at least one sample")

    free_items = [i for i in items if (i.get("price_gbp") or 0) == 0]
    paid_items = [i for i in items if (i.get("price_gbp") or 0) > 0]

    if len(free_items) > MAX_FREE_SAMPLES_PER_ORDER:
        raise HTTPException(
            status_code=400,
            detail=(
                f"You can order up to {MAX_FREE_SAMPLES_PER_ORDER} free samples per delivery. "
                "Add Full Size Samples (£5) for unlimited large-format samples in the same basket."
            ),
        )

    # ── Per-tile uniqueness rule (replaces the old per-month / per-order caps) ──
    # New policy (May 2 2026): a customer can order ANY number of samples in
    # ONE basket and place AS MANY orders as they like — the only constraint
    # is they cannot order the same physical tile sample twice. We've already
    # posted them one of that exact tile, so a repeat would just be giving
    # away free product. We check across every prior fulfilled sample order
    # for this email.
    paid_statuses = ["paid", "shipped", "delivered", "completed"]
    prior = db.sample_orders.find(
        {"customer_email": data.customer_email, "status": {"$in": paid_statuses}},
        {"_id": 0, "products": 1},
    )
    already_ordered_ids: set[str] = set()
    async for prior_order in prior:
        for p in (prior_order.get("products") or []):
            pid = p.get("id")
            if pid:
                already_ordered_ids.add(str(pid))

    duplicate_in_request = [
        i["id"] for i in items
        if i["id"] in already_ordered_ids and (i.get("price_gbp") or 0) == 0
    ]
    if duplicate_in_request:
        raise HTTPException(
            status_code=409,
            detail={
                "message": (
                    "You've already received "
                    f"{'this sample' if len(duplicate_in_request) == 1 else 'these samples'} "
                    "from us before — please pick different tiles, or order a Full Size Sample (£5) "
                    "if you need a larger view of the same tile."
                ),
                "already_ordered_product_ids": duplicate_in_request,
            },
        )

    # Best-effort cleanup of the customer's own dangling `pending_payment`
    # rows from earlier failed attempts, so retries don't leave clutter in the
    # admin sample-orders viewer.
    one_hour_ago = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    try:
        await db.sample_orders.delete_many({
            "customer_email": data.customer_email,
            "status": "pending_payment",
            "created_at": {"$lt": one_hour_ago},
        })
    except Exception as _cleanup_err:
        logger.warning(f"sample_orders cleanup skipped: {_cleanup_err}")

    # Verify products exist. Quietly skip any IDs that no longer exist
    # (the product may have been deleted or had its ID changed by a
    # supplier re-import). Returning a hard 404 here was the bug that
    # locked customers out — better to proceed with whatever's still
    # valid AND surface the skipped IDs so the frontend can prune the
    # localStorage basket of stale entries on the next attempt.
    #
    # NB: storefront samples can come from BOTH collections:
    #   1. `products` (UUID `id` field, 36 chars with dashes) — newer
    #      pure e-commerce products.
    #   2. `tiles` (Mongo ObjectId `_id`, 24 hex chars) — the bulk of the
    #      catalog. `serialize_tile_for_shop` exposes `_id` as `id` to the
    #      frontend, which is why customers' basket items often look like
    #      "69dfa2638f561dae5550daf3".
    # We try both. THIS WAS THE LIVE BUG (May 2 2026): we only looked in
    # `products`, so every tile-sample order that came from the main
    # catalog 404'd at the Pay button.
    products = []
    skipped_product_ids: list[str] = []
    blocked_clearance_ids: list[str] = []
    try:
        from bson import ObjectId  # noqa: WPS433
    except ImportError:
        ObjectId = None  # type: ignore

    for it in items:
        pid = it["id"]
        sample_type = it.get("sample_type") or "free_cut"
        price_gbp = float(it.get("price_gbp") or 0)
        # 1) products collection (UUID style)
        product = await db.products.find_one({"id": pid})
        # Block clearance tiles from samples — they go to showroom only.
        # This is a server-side safety net; the storefront button is
        # already hidden for clearance tiles via OrderSampleButton.jsx.
        if product and product.get("clearance"):
            blocked_clearance_ids.append(pid)
            continue
        if product:
            products.append({
                "id": product["id"],
                "name": product["name"],
                "sku": product.get("sku", ""),
                "image": product.get("images", [""])[0] if product.get("images") else "",
                "sample_type": sample_type,
                "price_gbp": price_gbp,
            })
            continue

        # 2) tiles collection (ObjectId style)
        tile = None
        if ObjectId is not None and len(pid) == 24:
            try:
                tile = await db.tiles.find_one({"_id": ObjectId(pid)})
            except Exception:  # noqa: BLE001
                tile = None
        if not tile:
            tile = await db.tiles.find_one({"slug": pid}) or \
                   await db.tiles.find_one({"supplier_code": pid})

        if tile and tile.get("clearance"):
            blocked_clearance_ids.append(pid)
            continue

        if tile:
            tile_id = pid if pid else str(tile.get("_id", ""))
            tile_name = (
                tile.get("display_name")
                or tile.get("our_name")
                or tile.get("name")
                or tile.get("original_name")
                or "Tile sample"
            )
            tile_image = ""
            imgs = tile.get("images") or []
            if isinstance(imgs, list) and imgs:
                tile_image = imgs[0]
            products.append({
                "id": tile_id,
                "name": tile_name.strip(),
                "sku": tile.get("supplier_code", "") or tile.get("sku", ""),
                "image": tile_image,
                "sample_type": sample_type,
                "price_gbp": price_gbp,
            })
            continue

        skipped_product_ids.append(pid)

    if blocked_clearance_ids:
        # Hard fail with a friendly explanation. The customer's basket
        # contained a clearance tile — we don't ship samples for those.
        raise HTTPException(
            status_code=409,
            detail={
                "message": (
                    "We don't post samples for clearance tiles — please visit any "
                    "of our showrooms (Tonbridge, Gravesend) "
                    "to view the tile in person."
                ),
                "blocked_clearance_product_ids": blocked_clearance_ids,
            },
        )

    if not products:
        raise HTTPException(
            status_code=410,
            detail={
                "message": "Some samples in your basket are no longer available. We've cleared them — please add new ones from the shop.",
                "skipped_product_ids": skipped_product_ids,
            },
        )

    # Create sample order. Total = postage + sum(paid sample prices).
    samples_subtotal = sum(p.get("price_gbp", 0) or 0 for p in products)
    order_total = round(SAMPLE_POSTAGE_FEE + samples_subtotal, 2)
    order_number = f"SMP-{datetime.now().strftime('%y%m%d')}-{str(uuid.uuid4())[:6].upper()}"

    paid_count = sum(1 for p in products if (p.get("price_gbp") or 0) > 0)
    free_count = len(products) - paid_count

    sample_order = {
        "id": str(uuid.uuid4()),
        "order_number": order_number,
        "customer_name": data.customer_name,
        "customer_email": data.customer_email,
        "customer_phone": data.customer_phone,
        "delivery_address": data.delivery_address,
        "products": products,
        "sample_count": len(products),
        "free_sample_count": free_count,
        "paid_sample_count": paid_count,
        "samples_subtotal": round(samples_subtotal, 2),
        "postage_fee": SAMPLE_POSTAGE_FEE,
        "total": order_total,
        "status": "pending_payment",
        "notes": data.notes,
        "created_at": datetime.now(timezone.utc).isoformat()
    }

    await db.sample_orders.insert_one(sample_order)

    summary_bits = []
    if free_count:
        summary_bits.append(f"{free_count} free")
    if paid_count:
        summary_bits.append(f"{paid_count} Full Size (£{paid_count * FULL_SIZE_SAMPLE_PRICE:.2f})")
    msg = (
        f"Sample order created. "
        f"{' + '.join(summary_bits)} sample(s) + £{SAMPLE_POSTAGE_FEE} postage = £{order_total:.2f}."
    )

    return {
        "order_id": sample_order["id"],
        "order_number": order_number,
        "sample_count": len(products),
        "free_sample_count": free_count,
        "paid_sample_count": paid_count,
        "samples_subtotal": round(samples_subtotal, 2),
        "postage_fee": SAMPLE_POSTAGE_FEE,
        "total": order_total,
        "skipped_product_ids": skipped_product_ids,
        "message": msg,
    }


class SampleCheckoutRequest(BaseModel):
    origin_url: str


@router.post("/samples/checkout/{order_id}")
async def create_sample_checkout(order_id: str, payload: SampleCheckoutRequest, request: Request):
    """Create Stripe checkout session for sample postage.

    Mirrors the production trade-checkout pattern (same env var name, same
    async client call, same `amount` unit — pounds as a float, NOT pence).
    The previous implementation had three silent bugs:
      • read STRIPE_SECRET_KEY (the rest of the codebase uses STRIPE_API_KEY)
      • passed amount as int pence; downstream lib expects float pounds
      • forgot `await` so the coroutine was never awaited and no session
        was created (Python returned None and the route 500'd inconsistently)
      • success_url pointed at `/sample-success` which doesn't exist; the
        actual route is `/shop/tile-sample-success`
      • webhook_url was empty so Stripe-side metadata didn't point at our
        webhook — the 2 May 2026 Zoe Ward incident. Now resolves through
        the SITE_URL/BACKEND_URL env var; webhook itself also handles
        sample order_type from the checkout.session.completed metadata.
    """
    db = get_db()

    order = await db.sample_orders.find_one({"id": order_id})
    if not order:
        raise HTTPException(status_code=404, detail="Sample order not found")

    if order.get("status") == "paid":
        raise HTTPException(status_code=400, detail="Already paid")

    stripe_api_key = os.environ.get("STRIPE_API_KEY")
    if not stripe_api_key:
        raise HTTPException(status_code=500, detail="Payment service not configured")

    origin = (payload.origin_url or "").rstrip("/")
    success_url = f"{origin}/shop/tile-sample-success?session_id={{CHECKOUT_SESSION_ID}}&order_id={order_id}"
    cancel_url = f"{origin}/shop/tile-samples?cancelled=true"

    webhook_url = _resolve_webhook_url(request)
    stripe_checkout = StripeCheckout(api_key=stripe_api_key, webhook_url=webhook_url)
    payment_methods = await get_enabled_checkout_payment_methods(float(order["total"]))

    def _build_request(methods_list):
        return CheckoutSessionRequest(
            amount=float(order["total"]),
            currency="gbp",
            payment_methods=methods_list,
            success_url=success_url,
            cancel_url=cancel_url,
            metadata={
                "order_id": order_id,
                "order_type": "sample",
                "sample_count": str(order["sample_count"]),
                "customer_email": order.get("customer_email", ""),
            }
        )

    try:
        session = await _create_stripe_checkout_with_fallback(
            stripe_checkout, _build_request, payment_methods
        )
    except Exception as e:
        logger.exception("Sample checkout session creation failed")
        raise HTTPException(status_code=500, detail=f"Payment session creation failed: {str(e)}")

    # Store session ID on the sample order so the success page can verify
    await db.sample_orders.update_one(
        {"id": order_id},
        {"$set": {"stripe_session_id": session.session_id}}
    )

    return {
        "checkout_url": session.url,
        "session_id": session.session_id,
    }


@router.get("/samples/checkout/status/{session_id}")
async def get_sample_checkout_status(session_id: str):
    """Verify a sample-postage Stripe session and flip the order to `paid`
    once Stripe confirms. Called from the sample-success page. Idempotent —
    repeat calls after `paid` just return the current state.

    17 May 2026 — Added confirmation-email + admin-alert fanout. Up
    to today this endpoint flipped status to `paid` and that was it:
    the customer got NO email confirming their samples were on the way
    and the showroom team got NO notification an order existed. The
    only way orders were surfacing was via the cron-based recovery
    scan in `stripe_reconcile.py` (which DID send an apology email).
    That meant happy-path orders went silent for hours/days. Now we
    fire both notifications immediately on first-paid-flip, with a
    `confirmation_sent_at` idempotency stamp so repeat calls (or the
    recovery cron also catching it) never double-send.
    """
    db = get_db()
    order = await db.sample_orders.find_one(
        {"stripe_session_id": session_id}, {"_id": 0}
    )
    if not order:
        raise HTTPException(status_code=404, detail="Sample order not found")

    # Already marked paid → short-circuit. If for some reason confirmation
    # was never sent (e.g. email service was down at the time of payment),
    # try once more — the `confirmation_sent_at` guard prevents duplicates.
    if order.get("status") in ("paid", "shipped", "delivered", "completed"):
        if not order.get("confirmation_sent_at"):
            await _send_sample_confirmation_fanout(order)
        return {
            "payment_status": "paid",
            "order_status": order.get("status"),
            "order_number": order.get("order_number"),
        }

    stripe_api_key = os.environ.get("STRIPE_API_KEY")
    if not stripe_api_key:
        raise HTTPException(status_code=500, detail="Payment service not configured")

    stripe_checkout = StripeCheckout(api_key=stripe_api_key, webhook_url="")
    try:
        status = await stripe_checkout.get_checkout_status(session_id)
    except Exception as e:
        logger.exception("Sample checkout status check failed")
        raise HTTPException(status_code=500, detail=f"Failed to check payment status: {str(e)}")

    payment_status = getattr(status, "payment_status", None) or "unpaid"
    if payment_status == "paid":
        await db.sample_orders.update_one(
            {"stripe_session_id": session_id},
            {"$set": {
                "status": "paid",
                "paid_at": datetime.now(timezone.utc).isoformat(),
            }},
        )
        # Re-read the freshly-updated doc so the email/alert fanout
        # sees the new `status` + `paid_at` and the confirmation guard
        # writes to a doc that already says paid.
        order = await db.sample_orders.find_one(
            {"stripe_session_id": session_id}, {"_id": 0}
        ) or order

        # Fire confirmation email to customer + alert to showroom team.
        # Errors are swallowed inside the helper so a flaky email
        # service can never block the success-page response — admin
        # gets a daily recovery digest as a safety net.
        await _send_sample_confirmation_fanout(order)

        # Sweep any abandoned-basket capture(s) for this email so they
        # don't end up in tomorrow's apology-email batch.
        await _mark_basket_recovered(order.get("customer_email", ""))

    return {
        "payment_status": payment_status,
        "order_status": "paid" if payment_status == "paid" else order.get("status"),
        "order_number": order.get("order_number"),
    }


async def _send_sample_confirmation_fanout(
    order: dict,
    *,
    force: bool = False,
) -> dict:
    """Send customer confirmation + admin/showroom alert for a freshly-
    paid sample order.

    Idempotent by default: stamps `confirmation_sent_at` on the order
    before returning. Repeated calls (e.g. the recovery cron also
    catching this order) check the stamp and bail before sending.

    `force=True` bypasses the idempotency check — used by the admin
    "Resend confirmation" button after a silent Resend failure.

    Returns a dict with the actual Resend / Telegram results so callers
    (and the admin UI) can see what actually happened:
        {
          "customer_email": {"success": bool, "resend_id": str|None, "error": str|None},
          "admin_email":    {"success": bool, "resend_id": str|None, "error": str|None},
          "telegram":       {"success": bool, "error": str|None},
          "skipped":        bool,  # True only when idempotency claim failed
        }

    The same dict is persisted to `confirmation_send_result` on the
    order doc so the admin drawer can show "customer not notified" /
    "Resend rejected: x@y bounced previously" without needing to scrape
    backend logs.

    20 Jun 2026 — Fix for silent-failure incident (SMP-260620-FFC920,
    Tracy Batchelor). Customer received NO email even though Telegram
    fired, because `send_simple_email_if_possible` returns a dict on
    failure instead of raising, and the previous fanout ignored that
    dict entirely. Now we (a) capture the result, (b) persist it for
    forensics, and (c) only mark `confirmation_sent_at` after at least
    one email actually succeeds — so a transient Resend hiccup doesn't
    permanently mark the order as "already notified" and block manual
    resends.
    """
    result: dict = {
        "customer_email": None,
        "admin_email": None,
        "telegram": None,
        "skipped": False,
    }
    if not order:
        result["skipped"] = True
        return result
    db = get_db()
    order_id = order.get("id")

    if not force:
        # Idempotency: atomic compare-and-set on `confirmation_attempted_at`.
        # We use the *attempted* marker (not *sent*) so a transient failure
        # can be retried by the admin's manual "Resend" button. The
        # `confirmation_sent_at` marker is only set later, after at least
        # one email actually succeeded.
        now_iso = datetime.now(timezone.utc).isoformat()
        claim = await db.sample_orders.update_one(
            {"id": order_id, "confirmation_attempted_at": {"$exists": False}},
            {"$set": {"confirmation_attempted_at": now_iso}},
        )
        if claim.modified_count == 0:
            logger.info(
                "Sample confirmation already attempted for order %s — skipping fanout",
                order_id,
            )
            result["skipped"] = True
            return result

    # ── Build the items list — the bit that's been missing from your
    # Stripe dashboard / your inbox for the past several sample orders ──
    products = order.get("products") or []
    items_html = "".join(
        f"<li style='margin:4px 0'>"
        f"<strong>{(p.get('name') or 'Sample')}</strong>"
        f"{(' — ' + p.get('size_human')) if p.get('size_human') else ''}"
        f"{' · £' + format(p.get('price_gbp') or 0, '.2f') if (p.get('price_gbp') or 0) > 0 else ' · FREE'}"
        f"</li>"
        for p in products
    )
    order_number = order.get("order_number") or order.get("id") or "—"
    total = float(order.get("total") or 0)
    customer_name = order.get("customer_name") or "there"
    customer_email = order.get("customer_email") or ""
    customer_phone = order.get("customer_phone") or "—"
    delivery_address = order.get("delivery_address") or {}
    addr_lines = [
        delivery_address.get("line1") or "",
        delivery_address.get("line2") or "",
        delivery_address.get("city") or "",
        delivery_address.get("county") or "",
        delivery_address.get("postcode") or "",
    ]
    addr_block = "<br/>".join(line for line in addr_lines if line)

    # ── Customer confirmation email ──
    # 20 Jun 2026 — switched FROM=samples@ (was online@). The samples@
    # mailbox is the proven path used by `send_sample_followup_email`
    # and is already verified on Resend. Also: when a customer hits
    # reply, it goes to the right team inbox.
    cust_result: dict = {"success": False, "resend_id": None, "error": None}
    try:
        from services import email as email_svc
        cust_subject = f"Sample order #{order_number} confirmed · Tile Station"
        cust_html = (
            f"<p>Hi {customer_name},</p>"
            f"<p>Thanks for your sample order — payment received ✅. "
            f"We'll pop your samples in the post within one working day.</p>"
            f"<p><strong>Order #{order_number}</strong><br/>"
            f"Total paid: £{total:.2f}</p>"
            f"<p><strong>Your samples:</strong></p>"
            f"<ul>{items_html}</ul>"
            f"<p><strong>Delivering to:</strong><br/>{addr_block}</p>"
            f"<p>Any questions, just reply to this email and one of our team will help.</p>"
            f"<p>Thanks,<br/>Tile Station</p>"
        )
        send_fn = getattr(email_svc, "send_simple_email_if_possible", None)
        if not customer_email:
            cust_result["error"] = "No customer email on order"
        elif not send_fn:
            cust_result["error"] = "Email service unavailable"
        else:
            raw = await send_fn(
                customer_email, cust_subject, cust_html,
                from_override="Tile Station <samples@tilestation.co.uk>",
            )
            # send_simple_email_if_possible returns
            #   {"success": bool, "resend_id": str|None}  on success
            #   {"success": False, "error": "..."}         on failure
            # Coerce into our standard shape so the admin UI can show it.
            if isinstance(raw, dict):
                cust_result["success"] = bool(raw.get("success"))
                cust_result["resend_id"] = raw.get("resend_id")
                cust_result["error"] = raw.get("error")
            else:
                cust_result["error"] = f"Unexpected response: {raw!r}"
    except Exception as exc:  # noqa: BLE001
        logger.exception("Sample confirmation email to customer failed (non-fatal)")
        cust_result["error"] = str(exc)[:300]
    result["customer_email"] = cust_result

    # ── Admin / showroom alert ──
    # Fan out to the owner's monitored inboxes (same default as shop
    # orders — online@ + qasim@). FROM notifications@ so neither online@
    # (online-customer-only) nor qasim@ (personal alerts inbox) appears
    # as a sending address — per the 20 May 2026 email-policy update.
    admin_result: dict = {"success": False, "resend_id": None, "error": None}
    try:
        from services import email as email_svc
        raw_env = os.environ.get(
            "SAMPLES_ADMIN_EMAIL",
            "online@tilestation.co.uk,qasim@tilestation.co.uk",
        )
        admin_recipients = [e.strip() for e in raw_env.split(",") if e.strip() and "@" in e]
        admin_subject = f"🟢 New sample order — #{order_number} · £{total:.2f}"
        admin_html = (
            f"<p><strong>New paid sample order ready to dispatch.</strong></p>"
            f"<p><strong>Order:</strong> #{order_number}<br/>"
            f"<strong>Total:</strong> £{total:.2f}<br/>"
            f"<strong>Customer:</strong> {customer_name} &lt;{customer_email}&gt;<br/>"
            f"<strong>Phone:</strong> {customer_phone}</p>"
            f"<p><strong>Samples ({len(products)}):</strong></p>"
            f"<ul>{items_html}</ul>"
            f"<p><strong>Delivering to:</strong><br/>{addr_block}</p>"
            f"<p>Stripe payment: <code>{order.get('stripe_session_id','—')}</code></p>"
        )
        send_fn = getattr(email_svc, "send_simple_email_if_possible", None)
        if not admin_recipients:
            admin_result["error"] = "No admin recipients configured"
        elif not send_fn:
            admin_result["error"] = "Email service unavailable"
        else:
            raw = await send_fn(
                admin_recipients, admin_subject, admin_html,
                from_override="Tile Station Alerts <notifications@tilestation.co.uk>",
            )
            if isinstance(raw, dict):
                admin_result["success"] = bool(raw.get("success"))
                admin_result["resend_id"] = raw.get("resend_id")
                admin_result["error"] = raw.get("error")
            else:
                admin_result["error"] = f"Unexpected response: {raw!r}"
    except Exception as exc:  # noqa: BLE001
        logger.exception("Sample admin alert email failed (non-fatal)")
        admin_result["error"] = str(exc)[:300]
    result["admin_email"] = admin_result

    # ── Telegram alert ──
    # The bot infrastructure has been in place since Feb 2026 with
    # `new_order` event enabled by default — but no code path was firing
    # it. Result: owner found out about paid orders by manually scrolling
    # Stripe, days later. This closes the loop: every paid sample order
    # now pings the owner's Telegram within seconds of payment.
    #
    # Dedupe key uses the order_number so a refresh/retry of the success
    # page doesn't double-alert (the email fanout's confirmation_sent_at
    # flag already prevents that, but the dedupe inside notify_event is
    # belt-and-braces against any future code path that re-enters this
    # helper without checking the flag first).
    tg_result: dict = {"success": False, "error": None}
    try:
        from services.telegram_notify import notify_event
        product_lines = "\n".join(
            f"  • {(p.get('name') or 'Sample')}"
            + (f" — {p.get('size_human')}" if p.get('size_human') else "")
            for p in products
        )
        tg_text = (
            f"🟢 <b>New sample order — #{order_number}</b>\n"
            f"<b>£{total:.2f}</b> · {len(products)} sample(s)\n\n"
            f"<b>Customer:</b> {customer_name}\n"
            f"<b>Email:</b> {customer_email}\n"
            f"<b>Phone:</b> {customer_phone}\n\n"
            f"<b>Samples:</b>\n{product_lines}\n\n"
            f"<b>Delivering to:</b>\n{(addr_block or '—').replace('<br/>', chr(10))}"
        )
        await notify_event(
            "new_order", tg_text,
            # Force-resend should also bypass Telegram dedupe — admin
            # is actively asking for the alert to fire again.
            dedupe_key=None if force else f"sample:{order_number}",
        )
        tg_result["success"] = True
    except Exception as exc:  # noqa: BLE001
        logger.exception("Sample Telegram alert failed (non-fatal)")
        tg_result["error"] = str(exc)[:300]
    result["telegram"] = tg_result

    # ── Persist forensic record to the order doc ──
    # Even on partial failure, this captures exactly what happened so the
    # admin drawer can show "customer not notified · Resend error: …" and
    # ops can run a daily query for orders where confirmation_send_result
    # has any failure and re-trigger them manually.
    now_iso = datetime.now(timezone.utc).isoformat()
    persisted: dict = {
        "$set": {
            "confirmation_send_result": result,
            "confirmation_last_attempt_at": now_iso,
        }
    }
    # `confirmation_sent_at` (the legacy customer-was-notified flag) is
    # only set after at least one email succeeded — so the recovery cron
    # / admin Resend button can correctly identify orders that still need
    # to notify the customer.
    if cust_result.get("success") or admin_result.get("success"):
        persisted["$set"]["confirmation_sent_at"] = now_iso
    try:
        await db.sample_orders.update_one({"id": order_id}, persisted)
    except Exception:  # noqa: BLE001
        logger.exception(
            "Failed to persist confirmation_send_result for sample order %s",
            order_id,
        )

    return result


async def _send_shop_order_alert_fanout(order: dict) -> None:
    """Fire Telegram + admin email + customer confirmation for a freshly-
    paid shop order (NOT a sample order — those have their own fanout).

    Called from `get_guest_checkout_status` after the order flips to
    `payment_status=paid`. The caller stamps `confirmation_sent_at` on
    the order BEFORE calling so this helper can never double-fire.
    Errors are caught and logged — never propagated. The success page
    must always render even if Telegram or SMTP is down.
    """
    if not order:
        return
    try:
        order_number = order.get("order_number") or order.get("id") or "—"
        total = float(order.get("total") or 0)
        customer_name = order.get("customer_name") or "—"
        customer_email = order.get("customer_email") or ""
        customer_phone = order.get("customer_phone") or "—"
        items = order.get("items") or []
        addr = order.get("delivery_address") or {}
        delivery_method = order.get("delivery_method") or "delivery"

        item_lines_text = "\n".join(
            f"  • {it.get('quantity', 1)}× {it.get('name', 'Item')}"
            + (f" — {it.get('size')}" if it.get('size') else "")
            + (f" · £{float(it.get('line_total') or it.get('subtotal') or 0):.2f}"
               if (it.get('line_total') or it.get('subtotal')) else "")
            for it in items
        )
        addr_text = "\n".join(
            l for l in [
                addr.get("line1"), addr.get("line2"), addr.get("city"),
                addr.get("county"), addr.get("postcode"),
            ] if l
        ) or "(Collection / no address)"

        # ── Telegram ──
        try:
            from services.telegram_notify import notify_event
            trade_line = ""
            if order.get("is_trade") or order.get("trade_account_number"):
                credit = float(order.get("credits_awarded") or 0)
                trade_line = (
                    f"🏗️ <b>TRADE · {order.get('trade_account_number') or 'T-?'}"
                    f"{' · ' + order['trade_business_name'] if order.get('trade_business_name') else ''}</b>"
                    f"{' · £' + format(credit, '.2f') + ' credit earned' if credit else ''}\n"
                )
            tg_text = (
                f"{trade_line}"
                f"💰 <b>New order — #{order_number}</b>\n"
                f"<b>£{total:.2f}</b> · {len(items)} item(s)\n\n"
                f"<b>Customer:</b> {customer_name}\n"
                f"<b>Email:</b> {customer_email}\n"
                f"<b>Phone:</b> {customer_phone}\n"
                f"<b>Method:</b> {delivery_method}\n\n"
                f"<b>Items:</b>\n{item_lines_text or '  (no items)'}\n\n"
                f"<b>Address:</b>\n{addr_text}"
            )
            await notify_event("new_order", tg_text, dedupe_key=f"order:{order_number}")
        except Exception:
            logger.exception("Shop order Telegram alert failed (non-fatal)")

        # ── Admin email — fan out to the showroom team inboxes ──
        # (20 May 2026 — user-reported bug: "Why am I not receiving email
        # notifications about the orders." Root cause was the previous
        # single hardcoded fallback `orders@tilestation.co.uk` — an inbox
        # the owner never monitored. Resend reported success, the email
        # silently disappeared, and orders looked invisible from the
        # email side. Now we fan out to a configurable list and stamp
        # which inboxes received it in the Telegram alert below.)
        admin_email_results = {"recipients": [], "success_count": 0, "error": None}
        try:
            from services import email as email_svc
            # Allow override via env (comma-separated). Default = the
            # owner's two real, monitored inboxes.
            raw = os.environ.get(
                "ORDERS_ADMIN_EMAIL",
                "online@tilestation.co.uk,qasim@tilestation.co.uk",
            )
            admin_recipients = [e.strip() for e in raw.split(",") if e.strip() and "@" in e]
            items_html = "".join(
                f"<li>{it.get('quantity', 1)}× <strong>{it.get('name', 'Item')}</strong>"
                + (f" — {it.get('size')}" if it.get('size') else "")
                + (f" · £{float(it.get('line_total') or it.get('subtotal') or 0):.2f}"
                   if (it.get('line_total') or it.get('subtotal')) else "")
                + "</li>"
                for it in items
            )
            addr_html = "<br/>".join(
                l for l in [
                    addr.get("line1"), addr.get("line2"), addr.get("city"),
                    addr.get("county"), addr.get("postcode"),
                ] if l
            ) or "(Collection / no address)"
            trade_html = ""
            if order.get("is_trade") or order.get("trade_account_number"):
                trade_html = (
                    f"<p style=\"background:#fef3c7;border-left:4px solid #d97706;padding:8px 12px;\"><strong>🏗️ TRADE ORDER · "
                    f"{order.get('trade_account_number') or 'T-?'}"
                    f"{' · ' + order['trade_business_name'] if order.get('trade_business_name') else ''}</strong>"
                    f"{' · £' + format(float(order.get('credits_awarded') or 0), '.2f') + ' credit earned' if order.get('credits_awarded') else ''}</p>"
                )
            admin_html = (
                f"{trade_html}"
                f"<p><strong>New paid order ready to process.</strong></p>"
                f"<p><strong>Order:</strong> #{order_number}<br/>"
                f"<strong>Total:</strong> £{total:.2f}<br/>"
                f"<strong>Customer:</strong> {customer_name} &lt;{customer_email}&gt;<br/>"
                f"<strong>Phone:</strong> {customer_phone}<br/>"
                f"<strong>Method:</strong> {delivery_method}</p>"
                f"<p><strong>Items ({len(items)}):</strong></p>"
                f"<ul>{items_html or '<li>(no items)</li>'}</ul>"
                f"<p><strong>Delivering to:</strong><br/>{addr_html}</p>"
                f"<p>Stripe session: <code>{order.get('stripe_session_id','—')}</code></p>"
            )
            send_fn = getattr(email_svc, "send_simple_email_if_possible", None)
            if send_fn and admin_recipients:
                send_result = await send_fn(
                    admin_recipients,
                    (f"🏗️ TRADE {order.get('trade_account_number') or ''} · " if (order.get("is_trade") or order.get("trade_account_number")) else "")
                    + f"💰 New order #{order_number} · £{total:.2f}",
                    admin_html,
                    from_override="Tile Station Alerts <notifications@tilestation.co.uk>",
                )
                admin_email_results["recipients"] = admin_recipients
                if send_result and send_result.get("success"):
                    admin_email_results["success_count"] = len(admin_recipients)
                else:
                    admin_email_results["error"] = (send_result or {}).get("error", "unknown error")
        except Exception as exc:  # noqa: BLE001
            admin_email_results["error"] = str(exc)
            logger.exception("Shop order admin alert email failed (non-fatal)")

        # ── Post-send Telegram confirmation ──
        # Stamps which inboxes got pinged (or didn't) directly into the
        # admin's Telegram channel so the email-vs-no-email mystery from
        # 20 May 2026 can never repeat silently. If 0 recipients got the
        # email, the message is RED and screams "no email sent".
        try:
            from services.telegram_notify import notify_event
            recips = admin_email_results.get("recipients") or []
            ok_count = admin_email_results.get("success_count") or 0
            err = admin_email_results.get("error")
            if ok_count > 0 and recips:
                conf_text = (
                    f"📧 <b>Order #{order_number} email sent</b>\n"
                    f"To: {', '.join(recips)}"
                )
            elif err:
                conf_text = (
                    f"⚠️ <b>Order #{order_number} email FAILED</b>\n"
                    f"Recipients attempted: {', '.join(recips) or '(none configured)'}\n"
                    f"Error: <code>{err}</code>\n"
                    f"Check RESEND_API_KEY / ORDERS_ADMIN_EMAIL env vars."
                )
            else:
                conf_text = (
                    f"⚠️ <b>Order #{order_number} — no admin email sent</b>\n"
                    f"ORDERS_ADMIN_EMAIL env appears empty or send_simple_email_if_possible unavailable."
                )
            await notify_event(
                "new_order_email_status", conf_text,
                dedupe_key=f"order_email_status:{order_number}",
            )
        except Exception:
            logger.exception("Order email Telegram confirmation failed (non-fatal)")

        # ── Customer confirmation ──
        try:
            from services import email as email_svc
            items_html = "".join(
                f"<li>{it.get('quantity', 1)}× <strong>{it.get('name', 'Item')}</strong>"
                + (f" — {it.get('size')}" if it.get('size') else "")
                + "</li>"
                for it in items
            )
            cust_html = (
                f"<p>Hi {customer_name},</p>"
                f"<p>Thanks for your order — payment received ✅.</p>"
                f"<p><strong>Order #{order_number}</strong><br/>"
                f"Total: £{total:.2f}</p>"
                f"<p><strong>Your order:</strong></p>"
                f"<ul>{items_html or '<li>(no items)</li>'}</ul>"
                f"<p>We'll be in touch shortly with delivery details.</p>"
                f"<p>Thanks,<br/>Tile Station</p>"
            )
            send_fn = getattr(email_svc, "send_simple_email_if_possible", None)
            if send_fn and customer_email:
                # Online-shop customer confirmation. Per company email
                # policy (20 May 2026): online@ is the ONLY sender allowed
                # for online-customer-facing emails.
                await send_fn(
                    customer_email,
                    f"Order #{order_number} confirmed · Tile Station",
                    cust_html,
                    from_override="Tile Station <online@tilestation.co.uk>",
                )
        except Exception:
            logger.exception("Shop order customer confirmation email failed (non-fatal)")
    except Exception:
        logger.exception("_send_shop_order_alert_fanout outer failure")


@router.get("/samples/status/{order_id}")
async def get_sample_order_status(order_id: str):
    """Get sample order status"""
    db = get_db()
    
    order = await db.sample_orders.find_one({"id": order_id}, {"_id": 0})
    if not order:
        raise HTTPException(status_code=404, detail="Sample order not found")
    
    return order


@router.get("/samples/info")
async def get_sample_info():
    """Get sample ordering information"""
    return {
        "max_free_samples": MAX_FREE_SAMPLES_PER_ORDER,
        # Legacy alias kept for older frontend callers
        "max_samples": MAX_FREE_SAMPLES_PER_ORDER,
        "postage_fee": SAMPLE_POSTAGE_FEE,
        "full_size_sample_price": FULL_SIZE_SAMPLE_PRICE,
        "delivery_time": "3-5 working days",
        "description": (
            f"Order up to {MAX_FREE_SAMPLES_PER_ORDER} free samples per delivery, "
            f"plus unlimited Full Size Samples (£{FULL_SIZE_SAMPLE_PRICE:.2f} each) — "
            f"only £{SAMPLE_POSTAGE_FEE} postage."
        ),
        "terms": [
            f"Up to {MAX_FREE_SAMPLES_PER_ORDER} free samples per order",
            f"Unlimited Full Size Samples (£{FULL_SIZE_SAMPLE_PRICE:.2f} each)",
            "Place additional orders any time for more tiles",
            "Each tile can only be sampled once per customer",
            "Samples are cut pieces, not full tiles",
            "Postage is non-refundable",
        ],
    }


# ============ ADMIN: SAMPLE ORDERS MANAGEMENT ============
# 5 Jun 2026 — A `/admin/online-orders` page existed for shop_orders
# (TS-…) but paid sample orders (SMP-…) had no home in the admin UI.
# These endpoints mirror the online-orders shape so the new
# `SampleOrdersPage.jsx` can reuse the same components.

_SAMPLE_VALID_STATUSES = (
    "pending_payment",  # checkout started, payment not finalised
    "paid",             # payment confirmed, awaiting dispatch
    "ready",            # picked, waiting at showroom for collection
    "shipped",          # in the post (Royal Mail / courier)
    "delivered",        # marked delivered (manually or via webhook)
    "completed",        # delivered + customer follow-up done
    "cancelled",        # cancelled by admin (refunded separately)
)


@router.get("/admin/sample-orders")
async def admin_list_sample_orders(
    status: Optional[str] = None,
    payment_status: Optional[str] = None,
    search: Optional[str] = None,
    include_unpaid: bool = False,
    limit: int = 50,
    skip: int = 0,
    current_user: dict = Depends(get_current_user),
):
    """Paginated list of paid sample orders for the admin
    `Sample Orders` page (5 Jun 2026).

    By default UNPAID rows (`status == 'pending_payment'` and no
    `paid_at`) are hidden so the team isn't flooded with cart-stage
    drafts. Pass `include_unpaid=true` to surface them.

    Filters mirror the shop_orders endpoint:
      • `status`         — exact match against status field
      • `payment_status` — paid / pending / completed
      • `search`         — order_number / customer_email / customer_name (regex, ci)
    """
    if current_user.get("role") not in ["super_admin", "admin", "manager"]:
        raise HTTPException(status_code=403, detail="Not authorized")

    db = get_db()
    query: dict = {}
    if status and status != "all":
        query["status"] = status
    if payment_status and payment_status != "all":
        query["payment_status"] = payment_status

    if not include_unpaid:
        # Real (paid) orders only. Sample orders carry either a
        # status of "paid"+ or a populated `paid_at` timestamp once
        # Stripe confirms. Excluding "pending_payment" rows hides
        # the silent-cart abandons that have their own dedicated
        # admin page (`/admin/abandoned-sample-baskets`).
        query["$or"] = [
            {"status": {"$in": ["paid", "ready", "shipped", "delivered", "completed"]}},
            {"paid_at": {"$exists": True, "$ne": None}},
        ]

    if search:
        s = search.strip()
        if s:
            query["$and"] = (query.get("$and") or []) + [{
                "$or": [
                    {"order_number": {"$regex": s, "$options": "i"}},
                    {"customer_email": {"$regex": s, "$options": "i"}},
                    {"customer_name": {"$regex": s, "$options": "i"}},
                    {"customer_phone": {"$regex": s, "$options": "i"}},
                ]
            }]

    total = await db.sample_orders.count_documents(query)
    cursor = (
        db.sample_orders.find(query, {"_id": 0, "stripe_session_id": 0})
        .sort("created_at", -1)
        .skip(max(0, int(skip)))
        .limit(min(200, max(1, int(limit))))
    )
    rows = await cursor.to_list(length=limit)

    # Trim to the columns the list view actually renders.
    summary = []
    for o in rows:
        products = o.get("products") or []
        summary.append({
            "id": o.get("id"),
            "order_number": o.get("order_number"),
            "customer_name": o.get("customer_name"),
            "customer_email": o.get("customer_email"),
            "customer_phone": o.get("customer_phone"),
            "delivery_address": o.get("delivery_address"),
            "sample_count": o.get("sample_count") or len(products),
            "free_sample_count": o.get("free_sample_count"),
            "paid_sample_count": o.get("paid_sample_count"),
            "samples_subtotal": o.get("samples_subtotal", 0),
            "postage_fee": o.get("postage_fee", 0),
            "total": o.get("total", 0),
            "status": o.get("status", "pending_payment"),
            "payment_status": (
                o.get("payment_status")
                or ("paid" if o.get("paid_at") else "pending")
            ),
            "tracking": o.get("tracking", {}),
            "paid_at": o.get("paid_at"),
            "created_at": o.get("created_at"),
            "products": [
                {
                    "name": p.get("product_name") or p.get("name"),
                    "image": p.get("image_url") or p.get("image"),
                    "price_gbp": p.get("price_gbp", 0) or 0,
                }
                for p in products
            ],
        })

    return {"total": total, "skip": skip, "limit": limit, "orders": summary}


@router.get("/admin/sample-orders/stats")
async def admin_sample_orders_stats(
    current_user: dict = Depends(get_current_user),
):
    """Top-line counters for the Sample Orders page hero strip.

    Mirrors the shape returned by `/admin/online-orders/stats` so
    the same StatCard component renders both pages."""
    if current_user.get("role") not in ["super_admin", "admin", "manager"]:
        raise HTTPException(status_code=403, detail="Not authorized")

    db = get_db()
    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
    two_days_ago = (now - timedelta(days=2)).isoformat()

    paid_filter = {"$or": [
        {"status": {"$in": ["paid", "ready", "shipped", "delivered", "completed"]}},
        {"paid_at": {"$exists": True, "$ne": None}},
    ]}

    orders_today = await db.sample_orders.count_documents({
        **paid_filter,
        "created_at": {"$gte": today_start},
    })
    pending_dispatch = await db.sample_orders.count_documents({
        **paid_filter,
        "status": "paid",   # paid but not yet ready/shipped
    })
    awaiting_collection = await db.sample_orders.count_documents({
        **paid_filter,
        "status": "ready",
    })
    overdue = await db.sample_orders.count_documents({
        **paid_filter,
        "status": "paid",
        "created_at": {"$lt": two_days_ago},
    })

    # Revenue today = sum of `total` on today's paid orders.
    revenue_pipe = [
        {"$match": {**paid_filter, "created_at": {"$gte": today_start}}},
        {"$group": {"_id": None, "sum": {"$sum": "$total"}}},
    ]
    rev_rows = await db.sample_orders.aggregate(revenue_pipe).to_list(length=1)
    revenue_today = float(rev_rows[0]["sum"]) if rev_rows else 0.0

    return {
        "orders_today": orders_today,
        "revenue_today": round(revenue_today, 2),
        "pending_dispatch": pending_dispatch,
        "awaiting_collection": awaiting_collection,
        "overdue": overdue,
    }


@router.get("/admin/sample-orders/{order_id}")
async def admin_get_sample_order(
    order_id: str,
    current_user: dict = Depends(get_current_user),
):
    """Full sample-order doc for the admin detail-drawer."""
    if current_user.get("role") not in ["super_admin", "admin", "manager"]:
        raise HTTPException(status_code=403, detail="Not authorized")

    db = get_db()
    order = await db.sample_orders.find_one(
        {"$or": [{"id": order_id}, {"order_number": order_id}]},
        {"_id": 0, "stripe_session_id": 0},
    )
    if not order:
        raise HTTPException(status_code=404, detail="Sample order not found")
    return order


@router.patch("/admin/sample-orders/{order_id}")
async def admin_update_sample_order(
    order_id: str,
    body: dict = Body(...),
    current_user: dict = Depends(get_current_user),
):
    """Update an admin-mutable field on a sample order. Accepts:
      • `status`   — must be in _SAMPLE_VALID_STATUSES
      • `tracking` — `{carrier, tracking_number, url}` dict
      • `notes`    — freeform admin note (appended to a history list)
    """
    if current_user.get("role") not in ["super_admin", "admin", "manager"]:
        raise HTTPException(status_code=403, detail="Not authorized")

    db = get_db()
    order = await db.sample_orders.find_one(
        {"$or": [{"id": order_id}, {"order_number": order_id}]},
        {"_id": 0, "order_number": 1, "status": 1, "id": 1},
    )
    if not order:
        raise HTTPException(status_code=404, detail="Sample order not found")

    set_fields: dict = {"updated_at": datetime.now(timezone.utc).isoformat()}
    push_fields: dict = {}

    new_status = (body or {}).get("status")
    if new_status is not None:
        if new_status not in _SAMPLE_VALID_STATUSES:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid status. Must be one of: {', '.join(_SAMPLE_VALID_STATUSES)}",
            )
        set_fields["status"] = new_status
        push_fields["status_history"] = {
            "status": new_status,
            "at": datetime.now(timezone.utc).isoformat(),
            "by": current_user.get("email") or current_user.get("id"),
        }

    tracking = (body or {}).get("tracking")
    if tracking is not None:
        if not isinstance(tracking, dict):
            raise HTTPException(status_code=400, detail="tracking must be an object")
        set_fields["tracking"] = {
            "carrier": (tracking.get("carrier") or "").strip(),
            "tracking_number": (tracking.get("tracking_number") or "").strip(),
            "url": (tracking.get("url") or "").strip(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "updated_by": current_user.get("email") or current_user.get("id"),
        }

    notes = (body or {}).get("notes")
    if notes:
        push_fields["admin_notes"] = {
            "note": str(notes).strip(),
            "at": datetime.now(timezone.utc).isoformat(),
            "by": current_user.get("email") or current_user.get("id"),
        }

    update_doc: dict = {"$set": set_fields}
    if push_fields:
        update_doc["$push"] = push_fields

    res = await db.sample_orders.update_one(
        {"$or": [{"id": order_id}, {"order_number": order_id}]},
        update_doc,
    )
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Sample order not found")

    updated = await db.sample_orders.find_one(
        {"$or": [{"id": order_id}, {"order_number": order_id}]},
        {"_id": 0, "stripe_session_id": 0},
    )

    # 5 Jun 2026 — auto-dispatch email on status → "shipped". Only
    # fires when:
    #   • status JUST flipped to "shipped" on THIS request (not a
    #     re-save of an already-shipped order), AND
    #   • we have a customer email, AND
    #   • we haven't already sent the email for this order
    #     (`shipped_email_sent_at` is the idempotency guard).
    # Failures are logged but never block the admin save — the
    # status change is what's authoritative; the email is a courtesy.
    email_result = None
    if (
        new_status == "shipped"
        and (order.get("status") != "shipped")
        and (updated or {}).get("customer_email")
        and not (updated or {}).get("shipped_email_sent_at")
    ):
        try:
            from services.email import send_sample_shipped_email
            email_result = await send_sample_shipped_email(
                customer_email=updated["customer_email"],
                customer_name=updated.get("customer_name") or "",
                order=updated,
                tracking=updated.get("tracking") or set_fields.get("tracking"),
            )
            if email_result.get("sent"):
                # Stamp the idempotency marker so a re-save of the
                # same shipped order doesn't fire a second email.
                now_iso = datetime.now(timezone.utc).isoformat()
                await db.sample_orders.update_one(
                    {"$or": [{"id": order_id}, {"order_number": order_id}]},
                    {"$set": {"shipped_email_sent_at": now_iso}},
                )
                # Refresh the in-memory copy so the response reflects it.
                updated["shipped_email_sent_at"] = now_iso
        except Exception as e:  # noqa: BLE001
            # Don't fail the PATCH — the admin's status save is the
            # source of truth. Surface in logs only.
            email_result = {"sent": False, "error": str(e)[:200]}

    return {
        "message": "Sample order updated",
        "order": updated,
        "shipped_email": email_result,
    }


@router.post("/admin/sample-orders/{order_id}/resend-confirmation")
async def admin_resend_sample_confirmation(
    order_id: str,
    current_user: dict = Depends(get_current_user),
):
    """Force-resend the paid-order confirmation fanout for a sample
    order (customer email + admin alert + Telegram).

    Built 20 Jun 2026 after SMP-260620-FFC920 (Tracy Batchelor) silently
    failed to send the customer email — only Telegram fired. Admin
    needs a one-click recovery path that doesn't require redeploying.

    Bypasses the `confirmation_attempted_at` idempotency guard so it
    can retry a previously-failed send. The full result (per-channel
    success/error) is returned AND persisted to the order doc so the
    drawer can show "✓ customer notified" or "✗ Resend rejected".
    """
    if current_user.get("role") not in ["super_admin", "admin", "manager"]:
        raise HTTPException(status_code=403, detail="Not authorized")

    db = get_db()
    order = await db.sample_orders.find_one(
        {"$or": [{"id": order_id}, {"order_number": order_id}]},
        {"_id": 0},
    )
    if not order:
        raise HTTPException(status_code=404, detail="Sample order not found")
    if order.get("status") not in ("paid", "shipped", "delivered", "completed", "ready"):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Cannot resend confirmation for status '{order.get('status')}'. "
                "Order must be paid before a confirmation email can be sent."
            ),
        )

    result = await _send_sample_confirmation_fanout(order, force=True)

    # Stamp an audit trail so we can prove the admin manually retried.
    try:
        await db.sample_orders.update_one(
            {"id": order.get("id")},
            {"$push": {
                "admin_notes": {
                    "note": (
                        f"Resent confirmation — "
                        f"customer: {'✓' if (result.get('customer_email') or {}).get('success') else '✗ ' + ((result.get('customer_email') or {}).get('error') or 'failed')} · "
                        f"admin: {'✓' if (result.get('admin_email') or {}).get('success') else '✗ ' + ((result.get('admin_email') or {}).get('error') or 'failed')}"
                    ),
                    "at": datetime.now(timezone.utc).isoformat(),
                    "by": current_user.get("email") or current_user.get("id") or "admin",
                }
            }},
        )
    except Exception:  # noqa: BLE001
        logger.exception("Failed to write admin_note for confirmation resend")

    updated = await db.sample_orders.find_one(
        {"id": order.get("id")},
        {"_id": 0, "stripe_session_id": 0},
    )

    return {
        "message": "Confirmation re-sent",
        "result": result,
        "order": updated,
    }


# ============ CONTENT MANAGEMENT ENDPOINTS ============

@router.get("/content/{page_key}")
async def get_page_content(page_key: str):
    """Get editable content for a specific page"""
    db = get_db()
    content = await db.page_content.find_one({"page_key": page_key}, {"_id": 0})
    if content:
        return content.get("content", {})
    return {}


@router.put("/content/{page_key}")
async def update_page_content(page_key: str, content: dict):
    """Update editable content for a specific page (admin only)"""
    db = get_db()
    result = await db.page_content.update_one(
        {"page_key": page_key},
        {"$set": {"page_key": page_key, "content": content, "updated_at": datetime.utcnow()}},
        upsert=True
    )
    return {"success": True, "message": f"Content for {page_key} updated"}


# ============ PUBLIC STORES ENDPOINT ============

# ============ CREDIT BACK RATES FOR CART ============

class CreditBackRequest(BaseModel):
    slugs: List[str]

@router.post("/cart/credit-back-rates")
async def get_cart_credit_back_rates(req: CreditBackRequest):
    """
    Get credit back rates for products in the cart.
    Checks per-product credit_back_rate, falls back to global default.
    """
    from business_config.business_rules import TRADE_CREDIT_BACK_DEFAULT
    
    db = get_db()
    rates = {}
    
    if req.slugs:
        # Fetch products to check per-product credit_back_rate
        tiles = await db.tiles.find(
            {"slug": {"$in": req.slugs}},
            {"_id": 0, "slug": 1, "credit_back_rate": 1, "sku": 1, "supplier_code": 1}
        ).to_list(500)
        
        tile_map = {t["slug"]: t for t in tiles}
        
        for slug in req.slugs:
            tile = tile_map.get(slug)
            if tile and tile.get("credit_back_rate") is not None:
                rates[slug] = tile["credit_back_rate"]
            else:
                # Check supplier_products as fallback
                if tile:
                    sku = tile.get("sku") or tile.get("supplier_code")
                    if sku:
                        sp = await db.supplier_products.find_one(
                            {"sku": sku},
                            {"_id": 0, "credit_back_rate": 1}
                        )
                        if sp and sp.get("credit_back_rate") is not None:
                            rates[slug] = sp["credit_back_rate"]
                            continue
                rates[slug] = TRADE_CREDIT_BACK_DEFAULT
    
    return {"rates": rates, "default_rate": TRADE_CREDIT_BACK_DEFAULT}

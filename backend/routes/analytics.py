"""
Analytics and dashboard routes
"""
import calendar
import logging
import os
import uuid
import time
from datetime import datetime, timezone, timedelta
from typing import Optional
from collections import defaultdict
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

from config import get_db
from services import get_current_user, is_admin_user, has_permission, log_audit

logger = logging.getLogger(__name__)

# Simple in-memory cache for analytics data (TTL: 60 seconds)
_analytics_cache = {}
_CACHE_TTL = 60  # seconds

def get_cached_analytics(cache_key: str):
    """Get cached analytics data if still valid"""
    if cache_key in _analytics_cache:
        data, timestamp = _analytics_cache[cache_key]
        if time.time() - timestamp < _CACHE_TTL:
            return data
    return None

def set_cached_analytics(cache_key: str, data):
    """Cache analytics data with timestamp"""
    _analytics_cache[cache_key] = (data, time.time())

def clear_analytics_cache():
    """Clear all analytics cache"""
    global _analytics_cache
    _analytics_cache = {}

def can_access_dashboard(user: dict) -> bool:
    """Check if user can access dashboard (admin or has dashboard permission)"""
    if is_admin_user(user):
        return True
    return has_permission(user, "dashboard")


def parse_document_date(date_str: str) -> datetime:
    """
    Parse a document date in DD/MM/YYYY format to a datetime object.
    Returns UTC datetime for the start of that day.
    """
    try:
        if not date_str:
            return None
        # Handle DD/MM/YYYY format
        parts = date_str.split("/")
        if len(parts) == 3:
            day, month, year = int(parts[0]), int(parts[1]), int(parts[2])
            return datetime(year, month, day, 0, 0, 0, tzinfo=timezone.utc)
        # Try ISO format as fallback
        return datetime.fromisoformat(date_str.replace("Z", "+00:00"))
    except:
        return None


def get_document_date_str(date_str: str) -> str:
    """
    Convert DD/MM/YYYY to YYYY-MM-DD for sorting and comparison.
    """
    try:
        if not date_str:
            return ""
        parts = date_str.split("/")
        if len(parts) == 3:
            day, month, year = parts[0].zfill(2), parts[1].zfill(2), parts[2]
            return f"{year}-{month}-{day}"
        return date_str
    except:
        return ""


def is_date_in_range(doc_date: str, start: datetime, end: datetime) -> bool:
    """
    Check if a document date (DD/MM/YYYY) falls within the given date range.
    """
    parsed = parse_document_date(doc_date)
    if not parsed:
        return False
    # Set end to end of day for inclusive comparison
    end_of_day = end.replace(hour=23, minute=59, second=59, microsecond=999999)
    start_of_day = start.replace(hour=0, minute=0, second=0, microsecond=0)
    return start_of_day <= parsed <= end_of_day


def format_date_for_query(dt: datetime) -> str:
    """
    Format a datetime to DD/MM/YYYY for querying document dates.
    """
    return dt.strftime("%d/%m/%Y")


router = APIRouter(tags=["Analytics"])


# ============ HELPERS ============

# Children of /shop/ that are NOT product detail pages — used by _is_pdp_url
# below to filter the storefront's auth/utility routes out of the Hot Session
# heuristic so we only count genuine product views.
_NON_PDP_SHOP_SEGMENTS = {
    "login", "register", "trade", "auth", "checkout", "basket",
    "cart", "search", "contact", "about", "stores", "wishlist",
    "compare", "account", "profile", "samples", "calculator",
    "info", "refer", "terms", "privacy", "delivery", "returns",
}


def _is_pdp_url(url: str) -> bool:
    """True when a URL looks like a product detail page (or product list slug).
    Mirrors the loose convention used elsewhere in this file but excludes
    obvious non-product children of /shop/ (login, register, basket, etc.).
    """
    if not url:
        return False
    path = url.split("?")[0].split("#")[0]
    parts = [p for p in path.split("/") if p]
    if len(parts) < 2:
        return False
    if parts[0].lower() not in {"shop", "tile", "product", "product-detail"}:
        return False
    if parts[0].lower() == "shop" and parts[1].lower() in _NON_PDP_SHOP_SEGMENTS:
        return False
    return True


# ============ MODELS ============

class DashboardStats(BaseModel):
    total_products: int
    low_stock_count: int
    total_orders: int
    pending_orders: int
    total_revenue: float

class SalesTargetCreate(BaseModel):
    showroom_id: Optional[str] = None
    month: int
    year: int
    monthly_target: float
    target_type: str = "sales"  # sales, bonus, or company


# ============ ROUTES ============

@router.get("/dashboard/stats")
async def get_dashboard_stats(current_user: dict = Depends(get_current_user)):
    """Get dashboard statistics"""
    if not can_access_dashboard(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    
    # Build showroom filter for non-super-admin users
    showroom_filter = {}
    user_showroom_id = current_user.get("showroom_id")
    if current_user.get("role") != "super_admin" and user_showroom_id:
        showroom_filter["showroom_id"] = user_showroom_id
    
    total_products = await db.products.count_documents({})
    
    products = await db.products.find({}, {"_id": 0, "stock": 1, "reorder_level": 1}).to_list(100000)
    # Fix: Handle None values for stock and reorder_level
    low_stock_count = sum(1 for p in products if (p.get('stock') or 0) <= (p.get('reorder_level') or 10))
    
    # Filter orders by showroom
    total_orders = await db.orders.count_documents(showroom_filter)
    pending_orders = await db.orders.count_documents({**showroom_filter, "status": "pending"})
    
    orders = await db.orders.find(showroom_filter, {"_id": 0, "total_amount": 1}).to_list(100000)
    total_revenue = sum(order.get('total_amount', 0) for order in orders)
    
    # Also include invoice revenue for the showroom - using actual paid amounts
    # EXCLUDE soft-deleted invoices
    invoice_query = {**showroom_filter, "deleted_at": {"$exists": False}}
    invoices = await db.invoices.find(invoice_query, {"_id": 0, "gross_total": 1, "deposits": 1}).to_list(100000)
    invoice_revenue = 0
    for inv in invoices:
        gross_total = inv.get("gross_total", 0)
        deposits = inv.get("deposits", [])
        total_deposits = sum(float(d.get("amount", 0)) for d in deposits)
        outstanding = round(max(0, gross_total - total_deposits) * 100) / 100
        # If deposit order with outstanding, only count paid
        if total_deposits > 0 and outstanding > 0:
            invoice_revenue += total_deposits
        else:
            invoice_revenue += gross_total
    total_revenue = max(total_revenue, invoice_revenue)
    
    return DashboardStats(
        total_products=total_products,
        low_stock_count=low_stock_count,
        total_orders=total_orders,
        pending_orders=pending_orders,
        total_revenue=total_revenue
    )


@router.get("/dashboard/best-sellers")
async def get_best_selling_products(
    period: str = "month",
    limit: int = 5,
    current_user: dict = Depends(get_current_user)
):
    """Get best selling products based on invoice data"""
    if not can_access_dashboard(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    
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
    
    end = now
    
    # Get invoices and filter by document date - EXCLUDE soft-deleted invoices
    invoice_query = {**showroom_filter, "deleted_at": {"$exists": False}}
    all_invoices = await db.invoices.find(invoice_query, {"_id": 0, "date": 1, "line_items": 1}).to_list(100000)
    invoices = [inv for inv in all_invoices if is_date_in_range(inv.get("date", ""), start, end)]
    
    # Aggregate product sales
    product_sales = defaultdict(lambda: {"quantity": 0, "revenue": 0, "name": "", "sku": ""})
    
    for invoice in invoices:
        for item in invoice.get("line_items", []):
            product_id = item.get("product_id")
            if product_id:
                qty = item.get("quantity") or 0  # Fix: Handle None
                price = item.get("price") or 0  # Fix: Handle None
                discount = item.get("discount", 0)
                item_revenue = qty * price * (1 - discount / 100)
                
                product_sales[product_id]["quantity"] += qty
                product_sales[product_id]["revenue"] += item_revenue
                product_sales[product_id]["name"] = item.get("product_name", "Unknown")
                product_sales[product_id]["sku"] = item.get("sku", "")
    
    # Sort by quantity sold
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
    
    # Get product details and calculate profit for super admin
    total_profit = 0
    total_cost = 0
    products_with_cost_count = 0
    revenue_with_cost = 0
    
    for product in top_by_quantity + top_by_revenue:
        prod = await db.products.find_one({"id": product["product_id"]}, {"_id": 0, "images": 1, "cost": 1})
        product["image"] = prod.get("images", [None])[0] if prod else None
        product["revenue"] = round(product["revenue"], 2)
        
        if is_super_admin:
            cost = prod.get("cost", 0) if prod else 0
            # Only calculate profit if cost is allocated (cost > 0)
            if cost and cost > 0:
                product["cost"] = cost
                product["total_cost"] = round(cost * product["quantity"], 2)
                product["profit"] = round(product["revenue"] - product["total_cost"], 2)
                product["margin"] = round((product["profit"] / product["revenue"] * 100), 1) if product["revenue"] > 0 else 0
                product["has_cost"] = True
            else:
                product["cost"] = 0
                product["total_cost"] = 0
                product["profit"] = None  # No profit calculation without cost
                product["margin"] = None
                product["has_cost"] = False
    
    # Calculate overall totals for super admin - only for products with cost allocated
    if is_super_admin:
        for pid, data in product_sales.items():
            prod = await db.products.find_one({"id": pid}, {"_id": 0, "cost": 1})
            cost = prod.get("cost", 0) if prod else 0
            # Only include in profit calculation if cost is allocated
            if cost and cost > 0:
                item_cost = cost * data["quantity"]
                total_cost += item_cost
                total_profit += data["revenue"] - item_cost
                products_with_cost_count += 1
                revenue_with_cost += data["revenue"]
        
        # Calculate margin only on revenue from products with cost
        overall_margin = round((total_profit / revenue_with_cost * 100), 1) if revenue_with_cost > 0 else 0
    else:
        overall_margin = None
    
    response = {
        "period": period,
        "top_by_quantity": top_by_quantity,
        "top_by_revenue": top_by_revenue,
        "total_products_sold": sum(p["quantity"] for p in product_sales.values()),
        "total_revenue": round(sum(p["revenue"] for p in product_sales.values()), 2),
    }
    
    if is_super_admin:
        response["total_cost"] = round(total_cost, 2)
        response["total_profit"] = round(total_profit, 2)
        response["overall_margin"] = overall_margin
        response["products_with_cost"] = products_with_cost_count
        response["revenue_with_cost"] = round(revenue_with_cost, 2)
        response["show_profit"] = True
        response["profit_note"] = "Profit calculated only for products with cost allocated"
    else:
        response["show_profit"] = False
    
    return response


# ============================================================================
# Return Heatmap — Feb 26, 2026
#
# Aggregates the last N days of return activity from TWO sources so the
# Dashboard widget reflects the FULL refund picture, not just one path:
#
#   1. `invoices.line_items[*]` where is_return=True
#      → Per-line returns done inside an invoice (the EPOS Return checkbox
#        flow introduced today). These now carry original_invoice_no for
#        audit but each return line is itself just a flagged invoice row.
#
#   2. `refunds.line_items[*]`
#      → Refunds processed via the dedicated Refund page (existing flow).
#        These already had structured refund_price/quantity data.
#
# Each return is enriched with supplier info via the `products` collection
# (joined on sku, fallback to product_id, fallback to product_name) so the
# tile can also show top-returning SUPPLIERS, not just products.
#
# Bonus output: per-product return RATE % = units_returned / units_sold
# over the same period (so a tile that sells 1000 units and returns 5 is
# clearly distinguishable from a tile that sells 8 and returns 5).
# ============================================================================
@router.get("/analytics/return-heatmap")
async def get_return_heatmap(
    days: int = 30,
    limit_products: int = 8,
    limit_suppliers: int = 5,
    current_user: dict = Depends(get_current_user)
):
    """Top returning products + suppliers over the last `days` window."""
    if not can_access_dashboard(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")

    # Clamp to reasonable bounds so a runaway client can't pull 10 years.
    days = max(1, min(int(days or 30), 365))
    limit_products = max(1, min(int(limit_products or 8), 50))
    limit_suppliers = max(1, min(int(limit_suppliers or 5), 50))

    db = get_db()
    now = datetime.now(timezone.utc)
    start = now - timedelta(days=days)

    # Showroom scoping — non-super-admin sees only their own store.
    showroom_filter = {}
    if current_user.get("role") != "super_admin" and current_user.get("showroom_id"):
        showroom_filter["showroom_id"] = current_user["showroom_id"]

    # ── Load the product catalogue ONCE to enrich return rows with supplier
    #    + canonical name. Index lookups twice (sku → prod, id → prod) so the
    #    join hits regardless of which key the line item carries.
    products = await db.products.find(
        {},
        {"_id": 0, "id": 1, "sku": 1, "name": 1, "supplier_id": 1, "supplier_name": 1}
    ).to_list(100000)
    by_sku = {p.get("sku"): p for p in products if p.get("sku")}
    by_id = {p.get("id"): p for p in products if p.get("id")}

    def _resolve_product(li: dict) -> dict:
        sku = li.get("sku")
        pid = li.get("product_id")
        if sku and sku in by_sku:
            return by_sku[sku]
        if pid and pid in by_id:
            return by_id[pid]
        return {"name": li.get("product_name") or "Unknown", "sku": sku or "", "supplier_name": None}

    # ── Accumulators ─────────────────────────────────────────────────────
    # Keyed by sku-or-name so a manually-typed product still aggregates
    # rather than fragmenting per typo. Suppliers keyed by supplier_name.
    by_product: dict = {}
    by_supplier: dict = {}
    total_returned_units = 0.0
    total_returned_value = 0.0
    return_event_count = 0  # distinct refund/invoice-line events

    def _bump_product(key: str, qty: float, value: float, name: str, sku: str, supplier: str | None):
        row = by_product.setdefault(key, {
            "key": key, "product_name": name, "sku": sku or "",
            "supplier_name": supplier or "—",
            "units_returned": 0.0, "value_returned": 0.0,
            "units_sold": 0.0, "events": 0,
        })
        row["units_returned"] += float(qty or 0)
        row["value_returned"] += float(value or 0)
        row["events"] += 1

    def _bump_supplier(supplier: str | None, qty: float, value: float):
        key = supplier or "— (no supplier)"
        row = by_supplier.setdefault(key, {
            "supplier_name": key,
            "units_returned": 0.0, "value_returned": 0.0,
            "events": 0,
        })
        row["units_returned"] += float(qty or 0)
        row["value_returned"] += float(value or 0)
        row["events"] += 1

    # ── Source 1: invoices.line_items where is_return=True ───────────────
    # Use date string DD/MM/YYYY parsing via the shared helper to stay
    # consistent with the rest of the analytics module.
    inv_query = {**showroom_filter, "deleted_at": {"$exists": False}}
    invoices = await db.invoices.find(
        inv_query,
        {"_id": 0, "date": 1, "line_items": 1}
    ).to_list(100000)

    for inv in invoices:
        if not is_date_in_range(inv.get("date", ""), start, now):
            continue
        for li in inv.get("line_items") or []:
            qty = float(li.get("quantity") or 0)
            if qty <= 0:
                continue
            # Sold-units denominator: every non-return line in the window.
            if not li.get("is_return"):
                prod = _resolve_product(li)
                key = (li.get("sku") or prod.get("sku") or li.get("product_name") or "unknown").lower()
                row = by_product.setdefault(key, {
                    "key": key,
                    "product_name": prod.get("name") or li.get("product_name") or "Unknown",
                    "sku": (li.get("sku") or prod.get("sku") or ""),
                    "supplier_name": prod.get("supplier_name") or "—",
                    "units_returned": 0.0, "value_returned": 0.0,
                    "units_sold": 0.0, "events": 0,
                })
                row["units_sold"] += qty
                continue
            # Return line — count it.
            prod = _resolve_product(li)
            unit_price = float(li.get("due_price") if li.get("due_price") is not None else li.get("price") or 0)
            value = abs(unit_price * qty)
            sku = li.get("sku") or prod.get("sku") or ""
            key = (sku or li.get("product_name") or "unknown").lower()
            _bump_product(
                key=key, qty=qty, value=value,
                name=prod.get("name") or li.get("product_name") or "Unknown",
                sku=sku, supplier=prod.get("supplier_name"),
            )
            _bump_supplier(prod.get("supplier_name"), qty, value)
            total_returned_units += qty
            total_returned_value += value
            return_event_count += 1

    # ── Source 2: refunds.line_items ─────────────────────────────────────
    # Refunds have refund_price (per unit) — separate from invoice line shape.
    refunds = await db.refunds.find(
        showroom_filter,
        {"_id": 0, "date": 1, "line_items": 1}
    ).to_list(100000)

    for rf in refunds:
        if not is_date_in_range(rf.get("date", ""), start, now):
            continue
        for li in rf.get("line_items") or []:
            qty = float(li.get("quantity") or 0)
            if qty <= 0:
                continue
            prod = _resolve_product(li)
            unit_price = float(li.get("refund_price") if li.get("refund_price") is not None else li.get("original_price") or 0)
            value = abs(unit_price * qty)
            sku = li.get("sku") or prod.get("sku") or ""
            key = (sku or li.get("product_name") or "unknown").lower()
            _bump_product(
                key=key, qty=qty, value=value,
                name=prod.get("name") or li.get("product_name") or "Unknown",
                sku=sku, supplier=prod.get("supplier_name"),
            )
            _bump_supplier(prod.get("supplier_name"), qty, value)
            total_returned_units += qty
            total_returned_value += value
            return_event_count += 1

    # ── Compute return rate per product, then rank ───────────────────────
    products_list = []
    for row in by_product.values():
        if row["units_returned"] <= 0:
            continue  # Skip products that only contributed to the denominator
        rate = (row["units_returned"] / row["units_sold"] * 100.0) if row["units_sold"] > 0 else None
        products_list.append({
            "product_name": row["product_name"],
            "sku": row["sku"],
            "supplier_name": row["supplier_name"],
            "units_returned": round(row["units_returned"], 2),
            "value_returned": round(row["value_returned"], 2),
            "units_sold": round(row["units_sold"], 2),
            "return_rate_pct": round(rate, 1) if rate is not None else None,
            "events": row["events"],
        })
    products_list.sort(key=lambda r: (r["value_returned"], r["units_returned"]), reverse=True)
    top_products = products_list[:limit_products]

    suppliers_list = []
    for row in by_supplier.values():
        suppliers_list.append({
            "supplier_name": row["supplier_name"],
            "units_returned": round(row["units_returned"], 2),
            "value_returned": round(row["value_returned"], 2),
            "events": row["events"],
        })
    suppliers_list.sort(key=lambda r: r["value_returned"], reverse=True)
    top_suppliers = suppliers_list[:limit_suppliers]

    return {
        "window_days": days,
        "start": start.strftime("%Y-%m-%d"),
        "end": now.strftime("%Y-%m-%d"),
        "totals": {
            "events": return_event_count,
            "units": round(total_returned_units, 2),
            "value": round(total_returned_value, 2),
        },
        "top_products": top_products,
        "top_suppliers": top_suppliers,
    }


@router.get("/analytics/showrooms")
async def get_showroom_analytics(
    period: str = "month",
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    """Get showroom-level sales analytics with time filters."""
    if not can_access_dashboard(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    
    is_super_admin = current_user.get("role") == "super_admin"
    user_showroom_id = current_user.get("showroom_id")
    
    # Check cache first
    cache_key = f"showroom_analytics:{period}:{user_showroom_id or 'all'}"
    cached = get_cached_analytics(cache_key)
    if cached:
        logging.info(f"[Analytics] Returning cached data for {cache_key}")
        return cached
    
    # Calculate date range
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
        except:
            start = now - timedelta(days=30)
            end = now
    else:
        start = now - timedelta(days=30)
        end = now
    
    # Build base query for showroom filtering
    base_query = {}
    if not is_super_admin and user_showroom_id:
        base_query["showroom_id"] = user_showroom_id
    
    # Fetch all invoices and filter by document date OR deposit dates (DD/MM/YYYY format) - EXCLUDE soft-deleted
    # Include invoices where either:
    # 1. The invoice date is in range, OR
    # 2. Any deposit payment date is in range (to capture final payments on deposit orders)
    invoice_query = {**base_query, "deleted_at": {"$exists": False}}
    all_invoices = await db.invoices.find(invoice_query, {"_id": 0}).to_list(100000)
    
    def invoice_has_deposit_in_range(invoice, start, end):
        """Check if any deposit on this invoice has a date in the given range"""
        for dep in invoice.get("deposits", []):
            if is_date_in_range(dep.get("date", ""), start, end):
                return True
        return False
    
    invoices = [inv for inv in all_invoices if is_date_in_range(inv.get("date", ""), start, end) or invoice_has_deposit_in_range(inv, start, end)]
    
    # Also get Cash Quotations for the same period (they count towards sales)
    all_cash_quotations = await db.cash_quotations.find(base_query, {"_id": 0}).to_list(100000)
    cash_quotations = [cq for cq in all_cash_quotations if is_date_in_range(cq.get("date", ""), start, end)]
    
    showrooms = await db.showrooms.find({}, {"_id": 0}).to_list(10000)
    showroom_map = {s["id"]: s["name"] for s in showrooms if s.get("id")}
    
    # Aggregate data
    showroom_data = defaultdict(lambda: {
        "revenue": 0, "revenue_ex_vat": 0, "cost": 0, "count": 0, "total_m2": 0,
        "cash_quotation_revenue": 0, "cash_quotation_count": 0,  # Track cash quotations separately
        "products": defaultdict(lambda: {"quantity": 0, "m2": 0, "revenue": 0, "revenue_ex_vat": 0, "cost": 0, "name": "", "product_id": ""})
    })
    
    daily_data = defaultdict(lambda: {"revenue": 0, "revenue_ex_vat": 0, "cost": 0, "count": 0, "total_m2": 0, "cash_quotation_revenue": 0, "cash_quotation_count": 0})
    
    # Cache product costs for super admin - only products with cost > 0
    product_costs = {}
    if is_super_admin:
        # Optimized: Only fetch products that have cost > 0 (using index)
        products = await db.products.find(
            {"cost": {"$gt": 0}, "id": {"$ne": None}}, 
            {"_id": 0, "id": 1, "cost": 1}
        ).to_list(100000)
        product_costs = {p["id"]: p["cost"] for p in products if p.get("id")}
    
    # Helper to calculate actual paid amount for an invoice
    def get_actual_paid(invoice):
        gross_total = invoice.get("gross_total", 0)
        deposits = invoice.get("deposits", [])
        total_deposits = sum(float(d.get("amount", 0)) for d in deposits)
        outstanding = round(max(0, gross_total - total_deposits) * 100) / 100
        # If deposit order with outstanding, return only paid portion
        if total_deposits > 0 and outstanding > 0:
            return total_deposits
        return gross_total
    
    total_revenue = 0
    total_revenue_ex_vat = 0
    total_cost = 0
    total_invoices = len(invoices)
    
    for invoice in invoices:
        showroom_id = invoice.get("showroom_id", "unassigned")
        showroom_name = invoice.get("showroom_name") or showroom_map.get(showroom_id, "Unassigned")
        
        # Use actual paid amount instead of gross_total for revenue
        actual_paid = get_actual_paid(invoice)
        gross_total = invoice.get("gross_total", 0)
        subtotal = invoice.get("subtotal", 0)
        
        # Calculate what portion is paid (for proportional subtotal)
        paid_ratio = actual_paid / gross_total if gross_total > 0 else 1
        actual_subtotal = subtotal * paid_ratio
        
        showroom_data[showroom_id]["revenue"] += actual_paid
        showroom_data[showroom_id]["revenue_ex_vat"] += actual_subtotal
        showroom_data[showroom_id]["count"] += 1
        showroom_data[showroom_id]["name"] = showroom_name
        total_revenue += actual_paid
        total_revenue_ex_vat += actual_subtotal
        
        for item in invoice.get("line_items", []):
            product_id = item.get("product_id", "unknown")
            qty = item.get("quantity") or 0  # Fix: Handle None values
            item_m2 = item.get("m2") or 0  # Fix: Handle None values
            price = item.get("price") or 0  # Fix: Handle None values
            discount = item.get("discount") or 0  # Fix: Handle None values
            item_revenue = qty * price * (1 - discount / 100)
            
            item_cost = 0
            # Only calculate cost/profit for products that have cost allocated
            if is_super_admin and product_id in product_costs:
                item_cost = qty * product_costs[product_id]
                showroom_data[showroom_id]["cost"] += item_cost
                total_cost += item_cost
            
            showroom_data[showroom_id]["total_m2"] += item_m2
            showroom_data[showroom_id]["products"][product_id]["quantity"] += qty
            showroom_data[showroom_id]["products"][product_id]["m2"] += item_m2
            showroom_data[showroom_id]["products"][product_id]["revenue"] += item_revenue
            showroom_data[showroom_id]["products"][product_id]["revenue_ex_vat"] += item_revenue
            showroom_data[showroom_id]["products"][product_id]["cost"] += item_cost
            showroom_data[showroom_id]["products"][product_id]["name"] = item.get("product_name", "Unknown")
            showroom_data[showroom_id]["products"][product_id]["product_id"] = product_id
            showroom_data[showroom_id]["products"][product_id]["has_cost"] = product_id in product_costs
        
        # Daily trends - attribute deposits to their payment dates
        deposits = invoice.get("deposits", [])
        invoice_date_raw = invoice.get("date", "")
        invoice_date = get_document_date_str(invoice_date_raw)  # Convert to YYYY-MM-DD
        vat = invoice.get("vat", 0)
        
        if deposits and len(deposits) > 0:
            # For invoices with deposits, count each deposit on its payment date
            for dep in deposits:
                dep_date_raw = dep.get("date", "")
                dep_date = get_document_date_str(dep_date_raw)
                dep_amount = float(dep.get("amount", 0))
                
                if dep_amount > 0 and dep_date and is_date_in_range(dep_date_raw, start, end):
                    daily_data[dep_date]["revenue"] += dep_amount
                    # Prorate subtotal based on deposit amount relative to gross total
                    if gross_total > 0:
                        dep_subtotal = subtotal * (dep_amount / gross_total)
                        daily_data[dep_date]["revenue_ex_vat"] += dep_subtotal
                    
            # Count invoice on its original date for the count
            if invoice_date:
                daily_data[invoice_date]["count"] += 1
                for item in invoice.get("line_items", []):
                    daily_data[invoice_date]["total_m2"] += item.get("m2", 0) or 0
                if is_super_admin:
                    for item in invoice.get("line_items", []):
                        pid = item.get("product_id", "")
                        qty = item.get("quantity") or 0  # Fix: Handle None
                        if pid in product_costs:
                            daily_data[invoice_date]["cost"] += qty * product_costs[pid]
        else:
            # No deposits - count full amount on invoice date
            if invoice_date:
                daily_data[invoice_date]["revenue"] += actual_paid
                daily_data[invoice_date]["revenue_ex_vat"] += actual_subtotal
                daily_data[invoice_date]["count"] += 1
                for item in invoice.get("line_items", []):
                    daily_data[invoice_date]["total_m2"] += item.get("m2", 0) or 0
                if is_super_admin:
                    for item in invoice.get("line_items", []):
                        pid = item.get("product_id", "")
                        qty = item.get("quantity") or 0  # Fix: Handle None
                        if pid in product_costs:
                            daily_data[invoice_date]["cost"] += qty * product_costs[pid]
    
    # Process Cash Quotations (no VAT, counts towards sales)
    total_cash_quotation_revenue = 0
    total_cash_quotation_count = len(cash_quotations)
    
    for cq in cash_quotations:
        showroom_id = cq.get("showroom_id", "unassigned")
        showroom_name = cq.get("showroom_name") or showroom_map.get(showroom_id, "Unassigned")
        
        # Cash quotation total (no VAT)
        cq_total = cq.get("total", cq.get("subtotal", 0))
        
        showroom_data[showroom_id]["cash_quotation_revenue"] += cq_total
        showroom_data[showroom_id]["cash_quotation_count"] += 1
        showroom_data[showroom_id]["name"] = showroom_name
        
        # Add to overall totals (cash quotations are revenue without VAT)
        showroom_data[showroom_id]["revenue"] += cq_total
        showroom_data[showroom_id]["revenue_ex_vat"] += cq_total  # Same as total since no VAT
        showroom_data[showroom_id]["count"] += 1
        
        total_revenue += cq_total
        total_revenue_ex_vat += cq_total
        total_cash_quotation_revenue += cq_total
        total_invoices += 1  # Count as transaction
        
        # Daily trends for cash quotations
        cq_date_raw = cq.get("date", "")
        cq_date = get_document_date_str(cq_date_raw)  # Convert to YYYY-MM-DD
        if cq_date:
            daily_data[cq_date]["revenue"] += cq_total
            daily_data[cq_date]["revenue_ex_vat"] += cq_total
            daily_data[cq_date]["cash_quotation_revenue"] += cq_total
            daily_data[cq_date]["cash_quotation_count"] += 1
            daily_data[cq_date]["count"] += 1
            for item in cq.get("line_items", []):
                daily_data[cq_date]["total_m2"] += item.get("m2", 0) or 0
    
    # Build response
    showroom_analytics = []
    for showroom_id, data in showroom_data.items():
        top_products = sorted(
            [{"product_id": pid, **pdata} for pid, pdata in data["products"].items()],
            key=lambda x: x["revenue"],
            reverse=True
        )[:5]
        
        if is_super_admin:
            for prod in top_products:
                # Only calculate profit/margin if product has cost allocated
                if prod.get("has_cost") and prod["cost"] > 0:
                    prod["profit"] = round(prod["revenue_ex_vat"] - prod["cost"], 2)
                    prod["margin"] = round((prod["profit"] / prod["revenue_ex_vat"] * 100), 1) if prod["revenue_ex_vat"] > 0 else 0
                else:
                    prod["profit"] = None
                    prod["margin"] = None
        
        avg_order = data["revenue"] / data["count"] if data["count"] > 0 else 0
        pct_of_total = (data["revenue"] / total_revenue * 100) if total_revenue > 0 else 0
        
        showroom_entry = {
            "showroom_id": showroom_id,
            "showroom_name": data["name"],
            "total_revenue": round(data["revenue"], 2),
            "total_revenue_ex_vat": round(data["revenue_ex_vat"], 2),
            "total_m2": round(data["total_m2"], 2),
            "invoice_count": data["count"],
            "cash_quotation_count": data.get("cash_quotation_count", 0),
            "cash_quotation_revenue": round(data.get("cash_quotation_revenue", 0), 2),
            "average_order_value": round(avg_order, 2),
            "top_products": top_products,
            "percentage_of_total": round(pct_of_total, 1)
        }
        
        if is_super_admin:
            showroom_entry["total_cost"] = round(data["cost"], 2)
            showroom_profit = data["revenue_ex_vat"] - data["cost"]
            showroom_entry["total_profit"] = round(showroom_profit, 2)
            showroom_entry["profit_margin"] = round((showroom_profit / data["revenue_ex_vat"] * 100), 1) if data["revenue_ex_vat"] > 0 else 0
        
        showroom_analytics.append(showroom_entry)
    
    showroom_analytics.sort(key=lambda x: x["total_revenue"], reverse=True)
    
    # Fetch refunds data BEFORE building daily trends - using document date, not created_at
    # EXCLUDE soft-deleted refunds
    refund_base_query = {"deleted_at": {"$exists": False}}
    if not is_super_admin and user_showroom_id:
        refund_base_query["showroom_id"] = user_showroom_id
    
    all_refunds = await db.refunds.find(refund_base_query, {"_id": 0}).to_list(100000)
    refunds = [r for r in all_refunds if is_date_in_range(r.get("date", ""), start, end)]
    
    total_refunds_count = len(refunds)
    total_refunds_gross = sum(r.get("gross_total", 0) for r in refunds)
    total_refunds_net = sum(r.get("net_refund", 0) for r in refunds)
    total_restocking_fees = sum(r.get("restocking_fee", 0) for r in refunds)
    
    # Refunds by showroom and by date
    refunds_by_showroom = {}
    for r in refunds:
        sid = r.get("showroom_id", "unassigned")
        if sid not in refunds_by_showroom:
            refunds_by_showroom[sid] = {"count": 0, "gross": 0, "net": 0, "fees": 0}
        refunds_by_showroom[sid]["count"] += 1
        refunds_by_showroom[sid]["gross"] += r.get("gross_total", 0)
        refunds_by_showroom[sid]["net"] += r.get("net_refund", 0)
        refunds_by_showroom[sid]["fees"] += r.get("restocking_fee", 0)
        
        # Add refunds to daily_data by date
        refund_date = get_document_date_str(r.get("date", ""))
        if refund_date:
            if refund_date not in daily_data:
                daily_data[refund_date] = {"revenue": 0, "revenue_ex_vat": 0, "cost": 0, "count": 0, "total_m2": 0, "cash_quotation_revenue": 0, "cash_quotation_count": 0, "refunds_count": 0, "refunds_net": 0}
            daily_data[refund_date]["refunds_count"] = daily_data[refund_date].get("refunds_count", 0) + 1
            daily_data[refund_date]["refunds_net"] = daily_data[refund_date].get("refunds_net", 0) + r.get("net_refund", 0)
    
    # Daily trends (now includes refund data)
    daily_trends = []
    for date in sorted(daily_data.keys()):
        refunds_net = daily_data[date].get("refunds_net", 0)
        refunds_count = daily_data[date].get("refunds_count", 0)
        trend_entry = {
            "date": date,
            "revenue": round(daily_data[date]["revenue"], 2),
            "revenue_ex_vat": round(daily_data[date]["revenue_ex_vat"], 2),
            "total_m2": round(daily_data[date]["total_m2"], 2),
            "invoices": daily_data[date]["count"],
            "cash_quotation_revenue": round(daily_data[date].get("cash_quotation_revenue", 0), 2),
            "cash_quotation_count": daily_data[date].get("cash_quotation_count", 0),
            "refunds_count": refunds_count,
            "refunds_net": round(refunds_net, 2),
            "net_revenue": round(daily_data[date]["revenue"] - refunds_net, 2)
        }
        if is_super_admin:
            trend_entry["cost"] = round(daily_data[date]["cost"], 2)
            daily_profit = daily_data[date]["revenue_ex_vat"] - daily_data[date]["cost"] - (refunds_net * 0.8333)
            trend_entry["profit"] = round(daily_profit, 2)
        daily_trends.append(trend_entry)
    
    total_m2 = sum(data["total_m2"] for data in showroom_data.values())
    total_vat = total_revenue - total_revenue_ex_vat
    avg_order_value = total_revenue / total_invoices if total_invoices > 0 else 0
    
    user_showroom_name = None
    if not is_super_admin and user_showroom_id:
        showroom = await db.showrooms.find_one({"id": user_showroom_id}, {"_id": 0, "name": 1})
        user_showroom_name = showroom.get("name") if showroom else None
    
    response = {
        "period": period,
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "total_revenue": round(total_revenue, 2),
        "total_revenue_ex_vat": round(total_revenue_ex_vat, 2),
        "total_vat": round(total_vat, 2),
        "total_m2": round(total_m2, 2),
        "total_invoices": total_invoices,
        "total_cash_quotations": total_cash_quotation_count,
        "total_cash_quotation_revenue": round(total_cash_quotation_revenue, 2),
        "average_order_value": round(avg_order_value, 2),
        "showroom_analytics": showroom_analytics,
        "daily_trends": daily_trends,
        "access_level": "all" if is_super_admin else "store",
        "user_showroom_id": user_showroom_id if not is_super_admin else None,
        "user_showroom_name": user_showroom_name
    }
    
    # Add refund data to each showroom in the analytics
    for entry in showroom_analytics:
        sid = entry["showroom_id"]
        if sid in refunds_by_showroom:
            entry["refunds_count"] = refunds_by_showroom[sid]["count"]
            entry["refunds_gross"] = round(refunds_by_showroom[sid]["gross"], 2)
            entry["refunds_net"] = round(refunds_by_showroom[sid]["net"], 2)
            entry["restocking_fees"] = round(refunds_by_showroom[sid]["fees"], 2)
            entry["net_revenue"] = round(entry["total_revenue"] - refunds_by_showroom[sid]["net"], 2)
        else:
            entry["refunds_count"] = 0
            entry["refunds_gross"] = 0
            entry["refunds_net"] = 0
            entry["restocking_fees"] = 0
            entry["net_revenue"] = entry["total_revenue"]
    
    # Add refund totals to response
    response["refunds"] = {
        "total_count": total_refunds_count,
        "total_gross": round(total_refunds_gross, 2),
        "total_net": round(total_refunds_net, 2),
        "total_restocking_fees": round(total_restocking_fees, 2)
    }
    response["net_revenue"] = round(total_revenue - total_refunds_net, 2)
    
    if is_super_admin:
        total_profit = total_revenue_ex_vat - total_cost - (total_refunds_net * 0.8333)  # Remove VAT from refunds
        response["total_cost"] = round(total_cost, 2)
        response["total_profit"] = round(total_profit, 2)
        response["average_margin"] = round((total_profit / total_revenue_ex_vat * 100), 1) if total_revenue_ex_vat > 0 else 0
        response["show_profit"] = True
        response["profit_note"] = "Profit calculated only for products with cost allocated. Refunds deducted from profit."
    else:
        response["show_profit"] = False
    
    # Cache the result
    set_cached_analytics(cache_key, response)
    
    return response


# ============ SALES TARGETS ============

@router.get("/sales-targets")
async def get_sales_targets(
    month: Optional[int] = None,
    year: Optional[int] = None,
    showroom_id: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    """Get sales targets"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    now = datetime.now(timezone.utc)
    target_month = month or now.month
    target_year = year or now.year
    
    query = {"month": target_month, "year": target_year}
    if showroom_id:
        query["showroom_id"] = showroom_id
    
    targets = await db.sales_targets.find(query, {"_id": 0}).to_list(10000)
    return targets


@router.get("/sales-targets/current")
async def get_current_sales_target(
    showroom_id: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    """Get current month's sales target with progress"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    now = datetime.now(timezone.utc)
    
    query = {"month": now.month, "year": now.year}
    if showroom_id:
        query["showroom_id"] = showroom_id
    else:
        query["showroom_id"] = None
    
    target = await db.sales_targets.find_one(query, {"_id": 0})
    
    # Calculate actual sales using document date
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    # Week runs Sunday to Saturday: (weekday + 1) % 7 gives days since Sunday
    days_since_sunday = (now.weekday() + 1) % 7
    week_start = now - timedelta(days=days_since_sunday)
    week_start = week_start.replace(hour=0, minute=0, second=0, microsecond=0)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    
    invoice_filter = {"deleted_at": {"$exists": False}}  # EXCLUDE soft-deleted invoices
    if showroom_id:
        invoice_filter["showroom_id"] = showroom_id
    
    all_invoices = await db.invoices.find(invoice_filter, {"_id": 0, "subtotal": 1, "date": 1}).to_list(100000)
    
    # Filter by document date for each period
    monthly_invoices = [inv for inv in all_invoices if is_date_in_range(inv.get("date", ""), month_start, now)]
    weekly_invoices = [inv for inv in all_invoices if is_date_in_range(inv.get("date", ""), week_start, now)]
    today_invoices = [inv for inv in all_invoices if is_date_in_range(inv.get("date", ""), today_start, now)]
    
    monthly_sales = sum(inv.get("subtotal", 0) or 0 for inv in monthly_invoices)
    weekly_sales = sum(inv.get("subtotal", 0) or 0 for inv in weekly_invoices)
    daily_sales = sum(inv.get("subtotal", 0) or 0 for inv in today_invoices)
    
    days_in_month = calendar.monthrange(now.year, now.month)[1]
    day_of_month = now.day
    days_remaining = days_in_month - day_of_month
    
    if target:
        monthly_target = target.get("monthly_target", 0)
        daily_target = target.get("daily_target", 0)
        weekly_target = target.get("weekly_target", 0)
    else:
        monthly_target = daily_target = weekly_target = 0
    
    return {
        "month": now.month,
        "year": now.year,
        "month_name": now.strftime("%B"),
        "days_in_month": days_in_month,
        "day_of_month": day_of_month,
        "days_remaining": days_remaining,
        "target": {"monthly": monthly_target, "weekly": weekly_target, "daily": daily_target},
        "actual": {"monthly": round(monthly_sales, 2), "weekly": round(weekly_sales, 2), "daily": round(daily_sales, 2)},
        "progress": {
            "monthly": round((monthly_sales / monthly_target * 100), 1) if monthly_target > 0 else 0,
            "weekly": round((weekly_sales / weekly_target * 100), 1) if weekly_target > 0 else 0,
            "daily": round((daily_sales / daily_target * 100), 1) if daily_target > 0 else 0
        },
        "remaining": {
            "monthly": round(max(monthly_target - monthly_sales, 0), 2),
            "weekly": round(max(weekly_target - weekly_sales, 0), 2),
            "daily": round(max(daily_target - daily_sales, 0), 2)
        },
        "has_target": target is not None
    }


@router.get("/analytics/showrooms-breakdown")
async def get_showroom_sales_breakdown(
    current_user: dict = Depends(get_current_user)
):
    """Get daily/weekly/monthly sales breakdown per showroom for Super Admin dashboard.
    Returns actual revenue figures for each period per showroom."""
    
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super Admin access required")
    
    db = get_db()
    now = datetime.now(timezone.utc)
    
    # Check cache
    cache_key = "showrooms_breakdown"
    cached = get_cached_analytics(cache_key)
    if cached:
        logging.info(f"[Analytics] Returning cached showrooms breakdown")
        return cached
    
    # Date ranges
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    days_since_sunday = (now.weekday() + 1) % 7
    week_start = (now - timedelta(days=days_since_sunday)).replace(hour=0, minute=0, second=0, microsecond=0)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    
    # Get all showrooms
    showrooms = await db.showrooms.find({}, {"_id": 0}).to_list(100)
    showroom_list = [{"id": s["id"], "name": s["name"]} for s in showrooms if s.get("id")]
    
    # Get all invoices (we'll filter by date in Python)
    invoice_query = {"deleted_at": {"$exists": False}}
    all_invoices = await db.invoices.find(invoice_query, {
        "_id": 0, "id": 1, "date": 1, "showroom_id": 1, "showroom_name": 1,
        "gross_total": 1, "amount_outstanding": 1, "deposits": 1, "credit_redeemed": 1
    }).to_list(100000)
    
    # Initialize showroom data
    showroom_data = {}
    for s in showroom_list:
        showroom_data[s["id"]] = {
            "showroom_id": s["id"],
            "showroom_name": s["name"],
            "today": {"revenue": 0, "invoices": 0},
            "week": {"revenue": 0, "invoices": 0},
            "month": {"revenue": 0, "invoices": 0}
        }
    
    # Track which invoices we've counted per period per showroom
    invoices_counted = {
        "today": {s["id"]: set() for s in showroom_list},
        "week": {s["id"]: set() for s in showroom_list},
        "month": {s["id"]: set() for s in showroom_list}
    }
    
    # Process invoices - SAME LOGIC AS SALES SUMMARY AND INVOICE HISTORY
    # Use is_date_in_range with string dates for consistency
    for inv in all_invoices:
        showroom_id = inv.get("showroom_id")
        if not showroom_id or showroom_id not in showroom_data:
            continue
        
        invoice_id = inv.get("id", "")
        invoice_date_str = inv.get("date", "")
        gross_total = inv.get("gross_total", 0) or 0
        deposits = inv.get("deposits", [])
        
        if deposits and len(deposits) > 0:
            # For invoices with deposits, attribute each deposit to its payment date
            for dep in deposits:
                dep_date_str = dep.get("date", "")
                dep_amount = float(dep.get("amount", 0) or 0)
                
                if dep_date_str and dep_amount > 0:
                    # Check each period using string date comparison (same as sales summary)
                    if is_date_in_range(dep_date_str, month_start, now):
                        showroom_data[showroom_id]["month"]["revenue"] += dep_amount
                        if invoice_id not in invoices_counted["month"][showroom_id]:
                            showroom_data[showroom_id]["month"]["invoices"] += 1
                            invoices_counted["month"][showroom_id].add(invoice_id)
                    
                    if is_date_in_range(dep_date_str, week_start, now):
                        showroom_data[showroom_id]["week"]["revenue"] += dep_amount
                        if invoice_id not in invoices_counted["week"][showroom_id]:
                            showroom_data[showroom_id]["week"]["invoices"] += 1
                            invoices_counted["week"][showroom_id].add(invoice_id)
                    
                    if is_date_in_range(dep_date_str, today_start, now):
                        showroom_data[showroom_id]["today"]["revenue"] += dep_amount
                        if invoice_id not in invoices_counted["today"][showroom_id]:
                            showroom_data[showroom_id]["today"]["invoices"] += 1
                            invoices_counted["today"][showroom_id].add(invoice_id)
        else:
            # No deposits - use invoice date and actual paid amount
            if not invoice_date_str:
                continue
            
            # Calculate actual money received = gross_total - outstanding - trade credit.
            # Trade credit is a ledger movement, not till/bank money — Invoice History
            # excludes it the same way, keeping the drift badge green.
            amount_outstanding = inv.get("amount_outstanding", 0) or 0
            amount_outstanding = round(amount_outstanding * 100) / 100
            credit_redeemed = float(inv.get("credit_redeemed", 0) or 0)
            actual_paid = round((gross_total - amount_outstanding - credit_redeemed) * 100) / 100
            actual_paid = max(0, actual_paid)
            
            if is_date_in_range(invoice_date_str, month_start, now):
                showroom_data[showroom_id]["month"]["revenue"] += actual_paid
                showroom_data[showroom_id]["month"]["invoices"] += 1
            
            if is_date_in_range(invoice_date_str, week_start, now):
                showroom_data[showroom_id]["week"]["revenue"] += actual_paid
                showroom_data[showroom_id]["week"]["invoices"] += 1
            
            if is_date_in_range(invoice_date_str, today_start, now):
                showroom_data[showroom_id]["today"]["revenue"] += actual_paid
                showroom_data[showroom_id]["today"]["invoices"] += 1
    
    # Get refunds and subtract from revenue per showroom (same as Invoice History)
    all_refunds = await db.refunds.find({"deleted_at": {"$exists": False}}, {
        "_id": 0, "date": 1, "showroom_id": 1, "net_refund": 1, "gross_total": 1
    }).to_list(100000)
    
    # Calculate refunds per showroom per period
    for refund in all_refunds:
        refund_showroom = refund.get("showroom_id")
        if not refund_showroom or refund_showroom not in showroom_data:
            continue
        
        refund_date_str = refund.get("date", "")
        refund_amount = refund.get("net_refund") or refund.get("gross_total", 0) or 0
        
        if refund_date_str and refund_amount > 0:
            if is_date_in_range(refund_date_str, today_start, now):
                showroom_data[refund_showroom]["today"]["revenue"] -= refund_amount
            if is_date_in_range(refund_date_str, week_start, now):
                showroom_data[refund_showroom]["week"]["revenue"] -= refund_amount
            if is_date_in_range(refund_date_str, month_start, now):
                showroom_data[refund_showroom]["month"]["revenue"] -= refund_amount
    
    # Get targets for each showroom
    targets_query = {"month": now.month, "year": now.year}
    all_targets = await db.sales_targets.find(targets_query, {"_id": 0}).to_list(1000)
    
    # Add targets to showroom data
    for sid, data in showroom_data.items():
        store_targets = [t for t in all_targets if t.get("showroom_id") == sid]
        sales_target = next((t for t in store_targets if t.get("target_type") == "sales"), None)
        bonus_target = next((t for t in store_targets if t.get("target_type") == "bonus"), None)
        
        data["targets"] = {
            "sales": {
                "monthly": sales_target.get("monthly_target", 0) if sales_target else 0,
                "weekly": sales_target.get("weekly_target", 0) if sales_target else 0,
                "daily": sales_target.get("daily_target", 0) if sales_target else 0
            },
            "bonus": {
                "monthly": bonus_target.get("monthly_target", 0) if bonus_target else 0,
                "weekly": bonus_target.get("weekly_target", 0) if bonus_target else 0,
                "daily": bonus_target.get("daily_target", 0) if bonus_target else 0
            }
        }
        
        # Round revenue (now net of refunds)
        data["today"]["revenue"] = round(data["today"]["revenue"], 2)
        data["week"]["revenue"] = round(data["week"]["revenue"], 2)
        data["month"]["revenue"] = round(data["month"]["revenue"], 2)
    
    result = {
        "date": now.isoformat(),
        "period_info": {
            "today": today_start.strftime("%d/%m/%Y"),
            "week_start": week_start.strftime("%d/%m/%Y"),
            "month_start": month_start.strftime("%d/%m/%Y"),
            "month_name": now.strftime("%B %Y")
        },
        "showrooms": list(showroom_data.values())
    }
    
    # Cache result
    set_cached_analytics(cache_key, result)
    
    return result


@router.post("/sales-targets")
async def create_or_update_sales_target(
    input: SalesTargetCreate,
    current_user: dict = Depends(get_current_user)
):
    """Create or update a sales target (Super Admin only)"""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Only Super Admin can set sales targets")
    
    db = get_db()
    target_type = input.target_type or "sales"
    
    days_in_month = calendar.monthrange(input.year, input.month)[1]
    daily_target = round(input.monthly_target / days_in_month, 2)
    weekly_target = round(input.monthly_target / 4, 2)
    
    showroom = await db.showrooms.find_one({"id": input.showroom_id}, {"_id": 0, "name": 1})
    showroom_name = showroom.get("name") if showroom else "All Stores"
    month_name = calendar.month_name[input.month]
    
    # Migrate legacy records (without target_type) to "sales" type
    if target_type == "sales":
        await db.sales_targets.update_many(
            {"month": input.month, "year": input.year, "showroom_id": input.showroom_id, "target_type": {"$exists": False}},
            {"$set": {"target_type": "sales"}}
        )
    
    # Query including target_type
    query = {"month": input.month, "year": input.year, "showroom_id": input.showroom_id, "target_type": target_type}
    existing = await db.sales_targets.find_one(query)
    
    if existing:
        old_target = existing.get("monthly_target")
        await db.sales_targets.update_one(
            {"_id": existing["_id"]},
            {"$set": {
                "monthly_target": input.monthly_target,
                "daily_target": daily_target,
                "weekly_target": weekly_target,
                "target_type": target_type,
                "updated_at": datetime.now(timezone.utc).isoformat()
            }}
        )
        target = await db.sales_targets.find_one({"_id": existing["_id"]}, {"_id": 0})
        
        await log_audit(
            action="UPDATE",
            entity_type="sales_target",
            user=current_user,
            entity_id=existing.get("id"),
            entity_name=f"{target_type.capitalize()} Target - {showroom_name} - {month_name} {input.year}",
            before_data={"monthly_target": old_target},
            after_data={"monthly_target": input.monthly_target},
            details=f"Updated {target_type} target for {showroom_name}"
        )
    else:
        target_dict = {
            "id": str(uuid.uuid4()),
            "showroom_id": input.showroom_id,
            "month": input.month,
            "year": input.year,
            "monthly_target": input.monthly_target,
            "daily_target": daily_target,
            "weekly_target": weekly_target,
            "target_type": target_type,
            "created_by": current_user.get("email"),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat()
        }
        await db.sales_targets.insert_one(target_dict)
        target = {k: v for k, v in target_dict.items() if k != "_id"}
        
        await log_audit(
            action="CREATE",
            entity_type="sales_target",
            user=current_user,
            entity_id=target_dict["id"],
            entity_name=f"{target_type.capitalize()} Target - {showroom_name} - {month_name} {input.year}",
            after_data={"monthly_target": input.monthly_target},
            details=f"Created {target_type} target for {showroom_name}"
        )
    
    return target


@router.get("/sales-targets/all-types")
async def get_all_target_types(
    showroom_id: Optional[str] = None,
    month: Optional[int] = None,
    year: Optional[int] = None,
    current_user: dict = Depends(get_current_user)
):
    """Get all target types (sales, bonus, company) for a specific month.
    Defaults to current month if not specified. Falls back to overall targets if showroom-specific ones don't exist."""
    db = get_db()
    now = datetime.now(timezone.utc)
    
    # Use provided month/year or default to current
    target_month = month if month else now.month
    target_year = year if year else now.year
    
    # Clean up showroom_id - treat empty string as None
    clean_showroom_id = showroom_id if showroom_id and showroom_id.strip() else None
    
    logging.info(f"[Targets] Fetching targets - showroom: {clean_showroom_id or 'OVERALL'}, month: {target_month}/{target_year}")
    
    # Organize by type
    result = {
        "sales": None,
        "bonus": None,
        "company": None,
        "month": target_month,
        "year": target_year,
        "showroom_id": clean_showroom_id,
        "is_showroom_specific": False
    }
    
    # First, try to get showroom-specific targets if showroom_id is provided
    if clean_showroom_id:
        query = {"month": target_month, "year": target_year, "showroom_id": clean_showroom_id}
        logging.info(f"[Targets] Query for showroom-specific: {query}")
        targets = await db.sales_targets.find(query, {"_id": 0}).to_list(10)
        logging.info(f"[Targets] Found {len(targets)} showroom-specific targets")
        
        if targets:
            result["is_showroom_specific"] = True
            for target in targets:
                target_type = target.get("target_type") or "sales"
                result[target_type] = {
                    "monthly": target.get("monthly_target", 0),
                    "weekly": target.get("weekly_target", 0),
                    "daily": target.get("daily_target", 0)
                }
            logging.info(f"[Targets] Returning showroom-specific targets: {result}")
            return result
    
    # Fallback: Get overall targets (showroom_id is None)
    query = {"month": target_month, "year": target_year, "showroom_id": None}
    logging.info(f"[Targets] Query for overall (fallback): {query}")
    targets = await db.sales_targets.find(query, {"_id": 0}).to_list(10)
    logging.info(f"[Targets] Found {len(targets)} overall targets")
    
    for target in targets:
        target_type = target.get("target_type") or "sales"
        result[target_type] = {
            "monthly": target.get("monthly_target", 0),
            "weekly": target.get("weekly_target", 0),
            "daily": target.get("daily_target", 0)
        }
    
    logging.info(f"[Targets] Returning overall targets: {result}")
    return result


@router.get("/sales-targets/all-showrooms")
async def get_all_showroom_targets(
    month: Optional[int] = None,
    year: Optional[int] = None,
    current_user: dict = Depends(get_current_user)
):
    """Get sales targets for ALL showrooms for a specific month.
    Returns a list of targets organized by showroom."""
    db = get_db()
    now = datetime.now(timezone.utc)
    
    # Use provided month/year or default to current
    target_month = month if month else now.month
    target_year = year if year else now.year
    
    logging.info(f"[Targets] Fetching ALL showroom targets for month: {target_month}/{target_year}")
    
    # Get all showrooms first
    showrooms = await db.showrooms.find({}, {"_id": 0}).to_list(100)
    showroom_map = {s["id"]: s["name"] for s in showrooms if s.get("id")}
    
    # Get all targets for this month (both showroom-specific and overall)
    query = {"month": target_month, "year": target_year}
    all_targets = await db.sales_targets.find(query, {"_id": 0}).to_list(1000)
    
    # Organize by showroom
    result = {
        "month": target_month,
        "year": target_year,
        "overall": {"sales": None, "bonus": None, "company": None},
        "showrooms": []
    }
    
    # Process overall targets (showroom_id is None)
    for target in all_targets:
        if target.get("showroom_id") is None:
            target_type = target.get("target_type") or "sales"
            result["overall"][target_type] = {
                "monthly": target.get("monthly_target", 0),
                "weekly": target.get("weekly_target", 0),
                "daily": target.get("daily_target", 0)
            }
    
    # Process showroom-specific targets
    showroom_targets = {}
    for target in all_targets:
        showroom_id = target.get("showroom_id")
        if showroom_id:
            if showroom_id not in showroom_targets:
                showroom_targets[showroom_id] = {
                    "showroom_id": showroom_id,
                    "showroom_name": showroom_map.get(showroom_id, "Unknown"),
                    "sales": None,
                    "bonus": None
                }
            target_type = target.get("target_type") or "sales"
            showroom_targets[showroom_id][target_type] = {
                "monthly": target.get("monthly_target", 0),
                "weekly": target.get("weekly_target", 0),
                "daily": target.get("daily_target", 0)
            }
    
    result["showrooms"] = list(showroom_targets.values())
    
    logging.info(f"[Targets] Returning targets for {len(result['showrooms'])} showrooms + overall")
    return result


@router.delete("/sales-targets/{target_id}")
async def delete_sales_target(target_id: str, current_user: dict = Depends(get_current_user)):
    """Delete a sales target (Super Admin only)"""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Only Super Admin can delete sales targets")
    
    db = get_db()
    target = await db.sales_targets.find_one({"id": target_id}, {"_id": 0})
    
    if not target:
        raise HTTPException(status_code=404, detail="Sales target not found")
    
    await db.sales_targets.delete_one({"id": target_id})
    
    showroom = await db.showrooms.find_one({"id": target.get("showroom_id")}, {"_id": 0, "name": 1})
    showroom_name = showroom.get("name") if showroom else "Unknown"
    month_name = calendar.month_name[target.get("month", 1)]
    
    await log_audit(
        action="DELETE",
        entity_type="sales_target",
        user=current_user,
        entity_id=target_id,
        entity_name=f"{showroom_name} - {month_name} {target.get('year')}",
        before_data={"monthly_target": target.get("monthly_target")},
        details=f"Deleted sales target for {showroom_name}"
    )
    
    return {"message": "Sales target deleted"}


@router.get("/sales-targets/report")
async def generate_targets_report(
    month: int,
    year: int,
    showroom_id: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    """Generate a targets vs actuals report for a specific month."""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Only Super Admin can generate reports")
    
    db = get_db()
    
    # Get showroom info
    showrooms = await db.showrooms.find({}, {"_id": 0}).to_list(100)
    showroom_map = {s["id"]: s["name"] for s in showrooms if s.get("id")}
    
    # Get all targets for the month
    target_query = {"month": month, "year": year}
    if showroom_id:
        target_query["showroom_id"] = showroom_id
    
    all_targets = await db.sales_targets.find(target_query, {"_id": 0}).to_list(1000)
    
    # Calculate date range for the month
    days_in_month = calendar.monthrange(year, month)[1]
    month_start = datetime(year, month, 1, 0, 0, 0, tzinfo=timezone.utc)
    month_end = datetime(year, month, days_in_month, 23, 59, 59, tzinfo=timezone.utc)
    
    # Get all invoices for the month - EXCLUDE soft-deleted invoices
    invoices = await db.invoices.find({"deleted_at": {"$exists": False}}, {"_id": 0, "subtotal": 1, "date": 1, "showroom_id": 1}).to_list(100000)
    
    # Filter invoices by date (DD/MM/YYYY format)
    month_invoices = []
    for inv in invoices:
        inv_date = parse_document_date(inv.get("date", ""))
        if inv_date and month_start <= inv_date <= month_end:
            month_invoices.append(inv)
    
    # Calculate actuals per showroom
    showroom_actuals = defaultdict(float)
    overall_actual = 0
    for inv in month_invoices:
        amount = inv.get("subtotal", 0) or 0
        sid = inv.get("showroom_id")
        if sid:
            showroom_actuals[sid] += amount
        overall_actual += amount
    
    # Build report data
    report_data = []
    
    # Group targets by showroom
    targets_by_showroom = defaultdict(dict)
    for t in all_targets:
        sid = t.get("showroom_id")
        t_type = t.get("target_type", "sales")
        targets_by_showroom[sid][t_type] = t.get("monthly_target", 0)
    
    # Add overall if exists
    if None in targets_by_showroom or not showroom_id:
        overall_targets = targets_by_showroom.get(None, {})
        report_data.append({
            "showroom": "Overall (All Stores)",
            "showroom_id": None,
            "sales_target": overall_targets.get("sales", 0),
            "bonus_target": overall_targets.get("bonus", 0),
            "company_target": overall_targets.get("company", 0),
            "actual_revenue": round(overall_actual, 2),
            "sales_achievement": round((overall_actual / overall_targets.get("sales", 1)) * 100, 1) if overall_targets.get("sales") else 0,
            "bonus_achievement": round((overall_actual / overall_targets.get("bonus", 1)) * 100, 1) if overall_targets.get("bonus") else 0
        })
    
    # Add each showroom
    for sid, name in showroom_map.items():
        if showroom_id and sid != showroom_id:
            continue
        targets = targets_by_showroom.get(sid, {})
        actual = showroom_actuals.get(sid, 0)
        report_data.append({
            "showroom": name,
            "showroom_id": sid,
            "sales_target": targets.get("sales", 0),
            "bonus_target": targets.get("bonus", 0),
            "company_target": targets.get("company", 0),
            "actual_revenue": round(actual, 2),
            "sales_achievement": round((actual / targets.get("sales", 1)) * 100, 1) if targets.get("sales") else 0,
            "bonus_achievement": round((actual / targets.get("bonus", 1)) * 100, 1) if targets.get("bonus") else 0
        })
    
    return {
        "month": month,
        "year": year,
        "month_name": calendar.month_name[month],
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "data": report_data
    }


@router.get("/sales-targets/history")
async def get_targets_history(
    showroom_id: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    """Get list of months that have targets set."""
    db = get_db()
    
    query = {}
    if showroom_id:
        query["showroom_id"] = showroom_id
    
    # Get all unique month/year combinations
    targets = await db.sales_targets.find(query, {"_id": 0, "month": 1, "year": 1}).to_list(10000)
    
    # Get unique months
    months_set = set()
    for t in targets:
        months_set.add((t.get("year"), t.get("month")))
    
    # Sort by year desc, month desc
    sorted_months = sorted(months_set, reverse=True)
    
    result = []
    for year, month in sorted_months:
        result.append({
            "month": month,
            "year": year,
            "month_name": calendar.month_name[month],
            "label": f"{calendar.month_name[month]} {year}"
        })
    
    return result


@router.get("/staff/sales-summary")
async def get_staff_sales_summary(
    showroom_id: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    """Get comprehensive sales summary for staff dashboard - daily, weekly, monthly with targets
    
    VERSION 4.0.0 - Revenue calculation now matches InvoiceHistory.js exactly:
    - Uses invoice date (not deposit date) for period filtering
    - Calculates actual_paid as gross_total - amount_outstanding
    - Falls back to deposit sum if amount_outstanding is missing
    """
    logging.info("[Sales Summary API] VERSION 4.0.0 - Using unified revenue calculation")
    
    if not can_access_dashboard(current_user):
        raise HTTPException(status_code=403, detail="Access required")
    
    db = get_db()
    now = datetime.now(timezone.utc)
    
    # Get user's store or all stores for admin
    user_showroom_id = current_user.get("showroom_id")
    is_super_admin = current_user.get("role") == "super_admin"
    is_admin = current_user.get("role") in ["super_admin", "admin", "manager"]
    
    # Build showroom filter
    showroom_filter = {}
    # Super admin can filter by any showroom via query param
    if is_super_admin and showroom_id:
        showroom_filter["showroom_id"] = showroom_id
    elif not is_super_admin and user_showroom_id:
        showroom_filter["showroom_id"] = user_showroom_id
    
    # Check cache
    cache_key = f"sales_summary:{showroom_id or user_showroom_id or 'all'}"
    cached = get_cached_analytics(cache_key)
    if cached:
        logging.info(f"[Sales Summary] Returning cached data for {cache_key}")
        return cached
    
    # Date ranges
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    # Week runs Sunday to Saturday: (weekday + 1) % 7 gives days since Sunday
    days_since_sunday = (now.weekday() + 1) % 7
    week_start = now - timedelta(days=days_since_sunday)
    week_start = week_start.replace(hour=0, minute=0, second=0, microsecond=0)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    
    # Calculate days in current month for daily target
    days_in_month = calendar.monthrange(now.year, now.month)[1]
    days_passed = now.day
    
    # Get all invoices once for efficiency - EXCLUDE soft-deleted invoices
    invoice_filter = {**showroom_filter, "deleted_at": {"$exists": False}}
    all_invoices = await db.invoices.find(invoice_filter, {"_id": 0, "id": 1, "invoice_no": 1, "date": 1, "gross_total": 1, "amount_outstanding": 1, "deposits": 1, "line_items": 1, "payment_method": 1, "payment_methods": 1}).to_list(100000)
    
    # Get invoices for different periods - count deposits by their payment dates
    # Revenue = actual money received (gross_total - amount_outstanding), NOT total invoice value
    # IMPORTANT: Deposits are attributed to their payment dates, not the invoice date
    async def get_sales_for_period(start_date, end_date=None):
        """Get sales for invoices - attributes deposit payments to their payment dates, not invoice date"""
        end = end_date or now
        
        revenue = 0
        invoice_count = 0
        items_sold = 0
        by_payment_method = defaultdict(float)
        invoices_counted = set()  # Track which invoices we've counted for the count metric
        
        for inv in all_invoices:
            invoice_date = inv.get("date", "")
            invoice_id = inv.get("id", inv.get("invoice_no", ""))
            
            gross_total = inv.get("gross_total", 0)
            deposits = inv.get("deposits", [])
            
            if deposits and len(deposits) > 0:
                # For invoices with deposits, count each deposit on its payment date
                for dep in deposits:
                    dep_date = dep.get("date", "")
                    dep_amount = float(dep.get("amount", 0))
                    
                    if dep_amount > 0 and is_date_in_range(dep_date, start_date, end):
                        revenue += dep_amount
                        
                        # Track payment method for this deposit
                        dep_method = dep.get("method") or dep.get("note") or inv.get("payment_method") or "Unknown"
                        by_payment_method[dep_method] += dep_amount
                        
                        # Count invoice and items only once per invoice
                        if invoice_id not in invoices_counted:
                            invoice_count += 1
                            items_sold += sum((item.get("quantity") or 0) for item in inv.get("line_items", []))
                            invoices_counted.add(invoice_id)
            else:
                # No deposits - count full amount on invoice date (original behavior)
                if is_date_in_range(invoice_date, start_date, end):
                    # Calculate actual paid amount
                    if "amount_outstanding" in inv and inv["amount_outstanding"] is not None:
                        amount_outstanding = inv.get("amount_outstanding", 0) or 0
                    else:
                        amount_outstanding = 0
                    
                    amount_outstanding = round(amount_outstanding * 100) / 100
                    actual_paid = round((gross_total - amount_outstanding) * 100) / 100
                    
                    revenue += actual_paid
                    invoice_count += 1
                    items_sold += sum((item.get("quantity") or 0) for item in inv.get("line_items", []))
                    
                    # Track payment method
                    payment_methods = inv.get("payment_methods", [])
                    if payment_methods and len(payment_methods) > 0:
                        for pm in payment_methods:
                            pm_method = pm.get("method", "Unknown")
                            pm_amount = float(pm.get("amount", 0))
                            if pm_amount > 0:
                                by_payment_method[pm_method] += pm_amount
                            elif pm_method:
                                by_payment_method[pm_method] += actual_paid
                    else:
                        method = inv.get("payment_method", "Unknown") or "Unknown"
                        by_payment_method[method] += actual_paid
        
        # Convert payment method breakdown to list sorted by amount
        payment_breakdown = [{"method": k, "amount": round(v, 2)} for k, v in by_payment_method.items()]
        payment_breakdown.sort(key=lambda x: x["amount"], reverse=True)
        
        return {
            "revenue": round(revenue, 2), 
            "invoices": invoice_count, 
            "items_sold": items_sold,
            "by_payment_method": payment_breakdown
        }
    
    # Get refunds for different periods
    async def get_refunds_for_period(start_date, end_date=None):
        """Get refunds filtered by document date (DD/MM/YYYY), not created_at"""
        # EXCLUDE soft-deleted refunds
        refund_query = {**showroom_filter, "deleted_at": {"$exists": False}}
        all_refunds = await db.refunds.find(refund_query, {"_id": 0, "date": 1, "net_refund": 1, "gross_total": 1}).to_list(100000)
        
        # Filter by document date
        end = end_date or now
        refunds = [r for r in all_refunds if is_date_in_range(r.get("date", ""), start_date, end)]
        
        total_refunded = sum(r.get("net_refund", r.get("gross_total", 0)) for r in refunds)
        
        logging.info(f"[Refunds] Period: {start_date.strftime('%Y-%m-%d')} to {end.strftime('%Y-%m-%d')}, Count: {len(refunds)}, Total: {total_refunded}")
        
        return {"refunded": round(total_refunded, 2), "count": len(refunds)}
    
    today_sales = await get_sales_for_period(today_start)
    week_sales = await get_sales_for_period(week_start)
    month_sales = await get_sales_for_period(month_start)
    
    # Get refunds for same periods
    today_refunds = await get_refunds_for_period(today_start)
    week_refunds = await get_refunds_for_period(week_start)
    month_refunds = await get_refunds_for_period(month_start)
    
    # Calculate net revenue (after refunds)
    today_net = round(today_sales["revenue"] - today_refunds["refunded"], 2)
    week_net = round(week_sales["revenue"] - week_refunds["refunded"], 2)
    month_net = round(month_sales["revenue"] - month_refunds["refunded"], 2)
    
    # Get targets - use filtered showroom_id for super admin, otherwise user's showroom
    # Priority: showroom_id param (for super admin filter) > user_showroom_id > None (company-wide)
    target_showroom_id = None
    if is_super_admin and showroom_id:
        target_showroom_id = showroom_id
    elif user_showroom_id:
        target_showroom_id = user_showroom_id
    
    # First try to get showroom-specific target
    target = None
    if target_showroom_id:
        target_query = {"month": now.month, "year": now.year, "showroom_id": target_showroom_id, "target_type": "sales"}
        target = await db.sales_targets.find_one(target_query, {"_id": 0})
    
    # Fallback to company-wide target if no showroom-specific target found
    if not target:
        target_query = {"month": now.month, "year": now.year, "showroom_id": None, "target_type": "sales"}
        target = await db.sales_targets.find_one(target_query, {"_id": 0})
    
    monthly_target = target.get("monthly_target", 0) if target else 0
    
    # Calculate derived targets
    daily_target = round(monthly_target / days_in_month, 2) if monthly_target > 0 else 0
    weekly_target = round(monthly_target / 4, 2) if monthly_target > 0 else 0
    
    # Calculate progress percentages using NET revenue (after refunds)
    today_progress = round((today_net / daily_target * 100), 1) if daily_target > 0 else 0
    week_progress = round((week_net / weekly_target * 100), 1) if weekly_target > 0 else 0
    month_progress = round((month_net / monthly_target * 100), 1) if monthly_target > 0 else 0
    
    # Expected progress for month (based on days passed)
    expected_month_progress = round((days_passed / days_in_month * 100), 1)
    
    # Get all invoices at once (for efficiency) - EXCLUDE soft-deleted invoices
    invoice_query = {**showroom_filter, "deleted_at": {"$exists": False}}
    all_invoices = await db.invoices.find(invoice_query, {"_id": 0, "date": 1, "gross_total": 1, "deposits": 1, "line_items": 1}).to_list(100000)
    
    # Get recent 7 days sales trend for chart (Sunday to Saturday week)
    # Find the start of the current week (Sunday)
    days_since_sunday = (now.weekday() + 1) % 7
    week_start_sunday = now - timedelta(days=days_since_sunday)
    week_start_sunday = week_start_sunday.replace(hour=0, minute=0, second=0, microsecond=0)
    
    daily_trend = []
    for i in range(7):
        day = week_start_sunday + timedelta(days=i)
        day_start = day.replace(hour=0, minute=0, second=0, microsecond=0)
        day_end = day_start + timedelta(days=1)
        
        # Only include days up to today
        if day_start > now:
            daily_trend.append({
                "day": day.strftime("%a"),
                "date": day.strftime("%d/%m"),
                "revenue": 0,
                "target": daily_target
            })
            continue
        
        # Calculate revenue for this day - attribute deposits to their payment dates
        day_revenue = 0
        for inv in all_invoices:
            invoice_date = inv.get("date", "")
            gross_total = inv.get("gross_total", 0)
            deposits = inv.get("deposits", [])
            
            if deposits and len(deposits) > 0:
                # For invoices with deposits, only count deposits that fall on this day
                for dep in deposits:
                    dep_date = dep.get("date", "")
                    dep_amount = float(dep.get("amount", 0))
                    if dep_amount > 0 and is_date_in_range(dep_date, day_start, day_end - timedelta(seconds=1)):
                        day_revenue += dep_amount
            else:
                # No deposits - count full amount if invoice date is on this day
                if is_date_in_range(invoice_date, day_start, day_end - timedelta(seconds=1)):
                    amount_outstanding = inv.get("amount_outstanding", 0) or 0
                    actual_paid = round((gross_total - amount_outstanding) * 100) / 100
                    day_revenue += actual_paid
        
        daily_trend.append({
            "day": day.strftime("%a"),
            "date": day.strftime("%d/%m"),
            "revenue": round(day_revenue, 2),
            "target": daily_target
        })
    
    # Get top selling products today (using document date)
    today_invoices = [inv for inv in all_invoices if is_date_in_range(inv.get("date", ""), today_start, now)]
    
    product_sales = defaultdict(lambda: {"quantity": 0, "revenue": 0, "name": ""})
    for invoice in today_invoices:
        for item in invoice.get("line_items", []):
            product_id = item.get("product_id", item.get("product_name", "unknown"))
            qty = item.get("quantity") or 0  # Fix: Handle None
            price = item.get("price") or 0  # Fix: Handle None
            discount = item.get("discount", 0)
            product_sales[product_id]["quantity"] += qty
            product_sales[product_id]["revenue"] += qty * price * (1 - discount / 100)
            product_sales[product_id]["name"] = item.get("product_name", "Unknown")
    
    top_products_today = sorted(
        [{"name": data["name"], "quantity": data["quantity"], "revenue": round(data["revenue"], 2)} 
         for data in product_sales.values()],
        key=lambda x: x["revenue"],
        reverse=True
    )[:5]
    
    # Get store info
    store_name = "All Stores"
    if user_showroom_id:
        showroom = await db.showrooms.find_one({"id": user_showroom_id}, {"_id": 0, "name": 1})
        store_name = showroom.get("name", "Your Store") if showroom else "Your Store"
    
    result = {
        "store_name": store_name,
        "today": {
            **today_sales,
            "refunds": today_refunds["refunded"],
            "refund_count": today_refunds["count"],
            "net_revenue": today_net,
            "target": daily_target,
            "progress": min(today_progress, 999),
            "on_track": today_net >= daily_target
        },
        "week": {
            **week_sales,
            "refunds": week_refunds["refunded"],
            "refund_count": week_refunds["count"],
            "net_revenue": week_net,
            "target": weekly_target,
            "progress": min(week_progress, 999),
            "on_track": week_net >= weekly_target
        },
        "month": {
            **month_sales,
            "refunds": month_refunds["refunded"],
            "refund_count": month_refunds["count"],
            "net_revenue": month_net,
            "target": monthly_target,
            "progress": min(month_progress, 999),
            "expected_progress": expected_month_progress,
            "days_passed": days_passed,
            "days_total": days_in_month,
            "on_track": month_progress >= expected_month_progress
        },
        "daily_trend": daily_trend,
        "top_products_today": top_products_today,
        "has_target": monthly_target > 0
    }
    
    # Cache the result
    set_cached_analytics(cache_key, result)
    
    return result



# ============ WEBSITE VISITOR ANALYTICS ============
# Tracks live visitors, page views, and provides historical analytics

import hashlib
import asyncio
import json
from fastapi import WebSocket, WebSocketDisconnect, Request

# Try to import user_agents, install if not available
try:
    from user_agents import parse as parse_user_agent
    HAS_USER_AGENTS = True
except ImportError:
    HAS_USER_AGENTS = False
    def parse_user_agent(ua_string):
        return None

# WebSocket connections for real-time updates
_active_ws_connections = []


class PageViewTrack(BaseModel):
    page_url: str
    page_title: Optional[str] = None
    referrer: Optional[str] = None
    session_id: Optional[str] = None


async def get_geo_location(ip: str) -> dict:
    """Get location from IP address using free IP-API service"""
    if ip in ['127.0.0.1', 'localhost', '::1'] or ip.startswith('192.168.') or ip.startswith('10.') or ip.startswith('100.'):
        return {"country": "Local", "city": "Local", "country_code": "LC"}
    
    try:
        import httpx
        async with httpx.AsyncClient(timeout=2.0) as client:
            response = await client.get(f"http://ip-api.com/json/{ip}?fields=country,city,countryCode")
            if response.status_code == 200:
                data = response.json()
                return {
                    "country": data.get("country", "Unknown"),
                    "city": data.get("city", "Unknown"),
                    "country_code": data.get("countryCode", "XX")
                }
    except Exception as e:
        logger.debug(f"Geo lookup failed for {ip}: {e}")
    
    return {"country": "Unknown", "city": "Unknown", "country_code": "XX"}


def _country_name_from_iso2(code: str) -> str:
    """Tiny lookup for the most common 2-letter country codes seen in
    UK e-commerce traffic. Falls back to the code itself for unknowns
    so the dashboard never shows a blank cell."""
    return _ISO2_TO_NAME.get((code or "").upper(), code or "Unknown")


_ISO2_TO_NAME = {
    "GB": "United Kingdom", "IE": "Ireland", "US": "United States",
    "CA": "Canada", "AU": "Australia", "NZ": "New Zealand",
    "FR": "France", "DE": "Germany", "ES": "Spain", "IT": "Italy",
    "PT": "Portugal", "NL": "Netherlands", "BE": "Belgium",
    "PL": "Poland", "RO": "Romania", "CZ": "Czechia", "SE": "Sweden",
    "NO": "Norway", "DK": "Denmark", "FI": "Finland",
    "IN": "India", "PK": "Pakistan", "BD": "Bangladesh",
    "AE": "UAE", "SA": "Saudi Arabia", "JP": "Japan", "CN": "China",
    "RU": "Russia", "BR": "Brazil", "MX": "Mexico", "ZA": "South Africa",
    "TR": "Turkey", "GR": "Greece", "CH": "Switzerland", "AT": "Austria",
}


def parse_device_info(user_agent_string: str) -> dict:
    """Parse user agent to get device info"""
    if HAS_USER_AGENTS and user_agent_string:
        try:
            ua = parse_user_agent(user_agent_string)
            base_is_bot = ua.is_bot or _looks_like_bot(user_agent_string)
            return {
                "device_type": "mobile" if ua.is_mobile else ("tablet" if ua.is_tablet else "desktop"),
                "browser": f"{ua.browser.family}",
                "os": f"{ua.os.family}",
                "is_bot": base_is_bot,
            }
        except:
            pass
    
    # Fallback parsing
    ua_lower = user_agent_string.lower() if user_agent_string else ""
    is_mobile = any(x in ua_lower for x in ['mobile', 'android', 'iphone', 'ipad'])
    is_bot = _looks_like_bot(user_agent_string)
    
    return {
        "device_type": "mobile" if is_mobile else "desktop",
        "browser": "Unknown",
        "os": "Unknown",
        "is_bot": is_bot
    }


# Comprehensive bot / scraper / AI-crawler signature list. The library
# `user_agents` only catches the "well-behaved" ones that ID themselves
# as bots. This catches the rest — Python requests, curl, headless
# Chromium, the new wave of LLM scrapers (GPTBot, ClaudeBot, etc.), and
# empty/missing user agents (which always indicate a script).
_BOT_UA_SIGNATURES = (
    # Generic crawler / spider keywords
    "bot", "crawler", "spider", "scraper", "fetch", "monitor",
    # HTTP client libraries used for scraping
    "python-requests", "python-urllib", "python/", "python ",
    "go-http-client", "okhttp", "httpx", "aiohttp",
    "node-fetch", "axios", "java/", "ruby", "perl",
    "curl/", "wget/", "lwp::simple", "libwww-perl",
    # Headless browsers / scraping tools
    "headlesschrome", "headless chrome", "phantomjs", "puppeteer",
    "playwright", "selenium", "scrapy", "beautifulsoup",
    # SEO / monitoring services
    "ahrefs", "semrush", "majestic", "moz.com", "seznam",
    "screaming frog", "uptimerobot", "pingdom", "newrelicpinger",
    "applebot", "duckduckbot", "yandexbot", "baiduspider",
    "facebookexternalhit", "linkedinbot", "twitterbot", "telegrambot",
    "whatsapp", "embedly", "slackbot",
    # Modern AI / LLM scrapers
    "gptbot", "chatgpt-user", "openai", "anthropic", "claude-web",
    "claudebot", "perplexitybot", "perplexity", "bytespider",
    "meta-externalagent", "meta-externalfetcher", "ccbot",
    "google-extended", "amazonbot", "youbot", "diffbot",
)


# Cloud-datacentre cities. ANY request originating from these locations
# is almost certainly a bot/scraper/uptime-monitor — Tile Station is a
# UK-only tile retailer; real customers do not visit from AWS us-east-1.
# Match is case-insensitive substring on the city name (so "Ashburn" hits
# both "Ashburn" and "Ashburn, VA"). When a request's CF-IPCountry +
# CF-IPCity (or IP-API city) lands in this list it's flagged as a bot.
_DATACENTRE_CITIES = frozenset({
    "ashburn",            # AWS us-east-1
    "council bluffs",     # Google Cloud us-central1
    "the dalles",         # Google Cloud us-west1
    "sterling",           # AWS us-east-1
    "boardman",           # AWS us-west-2
    "moncks corner",      # Google Cloud us-east1
    "umatilla",           # AWS us-west-2
    "dublin",             # AWS eu-west-1 (Ireland, but ~all real IE traffic is Dublin DCs)
    "frankfurt am main",  # AWS eu-central-1 / Azure
    "frankfurt",          # AWS eu-central-1 / Azure
    "st ghislain",        # Google Cloud europe-west1
    "saint-ghislain",     # Google Cloud europe-west1
    "saint ghislain",     # Google Cloud europe-west1
    "eemshaven",          # Google Cloud europe-west4
    "groningen",          # Google Cloud europe-west4 area
    "hamina",             # Google Cloud europe-north1
    "frémont",            # Various cloud
    "fremont",            # Linode / Various cloud
    "san jose",           # AWS / DigitalOcean
    "san francisco",      # Various cloud (esp. DigitalOcean / Linode)
    "seattle",            # Azure / AWS
    "santa clara",        # AWS / Google Cloud
    "redmond",            # Azure
    "boydton",            # Azure us-east-2
    "quincy",             # Azure us-west-2
    "des moines",         # Azure us-central
    "tokyo",              # AWS ap-northeast-1
    "singapore",          # AWS ap-southeast-1 (~all SG traffic = DCs)
    "mumbai",             # AWS ap-south-1
    "sydney",             # AWS ap-southeast-2
    "são paulo",          # AWS sa-east-1
    "sao paulo",          # AWS sa-east-1
    "cape town",          # AWS af-south-1
    "manama",             # AWS me-south-1 (Bahrain)
    "hong kong",          # AWS ap-east-1
    "kuala lumpur",       # Various cloud
    "stockholm",          # AWS eu-north-1
    "milan",              # AWS eu-south-1
    "paris",              # AWS eu-west-3 (heavy bot signal even for FR)
    "zurich",             # Google Cloud europe-west6
    "delhi",              # Various cloud
    "warsaw",             # AWS eu-central-2
    # ── Search engine + AI crawler origins (added 12 May 2026) ─────
    "mountain view",      # Googlebot HQ + Google Cloud
    "plano",              # Microsoft / Azure central US
    "bluffdale",          # NSA / various cloud (Utah)
    "boardman",           # AWS us-west-2
    "south bend",          # Various cloud
    "henderson",          # Switch datacentre (Nevada)
    "phoenix",            # Various cloud / iCloud
    "atlanta",            # CoreSite / various cloud
    "chicago",            # Various cloud (high bot ratio)
    "dallas",             # Various cloud
    "los angeles",        # Various cloud (high bot ratio)
    "new york",           # Various cloud (high bot ratio)
    "miami",              # Various cloud
    "amsterdam",          # AWS eu-west-* / DigitalOcean ams
    "rotterdam",          # Various cloud
    "helsinki",           # Hetzner / various cloud
    "nuremberg",           # Hetzner DE
    "munich",             # Various cloud
    "vienna",             # Microsoft / Cloudflare
    "ojinaga",            # Various cloud
    "richardson",         # Microsoft / Verizon datacentre
    "auburn",             # Various cloud
    "north bergen",       # AWS / Cogent
    "queens",             # AWS / DigitalOcean nyc
    "newark",              # DigitalOcean nyc3
    "san diego",          # Various cloud
})


def _is_datacentre_location(location: dict) -> bool:
    """True when the location dict points at a known cloud-datacentre.
    Robust to missing keys and case differences."""
    if not location:
        return False
    city = (location.get("city") or "").strip().lower()
    if not city or city in ("unknown", "—", "-"):
        return False
    if city in _DATACENTRE_CITIES:
        return True
    # Substring match to handle "Ashburn, VA" style strings
    for needle in _DATACENTRE_CITIES:
        if needle in city:
            return True
    return False


# ─── UK-ONLY HARD LOCKDOWN (12 May 2026) ─────────────────────────────
# Admin demanded zero notifications/visitors from non-UK countries.
# Tile Station is a UK-only business — any visit from outside GB is
# either a bot, a scraper, or a curious foreigner who will never buy.
# This helper is the single source of truth for the country guard;
# wired into the track endpoint, the live-visitors panel, AND every
# Telegram alert.
_ALLOWED_COUNTRY_CODES = frozenset({"GB"})
_ALLOWED_COUNTRY_NAMES = frozenset({
    "united kingdom", "uk", "great britain", "england", "scotland",
    "wales", "northern ireland",
})


def _is_uk_visitor(location: dict) -> bool:
    """Return True ONLY when the location is conclusively UK.

    Unknown / missing country = NOT UK (fail closed). This is a hard
    lockdown — we'd rather miss a logged-out UK visitor than show a
    single non-UK row in the admin panel ever again.

    Reads both `country_code` (ISO2, from Cloudflare's CF-IPCountry
    header) and `country` (full name, from IP-API fallback).
    """
    if not location:
        return False
    cc = (location.get("country_code") or "").strip().upper()
    if cc in _ALLOWED_COUNTRY_CODES:
        return True
    if cc and cc not in _ALLOWED_COUNTRY_CODES:
        return False  # explicit non-UK ISO2 — reject
    # No ISO2 → fall back to full country-name match
    name = (location.get("country") or "").strip().lower()
    return name in _ALLOWED_COUNTRY_NAMES


def _looks_like_bot(user_agent_string: str) -> bool:
    """Match against the comprehensive bot signature list. Empty or
    missing UA is treated as a bot (no real browser ships without one)."""
    if not user_agent_string:
        return True
    ua = user_agent_string.lower().strip()
    if len(ua) < 8:  # absurdly short = scripted
        return True
    return any(sig in ua for sig in _BOT_UA_SIGNATURES)


def _is_valid_tilestation_url(page_url: str) -> bool:
    """A real customer's analytics ping carries the page they're on.
    Bot pings often carry junk like `https://example.com/...` or other
    domains. Reject anything that looks off-site or schemeless garbage.
    """
    if not page_url:
        return False
    pu = page_url.strip().lower()
    # Same-origin relative path is fine
    if pu.startswith("/"):
        return True
    # Absolute URL must point at our own domain (any subdomain of
    # tilestation.co.uk, plus the railway preview URL we control)
    allowed_hosts = (
        "tilestation.co.uk", "www.tilestation.co.uk",
        "tile-station-production.up.railway.app",
        ".preview.emergentagent.com",  # Emergent preview substring match
    )
    for host in allowed_hosts:
        if f"://{host}" in pu or f"//{host}" in pu or host in pu:
            return True
    return False


def generate_visitor_id(ip: str, user_agent: str) -> str:
    """Generate a consistent visitor ID from IP and user agent"""
    combined = f"{ip}:{user_agent}"
    return hashlib.sha256(combined.encode()).hexdigest()[:16]


async def broadcast_live_update(db):
    """Broadcast live visitor update to all connected WebSocket clients"""
    if not _active_ws_connections:
        return
    
    try:
        live_data = await get_live_visitors_data(db)
        message = json.dumps({"type": "live_update", "data": live_data})
        
        for connection in _active_ws_connections[:]:
            try:
                await connection.send_text(message)
            except:
                if connection in _active_ws_connections:
                    _active_ws_connections.remove(connection)
    except Exception as e:
        logger.error(f"Broadcast error: {e}")


async def get_live_visitors_data(db) -> dict:
    """Get current live visitors (active in last 5 minutes).

    Defensive bot filtering at the read layer (belt + braces — track endpoint
    also rejects bots, but old rows + edge cases get cleaned here):
      • `device.is_bot=True` already flagged → excluded
      • datacentre cities (Ashburn, Council Bluffs, Dublin DCs, etc.) → excluded
      • non-existent /shop/.../shop/... double-prefix URLs → excluded
        (those are scrapers probing for /track endpoints inside collection slugs)
    """
    five_minutes_ago = datetime.now(timezone.utc) - timedelta(minutes=5)
    
    pipeline = [
        {"$match": {
            "timestamp": {"$gte": five_minutes_ago},
            # Hard exclude any row already flagged as a bot at write-time
            "$or": [
                {"device.is_bot": {"$exists": False}},
                {"device.is_bot": False},
            ],
        }},
        {"$group": {
            "_id": "$visitor_id",
            "last_page": {"$last": "$page_url"},
            "last_seen": {"$max": "$timestamp"},
            "page_count": {"$sum": 1},
            "country": {"$first": "$location.country"},
            "country_code": {"$first": "$location.country_code"},
            "city": {"$first": "$location.city"},
            "device_type": {"$first": "$device.device_type"},
            "referrer": {"$first": "$referrer"}
        }},
        {"$sort": {"last_seen": -1}},
        {"$limit": 100}
    ]
    
    visitors = await db.page_views.aggregate(pipeline).to_list(100)
    
    formatted_visitors = []
    for v in visitors:
        loc = {
            "city": v.get("city"),
            "country": v.get("country"),
            "country_code": v.get("country_code"),
        }
        # Skip datacentre-origin visitors
        if _is_datacentre_location(loc):
            continue
        # Hard UK-only filter — admin requirement from 12 May 2026.
        # Anything not conclusively UK is hidden from the admin panel.
        if not _is_uk_visitor(loc):
            continue
        # Skip obvious bot URL patterns (e.g. /shop/collection/X/shop/track —
        # double "/shop/" prefix is a scraper hallmark, never a real customer route).
        page = (v.get("last_page") or "").lower()
        if page.count("/shop/") >= 2 or "/shop/track" in page:
            continue
        formatted_visitors.append({
            "visitor_id": v["_id"],
            "current_page": v["last_page"],
            "last_seen": v["last_seen"].isoformat() if v["last_seen"] else None,
            "pages_viewed": v["page_count"],
            "country": v.get("country", "Unknown"),
            "city": v.get("city", "Unknown"),
            "device_type": v.get("device_type", "unknown"),
            "referrer": v.get("referrer", "Direct")
        })
    
    return {
        "count": len(formatted_visitors),
        "visitors": formatted_visitors,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }


@router.post("/website/track")
async def track_page_view(data: PageViewTrack, request: Request):
    """Track a page view from the website (public endpoint - no auth required)"""
    db = get_db()
    
    try:
        # Get visitor info
        ip = request.headers.get("X-Forwarded-For", request.client.host if request.client else "unknown")
        if "," in ip:
            ip = ip.split(",")[0].strip()
        
        user_agent = request.headers.get("User-Agent", "")
        visitor_id = generate_visitor_id(ip, user_agent)
        
        # Parse device info
        device_info = parse_device_info(user_agent)
        
        # Skip bots (now uses comprehensive signature list incl. Python/curl/AI scrapers)
        if device_info.get("is_bot"):
            return {"success": True, "tracked": False, "reason": "bot"}

        # Reject pings whose page_url isn't actually on our site —
        # bots commonly send fake URLs like https://example.com/shop
        # which would otherwise pollute the analytics with phantom traffic.
        if not _is_valid_tilestation_url(data.page_url):
            return {"success": True, "tracked": False, "reason": "off_site_url"}

        # ── Visitor location resolution ────────────────────────────
        # Priority order (highest accuracy first):
        #   1. Cloudflare's CF-IPCity (+ CF-IPCountry, CF-Region) when
        #      Cloudflare's "Add visitor location headers" Transform
        #      Rule is enabled. These are device-level geo, derived
        #      from Cloudflare's MaxMind feed but importantly resolved
        #      from the handset's effective IP — which on mobile means
        #      the carrier breakout point, NOT the raw GGSN NAT.
        #   2. Cloudflare's CF-IPCountry alone (Free/Pro tier default).
        #      Country accurate; city left as "Unknown" rather than
        #      defaulting to the carrier NAT (Manchester for EE,
        #      Vodafone, Three — the bug the user reported on 30 May).
        #   3. IP-API HTTP lookup against the raw client IP — last
        #      resort for non-Cloudflare paths (preview env, direct
        #      backend hits). Subject to the carrier-NAT inaccuracy
        #      that motivated this change.
        cf_country = (request.headers.get("CF-IPCountry") or "").upper()
        cf_country = cf_country if len(cf_country) == 2 else ""
        cf_city = (request.headers.get("CF-IPCity") or "").strip()
        cf_region = (request.headers.get("CF-Region") or "").strip()

        if cf_country and cf_city:
            location = {
                "country": _country_name_from_iso2(cf_country),
                "city": cf_city,
                "region": cf_region or None,
                "country_code": cf_country,
                "source": "cloudflare",
            }
        elif cf_country:
            location = {
                "country": _country_name_from_iso2(cf_country),
                "city": "Unknown",
                "country_code": cf_country,
                "source": "cloudflare_country_only",
            }
        else:
            location = await get_geo_location(ip)
            location["source"] = "ip_api"

        # Datacentre IP guard — block ANYTHING coming from a known cloud
        # hosting region. Real customers don't visit a UK tile retailer
        # from AWS us-east-1 (Ashburn), Google Cloud us-central1 (Council
        # Bluffs), AWS eu-west-1 (Dublin), etc. The 12 May 2026 incident
        # showed bots spoofing "Mobile Chrome" UAs from Ashburn slipping
        # past the UA filter — this catches them.
        if _is_datacentre_location(location):
            return {"success": True, "tracked": False, "reason": "datacentre_ip"}

        # ── UK-ONLY HARD LOCKDOWN ──────────────────────────────────
        # Tile Station is UK-only. Reject everything else at the
        # boundary so it never even enters page_views. The admin
        # demanded zero non-UK rows; this is the enforcement point.
        if not _is_uk_visitor(location):
            return {"success": True, "tracked": False, "reason": "non_uk_visitor"}
        
        # Create page view record
        page_view = {
            "visitor_id": visitor_id,
            "session_id": data.session_id or visitor_id,
            "page_url": data.page_url,
            "page_title": data.page_title,
            "referrer": data.referrer or "Direct",
            "ip_hash": hashlib.sha256(ip.encode()).hexdigest()[:12],
            "location": location,
            "device": device_info,
            "timestamp": datetime.now(timezone.utc),
            "date": datetime.now(timezone.utc).strftime("%Y-%m-%d")
        }
        
        await db.page_views.insert_one(page_view)
        
        # Update daily stats
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        await db.analytics_daily.update_one(
            {"date": today},
            {
                "$inc": {"total_views": 1},
                "$addToSet": {"unique_visitors": visitor_id},
                "$set": {"updated_at": datetime.now(timezone.utc)}
            },
            upsert=True
        )
        
        # Broadcast to WebSocket clients
        asyncio.create_task(broadcast_live_update(db))

        # Fire Telegram "new visitor" alert (gated by per-event toggle in
        # admin UI; rate-limited 1/hour per visitor_id by the service).
        # Tagged staff devices are skipped at the alert callsite. Datacentre
        # origins (Mountain View, Ashburn, etc.) are also skipped — those
        # are bots/scrapers, not real customers (added 12 May 2026 after
        # admin complained about Googlebot triggering visitor pings).
        try:
            from services.telegram_notify import fire_and_forget
            is_tagged_device = bool(await db.known_devices.find_one(
                {"visitor_id": visitor_id, "exclude_from_stats": True},
                {"_id": 0},
            )) if visitor_id else False
            if not is_tagged_device and not _is_datacentre_location(location) and _is_uk_visitor(location):
                page_url = (data.page_url or "/")[:120]
                referrer = (data.referrer or "Direct")[:200]
                country = (location or {}).get("country") or "Unknown"
                city = (location or {}).get("city") or ""
                where = f"{city}, {country}" if city else country
                text = (
                    "<b>👋 New visitor on tilestation.co.uk</b>\n"
                    f"<b>Page:</b> {page_url}\n"
                    f"<b>Referrer:</b> {referrer}\n"
                    f"<b>Where:</b> {where}\n"
                    f"<b>Device:</b> {device_info.get('device_type', 'unknown')}"
                )
                fire_and_forget("visitor_landed", text, dedupe_key=visitor_id)
        except Exception as _telegram_exc:
            logger.debug(f"Telegram visitor alert skipped: {_telegram_exc}")

        # 🔥 Hot Session detection — fire once per session when a visitor has
        # viewed ≥3 distinct PDPs AND been on site >2 min. High-signal alert
        # so the sales team can call genuine buying intent, not drive-bys.
        # Only runs when the page that just landed is itself a PDP (cheap
        # short-circuit so we don't query DB on every homepage refresh).
        try:
            if not is_tagged_device and _is_uk_visitor(location) and _is_pdp_url(data.page_url):
                from services.telegram_notify import fire_and_forget as _ff_hot
                session_id = page_view["session_id"]
                cutoff = datetime.now(timezone.utc) - timedelta(minutes=30)
                session_pages = await db.page_views.find(
                    {"session_id": session_id, "timestamp": {"$gte": cutoff}},
                    {"_id": 0, "page_url": 1, "timestamp": 1},
                ).to_list(200)
                if len(session_pages) >= 3:
                    unique_pdps = {
                        (p.get("page_url") or "").split("?")[0]
                        for p in session_pages
                        if _is_pdp_url(p.get("page_url"))
                    }
                    if len(unique_pdps) >= 3:
                        ts_list = [p["timestamp"] for p in session_pages if p.get("timestamp")]
                        if ts_list:
                            duration_s = int((max(ts_list) - min(ts_list)).total_seconds())
                            if duration_s > 120:
                                country = (location or {}).get("country") or "Unknown"
                                city = (location or {}).get("city") or ""
                                where = f"{city}, {country}" if city else country
                                mins, secs = divmod(duration_s, 60)
                                text_hot = (
                                    "<b>🔥 Hot session on tilestation.co.uk</b>\n"
                                    f"<b>Products viewed:</b> {len(unique_pdps)}\n"
                                    f"<b>Time on site:</b> {mins}m {secs}s\n"
                                    f"<b>Where:</b> {where}\n"
                                    f"<b>Device:</b> {device_info.get('device_type', 'unknown')}\n"
                                    f"<b>Latest page:</b> {(data.page_url or '/')[:120]}"
                                )
                                _ff_hot("hot_session", text_hot, dedupe_key=session_id)
                                # Persist the hot flag so the Live Visitors
                                # admin row can show a 🔥 badge for the next
                                # 30 minutes (matches the dedupe window).
                                try:
                                    await db.hot_sessions.update_one(
                                        {"session_id": session_id},
                                        {"$set": {
                                            "session_id": session_id,
                                            "visitor_id": visitor_id,
                                            "marked_at": datetime.now(timezone.utc),
                                            "products_viewed": len(unique_pdps),
                                            "duration_s": duration_s,
                                        }},
                                        upsert=True,
                                    )
                                except Exception as _hot_persist_exc:
                                    logger.debug(f"hot_sessions persist skipped: {_hot_persist_exc}")
        except Exception as _hot_exc:
            logger.debug(f"Telegram hot-session check skipped: {_hot_exc}")

        return {"success": True, "tracked": True}
    
    except Exception as e:
        logger.error(f"Error tracking page view: {e}")
        return {"success": False, "error": str(e)}


@router.get("/website/live")
async def get_live_visitors(user: dict = Depends(get_current_user)):
    """Get currently active visitors (last 5 minutes)"""
    db = get_db()
    return await get_live_visitors_data(db)


@router.post("/website/cleanup-bot-traffic")
async def cleanup_bot_traffic(
    days: int = 60,
    dry_run: bool = True,
    user: dict = Depends(get_current_user),
):
    """One-shot purge of historic bot rows from page_views.

    Uses the same comprehensive bot detection as the live tracker:
      • UA matching the new BOT_UA_SIGNATURES list (Python, curl,
        wget, headless Chrome, GPTBot, ClaudeBot, etc.)
      • OR off-site URLs (e.g. https://example.com/...)
      • OR `device.is_bot=True` already flagged
      • OR `location.city` matches a known cloud-datacentre (Ashburn,
        Council Bluffs, Dublin DCs, Frankfurt, etc.) — added 12 May 2026
        after bots spoofing mobile-Chrome UAs slipped past the UA filter.
      • OR `page_url` contains the double-`/shop/` scraper pattern.

    `dry_run=True` returns the count of rows that WOULD be deleted
    without touching anything. `dry_run=false` performs the delete.
    """
    if (user or {}).get("role") not in ("admin", "super_admin", "manager"):
        raise HTTPException(status_code=403, detail="Admin only")
    db = get_db()
    cutoff = datetime.now(timezone.utc) - timedelta(days=max(1, min(days, 365)))

    # Build a single Mongo query that captures every bot signal in one
    # pass. Each branch is independently sufficient to flag the row.
    # Note: the city-regex uses case-insensitive match across all
    # known datacentre cities.
    datacentre_regex = "|".join(
        # Escape any regex-special characters in the city names. Most are
        # plain letters but Saint-Ghislain etc. have hyphens which are safe.
        c.replace(" ", r"\s*") for c in sorted(_DATACENTRE_CITIES)
    )
    cursor = db.page_views.find(
        {
            "timestamp": {"$gte": cutoff},
            "$or": [
                {"device.is_bot": True},
                # Off-site / fake URLs commonly used by scrapers
                {"page_url": {"$regex": r"^https?://example\.(com|org|net)", "$options": "i"}},
                {"page_url": {"$regex": r"^https?://(?!.*tilestation|.*railway|.*emergentagent)", "$options": "i"}},
                # Double /shop/ scraper pattern
                {"page_url": {"$regex": r"/shop/[^/]+/shop/", "$options": "i"}},
                {"page_url": {"$regex": r"/shop/track", "$options": "i"}},
                # Datacentre origin — the big one (added 12 May 2026)
                {"location.city": {"$regex": datacentre_regex, "$options": "i"}},
                # ── UK-only hard lockdown (added 12 May 2026) ──
                # Anything explicitly NOT GB is purged. Records with
                # no country_code at all are also caught (probably
                # bot or proxy) by the page_url / device.is_bot rules.
                {"location.country_code": {"$exists": True, "$nin": ["GB", "gb", None, ""]}},
            ],
        },
        {"_id": 1, "device": 1, "page_url": 1, "location": 1},
    )
    candidate_ids = []
    async for row in cursor:
        # Re-validate against current rules so we don't false-positive
        # on legitimate same-origin deep links.
        page_url = row.get("page_url") or ""
        if not _is_valid_tilestation_url(page_url):
            candidate_ids.append(row["_id"])
            continue
        if (row.get("device") or {}).get("is_bot"):
            candidate_ids.append(row["_id"])
            continue
        if _is_datacentre_location(row.get("location") or {}):
            candidate_ids.append(row["_id"])
            continue
        # Non-UK hard guard
        if not _is_uk_visitor(row.get("location") or {}):
            candidate_ids.append(row["_id"])
            continue
        # Double /shop/ pattern hard-block
        pu_lower = page_url.lower()
        if pu_lower.count("/shop/") >= 2 or "/shop/track" in pu_lower:
            candidate_ids.append(row["_id"])

    if dry_run:
        return {
            "dry_run": True,
            "would_delete": len(candidate_ids),
            "window_days": days,
        }

    if not candidate_ids:
        return {"dry_run": False, "deleted": 0, "window_days": days}

    res = await db.page_views.delete_many({"_id": {"$in": candidate_ids}})
    return {
        "dry_run": False,
        "deleted": res.deleted_count,
        "window_days": days,
    }


@router.get("/website/stats")
async def get_website_stats(period: str = "today", user: dict = Depends(get_current_user)):
    """
    Get website analytics statistics for a given period
    period: 'today', 'yesterday', 'week', 'month', 'year', 'all'
    """
    db = get_db()
    now = datetime.now(timezone.utc)
    
    # Determine date range
    if period == "today":
        start_date = now.replace(hour=0, minute=0, second=0, microsecond=0)
    elif period == "yesterday":
        start_date = (now - timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
        now = start_date + timedelta(days=1)
    elif period == "week":
        start_date = now - timedelta(days=7)
    elif period == "month":
        start_date = now - timedelta(days=30)
    elif period == "year":
        start_date = now - timedelta(days=365)
    else:
        start_date = datetime(2020, 1, 1, tzinfo=timezone.utc)
    
    # Get total views and unique visitors
    pipeline = [
        {"$match": {"timestamp": {"$gte": start_date, "$lte": now}}},
        {"$group": {
            "_id": None,
            "total_views": {"$sum": 1},
            "unique_visitors": {"$addToSet": "$visitor_id"}
        }}
    ]
    
    result = await db.page_views.aggregate(pipeline).to_list(1)
    
    if result:
        total_views = result[0]["total_views"]
        unique_visitors = len(result[0]["unique_visitors"])
    else:
        total_views = 0
        unique_visitors = 0
    
    # Get views by day
    views_pipeline = [
        {"$match": {"timestamp": {"$gte": start_date, "$lte": now}}},
        {"$group": {
            "_id": "$date",
            "views": {"$sum": 1},
            "visitors": {"$addToSet": "$visitor_id"}
        }},
        {"$project": {
            "_id": 0,
            "date": "$_id",
            "views": 1,
            "unique_visitors": {"$size": "$visitors"}
        }},
        {"$sort": {"date": 1}},
        {"$limit": 365}
    ]
    
    views_by_day = await db.page_views.aggregate(views_pipeline).to_list(365)
    
    # Get top pages
    pages_pipeline = [
        {"$match": {"timestamp": {"$gte": start_date, "$lte": now}}},
        {"$group": {
            "_id": "$page_url",
            "views": {"$sum": 1},
            "visitors": {"$addToSet": "$visitor_id"},
            "title": {"$first": "$page_title"}
        }},
        {"$project": {
            "_id": 0,
            "page_url": "$_id",
            "views": 1,
            "unique_visitors": {"$size": "$visitors"},
            "title": 1
        }},
        {"$sort": {"views": -1}},
        {"$limit": 20}
    ]
    
    top_pages = await db.page_views.aggregate(pages_pipeline).to_list(20)
    
    # Get device breakdown
    device_pipeline = [
        {"$match": {"timestamp": {"$gte": start_date, "$lte": now}}},
        {"$group": {
            "_id": "$device.device_type",
            "count": {"$sum": 1}
        }},
        {"$project": {"_id": 0, "device_type": "$_id", "count": 1}}
    ]
    
    devices = await db.page_views.aggregate(device_pipeline).to_list(10)
    
    # Get top countries
    countries_pipeline = [
        {"$match": {"timestamp": {"$gte": start_date, "$lte": now}}},
        {"$group": {
            "_id": "$location.country",
            "views": {"$sum": 1},
            "visitors": {"$addToSet": "$visitor_id"}
        }},
        {"$project": {
            "_id": 0,
            "country": "$_id",
            "views": 1,
            "unique_visitors": {"$size": "$visitors"}
        }},
        {"$sort": {"views": -1}},
        {"$limit": 10}
    ]
    
    top_countries = await db.page_views.aggregate(countries_pipeline).to_list(10)
    
    # Get top referrers
    referrers_pipeline = [
        {"$match": {"timestamp": {"$gte": start_date, "$lte": now}, "referrer": {"$ne": "Direct"}}},
        {"$group": {
            "_id": "$referrer",
            "views": {"$sum": 1}
        }},
        {"$project": {"_id": 0, "referrer": "$_id", "views": 1}},
        {"$sort": {"views": -1}},
        {"$limit": 10}
    ]
    
    top_referrers = await db.page_views.aggregate(referrers_pipeline).to_list(10)
    
    # Get hourly distribution for today
    today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    hourly_pipeline = [
        {"$match": {"date": today_str}},
        {"$group": {
            "_id": {"$hour": "$timestamp"},
            "views": {"$sum": 1}
        }},
        {"$project": {"_id": 0, "hour": "$_id", "views": 1}},
        {"$sort": {"hour": 1}}
    ]
    
    hourly_views = await db.page_views.aggregate(hourly_pipeline).to_list(24)
    
    return {
        "period": period,
        "start_date": start_date.isoformat(),
        "end_date": now.isoformat(),
        "total_views": total_views,
        "unique_visitors": unique_visitors,
        "avg_views_per_visitor": round(total_views / unique_visitors, 2) if unique_visitors > 0 else 0,
        "views_by_day": views_by_day,
        "top_pages": top_pages,
        "devices": devices,
        "top_countries": top_countries,
        "top_referrers": top_referrers,
        "hourly_views": hourly_views
    }


@router.get("/website/pages")
async def get_page_analytics(page_url: Optional[str] = None, limit: int = 50, user: dict = Depends(get_current_user)):
    """Get detailed analytics for pages"""
    db = get_db()
    
    pipeline = [
        {"$group": {
            "_id": "$page_url",
            "total_views": {"$sum": 1},
            "unique_visitors": {"$addToSet": "$visitor_id"},
            "title": {"$first": "$page_title"},
            "last_viewed": {"$max": "$timestamp"},
            "first_viewed": {"$min": "$timestamp"}
        }},
        {"$project": {
            "_id": 0,
            "page_url": "$_id",
            "total_views": 1,
            "unique_visitors": {"$size": "$unique_visitors"},
            "title": 1,
            "last_viewed": 1,
            "first_viewed": 1
        }},
        {"$sort": {"total_views": -1}},
        {"$limit": limit}
    ]
    
    if page_url:
        pipeline.insert(0, {"$match": {"page_url": {"$regex": page_url, "$options": "i"}}})
    
    pages = await db.page_views.aggregate(pipeline).to_list(limit)
    
    for page in pages:
        if page.get("last_viewed"):
            page["last_viewed"] = page["last_viewed"].isoformat()
        if page.get("first_viewed"):
            page["first_viewed"] = page["first_viewed"].isoformat()
    
    return {"pages": pages, "count": len(pages)}


@router.get("/website/visitors/recent")
async def get_recent_visitors(limit: int = 50, user: dict = Depends(get_current_user)):
    """Get recent unique visitors with their activity"""
    db = get_db()
    
    pipeline = [
        {"$sort": {"timestamp": -1}},
        {"$group": {
            "_id": "$visitor_id",
            "last_seen": {"$first": "$timestamp"},
            "first_seen": {"$last": "$timestamp"},
            "pages_viewed": {"$sum": 1},
            "last_page": {"$first": "$page_url"},
            "country": {"$first": "$location.country"},
            "city": {"$first": "$location.city"},
            "device_type": {"$first": "$device.device_type"},
            "browser": {"$first": "$device.browser"},
            "os": {"$first": "$device.os"},
            "referrer": {"$first": "$referrer"}
        }},
        {"$sort": {"last_seen": -1}},
        {"$limit": limit},
        {"$project": {
            "_id": 0,
            "visitor_id": "$_id",
            "last_seen": 1,
            "first_seen": 1,
            "pages_viewed": 1,
            "last_page": 1,
            "country": 1,
            "city": 1,
            "device_type": 1,
            "browser": 1,
            "os": 1,
            "referrer": 1
        }}
    ]
    
    visitors = await db.page_views.aggregate(pipeline).to_list(limit)
    
    for v in visitors:
        if v.get("last_seen"):
            v["last_seen"] = v["last_seen"].isoformat()
        if v.get("first_seen"):
            v["first_seen"] = v["first_seen"].isoformat()
    
    return {"visitors": visitors, "count": len(visitors)}


@router.get("/website/visitor-history")
async def get_visitor_history(
    days: int = 7,
    limit: int = 100,
    pdp_only: bool = False,
    min_pages: int = 1,
    user: dict = Depends(get_current_user),
):
    """Visitor history grouped by VISITOR (one row per unique person/device),
    with all their sessions nested inside.

    A "visitor" here = same `visitor_id` (hash of IP + user-agent + accept-language).
    A "session" = same `session_id` within that visitor. So:
      - someone who visits today, leaves, comes back tomorrow → ONE row, "2 visits"
      - someone who opens 3 tabs in the same browser → ONE row, 1-3 sessions inside
    Time-on-page is computed as the gap between consecutive page-view timestamps
    within the same session (capped at 30m).

    No new tracking is added. Pure aggregation over `page_views`.
    """
    if user.get("role") not in {"admin", "super_admin"}:
        raise HTTPException(status_code=403, detail="Admin only")

    db = get_db()
    start = datetime.now(timezone.utc) - timedelta(days=max(1, min(days, 90)))

    match: dict = {"timestamp": {"$gte": start}}
    if pdp_only:
        match["page_url"] = {"$regex": r"^/(shop|tile|product|product-detail)/", "$options": "i"}

    # Pull every page-view row in the window. We do the per-session +
    # per-visitor grouping in Python because it lets us compute dwell-time
    # gaps cleanly without a deeply-nested aggregation pipeline.
    cursor = db.page_views.find(match).sort("timestamp", 1)
    rows = await cursor.to_list(20000)
    if not rows:
        return {"visitors": [], "sessions": [], "summary": {"visitor_count": 0, "returning_count": 0, "session_count": 0, "total_pdp_views": 0, "avg_pdp_dwell_s": 0, "lookback_days": days}}

    # Skip admin's own /admin/* page views (don't pollute history with our own clicks)
    # but DO include currently-live sessions so the most recent visitors show
    # up here too. The Live panel is a real-time snapshot; this list is the
    # full record of everyone who has visited in the window.
    rows = [r for r in rows if not (r.get("page_url") or "").startswith("/admin")]
    if not rows:
        return {"visitors": [], "sessions": [], "summary": {"visitor_count": 0, "returning_count": 0, "session_count": 0, "total_pdp_views": 0, "avg_pdp_dwell_s": 0, "lookback_days": days}}

    # Step 1 — group rows into sessions
    sessions_by_id: dict = {}
    for r in rows:
        sid = r.get("session_id") or "no-session"
        sessions_by_id.setdefault(sid, []).append(r)

    # Step 2 — build a session object (with dwell times) per session_id
    def build_session(sid: str, page_rows: list) -> dict:
        # Compute dwell as gap between consecutive timestamps
        page_rows.sort(key=lambda r: r.get("timestamp"))
        enriched = []
        for i, p in enumerate(page_rows):
            this_ts = p.get("timestamp")
            next_ts = page_rows[i + 1].get("timestamp") if i + 1 < len(page_rows) else None
            dwell_s = int((next_ts - this_ts).total_seconds()) if next_ts else 0
            capped = min(max(0, dwell_s), 1800)
            url = p.get("page_url") or ""
            enriched.append({
                "url": url,
                "title": p.get("page_title"),
                "ts": this_ts.isoformat() if this_ts else None,
                "dwell_s": dwell_s,
                "dwell_capped_s": capped,
                "is_pdp": bool(url and url.split("?")[0].split("/")[1:2] in (["shop"], ["tile"], ["product"], ["product-detail"])),
            })
        first = page_rows[0].get("timestamp")
        last = page_rows[-1].get("timestamp")
        first_row = page_rows[0]
        return {
            "session_id": sid,
            "first_seen": first.isoformat() if first else None,
            "last_seen": last.isoformat() if last else None,
            "duration_s": int((last - first).total_seconds()) if first and last else 0,
            "total_dwell_s": sum(p["dwell_capped_s"] for p in enriched),
            "page_count": len(enriched),
            "pages": enriched,
            "country": (first_row.get("location") or {}).get("country") or "Unknown",
            "city": (first_row.get("location") or {}).get("city") or "",
            "device_type": (first_row.get("device") or {}).get("device_type") or "unknown",
            "browser": (first_row.get("device") or {}).get("browser") or "—",
            "first_referrer": first_row.get("referrer") or "Direct",
        }

    sessions = [build_session(sid, page_rows) for sid, page_rows in sessions_by_id.items()]
    sessions = [s for s in sessions if s["page_count"] >= max(1, min_pages)]

    # Step 3 — group sessions by visitor_id (fall back to ip_hash, then session_id)
    visitor_key_for_session: dict = {}
    for sid, page_rows in sessions_by_id.items():
        first = page_rows[0]
        # Prefer stored visitor_id, then ip_hash, then session_id (orphan)
        visitor_key_for_session[sid] = (
            first.get("visitor_id")
            or first.get("ip_hash")
            or sid
        )

    visitors_map: dict = {}
    for s in sessions:
        vk = visitor_key_for_session.get(s["session_id"], s["session_id"])
        visitors_map.setdefault(vk, []).append(s)

    # Step 4 — assemble visitor-level rows with aggregates
    visitors_out = []
    for vk, vsessions in visitors_map.items():
        vsessions.sort(key=lambda s: s["last_seen"] or "", reverse=True)
        latest = vsessions[0]
        total_pages = sum(s["page_count"] for s in vsessions)
        total_dwell = sum(s["total_dwell_s"] for s in vsessions)
        pdp_views = sum(1 for s in vsessions for p in s["pages"] if p["is_pdp"])
        first_ever = min((s["first_seen"] for s in vsessions if s["first_seen"]), default=None)
        last_ever = max((s["last_seen"] for s in vsessions if s["last_seen"]), default=None)
        visitors_out.append({
            "visitor_id": vk,
            "visit_count": len(vsessions),     # number of distinct sessions
            "is_returning": len(vsessions) > 1,
            "total_pages": total_pages,
            "total_dwell_s": total_dwell,
            "total_pdp_views": pdp_views,
            "first_seen": first_ever,
            "last_seen": last_ever,
            "country": latest["country"],
            "city": latest["city"],
            "device_type": latest["device_type"],
            "browser": latest["browser"],
            "first_referrer": next(
                (s["first_referrer"] for s in reversed(vsessions) if s["first_referrer"] and s["first_referrer"] != "Direct"),
                latest["first_referrer"],
            ),
            "sessions": vsessions,
        })

    visitors_out.sort(key=lambda v: v["last_seen"] or "", reverse=True)
    visitors_out = visitors_out[: max(1, min(limit, 500))]

    # Decorate sessions + visitors with the 🔥 Hot Session flag so the History
    # panel can show which sessions hit the buying-intent threshold. Single
    # bulk query against `hot_sessions` to avoid N+1.
    try:
        hot_set: set = set()
        cursor_hot = db.hot_sessions.find(
            {"marked_at": {"$gte": start}},
            {"_id": 0, "session_id": 1},
        )
        async for h in cursor_hot:
            sid = h.get("session_id")
            if sid:
                hot_set.add(sid)
        for v in visitors_out:
            any_hot = False
            for s in v.get("sessions", []):
                s["is_hot"] = s.get("session_id") in hot_set
                if s["is_hot"]:
                    any_hot = True
            v["is_hot"] = any_hot
    except Exception as _hot_decorate_exc:
        logger.debug(f"hot session decorate skipped: {_hot_decorate_exc}")

    # Headline aggregates
    pdp_dwells = [
        p["dwell_capped_s"]
        for v in visitors_out for s in v["sessions"] for p in s["pages"]
        if p.get("is_pdp")
    ]
    avg_pdp = int(sum(pdp_dwells) / len(pdp_dwells)) if pdp_dwells else 0
    returning = sum(1 for v in visitors_out if v["is_returning"])

    return {
        "visitors": visitors_out,
        # Backwards-compat for any caller still expecting `sessions`
        "sessions": [s for v in visitors_out for s in v["sessions"]],
        "summary": {
            "visitor_count": len(visitors_out),
            "returning_count": returning,
            "session_count": sum(v["visit_count"] for v in visitors_out),
            "total_pdp_views": len(pdp_dwells),
            "avg_pdp_dwell_s": avg_pdp,
            "lookback_days": days,
        },
    }


@router.get("/website/top-pages")
async def get_top_pages(
    days: int = 7,
    limit: int = 15,
    user: dict = Depends(get_current_user),
):
    """Top visited pages, excluding home/auth/admin/checkout etc.
    Used by the leaderboard chip on /admin/live-visitors so the team can
    see which products / collections actually pull traffic."""
    if user.get("role") not in {"admin", "super_admin"}:
        raise HTTPException(status_code=403, detail="Admin only")

    db = get_db()
    start = datetime.now(timezone.utc) - timedelta(days=max(1, min(days, 90)))

    # Exclude noise: home, auth, admin, account, checkout, basket, search.
    # Keep only meaningful storefront pages so the chart is action-able.
    exclude_pattern = (
        r"^(/?$|/shop/?$|/login|/register|/auth|/admin|/account|/profile|"
        r"/checkout|/basket|/cart|/search|/contact|/about|/api/)"
    )

    pipeline = [
        {"$match": {
            "timestamp": {"$gte": start},
            "page_url": {"$exists": True, "$ne": "", "$not": {"$regex": exclude_pattern, "$options": "i"}},
        }},
        # Strip query strings so /shop/x?ref=fb and /shop/x merge
        {"$addFields": {
            "url_clean": {"$arrayElemAt": [{"$split": ["$page_url", "?"]}, 0]},
        }},
        {"$group": {
            "_id": "$url_clean",
            "views": {"$sum": 1},
            "visitors": {"$addToSet": "$visitor_id"},
            "title": {"$first": "$page_title"},
            "last_seen": {"$max": "$timestamp"},
        }},
        {"$project": {
            "_id": 0,
            "url": "$_id",
            "title": 1,
            "views": 1,
            "unique_visitors": {"$size": "$visitors"},
            "last_seen": 1,
        }},
        {"$sort": {"views": -1}},
        {"$limit": max(1, min(limit, 50))},
    ]

    rows = await db.page_views.aggregate(pipeline).to_list(limit)
    for r in rows:
        if r.get("last_seen"):
            r["last_seen"] = r["last_seen"].isoformat()

    return {
        "pages": rows,
        "lookback_days": days,
        "max_views": rows[0]["views"] if rows else 0,
    }


@router.websocket("/website/ws/live")
async def websocket_live_visitors(websocket: WebSocket):
    """WebSocket endpoint for real-time visitor updates"""
    await websocket.accept()
    _active_ws_connections.append(websocket)
    db = get_db()
    
    try:
        # Send initial data
        live_data = await get_live_visitors_data(db)
        await websocket.send_text(json.dumps({"type": "live_update", "data": live_data}))
        
        while True:
            try:
                data = await asyncio.wait_for(websocket.receive_text(), timeout=30)
                if data == "ping":
                    await websocket.send_text("pong")
            except asyncio.TimeoutError:
                await websocket.send_text(json.dumps({"type": "heartbeat"}))
            except WebSocketDisconnect:
                break
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
    finally:
        if websocket in _active_ws_connections:
            _active_ws_connections.remove(websocket)



# ============================================================================
# Hot Sessions Daily Digest — fires at 09:00 UTC, summarises yesterday's
# hot sessions for the sales team. Coffee-time reading list of "people who
# almost bought yesterday — call them now". Idempotent per UTC date.
# ============================================================================
async def _build_hot_sessions_digest(db, day_start: datetime, day_end: datetime) -> dict:
    """Pulls all hot_sessions in [day_start, day_end) and enriches each with the
    actual page paths the visitor viewed (single page_views query, in-Python
    grouping). Returns a dict suitable for both the email body and a future
    in-app endpoint."""
    rows = []
    async for h in db.hot_sessions.find(
        {"marked_at": {"$gte": day_start, "$lt": day_end}},
        {"_id": 0},
    ).sort("marked_at", -1):
        rows.append(h)
    if not rows:
        return {"sessions": [], "count": 0}

    session_ids = [r["session_id"] for r in rows if r.get("session_id")]
    pv_map: dict = {}
    if session_ids:
        cursor_pv = db.page_views.find(
            {"session_id": {"$in": session_ids}},
            {"_id": 0, "session_id": 1, "page_url": 1, "page_title": 1,
             "location": 1, "device": 1, "referrer": 1, "timestamp": 1},
        ).sort("timestamp", 1)
        async for pv in cursor_pv:
            pv_map.setdefault(pv["session_id"], []).append(pv)

    sessions = []
    for r in rows:
        sid = r.get("session_id") or ""
        pvs = pv_map.get(sid, [])
        first = pvs[0] if pvs else {}
        location = (first.get("location") or {})
        country = location.get("country") or "Unknown"
        city = location.get("city") or ""
        # De-dupe pages while preserving order
        seen, pages_clean = set(), []
        for p in pvs:
            url = (p.get("page_url") or "").split("?")[0]
            if url and url not in seen:
                seen.add(url)
                pages_clean.append({
                    "url": url,
                    "title": p.get("page_title") or url,
                })
        sessions.append({
            "session_id": sid,
            "visitor_id": r.get("visitor_id"),
            "marked_at": r.get("marked_at").isoformat() if r.get("marked_at") else None,
            "products_viewed": int(r.get("products_viewed") or 0),
            "duration_s": int(r.get("duration_s") or 0),
            "country": country,
            "city": city,
            "device_type": (first.get("device") or {}).get("device_type") or "unknown",
            "first_referrer": first.get("referrer") or "Direct",
            "page_count": len(pvs),
            "pages": pages_clean[:12],  # Cap noise per session in the email
        })
    return {"sessions": sessions, "count": len(sessions)}


def _format_hot_sessions_email_html(sessions: list, day_label: str, dashboard_url: str) -> str:
    if not sessions:
        return ""
    rows_html = []
    for s in sessions:
        mins, secs = divmod(s["duration_s"], 60)
        loc = f"{s['city']}, {s['country']}" if s["city"] else s["country"]
        ref = s["first_referrer"]
        if ref and ref != "Direct":
            try:
                ref = ref.replace("https://", "").replace("http://", "").split("/")[0]
            except Exception:
                pass
        page_list = "".join(
            f"<li style='margin:1px 0'><code style='font-size:11px;color:#374151'>{p['url']}</code></li>"
            for p in s["pages"]
        )
        rows_html.append(
            f"<tr style='border-bottom:1px solid #f1f5f9'>"
            f"<td style='padding:10px;vertical-align:top'>"
            f"<b style='color:#ea580c'>🔥 {s['products_viewed']} products</b><br>"
            f"<span style='color:#64748b;font-size:12px'>{mins}m {secs}s on site</span>"
            f"</td>"
            f"<td style='padding:10px;vertical-align:top;font-size:13px;color:#334155'>"
            f"<b>{loc}</b> · {s['device_type']}<br>"
            f"<span style='color:#64748b;font-size:12px'>via {ref}</span>"
            f"</td>"
            f"<td style='padding:10px;vertical-align:top'>"
            f"<ol style='margin:0;padding-left:18px'>{page_list}</ol>"
            f"</td>"
            f"</tr>"
        )

    return (
        "<div style='font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:760px;margin:0 auto'>"
        f"<h2 style='color:#0f172a'>🔥 Hot Sessions Digest — {day_label}</h2>"
        f"<p style='color:#475569'><b>{len(sessions)}</b> session(s) yesterday viewed 3+ products and stayed 2+ min "
        f"on site. These visitors showed genuine buying intent.</p>"
        f"<table style='border-collapse:collapse;width:100%;background:white;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden'>"
        f"<thead style='background:#fff7ed'>"
        f"<tr><th style='text-align:left;padding:10px;color:#9a3412;font-size:12px;text-transform:uppercase'>Engagement</th>"
        f"<th style='text-align:left;padding:10px;color:#9a3412;font-size:12px;text-transform:uppercase'>Where</th>"
        f"<th style='text-align:left;padding:10px;color:#9a3412;font-size:12px;text-transform:uppercase'>Pages viewed</th></tr>"
        f"</thead><tbody>"
        f"{''.join(rows_html)}"
        f"</tbody></table>"
        f"<p style='color:#64748b;font-size:12px;margin-top:16px'>"
        f"Open <a href='{dashboard_url}/admin/live-visitors' style='color:#ea580c'>Live Visitors</a> "
        f"to see the full session detail and start a follow-up. Toggle this digest off any time in the Telegram Alerts panel.</p>"
        "</div>"
    )


async def run_hot_sessions_digest_tick():
    """Hourly probe — fires the digest only at 09:00 UTC, once per UTC day.
    Idempotent via a marker doc in `website_settings`."""
    db = get_db()
    now = datetime.now(timezone.utc)
    settings = await db.website_settings.find_one({"_id": "hot_sessions_digest"}) or {}
    if not settings.get("enabled", True):
        return
    target_hour = int(settings.get("hour_utc", 9))
    if now.hour != target_hour:
        return
    today = now.strftime("%Y-%m-%d")
    if settings.get("last_sent_date") == today:
        return

    today_midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    yesterday_midnight = today_midnight - timedelta(days=1)
    digest = await _build_hot_sessions_digest(db, yesterday_midnight, today_midnight)

    # Always update the marker so we don't keep re-querying mid-window even
    # on quiet days. Skip the email when there are zero hot sessions.
    if digest["count"] > 0:
        try:
            from services.email import send_simple_email_if_possible
            recipients = [
                u.get("email") async for u in db.users.find(
                    {"role": {"$in": ["admin", "super_admin"]}, "email": {"$ne": None}},
                    {"_id": 0, "email": 1},
                )
            ]
            recipients = [r for r in recipients if r]
            if recipients:
                day_label = yesterday_midnight.strftime("%a %d %b %Y")
                dashboard_url = os.environ.get("PUBLIC_PREVIEW_URL") or os.environ.get("SHOP_WEBSITE_URL") or "https://tilestation.co.uk"
                html = _format_hot_sessions_email_html(digest["sessions"], day_label, dashboard_url.rstrip("/"))
                await send_simple_email_if_possible(
                    to=recipients,
                    subject=f"[Tile Station] 🔥 {digest['count']} hot session(s) yesterday — high buying intent",
                    html=html,
                )
        except Exception as exc:
            logger.warning(f"Hot sessions digest email failed: {exc}")

    await db.website_settings.update_one(
        {"_id": "hot_sessions_digest"},
        {"$set": {"last_sent_date": today, "last_count": digest["count"], "hour_utc": target_hour, "enabled": settings.get("enabled", True)}},
        upsert=True,
    )



# ============================================================================
# Sidebar Activity — Feb 26, 2026
#
# Lightweight aggregate endpoint that powers the small "last activity" snippet
# under specific sidebar items (Price Tickets, Reorder Suggestions, Stocktake
# Report). Returns a tiny payload in ONE query each so we can poll it cheaply
# from the Layout component without flooding the backend.
# ============================================================================
@router.get("/sidebar-activity")
async def get_sidebar_activity(current_user: dict = Depends(get_current_user)):
    """Per-sidebar-item status snippets — for the Layout 'last activity' note.

    Each field is independent: missing data → `null` field on that key, the
    frontend just hides that snippet rather than rendering a stale label.
    """
    db = get_db()

    out: dict = {
        "price_tickets": None,
        "reorder_suggestions": None,
        "stocktake_report": None,
    }

    # ── Price Tickets — newest entry in ticket_print_batches ────────────
    # Scoped to THIS user (so each staff member sees their own last print)
    # because that's how the batches are stored (printed_by = email).
    try:
        latest_batch = await db.ticket_print_batches.find_one(
            {"printed_by": current_user.get("email")},
            {"_id": 0, "last_printed_at": 1, "printed_at": 1, "product_count": 1, "print_count": 1},
            sort=[("last_printed_at", -1)],
        )
        if latest_batch:
            out["price_tickets"] = {
                "last_at": latest_batch.get("last_printed_at") or latest_batch.get("printed_at"),
                "count": int(latest_batch.get("product_count") or 0),
                "print_count": int(latest_batch.get("print_count") or 1),
            }
    except Exception:
        # Missing index / collection → leave null. Frontend hides the row.
        pass

    # ── Reorder Suggestions — count of currently-critical items ─────────
    # We can't easily mirror the full /analyze run here, but a quick
    # signal is the number of products with stock at-or-below their
    # reorder_point (stored on each product). That's accurate enough
    # to put a red dot on the menu when there's something to do.
    try:
        critical = await db.products.count_documents({
            "$expr": {
                "$and": [
                    {"$gt": ["$reorder_point", 0]},
                    {"$lte": ["$stock_quantity", "$reorder_point"]},
                ]
            },
            "deleted": {"$ne": True},
        })
        out["reorder_suggestions"] = {"critical_count": int(critical)}
    except Exception:
        pass

    # ── Stocktake Report — last STOCK_IMPORT audit log entry ────────────
    # Stocktake doesn't store its own run history; the closest signal is
    # the audit log for the upload that generated it.
    try:
        latest_import = await db.audit_logs.find_one(
            {"action": "STOCK_IMPORT"},
            {"_id": 0, "timestamp": 1, "user_name": 1, "details": 1},
            sort=[("timestamp", -1)],
        )
        if latest_import:
            out["stocktake_report"] = {
                "last_at": latest_import.get("timestamp"),
                "by": latest_import.get("user_name") or "",
            }
    except Exception:
        pass

    return out

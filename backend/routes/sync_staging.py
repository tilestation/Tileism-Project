"""
Sync Staging Routes - Staging area for product sync data before applying to Supplier Products
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
from datetime import datetime, timezone
from bson import ObjectId
from pymongo import MongoClient
import logging
import os
import re
import sys

# Import unique naming function from business rules
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from business_config.business_rules import generate_unique_product_name, apply_unique_naming_to_product

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/sync-staging", tags=["Sync Staging"])


# ============================================================================
# CATEGORY EXTRACTION HELPER
# Extracts proper category from finish, product name, or validates existing category
# ============================================================================

def extract_proper_category(staged: dict) -> str:
    """
    Extract proper category from product data.
    
    Category should be one of:
    - Product type: Floor Tiles, Wall Tiles, Outdoor Tiles, etc.
    
    NOT finish types (Polished, Matt, Gloss) - those go in the 'finish' field!
    NOT the full product description or product line name!
    
    Args:
        staged: Product data from sync_staging
        
    Returns:
        Proper category string (e.g., "Wall Tiles", "Floor Tiles") or empty string
    """
    # Valid CATEGORY values - tile TYPES only, NOT finishes!
    VALID_CATEGORIES = {
        'wall tiles', 'floor tiles', 'outdoor tiles', 'indoor tiles',
        'wall-tiles', 'floor-tiles', 'outdoor-tiles', 'indoor-tiles',
        'porcelain', 'ceramic', 'mosaic', 'feature', 'decor', 'border',
        'wall', 'floor', 'outdoor', 'indoor'
    }
    
    # Category mapping for standardization
    CATEGORY_MAP = {
        'wall-tiles': 'Wall Tiles',
        'floor-tiles': 'Floor Tiles',
        'outdoor-tiles': 'Outdoor Tiles',
        'indoor-tiles': 'Indoor Tiles',
        'wall tiles': 'Wall Tiles',
        'floor tiles': 'Floor Tiles',
        'outdoor tiles': 'Outdoor Tiles',
        'indoor tiles': 'Indoor Tiles',
        'wall': 'Wall Tiles',
        'floor': 'Floor Tiles',
        'outdoor': 'Outdoor Tiles',
        'indoor': 'Indoor Tiles',
        'porcelain': 'Porcelain',
        'ceramic': 'Ceramic',
        'mosaic': 'Mosaic',
        'feature': 'Feature',
        'decor': 'Decor',
        'border': 'Border',
    }
    
    # FINISHES - These should NOT be categories!
    FINISH_WORDS = {
        'polished', 'matt', 'matte', 'gloss', 'glossy', 'lappato', 
        'satin', 'honed', 'natural', 'rustic', 'textured', 'anti-slip',
        'antislip', 'grip', 'structured', 'rectified', 'high-gloss'
    }
    
    existing_category = staged.get("category", "") or ""
    name = staged.get("name", "") or ""
    url = staged.get("url", "") or ""
    
    # First, check if existing category is valid
    if existing_category:
        cat_lower = existing_category.lower().strip()
        
        # REJECT if it's a finish word
        if cat_lower in FINISH_WORDS:
            existing_category = ""  # Invalid - it's a finish, not category
        # Check for valid category match
        elif cat_lower in VALID_CATEGORIES:
            return CATEGORY_MAP.get(cat_lower, existing_category.title())
        # If category is too long, has numbers, or too many words - it's probably a product line name
        elif len(existing_category) > 20 or any(char.isdigit() for char in existing_category) or len(existing_category.split()) > 2:
            existing_category = ""  # Invalid
    
    # Priority 1: Extract from URL (most reliable)
    url_lower = url.lower()
    if 'wall-tile' in url_lower or '/wall/' in url_lower:
        return 'Wall Tiles'
    if 'floor-tile' in url_lower or '/floor/' in url_lower:
        return 'Floor Tiles'
    if 'outdoor' in url_lower:
        return 'Outdoor Tiles'
    
    # Priority 2: Extract from product name (looking for tile type keywords only)
    name_lower = name.lower()
    
    # Look for specific tile type keywords
    if 'floor' in name_lower and 'tile' in name_lower:
        return 'Floor Tiles'
    if 'wall' in name_lower and 'tile' in name_lower:
        return 'Wall Tiles'
    if 'outdoor' in name_lower:
        return 'Outdoor Tiles'
    if 'mosaic' in name_lower:
        return 'Mosaic'
    
    # DO NOT extract finish keywords as categories!
    # If we get here and nothing matches, return empty string
    return ""


# ============================================================================
# CODE MISMATCH VALIDATION SYSTEM
# Prevents data corruption by detecting potential code/name mismatches
# ============================================================================

def validate_code_mappings(supplier: str = None) -> Dict[str, Any]:
    """
    Validate that all supplier product codes are correctly mapped.
    
    Checks for:
    1. Products where original_supplier_code != supplier_code (potential mismatch)
    2. Same code assigned to products with different names (code collision)
    3. Products with the same name having vastly different codes (naming issue)
    
    Returns validation results with warnings and alerts.
    """
    db = get_sync_db()
    
    query = {"supplier": supplier} if supplier else {}
    products = list(db.supplier_products.find(query))
    
    alerts = []
    warnings = []
    stats = {
        "total_checked": len(products),
        "code_mismatches": 0,
        "code_collisions": 0,
        "name_duplicates_with_different_codes": 0
    }
    
    # Check 1: original_supplier_code != supplier_code
    for product in products:
        orig_code = product.get("original_supplier_code")
        supplier_code = product.get("supplier_code")
        
        if orig_code and supplier_code and orig_code != supplier_code:
            stats["code_mismatches"] += 1
            alerts.append({
                "type": "code_mismatch",
                "severity": "HIGH",
                "product_name": product.get("name"),
                "sku": product.get("sku"),
                "original_supplier_code": orig_code,
                "supplier_code": supplier_code,
                "message": f"Code mismatch: original_supplier_code ({orig_code}) != supplier_code ({supplier_code})"
            })
    
    # Check 2: Same code assigned to multiple different product names
    code_to_names = {}
    for product in products:
        code = product.get("original_supplier_code") or product.get("supplier_code")
        name = product.get("name")
        if code and name:
            if code not in code_to_names:
                code_to_names[code] = set()
            code_to_names[code].add(name)
    
    for code, names in code_to_names.items():
        if len(names) > 1:
            # Allow some legitimate cases (size variants have same name)
            # Only flag if names are completely different
            name_list = list(names)
            if not all(n.split()[0:2] == name_list[0].split()[0:2] for n in name_list):
                stats["code_collisions"] += 1
                alerts.append({
                    "type": "code_collision",
                    "severity": "MEDIUM",
                    "code": code,
                    "names": list(names),
                    "message": f"Code {code} assigned to different product names: {', '.join(names)}"
                })
    
    # Check 3: Products with same name but different code patterns
    name_to_codes = {}
    for product in products:
        name = product.get("name")
        code = product.get("original_supplier_code") or product.get("supplier_code")
        if name and code:
            if name not in name_to_codes:
                name_to_codes[name] = set()
            name_to_codes[name].add(code)
    
    for name, codes in name_to_codes.items():
        if len(codes) > 1:
            # Check if codes follow same pattern (e.g., all start with P or all start with G)
            code_list = list(codes)
            prefixes = set(c[0] if c else '' for c in code_list)
            if len(prefixes) > 1:
                stats["name_duplicates_with_different_codes"] += 1
                warnings.append({
                    "type": "mixed_code_prefixes",
                    "severity": "LOW",
                    "name": name,
                    "codes": code_list,
                    "message": f"Product '{name}' has codes with different prefixes: {', '.join(code_list)}"
                })
    
    # Determine overall health status
    if stats["code_mismatches"] > 0:
        health = "CRITICAL"
    elif stats["code_collisions"] > 0:
        health = "WARNING"
    elif stats["name_duplicates_with_different_codes"] > 0:
        health = "INFO"
    else:
        health = "HEALTHY"
    
    return {
        "health": health,
        "stats": stats,
        "alerts": alerts,
        "warnings": warnings,
        "checked_at": datetime.now(timezone.utc).isoformat()
    }


def validate_incoming_sync(staged_products: List[Dict], supplier: str) -> List[Dict]:
    """
    Validate incoming sync data before it's applied.
    
    Checks for potential issues that could cause data corruption.
    Returns list of validation warnings to display to user.
    """
    db = get_sync_db()
    validation_warnings = []
    
    # Get existing products for this supplier
    existing_products = list(db.supplier_products.find({"supplier": {"$regex": f"^{supplier}$", "$options": "i"}}))
    
    # Build lookup maps
    code_to_product = {}
    name_to_codes = {}
    
    for p in existing_products:
        code = p.get("original_supplier_code") or p.get("supplier_code")
        name = p.get("name")
        if code:
            code_to_product[code] = p
        if name:
            if name not in name_to_codes:
                name_to_codes[name] = []
            name_to_codes[name].append(code)
    
    for staged in staged_products:
        incoming_code = staged.get("sku")
        incoming_name = staged.get("name")
        
        # Check 1: Is this code already assigned to a different product name?
        if incoming_code in code_to_product:
            existing_name = code_to_product[incoming_code].get("name")
            if existing_name and incoming_name and existing_name.lower() != incoming_name.lower():
                # Check if names are at least similar (first word matches)
                existing_first = existing_name.split()[0].lower() if existing_name else ""
                incoming_first = incoming_name.split()[0].lower() if incoming_name else ""
                
                if existing_first != incoming_first:
                    validation_warnings.append({
                        "type": "name_change_detected",
                        "severity": "HIGH",
                        "code": incoming_code,
                        "existing_name": existing_name,
                        "incoming_name": incoming_name,
                        "message": f"⚠️ Code {incoming_code} is assigned to '{existing_name}' but sync has '{incoming_name}'. Verify this is correct."
                    })
        
        # Check 2: Is this product name already in DB with a different code?
        if incoming_name and incoming_name in name_to_codes:
            existing_codes = name_to_codes[incoming_name]
            if existing_codes and incoming_code not in existing_codes:
                # Only warn if the existing codes have different prefix
                existing_prefixes = set(c[0] if c else '' for c in existing_codes)
                incoming_prefix = incoming_code[0] if incoming_code else ''
                
                if incoming_prefix and incoming_prefix not in existing_prefixes:
                    validation_warnings.append({
                        "type": "new_code_for_existing_name",
                        "severity": "MEDIUM",
                        "name": incoming_name,
                        "incoming_code": incoming_code,
                        "existing_codes": existing_codes,
                        "message": f"⚠️ Product '{incoming_name}' exists with codes {existing_codes}, but sync has new code {incoming_code}."
                    })
    
    return validation_warnings


_MATCH_FILLER = {"effect", "effects", "tiles", "tile"}

def _name_tokens(name: str) -> list:
    import re
    tokens = re.findall(r"[a-z0-9]+(?:x[0-9]+)?", (name or "").lower())
    return [t for t in tokens if t not in _MATCH_FILLER]

def _names_match(a: str, b: str) -> bool:
    """True when two product names clearly refer to the same product."""
    ta, tb = _name_tokens(a), _name_tokens(b)
    if not ta or not tb:
        return False
    if ta[0] != tb[0]:
        return False
    common = set(ta) & set(tb)
    return len(common) >= max(1, min(len(set(ta)), len(set(tb))) // 2)

# Database connection (sync for this router)
def get_sync_db():
    mongo_url = os.environ.get('MONGO_URL')
    if not mongo_url:
        raise ValueError("MONGO_URL environment variable is required")
    client = MongoClient(mongo_url)
    return client[os.environ.get('DB_NAME', 'tile_station')]


def calculate_list_price_from_cost(cost_price: float) -> float:
    """
    Calculate list price from cost price using business rules:
    List Price = Cost × 1.90 (markup) × 1.20 (VAT), rounded up to .99
    
    This is used for display purposes in the staging UI to show users
    what the actual list price will be after applying markup.
    """
    import math
    if cost_price is None or cost_price <= 0:
        return None
    raw_list_price = cost_price * 1.90 * 1.20
    list_price = math.ceil(raw_list_price) - 0.01
    if list_price < raw_list_price:
        list_price = math.ceil(raw_list_price + 1) - 0.01
    return round(list_price, 2)


# Pydantic Models
class StagedProduct(BaseModel):
    sku: str
    name: str
    supplier: str
    stock_quantity: Optional[float] = None
    stock_m2: Optional[float] = None
    price: Optional[float] = None
    cost_price: Optional[float] = None
    category: Optional[str] = None
    material: Optional[str] = None
    finish: Optional[str] = None
    size: Optional[str] = None
    image: Optional[str] = None
    description: Optional[str] = None
    in_stock: Optional[bool] = None
    is_new: bool = False
    sync_source: str = "browser_extension"
    synced_at: Optional[datetime] = None


class ApplyChangesRequest(BaseModel):
    product_ids: List[str] = []  # List of staging document IDs to apply. Empty = apply all


class IgnoreProductRequest(BaseModel):
    sku: str
    supplier: str
    reason: Optional[str] = None


# Helper function to check if product exists in supplier_products
def product_exists_in_supplier_products(sku: str, supplier: str, name: str = None) -> dict:
    """
    Check if product exists and return current data including _id for updates.
    
    DUAL MATCHING STRATEGY (for robustness):
    1. original_supplier_code - The code from website/extension (e.g., G30149, D10909)
    2. supplier_code - The spreadsheet code (e.g., P14461)
    3. name - The supplier product name
    4. sku - Our internal SKU
    
    This dual approach ensures matching works even if:
    - Supplier changes product names in the future
    - Different code formats between spreadsheet vs website
    """
    # Create case-insensitive regex pattern for supplier
    supplier_pattern = re.compile(f"^{re.escape(supplier)}$", re.IGNORECASE)
    
    # PRIORITY 1: Try original_supplier_code (website/extension URL code - most reliable for syncs)
    existing = get_sync_db().supplier_products.find_one({
        "original_supplier_code": sku,
        "supplier": supplier_pattern
    })
    
    if existing:
        logger.info(f"Matched by original_supplier_code: {sku} -> {existing.get('product_name')}")
        return existing
    
    # PRIORITY 2: Try supplier_code (spreadsheet code)
    existing = get_sync_db().supplier_products.find_one({
        "supplier_code": sku,
        "supplier": supplier_pattern
    })
    
    if existing:
        logger.info(f"Matched by supplier_code: {sku} -> {existing.get('product_name')}")
        return existing
    
    # PRIORITY 3: Try by sku field (our internal SKU)
    existing = get_sync_db().supplier_products.find_one({
        "sku": sku,
        "supplier": supplier_pattern
    })
    
    if existing:
        logger.info(f"Matched by sku: {sku} -> {existing.get('product_name')}")
        return existing
    
    # PRIORITY 4: Try matching by name field (supplier product name)
    # Use full name match first, then partial if needed
    if name:
        # Try exact name match first (case-insensitive)
        existing = get_sync_db().supplier_products.find_one({
            "name": {"$regex": f"^{re.escape(name)}$", "$options": "i"},
            "supplier": supplier_pattern
        })
        
        if existing:
            logger.info(f"Matched by exact name: {name} -> {existing.get('product_name')}")
            return existing
        
        # Try partial name match (first 30 chars for robustness)
        import re as re_module
        # Extract core product name (before size info)
        core_name_match = re_module.match(r'^([A-Za-z\s]+(?:Light|Dark|White|Grey|Black|Brown|Cream|Beige)?[A-Za-z\s]*)', name)
        if core_name_match:
            core_name = core_name_match.group(1).strip()[:30]
        else:
            core_name = name[:30]
        
        existing = get_sync_db().supplier_products.find_one({
            "name": {"$regex": f"^{re.escape(core_name)}", "$options": "i"},
            "supplier": supplier_pattern
        })
        
        if existing:
            logger.info(f"Matched by partial name: {core_name} -> {existing.get('product_name')}")
            return existing
    
    # PRIORITY 5: Try slug
    existing = get_sync_db().supplier_products.find_one({
        "slug": sku,
        "supplier": supplier_pattern
    })
    
    if existing:
        logger.info(f"Matched by slug: {sku} -> {existing.get('product_name')}")
        return existing
    
    logger.warning(f"No match found for SKU: {sku}, Name: {name}")
    return None


# Helper function to check if product is ignored
def is_product_ignored(sku: str, supplier: str) -> bool:
    """Check if product is in the ignored list"""
    ignored = get_sync_db().ignored_products.find_one({
        "sku": sku,
        "supplier": supplier
    })
    return ignored is not None


@router.get("/")
def get_all_staged_products():
    """Get all staged sync data grouped by supplier"""
    try:
        # Get all staged products
        staged = list(get_sync_db().sync_staging.find().sort("synced_at", -1))
        _mg = get_sync_db().settings.find_one({"_id": "margin_guard"}) or {}
        margin_floor = _mg.get("floor_percent", 30.0)
        
        # Group by supplier
        suppliers = {}
        for product in staged:
            supplier = product.get("supplier", "Unknown")
            if supplier not in suppliers:
                suppliers[supplier] = {
                    "updates": [],
                    "new_products": [],
                    "warnings": []
                }
            
            # Check if this is a new product or an update - pass name for matching
            existing = product_exists_in_supplier_products(product.get("sku"), supplier, product.get("name"))
            
            # Extract proper category (converts "wall-tiles" to "Wall Tiles", etc.)
            proper_category = extract_proper_category(product)
            
            product_data = {
                "id": str(product["_id"]),
                "sku": product.get("sku"),
                "name": product.get("name"),
                "supplier": supplier,
                "stock_quantity": product.get("stock_quantity"),
                "stock_m2": product.get("stock_m2"),
                "price": product.get("price"),
                "cost_price": product.get("cost_price"),
                "category": proper_category,  # Use processed category
                "material": product.get("material"),
                "finish": product.get("finish"),
                "size": product.get("size"),
                "image": product.get("image"),
                "in_stock": product.get("in_stock"),
                "sync_source": product.get("sync_source"),
                "synced_at": product.get("synced_at").isoformat() if product.get("synced_at") else None,
                "has_stock": product.get("stock_quantity") is not None or product.get("stock_m2") is not None,
                "has_price": product.get("price") is not None,
                "can_apply": product.get("stock_quantity") is not None or product.get("stock_m2") is not None  # Stock is mandatory
            }
            
            if existing:
                # This is an update - add comparison data
                product_data["is_update"] = True
                product_data["matched_product_id"] = existing.get("_id_str")  # Store matched product ID for apply
                # Handle different field names: stock_quantity, stock_m2, stock_sqm
                product_data["current_stock"] = existing.get("stock_quantity") or existing.get("stock_m2") or existing.get("stock_sqm")
                # Handle different price fields: price, room_lot_price
                product_data["current_price"] = existing.get("price") or existing.get("room_lot_price")
                product_data["stock_change"] = None
                product_data["price_change"] = None
                
                # Calculate stock change
                new_stock = product.get("stock_quantity") or product.get("stock_m2")
                old_stock = existing.get("stock_quantity") or existing.get("stock_m2") or existing.get("stock_sqm")
                if new_stock is not None and old_stock is not None:
                    product_data["stock_change"] = new_stock - old_stock
                
                # COST-ONLY PRICING: syncs track the supplier COST only.
                # The list price is admin-managed and NEVER changed by a sync.
                # current_price/price/price_change now carry COST values so the
                # UI (table, stats, exports) shows cost transitions.
                price_locked = existing.get("price_locked", False)
                product_data["price_locked"] = price_locked
                
                raw_synced_price = product.get("price")
                raw_cost_price = product.get("cost_price")
                new_cost = raw_cost_price if raw_cost_price is not None else raw_synced_price
                old_cost = existing.get("cost_price") if existing.get("cost_price") is not None else existing.get("cost_price_m2")
                
                product_data["current_cost"] = old_cost
                product_data["new_cost"] = new_cost
                product_data["cost_price"] = new_cost
                product_data["current_price"] = old_cost
                product_data["price"] = new_cost
                product_data["has_price"] = new_cost is not None
                product_data["list_price"] = existing.get("price") or existing.get("room_lot_price")
                if new_cost is not None and old_cost is not None:
                    product_data["cost_change"] = round(float(new_cost) - float(old_cost), 2)
                else:
                    product_data["cost_change"] = None
                product_data["price_change"] = product_data["cost_change"]
                
                suppliers[supplier]["updates"].append(product_data)
            else:
                # This is a new product
                product_data["is_update"] = False
                suppliers[supplier]["new_products"].append(product_data)
        
        # Check for duplicates and add warnings
        for supplier, data in suppliers.items():
            sku_counts = {}
            for item in data["updates"] + data["new_products"]:
                sku = item["sku"]
                sku_counts[sku] = sku_counts.get(sku, 0) + 1
            
            duplicates = [sku for sku, count in sku_counts.items() if count > 1 and sku is not None]
            if duplicates:
                data["warnings"].append({
                    "type": "duplicate",
                    "message": f"Duplicate sync detected for SKUs: {', '.join(str(s) for s in duplicates)}",
                    "skus": duplicates
                })
            
            # Check for missing stock data
            missing_stock = [item["sku"] for item in data["updates"] if not item["has_stock"] and item["sku"] is not None]
            if missing_stock:
                data["warnings"].append({
                    "type": "missing_stock",
                    "message": f"Missing stock data for {len(missing_stock)} products - these cannot be applied",
                    "skus": missing_stock
                })
            
            # NEW: Run code mismatch validation on incoming sync data
            staged_for_supplier = [p for p in staged if p.get("supplier") == supplier]
            validation_warnings = validate_incoming_sync(staged_for_supplier, supplier)
            
            # Filter out dismissed warnings
            dismissed_codes = set()
            try:
                dismissed_docs = list(get_sync_db().dismissed_warnings.find({"supplier": supplier}, {"code": 1}))
                dismissed_codes = set(d["code"] for d in dismissed_docs if d.get("code"))
            except Exception:
                pass
            
            for vw in validation_warnings:
                warning_code = vw.get("code") or vw.get("incoming_code", "")
                if warning_code in dismissed_codes:
                    continue
                data["warnings"].append({
                    "type": vw["type"],
                    "severity": vw["severity"],
                    "message": vw["message"],
                    "details": vw
                })
        
        return {
            "suppliers": suppliers,
            "total_staged": len(staged)
        }
    except Exception as e:
        logger.error(f"Error fetching staged products: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/stats")
def get_staging_stats():
    """Get counts per supplier for the staging area"""
    try:
        pipeline = [
            {
                "$group": {
                    "_id": "$supplier",
                    "count": {"$sum": 1},
                    "last_sync": {"$max": "$synced_at"}
                }
            }
        ]
        
        stats = list(get_sync_db().sync_staging.aggregate(pipeline))
        
        result = {}
        total = 0
        for stat in stats:
            supplier = stat["_id"] or "Unknown"
            result[supplier] = {
                "count": stat["count"],
                "last_sync": stat["last_sync"].isoformat() if stat["last_sync"] else None
            }
            total += stat["count"]
        
        return {
            "suppliers": result,
            "total": total
        }
    except Exception as e:
        logger.error(f"Error fetching staging stats: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/ignored")
def get_ignored_products(supplier: Optional[str] = None):
    """Get list of all ignored products"""
    try:
        query = {}
        if supplier:
            query["supplier"] = supplier
        
        ignored = list(get_sync_db().ignored_products.find(query, {"_id": 0}))
        
        # Convert datetime to string
        for item in ignored:
            if item.get("ignored_at"):
                item["ignored_at"] = item["ignored_at"].isoformat()
        
        return {
            "ignored_products": ignored,
            "total": len(ignored)
        }
    except Exception as e:
        logger.error(f"Error fetching ignored products: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{supplier}")
def get_staged_by_supplier(supplier: str):
    """Get staged sync data for a specific supplier"""
    try:
        db = get_sync_db()
        staged = list(db.sync_staging.find({"supplier": supplier}).sort("synced_at", -1))
        _mg = db.settings.find_one({"_id": "margin_guard"}) or {}
        margin_floor = _mg.get("floor_percent", 30.0)
        
        updates = []
        new_products = []
        warnings = []
        
        sku_counts = {}
        
        # OPTIMIZATION: Load all existing products for this supplier upfront
        # This avoids N+1 queries (one query instead of 4-5 per staged product)
        existing_products = list(db.supplier_products.find(
            {"supplier": {"$regex": f"^{supplier}$", "$options": "i"}}
        ))
        
        # Build lookup indexes for fast matching
        by_original_code = {}
        by_supplier_code = {}
        by_sku = {}
        by_name = {}
        
        for p in existing_products:
            if p.get("original_supplier_code"):
                by_original_code[p["original_supplier_code"]] = p
            if p.get("supplier_code"):
                by_supplier_code[p["supplier_code"]] = p
            if p.get("sku"):
                by_sku[p["sku"]] = p
            if p.get("name"):
                by_name[p["name"].lower()] = p
        
        def find_existing_fast(sku, name):
            """Fast lookup using pre-built indexes"""
            if sku:
                if sku in by_original_code:
                    return by_original_code[sku]
                if sku in by_supplier_code:
                    return by_supplier_code[sku]
                if sku in by_sku:
                    return by_sku[sku]
            if name:
                name_lower = name.lower()
                if name_lower in by_name:
                    return by_name[name_lower]
            return None
        
        for product in staged:
            sku = product.get("sku")
            sku_counts[sku] = sku_counts.get(sku, 0) + 1
            
            # Use fast lookup instead of slow per-product queries
            existing = find_existing_fast(sku, product.get("name"))
            
            # Extract proper category (converts "wall-tiles" to "Wall Tiles", etc.)
            proper_category = extract_proper_category(product)
            
            product_data = {
                "id": str(product["_id"]),
                "sku": sku,
                "name": product.get("name"),
                "supplier": supplier,
                "stock_quantity": product.get("stock_quantity"),
                "stock_m2": product.get("stock_m2"),
                "price": product.get("price"),
                "cost_price": product.get("cost_price"),
                "category": proper_category,  # Use processed category
                "material": product.get("material"),
                "finish": product.get("finish"),
                "size": product.get("size"),
                "image": product.get("image"),
                "description": product.get("description"),
                "in_stock": product.get("in_stock"),
                "sync_source": product.get("sync_source"),
                "synced_at": product.get("synced_at").isoformat() if product.get("synced_at") else None,
                "has_stock": product.get("stock_quantity") is not None or product.get("stock_m2") is not None,
                "has_price": product.get("price") is not None,
                "can_apply": product.get("stock_quantity") is not None or product.get("stock_m2") is not None
            }
            
            if existing:
                product_data["is_update"] = True
                product_data["matched_product_id"] = existing.get("_id_str")  # Store matched product ID
                # Light syncs don't pull images — show the existing product's photo instead of a blank
                if not product_data["image"]:
                    existing_imgs = existing.get("images") or []
                    product_data["image"] = existing.get("image") or (existing_imgs[0] if existing_imgs else None)
                # Handle different field names: stock_quantity, stock_m2, stock_sqm
                product_data["current_stock"] = existing.get("stock_quantity") or existing.get("stock_m2") or existing.get("stock_sqm")
                # Handle different price fields: price, room_lot_price
                product_data["current_price"] = existing.get("price") or existing.get("room_lot_price")
                
                new_stock = product.get("stock_quantity") or product.get("stock_m2")
                old_stock = existing.get("stock_quantity") or existing.get("stock_m2") or existing.get("stock_sqm")
                if new_stock is not None and old_stock is not None:
                    product_data["stock_change"] = new_stock - old_stock
                else:
                    product_data["stock_change"] = None
                
                # COST-ONLY PRICING: syncs track the supplier COST only.
                # The list price is admin-managed and NEVER changed by a sync.
                price_locked = existing.get("price_locked", False)
                product_data["price_locked"] = price_locked
                
                raw_synced_price = product.get("price")
                raw_cost_price = product.get("cost_price")
                new_cost = raw_cost_price if raw_cost_price is not None else raw_synced_price
                old_cost = existing.get("cost_price") if existing.get("cost_price") is not None else existing.get("cost_price_m2")
                
                product_data["current_cost"] = old_cost
                product_data["new_cost"] = new_cost
                product_data["cost_price"] = new_cost
                product_data["current_price"] = old_cost
                product_data["price"] = new_cost
                product_data["has_price"] = new_cost is not None
                product_data["list_price"] = existing.get("price") or existing.get("room_lot_price")
                if new_cost is not None and old_cost is not None:
                    product_data["cost_change"] = round(float(new_cost) - float(old_cost), 2)
                else:
                    product_data["cost_change"] = None
                product_data["price_change"] = product_data["cost_change"]
                
                # MARGIN GUARD: warn when the new cost pushes the ex-VAT margin
                # (based on the admin's current list price) below the floor
                _lp = product_data["list_price"]
                if _lp and new_cost is not None and float(_lp) > 0:
                    _net = float(_lp) / 1.2
                    _margin = round((_net - float(new_cost)) / _net * 100, 1) if _net > 0 else None
                    product_data["margin_after_percent"] = _margin
                    product_data["margin_alert"] = _margin is not None and _margin < margin_floor
                else:
                    product_data["margin_after_percent"] = None
                    product_data["margin_alert"] = False
                
                updates.append(product_data)
            else:
                product_data["is_update"] = False
                new_products.append(product_data)
        
        # Check for duplicates
        duplicates = [sku for sku, count in sku_counts.items() if count > 1 and sku is not None]
        if duplicates:
            warnings.append({
                "type": "duplicate",
                "message": f"Duplicate sync detected for SKUs: {', '.join(str(s) for s in duplicates)}",
                "skus": duplicates
            })
        
        # Check for missing stock
        missing_stock = [item["sku"] for item in updates if not item["has_stock"] and item["sku"] is not None]
        if missing_stock:
            warnings.append({
                "type": "missing_stock",
                "message": f"Missing stock data for {len(missing_stock)} products - these cannot be applied",
                "skus": missing_stock
            })
        
        # NEW: Run code mismatch validation on incoming sync data
        validation_warnings = validate_incoming_sync(staged, supplier)

        # Filter out dismissed warnings
        dismissed_codes = set()
        try:
            dismissed_docs = list(db.dismissed_warnings.find({"supplier": supplier}, {"code": 1}))
            dismissed_codes = set(d["code"] for d in dismissed_docs if d.get("code"))
        except Exception:
            pass

        for vw in validation_warnings:
            warning_code = vw.get("code") or vw.get("incoming_code", "")
            if warning_code and warning_code in dismissed_codes:
                continue
            warnings.append({
                "type": vw["type"],
                "severity": vw["severity"],
                "message": vw["message"],
                "details": vw
            })
        
        # Check if can apply all (all updates must have stock)
        can_apply_all = all(item["can_apply"] for item in updates) if updates else False
        
        return {
            "supplier": supplier,
            "updates": updates,
            "new_products": new_products,
            "warnings": warnings,
            "can_apply_all": can_apply_all,
            "total_updates": len(updates),
            "total_new": len(new_products)
        }
    except Exception as e:
        logger.error(f"Error fetching staged products for {supplier}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{supplier}/apply")
def apply_supplier_changes(supplier: str, request: Optional[ApplyChangesRequest] = None):
    """Apply all staged changes for a supplier to supplier_products"""
    try:
        # Get all staged updates for this supplier (only updates, not new products)
        if request and request.product_ids:
            # Apply specific products
            staged = list(get_sync_db().sync_staging.find({
                "_id": {"$in": [ObjectId(pid) for pid in request.product_ids]},
                "supplier": supplier
            }))
        else:
            # Apply all updates for supplier (only existing products)
            staged = list(get_sync_db().sync_staging.find({"supplier": supplier}))
        
        applied = 0
        skipped = 0
        errors = []
        
        for product in staged:
            sku = product.get("sku")
            name = product.get("name")
            
            # Check if this is an existing product (update) - use name matching
            existing = product_exists_in_supplier_products(sku, supplier, name)
            if not existing:
                # Skip new products - they need to be added explicitly
                skipped += 1
                continue
            
            # Check if has stock data (mandatory)
            has_stock = product.get("stock_quantity") is not None or product.get("stock_m2") is not None
            if not has_stock:
                errors.append(f"SKU {sku}: Missing stock data")
                skipped += 1
                continue
            
            # Build update data
            update_data = {
                "last_synced": datetime.now(timezone.utc),
                "sync_source": product.get("sync_source", "sync_staging")
            }
            
            # IMPORTANT: Store original_supplier_code if not already set
            # This is the code from the extension/website URL (e.g., G30149, D10909)
            # Used for future matching to avoid mismatches
            if sku and not existing.get("original_supplier_code"):
                update_data["original_supplier_code"] = sku
            
            # Persist the supplier portal URL — light syncs need it after staging is cleared
            if product.get("url"):
                update_data["url"] = product.get("url")
            
            # Update stock - store BOTH stock_quantity and stock_m2
            if product.get("stock_quantity") is not None:
                update_data["stock_quantity"] = product.get("stock_quantity")
            if product.get("stock_m2") is not None:
                update_data["stock_m2"] = product.get("stock_m2")
            
            # Update in_stock status - check both stock values
            stock_qty = product.get("stock_quantity") or 0
            stock_m2 = product.get("stock_m2") or 0
            update_data["in_stock"] = stock_qty > 0 or stock_m2 > 0
            
            # COST-ONLY PRICING: syncs update the supplier COST only.
            # The admin's list price is NEVER touched by a sync — the admin
            # sets it manually. Cost changes are recorded in last_cost_change
            # and cost_change_history so the admin always knows.
            raw_cost_price = product.get("cost_price")
            synced_price = product.get("price")
            new_cost = raw_cost_price if raw_cost_price is not None else synced_price
            
            if new_cost is not None:
                old_cost = existing.get("cost_price") if existing.get("cost_price") is not None else existing.get("cost_price_m2")
                update_data["cost_price"] = new_cost
                update_data["cost_price_m2"] = new_cost
                if old_cost is not None and round(float(old_cost), 2) != round(float(new_cost), 2):
                    change_entry = {
                        "from": round(float(old_cost), 2),
                        "to": round(float(new_cost), 2),
                        "changed_at": datetime.now(timezone.utc).isoformat(),
                        "source": product.get("sync_source", "sync"),
                    }
                    update_data["last_cost_change"] = change_entry
                    try:
                        get_sync_db().supplier_products.update_one(
                            {"_id": existing.get("_id")},
                            {"$push": {"cost_change_history": {"$each": [change_entry], "$slice": -20}}}
                        )
                    except Exception:
                        pass
            
            # CRITICAL: Update image if available from sync
            # This ensures product images from the extension sync are saved
            if product.get("image"):
                update_data["image"] = product.get("image")
                # Also update images array for frontend display
                update_data["images"] = [product.get("image")]
                logger.info(f"Updating image for {name}: {product.get('image')}")
            
            # Apply update using the matched product's _id (most reliable)
            try:
                result = None
                matched_id = existing.get("_id")
                
                if matched_id:
                    # Use the _id from the matched product (most reliable)
                    result = get_sync_db().supplier_products.update_one(
                        {"_id": matched_id},
                        {"$set": update_data}
                    )
                
                if result and result.matched_count > 0:
                    # Remove from staging
                    get_sync_db().sync_staging.delete_one({"_id": product["_id"]})
                    applied += 1
                    logger.info(f"Applied update to {name} (matched by _id: {matched_id})")
                else:
                    errors.append(f"{name}: No matching product found")
                    skipped += 1
            except Exception as e:
                errors.append(f"{name}: {str(e)}")
        
        # Log the apply action
        get_sync_db().sync_logs.insert_one({
            "action": "apply_staging",
            "supplier": supplier,
            "timestamp": datetime.now(timezone.utc),
            "applied": applied,
            "skipped": skipped,
            "errors": errors
        })
        
        return {
            "success": True,
            "applied": applied,
            "skipped": skipped,
            "errors": errors,
            "message": f"Applied {applied} updates to {supplier} products"
        }
    except Exception as e:
        logger.error(f"Error applying changes for {supplier}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


class AddNewProductRequest(BaseModel):
    is_clearance: bool = False



@router.put("/{staging_id}/update-stock")
def update_staged_product_stock(staging_id: str, data: dict):
    """
    Update stock data for a staged product.
    Allows users to add/edit stock before adding product to database.
    """
    try:
        db = get_sync_db()
        
        # Validate staging_id
        try:
            obj_id = ObjectId(staging_id)
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid staging ID")
        
        # Find the staged product
        staged = db.sync_staging.find_one({"_id": obj_id})
        if not staged:
            raise HTTPException(status_code=404, detail="Staged product not found")
        
        # Get stock values
        stock_m2 = data.get("stock_m2")
        stock_quantity = data.get("stock_quantity")
        
        # Build update
        update_fields = {"last_updated": datetime.now(timezone.utc)}
        
        if stock_m2 is not None:
            update_fields["stock_m2"] = float(stock_m2) if stock_m2 else None
        if stock_quantity is not None:
            update_fields["stock_quantity"] = int(stock_quantity) if stock_quantity else None
        
        # Calculate has_stock flag
        has_stock = (update_fields.get("stock_m2") or staged.get("stock_m2")) is not None or \
                    (update_fields.get("stock_quantity") or staged.get("stock_quantity")) is not None
        update_fields["has_stock"] = has_stock
        
        # Update the staged product
        result = db.sync_staging.update_one(
            {"_id": obj_id},
            {"$set": update_fields}
        )
        
        if result.modified_count == 0:
            raise HTTPException(status_code=400, detail="No changes made")
        
        logger.info(f"Updated stock for staged product {staged.get('sku')}: m2={stock_m2}, qty={stock_quantity}")
        
        return {
            "success": True,
            "message": f"Stock updated for {staged.get('sku')}",
            "sku": staged.get("sku"),
            "stock_m2": update_fields.get("stock_m2"),
            "stock_quantity": update_fields.get("stock_quantity"),
            "has_stock": has_stock
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating stock: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{supplier}/add-new-product/{staging_id}")
def add_new_product_to_database(supplier: str, staging_id: str, request: Optional[AddNewProductRequest] = None):
    """Add a new product from staging to supplier_products
    
    Args:
        is_clearance: If True, product is marked as clearance. If False, marked as new_collection.
    """
    try:
        # Get the staged product
        staged = get_sync_db().sync_staging.find_one({"_id": ObjectId(staging_id)})
        if not staged:
            raise HTTPException(status_code=404, detail="Staged product not found")
        
        # Check if has stock (mandatory)
        has_stock = staged.get("stock_quantity") is not None or staged.get("stock_m2") is not None
        if not has_stock:
            raise HTTPException(status_code=400, detail="Cannot add product without stock data")
        
        sku = staged.get("sku")
        
        # Check if already exists
        existing = product_exists_in_supplier_products(sku, supplier)
        if existing:
            raise HTTPException(status_code=400, detail=f"Product {sku} already exists in supplier products")
        
        # Determine product type based on is_clearance flag
        is_clearance = request.is_clearance if request else False
        product_type = "clearance" if is_clearance else "new_collection"
        
        # Build product data
        product_data = {
            "sku": sku,
            "name": staged.get("name"),
            "original_name": staged.get("name"),  # Keep original supplier name
            "original_supplier_code": sku,  # Store the website/URL code for future sync matching
            "supplier": supplier,
            "stock_quantity": staged.get("stock_quantity"),
            "stock_m2": staged.get("stock_m2"),
            "price": staged.get("price"),
            "cost_price": staged.get("cost_price"),
            "category": staged.get("category"),
            "material": staged.get("material"),
            "finish": staged.get("finish"),
            "size": staged.get("size"),
            "image": staged.get("image"),
            "images": [staged.get("image")] if staged.get("image") else [],  # Also store in images array
            "description": staged.get("description"),
            "in_stock": (staged.get("stock_quantity") or staged.get("stock_m2") or 0) > 0,
            "in_products_db": True,  # Now adding to main products DB too
            "product_type": product_type,  # "clearance" or "new_collection"
            "created_at": datetime.now(timezone.utc),
            "last_synced": datetime.now(timezone.utc),
            "sync_source": staged.get("sync_source", "sync_staging")
        }
        
        # Apply unique naming - generates unique product_name and checks for duplicates
        product_data = apply_unique_naming_to_product(product_data, get_sync_db())
        
        # Upsert into supplier_products (prevents duplicates)
        get_sync_db().supplier_products.update_one(
            {"sku": sku, "supplier": supplier},
            {"$set": product_data},
            upsert=True
        )
        
        # ALSO add to main products collection (EPOS database)
        main_product_data = {
            "sku": sku,
            "name": product_data.get("product_name") or product_data.get("name"),
            "supplier": supplier,
            "supplier_product_name": product_data.get("name"),  # Original supplier name for SEO
            "category_name": product_data.get("category"),
            "description": product_data.get("description", ""),
            "material": product_data.get("material"),
            "finish": product_data.get("finish"),
            "cost": product_data.get("cost_price"),
            "price": product_data.get("price"),
            "stock": product_data.get("stock_quantity", 0),
            "m2_quantity": product_data.get("stock_m2", 0),
            "images": product_data.get("images", []),
            "in_stock": product_data.get("in_stock", True),
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc),
            "source": "sync_staging_single_add"
        }
        
        if not main_product_data["images"] and product_data.get("image"):
            main_product_data["images"] = [product_data.get("image")]
        
        result = get_sync_db().products.update_one(
            {"sku": sku},
            {"$set": main_product_data},
            upsert=True
        )
        
        # Get product_id and update supplier_products
        if result.upserted_id:
            products_db_id = str(result.upserted_id)
        else:
            existing = get_sync_db().products.find_one({"sku": sku}, {"_id": 1})
            products_db_id = str(existing["_id"]) if existing else None
        
        get_sync_db().supplier_products.update_one(
            {"sku": sku, "supplier": supplier},
            {"$set": {"products_db_id": products_db_id}}
        )
        
        # Remove from staging
        get_sync_db().sync_staging.delete_one({"_id": ObjectId(staging_id)})
        
        return {
            "success": True,
            "message": f"Product {sku} added to database as {product_type}",
            "sku": sku,
            "product_type": product_type,
            "in_products_db": True
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error adding new product: {e}")
        raise HTTPException(status_code=500, detail=str(e))


class BulkAddRequest(BaseModel):
    is_clearance: bool = False
    apply_price_rules: bool = True  # Apply markup + VAT rules


# ============================================================================
# BULK ADD BACKGROUND TASK - Runs even when user switches tabs
# ============================================================================

def run_bulk_add_background(supplier: str, is_clearance: bool, apply_price_rules: bool):
    """
    Background task to add all new products from staging to supplier_products.
    This runs independently of the frontend connection and tracks progress in DB.
    """
    import math
    import threading
    
    # Get a fresh database connection for this thread
    mongo_url = os.environ.get('MONGO_URL')
    db_name = os.environ.get('DB_NAME', 'tile_station')
    client = MongoClient(mongo_url)
    db = client[db_name]
    
    try:
        product_type = "clearance" if is_clearance else "new_collection"
        
        # Get all staged products for this supplier
        staged_products = list(db.sync_staging.find({"supplier": supplier}))
        total = len(staged_products)
        
        # Update progress: started
        db.bulk_add_progress.update_one(
            {"supplier": supplier},
            {"$set": {
                "status": "running",
                "total": total,
                "processed": 0,
                "added": 0,
                "skipped": 0,
                "errors": [],
                "started_at": datetime.now(timezone.utc),
                "last_updated": datetime.now(timezone.utc)
            }},
            upsert=True
        )
        
        added = 0
        skipped = 0
        errors = []
        
        for idx, staged in enumerate(staged_products):
            # Check if stop was requested
            if idx % 5 == 0:
                stop_check = db.bulk_add_progress.find_one({"supplier": supplier}, {"status": 1})
                if stop_check and stop_check.get("status") == "stopped":
                    logger.info(f"Bulk add stopped by user at {idx}/{total}")
                    break
            
            sku = staged.get("sku")
            name = staged.get("name")
            
            # Check if has stock (mandatory) - server-side syncs may have 0 stock which is valid
            has_stock = staged.get("stock_quantity") is not None or staged.get("stock_m2") is not None
            if not has_stock and staged.get("sync_source") in ("deep_full_sync", "server_side_deep_sync", "light_sync"):
                has_stock = True
                staged["stock_m2"] = 0
                staged["stock_quantity"] = 0
            if not has_stock:
                errors.append(f"SKU {sku}: Missing stock data")
                skipped += 1
                # Update progress
                db.bulk_add_progress.update_one(
                    {"supplier": supplier},
                    {"$set": {
                        "processed": idx + 1,
                        "added": added,
                        "skipped": skipped,
                        "last_updated": datetime.now(timezone.utc)
                    }}
                )
                continue
            
            # Check if already exists in supplier_products (prevent duplicates)
            existing = db.supplier_products.find_one({"sku": sku, "supplier": supplier})
            if existing:
                # Already added - just remove from staging if still there
                db.sync_staging.delete_one({"_id": staged["_id"]})
                skipped += 1
                # Update progress
                db.bulk_add_progress.update_one(
                    {"supplier": supplier},
                    {"$set": {
                        "processed": idx + 1,
                        "added": added,
                        "skipped": skipped,
                        "last_updated": datetime.now(timezone.utc)
                    }}
                )
                continue
            
            # Get prices from staging
            cost_price = staged.get("cost_price") or staged.get("price")
            staged_price = staged.get("price")
            
            # Determine if price markup was already applied
            price_already_calculated = False
            if cost_price and staged_price and staged_price > cost_price * 1.5:
                price_already_calculated = True
                list_price = staged_price
            elif cost_price and apply_price_rules and not price_already_calculated:
                # Apply price rules: Cost × 1.90 × 1.20, rounded to .99
                raw_list_price = cost_price * 1.90 * 1.20
                list_price = math.ceil(raw_list_price) - 0.01
                if list_price < raw_list_price:
                    list_price = math.ceil(raw_list_price + 1) - 0.01
                list_price = round(list_price, 2)
            else:
                list_price = staged_price
            
            # Build product data
            product_data = {
                "sku": sku,
                "name": name,
                "original_name": name,
                "original_supplier_code": sku,
                "supplier": supplier,
                "stock_quantity": staged.get("stock_quantity"),
                "stock_m2": staged.get("stock_m2"),
                "cost_price": cost_price,
                "cost_price_m2": cost_price,
                "price": list_price if list_price else cost_price,
                "list_price": list_price,
                "category": extract_proper_category(staged),  # Use helper to extract proper category
                "material": staged.get("material"),
                "finish": staged.get("finish"),
                "size": staged.get("size"),
                "image": staged.get("image"),
                "images": staged.get("images") or ([staged.get("image")] if staged.get("image") else []),
                "description": staged.get("description"),
                "url": staged.get("url"),
                "in_stock": (staged.get("stock_quantity") or staged.get("stock_m2") or 0) > 0,
                "in_products_db": True,  # Will be added to main products DB
                "product_type": product_type,
                "has_complete_data": staged.get("has_complete_data", True),
                "created_at": datetime.now(timezone.utc),
                "last_synced": datetime.now(timezone.utc),
                "sync_source": staged.get("sync_source", "deep_full_sync")
            }
            
            # Apply unique naming
            try:
                product_data = apply_unique_naming_to_product(product_data, db)
            except Exception as naming_err:
                logger.warning(f"Naming error for {sku}: {naming_err}")
                # Continue with original name if naming fails
            
            try:
                # Check if existing product has locked name/price
                existing_for_lock = db.supplier_products.find_one(
                    {"sku": sku, "supplier": supplier},
                    {"name_locked": 1, "price_locked": 1, "product_name": 1, "price": 1, "cost_price": 1}
                )
                if existing_for_lock:
                    if existing_for_lock.get("name_locked"):
                        # Keep existing admin-set name
                        product_data["name"] = existing_for_lock.get("product_name") or product_data["name"]
                        product_data["name_locked"] = True
                    if existing_for_lock.get("price_locked"):
                        # Keep existing admin-set price
                        product_data["price"] = existing_for_lock.get("price") or product_data.get("price")
                        product_data["cost_price"] = existing_for_lock.get("cost_price") or product_data.get("cost_price")
                        product_data["price_locked"] = True
                
                # Upsert into supplier_products
                db.supplier_products.update_one(
                    {"sku": sku, "supplier": supplier},
                    {"$set": product_data},
                    upsert=True
                )
                
                # ALSO add to main products collection (EPOS database)
                # This makes products immediately available and shows green tick
                main_product_data = {
                    "sku": sku,
                    "name": product_data.get("product_name") or product_data.get("name"),
                    "supplier": supplier,
                    "supplier_product_name": product_data.get("name"),  # Original supplier name for SEO
                    "category_name": product_data.get("category"),
                    "description": product_data.get("description", ""),
                    "material": product_data.get("material"),
                    "finish": product_data.get("finish"),
                    "cost": product_data.get("cost_price"),
                    "price": product_data.get("price"),
                    "stock": product_data.get("stock_quantity", 0),
                    "m2_quantity": product_data.get("stock_m2", 0),
                    "tile_width": product_data.get("length_mm"),
                    "tile_height": product_data.get("width_mm"),
                    "images": product_data.get("images", []),
                    "in_stock": product_data.get("in_stock", (product_data.get("stock_quantity") or product_data.get("stock_m2") or 0) > 0),
                    "created_at": datetime.now(timezone.utc),
                    "updated_at": datetime.now(timezone.utc),
                    "source": "sync_staging_bulk_add"
                }
                
                # Add single image if images array is empty but image exists
                if not main_product_data["images"] and product_data.get("image"):
                    main_product_data["images"] = [product_data.get("image")]
                
                # Upsert into main products collection
                result = db.products.update_one(
                    {"sku": sku},
                    {"$set": main_product_data},
                    upsert=True
                )
                
                # Get the product_id and update supplier_products to mark as in_products_db
                if result.upserted_id:
                    products_db_id = str(result.upserted_id)
                else:
                    existing = db.products.find_one({"sku": sku}, {"_id": 1})
                    products_db_id = str(existing["_id"]) if existing else None
                
                # Update supplier_products to show green tick
                db.supplier_products.update_one(
                    {"sku": sku, "supplier": supplier},
                    {"$set": {
                        "in_products_db": True,
                        "products_db_id": products_db_id
                    }}
                )
                
                # Remove from staging
                db.sync_staging.delete_one({"_id": staged["_id"]})
                added += 1
                
            except Exception as e:
                errors.append(f"{sku}: {str(e)}")
            
            # Update progress every 5 products or on last
            if (idx + 1) % 5 == 0 or idx == total - 1:
                db.bulk_add_progress.update_one(
                    {"supplier": supplier},
                    {"$set": {
                        "processed": idx + 1,
                        "added": added,
                        "skipped": skipped,
                        "errors": errors[:20],
                        "last_updated": datetime.now(timezone.utc)
                    }}
                )
        
        # Mark as complete
        db.bulk_add_progress.update_one(
            {"supplier": supplier},
            {"$set": {
                "status": "complete",
                "processed": total,
                "added": added,
                "skipped": skipped,
                "errors": errors[:20],
                "completed_at": datetime.now(timezone.utc),
                "last_updated": datetime.now(timezone.utc)
            }}
        )
        
        # Log the action
        db.sync_logs.insert_one({
            "action": "bulk_add_new_products_background",
            "supplier": supplier,
            "timestamp": datetime.now(timezone.utc),
            "added": added,
            "skipped": skipped,
            "product_type": product_type,
            "apply_price_rules": apply_price_rules,
            "errors": errors[:20]
        })
        
    except Exception as e:
        logger.error(f"Error in background bulk add for {supplier}: {e}")
        db.bulk_add_progress.update_one(
            {"supplier": supplier},
            {"$set": {
                "status": "error",
                "error_message": str(e),
                "last_updated": datetime.now(timezone.utc)
            }}
        )
    finally:
        client.close()


@router.post("/{supplier}/start-bulk-add")
def start_bulk_add_to_database(supplier: str, request: Optional[BulkAddRequest] = None):
    """
    Start adding ALL new products from staging to supplier_products as a background task.
    This runs independently and continues even if user switches tabs.
    
    Returns immediately with task status. Use /bulk-add-progress to check progress.
    """
    import threading
    
    try:
        is_clearance = request.is_clearance if request else False
        apply_price_rules = request.apply_price_rules if request else True
        
        # Check if already running
        progress = get_sync_db().bulk_add_progress.find_one({"supplier": supplier})
        if progress and progress.get("status") == "running":
            # Check if it's stale (no update in 2 minutes)
            last_update = progress.get("last_updated")
            if last_update:
                # Ensure both datetimes are timezone-aware for comparison
                if last_update.tzinfo is None:
                    last_update = last_update.replace(tzinfo=timezone.utc)
                age = (datetime.now(timezone.utc) - last_update).total_seconds()
                if age < 120:
                    return {
                        "success": True,
                        "status": "already_running",
                        "message": f"Bulk add already in progress for {supplier}",
                        "progress": {
                            "total": progress.get("total", 0),
                            "processed": progress.get("processed", 0),
                            "added": progress.get("added", 0),
                            "skipped": progress.get("skipped", 0)
                        }
                    }
        
        # Get count of products to add
        total = get_sync_db().sync_staging.count_documents({"supplier": supplier})
        
        if total == 0:
            return {
                "success": True,
                "status": "no_products",
                "message": f"No products in staging for {supplier}"
            }
        
        # Start background task
        thread = threading.Thread(
            target=run_bulk_add_background,
            args=(supplier, is_clearance, apply_price_rules),
            daemon=True
        )
        thread.start()
        
        return {
            "success": True,
            "status": "started",
            "message": f"Started adding {total} products for {supplier}",
            "total": total
        }
        
    except Exception as e:
        logger.error(f"Error starting bulk add: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{supplier}/bulk-add-progress")
def get_bulk_add_progress(supplier: str):
    """Get the progress of the bulk add operation for a supplier."""
    try:
        progress = get_sync_db().bulk_add_progress.find_one({"supplier": supplier}, {"_id": 0})
        
        if not progress:
            return {
                "status": "not_started",
                "message": "No bulk add operation found for this supplier"
            }
        
        return {
            "status": progress.get("status", "unknown"),
            "total": progress.get("total", 0),
            "processed": progress.get("processed", 0),
            "added": progress.get("added", 0),
            "skipped": progress.get("skipped", 0),
            "errors": progress.get("errors", []),
            "started_at": progress.get("started_at"),
            "completed_at": progress.get("completed_at"),
            "last_updated": progress.get("last_updated")
        }
        
    except Exception as e:
        logger.error(f"Error getting bulk add progress: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{supplier}/stop-bulk-add")
def stop_bulk_add(supplier: str):
    """Force stop/reset a stuck bulk add operation."""
    try:
        db = get_sync_db()
        result = db.bulk_add_progress.update_one(
            {"supplier": supplier},
            {"$set": {
                "status": "stopped",
                "stopped_at": datetime.now(timezone.utc),
                "last_updated": datetime.now(timezone.utc)
            }}
        )
        if result.modified_count > 0:
            return {"success": True, "message": f"Bulk add stopped for {supplier}"}
        else:
            # No running task, just clear any stale progress
            db.bulk_add_progress.delete_many({"supplier": supplier})
            return {"success": True, "message": f"Cleared stale bulk add state for {supplier}"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))



@router.post("/{supplier}/add-all-new-products")
def add_all_new_products_to_database(supplier: str, request: Optional[BulkAddRequest] = None):
    """Add ALL new products from staging to supplier_products with price rules applied.
    
    This applies:
    1. Price Rules: List Price = Cost × 1.90 (markup) × 1.20 (VAT), rounded to .99
    2. Stores cost_price and calculated list_price
    3. Saves images
    
    Args:
        is_clearance: If True, all products marked as clearance
        apply_price_rules: If True (default), apply markup and VAT to prices
    """
    import math
    
    try:
        is_clearance = request.is_clearance if request else False
        apply_price_rules = request.apply_price_rules if request else True
        product_type = "clearance" if is_clearance else "new_collection"
        
        # Get all staged new products for this supplier
        staged_products = list(get_sync_db().sync_staging.find({"supplier": supplier}))
        
        added = 0
        skipped = 0
        errors = []
        
        for staged in staged_products:
            sku = staged.get("sku")
            name = staged.get("name")
            
            # Check if has stock (mandatory)
            has_stock = staged.get("stock_quantity") is not None or staged.get("stock_m2") is not None
            if not has_stock:
                errors.append(f"SKU {sku}: Missing stock data")
                skipped += 1
                continue
            
            # Check if already exists
            existing = product_exists_in_supplier_products(sku, supplier, name)
            if existing:
                skipped += 1
                continue
            
            # Get prices from staging - the sync may have already calculated list_price
            cost_price = staged.get("cost_price") or staged.get("price")
            staged_price = staged.get("price")
            
            # Determine if price markup was already applied during sync
            # If staged price is significantly higher than cost (> 1.5x), markup was already applied
            price_already_calculated = False
            if cost_price and staged_price and staged_price > cost_price * 1.5:
                price_already_calculated = True
                list_price = staged_price  # Use the already calculated price
            elif cost_price and apply_price_rules and not price_already_calculated:
                # Apply price rules: Cost × 1.90 × 1.20, rounded to .99
                raw_list_price = cost_price * 1.90 * 1.20
                list_price = math.ceil(raw_list_price) - 0.01
                if list_price < raw_list_price:
                    list_price = math.ceil(raw_list_price + 1) - 0.01
                list_price = round(list_price, 2)
            else:
                list_price = staged_price
            
            # Build product data
            product_data = {
                "sku": sku,
                "name": name,
                "original_name": name,  # Keep original supplier name
                "original_supplier_code": sku,
                "supplier": supplier,
                "stock_quantity": staged.get("stock_quantity"),
                "stock_m2": staged.get("stock_m2"),
                "cost_price": cost_price,
                "cost_price_m2": cost_price,
                "price": list_price if list_price else cost_price,  # Use calculated list price
                "list_price": list_price,
                "category": extract_proper_category(staged),  # Use helper to extract proper category
                "material": staged.get("material"),
                "finish": staged.get("finish"),
                "size": staged.get("size"),
                "image": staged.get("image"),
                "images": staged.get("images") or ([staged.get("image")] if staged.get("image") else []),
                "description": staged.get("description"),
                "url": staged.get("url"),
                "in_stock": (staged.get("stock_quantity") or staged.get("stock_m2") or 0) > 0,
                "in_products_db": True,  # Will be added to main products DB
                "product_type": product_type,
                "has_complete_data": staged.get("has_complete_data", True),
                "created_at": datetime.now(timezone.utc),
                "last_synced": datetime.now(timezone.utc),
                "sync_source": staged.get("sync_source", "deep_full_sync")
            }
            
            # Apply unique naming - this generates a unique product_name
            # and checks for duplicates across all suppliers
            product_data = apply_unique_naming_to_product(product_data, get_sync_db())
            
            try:
                # Upsert into supplier_products (prevents duplicates if button clicked multiple times)
                get_sync_db().supplier_products.update_one(
                    {"sku": sku, "supplier": supplier},
                    {"$set": product_data},
                    upsert=True
                )
                
                # ALSO add to main products collection (EPOS database)
                main_product_data = {
                    "sku": sku,
                    "name": product_data.get("product_name") or product_data.get("name"),
                    "supplier": supplier,
                    "supplier_product_name": product_data.get("name"),  # Original supplier name for SEO
                    "category_name": product_data.get("category"),
                    "description": product_data.get("description", ""),
                    "material": product_data.get("material"),
                    "finish": product_data.get("finish"),
                    "cost": product_data.get("cost_price"),
                    "price": product_data.get("price"),
                    "stock": product_data.get("stock_quantity", 0),
                    "m2_quantity": product_data.get("stock_m2", 0),
                    "images": product_data.get("images", []),
                    "in_stock": product_data.get("in_stock", (product_data.get("stock_quantity") or product_data.get("stock_m2") or 0) > 0),
                    "created_at": datetime.now(timezone.utc),
                    "updated_at": datetime.now(timezone.utc),
                    "source": "sync_staging_bulk_add_sync"
                }
                
                result = get_sync_db().products.update_one(
                    {"sku": sku},
                    {"$set": main_product_data},
                    upsert=True
                )
                
                # Update supplier_products with products_db_id
                if result.upserted_id:
                    products_db_id = str(result.upserted_id)
                else:
                    existing = get_sync_db().products.find_one({"sku": sku}, {"_id": 1})
                    products_db_id = str(existing["_id"]) if existing else None
                
                get_sync_db().supplier_products.update_one(
                    {"sku": sku, "supplier": supplier},
                    {"$set": {"products_db_id": products_db_id}}
                )
                
                # Remove from staging
                get_sync_db().sync_staging.delete_one({"_id": staged["_id"]})
                added += 1
                
            except Exception as e:
                errors.append(f"{sku}: {str(e)}")
        
        # Log the bulk add action
        get_sync_db().sync_logs.insert_one({
            "action": "bulk_add_new_products",
            "supplier": supplier,
            "timestamp": datetime.now(timezone.utc),
            "added": added,
            "skipped": skipped,
            "product_type": product_type,
            "apply_price_rules": apply_price_rules,
            "errors": errors[:20]  # Limit errors logged
        })
        
        return {
            "success": True,
            "added": added,
            "skipped": skipped,
            "product_type": product_type,
            "price_rules_applied": apply_price_rules,
            "errors": errors[:20],
            "message": f"Added {added} new {supplier} products to database"
        }
        
    except Exception as e:
        logger.error(f"Error in bulk add: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/ignore")
def ignore_product(request: IgnoreProductRequest):
    """Add a product to the ignore list and remove from staging"""
    try:
        # Add to ignored list
        get_sync_db().ignored_products.update_one(
            {"sku": request.sku, "supplier": request.supplier},
            {
                "$set": {
                    "sku": request.sku,
                    "supplier": request.supplier,
                    "reason": request.reason,
                    "ignored_at": datetime.now(timezone.utc)
                }
            },
            upsert=True
        )
        
        # Remove from staging
        result = get_sync_db().sync_staging.delete_many({
            "sku": request.sku,
            "supplier": request.supplier
        })
        
        return {
            "success": True,
            "message": f"Product {request.sku} will be ignored in future syncs",
            "removed_from_staging": result.deleted_count
        }
    except Exception as e:
        logger.error(f"Error ignoring product: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/ignored/{supplier}/{sku}")
def remove_from_ignored(supplier: str, sku: str):
    """Remove a product from the ignore list"""
    try:
        result = get_sync_db().ignored_products.delete_one({
            "sku": sku,
            "supplier": supplier
        })
        
        if result.deleted_count == 0:
            raise HTTPException(status_code=404, detail="Product not found in ignore list")
        
        return {
            "success": True,
            "message": f"Product {sku} removed from ignore list"
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error removing from ignored: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{staging_id}")
def delete_staged_product(staging_id: str):
    """Delete a single product from staging"""
    try:
        result = get_sync_db().sync_staging.delete_one({"_id": ObjectId(staging_id)})
        
        if result.deleted_count == 0:
            raise HTTPException(status_code=404, detail="Staged product not found")
        
        return {
            "success": True,
            "message": "Product removed from staging"
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting staged product: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/clear/{supplier}")
def clear_supplier_staging(supplier: str):
    """Clear all staged products for a supplier"""
    try:
        result = get_sync_db().sync_staging.delete_many({"supplier": supplier})
        
        return {
            "success": True,
            "deleted": result.deleted_count,
            "message": f"Cleared {result.deleted_count} staged products for {supplier}"
        }
    except Exception as e:
        logger.error(f"Error clearing staging for {supplier}: {e}")
        raise HTTPException(status_code=500, detail=str(e))



# ============== CLEARANCE & NEW COLLECTION ENDPOINTS ==============

@router.get("/special-products/clearance")
def get_clearance_products(
    supplier: Optional[str] = None,
    search: Optional[str] = None,
    skip: int = 0,
    limit: int = 100
):
    """Get all clearance products across all suppliers"""
    try:
        query = {"product_type": "clearance"}
        
        if supplier:
            query["supplier"] = supplier
        
        if search:
            query["$or"] = [
                {"name": {"$regex": search, "$options": "i"}},
                {"sku": {"$regex": search, "$options": "i"}},
                {"product_name": {"$regex": search, "$options": "i"}}
            ]
        
        products_cursor = get_sync_db().supplier_products.find(
            query,
            {"_id": 0}
        ).skip(skip).limit(limit).sort("created_at", -1)
        
        products = list(products_cursor)
        total = get_sync_db().supplier_products.count_documents(query)
        
        # Get counts by supplier
        pipeline = [
            {"$match": {"product_type": "clearance"}},
            {"$group": {"_id": "$supplier", "count": {"$sum": 1}}}
        ]
        supplier_counts = {doc["_id"]: doc["count"] for doc in get_sync_db().supplier_products.aggregate(pipeline)}
        
        return {
            "products": products,
            "total": total,
            "skip": skip,
            "limit": limit,
            "by_supplier": supplier_counts
        }
    except Exception as e:
        logger.error(f"Error fetching clearance products: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/special-products/new-collection")
def get_new_collection_products(
    supplier: Optional[str] = None,
    search: Optional[str] = None,
    skip: int = 0,
    limit: int = 100
):
    """Get all new collection products across all suppliers"""
    try:
        query = {"product_type": "new_collection"}
        
        if supplier:
            query["supplier"] = supplier
        
        if search:
            query["$or"] = [
                {"name": {"$regex": search, "$options": "i"}},
                {"sku": {"$regex": search, "$options": "i"}},
                {"product_name": {"$regex": search, "$options": "i"}}
            ]
        
        products_cursor = get_sync_db().supplier_products.find(
            query,
            {"_id": 0}
        ).skip(skip).limit(limit).sort("created_at", -1)
        
        products = list(products_cursor)
        total = get_sync_db().supplier_products.count_documents(query)
        
        # Get counts by supplier
        pipeline = [
            {"$match": {"product_type": "new_collection"}},
            {"$group": {"_id": "$supplier", "count": {"$sum": 1}}}
        ]
        supplier_counts = {doc["_id"]: doc["count"] for doc in get_sync_db().supplier_products.aggregate(pipeline)}
        
        return {
            "products": products,
            "total": total,
            "skip": skip,
            "limit": limit,
            "by_supplier": supplier_counts
        }
    except Exception as e:
        logger.error(f"Error fetching new collection products: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/special-products/stats")
def get_special_products_stats():
    """Get stats for clearance and new collection products"""
    try:
        # Count clearance products
        clearance_count = get_sync_db().supplier_products.count_documents({"product_type": "clearance"})
        
        # Count new collection products
        new_collection_count = get_sync_db().supplier_products.count_documents({"product_type": "new_collection"})
        
        # Get counts by supplier for clearance
        clearance_pipeline = [
            {"$match": {"product_type": "clearance"}},
            {"$group": {"_id": "$supplier", "count": {"$sum": 1}}}
        ]
        clearance_by_supplier = {doc["_id"]: doc["count"] for doc in get_sync_db().supplier_products.aggregate(clearance_pipeline)}
        
        # Get counts by supplier for new collection
        new_collection_pipeline = [
            {"$match": {"product_type": "new_collection"}},
            {"$group": {"_id": "$supplier", "count": {"$sum": 1}}}
        ]
        new_collection_by_supplier = {doc["_id"]: doc["count"] for doc in get_sync_db().supplier_products.aggregate(new_collection_pipeline)}
        
        return {
            "clearance": {
                "total": clearance_count,
                "by_supplier": clearance_by_supplier
            },
            "new_collection": {
                "total": new_collection_count,
                "by_supplier": new_collection_by_supplier
            }
        }
    except Exception as e:
        logger.error(f"Error fetching special products stats: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/special-products/{sku}/update-type")
def update_product_type(sku: str, product_type: str, supplier: Optional[str] = None):
    """Update a product's type (clearance/new_collection/normal)"""
    try:
        if product_type not in ["clearance", "new_collection", "normal"]:
            raise HTTPException(status_code=400, detail="Invalid product type. Must be 'clearance', 'new_collection', or 'normal'")
        
        query = {"sku": sku}
        if supplier:
            query["supplier"] = supplier
        
        if product_type == "normal":
            result = get_sync_db().supplier_products.update_one(
                query,
                {"$unset": {"product_type": ""}}
            )
        else:
            result = get_sync_db().supplier_products.update_one(
                query,
                {"$set": {"product_type": product_type}}
            )
        
        if result.modified_count == 0:
            raise HTTPException(status_code=404, detail="Product not found or type unchanged")
        
        return {
            "success": True,
            "message": f"Product {sku} type updated to {product_type}",
            "sku": sku,
            "product_type": product_type
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating product type: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============== DATA VALIDATION ENDPOINTS ==============

@router.get("/validation/check")
def validate_supplier_codes(supplier: Optional[str] = None):
    """
    Run validation check on supplier product codes.
    
    Detects potential data integrity issues:
    - Code mismatches (original_supplier_code != supplier_code)
    - Code collisions (same code for different products)
    - Name duplicates with different code patterns
    
    Returns health status and detailed alerts.
    """
    try:
        result = validate_code_mappings(supplier)
        
        # Log validation run
        get_sync_db().sync_logs.insert_one({
            "action": "validation_check",
            "supplier": supplier or "ALL",
            "timestamp": datetime.now(timezone.utc),
            "health": result["health"],
            "alerts_count": len(result["alerts"]),
            "warnings_count": len(result["warnings"])
        })
        
        return result
    except Exception as e:
        logger.error(f"Error running validation: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/validation/fix-mismatches")
def fix_code_mismatches(supplier: Optional[str] = None, dry_run: bool = True):
    """
    Fix code mismatches by setting original_supplier_code = supplier_code.
    
    Args:
        supplier: Optional supplier to limit the fix to
        dry_run: If True, only report what would be fixed without making changes
    
    Returns list of products that would be/were fixed.
    """
    try:
        db = get_sync_db()
        
        query = {"supplier": supplier} if supplier else {}
        products = list(db.supplier_products.find(query))
        
        fixes = []
        fixed_count = 0
        
        for product in products:
            orig_code = product.get("original_supplier_code")
            supplier_code = product.get("supplier_code")
            
            # Fix: Set original_supplier_code to match supplier_code
            if supplier_code and (not orig_code or orig_code != supplier_code):
                fix_info = {
                    "sku": product.get("sku"),
                    "name": product.get("name"),
                    "old_original_code": orig_code,
                    "new_original_code": supplier_code,
                    "supplier_code": supplier_code
                }
                
                if not dry_run:
                    db.supplier_products.update_one(
                        {"_id": product["_id"]},
                        {"$set": {"original_supplier_code": supplier_code}}
                    )
                    fixed_count += 1
                
                fixes.append(fix_info)
        
        # Log the fix action
        get_sync_db().sync_logs.insert_one({
            "action": "fix_code_mismatches",
            "supplier": supplier or "ALL",
            "timestamp": datetime.now(timezone.utc),
            "dry_run": dry_run,
            "fixes_count": len(fixes),
            "applied_count": fixed_count
        })
        
        return {
            "dry_run": dry_run,
            "would_fix" if dry_run else "fixed": len(fixes),
            "fixes": fixes[:100],  # Limit response size
            "total_fixes": len(fixes),
            "message": f"{'Would fix' if dry_run else 'Fixed'} {len(fixes)} products. Set dry_run=false to apply."
        }
    except Exception as e:
        logger.error(f"Error fixing mismatches: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/validation/history")
def get_validation_history(limit: int = 20):
    """Get recent validation and fix history"""
    try:
        logs = list(get_sync_db().sync_logs.find(
            {"action": {"$in": ["validation_check", "fix_code_mismatches"]}},
            {"_id": 0}
        ).sort("timestamp", -1).limit(limit))
        
        for log in logs:
            if log.get("timestamp"):
                log["timestamp"] = log["timestamp"].isoformat()
        
        return {
            "history": logs,
            "total": len(logs)
        }
    except Exception as e:
        logger.error(f"Error fetching validation history: {e}")
        raise HTTPException(status_code=500, detail=str(e))



@router.post("/{supplier}/update-codes-from-staging")
def update_codes_from_staging(supplier: str, dry_run: bool = True):
    """
    Update existing product codes from staging data.
    
    When products exist in the database with [None] codes but staging has proper codes,
    this endpoint will update the existing products with the new codes.
    
    Args:
        supplier: Supplier name (e.g., 'Splendour')
        dry_run: If True, only report what would be updated without making changes
    """
    try:
        db = get_sync_db()
        
        # Get all staged products for this supplier
        staged_products = list(db.sync_staging.find({"supplier": supplier}))
        
        if not staged_products:
            return {"message": f"No staged products found for {supplier}", "updated": 0}
        
        # Get existing products for this supplier  
        existing_products = list(db.supplier_products.find({"supplier": {"$regex": f"^{supplier}$", "$options": "i"}}))
        
        # Build name-to-product lookup
        name_to_product = {}
        for p in existing_products:
            name = p.get("name")
            if name:
                name_to_product[name.lower()] = p
        
        updates = []
        updated_count = 0
        
        for staged in staged_products:
            incoming_code = staged.get("sku")
            incoming_name = staged.get("name")
            
            if not incoming_code or not incoming_name:
                continue
            
            # Find matching existing product by name
            existing = name_to_product.get(incoming_name.lower())
            
            if existing:
                existing_code = existing.get("original_supplier_code") or existing.get("supplier_code")
                
                # Only update if existing code is None/empty and incoming code is valid
                if not existing_code and incoming_code:
                    update_info = {
                        "name": incoming_name,
                        "old_code": existing_code,
                        "new_code": incoming_code,
                        "product_id": str(existing.get("_id"))
                    }
                    
                    if not dry_run:
                        db.supplier_products.update_one(
                            {"_id": existing["_id"]},
                            {"$set": {
                                "original_supplier_code": incoming_code,
                                "supplier_code": incoming_code
                            }}
                        )
                        updated_count += 1
                    
                    updates.append(update_info)
        
        # Log the action
        db.sync_logs.insert_one({
            "action": "update_codes_from_staging",
            "supplier": supplier,
            "timestamp": datetime.now(timezone.utc),
            "dry_run": dry_run,
            "updates_count": len(updates),
            "applied_count": updated_count
        })
        
        return {
            "supplier": supplier,
            "dry_run": dry_run,
            "would_update" if dry_run else "updated": len(updates),
            "updates": updates[:50],  # Limit response size
            "total_updates": len(updates),
            "message": f"{'Would update' if dry_run else 'Updated'} {len(updates)} product codes. Set dry_run=false to apply."
        }
    except Exception as e:
        logger.error(f"Error updating codes from staging: {e}")
        raise HTTPException(status_code=500, detail=str(e))



@router.post("/fix-supplier-names")
async def fix_supplier_product_names(dry_run: bool = True):
    """
    Fix missing supplier_product_name field in products collection.
    
    This populates the supplier_product_name from sync_staging 'name' field
    for all products that are missing this field.
    
    Args:
        dry_run: If True, only report what would be updated. Set to False to apply changes.
    """
    try:
        db = get_sync_db()
        
        # Find all products with missing or null supplier_product_name
        products_to_fix = list(db.products.find({
            "$or": [
                {"supplier_product_name": None},
                {"supplier_product_name": {"$exists": False}},
                {"supplier_product_name": ""}
            ]
        }))
        
        logger.info(f"Found {len(products_to_fix)} products with missing supplier_product_name")
        
        updates = []
        updated_count = 0
        
        for product in products_to_fix:
            sku = product.get("sku")
            if not sku:
                continue
            
            # Find corresponding sync_staging record
            staging = db.sync_staging.find_one({"sku": sku})
            
            if staging and staging.get("name"):
                original_name = staging.get("name")
                update_info = {
                    "sku": sku,
                    "product_name": product.get("name"),
                    "supplier_product_name_to_set": original_name
                }
                updates.append(update_info)
                
                if not dry_run:
                    db.products.update_one(
                        {"sku": sku},
                        {"$set": {"supplier_product_name": original_name}}
                    )
                    updated_count += 1
        
        return {
            "dry_run": dry_run,
            "products_checked": len(products_to_fix),
            "products_to_update": len(updates),
            "updated_count": updated_count if not dry_run else 0,
            "sample_updates": updates[:20],
            "message": f"{'Would update' if dry_run else 'Updated'} {len(updates)} products with supplier_product_name. Set dry_run=false to apply."
        }
    except Exception as e:
        logger.error(f"Error fixing supplier product names: {e}")
        raise HTTPException(status_code=500, detail=str(e))



@router.post("/fix-missing-fields")
async def fix_missing_product_fields(dry_run: bool = True):
    """
    Fix missing required fields in products collection.
    
    This fixes:
    - reorder_level: Set to 10 if missing
    - stock: Set to 0 if missing
    - price: Set to 0 if missing
    - sku: Set to product ID if missing
    
    Args:
        dry_run: If True, only report what would be updated. Set to False to apply changes.
    """
    try:
        db = get_sync_db()
        
        # Find all products with missing required fields
        products_to_fix = list(db.products.find({
            "$or": [
                {"reorder_level": None},
                {"reorder_level": {"$exists": False}},
                {"stock": None},
                {"stock": {"$exists": False}},
                {"price": None},
                {"price": {"$exists": False}},
                {"sku": None},
                {"sku": {"$exists": False}},
                {"sku": ""}
            ]
        }))
        
        logger.info(f"Found {len(products_to_fix)} products with missing required fields")
        
        updates = []
        updated_count = 0
        
        for product in products_to_fix:
            product_id = str(product.get("_id"))
            update_fields = {}
            issues = []
            
            if product.get("reorder_level") is None:
                update_fields["reorder_level"] = 10
                issues.append("reorder_level")
            
            if product.get("stock") is None:
                update_fields["stock"] = 0
                issues.append("stock")
            
            if product.get("price") is None:
                update_fields["price"] = 0.0
                issues.append("price")
            
            if not product.get("sku"):
                update_fields["sku"] = product.get("id", product_id)
                issues.append("sku")
            
            if update_fields:
                update_info = {
                    "product_id": product_id,
                    "name": product.get("name", "Unknown"),
                    "sku": product.get("sku", "UNKNOWN"),
                    "issues_fixed": issues,
                    "fields_set": update_fields
                }
                updates.append(update_info)
                
                if not dry_run:
                    db.products.update_one(
                        {"_id": product["_id"]},
                        {"$set": update_fields}
                    )
                    updated_count += 1
        
        return {
            "dry_run": dry_run,
            "products_checked": len(products_to_fix),
            "products_to_update": len(updates),
            "updated_count": updated_count if not dry_run else 0,
            "sample_updates": updates[:30],
            "message": f"{'Would update' if dry_run else 'Updated'} {len(updates)} products with missing fields. Set dry_run=false to apply."
        }
    except Exception as e:
        logger.error(f"Error fixing missing fields: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ===== Warning Dismiss & SKU Remap Endpoints =====

class DismissWarningsRequest(BaseModel):
    supplier: str
    warning_codes: Optional[List[str]] = None  # If None, dismiss all
    dismiss_all: bool = False

@router.post("/warnings/dismiss")
def dismiss_validation_warnings(data: DismissWarningsRequest):
    """Dismiss validation warnings for a supplier. Stores dismissed codes so they don't reappear."""
    db = get_sync_db()
    
    now = datetime.now(timezone.utc)
    dismissed_count = 0
    
    if data.dismiss_all:
        # Get all current warnings for supplier
        staged = list(db.sync_staging.find({"supplier": data.supplier}))
        warnings = validate_incoming_sync(staged, data.supplier)
        codes = list(set(w.get("code") or w.get("incoming_code", "") for w in warnings if w.get("code") or w.get("incoming_code")))
    else:
        codes = data.warning_codes or []
    
    for code in codes:
        if not code:
            continue
        db.dismissed_warnings.update_one(
            {"supplier": data.supplier, "code": code},
            {"$set": {
                "supplier": data.supplier,
                "code": code,
                "dismissed_at": now,
                "dismissed_by": "admin"
            }},
            upsert=True
        )
        dismissed_count += 1
    
    return {
        "success": True,
        "dismissed_count": dismissed_count,
        "message": f"Dismissed {dismissed_count} warnings for {data.supplier}"
    }


class AutoVerifyRequest(BaseModel):
    supplier: str
    dry_run: bool = False

@router.post("/warnings/auto-verify")
def auto_verify_warnings(data: AutoVerifyRequest):
    """
    Auto-verify name-change warnings that are provably safe renames:
    the staged product's transformed display name (our naming rules / custom
    mappings) matches the existing product assigned to that code — meaning the
    code points at the right product, we just renamed it. Safe ones are
    dismissed; genuine mismatches are left for manual review.
    """
    db = get_sync_db()

    staged = list(db.sync_staging.find({"supplier": data.supplier}))
    warnings = validate_incoming_sync(staged, data.supplier)

    dismissed_codes = {d["code"] for d in db.dismissed_warnings.find({"supplier": data.supplier}, {"code": 1})}
    staged_by_sku = {s.get("sku"): s for s in staged if s.get("sku")}

    existing_by_code = {}
    for p in db.supplier_products.find({"supplier": {"$regex": f"^{data.supplier}$", "$options": "i"}}):
        code = p.get("original_supplier_code") or p.get("supplier_code")
        if code:
            existing_by_code[code] = p

    safe = []
    remaining = []
    for w in warnings:
        code = w.get("code") or w.get("incoming_code")
        if not code or code in dismissed_codes:
            continue
        if w.get("type") != "name_change_detected":
            remaining.append({"code": code, "type": w.get("type"), "message": w.get("message")})
            continue
        staged_doc = staged_by_sku.get(code) or {}
        existing = existing_by_code.get(code) or {}
        staged_display = staged_doc.get("product_name")
        is_safe = bool(staged_display) and (
            _names_match(staged_display, existing.get("name"))
            or _names_match(staged_display, existing.get("product_name"))
        )
        if is_safe:
            safe.append({
                "code": code,
                "existing_name": w.get("existing_name"),
                "incoming_name": w.get("incoming_name"),
                "matched_display_name": staged_display,
            })
        else:
            remaining.append({
                "code": code,
                "type": w.get("type"),
                "existing_name": w.get("existing_name"),
                "incoming_name": w.get("incoming_name"),
                "staged_display_name": staged_display,
                "message": w.get("message"),
            })

    dismissed_count = 0
    if not data.dry_run and safe:
        now = datetime.now(timezone.utc)
        for s in safe:
            db.dismissed_warnings.update_one(
                {"supplier": data.supplier, "code": s["code"]},
                {"$set": {
                    "supplier": data.supplier,
                    "code": s["code"],
                    "dismissed_at": now,
                    "dismissed_by": "auto_verify",
                    "verified_match": s["matched_display_name"],
                    "supplier_name_at_verify": s["incoming_name"],
                }},
                upsert=True,
            )
            # Heal old damage: restore the supplier's original name into `name`
            # (a past Name Sanity bug overwrote it with our display name).
            existing = existing_by_code.get(s["code"])
            if existing and s.get("incoming_name") and existing.get("name") != s["incoming_name"]:
                db.supplier_products.update_one(
                    {"_id": existing["_id"]},
                    {"$set": {"name": s["incoming_name"], "updated_at": now.isoformat()}},
                )
            dismissed_count += 1

    return {
        "success": True,
        "checked": len(warnings),
        "safe_count": len(safe),
        "dismissed_count": dismissed_count,
        "remaining_count": len(remaining),
        "safe_examples": safe[:15],
        "remaining": remaining[:50],
        "dry_run": data.dry_run,
    }


class RemapSkuRequest(BaseModel):
    supplier: str
    sku: str
    action: str  # "relink" or "break_and_new"
    target_product_sku: Optional[str] = None  # For relink: which existing product to link to

@router.post("/warnings/remap-sku")
def remap_sku(data: RemapSkuRequest):
    """
    Remap a SKU when supplier reassigns it to a different product.
    - relink: Change which existing product this SKU maps to
    - break_and_new: Disconnect from old product, treat synced data as new product
    """
    db = get_sync_db()
    
    if data.action == "relink":
        if not data.target_product_sku:
            raise HTTPException(status_code=400, detail="target_product_sku required for relink action")
        
        # Find the target product
        target = db.supplier_products.find_one({
            "supplier": {"$regex": f"^{data.supplier}$", "$options": "i"},
            "$or": [
                {"sku": data.target_product_sku},
                {"supplier_code": data.target_product_sku},
                {"original_supplier_code": data.target_product_sku}
            ]
        })
        if not target:
            raise HTTPException(status_code=404, detail=f"Target product {data.target_product_sku} not found")
        
        # Update the target product to use the new SKU
        db.supplier_products.update_one(
            {"_id": target["_id"]},
            {"$set": {
                "original_supplier_code": data.sku,
                "supplier_code": data.sku,
                "sku_remapped_at": datetime.now(timezone.utc),
                "sku_remapped_from": target.get("original_supplier_code") or target.get("supplier_code")
            }}
        )
        
        # Also dismiss this warning
        db.dismissed_warnings.update_one(
            {"supplier": data.supplier, "code": data.sku},
            {"$set": {
                "supplier": data.supplier,
                "code": data.sku,
                "dismissed_at": datetime.now(timezone.utc),
                "action": "relinked",
                "target_sku": data.target_product_sku
            }},
            upsert=True
        )
        
        return {
            "success": True,
            "action": "relinked",
            "message": f"SKU {data.sku} relinked to product '{target.get('name', data.target_product_sku)}'"
        }
    
    elif data.action == "break_and_new":
        # Find the existing product that currently uses this SKU
        existing = db.supplier_products.find_one({
            "supplier": {"$regex": f"^{data.supplier}$", "$options": "i"},
            "$or": [
                {"sku": data.sku},
                {"supplier_code": data.sku},
                {"original_supplier_code": data.sku}
            ]
        })
        
        if existing:
            # Clear the SKU from the existing product so it doesn't conflict
            old_name = existing.get("name", "Unknown")
            db.supplier_products.update_one(
                {"_id": existing["_id"]},
                {"$set": {
                    "original_supplier_code": f"OLD_{data.sku}",
                    "sku_broken_at": datetime.now(timezone.utc),
                    "sku_broken_reason": f"SKU {data.sku} reassigned by supplier to different product"
                }}
            )
        
        # Get the staged product data
        staged = db.sync_staging.find_one({
            "supplier": data.supplier,
            "sku": data.sku
        })
        
        if staged:
            # Mark it as a new product by removing the existing match flag
            db.sync_staging.update_one(
                {"_id": staged["_id"]},
                {"$set": {"is_new_product": True, "broken_from": existing.get("name") if existing else None}}
            )
        
        # Dismiss the warning
        db.dismissed_warnings.update_one(
            {"supplier": data.supplier, "code": data.sku},
            {"$set": {
                "supplier": data.supplier,
                "code": data.sku,
                "dismissed_at": datetime.now(timezone.utc),
                "action": "broken_and_new",
                "old_product_name": existing.get("name") if existing else None
            }},
            upsert=True
        )
        
        return {
            "success": True,
            "action": "break_and_new",
            "message": f"SKU {data.sku} disconnected from '{old_name if existing else 'unknown'}'. Synced product will be treated as new."
        }
    
    else:
        raise HTTPException(status_code=400, detail=f"Invalid action: {data.action}. Use 'relink' or 'break_and_new'")


@router.get("/warnings/dismissed/{supplier}")
def get_dismissed_warnings(supplier: str):
    """Get list of dismissed warning codes for a supplier."""
    db = get_sync_db()
    dismissed = list(db.dismissed_warnings.find(
        {"supplier": supplier},
        {"_id": 0, "code": 1, "dismissed_at": 1, "action": 1}
    ))
    return {"dismissed": dismissed, "count": len(dismissed)}


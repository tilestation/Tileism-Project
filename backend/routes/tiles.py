"""
Tile Products API Routes
Routes for tile products from tiles collection (published products) for the public shop.
"""
from datetime import datetime, timezone
from typing import Optional, List
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel
import re

from utils.bulletproof import bulletproof_endpoint

router = APIRouter(prefix="/tiles", tags=["Tiles"])


def get_tile_db():
    """Get tile_station database connection"""
    from pymongo import MongoClient
    import os
    mongo_url = os.environ.get('MONGO_URL')
    if not mongo_url:
        raise ValueError("MONGO_URL environment variable is required")
    client = MongoClient(mongo_url)
    return client[os.environ.get('DB_NAME', 'tile_station')]


def _safe_str(val) -> str:
    """Safely convert any value to string. Handles lists, dicts, None."""
    if not val:
        return ""
    if isinstance(val, list):
        return val[0] if val and isinstance(val[0], str) else str(val[0]) if val else ""
    if isinstance(val, str):
        return val
    return str(val)


def parse_tile_size(size_str: str) -> tuple:
    """
    Parse tile size string and return dimensions in meters and area in m².
    Supports formats: "30x45", "600x600mm", "60X60", etc.
    Returns: (width_m, height_m, area_m2) or (None, None, None) if unparseable
    """
    if not size_str:
        return None, None, None
    
    # Clean up the string
    size_clean = size_str.lower().replace('mm', '').replace('cm', '').strip()
    
    # Try to extract two numbers (width x height)
    match = re.search(r'(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)', size_clean)
    if not match:
        return None, None, None
    
    try:
        width = float(match.group(1))
        height = float(match.group(2))
        
        # Determine if dimensions are in mm or cm based on typical sizes
        # If values are > 100, likely mm; otherwise likely cm
        if width > 100 or height > 100:
            # Values in mm, convert to m
            width_m = width / 1000
            height_m = height / 1000
        else:
            # Values in cm, convert to m
            width_m = width / 100
            height_m = height / 100
        
        area_m2 = width_m * height_m
        return width_m, height_m, area_m2
    except (ValueError, AttributeError):
        return None, None, None


# Words that are product types, NOT surface finishes — strip from finish field
PRODUCT_TYPE_WORDS = {'decor', 'feature', 'mosaic', 'border', 'listello', 'skirting'}

def normalize_finish(raw_finish) -> str:
    """Strip product-type words from finish values.
    E.g. 'Matt Decor' → 'Matt', 'Polished Feature' → 'Polished'
    Handles non-string types (lists, dicts) gracefully.
    """
    if not raw_finish:
        return ""
    # Handle non-string types (e.g., lists stored in DB)
    if isinstance(raw_finish, list):
        raw_finish = raw_finish[0] if raw_finish else ""
    if not isinstance(raw_finish, str):
        raw_finish = str(raw_finish)
    if not raw_finish:
        return ""
    words = [w for w in raw_finish.split() if w.lower() not in PRODUCT_TYPE_WORDS]
    return ' '.join(words) if words else raw_finish


def serialize_tile_for_shop(tile: dict) -> dict:
    """Serialize tile product for public shop display"""
    # Get size info
    size_str = tile.get("size", "") or tile.get("attributes", {}).get("size", "")
    if isinstance(size_str, list):
        size_str = size_str[0] if size_str else ""
    if not isinstance(size_str, str):
        size_str = str(size_str) if size_str else ""
    width_m, height_m, tile_area_m2 = parse_tile_size(size_str)
    
    # Calculate per-tile prices if we have tile area
    room_lot_price = tile.get("room_lot_price", 0) or 0
    pallet_price = tile.get("pallet_price", 0) or 0
    half_pallet_price = tile.get("half_pallet_price", 0) or 0
    price_per_sqm = room_lot_price or tile.get("price", 0) or 0
    
    price_per_tile = None
    pallet_price_per_tile = None
    tiles_per_sqm = None
    
    if tile_area_m2 and tile_area_m2 > 0:
        tiles_per_sqm = round(1 / tile_area_m2, 2)
        if price_per_sqm > 0:
            price_per_tile = round(price_per_sqm * tile_area_m2, 2)
        if pallet_price > 0:
            pallet_price_per_tile = round(pallet_price * tile_area_m2, 2)
    
    # Half + Full pallet pricing — m² minimums on the tile drive what
    # tier the customer can pick on the PDP. The £/m² rates are the
    # tile's own pallet_price / half_pallet_price fields.
    m2_per_pallet = tile.get("m2_per_pallet")
    m2_per_half_pallet = tile.get("m2_per_half_pallet")
    # Default half = ½ of full when not explicitly set
    if m2_per_half_pallet is None and m2_per_pallet:
        try:
            v = float(m2_per_pallet)
            m2_per_half_pallet = round(v / 2.0, 2) if v > 0 else None
        except (TypeError, ValueError):
            m2_per_half_pallet = None
    
    # Get pricing unit (m2 or unit)
    pricing_unit = tile.get("pricing_unit", "m2")
    unit_price = tile.get("unit_price")
    
    # Get additional attributes (try both root-level and nested in attributes)
    attrs = tile.get("attributes", {})
    
    return {
        "id": str(tile.get("_id", "")),
        "supplier_code": tile.get("supplier_code", ""),
        "sku": tile.get("sku", tile.get("supplier_code", "")),
        "display_code": tile.get("display_code", ""),
        "display_name": tile.get("display_name", tile.get("name", "")),
        "slug": tile.get("slug", ""),
        "description": tile.get("description", ""),
        "short_description": tile.get("short_description", ""),
        "seo_keywords": tile.get("seo_keywords", ""),
        # Stealth alternate names — supplier-original product names
        # (e.g. "Opal", "LP-6611") that we want Google to index for
        # this listing without showing them in the customer-facing UI.
        # Consumed by the SSR enrich layer to populate JSON-LD
        # `alternateName` and a hidden semantic span. Customer-facing
        # components ignore this field entirely.
        "hidden_seo_keywords": tile.get("hidden_seo_keywords", ""),
        "original_name": tile.get("original_name", ""),
        "supplier": tile.get("supplier_name", ""),
        "room_lot_price": room_lot_price,
        "pallet_price": pallet_price,
        # Half + Full Pallet pricing (Feb 2026)
        # Customer must order at least m2_per_pallet / m2_per_half_pallet
        # m² to qualify for the corresponding £/m² rate. Frontend enforces
        # min via PDP chip selector; cart enforces on checkout.
        "half_pallet_price": half_pallet_price,
        "m2_per_pallet": m2_per_pallet,
        "m2_per_half_pallet": m2_per_half_pallet,
        "price": price_per_sqm,  # Default to room lot
        "price_per_tile": price_per_tile,
        "pallet_price_per_tile": pallet_price_per_tile,
        "tiles_per_sqm": tiles_per_sqm,
        "tile_area_m2": round(tile_area_m2, 4) if tile_area_m2 else None,
        "stock": tile.get("stock", 0),
        "stock_quantity": tile.get("stock", 0),
        "always_in_stock": tile.get("always_in_stock", False),
        # 14 May 2026 — surface the admin's manual stock_status override
        # (set via /supplier-sync/products/set-stock-status). Defaults
        # to None so the frontend can distinguish "admin hasn't touched"
        # from explicit "out_of_stock" / "low_stock" / "in_stock".
        "stock_status": tile.get("stock_status"),
        "images": tile.get("images", []),
        # If the admin has explicitly marked this SKU as out of stock,
        # ALWAYS surface in_stock=False even if a previous supplier sync
        # set always_in_stock=True. The manual override is authoritative.
        "in_stock": (
            False if tile.get("stock_status") == "out_of_stock"
            else (
                tile["in_stock"] if isinstance(tile.get("in_stock"), bool)
                else (tile.get("stock", 0) > 0 or tile.get("always_in_stock", False))
            )
        ),
        "attributes": attrs,
        "size": size_str,
        "finish": normalize_finish(tile.get("finish") or attrs.get("finish", "")),
        "color": _safe_str(tile.get("color") or attrs.get("color", "")),
        "material": _safe_str(tile.get("material") or attrs.get("material", "")),
        "category": tile.get("category", ""),
        # Additional specifications
        "series": tile.get("series") or tile.get("original_series", ""),
        "original_series": tile.get("original_series", ""),
        "thickness": _safe_str(tile.get("thickness") or attrs.get("thickness", "")),
        "suitability": _safe_str(tile.get("suitability") or attrs.get("suitability", "")),
        "edge": _safe_str(tile.get("edge") or attrs.get("edge", "")),
        "slip_rating": _safe_str(tile.get("slip_rating") or attrs.get("slip_rating", "")),
        # Pricing unit fields
        "pricing_unit": pricing_unit,
        "unit_price": unit_price,
        # Quote and tier settings
        "quote_disabled": tile.get("quote_disabled", False),
        "custom_quote_threshold": tile.get("custom_quote_threshold"),
        "tier_pricing_disabled": tile.get("tier_pricing_disabled", False),
        # Sale pricing (WAS/NOW display)
        "sale_active": tile.get("sale_active", False),
        "was_price": tile.get("was_price"),
        "was_markup_percent": tile.get("was_markup_percent"),
        "discount_percentage": tile.get("discount_percentage"),
        "sale_savings": tile.get("sale_savings"),
        "labels": tile.get("labels", []),
        # Box info for tile calculator
        "tiles_per_box": tile.get("tiles_per_box"),
        "sqm_per_box": tile.get("sqm_per_box") or tile.get("box_m2_coverage"),
        # Product display classification (see business_rules.py)
        # Surface Products show Tile Calculator, Technical Specs, etc.
        # Unit Products hide those sections
        "is_surface_product": bool(re.search(r'\d+\s*x\s*\d+', size_str, re.IGNORECASE)),
        # Product group for navigation filtering
        "product_group": tile.get("product_group", "tiles"),
        # Country of origin
        "made_in": tile.get("made_in", ""),
        # Trade pricing fields (for collection-level aggregation)
        "trade_discount": tile.get("trade_discount"),
        "trade_discount_type": tile.get("trade_discount_type") or "percent",
        "credit_back_rate": tile.get("credit_back_rate"),
    }


def serialize_tile_for_admin(tile: dict) -> dict:
    """Serialize tile product for admin display - includes supplier name"""
    return {
        "id": str(tile.get("_id", "")),
        "supplier_code": tile.get("supplier_code", ""),
        "display_name": tile.get("display_name", ""),
        "original_supplier_name": tile.get("original_supplier_name", tile.get("name", "")),
        "slug": tile.get("slug", ""),
        "supplier": tile.get("supplier_name", ""),
        "room_lot_price": tile.get("room_lot_price", 0),
        "pallet_price": tile.get("pallet_price", 0),
        "stock": tile.get("stock", 0),
        "images": tile.get("images", []),
        "attributes": tile.get("attributes", {}),
        "category": tile.get("category", ""),
        "last_synced": tile.get("last_synced"),
        "images_migrated": tile.get("images_migrated", False),
    }


# ============ PUBLIC TILE ROUTES ============

@router.get("/products")
@bulletproof_endpoint(
    cache_namespace="tiles_products",
    empty_check=lambda r: not (isinstance(r, dict) and r.get("products")),
    empty_fallback={"products": [], "total": 0, "page": 1, "limit": 24, "total_pages": 1},
)
async def get_tile_products(
    search: Optional[str] = None,
    supplier: Optional[str] = None,
    size: Optional[str] = None,
    finish: Optional[str] = None,
    color: Optional[str] = None,
    material: Optional[str] = None,
    min_price: Optional[float] = None,
    max_price: Optional[float] = None,
    in_stock_only: bool = False,
    sort_by: str = "name",  # name, price_asc, price_desc
    page: int = 1,
    limit: int = 24
):
    """Get tile products for public shop"""
    db = get_tile_db()
    
    # Build query
    query = {}
    
    if search:
        query["$or"] = [
            {"display_name": {"$regex": search, "$options": "i"}},
            {"original_supplier_name": {"$regex": search, "$options": "i"}},
            {"supplier_code": {"$regex": search, "$options": "i"}}
        ]
    
    if supplier:
        query["supplier_name"] = {"$regex": supplier, "$options": "i"}
    
    if size:
        query.setdefault("$and", []).append({"$or": [
            {"size": {"$regex": size, "$options": "i"}},
            {"attributes.size": {"$regex": size, "$options": "i"}}
        ]})
    
    if finish:
        query.setdefault("$and", []).append({"$or": [
            {"finish": {"$regex": finish, "$options": "i"}},
            {"attributes.finish": {"$regex": finish, "$options": "i"}}
        ]})
    
    if color:
        query.setdefault("$and", []).append({"$or": [
            {"color": {"$regex": color, "$options": "i"}},
            {"attributes.color": {"$regex": color, "$options": "i"}}
        ]})
    
    if material:
        query["attributes.material"] = {"$regex": material, "$options": "i"}
    
    if min_price is not None:
        query["room_lot_price"] = {"$gte": min_price}
    
    if max_price is not None:
        if "room_lot_price" in query:
            query["room_lot_price"]["$lte"] = max_price
        else:
            query["room_lot_price"] = {"$lte": max_price}
    
    if in_stock_only:
        query["stock"] = {"$gt": 0}
    
    # Sorting
    sort_field = "display_name"
    sort_order = 1
    if sort_by == "price_asc":
        sort_field = "room_lot_price"
        sort_order = 1
    elif sort_by == "price_desc":
        sort_field = "room_lot_price"
        sort_order = -1
    
    # Get total count
    total = db.tiles.count_documents(query)
    
    # Get products with pagination
    skip = (page - 1) * limit
    products = list(db.tiles.find(query).sort(sort_field, sort_order).skip(skip).limit(limit))
    
    return {
        "products": [serialize_tile_for_shop(p) for p in products if p],
        "total": total,
        "page": page,
        "limit": limit,
        "total_pages": (total + limit - 1) // limit
    }


@router.get("/products/{slug}")
async def get_tile_by_slug(slug: str):
    """Get single tile by slug for product detail page"""
    db = get_tile_db()
    
    tile = db.tiles.find_one({"slug": slug})
    if not tile:
        raise HTTPException(status_code=404, detail="Tile not found")
    
    return serialize_tile_for_shop(tile)


@router.get("/products/{slug}/collection-info")
async def get_tile_collection_info(slug: str):
    """Get the collection name for a tile, so the frontend can redirect to the collection page"""
    db = get_tile_db()
    
    tile = db.tiles.find_one({"slug": slug}, {"_id": 0, "display_name": 1, "name": 1, "original_series": 1, "series": 1})
    if not tile:
        raise HTTPException(status_code=404, detail="Tile not found")
    
    # Use admin-set series name first, then extract from display name
    name = tile.get("display_name") or tile.get("name") or ""
    collection_name = tile.get("original_series") or tile.get("series")
    
    if not collection_name:
        # Extract series from product name (everything before dimensions)
        import re as _re
        parts = name.strip().split()
        series_parts = []
        for part in parts:
            if _re.match(r'^\d+(\.\d+)?[xX]\d+', part):
                break
            if _re.match(r'^\d+mm$', part, _re.IGNORECASE):
                continue
            series_parts.append(part)
        collection_name = ' '.join(series_parts) if series_parts else name
    
    return {
        "collection_name": collection_name,
        "product_slug": slug,
        "product_name": name
    }


@router.get("/product-by-code/{supplier_code}")
async def get_tile_by_code(supplier_code: str):
    """Get single tile by supplier code"""
    db = get_tile_db()
    
    tile = db.tiles.find_one({"supplier_code": supplier_code})
    if not tile:
        raise HTTPException(status_code=404, detail="Tile not found")
    
    return serialize_tile_for_shop(tile)


@router.get("/filters")
@bulletproof_endpoint(
    cache_namespace="tiles_filters",
    empty_check=lambda r: not (isinstance(r, dict) and (r.get("suppliers") or r.get("sizes") or r.get("colors"))),
    empty_fallback={"suppliers": [], "sizes": [], "finishes": [], "colors": [], "materials": [], "price_range": {"min": 0, "max": 100}},
)
async def get_tile_filters():
    """Get available filter options for tiles"""
    db = get_tile_db()
    
    # Get unique values for each filter
    suppliers = db.tiles.distinct("supplier_name")
    sizes = [s for s in db.tiles.distinct("attributes.size") if s]
    finishes = [f for f in db.tiles.distinct("attributes.finish") if f]
    colors = [c for c in db.tiles.distinct("attributes.color") if c]
    materials = [m for m in db.tiles.distinct("attributes.material") if m]
    
    # Get price range
    pipeline = [
        {"$group": {
            "_id": None,
            "min_price": {"$min": "$room_lot_price"},
            "max_price": {"$max": "$room_lot_price"}
        }}
    ]
    price_range = list(db.tiles.aggregate(pipeline))
    
    return {
        "suppliers": sorted([s for s in suppliers if s]),
        "sizes": sorted(sizes),
        "finishes": sorted(finishes),
        "colors": sorted(colors),
        "materials": sorted(materials),
        "price_range": {
            "min": price_range[0]["min_price"] if price_range else 0,
            "max": price_range[0]["max_price"] if price_range else 100
        }
    }



@router.get("/debug/data-check")
async def debug_data_check():
    """Temporary diagnostic endpoint to check production data types"""
    db = get_tile_db()
    total = db.tiles.count_documents({})
    
    # Check field types  
    pipeline = [
        {"$group": {
            "_id": {
                "finish_type": {"$type": "$finish"},
                "color_type": {"$type": "$color"},
                "size_type": {"$type": "$size"},
                "product_group": "$product_group"
            },
            "count": {"$sum": 1}
        }}
    ]
    type_info = list(db.tiles.aggregate(pipeline))
    
    # Get a sample product name
    sample = db.tiles.find_one({}, {"_id": 0, "display_name": 1, "name": 1, "finish": 1, "color": 1, "size": 1, "product_group": 1, "attributes": 1})
    
    # Get product groups
    groups = list(db.tiles.aggregate([
        {"$group": {"_id": "$product_group", "count": {"$sum": 1}}}
    ]))
    
    return {
        "total_tiles": total,
        "field_types": [{"types": t["_id"], "count": t["count"]} for t in type_info],
        "product_groups": [{"group": g["_id"], "count": g["count"]} for g in groups],
        "sample_product": sample
    }


@router.get("/collections")
async def get_tile_collections(
    request: Request,
    supplier: Optional[str] = None,
    category: Optional[str] = None,
    filter: Optional[str] = None,
    size: Optional[str] = None,
    color: Optional[str] = None,
    finish: Optional[str] = None,
    material: Optional[str] = None,
    room_suitability: Optional[str] = None,
    in_stock: Optional[str] = None,
    sale: Optional[str] = None,
    group: Optional[str] = None,
    search: Optional[str] = None,
    page: int = 1,
    limit: int = 24
):
    """
    Get tile products grouped by series/collection for Claybrook-style layout.
    Groups products by series name (extracted from product name before dimensions).
    Returns collection cards with lifestyle images and color swatches.
    
    Filters:
    - category: Filter by category slug (e.g., "wall-tiles", "floor-tiles")
    - filter: Filter in format "field:value" (e.g., "finish:polished", "sale:true")
    - size: Direct size filter (e.g., "120x120cm")
    - color: Direct color filter (e.g., "Grey")
    - finish: Direct finish filter (e.g., "Matt")
    - material: Direct material filter (e.g., "Porcelain")
    - in_stock: Filter to only show in-stock items ("true")
    """
    import logging
    import traceback
    from fastapi.responses import JSONResponse

    # 60s in-memory cache — first-paint drops from 2.8s to <50ms for every
    # visitor except the unlucky one-in-sixty who triggers a refresh.
    # Cache key includes EVERY filter so different category/sale/group views
    # don't collide. Auth-dependent fields (trade pricing) are NOT in this
    # response, so caching is safe across logged-in vs. anonymous visitors.
    from utils.endpoint_cache import endpoint_cache
    _cache_key = endpoint_cache.key(
        "tiles_collections",
        supplier=supplier, category=category, filter=filter, size=size,
        color=color, finish=finish, material=material,
        room_suitability=room_suitability, in_stock=in_stock, sale=sale,
        group=group, search=search, page=page, limit=limit,
    )
    # Long-lived "last known good" backup — survives the short 60s
    # cache window so that even if the impl crashes for hours we keep
    # serving the last successful response instead of a blank page.
    _lkg_key = f"lkg:{_cache_key}"

    # Browser + Cloudflare cache strategy:
    #   • max-age=60        — browser keeps response fresh for 1 min.
    #   • s-maxage=300      — Cloudflare/edge keeps it for 5 min (the CDN
    #                          serves it instantly to ALL visitors hitting
    #                          that POP, not just the one who warmed it).
    #   • stale-while-revalidate=3600 — for the next hour the edge MAY
    #                          serve a slightly stale response while it
    #                          refreshes in the background, so the
    #                          customer never waits on a cold cache miss.
    # Net effect: TTFB for /api/tiles/collections drops from ~600ms (UK→
    # us-west2 round trip) to ~30ms (UK customer → London CDN edge).
    public_cache_headers = {
        "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=3600",
        "Vary": "Accept-Encoding",
    }
    # Headers used when we're returning empty/error/fallback data — tell
    # every cache layer (browser, Cloudflare, Fastly, Railway edge) NOT to
    # store this so the next request immediately re-tries the live query.
    no_store_headers = {
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Pragma": "no-cache",
        "Vary": "Accept-Encoding",
    }

    _cached = endpoint_cache.get(_cache_key)
    if _cached is not None:
        return JSONResponse(content=_cached, headers=public_cache_headers)

    try:
        result = await _get_tile_collections_impl(
            request, supplier, category, filter, size, color, finish,
            material, room_suitability, in_stock, sale, group, search, page, limit
        )
        # Only cache successful, NON-EMPTY responses. Empty results get
        # `no-store` headers so a transient blip can never poison the CDN
        # for up to 5 minutes (which is what triggered today's outage).
        is_empty = (
            not isinstance(result, dict)
            or not result.get("collections")
        )
        if is_empty:
            # Fall back to last-known-good if we have one — better to serve
            # slightly-stale tiles than an empty "0 collections" page.
            stale = endpoint_cache.get_stale(_lkg_key)
            if stale is not None:
                logging.warning(f"Collections empty/missing — serving last-known-good for key={_cache_key[:32]}")
                return JSONResponse(content=stale, headers=no_store_headers)
            return JSONResponse(content=result, headers=no_store_headers)
        # Healthy non-empty response — cache short-term AND save as LKG.
        endpoint_cache.set(_cache_key, result, ttl=60)
        endpoint_cache.set_long(_lkg_key, result, ttl=86400)
        return JSONResponse(content=result, headers=public_cache_headers)
    except Exception:
        logging.error(f"Collections endpoint crash: {traceback.format_exc()}")
        # CRITICAL: never let an exception turn into "0 collections" for
        # customers. Serve last-known-good if we have one; only emit a
        # 503 if we have absolutely nothing to fall back to.
        stale = endpoint_cache.get_stale(_lkg_key)
        if stale is not None:
            logging.warning(f"Serving last-known-good after exception for key={_cache_key[:32]}")
            return JSONResponse(content=stale, headers=no_store_headers)
        return JSONResponse(
            status_code=503,
            content={
                "collections": [],
                "total": 0,
                "total_products": 0,
                "page": page,
                "limit": limit,
                "total_pages": 1,
                "error": "temporarily_unavailable",
                "retry_after_seconds": 5,
            },
            headers={**no_store_headers, "Retry-After": "5"},
        )


async def _get_tile_collections_impl(
    request, supplier, category, filter, size, color, finish,
    material, room_suitability, in_stock, sale, group, search, page, limit
):
    try:
        import business_config.business_rules as br
    except Exception as e:
        import logging
        logging.error(f"Failed to import business_rules: {e}")
        br = None
    
    db = get_tile_db()
    
    # Build match query
    match_query = {}
    
    # Text search filter
    if search:
        search_regex = {"$regex": search, "$options": "i"}
        match_query["$or"] = [
            {"name": search_regex},
            {"display_name": search_regex},
            {"series": search_regex},
            {"collection_name": search_regex},
            {"supplier_name": search_regex},
        ]
    
    # Category filter (internal - not shown to users)
    if supplier:
        match_query["supplier_name"] = {"$regex": supplier, "$options": "i"}
    
    # Category filter (from admin-managed categories)
    if category:
        # DYNAMIC CATEGORY ROUTING
        # Primary: Look up actual category name from website_categories by slug
        # This ensures ANY future category works automatically without code changes
        category_doc = db.website_categories.find_one({"slug": category}, {"name": 1, "_id": 0})
        actual_category_name = category_doc["name"] if category_doc else None
        
        # Build fallback search patterns from slug
        category_search = category.replace("-", " ")
        category_search_regex = category_search.replace(" and ", "( and | & | & )")
        category_search_amp = category_search.replace(" and ", " & ")
        
        # Legacy hardcoded attribute mappings (kept for backwards compatibility
        # with products that don't have sub_categories set yet)
        legacy_attribute_mappings = {
            "wall-tiles": {"attributes.type": {"$regex": "wall", "$options": "i"}},
            "floor-tiles": {"attributes.type": {"$regex": "floor", "$options": "i"}},
            "outdoor-tiles": {"attributes.suitability": {"$regex": "outdoor", "$options": "i"}},
            "bathroom-tiles": {"rooms": "Bathroom"},
            "kitchen-tiles": {"rooms": "Kitchen"},
            "porcelain": {"material": "Porcelain"},
            "ceramic": {"material": "Ceramic"},
            "natural-stone": {"material": {"$regex": "stone|marble|slate", "$options": "i"}},
        }
        
        # Build the $or conditions — ordered by reliability
        or_conditions = []
        
        # 1. Exact match on sub_categories using actual DB name (most reliable)
        if actual_category_name:
            or_conditions.append({"sub_categories": actual_category_name})
        
        # 2. Legacy attribute mapping (for older products without sub_categories)
        if category in legacy_attribute_mappings:
            or_conditions.append(legacy_attribute_mappings[category])
        
        # 3. Regex fallbacks on sub_categories (handles slight naming variations)
        or_conditions.append({"sub_categories": {"$regex": category_search_regex, "$options": "i"}})
        if category_search_amp != category_search:
            or_conditions.append({"sub_categories": {"$regex": category_search_amp, "$options": "i"}})
        if actual_category_name:
            escaped_name = actual_category_name.replace("&", "\\&").replace("(", "\\(").replace(")", "\\)")
            or_conditions.append({"sub_categories": {"$regex": escaped_name, "$options": "i"}})
        
        # 4. Regex on other fields (category, categories, material, rooms)
        or_conditions.append({"category": {"$regex": category_search, "$options": "i"}})
        if actual_category_name:
            or_conditions.append({"category": actual_category_name})
            or_conditions.append({"categories": actual_category_name})
        or_conditions.append({"categories": {"$regex": category_search, "$options": "i"}})
        or_conditions.append({"material": {"$regex": category_search, "$options": "i"}})
        or_conditions.append({"rooms": {"$regex": category_search, "$options": "i"}})
        
        cat_conditions = {"$or": or_conditions}
        
        if "$and" not in match_query:
            match_query["$and"] = []
        match_query["$and"].append(cat_conditions)
    
    # Direct filter parameters from FilterPanel
    if size:
        size_values = [s.strip() for s in size.split(',') if s.strip()]
        if len(size_values) == 1:
            match_query.setdefault("$and", []).append({"$or": [
                {"size": {"$regex": size_values[0], "$options": "i"}},
                {"attributes.size": {"$regex": size_values[0], "$options": "i"}}
            ]})
        elif len(size_values) > 1:
            or_clauses = []
            for s in size_values:
                or_clauses.append({"size": {"$regex": s, "$options": "i"}})
                or_clauses.append({"attributes.size": {"$regex": s, "$options": "i"}})
            match_query.setdefault("$and", []).append({"$or": or_clauses})
    
    if color:
        color_values = [c.strip() for c in color.split(',') if c.strip()]
        if len(color_values) == 1:
            match_query.setdefault("$and", []).append({"$or": [
                {"color": {"$regex": color_values[0], "$options": "i"}},
                {"attributes.color": {"$regex": color_values[0], "$options": "i"}}
            ]})
        elif len(color_values) > 1:
            or_clauses = []
            for cv in color_values:
                or_clauses.append({"color": {"$regex": cv, "$options": "i"}})
                or_clauses.append({"attributes.color": {"$regex": cv, "$options": "i"}})
            match_query.setdefault("$and", []).append({"$or": or_clauses})
    
    if finish:
        finish_values = [f.strip() for f in finish.split(',') if f.strip()]
        if len(finish_values) == 1:
            match_query.setdefault("$and", []).append({"$or": [
                {"finish": {"$regex": finish_values[0], "$options": "i"}},
                {"attributes.finish": {"$regex": finish_values[0], "$options": "i"}}
            ]})
        elif len(finish_values) > 1:
            or_clauses = []
            for fv in finish_values:
                or_clauses.append({"finish": {"$regex": fv, "$options": "i"}})
                or_clauses.append({"attributes.finish": {"$regex": fv, "$options": "i"}})
            match_query.setdefault("$and", []).append({"$or": or_clauses})
    
    if material:
        material_values = [m.strip() for m in material.split(',') if m.strip()]
        if len(material_values) == 1:
            match_query["material"] = {"$regex": material_values[0], "$options": "i"}
        elif len(material_values) > 1:
            match_query["$or"] = match_query.get("$or", []) or []
            for mv in material_values:
                match_query["$or"].append({"material": {"$regex": mv, "$options": "i"}})
    
    if room_suitability:
        room_values = [r.strip() for r in room_suitability.split(',') if r.strip()]
        match_query["rooms"] = {"$in": room_values}
    
    if in_stock and in_stock.lower() == 'true':
        match_query["stock_quantity"] = {"$gt": 0}
    
    # Product group filter - isolate collections by group
    if group:
        # Match product_group OR main_category (supports both old and new data)
        group_regex = group.replace("-", "[ -]?")
        group_conditions = {"$or": [
            {"product_group": group},
            {"product_group": {"$regex": group_regex, "$options": "i"}},
            {"main_category": {"$regex": group_regex, "$options": "i"}},
        ]}
        if "$and" not in match_query:
            match_query["$and"] = []
        match_query["$and"].append(group_conditions)
    
    # Custom filter (format: "field:value") - legacy support
    if filter:
        try:
            field, value = filter.split(":", 1)
            filter_mappings = {
                "finish": {"attributes.finish": {"$regex": value, "$options": "i"}},
                "material": {"material": {"$regex": value, "$options": "i"}},
                "color": {"color": {"$regex": value, "$options": "i"}},
                "size": {"attributes.size": {"$regex": value, "$options": "i"}},
                "sale": {"labels": {"$in": ["SALE", "Sale", "sale"]}},
                "new": {"labels": {"$in": ["NEW", "New", "new"]}},
                "bestseller": {"labels": {"$in": ["BESTSELLER", "Bestseller", "bestseller"]}},
                "style": {"attributes.style": {"$regex": value, "$options": "i"}},
                "stock": {"stock_quantity": {"$gt": 0}} if value.lower() == "true" else {},
                "price": {},  # Handle price filter separately
            }
            if field == "price" and "-" in value:
                try:
                    min_price, max_price = value.split("-")
                    price_query = {}
                    if min_price:
                        price_query["$gte"] = float(min_price)
                    if max_price:
                        price_query["$lte"] = float(max_price)
                    if price_query:
                        match_query["room_lot_price"] = price_query
                except (ValueError, TypeError):
                    pass
            elif field in filter_mappings and filter_mappings[field]:
                match_query.update(filter_mappings[field])
        except ValueError:
            pass  # Invalid filter format, ignore
    
    # Standalone sale parameter (from SALE tab)
    if sale and sale.lower() == "true":
        match_query["labels"] = {"$in": ["SALE", "Sale", "sale"]}
    
    # Get all products with minimal fields for grouping
    products = list(db.tiles.find(
        match_query,
        {
            "_id": 0,
            "display_name": 1,
            "name": 1,
            "slug": 1,
            "color": 1,
            "finish": 1,
            "attributes": 1,
            "room_lot_price": 1,
            "supplier_name": 1,
            "images": 1,
            "labels": 1,
            "size": 1,
            "tier_pricing_disabled": 1,
            "tier_discounts": 1,
            "has_custom_tier_pricing": 1,
            "price": 1,
            "pricing_unit": 1,
            "product_group": 1,
            "was_markup_percent": 1,
            "sale_active": 1,
            "was_price": 1,
            "made_in": 1,
            "trade_discount": 1,
            "credit_back_rate": 1,
            "series": 1,
            "original_series": 1
        }
    ))
    
    # Group products by series name in Python
    from collections import defaultdict
    
    # Common color words to strip from series names for better grouping
    COLOR_WORDS = {
        # Basic colors
        'white', 'grey', 'gray', 'black', 'beige', 'cream', 'brown', 'blue', 'green',
        'red', 'pink', 'yellow', 'orange', 'purple', 'silver', 'gold', 'ivory',
        'charcoal', 'anthracite', 'taupe', 'sand', 'bone', 'pearl', 'light', 'dark',
        # Italian colors
        'crema', 'bianco', 'grigio', 'nero', 'avorio', 'noce', 'cenere', 'pietra',
        'polvere', 'verde', 'rosa', 'marfil',
        # Spanish colors
        'blanco', 'gris', 'perla', 'ceniza', 'grafito', 'hueso', 'arena',
        'marengo', 'roble', 'terra', 'acacia', 'arce', 'nuez',
        # Decorative / pattern (used as tile variant names)
        'decor', 'feature', 'border', 'listello',
        # Color modifiers
        'brilliant', 'bright', 'jet', 'royal', 'midnight', 'pale', 'deep', 'ultra',
        # Blue/ocean tones
        'sky', 'ocean', 'aqua', 'teal', 'azure', 'cobalt', 'turquoise', 'indigo',
        'denim', 'navy', 'jean',
        # Green tones
        'sage', 'olive', 'emerald', 'mint', 'forest', 'moss',
        # Pink/red tones
        'coral', 'salmon', 'blush', 'rose', 'orchid', 'magenta',
        'burgundy', 'maroon', 'garnet', 'bordeaux', 'ruby', 'wine', 'claret',
        # Brown/warm tones
        'rust', 'terracotta', 'copper', 'bronze', 'brass', 'amber', 'honey', 'caramel',
        'walnut', 'chocolate', 'coffee', 'mocha', 'tobacco', 'cinnamon', 'chestnut',
        # Grey/neutral tones
        'smoke', 'ash', 'graphite', 'slate', 'onyx', 'ice', 'snow', 'carbon',
        'smoky', 'greige', 'platinum', 'titanium', 'pewter', 'lead',
        # Purple tones
        'violet', 'lilac', 'lavender', 'mauve', 'lemon',
        # Descriptive color words (used as tile color variants, not series)
        'pigment', 'leaf', 'romantic', 'storm', 'pepper', 'blonde', 'golden',
        'warm', 'cool', 'soft', 'fumes', 'lawa', 'thunder',
        # Marble/stone color variant names
        'breccia', 'carrara',
        'natural', 'stone', 'earth', 'clay',
        # Italian blue
        'blu',
        # Misc color-like words
        'alga', 'invisible', 'sugar', 'brillo',
        'antrecide',
    }
    
    # Extended color keywords for color extraction (mirrors frontend)
    COLOR_KEYWORDS = {
        'white', 'ivory', 'cream', 'beige', 'sand', 'bone', 'pearl', 'crema', 'bianco',
        'grey', 'gray', 'silver', 'charcoal', 'graphite', 'ash', 'smoke', 'slate', 'grigio', 'ice', 'snow',
        'black', 'anthracite', 'onyx', 'nero', 'dark', 'carbon',
        'brown', 'walnut', 'chocolate', 'coffee', 'bronze', 'copper', 'taupe', 'mocha', 'tobacco',
        'blue', 'navy', 'aqua', 'teal', 'ocean', 'azure', 'cobalt', 'sky', 'turquoise', 'indigo', 'denim', 'jean', 'blu',
        'green', 'sage', 'olive', 'emerald', 'forest', 'moss', 'mint', 'verde',
        'pink', 'rose', 'blush', 'coral', 'salmon', 'orchid', 'rosa',
        'red', 'terracotta', 'rust', 'burgundy', 'maroon', 'garnet',
        'gold', 'golden', 'brass', 'amber', 'honey', 'caramel', 'lemon',
        'purple', 'lilac', 'lavender', 'mauve', 'violet', 'magenta',
        'natural', 'stone', 'earth', 'clay', 'greige', 'platinum',
        'noce', 'cenere', 'perla', 'gris', 'blanco', 'marfil', 'bordeaux',
    }
    
    def extract_color_from_name(product_name):
        """Extract last color keyword from product name before dimensions.
        Mirrors frontend extractColorFromName logic exactly."""
        if not product_name:
            return None
        parts = product_name.strip().split()
        last_color = None
        for part in parts:
            if re.match(r'^\d+[xX]\d+', part):
                break
            if part.lower() in COLOR_KEYWORDS:
                last_color = part.capitalize()
        return last_color
    
    def get_product_color(product):
        """Get color ONLY from explicitly saved DB field. Never extract from product name."""
        color = product.get("color") or product.get("attributes", {}).get("color", "")
        color = _safe_str(color)
        if color and color.strip():
            return color.strip()
        return None
    
    # Words that are product attributes/descriptors (not series identifiers) — skipped during grouping
    ATTRIBUTE_WORDS = {
        # Location/use
        'outdoor', 'indoor', 'external', 'internal', 'anti-slip', 'antislip',
        # Finish types
        'rectified', 'unrectified', 'honed', 'lappato', 'lapato', 'structured',
        'polished', 'matt', 'matte', 'gloss', 'glossy', 'satin', 'silk', 'rustic',
        'linear', 'plain', 'scored', 'textured', 'embossed', 'riven', 'tumbled',
        'brushed', 'glazed', 'unglazed', 'smooth', 'flamed', 'hammered', 'bush-hammered',
        'oiled', 'lacquered', 'whitewashed', 'smoked', 'unfinished', 'sanded',
        'carving', 'high-gloss', 'semi', 'waxed', 'primed',
        'brillo', 'mate',  # Spanish for gloss/matte
        # Style/pattern descriptors
        'savage', 'garden', 'mosaic', 'patchwork', 'stripe', 'chevron', 'herringbone',
        'hexagon', 'split', 'face', 'endless', 'deluxe', 'lounge', 'unique',
        'square', 'flat', 'bumpy', 'bevelled', 'round',
        # Product type suffixes (never part of a series name)
        'tiles', 'tile', 'wall', 'floor', 'and', 'slabs', 'slab',
        # Material/effect descriptors
        'effect', 'marble', 'wood', 'concrete', 'ceramic', 'metro',
        'quarry', 'travertine', 'terrazzo', 'porcelain', 'patterned',
        'laminate', 'engineered', 'lvt', 'plank', 'straight',
    }
    
    def extract_series_name(product_name):
        """Extract series name from product name (everything before dimensions, without color/attribute suffix).
        E.g. 'Ardesia Slate Beige 20mm Outdoor 40x80cm Matt' -> 'Ardesia Slate'
        For materials: 'Cleaning & Maintenance - Easy Clean Tile Protector 1L' -> 'Cleaning & Maintenance'
        For materials without separator: 'ProGrout Flexible Almond 3kg' -> 'ProGrout Flexible'
        """
        if not product_name:
            return "Other"
        
        # Normalize accented characters for comparison (e.g., Décor → decor)
        import unicodedata
        def normalize_word(w):
            return unicodedata.normalize('NFD', w.lower()).encode('ascii', 'ignore').decode('ascii')
        
        # If name contains ' - ' separator (common in materials/tools/accessories),
        # use the part before it as the series name for grouping
        if ' - ' in product_name:
            prefix = product_name.split(' - ')[0].strip()
            if prefix:
                return prefix
        
        # Split by space and find where dimensions start
        parts = product_name.strip().split()
        
        # Pre-process: split concatenated word+dimension tokens (e.g., "Decor25x60cm" → "Decor" + "25x60cm")
        expanded_parts = []
        for part in parts:
            concat_match = re.match(r'^([A-Za-z]+)(\d+(\.\d+)?[xX]\d+.*)$', part)
            if concat_match:
                expanded_parts.append(concat_match.group(1))
                expanded_parts.append(concat_match.group(2))
            else:
                expanded_parts.append(part)
        parts = expanded_parts
        
        series_parts = []
        for part in parts:
            # Check if this part looks like dimensions (e.g., 60x60cm, 120X120, 21.6x21.6, etc.)
            if re.match(r'^\d+(\.\d+)?[xX]\d+', part):
                break
            # Skip thickness patterns (e.g., 20mm, 10mm) — these are attributes, not series
            if re.match(r'^\d+mm$', part, re.IGNORECASE):
                continue
            # Skip unit size patterns (e.g., 3kg, 10kg, 1L, 500ml, 5ltr, 2.5L) — these are product variants, not series
            if re.match(r'^\d+(\.\d+)?\s*(kg|g|L|l|ml|ltr|litre|litres|mtr|m)$', part, re.IGNORECASE):
                continue
            # Skip attribute words (e.g., Outdoor, Indoor, Polished, Linear)
            if normalize_word(part) in ATTRIBUTE_WORDS:
                continue
            series_parts.append(part)
        
        if not series_parts:
            return product_name
        
        # Remove trailing color words to group color variants together
        # e.g., "Dolomite Grey" -> "Dolomite", "Dolomite White" -> "Dolomite"
        while series_parts and normalize_word(series_parts[-1]) in COLOR_WORDS:
            series_parts.pop()
        
        if not series_parts:
            # If only color/finish words were there, use original first 2 words
            return ' '.join(product_name.strip().split()[:2])
        
        return ' '.join(series_parts)
    
    series_groups = defaultdict(lambda: {
        "products": [],
        "colors": set(),
        "sizes": set(),
        "finishes": set(),
        "prices": [],
        "best_prices": [],  # Maximum discounted tier prices
        "images": [],
        "labels": set(),
        "supplier": None,
        "max_tier_discount": 0,
        "max_was_markup": 0,
        "max_was_price": 0,
        "max_sale_discount_pct": 0,  # Max per-product sale discount % (was_price vs price, same product)
        "all_tier_disabled": True,  # True if ALL products in group have tier pricing disabled
        "made_in": None
    })
    
    for p in products:
        try:
            name = p.get("display_name") or p.get("name") or ""
            # Use admin-set series name if available, otherwise extract from product name
            series_name = p.get("series") or p.get("original_series") or extract_series_name(name)
            group = series_groups[series_name]
            
            group["products"].append(p)
            
            # Collect review count (take maximum from any product in the group)
            rc = p.get("review_count", 0) or 0
            if rc > group.get("review_count", 0):
                group["review_count"] = rc
            
            # Collect color - from spec field first, then fallback to name extraction
            color = p.get("color") or p.get("attributes", {}).get("color", "")
            if isinstance(color, list):
                color = color[0] if color else ""
            if not isinstance(color, str):
                color = str(color) if color else ""
            if not color or not color.strip():
                color = extract_color_from_name(p.get("display_name") or p.get("name") or "")
            if color:
                group["colors"].add(color.strip())
            
            # Collect size - from spec field first, then attributes
            size = p.get("size") or p.get("attributes", {}).get("size", "")
            if isinstance(size, list):
                size = size[0] if size else ""
            if not isinstance(size, str):
                size = str(size) if size else ""
            if size:
                group["sizes"].add(size)
            
            # Collect finish - from spec field first, then attributes
            finish = normalize_finish(p.get("finish") or p.get("attributes", {}).get("finish", ""))
            if finish:
                group["finishes"].add(finish)
            
            # Collect price
            price = p.get("room_lot_price") or p.get("price") or 0
            if price:
                group["prices"].append(price)
                # Calculate best tier price (maximum discounted price)
                # Skip tier discount ONLY for products with tier pricing explicitly disabled
                if p.get("tier_pricing_disabled"):
                    group["best_prices"].append(price)
                else:
                    group["all_tier_disabled"] = False
                    tier_discounts = p.get("tier_discounts", [5, 10, 15, 20])
                    max_discount = max(tier_discounts) if tier_discounts else 20
                    best_tier_price = round(price * (1 - max_discount / 100), 2)
                    group["best_prices"].append(best_tier_price)
                    if max_discount > group["max_tier_discount"]:
                        group["max_tier_discount"] = max_discount
            
            # Track was_markup_percent for sale products
            was_markup = p.get("was_markup_percent", 0) or 0
            if was_markup > group["max_was_markup"]:
                group["max_was_markup"] = was_markup
            was_price_val = p.get("was_price", 0) or 0
            if was_price_val > group["max_was_price"]:
                group["max_was_price"] = was_price_val
            
            # Compute per-product sale discount % (same product's was_price vs price)
            if was_price_val > 0 and price > 0 and was_price_val > price:
                product_sale_pct = round(((was_price_val - price) / was_price_val) * 100)
                if product_sale_pct > group["max_sale_discount_pct"]:
                    group["max_sale_discount_pct"] = product_sale_pct
            
            # Track country of origin
            made_in_val = p.get("made_in", "") or ""
            if made_in_val and not group["made_in"]:
                group["made_in"] = made_in_val
            
            # Collect images
            images = p.get("images", [])
            if images:
                group["images"].append(images[0])
            
            # Collect labels
            labels = p.get("labels", [])
            if labels:
                for label in labels:
                    if label:
                        group["labels"].add(label)
            
            # Set supplier
            if not group["supplier"]:
                group["supplier"] = p.get("supplier_name", "")
        except Exception as e:
            import logging
            logging.getLogger(__name__).warning(f"Error processing product {p.get('display_name', 'unknown')}: {e}")
            continue
    
    # Convert to list and sort by product count
    # --- MERGE PASS for material products ---
    # Material products (no dimensional sizes) may produce too-specific series names
    # e.g., "ProGrout Flexible Almond" and "ProGrout Flexible Limestone" should merge to "ProGrout Flexible"
    # Strategy: Find groups that share a common prefix (≥2 words) and none have dimensional sizes → merge them
    non_surface_keys = []
    surface_keys = []
    for series_name, group in series_groups.items():
        has_dimensions = any(
            bool(re.search(r'\d+\s*x\s*\d+', str(s), re.IGNORECASE))
            for p in group["products"]
            for s in [p.get("size", ""), p.get("display_name", ""), p.get("name", "")]
            if s
        )
        if has_dimensions:
            surface_keys.append(series_name)
        else:
            non_surface_keys.append(series_name)
    
    # For non-surface groups, find and merge those sharing a common prefix of ≥2 words
    if len(non_surface_keys) > 1:
        sorted_keys = sorted(non_surface_keys)
        merge_map = {}  # old_name -> canonical_prefix
        
        for i, key_a in enumerate(sorted_keys):
            if key_a in merge_map:
                continue
            words_a = key_a.split()
            if len(words_a) < 2:
                continue
            
            # Find all other keys that share a common prefix with key_a
            for key_b in sorted_keys[i+1:]:
                if key_b in merge_map:
                    continue
                words_b = key_b.split()
                # Find common prefix length
                common_len = 0
                for k in range(min(len(words_a), len(words_b))):
                    if words_a[k].lower() == words_b[k].lower():
                        common_len = k + 1
                    else:
                        break
                
                if common_len >= 2:
                    prefix = ' '.join(words_a[:common_len])
                    # Map both to the common prefix
                    if key_a not in merge_map:
                        merge_map[key_a] = prefix
                    else:
                        # Use the shorter prefix
                        existing = merge_map[key_a]
                        existing_words = existing.split()
                        if common_len < len(existing_words):
                            merge_map[key_a] = prefix
                    merge_map[key_b] = merge_map.get(key_a, prefix)
        
        # Apply merges
        if merge_map:
            new_series_groups = defaultdict(lambda: {
                "products": [], "colors": set(), "sizes": set(), "finishes": set(),
                "prices": [], "best_prices": [], "images": [], "labels": set(),
                "supplier": None, "max_tier_discount": 0, "max_was_markup": 0,
                "max_was_price": 0, "max_sale_discount_pct": 0, "all_tier_disabled": True, "made_in": None,
                "review_count": 0
            })
            
            for old_key, group in series_groups.items():
                new_key = merge_map.get(old_key, old_key)
                target = new_series_groups[new_key]
                target["products"].extend(group["products"])
                target["colors"].update(group["colors"])
                target["sizes"].update(group["sizes"])
                target["finishes"].update(group["finishes"])
                target["prices"].extend(group["prices"])
                target["best_prices"].extend(group["best_prices"])
                target["images"].extend(group["images"])
                target["labels"].update(group["labels"])
                if not target["supplier"] and group["supplier"]:
                    target["supplier"] = group["supplier"]
                target["max_tier_discount"] = max(target["max_tier_discount"], group["max_tier_discount"])
                target["max_was_markup"] = max(target["max_was_markup"], group["max_was_markup"])
                target["max_was_price"] = max(target["max_was_price"], group["max_was_price"])
                target["max_sale_discount_pct"] = max(target.get("max_sale_discount_pct", 0), group.get("max_sale_discount_pct", 0))
                if group.get("all_tier_disabled") is False:
                    target["all_tier_disabled"] = False
                if group.get("made_in") and not target["made_in"]:
                    target["made_in"] = group["made_in"]
                target["review_count"] = max(target.get("review_count", 0), group.get("review_count", 0))
            
            series_groups = new_series_groups

    # --- MERGE PASS for surface products with unique series names ---
    # Products like Canopy Herringbone have unique series per variant (Blenheim Oak, Chiltern Oak, etc.)
    # but should group together since they share size+material+supplier.
    # Strategy: merge single-product surface groups from the same supplier that share the same size+material.
    if len(surface_keys) > 1:
        single_surface = [k for k in surface_keys if len(series_groups[k]["products"]) == 1]
        if len(single_surface) >= 2:  # Merge when 2+ singles share the same size+material
            # Group singles by (supplier, size, material) to find natural collections
            from collections import defaultdict as _dd
            size_material_groups = _dd(list)
            for key in single_surface:
                p = series_groups[key]["products"][0]
                p_size = p.get("size") or p.get("attributes", {}).get("size", "")
                p_material = p.get("material") or p.get("attributes", {}).get("material", "")
                p_supplier = p.get("supplier_name") or ""
                if isinstance(p_size, list): p_size = p_size[0] if p_size else ""
                if p_size and p_material:
                    bucket_key = (p_supplier, str(p_size).strip(), str(p_material).strip())
                    size_material_groups[bucket_key].append(key)
            
            surface_merge_map = {}
            for (supplier, size, material), keys in size_material_groups.items():
                if len(keys) < 2:
                    continue
                # Generate a collection name from size + material (+ product type if available)
                # Try to extract a nice name from the product names
                sample_p = series_groups[keys[0]]["products"][0]
                p_name = sample_p.get("display_name") or sample_p.get("name") or ""
                # Extract everything from the dimension onwards as the shared descriptor
                dim_match = re.search(r'(\d+[xX]\d+[^\s]*\s+.*)', p_name)
                if dim_match:
                    shared_part = dim_match.group(1).strip()
                    # Clean up: remove trailing color/finish words
                    collection_name = shared_part
                else:
                    collection_name = f"{size} {material}"
                
                for key in keys:
                    surface_merge_map[key] = collection_name
            
            if surface_merge_map:
                new_series_groups2 = defaultdict(lambda: {
                    "products": [], "colors": set(), "sizes": set(), "finishes": set(),
                    "prices": [], "best_prices": [], "images": [], "labels": set(),
                    "supplier": None, "max_tier_discount": 0, "max_was_markup": 0,
                    "max_was_price": 0, "max_sale_discount_pct": 0, "all_tier_disabled": True, "made_in": None,
                    "review_count": 0
                })
                
                for old_key, group in series_groups.items():
                    new_key = surface_merge_map.get(old_key, old_key)
                    target = new_series_groups2[new_key]
                    target["products"].extend(group["products"])
                    target["colors"].update(group["colors"])
                    target["sizes"].update(group["sizes"])
                    target["finishes"].update(group["finishes"])
                    target["prices"].extend(group["prices"])
                    target["best_prices"].extend(group["best_prices"])
                    target["images"].extend(group["images"])
                    target["labels"].update(group["labels"])
                    if not target["supplier"] and group["supplier"]:
                        target["supplier"] = group["supplier"]
                    target["max_tier_discount"] = max(target["max_tier_discount"], group["max_tier_discount"])
                    target["max_was_markup"] = max(target["max_was_markup"], group["max_was_markup"])
                    target["max_was_price"] = max(target["max_was_price"], group["max_was_price"])
                    target["max_sale_discount_pct"] = max(target.get("max_sale_discount_pct", 0), group.get("max_sale_discount_pct", 0))
                    if group.get("all_tier_disabled") is False:
                        target["all_tier_disabled"] = False
                    if group.get("made_in") and not target["made_in"]:
                        target["made_in"] = group["made_in"]
                    target["review_count"] = max(target.get("review_count", 0), group.get("review_count", 0))
                
                series_groups = new_series_groups2

    
    collections_list = []
    for series_name, group in series_groups.items():
        product_count = len(group["products"])
        colors = list(group["colors"])
        
        # Generate variant swatches with product images
        # Rule: if ANY products have saved colours, show ONLY colours. Otherwise show first-word variants.
        color_swatches = []
        non_color_images = []
        seen_variants = set()
        
        # Check if any product in this group has a saved color
        any_have_color = any(get_product_color(p) for p in group["products"])
        
        for product in group["products"]:
            color = get_product_color(product)
            images = product.get("images", [])
            
            if any_have_color:
                # Colour mode: only show products with saved colours
                if not color:
                    continue
                variant_label = color
                variant_type = "color"
            else:
                # Name mode: use first word of display name
                display_name = product.get("display_name") or product.get("name") or ""
                first_word = display_name.strip().split()[0] if display_name.strip() else ""
                variant_label = first_word.lower() if first_word else ""
                variant_type = "name"
            
            if variant_label and variant_label not in seen_variants and images:
                seen_variants.add(variant_label)
                color_swatches.append({
                    "color": variant_label,
                    "hex": get_color_hex(variant_label) if color else None,
                    "image": images[0],
                    "product_slug": product.get("slug", ""),
                    "variant_type": variant_type
                })
            elif not variant_label and images:
                non_color_images.append({
                    "color": (product.get("display_name") or product.get("name") or "")[:30],
                    "image": images[0],
                    "product_slug": product.get("slug", ""),
                    "variant_type": "product"
                })
        
        # Build product_images: color entries first, then fill with non-color
        product_images = [{"color": s["color"], "image": s["image"], "product_slug": s["product_slug"]} for s in color_swatches]
        remaining_slots = 10 - len(product_images)
        if remaining_slots > 0:
            product_images.extend(non_color_images[:remaining_slots])
        
        # Determine the dominant variant type for the badge label
        variant_types = [s.get("variant_type", "color") for s in color_swatches]
        dominant_variant_type = "color"
        if variant_types:
            from collections import Counter as _Counter
            type_counts = _Counter(variant_types)
            dominant_variant_type = type_counts.most_common(1)[0][0]
        
        collections_list.append({
            "series_name": series_name,
            "product_count": product_count,
            "colors": colors,
            "sizes": list(group["sizes"]),
            "finishes": list(group["finishes"]),
            "variant_type": dominant_variant_type,  # "color", "finish", or "size"
            "variant_count": len(color_swatches),  # Total unique variants
            "min_price": min(group["prices"]) if group["prices"] else 0,
            "max_price": max(group["prices"]) if group["prices"] else 0,
            "prices_from": min(group["best_prices"]) if group["best_prices"] else 0,  # Best discounted price
            "supplier": group["supplier"],
            "auto_hero_image": group["images"][0] if group["images"] else None,
            "hero_image": group["images"][0] if group["images"] else None,  # Will be overridden by custom settings
            "images": group["images"][:5],
            "product_images": product_images[:8],  # Tile images for thumbnails
            "is_new": any(str(l).upper() in ("NEW", "NEW ARRIVAL") for l in group["labels"] if l),
            "has_new_sizes": any(str(l).upper() in ("NEW SIZES", "NEW SIZE") for l in group["labels"] if l),
            "is_sale": any(str(l).upper() in ("SALE", "ON SALE") for l in group["labels"] if l) or any(p.get("sale_active") for p in group["products"]),
            "labels": [str(l) for l in group["labels"] if l],  # All custom labels
            "review_count": group.get("review_count", 0),
            "first_product_slug": group["products"][0].get("slug", "") if group["products"] else "",
            "color_swatches": color_swatches[:8],
            "additional_colors": max(0, len(color_swatches) - 8),
            "max_tier_discount": group["max_tier_discount"],
            "max_was_markup": group["max_was_markup"],
            "max_was_price": group["max_was_price"] if group["max_was_price"] > 0 else None,
            "made_in": group["made_in"],
            # Product display classification: Surface Product if any size has dimensional pattern (NxN)
            # Empty sizes = Unit Product (no dimensional data = materials/tools/accessories)
            "is_surface_product": any(bool(re.search(r'\d+\s*x\s*\d+', str(s), re.IGNORECASE)) for s in group["sizes"] if s) if group["sizes"] else False,
            # Credit back rate: will be resolved from supplier_products below
            "credit_back_rate": None,
            # Trade discount: will be resolved from supplier_products below
            "trade_discount": None,
            "trade_discount_type": None,
            # Whether ALL products in this collection have tier pricing disabled
            "tier_pricing_disabled": group["all_tier_disabled"],
            "max_sale_discount_pct": group["max_sale_discount_pct"] if group["max_sale_discount_pct"] > 0 else None,
        })
    
    # Post-process: look up trade_discount & credit_back_rate from supplier_products (source of truth)
    # Always check supplier_products since admin saves go there, tiles may have stale values
    try:
        for col_data in collections_list:
            series_name = col_data["series_name"]
            grp = series_groups.get(series_name)
            if not grp:
                continue
            skus = [p.get("sku") or p.get("supplier_code") for p in grp["products"] if p.get("sku") or p.get("supplier_code")]
            if not skus:
                continue
            # Batch lookup from supplier_products
            sp_docs = list(db.supplier_products.find(
                {"sku": {"$in": skus}},
                {"_id": 0, "trade_discount": 1, "trade_discount_type": 1, "credit_back_rate": 1}
            ))
            for sp in sp_docs:
                if col_data["trade_discount"] is None and sp.get("trade_discount") is not None:
                    col_data["trade_discount"] = sp["trade_discount"]
                if col_data["trade_discount_type"] is None and sp.get("trade_discount_type"):
                    col_data["trade_discount_type"] = sp["trade_discount_type"]
                if col_data["credit_back_rate"] is None and sp.get("credit_back_rate") is not None:
                    col_data["credit_back_rate"] = sp["credit_back_rate"]
                if col_data["trade_discount"] is not None and col_data["credit_back_rate"] is not None and col_data["trade_discount_type"] is not None:
                    break
            
            # Fallback to tiles data if supplier_products didn't have it
            if col_data["trade_discount"] is None or col_data["credit_back_rate"] is None or col_data["trade_discount_type"] is None:
                for p in grp["products"]:
                    if col_data["trade_discount"] is None and p.get("trade_discount") is not None:
                        col_data["trade_discount"] = p["trade_discount"]
                    if col_data["trade_discount_type"] is None and p.get("trade_discount_type"):
                        col_data["trade_discount_type"] = p["trade_discount_type"]
                    if col_data["credit_back_rate"] is None and p.get("credit_back_rate") is not None:
                        col_data["credit_back_rate"] = p["credit_back_rate"]
                    if col_data["trade_discount"] is not None and col_data["credit_back_rate"] is not None and col_data["trade_discount_type"] is not None:
                        break
    except Exception as e:
        logger.warning(f"Error looking up supplier_products trade data: {e}")
    
    # Apply global defaults for any still-missing values
    default_td = getattr(br, 'TRADE_DISCOUNT_DEFAULT', 5) if br else 5
    default_cb = getattr(br, 'TRADE_CREDIT_BACK_DEFAULT', 2) if br else 2
    for col_data in collections_list:
        if col_data["trade_discount"] is None:
            col_data["trade_discount"] = default_td
        if col_data["credit_back_rate"] is None:
            col_data["credit_back_rate"] = default_cb
        if col_data["trade_discount_type"] is None:
            col_data["trade_discount_type"] = "percent"

    # Fetch custom collection settings from DB
    try:
        custom_settings = {}
        # Use synchronous find since tiles.py uses PyMongo (not async Motor)
        settings_list = list(db.collection_settings.find({}))
        for setting in settings_list:
            custom_settings[setting["series_name"]] = setting
        
        # Apply custom settings to collections
        filtered_collections = []
        for collection in collections_list:
            series_name = collection["series_name"]
            settings = custom_settings.get(series_name, {})
            
            # Skip hidden collections
            if settings.get("is_hidden", False):
                continue
            
            # Apply custom hero image if set
            if settings.get("custom_hero_image"):
                collection["hero_image"] = settings["custom_hero_image"]
                collection["has_custom_image"] = True
            
            # Apply other custom settings
            collection["is_featured"] = settings.get("is_featured", False)
            collection["display_order"] = settings.get("display_order", 0)
            if settings.get("custom_title"):
                collection["custom_title"] = settings["custom_title"]
            if settings.get("custom_description"):
                collection["custom_description"] = settings["custom_description"]
            
            filtered_collections.append(collection)
        
        collections_list = filtered_collections
    except Exception as e:
        # If fetching settings fails, continue with auto-generated data
        import logging
        logging.warning(f"Could not fetch collection settings: {e}")
    
    # Sort by featured status, display_order, then product count (descending)
    collections_list.sort(key=lambda x: (-x.get("is_featured", False), x.get("display_order", 0), -x["product_count"], x["series_name"]))
    
    # Calculate total products across all collections
    total_products = sum(c["product_count"] for c in collections_list)
    
    # Paginate
    total = len(collections_list)
    start_idx = (page - 1) * limit
    end_idx = start_idx + limit
    paginated = collections_list[start_idx:end_idx]

    return _jsonify_safe({
        "collections": paginated,
        "total": total,
        "total_products": total_products,
        "page": page,
        "limit": limit,
        "total_pages": (total + limit - 1) // limit if total > 0 else 1
    })


def _jsonify_safe(obj):
    """Recursively walk a dict/list and convert any value that JSON
    cannot serialize (datetime, ObjectId, Decimal, set, etc) to a
    safe primitive. Production hit a `TypeError: Object of type
    datetime is not JSON serializable` on /api/tiles/collections
    because some collection_settings docs had a stray datetime field
    that bled into the response. Without this guard a single bad
    DB row takes down the entire endpoint."""
    from datetime import datetime, date
    try:
        from bson import ObjectId  # type: ignore
    except Exception:
        ObjectId = None  # type: ignore
    from decimal import Decimal

    if isinstance(obj, dict):
        return {k: _jsonify_safe(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_jsonify_safe(v) for v in obj]
    if isinstance(obj, tuple):
        return [_jsonify_safe(v) for v in obj]
    if isinstance(obj, set):
        return [_jsonify_safe(v) for v in obj]
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    if ObjectId is not None and isinstance(obj, ObjectId):
        return str(obj)
    if isinstance(obj, Decimal):
        return float(obj)
    return obj


def get_color_hex(color_name: str) -> str:
    """Map color names to hex codes for swatches"""
    color_map = {
        "white": "#FFFFFF",
        "black": "#1a1a1a",
        "grey": "#808080",
        "gray": "#808080",
        "beige": "#D4C4B0",
        "cream": "#FFFDD0",
        "brown": "#8B4513",
        "blue": "#4169E1",
        "green": "#228B22",
        "gold": "#D4AF37",
        "silver": "#C0C0C0",
        "charcoal": "#36454F",
        "anthracite": "#293133",
        "taupe": "#483C32",
        "sand": "#C2B280",
        "bone": "#E3DAC9",
        "ivory": "#FFFFF0",
        "natural": "#D2B48C",
        "oak": "#806517",
        "walnut": "#5D432C",
        "slate": "#708090",
        "stone": "#928E85",
        "pearl": "#EAE0C8",
        "copper": "#B87333",
        "pink": "#FFC0CB",
        "ash": "#B2BEB5",
        "smoke": "#738276",
        "dune": "#C19A6B",
        "dove": "#B6AFA9",
        "emerald": "#50C878",
        "steel": "#71797E",
        "light": "#F5F5F5",
        "dark": "#2F4F4F",
        "mix": "#A0A0A0",
        "multi": "#808080"
    }
    color_lower = color_name.lower().strip()
    # Check for exact match first
    if color_lower in color_map:
        return color_map[color_lower]
    # Check for partial match
    for key, hex_val in color_map.items():
        if key in color_lower:
            return hex_val
    return "#CCCCCC"  # Default grey for unknown colors


@router.get("/collection/{series_name:path}")
async def get_collection_products(
    series_name: str,
    sort_by: str = "color",
    page: int = 1,
    limit: int = 24
):
    """
    Get all products within a specific collection/series.
    For the collection detail page.
    """
    from fastapi.responses import JSONResponse
    import logging
    import traceback
    # 60s in-memory cache — drops 3s response to <50ms for repeat visitors.
    from utils.endpoint_cache import endpoint_cache
    _cache_key = endpoint_cache.key(
        "collection_products",
        series_name=series_name, sort_by=sort_by, page=page, limit=limit,
    )
    _lkg_key = f"lkg:{_cache_key}"

    public_cache_headers = {
        "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=3600",
        "Vary": "Accept-Encoding",
    }
    no_store_headers = {
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Pragma": "no-cache",
        "Vary": "Accept-Encoding",
    }

    _cached = endpoint_cache.get(_cache_key)
    if _cached is not None:
        return JSONResponse(content=_cached, headers=public_cache_headers)

    try:
        result = await _get_collection_products_impl(series_name, sort_by, page, limit)
        is_empty = (
            not isinstance(result, dict)
            or not result.get("products")
        )
        if is_empty:
            stale = endpoint_cache.get_stale(_lkg_key)
            if stale is not None:
                logging.warning(f"Collection products empty — serving last-known-good for {series_name}")
                return JSONResponse(content=stale, headers=no_store_headers)
            return JSONResponse(content=result or {"products": [], "total": 0}, headers=no_store_headers)
        endpoint_cache.set(_cache_key, result, ttl=60)
        endpoint_cache.set_long(_lkg_key, result, ttl=86400)
        return JSONResponse(content=result, headers=public_cache_headers)
    except Exception:
        logging.error(f"Collection products crash for '{series_name}': {traceback.format_exc()}")
        stale = endpoint_cache.get_stale(_lkg_key)
        if stale is not None:
            return JSONResponse(content=stale, headers=no_store_headers)
        return JSONResponse(
            status_code=503,
            content={"products": [], "total": 0, "error": "temporarily_unavailable", "retry_after_seconds": 5},
            headers={**no_store_headers, "Retry-After": "5"},
        )


async def _get_collection_products_impl(
    series_name: str,
    sort_by: str = "color",
    page: int = 1,
    limit: int = 24,
):
    import business_config.business_rules as br
    db = get_tile_db()
    
    # Fetch series-level description from tracking collection
    series_description_doc = db.series_description_tracking.find_one({"series_name": series_name})
    series_description = series_description_doc.get("last_description", "") if series_description_doc else ""
    
    # Also fetch custom description from collection_settings (admin-set, takes priority)
    custom_description = ""
    try:
        coll_settings = db.collection_settings.find_one({"series_name": series_name})
        if coll_settings and coll_settings.get("custom_description"):
            custom_description = coll_settings["custom_description"]
    except Exception:
        pass
    
    # FALLBACK: If no collection_settings custom_description, check if any product in the
    # collection has a description field (set via "Apply Description to N Products" button).
    # This ensures descriptions saved to individual products still appear on the collection page.
    if not custom_description:
        try:
            product_with_desc = db.tiles.find_one(
                {
                    "$or": [
                        {"display_name": {"$regex": f"^{re.escape(series_name)}", "$options": "i"}},
                        {"name": {"$regex": f"^{re.escape(series_name)}", "$options": "i"}},
                        {"series": {"$regex": f"^{re.escape(series_name)}", "$options": "i"}},
                        {"original_series": series_name},
                        {"series": series_name}
                    ],
                    "description": {"$exists": True, "$ne": "", "$ne": None}
                },
                {"description": 1, "_id": 0}
            )
            if product_with_desc and product_with_desc.get("description"):
                custom_description = product_with_desc["description"]
        except Exception:
            pass
    
    # Search for products whose name starts with the series name, or exact series match
    query = {
        "$or": [
            {"display_name": {"$regex": f"^{re.escape(series_name)}", "$options": "i"}},
            {"name": {"$regex": f"^{re.escape(series_name)}", "$options": "i"}},
            {"series": {"$regex": f"^{re.escape(series_name)}", "$options": "i"}},
            {"original_series": series_name},
            {"series": series_name}
        ]
    }
    
    # Fallback: If direct query finds nothing, this might be a size+material merged group name
    # (e.g., "80x300x10/3mm Engineered Wood Herringbone"). Find tiles whose name contains
    # the series_name as a substring (the dimension+material part of the product name).
    total_check = db.tiles.count_documents(query)
    if total_check == 0:
        try:
            # Normalize dimension spaces: "80 x 300 x 10/3mm" → "80x300x10/3mm"
            normalized = re.sub(r'\s*x\s*', 'x', series_name)
            # Try substring match with normalized name
            escaped = re.escape(normalized)
            substring_query = {
                "$or": [
                    {"name": {"$regex": escaped, "$options": "i"}},
                    {"display_name": {"$regex": escaped, "$options": "i"}}
                ]
            }
            substring_count = db.tiles.count_documents(substring_query)
            if substring_count > 0:
                query = substring_query
            else:
                # Try matching each significant word from the series name
                words = [w for w in normalized.split() if len(w) > 2]
                if len(words) >= 2:
                    # Build regex that matches all words in any order
                    word_patterns = [f"(?=.*{re.escape(w)})" for w in words]
                    combined = "".join(word_patterns)
                    word_query = {
                        "$or": [
                            {"name": {"$regex": combined, "$options": "i"}},
                            {"display_name": {"$regex": combined, "$options": "i"}}
                        ]
                    }
                    word_count = db.tiles.count_documents(word_query)
                    if word_count > 0:
                        query = word_query
        except Exception:
            pass
    
    # Sorting
    sort_field = "display_name"
    sort_order = 1
    # Determine sort field and order
    sort_field = "display_name"  # default
    sort_order = 1
    
    if sort_by == "price_asc":
        sort_field = "room_lot_price"
        sort_order = 1
    elif sort_by == "price_desc":
        sort_field = "room_lot_price"
        sort_order = -1
    elif sort_by == "size":
        sort_field = "attributes.size"
        sort_order = 1
    elif sort_by == "color":
        # Sort by color field, then by display_name for consistency
        sort_field = None  # Will use aggregation
    elif sort_by == "name":
        sort_field = "display_name"
        sort_order = 1
    
    total = db.tiles.count_documents(query)
    skip = (page - 1) * limit
    
    # For color sorting, use aggregation to handle missing/null color fields
    if sort_by == "color":
        pipeline = [
            {"$match": query},
            {"$addFields": {
                "sort_color": {
                    "$ifNull": [
                        "$color",
                        {"$ifNull": ["$attributes.color", "zzz"]}  # Put items without color at the end
                    ]
                }
            }},
            {"$sort": {"sort_color": 1, "attributes.size": 1, "display_name": 1}},
            {"$skip": skip},
            {"$limit": limit}
        ]
        products = list(db.tiles.aggregate(pipeline))
    else:
        products = list(db.tiles.find(query).sort(sort_field, sort_order).skip(skip).limit(limit))
    
    # Get collection summary info
    all_products = list(db.tiles.find(query, {"color": 1, "finish": 1, "size": 1, "attributes.color": 1, "attributes.size": 1, "attributes.finish": 1, "room_lot_price": 1}))
    
    unique_colors = set()
    unique_sizes = set()
    unique_finishes = set()
    prices = []
    
    for p in all_products:
        try:
            color = p.get("color") or p.get("attributes", {}).get("color", "")
            if isinstance(color, list):
                color = color[0] if color else ""
            if not isinstance(color, str):
                color = str(color) if color else ""
            size = p.get("size") or p.get("attributes", {}).get("size", "")
            if isinstance(size, list):
                size = size[0] if size else ""
            if not isinstance(size, str):
                size = str(size) if size else ""
            finish = normalize_finish(p.get("finish") or p.get("attributes", {}).get("finish", ""))
            price = p.get("room_lot_price", 0)
        
            if color:
                unique_colors.add(color)
            if size:
                unique_sizes.add(size)
            if finish:
                unique_finishes.add(finish)
            if price:
                prices.append(price)
        except Exception:
            continue
    
    # Get credit_back_rate and trade_discount - prioritize supplier_products as source of truth
    collection_credit_back = None
    collection_trade_discount = None
    collection_trade_discount_type = None
    
    # First check supplier_products (admin saves go here)
    if products:
        first_sku = None
        for p in products:
            first_sku = p.get("sku") or p.get("supplier_code")
            if first_sku:
                break
        if first_sku:
            sp = db.supplier_products.find_one(
                {"sku": first_sku},
                {"_id": 0, "trade_discount": 1, "trade_discount_type": 1, "credit_back_rate": 1}
            )
            if sp:
                collection_trade_discount = sp.get("trade_discount")
                collection_trade_discount_type = sp.get("trade_discount_type")
                collection_credit_back = sp.get("credit_back_rate")
    
    # Fallback to tiles data if not found in supplier_products
    if collection_trade_discount is None or collection_credit_back is None or collection_trade_discount_type is None:
        for p in products:
            if collection_credit_back is None and p.get("credit_back_rate") is not None:
                collection_credit_back = p["credit_back_rate"]
            if collection_trade_discount is None and p.get("trade_discount") is not None:
                collection_trade_discount = p["trade_discount"]
            if collection_trade_discount_type is None and p.get("trade_discount_type"):
                collection_trade_discount_type = p["trade_discount_type"]
            if collection_credit_back is not None and collection_trade_discount is not None and collection_trade_discount_type is not None:
                break
    
    if collection_credit_back is None:
        collection_credit_back = br.TRADE_CREDIT_BACK_DEFAULT
    if collection_trade_discount is None:
        collection_trade_discount = br.TRADE_DISCOUNT_DEFAULT
    if collection_trade_discount_type is None:
        collection_trade_discount_type = "percent"

    return _jsonify_safe({
        "series_name": series_name,
        "series_description": series_description,
        "custom_description": custom_description,
        "products": [serialize_tile_for_shop(p) for p in products],
        "credit_back_rate": collection_credit_back,
        "trade_discount": collection_trade_discount,
        "trade_discount_type": collection_trade_discount_type,
        "total": total,
        "page": page,
        "limit": limit,
        "total_pages": (total + limit - 1) // limit,
        "summary": {
            "colors": sorted(list(unique_colors)),
            "sizes": sorted(list(unique_sizes)),
            "finishes": sorted(list(unique_finishes)),
            "price_range": {
                "min": min(prices) if prices else 0,
                "max": max(prices) if prices else 0
            }
        }
    })


@router.get("/related/{series_name:path}")
@bulletproof_endpoint(
    cache_namespace="tiles_related",
    empty_check=lambda r: not (isinstance(r, dict) and (r.get("related_products") or r.get("related_series"))),
    empty_fallback={"related_products": [], "related_series": []},
)
async def get_related_products(
    series_name: str,
    limit: int = 8
):
    """
    Get related products for a collection/series based on similar attributes.
    Finds products with matching: material, finish, effect, categories, or similar price range.
    """
    db = get_tile_db()
    
    # First, get the current series products to understand their attributes
    current_products = list(db.tiles.find({
        "$or": [
            {"display_name": {"$regex": f"^{re.escape(series_name)}", "$options": "i"}},
            {"name": {"$regex": f"^{re.escape(series_name)}", "$options": "i"}},
            {"series": {"$regex": f"^{re.escape(series_name)}", "$options": "i"}}
        ]
    }).limit(10))
    
    if not current_products:
        return {"related_products": [], "related_series": []}
    
    # Collect attributes from current products
    materials = set()
    finishes = set()
    effects = set()
    categories = set()
    prices = []
    
    for p in current_products:
        material = p.get('material') or p.get('attributes', {}).get('material', '')
        finish = p.get('finish') or p.get('attributes', {}).get('finish', '')
        effect = p.get('effect') or p.get('attributes', {}).get('effect', '')
        cats = p.get('categories', [])
        price = p.get('room_lot_price') or p.get('price', 0)
        
        if material:
            materials.add(material)
        if finish:
            finishes.add(finish)
        if effect:
            effects.add(effect)
        if isinstance(cats, list):
            categories.update(cats)
        if price:
            prices.append(price)
    
    # Build query for related products (excluding current series)
    exclude_query = {
        "$and": [
            {"display_name": {"$not": {"$regex": f"^{re.escape(series_name)}", "$options": "i"}}},
            {"name": {"$not": {"$regex": f"^{re.escape(series_name)}", "$options": "i"}}}
        ]
    }
    
    # Find products with similar attributes
    match_conditions = []
    
    if materials:
        match_conditions.append({
            "$or": [
                {"material": {"$in": list(materials)}},
                {"attributes.material": {"$in": list(materials)}}
            ]
        })
    
    if finishes:
        match_conditions.append({
            "$or": [
                {"finish": {"$in": list(finishes)}},
                {"attributes.finish": {"$in": list(finishes)}}
            ]
        })
    
    if effects:
        match_conditions.append({
            "$or": [
                {"effect": {"$in": list(effects)}},
                {"attributes.effect": {"$in": list(effects)}},
                {"display_name": {"$regex": "|".join(effects), "$options": "i"}}
            ]
        })
    
    if categories:
        match_conditions.append({"categories": {"$in": list(categories)}})
    
    # Price range (within 30% of current prices)
    if prices:
        avg_price = sum(prices) / len(prices)
        min_price = avg_price * 0.7
        max_price = avg_price * 1.3
        match_conditions.append({
            "$or": [
                {"room_lot_price": {"$gte": min_price, "$lte": max_price}},
                {"price": {"$gte": min_price, "$lte": max_price}}
            ]
        })
    
    # Combine conditions - products matching ANY of the criteria
    if match_conditions:
        related_query = {
            "$and": [
                exclude_query,
                {"$or": match_conditions}
            ]
        }
    else:
        related_query = exclude_query
    
    # Get related products
    related_products = list(db.tiles.find(related_query).limit(limit * 3))
    
    # Group by series and get unique series
    series_map = {}
    for p in related_products:
        product_name = p.get('display_name') or p.get('name', '')
        if not product_name:
            continue
        
        # Extract series name (first word)
        product_series = product_name.split()[0] if product_name.split() else ''
        if not product_series or product_series.lower() == series_name.lower():
            continue
        
        if product_series not in series_map:
            series_map[product_series] = {
                "series_name": product_series,
                "sample_product": serialize_tile_for_shop(p),
                "image": (p.get('images') or [None])[0] if (p.get('images') or [None]) else None,
                "price": p.get('room_lot_price') or p.get('price', 0),
                "finish": p.get('finish') or p.get('attributes', {}).get('finish', ''),
                "material": p.get('material') or p.get('attributes', {}).get('material', '')
            }
    
    # Return limited unique series
    related_series = list(series_map.values())[:limit]
    
    return {
        "related_series": related_series,
        "current_series": series_name,
        "matching_criteria": {
            "materials": list(materials),
            "finishes": list(finishes),
            "effects": list(effects),
            "categories": list(categories)
        }
    }


@router.get("/categories")
@bulletproof_endpoint(
    cache_namespace="tiles_categories",
    empty_check=lambda r: not r,
    empty_fallback=[],
)
async def get_tile_categories():
    """Get tile categories based on attributes"""
    db = get_tile_db()
    
    # Generate categories from finishes and materials
    categories = []
    
    # By Finish
    finishes = db.tiles.distinct("attributes.finish")
    for finish in finishes:
        if finish:
            count = db.tiles.count_documents({"attributes.finish": finish})
            categories.append({
                "id": f"finish-{finish.lower().replace(' ', '-')}",
                "name": f"{finish.title()} Tiles",
                "type": "finish",
                "filter_value": finish,
                "product_count": count
            })
    
    # By Material
    materials = db.tiles.distinct("attributes.material")
    for material in materials:
        if material:
            count = db.tiles.count_documents({"attributes.material": material})
            categories.append({
                "id": f"material-{material.lower().replace(' ', '-').replace('-effect', '')}",
                "name": f"{material.replace('-', ' ').title()}",
                "type": "material",
                "filter_value": material,
                "product_count": count
            })
    
    # By Supplier (Collection)
    suppliers = db.tiles.distinct("supplier_name")
    for supplier in suppliers:
        if supplier:
            count = db.tiles.count_documents({"supplier_name": supplier})
            categories.append({
                "id": f"collection-{supplier.lower().replace(' ', '-')}",
                "name": f"{supplier} Collection",
                "type": "supplier",
                "filter_value": supplier,
                "product_count": count
            })
    
    return sorted(categories, key=lambda x: -x["product_count"])


@router.get("/featured")
@bulletproof_endpoint(
    cache_namespace="tiles_featured",
    empty_check=lambda r: not r,
    empty_fallback=[],
)
async def get_featured_tiles(limit: int = 8):
    """Get featured collections - series assigned to 'Feature Tiles' category via Collection Organizer"""
    db = get_tile_db()
    import re as _re

    # Find all tiles assigned to "Feature Tiles" category
    featured_tiles = list(db.tiles.find(
        {"sub_categories": {"$regex": "Feature", "$options": "i"}},
    ))

    if not featured_tiles:
        # Fallback: return tiles with images sorted by stock as individual products
        fallback = list(db.tiles.find(
            {"images": {"$exists": True, "$ne": []}},
        ).sort("stock", -1).limit(limit))
        return {"mode": "products", "items": [serialize_tile_for_shop(t) for t in fallback]}

    # Group featured tiles by series (derived series logic: first word of name if no series)
    series_groups = {}
    for tile in featured_tiles:
        series = tile.get("series") or tile.get("display_name", tile.get("name", "")).split()[0] if tile.get("display_name") or tile.get("name") else "Unknown"
        if not series:
            series = "Unknown"
        if series not in series_groups:
            series_groups[series] = {
                "products": [],
                "images": [],
                "supplier": tile.get("supplier_name") or tile.get("source_supplier", ""),
            }
        series_groups[series]["products"].append(tile)
        for img in (tile.get("images") or []):
            if img and img not in series_groups[series]["images"]:
                series_groups[series]["images"].append(img)

    # Build collection cards
    collections = []
    for series_name, group in series_groups.items():
        hero_image = group["images"][0] if group["images"] else None
        first_slug = group["products"][0].get("slug", "") if group["products"] else ""
        collections.append({
            "series_name": series_name,
            "supplier": group["supplier"],
            "product_count": len(group["products"]),
            "hero_image": hero_image,
            "images": group["images"][:5],
            "first_product_slug": first_slug,
        })

    # Apply custom collection settings (hero images, titles)
    try:
        settings_list = list(db.collection_settings.find({}))
        custom_settings = {s["series_name"]: s for s in settings_list}
        for coll in collections:
            settings = custom_settings.get(coll["series_name"], {})
            if settings.get("custom_hero_image"):
                coll["hero_image"] = settings["custom_hero_image"]
            if settings.get("custom_title"):
                coll["custom_title"] = settings["custom_title"]
    except Exception:
        pass

    # Sort by product count descending
    collections.sort(key=lambda x: -x["product_count"])

    return {"mode": "collections", "items": collections[:limit]}


@router.get("/search")
@bulletproof_endpoint(
    cache_namespace="tiles_search",
    empty_check=lambda r: not r,
    empty_fallback=[],
    short_ttl=30,  # search is hot — short cache
)
async def search_tiles(
    q: str,
    limit: int = 10
):
    """Quick search for tiles (header autocomplete).

    Uses the shared tile_search engine so suggestions match what the
    /api/shop/search-all results page returns. Two endpoints once
    drifted apart and produced inconsistent results — never again.
    """
    from services.tile_search import build_tile_search_query, rank_score

    db = get_tile_db()

    query = build_tile_search_query(q)
    if query is None:
        return []

    tiles = list(db.tiles.find(
        query,
        {"display_name": 1, "name": 1, "slug": 1, "images": 1, "room_lot_price": 1, "original_series": 1, "series": 1}
    ).limit(limit * 3))  # over-fetch a bit so ranking has options

    results = []
    for t in tiles:
        display_name = t.get("display_name") or t.get("name") or ""
        # Determine collection name
        collection = t.get("original_series") or t.get("series")
        if not collection:
            import re as _re
            parts = display_name.strip().split()
            series_parts = []
            for part in parts:
                if _re.match(r'^\d+(\.\d+)?[xX]\d+', part):
                    break
                if _re.match(r'^\d+mm$', part, _re.IGNORECASE):
                    continue
                series_parts.append(part)
            collection = ' '.join(series_parts) if series_parts else display_name

        results.append({
            "id": t.get("id") or str(t.get("_id", "")),
            "name": display_name,
            "slug": t.get("slug", ""),
            "image": t.get("images", [""])[0] if t.get("images") else "",
            "images": t.get("images") or [],
            "price": t.get("room_lot_price", 0),
            "collection": collection,
            "_score": rank_score(display_name, q),
        })

    results.sort(key=lambda r: (r.pop("_score", 99), r["name"].lower()))
    return results[:limit]


@router.get("/similar/{slug}")
async def get_similar_tiles(slug: str, limit: int = 4):
    """Get similar tiles based on attributes"""
    db = get_tile_db()
    
    tile = db.tiles.find_one({"slug": slug})
    if not tile:
        raise HTTPException(status_code=404, detail="Tile not found")
    
    attrs = tile.get("attributes", {})
    
    # Find similar by size and finish
    similar = list(db.tiles.find(
        {
            "slug": {"$ne": slug},
            "$or": [
                {"attributes.size": attrs.get("size")},
                {"attributes.finish": attrs.get("finish")},
                {"attributes.material": attrs.get("material")}
            ]
        }
    ).limit(limit))
    
    return [serialize_tile_for_shop(t) for t in similar]


# ============ ADMIN TILE ROUTES ============

@router.get("/admin/products")
async def get_tiles_for_admin(
    search: Optional[str] = None,
    supplier: Optional[str] = None,
    page: int = 1,
    limit: int = 50
):
    """Get tiles for admin panel - includes supplier names"""
    db = get_tile_db()
    
    query = {}
    
    if search:
        query["$or"] = [
            {"display_name": {"$regex": search, "$options": "i"}},
            {"original_supplier_name": {"$regex": search, "$options": "i"}},
            {"supplier_code": {"$regex": search, "$options": "i"}}
        ]
    
    if supplier:
        query["supplier_name"] = supplier
    
    total = db.supplier_products.count_documents(query)
    skip = (page - 1) * limit
    products = list(db.supplier_products.find(query).sort("supplier_name", 1).skip(skip).limit(limit))
    
    return {
        "products": [serialize_tile_for_admin(p) for p in products],
        "total": total,
        "page": page,
        "limit": limit,
        "total_pages": (total + limit - 1) // limit
    }


@router.get("/admin/stats")
async def get_tile_stats():
    """Get tile inventory statistics for admin"""
    db = get_tile_db()
    
    total = db.supplier_products.count_documents({})
    with_images = db.supplier_products.count_documents({"images": {"$exists": True, "$ne": []}})
    with_prices = db.supplier_products.count_documents({"room_lot_price": {"$gt": 0}})
    with_stock = db.supplier_products.count_documents({"stock": {"$gt": 0}})
    
    # By supplier
    by_supplier = {}
    for supplier in db.supplier_products.distinct("supplier_name"):
        count = db.supplier_products.count_documents({"supplier_name": supplier})
        by_supplier[supplier] = count
    
    return {
        "total_products": total,
        "with_images": with_images,
        "with_prices": with_prices,
        "with_stock": with_stock,
        "by_supplier": by_supplier
    }



# =============================================================================
# TIER PRICING ENDPOINTS
# =============================================================================

@router.get("/pricing/tiers")
async def get_tier_pricing_config():
    """Get global tier pricing configuration"""
    from business_config.business_rules import get_tier_pricing_config as get_config
    return get_config()


class TierPricingConfigUpdate(BaseModel):
    thresholds: Optional[List[int]] = None
    discounts: Optional[List[int]] = None
    custom_quote_threshold: Optional[int] = None
    trade_discount_default: Optional[int] = None
    credit_back_default: Optional[int] = None


@router.put("/pricing/tiers")
async def update_tier_pricing_config(config: TierPricingConfigUpdate):
    """
    Update global tier pricing configuration.
    Saves to tier_pricing_config collection in MongoDB.
    """
    db = get_tile_db()
    
    update_data = {}
    if config.thresholds is not None:
        update_data["thresholds"] = config.thresholds
    if config.discounts is not None:
        update_data["discounts"] = config.discounts
    if config.custom_quote_threshold is not None:
        update_data["custom_quote_threshold"] = config.custom_quote_threshold
    if config.trade_discount_default is not None:
        update_data["trade_discount_default"] = config.trade_discount_default
    if config.credit_back_default is not None:
        update_data["credit_back_default"] = config.credit_back_default
    
    if update_data:
        update_data["updated_at"] = datetime.now(timezone.utc)
        db.tier_pricing_config.update_one(
            {"_id": "global"},
            {"$set": update_data},
            upsert=True
        )
        
        # Also update the in-memory values in business_rules
        import business_config.business_rules as br
        if config.thresholds is not None:
            br.QUANTITY_TIER_THRESHOLDS = config.thresholds
        if config.discounts is not None:
            br.QUANTITY_TIER_DISCOUNTS = config.discounts
        if config.custom_quote_threshold is not None:
            br.CUSTOM_QUOTE_THRESHOLD = config.custom_quote_threshold
        if config.trade_discount_default is not None:
            br.TRADE_DISCOUNT_DEFAULT = config.trade_discount_default
        if config.credit_back_default is not None:
            br.TRADE_CREDIT_BACK_DEFAULT = config.credit_back_default
    
    return {"success": True, "message": "Tier pricing config updated"}


@router.get("/pricing/calculate")
async def calculate_tier_price(
    base_price: float = Query(..., description="Base price per m²"),
    quantity: float = Query(1, description="Quantity in m²"),
    is_trade: bool = Query(False, description="Is trade account"),
    trade_discount: Optional[float] = Query(None, description="Custom trade discount %"),
    trade_discount_type: Optional[str] = Query(None, description="'percent' (default) or 'fixed' for flat £/m²"),
    product_sku: Optional[str] = Query(None, description="Product SKU for custom tier settings")
):
    """
    Calculate tier pricing for a given base price and quantity.
    Returns tier breakdown and current applicable price.
    If product has tier_pricing_disabled=True, returns disabled response.
    """
    try:
        from business_config.business_rules import get_quantity_tier_pricing
        
        # Check for custom tier settings for this product/series
        custom_thresholds = None
        custom_discounts = None
        tier_disabled = False
        # Trade discount type resolution: query param > product field > default 'percent'
        effective_td_type = trade_discount_type
        
        if product_sku:
            try:
                db = get_tile_db()
                sp = db.supplier_products.find_one(
                    {"sku": product_sku},
                    {"_id": 0, "tier_thresholds": 1, "tier_discounts": 1, "tier_pricing_disabled": 1, "trade_discount_type": 1}
                )
                
                if sp:
                    tier_disabled = sp.get("tier_pricing_disabled", False)
                    custom_thresholds = sp.get("tier_thresholds")
                    custom_discounts = sp.get("tier_discounts")
                    if effective_td_type is None and sp.get("trade_discount_type"):
                        effective_td_type = sp.get("trade_discount_type")
                
                if custom_thresholds is None or custom_discounts is None or effective_td_type is None:
                    product = db.tiles.find_one(
                        {"sku": product_sku},
                        {"_id": 0, "tier_thresholds": 1, "tier_discounts": 1, "tier_pricing_disabled": 1, "trade_discount_type": 1}
                    )
                    if product:
                        if not tier_disabled:
                            tier_disabled = product.get("tier_pricing_disabled", False)
                        if custom_thresholds is None:
                            custom_thresholds = product.get("tier_thresholds")
                        if custom_discounts is None:
                            custom_discounts = product.get("tier_discounts")
                        if effective_td_type is None and product.get("trade_discount_type"):
                            effective_td_type = product.get("trade_discount_type")
            except Exception as db_err:
                logger.warning(f"DB lookup failed for sku={product_sku}: {db_err}")
        
        if tier_disabled:
            return {
                "disabled": True,
                "base_price": base_price,
                "quantity": quantity,
                "tiers": [],
                "current_price_per_m2": base_price,
                "total_price": base_price * quantity,
                "current_tier": None,
                "current_discount_percent": 0
            }
        
        result = get_quantity_tier_pricing(
            base_price=base_price,
            quantity=quantity,
            custom_thresholds=custom_thresholds,
            custom_discounts=custom_discounts,
            is_trade=is_trade,
            trade_discount=trade_discount,
            trade_discount_type=effective_td_type or "percent"
        )
        
        if product_sku:
            try:
                db = get_tile_db()
                sp = db.supplier_products.find_one({"sku": product_sku}, {"_id": 0, "credit_back_rate": 1, "trade_discount": 1, "trade_discount_type": 1})
                if sp:
                    if sp.get("credit_back_rate") is not None:
                        result["credit_back_rate"] = sp["credit_back_rate"]
                    if sp.get("trade_discount") is not None:
                        result["trade_discount"] = sp["trade_discount"]
                    if sp.get("trade_discount_type"):
                        result["trade_discount_type"] = sp["trade_discount_type"]
            except Exception:
                pass
        
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Pricing calculate error for sku={product_sku}: {e}")
        # Safe fallback
        try:
            from business_config.business_rules import get_quantity_tier_pricing
            return get_quantity_tier_pricing(base_price=base_price, quantity=quantity, is_trade=is_trade, trade_discount=trade_discount, trade_discount_type=trade_discount_type or "percent")
        except:
            return {"tiers": [], "trade_tiers": [], "base_price": base_price, "current_price_per_m2": base_price}


@router.get("/pricing/calculate-unit")
async def calculate_unit_tier_price(
    unit_price: float = Query(..., description="Price per unit"),
    quantity: int = Query(1, description="Number of units"),
    is_trade: bool = Query(False, description="Is trade account"),
    trade_discount: Optional[float] = Query(None, description="Custom trade discount %"),
    product_sku: Optional[str] = Query(None, description="Product SKU for custom tier settings")
):
    """
    Calculate tier pricing for unit-based products (adhesives, grout, tools).
    Returns tier breakdown with per-unit prices.
    """
    from business_config.business_rules import get_unit_tier_pricing
    
    # Check for custom tier settings for this product
    custom_thresholds = None
    custom_discounts = None
    
    if product_sku:
        db = get_tile_db()
        # Check supplier_products first (source of truth for admin settings)
        sp = db.supplier_products.find_one(
            {"sku": product_sku},
            {"_id": 0, "unit_tier_thresholds": 1, "unit_tier_discounts": 1, "tier_pricing_disabled": 1}
        )
        
        tier_disabled = False
        if sp:
            tier_disabled = sp.get("tier_pricing_disabled", False)
            custom_thresholds = sp.get("unit_tier_thresholds")
            custom_discounts = sp.get("unit_tier_discounts")
        
        # Fallback to tiles
        if custom_thresholds is None or custom_discounts is None:
            product = db.tiles.find_one(
                {"sku": product_sku},
                {"_id": 0, "unit_tier_thresholds": 1, "unit_tier_discounts": 1, "tier_pricing_disabled": 1}
            )
            if product:
                if not tier_disabled:
                    tier_disabled = product.get("tier_pricing_disabled", False)
                if custom_thresholds is None:
                    custom_thresholds = product.get("unit_tier_thresholds")
                if custom_discounts is None:
                    custom_discounts = product.get("unit_tier_discounts")
        
        if tier_disabled:
            return {
                "disabled": True,
                "pricing_unit": "unit",
                "base_price": unit_price,
                "quantity": quantity,
                "tiers": [],
                "current_price_per_unit": unit_price,
                "total_price": unit_price * quantity,
                "current_tier": None,
                "current_discount_percent": 0
            }
    
    result = get_unit_tier_pricing(
        unit_price=unit_price,
        quantity=quantity,
        custom_thresholds=custom_thresholds,
        custom_discounts=custom_discounts,
        is_trade=is_trade,
        trade_discount=trade_discount
    )
    
    return result


@router.get("/products/{slug}/tier-pricing")
async def get_product_tier_pricing(
    slug: str,
    quantity: float = Query(1, description="Quantity in m²"),
    is_trade: bool = Query(False, description="Is trade account"),
    trade_discount: Optional[float] = Query(None, description="Custom trade discount %"),
    trade_discount_type: Optional[str] = Query(None, description="'percent' (default) or 'fixed'")
):
    """
    Get tier pricing for a specific product.
    Returns full tier breakdown with product's base price.
    If tier pricing is disabled for this product, returns disabled: true.
    """
    try:
        from business_config.business_rules import get_quantity_tier_pricing
        
        db = get_tile_db()
        
        # Get product
        tile = db.tiles.find_one({"slug": slug}, {"_id": 0})
        if not tile:
            raise HTTPException(status_code=404, detail="Product not found")
    
        # Check if tier pricing is disabled - check supplier_products first (source of truth)
        tier_disabled = False
        sku = tile.get("sku") or tile.get("supplier_code")
        supplier = tile.get("supplier")
        sp_data = None
        if sku:
            sp_query = {"sku": sku}
            if supplier:
                sp_query["supplier"] = supplier
            sp_data = db.supplier_products.find_one(sp_query, {
                "_id": 0, "tier_pricing_disabled": 1, "tier_thresholds": 1, "tier_discounts": 1
            })
            if sp_data and sp_data.get("tier_pricing_disabled"):
                tier_disabled = True
    
        # Fallback to tiles for disabled flag
        if not tier_disabled:
            tier_disabled = tile.get("tier_pricing_disabled", False)
        
        if tier_disabled:
            return {
                "disabled": True,
                "product": {
                    "slug": slug,
                    "display_name": tile.get("display_name") or tile.get("name"),
                    "display_code": tile.get("display_code"),
                    "sku": tile.get("sku"),
                    "tier_pricing_disabled": True
                },
                "base_price": tile.get("room_lot_price") or tile.get("price") or 0,
                "tiers": []
            }
        
        # Get base price (room lot price)
        base_price = tile.get("room_lot_price") or tile.get("price") or 0
        
        if base_price == 0:
            raise HTTPException(status_code=400, detail="Product has no price set")
        
        # Get custom tier settings - supplier_products first (source of truth), fallback to tiles
        custom_thresholds = sp_data.get("tier_thresholds") if sp_data else None
        custom_discounts = sp_data.get("tier_discounts") if sp_data else None
        if custom_thresholds is None:
            custom_thresholds = tile.get("tier_thresholds")
        if custom_discounts is None:
            custom_discounts = tile.get("tier_discounts")
        
        # Resolve per-product trade_discount: query param > supplier_product field > product field > global default
        effective_trade_discount = trade_discount
        effective_td_type = trade_discount_type
        if effective_trade_discount is None or effective_td_type is None:
            # Check supplier_products first (admin saves go here, source of truth)
            sku_td = tile.get("sku") or tile.get("supplier_code")
            if sku_td:
                sp_td = db.supplier_products.find_one({"sku": sku_td}, {"_id": 0, "trade_discount": 1, "trade_discount_type": 1})
                if sp_td:
                    if effective_trade_discount is None and sp_td.get("trade_discount") is not None:
                        effective_trade_discount = sp_td["trade_discount"]
                    if effective_td_type is None and sp_td.get("trade_discount_type"):
                        effective_td_type = sp_td["trade_discount_type"]
        if effective_trade_discount is None:
            effective_trade_discount = tile.get("trade_discount")
        if effective_td_type is None:
            effective_td_type = tile.get("trade_discount_type") or "percent"
        
        result = get_quantity_tier_pricing(
            base_price=base_price,
            quantity=quantity,
            custom_thresholds=custom_thresholds,
            custom_discounts=custom_discounts,
            is_trade=is_trade,
            trade_discount=effective_trade_discount,
            trade_discount_type=effective_td_type,
            was_price=tile.get("was_price"),
            sale_active=tile.get("sale_active", False)
        )
        
        # Add product info
        # Get credit_back_rate: check supplier_products first (source of truth), then tiles, then global default
        product_credit_back = None
        sku_for_cb = tile.get("sku") or tile.get("supplier_code")
        if sku_for_cb:
            sp_cb = db.supplier_products.find_one({"sku": sku_for_cb}, {"_id": 0, "credit_back_rate": 1})
            if sp_cb:
                product_credit_back = sp_cb.get("credit_back_rate")
        if product_credit_back is None:
            product_credit_back = tile.get("credit_back_rate")
        if product_credit_back is None:
            from business_config.business_rules import TRADE_CREDIT_BACK_DEFAULT
            product_credit_back = TRADE_CREDIT_BACK_DEFAULT

        result["credit_back_rate"] = product_credit_back
        # Include the actual trade_discount used so the frontend knows the per-product rate
        from business_config.business_rules import TRADE_DISCOUNT_DEFAULT
        result["trade_discount"] = effective_trade_discount if effective_trade_discount is not None else TRADE_DISCOUNT_DEFAULT
        result["trade_discount_type"] = effective_td_type or "percent"
        result["product"] = {
            "slug": slug,
            "display_name": tile.get("display_name") or tile.get("name"),
            "display_code": tile.get("display_code"),
            "sku": tile.get("sku"),
            "has_custom_tiers": bool(custom_thresholds or custom_discounts)
        }
        
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Tier pricing error for slug={slug}: {e}")
        # Return a safe fallback instead of 500
        from business_config.business_rules import get_quantity_tier_pricing
        try:
            db = get_tile_db()
            base = db.tiles.find_one({"slug": slug}, {"_id": 0, "room_lot_price": 1, "price": 1})
            bp = (base.get("room_lot_price") or base.get("price") or 0) if base else 0
            if bp > 0:
                return get_quantity_tier_pricing(base_price=bp, quantity=quantity, is_trade=is_trade, trade_discount=trade_discount, trade_discount_type=trade_discount_type or "percent")
        except:
            pass
        return {"tiers": [], "trade_tiers": [], "base_price": 0}



# ============ LABEL MANAGEMENT ENDPOINTS ============

@router.get("/labels/available")
async def get_available_labels():
    """Get list of all available product labels with their colors"""
    # Predefined labels with styling
    predefined_labels = [
        {"value": "NEW", "label": "New", "color": "emerald", "description": "Newly added products"},
        {"value": "SALE", "label": "Sale", "color": "red", "description": "Products on sale"},
        {"value": "NEW SIZES", "label": "New Sizes", "color": "emerald", "description": "New sizes available"},
        {"value": "BESTSELLER", "label": "Bestseller", "color": "amber", "description": "Top selling products"},
        {"value": "LIMITED", "label": "Limited Edition", "color": "purple", "description": "Limited availability"},
        {"value": "EXCLUSIVE", "label": "Exclusive", "color": "blue", "description": "Exclusive to Tile Station"},
        {"value": "CLEARANCE", "label": "Clearance", "color": "orange", "description": "End of line clearance"},
        {"value": "ECO", "label": "Eco-Friendly", "color": "green", "description": "Environmentally friendly"},
    ]
    
    # Get custom labels from database
    db = get_tile_db()
    custom_labels_doc = db.settings.find_one({"type": "custom_labels"})
    custom_labels = custom_labels_doc.get("labels", []) if custom_labels_doc else []
    
    return {
        "predefined": predefined_labels,
        "custom": custom_labels
    }


@router.post("/labels/custom")
async def add_custom_label(label_data: dict):
    """Add a new custom label"""
    db = get_tile_db()
    
    value = label_data.get("value", "").upper().strip()
    label = label_data.get("label", value.title())
    color = label_data.get("color", "gray")
    description = label_data.get("description", "")
    
    if not value:
        raise HTTPException(status_code=400, detail="Label value is required")
    
    # Update or create custom labels document
    db.settings.update_one(
        {"type": "custom_labels"},
        {"$addToSet": {"labels": {
            "value": value,
            "label": label,
            "color": color,
            "description": description
        }}},
        upsert=True
    )
    
    return {"message": f"Custom label '{value}' added", "value": value}


@router.delete("/labels/custom/{label_value}")
async def delete_custom_label(label_value: str):
    """Delete a custom label"""
    db = get_tile_db()
    
    db.settings.update_one(
        {"type": "custom_labels"},
        {"$pull": {"labels": {"value": label_value.upper()}}}
    )
    
    return {"message": f"Custom label '{label_value}' deleted"}


@router.post("/product/{slug}/labels")
async def update_product_labels(slug: str, data: dict):
    """Update labels on a specific product"""
    db = get_tile_db()
    
    labels = data.get("labels", [])
    
    # Update the product in tiles collection
    result = db.tiles.update_one(
        {"slug": slug},
        {"$set": {"labels": labels}}
    )
    
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Product not found")
    
    return {"message": "Labels updated", "labels": labels}


@router.post("/collection/{series_name:path}/labels")
async def update_collection_labels(series_name: str, data: dict):
    """Update labels on all products in a collection/series"""
    from utils.collection_utils import extract_series_name
    
    db = get_tile_db()
    labels = data.get("labels", [])
    action = data.get("action", "set")  # "set", "add", or "remove"
    
    # Find all products in this series
    all_products = list(db.tiles.find({}, {"name": 1, "slug": 1}))
    matching_slugs = []
    
    for p in all_products:
        if extract_series_name(p.get("name", "")) == series_name:
            matching_slugs.append(p["slug"])
    
    if not matching_slugs:
        raise HTTPException(status_code=404, detail=f"No products found in collection '{series_name}'")
    
    # Update labels based on action
    if action == "add":
        update_op = {"$addToSet": {"labels": {"$each": labels}}}
    elif action == "remove":
        update_op = {"$pullAll": {"labels": labels}}
    else:  # "set"
        update_op = {"$set": {"labels": labels}}
    
    result = db.tiles.update_many(
        {"slug": {"$in": matching_slugs}},
        update_op
    )
    
    return {
        "message": f"Labels updated on {result.modified_count} products in '{series_name}'",
        "products_updated": result.modified_count
    }

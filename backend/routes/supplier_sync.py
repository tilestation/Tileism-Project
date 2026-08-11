"""
Supplier Sync Routes - Receive product data from browser extensions
All images are automatically uploaded to Cloudflare R2 cloud storage.
"""
from fastapi import APIRouter, HTTPException, UploadFile, File, Form, BackgroundTasks, Depends, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime, timezone
import logging
import os
import json
import tempfile
import re
import uuid
import asyncio
from pymongo import MongoClient

# Import auth services
from services import get_current_user, is_admin_user

# Centralised filter normaliser — maps 'all' / '' / 'any' / None → None
from utils.request_filters import normalise_filter_value

# Helper function for admin access check
def require_admin_access(current_user: dict):
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")

# Import non-tile exclusion rules
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from business_config.business_rules import is_non_tile_product, NON_TILE_EXCLUSION_RULES, construct_complete_name, calculate_list_price, PRICING_RULES

# Import R2 uploader for automatic image upload
try:
    from services.storage.r2_uploader import process_product_images_sync, R2ImageUploader, upload_to_r2, optimize_image
    # Don't cache the result - check dynamically each time
    def is_r2_available():
        return R2ImageUploader.is_configured()
except ImportError:
    def is_r2_available():
        return False
    process_product_images_sync = None
    R2ImageUploader = None
    upload_to_r2 = None
    optimize_image = None

# Import custom mappings service for preserving manual name changes
try:
    from services.custom_mappings import (
        save_custom_mapping,
        get_custom_mapping,
        get_display_name_with_custom_check
    )
    CUSTOM_MAPPINGS_AVAILABLE = True
except ImportError:
    CUSTOM_MAPPINGS_AVAILABLE = False
    save_custom_mapping = None
    get_custom_mapping = None
    get_display_name_with_custom_check = None

# Import category sync utility for unified category management
try:
    from utils.category_sync import (
        sync_category_to_website_sync,
        sync_bulk_update_categories_sync,
        sync_category_on_product_save_sync,
        update_category_product_counts_sync
    )
    CATEGORY_SYNC_AVAILABLE = True
except ImportError:
    CATEGORY_SYNC_AVAILABLE = False
    sync_category_to_website_sync = None
    sync_bulk_update_categories_sync = None
    sync_category_on_product_save_sync = None
    update_category_product_counts_sync = None

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/supplier-sync", tags=["Supplier Sync"])

# Database connection
def get_db():
    mongo_url = os.environ.get('MONGO_URL')
    if not mongo_url:
        raise ValueError("MONGO_URL environment variable is required")
    client = MongoClient(mongo_url)
    return client[os.environ.get('DB_NAME', 'tile_station')]


@router.get("/verona/extension/download")
def download_verona_extension():
    """
    Download the Verona browser extension ZIP file
    """
    # Check multiple possible locations - latest version first
    possible_paths = [
        "/app/frontend/public/verona-sync-extension-v4.9.zip",
        "/app/frontend/public/verona-sync-extension-v4.8.zip",
        "/app/frontend/public/verona-sync-extension-v4.6.zip",
        "/app/frontend/public/verona-sync-extension-v4.5.zip",
        "/app/frontend/public/verona-sync-extension-v4.4.zip",
        "/app/frontend/public/verona-sync-extension-v4.3.zip",
        "/app/frontend/public/verona-sync-extension-v4.1.zip",
        "/app/frontend/public/verona-sync-extension-v4.0.zip",
        "/app/frontend/public/verona-sync-extension-v3.1.zip",
        "/app/browser-extension.zip",
        "/app/frontend/public/verona-extension.zip",
        "/app/browser-extension/verona-extension.zip"
    ]
    
    for path in possible_paths:
        if os.path.exists(path):
            return FileResponse(
                path,
                media_type="application/zip",
                filename="TileStation-Verona-Extension-v4.9.zip"
            )
    
    raise HTTPException(status_code=404, detail="Extension file not found")


@router.get("/search")
def search_products_for_images(q: str = "", limit: int = 20):
    """Search products by name, series, or style - returns products with images
    Used by the admin UI to select product images for homepage sections."""
    
    if not q or len(q) < 2:
        return {"products": []}
    
    db = get_db()
    
    # Use aggregation to search products with images
    pipeline = [
        {
            "$match": {
                "$and": [
                    {
                        "$or": [
                            {"name": {"$regex": q, "$options": "i"}},
                            {"series_name": {"$regex": q, "$options": "i"}},
                            {"product_name": {"$regex": q, "$options": "i"}},
                            {"style": {"$regex": q, "$options": "i"}},
                            {"website_categories.style_effect": {"$regex": q, "$options": "i"}}
                        ]
                    },
                    {
                        "$or": [
                            {"main_image": {"$exists": True, "$nin": [None, ""]}},
                            {"images.0": {"$exists": True}},
                            {"lifestyle_image": {"$exists": True, "$nin": [None, ""]}}
                        ]
                    }
                ]
            }
        },
        {"$limit": limit},
        {
            "$project": {
                "_id": 0,
                "id": {"$toString": "$_id"},
                "name": 1,
                "series_name": 1,
                "supplier_name": "$supplier",
                "main_image": 1,
                "images": 1,
                "lifestyle_image": 1,
                "style": 1
            }
        }
    ]
    
    products = list(db.supplier_products.aggregate(pipeline))
    
    return {"products": products}


class ExtractedProduct(BaseModel):
    sku: Optional[str] = None
    name: Optional[str] = None
    description: Optional[str] = None
    price: Optional[float] = None
    stock_sqm: Optional[float] = None
    image_url: Optional[str] = None
    url: Optional[str] = None
    image: Optional[str] = None
    images: Optional[List[str]] = None
    in_stock: Optional[bool] = None
    stock_text: Optional[str] = None
    stock_quantity: Optional[int] = None
    stock_m2: Optional[int] = None
    size: Optional[str] = None
    tile_width: Optional[int] = None
    tile_height: Optional[int] = None
    tile_depth: Optional[int] = None
    material: Optional[str] = None
    finish: Optional[str] = None
    color: Optional[str] = None
    usage: Optional[str] = None
    suitability: Optional[str] = None


class SingleProductRequest(BaseModel):
    url: str
    supplier: Optional[str] = None


# =============================================================================
# SINGLE PRODUCT SYNC - Add any product from supplier URL
# =============================================================================

@router.post("/single-product")
async def sync_single_product_endpoint(data: SingleProductRequest, background_tasks: BackgroundTasks):
    """
    Sync a single product from ANY supplier's website using just the URL.
    
    This performs a DEEP extraction of all product details including:
    - Product name (with automatic unique naming)
    - SKU/Stock code
    - Cost price and calculated list price
    - Stock availability
    - Size/dimensions
    - Material and finish
    - All product images
    
    FEATURES:
    - Auto-detects supplier from URL domain
    - Creates new supplier in database if not exists
    - Works with ANY tile/product website
    
    Example:
        POST /api/supplier-sync/single-product
        Body: {"url": "https://www.any-tile-supplier.com/product/example-tile"}
    
    Returns:
        - success: Whether the sync was successful
        - action: "added" or "updated"
        - supplier: Detected or provided supplier name
        - supplier_info: {name, is_new, domain} - indicates if new supplier was created
        - product: Extracted product details with pricing
    """
    try:
        from services.single_product_sync import sync_single_product, detect_supplier
        
        url = data.url.strip()
        supplier = data.supplier
        
        if not url:
            raise HTTPException(status_code=400, detail="Product URL is required")
        
        # Validate URL
        if not url.startswith('http'):
            raise HTTPException(status_code=400, detail="Invalid URL format. URL must start with http:// or https://")
        
        # Run the sync (await the coroutine directly)
        result = await sync_single_product(url, supplier)
        
        if not result.get("success"):
            raise HTTPException(status_code=400, detail=result.get("error", "Sync failed"))
        
        return result
        
    except HTTPException:
        raise
    except ImportError as e:
        logger.error(f"Import error: {e}")
        raise HTTPException(status_code=500, detail="Single product sync module not available")
    except Exception as e:
        logger.error(f"Single product sync error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


class VeronaSyncRequest(BaseModel):
    products: List[ExtractedProduct]
    source: str = "browser_extension"
    timestamp: Optional[str] = None


class SyncResponse(BaseModel):
    success: bool
    synced: int
    updated: int
    new: int
    errors: int
    message: str


@router.post("/verona/receive", response_model=SyncResponse)
def receive_verona_products(data: VeronaSyncRequest):
    """
    Receive product data from Verona browser extension - writes to sync_staging for review
    """
    try:
        db = get_db()
        
        synced = 0
        updated = 0
        new = 0
        errors = 0
        ignored = 0
        
        for product in data.products:
            try:
                if not product.name and not product.sku:
                    errors += 1
                    continue
                
                sku = product.sku or product.name
                
                # Check if this is a non-tile product (adhesive, grout, etc.) - SKIP if so
                should_skip, skip_reason = is_non_tile_product(
                    product.name or '',
                    '',  # category not available from extension
                    product.url or ''
                )
                if should_skip:
                    ignored += 1
                    logger.info(f"SKIPPED non-tile product from Verona extension: {product.name} - {skip_reason}")
                    continue
                
                # Check if this product is in the ignored list
                is_ignored = db.ignored_products.find_one({
                    "sku": sku,
                    "supplier": "Verona"
                })
                
                if is_ignored:
                    ignored += 1
                    continue
                
                # Calculate list price from cost price using formula
                # List Price = ceil((Cost × 1.90) × 1.20) - 0.01
                list_price = None
                if product.price is not None and product.price > 0:
                    import math
                    raw_price = product.price * 1.90 * 1.20
                    list_price = math.ceil(raw_price) - 0.01
                
                # Prepare product data for staging
                product_data = {
                    "supplier": "Verona",
                    "synced_at": datetime.now(timezone.utc),
                    "sync_source": data.source
                }
                
                if product.name:
                    # Construct complete name with size and finish
                    complete_name = construct_complete_name(
                        product.name,
                        product.size,
                        product.finish
                    )
                    product_data["name"] = complete_name  # Store complete name
                    # Generate transformed product name using naming logic
                    # CUSTOM MAPPINGS: Check for custom mapping first before auto-generating
                    if CUSTOM_MAPPINGS_AVAILABLE and get_display_name_with_custom_check and sku:
                        product_data["product_name"] = get_display_name_with_custom_check(
                            db, complete_name, "Verona", sku, product.finish
                        )
                    else:
                        from business_config.business_rules import get_display_name
                        product_data["product_name"] = get_display_name(
                            complete_name, 
                            "Verona", 
                            product.finish  # Pass finish for proper name formatting
                        )
                if product.sku:
                    product_data["sku"] = product.sku
                if product.url:
                    product_data["url"] = product.url
                
                # Handle images (multiple images support) - Upload to R2
                images_list = []
                if product.images and len(product.images) > 0:
                    images_list = product.images
                elif product.image:
                    images_list = [product.image]
                
                # Store original source URLs for future change detection
                source_urls = images_list.copy() if images_list else []
                
                # Get existing product for image change detection
                existing_product = db.sync_staging.find_one({"supplier": "Verona", "sku": sku})
                existing_source_urls = existing_product.get("image_source_urls", []) if existing_product else []
                
                # Upload images to R2 cloud storage
                if is_r2_available() and process_product_images_sync and images_list:
                    try:
                        processed_images, returned_source_urls = process_product_images_sync(
                            images_list,
                            "Verona",
                            product.name or sku,  # Use product name for image naming
                            existing_source_urls  # Pass existing to detect changes
                        )
                        if processed_images:
                            images_list = processed_images
                            source_urls = returned_source_urls
                            product_data["images_uploaded_to_r2"] = True
                    except Exception as img_err:
                        logger.warning(f"Failed to upload images to R2: {img_err}")
                
                if images_list:
                    product_data["images"] = images_list
                    product_data["image"] = images_list[0]  # Primary image
                    product_data["image_source_urls"] = source_urls  # Store for future change detection
                
                # Price handling
                if product.price is not None:
                    product_data["cost_price"] = product.price  # Original cost
                    if list_price:
                        product_data["price"] = list_price  # Calculated list price
                
                if product.in_stock is not None:
                    product_data["in_stock"] = product.in_stock
                if product.stock_text:
                    product_data["stock_text"] = product.stock_text
                if product.stock_quantity is not None:
                    product_data["stock_quantity"] = product.stock_quantity
                if product.stock_m2 is not None:
                    product_data["stock_m2"] = product.stock_m2
                
                # New enhanced fields
                if product.size:
                    product_data["size"] = product.size
                if product.tile_width:
                    product_data["tile_width"] = product.tile_width
                if product.tile_height:
                    product_data["tile_height"] = product.tile_height
                if product.tile_depth:
                    product_data["tile_depth"] = product.tile_depth
                if product.material:
                    product_data["material"] = product.material
                if product.finish:
                    product_data["finish"] = product.finish
                if product.color:
                    product_data["color"] = product.color
                if product.usage:
                    product_data["usage"] = product.usage
                if product.suitability:
                    product_data["suitability"] = product.suitability
                
                # Check if existing in supplier_products to determine if update or new
                existing = db.supplier_products.find_one({
                    "sku": sku,
                    "supplier": "Verona"
                })
                
                # Upsert into sync_staging (staging area)
                filter_query = {"supplier": "Verona", "sku": sku}
                result = db.sync_staging.update_one(
                    filter_query,
                    {
                        "$set": product_data,
                        "$setOnInsert": {"created_at": datetime.now(timezone.utc)}
                    },
                    upsert=True
                )
                
                if result.upserted_id:
                    if existing:
                        updated += 1
                    else:
                        new += 1
                elif result.modified_count > 0:
                    updated += 1
                
                synced += 1
                
            except Exception as e:
                logger.error(f"Error syncing product: {e}")
                errors += 1
        
        # Log the sync event
        db.sync_logs.insert_one({
            "supplier": "Verona",
            "source": data.source,
            "destination": "sync_staging",
            "timestamp": datetime.now(timezone.utc),
            "products_received": len(data.products),
            "synced": synced,
            "updated": updated,
            "new": new,
            "ignored": ignored,
            "errors": errors
        })
        
        return SyncResponse(
            success=True,
            synced=synced,
            updated=updated,
            new=new,
            errors=errors,
            message=f"Staged {synced} products for review ({new} new, {updated} updates, {ignored} ignored)"
        )
        
    except Exception as e:
        logger.error(f"Verona sync error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/verona/status")
def get_verona_sync_status():
    """
    Get the status of Verona sync
    """
    try:
        db = get_db()
        
        # Get last sync
        last_sync = db.sync_logs.find_one(
            {"supplier": "Verona"},
            sort=[("timestamp", -1)]
        )
        
        # Get product count
        product_count = db.supplier_products.count_documents({"supplier": "Verona"})
        
        return {
            "supplier": "Verona",
            "total_products": product_count,
            "last_sync": last_sync.get("timestamp") if last_sync else None,
            "last_sync_source": last_sync.get("source") if last_sync else None,
            "last_sync_count": last_sync.get("synced") if last_sync else 0
        }
        
    except Exception as e:
        logger.error(f"Error getting Verona status: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/logs")
def get_sync_logs(limit: int = 20, supplier: Optional[str] = None):
    """
    Get recent sync logs
    """
    try:
        db = get_db()
        
        query = {}
        supplier = normalise_filter_value(supplier)
        if supplier:
            query["supplier"] = supplier
        
        logs = list(db.sync_logs.find(query, {"_id": 0}).sort("timestamp", -1).limit(limit))
        
        return logs
    except Exception as e:
        logger.error(f"Error fetching sync logs: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============== SPLENDOUR ENDPOINTS ==============

class SplendourProduct(BaseModel):
    name: Optional[str] = None
    sku: Optional[str] = None
    url: Optional[str] = None
    price: Optional[float] = None
    pallet_price: Optional[float] = None
    stock_m2: Optional[float] = 0
    in_stock: Optional[bool] = False
    size: Optional[str] = None
    images: Optional[List[str]] = []


class SplendourSyncRequest(BaseModel):
    products: List[SplendourProduct]
    source: str = "browser_extension"


@router.post("/bulk-upsert")
def bulk_upsert_products(data: dict):
    """
    Bulk upsert products for any supplier.
    Inserts new products and updates existing ones.
    Expects: {"supplier": "Verona", "products": [{...}, ...], "match_by": "old_sku"}
    
    match_by options:
    - "sku" (default): Match by new SKU or old_sku field
    - "old_sku": Match primarily by old_sku (supplier's original code) - prevents duplicates when re-processing
    - "name": Match by product name (use with caution)
    """
    try:
        db = get_db()
        supplier = normalise_filter_value(data.get("supplier"))
        products = data.get("products", [])
        match_by = data.get("match_by", "sku")  # Default to SKU matching
        
        if not supplier:
            raise HTTPException(status_code=400, detail="Supplier name required")
        
        inserted = 0
        updated = 0
        errors = 0
        skipped = 0
        
        for p in products:
            try:
                sku = p.get("sku") or p.get("new_sku")
                old_sku = p.get("old_sku")
                
                if not sku and not old_sku:
                    skipped += 1
                    continue
                
                product_data = {
                    "supplier": supplier,
                    "sku": sku,
                    "name": p.get("name"),
                    "product_name": p.get("product_name"),
                    "supplier_product_name": p.get("supplier_product_name") or p.get("original_series") or None,
                    "category": p.get("category"),
                    "series": p.get("series"),
                    "original_series": p.get("original_series"),  # Original Canopy series name
                    "cost_price": p.get("cost_price"),
                    "price": p.get("price"),
                    "trade_price": p.get("trade_price"),
                    "retail_price": p.get("retail_price"),
                    "material": p.get("material"),
                    "specifications": p.get("specifications"),
                    "finish": p.get("finish"),
                    "size": p.get("size"),
                    "thickness": p.get("thickness"),
                    "coverage_m2": p.get("coverage_m2"),
                    "stock_m2": p.get("stock_m2"),
                    "stock_quantity": p.get("stock_quantity"),
                    "in_stock": p.get("in_stock"),
                    "images": p.get("images", []),
                    "synced_at": datetime.now(timezone.utc),
                    "last_processed": datetime.now(timezone.utc)
                }
                
                # Keep old_sku if provided
                if old_sku:
                    product_data["old_sku"] = old_sku
                
                # Remove None values
                product_data = {k: v for k, v in product_data.items() if v is not None}
                
                # Build the match filter based on match_by parameter
                if match_by == "old_sku" and old_sku:
                    # Match by old_sku first (best for re-processing to avoid duplicates)
                    match_filter = {"supplier": supplier, "old_sku": old_sku}
                elif match_by == "name" and p.get("name"):
                    # Match by name (use with caution - may merge different products)
                    match_filter = {"supplier": supplier, "name": p.get("name")}
                else:
                    # Default: Match by sku OR old_sku
                    if sku and old_sku:
                        match_filter = {"supplier": supplier, "$or": [{"sku": sku}, {"old_sku": old_sku}]}
                    elif old_sku:
                        match_filter = {"supplier": supplier, "old_sku": old_sku}
                    else:
                        match_filter = {"supplier": supplier, "sku": sku}
                
                result = db.supplier_products.update_one(
                    match_filter,
                    {
                        "$set": product_data,
                        "$setOnInsert": {"created_at": datetime.now(timezone.utc)}
                    },
                    upsert=True
                )
                
                if result.upserted_id:
                    inserted += 1
                elif result.modified_count > 0:
                    updated += 1
                    
            except Exception as e:
                logger.error(f"Error upserting {p.get('sku')}: {e}")
                errors += 1
        
        return {
            "success": True,
            "supplier": supplier,
            "inserted": inserted,
            "updated": updated,
            "skipped": skipped,
            "errors": errors,
            "match_by": match_by,
            "message": f"Processed {inserted + updated} {supplier} products ({inserted} new, {updated} updated)"
        }
        
    except Exception as e:
        logger.error(f"Bulk upsert error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/splendour/products")
def sync_splendour_products(data: SplendourSyncRequest):
    """
    Receive product data from the Splendour browser extension - writes to sync_staging for review
    """
    try:
        from business_config.business_rules import is_non_tile_product
        
        db = get_db()
        
        synced = 0
        updated = 0
        new = 0
        errors = 0
        ignored = 0
        excluded_non_tile = 0
        
        for product in data.products:
            try:
                # Skip products without name or SKU
                if not product.name and not product.sku:
                    continue
                
                # Generate SKU from URL if not provided
                sku = product.sku
                if not sku and product.url:
                    # Extract from URL like /agora-light-grey-matt-600x300
                    url_parts = product.url.rstrip('/').split('/')
                    sku = url_parts[-1] if url_parts else None
                
                if not sku:
                    errors += 1
                    continue
                
                # CHECK: Skip non-tile products (grout, sealant, adhesive, etc.)
                should_skip, skip_reason = is_non_tile_product(product.name or "", "", product.url or "")
                if should_skip:
                    excluded_non_tile += 1
                    logger.debug(f"Skipping non-tile product: {product.name} - {skip_reason}")
                    continue
                
                # Check if this product is in the ignored list
                is_ignored = db.ignored_products.find_one({
                    "sku": sku,
                    "supplier": "Splendour"
                })
                
                if is_ignored:
                    ignored += 1
                    continue
                
                product_data = {
                    "supplier": "Splendour",
                    "sku": sku,
                    "name": construct_complete_name(product.name, product.size, getattr(product, 'finish', None)),  # Complete name
                    "url": product.url,
                    "price": product.price,
                    "pallet_price": product.pallet_price,
                    "stock_m2": product.stock_m2 or 0,
                    "in_stock": product.in_stock if product.in_stock is not None else (product.stock_m2 or 0) > 0,
                    "size": product.size,
                    "synced_at": datetime.now(timezone.utc),
                    "sync_source": data.source
                }
                
                # Handle images - upload to R2 cloud storage
                images_list = product.images if product.images else []
                source_urls = images_list.copy() if images_list else []
                
                # Get existing product for image change detection
                existing_staging = db.sync_staging.find_one({"supplier": "Splendour", "sku": sku})
                existing_source_urls = existing_staging.get("image_source_urls", []) if existing_staging else []
                
                # Upload images to R2 if available
                if is_r2_available() and process_product_images_sync and images_list:
                    try:
                        processed_images, returned_source_urls = process_product_images_sync(
                            images_list,
                            "Splendour",
                            product.name or sku,
                            existing_source_urls
                        )
                        if processed_images:
                            images_list = processed_images
                            source_urls = returned_source_urls
                            product_data["images_uploaded_to_r2"] = True
                    except Exception as img_err:
                        logger.warning(f"Failed to upload Splendour images to R2: {img_err}")
                
                # Store images
                if images_list:
                    product_data["images"] = images_list
                    product_data["image"] = images_list[0]
                    product_data["image_source_urls"] = source_urls
                else:
                    product_data["images"] = []
                    product_data["image"] = None
                
                # Generate transformed product name
                # CUSTOM MAPPINGS: Check for custom mapping first before auto-generating
                finish = getattr(product, 'finish', None)
                complete_name = product_data["name"]  # Use already constructed complete name
                if CUSTOM_MAPPINGS_AVAILABLE and get_display_name_with_custom_check and sku:
                    product_data["product_name"] = get_display_name_with_custom_check(
                        db, complete_name, "Splendour", sku, finish
                    )
                else:
                    from business_config.business_rules import get_display_name
                    product_data["product_name"] = get_display_name(complete_name, "Splendour", finish)
                
                # Check if existing in supplier_products
                existing = db.supplier_products.find_one({
                    "sku": sku,
                    "supplier": "Splendour"
                })
                
                # Upsert into sync_staging
                result = db.sync_staging.update_one(
                    {"supplier": "Splendour", "sku": sku},
                    {
                        "$set": product_data,
                        "$setOnInsert": {"created_at": datetime.now(timezone.utc)}
                    },
                    upsert=True
                )
                
                if result.upserted_id:
                    if existing:
                        updated += 1
                    else:
                        new += 1
                elif result.modified_count > 0:
                    updated += 1
                
                synced += 1
                
            except Exception as e:
                logger.error(f"Error syncing Splendour product {product.name}: {e}")
                errors += 1
        
        # Log the sync
        db.sync_logs.insert_one({
            "supplier": "Splendour",
            "source": data.source,
            "destination": "sync_staging",
            "timestamp": datetime.now(timezone.utc),
            "products_received": len(data.products),
            "synced": synced,
            "updated": updated,
            "new": new,
            "ignored": ignored,
            "excluded_non_tile": excluded_non_tile,
            "errors": errors
        })
        
        logger.info(f"Splendour sync complete: {synced} staged, {new} new, {updated} updates, {ignored} ignored, {excluded_non_tile} non-tile excluded, {errors} errors")
        
        return dict(
            success=True,
            synced=synced,
            updated=updated,
            new=new,
            errors=errors,
            excluded_non_tile=excluded_non_tile,
            message=f"Staged {synced} products for review ({new} new, {updated} updates, {ignored} ignored, {excluded_non_tile} non-tile products excluded)"
        )
        
    except Exception as e:
        logger.error(f"Splendour sync error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/splendour/status")
def get_splendour_sync_status():
    """
    Get the status of Splendour sync including resume information
    """
    try:
        db = get_db()
        
        # Get last sync
        last_sync = db.sync_logs.find_one(
            {"supplier": "Splendour"},
            sort=[("timestamp", -1)]
        )
        
        # Get product counts
        product_count = db.supplier_products.count_documents({"supplier": "Splendour"})
        staging_count = db.sync_staging.count_documents({"supplier": "Splendour"})
        
        # Check for running/paused scrape session (for resume capability)
        scrape_session = db.scrape_progress.find_one(
            {"supplier": "Splendour", "status": {"$in": ["running", "paused"]}},
            sort=[("started_at", -1)]
        )
        
        resume_info = None
        if scrape_session:
            resume_info = {
                "status": scrape_session.get("status"),
                "started_at": scrape_session.get("started_at"),
                "ranges_scraped": len(scrape_session.get("scraped_ranges", [])),
                "categories_completed": scrape_session.get("scraped_categories", []),
                "last_category": scrape_session.get("last_category"),
                "last_range": scrape_session.get("last_range"),
                "products_saved": scrape_session.get("products_saved", 0),
                "can_resume": scrape_session.get("status") == "paused"
            }
        
        # Check for running job
        running_job = db.sync_jobs.find_one(
            {"supplier": "Splendour", "status": "running"},
            sort=[("started_at", -1)]
        )
        
        return {
            "supplier": "Splendour",
            "total_products": product_count,
            "staging_count": staging_count,
            "last_sync": last_sync.get("timestamp") if last_sync else None,
            "last_sync_source": last_sync.get("source") if last_sync else None,
            "last_sync_count": last_sync.get("synced") if last_sync else 0,
            "running_job": {
                "job_id": running_job.get("id"),
                "started_at": running_job.get("started_at"),
                "progress": running_job.get("progress", {})
            } if running_job else None,
            "resume_info": resume_info
        }
        
    except Exception as e:
        logger.error(f"Error getting Splendour status: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/splendour/reset-session")
def reset_splendour_scrape_session():
    """
    Reset the Splendour scrape session to start fresh.
    Use this if you want to re-scrape everything from the beginning.
    """
    try:
        db = get_db()
        result = db.scrape_progress.delete_many({"supplier": "Splendour"})
        return {
            "success": True,
            "message": f"Scrape session reset. Deleted {result.deleted_count} session(s). Next scrape will start fresh."
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/splendour/scrape-portal")
async def scrape_splendour_portal():
    """
    Scrape Splendour wholesale portal.
    NOTE: Requires Playwright browser automation which may not be available on all hosts.
    Falls back to existing data in sync_staging if Playwright fails.
    """
    import subprocess
    import sys
    import threading
    
    db = get_db()
    
    # Create a sync job record
    job_id = str(uuid.uuid4())
    sync_job = {
        "id": job_id,
        "supplier": "Splendour",
        "source": "portal_scrape_playwright",
        "status": "running",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "completed_at": None,
        "products_found": 0,
        "products_synced": 0,
        "images_found": 0,
        "progress": {"stage": "starting", "current": 0, "total": 0, "message": "Checking Playwright availability..."},
        "errors": []
    }
    db.sync_jobs.insert_one(sync_job)
    
    def run_playwright_scraper():
        """Run the Playwright scraper in a thread"""
        thread_db = get_db()
        
        try:
            # Check if Playwright is installed
            try:
                import playwright
                logger.info("Playwright module found")
            except ImportError:
                thread_db.sync_jobs.update_one(
                    {"id": job_id},
                    {"$set": {
                        "status": "failed",
                        "completed_at": datetime.now(timezone.utc).isoformat(),
                        "progress": {"stage": "error", "message": "Playwright not installed on this server"},
                        "errors": ["Playwright browser automation is required for Splendour but is not installed. Use browser extension instead."]
                    }}
                )
                return
            
            # Try to run the scraper
            thread_db.sync_jobs.update_one(
                {"id": job_id},
                {"$set": {"progress": {"stage": "starting", "message": "Starting Playwright browser..."}}}
            )
            
            result = subprocess.run(
                [sys.executable, '/app/backend/run_splendour_scrape.py'],
                capture_output=True,
                text=True,
                timeout=1800,  # 30 minute timeout
                cwd='/app/backend'
            )
            
            if result.returncode != 0:
                error_msg = result.stderr[:500] if result.stderr else "Unknown error"
                thread_db.sync_jobs.update_one(
                    {"id": job_id},
                    {"$set": {
                        "status": "failed",
                        "completed_at": datetime.now(timezone.utc).isoformat(),
                        "progress": {"stage": "error", "message": "Playwright scraper failed"},
                        "errors": [f"Scraper error: {error_msg}"]
                    }}
                )
                return
            
            # Count products after scrape
            staging_count = thread_db.sync_staging.count_documents({"supplier": "Splendour"})
            
            thread_db.sync_logs.insert_one({
                "supplier": "Splendour",
                "source": "portal_scrape_playwright",
                "timestamp": datetime.now(timezone.utc),
                "synced": staging_count,
                "errors": 0
            })
            
            thread_db.sync_jobs.update_one(
                {"id": job_id},
                {"$set": {
                    "status": "completed",
                    "completed_at": datetime.now(timezone.utc).isoformat(),
                    "products_found": staging_count,
                    "products_synced": staging_count,
                    "progress": {"stage": "complete", "message": f"Scrape complete - {staging_count} products in staging"}
                }}
            )
            
            logger.info(f"Splendour scrape completed: {staging_count} products")
            
        except subprocess.TimeoutExpired:
            thread_db.sync_jobs.update_one(
                {"id": job_id},
                {"$set": {
                    "status": "failed",
                    "completed_at": datetime.now(timezone.utc).isoformat(),
                    "errors": ["Scraper timed out after 30 minutes"]
                }}
            )
        except Exception as e:
            logger.error(f"Splendour scrape error: {e}")
            thread_db.sync_jobs.update_one(
                {"id": job_id},
                {"$set": {
                    "status": "failed",
                    "completed_at": datetime.now(timezone.utc).isoformat(),
                    "errors": [str(e)]
                }}
            )
    
    # Run in background thread
    thread = threading.Thread(target=run_playwright_scraper)
    thread.start()
    
    return {
        "success": True,
        "job_id": job_id,
        "message": "Splendour portal scrape started. NOTE: Requires Playwright which may not be available on all servers.",
        "check_status_url": f"/api/supplier-sync/splendour/scrape-status/{job_id}"
    }


@router.get("/splendour/scrape-status/{job_id}")
def get_splendour_scrape_status(job_id: str):
    """Get the status of a Splendour scrape job"""
    db = get_db()
    job = db.sync_jobs.find_one({"id": job_id}, {"_id": 0})
    
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    
    return job


# =============================================================================
# SPLENDOUR SERVER-SIDE SYNC (NEW - RECOMMENDED APPROACH)
# =============================================================================
# This runs the full sync on the server using Playwright.
# User just clicks a button in Sync Hub - no browser extension needed.

@router.post("/splendour/server-sync/start")
async def start_splendour_server_sync(categories: List[str] = None, mode: str = "deep", fresh: int = 0):
    """
    Start a server-side Splendour sync.
    
    This is the RECOMMENDED approach - runs on the server, no browser extension needed.
    
    MODES:
    - "deep" (default): Full sync with images, product details, etc. Use for initial setup.
    - "light" or "quick": Only sync stock and prices. Use for daily/weekly updates.
    
    Args:
        categories: Optional list of categories to sync (only for deep mode)
        mode: "deep" for full sync with images, "light" or "quick" for stock/price only
    """
    import threading
    
    try:
        from services.splendour_sync import get_sync_state, run_full_sync, run_quick_sync
        
        state = get_sync_state()
        if state["is_running"]:
            return {
                "success": False,
                "message": "Sync already in progress",
                "state": state
            }
        
        db = get_db()
        
        # fresh=1 wipes any saved resume progress so the deep sync re-discovers everything
        if fresh:
            from services.splendour_sync import clear_sync_progress
            clear_sync_progress(db)
        
        # Accept both "quick" and "light" for backwards compatibility
        if mode in ["quick", "light"]:
            # Light/Quick sync - stock and price only
            def run_sync_thread():
                from services.splendour_sync import update_state
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                try:
                    logger.info("[SPLENDOUR SYNC] Starting LIGHT sync thread...")
                    loop.run_until_complete(run_quick_sync(db))
                    logger.info("[SPLENDOUR SYNC] LIGHT sync thread completed successfully")
                except Exception as e:
                    error_msg = f"LIGHT sync thread error: {str(e)}"
                    logger.error(f"[SPLENDOUR SYNC] {error_msg}")
                    import traceback
                    logger.error(f"[SPLENDOUR SYNC] Traceback: {traceback.format_exc()}")
                    update_state(
                        is_running=False,
                        phase="error",
                        message=error_msg,
                        errors=[error_msg]
                    )
                finally:
                    loop.close()
            
            thread = threading.Thread(target=run_sync_thread, daemon=True)
            thread.start()
            
            return {
                "success": True,
                "mode": "light",
                "message": "LIGHT sync started (stock & price only)",
                "note": "Check /api/supplier-sync/splendour/server-sync/status for progress"
            }
        else:
            # Deep sync - full sync with images
            def run_sync_thread():
                from services.splendour_sync import update_state
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                try:
                    logger.info("[SPLENDOUR SYNC] Starting DEEP sync thread...")
                    loop.run_until_complete(run_full_sync(db, categories))
                    logger.info("[SPLENDOUR SYNC] DEEP sync thread completed successfully")
                except Exception as e:
                    error_msg = f"DEEP sync thread error: {str(e)}"
                    logger.error(f"[SPLENDOUR SYNC] {error_msg}")
                    import traceback
                    logger.error(f"[SPLENDOUR SYNC] Traceback: {traceback.format_exc()}")
                    update_state(
                        is_running=False,
                        phase="error",
                        message=error_msg,
                        errors=[error_msg]
                    )
                finally:
                    loop.close()
            
            thread = threading.Thread(target=run_sync_thread, daemon=True)
            thread.start()
            
            return {
                "success": True,
                "mode": "deep",
                "message": "DEEP sync started (full product info with images)",
                "note": "Check /api/supplier-sync/splendour/server-sync/status for progress"
            }
        
    except ImportError as e:
        logger.error(f"Import error: {e}")
        return {
            "success": False,
            "error": "Server-side sync module not available",
            "detail": str(e)
        }
    except Exception as e:
        logger.error(f"Error starting sync: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/splendour/server-sync/status")
def get_splendour_server_sync_status():
    """
    Get the status of the server-side Splendour sync.
    
    Returns progress information including:
    - is_running: Whether sync is currently running
    - sync_mode: "deep" or "quick"
    - phase: Current phase (login, finding_subcategories, finding_products, syncing, complete)
    - progress: Progress percentage (0-100)
    - message: Current status message
    - products_found: Number of products found
    - products_synced: Number of products synced
    - products_skipped: Number of products skipped (quick mode)
    """
    try:
        from services.splendour_sync import get_sync_state
        return get_sync_state()
    except ImportError:
        return {
            "is_running": False,
            "phase": "error",
            "message": "Server-side sync module not available",
            "progress": 0
        }


@router.post("/splendour/server-sync/stop")
def stop_splendour_server_sync():
    """Stop the running server-side sync"""
    try:
        from services.splendour_sync import update_state, get_sync_state
        
        state = get_sync_state()
        if not state["is_running"]:
            return {"success": False, "message": "No sync is running"}
        
        update_state(is_running=False, phase="stopped", message="Sync stopped by user")
        return {"success": True, "message": "Sync stop signal sent"}
        
    except ImportError:
        return {"success": False, "error": "Module not available"}


@router.post("/splendour/server-sync/force-reset")
def force_reset_splendour_sync():
    """Force reset a stuck Splendour sync state"""
    try:
        from services.splendour_sync import reset_sync_state
        reset_sync_state()
        db = get_db()
        db.sync_progress.delete_many({"supplier": "Splendour"})
        return {"success": True, "message": "Splendour sync state forcefully reset."}
    except Exception as e:
        logger.error(f"Error force-resetting Splendour sync: {e}")
        raise HTTPException(status_code=500, detail=str(e))




class WallcanoProduct(BaseModel):
    sku: Optional[str] = None
    name: Optional[str] = None
    product_name: Optional[str] = None  # Generated unique name
    size: Optional[str] = None
    finish: Optional[str] = None
    thickness: Optional[str] = None
    material: Optional[str] = None
    tiles_per_box: Optional[int] = 0
    sqm_per_box: Optional[float] = 0
    boxes_per_pallet: Optional[int] = 0
    stock_sqm: Optional[float] = 0
    trade_price: Optional[float] = None  # Original trade price
    cost_price: Optional[float] = None   # Cost price from supplier
    price: Optional[float] = None        # Calculated list price
    pallet_price: Optional[float] = None
    in_stock: Optional[bool] = True
    images: Optional[List[str]] = []


class WallcanoSyncRequest(BaseModel):
    products: List[WallcanoProduct]
    source: str = "browser_extension"


@router.post("/wallcano/products")
def sync_wallcano_products(data: WallcanoSyncRequest):
    """
    Receive product data from the Wallcano browser extension - writes to sync_staging for review
    """
    try:
        from business_config.business_rules import is_non_tile_product
        
        db = get_db()
        
        synced = 0
        updated = 0
        new = 0
        errors = 0
        ignored = 0
        excluded_non_tile = 0
        
        for product in data.products:
            try:
                if not product.name and not product.sku:
                    continue
                
                sku = product.sku
                if not sku:
                    errors += 1
                    continue
                
                # CHECK: Skip non-tile products (grout, sealant, adhesive, etc.)
                should_skip, skip_reason = is_non_tile_product(product.name or "", "", "")
                if should_skip:
                    excluded_non_tile += 1
                    logger.debug(f"Skipping non-tile product: {product.name} - {skip_reason}")
                    continue
                
                # Check if this product is in the ignored list
                is_ignored = db.ignored_products.find_one({
                    "sku": sku,
                    "supplier": "Wallcano"
                })
                
                if is_ignored:
                    ignored += 1
                    continue
                
                product_data = {
                    "supplier": "Wallcano",
                    "sku": sku,
                    "name": construct_complete_name(product.name, product.size, product.finish),  # Complete name
                    "size": product.size,
                    "finish": product.finish,
                    "thickness": product.thickness,
                    "material": product.material,
                    "tiles_per_box": product.tiles_per_box,
                    "sqm_per_box": product.sqm_per_box,
                    "boxes_per_pallet": product.boxes_per_pallet,
                    "stock_m2": product.stock_sqm or 0,
                    "in_stock": product.in_stock if product.in_stock is not None else (product.stock_sqm or 0) > 0,
                    "synced_at": datetime.now(timezone.utc),
                    "sync_source": data.source
                }
                
                # Handle images - upload to R2 cloud storage
                images_list = product.images if product.images else []
                source_urls = images_list.copy() if images_list else []
                
                # Get existing product for image change detection
                existing_staging = db.sync_staging.find_one({"supplier": "Wallcano", "sku": sku})
                existing_source_urls = existing_staging.get("image_source_urls", []) if existing_staging else []
                
                # Upload images to R2 if available
                if is_r2_available() and process_product_images_sync and images_list:
                    try:
                        processed_images, returned_source_urls = process_product_images_sync(
                            images_list,
                            "Wallcano",
                            product.name or sku,
                            existing_source_urls
                        )
                        if processed_images:
                            images_list = processed_images
                            source_urls = returned_source_urls
                            product_data["images_uploaded_to_r2"] = True
                    except Exception as img_err:
                        logger.warning(f"Failed to upload Wallcano images to R2: {img_err}")
                
                # Store images
                if images_list:
                    product_data["images"] = images_list
                    product_data["image"] = images_list[0]
                    product_data["image_source_urls"] = source_urls
                else:
                    product_data["images"] = []
                    product_data["image"] = None
                
                # Add pricing fields if provided
                # Generate transformed product name if not provided by extension
                # CUSTOM MAPPINGS: Check for custom mapping first before auto-generating
                complete_name = product_data["name"]  # Use already constructed complete name
                if product.product_name:
                    product_data["product_name"] = product.product_name
                elif CUSTOM_MAPPINGS_AVAILABLE and get_display_name_with_custom_check and sku:
                    product_data["product_name"] = get_display_name_with_custom_check(
                        db, complete_name, "Wallcano", sku, product.finish
                    )
                else:
                    # Generate using naming logic
                    from business_config.business_rules import get_display_name
                    product_data["product_name"] = get_display_name(
                        complete_name, 
                        "Wallcano", 
                        product.finish
                    )
                if product.trade_price is not None:
                    product_data["trade_price"] = product.trade_price
                if product.cost_price is not None:
                    product_data["cost_price"] = product.cost_price
                if product.price is not None:
                    product_data["price"] = product.price
                if product.pallet_price is not None:
                    product_data["pallet_price"] = product.pallet_price
                
                # Check if existing in supplier_products
                existing = db.supplier_products.find_one({
                    "sku": sku,
                    "supplier": "Wallcano"
                })
                
                result = db.sync_staging.update_one(
                    {"supplier": "Wallcano", "sku": sku},
                    {
                        "$set": product_data,
                        "$setOnInsert": {"created_at": datetime.now(timezone.utc)}
                    },
                    upsert=True
                )
                
                if result.upserted_id:
                    if existing:
                        updated += 1
                    else:
                        new += 1
                elif result.modified_count > 0:
                    updated += 1
                synced += 1
                
            except Exception as e:
                logger.error(f"Error syncing Wallcano product {product.name}: {e}")
                errors += 1
        
        db.sync_logs.insert_one({
            "supplier": "Wallcano",
            "source": data.source,
            "destination": "sync_staging",
            "timestamp": datetime.now(timezone.utc),
            "products_received": len(data.products),
            "synced": synced,
            "updated": updated,
            "new": new,
            "ignored": ignored,
            "errors": errors
        })
        
        return dict(
            success=True,
            synced=synced,
            updated=updated,
            new=new,
            errors=errors,
            message=f"Staged {synced} products for review ({new} new, {updated} updates, {ignored} ignored)"
        )
        
    except Exception as e:
        logger.error(f"Wallcano sync error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/wallcano/update-pricing")
def update_wallcano_pricing(data: dict):
    """
    Update pricing data and SKU for existing Wallcano products.
    Expects: {"products": [{"sku": "...", "new_sku": "...", "product_name": "...", "cost_price": X, "price": Y}, ...]}
    """
    try:
        db = get_db()
        products = data.get("products", [])
        
        updated = 0
        errors = 0
        
        for p in products:
            try:
                sku = p.get("sku")
                if not sku:
                    continue
                
                # Check if product has locked fields
                existing = db.supplier_products.find_one(
                    {"supplier": "Wallcano", "sku": sku},
                    {"name_locked": 1, "price_locked": 1}
                )
                
                update_fields = {}
                if p.get("product_name") and not (existing and existing.get("name_locked")):
                    update_fields["product_name"] = p["product_name"]
                if p.get("cost_price") is not None and not (existing and existing.get("price_locked")):
                    update_fields["cost_price"] = p["cost_price"]
                if p.get("price") is not None and not (existing and existing.get("price_locked")):
                    update_fields["price"] = p["price"]
                if p.get("new_sku"):
                    update_fields["sku"] = p["new_sku"]
                    update_fields["old_sku"] = sku  # Keep old SKU for reference
                
                if update_fields:
                    update_fields["last_processed"] = datetime.now(timezone.utc)
                    result = db.supplier_products.update_one(
                        {"supplier": "Wallcano", "sku": sku},
                        {"$set": update_fields}
                    )
                    if result.modified_count > 0:
                        updated += 1
                        
            except Exception as e:
                logger.error(f"Error updating {p.get('sku')}: {e}")
                errors += 1
        
        return {
            "success": True,
            "updated": updated,
            "errors": errors,
            "message": f"Updated pricing for {updated} products"
        }
        
    except Exception as e:
        logger.error(f"Update pricing error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/update-products")
def update_supplier_products(data: dict):
    """
    Generic endpoint to update supplier products with pricing and names.
    Works for Verona, Splendour, Ceramica Impex, etc.
    Expects: {"supplier": "Verona", "products": [{"sku": "...", "new_sku": "...", "product_name": "...", "cost_price": X, "price": Y}, ...]}
    """
    try:
        db = get_db()
        supplier = normalise_filter_value(data.get("supplier"))
        products = data.get("products", [])
        
        if not supplier:
            raise HTTPException(status_code=400, detail="Supplier name required")
        
        updated = 0
        errors = 0
        
        for p in products:
            try:
                sku = p.get("sku") or p.get("old_sku")
                if not sku:
                    continue
                
                # Check if product has locked fields
                existing = db.supplier_products.find_one(
                    {"supplier": supplier, "$or": [{"sku": sku}, {"old_sku": sku}]},
                    {"name_locked": 1, "price_locked": 1}
                )
                
                update_fields = {}
                if p.get("product_name") and not (existing and existing.get("name_locked")):
                    update_fields["product_name"] = p["product_name"]
                if p.get("cost_price") is not None and not (existing and existing.get("price_locked")):
                    update_fields["cost_price"] = p["cost_price"]
                if p.get("price") is not None and not (existing and existing.get("price_locked")):
                    update_fields["price"] = p["price"]
                if p.get("new_sku"):
                    update_fields["sku"] = p["new_sku"]
                    update_fields["old_sku"] = sku
                
                if update_fields:
                    update_fields["last_processed"] = datetime.now(timezone.utc)
                    result = db.supplier_products.update_one(
                        {"supplier": supplier, "$or": [{"sku": sku}, {"old_sku": sku}]},
                        {"$set": update_fields}
                    )
                    if result.modified_count > 0:
                        updated += 1
                        
            except Exception as e:
                logger.error(f"Error updating {p.get('sku')}: {e}")
                errors += 1
        
        return {
            "success": True,
            "supplier": supplier,
            "updated": updated,
            "errors": errors,
            "message": f"Updated {updated} {supplier} products"
        }
        
    except Exception as e:
        logger.error(f"Update products error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/wallcano/status")
def get_wallcano_status():
    try:
        db = get_db()
        last_sync = db.sync_logs.find_one({"supplier": "Wallcano"}, sort=[("timestamp", -1)])
        product_count = db.supplier_products.count_documents({"supplier": "Wallcano"})
        staging_count = db.sync_staging.count_documents({"supplier": "Wallcano"})
        
        # Count products missing images
        missing_images_count = db.supplier_products.count_documents({
            "supplier": "Wallcano",
            "$or": [
                {"images": {"$exists": False}},
                {"images": None},
                {"images": []},
                {"image": {"$exists": False}},
                {"image": None}
            ]
        })
        
        # Check for resume info
        scrape_session = db.scrape_progress.find_one(
            {"supplier": "Wallcano", "status": {"$in": ["running", "paused"]}},
            sort=[("started_at", -1)]
        )
        
        resume_info = None
        if scrape_session:
            resume_info = {
                "status": scrape_session.get("status"),
                "products_scraped": len(scrape_session.get("scraped_products", [])),
                "products_saved": scrape_session.get("products_saved", 0),
                "can_resume": scrape_session.get("status") == "paused"
            }
        
        return {
            "supplier": "Wallcano",
            "total_products": product_count,
            "staging_count": staging_count,
            "missing_images_count": missing_images_count,
            "last_sync": last_sync.get("timestamp") if last_sync else None,
            "last_sync_source": last_sync.get("source") if last_sync else None,
            "last_sync_count": last_sync.get("synced") if last_sync else 0,
            "resume_info": resume_info
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/products/missing-images")
def get_products_missing_images(supplier: Optional[str] = None, limit: int = 50):
    """Get products that are missing images"""
    try:
        db = get_db()
        
        query = {
            "$or": [
                {"images": {"$exists": False}},
                {"images": None},
                {"images": []},
                {"image": {"$exists": False}},
                {"image": None}
            ]
        }
        supplier = normalise_filter_value(supplier)
        if supplier:
            query["supplier"] = supplier
        
        products = list(db.supplier_products.find(
            query,
            {"_id": 0, "sku": 1, "name": 1, "product_name": 1, "supplier": 1, "url": 1}
        ).limit(limit))
        
        total = db.supplier_products.count_documents(query)
        
        return {
            "products": products,
            "total": total,
            "supplier": supplier or "all"
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
def reset_wallcano_scrape_session():
    """Reset Wallcano scrape session to start fresh"""
    try:
        db = get_db()
        result = db.scrape_progress.delete_many({"supplier": "Wallcano"})
        return {
            "success": True,
            "message": f"Scrape session reset. Deleted {result.deleted_count} session(s). Next scrape will start fresh."
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/wallcano/scrape-dealer-portal")
async def scrape_wallcano_dealer_portal():
    """
    Scrape Wallcano dealer portal using requests (no Playwright needed).
    With RESUME capability - if interrupted, will resume from where it left off.
    """
    import requests
    from bs4 import BeautifulSoup
    import json as json_lib
    import threading
    import time
    
    WALLCANO_EMAIL = "accounts@tilestation.co.uk"
    WALLCANO_PASSWORD = os.environ.get("WALLCANO_PORTAL_PASSWORD", "")
    
    BASE_URL = "https://www.wallcanotiles.com"
    LOGIN_URL = f"{BASE_URL}/login"
    
    db = get_db()
    
    # Check for existing session to resume
    existing_session = db.scrape_progress.find_one({
        "supplier": "Wallcano",
        "status": {"$in": ["running", "paused"]}
    })
    
    if existing_session:
        session_id = existing_session["_id"]
        scraped_products = set(existing_session.get("scraped_products", []))
        logger.info(f"RESUMING Wallcano scrape - {len(scraped_products)} products already done")
        db.scrape_progress.update_one(
            {"_id": session_id},
            {"$set": {"status": "running", "resumed_at": datetime.now(timezone.utc)}}
        )
    else:
        session_doc = {
            "supplier": "Wallcano",
            "started_at": datetime.now(timezone.utc),
            "status": "running",
            "scraped_products": [],
            "products_saved": 0
        }
        result = db.scrape_progress.insert_one(session_doc)
        session_id = result.inserted_id
        scraped_products = set()
        logger.info("Starting NEW Wallcano scrape session")
    
    # Create sync job
    job_id = str(uuid.uuid4())
    sync_job = {
        "id": job_id,
        "supplier": "Wallcano",
        "source": "dealer_portal_scrape",
        "status": "running",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "completed_at": None,
        "products_found": 0,
        "products_synced": 0,
        "resumed_from": len(scraped_products),
        "progress": {"stage": "starting", "current": 0, "total": 0, "message": "Initializing..."},
        "errors": []
    }
    db.sync_jobs.insert_one(sync_job)
    
    def run_scraper_thread():
        """Run the Wallcano scraper in a separate thread"""
        thread_db = get_db()
        synced = 0
        errors_list = []
        already_scraped = set(scraped_products)
        
        try:
            http_session = requests.Session()
            http_session.headers.update({
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            })
            
            # Step 1: Get login page and CSRF token
            thread_db.sync_jobs.update_one(
                {"id": job_id},
                {"$set": {"progress": {"stage": "login", "message": "Fetching login page..."}}}
            )
            
            login_page = http_session.get(LOGIN_URL, timeout=60)
            soup = BeautifulSoup(login_page.text, 'html.parser')
            csrf_input = soup.find('input', {'name': '_token'})
            csrf_token = csrf_input.get('value') if csrf_input else None
            
            # Step 2: Login
            thread_db.sync_jobs.update_one(
                {"id": job_id},
                {"$set": {"progress": {"stage": "login", "message": "Logging in..."}}}
            )
            
            login_data = {
                'email': WALLCANO_EMAIL,
                'password': WALLCANO_PASSWORD,
            }
            if csrf_token:
                login_data['_token'] = csrf_token
            
            http_session.post(LOGIN_URL, data=login_data, timeout=60)
            
            # Step 3: Get products page
            thread_db.sync_jobs.update_one(
                {"id": job_id},
                {"$set": {"progress": {"stage": "scraping", "message": "Fetching products..."}}}
            )
            
            products_url = f"{BASE_URL}/dealers/createOrder"
            products_page = http_session.get(products_url, timeout=60)
            
            # Parse products from JavaScript variable
            html = products_page.text
            match = re.search(r'var sample_product = (\[.*?\]);', html, re.DOTALL)
            
            all_products = []
            
            if match:
                try:
                    products_data = json_lib.loads(match.group(1))
                    logger.info(f"Wallcano: Found {len(products_data)} products in JavaScript")
                    
                    for p in products_data:
                        sku = p.get('sku', '')
                        name = p.get('name', '')
                        
                        if not sku or not name:
                            continue
                        
                        # Extract image from media array
                        image_url = ''
                        if p.get('media') and len(p['media']) > 0:
                            image_url = p['media'][0].get('full_image_url', '')
                        
                        # Extract size from name or sub_category
                        size = ''
                        size_match = re.search(r'(\d+)[xX](\d+)', name)
                        if size_match:
                            size = f"{size_match.group(1)}x{size_match.group(2)}"
                        elif p.get('sub_category', {}).get('name'):
                            sub_name = p['sub_category']['name']
                            size_match = re.search(r'(\d+)[xX](\d+)', sub_name)
                            if size_match:
                                size = f"{size_match.group(1)}x{size_match.group(2)}"
                        
                        # Get finishing/finish
                        finish = p.get('finishing', '')
                        
                        all_products.append({
                            "sku": sku,
                            "name": name,
                            "size": size,
                            "price": 0,  # Price not in this data, would need separate call
                            "image": image_url,
                            "finish": finish,
                            "sqm_per_box": p.get('square_meter_per_box', 0),
                            "tiles_per_box": p.get('tiles_per_box', 0)
                        })
                        
                except json_lib.JSONDecodeError as e:
                    logger.error(f"Wallcano JSON parse error: {e}")
                    errors_list.append(f"JSON parse error: {str(e)}")
            else:
                logger.warning("Wallcano: No sample_product variable found - login may have failed")
                errors_list.append("Could not find product data - login may have failed")
            
            # Step 4: Save to sync_staging
            total_products = len(all_products)
            logger.info(f"Wallcano: Saving {total_products} products to staging")
            
            for idx, product in enumerate(all_products):
                try:
                    sku = product.get('sku', '')
                    
                    if sku in already_scraped:
                        continue
                    
                    thread_db.sync_jobs.update_one(
                        {"id": job_id},
                        {"$set": {"progress": {
                            "stage": "saving",
                            "current": idx + 1,
                            "total": total_products,
                            "message": f"Processing {product.get('name', '')[:30]}..."
                        }}}
                    )
                    
                    staging_doc = {
                        "supplier": "Wallcano",
                        "sku": sku,
                        "name": product.get('name', ''),
                        "size": product.get('size', ''),
                        "material": "Porcelain",
                        "finish": product.get('finish', ''),
                        "room_lot_price": product.get('price', 0),
                        "price": product.get('price', 0),
                        "stock_sqm": 100,
                        "stock_m2": 100,
                        "stock_quantity": 100,
                        "stock_status": "In Stock",
                        "in_stock": True,
                        "images": [product.get('image')] if product.get('image') else [],
                        "sqm_per_box": product.get('sqm_per_box', 0),
                        "tiles_per_box": product.get('tiles_per_box', 0),
                        "synced_at": datetime.now(timezone.utc),
                        "sync_source": "server_scraper",
                        "status": "pending"
                    }
                    
                    existing = thread_db.supplier_products.find_one({"supplier": "Wallcano", "sku": sku})
                    
                    # Also check by name if no SKU match (for products with None codes)
                    if not existing:
                        name_match = thread_db.supplier_products.find_one({
                            "supplier": "Wallcano",
                            "name": product.get('name', ''),
                            "$or": [{"sku": None}, {"sku": ""}, {"sku": {"$exists": False}}, {"supplier_code": None}, {"supplier_code": ""}]
                        })
                        if name_match:
                            # Update existing product with new SKU
                            thread_db.supplier_products.update_one(
                                {"_id": name_match["_id"]},
                                {"$set": {"sku": sku, "supplier_code": sku}}
                            )
                            existing = name_match
                            logger.info(f"Updated existing product '{product.get('name', '')[:30]}' with new SKU: {sku}")
                    
                    staging_doc["status"] = "update" if existing else "new"
                    
                    thread_db.sync_staging.update_one(
                        {"supplier": "Wallcano", "sku": sku},
                        {"$set": staging_doc},
                        upsert=True
                    )
                    synced += 1
                    
                    if sku:
                        thread_db.scrape_progress.update_one(
                            {"_id": session_id},
                            {"$addToSet": {"scraped_products": sku}, "$set": {"products_saved": synced}}
                        )
                    
                except Exception as e:
                    errors_list.append(f"Error saving {product.get('sku', 'unknown')}: {str(e)}")
            
            # Mark complete
            thread_db.sync_logs.insert_one({
                "supplier": "Wallcano",
                "source": "portal_scrape",
                "timestamp": datetime.now(timezone.utc),
                "synced": synced,
                "errors": len(errors_list)
            })
            
            thread_db.scrape_progress.update_one(
                {"_id": session_id},
                {"$set": {"status": "completed", "completed_at": datetime.now(timezone.utc)}}
            )
            
            thread_db.sync_jobs.update_one(
                {"id": job_id},
                {"$set": {
                    "status": "completed",
                    "completed_at": datetime.now(timezone.utc).isoformat(),
                    "products_found": total_products,
                    "products_synced": synced,
                    "progress": {"stage": "complete", "message": f"Synced {synced} products to staging"},
                    "errors": errors_list[:20]
                }}
            )
            
            logger.info(f"Wallcano scrape completed: {synced} products synced")
            
        except Exception as e:
            logger.error(f"Wallcano scrape error: {e}")
            import traceback
            traceback.print_exc()
            
            thread_db.scrape_progress.update_one(
                {"_id": session_id},
                {"$set": {"status": "paused", "error": str(e), "products_saved": synced}}
            )
            thread_db.sync_jobs.update_one(
                {"id": job_id},
                {"$set": {
                    "status": "failed",
                    "completed_at": datetime.now(timezone.utc).isoformat(),
                    "errors": [str(e)]
                }}
            )
    
    # Run in background thread
    thread = threading.Thread(target=run_scraper_thread)
    thread.start()
    
    return {
        "success": True,
        "job_id": job_id,
        "message": "Wallcano dealer portal scrape started. This runs in background.",
        "check_status_url": f"/api/supplier-sync/wallcano/scrape-status/{job_id}"
    }


@router.get("/wallcano/scrape-status/{job_id}")
def get_wallcano_scrape_status(job_id: str):
    """Get the status of a Wallcano scrape job"""
    db = get_db()
    job = db.sync_jobs.find_one({"id": job_id}, {"_id": 0})
    
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    
    return job


# ============== CERAMICA IMPEX ENDPOINTS ==============

class CeramicaImpexProduct(BaseModel):
    sku: Optional[str] = None
    name: Optional[str] = None
    size: Optional[str] = None
    price: Optional[float] = 0
    stock_sqm: Optional[float] = 0
    in_stock: Optional[bool] = True
    boxes_available: Optional[int] = 0
    sqm_per_box: Optional[float] = 0
    images: Optional[List[str]] = []


# =============================================================================
# WALLCANO SERVER-SIDE SYNC ROUTES
# =============================================================================

@router.post("/wallcano/server-sync/start")
async def start_wallcano_server_sync(mode: str = "deep", fresh: int = 0):
    """
    Start a server-side Wallcano sync.
    
    IMPORTANT: Wallcano does NOT have prices on their portal.
    
    Args:
        mode: "deep" (full sync with images and details) or "light" (stock-only
              refresh of existing products — fast, used by the nightly schedule)
    """
    try:
        from services.wallcano_sync import get_sync_state, start_sync_background
        
        state = get_sync_state()
        if state["is_running"]:
            return {
                "success": False,
                "message": "Sync already in progress",
                "state": state
            }
        
        # fresh=1 wipes any saved resume progress so the deep sync re-discovers everything
        if fresh:
            from services.wallcano_sync import clear_sync_progress, get_db as _wget_db
            clear_sync_progress(_wget_db())
        
        sync_mode = "light" if mode in ("light", "quick") else "deep"
        result = start_sync_background(mode=sync_mode)
        
        return {
            "success": True,
            "mode": sync_mode,
            "message": (
                "Wallcano LIGHT sync started (stock only)." if sync_mode == "light"
                else "Wallcano sync started. NOTE: Prices are NOT available on Wallcano portal - set manually after sync."
            ),
            "note": "Check /api/supplier-sync/wallcano/server-sync/status for progress"
        }
        
    except ImportError as e:
        logger.error(f"Import error: {e}")
        return {
            "success": False,
            "error": "Wallcano sync module not available",
            "detail": str(e)
        }
    except Exception as e:
        logger.error(f"Error starting Wallcano sync: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/wallcano/server-sync/status")
def get_wallcano_server_sync_status():
    """
    Get the status of the server-side Wallcano sync.
    
    Returns progress information including:
    - is_running: Whether sync is currently running
    - phase: Current phase (login, finding_categories, finding_products, syncing, complete)
    - progress: Progress percentage (0-100)
    - message: Current status message
    - products_found: Number of products found
    - products_synced: Number of products synced
    """
    try:
        from services.wallcano_sync import get_sync_state
        return get_sync_state()
    except ImportError:
        return {
            "is_running": False,
            "phase": "error",
            "message": "Wallcano sync module not available",
            "progress": 0
        }


@router.post("/wallcano/server-sync/stop")
def stop_wallcano_server_sync():
    """Stop the running Wallcano server-side sync"""
    try:
        from services.wallcano_sync import request_stop, get_sync_state
        
        state = get_sync_state()
        if not state["is_running"]:
            return {"success": False, "message": "No sync is running"}
        
        result = request_stop()
        return {"success": True, "message": "Sync stop signal sent. Progress will be saved."}
        
    except ImportError:
        return {"success": False, "message": "Wallcano sync module not available"}
    except Exception as e:
        logger.error(f"Error stopping sync: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/wallcano/server-sync/force-reset")
def force_reset_wallcano_sync():
    """Force reset a stuck Wallcano sync state"""
    try:
        from services.wallcano_sync import reset_sync_state
        reset_sync_state()
        # Also clear any progress
        db = get_db()
        db.sync_progress.delete_many({"supplier": "Wallcano"})
        return {"success": True, "message": "Wallcano sync state forcefully reset. You can now start a new sync."}
    except Exception as e:
        logger.error(f"Error force-resetting Wallcano sync: {e}")
        raise HTTPException(status_code=500, detail=str(e))



@router.delete("/wallcano/clear-data")
def clear_wallcano_data():
    """
    Clear all Wallcano data from sync_staging and supplier_products.
    Use this before a fresh sync to start clean.
    """
    try:
        db = get_db()
        
        # Clear sync_staging
        staging_result = db.sync_staging.delete_many({"supplier": "Wallcano"})
        
        # Clear supplier_products
        products_result = db.supplier_products.delete_many({"supplier": "Wallcano"})
        
        # Clear sync progress
        db.sync_progress.delete_many({"supplier": "Wallcano"})
        
        return {
            "success": True,
            "message": "Wallcano data cleared",
            "staging_deleted": staging_result.deleted_count,
            "products_deleted": products_result.deleted_count
        }
        
    except Exception as e:
        logger.error(f"Error clearing Wallcano data: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/wallcano/export-for-pricing")
def export_wallcano_for_pricing():
    """
    Export Wallcano products to CSV format for price entry.
    Returns a CSV file with: SKU, Name, Category, Size, Stock, Cost Price, List Price
    """
    import csv
    import io
    
    try:
        db = get_db()
        products = list(db.supplier_products.find(
            {"supplier": "Wallcano"},
            {"_id": 0, "sku": 1, "name": 1, "category": 1, "size": 1, "stock_m2": 1, "cost_price": 1, "price": 1}
        ).sort("category", 1))
        
        if not products:
            raise HTTPException(status_code=404, detail="No Wallcano products found")
        
        # Create CSV in memory
        output = io.StringIO()
        writer = csv.writer(output)
        
        # Header
        writer.writerow(["SKU", "Name", "Category", "Size", "Stock (m2)", "Cost Price", "List Price"])
        
        # Data rows
        for p in products:
            writer.writerow([
                p.get("sku", ""),
                p.get("name", ""),
                p.get("category", ""),
                p.get("size", ""),
                p.get("stock_m2", 0),
                p.get("cost_price", ""),  # Empty if not set
                p.get("price", "")  # Empty if not set
            ])
        
        # Return as downloadable CSV
        csv_content = output.getvalue()
        
        return {
            "success": True,
            "total_products": len(products),
            "csv_content": csv_content,
            "instructions": "Fill in 'Cost Price' and optionally 'List Price' columns, then upload using /wallcano/import-prices"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error exporting Wallcano products: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/wallcano/import-prices")
async def import_wallcano_prices(file: UploadFile = File(...)):
    """
    Import prices for Wallcano products from CSV or Excel file.
    
    Expected columns (by name, case-insensitive):
    - SKU or Product Code (required) - to match products
    - Cost Price or Cost (required) - the cost price to set
    - List Price or Price (optional) - if not provided, will be calculated
    
    Alternative matching:
    - Name or Product Name - can match by product name if SKU not found
    """
    import csv
    import io
    
    try:
        db = get_db()
        
        # Read file content
        content = await file.read()
        filename = file.filename.lower()
        
        rows = []
        
        if filename.endswith('.xlsx') or filename.endswith('.xls'):
            # Excel file
            import openpyxl
            from io import BytesIO
            
            wb = openpyxl.load_workbook(BytesIO(content), read_only=True)
            ws = wb.active
            
            headers = None
            for row in ws.iter_rows(values_only=True):
                if headers is None:
                    headers = [str(h).lower().strip() if h else '' for h in row]
                    continue
                rows.append(dict(zip(headers, row)))
            
        elif filename.endswith('.csv'):
            # CSV file
            text_content = content.decode('utf-8-sig')  # Handle BOM
            reader = csv.DictReader(io.StringIO(text_content))
            # Normalize headers to lowercase
            for row in reader:
                normalized_row = {k.lower().strip(): v for k, v in row.items()}
                rows.append(normalized_row)
        else:
            raise HTTPException(status_code=400, detail="File must be CSV or Excel (.xlsx/.xls)")
        
        if not rows:
            raise HTTPException(status_code=400, detail="File is empty or has no data rows")
        
        # Find column mappings
        sample_row = rows[0]
        available_cols = list(sample_row.keys())
        
        # SKU column
        sku_col = None
        for col in ['sku', 'product code', 'code', 'product_code', 'productcode']:
            if col in available_cols:
                sku_col = col
                break
        
        # Name column (fallback for matching)
        name_col = None
        for col in ['name', 'product name', 'product_name', 'productname', 'title']:
            if col in available_cols:
                name_col = col
                break
        
        # Cost price column
        cost_col = None
        for col in ['cost price', 'cost_price', 'costprice', 'cost', 'unit cost', 'purchase price']:
            if col in available_cols:
                cost_col = col
                break
        
        # List price column (optional)
        list_col = None
        for col in ['list price', 'list_price', 'listprice', 'price', 'sell price', 'selling price', 'retail price']:
            if col in available_cols:
                list_col = col
                break
        
        if not sku_col and not name_col:
            raise HTTPException(
                status_code=400, 
                detail=f"Could not find SKU or Name column. Available columns: {available_cols}"
            )
        
        if not cost_col:
            raise HTTPException(
                status_code=400,
                detail=f"Could not find Cost Price column. Available columns: {available_cols}"
            )
        
        # Process rows
        updated = 0
        skipped = 0
        not_found = []
        errors = []
        
        for i, row in enumerate(rows):
            try:
                # Get SKU or name for matching
                sku = str(row.get(sku_col, '')).strip() if sku_col else ''
                name = str(row.get(name_col, '')).strip() if name_col else ''
                
                # Get cost price
                cost_value = row.get(cost_col, '')
                if cost_value is None or str(cost_value).strip() == '':
                    skipped += 1
                    continue
                
                # Parse cost price (handle £ symbol and commas)
                cost_str = str(cost_value).replace('£', '').replace(',', '').strip()
                try:
                    cost_price = float(cost_str)
                except ValueError:
                    errors.append(f"Row {i+2}: Invalid cost price '{cost_value}'")
                    continue
                
                # Get list price if provided
                list_price = None
                if list_col:
                    list_value = row.get(list_col, '')
                    if list_value and str(list_value).strip():
                        list_str = str(list_value).replace('£', '').replace(',', '').strip()
                        try:
                            list_price = float(list_str)
                        except ValueError:
                            pass  # Ignore invalid list price, will calculate
                
                # Find product in database
                query = None
                if sku:
                    query = {"supplier": "Wallcano", "sku": sku}
                    product = db.supplier_products.find_one(query)
                    
                    if not product and name:
                        # Try by name
                        query = {"supplier": "Wallcano", "name": {"$regex": f"^{re.escape(name)}$", "$options": "i"}}
                        product = db.supplier_products.find_one(query)
                elif name:
                    query = {"supplier": "Wallcano", "name": {"$regex": f"^{re.escape(name)}$", "$options": "i"}}
                    product = db.supplier_products.find_one(query)
                else:
                    skipped += 1
                    continue
                
                if not product:
                    not_found.append(sku or name)
                    continue
                
                # Update product with prices
                update_data = {
                    "cost_price": cost_price,
                    "price_updated_at": datetime.now(timezone.utc)
                }
                
                if list_price:
                    update_data["price"] = list_price
                
                db.supplier_products.update_one(
                    {"_id": product["_id"]},
                    {"$set": update_data}
                )
                
                # Also update in sync_staging if exists
                db.sync_staging.update_one(
                    {"supplier": "Wallcano", "sku": product.get("sku")},
                    {"$set": update_data}
                )
                
                updated += 1
                
            except Exception as e:
                errors.append(f"Row {i+2}: {str(e)[:50]}")
        
        return {
            "success": True,
            "message": "Price import complete",
            "updated": updated,
            "skipped": skipped,
            "not_found": len(not_found),
            "not_found_items": not_found[:10] if not_found else [],  # Show first 10
            "errors": errors[:10] if errors else [],
            "columns_detected": {
                "sku": sku_col,
                "name": name_col,
                "cost_price": cost_col,
                "list_price": list_col
            }
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error importing Wallcano prices: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/wallcano/products")
def get_wallcano_products(page: int = 1, per_page: int = 50, has_price: Optional[bool] = None):
    """
    Get Wallcano products from supplier_products collection.
    
    Args:
        page: Page number (default 1)
        per_page: Products per page (default 50, max 200)
        has_price: Filter by price status - True for with price, False for without
    """
    try:
        db = get_db()
        
        per_page = min(per_page, 200)
        skip = (page - 1) * per_page
        
        # Build query
        query = {"supplier": "Wallcano"}
        if has_price is True:
            query["cost_price"] = {"$exists": True, "$ne": None, "$gt": 0}
        elif has_price is False:
            query["$or"] = [
                {"cost_price": {"$exists": False}},
                {"cost_price": None},
                {"cost_price": 0}
            ]
        
        # Get total count
        total = db.supplier_products.count_documents(query)
        
        # Get products
        products = list(db.supplier_products.find(
            query,
            {"_id": 0}
        ).sort("name", 1).skip(skip).limit(per_page))
        
        # Count products with/without prices
        with_price = db.supplier_products.count_documents({
            "supplier": "Wallcano",
            "cost_price": {"$exists": True, "$ne": None, "$gt": 0}
        })
        without_price = db.supplier_products.count_documents({
            "supplier": "Wallcano",
            "$or": [
                {"cost_price": {"$exists": False}},
                {"cost_price": None},
                {"cost_price": 0}
            ]
        })
        
        return {
            "success": True,
            "total": total,
            "page": page,
            "per_page": per_page,
            "total_pages": (total + per_page - 1) // per_page,
            "products": products,
            "price_summary": {
                "with_price": with_price,
                "without_price": without_price
            }
        }
        
    except Exception as e:
        logger.error(f"Error getting Wallcano products: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/publish-to-website")
def publish_supplier_products_to_website(
    supplier: Optional[str] = None,
    with_price_only: bool = True,
    skus: Optional[str] = None,  # Comma-separated list of SKUs to publish
    product_group: Optional[str] = None  # Product group slug (tiles, flooring, materials, etc.)
):
    """
    Publish supplier products to the website (tiles collection).
    
    This copies products from supplier_products to tiles collection,
    making them visible on the public website.
    
    Args:
        supplier: Filter by supplier name (e.g., "Wallcano", "Verona", "Splendour")
                  If None, publishes all suppliers
        with_price_only: If True, only publish products that have prices set
        skus: Comma-separated list of specific SKUs to publish. If provided, only these SKUs will be published.
    """
    try:
        db = get_db()
        
        # Build query
        query = {}
        
        # If specific SKUs provided, only publish those (match sku OR supplier_code)
        if skus:
            sku_list = [s.strip() for s in skus.split(",") if s.strip()]
            if sku_list:
                query["$or"] = [{"sku": {"$in": sku_list}}, {"supplier_code": {"$in": sku_list}}]
        else:
            _sup = normalise_filter_value(supplier)
            if _sup:
                query["supplier"] = _sup
        
        if with_price_only and not skus:  # Don't filter by price when publishing specific SKUs
            query["$or"] = [
                {"cost_price": {"$exists": True, "$gt": 0}},
                {"price": {"$exists": True, "$gt": 0}}
            ]
        
        # Get supplier products
        supplier_products = list(db.supplier_products.find(query))
        
        if not supplier_products:
            return {
                "success": False,
                "message": "No products found to publish",
                "query": query
            }
        
        published = 0
        updated = 0
        skipped = 0
        errors = []
        
        for sp in supplier_products:
            try:
                # Generate website-friendly data
                sku = sp.get('sku') or sp.get('supplier_code') or ''
                if not sku:
                    skipped += 1
                    continue
                # Use our_product_name first (admin-customized), then product_name, then display_name, then name (original supplier)
                base_name = sp.get('our_product_name') or sp.get('product_name') or sp.get('display_name') or sp.get('name', 'Unknown Product')
                original_name = sp.get('name', 'Unknown Product')
                
                # Use the admin-saved name EXACTLY as it appears in Supplier
                # Products — no size suffix (size renders separately on the site).
                name = str(base_name).strip()
                
                # Get or generate display_code
                display_code = sp.get('display_code')
                if not display_code:
                    from business_config.business_rules import generate_display_code
                    display_code = generate_display_code(name)
                
                # Calculate prices
                cost_price = sp.get('cost_price') or 0
                list_price = sp.get('price') or sp.get('list_price') or 0
                
                # If no list price, calculate from cost (e.g., 2x markup)
                if not list_price and cost_price:
                    list_price = round(cost_price * 2, 2)
                
                # Skip if no price at all and with_price_only is True
                if with_price_only and not list_price:
                    skipped += 1
                    continue
                
                # Create slug from name
                slug = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')
                
                # Prepare tile document
                tile_doc = {
                    "id": f"tile-{sku}",
                    "name": name,
                    "display_name": name,
                    "display_code": display_code,
                    "website_name": name,
                    "original_name": original_name,
                    "sku": sku,
                    "supplier_code": sku,
                    "supplier_name": sp.get('supplier', 'Unknown'),
                    "original_supplier_name": sp.get('supplier', 'Unknown'),
                    "slug": slug,
                    "price": list_price,
                    "room_lot_price": list_price,
                    "pallet_price": sp.get('pallet_price') or (round(list_price * 0.9, 2) if list_price else 0),
                    "half_pallet_price": sp.get('half_pallet_price'),
                    "m2_per_pallet": sp.get('m2_per_pallet'),
                    "m2_per_half_pallet": sp.get('m2_per_half_pallet'),
                    "pallet_enabled": sp.get('pallet_enabled', False),
                    "cost_price": cost_price,
                    "description": sp.get('description', ''),
                    "short_description": sp.get('description', '')[:200] if sp.get('description') else '',
                    "seo_keywords": sp.get('seo_keywords', ''),
                    "hidden_seo_keywords": sp.get('hidden_seo_keywords', ''),
                    "category_ids": [],
                    "attributes": {
                        "finish": sp.get('finish') or '',
                        "material": sp.get('material') or '',
                        "size": sp.get('size') or '',
                        "color": sp.get('color') or '',
                        "thickness": sp.get('thickness') or '',
                        "suitability": sp.get('suitability') or '',
                        "edge": sp.get('edge') or '',
                        "slip_rating": sp.get('slip_rating') or ''
                    },
                    "finish": sp.get('finish') or '',
                    "material": sp.get('material') or '',
                    "size": sp.get('size') or '',
                    "color": sp.get('color') or '',
                    # Array fields — required for storefront colour/material/style aggregation
                    "colors": sp.get('colors', []) or ([sp.get('color')] if sp.get('color') else []),
                    "materials": sp.get('materials', []) or ([sp.get('material')] if sp.get('material') else []),
                    "styles": sp.get('styles', []),
                    "features": sp.get('features', []),
                    "rooms": sp.get('rooms', []),
                    "series": sp.get('series') or '',
                    "original_series": sp.get('original_series') or '',
                    "thickness": sp.get('thickness') or '',
                    "suitability": sp.get('suitability') or '',
                    "edge": sp.get('edge') or '',
                    "slip_rating": sp.get('slip_rating') or '',
                    "images": sp.get('images', []),
                    "stock": sp.get('stock_m2') or sp.get('stock_quantity') or sp.get('stock') or 0,
                    "stock_quantity": sp.get('stock_quantity') or sp.get('stock_m2') or sp.get('stock') or 0,
                    "stock_m2": sp.get('stock_m2') or 0,
                    "in_stock": bool((sp.get('stock_m2') or sp.get('stock_quantity') or sp.get('stock') or 0) > 0) if not sp.get('always_in_stock') else True,
                    "always_in_stock": sp.get('always_in_stock', False),
                    "sqm_per_box": sp.get('sqm_per_box'),
                    "tiles_per_box": sp.get('tiles_per_box'),
                    "tile_width": sp.get('tile_width'),
                    "tile_height": sp.get('tile_height'),
                    "is_active": True,
                    "is_featured": False,
                    "is_manual": False,
                    "source": "supplier_sync",
                    "source_supplier": sp.get('supplier'),
                    "product_group": sp.get('product_group') or product_group or "tiles",
                    "category": sp.get('category') or '',
                    "categories": sp.get('categories') or [],
                    "sub_category": sp.get('sub_category') or '',
                    "sub_categories": sp.get('sub_categories') or [],
                    "main_category": sp.get('main_category', ''),
                    "website_categories": sp.get('website_categories', {}),
                    "show_on_website": True,
                    "stock_status": sp.get('stock_status'),
                    "pricing_unit": sp.get('pricing_unit'),
                    "custom_labels": sp.get('custom_labels', []),
                    "collection": sp.get('collection') or sp.get('original_series') or '',
                    "labels": sp.get('labels', []),
                    "field_label_overrides": sp.get('field_label_overrides', {}),
                    "custom_specs": sp.get('custom_specs', []),
                    # Tier pricing fields
                    "tier_pricing_disabled": sp.get('tier_pricing_disabled', False),
                    "has_custom_tier_pricing": sp.get('has_custom_tier_pricing', False),
                    "tier_discounts": sp.get('tier_discounts'),
                    "tier_thresholds": sp.get('tier_thresholds'),
                    "trade_discount": sp.get('trade_discount'),
                    "trade_discount_type": sp.get('trade_discount_type') or "percent",
                    "credit_back_rate": sp.get('credit_back_rate'),
                    # Sale fields
                    "sale_active": sp.get('sale_active', False),
                    "was_price": sp.get('was_price'),
                    "discount_percentage": sp.get('discount_percentage'),
                    "sale_savings": sp.get('sale_savings'),
                    "created_at": datetime.now(timezone.utc),
                    "updated_at": datetime.now(timezone.utc),
                    "synced_at": sp.get('synced_at')
                }
                
                # Upsert to tiles collection
                result = db.tiles.update_one(
                    {"sku": sku},
                    {"$set": tile_doc},
                    upsert=True
                )
                
                if result.upserted_id:
                    published += 1
                else:
                    updated += 1
                
                # Update the supplier_products record to mark as published
                db.supplier_products.update_one(
                    {"$or": [{"sku": sku}, {"supplier_code": sku}]},
                    {"$set": {"published": True, "show_on_website": True, "in_products_db": True, "visibility": "published", "status": "active"}}
                )
                
                # Also update the products collection to remove draft status
                db.products.update_one(
                    {"sku": sku},
                    {"$set": {"show_on_website": True, "visibility": "published", "status": "active"}}
                )
                
            except Exception as e:
                errors.append(f"{sp.get('sku', 'unknown')}: {str(e)[:50]}")
        
        return {
            "success": True,
            "message": f"Published {published} new, updated {updated} products to website",
            "published": published,
            "updated": updated,
            "skipped": skipped,
            "total_processed": published + updated,
            "errors": errors[:10] if errors else []
        }
        
    except Exception as e:
        logger.error(f"Error publishing to website: {e}")
        raise HTTPException(status_code=500, detail=str(e))



@router.post("/sync-box-data-to-tiles")
def sync_box_data_to_tiles(data: dict = None):
    """
    Sync sqm_per_box and tiles_per_box from supplier_products to tiles collection.
    Use this to update existing tiles with box data that was added later.
    
    Optional filters:
    - supplier: Only sync products from this supplier
    - skus: List of specific SKUs to sync
    """
    try:
        db = get_db()
        supplier = normalise_filter_value(data.get("supplier")) if data else None
        skus = data.get("skus") if data else None
        
        # Build query for supplier_products
        query = {"$or": [
            {"sqm_per_box": {"$exists": True, "$ne": None, "$gt": 0}},
            {"tiles_per_box": {"$exists": True, "$ne": None, "$gt": 0}}
        ]}
        
        supplier = normalise_filter_value(supplier)
        if supplier:
            query["supplier"] = supplier
        if skus:
            query["sku"] = {"$in": skus}
        
        # Find all supplier_products with box data
        supplier_products = list(db.supplier_products.find(query))
        
        updated = 0
        not_found = 0
        errors = []
        
        for sp in supplier_products:
            sku = sp.get("sku")
            if not sku:
                continue
            
            sqm_per_box = sp.get("sqm_per_box")
            tiles_per_box = sp.get("tiles_per_box")
            
            if not sqm_per_box and not tiles_per_box:
                continue
            
            # Update tiles collection
            update_data = {"updated_at": datetime.now(timezone.utc)}
            if sqm_per_box:
                update_data["sqm_per_box"] = sqm_per_box
            if tiles_per_box:
                update_data["tiles_per_box"] = tiles_per_box
            
            result = db.tiles.update_one(
                {"sku": sku},
                {"$set": update_data}
            )
            
            if result.matched_count > 0:
                updated += 1
            else:
                not_found += 1
        
        return {
            "success": True,
            "message": f"Synced box data for {updated} tiles",
            "updated": updated,
            "not_found_in_tiles": not_found,
            "total_processed": len(supplier_products)
        }
    except Exception as e:
        logger.error(f"Error syncing box data: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/products/strip-duplicate-mm-size")
def strip_duplicate_mm_size(data: dict = None):
    """Clean product names that contain BOTH cm AND mm size forms (e.g. "30x60cm ... 600x300x7mm").

    Body (all optional):
      {
        "dry_run": true,           # default true — returns preview without writing
        "skus": ["..."],           # limit to specific SKUs (otherwise scans all)
        "supplier": "Verona",      # optional supplier filter
        "limit": 500,              # safety cap on how many to process
      }

    Strips the trailing mm-size token ONLY when a matching cm-form of the same
    dimension is also present earlier in the name. Updates both `supplier_products`
    AND the published `tiles` collection.
    """
    import re
    try:
        db = get_db()
        data = data or {}
        dry_run = data.get("dry_run", True)
        skus = data.get("skus")
        supplier = normalise_filter_value(data.get("supplier"))
        limit = int(data.get("limit") or 500)

        query = {}
        if skus:
            query["sku"] = {"$in": skus}
        if supplier:
            query["supplier_name"] = supplier

        trailing_mm_re = re.compile(
            r"\s+(\d+)x(\d+)(?:x[\d./]+(?:mm)?)(?:\s*mm)?\s*$",
            re.IGNORECASE,
        )

        def clean_name(n: str):
            if not n:
                return n, False
            m = trailing_mm_re.search(n)
            if not m:
                return n, False
            na = int(m.group(1))
            nb = int(m.group(2))
            if na < 100 or nb < 100:
                return n, False
            ca, cb = na / 10, nb / 10
            lower = n.lower()
            before = lower[: lower.rfind(m.group(0).lower())]
            cm_forms = [f"{ca:g}x{cb:g}cm", f"{cb:g}x{ca:g}cm", f"{ca:g}x{cb:g}", f"{cb:g}x{ca:g}"]
            if any(f in before for f in cm_forms):
                cleaned = n[: n.rfind(m.group(0))].strip()
                return cleaned, True
            return n, False

        details = []
        updated_sp = 0
        updated_tiles = 0

        cursor = db.supplier_products.find(
            query,
            {"_id": 0, "sku": 1, "display_name": 1, "product_name": 1, "name": 1, "supplier_name": 1},
        ).limit(limit)

        for doc in cursor:
            sku = doc.get("sku")
            if not sku:
                continue
            changed = {}
            for field in ("display_name", "product_name", "name"):
                orig = doc.get(field)
                cleaned, did = clean_name(orig)
                if did and cleaned and cleaned != orig:
                    changed[field] = {"before": orig, "after": cleaned}
            if not changed:
                continue
            details.append({"sku": sku, "changes": changed})
            if dry_run:
                continue
            set_doc = {f: v["after"] for f, v in changed.items()}
            r_sp = db.supplier_products.update_one({"sku": sku}, {"$set": set_doc})
            if r_sp.modified_count:
                updated_sp += 1
            r_t = db.tiles.update_one({"sku": sku}, {"$set": set_doc})
            if r_t.modified_count:
                updated_tiles += 1

        return {
            "success": True,
            "dry_run": dry_run,
            "scanned_limit": limit,
            "candidates_found": len(details),
            "supplier_products_updated": updated_sp,
            "tiles_updated": updated_tiles,
            "details": details[:200],  # cap payload
        }
    except Exception as e:
        return {"error": str(e)}


@router.post("/fix-tiles-product-group")
def fix_tiles_product_group(data: dict):
    """Fix product_group on tiles and supplier_products.
    
    Body: {
        "skus": ["HE7013FSC", "HE7012FSC"],
        "product_group": "flooring"  # optional — if omitted, uses value from supplier_products
    }
    
    Behaviour:
    - If `product_group` is provided in the body, force-sets it on BOTH `tiles` AND
      `supplier_products` for the given SKUs (keeps them in sync).
    - If `product_group` is omitted, reads the current value from `supplier_products`
      and writes it to `tiles` (legacy behaviour).
    """
    try:
        db = get_db()
        skus = data.get("skus", [])
        override_group = (data.get("product_group") or "").strip() or None
        if not skus:
            return {"error": "No SKUs provided"}
        
        fixed_tiles = 0
        fixed_supplier = 0
        details = []
        
        for sku in skus:
            target_group = override_group
            
            if not target_group:
                sp = db.supplier_products.find_one({"sku": sku}, {"product_group": 1, "_id": 0})
                if sp and sp.get("product_group"):
                    target_group = sp["product_group"]
            
            if not target_group:
                details.append({"sku": sku, "skipped": "no target product_group"})
                continue
            
            # Update tiles
            t_res = db.tiles.update_one(
                {"sku": sku},
                {"$set": {"product_group": target_group}}
            )
            if t_res.modified_count > 0:
                fixed_tiles += 1
            
            # Sync supplier_products when an override is provided
            if override_group:
                sp_res = db.supplier_products.update_one(
                    {"sku": sku},
                    {"$set": {"product_group": target_group}}
                )
                if sp_res.modified_count > 0:
                    fixed_supplier += 1
            
            details.append({
                "sku": sku,
                "product_group": target_group,
                "tiles_matched": t_res.matched_count,
                "tiles_modified": t_res.modified_count,
            })
        
        return {
            "success": True,
            "fixed_tiles": fixed_tiles,
            "fixed_supplier_products": fixed_supplier,
            "total": len(skus),
            "details": details,
        }
    except Exception as e:
        return {"error": str(e)}


@router.get("/website-tiles-count")
def get_website_tiles_count():
    """Get count of tiles published to website by supplier"""
    try:
        db = get_db()
        
        total = db.tiles.count_documents({})
        
        # By supplier
        pipeline = [
            {"$group": {"_id": "$source_supplier", "count": {"$sum": 1}}}
        ]
        by_supplier = list(db.tiles.aggregate(pipeline))
        
        return {
            "total_tiles": total,
            "by_supplier": {s["_id"] or "Unknown": s["count"] for s in by_supplier}
        }
        
    except Exception as e:
        logger.error(f"Error getting tiles count: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/unpublish-from-website")
def unpublish_from_website(
    supplier: Optional[str] = None,
    sku: Optional[str] = None,
    skus: Optional[str] = None  # Comma-separated list of SKUs
):
    """
    Unpublish products from the website (remove from tiles collection).
    
    Args:
        supplier: Remove all products from this supplier
        sku: Remove a single product by SKU
        skus: Remove multiple products by comma-separated SKUs
    """
    try:
        db = get_db()
        
        deleted_count = 0
        supplier_updated = 0
        
        if sku:
            # Delete single product - try multiple field names
            result = db.tiles.delete_one({"$or": [{"sku": sku}, {"supplier_code": sku}]})
            deleted_count = result.deleted_count
            
            # ALWAYS update supplier_products to mark as unpublished (even if tiles delete returned 0)
            sp_result = db.supplier_products.update_one(
                {"sku": sku},
                {"$set": {"published": False, "show_on_website": False}}
            )
            supplier_updated = sp_result.modified_count
            
            # Update products collection visibility (don't delete, just hide)
            db.products.update_one(
                {"sku": sku},
                {"$set": {"show_on_website": False, "visibility": "draft"}}
            )
            
        elif skus:
            # Delete multiple products - try multiple field names
            sku_list = [s.strip() for s in skus.split(",") if s.strip()]
            result = db.tiles.delete_many({"$or": [{"sku": {"$in": sku_list}}, {"supplier_code": {"$in": sku_list}}]})
            deleted_count = result.deleted_count
            
            # ALWAYS update supplier_products (even if tiles delete returned 0)
            sp_result = db.supplier_products.update_many(
                {"$or": [{"sku": {"$in": sku_list}}, {"supplier_code": {"$in": sku_list}}]},
                {"$set": {"published": False, "show_on_website": False}}
            )
            supplier_updated = sp_result.modified_count
            logger.info(f"Updated {supplier_updated} supplier_products records for SKUs: {sku_list}")
            
            # Update products collection visibility (don't delete, just hide)
            db.products.update_many(
                {"sku": {"$in": sku_list}},
                {"$set": {"show_on_website": False, "visibility": "draft"}}
            )
            
        elif supplier:
            # Delete all from supplier
            result = db.tiles.delete_many({"source_supplier": supplier})
            deleted_count = result.deleted_count
            
            # Update supplier_products
            db.supplier_products.update_many(
                {"supplier": supplier},
                {"$set": {"published": False, "show_on_website": False, "in_products_db": False}}
            )
            
        else:
            # Delete ALL tiles from website
            result = db.tiles.delete_many({})
            deleted_count = result.deleted_count
            
            # Update all supplier_products
            sp_result = db.supplier_products.update_many(
                {},
                {"$set": {"show_on_website": False, "in_products_db": False}}
            )
            supplier_updated = sp_result.modified_count
        
        return {
            "success": True,
            "message": f"Unpublished {deleted_count} products from website, updated {supplier_updated} supplier records",
            "deleted_count": deleted_count,
            "supplier_updated": supplier_updated
        }
        
    except Exception as e:
        logger.error(f"Error unpublishing from website: {e}")
        raise HTTPException(status_code=500, detail=str(e))



@router.post("/cleanup-orphaned-tiles")
def cleanup_orphaned_tiles(confirm: bool = False):
    """
    Find and remove tiles (storefront products) whose SKU no longer exists
    in supplier_products. These are orphaned entries from products that were
    deleted from the admin but not properly cascaded to the storefront.
    """
    try:
        db = get_db()
        
        # Get all SKUs in tiles
        tile_skus = set()
        for t in db.tiles.find({}, {"sku": 1}):
            if t.get("sku"):
                tile_skus.add(t["sku"])
        
        if not tile_skus:
            return {"success": True, "orphaned": 0, "message": "No tiles found"}
        
        # Get all SKUs in supplier_products
        sp_skus = set()
        for sp in db.supplier_products.find({}, {"sku": 1}):
            if sp.get("sku"):
                sp_skus.add(sp["sku"])
        
        # Find orphaned tiles (in tiles but not in supplier_products)
        orphaned_skus = tile_skus - sp_skus
        
        if not orphaned_skus:
            return {"success": True, "orphaned": 0, "message": "No orphaned tiles found"}
        
        # Get details of orphaned tiles for preview
        orphaned_details = []
        for t in db.tiles.find({"sku": {"$in": list(orphaned_skus)}}, {"_id": 0, "sku": 1, "name": 1, "display_name": 1, "supplier": 1}):
            orphaned_details.append({
                "sku": t.get("sku"),
                "name": t.get("display_name") or t.get("name"),
                "supplier": t.get("supplier")
            })
        
        if not confirm:
            return {
                "success": True,
                "orphaned": len(orphaned_skus),
                "message": f"Found {len(orphaned_skus)} orphaned tiles. Set confirm=true to delete them.",
                "orphaned_products": orphaned_details[:50]  # Show first 50
            }
        
        # Delete orphaned tiles
        result = db.tiles.delete_many({"sku": {"$in": list(orphaned_skus)}})
        
        return {
            "success": True,
            "deleted": result.deleted_count,
            "message": f"Cleaned up {result.deleted_count} orphaned tiles from storefront"
        }
        
    except Exception as e:
        logger.error(f"Cleanup orphaned tiles error: {e}")
        raise HTTPException(status_code=500, detail=str(e))




@router.post("/delete-tiles-by-name")
def delete_tiles_by_name(data: dict):
    """Delete tiles from storefront matching a name pattern"""
    try:
        db = get_db()
        name_pattern = data.get("name_pattern", "").strip()
        confirm = data.get("confirm", False)
        
        if not name_pattern:
            raise HTTPException(status_code=400, detail="name_pattern is required")
        
        # Find matching tiles
        query = {"$or": [
            {"name": {"$regex": name_pattern, "$options": "i"}},
            {"display_name": {"$regex": name_pattern, "$options": "i"}},
        ]}
        
        matching = list(db.tiles.find(query, {"_id": 0, "sku": 1, "name": 1, "display_name": 1}))
        
        if not matching:
            return {"success": True, "found": 0, "message": "No matching tiles found"}
        
        if not confirm:
            return {
                "success": True,
                "found": len(matching),
                "message": f"Found {len(matching)} tiles matching '{name_pattern}'. Set confirm=true to delete.",
                "tiles": [{"sku": t.get("sku"), "name": t.get("display_name") or t.get("name")} for t in matching]
            }
        
        result = db.tiles.delete_many(query)
        return {
            "success": True,
            "deleted": result.deleted_count,
            "message": f"Deleted {result.deleted_count} tiles matching '{name_pattern}'"
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Delete tiles by name error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/migrate-display-codes")
def migrate_display_codes():
    """
    One-time migration to add display_code to existing tiles and supplier_products.
    Generates display_code from display_name for all products that don't have one.
    """
    from business_config.business_rules import generate_display_code
    
    try:
        db = get_db()
        
        tiles_updated = 0
        supplier_products_updated = 0
        
        # Update tiles collection
        tiles = db.tiles.find({"$or": [
            {"display_code": {"$exists": False}},
            {"display_code": ""},
            {"display_code": None}
        ]})
        
        for tile in tiles:
            display_name = tile.get("display_name") or tile.get("name", "")
            if display_name:
                display_code = generate_display_code(display_name)
                db.tiles.update_one(
                    {"_id": tile["_id"]},
                    {"$set": {"display_code": display_code}}
                )
                tiles_updated += 1
        
        # Update supplier_products collection
        supplier_products = db.supplier_products.find({"$or": [
            {"display_code": {"$exists": False}},
            {"display_code": ""},
            {"display_code": None}
        ]})
        
        for sp in supplier_products:
            display_name = sp.get("our_product_name") or sp.get("display_name") or sp.get("product_name") or sp.get("name", "")
            if display_name:
                display_code = generate_display_code(display_name)
                db.supplier_products.update_one(
                    {"_id": sp["_id"]},
                    {"$set": {"display_code": display_code}}
                )
                supplier_products_updated += 1
        
        return {
            "success": True,
            "message": "Migration complete",
            "tiles_updated": tiles_updated,
            "supplier_products_updated": supplier_products_updated
        }
        
    except Exception as e:
        logger.error(f"Error migrating display codes: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/staging/stats")
def get_staging_stats():
    """Get stats for all supplier products in the database"""
    try:
        db = get_db()
        
        # Get counts by supplier from supplier_products
        pipeline = [
            {"$group": {"_id": "$supplier", "count": {"$sum": 1}}}
        ]
        by_supplier = list(db.supplier_products.aggregate(pipeline))
        
        total = sum(s.get("count", 0) for s in by_supplier)
        
        return {
            "total": total,
            "by_supplier": by_supplier
        }
        
    except Exception as e:
        logger.error(f"Error getting staging stats: {e}")
        raise HTTPException(status_code=500, detail=str(e))


class CeramicaImpexSyncRequest(BaseModel):
    products: List[CeramicaImpexProduct]
    source: str = "browser_extension"


@router.post("/ceramica-impex/products")
def sync_ceramica_impex_products(data: CeramicaImpexSyncRequest):
    """
    Receive product data from the Ceramica Impex browser extension - writes to sync_staging for review
    """
    try:
        from business_config.business_rules import is_non_tile_product
        
        db = get_db()
        
        synced = 0
        updated = 0
        new = 0
        errors = 0
        ignored = 0
        excluded_non_tile = 0
        
        for product in data.products:
            try:
                if not product.name and not product.sku:
                    continue
                
                sku = product.sku
                if not sku:
                    errors += 1
                    continue
                
                # CHECK: Skip non-tile products (grout, sealant, adhesive, etc.)
                should_skip, skip_reason = is_non_tile_product(product.name or "", "", "")
                if should_skip:
                    excluded_non_tile += 1
                    logger.debug(f"Skipping non-tile product: {product.name} - {skip_reason}")
                    continue
                
                # Check if this product is in the ignored list
                is_ignored = db.ignored_products.find_one({
                    "sku": sku,
                    "supplier": "Ceramica Impex"
                })
                
                if is_ignored:
                    ignored += 1
                    continue
                
                product_data = {
                    "supplier": "Ceramica Impex",
                    "sku": sku,
                    "name": construct_complete_name(product.name, product.size, None),  # Complete name with size
                    "size": product.size,
                    "price": product.price,
                    "stock_m2": product.stock_sqm or 0,
                    "in_stock": product.in_stock if product.in_stock is not None else (product.stock_sqm or 0) > 0,
                    "boxes_available": product.boxes_available,
                    "sqm_per_box": product.sqm_per_box,
                    "synced_at": datetime.now(timezone.utc),
                    "sync_source": data.source
                }
                
                # Handle images - upload to R2 cloud storage
                images_list = product.images if product.images else []
                source_urls = images_list.copy() if images_list else []
                
                # Get existing product for image change detection
                existing_staging = db.sync_staging.find_one({"supplier": "Ceramica Impex", "sku": sku})
                existing_source_urls = existing_staging.get("image_source_urls", []) if existing_staging else []
                
                # Upload images to R2 if available
                if is_r2_available() and process_product_images_sync and images_list:
                    try:
                        processed_images, returned_source_urls = process_product_images_sync(
                            images_list,
                            "Ceramica Impex",
                            product.name or sku,
                            existing_source_urls
                        )
                        if processed_images:
                            images_list = processed_images
                            source_urls = returned_source_urls
                            product_data["images_uploaded_to_r2"] = True
                    except Exception as img_err:
                        logger.warning(f"Failed to upload Ceramica Impex images to R2: {img_err}")
                
                # Store images
                if images_list:
                    product_data["images"] = images_list
                    product_data["image"] = images_list[0]
                    product_data["image_source_urls"] = source_urls
                else:
                    product_data["images"] = []
                    product_data["image"] = None
                
                # Generate transformed product name
                # CUSTOM MAPPINGS: Check for custom mapping first before auto-generating
                finish = getattr(product, 'finish', None)
                complete_name = product_data["name"]  # Use the already constructed complete name
                if CUSTOM_MAPPINGS_AVAILABLE and get_display_name_with_custom_check and sku:
                    product_data["product_name"] = get_display_name_with_custom_check(
                        db, complete_name, "Ceramica Impex", sku, finish
                    )
                else:
                    from business_config.business_rules import get_display_name
                    product_data["product_name"] = get_display_name(complete_name, "Ceramica Impex", finish)
                
                # Check if existing in supplier_products
                existing = db.supplier_products.find_one({
                    "sku": sku,
                    "supplier": "Ceramica Impex"
                })
                
                result = db.sync_staging.update_one(
                    {"supplier": "Ceramica Impex", "sku": sku},
                    {
                        "$set": product_data,
                        "$setOnInsert": {"created_at": datetime.now(timezone.utc)}
                    },
                    upsert=True
                )
                
                if result.upserted_id:
                    if existing:
                        updated += 1
                    else:
                        new += 1
                elif result.modified_count > 0:
                    updated += 1
                synced += 1
                
            except Exception as e:
                logger.error(f"Error syncing Ceramica Impex product {product.name}: {e}")
                errors += 1
        
        db.sync_logs.insert_one({
            "supplier": "Ceramica Impex",
            "source": data.source,
            "destination": "sync_staging",
            "timestamp": datetime.now(timezone.utc),
            "products_received": len(data.products),
            "synced": synced,
            "updated": updated,
            "new": new,
            "ignored": ignored,
            "errors": errors
        })
        
        return dict(
            success=True,
            synced=synced,
            updated=updated,
            new=new,
            errors=errors,
            message=f"Staged {synced} products for review ({new} new, {updated} updates, {ignored} ignored)"
        )
        
    except Exception as e:
        logger.error(f"Ceramica Impex sync error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/ceramica-impex/status")
def get_ceramica_impex_status():
    try:
        db = get_db()
        last_sync = db.sync_logs.find_one({"supplier": "Ceramica Impex"}, sort=[("timestamp", -1)])
        product_count = db.supplier_products.count_documents({"supplier": "Ceramica Impex"})
        staging_count = db.sync_staging.count_documents({"supplier": "Ceramica Impex"})
        
        # Check for resume info
        scrape_session = db.scrape_progress.find_one(
            {"supplier": "Ceramica Impex", "status": {"$in": ["running", "paused"]}},
            sort=[("started_at", -1)]
        )
        
        resume_info = None
        if scrape_session:
            resume_info = {
                "status": scrape_session.get("status"),
                "products_scraped": len(scrape_session.get("scraped_products", [])),
                "products_saved": scrape_session.get("products_saved", 0),
                "can_resume": scrape_session.get("status") == "paused"
            }
        
        # Check for running job
        running_job = db.sync_jobs.find_one(
            {"supplier": "Ceramica Impex", "status": "running"},
            sort=[("started_at", -1)]
        )
        
        return {
            "supplier": "Ceramica Impex",
            "total_products": product_count,
            "staging_count": staging_count,
            "last_sync": last_sync.get("timestamp") if last_sync else None,
            "last_sync_source": last_sync.get("source") if last_sync else None,
            "last_sync_count": last_sync.get("synced") if last_sync else 0,
            "running_job": running_job.get("id") if running_job else None,
            "resume_info": resume_info
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/ceramica-impex/reset-session")
def reset_ceramica_impex_scrape_session():
    """Reset Ceramica Impex scrape session to start fresh"""
    try:
        db = get_db()
        result = db.scrape_progress.delete_many({"supplier": "Ceramica Impex"})
        return {
            "success": True,
            "message": f"Scrape session reset. Deleted {result.deleted_count} session(s). Next scrape will start fresh."
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/ceramica-impex/scrape-portal")
async def scrape_ceramica_impex_portal():
    """
    Scrape Ceramica Impex B2B portal using requests (no Playwright needed).
    With RESUME capability - if interrupted, will resume from where it left off.
    """
    import requests
    from bs4 import BeautifulSoup
    import json as json_lib
    import threading
    import time
    
    CERAMICA_EMAIL = "qasim@tilestation.co.uk"
    CERAMICA_PASSWORD = os.environ.get("CERAMICA_PORTAL_PASSWORD", "")
    
    BASE_URL = "https://portal.ceramicaimpex.co.uk"
    LOGIN_URL = f"{BASE_URL}/login/default.aspx"
    
    db = get_db()
    
    # Check for existing session to resume
    existing_session = db.scrape_progress.find_one({
        "supplier": "Ceramica Impex",
        "status": {"$in": ["running", "paused"]}
    })
    
    if existing_session:
        session_id = existing_session["_id"]
        scraped_products = set(existing_session.get("scraped_products", []))
        logger.info(f"RESUMING Ceramica Impex scrape - {len(scraped_products)} products already done")
        db.scrape_progress.update_one(
            {"_id": session_id},
            {"$set": {"status": "running", "resumed_at": datetime.now(timezone.utc)}}
        )
    else:
        session_doc = {
            "supplier": "Ceramica Impex",
            "started_at": datetime.now(timezone.utc),
            "status": "running",
            "scraped_products": [],
            "products_saved": 0
        }
        result = db.scrape_progress.insert_one(session_doc)
        session_id = result.inserted_id
        scraped_products = set()
        logger.info("Starting NEW Ceramica Impex scrape session")
    
    # Create sync job
    job_id = str(uuid.uuid4())
    sync_job = {
        "id": job_id,
        "supplier": "Ceramica Impex",
        "source": "portal_scrape",
        "status": "running",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "completed_at": None,
        "products_found": 0,
        "products_synced": 0,
        "resumed_from": len(scraped_products),
        "progress": {"stage": "starting", "message": "Initializing scraper..."},
        "errors": []
    }
    db.sync_jobs.insert_one(sync_job)
    
    def run_scraper_thread():
        """Run the scraper in a separate thread"""
        # Get fresh DB connection for this thread
        thread_db = get_db()
        synced = 0
        errors_list = []
        already_scraped = set(scraped_products)
        
        try:
            # Create requests session
            http_session = requests.Session()
            http_session.headers.update({
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            })
            
            # Step 1: Get login page
            thread_db.sync_jobs.update_one(
                {"id": job_id},
                {"$set": {"progress": {"stage": "login", "message": "Fetching login page..."}}}
            )
            
            login_page = http_session.get(LOGIN_URL, timeout=60)
            soup = BeautifulSoup(login_page.text, 'html.parser')
            
            # Extract ASP.NET form fields
            viewstate = soup.find('input', {'name': '__VIEWSTATE'})
            viewstate_gen = soup.find('input', {'name': '__VIEWSTATEGENERATOR'})
            event_validation = soup.find('input', {'name': '__EVENTVALIDATION'})
            
            # Build login data - field name is 'uname' not 'username'
            login_data = {
                'uname': CERAMICA_EMAIL,
                'pword': CERAMICA_PASSWORD,
            }
            
            if viewstate:
                login_data['__VIEWSTATE'] = viewstate.get('value', '')
            if viewstate_gen:
                login_data['__VIEWSTATEGENERATOR'] = viewstate_gen.get('value', '')
            if event_validation:
                login_data['__EVENTVALIDATION'] = event_validation.get('value', '')
            
            # Step 2: Submit login
            thread_db.sync_jobs.update_one(
                {"id": job_id},
                {"$set": {"progress": {"stage": "login", "message": "Logging in..."}}}
            )
            
            http_session.post(LOGIN_URL, data=login_data, timeout=60)
            
            # Step 3: Scrape categories - including Fireplaces
            categories = ["/Catalogue/Tiles", "/Catalogue/Fireplaces"]  # Main category + Fireplaces
            all_products = []
            
            for cat_idx, category in enumerate(categories):
                thread_db.sync_jobs.update_one(
                    {"id": job_id},
                    {"$set": {"progress": {
                        "stage": "scraping",
                        "current": cat_idx + 1,
                        "total": len(categories),
                        "message": f"Scraping {category}..."
                    }}}
                )
                
                cat_url = f"{BASE_URL}{category}"
                response = http_session.get(cat_url, timeout=60)
                html = response.text
                
                # Extract FASTNodes JSON
                match = re.search(r'data-type="FASTNodes"[^>]*>(\{.*?\})</script>', html, re.DOTALL)
                
                if match:
                    try:
                        json_str = match.group(1)
                        data = json_lib.loads(json_str)
                        nodes = data.get('Nodes', [])
                        
                        logger.info(f"Ceramica Impex: Found {len(nodes)} nodes in {category}")
                        
                        for node in nodes:
                            if node.get('Type') and node.get('Type') != 'P':
                                continue
                            
                            name = node.get('Name', '')
                            code = node.get('StockCode', '')
                            price = node.get('SortPrice', 0)
                            image_url = node.get('ImageHref', '')
                            
                            if not name or not code:
                                continue
                            
                            # Skip already scraped
                            if code in already_scraped:
                                continue
                            
                            # Extract size
                            size_match = re.search(r'(\d+)[xX](\d+)', name)
                            size = f"{size_match.group(1)}x{size_match.group(2)}" if size_match else ""
                            
                            # Determine material and finish
                            name_lower = name.lower()
                            material = "Porcelain"
                            if "ceramic" in name_lower:
                                material = "Ceramic"
                            elif "glass" in name_lower:
                                material = "Glass"
                            
                            finish = ""
                            if "polished" in name_lower:
                                finish = "Polished"
                            elif "matt" in name_lower:
                                finish = "Matt"
                            
                            all_products.append({
                                "sku": code,
                                "name": name,
                                "size": size,
                                "material": material,
                                "finish": finish,
                                "price": float(price) if price else 0,
                                "image": image_url
                            })
                            
                    except json_lib.JSONDecodeError as e:
                        errors_list.append(f"JSON parse error in {category}: {str(e)}")
                
                time.sleep(0.5)
            
            # Step 4: Save to sync_staging
            total_products = len(all_products)
            logger.info(f"Ceramica Impex: Saving {total_products} products to staging")
            
            for idx, product in enumerate(all_products):
                try:
                    sku = product.get('sku', '')
                    
                    thread_db.sync_jobs.update_one(
                        {"id": job_id},
                        {"$set": {"progress": {
                            "stage": "saving",
                            "current": idx + 1,
                            "total": total_products,
                            "message": f"Saving {product.get('name', '')[:30]}..."
                        }}}
                    )
                    
                    staging_doc = {
                        "supplier": "Ceramica Impex",
                        "sku": sku,
                        "name": product.get('name', ''),
                        "size": product.get('size', ''),
                        "material": product.get('material', 'Porcelain'),
                        "finish": product.get('finish', ''),
                        "room_lot_price": product.get('price', 0),
                        "cost_price": product.get('price', 0),  # Explicitly store cost price for Apply endpoint
                        "price": product.get('price', 0),  # Raw cost price from portal
                        "stock_sqm": 100,
                        "stock_m2": 100,
                        "stock_quantity": 100,
                        "stock_status": "In Stock",
                        "in_stock": True,
                        "images": [product.get('image')] if product.get('image') else [],
                        "synced_at": datetime.now(timezone.utc),
                        "sync_source": "server_scraper",
                        "status": "pending"
                    }
                    
                    # Check if exists by SKU
                    existing = thread_db.supplier_products.find_one({"supplier": "Ceramica Impex", "sku": sku})
                    
                    # Also check by name if no SKU match (for products with None codes)
                    if not existing:
                        name_match = thread_db.supplier_products.find_one({
                            "supplier": "Ceramica Impex",
                            "name": staging_doc.get('name', ''),
                            "$or": [{"sku": None}, {"sku": ""}, {"sku": {"$exists": False}}, {"supplier_code": None}, {"supplier_code": ""}]
                        })
                        if name_match:
                            # Update existing product with new SKU
                            thread_db.supplier_products.update_one(
                                {"_id": name_match["_id"]},
                                {"$set": {"sku": sku, "supplier_code": sku}}
                            )
                            existing = name_match
                            logger.info(f"Updated existing Ceramica product with new SKU: {sku}")
                    
                    staging_doc["status"] = "update" if existing else "new"
                    
                    result = thread_db.sync_staging.update_one(
                        {"supplier": "Ceramica Impex", "sku": sku},
                        {"$set": staging_doc},
                        upsert=True
                    )
                    
                    if idx < 3:  # Log first 3 saves for debugging
                        logger.info(f"Ceramica save {idx+1}: {sku} - upserted_id={result.upserted_id}, modified={result.modified_count}")
                    
                    synced += 1
                    
                    # Track for resume
                    if sku:
                        thread_db.scrape_progress.update_one(
                            {"_id": session_id},
                            {"$addToSet": {"scraped_products": sku}, "$set": {"products_saved": synced}}
                        )
                    
                except Exception as e:
                    errors_list.append(f"Error saving {product.get('sku', 'unknown')}: {str(e)}")
            
            # Log completion
            thread_db.sync_logs.insert_one({
                "supplier": "Ceramica Impex",
                "source": "portal_scrape",
                "timestamp": datetime.now(timezone.utc),
                "synced": synced,
                "errors": len(errors_list)
            })
            
            # Mark session complete
            thread_db.scrape_progress.update_one(
                {"_id": session_id},
                {"$set": {"status": "completed", "completed_at": datetime.now(timezone.utc)}}
            )
            
            thread_db.sync_jobs.update_one(
                {"id": job_id},
                {"$set": {
                    "status": "completed",
                    "completed_at": datetime.now(timezone.utc).isoformat(),
                    "products_found": total_products,
                    "products_synced": synced,
                    "progress": {"stage": "complete", "message": f"Synced {synced} products to staging"},
                    "errors": errors_list[:20]
                }}
            )
            
            logger.info(f"Ceramica Impex scrape completed: {synced} products synced")
            
        except Exception as e:
            logger.error(f"Ceramica Impex scrape error: {e}")
            import traceback
            traceback.print_exc()
            
            thread_db.scrape_progress.update_one(
                {"_id": session_id},
                {"$set": {"status": "paused", "error": str(e), "products_saved": synced}}
            )
            thread_db.sync_jobs.update_one(
                {"id": job_id},
                {"$set": {
                    "status": "failed",
                    "completed_at": datetime.now(timezone.utc).isoformat(),
                    "errors": [str(e)]
                }}
            )
    
    # Run in background thread
    thread = threading.Thread(target=run_scraper_thread)
    thread.start()
    
    return {
        "success": True,
        "job_id": job_id,
        "message": "Ceramica Impex portal scrape started. This runs in background.",
        "check_status_url": f"/api/supplier-sync/ceramica-impex/scrape-status/{job_id}"
    }


@router.get("/ceramica-impex/scrape-status/{job_id}")
def get_ceramica_impex_scrape_status(job_id: str):
    """Get the status of a Ceramica Impex scrape job"""
    db = get_db()
    job = db.sync_jobs.find_one({"id": job_id}, {"_id": 0})
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


# =============================================================================
# CERAMICA IMPEX SERVER-SIDE SYNC (RECOMMENDED APPROACH)
# =============================================================================
# This runs the full sync on the server using Playwright.
# User just clicks a button in Sync Hub - no browser extension needed.
# Supports TWO modes: DEEP (full sync) and LIGHT (price/stock only)

@router.post("/ceramica-impex/server-sync/start")
async def start_ceramica_impex_server_sync(categories: List[str] = None, mode: str = "deep", fresh: int = 0):
    """
    Start a server-side Ceramica Impex sync.
    
    This is the RECOMMENDED approach - runs on the server, no browser extension needed.
    
    MODES:
    - "deep" (default): Full sync with images, product details, etc. Use for initial setup.
    - "light": Only sync stock and prices. Use for daily/weekly updates.
    
    Args:
        categories: Optional list of categories to sync (only for deep mode)
        mode: "deep" for full sync with images, "light" for stock/price only
    """
    import threading
    
    try:
        from services.ceramica_impex_sync import get_sync_state, run_deep_sync, run_light_sync
        
        state = get_sync_state()
        if state["is_running"]:
            return {
                "success": False,
                "message": "Sync already in progress",
                "state": state
            }
        
        db = get_db()
        
        # fresh=1 wipes any saved resume progress so the deep sync re-discovers everything
        if fresh:
            from services.ceramica_impex_sync import clear_sync_progress
            clear_sync_progress(db)
        
        if mode == "light":
            # Light sync - stock and price only
            def run_sync_thread():
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                try:
                    loop.run_until_complete(run_light_sync(db))
                finally:
                    loop.close()
            
            thread = threading.Thread(target=run_sync_thread, daemon=True)
            thread.start()
            
            return {
                "success": True,
                "mode": "light",
                "message": "LIGHT sync started (stock & price only)",
                "note": "Check /api/supplier-sync/ceramica-impex/server-sync/status for progress"
            }
        else:
            # Deep sync - full sync with images
            def run_sync_thread():
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                try:
                    loop.run_until_complete(run_deep_sync(db, categories))
                finally:
                    loop.close()
            
            thread = threading.Thread(target=run_sync_thread, daemon=True)
            thread.start()
            
            return {
                "success": True,
                "mode": "deep",
                "message": "DEEP sync started (full product info with images)",
                "note": "Check /api/supplier-sync/ceramica-impex/server-sync/status for progress"
            }
        
    except ImportError as e:
        logger.error(f"Import error: {e}")
        return {
            "success": False,
            "error": "Server-side sync module not available",
            "detail": str(e)
        }
    except Exception as e:
        logger.error(f"Error starting sync: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/ceramica-impex/server-sync/status")
def get_ceramica_impex_server_sync_status():
    """
    Get the status of the server-side Ceramica Impex sync.
    
    Returns progress information including:
    - is_running: Whether sync is currently running
    - sync_mode: "deep" or "light"
    - phase: Current phase (login, finding_categories, finding_products, syncing, complete)
    - progress: Progress percentage (0-100)
    - message: Current status message
    - products_found: Number of products found
    - products_synced: Number of products synced
    - products_skipped: Number of products skipped (light mode)
    """
    try:
        from services.ceramica_impex_sync import get_sync_state
        return get_sync_state()
    except ImportError:
        return {
            "is_running": False,
            "phase": "error",
            "message": "Server-side sync module not available",
            "progress": 0
        }


@router.post("/ceramica-impex/server-sync/stop")
def stop_ceramica_impex_server_sync():
    """Stop the running server-side sync"""
    try:
        from services.ceramica_impex_sync import update_state, get_sync_state
        
        state = get_sync_state()
        if not state["is_running"]:
            return {"success": False, "message": "No sync is running"}
        
        update_state(is_running=False, phase="stopped", message="Sync stopped by user")
        return {"success": True, "message": "Sync stop signal sent"}
        
    except ImportError:
        return {"success": False, "error": "Module not available"}


@router.get("/verona/products")
def get_verona_products(skip: int = 0, limit: int = 50, search: Optional[str] = None):
    """
    Get synced Verona products
    """
    try:
        db = get_db()
        
        query = {"supplier": "Verona"}
        if search:
            query["$or"] = [
                {"name": {"$regex": search, "$options": "i"}},
                {"product_name": {"$regex": search, "$options": "i"}},
                {"sku": {"$regex": search, "$options": "i"}},
                {"supplier_product_name": {"$regex": search, "$options": "i"}}
            ]
        
        products_cursor = db.supplier_products.find(
            query,
            {"_id": 0}
        ).skip(skip).limit(limit).sort("last_synced", -1)
        
        # Transform products for frontend
        products = []
        for p in products_cursor:
            product = {
                "name": p.get("name"),
                "product_name": p.get("product_name"),
                "unique_name": p.get("unique_name"),
                "sku": p.get("sku"),
                "url": p.get("url"),
                "image": p.get("images", [None])[0] if p.get("images") else p.get("image"),
                "price": p.get("price") or p.get("trade_price"),
                "cost_price": p.get("cost_price"),
                "cost_each": p.get("cost_each"),
                "cost_m2": p.get("cost_m2"),
                "size_unit": p.get("size_unit", "m2"),
                "stock_quantity": p.get("stock_quantity"),
                "stock_m2": p.get("stock_m2"),
                "in_stock": p.get("in_stock"),
                "stock_text": p.get("stock_text"),
                "category": p.get("category"),
                "synced_at": p.get("last_synced").isoformat() if p.get("last_synced") and hasattr(p.get("last_synced"), 'isoformat') else p.get("last_synced")
            }
            products.append(product)
        
        total = db.supplier_products.count_documents(query)
        
        return {
            "products": products,
            "total": total,
            "skip": skip,
            "limit": limit
        }
        
    except Exception as e:
        logger.error(f"Error getting Verona products: {e}")
        raise HTTPException(status_code=500, detail=str(e))



@router.get("/products")
def get_all_supplier_products(
    skip: int = 0, 
    limit: int = 50, 
    supplier: Optional[str] = None,
    search: Optional[str] = None,
    new_only: Optional[bool] = False,
    series: Optional[str] = None
):
    """
    Get products from all suppliers with optional filtering
    """
    try:
        db = get_db()
        
        query = {}
        supplier = normalise_filter_value(supplier)
        if supplier:
            query["supplier"] = supplier
        if search:
            query["$or"] = [
                {"name": {"$regex": search, "$options": "i"}},
                {"product_name": {"$regex": search, "$options": "i"}},
                {"sku": {"$regex": search, "$options": "i"}},
                {"category": {"$regex": search, "$options": "i"}},
                {"supplier_product_name": {"$regex": search, "$options": "i"}}
            ]
        
        # Series filter — match `series` field exactly. Required so the
        # frontend dropdown ("Metallique (13)") returns ONLY those 13
        # products even when the supplier dropdown is "All". Without
        # this, the frontend was applying the series filter to only the
        # 50-product paginated page returned by the API, which usually
        # contained zero matches → "No products found".
        series = normalise_filter_value(series) if series else None
        if series:
            query["series"] = series
        
        # Filter for new products (not yet added to Products database)
        if new_only:
            query["in_products_db"] = {"$ne": True}
        
        # Sort by product_name first (groups series together), then by last_synced
        if supplier == "Canopy":
            sort_order = [("material_order", 1), ("type_order", 1), ("sort_order", 1), ("name", 1)]
        else:
            # Sort by product_name to group series together, then by size pattern for natural ordering
            sort_order = [("product_name", 1)]
        
        products_cursor = db.supplier_products.find(
            query
        ).skip(skip).limit(limit).sort(sort_order)
        
        # Build a set of all SKUs we're returning to batch-check against products collection
        products_list = list(products_cursor)
        skus_to_check = [p.get("sku") for p in products_list if p.get("sku")]
        
        # Batch check which SKUs exist in the products collection
        existing_in_products = set()
        if skus_to_check:
            existing_products = db.products.find({"sku": {"$in": skus_to_check}}, {"sku": 1})
            existing_in_products = {p["sku"] for p in existing_products}

        # Batch check which SKUs are LIVE on the website (tiles collection).
        # This is the source of truth for the admin "published" state — the
        # legacy publish paths never set supplier_products.published, so the
        # stored flag drifts. A product is published iff its tile doc exists.
        codes_to_check = list({c for p in products_list for c in (p.get("sku"), p.get("supplier_code")) if c})
        live_tiles = {}
        if codes_to_check:
            for t in db.tiles.find(
                {"$or": [{"sku": {"$in": codes_to_check}}, {"supplier_code": {"$in": codes_to_check}}]},
                {"sku": 1, "supplier_code": 1, "slug": 1, "series": 1},
            ):
                for c in (t.get("sku"), t.get("supplier_code")):
                    if c:
                        live_tiles[c] = t
        
        products = []
        products_to_update = []  # Batch updates for in_products_db flag
        
        for p in products_list:
            sku = p.get("sku")
            stored_in_products_db = p.get("in_products_db", False)
            actual_in_products_db = sku in existing_in_products if sku else False
            
            # If there's a mismatch, queue the update
            if actual_in_products_db != stored_in_products_db:
                products_to_update.append({
                    "_id": p["_id"],
                    "in_products_db": actual_in_products_db
                })
            
            # Apply category extraction to fix bad category data on-the-fly
            from routes.sync_staging import extract_proper_category
            corrected_category = extract_proper_category({
                "category": p.get("category"),
                "finish": p.get("finish"),
                "name": p.get("name")
            })
            
            product = {
                "_id": str(p.get("_id")),  # Include MongoDB _id for image operations
                "name": p.get("name"),
                "product_name": p.get("product_name"),  # Unique generated name
                "unique_name": p.get("unique_name"),  # Series/range name
                "range_name": p.get("range_name"),  # Admin-set series (Auto-Assign / Bulk Set Series)
                "series": p.get("series"),  # Flooring series
                "series_name": p.get("series_name"),  # Legacy alias — kept for frontend grouping fallback
                "original_series": p.get("original_series"),  # Original Canopy series name before transformation
                "sku": sku,
                "supplier_code": p.get("supplier_code"),  # Spreadsheet supplier code (e.g., P14461)
                "original_supplier_code": p.get("original_supplier_code"),  # Website/URL code (e.g., G30149)
                "url": p.get("url"),
                "image": p.get("images", [None])[0] if p.get("images") else p.get("image"),
                "images": p.get("images", []),  # Full images array for image management
                "supplier_product_name": p.get("supplier_product_name") or p.get("original_series") or None,  # Supplier product name - never fall back to name field
                "our_product_name": p.get("our_product_name"),  # Our renamed product name
                "display_name": p.get("display_name"),  # Admin-set display name
                "stock_status": p.get("stock_status"),  # Stock status field
                "price": p.get("price") or p.get("trade_price"),  # List price (calculated)
                "cost_price": p.get("cost_price"),  # Cost from supplier (per m²)
                "cost_each": p.get("cost_each"),  # Cost per each (for accessories)
                "cost_m2": p.get("cost_m2"),  # Cost per m²
                "size_unit": p.get("size_unit", "m2"),  # m2 or each
                "trade_price": p.get("trade_price"),  # Original trade price
                "retail_price": p.get("retail_price"),  # Retail price
                "pallet_price": p.get("pallet_price"),
                "stock_quantity": p.get("stock_quantity") or p.get("stock_chingford", 0) + p.get("stock_tonbridge", 0),
                "stock_m2": p.get("stock_m2") or p.get("stock_sqm"),
                "in_stock": p.get("in_stock"),
                "always_in_stock": p.get("always_in_stock", False),  # Always show as In Stock on website
                "visibility": p.get("visibility", "online"),  # online, in_store_only, hidden
                "in_products_db": actual_in_products_db,  # Use verified status from products collection
                # Live-truth published state — tile doc existence, not the stored flag
                "published": (sku or p.get("supplier_code")) in live_tiles,
                "live_on_website": (sku or p.get("supplier_code")) in live_tiles,
                "live_slug": (live_tiles.get(sku or p.get("supplier_code")) or {}).get("slug"),
                "live_series": (live_tiles.get(sku or p.get("supplier_code")) or {}).get("series"),
                "category": corrected_category,  # Use corrected category
                "material": p.get("material"),
                "specifications": p.get("specifications"),  # Flooring specifications
                "finish": p.get("finish"),
                "color": p.get("color"),
                "size": p.get("size"),
                "thickness": p.get("thickness"),  # Flooring thickness
                "coverage_m2": p.get("coverage_m2"),  # Pack coverage in m²
                "description": p.get("description"),
                "length_mm": p.get("length_mm"),
                "width_mm": p.get("width_mm"),
                "supplier": p.get("supplier"),
                "synced_at": p.get("last_synced").isoformat() if p.get("last_synced") and hasattr(p.get("last_synced"), 'isoformat') else p.get("last_synced"),
                "created_at": p.get("created_at").isoformat() if p.get("created_at") and hasattr(p.get("created_at"), 'isoformat') else p.get("created_at"),
                "updated_at": p.get("updated_at").isoformat() if p.get("updated_at") and hasattr(p.get("updated_at"), 'isoformat') else p.get("updated_at"),
                "dimension_fix_applied": p.get("dimension_fix_applied", False),
                "dimension_fix_date": p.get("dimension_fix_date").isoformat() if p.get("dimension_fix_date") and hasattr(p.get("dimension_fix_date"), 'isoformat') else p.get("dimension_fix_date"),
                "recently_updated": p.get("recently_updated", False),
                "website_categories": p.get("website_categories"),  # Website categories for e-commerce
                "show_on_website": p.get("show_on_website", False),  # Show on e-commerce website
                "products_db_id": p.get("products_db_id"),  # ID in main products DB if synced
                "product_type": p.get("product_type"),  # Flooring type (Herringbone, Straight Plank, etc.)
                "sort_order": p.get("sort_order"),  # Overall sort order
                "material_order": p.get("material_order"),  # Material sort order
                "type_order": p.get("type_order"),  # Type sort order
                # Tier pricing fields
                "has_custom_tier_pricing": p.get("has_custom_tier_pricing", False),
                "tier_discounts": p.get("tier_discounts"),
                "tier_thresholds": p.get("tier_thresholds"),
                "tier_pricing_disabled": p.get("tier_pricing_disabled", False),
                "trade_discount": p.get("trade_discount"),
                "trade_discount_type": p.get("trade_discount_type") or "percent",
                "credit_back_rate": p.get("credit_back_rate"),
                # Half + Full pallet pricing (surfaced for bulk editor pre-population)
                "pallet_enabled": p.get("pallet_enabled", False),
                "pallet_price": p.get("pallet_price"),
                "half_pallet_price": p.get("half_pallet_price"),
                "m2_per_pallet": p.get("m2_per_pallet"),
                "m2_per_half_pallet": p.get("m2_per_half_pallet"),
                # List price override
                "list_price": p.get("list_price"),
                # Tiles per box fields
                "tiles_per_box": p.get("tiles_per_box"),
                "sqm_per_box": p.get("sqm_per_box"),
                # Category fields for bulk editor pre-population
                "type": p.get("type"),
                "edge": p.get("edge"),
                "slip_rating": p.get("slip_rating"),
                "suitability": p.get("suitability"),
                "underfloor_heating": p.get("underfloor_heating"),
                "main_category": p.get("main_category"),
                "sub_categories": p.get("sub_categories", []),
                "rooms": p.get("rooms", []),
                "materials": p.get("materials", []),
                "styles": p.get("styles", []),
                "colors": p.get("colors", []),
                "features": p.get("features", []),
                "made_in": p.get("made_in"),
                "hidden_seo_keywords": p.get("hidden_seo_keywords"),
                # Sale & Labels
                "labels": p.get("labels", []),
                "custom_labels": p.get("custom_labels", []),
                "sale_active": p.get("sale_active", False),
                "was_price": p.get("was_price"),
                "discount_percentage": p.get("discount_percentage"),
                "sale_savings": p.get("sale_savings"),
                # Pricing unit + product group (drives labels in the Tier Pricing modal)
                "pricing_unit": p.get("pricing_unit"),
                "product_group": p.get("product_group"),
            }

            # Pass-through of any additional category-specific spec fields the
            # Manager config surfaces (Bag Colour, Coverage m²/bag, VOC Rating,
            # Setting Time, Pack Size, Bag Weight, Pot Life, Application
            # Thickness, Made In, etc.). Anything not already in the projection
            # above OR in the internal-only denylist gets echoed back so the
            # Quick Edit "More Specs" panel can round-trip its values.
            _INTERNAL_KEYS = {
                "_id", "password_hash", "raw", "raw_row", "canopy_raw",
                "images_meta", "sync_history", "audit", "index_meta",
            }
            for _k, _v in p.items():
                if _k in product or _k in _INTERNAL_KEYS:
                    continue
                if _k.startswith("_"):
                    continue
                # Skip datetime objects (fragile to serialize); the ones we care
                # about (created_at/updated_at/last_synced) are already handled.
                try:
                    from datetime import datetime as _dt
                    if isinstance(_v, _dt):
                        continue
                except Exception:
                    pass
                product[_k] = _v

            products.append(product)
        
        # Batch update any mismatched in_products_db flags
        if products_to_update:
            for update in products_to_update:
                db.supplier_products.update_one(
                    {"_id": update["_id"]},
                    {"$set": {"in_products_db": update["in_products_db"]}}
                )
            logger.info(f"Updated in_products_db flag for {len(products_to_update)} products")
        
        total = db.supplier_products.count_documents(query)
        
        # Count new products (not yet in Products database)
        new_query = {"in_products_db": {"$ne": True}}
        if supplier:
            new_query["supplier"] = supplier
        new_count = db.supplier_products.count_documents(new_query)
        
        # Count products with prices (price > 0)
        price_query = {**query, "price": {"$gt": 0}}
        with_prices_count = db.supplier_products.count_documents(price_query)
        
        # Count in stock products
        in_stock_query = {**query, "in_stock": True}
        in_stock_count = db.supplier_products.count_documents(in_stock_query)
        
        # Count out of stock products
        out_of_stock_query = {**query, "in_stock": False}
        out_of_stock_count = db.supplier_products.count_documents(out_of_stock_query)
        
        return {
            "products": products,
            "total": total,
            "new_products_count": new_count,
            "with_prices_count": with_prices_count,
            "in_stock_count": in_stock_count,
            "out_of_stock_count": out_of_stock_count,
            "skip": skip,
            "limit": limit
        }
        
    except Exception as e:
        logger.error(f"Error getting supplier products: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/stats")
def get_supplier_stats():
    """
    Get product counts for each supplier
    """
    try:
        db = get_db()
        
        # Aggregate counts by supplier
        pipeline = [
            {"$group": {"_id": "$supplier", "count": {"$sum": 1}}}
        ]
        
        results = list(db.supplier_products.aggregate(pipeline))
        
        stats = {}
        for r in results:
            if r["_id"]:
                stats[r["_id"]] = r["count"]
        
        # Include total count of ALL supplier products (including those without supplier field)
        stats["_total"] = db.supplier_products.count_documents({})
        
        return stats
        
    except Exception as e:
        logger.error(f"Error getting supplier stats: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/series-options")
def get_series_options(supplier: Optional[str] = None):
    """
    Get all unique series names with product counts for a supplier.
    Returns ALL series, not just from the current page.
    """
    try:
        db = get_db()
        
        # Build match stage
        match_stage = {}
        if supplier:
            match_stage["supplier"] = supplier
        
        # Aggregate to get series counts
        # Try to extract series from product_name or series field
        pipeline = [
            {"$match": match_stage} if match_stage else {"$match": {}},
            {"$project": {
                "series": {
                    "$ifNull": [
                        "$series",
                        {"$arrayElemAt": [{"$split": ["$product_name", " "]}, 0]}  # First word as fallback
                    ]
                },
                "product_name": 1
            }},
            {"$group": {
                "_id": "$series",
                "count": {"$sum": 1}
            }},
            {"$match": {"_id": {"$ne": None, "$ne": ""}}},
            {"$sort": {"count": -1}},
            {"$project": {
                "_id": 0,
                "name": "$_id",
                "count": 1
            }}
        ]
        
        results = list(db.supplier_products.aggregate(pipeline))
        
        return {
            "success": True,
            "supplier": supplier or "all",
            "series": results,
            "total_series": len(results)
        }
        
    except Exception as e:
        logger.error(f"Error getting series options: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/products/refresh-in-products-db-status")
def refresh_in_products_db_status(supplier: Optional[str] = None):
    """
    Refresh the in_products_db flag for all supplier products by checking 
    if they exist in the main products collection.
    
    This fixes any data inconsistencies where products were added to the main
    database but the flag wasn't updated in supplier_products.
    """
    try:
        db = get_db()
        
        # Build query
        query = {}
        supplier = normalise_filter_value(supplier)
        if supplier:
            query["supplier"] = supplier
        
        # Get all supplier products
        supplier_products_list = list(db.supplier_products.find(query, {"_id": 1, "sku": 1, "in_products_db": 1}))
        
        # Get all SKUs
        skus = [p.get("sku") for p in supplier_products_list if p.get("sku")]
        
        # Check which SKUs exist in products collection
        existing_in_products = set()
        if skus:
            existing_products = db.products.find({"sku": {"$in": skus}}, {"sku": 1})
            existing_in_products = {p["sku"] for p in existing_products}
        
        # Update supplier_products with correct status
        updated_to_true = 0
        updated_to_false = 0
        already_correct = 0
        
        for sp in supplier_products_list:
            sku = sp.get("sku")
            current_status = sp.get("in_products_db", False)
            actual_status = sku in existing_in_products if sku else False
            
            if current_status != actual_status:
                db.supplier_products.update_one(
                    {"_id": sp["_id"]},
                    {"$set": {"in_products_db": actual_status}}
                )
                if actual_status:
                    updated_to_true += 1
                else:
                    updated_to_false += 1
            else:
                already_correct += 1
        
        logger.info(f"Refreshed in_products_db status: {updated_to_true} marked as in DB, {updated_to_false} marked as not in DB, {already_correct} already correct")
        
        return {
            "success": True,
            "supplier": supplier or "all",
            "total_checked": len(supplier_products_list),
            "updated_to_true": updated_to_true,  # Now correctly shows green tick
            "updated_to_false": updated_to_false,  # Now correctly shows + sign
            "already_correct": already_correct,
            "products_in_main_db": len(existing_in_products)
        }
        
    except Exception as e:
        logger.error(f"Error refreshing in_products_db status: {e}")
        raise HTTPException(status_code=500, detail=str(e))



@router.post("/products")
def upsert_supplier_product(data: dict):
    """
    Add or update a supplier product
    """
    try:
        db = get_db()
        
        products = data.get("products", [])
        supplier = data.get("supplier", "Verona")
        supplier = normalise_filter_value(supplier) or "Verona"
        
        synced = 0
        new = 0
        updated = 0
        
        for product in products:
            product_data = {
                "supplier": supplier,
                "sku": product.get("sku"),
                "name": product.get("name"),
                "category": product.get("category"),
                "description": product.get("description"),
                "material": product.get("material"),
                "finish": product.get("finish"),
                "length_mm": product.get("length_mm"),
                "width_mm": product.get("width_mm"),
                "trade_price": product.get("price"),
                "stock_quantity": product.get("stock_quantity"),
                "in_stock": product.get("in_stock"),
                "synced_at": datetime.now(timezone.utc),
                "sync_source": "manual"
            }
            
            result = db.supplier_products.update_one(
                {"supplier": supplier, "sku": product.get("sku")},
                {
                    "$set": product_data,
                    "$setOnInsert": {"created_at": datetime.now(timezone.utc)}
                },
                upsert=True
            )
            
            if result.upserted_id:
                new += 1
            elif result.modified_count > 0:
                updated += 1
            synced += 1
        
        return {
            "success": True,
            "synced": synced,
            "new": new,
            "updated": updated
        }
        
    except Exception as e:
        logger.error(f"Error upserting product: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============ ADD PRODUCT WIZARD ENDPOINTS ============

# Allowed writable fields for the Wizard. Everything else in the incoming
# dict is silently dropped so a malicious/misconfigured client can't overwrite
# server-managed fields (created_at, _id, sync_source etc.).
WIZARD_ALLOWED_FIELDS = {
    # Universal
    "supplier", "sku", "supplier_code", "product_name", "our_product_name",
    "name", "display_name", "description", "price", "list_price", "retail_price",
    "cost_price", "cost_each", "cost_m2", "trade_price",
    "stock_quantity", "in_stock", "always_in_stock",
    "images", "image",
    # Category
    "product_group", "main_category", "sub_categories",
    # Pricing unit
    "pricing_unit", "size_unit",
    # Tile-specific
    "size", "thickness", "length_mm", "width_mm", "coverage_m2",
    "material", "finish", "type", "edge", "slip_rating", "underfloor_heating",
    "made_in", "tiles_per_box", "sqm_per_box",
    # Materials-specific
    "bag_weight_kg", "coverage_m2_per_bag", "setting_time_hours",
    "pot_life_minutes", "application_thickness_mm", "voc_rating", "bag_colour",
    # Flooring-specific
    "plank_length_mm", "plank_width_mm", "plank_thickness_mm", "wear_layer_mm",
    "click_system", "waterproof", "underlay_compatible",
    # Bathroom-specific
    "brand", "model", "dimensions", "flush_type", "tank_capacity", "warranty",
    # UFH-specific
    "kit_size_m2", "voltage", "thermostat_included",
    # Colours / attributes
    "color", "colors", "styles", "features", "rooms", "materials",
    "suitability", "series", "series_name",
    # Visibility
    "visibility", "show_on_website", "published",
}


# ============ PRODUCT-GROUP CLASSIFICATION ============
# Ordered list of (regex, group) — first match wins. Kept simple and inspectable
# so the classifier is easy to reason about and to extend.
_CLASSIFY_RULES = [
    # Main category exact matches — highest confidence
    ("__MAIN__", {
        "materials": "materials", "material": "materials",
        "tiles": "tiles", "tile": "tiles",
        "flooring": "flooring", "floor": "flooring", "floors": "flooring",
        "bathroom": "bathroom", "bathrooms": "bathroom",
        "underfloor heating": "underfloor_heating", "underfloor": "underfloor_heating", "ufh": "underfloor_heating",
        "tools": "tools", "tools & accessories": "tools", "accessories": "tools",
    }),
    # Sub-category keywords → group
    ("__SUB__", [
        (r"adhesive|primer|grout|sealant|silicone|cleaning|cleaner|levelling compound|self-levelling", "materials"),
        (r"lvt|laminate|engineered wood|solid wood|vinyl|floor plank|spc|floor board", "flooring"),
        (r"toilet|basin|bath|shower|tap|mixer|cistern|urinal|bidet|wc|vanity unit|towel rail", "bathroom"),
        (r"underfloor heat|thermostat|heating mat|heating cable|ufh", "underfloor_heating"),
        (r"trowel|spacer|cutter|drill bit|leveller kit|leveller|tile saw|notched|tile clip", "tools"),
        (r"tile|mosaic|border|feature strip", "tiles"),
    ]),
]

def _classify_product_group(sp: dict) -> str | None:
    """Return best-guess product_group, or None when the data doesn't say.
    Order of trust: existing product_group > main_category > sub_categories > product name."""
    # Already classified — never override without explicit intent
    if sp.get("product_group"):
        return sp["product_group"]
    
    # Main category
    mc = str(sp.get("main_category") or "").strip().lower()
    if mc:
        mapping = _CLASSIFY_RULES[0][1]
        if mc in mapping:
            return mapping[mc]
    
    # Sub-categories
    subs = sp.get("sub_categories") or []
    if isinstance(subs, list) and subs:
        blob = " | ".join(str(s).lower() for s in subs)
        for pattern, group in _CLASSIFY_RULES[1][1]:
            if re.search(pattern, blob, re.IGNORECASE):
                return group
    
    # Product name (weaker signal)
    name = " ".join(str(sp.get(k) or "") for k in ("product_name", "our_product_name", "name", "display_name")).lower()
    if name:
        for pattern, group in _CLASSIFY_RULES[1][1]:
            if re.search(pattern, name, re.IGNORECASE):
                return group
    
    return None


@router.post("/products/backfill-product-group")
def backfill_product_group(data: dict):
    """
    Classify products into `product_group` (tiles / materials / flooring / bathroom /
    underfloor_heating / tools) based on main_category, sub_categories and name.
    
    Body:
      {
        "dry_run": true      # if true, return preview without writing
      }
    
    Returns per-group counts, an "unclassified" count, and a small preview list.
    """
    try:
        db = get_db()
        dry_run = bool(data.get("dry_run", True))
        
        cur = db.supplier_products.find(
            {},
            {"_id": 0, "sku": 1, "supplier": 1, "product_name": 1, "our_product_name": 1,
             "name": 1, "display_name": 1, "main_category": 1, "sub_categories": 1,
             "product_group": 1}
        )
        
        counts = {"tiles": 0, "materials": 0, "flooring": 0, "bathroom": 0,
                  "underfloor_heating": 0, "tools": 0, "unclassified": 0, "already_set": 0}
        classified_bulk = []   # (sku, supplier, group)
        preview_samples = {"tiles": [], "materials": [], "flooring": [], "bathroom": [], "underfloor_heating": [], "tools": [], "unclassified": []}
        
        for sp in cur:
            existing = sp.get("product_group")
            if existing:
                counts["already_set"] += 1
                continue
            group = _classify_product_group(sp)
            if group:
                counts[group] += 1
                classified_bulk.append((sp.get("sku"), sp.get("supplier"), group))
                if len(preview_samples.get(group, [])) < 5:
                    preview_samples[group].append({
                        "sku": sp.get("sku"),
                        "supplier": sp.get("supplier"),
                        "name": sp.get("product_name") or sp.get("our_product_name") or sp.get("name") or ""
                    })
            else:
                counts["unclassified"] += 1
                if len(preview_samples["unclassified"]) < 5:
                    preview_samples["unclassified"].append({
                        "sku": sp.get("sku"),
                        "supplier": sp.get("supplier"),
                        "name": sp.get("product_name") or sp.get("our_product_name") or sp.get("name") or ""
                    })
        
        applied = 0
        if not dry_run and classified_bulk:
            # Apply in bulk — one update_many per group with $in on SKUs to minimise round-trips
            grouped = {}
            for sku, supplier, grp in classified_bulk:
                grouped.setdefault(grp, []).append(sku)
            for grp, skus in grouped.items():
                if not skus:
                    continue
                res = db.supplier_products.update_many(
                    {"sku": {"$in": skus}, "product_group": {"$in": [None, ""]}},
                    {"$set": {"product_group": grp, "updated_at": datetime.now(timezone.utc)}}
                )
                # Also propagate to tiles collection
                db.tiles.update_many(
                    {"sku": {"$in": skus}},
                    {"$set": {"product_group": grp}}
                )
                applied += res.modified_count
        
        return {
            "success": True,
            "dry_run": dry_run,
            "counts": counts,
            "applied": applied,
            "preview": preview_samples,
            "message": (
                f"[Dry-run] Would classify {sum(counts[k] for k in counts if k not in ('unclassified','already_set'))} products, "
                f"leaving {counts['unclassified']} unclassified."
                if dry_run else
                f"Classified and updated {applied} products. {counts['unclassified']} left unclassified for manual review."
            )
        }
    except Exception as e:
        logger.error(f"Backfill product_group error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


class BulkAssignCategoryRequest(BaseModel):
    product_ids: List[str]
    id_field: Optional[str] = "sku"
    product_group: str  # 'tiles' | 'materials' | 'flooring' | 'bathroom' | 'underfloor_heating' | 'tools'


@router.post("/products/bulk-assign-category")
def bulk_assign_category(data: BulkAssignCategoryRequest):
    """Explicitly set `product_group` on a list of products (overrides prior value).
    
    Used by the "Assign Category" bulk action in the legacy Bulk Editor when the
    admin knows better than the classifier. Also writes to `main_category` when
    it's currently blank so the Manager filters can rely on either field.
    """
    valid_groups = {"tiles", "materials", "flooring", "bathroom", "underfloor_heating", "tools"}
    if data.product_group not in valid_groups:
        raise HTTPException(status_code=400, detail=f"product_group must be one of {sorted(valid_groups)}")
    
    try:
        db = get_db()
        id_field = data.id_field or "sku"
        # Default main_category text matches what the Managers filter on
        main_cat_map = {
            "tiles": "Tiles", "materials": "Materials", "flooring": "Flooring",
            "bathroom": "Bathroom", "underfloor_heating": "Underfloor Heating", "tools": "Tools"
        }
        main_category = main_cat_map[data.product_group]
        
        # Auto-set pricing_unit for materials (bag pricing) — others default to m2 elsewhere
        set_fields = {
            "product_group": data.product_group,
            "updated_at": datetime.now(timezone.utc),
        }
        
        # First pass: set product_group + backfill main_category only when blank
        sp_result = db.supplier_products.update_many(
            {id_field: {"$in": data.product_ids}},
            {"$set": set_fields}
        )
        # Backfill blank main_category only
        db.supplier_products.update_many(
            {id_field: {"$in": data.product_ids}, "$or": [{"main_category": {"$in": [None, ""]}}, {"main_category": {"$exists": False}}]},
            {"$set": {"main_category": main_category}}
        )
        # Propagate to tiles collection
        db.tiles.update_many(
            {id_field: {"$in": data.product_ids}},
            {"$set": {"product_group": data.product_group}}
        )
        db.tiles.update_many(
            {id_field: {"$in": data.product_ids}, "$or": [{"main_category": {"$in": [None, ""]}}, {"main_category": {"$exists": False}}]},
            {"$set": {"main_category": main_category}}
        )
        
        # For materials, also set pricing_unit=unit where it's not already set
        if data.product_group == "materials":
            db.supplier_products.update_many(
                {id_field: {"$in": data.product_ids}, "$or": [{"pricing_unit": {"$in": [None, ""]}}, {"pricing_unit": {"$exists": False}}]},
                {"$set": {"pricing_unit": "unit"}}
            )
        
        return {
            "success": True,
            "modified_count": sp_result.modified_count,
            "product_group": data.product_group,
            "message": f"Assigned {sp_result.modified_count} products to {main_category}"
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Bulk assign category error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/products/create")
def create_product_via_wizard(data: dict):
    """
    Create a new product from the Add Product Wizard.
    
    Accepts any subset of WIZARD_ALLOWED_FIELDS. Enforces:
      - `supplier` and `sku` are required
      - No existing record with the same (supplier, sku) — otherwise 409
      - Server-managed timestamps set on insert
      - Returns the created record's identity so the Manager can jump straight
        to edit mode or refresh the list to include the new row.
    """
    try:
        db = get_db()
        
        supplier = (data.get("supplier") or "").strip()
        sku = (data.get("sku") or data.get("supplier_code") or "").strip()
        if not supplier or not sku:
            raise HTTPException(status_code=400, detail="supplier and sku are required")
        
        # Prevent duplicates — bulk-update-unified is the update path,
        # this endpoint is strictly for new records.
        existing = db.supplier_products.find_one({"supplier": supplier, "sku": sku}, {"_id": 1})
        if existing:
            raise HTTPException(status_code=409, detail=f"A product with SKU '{sku}' already exists for supplier '{supplier}'. Use the edit flow instead.")
        
        # Filter to allowed fields only
        product_data = {}
        for k, v in data.items():
            if k in WIZARD_ALLOWED_FIELDS and v is not None and v != "":
                product_data[k] = v
        
        # Normalise supplier + ensure sku is set on the doc even if data used supplier_code
        product_data["supplier"] = normalise_filter_value(supplier) or supplier
        product_data["sku"] = sku
        
        # Server-managed timestamps
        now = datetime.now(timezone.utc)
        product_data["created_at"] = now
        product_data["updated_at"] = now
        product_data["sync_source"] = "wizard"
        
        # Sane defaults based on product_group so the storefront renders correctly
        # even if the admin skipped a field in the wizard.
        grp = str(product_data.get("product_group") or product_data.get("main_category") or "").lower()
        if "material" in grp and not product_data.get("pricing_unit"):
            product_data["pricing_unit"] = "unit"
        elif not product_data.get("pricing_unit"):
            product_data["pricing_unit"] = "m2"
        
        # Default visibility: draft (not on storefront until admin publishes)
        product_data.setdefault("visibility", "draft")
        product_data.setdefault("published", False)
        product_data.setdefault("show_on_website", False)
        product_data.setdefault("in_stock", True)
        
        # Insert
        result = db.supplier_products.insert_one(product_data)
        
        return {
            "success": True,
            "id": str(result.inserted_id),
            "supplier": product_data["supplier"],
            "sku": product_data["sku"],
            "product_name": product_data.get("product_name") or product_data.get("name"),
            "created_at": now.isoformat(),
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating product via wizard: {e}")
        raise HTTPException(status_code=500, detail=str(e))



@router.post("/products/fix-categories")
def fix_supplier_product_categories(supplier: Optional[str] = None):
    """
    Fix incorrect category values in supplier_products collection.
    
    This runs the extract_proper_category function on all products and updates
    any that have incorrect category values (like product line names instead of
    actual categories like "Matt", "Wall Tiles", etc.)
    """
    try:
        from routes.sync_staging import extract_proper_category
        
        db = get_db()
        
        # Build query
        query = {}
        supplier = normalise_filter_value(supplier)
        if supplier:
            query["supplier"] = supplier
        
        # Get all supplier products
        products = list(db.supplier_products.find(query))
        
        fixed_count = 0
        already_correct = 0
        
        for product in products:
            current_category = product.get("category", "")
            
            # Calculate correct category
            correct_category = extract_proper_category({
                "category": current_category,
                "finish": product.get("finish", ""),
                "name": product.get("name", "")
            })
            
            # Update if different
            if current_category != correct_category:
                db.supplier_products.update_one(
                    {"_id": product["_id"]},
                    {"$set": {"category": correct_category}}
                )
                fixed_count += 1
                logger.info(f"Fixed category for {product.get('name', 'Unknown')}: '{current_category}' -> '{correct_category}'")
            else:
                already_correct += 1
        
        return {
            "success": True,
            "supplier": supplier or "all",
            "total_products": len(products),
            "fixed": fixed_count,
            "already_correct": already_correct
        }
        
    except Exception as e:
        logger.error(f"Error fixing categories: {e}")
        raise HTTPException(status_code=500, detail=str(e))



@router.post("/products/fix-product-names")
def fix_supplier_product_names(supplier: Optional[str] = None):
    """
    Fix missing product_name (transformed/display name) for existing products.
    
    This applies the get_display_name function to all products and saves
    the transformed name to the product_name field.
    
    IMPORTANT: Respects custom mappings - products with custom mappings
    will use their custom name instead of auto-generating.
    """
    try:
        from business_config.business_rules import get_display_name
        
        db = get_db()
        
        # Build query - only products without product_name or with product_name same as name
        query = {
            "$or": [
                {"product_name": {"$exists": False}},
                {"product_name": None},
                {"product_name": ""},
                {"$expr": {"$eq": ["$product_name", "$name"]}}  # product_name same as name
            ]
        }
        supplier = normalise_filter_value(supplier)
        if supplier:
            query["supplier"] = supplier
        
        # Get products that need fixing
        products = list(db.supplier_products.find(query))
        
        fixed_count = 0
        skipped_excluded = 0
        
        # Excluded suppliers (keep original names)
        EXCLUDED_SUPPLIERS = ["Tile Rite", "Ultra Tile", "Trimline", "Regulus"]
        
        for product in products:
            product_supplier = product.get("supplier", "")
            raw_name = product.get("name", "")
            product_finish = product.get("finish", "")
            
            # Skip excluded suppliers
            if product_supplier in EXCLUDED_SUPPLIERS:
                skipped_excluded += 1
                continue
            
            if not raw_name:
                continue
            
            # Check for custom mapping first - CUSTOM MAPPINGS support
            product_sku = product.get("sku", "")
            if CUSTOM_MAPPINGS_AVAILABLE and get_custom_mapping and product_sku:
                custom_mapping = get_custom_mapping(db, product_supplier, product_sku)
                if custom_mapping:
                    # Use custom mapping instead of auto-generating
                    transformed_name = custom_mapping["custom_name"]
                else:
                    # Generate transformed name - pass finish from product data
                    transformed_name = get_display_name(raw_name, product_supplier, product_finish)
            else:
                # Generate transformed name - pass finish from product data
                transformed_name = get_display_name(raw_name, product_supplier, product_finish)
            
            # Update if different from raw name
            if transformed_name and transformed_name != raw_name:
                db.supplier_products.update_one(
                    {"_id": product["_id"]},
                    {"$set": {"product_name": transformed_name}}
                )
                fixed_count += 1
                logger.info(f"Fixed name for {product_supplier}/{raw_name[:30]}: '{transformed_name}'")
            else:
                # Even if no transformation, store the name as product_name
                db.supplier_products.update_one(
                    {"_id": product["_id"]},
                    {"$set": {"product_name": raw_name}}
                )
                fixed_count += 1
        
        return {
            "success": True,
            "supplier": supplier or "all",
            "total_checked": len(products),
            "fixed": fixed_count,
            "skipped_excluded_suppliers": skipped_excluded,
            "excluded_suppliers": EXCLUDED_SUPPLIERS
        }
        
    except Exception as e:
        logger.error(f"Error fixing product names: {e}")
        raise HTTPException(status_code=500, detail=str(e))


class CopyProductRequest(BaseModel):
    sku: str
    supplier: str


@router.post("/products/copy")
def copy_product(request: CopyProductRequest):
    """
    Create a copy of a product for a new variant/series.
    
    The copied product will be:
    - Set to 'draft' status (not visible online or in EPOS)
    - Requires Super Admin approval to publish
    - Gets a new unique SKU
    - All specifications can be edited after copying
    """
    try:
        db = get_db()
        
        # Find the source product
        source_product = db.supplier_products.find_one({
            "sku": request.sku,
            "supplier": request.supplier
        })
        
        if not source_product:
            raise HTTPException(status_code=404, detail=f"Product not found: {request.sku}")
        
        # Generate new SKU
        base_sku = request.sku
        copy_number = 1
        new_sku = f"{base_sku}-COPY{copy_number}"
        
        # Find unique SKU
        while db.supplier_products.find_one({"sku": new_sku, "supplier": request.supplier}):
            copy_number += 1
            new_sku = f"{base_sku}-COPY{copy_number}"
        
        # Create copy of the product
        new_product = {k: v for k, v in source_product.items() if k != '_id'}
        new_product.update({
            "sku": new_sku,
            "supplier_code": new_sku,  # Copy gets its own supplier_code matching the new SKU
            "name": f"{source_product.get('name', '')} (Copy)",
            "product_name": f"{source_product.get('product_name', source_product.get('name', ''))} (Copy)",
            "sort_order": (source_product.get("sort_order", 0) or 0) + 0.5,  # Sort right after the source
            "visibility": "draft",  # Not visible online
            "status": "pending_approval",  # Needs Super Admin approval
            "epos_visible": False,  # Not visible in EPOS
            "show_on_website": False,  # Not visible on website
            "in_products_db": False,  # Not in main products database yet
            "products_db_id": None,
            "copied_from": request.sku,
            "copied_at": datetime.now(timezone.utc),
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc)
        })
        
        # Insert the new product
        result = db.supplier_products.insert_one(new_product)
        new_product_id = str(result.inserted_id)
        
        # Also create in main products table as draft
        import uuid
        new_product_uuid = str(uuid.uuid4())
        
        products_entry = {
            "id": new_product_uuid,  # Add UUID for proper lookup
            "sku": new_sku,
            "supplier": request.supplier,
            "name": new_product.get("name"),
            "product_name": new_product.get("product_name"),
            "display_name": new_product.get("product_name", new_product.get("name")),
            "price": source_product.get("price"),
            "cost_price": source_product.get("cost_price"),
            "images": source_product.get("images", []),
            "image": source_product.get("image"),
            "size": source_product.get("size"),
            "finish": source_product.get("finish"),
            "material": source_product.get("material"),
            "category": source_product.get("category"),
            "made_in": source_product.get("made_in"),
            "rooms": source_product.get("rooms", []),
            "styles": source_product.get("styles", []),
            "colors": source_product.get("colors", []),
            "features": source_product.get("features", []),
            "visibility": "draft",
            "status": "pending_approval",
            "show_on_website": False,
            "show_in_epos": False,
            "copied_from": request.sku,
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc)
        }
        
        products_result = db.products.insert_one(products_entry)
        products_id = new_product_uuid  # Use the UUID we created, not MongoDB's _id
        
        # Update supplier_products with products_db reference
        db.supplier_products.update_one(
            {"_id": result.inserted_id},
            {"$set": {
                "in_products_db": True,
                "products_db_id": products_id
            }}
        )
        
        logger.info(f"Product copied: {request.sku} -> {new_sku} (pending approval)")
        
        return {
            "success": True,
            "message": "Product copied successfully as draft",
            "new_sku": new_sku,
            "product_id": products_id,
            "supplier_product_id": new_product_id,
            "status": "pending_approval",
            "note": "Product is set to DRAFT and requires Super Admin approval to publish"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error copying product: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/products/approve")
def approve_product(sku: str, supplier: str):
    """
    Super Admin endpoint to approve a draft product and make it visible.
    """
    try:
        db = get_db()
        
        # Update supplier_products
        supplier_result = db.supplier_products.update_one(
            {"sku": sku, "supplier": supplier},
            {"$set": {
                "visibility": "online",
                "status": "approved",
                "show_on_website": True,
                "epos_visible": True,
                "approved_at": datetime.now(timezone.utc)
            }}
        )
        
        # Update products table
        products_result = db.products.update_one(
            {"sku": sku, "supplier": supplier},
            {"$set": {
                "visibility": "online",
                "status": "approved",
                "show_on_website": True,
                "show_in_epos": True,
                "approved_at": datetime.now(timezone.utc)
            }}
        )
        
        if supplier_result.modified_count == 0 and products_result.modified_count == 0:
            raise HTTPException(status_code=404, detail="Product not found")
        
        return {
            "success": True,
            "message": f"Product {sku} approved and now visible online"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error approving product: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/products/add-to-main-database")
def add_supplier_products_to_main_database(supplier: Optional[str] = None):
    """
    Add all supplier_products to the main products collection (EPOS database).
    This fixes existing products that show '+' instead of green tick.
    
    After running this, all products will show green tick on Supplier Products page.
    """
    try:
        db = get_db()
        
        # Query for products not in main database
        query = {"in_products_db": {"$ne": True}}
        supplier = normalise_filter_value(supplier)
        if supplier:
            query["supplier"] = supplier
        
        products = list(db.supplier_products.find(query))
        
        added_count = 0
        already_exists = 0
        errors = []
        
        for product in products:
            try:
                sku = product.get("sku")
                if not sku:
                    continue
                
                # Check if already in products collection
                existing = db.products.find_one({"sku": sku})
                if existing:
                    # Just update in_products_db flag
                    db.supplier_products.update_one(
                        {"_id": product["_id"]},
                        {"$set": {
                            "in_products_db": True,
                            "products_db_id": str(existing["_id"])
                        }}
                    )
                    already_exists += 1
                    continue
                
                # Add to main products collection
                main_product_data = {
                    "sku": sku,
                    "name": product.get("product_name") or product.get("name"),
                    "supplier": product.get("supplier"),
                    "supplier_name": product.get("name"),
                    "category_name": product.get("category"),
                    "description": product.get("description", ""),
                    "material": product.get("material"),
                    "finish": product.get("finish"),
                    "cost": product.get("cost_price"),
                    "price": product.get("price"),
                    "stock": product.get("stock_quantity", 0),
                    "m2_quantity": product.get("stock_m2", 0),
                    "images": product.get("images", []),
                    "in_stock": product.get("in_stock", True),
                    "created_at": datetime.now(timezone.utc),
                    "updated_at": datetime.now(timezone.utc),
                    "source": "supplier_products_bulk_add"
                }
                
                result = db.products.insert_one(main_product_data)
                
                # Update supplier_products
                db.supplier_products.update_one(
                    {"_id": product["_id"]},
                    {"$set": {
                        "in_products_db": True,
                        "products_db_id": str(result.inserted_id)
                    }}
                )
                added_count += 1
                
            except Exception as e:
                errors.append(f"{product.get('sku')}: {str(e)}")
        
        logger.info(f"Added {added_count} products to main database, {already_exists} already existed")
        
        return {
            "success": True,
            "supplier": supplier or "all",
            "total_checked": len(products),
            "added_to_main_db": added_count,
            "already_in_main_db": already_exists,
            "errors": errors[:20]
        }
        
    except Exception as e:
        logger.error(f"Error adding to main database: {e}")
        raise HTTPException(status_code=500, detail=str(e))





def build_product_query(supplier, sku):
    """Build a flexible MongoDB query that handles products with null sku.
    Falls back to supplier_code lookup when sku doesn't match a regular sku field."""
    if supplier and sku:
        return {"$or": [
            {"supplier": supplier, "sku": sku},
            {"supplier": supplier, "supplier_code": sku},
        ]}
    elif sku:
        return {"$or": [{"sku": sku}, {"supplier_code": sku}]}
    elif supplier:
        return {"supplier": supplier}
    return None


class QuickUpdateRequest(BaseModel):
    product_id: Optional[str] = None
    sku: Optional[str] = None  # Optional - products may have supplier_code instead
    supplier: Optional[str] = None  # Optional - some products have null supplier
    supplier_code: Optional[str] = None  # Alternative identifier when sku is missing
    name: Optional[str] = None
    # Display Name (customer-facing - shown on invoices and website)
    display_name: Optional[str] = None
    # Supplier Product Name (internal - for staff reference)
    supplier_product_name: Optional[str] = None
    # Supplier Product Code (editable SKU)
    supplier_product_code: Optional[str] = None
    new_sku: Optional[str] = None  # New SKU if changing the supplier code
    # Display Code (auto-generated from display_name)
    display_code: Optional[str] = None
    # Legacy fields (mapped to new structure)
    product_name: Optional[str] = None  # Alias for display_name
    original_series: Optional[str] = None
    price: Optional[float] = None
    cost_price: Optional[float] = None
    stock_quantity: Optional[float] = None
    stock_m2: Optional[float] = None
    category: Optional[str] = None
    finish: Optional[str] = None
    in_stock: Optional[bool] = None
    always_in_stock: Optional[bool] = None
    is_featured: Optional[bool] = None  # Featured on Homepage
    # Sale/Clearance Labels
    labels: Optional[List[str]] = None  # ["Sale", "Clearance", "New Arrival", "Limited Stock", "Best Seller"]
    custom_labels: Optional[List[str]] = None  # Custom labels defined by user
    was_price: Optional[float] = None  # Original display price for showing discount
    now_price: Optional[float] = None  # Sale/discounted price
    sale_price: Optional[float] = None  # Alias for now_price used by newer clients
    discount_percentage: Optional[float] = None  # Discount percentage
    sale_active: Optional[bool] = None  # Whether sale pricing is active
    # Long product description ("About This Product" on the customer landing page).
    description: Optional[str] = None
    # Admin-pinned related products for the landing page carousels.
    # Entries: {sku, kind: 'also_liked'|'you_may_need', series_name, display_name, image}
    related_products: Optional[List[dict]] = None
    # Images
    images: Optional[List[str]] = None  # Array of image URLs
    image: Optional[str] = None  # Primary image URL


# Pydantic models for Sale/Labels endpoints
class ProductLabelsRequest(BaseModel):
    sku: str
    supplier: str
    labels: List[str] = []  # Preset labels
    custom_labels: List[str] = []  # Custom labels


class ProductSalePricingRequest(BaseModel):
    sku: str
    supplier: str
    was_price: Optional[float] = None  # Display "was" price (inflated original)
    was_markup_percent: Optional[float] = None  # Markup % on top of list price to create WAS
    discount_percentage: Optional[float] = None  # Calculated: (WAS - NOW) / WAS
    sale_active: bool = True


class BulkLabelsRequest(BaseModel):
    product_ids: List[dict]  # [{"sku": "...", "supplier": "..."}]
    labels: List[str] = []  # Labels to add
    custom_labels: List[str] = []  # Custom labels to add
    action: str = "add"  # "add", "remove", or "replace"


class BulkSalePricingRequest(BaseModel):
    product_ids: List[dict]  # [{"sku": "...", "supplier": "..."}]
    discount_percentage: Optional[float] = None  # Apply this discount to all
    was_price_markup: Optional[float] = None  # Markup over cost_price for was_price
    sale_active: bool = True
    clear_sale: bool = False  # If true, removes all sale pricing


class DeleteNameHistoryRequest(BaseModel):
    sku: str
    supplier: str
    field: str  # 'name', 'our_product_name', or 'history'
    history_index: Optional[int] = None  # Index in name_history array if field is 'history'


@router.post("/products/delete-name-history")
async def delete_name_history(data: DeleteNameHistoryRequest, request: Request):
    """
    Delete a name history entry from a product (Super Admin only).
    Can delete:
    - 'name' field (clears to product_name)
    - 'our_product_name' field (clears to None)
    - 'history' entry at specific index
    """
    try:
        db = get_db()
        
        # Verify user is super admin
        auth_header = request.headers.get('Authorization', '')
        if not auth_header.startswith('Bearer '):
            raise HTTPException(status_code=401, detail="Not authenticated")
        
        token = auth_header.split(' ')[1]
        from jose import jwt
        secret_key = os.environ.get('JWT_SECRET', 'your-secret-key-change-in-production')
        payload = jwt.decode(token, secret_key, algorithms=['HS256'])
        user_role = payload.get('role', '')
        
        if user_role.lower() not in ['super_admin', 'superadmin']:
            raise HTTPException(status_code=403, detail="Only Super Admin can delete name history")
        
        # Find the product
        product = db.supplier_products.find_one({
            'sku': data.sku,
            'supplier': data.supplier
        })
        
        if not product:
            raise HTTPException(status_code=404, detail="Product not found")
        
        update_fields = {'updated_at': datetime.now(timezone.utc)}
        
        if data.field == 'name':
            # Clear the original name by setting it to product_name
            update_fields['name'] = product.get('product_name', '')
        elif data.field == 'our_product_name':
            # Clear our_product_name
            update_fields['our_product_name'] = None
        elif data.field == 'history' and data.history_index is not None:
            # Remove specific entry from name_history array
            name_history = product.get('name_history', [])
            if 0 <= data.history_index < len(name_history):
                name_history.pop(data.history_index)
                update_fields['name_history'] = name_history
        else:
            raise HTTPException(status_code=400, detail="Invalid field specified")
        
        # Update the product
        db.supplier_products.update_one(
            {'_id': product['_id']},
            {'$set': update_fields}
        )
        
        return {"success": True, "message": f"Name history entry '{data.field}' deleted"}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Delete name history error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/products/quick-update")
def quick_update_supplier_product(data: QuickUpdateRequest):
    """
    Quick update a supplier product - updates only the fields provided.
    Used by the Quick Edit popup modal in the Supplier Products page.
    Also syncs changes to the main products collection and tiles collection.
    
    FIELD MAPPING:
    - display_name: Customer-facing name (shown on invoices and website)
    - supplier_product_name: Internal reference (for staff only)
    - display_code: Auto-generated from display_name (format: TSAB66P)
    - product_name: Legacy alias for display_name (for backwards compatibility)
    
    CUSTOM MAPPINGS: When display_name is changed, automatically saves a custom
    mapping so the name persists across automated syncs.
    """
    from business_config.business_rules import generate_display_code
    
    try:
        db = get_db()
        
        logger.info(f"Quick update request: sku={data.sku}, supplier={data.supplier}, product_id={data.product_id}")
        
        current_product = None
        
        # Try finding by _id first (most reliable)
        if data.product_id:
            try:
                from bson import ObjectId
                current_product = db.supplier_products.find_one({"_id": ObjectId(data.product_id)})
                if current_product:
                    logger.info(f"Found product by _id: {data.product_id}")
                    data.supplier = current_product.get("supplier", data.supplier)
                    data.sku = current_product.get("sku", data.sku)
            except Exception as e:
                logger.warning(f"_id lookup failed: {e}")
        
        # Fallback: try supplier + sku
        if not current_product:
            current_product = db.supplier_products.find_one({
                "supplier": data.supplier,
                "sku": data.sku
            })
        
        # Fallback: try finding by SKU alone
        if not current_product:
            logger.info(f"Trying SKU-only lookup for {data.sku}")
            current_product = db.supplier_products.find_one({"sku": data.sku})
            if current_product:
                data.supplier = current_product.get("supplier", data.supplier)
        
        # Fallback: try finding by supplier_code
        if not current_product and data.sku:
            current_product = db.supplier_products.find_one({"supplier_code": data.sku})
            if current_product:
                data.sku = current_product.get("sku", data.sku)
                data.supplier = current_product.get("supplier", data.supplier)
        
        if not current_product:
            logger.error(f"Product not found: sku={data.sku}, supplier={data.supplier}, product_id={data.product_id}")
            raise HTTPException(status_code=404, detail=f"Product not found: {data.sku}")
        
        # Handle SKU change if new_sku is provided
        if data.new_sku and data.new_sku != data.sku:
            new_sku = data.new_sku.strip()
            # Check if new SKU already exists
            existing = db.supplier_products.find_one({"supplier": data.supplier, "sku": new_sku})
            if existing:
                raise HTTPException(status_code=400, detail=f"SKU '{new_sku}' already exists for supplier {data.supplier}")
            
            # Update the SKU in all collections
            old_sku = data.sku
            
            # Update supplier_products using _id if available
            if data.product_id:
                try:
                    db.supplier_products.update_one(
                        {"_id": ObjectId(data.product_id)},
                        {"$set": {"sku": new_sku, "last_updated": datetime.now(timezone.utc)}}
                    )
                except Exception:
                    db.supplier_products.update_one(
                        {"supplier": data.supplier, "sku": old_sku},
                        {"$set": {"sku": new_sku, "last_updated": datetime.now(timezone.utc)}}
                    )
            else:
                db.supplier_products.update_one(
                    {"supplier": data.supplier, "sku": old_sku},
                    {"$set": {"sku": new_sku, "last_updated": datetime.now(timezone.utc)}}
                )
            
            # Update products collection
            db.products.update_one(
                {"sku": old_sku},
                {"$set": {"sku": new_sku, "supplier_sku": new_sku, "updated_at": datetime.now(timezone.utc)}}
            )
            
            # Update tiles collection
            db.tiles.update_one(
                {"sku": old_sku},
                {"$set": {"sku": new_sku, "updated_at": datetime.now(timezone.utc)}}
            )
            
            logger.info(f"Changed SKU from {old_sku} to {new_sku} for supplier {data.supplier}")
            
            # Update the sku reference for the rest of the update
            data.sku = new_sku
        
        # Handle display_name (also accept product_name as alias for backwards compatibility)
        effective_display_name = data.display_name or data.product_name
        
        # Build update dict with only non-None values
        update_fields = {}
        
        if data.name is not None:
            update_fields["name"] = data.name
        
        # Handle display_name and auto-generate display_code
        if effective_display_name is not None:
            update_fields["display_name"] = effective_display_name
            update_fields["product_name"] = effective_display_name  # Keep legacy field in sync
            # Auto-generate display_code from display_name
            generated_code = generate_display_code(effective_display_name)
            update_fields["display_code"] = generated_code
            
        # Allow manual override of display_code if provided
        if data.display_code is not None:
            update_fields["display_code"] = data.display_code
            
        # CUSTOM MAPPINGS: Save custom mapping if display_name or supplier_product_name is being changed
        if CUSTOM_MAPPINGS_AVAILABLE and save_custom_mapping:
            old_display_name = current_product.get("display_name") or current_product.get("product_name", "")
            old_supplier_product_name = current_product.get("supplier_product_name", "")
            new_display_name = effective_display_name if effective_display_name is not None else old_display_name
            new_supplier_product_name = data.supplier_product_name if data.supplier_product_name is not None else old_supplier_product_name
            
            # Check if either name changed
            display_name_changed = effective_display_name is not None and effective_display_name != old_display_name
            supplier_name_changed = data.supplier_product_name is not None and data.supplier_product_name != old_supplier_product_name
            
            if display_name_changed or supplier_name_changed:
                # Get the original supplier name for reference
                original_name = current_product.get("original_sync_name") or current_product.get("name") or old_supplier_product_name or ""
                try:
                    save_custom_mapping(
                        db=db,
                        supplier=data.supplier,
                        sku=data.sku,
                        original_name=original_name,
                        custom_name=new_display_name,
                        user_email=None,  # Could add user email from auth if available
                        supplier_product_name=new_supplier_product_name if supplier_name_changed else None
                    )
                    logger.info(f"Saved custom mapping for {data.supplier}/{data.sku}: display_name='{new_display_name}'" +
                               (f", supplier_product_name='{new_supplier_product_name}'" if supplier_name_changed else ""))
                except Exception as cm_error:
                    logger.warning(f"Failed to save custom mapping: {cm_error}")
                    
        if data.supplier_product_name is not None:
            update_fields["supplier_product_name"] = data.supplier_product_name
        if data.original_series is not None:
            update_fields["original_series"] = data.original_series
        if data.price is not None:
            update_fields["price"] = data.price
            update_fields["price_locked"] = True  # Lock price from sync overwrites
            update_fields["price_locked_at"] = datetime.now(timezone.utc)
        if data.cost_price is not None:
            update_fields["cost_price"] = data.cost_price
            update_fields["price_locked"] = True
            update_fields["price_locked_at"] = datetime.now(timezone.utc)
        if data.stock_quantity is not None:
            update_fields["stock_quantity"] = data.stock_quantity
        if data.stock_m2 is not None:
            update_fields["stock_m2"] = data.stock_m2
        if data.category is not None:
            update_fields["category"] = data.category
        if data.finish is not None:
            update_fields["finish"] = data.finish
        if data.in_stock is not None:
            update_fields["in_stock"] = data.in_stock
        if data.always_in_stock is not None:
            update_fields["always_in_stock"] = data.always_in_stock
        if data.is_featured is not None:
            update_fields["is_featured"] = data.is_featured
        
        # Sale/Clearance Labels fields
        if data.labels is not None:
            update_fields["labels"] = data.labels
        if data.custom_labels is not None:
            update_fields["custom_labels"] = data.custom_labels
        if data.was_price is not None:
            update_fields["was_price"] = data.was_price
        if data.now_price is not None:
            update_fields["now_price"] = data.now_price
        # Accept sale_price too — newer frontends use this alias. Store into
        # both fields so downstream consumers reading either see the change.
        if data.sale_price is not None:
            update_fields["sale_price"] = data.sale_price
            update_fields["now_price"] = data.sale_price
        if data.discount_percentage is not None:
            update_fields["discount_percentage"] = data.discount_percentage
        if data.sale_active is not None:
            update_fields["sale_active"] = data.sale_active
        # Long product description — surfaces as "About This Product" on the
        # customer landing page. Allow empty string to clear it.
        if data.description is not None:
            update_fields["description"] = data.description
        # Related-product pins — sanitize entries; empty list clears all pins.
        if data.related_products is not None:
            cleaned_pins = []
            for entry in data.related_products:
                if not isinstance(entry, dict) or not entry.get("sku"):
                    continue
                cleaned_pins.append({
                    "sku": str(entry.get("sku")),
                    "kind": entry.get("kind") if entry.get("kind") in ("also_liked", "you_may_need") else "also_liked",
                    "series_name": str(entry.get("series_name") or ""),
                    "display_name": str(entry.get("display_name") or ""),
                    "image": entry.get("image") or None,
                })
            update_fields["related_products"] = cleaned_pins
        
        # Handle images
        if data.images is not None:
            update_fields["images"] = data.images
        if data.image is not None:
            update_fields["image"] = data.image
        
        if not update_fields:
            return {"success": True, "message": "No fields to update"}
        
        # Add update timestamp
        update_fields["last_updated"] = datetime.now(timezone.utc)
        
        # Update the product in supplier_products
        # Use _id for the update filter when available (most reliable, handles null sku/supplier)
        if data.product_id:
            try:
                update_filter = {"_id": ObjectId(data.product_id)}
            except Exception:
                update_filter = {"supplier": data.supplier, "sku": data.sku}
        else:
            update_filter = {"supplier": data.supplier, "sku": data.sku}
        
        result = db.supplier_products.update_one(
            update_filter,
            {"$set": update_fields}
        )
        
        if result.matched_count == 0:
            raise HTTPException(status_code=404, detail=f"Product not found: {data.sku}")
        
        # If category is provided, add to master categories list and update products collection
        if data.category is not None and data.category.strip():
            category_clean = data.category.strip()
            # Add to categories collection (upsert)
            db.categories.update_one(
                {"name": category_clean},
                {
                    "$set": {"name": category_clean, "last_updated": datetime.now(timezone.utc)},
                    "$setOnInsert": {"created_at": datetime.now(timezone.utc), "source": "quick_edit"}
                },
                upsert=True
            )
            
            # AUTO-SYNC: Also sync to website_categories for unified category management
            if CATEGORY_SYNC_AVAILABLE:
                try:
                    sync_category_to_website_sync(db, category_clean, auto_create=True)
                except Exception as sync_err:
                    logger.warning(f"Category sync warning (non-critical): {sync_err}")
        
        # Update the main products collection if this product exists there
        products_update = {}
        if data.price is not None:
            products_update["price"] = data.price
        if data.cost_price is not None:
            products_update["cost"] = data.cost_price
        if data.stock_quantity is not None:
            products_update["stock"] = data.stock_quantity
        if data.stock_m2 is not None:
            products_update["m2_quantity"] = data.stock_m2
        # Sync display_name to products.name
        if effective_display_name is not None:
            products_update["name"] = effective_display_name
            products_update["display_name"] = effective_display_name
        if "display_code" in update_fields:
            products_update["display_code"] = update_fields["display_code"]
        if data.supplier_product_name is not None:
            products_update["supplier_product_name"] = data.supplier_product_name
        if data.category is not None:
            products_update["category"] = data.category
        if data.finish is not None:
            products_update["finish"] = data.finish
        if data.in_stock is not None:
            products_update["in_stock"] = data.in_stock
        if data.always_in_stock is not None:
            products_update["always_in_stock"] = data.always_in_stock
        if data.is_featured is not None:
            products_update["is_featured"] = data.is_featured
        
        # Sync sale/label fields to main products collection
        if data.labels is not None:
            products_update["labels"] = data.labels
        if data.custom_labels is not None:
            products_update["custom_labels"] = data.custom_labels
        if data.was_price is not None:
            products_update["was_price"] = data.was_price
        if data.now_price is not None:
            products_update["now_price"] = data.now_price
        if data.discount_percentage is not None:
            products_update["discount_percentage"] = data.discount_percentage
        if data.sale_active is not None:
            products_update["sale_active"] = data.sale_active
        
        # Sync images to main products collection
        if data.images is not None:
            products_update["images"] = data.images
        if data.image is not None:
            products_update["image"] = data.image
        
        if products_update:
            products_update["updated_at"] = datetime.now(timezone.utc)
            # Try to update by sku first, then by supplier_sku
            result = db.products.update_one(
                {"sku": data.sku},
                {"$set": products_update}
            )
            # If no match by sku, try supplier_sku
            if result.matched_count == 0:
                db.products.update_one(
                    {"supplier_sku": data.sku},
                    {"$set": products_update}
                )
        
        # Also sync to tiles collection if product is published on website
        if current_product.get("show_on_website"):
            tiles_update = {}
            if effective_display_name is not None:
                tiles_update["display_name"] = effective_display_name
                tiles_update["name"] = effective_display_name
                # Also update slug when name changes
                import re
                slug = re.sub(r'[^a-z0-9]+', '-', effective_display_name.lower()).strip('-')
                tiles_update["slug"] = slug
            if "display_code" in update_fields:
                tiles_update["display_code"] = update_fields["display_code"]
            if data.price is not None:
                tiles_update["price"] = data.price
            if data.images is not None and len(data.images) > 0:
                tiles_update["images"] = data.images
            if data.is_featured is not None:
                tiles_update["is_featured"] = data.is_featured
            if "related_products" in update_fields:
                tiles_update["related_products"] = update_fields["related_products"]
            
            if tiles_update:
                tiles_update["updated_at"] = datetime.now(timezone.utc)
                db.tiles.update_one(
                    {"sku": data.sku},
                    {"$set": tiles_update}
                )
        
        logger.info(f"Quick update for {data.supplier}/{data.sku}: {list(update_fields.keys())}")
        
        # Bust endpoint caches (incl. tiles_related) so pin changes and name/price
        # edits show on the storefront immediately instead of serving stale cache.
        try:
            from utils.endpoint_cache import endpoint_cache
            endpoint_cache.invalidate()
        except Exception:
            pass
        
        return {
            "success": True,
            "message": f"Product {data.sku} updated",
            "updated_fields": list(update_fields.keys())
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in quick update: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/products/related-picker-search")
def related_picker_search(q: str = "", limit: int = 12, exclude_sku: str = ""):
    """Lightweight product search powering the Quick Edit 'Related Products' pin picker."""
    import re as _re
    if not q or len(q.strip()) < 2:
        return {"results": []}
    db = get_db()
    rx = {"$regex": _re.escape(q.strip()), "$options": "i"}
    query = {"$or": [
        {"display_name": rx},
        {"product_name": rx},
        {"name": rx},
        {"original_series": rx},
        {"sku": rx},
    ]}
    limit = max(1, min(int(limit), 30))
    projection = {
        "sku": 1, "display_name": 1, "product_name": 1, "name": 1,
        "our_product_name": 1, "original_series": 1, "range_name": 1,
        "series": 1, "series_name": 1, "unique_name": 1,
        "images": 1, "image": 1, "price": 1, "room_lot_price": 1, "supplier": 1,
    }
    # Search published tiles first (live on the storefront), then supplier_products.
    docs = list(db.tiles.find(query, projection).limit(limit * 3)) + \
           list(db.supplier_products.find(query, projection).limit(limit * 3))
    results, seen = [], set()
    for d in docs:
        sku = d.get("sku") or ""
        if not sku or sku in seen or (exclude_sku and sku == exclude_sku):
            continue
        seen.add(sku)
        images = d.get("images") or []
        results.append({
            "sku": sku,
            "display_name": d.get("display_name") or d.get("product_name") or d.get("name") or "",
            "name": d.get("name") or "",
            "product_name": d.get("product_name") or "",
            "our_product_name": d.get("our_product_name") or "",
            "original_series": d.get("original_series") or "",
            "range_name": d.get("range_name") or "",
            "series": d.get("series") or "",
            "series_name": d.get("series_name") or "",
            "unique_name": d.get("unique_name") or "",
            "image": (images[0] if images else None) or d.get("image"),
            "price": d.get("room_lot_price") or d.get("price") or 0,
            "supplier": d.get("supplier") or "",
        })
        if len(results) >= limit:
            break
    return {"results": results}


# Default tiles shop menu — MUST stay in sync with the fallback served by
# /website-admin/navigation/shop (website_admin.py) for pages with no DB doc.
DEFAULT_TILES_SHOP_MENU = [
    {"id": "1", "label": "ALL TILES", "link_url": "/shop/tiles", "display_order": 0, "is_active": True, "highlight": False},
    {"id": "2", "label": "WALL TILES", "link_url": "/shop/tiles?category=wall-tiles", "display_order": 1, "is_active": True, "highlight": False},
    {"id": "3", "label": "FLOOR TILES", "link_url": "/shop/tiles?category=floor-tiles", "display_order": 2, "is_active": True, "highlight": False},
    {"id": "4", "label": "PORCELAIN", "link_url": "/shop/tiles?category=porcelain", "display_order": 3, "is_active": True, "highlight": False},
    {"id": "5", "label": "POLISHED", "link_url": "/shop/tiles?filter=finish:polished", "display_order": 4, "is_active": True, "highlight": False},
    {"id": "6", "label": "MATT", "link_url": "/shop/tiles?filter=finish:matt", "display_order": 5, "is_active": True, "highlight": False},
    {"id": "7", "label": "SALE", "link_url": "/shop/tiles?filter=sale:true", "display_order": 6, "is_active": True, "highlight": True, "highlight_color": "#ef4444"},
]


@router.get("/shop-tab-destinations")
def get_shop_tab_destinations():
    """All shop pages + their tabs, each resolved to the website category it
    filters by — powers the 'Shop Tabs' bulk assignment modal in Managers."""
    from urllib.parse import urlparse, parse_qs
    db = get_db()
    groups = list(db.category_groups.find(
        {}, {"_id": 0, "slug": 1, "name": 1, "display_order": 1}
    ).sort("display_order", 1))
    cats = {c["slug"]: c.get("name") for c in db.website_categories.find({}, {"_id": 0, "slug": 1, "name": 1})}
    pages = []
    for g in groups:
        menu_type = "shop" if g["slug"] == "tiles" else f"shop_{g['slug']}"
        menu = db.navigation_menus.find_one({"menu_type": menu_type}, {"_id": 0})
        items = (menu or {}).get("items", [])
        if not items and menu_type == "shop":
            items = DEFAULT_TILES_SHOP_MENU
        tabs = []
        for it in sorted(items, key=lambda x: x.get("display_order", 0)):
            if it.get("is_active") is False:
                continue
            url = it.get("link_url") or ""
            qs = parse_qs(urlparse(url).query)
            cat_slug = (qs.get("category") or [None])[0]
            cat_name = None
            if cat_slug:
                cat_name = cats.get(cat_slug) or cat_slug.replace("-", " ").title()
            tabs.append({
                "label": it.get("label"),
                "url": url,
                "category_slug": cat_slug,
                "category_name": cat_name,
                "assignable": bool(cat_slug),
            })
        if tabs:
            pages.append({"group_slug": g["slug"], "group_name": g.get("name"), "tabs": tabs})
    return {"pages": pages}


class AssignShopTabsRequest(BaseModel):
    skus: List[str] = []
    supplier_codes: List[str] = []
    add_categories: List[str] = []
    remove_categories: List[str] = []


@router.post("/products/assign-shop-tabs")
def assign_shop_tabs(data: AssignShopTabsRequest):
    """Add/remove shop-tab destinations (sub_categories) for a set of products.
    Writes to supplier_products AND published tiles so the storefront updates."""
    if not data.skus and not data.supplier_codes:
        raise HTTPException(status_code=400, detail="No products supplied")
    if not data.add_categories and not data.remove_categories:
        raise HTTPException(status_code=400, detail="Nothing to change")
    db = get_db()
    id_or = []
    if data.skus:
        id_or.append({"sku": {"$in": data.skus}})
    if data.supplier_codes:
        id_or.append({"supplier_code": {"$in": data.supplier_codes}})
    query = {"$or": id_or}
    matched = 0
    for coll in (db.supplier_products, db.tiles):
        coll_matched = 0
        if data.add_categories:
            r = coll.update_many(query, {"$addToSet": {"sub_categories": {"$each": data.add_categories}}})
            coll_matched = r.matched_count
        if data.remove_categories:
            r = coll.update_many(query, {"$pull": {"sub_categories": {"$in": data.remove_categories}}})
            coll_matched = max(coll_matched, r.matched_count)
        matched = max(matched, coll_matched)
    return {
        "success": True,
        "updated": matched,
        "added": data.add_categories,
        "removed": data.remove_categories,
    }


class CreateShopTabRequest(BaseModel):
    group_slug: str
    label: str


@router.post("/shop-tab-destinations/create")
def create_shop_tab(data: CreateShopTabRequest):
    """Create a brand-new shop tab: backing website category (if needed) +
    nav item appended to that shop page's menu. Used by the Shop Tabs modal."""
    import re as _re
    import uuid as _uuid
    from datetime import datetime, timezone
    label = (data.label or "").strip()
    if not label or not data.group_slug:
        raise HTTPException(status_code=400, detail="label and group_slug are required")
    db = get_db()
    group = db.category_groups.find_one({"slug": data.group_slug})
    if not group:
        raise HTTPException(status_code=404, detail=f"Unknown shop page '{data.group_slug}'")
    cat_slug = _re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")
    if not cat_slug:
        raise HTTPException(status_code=400, detail="Label must contain letters or numbers")
    existing_cat = db.website_categories.find_one({"slug": cat_slug})
    cat_name = existing_cat["name"] if existing_cat else label.title()
    if not existing_cat:
        now = datetime.now(timezone.utc)
        db.website_categories.insert_one({
            "name": cat_name, "slug": cat_slug, "description": "",
            "parent_id": None, "image_url": "",
            "display_order": db.website_categories.count_documents({}),
            "is_active": True, "show_on_homepage": False,
            "seo_title": "", "seo_description": "", "product_count": 0,
            "group_slug": data.group_slug, "custom_url": None,
            "highlight": False, "subtitle": "",
            "created_at": now, "updated_at": now,
        })
    menu_type = "shop" if data.group_slug == "tiles" else f"shop_{data.group_slug}"
    menu = db.navigation_menus.find_one({"menu_type": menu_type})
    items = (menu or {}).get("items", [])
    if not items and menu_type == "shop":
        # Materialize the defaults so appending doesn't wipe the standard tabs.
        items = [dict(it) for it in DEFAULT_TILES_SHOP_MENU]
    if data.group_slug == "tiles":
        link_url = f"/shop/tiles?category={cat_slug}"
    else:
        link_url = f"/tiles?group={data.group_slug}&category={cat_slug}"
    for it in items:
        if (it.get("link_url") or "") == link_url or (it.get("label") or "").strip().lower() == label.lower():
            raise HTTPException(status_code=409, detail=f"A tab like '{label}' already exists on that page")
    items.append({
        "id": str(_uuid.uuid4()), "label": label.upper(), "link_type": "custom",
        "link_url": link_url, "display_order": len(items),
        "is_active": True, "highlight": False, "highlight_color": None, "children": [],
    })
    db.navigation_menus.update_one(
        {"menu_type": menu_type},
        {"$set": {"menu_type": menu_type, "items": items}},
        upsert=True,
    )
    return {"success": True, "tab": {
        "label": label.upper(), "url": link_url,
        "category_slug": cat_slug, "category_name": cat_name, "assignable": True,
    }}


# ============================================================
# PREVIEW DATA SYNC — pull live-site catalog data into this environment
# ============================================================

PREVIEW_SYNC_COLLECTIONS = [
    "supplier_products", "tiles", "website_categories",
    "category_groups", "navigation_menus", "page_banners",
]


def _clean_for_export(value):
    from bson import ObjectId
    if isinstance(value, ObjectId):
        return str(value)
    if isinstance(value, dict):
        return {k: _clean_for_export(v) for k, v in value.items() if k != "_id"}
    if isinstance(value, list):
        return [_clean_for_export(v) for v in value]
    return value


@router.get("/preview-sync/export")
def preview_sync_export(collection: str, skip: int = 0, limit: int = 500):
    """Read-only paged dump of whitelisted catalog collections. Consumed by a
    preview environment's pull endpoint to mirror live data for safe testing."""
    if collection not in PREVIEW_SYNC_COLLECTIONS:
        raise HTTPException(status_code=400, detail=f"Collection not allowed. Choose from: {', '.join(PREVIEW_SYNC_COLLECTIONS)}")
    db = get_db()
    limit = max(1, min(int(limit), 1000))
    total = db[collection].count_documents({})
    docs = [_clean_for_export(d) for d in db[collection].find({}).skip(max(0, int(skip))).limit(limit)]
    return {"collection": collection, "total": total, "skip": skip, "count": len(docs), "docs": docs}


class PreviewSyncPullRequest(BaseModel):
    source_url: str
    collections: List[str] = []


def _revive_dates(doc):
    from datetime import datetime as _dt
    for k, v in list(doc.items()):
        if isinstance(v, str) and (k.endswith("_at") or k in ("created", "updated")):
            try:
                doc[k] = _dt.fromisoformat(v)
            except ValueError:
                pass
    return doc


def _run_preview_sync(source_url: str, collections: List[str]):
    import requests as _rq
    from datetime import datetime, timezone
    db = get_db()

    def set_status(patch):
        db.preview_sync_status.update_one({"_id": "status"}, {"$set": patch}, upsert=True)

    db.preview_sync_status.replace_one({"_id": "status"}, {
        "_id": "status", "state": "running", "source": source_url,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "collections": {c: {"done": False, "count": 0} for c in collections},
        "error": None,
    }, upsert=True)
    try:
        for coll in collections:
            fetched = []
            skip = 0
            while True:
                r = _rq.get(
                    f"{source_url}/api/supplier-sync/preview-sync/export",
                    params={"collection": coll, "skip": skip, "limit": 500},
                    timeout=90,
                )
                r.raise_for_status()
                data = r.json()
                docs = data.get("docs", [])
                fetched.extend(docs)
                skip += len(docs)
                set_status({f"collections.{coll}.count": len(fetched)})
                if not docs or skip >= data.get("total", 0):
                    break
            if fetched:
                fetched = [_revive_dates(d) for d in fetched]
                db[coll].delete_many({})
                db[coll].insert_many(fetched)
            set_status({f"collections.{coll}.done": True, f"collections.{coll}.count": len(fetched)})
        set_status({"state": "done", "finished_at": datetime.now(timezone.utc).isoformat()})
    except Exception as e:
        set_status({"state": "error", "error": str(e)})


@router.post("/preview-sync/pull")
def preview_sync_pull(
    data: PreviewSyncPullRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(get_current_user),
):
    """Kick off a background sync that REPLACES this environment's catalog
    collections with the live site's data. Admin-only; refuses self-pull."""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    source = (data.source_url or "").strip().rstrip("/")
    if not source.startswith("http"):
        raise HTTPException(status_code=400, detail="source_url must start with http(s)://")
    from urllib.parse import urlparse
    src_host = (urlparse(source).netloc or "").lower()
    # Behind the k8s ingress the Host header is internal — check forwarded headers too.
    self_hosts = {
        (request.headers.get("host") or "").lower(),
        (request.headers.get("x-forwarded-host") or "").split(",")[0].strip().lower(),
        (urlparse(os.environ.get("REACT_APP_BACKEND_URL", "")).netloc or "").lower(),
    }
    self_hosts.discard("")
    if src_host and src_host in self_hosts:
        raise HTTPException(status_code=400, detail="Source is this same site — refusing to sync into itself")
    cols = [c for c in (data.collections or PREVIEW_SYNC_COLLECTIONS) if c in PREVIEW_SYNC_COLLECTIONS]
    if not cols:
        raise HTTPException(status_code=400, detail="No valid collections requested")
    import requests as _rq
    try:
        ping = _rq.get(
            f"{source}/api/supplier-sync/preview-sync/export",
            params={"collection": "category_groups", "skip": 0, "limit": 1},
            timeout=15,
        )
        if ping.status_code != 200:
            raise HTTPException(status_code=400, detail=f"Live site responded {ping.status_code} — has today's update been deployed there yet?")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not reach {source}: {e}")
    background_tasks.add_task(_run_preview_sync, source, cols)
    return {"success": True, "message": "Sync started in the background", "collections": cols}


@router.get("/preview-sync/status")
def preview_sync_status():
    db = get_db()
    doc = db.preview_sync_status.find_one({"_id": "status"})
    if not doc:
        return {"state": "idle"}
    doc.pop("_id", None)
    return doc


def _assignable_tab_category_names(db):
    """Lowercased set of category names used by assignable shop tabs."""
    from urllib.parse import urlparse, parse_qs
    cats = {c["slug"]: c.get("name") for c in db.website_categories.find({}, {"_id": 0, "slug": 1, "name": 1})}
    names = set()
    for g in db.category_groups.find({}, {"slug": 1}):
        menu_type = "shop" if g["slug"] == "tiles" else f"shop_{g['slug']}"
        menu = db.navigation_menus.find_one({"menu_type": menu_type}, {"_id": 0})
        items = (menu or {}).get("items", [])
        if not items and menu_type == "shop":
            items = DEFAULT_TILES_SHOP_MENU
        for it in items:
            if it.get("is_active") is False:
                continue
            qs = parse_qs(urlparse(it.get("link_url") or "").query)
            slug = (qs.get("category") or [None])[0]
            if slug:
                names.add((cats.get(slug) or slug.replace("-", " ").title()).lower())
    return names


@router.get("/products/shop-tab-gaps")
def shop_tab_gaps():
    """Counts of products not assigned to any shop tab, per product group.
    Powers the admin dashboard 'gaps' card."""
    db = get_db()
    names = _assignable_tab_category_names(db)
    by_group = {}
    total = 0
    total_products = 0
    for d in db.supplier_products.find({}, {"sub_categories": 1, "product_group": 1, "category": 1}):
        total_products += 1
        subs = [str(x).lower() for x in (d.get("sub_categories") or [])]
        if any(s in names for s in subs):
            continue
        total += 1
        grp = str(d.get("product_group") or d.get("category") or "unassigned").strip().lower()
        by_group[grp] = by_group.get(grp, 0) + 1
    return {
        "total_gaps": total,
        "total_products": total_products,
        "by_group": sorted([{"group": k, "count": v} for k, v in by_group.items()], key=lambda x: -x["count"]),
    }


def _clean_name_ws(s: str) -> str:
    """Trim + collapse internal runs of whitespace to a single space."""
    return re.sub(r"\s+", " ", s).strip()


_SP_NAME_FIELDS = ("name", "product_name", "our_product_name", "display_name", "series")
_TILE_NAME_FIELDS = ("name", "display_name", "website_name", "original_name", "series", "original_series")


@router.get("/products/data-health")
def products_data_health():
    """Missing-image counts per product group + count of products whose name
    fields carry stray whitespace. Powers the admin dashboard Data Health card."""
    db = get_db()
    by_group = {}
    missing_total = 0
    total_products = 0
    untrimmed = 0
    proj = {f: 1 for f in _SP_NAME_FIELDS}
    proj.update({"images": 1, "image": 1, "product_group": 1, "category": 1})
    for d in db.supplier_products.find({}, proj):
        total_products += 1
        imgs = d.get("images") or ([d["image"]] if d.get("image") else [])
        if not [i for i in imgs if i]:
            missing_total += 1
            grp = str(d.get("product_group") or d.get("category") or "unassigned").strip().lower()
            by_group[grp] = by_group.get(grp, 0) + 1
        if any(isinstance(d.get(f), str) and d[f] and d[f] != _clean_name_ws(d[f]) for f in _SP_NAME_FIELDS):
            untrimmed += 1
    # Name Guard — storefront (tiles) rows whose name/display_name drifted from
    # the Supplier Products name. Target matches sync-to-epos-website exactly
    # (product_name only) so "Fix now" always clears the warning.
    sp_names = {}
    for d in db.supplier_products.find(
        {"product_name": {"$nin": [None, ""]}},
        {"sku": 1, "supplier_code": 1, "product_name": 1},
    ):
        sku = d.get("sku") or d.get("supplier_code")
        if sku:
            sp_names[sku] = str(d["product_name"]).strip()
    name_drift = 0
    drift_samples = []
    for t in db.tiles.find({}, {"sku": 1, "name": 1, "display_name": 1}):
        target = sp_names.get(t.get("sku"))
        if not target:
            continue
        t_name = str(t.get("name") or "").strip()
        t_disp = str(t.get("display_name") or t_name).strip()
        if t_name != target or t_disp != target:
            name_drift += 1
            if len(drift_samples) < 5:
                drift_samples.append({"sku": t.get("sku"), "storefront": t_disp or t_name, "supplier": target})
    return {
        "missing_images_total": missing_total,
        "total_products": total_products,
        "missing_images_by_group": sorted([{"group": k, "count": v} for k, v in by_group.items()], key=lambda x: -x["count"]),
        "untrimmed_names": untrimmed,
        "name_drift": name_drift,
        "name_drift_samples": drift_samples,
    }


@router.post("/products/trim-names")
def trim_product_names():
    """One-click data cleanup: trim leading/trailing spaces and collapse double
    spaces in name fields across supplier_products, tiles, products and
    sync_staging. Slugs are NOT touched."""
    db = get_db()
    examples = []
    counts = {}
    targets = [
        (db.supplier_products, _SP_NAME_FIELDS, "supplier_products"),
        (db.tiles, _TILE_NAME_FIELDS, "tiles"),
        (db.products, ("name", "product_name", "display_name"), "products"),
        (db.sync_staging, ("name", "product_name"), "sync_staging"),
    ]
    for coll, fields, label in targets:
        fixed = 0
        proj = {f: 1 for f in fields}
        for d in coll.find({}, proj):
            sets = {}
            for f in fields:
                v = d.get(f)
                if isinstance(v, str) and v:
                    cleaned = _clean_name_ws(v)
                    if cleaned != v:
                        sets[f] = cleaned
                        if len(examples) < 5:
                            examples.append(f"'{v}' → '{cleaned}'")
            if sets:
                coll.update_one({"_id": d["_id"]}, {"$set": sets})
                fixed += 1
        counts[f"{label}_fixed"] = fixed
    counts["total_fixed"] = sum(counts.values())
    counts["examples"] = examples
    return counts


# ============================================================
# BULK TIER PRICING UPDATE ENDPOINT
# ============================================================

class BulkTierUpdateRequest(BaseModel):
    products: List[dict]  # List of {supplier, sku}
    tier_thresholds: Optional[List[float]] = None
    tier_discounts: Optional[List[float]] = None
    trade_discount: Optional[float] = None  # Optional custom trade discount for these products
    trade_discount_type: Optional[str] = None  # "percent" (default) | "fixed" (flat £/m²)
    credit_back_rate: Optional[float] = None  # Optional credit back % for trade orders
    disabled: Optional[bool] = None  # If True, disables tier pricing entirely for these products
    # Half + Full pallet pricing (bulk apply)
    pallet_enabled: Optional[bool] = None       # True/False toggles the pallet block
    pallet_price: Optional[float] = None        # Full pallet £/m²
    half_pallet_price: Optional[float] = None   # Half pallet £/m²
    m2_per_pallet: Optional[float] = None       # Full pallet m² threshold
    m2_per_half_pallet: Optional[float] = None  # Half pallet m² threshold


@router.put("/products/bulk-tier-update")
def bulk_update_product_tier_pricing(data: BulkTierUpdateRequest):
    """
    Update tier pricing settings for multiple products at once.
    Saves custom tier_thresholds, tier_discounts, and optionally trade_discount to each product.
    Products with custom settings will use these instead of global defaults.

    Per-product overrides:
    Each item in `products` can carry its own trade_discount / trade_discount_type /
    credit_back_rate / disabled / tier_thresholds / tier_discounts / pallet_* fields.
    When present these WIN over the top-level defaults for that specific product —
    so a caller can set a global 5% trade discount for 14 rows and tune 2 of them
    individually in one atomic request.

    If disabled=True (top-level or per-product), tier pricing is completely disabled for
    that product. Half + Full pallet fields are applied independently of the tier-disabled flag.
    """
    try:
        db = get_db()
        updated_count = 0

        # Normalise top-level trade_discount_type
        default_td_type = None
        if data.trade_discount_type is not None:
            default_td_type = "fixed" if str(data.trade_discount_type).lower() == "fixed" else "percent"

        for product in data.products:
            supplier = product.get('supplier')
            sku = product.get('sku')

            query = build_product_query(supplier, sku)
            if not query:
                continue

            # Per-product overrides — any of these keys, when present on this row,
            # win over the top-level defaults for this specific product.
            row_disabled          = product.get('disabled')          if 'disabled'          in product else data.disabled
            row_thresholds        = product.get('tier_thresholds')   if 'tier_thresholds'   in product else data.tier_thresholds
            row_discounts         = product.get('tier_discounts')    if 'tier_discounts'    in product else data.tier_discounts
            row_trade_discount    = product.get('trade_discount')    if 'trade_discount'    in product else data.trade_discount
            row_credit_back       = product.get('credit_back_rate')  if 'credit_back_rate'  in product else data.credit_back_rate
            row_pallet_enabled    = product.get('pallet_enabled')    if 'pallet_enabled'    in product else data.pallet_enabled
            row_pallet_price      = product.get('pallet_price')      if 'pallet_price'      in product else data.pallet_price
            row_half_pallet_price = product.get('half_pallet_price') if 'half_pallet_price' in product else data.half_pallet_price
            row_m2_per_pallet     = product.get('m2_per_pallet')     if 'm2_per_pallet'     in product else data.m2_per_pallet
            row_m2_per_half       = product.get('m2_per_half_pallet') if 'm2_per_half_pallet' in product else data.m2_per_half_pallet

            row_td_type = default_td_type
            if 'trade_discount_type' in product and product.get('trade_discount_type') is not None:
                row_td_type = "fixed" if str(product.get('trade_discount_type')).lower() == "fixed" else "percent"

            update_data = {
                "updated_at": datetime.now(timezone.utc)
            }

            # Check if disabling tier pricing (per-product OR top-level)
            if row_disabled:
                update_data["tier_pricing_disabled"] = True
                update_data["has_custom_tier_pricing"] = False
            else:
                # Enabling tier pricing with custom settings
                update_data["tier_pricing_disabled"] = False
                if row_thresholds is not None:
                    update_data["tier_thresholds"] = row_thresholds
                if row_discounts is not None:
                    update_data["tier_discounts"] = row_discounts
                update_data["has_custom_tier_pricing"] = True

            # Add trade discount if provided (per-product or top-level)
            if row_trade_discount is not None:
                update_data["trade_discount"] = row_trade_discount
            if row_td_type is not None:
                update_data["trade_discount_type"] = row_td_type

            # Add credit back rate if provided
            if row_credit_back is not None:
                update_data["credit_back_rate"] = row_credit_back

            # Half + Full pallet pricing (independent of tier_pricing_disabled)
            if row_pallet_enabled is not None:
                update_data["pallet_enabled"] = bool(row_pallet_enabled)
                if not row_pallet_enabled:
                    # Explicit disable — clear the rates & thresholds so the storefront
                    # stops offering the pallet selector.
                    update_data["pallet_price"] = None
                    update_data["half_pallet_price"] = None
                    update_data["m2_per_pallet"] = None
                    update_data["m2_per_half_pallet"] = None
            if row_pallet_price is not None:
                update_data["pallet_price"] = row_pallet_price
            if row_half_pallet_price is not None:
                update_data["half_pallet_price"] = row_half_pallet_price
            if row_m2_per_pallet is not None:
                update_data["m2_per_pallet"] = row_m2_per_pallet
            if row_m2_per_half is not None:
                update_data["m2_per_half_pallet"] = row_m2_per_half

            # Update supplier_products
            result = db.supplier_products.update_one(
                query,
                {"$set": update_data}
            )
            
            if result.modified_count > 0:
                updated_count += 1
            
            # Also update tiles collection if product is published
            # Try both sku and supplier_code since the identifier could be either
            tile_query = build_product_query(supplier, sku)
            if tile_query:
                db.tiles.update_one(tile_query, {"$set": update_data})
        
        action = "disabled" if data.disabled else "updated"
        logger.info(f"Bulk tier update: {updated_count} products {action}")
        
        return {
            "success": True,
            "message": f"Tier pricing {action} for {updated_count} products",
            "updated_count": updated_count,
            "action": action
        }
        
    except Exception as e:
        logger.error(f"Error in bulk tier update: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================
# QUOTE SETTINGS UPDATE ENDPOINT
# ============================================================

class BulkQuoteSettingsRequest(BaseModel):
    products: List[dict]  # List of {supplier, sku}
    quote_disabled: bool  # If True, disables quote requests for these products
    custom_quote_threshold: Optional[int] = None  # Custom threshold, if None uses global


@router.put("/products/bulk-quote-settings")
def bulk_update_product_quote_settings(data: BulkQuoteSettingsRequest):
    """
    Update quote settings for multiple products at once.
    Can disable quote requests or set custom thresholds.
    """
    try:
        db = get_db()
        updated_count = 0
        
        for product in data.products:
            supplier = product.get('supplier')
            sku = product.get('sku')
            
            query = build_product_query(supplier, sku)
            if not query:
                continue
            
            update_data = {
                "quote_disabled": data.quote_disabled,
                "updated_at": datetime.now(timezone.utc)
            }
            
            # Only set custom threshold if provided and quotes not disabled
            if data.custom_quote_threshold is not None and not data.quote_disabled:
                update_data["custom_quote_threshold"] = data.custom_quote_threshold
            elif data.quote_disabled:
                # Clear custom threshold when disabling quotes
                update_data["custom_quote_threshold"] = None
            
            # Update supplier_products
            result = db.supplier_products.update_one(
                query,
                {"$set": update_data}
            )
            
            if result.modified_count > 0:
                updated_count += 1
            
            # Also update tiles collection if product is published
            db.tiles.update_one(
                {"$or": [{"sku": sku}, {"supplier_code": sku}]},
                {"$set": update_data}
            )
        
        action = "disabled" if data.quote_disabled else "enabled"
        logger.info(f"Bulk quote update: {updated_count} products - quotes {action}")
        
        return {
            "success": True,
            "message": f"Quote requests {action} for {updated_count} products",
            "updated_count": updated_count,
            "quote_disabled": data.quote_disabled
        }
        
    except Exception as e:
        logger.error(f"Error in bulk quote settings update: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================
# PRICING UNIT SETTINGS UPDATE ENDPOINT
# ============================================================

class BulkPricingUnitRequest(BaseModel):
    products: List[dict]  # List of {supplier, sku}
    pricing_unit: str  # "m2" or "unit"
    unit_price: Optional[float] = None  # Price per unit (only for unit-based products)


@router.put("/products/bulk-pricing-unit")
def bulk_update_product_pricing_unit(data: BulkPricingUnitRequest):
    """
    Update pricing unit settings for multiple products at once.
    Sets products to be priced per m² (tiles) or per unit (adhesives, grout, tools).
    """
    try:
        db = get_db()
        updated_count = 0
        
        # Validate pricing_unit
        if data.pricing_unit not in ['m2', 'unit']:
            raise HTTPException(status_code=400, detail="pricing_unit must be 'm2' or 'unit'")
        
        for product in data.products:
            supplier = product.get('supplier')
            sku = product.get('sku')
            
            query = build_product_query(supplier, sku)
            if not query:
                continue
            
            update_data = {
                "pricing_unit": data.pricing_unit,
                "updated_at": datetime.now(timezone.utc)
            }
            
            # Set unit_price if provided and pricing is per-unit
            if data.pricing_unit == 'unit' and data.unit_price is not None:
                update_data["unit_price"] = data.unit_price
            
            # Update supplier_products
            result = db.supplier_products.update_one(
                query,
                {"$set": update_data}
            )
            
            if result.modified_count > 0:
                updated_count += 1
            
            # Also update tiles collection if product is published
            db.tiles.update_one(
                {"$or": [{"sku": sku}, {"supplier_code": sku}]},
                {"$set": update_data}
            )
        
        logger.info(f"Bulk pricing unit update: {updated_count} products set to '{data.pricing_unit}'")
        
        return {
            "success": True,
            "message": f"Pricing unit set to '{data.pricing_unit}' for {updated_count} products",
            "updated_count": updated_count,
            "pricing_unit": data.pricing_unit
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in bulk pricing unit update: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================
# DISPLAY CODE GENERATION ENDPOINT
# ============================================================

@router.post("/generate-display-code")
def generate_display_code_endpoint(display_name: str):
    """
    Generate a display code from a display name.
    Used for live preview in the frontend when editing display names.
    
    Format: TS + Series Initial + Color Initial + Size Digits + Finish Initial
    Example: "Dolomite Blue 60x60cm Polished" → "TSDB66P"
    """
    from business_config.business_rules import generate_display_code, parse_display_name_components
    
    try:
        code = generate_display_code(display_name)
        components = parse_display_name_components(display_name)
        
        return {
            "success": True,
            "display_code": code,
            "components": components,
            "breakdown": {
                "prefix": "TS",
                "series": components.get("series", ""),
                "series_initial": code[2] if len(code) > 2 else "",
                "color": components.get("color", ""),
                "color_initial": code[3] if len(code) > 3 else "",
                "size": components.get("size", ""),
                "size_digits": code[4:6] if len(code) > 5 else "",
                "finish": components.get("finish", ""),
                "finish_initial": code[6] if len(code) > 6 else ""
            }
        }
    except Exception as e:
        logger.error(f"Error generating display code: {e}")
        return {
            "success": False,
            "display_code": "TS0000",
            "error": str(e)
        }


@router.get("/generate-display-code")
def generate_display_code_get(display_name: str):
    """GET version of display code generation for easier testing"""
    return generate_display_code_endpoint(display_name)



# ============================================================
# SALE / CLEARANCE LABELS ENDPOINTS
# ============================================================

# ============ Product Labels CRUD ============

DEFAULT_LABELS = [
    {"name": "Sale", "color": "#ef4444", "bg_color": "#fef2f2", "text_color": "#b91c1c", "icon": "tag", "is_default": True, "order": 0},
    {"name": "Clearance", "color": "#f97316", "bg_color": "#fff7ed", "text_color": "#c2410c", "icon": "percent", "is_default": True, "order": 1},
    {"name": "New Arrival", "color": "#3b82f6", "bg_color": "#eff6ff", "text_color": "#1d4ed8", "icon": "zap", "is_default": True, "order": 2},
    {"name": "Limited Stock", "color": "#eab308", "bg_color": "#fefce8", "text_color": "#a16207", "icon": "alert-circle", "is_default": True, "order": 3},
    {"name": "Best Seller", "color": "#a855f7", "bg_color": "#faf5ff", "text_color": "#7e22ce", "icon": "star", "is_default": True, "order": 4},
]

@router.get("/labels")
def get_all_labels():
    """Get all product labels (both default and custom) from DB"""
    try:
        db = get_db()
        # Seed defaults if collection is empty
        if db.product_labels.count_documents({}) == 0:
            for label in DEFAULT_LABELS:
                db.product_labels.insert_one(label)
        
        labels = list(db.product_labels.find({}, {"_id": 0}).sort("order", 1))
        return {"labels": labels}
    except Exception as e:
        logger.error(f"Error getting labels: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/labels")
def create_label(data: dict):
    """Create a new custom product label"""
    try:
        db = get_db()
        name = data.get("name", "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="Label name is required")
        
        # Check for duplicates (case-insensitive)
        existing = db.product_labels.find_one({"name": {"$regex": f"^{re.escape(name)}$", "$options": "i"}})
        if existing:
            raise HTTPException(status_code=400, detail=f"Label '{name}' already exists")
        
        # Get max order
        max_order = 0
        last = db.product_labels.find_one(sort=[("order", -1)])
        if last:
            max_order = last.get("order", 0) + 1
        
        label = {
            "name": name,
            "color": data.get("color", "#6b7280"),
            "bg_color": data.get("bg_color", "#f3f4f6"),
            "text_color": data.get("text_color", "#374151"),
            "icon": data.get("icon", "tag"),
            "is_default": False,
            "order": max_order
        }
        db.product_labels.insert_one(label)
        
        return {"success": True, "label": {k: v for k, v in label.items() if k != "_id"}}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating label: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/labels/{label_name}")
def update_label(label_name: str, data: dict):
    """Update an existing product label (name, color, icon)"""
    try:
        db = get_db()
        existing = db.product_labels.find_one({"name": label_name})
        if not existing:
            raise HTTPException(status_code=404, detail=f"Label '{label_name}' not found")
        
        update_fields = {}
        new_name = data.get("name", "").strip()
        if new_name and new_name != label_name:
            # Check for name collision
            collision = db.product_labels.find_one({"name": {"$regex": f"^{re.escape(new_name)}$", "$options": "i"}})
            if collision:
                raise HTTPException(status_code=400, detail=f"Label '{new_name}' already exists")
            update_fields["name"] = new_name
        
        for field in ["color", "bg_color", "text_color", "icon"]:
            if field in data:
                update_fields[field] = data[field]
        
        if not update_fields:
            return {"success": True, "message": "No changes"}
        
        db.product_labels.update_one({"name": label_name}, {"$set": update_fields})
        
        # If name changed, update all products that reference this label
        if "name" in update_fields:
            old_name = label_name
            new_name = update_fields["name"]
            # Update in labels array
            db.supplier_products.update_many(
                {"labels": old_name},
                {"$set": {"labels.$[elem]": new_name}},
                array_filters=[{"elem": old_name}]
            )
            # Update in custom_labels array
            db.supplier_products.update_many(
                {"custom_labels": old_name},
                {"$set": {"custom_labels.$[elem]": new_name}},
                array_filters=[{"elem": old_name}]
            )
            # Also update tiles
            db.tiles.update_many(
                {"labels": old_name},
                {"$set": {"labels.$[elem]": new_name}},
                array_filters=[{"elem": old_name}]
            )
        
        return {"success": True, "message": f"Label '{label_name}' updated"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating label: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/labels/{label_name}")
def delete_label(label_name: str):
    """Delete a product label and remove it from all products"""
    try:
        db = get_db()
        existing = db.product_labels.find_one({"name": label_name})
        if not existing:
            raise HTTPException(status_code=404, detail=f"Label '{label_name}' not found")
        
        # Remove label from DB
        db.product_labels.delete_one({"name": label_name})
        
        # Remove from all products
        products_updated = db.supplier_products.update_many(
            {"$or": [{"labels": label_name}, {"custom_labels": label_name}]},
            {"$pull": {"labels": label_name, "custom_labels": label_name}}
        ).modified_count
        
        tiles_updated = db.tiles.update_many(
            {"labels": label_name},
            {"$pull": {"labels": label_name}}
        ).modified_count
        
        return {
            "success": True,
            "message": f"Label '{label_name}' deleted",
            "products_updated": products_updated,
            "tiles_updated": tiles_updated
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting label: {e}")
        raise HTTPException(status_code=500, detail=str(e))


PRESET_LABELS = ["Sale", "Clearance", "New Arrival", "Limited Stock", "Best Seller"]


@router.get("/labels/presets")
def get_preset_labels():
    """Get list of predefined labels available"""
    return {
        "presets": PRESET_LABELS,
        "description": {
            "Sale": "Product is on sale with discounted pricing",
            "Clearance": "Product is being cleared out, often at significant discount",
            "New Arrival": "Recently added product",
            "Limited Stock": "Low stock warning",
            "Best Seller": "Popular product"
        }
    }


@router.get("/labels/custom")
def get_custom_labels():
    """Get list of all custom labels that have been used across products"""
    try:
        db = get_db()
        # Aggregate all unique custom labels
        pipeline = [
            {"$match": {"custom_labels": {"$exists": True, "$ne": []}}},
            {"$unwind": "$custom_labels"},
            {"$group": {"_id": "$custom_labels"}},
            {"$sort": {"_id": 1}}
        ]
        result = list(db.supplier_products.aggregate(pipeline))
        custom_labels = [r["_id"] for r in result]
        return {"custom_labels": custom_labels}
    except Exception as e:
        logger.error(f"Error getting custom labels: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/products/labels")
def update_product_labels(data: ProductLabelsRequest):
    """Update labels for a single product"""
    try:
        db = get_db()
        
        update_fields = {
            "labels": data.labels,
            "custom_labels": data.custom_labels,
            "last_updated": datetime.now(timezone.utc)
        }
        
        # Update supplier_products
        result = db.supplier_products.update_one(
            {"sku": data.sku, "supplier": data.supplier},
            {"$set": update_fields}
        )
        
        if result.matched_count == 0:
            raise HTTPException(status_code=404, detail=f"Product not found: {data.sku}")
        
        # Also update main products collection
        db.products.update_one(
            {"sku": data.sku},
            {"$set": {
                "labels": data.labels,
                "custom_labels": data.custom_labels,
                "updated_at": datetime.now(timezone.utc)
            }}
        )
        
        logger.info(f"Updated labels for {data.supplier}/{data.sku}: {data.labels + data.custom_labels}")
        
        return {
            "success": True,
            "message": f"Labels updated for {data.sku}",
            "labels": data.labels,
            "custom_labels": data.custom_labels
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating labels: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/products/sale-pricing")
def update_product_sale_pricing(data: ProductSalePricingRequest):
    """
    Update sale pricing for a single product.
    
    Logic:
    - NOW price = List Price (unchanged, the actual selling price)
    - WAS price = NOW × (1 + was_markup_percent%) OR directly entered was_price
    - Discount = (WAS - NOW) / WAS × 100
    
    This creates a "was £X, now £Y, save Z%" display without changing the actual selling price.
    """
    try:
        db = get_db()
        
        # Get current product to access list_price and cost_price
        product = db.supplier_products.find_one(
            {"sku": data.sku, "supplier": data.supplier},
            {"_id": 0, "cost_price": 1, "price": 1, "list_price": 1, "room_lot_price": 1}
        )
        
        if not product:
            raise HTTPException(status_code=404, detail=f"Product not found: {data.sku}")
        
        # NOW price is always the list price (actual selling price)
        list_price = product.get("list_price") or product.get("price") or product.get("room_lot_price") or 0
        
        update_fields = {
            "sale_active": data.sale_active,
            "last_updated": datetime.now(timezone.utc)
        }
        
        # Determine WAS price
        was_price = None
        was_markup_percent = None
        
        if data.was_price is not None:
            # Direct WAS price entry
            was_price = data.was_price
            # Calculate discount percentage from WAS: (WAS - NOW) / WAS × 100
            if was_price > list_price and was_price > 0:
                was_markup_percent = round(((was_price - list_price) / was_price) * 100, 1)
        elif data.was_markup_percent is not None and list_price > 0:
            # Calculate WAS from discount percentage
            # User enters 20% meaning "20% off the WAS price" → NOW = WAS × (1 - 20/100)
            # So WAS = NOW / (1 - discount/100)
            was_markup_percent = data.was_markup_percent
            if was_markup_percent >= 100:
                raise HTTPException(status_code=400, detail="Discount percentage must be less than 100%")
            raw_was = list_price / (1 - data.was_markup_percent / 100)
            # Round to .99
            import math
            was_price = math.ceil(raw_was) - 0.01
        
        if was_price and was_price > 0:
            update_fields["was_price"] = was_price
            update_fields["was_markup_percent"] = was_markup_percent
            
            # Store discount percentage
            # When user explicitly entered a percentage, use their exact value
            # When user entered a direct WAS price, calculate from the actual values
            if data.was_markup_percent is not None:
                update_fields["discount_percentage"] = data.was_markup_percent
            elif was_price > list_price:
                update_fields["discount_percentage"] = round(((was_price - list_price) / was_price) * 100, 1)
                
            # Calculate savings
            if was_price > list_price:
                savings = round(was_price - list_price, 2)
                update_fields["sale_savings"] = savings
        else:
            # Clear sale pricing if no WAS price
            update_fields["was_price"] = None
            update_fields["was_markup_percent"] = None
            update_fields["discount_percentage"] = None
            update_fields["sale_savings"] = None
        
        # Update supplier_products
        db.supplier_products.update_one(
            {"sku": data.sku, "supplier": data.supplier},
            {"$set": update_fields}
        )
        
        # Also update tiles collection if published
        db.tiles.update_one(
            {"sku": data.sku},
            {"$set": update_fields}
        )
        
        logger.info(f"Updated sale pricing for {data.supplier}/{data.sku}: WAS={was_price}, NOW={list_price}")
        
        return {
            "success": True,
            "message": f"Sale pricing updated for {data.sku}",
            "now_price": list_price,
            "was_price": was_price,
            "was_markup_percent": was_markup_percent,
            "discount_percentage": update_fields.get("discount_percentage"),
            "savings": update_fields.get("sale_savings"),
            "sale_active": data.sale_active
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating sale pricing: {e}")
        raise HTTPException(status_code=500, detail=str(e))


class BulkSalePricingRequest(BaseModel):
    products: List[dict]  # List of {supplier, sku}
    sale_active: bool = True
    was_markup_percent: Optional[float] = None
    was_price: Optional[float] = None
    labels: Optional[List[str]] = []


@router.put("/products/bulk-sale-pricing")
def bulk_update_sale_pricing(data: BulkSalePricingRequest):
    """
    Bulk update sale pricing and labels for multiple products.
    
    - was_markup_percent: Add % on top of list price to create WAS price
    - was_price: Direct WAS price (overrides markup if provided)
    - labels: Product labels like "Sale", "Clearance", etc.
    """
    try:
        db = get_db()
        import math
        
        updated_count = 0
        
        for product in data.products:
            supplier = product.get('supplier')
            sku = product.get('sku')
            
            query = build_product_query(supplier, sku)
            if not query:
                continue
            
            # Get product to access list_price
            prod = db.supplier_products.find_one(
                query,
                {"list_price": 1, "price": 1, "room_lot_price": 1}
            )
            
            if not prod:
                continue
            
            list_price = prod.get("list_price") or prod.get("price") or prod.get("room_lot_price") or 0
            
            update_fields = {
                "sale_active": data.sale_active,
                "last_updated": datetime.now(timezone.utc)
            }
            
            # Add labels if provided
            if data.labels:
                update_fields["labels"] = data.labels
            
            # Calculate WAS price
            was_price = None
            was_markup_percent = None
            
            if data.was_price:
                # Direct WAS price
                was_price = data.was_price
                if list_price > 0:
                    was_markup_percent = round(((was_price - list_price) / list_price) * 100, 1)
            elif data.was_markup_percent and list_price > 0:
                # User enters X% meaning "X% off the WAS price" → NOW = WAS × (1 - X/100) → WAS = NOW / (1 - X/100)
                was_markup_percent = data.was_markup_percent
                if was_markup_percent >= 100:
                    continue
                raw_was = list_price / (1 - data.was_markup_percent / 100)
                was_price = math.ceil(raw_was) - 0.01
            
            if was_price and was_price > 0:
                update_fields["was_price"] = was_price
                update_fields["was_markup_percent"] = was_markup_percent
                
                if was_price > list_price:
                    # Store the exact user-entered discount percentage
                    update_fields["discount_percentage"] = data.was_markup_percent if data.was_markup_percent else round(((was_price - list_price) / was_price) * 100, 1)
                    update_fields["sale_savings"] = round(was_price - list_price, 2)
            
            # Update supplier_products
            db.supplier_products.update_one(
                query,
                {"$set": update_fields}
            )
            
            # Also update tiles collection
            db.tiles.update_one(
                {"$or": [{"sku": sku}, {"supplier_code": sku}]},
                {"$set": update_fields}
            )
            
            updated_count += 1
        
        logger.info(f"Bulk sale pricing update: {updated_count} products")
        
        return {
            "success": True,
            "message": f"Sale settings updated for {updated_count} products",
            "updated_count": updated_count,
            "sale_active": data.sale_active,
            "was_markup_percent": data.was_markup_percent,
            "was_price": data.was_price,
            "labels": data.labels
        }
        
    except Exception as e:
        logger.error(f"Error in bulk sale pricing update: {e}")
        raise HTTPException(status_code=500, detail=str(e))


class BulkDescriptionRequest(BaseModel):
    products: List[dict]  # List of {supplier, sku, color, size, material, finish, name, series, supplier_product_name}
    description_template: Optional[str] = None
    seo_keywords: Optional[str] = None
    hidden_seo_keywords: Optional[str] = None  # NEW: Manual hidden SEO keywords
    generate_hidden_seo: bool = False  # NEW: Auto-generate hidden SEO from supplier names
    use_placeholders: bool = True
    add_variations: bool = False  # NEW: Add slight wording variations for SEO
    update_mode: str = 'replace'  # 'replace' = overwrite all, 'append' = only update empty fields


@router.put("/products/bulk-description")
def bulk_update_description(data: BulkDescriptionRequest):
    """
    Bulk update description and SEO keywords for multiple products.
    
    Supports smart placeholders that preserve each product's unique attributes:
    - {color} - Product's color
    - {size} - Product's size
    - {material} - Product's material
    - {finish} - Product's finish
    - {name} - Product's name
    - {series} - Product's series
    
    Supports add_variations flag for SEO-friendly unique descriptions.
    Each product will get its own unique description with placeholders replaced.
    """
    try:
        db = get_db()
        updated_count = 0
        
        # Variation phrases for add_variations mode
        variation_openings = [
            'Transform your living spaces with',
            'Elevate your interiors with',
            'Create stunning spaces with',
            'Bring elegance to your home with',
            'Discover the beauty of',
            'Enhance your rooms with',
            'Make a statement with',
            'Upgrade your space with',
            'Redesign your home with',
            'Add sophistication with',
            'Introduce style to your space with',
            'Beautify your rooms with'
        ]
        variation_qualities = [
            'exceptional quality',
            'premium craftsmanship',
            'superior durability',
            'outstanding elegance',
            'timeless beauty',
            'remarkable style',
            'stunning design',
            'exquisite finish',
            'impeccable quality',
            'sophisticated appeal'
        ]
        variation_ideal = [
            'an ideal choice',
            'a perfect option',
            'an excellent selection',
            'a superb choice',
            'a great addition',
            'a wonderful solution'
        ]
        
        add_variations = getattr(data, 'add_variations', False)
        update_mode = getattr(data, 'update_mode', 'replace')  # 'replace' or 'append'
        import random
        
        for idx, product in enumerate(data.products):
            supplier = product.get('supplier')
            sku = product.get('sku')
            
            query = build_product_query(supplier, sku)
            if not query:
                continue
            
            # For 'append' mode, fetch the existing product to check which fields are empty
            existing_product = None
            if update_mode == 'append':
                existing_product = db.supplier_products.find_one(
                    query,
                    {"description": 1, "seo_keywords": 1, "hidden_seo_keywords": 1}
                )
            
            update_fields = {
                "last_updated": datetime.now(timezone.utc)
            }
            
            # Process description template
            if data.description_template:
                # Skip if append mode and product already has a description
                should_update_description = True
                if update_mode == 'append' and existing_product:
                    existing_desc = existing_product.get('description', '')
                    if existing_desc and str(existing_desc).strip():
                        should_update_description = False
                
                if should_update_description:
                    if data.use_placeholders:
                        # Replace placeholders with product's actual values
                        description = data.description_template
                        description = description.replace('{color}', str(product.get('color', '')).strip())
                        description = description.replace('{size}', str(product.get('size', '')).strip())
                        description = description.replace('{material}', str(product.get('material', '')).strip())
                        description = description.replace('{finish}', str(product.get('finish', '')).strip())
                        # Use product_name first (customer-facing renamed name), then display_name, then name (supplier name)
                        display_name = product.get('product_name') or product.get('display_name') or product.get('name', '')
                        description = description.replace('{name}', str(display_name).strip())
                        description = description.replace('{series}', str(product.get('series', '')).strip())
                        
                        # Apply variations if enabled (skip first product to keep original as template)
                        if add_variations and idx > 0:
                            import re
                            # Vary opening phrases
                            opening = variation_openings[idx % len(variation_openings)]
                            description = re.sub(
                                r'^(Transform your living spaces with|Elevate your interiors with|Create stunning spaces with)',
                                opening,
                                description,
                                flags=re.IGNORECASE
                            )
                            # Vary quality phrases
                            quality = variation_qualities[idx % len(variation_qualities)]
                            description = re.sub(r'exceptional quality|premium quality|superior quality', quality, description, flags=re.IGNORECASE)
                            # Vary "ideal choice" phrases
                            ideal = variation_ideal[idx % len(variation_ideal)]
                            description = re.sub(r'an ideal choice|a perfect choice|an excellent choice', ideal, description, flags=re.IGNORECASE)
                        
                        # Clean up any empty placeholders that weren't replaced
                        import re
                        description = re.sub(r'\s+', ' ', description).strip()
                        update_fields["description"] = description
                    else:
                        # Use template as-is for all products
                        update_fields["description"] = data.description_template
            
            # Process SEO keywords
            if data.seo_keywords:
                # Skip if append mode and product already has seo_keywords
                should_update_seo = True
                if update_mode == 'append' and existing_product:
                    existing_seo = existing_product.get('seo_keywords', [])
                    if existing_seo and len(existing_seo) > 0:
                        should_update_seo = False
                
                if should_update_seo:
                    if data.use_placeholders:
                        # Replace placeholders in keywords too
                        keywords = data.seo_keywords
                        keywords = keywords.replace('{color}', str(product.get('color', '')).strip())
                        keywords = keywords.replace('{size}', str(product.get('size', '')).strip())
                        keywords = keywords.replace('{material}', str(product.get('material', '')).strip())
                        keywords = keywords.replace('{finish}', str(product.get('finish', '')).strip())
                        # Use product_name first (customer-facing renamed name), then display_name, then name (supplier name)
                        display_name = product.get('product_name') or product.get('display_name') or product.get('name', '')
                        keywords = keywords.replace('{name}', str(display_name).strip())
                        keywords = keywords.replace('{series}', str(product.get('series', '')).strip())
                        # Clean up and split into list
                        keywords_list = [k.strip() for k in keywords.split(',') if k.strip()]
                        update_fields["seo_keywords"] = keywords_list
                    else:
                        keywords_list = [k.strip() for k in data.seo_keywords.split(',') if k.strip()]
                        update_fields["seo_keywords"] = keywords_list
            
            # Process Hidden SEO Keywords (manual input or auto-generated)
            if data.hidden_seo_keywords:
                # Skip if append mode and product already has hidden_seo_keywords
                should_update_hidden = True
                if update_mode == 'append' and existing_product:
                    existing_hidden = existing_product.get('hidden_seo_keywords', '')
                    if existing_hidden and str(existing_hidden).strip():
                        should_update_hidden = False
                
                if should_update_hidden:
                    # Manual hidden SEO keywords - apply to all products
                    update_fields["hidden_seo_keywords"] = data.hidden_seo_keywords
            
            if data.generate_hidden_seo:
                # Auto-generate hidden SEO from supplier product name
                supplier_name = product.get('supplier_product_name', '')
                if supplier_name:
                    # Store the supplier name as hidden SEO (for search engines only)
                    update_fields["hidden_seo_keywords"] = supplier_name
            
            # Update supplier_products
            result = db.supplier_products.update_one(
                query,
                {"$set": update_fields}
            )
            
            if result.matched_count > 0:
                updated_count += 1
                
                # Also update tiles collection
                db.tiles.update_one(
                    {"$or": [{"sku": sku}, {"supplier_code": sku}]},
                    {"$set": update_fields}
                )
                
                # Also sync to products collection (for Edit Product Full Page sync)
                db.products.update_one(
                    {"$or": [{"sku": sku}, {"supplier_code": sku}]},
                    {"$set": update_fields}
                )
        
        logger.info(f"Bulk description update: {updated_count} products")
        
        return {
            "success": True,
            "message": f"Description updated for {updated_count} products",
            "updated_count": updated_count,
            "used_placeholders": data.use_placeholders
        }
        
    except Exception as e:
        logger.error(f"Error in bulk description update: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/products/bulk-labels")
def bulk_update_labels(data: BulkLabelsRequest):
    """
    Bulk update labels for multiple products.
    Actions:
    - "add": Add labels to existing labels
    - "remove": Remove specified labels
    - "replace": Replace all labels with the provided ones
    """
    try:
        db = get_db()
        
        updated_count = 0
        errors = []
        
        for product_id in data.product_ids:
            sku = product_id.get("sku")
            supplier = product_id.get("supplier")
            
            if not sku or not supplier:
                errors.append("Missing sku or supplier in product_id")
                continue
            
            try:
                if data.action == "replace":
                    # Replace all labels
                    update = {
                        "$set": {
                            "labels": data.labels,
                            "custom_labels": data.custom_labels,
                            "last_updated": datetime.now(timezone.utc)
                        }
                    }
                elif data.action == "add":
                    # Add to existing labels
                    update = {
                        "$addToSet": {
                            "labels": {"$each": data.labels},
                            "custom_labels": {"$each": data.custom_labels}
                        },
                        "$set": {"last_updated": datetime.now(timezone.utc)}
                    }
                elif data.action == "remove":
                    # Remove specified labels
                    update = {
                        "$pull": {
                            "labels": {"$in": data.labels},
                            "custom_labels": {"$in": data.custom_labels}
                        },
                        "$set": {"last_updated": datetime.now(timezone.utc)}
                    }
                else:
                    errors.append(f"Invalid action: {data.action}")
                    continue
                
                result = db.supplier_products.update_one(
                    {"sku": sku, "supplier": supplier},
                    update
                )
                
                if result.matched_count > 0:
                    updated_count += 1
                    # Also update main products
                    if data.action == "replace":
                        db.products.update_one(
                            {"sku": sku},
                            {"$set": {"labels": data.labels, "custom_labels": data.custom_labels}}
                        )
                    elif data.action == "add":
                        db.products.update_one(
                            {"sku": sku},
                            {"$addToSet": {"labels": {"$each": data.labels}, "custom_labels": {"$each": data.custom_labels}}}
                        )
                    elif data.action == "remove":
                        db.products.update_one(
                            {"sku": sku},
                            {"$pull": {"labels": {"$in": data.labels}, "custom_labels": {"$in": data.custom_labels}}}
                        )
                        
            except Exception as e:
                errors.append(f"Error updating {sku}: {str(e)}")
        
        logger.info(f"Bulk labels update: {updated_count}/{len(data.product_ids)} products updated")
        
        return {
            "success": True,
            "message": f"Updated labels for {updated_count} products",
            "updated_count": updated_count,
            "total_requested": len(data.product_ids),
            "errors": errors if errors else None
        }
    except Exception as e:
        logger.error(f"Error in bulk labels update: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/products/bulk-sale-pricing")
def bulk_update_sale_pricing(data: BulkSalePricingRequest):
    """
    Bulk update sale pricing for multiple products.
    - Apply discount_percentage to all selected products
    - Or clear all sale pricing if clear_sale=True
    """
    try:
        db = get_db()
        
        updated_count = 0
        errors = []
        results = []
        
        for product_id in data.product_ids:
            sku = product_id.get("sku")
            supplier = product_id.get("supplier")
            
            if not sku or not supplier:
                errors.append("Missing sku or supplier")
                continue
            
            try:
                # Get current product
                product = db.supplier_products.find_one(
                    {"sku": sku, "supplier": supplier},
                    {"_id": 0, "cost_price": 1, "price": 1, "product_name": 1}
                )
                
                if not product:
                    errors.append(f"Product not found: {sku}")
                    continue
                
                if data.clear_sale:
                    # Clear all sale pricing
                    update = {
                        "$set": {
                            "sale_active": False,
                            "last_updated": datetime.now(timezone.utc)
                        },
                        "$unset": {
                            "was_price": "",
                            "now_price": "",
                            "discount_percentage": "",
                            "sale_profit": "",
                            "sale_profit_margin": ""
                        }
                    }
                else:
                    cost_price = product.get("cost_price", 0) or 0
                    current_price = product.get("price", 0) or 0
                    
                    # Calculate was_price
                    if data.was_price_markup and cost_price > 0:
                        was_price = round(cost_price * (1 + data.was_price_markup / 100), 2)
                    else:
                        was_price = current_price
                    
                    # Calculate now_price from discount
                    if data.discount_percentage and was_price > 0:
                        now_price = round(was_price * (1 - data.discount_percentage / 100), 2)
                    else:
                        now_price = current_price
                    
                    # Calculate profit
                    profit = round(now_price - cost_price, 2) if cost_price > 0 else 0
                    profit_margin = round((profit / now_price) * 100, 1) if now_price > 0 else 0
                    
                    update = {
                        "$set": {
                            "was_price": was_price,
                            "now_price": now_price,
                            "discount_percentage": data.discount_percentage,
                            "sale_active": data.sale_active,
                            "sale_profit": profit,
                            "sale_profit_margin": profit_margin,
                            "last_updated": datetime.now(timezone.utc)
                        }
                    }
                    
                    results.append({
                        "sku": sku,
                        "name": product.get("product_name", ""),
                        "was_price": was_price,
                        "now_price": now_price,
                        "discount": data.discount_percentage,
                        "profit": profit
                    })
                
                db.supplier_products.update_one(
                    {"sku": sku, "supplier": supplier},
                    update
                )
                
                # Sync to main products
                if data.clear_sale:
                    db.products.update_one(
                        {"sku": sku},
                        {
                            "$set": {"sale_active": False},
                            "$unset": {"was_price": "", "now_price": "", "discount_percentage": ""}
                        }
                    )
                else:
                    db.products.update_one(
                        {"sku": sku},
                        {"$set": {
                            "was_price": was_price,
                            "now_price": now_price,
                            "discount_percentage": data.discount_percentage,
                            "sale_active": data.sale_active
                        }}
                    )
                
                updated_count += 1
                
            except Exception as e:
                errors.append(f"Error updating {sku}: {str(e)}")
        
        logger.info(f"Bulk sale pricing update: {updated_count}/{len(data.product_ids)} products")
        
        return {
            "success": True,
            "message": f"Updated sale pricing for {updated_count} products",
            "updated_count": updated_count,
            "total_requested": len(data.product_ids),
            "results": results[:10] if results else None,  # Return first 10 for preview
            "errors": errors if errors else None
        }
    except Exception as e:
        logger.error(f"Error in bulk sale pricing: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/products/with-labels")
def get_products_with_labels(
    supplier: Optional[str] = None,
    label: Optional[str] = None,
    sale_only: bool = False,
    limit: int = 100
):
    """Get products that have labels or are on sale"""
    try:
        db = get_db()
        
        query = {}
        supplier = normalise_filter_value(supplier)
        if supplier:
            query["supplier"] = supplier
        
        if label:
            query["$or"] = [
                {"labels": label},
                {"custom_labels": label}
            ]
        elif sale_only:
            query["sale_active"] = True
        else:
            # Get products that have any labels
            query["$or"] = [
                {"labels": {"$exists": True, "$ne": []}},
                {"custom_labels": {"$exists": True, "$ne": []}},
                {"sale_active": True}
            ]
        
        products = list(db.supplier_products.find(
            query,
            {"_id": 0}
        ).limit(limit))
        
        return {
            "products": products,
            "count": len(products)
        }
    except Exception as e:
        logger.error(f"Error getting products with labels: {e}")
        raise HTTPException(status_code=500, detail=str(e))




@router.get("/categories")
def get_all_categories():
    """
    Get all unique categories from both supplier_products and products collections.
    Returns a sorted list of category names for autocomplete/dropdown.
    """
    try:
        db = get_db()
        
        # Get unique categories from supplier_products
        supplier_cats = db.supplier_products.distinct("category")
        
        # Get unique categories from products
        product_cats = db.products.distinct("category")
        
        # Get categories from dedicated categories collection
        stored_cats = [c["name"] for c in db.categories.find({}, {"name": 1, "_id": 0})]
        
        # Combine and dedupe
        all_cats = set()
        for cat in supplier_cats + product_cats + stored_cats:
            if cat and isinstance(cat, str) and cat.strip():
                all_cats.add(cat.strip())
        
        # Sort alphabetically
        sorted_cats = sorted(list(all_cats))
        
        return {
            "success": True,
            "categories": sorted_cats,
            "count": len(sorted_cats)
        }
        
    except Exception as e:
        logger.error(f"Error fetching categories: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/categories/detailed")
def get_categories_detailed():
    """
    Get detailed category information including product counts.
    Used by the Manage Categories page.
    """
    try:
        db = get_db()
        
        # Get all unique categories
        supplier_cats = db.supplier_products.distinct("category")
        product_cats = db.products.distinct("category")
        stored_cats_docs = list(db.categories.find({}, {"_id": 0}))
        stored_cats_map = {c["name"]: c for c in stored_cats_docs}
        
        # Combine all unique category names
        all_cat_names = set()
        for cat in supplier_cats + product_cats + list(stored_cats_map.keys()):
            if cat and isinstance(cat, str) and cat.strip():
                all_cat_names.add(cat.strip())
        
        # Build detailed category list with counts
        categories = []
        for cat_name in sorted(all_cat_names):
            # Count products in each collection
            supplier_count = db.supplier_products.count_documents({"category": cat_name})
            products_count = db.products.count_documents({"category": cat_name})
            
            # Get metadata from stored category if exists
            stored_data = stored_cats_map.get(cat_name, {})
            
            categories.append({
                "name": cat_name,
                "supplier_products_count": supplier_count,
                "products_count": products_count,
                "total_count": supplier_count + products_count,
                "source": stored_data.get("source", "auto"),
                "created_at": stored_data.get("created_at"),
                "show_on_website": stored_data.get("show_on_website", True),
                "display_order": stored_data.get("display_order", 999)
            })
        
        # Sort by display_order then name (handle None and invalid values)
        def safe_sort_key(x):
            order = x.get("display_order", 0)
            # Handle None, lists, or other non-numeric values
            if order is None or not isinstance(order, (int, float)):
                order = 999
            name = x.get("name", "") or ""
            return (order, name)
        
        categories.sort(key=safe_sort_key)
        
        return {
            "success": True,
            "categories": categories,
            "count": len(categories)
        }
        
    except Exception as e:
        logger.error(f"Error fetching detailed categories: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/categories")
def create_category(data: dict):
    """
    Create a new category.
    """
    try:
        db = get_db()
        
        name = data.get("name", "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="Category name is required")
        
        # Check if already exists
        existing = db.categories.find_one({"name": name})
        if existing:
            raise HTTPException(status_code=400, detail=f"Category '{name}' already exists")
        
        # Create the category
        category_doc = {
            "name": name,
            "show_on_website": data.get("show_on_website", True),
            "display_order": data.get("display_order", 999),
            "source": "manual",
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc)
        }
        
        db.categories.insert_one(category_doc)
        
        logger.info(f"Created category: {name}")
        
        return {
            "success": True,
            "message": f"Category '{name}' created",
            "category": {
                "name": name,
                "show_on_website": category_doc["show_on_website"],
                "display_order": category_doc["display_order"]
            }
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating category: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/categories/{category_name}")
def update_category(category_name: str, data: dict):
    """
    Update a category - can rename, change visibility, or update display order.
    Also updates all products using this category.
    """
    try:
        db = get_db()
        
        new_name = data.get("name", "").strip()
        show_on_website = data.get("show_on_website")
        display_order = data.get("display_order")
        
        # Build update for categories collection
        category_update = {"updated_at": datetime.now(timezone.utc)}
        if new_name and new_name != category_name:
            # Check if new name already exists
            if db.categories.find_one({"name": new_name}):
                raise HTTPException(status_code=400, detail=f"Category '{new_name}' already exists")
            category_update["name"] = new_name
        if show_on_website is not None:
            category_update["show_on_website"] = show_on_website
        if display_order is not None:
            category_update["display_order"] = display_order
        
        # Update or create in categories collection
        db.categories.update_one(
            {"name": category_name},
            {"$set": category_update},
            upsert=True
        )
        
        # If renaming, update all products
        products_updated = 0
        supplier_products_updated = 0
        
        if new_name and new_name != category_name:
            # Update supplier_products
            result1 = db.supplier_products.update_many(
                {"category": category_name},
                {"$set": {"category": new_name}}
            )
            supplier_products_updated = result1.modified_count
            
            # Update products
            result2 = db.products.update_many(
                {"category": category_name},
                {"$set": {"category": new_name}}
            )
            products_updated = result2.modified_count
            
            # Delete old category entry if it exists
            db.categories.delete_one({"name": category_name})
        
        final_name = new_name if new_name else category_name
        logger.info(f"Updated category '{category_name}' -> '{final_name}', products updated: {products_updated + supplier_products_updated}")
        
        return {
            "success": True,
            "message": "Category updated",
            "old_name": category_name,
            "new_name": final_name,
            "supplier_products_updated": supplier_products_updated,
            "products_updated": products_updated
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating category: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/categories/{category_name}")
def delete_category(category_name: str, replacement: str = None):
    """
    Delete a category. Optionally replace it with another category on all products.
    If no replacement is provided, the category field is cleared on affected products.
    """
    try:
        db = get_db()
        
        # Count affected products
        supplier_count = db.supplier_products.count_documents({"category": category_name})
        products_count = db.products.count_documents({"category": category_name})
        
        if replacement and replacement.strip():
            replacement = replacement.strip()
            # Replace category on all products
            db.supplier_products.update_many(
                {"category": category_name},
                {"$set": {"category": replacement}}
            )
            db.products.update_many(
                {"category": category_name},
                {"$set": {"category": replacement}}
            )
            action = f"replaced with '{replacement}'"
        else:
            # Clear category on all products
            db.supplier_products.update_many(
                {"category": category_name},
                {"$set": {"category": ""}}
            )
            db.products.update_many(
                {"category": category_name},
                {"$set": {"category": ""}}
            )
            action = "cleared"
        
        # Delete from categories collection
        db.categories.delete_one({"name": category_name})
        
        logger.info(f"Deleted category '{category_name}', {supplier_count + products_count} products {action}")
        
        return {
            "success": True,
            "message": f"Category '{category_name}' deleted",
            "supplier_products_affected": supplier_count,
            "products_affected": products_count,
            "action": action
        }
        
    except Exception as e:
        logger.error(f"Error deleting category: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/categories/merge")
def merge_categories(data: dict):
    """
    Merge multiple categories into one.
    """
    try:
        db = get_db()
        
        source_categories = data.get("sources", [])
        target_category = data.get("target", "").strip()
        
        if not source_categories or not target_category:
            raise HTTPException(status_code=400, detail="Sources and target are required")
        
        total_supplier_updated = 0
        total_products_updated = 0
        
        for source in source_categories:
            if source == target_category:
                continue
                
            # Update supplier_products
            result1 = db.supplier_products.update_many(
                {"category": source},
                {"$set": {"category": target_category}}
            )
            total_supplier_updated += result1.modified_count
            
            # Update products
            result2 = db.products.update_many(
                {"category": source},
                {"$set": {"category": target_category}}
            )
            total_products_updated += result2.modified_count
            
            # Delete source category
            db.categories.delete_one({"name": source})
        
        # Ensure target category exists in categories collection
        db.categories.update_one(
            {"name": target_category},
            {
                "$set": {"name": target_category, "updated_at": datetime.now(timezone.utc)},
                "$setOnInsert": {"created_at": datetime.now(timezone.utc), "source": "merge"}
            },
            upsert=True
        )
        
        logger.info(f"Merged {len(source_categories)} categories into '{target_category}'")
        
        return {
            "success": True,
            "message": f"Merged {len(source_categories)} categories into '{target_category}'",
            "supplier_products_updated": total_supplier_updated,
            "products_updated": total_products_updated
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error merging categories: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/products/{sku}")
def delete_supplier_product(sku: str, supplier: str = "Verona"):
    """
    Delete a supplier product by sku or supplier_code.
    Also removes from tiles (storefront) and products collections.
    """
    try:
        db = get_db()
        
        result = db.supplier_products.delete_one({
            "supplier": supplier,
            "sku": sku
        })
        
        if result.deleted_count == 0:
            result = db.supplier_products.delete_one({
                "supplier": supplier,
                "supplier_code": sku
            })
        
        if result.deleted_count == 0:
            raise HTTPException(status_code=404, detail="Product not found")
        
        # Also remove from tiles (storefront) and products collections
        tiles_deleted = db.tiles.delete_many({"sku": sku}).deleted_count
        products_deleted = db.products.delete_many({"sku": sku}).deleted_count
        
        msg = "Product deleted"
        if tiles_deleted > 0:
            msg += f" (also removed from storefront)"
        
        return {"success": True, "message": msg, "tiles_deleted": tiles_deleted, "products_deleted": products_deleted}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting product: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/products/bulk/{supplier}")
def bulk_delete_supplier_products(supplier: str, confirm: bool = False):
    """
    Bulk delete ALL products for a specific supplier.
    Requires confirm=true query parameter for safety.
    """
    try:
        if not confirm:
            db = get_db()
            count = db.supplier_products.count_documents({"supplier": supplier})
            return {
                "success": False,
                "message": f"This will delete {count} products for {supplier}. Add ?confirm=true to proceed.",
                "count": count
            }
        
        db = get_db()
        
        # Get count before deletion
        count_before = db.supplier_products.count_documents({"supplier": supplier})
        
        if count_before == 0:
            return {
                "success": True,
                "message": f"No products found for {supplier}",
                "deleted": 0
            }
        
        # Delete all products for this supplier
        result = db.supplier_products.delete_many({"supplier": supplier})
        
        # Also remove from tiles and products collections
        tiles_deleted = db.tiles.delete_many({"supplier": supplier}).deleted_count
        products_deleted = db.products.delete_many({"supplier": supplier}).deleted_count
        
        # Log the deletion
        db.sync_logs.insert_one({
            "supplier": supplier,
            "source": "bulk_delete",
            "timestamp": datetime.now(timezone.utc),
            "action": "bulk_delete",
            "deleted_count": result.deleted_count,
            "tiles_deleted": tiles_deleted,
            "products_deleted": products_deleted
        })
        
        return {
            "success": True,
            "message": f"Deleted {result.deleted_count} products for {supplier} (also removed {tiles_deleted} from storefront)",
            "deleted": result.deleted_count,
            "tiles_deleted": tiles_deleted
        }
        
    except Exception as e:
        logger.error(f"Bulk delete error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/products/bulk-delete")
def bulk_delete_by_filter(data: dict):
    """
    Bulk delete products by custom filter.
    Expects: {"supplier": "Verona", "filter": {...}, "confirm": true}
    """
    try:
        supplier = normalise_filter_value(data.get("supplier"))
        custom_filter = data.get("filter", {})
        confirm = data.get("confirm", False)
        
        if not supplier:
            raise HTTPException(status_code=400, detail="Supplier name required")
        
        db = get_db()
        
        # Build the delete filter
        delete_filter = {"supplier": supplier}
        delete_filter.update(custom_filter)
        
        if not confirm:
            count = db.supplier_products.count_documents(delete_filter)
            return {
                "success": False,
                "message": f"This will delete {count} products. Set confirm=true to proceed.",
                "count": count,
                "filter_used": delete_filter
            }
        
        # Get SKUs before deleting for cascade
        products_to_delete = list(db.supplier_products.find(delete_filter, {"sku": 1}))
        skus_to_delete = [p["sku"] for p in products_to_delete if p.get("sku")]
        
        result = db.supplier_products.delete_many(delete_filter)
        
        # Cascade delete to tiles and products
        tiles_deleted = 0
        products_deleted = 0
        if skus_to_delete:
            tiles_deleted = db.tiles.delete_many({"sku": {"$in": skus_to_delete}}).deleted_count
            products_deleted = db.products.delete_many({"sku": {"$in": skus_to_delete}}).deleted_count
        
        # Log the deletion
        db.sync_logs.insert_one({
            "supplier": supplier,
            "source": "filtered_bulk_delete",
            "timestamp": datetime.now(timezone.utc),
            "action": "filtered_bulk_delete",
            "filter_used": custom_filter,
            "deleted_count": result.deleted_count,
            "tiles_deleted": tiles_deleted
        })
        
        return {
            "success": True,
            "message": f"Deleted {result.deleted_count} products (also removed {tiles_deleted} from storefront)",
            "deleted": result.deleted_count,
            "tiles_deleted": tiles_deleted
        }
        
    except Exception as e:
        logger.error(f"Bulk delete by filter error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/cleanup-duplicates")
def cleanup_duplicate_products(data: dict):
    """
    Find and remove duplicate products for a supplier based on name.
    Keeps the product with the lowest SKU (alphabetically).
    Expects: {"supplier": "Verona", "confirm": true}
    """
    try:
        supplier = normalise_filter_value(data.get("supplier"))
        confirm = data.get("confirm", False)
        
        if not supplier:
            raise HTTPException(status_code=400, detail="Supplier name required")
        
        db = get_db()
        
        # Find duplicates by name
        dup_pipeline = [
            {'$match': {'supplier': supplier}},
            {'$group': {'_id': '$name', 'count': {'$sum': 1}, 'skus': {'$push': '$sku'}}},
            {'$match': {'count': {'$gt': 1}}},
            {'$sort': {'count': -1}}
        ]
        duplicates = list(db.supplier_products.aggregate(dup_pipeline))
        
        if not confirm:
            # Preview mode - show what would be deleted
            to_delete = []
            for d in duplicates:
                products = list(db.supplier_products.find(
                    {'supplier': supplier, 'name': d['_id']},
                    {'_id': 0, 'sku': 1, 'cost_price': 1}
                ))
                prices = [p.get('cost_price') for p in products]
                unique_prices = set(p for p in prices if p is not None)
                
                # Only mark as duplicate if prices are the same
                if len(unique_prices) <= 1:
                    sorted_skus = sorted(d['skus'])
                    to_delete.extend(sorted_skus[1:])  # Keep first, delete rest
            
            return {
                "success": False,
                "message": f"Found {len(to_delete)} duplicate products to delete. Set confirm=true to proceed.",
                "duplicate_groups": len(duplicates),
                "to_delete_count": len(to_delete),
                "to_delete_skus": to_delete[:20]  # Show first 20
            }
        
        # Actual cleanup
        deleted_count = 0
        for d in duplicates:
            products = list(db.supplier_products.find(
                {'supplier': supplier, 'name': d['_id']},
                {'_id': 1, 'sku': 1, 'cost_price': 1}
            ))
            prices = [p.get('cost_price') for p in products]
            unique_prices = set(p for p in prices if p is not None)
            
            if len(unique_prices) <= 1:
                # Sort by SKU and keep the first one
                products_sorted = sorted(products, key=lambda x: x.get('sku', ''))
                for p in products_sorted[1:]:
                    result = db.supplier_products.delete_one({'_id': p['_id']})
                    if result.deleted_count:
                        deleted_count += 1
        
        return {
            "success": True,
            "message": f"Cleaned up {deleted_count} duplicate products for {supplier}",
            "deleted": deleted_count
        }
        
    except Exception as e:
        logger.error(f"Cleanup duplicates error: {e}")
        raise HTTPException(status_code=500, detail=str(e))




class ExcelProduct(BaseModel):
    code: str
    name: str
    category: Optional[str] = None
    description: Optional[str] = None
    material: Optional[str] = None
    finish: Optional[str] = None
    length_mm: Optional[float] = None
    width_mm: Optional[float] = None
    price: Optional[float] = None


class ExcelImportRequest(BaseModel):
    products: List[ExcelProduct]
    supplier: str = "Verona"


@router.post("/verona/import-excel")
async def import_verona_excel(file: UploadFile = File(...)):
    """
    Import Verona products from Excel file
    """
    # Redirect to generic import
    return await import_excel_generic(file, "Verona")


@router.post("/import-excel")
async def import_excel_generic(file: UploadFile = File(...), supplier: str = "General"):
    """
    Import products from Excel/CSV file for any supplier.
    Supports flexible column mapping and CSV files.
    """
    try:
        import pandas as pd
        
        # Determine file type from extension
        is_csv = file.filename.lower().endswith('.csv')
        suffix = '.csv' if is_csv else '.xlsx'
        
        # Save uploaded file temporarily
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            content = await file.read()
            tmp.write(content)
            tmp_path = tmp.name
        
        # Read file
        if is_csv:
            df = pd.read_csv(tmp_path)
        else:
            # Try to read with headers first
            try:
                df = pd.read_excel(tmp_path)
                # Check if first row looks like headers
                if 'sku' in str(df.columns).lower() or 'code' in str(df.columns).lower() or 'name' in str(df.columns).lower():
                    pass  # Headers found
                else:
                    df = pd.read_excel(tmp_path, header=None)
            except:
                df = pd.read_excel(tmp_path, header=None)
        
        os.unlink(tmp_path)  # Clean up temp file
        
        products = []
        
        # Try to detect column mapping
        columns = [str(c).lower().strip() for c in df.columns]
        
        # Column name variants for detection
        sku_variants = ['sku', 'code', 'product code', 'item code', 'productcode', 'item_code']
        name_variants = ['name', 'product name', 'description', 'title', 'product_name', 'productname']
        supplier_name_variants = ['supplier name', 'supplier product name', 'original name', 'supplier_name']
        price_variants = ['price', 'trade price', 'cost', 'trade_price', 'unit price', 'unitprice']
        category_variants = ['category', 'cat', 'type', 'product type']
        stock_variants = ['stock', 'qty', 'quantity', 'stock_quantity', 'stock quantity', 'in stock']
        
        def find_column(variants):
            for v in variants:
                if v in columns:
                    return columns.index(v)
            return None
        
        sku_col = find_column(sku_variants)
        name_col = find_column(name_variants)
        supplier_name_col = find_column(supplier_name_variants)
        price_col = find_column(price_variants)
        category_col = find_column(category_variants)
        stock_col = find_column(stock_variants)
        
        # If no headers detected, use positional mapping
        if sku_col is None and name_col is None:
            # Assume: Code, Name, Category, Price...
            sku_col = 0
            name_col = 1
            category_col = 2 if len(df.columns) > 2 else None
            price_col = 3 if len(df.columns) > 3 else None
        
        for idx, row in df.iterrows():
            if idx == 0 and isinstance(df.columns[0], int):
                # Skip if first row looks like headers
                first_val = str(row.iloc[0]).lower() if pd.notna(row.iloc[0]) else ''
                if any(v in first_val for v in ['code', 'sku', 'name']):
                    continue
            
            sku = str(row.iloc[sku_col]).strip() if sku_col is not None and pd.notna(row.iloc[sku_col]) else ''
            name = str(row.iloc[name_col]).strip() if name_col is not None and pd.notna(row.iloc[name_col]) else ''
            
            if not sku or sku.lower() in ['nan', 'none', '']:
                continue
            
            product = {
                'sku': sku,
                'name': name or sku,  # Use SKU as name if no name provided
                'product_name': name or sku,
            }
            
            if supplier_name_col is not None and pd.notna(row.iloc[supplier_name_col]):
                product['name'] = str(row.iloc[supplier_name_col]).strip()
                product['product_name'] = name  # Keep the unique name separate
            
            if category_col is not None and pd.notna(row.iloc[category_col]):
                product['category'] = str(row.iloc[category_col]).strip()
            
            if price_col is not None and pd.notna(row.iloc[price_col]):
                try:
                    price_val = str(row.iloc[price_col]).replace('£', '').replace(',', '').strip()
                    product['price'] = float(price_val)
                except:
                    pass
            
            if stock_col is not None and pd.notna(row.iloc[stock_col]):
                try:
                    product['stock_quantity'] = int(float(row.iloc[stock_col]))
                    product['in_stock'] = product['stock_quantity'] > 0
                except:
                    pass
            
            products.append(product)
        
        # Import to database
        db = get_db()
        synced = 0
        updated = 0
        new = 0
        errors = 0
        
        # Import naming function
        from business_config.business_rules import get_display_name
        
        for product in products:
            try:
                raw_name = product.get('name', '')
                finish = product.get('finish', '')
                
                # Generate transformed product name using naming logic
                transformed_name = get_display_name(raw_name, supplier, finish)
                
                product_data = {
                    "supplier": supplier,
                    "sku": product['sku'],
                    "name": raw_name,
                    "product_name": transformed_name,  # Use transformed name
                    "category": product.get('category', ''),
                    "trade_price": product.get('price'),
                    "stock_quantity": product.get('stock_quantity'),
                    "in_stock": product.get('in_stock'),
                    "synced_at": datetime.now(timezone.utc),
                    "sync_source": "excel_import"
                }
                
                result = db.supplier_products.update_one(
                    {"supplier": supplier, "sku": product['sku']},
                    {
                        "$set": product_data,
                        "$setOnInsert": {"created_at": datetime.now(timezone.utc)}
                    },
                    upsert=True
                )
                
                synced += 1
                if result.upserted_id:
                    new += 1
                elif result.modified_count > 0:
                    updated += 1
                    
            except Exception as e:
                logger.error(f"Error importing product {product.get('sku')}: {e}")
                errors += 1
        
        # Log the import
        db.sync_logs.insert_one({
            "supplier": supplier,
            "source": "excel_import",
            "filename": file.filename,
            "timestamp": datetime.now(timezone.utc),
            "products_received": len(products),
            "synced": synced,
            "updated": updated,
            "new": new,
            "errors": errors
        })
        
        return {
            "success": True,
            "total_parsed": len(products),
            "synced": synced,
            "new": new,
            "updated": updated,
            "errors": errors,
            "message": f"Successfully imported {synced} products ({new} new, {updated} updated)"
        }
        
    except Exception as e:
        logger.error(f"Excel import error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/verona/import-json")
def import_verona_json(data: ExcelImportRequest):
    """
    Import Verona products from JSON (pre-parsed Excel data)
    """
    try:
        db = get_db()
        from business_config.business_rules import get_display_name
        
        synced = 0
        updated = 0
        new = 0
        errors = 0
        
        for product in data.products:
            try:
                # Generate transformed product name
                raw_name = product.name
                finish = product.finish if hasattr(product, 'finish') else None
                transformed_name = get_display_name(raw_name, data.supplier, finish)
                
                product_data = {
                    "supplier": data.supplier,
                    "sku": product.code,
                    "name": raw_name,
                    "product_name": transformed_name,  # Use transformed name
                    "category": product.category,
                    "description": product.description,
                    "material": product.material,
                    "finish": product.finish,
                    "length_mm": product.length_mm,
                    "width_mm": product.width_mm,
                    "trade_price": product.price,
                    "synced_at": datetime.now(timezone.utc),
                    "sync_source": "json_import"
                }
                
                result = db.supplier_products.update_one(
                    {"supplier": data.supplier, "sku": product.code},
                    {
                        "$set": product_data,
                        "$setOnInsert": {"created_at": datetime.now(timezone.utc)}
                    },
                    upsert=True
                )
                
                if result.upserted_id:
                    new += 1
                elif result.modified_count > 0:
                    updated += 1
                
                synced += 1
                
            except Exception as e:
                logger.error(f"Error importing product {product.code}: {e}")
                errors += 1
        
        return {
            "success": True,
            "synced": synced,
            "new": new,
            "updated": updated,
            "errors": errors,
            "message": f"Successfully imported {synced} products ({new} new, {updated} updated)"
        }
        
    except Exception as e:
        logger.error(f"JSON import error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# SKU Prefix to Supplier mapping
SKU_SUPPLIER_MAP = {
    'TIL': 'Tile Rite',
    'TRI': 'Trimline',
    'ULT': 'Ultra Tile',
    'VER': 'Verona',
    'SPL': 'Splendour',
    'WAL': 'Wallcano',
    'CER': 'Ceramica Impex',
    'LP': 'Le Porce',
    'HM': 'H Martin',
    'BS': 'Bloomstone',
    'BY': 'Boyden',
    'RG': 'Regulus',
    'EG': 'Eagle',
    'TB': 'Tilebase'
}


@router.post("/sync-from-products")
def sync_from_products_collection(data: dict = None):
    """
    Sync products from main products collection to supplier_products based on SKU prefix.
    Maps TIL-* to Tile Rite, TRI-* to Trimline, ULT-* to Ultra Tile, etc.
    
    Optional body: {"suppliers": ["Tile Rite", "Trimline"]} to sync specific suppliers only
    """
    try:
        db = get_db()
        
        # Get optional supplier filter
        target_suppliers = data.get("suppliers", []) if data else []
        
        synced = 0
        new = 0
        updated = 0
        errors = 0
        supplier_counts = {}
        
        # Build regex patterns for target suppliers
        if target_suppliers:
            active_prefixes = {k: v for k, v in SKU_SUPPLIER_MAP.items() if v in target_suppliers}
        else:
            active_prefixes = SKU_SUPPLIER_MAP
        
        if not active_prefixes:
            return {"success": False, "message": "No valid suppliers specified"}
        
        # Build OR query for all prefixes
        prefix_queries = []
        for prefix in active_prefixes.keys():
            prefix_queries.append({'sku': {'$regex': f'^{prefix}', '$options': 'i'}})
        
        if not prefix_queries:
            return {"success": True, "message": "No matching products found", "synced": 0}
        
        # Find all products matching any prefix
        products = list(db.products.find({'$or': prefix_queries}))
        
        for product in products:
            try:
                sku = product.get('sku', '')
                supplier = None
                
                # Determine supplier from SKU prefix
                for prefix, sup_name in active_prefixes.items():
                    if sku.upper().startswith(prefix):
                        supplier = sup_name
                        break
                
                if not supplier:
                    continue
                
                # Map product fields to supplier_products format
                # Generate transformed product name
                from business_config.business_rules import get_display_name
                raw_name = product.get('name', '')
                finish = product.get('finish', '')
                transformed_name = get_display_name(raw_name, supplier, finish)
                
                product_data = {
                    "supplier": supplier,
                    "sku": sku,
                    "name": raw_name,
                    "product_name": transformed_name,  # Use transformed name
                    "category": product.get('category_name'),
                    "description": product.get('description'),
                    "material": product.get('material'),
                    "finish": finish,
                    "size": (f"{product.get('tile_width')}x{product.get('tile_height')}" 
                            if product.get('tile_width') and product.get('tile_height') 
                            else None),
                    "cost_price": product.get('cost'),
                    "price": product.get('price'),
                    "trade_price": product.get('cost'),
                    "stock_quantity": product.get('stock', 0),
                    "stock_m2": product.get('m2_quantity', 0),
                    "in_stock": (product.get('stock', 0) or 0) > 0,
                    "images": product.get('images', []),
                    "source_product_id": product.get('id'),
                    "synced_at": datetime.now(timezone.utc),
                    "sync_source": "products_collection"
                }
                
                # Remove None values
                product_data = {k: v for k, v in product_data.items() if v is not None}
                
                result = db.supplier_products.update_one(
                    {"supplier": supplier, "sku": sku},
                    {
                        "$set": product_data,
                        "$setOnInsert": {"created_at": datetime.now(timezone.utc)}
                    },
                    upsert=True
                )
                
                if result.upserted_id:
                    new += 1
                elif result.modified_count > 0:
                    updated += 1
                
                synced += 1
                supplier_counts[supplier] = supplier_counts.get(supplier, 0) + 1
                
            except Exception as e:
                logger.error(f"Error syncing product {product.get('sku')}: {e}")
                errors += 1
        
        # Log the sync
        db.sync_logs.insert_one({
            "source": "products_collection_sync",
            "timestamp": datetime.now(timezone.utc),
            "action": "sync_from_products",
            "synced": synced,
            "new": new,
            "updated": updated,
            "errors": errors,
            "supplier_counts": supplier_counts
        })
        
        return {
            "success": True,
            "synced": synced,
            "new": new,
            "updated": updated,
            "errors": errors,
            "supplier_counts": supplier_counts,
            "message": f"Synced {synced} products ({new} new, {updated} updated)"
        }
        
    except Exception as e:
        logger.error(f"Sync from products error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/bulk-delete-selected")
def bulk_delete_selected_products(data: dict):
    """
    Delete multiple selected products by their SKUs.
    Super Admin only - verified by frontend.
    Expects: {"skus": ["SKU1", "SKU2", ...], "supplier": "optional"}
    """
    try:
        db = get_db()
        
        skus = data.get("skus", [])
        supplier = normalise_filter_value(data.get("supplier"))
        
        if not skus:
            raise HTTPException(status_code=400, detail="No SKUs provided")
        
        if len(skus) > 500:
            raise HTTPException(status_code=400, detail="Cannot delete more than 500 products at once")
        
        # Build delete filter
        delete_filter = {"sku": {"$in": skus}}
        if supplier:
            delete_filter["supplier"] = supplier
        
        # Get count before deletion for logging
        count_before = db.supplier_products.count_documents(delete_filter)
        
        if count_before == 0:
            return {
                "success": True,
                "message": "No matching products found",
                "deleted": 0
            }
        
        # Delete the products
        result = db.supplier_products.delete_many(delete_filter)
        
        # Also remove from tiles and products collections
        tiles_filter = {"sku": {"$in": skus}}
        tiles_deleted = db.tiles.delete_many(tiles_filter).deleted_count
        products_deleted = db.products.delete_many(tiles_filter).deleted_count
        
        # Log the deletion
        db.sync_logs.insert_one({
            "source": "bulk_delete_selected",
            "timestamp": datetime.now(timezone.utc),
            "action": "bulk_delete_selected",
            "skus_requested": len(skus),
            "deleted_count": result.deleted_count,
            "tiles_deleted": tiles_deleted,
            "products_deleted": products_deleted,
            "supplier_filter": supplier
        })
        
        return {
            "success": True,
            "message": f"Deleted {result.deleted_count} products (also removed {tiles_deleted} from storefront)",
            "deleted": result.deleted_count,
            "tiles_deleted": tiles_deleted,
            "requested": len(skus)
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Bulk delete selected error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/sync-from-products/preview")
def preview_sync_from_products():
    """
    Preview what products would be synced from main products collection.
    Returns counts by supplier prefix.
    """
    try:
        db = get_db()
        
        preview = {}
        total = 0
        
        for prefix, supplier in SKU_SUPPLIER_MAP.items():
            count = db.products.count_documents({'sku': {'$regex': f'^{prefix}', '$options': 'i'}})
            if count > 0:
                preview[supplier] = {
                    "prefix": prefix,
                    "count": count
                }
                total += count
        
        # Also check what's already in supplier_products
        existing = {}
        for supplier in preview.keys():
            existing[supplier] = db.supplier_products.count_documents({"supplier": supplier})
        
        return {
            "to_sync": preview,
            "total_products": total,
            "existing_in_supplier_products": existing,
            "sku_prefix_mapping": SKU_SUPPLIER_MAP
        }
        
    except Exception as e:
        logger.error(f"Preview sync error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/products/toggle-always-in-stock")
def toggle_always_in_stock(data: dict):
    """
    Toggle the 'always_in_stock' flag for a supplier product.
    When enabled, the product will always show as "In Stock" on the website.
    Expects: {"sku": "TIL-123", "supplier": "Tile Rite", "always_in_stock": true}
    """
    try:
        db = get_db()
        
        sku = data.get("sku")
        supplier = normalise_filter_value(data.get("supplier"))
        always_in_stock = data.get("always_in_stock", False)
        
        if not sku:
            raise HTTPException(status_code=400, detail="SKU is required")
        
        # Build filter
        filter_query = {"sku": sku}
        if supplier:
            filter_query["supplier"] = supplier
        
        # Update the product
        sp_set = {"always_in_stock": always_in_stock, "updated_at": datetime.now(timezone.utc)}
        if always_in_stock:
            sp_set["in_stock"] = True
            sp_set["stock_status"] = "in_stock"
        result = db.supplier_products.update_one(
            filter_query,
            {"$set": sp_set}
        )
        
        if result.matched_count == 0:
            raise HTTPException(status_code=404, detail="Product not found")
        
        if result.matched_count == 0:
            raise HTTPException(status_code=404, detail="Product not found")

        # Mirror to the tiles collection so the storefront PDP reflects it
        try:
            tile_set = {"always_in_stock": always_in_stock, "stock_overridden_at": datetime.now(timezone.utc)}
            if always_in_stock:
                tile_set["in_stock"] = True
                tile_set["stock_status"] = "in_stock"
            db.tiles.update_one({"sku": sku}, {"$set": tile_set})
        except Exception as e:
            logger.warning(f"Failed to mirror always_in_stock to tiles for {sku}: {e}")

        # Bust the collection endpoint cache so the change shows immediately
        try:
            from utils.endpoint_cache import endpoint_cache
            endpoint_cache.invalidate()
        except Exception:
            pass

        return {
            "success": True,
            "sku": sku,
            "always_in_stock": always_in_stock,
            "message": f"Product {'will always show as In Stock' if always_in_stock else 'will show actual stock status'}"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Toggle always in stock error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/products/set-stock-status")
def set_stock_status(data: dict):
    """
    Set stock status for a supplier product (In Stock / Low Stock / Out of Stock).
    Expects: {"sku": "LP-1234", "supplier": "LEPORCE", "stock_status": "low_stock", "in_stock": true}
    Valid stock_status values: "in_stock", "low_stock", "out_of_stock"
    """
    try:
        db = get_db()
        
        sku = data.get("sku")
        supplier = normalise_filter_value(data.get("supplier"))
        stock_status = data.get("stock_status", "in_stock")
        in_stock = data.get("in_stock", True)
        
        if not sku:
            raise HTTPException(status_code=400, detail="SKU is required")
        
        if stock_status not in ["in_stock", "low_stock", "out_of_stock"]:
            raise HTTPException(status_code=400, detail="Invalid stock_status. Must be: in_stock, low_stock, or out_of_stock")
        
        # Build filter
        filter_query = {"sku": sku}
        if supplier:
            filter_query["supplier"] = supplier
        
        # Update the product
        result = db.supplier_products.update_one(
            filter_query,
            {
                "$set": {
                    "stock_status": stock_status,
                    "in_stock": in_stock,
                    "updated_at": datetime.now(timezone.utc)
                }
            }
        )
        
        if result.matched_count == 0:
            raise HTTPException(status_code=404, detail="Product not found")
        
        # 14 May 2026 — mirror the change to the `tiles` collection so the
        # PDP reflects the new status. Admin reported setting "Out of
        # Stock" on `supplier_products` had no effect on the PDP because
        # the `tiles` row (where the storefront reads from) still showed
        # `in_stock: true` with a positive `stock` count from the last
        # supplier sync.
        # NOTE: the `tiles` collection often has no `supplier` field
        # (legacy schema), so filter by sku alone — SKUs are unique
        # across the catalogue.
        try:
            db.tiles.update_one(
                {"sku": sku},
                {"$set": {
                    "stock_status": stock_status,
                    "in_stock": in_stock,
                    "stock_overridden_at": datetime.now(timezone.utc),
                }},
            )
        except Exception as e:
            logger.warning(f"Failed to mirror stock_status to tiles for {sku}: {e}")
        
        # Bust the collection endpoint cache so the PDP picks up the
        # change immediately rather than after the 60s TTL.
        try:
            from utils.endpoint_cache import endpoint_cache
            endpoint_cache.invalidate()
        except Exception:
            pass
        
        status_labels = {"in_stock": "In Stock", "low_stock": "Low Stock", "out_of_stock": "Out of Stock"}
        
        return {
            "success": True,
            "sku": sku,
            "stock_status": stock_status,
            "in_stock": in_stock,
            "message": f"Stock status set to {status_labels[stock_status]}"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Set stock status error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/update-product-stock-status")
def update_product_stock_status(data: dict):
    """
    Update stock status for a supplier product by MongoDB _id.
    Used by the image management pages.
    Expects: {"product_id": "...", "stock_status": "in_stock", "in_stock": true}
    Valid stock_status values: "in_stock", "always_in_stock", "out_of_stock", "special_order"
    """
    try:
        from bson import ObjectId
        db = get_db()
        
        product_id = data.get("product_id")
        stock_status = data.get("stock_status", "in_stock")
        in_stock = data.get("in_stock", True)
        
        if not product_id:
            raise HTTPException(status_code=400, detail="Product ID is required")
        
        valid_statuses = ["in_stock", "always_in_stock", "out_of_stock", "special_order", "low_stock"]
        if stock_status not in valid_statuses:
            raise HTTPException(status_code=400, detail=f"Invalid stock_status. Must be one of: {', '.join(valid_statuses)}")
        
        # Try to convert to ObjectId
        try:
            obj_id = ObjectId(product_id)
        except:
            raise HTTPException(status_code=400, detail="Invalid product ID format")
        
        # Update the product
        result = db.supplier_products.update_one(
            {"_id": obj_id},
            {
                "$set": {
                    "stock_status": stock_status,
                    "in_stock": in_stock,
                    "always_in_stock": stock_status == "always_in_stock",
                    "updated_at": datetime.now(timezone.utc)
                }
            }
        )
        
        if result.matched_count == 0:
            raise HTTPException(status_code=404, detail="Product not found")
        
        # 14 May 2026 — mirror to the `tiles` collection (PDP source).
        # Without this, admin's manual override is invisible on the live
        # site because the storefront reads `tiles`, not `supplier_products`.
        # Match by sku alone — `tiles` often lacks the `supplier` field.
        try:
            sp_doc = db.supplier_products.find_one({"_id": obj_id}, {"sku": 1})
            if sp_doc and sp_doc.get("sku"):
                db.tiles.update_one(
                    {"sku": sp_doc["sku"]},
                    {"$set": {
                        "stock_status": stock_status,
                        "in_stock": in_stock,
                        "always_in_stock": stock_status == "always_in_stock",
                        "stock_overridden_at": datetime.now(timezone.utc),
                    }},
                )
        except Exception as e:
            logger.warning(f"Failed to mirror stock_status to tiles by id {product_id}: {e}")
        
        try:
            from utils.endpoint_cache import endpoint_cache
            endpoint_cache.invalidate()
        except Exception:
            pass
        
        return {
            "success": True,
            "product_id": product_id,
            "stock_status": stock_status,
            "in_stock": in_stock,
            "message": f"Stock status updated to {stock_status}"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Update stock status error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


class SetPricesRequest(BaseModel):
    skus: List[str]
    cost_price: Optional[float] = None
    price: Optional[float] = None


@router.post("/products/set-prices")
def set_product_prices(payload: SetPricesRequest):
    """Set cost and/or list price directly for one or many products.
    Mirrors the list price to the storefront (tiles) and EPOS (products)."""
    try:
        skus = [s.strip() for s in payload.skus if s and s.strip()]
        if not skus:
            raise HTTPException(status_code=400, detail="No SKUs provided")
        if payload.cost_price is None and payload.price is None:
            raise HTTPException(status_code=400, detail="Provide cost_price and/or price")
        if (payload.cost_price is not None and payload.cost_price < 0) or (payload.price is not None and payload.price < 0):
            raise HTTPException(status_code=400, detail="Prices cannot be negative")

        db = get_db()
        now = datetime.now(timezone.utc)
        filter_query = {"$or": [{"sku": {"$in": skus}}, {"supplier_code": {"$in": skus}}]}

        sp_set = {"updated_at": now, "price_updated_at": now}
        tile_set = {"updated_at": now}
        prod_set = {"updated_at": now}
        if payload.cost_price is not None:
            sp_set["cost_price"] = payload.cost_price
            tile_set["cost_price"] = payload.cost_price
            prod_set["cost_price"] = payload.cost_price
        if payload.price is not None:
            sp_set["price"] = payload.price
            tile_set["price"] = payload.price
            tile_set["room_lot_price"] = payload.price
            prod_set["price"] = payload.price

        result = db.supplier_products.update_many(filter_query, {"$set": sp_set})
        tiles_result = db.tiles.update_many(filter_query, {"$set": tile_set})
        db.products.update_many(filter_query, {"$set": prod_set})

        try:
            from utils.endpoint_cache import endpoint_cache
            endpoint_cache.invalidate()
        except Exception:
            pass

        return {
            "success": True,
            "updated_count": result.modified_count,
            "matched_count": result.matched_count,
            "tiles_updated": tiles_result.modified_count,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error setting prices: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/products/bulk-set-stock-status")
def bulk_set_stock_status(data: dict):
    """
    Bulk set stock status for multiple products.
    Expects: {"skus": ["SKU1", "SKU2"], "stock_status": "in_stock"}
    Valid stock_status values: "in_stock", "low_stock", "out_of_stock"
    """
    try:
        db = get_db()
        
        skus = data.get("skus", [])
        stock_status = data.get("stock_status", "in_stock")
        
        if not skus:
            raise HTTPException(status_code=400, detail="No SKUs provided")
        
        if stock_status not in ["in_stock", "low_stock", "out_of_stock"]:
            raise HTTPException(status_code=400, detail="Invalid stock_status. Must be: in_stock, low_stock, or out_of_stock")
        
        # Determine in_stock boolean based on status
        in_stock = stock_status in ["in_stock", "low_stock"]
        
        # Build filter — match sku OR supplier_code
        filter_query = {"$or": [{"sku": {"$in": skus}}, {"supplier_code": {"$in": skus}}]}
        
        # Update all matching products (clears any always_in_stock override)
        set_data = {
            "stock_status": stock_status,
            "in_stock": in_stock,
            "always_in_stock": False,
            "updated_at": datetime.now(timezone.utc)
        }
        result = db.supplier_products.update_many(filter_query, {"$set": set_data})

        # Mirror to the tiles collection so the storefront reflects it
        tiles_result = db.tiles.update_many(
            filter_query,
            {"$set": {
                "stock_status": stock_status,
                "in_stock": in_stock,
                "always_in_stock": False,
                "stock_overridden_at": datetime.now(timezone.utc)
            }}
        )

        # Bust the collection endpoint cache so the change shows immediately
        try:
            from utils.endpoint_cache import endpoint_cache
            endpoint_cache.invalidate()
        except Exception:
            pass
        
        status_labels = {"in_stock": "In Stock", "low_stock": "Low Stock", "out_of_stock": "Out of Stock"}
        
        return {
            "success": True,
            "updated_count": result.modified_count,
            "matched_count": result.matched_count,
            "tiles_updated": tiles_result.modified_count,
            "stock_status": stock_status,
            "message": f"Set {result.modified_count} products to {status_labels[stock_status]}"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Bulk set stock status error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/products/bulk-toggle-always-in-stock")
def bulk_toggle_always_in_stock(data: dict):
    """
    Bulk toggle 'always_in_stock' for multiple products.
    Expects: {"skus": ["SKU1", "SKU2"], "supplier": "optional", "always_in_stock": true}
    """
    try:
        db = get_db()
        
        skus = data.get("skus", [])
        supplier = normalise_filter_value(data.get("supplier"))
        always_in_stock = data.get("always_in_stock", False)
        
        if not skus:
            raise HTTPException(status_code=400, detail="No SKUs provided")
        
        # Build filter — match sku OR supplier_code
        filter_query = {"$or": [{"sku": {"$in": skus}}, {"supplier_code": {"$in": skus}}]}
        if supplier:
            filter_query["supplier"] = supplier
        
        # Update all matching products
        sp_set = {"always_in_stock": always_in_stock, "updated_at": datetime.now(timezone.utc)}
        if always_in_stock:
            sp_set["in_stock"] = True
            sp_set["stock_status"] = "in_stock"
        result = db.supplier_products.update_many(filter_query, {"$set": sp_set})

        # Mirror to the tiles collection so the storefront reflects it
        tile_set = {"always_in_stock": always_in_stock, "stock_overridden_at": datetime.now(timezone.utc)}
        if always_in_stock:
            tile_set["in_stock"] = True
            tile_set["stock_status"] = "in_stock"
        tiles_result = db.tiles.update_many(
            {"$or": [{"sku": {"$in": skus}}, {"supplier_code": {"$in": skus}}]},
            {"$set": tile_set}
        )

        # Bust the collection endpoint cache
        try:
            from utils.endpoint_cache import endpoint_cache
            endpoint_cache.invalidate()
        except Exception:
            pass
        
        return {
            "success": True,
            "updated": result.modified_count,
            "tiles_updated": tiles_result.modified_count,
            "always_in_stock": always_in_stock,
            "message": f"Updated {result.modified_count} products"
        }
        
    except Exception as e:
        logger.error(f"Bulk toggle always in stock error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/products/set-visibility")
def set_product_visibility(data: dict):
    """
    Set the visibility/availability of a supplier product.
    Options: 'online' (default), 'in_store_only', 'hidden'
    Expects: {"sku": "TIL-123", "supplier": "Tile Rite", "visibility": "in_store_only"}
    """
    try:
        db = get_db()
        
        sku = data.get("sku")
        supplier = normalise_filter_value(data.get("supplier"))
        visibility = data.get("visibility", "online")
        
        if not sku:
            raise HTTPException(status_code=400, detail="SKU is required")
        
        # Validate visibility option
        valid_options = ['online', 'in_store_only', 'hidden']
        if visibility not in valid_options:
            raise HTTPException(status_code=400, detail=f"Invalid visibility. Must be one of: {valid_options}")
        
        # Build filter
        filter_query = {"sku": sku}
        if supplier:
            filter_query["supplier"] = supplier
        
        # Update the product
        result = db.supplier_products.update_one(
            filter_query,
            {
                "$set": {
                    "visibility": visibility,
                    "updated_at": datetime.now(timezone.utc)
                }
            }
        )
        
        if result.matched_count == 0:
            raise HTTPException(status_code=404, detail="Product not found")
        
        visibility_labels = {
            'online': 'visible on website',
            'in_store_only': 'in-store only (hidden from website)',
            'hidden': 'completely hidden'
        }
        
        return {
            "success": True,
            "sku": sku,
            "visibility": visibility,
            "message": f"Product is now {visibility_labels.get(visibility, visibility)}"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Set visibility error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/products/bulk-set-visibility")
def bulk_set_visibility(data: dict):
    """
    Bulk set visibility for multiple products.
    Expects: {"skus": ["SKU1", "SKU2"], "supplier": "optional", "visibility": "in_store_only"}
    """
    try:
        db = get_db()
        
        skus = data.get("skus", [])
        supplier = normalise_filter_value(data.get("supplier"))
        visibility = data.get("visibility", "online")
        
        if not skus:
            raise HTTPException(status_code=400, detail="No SKUs provided")
        
        valid_options = ['online', 'in_store_only', 'hidden']
        if visibility not in valid_options:
            raise HTTPException(status_code=400, detail=f"Invalid visibility. Must be one of: {valid_options}")
        
        # Build filter
        filter_query = {"sku": {"$in": skus}}
        if supplier:
            filter_query["supplier"] = supplier
        
        # Update all matching products
        result = db.supplier_products.update_many(
            filter_query,
            {
                "$set": {
                    "visibility": visibility,
                    "updated_at": datetime.now(timezone.utc)
                }
            }
        )
        
        return {
            "success": True,
            "updated": result.modified_count,
            "visibility": visibility,
            "message": f"Updated {result.modified_count} products"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Bulk set visibility error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/products/fix-leporce-naming")
def fix_leporce_naming():
    """
    Fix LEPORCE product names to include size information.
    This is an admin utility endpoint to fix the naming logic bug.
    """
    try:
        db = get_db()
        from business_config.business_rules import get_display_name
        
        # Finish keywords for name reconstruction
        FINISH_KEYWORDS = ['matt', 'matte', 'polished', 'gloss', 'glossy', 'satin', 'natural', 'textured']
        
        # Get all LEPORCE products
        products = list(db.supplier_products.find({'supplier': 'LEPORCE'}))
        logger.info(f"Found {len(products)} LEPORCE products to fix")
        
        updates = 0
        size_pattern = re.compile(r'\d+x\d+', re.IGNORECASE)
        
        for p in products:
            current_name = p.get('product_name', '')
            finish = p.get('finish', '')
            size_field = p.get('size', '')
            
            # Apply the fixed get_display_name transformation
            new_name = get_display_name(current_name, 'LEPORCE', finish)
            
            # If size still missing but exists in size field, add it
            if size_field and not size_pattern.search(new_name):
                size_parts = size_field.lower().replace("cm", "").replace("mm", "").split("x")
                if len(size_parts) >= 2:
                    size_normalized = f"{size_parts[0]}x{size_parts[1]}cm"
                    
                    name_parts = new_name.split()
                    final_parts = []
                    finish_added = False
                    
                    for part in name_parts:
                        if part.lower() in FINISH_KEYWORDS:
                            final_parts.append(size_normalized)
                            final_parts.append(part)
                            finish_added = True
                        else:
                            final_parts.append(part)
                    
                    if not finish_added:
                        final_parts.append(size_normalized)
                    
                    new_name = ' '.join(final_parts)
            
            if new_name != current_name:
                result = db.supplier_products.update_one(
                    {'_id': p['_id']},
                    {'$set': {'product_name': new_name, 'updated_at': datetime.now(timezone.utc)}}
                )
                if result.modified_count > 0:
                    updates += 1
        
        # Verify results
        fixed_products = list(db.supplier_products.find({'supplier': 'LEPORCE'}))
        with_size = sum(1 for p in fixed_products if size_pattern.search(p.get('product_name', '')))
        
        return {
            "success": True,
            "total_products": len(products),
            "updated": updates,
            "with_size_now": with_size,
            "message": f"Fixed {updates} product names. {with_size}/{len(products)} now have size in name."
        }
        
    except Exception as e:
        logger.error(f"Fix LEPORCE naming error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/products/add-to-database")
def add_supplier_product_to_database(data: dict):
    """
    Add a supplier product to the main Products database.
    Expects: {"sku": "VVG75300", "supplier": "Verona"}
    """
    try:
        db = get_db()
        
        sku = data.get("sku")
        supplier = normalise_filter_value(data.get("supplier"))
        product_id = data.get("product_id")  # MongoDB _id for robust lookup
        
        # Find the supplier product - try multiple strategies
        supplier_product = None
        
        # Strategy 1: Use _id if provided (most reliable)
        if product_id:
            try:
                from bson import ObjectId
                supplier_product = db.supplier_products.find_one({"_id": ObjectId(product_id)})
                if supplier_product:
                    # Update sku/supplier from the found product
                    sku = supplier_product.get("sku") or supplier_product.get("supplier_code") or sku
                    supplier = supplier_product.get("supplier") or supplier
                    logger.info(f"Found product by _id: {product_id}")
            except Exception as e:
                logger.warning(f"_id lookup failed: {e}")
        
        # Strategy 2: Try sku + supplier
        if not supplier_product and sku:
            filter_query = {"sku": sku}
            if supplier:
                filter_query["supplier"] = supplier
            supplier_product = db.supplier_products.find_one(filter_query)
        
        # Strategy 3: Try supplier_code
        if not supplier_product and sku:
            supplier_product = db.supplier_products.find_one({"supplier_code": sku})
        
        if not supplier_product:
            raise HTTPException(status_code=404, detail="Supplier product not found")
        
        # Use actual sku from the found product (may be null for some suppliers)
        actual_sku = supplier_product.get("sku") or supplier_product.get("supplier_code") or str(supplier_product["_id"])
        
        # Check if already in products database (try sku, then supplier_code)
        existing = None
        if supplier_product.get("sku"):
            existing = db.products.find_one({"sku": supplier_product["sku"]})
        if not existing and supplier_product.get("supplier_code"):
            existing = db.products.find_one({"sku": supplier_product["supplier_code"]})
        if not existing and supplier_product.get("supplier_code"):
            existing = db.products.find_one({"supplier_code": supplier_product["supplier_code"]})
        if existing:
            # Update the supplier_product to mark as added and clear draft status
            db.supplier_products.update_one(
                {"_id": supplier_product["_id"]},
                {"$set": {
                    "in_products_db": True, 
                    "products_db_id": existing.get("id"),
                    "visibility": "published",
                    "status": "active",
                    "show_on_website": True
                }}
            )
            # Also update the existing product - SYNC ALL fields from supplier_products
            sync_fields = {
                "visibility": "published",
                "status": "active",
                "show_on_website": True,
                "updated_at": datetime.now(timezone.utc)
            }
            
            # Sync description and SEO keywords
            if supplier_product.get("description"):
                sync_fields["description"] = supplier_product.get("description")
            if supplier_product.get("seo_keywords"):
                sync_fields["seo_keywords"] = supplier_product.get("seo_keywords")
            if supplier_product.get("hidden_seo_keywords"):
                sync_fields["hidden_seo_keywords"] = supplier_product.get("hidden_seo_keywords")
            
            # Sync basic info
            if supplier_product.get("product_name"):
                sync_fields["name"] = supplier_product.get("product_name")
            if supplier_product.get("images"):
                sync_fields["images"] = supplier_product.get("images")
            if supplier_product.get("price"):
                sync_fields["price"] = supplier_product.get("price")
            if supplier_product.get("cost_price"):
                sync_fields["cost"] = supplier_product.get("cost_price")
            if supplier_product.get("category"):
                sync_fields["category_name"] = supplier_product.get("category")
            if supplier_product.get("color"):
                sync_fields["color"] = supplier_product.get("color")
            
            # SYNC ALL SPECIFICATION FIELDS
            spec_fields = [
                "material", "finish", "edge", "slip_rating", "thickness", 
                "suitability", "underfloor_heating", "made_in", "type",
                "tile_width", "tile_height", "tiles_per_box", "sqm_per_box",
                "tile_m2_per_piece", "size"
            ]
            for field in spec_fields:
                if supplier_product.get(field) is not None and supplier_product.get(field) != "":
                    sync_fields[field] = supplier_product.get(field)
            
            # SYNC WEBSITE CATEGORIES (arrays)
            category_fields = ["rooms", "styles", "colors", "features", "sub_categories", "main_category"]
            for field in category_fields:
                if supplier_product.get(field):
                    sync_fields[field] = supplier_product.get(field)
            
            db.products.update_one(
                {"_id": existing["_id"]},
                {"$set": sync_fields}
            )
            return {
                "success": True,
                "message": "Product synced from supplier data",
                "product_id": existing.get("id"),
                "already_existed": True
            }
        
        # Create product in main database
        import uuid
        product_id = str(uuid.uuid4())
        
        # Extract size dimensions
        size = supplier_product.get("size", "")
        width, height = None, None
        if size and "x" in size.lower():
            parts = size.lower().replace("mm", "").replace("cm", "").split("x")
            if len(parts) == 2:
                try:
                    width = int(parts[0].strip())
                    height = int(parts[1].strip())
                except:
                    pass
        
        # Use product_name (unique internal name) as the display name
        # Store original supplier name in supplier_product_name for search/reference
        unique_name = supplier_product.get("product_name") or supplier_product.get("name")
        original_supplier_name = supplier_product.get("name")  # Always store original
        
        new_product = {
            "id": product_id,
            "name": unique_name,  # Unique internal name for customer display
            "supplier_product_name": original_supplier_name,  # Original supplier name for search
            "sku": actual_sku,
            "description": supplier_product.get("description"),
            "seo_keywords": supplier_product.get("seo_keywords"),
            "hidden_seo_keywords": supplier_product.get("hidden_seo_keywords"),
            "category_id": None,
            "category_name": supplier_product.get("category"),
            "stock": supplier_product.get("stock_quantity", 0) or 0,
            "m2_quantity": supplier_product.get("stock_m2", 0) or 0,
            "tile_width": supplier_product.get("tile_width") or width,
            "tile_height": supplier_product.get("tile_height") or height,
            "tile_m2_per_piece": supplier_product.get("tile_m2_per_piece"),
            "tiles_per_box": supplier_product.get("tiles_per_box"),
            "sqm_per_box": supplier_product.get("sqm_per_box"),
            "box_m2_coverage": supplier_product.get("sqm_per_box"),
            "price": supplier_product.get("price", 0) or 0,
            "cost": supplier_product.get("cost_price", 0) or 0,
            "images": supplier_product.get("images", []),
            # ALL Specification fields
            "material": supplier_product.get("material"),
            "finish": supplier_product.get("finish"),
            "color": supplier_product.get("color"),
            "edge": supplier_product.get("edge"),
            "slip_rating": supplier_product.get("slip_rating"),
            "thickness": supplier_product.get("thickness"),
            "suitability": supplier_product.get("suitability"),
            "underfloor_heating": supplier_product.get("underfloor_heating"),
            "made_in": supplier_product.get("made_in"),
            "type": supplier_product.get("type"),
            "size": supplier_product.get("size"),
            "supplier": supplier_product.get("supplier"),
            "supplier_sku": supplier_product.get("old_sku") or actual_sku,
            "supplier_code": supplier_product.get("supplier_code"),
            # Website categories
            "main_category": supplier_product.get("main_category"),
            "sub_categories": supplier_product.get("sub_categories"),
            "rooms": supplier_product.get("rooms"),
            "styles": supplier_product.get("styles"),
            "colors": supplier_product.get("colors"),
            "features": supplier_product.get("features"),
            # Clear draft status when adding to database
            "visibility": "published",
            "status": "active",
            "show_on_website": True,
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc)
        }
        
        # Remove None values
        new_product = {k: v for k, v in new_product.items() if v is not None}
        
        db.products.insert_one(new_product)
        
        # Update supplier_product to mark as added and clear draft status
        db.supplier_products.update_one(
            {"_id": supplier_product["_id"]},
            {"$set": {
                "in_products_db": True, 
                "products_db_id": product_id,
                "visibility": "published",
                "status": "active",
                "show_on_website": True
            }}
        )
        
        return {
            "success": True,
            "message": "Product added to database",
            "product_id": product_id,
            "already_existed": False
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Add to database error: {e}")
        raise HTTPException(status_code=500, detail=str(e))



@router.post("/products/fix-draft-status")
def fix_draft_status(data: dict = {}):
    """
    Fix draft status for products that are already in database.
    Clears visibility=draft and status=pending_approval for products that have in_products_db=True.
    Expects: {"sku": "SKU1"} for single product, {"skus": ["SKU1", "SKU2"]} for multiple, or {"supplier": "Plus39"} for all supplier products
    """
    try:
        db = get_db()
        
        sku = data.get("sku")
        skus = data.get("skus", [])
        supplier = normalise_filter_value(data.get("supplier"))
        
        # Build query for products that are in database but still draft
        query = {
            "$or": [
                {"visibility": "draft"},
                {"status": "pending_approval"}
            ]
        }
        
        if sku:
            query["$or"].append({"sku": sku})
            query["$or"].append({"supplier_code": sku})
            # Restructure: need both draft/pending AND (sku or supplier_code)
            query = {
                "$and": [
                    {"$or": [{"visibility": "draft"}, {"status": "pending_approval"}]},
                    {"$or": [{"sku": sku}, {"supplier_code": sku}]}
                ]
            }
        elif skus:
            query["$or"] = [
                {"visibility": "draft"},
                {"status": "pending_approval"}
            ]
            query["$or"] = [{"sku": {"$in": skus}}, {"supplier_code": {"$in": skus}}]
            query = {
                "$and": [
                    {"$or": [{"visibility": "draft"}, {"status": "pending_approval"}]},
                    {"$or": [{"sku": {"$in": skus}}, {"supplier_code": {"$in": skus}}]}
                ]
            }
        elif supplier:
            query["supplier"] = supplier
        
        # Fix supplier_products collection
        result1 = db.supplier_products.update_many(
            query,
            {"$set": {
                "visibility": "published",
                "status": "active",
                "show_on_website": True,
                "in_products_db": True
            }}
        )
        
        # Fix products collection too
        products_query = {
            "$or": [
                {"visibility": "draft"},
                {"status": "pending_approval"}
            ]
        }
        if sku:
            products_query["sku"] = sku
        elif skus:
            products_query["sku"] = {"$in": skus}
        elif supplier:
            products_query["supplier"] = supplier
            
        result2 = db.products.update_many(
            products_query,
            {"$set": {
                "visibility": "published",
                "status": "active",
                "show_on_website": True
            }}
        )
        
        total_fixed = result1.modified_count + result2.modified_count
        
        return {
            "success": True,
            "message": f"Fixed {total_fixed} products",
            "supplier_products_fixed": result1.modified_count,
            "products_fixed": result2.modified_count
        }
        
    except Exception as e:
        logger.error(f"Fix draft status error: {e}")
        raise HTTPException(status_code=500, detail=str(e))



@router.post("/products/bulk-add-to-database")
def bulk_add_to_database(data: dict):
    """
    Bulk add supplier products to the main Products database.
    Expects: {"supplier": "Verona"} or {"skus": ["SKU1", "SKU2"]}
    """
    try:
        db = get_db()
        import uuid
        
        supplier = normalise_filter_value(data.get("supplier"))
        skus = data.get("skus", [])
        
        if not supplier and not skus:
            raise HTTPException(status_code=400, detail="Supplier or SKUs required")
        
        # Build query — fetch ALL products for this supplier (don't rely on in_products_db flag
        # because it can get out of sync if products were deleted from the products collection)
        query = {}
        supplier = normalise_filter_value(supplier)
        if supplier:
            query["supplier"] = supplier
        if skus:
            query["$or"] = [{"sku": {"$in": skus}}, {"supplier_code": {"$in": skus}}]
        
        supplier_products = list(db.supplier_products.find(query))
        
        added = 0
        skipped = 0
        errors = 0
        error_details = []
        
        for sp in supplier_products:
            try:
                sku = sp.get("sku")
                supplier_code = sp.get("supplier_code")
                actual_sku = sku or supplier_code or str(sp["_id"])
                
                # Check if already exists in main products db using specific identifiers
                existing = None
                if sku:
                    existing = db.products.find_one({"sku": sku})
                if not existing and supplier_code:
                    existing = db.products.find_one({"sku": supplier_code})
                if not existing and supplier_code:
                    existing = db.products.find_one({"supplier_code": supplier_code})
                
                if existing:
                    db.supplier_products.update_one(
                        {"_id": sp["_id"]},
                        {"$set": {"in_products_db": True, "products_db_id": existing.get("id")}}
                    )
                    skipped += 1
                    continue
                
                # Extract size dimensions
                size = sp.get("size") or ""
                width, height = None, None
                if size and "x" in size.lower():
                    parts = size.lower().replace("mm", "").replace("cm", "").split("x")
                    if len(parts) >= 2:
                        try:
                            width = int(parts[0].strip())
                            height = int(parts[1].strip())
                        except (ValueError, IndexError):
                            pass
                
                product_id = str(uuid.uuid4())
                
                new_product = {
                    "id": product_id,
                    "name": sp.get("our_product_name") or sp.get("product_name") or sp.get("name"),
                    "sku": actual_sku,
                    "supplier_code": supplier_code,
                    "description": sp.get("description"),
                    "category_name": sp.get("category"),
                    "stock": sp.get("stock_quantity", 0) or 0,
                    "m2_quantity": sp.get("stock_m2", 0) or 0,
                    "tile_width": width,
                    "tile_height": height,
                    "price": sp.get("price", 0) or 0,
                    "cost": sp.get("cost_price", 0) or 0,
                    "images": sp.get("images", []),
                    "material": sp.get("material"),
                    "finish": sp.get("finish"),
                    "color": sp.get("color"),
                    "supplier": sp.get("supplier"),
                    "supplier_sku": sp.get("old_sku") or actual_sku,
                    "supplier_product_name": sp.get("supplier_product_name") or sp.get("original_series") or sp.get("name"),
                    "created_at": datetime.now(timezone.utc)
                }
                
                new_product = {k: v for k, v in new_product.items() if v is not None}
                
                db.products.insert_one(new_product)
                
                db.supplier_products.update_one(
                    {"_id": sp["_id"]},
                    {"$set": {"in_products_db": True, "products_db_id": product_id}}
                )
                
                added += 1
                
            except Exception as e:
                logger.error(f"Error adding {sp.get('sku') or sp.get('supplier_code')}: {e}")
                error_details.append(f"{sp.get('sku') or sp.get('supplier_code')}: {str(e)[:100]}")
                errors += 1
        
        return {
            "success": True,
            "added": added,
            "skipped": skipped,
            "errors": errors,
            "error_details": error_details[:5] if error_details else [],
            "message": f"Added {added} products to database ({skipped} already existed){f', {errors} errors' if errors else ''}"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Bulk add to database error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


class BulkDeleteFromDbRequest(BaseModel):
    supplier: str
    password: str


@router.post("/products/bulk-delete-from-database")
def bulk_delete_from_database(data: BulkDeleteFromDbRequest):
    """
    Bulk delete supplier products from the main Products database.
    Requires Super Admin password verification for security.
    
    This ONLY removes products from the main 'products' collection.
    Products remain in 'supplier_products' staging area and can be re-added.
    """
    try:
        from services import verify_password
        
        db = get_db()
        supplier = data.supplier
        password = data.password
        
        if not supplier:
            raise HTTPException(status_code=400, detail="Supplier is required")
        
        if not password:
            raise HTTPException(status_code=400, detail="Password is required")
        
        # Find super admin users to verify password against
        super_admins = list(db.users.find({"role": {"$in": ["super_admin", "SUPER_ADMIN"]}}))
        
        if not super_admins:
            raise HTTPException(status_code=403, detail="No super admin found in system")
        
        # Verify password against any super admin
        password_verified = False
        for admin in super_admins:
            if admin.get("password") and verify_password(password, admin["password"]):
                password_verified = True
                break
        
        if not password_verified:
            raise HTTPException(status_code=401, detail="Invalid Super Admin password")
        
        # Find all products for this supplier in main products database
        # Products from supplier_products have the "supplier" field set
        products_to_delete = list(db.products.find({
            "supplier": supplier
        }))
        
        if not products_to_delete:
            return {
                "success": True,
                "deleted": 0,
                "message": f"No {supplier} products found in the database"
            }
        
        product_skus = [p.get("sku") for p in products_to_delete if p.get("sku")]
        
        # Delete from products collection
        delete_result = db.products.delete_many({"supplier": supplier})
        deleted_count = delete_result.deleted_count
        
        # Update supplier_products to mark them as no longer in products db
        if product_skus:
            db.supplier_products.update_many(
                {"sku": {"$in": product_skus}, "supplier": supplier},
                {
                    "$set": {"in_products_db": False},
                    "$unset": {"products_db_id": ""}
                }
            )
        
        logger.info(f"Bulk deleted {deleted_count} {supplier} products from database")
        
        return {
            "success": True,
            "deleted": deleted_count,
            "message": f"Deleted {deleted_count} {supplier} products from the database"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Bulk delete from database error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/products/count-in-database")
def count_products_in_database(supplier: str):
    """
    Count how many products from a specific supplier are in the main Products database.
    Used to show the count before deleting all supplier products.
    """
    try:
        db = get_db()
        count = db.products.count_documents({"supplier": supplier})
        return {"count": count, "supplier": supplier}
    except Exception as e:
        logger.error(f"Error counting products: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/products/count-supplier-products")
def count_supplier_products(supplier: str):
    """
    Count how many products from a specific supplier are in the supplier_products collection.
    Used to show the count before clearing all supplier products from staging.
    """
    try:
        db = get_db()
        count = db.supplier_products.count_documents({"supplier": supplier})
        return {"count": count, "supplier": supplier}
    except Exception as e:
        logger.error(f"Error counting supplier products: {e}")
        raise HTTPException(status_code=500, detail=str(e))


class ClearSupplierProductsRequest(BaseModel):
    supplier: str
    password: str


class DeleteSupplierEntireRequest(BaseModel):
    """Completely remove a supplier — all products across every collection,
    the supplier row itself, and any sync / staging / progress data."""
    supplier: str
    password: str
    confirm_name: str = ""  # user must retype the supplier name


@router.get("/suppliers/{supplier}/impact")
def supplier_delete_impact(supplier: str):
    """Return counts of records that would be deleted if this supplier is
    fully removed. Used by the frontend confirmation modal so admins can see
    the blast-radius before typing the password."""
    try:
        db = get_db()
        return {
            "supplier": supplier,
            "supplier_products": db.supplier_products.count_documents({"supplier": supplier}),
            "tiles": db.tiles.count_documents({"$or": [{"supplier": supplier}, {"source_supplier": supplier}]}),
            "products": db.products.count_documents({"$or": [{"supplier": supplier}, {"source_supplier": supplier}]}),
            "sync_staging": db.sync_staging.count_documents({"supplier": supplier}),
            "sync_progress": db.sync_progress.count_documents({"supplier": supplier}) if "sync_progress" in db.list_collection_names() else 0,
            "scrape_progress": db.scrape_progress.count_documents({"supplier": supplier}) if "scrape_progress" in db.list_collection_names() else 0,
            "custom_mappings": db.custom_mappings.count_documents({"supplier": supplier}) if "custom_mappings" in db.list_collection_names() else 0,
            "supplier_row": db.suppliers.count_documents({"$or": [{"name": supplier}, {"slug": supplier}]}),
        }
    except Exception as e:
        logger.error(f"supplier_delete_impact error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/suppliers/delete-entirely")
def delete_supplier_entirely(data: DeleteSupplierEntireRequest):
    """Hard-delete a supplier and every artefact it produced across the DB.
    Guarded by:
      1. Super Admin password verification.
      2. Explicit name-confirmation match (user must retype the supplier name).
    Returns a per-collection deletion breakdown so the admin can audit."""
    try:
        from services import verify_password
        db = get_db()
        supplier = (data.supplier or "").strip()
        password = data.password or ""
        confirm = (data.confirm_name or "").strip()

        if not supplier:
            raise HTTPException(status_code=400, detail="Supplier is required")
        if not password:
            raise HTTPException(status_code=400, detail="Super Admin password is required")
        if confirm.lower() != supplier.lower():
            raise HTTPException(status_code=400, detail=f"Name confirmation mismatch — you typed '{confirm}', expected '{supplier}'")

        # Verify password against any Super Admin user in the system.
        super_admins = list(db.users.find({"role": {"$in": ["super_admin", "SUPER_ADMIN"]}}))
        if not super_admins:
            raise HTTPException(status_code=403, detail="No super admin found in system")
        if not any(a.get("password") and verify_password(password, a["password"]) for a in super_admins):
            raise HTTPException(status_code=401, detail="Invalid Super Admin password")

        # Perform the deletions. Each collection uses the query that matches
        # its schema (supplier vs source_supplier vs name/slug for suppliers).
        deleted = {}
        deleted["supplier_products"] = db.supplier_products.delete_many({"supplier": supplier}).deleted_count
        deleted["tiles"] = db.tiles.delete_many({"$or": [{"supplier": supplier}, {"source_supplier": supplier}]}).deleted_count
        deleted["products"] = db.products.delete_many({"$or": [{"supplier": supplier}, {"source_supplier": supplier}]}).deleted_count
        deleted["sync_staging"] = db.sync_staging.delete_many({"supplier": supplier}).deleted_count
        # Progress / mapping / config collections may not exist in every env.
        for coll_name in ("sync_progress", "scrape_progress", "custom_mappings"):
            try:
                if coll_name in db.list_collection_names():
                    deleted[coll_name] = db[coll_name].delete_many({"supplier": supplier}).deleted_count
                else:
                    deleted[coll_name] = 0
            except Exception:
                deleted[coll_name] = 0
        # Finally remove the supplier row itself (by name OR by slug so we
        # catch both the "Ultra Tile" and "ultra_tile" shapes admins might
        # have used historically).
        deleted["supplier_row"] = db.suppliers.delete_many({"$or": [{"name": supplier}, {"slug": supplier}]}).deleted_count

        # Also record the supplier as HIDDEN so the frontend chip list
        # (which is a hardcoded set in SupplierProducts.js) can filter it
        # out on next load. Without this, deleting a supplier removes all
        # its data but the chip stays visible forever.
        try:
            now_iso = datetime.now(timezone.utc).isoformat()
            db.hidden_suppliers.update_one(
                {"name": supplier},
                {"$set": {"name": supplier, "hidden_at": now_iso}},
                upsert=True,
            )
        except Exception as e:
            logger.warning(f"[SUPPLIER-HARD-DELETE] Failed to mark hidden: {e}")

        total = sum(v for v in deleted.values() if isinstance(v, int))
        logger.warning(f"[SUPPLIER-HARD-DELETE] {supplier} — total_removed={total} breakdown={deleted}")
        return {
            "success": True,
            "supplier": supplier,
            "total_deleted": total,
            "breakdown": deleted,
            "message": f"Removed '{supplier}' entirely — {total} records across {len(deleted)} collections",
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"delete_supplier_entirely error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/suppliers/hidden")
def list_hidden_suppliers():
    """Return the list of supplier names that have been deleted entirely
    and should be hidden from the admin's Supplier Products chip list.

    Called on page load by SupplierProducts.js so the hardcoded SUPPLIERS
    array can be filtered — otherwise deleting Regulus wipes its data but
    the chip stays visible forever."""
    try:
        db = get_db()
        if "hidden_suppliers" not in db.list_collection_names():
            return {"hidden": []}
        rows = list(db.hidden_suppliers.find({}, {"_id": 0, "name": 1, "hidden_at": 1}))
        return {"hidden": rows}
    except Exception as e:
        logger.error(f"list_hidden_suppliers error: {e}")
        return {"hidden": []}


@router.post("/suppliers/{supplier}/restore")
def restore_hidden_supplier(supplier: str):
    """Un-hide a previously deleted supplier so its chip reappears in the
    admin UI. Data that was hard-deleted isn't recovered — this only
    reveals the chip so admins can re-import products for that brand."""
    try:
        db = get_db()
        supplier = (supplier or "").strip()
        if not supplier:
            raise HTTPException(status_code=400, detail="Supplier is required")
        res = db.hidden_suppliers.delete_many({"name": {"$regex": f"^{supplier}$", "$options": "i"}})
        return {"success": True, "restored": res.deleted_count, "supplier": supplier}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"restore_hidden_supplier error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/products/clear-supplier-products")
def clear_supplier_products(data: ClearSupplierProductsRequest):
    """
    Clear all products for a supplier from the supplier_products collection.
    This is different from deleting from the main products database.
    Requires Super Admin password verification.
    """
    try:
        from services import verify_password
        
        db = get_db()
        supplier = data.supplier
        password = data.password
        
        if not supplier:
            raise HTTPException(status_code=400, detail="Supplier is required")
        
        if not password:
            raise HTTPException(status_code=400, detail="Password is required")
        
        # Find super admin users to verify password against
        super_admins = list(db.users.find({"role": {"$in": ["super_admin", "SUPER_ADMIN"]}}))
        
        if not super_admins:
            raise HTTPException(status_code=403, detail="No super admin found in system")
        
        # Verify password against any super admin
        password_verified = False
        for admin in super_admins:
            if admin.get("password") and verify_password(password, admin["password"]):
                password_verified = True
                break
        
        if not password_verified:
            raise HTTPException(status_code=401, detail="Invalid Super Admin password")
        
        # Count products before deleting
        count = db.supplier_products.count_documents({"supplier": supplier})
        
        if count == 0:
            return {
                "success": True,
                "deleted": 0,
                "message": f"No {supplier} products found in supplier products"
            }
        
        # Delete from supplier_products collection
        delete_result = db.supplier_products.delete_many({"supplier": supplier})
        deleted_count = delete_result.deleted_count
        
        logger.info(f"Cleared {deleted_count} {supplier} products from supplier_products")
        
        return {
            "success": True,
            "deleted": deleted_count,
            "message": f"Cleared {deleted_count} {supplier} products from supplier products"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Clear supplier products error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/products/fix-for-epos")
def fix_products_for_epos():
    """
    Fix all supplier products in main Products database to be compatible with EPOS.
    Ensures all required fields have proper values.
    """
    try:
        db = get_db()
        
        # Find products that need fixing (have supplier field - means they came from supplier_products)
        supplier_products = list(db.products.find({"supplier": {"$exists": True}}))
        
        fixed = 0
        for product in supplier_products:
            update_fields = {}
            
            # Fix stock - must be integer, not None
            if product.get('stock') is None:
                update_fields['stock'] = 0
            
            # Fix cost_price field
            if product.get('cost') is not None and product.get('cost_price') is None:
                update_fields['cost_price'] = product.get('cost')
            elif product.get('cost_price') is None:
                update_fields['cost_price'] = 0
            
            # Ensure price is not None
            if product.get('price') is None:
                update_fields['price'] = 0
            
            # Add missing required fields with defaults
            if product.get('description') is None:
                update_fields['description'] = ""
            if product.get('barcode') is None:
                update_fields['barcode'] = ""
            if product.get('category_id') is None:
                update_fields['category_id'] = ""
            if product.get('unit') is None:
                update_fields['unit'] = "m2"
            if product.get('reorder_level') is None:
                update_fields['reorder_level'] = 10
            if product.get('pallet_enabled') is None:
                update_fields['pallet_enabled'] = False
            if product.get('clearance') is None:
                update_fields['clearance'] = False
            if product.get('images') is None:
                update_fields['images'] = []
            
            # Fix datetime fields to ISO strings
            if isinstance(product.get('created_at'), datetime):
                update_fields['created_at'] = product['created_at'].isoformat()
            if isinstance(product.get('updated_at'), datetime):
                update_fields['updated_at'] = product['updated_at'].isoformat()
            elif product.get('updated_at') is None:
                update_fields['updated_at'] = datetime.now(timezone.utc).isoformat()
            
            if update_fields:
                db.products.update_one(
                    {"id": product['id']},
                    {"$set": update_fields}
                )
                fixed += 1
        
        return {
            "success": True,
            "total_checked": len(supplier_products),
            "fixed": fixed,
            "message": f"Fixed {fixed} products for EPOS compatibility"
        }
        
    except Exception as e:
        logger.error(f"Fix products for EPOS error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/products/migrate-supplier-names")
def migrate_supplier_names():
    """
    Migrate existing products to include original supplier product names.
    This enables flexible search - staff can search by supplier's original name
    (e.g., "Tenby White") and find the internal product (e.g., "Sparta White").
    """
    try:
        db = get_db()
        
        # Find products that have a supplier but no supplier_product_name yet
        products_to_update = list(db.products.find({
            "supplier": {"$exists": True, "$ne": None},
            "$or": [
                {"supplier_product_name": {"$exists": False}},
                {"supplier_product_name": None}
            ]
        }))
        
        updated = 0
        skipped = 0
        
        for product in products_to_update:
            sku = product.get('sku')
            supplier = product.get('supplier')
            
            if not sku:
                skipped += 1
                continue
            
            # Find matching supplier product to get the original name
            supplier_product = db.supplier_products.find_one({
                "sku": sku,
                "supplier": supplier
            })
            
            if supplier_product and supplier_product.get('name'):
                # Update the product with the original supplier name
                db.products.update_one(
                    {"id": product['id']},
                    {"$set": {"supplier_product_name": supplier_product.get('name')}}
                )
                updated += 1
            else:
                skipped += 1
        
        return {
            "success": True,
            "total_checked": len(products_to_update),
            "updated": updated,
            "skipped": skipped,
            "message": f"Updated {updated} products with original supplier names"
        }
        
    except Exception as e:
        logger.error(f"Migrate supplier names error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/products/rebuild-complete-names")
def rebuild_complete_product_names(
    supplier: Optional[str] = None,
    dry_run: bool = True
):
    """
    Completely rebuild product_name with ALL components extracted from original name:
    [Unique Range] + [Color] + [Size] + [Finish] + [Characteristics]
    
    This extracts color, finish, and other attributes from the original supplier name
    and combines them with the unique range name.
    """
    import re
    
    try:
        db = get_db()
        
        # Build query
        query = {"product_name": {"$exists": True, "$ne": None}}
        supplier = normalise_filter_value(supplier)
        if supplier:
            query["supplier"] = supplier
        
        products = list(db.supplier_products.find(query, {"_id": 0}))
        
        changes = []
        
        # Known colors (common in tile industry)
        COLORS = [
            'WHITE', 'BLACK', 'GREY', 'GRAY', 'BEIGE', 'CREAM', 'IVORY', 'BROWN', 'TAUPE',
            'GOLD', 'SILVER', 'BRONZE', 'COPPER', 'BONE', 'SAND', 'PEARL', 'STONE',
            'ANTHRACITE', 'CHARCOAL', 'GRAPHITE', 'SLATE', 'ASH', 'SMOKE', 'DUNE',
            'BLUE', 'GREEN', 'RED', 'PINK', 'ORANGE', 'YELLOW', 'PURPLE', 'TEAL',
            'MOSS', 'SAGE', 'OLIVE', 'FOREST', 'NAVY', 'OCEAN', 'SKY', 'AQUA',
            'WALNUT', 'OAK', 'MAPLE', 'CHERRY', 'MAHOGANY', 'EBONY', 'TEAK',
            'GREIGE', 'COTTO', 'TERRACOTTA', 'RUST', 'CARAMEL', 'HONEY', 'MOCHA',
            'ALMOND', 'VANILLA', 'CAPPUCCINO', 'ESPRESSO', 'LATTE', 'NATURAL',
            'LIGHT', 'DARK', 'MEDIUM', 'WARM', 'COOL', 'MIXED', 'MULTI',
            # Spanish colors (common from suppliers)
            'BLANCO', 'NEGRO', 'GRIS', 'MARRON', 'CREMA', 'ORO', 'PLATA'
        ]
        
        # Known finishes
        FINISHES = [
            'MATT', 'MATTE', 'POLISHED', 'PULIDO', 'HONED', 'NATURAL', 'SATIN',
            'GLOSS', 'GLOSSY', 'LAPPATO', 'SEMI-POLISHED', 'RECTIFIED', 'RECT',
            'STRUCTURED', 'TEXTURED', 'RUSTIC', 'ANTIQUE', 'AGED', 'BRUSHED',
            'DECOR', 'FEATURE', 'MOSAIC', 'BORDER', 'LISTELLO', 'SKIRTING'
        ]
        
        # Size pattern
        size_pattern = re.compile(r'(\d+)\s*[xX×]\s*(\d+)')
        
        for product in products:
            current_name = product.get("product_name", "")
            original_name = product.get("name", "") or ""
            original_upper = original_name.upper()
            
            if not current_name or not original_name:
                continue
            
            # Extract the unique range name (first word(s) of current product_name before size/color/finish)
            # This preserves the unique name we generated (e.g., "Wacom", "Kavala", "Sparta")
            range_name = current_name.split()[0] if current_name else ""
            
            # Extract size from original
            size_match = size_pattern.search(original_name)
            size = ""
            if size_match:
                w, h = size_match.group(1), size_match.group(2)
                size = f"{w}x{h}"
            
            # Extract color from original name
            color = ""
            for c in COLORS:
                if c in original_upper:
                    # Map Spanish to English
                    color_map = {
                        'BLANCO': 'White', 'NEGRO': 'Black', 'GRIS': 'Grey',
                        'MARRON': 'Brown', 'CREMA': 'Cream', 'ORO': 'Gold', 'PLATA': 'Silver'
                    }
                    color = color_map.get(c, c.title())
                    break
            
            # Extract finish from original name
            finish = ""
            for f in FINISHES:
                if f in original_upper:
                    # Map Spanish to English and normalize
                    finish_map = {
                        'PULIDO': 'Polished', 'MATT': 'Matt', 'MATTE': 'Matt',
                        'RECT': 'Rectified', 'RECTIFIED': 'Rectified'
                    }
                    finish = finish_map.get(f, f.title())
                    # Don't duplicate if already captured
                    if finish.upper() not in current_name.upper():
                        break
                    else:
                        finish = ""
            
            # Check for characteristics
            characteristics = ""
            if 'DECOR' in original_upper and 'Decor' not in current_name:
                characteristics = "Decor"
            elif 'FEATURE' in original_upper and 'Feature' not in current_name:
                characteristics = "Feature"
            elif 'PATCHWORK' in original_upper and 'Patchwork' not in current_name:
                characteristics = "Patchwork"
            
            # Build the new complete name
            # Format: [Range] [Color] [Size] [Finish] [Characteristics]
            parts = [range_name]
            
            # Add color if not already in range_name
            if color and color.lower() not in range_name.lower():
                parts.append(color)
            
            # Add size
            if size:
                parts.append(size)
            
            # Add finish
            if finish:
                parts.append(finish)
            
            # Add characteristics
            if characteristics:
                parts.append(characteristics)
            
            new_name = ' '.join(parts)
            
            # Clean up - remove any redundant words
            new_name = ' '.join(new_name.split())  # Remove double spaces
            
            # Only add to changes if the name actually improved
            if new_name != current_name and len(new_name) > len(range_name):
                changes.append({
                    "sku": product.get("sku"),
                    "supplier": product.get("supplier"),
                    "original_name": original_name,
                    "current_product_name": current_name,
                    "new_product_name": new_name,
                    "extracted": {
                        "range": range_name,
                        "color": color,
                        "size": size,
                        "finish": finish,
                        "characteristics": characteristics
                    }
                })
                
                if not dry_run:
                    db.supplier_products.update_one(
                        {"sku": product.get("sku"), "supplier": product.get("supplier")},
                        {"$set": {"product_name": new_name}}
                    )
        
        return {
            "success": True,
            "dry_run": dry_run,
            "total_processed": len(products),
            "changes_needed": len(changes),
            "changes": changes[:100] if dry_run else [],
            "message": f"{'Would update' if dry_run else 'Updated'} {len(changes)} product names with complete information"
        }
        
    except Exception as e:
        logger.error(f"Rebuild complete product names error: {e}")
        raise HTTPException(status_code=500, detail=str(e))



@router.post("/products/rebuild-full-names")
def rebuild_full_product_names(
    supplier: Optional[str] = None,
    dry_run: bool = True
):
    """
    Rebuild product_name to include complete format:
    [Unique Range] + [Color] + [Size] + [Finish] + [Characteristics]
    
    Example: "Sparta White 30x60 Matt" instead of just "Sparta White Matt"
    
    Args:
        supplier: Optional supplier filter
        dry_run: If True, only preview changes without updating database
    """
    import re
    
    try:
        db = get_db()
        
        # Build query - only products that have a product_name (unique name generated)
        query = {"product_name": {"$exists": True, "$ne": None}}
        supplier = normalise_filter_value(supplier)
        if supplier:
            query["supplier"] = supplier
        
        products = list(db.supplier_products.find(query, {"_id": 0}))
        
        changes = []
        skipped = []
        
        # Pattern to detect if size is already in the name (e.g., 30x60, 100x200)
        size_pattern = re.compile(r'\d+\s*[xX×]\s*\d+')
        
        for product in products:
            current_name = product.get("product_name", "")
            original_name = product.get("name", "")
            size_field = product.get("size", "")
            finish_field = product.get("finish", "")
            
            # Skip if no current product_name
            if not current_name:
                continue
            
            # Check if size is ALREADY in the product_name - if so, skip
            if size_pattern.search(current_name):
                skipped.append({
                    "sku": product.get("sku"),
                    "reason": "Size already in name",
                    "current_name": current_name
                })
                continue
            
            # Extract size from original name
            size = ""
            size_match = size_pattern.search(original_name)
            if size_match:
                size = size_match.group(0).replace(' ', '').replace('×', 'x').replace('X', 'x')
            elif size_field:
                size = size_field
            
            # If no size found, skip
            if not size:
                skipped.append({
                    "sku": product.get("sku"),
                    "reason": "No size found",
                    "current_name": current_name
                })
                continue
            
            # Build the new complete name
            # Parse current name to insert size before finish
            finish_keywords = ['Matt', 'Polished', 'Natural', 'Honed', 'Satin', 'Gloss', 'Lappato', 'Rectified', 'Semi-Polished', 'Decor']
            
            new_name = current_name
            finish_found = None
            
            for f in finish_keywords:
                if f.lower() in current_name.lower():
                    # Find the position of finish in the name (case insensitive)
                    idx = current_name.lower().find(f.lower())
                    if idx > 0:
                        # Insert size before finish, preserving original finish case
                        base_part = current_name[:idx].strip()
                        finish_part = current_name[idx:].strip()
                        new_name = f"{base_part} {size} {finish_part}"
                        finish_found = f
                        break
            
            # If no finish keyword found in name, append size at end
            if not finish_found:
                # Check if we have a finish from the field
                if finish_field and finish_field.strip():
                    new_name = f"{current_name} {size} {finish_field}"
                else:
                    new_name = f"{current_name} {size}"
            
            # Clean up any double spaces
            new_name = ' '.join(new_name.split())
            
            # Only add to changes if name actually changed
            if new_name != current_name:
                changes.append({
                    "sku": product.get("sku"),
                    "supplier": product.get("supplier"),
                    "original_name": original_name,
                    "current_product_name": current_name,
                    "new_product_name": new_name,
                    "size_added": size
                })
                
                if not dry_run:
                    # Update the database
                    db.supplier_products.update_one(
                        {"sku": product.get("sku"), "supplier": product.get("supplier")},
                        {"$set": {"product_name": new_name}}
                    )
        
        return {
            "success": True,
            "dry_run": dry_run,
            "total_processed": len(products),
            "already_have_size": len([s for s in skipped if s.get("reason") == "Size already in name"]),
            "no_size_found": len([s for s in skipped if s.get("reason") == "No size found"]),
            "changes_needed": len(changes),
            "changes": changes[:50] if dry_run else [],  # Only show first 50 in dry run
            "message": f"{'Would update' if dry_run else 'Updated'} {len(changes)} product names with size information"
        }
        
    except Exception as e:
        logger.error(f"Rebuild full product names error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/products/fix-all-names")
def fix_all_product_names(
    supplier: Optional[str] = None,
    dry_run: bool = True
):
    """
    COMPREHENSIVE FIX for all product names.
    ADDS missing components to product_name: [Range] + [Color] + [Size] + [Finish]
    
    This endpoint PRESERVES existing components and ONLY ADDS what's missing:
    - If color is missing, add it from original supplier name
    - If size is missing, add it from original name or size field  
    - If finish is missing, add it from original name (PULIDO→Polished) OR finish field
    
    Example transformations:
    - "Wacom 60x120" → "Wacom Moss 60x120 Polished" (adds color + finish)
    - "Kavala 60x60" → "Kavala Ivory 60x60" (adds color, no finish in original)
    - "Garda Gold 60x120" → "Garda Gold 60x120 Polished" (adds finish from field)
    - "Durham White 30x60 Matt" → NO CHANGE (already complete)
    """
    import re
    
    try:
        db = get_db()
        
        # Build query
        query = {"product_name": {"$exists": True, "$ne": None, "$ne": ""}}
        supplier = normalise_filter_value(supplier)
        if supplier:
            query["supplier"] = supplier
        
        products = list(db.supplier_products.find(query, {"_id": 0}))
        
        changes = []
        skipped = []
        
        # Comprehensive color list
        COLORS = {
            'WHITE', 'BLACK', 'GREY', 'GRAY', 'BEIGE', 'CREAM', 'IVORY', 'BROWN', 'TAUPE',
            'GOLD', 'SILVER', 'BRONZE', 'COPPER', 'BONE', 'SAND', 'PEARL', 'STONE',
            'ANTHRACITE', 'CHARCOAL', 'GRAPHITE', 'SLATE', 'ASH', 'SMOKE', 'DUNE',
            'BLUE', 'GREEN', 'RED', 'PINK', 'ORANGE', 'YELLOW', 'PURPLE', 'TEAL',
            'MOSS', 'SAGE', 'OLIVE', 'FOREST', 'NAVY', 'OCEAN', 'SKY', 'AQUA',
            'WALNUT', 'OAK', 'MAPLE', 'CHERRY', 'MAHOGANY', 'EBONY', 'TEAK',
            'GREIGE', 'COTTO', 'TERRACOTTA', 'RUST', 'CARAMEL', 'HONEY', 'MOCHA',
            'ALMOND', 'VANILLA', 'CAPPUCCINO', 'ESPRESSO', 'LATTE',
            'BIANCO', 'GRIGIO', 'NEGRO', 'CREMA', 'MARRON', 'ORO', 'PLATA',
            'EMERALD', 'VIOLA', 'MIDNIGHT', 'ONYX', 'AZURE',
            'LIGHT', 'DARK', 'MEDIUM'
        }
        
        # Color translations
        COLOR_MAP = {
            'BIANCO': 'White', 'BLANCO': 'White', 
            'NEGRO': 'Black', 
            'GRIGIO': 'Grey', 'GRIS': 'Grey', 'GRAY': 'Grey',
            'MARRON': 'Brown',
            'CREMA': 'Cream',
            'ORO': 'Gold',
            'PLATA': 'Silver'
        }
        
        # Finish keywords mapping
        FINISH_MAP = {
            'PULIDO': 'Polished',
            'POLISHED': 'Polished',
            'POLISH': 'Polished',
            'HIGH POLISHED': 'High Polished',
            'MATT': 'Matt',
            'MATTE': 'Matt',
            'HONED': 'Honed',
            'SATIN': 'Satin',
            'GLOSS': 'Gloss',
            'GLOSSY': 'Gloss',
            'LAPPATO': 'Lappato',
            'SEMI-POLISHED': 'Semi-Polished',
            'STRUCTURED': 'Structured',
            'TEXTURED': 'Textured',
            'RUSTIC': 'Rustic',
            'BRUSHED': 'Brushed',
            'GLASS': 'Glass'
        }
        
        # All finish keywords for detection
        FINISH_WORDS = {'matt', 'matte', 'polished', 'honed', 'satin', 'gloss', 'glossy', 
                        'lappato', 'semi-polished', 'structured', 'textured', 'rustic', 
                        'brushed', 'glass', 'natural'}
        
        # Size pattern
        size_pattern = re.compile(r'(\d+)\s*[xX×]\s*(\d+)')
        
        for product in products:
            current_name = product.get("product_name", "").strip()
            original_name = product.get("name", "") or ""
            original_upper = original_name.upper()
            size_field = product.get("size", "") or ""
            finish_field = product.get("finish", "") or ""
            
            if not current_name:
                continue
            
            # Skip non-tile products
            skip_keywords = ['PEDESTAL', 'CLIP', 'KEY', 'LEVELLING', 'SUCTION', 'KIT', 'SYSTEM', 'BOARD', 'ADHESIVE', 'GROUT', 'TRIM', 'SPACER']
            if any(kw in original_upper for kw in skip_keywords):
                skipped.append({
                    "sku": product.get("sku"),
                    "reason": "Non-tile product",
                    "current_name": current_name
                })
                continue
            
            current_upper = current_name.upper()
            current_words = current_name.split()
            
            # === CHECK WHAT'S ALREADY IN THE NAME ===
            has_size = bool(size_pattern.search(current_name))
            has_finish = any(fw in current_name.lower() for fw in FINISH_WORDS)
            
            # Check if any color word is in current name (excluding the first word which is range)
            first_word = current_words[0].upper() if current_words else ""
            has_color = False
            for c in COLORS:
                # Check if color exists in name but not as the first word (range name)
                if c in current_upper:
                    # Make sure it's not just the range name
                    remaining_words_upper = ' '.join(current_words[1:]).upper() if len(current_words) > 1 else ""
                    if c in remaining_words_upper:
                        has_color = True
                        break
            
            # === EXTRACT MISSING COMPONENTS FROM ORIGINAL NAME ===
            
            # Extract color if missing
            color_to_add = ""
            if not has_color:
                for word in original_upper.split():
                    clean_word = re.sub(r'[^A-Z]', '', word)
                    if clean_word in COLORS:
                        translated_color = COLOR_MAP.get(clean_word, clean_word.title())
                        # Don't add if it's already in the current name (even as range)
                        if translated_color.upper() not in current_upper:
                            color_to_add = translated_color
                            break
            
            # Extract size if missing
            size_to_add = ""
            if not has_size:
                size_match = size_pattern.search(original_name)
                if size_match:
                    w, h = size_match.group(1), size_match.group(2)
                    size_to_add = f"{w}x{h}"
                elif size_field:
                    size_clean = re.sub(r'\.0', '', str(size_field))
                    if 'x' in size_clean.lower():
                        size_to_add = size_clean.replace('X', 'x')
            
            # Extract finish if missing
            finish_to_add = ""
            if not has_finish:
                # Try original name first
                for keyword, mapped_finish in FINISH_MAP.items():
                    if keyword in original_upper:
                        finish_to_add = mapped_finish
                        break
                
                # Try finish field if not found in original
                if not finish_to_add and finish_field:
                    finish_upper = finish_field.upper().strip()
                    for keyword, mapped_finish in FINISH_MAP.items():
                        if keyword in finish_upper:
                            finish_to_add = mapped_finish
                            break
                    if not finish_to_add and finish_field.strip():
                        # Use field value directly
                        finish_to_add = finish_field.strip().title()
                        if finish_to_add.lower() not in FINISH_WORDS:
                            finish_to_add = ""  # Don't add unknown finishes
            
            # === BUILD NEW NAME by inserting missing components ===
            # Strategy: Parse current name, insert color after range, size before finish, finish at end
            
            if not color_to_add and not size_to_add and not finish_to_add:
                # Nothing to add, skip
                continue
            
            # Find the range name (first word or words before size/color/finish)
            range_end_idx = len(current_words)
            for i, word in enumerate(current_words):
                if size_pattern.search(word) or word.lower() in FINISH_WORDS:
                    range_end_idx = i
                    break
                # Check if word is a known color
                if word.upper() in COLORS or word.upper() in COLOR_MAP:
                    range_end_idx = i
                    break
            
            range_words = current_words[:range_end_idx] if range_end_idx > 0 else [current_words[0]]
            remaining_words = current_words[range_end_idx:]
            
            # Build new name parts
            new_parts = list(range_words)
            
            # Add color if needed (after range)
            if color_to_add and color_to_add.upper() not in ' '.join(new_parts).upper():
                new_parts.append(color_to_add)
            
            # Add existing words (colors, sizes, etc. that were already there)
            for word in remaining_words:
                # Skip if it's a finish word (we'll handle finish at the end)
                if word.lower() in FINISH_WORDS:
                    continue
                new_parts.append(word)
            
            # Add size if needed
            if size_to_add:
                new_parts.append(size_to_add)
            
            # Add existing finish words back
            for word in remaining_words:
                if word.lower() in FINISH_WORDS:
                    new_parts.append(word)
            
            # Add new finish if needed
            if finish_to_add and finish_to_add.lower() not in [w.lower() for w in new_parts]:
                new_parts.append(finish_to_add)
            
            new_name = ' '.join(new_parts)
            new_name = ' '.join(new_name.split())  # Clean double spaces
            
            # Only record if changed
            if new_name != current_name:
                changes.append({
                    "sku": product.get("sku"),
                    "supplier": product.get("supplier"),
                    "original_supplier_name": original_name,
                    "current": current_name,
                    "will_become": new_name,
                    "added": {
                        "color": color_to_add,
                        "size": size_to_add,
                        "finish": finish_to_add
                    }
                })
                
                if not dry_run:
                    db.supplier_products.update_one(
                        {"sku": product.get("sku"), "supplier": product.get("supplier")},
                        {"$set": {"product_name": new_name}}
                    )
        
        # Group changes by supplier for summary
        supplier_summary = {}
        for c in changes:
            sup = c.get("supplier", "Unknown")
            supplier_summary[sup] = supplier_summary.get(sup, 0) + 1
        
        return {
            "success": True,
            "dry_run": dry_run,
            "total_products_processed": len(products),
            "total_changes": len(changes),
            "total_skipped": len(skipped),
            "changes_by_supplier": supplier_summary,
            "sample_changes": changes[:50] if dry_run else [],
            "sample_skipped": skipped[:10] if dry_run else [],
            "message": f"{'Would update' if dry_run else 'Updated'} {len(changes)} product names"
        }
        
    except Exception as e:
        logger.error(f"Fix all product names error: {e}")
        raise HTTPException(status_code=500, detail=str(e))



@router.post("/products/fix-products-collection-names")
def fix_products_collection_names(
    dry_run: bool = True
):
    """
    Fix product names in the main 'products' collection by syncing correct names from 'supplier_products'.
    
    This endpoint:
    1. Finds products in 'products' collection that have matching SKU in 'supplier_products'
    2. Updates 'name' to use 'product_name' (unique internal name) from supplier_products
    3. Updates 'supplier_product_name' to use 'name' (original) from supplier_products
    
    This fixes the issue where both Product Name and Supplier Product Name show the same value.
    """
    try:
        db = get_db()
        
        # Get all products from main collection
        products = list(db.products.find({}, {"_id": 0}))
        
        changes = []
        skipped = []
        
        for product in products:
            sku = product.get("sku")
            if not sku:
                continue
            
            # Find matching supplier product
            supplier_product = db.supplier_products.find_one(
                {"sku": sku, "product_name": {"$exists": True, "$ne": None, "$ne": ""}},
                {"_id": 0}
            )
            
            if not supplier_product:
                skipped.append({
                    "sku": sku,
                    "reason": "No matching supplier_product with product_name found"
                })
                continue
            
            unique_name = supplier_product.get("product_name")
            original_name = supplier_product.get("name")
            current_name = product.get("name")
            current_supplier_name = product.get("supplier_product_name")
            
            # Check if update is needed
            needs_update = False
            updates = {}
            
            # Update name if it differs from unique_name
            if unique_name and current_name != unique_name:
                updates["name"] = unique_name
                needs_update = True
            
            # Update supplier_product_name if not set or different
            if original_name and current_supplier_name != original_name:
                updates["supplier_product_name"] = original_name
                needs_update = True
            
            if needs_update:
                changes.append({
                    "sku": sku,
                    "supplier": product.get("supplier"),
                    "current_name": current_name,
                    "new_name": updates.get("name", current_name),
                    "current_supplier_name": current_supplier_name,
                    "new_supplier_name": updates.get("supplier_product_name", current_supplier_name),
                    "updates": updates
                })
                
                if not dry_run:
                    db.products.update_one(
                        {"id": product.get("id")},
                        {"$set": updates}
                    )
        
        return {
            "success": True,
            "dry_run": dry_run,
            "total_products": len(products),
            "total_changes": len(changes),
            "total_skipped": len(skipped),
            "sample_changes": changes[:50] if dry_run else [],
            "sample_skipped": skipped[:10] if dry_run else [],
            "message": f"{'Would update' if dry_run else 'Updated'} {len(changes)} products in main collection"
        }
        
    except Exception as e:
        logger.error(f"Fix products collection names error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ============== COMPREHENSIVE DATA POPULATION FROM SUPPLIER FILES ==============

@router.post("/products/populate-from-files")
def populate_data_from_supplier_files(
    supplier: Optional[str] = None,
    dry_run: bool = True
):
    """
    COMPREHENSIVE DATA POPULATION - Extract data from supplier files and populate missing fields.
    
    Reads from:
    - /app/supplier_data/Verona_List_2026.xlsx
    - /app/supplier_data/Splendour_Pricelist.xlsx  
    - /app/supplier_data/Wallcano_Pricelist.pdf
    - /app/supplier_data/Ceramica_Impex_Pricelist.pdf
    
    Populates fields: material, thickness, box_quantity, sqm_per_box, sqm_per_pallet, 
                      pieces_per_pallet, boxes_per_pallet, tiles_per_box, trade_price, pallet_price
    
    Args:
        supplier: Optional - only process one supplier (Verona, Splendour, Wallcano, Ceramica Impex)
        dry_run: If True, preview changes without updating database
    """
    import pandas as pd
    import PyPDF2
    import re
    
    try:
        db = get_db()
        results = {
            "success": True,
            "dry_run": dry_run,
            "suppliers_processed": [],
            "total_matched": 0,
            "total_updated": 0,
            "errors": []
        }
        
        # ========== VERONA EXCEL PARSING ==========
        if not supplier or supplier.lower() == "verona":
            try:
                verona_file = "/app/supplier_data/Verona_List_2026.xlsx"
                df = pd.read_excel(verona_file, header=1)  # Skip first row with category header
                
                # Normalize column names
                df.columns = [str(c).strip().lower().replace(' ', '_') for c in df.columns]
                
                # Get all Verona products from DB
                verona_products = list(db.supplier_products.find({"supplier": "Verona"}, {"_id": 0}))
                
                matched = 0
                updated = 0
                verona_changes = []
                
                for product in verona_products:
                    sku = product.get("sku", "")
                    name = product.get("name", "")
                    
                    # Try to match by code/sku
                    match_row = None
                    if sku:
                        match_row = df[df['code'].astype(str).str.strip() == str(sku).strip()] if 'code' in df.columns else pd.DataFrame()
                        if match_row.empty:
                            # Try partial match
                            match_row = df[df['code'].astype(str).str.contains(str(sku).strip(), case=False, na=False)] if 'code' in df.columns else pd.DataFrame()
                    
                    # If no SKU match, try by description/name
                    if (match_row is None or match_row.empty) and name:
                        match_row = df[df['description'].astype(str).str.contains(name[:20], case=False, na=False)] if 'description' in df.columns else pd.DataFrame()
                    
                    if match_row is not None and not match_row.empty:
                        row = match_row.iloc[0]
                        matched += 1
                        
                        # Build update fields from row data
                        update_fields = {}
                        
                        # Material
                        if pd.notna(row.get('material')) and not product.get('material'):
                            update_fields['material'] = str(row['material']).strip()
                        
                        # Finish
                        if pd.notna(row.get('finish')) and not product.get('finish'):
                            update_fields['finish'] = str(row['finish']).strip()
                        
                        # Thickness
                        thickness_col = 'thickness_(mm)' if 'thickness_(mm)' in row.index else 'thickness'
                        if pd.notna(row.get(thickness_col)) and not product.get('thickness'):
                            try:
                                update_fields['thickness'] = float(row[thickness_col])
                            except: pass
                        
                        # Length/Width
                        if pd.notna(row.get('length_(mm)')) and not product.get('length_mm'):
                            try:
                                update_fields['length_mm'] = float(row['length_(mm)'])
                            except: pass
                        
                        if pd.notna(row.get('width_(mm)')) and not product.get('width_mm'):
                            try:
                                update_fields['width_mm'] = float(row['width_(mm)'])
                            except: pass
                        
                        # Box quantity
                        if pd.notna(row.get('box_quantity')) and not product.get('tiles_per_box'):
                            try:
                                update_fields['tiles_per_box'] = int(float(row['box_quantity']))
                            except: pass
                        
                        # M2 per box
                        if pd.notna(row.get('m2_per_box')) and not product.get('sqm_per_box'):
                            try:
                                update_fields['sqm_per_box'] = float(row['m2_per_box'])
                            except: pass
                        
                        # M2 per pallet
                        if pd.notna(row.get('m2_per_pallet')) and not product.get('sqm_per_pallet'):
                            try:
                                update_fields['sqm_per_pallet'] = float(row['m2_per_pallet'])
                            except: pass
                        
                        # Pallet quantity
                        if pd.notna(row.get('pallet_quantity')) and not product.get('boxes_per_pallet'):
                            try:
                                update_fields['boxes_per_pallet'] = int(float(row['pallet_quantity']))
                            except: pass
                        
                        # Trade price (under 1 pallet)
                        price_col = 'under_1_pallet_price_per_m2'
                        if pd.notna(row.get(price_col)) and not product.get('trade_price'):
                            try:
                                update_fields['trade_price'] = float(row[price_col])
                            except: pass
                        
                        # Pallet price
                        pallet_col = '1_pallet+_price_per_m2'
                        if pd.notna(row.get(pallet_col)) and not product.get('pallet_price'):
                            try:
                                update_fields['pallet_price'] = float(row[pallet_col])
                            except: pass
                        
                        if update_fields:
                            updated += 1
                            verona_changes.append({
                                "sku": sku,
                                "name": name,
                                "fields_updated": list(update_fields.keys()),
                                "updates": update_fields
                            })
                            
                            if not dry_run:
                                db.supplier_products.update_one(
                                    {"supplier": "Verona", "sku": sku},
                                    {"$set": update_fields}
                                )
                
                results["suppliers_processed"].append({
                    "supplier": "Verona",
                    "file": verona_file,
                    "total_in_db": len(verona_products),
                    "matched": matched,
                    "updated": updated,
                    "sample_changes": verona_changes[:10]
                })
                results["total_matched"] += matched
                results["total_updated"] += updated
                
            except Exception as e:
                results["errors"].append({"supplier": "Verona", "error": str(e)})
        
        # ========== SPLENDOUR EXCEL PARSING ==========
        if not supplier or supplier.lower() == "splendour":
            try:
                splendour_file = "/app/supplier_data/Splendour_Pricelist.xlsx"
                # Read with correct structure - skip first 2 rows, header is row 3
                df = pd.read_excel(splendour_file, header=None, skiprows=2)
                # Set proper column names from first row of data
                df.columns = ['shared', 'sku_no', 'product_description', 'ptv_rating', 'r_rating', 
                             'material', 'size', 'pieces_per_m2', 'room_lot_per_m2_ex_vat',
                             'price_per_tile_rl', 'pallet_price_per_m2_ex_vat', 'price_per_tile_pr',
                             'pieces_per_pack', 'pieces_per_pallet']
                # Skip the header row that's now in the data
                df = df.iloc[1:].reset_index(drop=True)
                
                # Get all Splendour products
                splendour_products = list(db.supplier_products.find({"supplier": "Splendour"}, {"_id": 0}))
                
                matched = 0
                updated = 0
                splendour_changes = []
                
                for product in splendour_products:
                    sku = product.get("sku", "")
                    name = product.get("name", "")
                    
                    # Match by SKU
                    match_row = None
                    if sku:
                        match_row = df[df['sku_no'].astype(str).str.strip() == str(sku).strip()]
                    
                    # Try by name (fuzzy match)
                    if (match_row is None or match_row.empty) and name:
                        # Try exact match first
                        match_row = df[df['product_description'].astype(str).str.strip().str.lower() == name.lower().strip()]
                        if match_row.empty:
                            # Try partial match with first 15 chars
                            match_row = df[df['product_description'].astype(str).str.contains(name[:15], case=False, na=False)]
                    
                    if match_row is not None and not match_row.empty:
                        row = match_row.iloc[0]
                        matched += 1
                        
                        update_fields = {}
                        
                        # Material
                        if pd.notna(row.get('material')) and not product.get('material'):
                            update_fields['material'] = str(row['material']).strip()
                        
                        # Size
                        if pd.notna(row.get('size')) and not product.get('size'):
                            update_fields['size'] = str(row['size']).strip()
                        
                        # PTV Rating
                        if pd.notna(row.get('ptv_rating')) and not product.get('ptv_rating'):
                            update_fields['ptv_rating'] = str(row['ptv_rating']).strip()
                        
                        # R Rating
                        if pd.notna(row.get('r_rating')) and not product.get('r_rating'):
                            update_fields['r_rating'] = str(row['r_rating']).strip()
                        
                        # Pieces per M2
                        if pd.notna(row.get('pieces_per_m2')) and not product.get('pieces_per_m2'):
                            try:
                                update_fields['pieces_per_m2'] = float(row['pieces_per_m2'])
                            except: pass
                        
                        # Pieces per pack
                        if pd.notna(row.get('pieces_per_pack')) and not product.get('tiles_per_box'):
                            try:
                                update_fields['tiles_per_box'] = int(float(row['pieces_per_pack']))
                            except: pass
                        
                        # Pieces per pallet
                        if pd.notna(row.get('pieces_per_pallet')) and not product.get('pieces_per_pallet'):
                            try:
                                update_fields['pieces_per_pallet'] = int(float(row['pieces_per_pallet']))
                            except: pass
                        
                        # Trade price (room lot)
                        if pd.notna(row.get('room_lot_per_m2_ex_vat')) and not product.get('trade_price'):
                            try:
                                update_fields['trade_price'] = float(row['room_lot_per_m2_ex_vat'])
                            except: pass
                        
                        # Pallet price
                        if pd.notna(row.get('pallet_price_per_m2_ex_vat')) and not product.get('pallet_price'):
                            try:
                                update_fields['pallet_price'] = float(row['pallet_price_per_m2_ex_vat'])
                            except: pass
                        
                        if update_fields:
                            updated += 1
                            splendour_changes.append({
                                "sku": sku,
                                "name": name,
                                "fields_updated": list(update_fields.keys()),
                                "updates": update_fields
                            })
                            
                            if not dry_run:
                                db.supplier_products.update_one(
                                    {"supplier": "Splendour", "sku": sku},
                                    {"$set": update_fields}
                                )
                
                results["suppliers_processed"].append({
                    "supplier": "Splendour",
                    "file": splendour_file,
                    "total_in_db": len(splendour_products),
                    "matched": matched,
                    "updated": updated,
                    "sample_changes": splendour_changes[:10]
                })
                results["total_matched"] += matched
                results["total_updated"] += updated
                
            except Exception as e:
                results["errors"].append({"supplier": "Splendour", "error": str(e)})
        
        # ========== WALLCANO JSON DATA (from previously processed file) ==========
        if not supplier or supplier.lower() == "wallcano":
            try:
                wallcano_json_file = "/app/supplier_data/wallcano_products.json"
                
                # Load the pre-processed JSON data
                with open(wallcano_json_file, 'r') as f:
                    wallcano_json_data = json.load(f)
                
                # Build lookup by internal name and supplier SKU
                wallcano_by_name = {}
                wallcano_by_sku = {}
                
                for item in wallcano_json_data:
                    internal_name = item.get('name', '').lower().strip()
                    sku = item.get('sku', '')
                    
                    data = {
                        "material": item.get('material'),
                        "finish": item.get('finish'),
                        "trade_price": item.get('cost'),
                        "price": item.get('price'),
                        "stock_m2": item.get('stock_sqm'),
                        "images": item.get('images', [])
                    }
                    
                    if internal_name:
                        wallcano_by_name[internal_name] = data
                    if sku:
                        wallcano_by_sku[sku] = data
                
                # Get Wallcano products from DB
                wallcano_products = list(db.supplier_products.find({"supplier": "Wallcano"}, {"_id": 0}))
                
                matched = 0
                updated = 0
                wallcano_changes = []
                
                for product in wallcano_products:
                    sku = product.get("sku", "")
                    old_sku = product.get("old_sku", "")
                    name = product.get("name", "") or ""
                    product_name = product.get("product_name", "") or ""
                    
                    # Try to match by SKU first
                    file_data = wallcano_by_sku.get(sku) or wallcano_by_sku.get(old_sku)
                    
                    # Try matching by name
                    if not file_data:
                        # Try internal product name
                        name_key = product_name.lower().strip() if product_name else name.lower().strip()
                        # Remove size suffix for matching (e.g., "60x120cm")
                        name_key = re.sub(r'\s*\d+x\d+\s*cm?', '', name_key, flags=re.IGNORECASE).strip()
                        
                        file_data = wallcano_by_name.get(name_key)
                        
                        # Try partial matching
                        if not file_data:
                            for stored_name, data in wallcano_by_name.items():
                                # Check if first word matches
                                if name_key and stored_name and name_key.split()[0] == stored_name.split()[0]:
                                    file_data = data
                                    break
                    
                    if file_data:
                        matched += 1
                        update_fields = {}
                        
                        for field, value in file_data.items():
                            if value and not product.get(field):
                                update_fields[field] = value
                        
                        if update_fields:
                            updated += 1
                            wallcano_changes.append({
                                "sku": sku,
                                "name": name,
                                "fields_updated": list(update_fields.keys()),
                                "updates": update_fields
                            })
                            
                            if not dry_run:
                                db.supplier_products.update_one(
                                    {"supplier": "Wallcano", "sku": sku},
                                    {"$set": update_fields}
                                )
                
                results["suppliers_processed"].append({
                    "supplier": "Wallcano",
                    "file": wallcano_json_file,
                    "total_in_db": len(wallcano_products),
                    "products_in_json": len(wallcano_json_data),
                    "matched": matched,
                    "updated": updated,
                    "sample_changes": wallcano_changes[:10]
                })
                results["total_matched"] += matched
                results["total_updated"] += updated
                
            except Exception as e:
                results["errors"].append({"supplier": "Wallcano", "error": str(e)})
        
        # ========== CERAMICA IMPEX PDF PARSING ==========
        if not supplier or supplier.lower() == "ceramica impex":
            try:
                ceramica_file = "/app/supplier_data/Ceramica_Impex_Pricelist.pdf"
                
                with open(ceramica_file, 'rb') as f:
                    reader = PyPDF2.PdfReader(f)
                    ceramica_data = {}
                    
                    for page in reader.pages:
                        text = page.extract_text()
                        if not text:
                            continue
                        
                        # Parse line by line
                        # Format: Code Description Size Tiles per Box m2 per Box m2 per Pallet Prices...
                        lines = text.split('\n')
                        
                        for line in lines:
                            # Match lines that start with product codes
                            # Codes like: 355POL6060, 4405, 5225, HAL-ORGR8080, etc.
                            code_match = re.match(r'^([A-Z0-9\-]+)\s+(.+)', line)
                            if code_match:
                                code = code_match.group(1).strip()
                                rest = code_match.group(2)
                                
                                # Extract size (like 60x60, 30x60, etc.)
                                size_match = re.search(r'(\d+)[xX](\d+)', rest)
                                size = f"{size_match.group(1)}x{size_match.group(2)}" if size_match else None
                                
                                # Extract tiles per box
                                tiles_match = re.search(r'\s(\d+)\s+[\d.]+\s+[\d.]+', rest)
                                tiles_per_box = int(tiles_match.group(1)) if tiles_match else None
                                
                                # Extract m2 per box (usually after tiles per box)
                                m2_match = re.search(r'\s\d+\s+([\d.]+)\s+[\d.]+', rest)
                                sqm_per_box = float(m2_match.group(1)) if m2_match else None
                                
                                # Extract m2 per pallet
                                pallet_m2_match = re.search(r'\s\d+\s+[\d.]+\s+([\d.]+)', rest)
                                sqm_per_pallet = float(pallet_m2_match.group(1)) if pallet_m2_match else None
                                
                                # Extract room lot price (last price column)
                                price_match = re.search(r'£([\d.]+)\s*$', rest)
                                if not price_match:
                                    # Try pattern like: £8.95 £7.95 £11.95
                                    prices = re.findall(r'£([\d.]+)', rest)
                                    if len(prices) >= 3:
                                        trade_price = float(prices[2])  # Room lot is usually 3rd
                                    elif prices:
                                        trade_price = float(prices[-1])
                                    else:
                                        trade_price = None
                                else:
                                    trade_price = float(price_match.group(1))
                                
                                ceramica_data[code] = {
                                    "size": size,
                                    "tiles_per_box": tiles_per_box,
                                    "sqm_per_box": sqm_per_box,
                                    "sqm_per_pallet": sqm_per_pallet,
                                    "trade_price": trade_price
                                }
                
                # Get Ceramica Impex products from DB
                ceramica_products = list(db.supplier_products.find({"supplier": "Ceramica Impex"}, {"_id": 0}))
                
                matched = 0
                updated = 0
                ceramica_changes = []
                
                for product in ceramica_products:
                    sku = product.get("sku", "")
                    
                    file_data = ceramica_data.get(sku)
                    
                    if file_data:
                        matched += 1
                        update_fields = {}
                        
                        for field, value in file_data.items():
                            if value and not product.get(field):
                                update_fields[field] = value
                        
                        if update_fields:
                            updated += 1
                            ceramica_changes.append({
                                "sku": sku,
                                "fields_updated": list(update_fields.keys()),
                                "updates": update_fields
                            })
                            
                            if not dry_run:
                                db.supplier_products.update_one(
                                    {"supplier": "Ceramica Impex", "sku": sku},
                                    {"$set": update_fields}
                                )
                
                results["suppliers_processed"].append({
                    "supplier": "Ceramica Impex",
                    "file": ceramica_file,
                    "total_in_db": len(ceramica_products),
                    "products_parsed_from_pdf": len(ceramica_data),
                    "matched": matched,
                    "updated": updated,
                    "sample_changes": ceramica_changes[:10]
                })
                results["total_matched"] += matched
                results["total_updated"] += updated
                
            except Exception as e:
                results["errors"].append({"supplier": "Ceramica Impex", "error": str(e)})
        
        results["message"] = f"{'Would update' if dry_run else 'Updated'} {results['total_updated']} products across {len(results['suppliers_processed'])} suppliers"
        return results
        
    except Exception as e:
        logger.error(f"Populate from files error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/products/rebuild-full-names-v3")
def rebuild_full_names_v3(
    supplier: Optional[str] = None,
    dry_run: bool = True
):
    """
    V3: Rebuild product names with COMPREHENSIVE parsing.
    Adds missing COLOR and FINISH from original supplier names.
    
    This is the DEFINITIVE name rebuilding endpoint that:
    1. Preserves existing product_name structure
    2. Adds missing color extracted from original name
    3. Adds missing finish extracted from original name or finish field
    4. Handles edge cases and duplicates intelligently
    
    Example:
    - Current: "Sparta 30x60 Matt" + Original: "SPARTA WHITE 30x60 MATT"
      → Result: "Sparta White 30x60 Matt" (adds color)
    
    - Current: "Wacom 60x120" + Original: "WACOM MOSS 60X120 POLISHED" 
      → Result: "Wacom Moss 60x120 Polished" (adds color + finish)
    """
    import re
    
    try:
        db = get_db()
        
        # Build query
        query = {"product_name": {"$exists": True, "$ne": None, "$ne": ""}}
        supplier = normalise_filter_value(supplier)
        if supplier:
            query["supplier"] = supplier
        
        products = list(db.supplier_products.find(query, {"_id": 0}))
        
        changes = []
        skipped = []
        
        # Colors that should be added
        COLORS = {
            'WHITE', 'BLACK', 'GREY', 'GRAY', 'BEIGE', 'CREAM', 'IVORY', 'BROWN', 'TAUPE',
            'GOLD', 'SILVER', 'BRONZE', 'COPPER', 'BONE', 'SAND', 'PEARL', 'STONE',
            'ANTHRACITE', 'CHARCOAL', 'GRAPHITE', 'SLATE', 'ASH', 'SMOKE', 'DUNE',
            'BLUE', 'GREEN', 'RED', 'PINK', 'ORANGE', 'YELLOW', 'PURPLE', 'TEAL',
            'MOSS', 'SAGE', 'OLIVE', 'FOREST', 'NAVY', 'OCEAN', 'SKY', 'AQUA',
            'WALNUT', 'OAK', 'MAPLE', 'CHERRY', 'MAHOGANY', 'EBONY', 'TEAK',
            'GREIGE', 'COTTO', 'TERRACOTTA', 'RUST', 'CARAMEL', 'HONEY', 'MOCHA',
            'ALMOND', 'VANILLA', 'CAPPUCCINO', 'ESPRESSO', 'LATTE',
            'BIANCO', 'GRIGIO', 'NEGRO', 'CREMA', 'MARRON', 'ORO', 'PLATA',
            'EMERALD', 'VIOLA', 'MIDNIGHT', 'ONYX', 'AZURE', 'LIGHT', 'DARK', 'MEDIUM'
        }
        
        # Color translations
        COLOR_MAP = {
            'BIANCO': 'White', 'BLANCO': 'White', 
            'NEGRO': 'Black', 
            'GRIGIO': 'Grey', 'GRIS': 'Grey', 'GRAY': 'Grey',
            'MARRON': 'Brown', 'CREMA': 'Cream', 'ORO': 'Gold', 'PLATA': 'Silver'
        }
        
        # Finish mapping
        FINISH_MAP = {
            'PULIDO': 'Polished', 'POLISHED': 'Polished', 'POLISH': 'Polished',
            'MATT': 'Matt', 'MATTE': 'Matt', 'HONED': 'Honed', 'SATIN': 'Satin',
            'GLOSS': 'Gloss', 'GLOSSY': 'Gloss', 'LAPPATO': 'Lappato',
            'SEMI-POLISHED': 'Semi-Polished', 'STRUCTURED': 'Structured',
            'TEXTURED': 'Textured', 'RUSTIC': 'Rustic', 'NATURAL': 'Natural'
        }
        
        FINISH_WORDS = set(f.lower() for f in FINISH_MAP.values())
        
        size_pattern = re.compile(r'(\d+)\s*[xX×]\s*(\d+)')
        
        for product in products:
            current_name = product.get("product_name", "").strip()
            original_name = product.get("name", "") or ""
            original_upper = original_name.upper()
            finish_field = product.get("finish", "") or ""
            
            if not current_name:
                continue
            
            # Skip non-tile products
            skip_keywords = ['PEDESTAL', 'CLIP', 'KEY', 'LEVELLING', 'SUCTION', 'KIT', 
                           'SYSTEM', 'BOARD', 'ADHESIVE', 'GROUT', 'TRIM', 'SPACER', 'CUTTER']
            if any(kw in original_upper for kw in skip_keywords):
                continue
            
            current_upper = current_name.upper()
            current_words = current_name.split()
            
            # Check what's already in the name
            has_finish = any(fw in current_name.lower() for fw in FINISH_WORDS)
            
            # Check if color exists (not as first word which is range)
            has_color = False
            for c in COLORS:
                if len(current_words) > 1:
                    remaining = ' '.join(current_words[1:]).upper()
                    if c in remaining:
                        has_color = True
                        break
            
            # Extract color if missing
            color_to_add = ""
            if not has_color:
                for word in original_upper.split():
                    clean_word = re.sub(r'[^A-Z]', '', word)
                    if clean_word in COLORS:
                        translated = COLOR_MAP.get(clean_word, clean_word.title())
                        if translated.upper() not in current_upper:
                            color_to_add = translated
                            break
            
            # Extract finish if missing
            finish_to_add = ""
            if not has_finish:
                for kw, mapped in FINISH_MAP.items():
                    if kw in original_upper:
                        finish_to_add = mapped
                        break
                
                if not finish_to_add and finish_field:
                    for kw, mapped in FINISH_MAP.items():
                        if kw in finish_field.upper():
                            finish_to_add = mapped
                            break
            
            # Build new name
            if not color_to_add and not finish_to_add:
                continue
            
            # Find where size is in current name to insert color before it
            new_parts = []
            size_idx = -1
            finish_idx = -1
            
            for i, word in enumerate(current_words):
                if size_pattern.search(word):
                    size_idx = i
                if word.lower() in FINISH_WORDS:
                    finish_idx = i
            
            for i, word in enumerate(current_words):
                # Insert color before size (if found) or before finish
                if color_to_add and i == size_idx:
                    new_parts.append(color_to_add)
                    color_to_add = ""  # Only add once
                new_parts.append(word)
            
            # If color wasn't added yet (no size found), add after first word
            if color_to_add:
                new_parts.insert(1, color_to_add)
            
            # Add finish at end if needed
            if finish_to_add and finish_to_add.lower() not in [w.lower() for w in new_parts]:
                new_parts.append(finish_to_add)
            
            new_name = ' '.join(new_parts)
            new_name = ' '.join(new_name.split())
            
            if new_name != current_name:
                changes.append({
                    "sku": product.get("sku"),
                    "supplier": product.get("supplier"),
                    "original_supplier_name": original_name,
                    "current": current_name,
                    "new": new_name,
                    "added_color": color_to_add if color_to_add else None,
                    "added_finish": finish_to_add if finish_to_add else None
                })
                
                if not dry_run:
                    db.supplier_products.update_one(
                        {"sku": product.get("sku"), "supplier": product.get("supplier")},
                        {"$set": {"product_name": new_name}}
                    )
        
        # Group by supplier
        supplier_summary = {}
        for c in changes:
            sup = c.get("supplier", "Unknown")
            supplier_summary[sup] = supplier_summary.get(sup, 0) + 1
        
        return {
            "success": True,
            "dry_run": dry_run,
            "total_processed": len(products),
            "total_changes": len(changes),
            "changes_by_supplier": supplier_summary,
            "sample_changes": changes[:30] if dry_run else [],
            "message": f"{'Would update' if dry_run else 'Updated'} {len(changes)} product names"
        }
        
    except Exception as e:
        logger.error(f"Rebuild full names v3 error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/products/sync-all-and-cleanup")
def sync_all_products_and_remove_duplicates(dry_run: bool = True):
    """
    COMPREHENSIVE SYNC: 
    1. Add ALL supplier products to main products database
    2. Find and remove duplicate products
    
    Run with dry_run=true first to see what will be done.
    """
    import uuid
    
    try:
        db = get_db()
        
        results = {
            "success": True,
            "dry_run": dry_run,
            "products_added": 0,
            "products_skipped": 0,
            "duplicates_found": 0,
            "duplicates_deleted": 0,
            "errors": [],
            "duplicate_details": []
        }
        
        # STEP 1: Add all supplier products to main products database
        logger.info("Step 1: Adding all supplier products to database...")
        
        # Get all supplier products not in database
        not_in_db_query = {
            "$or": [
                {"in_products_db": {"$exists": False}},
                {"in_products_db": False}
            ]
        }
        
        supplier_products = list(db.supplier_products.find(not_in_db_query))
        logger.info(f"Found {len(supplier_products)} products to add")
        
        for sp in supplier_products:
            try:
                sku = sp.get("sku")
                if not sku:
                    continue
                
                # Check if already exists in products
                existing = db.products.find_one({"sku": sku})
                if existing:
                    # Just mark as in_products_db
                    if not dry_run:
                        db.supplier_products.update_one(
                            {"_id": sp["_id"]},
                            {"$set": {"in_products_db": True, "products_db_id": existing.get("id")}}
                        )
                    results["products_skipped"] += 1
                    continue
                
                # Create new product
                product_id = str(uuid.uuid4())
                
                # Extract size dimensions
                size = sp.get("size", "")
                width, height = None, None
                if size and "x" in size.lower():
                    parts = size.lower().replace("mm", "").replace("cm", "").split("x")
                    if len(parts) == 2:
                        try:
                            width = int(parts[0].strip())
                            height = int(parts[1].strip())
                        except:
                            pass
                
                unique_name = sp.get("our_product_name") or sp.get("product_name") or sp.get("name")
                original_supplier_name = sp.get("name")
                
                new_product = {
                    "id": product_id,
                    "name": unique_name,
                    "supplier_product_name": original_supplier_name,
                    "sku": sku,
                    "description": sp.get("description"),
                    "category_id": None,
                    "category_name": sp.get("category"),
                    "stock": sp.get("stock_quantity", 0) or 0,
                    "m2_quantity": sp.get("stock_m2", 0) or 0,
                    "tile_width": width,
                    "tile_height": height,
                    "price": sp.get("price", 0) or 0,
                    "cost": sp.get("cost_price", 0) or sp.get("trade_price", 0) or 0,
                    "images": sp.get("images", []),
                    "material": sp.get("material"),
                    "finish": sp.get("finish"),
                    "color": sp.get("color"),
                    "supplier": sp.get("supplier"),
                    "supplier_sku": sp.get("old_sku") or sku,
                    "created_at": datetime.now(timezone.utc),
                    "updated_at": datetime.now(timezone.utc)
                }
                
                # Remove None values
                new_product = {k: v for k, v in new_product.items() if v is not None}
                
                if not dry_run:
                    db.products.insert_one(new_product)
                    db.supplier_products.update_one(
                        {"_id": sp["_id"]},
                        {"$set": {"in_products_db": True, "products_db_id": product_id}}
                    )
                
                results["products_added"] += 1
                
            except Exception as e:
                results["errors"].append(f"Error adding {sp.get('sku')}: {str(e)}")
        
        # STEP 2: Find and remove duplicates in supplier_products
        logger.info("Step 2: Finding duplicates...")
        
        # Aggregation to find duplicates by name (normalized)
        pipeline = [
            {
                "$project": {
                    "sku": 1,
                    "name": 1,
                    "product_name": 1,
                    "supplier": 1,
                    "name_normalized": {"$toLower": {"$trim": {"input": "$name"}}}
                }
            },
            {
                "$group": {
                    "_id": {
                        "name_normalized": "$name_normalized",
                        "supplier": "$supplier"
                    },
                    "count": {"$sum": 1},
                    "docs": {"$push": {"sku": "$sku", "name": "$name", "product_name": "$product_name"}}
                }
            },
            {
                "$match": {"count": {"$gt": 1}}
            }
        ]
        
        duplicates = list(db.supplier_products.aggregate(pipeline))
        
        for dup_group in duplicates:
            results["duplicates_found"] += dup_group["count"] - 1  # Keep one, delete rest
            
            docs = dup_group["docs"]
            # Keep the first one (or the one with product_name), delete rest
            docs_sorted = sorted(docs, key=lambda x: (x.get("product_name") is not None, x.get("sku")), reverse=True)
            
            keep = docs_sorted[0]
            to_delete = docs_sorted[1:]
            
            results["duplicate_details"].append({
                "name": dup_group["_id"]["name_normalized"],
                "supplier": dup_group["_id"]["supplier"],
                "keeping": keep["sku"],
                "deleting": [d["sku"] for d in to_delete]
            })
            
            if not dry_run:
                for doc in to_delete:
                    # Delete from supplier_products
                    db.supplier_products.delete_one({"sku": doc["sku"], "supplier": dup_group["_id"]["supplier"]})
                    # Also delete from products if exists
                    db.products.delete_one({"sku": doc["sku"]})
                    results["duplicates_deleted"] += 1
        
        results["message"] = f"{'Would add' if dry_run else 'Added'} {results['products_added']} products, {'would delete' if dry_run else 'deleted'} {results['duplicates_deleted']} duplicates"
        
        # Limit duplicate_details for response
        results["duplicate_details"] = results["duplicate_details"][:50]
        
        return results
        
    except Exception as e:
        logger.error(f"Sync all and cleanup error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/products/cleanup-nonexnone")
def cleanup_nonexnone_from_names(dry_run: bool = False):
    """
    Remove 'NonexNone', 'NoneXNone', 'Nonex', 'xNone' and similar patterns
    from product names across ALL suppliers.
    
    Args:
        dry_run: If True, only shows what would be changed without making changes
    """
    import re
    
    try:
        db = get_db()
        
        # Patterns to remove (case-insensitive)
        patterns_to_remove = [
            r'\s*NonexNone\s*',      # NonexNone with optional spaces
            r'\s*NoneXNone\s*',      # NoneXNone
            r'\s*NonexNone$',        # NonexNone at end
            r'\s*Nonex\s*None\s*',   # Nonex None with space
            r'\s+xNone$',            # xNone at end
            r'\s+Nonex$',            # Nonex at end  
            r'\s*\bNone\s*x\s*None\b\s*',  # None x None
        ]
        
        # Find products with any of these patterns
        regex_pattern = '|'.join(patterns_to_remove)
        
        products = list(db.supplier_products.find({
            "$or": [
                {"name": {"$regex": "NonexNone|NoneXNone|xNone", "$options": "i"}},
                {"product_name": {"$regex": "NonexNone|NoneXNone|xNone", "$options": "i"}}
            ]
        }))
        
        changes = []
        
        for product in products:
            original_name = product.get("name", "")
            original_product_name = product.get("product_name", "")
            
            # Clean the names
            new_name = original_name
            new_product_name = original_product_name
            
            for pattern in patterns_to_remove:
                if new_name:
                    new_name = re.sub(pattern, '', new_name, flags=re.IGNORECASE).strip()
                if new_product_name:
                    new_product_name = re.sub(pattern, '', new_product_name, flags=re.IGNORECASE).strip()
            
            # Check if anything changed
            if new_name != original_name or new_product_name != original_product_name:
                change = {
                    "sku": product.get("sku"),
                    "supplier": product.get("supplier"),
                    "original_name": original_name,
                    "new_name": new_name,
                    "original_product_name": original_product_name,
                    "new_product_name": new_product_name
                }
                changes.append(change)
                
                if not dry_run:
                    # Actually update the document
                    update_fields = {}
                    if new_name != original_name:
                        update_fields["name"] = new_name
                    if new_product_name != original_product_name:
                        update_fields["product_name"] = new_product_name
                    
                    db.supplier_products.update_one(
                        {"_id": product["_id"]},
                        {"$set": update_fields}
                    )
        
        return {
            "success": True,
            "dry_run": dry_run,
            "total_found": len(products),
            "total_changed": len(changes),
            "message": f"{'Would clean' if dry_run else 'Cleaned'} {len(changes)} product names",
            "changes": changes[:50]  # Return first 50 examples
        }
        
    except Exception as e:
        logger.error(f"Cleanup NonexNone error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/products/reapply-naming")
def reapply_naming_to_products(supplier: str = None, dry_run: bool = False):
    """
    Re-apply the naming transformation to all products.
    
    This is useful after adding new series mappings to business_rules.py
    to fix products that weren't transformed on initial sync.
    
    Also fixes categories by removing finish values (Gloss, Matt, etc.)
    that were incorrectly stored as categories.
    
    Args:
        supplier: Optional supplier filter (e.g., "Wallcano")
        dry_run: If True, only shows what would be changed
    """
    from business_config.business_rules import generate_unique_product_name
    
    try:
        db = get_db()
        
        # Build query
        query = {}
        supplier = normalise_filter_value(supplier)
        if supplier:
            query["supplier"] = supplier
        
        products = list(db.supplier_products.find(query))
        
        changes = []
        updated_count = 0
        
        # Finishes that should NOT be categories
        INVALID_CATEGORY_VALUES = {
            'gloss', 'glossy', 'matt', 'matte', 'polished', 'lappato',
            'satin', 'honed', 'natural', 'rustic', 'textured', 'anti-slip',
            'antislip', 'grip', 'structured', 'rectified', 'high-gloss'
        }
        
        for product in products:
            sku = product.get("sku", "")
            supplier_name = product.get("supplier", "")
            original_name = product.get("name", "")
            current_product_name = product.get("product_name", "")
            finish = product.get("finish", "")
            current_category = product.get("category", "")
            
            # Generate new product name using latest mappings
            new_product_name = generate_unique_product_name(
                raw_name=original_name,
                supplier=supplier_name,
                sku=sku,
                db=db,
                finish=finish
            )
            
            # Fix category - remove if it's a finish value
            new_category = current_category
            if current_category and current_category.lower().strip() in INVALID_CATEGORY_VALUES:
                new_category = ""  # Clear invalid category
            
            # Check if anything changed
            name_changed = new_product_name != current_product_name
            category_changed = new_category != current_category
            
            if name_changed or category_changed:
                change_record = {
                    "sku": sku,
                    "supplier": supplier_name,
                    "original_name": original_name
                }
                
                if name_changed:
                    change_record["old_product_name"] = current_product_name
                    change_record["new_product_name"] = new_product_name
                
                if category_changed:
                    change_record["old_category"] = current_category
                    change_record["new_category"] = new_category or "(cleared)"
                
                changes.append(change_record)
                
                if not dry_run:
                    # Update supplier_products
                    update_data = {
                        "product_name": new_product_name,
                        "category": new_category
                    }
                    db.supplier_products.update_one(
                        {"_id": product["_id"]},
                        {"$set": update_data}
                    )
                    
                    # Also update main products collection if it exists there
                    db.products.update_one(
                        {"sku": sku},
                        {"$set": {
                            "name": new_product_name,
                            "category": new_category,
                            "category_name": new_category
                        }}
                    )
                    
                    updated_count += 1
        
        return {
            "success": True,
            "dry_run": dry_run,
            "supplier_filter": supplier,
            "total_products_checked": len(products),
            "products_to_update": len(changes),
            "products_updated": updated_count if not dry_run else 0,
            "message": f"{'Would update' if dry_run else 'Updated'} {len(changes)} products",
            "sample_changes": changes[:20]  # Show first 20 examples
        }
        
    except Exception as e:
        logger.error(f"Error reapplying naming: {e}")
        raise HTTPException(status_code=500, detail=str(e))




@router.post("/products/cleanup-all-none-patterns")
def cleanup_all_none_patterns(dry_run: bool = False):
    """
    COMPREHENSIVE cleanup of ALL 'None' patterns from product names.
    Cleans both supplier_products AND main products collections.
    
    Patterns cleaned:
    - NonexNone, NoneXNone, xNone, Nonex
    - (None), [None], (NoneKg), (20None), etc.
    - None at end of strings
    - Multiple None patterns combined
    
    Args:
        dry_run: If True, only shows what would be changed
    """
    import re
    
    try:
        db = get_db()
        
        # Comprehensive patterns to remove (case-insensitive)
        patterns_to_remove = [
            r'\s*NonexNone\s*',         # NonexNone
            r'\s*NoneXNone\s*',         # NoneXNone  
            r'\s*NonexNone$',           # NonexNone at end
            r'\s*Nonex\s*None\s*',      # Nonex None
            r'\s+xNone$',               # xNone at end
            r'\s+xNone\b',              # xNone word boundary
            r'\s+Nonex$',               # Nonex at end
            r'\s*\bNone\s*x\s*None\b\s*',  # None x None
            r'\s*\(None\)\s*',          # (None)
            r'\s*\[None\]\s*',          # [None]
            r'\s*\(None[Kk]g\)\s*',     # (NoneKg)
            r'\s*\(\d*None\)\s*',       # (20None) etc
            r'\s*\(None\d*\)\s*',       # (None20)
            r'\s*\(None[Kk]g\)\s*',     # (NoneKg)
            r'\s*\bNone\s*[Kk]g\b',     # None Kg
            r'\s+None\s*$',             # None at end
            r'^\s*None\s+',             # None at start
            r'\s*\(None\s*[xX]\s*None\)', # (None x None)
            r'\s*\(\s*None\s*\)',       # ( None )
        ]
        
        changes = []
        collections_to_clean = ['supplier_products', 'products']
        
        for collection_name in collections_to_clean:
            collection = db[collection_name]
            
            # Find products with any None patterns
            products = list(collection.find({
                "$or": [
                    {"name": {"$regex": "None", "$options": "i"}},
                    {"product_name": {"$regex": "None", "$options": "i"}}
                ]
            }))
            
            for product in products:
                original_name = product.get("name", "")
                original_product_name = product.get("product_name", "")
                
                # Clean the names
                new_name = original_name
                new_product_name = original_product_name
                
                for pattern in patterns_to_remove:
                    if new_name:
                        new_name = re.sub(pattern, '', new_name, flags=re.IGNORECASE).strip()
                    if new_product_name:
                        new_product_name = re.sub(pattern, '', new_product_name, flags=re.IGNORECASE).strip()
                
                # Also clean up double spaces and trailing/leading spaces
                if new_name:
                    new_name = re.sub(r'\s+', ' ', new_name).strip()
                if new_product_name:
                    new_product_name = re.sub(r'\s+', ' ', new_product_name).strip()
                
                # Check if anything changed
                if new_name != original_name or new_product_name != original_product_name:
                    change = {
                        "collection": collection_name,
                        "sku": product.get("sku") or product.get("supplier_code"),
                        "supplier": product.get("supplier", "main"),
                        "original_name": original_name,
                        "new_name": new_name,
                        "original_product_name": original_product_name,
                        "new_product_name": new_product_name
                    }
                    changes.append(change)
                    
                    if not dry_run:
                        update_fields = {}
                        if new_name != original_name:
                            update_fields["name"] = new_name
                        if new_product_name != original_product_name:
                            update_fields["product_name"] = new_product_name
                        
                        collection.update_one(
                            {"_id": product["_id"]},
                            {"$set": update_fields}
                        )
        
        return {
            "success": True,
            "dry_run": dry_run,
            "total_changed": len(changes),
            "message": f"{'Would clean' if dry_run else 'Cleaned'} {len(changes)} product names",
            "changes": changes[:100]  # Return first 100 examples
        }
        
    except Exception as e:
        logger.error(f"Cleanup all None patterns error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/products/cleanup-invalid")
def cleanup_invalid_products():
    """
    Delete products with null/empty SKU - these are invalid entries
    """
    try:
        db = get_db()
        
        # Find and delete products with null/empty SKU
        result = db.supplier_products.delete_many({
            "$or": [
                {"sku": None},
                {"sku": ""},
                {"sku": {"$exists": False}}
            ]
        })
        
        return {
            "success": True,
            "deleted": result.deleted_count,
            "message": f"Deleted {result.deleted_count} invalid products (null/empty SKU)"
        }
        
    except Exception as e:
        logger.error(f"Cleanup invalid products error: {e}")
        raise HTTPException(status_code=500, detail=str(e))



@router.post("/products/clear-new-tags")
def clear_new_tags(supplier: Optional[str] = None):
    """
    Remove the 'NEW' tag from all supplier products by updating their created_at
    to be older than 48 hours.
    """
    try:
        db = get_db()
        from datetime import timedelta
        
        # Set created_at to 3 days ago so they're no longer "new"
        old_date = datetime.now(timezone.utc) - timedelta(days=3)
        
        # Build query
        query = {}
        supplier = normalise_filter_value(supplier)
        if supplier:
            query["supplier"] = supplier
        
        # Update all matching products
        result = db.supplier_products.update_many(
            query,
            {"$set": {"created_at": old_date}}
        )
        
        return {
            "success": True,
            "updated": result.modified_count,
            "message": f"Removed NEW tag from {result.modified_count} products"
        }
        
    except Exception as e:
        logger.error(f"Clear new tags error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============ UNIFIED BULK UPDATE ENDPOINT ============

@router.post("/products/bulk-update-unified")
def bulk_update_unified(data: dict):
    """
    Unified bulk update for products - handles BOTH tile specifications AND website categories.
    This ensures changes sync across ALL THREE collections:
    1. sync_staging (staging area)
    2. supplier_products (supplier database)
    3. products (website/main catalog)
    
    Used by: Supplier Products Page, Sync Hub, Product Edit Page
    
    Expects:
    {
        "product_ids": ["sku1", "sku2", ...],  # SKUs of products to update
        "updates": {
            // Tile Specifications (single values)
            "material": "Porcelain",
            "finish": "Matt",
            "type": "Floor Tile",
            "edge": "Rectified",
            "slip_rating": "R10",
            "suitability": "Indoor & Outdoor",
            
            // Website Categories (arrays)
            "rooms": ["floor", "bathroom"],
            "styles": ["marble_effect"],
            "colors": ["white", "grey"],
            "features": ["anti_slip"],
            
            // Other fields
            "show_on_website": true
        },
        "mode": "replace" or "append"  # For array fields only
    }
    """
    try:
        db = get_db()
        
        product_ids = data.get("product_ids", [])
        updates = data.get("updates", {})
        mode = data.get("mode", "replace")  # For array fields
        update_mode = data.get("update_mode", "replace")  # 'replace' = overwrite all, 'append' = only fill empty
        id_field = data.get("id_field", "sku")  # Which field to query by (sku or supplier_code)
        supplier_filter = normalise_filter_value(data.get("supplier"))  # 'all'/''/None → None
        
        fields_to_clear = data.get("fields_to_clear", {})
        
        if not product_ids:
            raise HTTPException(status_code=400, detail="product_ids required")
        
        if not updates and not fields_to_clear:
            raise HTTPException(status_code=400, detail="updates or fields_to_clear required")
        
        # VALIDATION: Auto-convert and validate tile dimensions
        if "tile_width" in updates and updates["tile_width"]:
            tile_width = float(updates["tile_width"])
            if tile_width > 200:
                tile_width = tile_width / 10  # Auto-convert mm to cm
                updates["tile_width"] = tile_width
                logger.info(f"Auto-converted tile_width from {tile_width * 10}mm to {tile_width}cm")
            if tile_width > 200:
                raise HTTPException(status_code=400, detail=f"Tile width {tile_width}cm exceeds maximum (200cm). Did you enter mm instead of cm?")
        
        if "tile_height" in updates and updates["tile_height"]:
            tile_height = float(updates["tile_height"])
            if tile_height > 200:
                tile_height = tile_height / 10  # Auto-convert mm to cm
                updates["tile_height"] = tile_height
                logger.info(f"Auto-converted tile_height from {tile_height * 10}mm to {tile_height}cm")
            if tile_height > 200:
                raise HTTPException(status_code=400, detail=f"Tile height {tile_height}cm exceeds maximum (200cm). Did you enter mm instead of cm?")
        
        # VALIDATION: Sanity check m² per piece if both dimensions provided
        if updates.get("tile_width") and updates.get("tile_height"):
            m2_per_piece = (float(updates["tile_width"]) / 100) * (float(updates["tile_height"]) / 100)
            if m2_per_piece > 4:
                raise HTTPException(
                    status_code=400,
                    detail=f"Calculated {m2_per_piece:.2f}m² per tile is unrealistic. Please check dimensions."
                )
            # Auto-calculate m² per piece
            updates["tile_m2_per_piece"] = round(m2_per_piece, 4)
        
        # Separate single-value fields from array fields
        single_value_fields = ["material", "finish", "type", "edge", "slip_rating", "suitability", "thickness", "color", "size", "pot_life", "adhesive", "origin", "made_in", "underfloor_heating", "show_on_website", "cost_price", "price", "category", "product_name", "our_product_name", "tiles_per_box", "sqm_per_box", "tile_width", "tile_height", "main_category", "hidden_seo_keywords"]
        array_fields = ["rooms", "materials", "styles", "colors", "features", "sub_categories"]
        
        # Build the $set operation for single-value fields
        set_fields = {}
        unset_fields = {}
        # Fields that can be explicitly cleared (set to empty string to remove)
        clearable_fields = {"made_in"}
        for field in single_value_fields:
            if field in updates:
                if updates[field] is not None and updates[field] != "":
                    set_fields[field] = updates[field]
                elif field in clearable_fields and updates[field] == "":
                    unset_fields[field] = ""
        
        # IMPORTANT: Sync price to list_price and room_lot_price for consistency
        # The codebase has multiple price fields that need to stay in sync
        if "price" in set_fields:
            set_fields["list_price"] = set_fields["price"]
            set_fields["room_lot_price"] = set_fields["price"]
        
        # IMPORTANT: Sync main_category to product_group for customer-facing page queries
        # The customer-facing collections page filters by product_group, so when admin
        # sets main_category via Bulk Category Editor, we must also set product_group
        if "main_category" in set_fields and set_fields["main_category"]:
            main_cat = set_fields["main_category"]
            product_group_slug = main_cat.lower().strip().replace(' ', '-').replace('&', 'and')
            product_group_slug = ''.join(c if c.isalnum() or c == '-' else '' for c in product_group_slug)
            set_fields["product_group"] = product_group_slug
        
        set_fields["updated_at"] = datetime.now(timezone.utc).isoformat()
        
        # When our_product_name is set, also update display_name and name
        # This ensures the storefront shows the admin's custom name, not the supplier name
        if "our_product_name" in set_fields and set_fields["our_product_name"]:
            set_fields["display_name"] = set_fields["our_product_name"]
            set_fields["name"] = set_fields["our_product_name"]
        
        # Also update attributes sub-document for spec fields
        # The frontend Specifications tab checks both top-level AND attributes.* fields
        spec_to_attr = ["material", "finish", "thickness", "suitability", "edge", "slip_rating", "size", "color", "type", "pot_life", "adhesive", "origin"]
        for field in spec_to_attr:
            if field in set_fields:
                set_fields[f"attributes.{field}"] = set_fields[field]
        set_fields["bulk_edited_at"] = datetime.now(timezone.utc).isoformat()

        
        # Process array fields (website categories)
        # Note: We need to handle empty arrays [] to allow clearing values
        array_updates = {}
        for field in array_fields:
            if field in updates:
                val = updates[field] if updates[field] is not None else []
                # Deduplicate array values (preserve order, case-insensitive dedup)
                if isinstance(val, list):
                    seen = set()
                    deduped = []
                    for v in val:
                        key = v.strip().lower() if isinstance(v, str) else v
                        if key not in seen:
                            seen.add(key)
                            deduped.append(v.strip() if isinstance(v, str) else v)
                    val = deduped
                array_updates[field] = val
        
        # SYNC: Keep array fields and their scalar counterparts in sync
        # When array field is set, also update scalar counterpart with first value
        array_to_scalar_sync = {
            'colors': 'color',
            'materials': 'material',
            'sub_categories': 'category',
        }
        for arr_field, scalar_field in array_to_scalar_sync.items():
            if arr_field in array_updates and scalar_field not in set_fields:
                arr_val = array_updates[arr_field]
                if arr_val and len(arr_val) > 0:
                    set_fields[scalar_field] = arr_val[0]
                    # Also sync to attributes sub-document for spec fields
                    if scalar_field in ["color", "material"]:
                        set_fields[f"attributes.{scalar_field}"] = arr_val[0]
                else:
                    set_fields[scalar_field] = ''
                    if scalar_field in ["color", "material"]:
                        set_fields[f"attributes.{scalar_field}"] = ''
        
        # REVERSE SYNC: When scalar is set but array is not, update the array too
        scalar_to_array_sync = {v: k for k, v in array_to_scalar_sync.items()}
        for scalar_field, arr_field in scalar_to_array_sync.items():
            if scalar_field in set_fields and arr_field not in array_updates:
                val = set_fields[scalar_field]
                if val and val != '':
                    array_updates[arr_field] = [val]
                else:
                    array_updates[arr_field] = []

        # NEW — Accept any Configure-driven field key that is NOT already handled by
        # the built-in whitelists (single_value_fields / array_fields). This makes
        # the BulkSpecsFiltersModal promise "any field added via Configure is
        # immediately bulk-editable" actually true. Reserved system keys must never
        # be user-writable via this path.
        RESERVED_SYSTEM_KEYS = {
            "_id", "id", "supplier", "sku", "supplier_code",
            "created_at", "updated_at", "deleted_at", "bulk_edited_at",
            "is_active", "is_deleted", "is_builtin",
            "verification_ok", "verification_failures", "sale_pricing",
            "password", "password_hash",
        }
        _extra_keys = [
            k for k, v in updates.items()
            if k not in single_value_fields
            and k not in array_fields
            and k not in RESERVED_SYSTEM_KEYS
            and not k.startswith("__")
        ]
        for k in _extra_keys:
            v = updates[k]
            if isinstance(v, list):
                # Configure-defined array field (rare) — go the array-append route.
                array_updates[k] = v
                continue
            if v is None or v == "":
                # Blank-clear semantic: admin explicitly typing '' should unset.
                unset_fields[k] = ""
                continue
            set_fields[k] = v

        
        staging_updated = 0
        supplier_updated = 0
        products_updated = 0
        
        # Helper function to perform updates on a collection
        def update_collection(collection, query_field=None, skip_supplier_filter=False):
            nonlocal staging_updated, supplier_updated, products_updated
            # Use the id_field from the request, default to 'sku'
            qf = query_field or id_field or "sku"
            
            collection_query = {qf: {"$in": product_ids}}
            if supplier_filter and not skip_supplier_filter:
                collection_query["supplier"] = supplier_filter
            count = 0
            
            # If update_mode is 'append', we need to check each product's existing values
            if update_mode == "append":
                # Process each product individually to check existing values
                for sku in product_ids:
                    per_q = {qf: sku}
                    if supplier_filter and not skip_supplier_filter:
                        per_q["supplier"] = supplier_filter
                    doc = collection.find_one(per_q)
                    if doc:
                        filtered_set_fields = {}
                        
                        # Only update fields that are currently empty/missing
                        for field, value in set_fields.items():
                            if field in ['updated_at', 'bulk_edited_at']:
                                # Always update timestamps
                                filtered_set_fields[field] = value
                            else:
                                existing_value = doc.get(field)
                                # Check if field is empty/missing
                                if existing_value is None or existing_value == '' or existing_value == [] or existing_value == {}:
                                    filtered_set_fields[field] = value
                        
                        # Handle array fields - merge if mode is 'append', otherwise only add if empty
                        for arr_field in array_updates:
                            existing = doc.get(arr_field, [])
                            if mode == "append":
                                # Merge arrays
                                new_values = set(array_updates[arr_field])
                                existing_set = set(existing) if existing else set()
                                filtered_set_fields[arr_field] = list(existing_set | new_values)
                            elif not existing or len(existing) == 0:
                                # Only set if empty
                                filtered_set_fields[arr_field] = array_updates[arr_field]
                        
                        if filtered_set_fields:
                            update_op = {"$set": filtered_set_fields}
                            if unset_fields:
                                update_op["$unset"] = unset_fields
                            collection.update_one({qf: sku}, update_op)
                            count += 1
            elif mode == "append" and array_updates:
                # Append mode for arrays only (legacy behavior)
                for sku in product_ids:
                    per_q2 = {qf: sku}
                    if supplier_filter and not skip_supplier_filter:
                        per_q2["supplier"] = supplier_filter
                    doc = collection.find_one(per_q2)
                    if doc:
                        update_doc = {"$set": set_fields.copy()}
                        if unset_fields:
                            update_doc["$unset"] = unset_fields
                        
                        # Merge arrays
                        for arr_field in array_updates:
                            existing = set(doc.get(arr_field, []))
                            new_values = set(array_updates[arr_field])
                            update_doc["$set"][arr_field] = list(existing | new_values)
                        
                        collection.update_one({qf: sku}, update_doc)
                        count += 1
            else:
                # Replace mode: overwrite arrays
                update_doc = {"$set": {**set_fields, **array_updates}}
                if unset_fields:
                    update_doc["$unset"] = unset_fields
                result = collection.update_many(collection_query, update_doc)
                count = result.modified_count
            
            return count
        
        # 1. Update sync_staging collection (staging area)
        staging_updated = update_collection(db.sync_staging)
        
        # 2. Update supplier_products collection
        supplier_updated = update_collection(db.supplier_products)
        
        # 3. Update products collection (main catalog/website)
        products_updated = update_collection(db.products)
        
        # 4. Update tiles collection (published website products)
        # Tiles uses 'supplier_name' not 'supplier', so pass without supplier filter
        tiles_updated = update_collection(db.tiles, skip_supplier_filter=True)
        
        # 5. AUTO-PUBLISH: Opt-in only. The admin must EXPLICITLY tick
        #    "Show on website" in the bulk editor (which sends
        #    `updates.show_on_website = true`) to publish to the
        #    storefront. Previously this fired implicitly whenever
        #    sub_categories/main_category was in the updates payload —
        #    customers (24 May 2026) reported half-finished products
        #    going live before all attributes were filled in. By
        #    gating on the existing publish-toggle, admins keep
        #    one-checkbox control over when products go live.
        #    Legacy callers can also force-opt-in with `auto_publish: true`
        #    at the request body root.
        auto_published = 0
        auto_publish_errors = []
        explicit_publish_opt_in = (
            bool(data.get("auto_publish", False))
            or updates.get("show_on_website") is True
        )
        has_category_update = bool(updates.get("sub_categories") or updates.get("main_category"))

        if explicit_publish_opt_in and has_category_update and product_ids:
            qf = id_field or "sku"
            # Find which product_ids DON'T exist in tiles
            existing_in_tiles = set()
            for doc in db.tiles.find({qf: {"$in": product_ids}}, {qf: 1, "_id": 0}):
                existing_in_tiles.add(doc.get(qf))
            
            missing_skus = [pid for pid in product_ids if pid not in existing_in_tiles]
            
            if missing_skus:
                logger.info(f"Auto-publishing {len(missing_skus)} products to tiles collection")
                for sku_val in missing_skus:
                    try:
                        # Get the updated supplier_product (already has the new categories)
                        sp = db.supplier_products.find_one({qf: sku_val})
                        if not sp:
                            continue
                        
                        # Use sku if available, otherwise fall back to supplier_code
                        sku = sp.get('sku') or sp.get('supplier_code') or ''
                        if not sku:
                            continue
                        
                        base_name = sp.get('our_product_name') or sp.get('product_name') or sp.get('display_name') or sp.get('name', 'Unknown Product')
                        original_name = sp.get('name', 'Unknown Product')
                        product_size = sp.get('size') or ''
                        name = base_name
                        # Only append DIMENSIONAL sizes (60x60 etc.) — unit sizes
                        # like "1l"/"20kg" must never be appended so the storefront
                        # name matches Supplier Products exactly.
                        if product_size and re.search(r'\d\s*[xX×]\s*\d', product_size) and product_size.lower() not in base_name.lower():
                            name = f"{base_name} {product_size}"
                        
                        display_code = sp.get('display_code', '')
                        cost_price = sp.get('cost_price') or 0
                        list_price = sp.get('price') or sp.get('list_price') or 0
                        if not list_price and cost_price:
                            list_price = round(cost_price * 2, 2)
                        
                        slug = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')
                        
                        tile_doc = {
                            "id": f"tile-{sku}",
                            "name": name,
                            "display_name": name,
                            "display_code": display_code,
                            "website_name": name,
                            "original_name": original_name,
                            "sku": sp.get('sku') or sku,
                            "supplier_code": sp.get('supplier_code') or sku,
                            "supplier_name": sp.get('supplier', 'Unknown'),
                            "original_supplier_name": sp.get('supplier', 'Unknown'),
                            "slug": slug,
                            "price": list_price,
                            "room_lot_price": list_price,
                            "pallet_price": round(list_price * 0.9, 2) if list_price else 0,
                            "cost_price": cost_price,
                            "description": sp.get('description', ''),
                            "short_description": (sp.get('description', '') or '')[:200],
                            "seo_keywords": sp.get('seo_keywords', ''),
                            "category_ids": [],
                            "attributes": {
                                "finish": sp.get('finish') or '',
                                "material": sp.get('material') or '',
                                "size": sp.get('size') or '',
                                "color": sp.get('color') or '',
                                "thickness": sp.get('thickness') or '',
                                "suitability": sp.get('suitability') or '',
                                "edge": sp.get('edge') or '',
                                "slip_rating": sp.get('slip_rating') or ''
                            },
                            "finish": sp.get('finish') or '',
                            "material": sp.get('material') or '',
                            "size": sp.get('size') or '',
                            "color": sp.get('color') or '',
                            # ARRAY FIELDS — required for storefront colour/material/style aggregation
                            # (previously omitted, causing "1 COLOUR" on the collection card
                            # even after saving multiple colour variants via Bulk Category Editor)
                            "colors": sp.get('colors', []) or ([sp.get('color')] if sp.get('color') else []),
                            "materials": sp.get('materials', []) or ([sp.get('material')] if sp.get('material') else []),
                            "styles": sp.get('styles', []),
                            "features": sp.get('features', []),
                            "rooms": sp.get('rooms', []),
                            "series": sp.get('series') or '',
                            "original_series": sp.get('original_series') or '',
                            "thickness": sp.get('thickness') or '',
                            "suitability": sp.get('suitability') or '',
                            "edge": sp.get('edge') or '',
                            "slip_rating": sp.get('slip_rating') or '',
                            "images": sp.get('images', []),
                            "stock": sp.get('stock_m2', 0) or sp.get('stock', 0) or 100,
                            "sqm_per_box": sp.get('sqm_per_box'),
                            "tiles_per_box": sp.get('tiles_per_box'),
                            "tile_width": sp.get('tile_width'),
                            "tile_height": sp.get('tile_height'),
                            "is_active": True,
                            "is_featured": False,
                            "is_manual": False,
                            "source": "supplier_sync",
                            "source_supplier": sp.get('supplier'),
                            "product_group": sp.get('product_group') or "tiles",
                            "labels": sp.get('labels', []),
                            "tier_pricing_disabled": sp.get('tier_pricing_disabled', False),
                            "has_custom_tier_pricing": sp.get('has_custom_tier_pricing', False),
                            "tier_discounts": sp.get('tier_discounts'),
                            "tier_thresholds": sp.get('tier_thresholds'),
                            "trade_discount": sp.get('trade_discount'),
                            "credit_back_rate": sp.get('credit_back_rate'),
                            "sale_active": sp.get('sale_active', False),
                            "was_price": sp.get('was_price'),
                            "discount_percentage": sp.get('discount_percentage'),
                            "sale_savings": sp.get('sale_savings'),
                            "main_category": sp.get('main_category', ''),
                            "sub_categories": sp.get('sub_categories', []),
                            "website_categories": sp.get('website_categories', {}),
                            "show_on_website": True,
                            "created_at": datetime.now(timezone.utc),
                            "updated_at": datetime.now(timezone.utc),
                        }
                        
                        db.tiles.insert_one(tile_doc)
                        auto_published += 1
                        
                        # Also mark as published in supplier_products
                        db.supplier_products.update_one(
                            {qf: sku_val},
                            {"$set": {"show_on_website": True, "in_products_db": True, "visibility": "published", "status": "active"}}
                        )
                    except Exception as pub_err:
                        auto_publish_errors.append(f"{sku_val}: {str(pub_err)[:50]}")
                        logger.warning(f"Auto-publish error for {sku_val}: {pub_err}")
                
                if auto_published > 0:
                    logger.info(f"Auto-published {auto_published} products to tiles collection")
        
        logger.info(f"Unified bulk update: {staging_updated} staging, {supplier_updated} supplier, {products_updated} products, {tiles_updated} tiles, {auto_published} auto-published")
        
        # 5. Process fields_to_clear - remove specific values from products
        fields_cleared = 0
        if fields_to_clear:
            known_array_fields = {"rooms", "materials", "styles", "colors", "features", "sub_categories"}
            spec_to_attr_clear = {"material", "finish", "thickness", "suitability", "edge", "slip_rating", "size", "color", "type", "pot_life", "adhesive", "origin"}
            
            for collection in [db.sync_staging, db.supplier_products, db.products, db.tiles]:
                qf = id_field or "sku"
                query = {qf: {"$in": product_ids}}
                
                pull_ops = {}
                scalar_clear_fields = []
                
                for field, values in fields_to_clear.items():
                    if field in known_array_fields:
                        # Array field: pull specific values
                        pull_ops[field] = {"$in": values}
                    else:
                        # Scalar field: unset only for products whose current value matches
                        scalar_clear_fields.append((field, values))
                        # Also handle attributes.* mirror if applicable
                
                if pull_ops:
                    collection.update_many(query, {"$pull": pull_ops})
                
                # For scalar fields, target only products with matching values
                for field, values in scalar_clear_fields:
                    scalar_query = {**query, field: {"$in": values}}
                    unset_doc = {field: ""}
                    if field in spec_to_attr_clear:
                        unset_doc[f"attributes.{field}"] = ""
                    collection.update_many(scalar_query, {"$unset": unset_doc})
            
            fields_cleared = len(fields_to_clear)
            logger.info(f"Cleared {fields_cleared} fields from {len(product_ids)} products: {list(fields_to_clear.keys())}")
        
        # 6. AUTO-SYNC: Sync any new categories to website_categories collection
        categories_synced = 0
        try:
            if CATEGORY_SYNC_AVAILABLE:
                sync_result = sync_bulk_update_categories_sync(db, updates)
                categories_synced = sync_result.get("categories_synced", 0)
            else:
                # Fallback: basic category sync without utility
                categories_to_sync = set()
                if updates.get("category"):
                    categories_to_sync.add(updates["category"])
                if updates.get("material"):
                    categories_to_sync.add(updates["material"])
                if updates.get("finish"):
                    categories_to_sync.add(updates["finish"])
                
                for cat_name in categories_to_sync:
                    if not cat_name or not cat_name.strip():
                        continue
                    cat_name = cat_name.strip()
                    slug = cat_name.lower().replace(' ', '-').replace('&', 'and')
                    slug = ''.join(c if c.isalnum() or c == '-' else '' for c in slug)
                    
                    existing = db.website_categories.find_one({
                        "$or": [{"slug": slug}, {"name": {"$regex": f"^{cat_name}$", "$options": "i"}}]
                    })
                    
                    if not existing:
                        db.website_categories.insert_one({
                            "name": cat_name, "slug": slug, "description": f"{cat_name} tile collection",
                            "parent_id": None, "image_url": "", "display_order": 999, "is_active": True,
                            "show_on_homepage": False, "seo_title": cat_name,
                            "seo_description": f"Browse our {cat_name} collection", "product_count": 0,
                            "created_at": datetime.now(timezone.utc), "updated_at": datetime.now(timezone.utc)
                        })
                        categories_synced += 1
                        logger.info(f"Auto-created website category: {cat_name}")
        except Exception as sync_error:
            logger.warning(f"Category sync warning (non-critical): {sync_error}")
        
        # AUTO-UPDATE: Refresh category product counts after bulk edit
        counts_updated = 0
        try:
            if CATEGORY_SYNC_AVAILABLE and categories_synced > 0:
                result = update_category_product_counts_sync(db)
                counts_updated = result.get("categories_updated", 0)
                logger.info(f"Auto-updated {counts_updated} category product counts")
        except Exception as count_err:
            logger.warning(f"Category count update warning (non-critical): {count_err}")
        
        # Recalculate was_price when list price changes and sale is active
        if "price" in set_fields:
            try:
                new_list = float(set_fields["price"])
                for pid in product_ids:
                    query = {id_field: pid, "supplier": supplier} if supplier else {id_field: pid}
                    existing = db.supplier_products.find_one(
                        query,
                        {"was_markup_percent": 1, "sale_active": 1, "_id": 0}
                    )
                    if existing and existing.get("was_markup_percent") and existing.get("sale_active"):
                        markup_pct = float(existing["was_markup_percent"])
                        new_was = round(new_list * (1 + markup_pct / 100), 2)
                        new_discount_pct = round((markup_pct / (100 + markup_pct)) * 100, 1)
                        new_savings = round(new_was - new_list, 2)
                        sale_update = {"was_price": new_was, "discount_percentage": new_discount_pct, "sale_savings": new_savings}
                        db.supplier_products.update_one(query, {"$set": sale_update})
                        db.tiles.update_one({id_field: pid}, {"$set": sale_update})
                        logger.info(f"Recalculated WAS price for {pid}: list={new_list} was={new_was} discount={new_discount_pct}%")
            except Exception as e:
                logger.warning(f"WAS price recalculation warning: {e}")
        
        # SAFETY VERIFICATION — After all writes, RE-READ every affected product from
        # supplier_products and compare intended vs actual values for the fields the
        # admin set. Previous version sampled 10 products only; the owner ran into a
        # scoped-save bug where colours didn't stick for the products outside the
        # 10-product sample. Verifying all of them costs one bulk find_many() call
        # per batch — the trade-off is worth it (silent save = launch-blocker).
        verification_failures = []
        verification_checked = 0
        try:
            if product_ids and (set_fields or array_updates):
                qf = id_field or "sku"
                # Merge intended values from set_fields + array_updates (skip meta fields)
                intended = {}
                for k, v in set_fields.items():
                    if k in ("updated_at", "updated_by") or k.startswith("attributes."):
                        continue
                    intended[k] = v
                for k, v in array_updates.items():
                    intended[k] = v
                
                if intended:
                    projection = {"_id": 0, qf: 1, **{k: 1 for k in intended.keys()}}
                    saved_docs = {d.get(qf): d for d in db.supplier_products.find({qf: {"$in": list(product_ids)}}, projection)}
                    for pid in product_ids:
                        sp_doc = saved_docs.get(pid)
                        if not sp_doc:
                            verification_failures.append({"sku": pid, "field": "__missing__", "expected": "product record", "actual": None})
                            continue
                        for k, expected in intended.items():
                            actual = sp_doc.get(k)
                            # Normalise for comparison
                            if isinstance(expected, list) and isinstance(actual, list):
                                if set(map(str, expected)) != set(map(str, actual)):
                                    verification_failures.append({"sku": pid, "field": k, "expected": expected, "actual": actual})
                            elif expected != actual:
                                # Allow None ≈ "" ≈ 0 flex — anything else is a real mismatch
                                if not (expected in (None, "", 0) and actual in (None, "", 0)):
                                    verification_failures.append({"sku": pid, "field": k, "expected": expected, "actual": actual})
                        verification_checked += 1
                if verification_failures:
                    logger.warning(f"Bulk save verification: {len(verification_failures)} field mismatch(es) across {verification_checked} products (100% checked)")
        except Exception as ver_err:
            logger.warning(f"Bulk save verification skipped: {ver_err}")
        
        return {
            "success": True,
            "staging_updated": staging_updated,
            "supplier_products_updated": supplier_updated,
            "products_updated": products_updated,
            "categories_synced": categories_synced,
            "counts_updated": counts_updated,
            "fields_cleared": fields_cleared,
            "auto_published": auto_published,
            "auto_publish_errors": auto_publish_errors[:5] if auto_publish_errors else [],
            "updated_count": max(staging_updated, supplier_updated, products_updated),
            "verification_checked": verification_checked,
            "verification_failures": verification_failures,  # full list
            "verification_ok": len(verification_failures) == 0,
            "message": f"Updated {staging_updated} staging, {supplier_updated} supplier, {products_updated} website products. Synced {categories_synced} new categories. Cleared {fields_cleared} fields. Auto-published {auto_published} products to storefront."
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unified bulk update error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/categories/update-counts")
def update_category_counts():
    """
    Update product counts for all website categories.
    Call this after bulk updates or periodically to keep counts accurate.
    """
    try:
        db = get_db()
        
        if CATEGORY_SYNC_AVAILABLE:
            result = update_category_product_counts_sync(db)
            return {
                "success": True,
                "message": f"Updated {result.get('categories_updated', 0)} category counts"
            }
        else:
            # Fallback: basic count update
            categories = list(db.website_categories.find({}))
            updated = 0
            
            for cat in categories:
                count = db.supplier_products.count_documents({
                    "$or": [
                        {"category": cat["name"]},
                        {"category": {"$regex": f"^{cat['name']}$", "$options": "i"}}
                    ],
                    "show_on_website": True
                })
                
                db.website_categories.update_one(
                    {"_id": cat["_id"]},
                    {"$set": {"product_count": count, "updated_at": datetime.now(timezone.utc)}}
                )
                updated += 1
            
            return {"success": True, "message": f"Updated {updated} category counts"}
            
    except Exception as e:
        logger.error(f"Update category counts error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/categories/sync-all")
def sync_all_categories_to_website():
    """
    Sync all unique categories from products to website_categories.
    Creates any missing categories in the website_categories collection.
    """
    try:
        db = get_db()
        
        # Get all unique categories from supplier_products
        product_categories = db.supplier_products.distinct("category")
        
        synced = 0
        existing = 0
        
        for cat_name in product_categories:
            if not cat_name or not cat_name.strip():
                continue
            
            if CATEGORY_SYNC_AVAILABLE:
                result = sync_category_to_website_sync(db, cat_name, auto_create=True)
                if result:
                    synced += 1
            else:
                # Fallback
                cat_name = cat_name.strip()
                slug = cat_name.lower().replace(' ', '-').replace('&', 'and')
                slug = ''.join(c if c.isalnum() or c == '-' else '' for c in slug)
                
                exists = db.website_categories.find_one({
                    "$or": [{"slug": slug}, {"name": {"$regex": f"^{cat_name}$", "$options": "i"}}]
                })
                
                if exists:
                    existing += 1
                else:
                    db.website_categories.insert_one({
                        "name": cat_name, "slug": slug, "description": f"{cat_name} tile collection",
                        "parent_id": None, "image_url": "", "display_order": 999, "is_active": True,
                        "show_on_homepage": False, "seo_title": cat_name,
                        "seo_description": f"Browse our {cat_name} collection", "product_count": 0,
                        "created_at": datetime.now(timezone.utc), "updated_at": datetime.now(timezone.utc)
                    })
                    synced += 1
        
        # Also update counts after syncing
        if CATEGORY_SYNC_AVAILABLE:
            update_category_product_counts_sync(db)
        
        total = db.website_categories.count_documents({})
        
        return {
            "success": True,
            "synced": synced,
            "existing": existing,
            "total_categories": total,
            "message": f"Synced {synced} new categories. {existing} already existed. Total: {total}"
        }
        
    except Exception as e:
        logger.error(f"Sync all categories error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============ BULK EDIT TEMPLATES ENDPOINTS ============

@router.get("/bulk-edit-templates")
def get_bulk_edit_templates():
    """Get all saved bulk edit templates"""
    try:
        db = get_db()
        templates = list(db.bulk_edit_templates.find({}, {"_id": 0}))
        return {"success": True, "templates": templates}
    except Exception as e:
        logger.error(f"Error fetching templates: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/bulk-edit-templates")
def save_bulk_edit_template(data: dict):
    """Save a new bulk edit template"""
    try:
        db = get_db()
        
        name = data.get("name", "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="Template name is required")
        
        # Check for duplicate name
        existing = db.bulk_edit_templates.find_one({"name": name})
        if existing:
            raise HTTPException(status_code=400, detail="A template with this name already exists")
        
        template = {
            "id": f"template_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}_{name.lower().replace(' ', '_')[:20]}",
            "name": name,
            "selections": data.get("selections", {}),
            "show_on_website": data.get("show_on_website", False),
            "created_at": datetime.now(timezone.utc).isoformat()
        }
        
        db.bulk_edit_templates.insert_one(template)
        
        # Remove MongoDB _id before returning
        template.pop("_id", None)
        
        return {"success": True, "template": template}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error saving template: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/bulk-edit-templates/{template_id}")
def delete_bulk_edit_template(template_id: str):
    """Delete a bulk edit template"""
    try:
        db = get_db()
        result = db.bulk_edit_templates.delete_one({"id": template_id})
        
        if result.deleted_count == 0:
            raise HTTPException(status_code=404, detail="Template not found")
        
        return {"success": True, "message": "Template deleted"}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting template: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============ WEBSITE CATEGORIES ENDPOINTS ============

@router.post("/products/bulk-update-website-categories")
def bulk_update_website_categories(data: dict):
    """
    Bulk update website categories for multiple products.
    Used by the Bulk Category Editor in SupplierProducts page.
    
    Expects:
    {
        "product_ids": ["id1", "id2", ...] or None for using skus,
        "skus": ["sku1", "sku2", ...] or None for using product_ids,
        "supplier": "Verona" (optional, filter by supplier),
        "website_categories": {
            "rooms": ["floor", "bathroom"],
            "styles": ["marble_effect"],
            "colors": ["white", "grey"],
            "features": ["anti_slip"]
        },
        "show_on_website": true/false,
        "mode": "replace" or "append"  # replace overwrites, append adds to existing
    }
    """
    try:
        db = get_db()
        
        product_ids = data.get("product_ids", [])
        skus = data.get("skus", [])
        supplier = normalise_filter_value(data.get("supplier"))
        website_categories = data.get("website_categories", {})
        show_on_website = data.get("show_on_website")
        mode = data.get("mode", "replace")
        
        if not product_ids and not skus:
            raise HTTPException(status_code=400, detail="Either product_ids or skus required")
        
        if not website_categories and show_on_website is None:
            raise HTTPException(status_code=400, detail="Nothing to update")
        
        # Build query for supplier_products
        query = {}
        if skus:
            query["sku"] = {"$in": skus}
        supplier = normalise_filter_value(supplier)
        if supplier:
            query["supplier"] = supplier
        
        # Build update data
        update_fields = {}
        
        if mode == "replace" and website_categories:
            update_fields["website_categories"] = website_categories
        
        if show_on_website is not None:
            update_fields["show_on_website"] = show_on_website
        
        update_fields["updated_at"] = datetime.now(timezone.utc).isoformat()
        
        # Update supplier_products
        supplier_updated = 0
        products_updated = 0
        
        if skus:
            if mode == "append" and website_categories:
                # For append mode, we need to update each product individually
                for sku in skus:
                    doc_query = {"sku": sku}
                    if supplier:
                        doc_query["supplier"] = supplier
                    
                    existing = db.supplier_products.find_one(doc_query)
                    if existing:
                        existing_cats = existing.get("website_categories", {})
                        merged_cats = {}
                        for cat_type in ["rooms", "styles", "colors", "features"]:
                            existing_values = set(existing_cats.get(cat_type, []))
                            new_values = set(website_categories.get(cat_type, []))
                            merged_cats[cat_type] = list(existing_values | new_values)
                        
                        db.supplier_products.update_one(
                            doc_query,
                            {"$set": {
                                "website_categories": merged_cats,
                                "updated_at": datetime.now(timezone.utc).isoformat(),
                                **({"show_on_website": show_on_website} if show_on_website is not None else {})
                            }}
                        )
                        supplier_updated += 1
            else:
                result = db.supplier_products.update_many(query, {"$set": update_fields})
                supplier_updated = result.modified_count
        
        # Also update products collection if products have been synced there
        if skus:
            products_query = {"sku": {"$in": skus}}
            
            if mode == "append" and website_categories:
                # For append mode in products collection
                for sku in skus:
                    existing = db.products.find_one({"sku": sku})
                    if existing:
                        existing_cats = existing.get("website_categories", {})
                        merged_cats = {}
                        for cat_type in ["rooms", "styles", "colors", "features"]:
                            existing_values = set(existing_cats.get(cat_type, []))
                            new_values = set(website_categories.get(cat_type, []))
                            merged_cats[cat_type] = list(existing_values | new_values)
                        
                        db.products.update_one(
                            {"sku": sku},
                            {"$set": {
                                "website_categories": merged_cats,
                                "updated_at": datetime.now(timezone.utc).isoformat(),
                                **({"show_on_website": show_on_website} if show_on_website is not None else {})
                            }}
                        )
                        products_updated += 1
            else:
                result = db.products.update_many(products_query, {"$set": update_fields})
                products_updated = result.modified_count
        
        return {
            "success": True,
            "supplier_products_updated": supplier_updated,
            "products_updated": products_updated,
            "total_updated": supplier_updated + products_updated,
            "message": f"Updated {supplier_updated} supplier products and {products_updated} main products"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Bulk update website categories error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/website-category-options")
def get_website_category_options():
    """
    Get all website category options including custom ones added by user.
    Returns the default options merged with any custom options from the database.
    """
    try:
        db = get_db()
        
        # Default options (hardcoded in frontend currently)
        default_options = {
            # Room/Location = Where the tile can be used (multi-select)
            "rooms": [
                {"id": "bathroom", "label": "Bathroom", "color": "bg-cyan-500"},
                {"id": "kitchen", "label": "Kitchen", "color": "bg-orange-500"},
                {"id": "living_room", "label": "Living Room", "color": "bg-indigo-500"},
                {"id": "bedroom", "label": "Bedroom", "color": "bg-pink-400"},
                {"id": "hallway", "label": "Hallway", "color": "bg-violet-500"},
                {"id": "conservatory", "label": "Conservatory", "color": "bg-lime-500"},
                {"id": "outdoor", "label": "Outdoor/Patio", "color": "bg-green-500"},
                {"id": "commercial", "label": "Commercial", "color": "bg-slate-500"},
                {"id": "wet_room", "label": "Wet Room", "color": "bg-teal-500"},
                {"id": "pool_area", "label": "Pool Area", "color": "bg-sky-500"}
            ],
            # Tile Type = What the tile IS (single select)
            "types": [
                {"id": "floor_tiles", "label": "Floor Tiles", "color": "bg-amber-500"},
                {"id": "wall_tiles", "label": "Wall Tiles", "color": "bg-blue-500"},
                {"id": "wall_floor_tiles", "label": "Wall & Floor Tiles", "color": "bg-purple-500"},
                {"id": "mosaic", "label": "Mosaic", "color": "bg-teal-500"},
                {"id": "feature", "label": "Feature Tile", "color": "bg-pink-500"},
                {"id": "border", "label": "Border/Trim", "color": "bg-gray-500"},
                {"id": "decor", "label": "Décor", "color": "bg-rose-500"},
                {"id": "skirting", "label": "Skirting", "color": "bg-stone-500"}
            ],
            "edges": [
                {"id": "rectified", "label": "Rectified", "color": "bg-blue-600"},
                {"id": "cushion", "label": "Cushion Edge", "color": "bg-amber-500"},
                {"id": "bevelled", "label": "Bevelled", "color": "bg-purple-500"},
                {"id": "pressed", "label": "Pressed Edge", "color": "bg-green-500"},
                {"id": "natural", "label": "Natural Edge", "color": "bg-stone-500"}
            ],
            "slip_ratings": [
                {"id": "r9", "label": "R9", "color": "bg-green-400"},
                {"id": "r10", "label": "R10", "color": "bg-green-500"},
                {"id": "r11", "label": "R11", "color": "bg-yellow-500"},
                {"id": "r12", "label": "R12", "color": "bg-orange-500"},
                {"id": "r13", "label": "R13", "color": "bg-red-500"},
                {"id": "pei_1", "label": "PEI 1", "color": "bg-blue-300"},
                {"id": "pei_2", "label": "PEI 2", "color": "bg-blue-400"},
                {"id": "pei_3", "label": "PEI 3", "color": "bg-blue-500"},
                {"id": "pei_4", "label": "PEI 4", "color": "bg-blue-600"},
                {"id": "pei_5", "label": "PEI 5", "color": "bg-blue-700"}
            ],
            "suitabilities": [
                {"id": "residential", "label": "Residential", "color": "bg-green-500"},
                {"id": "commercial_light", "label": "Light Commercial", "color": "bg-yellow-500"},
                {"id": "commercial_heavy", "label": "Heavy Commercial", "color": "bg-orange-500"},
                {"id": "exterior", "label": "Exterior Use", "color": "bg-blue-500"},
                {"id": "wet_areas", "label": "Wet Areas", "color": "bg-cyan-500"},
                {"id": "shower", "label": "Shower Safe", "color": "bg-teal-500"},
                {"id": "pool", "label": "Pool Surround", "color": "bg-sky-500"}
            ],
            "materials": [
                {"id": "porcelain", "label": "Porcelain", "color": "bg-blue-600"},
                {"id": "ceramic", "label": "Ceramic", "color": "bg-amber-600"},
                {"id": "natural_stone", "label": "Natural Stone", "color": "bg-stone-600"},
                {"id": "marble", "label": "Marble", "color": "bg-gray-300 border border-gray-400"},
                {"id": "travertine", "label": "Travertine", "color": "bg-amber-300"},
                {"id": "slate", "label": "Slate", "color": "bg-slate-600"},
                {"id": "limestone", "label": "Limestone", "color": "bg-stone-400"},
                {"id": "granite", "label": "Granite", "color": "bg-gray-600"},
                {"id": "glass", "label": "Glass", "color": "bg-sky-400"},
                {"id": "terracotta", "label": "Terracotta", "color": "bg-orange-600"},
                {"id": "quarry", "label": "Quarry", "color": "bg-red-700"},
                {"id": "encaustic", "label": "Encaustic", "color": "bg-rose-500"}
            ],
            "styles": [
                {"id": "marble_effect", "label": "Marble Effect", "color": "bg-gray-400"},
                {"id": "wood_effect", "label": "Wood Effect", "color": "bg-amber-700"},
                {"id": "stone_effect", "label": "Stone Effect", "color": "bg-stone-500"},
                {"id": "concrete_effect", "label": "Concrete Effect", "color": "bg-gray-500"},
                {"id": "patterned", "label": "Patterned", "color": "bg-pink-500"},
                {"id": "metro", "label": "Metro/Subway", "color": "bg-sky-500"},
                {"id": "terrazzo", "label": "Terrazzo", "color": "bg-rose-400"},
                {"id": "hexagon", "label": "Hexagon", "color": "bg-violet-500"},
                {"id": "mosaic", "label": "Mosaic", "color": "bg-teal-500"},
                {"id": "brick_effect", "label": "Brick Effect", "color": "bg-red-600"},
                {"id": "plain", "label": "Plain/Solid", "color": "bg-neutral-400"},
                {"id": "onyx_effect", "label": "Onyx Effect", "color": "bg-emerald-600"},
                {"id": "zellige", "label": "Zellige", "color": "bg-cyan-600"},
                {"id": "splitface", "label": "Splitface/3D", "color": "bg-stone-700"}
            ],
            "colors": [
                {"id": "white", "label": "White", "color": "bg-white border border-gray-300"},
                {"id": "grey", "label": "Grey", "color": "bg-gray-400"},
                {"id": "black", "label": "Black", "color": "bg-gray-900"},
                {"id": "beige", "label": "Beige", "color": "bg-amber-200"},
                {"id": "cream", "label": "Cream", "color": "bg-amber-50 border border-gray-200"},
                {"id": "brown", "label": "Brown", "color": "bg-amber-800"},
                {"id": "blue", "label": "Blue", "color": "bg-blue-500"},
                {"id": "green", "label": "Green", "color": "bg-green-500"},
                {"id": "pink", "label": "Pink", "color": "bg-pink-400"},
                {"id": "gold", "label": "Gold", "color": "bg-yellow-500"},
                {"id": "silver", "label": "Silver", "color": "bg-slate-300"},
                {"id": "ivory", "label": "Ivory", "color": "bg-amber-50"},
                {"id": "sand", "label": "Sand", "color": "bg-yellow-200"},
                {"id": "taupe", "label": "Taupe", "color": "bg-stone-400"},
                {"id": "anthracite", "label": "Anthracite", "color": "bg-gray-700"},
                {"id": "terracotta", "label": "Terracotta", "color": "bg-orange-600"},
                {"id": "red", "label": "Red", "color": "bg-red-500"},
                {"id": "yellow", "label": "Yellow", "color": "bg-yellow-400"},
                {"id": "orange", "label": "Orange", "color": "bg-orange-500"},
                {"id": "purple", "label": "Purple", "color": "bg-purple-500"},
                {"id": "teal", "label": "Teal", "color": "bg-teal-500"},
                {"id": "navy", "label": "Navy", "color": "bg-blue-900"},
                {"id": "charcoal", "label": "Charcoal", "color": "bg-gray-600"},
                {"id": "graphite", "label": "Graphite", "color": "bg-gray-800"},
                {"id": "oak", "label": "Oak", "color": "bg-amber-600"},
                {"id": "walnut", "label": "Walnut", "color": "bg-amber-900"},
                {"id": "natural", "label": "Natural", "color": "bg-stone-300"},
                {"id": "multicolour", "label": "Multicolour", "color": "bg-gradient-to-r from-red-500 via-yellow-500 to-blue-500"}
            ],
            "finishes": [
                {"id": "matt", "label": "Matt", "color": "bg-gray-500"},
                {"id": "gloss", "label": "Gloss", "color": "bg-blue-400"},
                {"id": "polished", "label": "Polished", "color": "bg-slate-300"},
                {"id": "satin", "label": "Satin", "color": "bg-purple-400"},
                {"id": "lappato", "label": "Lappato", "color": "bg-indigo-400"},
                {"id": "natural", "label": "Natural", "color": "bg-stone-500"},
                {"id": "textured", "label": "Textured", "color": "bg-amber-600"},
                {"id": "honed", "label": "Honed", "color": "bg-gray-400"},
                {"id": "brushed", "label": "Brushed", "color": "bg-zinc-400"}
            ],
            "features": [
                {"id": "anti_slip", "label": "Anti-Slip", "color": "bg-yellow-500"},
                {"id": "large_format", "label": "Large Format", "color": "bg-indigo-500"},
                {"id": "small_format", "label": "Small Format", "color": "bg-pink-500"},
                {"id": "rectified", "label": "Rectified", "color": "bg-blue-600"},
                {"id": "underfloor_heating", "label": "Underfloor Heating", "color": "bg-orange-500"},
                {"id": "frost_resistant", "label": "Frost Resistant", "color": "bg-cyan-600"},
                {"id": "wet_room", "label": "Wet Room Safe", "color": "bg-teal-500"},
                {"id": "eco_friendly", "label": "Eco Friendly", "color": "bg-green-600"}
            ],
            # Main Categories - Primary product classification (single select)
            "main_categories": [
                {"id": "wall_floor_tiles", "label": "Wall & Floor Tiles", "color": "bg-purple-600"},
                {"id": "wall_tiles_only", "label": "Wall Tiles Only", "color": "bg-blue-600"},
                {"id": "floor_tiles_only", "label": "Floor Tiles Only", "color": "bg-amber-600"},
                {"id": "outdoor_tiles", "label": "Outdoor Tiles", "color": "bg-green-600"},
                {"id": "mosaic", "label": "Mosaic", "color": "bg-teal-600"},
                {"id": "feature_tiles", "label": "Feature Tiles", "color": "bg-pink-600"},
                {"id": "border_trim", "label": "Border & Trim", "color": "bg-gray-600"}
            ],
            # Sub-Categories - Secondary classification tags (multi-select)
            "sub_categories": [
                {"id": "wall_tiles", "label": "Wall Tiles", "color": "bg-blue-500"},
                {"id": "floor_tiles", "label": "Floor Tiles", "color": "bg-amber-500"},
                {"id": "large_format", "label": "Large Format", "color": "bg-indigo-500"},
                {"id": "small_format", "label": "Small Format", "color": "bg-pink-500"},
                {"id": "decor", "label": "Decor", "color": "bg-rose-500"},
                {"id": "plain", "label": "Plain", "color": "bg-gray-500"},
                {"id": "patterned", "label": "Patterned", "color": "bg-violet-500"},
                {"id": "wood_effect", "label": "Wood Effect", "color": "bg-amber-700"},
                {"id": "stone_effect", "label": "Stone Effect", "color": "bg-stone-600"},
                {"id": "marble_effect", "label": "Marble Effect", "color": "bg-gray-400"},
                {"id": "concrete_effect", "label": "Concrete Effect", "color": "bg-gray-600"},
                {"id": "terrazzo", "label": "Terrazzo", "color": "bg-rose-400"},
                {"id": "subway_metro", "label": "Subway/Metro", "color": "bg-sky-500"},
                {"id": "hexagon", "label": "Hexagon", "color": "bg-violet-600"},
                {"id": "brick_effect", "label": "Brick Effect", "color": "bg-red-600"}
            ],
            # Country of Origin - Where the tile is made (single select)
            "countries": [
                {"id": "Italy", "label": "🇮🇹 Italy", "color": "bg-green-600"},
                {"id": "Spain", "label": "🇪🇸 Spain", "color": "bg-red-600"},
                {"id": "Europe", "label": "🇪🇺 Europe", "color": "bg-blue-600"},
                {"id": "Poland", "label": "🇵🇱 Poland", "color": "bg-pink-500"},
                {"id": "India", "label": "🇮🇳 India", "color": "bg-orange-600"},
                {"id": "China", "label": "🇨🇳 China", "color": "bg-red-500"},
                {"id": "Turkey", "label": "🇹🇷 Turkey", "color": "bg-red-700"},
                {"id": "Portugal", "label": "🇵🇹 Portugal", "color": "bg-green-700"},
                {"id": "UK", "label": "🇬🇧 UK", "color": "bg-blue-700"},
                {"id": "Morocco", "label": "🇲🇦 Morocco", "color": "bg-red-800"},
                {"id": "Vietnam", "label": "🇻🇳 Vietnam", "color": "bg-yellow-600"},
                {"id": "Brazil", "label": "🇧🇷 Brazil", "color": "bg-green-500"}
            ],
            # Thickness options
            "thicknesses": [
                {"id": "6mm", "label": "6mm", "color": "bg-gray-400"},
                {"id": "8mm", "label": "8mm", "color": "bg-gray-500"},
                {"id": "9mm", "label": "9mm", "color": "bg-gray-500"},
                {"id": "10mm", "label": "10mm", "color": "bg-gray-600"},
                {"id": "11mm", "label": "11mm", "color": "bg-gray-600"},
                {"id": "12mm", "label": "12mm", "color": "bg-gray-700"},
                {"id": "14mm", "label": "14mm", "color": "bg-gray-700"},
                {"id": "20mm", "label": "20mm", "color": "bg-gray-800"}
            ]
        }
        
        # Get custom options from database
        custom_options = db.website_category_custom_options.find_one({"_id": "custom_options"})
        
        # Get deleted defaults from database
        deleted_defaults_doc = db.website_category_custom_options.find_one({"_id": "deleted_defaults"}) or {}
        
        # Filter out deleted defaults from default_options
        for category_type in list(default_options.keys()):
            deleted_ids = deleted_defaults_doc.get(category_type, [])
            if deleted_ids:
                # Flatten list in case it contains nested lists
                flat_deleted_ids = []
                for item in deleted_ids:
                    if isinstance(item, list):
                        flat_deleted_ids.extend(item)
                    else:
                        flat_deleted_ids.append(item)
                
                # Convert to lowercase for case-insensitive matching
                deleted_ids_lower = [str(d).lower() for d in flat_deleted_ids]
                
                default_options[category_type] = [
                    opt for opt in default_options[category_type] 
                    if str(opt.get("id", "")).lower() not in deleted_ids_lower 
                    and str(opt.get("label", "")).lower() not in deleted_ids_lower
                ]
        
        if custom_options:
            # Merge custom options with defaults - include all category types
            for category_type in ["rooms", "types", "edges", "slip_ratings", "suitabilities", "materials", "styles", "colors", "finishes", "features", "main_categories", "sub_categories", "countries", "thicknesses"]:
                if category_type not in default_options:
                    default_options[category_type] = []
                custom_list = custom_options.get(category_type, [])
                # Add custom options that don't already exist
                existing_ids = {opt["id"] for opt in default_options.get(category_type, [])}
                for custom in custom_list:
                    if custom.get("id") not in existing_ids:
                        default_options[category_type].append(custom)
            
            # Also add any entirely NEW custom category types (like "flooring")
            for key, value in custom_options.items():
                if key not in default_options and key != "_id" and key != "created_at" and isinstance(value, list):
                    default_options[key] = value
        
        return default_options
        
    except Exception as e:
        logger.error(f"Get website category options error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/website-category-options")
def add_website_category_option(data: dict):
    """
    Add a new custom category option or create a new category type.
    
    Expects:
    {
        "category_type": "rooms" | "styles" | "colors" | "features" | "flooring" | any custom type,
        "id": "fireplace",  # Unique ID (lowercase, underscores)
        "label": "Fireplace",  # Display name
        "color": "bg-red-500"  # Tailwind color class (optional)
    }
    """
    try:
        db = get_db()
        
        category_type = data.get("category_type")
        option_id = data.get("id")
        label = data.get("label")
        color = data.get("color", "bg-gray-500")
        
        # Allow any category type (including custom ones)
        if not category_type:
            raise HTTPException(status_code=400, detail="category_type is required")
        
        # Sanitize category type
        import re
        category_type = re.sub(r'[^a-z0-9_]', '_', category_type.lower().strip())
        
        if not option_id or not label:
            raise HTTPException(status_code=400, detail="id and label are required")
        
        # Sanitize the ID
        option_id = re.sub(r'[^a-z0-9_]', '_', option_id.lower().strip())
        
        # Check if option already exists in custom options (prevent duplicates)
        existing = db.website_category_custom_options.find_one({"_id": "custom_options"})
        if existing:
            existing_options = existing.get(category_type, [])
            for opt in existing_options:
                if opt.get("id") == option_id:
                    raise HTTPException(status_code=400, detail=f"Option '{label}' already exists")
        
        new_option = {
            "id": option_id,
            "label": label,
            "color": color,
            "custom": True,
            "created_at": datetime.now(timezone.utc).isoformat()
        }
        
        # Upsert the custom options document
        result = db.website_category_custom_options.update_one(
            {"_id": "custom_options"},
            {
                "$push": {category_type: new_option},
                "$setOnInsert": {"created_at": datetime.now(timezone.utc).isoformat()}
            },
            upsert=True
        )
        
        return {
            "success": True,
            "option": new_option,
            "message": f"Added '{label}' to {category_type}"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Add website category option error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/website-category-options/category/{category_type}")
def delete_entire_category(category_type: str):
    """
    Delete an entire custom category and all its options in ONE call.
    This is more efficient than deleting options one by one.
    NOTE: This route MUST be defined before the {category_type}/{option_id} route.
    """
    try:
        db = get_db()
        
        # Sanitize category type
        import re
        category_type = re.sub(r'[^a-z0-9_]', '_', category_type.lower().strip())
        
        # Remove the entire category from custom options
        result = db.website_category_custom_options.update_one(
            {"_id": "custom_options"},
            {"$unset": {category_type: ""}}
        )
        
        logger.info(f"Deleted entire category '{category_type}' - modified: {result.modified_count}")
        
        return {
            "success": True,
            "message": f"Deleted entire '{category_type}' category"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Delete entire category error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/website-category-options/{category_type}/{option_id}")
def delete_website_category_option(category_type: str, option_id: str):
    """
    Delete a category option (either custom or default).
    For default options, we store them in a 'deleted_defaults' collection to hide them.
    """
    try:
        db = get_db()
        
        # Allow deletion from any category type (standard or custom)
        # Sanitize category type
        import re
        category_type_clean = re.sub(r'[^a-z0-9_]', '_', category_type.lower().strip())
        
        # Sanitize option_id too
        option_id_clean = re.sub(r'[^a-z0-9_]', '_', option_id.lower().strip())
        
        # Try multiple matching strategies for custom options
        result = db.website_category_custom_options.update_one(
            {"_id": "custom_options"},
            {"$pull": {category_type_clean: {"id": option_id_clean}}}
        )
        
        # Try matching by original option_id (without cleaning)
        if result.modified_count == 0:
            result = db.website_category_custom_options.update_one(
                {"_id": "custom_options"},
                {"$pull": {category_type_clean: {"id": option_id}}}
            )
        
        # Also try matching by label (case-insensitive via regex)
        if result.modified_count == 0:
            result = db.website_category_custom_options.update_one(
                {"_id": "custom_options"},
                {"$pull": {category_type_clean: {"label": {"$regex": f"^{re.escape(option_id)}$", "$options": "i"}}}}
            )
        
        # If nothing was deleted from custom options, it might be a default option
        # Store it in deleted_defaults to hide it from the UI
        if result.modified_count == 0:
            # Add both cleaned and original IDs to deleted defaults
            db.website_category_custom_options.update_one(
                {"_id": "deleted_defaults"},
                {"$addToSet": {category_type_clean: {"$each": [option_id_clean, option_id]}}},
                upsert=True
            )
            logger.info(f"Marked default option '{option_id}' as deleted from {category_type_clean}")
        
        # If the entire custom category is empty after deletion, remove it
        custom_doc = db.website_category_custom_options.find_one({"_id": "custom_options"})
        if custom_doc and category_type_clean in custom_doc:
            if not custom_doc[category_type_clean] or len(custom_doc[category_type_clean]) == 0:
                db.website_category_custom_options.update_one(
                    {"_id": "custom_options"},
                    {"$unset": {category_type_clean: ""}}
                )
        
        return {
            "success": True,
            "message": f"Deleted option '{option_id}' from {category_type_clean}"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Delete website category option error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/website-category-options/{category_type}/{option_id}")
def update_website_category_option(category_type: str, option_id: str, data: dict):
    """
    Update a category option label.
    Works for both custom options and default options.
    For default options, creates an override in custom_options.
    """
    try:
        db = get_db()
        
        # Allow any category type (including custom categories)
        import re
        category_type_clean = re.sub(r'[^a-z0-9_]', '_', category_type.lower().strip())
        option_id_clean = option_id.lower().strip()
        
        new_label = data.get("label")
        if not new_label:
            raise HTTPException(status_code=400, detail="Label is required")
        
        logger.info(f"Updating option: category={category_type_clean}, option_id={option_id_clean}, new_label={new_label}")
        
        # Try to update in custom options first
        result = db.website_category_custom_options.update_one(
            {"_id": "custom_options", f"{category_type_clean}.id": option_id_clean},
            {"$set": {f"{category_type_clean}.$.label": new_label}}
        )
        
        if result.modified_count > 0:
            logger.info("Updated custom option successfully")
            return {
                "success": True,
                "message": f"Updated option '{option_id_clean}' label to '{new_label}'"
            }
        
        # If not found in custom options, check if it's a default option
        # and create an override in custom_options
        default_options = {
            "rooms": ["bathroom", "kitchen", "living_room", "bedroom", "hallway", "conservatory", "outdoor", "commercial", "wet_room", "pool_area"],
            "types": ["floor_tiles", "wall_tiles", "wall_floor_tiles", "mosaic", "feature", "border", "decor", "skirting"],
            "edges": ["rectified", "cushion", "bevelled", "pressed", "natural"],
            "slip_ratings": ["r9", "r10", "r11", "r12", "r13", "pei_1", "pei_2", "pei_3", "pei_4", "pei_5"],
            "suitabilities": ["residential", "commercial_light", "commercial_heavy", "exterior", "wet_areas", "shower", "pool"],
            "materials": ["porcelain", "ceramic", "natural_stone", "marble", "travertine", "slate", "limestone", "granite", "glass", "terracotta", "quarry", "encaustic"],
            "styles": ["marble_effect", "wood_effect", "stone_effect", "concrete_effect", "patterned", "metro", "terrazzo", "hexagon", "mosaic", "brick_effect", "plain", "onyx_effect", "zellige", "splitface"],
            "colors": ["white", "grey", "black", "beige", "cream", "brown", "blue", "green", "pink", "gold", "silver", "multicolour"],
            "finishes": ["matt", "gloss", "polished", "satin", "lappato", "natural", "textured", "honed", "brushed"],
            "features": ["anti_slip", "large_format", "small_format", "rectified", "underfloor_heating", "frost_resistant", "wet_room", "eco_friendly"],
            "main_categories": ["wall_floor_tiles", "wall_tiles_only", "floor_tiles_only", "outdoor_tiles", "mosaic", "feature_tiles", "border_trim"],
            "sub_categories": ["wall_tiles", "floor_tiles", "large_format", "small_format", "decor", "plain", "patterned", "wood_effect", "stone_effect", "marble_effect", "concrete_effect", "terrazzo", "subway_metro", "hexagon", "brick_effect"]
        }
        
        is_default = category_type_clean in default_options and option_id_clean in default_options.get(category_type_clean, [])
        
        if is_default:
            logger.info("Option is a default option, creating override in custom_options")
            # Create an override entry in custom_options with the new label
            # This will be merged with defaults in the GET response
            
            # Ensure custom_options document exists
            db.website_category_custom_options.update_one(
                {"_id": "custom_options"},
                {"$setOnInsert": {"_id": "custom_options"}},
                upsert=True
            )
            
            # Add the updated option to custom_options (this will override the default)
            new_option = {
                "id": option_id_clean,
                "label": new_label,
                "color": "bg-gray-500",  # Default color
                "is_override": True  # Mark as override of default
            }
            
            # Remove any existing entry with this id first, then add the new one
            db.website_category_custom_options.update_one(
                {"_id": "custom_options"},
                {"$pull": {category_type_clean: {"id": option_id_clean}}}
            )
            db.website_category_custom_options.update_one(
                {"_id": "custom_options"},
                {"$push": {category_type_clean: new_option}}
            )
            
            # Also mark the default as "deleted" so only the override shows
            db.website_category_custom_options.update_one(
                {"_id": "deleted_defaults"},
                {"$addToSet": {category_type_clean: option_id_clean}},
                upsert=True
            )
            
            logger.info("Created override for default option successfully")
            return {
                "success": True,
                "message": f"Updated default option '{option_id_clean}' label to '{new_label}'"
            }
        
        # Option not found anywhere
        logger.warning(f"Option not found: category={category_type_clean}, option_id={option_id_clean}")
        return {
            "success": False,
            "message": f"Option '{option_id_clean}' not found in category '{category_type_clean}'"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Update website category option error: {e}")
        raise HTTPException(status_code=500, detail=str(e))



@router.post("/fix-supplier-names/{supplier}")
def fix_supplier_product_names(supplier: str):
    """
    Fix product names for any supplier by applying the unique naming transformation.
    Supported suppliers: Splendour, Wallcano, Verona, Plus39, LEPORCE
    """
    try:
        from business_config.business_rules import get_display_name
        
        db = get_db()
        
        # Validate supplier
        valid_suppliers = ["Splendour", "Wallcano", "Verona", "Plus39", "LEPORCE", "Ceramica Impex"]
        if supplier not in valid_suppliers:
            raise HTTPException(status_code=400, detail=f"Invalid supplier. Valid options: {valid_suppliers}")
        
        # Get all products for this supplier
        products = list(db.supplier_products.find({'supplier': supplier}))
        logger.info(f"Found {len(products)} {supplier} products to fix")
        
        supplier_updates = 0
        main_db_updates = 0
        
        for p in products:
            original_name = p.get('name', '')
            current_product_name = p.get('product_name', '')
            finish = p.get('finish', '')
            sku = p.get('sku', '')
            
            # Apply the naming transformation
            new_name = get_display_name(original_name, supplier, finish)
            
            # Only update if the name actually changed
            if new_name != current_product_name:
                # Update supplier_products
                result = db.supplier_products.update_one(
                    {'_id': p['_id']},
                    {'$set': {
                        'product_name': new_name,
                        'updated_at': datetime.now(timezone.utc)
                    }}
                )
                if result.modified_count > 0:
                    supplier_updates += 1
                
                # Also update main Products database if product exists there
                main_result = db.products.update_one(
                    {'sku': sku},
                    {'$set': {
                        'name': new_name,
                        'supplier_product_name': original_name,
                        'updated_at': datetime.now(timezone.utc)
                    }}
                )
                if main_result.modified_count > 0:
                    main_db_updates += 1
        
        return {
            "success": True,
            "supplier": supplier,
            "total_products": len(products),
            "supplier_products_updated": supplier_updates,
            "main_products_updated": main_db_updates,
            "message": f"Fixed {supplier_updates} {supplier} supplier products and {main_db_updates} main products"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Fix {supplier} naming error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/products/fix-duplicate-words")
async def fix_duplicate_words(
    request: Request,
    current_user: dict = Depends(get_current_user)
):
    """
    Fix product names that have duplicate consecutive words (e.g., "12mm 12Mm" -> "12mm")
    """
    try:
        require_admin_access(current_user)
        
        db = get_db()
        body = await request.json()
        skus = body.get('skus', [])
        supplier = body.get('supplier')
        word_to_dedupe = body.get('word', '').lower()  # e.g., "12mm"
        
        if not skus and not supplier:
            raise HTTPException(status_code=400, detail="Provide either SKUs or supplier filter")
        
        import re
        
        # Build query
        query = {"deleted_at": {"$exists": False}}
        if skus:
            query["sku"] = {"$in": skus}
        supplier = normalise_filter_value(supplier)
        if supplier:
            query["supplier"] = supplier
        
        products = list(db.supplier_products.find(query))
        updated_count = 0
        
        for product in products:
            current_name = product.get('product_name', '') or product.get('name', '')
            if not current_name:
                continue
            
            new_name = current_name
            
            if word_to_dedupe:
                # Remove specific duplicate word (case insensitive)
                pattern = rf'({re.escape(word_to_dedupe)})\s+\1'
                new_name = re.sub(pattern, r'\1', new_name, flags=re.IGNORECASE)
            else:
                # Remove any consecutive duplicate words
                words = new_name.split()
                deduped_words = [words[0]] if words else []
                for i in range(1, len(words)):
                    if words[i].lower() != words[i-1].lower():
                        deduped_words.append(words[i])
                new_name = ' '.join(deduped_words)
            
            if new_name != current_name:
                db.supplier_products.update_one(
                    {"_id": product["_id"]},
                    {"$set": {"product_name": new_name}}
                )
                # Also update main products collection if exists
                db.products.update_one(
                    {"sku": product.get("sku")},
                    {"$set": {"product_name": new_name, "name": new_name}}
                )
                updated_count += 1
                logger.info(f"Fixed duplicate: '{current_name}' -> '{new_name}'")
        
        return {"success": True, "updated_count": updated_count}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Fix duplicate words error: {e}")
        raise HTTPException(status_code=500, detail=str(e))



@router.post("/products/bulk-rename-series")
async def bulk_rename_series(
    request: Request,
    current_user: dict = Depends(get_current_user)
):
    """
    Bulk edit product names - add characteristics while keeping sizes and finishes.
    
    Options:
    - insert_text: Text to insert at specified position
    - insert_position: Where to insert ('after_series', 'before_size', 'before_color', 'at_start', 'at_end', 'custom')
    - custom_insert_index: Word position for 'custom' mode (0-based)
    - add_cm_to_size: Add "cm" to size dimensions (e.g., 30x60 → 30x60cm)
    
    Example: "Ardesia Black 30x60 Matt" → "Ardesia Slate Effect Black 30x60cm Matt"
    """
    try:
        require_admin_access(current_user)
        
        db = get_db()
        
        body = await request.json()
        skus = body.get('skus', [])
        current_series_name = body.get('current_series_name', '').strip()
        new_series_name = body.get('new_series_name', '').strip()
        # Support both old and new parameter names
        insert_text = body.get('insert_text', '').strip() or body.get('insert_after_series', '').strip()
        insert_position = body.get('insert_position', 'after_series')
        custom_insert_index = body.get('custom_insert_index', 1)
        add_cm_to_size = body.get('add_cm_to_size', False)
        word_replacements = body.get('word_replacements', [])  # List of {from: 'word', to: 'newword'}
        supplier = body.get('supplier')
        supplier_product_name_override = body.get('supplier_product_name', '').strip() if body.get('supplier_product_name') else None
        supplier_name_replacements = body.get('supplier_name_replacements', [])  # Word replacements for supplier_product_name
        
        # Handle products array format (from template mode)
        products_array = body.get('products', [])
        if products_array:
            # Template mode: each product has its own new_product_name and new_supplier_product_name
            updated_supplier_products = 0
            updated_main_products = 0
            
            for prod in products_array:
                sku = prod.get('sku')
                prod_supplier = prod.get('supplier')
                new_product_name = prod.get('new_product_name', '').strip()
                new_supplier_name = prod.get('new_supplier_product_name', '').strip()
                
                if not sku or not new_product_name:
                    continue
                
                # Build query
                query = {"sku": sku}
                if prod_supplier:
                    query["supplier"] = prod_supplier
                
                # Get current product
                product = db.supplier_products.find_one(query)
                if not product:
                    continue
                
                original_name = product.get('name', '')
                
                # Update supplier_products
                update_fields = {
                    'product_name': new_product_name,
                    'name_locked': True,  # Lock name from sync overwrites
                    'name_locked_at': datetime.now(timezone.utc),
                    'updated_at': datetime.now(timezone.utc)
                }
                if new_supplier_name:
                    update_fields['supplier_product_name'] = new_supplier_name
                
                # Save the series name from template (e.g., "Himalaya Marble")
                series_name = prod.get('series_name', '').strip()
                if series_name:
                    update_fields['original_series'] = series_name
                    update_fields['series'] = series_name
                
                result = db.supplier_products.update_one(
                    {'_id': product['_id']},
                    {'$set': update_fields}
                )
                if result.modified_count > 0:
                    updated_supplier_products += 1
                
                # Update main products collection
                main_update_fields = {
                    'name': new_product_name,
                    'display_name': new_product_name,
                    'product_name': new_product_name,
                    'updated_at': datetime.now(timezone.utc)
                }
                if new_supplier_name:
                    main_update_fields['supplier_product_name'] = new_supplier_name
                else:
                    main_update_fields['supplier_product_name'] = original_name
                
                main_result = db.products.update_one(
                    {'sku': sku},
                    {'$set': main_update_fields}
                )
                if main_result.modified_count > 0:
                    updated_main_products += 1
                
                # Also update tiles collection if product is published
                if product.get('show_on_website'):
                    import re
                    new_slug = re.sub(r'[^a-z0-9]+', '-', new_product_name.lower()).strip('-')
                    tiles_update_fields = {
                        'name': new_product_name,
                        'display_name': new_product_name,
                        'slug': new_slug,
                        'updated_at': datetime.now(timezone.utc)
                    }
                    if series_name:
                        tiles_update_fields['original_series'] = series_name
                        tiles_update_fields['series'] = series_name
                    db.tiles.update_one(
                        {'sku': sku},
                        {'$set': tiles_update_fields}
                    )
            
            return {
                "success": True,
                "updated_count": updated_supplier_products,
                "main_db_updated": updated_main_products,
                "message": f"Updated {updated_supplier_products} products via template mode"
            }
        
        # Legacy support
        series_name = body.get('series_name', '').strip() or current_series_name
        
        if not skus:
            raise HTTPException(status_code=400, detail="No products selected")
        
        # Check if any changes are specified
        has_word_replacements = word_replacements and any(r.get('from') and r.get('to') is not None for r in word_replacements)
        has_supplier_name_replacements = supplier_name_replacements and any(r.get('from') and r.get('to') is not None for r in supplier_name_replacements)
        if not insert_text and not add_cm_to_size and not new_series_name and not has_word_replacements and not supplier_product_name_override and not has_supplier_name_replacements:
            raise HTTPException(status_code=400, detail="No changes specified")
        
        # Color words that should be protected from word replacements
        COLOR_WORDS = [
            'white', 'black', 'grey', 'gray', 'cream', 'beige', 'brown', 'red', 'blue', 'green', 
            'yellow', 'orange', 'pink', 'purple', 'gold', 'silver', 'bronze', 'ivory', 'sand',
            'charcoal', 'anthracite', 'taupe', 'graphite', 'pearl', 'bone', 'almond', 'caramel',
            'mocha', 'espresso', 'walnut', 'oak', 'ash', 'slate', 'stone', 'marble', 'granite',
            'terracotta', 'rust', 'copper', 'brass', 'champagne', 'rose', 'coral', 'mint',
            'teal', 'navy', 'cobalt', 'indigo', 'violet', 'lavender', 'mauve', 'burgundy',
            'bordeaux', 'wine', 'plum', 'aubergine', 'olive', 'sage', 'forest', 'emerald',
            'jade', 'aqua', 'turquoise', 'cyan', 'azure', 'sky', 'ocean', 'marine',
            'noir', 'blanc', 'gris', 'bianco', 'nero', 'grigio', 'crema', 'natural'
        ]
        
        updated_supplier_products = 0
        updated_main_products = 0
        
        import re
        
        def insert_at_position(name, text, position, custom_idx=1):
            """Insert text at the specified position in the product name"""
            if not text:
                return name
            
            words = name.split()
            
            if position == 'after_series':
                # Insert after first word (series name)
                if len(words) > 0:
                    words.insert(1, text)
            elif position == 'before_size':
                # Find size pattern and insert before it
                size_idx = next((i for i, w in enumerate(words) if re.match(r'^\d+[xX]\d+', w)), -1)
                if size_idx > 0:
                    words.insert(size_idx, text)
                elif len(words) > 1:
                    words.insert(1, text)
            elif position == 'before_color':
                # Find first color word and insert before it
                color_idx = next((i for i, w in enumerate(words) if w.lower() in COLOR_WORDS), -1)
                if color_idx > 0:
                    words.insert(color_idx, text)
                elif len(words) > 1:
                    words.insert(1, text)
            elif position == 'at_start':
                words.insert(0, text)
            elif position == 'at_end':
                words.append(text)
            elif position == 'custom':
                idx = min(max(0, custom_idx), len(words))
                words.insert(idx, text)
            else:
                # Default: after series
                if len(words) > 0:
                    words.insert(1, text)
            
            return ' '.join(words)
        
        for sku in skus:
            # Get the current product from supplier_products
            query = {"sku": sku}
            if supplier:
                query["supplier"] = supplier
            
            product = db.supplier_products.find_one(query)
            
            if not product:
                continue
            
            current_name = product.get('product_name', '') or product.get('name', '')
            original_name = product.get('name', '')
            
            if not current_name:
                continue
            
            new_product_name = current_name
            
            # Step 1: Replace series name if new one provided
            if new_series_name and series_name:
                pattern = rf'^{re.escape(series_name)}\s+'
                replacement = f'{new_series_name.title()} '
                new_product_name = re.sub(pattern, replacement, new_product_name, flags=re.IGNORECASE)
            
            # Step 2: Insert text at specified position
            if insert_text:
                new_product_name = insert_at_position(new_product_name, insert_text, insert_position, custom_insert_index)
            
            # Step 3: Add cm to sizes (e.g., 30x60 → 30x60cm, but not if already has cm/mm)
            if add_cm_to_size:
                # Match sizes like 30x60, 60X120, etc. that don't already have cm or mm
                # Note: (?![0-9cm]) ensures we don't match partial numbers (e.g., 30x6 in 30x60cm)
                new_product_name = re.sub(r'(\d+)[xX](\d+)(?![0-9cm])', r'\1x\2cm', new_product_name)
            
            # Step 4: Apply word replacements (protect colors and sizes)
            if word_replacements:
                for replacement in word_replacements:
                    from_word = replacement.get('from', '').strip()
                    to_word = replacement.get('to', '').strip() if replacement.get('to') is not None else ''
                    
                    if not from_word:
                        continue
                    
                    # Skip if trying to replace a color word
                    if from_word.lower() in COLOR_WORDS:
                        logger.info(f"Skipping protected color word: {from_word}")
                        continue
                    
                    # Skip if trying to replace a size pattern
                    if re.match(r'^\d+[xX]\d+(?:[xX]\d+)?(?:cm|mm)?$', from_word):
                        logger.info(f"Skipping size pattern: {from_word}")
                        continue
                    
                    # Replace whole words only (word boundaries)
                    pattern = rf'\b{re.escape(from_word)}\b'
                    new_product_name = re.sub(pattern, to_word, new_product_name, flags=re.IGNORECASE)
            
            # Step 5: Delete words marked for deletion
            words_to_delete = body.get('words_to_delete', [])
            if words_to_delete:
                words_to_delete_lower = [w.lower() for w in words_to_delete]
                name_words = new_product_name.split()
                filtered_words = [w for w in name_words if w.lower() not in words_to_delete_lower]
                new_product_name = ' '.join(filtered_words)
            
            # Step 6: Apply supplier_name_replacements to compute new supplier_product_name
            current_supplier_product_name = product.get('supplier_product_name', '') or original_name
            new_supplier_product_name = current_supplier_product_name
            
            if supplier_name_replacements:
                for replacement in supplier_name_replacements:
                    from_word = replacement.get('from', '')
                    to_word = replacement.get('to', '')
                    
                    if not from_word or to_word is None:
                        continue
                    
                    # Replace whole words only (word boundaries)
                    pattern = rf'\b{re.escape(from_word)}\b'
                    new_supplier_product_name = re.sub(pattern, to_word, new_supplier_product_name, flags=re.IGNORECASE)
            
            # Determine final supplier_product_name (override takes precedence)
            final_supplier_product_name = supplier_product_name_override if supplier_product_name_override else (
                new_supplier_product_name if new_supplier_product_name != current_supplier_product_name else None
            )
            
            # Only update if name actually changed
            if new_product_name == current_name and not final_supplier_product_name:
                continue
            
            # Save custom mapping to preserve this change across syncs
            # Maps: Original Supplier Name → Our Custom Display Name
            from services.custom_mappings import save_custom_mapping
            save_custom_mapping(
                db=db,
                supplier=product.get('supplier', supplier),
                sku=sku,
                original_name=original_name,  # Keep the original supplier name
                custom_name=new_product_name,
                user_email=current_user.get('email', 'system'),
                supplier_product_name=final_supplier_product_name  # Include computed supplier_product_name in custom mapping
            )
            
            # Update supplier_products - ONLY product_name (our display name)
            # Build update fields for supplier_products
            update_fields = {
                'product_name': new_product_name,
                # 'name' intentionally NOT updated - preserves original supplier name
                'updated_at': datetime.now(timezone.utc)
            }
            
            # Add supplier_product_name if computed from word replacements or override
            if final_supplier_product_name:
                update_fields['supplier_product_name'] = final_supplier_product_name
            
            # DO NOT update 'name' - that's the original supplier name and should be preserved
            result = db.supplier_products.update_one(
                {'_id': product['_id']},
                {'$set': update_fields}
            )
            if result.modified_count > 0:
                updated_supplier_products += 1
            
            # Build update fields for main products collection
            # CRITICAL: Must update BOTH 'name' AND 'product_name' for proper sync
            # The Edit Product page uses 'name' field, so we must update it
            main_update_fields = {
                'name': new_product_name,  # This is what Edit Product page shows
                'display_name': new_product_name,  # Keep in sync
                'product_name': new_product_name,  # Legacy field
                'updated_at': datetime.now(timezone.utc)
            }
            
            # Use computed supplier_product_name if available, otherwise keep original
            if final_supplier_product_name:
                main_update_fields['supplier_product_name'] = final_supplier_product_name
            else:
                main_update_fields['supplier_product_name'] = original_name  # Keep original supplier name
            
            # Also update main products collection if it exists there
            main_result = db.products.update_one(
                {'sku': sku},
                {'$set': main_update_fields}
            )
            if main_result.modified_count > 0:
                updated_main_products += 1
        
        return {
            "success": True,
            "updated_count": updated_supplier_products,
            "main_db_updated": updated_main_products,
            "custom_mappings_created": updated_supplier_products,
            "message": f"Updated {updated_supplier_products} products (custom mappings saved for future syncs)"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Bulk rename series error: {e}")
        raise HTTPException(status_code=500, detail=str(e))



# =============================================================================
# CUSTOM MAPPINGS ENDPOINTS
# =============================================================================
# These endpoints allow viewing and managing custom name mappings.
# Custom mappings preserve manual product name changes across syncs.

@router.get("/custom-mappings")
def get_all_custom_mappings(
    supplier: Optional[str] = None,
    limit: int = 1000
):
    """
    Get all custom mappings, optionally filtered by supplier.
    Custom mappings preserve manual product name changes across syncs.
    """
    try:
        db = get_db()
        
        query = {}
        supplier = normalise_filter_value(supplier)
        if supplier:
            query["supplier"] = supplier
        
        mappings = list(db.custom_mappings.find(query, {"_id": 0}).sort([
            ("supplier", 1),
            ("updated_at", -1)
        ]).limit(limit))
        
        # Get count by supplier
        pipeline = [
            {"$group": {"_id": "$supplier", "count": {"$sum": 1}}},
            {"$sort": {"_id": 1}}
        ]
        by_supplier = list(db.custom_mappings.aggregate(pipeline))
        
        return {
            "success": True,
            "total_count": len(mappings),
            "by_supplier": {item["_id"]: item["count"] for item in by_supplier},
            "mappings": mappings
        }
        
    except Exception as e:
        logger.error(f"Get custom mappings error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/custom-mappings/{supplier}/{sku}")
def delete_custom_mapping_endpoint(
    supplier: str,
    sku: str
):
    """
    Delete a custom mapping for a specific product.
    After deletion, the next sync will apply the default auto-generated name.
    """
    try:
        db = get_db()
        
        result = db.custom_mappings.delete_one({
            "supplier": supplier,
            "sku": sku
        })
        
        if result.deleted_count == 0:
            raise HTTPException(status_code=404, detail=f"No custom mapping found for {supplier}/{sku}")
        
        logger.info(f"Deleted custom mapping for {supplier}/{sku}")
        
        return {
            "success": True,
            "message": f"Custom mapping deleted for {supplier}/{sku}. Next sync will apply default naming."
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Delete custom mapping error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/custom-mappings")
def create_custom_mapping_endpoint(data: dict):
    """
    Manually create or update a custom mapping.
    
    Body:
    {
        "supplier": "Verona",
        "sku": "product-sku",
        "original_name": "Original supplier name",
        "custom_name": "Your custom display name"
    }
    """
    try:
        db = get_db()
        
        supplier = normalise_filter_value(data.get("supplier"))
        sku = data.get("sku")
        original_name = data.get("original_name", "")
        custom_name = data.get("custom_name")
        
        if not supplier or not sku or not custom_name:
            raise HTTPException(status_code=400, detail="supplier, sku, and custom_name are required")
        
        now = datetime.now(timezone.utc).isoformat()
        
        result = db.custom_mappings.update_one(
            {"supplier": supplier, "sku": sku},
            {
                "$set": {
                    "supplier": supplier,
                    "sku": sku,
                    "original_name": original_name,
                    "custom_name": custom_name,
                    "updated_at": now
                },
                "$setOnInsert": {"created_at": now}
            },
            upsert=True
        )
        
        action = "created" if result.upserted_id else "updated"
        logger.info(f"Custom mapping {action} for {supplier}/{sku}: '{custom_name}'")
        
        return {
            "success": True,
            "action": action,
            "message": f"Custom mapping {action} for {supplier}/{sku}"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Create custom mapping error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/custom-mappings/bulk")
def bulk_delete_custom_mappings(
    supplier: Optional[str] = None,
    confirm: str = None
):
    """
    Bulk delete custom mappings. Requires confirmation.
    
    Query params:
    - supplier: Filter by supplier (optional, if not provided deletes ALL)
    - confirm: Must be "DELETE_ALL" to confirm bulk deletion
    """
    try:
        if confirm != "DELETE_ALL":
            raise HTTPException(
                status_code=400, 
                detail="Confirmation required. Add ?confirm=DELETE_ALL to proceed."
            )
        
        db = get_db()
        
        query = {}
        supplier = normalise_filter_value(supplier)
        if supplier:
            query["supplier"] = supplier
        
        result = db.custom_mappings.delete_many(query)
        
        scope = f"for {supplier}" if supplier else "for ALL suppliers"
        logger.info(f"Bulk deleted {result.deleted_count} custom mappings {scope}")
        
        return {
            "success": True,
            "deleted_count": result.deleted_count,
            "message": f"Deleted {result.deleted_count} custom mappings {scope}"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Bulk delete custom mappings error: {e}")
        raise HTTPException(status_code=500, detail=str(e))



@router.post("/upload-product-image")
async def upload_product_image(
    image: UploadFile = File(...),
    product_id: str = Form(...),
    supplier: str = Form(None)
):
    """
    Upload an image for a supplier product.
    Stores the image in R2 cloud storage and updates the product's images array.
    """
    try:
        from bson import ObjectId
        import uuid as uuid_module
        
        db = get_db()
        
        if not product_id:
            raise HTTPException(status_code=400, detail="Product ID is required")
        
        logger.info(f"Uploading image for product {product_id}, supplier: {supplier}")
        
        # Validate file type - support common image formats including TIF.
        # Also check file extension for TIF files (some browsers may not
        # send correct MIME type) and to give a CLEAR rejection reason
        # for HEIC/AVIF/SVG which we can't process.
        allowed_types = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/tiff", "image/tif"]
        allowed_exts = {"jpg", "jpeg", "png", "webp", "gif", "tif", "tiff"}
        rejected_exts = {"heic", "heif", "avif", "svg", "bmp", "ico"}
        content_type = image.content_type or ""
        file_ext = (image.filename or "").lower().split(".")[-1] if image.filename else ""
        is_supported_ext = file_ext in allowed_exts
        is_rejected_ext = file_ext in rejected_exts
        
        if is_rejected_ext:
            raise HTTPException(
                status_code=400,
                detail=f"{file_ext.upper()} is not supported. Please convert to JPG, PNG, WEBP or TIFF and try again."
            )
        if content_type not in allowed_types and not is_supported_ext:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported file type ({content_type or file_ext or 'unknown'}). Allowed: JPG, PNG, WEBP, GIF, TIF/TIFF."
            )
        
        # Read the image data
        image_data = await image.read()
        
        # Generate a unique filename - always use .jpg since we convert to JPEG
        unique_filename = f"{supplier or 'product'}_{product_id}_{uuid_module.uuid4().hex[:8]}.jpg"
        
        # Try to upload to R2 if available
        image_url = None
        logger.info(f"R2 available check: {is_r2_available()}")
        if is_r2_available():
            try:
                # Generate R2 key
                r2_key = f"products/{supplier or 'product'}/{unique_filename}"
                logger.info(f"Attempting R2 upload with key: {r2_key}")
                # Optimize the image before upload
                optimized_data = optimize_image(image_data)
                # Upload to R2
                image_url = upload_to_r2(optimized_data, r2_key)
                if image_url:
                    logger.info(f"Image uploaded to R2: {image_url}")
                else:
                    logger.warning("R2 upload returned None, falling back to local storage")
            except Exception as r2_err:
                logger.warning(f"R2 upload failed, falling back to local storage: {r2_err}")
                import traceback
                logger.warning(f"R2 error traceback: {traceback.format_exc()}")
        
        # Fallback to local storage if R2 not available or failed
        if not image_url:
            upload_dir = "/app/backend/uploads/products"
            os.makedirs(upload_dir, exist_ok=True)
            filepath = os.path.join(upload_dir, unique_filename)
            with open(filepath, "wb") as f:
                f.write(image_data)
            
            # Return URL - uploads are mounted at /api/uploads to route through ingress
            backend_url = os.environ.get("REACT_APP_BACKEND_URL", "")
            if not backend_url:
                backend_url = "https://feature-verification-7.preview.emergentagent.com"
            image_url = f"{backend_url}/api/uploads/products/{unique_filename}"
            logger.info(f"Image saved locally: {image_url}")
        
        # Try to convert to ObjectId
        try:
            obj_id = ObjectId(product_id)
        except Exception as e:
            logger.error(f"Invalid ObjectId: {product_id}, error: {e}")
            raise HTTPException(status_code=400, detail="Invalid product ID format")
        
        # Update the product's images array
        result = db.supplier_products.update_one(
            {"_id": obj_id},
            {
                "$push": {"images": image_url},
                "$set": {"updated_at": datetime.now(timezone.utc)}
            }
        )
        
        logger.info(f"Database update result: matched={result.matched_count}, modified={result.modified_count}")
        
        if result.matched_count == 0:
            raise HTTPException(status_code=404, detail="Product not found")
        
        return {
            "success": True,
            "image_url": image_url,
            "message": "Image uploaded successfully"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Image upload error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/delete-product-image")
def delete_product_image(data: dict):
    """
    Delete an image from a supplier product.
    Expects: {"product_id": "...", "image_url": "..."}
    """
    try:
        from bson import ObjectId
        
        db = get_db()
        
        product_id = data.get("product_id")
        image_url = data.get("image_url")
        
        if not product_id or not image_url:
            raise HTTPException(status_code=400, detail="Product ID and image URL are required")
        
        # Try to convert to ObjectId
        try:
            obj_id = ObjectId(product_id)
        except:
            raise HTTPException(status_code=400, detail="Invalid product ID format")
        
        # Remove the image from the product's images array
        result = db.supplier_products.update_one(
            {"_id": obj_id},
            {
                "$pull": {"images": image_url},
                "$set": {"updated_at": datetime.now(timezone.utc)}
            }
        )
        
        if result.matched_count == 0:
            raise HTTPException(status_code=404, detail="Product not found")
        
        # Optionally: Delete the actual file from storage (R2 or local)
        # For now, we just remove the reference
        
        return {
            "success": True,
            "message": "Image deleted successfully"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Image delete error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/reorder-images")
def reorder_product_images(data: dict):
    """
    Reorder images for a supplier product. First image becomes primary.
    Expects: {"product_id": "...", "images": ["url1", "url2", ...]}
    """
    try:
        from bson import ObjectId
        
        db = get_db()
        
        product_id = data.get("product_id")
        images = data.get("images", [])
        
        if not product_id:
            raise HTTPException(status_code=400, detail="Product ID is required")
        
        if not isinstance(images, list):
            raise HTTPException(status_code=400, detail="Images must be an array")
        
        # Try to convert to ObjectId
        try:
            obj_id = ObjectId(product_id)
        except:
            raise HTTPException(status_code=400, detail="Invalid product ID format")
        
        # Update the images array with new order
        result = db.supplier_products.update_one(
            {"_id": obj_id},
            {
                "$set": {
                    "images": images,
                    "updated_at": datetime.now(timezone.utc)
                }
            }
        )
        
        if result.matched_count == 0:
            raise HTTPException(status_code=404, detail="Product not found")
        
        return {
            "success": True,
            "message": "Image order updated successfully",
            "images": images
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Image reorder error: {e}")
        raise HTTPException(status_code=500, detail=str(e))



# =============================================================================
# ADMIN: PRICING CONFIGURATION & RECALCULATION
# =============================================================================

class PricingConfigUpdate(BaseModel):
    global_markup_percentage: Optional[float] = None
    vat_percentage: Optional[float] = None
    round_to_99: Optional[bool] = None
    supplier_markups: Optional[dict] = None  # {"Verona": 120, "Splendour": 140}


@router.get("/admin/pricing-config")
async def get_pricing_config(current_user: dict = Depends(get_current_user)):
    """
    Get current pricing configuration including per-supplier markups.
    """
    require_admin_access(current_user)
    
    try:
        db = get_db()
        
        # Get stored config or use defaults
        stored_config = db.pricing_config.find_one({"_id": "global"})
        
        if stored_config:
            global_markup = stored_config.get("global_markup_percentage", 130)
            vat_pct = stored_config.get("vat_percentage", 20)
            round_99 = stored_config.get("round_to_99", True)
            supplier_markups = stored_config.get("supplier_markups", {})
        else:
            global_markup = PRICING_RULES.get("markup_percentage", 130)
            vat_pct = PRICING_RULES.get("vat_percentage", 20)
            round_99 = PRICING_RULES.get("round_to_99", True)
            supplier_markups = {}
        
        # Get list of all suppliers
        suppliers = db.supplier_products.distinct("supplier")
        
        # Build supplier list with their markups
        supplier_list = []
        for supplier in suppliers:
            if supplier:
                supplier_list.append({
                    "name": supplier,
                    "markup_percentage": supplier_markups.get(supplier, global_markup),
                    "is_custom": supplier in supplier_markups,
                    "product_count": db.supplier_products.count_documents({"supplier": supplier})
                })
        
        # Sort by product count descending
        supplier_list.sort(key=lambda x: x["product_count"], reverse=True)
        
        return {
            "global_markup_percentage": global_markup,
            "vat_percentage": vat_pct,
            "round_to_99": round_99,
            "vat_multiplier": 1 + (vat_pct / 100),
            "suppliers": supplier_list,
            "example": {
                "cost": 10.00,
                "list_price": _calculate_price_with_markup(10.00, global_markup, vat_pct, round_99)
            }
        }
    except Exception as e:
        logger.error(f"Error getting pricing config: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/admin/pricing-config")
async def update_pricing_config(data: PricingConfigUpdate, current_user: dict = Depends(get_current_user)):
    """
    Update pricing configuration (global and per-supplier markups).
    """
    require_admin_access(current_user)
    
    try:
        db = get_db()
        
        # Get current config
        current = db.pricing_config.find_one({"_id": "global"}) or {}
        
        update_data = {
            "_id": "global",
            "global_markup_percentage": data.global_markup_percentage if data.global_markup_percentage is not None else current.get("global_markup_percentage", 130),
            "vat_percentage": data.vat_percentage if data.vat_percentage is not None else current.get("vat_percentage", 20),
            "round_to_99": data.round_to_99 if data.round_to_99 is not None else current.get("round_to_99", True),
            "supplier_markups": data.supplier_markups if data.supplier_markups is not None else current.get("supplier_markups", {}),
            "updated_at": datetime.now(timezone.utc),
            "updated_by": current_user.get("email", "unknown")
        }
        
        db.pricing_config.replace_one({"_id": "global"}, update_data, upsert=True)
        
        return {
            "success": True,
            "message": "Pricing configuration updated",
            "config": update_data
        }
    except Exception as e:
        logger.error(f"Error updating pricing config: {e}")
        raise HTTPException(status_code=500, detail=str(e))


def _calculate_price_with_markup(cost: float, markup_pct: float, vat_pct: float, round_to_99: bool) -> float:
    """Calculate list price with given markup and VAT."""
    import math
    if cost and cost > 0:
        markup_mult = 1 + (markup_pct / 100)
        vat_mult = 1 + (vat_pct / 100)
        raw_price = cost * markup_mult * vat_mult
        
        if round_to_99:
            whole = math.ceil(raw_price)
            return whole - 0.01
        return round(raw_price, 2)
    return 0


@router.post("/admin/recalculate-all-prices")
async def recalculate_all_prices(current_user: dict = Depends(get_current_user)):
    """
    Recalculate all product list prices based on current pricing config.
    Uses per-supplier markups where configured, otherwise uses global markup.
    
    Requires admin authentication.
    """
    require_admin_access(current_user)
    
    try:
        db = get_db()
        
        # Get pricing config
        config = db.pricing_config.find_one({"_id": "global"}) or {}
        global_markup = config.get("global_markup_percentage", 130)
        vat_pct = config.get("vat_percentage", 20)
        round_99 = config.get("round_to_99", True)
        supplier_markups = config.get("supplier_markups", {})
        
        results = {
            "global_markup_percentage": global_markup,
            "vat_percentage": vat_pct,
            "supplier_markups_applied": list(supplier_markups.keys()),
            "supplier_products_updated": 0,
            "supplier_products_skipped": 0,
            "tiles_updated": 0,
            "tiles_skipped": 0,
            "by_supplier": {},
            "sample_updates": []
        }
        
        # Update supplier_products collection
        supplier_products = list(db.supplier_products.find({"cost_price": {"$gt": 0}}))
        
        for product in supplier_products:
            cost_price = product.get('cost_price', 0)
            supplier = product.get('supplier', '')
            
            if cost_price and cost_price > 0:
                # Get markup for this supplier (custom or global)
                markup = supplier_markups.get(supplier, global_markup)
                new_list_price = _calculate_price_with_markup(cost_price, markup, vat_pct, round_99)
                old_list_price = product.get('list_price', 0) or product.get('price', 0)
                
                db.supplier_products.update_one(
                    {"_id": product["_id"]},
                    {"$set": {
                        "list_price": new_list_price,
                        "price": new_list_price,
                        "room_lot_price": new_list_price,
                        "markup_percentage": markup,
                        "updated_at": datetime.now(timezone.utc)
                    }}
                )
                results["supplier_products_updated"] += 1
                
                # Track by supplier
                if supplier not in results["by_supplier"]:
                    results["by_supplier"][supplier] = {"updated": 0, "markup": markup}
                results["by_supplier"][supplier]["updated"] += 1
                
                # Save first 5 samples
                if len(results["sample_updates"]) < 5:
                    results["sample_updates"].append({
                        "sku": product.get('sku', 'N/A'),
                        "supplier": supplier,
                        "cost": cost_price,
                        "markup": markup,
                        "old_price": old_list_price,
                        "new_price": new_list_price
                    })
            else:
                results["supplier_products_skipped"] += 1
        
        # Update tiles collection (published products)
        tiles = list(db.tiles.find({"cost_price": {"$gt": 0}}))
        
        for tile in tiles:
            cost_price = tile.get('cost_price', 0)
            supplier = tile.get('supplier_name', tile.get('supplier', ''))
            
            if cost_price and cost_price > 0:
                markup = supplier_markups.get(supplier, global_markup)
                new_list_price = _calculate_price_with_markup(cost_price, markup, vat_pct, round_99)
                
                db.tiles.update_one(
                    {"_id": tile["_id"]},
                    {"$set": {
                        "room_lot_price": new_list_price,
                        "price": new_list_price,
                        "markup_percentage": markup,
                        "updated_at": datetime.now(timezone.utc)
                    }}
                )
                results["tiles_updated"] += 1
            else:
                results["tiles_skipped"] += 1
        
        results["success"] = True
        results["message"] = f"Updated {results['supplier_products_updated']} supplier products and {results['tiles_updated']} tiles"
        
        logger.info(f"Price recalculation complete: {results['message']}")
        
        return results
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Price recalculation error: {e}")
        raise HTTPException(status_code=500, detail=str(e))



@router.get("/products/broken-images")
def get_products_with_broken_images(supplier: Optional[str] = None):
    """
    Get products with broken or placeholder image URLs.
    Helps identify products that need image re-upload.
    """
    try:
        db = get_db()
        
        # Build query
        query = {}
        supplier = normalise_filter_value(supplier)
        if supplier:
            query["supplier"] = supplier
        
        # Find products with images
        products = list(db.supplier_products.find(
            query,
            {"_id": 1, "sku": 1, "name": 1, "product_name": 1, "supplier": 1, "images": 1, "main_image": 1}
        ))
        
        broken_products = []
        fixed_products = []
        
        # Patterns that indicate broken/placeholder images
        broken_patterns = [
            "example.com",
            "placeholder",
            "no-image",
            "default.jpg",
            "undefined",
            "null"
        ]
        
        # Patterns that indicate valid cloud storage
        valid_patterns = [
            "images.tilestation.co.uk",
            "r2.dev",
            "r2.cloudflarestorage.com",
            "cloudflare",
            "amazonaws.com",
            "blob.core.windows.net",
            "splendourtiles.co.uk",
            "wallcano",
            "verona"
        ]
        
        for p in products:
            images = p.get("images", [])
            product_info = {
                "id": str(p["_id"]),
                "sku": p.get("sku"),
                "name": p.get("product_name") or p.get("name"),
                "supplier": p.get("supplier"),
                "images": images,
                "broken_images": [],
                "valid_images": []
            }
            
            has_broken = False
            for img in images:
                if not img:
                    continue
                    
                img_lower = img.lower()
                
                # Check if it's a broken/placeholder URL
                is_broken = any(pattern in img_lower for pattern in broken_patterns)
                
                # Check if it's a valid cloud URL
                is_valid = any(pattern in img_lower for pattern in valid_patterns)
                
                if is_broken or (not is_valid and not img.startswith("http")):
                    product_info["broken_images"].append(img)
                    has_broken = True
                else:
                    product_info["valid_images"].append(img)
            
            if has_broken or not images:
                broken_products.append(product_info)
            else:
                fixed_products.append(product_info)
        
        return {
            "summary": {
                "total_products": len(products),
                "products_with_broken_images": len(broken_products),
                "products_with_valid_images": len(fixed_products)
            },
            "broken_products": broken_products,
            "note": "Use POST /api/supplier-sync/upload-product-image to upload new images for products with broken URLs"
        }
        
    except Exception as e:
        logger.error(f"Get broken images error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/products/clean-broken-images")
def clean_broken_images(data: dict):
    """
    Remove broken/placeholder image URLs from products.
    Only removes URLs that match broken patterns, preserves valid ones.
    
    Body: { "supplier": "Plus39", "dry_run": true }
    """
    try:
        db = get_db()
        
        supplier = normalise_filter_value(data.get("supplier"))
        dry_run = data.get("dry_run", True)  # Default to dry run for safety
        
        if not supplier:
            raise HTTPException(status_code=400, detail="Supplier is required")
        
        # Find products for this supplier
        products = list(db.supplier_products.find(
            {"supplier": supplier},
            {"_id": 1, "sku": 1, "images": 1}
        ))
        
        # Patterns that indicate broken/placeholder images
        broken_patterns = [
            "example.com",
            "placeholder",
            "no-image",
            "default.jpg"
        ]
        
        cleaned_count = 0
        changes = []
        
        for p in products:
            images = p.get("images", [])
            if not images:
                continue
            
            # Filter out broken images
            valid_images = []
            removed_images = []
            
            for img in images:
                if not img:
                    continue
                    
                img_lower = img.lower()
                is_broken = any(pattern in img_lower for pattern in broken_patterns)
                
                if is_broken:
                    removed_images.append(img)
                else:
                    valid_images.append(img)
            
            # If we removed any images, update the product
            if removed_images:
                changes.append({
                    "sku": p.get("sku"),
                    "removed": removed_images,
                    "kept": valid_images
                })
                
                if not dry_run:
                    db.supplier_products.update_one(
                        {"_id": p["_id"]},
                        {
                            "$set": {
                                "images": valid_images,
                                "updated_at": datetime.now(timezone.utc)
                            }
                        }
                    )
                    cleaned_count += 1
        
        return {
            "dry_run": dry_run,
            "supplier": supplier,
            "products_cleaned": cleaned_count if not dry_run else 0,
            "products_to_clean": len(changes),
            "changes": changes,
            "message": "Dry run - no changes made. Set dry_run: false to apply changes." if dry_run else f"Cleaned {cleaned_count} products"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Clean broken images error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============ EMERGENCY HARD RESET ============

@router.delete("/hard-reset-website")
def hard_reset_website():
    """
    EMERGENCY: Complete hard reset of website products.
    1. Drops ALL documents from tiles collection
    2. Resets ALL supplier_products flags to unpublished state
    """
    # Step 1: Wipe tiles collection completely
    tiles_result = sync_db.tiles.delete_many({})
    
    # Step 2: Reset ALL flags on ALL supplier products - leave no trace
    sp_result = sync_db.supplier_products.update_many(
        {},
        {"$set": {
            "show_on_website": False,
            "in_products_db": False,
            "visibility": "draft",
            "status": "draft"
        }}
    )
    
    return {
        "success": True,
        "tiles_deleted": tiles_result.deleted_count,
        "supplier_products_reset": sp_result.modified_count,
        "message": "Hard reset complete. All products unpublished. Use publish-to-website to selectively republish."
    }



@router.post("/replace-ultra-tile-products")
def replace_ultra_tile_products(data: dict):
    """
    Replace all Ultra Tile supplier products with new data from PDF price list.
    Expects: {"products": [{"sku": "...", "name": "...", "description": "...", "cost_price": 5.43}, ...], "confirm": true}
    """
    try:
        db = get_db()
        confirm = data.get("confirm", False)
        new_products = data.get("products", [])
        supplier_name = "Ultra Tile"
        
        current_count = db.supplier_products.count_documents({"supplier": supplier_name})
        
        if not confirm:
            return {
                "success": False,
                "message": f"This will DELETE {current_count} existing Ultra Tile products and INSERT {len(new_products)} new ones. Send confirm=true to proceed.",
                "current_count": current_count,
                "new_count": len(new_products)
            }
        
        if not new_products:
            raise HTTPException(status_code=400, detail="No products provided")
        
        # Step 1: Delete all existing Ultra Tile products
        delete_result = db.supplier_products.delete_many({"supplier": supplier_name})
        deleted_count = delete_result.deleted_count
        
        # Step 2: Insert all new products
        inserted_count = 0
        errors = []
        
        for p in new_products:
            try:
                sku = p.get("sku", "")
                product_doc = {
                    "supplier": supplier_name,
                    "sku": sku,
                    "name": p.get("name", ""),
                    "product_name": p.get("name", ""),
                    "supplier_product_name": p.get("description", p.get("name", "")),
                    "cost_price": p.get("cost_price"),
                    "in_stock": True,
                    "always_in_stock": True,
                    "stock_status": "in_stock",
                    "visibility": "draft",
                    "show_on_website": False,
                    "in_products_db": False,
                    "synced_at": datetime.now(timezone.utc),
                    "last_processed": datetime.now(timezone.utc),
                    "created_at": datetime.now(timezone.utc)
                }
                
                # Add optional fields
                if p.get("unit"):
                    product_doc["unit_of_measure"] = p["unit"]
                if p.get("category"):
                    product_doc["category"] = p["category"]
                
                db.supplier_products.insert_one(product_doc)
                inserted_count += 1
            except Exception as e:
                errors.append({"sku": sku, "error": str(e)})
        
        # Log the operation
        db.sync_logs.insert_one({
            "supplier": supplier_name,
            "source": "pdf_import_replace",
            "timestamp": datetime.now(timezone.utc),
            "action": "replace_all",
            "deleted_count": deleted_count,
            "inserted_count": inserted_count,
            "errors": len(errors)
        })
        
        return {
            "success": True,
            "deleted": deleted_count,
            "inserted": inserted_count,
            "errors": len(errors),
            "error_details": errors[:10] if errors else [],
            "message": f"Replaced Ultra Tile products: deleted {deleted_count}, inserted {inserted_count}"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Replace Ultra Tile error: {e}")
        raise HTTPException(status_code=500, detail=str(e))



# ===== Bulk Update Single Field for Multiple Products =====
# Used by batch series description "Apply to Series" and "Apply All" buttons

class BulkUpdateFieldRequest(BaseModel):
    skus: List[str]
    field: str
    value: str = ""

@router.post("/products/bulk-update-field")
def bulk_update_field(data: BulkUpdateFieldRequest):
    """Update a single field for multiple products by SKU."""
    db = get_db()
    
    allowed_fields = {"description", "short_description", "seo_keywords", "hidden_seo_keywords", "material", "finish", "type", "edge", "size", "made_in", "slip_rating", "suitability", "thickness"}
    if data.field not in allowed_fields:
        raise HTTPException(status_code=400, detail=f"Field '{data.field}' is not allowed for bulk update")
    
    if not data.skus:
        raise HTTPException(status_code=400, detail="No SKUs provided")
    
    # Update supplier_products
    sp_result = db.supplier_products.update_many(
        {"sku": {"$in": data.skus}},
        {"$set": {data.field: data.value, "updated_at": datetime.now(timezone.utc)}}
    )
    
    # Also sync to tiles collection
    tiles_result = db.tiles.update_many(
        {"$or": [{"sku": {"$in": data.skus}}, {"supplier_code": {"$in": data.skus}}]},
        {"$set": {data.field: data.value, "updated_at": datetime.now(timezone.utc)}}
    )
    
    return {
        "success": True,
        "updated": sp_result.modified_count,
        "tiles_updated": tiles_result.modified_count,
        "field": data.field
    }

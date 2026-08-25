"""
Product and Category routes
"""
import uuid
import os
import csv
import io
import json
import re
import asyncio
from datetime import datetime, timezone
from typing import List, Optional
from fastapi import APIRouter, HTTPException, Depends, File, UploadFile, Query
from fastapi.responses import StreamingResponse

from config import get_db
from models import Category, CategoryCreate, Product, ProductCreate, ProductUpdate
from services import get_current_user, is_admin_user, require_admin_access, log_audit

router = APIRouter(tags=["Products"])


def clean_duplicate_dimensions(name: str) -> str:
    """
    Clean duplicate dimensions from product name.
    Keeps only the bracketed version if present.
    Example: "Tile Trim 10mm 10mm (10mm)" -> "Tile Trim (10mm)"
    """
    if not name:
        return name
    
    # Find all bracketed content like (10mm), (2.5m), (600x600mm)
    bracketed_pattern = r'\(([^)]+)\)'
    bracketed_matches = re.findall(bracketed_pattern, name)
    
    if not bracketed_matches:
        return name
    
    cleaned_name = name
    
    for bracketed_content in bracketed_matches:
        # Extract dimensions/sizes from bracketed content
        dim_pattern = r'(\d+(?:\.\d+)?(?:mm|cm|m)?(?:\s*x\s*\d+(?:\.\d+)?(?:mm|cm|m)?)?)'
        dims_in_bracket = re.findall(dim_pattern, bracketed_content, re.IGNORECASE)
        
        for dim in dims_in_bracket:
            dim_clean = dim.strip()
            if not dim_clean:
                continue
            
            # Temporarily replace the bracketed version
            bracketed_full = f"({bracketed_content})"
            placeholder = "###BRACKET_PLACEHOLDER###"
            temp_name = cleaned_name.replace(bracketed_full, placeholder)
            
            # Remove unbracketed occurrences
            unbracketed_pattern = rf'\b{re.escape(dim_clean)}\b'
            temp_name = re.sub(unbracketed_pattern, '', temp_name, flags=re.IGNORECASE)
            
            # Restore the bracketed version
            cleaned_name = temp_name.replace(placeholder, bracketed_full)
    
    # Clean up multiple spaces
    cleaned_name = re.sub(r'\s+', ' ', cleaned_name).strip()
    
    return cleaned_name


@router.post("/categories", response_model=Category)
async def create_category(input: CategoryCreate, current_user: dict = Depends(get_current_user)):
    """Create a new category"""
    require_admin_access(current_user)
    db = get_db()
    
    category_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    
    category_doc = {
        "id": category_id,
        "name": input.name,
        "description": input.description,
        "created_at": now.isoformat()
    }
    
    await db.categories.insert_one(category_doc)
    return Category(**category_doc)


@router.get("/categories", response_model=List[Category])
async def get_categories(current_user: dict = Depends(get_current_user)):
    """Get all categories"""
    db = get_db()
    categories = await db.categories.find({}, {"_id": 0}).to_list(1000)
    return [Category(**c) for c in categories]


@router.post("/upload-image")
async def upload_image(file: UploadFile = File(...), current_user: dict = Depends(get_current_user)):
    """Upload an image file to Cloudflare R2 storage"""
    require_admin_access(current_user)
    
    # Validate file type
    allowed_types = ["image/jpeg", "image/png", "image/webp", "image/gif"]
    if file.content_type not in allowed_types:
        raise HTTPException(status_code=400, detail="Invalid file type")
    
    # Read file content
    content = await file.read()
    
    # Generate unique filename
    ext = file.filename.split(".")[-1].lower() if file.filename else "jpg"
    if ext not in ["jpg", "jpeg", "png", "webp", "gif"]:
        ext = "jpg"
    filename = f"{uuid.uuid4()}.{ext}"
    
    # Try to upload to R2 first
    from services.storage.r2_uploader import R2ImageUploader, optimize_image
    
    if R2ImageUploader.is_configured():
        try:
            # Optimize the image before upload
            optimized_content = optimize_image(content)
            
            # Upload to R2
            client = R2ImageUploader.get_client()
            bucket_name = R2ImageUploader.get_bucket_name()
            key = f"uploads/{filename}"
            
            content_type = "image/jpeg" if ext in ["jpg", "jpeg"] else f"image/{ext}"
            
            client.put_object(
                Bucket=bucket_name,
                Key=key,
                Body=optimized_content,
                ContentType=content_type,
                CacheControl='public, max-age=31536000'
            )
            
            # Return R2 public URL
            r2_url = f"{R2ImageUploader.get_public_url()}/{key}"
            return {"url": r2_url, "filename": filename, "storage": "r2"}
            
        except Exception as e:
            import logging
            logging.error(f"R2 upload failed, falling back to local: {e}")
    
    # Fallback to local storage if R2 not configured or upload fails
    upload_dir = "/app/backend/uploads"
    os.makedirs(upload_dir, exist_ok=True)
    filepath = os.path.join(upload_dir, filename)
    
    with open(filepath, "wb") as f:
        f.write(content)
    
    # Return local URL
    backend_url = os.environ.get("APP_URL", os.environ.get("REACT_APP_BACKEND_URL", ""))
    image_url = f"{backend_url}/api/uploads/{filename}"
    
    return {"url": image_url, "filename": filename, "storage": "local"}


@router.post("/products", response_model=Product)
async def create_product(input: ProductCreate, current_user: dict = Depends(get_current_user)):
    """Create a new product"""
    require_admin_access(current_user)
    db = get_db()
    
    product_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    
    product_doc = {
        "id": product_id,
        "name": input.name,
        "description": input.description,
        "sku": input.sku,
        "barcode": input.barcode,
        "price": input.price,
        "cost_price": input.cost_price,
        "stock": input.stock,
        "category_id": input.category_id,
        "category_name": input.category_name,
        "unit": input.unit,
        "m2_quantity": input.m2_quantity,
        "tile_width": input.tile_width,
        "tile_height": input.tile_height,
        "tile_m2_per_piece": input.tile_m2_per_piece,
        "tiles_per_box": input.tiles_per_box,
        "box_m2_coverage": input.box_m2_coverage,
        "pallet_enabled": input.pallet_enabled,
        "pallet_quantity": input.pallet_quantity,
        "pallet_price": input.pallet_price,
        "clearance": input.clearance,
        "clearance_price": input.clearance_price,
        "max_discount": input.max_discount,
        "reorder_level": input.reorder_level,
        "images": input.images if input.images else [],
        "created_at": now.isoformat(),
        "updated_at": now.isoformat()
    }
    
    await db.products.insert_one(product_doc)
    
    # Log audit
    await log_audit(
        action="CREATE",
        entity_type="product",
        user=current_user,
        entity_id=product_id,
        entity_name=input.name,
        after_data={"name": input.name, "sku": input.sku, "price": input.price, "stock": input.stock},
        details=f"Product created: {input.name}"
    )
    
    return Product(**product_doc)


@router.get("/products", response_model=List[Product])
async def get_products(
    category_id: Optional[str] = None,
    search: Optional[str] = None,
    low_stock: Optional[bool] = None,
    clearance: Optional[bool] = None,
    current_user: dict = Depends(get_current_user)
):
    """Get all products with optional filters"""
    db = get_db()
    
    query = {}
    if category_id:
        query["category_id"] = category_id
    if search:
        query["$or"] = [
            {"name": {"$regex": search, "$options": "i"}},
            {"sku": {"$regex": search, "$options": "i"}},
            {"barcode": {"$regex": search, "$options": "i"}},
            # Allow searching by original supplier product name (e.g., "Tenby White" finds "Sparta White")
            {"supplier_product_name": {"$regex": search, "$options": "i"}}
        ]
    if low_stock:
        query["$expr"] = {"$lte": ["$stock", "$reorder_level"]}
    if clearance:
        query["clearance"] = True
    
    products = await db.products.find(query, {"_id": 0}).to_list(10000)
    return [Product(**p) for p in products]


@router.get("/products/epos/search")
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
    db = get_db()
    
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


@router.get("/products/{product_id}")
async def get_product(product_id: str, current_user: dict = Depends(get_current_user)):
    """Get a single product"""
    db = get_db()
    
    # Try to find by ObjectId first (from supplier_products.products_db_id)
    product = None
    try:
        from bson import ObjectId
        product = await db.products.find_one({"_id": ObjectId(product_id)})
        if product:
            product["id"] = str(product.pop("_id"))
    except Exception:
        pass
    
    # Fallback to finding by 'id' field
    if not product:
        product = await db.products.find_one({"id": product_id}, {"_id": 0})
    
    # Also try by SKU
    if not product:
        product = await db.products.find_one({"sku": product_id}, {"_id": 0})
    
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    
    # Return as dict directly to ensure all fields are included
    # Remove any MongoDB-specific fields
    product.pop("_id", None)
    
    return product


@router.put("/products/{product_id}", response_model=Product)
async def update_product(product_id: str, input: ProductUpdate, current_user: dict = Depends(get_current_user)):
    """Update a product"""
    require_admin_access(current_user)
    db = get_db()
    
    # Get existing product
    existing = await db.products.find_one({"id": product_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Product not found")
    
    # Build update data
    update_data = {k: v for k, v in input.model_dump(exclude_unset=True).items() if v is not None}
    update_data["updated_at"] = datetime.now(timezone.utc).isoformat()
    
    # Check if name is being changed - if so, create custom mapping for supplier products
    old_name = existing.get("name", "")
    new_name = update_data.get("name")
    old_supplier_product_name = existing.get("supplier_product_name", "")
    new_supplier_product_name = update_data.get("supplier_product_name")
    supplier_name = existing.get("supplier_name") or update_data.get("supplier_name")
    sku = existing.get("sku") or existing.get("supplier_sku")
    
    # Check if either name or supplier_product_name is being changed
    name_changed = new_name and new_name != old_name
    supplier_name_changed = new_supplier_product_name is not None and new_supplier_product_name != old_supplier_product_name
    
    # If product_name or supplier_product_name is being changed and this is linked to a supplier product
    if (name_changed or supplier_name_changed) and supplier_name and sku:
        try:
            # Get original supplier name from supplier_product_name or existing name
            original_supplier_name = existing.get("supplier_product_name") or old_name
            
            now = datetime.now(timezone.utc).isoformat()
            mapping_data = {
                "supplier": supplier_name,
                "sku": sku,
                "original_name": original_supplier_name,
                "custom_name": new_name or old_name,
                "updated_at": now,
                "updated_by": current_user.get('email', 'system')
            }
            
            # Add supplier_product_name to mapping if changed
            if supplier_name_changed:
                mapping_data["supplier_product_name"] = new_supplier_product_name
            
            # Upsert the custom mapping (async)
            await db.custom_mappings.update_one(
                {"supplier": supplier_name, "sku": sku},
                {
                    "$set": mapping_data,
                    "$setOnInsert": {"created_at": now}
                },
                upsert=True
            )
            
            # Also update the supplier_products collection if it exists
            supplier_product = await db.supplier_products.find_one({
                "supplier": supplier_name,
                "sku": sku
            })
            if supplier_product:
                sp_update = {"updated_at": datetime.now(timezone.utc)}
                if name_changed:
                    sp_update["product_name"] = new_name
                if supplier_name_changed:
                    sp_update["supplier_product_name"] = new_supplier_product_name
                await db.supplier_products.update_one(
                    {"_id": supplier_product["_id"]},
                    {"$set": sp_update}
                )
                
                # Also sync to tiles collection if product is published on website
                if supplier_product.get("show_on_website"):
                    tiles_update = {"updated_at": datetime.now(timezone.utc)}
                    if name_changed:
                        tiles_update["display_name"] = new_name
                        tiles_update["name"] = new_name
                    await db.tiles.update_one(
                        {"sku": sku},
                        {"$set": tiles_update}
                    )
        except Exception as e:
            # Don't fail the whole update if custom mapping fails
            print(f"Custom mapping save failed (non-critical): {e}")
    
    # SYNC DESCRIPTION & SEO FIELDS to supplier_products and tiles collections
    # This ensures changes from Edit Product (Full Page) sync to Bulk Category Editor
    sync_fields = ['description', 'seo_keywords', 'hidden_seo_keywords', 
                   'main_category', 'sub_categories', 'rooms', 'styles', 'colors', 'features', 'materials', 'finishes',
                   # Half + Full Pallet pricing — Feb 2026.
                   # These all live on the `tiles` doc so the storefront PDP can
                   # render the half/full chip selector + minimum-m² gate.
                   'pallet_enabled', 'pallet_price', 'half_pallet_price',
                   'm2_per_pallet', 'm2_per_half_pallet']
    sync_data = {k: update_data[k] for k in sync_fields if k in update_data}
    
    if sync_data and sku:
        try:
            sync_data["updated_at"] = datetime.now(timezone.utc)
            # Sync to supplier_products
            await db.supplier_products.update_one(
                {"sku": sku},
                {"$set": sync_data}
            )
            # Sync to tiles
            await db.tiles.update_one(
                {"sku": sku},
                {"$set": sync_data}
            )
        except Exception as e:
            print(f"Sync to supplier_products/tiles failed (non-critical): {e}")
    
    await db.products.update_one({"id": product_id}, {"$set": update_data})
    
    # Log audit
    await log_audit(
        action="UPDATE",
        entity_type="product",
        user=current_user,
        entity_id=product_id,
        entity_name=existing.get("name", ""),
        before_data=existing,
        after_data=update_data,
        details=f"Product updated: {existing.get('name', '')}"
    )
    
    product = await db.products.find_one({"id": product_id}, {"_id": 0})
    return Product(**product)


@router.delete("/products/{product_id}")
async def delete_product(product_id: str, current_user: dict = Depends(get_current_user)):
    """Delete a product"""
    require_admin_access(current_user)
    db = get_db()
    
    # Get existing product
    existing = await db.products.find_one({"id": product_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Product not found")
    
    await db.products.delete_one({"id": product_id})
    
    # Log audit
    await log_audit(
        action="DELETE",
        entity_type="product",
        user=current_user,
        entity_id=product_id,
        entity_name=existing.get("name", ""),
        before_data=existing,
        details=f"Product deleted: {existing.get('name', '')}"
    )
    
    return {"message": "Product deleted"}


@router.get("/products/export/csv")
async def export_products_csv(current_user: dict = Depends(get_current_user)):
    """
    Export all products as CSV file.
    Useful for backup and data migration.
    """
    require_admin_access(current_user)
    db = get_db()
    
    # Get all products
    products = await db.products.find({}, {"_id": 0}).to_list(50000)
    
    if not products:
        raise HTTPException(status_code=404, detail="No products found to export")
    
    # Create CSV in memory
    output = io.StringIO()
    
    # Define CSV columns
    fieldnames = [
        'id', 'name', 'sku', 'barcode', 'description', 'category_id', 'category_name',
        'supplier_id', 'supplier_name', 'price', 'cost_price', 'stock', 'unit',
        'm2_quantity', 'tile_width', 'tile_height', 'tile_m2_per_piece',
        'tiles_per_box', 'box_m2_coverage', 'pallet_enabled', 'pallet_quantity',
        'pallet_price', 'clearance', 'clearance_price', 'max_discount',
        'reorder_level', 'status', 'images', 'created_at', 'updated_at'
    ]
    
    writer = csv.DictWriter(output, fieldnames=fieldnames, extrasaction='ignore')
    writer.writeheader()
    
    for product in products:
        # Convert images list to string
        if 'images' in product and isinstance(product['images'], list):
            product['images'] = '|'.join(product['images'])
        writer.writerow(product)
    
    output.seek(0)
    
    # Generate filename with timestamp
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"products_backup_{timestamp}.csv"
    
    # Log export
    await log_audit(
        action="EXPORT",
        entity_type="products",
        user=current_user,
        details=f"Exported {len(products)} products to CSV"
    )
    
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )


@router.get("/products/export/json")
async def export_products_json(current_user: dict = Depends(get_current_user)):
    """
    Export all products as JSON file.
    Includes full product data for complete backup.
    """
    require_admin_access(current_user)
    db = get_db()
    
    # Get all products
    products = await db.products.find({}, {"_id": 0}).to_list(50000)
    
    if not products:
        raise HTTPException(status_code=404, detail="No products found to export")
    
    # Create export data with metadata
    export_data = {
        "export_date": datetime.now(timezone.utc).isoformat(),
        "total_products": len(products),
        "exported_by": current_user.get("email", "unknown"),
        "products": products
    }
    
    # Generate filename with timestamp
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"products_backup_{timestamp}.json"
    
    # Log export
    await log_audit(
        action="EXPORT",
        entity_type="products",
        user=current_user,
        details=f"Exported {len(products)} products to JSON"
    )
    
    # Create JSON string
    json_str = json.dumps(export_data, indent=2, default=str)
    
    return StreamingResponse(
        iter([json_str]),
        media_type="application/json",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )


@router.get("/products/stats")
async def get_products_stats(current_user: dict = Depends(get_current_user)):
    """
    Get product statistics for backup/export page.
    """
    db = get_db()
    
    total = await db.products.count_documents({})
    with_images = await db.products.count_documents({"images": {"$exists": True, "$ne": []}})
    without_images = total - with_images
    
    # Get supplier breakdown
    pipeline = [
        {"$group": {"_id": "$supplier_name", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
        {"$limit": 10}
    ]
    supplier_stats = await db.products.aggregate(pipeline).to_list(10)
    
    return {
        "total_products": total,
        "with_images": with_images,
        "without_images": without_images,
        "by_supplier": [{"supplier": s["_id"] or "Unknown", "count": s["count"]} for s in supplier_stats]
    }


@router.post("/products/cleanup/duplicate-dimensions")
async def cleanup_duplicate_dimensions(
    dry_run: bool = True,
    current_user: dict = Depends(get_current_user)
):
    """
    Clean up duplicate dimension mentions in product names.
    For example: "Tile Trim 10mm 10mm (10mm)" becomes "Tile Trim (10mm)"
    
    Args:
        dry_run: If True, only preview changes without applying them
    """
    require_admin_access(current_user)
    db = get_db()
    
    products = await db.products.find({}, {"_id": 0, "id": 1, "sku": 1, "name": 1}).to_list(50000)
    
    changes = []
    updated_count = 0
    
    for product in products:
        name = product.get('name', '')
        cleaned = clean_duplicate_dimensions(name)
        
        if name != cleaned:
            changes.append({
                'id': product.get('id'),
                'sku': product.get('sku'),
                'original': name,
                'cleaned': cleaned
            })
            
            if not dry_run:
                await db.products.update_one(
                    {'id': product.get('id')},
                    {'$set': {'name': cleaned}}
                )
                updated_count += 1
    
    if not dry_run and updated_count > 0:
        await log_audit(
            action="CLEANUP",
            entity_type="products",
            user=current_user,
            details=f"Cleaned duplicate dimensions from {updated_count} product names"
        )
    
    return {
        "total_products": len(products),
        "products_with_duplicates": len(changes),
        "updated": updated_count if not dry_run else 0,
        "dry_run": dry_run,
        "sample_changes": changes[:20]
    }


# AI Description Generator
@router.post("/generate-description")
async def generate_product_description(
    product_context: dict,
    current_user: dict = Depends(get_current_user)
):
    """
    Generate an SEO-friendly product description using AI.
    Takes product context including name, category, keywords, specifications.
    Supports modes: generate, brief, long, shorter, longer, regenerate
    """
    from dotenv import load_dotenv
    load_dotenv()
    
    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage
        
        api_key = os.environ.get('EMERGENT_LLM_KEY')
        if not api_key:
            raise HTTPException(status_code=500, detail="LLM API key not configured")
        
        # Extract product details
        name = product_context.get('name', 'Tile')
        category = product_context.get('category', '')
        seo_keywords = product_context.get('seo_keywords', '')
        material = product_context.get('material', '')
        finish = product_context.get('finish', '')
        size = product_context.get('size', '')
        colors = product_context.get('colors', [])
        suitability = product_context.get('suitability', '')
        slip_rating = product_context.get('slip_rating', '')
        
        # Get mode and length hint
        mode = product_context.get('mode', 'generate')
        length_hint = product_context.get('length_hint', 'standard')
        current_description = product_context.get('current_description', '')
        
        # Get website categories for additional context
        website_cats = product_context.get('website_categories', {})
        rooms = website_cats.get('rooms', [])
        materials = website_cats.get('materials', [])
        styles = website_cats.get('styles', [])
        features = website_cats.get('features', [])
        finishes = website_cats.get('finishes', [])
        
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
        
        # Add website category context
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
        
        # Detect tile type from product attributes for context-aware descriptions
        name_lower = name.lower()
        tile_type_instructions = []
        
        # Also check category and type fields
        category_lower = (category or '').lower()
        tile_type = product_context.get('type', '').lower()
        sub_cats = product_context.get('sub_categories', [])
        sub_cats_lower = ' '.join(sub_cats).lower() if sub_cats else ''
        
        is_outdoor = (
            'outdoor' in name_lower or 'external' in name_lower or
            '20mm' in name_lower or
            'outdoor' in category_lower or 'outdoor' in tile_type or
            'outdoor' in sub_cats_lower or
            (suitability and 'outdoor' in suitability.lower()) or
            (slip_rating and slip_rating.upper() in ('R11', 'R12', 'R13'))
        )
        is_wall_only = suitability and 'wall' in suitability.lower() and 'floor' not in suitability.lower()
        is_mosaic = 'mosaic' in name_lower
        is_decor = 'decor' in name_lower or 'feature' in name_lower
        
        if is_outdoor:
            tile_type_instructions.append(
                "This is an OUTDOOR tile. Focus on outdoor applications: patios, garden paths, terraces, driveways, "
                "pool surrounds, balconies, and external walkways. Emphasise weather resistance, frost-proof properties, "
                "anti-slip surface, and durability against the elements. "
                "Do NOT mention bathrooms, kitchens, or any indoor rooms."
            )
        elif is_wall_only:
            tile_type_instructions.append(
                "This is a WALL-ONLY tile. Focus on wall applications: splashbacks, feature walls, shower walls, "
                "bathroom walls, kitchen walls. Do NOT suggest using it as floor tile."
            )
        elif is_mosaic:
            tile_type_instructions.append(
                "This is a MOSAIC tile. Focus on decorative applications: feature walls, splashbacks, borders, "
                "accent areas, shower niches. Highlight the mosaic pattern and design versatility."
            )
        elif is_decor:
            tile_type_instructions.append(
                "This is a DECORATIVE/FEATURE tile. Focus on its decorative pattern and how it creates "
                "visual interest as a feature piece or accent within a tiled area."
            )
        
        tile_type_context = '\n'.join(tile_type_instructions) if tile_type_instructions else ''
        
        # Determine length requirements based on mode
        if mode == 'brief' or length_hint == 'short':
            length_instruction = "Write 1 short paragraph (50-80 words). Be concise and impactful."
        elif mode == 'long' or length_hint == 'detailed':
            length_instruction = "Write 3-4 detailed paragraphs (250-350 words). Include comprehensive details about features, benefits, and applications."
        elif mode == 'shorter':
            length_instruction = f"Current description:\n{current_description}\n\nRewrite this description to be SHORTER (reduce by 30-40%). Keep the key points but make it more concise."
        elif mode == 'longer':
            length_instruction = f"Current description:\n{current_description}\n\nExpand this description to be LONGER (increase by 30-50%). Add more detail about benefits, applications, and features."
        elif mode == 'regenerate':
            length_instruction = f"Current description:\n{current_description}\n\nWrite a completely NEW and DIFFERENT description with similar length but different wording and structure."
        else:
            length_instruction = "Write 2-3 paragraphs (150-200 words total). Balance detail with readability."
        
        # Create the prompt
        prompt = f"""Write a compelling, SEO-friendly product description for this tile:

Product Name: {name}
Category: {category or 'Tiles'}

Product Details:
{details_text}

SEO Keywords to include (naturally): {seo_keywords or 'tiles, quality, home improvement'}

{f"IMPORTANT - Tile Type Context:{chr(10)}{tile_type_context}" if tile_type_context else ""}

Length Requirements:
{length_instruction}

Style Requirements:
1. Highlight key features and benefits
2. Use the SEO keywords naturally throughout
3. Include mention of the material, finish, and suitable applications based on the tile type
4. Write in a professional but engaging tone suitable for an e-commerce website
5. Do NOT include any placeholder text or brackets
6. Do NOT start with "Introducing" or similar clichés
7. Do NOT include any headings or bullet points - just flowing paragraphs
8. Only recommend applications that match this tile's actual type and suitability

Write the description now:"""

        # Initialize LLM
        chat = LlmChat(
            api_key=api_key,
            session_id=f"product-desc-{uuid.uuid4()}",
            system_message="You are an expert copywriter specializing in tile and home improvement product descriptions. Write compelling, SEO-friendly descriptions that highlight product features and benefits."
        ).with_model("openai", "gpt-4o")
        
        # Generate description
        user_message = UserMessage(text=prompt)
        description = await chat.send_message(user_message)
        
        return {
            "success": True,
            "description": description.strip()
        }
        
    except ImportError as e:
        raise HTTPException(status_code=500, detail=f"LLM library not installed: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate description: {str(e)}")


# Unified AI Series Description Generator
@router.post("/generate-series-description")
async def generate_series_description(
    request_data: dict,
    current_user: dict = Depends(get_current_user)
):
    """
    Generate a unified, comprehensive description for an entire product series.
    This creates one description that covers ALL variants (colors, sizes, finishes)
    in the series, perfect for collection pages.
    
    Request body:
    - series_name: The name of the series (e.g., "Bluestone", "Sparta")
    - product_skus: Optional list of specific SKUs to include (if not provided, auto-detects from series_name)
    - seo_keywords: Optional SEO keywords to include
    - length: "standard", "brief", or "detailed"
    """
    from dotenv import load_dotenv
    load_dotenv()
    
    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage
        
        api_key = os.environ.get('EMERGENT_LLM_KEY')
        if not api_key:
            raise HTTPException(status_code=500, detail="LLM API key not configured")
        
        db = get_db()
        
        series_name = request_data.get('series_name', '')
        product_skus = request_data.get('product_skus', [])
        seo_keywords = request_data.get('seo_keywords', '')
        length = request_data.get('length', 'standard')
        
        if not series_name and not product_skus:
            raise HTTPException(status_code=400, detail="Either series_name or product_skus must be provided")
        
        # Query products - either by SKU list or by series name
        if product_skus:
            # Query by specific SKUs
            query = {"sku": {"$in": product_skus}}
        else:
            # Query by series name - match products whose name starts with series
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
            # Try tiles collection as fallback
            products = await db.tiles.find(query).to_list(500)
        
        if not products:
            raise HTTPException(status_code=404, detail=f"No products found for series '{series_name}'")
        
        # Aggregate all unique attributes across all products
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
        price_range = {"min": float('inf'), "max": 0}
        
        for p in products:
            # Colors
            color = p.get('color') or p.get('attributes', {}).get('color', '')
            if color:
                all_colors.add(color)
            
            # Sizes
            size = p.get('size') or p.get('attributes', {}).get('size', '')
            if size:
                all_sizes.add(size)
            
            # Finishes
            finish = p.get('finish') or p.get('attributes', {}).get('finish', '')
            if finish:
                all_finishes.add(finish)
            
            # Materials
            material = p.get('material') or p.get('attributes', {}).get('material', '')
            if material:
                all_materials.add(material)
            
            # Suitability (Wall, Floor, Wall & Floor)
            suitability = p.get('suitability', '')
            if suitability:
                all_suitabilities.add(suitability)
            
            # Slip rating
            slip_rating = p.get('slip_rating', '')
            if slip_rating:
                all_slip_ratings.add(slip_rating)
            
            # Thickness
            thickness = p.get('thickness', '')
            if thickness:
                all_thicknesses.add(str(thickness))
            
            # Features
            features = p.get('features', [])
            if isinstance(features, list):
                all_features.update(features)
            
            # Rooms
            rooms = p.get('rooms', [])
            if isinstance(rooms, list):
                all_rooms.update(rooms)
            
            # Styles
            styles = p.get('styles', [])
            if isinstance(styles, list):
                all_styles.update(styles)
            
            # Price range
            price = p.get('price') or p.get('room_lot_price') or p.get('trade_price', 0)
            if price:
                try:
                    price_val = float(price)
                    if price_val > 0:
                        price_range["min"] = min(price_range["min"], price_val)
                        price_range["max"] = max(price_range["max"], price_val)
                except (ValueError, TypeError):
                    pass
        
        # Build comprehensive details for AI prompt
        details_parts = []
        
        # Colors - key selling point for collections
        if all_colors:
            color_list = sorted(list(all_colors))
            details_parts.append(f"Available Colors ({len(color_list)}): {', '.join(color_list)}")
        
        # Sizes
        if all_sizes:
            size_list = sorted(list(all_sizes))
            details_parts.append(f"Available Sizes ({len(size_list)}): {', '.join(size_list)}")
        
        # Finishes
        if all_finishes:
            finish_list = sorted(list(all_finishes))
            details_parts.append(f"Finishes: {', '.join(finish_list)}")
        
        # Materials
        if all_materials:
            material_list = sorted(list(all_materials))
            details_parts.append(f"Material: {', '.join(material_list)}")
        
        # Suitability
        if all_suitabilities:
            details_parts.append(f"Suitable for: {', '.join(sorted(list(all_suitabilities)))}")
        
        # Slip rating (important for safety)
        if all_slip_ratings:
            details_parts.append(f"Slip Rating: {', '.join(sorted(list(all_slip_ratings)))}")
        
        # Thickness
        if all_thicknesses:
            thickness_list = sorted(list(all_thicknesses))
            details_parts.append(f"Thickness options: {', '.join(thickness_list)}")
        
        # Room suitability
        if all_rooms:
            details_parts.append(f"Ideal for: {', '.join(sorted(list(all_rooms)))}")
        
        # Styles
        if all_styles:
            details_parts.append(f"Style: {', '.join(sorted(list(all_styles)))}")
        
        # Features
        if all_features:
            details_parts.append(f"Features: {', '.join(sorted(list(all_features)))}")
        
        details_text = '\n'.join(details_parts) if details_parts else 'Premium tile collection'
        
        # Detect tile type from aggregated product data
        series_lower = series_name.lower()
        has_outdoor = any('outdoor' in (p.get('product_name', '') + p.get('name', '')).lower() for p in products)
        has_20mm = any('20mm' in (p.get('product_name', '') + p.get('name', '')).lower() for p in products)
        has_high_slip = bool(all_slip_ratings & {'R11', 'R12', 'R13'})
        # Check sub_categories for outdoor classification
        has_outdoor_category = any(
            'outdoor' in ' '.join(p.get('sub_categories', [])).lower()
            for p in products
        )
        # Check suitability field
        has_outdoor_suitability = any(
            'outdoor' in (p.get('suitability', '') or '').lower()
            for p in products
        )
        is_outdoor_collection = (
            has_outdoor or has_20mm or has_high_slip or 
            has_outdoor_category or has_outdoor_suitability or
            'outdoor' in series_lower or 'external' in series_lower or
            'slate' in series_lower or 'paving' in series_lower
        )
        
        tile_type_context = ""
        if is_outdoor_collection:
            tile_type_context = """
IMPORTANT - This is an OUTDOOR tile collection. Focus on:
- Outdoor applications: patios, garden paths, terraces, driveways, pool surrounds, balconies, external walkways
- Weather resistance, frost-proof properties, anti-slip surface, durability against the elements
- The 20mm thickness providing extra strength for external installation
- Do NOT mention bathrooms, kitchens, or any indoor rooms as applications
"""
        
        # Determine length requirements
        if length == 'brief':
            length_instruction = "Write 1-2 paragraphs (80-120 words). Be concise but comprehensive."
        elif length == 'detailed':
            length_instruction = "Write 4-5 detailed paragraphs (300-400 words). Include comprehensive details about all variants, features, benefits, and applications."
        else:
            length_instruction = "Write 2-3 paragraphs (150-250 words). Balance detail with readability."
        
        # Create the unified series prompt
        prompt = f"""Write a compelling, unified product collection description for the "{series_name}" tile series.

CRITICAL: The exact collection name is "{series_name}". You MUST use this exact spelling throughout - do NOT change, abbreviate, or use a similar-sounding word. The collection is called "{series_name}", not anything else.

This is a COLLECTION description that should cover ALL variants in one cohesive text. Do NOT write separate descriptions for each color/size - write ONE unified description that mentions the variety available.

Collection Overview:
- Series Name: {series_name} (use this exact name every time you refer to the collection)
- Total Variants: {len(products)} products in this collection

{details_text}
{tile_type_context}
SEO Keywords to weave in naturally: {seo_keywords or 'tiles, porcelain tiles, premium tiles'}

Length Requirements:
{length_instruction}

Writing Guidelines:
1. Start with a compelling opening about the {series_name} collection's overall aesthetic/appeal
2. Mention the variety of colors available (list them naturally in the text)
3. Reference the size options available for different project needs
4. Include the finishes and what look they create
5. Mention suitable applications that match the tile type (outdoor-only for outdoor tiles, indoor for indoor tiles)
6. End with why this collection is a great choice
7. Write in a professional but engaging e-commerce tone
8. Do NOT use bullet points or headings - flowing paragraphs only
9. Do NOT use placeholder text or brackets
10. Make it sound premium and aspirational
11. Only recommend applications that genuinely match this tile's type and suitability
12. IMPORTANT: Always spell the collection name exactly as "{series_name}" - never alter it
13. NEVER invent details: if no colours are listed above, do not mention colour options; if no sizes are listed, do not mention size options; never fabricate slip ratings, thicknesses or materials
14. Do NOT single out one specific size or colour as if it were the only product — this text represents the whole collection

Write the unified collection description now:"""

        # Initialize LLM
        chat = LlmChat(
            api_key=api_key,
            session_id=f"series-desc-{uuid.uuid4()}",
            system_message="You are an expert copywriter specializing in tile and building product collections. Write compelling, SEO-friendly collection descriptions that showcase the full range of options and help customers understand the variety available. Always match the tone and applications to the tile type — outdoor tiles should focus on outdoor use, indoor tiles on indoor use."
        ).with_model("openai", "gpt-4o")
        
        # Generate description
        user_message = UserMessage(text=prompt)
        description = await chat.send_message(user_message)
        
        # Post-process: ensure the series name is correct in the output
        # LLMs sometimes hallucinate similar-sounding names (e.g. "Arctic" instead of "Atlantic", "Dea" instead of "Delta")
        generated_text = description.strip()
        if series_name.lower() not in generated_text.lower():
            import difflib
            # Method 1: Find similar words and replace them
            words_in_text = set(re.findall(r'\b[A-Z][a-z]+\b', generated_text))
            close_matches = difflib.get_close_matches(series_name, words_in_text, n=5, cutoff=0.4)
            for wrong_name in close_matches:
                if wrong_name.lower() != series_name.lower():
                    generated_text = re.sub(r'\b' + re.escape(wrong_name) + r'\b', series_name, generated_text)
            
            # Method 2: Replace context patterns like "the X collection", "X tiles", "X series"
            context_patterns = [
                r'the\s+(\w+)\s+collection',
                r'(\w+)\s+collection',
                r'(\w+)\s+tiles\b',
                r'(\w+)\s+tile\s+series',
                r'(\w+)\s+series\b',
                r'(\w+)\s+range\b',
            ]
            for pattern in context_patterns:
                matches = re.finditer(pattern, generated_text, re.IGNORECASE)
                for m in matches:
                    wrong = m.group(1)
                    if wrong.lower() not in ('the', 'these', 'this', 'our', 'a', 'an', 'porcelain', 'ceramic', 'natural', 'premium', 'luxury', 'wall', 'floor'):
                        if wrong.lower() != series_name.lower():
                            ratio = difflib.SequenceMatcher(None, wrong.lower(), series_name.lower()).ratio()
                            if ratio > 0.35:
                                generated_text = generated_text.replace(wrong, series_name)
        
        return {
            "success": True,
            "series_name": series_name,
            "product_count": len(products),
            "description": generated_text,
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
        
    except ImportError as e:
        raise HTTPException(status_code=500, detail=f"LLM library not installed: {str(e)}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate series description: {str(e)}")

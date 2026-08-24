"""
Website Admin Routes - Full control over website content
Categories, Filters, Products, Homepage, Settings
"""
from fastapi import APIRouter, HTTPException, UploadFile, File, Form, Request, Depends, BackgroundTasks
from motor.motor_asyncio import AsyncIOMotorClient
from bson import ObjectId
from datetime import datetime, timezone
from typing import Optional, List
from pydantic import BaseModel
import os
import uuid
import base64
import logging
from urllib.parse import quote
from routes.auth import get_current_user
from utils.bulletproof import bulletproof_endpoint

logger = logging.getLogger(__name__)

# Centralised filter normaliser — maps 'all' / '' / 'any' / None → None
from utils.request_filters import normalise_filter_value

# Import category sync utility for automatic syncing
try:
    from utils.category_sync import (
        sync_category_to_website,
        update_category_product_counts,
        sync_product_categories_batch
    )
    CATEGORY_SYNC_AVAILABLE = True
except ImportError:
    CATEGORY_SYNC_AVAILABLE = False
    sync_category_to_website = None
    update_category_product_counts = None
    sync_product_categories_batch = None

router = APIRouter(prefix="/website-admin", tags=["Website Admin"])

# MongoDB connection
mongo_url = os.environ.get('MONGO_URL')
db_name = os.environ.get('DB_NAME', 'tile_epos_db')
client = AsyncIOMotorClient(mongo_url)
db = client[db_name]


def deep_merge(base: dict, override: dict) -> dict:
    """Recursively merge override into base, preserving nested keys."""
    result = dict(base)
    for key, value in override.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result


# ============ PYDANTIC MODELS ============

class CategoryGroupCreate(BaseModel):
    name: str
    slug: str
    description: Optional[str] = ""
    icon: Optional[str] = ""  # Icon name or URL
    color: Optional[str] = ""  # Brand color for the group
    display_order: int = 0
    is_active: bool = True


class CategoryCreate(BaseModel):
    name: str
    slug: str
    description: Optional[str] = ""
    parent_id: Optional[str] = None
    group_slug: Optional[str] = "tiles"  # Category group this belongs to
    image_url: Optional[str] = ""
    display_order: Optional[int] = 0
    is_active: bool = True
    show_on_homepage: bool = False
    subtitle: Optional[str] = ""  # Subtitle for homepage display (e.g., "New styles added")
    highlight: bool = False  # Highlight badge on homepage (e.g., "Up to 1/3 off")
    seo_title: Optional[str] = ""
    seo_description: Optional[str] = ""
    # Optional custom destination link (path or full URL). When set, the
    # storefront homepage tile links here instead of the default category
    # route. Empty/null = revert to default. Validated lightly admin-side.
    custom_url: Optional[str] = None


class FilterOptionCreate(BaseModel):
    name: str
    value: str
    display_order: Optional[int] = 0
    is_active: bool = True


class FilterTypeCreate(BaseModel):
    name: str
    slug: str
    filter_type: str = "checkbox"  # checkbox, range, color
    display_order: Optional[int] = 0
    is_active: bool = True
    options: List[FilterOptionCreate] = []


class ProductUpdate(BaseModel):
    website_name: Optional[str] = None
    description: Optional[str] = None
    short_description: Optional[str] = None
    seo_title: Optional[str] = None
    seo_description: Optional[str] = None
    category_ids: Optional[List[str]] = None
    tags: Optional[List[str]] = None
    is_featured: Optional[bool] = None
    is_active: Optional[bool] = None
    images: Optional[List[str]] = None
    specifications: Optional[dict] = None


class HomepageContent(BaseModel):
    hero_title: Optional[str] = None
    hero_subtitle: Optional[str] = None
    hero_image: Optional[str] = None
    hero_cta_text: Optional[str] = None
    hero_cta_link: Optional[str] = None
    featured_categories: Optional[List[str]] = None
    featured_products: Optional[List[str]] = None
    banner_text: Optional[str] = None
    banner_link: Optional[str] = None
    usp_items: Optional[List[dict]] = None
    about_title: Optional[str] = None
    about_text: Optional[str] = None
    about_image: Optional[str] = None
    brand_marquee_visible: Optional[bool] = None
    brand_marquee_title: Optional[str] = None
    brand_marquee_brands: Optional[List[dict]] = None
    # Video Showroom section
    video_showroom_visible: Optional[bool] = None
    video_showroom_badge: Optional[str] = None
    video_showroom_title: Optional[str] = None
    video_showroom_description: Optional[str] = None
    video_showroom_video_url: Optional[str] = None
    video_showroom_video_path: Optional[str] = None
    video_showroom_thumbnail_url: Optional[str] = None
    video_showroom_cta_primary_text: Optional[str] = None
    video_showroom_cta_primary_link: Optional[str] = None
    video_showroom_cta_secondary_text: Optional[str] = None
    video_showroom_cta_secondary_link: Optional[str] = None
    video_showroom_stats: Optional[List[dict]] = None
    video_showroom_floating_badge_title: Optional[str] = None
    video_showroom_floating_badge_subtitle: Optional[str] = None
    # Showroom Tours section (multi-video playlist)
    showroom_tours_visible: Optional[bool] = None
    showroom_tours_title: Optional[str] = None
    showroom_tours_subtitle: Optional[str] = None
    showroom_tours_videos: Optional[List[dict]] = None
    # Google Reviews section
    google_reviews_visible: Optional[bool] = None
    google_reviews_rating: Optional[str] = None
    google_reviews: Optional[List[dict]] = None


class WebsiteSettings(BaseModel):
    site_name: Optional[str] = None
    tagline: Optional[str] = None
    logo_url: Optional[str] = None
    favicon_url: Optional[str] = None
    primary_color: Optional[str] = None
    secondary_color: Optional[str] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None
    address: Optional[str] = None
    social_facebook: Optional[str] = None
    social_instagram: Optional[str] = None
    social_twitter: Optional[str] = None
    footer_text: Optional[str] = None
    google_analytics_id: Optional[str] = None


# ============ CATEGORY GROUPS ENDPOINTS ============

@router.get("/category-groups")
async def get_all_category_groups():
    """Get all category groups"""
    groups = await db.category_groups.find({}).sort("display_order", 1).to_list(100)
    for group in groups:
        group["id"] = str(group.pop("_id"))
        # Get count of categories in this group
        group["category_count"] = await db.website_categories.count_documents({"group_slug": group["slug"]})
    return groups


@router.get("/category-groups/{group_id}")
async def get_category_group(group_id: str):
    """Get single category group with its categories"""
    from bson import ObjectId
    group = await db.category_groups.find_one({"_id": ObjectId(group_id)})
    if not group:
        raise HTTPException(status_code=404, detail="Category group not found")
    
    group["id"] = str(group.pop("_id"))
    
    # Get categories in this group
    categories = await db.website_categories.find({"group_slug": group["slug"]}).sort("display_order", 1).to_list(1000)
    for cat in categories:
        cat["id"] = str(cat.pop("_id"))
    group["categories"] = categories
    
    return group


@router.post("/category-groups")
async def create_category_group(group: CategoryGroupCreate):
    """Create new category group"""
    data = group.dict()
    data["created_at"] = datetime.now(timezone.utc)
    data["updated_at"] = datetime.now(timezone.utc)
    
    # Check for duplicate slug
    existing = await db.category_groups.find_one({"slug": data["slug"]})
    if existing:
        raise HTTPException(status_code=400, detail="Category group with this slug already exists")
    
    result = await db.category_groups.insert_one(data)
    return {"id": str(result.inserted_id), "message": "Category group created"}


@router.put("/category-groups/reorder")
async def reorder_category_groups(data: dict):
    """Reorder category groups by updating their display_order"""
    from bson import ObjectId
    
    groups = data.get("groups", [])
    
    for group_data in groups:
        group_id = group_data.get("id")
        display_order = group_data.get("display_order", 0)
        
        if group_id:
            try:
                await db.category_groups.update_one(
                    {"_id": ObjectId(group_id)},
                    {"$set": {"display_order": display_order}}
                )
            except Exception as e:
                print(f"Error updating group {group_id}: {e}")
    
    return {"message": "Category groups reordered successfully"}


@router.put("/category-groups/{group_id}")
async def update_category_group(group_id: str, group: CategoryGroupCreate):
    """Update category group"""
    from bson import ObjectId
    data = group.dict()
    data["updated_at"] = datetime.now(timezone.utc)
    
    result = await db.category_groups.update_one(
        {"_id": ObjectId(group_id)},
        {"$set": data}
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Category group not found")
    return {"message": "Category group updated"}


@router.delete("/category-groups/{group_id}")
async def delete_category_group(group_id: str):
    """Delete category group (categories in group will become ungrouped)"""
    from bson import ObjectId
    
    # Get the group to find its slug
    group = await db.category_groups.find_one({"_id": ObjectId(group_id)})
    if not group:
        raise HTTPException(status_code=404, detail="Category group not found")
    
    # Set categories in this group to have no group (or default group)
    await db.website_categories.update_many(
        {"group_slug": group["slug"]},
        {"$set": {"group_slug": None}}
    )
    
    result = await db.category_groups.delete_one({"_id": ObjectId(group_id)})
    return {"message": "Category group deleted", "categories_ungrouped": True}


@router.post("/category-groups/seed-defaults")
async def seed_default_category_groups():
    """Seed default category groups"""
    
    # Check if already seeded
    existing = await db.category_groups.count_documents({})
    if existing > 0:
        return {"message": "Category groups already exist", "skipped": True}
    
    default_groups = [
        {
            "name": "Tiles",
            "slug": "tiles",
            "description": "Wall tiles, floor tiles, and decorative tiles",
            "icon": "Grid3X3",
            "color": "#3B82F6",
            "display_order": 1,
            "is_active": True
        },
        {
            "name": "Underfloor Heating",
            "slug": "underfloor-heating",
            "description": "Electric and water-based underfloor heating systems",
            "icon": "Flame",
            "color": "#EF4444",
            "display_order": 2,
            "is_active": True
        },
        {
            "name": "Materials",
            "slug": "materials",
            "description": "Adhesives, grouts, sealants, and primers",
            "icon": "Package",
            "color": "#10B981",
            "display_order": 3,
            "is_active": True
        },
        {
            "name": "Tools",
            "slug": "tools",
            "description": "Tiling tools and equipment",
            "icon": "Wrench",
            "color": "#F59E0B",
            "display_order": 4,
            "is_active": True
        },
        {
            "name": "Accessories",
            "slug": "accessories",
            "description": "Trims, spacers, and finishing products",
            "icon": "Puzzle",
            "color": "#8B5CF6",
            "display_order": 5,
            "is_active": True
        }
    ]
    
    for group_data in default_groups:
        group_data["created_at"] = datetime.now(timezone.utc)
        group_data["updated_at"] = datetime.now(timezone.utc)
        await db.category_groups.insert_one(group_data)
    
    # Update existing categories to belong to "tiles" group
    await db.website_categories.update_many(
        {"group_slug": {"$exists": False}},
        {"$set": {"group_slug": "tiles"}}
    )
    await db.website_categories.update_many(
        {"group_slug": None},
        {"$set": {"group_slug": "tiles"}}
    )
    
    return {
        "message": "Default category groups created",
        "groups_created": len(default_groups),
        "existing_categories_assigned": "tiles"
    }


# ============ CATEGORIES ENDPOINTS ============

@router.get("/categories")
async def get_all_categories(group_slug: Optional[str] = None):
    """Get all website categories with hierarchy, optionally filtered by group"""
    query = {}
    if group_slug:
        query["group_slug"] = group_slug
    
    categories = await db.website_categories.find(query).sort("display_order", 1).to_list(1000)
    for cat in categories:
        cat["id"] = str(cat.pop("_id"))
    return categories


@router.get("/categories/by-group")
async def get_categories_grouped():
    """Get all categories organized by their groups"""
    # Get all groups
    groups = await db.category_groups.find({"is_active": True}).sort("display_order", 1).to_list(100)
    
    result = []
    for group in groups:
        group["id"] = str(group.pop("_id"))
        
        # Get categories for this group
        categories = await db.website_categories.find(
            {"group_slug": group["slug"]}
        ).sort("display_order", 1).to_list(1000)
        
        for cat in categories:
            cat["id"] = str(cat.pop("_id"))
        
        group["categories"] = categories
        result.append(group)
    
    # Also get ungrouped categories
    ungrouped = await db.website_categories.find({
        "$or": [
            {"group_slug": {"$exists": False}},
            {"group_slug": None},
            {"group_slug": ""}
        ]
    }).sort("display_order", 1).to_list(1000)
    
    if ungrouped:
        for cat in ungrouped:
            cat["id"] = str(cat.pop("_id"))
        result.append({
            "id": "ungrouped",
            "name": "Ungrouped",
            "slug": "ungrouped",
            "description": "Categories not assigned to a group",
            "categories": ungrouped
        })
    
    return result


@router.get("/public/categories")
@bulletproof_endpoint(
    cache_namespace="public_categories",
    empty_check=lambda r: not r,
    empty_fallback=[],
)
async def get_public_categories():
    """
    Public endpoint for categories - no auth required.
    Used by shop navigation and filters.
    """
    categories = await db.website_categories.find(
        {"is_active": True},
        {"_id": 0, "name": 1, "slug": 1, "description": 1, "image_url": 1, "product_count": 1}
    ).sort("display_order", 1).to_list(1000)
    return categories


@router.get("/categories/homepage")
async def get_homepage_categories():
    """
    Get categories marked for homepage display.
    These are categories with show_on_homepage: true.
    No limit - returns ALL categories with Homepage badge.
    """
    categories = await db.website_categories.find(
        {"is_active": True, "show_on_homepage": True},
        {"_id": 0, "name": 1, "slug": 1, "description": 1, "image_url": 1, 
         "product_count": 1, "subtitle": 1, "highlight": 1, "display_order": 1,
         "custom_url": 1}
    ).sort("display_order", 1).to_list(100)
    
    return categories


@router.get("/categories/dropdown")
async def get_categories_for_dropdown():
    """
    Get categories formatted for dropdown selection in admin panel.
    This is the single source of truth for category dropdowns.
    """
    categories = await db.website_categories.find(
        {},
        {"_id": 0, "name": 1, "slug": 1, "is_active": 1, "product_count": 1}
    ).sort("name", 1).to_list(1000)
    
    # Also get categories from products that might not be in website_categories yet
    product_categories = await db.supplier_products.distinct("category")
    
    # Merge - add any missing categories
    existing_names = {c["name"].lower() for c in categories}
    for cat in product_categories:
        if cat and cat.strip() and cat.lower() not in existing_names:
            categories.append({
                "name": cat,
                "slug": cat.lower().replace(" ", "-"),
                "is_active": False,  # Not in website_categories yet
                "product_count": 0,
                "needs_sync": True
            })
    
    return categories


@router.put("/categories/reorder")
async def reorder_categories(order: List[dict]):
    """Reorder categories - expects [{id: "...", display_order: 1}, ...]"""
    from bson import ObjectId
    for item in order:
        await db.website_categories.update_one(
            {"_id": ObjectId(item["id"])},
            {"$set": {"display_order": item["display_order"]}}
        )
    return {"message": "Categories reordered successfully"}


@router.get("/categories/{category_id}")
async def get_category(category_id: str):
    """Get single category"""
    from bson import ObjectId
    from bson.errors import InvalidId
    
    if not category_id or category_id in ('undefined', 'null'):
        raise HTTPException(status_code=400, detail="Invalid category ID")
    try:
        oid = ObjectId(category_id)
    except (InvalidId, Exception):
        raise HTTPException(status_code=400, detail=f"Invalid category ID format: {category_id}")
    
    cat = await db.website_categories.find_one({"_id": oid})
    if not cat:
        raise HTTPException(status_code=404, detail="Category not found")
    cat["id"] = str(cat.pop("_id"))
    return cat


@router.post("/categories")
async def create_category(category: CategoryCreate):
    """Create new category - auto-syncs to master categories list"""
    data = category.dict()
    data["created_at"] = datetime.now(timezone.utc)
    data["updated_at"] = datetime.now(timezone.utc)
    data["product_count"] = 0  # Initialize product count
    
    # Check for duplicate slug WITHIN THE SAME GROUP only
    # Same category name can exist independently in different groups
    existing = await db.website_categories.find_one({
        "slug": data["slug"],
        "group_slug": data.get("group_slug", "tiles")
    })
    if existing:
        raise HTTPException(
            status_code=400, 
            detail=f"Category '{data['name']}' already exists in this group"
        )
    
    result = await db.website_categories.insert_one(data)
    
    # AUTO-SYNC: Also add to master categories collection for consistency
    try:
        await db.categories.update_one(
            {"name": data["name"]},
            {
                "$set": {"name": data["name"], "slug": data["slug"], "last_updated": datetime.now(timezone.utc)},
                "$setOnInsert": {"created_at": datetime.now(timezone.utc), "source": "website_admin"}
            },
            upsert=True
        )
        logger.info(f"Auto-synced new category to master list: {data['name']}")
    except Exception as sync_err:
        logger.warning(f"Category master sync warning (non-critical): {sync_err}")
    
    return {"id": str(result.inserted_id), "message": "Category created successfully", "synced": True}


@router.put("/categories/{category_id}")
async def update_category(category_id: str, category: CategoryCreate):
    """Update category - auto-syncs name changes to master list"""
    from bson import ObjectId
    
    # Get existing category to check for name changes
    existing = await db.website_categories.find_one({"_id": ObjectId(category_id)})
    old_name = existing.get("name") if existing else None
    
    data = category.dict()
    data["updated_at"] = datetime.now(timezone.utc)
    
    result = await db.website_categories.update_one(
        {"_id": ObjectId(category_id)},
        {"$set": data}
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Category not found")
    
    # AUTO-SYNC: Update master categories list
    try:
        # Update the master categories entry
        await db.categories.update_one(
            {"name": data["name"]},
            {
                "$set": {"name": data["name"], "slug": data["slug"], "last_updated": datetime.now(timezone.utc)},
                "$setOnInsert": {"created_at": datetime.now(timezone.utc), "source": "website_admin"}
            },
            upsert=True
        )
        
        # If name changed, update products with the old category name
        if old_name and old_name != data["name"]:
            # Update products in supplier_products collection
            products_result = await db.supplier_products.update_many(
                {"category": old_name},
                {"$set": {"category": data["name"], "updated_at": datetime.now(timezone.utc)}}
            )
            # Update products in main products collection
            await db.products.update_many(
                {"category": old_name},
                {"$set": {"category": data["name"], "updated_at": datetime.now(timezone.utc)}}
            )
            logger.info(f"Auto-synced category rename: '{old_name}' → '{data['name']}' ({products_result.modified_count} products updated)")
    except Exception as sync_err:
        logger.warning(f"Category sync warning (non-critical): {sync_err}")
    
    return {"message": "Category updated successfully", "synced": True}


@router.delete("/categories/{category_id}")
async def delete_category(category_id: str, exclude_from_sync: bool = True):
    """Delete category and optionally exclude it from future syncs"""
    from bson import ObjectId
    from bson.errors import InvalidId
    
    # Validate category_id
    if not category_id or category_id == 'undefined' or category_id == 'null':
        raise HTTPException(status_code=400, detail="Invalid category ID")
    
    try:
        oid = ObjectId(category_id)
    except (InvalidId, Exception):
        raise HTTPException(status_code=400, detail=f"Invalid category ID format: {category_id}")
    
    # Check if category has children
    children = await db.website_categories.find_one({"parent_id": category_id})
    if children:
        raise HTTPException(status_code=400, detail="Cannot delete category with sub-categories")
    
    # Get the category before deleting to get its slug
    category = await db.website_categories.find_one({"_id": oid})
    if not category:
        raise HTTPException(status_code=404, detail="Category not found")
    
    slug = category.get("slug")
    
    result = await db.website_categories.delete_one({"_id": oid})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Category not found")
    
    # If exclude_from_sync is True, add to excluded list so it doesn't come back on sync
    if exclude_from_sync and slug:
        await db.sync_settings.update_one(
            {"type": "excluded_categories"},
            {"$addToSet": {"slugs": slug}},
            upsert=True
        )
    
    return {"message": "Category deleted successfully", "excluded_from_sync": exclude_from_sync}


@router.post("/categories/sync-from-products")
async def sync_categories_from_products():
    """
    Sync website categories from existing product data.
    Creates main categories from unique categories in products and supplier_products collections.
    Respects excluded_categories - categories user has deleted won't come back.
    """
    try:
        synced_count = 0
        
        # Get excluded categories (ones user has deleted and doesn't want back)
        excluded_doc = await db.sync_settings.find_one({"type": "excluded_categories"})
        excluded_slugs = set(excluded_doc.get("slugs", []) if excluded_doc else [])
        
        # Define the main category structure based on Room/Location types
        main_categories = [
            {"name": "Floor Tiles", "slug": "floor-tiles", "description": "Quality floor tiles for every room"},
            {"name": "Wall Tiles", "slug": "wall-tiles", "description": "Beautiful wall tiles for any space"},
            {"name": "Wall & Floor Tiles", "slug": "wall-floor-tiles", "description": "Versatile tiles suitable for walls and floors"},
            {"name": "Bathroom Tiles", "slug": "bathroom-tiles", "description": "Stylish bathroom tile collections"},
            {"name": "Kitchen Tiles", "slug": "kitchen-tiles", "description": "Durable kitchen tile options"},
            {"name": "Outdoor Tiles", "slug": "outdoor-tiles", "description": "Weather-resistant outdoor tiles"},
            {"name": "Mosaic Tiles", "slug": "mosaic-tiles", "description": "Decorative mosaic tile collections"},
            {"name": "Clearance", "slug": "clearance", "description": "Discounted tile clearance items"},
        ]
        
        # Get unique categories from products collection
        product_categories = await db.products.distinct("category")
        
        # Get unique categories from supplier_products collection  
        supplier_categories = await db.supplier_products.distinct("category")
        
        # Combine and deduplicate - SKIP comma-separated values (invalid multi-value categories)
        all_categories = set()
        for cat in product_categories + supplier_categories:
            if cat and isinstance(cat, str) and cat.strip():
                # Skip comma-separated values - these are data errors
                if ',' in cat:
                    continue
                all_categories.add(cat.strip())
        
        # Add categories from product data that aren't in main list
        for cat_name in all_categories:
            slug = cat_name.lower().replace(' ', '-').replace('&', 'and')
            slug = ''.join(c if c.isalnum() or c == '-' else '' for c in slug)
            
            # Skip if in excluded list
            if slug in excluded_slugs:
                continue
            
            # Check if already in main categories
            exists_in_main = any(m["slug"] == slug or m["name"].lower() == cat_name.lower() for m in main_categories)
            if not exists_in_main:
                main_categories.append({
                    "name": cat_name,
                    "slug": slug,
                    "description": f"{cat_name} tile collection"
                })
        
        # Insert categories that don't exist AND aren't excluded
        for cat_data in main_categories:
            # Skip excluded categories
            if cat_data["slug"] in excluded_slugs:
                continue
                
            existing = await db.website_categories.find_one({"slug": cat_data["slug"]})
            if not existing:
                await db.website_categories.insert_one({
                    "name": cat_data["name"],
                    "slug": cat_data["slug"],
                    "description": cat_data["description"],
                    "parent_id": None,
                    "image_url": "",
                    "display_order": synced_count,
                    "is_active": True,
                    "show_on_homepage": True if synced_count < 6 else False,
                    "seo_title": cat_data["name"],
                    "seo_description": cat_data["description"],
                    "product_count": 0,
                    "created_at": datetime.now(timezone.utc),
                    "updated_at": datetime.now(timezone.utc)
                })
                synced_count += 1
        
        # AUTO-UPDATE: Refresh product counts for all categories
        counts_updated = 0
        try:
            if CATEGORY_SYNC_AVAILABLE:
                result = await update_category_product_counts(db)
                counts_updated = result.get("categories_updated", 0)
            else:
                # Fallback: basic count update
                all_cats = await db.website_categories.find({}).to_list(1000)
                for cat in all_cats:
                    cat_name = cat["name"]
                    count = await db.supplier_products.count_documents({
                        "$or": [
                            {"category": cat_name},
                            {"category": {"$regex": f"^{cat_name}$", "$options": "i"}}
                        ]
                    })
                    await db.website_categories.update_one(
                        {"_id": cat["_id"]},
                        {"$set": {"product_count": count, "updated_at": datetime.now(timezone.utc)}}
                    )
                    counts_updated += 1
        except Exception as count_err:
            logger.warning(f"Product count update warning: {count_err}")
        
        # Get count of product categories for reporting
        total_categories = await db.website_categories.count_documents({})
        
        return {
            "success": True,
            "message": f"Sync complete. Added {synced_count} new categories. Updated {counts_updated} product counts.",
            "total_categories": total_categories,
            "categories_from_products": list(all_categories),
            "counts_updated": counts_updated
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Sync failed: {str(e)}")


# ============ FILTERS ENDPOINTS ============

@router.get("/filters")
async def get_all_filters():
    """Get all filter types with options"""
    filters = await db.website_filters.find({}).sort("display_order", 1).to_list(100)
    for f in filters:
        f["id"] = str(f.pop("_id"))
    return filters


@router.get("/filters/{filter_id}")
async def get_filter(filter_id: str):
    """Get single filter type"""
    from bson import ObjectId
    f = await db.website_filters.find_one({"_id": ObjectId(filter_id)})
    if not f:
        raise HTTPException(status_code=404, detail="Filter not found")
    f["id"] = str(f.pop("_id"))
    return f


@router.post("/filters")
async def create_filter(filter_type: FilterTypeCreate):
    """Create new filter type"""
    data = filter_type.dict()
    data["created_at"] = datetime.utcnow()
    data["updated_at"] = datetime.utcnow()
    
    # Check for duplicate slug
    existing = await db.website_filters.find_one({"slug": data["slug"]})
    if existing:
        raise HTTPException(status_code=400, detail="Filter with this slug already exists")
    
    result = await db.website_filters.insert_one(data)
    return {"id": str(result.inserted_id), "message": "Filter created successfully"}


@router.put("/filters/{filter_id}")
async def update_filter(filter_id: str, filter_type: FilterTypeCreate):
    """Update filter type"""
    from bson import ObjectId
    data = filter_type.dict()
    data["updated_at"] = datetime.utcnow()
    
    result = await db.website_filters.update_one(
        {"_id": ObjectId(filter_id)},
        {"$set": data}
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Filter not found")
    return {"message": "Filter updated successfully"}


@router.delete("/filters/{filter_id}")
async def delete_filter(filter_id: str):
    """Delete filter type"""
    from bson import ObjectId
    result = await db.website_filters.delete_one({"_id": ObjectId(filter_id)})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Filter not found")
    return {"message": "Filter deleted successfully"}


@router.post("/filters/{filter_id}/options")
async def add_filter_option(filter_id: str, option: FilterOptionCreate):
    """Add option to filter type"""
    from bson import ObjectId
    data = option.dict()
    
    result = await db.website_filters.update_one(
        {"_id": ObjectId(filter_id)},
        {"$push": {"options": data}}
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Filter not found")
    return {"message": "Option added successfully"}


@router.delete("/filters/{filter_id}/options/{option_value}")
async def remove_filter_option(filter_id: str, option_value: str):
    """Remove option from filter type"""
    from bson import ObjectId
    result = await db.website_filters.update_one(
        {"_id": ObjectId(filter_id)},
        {"$pull": {"options": {"value": option_value}}}
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Filter not found")
    return {"message": "Option removed successfully"}


# ============ PRODUCTS ENDPOINTS ============

@router.get("/products")
async def get_website_products(
    page: int = 1,
    limit: int = 20,
    search: Optional[str] = None,
    category: Optional[str] = None,
    status: Optional[str] = None
):
    """Get products for website admin with pagination"""
    query = {}
    
    if search:
        query["$or"] = [
            {"name": {"$regex": search, "$options": "i"}},
            {"website_name": {"$regex": search, "$options": "i"}},
            {"sku": {"$regex": search, "$options": "i"}}
        ]
    
    if category:
        query["category_ids"] = category
    
    if status == "active":
        query["is_active"] = True
    elif status == "inactive":
        query["is_active"] = False
    
    skip = (page - 1) * limit
    total = await db.tiles.count_documents(query)
    
    products = await db.tiles.find(query, {"_id": 0}).skip(skip).limit(limit).to_list(limit)
    
    return {
        "products": products,
        "total": total,
        "page": page,
        "pages": (total + limit - 1) // limit
    }


@router.get("/products/{product_id}")
async def get_product_for_edit(product_id: str):
    """Get single product for editing"""
    product = await db.tiles.find_one({"id": product_id}, {"_id": 0})
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    return product


@router.put("/products/{product_id}")
async def update_product(product_id: str, updates: ProductUpdate):
    """Update product details"""
    data = {k: v for k, v in updates.dict().items() if v is not None}
    data["updated_at"] = datetime.utcnow()
    
    result = await db.tiles.update_one(
        {"id": product_id},
        {"$set": data}
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Product not found")
    return {"message": "Product updated successfully"}


@router.post("/products")
async def create_manual_product(
    name: str = Form(...),
    website_name: str = Form(None),
    sku: str = Form(...),
    price: float = Form(...),
    description: str = Form(""),
    category_ids: str = Form(""),  # Comma-separated
    finish: str = Form(""),
    material: str = Form(""),
    size: str = Form(""),
    color: str = Form(""),
    is_active: bool = Form(True),
    is_featured: bool = Form(False)
):
    """Create a manual product entry"""
    import secrets
    
    # Generate unique ID
    product_id = f"manual_{secrets.token_hex(8)}"
    slug = (website_name or name).lower().replace(" ", "-").replace("'", "")
    
    # Check for duplicate SKU
    existing = await db.tiles.find_one({"sku": sku})
    if existing:
        raise HTTPException(status_code=400, detail="Product with this SKU already exists")
    
    product = {
        "id": product_id,
        "name": name,
        "website_name": website_name or name,
        "display_name": website_name or name,
        "sku": sku,
        "supplier_code": sku,
        "slug": slug,
        "price": price,
        "room_lot_price": price,
        "pallet_price": price * 0.9,  # 10% discount for pallet
        "description": description,
        "short_description": description[:200] if description else "",
        "category_ids": [c.strip() for c in category_ids.split(",") if c.strip()],
        "finish": finish,
        "material": material,
        "size": size,
        "color": color,
        "images": [],
        "is_active": is_active,
        "is_featured": is_featured,
        "is_manual": True,
        "stock": 100,
        "created_at": datetime.utcnow(),
        "updated_at": datetime.utcnow()
    }
    
    await db.tiles.insert_one(product)
    return {"id": product_id, "message": "Product created successfully"}


@router.delete("/products/{product_id}")
async def delete_product(product_id: str):
    """Delete a product (only manual products)"""
    product = await db.tiles.find_one({"id": product_id})
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    
    if not product.get("is_manual"):
        raise HTTPException(status_code=400, detail="Cannot delete imported products. Deactivate instead.")
    
    await db.tiles.delete_one({"id": product_id})
    return {"message": "Product deleted successfully"}


@router.post("/products/{product_id}/images")
async def add_product_image(product_id: str, image_url: str = Form(...)):
    """Add image URL to product"""
    result = await db.tiles.update_one(
        {"id": product_id},
        {"$push": {"images": image_url}}
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Product not found")
    return {"message": "Image added successfully"}


@router.delete("/products/{product_id}/images")
async def remove_product_image(product_id: str, image_url: str):
    """Remove image from product"""
    result = await db.tiles.update_one(
        {"id": product_id},
        {"$pull": {"images": image_url}}
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Product not found")
    return {"message": "Image removed successfully"}


@router.put("/products/{product_id}/images/reorder")
async def reorder_product_images(product_id: str, images: List[str]):
    """Reorder product images"""
    result = await db.tiles.update_one(
        {"id": product_id},
        {"$set": {"images": images}}
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Product not found")
    return {"message": "Images reordered successfully"}


# ============ HOMEPAGE CONTENT ENDPOINTS ============

@router.get("/homepage")
async def get_homepage_content():
    """Get homepage content"""
    content = await db.page_content.find_one({"page_key": "homepage"}, {"_id": 0})
    return content.get("content", {}) if content else {}


@router.put("/homepage")
async def update_homepage_content(content: HomepageContent):
    """Update homepage content (partial merge)"""
    data = {k: v for k, v in content.dict().items() if v is not None}

    existing = await db.page_content.find_one({"page_key": "homepage"}, {"_id": 0})
    merged = deep_merge(existing.get("content", {}) if existing else {}, data)
    
    await db.page_content.update_one(
        {"page_key": "homepage"},
        {"$set": {"page_key": "homepage", "content": merged, "updated_at": datetime.utcnow()}},
        upsert=True
    )
    return {"message": "Homepage content updated successfully"}


MAX_VIDEO_SIZE = 200 * 1024 * 1024  # 200 MB
ALLOWED_VIDEO_TYPES = {"video/mp4", "video/webm", "video/quicktime"}
ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}


@router.post("/homepage/upload-video")
async def upload_homepage_video(file: UploadFile = File(...)):
    """Upload a video for the homepage video showroom section. Max 200MB."""
    from services.object_storage import put_object

    if file.content_type not in ALLOWED_VIDEO_TYPES:
        raise HTTPException(status_code=400, detail=f"Invalid file type '{file.content_type}'. Allowed: mp4, webm, mov")

    data = await file.read()
    if len(data) > MAX_VIDEO_SIZE:
        raise HTTPException(status_code=400, detail=f"File too large ({len(data) / 1024 / 1024:.1f}MB). Maximum is 200MB.")

    ext = file.filename.rsplit(".", 1)[-1].lower() if "." in file.filename else "mp4"
    path = f"tile-station/homepage/video/{uuid.uuid4()}.{ext}"
    result = put_object(path, data, file.content_type)

    return {
        "storage_path": result["path"],
        "original_filename": file.filename,
        "content_type": file.content_type,
        "size": len(data),
    }


@router.post("/homepage/upload-thumbnail")
async def upload_homepage_thumbnail(file: UploadFile = File(...)):
    """Upload a thumbnail image for the video showroom section."""
    from services.object_storage import put_object

    if file.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=400, detail=f"Invalid image type '{file.content_type}'. Allowed: jpeg, png, webp, gif")

    data = await file.read()
    if len(data) > 10 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Image too large. Maximum is 10MB.")

    ext = file.filename.rsplit(".", 1)[-1].lower() if "." in file.filename else "jpg"
    path = f"tile-station/homepage/thumbnails/{uuid.uuid4()}.{ext}"
    result = put_object(path, data, file.content_type)

    return {
        "storage_path": result["path"],
        "original_filename": file.filename,
        "content_type": file.content_type,
        "size": len(data),
    }


@router.get("/homepage/media/{path:path}")
async def serve_homepage_media(path: str):
    """Serve uploaded homepage media (video/image) publicly for shop display."""
    from services.object_storage import get_object
    from fastapi.responses import Response

    full_path = f"tile-station/homepage/{path}"
    try:
        data, content_type = get_object(full_path)
        return Response(content=data, media_type=content_type)
    except Exception as e:
        logger.error(f"Failed to serve media {full_path}: {e}")
        raise HTTPException(status_code=404, detail="Media not found")


# ============ WEBSITE SETTINGS ENDPOINTS ============

@router.get("/settings")
async def get_website_settings():
    """Get website settings"""
    settings = await db.website_settings.find_one({"key": "main"}, {"_id": 0})
    return settings.get("settings", {}) if settings else {}


@router.put("/settings")
async def update_website_settings(settings: WebsiteSettings):
    """Update website settings"""
    data = {k: v for k, v in settings.dict().items() if v is not None}
    
    await db.website_settings.update_one(
        {"key": "main"},
        {"$set": {"key": "main", "settings": data, "updated_at": datetime.utcnow()}},
        upsert=True
    )
    return {"message": "Settings updated successfully"}


# ============ IMAGE UPLOAD ENDPOINT ============

@router.post("/upload-image")
async def upload_image(
    file: UploadFile = File(...),
    folder: str = Form("products")
):
    """Upload image to Cloudflare R2 storage (with local fallback)"""
    # Validate file type
    allowed_types = ["image/jpeg", "image/png", "image/webp", "image/gif"]
    if file.content_type not in allowed_types:
        raise HTTPException(status_code=400, detail="Invalid file type. Allowed: JPEG, PNG, WebP, GIF")
    
    # Read file content
    content = await file.read()
    
    # Generate unique filename
    ext = file.filename.split(".")[-1].lower() if "." in file.filename else "jpg"
    if ext not in ["jpg", "jpeg", "png", "webp", "gif"]:
        ext = "jpg"
    unique_id = uuid.uuid4().hex
    filename = f"{folder}/{unique_id}.{ext}"
    
    # Try to upload to R2 first
    try:
        from services.storage.r2_uploader import R2ImageUploader, optimize_image, upload_to_r2
        
        if R2ImageUploader.is_configured():
            # Optimize the image before upload
            optimized_content = optimize_image(content)
            
            # Upload to R2
            r2_key = filename
            r2_url = upload_to_r2(optimized_content, r2_key)
            
            if r2_url:
                logger.info(f"Image uploaded to R2: {r2_url}")
                return {
                    "url": r2_url,
                    "filename": filename,
                    "storage": "r2",
                    "message": "Image uploaded successfully to cloud storage"
                }
    except Exception as e:
        logger.warning(f"R2 upload failed, falling back to local: {e}")
    
    # Fallback to local storage
    upload_dir = f"/app/frontend/public/uploads/{folder}"
    os.makedirs(upload_dir, exist_ok=True)
    
    file_path = f"/app/frontend/public/uploads/{filename}"
    with open(file_path, "wb") as f:
        f.write(content)
    
    return {
        "url": f"/uploads/{filename}",
        "filename": filename,
        "storage": "local",
        "message": "Image uploaded locally"
    }


# ============ BULK OPERATIONS ============

@router.post("/products/bulk-update")
async def bulk_update_products(
    product_ids: List[str],
    updates: dict
):
    """Bulk update multiple products"""
    updates["updated_at"] = datetime.utcnow()
    
    result = await db.tiles.update_many(
        {"id": {"$in": product_ids}},
        {"$set": updates}
    )
    return {"message": f"Updated {result.modified_count} products"}


@router.post("/products/bulk-category")
async def bulk_assign_category(
    product_ids: List[str],
    category_id: str,
    action: str = "add"  # add or remove
):
    """Bulk assign/remove category from products"""
    if action == "add":
        result = await db.tiles.update_many(
            {"id": {"$in": product_ids}},
            {"$addToSet": {"category_ids": category_id}}
        )
    else:
        result = await db.tiles.update_many(
            {"id": {"$in": product_ids}},
            {"$pull": {"category_ids": category_id}}
        )
    return {"message": f"Updated {result.modified_count} products"}


# ============ STATS ENDPOINTS ============

@router.get("/stats")
async def get_website_stats():
    """Get website statistics for dashboard"""
    total_products = await db.tiles.count_documents({})
    active_products = await db.tiles.count_documents({"is_active": True})
    featured_products = await db.tiles.count_documents({"is_featured": True})
    total_categories = await db.website_categories.count_documents({})
    total_filters = await db.website_filters.count_documents({})
    
    return {
        "total_products": total_products,
        "active_products": active_products,
        "featured_products": featured_products,
        "inactive_products": total_products - active_products,
        "total_categories": total_categories,
        "total_filters": total_filters
    }


# ============ NAVIGATION MENU ENDPOINTS ============

class NavMenuItem(BaseModel):
    id: Optional[str] = None
    label: str
    link_type: str = "custom"  # custom, category, page
    link_url: Optional[str] = ""
    category_id: Optional[str] = None
    page_slug: Optional[str] = None
    display_order: int = 0
    is_active: bool = True
    highlight: bool = False  # For items like "SALE"
    highlight_color: Optional[str] = None
    children: List[dict] = []  # For dropdown menus


class NavigationMenu(BaseModel):
    menu_type: str = "main"  # main, footer, mobile
    items: List[NavMenuItem] = []


@router.get("/navigation/{menu_type}")
async def get_navigation_menu(menu_type: str = "main"):
    """Get navigation menu items"""
    menu = await db.navigation_menus.find_one({"menu_type": menu_type}, {"_id": 0})
    if menu:
        return menu.get("items", [])
    
    # Return default menu if none exists
    if menu_type == "main":
        return [
            {"id": "1", "label": "NEW COLLECTION", "link_type": "custom", "link_url": "/shop/tiles?collection=new", "display_order": 0, "is_active": True, "highlight": False, "children": []},
            {"id": "2", "label": "ALL TILES", "link_type": "custom", "link_url": "/shop/tiles", "display_order": 1, "is_active": True, "highlight": False, "children": []},
            {"id": "3", "label": "WALL TILES", "link_type": "custom", "link_url": "/shop/tiles?type=wall", "display_order": 2, "is_active": True, "highlight": False, "children": []},
            {"id": "4", "label": "FLOOR TILES", "link_type": "custom", "link_url": "/shop/tiles?type=floor", "display_order": 3, "is_active": True, "highlight": False, "children": []},
            {"id": "5", "label": "POLISHED", "link_type": "custom", "link_url": "/shop/tiles?finish=polished", "display_order": 4, "is_active": True, "highlight": False, "children": []},
            {"id": "6", "label": "MATT", "link_type": "custom", "link_url": "/shop/tiles?finish=matt", "display_order": 5, "is_active": True, "highlight": False, "children": []},
            {"id": "7", "label": "TILING ACCESSORIES", "link_type": "custom", "link_url": "/shop/tiles?category=accessories", "display_order": 6, "is_active": True, "highlight": False, "children": []},
            {"id": "8", "label": "SALE", "link_type": "custom", "link_url": "/shop/tiles?sale=true", "display_order": 7, "is_active": True, "highlight": True, "highlight_color": "#ef4444", "children": []}
        ]
    if menu_type == "shop":
        return [
            {"id": "1", "label": "ALL TILES", "link_url": "/shop/tiles", "display_order": 0, "is_active": True, "highlight": False},
            {"id": "2", "label": "WALL TILES", "link_url": "/shop/tiles?category=wall-tiles", "display_order": 1, "is_active": True, "highlight": False},
            {"id": "3", "label": "FLOOR TILES", "link_url": "/shop/tiles?category=floor-tiles", "display_order": 2, "is_active": True, "highlight": False},
            {"id": "4", "label": "PORCELAIN", "link_url": "/shop/tiles?category=porcelain", "display_order": 3, "is_active": True, "highlight": False},
            {"id": "5", "label": "POLISHED", "link_url": "/shop/tiles?filter=finish:polished", "display_order": 4, "is_active": True, "highlight": False},
            {"id": "6", "label": "MATT", "link_url": "/shop/tiles?filter=finish:matt", "display_order": 5, "is_active": True, "highlight": False},
            {"id": "7", "label": "SALE", "link_url": "/shop/tiles?filter=sale:true", "display_order": 6, "is_active": True, "highlight": True, "highlight_color": "#ef4444"}
        ]
    return []


@router.put("/navigation/{menu_type}")
async def update_navigation_menu(menu_type: str, items: List[dict]):
    """Update navigation menu items"""
    # Add IDs to items that don't have them
    for i, item in enumerate(items):
        if not item.get("id"):
            item["id"] = str(uuid.uuid4())[:8]
        item["display_order"] = i
    
    await db.navigation_menus.update_one(
        {"menu_type": menu_type},
        {"$set": {"menu_type": menu_type, "items": items, "updated_at": datetime.utcnow()}},
        upsert=True
    )
    return {"message": "Navigation menu updated successfully"}


@router.post("/navigation/{menu_type}/item")
async def add_navigation_item(menu_type: str, item: NavMenuItem):
    """Add single item to navigation menu"""
    item_dict = item.dict()
    item_dict["id"] = str(uuid.uuid4())[:8]
    
    # Get current menu
    menu = await db.navigation_menus.find_one({"menu_type": menu_type})
    items = menu.get("items", []) if menu else []
    
    # Set display order
    item_dict["display_order"] = len(items)
    items.append(item_dict)
    
    await db.navigation_menus.update_one(
        {"menu_type": menu_type},
        {"$set": {"menu_type": menu_type, "items": items, "updated_at": datetime.utcnow()}},
        upsert=True
    )
    return {"id": item_dict["id"], "message": "Menu item added successfully"}


@router.delete("/navigation/{menu_type}/item/{item_id}")
async def delete_navigation_item(menu_type: str, item_id: str):
    """Delete item from navigation menu"""
    result = await db.navigation_menus.update_one(
        {"menu_type": menu_type},
        {"$pull": {"items": {"id": item_id}}}
    )
    if result.modified_count == 0:
        raise HTTPException(status_code=404, detail="Menu item not found")
    return {"message": "Menu item deleted successfully"}


# Public endpoint for frontend to fetch navigation
@router.get("/public/navigation/{menu_type}")
@bulletproof_endpoint(
    cache_namespace="public_navigation",
    empty_check=lambda r: not r,
    empty_fallback=[],
)
async def get_public_navigation(menu_type: str = "main"):
    """Public endpoint to get navigation menu (no auth required)"""
    menu = await db.navigation_menus.find_one({"menu_type": menu_type}, {"_id": 0})
    if menu:
        # Filter only active items
        items = [item for item in menu.get("items", []) if item.get("is_active", True)]
        return sorted(items, key=lambda x: x.get("display_order", 0))
    
    # Return default menu based on type
    if menu_type == "main":
        return [
            {"id": "1", "label": "NEW COLLECTION", "link_url": "/shop/tiles?collection=new", "display_order": 0, "is_active": True, "highlight": False},
            {"id": "2", "label": "ALL TILES", "link_url": "/shop/tiles", "display_order": 1, "is_active": True, "highlight": False},
            {"id": "3", "label": "WALL TILES", "link_url": "/shop/tiles?type=wall", "display_order": 2, "is_active": True, "highlight": False},
            {"id": "4", "label": "FLOOR TILES", "link_url": "/shop/tiles?type=floor", "display_order": 3, "is_active": True, "highlight": False},
            {"id": "5", "label": "POLISHED", "link_url": "/shop/tiles?finish=polished", "display_order": 4, "is_active": True, "highlight": False},
            {"id": "6", "label": "MATT", "link_url": "/shop/tiles?finish=matt", "display_order": 5, "is_active": True, "highlight": False},
            {"id": "7", "label": "TILING ACCESSORIES", "link_url": "/shop/tiles?category=accessories", "display_order": 6, "is_active": True, "highlight": False},
            {"id": "8", "label": "SALE", "link_url": "/shop/tiles?sale=true", "display_order": 7, "is_active": True, "highlight": True, "highlight_color": "#ef4444"}
        ]
    
    # Shop page navigation (collections tabs)
    if menu_type == "shop":
        return [
            {"id": "1", "label": "ALL TILES", "link_url": "/shop/tiles", "display_order": 0, "is_active": True, "highlight": False},
            {"id": "2", "label": "WALL TILES", "link_url": "/shop/tiles?category=wall-tiles", "display_order": 1, "is_active": True, "highlight": False},
            {"id": "3", "label": "FLOOR TILES", "link_url": "/shop/tiles?category=floor-tiles", "display_order": 2, "is_active": True, "highlight": False},
            {"id": "4", "label": "PORCELAIN", "link_url": "/shop/tiles?category=porcelain", "display_order": 3, "is_active": True, "highlight": False},
            {"id": "5", "label": "POLISHED", "link_url": "/shop/tiles?filter=finish:polished", "display_order": 4, "is_active": True, "highlight": False},
            {"id": "6", "label": "MATT", "link_url": "/shop/tiles?filter=finish:matt", "display_order": 5, "is_active": True, "highlight": False},
            {"id": "7", "label": "SALE", "link_url": "/shop/tiles?filter=sale:true", "display_order": 6, "is_active": True, "highlight": True, "highlight_color": "#ef4444"}
        ]
    
    return []


# ============ WEBSITE PUBLISH SYSTEM ============
# Staging system for website design changes

@router.get("/pending-changes")
async def get_pending_changes():
    """
    Get list of pending (unpublished) website design changes.
    Returns changes to settings, homepage, categories, filters, navigation.
    """
    try:
        pending = await db.website_pending_changes.find({}).to_list(100)
        
        # Convert ObjectId to string
        for change in pending:
            change["_id"] = str(change["_id"])
        
        # Group by type
        changes_by_type = {}
        for change in pending:
            change_type = change.get("type", "other")
            if change_type not in changes_by_type:
                changes_by_type[change_type] = []
            changes_by_type[change_type].append(change)
        
        return {
            "has_pending": len(pending) > 0,
            "total_changes": len(pending),
            "changes": pending,
            "by_type": changes_by_type
        }
    except Exception as e:
        return {"has_pending": False, "total_changes": 0, "changes": [], "error": str(e)}


@router.post("/save-draft")
async def save_draft_change(
    change_type: str,
    change_key: str,
    change_data: dict,
    description: str = ""
):
    """
    Save a design change as draft (not published yet).
    
    Args:
        change_type: Type of change (settings, homepage, category, filter, navigation)
        change_key: Unique key for this change (e.g., "homepage_hero", "nav_menu")
        change_data: The actual change data to save
        description: Human-readable description of the change
    """
    try:
        change_doc = {
            "type": change_type,
            "key": change_key,
            "data": change_data,
            "description": description,
            "created_at": datetime.utcnow(),
            "status": "draft"
        }
        
        # Upsert - replace existing draft for same key
        await db.website_pending_changes.update_one(
            {"type": change_type, "key": change_key},
            {"$set": change_doc},
            upsert=True
        )
        
        return {"success": True, "message": "Draft saved"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/publish-changes")
async def publish_website_changes():
    """
    Publish all pending website design changes.
    This applies all draft changes to the live website.
    """
    try:
        # Get all pending changes
        pending = await db.website_pending_changes.find({"status": "draft"}).to_list(100)
        
        if not pending:
            return {
                "success": True,
                "message": "No pending changes to publish",
                "published": 0
            }
        
        published_count = 0
        errors = []
        
        for change in pending:
            try:
                change_type = change.get("type")
                change_key = change.get("key")
                change_data = change.get("data", {})
                
                # Apply change based on type
                if change_type == "settings":
                    # Update website settings
                    await db.website_settings.update_one(
                        {"key": change_key},
                        {"$set": {"value": change_data, "updated_at": datetime.utcnow()}},
                        upsert=True
                    )
                elif change_type == "homepage":
                    # Update homepage content
                    await db.website_homepage.update_one(
                        {"section": change_key},
                        {"$set": {"content": change_data, "updated_at": datetime.utcnow()}},
                        upsert=True
                    )
                elif change_type == "navigation":
                    # Update navigation menu
                    await db.website_navigation.update_one(
                        {"menu_id": change_key},
                        {"$set": {"items": change_data, "updated_at": datetime.utcnow()}},
                        upsert=True
                    )
                elif change_type == "category":
                    # Update category
                    if "id" in change_data:
                        await db.website_categories.update_one(
                            {"id": change_data["id"]},
                            {"$set": change_data}
                        )
                elif change_type == "filter":
                    # Update filter
                    if "id" in change_data:
                        await db.website_filters.update_one(
                            {"id": change_data["id"]},
                            {"$set": change_data}
                        )
                
                # Mark as published and archive
                await db.website_published_changes.insert_one({
                    **change,
                    "published_at": datetime.utcnow(),
                    "status": "published"
                })
                
                published_count += 1
                
            except Exception as e:
                errors.append(f"{change.get('key', 'unknown')}: {str(e)[:50]}")
        
        # Clear all pending changes that were published
        await db.website_pending_changes.delete_many({"status": "draft"})
        
        return {
            "success": True,
            "message": f"Published {published_count} changes to website",
            "published": published_count,
            "errors": errors if errors else None
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/discard-changes")
async def discard_pending_changes(change_key: Optional[str] = None):
    """
    Discard pending changes without publishing.
    If change_key is provided, only discard that specific change.
    Otherwise, discard all pending changes.
    """
    try:
        if change_key:
            result = await db.website_pending_changes.delete_one({"key": change_key})
            return {
                "success": True,
                "message": f"Discarded change: {change_key}",
                "deleted": result.deleted_count
            }
        else:
            result = await db.website_pending_changes.delete_many({})
            return {
                "success": True,
                "message": "Discarded all pending changes",
                "deleted": result.deleted_count
            }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/publish-history")
async def get_publish_history(limit: int = 20):
    """Get history of published changes"""
    try:
        history = await db.website_published_changes.find({}).sort("published_at", -1).limit(limit).to_list(limit)
        
        for item in history:
            item["_id"] = str(item["_id"])
        
        return {"history": history}
    except Exception as e:
        return {"history": [], "error": str(e)}



# ============== PAGE BANNERS ==============

@router.get("/public/page-banners")
async def get_page_banner(category: str = None, group: str = None):
    """Get page banner settings for a specific category or group"""
    try:
        query = {}
        if category:
            query["category_slug"] = category
        elif group:
            query["group_slug"] = group
        else:
            query["is_default"] = True
        
        banner = await db.page_banners.find_one(query, {"_id": 0})
        if banner:
            return banner
        
        # Return empty if no custom banner found (frontend will use defaults)
        return {}
    except Exception as e:
        return {}


@router.get("/page-banners")
async def list_page_banners():
    """List all page banners"""
    banners = await db.page_banners.find({}).to_list(100)
    for b in banners:
        b["id"] = str(b["_id"])
        del b["_id"]
    return banners


@router.post("/page-banners")
async def create_page_banner(banner: dict):
    """Create or update a page banner"""
    from datetime import datetime, timezone
    
    # Required fields
    if not banner.get("title"):
        raise HTTPException(status_code=400, detail="Title is required")
    
    banner_data = {
        "title": banner.get("title"),
        "subtitle": banner.get("subtitle", ""),
        "image": banner.get("image", ""),
        "overlay": banner.get("overlay", "rgba(0,0,0,0.3)"),
        "category_slug": banner.get("category_slug"),
        "group_slug": banner.get("group_slug"),
        "is_default": banner.get("is_default", False),
        "is_active": banner.get("is_active", True),
        "updated_at": datetime.now(timezone.utc).isoformat()
    }
    
    # Check if banner exists for this category/group
    query = {}
    if banner_data["category_slug"]:
        query["category_slug"] = banner_data["category_slug"]
    elif banner_data["group_slug"]:
        query["group_slug"] = banner_data["group_slug"]
    elif banner_data["is_default"]:
        query["is_default"] = True
    
    if query:
        existing = await db.page_banners.find_one(query)
        if existing:
            # Update existing
            await db.page_banners.update_one(query, {"$set": banner_data})
            return {"message": "Banner updated", "id": str(existing["_id"])}
    
    # Create new
    result = await db.page_banners.insert_one(banner_data)
    return {"message": "Banner created", "id": str(result.inserted_id)}


@router.delete("/page-banners/{banner_id}")
async def delete_page_banner(banner_id: str):
    """Delete a page banner"""
    from bson import ObjectId
    result = await db.page_banners.delete_one({"_id": ObjectId(banner_id)})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Banner not found")
    return {"message": "Banner deleted"}



@router.post("/upload-banner-image")
async def upload_banner_image(file: UploadFile = File(...)):
    """
    Upload a banner image to R2 cloud storage.
    Returns the public URL of the uploaded image.
    """
    import uuid as uuid_module
    
    try:
        # Import R2 uploader
        try:
            from services.storage.r2_uploader import R2ImageUploader, optimize_image, upload_to_r2
        except ImportError:
            R2ImageUploader = None
            optimize_image = None
            upload_to_r2 = None
        
        # Validate file type
        allowed_types = ["image/jpeg", "image/png", "image/webp", "image/gif"]
        content_type = file.content_type or ""
        file_ext = (file.filename or "").lower().split(".")[-1] if file.filename else "jpg"
        
        if content_type not in allowed_types and file_ext not in ["jpg", "jpeg", "png", "webp", "gif"]:
            raise HTTPException(status_code=400, detail="Invalid file type. Allowed: JPEG, PNG, WebP, GIF")
        
        # Read the image data
        image_data = await file.read()
        
        # Generate a unique filename
        unique_filename = f"banner_{uuid_module.uuid4().hex[:12]}.jpg"
        
        # Try to upload to R2 if available
        image_url = None
        if R2ImageUploader and R2ImageUploader.is_configured():
            try:
                r2_key = f"banners/{unique_filename}"
                logger.info(f"Uploading banner image to R2: {r2_key}")
                
                # Optimize the image before upload (resize for banner dimensions)
                if optimize_image:
                    optimized_data = optimize_image(image_data, max_size=1920)  # Banner-appropriate size
                else:
                    optimized_data = image_data
                
                # Upload to R2
                image_url = upload_to_r2(optimized_data, r2_key)
                if image_url:
                    logger.info(f"Banner image uploaded to R2: {image_url}")
            except Exception as r2_err:
                logger.warning(f"R2 upload failed, falling back to local storage: {r2_err}")
        
        # Fallback to local storage if R2 not available or failed
        if not image_url:
            upload_dir = "/app/frontend/public/uploads/banners"
            os.makedirs(upload_dir, exist_ok=True)
            filepath = os.path.join(upload_dir, unique_filename)
            with open(filepath, "wb") as f:
                f.write(image_data)
            image_url = f"/uploads/banners/{unique_filename}"
            logger.info(f"Banner image saved locally: {image_url}")
        
        return {
            "success": True,
            "url": image_url,
            "filename": unique_filename,
            "storage": "r2" if "images.tilestation.co.uk" in (image_url or "") else "local",
            "message": "Banner image uploaded successfully"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Banner image upload error: {e}")
        raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")



# ============ FEATURE CARDS / USP MANAGEMENT ============

@router.get("/feature-cards")
async def get_feature_cards():
    """Get all feature cards for the 'Shopping with us' section"""
    cards = await db.feature_cards.find({}).sort("display_order", 1).to_list(50)
    
    # If no cards exist, seed with defaults
    if not cards:
        default_cards = [
            {
                "icon": "Palette",
                "title": "Design Your Dream Room",
                "description": "Tap into your creativity with help from our online visualiser tool.",
                "link": "/shop/visualiser",
                "display_order": 0,
                "is_active": True
            },
            {
                "icon": "Package",
                "title": "Free Samples",
                "description": "Add up to 3 free samples delivered to your door free of charge.",
                "link": "/shop/sample-service",
                "display_order": 1,
                "is_active": True
            },
            {
                "icon": "MapPin",
                "title": "Our Showrooms",
                "description": "Chat with our specialists at our Tonbridge, Gravesend, Chingford & Sydenham stores.",
                "link": "/shop/stores",
                "display_order": 2,
                "is_active": True
            },
            {
                "icon": "Truck",
                "title": "Free Delivery",
                "description": "Free delivery for orders over £499, or collect from store.",
                "link": "/shop/delivery",
                "display_order": 3,
                "is_active": True
            },
            {
                "icon": "Star",
                "title": "Loved By Customers",
                "description": "Rated 4.9 stars from thousands of happy customers.",
                "link": "/shop/reviews",
                "display_order": 4,
                "is_active": True
            },
        ]
        for card in default_cards:
            card["created_at"] = datetime.now(timezone.utc)
            await db.feature_cards.insert_one(card)
        cards = await db.feature_cards.find({}).sort("display_order", 1).to_list(50)
    
    # Convert ObjectIds to strings
    for card in cards:
        card["id"] = str(card.pop("_id"))
    
    return cards


@router.post("/feature-cards")
async def create_feature_card(card_data: dict):
    """Create a new feature card"""
    # Get max display_order
    max_order_card = await db.feature_cards.find_one({}, sort=[("display_order", -1)])
    next_order = (max_order_card.get("display_order", 0) + 1) if max_order_card else 0
    
    card = {
        "icon": card_data.get("icon", "Star"),
        "title": card_data.get("title", ""),
        "description": card_data.get("description", ""),
        "link": card_data.get("link", "/shop"),
        "display_order": card_data.get("display_order", next_order),
        "is_active": card_data.get("is_active", True),
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc)
    }
    
    result = await db.feature_cards.insert_one(card)
    
    return {
        "message": "Feature card created",
        "id": str(result.inserted_id)
    }


@router.put("/feature-cards/{card_id}")
async def update_feature_card(card_id: str, card_data: dict):
    """Update a feature card"""
    update_fields = {
        "updated_at": datetime.now(timezone.utc)
    }
    
    allowed_fields = ["icon", "title", "description", "link", "display_order", "is_active"]
    for field in allowed_fields:
        if field in card_data:
            update_fields[field] = card_data[field]
    
    result = await db.feature_cards.update_one(
        {"_id": ObjectId(card_id)},
        {"$set": update_fields}
    )
    
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Feature card not found")
    
    return {"message": "Feature card updated"}


@router.delete("/feature-cards/{card_id}")
async def delete_feature_card(card_id: str):
    """Delete a feature card"""
    result = await db.feature_cards.delete_one({"_id": ObjectId(card_id)})
    
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Feature card not found")
    
    return {"message": "Feature card deleted"}


@router.post("/feature-cards/reorder")
async def reorder_feature_cards(data: dict):
    """Reorder feature cards by providing an ordered list of IDs"""
    card_ids = data.get("card_ids", [])
    
    for idx, card_id in enumerate(card_ids):
        await db.feature_cards.update_one(
            {"_id": ObjectId(card_id)},
            {"$set": {"display_order": idx}}
        )
    
    return {"message": f"Reordered {len(card_ids)} feature cards"}


# Public endpoint for the frontend
@router.get("/feature-cards/public")
async def get_public_feature_cards():
    """Get active feature cards for the public website"""
    cards = await db.feature_cards.find({"is_active": True}).sort("display_order", 1).to_list(50)
    
    # If no cards exist, return defaults
    if not cards:
        return [
            {"icon": "Palette", "title": "Design Your Dream Room", "description": "Tap into your creativity with help from our online visualiser tool.", "link": "/shop/visualiser"},
            {"icon": "Package", "title": "Free Samples", "description": "Add up to 3 free samples delivered to your door free of charge.", "link": "/shop/sample-service"},
            {"icon": "MapPin", "title": "Our Showrooms", "description": "Chat with our specialists at our Tonbridge, Gravesend, Chingford & Sydenham stores.", "link": "/shop/stores"},
            {"icon": "Truck", "title": "Free Delivery", "description": "Free delivery for orders over £499, or collect from store.", "link": "/shop/info/delivery"},
            {"icon": "Star", "title": "Loved By Customers", "description": "Rated 4.9 stars from thousands of happy customers.", "link": "/shop/reviews"},
        ]
    
    # Return only necessary fields
    return [
        {
            "icon": card.get("icon", "Star"),
            "title": card.get("title", ""),
            "description": card.get("description", ""),
            "link": card.get("link", "/shop")
        }
        for card in cards
    ]



# ============== HERO SLIDES (Homepage Carousel) ==============

@router.get("/hero-slides")
async def get_hero_slides():
    """Get all hero slides for homepage carousel - Admin"""
    slides = await db.hero_slides.find({}).sort("display_order", 1).to_list(20)
    for slide in slides:
        slide["id"] = str(slide["_id"])
        del slide["_id"]
    return slides


@router.get("/public/hero-slides")
@bulletproof_endpoint(
    cache_namespace="public_hero_slides",
    empty_check=lambda r: not r,
    empty_fallback=[],
)
async def get_public_hero_slides():
    """Get active hero slides for homepage carousel - Public"""
    slides = await db.hero_slides.find(
        {"is_active": True},
        {"_id": 0}
    ).sort("display_order", 1).to_list(10)
    
    # Return default slides if none configured
    if not slides:
        return [
            {
                "image": "https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?w=1600&q=80",
                "badge": "UP TO 1/3 OFF",
                "title": "THE SPRING COLLECTION",
                "subtitle": "Revitalise your home this spring with savings you'll love!",
                "cta": "Shop Now",
                "link": "/tiles?sale=true"
            }
        ]
    return slides


@router.post("/hero-slides")
async def save_hero_slides(data: dict):
    """Save all hero slides - replaces entire set"""
    slides = data.get("slides", [])
    
    if isinstance(slides, list):
        # Bulk save mode: replace all slides
        await db.hero_slides.delete_many({})
        if slides:
            slides_to_insert = []
            for i, slide in enumerate(slides):
                slides_to_insert.append({
                    "image": slide.get("image", ""),
                    "badge": slide.get("badge", ""),
                    "title": slide.get("title", ""),
                    "subtitle": slide.get("subtitle", ""),
                    "cta": slide.get("cta", "Shop Now"),
                    "link": slide.get("link", "/tiles"),
                    "theme": slide.get("theme", "default"),
                    "discount": slide.get("discount", ""),
                    "badgeColor": slide.get("badgeColor", ""),
                    "badgeTextColor": slide.get("badgeTextColor", ""),
                    "ctaColor": slide.get("ctaColor", ""),
                    "ctaTextColor": slide.get("ctaTextColor", ""),
                    "display_order": i,
                    "is_active": slide.get("is_active", True),
                    "created_at": slide.get("created_at", datetime.now(timezone.utc))
                })
            await db.hero_slides.insert_many(slides_to_insert)
        return {"message": f"Saved {len(slides)} hero slides"}
    else:
        # Single slide creation (legacy)
        slide_data = {
            "image": data.get("image", ""),
            "badge": data.get("badge", ""),
            "title": data.get("title", ""),
            "subtitle": data.get("subtitle", ""),
            "cta": data.get("cta", "Shop Now"),
            "link": data.get("link", "/tiles"),
            "display_order": data.get("display_order", 0),
            "is_active": data.get("is_active", True),
            "created_at": datetime.now(timezone.utc)
        }
        result = await db.hero_slides.insert_one(slide_data)
        return {"id": str(result.inserted_id), "message": "Hero slide created"}


@router.put("/hero-slides/{slide_id}")
async def update_hero_slide(slide_id: str, slide: dict):
    """Update a hero slide"""
    from bson import ObjectId
    update_data = {
        "image": slide.get("image"),
        "badge": slide.get("badge"),
        "title": slide.get("title"),
        "subtitle": slide.get("subtitle"),
        "cta": slide.get("cta"),
        "link": slide.get("link"),
        "display_order": slide.get("display_order"),
        "is_active": slide.get("is_active"),
        "updated_at": datetime.utcnow()
    }
    # Remove None values
    update_data = {k: v for k, v in update_data.items() if v is not None}
    
    await db.hero_slides.update_one(
        {"_id": ObjectId(slide_id)},
        {"$set": update_data}
    )
    return {"message": "Hero slide updated"}


@router.delete("/hero-slides/{slide_id}")
async def delete_hero_slide(slide_id: str):
    """Delete a hero slide"""
    from bson import ObjectId
    await db.hero_slides.delete_one({"_id": ObjectId(slide_id)})
    return {"message": "Hero slide deleted"}


# ============== BENEFITS BAR ==============

@router.get("/benefits-bar")
async def get_benefits_bar():
    """Get all benefits bar items - Admin"""
    benefits = await db.benefits_bar.find({}).sort("display_order", 1).to_list(20)
    for benefit in benefits:
        benefit["id"] = str(benefit["_id"])
        del benefit["_id"]
    return benefits


@router.get("/public/benefits-bar")
async def get_public_benefits_bar():
    """Get active benefits bar items - Public"""
    benefits = await db.benefits_bar.find(
        {"is_active": True},
        {"_id": 0}
    ).sort("display_order", 1).to_list(10)
    
    # Return defaults if none configured
    if not benefits:
        return [
            {"text": "Pay in 3 ways with Klarna", "link": "/shop/tile-cart"},
            {"text": "Free samples with free delivery", "link": "/shop/sample-service"},
            {"text": "Free collection from all stores", "link": "/shop/contact"},
            {"text": "Free delivery on orders over £499", "link": "/shop/info/delivery"}
        ]
    return benefits


@router.post("/benefits-bar")
async def save_benefits_bar(request: Request):
    """Save all benefits bar items (bulk replace)"""
    from bson import ObjectId
    
    benefits = await request.json()
    
    # Handle both single benefit and array of benefits
    if isinstance(benefits, dict):
        # Single benefit - create it
        benefit_data = {
            "text": benefits.get("text", ""),
            "link": benefits.get("link", "/shop"),
            "display_order": benefits.get("display_order", 0),
            "is_active": benefits.get("is_active", True),
            "created_at": datetime.utcnow()
        }
        result = await db.benefits_bar.insert_one(benefit_data)
        return {"id": str(result.inserted_id), "message": "Benefit created"}
    
    # Array of benefits - bulk save
    # Delete all existing benefits and insert new ones
    await db.benefits_bar.delete_many({})
    
    if benefits and len(benefits) > 0:
        benefits_to_insert = []
        for idx, benefit in enumerate(benefits):
            benefits_to_insert.append({
                "text": benefit.get("text", ""),
                "link": benefit.get("link", "/shop"),
                "display_order": idx,
                "is_active": benefit.get("is_active", True),
                "created_at": datetime.utcnow()
            })
        
        if benefits_to_insert:
            await db.benefits_bar.insert_many(benefits_to_insert)
    
    return {"message": "Benefits bar saved successfully", "count": len(benefits) if isinstance(benefits, list) else 1}


@router.put("/benefits-bar/{benefit_id}")
async def update_benefit(benefit_id: str, benefit: dict):
    """Update a benefits bar item"""
    from bson import ObjectId
    update_data = {
        "text": benefit.get("text"),
        "link": benefit.get("link"),
        "display_order": benefit.get("display_order"),
        "is_active": benefit.get("is_active"),
        "updated_at": datetime.utcnow()
    }
    update_data = {k: v for k, v in update_data.items() if v is not None}
    
    await db.benefits_bar.update_one(
        {"_id": ObjectId(benefit_id)},
        {"$set": update_data}
    )
    return {"message": "Benefit updated"}


@router.delete("/benefits-bar/{benefit_id}")
async def delete_benefit(benefit_id: str):
    """Delete a benefits bar item"""
    from bson import ObjectId
    await db.benefits_bar.delete_one({"_id": ObjectId(benefit_id)})
    return {"message": "Benefit deleted"}



# ============ COLLECTION MANAGER ============

class CollectionSettings(BaseModel):
    series_name: str
    custom_hero_image: Optional[str] = None
    custom_title: Optional[str] = None
    custom_description: Optional[str] = None
    is_featured: bool = False
    display_order: int = 0
    is_hidden: bool = False


@router.get("/collections")
async def get_all_collections():
    """
    Get all collections/series with their settings.
    Extracts series names from product names (same logic as shop collections page).
    Combines auto-generated data with custom settings from DB.
    Uses the 'tiles' collection (same as shop) for consistency.
    """
    import re
    from collections import defaultdict
    
    try:
        # Color words to strip from series names (same as tiles.py)
        COLOR_WORDS = {
            'white', 'black', 'grey', 'gray', 'beige', 'cream', 'ivory', 'brown', 'blue',
            'green', 'red', 'yellow', 'orange', 'pink', 'purple', 'gold', 'silver',
            'charcoal', 'anthracite', 'taupe', 'sand', 'bone', 'pearl', 'light', 'dark',
            'natural', 'almond', 'crema', 'bianco', 'grigio', 'nero', 'avorio',
            'decor', 'feature', 'border', 'mosaic', 'listello'
        }
        
        def extract_series_name(product_name):
            """Extract series name from product name (everything before dimensions, without color suffix)"""
            if not product_name:
                return "Other"
            parts = product_name.strip().split()
            series_parts = []
            for part in parts:
                if re.match(r'^\d+[xX]\d+', part):
                    break
                series_parts.append(part)
            
            if not series_parts:
                return product_name
            
            # Remove trailing color words
            while series_parts and series_parts[-1].lower() in COLOR_WORDS:
                series_parts.pop()
            
            if not series_parts:
                return ' '.join(product_name.strip().split()[:2])
            
            return ' '.join(series_parts)
        
        # Fetch products from 'tiles' collection (same as shop uses)
        # This ensures consistency between admin and shop views
        products_cursor = db.tiles.find(
            {},
            {"display_name": 1, "name": 1, "images": 1, "image": 1, "room_lot_price": 1, "supplier_name": 1}
        )
        products = await products_cursor.to_list(10000)
        
        # Group by extracted series name
        series_groups = defaultdict(lambda: {
            "products": [],
            "images": [],
            "prices": [],
            "supplier": None
        })
        
        for p in products:
            name = p.get("display_name") or p.get("name") or ""
            series_name = extract_series_name(name)
            
            if not series_name or series_name == "Other":
                continue
            
            group = series_groups[series_name]
            group["products"].append(p)
            
            # Collect images
            if p.get("images") and len(p["images"]) > 0:
                group["images"].append(p["images"][0])
            elif p.get("image"):
                group["images"].append(p["image"])
            
            # Collect prices (coerce — some imports store prices as strings)
            price = p.get("room_lot_price") or p.get("price")
            try:
                price = float(price)
            except (TypeError, ValueError):
                price = None
            if price:
                group["prices"].append(price)
            
            # Set supplier
            if not group["supplier"] and (p.get("supplier_name") or p.get("supplier")):
                group["supplier"] = p.get("supplier_name") or p.get("supplier")
        
        # Get custom settings from DB
        custom_settings = {}
        settings_cursor = db.collection_settings.find({})
        async for setting in settings_cursor:
            key = setting.get("series_name")
            if not key:
                continue
            custom_settings[key] = {
                "custom_hero_image": setting.get("custom_hero_image"),
                "custom_title": setting.get("custom_title"),
                "custom_description": setting.get("custom_description"),
                "is_featured": setting.get("is_featured", False),
                "display_order": setting.get("display_order", 0),
                "is_hidden": setting.get("is_hidden", False),
                "variant_label": setting.get("variant_label"),
                "hero_zoom": setting.get("hero_zoom"),
                "hero_pos_x": setting.get("hero_pos_x"),
                "hero_pos_y": setting.get("hero_pos_y"),
            }
        
        # Build collections list
        collections = []
        for series_name, group in series_groups.items():
            if len(group["products"]) < 1:
                continue
            
            settings = custom_settings.get(series_name, {})
            
            # Get first valid image
            auto_image = group["images"][0] if group["images"] else None
            
            collections.append({
                "series_name": series_name,
                "product_count": len(group["products"]),
                "auto_hero_image": auto_image,
                "custom_hero_image": settings.get("custom_hero_image"),
                "hero_image": settings.get("custom_hero_image") or auto_image,
                "custom_title": settings.get("custom_title"),
                "custom_description": settings.get("custom_description"),
                "variant_label": settings.get("variant_label"),
                "hero_zoom": settings.get("hero_zoom"),
                "hero_pos_x": settings.get("hero_pos_x"),
                "hero_pos_y": settings.get("hero_pos_y"),
                "is_featured": settings.get("is_featured", False),
                "display_order": settings.get("display_order", 0),
                "is_hidden": settings.get("is_hidden", False),
                "supplier": group["supplier"],
                "min_price": min(group["prices"]) if group["prices"] else 0,
                "max_price": max(group["prices"]) if group["prices"] else 0,
            })
        
        # Sort by featured status, display_order, then by product_count
        # (bool/float coercion — settings docs can hold None or string values)
        def _sort_key(x):
            try:
                order = float(x.get("display_order") or 0)
            except (TypeError, ValueError):
                order = 0.0
            return (-bool(x.get("is_featured")), order, -x.get("product_count", 0))
        collections.sort(key=_sort_key)
        
        return {
            "collections": collections,
            "total": len(collections)
        }
    except Exception as e:
        logger.error(f"Error fetching collections: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/collections/{series_name}")
async def update_collection_settings(series_name: str, settings: dict):
    """Update collection settings (custom image, title, etc.)"""
    try:
        update_data = {
            "series_name": series_name,
            "updated_at": datetime.utcnow()
        }
        
        # Only update provided fields
        if "custom_hero_image" in settings:
            update_data["custom_hero_image"] = settings["custom_hero_image"]
        if "custom_title" in settings:
            update_data["custom_title"] = settings["custom_title"]
        if "custom_description" in settings:
            update_data["custom_description"] = settings["custom_description"]
        if "is_featured" in settings:
            update_data["is_featured"] = settings["is_featured"]
        if "display_order" in settings:
            update_data["display_order"] = settings["display_order"]
        if "is_hidden" in settings:
            update_data["is_hidden"] = settings["is_hidden"]
        if "variant_label" in settings:
            update_data["variant_label"] = settings["variant_label"]
        if "hero_zoom" in settings:
            update_data["hero_zoom"] = settings["hero_zoom"]
        if "hero_pos_x" in settings:
            update_data["hero_pos_x"] = settings["hero_pos_x"]
        if "hero_pos_y" in settings:
            update_data["hero_pos_y"] = settings["hero_pos_y"]
        
        await db.collection_settings.update_one(
            {"series_name": series_name},
            {"$set": update_data},
            upsert=True
        )
        
        return {"message": "Collection settings updated", "series_name": series_name}
    except Exception as e:
        logger.error(f"Error updating collection settings: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/collection-settings/{series_name}")
async def get_collection_settings(series_name: str):
    """Get collection settings directly from collection_settings by series name."""
    try:
        setting = await db.collection_settings.find_one(
            {"series_name": series_name},
            {"_id": 0}
        )
        if setting:
            return {"found": True, "settings": setting}
        return {"found": False, "settings": None}
    except Exception as e:
        logger.error(f"Error fetching collection settings for {series_name}: {e}")
        raise HTTPException(status_code=500, detail=str(e))



@router.post("/collections/upload-image")
async def upload_collection_image(file: UploadFile = File(...), series_name: str = Form(...)):
    """Upload a custom hero image for a collection"""
    try:
        # Import R2 uploader
        try:
            from services.storage.r2_uploader import R2ImageUploader, optimize_image, upload_to_r2
        except ImportError:
            R2ImageUploader = None
            optimize_image = None
            upload_to_r2 = None
        
        # Validate file type
        allowed_types = ["image/jpeg", "image/png", "image/webp", "image/gif"]
        content_type = file.content_type or ""
        if content_type not in allowed_types:
            raise HTTPException(status_code=400, detail="Invalid file type. Allowed: JPEG, PNG, WebP, GIF")
        
        # Read the image data
        image_data = await file.read()
        
        # Generate a unique filename
        safe_series_name = series_name.lower().replace(" ", "-").replace("/", "-")[:50]
        unique_filename = f"collection_{safe_series_name}_{uuid.uuid4().hex[:8]}.jpg"
        
        # Try to upload to R2 if available
        image_url = None
        if R2ImageUploader and R2ImageUploader.is_configured():
            try:
                r2_key = f"collections/{unique_filename}"
                logger.info(f"Uploading collection image to R2: {r2_key}")
                
                # Optimize the image before upload
                if optimize_image:
                    optimized_data = optimize_image(image_data, max_size=1200)
                else:
                    optimized_data = image_data
                
                # Upload to R2
                image_url = upload_to_r2(optimized_data, r2_key)
                if image_url:
                    logger.info(f"Collection image uploaded to R2: {image_url}")
            except Exception as r2_err:
                logger.warning(f"R2 upload failed, falling back to local storage: {r2_err}")
        
        # Fallback to local storage if R2 not available or failed
        if not image_url:
            upload_dir = "/app/frontend/public/uploads/collections"
            os.makedirs(upload_dir, exist_ok=True)
            filepath = os.path.join(upload_dir, unique_filename)
            with open(filepath, "wb") as f:
                f.write(image_data)
            image_url = f"/uploads/collections/{unique_filename}"
            logger.info(f"Collection image saved locally: {image_url}")
        
        # Update collection settings with new image
        await db.collection_settings.update_one(
            {"series_name": series_name},
            {"$set": {
                "series_name": series_name,
                "custom_hero_image": image_url,
                "updated_at": datetime.utcnow()
            }},
            upsert=True
        )
        
        return {
            "success": True,
            "url": image_url,
            "filename": unique_filename,
            "series_name": series_name,
            "storage": "r2" if "images.tilestation.co.uk" in (image_url or "") else "local",
            "message": "Collection image uploaded successfully"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Collection image upload error: {e}")
        raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")


@router.delete("/collections/{series_name}/image")
async def delete_collection_image(series_name: str):
    """Remove custom hero image from a collection (reverts to auto-generated)"""
    try:
        await db.collection_settings.update_one(
            {"series_name": series_name},
            {"$set": {"custom_hero_image": None, "updated_at": datetime.utcnow()}}
        )
        return {"message": "Custom image removed", "series_name": series_name}
    except Exception as e:
        logger.error(f"Error removing collection image: {e}")
        raise HTTPException(status_code=500, detail=str(e))



# ============ COLLECTION CARD DISPLAY SETTINGS ============

@router.get("/collection-card-settings")
async def get_collection_card_settings():
    """Get collection card display settings"""
    try:
        settings = await db.website_settings.find_one({"_id": "collection_card_settings"})
        if settings:
            # Remove MongoDB _id before returning
            settings.pop("_id", None)
            return settings
        return {
            "enableZoom": False,
            "shadowStyle": "elegant",
            "borderRadius": "rounded",
            "showBorder": True,
            "hoverEffect": "shadow"
        }
    except Exception as e:
        logger.error(f"Error fetching card settings: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/collection-card-settings")
async def update_collection_card_settings(settings: dict):
    """Update collection card display settings"""
    try:
        update_data = {
            "_id": "collection_card_settings",
            "enableZoom": settings.get("enableZoom", False),
            "shadowStyle": settings.get("shadowStyle", "elegant"),
            "borderRadius": settings.get("borderRadius", "rounded"),
            "showBorder": settings.get("showBorder", True),
            "hoverEffect": settings.get("hoverEffect", "shadow"),
            "updated_at": datetime.utcnow()
        }
        
        await db.website_settings.update_one(
            {"_id": "collection_card_settings"},
            {"$set": update_data},
            upsert=True
        )
        
        return {"message": "Card settings updated", "settings": update_data}
    except Exception as e:
        logger.error(f"Error updating card settings: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============ INFO PAGES (Delivery, Returns, FAQ, etc.) ============

@router.get("/info-pages")
async def get_all_info_pages():
    """Get all info pages (public)"""
    try:
        pages = await db.info_pages.find({}, {"_id": 0}).to_list(length=100)
        return {"pages": pages}
    except Exception as e:
        logger.error(f"Error fetching info pages: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/info-pages/{slug}")
async def get_info_page(slug: str):
    """Get a single info page by slug (public) - supports slug aliases and auto-seeds defaults"""
    SLUG_ALIASES = {
        "terms-and-conditions": "terms",
        "terms-conditions": "terms",
        "privacy-policy": "privacy",
        "faqs": "faq",
        "frequently-asked-questions": "faq",
        "returns-refunds": "returns",
        "returns-and-refunds": "returns",
        "delivery-information": "delivery",
        "contact-us": "contact",
        "track-order": "track",
    }
    DEFAULT_INFO_PAGES = {
        "delivery": {
            "slug": "delivery", "title": "Delivery Information", "enabled": True,
            "sections": [
                {"id": "delivery-cards", "type": "cards", "title": "Delivery Highlights", "cards": [
                    {"title": "Delivery Date", "description": "At the checkout, choose a delivery date that works for you", "icon": "Calendar"},
                    {"title": "Truck Access", "description": "Access must be obstacle-free, wide enough and flat for safe delivery", "icon": "Truck"},
                    {"title": "No Loose Surfaces", "description": "Surfaces must be hard and flat: tarmac, concrete or block paving", "icon": "Shield"},
                    {"title": "Express Delivery", "description": "Need your tiles quicker? Upgrade to Express Delivery", "icon": "Zap"},
                ]},
                {"id": "delivery-times", "type": "text", "title": "Delivery Times",
                 "content": "We aim to deliver all orders within 2-3 working days from Monday to Friday excluding Saturday and Sunday.\n\nPlease note that orders containing multiple samples or underfloor heating products will be delivered separately."},
                {"id": "delivery-rates", "type": "table", "title": "Delivery Rates", "rows": [
                    {"description": "UK online orders over £299 (excluding Scotland)", "price": "FREE"},
                    {"description": "Free Cut Sample Delivery", "price": "FREE"},
                    {"description": "Small Full-Size Sample (Parcel up to 2 KG)", "price": "£0.99"},
                    {"description": "Small Orders (Less Than 18 Kg)", "price": "£11.99"},
                    {"description": "Pallet Delivery for orders under £299", "price": "Calculated at checkout"},
                ]},
                {"id": "delivery-conditions", "type": "text", "title": "Delivery Conditions",
                 "content": "Most deliveries are made on pallets and are delivered kerbside. This means your tiles will be left secured to the pallet at the nearest external location of your property which has a flat hard surface.\n\nThe pallet is manoeuvred using a hand pump truck that cannot operate on soft ground or loose gravel.\n\nSome tile boxes weigh more than 30kg each — we recommend arranging help on the day of delivery.\n\nFailed deliveries will incur a redelivery charge per pallet determined by the logistics company."},
            ]
        },
        "returns": {
            "slug": "returns", "title": "Returns & Refunds", "enabled": True,
            "sections": [
                {"id": "returns-overview", "type": "text", "title": "Returns Policy",
                 "content": "We want you to be completely happy with your purchase. If for any reason you are not satisfied, you can return unused products within 30 days of delivery for a full refund.\n\nPlease note that cut samples cannot be returned. Full-size samples can be returned if they are in their original, unopened packaging."},
                {"id": "returns-steps", "type": "cards", "title": "How to Return", "cards": [
                    {"title": "Step 1: Contact Us", "description": "Email or call us to arrange your return and receive a returns authorisation number", "icon": "Phone"},
                    {"title": "Step 2: Pack Items", "description": "Repack the tiles securely in their original packaging to prevent damage in transit", "icon": "Package"},
                    {"title": "Step 3: Ship Back", "description": "Send the items back to us using a tracked delivery service. You are responsible for return shipping costs", "icon": "Truck"},
                    {"title": "Step 4: Refund", "description": "Once we receive and inspect the items, we will process your refund within 5-10 working days", "icon": "CreditCard"},
                ]},
                {"id": "returns-conditions", "type": "text", "title": "Conditions",
                 "content": "Items must be unused, in their original packaging, and in a resalable condition.\n\nBespoke or made-to-order items cannot be returned.\n\nA restocking fee of 25% may apply for large pallet orders.\n\nRefunds will be made to the original payment method."},
            ]
        },
        "faq": {
            "slug": "faq", "title": "Frequently Asked Questions", "enabled": True,
            "sections": [
                {"id": "faq-ordering", "type": "text", "title": "Ordering",
                 "content": "**How do I place an order?**\nSimply browse our range, add products to your basket, and proceed to checkout. You can pay by card or request a trade account.\n\n**Can I order samples?**\nYes! We offer free cut samples and full-size samples for a small fee so you can see and feel the tiles before committing.\n\n**Can I change or cancel my order?**\nPlease contact us as soon as possible. Orders that have already been dispatched cannot be cancelled but can be returned."},
                {"id": "faq-delivery", "type": "text", "title": "Delivery",
                 "content": "**How long does delivery take?**\nWe aim to deliver within 2-3 working days. Express delivery options are available at checkout.\n\n**Do you deliver to Scotland?**\nYes, but delivery charges may vary. Please check at checkout for accurate pricing.\n\n**What if I'm not home?**\nPallet deliveries are kerbside only. You do not need to be present, but the delivery area must be accessible."},
                {"id": "faq-products", "type": "text", "title": "Products",
                 "content": "**Are your tiles suitable for underfloor heating?**\nMost of our tiles are compatible with underfloor heating. Check the product specifications or contact us for advice.\n\n**Do you offer fitting services?**\nWe do not offer fitting directly but can recommend trusted local fitters.\n\n**What is the difference between wall and floor tiles?**\nFloor tiles are thicker and more durable. Wall tiles are lighter and designed for vertical surfaces. Some tiles are suitable for both."},
            ]
        },
        "privacy": {
            "slug": "privacy", "title": "Privacy Policy", "enabled": True,
            "sections": [
                {"id": "privacy-intro", "type": "text", "title": "Introduction",
                 "content": "Tile Station Ltd is committed to protecting your privacy. This policy explains how we collect, use, and safeguard your personal information when you use our website and services."},
                {"id": "privacy-collection", "type": "text", "title": "Information We Collect",
                 "content": "We may collect the following information:\n\n- Name and contact details (email, phone, address)\n- Payment information (processed securely via our payment provider)\n- Order history and preferences\n- Website usage data via cookies\n- Communication records when you contact us"},
                {"id": "privacy-use", "type": "text", "title": "How We Use Your Information",
                 "content": "We use your information to:\n\n- Process and deliver your orders\n- Communicate with you about your orders\n- Improve our products and services\n- Send marketing communications (only with your consent)\n- Comply with legal obligations"},
                {"id": "privacy-rights", "type": "text", "title": "Your Rights",
                 "content": "Under GDPR, you have the right to:\n\n- Access your personal data\n- Correct inaccurate data\n- Request deletion of your data\n- Object to processing of your data\n- Request data portability\n\nTo exercise these rights, contact us at info@tilestation.co.uk."},
            ]
        },
        "terms": {
            "slug": "terms", "title": "Terms & Conditions", "enabled": True,
            "sections": [
                {"id": "terms-general", "type": "text", "title": "General",
                 "content": "These terms and conditions govern your use of the Tile Station website and the purchase of products from us. By placing an order, you agree to be bound by these terms.\n\nTile Station Ltd reserves the right to update these terms at any time."},
                {"id": "terms-pricing", "type": "text", "title": "Pricing & Payment",
                 "content": "All prices are shown in GBP and include VAT where applicable. Trade account holders may see prices excluding VAT.\n\nWe accept payment by major credit and debit cards. Payment is taken at the time of order.\n\nWhile we make every effort to ensure pricing accuracy, errors may occasionally occur. In such cases, we will contact you before processing the order."},
                {"id": "terms-liability", "type": "text", "title": "Liability",
                 "content": "Tile Station Ltd shall not be liable for any indirect or consequential loss arising from the use of our products.\n\nOur liability is limited to the purchase price of the products ordered.\n\nWe recommend professional installation for all products. Tile Station is not responsible for installation defects."},
            ]
        },
    }
    try:
        page = await db.info_pages.find_one({"slug": slug}, {"_id": 0})
        if not page:
            canonical = SLUG_ALIASES.get(slug)
            if canonical:
                page = await db.info_pages.find_one({"slug": canonical}, {"_id": 0})
        if not page:
            resolved_slug = SLUG_ALIASES.get(slug, slug)
            default = DEFAULT_INFO_PAGES.get(resolved_slug)
            if default:
                default["updated_at"] = datetime.now(timezone.utc).isoformat()
                await db.info_pages.update_one(
                    {"slug": resolved_slug}, {"$set": default}, upsert=True
                )
                page = default
        if not page:
            return {"page": None}
        return {"page": page}
    except Exception as e:
        logger.error(f"Error fetching info page: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/info-pages/{slug}")
async def save_info_page(slug: str, data: dict):
    """Save/update an info page"""
    try:
        page_data = data.get("page", {})
        page_data["slug"] = slug
        page_data["updated_at"] = datetime.now(timezone.utc).isoformat()
        
        await db.info_pages.update_one(
            {"slug": slug},
            {"$set": page_data},
            upsert=True
        )
        return {"message": f"Info page '{slug}' saved", "page": page_data}
    except Exception as e:
        logger.error(f"Error saving info page: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============ FOOTER SETTINGS ============

@router.get("/footer-settings")
async def get_footer_settings():
    """Get footer settings (public - no auth required)"""
    try:
        settings = await db.website_settings.find_one({"_id": "footer_settings"})
        if settings:
            settings.pop("_id", None)
            return {"settings": settings.get("settings", {})}
        return {"settings": {}}
    except Exception as e:
        logger.error(f"Error fetching footer settings: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/footer-settings")
async def save_footer_settings(data: dict):
    """Save footer settings (admin only)"""
    try:
        settings = data.get("settings", {})
        await db.website_settings.update_one(
            {"_id": "footer_settings"},
            {"$set": {
                "_id": "footer_settings",
                "settings": settings,
                "updated_at": datetime.now(timezone.utc)
            }},
            upsert=True
        )
        return {"message": "Footer settings saved successfully", "settings": settings}
    except Exception as e:
        logger.error(f"Error saving footer settings: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============ SITE MAP & LINK MANAGER ============

@router.post("/migrate-tools-accessories")
async def migrate_tools_accessories_group(current_user: dict = Depends(get_current_user)):
    """One-shot DB consolidation: merges legacy `tools` and `accessories`
    product-group records into a unified `tools-accessories` group across
    every place admins might have saved them.

    Safe to run multiple times — idempotent. Call once on production after
    the Railway redeploy lands to clean up the data.

    Scope:
      - website_categories.group_slug
      - tiles.product_group
      - navigation_menus[*].items[*].link_url (?group=tools, ?group=accessories)
      - website_settings.collection_page_settings.settings (legacy keys merged)
    """
    if current_user.get("role") not in ["super_admin", "admin"]:
        raise HTTPException(status_code=403, detail="Not authorized")

    summary = {
        "categories_updated": 0,
        "tiles_updated": 0,
        "nav_menus_updated": 0,
        "settings_keys_merged": 0,
    }

    # 1) Categories
    res1 = await db.website_categories.update_many(
        {"group_slug": {"$in": ["tools", "accessories"]}},
        {"$set": {"group_slug": "tools-accessories",
                   "updated_at": datetime.now(timezone.utc).isoformat()}},
    )
    summary["categories_updated"] = res1.modified_count

    # 2) Tiles (product catalogue)
    res2 = await db.tiles.update_many(
        {"product_group": {"$in": ["tools", "accessories"]}},
        {"$set": {"product_group": "tools-accessories"}},
    )
    summary["tiles_updated"] = res2.modified_count

    # 3) Navigation menus
    async for m in db.navigation_menus.find({}):
        items = m.get("items") or []
        changed = False
        seen_ta = False
        new_items = []
        for it in items:
            url = it.get("link_url") or ""
            if "?group=tools" in url and "tools-accessories" not in url:
                if seen_ta:
                    continue
                it["link_url"] = "/tiles?group=tools-accessories"
                it["label"] = "Tools & Accessories"
                changed = True
                seen_ta = True
            elif "?group=accessories" in url:
                if seen_ta:
                    continue
                it["link_url"] = "/tiles?group=tools-accessories"
                it["label"] = "Tools & Accessories"
                changed = True
                seen_ta = True
            new_items.append(it)
        if changed:
            await db.navigation_menus.update_one({"_id": m["_id"]}, {"$set": {"items": new_items}})
            summary["nav_menus_updated"] += 1

    # 4) Page settings — merge legacy keys
    s = await db.website_settings.find_one({"_id": "collection_page_settings"})
    if s and isinstance(s.get("settings"), dict):
        sett = s["settings"]
        moved = 0
        for legacy in ("tools", "accessories"):
            if legacy in sett:
                sett.setdefault("tools-accessories", sett[legacy])
                del sett[legacy]
                moved += 1
        if moved:
            await db.website_settings.update_one(
                {"_id": "collection_page_settings"},
                {"$set": {"settings": sett}},
            )
            summary["settings_keys_merged"] = moved

    await _record_maintenance_run("tools_accessories_merge", summary, current_user.get("email"))
    return {"success": True, **summary}


# ============ MAINTENANCE TASKS REGISTRY ============
# Each one-shot migrator records its last result + timestamp here so the
# admin Maintenance Tasks page can show "Last run X mins ago: 3 records
# updated" instead of forcing admins to copy-paste curl into the console.

async def _record_maintenance_run(task_id: str, result: dict, user_email: str = None):
    """Persists a tiny audit row for each migrator invocation."""
    await db.website_settings.update_one(
        {"_id": f"maintenance_run_{task_id}"},
        {"$set": {
            "_id": f"maintenance_run_{task_id}",
            "task_id": task_id,
            "last_run_at": datetime.now(timezone.utc).isoformat(),
            "last_run_by": user_email or "unknown",
            "last_result": result,
        }},
        upsert=True,
    )


@router.get("/maintenance/runs")
async def list_maintenance_runs(current_user: dict = Depends(get_current_user)):
    """Return every persisted last-run record for the migration tasks."""
    if current_user.get("role") not in ["super_admin", "admin"]:
        raise HTTPException(status_code=403, detail="Not authorized")
    runs = {}
    async for doc in db.website_settings.find({"_id": {"$regex": "^maintenance_run_"}}, {"_id": 0}):
        tid = doc.get("task_id")
        if tid:
            runs[tid] = doc
    return {"runs": runs}


@router.get("/maintenance/health")
async def maintenance_health_snapshot(current_user: dict = Depends(get_current_user)):
    """One-glance "is everything humming?" snapshot for the Maintenance
    Tasks page. Cheap counts only — runs in well under 100ms even on a
    busy DB."""
    if current_user.get("role") not in ["super_admin", "admin", "manager"]:
        raise HTTPException(status_code=403, detail="Not authorized")

    now = datetime.now(timezone.utc)
    today_start_iso = now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()

    # Total products in the storefront catalogue
    total_products = await db.tiles.count_documents({})

    # Paid orders today (paid_at OR created_at within today, status not cancelled)
    paid_today = await db.shop_orders.count_documents({
        "payment_status": {"$in": ["paid", "completed"]},
        "$or": [
            {"paid_at": {"$gte": today_start_iso}},
            {"created_at": {"$gte": today_start_iso}},
        ],
    })

    # Revenue today — sum of total field on those orders
    pipeline = [
        {"$match": {
            "payment_status": {"$in": ["paid", "completed"]},
            "$or": [
                {"paid_at": {"$gte": today_start_iso}},
                {"created_at": {"$gte": today_start_iso}},
            ],
        }},
        {"$group": {"_id": None, "total": {"$sum": "$total"}}},
    ]
    rev_today = 0.0
    async for r in db.shop_orders.aggregate(pipeline):
        rev_today = float(r.get("total") or 0)
        break

    # Draft / abandoned cart count — anything in abandoned_carts that
    # hasn't been recovered.
    draft_carts = await db.abandoned_carts.count_documents({
        "$or": [{"status": {"$ne": "recovered"}}, {"status": {"$exists": False}}]
    })

    # Most recent successful payment
    last_paid = await db.shop_orders.find_one(
        {"payment_status": {"$in": ["paid", "completed"]}},
        {"_id": 0, "order_number": 1, "total": 1, "paid_at": 1, "created_at": 1, "customer_email": 1},
        sort=[("paid_at", -1), ("created_at", -1)],
    )

    return {
        "total_products": total_products,
        "paid_orders_today": paid_today,
        "revenue_today": round(rev_today, 2),
        "draft_carts": draft_carts,
        "last_paid_order": {
            "order_number": (last_paid or {}).get("order_number"),
            "total": float((last_paid or {}).get("total") or 0),
            "at": (last_paid or {}).get("paid_at") or (last_paid or {}).get("created_at"),
            "customer_email": (last_paid or {}).get("customer_email"),
        } if last_paid else None,
        "generated_at": now.isoformat(),
    }


# ============ CRITICAL UI HEALTH CHECKS ============
# Registry of must-have storefront/admin elements. Each entry: a URL the
# admin can visit + the data-testid selectors that MUST be present after
# the page renders. Frontend Maintenance page runs these in hidden
# iframes and reports pass/fail. This is the safety net so launch-eve
# regressions like "Trade Login Box vanished" can never go unnoticed.

CRITICAL_UI_CHECKS = [
    {
        "id": "homepage_categories",
        "label": "Homepage — shop categories grid",
        # 24 May 2026 — was "/shop", which 301-redirects to /tiles where
        # `tile_collections_grid` is the relevant grid (already covered
        # by its own check below). The "Shop our categories" grid that
        # this check is really probing lives on the storefront ROOT.
        "url": "/",
        "expected_selectors": ["[data-testid='homepage-category-grid']"],
    },
    {
        "id": "homepage_header_logo",
        "label": "Homepage — header logo + cart link",
        "url": "/",
        "expected_selectors": [
            "[data-testid='header-logo']",
            "[data-testid='cart-link']",
        ],
    },
    {
        "id": "tile_collections_grid",
        "label": "Tile Collections — /tiles listing page",
        "url": "/tiles",
        "expected_selectors": ["[data-testid='tile-collections-page']"],
    },
    {
        "id": "tile_detail_trade_box",
        "label": "Tile Detail — Trade Customer login box",
        "url": "__DYNAMIC_FIRST_COLLECTION__",
        "expected_selectors": [
            "[data-testid='trade-customer-box']",
            "[data-testid='trade-login-link']",
            "[data-testid='trade-signup-link']",
        ],
        "skip_text_markers": [
            "doesn't exist or has no products",
            "Collection not found",
        ],
    },
    {
        "id": "tile_detail_volume_pricing",
        "label": "Tile Detail — Volume Pricing table",
        "url": "__DYNAMIC_FIRST_COLLECTION__",
        "expected_selectors": ["[data-testid='volume-pricing-table']"],
        "skip_text_markers": [
            "doesn't exist or has no products",
            "Collection not found",
        ],
        # 24 May 2026 — Volume Pricing Table is INTENTIONALLY hidden on
        # products that don't have tier pricing configured (see
        # VolumePricingTable.jsx line 23 — returns null when tierPricing
        # is empty). Missing testid on those products is a content
        # choice (admin hasn't set bulk discounts), NOT a regression.
        # Marking this as a SOFT check so the storefront-health dashboard
        # doesn't flag it red when the audit happens to land on a
        # product without bulk pricing.
        "severity": "warn",
    },
    {
        "id": "tile_detail_add_to_cart",
        "label": "Tile Detail — Add to Cart button",
        "url": "__DYNAMIC_FIRST_COLLECTION__",
        "expected_selectors": ["[data-testid='add-to-cart-btn']"],
        "skip_text_markers": [
            "doesn't exist or has no products",
            "Collection not found",
        ],
    },
    {
        "id": "shop_track_form",
        "label": "Track Order — submit button",
        "url": "/shop/track",
        "expected_selectors": ["[data-testid='track-submit-btn']"],
    },
    {
        "id": "trade_login_form",
        "label": "Trade Login — sign-in form",
        "url": "/shop/trade/login",
        "expected_selectors": [
            "[data-testid='trade-login-form']",
            "[data-testid='trade-login-submit']",
        ],
    },
    {
        "id": "trade_register_form",
        "label": "Trade Register — application form",
        "url": "/shop/trade/register",
        "expected_selectors": ["[data-testid='trade-register-page']"],
    },
    {
        "id": "customer_login_form",
        "label": "Customer Login — sign-in form",
        "url": "/shop/tile-login",
        "expected_selectors": ["[data-testid='login-submit-btn']"],
    },
    {
        "id": "customer_register_form",
        "label": "Customer Register — create account form",
        "url": "/shop/register",
        "expected_selectors": ["[data-testid='register-page']"],
    },
    {
        "id": "info_delivery",
        "label": "Info — Delivery page",
        "url": "/shop/info/delivery",
        "expected_selectors": ["[data-testid='info-page']"],
    },
    {
        "id": "info_returns",
        "label": "Info — Returns page",
        "url": "/shop/info/returns",
        "expected_selectors": ["[data-testid='info-page']"],
    },
    {
        "id": "info_privacy",
        "label": "Info — Privacy page",
        "url": "/shop/info/privacy",
        "expected_selectors": ["[data-testid='info-page']"],
    },
    {
        "id": "contact_page",
        "label": "Contact — phone/whatsapp/email cards",
        "url": "/shop/contact",
        "expected_selectors": [
            "[data-testid='contact-page']",
        ],
        "optional_selectors": [
            "[data-testid='enquiry-phone-card']",
            "[data-testid='enquiry-whatsapp-card']",
            "[data-testid='enquiry-email-card']",
        ],
    },
    {
        "id": "refer_page",
        "label": "Refer-a-Friend — public landing",
        "url": "/shop/refer",
        "expected_selectors": ["[data-testid='refer-form']"],
        "skip_text_markers": [
            "Referrals are currently paused",
            "Programme paused",
        ],
    },
    {
        "id": "sample_service",
        "label": "Sample Service — landing page",
        "url": "/shop/sample-service",
        "expected_selectors": ["[data-testid='sample-service-page']"],
    },
    {
        "id": "tile_calculator",
        "label": "Tile Calculator — landing page",
        "url": "/shop/calculator",
        "expected_selectors": ["[data-testid='tile-calculator-page']"],
    },
]


@router.get("/maintenance/ui-checks")
async def list_ui_checks(current_user: dict = Depends(get_current_user)):
    """Returns the registry of critical UI checks + last-run history.
    Each check is annotated with its current `disabled` state so the
    admin UI can render the toggle correctly."""
    if current_user.get("role") not in ["super_admin", "admin", "manager"]:
        raise HTTPException(status_code=403, detail="Not authorized")

    last_run = await db.website_settings.find_one(
        {"_id": "ui_health_last_run"}, {"_id": 0}
    )

    # Annotate each check with its disabled state from the overrides
    # collection. Defaults to enabled when no override row exists.
    from services.ui_health_runner import _get_disabled_overrides
    overrides = await _get_disabled_overrides()
    annotated = []
    for c in CRITICAL_UI_CHECKS:
        cid = c.get("id")
        annotated.append({
            **c,
            "disabled": cid in overrides,
            "disabled_reason": overrides.get(cid, {}).get("reason") if cid in overrides else None,
            "disabled_by": overrides.get(cid, {}).get("by") if cid in overrides else None,
            "disabled_at": overrides.get(cid, {}).get("at") if cid in overrides else None,
        })
    return {
        "checks": annotated,
        "last_run": last_run or None,
    }


class UICheckTogglePayload(BaseModel):
    disabled: bool
    reason: Optional[str] = None


@router.patch("/maintenance/ui-checks/{check_id}/toggle")
async def toggle_ui_check(
    check_id: str,
    payload: UICheckTogglePayload,
    current_user: dict = Depends(get_current_user),
):
    """Enable or disable a single UI health check by id. Disabled
    checks are skipped on the next probe run (status='disabled', not
    counted as failures). Persists across deploys via the
    `ui_health_check_overrides` collection."""
    if current_user.get("role") not in ["super_admin", "admin", "manager"]:
        raise HTTPException(status_code=403, detail="Not authorized")

    # Validate the check_id actually exists in the registry — prevents
    # the admin from typo-ing into a permanently-disabled phantom check
    if not any(c.get("id") == check_id for c in CRITICAL_UI_CHECKS):
        raise HTTPException(status_code=404, detail=f"Unknown check: {check_id}")

    from services.ui_health_runner import set_check_disabled
    res = await set_check_disabled(
        check_id,
        disabled=payload.disabled,
        reason=payload.reason,
        actor_email=current_user.get("email"),
    )
    return {
        "ok": True,
        "check_id": check_id,
        "disabled": res["disabled"],
        "reason": res.get("reason"),
    }


class UIHealthResultPayload(BaseModel):
    results: List[dict]  # [{id, label, url, status: 'pass'|'fail', missing: [...]}]
    ran_at: Optional[str] = None


@router.post("/maintenance/ui-checks/result")
async def record_ui_health_result(payload: UIHealthResultPayload, current_user: dict = Depends(get_current_user)):
    """Persist the result of a UI health run + send an email alert to
    super_admins if any check failed. Idempotent — overwrites the last
    run record so the admin always sees the most recent state."""
    if current_user.get("role") not in ["super_admin", "admin", "manager"]:
        raise HTTPException(status_code=403, detail="Not authorized")

    ran_at = payload.ran_at or datetime.now(timezone.utc).isoformat()
    failed = [r for r in (payload.results or []) if (r or {}).get("status") == "fail"]
    skipped = [r for r in (payload.results or []) if (r or {}).get("status") == "skipped"]
    disabled = [r for r in (payload.results or []) if (r or {}).get("status") == "disabled"]
    passed = [r for r in (payload.results or [])
              if (r or {}).get("status") not in ("fail", "skipped", "disabled")]

    record = {
        "_id": "ui_health_last_run",
        "ran_at": ran_at,
        "ran_by": current_user.get("email"),
        "results": payload.results or [],
        "failed_count": len(failed),
        "passed_count": len(passed),
        "skipped_count": len(skipped),
        "disabled_count": len(disabled),
    }
    await db.website_settings.update_one(
        {"_id": "ui_health_last_run"}, {"$set": record}, upsert=True
    )

    alerted = False
    if failed:
        # Best-effort email alert — collect every super_admin/admin email
        # and notify them. Never block the response on email failure.
        try:
            recipients = []
            async for u in db.users.find(
                {"role": {"$in": ["super_admin", "admin"]},
                 "email": {"$exists": True, "$nin": [None, ""]}},
                {"_id": 0, "email": 1},
            ):
                recipients.append(u.get("email"))
            recipients = list({r for r in recipients if r})

            if recipients:
                lines = [f"<li><strong>{f.get('label')}</strong>: missing on <code>{f.get('url')}</code></li>" for f in failed]
                html = (
                    "<h2 style='color:#dc2626'>⚠ Critical UI elements missing</h2>"
                    f"<p>Detected by the Maintenance Tasks UI health check at {ran_at}.</p>"
                    f"<ul>{''.join(lines)}</ul>"
                    "<p>Check <a href='/admin/maintenance'>/admin/maintenance</a> in your admin dashboard for details and re-run.</p>"
                )
                from services.email import send_simple_email_if_possible
                await send_simple_email_if_possible(
                    to=recipients,
                    subject=f"⚠ {len(failed)} critical UI element(s) missing on storefront",
                    html=html,
                )
                alerted = True
        except Exception:
            logging.exception("UI health alert email failed")

    return {"saved": True, "failed": len(failed), "alerted": alerted}


@router.get("/maintenance/ui-checks/last")
async def get_last_ui_check_run(current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["super_admin", "admin", "manager"]:
        raise HTTPException(status_code=403, detail="Not authorized")
    last_run = await db.website_settings.find_one({"_id": "ui_health_last_run"}, {"_id": 0})
    return last_run or {"ran_at": None, "results": []}


# ---------------------------------------------------------------------------
# Daily UI-health cron: server-side Playwright runner + emailed PDF report.
# ---------------------------------------------------------------------------
DEFAULT_UI_HEALTH_SCHEDULE = {
    "enabled": True,
    "hour_utc": 3,
    "recipients": [],          # empty = auto-pick all super_admin/admin emails
    "always_email": True,      # email even when all checks pass (so admins know it ran)
}


async def _load_ui_health_schedule() -> dict:
    """Returns the saved schedule + recipients (auto-fills with all
    super_admin/admin users when no explicit recipients are configured)."""
    doc = await db.website_settings.find_one(
        {"_id": "ui_health_schedule"}, {"_id": 0}
    )
    settings = {**DEFAULT_UI_HEALTH_SCHEDULE, **(doc or {})}

    if not settings.get("recipients"):
        emails = []
        async for u in db.users.find(
            {"role": {"$in": ["super_admin", "admin"]},
             "email": {"$exists": True, "$nin": [None, ""]}},
            {"_id": 0, "email": 1},
        ):
            emails.append(u.get("email"))
        settings["recipients"] = sorted({e for e in emails if e})
    return settings


async def run_ui_health_now_and_email(triggered_by: str = "manual") -> dict:
    """Core orchestration: runs checks via Playwright, persists the result,
    generates a PDF report, and emails it to the configured recipients.
    Used by both the daily cron and the admin "Run now" button."""
    from services.ui_health_runner import run_with_timeout
    from services.ui_health_report import render_ui_health_pdf
    from services.email import send_simple_email_if_possible

    schedule = await _load_ui_health_schedule()
    recipients = schedule.get("recipients") or []
    # Filter through the super-admin-managed authorisation table — only
    # send to admins explicitly opted-in for ui_health_alerts.
    try:
        from services.notification_prefs import get_authorized_recipients
        authorised = set(await get_authorized_recipients("ui_health_alerts"))
        recipients = [e for e in recipients if e in authorised]
    except Exception:
        # Fail-closed: if the auth table can't be read, send to nobody
        # rather than spam everyone.
        recipients = []

    run = await run_with_timeout(CRITICAL_UI_CHECKS, timeout_seconds=240)
    failed = run.get("failed_count", 0)
    passed = run.get("passed_count", 0)
    total = len(run.get("results") or [])
    ran_at = run.get("ran_at")

    # Persist exactly the same shape as the manual frontend POST so /last reads correctly.
    record = {
        "_id": "ui_health_last_run",
        "ran_at": ran_at,
        "ran_by": f"cron ({triggered_by})",
        "results": [
            {
                "id": r["id"],
                "label": r["label"],
                "url": r["url"],
                "status": r["status"],
                "missing": r.get("missing", []),
            }
            for r in run.get("results", [])
        ],
        "failed_count": failed,
        "passed_count": passed,
        "duration_ms": run.get("duration_ms", 0),
        "source": "cron",
    }
    await db.website_settings.update_one(
        {"_id": "ui_health_last_run"}, {"$set": record}, upsert=True
    )

    email_sent = False
    email_error = None
    should_email = schedule.get("always_email") or failed > 0
    if should_email and recipients:
        try:
            pdf_bytes = render_ui_health_pdf(run)
            today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            filename = f"ui-health-report-{today}.pdf"
            status_word = "ALL PASSING" if failed == 0 else f"{failed} FAILING"
            color = "#059669" if failed == 0 else "#DC2626"
            html = (
                f"<div style='font-family:-apple-system,BlinkMacSystemFont,sans-serif;'>"
                f"<h2 style='color:{color};margin:0 0 12px'>UI Health: {status_word}</h2>"
                f"<p style='color:#475569'>Daily check completed at "
                f"<b>{ran_at}</b> · <b>{passed}</b> pass / <b>{failed}</b> fail "
                f"of <b>{total}</b> total.</p>"
                f"<p style='color:#475569'>Probed: <code>{run.get('base_url')}</code> "
                f"in {run.get('duration_ms', 0)} ms.</p>"
                f"<p>Full breakdown attached as PDF. "
                f"Open <a href='/admin/maintenance'>/admin/maintenance</a> to re-run "
                f"or adjust the schedule.</p>"
                f"</div>"
            )
            send_result = await send_simple_email_if_possible(
                to=recipients,
                subject=f"UI Health — {status_word} ({today})",
                html=html,
                attachments=[{
                    "filename": filename,
                    "content": pdf_bytes,
                    "content_type": "application/pdf",
                }],
            )
            email_sent = bool(send_result.get("success"))
            email_error = send_result.get("error")
        except Exception as exc:
            logging.exception("UI health PDF email failed")
            email_error = str(exc)

    # Append a small audit row so the admin UI can show "last 5 runs"
    await db.ui_health_run_log.insert_one({
        "ran_at": ran_at,
        "triggered_by": triggered_by,
        "failed_count": failed,
        "passed_count": passed,
        "total": total,
        "duration_ms": run.get("duration_ms", 0),
        "email_sent": email_sent,
        "email_error": email_error,
        "recipient_count": len(recipients),
    })

    return {
        "ran_at": ran_at,
        "passed_count": passed,
        "failed_count": failed,
        "total": total,
        "duration_ms": run.get("duration_ms", 0),
        "email_sent": email_sent,
        "email_error": email_error,
        "recipient_count": len(recipients),
        "alerted": email_sent,
    }


@router.get("/maintenance/ui-checks/schedule")
async def get_ui_health_schedule(current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["super_admin", "admin", "manager"]:
        raise HTTPException(status_code=403, detail="Not authorized")
    settings = await _load_ui_health_schedule()

    # Last 5 audit log entries
    cursor = db.ui_health_run_log.find({}, {"_id": 0}).sort("ran_at", -1).limit(5)
    log = [doc async for doc in cursor]

    return {"settings": settings, "log": log}


class UIHealthScheduleUpdate(BaseModel):
    enabled: Optional[bool] = None
    hour_utc: Optional[int] = None
    recipients: Optional[List[str]] = None
    always_email: Optional[bool] = None


@router.put("/maintenance/ui-checks/schedule")
async def update_ui_health_schedule(
    payload: UIHealthScheduleUpdate,
    current_user: dict = Depends(get_current_user),
):
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super admin only")

    update = {k: v for k, v in payload.dict().items() if v is not None}
    if "hour_utc" in update:
        h = int(update["hour_utc"])
        if h < 0 or h > 23:
            raise HTTPException(status_code=400, detail="hour_utc must be 0-23")
        update["hour_utc"] = h
    if "recipients" in update:
        # Trim, dedupe, drop empties
        cleaned = [r.strip() for r in update["recipients"] if (r or "").strip()]
        update["recipients"] = sorted(set(cleaned))

    update["updated_at"] = datetime.now(timezone.utc).isoformat()
    update["updated_by"] = current_user.get("email")

    await db.website_settings.update_one(
        {"_id": "ui_health_schedule"}, {"$set": update}, upsert=True
    )

    # Re-register the cron at the new hour if scheduler is alive
    try:
        from services.scheduler import reschedule_ui_health_job
        await reschedule_ui_health_job()
    except Exception:
        logging.exception("Could not reschedule UI health job")

    return await _load_ui_health_schedule()


@router.post("/maintenance/ui-checks/run-now")
async def trigger_ui_health_now(
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(get_current_user),
):
    """Admin "Run now" button — fires the same flow as the daily cron
    immediately, including PDF email to recipients. Runs in a background
    task so we return < 100 ms (the actual probe takes ~60 s and would
    blow the ingress proxy timeout if synchronous)."""
    if current_user.get("role") not in ["super_admin", "admin"]:
        raise HTTPException(status_code=403, detail="Not authorized")

    triggered_by = f"manual ({current_user.get('email')})"
    background_tasks.add_task(run_ui_health_now_and_email, triggered_by)
    return {
        "started": True,
        "message": "UI health probe queued — PDF will be emailed when complete (~60 s).",
    }


# ---------------------------------------------------------------------------
# Announcement Ribbon — slow-scrolling marquee above the storefront header.
# Single-document settings stored at website_settings.announcement_ribbon.
# ---------------------------------------------------------------------------
DEFAULT_RIBBON = {
    "enabled": False,
    "message": "Free delivery on orders over £499 · 28-day returns · Trade pricing live now",
    "link_url": "",
    "link_label": "",
    "speed": "medium",
    "background_color": "#1C1917",
    "text_color": "#F7EA1C",
    "link_color": "#FFFFFF",
    "icon": True,
    "version": 1,
    # Scheduling — when schedule_enabled is True, the ribbon auto-shows
    # between scheduled_start and scheduled_end (UTC ISO strings) and
    # auto-hides outside that window. The manual `enabled` flag still
    # works independently — visible if EITHER manual is on OR schedule is
    # active right now. So you can pre-arm a Friday-night sale on Monday
    # without flipping a single switch on the day.
    "schedule_enabled": False,
    "scheduled_start": None,
    "scheduled_end": None,
    # Rolling log of the last 10 Quick Posts (newest first). Used by the admin
    # history panel for one-click re-publish.
    "history": [],
}


def _strip_id(doc: Optional[dict]) -> dict:
    if not doc:
        return {}
    return {k: v for k, v in doc.items() if k != "_id"}


def _ribbon_is_active_now(cfg: dict) -> tuple[bool, str]:
    """Returns (should_show, reason). Used by public GET so the storefront
    sees an instantly-correct answer on every page load — no cron needed."""
    manual_on = bool(cfg.get("enabled"))
    sched_on = bool(cfg.get("schedule_enabled"))
    start_iso = cfg.get("scheduled_start")
    end_iso = cfg.get("scheduled_end")

    in_window = False
    if sched_on and start_iso and end_iso:
        try:
            start = datetime.fromisoformat(str(start_iso).replace("Z", "+00:00"))
            end = datetime.fromisoformat(str(end_iso).replace("Z", "+00:00"))
            now = datetime.now(timezone.utc)
            in_window = start <= now <= end
        except Exception:
            in_window = False

    if manual_on:
        return True, "manual"
    if in_window:
        return True, "scheduled"
    return False, "off"


@router.get("/announcement-ribbon")
async def get_announcement_ribbon_admin(current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["super_admin", "admin", "manager"]:
        raise HTTPException(status_code=403, detail="Not authorized")
    doc = await db.website_settings.find_one({"_id": "announcement_ribbon"})
    cfg = {**DEFAULT_RIBBON, **_strip_id(doc)}
    show, reason = _ribbon_is_active_now(cfg)
    cfg["_now_visible"] = show
    cfg["_now_reason"] = reason
    return cfg


@router.get("/public/announcement-ribbon")
@bulletproof_endpoint(
    cache_namespace="public_announcement_ribbon",
    empty_check=lambda r: False,  # disabled ribbon is a valid state
    empty_fallback={"enabled": False},
    short_ttl=15,  # short — schedule windows should flip in seconds
)
async def get_announcement_ribbon_public():
    """Customer-facing fetch — returns the active ribbon config, or
    {enabled: False} when (manual=off AND schedule not currently active).
    Schedule is computed at request time so toggles take effect instantly."""
    doc = await db.website_settings.find_one({"_id": "announcement_ribbon"})
    merged = {**DEFAULT_RIBBON, **_strip_id(doc)}
    show, _ = _ribbon_is_active_now(merged)
    if not show or not (merged.get("message") or "").strip():
        return {"enabled": False}
    return {
        "enabled": True,
        "message": merged.get("message"),
        "link_url": merged.get("link_url") or "",
        "link_label": merged.get("link_label") or "",
        "speed": merged.get("speed") or "medium",
        "background_color": merged.get("background_color") or "#1C1917",
        "text_color": merged.get("text_color") or "#F7EA1C",
        "link_color": merged.get("link_color") or "#FFFFFF",
        "icon": bool(merged.get("icon", True)),
        "version": int(merged.get("version") or 1),
    }


class AnnouncementRibbonUpdate(BaseModel):
    enabled: Optional[bool] = None
    message: Optional[str] = None
    link_url: Optional[str] = None
    link_label: Optional[str] = None
    speed: Optional[str] = None
    background_color: Optional[str] = None
    text_color: Optional[str] = None
    link_color: Optional[str] = None
    icon: Optional[bool] = None
    version: Optional[int] = None
    schedule_enabled: Optional[bool] = None
    scheduled_start: Optional[str] = None
    scheduled_end: Optional[str] = None
    # When True, this save is treated as a "Quick Post" and appended to the
    # rolling history log (last 10). Not persisted on the doc itself.
    record_history: Optional[bool] = None


@router.put("/announcement-ribbon")
async def update_announcement_ribbon(
    payload: AnnouncementRibbonUpdate,
    current_user: dict = Depends(get_current_user),
):
    if current_user.get("role") not in ["super_admin", "admin"]:
        raise HTTPException(status_code=403, detail="Not authorized")

    raw = {k: v for k, v in payload.dict().items() if v is not None}
    record_history = bool(raw.pop("record_history", False))
    update = raw
    if "speed" in update and update["speed"] not in ("slow", "medium", "fast"):
        raise HTTPException(status_code=400, detail="speed must be slow|medium|fast")

    update["updated_at"] = datetime.now(timezone.utc).isoformat()
    update["updated_by"] = current_user.get("email")

    mongo_ops: dict = {"$set": update}

    # Append a Quick-Post entry to the rolling history (capped at 10, newest first).
    if record_history and (update.get("message") or "").strip():
        history_entry = {
            "id": uuid.uuid4().hex,
            "message": update["message"],
            "link_url": update.get("link_url") or "",
            "link_label": update.get("link_label") or "",
            "background_color": update.get("background_color") or "#1C1917",
            "text_color": update.get("text_color") or "#F7EA1C",
            "link_color": update.get("link_color") or "#FFFFFF",
            "speed": update.get("speed") or "medium",
            "icon": bool(update.get("icon", True)),
            "published_at": update["updated_at"],
            "published_by": current_user.get("email"),
        }
        mongo_ops["$push"] = {
            "history": {
                "$each": [history_entry],
                "$position": 0,     # newest first
                "$slice": 10,       # cap at 10
            }
        }

    await db.website_settings.update_one(
        {"_id": "announcement_ribbon"}, mongo_ops, upsert=True
    )
    doc = await db.website_settings.find_one({"_id": "announcement_ribbon"})
    cfg = {**DEFAULT_RIBBON, **_strip_id(doc)}
    show, reason = _ribbon_is_active_now(cfg)
    cfg["_now_visible"] = show
    cfg["_now_reason"] = reason
    return cfg



# ---------------------------------------------------------------------------
# Launch checklists / Roadmap downloads — let admins grab the pre-built PDFs
# straight from the live site without needing pod / repo access.
# ---------------------------------------------------------------------------
import pathlib

CHECKLIST_DIR = pathlib.Path("/app/checklists")

# id → (filename, friendly download name)
_CHECKLIST_FILES = {
    "post-launch-roadmap": (
        "Post_Launch_Monitoring_Roadmap.pdf",
        "TileStation_Post-Launch_Monitoring_Roadmap.pdf",
    ),
    "staff-training": (
        "Staff_Training_Booklet.pdf",
        "TileStation_Staff_Training_Booklet.pdf",
    ),
    "website-features": (
        "Website_Features_Checklist.pdf",
        "TileStation_Website_Features_Checklist.pdf",
    ),
    "epos-features": (
        "EPOS_Features_Checklist.pdf",
        "TileStation_EPOS_Features_Checklist.pdf",
    ),
}


@router.get("/maintenance/checklists")
async def list_checklists(current_user: dict = Depends(get_current_user)):
    """Lists which checklist PDFs are available for download.

    Each row has the kind id (used in the download URL), display title,
    file size in bytes, and last-modified ISO timestamp. The frontend
    uses this to render a small "Downloads" panel — disables rows whose
    file is missing on disk so the UI never offers a broken link.
    """
    if current_user.get("role") not in ("super_admin", "admin", "manager"):
        raise HTTPException(status_code=403, detail="Not authorized")

    titles = {
        "post-launch-roadmap": "Post-Launch Monitoring Roadmap",
        "staff-training": "Staff Training Booklet",
        "website-features": "Website Features Checklist",
        "epos-features": "EPOS Features Checklist",
    }
    descriptions = {
        "post-launch-roadmap": "9-tier observability + security strategy with backbone health checks for Bulk Category Editor & Supplier Products.",
        "staff-training": "Day-one operational guide for counter staff: refunds, invoice linking, EPOS sales, deliveries, customer-website tour. Image-rich.",
        "website-features": "Every storefront feature with the admin path that controls it.",
        "epos-features": "Every till / EPOS feature with the admin path that controls it.",
    }
    out = []
    for kid, (fname, _dl_name) in _CHECKLIST_FILES.items():
        path = CHECKLIST_DIR / fname
        exists = path.exists()
        out.append({
            "id": kid,
            "title": titles[kid],
            "description": descriptions[kid],
            "filename": fname,
            "available": exists,
            "size_bytes": path.stat().st_size if exists else 0,
            "updated_at": (
                datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()
                if exists else None
            ),
        })
    return {"checklists": out}


@router.get("/maintenance/checklists/{kind}.pdf")
async def download_checklist(kind: str, current_user: dict = Depends(get_current_user)):
    """Streams a checklist PDF inline. Auth-gated to admins/managers only."""
    from fastapi.responses import FileResponse

    if current_user.get("role") not in ("super_admin", "admin", "manager"):
        raise HTTPException(status_code=403, detail="Not authorized")

    entry = _CHECKLIST_FILES.get(kind)
    if not entry:
        raise HTTPException(status_code=404, detail=f"Unknown checklist: {kind}")

    fname, dl_name = entry
    path = CHECKLIST_DIR / fname
    if not path.exists():
        raise HTTPException(
            status_code=404,
            detail="Checklist not generated yet — click 'Regenerate' to build it.",
        )

    return FileResponse(
        path=str(path),
        media_type="application/pdf",
        filename=dl_name,
    )


@router.post("/maintenance/checklists/regenerate-roadmap")
async def regenerate_roadmap(current_user: dict = Depends(get_current_user)):
    """Re-runs the roadmap PDF generator. Useful after adding new checks
    to the script — admins shouldn't need shell access."""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super admin only")

    import subprocess
    import sys
    try:
        result = subprocess.run(
            [sys.executable, "/app/checklists/build_post_launch_roadmap.py"],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            raise HTTPException(status_code=500, detail=f"Build failed: {result.stderr[:200]}")
        path = CHECKLIST_DIR / "Post_Launch_Monitoring_Roadmap.pdf"
        return {
            "success": True,
            "size_bytes": path.stat().st_size if path.exists() else 0,
            "stdout": result.stdout.strip()[:200],
        }
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="Build timed out (>30 s)")



@router.post("/sitemap/migrate-hyphenated-urls")
async def migrate_hyphenated_urls(current_user: dict = Depends(get_current_user)):
    """One-shot migrator that fixes admin-saved URL fields broken by the
    pre-Apr-27 hyphen bug.

    Background: prior to today's fix, the Site Map admin tool generated
    `/shop/collection/Some-Hyphenated-Name` for collections whose actual
    storefront route is `/shop/collection/Some%20Hyphenated%20Name`.
    Admins who copied those URLs into category `custom_url` fields, nav
    menus, footer links, or banner CTAs ended up with broken links.

    This endpoint scans every URL-bearing admin field and rewrites any
    `/shop/collection/Some-Name-With-Hyphens` path to `%20`-encoded form
    IF AND ONLY IF the resulting collection actually exists in the DB.
    Untranslatable URLs (typos, dead routes) are flagged as
    `needs_review` so the admin can fix them manually.

    Safe to run multiple times — it's idempotent.
    """
    if current_user.get("role") not in ["super_admin", "admin"]:
        raise HTTPException(status_code=403, detail="Not authorized")

    # Note: this module already exposes the global `db` client at the top
    # of the file — no helper indirection needed.

    # Validate "is this a real collection?" using the SAME pattern the
    # storefront route uses (`backend/routes/shop.py` line ~4853): a tile
    # exists whose display_name (or name) starts with the candidate
    # series text, case-insensitive. We cache lookups so a 600+ category
    # migration doesn't hammer the DB.
    import re as _re
    _collection_cache: dict = {}

    async def collection_exists(candidate: str) -> bool:
        if not candidate or not candidate.strip():
            return False
        key = candidate.strip().lower()
        if key in _collection_cache:
            return _collection_cache[key]
        regex = _re.compile(f"^{_re.escape(candidate.strip())}", _re.IGNORECASE)
        doc = await db.tiles.find_one(
            {"$or": [{"display_name": {"$regex": regex}}, {"name": {"$regex": regex}}]},
            {"_id": 1},
        )
        _collection_cache[key] = doc is not None
        return doc is not None

    pattern = _re.compile(r"^/shop/collection/([^?#]+)(.*)$")

    async def attempt_rewrite(url: str):
        """Returns (new_url, status)."""
        if not url or not isinstance(url, str):
            return url, "skipped"
        m = pattern.match(url)
        if not m:
            return url, "skipped"
        slug, suffix = m.group(1), m.group(2) or ""
        # Already URL-encoded? Treat as already-correct.
        if "%20" in slug or "%" in slug:
            return url, "already_valid"
        # Slug is a real collection literally — leave alone.
        if await collection_exists(slug):
            return url, "already_valid"
        # Try the hyphen→space swap.
        candidate = slug.replace("-", " ").strip()
        if candidate != slug and await collection_exists(candidate):
            return f"/shop/collection/{quote(candidate, safe='')}{suffix}", "rewritten"
        return url, "needs_review"

    summary = {
        "rewritten": [],         # list of {where, old, new}
        "needs_review": [],      # list of {where, url}
        "scanned": 0,
    }

    # 1) website_categories.custom_url ---------------------------------
    async for cat in db.website_categories.find(
        {"custom_url": {"$exists": True, "$nin": [None, ""]}},
        {"_id": 1, "name": 1, "custom_url": 1},
    ):
        summary["scanned"] += 1
        old = cat.get("custom_url") or ""
        new, status = await attempt_rewrite(old)
        if status == "rewritten":
            await db.website_categories.update_one(
                {"_id": cat["_id"]},
                {"$set": {"custom_url": new, "updated_at": datetime.now(timezone.utc).isoformat()}},
            )
            summary["rewritten"].append({"where": f"Category: {cat.get('name')}", "old": old, "new": new})
        elif status == "needs_review":
            summary["needs_review"].append({"where": f"Category: {cat.get('name')}", "url": old})

    # 2) navigation_menus[*].items[*].link_url + .children[*].link_url -
    async for menu in db.navigation_menus.find({}, {"_id": 1, "menu_type": 1, "items": 1}):
        items = menu.get("items") or []
        changed = False
        for it in items:
            for field in (it,):
                old = field.get("link_url") or ""
                if old:
                    summary["scanned"] += 1
                    new, status = await attempt_rewrite(old)
                    if status == "rewritten":
                        field["link_url"] = new
                        changed = True
                        summary["rewritten"].append({"where": f"Nav {menu.get('menu_type')}: {it.get('label')}", "old": old, "new": new})
                    elif status == "needs_review":
                        summary["needs_review"].append({"where": f"Nav {menu.get('menu_type')}: {it.get('label')}", "url": old})
            for ch in it.get("children") or []:
                old = ch.get("link_url") or ""
                if old:
                    summary["scanned"] += 1
                    new, status = await attempt_rewrite(old)
                    if status == "rewritten":
                        ch["link_url"] = new
                        changed = True
                        summary["rewritten"].append({"where": f"Nav {menu.get('menu_type')}: {it.get('label')} → {ch.get('label')}", "old": old, "new": new})
                    elif status == "needs_review":
                        summary["needs_review"].append({"where": f"Nav {menu.get('menu_type')}: {it.get('label')} → {ch.get('label')}", "url": old})
        if changed:
            await db.navigation_menus.update_one({"_id": menu["_id"]}, {"$set": {"items": items}})

    # 3) footer_settings (quickLinks, customerService, legalLinks) ----
    footer_doc = await db.website_settings.find_one({"_id": "footer_settings"})
    if footer_doc:
        fs = footer_doc.get("settings") or {}
        changed = False
        for section_key in ["quickLinks", "customerService", "legalLinks"]:
            for link in fs.get(section_key) or []:
                old = link.get("url") or ""
                if old:
                    summary["scanned"] += 1
                    new, status = await attempt_rewrite(old)
                    if status == "rewritten":
                        link["url"] = new
                        changed = True
                        summary["rewritten"].append({"where": f"Footer {section_key}: {link.get('label')}", "old": old, "new": new})
                    elif status == "needs_review":
                        summary["needs_review"].append({"where": f"Footer {section_key}: {link.get('label')}", "url": old})
        if changed:
            await db.website_settings.update_one({"_id": "footer_settings"}, {"$set": {"settings": fs}})

    # 4) benefits_bar.link --------------------------------------------
    async for b in db.benefits_bar.find({"link": {"$exists": True, "$ne": ""}}, {"_id": 1, "text": 1, "link": 1}):
        old = b.get("link") or ""
        summary["scanned"] += 1
        new, status = await attempt_rewrite(old)
        if status == "rewritten":
            await db.benefits_bar.update_one({"_id": b["_id"]}, {"$set": {"link": new}})
            summary["rewritten"].append({"where": f"Benefits Bar: {b.get('text')}", "old": old, "new": new})
        elif status == "needs_review":
            summary["needs_review"].append({"where": f"Benefits Bar: {b.get('text')}", "url": old})

    result = {
        "scanned": summary["scanned"],
        "rewritten_count": len(summary["rewritten"]),
        "needs_review_count": len(summary["needs_review"]),
        "rewritten": summary["rewritten"][:50],
        "needs_review": summary["needs_review"][:50],
    }
    await _record_maintenance_run("hyphen_url_fix", result, current_user.get("email"))
    return result


@router.get("/sitemap")
async def get_sitemap():
    """
    Aggregates ALL pages/URLs across the site and shows where each is linked.
    Returns: shop pages, collection pages, product pages, info pages, with link references.
    """
    import re
    from collections import defaultdict

    try:
        # 1. Gather navigation links for cross-referencing (with IDs for unlinking)
        nav_links = {}
        for menu_type in ["main", "top_bar", "shop"]:
            menu = await db.navigation_menus.find_one({"menu_type": menu_type}, {"_id": 0})
            if menu:
                for item in menu.get("items", []):
                    url = item.get("link_url", "")
                    if url:
                        nav_links.setdefault(url, []).append({
                            "label": f"Nav: {menu_type} → {item.get('label', '?')}",
                            "type": "nav",
                            "menu_type": menu_type,
                            "item_id": item.get("id", ""),
                            "removable": True
                        })
                    for child in item.get("children", []):
                        curl = child.get("link_url", "")
                        if curl:
                            nav_links.setdefault(curl, []).append({
                                "label": f"Nav: {menu_type} → {item.get('label','')} → {child.get('label','?')}",
                                "type": "nav",
                                "menu_type": menu_type,
                                "item_id": child.get("id", ""),
                                "removable": True
                            })

        # 2. Gather homepage category links
        homepage_cats_raw = await db.website_categories.find(
            {"show_on_homepage": True}, {"name": 1, "slug": 1}
        ).to_list(100)
        homepage_cats = []
        for c in homepage_cats_raw:
            homepage_cats.append({"name": c.get("name"), "slug": c.get("slug"), "id": str(c["_id"])})

        # 3. Gather footer links (with section info for unlinking)
        footer_links = {}
        footer_doc = await db.website_settings.find_one({"_id": "footer_settings"})
        if footer_doc:
            fs = footer_doc.get("settings", {})
            for section_key in ["quickLinks", "customerService", "legalLinks"]:
                for idx, link in enumerate(fs.get(section_key, [])):
                    url = link.get("url", "")
                    if url:
                        footer_links.setdefault(url, []).append({
                            "label": f"Footer: {section_key} → {link.get('label', '?')}",
                            "type": "footer",
                            "section": section_key,
                            "link_url": url,
                            "link_label": link.get("label", ""),
                            "removable": True
                        })

        # 4. Gather component links (header icons, benefits bar, USP sections, CTAs)
        # These are links hardcoded in frontend components that the sitemap should recognise
        component_links = {}

        # Header icon links
        header_icon_map = {
            "/shop/stores": "Header: Stores icon",
            "/shop/tile-account": "Header: Account icon",
            "/shop/tile-login": "Header: Sign In icon",
            "/shop/trade/login": "Header: Trade login icon",
            "/shop/tile-samples": "Header: Samples icon",
            "/shop/tile-wishlist": "Header: Wishlist icon",
            "/shop/tile-cart": "Header: Basket icon",
        }
        for url, label in header_icon_map.items():
            component_links.setdefault(url, []).append({
                "label": label, "type": "header", "removable": False
            })

        # Homepage section links (hardcoded CTAs in TileStationHome)
        homepage_section_map = {
            "/shop/calculator": "Homepage: Tile Calculator section",
            "/shop/trade/register": "Homepage: Trade registration CTA",
            "/shop/sample-service": "Homepage: USP 'Free Samples' section",
            "/shop/contact": "Homepage: Footer contact section",
            "/shop/checkout": "Cart: Checkout flow",
        }
        for url, label in homepage_section_map.items():
            component_links.setdefault(url, []).append({
                "label": label, "type": "component", "removable": False
            })

        # Benefits bar links (dynamic from DB)
        benefits = await db.benefits_bar.find(
            {"is_active": True}, {"_id": 0, "text": 1, "link": 1}
        ).to_list(20)
        for b in benefits:
            blink = b.get("link", "")
            if blink:
                component_links.setdefault(blink, []).append({
                    "label": f"Benefits Bar: {b.get('text', '?')}",
                    "type": "benefits_bar",
                    "removable": False
                })

        # URL aliases — some pages are accessible via multiple routes
        url_aliases = {
            "/shop/cart": ["/shop/tile-cart"],
            "/shop/tile-cart": ["/shop/cart"],
            "/shop/trade": ["/shop/trade/login", "/shop/trade/register"],
            "/shop/trade/login": ["/shop/trade", "/shop/trade/register"],
            "/shop/trade/register": ["/shop/trade", "/shop/trade/login"],
            "/shop/sample-service": ["/shop/tile-samples", "/samples"],
            "/shop/tile-samples": ["/shop/sample-service", "/samples"],
            "/samples": ["/shop/sample-service", "/shop/tile-samples"],
            "/shop/stores": ["/stores"],
            "/delivery": ["/shop/delivery"],
            "/shop/delivery": ["/delivery"],
            "/shop/contact": ["/contact"],
        }

        def get_linked_from(url):
            refs = []
            # Check all URL variants (original + aliases)
            urls_to_check = [url] + url_aliases.get(url, [])
            for u in urls_to_check:
                refs.extend(nav_links.get(u, []))
                refs.extend(footer_links.get(u, []))
                refs.extend(component_links.get(u, []))
                # Check homepage categories
                for cat in homepage_cats:
                    cat_url = f"/tiles?category={cat['slug']}"
                    if u == cat_url:
                        refs.append({
                            "label": f"Homepage: {cat['name']}",
                            "type": "homepage",
                            "category_id": cat["id"],
                            "category_slug": cat["slug"],
                            "removable": True
                        })
            # Deduplicate by label
            seen = set()
            unique = []
            for r in refs:
                key = r["label"]
                if key not in seen:
                    seen.add(key)
                    unique.append(r)
            return unique

        pages = []

        # --- STATIC SHOP PAGES ---
        static_pages = [
            {"name": "Homepage", "url": "/tiles", "type": "shop"},
            {"name": "All Collections", "url": "/tiles", "type": "shop"},
            {"name": "Tile Calculator", "url": "/shop/calculator", "type": "shop"},
            {"name": "Trade Signup", "url": "/shop/trade", "type": "shop"},
            {"name": "Sample Service", "url": "/shop/sample-service", "type": "shop"},
            {"name": "Cart", "url": "/shop/cart", "type": "shop"},
            {"name": "Checkout", "url": "/shop/checkout", "type": "shop"},
            {"name": "Contact Us", "url": "/shop/contact", "type": "shop"},
        ]
        for sp in static_pages:
            sp["linked_from"] = get_linked_from(sp["url"])
            pages.append(sp)

        # --- COLLECTION PAGES ---
        COLOR_WORDS = {
            'white','black','grey','gray','beige','cream','ivory','brown','blue',
            'green','red','yellow','orange','pink','purple','gold','silver',
            'charcoal','anthracite','taupe','sand','bone','pearl','light','dark',
            'natural','almond','crema','bianco','grigio','nero','avorio',
            'decor', 'feature', 'border', 'mosaic', 'listello'
        }

        def extract_series_name(product_name):
            if not product_name:
                return "Other"
            parts = product_name.strip().split()
            series_parts = []
            for part in parts:
                if re.match(r'^\d+[xX]\d+', part):
                    break
                series_parts.append(part)
            if not series_parts:
                return product_name
            while series_parts and series_parts[-1].lower() in COLOR_WORDS:
                series_parts.pop()
            if not series_parts:
                return ' '.join(product_name.strip().split()[:2])
            return ' '.join(series_parts)

        products_raw = await db.tiles.find(
            {}, {"display_name": 1, "name": 1, "slug": 1, "supplier_name": 1}
        ).to_list(10000)

        series_groups = defaultdict(lambda: {"count": 0, "products": []})
        for p in products_raw:
            name = p.get("display_name") or p.get("name") or ""
            series = extract_series_name(name)
            if series and series != "Other":
                series_groups[series]["count"] += 1
                if len(series_groups[series]["products"]) < 5:
                    slug = p.get("slug", "")
                    if slug:
                        series_groups[series]["products"].append({
                            "name": name,
                            "slug": slug
                        })

        for series_name, group in series_groups.items():
            # Match the storefront route exactly — every Link in the shop
            # uses `encodeURIComponent(series_name)` which leaves the space
            # as %20, e.g. `/shop/collection/Ardesia%20Slate`. We were
            # producing `/shop/collection/Ardesia-Slate` here which 404'd
            # the preview AND every "Open" link admins copied out of the
            # Site Map. Use urllib.parse.quote with the same default safe
            # set ("/") so brand names with `&` (e.g. "Wood & Stone") stay
            # consistent with the rest of the app.
            url = f"/shop/collection/{quote(series_name, safe='')}"
            pages.append({
                "name": series_name,
                "url": url,
                "type": "collection",
                "product_count": group["count"],
                "linked_from": get_linked_from(url)
            })

        # --- INDIVIDUAL PRODUCT PAGES (just count + sample) ---
        product_count = await db.tiles.count_documents({})
        sample_products = await db.tiles.find(
            {"slug": {"$exists": True, "$ne": ""}},
            {"display_name": 1, "name": 1, "slug": 1, "_id": 0}
        ).sort("name", 1).limit(50).to_list(50)

        for p in sample_products:
            name = p.get("display_name") or p.get("name") or "?"
            slug = p.get("slug", "")
            url = f"/tiles/{slug}"
            pages.append({
                "name": name,
                "url": url,
                "type": "product",
                "linked_from": get_linked_from(url)
            })

        # --- INFO / CMS PAGES ---
        info_pages_raw = await db.info_pages.find({}, {"_id": 0, "slug": 1, "title": 1}).to_list(100)
        for ip in info_pages_raw:
            slug = ip.get("slug", "")
            url = f"/shop/info/{slug}"
            pages.append({
                "name": ip.get("title", slug.replace("-", " ").title()),
                "url": url,
                "type": "info",
                "linked_from": get_linked_from(url)
            })

        # Also add known info page slugs that may not be in DB yet
        known_info = ["delivery", "returns", "faq", "contact", "track-order", "privacy-policy", "terms-and-conditions"]
        existing_slugs = {ip.get("slug") for ip in info_pages_raw}
        for slug in known_info:
            if slug not in existing_slugs:
                url = f"/shop/info/{slug}"
                pages.append({
                    "name": slug.replace("-", " ").title(),
                    "url": url,
                    "type": "info",
                    "linked_from": get_linked_from(url)
                })

        # --- CATEGORY PAGES ---
        categories = await db.website_categories.find(
            {"is_active": True}, {"name": 1, "slug": 1, "show_on_homepage": 1}
        ).to_list(200)
        for cat in categories:
            url = f"/tiles?category={cat['slug']}"
            refs = get_linked_from(url)
            if cat.get("show_on_homepage"):
                # Already captured in get_linked_from, check if not duplicate
                has_homepage = any(r.get("type") == "homepage" for r in refs)
                if not has_homepage:
                    refs.append({
                        "label": "Homepage: Shop Categories",
                        "type": "homepage",
                        "category_id": str(cat["_id"]),
                        "category_slug": cat["slug"],
                        "removable": True
                    })
            pages.append({
                "name": cat["name"],
                "url": url,
                "type": "category",
                "linked_from": refs
            })

        return {
            "pages": pages,
            "total_products": product_count,
            "total_collections": len(series_groups),
            "summary": {
                "shop": len([p for p in pages if p["type"] == "shop"]),
                "collection": len([p for p in pages if p["type"] == "collection"]),
                "product": len([p for p in pages if p["type"] == "product"]),
                "info": len([p for p in pages if p["type"] == "info"]),
                "category": len([p for p in pages if p["type"] == "category"]),
            }
        }
    except Exception as e:
        logger.error(f"Error building sitemap: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/sitemap/unlink")
async def unlink_page(data: dict):
    """Remove a page's link from a specific location (nav, footer, or homepage)."""
    link_type = data.get("type")
    
    if link_type == "nav":
        menu_type = data.get("menu_type")
        item_id = data.get("item_id")
        if not menu_type or not item_id:
            raise HTTPException(status_code=400, detail="menu_type and item_id required")
        
        menu = await db.navigation_menus.find_one({"menu_type": menu_type})
        if menu:
            items = menu.get("items", [])
            new_items = [i for i in items if i.get("id") != item_id]
            # Also check children
            for item in new_items:
                if "children" in item:
                    item["children"] = [c for c in item["children"] if c.get("id") != item_id]
            
            await db.navigation_menus.update_one(
                {"menu_type": menu_type},
                {"$set": {"items": new_items}}
            )
            return {"message": "Removed from navigation"}
        raise HTTPException(status_code=404, detail="Navigation menu not found")

    elif link_type == "footer":
        section = data.get("section")
        link_url = data.get("link_url")
        if not section or not link_url:
            raise HTTPException(status_code=400, detail="section and link_url required")
        
        footer_doc = await db.website_settings.find_one({"_id": "footer_settings"})
        if footer_doc:
            settings = footer_doc.get("settings", {})
            section_links = settings.get(section, [])
            settings[section] = [l for l in section_links if l.get("url") != link_url]
            await db.website_settings.update_one(
                {"_id": "footer_settings"},
                {"$set": {"settings": settings}}
            )
            return {"message": "Removed from footer"}
        raise HTTPException(status_code=404, detail="Footer settings not found")

    elif link_type == "homepage":
        category_id = data.get("category_id")
        if not category_id:
            raise HTTPException(status_code=400, detail="category_id required")
        
        result = await db.website_categories.update_one(
            {"_id": ObjectId(category_id)},
            {"$set": {"show_on_homepage": False}}
        )
        if result.matched_count:
            return {"message": "Removed from homepage"}
        raise HTTPException(status_code=404, detail="Category not found")
    
    raise HTTPException(status_code=400, detail="Invalid link type")

@router.get("/collection-detail-settings")
async def get_collection_detail_settings():
    """Get Collection Detail Page customization settings"""
    try:
        settings = await db.website_settings.find_one({"_id": "collection_detail_settings"})
        if settings:
            # Remove MongoDB _id before returning
            settings.pop("_id", None)
            return {"settings": settings.get("settings", {})}
        return {"settings": {}}
    except Exception as e:
        logger.error(f"Error fetching collection detail settings: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/suppliers-list")
async def get_suppliers_list():
    """Get distinct list of all supplier names for admin use"""
    try:
        suppliers = await db.tiles.distinct("supplier_name")
        supplier_list = sorted([s for s in suppliers if s])
        return {"suppliers": supplier_list}
    except Exception as e:
        logger.error(f"Error fetching suppliers list: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/collection-detail-settings")
async def save_collection_detail_settings(data: dict):
    """Save Collection Detail Page customization settings"""
    try:
        settings = data.get("settings", {})
        
        update_data = {
            "_id": "collection_detail_settings",
            "settings": settings,
            "updated_at": datetime.now(timezone.utc)
        }
        
        await db.website_settings.update_one(
            {"_id": "collection_detail_settings"},
            {"$set": update_data},
            upsert=True
        )
        
        return {"message": "Collection detail settings saved successfully", "settings": settings}
    except Exception as e:
        logger.error(f"Error saving collection detail settings: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============ COLLECTIONS PAGE SETTINGS (Hero, Room Links, Popular Filters) ============

@router.get("/collections-page-settings")
async def get_collections_page_settings():
    """Get Collections Page settings (hero banners, room links, filters)"""
    try:
        settings = await db.website_settings.find_one({"_id": "collections_page_settings"})
        if settings:
            settings.pop("_id", None)
            return {"settings": settings.get("settings", {})}
        return {"settings": {}}
    except Exception as e:
        logger.error(f"Error fetching collections page settings: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/collections-page-settings")
async def save_collections_page_settings(data: dict):
    """Save Collections Page settings (hero banners, room links, filters)"""
    try:
        settings = data.get("settings", {})
        
        update_data = {
            "_id": "collections_page_settings",
            "settings": settings,
            "updated_at": datetime.now(timezone.utc)
        }
        
        await db.website_settings.update_one(
            {"_id": "collections_page_settings"},
            {"$set": update_data},
            upsert=True
        )
        
        return {"message": "Collections page settings saved successfully", "settings": settings}
    except Exception as e:
        logger.error(f"Error saving collections page settings: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/public/collections-page-settings")
async def get_public_collections_page_settings():
    """Public endpoint - Get Collections Page settings without auth"""
    try:
        settings = await db.website_settings.find_one({"_id": "collections_page_settings"})
        if settings:
            settings.pop("_id", None)
            return {"settings": settings.get("settings", {})}
        return {"settings": {}}
    except Exception as e:
        logger.error(f"Error fetching collections page settings: {e}")
        return {"settings": {}}


# ============ TRADE ACCOUNT SETTINGS ============

@router.get("/trade-account-settings")
async def get_trade_account_settings():
    """Get trade account settings (banner, benefits, tiers)"""
    try:
        settings = await db.website_settings.find_one({"_id": "trade_account_settings"})
        result = {}
        if settings:
            settings.pop("_id", None)
            result = settings.get("settings", {})
        
        # If no announcement_bar saved yet, load from benefits_bar collection
        if "announcement_bar" not in result:
            benefits = await db.benefits_bar.find({}).sort("display_order", 1).to_list(20)
            if benefits:
                result["announcement_bar"] = {
                    "enabled": True,
                    "items": [{"text": b.get("text", ""), "link": b.get("link", "/tiles"), "enabled": b.get("is_active", True)} for b in benefits]
                }
        
        return {"settings": result}
    except Exception as e:
        logger.error(f"Error fetching trade account settings: {e}")
        return {"settings": {}}


@router.post("/trade-account-settings")
async def save_trade_account_settings(data: dict):
    """Save trade account settings"""
    try:
        settings = data.get("settings", {})
        await db.website_settings.update_one(
            {"_id": "trade_account_settings"},
            {"$set": {"settings": settings, "updated_at": datetime.now(timezone.utc).isoformat()}},
            upsert=True
        )
        
        return {"success": True, "message": "Settings saved"}
    except Exception as e:
        logger.error(f"Error saving trade account settings: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/public/trade-account-settings")
async def get_public_trade_account_settings():
    """Public endpoint - Get trade account settings for frontend"""
    try:
        settings = await db.website_settings.find_one({"_id": "trade_account_settings"})
        if settings:
            settings.pop("_id", None)
            return {"settings": settings.get("settings", {})}
        return {"settings": {}}
    except Exception as e:
        logger.error(f"Error fetching trade account settings: {e}")
        return {"settings": {}}


# ============ CUSTOMER ACCOUNT SETTINGS ============

@router.get("/customer-account-settings")
async def get_customer_account_settings():
    """Get customer account settings (registration page, account portal)"""
    try:
        settings = await db.website_settings.find_one({"_id": "customer_account_settings"})
        if settings:
            settings.pop("_id", None)
            return {"settings": settings.get("settings", {})}
        return {"settings": {}}
    except Exception as e:
        logger.error(f"Error fetching customer account settings: {e}")
        return {"settings": {}}


@router.post("/customer-account-settings")
async def save_customer_account_settings(data: dict):
    """Save customer account settings"""
    try:
        settings = data.get("settings", {})
        await db.website_settings.update_one(
            {"_id": "customer_account_settings"},
            {"$set": {"settings": settings, "updated_at": datetime.utcnow().isoformat()}},
            upsert=True
        )
        return {"success": True, "message": "Settings saved"}
    except Exception as e:
        logger.error(f"Error saving customer account settings: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/public/customer-account-settings")
async def get_public_customer_account_settings():
    """Public endpoint - Get customer account settings for frontend"""
    try:
        settings = await db.website_settings.find_one({"_id": "customer_account_settings"})
        if settings:
            settings.pop("_id", None)
            return {"settings": settings.get("settings", {})}
        return {"settings": {}}
    except Exception as e:
        logger.error(f"Error fetching customer account settings: {e}")
        return {"settings": {}}


# ============ CHECKOUT SETTINGS ============

@router.get("/checkout-settings")
async def get_checkout_settings():
    try:
        doc = await db.website_settings.find_one({"key": "checkout_settings"}, {"_id": 0})
        return {"settings": doc.get("value", {}) if doc else {}}
    except Exception as e:
        logger.error(f"Error fetching checkout settings: {e}")
        return {"settings": {}}

@router.post("/checkout-settings")
async def save_checkout_settings(data: dict):
    try:
        settings = data.get("settings", {})
        # Deep merge with existing settings to prevent partial data loss
        existing = await db.website_settings.find_one({"key": "checkout_settings"}, {"_id": 0})
        if existing and existing.get("value"):
            merged = deep_merge(existing["value"], settings)
        else:
            merged = settings
        await db.website_settings.update_one(
            {"key": "checkout_settings"},
            {"$set": {"key": "checkout_settings", "value": merged}},
            upsert=True
        )
        return {"message": "Checkout settings saved"}
    except Exception as e:
        logger.error(f"Error saving checkout settings: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/public/checkout-settings")
async def get_public_checkout_settings():
    try:
        doc = await db.website_settings.find_one({"key": "checkout_settings"}, {"_id": 0})
        return {"settings": doc.get("value", {}) if doc else {}}
    except Exception as e:
        logger.error(f"Error fetching checkout settings: {e}")
        return {"settings": {}}



# ============ SHOWROOM / CONTACT PAGE MANAGEMENT ============

class ShowroomCreate(BaseModel):
    name: str
    address: str
    city: str
    postcode: str
    phone: Optional[str] = None
    email: Optional[str] = None
    image_url: Optional[str] = None
    map_url: Optional[str] = None
    opening_hours: Optional[dict] = None
    holiday_hours: Optional[dict] = None  # Special hours for UK holidays
    is_coming_soon: bool = False
    display_order: int = 0
    is_active: bool = True


# UK Bank Holidays for 2025/2026
import httpx

# Cached UK holidays (auto-fetched from GOV.UK API)
_uk_holidays_cache = {"data": None, "fetched_at": None}

FALLBACK_UK_HOLIDAYS = [
    {"date": "2025-01-01", "name": "New Year's Day"},
    {"date": "2025-04-18", "name": "Good Friday"},
    {"date": "2025-04-21", "name": "Easter Monday"},
    {"date": "2025-05-05", "name": "Early May Bank Holiday"},
    {"date": "2025-05-26", "name": "Spring Bank Holiday"},
    {"date": "2025-08-25", "name": "Summer Bank Holiday"},
    {"date": "2025-12-25", "name": "Christmas Day"},
    {"date": "2025-12-26", "name": "Boxing Day"},
    {"date": "2026-01-01", "name": "New Year's Day"},
    {"date": "2026-04-03", "name": "Good Friday"},
    {"date": "2026-04-06", "name": "Easter Monday"},
    {"date": "2026-05-04", "name": "Early May Bank Holiday"},
    {"date": "2026-05-25", "name": "Spring Bank Holiday"},
    {"date": "2026-08-31", "name": "Summer Bank Holiday"},
    {"date": "2026-12-25", "name": "Christmas Day"},
    {"date": "2026-12-26", "name": "Boxing Day"},
]

async def get_uk_holidays_cached():
    """Fetch UK bank holidays from GOV.UK API with caching (refreshes daily)"""
    now = datetime.now(timezone.utc)
    if _uk_holidays_cache["data"] and _uk_holidays_cache["fetched_at"]:
        age = (now - _uk_holidays_cache["fetched_at"]).total_seconds()
        if age < 86400:  # Cache for 24 hours
            return _uk_holidays_cache["data"]
    
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get("https://www.gov.uk/bank-holidays.json")
            resp.raise_for_status()
            data = resp.json()
            
            england_events = data.get("england-and-wales", {}).get("events", [])
            holidays = [{"date": e["date"], "name": e["title"]} for e in england_events]
            
            # Sort by date and only keep current + next year
            current_year = now.year
            holidays = [h for h in holidays if int(h["date"][:4]) >= current_year - 1]
            holidays.sort(key=lambda x: x["date"])
            
            _uk_holidays_cache["data"] = holidays
            _uk_holidays_cache["fetched_at"] = now
            logger.info(f"Fetched {len(holidays)} UK bank holidays from GOV.UK API")
            return holidays
    except Exception as e:
        logger.warning(f"Failed to fetch UK holidays from GOV.UK: {e}, using fallback")
        if _uk_holidays_cache["data"]:
            return _uk_holidays_cache["data"]
        return FALLBACK_UK_HOLIDAYS


@router.get("/uk-holidays")
async def get_uk_holidays():
    """Get list of UK bank holidays (auto-detected from GOV.UK)"""
    holidays = await get_uk_holidays_cached()
    return {"holidays": holidays}


@router.get("/showrooms")
async def get_all_showrooms():
    """Get all showrooms for the contact page"""
    try:
        showrooms = await db.showrooms.find({}).sort("display_order", 1).to_list(50)
        
        result = []
        for s in showrooms:
            result.append({
                "id": str(s["_id"]),
                "name": s.get("name"),
                "address": s.get("address"),
                "city": s.get("city"),
                "postcode": s.get("postcode"),
                "phone": s.get("phone"),
                "email": s.get("email"),
                "image_url": s.get("image_url"),
                "image_position_x": s.get("image_position_x", 50),
                "image_position_y": s.get("image_position_y", 50),
                "map_url": s.get("map_url"),
                "opening_hours": s.get("opening_hours", {}),
                "holiday_hours": s.get("holiday_hours", {}),
                "is_coming_soon": s.get("is_coming_soon", False),
                "display_order": s.get("display_order", 0),
                "is_active": s.get("is_active", True),
            })
        
        return {"showrooms": result, "total": len(result)}
    except Exception as e:
        logger.error(f"Error fetching showrooms: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/showrooms/public")
async def get_public_showrooms():
    """Get active showrooms for public contact page (no auth required)"""
    try:
        # Match showrooms where is_active is True OR field doesn't exist (default active),
        # AND exclude warehouses (they are internal-only, not customer-facing).
        showrooms = await db.showrooms.find(
            {"is_active": {"$ne": False}, "is_warehouse": {"$ne": True}}
        ).sort("display_order", 1).to_list(50)
        
        result = []
        for s in showrooms:
            result.append({
                "id": str(s["_id"]),
                "name": s.get("name"),
                "address": s.get("address"),
                "city": s.get("city"),
                "postcode": s.get("postcode"),
                "phone": s.get("phone"),
                "email": s.get("email"),
                "image_url": s.get("image_url"),
                "image_position_x": s.get("image_position_x", 50),
                "image_position_y": s.get("image_position_y", 50),
                "map_url": s.get("map_url"),
                "opening_hours": s.get("opening_hours", {}),
                "holiday_hours": s.get("holiday_hours", {}),
                "is_coming_soon": s.get("is_coming_soon", False),
            })
        
        holidays = await get_uk_holidays_cached()
        return {"showrooms": result, "holidays": holidays}
    except Exception as e:
        logger.error(f"Error fetching public showrooms: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/showrooms")
async def create_showroom(showroom: ShowroomCreate):
    """Create a new showroom"""
    try:
        doc = {
            "name": showroom.name,
            "address": showroom.address,
            "city": showroom.city,
            "postcode": showroom.postcode,
            "phone": showroom.phone,
            "email": showroom.email,
            "image_url": showroom.image_url,
            "map_url": showroom.map_url,
            "opening_hours": showroom.opening_hours or {},
            "is_coming_soon": showroom.is_coming_soon,
            "display_order": showroom.display_order,
            "is_active": showroom.is_active,
            "created_at": datetime.utcnow(),
            "updated_at": datetime.utcnow()
        }
        
        result = await db.showrooms.insert_one(doc)
        return {"message": "Showroom created", "id": str(result.inserted_id)}
    except Exception as e:
        logger.error(f"Error creating showroom: {e}")
        raise HTTPException(status_code=500, detail=str(e))



@router.put("/showrooms/reorder")
async def reorder_showrooms(payload: dict):
    """Reorder showrooms by updating display_order"""
    try:
        from bson import ObjectId
        order = payload.get("order", [])
        for item in order:
            await db.showrooms.update_one(
                {"_id": ObjectId(item["id"])},
                {"$set": {"display_order": item["display_order"]}}
            )
        return {"success": True}
    except Exception as e:
        logger.error(f"Error reordering showrooms: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.put("/showrooms/{showroom_id}")
async def update_showroom(showroom_id: str, updates: dict):
    """Update a showroom"""
    try:
        from bson import ObjectId
        
        updates["updated_at"] = datetime.utcnow()
        updates.pop("_id", None)
        updates.pop("id", None)
        
        await db.showrooms.update_one(
            {"_id": ObjectId(showroom_id)},
            {"$set": updates}
        )
        
        return {"message": "Showroom updated", "id": showroom_id}
    except Exception as e:
        logger.error(f"Error updating showroom: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/showrooms/{showroom_id}")
async def delete_showroom(showroom_id: str):
    """Delete a showroom"""
    try:
        from bson import ObjectId
        await db.showrooms.delete_one({"_id": ObjectId(showroom_id)})
        return {"message": "Showroom deleted", "id": showroom_id}
    except Exception as e:
        logger.error(f"Error deleting showroom: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ==================== CONTACT SETTINGS (Online Enquiries) ====================

@router.get("/contact-settings/public")
async def get_public_contact_settings():
    """Get contact settings for public display (no auth)"""
    try:
        # Try _id: "main" first, then fall back to any document
        settings = await db.contact_settings.find_one({"_id": "main"}, {"_id": 0})
        if not settings:
            settings = await db.contact_settings.find_one({}, {"_id": 0})
        if not settings:
            return {"phone": "", "whatsapp": "", "emails": []}
        return {
            "phone": settings.get("phone", ""),
            "whatsapp": settings.get("whatsapp", ""),
            "phone_visible": settings.get("phone_visible", True),
            "whatsapp_visible": settings.get("whatsapp_visible", True),
            "emails": settings.get("emails", [])
        }
    except Exception as e:
        logger.error(f"Error fetching contact settings: {e}")
        return {"phone": "", "whatsapp": "", "emails": []}


@router.get("/contact-settings")
async def get_contact_settings():
    """Get contact settings for admin"""
    try:
        settings = await db.contact_settings.find_one({"_id": "main"}, {"_id": 0})
        if not settings:
            settings = await db.contact_settings.find_one({}, {"_id": 0})
        if not settings:
            return {"phone": "", "whatsapp": "", "emails": []}
        return {
            "phone": settings.get("phone", ""),
            "whatsapp": settings.get("whatsapp", ""),
            "phone_visible": settings.get("phone_visible", True),
            "whatsapp_visible": settings.get("whatsapp_visible", True),
            "emails": settings.get("emails", [])
        }
    except Exception as e:
        logger.error(f"Error fetching contact settings: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/contact-settings")
async def update_contact_settings(payload: dict):
    """Update contact settings (phone + categorized emails)"""
    try:
        doc = {
            "phone": payload.get("phone", ""),
            "whatsapp": payload.get("whatsapp", ""),
            "phone_visible": payload.get("phone_visible", True),
            "whatsapp_visible": payload.get("whatsapp_visible", True),
            "emails": payload.get("emails", []),
            "updated_at": datetime.utcnow()
        }
        await db.contact_settings.update_one(
            {"_id": "main"},
            {"$set": doc},
            upsert=True
        )
        return {"message": "Contact settings updated"}
    except Exception as e:
        logger.error(f"Error updating contact settings: {e}")
        raise HTTPException(status_code=500, detail=str(e))



# ==================== PAGE MAINTENANCE ====================

@router.get("/maintenance-pages/public")
async def get_public_maintenance_pages():
    """Get list of pages currently under maintenance (no auth)"""
    try:
        doc = await db.maintenance_pages.find_one({"_id": "config"}, {"_id": 0})
        if not doc:
            return {"pages": []}
        return {"pages": [p for p in doc.get("pages", []) if p.get("disabled")]}
    except Exception as e:
        logger.error(f"Error fetching maintenance pages: {e}")
        return {"pages": []}


@router.get("/maintenance-pages")
async def get_maintenance_pages():
    """Get all page maintenance settings (admin)"""
    try:
        doc = await db.maintenance_pages.find_one({"_id": "config"}, {"_id": 0})
        if not doc:
            return {"pages": []}
        return {"pages": doc.get("pages", [])}
    except Exception as e:
        logger.error(f"Error fetching maintenance pages: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/maintenance-pages")
async def update_maintenance_pages(payload: dict):
    """Update page maintenance settings"""
    try:
        pages = payload.get("pages", [])
        await db.maintenance_pages.update_one(
            {"_id": "config"},
            {"$set": {"pages": pages, "updated_at": datetime.utcnow()}},
            upsert=True
        )
        return {"message": "Maintenance settings updated"}
    except Exception as e:
        logger.error(f"Error updating maintenance pages: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ==================== WHOLE-SITE MAINTENANCE ====================
# A higher-level switch than per-page maintenance: when enabled, the entire
# storefront is replaced with the configured "Under Maintenance" page.
# Admin routes are unaffected (they don't pass through MaintenanceGuard).

_DEFAULT_SITE_MAINTENANCE = {
    "enabled": False,
    "headline": "We'll be back shortly",
    "message": (
        "Sorry for the inconvenience — we're making some quick improvements to the website. "
        "We'll be back online soon. Thanks for your patience."
    ),
    "scheduled_start": None,  # ISO 8601 string in UTC
    "scheduled_end": None,
    "auto_enabled": False,    # True when scheduler — not a human — flipped enabled
}


def _merge_site_maintenance(doc: dict | None) -> dict:
    out = dict(_DEFAULT_SITE_MAINTENANCE)
    if doc:
        if "enabled" in doc:
            out["enabled"] = bool(doc["enabled"])
        if isinstance(doc.get("headline"), str):
            h = doc["headline"].strip()
            if h:
                out["headline"] = h
        if isinstance(doc.get("message"), str):
            m = doc["message"].strip()
            if m:
                out["message"] = m
        # Schedule fields. Datetime values are normalised to ISO strings so the
        # JSON response is always serializable.
        for fld in ("scheduled_start", "scheduled_end"):
            v = doc.get(fld)
            if isinstance(v, datetime):
                out[fld] = v.replace(tzinfo=v.tzinfo or timezone.utc).isoformat()
            elif isinstance(v, str) and v.strip():
                out[fld] = v.strip()
        out["auto_enabled"] = bool(doc.get("auto_enabled", False))
    return out


@router.get("/site-maintenance/public")
async def get_public_site_maintenance():
    """Public read for the storefront guard. No auth — must be cheap and
    always succeed (we fail-open if the lookup errors, see below)."""
    try:
        doc = await db.site_maintenance.find_one({"_id": "config"}, {"_id": 0})
        return _merge_site_maintenance(doc)
    except Exception as e:
        logger.error(f"site-maintenance read failed: {e}")
        # Fail open — don't take the storefront down if Mongo blips.
        return _merge_site_maintenance(None)


@router.get("/site-maintenance")
async def get_site_maintenance():
    """Admin read."""
    doc = await db.site_maintenance.find_one({"_id": "config"}, {"_id": 0})
    return _merge_site_maintenance(doc)


@router.put("/site-maintenance")
async def update_site_maintenance(payload: dict):
    """Admin update — toggle / edit headline + message + (optionally) the
    auto-window. Setting enabled manually clears `auto_enabled` so the
    scheduler doesn't fight a human override."""
    try:
        update = {}
        if "enabled" in payload:
            update["enabled"] = bool(payload["enabled"])
            # Manual flip wins over any prior auto-flip.
            update["auto_enabled"] = False
        if "headline" in payload and isinstance(payload["headline"], str):
            update["headline"] = payload["headline"].strip()
        if "message" in payload and isinstance(payload["message"], str):
            update["message"] = payload["message"].strip()
        # Schedule fields — accept null/"" to clear, ISO string to set.
        for fld in ("scheduled_start", "scheduled_end"):
            if fld in payload:
                v = payload[fld]
                if v in (None, ""):
                    update[fld] = None
                elif isinstance(v, str):
                    parsed = _parse_iso(v)
                    if not parsed:
                        raise HTTPException(status_code=400, detail=f"Invalid {fld} — expected ISO 8601 datetime")
                    update[fld] = parsed.astimezone(timezone.utc).isoformat()
                else:
                    raise HTTPException(status_code=400, detail=f"Invalid {fld} type")
        # Cross-field validation: end must be after start.
        if update.get("scheduled_start") and update.get("scheduled_end"):
            s = _parse_iso(update["scheduled_start"])
            e = _parse_iso(update["scheduled_end"])
            if s and e and e <= s:
                raise HTTPException(status_code=400, detail="scheduled_end must be after scheduled_start")
        if not update:
            raise HTTPException(status_code=400, detail="Nothing to update")
        update["updated_at"] = datetime.now(timezone.utc)
        await db.site_maintenance.update_one(
            {"_id": "config"},
            {"$set": update},
            upsert=True,
        )
        doc = await db.site_maintenance.find_one({"_id": "config"}, {"_id": 0})
        return _merge_site_maintenance(doc)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating site maintenance: {e}")
        raise HTTPException(status_code=500, detail=str(e))


def _parse_iso(value: str | None):
    """Lenient ISO 8601 parse. Accepts trailing 'Z' (browser
    `<input type="datetime-local">` doesn't include a timezone, so we treat
    naive datetimes as UTC). Returns timezone-aware datetime or None."""
    if not value:
        return None
    try:
        s = value.strip()
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


async def run_site_maintenance_schedule_tick() -> dict:
    """
    APScheduler tick (every minute). Flips `enabled` based on the configured
    window, and only undoes its own work — a human override (manual enable
    or manual disable) is left alone.
    """
    try:
        doc = await db.site_maintenance.find_one({"_id": "config"})
        if not doc:
            return {"status": "no_config"}
        merged = _merge_site_maintenance(doc)
        start = _parse_iso(merged.get("scheduled_start"))
        end = _parse_iso(merged.get("scheduled_end"))
        now = datetime.now(timezone.utc)

        # Auto-enable: window has started, not already enabled.
        if start and end and start <= now < end and not merged["enabled"]:
            await db.site_maintenance.update_one(
                {"_id": "config"},
                {"$set": {
                    "enabled": True,
                    "auto_enabled": True,
                    "updated_at": now,
                }},
                upsert=True,
            )
            logger.info("site-maintenance: auto-enabled at %s (window %s → %s)", now.isoformat(), start, end)
            return {"status": "enabled"}

        # Auto-disable: window ended AND we were the ones who turned it on.
        if end and now >= end and merged["enabled"] and merged["auto_enabled"]:
            await db.site_maintenance.update_one(
                {"_id": "config"},
                {"$set": {
                    "enabled": False,
                    "auto_enabled": False,
                    "scheduled_start": None,
                    "scheduled_end": None,
                    "updated_at": now,
                }},
                upsert=True,
            )
            logger.info("site-maintenance: auto-disabled at %s (window ended %s)", now.isoformat(), end)
            return {"status": "disabled"}

        return {"status": "noop"}
    except Exception as e:
        logger.warning(f"site-maintenance schedule tick failed: {e}")
        return {"status": "error", "error": str(e)}



# ==================== WELCOME POPUP ====================

@router.get("/welcome-popup/public")
async def get_public_welcome_popup():
    """Get welcome popup config (no auth). Returns full coupon settings even when
    the popup itself is disabled, so the cart-save banner (which reuses the same
    coupon endpoint) keeps working independently."""
    try:
        doc = await db.welcome_popup.find_one({"_id": "config"}, {"_id": 0}) or {}
        return {
            "enabled": bool(doc.get("enabled")),
            "heading": doc.get("heading", ""),
            "message": doc.get("message", ""),
            "image_url": doc.get("image_url", ""),
            "cta_text": doc.get("cta_text", ""),
            "cta_link": doc.get("cta_link", ""),
            "show_email_capture": doc.get("show_email_capture", False),
            "email_placeholder": doc.get("email_placeholder", "Enter your email"),
            "email_button_text": doc.get("email_button_text", "Subscribe"),
            "frequency": doc.get("frequency", "once"),
            "delay_seconds": doc.get("delay_seconds", 2),
            "coupon_enabled": doc.get("coupon_enabled", False),
            "coupon_percent": int(doc.get("coupon_percent", 10) or 10),
            "coupon_expires_days": int(doc.get("coupon_expires_days", 30) or 30),
        }
    except Exception as e:
        logger.error(f"Error fetching welcome popup: {e}")
        return {"enabled": False, "coupon_enabled": False}


@router.get("/welcome-popup")
async def get_welcome_popup():
    """Get welcome popup config (admin)"""
    try:
        doc = await db.welcome_popup.find_one({"_id": "config"}, {"_id": 0})
        if not doc:
            return {
                "enabled": False, "heading": "", "message": "", "image_url": "",
                "cta_text": "", "cta_link": "", "show_email_capture": False,
                "email_placeholder": "Enter your email", "email_button_text": "Subscribe",
                "frequency": "once", "delay_seconds": 2,
                "coupon_enabled": False, "coupon_percent": 10, "coupon_expires_days": 30,
            }
        return doc
    except Exception as e:
        logger.error(f"Error fetching welcome popup: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/welcome-popup")
async def update_welcome_popup(payload: dict):
    """Update welcome popup config"""
    try:
        fields = {
            "enabled": payload.get("enabled", False),
            "heading": payload.get("heading", ""),
            "message": payload.get("message", ""),
            "image_url": payload.get("image_url", ""),
            "cta_text": payload.get("cta_text", ""),
            "cta_link": payload.get("cta_link", ""),
            "show_email_capture": payload.get("show_email_capture", False),
            "email_placeholder": payload.get("email_placeholder", "Enter your email"),
            "email_button_text": payload.get("email_button_text", "Subscribe"),
            "frequency": payload.get("frequency", "once"),
            "delay_seconds": payload.get("delay_seconds", 2),
            "coupon_enabled": bool(payload.get("coupon_enabled", False)),
            "coupon_percent": int(payload.get("coupon_percent", 10) or 10),
            "coupon_expires_days": int(payload.get("coupon_expires_days", 30) or 30),
            "updated_at": datetime.utcnow()
        }
        await db.welcome_popup.update_one({"_id": "config"}, {"$set": fields}, upsert=True)
        return {"message": "Welcome popup updated"}
    except Exception as e:
        logger.error(f"Error updating welcome popup: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/welcome-popup/email")
async def capture_popup_email(payload: dict):
    """Store an email captured from the welcome popup. If coupon_enabled,
    mint a single-use WELCOME-XXXXXX code and email it to the visitor."""
    try:
        from services.promo_codes import generate_promo_code_for_email
        from services.email import send_email_notification

        email = (payload.get("email") or "").strip().lower()
        if not email:
            raise HTTPException(status_code=400, detail="Email is required")

        # Allow callers (Welcome Popup vs Cart Save Banner) to tag where the lead
        # came from, so the Marketing Funnel widget can attribute captures.
        raw_source = (payload.get("source") or "welcome_popup").strip().lower()
        capture_source = raw_source if raw_source in {"welcome_popup", "cart_save_banner"} else "welcome_popup"

        # Idempotent capture
        existing = await db.popup_emails.find_one({"email": email})
        if not existing:
            await db.popup_emails.insert_one({
                "email": email,
                "source": capture_source,
                "captured_at": datetime.utcnow(),
            })

        config = await db.welcome_popup.find_one({"_id": "config"}, {"_id": 0}) or {}
        if config.get("coupon_enabled"):
            percent = int(config.get("coupon_percent", 10) or 10)
            expires_days = int(config.get("coupon_expires_days", 30) or 30)
            promo = await generate_promo_code_for_email(
                db, email,
                percent_off=percent,
                expires_days=expires_days,
                source="welcome_popup",
                prefix="WELCOME",
            )

            # Send the email asynchronously — don't block on failure
            try:
                expires_str = ""
                try:
                    if promo.get("expires_at"):
                        expires_str = datetime.fromisoformat(promo["expires_at"].replace("Z", "+00:00")).strftime("%d %b %Y")
                except Exception:
                    pass

                register_url = "https://tilestation.co.uk/shop/register"
                cart_url = f"https://tilestation.co.uk/shop/tile-cart?promo={promo['code']}"
                html = f"""
<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;background:#fff;">
  <div style="background:#111;color:#F7EA1C;padding:24px;text-align:center;">
    <h1 style="margin:0;font-size:22px;letter-spacing:1px;">TILE STATION</h1>
  </div>
  <div style="padding:32px;">
    <h2 style="margin:0 0 8px 0;">Welcome — here's your {percent}% off code</h2>
    <p style="color:#444;line-height:1.5;">Thanks for joining us. Use this single-use code at checkout{(' before ' + expires_str) if expires_str else ''}.</p>
    <div style="background:#FFFBE6;border:2px dashed #F7EA1C;border-radius:8px;padding:18px;margin:20px 0;text-align:center;">
      <div style="font-size:13px;color:#666;letter-spacing:1px;text-transform:uppercase;">Your code</div>
      <div style="font-size:26px;font-weight:bold;letter-spacing:2px;color:#111;margin:6px 0;">{promo['code']}</div>
      <div style="font-size:13px;color:#666;">{percent}% off your first order</div>
    </div>
    <div style="text-align:center;margin:28px 0;">
      <a href="{cart_url}"
         style="background:#F7EA1C;color:#111;padding:14px 36px;text-decoration:none;font-weight:bold;border-radius:6px;display:inline-block;">
        Start shopping
      </a>
    </div>
    <div style="border-top:1px solid #eee;margin-top:28px;padding-top:18px;">
      <p style="font-weight:bold;margin:0 0 6px 0;">Want to track your orders + save your favourites?</p>
      <p style="color:#666;font-size:14px;margin:0 0 14px 0;">Create your account in 30 seconds — your code stays valid either way.</p>
      <a href="{register_url}" style="color:#16A34A;font-weight:bold;text-decoration:underline;font-size:14px;">Create my account →</a>
    </div>
  </div>
</div>"""
                await send_email_notification(
                    to_emails=[email],
                    subject=f"Welcome to Tile Station — your {percent}% off code is inside",
                    html_content=html,
                    from_name="Tile Station",
                )
            except Exception as send_err:
                logger.warning(f"Welcome email send failed: {send_err}")

        return {"message": "Email captured. Discount code emailed."}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error capturing email: {e}")
        raise HTTPException(status_code=500, detail=str(e))



@router.post("/showrooms/upload-image")
async def upload_showroom_image(file: UploadFile = File(...)):
    """Upload a showroom image"""
    try:
        from services.storage.r2_uploader import R2ImageUploader, optimize_image, upload_to_r2
        
        # Validate file type
        allowed_types = ["image/jpeg", "image/png", "image/webp"]
        if file.content_type not in allowed_types:
            raise HTTPException(status_code=400, detail="Invalid file type")
        
        image_data = await file.read()
        unique_filename = f"showroom_{uuid.uuid4().hex[:12]}.jpg"
        
        # Try R2 upload
        image_url = None
        if R2ImageUploader and R2ImageUploader.is_configured():
            try:
                optimized_data = optimize_image(image_data, max_size=1200)
                image_url = upload_to_r2(optimized_data, f"showrooms/{unique_filename}")
            except Exception as e:
                logger.warning(f"R2 upload failed: {e}")
        
        # Fallback to local
        if not image_url:
            upload_dir = "/app/frontend/public/uploads/showrooms"
            os.makedirs(upload_dir, exist_ok=True)
            filepath = os.path.join(upload_dir, unique_filename)
            with open(filepath, "wb") as f:
                f.write(image_data)
            image_url = f"/uploads/showrooms/{unique_filename}"
        
        return {"success": True, "url": image_url}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Showroom image upload error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/showrooms/seed-defaults")
async def seed_default_showrooms():
    """Seed default Tile Station showrooms"""
    try:
        # Check if showrooms already exist
        count = await db.showrooms.count_documents({})
        if count > 0:
            return {"message": "Showrooms already exist", "count": count}
        
        default_showrooms = [
            {
                "name": "Gravesend (Northfleet)",
                "address": "Unit 3, Trade City, Coldharbour Road, Northfleet",
                "city": "Gravesend",
                "postcode": "DA11 8AB",
                "phone": "01474 878989",
                "email": "gravesend@tilestation.co.uk",
                "opening_hours": {
                    "monday": "8:00 - 18:00",
                    "tuesday": "8:00 - 18:00",
                    "wednesday": "8:00 - 18:00",
                    "thursday": "8:00 - 18:00",
                    "friday": "8:00 - 18:00",
                    "saturday": "9:00 - 18:00",
                    "sunday": "10:00 - 16:00"
                },
                "is_coming_soon": False,
                "display_order": 1,
                "is_active": True,
                "created_at": datetime.utcnow()
            },
            {
                "name": "Tonbridge",
                "address": "Unit 6, 402 Vale Road, Postern Industrial Estate",
                "city": "Tonbridge",
                "postcode": "TN9 1SW",
                "phone": "01732 914374",
                "email": "tonbridge@tilestation.co.uk",
                "opening_hours": {
                    "monday": "7:30 - 17:30",
                    "tuesday": "7:30 - 17:30",
                    "wednesday": "7:30 - 17:30",
                    "thursday": "7:30 - 17:30",
                    "friday": "7:30 - 17:30",
                    "saturday": "8:30 - 17:30",
                    "sunday": "10:00 - 16:00"
                },
                "is_coming_soon": False,
                "display_order": 2,
                "is_active": True,
                "created_at": datetime.utcnow()
            },
            {
                "name": "Chingford",
                "address": "10, Deacon Trading Estate, 11 Cabinet Way, South Chingford",
                "city": "London",
                "postcode": "E4 8QF",
                "phone": "",
                "email": "chingford@tilestation.co.uk",
                "opening_hours": {
                    "monday": "7:30 - 17:30",
                    "tuesday": "7:30 - 17:30",
                    "wednesday": "7:30 - 17:30",
                    "thursday": "7:30 - 17:30",
                    "friday": "7:30 - 17:30",
                    "saturday": "8:30 - 17:30",
                    "sunday": "10:00 - 16:00"
                },
                "is_coming_soon": False,
                "display_order": 3,
                "is_active": True,
                "created_at": datetime.utcnow()
            },
            {
                "name": "Sydenham",
                "address": "Coming Soon",
                "city": "London",
                "postcode": "",
                "phone": "",
                "email": "info@tilestation.co.uk",
                "opening_hours": {},
                "is_coming_soon": True,
                "display_order": 4,
                "is_active": True,
                "created_at": datetime.utcnow()
            }
        ]
        
        await db.showrooms.insert_many(default_showrooms)
        return {"message": "Default showrooms created", "count": len(default_showrooms)}
    except Exception as e:
        logger.error(f"Error seeding showrooms: {e}")
        raise HTTPException(status_code=500, detail=str(e))



# ============ COLLECTION-PRODUCT MAPPING SYSTEM ============
# Hybrid system: Auto-detection + Manual Override

class CollectionCreate(BaseModel):
    name: str
    description: Optional[str] = None
    hero_image: Optional[str] = None
    auto_rules: Optional[List[str]] = []  # Patterns for auto-detection
    is_featured: bool = False
    display_order: int = 0
    is_active: bool = True


@router.get("/collection-mappings")
async def get_all_collection_mappings():
    """
    Get all defined collections with their product counts.
    Shows both auto-detected and manually assigned products.
    """
    try:
        # Get manually defined collections
        collections_cursor = db.defined_collections.find({})
        defined_collections = await collections_cursor.to_list(500)
        
        # Get manual product mappings count for each collection
        result = []
        for col in defined_collections:
            col_id = str(col["_id"])
            
            # Count manually mapped products
            manual_count = await db.product_collection_map.count_documents({
                "collection_id": col_id,
                "is_manual": True
            })
            
            # Count auto-detected products (based on rules)
            auto_count = 0
            if col.get("auto_rules"):
                for rule in col["auto_rules"]:
                    pattern_count = await db.tiles.count_documents({
                        "$or": [
                            {"display_name": {"$regex": rule, "$options": "i"}},
                            {"name": {"$regex": rule, "$options": "i"}}
                        ]
                    })
                    auto_count += pattern_count
            
            result.append({
                "id": col_id,
                "name": col.get("name"),
                "slug": col.get("slug"),
                "description": col.get("description"),
                "hero_image": col.get("hero_image"),
                "auto_rules": col.get("auto_rules", []),
                "is_featured": col.get("is_featured", False),
                "display_order": col.get("display_order", 0),
                "is_active": col.get("is_active", True),
                "manual_product_count": manual_count,
                "auto_product_count": auto_count,
                "total_product_count": manual_count + auto_count
            })
        
        # Sort by display_order, then by name
        result.sort(key=lambda x: (x["display_order"], x["name"]))
        
        return {"collections": result, "total": len(result)}
    except Exception as e:
        logger.error(f"Error fetching collection mappings: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/collection-mappings")
async def create_collection_mapping(collection: CollectionCreate):
    """Create a new collection definition"""
    try:
        # Generate slug from name
        slug = collection.name.lower().replace(" ", "-").replace("&", "and")
        slug = ''.join(c for c in slug if c.isalnum() or c == '-')
        
        # Check if slug already exists
        existing = await db.defined_collections.find_one({"slug": slug})
        if existing:
            raise HTTPException(status_code=400, detail="Collection with this name already exists")
        
        doc = {
            "name": collection.name,
            "slug": slug,
            "description": collection.description,
            "hero_image": collection.hero_image,
            "auto_rules": collection.auto_rules or [],
            "is_featured": collection.is_featured,
            "display_order": collection.display_order,
            "is_active": collection.is_active,
            "created_at": datetime.utcnow(),
            "updated_at": datetime.utcnow()
        }
        
        result = await db.defined_collections.insert_one(doc)
        doc["id"] = str(result.inserted_id)
        doc.pop("_id", None)
        
        return {"message": "Collection created", "collection": doc}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating collection: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/collection-mappings/{collection_id}")
async def update_collection_mapping(collection_id: str, updates: dict):
    """Update a collection definition"""
    try:
        from bson import ObjectId
        
        update_data = {"updated_at": datetime.utcnow()}
        
        allowed_fields = ["name", "description", "hero_image", "auto_rules", 
                         "is_featured", "display_order", "is_active"]
        for field in allowed_fields:
            if field in updates:
                update_data[field] = updates[field]
        
        # Update slug if name changed
        if "name" in updates:
            slug = updates["name"].lower().replace(" ", "-").replace("&", "and")
            update_data["slug"] = ''.join(c for c in slug if c.isalnum() or c == '-')
        
        await db.defined_collections.update_one(
            {"_id": ObjectId(collection_id)},
            {"$set": update_data}
        )
        
        return {"message": "Collection updated", "id": collection_id}
    except Exception as e:
        logger.error(f"Error updating collection: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/collection-mappings/{collection_id}")
async def delete_collection_mapping(collection_id: str):
    """Delete a collection and its mappings"""
    try:
        from bson import ObjectId
        
        # Delete the collection
        await db.defined_collections.delete_one({"_id": ObjectId(collection_id)})
        
        # Delete all product mappings for this collection
        await db.product_collection_map.delete_many({"collection_id": collection_id})
        
        return {"message": "Collection deleted", "id": collection_id}
    except Exception as e:
        logger.error(f"Error deleting collection: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/collection-mappings/{collection_id}/products")
async def get_collection_products(
    collection_id: str,
    page: int = 1,
    limit: int = 50,
    search: str = ""
):
    """
    Get all products in a collection (both manual and auto-detected).
    Manual overrides are marked.
    """
    try:
        from bson import ObjectId
        
        # Get collection details
        collection = await db.defined_collections.find_one({"_id": ObjectId(collection_id)})
        if not collection:
            raise HTTPException(status_code=404, detail="Collection not found")
        
        # Get manually mapped product IDs
        manual_mappings = await db.product_collection_map.find({
            "collection_id": collection_id
        }).to_list(10000)
        
        manual_product_ids = {m["product_id"] for m in manual_mappings if m.get("is_manual")}
        excluded_product_ids = {m["product_id"] for m in manual_mappings if m.get("is_excluded")}
        
        # Build query for auto-detected products
        auto_query = {"$or": []}
        for rule in collection.get("auto_rules", []):
            if rule:
                auto_query["$or"].append({"display_name": {"$regex": rule, "$options": "i"}})
                auto_query["$or"].append({"name": {"$regex": rule, "$options": "i"}})
        
        # Search filter
        if search:
            search_filter = {
                "$or": [
                    {"display_name": {"$regex": search, "$options": "i"}},
                    {"name": {"$regex": search, "$options": "i"}},
                    {"sku": {"$regex": search, "$options": "i"}}
                ]
            }
        
        # Get products
        products = []
        seen_ids = set()
        
        # First, get manually assigned products
        if manual_product_ids:
            manual_query = {"_id": {"$in": [ObjectId(pid) for pid in manual_product_ids]}}
            if search:
                manual_query = {"$and": [manual_query, search_filter]}
            
            manual_products = await db.tiles.find(manual_query).to_list(1000)
            for p in manual_products:
                pid = str(p["_id"])
                if pid not in seen_ids and pid not in excluded_product_ids:
                    seen_ids.add(pid)
                    products.append({
                        "id": pid,
                        "name": p.get("display_name") or p.get("name"),
                        "sku": p.get("sku"),
                        "image": (p.get("images") or [None])[0] or p.get("image"),
                        "price": p.get("room_lot_price") or p.get("price"),
                        "supplier": p.get("supplier_name"),
                        "is_manual": True,
                        "is_excluded": False
                    })
        
        # Then, get auto-detected products
        if auto_query["$or"]:
            if search:
                auto_query = {"$and": [auto_query, search_filter]}
            
            auto_products = await db.tiles.find(auto_query).to_list(5000)
            for p in auto_products:
                pid = str(p["_id"])
                if pid not in seen_ids and pid not in excluded_product_ids:
                    seen_ids.add(pid)
                    products.append({
                        "id": pid,
                        "name": p.get("display_name") or p.get("name"),
                        "sku": p.get("sku"),
                        "image": (p.get("images") or [None])[0] or p.get("image"),
                        "price": p.get("room_lot_price") or p.get("price"),
                        "supplier": p.get("supplier_name"),
                        "is_manual": False,
                        "is_excluded": False
                    })
        
        # Pagination
        total = len(products)
        start = (page - 1) * limit
        end = start + limit
        paginated = products[start:end]
        
        return {
            "products": paginated,
            "total": total,
            "page": page,
            "pages": (total + limit - 1) // limit,
            "collection_name": collection.get("name")
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching collection products: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/collection-mappings/{collection_id}/products")
async def add_products_to_collection(collection_id: str, data: dict):
    """
    Manually add products to a collection.
    This creates manual overrides that take precedence over auto-detection.
    """
    try:
        product_ids = data.get("product_ids", [])
        if not product_ids:
            raise HTTPException(status_code=400, detail="No product IDs provided")
        
        added = 0
        for pid in product_ids:
            # Check if mapping already exists
            existing = await db.product_collection_map.find_one({
                "collection_id": collection_id,
                "product_id": pid
            })
            
            if existing:
                # Update to manual if it was auto
                await db.product_collection_map.update_one(
                    {"_id": existing["_id"]},
                    {"$set": {"is_manual": True, "is_excluded": False, "updated_at": datetime.utcnow()}}
                )
            else:
                # Create new mapping
                await db.product_collection_map.insert_one({
                    "collection_id": collection_id,
                    "product_id": pid,
                    "is_manual": True,
                    "is_excluded": False,
                    "created_at": datetime.utcnow(),
                    "updated_at": datetime.utcnow()
                })
            added += 1
        
        return {"message": f"Added {added} products to collection", "added": added}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error adding products to collection: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/collection-mappings/{collection_id}/products/{product_id}")
async def remove_product_from_collection(collection_id: str, product_id: str, exclude: bool = False):
    """
    Remove a product from a collection.
    If exclude=True, the product will be explicitly excluded (won't be auto-detected).
    """
    try:
        if exclude:
            # Mark as excluded (prevents auto-detection from adding it back)
            await db.product_collection_map.update_one(
                {"collection_id": collection_id, "product_id": product_id},
                {"$set": {
                    "is_manual": False,
                    "is_excluded": True,
                    "updated_at": datetime.utcnow()
                }},
                upsert=True
            )
            return {"message": "Product excluded from collection"}
        else:
            # Just remove the mapping
            await db.product_collection_map.delete_one({
                "collection_id": collection_id,
                "product_id": product_id
            })
            return {"message": "Product removed from collection"}
    except Exception as e:
        logger.error(f"Error removing product from collection: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/collection-mappings/{collection_id}/products/bulk")
async def bulk_add_products_to_collection(collection_id: str, data: dict):
    """
    Bulk add products to a collection based on filters.
    Supports: supplier, name pattern, category, etc.
    """
    try:
        filters = data.get("filters", {})
        query = {}
        
        # Build query from filters
        _f_supplier = normalise_filter_value(filters.get("supplier"))
        if _f_supplier:
            query["supplier_name"] = _f_supplier
        
        if filters.get("name_pattern"):
            query["$or"] = [
                {"display_name": {"$regex": filters["name_pattern"], "$options": "i"}},
                {"name": {"$regex": filters["name_pattern"], "$options": "i"}}
            ]
        
        if filters.get("category"):
            query["category"] = filters["category"]
        
        if filters.get("material"):
            query["material"] = filters["material"]
        
        if not query:
            raise HTTPException(status_code=400, detail="No filters provided")
        
        # Find matching products
        products = await db.tiles.find(query, {"_id": 1}).to_list(10000)
        product_ids = [str(p["_id"]) for p in products]
        
        # Add all to collection
        added = 0
        for pid in product_ids:
            existing = await db.product_collection_map.find_one({
                "collection_id": collection_id,
                "product_id": pid
            })
            
            if not existing:
                await db.product_collection_map.insert_one({
                    "collection_id": collection_id,
                    "product_id": pid,
                    "is_manual": True,
                    "is_excluded": False,
                    "created_at": datetime.utcnow()
                })
                added += 1
            elif existing.get("is_excluded"):
                # Don't override exclusions
                pass
            else:
                added += 1
        
        return {
            "message": f"Bulk added {added} products to collection",
            "added": added,
            "total_matched": len(product_ids)
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error bulk adding products: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/collection-mappings/available-products")
async def get_available_products(
    search: str = "",
    supplier: str = "",
    page: int = 1,
    limit: int = 50
):
    """Get products that can be added to collections"""
    try:
        query = {}
        
        if search:
            query["$or"] = [
                {"display_name": {"$regex": search, "$options": "i"}},
                {"name": {"$regex": search, "$options": "i"}},
                {"sku": {"$regex": search, "$options": "i"}}
            ]
        
        if supplier:
            query["supplier_name"] = supplier
        
        total = await db.tiles.count_documents(query)
        skip = (page - 1) * limit
        
        products = await db.tiles.find(query).skip(skip).limit(limit).to_list(limit)
        
        result = []
        for p in products:
            result.append({
                "id": str(p["_id"]),
                "name": p.get("display_name") or p.get("name"),
                "sku": p.get("sku"),
                "image": (p.get("images") or [None])[0] or p.get("image"),
                "price": p.get("room_lot_price") or p.get("price"),
                "supplier": p.get("supplier_name")
            })
        
        # Get unique suppliers for filter
        suppliers = await db.tiles.distinct("supplier_name")
        
        return {
            "products": result,
            "total": total,
            "page": page,
            "pages": (total + limit - 1) // limit,
            "suppliers": [s for s in suppliers if s]
        }
    except Exception as e:
        logger.error(f"Error fetching available products: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/collection-mappings/product/{product_id}/collections")
async def get_product_collections(product_id: str):
    """Get all collections a product belongs to"""
    try:
        # Get manual mappings
        mappings = await db.product_collection_map.find({
            "product_id": product_id,
            "is_excluded": {"$ne": True}
        }).to_list(100)
        
        collection_ids = [m["collection_id"] for m in mappings]
        
        # Get collection details
        from bson import ObjectId
        collections = []
        
        for cid in collection_ids:
            try:
                col = await db.defined_collections.find_one({"_id": ObjectId(cid)})
                if col:
                    collections.append({
                        "id": str(col["_id"]),
                        "name": col.get("name"),
                        "is_manual": next((m["is_manual"] for m in mappings if m["collection_id"] == cid), False)
                    })
            except:
                pass
        
        return {"collections": collections, "product_id": product_id}
    except Exception as e:
        logger.error(f"Error fetching product collections: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============ DATABASE LINK MIGRATION ============

@router.post("/migrate-links")
async def migrate_shop_links():
    """
    Bulk-update all saved links in the database from /shop/tiles to /tiles.
    Scans: navigation_menus, hero_slides, page_banners, website_settings, collections_page_settings.
    """
    total_updated = 0
    details = []

    def replace_in_value(val):
        """Recursively replace /shop/tiles with /tiles in strings, lists, and dicts."""
        if isinstance(val, str):
            return val.replace("/shop/tiles", "/tiles")
        elif isinstance(val, list):
            return [replace_in_value(item) for item in val]
        elif isinstance(val, dict):
            return {k: replace_in_value(v) for k, v in val.items()}
        return val

    try:
        # 1. Navigation menus
        nav_menus = await db.navigation_menus.find({}).to_list(100)
        for menu in nav_menus:
            items = menu.get("items", [])
            updated_items = replace_in_value(items)
            if updated_items != items:
                await db.navigation_menus.update_one(
                    {"_id": menu["_id"]},
                    {"$set": {"items": updated_items}}
                )
                count = str(items).count("/shop/tiles")
                total_updated += count
                details.append(f"navigation_menus ({menu.get('menu_type', '?')}): {count} links")

        # 2. Hero slides
        slides = await db.hero_slides.find({}).to_list(100)
        for slide in slides:
            link = slide.get("link", "")
            if "/shop/tiles" in str(link):
                new_link = link.replace("/shop/tiles", "/tiles")
                await db.hero_slides.update_one(
                    {"_id": slide["_id"]},
                    {"$set": {"link": new_link}}
                )
                total_updated += 1
                details.append(f"hero_slides: {slide.get('title', '?')}")

        # 3. Page banners
        banners = await db.page_banners.find({}).to_list(200)
        for banner in banners:
            changed = False
            update_fields = {}
            for field in ["link", "cta_link", "button_link"]:
                val = banner.get(field, "")
                if isinstance(val, str) and "/shop/tiles" in val:
                    update_fields[field] = val.replace("/shop/tiles", "/tiles")
                    changed = True
            if changed:
                await db.page_banners.update_one(
                    {"_id": banner["_id"]},
                    {"$set": update_fields}
                )
                total_updated += len(update_fields)
                details.append(f"page_banners: {banner.get('title', banner.get('category', '?'))}")

        # 4. Website settings (all settings docs that might contain links)
        settings_docs = await db.website_settings.find({}).to_list(100)
        for doc in settings_docs:
            original = str(doc)
            if "/shop/tiles" not in original:
                continue
            updated_doc = replace_in_value(doc)
            del updated_doc["_id"]
            await db.website_settings.update_one(
                {"_id": doc["_id"]},
                {"$set": updated_doc}
            )
            count = original.count("/shop/tiles")
            total_updated += count
            details.append(f"website_settings ({doc.get('key', doc.get('_id', '?'))}): {count} links")

        # 5. Shop tabs
        tabs_docs = await db.shop_tabs.find({}).to_list(100) if "shop_tabs" in await db.list_collection_names() else []
        for doc in tabs_docs:
            original = str(doc)
            if "/shop/tiles" not in original:
                continue
            updated_doc = replace_in_value(doc)
            del updated_doc["_id"]
            await db.shop_tabs.update_one(
                {"_id": doc["_id"]},
                {"$set": updated_doc}
            )
            count = original.count("/shop/tiles")
            total_updated += count
            details.append(f"shop_tabs: {count} links")

        result_payload = {
            "success": True,
            "total_links_updated": total_updated,
            "details": details,
            "message": f"Migration complete. Updated {total_updated} links from /shop/tiles to /tiles."
        }
        try:
            await _record_maintenance_run("legacy_shop_tiles_paths", result_payload, None)
        except Exception:
            pass
        return result_payload
    except Exception as e:
        logger.error(f"Link migration error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============ DATA CLEANUP ============

@router.post("/cleanup/find-collections")
async def find_collections_by_name(data: dict):
    """Search for collections/products by name across all relevant DB collections."""
    search_terms = data.get("names", [])
    if not search_terms:
        raise HTTPException(status_code=400, detail="Provide 'names' array")
    
    results = []
    db_collections = await db.list_collection_names()
    
    for term in search_terms:
        for coll_name in db_collections:
            try:
                coll = db[coll_name]
                docs = await coll.find({"$or": [
                    {"name": {"$regex": term, "$options": "i"}},
                    {"title": {"$regex": term, "$options": "i"}},
                    {"slug": {"$regex": term.lower().replace(" ", "-"), "$options": "i"}},
                    {"range_name": {"$regex": term, "$options": "i"}},
                    {"collection_name": {"$regex": term, "$options": "i"}},
                ]}).to_list(20)
                for doc in docs:
                    results.append({
                        "db_collection": coll_name,
                        "id": str(doc["_id"]),
                        "name": doc.get("name", doc.get("title", doc.get("range_name", doc.get("slug", "?")))),
                        "slug": doc.get("slug", ""),
                    })
            except Exception:
                pass
    
    return {"results": results, "count": len(results)}


@router.post("/cleanup/delete-by-name")
async def delete_collections_by_name(data: dict):
    """Delete collections/products by name from all relevant DB collections. Searches and deletes."""
    search_terms = data.get("names", [])
    dry_run = data.get("dry_run", True)
    
    if not search_terms:
        raise HTTPException(status_code=400, detail="Provide 'names' array")
    
    deleted = []
    db_collections = await db.list_collection_names()
    
    for term in search_terms:
        for coll_name in db_collections:
            try:
                coll = db[coll_name]
                query = {"$or": [
                    {"name": {"$regex": f"^{term}$", "$options": "i"}},
                    {"title": {"$regex": f"^{term}$", "$options": "i"}},
                    {"slug": {"$regex": f"^{term.lower().replace(' ', '-')}$", "$options": "i"}},
                    {"range_name": {"$regex": f"^{term}$", "$options": "i"}},
                ]}
                docs = await coll.find(query).to_list(50)
                for doc in docs:
                    entry = {
                        "db_collection": coll_name,
                        "id": str(doc["_id"]),
                        "name": doc.get("name", doc.get("title", doc.get("range_name", "?"))),
                    }
                    if not dry_run:
                        await coll.delete_one({"_id": doc["_id"]})
                        entry["deleted"] = True
                    else:
                        entry["would_delete"] = True
                    deleted.append(entry)
            except Exception:
                pass
    
    return {
        "mode": "DRY RUN (preview)" if dry_run else "DELETED",
        "items": deleted,
        "count": len(deleted),
        "message": f"{'Would delete' if dry_run else 'Deleted'} {len(deleted)} items matching {search_terms}. Set dry_run=false to confirm deletion."
    }


# ============ COLLECTION ORGANIZER ============

@router.get("/collection-organizer/suppliers")
async def get_collection_organizer_suppliers():
    """Get all suppliers with their series counts for the Collection Organizer.
    Uses same series logic as Supplier Products page: raw series field, 
    falling back to first word of product_name."""
    pipeline = [
        {"$match": {"supplier": {"$ne": None}}},
        {"$project": {
            "supplier": 1,
            "effective_series": {
                "$ifNull": [
                    "$series",
                    {"$arrayElemAt": [{"$split": [{"$ifNull": ["$product_name", ""]}, " "]}, 0]}
                ]
            }
        }},
        {"$match": {"effective_series": {"$nin": [None, ""]}}},
        {"$group": {
            "_id": "$supplier",
            "total_products": {"$sum": 1},
            "series_list": {"$addToSet": "$effective_series"}
        }},
        {"$sort": {"total_products": -1}},
        {"$project": {
            "_id": 0,
            "name": "$_id",
            "total_products": 1,
            "series_count": {"$size": "$series_list"}
        }}
    ]
    suppliers = await db.supplier_products.aggregate(pipeline).to_list(200)
    
    # Also count suppliers that had no effective series (products with no name at all)
    all_supplier_counts = {}
    count_pipeline = [
        {"$group": {"_id": "$supplier", "count": {"$sum": 1}}},
        {"$match": {"_id": {"$ne": None}}}
    ]
    for s in await db.supplier_products.aggregate(count_pipeline).to_list(200):
        all_supplier_counts[s["_id"]] = s["count"]
    
    # Merge: some suppliers might be missing if ALL their products lack names
    seen = {s["name"] for s in suppliers}
    for name, count in all_supplier_counts.items():
        if name not in seen:
            suppliers.append({"name": name, "total_products": count, "series_count": 0})
        else:
            # Fix total_products to include products with no effective_series
            for s in suppliers:
                if s["name"] == name:
                    s["total_products"] = count
                    break
    
    suppliers.sort(key=lambda x: -x["total_products"])
    return {"suppliers": suppliers}


@router.get("/collection-organizer/series")
async def get_collection_organizer_series(supplier: str):
    """
    Get all series for a supplier with product counts, product names, and category assignments.
    Uses same series logic as Supplier Products page: raw series field,
    falling back to first word of product_name.
    """
    pipeline = [
        {"$match": {"supplier": supplier}},
        {"$project": {
            "effective_series": {
                "$ifNull": [
                    "$series",
                    {"$arrayElemAt": [{"$split": [{"$ifNull": ["$product_name", ""]}, " "]}, 0]}
                ]
            },
            "main_image": 1,
            "product_group": 1,
            "main_category": 1,
            "sub_categories": 1,
            "our_product_name": 1,
            "product_name": 1,
            "name": 1,
        }},
        {"$match": {"effective_series": {"$nin": [None, ""]}}},
        {"$group": {
            "_id": "$effective_series",
            "count": {"$sum": 1},
            "sample_image": {"$first": "$main_image"},
            "product_groups": {"$addToSet": "$product_group"},
            "main_categories": {"$addToSet": "$main_category"},
            "all_sub_categories": {"$push": "$sub_categories"},
            "product_names": {"$push": {
                "$ifNull": ["$our_product_name", {"$ifNull": ["$product_name", "$name"]}]
            }},
        }},
        {"$sort": {"count": -1}},
        {"$project": {
            "_id": 0,
            "name": "$_id",
            "count": 1,
            "sample_image": 1,
            "product_groups": 1,
            "main_categories": 1,
            "all_sub_categories": 1,
            "product_names": {"$slice": ["$product_names", 5]},
        }}
    ]
    series_list = await db.supplier_products.aggregate(pipeline).to_list(500)

    # Collect all relevant product_groups from this supplier's data
    all_groups = set()

    # Clean up the results
    for s in series_list:
        s["product_groups"] = [pg for pg in (s.get("product_groups") or []) if pg]
        s["main_categories"] = [mc for mc in (s.get("main_categories") or []) if mc]
        for pg in s["product_groups"]:
            all_groups.add(pg)
        # Flatten nested sub_categories arrays
        flat_subs = set()
        for sub_arr in (s.get("all_sub_categories") or []):
            if isinstance(sub_arr, list):
                for sub in sub_arr:
                    if sub:
                        flat_subs.add(sub)
            elif sub_arr:
                flat_subs.add(sub_arr)
        s["sub_categories"] = sorted(flat_subs)
        if "all_sub_categories" in s:
            del s["all_sub_categories"]
        # Clean product_names - remove None values
        raw_names = [n for n in (s.get("product_names") or []) if n]
        s["product_names"] = raw_names[:5]

        # Build a simple assignments summary
        assignments = []
        for mc in s["main_categories"]:
            subs = [sc for sc in s["sub_categories"]]
            assignments.append({"main_category": mc, "sub_categories": subs})
        s["assignments"] = assignments

    # Calculate truly ungrouped: total products minus sum of all series products
    total_products = await db.supplier_products.count_documents({"supplier": supplier})
    grouped_count = sum(s["count"] for s in series_list)
    ungrouped_count = max(0, total_products - grouped_count)

    return {
        "supplier": supplier,
        "series": series_list,
        "total": len(series_list),
        "ungrouped_count": ungrouped_count,
        "relevant_groups": sorted(all_groups),
    }


@router.get("/collection-organizer/category-tree")
async def get_collection_organizer_category_tree():
    """
    Get the full category tree for drop zones.
    Returns category_groups with their categories, dynamically from DB.
    """
    groups = await db.category_groups.find({"is_active": True}).sort("display_order", 1).to_list(100)
    result = []
    for group in groups:
        group_id = str(group.pop("_id"))
        categories = await db.website_categories.find(
            {"group_slug": group["slug"]}
        ).sort("display_order", 1).to_list(1000)
        for cat in categories:
            cat["id"] = str(cat.pop("_id"))
        result.append({
            "id": group_id,
            "name": group["name"],
            "slug": group["slug"],
            "color": group.get("color", "#6B7280"),
            "icon": group.get("icon", "Folder"),
            "categories": categories
        })

    # If no groups exist yet, seed defaults and retry
    if not result:
        existing = await db.category_groups.count_documents({})
        if existing == 0:
            default_groups = [
                {"name": "Tiles", "slug": "tiles", "color": "#3B82F6", "icon": "Grid3X3", "display_order": 1, "is_active": True},
                {"name": "Flooring", "slug": "flooring", "color": "#8B5CF6", "icon": "Layers", "display_order": 2, "is_active": True},
                {"name": "Underfloor Heating", "slug": "underfloor-heating", "color": "#EF4444", "icon": "Flame", "display_order": 3, "is_active": True},
                {"name": "Materials", "slug": "materials", "color": "#10B981", "icon": "Package", "display_order": 4, "is_active": True},
                {"name": "Tools", "slug": "tools", "color": "#F59E0B", "icon": "Wrench", "display_order": 5, "is_active": True},
                {"name": "Accessories", "slug": "accessories", "color": "#EC4899", "icon": "Puzzle", "display_order": 6, "is_active": True},
            ]
            for g in default_groups:
                g["created_at"] = datetime.now(timezone.utc)
                g["updated_at"] = datetime.now(timezone.utc)
                await db.category_groups.insert_one(g)
            # Re-fetch
            groups = await db.category_groups.find({"is_active": True}).sort("display_order", 1).to_list(100)
            for group in groups:
                group_id = str(group.pop("_id"))
                result.append({
                    "id": group_id,
                    "name": group["name"],
                    "slug": group["slug"],
                    "color": group.get("color", "#6B7280"),
                    "icon": group.get("icon", "Folder"),
                    "categories": []
                })

    return {"groups": result}


@router.post("/collection-organizer/assign")
async def assign_series_to_category(data: dict):
    """
    Assign a supplier's series to a category (group + optional sub-category).
    Updates product_group, main_category, and sub_categories on all products in the series.
    
    Body:
    {
        "supplier": "Plus39",
        "series": "Artisan",
        "group_slug": "tiles",
        "main_category": "Tiles",       // The group name (used for customer-facing display)
        "sub_categories": ["Wall Tiles"] // Optional: specific categories within the group
    }
    """
    supplier = normalise_filter_value(data.get("supplier"))
    series_name = data.get("series")
    group_slug = data.get("group_slug")
    main_category = data.get("main_category")
    sub_categories = data.get("sub_categories", [])

    if not supplier or not series_name or not group_slug or not main_category:
        raise HTTPException(status_code=400, detail="supplier, series, group_slug, and main_category are required")

    # Match products by raw series field OR by derived series (first word of product_name)
    import re as _re
    escaped_series = _re.escape(series_name)
    query = {"supplier": supplier, "$or": [
        {"series": series_name},
        {"series": {"$in": [None, ""]}, "product_name": {"$regex": f"^{escaped_series}\\b", "$options": "i"}},
        {"series": {"$exists": False}, "product_name": {"$regex": f"^{escaped_series}\\b", "$options": "i"}},
    ]}
    products = await db.supplier_products.find(query).to_list(5000)
    updated = 0

    for product in products:
        existing_subs = product.get("sub_categories", []) or []
        if not isinstance(existing_subs, list):
            existing_subs = [existing_subs] if existing_subs else []
        merged_subs = list(set(existing_subs + sub_categories))
        update_fields = {
            "product_group": group_slug,
            "main_category": main_category,
            "sub_categories": merged_subs,
            "updated_at": datetime.now(timezone.utc)
        }
        result = await db.supplier_products.update_one(
            {"_id": product["_id"]},
            {"$set": update_fields}
        )
        if result.modified_count > 0:
            updated += 1

    # Also update in the published tiles collection using broad matching (including derived series)
    supplier_regex = {"$regex": f"^{supplier}$", "$options": "i"}
    series_derived = {"series": {"$in": [None, ""]}, "name": {"$regex": f"^{escaped_series}\\b", "$options": "i"}}
    series_derived_missing = {"series": {"$exists": False}, "name": {"$regex": f"^{escaped_series}\\b", "$options": "i"}}
    tile_conditions = [
        {"supplier_name": supplier_regex, "series": series_name},
        {"supplier_name": supplier_regex, **series_derived},
        {"supplier_name": supplier_regex, **series_derived_missing},
        {"source_supplier": supplier_regex, "series": series_name},
        {"source_supplier": supplier_regex, **series_derived},
        {"source_supplier": supplier_regex, **series_derived_missing},
    ]
    matching_tiles = await db.tiles.find({"$or": tile_conditions}).to_list(1000)
    tiles_updated = 0
    for tile in matching_tiles:
        existing_tile_subs = tile.get("sub_categories", []) or []
        if not isinstance(existing_tile_subs, list):
            existing_tile_subs = [existing_tile_subs] if existing_tile_subs else []
        merged_tile_subs = list(set(existing_tile_subs + sub_categories))
        t_result = await db.tiles.update_one(
            {"_id": tile["_id"]},
            {"$set": {"product_group": group_slug, "main_category": main_category, "sub_categories": merged_tile_subs}}
        )
        if t_result.modified_count > 0:
            tiles_updated += 1

    total = len(products) + len(matching_tiles)
    if total == 0:
        raise HTTPException(status_code=404, detail=f"No products found for series '{series_name}' from supplier '{supplier}'")

    return {
        "success": True,
        "message": f"Assigned {series_name} to {main_category}" + (f" > {', '.join(sub_categories)}" if sub_categories else ""),
        "products_updated": updated,
        "tiles_updated": tiles_updated,
        "total_in_series": total
    }


@router.post("/collection-organizer/unassign")
async def unassign_series_from_category(data: dict):
    """
    Remove a series from a specific category assignment.
    If sub_categories specified, removes only those subs. 
    If no sub_categories, clears the entire main_category assignment.
    
    Body:
    {
        "supplier": "Plus39",
        "series": "Artisan",
        "main_category": "Tiles",
        "sub_categories": ["Wall Tiles"]  // Optional: remove specific subs only
    }
    """
    supplier = normalise_filter_value(data.get("supplier"))
    series_name = data.get("series")
    main_category = data.get("main_category")
    sub_categories_to_remove = data.get("sub_categories", [])

    if not supplier or not series_name:
        raise HTTPException(status_code=400, detail="supplier and series are required")

    # Match products by raw series field OR by derived series (first word of product_name)
    import re as _re
    escaped_series = _re.escape(series_name)
    query = {"supplier": supplier, "$or": [
        {"series": series_name},
        {"series": {"$in": [None, ""]}, "product_name": {"$regex": f"^{escaped_series}\\b", "$options": "i"}},
        {"series": {"$exists": False}, "product_name": {"$regex": f"^{escaped_series}\\b", "$options": "i"}},
    ]}
    products = await db.supplier_products.find(query).to_list(5000)
    updated = 0

    for product in products:
        if sub_categories_to_remove:
            # Remove specific sub_categories
            existing_subs = product.get("sub_categories", []) or []
            new_subs = [s for s in existing_subs if s not in sub_categories_to_remove]
            update = {"$set": {"sub_categories": new_subs, "updated_at": datetime.now(timezone.utc)}}
        else:
            # Clear entire category assignment
            update = {"$set": {
                "product_group": None,
                "main_category": None,
                "sub_categories": [],
                "updated_at": datetime.now(timezone.utc)
            }}

        result = await db.supplier_products.update_one({"_id": product["_id"]}, update)
        if result.modified_count > 0:
            updated += 1

    # Also update tiles collection using broad matching (including derived series)
    supplier_regex = {"$regex": f"^{supplier}$", "$options": "i"}
    series_derived = {"series": {"$in": [None, ""]}, "name": {"$regex": f"^{escaped_series}\\b", "$options": "i"}}
    series_derived_missing = {"series": {"$exists": False}, "name": {"$regex": f"^{escaped_series}\\b", "$options": "i"}}
    tile_conditions = [
        {"supplier_name": supplier_regex, "series": series_name},
        {"supplier_name": supplier_regex, **series_derived},
        {"supplier_name": supplier_regex, **series_derived_missing},
        {"source_supplier": supplier_regex, "series": series_name},
        {"source_supplier": supplier_regex, **series_derived},
        {"source_supplier": supplier_regex, **series_derived_missing},
    ]
    matching_tiles = await db.tiles.find({"$or": tile_conditions}).to_list(1000)
    for tile in matching_tiles:
        if sub_categories_to_remove:
            existing_tile_subs = tile.get("sub_categories", []) or []
            if not isinstance(existing_tile_subs, list):
                existing_tile_subs = [existing_tile_subs] if existing_tile_subs else []
            new_tile_subs = [s for s in existing_tile_subs if s not in sub_categories_to_remove]
            await db.tiles.update_one({"_id": tile["_id"]}, {"$set": {"sub_categories": new_tile_subs}})
        else:
            await db.tiles.update_one({"_id": tile["_id"]}, {"$set": {
                "product_group": None,
                "main_category": None,
                "sub_categories": [],
            }})

    return {
        "success": True,
        "message": f"Unassigned {series_name}" + (f" from {', '.join(sub_categories_to_remove)}" if sub_categories_to_remove else f" from {main_category}"),
        "products_updated": updated
    }


@router.post("/collection-organizer/bulk-assign")
async def bulk_assign_series_to_category(data: dict):
    """
    Assign multiple series from a supplier to one or more categories in one call.
    
    Body (single target - backwards compatible):
    {
        "supplier": "Plus39",
        "series_names": ["Artisan", "Burlington"],
        "group_slug": "tiles",
        "main_category": "Tiles",
        "sub_categories": ["Wall Tiles"]
    }
    
    Body (multiple targets):
    {
        "supplier": "Plus39",
        "series_names": ["Artisan", "Burlington"],
        "targets": [
            {"group_slug": "tiles", "main_category": "Tiles", "sub_categories": ["Wall Tiles"]},
            {"group_slug": "tiles", "main_category": "Tiles", "sub_categories": ["Bathroom Tiles"]}
        ]
    }
    """
    supplier = normalise_filter_value(data.get("supplier"))
    series_names = data.get("series_names", [])
    targets = data.get("targets", [])

    # Backwards compatibility: if no targets array, build one from flat fields
    if not targets:
        group_slug = data.get("group_slug")
        main_category = data.get("main_category")
        sub_categories = data.get("sub_categories", [])
        if group_slug and main_category:
            targets = [{"group_slug": group_slug, "main_category": main_category, "sub_categories": sub_categories}]

    if not supplier or not series_names or not targets:
        raise HTTPException(status_code=400, detail="supplier, series_names, and at least one target are required")

    # Collect all sub_categories across all targets for each group
    # Group targets by group_slug to merge sub_categories
    group_map = {}
    for t in targets:
        gs = t.get("group_slug")
        mc = t.get("main_category")
        subs = t.get("sub_categories", [])
        key = f"{gs}::{mc}"
        if key not in group_map:
            group_map[key] = {"group_slug": gs, "main_category": mc, "sub_categories": set()}
        for s in subs:
            group_map[key]["sub_categories"].add(s)

    results = []
    total_updated = 0
    target_labels = []

    for series_name in series_names:
        # Match products by raw series field OR by derived series (first word of product_name)
        import re as _re
        escaped_series = _re.escape(series_name)
        query = {"supplier": supplier, "$or": [
            {"series": series_name},
            {"series": {"$in": [None, ""]}, "product_name": {"$regex": f"^{escaped_series}\\b", "$options": "i"}},
            {"series": {"$exists": False}, "product_name": {"$regex": f"^{escaped_series}\\b", "$options": "i"}},
        ]}
        products = await db.supplier_products.find(query).to_list(5000)
        updated = 0

        for product in products:
            existing_subs = product.get("sub_categories", []) or []
            if not isinstance(existing_subs, list):
                existing_subs = [existing_subs] if existing_subs else []

            # Merge all target sub_categories
            all_new_subs = set()
            last_group_slug = None
            last_main_category = None
            for merged in group_map.values():
                all_new_subs.update(merged["sub_categories"])
                last_group_slug = merged["group_slug"]
                last_main_category = merged["main_category"]

            merged_subs = list(set(existing_subs) | all_new_subs)

            update_fields = {
                "product_group": last_group_slug,
                "main_category": last_main_category,
                "sub_categories": merged_subs,
                "updated_at": datetime.now(timezone.utc)
            }
            result = await db.supplier_products.update_one(
                {"_id": product["_id"]},
                {"$set": update_fields}
            )
            if result.modified_count > 0:
                updated += 1

        # Update tiles for this series using broad matching (including derived series)
        supplier_regex = {"$regex": f"^{supplier}$", "$options": "i"}
        series_derived = {"series": {"$in": [None, ""]}, "name": {"$regex": f"^{escaped_series}\\b", "$options": "i"}}
        series_derived_missing = {"series": {"$exists": False}, "name": {"$regex": f"^{escaped_series}\\b", "$options": "i"}}
        tile_conditions = [
            {"supplier_name": supplier_regex, "series": series_name},
            {"supplier_name": supplier_regex, **series_derived},
            {"supplier_name": supplier_regex, **series_derived_missing},
            {"source_supplier": supplier_regex, "series": series_name},
            {"source_supplier": supplier_regex, **series_derived},
            {"source_supplier": supplier_regex, **series_derived_missing},
        ]
        matching_tiles = await db.tiles.find({"$or": tile_conditions}).to_list(1000)
        for tile in matching_tiles:
            existing_tile_subs = tile.get("sub_categories", []) or []
            if not isinstance(existing_tile_subs, list):
                existing_tile_subs = [existing_tile_subs] if existing_tile_subs else []
            all_new_subs_list = set()
            last_gs = None
            last_mc = None
            for merged in group_map.values():
                all_new_subs_list.update(merged["sub_categories"])
                last_gs = merged["group_slug"]
                last_mc = merged["main_category"]
            merged_tile_subs = list(set(existing_tile_subs) | all_new_subs_list)
            await db.tiles.update_one({"_id": tile["_id"]}, {"$set": {
                "product_group": last_gs,
                "main_category": last_mc,
                "sub_categories": merged_tile_subs,
            }})

        total_updated += updated
        results.append({"series": series_name, "products_updated": updated})

    for merged in group_map.values():
        subs = sorted(merged["sub_categories"])
        label = merged["main_category"] + (f" > {', '.join(subs)}" if subs else "")
        target_labels.append(label)

    return {
        "success": True,
        "message": f"Assigned {len(series_names)} series to {'; '.join(target_labels)}",
        "total_products_updated": total_updated,
        "details": results
    }

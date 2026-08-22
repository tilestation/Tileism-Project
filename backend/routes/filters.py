"""
Filters Management Routes
Category-based filter system for products
"""
from fastapi import APIRouter, HTTPException
from motor.motor_asyncio import AsyncIOMotorClient
from datetime import datetime, timezone
from typing import Optional, List
from pydantic import BaseModel
from bson import ObjectId
import os
import re
import logging
from collections import defaultdict
from routes.series_utils import product_group_key

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/filters", tags=["Filters"])

# Database connection
MONGO_URL = os.environ.get("MONGO_URL")
DB_NAME = os.environ.get("DB_NAME", "tile_station")
client = AsyncIOMotorClient(MONGO_URL)
db = client[DB_NAME]


# ============ SIZE NORMALIZATION UTILITIES ============

def normalize_size(size_str: str) -> str:
    """
    Normalize a tile size string to a consistent format.
    
    Tile sizes can be in:
    - Centimeters: 30x60, 60x60, 80x160 (common in tile industry)
    - Millimeters: 300x600, 600x600, 800x1600
    
    Logic:
    - If dimensions are < 200, assume centimeters
    - If dimensions are >= 200, assume millimeters
    
    Returns format: WIDTHxHEIGHTcm or WIDTHxHEIGHTmm
    """
    if not size_str:
        return ""
    
    # Convert to lowercase and strip whitespace
    s = size_str.lower().strip()
    
    # Remove all spaces
    s = re.sub(r'\s+', '', s)
    
    # Extract numbers and dimensions
    # Pattern matches: number(x)number(x)number(optional mm/cm)
    pattern = r'^(\d+)[x×](\d+)(?:[x×](\d+))?(?:mm|cm)?$'
    match = re.match(pattern, s)
    
    if match:
        width = int(match.group(1))
        height = int(match.group(2))
        thickness = match.group(3)
        
        # Determine unit based on size values
        # Tiles are typically sold in cm (30x60, 60x60, 80x80)
        # or mm (300x600, 600x600, 800x800)
        # If the largest dimension is < 200, it's likely cm
        max_dim = max(width, height)
        unit = "cm" if max_dim < 200 else "mm"
        
        if thickness:
            return f"{width}x{height}x{thickness}{unit}"
        else:
            return f"{width}x{height}{unit}"
    
    # If pattern doesn't match, just lowercase and standardize x separator
    s = re.sub(r'[×X]', 'x', s)
    
    # Try to determine unit from existing suffix or guess
    if s.endswith('cm') or s.endswith('mm'):
        return s
    
    # If it looks like a size, try to determine the unit
    numbers = re.findall(r'\d+', s)
    if len(numbers) >= 2:
        max_dim = max(int(numbers[0]), int(numbers[1]))
        unit = "cm" if max_dim < 200 else "mm"
        # Replace any trailing unit and add correct one
        s = re.sub(r'(mm|cm)?$', unit, s)
    
    return s


def format_size_label(size_str: str) -> str:
    """
    Format a normalized size string for display.
    Example: "60x60cm" -> "60 x 60 cm"
    """
    if not size_str:
        return ""
    
    # Extract numbers and unit
    match = re.match(r'^(\d+)x(\d+)(?:x(\d+))?(cm|mm)?$', size_str.lower())
    if match:
        width = match.group(1)
        height = match.group(2)
        thickness = match.group(3)
        unit = match.group(4) or "cm"
        
        if thickness:
            return f"{width} x {height} x {thickness} {unit}"
        else:
            return f"{width} x {height} {unit}"
    
    return size_str


def get_size_sort_key(size_str: str) -> tuple:
    """
    Generate a sort key for size strings to sort them numerically.
    Returns (width, height, thickness) as integers for proper sorting.
    """
    s = normalize_size(size_str)
    # Extract numbers
    numbers = re.findall(r'\d+', s)
    if len(numbers) >= 2:
        width = int(numbers[0])
        height = int(numbers[1])
        thickness = int(numbers[2]) if len(numbers) > 2 else 0
        return (width, height, thickness)
    return (0, 0, 0)


def deduplicate_sizes(sizes: List[str]) -> List[str]:
    """
    Remove duplicate sizes after normalization.
    Returns unique normalized sizes, sorted by dimensions.
    """
    normalized = {}
    for size in sizes:
        norm = normalize_size(size)
        if norm and norm not in normalized:
            normalized[norm] = size  # Keep first occurrence
    
    # Sort by dimensions
    sorted_sizes = sorted(normalized.keys(), key=get_size_sort_key)
    return sorted_sizes


# ============ MODELS ============

class FilterValue(BaseModel):
    value: str
    label: str
    display_order: int = 0
    is_active: bool = True
    image_url: Optional[str] = None  # Image for homepage display (e.g., "Shop by Style")
    show_on_homepage: bool = False  # Show this value in homepage sections


class FilterTypeCreate(BaseModel):
    name: str
    slug: str
    input_type: str  # checkbox, range, dropdown, toggle
    description: Optional[str] = ""
    values: Optional[List[dict]] = []
    is_active: bool = True
    auto_populate: bool = False  # Auto-detect values from products
    auto_populate_field: Optional[str] = None  # Field to auto-populate from
    auto_populate_categories: Optional[List[str]] = []  # Restrict auto-populate to specific categories
    auto_populate_groups: Optional[List[str]] = []  # Restrict auto-populate to specific groups (e.g., "tiles")
    excluded_values: Optional[List[str]] = []  # Values excluded from auto-sync
    # Display flags
    show_in_shop_filter: bool = True  # Show in shop page filter panel
    show_in_bulk_editor: bool = True  # Show in Bulk Category Editor
    show_in_product_detail: bool = False  # Show in product detail specifications
    allow_new_values_in_bulk_editor: bool = False  # Allow users to add new values from Bulk Editor
    # Grouping
    option_category: Optional[str] = "general"  # Category for organization (e.g., "appearance", "technical", "location")


class FilterGroupCreate(BaseModel):
    name: str
    slug: str
    description: Optional[str] = ""
    category_slugs: List[str] = []  # Which categories this applies to (legacy)
    group_slugs: List[str] = []  # Which product groups this applies to (e.g., ["tiles", "flooring"])
    filter_ids: List[str] = []  # Filter types in this group
    is_active: bool = True
    display_order: int = 0


class PageFilterSettings(BaseModel):
    page_slug: str  # e.g., "collections", "all-tiles", "collection-detail"
    enabled_filter_groups: List[str] = []  # Filter group slugs
    auto_detect: bool = True  # Auto-detect based on products
    display_style: str = "sidebar"  # sidebar, drawer, topbar, modal


# ============ FILTER TYPES ENDPOINTS ============

@router.post("/lock-for-staff")
async def lock_filters_for_staff():
    """Disable 'Allow Adding in Bulk Editor' for ALL filters.
    This ensures only admins can add/edit filter values via Navigation & Structure."""
    
    result = await db.filter_types.update_many(
        {},
        {"$set": {"allow_new_values_in_bulk_editor": False}}
    )
    
    return {
        "message": "All filters locked for staff",
        "filters_updated": result.modified_count
    }


@router.get("/homepage-styles")
async def get_homepage_styles():
    """Get filter values that should be displayed on homepage (e.g., Shop by Style section)
    Returns values from any filter type where show_on_homepage=True"""
    
    # Find the Style filter (or any filter with homepage values)
    filters_with_homepage = await db.filter_types.find({
        "values.show_on_homepage": True
    }).to_list(100)
    
    homepage_styles = []
    for filter_doc in filters_with_homepage:
        filter_slug = filter_doc.get("slug", "")
        filter_name = filter_doc.get("name", "")
        
        for value in filter_doc.get("values", []):
            if value.get("show_on_homepage") and value.get("is_active", True):
                homepage_styles.append({
                    "name": value.get("label", value.get("value", "")),
                    "slug": value.get("value", ""),
                    "image": value.get("image_url", ""),
                    "link": f"/shop/tiles?{filter_slug}={value.get('value', '')}",
                    "filter_type": filter_name,
                    "display_order": value.get("display_order", 0)
                })
    
    # Sort by display order (handle None values)
    homepage_styles.sort(key=lambda x: x["display_order"] if x["display_order"] is not None else 999)
    
    return homepage_styles


@router.get("/homepage-styles/all")
async def get_all_styles_for_admin():
    """Get all style filter values for the admin homepage styles editor.
    Returns all values from style-type filters with their homepage status and images."""
    
    style_filters = await db.filter_types.find(
        {"slug": {"$in": ["style", "material", "finish", "colour", "color"]}}
    ).to_list(100)
    
    all_styles = []
    for filter_doc in style_filters:
        filter_id = str(filter_doc["_id"])
        filter_slug = filter_doc.get("slug", "")
        filter_name = filter_doc.get("name", "")
        
        for value in filter_doc.get("values", []):
            if value.get("is_active", True):
                all_styles.append({
                    "filter_id": filter_id,
                    "filter_slug": filter_slug,
                    "filter_name": filter_name,
                    "value": value.get("value", ""),
                    "label": value.get("label", value.get("value", "")),
                    "image_url": value.get("image_url", ""),
                    "show_on_homepage": value.get("show_on_homepage", False),
                    "display_order": value.get("display_order", 0)
                })
    
    all_styles.sort(key=lambda x: (not x["show_on_homepage"], x.get("display_order") or 999, x["label"]))
    return all_styles


@router.patch("/homepage-styles/update-value")
async def update_style_homepage_settings(data: dict):
    """Update a filter value's homepage visibility and image URL."""
    filter_id = data.get("filter_id")
    value_slug = data.get("value")
    image_url = data.get("image_url")
    show_on_homepage = data.get("show_on_homepage")
    
    if not filter_id or not value_slug:
        raise HTTPException(status_code=400, detail="filter_id and value are required")
    
    update_fields = {}
    if image_url is not None:
        update_fields["values.$.image_url"] = image_url
    if show_on_homepage is not None:
        update_fields["values.$.show_on_homepage"] = show_on_homepage
    
    if not update_fields:
        raise HTTPException(status_code=400, detail="No fields to update")
    
    update_fields["updated_at"] = datetime.now(timezone.utc)
    
    result = await db.filter_types.update_one(
        {"_id": ObjectId(filter_id), "values.value": value_slug},
        {"$set": update_fields}
    )
    
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Filter or value not found")
    
    return {"message": "Style updated successfully"}


@router.get("/types")
async def get_filter_types():
    """Get all filter types"""
    filters = await db.filter_types.find({}).sort("name", 1).to_list(100)
    for f in filters:
        f["id"] = str(f.pop("_id"))
    return filters


@router.get("/types/{filter_id}")
async def get_filter_type(filter_id: str):
    """Get single filter type"""
    filter_doc = await db.filter_types.find_one({"_id": ObjectId(filter_id)})
    if not filter_doc:
        raise HTTPException(status_code=404, detail="Filter type not found")
    filter_doc["id"] = str(filter_doc.pop("_id"))
    return filter_doc


@router.post("/types")
async def create_filter_type(filter_type: FilterTypeCreate):
    """Create new filter type"""
    data = filter_type.dict()
    data["created_at"] = datetime.now(timezone.utc)
    data["updated_at"] = datetime.now(timezone.utc)
    
    # Check for duplicate slug
    existing = await db.filter_types.find_one({"slug": data["slug"]})
    if existing:
        raise HTTPException(status_code=400, detail="Filter type with this slug already exists")
    
    result = await db.filter_types.insert_one(data)
    return {"id": str(result.inserted_id), "message": "Filter type created"}


@router.put("/types/{filter_id}")
async def update_filter_type(filter_id: str, filter_type: FilterTypeCreate):
    """Update filter type - MERGES values with existing DB values to prevent sync overwrites.
    Values can only be deleted via the dedicated DELETE endpoint, not via PUT.
    """
    data = filter_type.dict()
    data["updated_at"] = datetime.now(timezone.utc)
    
    # Get the current filter from DB
    current_filter = await db.filter_types.find_one({"_id": ObjectId(filter_id)})
    if not current_filter:
        raise HTTPException(status_code=404, detail="Filter type not found")
    
    existing_values = current_filter.get("values", [])
    incoming_values = data.get("values", [])
    
    if incoming_values:
        # MERGE strategy: 
        # - Keep ALL existing values (preserving metadata like product_groups)
        # - Add any NEW values from incoming that don't exist yet
        # - Update metadata for values that exist in both
        existing_map = {v.get("value"): v for v in existing_values}
        incoming_map = {v.get("value"): v for v in incoming_values}
        
        merged_values = []
        # Keep all existing values, update metadata from incoming if present
        for slug, existing_val in existing_map.items():
            if slug in incoming_map:
                # Merge: incoming updates metadata, but preserve product_groups
                merged = {**existing_val, **incoming_map[slug]}
                if "product_groups" in existing_val and "product_groups" not in incoming_map[slug]:
                    merged["product_groups"] = existing_val["product_groups"]
                merged_values.append(merged)
            else:
                # Value exists in DB but not in incoming — KEEP it (don't delete via PUT)
                merged_values.append(existing_val)
        
        # Add truly new values (in incoming but not in DB)
        for slug, incoming_val in incoming_map.items():
            if slug not in existing_map:
                merged_values.append(incoming_val)
        
        data["values"] = merged_values
    else:
        # No values in the update payload — preserve existing values entirely
        data.pop("values", None)
    
    result = await db.filter_types.update_one(
        {"_id": ObjectId(filter_id)},
        {"$set": data}
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Filter type not found")
    return {"message": "Filter type updated"}


@router.delete("/types/{filter_id}")
async def delete_filter_type(filter_id: str):
    """Delete filter type"""
    result = await db.filter_types.delete_one({"_id": ObjectId(filter_id)})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Filter type not found")
    return {"message": "Filter type deleted"}


@router.post("/types/{filter_id}/values")
async def add_filter_value(filter_id: str, value: FilterValue):
    """Add value to filter type"""
    # First get the filter to know its slug
    filter_type = await db.filter_types.find_one({"_id": ObjectId(filter_id)})
    if not filter_type:
        raise HTTPException(status_code=404, detail="Filter type not found")
    
    await db.filter_types.update_one(
        {"_id": ObjectId(filter_id)},
        {
            "$push": {"values": value.dict()},
            "$set": {"updated_at": datetime.now(timezone.utc)}
        }
    )
    
    # Sync to specification_types if this is a shared attribute
    try:
        from utils.attribute_sync import sync_on_filter_value_add
        sync_result = await sync_on_filter_value_add(db, filter_type["slug"], value.value, value.label)
        logger.info(f"Attribute sync result: {sync_result}")
    except Exception as e:
        logger.warning(f"Failed to sync filter value to specifications: {e}")
    
    return {"message": "Filter value added"}


@router.delete("/types/{filter_id}/values/{value_slug}")
async def delete_filter_value(filter_id: str, value_slug: str, exclude_from_sync: bool = True):
    """Delete a value from filter and optionally exclude it from future syncs"""
    # First get the filter to know its slug
    filter_type = await db.filter_types.find_one({"_id": ObjectId(filter_id)})
    if not filter_type:
        raise HTTPException(status_code=404, detail="Filter type not found")
    
    # Remove the value from the values array
    await db.filter_types.update_one(
        {"_id": ObjectId(filter_id)},
        {
            "$pull": {"values": {"value": value_slug}},
            "$set": {"updated_at": datetime.now(timezone.utc)}
        }
    )
    
    # If exclude_from_sync is True, add to excluded_values list so it doesn't come back
    if exclude_from_sync:
        await db.filter_types.update_one(
            {"_id": ObjectId(filter_id)},
            {"$addToSet": {"excluded_values": value_slug}}
        )
    
    # Sync deletion to specification_types if this is a shared attribute
    try:
        from utils.attribute_sync import sync_on_filter_value_delete
        sync_result = await sync_on_filter_value_delete(db, filter_type["slug"], value_slug)
        logger.info(f"Attribute sync deletion result: {sync_result}")
    except Exception as e:
        logger.warning(f"Failed to sync filter value deletion to specifications: {e}")
    
    return {"message": "Filter value deleted", "excluded_from_sync": exclude_from_sync}


@router.delete("/types/by-slug/{filter_slug}/values/{value_slug}")
async def delete_filter_value_by_slug(filter_slug: str, value_slug: str, exclude_from_sync: bool = True):
    """Delete a value from filter using the filter slug (e.g., 'color', 'material')
    This endpoint is used by the Manage Options modal for syncing deletes."""
    # Find the filter by slug
    filter_type = await db.filter_types.find_one({"slug": filter_slug})
    if not filter_type:
        raise HTTPException(status_code=404, detail=f"Filter type '{filter_slug}' not found")
    
    # Remove the value from the values array
    await db.filter_types.update_one(
        {"slug": filter_slug},
        {
            "$pull": {"values": {"value": value_slug}},
            "$set": {"updated_at": datetime.now(timezone.utc)}
        }
    )
    
    # If exclude_from_sync is True, add to excluded_values list so it doesn't come back
    if exclude_from_sync:
        await db.filter_types.update_one(
            {"slug": filter_slug},
            {"$addToSet": {"excluded_values": value_slug}}
        )
    
    # Sync deletion to specification_types if this is a shared attribute
    try:
        from utils.attribute_sync import sync_on_filter_value_delete
        sync_result = await sync_on_filter_value_delete(db, filter_slug, value_slug)
        logger.info(f"Attribute sync deletion result: {sync_result}")
    except Exception as e:
        logger.warning(f"Failed to sync filter value deletion to specifications: {e}")
    
    return {"message": "Filter value deleted", "excluded_from_sync": exclude_from_sync}



@router.patch("/types/{filter_id}/toggle-type-visibility")
async def toggle_filter_type_visibility(filter_id: str, data: dict):
    """Hide or show an entire filter type for a specific product group.
    Body: {"product_group": "materials", "action": "hide" | "show"}
    
    hidden_groups field on the filter type:
    - [] or missing → visible in ALL groups
    - ["materials", "tools"] → hidden from those groups
    """
    product_group = data.get("product_group")
    action = data.get("action", "hide")
    
    if not product_group:
        raise HTTPException(status_code=400, detail="product_group is required")
    
    filter_type = await db.filter_types.find_one({"_id": ObjectId(filter_id)})
    if not filter_type:
        raise HTTPException(status_code=404, detail="Filter type not found")
    
    hidden_groups = filter_type.get("hidden_groups", [])
    
    if action == "hide":
        if product_group not in hidden_groups:
            hidden_groups.append(product_group)
    elif action == "show":
        hidden_groups = [g for g in hidden_groups if g != product_group]
    
    await db.filter_types.update_one(
        {"_id": ObjectId(filter_id)},
        {"$set": {"hidden_groups": hidden_groups, "updated_at": datetime.now(timezone.utc)}}
    )
    
    return {
        "message": f"Filter '{filter_type.get('name')}' {'hidden from' if action == 'hide' else 'shown in'} {product_group}",
        "hidden_groups": hidden_groups
    }


@router.patch("/types/{filter_id}/toggle-group")
async def toggle_filter_type_group(filter_id: str, data: dict):
    """Add or remove a product group from a filter type's auto_populate_groups.
    Body: {"product_group": "flooring", "action": "add" | "remove"}
    """
    product_group = data.get("product_group")
    action = data.get("action", "add")
    
    if not product_group:
        raise HTTPException(status_code=400, detail="product_group is required")
    
    filter_type = await db.filter_types.find_one({"_id": ObjectId(filter_id)})
    if not filter_type:
        raise HTTPException(status_code=404, detail="Filter type not found")
    
    current_groups = filter_type.get("auto_populate_groups", [])
    
    if action == "add":
        if product_group not in current_groups:
            current_groups.append(product_group)
    elif action == "remove":
        current_groups = [g for g in current_groups if g != product_group]
    
    await db.filter_types.update_one(
        {"_id": ObjectId(filter_id)},
        {"$set": {"auto_populate_groups": current_groups, "updated_at": datetime.now(timezone.utc)}}
    )
    return {
        "message": f"Filter type {'added to' if action == 'add' else 'removed from'} {product_group}",
        "auto_populate_groups": current_groups
    }


@router.post("/types/bulk-assign-group")
async def bulk_assign_filter_type_group(data: dict):
    """Bulk add or remove a product group from multiple filter types at once.
    Body: {"type_ids": ["id1","id2",...], "product_group": "tiles", "action": "add"|"remove"}
    """
    type_ids = data.get("type_ids", [])
    product_group = data.get("product_group")
    action = data.get("action", "add")

    if not type_ids or not product_group:
        raise HTTPException(status_code=400, detail="type_ids and product_group are required")

    updated = 0
    for tid in type_ids:
        try:
            ftype = await db.filter_types.find_one({"_id": ObjectId(tid)})
            if not ftype:
                continue
            current = ftype.get("auto_populate_groups", [])
            if action == "add" and product_group not in current:
                current.append(product_group)
            elif action == "remove":
                current = [g for g in current if g != product_group]
            await db.filter_types.update_one(
                {"_id": ObjectId(tid)},
                {"$set": {"auto_populate_groups": current, "updated_at": datetime.now(timezone.utc)}}
            )
            updated += 1
        except Exception:
            continue

    return {"message": f"{updated} filter types updated", "updated": updated}





@router.patch("/types/{filter_id}/values/{value_slug}/toggle-group")
async def toggle_filter_value_group(filter_id: str, value_slug: str, data: dict):
    """Toggle a product group's visibility for a specific filter value.
    This enables per-group isolation: removing a value from 'Flooring' only hides it there,
    not from other groups like 'Tiles' or 'Bathroom'.
    
    Body: {"product_group": "flooring", "action": "remove" | "add"}
    
    How product_groups works on values:
    - [] or missing → visible in ALL groups (backward compatible)
    - ["tiles", "flooring"] → visible only in those groups
    """
    product_group = data.get("product_group")
    action = data.get("action", "remove")
    
    if not product_group:
        raise HTTPException(status_code=400, detail="product_group is required")
    
    filter_type = await db.filter_types.find_one({"_id": ObjectId(filter_id)})
    if not filter_type:
        raise HTTPException(status_code=404, detail="Filter type not found")
    
    values = filter_type.get("values", [])
    target_value = None
    for v in values:
        if v.get("value") == value_slug:
            target_value = v
            break
    
    if not target_value:
        raise HTTPException(status_code=404, detail=f"Value '{value_slug}' not found")
    
    current_groups = target_value.get("product_groups", [])
    
    if action == "remove":
        if not current_groups:
            # Value was visible everywhere. Now we need to set it to all groups EXCEPT the one being removed.
            # Get all known product groups
            all_groups = await db.category_groups.distinct("slug")
            if not all_groups:
                all_groups = ["tiles", "flooring", "bathroom", "outdoor"]
            current_groups = [g for g in all_groups if g != product_group]
        else:
            current_groups = [g for g in current_groups if g != product_group]
    elif action == "add":
        if product_group not in current_groups:
            current_groups.append(product_group)
        # If all groups are now included, clear the array (means "visible everywhere")
        all_groups = await db.category_groups.distinct("slug")
        if all_groups and set(current_groups) >= set(all_groups):
            current_groups = []
    
    # Update the value's product_groups
    await db.filter_types.update_one(
        {"_id": ObjectId(filter_id), "values.value": value_slug},
        {
            "$set": {
                "values.$.product_groups": current_groups,
                "updated_at": datetime.now(timezone.utc)
            }
        }
    )
    
    return {
        "message": f"Value '{value_slug}' {'removed from' if action == 'remove' else 'added to'} {product_group}",
        "value": value_slug,
        "product_groups": current_groups
    }



@router.post("/types/{filter_id}/clear-values")
async def clear_filter_values(filter_id: str, keep_excluded: bool = True):
    """Clear all values from a filter (useful before re-syncing with new restrictions).
    By default keeps the excluded_values list so previously deleted values don't come back."""
    update_data = {
        "values": [],
        "updated_at": datetime.now(timezone.utc)
    }
    
    if not keep_excluded:
        update_data["excluded_values"] = []
    
    result = await db.filter_types.update_one(
        {"_id": ObjectId(filter_id)},
        {"$set": update_data}
    )
    
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Filter type not found")
    
    return {
        "message": "Filter values cleared",
        "excluded_values_kept": keep_excluded
    }



@router.post("/types/{filter_id}/normalize-sizes")
async def normalize_filter_sizes(filter_id: str):
    """
    Normalize and deduplicate size values in a filter.
    This will:
    1. Standardize format (1000X1000Mm -> 1000x1000mm)
    2. Remove duplicates (1200X1200 and 1200X1200Mm become one entry)
    3. Sort by dimensions (smallest to largest)
    
    Only works on filters with 'size' in the name or slug.
    """
    filter_doc = await db.filter_types.find_one({"_id": ObjectId(filter_id)})
    if not filter_doc:
        raise HTTPException(status_code=404, detail="Filter type not found")
    
    # Verify this is a size filter
    name_lower = (filter_doc.get("name", "") + filter_doc.get("slug", "")).lower()
    if "size" not in name_lower:
        raise HTTPException(status_code=400, detail="This operation is only for size filters")
    
    current_values = filter_doc.get("values", [])
    if not current_values:
        return {"message": "No values to normalize", "changes": 0}
    
    # Track changes
    original_count = len(current_values)
    
    # Normalize and deduplicate
    seen_normalized = {}
    normalized_values = []
    
    for val in current_values:
        original = val.get("value", "")
        normalized = normalize_size(original)
        
        if normalized and normalized not in seen_normalized:
            seen_normalized[normalized] = True
            normalized_values.append({
                "value": normalized,
                "label": format_size_label(normalized),  # Pretty label: "60 x 60 cm" or "600 x 600 mm"
                "is_active": val.get("is_active", True)
            })
    
    # Sort by dimensions
    normalized_values.sort(key=lambda v: get_size_sort_key(v["value"]))
    
    # Update the filter
    await db.filter_types.update_one(
        {"_id": ObjectId(filter_id)},
        {"$set": {
            "values": normalized_values,
            "updated_at": datetime.now(timezone.utc)
        }}
    )
    
    final_count = len(normalized_values)
    duplicates_removed = original_count - final_count
    
    return {
        "message": f"Normalized {final_count} size values",
        "original_count": original_count,
        "final_count": final_count,
        "duplicates_removed": duplicates_removed,
        "sample_values": [v["label"] for v in normalized_values[:10]]
    }


class AddFilterValueRequest(BaseModel):
    value: str
    label: str
    is_active: bool = True
    product_groups: Optional[List[str]] = []


@router.post("/types/{filter_slug}/add-value")
async def add_filter_value_by_slug(filter_slug: str, data: AddFilterValueRequest):
    """
    Add a new value to an existing filter type.
    Used when adding options from Bulk Category Editor to sync with Navigation & Structure.
    """
    # Find the filter type
    filter_type = await db.filter_types.find_one({"slug": filter_slug})
    if not filter_type:
        raise HTTPException(status_code=404, detail=f"Filter type '{filter_slug}' not found")
    
    # Check if value already exists
    existing_values = filter_type.get("values", [])
    for v in existing_values:
        if v.get("value") == data.value:
            return {"message": "Value already exists", "value": data.value}
    
    # Add the new value
    new_value = {
        "value": data.value,
        "label": data.label,
        "is_active": data.is_active
    }
    if data.product_groups:
        new_value["product_groups"] = data.product_groups
    existing_values.append(new_value)
    
    await db.filter_types.update_one(
        {"_id": filter_type["_id"]},
        {"$set": {"values": existing_values, "updated_at": datetime.now(timezone.utc)}}
    )
    
    # Sync to specification_types if this is a shared attribute
    try:
        from utils.attribute_sync import sync_on_filter_value_add
        sync_result = await sync_on_filter_value_add(db, filter_slug, data.value, data.label)
        logger.info(f"Attribute sync result: {sync_result}")
    except Exception as e:
        logger.warning(f"Failed to sync filter value to specifications: {e}")
    
    return {"message": "Value added", "value": data.value, "label": data.label}


@router.post("/normalize-all-sizes")
async def normalize_all_size_filters():
    """
    Normalize all size-related filters in the database.
    Finds all filters with 'size' in name/slug and normalizes their values.
    """
    # Find all size filters
    size_filters = await db.filter_types.find({
        "$or": [
            {"name": {"$regex": "size", "$options": "i"}},
            {"slug": {"$regex": "size", "$options": "i"}}
        ]
    }).to_list(100)
    
    results = []
    total_duplicates = 0
    
    for filter_doc in size_filters:
        filter_id = str(filter_doc["_id"])
        current_values = filter_doc.get("values", [])
        
        if not current_values:
            results.append({
                "filter": filter_doc["name"],
                "status": "skipped",
                "reason": "no values"
            })
            continue
        
        original_count = len(current_values)
        
        # Normalize and deduplicate
        seen_normalized = {}
        normalized_values = []
        
        for val in current_values:
            original = val.get("value", "")
            normalized = normalize_size(original)
            
            if normalized and normalized not in seen_normalized:
                seen_normalized[normalized] = True
                normalized_values.append({
                    "value": normalized,
                    "label": format_size_label(normalized),
                    "is_active": val.get("is_active", True)
                })
        
        # Sort by dimensions
        normalized_values.sort(key=lambda v: get_size_sort_key(v["value"]))
        
        # Update the filter
        await db.filter_types.update_one(
            {"_id": filter_doc["_id"]},
            {"$set": {
                "values": normalized_values,
                "updated_at": datetime.now(timezone.utc)
            }}
        )
        
        final_count = len(normalized_values)
        duplicates = original_count - final_count
        total_duplicates += duplicates
        
        results.append({
            "filter": filter_doc["name"],
            "original_count": original_count,
            "final_count": final_count,
            "duplicates_removed": duplicates
        })
    
    return {
        "message": f"Normalized {len(size_filters)} size filter(s)",
        "total_duplicates_removed": total_duplicates,
        "results": results
    }


@router.put("/types/{filter_id}/restrictions")
async def update_filter_restrictions(filter_id: str, data: dict):
    """Update the category/group restrictions for auto-populate.
    
    Example body:
    {
        "auto_populate_categories": ["Tiles", "Wall Tiles", "Floor Tiles"],
        "auto_populate_groups": ["tiles"]
    }
    """
    update_fields = {}
    
    if "auto_populate_categories" in data:
        update_fields["auto_populate_categories"] = data["auto_populate_categories"]
    
    if "auto_populate_groups" in data:
        update_fields["auto_populate_groups"] = data["auto_populate_groups"]
    
    if "auto_populate" in data:
        update_fields["auto_populate"] = data["auto_populate"]
    
    if "auto_populate_field" in data:
        update_fields["auto_populate_field"] = data["auto_populate_field"]
    
    if not update_fields:
        raise HTTPException(status_code=400, detail="No valid fields to update")
    
    update_fields["updated_at"] = datetime.now(timezone.utc)
    
    result = await db.filter_types.update_one(
        {"_id": ObjectId(filter_id)},
        {"$set": update_fields}
    )
    
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Filter type not found")
    
    return {"message": "Filter restrictions updated", "updated_fields": list(update_fields.keys())}


@router.post("/rebuild-from-live-products")
async def rebuild_filters_from_live_products(filter_name: str = "Size", preserve_manual: bool = True):
    """
    Rebuild a filter's values from live products (tiles collection).
    
    Args:
        filter_name: Name of the filter to rebuild
        preserve_manual: If True, keeps existing values and only ADDS new ones from products.
                        If False, completely replaces all values (destructive).
    """
    from pymongo import MongoClient
    import os
    
    # Get synchronous MongoDB connection for tiles collection
    mongo_url = os.environ.get('MONGO_URL')
    sync_client = MongoClient(mongo_url)
    sync_db = sync_client[os.environ.get('DB_NAME', 'tile_station')]
    
    # Find the filter
    filter_doc = await db.filter_types.find_one({"name": {"$regex": f"^{filter_name}$", "$options": "i"}})
    if not filter_doc:
        raise HTTPException(status_code=404, detail=f"Filter '{filter_name}' not found")
    
    field = filter_doc.get("auto_populate_field", "size")
    filter_id = filter_doc["_id"]
    
    # Get existing values (to preserve manually added ones)
    existing_values = filter_doc.get("values", [])
    existing_value_slugs = {v.get("value", "").lower() for v in existing_values}
    
    # Map field to tiles collection schema
    tiles_field = f"attributes.{field}" if field in ["size", "finish", "color", "material"] else field
    
    # Get distinct values from TILES collection ONLY (live products)
    logger.info(f"Rebuilding {filter_name} filter from tiles collection using field: {tiles_field}")
    
    # Get all distinct values from live tiles
    raw_values = sync_db.tiles.distinct(tiles_field)
    
    # Clean and filter
    clean_values = [str(v).strip() for v in raw_values if v and str(v).strip()]
    
    logger.info(f"Found {len(clean_values)} raw values from tiles collection")
    
    # Check if this is a size filter - apply normalization
    is_size_filter = "size" in filter_name.lower()
    
    if is_size_filter:
        # Normalize and deduplicate sizes
        normalized = deduplicate_sizes(clean_values)
        new_values_from_products = [
            {
                "value": size,
                "label": format_size_label(size),
                "is_active": True
            }
            for size in normalized
        ]
        # Sort by dimensions
        new_values_from_products.sort(key=lambda v: get_size_sort_key(v.get("value", "")))
    else:
        # For non-size filters, just clean up
        seen = set()
        new_values_from_products = []
        for val in clean_values:
            val_lower = val.lower()
            if val_lower not in seen:
                seen.add(val_lower)
                new_values_from_products.append({
                    "value": val_lower.replace(" ", "-"),
                    "label": val.title() if val.islower() else val,
                    "is_active": True
                })
    
    # Get excluded values (keep respecting deletions)
    excluded = filter_doc.get("excluded_values", [])
    excluded_set = {e.lower() for e in excluded}
    
    # Remove excluded values from new values
    if excluded_set:
        new_values_from_products = [v for v in new_values_from_products if v["value"].lower() not in excluded_set]
    
    # Determine final values based on preserve_manual flag
    if preserve_manual:
        # MERGE: Keep existing values, add new ones from products
        new_value_slugs = {v["value"].lower() for v in new_values_from_products}
        
        # Start with all existing values (preserving manual additions)
        final_values = list(existing_values)
        
        # Add only NEW values from products that don't already exist
        added_count = 0
        for new_val in new_values_from_products:
            if new_val["value"].lower() not in existing_value_slugs:
                final_values.append(new_val)
                added_count += 1
        
        message = f"Merged {filter_name} filter: kept {len(existing_values)} existing, added {added_count} new from products"
    else:
        # REPLACE: Completely replace with values from products (old destructive behavior)
        final_values = new_values_from_products
        message = f"Rebuilt {filter_name} filter with {len(final_values)} values from products (replaced all existing)"
    
    old_count = len(existing_values)
    
    await db.filter_types.update_one(
        {"_id": filter_id},
        {"$set": {
            "values": final_values,
            "updated_at": datetime.now(timezone.utc),
            "last_rebuilt_from_live": datetime.now(timezone.utc).isoformat()
        }}
    )
    
    sync_client.close()
    
    return {
        "success": True,
        "message": message,
        "filter": filter_name,
        "old_values_count": old_count,
        "new_values_count": len(final_values),
        "excluded_count": len(excluded_set),
        "preserve_manual": preserve_manual,
        "sample_values": [v["label"] for v in final_values[:15]],
        "source": "tiles collection (live products only)"
    }


@router.post("/rebuild-all-from-live")
async def rebuild_all_filters_from_live():
    """
    Rebuild ALL auto-populate filters from live products only.
    Use this to completely fix the mixed values issue.
    """
    results = []
    
    # Get all auto-populate filters
    filters = await db.filter_types.find({"auto_populate": True}).to_list(100)
    
    for f in filters:
        try:
            result = await rebuild_filters_from_live_products(f["name"])
            results.append(result)
        except Exception as e:
            results.append({
                "filter": f["name"],
                "success": False,
                "error": str(e)
            })
    
    return {
        "message": f"Rebuilt {len(results)} filters from live products",
        "results": results
    }


# ============ FILTER-SPECIFICATION SYNC ============

@router.post("/sync-with-specifications")
async def sync_filters_with_specifications(attribute: Optional[str] = None):
    """
    Synchronize values between filter_types and specification_types for shared attributes.
    
    Shared attributes: color, material, finish, size
    
    Args:
        attribute: Optional specific attribute to sync (e.g., 'color'). 
                   If not provided, syncs all shared attributes.
    
    This ensures that when a value is added to Filters, it also appears in Specifications,
    and vice versa. Useful for keeping both admin sections in sync.
    """
    from utils.attribute_sync import sync_attribute_values, sync_all_shared_attributes, SHARED_ATTRIBUTES
    
    if attribute:
        if attribute not in SHARED_ATTRIBUTES:
            raise HTTPException(
                status_code=400, 
                detail=f"'{attribute}' is not a shared attribute. Valid options: {list(SHARED_ATTRIBUTES.keys())}"
            )
        result = await sync_attribute_values(db, attribute)
    else:
        result = await sync_all_shared_attributes(db)
    
    return result


@router.get("/sync-status")
async def get_filter_spec_sync_status():
    """
    Get the current sync status between filter_types and specification_types.
    Shows which values exist in filters but not specs, and vice versa.
    """
    from utils.attribute_sync import SHARED_ATTRIBUTES
    
    status = []
    
    for attr_slug, mapping in SHARED_ATTRIBUTES.items():
        filter_type = await db.filter_types.find_one({"slug": mapping["filter_slug"]})
        spec_type = await db.specification_types.find_one({"slug": mapping["spec_slug"]})
        
        filter_values = set()
        if filter_type:
            for v in filter_type.get("values", []):
                filter_values.add(v.get("value", "").lower())
        
        spec_values = set()
        if spec_type:
            for v in spec_type.get("values", []):
                spec_values.add(v.get("value", "").lower())
        
        only_in_filters = filter_values - spec_values
        only_in_specs = spec_values - filter_values
        
        status.append({
            "attribute": attr_slug,
            "filter_slug": mapping["filter_slug"],
            "spec_slug": mapping["spec_slug"],
            "filter_count": len(filter_values),
            "spec_count": len(spec_values),
            "in_sync": len(only_in_filters) == 0 and len(only_in_specs) == 0,
            "only_in_filters": list(only_in_filters)[:10],  # Limit to first 10
            "only_in_specs": list(only_in_specs)[:10],
            "filter_missing_count": len(only_in_specs),
            "spec_missing_count": len(only_in_filters)
        })
    
    all_in_sync = all(s["in_sync"] for s in status)
    
    return {
        "all_in_sync": all_in_sync,
        "shared_attributes": status
    }

@router.get("/groups")
async def get_filter_groups():
    """Get all filter groups"""
    groups = await db.filter_groups.find({}).sort("display_order", 1).to_list(100)
    for g in groups:
        g["id"] = str(g.pop("_id"))
    return groups


@router.get("/groups/{group_id}")
async def get_filter_group(group_id: str):
    """Get single filter group with populated filters"""
    group = await db.filter_groups.find_one({"_id": ObjectId(group_id)})
    if not group:
        raise HTTPException(status_code=404, detail="Filter group not found")
    
    group["id"] = str(group.pop("_id"))
    
    # Populate filter types
    if group.get("filter_ids"):
        filters = []
        for fid in group["filter_ids"]:
            try:
                f = await db.filter_types.find_one({"_id": ObjectId(fid)})
                if f:
                    f["id"] = str(f.pop("_id"))
                    filters.append(f)
            except:
                pass
        group["filters"] = filters
    
    return group


@router.post("/groups")
async def create_filter_group(group: FilterGroupCreate):
    """Create new filter group"""
    data = group.dict()
    data["created_at"] = datetime.now(timezone.utc)
    data["updated_at"] = datetime.now(timezone.utc)
    
    existing = await db.filter_groups.find_one({"slug": data["slug"]})
    if existing:
        raise HTTPException(status_code=400, detail="Filter group with this slug already exists")
    
    result = await db.filter_groups.insert_one(data)
    return {"id": str(result.inserted_id), "message": "Filter group created"}


@router.put("/groups/{group_id}")
async def update_filter_group(group_id: str, group: FilterGroupCreate):
    """Update filter group"""
    data = group.dict()
    data["updated_at"] = datetime.now(timezone.utc)
    
    result = await db.filter_groups.update_one(
        {"_id": ObjectId(group_id)},
        {"$set": data}
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Filter group not found")
    return {"message": "Filter group updated"}


@router.delete("/groups/{group_id}")
async def delete_filter_group(group_id: str):
    """Delete filter group"""
    result = await db.filter_groups.delete_one({"_id": ObjectId(group_id)})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Filter group not found")
    return {"message": "Filter group deleted"}


# ============ PAGE SETTINGS ENDPOINTS ============

@router.get("/page-settings")
async def get_all_page_settings():
    """Get filter settings for all pages"""
    settings = await db.filter_page_settings.find({}).to_list(100)
    for s in settings:
        s["id"] = str(s.pop("_id"))
    return settings


@router.get("/page-settings/{page_slug}")
async def get_page_filter_settings(page_slug: str):
    """Get filter settings for specific page"""
    settings = await db.filter_page_settings.find_one({"page_slug": page_slug})
    if not settings:
        # Return default settings
        return {
            "page_slug": page_slug,
            "enabled_filter_groups": [],
            "auto_detect": True,
            "display_style": "sidebar"
        }
    settings["id"] = str(settings.pop("_id"))
    return settings


@router.put("/page-settings/{page_slug}")
async def update_page_filter_settings(page_slug: str, settings: PageFilterSettings):
    """Update filter settings for page"""
    data = settings.dict()
    data["updated_at"] = datetime.now(timezone.utc)
    
    result = await db.filter_page_settings.update_one(
        {"page_slug": page_slug},
        {"$set": data, "$setOnInsert": {"created_at": datetime.now(timezone.utc)}},
        upsert=True
    )
    return {"message": "Page filter settings updated"}


# ============ PUBLIC ENDPOINTS (for frontend) ============

@router.get("/for-page/{page_slug}")
async def get_filters_for_page(
    page_slug: str, 
    category: Optional[str] = None,
    group: Optional[str] = None,
    source: Optional[str] = "tiles"  # "tiles" for live products, "supplier_products" for all
):
    """
    Get filters to display on a specific page.
    
    - source="tiles" (default): Only shows filter values from LIVE products (tiles collection)
    - source="supplier_products": Shows values from ALL products (admin use)
    
    If category is provided, returns filters for that category.
    If group is provided, filters values to only include values from products in that group.
    """
    # Get page settings
    page_settings = await db.filter_page_settings.find_one({"page_slug": page_slug})
    
    # Determine which collection to query
    # "tiles" = live products on the website
    # "supplier_products" = all products in the system
    product_collection = db.tiles if source == "tiles" else db.supplier_products
    
    # Build a product query to determine which values to show
    product_query = {}
    
    # Map filter fields to the correct field names in the tiles collection
    # tiles collection uses "attributes.size", "attributes.finish", etc.
    field_mapping = {
        "size": "attributes.size" if source == "tiles" else "size",
        "finish": "attributes.finish" if source == "tiles" else "finish",
        "color": "attributes.color" if source == "tiles" else "color",
        "material": "attributes.material" if source == "tiles" else "material",
    }
    
    # If group is specified (e.g., "tiles"), filter products by product_group field
    # The tiles collection has a direct product_group field (tiles, flooring, materials, etc.)
    if group:
        if source == "tiles":
            # Match product_group OR main_category (supports both old and new data)
            # Aligns with how /api/tiles/collections filters by group
            group_regex = group.replace("-", "[ -]?")
            product_query["$or"] = [
                {"product_group": group},
                {"product_group": {"$regex": group_regex, "$options": "i"}},
                {"main_category": {"$regex": group_regex, "$options": "i"}},
            ]
        else:
            # For supplier_products, try category-based group filtering
            group_cats = await db.website_categories.find(
                {"group_slug": group},
                {"name": 1}
            ).to_list(1000)
            group_category_names = [c["name"] for c in group_cats]
            if group_category_names:
                product_query["category"] = {"$in": group_category_names}
    
    # If category is specified WITHOUT a group, scope by category
    # When group IS provided, we keep the group-level query so all categories
    # in the same group show consistent filter values
    if category and not group:
        # Look up actual category name from website_categories
        cat_doc = await db.website_categories.find_one({"slug": category}, {"name": 1, "_id": 0})
        actual_cat_name = cat_doc["name"] if cat_doc else None
        cat_search = category.replace("-", " ")
        cat_search_regex = cat_search.replace(" and ", "( and | & | & )")
        
        cat_match_conditions = [
            {"sub_categories": {"$regex": cat_search_regex, "$options": "i"}},
            {"category": {"$regex": cat_search, "$options": "i"}},
        ]
        if actual_cat_name:
            cat_match_conditions.insert(0, {"sub_categories": actual_cat_name})
            cat_match_conditions.append({"category": actual_cat_name})
        
        product_query["$or"] = cat_match_conditions
    
    filter_groups = []
    
    if group:
        # When group is provided, match filter groups by:
        # 1. group_slugs field (direct group assignment — future-proof for new categories)
        # 2. category_slugs matching any category in this group (legacy support)
        # 3. Empty category_slugs AND empty group_slugs (applies to all)
        group_categories = await db.website_categories.find(
            {"group_slug": group}, {"slug": 1, "_id": 0}
        ).to_list(1000)
        group_cat_slugs = [c["slug"] for c in group_categories if c.get("slug")]
        if category and category not in group_cat_slugs:
            group_cat_slugs.append(category)
        
        match_conditions = [
            {"group_slugs": group},  # Direct group-level assignment
            {"category_slugs": {"$size": 0}, "group_slugs": {"$exists": False}},  # Applies to all (legacy)
            {"category_slugs": {"$size": 0}, "group_slugs": {"$size": 0}},  # Applies to all
        ]
        if group_cat_slugs:
            match_conditions.append({"category_slugs": {"$in": group_cat_slugs}})  # Category-level match
        
        groups = await db.filter_groups.find({
            "is_active": True,
            "$or": match_conditions
        }).sort("display_order", 1).to_list(100)
        filter_groups = groups
        
        # If no dedicated filter group exists for this product group,
        # build a virtual one from filter types scoped to this group
        if not filter_groups and group:
            # Find filter types that belong to this group or are unscoped
            filter_types = await db.filter_types.find({
                "is_active": True,
                "$or": [
                    {"auto_populate_groups": group},
                    {"auto_populate_groups": {"$size": 0}},
                    {"auto_populate_groups": {"$exists": False}}
                ]
            }).sort("display_order", 1).to_list(100)
            
            if filter_types:
                # Build virtual filter group with only values from products in this group
                virtual_filters = []
                for ft in filter_types:
                    ft_id = str(ft["_id"])
                    ft_values = ft.get("values", [])
                    active_values = [{"value": v.get("value",""), "label": v.get("label",""), "is_active": True} for v in ft_values if v.get("is_active", True)]
                    if active_values:
                        virtual_filters.append({
                            "id": ft_id,
                            "name": ft.get("name", ""),
                            "slug": ft.get("slug", ""),
                            "type": ft.get("type", "multi-select"),
                            "values": active_values,
                            "display_order": ft.get("display_order", 0)
                        })
                
                if virtual_filters:
                    group_name = group.replace("-", " ").title()
                    filter_groups = [{
                        "id": f"virtual_{group}",
                        "name": group_name,
                        "slug": group,
                        "is_active": True,
                        "filters": virtual_filters,
                        "_virtual": True
                    }]
    elif category:
        # Get filter groups that apply to this specific category only
        groups = await db.filter_groups.find({
            "is_active": True,
            "$or": [
                {"category_slugs": category},
                {"category_slugs": {"$size": 0}}  # Groups that apply to all
            ]
        }).sort("display_order", 1).to_list(100)
        filter_groups = groups
    elif page_settings and page_settings.get("enabled_filter_groups"):
        # Get specifically enabled groups
        groups = await db.filter_groups.find({
            "slug": {"$in": page_settings["enabled_filter_groups"]},
            "is_active": True
        }).sort("display_order", 1).to_list(100)
        filter_groups = groups
    else:
        # Get all active groups
        groups = await db.filter_groups.find({"is_active": True}).sort("display_order", 1).to_list(100)
        filter_groups = groups
    
    # Populate filter types for each group
    result = []
    for fg in filter_groups:
        # Virtual groups already have filters populated
        if fg.get("_virtual"):
            result.append(fg)
            continue
            
        fg["id"] = str(fg.pop("_id"))
        
        # Get filter types
        filters = []
        for fid in fg.get("filter_ids", []):
            try:
                f = await db.filter_types.find_one({"_id": ObjectId(fid), "is_active": True})
                if f:
                    f["id"] = str(f.pop("_id"))
                    
                    # For non-auto-populated filters with a known field, 
                    # filter manual values to only show values that exist in the group's products
                    filter_field_slug = f.get("slug", "")
                    if not f.get("auto_populate") and group and product_query and filter_field_slug in field_mapping:
                        actual_field = field_mapping.get(filter_field_slug, filter_field_slug)
                        pipeline = [
                            {"$match": product_query},
                            {"$group": {"_id": f"${actual_field}"}},
                            {"$match": {"_id": {"$ne": None, "$ne": ""}}}
                        ]
                        results = await product_collection.aggregate(pipeline).to_list(5000)
                        existing_in_group = {str(r["_id"]).lower() for r in results if r["_id"]}
                        if existing_in_group:
                            f["values"] = [v for v in f.get("values", []) if v.get("value", "").lower() in existing_in_group]
                        else:
                            f["values"] = []
                    
                    # Auto-populate values if configured - respect group/category restrictions
                    if f.get("auto_populate") and f.get("auto_populate_field"):
                        field = f["auto_populate_field"]
                        
                        # Map field to correct collection schema
                        # tiles collection uses "attributes.size", supplier_products uses "size"
                        actual_field = field_mapping.get(field, field)
                        
                        # PRIORITY 1: Use page-level query (group/category from URL params)
                        # This ensures sidebar only shows values relevant to current page
                        is_group_scoped = False
                        if product_query:
                            query = product_query.copy()
                            is_group_scoped = bool(group)
                        else:
                            # PRIORITY 2: Use filter-level restrictions
                            query = {}
                            restrict_groups = f.get("auto_populate_groups", [])
                            restrict_categories = f.get("auto_populate_categories", [])
                            
                            if restrict_categories:
                                query["category"] = {"$in": restrict_categories}
                            
                            if restrict_groups:
                                # Get all categories that belong to these groups
                                group_categories = []
                                for group_slug in restrict_groups:
                                    cats = await db.website_categories.find(
                                        {"group_slug": group_slug},
                                        {"name": 1}
                                    ).to_list(1000)
                                    group_categories.extend([c["name"] for c in cats])
                                
                                if group_categories:
                                    if "category" in query:
                                        existing_cats = query["category"].get("$in", [])
                                        combined_cats = list(set(existing_cats + group_categories))
                                        query["category"] = {"$in": combined_cats}
                                    else:
                                        query["category"] = {"$in": group_categories}
                        
                        # Get distinct values from the CORRECT collection (tiles = live products)
                        if query:
                            pipeline = [
                                {"$match": query},
                                {"$group": {"_id": f"${actual_field}"}},
                                {"$match": {"_id": {"$ne": None, "$ne": ""}}}
                            ]
                            results = await product_collection.aggregate(pipeline).to_list(5000)
                            values = [r["_id"] for r in results if r["_id"]]
                        else:
                            # No restrictions - get all from the appropriate collection
                            values = await product_collection.distinct(actual_field)
                        
                        # Check if this is a size filter - normalize values
                        filter_name_lower = f.get("name", "").lower()
                        is_size_filter = "size" in filter_name_lower or field == "size"
                        
                        if is_size_filter:
                            # Normalize and deduplicate sizes
                            normalized_sizes = deduplicate_sizes([str(v) for v in values if v])
                            auto_values = [
                                {
                                    "value": size,
                                    "label": format_size_label(size),
                                    "is_active": True
                                }
                                for size in normalized_sizes
                            ]
                        else:
                            auto_values = [
                                {"value": str(v), "label": str(v), "is_active": True}
                                for v in values if v and str(v).strip()
                            ]
                        
                        if is_group_scoped:
                            # When filtered by product group, ONLY show values that exist
                            # in that group's products — replace manual values entirely
                            auto_value_set = {av["value"] for av in auto_values}
                            # Keep manual values that match, add new auto values
                            matched_manual = [v for v in f.get("values", []) if v["value"] in auto_value_set]
                            for av in auto_values:
                                if av["value"] not in {v["value"] for v in matched_manual}:
                                    matched_manual.append(av)
                            f["values"] = matched_manual
                        else:
                            # No group scope — merge auto values with manual values
                            existing_values = {v["value"] for v in f.get("values", [])}
                            for av in auto_values:
                                if av["value"] not in existing_values:
                                    f["values"].append(av)
                        
                        # Sort size filters by dimensions
                        if is_size_filter:
                            f["values"].sort(key=lambda v: get_size_sort_key(v.get("value", "")))
                    
                    # Only include filters that have values to show
                    if f.get("values") or f.get("input_type") in ("toggle", "range"):
                        filters.append(f)
            except Exception as e:
                logger.warning(f"Error loading filter {fid}: {e}")
        
        fg["filters"] = filters
        # Only include groups that have at least one filter with values
        if filters:
            result.append(fg)
    
    # ---- Per-option collection counts ----
    # "How many storefront cards will I see if I tick this?" — counts with the
    # SAME matching rules the collections endpoint uses (digit-bounded regex
    # for sizes, case-insensitive substring for colour/finish/material) and the
    # SAME series grouping the storefront renders.
    try:
        if result and source == "tiles":
            docs = await product_collection.find(
                product_query,
                {"_id": 0, "series": 1, "original_series": 1, "display_name": 1, "name": 1,
                 "size": 1, "finish": 1, "color": 1, "material": 1, "attributes": 1},
            ).to_list(20000)

            countable_fields = {"size", "finish", "color", "material"}

            def _field_strings(p, base_field):
                attrs = p.get("attributes") or {}
                out = []
                for raw in (p.get(base_field), attrs.get(base_field)):
                    if isinstance(raw, list):
                        out.extend([str(x) for x in raw if x])
                    elif raw:
                        out.append(str(raw))
                return out

            # base field -> list of (group_key, [strings])
            rows_by_field = {}
            needed = set()
            for fg2 in result:
                for f2 in fg2.get("filters", []):
                    base = f2.get("slug") if f2.get("slug") in countable_fields else f2.get("auto_populate_field")
                    if base in countable_fields:
                        needed.add(base)
            if needed and docs:
                for base in needed:
                    rows = []
                    for p in docs:
                        strings = _field_strings(p, base)
                        if strings:
                            rows.append((product_group_key(p), strings))
                    rows_by_field[base] = rows

                count_cache = {}

                def _option_count(base, value):
                    key = (base, value.lower())
                    if key in count_cache:
                        return count_cache[key]
                    if base == "size":
                        rx = re.compile(rf"(?<![0-9]){re.escape(value)}(?![0-9])", re.IGNORECASE)
                        match = lambda s: bool(rx.search(s))
                    else:
                        low = value.lower()
                        match = lambda s: low in s.lower()
                    groups = {gk for gk, strings in rows_by_field.get(base, []) if any(match(s) for s in strings)}
                    count_cache[key] = len(groups)
                    return count_cache[key]

                for fg2 in result:
                    for f2 in fg2.get("filters", []):
                        base = f2.get("slug") if f2.get("slug") in countable_fields else f2.get("auto_populate_field")
                        if base not in countable_fields:
                            continue
                        for v in f2.get("values", []):
                            val = str(v.get("value", "")).strip()
                            if val:
                                v["count"] = _option_count(base, val)
    except Exception as e:
        logger.warning(f"Filter collection counts skipped: {e}")

    return {
        "page_slug": page_slug,
        "display_style": page_settings.get("display_style", "sidebar") if page_settings else "sidebar",
        "filter_groups": result
    }


@router.get("/values/{field_name}")
async def get_distinct_filter_values(field_name: str):
    """Get distinct values for a field from products (for auto-population)"""
    values = await db.supplier_products.distinct(field_name)
    # Filter out empty values and sort
    clean_values = sorted([str(v) for v in values if v and str(v).strip()])
    return {"field": field_name, "values": clean_values}



@router.post("/sync-values-from-products")
async def sync_filter_values_from_products():
    """Sync filter values from product data for all auto-populate filters.
    Respects category and group restrictions to prevent mixing filter values."""
    from datetime import datetime, timezone
    
    total_new_values = 0
    synced_filters = []
    skipped_filters = []
    
    # Get all filters with auto_populate enabled
    filters = await db.filter_types.find({"auto_populate": True}).to_list(100)
    
    for filter_doc in filters:
        field = filter_doc.get("auto_populate_field")
        if not field:
            continue
        
        # Build query with category/group restrictions
        query = {}
        restriction_info = []
        
        # Get category restrictions
        restrict_categories = filter_doc.get("auto_populate_categories", [])
        restrict_groups = filter_doc.get("auto_populate_groups", [])
        
        if restrict_categories:
            # Filter by specific categories
            query["category"] = {"$in": restrict_categories}
            restriction_info.append(f"categories: {restrict_categories}")
        
        if restrict_groups:
            # Filter by group_slug field (if products have it) or category group mapping
            # First, get all categories that belong to these groups
            group_categories = []
            for group_slug in restrict_groups:
                cats = await db.website_categories.find(
                    {"group_slug": group_slug},
                    {"name": 1}
                ).to_list(1000)
                group_categories.extend([c["name"] for c in cats])
            
            if group_categories:
                if "category" in query:
                    # Combine with existing category restriction
                    existing_cats = query["category"].get("$in", [])
                    combined_cats = list(set(existing_cats + group_categories))
                    query["category"] = {"$in": combined_cats}
                else:
                    query["category"] = {"$in": group_categories}
                restriction_info.append(f"groups: {restrict_groups}")
        
        # Get distinct values from products with restrictions
        if query:
            # Use aggregation pipeline for filtered distinct
            pipeline = [
                {"$match": query},
                {"$group": {"_id": f"${field}"}},
                {"$match": {"_id": {"$ne": None, "$ne": ""}}}
            ]
            results = await db.supplier_products.aggregate(pipeline).to_list(5000)
            product_values = [r["_id"] for r in results if r["_id"]]
            logger.info(f"Filter '{filter_doc['name']}': Found {len(product_values)} values with restrictions {restriction_info}")
        else:
            # No restrictions - get all (original behavior, but log warning)
            product_values = await db.supplier_products.distinct(field)
            logger.warning(f"Filter '{filter_doc['name']}': No category/group restrictions - pulling from ALL products")
        
        clean_values = [str(v).strip() for v in product_values if v and str(v).strip()]
        
        # Check if this is a size filter - apply normalization
        filter_name_lower = filter_doc.get("name", "").lower()
        is_size_filter = "size" in filter_name_lower or field == "size"
        
        if is_size_filter:
            # Normalize sizes
            clean_values = deduplicate_sizes(clean_values)
        
        # Get existing values and excluded values
        existing_values_set = set()
        for v in filter_doc.get("values", []):
            val = v.get("value", "").lower()
            existing_values_set.add(val)
            # Also add normalized version for size filters
            if is_size_filter:
                existing_values_set.add(normalize_size(val))
        
        excluded_values = {v.lower() for v in filter_doc.get("excluded_values", [])}
        if is_size_filter:
            # Also normalize excluded values
            excluded_values = excluded_values.union({normalize_size(v) for v in excluded_values})
        
        # Find new values (not already existing AND not excluded)
        new_values = []
        for val in clean_values:
            if is_size_filter:
                val_normalized = normalize_size(val)
                label = format_size_label(val_normalized)
            else:
                val_normalized = val.lower().replace(" ", "-")
                label = val.title() if val.islower() else val
            
            if val_normalized not in existing_values_set and val_normalized not in excluded_values:
                new_values.append({
                    "value": val_normalized,
                    "label": label,
                    "is_active": True
                })
                # Add to set to prevent duplicates within this batch
                existing_values_set.add(val_normalized)
        
        if new_values:
            # Update filter with new values
            all_values = filter_doc.get("values", []) + new_values
            await db.filter_types.update_one(
                {"_id": filter_doc["_id"]},
                {"$set": {
                    "values": all_values,
                    "last_synced": datetime.now(timezone.utc).isoformat()
                }}
            )
            total_new_values += len(new_values)
            synced_filters.append({
                "filter": filter_doc["name"],
                "new_values_count": len(new_values),
                "new_values": [v["label"] for v in new_values[:10]],
                "restrictions": restriction_info or ["none - all products"]
            })
        else:
            skipped_filters.append({
                "filter": filter_doc["name"],
                "reason": "No new values found",
                "restrictions": restriction_info or ["none - all products"]
            })
    
    return {
        "success": True,
        "message": f"Synced {total_new_values} new values across {len(synced_filters)} filters",
        "total_new_values": total_new_values,
        "synced_filters": synced_filters,
        "skipped_filters": skipped_filters
    }



# ============ SEED DEFAULT FILTERS ============

@router.post("/seed-defaults")
async def seed_default_filters():
    """Create default filter types and groups for tiles"""
    
    # Check if already seeded
    existing = await db.filter_types.count_documents({})
    if existing > 0:
        return {"message": "Filters already exist", "skipped": True}
    
    # Default filter types
    default_filters = [
        {
            "name": "Size",
            "slug": "size",
            "input_type": "checkbox",
            "description": "Filter by tile dimensions",
            "auto_populate": True,
            "auto_populate_field": "size",
            "values": [],
            "is_active": True
        },
        {
            "name": "Color",
            "slug": "color",
            "input_type": "checkbox",
            "description": "Filter by tile color",
            "auto_populate": True,
            "auto_populate_field": "colour",
            "values": [
                {"value": "white", "label": "White", "display_order": 1, "is_active": True},
                {"value": "grey", "label": "Grey", "display_order": 2, "is_active": True},
                {"value": "beige", "label": "Beige", "display_order": 3, "is_active": True},
                {"value": "black", "label": "Black", "display_order": 4, "is_active": True},
                {"value": "brown", "label": "Brown", "display_order": 5, "is_active": True},
                {"value": "blue", "label": "Blue", "display_order": 6, "is_active": True},
                {"value": "green", "label": "Green", "display_order": 7, "is_active": True}
            ],
            "is_active": True
        },
        {
            "name": "Finish",
            "slug": "finish",
            "input_type": "checkbox",
            "description": "Filter by surface finish",
            "auto_populate": True,
            "auto_populate_field": "finish",
            "values": [
                {"value": "matt", "label": "Matt", "display_order": 1, "is_active": True},
                {"value": "polished", "label": "Polished", "display_order": 2, "is_active": True},
                {"value": "gloss", "label": "Gloss", "display_order": 3, "is_active": True},
                {"value": "textured", "label": "Textured", "display_order": 4, "is_active": True},
                {"value": "satin", "label": "Satin", "display_order": 5, "is_active": True}
            ],
            "is_active": True
        },
        {
            "name": "Material",
            "slug": "material",
            "input_type": "checkbox",
            "description": "Filter by material type",
            "auto_populate": True,
            "auto_populate_field": "material",
            "values": [
                {"value": "porcelain", "label": "Porcelain", "display_order": 1, "is_active": True},
                {"value": "ceramic", "label": "Ceramic", "display_order": 2, "is_active": True},
                {"value": "natural-stone", "label": "Natural Stone", "display_order": 3, "is_active": True},
                {"value": "marble", "label": "Marble", "display_order": 4, "is_active": True},
                {"value": "travertine", "label": "Travertine", "display_order": 5, "is_active": True}
            ],
            "is_active": True
        },
        {
            "name": "Room Suitability",
            "slug": "room",
            "input_type": "checkbox",
            "description": "Filter by room suitability",
            "auto_populate": False,
            "values": [
                {"value": "bathroom", "label": "Bathroom", "display_order": 1, "is_active": True},
                {"value": "kitchen", "label": "Kitchen", "display_order": 2, "is_active": True},
                {"value": "living-room", "label": "Living Room", "display_order": 3, "is_active": True},
                {"value": "bedroom", "label": "Bedroom", "display_order": 4, "is_active": True},
                {"value": "outdoor", "label": "Outdoor", "display_order": 5, "is_active": True},
                {"value": "commercial", "label": "Commercial", "display_order": 6, "is_active": True}
            ],
            "is_active": True
        },
        {
            "name": "Price Range",
            "slug": "price",
            "input_type": "range",
            "description": "Filter by price per m²",
            "auto_populate": False,
            "values": [
                {"value": "min", "label": "0", "display_order": 1, "is_active": True},
                {"value": "max", "label": "200", "display_order": 2, "is_active": True}
            ],
            "is_active": True
        },
        {
            "name": "In Stock",
            "slug": "in-stock",
            "input_type": "toggle",
            "description": "Show only in-stock products",
            "auto_populate": False,
            "values": [],
            "is_active": True
        }
    ]
    
    # Insert filter types
    filter_ids = []
    for f in default_filters:
        f["created_at"] = datetime.now(timezone.utc)
        f["updated_at"] = datetime.now(timezone.utc)
        result = await db.filter_types.insert_one(f)
        filter_ids.append(str(result.inserted_id))
    
    # Create Tiles filter group
    tiles_group = {
        "name": "Tiles",
        "slug": "tiles",
        "description": "Filters for tile products",
        "category_slugs": ["wall-tiles", "floor-tiles", "wall-floor-tiles", "mosaic-tiles", "outdoor-tiles", "bathroom-tiles", "kitchen-tiles"],
        "filter_ids": filter_ids,
        "is_active": True,
        "display_order": 1,
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc)
    }
    await db.filter_groups.insert_one(tiles_group)
    
    # Create default page settings
    pages = ["collections", "collection-detail", "all-tiles", "search"]
    for page in pages:
        await db.filter_page_settings.update_one(
            {"page_slug": page},
            {
                "$set": {
                    "page_slug": page,
                    "enabled_filter_groups": ["tiles"],
                    "auto_detect": True,
                    "display_style": "sidebar",
                    "updated_at": datetime.now(timezone.utc)
                },
                "$setOnInsert": {"created_at": datetime.now(timezone.utc)}
            },
            upsert=True
        )
    
    return {
        "message": "Default filters created",
        "filter_types": len(filter_ids),
        "filter_groups": 1,
        "page_settings": len(pages)
    }


@router.post("/seed-all-product-options")
async def seed_all_product_options():
    """
    Seed ALL filter types needed for both Navigation & Structure AND Bulk Category Editor.
    This creates a unified system where both places use the same data source.
    """
    
    # Define all product option types that need to exist
    all_option_types = [
        # === PRODUCT ATTRIBUTES ===
        {
            "name": "Material",
            "slug": "material",
            "input_type": "checkbox",
            "description": "Tile material (Porcelain, Ceramic, etc.)",
            "auto_populate": True,
            "auto_populate_field": "material",
            "show_in_shop_filter": True,
            "show_in_bulk_editor": True,
            "show_in_product_detail": True,
            "option_category": "attributes",
            "values": [
                {"value": "porcelain", "label": "Porcelain", "is_active": True},
                {"value": "ceramic", "label": "Ceramic", "is_active": True},
                {"value": "natural-stone", "label": "Natural Stone", "is_active": True},
                {"value": "marble", "label": "Marble", "is_active": True},
                {"value": "travertine", "label": "Travertine", "is_active": True},
                {"value": "slate", "label": "Slate", "is_active": True},
                {"value": "limestone", "label": "Limestone", "is_active": True},
                {"value": "granite", "label": "Granite", "is_active": True},
                {"value": "glass", "label": "Glass", "is_active": True},
                {"value": "terracotta", "label": "Terracotta", "is_active": True},
                {"value": "quarry", "label": "Quarry", "is_active": True},
                {"value": "encaustic", "label": "Encaustic", "is_active": True},
            ]
        },
        {
            "name": "Finish",
            "slug": "finish",
            "input_type": "checkbox",
            "description": "Surface finish (Matt, Gloss, Polished, etc.)",
            "auto_populate": True,
            "auto_populate_field": "finish",
            "show_in_shop_filter": True,
            "show_in_bulk_editor": True,
            "show_in_product_detail": True,
            "option_category": "appearance",
            "values": [
                {"value": "matt", "label": "Matt", "is_active": True},
                {"value": "gloss", "label": "Gloss", "is_active": True},
                {"value": "polished", "label": "Polished", "is_active": True},
                {"value": "satin", "label": "Satin", "is_active": True},
                {"value": "textured", "label": "Textured", "is_active": True},
                {"value": "honed", "label": "Honed", "is_active": True},
                {"value": "brushed", "label": "Brushed", "is_active": True},
                {"value": "semi-polish", "label": "Semi Polish (Sugar)", "is_active": True},
                {"value": "lappato", "label": "Lappato", "is_active": True},
                {"value": "structured", "label": "Structured", "is_active": True},
            ]
        },
        {
            "name": "Size",
            "slug": "size",
            "input_type": "checkbox",
            "description": "Tile dimensions",
            "auto_populate": True,
            "auto_populate_field": "size",
            "show_in_shop_filter": True,
            "show_in_bulk_editor": True,
            "show_in_product_detail": True,
            "option_category": "dimensions",
            "values": []  # Auto-populated from products
        },
        {
            "name": "Color",
            "slug": "color",
            "input_type": "checkbox",
            "description": "Tile color",
            "auto_populate": True,
            "auto_populate_field": "color",
            "show_in_shop_filter": True,
            "show_in_bulk_editor": True,
            "show_in_product_detail": True,
            "option_category": "appearance",
            "values": [
                {"value": "white", "label": "White", "is_active": True},
                {"value": "grey", "label": "Grey", "is_active": True},
                {"value": "black", "label": "Black", "is_active": True},
                {"value": "beige", "label": "Beige", "is_active": True},
                {"value": "cream", "label": "Cream", "is_active": True},
                {"value": "brown", "label": "Brown", "is_active": True},
                {"value": "blue", "label": "Blue", "is_active": True},
                {"value": "green", "label": "Green", "is_active": True},
                {"value": "pink", "label": "Pink", "is_active": True},
                {"value": "gold", "label": "Gold", "is_active": True},
                {"value": "silver", "label": "Silver", "is_active": True},
                {"value": "ivory", "label": "Ivory", "is_active": True},
                {"value": "sand", "label": "Sand", "is_active": True},
                {"value": "taupe", "label": "Taupe", "is_active": True},
                {"value": "anthracite", "label": "Anthracite", "is_active": True},
                {"value": "terracotta", "label": "Terracotta", "is_active": True},
                {"value": "red", "label": "Red", "is_active": True},
                {"value": "yellow", "label": "Yellow", "is_active": True},
                {"value": "orange", "label": "Orange", "is_active": True},
                {"value": "purple", "label": "Purple", "is_active": True},
                {"value": "teal", "label": "Teal", "is_active": True},
                {"value": "navy", "label": "Navy", "is_active": True},
                {"value": "charcoal", "label": "Charcoal", "is_active": True},
                {"value": "multicolour", "label": "Multicolour", "is_active": True},
            ]
        },
        # === TECHNICAL SPECS ===
        {
            "name": "Edge",
            "slug": "edge",
            "input_type": "checkbox",
            "description": "Tile edge type",
            "auto_populate": False,
            "show_in_shop_filter": True,
            "show_in_bulk_editor": True,
            "show_in_product_detail": True,
            "option_category": "technical",
            "values": [
                {"value": "rectified", "label": "Rectified", "is_active": True},
                {"value": "cushion-edge", "label": "Cushion Edge", "is_active": True},
                {"value": "bevelled", "label": "Bevelled", "is_active": True},
                {"value": "pressed-edge", "label": "Pressed Edge", "is_active": True},
                {"value": "natural-edge", "label": "Natural Edge", "is_active": True},
                {"value": "non-rectified", "label": "Non Rectified", "is_active": True},
            ]
        },
        {
            "name": "Slip Rating",
            "slug": "slip-rating",
            "input_type": "checkbox",
            "description": "Anti-slip rating",
            "auto_populate": False,
            "show_in_shop_filter": True,
            "show_in_bulk_editor": True,
            "show_in_product_detail": True,
            "option_category": "technical",
            "values": [
                {"value": "r9", "label": "R9", "is_active": True},
                {"value": "r10", "label": "R10", "is_active": True},
                {"value": "r11", "label": "R11", "is_active": True},
                {"value": "r12", "label": "R12", "is_active": True},
                {"value": "r13", "label": "R13", "is_active": True},
                {"value": "pei-1", "label": "PEI 1", "is_active": True},
                {"value": "pei-2", "label": "PEI 2", "is_active": True},
                {"value": "pei-3", "label": "PEI 3", "is_active": True},
                {"value": "pei-4", "label": "PEI 4", "is_active": True},
                {"value": "pei-5", "label": "PEI 5", "is_active": True},
            ]
        },
        {
            "name": "Thickness",
            "slug": "thickness",
            "input_type": "checkbox",
            "description": "Tile thickness",
            "auto_populate": False,
            "show_in_shop_filter": True,
            "show_in_bulk_editor": True,
            "show_in_product_detail": True,
            "option_category": "dimensions",
            "values": [
                {"value": "6mm", "label": "6mm", "is_active": True},
                {"value": "8mm", "label": "8mm", "is_active": True},
                {"value": "9mm", "label": "9mm", "is_active": True},
                {"value": "10mm", "label": "10mm", "is_active": True},
                {"value": "11mm", "label": "11mm", "is_active": True},
                {"value": "12mm", "label": "12mm", "is_active": True},
                {"value": "14mm", "label": "14mm", "is_active": True},
                {"value": "20mm", "label": "20mm", "is_active": True},
            ]
        },
        {
            "name": "Suitability",
            "slug": "suitability",
            "input_type": "checkbox",
            "description": "Where tile can be used (Wall, Floor, Both)",
            "auto_populate": False,
            "show_in_shop_filter": True,
            "show_in_bulk_editor": True,
            "show_in_product_detail": True,
            "option_category": "usage",
            "values": [
                {"value": "wall", "label": "Wall", "is_active": True},
                {"value": "floor", "label": "Floor", "is_active": True},
                {"value": "wall-floor", "label": "Wall & Floor", "is_active": True},
            ]
        },
        # === LOCATION / ROOM ===
        {
            "name": "Room",
            "slug": "room",
            "input_type": "checkbox",
            "description": "Suitable rooms/locations",
            "auto_populate": False,
            "show_in_shop_filter": True,
            "show_in_bulk_editor": True,
            "show_in_product_detail": False,
            "option_category": "location",
            "values": [
                {"value": "bathroom", "label": "Bathroom", "is_active": True},
                {"value": "kitchen", "label": "Kitchen", "is_active": True},
                {"value": "living-room", "label": "Living Room", "is_active": True},
                {"value": "bedroom", "label": "Bedroom", "is_active": True},
                {"value": "hallway", "label": "Hallway", "is_active": True},
                {"value": "conservatory", "label": "Conservatory", "is_active": True},
                {"value": "outdoor", "label": "Outdoor/Patio", "is_active": True},
                {"value": "commercial", "label": "Commercial", "is_active": True},
                {"value": "wet-room", "label": "Wet Room", "is_active": True},
                {"value": "pool-area", "label": "Pool Area", "is_active": True},
                {"value": "feature-wall", "label": "Feature Wall", "is_active": True},
            ]
        },
        # === STYLE ===
        {
            "name": "Style",
            "slug": "style",
            "input_type": "checkbox",
            "description": "Visual style/effect",
            "auto_populate": False,
            "show_in_shop_filter": True,
            "show_in_bulk_editor": True,
            "show_in_product_detail": False,
            "option_category": "appearance",
            "values": [
                {"value": "marble-effect", "label": "Marble Effect", "is_active": True},
                {"value": "wood-effect", "label": "Wood Effect", "is_active": True},
                {"value": "stone-effect", "label": "Stone Effect", "is_active": True},
                {"value": "concrete-effect", "label": "Concrete Effect", "is_active": True},
                {"value": "patterned", "label": "Patterned", "is_active": True},
                {"value": "metro-subway", "label": "Metro/Subway", "is_active": True},
                {"value": "terrazzo", "label": "Terrazzo", "is_active": True},
                {"value": "hexagon", "label": "Hexagon", "is_active": True},
                {"value": "mosaic", "label": "Mosaic", "is_active": True},
                {"value": "brick-effect", "label": "Brick Effect", "is_active": True},
                {"value": "plain-solid", "label": "Plain/Solid", "is_active": True},
                {"value": "onyx-effect", "label": "Onyx Effect", "is_active": True},
                {"value": "zellige", "label": "Zellige", "is_active": True},
                {"value": "splitface-3d", "label": "Splitface/3D", "is_active": True},
            ]
        },
        # === FEATURES ===
        {
            "name": "Features",
            "slug": "features",
            "input_type": "checkbox",
            "description": "Special features",
            "auto_populate": False,
            "show_in_shop_filter": True,
            "show_in_bulk_editor": True,
            "show_in_product_detail": True,
            "option_category": "features",
            "values": [
                {"value": "anti-slip", "label": "Anti-Slip", "is_active": True},
                {"value": "frost-resistant", "label": "Frost Resistant", "is_active": True},
                {"value": "wet-room-safe", "label": "Wet Room Safe", "is_active": True},
                {"value": "eco-friendly", "label": "Eco Friendly", "is_active": True},
                {"value": "underfloor-heating", "label": "Underfloor Heating Compatible", "is_active": True},
                {"value": "scratch-resistant", "label": "Scratch Resistant", "is_active": True},
                {"value": "stain-resistant", "label": "Stain Resistant", "is_active": True},
            ]
        },
        # === ORIGIN ===
        {
            "name": "Country of Origin",
            "slug": "country-of-origin",
            "input_type": "checkbox",
            "description": "Manufacturing country",
            "auto_populate": False,
            "show_in_shop_filter": False,  # Usually not a customer filter
            "show_in_bulk_editor": True,
            "show_in_product_detail": True,
            "option_category": "origin",
            "values": [
                {"value": "italy", "label": "Italy", "is_active": True},
                {"value": "spain", "label": "Spain", "is_active": True},
                {"value": "europe", "label": "Europe", "is_active": True},
                {"value": "poland", "label": "Poland", "is_active": True},
                {"value": "india", "label": "India", "is_active": True},
                {"value": "turkey", "label": "Turkey", "is_active": True},
                {"value": "portugal", "label": "Portugal", "is_active": True},
                {"value": "vietnam", "label": "Vietnam", "is_active": True},
                {"value": "china", "label": "China", "is_active": True},
                {"value": "uk", "label": "UK", "is_active": True},
            ]
        },
        # === PRICE (Special filter) ===
        {
            "name": "Price Range",
            "slug": "price",
            "input_type": "range",
            "description": "Filter by price",
            "auto_populate": False,
            "show_in_shop_filter": True,
            "show_in_bulk_editor": False,
            "show_in_product_detail": False,
            "option_category": "pricing",
            "values": [
                {"value": "0", "label": "Min", "is_active": True},
                {"value": "500", "label": "Max", "is_active": True},
            ]
        },
        # === STOCK (Special filter) ===
        {
            "name": "In Stock",
            "slug": "in-stock",
            "input_type": "toggle",
            "description": "Show only in-stock items",
            "auto_populate": False,
            "show_in_shop_filter": True,
            "show_in_bulk_editor": False,
            "show_in_product_detail": False,
            "option_category": "availability",
            "values": []
        },
    ]
    
    created = 0
    updated = 0
    
    for option in all_option_types:
        existing = await db.filter_types.find_one({"slug": option["slug"]})
        
        if existing:
            # Update existing - merge values, don't replace
            existing_values = {v.get("value"): v for v in existing.get("values", [])}
            
            for new_val in option.get("values", []):
                if new_val["value"] not in existing_values:
                    existing_values[new_val["value"]] = new_val
            
            # Update with new flags but keep existing values
            update_data = {
                "show_in_shop_filter": option.get("show_in_shop_filter", True),
                "show_in_bulk_editor": option.get("show_in_bulk_editor", True),
                "show_in_product_detail": option.get("show_in_product_detail", False),
                "option_category": option.get("option_category", "general"),
                "values": list(existing_values.values()),
                "updated_at": datetime.now(timezone.utc)
            }
            
            await db.filter_types.update_one(
                {"_id": existing["_id"]},
                {"$set": update_data}
            )
            updated += 1
        else:
            # Create new
            option["created_at"] = datetime.now(timezone.utc)
            option["updated_at"] = datetime.now(timezone.utc)
            option["is_active"] = True
            await db.filter_types.insert_one(option)
            created += 1
    
    return {
        "message": f"Product options seeded successfully",
        "created": created,
        "updated": updated,
        "total": len(all_option_types)
    }


@router.get("/bulk-editor-options")
async def get_bulk_editor_options():
    """
    Get all filter types that should appear in the Bulk Category Editor.
    This is the API endpoint that the Bulk Category Editor will use instead of
    the old website_category_custom_options collection.
    """
    filters = await db.filter_types.find({
        "show_in_bulk_editor": True,
        "is_active": True
    }).sort("name", 1).to_list(100)
    
    # Transform to the format expected by Bulk Category Editor
    result = {}
    for f in filters:
        slug = f.get("slug", "").replace("-", "_")  # Convert to underscore format
        result[slug] = [
            {"id": v.get("value"), "label": v.get("label"), "is_active": v.get("is_active", True)}
            for v in f.get("values", [])
        ]
    
    return result


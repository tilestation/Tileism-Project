"""
Shop Category — universal listing endpoint for any product group.

Serves both the Tiles storefront (extended pattern from /api/tiles/filters and
/api/tiles/products) and the new Bathroom / Flooring / Materials / UFH / Tools
storefronts. Also supports custom Managers created via /api/manager-definitions.

Endpoints:
  GET /api/shop/category/{category}/filters   — facet options for the category
  GET /api/shop/category/{category}/products  — filtered + paginated list

The `category` slug maps to `product_group` in supplier_products. If the value
matches an existing manager_definitions row, we also honour the custom
Manager's sub_categories keywords for classification.

Facets returned (per category preset):
  tiles     : sizes, finishes, materials, colors, slip_ratings, suppliers
  materials : colors, bag_colours, suitabilities, suppliers
  flooring  : sizes, finishes, materials, colors, thicknesses, suppliers
  bathroom  : brands, finishes, materials, colors, sizes, suppliers, sub_types
  ufh       : coverages, voltages, thermostat_types, suppliers
  tools     : brands, materials, sizes, suppliers
  <custom>  : colors, suppliers (universal fallback)
"""
from typing import List, Optional, Dict, Any
from fastapi import APIRouter, Query, HTTPException

from config import get_db


router = APIRouter(prefix="/shop/category", tags=["shop-category"])


# Category → { facet_key → list of product fields to pluck from }
FACET_CONFIG: Dict[str, List[Dict[str, Any]]] = {
    "tiles": [
        {"key": "sizes",         "field": "size",          "array_field": "sizes"},
        {"key": "finishes",      "field": "finish",        "array_field": "finishes"},
        {"key": "materials",     "field": "material",      "array_field": "materials"},
        {"key": "colors",        "field": "color",         "array_field": "colors"},
        {"key": "slip_ratings",  "field": "slip_rating"},
        {"key": "suppliers",     "field": "supplier"},
    ],
    "flooring": [
        {"key": "sizes",         "field": "size",          "array_field": "sizes"},
        {"key": "finishes",      "field": "finish",        "array_field": "finishes"},
        {"key": "materials",     "field": "material",      "array_field": "materials"},
        {"key": "colors",        "field": "color",         "array_field": "colors"},
        {"key": "thicknesses",   "field": "thickness"},
        {"key": "click_systems", "field": "click_system"},
        {"key": "suppliers",     "field": "supplier"},
    ],
    "materials": [
        {"key": "colors",        "field": "color",         "array_field": "colors"},
        {"key": "bag_colours",   "field": "bag_colour"},
        {"key": "suitabilities", "field": "suitability"},
        {"key": "suppliers",     "field": "supplier"},
    ],
    "bathroom": [
        {"key": "sub_types",     "field": "type"},
        {"key": "brands",        "field": "brand"},
        {"key": "finishes",      "field": "finish",        "array_field": "finishes"},
        {"key": "materials",     "field": "material",      "array_field": "materials"},
        {"key": "colors",        "field": "color",         "array_field": "colors"},
        {"key": "sizes",         "field": "dimensions"},
        {"key": "suppliers",     "field": "supplier"},
    ],
    "underfloor_heating": [
        {"key": "coverages",         "field": "kit_size_m2"},
        {"key": "voltages",          "field": "voltage"},
        {"key": "mat_types",         "field": "mat_type"},
        {"key": "thermostat_types",  "field": "thermostat_type"},
        {"key": "suppliers",         "field": "supplier"},
    ],
    "tools": [
        {"key": "brands",    "field": "brand"},
        {"key": "materials", "field": "material"},
        {"key": "sizes",     "field": "dimensions"},
        {"key": "suppliers", "field": "supplier"},
    ],
}

# Fallback for any category not listed above (custom Managers)
DEFAULT_FACETS = [
    {"key": "colors",    "field": "color", "array_field": "colors"},
    {"key": "suppliers", "field": "supplier"},
]


async def _category_query(db, category: str) -> dict:
    """Build a Mongo query that matches every product belonging to the category.

    Rules:
      1. product_group == category (canonical)
      2. main_category matches category (case-insensitive)
      3. sub_categories contains category keyword (e.g. 'bathroom-tiles' matches bathroom)
      4. For custom Manager categories, also match sub_categories against the
         definition's keywords list.
    Only surfaces products that are not explicitly hidden/deleted/archived.
    """
    category_match = [
        {"product_group": category},
        {"main_category": {"$regex": f"^{category}$", "$options": "i"}},
        {"main_category": {"$regex": category.replace("_", " "), "$options": "i"}},
        # Sub-category keyword (e.g. `bathroom-tiles` for /shop/browse/bathroom)
        {"sub_categories": {"$elemMatch": {"$regex": category, "$options": "i"}}},
    ]

    # Custom Manager keywords
    if category not in FACET_CONFIG:
        definition = await db.manager_definitions.find_one({
            "slug": category,
            "$or": [{"deleted_at": {"$exists": False}}, {"deleted_at": None}],
        })
        if definition and isinstance(definition.get("sub_categories"), list):
            for kw in definition["sub_categories"]:
                if kw:
                    category_match.append({
                        "sub_categories": {"$elemMatch": {"$regex": kw, "$options": "i"}}
                    })
                    category_match.append({
                        "our_product_name": {"$regex": kw, "$options": "i"}
                    })

    # Compose the full query — must use $and because we have multiple $or groups
    return {
        "$and": [
            {"$or": category_match},
            {"visibility": {"$ne": "hidden"}},
            {"status": {"$nin": ["deleted", "archived"]}},
        ],
    }


@router.get("/{category}/filters")
async def get_category_filters(category: str):
    """Return facet options for the given category, computed live from the data.

    Response shape mirrors /api/tiles/filters for drop-in reuse:
      { sizes: [...], finishes: [...], materials: [...], ... }
    """
    db = get_db()
    query = await _category_query(db, category)
    facet_defs = FACET_CONFIG.get(category, DEFAULT_FACETS)

    # Pull all matching products (projection keeps memory low for large catalogs)
    projection = {"_id": 0}
    for f in facet_defs:
        projection[f["field"]] = 1
        if f.get("array_field"):
            projection[f["array_field"]] = 1

    cursor = db.supplier_products.find(query, projection).limit(20000)
    docs = await cursor.to_list(length=20000)

    result: Dict[str, list] = {}
    for f in facet_defs:
        seen = {}   # value -> count
        for d in docs:
            values = []
            v = d.get(f["field"])
            if v:
                values.append(v)
            if f.get("array_field"):
                arr = d.get(f["array_field"])
                if isinstance(arr, list):
                    values.extend(arr)
            for val in values:
                if val is None or val == "":
                    continue
                key_val = str(val).strip()
                if not key_val:
                    continue
                seen[key_val] = seen.get(key_val, 0) + 1
        # Sort by frequency descending
        result[f["key"]] = [
            {"value": k, "count": c}
            for k, c in sorted(seen.items(), key=lambda kv: (-kv[1], kv[0]))
        ]

    result["total_products"] = len(docs)
    return result


@router.get("/{category}/products")
async def get_category_products(
    category: str,
    search: Optional[str] = None,
    supplier: Optional[str] = None,
    finish: Optional[str] = None,
    color: Optional[str] = None,
    size: Optional[str] = None,
    material: Optional[str] = None,
    brand: Optional[str] = None,
    sub_type: Optional[str] = Query(None, alias="sub_type"),
    slip_rating: Optional[str] = None,
    thickness: Optional[str] = None,
    click_system: Optional[str] = None,
    voltage: Optional[str] = None,
    thermostat_type: Optional[str] = None,
    mat_type: Optional[str] = None,
    price_min: Optional[float] = None,
    price_max: Optional[float] = None,
    sort_by: str = "featured",
    page: int = 1,
    limit: int = 24,
):
    """Filtered, paginated product list for any category. Same response
    envelope as /api/tiles/products for drop-in reuse."""
    db = get_db()
    query = await _category_query(db, category)

    # Apply user facet selections — merge extra $or into $and
    extra_and = []
    if search:
        extra_and.append({"$or": [
            {"our_product_name": {"$regex": search, "$options": "i"}},
            {"product_name":     {"$regex": search, "$options": "i"}},
            {"name":             {"$regex": search, "$options": "i"}},
            {"description":      {"$regex": search, "$options": "i"}},
            {"sku":              {"$regex": search, "$options": "i"}},
        ]})
    if color:
        extra_and.append({"$or": [{"color": color}, {"colors": color}]})
    if finish:
        extra_and.append({"$or": [{"finish": finish}, {"finishes": finish}]})
    if size:
        extra_and.append({"$or": [{"size": size}, {"sizes": size}]})
    if material:
        extra_and.append({"$or": [{"material": material}, {"materials": material}]})
    if extra_and:
        query["$and"] = (query.get("$and") or []) + extra_and

    if supplier:      query["supplier"] = supplier
    if brand:         query["brand"] = brand
    if sub_type:      query["type"] = sub_type
    if slip_rating:   query["slip_rating"] = slip_rating
    if thickness:     query["thickness"] = thickness
    if click_system:  query["click_system"] = click_system
    if voltage:       query["voltage"] = voltage
    if thermostat_type: query["thermostat_type"] = thermostat_type
    if mat_type:      query["mat_type"] = mat_type

    if price_min is not None or price_max is not None:
        price_query = {}
        if price_min is not None: price_query["$gte"] = price_min
        if price_max is not None: price_query["$lte"] = price_max
        query["list_price"] = price_query

    # Sort mapping (mirrors tiles endpoint)
    sort_map = {
        "featured":     [("featured_rank", 1), ("our_product_name", 1)],
        "price_asc":    [("list_price", 1)],
        "price_desc":   [("list_price", -1)],
        "name_asc":     [("our_product_name", 1)],
        "name_desc":    [("our_product_name", -1)],
        "newest":       [("created_at", -1)],
    }
    sort_spec = sort_map.get(sort_by, sort_map["featured"])

    total = await db.supplier_products.count_documents(query)
    total_pages = max(1, -(-total // max(1, limit)))     # ceiling division
    skip = max(0, (page - 1) * limit)
    projection = {
        "_id": 0, "id": 1, "sku": 1, "supplier_code": 1, "supplier": 1,
        "our_product_name": 1, "product_name": 1, "name": 1, "slug": 1,
        "image_url": 1, "images": 1, "list_price": 1, "retail_price": 1,
        "cost_price": 1, "sale_pct": 1, "description": 1, "size": 1,
        "finish": 1, "color": 1, "colors": 1, "material": 1, "brand": 1,
        "finishes": 1, "sizes": 1, "materials": 1,
        "type": 1, "thickness": 1, "dimensions": 1, "slip_rating": 1,
        "warehouse_stock": 1, "pricing_unit": 1, "product_group": 1,
        "main_category": 1, "sub_categories": 1, "kit_size_m2": 1, "voltage": 1,
        "thermostat_type": 1, "mat_type": 1, "watts_per_m2": 1,
        "wear_layer": 1, "click_system": 1, "underlay_included": 1,
        "trade_discount": 1, "trade_discount_type": 1, "credit_back_rate": 1,
    }
    cursor = db.supplier_products.find(query, projection).sort(sort_spec).skip(skip).limit(limit)
    products = await cursor.to_list(length=limit)

    return {
        "products": products,
        "total": total,
        "total_pages": total_pages,
        "page": page,
        "limit": limit,
        "category": category,
    }

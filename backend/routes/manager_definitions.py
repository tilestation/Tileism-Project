"""
Manager Definitions — data-driven custom Manager pages.

Each row in `manager_definitions` defines a custom category (e.g. Paint, Lighting,
Grout Extras) that appears as a new tab in the Products Workspace. Admins can
create these without shipping code — perfect for future SKUs that don't fit
into Tiles / Materials / Flooring / Bathroom / Underfloor Heating / Tools.

Fields:
  - slug: URL-safe identifier (e.g. 'paint')  — used in /admin/custom-manager/:slug
  - name: display label ('Paint')
  - description: optional one-liner
  - theme: colour theme for the tab ('purple','pink','emerald','amber',...)
  - icon: lucide icon name (defaults to Sparkles on the frontend)
  - sub_categories: array of sub-category keywords used to auto-classify products
      (matches against product.sub_categories with contains)
  - field_definitions: array of { key, label, type, options?[] } that drive the
      Custom Manager's edit form ('color', 'size', 'weight_kg', etc.). If empty
      the Manager falls back to a universal 6-field form.
  - created_at / created_by / updated_at
"""
from datetime import datetime, timezone
from typing import List, Optional
import re
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from config import get_db
from services import get_current_user, has_permission, log_audit


router = APIRouter(prefix="/manager-definitions", tags=["manager-definitions"])


# Hardcoded defaults for built-in Managers — seeded on first `?with_defaults=true` read.
# After that, admins can edit them via PATCH and their changes persist.
BUILTIN_DEFAULTS: dict = {
    "tiles": {
        "name": "Tiles Manager",
        "theme": "blue",
        "icon": "Grid3X3",
        "description": "Wall tiles, floor tiles, mosaics",
        "sub_tabs": [
            {"key": "all",   "label": "All Tiles",  "keywords": []},
            {"key": "floor", "label": "Floor",      "keywords": ["floor"]},
            {"key": "wall",  "label": "Wall",       "keywords": ["wall"]},
            {"key": "mosaic","label": "Mosaic",     "keywords": ["mosaic"]},
        ],
        "filter_facets": [
            {"key": "color",       "label": "Colour",   "field": "color",       "array_field": "colors"},
            {"key": "finish",      "label": "Finish",   "field": "finish"},
            {"key": "material",    "label": "Material", "field": "material"},
            {"key": "size",        "label": "Size",     "field": "size"},
            {"key": "slip_rating", "label": "Slip",     "field": "slip_rating"},
            {"key": "supplier",    "label": "Supplier", "field": "supplier"},
        ],
        "spec_fields": [
            {"key": "size",        "label": "Size",     "type": "text", "hint": "e.g. 600x600mm"},
            {"key": "finish",      "label": "Finish",   "type": "text"},
            {"key": "material",    "label": "Material", "type": "text"},
            {"key": "color",       "label": "Colour",   "type": "text"},
            {"key": "slip_rating", "label": "Slip",     "type": "text", "hint": "e.g. R10"},
            {"key": "suitability", "label": "Suitability", "type": "text"},
        ],
    },
    "materials": {
        "name": "Materials Manager",
        "theme": "orange",
        "icon": "Package",
        "description": "Adhesives, grouts, sealants, cleaning & primers",
        "sub_tabs": [
            {"key": "all",       "label": "All",         "keywords": []},
            {"key": "adhesive",  "label": "Adhesives",   "keywords": ["adhesive"]},
            {"key": "grout",     "label": "Grouts",      "keywords": ["grout"]},
            {"key": "sealant",   "label": "Sealants",    "keywords": ["sealant", "silicone"]},
            {"key": "cleaning",  "label": "Cleaning",    "keywords": ["clean"]},
            {"key": "primer",    "label": "Primers",     "keywords": ["primer"]},
        ],
        "filter_facets": [
            {"key": "color",       "label": "Colour",      "field": "color", "array_field": "colors"},
            {"key": "bag_colour",  "label": "Bag Colour",  "field": "bag_colour"},
            {"key": "suitability", "label": "Suitability", "field": "suitability"},
            {"key": "supplier",    "label": "Supplier",    "field": "supplier"},
        ],
        "spec_fields": [
            {"key": "color",             "label": "Colour"},
            {"key": "bag_colour",        "label": "Bag Colour"},
            {"key": "suitability",       "label": "Suitability"},
            {"key": "coverage_m2_per_bag", "label": "Coverage m²/bag", "type": "number"},
            {"key": "pack_size",         "label": "Pack Size"},
        ],
    },
    "flooring": {
        "name": "Flooring Manager",
        "theme": "amber",
        "icon": "Grid3X3",
        "description": "LVT, laminate, engineered wood, vinyl",
        "sub_tabs": [
            {"key": "all",      "label": "All Flooring", "keywords": []},
            {"key": "lvt",      "label": "LVT",          "keywords": ["lvt", "luxury vinyl"]},
            {"key": "laminate", "label": "Laminate",     "keywords": ["laminate"]},
            {"key": "wood",     "label": "Wood",         "keywords": ["wood", "engineered"]},
            {"key": "vinyl",    "label": "Vinyl",        "keywords": ["vinyl"]},
        ],
        "filter_facets": [
            {"key": "color",        "label": "Colour",    "field": "color", "array_field": "colors"},
            {"key": "finish",       "label": "Finish",    "field": "finish"},
            {"key": "material",     "label": "Material",  "field": "material"},
            {"key": "size",         "label": "Size",      "field": "size"},
            {"key": "thickness",    "label": "Thickness", "field": "thickness"},
            {"key": "click_system", "label": "Click",     "field": "click_system"},
            {"key": "supplier",     "label": "Supplier",  "field": "supplier"},
        ],
        "spec_fields": [
            {"key": "size",              "label": "Size"},
            {"key": "thickness",         "label": "Thickness"},
            {"key": "wear_layer",        "label": "Wear Layer"},
            {"key": "finish",            "label": "Finish"},
            {"key": "click_system",      "label": "Click System"},
            {"key": "underlay_included", "label": "Underlay Included"},
            {"key": "material",          "label": "Material"},
            {"key": "color",             "label": "Colour"},
            {"key": "pack_coverage",     "label": "Pack Coverage (m²)", "type": "number"},
        ],
    },
    "bathroom": {
        "name": "Bathroom Manager",
        "theme": "cyan",
        "icon": "Bath",
        "description": "Toilets, basins, baths, showers, taps",
        "sub_tabs": [
            {"key": "all",       "label": "All Bathroom", "keywords": []},
            {"key": "toilet",    "label": "Toilets",       "keywords": ["toilet"]},
            {"key": "basin",     "label": "Basins",        "keywords": ["basin", "sink", "vanity"]},
            {"key": "bath",      "label": "Baths",         "keywords": ["bath"]},
            {"key": "shower",    "label": "Showers",       "keywords": ["shower", "enclosure"]},
            {"key": "tap",       "label": "Taps & Mixers", "keywords": ["tap", "mixer", "faucet"]},
            {"key": "accessory", "label": "Accessories",   "keywords": ["towel", "mirror", "radiator", "holder"]},
        ],
        "filter_facets": [
            {"key": "type",     "label": "Type",     "field": "type"},
            {"key": "brand",    "label": "Brand",    "field": "brand"},
            {"key": "finish",   "label": "Finish",   "field": "finish"},
            {"key": "material", "label": "Material", "field": "material"},
            {"key": "color",    "label": "Colour",   "field": "color", "array_field": "colors"},
            {"key": "supplier", "label": "Supplier", "field": "supplier"},
        ],
        "spec_fields": [
            {"key": "brand",         "label": "Brand"},
            {"key": "model",         "label": "Model"},
            {"key": "dimensions",    "label": "Dimensions"},
            {"key": "flush_type",    "label": "Flush Type"},
            {"key": "tank_capacity", "label": "Tank Capacity (L)", "type": "number"},
            {"key": "material",      "label": "Material"},
            {"key": "finish",        "label": "Finish"},
            {"key": "color",         "label": "Colour"},
            {"key": "warranty",      "label": "Warranty"},
        ],
    },
    "underfloor_heating": {
        "name": "Underfloor Heating Manager",
        "theme": "red",
        "icon": "Flame",
        "description": "Electric UFH mats, cables, thermostats, insulation",
        "sub_tabs": [
            {"key": "all",         "label": "All UFH",        "keywords": []},
            {"key": "mat",         "label": "Heating Mats",   "keywords": ["mat"]},
            {"key": "cable",       "label": "Cables",         "keywords": ["cable"]},
            {"key": "thermostat",  "label": "Thermostats",    "keywords": ["thermostat", "controller"]},
            {"key": "insulation",  "label": "Insulation",     "keywords": ["insulation", "underlay"]},
        ],
        "filter_facets": [
            {"key": "kit_size_m2",     "label": "Coverage (m²)", "field": "kit_size_m2"},
            {"key": "voltage",         "label": "Voltage",        "field": "voltage"},
            {"key": "mat_type",        "label": "Mat Type",       "field": "mat_type"},
            {"key": "thermostat_type", "label": "Thermostat",     "field": "thermostat_type"},
            {"key": "supplier",        "label": "Supplier",       "field": "supplier"},
        ],
        "spec_fields": [
            {"key": "kit_size_m2",         "label": "Coverage (m²)", "type": "number"},
            {"key": "voltage",             "label": "Voltage"},
            {"key": "watts_per_m2",        "label": "Watts / m²",    "type": "number"},
            {"key": "cable_length_m",      "label": "Cable Length (m)", "type": "number"},
            {"key": "mat_type",            "label": "Mat / Cable Type"},
            {"key": "thermostat_included", "label": "Thermostat Included"},
            {"key": "thermostat_type",     "label": "Thermostat Type"},
            {"key": "warranty",            "label": "Warranty"},
        ],
    },
    "tools": {
        "name": "Tools Manager",
        "theme": "slate",
        "icon": "Wrench",
        "description": "Cutters, trowels, spacers, mixers, cleaning",
        "sub_tabs": [
            {"key": "all",     "label": "All Tools",             "keywords": []},
            {"key": "cutter",  "label": "Cutters",               "keywords": ["cutter", "blade", "saw"]},
            {"key": "trowel",  "label": "Trowels",               "keywords": ["trowel", "float"]},
            {"key": "spacer",  "label": "Spacers & Levellers",   "keywords": ["spacer", "leveller", "wedge", "clip"]},
            {"key": "mixer",   "label": "Mixers & Buckets",      "keywords": ["mixer", "bucket", "paddle"]},
            {"key": "clean",   "label": "Cleaning",              "keywords": ["sponge", "scraper", "cloth"]},
        ],
        "filter_facets": [
            {"key": "brand",      "label": "Brand",      "field": "brand"},
            {"key": "material",   "label": "Material",   "field": "material"},
            {"key": "dimensions", "label": "Size",       "field": "dimensions"},
            {"key": "supplier",   "label": "Supplier",   "field": "supplier"},
        ],
        "spec_fields": [
            {"key": "brand",       "label": "Brand"},
            {"key": "model",       "label": "Model"},
            {"key": "material",    "label": "Material"},
            {"key": "dimensions",  "label": "Size / Dimensions"},
            {"key": "capacity",    "label": "Capacity"},
            {"key": "suitability", "label": "Use With"},
            {"key": "pack_qty",    "label": "Pack Quantity", "type": "number"},
            {"key": "warranty",    "label": "Warranty"},
        ],
    },
}


class FieldDefinition(BaseModel):
    key: str
    label: str
    type: str = "text"           # text | number | select | textarea
    options: Optional[List[str]] = None
    hint: Optional[str] = None


class SubTab(BaseModel):
    key: str
    label: str
    keywords: List[str] = Field(default_factory=list)   # regex-like tokens for classification


class FilterFacet(BaseModel):
    key: str
    label: str
    field: str                     # source field on the product (e.g. 'color', 'brand')
    array_field: Optional[str] = None   # optional array field (e.g. 'colors') to also pluck from


class ManagerDefinitionCreate(BaseModel):
    name: str
    slug: Optional[str] = None
    description: Optional[str] = None
    theme: Optional[str] = "purple"
    icon: Optional[str] = "Sparkles"
    sub_categories: List[str] = Field(default_factory=list)
    field_definitions: List[FieldDefinition] = Field(default_factory=list)
    sub_tabs: List[SubTab] = Field(default_factory=list)
    filter_facets: List[FilterFacet] = Field(default_factory=list)
    spec_fields: List[FieldDefinition] = Field(default_factory=list)
    product_group: Optional[str] = None
    is_builtin: bool = False


class ManagerDefinitionUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    theme: Optional[str] = None
    icon: Optional[str] = None
    sub_categories: Optional[List[str]] = None
    field_definitions: Optional[List[FieldDefinition]] = None
    sub_tabs: Optional[List[SubTab]] = None
    filter_facets: Optional[List[FilterFacet]] = None
    spec_fields: Optional[List[FieldDefinition]] = None
    product_group: Optional[str] = None


def _slugify(value: str) -> str:
    v = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower()).strip("-")
    return v or f"manager-{uuid.uuid4().hex[:6]}"


def _serialize(doc: dict) -> dict:
    if not doc:
        return doc
    doc = dict(doc)
    doc.pop("_id", None)
    for ts in ("created_at", "updated_at"):
        if isinstance(doc.get(ts), datetime):
            doc[ts] = doc[ts].isoformat()
    return doc


@router.post("/cleanup-duplicates")
async def cleanup_duplicate_definitions(current_user: dict = Depends(get_current_user)):
    """One-shot cleanup: soft-delete any non-builtin manager_definitions whose slug or
    name clashes with a built-in Manager. Fixes the "Materials Manager (CUSTOM)" style
    duplicate tabs that appear when someone accidentally created a custom row with the
    same slug/name as a hardcoded tab.

    Returns a summary of removed rows so the caller can show it to the admin.
    """
    if not has_permission(current_user, "supplier_products"):
        raise HTTPException(403, "You need the Supplier Products permission to clean up Managers")

    db = get_db()
    builtin_slugs = set(BUILTIN_DEFAULTS.keys())
    builtin_names = {v["name"].lower() for v in BUILTIN_DEFAULTS.values()}

    # Load candidates: any non-builtin, non-deleted row
    cursor = db.manager_definitions.find({
        "is_builtin": {"$ne": True},
        "$or": [{"deleted_at": {"$exists": False}}, {"deleted_at": None}],
    })

    to_remove: list[dict] = []
    async for doc in cursor:
        slug = str(doc.get("slug") or "")
        name = str(doc.get("name") or "").strip().lower()
        if slug in builtin_slugs or name in builtin_names:
            to_remove.append({"slug": slug, "name": doc.get("name"), "id": doc.get("id")})

    if not to_remove:
        return {"ok": True, "removed_count": 0, "removed": []}

    now = datetime.now(timezone.utc)
    slugs = [r["slug"] for r in to_remove]
    await db.manager_definitions.update_many(
        {"slug": {"$in": slugs}, "is_builtin": {"$ne": True}},
        {"$set": {"deleted_at": now, "deleted_by": current_user.get("email")}},
    )
    await log_audit(
        action="CLEANUP_DUPLICATES",
        entity_type="manager_definition",
        user=current_user,
        entity_id="bulk",
        entity_name=f"{len(to_remove)} duplicate custom managers",
        before_data={"removed": to_remove},
    )
    return {"ok": True, "removed_count": len(to_remove), "removed": to_remove}




@router.get("")
async def list_definitions():
    """Public list — the Manager Tabs Bar reads this on every page load.

    We deliberately don't require auth here because the frontend uses it for
    navigation, not for editing. Editing endpoints below DO require auth.
    """
    db = get_db()
    cursor = db.manager_definitions.find({
        "$or": [
            {"deleted_at": {"$exists": False}},
            {"deleted_at": None},
        ]
    }).sort("created_at", 1)
    docs = [ _serialize(d) async for d in cursor ]
    return {"definitions": docs, "count": len(docs)}


@router.get("/{slug}")
async def get_definition(slug: str, with_defaults: bool = False):
    """Fetch a Manager definition. When `with_defaults=true` and the slug is a
    known built-in (tiles/materials/flooring/bathroom/underfloor_heating/tools),
    we seed a doc with the hardcoded defaults on the first read so admins can
    edit it going forward.
    """
    db = get_db()
    doc = await db.manager_definitions.find_one({
        "slug": slug,
        "$or": [
            {"deleted_at": {"$exists": False}},
            {"deleted_at": None},
        ]
    })
    if not doc and with_defaults and slug in BUILTIN_DEFAULTS:
        # Seed the row lazily on first read
        now = datetime.now(timezone.utc)
        seed = BUILTIN_DEFAULTS[slug]
        doc = {
            "id": str(uuid.uuid4()),
            "slug": slug,
            "name": seed["name"],
            "theme": seed["theme"],
            "icon": seed.get("icon", "Sparkles"),
            "description": seed.get("description"),
            "sub_categories": [],
            "field_definitions": [],
            "sub_tabs": seed.get("sub_tabs", []),
            "filter_facets": seed.get("filter_facets", []),
            "spec_fields": seed.get("spec_fields", []),
            "product_group": slug,
            "is_builtin": True,
            "created_at": now,
            "updated_at": now,
        }
        await db.manager_definitions.insert_one(doc)
    if not doc:
        raise HTTPException(404, f"Manager definition '{slug}' not found")
    return _serialize(doc)


@router.post("")
async def create_definition(
    payload: ManagerDefinitionCreate,
    current_user: dict = Depends(get_current_user),
):
    if not has_permission(current_user, "supplier_products"):
        raise HTTPException(403, "You need the Supplier Products permission to add a custom Manager")

    db = get_db()
    slug = _slugify(payload.slug or payload.name)

    # Guard against duplicate slugs
    existing = await db.manager_definitions.find_one({"slug": slug, "$or": [{"deleted_at": {"$exists": False}}, {"deleted_at": None}]})
    if existing:
        raise HTTPException(409, f"A Manager with slug '{slug}' already exists")

    # Guard against slug clashes with a built-in Manager (materials/tiles/flooring/
    # bathroom/underfloor_heating/tools). Non-admin flag not enough — even a
    # super-admin creating "Materials Manager" as a custom would double up the tab.
    if slug in BUILTIN_DEFAULTS and not payload.is_builtin:
        raise HTTPException(
            409,
            f"'{slug}' is a built-in Manager slug. Pick a different name (e.g. '{slug}-extras', 'my-{slug}', or a bespoke slug) — the workspace tabs bar would otherwise show two tabs for the same category.",
        )

    # Guard against name clash with a built-in Manager name (Materials Manager, etc.)
    # This catches the case where someone types "Materials Manager" as the name and
    # the slugify picks a UUID-style slug; the tab would still visually duplicate.
    _builtin_names = {v["name"].lower() for v in BUILTIN_DEFAULTS.values()}
    if payload.name.strip().lower() in _builtin_names and not payload.is_builtin:
        raise HTTPException(
            409,
            f"'{payload.name.strip()}' is the display name of a built-in Manager. Please choose a distinct name.",
        )

    now = datetime.now(timezone.utc)
    doc = {
        "id": str(uuid.uuid4()),
        "slug": slug,
        "name": payload.name.strip(),
        "description": (payload.description or "").strip() or None,
        "theme": (payload.theme or "purple").strip(),
        "icon": (payload.icon or "Sparkles").strip(),
        "sub_categories": [s.strip() for s in (payload.sub_categories or []) if s.strip()],
        "field_definitions": [f.dict() for f in (payload.field_definitions or [])],
        "sub_tabs": [t.dict() for t in (payload.sub_tabs or [])],
        "filter_facets": [f.dict() for f in (payload.filter_facets or [])],
        "spec_fields": [f.dict() for f in (payload.spec_fields or [])],
        "product_group": (payload.product_group or slug).strip(),
        "is_builtin": bool(payload.is_builtin),
        "created_at": now,
        "created_by": current_user.get("email"),
        "updated_at": now,
    }
    await db.manager_definitions.insert_one(doc)
    await log_audit(
        action="CREATE",
        entity_type="manager_definition",
        user=current_user,
        entity_id=doc["id"],
        entity_name=doc["name"],
        after_data={"slug": slug, "name": doc["name"], "sub_categories": doc["sub_categories"]},
    )
    return _serialize(doc)


@router.patch("/{slug}")
async def update_definition(
    slug: str,
    payload: ManagerDefinitionUpdate,
    current_user: dict = Depends(get_current_user),
):
    if not has_permission(current_user, "supplier_products"):
        raise HTTPException(403, "You need the Supplier Products permission to edit a custom Manager")

    db = get_db()
    doc = await db.manager_definitions.find_one({"slug": slug, "$or": [{"deleted_at": {"$exists": False}}, {"deleted_at": None}]})
    if not doc:
        raise HTTPException(404, f"Manager definition '{slug}' not found")

    updates = {k: v for k, v in payload.dict(exclude_unset=True).items() if v is not None}
    # Serialize nested Pydantic models → dicts
    for arr_key in ("field_definitions", "sub_tabs", "filter_facets", "spec_fields"):
        if arr_key in updates and updates[arr_key] is not None:
            updates[arr_key] = [x if isinstance(x, dict) else x.dict() for x in updates[arr_key]]
    updates["updated_at"] = datetime.now(timezone.utc)

    await db.manager_definitions.update_one({"slug": slug}, {"$set": updates})
    doc = await db.manager_definitions.find_one({"slug": slug})
    return _serialize(doc)


@router.delete("/{slug}")
async def delete_definition(
    slug: str,
    current_user: dict = Depends(get_current_user),
):
    if not has_permission(current_user, "supplier_products"):
        raise HTTPException(403, "You need the Supplier Products permission to delete a custom Manager")

    db = get_db()
    doc = await db.manager_definitions.find_one({"slug": slug, "$or": [{"deleted_at": {"$exists": False}}, {"deleted_at": None}]})
    if not doc:
        raise HTTPException(404, f"Manager definition '{slug}' not found")

    await db.manager_definitions.update_one(
        {"slug": slug},
        {"$set": {"deleted_at": datetime.now(timezone.utc), "deleted_by": current_user.get("email")}},
    )
    await log_audit(
        action="DELETE",
        entity_type="manager_definition",
        user=current_user,
        entity_id=doc.get("id", ""),
        entity_name=doc.get("name", slug),
        before_data={"slug": slug},
    )
    return {"ok": True, "slug": slug}

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


class FieldDefinition(BaseModel):
    key: str
    label: str
    type: str = "text"           # text | number | select | textarea
    options: Optional[List[str]] = None
    hint: Optional[str] = None


class ManagerDefinitionCreate(BaseModel):
    name: str
    slug: Optional[str] = None
    description: Optional[str] = None
    theme: Optional[str] = "purple"
    icon: Optional[str] = "Sparkles"
    sub_categories: List[str] = Field(default_factory=list)
    field_definitions: List[FieldDefinition] = Field(default_factory=list)
    product_group: Optional[str] = None   # overrides classification (e.g. 'paint')


class ManagerDefinitionUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    theme: Optional[str] = None
    icon: Optional[str] = None
    sub_categories: Optional[List[str]] = None
    field_definitions: Optional[List[FieldDefinition]] = None
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


@router.get("")
async def list_definitions():
    """Public list — the Manager Tabs Bar reads this on every page load.

    We deliberately don't require auth here because the frontend uses it for
    navigation, not for editing. Editing endpoints below DO require auth.
    """
    db = get_db()
    cursor = db.manager_definitions.find({"deleted_at": {"$exists": False}}).sort("created_at", 1)
    docs = [ _serialize(d) async for d in cursor ]
    return {"definitions": docs, "count": len(docs)}


@router.get("/{slug}")
async def get_definition(slug: str):
    db = get_db()
    doc = await db.manager_definitions.find_one({"slug": slug, "deleted_at": {"$exists": False}})
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
    existing = await db.manager_definitions.find_one({"slug": slug, "deleted_at": {"$exists": False}})
    if existing:
        raise HTTPException(409, f"A Manager with slug '{slug}' already exists")

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
        "product_group": (payload.product_group or slug).strip(),
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
    doc = await db.manager_definitions.find_one({"slug": slug, "deleted_at": {"$exists": False}})
    if not doc:
        raise HTTPException(404, f"Manager definition '{slug}' not found")

    updates = {k: v for k, v in payload.dict(exclude_unset=True).items() if v is not None}
    if "field_definitions" in updates and updates["field_definitions"] is not None:
        updates["field_definitions"] = [f if isinstance(f, dict) else f.dict() for f in updates["field_definitions"]]
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
    doc = await db.manager_definitions.find_one({"slug": slug, "deleted_at": {"$exists": False}})
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

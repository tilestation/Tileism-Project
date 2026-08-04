"""
Product Templates — save any product's spec fields as a reusable template so
sellers can pre-populate the Add Product Wizard for the next SKU. Ideal when
a supplier drops a large batch of variants that share most fields (colour,
brand, material, etc.).

Collection: `product_templates`
Fields:
  - id: uuid
  - slug: URL-safe
  - name: display label
  - product_group: 'tiles' | 'materials' | 'flooring' | 'bathroom' | 'underfloor_heating' | 'tools' | any custom slug
  - fields: dict of the pre-populated fields to spread into the Wizard's form state
  - image_url: optional preview
  - source_sku: SKU this template was created from (for provenance)
  - created_at / created_by / usage_count
"""
from datetime import datetime, timezone
from typing import Dict, List, Optional
import re
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from config import get_db
from services import get_current_user, has_permission


router = APIRouter(prefix="/product-templates", tags=["product-templates"])


class TemplateCreate(BaseModel):
    name: str
    product_group: str
    fields: Dict[str, object] = Field(default_factory=dict)
    slug: Optional[str] = None
    image_url: Optional[str] = None
    source_sku: Optional[str] = None


class TemplateUpdate(BaseModel):
    name: Optional[str] = None
    fields: Optional[Dict[str, object]] = None
    image_url: Optional[str] = None


def _slugify(v: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "-", v.strip().lower()).strip("-")
    return s or f"template-{uuid.uuid4().hex[:6]}"


def _serialize(d: dict) -> dict:
    if not d:
        return d
    d = dict(d)
    d.pop("_id", None)
    for ts in ("created_at", "updated_at", "last_used_at"):
        if isinstance(d.get(ts), datetime):
            d[ts] = d[ts].isoformat()
    return d


# Fields we NEVER copy into a template (they must be unique per SKU or per copy)
BLOCKED_FIELDS = {
    "sku", "supplier_code", "id", "_id", "product_id", "warehouse_stock",
    "stock_qty", "stock", "images", "image_url", "created_at", "updated_at",
    "published_at", "deleted_at", "published", "status", "sale_pct",
    "list_price", "retail_price", "cost_price", "cost_each",  # prices differ per SKU
}


@router.get("")
async def list_templates(product_group: Optional[str] = None):
    db = get_db()
    query = {"$or": [{"deleted_at": {"$exists": False}}, {"deleted_at": None}]}
    if product_group:
        query["product_group"] = product_group
    cursor = db.product_templates.find(query).sort("created_at", -1)
    docs = [ _serialize(d) async for d in cursor ]
    return {"templates": docs, "count": len(docs)}


@router.get("/{slug}")
async def get_template(slug: str):
    db = get_db()
    doc = await db.product_templates.find_one({
        "slug": slug,
        "$or": [{"deleted_at": {"$exists": False}}, {"deleted_at": None}],
    })
    if not doc:
        raise HTTPException(404, f"Template '{slug}' not found")
    return _serialize(doc)


@router.post("")
async def create_template(payload: TemplateCreate, current_user: dict = Depends(get_current_user)):
    if not has_permission(current_user, "supplier_products"):
        raise HTTPException(403, "You need the Supplier Products permission to save a template")

    db = get_db()
    slug = _slugify(payload.slug or payload.name)
    existing = await db.product_templates.find_one({
        "slug": slug,
        "$or": [{"deleted_at": {"$exists": False}}, {"deleted_at": None}],
    })
    if existing:
        # Make it unique
        slug = f"{slug}-{uuid.uuid4().hex[:5]}"

    clean_fields = {k: v for k, v in (payload.fields or {}).items() if k not in BLOCKED_FIELDS}

    now = datetime.now(timezone.utc)
    doc = {
        "id": str(uuid.uuid4()),
        "slug": slug,
        "name": payload.name.strip(),
        "product_group": (payload.product_group or "tiles").strip(),
        "fields": clean_fields,
        "image_url": payload.image_url,
        "source_sku": payload.source_sku,
        "created_at": now,
        "created_by": current_user.get("email"),
        "updated_at": now,
        "usage_count": 0,
    }
    await db.product_templates.insert_one(doc)
    return _serialize(doc)


@router.post("/from-product")
async def create_from_product(request: dict, current_user: dict = Depends(get_current_user)):
    """Convenience: pass {sku, name?} and we pluck fields from the existing supplier_product."""
    if not has_permission(current_user, "supplier_products"):
        raise HTTPException(403, "You need the Supplier Products permission to save a template")

    sku = request.get("sku")
    if not sku:
        raise HTTPException(400, "sku is required")

    db = get_db()
    product = await db.supplier_products.find_one({"$or": [{"sku": sku}, {"supplier_code": sku}]})
    if not product:
        raise HTTPException(404, f"Product with SKU '{sku}' not found")

    product_group = request.get("product_group") or product.get("product_group") or "tiles"
    template_name = request.get("name") or f"{product.get('our_product_name') or product.get('product_name') or sku} template"

    fields = {k: v for k, v in product.items() if k not in BLOCKED_FIELDS and not k.startswith("_")}

    payload = TemplateCreate(
        name=template_name,
        product_group=product_group,
        fields=fields,
        source_sku=sku,
        image_url=product.get("image_url") or (product.get("images") or [None])[0],
    )
    return await create_template(payload, current_user)


@router.post("/{slug}/use")
async def mark_used(slug: str, current_user: dict = Depends(get_current_user)):
    db = get_db()
    result = await db.product_templates.update_one(
        {"slug": slug},
        {"$inc": {"usage_count": 1}, "$set": {"last_used_at": datetime.now(timezone.utc)}},
    )
    if result.matched_count == 0:
        raise HTTPException(404, "Template not found")
    return {"ok": True}


@router.delete("/{slug}")
async def delete_template(slug: str, current_user: dict = Depends(get_current_user)):
    if not has_permission(current_user, "supplier_products"):
        raise HTTPException(403, "You need the Supplier Products permission to delete a template")
    db = get_db()
    doc = await db.product_templates.find_one({"slug": slug})
    if not doc:
        raise HTTPException(404, "Template not found")
    await db.product_templates.update_one(
        {"slug": slug},
        {"$set": {"deleted_at": datetime.now(timezone.utc), "deleted_by": current_user.get("email")}},
    )
    return {"ok": True, "slug": slug}

"""
Manager Config Templates — reusable presets of filter_facets + sub_tabs + spec_fields.

Use case: admin builds an ideal Warranty/Brand/Model layout on the Tools Manager,
saves it as "Hardware Preset", then spins up a new Custom Manager for "Screws" and
one-click applies the preset — no re-typing the 8 spec fields.

Endpoints:
  - GET  /api/manager-config-templates                    → list all
  - POST /api/manager-config-templates                    → create (either raw arrays or from a source manager)
  - POST /api/manager-config-templates/{slug}/apply       → copies template arrays into a target manager_definition
  - DELETE /api/manager-config-templates/{slug}           → soft-delete
"""
from datetime import datetime, timezone
from typing import List, Optional
import re
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from config import get_db
from services import get_current_user, has_permission, log_audit


router = APIRouter(prefix="/manager-config-templates", tags=["manager-config-templates"])


class FieldDefinitionDict(BaseModel):
    key: str
    label: str
    type: Optional[str] = "text"
    options: Optional[List[str]] = None
    hint: Optional[str] = None


class SubTabDict(BaseModel):
    key: str
    label: str
    keywords: List[str] = Field(default_factory=list)


class FilterFacetDict(BaseModel):
    key: str
    label: str
    field: str
    array_field: Optional[str] = None


class TemplateCreate(BaseModel):
    name: str
    slug: Optional[str] = None
    description: Optional[str] = None
    theme: Optional[str] = "slate"
    # Either provide arrays directly …
    filter_facets: List[FilterFacetDict] = Field(default_factory=list)
    sub_tabs: List[SubTabDict] = Field(default_factory=list)
    spec_fields: List[FieldDefinitionDict] = Field(default_factory=list)
    # … or plug a source slug and the server will pluck them from that manager_definition
    source_slug: Optional[str] = None


class TemplateApply(BaseModel):
    target_slug: str
    include_facets: bool = True
    include_sub_tabs: bool = True
    include_spec_fields: bool = True
    mode: str = "replace"   # 'replace' or 'append'


def _slugify(value: str) -> str:
    v = re.sub(r"[^a-zA-Z0-9]+", "-", (value or "").strip().lower()).strip("-")
    return v or f"tpl-{uuid.uuid4().hex[:6]}"


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
async def list_templates():
    """Public list — the Manager Config Modal reads this to show a preset picker."""
    db = get_db()
    cursor = db.manager_config_templates.find({
        "$or": [
            {"deleted_at": {"$exists": False}},
            {"deleted_at": None},
        ]
    }).sort("created_at", 1)
    docs = [_serialize(d) async for d in cursor]
    return {"templates": docs, "count": len(docs)}


@router.post("")
async def create_template(
    payload: TemplateCreate,
    current_user: dict = Depends(get_current_user),
):
    if not has_permission(current_user, "supplier_products"):
        raise HTTPException(403, "You need the Supplier Products permission to save a Manager preset")

    db = get_db()
    slug = _slugify(payload.slug or payload.name)

    existing = await db.manager_config_templates.find_one({
        "slug": slug,
        "$or": [{"deleted_at": {"$exists": False}}, {"deleted_at": None}],
    })
    if existing:
        raise HTTPException(409, f"A preset with slug '{slug}' already exists")

    facets = [f.dict() for f in (payload.filter_facets or [])]
    sub_tabs = [t.dict() for t in (payload.sub_tabs or [])]
    spec_fields = [f.dict() for f in (payload.spec_fields or [])]

    # If source_slug is provided, override arrays with the source manager's current config
    if payload.source_slug:
        source = await db.manager_definitions.find_one({
            "slug": payload.source_slug,
            "$or": [{"deleted_at": {"$exists": False}}, {"deleted_at": None}],
        })
        if not source:
            raise HTTPException(404, f"Source manager '{payload.source_slug}' not found — cannot pluck config")
        facets = source.get("filter_facets") or []
        sub_tabs = source.get("sub_tabs") or []
        spec_fields = source.get("spec_fields") or []

    now = datetime.now(timezone.utc)
    doc = {
        "id": str(uuid.uuid4()),
        "slug": slug,
        "name": payload.name.strip(),
        "description": (payload.description or "").strip() or None,
        "theme": (payload.theme or "slate").strip(),
        "filter_facets": facets,
        "sub_tabs": sub_tabs,
        "spec_fields": spec_fields,
        "source_slug": payload.source_slug,
        "created_at": now,
        "created_by": current_user.get("email"),
        "updated_at": now,
    }
    await db.manager_config_templates.insert_one(doc)
    await log_audit(
        action="CREATE",
        entity_type="manager_config_template",
        user=current_user,
        entity_id=doc["id"],
        entity_name=doc["name"],
        after_data={
            "slug": slug,
            "source_slug": payload.source_slug,
            "facets_count": len(facets),
            "sub_tabs_count": len(sub_tabs),
            "spec_fields_count": len(spec_fields),
        },
    )
    return _serialize(doc)


@router.post("/{slug}/apply")
async def apply_template(
    slug: str,
    payload: TemplateApply,
    current_user: dict = Depends(get_current_user),
):
    if not has_permission(current_user, "supplier_products"):
        raise HTTPException(403, "You need the Supplier Products permission to apply a Manager preset")

    db = get_db()
    tpl = await db.manager_config_templates.find_one({
        "slug": slug,
        "$or": [{"deleted_at": {"$exists": False}}, {"deleted_at": None}],
    })
    if not tpl:
        raise HTTPException(404, f"Preset '{slug}' not found")

    target = await db.manager_definitions.find_one({
        "slug": payload.target_slug,
        "$or": [{"deleted_at": {"$exists": False}}, {"deleted_at": None}],
    })
    if not target:
        # If the target is a built-in and hasn't been materialised yet, materialise it
        from .manager_definitions import BUILTIN_DEFAULTS
        if payload.target_slug in BUILTIN_DEFAULTS:
            seed = BUILTIN_DEFAULTS[payload.target_slug]
            now = datetime.now(timezone.utc)
            target = {
                "id": str(uuid.uuid4()),
                "slug": payload.target_slug,
                "name": seed["name"],
                "theme": seed["theme"],
                "icon": seed.get("icon", "Sparkles"),
                "description": seed.get("description"),
                "sub_categories": [],
                "field_definitions": [],
                "sub_tabs": seed.get("sub_tabs", []),
                "filter_facets": seed.get("filter_facets", []),
                "spec_fields": seed.get("spec_fields", []),
                "product_group": payload.target_slug,
                "is_builtin": True,
                "created_at": now,
                "updated_at": now,
            }
            await db.manager_definitions.insert_one(target)
        else:
            raise HTTPException(404, f"Target manager '{payload.target_slug}' not found")

    updates: dict = {"updated_at": datetime.now(timezone.utc)}
    changed = []

    if payload.include_facets:
        new_facets = list(tpl.get("filter_facets") or [])
        if payload.mode == "append":
            existing_keys = {f.get("key") for f in (target.get("filter_facets") or [])}
            new_facets = list(target.get("filter_facets") or []) + [
                f for f in new_facets if f.get("key") not in existing_keys
            ]
        updates["filter_facets"] = new_facets
        changed.append(f"filter_facets({len(new_facets)})")

    if payload.include_sub_tabs:
        new_tabs = list(tpl.get("sub_tabs") or [])
        if payload.mode == "append":
            existing_keys = {t.get("key") for t in (target.get("sub_tabs") or [])}
            new_tabs = list(target.get("sub_tabs") or []) + [
                t for t in new_tabs if t.get("key") not in existing_keys
            ]
        updates["sub_tabs"] = new_tabs
        changed.append(f"sub_tabs({len(new_tabs)})")

    if payload.include_spec_fields:
        new_specs = list(tpl.get("spec_fields") or [])
        if payload.mode == "append":
            existing_keys = {s.get("key") for s in (target.get("spec_fields") or [])}
            new_specs = list(target.get("spec_fields") or []) + [
                s for s in new_specs if s.get("key") not in existing_keys
            ]
        updates["spec_fields"] = new_specs
        changed.append(f"spec_fields({len(new_specs)})")

    if len(updates) == 1:   # only updated_at
        raise HTTPException(400, "Nothing to apply — set at least one of include_facets / include_sub_tabs / include_spec_fields to true")

    await db.manager_definitions.update_one({"slug": payload.target_slug}, {"$set": updates})
    result = await db.manager_definitions.find_one({"slug": payload.target_slug})

    await log_audit(
        action="APPLY",
        entity_type="manager_config_template",
        user=current_user,
        entity_id=tpl.get("id", ""),
        entity_name=tpl.get("name", slug),
        after_data={
            "target_slug": payload.target_slug,
            "mode": payload.mode,
            "changed": changed,
        },
    )

    return {
        "ok": True,
        "template_slug": slug,
        "target_slug": payload.target_slug,
        "mode": payload.mode,
        "changed": changed,
        "target": _serialize(result),
    }


@router.delete("/{slug}")
async def delete_template(
    slug: str,
    current_user: dict = Depends(get_current_user),
):
    if not has_permission(current_user, "supplier_products"):
        raise HTTPException(403, "You need the Supplier Products permission to delete a Manager preset")

    db = get_db()
    doc = await db.manager_config_templates.find_one({
        "slug": slug,
        "$or": [{"deleted_at": {"$exists": False}}, {"deleted_at": None}],
    })
    if not doc:
        raise HTTPException(404, f"Preset '{slug}' not found")

    await db.manager_config_templates.update_one(
        {"id": doc["id"]},
        {"$set": {"deleted_at": datetime.now(timezone.utc), "deleted_by": current_user.get("email")}},
    )
    await log_audit(
        action="DELETE",
        entity_type="manager_config_template",
        user=current_user,
        entity_id=doc.get("id", ""),
        entity_name=doc.get("name", slug),
        before_data={"slug": slug},
    )
    return {"ok": True, "slug": slug}

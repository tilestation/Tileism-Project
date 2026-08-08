"""
Product Variants API — enables the Moonstone-style landing page where one
"product" is actually a group of sibling SKUs that share:
  • variant_group_id (a shared UUID; every SKU in the group carries the same one)
  • variant_axes (per-SKU dict like {"color":"Ivory","finish":"Matt","size":"30x60cm"})
  • variant_display_order (int; controls chip ordering on the landing page)

Endpoints:
  POST /api/supplier-sync/variants/create-group
      Manually create a variant group from a list of SKUs. Generates a UUID,
      tags every SKU with variant_group_id + optional per-SKU axes.

  POST /api/supplier-sync/variants/auto-group-from-series
      For a given series name, cluster its SKUs by the "base name" (name with
      colour, finish, size tokens removed) and create one group per cluster.
      Fastest way to bootstrap 100+ groups from an existing catalogue.

  GET  /api/supplier-sync/variants/group/{group_id}
      Return every SKU in the group ordered by variant_display_order.

  GET  /api/supplier-sync/variants/candidates
      For a given SKU, return other SKUs that share the same series and look
      like plausible sibling variants (based on shared base-name). Powers the
      "Add sibling" search in the admin UI.

  POST /api/supplier-sync/variants/ungroup
      Remove `variant_group_id` (and optionally variant_axes) from a list of
      SKUs — either dissolving the group entirely or peeling off members.

  PUT  /api/supplier-sync/variants/set-axes
      Update the variant_axes dict (color / finish / size) on a single SKU.
"""

from __future__ import annotations

import logging
import re
import uuid
from typing import Optional, List, Dict, Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/supplier-sync/variants", tags=["Variants"])
logger = logging.getLogger(__name__)


def _get_db():
    """Lazy import to reuse the same connection factory as supplier_sync."""
    from routes.supplier_sync import get_db
    return get_db()


# --- name parsing --------------------------------------------------------

# Descriptor words we strip from product names when computing the "base"
# used for auto-grouping. Kept aligned with lib/series.js on the frontend so
# backend clusters + frontend rendering agree on what constitutes a series.
COLOR_WORDS = {
    'white','grey','gray','black','beige','cream','brown','blue','green',
    'red','pink','yellow','orange','purple','silver','gold','ivory',
    'charcoal','anthracite','taupe','sand','bone','pearl','light','dark',
    'crema','bianco','grigio','nero','avorio','noce','cenere','pietra',
    'polvere','verde','rosa','marfil','blanco','gris','perla','ceniza',
    'grafito','hueso','arena','marengo','roble','terra','acacia','arce',
    'nuez','moonstone','oxide','carbon','onyx',
}
FINISH_WORDS = {
    'matt','matte','gloss','glossy','polished','honed','satin','rustic',
    'brushed','structured','tumbled','textured','embossed','lappato','lapato',
    'silk','smooth','flamed','riven','hammered','glazed','unglazed','high-gloss',
}
# Attribute noise stripped from base name (not tracked as an axis).
NOISE_WORDS = {
    'tile','tiles','wall','floor','and','slabs','slab','effect','marble','wood',
    'concrete','ceramic','porcelain','laminate','engineered','lvt','plank',
}
DIMENSION_RE = re.compile(r'^(\d+(?:\.\d+)?)[xX](\d+(?:\.\d+)?)(mm|cm)?$')


def _tokenize(name: str) -> List[str]:
    """Split concatenated dimension tokens (\"Decor25x60cm\" → [\"Decor\", \"25x60cm\"])."""
    out: List[str] = []
    for part in re.split(r'\s+', (name or '').strip()):
        m = re.match(r'^([A-Za-z]+)(\d+(?:\.\d+)?[xX]\d+.*)$', part)
        if m:
            out.append(m.group(1))
            out.append(m.group(2))
        else:
            out.append(part)
    return [p for p in out if p]


def _extract_axes(name: str) -> Dict[str, Optional[str]]:
    """Extract candidate color/finish/size values from a raw product name.

    Falls back to None per axis when the token isn't found — the admin can
    still hand-edit the axes dict via set-axes.
    """
    color = finish = size = None
    for tok in _tokenize(name):
        low = tok.lower()
        if size is None and DIMENSION_RE.match(tok):
            m = DIMENSION_RE.match(tok)
            unit = (m.group(3) or 'cm').lower()
            size = f"{m.group(1)}x{m.group(2)}{unit}"
            continue
        if color is None and low in COLOR_WORDS:
            color = tok.title()
            continue
        if finish is None and low in FINISH_WORDS:
            finish = tok.title()
            continue
    return {"color": color, "finish": finish, "size": size}


def _base_name(name: str) -> str:
    """Strip color / finish / dimension / noise tokens → the group base name.

    E.g. \"Moonstone Ivory 30x60cm Matt Wall Tile\" → \"Moonstone\"
    """
    kept: List[str] = []
    for tok in _tokenize(name):
        low = tok.lower()
        if DIMENSION_RE.match(tok):
            continue
        if low in COLOR_WORDS or low in FINISH_WORDS or low in NOISE_WORDS:
            continue
        kept.append(tok)
    return ' '.join(kept).strip()


# --- request/response models ---------------------------------------------

class CreateGroupItem(BaseModel):
    sku: str
    color: Optional[str] = None
    finish: Optional[str] = None
    size: Optional[str] = None


class CreateGroupRequest(BaseModel):
    items: List[CreateGroupItem]
    group_id: Optional[str] = None  # Client may supply a specific id; else generated.


class AutoGroupRequest(BaseModel):
    series: Optional[str] = None
    supplier: Optional[str] = None
    dry_run: bool = False  # Preview clusters without writing.


class UngroupRequest(BaseModel):
    skus: List[str]
    clear_axes: bool = False


class SetAxesRequest(BaseModel):
    sku: str
    color: Optional[str] = None
    finish: Optional[str] = None
    size: Optional[str] = None
    display_order: Optional[int] = None


# --- endpoints -----------------------------------------------------------

@router.post("/create-group")
def create_group(data: CreateGroupRequest):
    """Tag every SKU in `items` with the same group_id and their variant axes."""
    if not data.items:
        raise HTTPException(status_code=400, detail="At least one SKU is required")
    db = _get_db()
    group_id = data.group_id or str(uuid.uuid4())
    updated = 0
    failed: List[str] = []
    for i, it in enumerate(data.items):
        try:
            res = db.supplier_products.update_one(
                {"sku": it.sku},
                {"$set": {
                    "variant_group_id": group_id,
                    "variant_axes": {
                        "color": it.color,
                        "finish": it.finish,
                        "size": it.size,
                    },
                    "variant_display_order": i,
                }},
            )
            if res.matched_count > 0:
                updated += 1
            else:
                failed.append(it.sku)
        except Exception as e:
            logger.error(f"create_group: failed on sku={it.sku}: {e}")
            failed.append(it.sku)
    return {"success": True, "group_id": group_id, "updated": updated, "failed": failed}


@router.post("/auto-group-from-series")
def auto_group_from_series(data: AutoGroupRequest):
    """Cluster products in a given series (or supplier) by base-name and create
    one variant group per cluster. Returns the clusters that would be / were
    created."""
    db = _get_db()
    q: Dict[str, Any] = {}
    if data.supplier:
        q["supplier"] = data.supplier
    # Prefer explicit series match; if not present accept any product whose
    # extracted series matches (backend-side).
    products = list(db.supplier_products.find(q).limit(5000))
    if data.series:
        target = data.series.strip().lower()
        products = [
            p for p in products if (
                target in (p.get("series") or "").lower() or
                target in (p.get("range_name") or "").lower() or
                target in (p.get("original_series") or "").lower() or
                target in (p.get("display_name") or "").lower() or
                target in (_base_name(p.get("display_name") or p.get("name") or "").lower())
            )
        ]

    # Cluster by (base_name, supplier)
    # Prefer display_name (customer-facing name used by lib/series.js on the
    # frontend) so backend clusters agree with the "Premium Oak Series" banner
    # rendered on the Manager page. Fall back to internal name/product_name.
    clusters: Dict[str, List[Dict[str, Any]]] = {}
    for p in products:
        name = p.get("display_name") or p.get("name") or p.get("product_name") or ""
        base = _base_name(name)
        if not base:
            continue
        key = f"{base.lower()}|{(p.get('supplier') or '').lower()}"
        clusters.setdefault(key, []).append(p)

    # Discard singletons — a "variant group" of 1 is useless.
    result_clusters: List[Dict[str, Any]] = []
    total_grouped = 0
    for key, members in clusters.items():
        if len(members) < 2:
            continue
        base_name = key.split("|")[0]
        group_id = str(uuid.uuid4())
        member_details = []
        # Determine axis values for each member.
        for i, p in enumerate(sorted(members, key=lambda x: x.get("display_name") or x.get("name") or "")):
            axes = _extract_axes(p.get("display_name") or p.get("name") or "")
            # Prefer any explicit fields on the product row over parsed values.
            axes["color"] = p.get("color") or axes["color"]
            axes["finish"] = p.get("finish") or axes["finish"]
            axes["size"] = p.get("size") or axes["size"]
            member_details.append({
                "sku": p.get("sku"),
                "name": p.get("display_name") or p.get("name"),
                **axes,
            })
            if not data.dry_run:
                db.supplier_products.update_one(
                    {"sku": p.get("sku")},
                    {"$set": {
                        "variant_group_id": group_id,
                        "variant_axes": axes,
                        "variant_display_order": i,
                    }},
                )
        result_clusters.append({
            "group_id": group_id,
            "base_name": base_name,
            "supplier": members[0].get("supplier"),
            "member_count": len(members),
            "members": member_details,
        })
        total_grouped += len(members)

    return {
        "success": True,
        "dry_run": data.dry_run,
        "clusters_found": len(result_clusters),
        "products_grouped": total_grouped,
        "clusters": result_clusters,
    }


@router.get("/group/{group_id}")
def get_group(group_id: str):
    """Return every SKU sharing this variant_group_id."""
    db = _get_db()
    products = list(db.supplier_products.find(
        {"variant_group_id": group_id},
        {
            "sku": 1, "name": 1, "product_name": 1, "supplier": 1,
            "variant_axes": 1, "variant_display_order": 1,
            "price": 1, "sale_price": 1, "images": 1, "image": 1,
            "in_stock": 1, "stock_quantity": 1,
        },
    ).sort("variant_display_order", 1))
    for p in products:
        p["_id"] = str(p.get("_id"))
    return {
        "group_id": group_id,
        "member_count": len(products),
        "members": products,
    }


@router.get("/candidates")
def find_candidates(sku: str):
    """For the given SKU return other SKUs from the same series that look like
    plausible sibling variants — used to power the "Add sibling" picker."""
    db = _get_db()
    src = db.supplier_products.find_one({"sku": sku})
    if not src:
        raise HTTPException(status_code=404, detail=f"SKU '{sku}' not found")
    supplier = src.get("supplier")
    # Prefer display_name (customer-facing) — aligned with lib/series.js on the
    # frontend so backend candidate matching agrees with the visible series banner.
    src_base = _base_name(src.get("display_name") or src.get("name") or "").lower()
    if not src_base:
        return {"sku": sku, "candidates": []}

    q: Dict[str, Any] = {"sku": {"$ne": sku}}
    if supplier:
        q["supplier"] = supplier
    candidates: List[Dict[str, Any]] = []
    for p in db.supplier_products.find(q).limit(500):
        pname = p.get("display_name") or p.get("name") or ""
        base = _base_name(pname).lower()
        if not base:
            continue
        if base == src_base:
            axes = _extract_axes(pname)
            candidates.append({
                "sku": p.get("sku"),
                "name": p.get("display_name") or p.get("name"),
                "supplier": p.get("supplier"),
                "variant_group_id": p.get("variant_group_id"),
                **axes,
            })
    return {"sku": sku, "base_name": src_base, "candidates": candidates}


@router.post("/ungroup")
def ungroup(data: UngroupRequest):
    """Remove `variant_group_id` from the listed SKUs. Optionally clear their
    variant_axes too."""
    if not data.skus:
        raise HTTPException(status_code=400, detail="At least one SKU is required")
    db = _get_db()
    unset_fields = {"variant_group_id": "", "variant_display_order": ""}
    if data.clear_axes:
        unset_fields["variant_axes"] = ""
    res = db.supplier_products.update_many(
        {"sku": {"$in": data.skus}},
        {"$unset": unset_fields},
    )
    return {"success": True, "modified": res.modified_count}


@router.put("/set-axes")
def set_axes(data: SetAxesRequest):
    """Set the color / finish / size values on ONE SKU."""
    db = _get_db()
    src = db.supplier_products.find_one({"sku": data.sku})
    if not src:
        raise HTTPException(status_code=404, detail=f"SKU '{data.sku}' not found")
    axes = src.get("variant_axes") or {}
    if data.color is not None:
        axes["color"] = data.color or None
    if data.finish is not None:
        axes["finish"] = data.finish or None
    if data.size is not None:
        axes["size"] = data.size or None
    set_fields: Dict[str, Any] = {"variant_axes": axes}
    if data.display_order is not None:
        set_fields["variant_display_order"] = data.display_order
    db.supplier_products.update_one({"sku": data.sku}, {"$set": set_fields})
    return {"success": True, "sku": data.sku, "variant_axes": axes}

"""
Group Cleanup — flags live products whose name/category disagrees with their
product_group so the admin can re-assign them in one sweep.
Zero-button UX: the admin UI only shows a banner when mismatches exist.
"""
from fastapi import APIRouter, HTTPException
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime, timezone
import os
import re
import logging

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/group-cleanup", tags=["Group Cleanup"])

MONGO_URL = os.environ.get("MONGO_URL")
DB_NAME = os.environ.get("DB_NAME", "tile_station")
client = AsyncIOMotorClient(MONGO_URL)
db = client[DB_NAME]

VALID_GROUPS = ["tiles", "flooring", "materials", "underfloor-heating", "bathroom", "tools-accessories"]
MAIN_CAT = {
    "tiles": "Tiles",
    "flooring": "Flooring",
    "materials": "Materials",
    "underfloor-heating": "Underfloor Heating",
    "bathroom": "Bathroom",
    "tools-accessories": "Tools & Accessories",
}

# First match wins — most specific signals first, tiles last (broadest)
NAME_RULES = [
    ("underfloor-heating", r"underfloor heat|under floor heat|\bufh\b|thermostat|heating (mat|cable|film)|insulation board|mesh \d+\s?w\b|\d+\s?w/m|heat mat"),
    ("tools-accessories", r"trowel|tile spacer|\bspacers?\b|tile cutter|cutting wheel|drill bit|levell?ing (clip|wedge|system)|mixing paddle|tile saw|grout float|scriber|knee pad|tile trim"),
    ("materials", r"adhesive|\bgrout\b|grouting|sealant|silicone|\bprimer\b|levell?ing compound|self.?levell?ing|waterproofing|tanking|decoupling|matting|\bcleaner\b|maintenance kit"),
    ("bathroom", r"\btoilet\b|\bbasin\b|cistern|vanity unit|shower (tray|enclosure|screen|valve)|towel (rail|radiator)|\bwc\b|bathtub|mixer tap"),
    ("flooring", r"engineered wood|engineered oak|\blaminate\b|\blvt\b|\bspc\b|\bvinyl\b|solid wood|wood floor|parquet|floor plank|click floor"),
    ("tiles", r"\btiles?\b|mosaic|\bporcelain\b|\bceramic\b"),
]
CATEGORY_RULES = [
    ("underfloor-heating", r"underfloor|\bufh\b|thermostat|insulation"),
    ("tools-accessories", r"trim|tool|spacer|cutter|profile|threshold|trowel|levell?ing system"),
    ("materials", r"adhesive|grout|sealant|primer|levell?ing compound|waterproof|cleaning"),
    ("bathroom", r"toilet|basin|shower|vanity|^bathroom$"),
    ("flooring", r"^flooring$|laminate|\blvt\b|\bspc\b|vinyl|engineered|solid wood"),
    ("tiles", r"tile|wall & floor|wall and floor|mosaic"),
]
FLOORING_MATERIALS = ("engineered wood", "engineered oak", "laminate", "spc lvt", "lvt", "spc", "solid oak", "solid wood", "vinyl")


def normalize_group(g) -> Optional[str]:
    g = str(g or "").strip().lower().replace("_", "-").replace(" ", "-")
    if not g:
        return None
    if "underfloor" in g or g == "ufh":
        return "underfloor-heating"
    if g.startswith("tool") or "accessor" in g:
        return "tools-accessories"
    if "tile" in g and "trim" not in g:
        return "tiles"
    if g in ("materials", "material"):
        return "materials"
    if g in ("flooring", "floor", "floors"):
        return "flooring"
    if g in ("bathroom", "bathrooms"):
        return "bathroom"
    return g


def _match_rules(text: str, rules):
    for grp, rx in rules:
        m = re.search(rx, text, re.IGNORECASE)
        if m:
            return grp, m.group(0)
    return None, None


def suggest_group(doc: dict):
    """Return (suggested_group, reason) or (None, None) when signals are unclear."""
    attrs = doc.get("attributes") or {}
    mat_bits = [attrs.get("material"), doc.get("material")]
    if isinstance(doc.get("materials"), list):
        mat_bits.extend(doc["materials"])
    mat_blob = " ".join(str(x) for x in mat_bits if x).lower()

    for fm in FLOORING_MATERIALS:
        if fm in mat_blob:
            return "flooring", f'material is "{fm}"'

    name = " ".join(str(doc.get(k) or "") for k in ("name", "display_name"))
    grp, kw = _match_rules(f"{name} {mat_blob}", NAME_RULES)
    if grp:
        return grp, f'name contains "{kw}"'

    category = str(doc.get("category") or "").strip()
    if category:
        grp, kw = _match_rules(category, CATEGORY_RULES)
        if grp:
            return grp, f'category is "{category}"'
    return None, None


def classify_supplier_product(sp: dict) -> Optional[str]:
    """Publish-time guard: best-guess group for a supplier_products draft."""
    doc = {
        "name": sp.get("our_product_name") or sp.get("product_name") or sp.get("name") or "",
        "display_name": sp.get("display_name") or "",
        "material": sp.get("material"),
        "materials": sp.get("materials") if isinstance(sp.get("materials"), list) else [],
        "category": sp.get("category") or "",
    }
    grp, _ = suggest_group(doc)
    return grp


@router.get("/mismatches")
async def get_group_mismatches():
    """Scan live products and return those whose name/category suggests a
    different product_group than the one they're assigned to."""
    docs = await db.tiles.find(
        {"product_group": {"$nin": ["samples", None, ""]}},
        {"_id": 0, "sku": 1, "name": 1, "display_name": 1, "category": 1,
         "product_group": 1, "attributes.material": 1, "material": 1,
         "materials": 1, "image": 1, "images": 1},
    ).to_list(20000)

    items, seen = [], set()
    for d in docs:
        sku = d.get("sku")
        if not sku or sku in seen:
            continue
        current = normalize_group(d.get("product_group"))
        if current not in VALID_GROUPS:
            continue
        suggested, reason = suggest_group(d)
        if not suggested or suggested == current:
            continue
        seen.add(sku)
        img = None
        if isinstance(d.get("images"), list):
            img = next((i for i in d["images"] if i), None)
        img = img or d.get("image")
        items.append({
            "sku": sku,
            "name": d.get("display_name") or d.get("name") or sku,
            "image": img,
            "current_group": current,
            "current_group_raw": d.get("product_group"),
            "suggested_group": suggested,
            "reason": reason,
        })

    by_group = {}
    for i in items:
        by_group[i["suggested_group"]] = by_group.get(i["suggested_group"], 0) + 1
    return {"total": len(items), "items": items[:1000], "by_group": by_group}


class ReassignItem(BaseModel):
    sku: str
    target_group: str


class ReassignRequest(BaseModel):
    items: List[ReassignItem]


@router.post("/reassign")
async def reassign_groups(req: ReassignRequest):
    """Sweep re-assign: sets product_group + main_category on BOTH tiles (live)
    and supplier_products (admin drafts) so storefront + managers stay in sync."""
    if not req.items:
        raise HTTPException(status_code=400, detail="No items provided")
    invalid = sorted({i.target_group for i in req.items if i.target_group not in VALID_GROUPS})
    if invalid:
        raise HTTPException(status_code=400, detail=f"Invalid target groups: {invalid}. Must be one of {VALID_GROUPS}")

    by_target = {}
    for i in req.items:
        by_target.setdefault(i.target_group, []).append(i.sku)

    now = datetime.now(timezone.utc)
    updated_tiles = updated_supplier = 0
    for grp, skus in by_target.items():
        fields = {"product_group": grp, "main_category": MAIN_CAT[grp], "updated_at": now}
        r1 = await db.tiles.update_many({"sku": {"$in": skus}}, {"$set": fields})
        r2 = await db.supplier_products.update_many({"sku": {"$in": skus}}, {"$set": fields})
        updated_tiles += r1.modified_count
        updated_supplier += r2.modified_count
        logger.info(f"Group cleanup: moved {len(skus)} SKUs -> {grp} (tiles={r1.modified_count}, supplier={r2.modified_count})")

    return {
        "success": True,
        "updated_tiles": updated_tiles,
        "updated_supplier_products": updated_supplier,
        "message": f"Re-assigned {len(req.items)} product(s) across {len(by_target)} group(s)",
    }

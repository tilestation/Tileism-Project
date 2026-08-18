"""
Attribute value presets — powers "pick instead of type" suggestions in the
Manager bulk editors. Values are the union of everything already used on
supplier_products plus any manually saved values.
"""
import os
from datetime import datetime, timezone
from typing import List

from fastapi import APIRouter
from pydantic import BaseModel
from pymongo import MongoClient

router = APIRouter(prefix="/attribute-values", tags=["Attribute Values"])


def _db():
    return MongoClient(os.environ.get("MONGO_URL"))[os.environ.get("DB_NAME", "tile_station")]


@router.get("")
def get_attribute_values(fields: str):
    """fields = comma-separated field keys, e.g. finish,material,size,color"""
    field_list = [f.strip() for f in fields.split(",") if f.strip()][:25]
    db = _db()
    docs = {d["field"]: d for d in db.attribute_value_presets.find({"field": {"$in": field_list}})}
    out = {}
    for f in field_list:
        doc = docs.get(f, {})
        hidden = {h.strip().lower() for h in doc.get("hidden", []) if isinstance(h, str) and h.strip()}
        saved_vals = sorted(
            {v.strip() for v in doc.get("values", []) if isinstance(v, str) and v.strip() and v.strip().lower() not in hidden},
            key=str.lower,
        )
        distinct_vals = set()
        try:
            for v in db.supplier_products.distinct(f):
                if isinstance(v, list):
                    for x in v:
                        if isinstance(x, str) and x.strip():
                            distinct_vals.add(x.strip())
                elif isinstance(v, str) and v.strip():
                    distinct_vals.add(v.strip())
                elif isinstance(v, (int, float)) and not isinstance(v, bool):
                    distinct_vals.add(str(v))
        except Exception:
            pass
        # Manually saved values first, then everything already in use.
        # Case-insensitive dedupe (e.g. 'Italy' vs 'italy' → keep one).
        seen = {s.lower() for s in saved_vals}
        rest = []
        for v in sorted(distinct_vals, key=str.lower):
            if v.lower() in seen or v.lower() in hidden:
                continue
            seen.add(v.lower())
            rest.append(v)
        out[f] = (saved_vals + rest)[:100]
    return {"values": out}


class SaveValuesRequest(BaseModel):
    field: str
    values: List[str]


@router.post("/save")
def save_attribute_values(req: SaveValuesRequest):
    cleaned = [v.strip() for v in req.values if isinstance(v, str) and v.strip()][:50]
    if not cleaned:
        return {"saved": 0}
    db = _db()
    # Re-saving a value un-hides it
    doc = db.attribute_value_presets.find_one({"field": req.field}) or {}
    cleaned_lower = {c.lower() for c in cleaned}
    hidden = [h for h in doc.get("hidden", []) if isinstance(h, str) and h.strip().lower() not in cleaned_lower]
    db.attribute_value_presets.update_one(
        {"field": req.field},
        {"$addToSet": {"values": {"$each": cleaned}},
         "$set": {"hidden": hidden, "updated_at": datetime.now(timezone.utc).isoformat()}},
        upsert=True,
    )
    return {"saved": len(cleaned)}


class RemoveValueRequest(BaseModel):
    field: str
    value: str


@router.post("/remove")
def remove_attribute_value(req: RemoveValueRequest):
    """Delete a saved value chip. Also hides it from in-use suggestions."""
    v = req.value.strip()
    if not v:
        return {"removed": False}
    db = _db()
    doc = db.attribute_value_presets.find_one({"field": req.field}) or {}
    keep = [x for x in doc.get("values", []) if isinstance(x, str) and x.strip().lower() != v.lower()]
    db.attribute_value_presets.update_one(
        {"field": req.field},
        {"$set": {"values": keep, "updated_at": datetime.now(timezone.utc).isoformat()},
         "$addToSet": {"hidden": v}},
        upsert=True,
    )
    return {"removed": True}

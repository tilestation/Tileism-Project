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
    saved = {d["field"]: d.get("values", []) for d in db.attribute_value_presets.find({"field": {"$in": field_list}})}
    out = {}
    for f in field_list:
        saved_vals = sorted({v.strip() for v in saved.get(f, []) if isinstance(v, str) and v.strip()}, key=str.lower)
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
            if v.lower() in seen:
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
    _db().attribute_value_presets.update_one(
        {"field": req.field},
        {"$addToSet": {"values": {"$each": cleaned}},
         "$set": {"updated_at": datetime.now(timezone.utc).isoformat()}},
        upsert=True,
    )
    return {"saved": len(cleaned)}

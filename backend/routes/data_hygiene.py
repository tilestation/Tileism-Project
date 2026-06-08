"""
Data Hygiene — admin maintenance tools (8 Jun 2026).

Born from the Tonbridge bug: one user had `showroom_name = "Tile Station
Tonbridge"` while three others had `"Tonbridge"`. Same `showroom_id`,
but the league split them. The defensive bucket-by-id fix is live in
`staff_leaderboard.py`, but the underlying data drift still poisons
EPOS exports, sales-by-store reports, and anywhere else the freetext
label leaks out — so this module surfaces every such drift and lets
admins fix it in one click.

Endpoints
---------
- GET  /api/admin/data-hygiene/scan
      Returns 4 sections:
        1. drifted_labels — records whose stamped `showroom_name`
           disagrees with the canonical `showrooms.name` (by id)
        2. orphan_showroom_name — records carrying a name but no id
           (so they can't be auto-resolved)
        3. unmapped_showroom_id — records with an id pointing at a
           showroom doc that no longer exists
        4. near_duplicate_showrooms — showroom docs whose names
           normalise to the same key (e.g. "Tonbridge" vs "Tile
           Station Tonbridge"), so the admin can merge them.

- POST /api/admin/data-hygiene/fix
      Apply one issue's fix. Body:
        { "issue_type": "drifted_labels" | "orphan_showroom_name",
          "scope": "one" | "group",
          "collection": "users" | "quotations" | "invoices",
          "showroom_id": "<id>",                # for group scope
          "record_ids": ["<id>", ...]           # for one scope
        }

Super-admin only — destructive enough that we don't want managers
touching it.
"""
import logging
import re
from typing import List, Literal, Optional
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from config import get_db
from services import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin/data-hygiene", tags=["Data Hygiene"])


# ---------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------
def _require_super_admin(current_user: dict):
    if (current_user or {}).get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super admin only")


def _normalise(name: str) -> str:
    """Lowercased, stripped, prefix-tolerant key so 'Tile Station
    Tonbridge' and 'Tonbridge' compare equal — used only for
    near-duplicate showroom detection, never for write paths."""
    n = (name or "").strip().lower()
    n = re.sub(r"^(tile\s+station|the)\s+", "", n)
    n = re.sub(r"\s+", " ", n)
    return n


async def _load_canonical_names() -> dict:
    """{showroom_id_str: canonical_name} from `db.showrooms`."""
    db = get_db()
    out: dict = {}
    async for sr in db.showrooms.find({}, {"name": 1}):
        sid = str(sr.get("_id") or "")
        nm = (sr.get("name") or "").strip()
        if sid and nm:
            out[sid] = nm
    return out


# ---------------------------------------------------------------------
# GET /scan
# ---------------------------------------------------------------------
@router.get("/scan")
async def scan_data_hygiene(current_user: dict = Depends(get_current_user)):
    _require_super_admin(current_user)
    db = get_db()
    canonical = await _load_canonical_names()

    # 1. Drifted labels — same id, different stamped name
    drifted: list = []
    # 2. Orphan showroom_name — name stamped but no id
    orphans: list = []
    # 3. Unmapped showroom_id — id stamped but showroom deleted
    unmapped: list = []

    async def _scan_collection(coll_name: str, label_field: str = "id"):
        coll = getattr(db, coll_name)
        # Only fetch records that have either a stamped name or an id
        cursor = coll.find(
            {
                "$or": [
                    {"showroom_name": {"$exists": True, "$ne": ""}},
                    {"showroom_id": {"$exists": True, "$ne": ""}},
                ]
            },
            {
                "_id": 1, "id": 1, "showroom_id": 1, "showroom_name": 1,
                "name": 1, "email": 1,            # users
                "quotation_number": 1,             # quotations
                "invoice_number": 1,               # invoices
                "created_at": 1,
            },
        )
        async for doc in cursor:
            sid = (doc.get("showroom_id") or "").strip()
            sname = (doc.get("showroom_name") or "").strip()
            rid = doc.get("id") or str(doc.get("_id"))
            display_label = (
                doc.get("quotation_number")
                or doc.get("invoice_number")
                or doc.get("name")
                or doc.get("email")
                or rid
            )
            if sid:
                canon = canonical.get(sid)
                if canon is None:
                    unmapped.append({
                        "collection": coll_name,
                        "record_id": rid,
                        "label": display_label,
                        "stamped_showroom_id": sid,
                        "stamped_showroom_name": sname,
                    })
                elif sname and sname != canon:
                    drifted.append({
                        "collection": coll_name,
                        "record_id": rid,
                        "label": display_label,
                        "showroom_id": sid,
                        "stamped_name": sname,
                        "canonical_name": canon,
                    })
            else:
                if sname:
                    orphans.append({
                        "collection": coll_name,
                        "record_id": rid,
                        "label": display_label,
                        "stamped_name": sname,
                    })

    for coll in ("users", "quotations", "invoices"):
        await _scan_collection(coll)

    # 4. Near-duplicate showroom docs (case-insensitive, prefix-tolerant)
    by_key: dict = {}
    async for sr in db.showrooms.find({}, {"name": 1, "_id": 1}):
        nm = (sr.get("name") or "").strip()
        if not nm:
            continue
        key = _normalise(nm)
        by_key.setdefault(key, []).append({
            "id": str(sr.get("_id")),
            "name": nm,
        })
    near_dupes = [
        {"normalised_key": k, "showrooms": v}
        for k, v in by_key.items()
        if len(v) > 1
    ]

    # Group drifted by canonical name for the "Fix all in group" UX.
    drifted_groups: dict = {}
    for d in drifted:
        grp_key = f"{d['showroom_id']}|{d['stamped_name']}"
        drifted_groups.setdefault(grp_key, {
            "showroom_id": d["showroom_id"],
            "stamped_name": d["stamped_name"],
            "canonical_name": d["canonical_name"],
            "records": [],
        })["records"].append({
            "collection": d["collection"],
            "record_id": d["record_id"],
            "label": d["label"],
        })

    return {
        "scanned_at": datetime.now(timezone.utc).isoformat(),
        "summary": {
            "drifted_labels": len(drifted),
            "orphan_showroom_name": len(orphans),
            "unmapped_showroom_id": len(unmapped),
            "near_duplicate_showrooms": len(near_dupes),
        },
        "drifted_labels": drifted,
        "drifted_groups": list(drifted_groups.values()),
        "orphan_showroom_name": orphans,
        "unmapped_showroom_id": unmapped,
        "near_duplicate_showrooms": near_dupes,
    }


# ---------------------------------------------------------------------
# POST /fix
# ---------------------------------------------------------------------
class FixRequest(BaseModel):
    issue_type: Literal["drifted_labels", "orphan_showroom_name"]
    scope: Literal["one", "group"]
    collection: Literal["users", "quotations", "invoices"]
    # Group scope — rename every record at this showroom_id with this
    # stamped_name to the canonical name.
    showroom_id: Optional[str] = Field(default=None, max_length=120)
    stamped_name: Optional[str] = Field(default=None, max_length=200)
    # One scope — fix a specific list of record ids.
    record_ids: Optional[List[str]] = Field(default=None, max_length=200)
    # For orphan fixes — admin picks the target showroom_id.
    target_showroom_id: Optional[str] = Field(default=None, max_length=120)


@router.post("/fix")
async def apply_fix(
    req: FixRequest,
    current_user: dict = Depends(get_current_user),
):
    _require_super_admin(current_user)
    db = get_db()
    canonical = await _load_canonical_names()
    coll = getattr(db, req.collection)

    # Resolve target name + id depending on issue type
    if req.issue_type == "drifted_labels":
        if not req.showroom_id:
            raise HTTPException(400, "showroom_id required")
        canonical_name = canonical.get(req.showroom_id)
        if not canonical_name:
            raise HTTPException(400, f"Unknown showroom_id {req.showroom_id}")
        target_id = req.showroom_id
        target_name = canonical_name
    else:  # orphan_showroom_name
        if not req.target_showroom_id:
            raise HTTPException(400, "target_showroom_id required for orphan fix")
        canonical_name = canonical.get(req.target_showroom_id)
        if not canonical_name:
            raise HTTPException(400, f"Unknown target_showroom_id {req.target_showroom_id}")
        target_id = req.target_showroom_id
        target_name = canonical_name

    update_doc = {"$set": {
        "showroom_id": target_id,
        "showroom_name": target_name,
        "data_hygiene_fixed_at": datetime.now(timezone.utc).isoformat(),
    }}

    if req.scope == "group":
        if req.issue_type != "drifted_labels":
            raise HTTPException(400, "Group scope only supported for drifted_labels")
        filt = {
            "showroom_id": req.showroom_id,
            "showroom_name": req.stamped_name,
        }
        result = await coll.update_many(filt, update_doc)
        return {
            "ok": True,
            "matched": result.matched_count,
            "modified": result.modified_count,
            "renamed_to": target_name,
        }

    # scope == "one"
    if not req.record_ids:
        raise HTTPException(400, "record_ids required for one-scope")
    # `id` is the canonical app-level id (uuid string); fall back to
    # `_id` (ObjectId) when callers send Mongo-native ids.
    from bson import ObjectId
    or_clauses: list = [{"id": {"$in": req.record_ids}}]
    obj_ids: list = []
    for r in req.record_ids:
        try:
            obj_ids.append(ObjectId(r))
        except Exception:
            continue
    if obj_ids:
        or_clauses.append({"_id": {"$in": obj_ids}})
    result = await coll.update_many({"$or": or_clauses}, update_doc)
    return {
        "ok": True,
        "matched": result.matched_count,
        "modified": result.modified_count,
        "renamed_to": target_name,
    }

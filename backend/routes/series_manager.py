"""Series / Collection manager endpoints.

The admin needs a fast way to bucket supplier products into series (a.k.a.
collections / ranges) — e.g. every "Cleaning & Maintenance - UltrTile ..." row
should sit under the "Cleaning & Maintenance" series, and every
"Flowable Grout ..." row should sit under "Flowable Grout".

Two flows are supported:

* Auto-Assign — parses `product_name` for every product in a supplier and
  proposes a series bucket per detected prefix. Admin approves in the UI and
  the backend writes `range_name` for every matching product.
* Bulk-Assign — the admin ticks any number of products in the Supplier
  Products list and posts `{items: [{sku, series}], ...}` to explicitly set
  their series in one call.

Series is stored in `supplier_products.range_name`. The frontend's
`getSeriesName()` already prefers `range_name` over the parsed-from-name
default, so setting the field is enough to fix the display everywhere.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from config import get_db
from services import get_current_user, has_permission, log_audit


router = APIRouter(prefix="/admin/series", tags=["Series Manager"])


# Words that indicate a color/finish/size — the extractor drops these when
# parsing a series name out of a product name. Mirrors the frontend list at
# /app/frontend/src/pages/admin/SupplierProducts.js#SERIES_COLOR_WORDS.
_COLOR_WORDS = {
    "white", "grey", "gray", "black", "beige", "cream", "brown", "blue", "green",
    "red", "pink", "yellow", "orange", "purple", "silver", "gold", "ivory",
    "charcoal", "anthracite", "taupe", "sand", "bone", "pearl", "light", "dark",
    "graphite", "slate", "onyx", "ice", "snow", "carbon", "smoky", "greige",
    "platinum", "titanium", "pewter", "lead", "violet", "lilac", "lavender",
    "mauve", "coral", "salmon", "blush", "rose", "orchid", "magenta",
    "burgundy", "maroon", "garnet", "bordeaux", "ruby", "wine", "claret",
    "rust", "terracotta", "copper", "bronze", "brass", "amber", "honey",
    "caramel", "walnut", "chocolate", "coffee", "mocha", "cinnamon",
    "chestnut", "smoke", "ash",
}
_ATTR_WORDS = {
    "outdoor", "indoor", "external", "internal", "rectified", "unrectified",
    "honed", "lappato", "structured", "polished", "matt", "matte", "gloss",
    "glossy", "satin", "silk", "rustic", "linear", "textured", "embossed",
    "riven", "tumbled", "brushed", "glazed", "unglazed", "smooth",
    "tiles", "tile", "wall", "floor", "and", "effect", "marble", "wood",
    "concrete", "ceramic", "metro", "porcelain",
}


def _looks_like_dimension(tok: str) -> bool:
    """Return True for tokens like `600x600`, `30x60cm`, `15kg`, `1L`."""
    t = tok.lower()
    if any(ch.isdigit() for ch in t) and any(ch in t for ch in ("x", "cm", "mm", "kg", "l", "g")):
        return True
    return False


def _extract_series(product_name: str) -> str:
    """Best-effort series name extractor. Matches the frontend logic:
    1. If `" - "` appears in the name, everything before it is the series.
    2. Otherwise walk the tokens from the left and stop at the first token
       that looks like a color / finish / dimension.
    """
    if not product_name:
        return ""
    if " - " in product_name:
        prefix = product_name.split(" - ", 1)[0].strip()
        if prefix:
            return prefix

    tokens = product_name.strip().split()
    keep: list[str] = []
    for tok in tokens:
        low = tok.lower().strip(",.-")
        if low in _COLOR_WORDS or low in _ATTR_WORDS:
            break
        if _looks_like_dimension(low):
            break
        keep.append(tok)
        if len(keep) >= 4:  # cap series names at 4 words
            break
    # Fallback — if we kept nothing (all tokens looked like colors), use the
    # very first word so we still get some grouping.
    if not keep and tokens:
        return tokens[0]
    return " ".join(keep).strip()


@router.get("/auto-suggest")
async def auto_suggest_series(
    supplier: Optional[str] = Query(None, description="Optional supplier to scope the scan"),
    only_missing: bool = Query(
        True,
        description="Skip products that already have an explicit `range_name` set (safer default so a rescan doesn't overwrite manual assignments).",
    ),
    current_user: dict = Depends(get_current_user),
):
    """Return a proposed grouping — each bucket has a series name, the SKUs
    that fell into it, and a few sample product names.
    """
    if not has_permission(current_user, "supplier_products"):
        raise HTTPException(403, "You need the Supplier Products permission")

    db = get_db()
    filt: dict = {
        "$or": [{"deleted_at": {"$exists": False}}, {"deleted_at": None}],
    }
    if supplier:
        filt["supplier"] = supplier
    if only_missing:
        # Consider a product "already assigned" if EITHER `series` or `range_name` is set.
        filt["$and"] = [
            {"$or": [{"series": {"$exists": False}}, {"series": None}, {"series": ""}]},
            {"$or": [{"range_name": {"$exists": False}}, {"range_name": None}, {"range_name": ""}]},
        ]

    buckets: dict[str, dict] = {}
    total_scanned = 0
    async for doc in db.supplier_products.find(filt).limit(10000):
        total_scanned += 1
        pn = doc.get("product_name") or doc.get("name") or ""
        series = _extract_series(pn)
        if not series:
            continue
        b = buckets.setdefault(series, {"series": series, "items": [], "samples": []})
        b["items"].append({"sku": doc.get("sku") or doc.get("supplier_code"), "product_name": pn})
        if len(b["samples"]) < 3:
            b["samples"].append(pn)

    # Sort by product count desc so the biggest buckets sit at the top.
    ordered = sorted(
        (
            {"series": v["series"], "product_count": len(v["items"]), "samples": v["samples"], "skus": [it["sku"] for it in v["items"] if it["sku"]]}
            for v in buckets.values()
        ),
        key=lambda x: -x["product_count"],
    )
    return {"total_scanned": total_scanned, "buckets": ordered}


class BulkAssignItem(BaseModel):
    sku: str = Field(min_length=1)
    series: str = Field(min_length=1)


class BulkAssignRequest(BaseModel):
    items: list[BulkAssignItem]
    supplier: Optional[str] = Field(default=None, description="Extra safety filter — only rows on this supplier get updated")


@router.post("/bulk-assign")
async def bulk_assign_series(
    payload: BulkAssignRequest,
    current_user: dict = Depends(get_current_user),
):
    """Set `range_name` for every product in the payload. Idempotent — hitting
    the endpoint twice with the same input produces the same result. Returns
    per-item outcome so the UI can flag any rows that didn't match.
    """
    if not has_permission(current_user, "supplier_products"):
        raise HTTPException(403, "You need the Supplier Products permission")

    db = get_db()
    now = datetime.now(timezone.utc)
    updated = 0
    failed: list[dict] = []

    for it in payload.items:
        q: dict = {"$or": [{"sku": it.sku}, {"supplier_code": it.sku}]}
        if payload.supplier:
            q["supplier"] = payload.supplier
        try:
            # Write to BOTH `series` (what the /supplier-sync/products list endpoint
            # returns to the frontend) AND `range_name` (kept as an admin
            # override audit-friendly field). We also OVERWRITE `unique_name`,
            # `series_name`, and `original_series` unconditionally — legacy
            # Canopy imports dumped the full product name into those fields,
            # which would win the display priority chain and drag the row
            # into a phantom series bucket. Setting them all to the new
            # value keeps every downstream code path in sync.
            res = await db.supplier_products.update_one(
                q,
                {"$set": {
                    "series": it.series.strip(),
                    "range_name": it.series.strip(),
                    "series_name": it.series.strip(),
                    "unique_name": it.series.strip(),
                    "original_series": it.series.strip(),
                    "updated_at": now,
                    "range_assigned_by": current_user.get("email"),
                }},
            )
            if res.matched_count == 0:
                failed.append({"sku": it.sku, "reason": "not_found"})
                continue
            if res.modified_count:
                updated += 1
        except Exception as e:
            failed.append({"sku": it.sku, "reason": str(e)})

    await log_audit(
        action="SERIES_BULK_ASSIGN",
        entity_type="supplier_product",
        user=current_user,
        entity_id="bulk-series",
        entity_name=f"Assigned series to {updated} product(s)",
        after_data={"updated": updated, "failed_count": len(failed), "supplier_filter": payload.supplier, "sample_items": [it.dict() for it in payload.items[:5]]},
    )
    return {"ok": True, "updated": updated, "failed": failed}


@router.post("/apply-suggestions")
async def apply_series_suggestions(
    supplier: Optional[str] = Query(None, description="Optional supplier scope"),
    only_missing: bool = Query(True),
    current_user: dict = Depends(get_current_user),
):
    """One-click apply: run auto-suggest and immediately write every proposed
    series into the matching `range_name`. Convenience wrapper so the admin
    doesn't have to POST every bucket manually if they trust the parser.
    """
    if not has_permission(current_user, "supplier_products"):
        raise HTTPException(403, "You need the Supplier Products permission")

    suggestion = await auto_suggest_series(supplier=supplier, only_missing=only_missing, current_user=current_user)  # type: ignore[arg-type]

    items = []
    for bucket in suggestion["buckets"]:
        for sku in bucket["skus"]:
            if sku:
                items.append(BulkAssignItem(sku=sku, series=bucket["series"]))

    req = BulkAssignRequest(items=items, supplier=supplier)
    return await bulk_assign_series(payload=req, current_user=current_user)  # type: ignore[arg-type]


@router.post("/heal-drift")
async def heal_series_drift(
    supplier: Optional[str] = Query(None, description="Optional supplier scope"),
    current_user: dict = Depends(get_current_user),
):
    """One-click sweep that scrubs stale series values across the whole DB.

    For every supplier product we look at `unique_name`; if it looks like a
    FULL product name (contains ` - `, is longer than 60 chars, or has
    dimension tokens like `60x60cm` / `15kg` / `1L`) it's obviously not a
    series name — most likely leftover Canopy-import junk. We overwrite it
    with a best-effort series parsed from `product_name`, and mirror the same
    value to `series` and `range_name` so every downstream code path stays
    consistent.

    Idempotent — running it twice produces the same result.
    """
    if not has_permission(current_user, "supplier_products"):
        raise HTTPException(403, "You need the Supplier Products permission")

    db = get_db()
    now = datetime.now(timezone.utc)

    def looks_like_full_product_name(v: str) -> bool:
        s = (v or "").strip()
        if len(s) > 60:
            return True
        if " - " in s:
            return True
        # crude dimension detection — matches "60x60", "15kg", "1L" etc.
        import re
        if re.search(r"\d{2,}\s*(x|cm|mm|kg|l|g)\b", s, re.IGNORECASE):
            return True
        return False

    filt: dict = {"$or": [{"deleted_at": {"$exists": False}}, {"deleted_at": None}]}
    if supplier:
        filt["supplier"] = supplier

    scanned = 0
    healed = 0
    per_supplier: dict[str, int] = {}
    async for doc in db.supplier_products.find(filt).limit(20000):
        scanned += 1
        unique_val = str(doc.get("unique_name") or "").strip()
        series_val = str(doc.get("series") or "").strip()
        range_val = str(doc.get("range_name") or "").strip()
        parsed = _extract_series(doc.get("product_name") or doc.get("name") or "")

        # Only heal if the current stored series looks like junk AND a cleaner
        # parsed alternative exists.
        needs_heal = (
            looks_like_full_product_name(unique_val) or looks_like_full_product_name(series_val) or looks_like_full_product_name(range_val)
        )
        if not needs_heal or not parsed:
            continue

        try:
            await db.supplier_products.update_one(
                {"_id": doc["_id"]},
                {"$set": {
                    "series": parsed,
                    "range_name": parsed,
                    "unique_name": parsed,
                    "updated_at": now,
                    "series_healed_by": current_user.get("email"),
                }},
            )
            healed += 1
            sup = doc.get("supplier") or "unknown"
            per_supplier[sup] = per_supplier.get(sup, 0) + 1
        except Exception:
            pass

    await log_audit(
        action="SERIES_HEAL_DRIFT",
        entity_type="supplier_product",
        user=current_user,
        entity_id="bulk-heal",
        entity_name=f"Healed {healed} drifted series values",
        after_data={"scanned": scanned, "healed": healed, "per_supplier": per_supplier, "supplier_filter": supplier},
    )
    return {"ok": True, "scanned": scanned, "healed": healed, "per_supplier": per_supplier}

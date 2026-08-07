"""
Product Name Sanity — scan `supplier_products` for suspicious product_name values
and offer suggested clean names built from other fields (color/size/finish/range_name).

Endpoints:
  GET  /api/product-name-sanity/report          → list of problem rows
  POST /api/product-name-sanity/apply           → apply a batch of {sku, new_name} pairs
  POST /api/product-name-sanity/apply-suggested → auto-apply the server-generated suggestions

The scanner tags each row with one or more `issues` from:
  - too_short          → product_name length < 5
  - contains_none      → "None" / "null" substrings
  - just_sku           → product_name equals sku (or supplier_code)
  - single_word        → one bare word (no spaces) shorter than 15 chars
  - missing_color      → color field populated but not present in product_name
  - missing_size       → size field populated but not present in product_name
  - duplicate_name     → same product_name shared by 2+ SKUs across the same supplier
  - has_placeholder    → contains "TBD", "TEMP", "XXX", "N/A", "?"

Suggestions are built with `build_suggested_name()`:
    "{range_name (first 3 words of current name if none)} {color} {size} {finish}"
"""
from datetime import datetime, timezone
from typing import List, Optional
import re

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from config import get_db
from services import get_current_user, has_permission, log_audit


router = APIRouter(prefix="/product-name-sanity", tags=["product-name-sanity"])


# ---------- helpers ----------

_PLACEHOLDER_TOKENS = ("TBD", "TEMP", "XXX", "N/A", "???", "??")
_NONE_TOKENS = ("None", "null", "NULL", "none")


def _first(field_value) -> str:
    """Products sometimes store color/size/finish as an array. Take the first non-empty."""
    if isinstance(field_value, list):
        for v in field_value:
            if v and str(v).strip() and str(v) not in _NONE_TOKENS:
                return str(v).strip()
        return ""
    if field_value and str(field_value).strip() and str(field_value) not in _NONE_TOKENS:
        return str(field_value).strip()
    return ""


def _scan_issues(doc: dict) -> List[str]:
    name = str(doc.get("product_name") or doc.get("name") or "").strip()
    sku  = str(doc.get("sku") or doc.get("supplier_code") or "").strip()
    color  = _first(doc.get("color") or doc.get("colors"))
    size   = _first(doc.get("size")  or doc.get("sizes"))

    issues: List[str] = []
    if len(name) < 5:
        issues.append("too_short")
    if any(tok in name for tok in _NONE_TOKENS):
        issues.append("contains_none")
    if name.lower() == sku.lower() and sku:
        issues.append("just_sku")
    if " " not in name and len(name) < 15 and name:
        issues.append("single_word")
    if color and color.lower() not in name.lower():
        issues.append("missing_color")
    if size and size.lower() not in name.lower().replace(" ", ""):
        issues.append("missing_size")
    if any(tok in name.upper() for tok in _PLACEHOLDER_TOKENS):
        issues.append("has_placeholder")

    return issues


def build_suggested_name(doc: dict) -> str:
    """Build a clean product name from available fields.

    Strategy:
      1. Start with `product_name` or `name`, stripped of None/placeholder tokens.
      2. If empty/junk fall through to the SKU or "Product".
      3. Append color / size / finish ONLY IF NOT ALREADY PRESENT (case-insensitive
         substring check). Do NOT truncate — the range/model wording in the current
         name is usually the most product-descriptive part.
      4. Collapse whitespace + title-case.
    """
    raw = str(doc.get("product_name") or doc.get("name") or "").strip()
    for tok in _NONE_TOKENS + _PLACEHOLDER_TOKENS:
        raw = re.sub(rf"\b{re.escape(tok)}\b", " ", raw, flags=re.IGNORECASE)
    raw = re.sub(r"\s+", " ", raw).strip()

    base = raw if len(raw) >= 3 else str(doc.get("sku") or "Product")

    color  = _first(doc.get("color")  or doc.get("colors"))
    size   = _first(doc.get("size")   or doc.get("sizes"))
    finish = _first(doc.get("finish") or doc.get("finishes"))

    # Skip test-data / placeholder colour+finish values so we don't leak them into names.
    def _clean_extra(v: str) -> str:
        if not v: return ""
        upper = v.upper()
        if upper.startswith("NEW_") or upper.startswith("TEST_"):
            return ""
        if any(p in upper for p in _PLACEHOLDER_TOKENS):
            return ""
        return v

    parts = [base]
    for extra in (_clean_extra(color), _clean_extra(size), _clean_extra(finish)):
        if extra and extra.lower() not in " ".join(parts).lower():
            parts.append(extra)

    suggested = " ".join(parts).strip()
    # Title-case but keep numeric/measurement tokens (like "12mm", "60x60") as-is
    words_out = []
    for w in suggested.split(" "):
        if re.match(r"^\d", w):
            words_out.append(w)
        else:
            words_out.append(w[:1].upper() + w[1:] if w else w)
    return " ".join(words_out).strip()


def _serialize_row(doc: dict, issues: List[str]) -> dict:
    return {
        "id": str(doc.get("id") or doc.get("_id") or ""),
        "sku": doc.get("sku") or doc.get("supplier_code"),
        "supplier": doc.get("supplier"),
        "product_name": doc.get("product_name") or doc.get("name") or "",
        "color": _first(doc.get("color") or doc.get("colors")),
        "size": _first(doc.get("size") or doc.get("sizes")),
        "finish": _first(doc.get("finish") or doc.get("finishes")),
        "issues": issues,
        "suggested_name": build_suggested_name(doc),
    }


# ---------- endpoints ----------


@router.get("/report")
async def sanity_report(
    supplier: Optional[str] = Query(None),
    issue: Optional[str] = Query(None, description="Filter to one issue type (e.g. too_short)"),
    limit: int = Query(500, ge=1, le=5000),
    include_clean: bool = Query(False, description="If true, also return non-flagged rows (useful when a supplier is selected so admins can rename ANY product)"),
    current_user: dict = Depends(get_current_user),
):
    """Scan `supplier_products` and return rows with detected issues."""
    if not has_permission(current_user, "supplier_products"):
        raise HTTPException(403, "You need the Supplier Products permission to view this report")

    db = get_db()
    filt: dict = {
        "$or": [{"deleted_at": {"$exists": False}}, {"deleted_at": None}],
    }
    if supplier:
        filt["supplier"] = supplier

    issue_counts: dict[str, int] = {}
    rows: list[dict] = []
    supplier_counts: dict[str, int] = {}
    total_scanned = 0
    total_flagged = 0

    # Scan with a modest limit — the collection can be huge; the frontend paginates.
    cursor = db.supplier_products.find(filt).limit(min(limit * 5, 8000))
    async for doc in cursor:
        total_scanned += 1
        issues = _scan_issues(doc)
        if issues:
            total_flagged += 1
        # Skip clean rows unless include_clean=true (typically set when a supplier is scoped).
        if not issues and not include_clean:
            continue
        if issue and issues and issue not in issues:
            continue
        for i in issues:
            issue_counts[i] = issue_counts.get(i, 0) + 1
        supplier_counts[str(doc.get("supplier") or "unknown")] = supplier_counts.get(str(doc.get("supplier") or "unknown"), 0) + 1
        rows.append(_serialize_row(doc, issues))
        if len(rows) >= limit:
            break

    return {
        "rows": rows,
        "total_scanned": total_scanned,
        "total_flagged": total_flagged,
        "issue_counts": issue_counts,
        "supplier_counts": supplier_counts,
    }


class SelectionRequest(BaseModel):
    skus: List[str] = Field(default_factory=list, description="Exact list of supplier product SKUs to review")
    include_clean: bool = Field(default=True, description="If true, return rows even when the scanner finds no issues (so admins can rename anything they selected)")


@router.post("/report-for-selection")
async def sanity_report_for_selection(
    payload: SelectionRequest,
    current_user: dict = Depends(get_current_user),
):
    """Return sanity rows for a specific set of SKUs (as selected in the Supplier
    Products list). Unlike GET /report which paginates the entire collection,
    this returns exactly what the admin picked — flagged OR clean — so they can
    rename any of them from one drawer.
    """
    if not has_permission(current_user, "supplier_products"):
        raise HTTPException(403, "You need the Supplier Products permission to view this report")

    if not payload.skus:
        return {"rows": [], "total_scanned": 0, "total_flagged": 0, "issue_counts": {}, "supplier_counts": {}}

    db = get_db()
    # Match on sku OR supplier_code so RSA Tiles / ThermoSphere (no sku) also resolve.
    filt = {
        "$and": [
            {"$or": [{"sku": {"$in": payload.skus}}, {"supplier_code": {"$in": payload.skus}}]},
            {"$or": [{"deleted_at": {"$exists": False}}, {"deleted_at": None}]},
        ]
    }

    rows: list[dict] = []
    issue_counts: dict[str, int] = {}
    supplier_counts: dict[str, int] = {}

    async for doc in db.supplier_products.find(filt).limit(5000):
        issues = _scan_issues(doc)
        if not issues and not payload.include_clean:
            continue
        for i in issues:
            issue_counts[i] = issue_counts.get(i, 0) + 1
        supplier_counts[str(doc.get("supplier") or "unknown")] = (
            supplier_counts.get(str(doc.get("supplier") or "unknown"), 0) + 1
        )
        rows.append(_serialize_row(doc, issues))

    return {
        "rows": rows,
        "total_scanned": len(rows),
        "total_flagged": sum(1 for r in rows if r["issues"]),
        "issue_counts": issue_counts,
        "supplier_counts": supplier_counts,
    }


class ApplyItem(BaseModel):
    sku: str
    supplier: Optional[str] = None
    new_name: str = Field(min_length=3, max_length=250)


class ApplyRequest(BaseModel):
    items: List[ApplyItem]


@router.post("/apply")
async def apply_new_names(
    payload: ApplyRequest,
    current_user: dict = Depends(get_current_user),
):
    """Rename a batch of products with explicit new names. Frontend uses this after the admin
    reviews the suggestion and optionally edits it."""
    if not has_permission(current_user, "supplier_products"):
        raise HTTPException(403, "You need the Supplier Products permission to rename products")

    db = get_db()
    now = datetime.now(timezone.utc)
    ok = 0
    failed: list[dict] = []

    for item in payload.items:
        query = {"sku": item.sku}
        if item.supplier:
            query["supplier"] = item.supplier

        # Also mirror to the `tiles` collection if present (some routes still read from there)
        set_data = {
            "product_name": item.new_name.strip(),
            "name": item.new_name.strip(),
            "updated_at": now,
            "product_name_fixed_by": current_user.get("email"),
        }

        res = await db.supplier_products.update_one(query, {"$set": set_data})
        if res.matched_count == 0:
            failed.append({"sku": item.sku, "reason": "not_found"})
            continue
        # Mirror to `tiles` (website tile listings) and `products` (EPOS + general products).
        # Best-effort — a missing SKU in either collection is fine.
        clean_name = item.new_name.strip()
        try:
            await db.tiles.update_one({"sku": item.sku}, {"$set": {"name": clean_name, "updated_at": now}})
        except Exception:
            pass
        try:
            await db.products.update_many(
                {"sku": item.sku},
                {"$set": {"name": clean_name, "product_name": clean_name, "updated_at": now}},
            )
        except Exception:
            pass
        ok += 1

    await log_audit(
        action="RENAME_BULK",
        entity_type="supplier_product",
        user=current_user,
        entity_id="bulk",
        entity_name=f"{ok} products renamed via Name Sanity Report",
        after_data={"count_ok": ok, "count_failed": len(failed)},
    )
    return {"ok": True, "updated": ok, "failed": failed}


@router.post("/apply-suggested")
async def apply_suggested_names(
    only_issues: Optional[List[str]] = Query(None, description="Optional filter: apply only rows tagged with these issues"),
    supplier: Optional[str] = Query(None),
    limit: int = Query(500, ge=1, le=5000),
    current_user: dict = Depends(get_current_user),
):
    """One-click auto-fix: apply the server-generated suggestion to every flagged row.
    Preview first via GET /report — this endpoint writes to the DB."""
    if not has_permission(current_user, "supplier_products"):
        raise HTTPException(403, "You need the Supplier Products permission to apply auto-fixes")

    db = get_db()
    filt: dict = {"$or": [{"deleted_at": {"$exists": False}}, {"deleted_at": None}]}
    if supplier:
        filt["supplier"] = supplier

    now = datetime.now(timezone.utc)
    updated = 0
    skipped = 0
    changed_samples: list[dict] = []

    async for doc in db.supplier_products.find(filt).limit(limit * 3):
        issues = _scan_issues(doc)
        if not issues:
            skipped += 1
            continue
        if only_issues and not any(i in issues for i in only_issues):
            skipped += 1
            continue
        suggested = build_suggested_name(doc)
        current = str(doc.get("product_name") or doc.get("name") or "").strip()
        if suggested == current or len(suggested) < 3:
            skipped += 1
            continue

        res = await db.supplier_products.update_one(
            {"_id": doc["_id"]},
            {"$set": {
                "product_name": suggested,
                "name": suggested,
                "updated_at": now,
                "product_name_fixed_by": current_user.get("email"),
                "product_name_fixed_at": now,
            }},
        )
        if res.modified_count:
            # Mirror to `tiles` + `products` collections (some routes read from there,
            # especially the storefront and EPOS). Best-effort — errors are swallowed.
            try:
                await db.tiles.update_one(
                    {"sku": doc.get("sku")},
                    {"$set": {"name": suggested, "updated_at": now}},
                )
            except Exception:
                pass
            try:
                await db.products.update_many(
                    {"sku": doc.get("sku")},
                    {"$set": {"name": suggested, "product_name": suggested, "updated_at": now}},
                )
            except Exception:
                pass
            updated += 1
            if len(changed_samples) < 20:
                changed_samples.append({
                    "sku": doc.get("sku"),
                    "before": current,
                    "after": suggested,
                    "issues": issues,
                })
            if updated >= limit:
                break

    await log_audit(
        action="RENAME_AUTO",
        entity_type="supplier_product",
        user=current_user,
        entity_id="bulk-auto",
        entity_name=f"{updated} products auto-renamed via Name Sanity Report",
        after_data={"updated": updated, "skipped": skipped, "filter_issues": only_issues, "filter_supplier": supplier},
    )
    return {"ok": True, "updated": updated, "skipped": skipped, "samples": changed_samples}


@router.post("/sync-to-epos-website")
async def sync_supplier_names_to_epos_and_website(
    supplier: Optional[str] = Query(None, description="Optional supplier to limit the sync"),
    current_user: dict = Depends(get_current_user),
):
    """Backfill sync: push every `supplier_products.product_name` value into the
    matching row in `db.tiles.name` (website storefront) and `db.products.name`
    (EPOS + main products DB). This is idempotent — a doc already in sync is
    counted as `unchanged`.

    Use case: historical renames done before the auto-mirror shipped are now stale
    in EPOS / the website. One click through this endpoint re-aligns them all.
    """
    if not has_permission(current_user, "supplier_products"):
        raise HTTPException(403, "You need the Supplier Products permission to sync product names")

    db = get_db()
    now = datetime.now(timezone.utc)

    filt: dict = {
        "$or": [{"deleted_at": {"$exists": False}}, {"deleted_at": None}],
        "product_name": {"$nin": [None, ""]},
    }
    if supplier:
        filt["supplier"] = supplier

    tiles_updated = 0
    products_updated = 0
    scanned = 0
    skipped_no_sku = 0
    changed_samples: list[dict] = []

    async for doc in db.supplier_products.find(filt):
        scanned += 1
        sku = doc.get("sku") or doc.get("supplier_code")
        if not sku:
            skipped_no_sku += 1
            continue
        target_name = str(doc.get("product_name") or "").strip()
        if not target_name:
            continue

        # tiles collection — best-effort mirror
        try:
            tres = await db.tiles.update_many(
                {"sku": sku, "$or": [{"name": {"$ne": target_name}}, {"name": {"$exists": False}}]},
                {"$set": {"name": target_name, "updated_at": now}},
            )
            if tres.modified_count:
                tiles_updated += tres.modified_count
        except Exception:
            pass

        # products collection — EPOS + main products
        try:
            pres = await db.products.update_many(
                {"sku": sku, "$or": [{"name": {"$ne": target_name}}, {"name": {"$exists": False}}]},
                {"$set": {"name": target_name, "product_name": target_name, "updated_at": now}},
            )
            if pres.modified_count:
                products_updated += pres.modified_count
                if len(changed_samples) < 20:
                    changed_samples.append({"sku": sku, "new_name": target_name})
        except Exception:
            pass

    await log_audit(
        action="RENAME_BACKFILL_SYNC",
        entity_type="supplier_product",
        user=current_user,
        entity_id="bulk-backfill",
        entity_name=f"Backfilled {tiles_updated + products_updated} names to EPOS/tiles",
        after_data={
            "scanned": scanned,
            "tiles_updated": tiles_updated,
            "products_updated": products_updated,
            "skipped_no_sku": skipped_no_sku,
            "supplier_filter": supplier,
        },
    )
    return {
        "ok": True,
        "scanned": scanned,
        "tiles_updated": tiles_updated,
        "products_updated": products_updated,
        "skipped_no_sku": skipped_no_sku,
        "samples": changed_samples,
    }


@router.get("/locate")
async def locate_sku(
    sku: str = Query(..., description="SKU to trace across every name-carrying collection (case-insensitive, supports partial match)"),
    exact: bool = Query(False, description="If true, requires an exact case-insensitive equality; otherwise does a substring regex match"),
    current_user: dict = Depends(get_current_user),
):
    """Find every collection that stores a product with this SKU. Useful when
    EPOS/Website shows a name the admin can't find in Supplier Products —
    the ghost record usually lives in `db.products` (manual entry), `db.tiles`
    (orphaned website record), `db.sync_staging` (unsynced CSV import row), or
    `db.custom_mappings` (name override rule).
    """
    if not has_permission(current_user, "supplier_products"):
        raise HTTPException(403, "You need the Supplier Products permission to trace SKUs")

    db = get_db()
    # Build a case-insensitive query. `re.escape` guards against regex-injection.
    import re
    pattern = f"^{re.escape(sku.strip())}$" if exact else re.escape(sku.strip())
    regex = {"$regex": pattern, "$options": "i"}

    # Every collection that could plausibly hold a product name / SKU keyed record.
    # supplier_products = source of truth
    # products         = EPOS + main products
    # tiles            = website storefront
    # sync_staging     = CSV import staging (may leak into EPOS if promoted)
    # custom_mappings  = admin name-override rules (SKU → display name)
    scan_targets = ("supplier_products", "products", "tiles", "sync_staging", "custom_mappings")

    locations: list[dict] = []
    for col_name in scan_targets:
        try:
            # Match on `sku`, `supplier_code`, `barcode`, `id`, or the underlying key used in mappings.
            or_clauses = [
                {"sku": regex},
                {"supplier_code": regex},
                {"barcode": regex},
                {"id": regex},
                {"key": regex},  # custom_mappings uses `key`
            ]
            async for d in db[col_name].find({"$or": or_clauses}).limit(20):
                locations.append({
                    "collection": col_name,
                    "id": str(d.get("id") or d.get("_id") or ""),
                    "sku": d.get("sku") or d.get("key") or d.get("id"),
                    "supplier_code": d.get("supplier_code"),
                    "barcode": d.get("barcode"),
                    "name": d.get("name") or d.get("display_name") or d.get("mapped_name"),
                    "product_name": d.get("product_name"),
                    "supplier": d.get("supplier") or d.get("supplier_name"),
                    "supplier_product_name": d.get("supplier_product_name"),
                    "in_products_db": d.get("in_products_db"),
                    "created_at": str(d.get("created_at") or ""),
                    "updated_at": str(d.get("updated_at") or ""),
                })
        except Exception:
            pass
    return {"sku": sku, "found": len(locations), "locations": locations, "scanned_collections": list(scan_targets)}


class PurgeRequest(BaseModel):
    sku: str = Field(min_length=1)
    collections: List[str] = Field(default_factory=lambda: ["products", "tiles"], description="Which collections to purge from. Never purges supplier_products via this endpoint.")


@router.post("/purge")
async def purge_sku(
    payload: PurgeRequest,
    current_user: dict = Depends(get_current_user),
):
    """Delete every doc for this SKU from the requested collections. Used to
    remove ghost EPOS / Website entries that don't have a matching
    Supplier Product row. Never touches `supplier_products` — use the usual
    delete flow for that.
    """
    if not has_permission(current_user, "supplier_products"):
        raise HTTPException(403, "You need the Supplier Products permission to purge products")

    ALLOWED = {"products", "tiles", "sync_staging", "custom_mappings"}
    targets = [c for c in payload.collections if c in ALLOWED]
    if not targets:
        raise HTTPException(400, f"No valid collections. Allowed: {sorted(ALLOWED)}")

    db = get_db()
    # Case-insensitive purge — mirrors the locate query.
    import re
    regex = {"$regex": f"^{re.escape(payload.sku.strip())}$", "$options": "i"}
    deleted: dict[str, int] = {}
    for col in targets:
        try:
            res = await db[col].delete_many({
                "$or": [
                    {"sku": regex},
                    {"supplier_code": regex},
                    {"barcode": regex},
                    {"id": regex},
                    {"key": regex},
                ]
            })
            deleted[col] = res.deleted_count
        except Exception as e:
            deleted[col] = 0
            deleted[f"{col}_error"] = str(e)  # type: ignore

    await log_audit(
        action="PURGE_GHOST_SKU",
        entity_type="product",
        user=current_user,
        entity_id=payload.sku,
        entity_name=f"Purged ghost SKU {payload.sku} from {targets}",
        after_data={"deleted": deleted, "collections": targets},
    )
    return {"ok": True, "sku": payload.sku, "deleted": deleted}

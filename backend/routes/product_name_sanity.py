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
_NONEISH_RE = re.compile(r"^\s*(none|null|n/?a|nan|-+)?(\s*[x×]\s*(none|null|nan))?\s*$", re.IGNORECASE)


def _is_noneish(v) -> bool:
    """True for empty/garbage values like 'None', 'null', 'NonexNone', 'None x None'."""
    return bool(_NONEISH_RE.fullmatch(str(v or "")))


def _first(field_value) -> str:
    """Products sometimes store color/size/finish as an array. Take the first non-empty."""
    if isinstance(field_value, list):
        for v in field_value:
            if v and str(v).strip() and not _is_noneish(v):
                return str(v).strip()
        return ""
    if field_value and str(field_value).strip() and not _is_noneish(field_value):
        return str(field_value).strip()
    return ""


def _norm_text(s: str) -> str:
    """Normalise for comparison: lowercase, non-alphanumerics → space, gray→grey.
    Makes 'cosmic-black' match 'Cosmic Black' and 'Storm_Grey' match 'storm gray'."""
    out = re.sub(r"[^a-z0-9]+", " ", str(s or "").lower()).strip()
    out = re.sub(r"\s+", " ", out).replace("gray", "grey")
    return out


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
    name_norm = _norm_text(name)
    if color and _norm_text(color) and _norm_text(color) not in name_norm:
        issues.append("missing_color")
    if size and _norm_text(size).replace(" ", "") and _norm_text(size).replace(" ", "") not in name_norm.replace(" ", ""):
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
    raw = re.sub(r"none\s*[x×]\s*none", " ", raw, flags=re.IGNORECASE)
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
        if not extra:
            continue
        # Space-stripped normalised presence check — 'cosmic-black' counts as
        # present when the name says 'Cosmic Black'; '60x60' matches '60 x 60'.
        if _norm_text(extra) and _norm_text(extra).replace(" ", "") not in _norm_text(" ".join(parts)).replace(" ", ""):
            parts.append(re.sub(r"[-_]+", " ", extra).strip())

    suggested = " ".join(parts).strip()
    # Title-case but keep numeric/measurement tokens (like "12mm", "60x60") as-is
    words_out = []
    for w in suggested.split(" "):
        if re.match(r"^\d", w):
            words_out.append(w)
        else:
            words_out.append(w[:1].upper() + w[1:] if w else w)
    return " ".join(words_out).strip()


def _supplier_original_name(doc: dict, ours: str) -> str:
    """Supplier's own name: feed `name` when it differs from ours, else the preserved original."""
    feed = str(doc.get("name") or "").strip()
    if feed and feed != ours:
        return feed
    return str(doc.get("original_supplier_name") or doc.get("supplier_product_name") or feed or "").strip()


def _serialize_row(doc: dict, issues: List[str]) -> dict:
    ours = str(doc.get("product_name") or doc.get("name") or "").strip()
    return {
        "id": str(doc.get("id") or doc.get("_id") or ""),
        "sku": doc.get("sku") or doc.get("supplier_code"),
        "supplier": doc.get("supplier"),
        "product_name": ours,
        "supplier_name": _supplier_original_name(doc, ours),
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
        query: dict = {"$or": [{"sku": item.sku}, {"supplier_code": item.sku}]}
        if item.supplier:
            query = {"$and": [query, {"supplier": item.supplier}]}

        # IMPORTANT: `name` = the SUPPLIER's original product name — never touch it here.
        # Renames from Name Sanity only change OUR storefront/display name fields.
        set_data = {
            "product_name": item.new_name.strip(),
            "our_product_name": item.new_name.strip(),
            "display_name": item.new_name.strip(),
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
            # display_name is what serialize_tile_for_shop shows on the storefront —
            # it MUST be updated together with name or the old (pre-rename) name keeps showing.
            await db.tiles.update_one(
                {"sku": item.sku},
                {"$set": {"name": clean_name, "display_name": clean_name, "website_name": clean_name, "updated_at": now}},
            )
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

        # tiles collection — best-effort mirror (name AND display_name; the
        # storefront reads display_name so a stale one keeps the old name alive)
        try:
            tres = await db.tiles.update_many(
                {"sku": sku, "$or": [
                    {"name": {"$ne": target_name}},
                    {"display_name": {"$ne": target_name}},
                    {"name": {"$exists": False}},
                ]},
                {"$set": {"name": target_name, "display_name": target_name, "website_name": target_name, "updated_at": now}},
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


@router.get("/ghost-sweep")
async def ghost_sweep(
    limit: int = Query(2000, ge=1, le=10000, description="Max rows to return per collection"),
    current_user: dict = Depends(get_current_user),
):
    """Scan `products`, `tiles`, and `sync_staging` for rows whose SKU has NO
    matching entry in `supplier_products`. Those are ghost records — usually
    left over from CSVs, manual EPOS entries, or old imports — that keep
    surfacing in EPOS/Website but can't be managed from Supplier Products.
    """
    if not has_permission(current_user, "supplier_products"):
        raise HTTPException(403, "You need the Supplier Products permission to run the ghost sweep")

    db = get_db()

    # Pull all live supplier SKUs (both from `sku` and `supplier_code`) into a lowercase set.
    live_skus: set[str] = set()
    async for d in db.supplier_products.find(
        {"$or": [{"deleted_at": {"$exists": False}}, {"deleted_at": None}]},
        {"sku": 1, "supplier_code": 1, "_id": 0},
    ):
        if d.get("sku"):
            live_skus.add(str(d["sku"]).strip().lower())
        if d.get("supplier_code"):
            live_skus.add(str(d["supplier_code"]).strip().lower())

    ghost_rows: list[dict] = []
    per_collection_counts: dict[str, int] = {}

    for col_name in ("products", "tiles", "sync_staging"):
        count = 0
        try:
            async for d in db[col_name].find({}).limit(limit * 3):
                sku_val = str(d.get("sku") or d.get("supplier_code") or d.get("key") or "").strip()
                if not sku_val:
                    continue
                if sku_val.lower() in live_skus:
                    continue
                ghost_rows.append({
                    "collection": col_name,
                    "id": str(d.get("id") or d.get("_id") or ""),
                    "sku": sku_val,
                    "name": d.get("name") or d.get("display_name") or d.get("mapped_name"),
                    "product_name": d.get("product_name"),
                    "supplier": d.get("supplier") or d.get("supplier_name"),
                    "supplier_product_name": d.get("supplier_product_name"),
                    "created_at": str(d.get("created_at") or ""),
                    "updated_at": str(d.get("updated_at") or ""),
                })
                count += 1
                if count >= limit:
                    break
        except Exception:
            pass
        per_collection_counts[col_name] = count

    return {
        "ok": True,
        "total_ghosts": len(ghost_rows),
        "supplier_skus_seen": len(live_skus),
        "per_collection": per_collection_counts,
        "rows": ghost_rows,
    }


class GhostRenameItem(BaseModel):
    sku: str = Field(min_length=1)
    collection: str
    new_name: str = Field(min_length=3, max_length=250)


class GhostRenameRequest(BaseModel):
    items: List[GhostRenameItem]


@router.post("/ghost-sweep/rename")
async def ghost_sweep_rename(
    payload: GhostRenameRequest,
    current_user: dict = Depends(get_current_user),
):
    """Manually fix ghost record names in-place. Unlike purge, this KEEPS the
    row in its collection (products/tiles/sync_staging) but rewrites its name —
    for ghost EPOS/Website entries the admin wants to correct rather than delete.
    """
    if not has_permission(current_user, "supplier_products"):
        raise HTTPException(403, "You need the Supplier Products permission to rename ghost records")

    ALLOWED = {"products", "tiles", "sync_staging"}
    db = get_db()
    now = datetime.now(timezone.utc)
    updated = 0
    failed: list[dict] = []

    for item in payload.items:
        col = item.collection.strip()
        if col not in ALLOWED:
            failed.append({"sku": item.sku, "reason": f"collection '{col}' not allowed"})
            continue
        new_name = item.new_name.strip()
        regex = {"$regex": f"^{re.escape(item.sku.strip())}$", "$options": "i"}
        set_data = {"name": new_name, "updated_at": now, "ghost_name_fixed_by": current_user.get("email")}
        if col in ("products", "sync_staging"):
            set_data["product_name"] = new_name
        if col == "tiles":
            set_data["display_name"] = new_name
            set_data["website_name"] = new_name
        try:
            res = await db[col].update_many(
                {"$or": [{"sku": regex}, {"supplier_code": regex}, {"key": regex}]},
                {"$set": set_data},
            )
            if res.matched_count == 0:
                failed.append({"sku": item.sku, "reason": "not_found"})
            else:
                updated += 1
        except Exception as e:
            failed.append({"sku": item.sku, "reason": str(e)})

    await log_audit(
        action="GHOST_RENAME",
        entity_type="product",
        user=current_user,
        entity_id="bulk-ghost-rename",
        entity_name=f"{updated} ghost records renamed via Name Sanity ghost sweep",
        after_data={"updated": updated, "failed_count": len(failed)},
    )
    return {"ok": True, "updated": updated, "failed": failed}


class GhostAdoptRequest(BaseModel):
    items: List[dict] = Field(
        default_factory=list,
        description="List of { sku, collection } pairs from the ghost sweep to adopt into supplier_products",
    )


@router.post("/ghost-sweep/adopt")
async def ghost_sweep_adopt(
    payload: GhostAdoptRequest,
    current_user: dict = Depends(get_current_user),
):
    """Turn ghost rows into proper managed products: copies each ghost record
    from its collection (products/tiles/sync_staging) into `supplier_products`
    so it shows up in Supplier Products and the managers. The original record
    is left in place (it's no longer a ghost once the supplier row exists).
    Skips SKUs that already exist in supplier_products.
    """
    if not has_permission(current_user, "supplier_products"):
        raise HTTPException(403, "You need the Supplier Products permission to adopt ghost records")

    ALLOWED = {"products", "tiles", "sync_staging"}
    db = get_db()
    now = datetime.now(timezone.utc)
    adopted = 0
    skipped: list[dict] = []

    for it in payload.items:
        sku = str(it.get("sku") or "").strip()
        col = str(it.get("collection") or "").strip()
        if not sku or col not in ALLOWED:
            skipped.append({"sku": sku, "reason": "invalid_sku_or_collection"})
            continue

        regex = {"$regex": f"^{re.escape(sku)}$", "$options": "i"}
        existing = await db.supplier_products.find_one(
            {"$or": [{"sku": regex}, {"supplier_code": regex}]}, {"_id": 1}
        )
        if existing:
            skipped.append({"sku": sku, "reason": "already_in_supplier_products"})
            continue

        src = await db[col].find_one({"$or": [{"sku": regex}, {"supplier_code": regex}, {"key": regex}]})
        if not src:
            skipped.append({"sku": sku, "reason": "source_not_found"})
            continue

        name = str(src.get("product_name") or src.get("name") or src.get("display_name") or sku).strip()
        import uuid
        sp_doc = {
            "id": str(uuid.uuid4()),
            "sku": src.get("sku") or sku,
            "supplier_code": src.get("supplier_code") or src.get("sku") or sku,
            "barcode": src.get("barcode"),
            "product_name": name,
            "our_product_name": name,
            "name": name,
            "supplier": src.get("supplier") or src.get("supplier_name") or "Adopted",
            "price": src.get("price") or src.get("room_lot_price") or 0,
            "cost_price": src.get("cost_price") or 0,
            "images": src.get("images") or ([src["image"]] if src.get("image") else []),
            "size": src.get("size") or "",
            "color": src.get("color") or "",
            "finish": src.get("finish") or "",
            "material": src.get("material") or "",
            "series": src.get("series") or "",
            "description": src.get("description") or "",
            "product_group": src.get("product_group") or "",
            "category": src.get("category") or "",
            "sub_categories": src.get("sub_categories") or [],
            "main_category": src.get("main_category") or "",
            "stock_quantity": src.get("stock_quantity") or src.get("stock") or 0,
            "adopted_from": col,
            "adopted_by": current_user.get("email"),
            "adopted_at": now,
            "created_at": now,
            "updated_at": now,
        }
        await db.supplier_products.insert_one(sp_doc)
        adopted += 1

    await log_audit(
        action="GHOST_ADOPT",
        entity_type="supplier_product",
        user=current_user,
        entity_id="bulk-ghost-adopt",
        entity_name=f"{adopted} ghost records adopted into Supplier Products",
        after_data={"adopted": adopted, "skipped_count": len(skipped)},
    )
    return {"ok": True, "adopted": adopted, "skipped": skipped}


class GhostBulkPurgeRequest(BaseModel):
    items: List[dict] = Field(
        default_factory=list,
        description="List of { sku, collection } pairs from the ghost sweep to delete",
    )


@router.post("/ghost-sweep/purge")
async def ghost_sweep_purge(
    payload: GhostBulkPurgeRequest,
    current_user: dict = Depends(get_current_user),
):
    """Bulk-delete a list of ghost `{sku, collection}` pairs returned by
    /ghost-sweep. Never touches `supplier_products`. Each pair is validated
    before deletion; unknown collections are rejected silently.
    """
    if not has_permission(current_user, "supplier_products"):
        raise HTTPException(403, "You need the Supplier Products permission to purge ghost SKUs")

    ALLOWED = {"products", "tiles", "sync_staging"}
    db = get_db()

    import re
    deleted: dict[str, int] = {"products": 0, "tiles": 0, "sync_staging": 0}
    failed: list[dict] = []
    processed = 0

    for it in payload.items:
        sku = str(it.get("sku") or "").strip()
        col = str(it.get("collection") or "").strip()
        if not sku or col not in ALLOWED:
            failed.append({"item": it, "reason": "invalid_sku_or_collection"})
            continue
        try:
            regex = {"$regex": f"^{re.escape(sku)}$", "$options": "i"}
            res = await db[col].delete_many({
                "$or": [
                    {"sku": regex},
                    {"supplier_code": regex},
                    {"key": regex},
                ]
            })
            deleted[col] += res.deleted_count
            processed += 1
        except Exception as e:
            failed.append({"item": it, "reason": str(e)})

    await log_audit(
        action="GHOST_SWEEP_PURGE",
        entity_type="product",
        user=current_user,
        entity_id="bulk-ghost-sweep",
        entity_name=f"Ghost sweep purge — {sum(deleted.values())} rows across {processed} items",
        after_data={"deleted": deleted, "processed": processed, "failed_count": len(failed)},
    )
    return {
        "ok": True,
        "processed": processed,
        "deleted": deleted,
        "failed": failed,
    }



# ---------- Series Rename Studio ----------

_FINISH_PATTERN = re.compile(
    r"\b(semi[- ]?polished|anti[- ]?slip|sugar effect|polished|lappato|matte|matt|glossy|gloss|satin|rustic|structured|honed|textured|brushed|riven|grip|carving|natural)\b",
    re.IGNORECASE,
)

_COLOR_WORDS = [
    "dark grey", "light grey", "dark gray", "light gray", "off white", "warm grey", "cool grey",
    "dark blue", "light blue", "dark green", "light green", "dark brown", "light brown",
    "anthracite", "charcoal", "graphite", "terracotta", "burgundy", "turquoise", "cappuccino",
    "chocolate", "grey", "gray", "white", "black", "green", "blue", "red", "yellow", "orange",
    "purple", "pink", "brown", "beige", "cream", "ivory", "sand", "taupe", "greige", "silver",
    "gold", "copper", "bronze", "rust", "cotto", "bone", "almond", "pearl", "smoke", "ash",
    "mink", "mocha", "coffee", "walnut", "honey", "amber", "navy", "teal", "aqua", "emerald",
    "sage", "olive", "mustard", "ochre", "blush", "coral", "maroon", "lilac", "lavender",
    "denim", "oyster", "dove", "fog", "mist", "steel", "iron", "lead", "slate", "carbon",
    "oxide", "basalt", "tobacco", "caramel", "latte", "vanilla", "ecru", "linen", "chalk",
    "salt", "midnight", "bianco", "blanco", "nero", "grigio", "marrone", "avorio", "perla",
    "antracite", "crema", "arctic", "glacier", "snow", "cloud",
]
_COLOR_PATTERN = re.compile(r"\b(" + "|".join(_COLOR_WORDS) + r")\b", re.IGNORECASE)

_SIZE_PATTERN = re.compile(r"(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(cm|mm|m)?\b", re.IGNORECASE)


def _tidy_num(n: str) -> str:
    return n.rstrip("0").rstrip(".") if "." in n else n


def _extract_size(text: str) -> str:
    m = _SIZE_PATTERN.search(text or "")
    if not m:
        return ""
    a, b, unit = _tidy_num(m.group(1)), _tidy_num(m.group(2)), (m.group(3) or "").lower()
    if not unit:
        unit = "mm" if max(float(a), float(b)) >= 200 else "cm"
    return f"{a}x{b}{unit}"


def _extract_finish(text: str) -> str:
    m = _FINISH_PATTERN.search(text or "")
    return m.group(1).title() if m else ""


def _extract_color(text: str) -> str:
    m = _COLOR_PATTERN.search(text or "")
    return m.group(1).title() if m else ""


def _strip_series_words(name: str, series: str) -> str:
    """Remove the series' words from the name so extraction only sees the variant part."""
    s_tokens = set(_norm_text(series).split())
    kept = [w for w in re.split(r"\s+", name or "") if _norm_text(w) not in s_tokens]
    return " ".join(kept)


def _clean_attr(v: str) -> str:
    if not v or _is_noneish(v):
        return ""
    upper = v.upper()
    if upper.startswith("NEW_") or upper.startswith("TEST_") or any(p in upper for p in _PLACEHOLDER_TOKENS):
        return ""
    return v.strip()


def _compose_series_name(series: str, color: str, size: str, finish: str) -> str:
    parts = [series.strip()]
    for p in (color, size, finish):
        if p and _norm_text(p).replace(" ", "") not in _norm_text(" ".join(parts)).replace(" ", ""):
            parts.append(p)
    return re.sub(r"\s+", " ", " ".join(parts)).strip()


@router.get("/series-list")
async def series_list_for_rename(
    q: Optional[str] = Query(None, description="Optional case-insensitive series name filter"),
    current_user: dict = Depends(get_current_user),
):
    """All distinct series values in supplier_products with product counts, biggest first."""
    if not has_permission(current_user, "supplier_products"):
        raise HTTPException(403, "You need the Supplier Products permission")

    db = get_db()
    match: dict = {"$and": [
        {"series": {"$nin": [None, ""]}},
        {"$or": [{"deleted_at": {"$exists": False}}, {"deleted_at": None}]},
    ]}
    if q:
        match["$and"].append({"series": {"$regex": re.escape(q.strip()), "$options": "i"}})

    pipeline = [
        {"$match": match},
        {"$group": {"_id": "$series", "count": {"$sum": 1}}},
        {"$sort": {"count": -1, "_id": 1}},
        {"$limit": 800},
    ]
    out = []
    async for r in db.supplier_products.aggregate(pipeline):
        out.append({"name": r["_id"], "count": r["count"]})
    return {"series": out}


@router.get("/series-products")
async def series_products_for_rename(
    series: str = Query(..., min_length=1),
    current_user: dict = Depends(get_current_user),
):
    """Every product in a series, with colour/size/finish parts extracted from the
    CURRENT NAME first (attributes are often stale) falling back to attribute
    fields, plus a composed standardised suggestion."""
    if not has_permission(current_user, "supplier_products"):
        raise HTTPException(403, "You need the Supplier Products permission")

    db = get_db()
    filt = {"series": series, "$or": [{"deleted_at": {"$exists": False}}, {"deleted_at": None}]}
    rows: list[dict] = []
    async for doc in db.supplier_products.find(filt).limit(3000):
        name = str(doc.get("product_name") or doc.get("name") or "").strip()
        remainder = _strip_series_words(name, series)

        color = _extract_color(remainder) or _clean_attr(_first(doc.get("color") or doc.get("colors"))).title()
        size = _extract_size(remainder) or _extract_size(_first(doc.get("size") or doc.get("sizes"))) or _clean_attr(_first(doc.get("size") or doc.get("sizes")))
        finish = _extract_finish(remainder) or _clean_attr(_first(doc.get("finish") or doc.get("finishes"))).title()

        feed_name = str(doc.get("name") or "").strip()
        supplier_name = _supplier_original_name(doc, name)

        parts = {"color": color, "size": size, "finish": finish}
        rows.append({
            "sku": doc.get("sku") or doc.get("supplier_code"),
            "supplier": doc.get("supplier"),
            "product_name": name,
            "supplier_name": supplier_name,
            "attr_color": _first(doc.get("color") or doc.get("colors")),
            "attr_size": _first(doc.get("size") or doc.get("sizes")),
            "attr_finish": _first(doc.get("finish") or doc.get("finishes")),
            "parts": parts,
            "standardised_name": _compose_series_name(series, color, size, finish),
        })

    rows.sort(key=lambda r: (r["product_name"] or "").lower())
    return {"series": series, "count": len(rows), "rows": rows}

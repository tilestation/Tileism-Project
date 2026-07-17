"""
Tonbridge Warehouse — separate stock location visible to all stores.

Feature contract (agreed with owner on Jul 13, 2026):
  - One dedicated warehouse location ("Tonbridge Warehouse") stored as a
    row in the existing `showrooms` collection with `is_warehouse=True`.
    Reusing showrooms means Stock Transfers, Delivery Check-In, and
    reorder analytics keep working with zero additional wiring.
  - Every authenticated admin/staff user can VIEW warehouse stock.
  - Only Super Admins OR users with the `warehouse_manage` permission
    can ADJUST warehouse stock.
  - Adjustments are audited: who, when, delta, before/after, reason.
  - Any store can raise a "Request from Warehouse" — this creates a
    pending stock transfer with from_showroom_id = warehouse_id, so it
    lands in the existing Stock Transfers workflow (pending → in_transit
    → received) that the warehouse manager already knows.
  - The warehouse is hidden from customer-facing surfaces (public store
    finder, delivery slot picker) via the is_warehouse flag.

Extension (Jul 17, 2026): per-batch stock tracking.
  - Each product can have multiple BATCHES in the warehouse (arriving
    from separate shipments, dye lots, etc.).
  - Batch fields: batch_number, boxes, tiles_per_box, extra_pieces.
  - Total pieces for a batch = boxes * tiles_per_box + extra_pieces.
  - Product's warehouse_stock is auto-synced to sum(total_pieces) across
    every ACTIVE batch (soft-deleted batches don't count).
  - Every batch create / edit / delete writes a warehouse_adjustments
    row so it appears in the Recent Adjustments audit trail.
"""
from datetime import datetime, timezone
from typing import List, Optional
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from config import get_db
from services import get_current_user, has_permission, log_audit

router = APIRouter(prefix="/warehouse", tags=["Warehouse"])

WAREHOUSE_NAME = "Tonbridge Warehouse"
ADJUSTMENT_REASONS = {
    "delivery_received",
    "stocktake_correction",
    "damage_writeoff",
    "transfer_out",
    "other",
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _get_or_create_warehouse(db) -> dict:
    """Return the singleton Tonbridge Warehouse doc, creating it on first
    call. Idempotent — safe to call from any endpoint."""
    warehouse = await db.showrooms.find_one({"is_warehouse": True})
    if warehouse:
        warehouse.pop("_id", None)
        return warehouse

    warehouse_id = str(uuid.uuid4())
    doc = {
        "id": warehouse_id,
        "name": WAREHOUSE_NAME,
        "is_warehouse": True,
        # Hide from customer-facing surfaces. website_admin.get_public_showrooms
        # also filters on is_warehouse (see follow-up patch).
        "is_active": True,
        "hide_from_store_finder": True,
        "hide_from_delivery_slots": True,
        "address": "",
        "phone": "",
        "email": "",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.showrooms.insert_one(doc)
    doc.pop("_id", None)
    return doc


def _can_manage(user: dict) -> bool:
    """Only Super Admins or users granted `warehouse_manage` may adjust."""
    if user.get("role") == "super_admin":
        return True
    return has_permission(user, "warehouse_manage")


def _require_manage(user: dict):
    if not _can_manage(user):
        raise HTTPException(
            status_code=403,
            detail="Warehouse stock adjustments require Super Admin or the "
                   "'Warehouse Manage' permission.",
        )


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class AdjustPayload(BaseModel):
    product_id: str = Field(..., min_length=1)
    # `set` overwrites to `quantity`; `delta` adds `quantity` (can be negative)
    mode: str = Field(..., pattern="^(set|delta)$")
    quantity: int
    reason: str = Field(..., min_length=1, max_length=64)
    note: Optional[str] = Field(default=None, max_length=500)


class RequestTransferPayload(BaseModel):
    to_showroom_id: str = Field(..., min_length=1)
    product_id: str = Field(..., min_length=1)
    sku: str = Field(..., min_length=1)
    name: str = Field(..., min_length=1)
    quantity: int = Field(..., gt=0)
    notes: Optional[str] = Field(default=None, max_length=500)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/info")
async def get_warehouse_info(current_user: dict = Depends(get_current_user)):
    """Return the warehouse doc + permissions of the calling user.
    Auto-creates the warehouse on first call — no manual seed needed."""
    db = get_db()
    warehouse = await _get_or_create_warehouse(db)
    return {
        "warehouse": warehouse,
        "can_manage": _can_manage(current_user),
        "reasons": [
            {"key": "delivery_received", "label": "Delivery received"},
            {"key": "stocktake_correction", "label": "Stocktake correction"},
            {"key": "damage_writeoff", "label": "Damage / write-off"},
            {"key": "transfer_out", "label": "Transfer out to store"},
            {"key": "other", "label": "Other"},
        ],
    }


@router.get("/products")
async def search_warehouse_products(
    q: str = Query("", max_length=200),
    limit: int = Query(50, ge=1, le=200),
    current_user: dict = Depends(get_current_user),
):
    """Search products by name or SKU, return warehouse stock for each.
    Empty query returns empty list (avoid slurping thousands of rows)."""
    q = (q or "").strip()
    if not q:
        return {"products": []}

    db = get_db()
    warehouse = await _get_or_create_warehouse(db)
    warehouse_id = warehouse["id"]

    # Match name OR sku OR barcode — case-insensitive regex.
    # We escape user input for regex safety.
    import re
    q_escaped = re.escape(q)
    query = {
        "$or": [
            {"name": {"$regex": q_escaped, "$options": "i"}},
            {"sku": {"$regex": q_escaped, "$options": "i"}},
            {"barcode": {"$regex": q_escaped, "$options": "i"}},
        ]
    }

    projection = {
        "_id": 0,
        "id": 1,
        "name": 1,
        "sku": 1,
        "barcode": 1,
        "category_name": 1,
        "unit": 1,
        "showroom_stock": 1,
        "stock": 1,
        "images": 1,
        "tile_width": 1,
        "tile_height": 1,
        "tile_m2_per_piece": 1,
        "tiles_per_box": 1,
    }

    products = await db.products.find(query, projection).limit(limit).to_list(limit)

    # Look up last adjustment timestamp for each product in the warehouse
    product_ids = [p.get("id") for p in products if p.get("id")]
    last_adj_map = {}
    batches_map: dict = {pid: [] for pid in product_ids}
    if product_ids:
        pipeline = [
            {"$match": {"product_id": {"$in": product_ids}}},
            {"$sort": {"created_at": -1}},
            {"$group": {
                "_id": "$product_id",
                "last_at": {"$first": "$created_at"},
                "last_by": {"$first": "$actor_email"},
            }},
        ]
        async for row in db.warehouse_adjustments.aggregate(pipeline):
            last_adj_map[row["_id"]] = {
                "at": row.get("last_at"),
                "by": row.get("last_by"),
            }
        # Load ACTIVE batches for every product in the result set
        batch_cursor = db.warehouse_batches.find(
            {"product_id": {"$in": product_ids}, "is_active": {"$ne": False}},
        ).sort("created_at", -1)
        async for b in batch_cursor:
            b.pop("_id", None)
            batches_map.setdefault(b.get("product_id"), []).append(b)

    results = []
    for p in products:
        showroom_stock = p.get("showroom_stock") or {}
        # showroom_stock in the DB can be either a dict (product model) or,
        # legacy, a list of {showroom_id, quantity}. Handle both.
        if isinstance(showroom_stock, list):
            warehouse_qty = 0
            for entry in showroom_stock:
                if isinstance(entry, dict) and entry.get("showroom_id") == warehouse_id:
                    warehouse_qty = int(entry.get("quantity", 0) or 0)
                    break
        elif isinstance(showroom_stock, dict):
            warehouse_qty = int(showroom_stock.get(warehouse_id, 0) or 0)
        else:
            warehouse_qty = 0

        last_adj = last_adj_map.get(p.get("id"))
        product_batches = batches_map.get(p.get("id"), [])
        # Aggregate m² coverage across all batches (if we know tile size).
        m2_per_piece = p.get("tile_m2_per_piece")
        coverage_m2 = None
        if m2_per_piece and warehouse_qty:
            try:
                coverage_m2 = round(warehouse_qty * float(m2_per_piece), 2)
            except (ValueError, TypeError):
                coverage_m2 = None
        image = None
        images = p.get("images") or []
        if isinstance(images, list) and images:
            image = images[0]
        results.append({
            "id": p.get("id"),
            "name": p.get("name"),
            "sku": p.get("sku"),
            "barcode": p.get("barcode"),
            "category_name": p.get("category_name"),
            "unit": p.get("unit"),
            "image": image,
            "tile_width": p.get("tile_width"),
            "tile_height": p.get("tile_height"),
            "tile_m2_per_piece": m2_per_piece,
            "tiles_per_box": p.get("tiles_per_box"),
            "warehouse_stock": warehouse_qty,
            "coverage_m2": coverage_m2,
            "batches": product_batches,
            "batch_count": len(product_batches),
            "last_adjusted_at": last_adj["at"] if last_adj else None,
            "last_adjusted_by": last_adj["by"] if last_adj else None,
        })

    # Sort: highest stock first, then name
    results.sort(key=lambda r: (-(r["warehouse_stock"] or 0), (r["name"] or "").lower()))
    return {"products": results}


@router.post("/adjust")
async def adjust_warehouse_stock(
    payload: AdjustPayload,
    current_user: dict = Depends(get_current_user),
):
    """Set or delta the warehouse stock for one product. Audited."""
    _require_manage(current_user)

    if payload.reason not in ADJUSTMENT_REASONS:
        raise HTTPException(status_code=400, detail="Invalid reason")

    db = get_db()
    warehouse = await _get_or_create_warehouse(db)
    warehouse_id = warehouse["id"]

    product = await db.products.find_one({"id": payload.product_id})
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")

    showroom_stock = product.get("showroom_stock") or {}
    if isinstance(showroom_stock, list):
        # Legacy list shape — convert to dict to unify going forward.
        converted = {}
        for entry in showroom_stock:
            if isinstance(entry, dict) and entry.get("showroom_id"):
                converted[entry["showroom_id"]] = int(entry.get("quantity", 0) or 0)
        showroom_stock = converted
    elif not isinstance(showroom_stock, dict):
        showroom_stock = {}

    before_qty = int(showroom_stock.get(warehouse_id, 0) or 0)
    if payload.mode == "set":
        after_qty = int(payload.quantity)
    else:  # delta
        after_qty = before_qty + int(payload.quantity)

    if after_qty < 0:
        raise HTTPException(
            status_code=400,
            detail=f"Adjustment would leave warehouse stock at {after_qty} "
                   f"(currently {before_qty}). Warehouse stock cannot go negative.",
        )

    showroom_stock[warehouse_id] = after_qty
    # Total `stock` field is the sum across all locations.
    total_stock = sum(int(v or 0) for v in showroom_stock.values())

    await db.products.update_one(
        {"id": payload.product_id},
        {
            "$set": {
                "showroom_stock": showroom_stock,
                "stock": total_stock,
                "updated_at": datetime.now(timezone.utc),
            }
        },
    )

    # Insert adjustment record
    adj_doc = {
        "id": str(uuid.uuid4()),
        "product_id": payload.product_id,
        "product_name": product.get("name"),
        "product_sku": product.get("sku"),
        "warehouse_id": warehouse_id,
        "before_qty": before_qty,
        "after_qty": after_qty,
        "delta": after_qty - before_qty,
        "mode": payload.mode,
        "reason": payload.reason,
        "note": payload.note or "",
        "actor_email": current_user.get("email"),
        "actor_name": current_user.get("name") or current_user.get("email"),
        "actor_role": current_user.get("role"),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.warehouse_adjustments.insert_one(adj_doc)
    adj_doc.pop("_id", None)

    # Audit trail (existing infra)
    await log_audit(
        action="UPDATE",
        entity_type="warehouse_stock",
        user=current_user,
        entity_id=payload.product_id,
        entity_name=product.get("name"),
        before_data={"warehouse_stock": before_qty},
        after_data={"warehouse_stock": after_qty, "reason": payload.reason},
        details=f"Warehouse stock: {before_qty} → {after_qty} ({payload.reason})",
    )

    return {
        "success": True,
        "before_qty": before_qty,
        "after_qty": after_qty,
        "adjustment": adj_doc,
    }


@router.get("/adjustments")
async def list_adjustments(
    limit: int = Query(50, ge=1, le=200),
    product_id: Optional[str] = Query(default=None),
    current_user: dict = Depends(get_current_user),
):
    """Recent adjustment history — visible to every authenticated user."""
    db = get_db()
    query: dict = {}
    if product_id:
        query["product_id"] = product_id

    cursor = db.warehouse_adjustments.find(query).sort("created_at", -1).limit(limit)
    rows = await cursor.to_list(limit)
    for r in rows:
        r.pop("_id", None)
    return {"adjustments": rows}


@router.post("/request-transfer")
async def request_transfer_from_warehouse(
    payload: RequestTransferPayload,
    current_user: dict = Depends(get_current_user),
):
    """Any store admin can request stock from the warehouse. This creates
    a stock transfer in the standard `stock_transfers` collection with
    status='pending' and from_showroom_id=warehouse_id. The warehouse
    manager processes it via the existing /admin/stock-transfers page."""
    db = get_db()
    warehouse = await _get_or_create_warehouse(db)
    warehouse_id = warehouse["id"]

    if payload.to_showroom_id == warehouse_id:
        raise HTTPException(status_code=400, detail="Destination cannot be the warehouse itself")

    to_showroom = await db.showrooms.find_one({"id": payload.to_showroom_id})
    if not to_showroom:
        raise HTTPException(status_code=404, detail="Destination store not found")

    product = await db.products.find_one({"id": payload.product_id})
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")

    # Snapshot warehouse stock at time of request (informational only —
    # we don't block requests when stock is low; the warehouse manager
    # decides whether to fulfil or reject).
    showroom_stock = product.get("showroom_stock") or {}
    if isinstance(showroom_stock, dict):
        warehouse_qty = int(showroom_stock.get(warehouse_id, 0) or 0)
    else:
        warehouse_qty = 0

    transfer_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    transfer_doc = {
        "id": transfer_id,
        "from_showroom_id": warehouse_id,
        "from_showroom_name": warehouse["name"],
        "to_showroom_id": payload.to_showroom_id,
        "to_showroom_name": to_showroom.get("name"),
        "items": [{
            "product_id": payload.product_id,
            "sku": payload.sku,
            "name": payload.name,
            "quantity": payload.quantity,
        }],
        "status": "pending",
        "source": "warehouse_request",
        "requested_qty_snapshot": warehouse_qty,
        "notes": payload.notes or "",
        "requested_by_email": current_user.get("email"),
        "requested_by_name": current_user.get("name") or current_user.get("email"),
        "created_at": now,
        "updated_at": now,
        "history": [{
            "at": now,
            "status": "pending",
            "actor": current_user.get("email"),
            "notes": f"Requested from warehouse by {current_user.get('name') or current_user.get('email')}",
        }],
    }
    await db.stock_transfers.insert_one(transfer_doc)
    transfer_doc.pop("_id", None)

    await log_audit(
        action="CREATE",
        entity_type="warehouse_request",
        user=current_user,
        entity_id=transfer_id,
        entity_name=f"{payload.name} × {payload.quantity}",
        after_data={
            "product_id": payload.product_id,
            "quantity": payload.quantity,
            "to_showroom_id": payload.to_showroom_id,
        },
        details=f"Requested {payload.quantity} × {payload.name} from warehouse to {to_showroom.get('name')}",
    )

    return {"success": True, "transfer": transfer_doc}



# ===========================================================================
# BATCH TRACKING (Jul 17, 2026)
# ===========================================================================
#
# Every product's warehouse stock can be split into one or more BATCHES,
# each representing a discrete shipment / dye lot / delivery. The product's
# aggregated warehouse_stock (in product.showroom_stock[warehouse_id])
# stays in sync via _resync_product_warehouse_stock().

class BatchCreatePayload(BaseModel):
    product_id: str = Field(..., min_length=1)
    batch_number: str = Field(..., min_length=1, max_length=100)
    boxes: int = Field(default=0, ge=0)
    tiles_per_box: int = Field(default=1, gt=0)
    extra_pieces: int = Field(default=0, ge=0)
    notes: Optional[str] = Field(default=None, max_length=500)


class BatchUpdatePayload(BaseModel):
    batch_number: Optional[str] = Field(default=None, min_length=1, max_length=100)
    boxes: Optional[int] = Field(default=None, ge=0)
    tiles_per_box: Optional[int] = Field(default=None, gt=0)
    extra_pieces: Optional[int] = Field(default=None, ge=0)
    notes: Optional[str] = Field(default=None, max_length=500)
    reason: Optional[str] = Field(default=None, max_length=64)


class QuickAddProductPayload(BaseModel):
    """Minimal product-creation payload for the warehouse's inline form.
    Full product management (pricing, categories, variants) still lives on
    /admin/products. This flow only captures what the warehouse team needs
    to log batches: identity + tile dimensions."""
    name: str = Field(..., min_length=1, max_length=200)
    sku: str = Field(..., min_length=1, max_length=100)
    barcode: Optional[str] = Field(default=None, max_length=100)
    category_name: Optional[str] = Field(default=None, max_length=100)
    tile_width: Optional[float] = Field(default=None, gt=0)   # mm
    tile_height: Optional[float] = Field(default=None, gt=0)  # mm
    tiles_per_box: Optional[int] = Field(default=None, gt=0)
    image_url: Optional[str] = Field(default=None, max_length=1000)


def _compute_batch_total(boxes: int, tiles_per_box: int, extra_pieces: int) -> int:
    return int(boxes) * int(tiles_per_box) + int(extra_pieces)


async def _resync_product_warehouse_stock(db, product_id: str, warehouse_id: str) -> int:
    """Recalculate product.showroom_stock[warehouse_id] = sum of active
    batches. Returns the new total. Called on every batch mutation so the
    aggregated view (and every downstream analytics that reads
    showroom_stock) stays consistent."""
    cursor = db.warehouse_batches.find(
        {"product_id": product_id, "is_active": {"$ne": False}},
        {"_id": 0, "total_pieces": 1},
    )
    total = 0
    async for b in cursor:
        total += int(b.get("total_pieces") or 0)

    product = await db.products.find_one({"id": product_id})
    if not product:
        return total
    showroom_stock = product.get("showroom_stock") or {}
    if isinstance(showroom_stock, list):
        converted = {}
        for entry in showroom_stock:
            if isinstance(entry, dict) and entry.get("showroom_id"):
                converted[entry["showroom_id"]] = int(entry.get("quantity", 0) or 0)
        showroom_stock = converted
    elif not isinstance(showroom_stock, dict):
        showroom_stock = {}
    showroom_stock[warehouse_id] = total
    aggregate_stock = sum(int(v or 0) for v in showroom_stock.values())
    await db.products.update_one(
        {"id": product_id},
        {"$set": {
            "showroom_stock": showroom_stock,
            "stock": aggregate_stock,
            "updated_at": datetime.now(timezone.utc),
        }},
    )
    return total


async def _log_batch_adjustment(
    db, product: dict, before_qty: int, after_qty: int,
    warehouse_id: str, reason: str, note: str, actor: dict,
):
    """Insert a warehouse_adjustments row so batch changes appear in the
    Recent Adjustments audit trail alongside direct adjust operations."""
    adj_doc = {
        "id": str(uuid.uuid4()),
        "product_id": product.get("id"),
        "product_name": product.get("name"),
        "product_sku": product.get("sku"),
        "warehouse_id": warehouse_id,
        "before_qty": before_qty,
        "after_qty": after_qty,
        "delta": after_qty - before_qty,
        "mode": "batch",
        "reason": reason,
        "note": note or "",
        "actor_email": actor.get("email"),
        "actor_name": actor.get("name") or actor.get("email"),
        "actor_role": actor.get("role"),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.warehouse_adjustments.insert_one(adj_doc)


@router.post("/products/quick-add")
async def quick_add_product(
    payload: QuickAddProductPayload,
    current_user: dict = Depends(get_current_user),
):
    """Create a minimal product from the warehouse page. Only for users
    who can manage the warehouse — otherwise regular staff could pollute
    the catalogue."""
    _require_manage(current_user)
    db = get_db()

    # Guard against duplicate SKU — the warehouse team already asks for
    # unique SKUs, but a friendly 409 beats a random uniqueness index.
    existing = await db.products.find_one({"sku": payload.sku})
    if existing:
        raise HTTPException(
            status_code=409,
            detail=f"A product with SKU '{payload.sku}' already exists "
                   f"({existing.get('name')}). Search for it instead.",
        )

    product_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)

    # Auto-compute tile_m2_per_piece when we know the dimensions.
    tile_m2_per_piece = None
    if payload.tile_width and payload.tile_height:
        try:
            tile_m2_per_piece = round(
                (float(payload.tile_width) * float(payload.tile_height)) / 1_000_000.0,
                4,
            )
        except (ValueError, TypeError):
            tile_m2_per_piece = None

    images = [payload.image_url] if payload.image_url else []
    doc = {
        "id": product_id,
        "name": payload.name.strip(),
        "sku": payload.sku.strip(),
        "barcode": (payload.barcode or "").strip(),
        "description": "",
        "price": 0.0,
        "cost_price": 0.0,
        "stock": 0,
        "category_id": "",
        "category_name": (payload.category_name or "").strip(),
        "unit": "piece",
        "tile_width": payload.tile_width,
        "tile_height": payload.tile_height,
        "tile_m2_per_piece": tile_m2_per_piece,
        "tiles_per_box": payload.tiles_per_box,
        "box_m2_coverage": (
            round(tile_m2_per_piece * int(payload.tiles_per_box), 4)
            if tile_m2_per_piece and payload.tiles_per_box else None
        ),
        "reorder_level": 10,
        "images": images,
        "showroom_stock": {},
        "created_at": now.isoformat(),
        "updated_at": now.isoformat(),
        "source": "warehouse_quick_add",
    }
    await db.products.insert_one(doc)
    doc.pop("_id", None)

    await log_audit(
        action="CREATE",
        entity_type="product",
        user=current_user,
        entity_id=product_id,
        entity_name=payload.name,
        after_data={"name": payload.name, "sku": payload.sku, "via": "warehouse"},
        details=f"Product quick-added via warehouse: {payload.name} ({payload.sku})",
    )

    return {"success": True, "product": doc}


@router.get("/products/{product_id}/batches")
async def list_product_batches(
    product_id: str,
    current_user: dict = Depends(get_current_user),
):
    """List all active batches for one product."""
    db = get_db()
    cursor = db.warehouse_batches.find(
        {"product_id": product_id, "is_active": {"$ne": False}},
    ).sort("created_at", -1)
    rows = []
    async for b in cursor:
        b.pop("_id", None)
        rows.append(b)
    return {"batches": rows}


@router.post("/batches")
async def create_batch(
    payload: BatchCreatePayload,
    current_user: dict = Depends(get_current_user),
):
    """Add a batch to a product. Bumps warehouse stock and logs audit."""
    _require_manage(current_user)
    db = get_db()
    warehouse = await _get_or_create_warehouse(db)
    warehouse_id = warehouse["id"]

    product = await db.products.find_one({"id": payload.product_id})
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")

    # Prevent duplicate batch numbers on the same product (case-insensitive).
    existing = await db.warehouse_batches.find_one({
        "product_id": payload.product_id,
        "batch_number_ci": payload.batch_number.strip().lower(),
        "is_active": {"$ne": False},
    })
    if existing:
        raise HTTPException(
            status_code=409,
            detail=f"Batch '{payload.batch_number}' already exists for this product. "
                   f"Edit the existing batch instead.",
        )

    total_pieces = _compute_batch_total(
        payload.boxes, payload.tiles_per_box, payload.extra_pieces,
    )

    now = datetime.now(timezone.utc).isoformat()
    batch_id = str(uuid.uuid4())
    batch_doc = {
        "id": batch_id,
        "product_id": payload.product_id,
        "product_name": product.get("name"),
        "product_sku": product.get("sku"),
        "batch_number": payload.batch_number.strip(),
        "batch_number_ci": payload.batch_number.strip().lower(),
        "boxes": int(payload.boxes),
        "tiles_per_box": int(payload.tiles_per_box),
        "extra_pieces": int(payload.extra_pieces),
        "total_pieces": total_pieces,
        "notes": payload.notes or "",
        "is_active": True,
        "created_at": now,
        "created_by_email": current_user.get("email"),
        "created_by_name": current_user.get("name") or current_user.get("email"),
        "updated_at": now,
    }
    await db.warehouse_batches.insert_one(batch_doc)

    before_qty = int((product.get("showroom_stock") or {}).get(warehouse_id, 0) or 0) \
        if isinstance(product.get("showroom_stock"), dict) else 0
    after_qty = await _resync_product_warehouse_stock(db, payload.product_id, warehouse_id)

    await _log_batch_adjustment(
        db, product, before_qty, after_qty, warehouse_id,
        reason="batch_added",
        note=f"Batch {payload.batch_number}: {payload.boxes} boxes × "
             f"{payload.tiles_per_box}/box + {payload.extra_pieces} loose = {total_pieces} pcs",
        actor=current_user,
    )
    await log_audit(
        action="CREATE",
        entity_type="warehouse_batch",
        user=current_user,
        entity_id=batch_id,
        entity_name=f"{product.get('name')} — Batch {payload.batch_number}",
        after_data={
            "product_id": payload.product_id,
            "batch_number": payload.batch_number,
            "boxes": payload.boxes,
            "tiles_per_box": payload.tiles_per_box,
            "extra_pieces": payload.extra_pieces,
            "total_pieces": total_pieces,
        },
        details=f"Batch created: {product.get('name')} #{payload.batch_number} → +{total_pieces} pcs",
    )

    batch_doc.pop("_id", None)
    return {"success": True, "batch": batch_doc, "warehouse_total": after_qty}


@router.put("/batches/{batch_id}")
async def update_batch(
    batch_id: str,
    payload: BatchUpdatePayload,
    current_user: dict = Depends(get_current_user),
):
    _require_manage(current_user)
    db = get_db()
    warehouse = await _get_or_create_warehouse(db)
    warehouse_id = warehouse["id"]

    batch = await db.warehouse_batches.find_one({"id": batch_id})
    if not batch or not batch.get("is_active", True):
        raise HTTPException(status_code=404, detail="Batch not found")

    product = await db.products.find_one({"id": batch.get("product_id")})
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")

    updates: dict = {"updated_at": datetime.now(timezone.utc).isoformat()}
    if payload.batch_number is not None:
        # Guard rename collision
        new_ci = payload.batch_number.strip().lower()
        if new_ci != batch.get("batch_number_ci"):
            clash = await db.warehouse_batches.find_one({
                "product_id": batch["product_id"],
                "batch_number_ci": new_ci,
                "is_active": {"$ne": False},
                "id": {"$ne": batch_id},
            })
            if clash:
                raise HTTPException(
                    status_code=409,
                    detail=f"Another batch with number '{payload.batch_number}' already exists.",
                )
        updates["batch_number"] = payload.batch_number.strip()
        updates["batch_number_ci"] = new_ci
    if payload.boxes is not None:
        updates["boxes"] = int(payload.boxes)
    if payload.tiles_per_box is not None:
        updates["tiles_per_box"] = int(payload.tiles_per_box)
    if payload.extra_pieces is not None:
        updates["extra_pieces"] = int(payload.extra_pieces)
    if payload.notes is not None:
        updates["notes"] = payload.notes

    # Recompute total_pieces from final values (either updated or existing).
    boxes = updates.get("boxes", batch.get("boxes", 0))
    tpb = updates.get("tiles_per_box", batch.get("tiles_per_box", 1))
    extra = updates.get("extra_pieces", batch.get("extra_pieces", 0))
    new_total = _compute_batch_total(boxes, tpb, extra)
    old_total = int(batch.get("total_pieces") or 0)
    updates["total_pieces"] = new_total
    updates["updated_by_email"] = current_user.get("email")

    await db.warehouse_batches.update_one({"id": batch_id}, {"$set": updates})

    before_qty = int((product.get("showroom_stock") or {}).get(warehouse_id, 0) or 0) \
        if isinstance(product.get("showroom_stock"), dict) else 0
    after_qty = await _resync_product_warehouse_stock(db, batch["product_id"], warehouse_id)

    reason_slug = payload.reason or "batch_edited"
    await _log_batch_adjustment(
        db, product, before_qty, after_qty, warehouse_id,
        reason=reason_slug,
        note=f"Batch {updates.get('batch_number', batch.get('batch_number'))}: "
             f"{old_total} → {new_total} pcs",
        actor=current_user,
    )
    await log_audit(
        action="UPDATE",
        entity_type="warehouse_batch",
        user=current_user,
        entity_id=batch_id,
        entity_name=f"{product.get('name')} — Batch {batch.get('batch_number')}",
        before_data={"total_pieces": old_total},
        after_data={"total_pieces": new_total, "updates": updates},
        details=f"Batch updated: {old_total} → {new_total} pcs",
    )
    updated_batch = {**batch, **updates}
    updated_batch.pop("_id", None)
    return {"success": True, "batch": updated_batch, "warehouse_total": after_qty}


@router.delete("/batches/{batch_id}")
async def delete_batch(
    batch_id: str,
    reason: Optional[str] = Query(default=None, max_length=200),
    current_user: dict = Depends(get_current_user),
):
    """Soft-delete a batch. Its total_pieces stop counting toward warehouse
    stock immediately. We keep the row for audit — a hard delete would
    lose the history."""
    _require_manage(current_user)
    db = get_db()
    warehouse = await _get_or_create_warehouse(db)
    warehouse_id = warehouse["id"]

    batch = await db.warehouse_batches.find_one({"id": batch_id})
    if not batch or not batch.get("is_active", True):
        raise HTTPException(status_code=404, detail="Batch not found")

    product = await db.products.find_one({"id": batch.get("product_id")})
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")

    await db.warehouse_batches.update_one(
        {"id": batch_id},
        {"$set": {
            "is_active": False,
            "deleted_at": datetime.now(timezone.utc).isoformat(),
            "deleted_by_email": current_user.get("email"),
            "deleted_reason": reason or "",
        }},
    )

    before_qty = int((product.get("showroom_stock") or {}).get(warehouse_id, 0) or 0) \
        if isinstance(product.get("showroom_stock"), dict) else 0
    after_qty = await _resync_product_warehouse_stock(db, batch["product_id"], warehouse_id)
    old_total = int(batch.get("total_pieces") or 0)

    await _log_batch_adjustment(
        db, product, before_qty, after_qty, warehouse_id,
        reason="batch_removed",
        note=f"Batch {batch.get('batch_number')} removed ({old_total} pcs). "
             f"{('Reason: ' + reason) if reason else ''}",
        actor=current_user,
    )
    await log_audit(
        action="DELETE",
        entity_type="warehouse_batch",
        user=current_user,
        entity_id=batch_id,
        entity_name=f"{product.get('name')} — Batch {batch.get('batch_number')}",
        before_data={"total_pieces": old_total},
        details=f"Batch removed: -{old_total} pcs ({reason or 'no reason'})",
    )

    return {"success": True, "warehouse_total": after_qty}

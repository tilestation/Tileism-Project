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
    }

    products = await db.products.find(query, projection).limit(limit).to_list(limit)

    # Look up last adjustment timestamp for each product in the warehouse
    product_ids = [p.get("id") for p in products if p.get("id")]
    last_adj_map = {}
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
        results.append({
            "id": p.get("id"),
            "name": p.get("name"),
            "sku": p.get("sku"),
            "barcode": p.get("barcode"),
            "category_name": p.get("category_name"),
            "unit": p.get("unit"),
            "warehouse_stock": warehouse_qty,
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

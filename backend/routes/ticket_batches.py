"""
Price-ticket print batches (May 13, 2026)

Stores admin's printed ticket batches so they can be:
  * Searched + re-loaded for re-print
  * Edited in-place (don't duplicate when re-saving the same batch)
  * Audited (`printed_at`, `printed_by`, `print_count`)

De-duplication strategy:
  Each batch gets a SHA-256 `content_hash` derived from the products list
  + paper size + ticket-display settings. On save, if a batch with the
  same hash already exists for this user, we BUMP `print_count` and
  `printed_at` instead of creating a duplicate row.
"""
import hashlib
import json
import uuid
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any

from fastapi import APIRouter, HTTPException, Depends, Query
from pydantic import BaseModel, Field

from config import get_db
from services import get_current_user

router = APIRouter(prefix="/admin", tags=["Ticket Batches"])


# ---------- Models ----------


class PaperSize(BaseModel):
    width_mm: float
    height_mm: float
    per_a4_cols: int = 2
    per_a4_rows: int = 2


class TicketSettings(BaseModel):
    show_original_price: bool = True
    show_clearance_badge: bool = True
    show_thisweek_badge: bool = False
    show_barcode: bool = True
    show_qr: bool = True
    copies: int = 1


class TicketBatchProduct(BaseModel):
    # Snapshot of the product at save-time so the batch is reproducible even
    # if the underlying product is later edited or deleted.
    id: str  # virtual id (may be "manual-...") — not a guaranteed FK
    name: str
    price: float
    clearance_price: Optional[float] = None
    sku: Optional[str] = None
    product_code: Optional[str] = None
    barcode: Optional[str] = None  # only set for manual entries
    slug: Optional[str] = None  # so we can rebuild the PDP QR
    sizes: List[str] = Field(default_factory=list)
    suitability: Optional[str] = None
    finish: Optional[str] = None
    material: Optional[str] = None
    country_of_origin: Optional[str] = None
    price_unit: Optional[str] = "m2"
    is_manual: bool = False


class TicketBatchSave(BaseModel):
    name: Optional[str] = None  # auto-generated if omitted
    template_name: str = "A6 Tickets"
    paper_size: PaperSize
    settings: TicketSettings
    products: List[TicketBatchProduct]


class TicketBatchUpdate(BaseModel):
    name: Optional[str] = None
    template_name: Optional[str] = None
    paper_size: Optional[PaperSize] = None
    settings: Optional[TicketSettings] = None
    products: Optional[List[TicketBatchProduct]] = None


# ---------- Helpers ----------


def _content_hash(payload: TicketBatchSave) -> str:
    """SHA-256 of the canonical JSON form of the batch contents.
    Used to de-duplicate: re-printing the SAME selection of products
    with the same paper size + settings bumps the existing row rather
    than creating a new one."""
    canonical = {
        "paper_size": payload.paper_size.model_dump(),
        "settings": payload.settings.model_dump(),
        # Sort products by id so [A,B] == [B,A]
        "products": sorted(
            [p.model_dump() for p in payload.products],
            key=lambda p: p.get("id", ""),
        ),
    }
    blob = json.dumps(canonical, sort_keys=True, default=str).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()


def _default_name(products: List[TicketBatchProduct]) -> str:
    """Auto-generate a batch name when admin doesn't supply one."""
    if not products:
        return f"Empty batch — {datetime.now(timezone.utc).strftime('%d %b %Y %H:%M')}"
    first = products[0].name
    if len(products) == 1:
        return f"{first} — {datetime.now(timezone.utc).strftime('%d %b %Y')}"
    return f"{first} +{len(products) - 1} more — {datetime.now(timezone.utc).strftime('%d %b %Y')}"


# ---------- Endpoints ----------


@router.post("/ticket-batches")
async def save_ticket_batch(
    payload: TicketBatchSave,
    current_user: dict = Depends(get_current_user),
):
    """Save (or upsert) a print batch.

    De-duplication: if a batch with the same content_hash already exists
    for this user we update its `last_printed_at` + `print_count` rather
    than creating a duplicate. Returns the saved batch document."""
    db = get_db()
    user_email = current_user.get("email") or current_user.get("id")
    chash = _content_hash(payload)
    now = datetime.now(timezone.utc).isoformat()

    existing = await db.ticket_print_batches.find_one(
        {"content_hash": chash, "printed_by": user_email},
        {"_id": 0},
    )

    if existing:
        # Dedupe — bump usage stats and refresh the name if admin supplied one
        update = {
            "last_printed_at": now,
            "print_count": int(existing.get("print_count", 1)) + 1,
        }
        if payload.name and payload.name != existing.get("name"):
            update["name"] = payload.name
        await db.ticket_print_batches.update_one(
            {"id": existing["id"]},
            {"$set": update},
        )
        existing.update(update)
        return {"deduped": True, "batch": existing}

    name = payload.name or _default_name(payload.products)
    batch = {
        "id": str(uuid.uuid4()),
        "name": name,
        "template_name": payload.template_name,
        "paper_size": payload.paper_size.model_dump(),
        "settings": payload.settings.model_dump(),
        "products": [p.model_dump() for p in payload.products],
        "product_count": len(payload.products),
        "content_hash": chash,
        "printed_by": user_email,
        "printed_at": now,
        "last_printed_at": now,
        "last_edited_at": now,
        "print_count": 1,
    }
    await db.ticket_print_batches.insert_one(batch)
    # _id may have been mutated onto the dict by motor — strip it
    batch.pop("_id", None)
    return {"deduped": False, "batch": batch}


@router.get("/ticket-batches")
async def list_ticket_batches(
    q: str = Query("", description="Search batch name or product names"),
    limit: int = Query(50, ge=1, le=200),
    current_user: dict = Depends(get_current_user),
):
    """List this user's saved batches, newest first. Optional substring
    search across batch name + product names (case-insensitive)."""
    db = get_db()
    user_email = current_user.get("email") or current_user.get("id")
    query: Dict[str, Any] = {"printed_by": user_email}
    if q.strip():
        # Match batch name OR any product name
        rx = {"$regex": q.strip(), "$options": "i"}
        query = {
            "$and": [
                {"printed_by": user_email},
                {"$or": [{"name": rx}, {"products.name": rx}]},
            ]
        }
    cursor = (
        db.ticket_print_batches.find(query, {"_id": 0})
        .sort("last_printed_at", -1)
        .limit(limit)
    )
    return {"batches": await cursor.to_list(limit)}


@router.get("/ticket-batches/{batch_id}")
async def get_ticket_batch(
    batch_id: str,
    current_user: dict = Depends(get_current_user),
):
    db = get_db()
    user_email = current_user.get("email") or current_user.get("id")
    batch = await db.ticket_print_batches.find_one(
        {"id": batch_id, "printed_by": user_email},
        {"_id": 0},
    )
    if not batch:
        raise HTTPException(status_code=404, detail="Batch not found")
    return batch


@router.put("/ticket-batches/{batch_id}")
async def update_ticket_batch(
    batch_id: str,
    payload: TicketBatchUpdate,
    current_user: dict = Depends(get_current_user),
):
    """Edit an existing batch in-place (rename, adjust paper, add/remove
    products). Also recomputes `content_hash` so future saves dedupe
    against the updated state."""
    db = get_db()
    user_email = current_user.get("email") or current_user.get("id")
    existing = await db.ticket_print_batches.find_one(
        {"id": batch_id, "printed_by": user_email}, {"_id": 0}
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Batch not found")

    merged_paper = (
        payload.paper_size.model_dump()
        if payload.paper_size
        else existing.get("paper_size")
    )
    merged_settings = (
        payload.settings.model_dump()
        if payload.settings
        else existing.get("settings")
    )
    merged_products = (
        [p.model_dump() for p in payload.products]
        if payload.products is not None
        else existing.get("products", [])
    )

    # Recompute hash so dedupe stays consistent
    hash_payload = TicketBatchSave(
        name=existing.get("name"),
        template_name=payload.template_name or existing.get("template_name", "A6 Tickets"),
        paper_size=PaperSize(**merged_paper),
        settings=TicketSettings(**merged_settings),
        products=[TicketBatchProduct(**p) for p in merged_products],
    )

    update: Dict[str, Any] = {
        "paper_size": merged_paper,
        "settings": merged_settings,
        "products": merged_products,
        "product_count": len(merged_products),
        "content_hash": _content_hash(hash_payload),
        "last_edited_at": datetime.now(timezone.utc).isoformat(),
    }
    if payload.name is not None:
        update["name"] = payload.name
    if payload.template_name is not None:
        update["template_name"] = payload.template_name

    await db.ticket_print_batches.update_one(
        {"id": batch_id, "printed_by": user_email},
        {"$set": update},
    )
    updated = await db.ticket_print_batches.find_one(
        {"id": batch_id}, {"_id": 0}
    )
    return updated


@router.delete("/ticket-batches/{batch_id}")
async def delete_ticket_batch(
    batch_id: str,
    current_user: dict = Depends(get_current_user),
):
    db = get_db()
    user_email = current_user.get("email") or current_user.get("id")
    result = await db.ticket_print_batches.delete_one(
        {"id": batch_id, "printed_by": user_email}
    )
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Batch not found")
    return {"deleted": True, "id": batch_id}

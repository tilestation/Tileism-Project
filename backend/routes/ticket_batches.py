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


async def _log_print_event(db, batch: dict, user_email: str) -> None:
    """Always log a row in `ticket_print_events` even on dedupe. Used by
    the weekly Telegram digest to accurately count prints over a window.

    Each event records the timestamp + a flattened list of `(id, name,
    is_manual)` so the digest aggregator can rank top products without
    re-loading the full batch payload."""
    products = batch.get("products") or []
    event = {
        "id": str(uuid.uuid4()),
        "batch_id": batch.get("id"),
        "batch_name": batch.get("name"),
        "printed_by": user_email,
        "printed_at": datetime.now(timezone.utc).isoformat(),
        "template_name": batch.get("template_name"),
        "product_count": len(products),
        "items": [
            {
                "id": p.get("id"),
                "name": p.get("name"),
                "sku": p.get("sku") or p.get("product_code") or p.get("barcode"),
                "is_manual": bool(p.get("is_manual")),
            }
            for p in products
        ],
    }
    await db.ticket_print_events.insert_one(event)


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
        await _log_print_event(db, existing, user_email)
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
    await _log_print_event(db, batch, user_email)
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


# ---------- Weekly digest preview / manual send ----------

@router.get("/ticket-batches/digest/preview")
async def preview_ticket_digest(
    days: int = Query(7, ge=1, le=90),
    current_user: dict = Depends(get_current_user),
):
    """Returns the computed stats + the Telegram message that WOULD be
    sent. Doesn't actually send. Used by the admin UI for a sanity
    check before pushing the manual digest."""
    from services.ticket_digest import compute_ticket_digest, build_digest_message

    stats = await compute_ticket_digest(days=days)
    return {
        "stats": stats,
        "message": build_digest_message(stats),
    }


@router.post("/ticket-batches/digest/send")
async def send_ticket_digest_now(
    current_user: dict = Depends(get_current_user),
):
    """Force the weekly Telegram digest to send immediately. Used to
    test the wiring without waiting for Monday 09:15."""
    from services.ticket_digest import run_ticket_digest_tick

    return await run_ticket_digest_tick(force=True)


# ============================================================================
# Colour-Range Presets — Feb 26, 2026
#
# Showroom managers stamp out the same colour range (e.g. "White / Grey /
# Beige / Black") over and over for different tile families. Storing those
# presets server-side means every staff member at every showroom picks
# from the same shared list — no diverging local copies.
# ============================================================================
DEFAULT_COLOUR_PRESETS = [
    {"name": "Classic 4-pack", "colours": ["White", "Grey", "Beige", "Black"]},
    {"name": "Stone Naturals", "colours": ["Cream", "Sand", "Stone", "Slate"]},
    {"name": "Warm Naturals", "colours": ["Ivory", "Sand", "Terracotta", "Mocha"]},
    {"name": "Greys & Charcoals", "colours": ["Light Grey", "Grey", "Anthracite", "Charcoal"]},
    {"name": "Marble Look", "colours": ["Statuario", "Calacatta", "Carrara", "Emperador"]},
]


class ColourRangePreset(BaseModel):
    name: str = Field(..., min_length=1, max_length=60)
    colours: List[str] = Field(..., min_items=1, max_items=20)


async def _ensure_default_presets(db) -> None:
    """First-call seeding — populate the collection if empty so the
    dropdown has something useful out of the box."""
    count = await db.ticket_colour_presets.count_documents({})
    if count == 0:
        now = datetime.now(timezone.utc).isoformat()
        await db.ticket_colour_presets.insert_many([
            {
                "id": str(uuid.uuid4()),
                "name": p["name"],
                "colours": p["colours"],
                "is_default": True,
                "created_at": now,
            }
            for p in DEFAULT_COLOUR_PRESETS
        ])


@router.get("/colour-range-presets")
async def list_colour_range_presets(current_user: dict = Depends(get_current_user)):
    """All saved presets — shared across all admin users."""
    db = get_db()
    await _ensure_default_presets(db)
    items = await db.ticket_colour_presets.find(
        {},
        {"_id": 0, "id": 1, "name": 1, "colours": 1, "is_default": 1, "created_at": 1},
    ).to_list(500)
    # Newest first for custom presets, defaults at the top.
    items.sort(key=lambda x: (not x.get("is_default"), x.get("created_at", "")))
    return {"items": items}


@router.post("/colour-range-presets")
async def create_colour_range_preset(
    payload: ColourRangePreset,
    current_user: dict = Depends(get_current_user),
):
    """Save a custom preset. Names must be unique (case-insensitive)."""
    db = get_db()
    clean_colours = [c.strip() for c in payload.colours if c and c.strip()]
    if not clean_colours:
        raise HTTPException(status_code=400, detail="At least one non-empty colour required")
    # Case-insensitive uniqueness — staff often Save twice without
    # realising; we silently 200 with the existing one rather than
    # forcing them to handle a 409.
    existing = await db.ticket_colour_presets.find_one(
        {"name": {"$regex": f"^{payload.name.strip()}$", "$options": "i"}},
        {"_id": 0, "id": 1, "name": 1, "colours": 1, "is_default": 1, "created_at": 1},
    )
    if existing:
        return existing
    doc = {
        "id": str(uuid.uuid4()),
        "name": payload.name.strip(),
        "colours": clean_colours,
        "is_default": False,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "created_by": current_user.get("email", ""),
    }
    await db.ticket_colour_presets.insert_one(doc)
    # Strip mutating _id before returning.
    return {k: v for k, v in doc.items() if k != "_id"}


@router.delete("/colour-range-presets/{preset_id}")
async def delete_colour_range_preset(
    preset_id: str,
    current_user: dict = Depends(get_current_user),
):
    """Delete a custom preset. Built-in defaults can't be deleted to keep
    the seed-list stable across reboots; we 400 with a friendly hint."""
    db = get_db()
    existing = await db.ticket_colour_presets.find_one({"id": preset_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Preset not found")
    if existing.get("is_default"):
        raise HTTPException(status_code=400, detail="Built-in defaults can't be deleted")
    await db.ticket_colour_presets.delete_one({"id": preset_id})
    return {"deleted": preset_id}

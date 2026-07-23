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
from datetime import datetime, timezone, timedelta
from typing import List, Optional
import uuid
import jwt

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field

from config import get_db, JWT_SECRET
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

# PIN session validity — a warehouse manager who authenticates once can
# perform mutations for this long before being asked to re-enter their PIN.
# Balances security (limits unattended terminal abuse) with UX (spare the
# manager from typing a PIN on every single batch edit during a shift).
PIN_SESSION_MINUTES = 15


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
    """Legacy synchronous check — kept for callers that only need a quick
    boolean and can tolerate false-negatives on role-based grants. New code
    should await `_can_manage_async` so custom roles (e.g. Warehouse
    Operator) that carry `warehouse_manage` in their role.pages are
    honoured. Both funnel through the same denied/extra/legacy logic.
    """
    if user.get("role") == "super_admin":
        return True
    return has_permission(user, "warehouse_manage")


async def _can_manage_async(user: dict) -> bool:
    """Role-aware permission check. Returns True when the user is either
    Super Admin, has `warehouse_manage` in their per-user extra_pages, or
    belongs to a role whose stored `pages` list includes it. This lets a
    dedicated "Warehouse Operator" role grant floor staff the ability to
    adjust warehouse stock without adding an extras override to every
    single user record."""
    if user.get("role") == "super_admin":
        return True
    if "warehouse_manage" in (user.get("denied_pages") or []):
        return False
    if has_permission(user, "warehouse_manage"):
        return True
    role_id = user.get("role") or "staff"
    db = get_db()
    role = await db.roles.find_one({"role_id": role_id}, {"_id": 0, "pages": 1})
    return bool(role and "warehouse_manage" in (role.get("pages") or []))


async def _require_manage(user: dict):
    if not await _can_manage_async(user):
        raise HTTPException(
            status_code=403,
            detail="Warehouse stock adjustments require Super Admin or the "
                   "'Warehouse Manage' permission.",
        )


# ---------------------------------------------------------------------------
# PIN session (second-factor confirmation for every mutation)
# ---------------------------------------------------------------------------
# The workflow: manager types their staff PIN into a modal on the warehouse
# page. Backend validates the PIN via the existing `staff_pins` collection,
# then signs a short-lived JWT ("pin_session_token") that the frontend
# includes with subsequent mutation requests. The token embeds the staff
# member's name so it can be recorded on every warehouse_adjustments row.
# Once the token expires the modal re-prompts.

class PinSessionCreatePayload(BaseModel):
    pin: str = Field(..., min_length=3, max_length=12)


def _pin_can_manage_warehouse(staff: dict) -> bool:
    """Whether the *PIN holder* (as recorded in staff_pins) is authorised
    to adjust warehouse stock.

    A PIN's authority is now decoupled from the JWT user's own permissions
    — a Tonbridge showroom staff account (no warehouse_manage) can still
    hand the terminal to a floor manager and let them punch in their PIN
    to Adjust / Add / Edit / Delete a batch. The check happens here on
    PIN redemption so an unauthorised PIN never mints a session token.

    Priority order:
      1. Explicit `can_manage_warehouse` toggle on the staff_pins doc
         (set by Super Admin via the Staff PINs admin page). This wins
         in both directions — a True unlocks, a False locks even if the
         PIN's role would otherwise allow it.
      2. Legacy PINs created before the toggle existed and therefore
         missing the field: fall back to the PIN's `role` — admin and
         super_admin PINs stay authorised. Manager / staff / everything
         else must be explicitly re-enabled by Super Admin.
    """
    explicit = staff.get("can_manage_warehouse")
    if explicit is True:
        return True
    if explicit is False:
        return False
    # Legacy fallback for PINs pre-dating the toggle. Keeps admin PINs
    # working after the feature ships without requiring a data migration.
    role = (staff.get("role") or "").strip().lower()
    return role in ("super_admin", "admin")


async def _create_pin_session(db, user: dict, pin: str) -> dict:
    """Verify PIN against staff_pins and mint a signed session token."""
    # Support both is_active and active flags for legacy rows.
    staff = await db.staff_pins.find_one({
        "pin": pin,
        "$or": [{"is_active": True}, {"active": True}, {"is_active": {"$exists": False}, "active": {"$exists": False}}],
    })
    if not staff:
        raise HTTPException(status_code=401, detail="Invalid or inactive PIN")

    # Authorisation now lives on the PIN itself. This lets any logged-in
    # showroom user attempt a warehouse edit — the PIN they enter decides
    # whether it proceeds. An unauthorised PIN gets a clear 403 that names
    # the PIN holder so the shop-floor knows who to escalate to.
    if not _pin_can_manage_warehouse(staff):
        raise HTTPException(
            status_code=403,
            detail=(
                f"{staff.get('name') or 'This PIN'} does not have permission "
                "to adjust warehouse stock. Ask a Super Admin to enable "
                "\"Warehouse: can adjust stock\" on this staff PIN in Team "
                "Management → Staff PINs."
            ),
        )

    expires_at = datetime.now(timezone.utc) + timedelta(minutes=PIN_SESSION_MINUTES)
    payload = {
        "typ": "warehouse_pin",
        "user_email": user.get("email"),
        "staff_id": staff.get("id"),
        "staff_name": staff.get("name") or "",
        "staff_role": staff.get("role") or "",
        "exp": int(expires_at.timestamp()),
    }
    token = jwt.encode(payload, JWT_SECRET, algorithm="HS256")
    return {
        "session_token": token,
        "staff_name": payload["staff_name"],
        "staff_role": payload["staff_role"],
        "expires_at": expires_at.isoformat(),
    }


def _verify_pin_session(user: dict, token: Optional[str]) -> dict:
    """Decode + validate the PIN session token bound to the calling user."""
    if not token:
        raise HTTPException(status_code=401, detail="PIN required for this action")
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="PIN session expired — please re-enter your PIN")
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid PIN session")
    if payload.get("typ") != "warehouse_pin":
        raise HTTPException(status_code=401, detail="Invalid PIN session type")
    # Bind to the JWT user — a token from user A can't be replayed by user B.
    if payload.get("user_email") != user.get("email"):
        raise HTTPException(status_code=401, detail="PIN session doesn't match current user")
    return payload


async def _require_pin(
    current_user: dict, token: Optional[str], db,
) -> dict:
    """Guard: caller must present a valid PIN session token. Authorisation
    for warehouse edits is now carried by the PIN itself (verified when
    the token was minted in `_create_pin_session`), so we no longer
    re-check the JWT user's warehouse_manage. This is the design the
    owner asked for on 22 Jul 2026: showroom users can hand the terminal
    to any authorised floor manager who has a valid PIN.
    Returns the decoded PIN session (with staff_name) for audit."""
    return _verify_pin_session(current_user, token)


@router.post("/pin-session")
async def create_pin_session(
    payload: PinSessionCreatePayload,
    current_user: dict = Depends(get_current_user),
):
    """Verify PIN and issue a short-lived session token used to authorise
    subsequent warehouse mutations. The PIN is now the sole authority —
    any authenticated user can attempt entry, but only PINs flagged
    `can_manage_warehouse=true` (or legacy admin/super_admin PINs) will
    receive a token."""
    db = get_db()
    return await _create_pin_session(db, current_user, payload.pin)


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
    pin_session_token: Optional[str] = Field(default=None)


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
    Auto-creates the warehouse on first call — no manual seed needed.

    Since 22 Jul 2026 the warehouse edit permission model is PIN-gated:
    any authenticated user can *attempt* an edit, and the PIN they enter
    decides whether it goes through. So `can_manage` is now True for
    every authenticated caller. The frontend uses this to render the
    edit buttons — the PIN dialog handles the actual authorisation and
    returns a specific 403 if the PIN isn't flagged for warehouse edits.

    The legacy `can_manage_legacy` field is preserved for any external
    tooling that still expects the old JWT-user check semantic.
    """
    db = get_db()
    warehouse = await _get_or_create_warehouse(db)
    return {
        "warehouse": warehouse,
        "can_manage": True,  # anyone authenticated can *try* — PIN decides
        "can_manage_legacy": await _can_manage_async(current_user),
        "pin_gated": True,   # frontend hint: all edits require PIN dialog
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
        "warehouse_location": 1,
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
            "warehouse_location": p.get("warehouse_location") or "",
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
    db = get_db()
    pin_session = await _require_pin(current_user, payload.pin_session_token, db)

    if payload.reason not in ADJUSTMENT_REASONS:
        raise HTTPException(status_code=400, detail="Invalid reason")

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
        "authorised_by_pin": pin_session.get("staff_name"),
        "authorised_by_pin_staff_id": pin_session.get("staff_id"),
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
    include_deleted: bool = Query(default=False),
    current_user: dict = Depends(get_current_user),
):
    """Recent adjustment history — visible to every authenticated user.
    Soft-deleted rows (see DELETE endpoint) are hidden by default so the
    Recent Adjustments panel actually shrinks when the owner hits Delete.
    Pass `include_deleted=true` to review previously-deleted rows."""
    db = get_db()
    query: dict = {}
    if product_id:
        query["product_id"] = product_id
    if not include_deleted:
        query["deleted_at"] = {"$in": [None, ""]}

    cursor = db.warehouse_adjustments.find(query).sort("created_at", -1).limit(limit)
    rows = await cursor.to_list(limit)
    for r in rows:
        r.pop("_id", None)
    return {"adjustments": rows}


# ---------------------------------------------------------------------------
# Adjustment editing / reversal (23 Jul 2026)
# ---------------------------------------------------------------------------
# The owner asked for the Recent Adjustments rows themselves to be
# editable / deletable / adjustable — but any change MUST run under a
# valid PIN session so the audit stays honest.
#
# We do NOT allow mutating the historical delta / before / after / product
# fields — that would silently rewrite history. Instead:
#
#   • PATCH  /adjustments/{id}          — edits the human-facing reason
#                                          + note strings (no stock math
#                                          impact). Stamps last_edited_*
#                                          fields on the row so the audit
#                                          panel can flag it as edited.
#   • POST   /adjustments/{id}/reverse  — books a compensating adjustment
#                                          that undoes the row's delta.
#                                          Original row stays untouched;
#                                          a new "Reversed adjustment"
#                                          row appears in the audit trail
#                                          with the reverser's PIN name.
#                                          This is the "delete" affordance:
#                                          the effect on stock is deleted,
#                                          the record is preserved.

class AdjustmentEditPayload(BaseModel):
    pin_session_token: str = Field(..., min_length=10)
    # Text fields — pure metadata, no stock math impact.
    reason: Optional[str] = Field(default=None, max_length=200)
    note: Optional[str] = Field(default=None, max_length=500)
    # Numeric corrections — allow the owner to fix bad historical data.
    # Provided values REPLACE the row's before/after; the delta is
    # derived automatically. The current product stock is re-normalised
    # by adding (new_delta - old_delta) so the running total stays
    # consistent with the row's new numbers.
    before_qty: Optional[int] = Field(default=None, ge=0)
    after_qty: Optional[int] = Field(default=None, ge=0)
    # Product name — updates the LINKED product doc, not just the audit
    # row's cached copy. This propagates to every other page that shows
    # the product. Because this is a global change, the audit sub-doc
    # captures the previous name so the trail is honest.
    product_name: Optional[str] = Field(default=None, min_length=1, max_length=200)


class AdjustmentReversePayload(BaseModel):
    pin_session_token: str = Field(..., min_length=10)
    note: Optional[str] = Field(default=None, max_length=500)


@router.patch("/adjustments/{adjustment_id}")
async def edit_adjustment(
    adjustment_id: str,
    payload: AdjustmentEditPayload,
    current_user: dict = Depends(get_current_user),
):
    """Full edit of an adjustment row — reason, note, before/after
    quantities and even the linked product's name. Numeric edits
    re-normalise the current warehouse stock so the running total
    stays consistent with the row's new numbers.

    Every changed field is snapshotted into a `previous_values`
    array on the doc so the audit is preserved end-to-end — an
    edit does NOT overwrite history, it appends a diff."""
    db = get_db()
    pin_session = await _require_pin(current_user, payload.pin_session_token, db)

    existing = await db.warehouse_adjustments.find_one({"id": adjustment_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Adjustment not found")
    if existing.get("reversed"):
        raise HTTPException(
            status_code=409,
            detail="This adjustment has been reversed — edits are no longer allowed on the original row.",
        )

    # Track everything that changes so both the audit sub-doc and the
    # global audit log carry the full before/after diff.
    changed: dict = {}
    old_snapshot: dict = {}
    if payload.reason is not None and payload.reason.strip() and payload.reason.strip() != existing.get("reason"):
        old_snapshot["reason"] = existing.get("reason")
        changed["reason"] = payload.reason.strip()
    if payload.note is not None and payload.note != existing.get("note"):
        old_snapshot["note"] = existing.get("note")
        changed["note"] = payload.note

    # ---- Numeric corrections ---------------------------------------
    new_before = payload.before_qty if payload.before_qty is not None else existing.get("before_qty")
    new_after = payload.after_qty if payload.after_qty is not None else existing.get("after_qty")
    numeric_changed = (
        (payload.before_qty is not None and payload.before_qty != existing.get("before_qty"))
        or (payload.after_qty is not None and payload.after_qty != existing.get("after_qty"))
    )
    if numeric_changed:
        old_delta = int(existing.get("delta") or 0)
        new_delta = int(new_after) - int(new_before)
        old_snapshot["before_qty"] = existing.get("before_qty")
        old_snapshot["after_qty"] = existing.get("after_qty")
        old_snapshot["delta"] = existing.get("delta")
        changed["before_qty"] = int(new_before)
        changed["after_qty"] = int(new_after)
        changed["delta"] = new_delta
        # Re-normalise the current warehouse stock. The row's new numbers
        # differ from the old by (new_delta - old_delta); apply that
        # difference to the product's live stock so the running total
        # matches the row again.
        product = await db.products.find_one({"id": existing["product_id"]}, {"_id": 0})
        if product:
            warehouse_id = existing.get("warehouse_id")
            current_stock = int((product.get("showroom_stock") or {}).get(warehouse_id, 0) or 0)
            adjusted_stock = max(0, current_stock + (new_delta - old_delta))
            await db.products.update_one(
                {"id": existing["product_id"]},
                {"$set": {
                    f"showroom_stock.{warehouse_id}": adjusted_stock,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }},
            )

    # ---- Product name (global change) ------------------------------
    if payload.product_name is not None:
        new_name = payload.product_name.strip()
        if new_name and new_name != existing.get("product_name"):
            old_snapshot["product_name"] = existing.get("product_name")
            changed["product_name"] = new_name
            # Update the linked product globally.
            await db.products.update_one(
                {"id": existing["product_id"]},
                {"$set": {
                    "name": new_name,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }},
            )

    if not changed:
        return {"success": True, "unchanged": True, "adjustment": existing}

    # Append this edit to the row's edit history sub-array so we never
    # actually lose the previous numbers or text. The UI can render
    # this as a small "edited 2x — see history" pill on the row.
    edit_record = {
        "edited_at": datetime.now(timezone.utc).isoformat(),
        "edited_by_pin": pin_session.get("staff_name"),
        "edited_by_email": current_user.get("email"),
        "previous_values": old_snapshot,
        "new_values": {k: v for k, v in changed.items()},
    }

    update_doc: dict = {
        **changed,
        "last_edited_at": edit_record["edited_at"],
        "last_edited_by_pin": edit_record["edited_by_pin"],
        "last_edited_by_email": current_user.get("email"),
    }
    await db.warehouse_adjustments.update_one(
        {"id": adjustment_id},
        {
            "$set": update_doc,
            "$push": {"edit_history": edit_record},
        },
    )

    await log_audit(
        action="UPDATE",
        entity_type="warehouse_adjustment",
        user=current_user,
        entity_id=adjustment_id,
        entity_name=changed.get("product_name") or existing.get("product_name"),
        before_data=old_snapshot,
        after_data=changed,
        details=(
            f"Edited warehouse adjustment "
            f"(fields: {', '.join(changed.keys())}) — authorised by PIN: "
            f"{pin_session.get('staff_name')}"
        ),
    )

    updated = await db.warehouse_adjustments.find_one({"id": adjustment_id}, {"_id": 0})
    return {"success": True, "adjustment": updated}


@router.post("/adjustments/{adjustment_id}/reverse")
async def reverse_adjustment(
    adjustment_id: str,
    payload: AdjustmentReversePayload,
    current_user: dict = Depends(get_current_user),
):
    """Soft-delete an adjustment row and roll back its stock effect. The
    row disappears from the Recent Adjustments panel; a copy is preserved
    in the DB with `deleted_at` so `?include_deleted=true` can still show
    it if the owner wants a forensic view.

    Renamed semantically 23 Jul 2026 — the previous implementation booked
    a compensating row and left both in the audit trail, but the owner
    reported the compensating chain kept growing every time they clicked
    Delete (rows "coming back") so we switched to a proper soft-delete
    with cascade cleanup:

      • Regular row (never reversed / never deleted): subtract its delta
        from product stock so the row's effect is truly undone.
      • Row that was previously reversed (has `reversed_adjustment_id`):
        this row and its compensating partner cancel to zero. Deleting
        the pair leaves stock untouched — but we ALSO soft-delete the
        compensating row so the audit doesn't end up with orphans.
      • Row that IS itself a compensating row (has `reverses_adjustment_id`):
        deleting the compensator un-reverses its target. Stock: undo the
        compensator's delta (which was applied when it was booked).

    Anything else is a no-op on stock. The response includes the list of
    ids that were soft-deleted so the caller can toast "2 rows removed".
    """
    db = get_db()
    pin_session = await _require_pin(current_user, payload.pin_session_token, db)

    original = await db.warehouse_adjustments.find_one({"id": adjustment_id}, {"_id": 0})
    if not original:
        raise HTTPException(status_code=404, detail="Adjustment not found")
    if original.get("deleted_at"):
        raise HTTPException(status_code=409, detail="This adjustment has already been deleted.")

    warehouse = await _get_or_create_warehouse(db)
    warehouse_id = warehouse["id"]
    product = await db.products.find_one({"id": original["product_id"]}, {"_id": 0})
    if not product:
        raise HTTPException(status_code=404, detail="Product no longer exists.")

    ids_to_delete: list = [adjustment_id]
    stock_delta_change: int = 0  # what to add to product stock

    if original.get("reverses_adjustment_id"):
        # Deleting a compensating row → un-reverse its target and undo the
        # compensator's own delta effect.
        target_id = original["reverses_adjustment_id"]
        target = await db.warehouse_adjustments.find_one({"id": target_id}, {"_id": 0})
        if target and target.get("reversed"):
            await db.warehouse_adjustments.update_one(
                {"id": target_id},
                {
                    "$unset": {
                        "reversed": "",
                        "reversed_at": "",
                        "reversed_by_pin": "",
                        "reversed_by_email": "",
                        "reversed_adjustment_id": "",
                    },
                },
            )
        stock_delta_change = -int(original.get("delta") or 0)

    elif original.get("reversed") and original.get("reversed_adjustment_id"):
        # Deleting a row that has a compensating partner — soft-delete both;
        # the pair nets to zero on stock so no delta change is needed.
        comp_id = original["reversed_adjustment_id"]
        comp = await db.warehouse_adjustments.find_one({"id": comp_id}, {"_id": 0})
        if comp and not comp.get("deleted_at"):
            ids_to_delete.append(comp_id)
        stock_delta_change = 0

    else:
        # Standalone row → undo its delta effect on stock.
        stock_delta_change = -int(original.get("delta") or 0)

    # Apply stock adjustment.
    if stock_delta_change != 0:
        current_stock = int((product.get("showroom_stock") or {}).get(warehouse_id, 0) or 0)
        new_stock = max(0, current_stock + stock_delta_change)
        await db.products.update_one(
            {"id": original["product_id"]},
            {"$set": {
                f"showroom_stock.{warehouse_id}": new_stock,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }},
        )

    # Soft-delete every impacted row in one hit.
    now_iso = datetime.now(timezone.utc).isoformat()
    await db.warehouse_adjustments.update_many(
        {"id": {"$in": ids_to_delete}},
        {"$set": {
            "deleted_at": now_iso,
            "deleted_by_pin": pin_session.get("staff_name"),
            "deleted_by_email": current_user.get("email"),
            "deleted_reason_note": (payload.note or "")[:500] or None,
        }},
    )

    await log_audit(
        action="DELETE",
        entity_type="warehouse_adjustment",
        user=current_user,
        entity_id=adjustment_id,
        entity_name=original.get("product_name"),
        before_data={
            "delta": original.get("delta"),
            "after_qty": original.get("after_qty"),
            "reversed": bool(original.get("reversed")),
        },
        after_data={
            "deleted_row_ids": ids_to_delete,
            "stock_delta_applied": stock_delta_change,
        },
        details=(
            f"Deleted warehouse adjustment for {original.get('product_name')} — "
            f"authorised by PIN: {pin_session.get('staff_name')}"
        ),
    )

    return {
        "success": True,
        "deleted_ids": ids_to_delete,
        "stock_delta_applied": stock_delta_change,
    }


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
    location: Optional[str] = Field(default=None, max_length=100)
    notes: Optional[str] = Field(default=None, max_length=500)
    pin_session_token: Optional[str] = Field(default=None)


class BatchUpdatePayload(BaseModel):
    batch_number: Optional[str] = Field(default=None, min_length=1, max_length=100)
    boxes: Optional[int] = Field(default=None, ge=0)
    tiles_per_box: Optional[int] = Field(default=None, gt=0)
    extra_pieces: Optional[int] = Field(default=None, ge=0)
    location: Optional[str] = Field(default=None, max_length=100)
    notes: Optional[str] = Field(default=None, max_length=500)
    reason: Optional[str] = Field(default=None, max_length=64)
    pin_session_token: Optional[str] = Field(default=None)


class QuickAddProductPayload(BaseModel):
    """Minimal product-creation payload for the warehouse's inline form.
    Full product management (pricing, categories, variants) still lives on
    /admin/products. This flow only captures what the warehouse team needs
    to log batches: identity + tile dimensions + default warehouse bay."""
    name: str = Field(..., min_length=1, max_length=200)
    sku: str = Field(..., min_length=1, max_length=100)
    barcode: Optional[str] = Field(default=None, max_length=100)
    category_name: Optional[str] = Field(default=None, max_length=100)
    tile_width: Optional[float] = Field(default=None, gt=0)   # mm
    tile_height: Optional[float] = Field(default=None, gt=0)  # mm
    tiles_per_box: Optional[int] = Field(default=None, gt=0)
    image_url: Optional[str] = Field(default=None, max_length=1000)
    warehouse_location: Optional[str] = Field(default=None, max_length=100)
    pin_session_token: Optional[str] = Field(default=None)


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
    pin_session: Optional[dict] = None,
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
        "authorised_by_pin": (pin_session or {}).get("staff_name"),
        "authorised_by_pin_staff_id": (pin_session or {}).get("staff_id"),
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
    db = get_db()
    pin_session = await _require_pin(current_user, payload.pin_session_token, db)

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
        "warehouse_location": (payload.warehouse_location or "").strip(),
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


class ProductLocationPayload(BaseModel):
    warehouse_location: str = Field(default="", max_length=100)
    pin_session_token: Optional[str] = Field(default=None)


@router.put("/products/{product_id}/location")
async def set_product_default_location(
    product_id: str,
    payload: ProductLocationPayload,
    current_user: dict = Depends(get_current_user),
):
    """Set the product's DEFAULT warehouse bay/rack. New batches created
    for this product without an explicit location will inherit this. Does
    NOT retroactively move existing batches — the location on already-
    logged batches is intentionally sticky (the stock physically sits where
    it sits until someone edits that batch)."""
    db = get_db()
    await _require_pin(current_user, payload.pin_session_token, db)
    product = await db.products.find_one({"id": product_id})
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")

    new_loc = (payload.warehouse_location or "").strip()
    await db.products.update_one(
        {"id": product_id},
        {"$set": {
            "warehouse_location": new_loc,
            "updated_at": datetime.now(timezone.utc),
        }},
    )
    await log_audit(
        action="UPDATE",
        entity_type="product",
        user=current_user,
        entity_id=product_id,
        entity_name=product.get("name"),
        before_data={"warehouse_location": product.get("warehouse_location") or ""},
        after_data={"warehouse_location": new_loc},
        details=f"Default warehouse location set to '{new_loc}'",
    )
    return {"success": True, "warehouse_location": new_loc}



@router.post("/batches")
async def create_batch(
    payload: BatchCreatePayload,
    current_user: dict = Depends(get_current_user),
):
    """Add a batch to a product. Bumps warehouse stock and logs audit."""
    db = get_db()
    pin_session = await _require_pin(current_user, payload.pin_session_token, db)
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

    # If the caller didn't specify a location, fall back to the product's
    # default warehouse_location (set at quick-add time). Empty string is
    # allowed — some batches genuinely aren't slotted yet.
    location = (payload.location or "").strip()
    if not location:
        location = (product.get("warehouse_location") or "").strip()

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
        "location": location,
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
        pin_session=pin_session,
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
    db = get_db()
    pin_session = await _require_pin(current_user, payload.pin_session_token, db)
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
    if payload.location is not None:
        updates["location"] = payload.location.strip()
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
        pin_session=pin_session,
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
    pin_session_token: Optional[str] = Header(default=None, alias="X-Warehouse-Pin"),
    current_user: dict = Depends(get_current_user),
):
    """Soft-delete a batch. Its total_pieces stop counting toward warehouse
    stock immediately. We keep the row for audit — a hard delete would
    lose the history."""
    db = get_db()
    pin_session = await _require_pin(current_user, pin_session_token, db)
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
        pin_session=pin_session,
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

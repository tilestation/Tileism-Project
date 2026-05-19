"""
Refund management routes
"""
import uuid
import logging

logger = logging.getLogger(__name__)

from datetime import datetime, timezone
from typing import Optional, List
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

from config import get_db
from services import get_current_user, is_admin_user, log_audit

router = APIRouter(prefix="/refunds", tags=["Refunds"])


# ============ Trade Credit — proportional reversal on refund ===============
# A refund note can be issued against a full or partial invoice. We reverse
# trade credit proportionally to refund_gross / original_invoice_gross,
# tracking cumulative reversal on the invoice so multiple partial refunds
# never overshoot the original credit movement.

async def reverse_credits_for_refund(
    db, refund_dict: dict,
) -> dict:
    """Idempotent proportional credit-reversal triggered by a Refund Note.

    Returns a summary the caller can stamp on the refund doc + return to UI.
    Quietly returns zeros when the refund is unattached to an invoice or the
    invoice had no trade-credit movement.
    """
    summary = {"earned_reversed": 0.0, "redeemed_reversed": 0.0, "ratio": 0.0}
    inv_id = refund_dict.get("original_invoice_id")
    if not inv_id:
        return summary

    invoice = await db.invoices.find_one({"id": inv_id})
    if not invoice:
        return summary

    invoice_gross = float(invoice.get("gross_total") or 0)
    if invoice_gross <= 0:
        return summary

    refund_amount = float(refund_dict.get("net_refund") or refund_dict.get("gross_total") or 0)
    if refund_amount <= 0:
        return summary

    # Cap ratio at 1.0 — over-refunds (rare, usually data-entry error) shouldn't
    # over-reverse credit. The accountant can manually adjust if needed.
    raw_ratio = refund_amount / invoice_gross
    ratio = min(1.0, raw_ratio)

    earned_total = float(invoice.get("trade_credit_earned") or 0)
    redeemed_total = float(invoice.get("credit_redeemed") or 0)

    # Cumulative cap — earlier partial refunds may have already reversed some
    already_earned_reversed = float(invoice.get("credit_earned_already_reversed") or 0)
    already_redeemed_reversed = float(invoice.get("credit_redeemed_already_reversed") or 0)

    earned_to_reverse = round(min(earned_total * ratio, earned_total - already_earned_reversed), 2)
    redeemed_to_refund = round(min(redeemed_total * ratio, redeemed_total - already_redeemed_reversed), 2)

    if earned_to_reverse <= 0 and redeemed_to_refund <= 0:
        return summary

    earned_ref = (invoice.get("trade_account_number") or "").strip()
    redeemed_ref = (invoice.get("credit_redeemed_account") or "").strip()
    refund_no = refund_dict.get("refund_no", "")
    refund_id = refund_dict.get("id")
    invoice_no = invoice.get("invoice_no", "")
    now = datetime.now(timezone.utc).isoformat()

    if earned_to_reverse > 0 and earned_ref:
        cust = await db.shop_customers.find_one_and_update(
            {"trade_account_number": earned_ref},
            {"$inc": {"credit_balance": -earned_to_reverse}},
            return_document=False,
        )
        prior_balance = float((cust or {}).get("credit_balance") or 0)
        await db.credit_transactions.insert_one({
            "id": str(uuid.uuid4()),
            "customer_id": (cust or {}).get("id"),
            "trade_account_number": earned_ref,
            "type": "reversed_earned_via_refund",
            "amount": -earned_to_reverse,
            "balance_after": round(prior_balance - earned_to_reverse, 2),
            "source": "refund_note",
            "invoice_id": inv_id,
            "invoice_no": invoice_no,
            "refund_id": refund_id,
            "refund_no": refund_no,
            "description": f"Reversed credit-back from invoice {invoice_no} via refund {refund_no} ({(ratio*100):.1f}% of invoice)",
            "created_at": now,
        })
        summary["earned_reversed"] = earned_to_reverse

    if redeemed_to_refund > 0 and redeemed_ref:
        cust = await db.shop_customers.find_one_and_update(
            {"trade_account_number": redeemed_ref},
            {"$inc": {"credit_balance": redeemed_to_refund}},  # add back
            return_document=False,
        )
        prior_balance = float((cust or {}).get("credit_balance") or 0)
        await db.credit_transactions.insert_one({
            "id": str(uuid.uuid4()),
            "customer_id": (cust or {}).get("id"),
            "trade_account_number": redeemed_ref,
            "type": "reversed_redeemed_via_refund",
            "amount": redeemed_to_refund,
            "balance_after": round(prior_balance + redeemed_to_refund, 2),
            "source": "refund_note",
            "invoice_id": inv_id,
            "invoice_no": invoice_no,
            "refund_id": refund_id,
            "refund_no": refund_no,
            "description": f"Refunded credit redemption from invoice {invoice_no} via refund {refund_no} ({(ratio*100):.1f}% of invoice)",
            "created_at": now,
        })
        summary["redeemed_reversed"] = redeemed_to_refund

    # Stamp cumulative trackers on the invoice so subsequent refunds know
    # what's already been reversed. We DON'T set `credits_reversed=true`
    # (which is the all-or-nothing flag used by delete-flow) — partial
    # refunds use this incremental counter instead.
    await db.invoices.update_one(
        {"id": inv_id},
        {"$inc": {
            "credit_earned_already_reversed": earned_to_reverse,
            "credit_redeemed_already_reversed": redeemed_to_refund,
        }},
    )
    summary["ratio"] = round(ratio, 4)
    return summary


# ============ MODELS ============

class RefundLineItem(BaseModel):
    product_id: Optional[str] = None
    product_name: str
    sku: Optional[str] = None
    quantity: float
    original_price: float
    refund_price: float
    total: float
    reason: Optional[str] = ""

class RefundCreate(BaseModel):
    refund_no: str
    date: str
    time: Optional[str] = None
    original_invoice_no: Optional[str] = None
    original_invoice_id: Optional[str] = None
    customer_name: Optional[str] = None
    customer_phone: Optional[str] = None
    customer_email: Optional[str] = None
    customer_address: Optional[str] = None
    notes: Optional[str] = None
    sales_person: Optional[str] = None
    staff_pin: Optional[str] = None
    refund_method: Optional[str] = None  # Cash, Card, Bank Transfer, Store Credit
    refund_type: Optional[str] = None  # Full Refund, Partial Refund, Exchange
    showroom_id: Optional[str] = None
    showroom_name: Optional[str] = None
    line_items: List[RefundLineItem]
    subtotal: float
    vat: float
    gross_total: float
    restocking_fee: Optional[float] = 0
    net_refund: Optional[float] = None  # gross_total - restocking_fee
    # 24 Feb 2026 — Super Admin override for the "must have original
    # invoice" rule. Required + acknowledged for any refund without a
    # linked invoice. UI surfaces a checkbox + reason field when the
    # current user is super_admin. Non-super-admins cannot submit this.
    no_invoice_override: Optional[bool] = False
    no_invoice_reason: Optional[str] = None

class RefundUpdate(BaseModel):
    refund_no: Optional[str] = None
    date: Optional[str] = None
    time: Optional[str] = None
    customer_name: Optional[str] = None
    customer_phone: Optional[str] = None
    customer_email: Optional[str] = None
    customer_address: Optional[str] = None
    notes: Optional[str] = None
    sales_person: Optional[str] = None
    refund_method: Optional[str] = None
    refund_type: Optional[str] = None
    line_items: Optional[List[RefundLineItem]] = None
    subtotal: Optional[float] = None
    vat: Optional[float] = None
    gross_total: Optional[float] = None
    restocking_fee: Optional[float] = None
    net_refund: Optional[float] = None
    status: Optional[str] = None


# ============ ROUTES ============

@router.post("")
async def create_refund(input: RefundCreate, current_user: dict = Depends(get_current_user)):
    """Create a new refund and restore stock"""
    # Allow admin users OR users with epos permission
    user_permissions = current_user.get("permissions", [])
    has_access = is_admin_user(current_user) or "epos" in user_permissions
    if not has_access:
        raise HTTPException(status_code=403, detail="Access denied. You need admin role or EPOS permission.")

    # ─── Original-invoice policy (24 Feb 2026) ──────────────────────
    # User intent (logged 19/05/2026): "Do not let anyone issue the
    # refund without Original Invoice linked. If just in case it's a
    # must to process refund without the original Invoice linked, then
    # only Super Admin should approve. Super Admin needs to receive a
    # notification."
    #
    # Implementation:
    #   1. Every refund MUST link to an original invoice unless the
    #      caller is super_admin AND explicitly passes
    #      no_invoice_override=true with a non-empty no_invoice_reason.
    #   2. When a no-invoice refund IS approved (super_admin path),
    #      we stamp `no_invoice_override=true` + `no_invoice_reason`
    #      + `no_invoice_approved_by` on the refund doc for the audit
    #      trail, and fire a Telegram notification to super admins
    #      who aren't physically in the showroom.
    has_invoice_link = bool(
        (input.original_invoice_id or "").strip()
        or (input.original_invoice_no or "").strip()
    )
    is_super_admin = current_user.get("role") == "super_admin"

    if not has_invoice_link:
        if not is_super_admin:
            raise HTTPException(
                status_code=403,
                detail=(
                    "Refunds must be linked to the original invoice. "
                    "If the invoice cannot be located, ask a Super Admin "
                    "to process this refund and approve the override."
                ),
            )
        # Super admin path — still requires explicit acknowledgement
        # + a written reason so we have something in the audit trail.
        if not input.no_invoice_override:
            raise HTTPException(
                status_code=400,
                detail=(
                    "This refund has no linked invoice. As Super Admin, "
                    "set no_invoice_override=true and provide "
                    "no_invoice_reason to proceed."
                ),
            )
        if not (input.no_invoice_reason or "").strip() or len((input.no_invoice_reason or "").strip()) < 6:
            raise HTTPException(
                status_code=400,
                detail="no_invoice_reason is required and must be at least 6 characters.",
            )

    # Validate line items
    if not input.line_items or len(input.line_items) == 0:
        raise HTTPException(status_code=400, detail="Refund must have at least one line item")
    
    db = get_db()
    
    # Check for duplicate refund number
    existing_refund = await db.refunds.find_one({"refund_no": input.refund_no}, {"_id": 0, "id": 1})
    if existing_refund:
        raise HTTPException(status_code=400, detail=f"Refund {input.refund_no} already exists. Cannot save duplicate.")
    
    # Verify staff PIN if provided
    staff_member = None
    if input.staff_pin:
        staff_member = await db.staff_pins.find_one({"pin": input.staff_pin, "active": True}, {"_id": 0})
        if not staff_member:
            raise HTTPException(status_code=401, detail="Invalid staff PIN")
    
    # Restore stock for each refunded item
    for item in input.line_items:
        if item.product_id and item.product_id.strip():
            product = await db.products.find_one({"id": item.product_id}, {"_id": 0})
            if product:
                new_stock = product.get("stock", 0) + int(item.quantity)
                await db.products.update_one(
                    {"id": item.product_id},
                    {"$set": {"stock": new_stock}}
                )
    
    # Calculate net refund
    net_refund = input.gross_total - (input.restocking_fee or 0)
    
    # Save refund
    refund_dict = {
        "id": str(uuid.uuid4()),
        "refund_no": input.refund_no,
        "date": input.date,
        "time": input.time,
        "original_invoice_no": input.original_invoice_no,
        "original_invoice_id": input.original_invoice_id,
        "customer_name": input.customer_name,
        "customer_phone": input.customer_phone,
        "customer_email": input.customer_email,
        "customer_address": input.customer_address,
        "notes": input.notes,
        "sales_person": staff_member["name"] if staff_member else input.sales_person,
        "staff_id": staff_member["id"] if staff_member else None,
        "staff_name": staff_member["name"] if staff_member else None,
        "refund_method": input.refund_method,
        "refund_type": input.refund_type,
        "showroom_id": input.showroom_id,
        "showroom_name": input.showroom_name,
        "line_items": [item.model_dump() for item in input.line_items],
        "subtotal": input.subtotal,
        "vat": input.vat,
        "gross_total": input.gross_total,
        "restocking_fee": input.restocking_fee or 0,
        "net_refund": net_refund,
        "status": "completed",
        "created_by": current_user["email"],
        "created_at": datetime.now(timezone.utc).isoformat(),
        # No-invoice-override audit fields (only set when Super Admin
        # approves a refund with no linked original invoice). Always
        # stored so the columns are queryable for reports later.
        "no_invoice_override": bool(input.no_invoice_override and not has_invoice_link),
        "no_invoice_reason": (input.no_invoice_reason or "").strip() if (input.no_invoice_override and not has_invoice_link) else None,
        "no_invoice_approved_by": current_user.get("email") if (input.no_invoice_override and not has_invoice_link) else None,
        "no_invoice_approved_at": datetime.now(timezone.utc).isoformat() if (input.no_invoice_override and not has_invoice_link) else None,
    }
    
    await db.refunds.insert_one(refund_dict)

    # Reverse trade credit proportional to refund amount (idempotent via
    # cumulative trackers stamped on the original invoice). Stamps the
    # reversal summary on the refund doc so we have an audit trail.
    credit_summary = await reverse_credits_for_refund(db, refund_dict)
    if credit_summary["earned_reversed"] > 0 or credit_summary["redeemed_reversed"] > 0:
        await db.refunds.update_one(
            {"id": refund_dict["id"]},
            {"$set": {
                "credit_earned_reversed": credit_summary["earned_reversed"],
                "credit_redeemed_refunded": credit_summary["redeemed_reversed"],
                "credit_reversal_ratio": credit_summary["ratio"],
            }},
        )

    # Log audit trail
    await log_audit(
        action="CREATE",
        entity_type="refund",
        user=current_user,
        entity_id=refund_dict["id"],
        entity_name=refund_dict["refund_no"],
        after_data={
            "refund_no": refund_dict["refund_no"],
            "customer_name": refund_dict.get("customer_name"),
            "gross_total": refund_dict["gross_total"],
            "net_refund": refund_dict["net_refund"],
            "showroom_name": refund_dict.get("showroom_name"),
            "items_count": len(refund_dict["line_items"]),
            "no_invoice_override": refund_dict["no_invoice_override"],
            "no_invoice_reason": refund_dict.get("no_invoice_reason"),
        },
        details=f"Refund {refund_dict['refund_no']} created for £{refund_dict['net_refund']:.2f}"
    )

    # Notify Super Admins on Telegram for any no-invoice override.
    # Super Admin isn't physically present in the showrooms — this is the
    # only way they hear about an override approval. Sent fire-and-forget
    # so a slow / failing Telegram doesn't block the refund response.
    if refund_dict["no_invoice_override"]:
        try:
            from services.telegram_notify import fire_and_forget as _telegram_fire
            text = (
                "🚨 <b>No-invoice refund issued</b>\n"
                f"<b>Ref:</b> {refund_dict['refund_no']}\n"
                f"<b>Amount:</b> £{refund_dict['net_refund']:.2f} ({refund_dict.get('refund_method') or '—'})\n"
                f"<b>Customer:</b> {refund_dict.get('customer_name') or '—'}\n"
                f"<b>Showroom:</b> {refund_dict.get('showroom_name') or '—'}\n"
                f"<b>Approved by:</b> {refund_dict['no_invoice_approved_by']}\n"
                f"<b>Reason:</b> {refund_dict.get('no_invoice_reason') or '—'}"
            )
            _telegram_fire(
                "no_invoice_refund",
                text,
                dedupe_key=refund_dict["refund_no"],
            )
        except Exception as e:  # pragma: no cover — never block refund on notify failure
            logger.warning("Telegram no_invoice_refund notify failed: %s", e)

    return {
        "message": "Refund processed and stock restored",
        "refund_id": refund_dict["id"],
        "refund_no": refund_dict["refund_no"],
        "net_refund": refund_dict["net_refund"],
        "staff_name": staff_member["name"] if staff_member else None,
        "credits_reversed": credit_summary,
        "no_invoice_override": refund_dict["no_invoice_override"],
    }


@router.get("")
async def get_refunds(
    current_user: dict = Depends(get_current_user),
    search: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    showroom_id: Optional[str] = None,
    include_deleted: bool = False
):
    """Get all refunds with optional search and filters"""
    user_permissions = current_user.get("permissions", [])
    has_access = is_admin_user(current_user) or "epos" in user_permissions
    if not has_access:
        raise HTTPException(status_code=403, detail="Access denied. You need admin role or EPOS permission.")
    
    db = get_db()
    query = {}
    
    # Exclude deleted documents unless specifically requested (super_admin only)
    if include_deleted and current_user.get("role") == "super_admin":
        query["deleted_at"] = {"$exists": True}
    else:
        query["deleted_at"] = {"$exists": False}
    
    # Filter by showroom for non-super-admin users
    user_showroom_id = current_user.get("showroom_id")
    if current_user.get("role") != "super_admin" and user_showroom_id:
        query["showroom_id"] = user_showroom_id
    elif showroom_id:
        query["showroom_id"] = showroom_id
    
    if search:
        search_query = [
            {"refund_no": {"$regex": search, "$options": "i"}},
            {"original_invoice_no": {"$regex": search, "$options": "i"}},
            {"customer_name": {"$regex": search, "$options": "i"}},
            {"customer_phone": {"$regex": search, "$options": "i"}},
            {"staff_name": {"$regex": search, "$options": "i"}},
        ]
        if "$or" not in query:
            query["$or"] = search_query
        else:
            query = {"$and": [query, {"$or": search_query}]}
    
    refunds = await db.refunds.find(query, {"_id": 0}).sort("created_at", -1).to_list(100000)
    return refunds


@router.get("/{refund_id}")
async def get_refund(refund_id: str, current_user: dict = Depends(get_current_user)):
    """Get single refund (admin only)"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    refund = await db.refunds.find_one({"id": refund_id}, {"_id": 0})
    if not refund:
        raise HTTPException(status_code=404, detail="Refund not found")
    
    return refund


@router.put("/{refund_id}")
async def update_refund(refund_id: str, input: RefundUpdate, current_user: dict = Depends(get_current_user)):
    """Update an existing refund (admin only)"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    existing = await db.refunds.find_one({"id": refund_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Refund not found")
    
    # Handle stock adjustments if line items changed
    if input.line_items is not None:
        old_items = {item["product_id"]: item["quantity"] for item in existing.get("line_items", []) if item.get("product_id")}
        
        # Reverse old stock restoration
        for product_id, old_qty in old_items.items():
            if product_id and product_id.strip():
                await db.products.update_one(
                    {"id": product_id},
                    {"$inc": {"stock": -int(old_qty)}}
                )
        
        # Apply new stock restoration
        for item in input.line_items:
            if item.product_id and item.product_id.strip():
                await db.products.update_one(
                    {"id": item.product_id},
                    {"$inc": {"stock": int(item.quantity)}}
                )
    
    # Build update data
    update_data = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "updated_by": current_user["email"]
    }
    
    for field in ["refund_no", "date", "time", "customer_name", "customer_phone", 
                  "customer_email", "customer_address", "notes", "sales_person",
                  "refund_method", "refund_type", "subtotal", "vat", "gross_total",
                  "restocking_fee", "status"]:
        value = getattr(input, field, None)
        if value is not None:
            update_data[field] = value
    
    if input.line_items is not None:
        update_data["line_items"] = [item.model_dump() for item in input.line_items]
    
    # Recalculate net refund
    if input.gross_total is not None or input.restocking_fee is not None:
        gross = input.gross_total if input.gross_total is not None else existing.get("gross_total", 0)
        fee = input.restocking_fee if input.restocking_fee is not None else existing.get("restocking_fee", 0)
        update_data["net_refund"] = gross - fee
    
    await db.refunds.update_one({"id": refund_id}, {"$set": update_data})
    
    # Log audit
    await log_audit(
        action="UPDATE",
        entity_type="refund",
        user=current_user,
        entity_id=refund_id,
        entity_name=existing.get("refund_no"),
        before_data={"gross_total": existing.get("gross_total"), "net_refund": existing.get("net_refund")},
        after_data={"gross_total": update_data.get("gross_total", existing.get("gross_total")), 
                   "net_refund": update_data.get("net_refund", existing.get("net_refund"))},
        details=f"Refund {existing.get('refund_no')} updated"
    )
    
    return {"message": "Refund updated successfully", "refund_id": refund_id}


@router.delete("/{refund_id}")
async def delete_refund(refund_id: str, current_user: dict = Depends(get_current_user)):
    """Soft delete a refund (Super Admin only) - moves to trash for 30 days"""
    # Only Super Admin can delete documents
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Only Super Admin can delete documents")
    
    db = get_db()
    refund = await db.refunds.find_one({"id": refund_id})
    if not refund:
        raise HTTPException(status_code=404, detail="Refund not found")
    
    if refund.get("deleted_at"):
        raise HTTPException(status_code=400, detail="Refund is already in trash")
    
    # Soft delete
    deleted_at = datetime.now(timezone.utc)
    await db.refunds.update_one(
        {"id": refund_id},
        {"$set": {
            "deleted_at": deleted_at.isoformat(),
            "deleted_by": current_user.get("email"),
            "deleted_by_name": current_user.get("name", current_user.get("email"))
        }}
    )
    
    # Reverse stock restoration for all line items (same as before)
    for item in refund.get("line_items", []):
        product_id = item.get("product_id")
        if product_id and product_id.strip():
            await db.products.update_one(
                {"id": product_id},
                {"$inc": {"stock": -int(item["quantity"])}}
            )
    
    await log_audit(
        action="SOFT_DELETE",
        entity_type="refund",
        user=current_user,
        entity_id=refund_id,
        entity_name=refund.get("refund_no"),
        before_data={
            "refund_no": refund.get("refund_no"),
            "customer_name": refund.get("customer_name"),
            "net_refund": refund.get("net_refund")
        },
        details=f"Refund {refund.get('refund_no')} moved to trash, stock adjustments reversed. Can be restored or permanently deleted from Trash."
    )
    
    return {"message": "Refund moved to trash. It can be restored or permanently deleted from Trash."}


@router.post("/{refund_id}/restore")
async def restore_refund(refund_id: str, current_user: dict = Depends(get_current_user)):
    """Restore a soft-deleted refund from trash (Super Admin only)"""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Only Super Admin can restore documents")
    
    db = get_db()
    refund = await db.refunds.find_one({"id": refund_id})
    if not refund:
        raise HTTPException(status_code=404, detail="Refund not found")
    
    if not refund.get("deleted_at"):
        raise HTTPException(status_code=400, detail="Refund is not in trash")
    
    await db.refunds.update_one(
        {"id": refund_id},
        {"$unset": {"deleted_at": "", "deleted_by": "", "deleted_by_name": ""}}
    )
    
    # Restore stock adjustments (reverse the reversal)
    for item in refund.get("line_items", []):
        product_id = item.get("product_id")
        if product_id and product_id.strip():
            await db.products.update_one(
                {"id": product_id},
                {"$inc": {"stock": int(item["quantity"])}}
            )
    
    await log_audit(
        action="RESTORE",
        entity_type="refund",
        user=current_user,
        entity_id=refund_id,
        entity_name=refund.get("refund_no"),
        details=f"Refund {refund.get('refund_no')} restored from trash, stock adjustments restored."
    )
    
    return {"message": "Refund restored successfully"}


@router.delete("/{refund_id}/permanent")
async def permanent_delete_refund(refund_id: str, current_user: dict = Depends(get_current_user)):
    """Permanently delete a refund (Super Admin only)"""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Only Super Admin can permanently delete documents")
    
    db = get_db()
    refund = await db.refunds.find_one({"id": refund_id})
    if not refund:
        raise HTTPException(status_code=404, detail="Refund not found")
    
    await db.refunds.delete_one({"id": refund_id})
    
    await log_audit(
        action="PERMANENT_DELETE",
        entity_type="refund",
        user=current_user,
        entity_id=refund_id,
        entity_name=refund.get("refund_no"),
        details=f"Refund {refund.get('refund_no')} permanently deleted"
    )
    
    return {"message": "Refund permanently deleted"}


class RefundEmailRequest(BaseModel):
    email: str


@router.post("/{refund_id}/send-email")
async def send_refund_email(refund_id: str, request: RefundEmailRequest, current_user: dict = Depends(get_current_user)):
    """Send refund document via email"""
    user_permissions = current_user.get("permissions", [])
    has_access = is_admin_user(current_user) or "epos" in user_permissions
    if not has_access:
        raise HTTPException(status_code=403, detail="Access denied")
    
    db = get_db()
    refund = await db.refunds.find_one({"id": refund_id})
    if not refund:
        raise HTTPException(status_code=404, detail="Refund not found")
    
    # Import email service
    from services.email import send_refund_email as send_email
    
    try:
        await send_email(refund, request.email)
        return {"message": "Refund email sent successfully"}
    except Exception as e:
        logging.error(f"Failed to send refund email: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/summary/stats")
async def get_refund_stats(
    period: str = "month",
    showroom_id: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    """Get refund statistics for analytics"""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    
    from datetime import timedelta
    now = datetime.now(timezone.utc)
    
    if period == "today":
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    elif period == "week":
        start = now - timedelta(days=7)
    elif period == "month":
        start = now - timedelta(days=30)
    elif period == "year":
        start = now - timedelta(days=365)
    else:
        start = now - timedelta(days=30)
    
    # Exclude soft-deleted refunds
    query = {
        "created_at": {"$gte": start.isoformat()},
        "deleted_at": {"$exists": False}
    }
    
    user_showroom_id = current_user.get("showroom_id")
    if current_user.get("role") != "super_admin" and user_showroom_id:
        query["showroom_id"] = user_showroom_id
    elif showroom_id:
        query["showroom_id"] = showroom_id
    
    refunds = await db.refunds.find(query, {"_id": 0}).to_list(100000)
    
    total_refunds = len(refunds)
    total_gross = sum(r.get("gross_total", 0) for r in refunds)
    total_net = sum(r.get("net_refund", 0) for r in refunds)
    total_restocking_fees = sum(r.get("restocking_fee", 0) for r in refunds)
    
    # Group by showroom
    by_showroom = {}
    for r in refunds:
        sid = r.get("showroom_id", "unassigned")
        sname = r.get("showroom_name", "Unassigned")
        if sid not in by_showroom:
            by_showroom[sid] = {"name": sname, "count": 0, "gross": 0, "net": 0, "fees": 0}
        by_showroom[sid]["count"] += 1
        by_showroom[sid]["gross"] += r.get("gross_total", 0)
        by_showroom[sid]["net"] += r.get("net_refund", 0)
        by_showroom[sid]["fees"] += r.get("restocking_fee", 0)
    
    return {
        "period": period,
        "total_refunds": total_refunds,
        "total_gross_refunds": round(total_gross, 2),
        "total_net_refunds": round(total_net, 2),
        "total_restocking_fees": round(total_restocking_fees, 2),
        "by_showroom": [{"showroom_id": k, **v} for k, v in by_showroom.items()]
    }

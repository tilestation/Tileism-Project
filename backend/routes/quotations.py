"""
Quotation management routes
"""
import uuid
import io
import os
import base64
import logging
from datetime import datetime, timezone
from typing import Optional, List
from fastapi import APIRouter, HTTPException, Depends, Body
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from config import get_db
from services import get_current_user, is_admin_user, log_audit

# Check for reportlab availability
try:
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.enums import TA_CENTER, TA_RIGHT, TA_LEFT
    from reportlab.lib import colors
    from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
    REPORTLAB_AVAILABLE = True
except ImportError:
    REPORTLAB_AVAILABLE = False
    logging.warning("reportlab not available - PDF generation disabled")

# Check for resend availability
try:
    import resend
    RESEND_AVAILABLE = True
except ImportError:
    RESEND_AVAILABLE = False
    logging.warning("resend not available - Email sending disabled")

router = APIRouter(prefix="/quotations", tags=["Quotations"])


class QuotationLineItem(BaseModel):
    product_id: Optional[str] = None
    product_name: str
    sku: Optional[str] = None
    quantity: float
    m2: Optional[float] = 0
    price: float
    due_price: Optional[float] = None
    total: Optional[float] = None
    discount: float = 0


class CompanyInfo(BaseModel):
    name: str
    address: str
    city: str
    telephone: str
    email: str
    companyNo: str
    vatNo: str


class QuotationCreate(BaseModel):
    quotation_no: str
    date: str
    time: str
    showroom_id: Optional[str] = None
    customer_name: Optional[str] = None
    customer_phone: Optional[str] = None
    customer_email: Optional[str] = None
    customer_address: Optional[str] = None
    sales_person: Optional[str] = None
    validity_days: int = 30
    notes: Optional[str] = None
    line_items: List[QuotationLineItem]
    subtotal: Optional[float] = 0
    vat: Optional[float] = 0
    gross_total: Optional[float] = 0
    total_savings: Optional[float] = 0
    company_info: Optional[CompanyInfo] = None


class QuotationUpdate(BaseModel):
    quotation_no: Optional[str] = None
    date: Optional[str] = None
    time: Optional[str] = None
    showroom_id: Optional[str] = None
    customer_name: Optional[str] = None
    customer_phone: Optional[str] = None
    customer_email: Optional[str] = None
    customer_address: Optional[str] = None
    sales_person: Optional[str] = None
    validity_days: Optional[int] = None
    notes: Optional[str] = None
    line_items: Optional[List[QuotationLineItem]] = None
    subtotal: Optional[float] = None
    vat: Optional[float] = None
    gross_total: Optional[float] = None
    total_savings: Optional[float] = None
    company_info: Optional[CompanyInfo] = None
    status: Optional[str] = None


@router.get("")
async def get_quotations(
    status: Optional[str] = None,
    showroom_id: Optional[str] = None,
    include_deleted: bool = False,
    current_user: dict = Depends(get_current_user)
):
    """Get all quotations with optional filters"""
    user_permissions = current_user.get("permissions", [])
    has_access = is_admin_user(current_user) or "epos" in user_permissions
    if not has_access:
        raise HTTPException(status_code=403, detail="Access denied")
    
    db = get_db()
    query = {}
    
    # Exclude deleted documents unless specifically requested (super_admin only)
    if include_deleted and current_user.get("role") == "super_admin":
        query["deleted_at"] = {"$exists": True}
    else:
        query["deleted_at"] = {"$exists": False}
    
    if status:
        query["status"] = status
    
    # Filter by showroom for non-super-admin users with assigned showroom
    user_showroom_id = current_user.get("showroom_id")
    is_super_admin = current_user.get("role") == "super_admin"
    
    if not is_super_admin and user_showroom_id:
        # Staff/Manager/Admin with assigned showroom can only see their showroom's quotations
        query["showroom_id"] = user_showroom_id
    elif showroom_id:
        # Super admin can filter by any showroom
        query["showroom_id"] = showroom_id
    
    quotations = await db.quotations.find(query, {"_id": 0}).sort("created_at", -1).to_list(5000)
    return quotations


@router.get("/audit/orphans")
async def get_orphan_converted_quotations(current_user: dict = Depends(get_current_user)):
    """Return quotations marked 'converted' but missing a linked invoice.
    
    These are the dangerous orphans where a user clicked Convert but the invoice
    was never actually saved — so the quote hides from the active list but sales
    numbers don't update. The Quotation History audit banner calls this endpoint.
    
    Detection logic:
      1. Quotation must have status == "converted" and not be soft-deleted.
      2. For each, check if an invoice exists that links back via:
         - `converted_to_invoice_id` stored on the quote, OR
         - an invoice whose `notes` contain the quote number (fallback for pre-fix data).
    """
    user_permissions = current_user.get("permissions", [])
    has_access = is_admin_user(current_user) or "epos" in user_permissions
    if not has_access:
        raise HTTPException(status_code=403, detail="Access denied")
    
    db = get_db()
    
    converted = await db.quotations.find(
        {"status": "converted", "deleted_at": {"$exists": False}},
        {"_id": 0, "id": 1, "quotation_no": 1, "customer_name": 1, "total": 1,
         "converted_at": 1, "converted_to_invoice_id": 1, "sales_person": 1,
         "showroom_id": 1, "showroom_name": 1}
    ).sort("converted_at", -1).to_list(5000)
    
    orphans = []
    for q in converted:
        linked_id = q.get("converted_to_invoice_id")
        if linked_id:
            exists = await db.invoices.find_one({"id": linked_id}, {"_id": 0, "id": 1})
            if exists:
                continue
        # Fallback: look for an invoice whose notes mention this quote number
        qn = q.get("quotation_no")
        if qn:
            import re as _re
            pattern = _re.escape(qn)
            inv = await db.invoices.find_one(
                {"notes": {"$regex": pattern, "$options": "i"}},
                {"_id": 0, "id": 1}
            )
            if inv:
                continue
        orphans.append({
            "id": q.get("id"),
            "quotation_no": q.get("quotation_no"),
            "customer_name": q.get("customer_name"),
            "total": q.get("total"),
            "converted_at": q.get("converted_at"),
            "sales_person": q.get("sales_person"),
            "showroom_name": q.get("showroom_name"),
        })
    
    return {"count": len(orphans), "orphans": orphans}


@router.get("/{quotation_id}")
async def get_quotation(quotation_id: str, current_user: dict = Depends(get_current_user)):
    """Get a single quotation by ID"""
    user_permissions = current_user.get("permissions", [])
    has_access = is_admin_user(current_user) or "epos" in user_permissions
    if not has_access:
        raise HTTPException(status_code=403, detail="Access denied")
    
    db = get_db()
    quotation = await db.quotations.find_one({"id": quotation_id}, {"_id": 0})
    
    if not quotation:
        raise HTTPException(status_code=404, detail="Quotation not found")
    
    return quotation


@router.post("")
async def create_quotation(input: QuotationCreate, current_user: dict = Depends(get_current_user)):
    """Create a new quotation"""
    user_permissions = current_user.get("permissions", [])
    has_access = is_admin_user(current_user) or "epos" in user_permissions
    if not has_access:
        raise HTTPException(status_code=403, detail="Access denied")
    
    db = get_db()
    
    # Check for duplicate quotation number
    existing_quotation = await db.quotations.find_one({"quotation_no": input.quotation_no}, {"_id": 0, "id": 1})
    if existing_quotation:
        raise HTTPException(status_code=400, detail=f"Quotation {input.quotation_no} already exists. Cannot save duplicate.")
    
    quotation_id = str(uuid.uuid4())
    
    # Calculate expiry date
    from datetime import timedelta
    try:
        date_parts = input.date.split('/')
        if len(date_parts) == 3:
            quotation_date = datetime(int(date_parts[2]), int(date_parts[1]), int(date_parts[0]))
        else:
            quotation_date = datetime.now(timezone.utc)
    except (ValueError, IndexError):
        quotation_date = datetime.now(timezone.utc)
    
    expiry_date = quotation_date + timedelta(days=input.validity_days)

    # Stamp attribution fields (4 Jun 2026) so downstream reports stay
    # correct after a staff transfer between showrooms.
    from services.staff_attribution import resolve_staff_attribution
    attribution = await resolve_staff_attribution(
        current_user,
        input_showroom_id=input.showroom_id,
        input_showroom_name=None,
    )

    quotation_dict = {
        "id": quotation_id,
        "quotation_no": input.quotation_no,
        "date": input.date,
        "time": input.time,
        "showroom_id": attribution["showroom_id"] or input.showroom_id,
        "showroom_name": attribution["showroom_name"],
        "customer_name": input.customer_name,
        "customer_phone": input.customer_phone,
        "customer_email": input.customer_email,
        "customer_address": input.customer_address,
        "sales_person": input.sales_person,
        "validity_days": input.validity_days,
        "expiry_date": expiry_date.isoformat(),
        "notes": input.notes,
        "line_items": [item.model_dump() for item in input.line_items],
        "subtotal": input.subtotal or 0,
        "vat": input.vat or 0,
        "gross_total": input.gross_total or 0,
        "total_savings": input.total_savings or 0,
        "company_info": input.company_info.model_dump() if input.company_info else None,
        "status": "active",
        "created_by": current_user.get("email"),
        "created_by_user_id": attribution["created_by_user_id"],
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat()
    }
    
    await db.quotations.insert_one(quotation_dict)
    
    # Audit log
    await log_audit(
        action="CREATE",
        entity_type="quotation",
        user=current_user,
        entity_id=quotation_id,
        entity_name=input.quotation_no,
        after_data={"quotation_no": input.quotation_no, "customer": input.customer_name, "total": input.gross_total},
        details=f"Quotation created: {input.quotation_no}"
    )
    
    return {
        "message": "Quotation saved successfully",
        "quotation_id": quotation_id,
        "quotation_no": input.quotation_no
    }


@router.put("/{quotation_id}")
async def update_quotation(
    quotation_id: str,
    input: QuotationUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Update an existing quotation"""
    user_permissions = current_user.get("permissions", [])
    has_access = is_admin_user(current_user) or "epos" in user_permissions
    if not has_access:
        raise HTTPException(status_code=403, detail="Access denied")
    
    db = get_db()
    
    # Check quotation exists
    existing = await db.quotations.find_one({"id": quotation_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Quotation not found")
    
    # Build update dict
    update_dict = {"updated_at": datetime.now(timezone.utc).isoformat()}
    
    if input.quotation_no is not None:
        update_dict["quotation_no"] = input.quotation_no
    if input.date is not None:
        update_dict["date"] = input.date
    if input.time is not None:
        update_dict["time"] = input.time
    if input.showroom_id is not None:
        update_dict["showroom_id"] = input.showroom_id
    if input.customer_name is not None:
        update_dict["customer_name"] = input.customer_name
    if input.customer_phone is not None:
        update_dict["customer_phone"] = input.customer_phone
    if input.customer_email is not None:
        update_dict["customer_email"] = input.customer_email
    if input.customer_address is not None:
        update_dict["customer_address"] = input.customer_address
    if input.sales_person is not None:
        update_dict["sales_person"] = input.sales_person
    if input.validity_days is not None:
        update_dict["validity_days"] = input.validity_days
    if input.notes is not None:
        update_dict["notes"] = input.notes
    if input.line_items is not None:
        update_dict["line_items"] = [item.model_dump() for item in input.line_items]
    if input.subtotal is not None:
        update_dict["subtotal"] = input.subtotal
    if input.vat is not None:
        update_dict["vat"] = input.vat
    if input.gross_total is not None:
        update_dict["gross_total"] = input.gross_total
    if input.total_savings is not None:
        update_dict["total_savings"] = input.total_savings
    if input.company_info is not None:
        update_dict["company_info"] = input.company_info.model_dump()
    if input.status is not None:
        update_dict["status"] = input.status
    
    await db.quotations.update_one({"id": quotation_id}, {"$set": update_dict})
    
    # Audit log
    await log_audit(
        action="UPDATE",
        entity_type="quotation",
        user=current_user,
        entity_id=quotation_id,
        entity_name=existing.get("quotation_no"),
        after_data=update_dict,
        details=f"Quotation updated: {existing.get('quotation_no')}"
    )
    
    return {"message": "Quotation updated successfully"}


@router.delete("/{quotation_id}")
async def delete_quotation(quotation_id: str, current_user: dict = Depends(get_current_user)):
    """Soft delete a quotation (Super Admin only) - moves to trash"""
    # Only Super Admin can delete documents
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Only Super Admin can delete documents")
    
    db = get_db()
    
    existing = await db.quotations.find_one({"id": quotation_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Quotation not found")
    
    # Check if already deleted
    if existing.get("deleted_at"):
        raise HTTPException(status_code=400, detail="Quotation is already in trash")
    
    # Soft delete
    deleted_at = datetime.now(timezone.utc)
    await db.quotations.update_one(
        {"id": quotation_id},
        {"$set": {
            "deleted_at": deleted_at.isoformat(),
            "deleted_by": current_user.get("email"),
            "deleted_by_name": current_user.get("name", current_user.get("email"))
        }}
    )
    
    # Audit log
    await log_audit(
        action="SOFT_DELETE",
        entity_type="quotation",
        user=current_user,
        entity_id=quotation_id,
        entity_name=existing.get("quotation_no"),
        details=f"Quotation {existing.get('quotation_no')} moved to trash."
    )
    
    return {"message": "Quotation moved to trash. You can restore it or permanently delete it from the Trash page."}


@router.post("/{quotation_id}/restore")
async def restore_quotation(quotation_id: str, current_user: dict = Depends(get_current_user)):
    """Restore a soft-deleted quotation from trash (Super Admin only)"""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Only Super Admin can restore documents")
    
    db = get_db()
    quotation = await db.quotations.find_one({"id": quotation_id})
    if not quotation:
        raise HTTPException(status_code=404, detail="Quotation not found")
    
    if not quotation.get("deleted_at"):
        raise HTTPException(status_code=400, detail="Quotation is not in trash")
    
    await db.quotations.update_one(
        {"id": quotation_id},
        {"$unset": {"deleted_at": "", "deleted_by": "", "deleted_by_name": ""}}
    )
    
    await log_audit(
        action="RESTORE",
        entity_type="quotation",
        user=current_user,
        entity_id=quotation_id,
        entity_name=quotation.get("quotation_no"),
        details=f"Quotation {quotation.get('quotation_no')} restored from trash."
    )
    
    return {"message": "Quotation restored successfully"}


@router.delete("/{quotation_id}/permanent")
async def permanent_delete_quotation(quotation_id: str, current_user: dict = Depends(get_current_user)):
    """Permanently delete a quotation (Super Admin only)"""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Only Super Admin can permanently delete documents")
    
    db = get_db()
    quotation = await db.quotations.find_one({"id": quotation_id})
    if not quotation:
        raise HTTPException(status_code=404, detail="Quotation not found")
    
    await db.quotations.delete_one({"id": quotation_id})
    
    await log_audit(
        action="PERMANENT_DELETE",
        entity_type="quotation",
        user=current_user,
        entity_id=quotation_id,
        entity_name=quotation.get("quotation_no"),
        details=f"Quotation {quotation.get('quotation_no')} permanently deleted"
    )
    
    return {"message": "Quotation permanently deleted"}


@router.post("/{quotation_id}/convert-to-invoice")
async def convert_to_invoice(quotation_id: str, body: Optional[dict] = Body(None), current_user: dict = Depends(get_current_user)):
    """Mark quotation as converted.

    Optional body: {"invoice_id": "<new invoice id>"}  — when provided, stores the
    linked invoice id on the quotation. This is what the Quotation History audit
    banner uses to detect orphan "converted" quotes with no matching invoice.
    """
    user_permissions = current_user.get("permissions", [])
    has_access = is_admin_user(current_user) or "epos" in user_permissions
    if not has_access:
        raise HTTPException(status_code=403, detail="Access denied")
    
    db = get_db()
    
    existing = await db.quotations.find_one({"id": quotation_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Quotation not found")
    
    if existing.get("status") == "converted":
        raise HTTPException(status_code=400, detail="This quotation has already been converted")
    
    update_fields = {
        "status": "converted",
        "converted_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat()
    }
    invoice_id = (body or {}).get("invoice_id") if body else None
    if invoice_id:
        update_fields["converted_to_invoice_id"] = invoice_id
    
    # Mark quotation as converted
    await db.quotations.update_one(
        {"id": quotation_id},
        {"$set": update_fields}
    )
    
    return {"message": "Quotation marked as converted", "quotation": existing}


@router.post("/{quotation_id}/revert-to-active")
async def revert_to_active(quotation_id: str, current_user: dict = Depends(get_current_user)):
    """Revert a converted quotation back to active - Super Admin only"""
    # Only Super Admins can revert
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Only Super Admins can revert quotations")
    
    db = get_db()
    
    existing = await db.quotations.find_one({"id": quotation_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Quotation not found")
    
    if existing.get("status") != "converted":
        raise HTTPException(status_code=400, detail="Only converted quotations can be reverted")
    
    # Revert quotation back to active
    now = datetime.now(timezone.utc)
    await db.quotations.update_one(
        {"id": quotation_id},
        {"$set": {
            "status": "active",
            "reverted_at": now.isoformat(),
            "reverted_by": current_user.get("email"),
            "updated_at": now.isoformat()
        },
        "$unset": {
            "converted_at": ""
        }}
    )
    
    # Log audit
    await log_audit(
        action="REVERT_QUOTATION",
        entity_type="quotation",
        user=current_user,
        entity_id=quotation_id,
        entity_name=existing.get("quotation_no"),
        details=f"Quotation {existing.get('quotation_no')} reverted from converted to active"
    )
    
    return {"message": "Quotation reverted to active", "quotation_no": existing.get("quotation_no")}


# ----------------------------------------------------------------------
# Manual invoice-linking for orphaned converted quotes (4 Jun 2026).
#
# User reported a banner showing 17 quotes marked Converted but missing
# a linked invoice — the only previous action was Revert. That's wrong
# when the invoice DOES exist but was saved under a different number;
# reverting would re-prompt the staff to re-create the invoice they
# already saved, double-counting revenue.
#
# These endpoints let a super-admin search invoices and link the right
# one to the orphaned quote, which:
#   • clears the orphan flag (the audit query checks
#     `converted_to_invoice_id` first)
#   • makes the leaderboard sales totals reflect the right staff
#   • makes the quote → invoice trail navigable in the UI
# ----------------------------------------------------------------------
@router.get("/audit/search-invoices")
async def search_invoices_for_linking(
    q: str = "",
    limit: int = 30,
    current_user: dict = Depends(get_current_user),
):
    """Type-ahead search returning invoices that could be linked to an
    orphan quote. Matches by invoice_no (prefix or substring) OR by
    customer_name (substring, case-insensitive). Excludes invoices
    that are ALREADY linked to a quote (so the admin can't double-link
    the same invoice)."""
    user_permissions = current_user.get("permissions", [])
    has_access = is_admin_user(current_user) or "epos" in user_permissions
    if not has_access:
        raise HTTPException(status_code=403, detail="Access denied")

    db = get_db()
    needle = (q or "").strip()
    if not needle or len(needle) < 2:
        return {"invoices": []}

    import re as _re
    pattern = _re.escape(needle)
    # Pull the already-linked invoice ids so we can filter them out.
    linked_ids = set()
    async for ql in db.quotations.find(
        {"converted_to_invoice_id": {"$exists": True, "$ne": None}},
        {"_id": 0, "converted_to_invoice_id": 1},
    ):
        v = ql.get("converted_to_invoice_id")
        if v:
            linked_ids.add(v)

    rows = await db.invoices.find(
        {"$or": [
            {"invoice_no": {"$regex": pattern, "$options": "i"}},
            {"customer_name": {"$regex": pattern, "$options": "i"}},
        ]},
        {"_id": 0, "id": 1, "invoice_no": 1, "customer_name": 1,
         "grand_total": 1, "total_amount": 1, "total": 1, "date": 1,
         "sales_person": 1, "showroom_name": 1, "created_at": 1},
    ).sort("created_at", -1).limit(int(limit) * 2).to_list(length=int(limit) * 2)

    out = []
    for r in rows:
        if r.get("id") in linked_ids:
            continue
        out.append({
            "id": r.get("id"),
            "invoice_no": r.get("invoice_no"),
            "customer_name": r.get("customer_name"),
            "total": r.get("grand_total") or r.get("total_amount") or r.get("total") or 0,
            "date": r.get("date") or r.get("created_at"),
            "sales_person": r.get("sales_person"),
            "showroom_name": r.get("showroom_name"),
        })
        if len(out) >= int(limit):
            break
    return {"invoices": out}


@router.post("/{quotation_id}/link-invoice")
async def link_invoice_to_quotation(
    quotation_id: str,
    body: dict = Body(...),
    current_user: dict = Depends(get_current_user),
):
    """Manually link an EXISTING invoice to a converted quotation that
    is missing its `converted_to_invoice_id`. Admin only (super_admin
    / admin / manager). The link is reversible by calling
    /revert-to-active on the quote.

    Body: `{ "invoice_id": "<uuid>" }`."""
    if (current_user or {}).get("role") not in {"super_admin", "admin", "manager"}:
        raise HTTPException(status_code=403, detail="Admin role required to link invoices.")

    invoice_id = (body or {}).get("invoice_id")
    if not invoice_id:
        raise HTTPException(status_code=400, detail="invoice_id is required")

    db = get_db()
    quote = await db.quotations.find_one({"id": quotation_id}, {"_id": 0})
    if not quote:
        raise HTTPException(status_code=404, detail="Quotation not found")

    invoice = await db.invoices.find_one(
        {"id": invoice_id},
        {"_id": 0, "id": 1, "invoice_no": 1, "customer_name": 1},
    )
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")

    # Reject if this invoice is already linked to a DIFFERENT quote — a
    # safe guard so the admin doesn't accidentally cross-wire two quotes
    # to the same invoice and inflate sales totals.
    other = await db.quotations.find_one(
        {"converted_to_invoice_id": invoice_id, "id": {"$ne": quotation_id}},
        {"_id": 0, "quotation_no": 1, "id": 1},
    )
    if other:
        raise HTTPException(
            status_code=400,
            detail=f"Invoice {invoice.get('invoice_no')} is already linked to quotation {other.get('quotation_no')}.",
        )

    now = datetime.now(timezone.utc)
    # Flip to converted if the quote wasn't already (handles the case
    # where an admin used this to retro-link a never-converted quote).
    update_fields = {
        "converted_to_invoice_id": invoice_id,
        "manually_linked_at": now.isoformat(),
        "manually_linked_by": current_user.get("email"),
        "updated_at": now.isoformat(),
    }
    if quote.get("status") != "converted":
        update_fields["status"] = "converted"
        update_fields["converted_at"] = now.isoformat()

    await db.quotations.update_one({"id": quotation_id}, {"$set": update_fields})

    await log_audit(
        action="LINK_INVOICE",
        entity_type="quotation",
        user=current_user,
        entity_id=quotation_id,
        entity_name=quote.get("quotation_no"),
        details=f"Quotation {quote.get('quotation_no')} manually linked to invoice {invoice.get('invoice_no')}",
    )

    return {
        "message": "Invoice linked to quotation",
        "quotation_no": quote.get("quotation_no"),
        "invoice_no": invoice.get("invoice_no"),
        "invoice_id": invoice_id,
    }



# ============ PDF GENERATION ============

async def generate_quotation_pdf_bytes(quotation: dict) -> bytes:
    """Generate PDF bytes for a quotation"""
    if not REPORTLAB_AVAILABLE:
        raise HTTPException(status_code=500, detail="PDF generation not available")
    
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4, topMargin=15*mm, bottomMargin=15*mm, leftMargin=15*mm, rightMargin=15*mm)
    
    elements = []
    styles = getSampleStyleSheet()
    
    # Custom styles
    title_style = ParagraphStyle('Title', parent=styles['Heading1'], fontSize=24, alignment=TA_CENTER, spaceAfter=5*mm)
    subtitle_style = ParagraphStyle('Subtitle', parent=styles['Normal'], fontSize=10, alignment=TA_CENTER, textColor=colors.grey)
    
    # Get company info - handle None case
    company_info = quotation.get("company_info") or {}
    company_address = company_info.get("address", "Unit 3 Trade City Coldharbour Road")
    company_city = company_info.get("city", "Northfleet Gravesend DA11 8AB")
    company_phone = company_info.get("telephone", "01474 878 989")
    company_email = company_info.get("email", "info@tilestation.co.uk")
    company_no = company_info.get("companyNo", "11982550")
    vat_no = company_info.get("vatNo", "324 251 828")
    
    # Company Header
    elements.append(Paragraph("TILE STATION", title_style))
    elements.append(Paragraph(f"{company_address}, {company_city}", subtitle_style))
    elements.append(Paragraph(f"Tel: {company_phone} | Email: {company_email}", subtitle_style))
    elements.append(Paragraph(f"Company No: {company_no} | VAT No: {vat_no}", subtitle_style))
    elements.append(Spacer(1, 10*mm))
    
    # Quotation Title with styling - black and white
    quote_title_style = ParagraphStyle('QuoteTitle', fontSize=18, alignment=TA_CENTER, spaceAfter=5*mm, textColor=colors.black)
    elements.append(Paragraph("<b>QUOTATION</b>", quote_title_style))
    elements.append(Spacer(1, 5*mm))
    
    # Validity notice - black and white
    validity_days = quotation.get("validity_days", 30)
    validity_style = ParagraphStyle('Validity', fontSize=10, alignment=TA_CENTER, textColor=colors.black, backColor=colors.HexColor('#f0f0f0'))
    elements.append(Paragraph(f"This quotation is valid for {validity_days} days from the date below", validity_style))
    elements.append(Spacer(1, 5*mm))
    
    # Quotation Details & Customer Details side by side
    quotation_info = [
        ["Quotation No:", quotation.get("quotation_no", "N/A")],
        ["Date:", quotation.get("date", "N/A")],
        ["Time:", quotation.get("time", "N/A")],
        ["Valid For:", f"{validity_days} days"],
        ["Sales Person:", quotation.get("sales_person") or "N/A"],
    ]
    
    customer_info = [
        ["Customer:", quotation.get("customer_name") or "N/A"],
        ["Phone:", quotation.get("customer_phone") or "N/A"],
        ["Email:", quotation.get("customer_email") or "N/A"],
        ["Address:", quotation.get("customer_address") or "N/A"],
    ]
    
    # Create two column layout for details
    left_table = Table(quotation_info, colWidths=[35*mm, 50*mm])
    left_table.setStyle(TableStyle([
        ('FONTSIZE', (0, 0), (-1, -1), 9),
        ('FONTNAME', (0, 0), (0, -1), 'Helvetica-Bold'),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
    ]))
    
    right_table = Table(customer_info, colWidths=[30*mm, 55*mm])
    right_table.setStyle(TableStyle([
        ('FONTSIZE', (0, 0), (-1, -1), 9),
        ('FONTNAME', (0, 0), (0, -1), 'Helvetica-Bold'),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
    ]))
    
    details_table = Table([[left_table, right_table]], colWidths=[90*mm, 90*mm])
    elements.append(details_table)
    elements.append(Spacer(1, 8*mm))
    
    # Line Items Table
    line_items = quotation.get("line_items", [])
    table_data = [["Qty", "m²", "Product", "List Price", "Quote Price", "Discount", "Total"]]
    
    # Style for product names to allow wrapping
    product_style = ParagraphStyle('ProductName', fontSize=9, leading=11)
    
    for item in line_items:
        qty = item.get("quantity", 0)
        m2 = item.get("m2", 0)
        price = item.get("price", 0)
        due_price = item.get("due_price", price)
        total = item.get("total", qty * due_price)
        
        # Calculate discount percentage
        discount_pct = 0
        if price > 0 and due_price < price:
            discount_pct = ((price - due_price) / price) * 100
        
        # Wrap product name in Paragraph for proper text wrapping
        product_name = item.get("product_name", "N/A")
        product_para = Paragraph(product_name, product_style)
        
        table_data.append([
            str(int(qty)) if qty == int(qty) else str(qty),
            f"{m2:.2f}" if m2 else "-",
            product_para,  # Use Paragraph instead of plain string
            f"£{price:.2f}",
            f"£{due_price:.2f}",
            f"{discount_pct:.1f}%" if discount_pct > 0 else "-",
            f"£{total:.2f}"
        ])
    
    # Add totals rows
    subtotal = quotation.get("subtotal", 0)
    vat = quotation.get("vat", 0)
    gross_total = quotation.get("gross_total", 0)
    total_savings = quotation.get("total_savings", 0)
    
    table_data.append(["", "", "", "", "", "Subtotal:", f"£{subtotal:.2f}"])
    if total_savings > 0:
        table_data.append(["", "", "", "", "", "Savings:", f"£{total_savings:.2f}"])
    table_data.append(["", "", "", "", "", "VAT (20%):", f"£{vat:.2f}"])
    table_data.append(["", "", "", "", "", "TOTAL:", f"£{gross_total:.2f}"])
    
    items_table = Table(table_data, colWidths=[12*mm, 12*mm, 70*mm, 20*mm, 20*mm, 18*mm, 24*mm])
    items_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.black),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTSIZE', (0, 0), (-1, -1), 9),
        ('ALIGN', (0, 0), (1, -1), 'CENTER'),
        ('ALIGN', (3, 0), (-1, -1), 'RIGHT'),
        ('GRID', (0, 0), (-1, len(line_items)), 0.5, colors.grey),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
        ('TOPPADDING', (0, 0), (-1, -1), 5),
        # Totals styling - black and white
        ('FONTNAME', (5, len(line_items)+1), (5, -1), 'Helvetica-Bold'),
        ('FONTNAME', (6, -1), (6, -1), 'Helvetica-Bold'),
        ('LINEABOVE', (5, len(line_items)+1), (-1, len(line_items)+1), 1, colors.black),
        ('BACKGROUND', (5, -1), (-1, -1), colors.HexColor('#f0f0f0')),
    ]))
    elements.append(items_table)
    elements.append(Spacer(1, 8*mm))
    
    # Tagline
    tagline_style = ParagraphStyle('Tagline', fontSize=11, alignment=TA_CENTER, spaceAfter=5*mm)
    elements.append(Paragraph("<b>Amazing Tiles - Beautiful Bathrooms - Excellent Service</b>", tagline_style))
    elements.append(Spacer(1, 5*mm))
    
    # Quotation Notes
    notes = quotation.get("notes", "")
    if notes:
        elements.append(Paragraph("<b>Notes:</b>", ParagraphStyle('Notes', fontSize=9, spaceAfter=2*mm)))
        elements.append(Paragraph(notes, ParagraphStyle('NotesText', fontSize=8, textColor=colors.grey, leading=10)))
        elements.append(Spacer(1, 3*mm))
    
    # Standard quotation terms
    elements.append(Paragraph("<b>Quotation Terms:</b>", ParagraphStyle('Terms', fontSize=9, spaceAfter=2*mm)))
    terms = """• Prices include VAT at 20% • This quotation is subject to stock availability • Prices may vary based on current market conditions • Delivery charges may apply • To proceed with your order, please contact us or visit one of our stores"""
    elements.append(Paragraph(terms, ParagraphStyle('TermsText', fontSize=7, textColor=colors.grey, leading=9)))
    
    # Build PDF
    doc.build(elements)
    buffer.seek(0)
    
    return buffer.getvalue()


@router.get("/{quotation_id}/pdf")
async def generate_quotation_pdf(quotation_id: str, current_user: dict = Depends(get_current_user)):
    """Generate PDF for a quotation"""
    user_permissions = current_user.get("permissions", [])
    has_access = is_admin_user(current_user) or "epos" in user_permissions
    if not has_access:
        raise HTTPException(status_code=403, detail="Access denied")
    
    if not REPORTLAB_AVAILABLE:
        raise HTTPException(status_code=500, detail="PDF generation not available")
    
    db = get_db()
    quotation = await db.quotations.find_one({"id": quotation_id}, {"_id": 0})
    if not quotation:
        raise HTTPException(status_code=404, detail="Quotation not found")
    
    # Generate PDF bytes
    pdf_bytes = await generate_quotation_pdf_bytes(quotation)
    
    # Return PDF
    filename = f"Quotation_{quotation.get('quotation_no', 'unknown')}.pdf"
    return StreamingResponse(
        io.BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )


# ============ EMAIL QUOTATION ============

class QuotationEmailRequest(BaseModel):
    email: str
    subject: Optional[str] = None
    message: Optional[str] = None


@router.post("/{quotation_id}/email")
async def email_quotation_pdf(quotation_id: str, request: QuotationEmailRequest, current_user: dict = Depends(get_current_user)):
    """Send quotation PDF via email"""
    user_permissions = current_user.get("permissions", [])
    has_access = is_admin_user(current_user) or "epos" in user_permissions
    if not has_access:
        raise HTTPException(status_code=403, detail="Access denied")
    
    if not RESEND_AVAILABLE:
        raise HTTPException(status_code=500, detail="Email service not available")
    
    db = get_db()
    quotation = await db.quotations.find_one({"id": quotation_id}, {"_id": 0})
    if not quotation:
        raise HTTPException(status_code=404, detail="Quotation not found")
    
    # Generate PDF
    try:
        pdf_bytes = await generate_quotation_pdf_bytes(quotation)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate PDF: {str(e)}")
    
    # Get quotation details
    quotation_no = quotation.get("quotation_no", "N/A")
    customer_name = quotation.get("customer_name", "Customer")
    gross_total = quotation.get("gross_total", 0)
    validity_days = quotation.get("validity_days", 30)
    total_savings = quotation.get("total_savings", 0)
    
    # Get company info for email - handle None case
    company_info = quotation.get("company_info") or {}
    company_phone = company_info.get("telephone", "01474 878 989")
    company_email = company_info.get("email", "info@tilestation.co.uk")
    company_address = company_info.get("address", "Unit 3 Trade City")
    company_city = company_info.get("city", "Northfleet Gravesend DA11 8AB")
    
    custom_message = request.message or ""
    if custom_message:
        custom_message = f"<p style='margin-bottom: 20px; padding: 15px; background: #f0f9ff; border-left: 4px solid #2563eb; border-radius: 4px;'>{custom_message}</p>"
    
    savings_html = ""
    if total_savings > 0:
        savings_html = f"""
        <tr style="color: #059669;">
            <td style="padding: 8px 0;"><strong>You Save:</strong></td>
            <td style="text-align: right; font-weight: bold;">£{total_savings:.2f}</td>
        </tr>
        """
    
    html_content = f"""
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #1e40af; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0;">TILE STATION</h1>
            <p style="margin: 5px 0 0 0; font-size: 14px;">Amazing Tiles - Beautiful Bathrooms - Excellent Service</p>
        </div>
        
        <div style="padding: 30px; background: #f9f9f9;">
            {custom_message}
            <p>Dear {customer_name},</p>
            
            <p>Thank you for your interest in Tile Station! Please find attached your quotation <strong>#{quotation_no}</strong>.</p>
            
            <div style="background: #dbeafe; padding: 15px; border-radius: 8px; margin: 20px 0; text-align: center;">
                <p style="margin: 0; color: #1e40af; font-weight: bold;">
                    ⏰ This quotation is valid for {validity_days} days
                </p>
            </div>
            
            <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #e5e7eb;">
                <table style="width: 100%;">
                    <tr>
                        <td style="padding: 8px 0;"><strong>Quotation No:</strong></td>
                        <td style="text-align: right;">{quotation_no}</td>
                    </tr>
                    <tr>
                        <td style="padding: 8px 0;"><strong>Total Amount:</strong></td>
                        <td style="text-align: right; font-size: 18px; font-weight: bold; color: #1e40af;">£{gross_total:.2f}</td>
                    </tr>
                    {savings_html}
                </table>
            </div>
            
            <p>To proceed with your order or if you have any questions, please don't hesitate to contact us:</p>
            
            <ul style="padding-left: 20px;">
                <li>📞 Call us: {company_phone}</li>
                <li>📧 Email us: {company_email}</li>
                <li>🏪 Visit our store</li>
            </ul>
            
            <p>We look forward to helping you transform your space!</p>
            
            <p style="margin-top: 30px;">
                Best regards,<br>
                <strong>Tile Station Team</strong>
            </p>
        </div>
        
        <div style="background: #1e40af; color: #93c5fd; padding: 15px; text-align: center; font-size: 12px;">
            <p style="margin: 0;">{company_address}, {company_city}</p>
            <p style="margin: 5px 0 0 0;">Company No: 11982550 | VAT No: 324 251 828</p>
        </div>
    </div>
    """
    
    try:
        resend.api_key = os.environ.get("RESEND_API_KEY")
        
        email_subject = request.subject or f"Your Quotation #{quotation_no} from Tile Station"
        
        # Use showroom-specific email if available, otherwise default to gravesend
        from_email = company_email if company_email and "@tilestation.co.uk" in company_email else "gravesend@tilestation.co.uk"
        
        resend.Emails.send({
            "from": f"Tile Station <{from_email}>",
            "to": [request.email],
            "subject": email_subject,
            "html": html_content,
            "attachments": [
                {
                    "filename": f"Quotation_{quotation_no}.pdf",
                    "content": base64.b64encode(pdf_bytes).decode("utf-8")
                }
            ]
        })
        
        # Log the email send action
        await log_audit(
            action="EMAIL",
            entity_type="quotation",
            user=current_user,
            entity_id=quotation_id,
            entity_name=quotation_no,
            details=f"Quotation {quotation_no} emailed to {request.email}"
        )
        
        return {"message": "Quotation sent successfully", "email": request.email}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to send email: {str(e)}")
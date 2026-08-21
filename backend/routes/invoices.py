"""
Invoice management routes
"""
import uuid
import io
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional, List
from fastapi import APIRouter, HTTPException, Depends, Response
from pydantic import BaseModel

from config import get_db
from services import get_current_user, is_admin_user, has_permission, log_audit, send_order_confirmation_email, send_trade_credit_earned_email, RESEND_AVAILABLE

def can_access_epos(user: dict) -> bool:
    """Check if user can access EPOS (admin or has epos permission)"""
    if is_admin_user(user):
        return True
    return has_permission(user, "epos")


# ============ Trade Credit Reversal Helpers =================================
# Used whenever an invoice that previously affected a trade customer's credit
# ledger is undone — soft-delete, permanent delete, or admin restore. Both
# directions are idempotent via the `credits_reversed` flag stamped on the
# invoice doc, so a delete-then-permanent-delete sequence will NOT double-
# reverse. A subsequent `restore_invoice` re-applies (un-reverses).
#
# Behaviour:
#   • If the invoice ACCRUED `trade_credit_earned > 0` → subtract that from
#     the customer's balance and write a `reversed_earned_in_store` ledger row.
#   • If the invoice REDEEMED `credit_redeemed > 0` → add that BACK to the
#     customer's balance and write a `reversed_redeemed_in_store` ledger row.
#
# Direction:
#   reverse_invoice_credits(...) — undoes the credit movement (delete path)
#   reapply_invoice_credits(...) — re-applies the credit movement (restore)

async def reverse_invoice_credits(db, invoice: dict, *, reason: str = "invoice_deleted") -> dict:
    """Idempotently reverse any trade-credit movement caused by this invoice.
    Returns a small summary dict for the caller's audit log."""
    summary = {"earned_reversed": 0.0, "redeemed_reversed": 0.0, "total_spent_reversed": 0.0}
    if not invoice or invoice.get("credits_reversed"):
        return summary  # idempotent — already reversed

    invoice_id = invoice.get("id")
    invoice_no = invoice.get("invoice_no", "")
    now = datetime.now(timezone.utc).isoformat()

    earned = float(invoice.get("trade_credit_earned") or 0)
    earned_ref = (invoice.get("trade_account_number") or "").strip()
    if earned > 0 and earned_ref:
        cust = await db.shop_customers.find_one_and_update(
            {"trade_account_number": earned_ref},
            {"$inc": {"credit_balance": -earned}},
            return_document=False,  # BEFORE — for ledger balance_after calc
        )
        prior_balance = float((cust or {}).get("credit_balance") or 0)
        await db.credit_transactions.insert_one({
            "id": str(uuid.uuid4()),
            "customer_id": (cust or {}).get("id"),
            "trade_account_number": earned_ref,
            "type": "reversed_earned_in_store",
            "amount": -earned,
            "balance_after": round(prior_balance - earned, 2),
            "source": "epos_invoice",
            "invoice_id": invoice_id,
            "invoice_no": invoice_no,
            # Carry forward the showroom of the ORIGINAL transaction so
            # the credit history view shows the reversal at the same store.
            "channel": "in_store",
            "showroom_id": invoice.get("showroom_id"),
            "showroom_name": invoice.get("showroom_name"),
            "description": f"Reversed credit-back from invoice {invoice_no} ({reason})",
            "created_at": now,
        })
        summary["earned_reversed"] = earned

    redeemed = float(invoice.get("credit_redeemed") or 0)
    redeemed_ref = (invoice.get("credit_redeemed_account") or "").strip()
    if redeemed > 0 and redeemed_ref:
        cust = await db.shop_customers.find_one_and_update(
            {"trade_account_number": redeemed_ref},
            {"$inc": {"credit_balance": redeemed}},  # add back
            return_document=False,
        )
        prior_balance = float((cust or {}).get("credit_balance") or 0)
        await db.credit_transactions.insert_one({
            "id": str(uuid.uuid4()),
            "customer_id": (cust or {}).get("id"),
            "trade_account_number": redeemed_ref,
            "type": "reversed_redeemed_in_store",
            "amount": redeemed,  # positive = inflow back to balance
            "balance_after": round(prior_balance + redeemed, 2),
            "source": "epos_invoice",
            "invoice_id": invoice_id,
            "invoice_no": invoice_no,
            "channel": "in_store",
            "showroom_id": invoice.get("showroom_id"),
            "showroom_name": invoice.get("showroom_name"),
            "description": f"Refunded credit redemption from invoice {invoice_no} ({reason})",
            "created_at": now,
        })
        summary["redeemed_reversed"] = redeemed

    if summary["earned_reversed"] > 0 or summary["redeemed_reversed"] > 0:
        # Keep the trader's lifetime `total_spent` honest — deleted/cancelled
        # invoices should NOT count toward spend-based tier progression or
        # the "Total Spent" dashboard stat.
        gross = float(invoice.get("gross_total") or 0)
        if gross > 0 and earned_ref:
            await db.shop_customers.update_one(
                {"trade_account_number": earned_ref},
                {"$inc": {"total_spent": -gross}},
            )
            summary["total_spent_reversed"] = gross
        await db.invoices.update_one(
            {"id": invoice_id},
            {"$set": {
                "credits_reversed": True,
                "credits_reversed_at": now,
                "credits_reversed_reason": reason,
            }},
        )
        return summary

    # ---- Retail-only path -------------------------------------------------
    # Linked retail invoices have no trade credit movement, but their gross
    # was added to the customer's `total_spent` at create time. Reverse it
    # so a voided receipt doesn't inflate retail lifetime value.
    linked_id = (invoice.get("linked_shop_customer_id") or "").strip()
    if linked_id and not earned_ref:
        gross = float(invoice.get("gross_total") or 0)
        if gross > 0:
            linked_cust = await db.shop_customers.find_one(
                {"id": linked_id}, {"_id": 0, "id": 1, "is_trade": 1},
            )
            if linked_cust and not bool(linked_cust.get("is_trade")):
                await db.shop_customers.update_one(
                    {"id": linked_id},
                    {"$inc": {"total_spent": -gross}},
                )
                summary["total_spent_reversed"] = gross
                await db.invoices.update_one(
                    {"id": invoice_id},
                    {"$set": {
                        "credits_reversed": True,
                        "credits_reversed_at": now,
                        "credits_reversed_reason": reason,
                    }},
                )
    return summary


async def reapply_invoice_credits(db, invoice: dict, *, reason: str = "invoice_restored") -> dict:
    """Inverse of reverse_invoice_credits — re-applies the original credit
    movement when a soft-deleted invoice is restored. Idempotent via the
    same `credits_reversed` flag (only runs if currently reversed)."""
    summary = {"earned_reapplied": 0.0, "redeemed_reapplied": 0.0, "total_spent_reapplied": 0.0}
    if not invoice or not invoice.get("credits_reversed"):
        return summary  # nothing to re-apply

    invoice_id = invoice.get("id")
    invoice_no = invoice.get("invoice_no", "")
    now = datetime.now(timezone.utc).isoformat()

    earned = float(invoice.get("trade_credit_earned") or 0)
    earned_ref = (invoice.get("trade_account_number") or "").strip()
    if earned > 0 and earned_ref:
        cust = await db.shop_customers.find_one_and_update(
            {"trade_account_number": earned_ref},
            {"$inc": {"credit_balance": earned}},
            return_document=False,
        )
        prior_balance = float((cust or {}).get("credit_balance") or 0)
        await db.credit_transactions.insert_one({
            "id": str(uuid.uuid4()),
            "customer_id": (cust or {}).get("id"),
            "trade_account_number": earned_ref,
            "type": "reapplied_earned_in_store",
            "amount": earned,
            "balance_after": round(prior_balance + earned, 2),
            "source": "epos_invoice",
            "invoice_id": invoice_id,
            "invoice_no": invoice_no,
            "channel": "in_store",
            "showroom_id": invoice.get("showroom_id"),
            "showroom_name": invoice.get("showroom_name"),
            "description": f"Re-applied credit-back to invoice {invoice_no} ({reason})",
            "created_at": now,
        })
        summary["earned_reapplied"] = earned

    redeemed = float(invoice.get("credit_redeemed") or 0)
    redeemed_ref = (invoice.get("credit_redeemed_account") or "").strip()
    if redeemed > 0 and redeemed_ref:
        # Re-deduct (atomic, balance-safe). If customer doesn't have enough
        # balance any more, we DON'T abort the restore — we simply let the
        # balance go negative and log the discrepancy. Otherwise a customer
        # could spend their refunded credit and block the original invoice
        # from ever being restored. Negative balances are visible to admin.
        cust = await db.shop_customers.find_one_and_update(
            {"trade_account_number": redeemed_ref},
            {"$inc": {"credit_balance": -redeemed}},
            return_document=False,
        )
        prior_balance = float((cust or {}).get("credit_balance") or 0)
        await db.credit_transactions.insert_one({
            "id": str(uuid.uuid4()),
            "customer_id": (cust or {}).get("id"),
            "trade_account_number": redeemed_ref,
            "type": "reapplied_redeemed_in_store",
            "amount": -redeemed,
            "balance_after": round(prior_balance - redeemed, 2),
            "source": "epos_invoice",
            "invoice_id": invoice_id,
            "invoice_no": invoice_no,
            "channel": "in_store",
            "showroom_id": invoice.get("showroom_id"),
            "showroom_name": invoice.get("showroom_name"),
            "description": f"Re-applied credit redemption to invoice {invoice_no} ({reason})",
            "created_at": now,
        })
        summary["redeemed_reapplied"] = redeemed

    # Re-bump lifetime `total_spent` on restore so the trader's tier
    # progression and "Total Spent" stat stay consistent with the invoice
    # being live again.
    gross = float(invoice.get("gross_total") or 0)
    if gross > 0 and earned_ref:
        await db.shop_customers.update_one(
            {"trade_account_number": earned_ref},
            {"$inc": {"total_spent": gross}},
        )
        summary["total_spent_reapplied"] = gross
    else:
        # Retail-only restore — no trade ref, but a linked retail customer
        # had their total_spent decremented during reverse_invoice_credits.
        # Mirror the increment so the lifetime-spend figure is restored.
        linked_id = (invoice.get("linked_shop_customer_id") or "").strip()
        if linked_id and gross > 0:
            linked_cust = await db.shop_customers.find_one(
                {"id": linked_id}, {"_id": 0, "id": 1, "is_trade": 1},
            )
            if linked_cust and not bool(linked_cust.get("is_trade")):
                await db.shop_customers.update_one(
                    {"id": linked_id},
                    {"$inc": {"total_spent": gross}},
                )
                summary["total_spent_reapplied"] = gross

    await db.invoices.update_one(
        {"id": invoice_id},
        {"$unset": {
            "credits_reversed": "",
            "credits_reversed_at": "",
            "credits_reversed_reason": "",
        }},
    )
    return summary


# ============ Per-Product Credit-Back Rate Lookup =========================
# EPOS in-store credit accrual mirrors the online-shop logic: every line item
# earns credit at THAT product's `credit_back_rate` (set per-product on the
# tile / supplier_products doc). Falls back to the global business default
# (currently 2%) when neither catalogue carries a rate for that SKU.
#
# The same helper is used by:
#   • `save_invoice()` — to compute the actual £ to accrue at save time.
#   • `POST /credit-back-rates` — so the EPOS frontend's "will earn £X
#     credit" preview pill stays in lock-step with the backend math.
# Keeping ONE source of truth prevents drift between the preview shown to
# staff and the figure that ultimately lands in the customer's ledger.


def _trade_credit_back_default() -> float:
    """Global default credit-back % when a product has no specific rate."""
    try:
        from business_config import business_rules as br  # noqa: PLC0415
        return float(getattr(br, "TRADE_CREDIT_BACK_DEFAULT", 2) or 2)
    except Exception:  # noqa: BLE001
        return 2.0


async def _resolve_credit_back_rate(
    db,
    *,
    sku: Optional[str] = None,
    product_id: Optional[str] = None,
    default: Optional[float] = None,
) -> float:
    """Resolve the credit-back % for a single line item.

    Lookup priority (mirrors `tiles.py` per-product tier-pricing endpoint):
      1. `supplier_products` matched by SKU
      2. `tiles` matched by SKU
      3. `tiles` matched by `db.products.{id}` → tile via that product's SKU
      4. Global default (`TRADE_CREDIT_BACK_DEFAULT`, currently 2%)
    """
    fallback = float(default) if default is not None else _trade_credit_back_default()
    sku_clean = (sku or "").strip()

    # 1. supplier_products by SKU
    if sku_clean:
        sp = await db.supplier_products.find_one(
            {"sku": sku_clean},
            {"_id": 0, "credit_back_rate": 1},
        )
        if sp and sp.get("credit_back_rate") is not None:
            return float(sp["credit_back_rate"])

        # 2. tiles by SKU
        tile = await db.tiles.find_one(
            {"sku": sku_clean},
            {"_id": 0, "credit_back_rate": 1},
        )
        if tile and tile.get("credit_back_rate") is not None:
            return float(tile["credit_back_rate"])

    # 3. products → SKU → tiles (catches the case where the EPOS line carries
    #    only `product_id` and no SKU, e.g. quotation conversions)
    if product_id and not sku_clean:
        prod = await db.products.find_one(
            {"id": product_id},
            {"_id": 0, "sku": 1},
        )
        prod_sku = (prod or {}).get("sku")
        if prod_sku:
            return await _resolve_credit_back_rate(
                db, sku=prod_sku, product_id=None, default=fallback
            )

    return fallback


async def _compute_per_line_credit(
    db,
    line_items: List[dict],
    *,
    apply_vat: bool = True,
) -> dict:
    """Return total credit earned + per-line breakdown for an EPOS invoice.

    `line_items` is the same shape as `invoice_dict["line_items"]` (already
    serialized — i.e. `due_price` and `price` are floats, `quantity` is float).
    Returned breakdown is stamped on the invoice doc so admins can audit
    *exactly* which product earned what — invaluable when a trader queries
    a credit-back number on their statement.

    Pricing basis:
      • Use `due_price` if set (negotiated price), else `price`.
      • Multiply by `quantity` to get the line net (ex-VAT — EPOS line
        prices are always ex-VAT regardless of the `apply_vat` toggle).
      • Multiply by `rate / 100` to get £ credit for that line.

    `apply_vat` is accepted for forward-compat but does not change the math
    today (line prices are already ex-VAT in this EPOS).
    """
    breakdown: List[dict] = []
    total_credit = 0.0
    total_net = 0.0

    for item in line_items or []:
        qty = float(item.get("quantity") or 0)
        if qty <= 0:
            continue
        # Skip return lines (negative-impact items use a different lane)
        if item.get("isReturn") or item.get("is_return"):
            continue
        unit = item.get("due_price")
        if unit in (None, "", 0) and item.get("due_price") != 0:
            unit = item.get("price") or 0
        try:
            unit_f = float(unit or 0)
        except (TypeError, ValueError):
            unit_f = 0.0
        net = unit_f * qty
        if net <= 0:
            continue
        rate = await _resolve_credit_back_rate(
            db,
            sku=item.get("sku"),
            product_id=item.get("product_id"),
        )
        line_credit = round(net * rate / 100.0, 2)
        total_credit += line_credit
        total_net += net
        breakdown.append({
            "product_id": item.get("product_id"),
            "sku": item.get("sku"),
            "product_name": item.get("product_name"),
            "quantity": qty,
            "net": round(net, 2),
            "rate": rate,
            "credit": line_credit,
        })

    return {
        "total_credit": round(total_credit, 2),
        "total_net": round(total_net, 2),
        "breakdown": breakdown,
        "blended_rate": (
            round(total_credit / total_net * 100, 2) if total_net > 0 else 0.0
        ),
    }


async def _reconcile_credit_after_edit(
    db, existing_invoice: dict, new_line_items: List[dict], current_user: dict
) -> None:
    """Reverse over-earned trade credit when an invoice is edited post-save.

    Common trigger: staff edits an existing invoice and marks one or more
    line items as `isReturn: true` (or removes a line entirely). The
    original `trade_credit_earned` figure was calculated at save time on
    the pre-return totals; without this reconciliation the trader keeps
    credit they never actually earned.

    The function recomputes the per-line credit from the NEW items, compares
    against the live `trade_credit_earned` field, and if the new amount is
    LOWER it:
      • subtracts the delta from the customer's `credit_balance`
      • inserts a `reversed_earned_via_invoice_edit` audit row in
        `credit_transactions`
      • $sets the new `trade_credit_earned` (NET) on the invoice
      • preserves `trade_credit_earned_original` on the first reconciliation
        so any subsequent refund-note reversal still has the true gross
        for its ratio math

    If the new amount is HIGHER than the live field (e.g. a line was added
    on edit), we DO NOT auto-accrue more — that path is too risky for an
    edit endpoint and should be handled via a fresh invoice. We log a
    warning so the admin can manually award if needed.
    """
    current_earned = float(existing_invoice.get("trade_credit_earned") or 0)
    trade_ref = (existing_invoice.get("trade_account_number") or "").strip()
    if current_earned <= 0 or not trade_ref:
        return  # nothing to reconcile

    # Re-run the same per-line credit math used on save.
    # We don't have the original apply_vat flag on the invoice doc, but the
    # function ignores it for now (line prices are already ex-VAT) so the
    # default is safe.
    calc = await _compute_per_line_credit(db, new_line_items, apply_vat=True)
    desired_earned = round(float(calc.get("total_credit") or 0), 2)

    # `trade_credit_earned` may already reflect prior refund-note reversals
    # (the live field stores NET, not original). The new computed value is
    # ALSO a gross-of-isReturn-exclusions number — but we want to keep the
    # refund-note reversals separate. So the truthful "desired live value"
    # is: max(0, desired_earned - already_reversed_by_refunds).
    already_reversed = float(existing_invoice.get("credit_earned_already_reversed") or 0)
    target_net = round(max(0.0, desired_earned - already_reversed), 2)

    delta = round(current_earned - target_net, 2)
    if delta <= 0.005:
        # No reduction needed. (delta < 0 = "edit added new lines" — see docstring.)
        if delta < -0.005:
            logging.warning(
                "Invoice %s edit increased earned credit by £%.2f — not auto-accrued. "
                "Issue a manual adjustment if appropriate.",
                existing_invoice.get("invoice_no"), -delta,
            )
        return

    # Reverse `delta` from the trader's balance.
    cust = await db.shop_customers.find_one_and_update(
        {"trade_account_number": trade_ref},
        {"$inc": {"credit_balance": -delta}},
        return_document=False,
    )
    prior_balance = float((cust or {}).get("credit_balance") or 0)
    now = datetime.now(timezone.utc).isoformat()
    invoice_no = existing_invoice.get("invoice_no", "")
    inv_id = existing_invoice.get("id")
    await db.credit_transactions.insert_one({
        "id": str(uuid.uuid4()),
        "customer_id": (cust or {}).get("id"),
        "trade_account_number": trade_ref,
        "type": "reversed_earned_via_invoice_edit",
        "amount": -delta,
        "balance_after": round(prior_balance - delta, 2),
        "source": "invoice_edit",
        "invoice_id": inv_id,
        "invoice_no": invoice_no,
        "channel": "in_store",
        "showroom_id": existing_invoice.get("showroom_id"),
        "showroom_name": existing_invoice.get("showroom_name"),
        "description": (
            f"Invoice {invoice_no} edited — credit earned reduced "
            f"from £{current_earned:.2f} to £{target_net:.2f} "
            f"(returns/edits) by {current_user.get('email', 'admin')}"
        ),
        "created_at": now,
    })

    # Decrement the invoice's `trade_credit_earned`; preserve the original on
    # the FIRST reconciliation so any future refund-note reversal still has
    # accurate ratio math.
    set_ops = {"trade_credit_earned": target_net}
    if existing_invoice.get("trade_credit_earned_original") is None:
        set_ops["trade_credit_earned_original"] = current_earned + already_reversed
    await db.invoices.update_one({"id": inv_id}, {"$set": set_ops})


# Check for reportlab availability
try:
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.enums import TA_CENTER, TA_RIGHT, TA_LEFT
    from reportlab.lib import colors
    from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, Image
    REPORTLAB_AVAILABLE = True
except ImportError:
    REPORTLAB_AVAILABLE = False
    logging.warning("reportlab not available - PDF generation disabled")

router = APIRouter(prefix="/invoices", tags=["Invoices"])


# ============ MODELS ============

class LineItemBase(BaseModel):
    product_id: Optional[str] = None
    product_name: str
    sku: Optional[str] = None
    quantity: float
    price: float
    due_price: Optional[float] = None
    total: float
    cost_price: Optional[float] = None  # Cost price for profit calculation
    # Per-line return/exchange — when True this line is treated as a credit
    # against an EARLIER invoice. The original invoice number/id is captured
    # at the moment the Return checkbox is ticked in the EPOS line table so
    # the return is permanently linked back to the source sale for audit and
    # trade-credit reversal.
    is_return: Optional[bool] = False
    original_invoice_no: Optional[str] = None
    original_invoice_id: Optional[str] = None

class DepositBase(BaseModel):
    date: str
    amount: float
    method: Optional[str] = ""  # Payment method (Card, Cash, Bank Transfer, etc.)
    note: Optional[str] = ""
    customNote: Optional[str] = ""  # Additional custom note

class PaymentMethodItem(BaseModel):
    method: str
    amount: float = 0

class InvoiceCreate(BaseModel):
    invoice_no: str
    date: str
    time: Optional[str] = None
    customer_name: Optional[str] = None
    customer_phone: Optional[str] = None
    customer_email: Optional[str] = None
    customer_address: Optional[str] = None
    notes: Optional[str] = None
    sales_person: Optional[str] = None
    staff_pin: Optional[str] = None
    payment_method: Optional[str] = None
    payment_methods: Optional[List[PaymentMethodItem]] = None
    order_type: Optional[str] = None
    showroom_id: Optional[str] = None
    showroom_name: Optional[str] = None
    deposits: Optional[List[DepositBase]] = []
    line_items: List[LineItemBase]
    subtotal: float
    vat: float
    gross_total: float
    total_savings: Optional[float] = 0
    apply_vat: Optional[bool] = True  # False for cash quotation conversions (0% VAT)
    # Trade-credit redemption — applied as a negative payment line, NOT a discount.
    # `credit_redeemed_amount` is what the customer is paying with stored credit.
    # `credit_redeemed_account` is the trade ref we'll deduct from (e.g. T-00001).
    credit_redeemed_amount: Optional[float] = 0
    credit_redeemed_account: Optional[str] = None
    # Cross-channel link — when set, this invoice belongs to an online-registered
    # customer paying in store. Stamped onto the invoice doc so:
    #   1. Customer's "My Orders" page on the shop side shows it.
    #   2. Admin reports can show ONE total spend figure per customer across
    #      online + in-store (rather than two halves of the same person).
    linked_shop_customer_id: Optional[str] = None
    linked_trade_account_number: Optional[str] = None
    linked_business_name: Optional[str] = None

class InvoiceUpdate(BaseModel):
    invoice_no: Optional[str] = None
    date: Optional[str] = None
    time: Optional[str] = None
    customer_name: Optional[str] = None
    customer_phone: Optional[str] = None
    customer_email: Optional[str] = None
    customer_address: Optional[str] = None
    notes: Optional[str] = None
    sales_person: Optional[str] = None
    staff_pin: Optional[str] = None
    payment_method: Optional[str] = None
    payment_methods: Optional[List[PaymentMethodItem]] = None
    order_type: Optional[str] = None
    deposits: Optional[List[DepositBase]] = None
    line_items: Optional[List[LineItemBase]] = None
    subtotal: Optional[float] = None
    vat: Optional[float] = None
    gross_total: Optional[float] = None
    total_savings: Optional[float] = None
    status: Optional[str] = None
    apply_vat: Optional[bool] = None  # False for cash quotation conversions (0% VAT)

class InvoiceStoreUpdate(BaseModel):
    showroom_id: Optional[str] = None
    showroom_name: Optional[str] = None

class BulkInvoiceTransfer(BaseModel):
    invoice_ids: List[str]
    target_showroom_id: str
    target_showroom_name: str

class InvoiceEmailRequest(BaseModel):
    email: str
    subject: Optional[str] = None
    message: Optional[str] = None


# ============ ROUTES ============

@router.get("/reconciliation/daily")
async def daily_reconciliation(
    date: Optional[str] = None,
    current_user: dict = Depends(get_current_user),
):
    """
    End-of-day reconciliation snapshot — splits the day's activity into
    cash/card takings vs trade-credit ledger movement so a Z-read can be
    matched line-for-line.

    Returns:
      gross_invoiced     £ sum of all invoices written today
      credit_redeemed    £ trade credit consumed today (paying off liability)
      net_takings        £ what the till + Stripe should hold (gross − redeemed)
      credit_earned      £ new liability accrued today (from in-store accrual)
      credit_movement    £ earned − redeemed (net liability change for the day)
      invoice_count      n
      redemption_count   n  (how many invoices used credit as payment)
    """
    if not can_access_epos(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    return await _compute_daily_reconciliation(db, date)


async def _compute_daily_reconciliation(db, date: Optional[str]) -> dict:
    """Shared aggregator — used by the GET endpoint and the email endpoint."""

    # Date window — caller can override, otherwise today (UTC). `created_at`
    # is stored as a native BSON datetime here, so we match against datetime
    # objects (range works with the index on created_at).
    if date:
        try:
            target = datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid date — expected YYYY-MM-DD")
    else:
        now = datetime.now(timezone.utc)
        target = now.replace(hour=0, minute=0, second=0, microsecond=0)
    start_dt = target.replace(hour=0, minute=0, second=0, microsecond=0)
    end_dt = target.replace(hour=23, minute=59, second=59, microsecond=999000)
    # Some legacy rows may have ISO-string `created_at`. We tolerate both with $or.
    start_iso = start_dt.isoformat()
    end_iso = end_dt.isoformat()
    date_match = {"$or": [
        {"created_at": {"$gte": start_dt, "$lte": end_dt}},
        {"created_at": {"$gte": start_iso, "$lte": end_iso}},
    ]}

    # 1) Sum all invoices written in window — gross + credit redeemed off them.
    invoice_pipeline = [
        {"$match": {**date_match, "deleted_at": {"$in": [None, ""]}}},
        {"$group": {
            "_id": None,
            "count": {"$sum": 1},
            "gross_invoiced": {"$sum": {"$ifNull": ["$gross_total", 0]}},
            "credit_redeemed": {"$sum": {"$ifNull": ["$credit_redeemed", 0]}},
            "redemption_count": {"$sum": {"$cond": [{"$gt": [{"$ifNull": ["$credit_redeemed", 0]}, 0]}, 1, 0]}},
        }},
    ]
    inv_rows = await db.invoices.aggregate(invoice_pipeline).to_list(1)
    inv = inv_rows[0] if inv_rows else {}
    gross_invoiced = round(float(inv.get("gross_invoiced") or 0), 2)
    credit_redeemed = round(float(inv.get("credit_redeemed") or 0), 2)
    invoice_count = int(inv.get("count") or 0)
    redemption_count = int(inv.get("redemption_count") or 0)

    # 2) Sum all credit_transactions earned today (from accrual side — paid orders / invoices).
    txn_pipeline = [
        {"$match": {
            **date_match,
            "type": {"$in": ["earned_in_store", "earned_online"]},
        }},
        {"$group": {"_id": None, "earned": {"$sum": {"$ifNull": ["$amount", 0]}}}},
    ]
    txn_rows = await db.credit_transactions.aggregate(txn_pipeline).to_list(1)
    credit_earned = round(float((txn_rows[0] if txn_rows else {}).get("earned") or 0), 2)

    # 3) Sum refunds dated today.
    # 24 Feb 2026 — added after the user spotted a £273 discrepancy between
    # Sales & EPOS "Today's Numbers" (£12,047.91) and Invoice History
    # "Daily Revenue" (£11,774.91) — same 31 invoices but different totals.
    # Root cause: Invoice History subtracts today's refunds; this endpoint
    # didn't. Both should reflect what's actually in the till, so refunds
    # are now deducted from net_takings here too.
    #
    # Refunds use the DD/MM/YYYY `date` string (user-stamped), matching
    # how Invoice History filters them. We DON'T use created_at because a
    # refund processed today for yesterday's sale belongs in yesterday's
    # reconciliation, not today's.
    today_ddmmyyyy = target.strftime("%d/%m/%Y")
    refund_pipeline = [
        {"$match": {"date": today_ddmmyyyy, "deleted_at": {"$in": [None, ""]}}},
        {"$group": {
            "_id": None,
            "count": {"$sum": 1},
            "refunds": {"$sum": {"$ifNull": ["$net_refund", {"$ifNull": ["$gross_total", 0]}]}},
        }},
    ]
    refund_rows = await db.refunds.aggregate(refund_pipeline).to_list(1)
    refund_row = refund_rows[0] if refund_rows else {}
    refunds_today = round(float(refund_row.get("refunds") or 0), 2)
    refund_count = int(refund_row.get("count") or 0)

    # Net takings = gross invoices written today
    #             − customer trade-credit redeemed (already deducted on the invoice)
    #             − refunds dated today (money out of the till)
    net_takings = round(gross_invoiced - credit_redeemed - refunds_today, 2)
    credit_movement = round(credit_earned - credit_redeemed, 2)

    return {
        "date": target.strftime("%Y-%m-%d"),
        "gross_invoiced": gross_invoiced,
        "credit_redeemed": credit_redeemed,
        "refunds_today": refunds_today,
        "net_takings": net_takings,
        "credit_earned": credit_earned,
        "credit_movement": credit_movement,
        "invoice_count": invoice_count,
        "redemption_count": redemption_count,
        "refund_count": refund_count,
    }


class ReconciliationEmailInput(BaseModel):
    date: Optional[str] = None
    to: Optional[str] = None  # override recipient; defaults to the requesting admin's email


async def _send_reconciliation_email(db, date: Optional[str], recipients: List[str]) -> dict:
    """
    Build + send the reconciliation email to one or more recipients. Used by the
    on-demand POST endpoint AND the nightly scheduler tick. Raises HTTPException
    on misconfig; returns the data dict on success.
    """
    import os
    import base64
    import csv
    import asyncio

    api_key = os.environ.get("RESEND_API_KEY")
    if not api_key or not RESEND_AVAILABLE:
        raise HTTPException(status_code=503, detail="Email service not configured")
    import resend  # lazy
    resend.api_key = api_key

    cleaned = [r.strip() for r in (recipients or []) if isinstance(r, str) and "@" in r]
    if not cleaned:
        raise HTTPException(status_code=400, detail="No valid recipients")

    data = await _compute_daily_reconciliation(db, date)
    sender_email = os.environ.get("SENDER_EMAIL", "onboarding@resend.dev")
    company_name = os.environ.get("COMPANY_NAME", "Tile Station")
    date_label = data["date"]

    # CSV — two ledger blocks the bookkeeper can paste into Xero/QB.
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([f"{company_name} — Daily Reconciliation", date_label])
    w.writerow([])
    w.writerow(["CASH & CARD TAKINGS"])
    w.writerow(["Gross invoiced", f"£{data['gross_invoiced']:.2f}", f"{data['invoice_count']} invoice(s)"])
    w.writerow(["Trade credit redeemed", f"-£{data['credit_redeemed']:.2f}", f"{data['redemption_count']} invoice(s) used credit"])
    w.writerow(["Refunds today", f"-£{data['refunds_today']:.2f}", f"{data['refund_count']} refund(s)"])
    w.writerow(["Net takings (Z-read)", f"£{data['net_takings']:.2f}"])
    w.writerow([])
    w.writerow(["CREDIT LEDGER MOVEMENT"])
    w.writerow(["Earned today", f"+£{data['credit_earned']:.2f}"])
    w.writerow(["Redeemed today", f"-£{data['credit_redeemed']:.2f}"])
    w.writerow(["Net liability change", f"{'+' if data['credit_movement'] >= 0 else ''}£{data['credit_movement']:.2f}"])
    csv_bytes = buf.getvalue().encode("utf-8")
    fname = f"reconciliation-{date_label}.csv"

    html = f"""
    <p>Hi,</p>
    <p>Here&apos;s the {company_name} reconciliation for <strong>{date_label}</strong>:</p>
    <table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px;margin:12px 0;">
      <tr><td style="padding:4px 14px 4px 0;color:#525252;">Gross invoiced</td>
          <td style="padding:4px 0;text-align:right;font-weight:600;">£{data['gross_invoiced']:.2f}</td></tr>
      <tr><td style="padding:4px 14px 4px 0;color:#525252;">Trade credit redeemed</td>
          <td style="padding:4px 0;text-align:right;color:#047857;">−£{data['credit_redeemed']:.2f}</td></tr>
      <tr><td style="padding:4px 14px 4px 0;color:#525252;">Refunds today ({data['refund_count']})</td>
          <td style="padding:4px 0;text-align:right;color:#b91c1c;">−£{data['refunds_today']:.2f}</td></tr>
      <tr><td style="padding:6px 14px 4px 0;border-top:1px solid #e5e7eb;font-weight:700;">Net takings</td>
          <td style="padding:6px 0 4px 0;border-top:1px solid #e5e7eb;text-align:right;font-weight:700;">£{data['net_takings']:.2f}</td></tr>
    </table>
    <p style="margin:18px 0 6px 0;font-weight:600;">Credit ledger</p>
    <table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px;">
      <tr><td style="padding:4px 14px 4px 0;color:#525252;">Earned today</td>
          <td style="padding:4px 0;text-align:right;color:#047857;">+£{data['credit_earned']:.2f}</td></tr>
      <tr><td style="padding:4px 14px 4px 0;color:#525252;">Redeemed today</td>
          <td style="padding:4px 0;text-align:right;color:#b91c1c;">−£{data['credit_redeemed']:.2f}</td></tr>
      <tr><td style="padding:6px 14px 4px 0;border-top:1px solid #fde68a;font-weight:700;">Net liability change</td>
          <td style="padding:6px 0 4px 0;border-top:1px solid #fde68a;text-align:right;font-weight:700;">{'+' if data['credit_movement'] >= 0 else ''}£{data['credit_movement']:.2f}</td></tr>
    </table>
    <p style="margin-top:18px;">CSV is attached for your bookkeeper.</p>
    <p>— {company_name}</p>
    """

    try:
        await asyncio.to_thread(
            resend.Emails.send,
            {
                "from": f"{company_name} <{sender_email}>",
                "to": cleaned,
                "subject": f"{company_name} reconciliation — {date_label} (net £{data['net_takings']:.2f})",
                "html": html,
                "attachments": [{
                    "filename": fname,
                    "content": base64.b64encode(csv_bytes).decode("ascii"),
                }],
            },
        )
    except Exception as exc:  # noqa: BLE001
        logging.exception("Failed to email daily reconciliation")
        raise HTTPException(status_code=502, detail="Could not send email — please try again later") from exc

    return {"ok": True, "recipients": cleaned, "date": date_label, "data": data}


@router.post("/reconciliation/daily/email")
async def email_daily_reconciliation(
    payload: ReconciliationEmailInput,
    current_user: dict = Depends(get_current_user),
):
    """
    Email the day's reconciliation snapshot as a CSV attachment to the
    requesting admin (or an override recipient). The CSV is the same shape
    the bookkeeper would expect — one section per ledger.
    """
    if not can_access_epos(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")

    db = get_db()
    recipient = (payload.to or current_user.get("email") or "").strip()
    if not recipient:
        raise HTTPException(status_code=400, detail="No recipient email — pass `to` or sign in with an account that has an email")

    res = await _send_reconciliation_email(db, payload.date, [recipient])
    return {"ok": True, "email": recipient, "date": res["date"], "net_takings": res["data"]["net_takings"]}


# ============ SCHEDULE MANAGEMENT ============
# Persisted in `website_settings.key = reconciliation_schedule_settings`.
# Probed hourly by the APScheduler in services/scheduler.py — fires when
# the wall-clock UTC hour matches `hour_utc` AND `enabled` is True.

_SCHEDULE_DEFAULTS = {
    "enabled": False,
    "recipient_emails": [],
    "hour_utc": 6,  # 06:00 UTC default — early enough to land before bookkeeper opens email
}


async def _load_schedule_settings(db) -> dict:
    doc = await db.website_settings.find_one({"key": "reconciliation_schedule_settings"}, {"_id": 0})
    out = dict(_SCHEDULE_DEFAULTS)
    if doc and isinstance(doc.get("value"), dict):
        out.update(doc["value"])
    out["recipient_emails"] = [
        e for e in (out.get("recipient_emails") or [])
        if isinstance(e, str) and "@" in e
    ]
    return out


class ScheduleSettings(BaseModel):
    enabled: Optional[bool] = None
    recipient_emails: Optional[List[str]] = None
    hour_utc: Optional[int] = None


@router.get("/reconciliation/schedule")
async def get_reconciliation_schedule(current_user: dict = Depends(get_current_user)):
    if not can_access_epos(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    return await _load_schedule_settings(db)


@router.put("/reconciliation/schedule")
async def update_reconciliation_schedule(
    payload: ScheduleSettings,
    current_user: dict = Depends(get_current_user),
):
    if not can_access_epos(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    current = await _load_schedule_settings(db)
    if payload.enabled is not None:
        current["enabled"] = bool(payload.enabled)
    if payload.recipient_emails is not None:
        current["recipient_emails"] = [
            e.strip().lower() for e in payload.recipient_emails
            if isinstance(e, str) and "@" in e
        ]
    if payload.hour_utc is not None:
        current["hour_utc"] = max(0, min(23, int(payload.hour_utc)))

    if current["enabled"] and not current["recipient_emails"]:
        raise HTTPException(status_code=400, detail="Add at least one recipient before enabling the schedule")

    await db.website_settings.update_one(
        {"key": "reconciliation_schedule_settings"},
        {"$set": {"value": current, "updated_at": datetime.now(timezone.utc)}},
        upsert=True,
    )
    return current


@router.post("/reconciliation/schedule/send-now")
async def send_scheduled_reconciliation_now(current_user: dict = Depends(get_current_user)):
    """
    Manual trigger — sends the previous day's reconciliation to all configured
    recipients right now (regardless of `enabled`). Used by the "Send test now"
    button in the admin UI.
    """
    if not can_access_epos(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    settings = await _load_schedule_settings(db)
    recipients = settings.get("recipient_emails") or []
    if not recipients:
        raise HTTPException(status_code=400, detail="No recipients configured")
    yesterday = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d")
    res = await _send_reconciliation_email(db, yesterday, recipients)
    await db.reconciliation_email_log.insert_one({
        "sent_at": datetime.now(timezone.utc),
        "recipients": recipients,
        "date": res["date"],
        "net_takings": res["data"]["net_takings"],
        "source": "manual",
        "triggered_by": current_user.get("email"),
    })
    return {"ok": True, "recipients": recipients, "date": res["date"], "net_takings": res["data"]["net_takings"]}


@router.get("/reconciliation/schedule/log")
async def get_reconciliation_log(current_user: dict = Depends(get_current_user)):
    """Last 5 auto/manual sends — feeds the audit-trail strip in the schedule dialog."""
    if not can_access_epos(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    rows = await db.reconciliation_email_log.find(
        {},
        {"_id": 0, "sent_at": 1, "recipients": 1, "date": 1, "net_takings": 1, "source": 1, "triggered_by": 1},
    ).sort("sent_at", -1).limit(5).to_list(length=5)
    # Make sure datetimes are JSON-serializable.
    for r in rows:
        if isinstance(r.get("sent_at"), datetime):
            r["sent_at"] = r["sent_at"].isoformat()
    return {"entries": rows}


async def run_scheduled_reconciliation_tick() -> dict:
    """
    Called by the APScheduler hourly probe. Fires the previous day's
    reconciliation to configured recipients when the wall-clock hour matches.
    Logs every successful fire to `reconciliation_email_log`.
    """
    db = get_db()
    settings = await _load_schedule_settings(db)
    if not settings.get("enabled"):
        return {"status": "disabled"}
    now_utc = datetime.now(timezone.utc)
    if now_utc.hour != int(settings.get("hour_utc", 6)):
        return {"status": "not_this_hour"}
    recipients = settings.get("recipient_emails") or []
    if not recipients:
        return {"status": "no_recipients"}

    yesterday = (now_utc - timedelta(days=1)).strftime("%Y-%m-%d")
    try:
        res = await _send_reconciliation_email(db, yesterday, recipients)
    except HTTPException as exc:
        logging.warning("scheduled reconciliation send failed: %s", exc.detail)
        return {"status": "failed", "error": exc.detail}
    await db.reconciliation_email_log.insert_one({
        "sent_at": now_utc,
        "recipients": recipients,
        "date": res["date"],
        "net_takings": res["data"]["net_takings"],
        "source": "auto",
    })
    return {"status": "ok", "recipients": recipients, "date": res["date"]}


@router.post("")
async def save_invoice(input: InvoiceCreate, current_user: dict = Depends(get_current_user)):
    """Save invoice and update product stock (admin only)"""
    if not can_access_epos(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    # Validate line items
    if not input.line_items or len(input.line_items) == 0:
        raise HTTPException(status_code=400, detail="Invoice must have at least one line item")
    
    # Trade credit can fully cover the invoice — then no cash/card payment is needed
    _credit_covers = (
        float(input.gross_total or 0) > 0
        and float(input.credit_redeemed_amount or 0) > 0
        and (input.credit_redeemed_account or "").strip()
        and float(input.credit_redeemed_amount or 0) >= float(input.gross_total or 0) - 0.005
    )

    # Validate deposits - at least one payment with amount and method required
    if input.deposits:
        valid_payments = [d for d in input.deposits if d.amount and d.amount > 0]
        if not valid_payments and not _credit_covers:
            raise HTTPException(status_code=400, detail="At least one payment with amount is required")
        
        # Check that all payments with amount have a valid method (not a number)
        for i, deposit in enumerate(input.deposits):
            if deposit.amount and deposit.amount > 0:
                method = deposit.method.strip() if deposit.method else ''
                if not method:
                    raise HTTPException(
                        status_code=400, 
                        detail=f"Payment method is required for payment entry {i+1} (£{deposit.amount:.2f})"
                    )
                # Check if method looks like a number (corruption check)
                try:
                    float(method)
                    raise HTTPException(
                        status_code=400,
                        detail=f"Invalid payment method '{method}' for payment entry {i+1}. Please select a valid method like Card, Cash, etc."
                    )
                except ValueError:
                    pass  # Not a number, that's good
    elif not _credit_covers:
        raise HTTPException(status_code=400, detail="At least one payment is required")
    
    db = get_db()
    
    # Check for duplicate invoice number
    existing_invoice = await db.invoices.find_one({"invoice_no": input.invoice_no}, {"_id": 0, "id": 1})
    if existing_invoice:
        raise HTTPException(status_code=400, detail=f"Invoice {input.invoice_no} already exists. Cannot save duplicate.")
    
    # Verify staff PIN if provided
    staff_member = None
    if input.staff_pin:
        staff_member = await db.staff_pins.find_one({"pin": input.staff_pin, "active": True}, {"_id": 0})
        if not staff_member:
            raise HTTPException(status_code=401, detail="Invalid staff PIN")
    
    # Update stock for each item and fetch cost prices
    total_cost = 0
    line_items_with_cost = []
    has_all_costs = True  # Track if all products have cost prices
    
    for item in input.line_items:
        item_dict = item.model_dump()
        cost_price = None  # Use None instead of 0 to indicate no cost
        
        if item.product_id and item.product_id.strip():
            product = await db.products.find_one({"id": item.product_id}, {"_id": 0})
            if product:
                new_stock = product.get("stock", 0) - int(item.quantity)
                await db.products.update_one(
                    {"id": item.product_id},
                    {"$set": {"stock": new_stock}}
                )
                # Get cost price for profit calculation (only if set)
                product_cost = product.get("cost")
                if product_cost is not None and product_cost > 0:
                    cost_price = product_cost
                else:
                    has_all_costs = False
        else:
            # Manual entry without product ID - no cost available
            has_all_costs = False
        
        item_dict["cost_price"] = cost_price
        line_items_with_cost.append(item_dict)
        if cost_price is not None:
            total_cost += cost_price * item.quantity
    
    # Only calculate profit if ALL products have cost prices
    if has_all_costs and total_cost > 0:
        selling_total = input.subtotal  # Net selling price before VAT
        net_profit = selling_total - total_cost
        profit_margin = round((net_profit / selling_total * 100), 2) if selling_total > 0 else 0
    else:
        net_profit = None
        profit_margin = None
        total_cost = None
    
    # Stamp attribution fields (4 Jun 2026) so downstream reports stay
    # correct after a staff transfer between showrooms.
    from services.staff_attribution import resolve_staff_attribution
    attribution = await resolve_staff_attribution(
        current_user,
        input_showroom_id=input.showroom_id,
        input_showroom_name=input.showroom_name,
    )

    # Save invoice
    invoice_dict = {
        "id": str(uuid.uuid4()),
        "invoice_no": input.invoice_no,
        "date": input.date,
        "time": input.time,
        "customer_name": input.customer_name,
        "customer_phone": input.customer_phone,
        "customer_email": input.customer_email,
        "customer_address": input.customer_address,
        "notes": input.notes,
        "sales_person": staff_member["name"] if staff_member else input.sales_person,
        "staff_id": staff_member["id"] if staff_member else None,
        "staff_name": staff_member["name"] if staff_member else None,
        "payment_method": input.payment_method,
        "payment_methods": [pm.model_dump() for pm in input.payment_methods] if input.payment_methods else [],
        "order_type": input.order_type,
        "showroom_id": attribution["showroom_id"] or input.showroom_id,
        "showroom_name": attribution["showroom_name"] or input.showroom_name,
        "deposits": [d.model_dump() for d in input.deposits] if input.deposits else [],
        "line_items": line_items_with_cost,
        "subtotal": input.subtotal,
        "vat": input.vat,
        "gross_total": input.gross_total,
        "total_savings": input.total_savings,
        "apply_vat": input.apply_vat,  # False for cash quotation conversions (0% VAT)
        "created_by": current_user["email"],
        "created_by_user_id": attribution["created_by_user_id"],
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

    # Stamp cross-channel link fields if provided. Backfill the trade
    # account from shop_customers when the staff member only set the link
    # without filling the trade fields explicitly.
    if input.linked_shop_customer_id:
        invoice_dict["linked_shop_customer_id"] = input.linked_shop_customer_id
        link_trade = input.linked_trade_account_number
        link_business = input.linked_business_name
        if not link_trade or not link_business:
            try:
                shop_cust = await db.shop_customers.find_one(
                    {"id": input.linked_shop_customer_id},
                    {"_id": 0, "trade_account_number": 1, "business_name": 1},
                )
                if shop_cust:
                    link_trade = link_trade or shop_cust.get("trade_account_number")
                    link_business = link_business or shop_cust.get("business_name")
            except Exception:
                pass
        if link_trade:
            invoice_dict["trade_account_number"] = link_trade
        if link_business:
            invoice_dict["trade_business_name"] = link_business
    
    # Add profit data only if calculated
    if net_profit is not None:
        invoice_dict["total_cost"] = total_cost
        invoice_dict["net_profit"] = net_profit
        invoice_dict["profit_margin"] = profit_margin
    
    # Calculate status based on payment
    total_deposits = sum(d.amount for d in input.deposits) if input.deposits else 0
    # Trade credit redemption is a payment lane too (deducted atomically
    # from the customer's balance below). Treat it as paid amount so the
    # invoice's outstanding figure stays accurate.
    credit_redeemed_for_calc = float(input.credit_redeemed_amount or 0) if (input.credit_redeemed_amount and input.credit_redeemed_account) else 0
    total_paid = total_deposits + credit_redeemed_for_calc
    amount_outstanding = input.gross_total - total_paid

    if total_paid > 0 and amount_outstanding > 0.01:
        invoice_dict["status"] = "deposit_order"
    else:
        invoice_dict["status"] = "open_order"
    
    invoice_dict["total_deposits"] = total_deposits
    invoice_dict["amount_outstanding"] = max(0, amount_outstanding)
    
    await db.invoices.insert_one(invoice_dict)

    # ---- Retail-customer lifetime spend tracking ----------------------------
    # When the EPOS invoice is linked to an online shop_customer who is NOT
    # trade (retail), bump their `total_spent` so the same field that powers
    # the trader's lifetime-spend stat also reflects retail in-store sales.
    # Trade accounts get their own bump inside the credit-accrual block below
    # (alongside the credit_balance += earned), so we skip them here to avoid
    # double-counting. Idempotent reverse logic lives in
    # reverse_invoice_credits / reapply_invoice_credits.
    if input.linked_shop_customer_id:
        try:
            linked_cust = await db.shop_customers.find_one(
                {"id": input.linked_shop_customer_id},
                {"_id": 0, "id": 1, "is_trade": 1},
            )
            if linked_cust and not bool(linked_cust.get("is_trade")):
                gross = float(input.gross_total or 0)
                if gross > 0:
                    await db.shop_customers.update_one(
                        {"id": linked_cust["id"]},
                        {"$inc": {"total_spent": gross}},
                    )
        except Exception as _spend_err:
            logging.warning(
                f"[retail-spend] failed to bump total_spent on invoice "
                f"{invoice_dict.get('invoice_no')}: {_spend_err}"
            )

    # ---- In-store trade credit accrual (opt-in via Storefront Messages admin) ----
    # If the configured toggle is ON and the invoice's customer email/phone
    # resolves to an approved trade `shop_customers` account, mirror the same
    # credit-back % their online orders earn. Stamps the invoice with their
    # trade reference so it shows on the badge column and admin reports.
    in_store_credit_earned = 0
    in_store_credit_setting = await db.website_settings.find_one(
        {"key": "storefront_messages"}, {"_id": 0, "value": 1},
    )
    in_store_enabled = bool(
        ((in_store_credit_setting or {}).get("value") or {})
        .get("in_store_credit", {})
        .get("enabled", False)
    )
    if in_store_enabled and (input.customer_email or input.customer_phone):
        trade_query = []
        if input.customer_email:
            trade_query.append({"email": input.customer_email.lower().strip()})
        if input.customer_phone:
            trade_query.append({"phone": input.customer_phone})
        trade_cust = await db.shop_customers.find_one(
            {"$or": trade_query, "is_trade": True} if trade_query else {"_id": None},
            {"_id": 0, "id": 1, "credit_rate": 1, "credit_balance": 1, "trade_account_number": 1, "business_name": 1, "total_spent": 1},
        )
        if trade_cust:
            customer_credit_rate = float(trade_cust.get("credit_rate") or 0)
            # ── Per-product credit-back (Scenario 1) ──────────────────────────
            # Walk every line item and accrue at THAT product's credit-back %
            # (supplier_products → tiles → 2% default). This matches the online
            # shop's per-product behaviour exactly so traders see the same £
            # number whether they buy in-store or online.
            credit_calc = await _compute_per_line_credit(
                db,
                invoice_dict["line_items"],
                apply_vat=bool(input.apply_vat) if input.apply_vat is not None else True,
            )
            credits = credit_calc["total_credit"]
            blended_rate = credit_calc["blended_rate"]
            t_ref = trade_cust.get("trade_account_number")
            # Stamp the invoice for searchability + audit.
            # `trade_credit_rate` now holds the *blended* effective rate
            # (sum of per-line credits ÷ ex-VAT net) so reports/email render
            # truthfully even when the invoice mixes products with different
            # credit-back rates. The full per-line breakdown is preserved on
            # `trade_credit_breakdown` so admins can audit any single line.
            invoice_update = {
                "trade_account_number": t_ref,
                "trade_business_name": trade_cust.get("business_name"),
                "trade_credit_earned": credits,
                "trade_credit_rate": blended_rate,
                "trade_credit_customer_rate": customer_credit_rate,
                "trade_credit_breakdown": credit_calc["breakdown"],
            }
            await db.invoices.update_one({"id": invoice_dict["id"]}, {"$set": invoice_update})
            invoice_dict.update(invoice_update)
            if credits > 0:
                # Move money + bump lifetime spend; log a credit transaction.
                await db.shop_customers.update_one(
                    {"id": trade_cust["id"]},
                    {"$inc": {"credit_balance": credits, "total_spent": float(input.gross_total or 0)}},
                )
                await db.credit_transactions.insert_one({
                    "id": str(uuid.uuid4()),
                    "customer_id": trade_cust["id"],
                    "trade_account_number": t_ref,
                    "type": "earned_in_store",
                    "amount": credits,
                    "balance_after": float(trade_cust.get("credit_balance") or 0) + credits,
                    "source": "epos_invoice",
                    "invoice_id": invoice_dict["id"],
                    "invoice_no": invoice_dict["invoice_no"],
                    # Where the credit was earned — added 24 Feb 2026 so the
                    # admin "credit history" view can show per-store breakdowns
                    # (which showroom is generating the most trade-credit
                    # liability, what's online vs in-store, etc.).
                    "channel": "in_store",
                    "showroom_id": invoice_dict.get("showroom_id"),
                    "showroom_name": invoice_dict.get("showroom_name"),
                    "description": (
                        f"Credit back from in-store invoice {invoice_dict['invoice_no']} "
                        f"(per-product rates, blended {blended_rate}% of £{credit_calc['total_net']:.2f})"
                    ),
                    "created_at": datetime.now(timezone.utc).isoformat(),
                })
                in_store_credit_earned = credits

                # ---- Celebratory re-engagement email ----
                # Every in-store invoice that accrues credit for a trade
                # customer sends a branded "You just earned £X credit"
                # nudge via Resend. Any Resend failure is logged on the
                # invoice doc for debugging but NEVER aborts invoice save.
                try:
                    email_result = await send_trade_credit_earned_email(
                        invoice=invoice_dict,
                        trade_customer=trade_cust,
                        credits_earned=credits,
                        balance_after=float(trade_cust.get("credit_balance") or 0) + credits,
                    )
                    await db.invoices.update_one(
                        {"id": invoice_dict["id"]},
                        {"$set": {
                            "credit_email_sent": bool(email_result.get("sent")),
                            "credit_email_error": email_result.get("error"),
                            "credit_email_at": datetime.now(timezone.utc).isoformat(),
                        }},
                    )
                except Exception as email_exc:  # noqa: BLE001
                    logging.exception("Credit-earned email dispatch failed: %s", email_exc)
                    await db.invoices.update_one(
                        {"id": invoice_dict["id"]},
                        {"$set": {
                            "credit_email_sent": False,
                            "credit_email_error": str(email_exc)[:200],
                            "credit_email_at": datetime.now(timezone.utc).isoformat(),
                        }},
                    )

    # ---- Credit redemption (Pay with credit) ----
    # When staff applies trade credit at the till, deduct from the customer's
    # balance and log a `redeemed_in_store` credit transaction. This is treated
    # as a payment method (not a discount), so VAT is unaffected.
    redeemed_amount = float(input.credit_redeemed_amount or 0)
    redeemed_ref = (input.credit_redeemed_account or "").strip()
    if redeemed_amount > 0 and redeemed_ref:
        # Atomic, balance-safe deduction: only deduct if balance >= amount.
        update_res = await db.shop_customers.find_one_and_update(
            {
                "trade_account_number": redeemed_ref,
                "is_trade": True,
                "credit_balance": {"$gte": redeemed_amount},
            },
            {"$inc": {"credit_balance": -redeemed_amount}},
            return_document=False,  # ReturnDocument.BEFORE — we want the prior balance for the audit log
        )
        if not update_res:
            raise HTTPException(
                status_code=400,
                detail=f"Could not redeem £{redeemed_amount:.2f} from {redeemed_ref} — insufficient balance or account not found",
            )
        prior_balance = float(update_res.get("credit_balance") or 0)
        _credit_set = {
            "credit_redeemed": redeemed_amount,
            "credit_redeemed_account": redeemed_ref,
        }
        # Credit-only invoice — record "Trade Credit" as the payment method so
        # history/reports never show a blank/unknown payment.
        if not (invoice_dict.get("payment_method") or "").strip():
            _credit_set["payment_method"] = "Trade Credit"
            invoice_dict["payment_method"] = "Trade Credit"
        await db.invoices.update_one(
            {"id": invoice_dict["id"]},
            {"$set": _credit_set},
        )
        invoice_dict["credit_redeemed"] = redeemed_amount
        invoice_dict["credit_redeemed_account"] = redeemed_ref
        await db.credit_transactions.insert_one({
            "id": str(uuid.uuid4()),
            "customer_id": update_res.get("id"),
            "trade_account_number": redeemed_ref,
            "type": "redeemed_in_store",
            "amount": -redeemed_amount,  # negative = outflow from balance
            "balance_after": round(prior_balance - redeemed_amount, 2),
            "source": "epos_invoice",
            "invoice_id": invoice_dict["id"],
            "invoice_no": invoice_dict["invoice_no"],
            # Where it was spent — see matching field on the earn path.
            "channel": "in_store",
            "showroom_id": invoice_dict.get("showroom_id"),
            "showroom_name": invoice_dict.get("showroom_name"),
            "description": f"Credit redeemed at till on invoice {invoice_dict['invoice_no']}",
            "created_at": datetime.now(timezone.utc).isoformat(),
        })

    invoice_dict["trade_credit_earned"] = in_store_credit_earned
    
    # Log audit trail
    await log_audit(
        action="CREATE",
        entity_type="invoice",
        user=current_user,
        entity_id=invoice_dict["id"],
        entity_name=invoice_dict["invoice_no"],
        after_data={
            "invoice_no": invoice_dict["invoice_no"],
            "customer_name": invoice_dict.get("customer_name"),
            "gross_total": invoice_dict["gross_total"],
            "showroom_name": invoice_dict.get("showroom_name"),
            "items_count": len(invoice_dict["line_items"])
        },
        details=f"Invoice {invoice_dict['invoice_no']} created for £{invoice_dict['gross_total']:.2f}"
    )
    
    # Send order confirmation email
    email_sent = False
    if input.customer_email and RESEND_AVAILABLE:
        try:
            await send_order_confirmation_email(invoice_dict)
            email_sent = True
        except Exception as e:
            logging.error(f"Failed to send order confirmation email: {e}")
    
    # Award loyalty points if customer is enrolled
    loyalty_points_earned = 0
    if input.customer_email or input.customer_phone:
        try:
            # Check if customer is enrolled using email or phone as customer_id
            customer_id = input.customer_email or input.customer_phone
            loyalty_account = await db.loyalty_accounts.find_one({"customer_id": customer_id})
            
            if not loyalty_account and input.customer_email:
                # Also check by email field
                loyalty_account = await db.loyalty_accounts.find_one({"email": input.customer_email})
            
            if loyalty_account:
                # Calculate points (10 points per £1 spent on net amount)
                from routes.loyalty import POINTS_PER_POUND
                points_earned = int(input.subtotal * POINTS_PER_POUND)
                
                if points_earned > 0:
                    # Update loyalty account
                    await db.loyalty_accounts.update_one(
                        {"_id": loyalty_account["_id"]},
                        {
                            "$inc": {
                                "current_points": points_earned,
                                "lifetime_points": points_earned
                            },
                            "$set": {"last_activity": datetime.now(timezone.utc)}
                        }
                    )
                    
                    # Log loyalty transaction
                    loyalty_transaction = {
                        "id": str(uuid.uuid4()),
                        "customer_id": loyalty_account["customer_id"],
                        "type": "earn",
                        "points": points_earned,
                        "amount": input.subtotal,
                        "invoice_id": invoice_dict["id"],
                        "invoice_no": invoice_dict["invoice_no"],
                        "created_at": datetime.now(timezone.utc)
                    }
                    await db.loyalty_transactions.insert_one(loyalty_transaction)
                    
                    loyalty_points_earned = points_earned
                    logging.info(f"Awarded {points_earned} loyalty points to {customer_id} for invoice {invoice_dict['invoice_no']}")
        except Exception as e:
            logging.error(f"Failed to award loyalty points: {e}")
    
    return {
        "message": "Invoice saved and stock updated",
        "invoice_id": invoice_dict["id"],
        "invoice_no": invoice_dict["invoice_no"],
        "staff_name": staff_member["name"] if staff_member else None,
        "email_sent": email_sent,
        "loyalty_points_earned": loyalty_points_earned
    }


class CreditBackLineItem(BaseModel):
    """Single line item from the EPOS in-progress invoice cart, used by the
    `POST /credit-back-rates` preview endpoint. Mirrors `LineItemBase` but
    every field is optional so the frontend can fire this even mid-typing."""

    product_id: Optional[str] = None
    sku: Optional[str] = None
    product_name: Optional[str] = None
    quantity: Optional[float] = 0
    price: Optional[float] = 0
    due_price: Optional[float] = None


class CreditBackPreviewInput(BaseModel):
    line_items: List[CreditBackLineItem]
    apply_vat: Optional[bool] = True


@router.post("/credit-back-rates")
async def credit_back_rates_preview(
    input: CreditBackPreviewInput,
    current_user: dict = Depends(get_current_user),
):
    """Preview the per-line credit-back the in-progress EPOS cart will earn.

    Used by the EPOS `TradeCustomerChip` to keep the live "Will earn £X
    credit" preview pill *exactly* in sync with the figure the backend will
    accrue when the invoice is saved. Mirrors the same lookup priority
    (supplier_products → tiles → 2% default) and the same per-line maths
    used in `save_invoice()`.
    """
    if not can_access_epos(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    serialized = [item.model_dump() for item in input.line_items]
    calc = await _compute_per_line_credit(
        db,
        serialized,
        apply_vat=bool(input.apply_vat) if input.apply_vat is not None else True,
    )
    return {
        "total_credit": calc["total_credit"],
        "total_net": calc["total_net"],
        "blended_rate": calc["blended_rate"],
        "breakdown": calc["breakdown"],
        "default_rate": _trade_credit_back_default(),
    }


@router.get("")
async def get_invoices(
    current_user: dict = Depends(get_current_user),
    search: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    staff_id: Optional[str] = None,
    showroom_id: Optional[str] = None,
    include_deleted: bool = False,
    limit: int = 5000,
    skip: int = 0
):
    """Get all invoices with optional search and filters (admin only)"""
    if not can_access_epos(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
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
            {"invoice_no": {"$regex": search, "$options": "i"}},
            {"customer_name": {"$regex": search, "$options": "i"}},
            {"customer_phone": {"$regex": search, "$options": "i"}},
            {"customer_email": {"$regex": search, "$options": "i"}},
            {"staff_name": {"$regex": search, "$options": "i"}},
        ]
        if "$or" not in query:
            query["$or"] = search_query
        else:
            query = {"$and": [query, {"$or": search_query}]}
    
    if staff_id:
        query["staff_id"] = staff_id
    
    # Use reasonable limit with pagination support
    max_limit = min(limit, 10000)
    invoices = await db.invoices.find(query, {"_id": 0}).sort("created_at", -1).skip(skip).limit(max_limit).to_list(max_limit)
    
    # Hide profit data from non-super-admin users
    if current_user.get("role") != "super_admin":
        for invoice in invoices:
            invoice.pop("total_cost", None)
            invoice.pop("net_profit", None)
            invoice.pop("profit_margin", None)
            # Also hide cost_price from line items
            for item in invoice.get("line_items", []):
                item.pop("cost_price", None)
    
    return invoices


@router.get("/outstanding-balances")
async def get_outstanding_balances(
    limit: int = 5,
    current_user: dict = Depends(get_current_user),
):
    """Top-N oldest deposit-order invoices still awaiting balance payment.

    Powers the "Outstanding Balances" widget on the EPOS tab. Returns
    invoices where ``amount_outstanding > 0.01``, sorted oldest-first
    (by the user-stamped DD/MM/YYYY ``date`` field, then created_at
    as a tiebreaker).

    For showroom-scoped users, results are filtered to their showroom
    so a Tonbridge clerk doesn't see Sydenham's outstanding balances.

    Response:
        {
          "count": N,                # total matching (not limited)
          "total_outstanding": £,    # sum across all matching invoices
          "invoices": [ {id, invoice_no, date, customer_name, customer_phone,
                         gross_total, total_deposits, amount_outstanding,
                         showroom_name, days_old} ... up to `limit` rows ]
        }
    """
    if not can_access_epos(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")

    db = get_db()

    # Showroom scoping — staff/manager only see their own showroom's invoices
    match: dict = {
        "deleted_at": {"$in": [None, ""]},
        "status": {"$ne": "cancelled"},
        "amount_outstanding": {"$gt": 0.01},
    }
    user_showroom_id = current_user.get("showroom_id")
    if current_user.get("role") != "super_admin" and user_showroom_id:
        match["showroom_id"] = user_showroom_id

    # Pull the (possibly long) candidate list — we need an accurate
    # "count" / "total_outstanding" across ALL matching rows, then take
    # the oldest N for the widget itself. Cap at 1000 for safety.
    rows = await db.invoices.find(
        match,
        {"_id": 0, "id": 1, "invoice_no": 1, "date": 1, "customer_name": 1,
         "customer_phone": 1, "gross_total": 1, "total_deposits": 1,
         "amount_outstanding": 1, "showroom_name": 1, "created_at": 1,
         "sales_person": 1, "deposits": 1},
    ).limit(1000).to_list(1000)

    def _parse_date(s):
        if not s or not isinstance(s, str):
            return None
        for fmt in ("%d/%m/%Y", "%d/%m/%y"):
            try:
                return datetime.strptime(s.strip(), fmt).replace(tzinfo=timezone.utc)
            except ValueError:
                continue
        return None

    now = datetime.now(timezone.utc)
    enriched = []
    total_outstanding = 0.0
    for inv in rows:
        outstanding = float(inv.get("amount_outstanding") or 0)
        if outstanding <= 0.01:
            continue
        # If total_deposits wasn't stored on legacy docs, compute it now
        deposits = inv.get("deposits") or []
        td = inv.get("total_deposits")
        if td is None:
            try:
                td = sum(float(d.get("amount") or 0) for d in deposits)
            except (TypeError, ValueError):
                td = 0
        inv_date = _parse_date(inv.get("date"))
        days_old = (now - inv_date).days if inv_date else 0
        total_outstanding += outstanding
        enriched.append({
            "id": inv.get("id"),
            "invoice_no": inv.get("invoice_no"),
            "date": inv.get("date"),
            "customer_name": inv.get("customer_name"),
            "customer_phone": inv.get("customer_phone"),
            "gross_total": round(float(inv.get("gross_total") or 0), 2),
            "total_deposits": round(float(td or 0), 2),
            "amount_outstanding": round(outstanding, 2),
            "showroom_name": inv.get("showroom_name"),
            "sales_person": inv.get("sales_person"),
            "days_old": max(0, days_old),
            "_date_sort": inv_date or now,
        })

    # Oldest first (largest days_old)
    enriched.sort(key=lambda r: r["_date_sort"])
    top = enriched[: max(1, min(limit, 50))]
    # Strip the sort helper before returning
    for r in top:
        r.pop("_date_sort", None)

    return {
        "count": len(enriched),
        "total_outstanding": round(total_outstanding, 2),
        "invoices": top,
    }


@router.get("/audit/mis-dated-deposits")
async def get_mis_dated_deposit_invoices(current_user: dict = Depends(get_current_user)):
    """Return invoices where the deposit date looks WRONG, not merely "different".

    Smart-audit logic (24 Feb 2026 rewrite):

    Original use case (real bug we still want to catch):
      User backdates an invoice to last Friday. The "Add Deposit" form
      auto-defaults to today. They miss it and save — revenue gets
      attributed to today instead of Friday.

    False positive we used to flag (now ignored):
      A correctly-dated initial deposit on the invoice date, followed by
      a legitimate part-payment days/weeks later. This is the normal
      "pay deposit now, balance on collection" flow and is NOT a bug.

    Rule: an invoice is only flagged when NONE of its non-zero deposits
    match the invoice date (within ±1 day). If at least one deposit was
    taken on/near the invoice date, any later deposits are presumed to
    be legitimate part-payments and the invoice is skipped.

    Response shape is unchanged from the original implementation.
    """
    if not can_access_epos(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")

    db = get_db()

    def _parse_ddmmyyyy(s):
        if not s or not isinstance(s, str):
            return None
        s = s.strip()
        # Accept DD/MM/YYYY and DD/MM/YY
        for fmt in ("%d/%m/%Y", "%d/%m/%y"):
            try:
                return datetime.strptime(s, fmt).date()
            except ValueError:
                continue
        return None

    cursor = db.invoices.find(
        {"deleted_at": {"$exists": False}, "status": {"$ne": "cancelled"}},
        {"_id": 0, "id": 1, "invoice_no": 1, "date": 1, "customer_name": 1,
         "total": 1, "deposits": 1, "showroom_name": 1, "sales_person": 1}
    )

    mis_dated = []
    async for inv in cursor:
        inv_date = _parse_ddmmyyyy(inv.get("date"))
        if not inv_date:
            continue
        deposits = inv.get("deposits") or []

        # First pass — parse all non-zero deposits and check if ANY
        # of them sit on (or within 1 day of) the invoice date. If yes,
        # this is a normal "deposit + part-payments" invoice — skip it.
        parsed_deposits = []
        any_match_invoice_date = False
        for dep in deposits:
            try:
                amt = float(dep.get("amount") or 0)
            except (TypeError, ValueError):
                amt = 0
            if amt <= 0:
                continue
            dep_date = _parse_ddmmyyyy(dep.get("date"))
            if not dep_date:
                continue
            diff = abs((dep_date - inv_date).days)
            parsed_deposits.append({
                "raw": dep,
                "date_obj": dep_date,
                "amount": amt,
                "diff": diff,
            })
            if diff <= 1:
                any_match_invoice_date = True

        # Skip — at least one deposit lines up with the invoice date,
        # so any other dates are legitimate part-payments, not a bug.
        if any_match_invoice_date:
            continue

        # Otherwise — every single deposit is dated away from the
        # invoice date. That's the original "auto-defaulted to today
        # on a backdated invoice" scenario we want to surface.
        bad_deposits = []
        max_diff = 0
        for p in parsed_deposits:
            if p["diff"] > 1:
                bad_deposits.append({
                    "date": p["raw"].get("date"),
                    "amount": p["amount"],
                    "method": p["raw"].get("method"),
                    "diff_days": p["diff"],
                })
                if p["diff"] > max_diff:
                    max_diff = p["diff"]

        if bad_deposits:
            mis_dated.append({
                "id": inv.get("id"),
                "invoice_no": inv.get("invoice_no"),
                "date": inv.get("date"),
                "customer_name": inv.get("customer_name"),
                "total": inv.get("total"),
                "sales_person": inv.get("sales_person"),
                "showroom_name": inv.get("showroom_name"),
                "deposits": bad_deposits,
                "max_diff_days": max_diff,
            })

    # Sort by biggest discrepancy first
    mis_dated.sort(key=lambda x: x["max_diff_days"], reverse=True)
    return {"count": len(mis_dated), "invoices": mis_dated}


@router.post("/audit/sync-deposit-dates")
async def sync_deposit_dates(body: Optional[dict] = None, current_user: dict = Depends(get_current_user)):
    """One-click fix: for each target invoice, set every deposit's date to the invoice date.

    Body (optional):
      {"invoice_ids": ["<id1>", "<id2>"]}   → sync only these
      {}  or missing                         → sync ALL invoices currently surfaced by
                                               the mis-dated-deposits audit (diff > 1 day).

    Only zero/positive amount deposits are touched. Returns per-invoice result with
    counts of deposits updated.
    """
    if not can_access_epos(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")

    db = get_db()
    body = body or {}
    invoice_ids = body.get("invoice_ids") or []

    # If no explicit ids, pull the current audit list
    if not invoice_ids:
        audit = await get_mis_dated_deposit_invoices(current_user)  # reuse
        invoice_ids = [i["id"] for i in audit.get("invoices", [])]

    if not invoice_ids:
        return {"updated_invoices": 0, "updated_deposits": 0, "details": []}

    details = []
    total_invoices_updated = 0
    total_deposits_updated = 0

    for inv_id in invoice_ids:
        inv = await db.invoices.find_one(
            {"id": inv_id, "deleted_at": {"$exists": False}},
            {"_id": 0, "id": 1, "invoice_no": 1, "date": 1, "deposits": 1}
        )
        if not inv:
            details.append({"id": inv_id, "skipped": "not found"})
            continue

        inv_date = inv.get("date")
        deposits = inv.get("deposits") or []
        updated_count = 0
        new_deposits = []
        for dep in deposits:
            new_dep = dict(dep)
            if dep.get("date") != inv_date and (dep.get("amount") or 0) != "":
                new_dep["date"] = inv_date
                updated_count += 1
            new_deposits.append(new_dep)

        if updated_count > 0:
            await db.invoices.update_one(
                {"id": inv_id},
                {"$set": {
                    "deposits": new_deposits,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }}
            )
            total_invoices_updated += 1
            total_deposits_updated += updated_count

        details.append({
            "id": inv_id,
            "invoice_no": inv.get("invoice_no"),
            "invoice_date": inv_date,
            "deposits_updated": updated_count,
        })

    return {
        "updated_invoices": total_invoices_updated,
        "updated_deposits": total_deposits_updated,
        "details": details,
    }


class QuickPaymentInput(BaseModel):
    """Payload for the one-click "Add Final Payment" action on Invoice History.

    Date is intentionally NOT in the schema — the server stamps it as
    today's date in UK local format. This is the whole point of the
    feature: revenue should always land on the day the payment was
    received, not on an arbitrary date the user could mistype.
    """
    amount: float
    method: str
    note: Optional[str] = ""


@router.post("/{invoice_id}/payments")
async def add_invoice_payment(
    invoice_id: str,
    input: QuickPaymentInput,
    current_user: dict = Depends(get_current_user),
):
    """One-click "Add Final Payment" endpoint used by Invoice History.

    Appends a single deposit row dated TODAY (UK local time), recalculates
    `total_deposits`, `amount_outstanding` and `status`, and returns the
    updated invoice. Designed for the common workflow where a customer
    returns to pay the balance on a deposit invoice — sales revenue is
    attributed to the day the payment is taken, not the original invoice
    date.

    Why a dedicated endpoint instead of reusing PUT /{invoice_id}:
      - PUT requires the entire invoice payload and risks accidentally
        wiping line items, stock, customer fields, etc.
      - PUT lets the caller specify any date, which is exactly the bug
        we just stopped flagging. Here the server controls the date.
      - Smaller surface area for staff PIN / showroom checks later.

    Args:
        invoice_id: target invoice
        input.amount: payment amount (> 0)
        input.method: payment method ("Cash", "Card", "Bank Transfer", etc.) — required
        input.note: optional free-text note

    Returns:
        { "ok": True, "deposit": {...}, "total_deposits": ..., "amount_outstanding": ..., "status": ... }
    """
    if not can_access_epos(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")

    if input.amount is None or input.amount <= 0:
        raise HTTPException(status_code=400, detail="Payment amount must be greater than zero")

    method = (input.method or "").strip()
    if not method:
        raise HTTPException(status_code=400, detail="Payment method is required (e.g. Card, Cash, Bank Transfer)")
    # Methods must not look like a number (corruption guard, mirrors PUT)
    try:
        float(method)
        raise HTTPException(
            status_code=400,
            detail=f"Invalid payment method '{method}'. Please select a valid method like Card, Cash, etc.",
        )
    except ValueError:
        pass

    db = get_db()
    existing = await db.invoices.find_one({"id": invoice_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Invoice not found")

    # Showroom-scoped users can only update their own showroom's invoices
    user_showroom_id = current_user.get("showroom_id")
    if current_user.get("role") != "super_admin" and user_showroom_id:
        if existing.get("showroom_id") != user_showroom_id:
            raise HTTPException(status_code=403, detail="You can only update invoices from your showroom")

    # Server-stamped date: today, UK local format. THIS IS THE WHOLE POINT
    # of the endpoint — the user can never enter the wrong day.
    today_uk = datetime.now(timezone.utc).strftime("%d/%m/%Y")

    new_deposit = {
        "date": today_uk,
        "amount": float(input.amount),
        "method": method,
        "note": (input.note or "").strip(),
    }

    deposits = list(existing.get("deposits") or [])
    # Strip leading empty placeholders (amount=0 or missing) — they're UI artefacts
    deposits = [d for d in deposits if (d.get("amount") or 0)]
    deposits.append(new_deposit)

    total_deposits = sum(float(d.get("amount") or 0) for d in deposits)
    gross_total = float(existing.get("gross_total") or 0)
    amount_outstanding = max(0.0, gross_total - total_deposits)

    # Status transition mirrors PUT logic
    current_status = existing.get("status", "open_order")
    new_status = current_status
    if amount_outstanding <= 0.01:
        new_status = "open_order" if current_status == "deposit_order" else current_status
    elif total_deposits > 0:
        new_status = "deposit_order"

    update_data = {
        "deposits": deposits,
        "total_deposits": total_deposits,
        "amount_outstanding": amount_outstanding,
        "status": new_status,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "updated_by": current_user["email"],
    }

    await db.invoices.update_one({"id": invoice_id}, {"$set": update_data})

    await log_audit(
        action="ADD_PAYMENT",
        entity_type="invoice",
        user=current_user,
        entity_id=invoice_id,
        entity_name=existing.get("invoice_no", invoice_id),
        after_data={
            "deposit": new_deposit,
            "total_deposits": total_deposits,
            "amount_outstanding": amount_outstanding,
            "status": new_status,
        },
        details=(
            f"Payment £{new_deposit['amount']:.2f} ({method}) added to "
            f"{existing.get('invoice_no', invoice_id)} on {today_uk} — outstanding now £{amount_outstanding:.2f}"
        ),
    )

    return {
        "ok": True,
        "deposit": new_deposit,
        "total_deposits": total_deposits,
        "amount_outstanding": amount_outstanding,
        "status": new_status,
    }





@router.get("/{invoice_id}")
async def get_invoice(invoice_id: str, current_user: dict = Depends(get_current_user)):
    """Get single invoice (admin only)"""
    if not can_access_epos(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    invoice = await db.invoices.find_one({"id": invoice_id}, {"_id": 0})
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
    
    # Check showroom access for non-super-admin users
    user_showroom_id = current_user.get("showroom_id")
    if current_user.get("role") != "super_admin" and user_showroom_id:
        if invoice.get("showroom_id") != user_showroom_id:
            raise HTTPException(status_code=403, detail="You can only view invoices from your showroom")
    
    # Hide profit data from non-super-admin users
    if current_user.get("role") != "super_admin":
        invoice.pop("total_cost", None)
        invoice.pop("net_profit", None)
        invoice.pop("profit_margin", None)
        # Also hide cost_price from line items
        for item in invoice.get("line_items", []):
            item.pop("cost_price", None)
    
    return invoice


@router.put("/{invoice_id}")
async def update_invoice(invoice_id: str, input: InvoiceUpdate, current_user: dict = Depends(get_current_user)):
    """Update an existing invoice (admin only)"""
    if not can_access_epos(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    db = get_db()
    existing = await db.invoices.find_one({"id": invoice_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Invoice not found")
    
    # Validate deposits if being updated - payment method is mandatory
    # (unless the invoice was fully paid with trade credit at creation)
    if input.deposits is not None:
        _existing_credit = float(existing.get("credit_redeemed") or 0)
        _gross = float(input.gross_total if input.gross_total is not None else existing.get("gross_total") or 0)
        _credit_covers = _existing_credit > 0 and _existing_credit >= _gross - 0.005
        valid_payments = [d for d in input.deposits if d.amount and d.amount > 0]
        if not valid_payments and not _credit_covers:
            raise HTTPException(status_code=400, detail="At least one payment with amount is required")
        
        # Check that all payments with amount have a valid method (not a number)
        for i, deposit in enumerate(input.deposits):
            if deposit.amount and deposit.amount > 0:
                method = deposit.method.strip() if deposit.method else ''
                if not method:
                    raise HTTPException(
                        status_code=400, 
                        detail=f"Payment method is required for payment entry {i+1} (£{deposit.amount:.2f})"
                    )
                # Check if method looks like a number (corruption check)
                try:
                    float(method)
                    raise HTTPException(
                        status_code=400,
                        detail=f"Invalid payment method '{method}' for payment entry {i+1}. Please select a valid method like Card, Cash, etc."
                    )
                except ValueError:
                    pass  # Not a number, that's good
    
    # Verify staff PIN if provided
    staff_member = None
    if input.staff_pin:
        staff_member = await db.staff_pins.find_one({"pin": input.staff_pin, "active": True}, {"_id": 0})
        if not staff_member:
            raise HTTPException(status_code=401, detail="Invalid staff PIN")
    
    # Handle stock adjustments if line items changed
    if input.line_items is not None:
        old_items = {item["product_id"]: item["quantity"] for item in existing.get("line_items", []) if item.get("product_id")}
        
        # Restore old stock
        for product_id, old_qty in old_items.items():
            if product_id and product_id.strip():
                await db.products.update_one(
                    {"id": product_id},
                    {"$inc": {"stock": int(old_qty)}}
                )
        
        # Apply new stock
        for item in input.line_items:
            if item.product_id and item.product_id.strip():
                product = await db.products.find_one({"id": item.product_id}, {"_id": 0})
                if product:
                    new_stock = product.get("stock", 0) - int(item.quantity)
                    await db.products.update_one(
                        {"id": item.product_id},
                        {"$set": {"stock": new_stock}}
                    )
    
    # Build update data
    update_data = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "updated_by": current_user["email"]
    }
    
    if input.invoice_no is not None:
        update_data["invoice_no"] = input.invoice_no
    if input.date is not None:
        update_data["date"] = input.date
    if input.time is not None:
        update_data["time"] = input.time
    if input.customer_name is not None:
        update_data["customer_name"] = input.customer_name
    if input.customer_phone is not None:
        update_data["customer_phone"] = input.customer_phone
    if input.customer_email is not None:
        update_data["customer_email"] = input.customer_email
    if input.customer_address is not None:
        update_data["customer_address"] = input.customer_address
    if input.notes is not None:
        update_data["notes"] = input.notes
    if input.payment_method is not None:
        update_data["payment_method"] = input.payment_method
    if input.payment_methods is not None:
        update_data["payment_methods"] = [pm.model_dump() for pm in input.payment_methods]
    if input.line_items is not None:
        update_data["line_items"] = [item.model_dump() for item in input.line_items]
    if input.subtotal is not None:
        update_data["subtotal"] = input.subtotal
    if input.vat is not None:
        update_data["vat"] = input.vat
    if input.gross_total is not None:
        update_data["gross_total"] = input.gross_total
    if input.total_savings is not None:
        update_data["total_savings"] = input.total_savings
    if input.deposits is not None:
        update_data["deposits"] = [d.model_dump() for d in input.deposits]
    
    # Update staff info if PIN provided
    if staff_member:
        update_data["sales_person"] = staff_member["name"]
        update_data["staff_id"] = staff_member["id"]
        update_data["staff_name"] = staff_member["name"]
    elif input.sales_person is not None:
        update_data["sales_person"] = input.sales_person
    
    # Handle status update
    if input.status is not None:
        valid_statuses = ["open_order", "deposit_order", "processing", "completed"]
        if input.status in valid_statuses:
            update_data["status"] = input.status
    
    # Recalculate status based on deposits
    if input.deposits is not None:
        total_deposits = sum(d.amount for d in input.deposits) if input.deposits else 0
        gross_total = input.gross_total if input.gross_total is not None else existing.get("gross_total", 0)
        amount_outstanding = gross_total - total_deposits
        
        update_data["total_deposits"] = total_deposits
        update_data["amount_outstanding"] = max(0, amount_outstanding)
        
        if input.status is None:
            current_status = existing.get("status", "open_order")
            if current_status == "deposit_order" and amount_outstanding <= 0.01:
                update_data["status"] = "open_order"
            elif total_deposits > 0 and amount_outstanding > 0.01:
                update_data["status"] = "deposit_order"
    
    await db.invoices.update_one({"id": invoice_id}, {"$set": update_data})
    
    # Recompute trade credit if line items changed and the original invoice
    # had accrued in-store credit. Marking a line as `isReturn` (or removing
    # a line entirely) post-save MUST reduce the trader's earned credit, or
    # we'd be giving away free money on returned goods. Delta is applied via
    # an atomic adjustment to the customer's `credit_balance` + an audit
    # row on `credit_transactions`. Idempotent — if no delta, no-op.
    # (24 Feb 2026 — user-reported bug: "Credit earned is being calculated
    # on the pre-refund total instead of the final amount paid.")
    if input.line_items is not None:
        try:
            await _reconcile_credit_after_edit(
                db, existing, update_data["line_items"], current_user
            )
        except Exception as _credit_err:  # noqa: BLE001
            logging.exception(
                "Failed to reconcile trade credit on invoice %s edit: %s",
                invoice_id, _credit_err,
            )
    
    # Log audit trail
    before_summary = {
        "invoice_no": existing.get("invoice_no"),
        "customer_name": existing.get("customer_name"),
        "gross_total": existing.get("gross_total"),
        "payment_method": existing.get("payment_method")
    }
    after_summary = {
        "invoice_no": update_data.get("invoice_no", existing.get("invoice_no")),
        "customer_name": update_data.get("customer_name", existing.get("customer_name")),
        "gross_total": update_data.get("gross_total", existing.get("gross_total")),
        "payment_method": update_data.get("payment_method", existing.get("payment_method"))
    }
    await log_audit(
        action="UPDATE",
        entity_type="invoice",
        user=current_user,
        entity_id=invoice_id,
        entity_name=existing.get("invoice_no"),
        before_data=before_summary,
        after_data=after_summary,
        details=f"Invoice {existing.get('invoice_no')} updated"
    )
    
    return {
        "message": "Invoice updated successfully",
        "invoice_id": invoice_id,
        "staff_name": staff_member["name"] if staff_member else None
    }


@router.delete("/{invoice_id}")
async def delete_invoice(invoice_id: str, current_user: dict = Depends(get_current_user)):
    """Soft delete an invoice (Super Admin only) - moves to trash for 30 days"""
    # Only Super Admin can delete documents
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Only Super Admin can delete documents")
    
    db = get_db()
    invoice = await db.invoices.find_one({"id": invoice_id})
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
    
    # Check if already deleted
    if invoice.get("deleted_at"):
        raise HTTPException(status_code=400, detail="Invoice is already in trash")
    
    # Soft delete - mark as deleted with timestamp
    deleted_at = datetime.now(timezone.utc)
    await db.invoices.update_one(
        {"id": invoice_id},
        {"$set": {
            "deleted_at": deleted_at.isoformat(),
            "deleted_by": current_user.get("email"),
            "deleted_by_name": current_user.get("name", current_user.get("email"))
        }}
    )
    
    # Restore stock for all line items (as if deleted)
    for item in invoice.get("line_items", []):
        product_id = item.get("product_id")
        if product_id and product_id.strip():
            await db.products.update_one(
                {"id": product_id},
                {"$inc": {"stock": int(item["quantity"])}}
            )

    # Reverse any trade-credit movement (idempotent — flagged on the doc).
    # Refreshes the invoice from DB first so we pick up the deleted_at stamp
    # we just wrote (cosmetic — the helper only reads credit fields).
    fresh_invoice = await db.invoices.find_one({"id": invoice_id})
    credit_summary = await reverse_invoice_credits(
        db, fresh_invoice, reason="invoice_soft_deleted",
    )
    
    # Log audit trail
    await log_audit(
        action="SOFT_DELETE",
        entity_type="invoice",
        user=current_user,
        entity_id=invoice_id,
        entity_name=invoice.get("invoice_no"),
        before_data={
            "invoice_no": invoice.get("invoice_no"),
            "customer_name": invoice.get("customer_name"),
            "gross_total": invoice.get("gross_total"),
            "items_count": len(invoice.get("line_items", []))
        },
        details=f"Invoice {invoice.get('invoice_no')} moved to trash, stock restored. Trade credit reversed: earned -£{credit_summary['earned_reversed']:.2f}, redeemed +£{credit_summary['redeemed_reversed']:.2f}. Can be restored or permanently deleted from Trash."
    )

    return {
        "message": "Invoice moved to trash. It can be restored or permanently deleted from Trash.",
        "credits_reversed": credit_summary,
    }


@router.post("/{invoice_id}/restore")
async def restore_invoice(invoice_id: str, current_user: dict = Depends(get_current_user)):
    """Restore a soft-deleted invoice from trash (Super Admin only)"""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Only Super Admin can restore documents")
    
    db = get_db()
    invoice = await db.invoices.find_one({"id": invoice_id})
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
    
    if not invoice.get("deleted_at"):
        raise HTTPException(status_code=400, detail="Invoice is not in trash")
    
    # Restore the invoice
    await db.invoices.update_one(
        {"id": invoice_id},
        {"$unset": {"deleted_at": "", "deleted_by": "", "deleted_by_name": ""}}
    )
    
    # Deduct stock again (reverse the restore from soft delete)
    for item in invoice.get("line_items", []):
        product_id = item.get("product_id")
        if product_id and product_id.strip():
            await db.products.update_one(
                {"id": product_id},
                {"$inc": {"stock": -int(item["quantity"])}}
            )

    # Re-apply any reversed trade-credit movement (idempotent — only runs
    # if the doc was actually flagged as reversed by an earlier soft-delete).
    fresh_invoice = await db.invoices.find_one({"id": invoice_id})
    credit_summary = await reapply_invoice_credits(
        db, fresh_invoice, reason="invoice_restored",
    )
    
    # Log audit trail
    await log_audit(
        action="RESTORE",
        entity_type="invoice",
        user=current_user,
        entity_id=invoice_id,
        entity_name=invoice.get("invoice_no"),
        details=f"Invoice {invoice.get('invoice_no')} restored from trash, stock deducted again. Trade credit re-applied: earned +£{credit_summary['earned_reapplied']:.2f}, redeemed -£{credit_summary['redeemed_reapplied']:.2f}."
    )

    return {
        "message": "Invoice restored successfully",
        "credits_reapplied": credit_summary,
    }


@router.delete("/{invoice_id}/permanent")
async def permanent_delete_invoice(invoice_id: str, current_user: dict = Depends(get_current_user)):
    """Permanently delete an invoice (Super Admin only) - cannot be recovered"""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Only Super Admin can permanently delete documents")
    
    db = get_db()
    invoice = await db.invoices.find_one({"id": invoice_id})
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")

    # If the invoice still has un-reversed credit movement (i.e. it was
    # permanent-deleted directly without going through Trash first), reverse
    # those credits BEFORE deleting the doc — otherwise the customer's
    # balance is stranded with credit that was never earned (or redemption
    # that was never refunded).
    credit_summary = await reverse_invoice_credits(
        db, invoice, reason="invoice_permanently_deleted",
    )

    # Permanently delete
    await db.invoices.delete_one({"id": invoice_id})
    
    # Log audit trail
    await log_audit(
        action="PERMANENT_DELETE",
        entity_type="invoice",
        user=current_user,
        entity_id=invoice_id,
        entity_name=invoice.get("invoice_no"),
        before_data={
            "invoice_no": invoice.get("invoice_no"),
            "customer_name": invoice.get("customer_name"),
            "gross_total": invoice.get("gross_total")
        },
        details=f"Invoice {invoice.get('invoice_no')} permanently deleted. Trade credit reversed: earned -£{credit_summary['earned_reversed']:.2f}, redeemed +£{credit_summary['redeemed_reversed']:.2f}."
    )

    return {
        "message": "Invoice permanently deleted",
        "credits_reversed": credit_summary,
    }


@router.patch("/{invoice_id}/status")
async def update_invoice_status(
    invoice_id: str, 
    status: str,
    current_user: dict = Depends(get_current_user)
):
    """Update invoice status (admin only)"""
    if not can_access_epos(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    
    valid_statuses = ["open_order", "deposit_order", "processing", "completed"]
    if status not in valid_statuses:
        raise HTTPException(status_code=400, detail=f"Invalid status. Must be one of: {valid_statuses}")
    
    db = get_db()
    invoice = await db.invoices.find_one({"id": invoice_id})
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
    
    old_status = invoice.get("status", "open_order")
    
    await db.invoices.update_one(
        {"id": invoice_id},
        {"$set": {
            "status": status,
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "updated_by": current_user["email"]
        }}
    )
    
    await log_audit(
        action="UPDATE",
        entity_type="invoice",
        user=current_user,
        entity_id=invoice_id,
        entity_name=invoice.get("invoice_no"),
        before_data={"status": old_status},
        after_data={"status": status},
        details=f"Invoice {invoice.get('invoice_no')} status changed: {old_status} -> {status}"
    )
    
    return {
        "message": f"Invoice status updated to {status}",
        "invoice_id": invoice_id,
        "old_status": old_status,
        "new_status": status
    }


@router.post("/cleanup-none-patterns")
async def cleanup_invoice_none_patterns(dry_run: bool = False):
    """
    Clean 'NonexNone' and similar patterns from all invoice line item product names.
    This fixes historical data that may have been saved with None values.
    """
    import re
    
    db = get_db()
    
    # Patterns to remove
    patterns_to_remove = [
        r'\s*NonexNone\s*',
        r'\s*NoneXNone\s*',
        r'\s*None\s*x\s*None\s*',
        r'\s*xNone\s*',
        r'\s*Nonex\s*',
        r'\s*\(None\)\s*',
        r'\s*\(None\d*[Kk]?g?\)\s*',
        r'\s*None\s*[Kk]g\s*',
        r'\s+None\s*$',
    ]
    
    # Find invoices with None patterns in line items
    invoices = await db.invoices.find({
        "$or": [
            {"items.product_name": {"$regex": "None", "$options": "i"}},
            {"items.name": {"$regex": "None", "$options": "i"}}
        ]
    }).to_list(None)
    
    changes = []
    
    for invoice in invoices:
        items = invoice.get("items", [])
        updated_items = []
        invoice_changed = False
        
        for item in items:
            original_name = item.get("product_name", "") or item.get("name", "") or ""
            new_name = original_name
            
            for pattern in patterns_to_remove:
                new_name = re.sub(pattern, ' ', new_name, flags=re.IGNORECASE)
            
            new_name = re.sub(r'\s+', ' ', new_name).strip()
            
            if new_name != original_name:
                invoice_changed = True
                changes.append({
                    "invoice_no": invoice.get("invoice_no"),
                    "original": original_name,
                    "cleaned": new_name
                })
                item["product_name"] = new_name
                if "name" in item:
                    item["name"] = new_name
            
            updated_items.append(item)
        
        if invoice_changed and not dry_run:
            await db.invoices.update_one(
                {"_id": invoice["_id"]},
                {"$set": {"items": updated_items}}
            )
    
    return {
        "success": True,
        "dry_run": dry_run,
        "invoices_affected": len(set(c["invoice_no"] for c in changes)),
        "items_cleaned": len(changes),
        "message": f"{'Would clean' if dry_run else 'Cleaned'} {len(changes)} invoice line items",
        "samples": changes[:20]
    }


@router.post("/fix-missing-payment-methods")
async def fix_missing_payment_methods(dry_run: bool = False):
    """
    Fix invoices with missing payment_method by extracting it from deposits or payment_methods array.
    """
    db = get_db()
    
    # Find invoices with missing or empty payment_method
    invoices = await db.invoices.find({
        "$or": [
            {"payment_method": None},
            {"payment_method": ""},
            {"payment_method": {"$exists": False}}
        ]
    }).to_list(None)
    
    fixes = []
    
    for invoice in invoices:
        invoice_no = invoice.get("invoice_no")
        deposits = invoice.get("deposits", [])
        payment_methods = invoice.get("payment_methods", [])
        
        # Try to find a valid payment method
        new_method = None
        source = None
        
        # First, check payment_methods array
        for pm in payment_methods:
            if pm.get("method") and pm["method"].strip():
                new_method = pm["method"]
                source = "payment_methods"
                break
        
        # If not found, check deposits
        if not new_method:
            for dep in deposits:
                if dep.get("method") and dep["method"].strip():
                    new_method = dep["method"]
                    source = "deposits"
                    break
        
        if new_method:
            fixes.append({
                "invoice_no": invoice_no,
                "new_method": new_method,
                "source": source
            })
            
            if not dry_run:
                await db.invoices.update_one(
                    {"_id": invoice["_id"]},
                    {"$set": {"payment_method": new_method}}
                )
    
    return {
        "success": True,
        "dry_run": dry_run,
        "total_missing": len(invoices),
        "total_fixed": len(fixes),
        "still_missing": len(invoices) - len(fixes),
        "message": f"{'Would fix' if dry_run else 'Fixed'} {len(fixes)} invoices with missing payment methods",
        "fixes": fixes[:50]
    }


@router.patch("/{invoice_id}/showroom")
async def update_invoice_showroom(
    invoice_id: str, 
    data: InvoiceStoreUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Update invoice showroom assignment (Super Admin only)"""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super Admin access required for showroom transfers")
    
    db = get_db()
    invoice = await db.invoices.find_one({"id": invoice_id})
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
    
    old_showroom_id = invoice.get("showroom_id")
    old_showroom_name = invoice.get("showroom_name", "Unassigned")
    
    await db.invoices.update_one(
        {"id": invoice_id},
        {"$set": {
            "showroom_id": data.showroom_id,
            "showroom_name": data.showroom_name,
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "updated_by": current_user["email"]
        }}
    )
    
    await log_audit(
        action="TRANSFER",
        entity_type="invoice",
        user=current_user,
        entity_id=invoice_id,
        entity_name=invoice.get("invoice_no"),
        before_data={"showroom_id": old_showroom_id, "showroom_name": old_showroom_name},
        after_data={"showroom_id": data.showroom_id, "showroom_name": data.showroom_name},
        details=f"Invoice {invoice.get('invoice_no')} transferred: {old_showroom_name or 'Unassigned'} -> {data.showroom_name or 'Unassigned'}"
    )
    
    return {
        "message": f"Invoice transferred to {data.showroom_name or 'Unassigned'}",
        "invoice_id": invoice_id,
        "old_showroom": old_showroom_name,
        "new_showroom": data.showroom_name
    }


@router.post("/bulk-transfer")
async def bulk_transfer_invoices(
    data: BulkInvoiceTransfer,
    current_user: dict = Depends(get_current_user)
):
    """Bulk transfer multiple invoices to a showroom (Super Admin only)"""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super Admin access required for bulk transfers")
    
    if not data.invoice_ids:
        raise HTTPException(status_code=400, detail="No invoices selected")
    
    db = get_db()
    invoices = await db.invoices.find(
        {"id": {"$in": data.invoice_ids}},
        {"_id": 0}
    ).to_list(len(data.invoice_ids))
    
    if not invoices:
        raise HTTPException(status_code=404, detail="No invoices found")
    
    transferred = []
    failed = []
    total_revenue = 0
    
    for invoice in invoices:
        try:
            old_showroom_id = invoice.get("showroom_id")
            old_showroom_name = invoice.get("showroom_name", "Unassigned")
            
            await db.invoices.update_one(
                {"id": invoice["id"]},
                {"$set": {
                    "showroom_id": data.target_showroom_id,
                    "showroom_name": data.target_showroom_name,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                    "updated_by": current_user["email"]
                }}
            )
            
            await log_audit(
                action="TRANSFER",
                entity_type="invoice",
                user=current_user,
                entity_id=invoice["id"],
                entity_name=invoice.get("invoice_no"),
                before_data={"showroom_id": old_showroom_id, "showroom_name": old_showroom_name},
                after_data={"showroom_id": data.target_showroom_id, "showroom_name": data.target_showroom_name},
                details=f"Bulk transfer: Invoice {invoice.get('invoice_no')} transferred"
            )
            
            transferred.append({
                "invoice_id": invoice["id"],
                "invoice_no": invoice.get("invoice_no"),
                "old_showroom": old_showroom_name,
                "gross_total": invoice.get("gross_total", 0)
            })
            total_revenue += invoice.get("gross_total", 0)
            
        except Exception as e:
            failed.append({
                "invoice_id": invoice["id"],
                "invoice_no": invoice.get("invoice_no"),
                "error": str(e)
            })
    
    return {
        "message": f"Transferred {len(transferred)} invoice(s) to {data.target_showroom_name}",
        "transferred_count": len(transferred),
        "failed_count": len(failed),
        "total_revenue_transferred": round(total_revenue, 2),
        "transferred": transferred,
        "failed": failed
    }



# ============ Trade Credit-Earned Email Audit Log =============================
# Visibility into the celebratory "You earned £X credit" email that fires on
# every accruing in-store invoice. Lets admins see the last 20 dispatches at
# a glance, spot Resend blips, and re-fire failed sends with one click.

@router.get("/credit-emails/recent")
async def list_credit_emails(
    limit: int = 20,
    current_user: dict = Depends(get_current_user),
):
    """Return the N most recent invoices that fired a credit-earned email
    (or attempted to). Used by the SalesHub admin card."""
    if not can_access_epos(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    capped = max(1, min(int(limit or 20), 100))
    cursor = db.invoices.find(
        {"credit_email_at": {"$exists": True}, "deleted_at": {"$exists": False}},
        {
            "_id": 0,
            "id": 1, "invoice_no": 1, "customer_name": 1, "customer_email": 1,
            "trade_business_name": 1, "trade_account_number": 1,
            "trade_credit_earned": 1, "trade_credit_rate": 1, "gross_total": 1,
            "subtotal": 1, "trade_credit_breakdown": 1,
            "showroom_name": 1, "credit_email_sent": 1,
            "credit_email_error": 1, "credit_email_at": 1,
        },
    ).sort("credit_email_at", -1).limit(capped)
    rows = await cursor.to_list(capped)
    sent_count = sum(1 for r in rows if r.get("credit_email_sent"))
    return {
        "rows": rows,
        "total": len(rows),
        "sent_count": sent_count,
        "failed_count": len(rows) - sent_count,
    }


@router.post("/{invoice_id}/credit-emails/resend")
async def resend_credit_email(
    invoice_id: str,
    current_user: dict = Depends(get_current_user),
):
    """Re-fire the trade credit-earned email for an existing invoice.

    Useful when Resend hit a transient blip (rate-limit, dns hiccup) and the
    trader missed their original "you earned £X" nudge. Idempotent on the
    sender side: sends a fresh email each time but the credit ledger is
    NEVER touched (this only re-runs the email, not the accrual).
    """
    if not can_access_epos(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    invoice = await db.invoices.find_one({"id": invoice_id}, {"_id": 0})
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")

    credits = float(invoice.get("trade_credit_earned") or 0)
    if credits <= 0:
        raise HTTPException(
            status_code=400,
            detail="This invoice did not accrue credit — nothing to re-send.",
        )
    if not invoice.get("customer_email"):
        raise HTTPException(
            status_code=400,
            detail="Invoice has no customer email on file.",
        )

    # Pull the trade customer for the email body. Fall back to a stub
    # using the invoice's stamped trade fields so we can still send even
    # if the customer record was deleted/renamed.
    trade_cust = None
    t_ref = invoice.get("trade_account_number")
    if t_ref:
        trade_cust = await db.shop_customers.find_one(
            {"trade_account_number": t_ref},
            {"_id": 0, "id": 1, "trade_account_number": 1, "business_name": 1,
             "name": 1, "credit_balance": 1},
        )
    if not trade_cust:
        trade_cust = {
            "trade_account_number": t_ref,
            "business_name": invoice.get("trade_business_name") or invoice.get("customer_name"),
            "name": invoice.get("customer_name"),
            "credit_balance": None,
        }

    # Use the customer's CURRENT balance for the email (more accurate than
    # the historical balance_after at invoice creation). Fall back to
    # credits if balance unknown so the message still reads sensibly.
    balance_after = (
        float(trade_cust.get("credit_balance"))
        if trade_cust.get("credit_balance") is not None
        else credits
    )

    result = await send_trade_credit_earned_email(
        invoice=invoice,
        trade_customer=trade_cust,
        credits_earned=credits,
        balance_after=balance_after,
    )
    await db.invoices.update_one(
        {"id": invoice_id},
        {"$set": {
            "credit_email_sent": bool(result.get("sent")),
            "credit_email_error": result.get("error"),
            "credit_email_at": datetime.now(timezone.utc).isoformat(),
            "credit_email_resent_by": current_user.get("email"),
        }},
    )
    return {
        "ok": bool(result.get("sent")),
        "error": result.get("error"),
        "invoice_no": invoice.get("invoice_no"),
        "customer_email": invoice.get("customer_email"),
    }



@router.get("/credit-history/{trade_account_number}")
async def get_trade_credit_history(
    trade_account_number: str,
    limit: int = 50,
    current_user: dict = Depends(get_current_user),
):
    """Return earn/redeem history for a trader, with per-store breakdown.

    Powers the "click trader name → tiny breakdown" feature in the
    RecentCreditEmailsCard. Returns:

    - `transactions`: latest N credit_transactions for the trader, each
      including channel ("in_store" / "online") and showroom_name.
      Legacy rows (pre 24 Feb 2026) without these fields are filled in
      live by joining to the linked invoice / refund.
    - `summary`: per-showroom and per-channel totals (earned / redeemed /
      net) so the UI can render the breakdown in 3-5 lines.
    - `balance`: customer's current credit balance.
    - `lifetime_earned` / `lifetime_redeemed`: all-time totals for context.
    """
    if not can_access_epos(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")

    db = get_db()
    t_ref = (trade_account_number or "").strip()
    if not t_ref:
        raise HTTPException(status_code=400, detail="trade_account_number is required")

    customer = await db.shop_customers.find_one(
        {"trade_account_number": t_ref},
        {"_id": 0, "id": 1, "name": 1, "business_name": 1,
         "credit_balance": 1, "trade_account_number": 1},
    )
    if not customer:
        raise HTTPException(status_code=404, detail="Trade account not found")

    capped = max(1, min(int(limit or 50), 200))
    cursor = db.credit_transactions.find(
        {"trade_account_number": t_ref},
        {"_id": 0},
    ).sort("created_at", -1).limit(capped)
    txns = await cursor.to_list(capped)

    # Back-fill `showroom_name` and `channel` for legacy rows by looking
    # up the linked invoice. Cheap because the txns list is capped.
    inv_ids = list({t.get("invoice_id") for t in txns if not t.get("showroom_name") and t.get("invoice_id")})
    inv_map = {}
    if inv_ids:
        async for inv in db.invoices.find(
            {"id": {"$in": inv_ids}},
            {"_id": 0, "id": 1, "showroom_id": 1, "showroom_name": 1},
        ):
            inv_map[inv["id"]] = inv
    for t in txns:
        if not t.get("showroom_name") and t.get("invoice_id") in inv_map:
            inv = inv_map[t["invoice_id"]]
            t["showroom_id"] = inv.get("showroom_id")
            t["showroom_name"] = inv.get("showroom_name")
        if not t.get("channel"):
            ttype = (t.get("type") or "").lower()
            t["channel"] = "online" if "online" in ttype else "in_store"

    # Per-showroom + per-channel aggregation across ALL transactions for
    # this trader (not just the visible page) so the breakdown reflects
    # the full picture.
    pipeline = [
        {"$match": {"trade_account_number": t_ref}},
        {"$group": {
            "_id": {
                "channel": {"$ifNull": ["$channel", "in_store"]},
                "showroom_name": {"$ifNull": ["$showroom_name", None]},
            },
            "earned": {"$sum": {"$cond": [
                {"$in": ["$type", ["earned_in_store", "earned_online", "reapplied_earned_in_store"]]},
                "$amount", 0,
            ]}},
            "redeemed": {"$sum": {"$cond": [
                {"$in": ["$type", ["redeemed_in_store", "redeemed_online", "reapplied_redeemed_in_store"]]},
                {"$abs": "$amount"}, 0,
            ]}},
            "reversed": {"$sum": {"$cond": [
                {"$in": ["$type", ["reversed_earned_in_store", "reversed_earned_via_refund", "reversed_redeemed_in_store", "reversed_redeemed_via_refund"]]},
                "$amount", 0,
            ]}},
            "count": {"$sum": 1},
        }},
        {"$sort": {"earned": -1}},
    ]
    agg = await db.credit_transactions.aggregate(pipeline).to_list(50)

    by_showroom = []
    lifetime_earned = 0.0
    lifetime_redeemed = 0.0
    for row in agg:
        key = row["_id"] or {}
        earned = round(float(row.get("earned") or 0), 2)
        redeemed = round(float(row.get("redeemed") or 0), 2)
        lifetime_earned += earned
        lifetime_redeemed += redeemed
        by_showroom.append({
            "channel": key.get("channel") or "in_store",
            "showroom_name": key.get("showroom_name"),
            "earned": earned,
            "redeemed": redeemed,
            "net": round(earned - redeemed, 2),
            "transaction_count": row.get("count", 0),
        })

    return {
        "customer": {
            "id": customer.get("id"),
            "name": customer.get("name"),
            "business_name": customer.get("business_name"),
            "trade_account_number": customer.get("trade_account_number"),
            "credit_balance": round(float(customer.get("credit_balance") or 0), 2),
        },
        "transactions": txns,
        "by_showroom": by_showroom,
        "lifetime_earned": round(lifetime_earned, 2),
        "lifetime_redeemed": round(lifetime_redeemed, 2),
    }



@router.get("/credit-liability/by-showroom")
async def get_credit_liability_by_showroom(
    current_user: dict = Depends(get_current_user),
):
    """Per-showroom trade-credit liability snapshot.

    For each showroom we report:
      - lifetime_earned: total credit issued from sales at this showroom
      - lifetime_redeemed: total credit redeemed at this showroom
      - liability: max(0, earned - redeemed) — money customers can still
        come back and spend that was generated here
      - earn_redeem_ratio: redeemed / earned (1.0 = fully recycled,
        <0.5 = poor turnover, dead inventory of someone else's money)
      - active_traders: distinct trade accounts with a transaction here

    Reads from the same `credit_transactions` collection used by the
    per-trader history view. Showroom info is back-filled from the
    linked invoice for legacy rows (pre-24 Feb 2026) so the totals
    are accurate even before today's stamping change ships.
    """
    if not can_access_epos(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()

    # Pull ALL transactions in one pass (these are small docs). We can
    # iterate locally because we need to back-fill missing showroom_name
    # from the linked invoice — that's awkward in a single aggregate.
    txns = await db.credit_transactions.find(
        {},
        {"_id": 0, "amount": 1, "type": 1, "trade_account_number": 1,
         "showroom_name": 1, "showroom_id": 1, "invoice_id": 1},
    ).to_list(100000)

    # Build invoice→showroom map for back-fill of legacy txns
    missing_inv_ids = list({t.get("invoice_id") for t in txns if not t.get("showroom_name") and t.get("invoice_id")})
    inv_map = {}
    if missing_inv_ids:
        async for inv in db.invoices.find(
            {"id": {"$in": missing_inv_ids}},
            {"_id": 0, "id": 1, "showroom_id": 1, "showroom_name": 1},
        ):
            inv_map[inv["id"]] = inv

    EARN_TYPES = {"earned_in_store", "earned_online", "reapplied_earned_in_store"}
    REDEEM_TYPES = {"redeemed_in_store", "redeemed_online", "reapplied_redeemed_in_store"}
    REVERSE_TYPES = {
        "reversed_earned_in_store", "reversed_earned_via_refund",
        "reversed_redeemed_in_store", "reversed_redeemed_via_refund",
    }

    per_showroom: dict = {}
    for t in txns:
        # Back-fill from linked invoice when needed
        name = t.get("showroom_name")
        if not name:
            inv = inv_map.get(t.get("invoice_id"))
            if inv:
                name = inv.get("showroom_name")
        key = name or "Unknown / Legacy"

        bucket = per_showroom.setdefault(key, {
            "showroom_name": key,
            "lifetime_earned": 0.0,
            "lifetime_redeemed": 0.0,
            "reversed_total": 0.0,
            "traders": set(),
            "transaction_count": 0,
        })
        amt = float(t.get("amount") or 0)
        ttype = (t.get("type") or "").lower()
        bucket["transaction_count"] += 1
        if t.get("trade_account_number"):
            bucket["traders"].add(t["trade_account_number"])
        if ttype in EARN_TYPES:
            bucket["lifetime_earned"] += amt
        elif ttype in REDEEM_TYPES:
            # `amount` is stored negative on redemptions, so absolute it
            bucket["lifetime_redeemed"] += abs(amt)
        elif ttype in REVERSE_TYPES:
            bucket["reversed_total"] += amt

    rows = []
    total_liability = 0.0
    for r in per_showroom.values():
        earned = round(r["lifetime_earned"], 2)
        redeemed = round(r["lifetime_redeemed"], 2)
        # Reversed credit-earns are negative (they subtract from earn);
        # reversed-redeems are positive (they add back to balance) — net
        # them into the appropriate side for honest accounting.
        net_earned = round(earned + r["reversed_total"], 2)  # reversed_total already negative for earns
        liability = round(max(0.0, net_earned - redeemed), 2)
        ratio = round(redeemed / earned, 3) if earned > 0 else None
        rows.append({
            "showroom_name": r["showroom_name"],
            "lifetime_earned": earned,
            "lifetime_redeemed": redeemed,
            "net_earned": net_earned,
            "liability": liability,
            "earn_redeem_ratio": ratio,
            "active_traders": len(r["traders"]),
            "transaction_count": r["transaction_count"],
        })
        total_liability += liability

    rows.sort(key=lambda r: r["liability"], reverse=True)
    return {
        "rows": rows,
        "total_liability": round(total_liability, 2),
        "showroom_count": len(rows),
    }

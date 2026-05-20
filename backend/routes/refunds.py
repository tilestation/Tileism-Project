"""
Refund management routes
"""
import os
import uuid
import logging
import hmac
import hashlib

logger = logging.getLogger(__name__)

from datetime import datetime, timezone, timedelta
from typing import Optional, List
from fastapi import APIRouter, HTTPException, Depends, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from config import get_db
from services import get_current_user, is_admin_user, log_audit

router = APIRouter(prefix="/refunds", tags=["Refunds"])


# ─── Approval-token helpers ─────────────────────────────────────────
# Magic-link tokens for the no-invoice-refund approval emails. We use a
# simple HMAC-SHA256 signature over `{request_id}:{action}` so the link
# is unforgeable without the JWT secret. Tokens are NOT replay-protected
# beyond the request lifecycle (one-shot use enforced by the request's
# status field flipping from `pending`).
APPROVAL_SECRET = os.environ.get("JWT_SECRET", "your-secret-key-change-in-production")
APPROVAL_TTL = timedelta(days=7)


def _sign_approval_token(request_id: str, action: str) -> str:
    """Return a short HMAC token tying a request to an action."""
    msg = f"{request_id}:{action}".encode()
    sig = hmac.new(APPROVAL_SECRET.encode(), msg, hashlib.sha256).hexdigest()
    return sig[:32]  # truncate — 128 bits is plenty for one-shot links


def _verify_approval_token(request_id: str, action: str, token: str) -> bool:
    expected = _sign_approval_token(request_id, action)
    return hmac.compare_digest(expected, token or "")


async def _create_refund_approval_request(input, current_user) -> dict:
    """Park a no-invoice refund as `pending` in `refund_approval_requests`.

    Returns the inserted document so the caller can email super admins.
    The full RefundCreate payload is serialised on the doc so the
    magic-link handler can rebuild the exact same RefundCreate later
    and replay it through the normal refund pipeline.
    """
    db = get_db()
    request_id = str(uuid.uuid4())
    request_doc = {
        "id": request_id,
        "status": "pending",
        "requested_by": current_user["email"],
        "requested_by_role": current_user.get("role"),
        "requested_at": datetime.now(timezone.utc).isoformat(),
        "expires_at": (datetime.now(timezone.utc) + APPROVAL_TTL).isoformat(),
        # Full payload, ready to feed back into create_refund on approve
        "payload": input.model_dump(),
        # Magic-link tokens — one per action so approve/deny are
        # cryptographically distinct (clicking the wrong button can't
        # accidentally trigger the other action).
        "approve_token": _sign_approval_token(request_id, "approve"),
        "deny_token": _sign_approval_token(request_id, "deny"),
    }
    await db.refund_approval_requests.insert_one(request_doc)

    await log_audit(
        action="REFUND_APPROVAL_REQUESTED",
        entity_type="refund_approval_request",
        user=current_user,
        entity_id=request_id,
        entity_name=input.refund_no,
        after_data={
            "refund_no": input.refund_no,
            "net_refund": (input.gross_total or 0) - (input.restocking_fee or 0),
            "reason": input.no_invoice_reason,
        },
        details=(
            f"No-invoice refund approval requested: {input.refund_no} "
            f"(£{(input.gross_total or 0):.2f})"
        ),
    )
    return request_doc


async def _email_approval_request(request_doc: dict) -> None:
    """Email all super admins with one-click Approve / Deny buttons."""
    try:
        from services.email import send_super_admin_alert, COMPANY_WEBSITE
        p = request_doc["payload"]
        # Build BOTH magic links — embedded directly into the HTML so
        # the admin only has to click once.
        approve_url = (
            f"{COMPANY_WEBSITE.rstrip('/')}"
            f"/api/refunds/approval/{request_doc['id']}/approve?token={request_doc['approve_token']}"
        )
        deny_url = (
            f"{COMPANY_WEBSITE.rstrip('/')}"
            f"/api/refunds/approval/{request_doc['id']}/deny?token={request_doc['deny_token']}"
        )
        net_refund = float((p.get("gross_total") or 0) - (p.get("restocking_fee") or 0))
        await send_super_admin_alert(
            title="Refund needs your approval",
            summary=(
                f"<strong>{request_doc['requested_by']}</strong> is requesting "
                f"to issue a refund <strong>without a linked original invoice</strong>. "
                f"Nothing has been refunded yet — please review and click <strong>Approve</strong> "
                f"only if this is legitimate. Clicking <strong>Deny</strong> rejects the "
                f"request and no refund is issued."
            ),
            fields=[
                ("Refund ref", f"<strong>{p.get('refund_no') or '—'}</strong>"),
                ("Amount", f"<strong>£{net_refund:.2f}</strong> via {p.get('refund_method') or '—'}"),
                ("Customer", f"{p.get('customer_name') or '—'}<br><span style='color:#737373;font-size:12px;'>{p.get('customer_phone') or '—'}</span>"),
                ("Showroom", p.get("showroom_name") or "—"),
                ("Requested by", f"<strong>{request_doc['requested_by']}</strong> ({request_doc.get('requested_by_role') or '—'})"),
                ("Reason", p.get("no_invoice_reason") or "—"),
                ("Items", f"{len(p.get('line_items') or [])} line item(s)"),
                ("Requested at", request_doc["requested_at"]),
                # ── Approval buttons rendered side-by-side ──
                ("Action", (
                    f'<a href="{approve_url}" '
                    f'style="display:inline-block;padding:11px 22px;background:#15803d;'
                    f'color:#fff;text-decoration:none;border-radius:8px;font-weight:600;'
                    f'font-size:14px;margin-right:8px;">✓ Approve &amp; Process</a>'
                    f'<a href="{deny_url}" '
                    f'style="display:inline-block;padding:11px 22px;background:#b91c1c;'
                    f'color:#fff;text-decoration:none;border-radius:8px;font-weight:600;'
                    f'font-size:14px;">✗ Deny</a>'
                )),
            ],
            # Use the deeper "Review in Admin" CTA as a fallback for
            # email clients that strip inline buttons.
            cta_label="Open Admin",
            cta_path="/admin/epos?tab=refund-history",
            accent_colour="#b45309",
            icon="🛑",
            subject_prefix="[Tile Station] Action required —",
            footer_note=(
                "Approval link expires in 7 days. If you didn't expect this email, "
                "click Deny and contact the requester immediately."
            ),
        )
    except Exception as e:  # pragma: no cover — never raise from a fire-and-forget
        logger.warning("send_super_admin_alert (approval-request) failed: %s", e)


async def _process_approved_refund(request_doc: dict, approver_email: str):
    """Replay the stored RefundCreate payload through the normal refund
    pipeline now that a Super Admin has approved it via magic link.

    Returns the saved refund_dict on success. Raises on failure (e.g.
    the refund_no has been used in the meantime, or an item is gone).
    """
    db = get_db()
    p = request_doc["payload"]

    # Defensive: refund_no may have collided with one created while the
    # request sat in the inbox. If so, fail loudly so the approver knows.
    if await db.refunds.find_one({"refund_no": p.get("refund_no")}, {"_id": 0, "id": 1}):
        raise RuntimeError(
            f"Refund {p.get('refund_no')} was already issued. Cannot replay an approved request."
        )

    # Restore stock (mirrors the main path)
    for raw_item in (p.get("line_items") or []):
        pid = (raw_item.get("product_id") or "").strip()
        qty = int(raw_item.get("quantity") or 0)
        if pid and qty > 0:
            product = await db.products.find_one({"id": pid}, {"_id": 0})
            if product:
                await db.products.update_one(
                    {"id": pid},
                    {"$set": {"stock": product.get("stock", 0) + qty}},
                )

    net_refund = float((p.get("gross_total") or 0) - (p.get("restocking_fee") or 0))
    refund_dict = {
        "id": str(uuid.uuid4()),
        "refund_no": p.get("refund_no"),
        "date": p.get("date"),
        "time": p.get("time"),
        "original_invoice_no": p.get("original_invoice_no"),
        "original_invoice_id": p.get("original_invoice_id"),
        "customer_name": p.get("customer_name"),
        "customer_phone": p.get("customer_phone"),
        "customer_email": p.get("customer_email"),
        "customer_address": p.get("customer_address"),
        "notes": p.get("notes"),
        "sales_person": p.get("sales_person"),
        "staff_id": None,
        "staff_name": None,
        "refund_method": p.get("refund_method"),
        "refund_type": p.get("refund_type"),
        "showroom_id": p.get("showroom_id"),
        "showroom_name": p.get("showroom_name"),
        "line_items": p.get("line_items") or [],
        "subtotal": p.get("subtotal"),
        "vat": p.get("vat"),
        "gross_total": p.get("gross_total"),
        "restocking_fee": p.get("restocking_fee") or 0,
        "net_refund": net_refund,
        "status": "completed",
        "created_by": request_doc.get("requested_by"),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "no_invoice_override": True,
        "no_invoice_reason": (p.get("no_invoice_reason") or "").strip(),
        "no_invoice_approved_by": approver_email,
        "no_invoice_approved_at": datetime.now(timezone.utc).isoformat(),
        "no_invoice_request_id": request_doc["id"],
    }
    await db.refunds.insert_one(refund_dict)

    # Reverse trade credit proportionally (idempotent helper, no-ops on
    # no-invoice refunds because there's no original invoice to bind to)
    try:
        await reverse_credits_for_refund(db, refund_dict)
    except Exception as e:
        logger.warning("reverse_credits_for_refund (post-approval) failed: %s", e)

    await log_audit(
        action="CREATE",
        entity_type="refund",
        user={"email": approver_email, "name": approver_email},
        entity_id=refund_dict["id"],
        entity_name=refund_dict["refund_no"],
        after_data={
            "refund_no": refund_dict["refund_no"],
            "net_refund": refund_dict["net_refund"],
            "no_invoice_override": True,
            "no_invoice_approved_by": approver_email,
            "no_invoice_request_id": request_doc["id"],
        },
        details=(
            f"No-invoice refund {refund_dict['refund_no']} (£{net_refund:.2f}) "
            f"approved via email magic link by {approver_email}"
        ),
    )
    return refund_dict


# `_approval_result_page` is defined further down — Python resolves
# names at call time, so the magic-link routes below can use it.

@router.get("/approval/{request_id}/{action}", response_class=HTMLResponse)
async def handle_refund_approval(
    request_id: str,
    action: str,
    request: Request,
):
    """Approve or deny a parked no-invoice refund via the magic link."""
    if action not in ("approve", "deny"):
        return _approval_result_page(
            success=False,
            title="Invalid action",
            message="The link in your email is malformed. Please return to admin and re-issue the request.",
        )

    token = (request.query_params.get("token") or "").strip()
    if not _verify_approval_token(request_id, action, token):
        return _approval_result_page(
            success=False,
            title="Invalid or tampered link",
            message="This approval link is not valid. It may have been copied incorrectly, expired, or been altered.",
        )

    db = get_db()
    req = await db.refund_approval_requests.find_one({"id": request_id}, {"_id": 0})
    if not req:
        return _approval_result_page(
            success=False,
            title="Request not found",
            message="This approval request no longer exists. It may have already been processed or expired.",
        )

    # Replay / re-click protection
    if req.get("status") != "pending":
        already = req.get("status")
        return _approval_result_page(
            success=already == "approved",
            title=f"Already {already}",
            message=f"This refund request has already been {already} (on {req.get('decided_at') or '—'}).",
            secondary=f"Decided by: {req.get('decided_by') or '—'}",
        )

    # Expiry
    try:
        expires_at = datetime.fromisoformat(req.get("expires_at"))
        if datetime.now(timezone.utc) > expires_at:
            await db.refund_approval_requests.update_one(
                {"id": request_id},
                {"$set": {"status": "expired", "decided_at": datetime.now(timezone.utc).isoformat()}},
            )
            return _approval_result_page(
                success=False,
                title="Link expired",
                message="This approval request expired after 7 days. Please ask the requester to start a new one.",
            )
    except (TypeError, ValueError):
        pass

    decided_at = datetime.now(timezone.utc).isoformat()
    # In magic-link world we don't have a logged-in user — but we know
    # the action came from a Super Admin's inbox because only super
    # admins receive the approval email. We record "<via email magic link>"
    # as the approver email so the audit trail isn't blank.
    approver_email = "super_admin@magic-link"

    if action == "deny":
        await db.refund_approval_requests.update_one(
            {"id": request_id},
            {"$set": {
                "status": "denied",
                "decided_at": decided_at,
                "decided_by": approver_email,
                "decided_action": "deny",
            }},
        )
        await log_audit(
            action="REFUND_APPROVAL_DENIED",
            entity_type="refund_approval_request",
            user={"email": approver_email, "name": "Super Admin (magic link)"},
            entity_id=request_id,
            entity_name=req["payload"].get("refund_no") or request_id,
            details=f"Refund request {req['payload'].get('refund_no')} denied via email magic link",
        )
        # Inform the requester
        try:
            from services.email import send_email_notification
            await send_email_notification(
                to_emails=[req["requested_by"]],
                subject=f"[Tile Station] Refund denied — {req['payload'].get('refund_no')}",
                html_content=(
                    f"<p>Your refund request <strong>{req['payload'].get('refund_no')}</strong> "
                    f"was denied by a Super Admin. Please contact your manager if you believe "
                    f"this is in error.</p>"
                ),
            )
        except Exception as e:
            logger.warning("requester denied-notification failed: %s", e)

        return _approval_result_page(
            success=False,
            title="Refund denied",
            message=f"Refund request {req['payload'].get('refund_no')} has been marked as denied. No money has been refunded and no stock has changed.",
            secondary=f"Requested by: {req.get('requested_by')}",
        )

    # action == "approve" — actually process the refund
    try:
        refund_dict = await _process_approved_refund(req, approver_email)
    except Exception as e:
        logger.exception("Refund approval processing failed for %s", request_id)
        return _approval_result_page(
            success=False,
            title="Could not process refund",
            message=f"The approval was valid but the refund could not be processed: {e}",
            secondary="Please open Admin and process this refund manually.",
        )

    await db.refund_approval_requests.update_one(
        {"id": request_id},
        {"$set": {
            "status": "approved",
            "decided_at": decided_at,
            "decided_by": approver_email,
            "decided_action": "approve",
            "refund_id": refund_dict["id"],
        }},
    )

    # Send the "refund completed" email (this is the SECOND email per
    # request — the FIRST was the approval-request email).
    import asyncio as _asyncio
    async def _email_completed():
        try:
            from services.email import send_super_admin_alert
            await send_super_admin_alert(
                title="No-invoice refund processed",
                summary=(
                    "A Super Admin approval (via the email magic link) has just "
                    "been used to issue the refund below. Money is out and stock "
                    "has been restored. This is your audit confirmation."
                ),
                fields=[
                    ("Refund ref", f"<strong>{refund_dict['refund_no']}</strong>"),
                    ("Amount", f"<strong>£{refund_dict['net_refund']:.2f}</strong> via {refund_dict.get('refund_method') or '—'}"),
                    ("Customer", f"{refund_dict.get('customer_name') or '—'}<br><span style='color:#737373;font-size:12px;'>{refund_dict.get('customer_phone') or '—'}</span>"),
                    ("Showroom", refund_dict.get("showroom_name") or "—"),
                    ("Originally requested by", req.get("requested_by") or "—"),
                    ("Approved at", decided_at),
                    ("Reason", refund_dict.get("no_invoice_reason") or "—"),
                ],
                cta_label="Open Refund History",
                cta_path="/admin/epos?tab=refund-history",
                accent_colour="#15803d",
                icon="✅",
                subject_prefix="[Tile Station]",
                footer_note="This is the post-approval confirmation. It complements the earlier 'approval required' email.",
            )
        except Exception as e:
            logger.warning("completion email failed: %s", e)
    try:
        _asyncio.create_task(_email_completed())
    except RuntimeError:
        pass

    return _approval_result_page(
        success=True,
        title="Refund approved",
        message=(
            f"Refund {refund_dict['refund_no']} (£{refund_dict['net_refund']:.2f}) "
            f"has been issued and stock restored."
        ),
        secondary=(
            f"Originally requested by {req.get('requested_by')} · "
            f"Reason: {refund_dict.get('no_invoice_reason')}"
        ),
    )


@router.get("/pending-approvals")
async def list_pending_approvals(current_user: dict = Depends(get_current_user)):
    """Return all pending no-invoice refund approval requests (super admin only).

    Useful for a future "Pending Approvals" admin widget so super admins
    can also approve/deny from inside the app, not only from the email.
    """
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super Admin only")
    db = get_db()
    cursor = db.refund_approval_requests.find(
        {"status": "pending"},
        {"_id": 0, "approve_token": 0, "deny_token": 0},  # never expose tokens to UI
    ).sort("requested_at", -1).limit(50)
    rows = await cursor.to_list(50)
    return {"count": len(rows), "requests": rows}


def _approval_result_page(*, success: bool, title: str, message: str, secondary: str = "") -> HTMLResponse:
    """Render a self-contained HTML response page for magic-link results.

    No frontend route needed — the email link lands directly here. Kept
    deliberately simple so it renders on every device and email-tracker
    redirect path.
    """
    colour = "#15803d" if success else "#b91c1c"
    icon = "✓" if success else "✗"
    return HTMLResponse(content=f"""\
<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>{title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f5f5f4;color:#111;margin:0;padding:48px 16px;}}.card{{max-width:480px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:32px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.04)}}.icon{{width:64px;height:64px;border-radius:50%;background:{colour};color:#fff;font-size:36px;line-height:64px;margin:0 auto 18px;}}h1{{font-size:22px;margin:0 0 8px;color:{colour}}}p{{font-size:15px;line-height:1.5;color:#374151;margin:0 0 14px}}a.btn{{display:inline-block;margin-top:18px;padding:11px 22px;background:#111;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px}}small{{color:#737373;font-size:12px;display:block;margin-top:14px}}</style>
</head><body><div class="card">
<div class="icon">{icon}</div>
<h1>{title}</h1>
<p>{message}</p>
{f'<p style="color:#737373;font-size:13px;">{secondary}</p>' if secondary else ''}
<a class="btn" href="/admin/epos?tab=refund-history">Open Refund History</a>
<small>Tile Station Admin — this is an automated response page.</small>
</div></body></html>""")


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

    # Use the ORIGINAL (pre-reversal) amount for ratio math so each refund
    # reverses a true `refund_amount / invoice_gross` slice, regardless of
    # how many prior refunds already chipped away at the live field.
    # `*_original` is set on the first reversal (see update at the bottom of
    # this function); on legacy invoices that pre-date this change we fall
    # back to the current `trade_credit_earned` field, which is still equal
    # to the original because no prior reversal touched it.
    earned_total = float(
        invoice.get("trade_credit_earned_original")
        if invoice.get("trade_credit_earned_original") is not None
        else (invoice.get("trade_credit_earned") or 0)
    )
    redeemed_total = float(
        invoice.get("credit_redeemed_original")
        if invoice.get("credit_redeemed_original") is not None
        else (invoice.get("credit_redeemed") or 0)
    )

    # Cumulative cap — earlier partial refunds may have already reversed some
    already_earned_reversed = float(invoice.get("credit_earned_already_reversed") or 0)
    already_redeemed_reversed = float(invoice.get("credit_redeemed_already_reversed") or 0)

    earned_to_reverse = round(min(earned_total * ratio, earned_total - already_earned_reversed), 2)
    redeemed_to_refund = round(min(redeemed_total * ratio, redeemed_total - already_redeemed_reversed), 2)
    # Clamp to non-negative — guards against float jitter / over-reversed legacy rows.
    earned_to_reverse = max(0.0, earned_to_reverse)
    redeemed_to_refund = max(0.0, redeemed_to_refund)

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
            # The reversal happens wherever the REFUND is issued, not where
            # the original credit was earned — those can be different
            # showrooms. We stamp the refund's showroom so the credit
            # history view shows the reversal at the till that processed it.
            "channel": "in_store",
            "showroom_id": refund_dict.get("showroom_id"),
            "showroom_name": refund_dict.get("showroom_name"),
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
            "channel": "in_store",
            "showroom_id": refund_dict.get("showroom_id"),
            "showroom_name": refund_dict.get("showroom_name"),
            "description": f"Refunded credit redemption from invoice {invoice_no} via refund {refund_no} ({(ratio*100):.1f}% of invoice)",
            "created_at": now,
        })
        summary["redeemed_reversed"] = redeemed_to_refund

    # Stamp cumulative trackers on the invoice so subsequent refunds know
    # what's already been reversed. We DON'T set `credits_reversed=true`
    # (which is the all-or-nothing flag used by delete-flow) — partial
    # refunds use this incremental counter instead.
    #
    # ALSO retroactively decrement `trade_credit_earned` / `credit_redeemed`
    # so the field that drives the printed invoice PDF / UI always shows
    # the NET amount the trader actually keeps (24 Feb 2026 — user request:
    # "Credit earned should reflect the final amount paid after refund").
    # `*_original` is preserved on the first reversal for accurate ratio
    # math on any future partial refunds.
    inc_ops = {
        "credit_earned_already_reversed": earned_to_reverse,
        "credit_redeemed_already_reversed": redeemed_to_refund,
        "trade_credit_earned": -earned_to_reverse,
        "credit_redeemed": -redeemed_to_refund,
    }
    set_ops = {}
    if invoice.get("trade_credit_earned_original") is None:
        set_ops["trade_credit_earned_original"] = earned_total
    if invoice.get("credit_redeemed_original") is None:
        set_ops["credit_redeemed_original"] = redeemed_total

    update_doc = {"$inc": inc_ops}
    if set_ops:
        update_doc["$set"] = set_ops

    await db.invoices.update_one(
        {"id": inv_id},
        update_doc,
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
    #      trail, and email super admins with a deep link straight
    #      to the refund history page so they can review immediately
    #      from their inbox (Super Admin isn't physically in showrooms).
    has_invoice_link = bool(
        (input.original_invoice_id or "").strip()
        or (input.original_invoice_no or "").strip()
    )

    # ─── NO-INVOICE → ALWAYS GO THROUGH MAGIC-LINK APPROVAL ──────────
    # 24 Feb 2026 (user follow-up screenshot 19:08): the previous flow
    # let a logged-in Super Admin process a no-invoice refund instantly
    # and only emailed *after* the money was already out. The user wants
    # an "approve-first" workflow:
    #
    #   1. Anyone (staff or super_admin) can REQUEST a no-invoice refund
    #   2. The refund is parked in `refund_approval_requests` (status=pending)
    #      with the full payload. No stock change, no money out yet.
    #   3. ALL super admins get an email with two magic-link buttons:
    #      "Approve & Process" + "Deny". Either button is one-click —
    #      no separate login required (HMAC-signed token gates the URL).
    #   4. Clicking "Approve" executes the refund (calls the rest of
    #      this function via _process_validated_refund). Sends the
    #      existing "refund completed" email afterwards.
    #   5. Clicking "Deny" marks the request as denied; nothing happens
    #      to stock or refunds collection.
    #
    # Requestor still has to supply a reason (≥6 chars) up-front — that
    # text travels in the approval email so the approver knows what
    # they're being asked to sign off on.
    if not has_invoice_link:
        if not (input.no_invoice_reason or "").strip() or len((input.no_invoice_reason or "").strip()) < 6:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Refunds without an original invoice require a written "
                    "reason of at least 6 characters. This reason will be "
                    "sent to Super Admins for approval."
                ),
            )
        if not input.line_items:
            raise HTTPException(status_code=400, detail="Refund must have at least one line item")

        # Park the request — don't touch stock or refunds yet.
        request_doc = await _create_refund_approval_request(input, current_user)

        # Fire the approval email. Fire-and-forget so a slow email
        # provider can't lock up the checkout flow.
        import asyncio as _asyncio
        try:
            _asyncio.create_task(_email_approval_request(request_doc))
        except RuntimeError:
            pass  # no event loop (test contexts)

        # 202 Accepted — refund is queued, not done.
        return {
            "message": "Approval request emailed to Super Admins. The refund will be processed as soon as a Super Admin clicks the approve link.",
            "status": "pending_approval",
            "request_id": request_doc["id"],
            "approval_required": True,
        }

    # Has an invoice link → drop the no-invoice override flags (they're
    # nonsensical here) and proceed with the normal refund processing.
    input.no_invoice_override = False
    input.no_invoice_reason = None

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
        # No-invoice-override audit fields are written by the magic-link
        # approval handler (see `_process_approved_refund`), NOT by this
        # path. Reaching here always means an invoice WAS linked, so
        # these fields stay null.
        "no_invoice_override": False,
        "no_invoice_reason": None,
        "no_invoice_approved_by": None,
        "no_invoice_approved_at": None,
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

    # NOTE — the no-invoice-override "completed" email is now sent from
    # `_process_approved_refund` (the magic-link approval handler), not
    # from here. By the time execution reaches this point, the refund
    # is guaranteed to be against a linked invoice and no email is
    # needed.

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

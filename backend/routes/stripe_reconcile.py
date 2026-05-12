"""
Stripe Reconciliation + Orphan Order Recovery
─────────────────────────────────────────────
The 2 May 2026 incident exposed a silent failure mode:

  • Customer reaches sample checkout → backend creates `sample_orders`
    row with status='pending' + stripe_session_id
  • Customer pays on Stripe → Stripe captures the money
  • Stripe redirects back to /shop/tile-sample-success — IF the customer
    waits for the redirect, the success page hits
    `/api/samples/checkout/status/{session_id}` which flips the order to
    paid AND fires the confirmation email.
  • IF the customer closes the tab after paying, OR the redirect fails
    (network blip, browser, etc.), the order stays at status='pending'
    forever. Money is in the merchant's Stripe balance. Customer is
    confused, no email goes out, dispatch never happens.

This module solves it in three layers:

  1. AUTO-RECOVERY scan (idempotent) — iterates over every pending order
     with a `stripe_session_id` from the last N days and re-queries
     Stripe. Any session that Stripe says is `paid` gets flipped server-
     side, customer gets a "we're so sorry, samples on their way" email,
     admin gets a Telegram alert.

  2. ORPHAN LIST endpoint — returns every still-orphan order joined with
     the abandoned-basket capture (which holds the delivery address the
     frontend collected before checkout). Lets the admin see name +
     email + address + Stripe payment ID at a glance.

  3. DAILY CRON — runs the auto-recovery scan once a day and emails the
     admin if anything was recovered or any orphan remains.
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Optional

import stripe
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from config import get_db
from services import get_current_user, is_admin_user

logger = logging.getLogger(__name__)
router = APIRouter()

STRIPE_API_KEY = os.environ.get("STRIPE_API_KEY")
if STRIPE_API_KEY:
    stripe.api_key = STRIPE_API_KEY


# =============================================================================
# CORE — recover a single order by session_id
# =============================================================================

async def _send_recovery_email(order: dict, *, was_recovered: bool) -> None:
    """Fire a "sorry, your samples are on the way" email after we auto-
    recover a stuck order. Imports lazily because services.email is
    fairly heavyweight and may not be configured in every env."""
    try:
        from services import email as email_svc
        send_fn = getattr(email_svc, "send_sample_order_confirmation", None) or \
                  getattr(email_svc, "send_simple_email_if_possible", None)
        if not send_fn:
            return
        to = order.get("customer_email") or order.get("email")
        if not to:
            return
        subject = (
            "Your sample order — samples on their way (apologies for the silence)"
            if was_recovered
            else f"Sample order #{order.get('order_number') or order.get('id')} — confirmation"
        )
        body = (
            f"Hi {order.get('customer_name') or 'there'},\n\n"
            "Apologies — there was a glitch on our checkout that meant we "
            "didn't see your sample order even though your card was charged. "
            "We've found it now and your samples are being dispatched today.\n\n"
            f"Order: {order.get('order_number') or order.get('id')}\n"
            f"Paid: £{float(order.get('total') or 0):.2f}\n\n"
            "If you'd prefer a refund instead, just reply to this email and "
            "we'll process it within the hour.\n\n"
            "Thank you for your patience.\nTile Station"
        )
        await asyncio.to_thread(send_fn, to, subject, body) if not asyncio.iscoroutinefunction(send_fn) else await send_fn(to, subject, body)
    except Exception:
        logger.exception("Recovery email failed (non-fatal)")


async def recover_order_by_session(
    db, *, session_id: str, source: str = "manual",
    send_email: bool = True, fire_alerts: bool = True,
) -> dict:
    """The single function that re-checks Stripe and recovers ONE order.

    Returns a dict shaped like:
      {"order_id", "before_status", "after_status", "paid_at",
       "stripe_payment_status", "amount_paid", "recovered": bool}

    Idempotent: safe to call repeatedly.
    """
    if not STRIPE_API_KEY:
        return {"error": "STRIPE_API_KEY not configured"}

    # The order may live in either sample_orders or shop_orders.
    coll_name = None
    order = await db.sample_orders.find_one({"stripe_session_id": session_id}, {"_id": 0})
    if order:
        coll_name = "sample_orders"
    else:
        order = await db.shop_orders.find_one({"stripe_session_id": session_id}, {"_id": 0})
        if order:
            coll_name = "shop_orders"
    if not order:
        return {"error": "order_not_found", "session_id": session_id}

    before_status = order.get("status")
    if before_status in ("paid", "shipped", "delivered", "completed"):
        return {
            "session_id": session_id,
            "order_id": order.get("id"),
            "before_status": before_status,
            "after_status": before_status,
            "recovered": False,
            "reason": "already_paid",
        }

    try:
        sess = await asyncio.to_thread(stripe.checkout.Session.retrieve, session_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Stripe retrieve failed for %s: %s", session_id, exc)
        return {"error": f"stripe_retrieve_failed: {exc}", "session_id": session_id}

    payment_status = (getattr(sess, "payment_status", "") or "").lower()
    amount_total = (getattr(sess, "amount_total", 0) or 0) / 100.0
    customer_email = getattr(sess, "customer_email", None) or order.get("customer_email")

    if payment_status != "paid":
        # Stripe says not paid yet. Nothing to recover — likely a true
        # abandoned cart.
        return {
            "session_id": session_id,
            "order_id": order.get("id"),
            "before_status": before_status,
            "after_status": before_status,
            "stripe_payment_status": payment_status,
            "amount_paid": amount_total,
            "recovered": False,
            "reason": "stripe_not_paid",
        }

    # Flip the order to paid. Idempotent at the DB layer via `before_status`
    # check above and the conservative $set.
    now_iso = datetime.now(timezone.utc).isoformat()
    update = {
        "status": "paid",
        "paid_at": now_iso,
        "auto_recovered": True,
        "auto_recovered_at": now_iso,
        "auto_recovered_source": source,
    }
    if customer_email and not order.get("customer_email"):
        update["customer_email"] = customer_email
    await db[coll_name].update_one({"stripe_session_id": session_id}, {"$set": update})

    # Sweep any abandoned-basket capture for this email so it doesn't end
    # up in tomorrow's apology-email batch.
    if customer_email:
        try:
            await db.abandoned_sample_baskets.update_many(
                {"customer_email": customer_email.lower()},
                {"$set": {"status": "recovered", "recovered_at": now_iso}},
            )
        except Exception:
            pass

    # Audit log
    try:
        await db.audit_logs.insert_one({
            "type": "order_auto_recovered",
            "order_id": order.get("id"),
            "session_id": session_id,
            "collection": coll_name,
            "amount_paid": amount_total,
            "customer_email": customer_email,
            "source": source,
            "before_status": before_status,
            "after_status": "paid",
            "created_at": now_iso,
        })
    except Exception:
        pass

    if send_email:
        await _send_recovery_email({**order, **update}, was_recovered=True)

    if fire_alerts:
        try:
            from services import telegram as tg
            send_fn = getattr(tg, "fire_and_forget", None)
            if send_fn:
                send_fn(
                    "order_recovered",
                    {
                        "order_id": order.get("id"),
                        "order_number": order.get("order_number"),
                        "email": customer_email,
                        "amount": amount_total,
                        "source": source,
                    },
                )
        except Exception:
            pass

    return {
        "session_id": session_id,
        "order_id": order.get("id"),
        "before_status": before_status,
        "after_status": "paid",
        "stripe_payment_status": payment_status,
        "amount_paid": amount_total,
        "paid_at": now_iso,
        "recovered": True,
    }


# =============================================================================
# BATCH — scan every pending order in the last N days and recover all paid
# =============================================================================

async def run_auto_recovery_scan(
    *, days_back: int = 30, dry_run: bool = False, source: str = "cron",
) -> dict:
    """Background-safe batch recovery. Iterates pending orders with a
    Stripe session_id and triggers recover_order_by_session for each."""
    db = get_db()
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days_back)).isoformat()
    pending_query = {
        "status": "pending",
        "stripe_session_id": {"$exists": True, "$nin": [None, ""]},
        "created_at": {"$gte": cutoff},
    }
    summary = {
        "scanned": 0, "recovered": 0, "still_pending": 0,
        "errors": 0, "details": [],
    }

    for coll in ("sample_orders", "shop_orders"):
        async for order in db[coll].find(pending_query, {"_id": 0}):
            summary["scanned"] += 1
            sid = order.get("stripe_session_id")
            if dry_run:
                summary["details"].append({"order_id": order.get("id"), "session_id": sid, "dry_run": True})
                continue
            try:
                res = await recover_order_by_session(
                    db, session_id=sid, source=source,
                    send_email=True, fire_alerts=True,
                )
                if res.get("recovered"):
                    summary["recovered"] += 1
                elif res.get("error"):
                    summary["errors"] += 1
                else:
                    summary["still_pending"] += 1
                summary["details"].append(res)
            except Exception as exc:  # noqa: BLE001
                summary["errors"] += 1
                summary["details"].append({"order_id": order.get("id"), "error": str(exc)[:200]})

    return summary


async def run_daily_orphan_alert_tick():
    """Cron entry — runs once daily. Auto-recovers anything Stripe says
    is paid, then emails the admin a digest of remaining orphans."""
    res = await run_auto_recovery_scan(days_back=30, source="daily_cron")
    if res["recovered"] == 0 and res["still_pending"] == 0:
        return  # nothing to report

    # Build admin alert
    try:
        admin_email = os.environ.get("ADMIN_NOTIFY_EMAIL") or os.environ.get("ADMIN_EMAIL")
        if not admin_email:
            return
        body = (
            "Tile Station — daily orphan-order reconciliation\n\n"
            f"Scanned (last 30 days): {res['scanned']}\n"
            f"Auto-recovered to paid: {res['recovered']}\n"
            f"Still pending (no Stripe match): {res['still_pending']}\n"
            f"Errors: {res['errors']}\n\n"
            "View full list: /admin/stripe-reconcile\n"
        )
        from services import email as email_svc
        send_fn = getattr(email_svc, "send_simple_email_if_possible", None)
        if send_fn:
            if asyncio.iscoroutinefunction(send_fn):
                await send_fn(admin_email, "Daily orphan-order report", body)
            else:
                await asyncio.to_thread(send_fn, admin_email, "Daily orphan-order report", body)
    except Exception:
        logger.exception("Daily orphan alert email failed")


# =============================================================================
# ADMIN ENDPOINTS
# =============================================================================

@router.get("/admin/stripe-reconcile/orphans")
async def admin_list_orphans(
    days_back: int = Query(60, ge=1, le=365),
    current_user: dict = Depends(get_current_user),
):
    """Returns every order in pending state that has a Stripe session ID,
    joined with the abandoned-basket capture so the admin sees the
    delivery address inline. Front-end uses this to render the reconcile
    page."""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days_back)).isoformat()
    rows: list[dict] = []
    for coll, kind in (("sample_orders", "sample"), ("shop_orders", "shop")):
        cursor = db[coll].find(
            {
                "status": "pending",
                "stripe_session_id": {"$exists": True, "$nin": [None, ""]},
                "created_at": {"$gte": cutoff},
            },
            {"_id": 0},
        ).sort("created_at", -1)
        async for order in cursor:
            email = (order.get("customer_email") or order.get("email") or "").lower()
            basket = None
            if email:
                basket = await db.abandoned_sample_baskets.find_one(
                    {"customer_email": email}, {"_id": 0},
                )
            address = (basket or {}).get("delivery_address") or {}
            rows.append({
                "order_id": order.get("id"),
                "order_number": order.get("order_number"),
                "kind": kind,
                "collection": coll,
                "customer_name": order.get("customer_name") or (basket or {}).get("customer_name") or "",
                "customer_email": email,
                "customer_phone": order.get("customer_phone") or (basket or {}).get("customer_phone") or "",
                "amount": order.get("total") or order.get("total_amount"),
                "stripe_session_id": order.get("stripe_session_id"),
                "stripe_payment_intent_id": order.get("stripe_payment_intent_id"),
                "delivery_address": address,
                "items": order.get("items") or order.get("sample_items") or [],
                "created_at": order.get("created_at"),
            })
    return {"count": len(rows), "orphans": rows}


@router.post("/admin/stripe-reconcile/scan")
async def admin_recover_all_orphans(
    days_back: int = Query(30, ge=1, le=365),
    dry_run: bool = Query(False),
    current_user: dict = Depends(get_current_user),
):
    """Trigger the full auto-recovery scan on demand. Returns a summary
    of how many were recovered / still pending."""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    res = await run_auto_recovery_scan(
        days_back=days_back, dry_run=dry_run, source="admin_manual",
    )
    return res


class RecoverBody(BaseModel):
    session_id: str = Field(..., min_length=4)


@router.post("/admin/stripe-reconcile/recover-one")
async def admin_recover_one(
    body: RecoverBody,
    current_user: dict = Depends(get_current_user),
):
    """Recover a single orphan by Stripe session_id."""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    return await recover_order_by_session(
        db, session_id=body.session_id, source="admin_single",
    )


class RefundBody(BaseModel):
    payment_intent_id: Optional[str] = None
    session_id: Optional[str] = None
    reason: Optional[str] = "requested_by_customer"


@router.post("/admin/stripe-reconcile/refund")
async def admin_refund(
    body: RefundBody,
    current_user: dict = Depends(get_current_user),
):
    """One-click refund directly via Stripe. Pass either payment_intent_id
    OR session_id (we'll look up the PI from the session)."""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    if not STRIPE_API_KEY:
        raise HTTPException(status_code=500, detail="STRIPE_API_KEY not configured")

    pi_id = body.payment_intent_id
    if not pi_id and body.session_id:
        try:
            sess = await asyncio.to_thread(stripe.checkout.Session.retrieve, body.session_id)
            pi_id = getattr(sess, "payment_intent", None)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=f"Could not resolve PI: {exc}")
    if not pi_id:
        raise HTTPException(status_code=400, detail="Need payment_intent_id or session_id")

    try:
        refund = await asyncio.to_thread(
            stripe.Refund.create,
            payment_intent=pi_id,
            reason=body.reason or "requested_by_customer",
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Stripe refund failed: {exc}")

    # Mark any matching order as refunded
    db = get_db()
    now_iso = datetime.now(timezone.utc).isoformat()
    for coll in ("sample_orders", "shop_orders"):
        await db[coll].update_one(
            {"$or": [
                {"stripe_payment_intent_id": pi_id},
                {"stripe_session_id": body.session_id} if body.session_id else {"stripe_payment_intent_id": pi_id},
            ]},
            {"$set": {"status": "refunded", "refunded_at": now_iso, "stripe_refund_id": refund.id}},
        )

    return {
        "refunded": True,
        "refund_id": refund.id,
        "amount": (refund.amount or 0) / 100.0,
        "status": refund.status,
    }


class MarkFulfilledBody(BaseModel):
    order_id: str = Field(..., min_length=1)
    tracking_number: Optional[str] = None


@router.post("/admin/stripe-reconcile/mark-fulfilled")
async def admin_mark_fulfilled(
    body: MarkFulfilledBody,
    current_user: dict = Depends(get_current_user),
):
    """One-click 'I've packed and posted this' button — marks the order
    as fulfilled and stores the tracking number if provided."""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    now_iso = datetime.now(timezone.utc).isoformat()
    update = {"status": "shipped", "shipped_at": now_iso, "manually_fulfilled": True}
    if body.tracking_number:
        update["tracking_number"] = body.tracking_number
    modified = 0
    for coll in ("sample_orders", "shop_orders"):
        res = await db[coll].update_one({"id": body.order_id}, {"$set": update})
        modified += res.modified_count
    if modified == 0:
        raise HTTPException(status_code=404, detail="Order not found")
    return {"marked": True, "tracking_number": body.tracking_number}

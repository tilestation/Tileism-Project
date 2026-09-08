"""Trade Hub — the one place for everything trade: dashboard KPIs, unified
ledger, manual credit adjustments, credit expiry, engagement nudges and the
per-trader 360 timeline. Reads across the collections trade data lives in:
shop_customers, shop_orders, invoices, refunds, trade_credits,
credit_transactions, whatsapp_queue, sample_orders, cash_quotations,
customer_logins, trade_engagement_log."""
import logging
import uuid
from datetime import datetime, timezone, timedelta
from typing import Optional, List

from fastapi import APIRouter, HTTPException, Depends, Request
from pydantic import BaseModel, Field

from services import get_current_user
from services.trade_engagement import (
    log_event, parse_date, send_credit_expiry_reminder, send_dormant_nudge,
    expire_customer_credit, dormant_cutoff,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/trade-hub", tags=["trade-hub"], dependencies=[Depends(get_current_user)])

DORMANT_DAYS = 60

# Ledger type → human label, and whether it is a "clawback" style movement
LEDGER_LABELS = {
    "earn": "Earned — online order",
    "redeem": "Redeemed — online order",
    "reverse_earn": "Clawed back — online order cancelled/refunded",
    "reverse_redeem": "Refunded to balance — online order cancelled",
    "earned_in_store": "Earned — in-store invoice",
    "redeemed_in_store": "Redeemed — in-store invoice",
    "reversed_earned_in_store": "Clawed back — invoice edited",
    "reversed_redeemed_in_store": "Refunded to balance — invoice edited",
    "reapplied_earned_in_store": "Re-applied — invoice edited",
    "reapplied_redeemed_in_store": "Re-applied redemption — invoice edited",
    "reversed_earned_via_refund": "Clawed back — in-store refund",
    "reversed_redeemed_via_refund": "Refunded to balance — in-store refund",
    "reversed_earned_via_invoice_edit": "Clawed back — invoice edited",
    "manual_adjustment": "Manual adjustment",
    "expired": "Expired",
}


def _require_super_admin(user: dict):
    if (user or {}).get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Super admin only")


def _actor(user: dict) -> str:
    return (user or {}).get("name") or (user or {}).get("email") or "staff"


async def _trader(db, account_id: str) -> dict:
    doc = await db.shop_customers.find_one({"id": account_id, "is_trade": True}, {"_id": 0, "password": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Trade account not found")
    return doc


def _trader_match(trader: dict) -> dict:
    ors = [{"customer_id": trader["id"]}]
    if trader.get("trade_account_number"):
        ors.append({"trade_account_number": trader["trade_account_number"]})
    return {"$or": ors}


def _f(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _ts(v) -> str:
    """Timestamps are stored as ISO strings, but legacy docs hold datetimes."""
    if v is None:
        return ""
    if isinstance(v, datetime):
        return (v if v.tzinfo else v.replace(tzinfo=timezone.utc)).isoformat()
    return str(v)


# ───────────────────────────── showroom IPs ─────────────────────────────
# Public IPs of the showroom computers. A trade sign-up from one of these is
# recorded as "in store" even when nobody is logged into the admin.

SHOWROOM_IPS_DOC = "trade_showroom_ips"


def _request_ip(request) -> str:
    fwd = request.headers.get("x-forwarded-for") or request.headers.get("x-real-ip") or ""
    return fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else "")


async def load_showroom_ips(db) -> list:
    doc = await db.website_settings.find_one({"_id": SHOWROOM_IPS_DOC}, {"_id": 0, "ips": 1})
    return (doc or {}).get("ips") or []


def match_showroom_ip(ips: list, ip: str):
    for entry in ips:
        if isinstance(entry, dict) and (entry.get("ip") or "").strip() == (ip or "").strip():
            return entry
    return None


class ShowroomIp(BaseModel):
    id: Optional[str] = None
    ip: str = Field(..., min_length=3)
    showroom_id: Optional[str] = None
    showroom_name: str = Field(..., min_length=1)
    label: Optional[str] = ""


class ShowroomIps(BaseModel):
    ips: List[ShowroomIp]


@router.get("/my-ip")
async def my_ip(request: Request):
    from server import db
    ip = _request_ip(request)
    hit = match_showroom_ip(await load_showroom_ips(db), ip)
    return {"ip": ip, "matched_showroom": (hit or {}).get("showroom_name")}


@router.get("/showroom-ips")
async def get_showroom_ips():
    from server import db
    return {"ips": await load_showroom_ips(db)}


@router.put("/showroom-ips")
async def save_showroom_ips(body: ShowroomIps, user: dict = Depends(get_current_user)):
    from server import db
    import ipaddress
    now = datetime.now(timezone.utc).isoformat()
    existing = {e.get("id"): e for e in await load_showroom_ips(db) if e.get("id")}
    cleaned, seen = [], set()
    for e in body.ips:
        ip = e.ip.strip()
        try:
            ipaddress.ip_address(ip)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"'{ip}' is not a valid IP address")
        if ip in seen:
            continue
        seen.add(ip)
        prev = existing.get(e.id) or {}
        cleaned.append({
            "id": e.id or str(uuid.uuid4()), "ip": ip, "showroom_id": e.showroom_id,
            "showroom_name": e.showroom_name.strip(), "label": (e.label or "").strip(),
            "added_by": prev.get("added_by") or _actor(user), "added_at": prev.get("added_at") or now,
        })
    await db.website_settings.update_one(
        {"_id": SHOWROOM_IPS_DOC}, {"$set": {"ips": cleaned, "updated_at": now, "updated_by": _actor(user)}}, upsert=True)
    return {"success": True, "ips": cleaned}


# ───────────────────────────── ledger ─────────────────────────────

async def build_ledger(db, trader: dict, limit: int = 500) -> dict:
    match = _trader_match(trader)
    online = await db.trade_credits.find(match, {"_id": 0}).to_list(limit)
    in_store = await db.credit_transactions.find(match, {"_id": 0}).to_list(limit)
    rows = []
    for d in online:
        rows.append({
            "id": d.get("id"), "created_at": d.get("created_at"), "type": d.get("type"),
            "label": LEDGER_LABELS.get(d.get("type"), d.get("type")),
            "amount": _f(d.get("amount")), "channel": "online",
            "reference": d.get("order_number") or d.get("order_id"),
            "description": d.get("description") or "", "actor": d.get("actor"),
        })
    for d in in_store:
        rows.append({
            "id": d.get("id"), "created_at": d.get("created_at"), "type": d.get("type"),
            "label": LEDGER_LABELS.get(d.get("type"), d.get("type")),
            "amount": _f(d.get("amount")),
            "channel": "manual" if d.get("type") in ("manual_adjustment", "expired") else "in_store",
            "reference": d.get("refund_no") or d.get("invoice_no") or d.get("reference"),
            "showroom": d.get("showroom_name"),
            "description": d.get("description") or "", "actor": d.get("actor"),
        })
    rows.sort(key=lambda r: _ts(r.get("created_at")))
    running = 0.0
    for r in rows:
        running = round(running + r["amount"], 2)
        r["running_balance"] = running
    rows.reverse()
    earned = round(sum(r["amount"] for r in rows if r["amount"] > 0 and r["type"] not in ("reverse_redeem", "reversed_redeemed_in_store", "reversed_redeemed_via_refund", "reapplied_redeemed_in_store")), 2)
    redeemed = round(-sum(r["amount"] for r in rows if r["type"] in ("redeem", "redeemed_in_store")), 2)
    clawed = round(-sum(r["amount"] for r in rows if r["amount"] < 0 and r["type"] not in ("redeem", "redeemed_in_store", "expired")), 2)
    expired = round(-sum(r["amount"] for r in rows if r["type"] == "expired"), 2)
    return {
        "rows": rows,
        "totals": {"earned": earned, "redeemed": redeemed, "clawed_back": clawed, "expired": expired,
                   "ledger_balance": running, "account_balance": round(_f(trader.get("credit_balance")), 2)},
    }


@router.get("/traders/{account_id}/ledger")
async def get_ledger(account_id: str):
    from server import db
    trader = await _trader(db, account_id)
    return await build_ledger(db, trader)


class CreditAdjust(BaseModel):
    amount: float = Field(..., description="Positive adds credit, negative removes it")
    reason: str = Field(..., min_length=3)
    reference: Optional[str] = None
    notify_customer: bool = False


@router.post("/traders/{account_id}/credit-adjust")
async def credit_adjust(account_id: str, body: CreditAdjust, user: dict = Depends(get_current_user)):
    _require_super_admin(user)
    from server import db
    trader = await _trader(db, account_id)
    amount = round(body.amount, 2)
    if amount == 0:
        raise HTTPException(status_code=400, detail="Amount cannot be zero")
    current = round(_f(trader.get("credit_balance")), 2)
    new_balance = round(current + amount, 2)
    if new_balance < 0:
        raise HTTPException(status_code=400, detail=f"Balance cannot go below £0 (current £{current:.2f})")
    now = datetime.now(timezone.utc).isoformat()
    await db.credit_transactions.insert_one({
        "id": str(uuid.uuid4()),
        "customer_id": trader["id"],
        "trade_account_number": trader.get("trade_account_number"),
        "type": "manual_adjustment",
        "amount": amount,
        "balance_after": new_balance,
        "source": "admin_manual",
        "reference": (body.reference or "").strip() or None,
        "description": f"{'Credit added' if amount > 0 else 'Credit removed'} by {_actor(user)}: {body.reason.strip()}",
        "actor": _actor(user),
        "created_at": now,
    })
    await db.shop_customers.update_one({"id": trader["id"]}, {"$set": {"credit_balance": new_balance, "updated_at": now}})
    await log_event(db, trader["id"], "credit_adjusted",
                    f"{'+' if amount > 0 else '−'}£{abs(amount):.2f} manual adjustment — {body.reason.strip()}",
                    meta={"amount": amount, "reference": body.reference, "balance_after": new_balance}, actor=_actor(user))
    if body.notify_customer and trader.get("email"):
        from services.email import send_simple_email_if_possible, COMPANY_NAME, SENDER_EMAIL
        html = (f"<p>Hi {trader.get('name','').split(' ')[0] or 'there'},</p><p>Your {COMPANY_NAME} trade credit balance has been "
                f"{'increased' if amount > 0 else 'reduced'} by <strong>£{abs(amount):.2f}</strong> ({body.reason.strip()}). "
                f"Your balance is now <strong>£{new_balance:.2f}</strong>.</p>")
        await send_simple_email_if_possible(trader["email"], f"Trade credit update — {COMPANY_NAME}", html,
                                            from_override=f"{COMPANY_NAME} <{SENDER_EMAIL}>")
    return {"success": True, "balance_before": current, "balance_after": new_balance, "amount": amount}


# ───────────────────────────── credit expiry ─────────────────────────────

class CreditExpiry(BaseModel):
    expires_at: Optional[str] = None  # YYYY-MM-DD or null to clear


@router.put("/traders/{account_id}/credit-expiry")
async def set_credit_expiry(account_id: str, body: CreditExpiry, user: dict = Depends(get_current_user)):
    from server import db
    trader = await _trader(db, account_id)
    if body.expires_at:
        dt = parse_date(body.expires_at)
        if not dt:
            raise HTTPException(status_code=400, detail="Invalid date — use YYYY-MM-DD")
        value = dt.date().isoformat()
    else:
        value = None
    await db.shop_customers.update_one(
        {"id": trader["id"]}, {"$set": {"credit_expires_at": value, "credit_expiry_reminders": {}}})
    await log_event(db, trader["id"], "credit_expiry_set",
                    f"Credit expiry {'set to ' + value if value else 'cleared'}", meta={"expires_at": value}, actor=_actor(user))
    return {"success": True, "credit_expires_at": value}


class BulkExpiry(BaseModel):
    ids: List[str]
    expires_at: str


@router.post("/credit-expiry/set-bulk")
async def set_credit_expiry_bulk(body: BulkExpiry, user: dict = Depends(get_current_user)):
    _require_super_admin(user)
    from server import db
    dt = parse_date(body.expires_at)
    if not dt:
        raise HTTPException(status_code=400, detail="Invalid date — use YYYY-MM-DD")
    value = dt.date().isoformat()
    result = await db.shop_customers.update_many(
        {"id": {"$in": body.ids}, "is_trade": True},
        {"$set": {"credit_expires_at": value, "credit_expiry_reminders": {}}})
    for cid in body.ids:
        await log_event(db, cid, "credit_expiry_set", f"Credit expiry set to {value} (bulk)", meta={"expires_at": value}, actor=_actor(user))
    return {"success": True, "updated": result.modified_count, "credit_expires_at": value}


@router.post("/traders/{account_id}/credit-expiry/remind")
async def remind_credit_expiry(account_id: str, user: dict = Depends(get_current_user)):
    from server import db
    trader = await _trader(db, account_id)
    result = await send_credit_expiry_reminder(db, trader, actor=_actor(user))
    if not result.get("success") and result.get("error") and "No credit" in str(result.get("error")):
        raise HTTPException(status_code=400, detail=result["error"])
    return result


@router.post("/traders/{account_id}/credit-expiry/expire-now")
async def expire_now(account_id: str, user: dict = Depends(get_current_user)):
    _require_super_admin(user)
    from server import db
    trader = await _trader(db, account_id)
    return await expire_customer_credit(db, trader, actor=_actor(user), reason=f"Credit expired manually by {_actor(user)}")


# ───────────────────────────── engagement ─────────────────────────────

class Ids(BaseModel):
    ids: List[str]


@router.post("/engagement/dormant-nudge")
async def dormant_nudge(body: Ids, user: dict = Depends(get_current_user)):
    from server import db
    sent, failed = 0, []
    for cid in body.ids[:200]:
        trader = await db.shop_customers.find_one({"id": cid, "is_trade": True}, {"_id": 0, "password": 0})
        if not trader or not trader.get("email"):
            failed.append({"id": cid, "error": "no email"})
            continue
        r = await send_dormant_nudge(db, trader, actor=_actor(user))
        if r.get("success"):
            sent += 1
        else:
            failed.append({"id": cid, "email": trader["email"], "error": r.get("error")})
    return {"success": True, "sent": sent, "failed": failed}


class Notes(BaseModel):
    internal_notes: Optional[str] = None
    trade_rep: Optional[str] = None


@router.put("/traders/{account_id}/notes")
async def set_notes(account_id: str, body: Notes, user: dict = Depends(get_current_user)):
    from server import db
    trader = await _trader(db, account_id)
    update = {k: v for k, v in body.model_dump().items() if v is not None}
    if not update:
        return {"success": True}
    update["updated_at"] = datetime.now(timezone.utc).isoformat()
    await db.shop_customers.update_one({"id": trader["id"]}, {"$set": update})
    if "trade_rep" in update:
        await log_event(db, trader["id"], "trade_rep_assigned", f"Trade rep set to {update['trade_rep'] or '—'}", actor=_actor(user))
    return {"success": True, **update}


# ───────────────────────────── timeline ─────────────────────────────

@router.get("/traders/{account_id}/timeline")
async def timeline(account_id: str, limit: int = 150):
    from server import db
    trader = await _trader(db, account_id)
    match = _trader_match(trader)
    email = (trader.get("email") or "").lower()
    phone = trader.get("phone") or ""
    events = []

    reg = trader.get("registration_source") or {}
    channel_label = {"in_store": "In store", "staff_created": "Staff created", "online": "Online (own device)"}.get(reg.get("channel"), "Channel not recorded (pre-tracking)")
    events.append({
        "kind": "registered", "at": trader.get("created_at"),
        "title": "Trade account created",
        "detail": (channel_label
                   + (f" · {reg.get('showroom_name')}" if reg.get("showroom_name") else "")
                   + (f" · by {reg.get('staff_name')}" if reg.get("staff_name") else "")
                   + (f" · {reg.get('device')}" if reg.get("device") else "")),
        "meta": reg,
    })

    for o in await db.shop_orders.find(match, {"_id": 0, "id": 1, "order_number": 1, "created_at": 1, "total": 1, "subtotal": 1,
                                                 "status": 1, "payment_status": 1, "items": 1, "credits_awarded": 1, "credits_applied": 1}).sort("created_at", -1).to_list(limit):
        events.append({
            "kind": "online_order", "at": o.get("created_at"),
            "title": f"Online order #{o.get('order_number') or o.get('id')}",
            "detail": f"£{_f(o.get('total')):.2f} · {len(o.get('items') or [])} item(s) · {o.get('payment_status') or o.get('status') or ''}",
            "amount": _f(o.get("total")), "ref": o.get("id"), "status": o.get("payment_status") or o.get("status"),
        })

    inv_match = {"$or": [{"trade_account_number": trader.get("trade_account_number")} if trader.get("trade_account_number") else {"_id": None},
                         {"linked_shop_customer_id": trader["id"]},
                         {"customer_email": email} if email else {"_id": None}]}
    for inv in await db.invoices.find(inv_match, {"_id": 0, "id": 1, "invoice_no": 1, "date": 1, "created_at": 1, "gross_total": 1,
                                                    "showroom_name": 1, "status": 1, "trade_credit_earned": 1, "credit_redeemed": 1}).sort("created_at", -1).to_list(limit):
        events.append({
            "kind": "in_store_invoice", "at": inv.get("created_at") or inv.get("date"),
            "title": f"In-store invoice {inv.get('invoice_no') or ''}",
            "detail": f"£{_f(inv.get('gross_total')):.2f} · {inv.get('showroom_name') or 'showroom'}"
                      + (f" · earned £{_f(inv.get('trade_credit_earned')):.2f}" if _f(inv.get("trade_credit_earned")) else "")
                      + (f" · used £{_f(inv.get('credit_redeemed')):.2f}" if _f(inv.get("credit_redeemed")) else ""),
            "amount": _f(inv.get("gross_total")), "ref": inv.get("id"), "status": inv.get("status"),
        })

    ref_match = {"$or": [{"trade_account_number": trader.get("trade_account_number")} if trader.get("trade_account_number") else {"_id": None},
                         {"customer_email": email} if email else {"_id": None}]}
    for rf in await db.refunds.find(ref_match, {"_id": 0, "id": 1, "refund_no": 1, "created_at": 1, "total": 1, "refund_total": 1,
                                                  "amount": 1, "showroom_name": 1, "reason": 1}).sort("created_at", -1).to_list(50):
        amt = _f(rf.get("total") or rf.get("refund_total") or rf.get("amount"))
        events.append({"kind": "refund", "at": rf.get("created_at"), "title": f"Refund {rf.get('refund_no') or ''}",
                       "detail": f"£{amt:.2f} · {rf.get('showroom_name') or ''} {('· ' + rf.get('reason')) if rf.get('reason') else ''}".strip(),
                       "amount": -amt, "ref": rf.get("id")})

    ledger = await build_ledger(db, trader, limit=limit)
    for r in ledger["rows"]:
        events.append({"kind": "credit", "at": r["created_at"], "title": r["label"],
                       "detail": (f"{'+' if r['amount'] >= 0 else '−'}£{abs(r['amount']):.2f}"
                                  + (f" · {r['reference']}" if r.get("reference") else "")
                                  + (f" · {r['description']}" if r.get("description") else "")),
                       "amount": r["amount"], "type": r["type"]})

    for lg in await db.customer_logins.find({"customer_id": trader["id"]}, {"_id": 0}).sort("at", -1).to_list(limit):
        events.append({"kind": "login", "at": lg.get("at"), "title": "Signed in online",
                       "detail": " · ".join(x for x in [lg.get("device"), lg.get("ip")] if x)})

    if phone:
        digits = "".join(ch for ch in phone if ch.isdigit())[-9:]
        if digits:
            for w in await db.whatsapp_queue.find({"phone": {"$regex": f"{digits}$"}}, {"_id": 0, "queued_at": 1, "sent_at": 1, "status": 1, "message": 1, "message_type": 1, "is_test": 1}).sort("queued_at", -1).to_list(50):
                events.append({"kind": "whatsapp", "at": w.get("sent_at") or w.get("queued_at"),
                               "title": f"WhatsApp {w.get('status') or ''}".strip(),
                               "detail": (w.get("message") or w.get("message_type") or "")[:140]})

    if email:
        for s in await db.sample_orders.find({"customer_email": email}, {"_id": 0, "order_number": 1, "created_at": 1, "sample_count": 1, "status": 1, "total": 1}).sort("created_at", -1).to_list(30):
            events.append({"kind": "sample_order", "at": s.get("created_at"), "title": f"Sample order {s.get('order_number') or ''}",
                           "detail": f"{s.get('sample_count') or 0} sample(s) · {s.get('status') or ''}", "amount": _f(s.get("total"))})
        for q in await db.cash_quotations.find({"customer_email": email}, {"_id": 0, "quotation_no": 1, "quote_number": 1, "created_at": 1, "total": 1, "grand_total": 1, "status": 1}).sort("created_at", -1).to_list(30):
            events.append({"kind": "quote", "at": q.get("created_at"), "title": f"Quote {q.get('quotation_no') or q.get('quote_number') or ''}",
                           "detail": f"£{_f(q.get('grand_total') or q.get('total')):.2f} · {q.get('status') or ''}", "amount": _f(q.get("grand_total") or q.get("total"))})

    for ev in await db.trade_engagement_log.find({"customer_id": trader["id"]}, {"_id": 0}).sort("created_at", -1).to_list(limit):
        events.append({"kind": ev.get("kind"), "at": ev.get("created_at"), "title": ev.get("summary"),
                       "detail": (f"by {ev.get('actor')}" if ev.get("actor") else ""), "meta": ev.get("meta") or {}})

    if trader.get("login_link_sent_at"):
        events.append({"kind": "login_link", "at": trader["login_link_sent_at"], "title": "Login link sent", "detail": trader.get("email")})
    if trader.get("password_set_at"):
        events.append({"kind": "password_set", "at": trader["password_set_at"], "title": "Password set", "detail": "Account activated online"})

    events = [e for e in events if e.get("at")]
    events.sort(key=lambda e: _ts(e["at"]), reverse=True)
    for e in events:
        e["at"] = _ts(e["at"])
    return {"trader": trader, "ledger_totals": ledger["totals"], "events": events[:limit]}


# ───────────────────────────── dashboard ─────────────────────────────

@router.get("/summary")
async def summary(days: int = 30):
    from server import db
    now = datetime.now(timezone.utc)
    since = (now - timedelta(days=days)).isoformat()
    since_90 = (now - timedelta(days=90)).isoformat()
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat()
    dormant_since = dormant_cutoff(DORMANT_DAYS)
    expiring_by = (now + timedelta(days=30)).date().isoformat()

    traders = await db.shop_customers.find({"is_trade": True}, {"_id": 0, "password": 0}).to_list(5000)
    total = len(traders)
    active_status = sum(1 for t in traders if (t.get("status") or "active") == "active")
    never_logged_in = sum(1 for t in traders if not t.get("last_login_at") and not t.get("password_set_at"))
    link_sent_not_activated = sum(1 for t in traders if t.get("login_link_sent_at") and not t.get("last_login_at") and not t.get("password_set_at"))
    new_this_month = sum(1 for t in traders if _ts(t.get("created_at")) >= month_start)
    credit_liability = round(sum(_f(t.get("credit_balance")) for t in traders), 2)
    expiring = [t for t in traders if _f(t.get("credit_balance")) > 0 and t.get("credit_expires_at") and _ts(t["credit_expires_at"])[:10] <= expiring_by]
    channels = {"online": 0, "in_store": 0, "staff_created": 0, "unknown": 0}
    for t in traders:
        ch = (t.get("registration_source") or {}).get("channel") or "unknown"
        channels[ch if ch in channels else "unknown"] += 1

    # Activity: last purchase either channel
    last_purchase = {}
    async for o in db.shop_orders.aggregate([
        {"$match": {"customer_id": {"$ne": None}, "payment_status": {"$in": ["paid", "confirmed"]}}},
        {"$group": {"_id": "$customer_id", "last": {"$max": "$created_at"}}}]):
        last_purchase[o["_id"]] = max(last_purchase.get(o["_id"], ""), _ts(o["last"]))
    by_tnum = {t.get("trade_account_number"): t["id"] for t in traders if t.get("trade_account_number")}
    async for i in db.invoices.aggregate([
        {"$match": {"trade_account_number": {"$in": list(by_tnum.keys())}}},
        {"$group": {"_id": "$trade_account_number", "last": {"$max": "$created_at"}}}]):
        cid = by_tnum.get(i["_id"])
        if cid:
            last_purchase[cid] = max(last_purchase.get(cid, ""), _ts(i["last"]))
    dormant = [t for t in traders if last_purchase.get(t["id"]) and last_purchase[t["id"]] < dormant_since]
    never_purchased = sum(1 for t in traders if not last_purchase.get(t["id"]))

    async def _sum(coll, match, field):
        agg = await db[coll].aggregate([{"$match": match}, {"$group": {"_id": None, "s": {"$sum": f"${field}"}, "n": {"$sum": 1}}}]).to_list(1)
        return (round(_f(agg[0]["s"]), 2), agg[0]["n"]) if agg else (0.0, 0)

    online_rev, online_n = await _sum("shop_orders", {"customer_id": {"$in": [t["id"] for t in traders]}, "payment_status": {"$in": ["paid", "confirmed"]}, "created_at": {"$gte": since}}, "total")
    online_rev_90, _ = await _sum("shop_orders", {"customer_id": {"$in": [t["id"] for t in traders]}, "payment_status": {"$in": ["paid", "confirmed"]}, "created_at": {"$gte": since_90}}, "total")
    store_rev, store_n = await _sum("invoices", {"trade_account_number": {"$in": list(by_tnum.keys())}, "created_at": {"$gte": since}}, "gross_total")
    store_rev_90, _ = await _sum("invoices", {"trade_account_number": {"$in": list(by_tnum.keys())}, "created_at": {"$gte": since_90}}, "gross_total")

    earned, redeemed, clawed, expired = 0.0, 0.0, 0.0, 0.0
    for coll in ("trade_credits", "credit_transactions"):
        async for r in db[coll].aggregate([{"$match": {"created_at": {"$gte": since}}}, {"$group": {"_id": "$type", "s": {"$sum": "$amount"}}}]):
            t, s = r["_id"], _f(r["s"])
            if t in ("earn", "earned_in_store", "reapplied_earned_in_store") or (t == "manual_adjustment" and s > 0):
                earned += s
            elif t in ("redeem", "redeemed_in_store"):
                redeemed += -s
            elif t == "expired":
                expired += -s
            elif s < 0:
                clawed += -s

    spend = {}
    async for o in db.shop_orders.aggregate([
        {"$match": {"customer_id": {"$in": [t["id"] for t in traders]}, "payment_status": {"$in": ["paid", "confirmed"]}, "created_at": {"$gte": since_90}}},
        {"$group": {"_id": "$customer_id", "s": {"$sum": "$total"}}}]):
        spend[o["_id"]] = spend.get(o["_id"], 0) + _f(o["s"])
    async for i in db.invoices.aggregate([
        {"$match": {"trade_account_number": {"$in": list(by_tnum.keys())}, "created_at": {"$gte": since_90}}},
        {"$group": {"_id": "$trade_account_number", "s": {"$sum": "$gross_total"}}}]):
        cid = by_tnum.get(i["_id"])
        if cid:
            spend[cid] = spend.get(cid, 0) + _f(i["s"])
    tmap = {t["id"]: t for t in traders}
    top = sorted(spend.items(), key=lambda kv: kv[1], reverse=True)[:10]
    top_traders = [{"id": cid, "business_name": tmap[cid].get("business_name") or tmap[cid].get("name"),
                    "trade_account_number": tmap[cid].get("trade_account_number"), "spend_90d": round(s, 2),
                    "credit_balance": round(_f(tmap[cid].get("credit_balance")), 2)} for cid, s in top if cid in tmap]

    def _brief(t):
        return {"id": t["id"], "business_name": t.get("business_name") or t.get("name"), "name": t.get("name"),
                "email": t.get("email"), "phone": t.get("phone"), "trade_account_number": t.get("trade_account_number"),
                "credit_balance": round(_f(t.get("credit_balance")), 2), "credit_expires_at": t.get("credit_expires_at"),
                "last_purchase_at": last_purchase.get(t["id"]), "last_login_at": t.get("last_login_at"),
                "last_nudge_at": t.get("last_nudge_at"), "login_link_sent_at": t.get("login_link_sent_at")}

    return {
        "days": days,
        "kpis": {
            "total_traders": total, "active_traders": active_status, "new_this_month": new_this_month,
            "never_logged_in": never_logged_in, "link_sent_not_activated": link_sent_not_activated,
            "dormant": len(dormant), "never_purchased": never_purchased,
            "online_revenue": online_rev, "online_orders": online_n, "online_revenue_90d": online_rev_90,
            "in_store_revenue": store_rev, "in_store_invoices": store_n, "in_store_revenue_90d": store_rev_90,
            "credit_liability": credit_liability, "credit_earned": round(earned, 2), "credit_redeemed": round(redeemed, 2),
            "credit_clawed_back": round(clawed, 2), "credit_expired": round(expired, 2),
            "expiring_credit_count": len(expiring), "expiring_credit_total": round(sum(_f(t.get("credit_balance")) for t in expiring), 2),
        },
        "channels": channels,
        "top_traders": top_traders,
        "dormant": sorted([_brief(t) for t in dormant], key=lambda b: _ts(b.get("last_purchase_at")))[:100],
        "expiring": sorted([_brief(t) for t in expiring], key=lambda b: _ts(b.get("credit_expires_at")))[:100],
        "never_logged_in": [_brief(t) for t in traders if not t.get("last_login_at") and not t.get("password_set_at")][:200],
    }


@router.get("/credit/movements")
async def credit_movements(days: int = 30, limit: int = 300):
    """Every credit movement across all traders — newest first."""
    from server import db
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    online = await db.trade_credits.find({"created_at": {"$gte": since}}, {"_id": 0}).sort("created_at", -1).to_list(limit)
    in_store = await db.credit_transactions.find({"created_at": {"$gte": since}}, {"_id": 0}).sort("created_at", -1).to_list(limit)
    ids = {d.get("customer_id") for d in online + in_store if d.get("customer_id")}
    tnums = {d.get("trade_account_number") for d in in_store if d.get("trade_account_number")}
    traders = await db.shop_customers.find({"$or": [{"id": {"$in": list(ids)}}, {"trade_account_number": {"$in": list(tnums)}}]},
                                           {"_id": 0, "id": 1, "business_name": 1, "name": 1, "trade_account_number": 1}).to_list(2000)
    by_id = {t["id"]: t for t in traders}
    by_t = {t.get("trade_account_number"): t for t in traders if t.get("trade_account_number")}
    rows = []
    for d in online + in_store:
        t = by_id.get(d.get("customer_id")) or by_t.get(d.get("trade_account_number")) or {}
        rows.append({
            "id": d.get("id"), "created_at": d.get("created_at"), "type": d.get("type"),
            "label": LEDGER_LABELS.get(d.get("type"), d.get("type")), "amount": _f(d.get("amount")),
            "reference": d.get("order_number") or d.get("refund_no") or d.get("invoice_no") or d.get("reference"),
            "description": d.get("description") or "", "actor": d.get("actor"),
            "customer_id": t.get("id") or d.get("customer_id"), "business_name": t.get("business_name") or t.get("name"),
            "trade_account_number": t.get("trade_account_number") or d.get("trade_account_number"),
        })
    rows.sort(key=lambda r: _ts(r.get("created_at")), reverse=True)
    return {"rows": rows[:limit], "days": days}

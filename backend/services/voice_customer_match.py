"""
Voice — Customer auto-recognition (Feb 2026).

Matches an inbound caller's phone number against existing customers
across multiple collections so the admin's screen pop-up + the
Telegram alert can say "Incoming call: Carolina Santiago (last order
TS-260616-30E725, £834.63)" instead of just a phone number.

Phone normalisation handles the messy UK reality:
  +447379562631 / 07379562631 / 07379 562631 / +44 7379 562631
all reduce to the same 10-digit key `7379562631`. We then query each
collection with multiple variants so we don't have to backfill a
`phone_normalized` field across years of historical orders.

Sources of truth (in priority order):
  1. shop_orders  — the strongest match (paying customer)
  2. quotes       — got a quote but didn't buy yet
  3. sample_orders — requested a sample
  4. users        — registered customer account

The result is cached on the voice_calls row so the call log table can
show the customer's name forever.
"""
import logging
import re
from datetime import datetime, timezone
from typing import List, Optional

logger = logging.getLogger(__name__)


# ─── Phone normalisation ─────────────────────────────────────────────
def normalize_phone(phone: Optional[str]) -> str:
    """Reduce a UK phone number to a 10-digit comparison key.

    Strips non-digits, drops the +44 country code or leading 0,
    returns the last 10 digits. Empty string for None / unparseable.
    """
    if not phone:
        return ""
    digits = re.sub(r"\D", "", str(phone))
    if not digits:
        return ""
    if digits.startswith("44") and len(digits) >= 11:
        digits = digits[2:]
    if digits.startswith("0"):
        digits = digits[1:]
    return digits[-10:]


def phone_variants(phone: Optional[str]) -> List[str]:
    """Common shapes a UK number can be stored in. We query with
    all of them via $in so we don't have to backfill historical rows."""
    norm = normalize_phone(phone)
    if not norm:
        return []
    return list({
        phone or "",          # original (e.g. "+447379562631")
        f"+44{norm}",
        f"0{norm}",
        norm,
        f"+44 {norm[:4]} {norm[4:]}",   # +44 7379 562631
        f"0{norm[:4]} {norm[4:]}",      # 07379 562631
    })


# ─── Match against DB ────────────────────────────────────────────────
async def match_caller(db, phone: str) -> dict:
    """Return a customer match summary for a caller's phone.

    Shape:
      {
        "matched": bool,
        "name": str | None,
        "email": str | None,
        "match_type": "shop_orders" | "quote" | "sample_order" | "user" | None,
        "order_count": int,
        "lifetime_value": float,
        "last_order": { order_number, total, status, created_at, items_count } | None,
      }
    """
    out = {
        "matched": False, "name": None, "email": None, "match_type": None,
        "order_count": 0, "lifetime_value": 0.0, "last_order": None,
    }
    variants = phone_variants(phone)
    if not variants:
        return out

    # 1. Shop orders — strongest signal
    try:
        cursor = db.shop_orders.find(
            {"customer_phone": {"$in": variants}},
            {"_id": 0, "order_number": 1, "customer_name": 1, "customer_email": 1,
             "total": 1, "status": 1, "payment_status": 1, "created_at": 1,
             "items": 1},
        ).sort("created_at", -1).limit(50)
        orders = await cursor.to_list(50)
        if orders:
            paid = [o for o in orders if o.get("payment_status") == "paid"]
            last = orders[0]
            out.update({
                "matched": True,
                "name": last.get("customer_name") or "",
                "email": last.get("customer_email") or "",
                "match_type": "shop_orders",
                "order_count": len(orders),
                "lifetime_value": round(sum(float(o.get("total") or 0) for o in paid), 2),
                "last_order": {
                    "order_number": last.get("order_number"),
                    "total": float(last.get("total") or 0),
                    "status": last.get("status") or last.get("payment_status"),
                    "created_at": last.get("created_at"),
                    "items_count": len(last.get("items") or []),
                },
            })
            return out
    except Exception:  # noqa: BLE001
        logger.exception("[voice-match] shop_orders lookup failed")

    # 2. Sample orders
    try:
        sample = await db.sample_orders.find_one(
            {"customer_phone": {"$in": variants}},
            {"_id": 0, "customer_name": 1, "customer_email": 1, "id": 1, "created_at": 1},
            sort=[("created_at", -1)],
        )
        if sample:
            out.update({
                "matched": True, "name": sample.get("customer_name"),
                "email": sample.get("customer_email"),
                "match_type": "sample_order",
                "last_order": {
                    "order_number": sample.get("id"),
                    "status": "sample_request",
                    "created_at": sample.get("created_at"),
                    "total": 0, "items_count": 0,
                },
            })
            return out
    except Exception:  # noqa: BLE001
        pass

    # 3. Quotes
    try:
        for col in ("quotes", "quotations"):
            if col not in (await db.list_collection_names()):
                continue
            q = await db[col].find_one(
                {"customer_phone": {"$in": variants}},
                {"_id": 0, "customer_name": 1, "customer_email": 1, "id": 1,
                 "total": 1, "created_at": 1, "quote_number": 1, "status": 1},
                sort=[("created_at", -1)],
            )
            if q:
                out.update({
                    "matched": True, "name": q.get("customer_name"),
                    "email": q.get("customer_email"),
                    "match_type": "quote",
                    "last_order": {
                        "order_number": q.get("quote_number") or q.get("id"),
                        "total": float(q.get("total") or 0),
                        "status": q.get("status", "quoted"),
                        "created_at": q.get("created_at"),
                        "items_count": 0,
                    },
                })
                return out
    except Exception:  # noqa: BLE001
        pass

    # 4. Registered users
    try:
        u = await db.users.find_one(
            {"phone": {"$in": variants}},
            {"_id": 0, "name": 1, "email": 1, "created_at": 1},
        )
        if u:
            out.update({
                "matched": True, "name": u.get("name"),
                "email": u.get("email"),
                "match_type": "user",
            })
    except Exception:  # noqa: BLE001
        pass

    return out


def telegram_caller_summary(match: dict, from_number: str) -> str:
    """Format the customer match as an HTML snippet for Telegram. Falls
    back to just the phone number when the caller is unknown."""
    if not (match and match.get("matched")):
        return f"<code>{from_number}</code> (unknown caller)"
    name = match.get("name") or "Unknown"
    lo = match.get("last_order") or {}
    parts = [f"<b>{name}</b> · <code>{from_number}</code>"]
    if match.get("match_type") == "shop_orders":
        oc = match.get("order_count", 0)
        ltv = match.get("lifetime_value", 0)
        parts.append(f"{oc} order(s) · £{ltv:,.0f} lifetime")
    if lo.get("order_number"):
        when = (lo.get("created_at") or "")[:10]
        parts.append(
            f"Last: <code>{lo['order_number']}</code>"
            f"{' · £' + format(lo.get('total', 0), ',.2f') if lo.get('total') else ''}"
            f"{' · ' + str(lo.get('status', '')) if lo.get('status') else ''}"
            f"{' · ' + when if when else ''}"
        )
    return "\n".join(parts)

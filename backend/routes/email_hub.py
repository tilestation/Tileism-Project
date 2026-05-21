"""
Email Hub
─────────
A unified system for composing, scheduling, and sending bulk email campaigns
to any segment of customers / traders, with full analytics + unsubscribe
compliance.

Architecture:
  • Audience builder — pure functions that translate "filter chips" into
    a Mongo query against shop_customers; preview + send share one builder.
  • Campaigns — every send is recorded as a campaign doc with a content
    snapshot, audience definition, and aggregated results.
  • Templates — reusable layouts saved per-admin.
  • Schedules — APScheduler one-shot jobs that fire send-now at the
    configured time (handled by a poll-tick that wakes hourly).
  • Webhook — Resend pings POST /api/webhooks/resend on delivered/opened/
    bounced/clicked events; we store one row per recipient per event.
  • Unsubscribe — every send appends an HMAC-signed link; clicking it adds
    an `email_preferences` doc that suppresses ALL future bulk sends.
    Transactional emails (order confirmations, refunds, etc.) deliberately
    bypass the suppression list so customers always get receipts.

Endpoints:
  POST   /api/admin/email-hub/audience/preview   — count + sample
  POST   /api/admin/email-hub/send-test          — send to one address
  POST   /api/admin/email-hub/campaigns          — create + send
  GET    /api/admin/email-hub/campaigns          — list (paginated)
  GET    /api/admin/email-hub/campaigns/{id}     — detail + analytics
  POST   /api/admin/email-hub/campaigns/{id}/cancel — kill a scheduled job
  GET    /api/admin/email-hub/templates          — list
  POST   /api/admin/email-hub/templates          — save current as template
  DELETE /api/admin/email-hub/templates/{id}     — delete
  GET    /api/admin/email-hub/suppressions       — view + add/remove

Public:
  POST /api/webhooks/resend                     — event ingestion
  GET  /api/unsubscribe                         — landing page returns JSON
       confirming unsubscribe; UI page reads it.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import os
import re
import secrets
from datetime import datetime, timezone, timedelta
from typing import Optional, Any
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Query, Request, BackgroundTasks
from pydantic import BaseModel, EmailStr, Field

from config import get_db
from services import get_current_user, is_admin_user

logger = logging.getLogger(__name__)
router = APIRouter()

# Resend SDK guard — same pattern as services/email.py
try:
    import resend  # type: ignore
    RESEND_AVAILABLE = True
except Exception:
    RESEND_AVAILABLE = False
RESEND_API_KEY = os.environ.get("RESEND_API_KEY")
RESEND_WEBHOOK_SECRET = os.environ.get("RESEND_WEBHOOK_SECRET", "")
COMPANY_NAME = os.environ.get("COMPANY_NAME", "Tile Station")
SENDER_EMAIL = os.environ.get("SENDER_EMAIL", "online@tilestation.co.uk")
COMPANY_WEBSITE = (
    os.environ.get("COMPANY_WEBSITE")
    or os.environ.get("SHOP_WEBSITE_URL")
    or "https://tilestation.co.uk"
)
# Used to sign one-click unsubscribe tokens. If JWT_SECRET exists we reuse it
# (single root of trust); else fall back to a stable per-deploy secret.
_UNSUB_SECRET = (
    os.environ.get("UNSUBSCRIBE_SECRET")
    or os.environ.get("JWT_SECRET")
    or "tilestation-default-unsubscribe-secret-please-set-env"
)

EMAIL_RX = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


# =============================================================================
# AUDIENCE BUILDER
# =============================================================================
# A SegmentDef tells the resolver which subset of shop_customers to iterate.
# `kind` switches behaviour:
#   • all_customers   — every shop_customer with a valid email
#   • trade_only      — is_trade=True
#   • non_trade       — is_trade != True
#   • has_credit      — credit_balance > 0
#   • inactive_days   — last_order_at older than `inactive_days_value`
#   • spend_gte       — lifetime_spend >= `spend_value`
#   • custom_emails   — paste a list (one per line)
# Multiple chips can be combined; AND-semantics (intersection).

class SegmentDef(BaseModel):
    kind: str = Field(..., min_length=2, max_length=40)
    inactive_days_value: Optional[int] = Field(default=None, ge=1, le=3650)
    spend_value: Optional[float] = Field(default=None, ge=0)
    custom_emails: Optional[list[str]] = None


class AudienceDef(BaseModel):
    """One or more segment chips intersected with each other."""
    segments: list[SegmentDef]
    additional_emails: Optional[list[str]] = None  # always added (union)


def _normalise_emails(items: Optional[list[str]]) -> list[str]:
    out: list[str] = []
    for raw in items or []:
        for piece in (raw or "").split(","):
            e = piece.strip().lower()
            if e and EMAIL_RX.match(e):
                out.append(e)
    # de-dup preserving order
    seen: set[str] = set()
    uniq = []
    for e in out:
        if e not in seen:
            uniq.append(e)
            seen.add(e)
    return uniq


def _segment_to_query(seg: SegmentDef) -> dict[str, Any]:
    """Translate one segment chip into a Mongo find() filter."""
    kind = (seg.kind or "").lower()
    if kind == "all_customers":
        return {"email": {"$regex": "^.+@.+\\..+$"}}
    if kind == "trade_only":
        return {"is_trade": True, "email": {"$regex": "^.+@.+\\..+$"}}
    if kind == "non_trade":
        return {"is_trade": {"$ne": True}, "email": {"$regex": "^.+@.+\\..+$"}}
    if kind == "has_credit":
        return {"credit_balance": {"$gt": 0}, "email": {"$regex": "^.+@.+\\..+$"}}
    if kind == "inactive_days":
        days = int(seg.inactive_days_value or 60)
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        return {
            "$or": [
                {"last_order_at": {"$lt": cutoff}},
                {"last_order_at": {"$exists": False}},
            ],
            "email": {"$regex": "^.+@.+\\..+$"},
        }
    if kind == "spend_gte":
        threshold = float(seg.spend_value or 0)
        return {"lifetime_spend": {"$gte": threshold}, "email": {"$regex": "^.+@.+\\..+$"}}
    if kind == "custom_emails":
        emails = _normalise_emails(seg.custom_emails)
        return {"email": {"$in": emails}} if emails else {"email": {"$in": ["__none__"]}}
    raise HTTPException(status_code=400, detail=f"Unknown segment kind: {kind}")


async def resolve_audience(db, audience: AudienceDef, sample_size: int = 5) -> dict:
    """Returns {count, total_credit, sample[5], emails (lowercase set)}.
    Filters out anyone in the suppression list."""
    # AND across segments — intersect by email set
    email_set: Optional[set[str]] = None
    for seg in audience.segments or []:
        q = _segment_to_query(seg)
        cursor = db.shop_customers.find(q, {"_id": 0, "email": 1, "credit_balance": 1, "name": 1, "business_name": 1, "is_trade": 1})
        emails_for_seg: set[str] = set()
        async for doc in cursor:
            e = (doc.get("email") or "").lower().strip()
            if e and EMAIL_RX.match(e):
                emails_for_seg.add(e)
        email_set = emails_for_seg if email_set is None else (email_set & emails_for_seg)

    if email_set is None:
        email_set = set()

    # Union the explicit additional list
    for e in _normalise_emails(audience.additional_emails):
        email_set.add(e)

    # Drop suppressed
    suppressed = {
        d["email"].lower() async for d in db.email_preferences.find(
            {"unsubscribed_at": {"$exists": True}},
            {"_id": 0, "email": 1},
        ) if d.get("email")
    }
    email_set -= suppressed

    # Pull a sample + totals
    cursor = db.shop_customers.find(
        {"email": {"$in": list(email_set)}},
        {"_id": 0, "email": 1, "name": 1, "business_name": 1, "credit_balance": 1, "is_trade": 1},
    ).limit(max(sample_size, 1))
    sample: list[dict] = []
    async for doc in cursor:
        sample.append({
            "email": doc.get("email"),
            "name": doc.get("name"),
            "business_name": doc.get("business_name"),
            "is_trade": bool(doc.get("is_trade")),
            "credit_balance": round(float(doc.get("credit_balance") or 0), 2),
        })

    # total credit balance across the audience
    total_credit = 0.0
    cursor2 = db.shop_customers.find(
        {"email": {"$in": list(email_set)}},
        {"_id": 0, "credit_balance": 1},
    )
    async for doc in cursor2:
        total_credit += float(doc.get("credit_balance") or 0)

    return {
        "count": len(email_set),
        "total_credit": round(total_credit, 2),
        "sample": sample,
        "emails": email_set,
        "suppressed_count": len(suppressed & (email_set | suppressed)),
    }


# =============================================================================
# UNSUBSCRIBE (HMAC-signed tokens)
# =============================================================================

def _sign_unsub_token(email: str, campaign_id: str = "") -> str:
    msg = f"{email.lower().strip()}|{campaign_id}".encode("utf-8")
    return hmac.new(_UNSUB_SECRET.encode("utf-8"), msg, hashlib.sha256).hexdigest()[:32]


def make_unsubscribe_url(email: str, campaign_id: str = "") -> str:
    token = _sign_unsub_token(email, campaign_id)
    qs = urlencode({"e": email.lower().strip(), "c": campaign_id, "t": token})
    return f"{COMPANY_WEBSITE}/unsubscribe?{qs}"


def _verify_unsub_token(email: str, campaign_id: str, token: str) -> bool:
    expected = _sign_unsub_token(email, campaign_id)
    return hmac.compare_digest(expected, token or "")


@router.get("/unsubscribe")
async def public_unsubscribe(e: str = Query(...), c: str = Query(""), t: str = Query(...)):
    """Public one-click unsubscribe endpoint. Adds the email to the
    suppression list — every future bulk send filters against it.

    Transactional emails (order confirmations, refunds) bypass this list."""
    if not EMAIL_RX.match(e or ""):
        raise HTTPException(status_code=400, detail="Invalid email")
    if not _verify_unsub_token(e, c, t):
        raise HTTPException(status_code=400, detail="Invalid unsubscribe token")
    db = get_db()
    now_iso = datetime.now(timezone.utc).isoformat()
    await db.email_preferences.update_one(
        {"email": e.lower().strip()},
        {"$set": {
            "email": e.lower().strip(),
            "unsubscribed_at": now_iso,
            "unsubscribed_from": c or None,
            "source": "one_click",
        }},
        upsert=True,
    )
    logger.info("Unsubscribed %s (campaign %s)", e, c or "—")
    return {"email": e.lower().strip(), "unsubscribed": True, "unsubscribed_at": now_iso}


@router.post("/unsubscribe/resubscribe")
async def public_resubscribe(payload: dict):
    """Lets a customer opt back in (rare, but compliance requires the option)."""
    email = (payload.get("email") or "").lower().strip()
    token = payload.get("token") or ""
    if not EMAIL_RX.match(email):
        raise HTTPException(status_code=400, detail="Invalid email")
    if not _verify_unsub_token(email, "", token):
        raise HTTPException(status_code=400, detail="Invalid token")
    db = get_db()
    await db.email_preferences.update_one(
        {"email": email},
        {"$unset": {"unsubscribed_at": "", "unsubscribed_from": ""},
         "$set": {"resubscribed_at": datetime.now(timezone.utc).isoformat()}},
    )
    return {"email": email, "subscribed": True}


# =============================================================================
# RENDERER — compose a self-contained HTML email
# =============================================================================
# The composer accepts:
#   subject / body_html (admin-edited rich text or AI-generated paragraphs)
#   hero_image_url (optional)
#   cta_text + cta_url (optional)
#   footer (auto-appended; contains unsubscribe + business address)
# Variable merge tags (rendered server-side per recipient):
#   {{first_name}} {{full_name}} {{business_name}} {{credit_balance}}

_VAR_RX = re.compile(r"\{\{\s*([a-zA-Z_]+)\s*\}\}")


def _merge_vars(text: str, customer: dict) -> str:
    if not text:
        return ""
    name = (customer.get("name") or "").strip()
    first_name = name.split(" ")[0] if name else "there"
    business = customer.get("business_name") or ""
    bal = customer.get("credit_balance")
    bal_str = f"£{float(bal or 0):.2f}" if bal is not None else "£0.00"

    def repl(m):
        v = m.group(1).lower()
        if v == "first_name":
            return first_name
        if v == "full_name":
            return name or first_name
        if v == "business_name":
            return business
        if v == "credit_balance":
            return bal_str
        return m.group(0)
    return _VAR_RX.sub(repl, text)


def render_campaign_html(
    *,
    subject: str,
    body_html: str,
    hero_image_url: str = "",
    cta_text: str = "",
    cta_url: str = "",
    featured_products: Optional[list[dict]] = None,
    customer: Optional[dict] = None,
    campaign_id: str = "",
) -> str:
    """Wraps user-edited body_html in the Tile-Station shell (header + footer
    + unsubscribe). `body_html` is allowed to contain plain HTML; we don't
    sanitise here because admin is the only one who composes.

    If `featured_products` is non-empty, renders a clickable image+price+CTA
    card grid BELOW the body — turns the email into a mini storefront.
    """
    cust = customer or {}
    body = _merge_vars(body_html or "", cust)
    cta_t = _merge_vars(cta_text or "", cust)

    hero = ""
    if hero_image_url:
        hero = (
            f'<div style="margin:-30px -24px 24px -24px;"><img src="{hero_image_url}" '
            'alt="" style="width:100%; max-width:620px; display:block;" /></div>'
        )

    cta = ""
    if cta_t and cta_url:
        cta = (
            f'<p style="margin:24px 0 0; text-align:center;">'
            f'<a href="{cta_url}" style="display:inline-block; background:#1a1a2e; color:#F7EA1C; '
            'padding:14px 32px; border-radius:8px; text-decoration:none; font-weight:700; font-size:14px;">'
            f'{cta_t}</a></p>'
        )

    # Product card grid — 2 cards per row for email-client compatibility
    products_html = ""
    if featured_products:
        cards = []
        for p in featured_products:
            name = (p.get("name") or "")[:80]
            img = p.get("image") or ""
            url = p.get("url") or COMPANY_WEBSITE
            price_val = p.get("price")
            price_txt = f"£{float(price_val):.2f}" if price_val is not None else ""
            cards.append(
                f'<td valign="top" style="width:50%; padding:8px;">'
                f'<a href="{url}" style="text-decoration:none; color:#1a1a2e;">'
                f'<table role="presentation" width="100%" cellspacing="0" cellpadding="0" '
                'style="background:#ffffff; border:1px solid #e7e5e4; border-radius:12px; overflow:hidden;">'
                f'<tr><td><img src="{img}" alt="{name}" style="display:block; width:100%; max-width:280px; height:auto;" /></td></tr>'
                f'<tr><td style="padding:12px 14px;">'
                f'<div style="font-size:13px; font-weight:600; color:#1a1a2e; line-height:1.3; min-height:34px;">{name}</div>'
                + (f'<div style="font-size:16px; font-weight:800; color:#1a1a2e; margin-top:6px;">{price_txt}</div>' if price_txt else "")
                + '<div style="font-size:11px; font-weight:700; color:#F7EA1C; background:#1a1a2e; '
                'padding:8px 12px; border-radius:6px; margin-top:10px; text-align:center; letter-spacing:0.04em;">'
                'SHOP NOW →</div>'
                '</td></tr></table></a></td>'
            )
        # Pair cards into 2-col rows
        rows = []
        for i in range(0, len(cards), 2):
            row_cards = cards[i:i + 2]
            if len(row_cards) == 1:
                row_cards.append('<td style="width:50%;"></td>')
            rows.append(f'<tr>{"".join(row_cards)}</tr>')
        products_html = (
            '<div style="margin:28px -8px 0;">'
            '<div style="font-size:11px; font-weight:700; letter-spacing:0.12em; '
            'text-transform:uppercase; color:#a8a29e; padding:0 16px 10px; text-align:center;">Featured this week</div>'
            f'<table role="presentation" width="100%" cellspacing="0" cellpadding="0">{"".join(rows)}</table>'
            '</div>'
        )

    unsubscribe_url = ""
    if cust.get("email"):
        unsubscribe_url = make_unsubscribe_url(cust["email"], campaign_id=campaign_id)

    return f"""
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width:620px; margin:0 auto; color:#1a1a2e; background:#f9fafb;">
      <div style="background:#1C1917; padding:18px 24px;">
        <h1 style="color:#F7EA1C; margin:0; font-size:20px; letter-spacing:-0.3px;">Tile Station</h1>
      </div>
      <div style="background:#fff; padding:30px 24px;">
        {hero}
        <div style="font-size:15px; line-height:1.65; color:#262626;">
          {body}
        </div>
        {cta}
        {products_html}
      </div>
      <div style="text-align:center; padding:18px 24px; color:#a8a29e; font-size:11px; line-height:1.6;">
        Tile Station · Unit 3 Trade City, Coldharbour Road, Northfleet, Gravesend DA11 8AB<br/>
        Company No: 11982550 · VAT No: 324 251 828<br/>
        {f'<a href="{unsubscribe_url}" style="color:#a8a29e; text-decoration:underline;">Unsubscribe</a>' if unsubscribe_url else ''}
      </div>
    </div>
    """


# =============================================================================
# CAMPAIGN DISPATCH
# =============================================================================

async def _send_one(*, customer: dict, subject: str, html: str) -> dict:
    if not RESEND_AVAILABLE or not RESEND_API_KEY:
        return {"sent": False, "error": "resend_not_configured"}
    try:
        resend.api_key = RESEND_API_KEY
        await asyncio.to_thread(resend.Emails.send, {
            "from": f"{COMPANY_NAME} <{SENDER_EMAIL}>",
            "to": [customer["email"]],
            "reply_to": "online@tilestation.co.uk",
            "subject": subject,
            "html": html,
            "headers": {
                "List-Unsubscribe": f"<{make_unsubscribe_url(customer['email'])}>",
                "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            },
        })
        return {"sent": True, "error": None}
    except Exception as exc:
        logger.exception("Email Hub send failed for %s: %s", customer.get("email"), exc)
        return {"sent": False, "error": str(exc)[:200]}


def _normalise_image(img: Any) -> str:
    """Image fields can be either a plain URL string or a
    `{url, alt, alt_generated_at}` dict (post-May-2026 SEO migration).
    Returns a clean URL string or empty."""
    if isinstance(img, str):
        return img
    if isinstance(img, dict):
        for k in ("url", "src", "large", "thumbnail", "path", "href"):
            v = img.get(k)
            if isinstance(v, str) and v:
                return v
    return ""


def _product_to_card(p: dict) -> dict:
    """Trim a tiles document to the lean payload the email renderer needs."""
    images = p.get("images") or []
    img_url = _normalise_image(images[0]) if images else ""
    slug = p.get("slug") or p.get("id") or p.get("sku") or ""
    price = p.get("price")
    return {
        "id": p.get("id") or p.get("sku"),
        "sku": p.get("sku"),
        "name": p.get("display_name") or p.get("name") or "",
        "image": img_url,
        "price": float(price) if price is not None else None,
        "url": f"{COMPANY_WEBSITE}/shop/product/{slug}" if slug else COMPANY_WEBSITE,
    }


@router.get("/admin/email-hub/products/search")
async def admin_product_search(
    q: str = Query("", max_length=120),
    limit: int = Query(24, ge=1, le=60),
    current_user: dict = Depends(get_current_user),
):
    """Search the tile catalogue for picker results — display_name + series_name
    + sku, prioritise items with images + a price + that are active."""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    base_filter: dict[str, Any] = {
        "is_active": {"$ne": False},
        "images.0": {"$exists": True},
        "price": {"$gt": 0},
    }
    if q.strip():
        # Case-insensitive substring match across the user-visible fields
        rx = {"$regex": re.escape(q.strip()), "$options": "i"}
        base_filter["$or"] = [
            {"display_name": rx},
            {"name": rx},
            {"series_name": rx},
            {"sku": rx},
            {"color": rx},
            {"category": rx},
        ]
    cursor = db.tiles.find(
        base_filter,
        {"_id": 0, "id": 1, "sku": 1, "display_name": 1, "name": 1,
         "images": 1, "price": 1, "slug": 1, "is_featured": 1,
         "series_name": 1, "category": 1},
    ).sort([("is_featured", -1), ("display_name", 1)]).limit(limit)
    items = [_product_to_card(p) async for p in cursor]
    return {"results": items, "count": len(items)}


async def _execute_campaign(campaign_id: str) -> dict:
    """Resolve the audience, dispatch one email per recipient, write events.
    Idempotent: if the campaign is already 'sent' it returns its prior result.
    """
    db = get_db()
    campaign = await db.email_campaigns.find_one({"id": campaign_id}, {"_id": 0})
    if not campaign:
        return {"sent": 0, "failed": 0, "error": "campaign_not_found"}
    if campaign.get("status") == "sent":
        return campaign.get("result_summary") or {"sent": 0, "failed": 0}

    await db.email_campaigns.update_one(
        {"id": campaign_id},
        {"$set": {"status": "sending", "send_started_at": datetime.now(timezone.utc).isoformat()}},
    )

    aud = AudienceDef(**campaign["audience"])
    res = await resolve_audience(db, aud, sample_size=0)
    emails = res["emails"]

    # Pull the full customer record for each email so merge tags work
    cust_index: dict[str, dict] = {}
    cursor = db.shop_customers.find(
        {"email": {"$in": list(emails)}},
        {"_id": 0, "email": 1, "name": 1, "business_name": 1, "credit_balance": 1, "is_trade": 1},
    )
    async for doc in cursor:
        e = (doc.get("email") or "").lower().strip()
        if e:
            cust_index[e] = doc

    sent = failed = 0
    errors: list[dict] = []
    for email in emails:
        cust = cust_index.get(email) or {"email": email}
        cust["email"] = email
        body_html = render_campaign_html(
            subject=campaign["subject"],
            body_html=campaign["body_html"],
            hero_image_url=campaign.get("hero_image_url") or "",
            cta_text=campaign.get("cta_text") or "",
            cta_url=campaign.get("cta_url") or "",
            featured_products=campaign.get("featured_products") or None,
            customer=cust,
            campaign_id=campaign_id,
        )
        merged_subject = _merge_vars(campaign["subject"], cust)
        result = await _send_one(customer=cust, subject=merged_subject, html=body_html)
        evt = {
            "campaign_id": campaign_id,
            "email": email,
            "event_type": "sent" if result["sent"] else "failed",
            "event_at": datetime.now(timezone.utc).isoformat(),
            "error": result.get("error"),
        }
        await db.email_recipient_events.insert_one(evt)
        if result["sent"]:
            sent += 1
        else:
            failed += 1
            if len(errors) < 25:
                errors.append({"email": email, "error": result.get("error")})

    summary = {
        "audience_count": len(emails),
        "sent": sent,
        "failed": failed,
        "errors": errors[:25],
        "completed_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.email_campaigns.update_one(
        {"id": campaign_id},
        {"$set": {"status": "sent", "result_summary": summary, "sent_at": summary["completed_at"]}},
    )
    return summary


# =============================================================================
# ADMIN ENDPOINTS
# =============================================================================

@router.post("/admin/email-hub/audience/preview")
async def admin_audience_preview(
    audience: AudienceDef,
    current_user: dict = Depends(get_current_user),
):
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    res = await resolve_audience(db, audience, sample_size=10)
    return {
        "count": res["count"],
        "total_credit": res["total_credit"],
        "sample": res["sample"],
        "suppressed_count": res["suppressed_count"],
    }


class FeaturedProduct(BaseModel):
    id: Optional[str] = None
    sku: Optional[str] = None
    name: str
    image: str
    price: Optional[float] = None
    url: str


class TestSendBody(BaseModel):
    email: str = Field(..., min_length=3)
    subject: str
    body_html: str
    hero_image_url: Optional[str] = None
    cta_text: Optional[str] = None
    cta_url: Optional[str] = None
    featured_products: Optional[list[FeaturedProduct]] = None


@router.post("/admin/email-hub/send-test")
async def admin_send_test(
    body: TestSendBody,
    current_user: dict = Depends(get_current_user),
):
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    if not EMAIL_RX.match(body.email):
        raise HTTPException(status_code=400, detail="Invalid email")
    db = get_db()
    cust = await db.shop_customers.find_one(
        {"email": body.email.lower().strip()},
        {"_id": 0, "email": 1, "name": 1, "business_name": 1, "credit_balance": 1, "is_trade": 1},
    ) or {"email": body.email.lower().strip()}
    products_payload = (
        [p.model_dump() for p in body.featured_products] if body.featured_products else None
    )
    html = render_campaign_html(
        subject=body.subject,
        body_html=body.body_html,
        hero_image_url=body.hero_image_url or "",
        cta_text=body.cta_text or "",
        cta_url=body.cta_url or "",
        featured_products=products_payload,
        customer=cust,
        campaign_id="test",
    )
    merged_subject = _merge_vars(body.subject, cust)
    res = await _send_one(customer=cust, subject=f"[TEST] {merged_subject}", html=html)
    if not res.get("sent"):
        raise HTTPException(status_code=502, detail=res.get("error") or "send_failed")
    return {"sent": True, "to": cust["email"]}


class CreateCampaignBody(BaseModel):
    subject: str = Field(..., min_length=1, max_length=300)
    body_html: str = Field(..., min_length=1)
    hero_image_url: Optional[str] = None
    cta_text: Optional[str] = None
    cta_url: Optional[str] = None
    featured_products: Optional[list[FeaturedProduct]] = None
    audience: AudienceDef
    scheduled_for: Optional[str] = None  # ISO timestamp; None = send now
    name: Optional[str] = None  # admin-friendly label
    template_id: Optional[str] = None  # if cloned from a template


@router.post("/admin/email-hub/campaigns")
async def admin_create_campaign(
    body: CreateCampaignBody,
    background: BackgroundTasks,
    current_user: dict = Depends(get_current_user),
):
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    aud_resolved = await resolve_audience(db, body.audience, sample_size=0)
    if aud_resolved["count"] == 0:
        raise HTTPException(status_code=400, detail="Audience is empty (after suppression filter)")

    cid = secrets.token_urlsafe(10)
    now = datetime.now(timezone.utc)
    is_scheduled = bool(body.scheduled_for and body.scheduled_for > now.isoformat())
    doc = {
        "id": cid,
        "name": body.name or body.subject[:80],
        "subject": body.subject,
        "body_html": body.body_html,
        "hero_image_url": body.hero_image_url,
        "cta_text": body.cta_text,
        "cta_url": body.cta_url,
        "featured_products": (
            [p.model_dump() for p in body.featured_products] if body.featured_products else None
        ),
        "audience": body.audience.model_dump(),
        "audience_count_at_create": aud_resolved["count"],
        "template_id": body.template_id,
        "scheduled_for": body.scheduled_for if is_scheduled else None,
        "status": "scheduled" if is_scheduled else "queued",
        "created_at": now.isoformat(),
        "created_by": current_user.get("email"),
    }
    await db.email_campaigns.insert_one(doc)

    if not is_scheduled:
        background.add_task(_execute_campaign, cid)

    return {"id": cid, "status": doc["status"], "audience_count": aud_resolved["count"]}


@router.get("/admin/email-hub/campaigns")
async def admin_list_campaigns(
    limit: int = Query(50, ge=1, le=500),
    skip: int = Query(0, ge=0),
    current_user: dict = Depends(get_current_user),
):
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    cursor = db.email_campaigns.find({}, {"_id": 0}).sort("created_at", -1).skip(skip).limit(limit)
    return {"campaigns": [c async for c in cursor]}


@router.get("/admin/email-hub/campaigns/{campaign_id}")
async def admin_campaign_detail(
    campaign_id: str,
    current_user: dict = Depends(get_current_user),
):
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    c = await db.email_campaigns.find_one({"id": campaign_id}, {"_id": 0})
    if not c:
        raise HTTPException(status_code=404, detail="Campaign not found")
    # Aggregate per-event analytics
    events: dict[str, int] = {"sent": 0, "delivered": 0, "opened": 0, "clicked": 0, "bounced": 0, "complained": 0, "failed": 0}
    async for ev in db.email_recipient_events.find({"campaign_id": campaign_id}, {"_id": 0, "event_type": 1}):
        t = (ev.get("event_type") or "").lower()
        if t in events:
            events[t] += 1
    # Unique opens / clicks
    unique_opened = len(await db.email_recipient_events.distinct("email", {"campaign_id": campaign_id, "event_type": "opened"}))
    unique_clicked = len(await db.email_recipient_events.distinct("email", {"campaign_id": campaign_id, "event_type": "clicked"}))
    return {
        "campaign": c,
        "analytics": {
            "events": events,
            "unique_opened": unique_opened,
            "unique_clicked": unique_clicked,
            "open_rate": round(100.0 * unique_opened / max(events["sent"], 1), 1),
            "click_rate": round(100.0 * unique_clicked / max(events["sent"], 1), 1),
        },
    }


@router.post("/admin/email-hub/campaigns/{campaign_id}/cancel")
async def admin_cancel_campaign(
    campaign_id: str,
    current_user: dict = Depends(get_current_user),
):
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    res = await db.email_campaigns.update_one(
        {"id": campaign_id, "status": {"$in": ["scheduled", "queued"]}},
        {"$set": {"status": "cancelled", "cancelled_at": datetime.now(timezone.utc).isoformat()}},
    )
    if res.modified_count == 0:
        raise HTTPException(status_code=400, detail="Campaign not cancellable in its current state")
    return {"cancelled": True}


# ----- Templates ------------------------------------------------------------

class TemplateBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    subject: str
    body_html: str
    hero_image_url: Optional[str] = None
    cta_text: Optional[str] = None
    cta_url: Optional[str] = None


@router.get("/admin/email-hub/templates")
async def admin_list_templates(current_user: dict = Depends(get_current_user)):
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    cursor = db.email_templates.find({}, {"_id": 0}).sort("updated_at", -1)
    return {"templates": [t async for t in cursor]}


@router.post("/admin/email-hub/templates")
async def admin_create_template(
    body: TemplateBody,
    current_user: dict = Depends(get_current_user),
):
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    tid = secrets.token_urlsafe(8)
    doc = {
        "id": tid,
        **body.model_dump(),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "created_by": current_user.get("email"),
    }
    await db.email_templates.insert_one(doc)
    return {"id": tid}


@router.delete("/admin/email-hub/templates/{template_id}")
async def admin_delete_template(
    template_id: str,
    current_user: dict = Depends(get_current_user),
):
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    res = await db.email_templates.delete_one({"id": template_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Template not found")
    return {"deleted": True}


# ----- Suppressions --------------------------------------------------------

@router.get("/admin/email-hub/suppressions")
async def admin_list_suppressions(
    limit: int = Query(500, ge=1, le=5000),
    current_user: dict = Depends(get_current_user),
):
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    cursor = db.email_preferences.find(
        {"unsubscribed_at": {"$exists": True}},
        {"_id": 0},
    ).sort("unsubscribed_at", -1).limit(limit)
    return {"suppressions": [s async for s in cursor]}


class SuppressionAddBody(BaseModel):
    email: str
    reason: Optional[str] = None


@router.post("/admin/email-hub/suppressions")
async def admin_add_suppression(
    body: SuppressionAddBody,
    current_user: dict = Depends(get_current_user),
):
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    if not EMAIL_RX.match(body.email):
        raise HTTPException(status_code=400, detail="Invalid email")
    db = get_db()
    await db.email_preferences.update_one(
        {"email": body.email.lower().strip()},
        {"$set": {
            "email": body.email.lower().strip(),
            "unsubscribed_at": datetime.now(timezone.utc).isoformat(),
            "source": "admin_added",
            "reason": body.reason,
            "added_by": current_user.get("email"),
        }},
        upsert=True,
    )
    return {"added": True}


@router.delete("/admin/email-hub/suppressions/{email}")
async def admin_remove_suppression(
    email: str,
    current_user: dict = Depends(get_current_user),
):
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    await db.email_preferences.update_one(
        {"email": email.lower().strip()},
        {"$unset": {"unsubscribed_at": "", "unsubscribed_from": ""},
         "$set": {"resubscribed_at": datetime.now(timezone.utc).isoformat()}},
    )
    return {"removed": True}


# =============================================================================
# RESEND WEBHOOK
# =============================================================================
# Resend sends events with a Svix signature header. For now we accept any
# request that carries a shared-secret query parameter (`?key=...`) — set
# this in the Resend dashboard webhook URL.
# https://resend.com/docs/dashboard/webhooks/introduction


@router.post("/webhooks/resend")
async def resend_webhook(request: Request, key: str = Query("")):
    """Ingests email events: delivered, bounced, opened, clicked, complained."""
    # Lightweight auth: shared secret in the URL. If the env secret is empty,
    # we accept anything (development convenience).
    if RESEND_WEBHOOK_SECRET and not hmac.compare_digest(key, RESEND_WEBHOOK_SECRET):
        raise HTTPException(status_code=401, detail="Invalid webhook key")
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Bad JSON")

    db = get_db()
    event_type = (payload.get("type") or payload.get("event") or "").split(".")[-1].lower()
    data = payload.get("data") or {}
    if not event_type:
        return {"ignored": True}

    # Resend tags the email's `headers.X-Campaign-ID` if we set it; we use
    # the `tags` array (preferred) but fall back to email lookup.
    campaign_id = ""
    tags = data.get("tags") or []
    for t in tags:
        if (t or {}).get("name") == "campaign_id":
            campaign_id = (t or {}).get("value") or ""
            break

    # Find the recipient email
    to_email = ""
    if isinstance(data.get("to"), list) and data["to"]:
        to_email = data["to"][0]
    elif isinstance(data.get("to"), str):
        to_email = data["to"]
    elif data.get("email"):
        to_email = data["email"]
    to_email = (to_email or "").lower().strip()

    # If no campaign tag, infer from the most recent prior `sent` event for this email
    if not campaign_id and to_email:
        prior = await db.email_recipient_events.find_one(
            {"email": to_email, "event_type": "sent"},
            sort=[("event_at", -1)],
            projection={"_id": 0, "campaign_id": 1},
        )
        if prior:
            campaign_id = prior.get("campaign_id", "")

    await db.email_recipient_events.insert_one({
        "campaign_id": campaign_id,
        "email": to_email,
        "event_type": event_type,
        "event_at": datetime.now(timezone.utc).isoformat(),
        "raw": payload,
    })

    # Auto-suppress hard bounces and complaints — protects sender reputation
    if event_type in ("bounced", "complained") and to_email:
        await db.email_preferences.update_one(
            {"email": to_email},
            {"$set": {
                "email": to_email,
                "unsubscribed_at": datetime.now(timezone.utc).isoformat(),
                "source": f"auto_{event_type}",
            }},
            upsert=True,
        )

    return {"ok": True, "event_type": event_type, "campaign_id": campaign_id}


# =============================================================================
# SCHEDULER TICK — fires scheduled campaigns whose time has come
# =============================================================================

async def run_email_hub_schedule_tick():
    """Hourly: find any campaigns with status=scheduled whose scheduled_for
    is in the past, kick them off."""
    db = get_db()
    now_iso = datetime.now(timezone.utc).isoformat()
    cursor = db.email_campaigns.find(
        {"status": "scheduled", "scheduled_for": {"$lte": now_iso}},
        {"_id": 0, "id": 1},
    )
    fired = 0
    async for c in cursor:
        cid = c.get("id")
        if not cid:
            continue
        await db.email_campaigns.update_one(
            {"id": cid},
            {"$set": {"status": "queued"}},
        )
        try:
            await _execute_campaign(cid)
        except Exception as exc:
            logger.exception("Scheduled campaign %s failed: %s", cid, exc)
            await db.email_campaigns.update_one(
                {"id": cid},
                {"$set": {"status": "failed", "error": str(exc)[:200]}},
            )
        fired += 1
    if fired:
        logger.info("[email-hub] fired %s scheduled campaigns", fired)



# ─── Email signature preview & test endpoints ────────────────────────────
# Built 21 May 2026 per owner request: "Can you design a nice email
# signature for all stores with our logo." This lets admins preview the
# rendered signature for each showroom (and optionally send a test email
# to any address) without having to invoice a real customer.

@router.get("/admin/email-signatures/preview")
async def preview_email_signature(
    showroom: str = "gravesend",
    sender_name: str = "",
    current_user: dict = Depends(get_current_user),
):
    """Render the per-showroom HTML signature so admins can preview it.

    Query params:
        showroom: slug — gravesend / tonbridge / chingford / sydenham
        sender_name: optional staff name to render above the showroom name
    """
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin only")
    from services.email import (
        render_email_signature, SHOWROOM_CONTACTS, get_showroom_contact,
    )
    sig_html = render_email_signature(
        showroom=showroom,
        sender_name=sender_name or None,
    )
    contact = get_showroom_contact(showroom)
    return {
        "showroom": showroom,
        "contact": contact,
        "html": sig_html,
        "available_showrooms": list(SHOWROOM_CONTACTS.keys()),
    }


class _SignatureTestRequest(BaseModel):
    to: EmailStr
    showroom: str = "gravesend"
    sender_name: str = ""


@router.post("/admin/email-signatures/send-test")
async def send_signature_test_email(
    payload: _SignatureTestRequest,
    current_user: dict = Depends(get_current_user),
):
    """Send a one-off preview email containing the per-showroom signature.

    Used by the admin so they can see how it actually renders in Gmail /
    Outlook / Apple Mail without invoicing a real customer.
    """
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin only")
    if not RESEND_AVAILABLE or not RESEND_API_KEY:
        raise HTTPException(status_code=503, detail="Resend not configured")

    from services.email import render_email_signature, get_showroom_contact
    contact = get_showroom_contact(payload.showroom)
    sig_html = render_email_signature(
        showroom=payload.showroom,
        sender_name=payload.sender_name or None,
    )
    body = f"""
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:620px;color:#1f2937;">
      <p style="font-size:15px;line-height:1.55;">Hi,</p>
      <p style="font-size:15px;line-height:1.55;">
        This is a preview of the new <strong>{contact['name']}</strong>
        email signature. The block below will appear at the bottom of
        every invoice / order confirmation we send to customers from this
        showroom.
      </p>
      <p style="font-size:15px;line-height:1.55;">
        If anything looks off (logo not loading, wrong phone number, etc.)
        reply directly to this email and we'll fix it.
      </p>
      <p style="font-size:15px;line-height:1.55;">Thanks,<br/>The Tile Station Team</p>
      {sig_html}
    </div>
    """
    resend.api_key = RESEND_API_KEY
    try:
        send_result = await asyncio.to_thread(resend.Emails.send, {
            "from": f"{contact['name']} <{contact['email']}>",
            "to": [payload.to],
            "reply_to": [contact['email']],
            "subject": f"[Preview] {contact['name']} email signature",
            "html": body,
        })
        return {
            "success": True,
            "id": (send_result or {}).get("id"),
            "to": payload.to,
            "from": contact['email'],
            "showroom": payload.showroom,
        }
    except Exception as exc:
        logger.exception("Email signature test send failed")
        raise HTTPException(status_code=502, detail=f"Send failed: {exc}")

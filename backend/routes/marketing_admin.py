"""
Marketing & SEO admin module.

Surfaces three retail-acquisition tools and a read-only SEO audit:
  • Trade-signup QR (per-showroom configurable landing page + UTM)
  • Referral-programme rules (configurable triggers: signup / approved / first-paid)
  • Showroom in-person email capture (public POST, opt-in checkbox, admin viewer + CSV)
  • SEO health audit (sitemap.xml, robots.txt, meta-description coverage, canonical tags)

All settings live in the existing `website_settings` collection under the
`marketing` key so we don't add a new collection just to hold a dict.
Captured leads live in `marketing_leads`.

Mounted at `/api/marketing/*` from `server.py`.
"""
from datetime import datetime, timezone
from typing import Optional
from io import StringIO
import csv
import logging
import os

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, EmailStr, Field

from config import get_db
from services import get_current_user

router = APIRouter(prefix="/marketing", tags=["Marketing"])
logger = logging.getLogger(__name__)


# ── Default config (used when no document exists yet) ────────────────────
DEFAULT_SETTINGS = {
    "qr": {
        # Per-showroom landing page configuration. The list is keyed by
        # showroom_id so each store can point to its own promo / UTM combo.
        # The `default` entry is used when a showroom has no override.
        "default": {
            "label": "Trade Signup",
            "destination": "/shop/trade/register",
            "utm_source": "showroom_qr",
            "utm_medium": "print",
            "utm_campaign": "trade_signup",
            "utm_content": "default",
        },
        "per_showroom": {},  # { "<showroom_id>": { ...same shape... } }
    },
    "referrals": {
        "enabled": True,
        # Three independent triggers — admin can toggle any combination ON,
        # set the £ reward, and decide whether the REFERRED party ALSO
        # receives a welcome credit (£0 disables it).
        "trigger_signup": {
            "enabled": False,
            "referrer_amount": 5,
            "referee_amount": 0,
        },
        "trigger_approved": {
            "enabled": True,
            "referrer_amount": 25,
            "referee_amount": 25,
        },
        "trigger_first_paid": {
            "enabled": False,
            "referrer_amount": 50,
            "referee_amount": 0,
            "min_order_total": 250,
        },
        "share_message": (
            "I'm using Tile Station for trade tiles — sign up with my code "
            "and we both get £25 credit on our first order."
        ),
    },
    "lead_capture": {
        "enabled": True,
        "title": "Hear about trade offers + new collections",
        "subtitle": (
            "Drop your email below. We'll only message you about new "
            "ranges, trade promos, and showroom events. Unsubscribe anytime."
        ),
        "consent_text": (
            "I agree to receive marketing emails from Tile Station and "
            "understand I can opt out at any time."
        ),
        "success_message": "Thanks — you're on the list. See you soon!",
    },
}


async def _get_settings(db) -> dict:
    """Read marketing settings, deep-merging with defaults so the response
    is always shaped predictably even when the admin hasn't customised yet."""
    doc = await db.website_settings.find_one(
        {"key": "marketing"}, {"_id": 0, "value": 1},
    )
    stored = (doc or {}).get("value") or {}
    merged = {
        "qr": {**DEFAULT_SETTINGS["qr"], **(stored.get("qr") or {})},
        "referrals": {**DEFAULT_SETTINGS["referrals"], **(stored.get("referrals") or {})},
        "lead_capture": {**DEFAULT_SETTINGS["lead_capture"], **(stored.get("lead_capture") or {})},
    }
    # Ensure nested per_showroom dict is preserved
    if "qr" in stored and "per_showroom" in stored["qr"]:
        merged["qr"]["per_showroom"] = stored["qr"]["per_showroom"]
    # Deep-merge referral trigger blocks so partial updates don't drop fields
    for key in ("trigger_signup", "trigger_approved", "trigger_first_paid"):
        merged["referrals"][key] = {
            **DEFAULT_SETTINGS["referrals"][key],
            **((stored.get("referrals") or {}).get(key) or {}),
        }
    return merged


def _is_admin(user: dict) -> bool:
    return (user or {}).get("role") in {"super_admin", "admin", "manager"}


# ──────────────────────── ADMIN — settings ──────────────────────────────

@router.get("/admin/settings")
async def admin_get_marketing_settings(current_user: dict = Depends(get_current_user)):
    if not _is_admin(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    return await _get_settings(db)


class MarketingSettingsPayload(BaseModel):
    qr: Optional[dict] = None
    referrals: Optional[dict] = None
    lead_capture: Optional[dict] = None


@router.put("/admin/settings")
async def admin_put_marketing_settings(
    payload: MarketingSettingsPayload,
    current_user: dict = Depends(get_current_user),
):
    if not _is_admin(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    current = await _get_settings(db)
    if payload.qr is not None:
        current["qr"].update(payload.qr)
    if payload.referrals is not None:
        # Triggers are dicts — merge them in instead of overwriting wholesale
        for key in ("trigger_signup", "trigger_approved", "trigger_first_paid"):
            if key in payload.referrals:
                current["referrals"][key] = {
                    **current["referrals"][key],
                    **payload.referrals[key],
                }
        for key, val in payload.referrals.items():
            if key not in ("trigger_signup", "trigger_approved", "trigger_first_paid"):
                current["referrals"][key] = val
    if payload.lead_capture is not None:
        current["lead_capture"].update(payload.lead_capture)

    await db.website_settings.update_one(
        {"key": "marketing"},
        {"$set": {"value": current, "updated_at": datetime.now(timezone.utc).isoformat()}},
        upsert=True,
    )
    return current


# ────────────────────── PUBLIC — settings + capture ────────────────────

@router.get("/public/lead-capture")
async def public_lead_capture_settings():
    """Public read of the showroom-signup landing page copy. No auth — the
    public page calls this on mount so the till tablet always shows whatever
    text the admin last published."""
    db = get_db()
    settings = await _get_settings(db)
    lc = settings["lead_capture"]
    return {
        "enabled": bool(lc.get("enabled", True)),
        "title": lc.get("title"),
        "subtitle": lc.get("subtitle"),
        "consent_text": lc.get("consent_text"),
        "success_message": lc.get("success_message"),
    }


class ShowroomSignupPayload(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    email: EmailStr
    consent: bool
    showroom_id: Optional[str] = None
    source: Optional[str] = "showroom_tablet"


@router.post("/showroom-signup")
async def showroom_signup(payload: ShowroomSignupPayload, request: Request):
    """Public — capture an email at the till tablet. Opt-in is mandatory:
    submitting `consent=False` returns 400 so we never store unconfirmed
    addresses for marketing use (GDPR/PECR-safe by design)."""
    if not payload.consent:
        raise HTTPException(
            status_code=400,
            detail="Consent is required to receive marketing emails.",
        )
    db = get_db()
    settings = await _get_settings(db)
    if not settings["lead_capture"].get("enabled", True):
        raise HTTPException(status_code=403, detail="Lead capture is disabled")

    email = payload.email.lower().strip()
    name = payload.name.strip()
    now = datetime.now(timezone.utc).isoformat()

    # Idempotent on email — a second submission updates the existing row
    # rather than creating a duplicate (useful when the same customer drops
    # in to multiple showrooms).
    update_doc = {
        "name": name,
        "email": email,
        "consent": True,
        "consent_at": now,
        "showroom_id": payload.showroom_id or "",
        "source": payload.source or "showroom_tablet",
        "ip": (request.client.host if request and request.client else None),
        "user_agent": request.headers.get("user-agent", "")[:300] if request else "",
        "updated_at": now,
    }
    await db.marketing_leads.update_one(
        {"email": email},
        {"$set": update_doc, "$setOnInsert": {"created_at": now}},
        upsert=True,
    )

    # ── Welcome email + £5-off voucher (best-effort, non-fatal) ──────────
    # Triggers ONLY on the FIRST signup (we look at $setOnInsert above to
    # decide whether the lead is new). Subsequent re-submits at other
    # showrooms refresh the row but don't spam the customer.
    voucher_code = None
    try:
        existing = await db.marketing_leads.find_one(
            {"email": email}, {"_id": 0, "welcome_email_sent_at": 1, "voucher_code": 1}
        )
        # NOTE: Mongo returns `{}` when none of the projected fields exist on
        # the doc — but the doc *is* there (we just upserted it). Use
        # `is not None` rather than truthiness so we don't accidentally skip
        # the welcome email path on every fresh signup.
        if existing is not None and not existing.get("welcome_email_sent_at"):
            from services.promo_codes import generate_promo_code_for_email
            from services.email import send_lead_welcome_email
            promo = await generate_promo_code_for_email(
                db,
                email=email,
                percent_off=5,
                expires_days=60,
                source="lead_welcome",
                prefix="WELCOME",
            )
            voucher_code = promo["code"]
            result = await send_lead_welcome_email(
                name=name, email=email,
                voucher_code=voucher_code,
                percent_off=promo["percent_off"],
                expires_at=promo["expires_at"],
            )
            await db.marketing_leads.update_one(
                {"email": email},
                {"$set": {
                    "welcome_email_sent_at": now if result.get("sent") else None,
                    "voucher_code": voucher_code,
                }},
            )
    except Exception as _welcome_err:
        # Lead is saved either way — welcome email is bonus, never block.
        logger.warning(f"[showroom-signup] welcome email failed: {_welcome_err}")

    return {
        "ok": True,
        "message": settings["lead_capture"].get("success_message", "Thanks!"),
        "voucher_issued": bool(voucher_code),
    }


# ────────────────────── ADMIN — leads viewer + CSV ──────────────────────

@router.get("/admin/leads")
async def admin_list_leads(
    limit: int = 200,
    current_user: dict = Depends(get_current_user),
):
    if not _is_admin(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    leads = await db.marketing_leads.find(
        {}, {"_id": 0}
    ).sort("created_at", -1).limit(max(1, min(int(limit), 1000))).to_list(1000)
    total = await db.marketing_leads.count_documents({})
    return {"total": total, "leads": leads}


@router.get("/admin/leads.csv")
async def admin_export_leads_csv(current_user: dict = Depends(get_current_user)):
    if not _is_admin(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    cursor = db.marketing_leads.find({}, {"_id": 0}).sort("created_at", -1)

    buf = StringIO()
    writer = csv.writer(buf)
    writer.writerow(["created_at", "name", "email", "consent_at", "showroom_id", "source"])
    async for row in cursor:
        writer.writerow([
            row.get("created_at", ""),
            row.get("name", ""),
            row.get("email", ""),
            row.get("consent_at", ""),
            row.get("showroom_id", ""),
            row.get("source", ""),
        ])
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="marketing-leads.csv"'},
    )


# ────────────────────────── SEO audit (read-only) ──────────────────────

def _site_origin() -> str:
    """Best guess at the production origin to probe. Falls back to the env
    var if available, else the live custom domain."""
    return (
        os.environ.get("PUBLIC_SITE_URL")
        or os.environ.get("FRONTEND_URL")
        or "https://tilestation.co.uk"
    ).rstrip("/")


@router.get("/admin/seo-audit")
async def admin_seo_audit(current_user: dict = Depends(get_current_user)):
    """Read-only audit — checks the live site for the four basics that
    most affect Google indexing: sitemap, robots.txt, canonical/OG tags
    on the homepage, meta-description coverage in the products collection.

    Never mutates anything; safe to run on production. Each check returns
    `{ok: bool, detail: str}` so the UI can render a green/amber/red chip.
    """
    if not _is_admin(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    origin = _site_origin()
    results = {"origin": origin, "checks": {}}

    async with httpx.AsyncClient(timeout=8.0, follow_redirects=True) as http:
        # Cloudflare bot-protection bypass (23 May 2026): real browser
        # UA + shared-secret header. See services/seo_self_audit.py for
        # the full rationale and the matching Cloudflare WAF rule.
        _audit_headers = {
            "User-Agent": (
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 "
                "TileStationSelfAudit"
            ),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-GB,en;q=0.9",
        }
        _audit_secret = os.environ.get("SEO_AUDIT_SHARED_SECRET", "")
        if _audit_secret:
            _audit_headers["X-SEO-Audit-Secret"] = _audit_secret

        # 1. sitemap.xml
        try:
            r = await http.get(f"{origin}/sitemap.xml", headers=_audit_headers)
            results["checks"]["sitemap"] = {
                "ok": r.status_code == 200 and ("<urlset" in r.text or "<sitemapindex" in r.text),
                "status": r.status_code,
                "detail": "Valid sitemap.xml found" if r.status_code == 200 else f"HTTP {r.status_code}",
            }
        except Exception as e:
            results["checks"]["sitemap"] = {"ok": False, "detail": f"Could not fetch: {e}"}

        # 2. robots.txt
        try:
            r = await http.get(f"{origin}/robots.txt", headers=_audit_headers)
            ok = r.status_code == 200 and "User-agent" in r.text
            results["checks"]["robots"] = {
                "ok": ok,
                "status": r.status_code,
                "detail": "robots.txt present" if ok else f"HTTP {r.status_code} or malformed",
            }
        except Exception as e:
            results["checks"]["robots"] = {"ok": False, "detail": f"Could not fetch: {e}"}

        # 3. Homepage canonical + OG tag presence
        try:
            r = await http.get(origin, headers=_audit_headers)
            html = r.text or ""
            has_canonical = 'rel="canonical"' in html or "rel='canonical'" in html
            has_og_title = 'property="og:title"' in html or "property='og:title'" in html
            has_meta_desc = 'name="description"' in html or "name='description'" in html
            results["checks"]["homepage_meta"] = {
                "ok": has_canonical and has_og_title and has_meta_desc,
                "detail": (
                    f"canonical: {'✓' if has_canonical else '✗'} · "
                    f"og:title: {'✓' if has_og_title else '✗'} · "
                    f"meta description: {'✓' if has_meta_desc else '✗'}"
                ),
            }
        except Exception as e:
            results["checks"]["homepage_meta"] = {"ok": False, "detail": f"Could not fetch: {e}"}

    # 4. Product meta-description coverage (database check, no HTTP)
    try:
        total = await db.products.count_documents({})
        with_desc = await db.products.count_documents({
            "$or": [
                {"description": {"$exists": True, "$ne": ""}},
                {"meta_description": {"$exists": True, "$ne": ""}},
            ]
        })
        coverage = round((with_desc / total) * 100, 1) if total > 0 else 0.0
        results["checks"]["product_descriptions"] = {
            "ok": coverage >= 80,
            "coverage_pct": coverage,
            "detail": f"{with_desc:,} of {total:,} products have a description ({coverage}%)",
        }
    except Exception as e:
        results["checks"]["product_descriptions"] = {"ok": False, "detail": f"Query failed: {e}"}

    return results

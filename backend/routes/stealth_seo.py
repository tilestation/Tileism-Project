"""Stealth-Keyword SEO admin routes — /api/admin/seo/stealth-keywords/*"""
from __future__ import annotations

import logging
import os
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from services import get_current_user
from services import stealth_seo

logger = logging.getLogger(__name__)


router = APIRouter(prefix="/admin/seo/stealth-keywords", tags=["Stealth SEO Keywords"])
public_router = APIRouter(prefix="/shop/seo/stealth-keywords", tags=["Stealth SEO public read"])


def _require_admin(user: dict):
    if (user or {}).get("role") not in ("admin", "super_admin"):
        raise HTTPException(status_code=403, detail="Admin access required")


# ───────── Public (SSR) read endpoint ─────────

@public_router.get("/collection/{collection}")
async def public_collection_keywords(collection: str):
    """Read-only endpoint the SSR enrich layer uses to inject
    collection-wide alternate names into /collections/<slug> meta
    tags. Anonymous access — keywords are public-by-design (they get
    indexed by Google).
    """
    keys = await stealth_seo.get_collection_keywords(collection)
    return {"collection": collection, "keywords": keys}


@router.get("/stats")
async def get_stats(current_user: dict = Depends(get_current_user)):
    _require_admin(current_user)
    return await stealth_seo.stats()


@router.get("/collections")
async def list_collections(current_user: dict = Depends(get_current_user)):
    _require_admin(current_user)
    return {"collections": await stealth_seo.list_collections_with_counts()}


@router.get("/products")
async def list_products(
    collection: Optional[str] = None,
    only_missing: bool = Query(False, description="Only show products without any stealth keywords"),
    limit: int = Query(200, ge=1, le=1000),
    current_user: dict = Depends(get_current_user),
):
    _require_admin(current_user)
    return {"products": await stealth_seo.list_products(
        collection=collection, only_missing=only_missing, limit=limit,
    )}


class SetProductKeywordsReq(BaseModel):
    keywords: list[str] = Field(default_factory=list)


@router.post("/products/{product_id}")
async def set_product_keywords(
    product_id: str,
    req: SetProductKeywordsReq,
    current_user: dict = Depends(get_current_user),
):
    _require_admin(current_user)
    try:
        return await stealth_seo.set_product_keywords(
            product_id, req.keywords,
            admin_email=(current_user or {}).get("email"),
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


class BulkApplyReq(BaseModel):
    collection: str
    keywords: list[str] = Field(default_factory=list)
    mode: str = Field("merge", pattern="^(merge|replace|append_supplier_original)$")


@router.post("/bulk-apply")
async def bulk_apply(
    req: BulkApplyReq,
    current_user: dict = Depends(get_current_user),
):
    _require_admin(current_user)
    try:
        return await stealth_seo.bulk_apply_to_collection(
            req.collection, req.keywords, mode=req.mode,
            admin_email=(current_user or {}).get("email"),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/auto-fill-all")
async def auto_fill_all(
    dry_run: bool = Query(False, description="Preview without writing"),
    current_user: dict = Depends(get_current_user),
):
    """One-click apply each product's own supplier-original name and
    supplier code as stealth keywords across the entire catalogue.

    Set `dry_run=true` to preview impact first.
    """
    _require_admin(current_user)
    return await stealth_seo.auto_fill_all_supplier_originals(
        dry_run=dry_run,
        admin_email=(current_user or {}).get("email"),
    )


# ───────── Performance attribution (joins GSC clicks vs catalogue) ─────────

class PromoteMissedReq(BaseModel):
    target: str = Field(..., pattern="^(product|collection)$")
    query: str
    product_id: Optional[str] = None
    collection: Optional[str] = None


@router.get("/performance")
async def get_performance(
    days: int = Query(28, ge=7, le=90),
    refresh: bool = Query(False, description="Bypass the 1-hour cache"),
    current_user: dict = Depends(get_current_user),
):
    """Returns a stealth-vs-brand performance breakdown for the last N
    days based on real Google Search Console clicks.

    Requires GSC to be connected. If not, returns an empty report with
    `gsc_connected: false` so the UI can show a connect-CTA.
    """
    _require_admin(current_user)
    from services import stealth_seo_performance as perf
    return await perf.get_performance(days=days, force_refresh=refresh)


@router.post("/performance/promote-missed-win")
async def promote_missed_win(
    payload: PromoteMissedReq,
    current_user: dict = Depends(get_current_user),
):
    """One-click "add this missed-wins query as a stealth keyword".
    Targets either a specific product (by id/slug) or a collection.
    Re-uses the existing set_product_keywords / set_collection_keywords
    so the rest of the stack just works.
    """
    _require_admin(current_user)
    if payload.target == "product":
        if not payload.product_id:
            raise HTTPException(status_code=400, detail="product_id is required for target=product")
        # Read current product keywords, merge new query
        from services.stealth_seo import _normalise
        from config import get_db as _get_db
        db_doc = await _get_db().tiles.find_one(
            {"id": payload.product_id},
            {"_id": 0, "hidden_seo_keywords": 1},
        )
        existing = _normalise((db_doc or {}).get("hidden_seo_keywords"))
        seen = {k.lower() for k in existing}
        if payload.query.lower() not in seen:
            existing.append(payload.query)
        try:
            return await stealth_seo.set_product_keywords(
                payload.product_id, existing,
                admin_email=(current_user or {}).get("email"),
            )
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc))
    if not payload.collection:
        raise HTTPException(status_code=400, detail="collection is required for target=collection")
    existing = await stealth_seo.get_collection_keywords(payload.collection)
    seen = {k.lower() for k in existing}
    if payload.query.lower() not in seen:
        existing.append(payload.query)
    return await stealth_seo.set_collection_keywords(
        payload.collection, existing,
        admin_email=(current_user or {}).get("email"),
    )


# ───────── Weekly digest email ─────────

class DigestSettingsPatch(BaseModel):
    enabled: Optional[bool] = None
    recipients: Optional[list[str]] = None
    auto_promote_enabled: Optional[bool] = None
    auto_promote_min_impressions: Optional[int] = None
    auto_promote_batch_mode: Optional[bool] = None
    auto_promote_batch_max: Optional[int] = None
    auto_local_seed_enabled: Optional[bool] = None


@router.get("/digest/settings")
async def get_digest_settings(current_user: dict = Depends(get_current_user)):
    _require_admin(current_user)
    from services import stealth_seo_digest as digest
    return await digest.get_settings()


@router.put("/digest/settings")
async def update_digest_settings(
    patch: DigestSettingsPatch,
    current_user: dict = Depends(get_current_user),
):
    _require_admin(current_user)
    from services import stealth_seo_digest as digest
    return await digest.update_settings(
        patch.model_dump(exclude_none=True),
        admin_email=(current_user or {}).get("email"),
    )


@router.post("/digest/send-now")
async def send_digest_now(current_user: dict = Depends(get_current_user)):
    _require_admin(current_user)
    from services import stealth_seo_digest as digest
    return await digest.send_digest_now()


# ───────── Keyword-level attribution timeline ─────────

@router.get("/attribution/timeline")
async def get_attribution_timeline(
    days: int = Query(28, ge=7, le=90),
    scope: Optional[str] = Query(None, pattern="^(collection|city_page)$"),
    min_days_live: int = Query(0, ge=0, le=60),
    limit: int = Query(100, ge=1, le=500),
    current_user: dict = Depends(get_current_user),
):
    """Per-keyword 28-day sparkline + ROI score for every tracked
    stealth keyword. See `services/stealth_seo_kw_attribution.py`
    docstring for the full data model.
    """
    _require_admin(current_user)
    from services import stealth_seo_kw_attribution as attr
    return await attr.get_attribution_timeline(
        days=days, scope=scope, min_days_live=min_days_live, limit=limit,
    )


@router.post("/attribution/rebuild")
async def rebuild_attribution_cache(
    days: int = Query(28, ge=7, le=90),
    current_user: dict = Depends(get_current_user),
):
    """Pulls fresh daily GSC data and refreshes the timeline cache.
    Normally runs as a daily cron at 09:00 BST — this endpoint is
    the admin's on-demand refresh button."""
    _require_admin(current_user)
    from services import stealth_seo_kw_attribution as attr
    return await attr.rebuild_timeline_cache(days=days)


# ───────── Supplier margin intelligence ─────────

@router.get("/margin-intel")
async def get_margin_intel(
    top_n: int = Query(20, ge=5, le=100),
    refresh: bool = Query(False, description="Bypass the 1h cache"),
    current_user: dict = Depends(get_current_user),
):
    """Joins cost/price/supplier with GSC organic signal. Returns the
    top N highest-score products (margin × log1p(impressions)),
    price-test candidates (high-volume low-margin), and a supplier
    league table. Cached for 1 hour."""
    _require_admin(current_user)
    from services import supplier_margin_intel as mi
    return await mi.get_margin_report(top_n=top_n, force_refresh=refresh)


# ───────── CEO dashboard snapshot ─────────

@router.get("/dashboard/snapshot")
async def get_dashboard_snapshot(current_user: dict = Depends(get_current_user)):
    """30-second pulse-check rendered at the top of /admin/seo.
    Composes headline performance + top keyword + top product +
    margin coverage + auto-promote count + health status into a
    single resilient response. Individual section failures degrade
    to null — they never block the rest of the dashboard."""
    _require_admin(current_user)
    from services import seo_dashboard_snapshot as snapshot
    return await snapshot.get_snapshot()


@router.get("/lifetime-savings")
async def lifetime_savings(current_user: dict = Depends(get_current_user)):
    """Quantifies the £-savings from the autopilot stack vs equivalent
    UK agency cost. Conservative low-end rates so the headline figure
    is defensible. See `services/lifetime_savings.py` for the rates
    card and full math.
    """
    _require_admin(current_user)
    from services import lifetime_savings as ls
    return await ls.get_savings_report()


# ───── SEO Self-Audit ─────

@router.get("/self-audit/latest")
async def self_audit_latest(current_user: dict = Depends(get_current_user)):
    """Most recent audit report (cached). Empty until first run.

    Frontend hits this on page load — no slow re-probe; for that
    use /run-now.
    """
    _require_admin(current_user)
    from services import seo_self_audit as audit
    latest = await audit.get_latest_audit()
    return latest or {"score": None, "grade": "N/A", "checks": {}}


@router.post("/self-audit/run-now")
async def self_audit_run_now(current_user: dict = Depends(get_current_user)):
    """Triggers a full audit run. Takes ~5-15s depending on network.
    Persists the result + updates the latest pointer."""
    _require_admin(current_user)
    from services import seo_self_audit as audit
    return await audit.run_seo_audit(persist=True)


@router.get("/self-audit/history")
async def self_audit_history(
    limit: int = 30,
    current_user: dict = Depends(get_current_user),
):
    """Score history for trend graphing on the dashboard."""
    _require_admin(current_user)
    from services import seo_self_audit as audit
    rows = await audit.list_recent_audits(limit=min(max(limit, 1), 90))
    return {"rows": rows, "count": len(rows)}


@router.get("/activity")
async def get_activity_feed(
    limit: int = Query(30, ge=5, le=100),
    days: int = Query(30, ge=1, le=90),
    current_user: dict = Depends(get_current_user),
):
    """Time-ordered activity timeline merging auto-promotions, undos,
    digest sends, manual stealth-keyword audits, health transitions,
    and blog publishes. Lives below the dashboard snapshot.
    Each event has {kind, severity, at, message, cta_link?}."""
    _require_admin(current_user)
    from services import seo_activity_feed as activity
    return await activity.get_activity(limit=limit, days=days)


@router.get("/auto-promote/history")
async def list_auto_promote_history(
    limit: int = Query(10, ge=1, le=50),
    current_user: dict = Depends(get_current_user),
):
    _require_admin(current_user)
    from services import stealth_seo_auto_promote as ap
    rows = await ap.list_recent(limit=limit)
    # Don't expose raw tokens — short-id is enough for UI
    for r in rows:
        if "token" in r:
            r["token_hint"] = (r["token"][:6] + "…") if r.get("token") else None
            r.pop("token", None)
    return {"rows": rows}


@router.post("/auto-promote/undo/{record_id}")
async def admin_undo_auto_promote(
    record_id: str,
    current_user: dict = Depends(get_current_user),
):
    """Admin UI calls this by record id (token stays hidden)."""
    _require_admin(current_user)
    from services import stealth_seo_auto_promote as ap
    res = await ap.undo_by_record_id(record_id)
    if not res.get("ok"):
        raise HTTPException(status_code=404, detail="Auto-promotion not found")
    return res


# Public (no-auth) undo — the token IS the credential. The URL is
# embedded in the weekly digest email so the admin can one-click undo.
@public_router.get("/auto-promote/undo/{token}")
async def public_undo_auto_promote(token: str):
    from services import stealth_seo_auto_promote as ap
    res = await ap.undo_by_token(token)
    if not res.get("ok"):
        raise HTTPException(status_code=404, detail=res.get("reason", "not_found"))
    base = os.environ.get("FRONTEND_BASE_URL", "https://www.tilestation.co.uk").rstrip("/")
    rec = res.get("record") or {}
    already = " (already undone)" if res.get("already_undone") else ""
    html = f"""
    <!doctype html>
    <html lang="en"><head><meta charset="utf-8">
    <title>Stealth keyword undone · Tile Station</title>
    <style>body{{font-family:system-ui,sans-serif;background:#f8fafc;padding:60px 20px;text-align:center;color:#0f172a}}
    .card{{max-width:520px;margin:0 auto;background:white;border:2px solid #86efac;border-radius:12px;padding:40px 28px;box-shadow:0 4px 20px rgba(0,0,0,.04)}}
    h1{{color:#065f46;margin:0 0 8px 0;font-size:24px}}
    code{{background:#f1f5f9;padding:2px 6px;border-radius:4px;font-size:13px}}
    a.btn{{display:inline-block;margin-top:16px;background:#0f172a;color:white;padding:10px 18px;border-radius:6px;text-decoration:none;font-size:14px}}</style>
    </head><body>
    <div class="card">
      <h1>✅ Stealth keyword removed{already}</h1>
      <p>Removed <code>{rec.get('query')}</code> from the <strong>{rec.get('collection')}</strong> collection.</p>
      <p style="color:#64748b;font-size:13px">It'll re-appear in next week's "missed wins" so you can re-add it manually if you change your mind.</p>
      <a class="btn" href="{base}/admin/seo">Open dashboard</a>
    </div>
    </body></html>
    """
    from fastapi.responses import HTMLResponse
    return HTMLResponse(content=html)


# Collection-wide keyword set (added to every product in that collection
# at SSR-time, not stored on each tile)

class CollectionKeywordsReq(BaseModel):
    keywords: list[str] = Field(default_factory=list)


@router.get("/collection/{collection}")
async def get_collection_keywords(
    collection: str, current_user: dict = Depends(get_current_user),
):
    _require_admin(current_user)
    return {
        "collection": collection,
        "keywords": await stealth_seo.get_collection_keywords(collection),
    }


@router.post("/collection/{collection}")
async def set_collection_keywords(
    collection: str, req: CollectionKeywordsReq,
    current_user: dict = Depends(get_current_user),
):
    _require_admin(current_user)
    return await stealth_seo.set_collection_keywords(
        collection, req.keywords,
        admin_email=(current_user or {}).get("email"),
    )

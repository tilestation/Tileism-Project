"""
Marketing-email outbox admin API — 22 Jun 2026
══════════════════════════════════════════════

Endpoints powering the /admin/marketing/pending-emails page.

    GET    /api/marketing-outbox/settings         — read master flag
    PUT    /api/marketing-outbox/settings         — flip master flag
    GET    /api/marketing-outbox                  — list (paginated + filtered)
    GET    /api/marketing-outbox/{id}             — full doc (with HTML for preview)
    POST   /api/marketing-outbox/{id}/send        — approve + send now
    POST   /api/marketing-outbox/{id}/skip        — dismiss (no send)
    POST   /api/marketing-outbox/batch-send       — approve + send N
    GET    /api/marketing-outbox/stats            — small counts panel

Every mutation is gated to super_admin / admin / manager.
"""
import logging
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from config import get_db
from services import get_current_user
from services.marketing_outbox import (
    ALL_CATEGORIES,
    CATEGORY_LABELS,
    STATUS_PENDING,
    STATUS_SENT,
    STATUS_SKIPPED,
    STATUS_AUTO_SENT,
    STATUS_BLOCKED_RECENT_ORDER,
    STATUS_FAILED,
    is_manual_mode,
    set_manual_mode,
    send_from_outbox,
    skip_from_outbox,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/marketing-outbox", tags=["Marketing Outbox"])


def _require_admin(current_user: dict):
    if current_user.get("role") not in ("super_admin", "admin", "manager"):
        raise HTTPException(status_code=403, detail="Admin access required")


# ── Master flag ────────────────────────────────────────────────────

@router.get("/settings")
async def get_settings(current_user: dict = Depends(get_current_user)):
    _require_admin(current_user)
    db = get_db()
    manual = await is_manual_mode(db)
    return {"manual_mode": manual}


class SettingsUpdate(BaseModel):
    manual_mode: bool


@router.put("/settings")
async def update_settings(
    payload: SettingsUpdate,
    current_user: dict = Depends(get_current_user),
):
    _require_admin(current_user)
    db = get_db()
    await set_manual_mode(db, payload.manual_mode, current_user.get("email") or "admin")
    return {"manual_mode": payload.manual_mode}


# ── List / read ─────────────────────────────────────────────────────

@router.get("")
async def list_outbox(
    current_user: dict = Depends(get_current_user),
    status: str = Query("pending", description="'pending', 'sent', 'skipped', 'blocked_recent_order', 'all'"),
    category: Optional[str] = Query(None),
    search: Optional[str] = Query(None, description="Match against recipient email or name"),
    limit: int = Query(50, ge=1, le=200),
    skip: int = Query(0, ge=0),
):
    _require_admin(current_user)
    db = get_db()
    query: dict = {}

    if status and status != "all":
        query["status"] = status
    if category and category in ALL_CATEGORIES:
        query["category"] = category
    if search:
        q = search.strip().lower()
        query["$or"] = [
            {"recipient_email": {"$regex": q, "$options": "i"}},
            {"recipient_name": {"$regex": q, "$options": "i"}},
            {"subject": {"$regex": q, "$options": "i"}},
        ]

    total = await db.marketing_email_outbox.count_documents(query)
    # Small projection — we DON'T ship the full HTML in the list to
    # keep the page snappy. HTML is fetched on demand by the preview
    # modal via the /{id} endpoint.
    projection = {
        "_id": 0, "id": 1, "category": 1, "recipient_email": 1,
        "recipient_name": 1, "subject": 1, "preview": 1, "created_at": 1,
        "scheduled_for": 1, "status": 1, "source_ref": 1, "extra": 1,
        "acted_by": 1, "acted_at": 1,
    }
    rows = await (
        db.marketing_email_outbox
        .find(query, projection)
        .sort("created_at", -1)
        .skip(skip)
        .limit(limit)
        .to_list(limit)
    )
    # Decorate each row with a human-friendly category label so the
    # frontend doesn't have to maintain its own mapping.
    for r in rows:
        r["category_label"] = CATEGORY_LABELS.get(r.get("category", ""), r.get("category", ""))
    return {
        "items": rows,
        "total": total,
        "limit": limit,
        "skip": skip,
        "categories": [
            {"key": k, "label": CATEGORY_LABELS[k]} for k in sorted(ALL_CATEGORIES)
        ],
    }


@router.get("/stats")
async def outbox_stats(current_user: dict = Depends(get_current_user)):
    _require_admin(current_user)
    db = get_db()
    return {
        "pending":  await db.marketing_email_outbox.count_documents({"status": STATUS_PENDING}),
        "sent":     await db.marketing_email_outbox.count_documents({"status": STATUS_SENT}),
        "auto_sent": await db.marketing_email_outbox.count_documents({"status": STATUS_AUTO_SENT}),
        "skipped":  await db.marketing_email_outbox.count_documents({"status": STATUS_SKIPPED}),
        "blocked":  await db.marketing_email_outbox.count_documents({"status": STATUS_BLOCKED_RECENT_ORDER}),
        "failed":   await db.marketing_email_outbox.count_documents({"status": STATUS_FAILED}),
        "manual_mode": await is_manual_mode(db),
    }


@router.get("/{outbox_id}")
async def get_outbox_item(outbox_id: str, current_user: dict = Depends(get_current_user)):
    _require_admin(current_user)
    db = get_db()
    doc = await db.marketing_email_outbox.find_one({"id": outbox_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Not found")
    doc["category_label"] = CATEGORY_LABELS.get(doc.get("category", ""), doc.get("category", ""))
    return doc


# ── Mutations ───────────────────────────────────────────────────────

@router.post("/{outbox_id}/send")
async def send_one(
    outbox_id: str,
    force: bool = Query(False, description="Bypass the recent-completed-order safety net"),
    current_user: dict = Depends(get_current_user),
):
    _require_admin(current_user)
    db = get_db()
    result = await send_from_outbox(
        db, outbox_id, current_user.get("email") or "admin",
        skip_recent_order_guard=force,
    )
    if not result.get("ok"):
        # Still 200 — the frontend renders the error state inline.
        # Only 4xx if the ID doesn't exist / state is wrong AND the
        # user can't do anything about it.
        return result
    return result


class SkipPayload(BaseModel):
    reason: Optional[str] = ""


@router.post("/{outbox_id}/skip")
async def skip_one(
    outbox_id: str,
    payload: SkipPayload,
    current_user: dict = Depends(get_current_user),
):
    _require_admin(current_user)
    db = get_db()
    return await skip_from_outbox(
        db, outbox_id, current_user.get("email") or "admin",
        reason=(payload.reason or ""),
    )


class BatchSendPayload(BaseModel):
    ids: List[str]
    force: bool = False


@router.post("/batch-send")
async def batch_send(
    payload: BatchSendPayload,
    current_user: dict = Depends(get_current_user),
):
    _require_admin(current_user)
    db = get_db()
    results = []
    sent_count = 0
    for outbox_id in payload.ids[:100]:  # hard cap so a fat-finger can't blast the whole DB
        r = await send_from_outbox(
            db, outbox_id, current_user.get("email") or "admin",
            skip_recent_order_guard=payload.force,
        )
        results.append({"id": outbox_id, **r})
        if r.get("ok"):
            sent_count += 1
    return {"attempted": len(payload.ids), "sent": sent_count, "results": results}

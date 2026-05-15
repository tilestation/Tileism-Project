"""
Admin: request a fresh re-crawl from Ahrefs + GSC + IndexNow (May 15, 2026)
"""
from fastapi import APIRouter, Depends

from services import get_current_user
from services.seo_recrawl import (
    get_last_recrawl,
    request_full_recrawl,
)

router = APIRouter(prefix="/admin/seo", tags=["SEO Re-crawl"])


@router.post("/request-recrawl")
async def request_recrawl(current_user: dict = Depends(get_current_user)):
    """One-click: trigger Ahrefs site audit + GSC sitemap re-submit +
    IndexNow ping. Returns the per-service status so the UI can show
    granular success/failure."""
    triggered_by = current_user.get("email") or current_user.get("id") or "admin"
    return await request_full_recrawl(triggered_by=triggered_by)


@router.get("/last-recrawl")
async def last_recrawl(current_user: dict = Depends(get_current_user)):
    """Returns the most-recent recrawl request log (for the
    'last requested Xm ago' status indicator)."""
    doc = await get_last_recrawl()
    return doc or {}

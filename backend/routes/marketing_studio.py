"""
Marketing Studio routes.

Admin-facing endpoints for AI-generated banners, lifestyle product
photos and (later) social videos. Outputs are stored in Mongo
(`marketing_assets`) plus the underlying R2 storage, then can be
1-click-published to the homepage hero or to a site-wide promo
banner.

Endpoint map
------------
POST  /api/admin/marketing-studio/generate                → run model, save asset, return JSON
GET   /api/admin/marketing-studio/assets                  → list gallery (newest first)
DELETE /api/admin/marketing-studio/assets/{id}            → soft-delete an asset
POST  /api/admin/marketing-studio/assets/{id}/publish     → publish to hero | promo-banner
GET   /api/admin/marketing-studio/stats                   → lifetime spend + counts
GET   /api/admin/marketing-studio/promo-banner            → admin: live promo banner config
PUT   /api/admin/marketing-studio/promo-banner            → admin: update promo banner

GET   /api/website/marketing-media/{path:path}            → public byte serve (homepage img src)
GET   /api/website/promo-banner                           → public read of the active promo banner
"""
from __future__ import annotations

import os
import uuid
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import Response
from pydantic import BaseModel, Field

from config import get_db
from services import get_current_user

logger = logging.getLogger(__name__)

from utils.bulletproof import bulletproof_endpoint

router = APIRouter(prefix="/admin/marketing-studio", tags=["Marketing Studio"])
public_router = APIRouter(prefix="/website", tags=["Marketing Studio (public)"])


def _require_admin(user: dict):
    if (user or {}).get("role") not in ("super_admin", "admin", "manager"):
        raise HTTPException(status_code=403, detail="Admin access required")


# ------------------------------------------------------------------
# Models
# ------------------------------------------------------------------

class GenerateReq(BaseModel):
    prompt: str = Field(min_length=4, max_length=2000)
    model: str = Field(pattern="^(nano-banana|gpt-image-1)$")
    width: int = Field(ge=256, le=4096)
    height: int = Field(ge=256, le=4096)
    preset: str | None = None  # informational tag only ("hero", "ribbon"...)
    asset_kind: str = Field(default="banner", pattern="^(banner|hero|ribbon|lifestyle|social)$")
    num_variants: int = Field(default=1, ge=1, le=4)  # 1 or up to 4 parallel renders


class RefinePromptReq(BaseModel):
    prompt: str = Field(min_length=4, max_length=2000)
    width: int = Field(ge=256, le=4096)
    height: int = Field(ge=256, le=4096)
    model: str = Field(default="nano-banana", pattern="^(nano-banana|gpt-image-1)$")


class PublishReq(BaseModel):
    placement: str = Field(pattern="^(homepage_hero|promo_banner)$")
    link_url: str | None = None  # for promo_banner placement
    cta_text: str | None = None  # for homepage_hero placement
    auto_unpublish_at: str | None = None  # ISO datetime — when set, banner auto-disables at this time


class PromoBannerUpdate(BaseModel):
    enabled: bool | None = None
    image_url: str | None = None
    link_url: str | None = None
    alt_text: str | None = None
    schedule_enabled: bool | None = None
    scheduled_start: str | None = None
    scheduled_end: str | None = None


# ------------------------------------------------------------------
# Generate
# ------------------------------------------------------------------

# ------------------------------------------------------------------
# Refine prompt — text-only LLM, ~£0.0001 per call. Lets the admin
# iterate on the prompt for essentially free before paying for an
# actual image. Returns a critique + rewritten prompt the user can
# accept or ignore.
# ------------------------------------------------------------------

@router.post("/refine-prompt")
async def refine_prompt(req: RefinePromptReq, current_user: dict = Depends(get_current_user)):
    _require_admin(current_user)
    api_key = os.environ.get("EMERGENT_LLM_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="EMERGENT_LLM_KEY not set")

    from emergentintegrations.llm.chat import LlmChat, UserMessage
    aspect = req.width / max(1, req.height)
    aspect_label = "very wide horizontal" if aspect > 2.5 else (
        "wide horizontal" if aspect > 1.6 else (
            "near-square" if 0.85 < aspect < 1.15 else (
                "tall portrait" if aspect < 0.7 else "landscape"
            )
        )
    )
    system = (
        "You are an expert AI-image-prompt critic for a UK tile, bathroom and flooring retailer's "
        "marketing banner generator. The admin will give you their prompt, the target "
        "dimensions, and the model. You return STRICT JSON with three keys:\n"
        "  predicted: 1-2 sentences describing what the image will most likely show.\n"
        "  warnings: array of short strings flagging obvious issues. ALWAYS warn if "
        "the prompt asks for text+headline+offer but doesn't specify a safe zone or "
        "clear padding — text cropping is the single most common banner failure. "
        "Also warn about low-contrast headlines, brand colour conflicts, ambiguous "
        "subjects. Empty array if genuinely no issues.\n"
        "  refined_prompt: the prompt rewritten for best results in a SINGLE paragraph "
        "(<= 1000 chars). Keep the user's intent but MUST: (1) specify all text sits "
        "in the centre 60% of the frame with ~20% padding from every edge, (2) move "
        "text into the LEFT HALF of the frame with imagery in the right half when the "
        "banner is wider than 2:1, (3) centre the text block vertically around the "
        "45-55% y-band, (4) request brand colour gold #F7EA1C where the user asks for "
        "gold, (5) request magazine-quality photography. Do NOT invent products or "
        "guarantees the user didn't mention.\n"
        "Return ONLY valid JSON, no commentary, no code fences."
    )
    user_msg = (
        f"Target dimensions: {req.width}x{req.height} ({aspect_label}, ratio {aspect:.2f}:1)\n"
        f"Image model: {req.model}\n"
        f"Prompt:\n{req.prompt}"
    )

    try:
        chat = LlmChat(
            api_key=api_key,
            session_id=f"refine-{os.urandom(4).hex()}",
            system_message=system,
        )
        # Claude Haiku is the cheapest & fastest text model on the universal key.
        chat.with_model("anthropic", "claude-haiku-4-5-20251001")
        out = await chat.send_message(UserMessage(text=user_msg))
    except Exception as exc:  # noqa: BLE001
        logger.exception("Prompt refinement failed")
        raise HTTPException(status_code=502, detail=f"Refinement failed: {str(exc)[:200]}")

    text = (out or "").strip()
    # Strip code fences if the model added them despite instructions
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
        text = text.strip()
    import json as _json
    try:
        parsed = _json.loads(text)
    except Exception:
        # Best-effort fallback so the UI never crashes — just hand back the raw
        return {
            "predicted": "(could not parse model output)",
            "warnings": [],
            "refined_prompt": req.prompt,
            "raw": text[:500],
        }
    return {
        "predicted": str(parsed.get("predicted") or "")[:600],
        "warnings": [str(w)[:160] for w in (parsed.get("warnings") or []) if w][:6],
        "refined_prompt": str(parsed.get("refined_prompt") or req.prompt)[:1500],
    }


@router.post("/generate")
async def generate(req: GenerateReq, current_user: dict = Depends(get_current_user)):
    """Run the chosen model, store the bytes in R2, persist a Mongo
    record, return the asset metadata for the admin UI to render.

    With `num_variants > 1`, we fan out N parallel calls to the model
    and save each as its own gallery entry sharing a `variant_group_id`.
    Total cost is N × per-render cost — the admin UI surfaces this so
    nothing is hidden."""
    _require_admin(current_user)
    import asyncio
    from services.marketing_studio import generate_banner_image
    from services.object_storage import put_object

    n = max(1, min(4, int(req.num_variants or 1)))
    variant_group_id = uuid.uuid4().hex if n > 1 else None

    async def _one():
        try:
            return await generate_banner_image(
                prompt=req.prompt, model=req.model,
                width=req.width, height=req.height,
            )
        except Exception as exc:  # noqa: BLE001
            return {"error": str(exc)[:240]}

    try:
        results = await asyncio.gather(*[_one() for _ in range(n)])
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    # Persist each successful result as its own asset
    db = get_db()
    saved: list[dict] = []
    failed: list[str] = []
    now_iso = datetime.now(timezone.utc).isoformat()
    for idx, result in enumerate(results):
        if isinstance(result, dict) and result.get("error"):
            failed.append(result["error"])
            continue
        asset_id = uuid.uuid4().hex
        storage_path = f"tile-station/marketing/{asset_id}.png"
        try:
            put_object(storage_path, result["png_bytes"], "image/png")
        except Exception as exc:  # noqa: BLE001
            logger.exception("Marketing Studio storage upload failed")
            failed.append(f"Storage upload failed: {str(exc)[:120]}")
            continue
        public_url = f"/api/website/marketing-media/{asset_id}.png"
        doc = {
            "id": asset_id,
            "asset_kind": req.asset_kind,
            "preset": req.preset,
            "model": req.model,
            "prompt": req.prompt[:1000],
            "enriched_prompt": result["prompt"][:2000],
            "width": result["width"],
            "height": result["height"],
            "storage_path": storage_path,
            "image_url": public_url,
            "cost_usd": result["cost_usd"],
            "variant_group_id": variant_group_id,
            "variant_index": idx if n > 1 else None,
            "deleted": False,
            "published_to": None,
            "created_at": now_iso,
            "created_by": (current_user or {}).get("email"),
        }
        await db.marketing_assets.insert_one(doc)
        doc.pop("_id", None)
        saved.append(doc)

    if not saved:
        # Every parallel call failed — surface the first error
        msg = failed[0] if failed else "Image generation failed"
        raise HTTPException(status_code=502, detail=msg)

    if n == 1:
        return {"asset": saved[0]}
    return {"assets": saved, "variant_group_id": variant_group_id, "failed": failed}


class LifestyleGenerateReq(BaseModel):
    tile_id: str
    room_type: str = Field(default="bathroom", pattern="^(bathroom|kitchen|hallway|lounge|shower|bedroom|open_plan)$")
    style_notes: str | None = Field(default=None, max_length=400)
    width: int = Field(default=1024, ge=256, le=4096)
    height: int = Field(default=1024, ge=256, le=4096)
    num_variants: int = Field(default=1, ge=1, le=4)


ROOM_PROMPT_TEMPLATES = {
    "bathroom":   "A magazine-quality luxury bathroom interior. Polished marble countertops, modern brass fittings, soft natural light through frosted windows, freestanding bathtub or walk-in shower. The tile from the reference image is used on the floor and lower wall.",
    "kitchen":    "A magazine-quality modern luxury kitchen. White or grey shaker units, marble or quartz worktops, brass pendant lights, hardwood island with stools, fresh herbs and fruit bowl. The tile from the reference image is used on the floor.",
    "hallway":    "A magazine-quality elegant entrance hallway. Console table with mirror, framed art, statement pendant light, herringbone or grid layout depending on tile. The tile from the reference image is used on the floor.",
    "lounge":     "A magazine-quality contemporary lounge. Velvet sofa, brass coffee table, large window with linen curtains, plants, soft natural light. The tile from the reference image is used on the floor.",
    "shower":     "A magazine-quality walk-in shower interior. Frameless glass screen, brushed brass fittings, niche with toiletries, ambient light. The tile from the reference image is used on the walls and floor.",
    "bedroom":    "A magazine-quality luxury master bedroom. Upholstered headboard, layered bedding, bedside lamps, soft natural light. The tile from the reference image is used on the floor.",
    "open_plan":  "A magazine-quality open-plan living and dining space. Sofa, dining table, large windows, brass accents, plants. The tile from the reference image is used continuously across the floor.",
}


@router.post("/lifestyle")
async def generate_lifestyle(
    req: LifestyleGenerateReq,
    current_user: dict = Depends(get_current_user),
):
    """Generate a lifestyle photo of a real catalogue tile placed in a
    luxury room scene. Uses Nano Banana with the tile photo as a
    reference image so the AI's interpretation stays close to the
    actual product."""
    _require_admin(current_user)
    db = get_db()

    # Find the tile + its primary image
    tile = await db.tiles.find_one({"id": req.tile_id}, {"_id": 0})
    if not tile:
        raise HTTPException(status_code=404, detail="Tile not found")
    images = tile.get("images") or []
    img_url = None
    for entry in images:
        if isinstance(entry, dict) and entry.get("url"):
            img_url = entry["url"]
            break
        if isinstance(entry, str) and entry:
            img_url = entry
            break
    if not img_url:
        raise HTTPException(status_code=422, detail="Tile has no image to use as reference")

    # Download + base64-encode the tile image
    import base64
    import httpx
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(img_url)
            r.raise_for_status()
            tile_image_b64 = base64.b64encode(r.content).decode("ascii")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Could not load tile image: {str(exc)[:160]}")

    # Build the prompt
    base = ROOM_PROMPT_TEMPLATES.get(req.room_type, ROOM_PROMPT_TEMPLATES["bathroom"])
    extra = f" {req.style_notes.strip()}" if req.style_notes else ""
    prompt = (
        f"{base}{extra} "
        "Sharp focus, photorealistic, magazine-quality interior photography, "
        "natural lighting, no people, no logos, no watermarks. "
        "The tile shown in the reference image must visually match the floor/wall surfaces."
    )

    n = max(1, min(4, int(req.num_variants or 1)))
    variant_group_id = uuid.uuid4().hex if n > 1 else None

    import asyncio
    from services.marketing_studio import generate_banner_image
    from services.object_storage import put_object

    async def _one():
        try:
            return await generate_banner_image(
                prompt=prompt, model="nano-banana",
                width=req.width, height=req.height,
                reference_image_b64=tile_image_b64,
            )
        except Exception as exc:  # noqa: BLE001
            return {"error": str(exc)[:240]}

    results = await asyncio.gather(*[_one() for _ in range(n)])

    saved: list[dict] = []
    failed: list[str] = []
    now_iso = datetime.now(timezone.utc).isoformat()
    for idx, result in enumerate(results):
        if isinstance(result, dict) and result.get("error"):
            failed.append(result["error"])
            continue
        asset_id = uuid.uuid4().hex
        storage_path = f"tile-station/marketing/{asset_id}.png"
        try:
            put_object(storage_path, result["png_bytes"], "image/png")
        except Exception as exc:  # noqa: BLE001
            logger.exception("Lifestyle storage upload failed")
            failed.append(str(exc)[:160])
            continue
        public_url = f"/api/website/marketing-media/{asset_id}.png"
        doc = {
            "id": asset_id,
            "asset_kind": "lifestyle",
            "preset": f"lifestyle-{req.room_type}",
            "model": "nano-banana",
            "prompt": prompt[:1000],
            "enriched_prompt": prompt[:2000],
            "width": result["width"],
            "height": result["height"],
            "storage_path": storage_path,
            "image_url": public_url,
            "cost_usd": result["cost_usd"],
            "variant_group_id": variant_group_id,
            "variant_index": idx if n > 1 else None,
            "lifestyle_meta": {
                "tile_id": req.tile_id,
                "tile_name": tile.get("our_name") or tile.get("name") or tile.get("display_name"),
                "tile_image": img_url,
                "room_type": req.room_type,
            },
            "deleted": False,
            "published_to": None,
            "created_at": now_iso,
            "created_by": (current_user or {}).get("email"),
        }
        await db.marketing_assets.insert_one(doc)
        doc.pop("_id", None)
        saved.append(doc)

    if not saved:
        raise HTTPException(status_code=502, detail=failed[0] if failed else "Lifestyle generation failed")
    return {"assets": saved, "variant_group_id": variant_group_id, "failed": failed,
            "tile": {"id": req.tile_id, "name": tile.get("our_name") or tile.get("name"), "image": img_url}}


@router.get("/assets")
async def list_assets(
    kind: str = "all",
    limit: int = 100,
    include_superseded: bool = False,
    current_user: dict = Depends(get_current_user),
):
    _require_admin(current_user)
    db = get_db()
    q: dict = {"deleted": {"$ne": True}}
    if kind != "all":
        q["asset_kind"] = kind
    # Hide regenerated "old" versions by default — the gallery should
    # show only the latest version of each banner. `?include_superseded=true`
    # opts in for audit flows. `superseded_by` is unset on fresh assets,
    # so $exists:false OR $eq:None covers both old and new docs.
    if not include_superseded:
        q["$or"] = [
            {"superseded_by": {"$exists": False}},
            {"superseded_by": None},
        ]
    rows = await (
        db.marketing_assets.find(q, {"_id": 0})
        .sort("created_at", -1)
        .limit(min(max(limit, 1), 500))
        .to_list(length=None)
    )
    return {"count": len(rows), "assets": rows}


@router.post("/verify-storage")
async def verify_storage(
    dry_run: bool = True,
    current_user: dict = Depends(get_current_user),
):
    """Probe every non-deleted marketing_asset's image URL. Returns
    the per-asset status so admins can see which blobs are missing
    from R2 + which would be auto-marked as orphans.

    • `?dry_run=true` (default) — just probes and returns the result
      without modifying any assets. Safe to click whenever.
    • `?dry_run=false` — probes AND soft-deletes any asset that's been
      404 for ≥48h (7 safety rails apply — see
      services/marketing_storage_sweep.py). Audit log written to
      `marketing_assets_orphan_log` for every mark.

    Never hard-deletes. Use `POST /assets/{id}/restore` to undo.
    """
    _require_admin(current_user)
    db = get_db()
    from services.marketing_storage_sweep import probe_assets, mark_orphans
    probe = await probe_assets(db)

    summary = {
        "probed_count": len(probe),
        "ok_count": sum(1 for r in probe if r["status"] == 200),
        "missing_count": sum(1 for r in probe if r["status"] == 404),
        "would_mark_count": sum(1 for r in probe if r.get("would_mark")),
        "skipped_count": sum(1 for r in probe if r["status"] == 404 and not r.get("would_mark")),
        "dry_run": dry_run,
    }
    marked_result = {"marked": 0, "errors": 0}
    if not dry_run:
        marked_result = await mark_orphans(db, probe)
        summary.update(marked_result)

    # Return the first 50 probe rows so the admin UI can show a table
    # (don't dump 500+ to the client).
    return {
        "summary": summary,
        "missing_assets": [r for r in probe if r["status"] == 404][:50],
    }


@router.post("/assets/{asset_id}/restore")
async def restore_orphaned_asset(
    asset_id: str,
    current_user: dict = Depends(get_current_user),
):
    """Undo an auto-orphan-sweep mark. Only restores assets whose
    `deleted_reason` starts with `r2_blob_404_` — so manual admin
    Delete actions remain permanent. If the image IS back on R2 the
    asset will stop being flagged 404 on the next probe."""
    _require_admin(current_user)
    db = get_db()
    from services.marketing_storage_sweep import restore_asset
    res = await restore_asset(db, asset_id)
    return res


async def _unpublish_placement(db, placement: str, asset: dict | None = None) -> None:
    """Disable whichever destination an asset was published to so the
    storefront stops serving it. Idempotent — safe to call when nothing
    is currently published.

      • homepage_hero  → clear `page_content.homepage.content.hero_image`
                         AND delete any slide in `hero_slides` linked to
                         this asset. The storefront's HeroBannerCarousel
                         reads from `hero_slides`, NOT page_content
                         (May 3 2026 production incident — Marketing
                         Studio was writing to a field nobody read).
      • promo_banner   → set `website_settings.promo_banner.enabled=False`
                         (the doc is preserved so a quick re-enable still works).

    `asset` (when provided) is the marketing_assets doc — used to match
    legacy slides by image URL when asset_id wasn't recorded.
    """
    if placement == "homepage_hero":
        existing = await db.page_content.find_one({"page_key": "homepage"}, {"_id": 0})
        if existing:
            content = (existing.get("content") or {}).copy()
            content.pop("hero_image", None)
            content.pop("hero_cta_text", None)
            content.pop("hero_asset_id", None)
            content.pop("hero_auto_unpublish_at", None)
            await db.page_content.update_one(
                {"page_key": "homepage"},
                {"$set": {"page_key": "homepage", "content": content,
                          "updated_at": datetime.now(timezone.utc)}},
                upsert=True,
            )
        # Remove the actual carousel slide. Match by asset_id first;
        # fall back to image URL match for legacy slides created before
        # we tracked asset_id (the May 3 production BANK HOLIDAY slide).
        delete_filter = {"$or": []}
        if asset and asset.get("id"):
            delete_filter["$or"].append({"asset_id": asset["id"]})
        if asset and asset.get("image_url"):
            delete_filter["$or"].append({"image": asset["image_url"]})
        if delete_filter["$or"]:
            res = await db.hero_slides.delete_many(delete_filter)
            logger.info("[unpublish] removed %d hero_slides matching asset %s",
                        res.deleted_count, (asset or {}).get("id"))
    elif placement == "promo_banner":
        # Disable AND close any active schedule window — without this,
        # `_promo_active_now` will OR `enabled=False` with the still-active
        # schedule and the banner stays live (May 3 2026 production
        # incident — schedule_end was 24h in the future when the user
        # tried to disable, so the banner kept showing for hours).
        await db.website_settings.update_one(
            {"key": "promo_banner"},
            {"$set": {
                "enabled": False,
                "schedule_enabled": False,
                "scheduled_start": "2020-01-01T00:00:00+00:00",
                "scheduled_end": "2020-01-02T00:00:00+00:00",
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }},
            upsert=False,
        )
    # Bust the public caches so the storefront flips immediately
    try:
        from utils.endpoint_cache import endpoint_cache
        endpoint_cache.invalidate("public_promo_banner")
        endpoint_cache.invalidate("homepage_content")
        endpoint_cache.invalidate("public_hero_slides")
    except Exception:
        pass


@router.post("/cleanup-orphan-hero-slides")
async def cleanup_orphan_hero_slides(
    aggressive: bool = False,
    current_user: dict = Depends(get_current_user),
):
    """Emergency: remove every slide in `hero_slides` that came from
    Marketing Studio but whose linked asset is gone (deleted=True,
    nonexistent, or has published_to=None).

    Uses three matching strategies (any one is enough to flag a slide
    as orphan):
      1. `source: "marketing_studio"` AND no asset_id, OR asset_id
         points to a deleted/unpublished/missing asset.
      2. Untagged slide whose `image` URL matches a deleted or
         unpublished `marketing_assets` doc.
      3. (Aggressive only) Untagged slide whose `image` URL matches
         any `marketing_assets` doc — even one that's still published.
         Use this when the deleted asset has been hard-removed from
         Mongo entirely.

    Pass `?aggressive=true` for the May 3 2026 production cleanup.

    Returns a list of removed slides for audit.
    """
    _require_admin(current_user)
    db = get_db()
    removed = []
    async for slide in db.hero_slides.find({}, {"_id": 0}):
        is_orphan = False
        reason = None
        # Strategy 1: tagged as marketing-studio
        if slide.get("source") == "marketing_studio":
            aid = slide.get("asset_id")
            if not aid:
                is_orphan = True
                reason = "marketing_studio slide with no asset_id link"
            else:
                a = await db.marketing_assets.find_one({"id": aid}, {"_id": 0})
                if not a or a.get("deleted") or not a.get("published_to"):
                    is_orphan = True
                    reason = (
                        "asset deleted" if (a or {}).get("deleted")
                        else "asset not found" if not a
                        else "asset.published_to cleared"
                    )
        # Strategy 2: untagged but image URL matches a deleted/unpublished asset
        elif slide.get("image"):
            a = await db.marketing_assets.find_one(
                {"image_url": slide["image"]}, {"_id": 0}
            )
            if a and (a.get("deleted") or not a.get("published_to")):
                is_orphan = True
                reason = "untagged slide matches deleted/unpublished marketing asset by image URL"
            elif aggressive and a:
                # Strategy 3 (aggressive): any image-URL match removes the slide
                is_orphan = True
                reason = "AGGRESSIVE: untagged slide matches any marketing asset image URL"
        if is_orphan:
            removed.append({"title": slide.get("title", "")[:80],
                            "image": (slide.get("image") or "")[:80],
                            "reason": reason})
            await db.hero_slides.delete_one({
                "image": slide["image"], "title": slide.get("title", "")
            })
    # Bust the cache so the cleanup is visible immediately
    try:
        from utils.endpoint_cache import endpoint_cache
        endpoint_cache.invalidate("public_hero_slides")
    except Exception:
        pass
    return {"ok": True, "removed_count": len(removed), "removed": removed}


@router.post("/delete-hero-slide-by-text")
async def delete_hero_slide_by_text(
    payload: dict,
    current_user: dict = Depends(get_current_user),
):
    """Surgical: delete hero_slides whose title OR badge contains the
    given text (case-insensitive). Use this when an admin recognises a
    rogue slide on the storefront and just wants it gone — no need to
    hunt through the homepage-manager UI or know the slide's id.

    Body: `{ "match": "BANK HOLIDAY" }` deletes any slide whose title
    or badge contains "bank holiday".
    Returns the list of deleted slide titles.
    """
    _require_admin(current_user)
    db = get_db()
    needle = (payload.get("match") or "").strip()
    if not needle or len(needle) < 3:
        raise HTTPException(status_code=400, detail="match must be at least 3 chars")
    import re
    rx = re.compile(re.escape(needle), re.IGNORECASE)
    cursor = db.hero_slides.find({"$or": [{"title": rx}, {"badge": rx}, {"subtitle": rx}]}, {"_id": 0})
    rows = await cursor.to_list(length=200)
    if not rows:
        return {"ok": True, "removed_count": 0, "removed": []}
    removed = [{"title": r.get("title", ""), "badge": r.get("badge", "")} for r in rows]
    await db.hero_slides.delete_many({"$or": [{"title": rx}, {"badge": rx}, {"subtitle": rx}]})
    try:
        from utils.endpoint_cache import endpoint_cache
        endpoint_cache.invalidate("public_hero_slides")
    except Exception:
        pass
    return {"ok": True, "removed_count": len(removed), "removed": removed}


@router.post("/clear-hero-slides")
async def clear_all_hero_slides(current_user: dict = Depends(get_current_user)):
    """Nuclear: delete EVERY active slide from the hero carousel. Use
    this when you need to clear a stuck banner immediately and the
    slide isn't tagged as marketing_studio source. The storefront falls
    back to the default Spring Collection slide while the carousel is empty.

    Use sparingly — admins need to re-create their slides afterwards.
    """
    _require_admin(current_user)
    db = get_db()
    res = await db.hero_slides.delete_many({})
    try:
        from utils.endpoint_cache import endpoint_cache
        endpoint_cache.invalidate("public_hero_slides")
    except Exception:
        pass
    return {"ok": True, "deleted_count": res.deleted_count}


@router.delete("/assets/{asset_id}")
async def delete_asset(asset_id: str, current_user: dict = Depends(get_current_user)):
    """Soft-delete an asset. If the asset was currently published, also
    unpublish that placement so customers don't keep seeing the deleted
    banner on the storefront (May 3 2026 production incident — Bank
    Holiday banner stayed live after admin clicked Delete)."""
    _require_admin(current_user)
    db = get_db()
    asset = await db.marketing_assets.find_one({"id": asset_id}, {"_id": 0})
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    if asset.get("published_to"):
        await _unpublish_placement(db, asset["published_to"], asset=asset)
    await db.marketing_assets.update_one(
        {"id": asset_id},
        {"$set": {"deleted": True,
                  "deleted_at": datetime.now(timezone.utc).isoformat(),
                  "published_to": None}},
    )
    return {"ok": True, "unpublished_from": asset.get("published_to")}


@router.post("/assets/{asset_id}/unpublish")
async def unpublish_asset(asset_id: str, current_user: dict = Depends(get_current_user)):
    """Remove an asset from its current placement on the storefront
    WITHOUT deleting the asset itself. Re-publishable later in 1 click.
    """
    _require_admin(current_user)
    db = get_db()
    asset = await db.marketing_assets.find_one(
        {"id": asset_id, "deleted": {"$ne": True}}, {"_id": 0}
    )
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    placement = asset.get("published_to")
    if not placement:
        return {"ok": True, "was_published": False}
    await _unpublish_placement(db, placement, asset=asset)
    await db.marketing_assets.update_one(
        {"id": asset_id},
        {"$set": {"published_to": None, "auto_unpublish_at": None,
                  "unpublished_at": datetime.now(timezone.utc).isoformat()}},
    )
    return {"ok": True, "was_published": True, "placement": placement}


@router.post("/assets/{asset_id}/publish")
async def publish_asset(
    asset_id: str,
    req: PublishReq,
    current_user: dict = Depends(get_current_user),
):
    """Wire a generated asset into the storefront. Two destinations:

      • homepage_hero  → updates `page_content.homepage.hero_image`
                         (existing field already used by the homepage).
      • promo_banner   → updates `website_settings.promo_banner.image_url`
                         (new sitewide image-strip placement).
    """
    _require_admin(current_user)
    db = get_db()
    asset = await db.marketing_assets.find_one(
        {"id": asset_id, "deleted": {"$ne": True}}, {"_id": 0}
    )
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")

    now_iso = datetime.now(timezone.utc).isoformat()

    if req.placement == "homepage_hero":
        existing = await db.page_content.find_one({"page_key": "homepage"}, {"_id": 0})
        content = (existing or {}).get("content", {}) or {}
        content["hero_image"] = asset["image_url"]
        content["hero_asset_id"] = asset_id  # link for auto-unpublish bookkeeping
        if req.cta_text:
            content["hero_cta_text"] = req.cta_text
        if req.auto_unpublish_at:
            content["hero_auto_unpublish_at"] = req.auto_unpublish_at
        else:
            content.pop("hero_auto_unpublish_at", None)
        await db.page_content.update_one(
            {"page_key": "homepage"},
            {"$set": {"page_key": "homepage", "content": content,
                      "updated_at": datetime.now(timezone.utc)}},
            upsert=True,
        )
        # ALSO insert/update a slide in hero_slides — the storefront's
        # HeroBannerCarousel reads from THAT collection, not from
        # page_content. Without this the publish flow silently does
        # nothing visible to customers (May 3 2026 production incident).
        # We tag with `source: "marketing_studio"` so admins can tell
        # which slides came from Marketing Studio vs hand-curated.
        # Marketing-studio banners have the headline, sale copy, CTA
        # button, model imagery — everything — baked INTO the image
        # (it's a one-shot AI-rendered hero, not a CSS-composed slide).
        # The hero carousel applies a dark gradient overlay AND a
        # white headline / Shop Now button on TOP of every slide UNLESS
        # `theme === 'image-only'`. Without that flag we obscure our
        # own beautifully-composed banner, leaving customers seeing a
        # near-empty gradient with a generic "Shop Now" button. Bug
        # spotted 23 May 2026 — banner had "BANK HOLIDAY SALE / UP TO
        # 70% OFF" baked in, rendered as a blank grey gradient.
        # Resolve the asset's image URL to an ABSOLUTE URL pointing at
        # the backend public host. Marketing Studio historically saved
        # `asset.image_url` as a relative path like
        #   `/api/website/marketing-media/<asset_id>.png`
        # which the browser dutifully resolves against the storefront
        # origin (tilestation.co.uk). The Express SPA server doesn't
        # serve that path unless we mount a proxy → broken image icon.
        # Storing an absolute URL here removes the dependency on the
        # proxy and makes the slide self-contained.
        # (23 May 2026 — paired with the websiteMediaProxy fix in
        # frontend/server.js so older slides keep working too.)
        _img = asset["image_url"] or ""
        if _img.startswith("/"):
            _backend_base = (
                os.environ.get("BACKEND_PUBLIC_URL")
                or os.environ.get("RAILWAY_PUBLIC_DOMAIN")
                or "https://tile-station-production.up.railway.app"
            ).rstrip("/")
            if not _backend_base.startswith("http"):
                _backend_base = f"https://{_backend_base}"
            _img = f"{_backend_base}{_img}"
        slide_doc = {
            "asset_id": asset_id,
            "source": "marketing_studio",
            "image": _img,
            "theme": "image-only",
            # The remaining fields are kept for back-compat / admin
            # overview but are NOT rendered when theme=="image-only".
            "badge": "",
            "title": "",
            "subtitle": "",
            "cta": "",
            "link": req.link_url or "/tiles?sale=true",
            "display_order": 0,  # marketing-studio slides go first
            "is_active": True,
            "created_at": datetime.now(timezone.utc),
        }
        await db.hero_slides.update_one(
            {"asset_id": asset_id},
            {"$set": slide_doc},
            upsert=True,
        )
        # Retro-fix any legacy marketing_studio slides published before
        # the theme=image-only fix (23 May 2026). Those slides ship with
        # `theme=null` so the carousel applies a dark gradient + generic
        # "Shop Now" overlay that buries our baked-in banner content.
        # Idempotent: only touches slides that still have the wrong theme.
        try:
            retro = await db.hero_slides.update_many(
                {
                    "source": "marketing_studio",
                    "$or": [
                        {"theme": {"$exists": False}},
                        {"theme": None},
                        {"theme": ""},
                        {"theme": {"$ne": "image-only"}},
                    ],
                },
                {"$set": {"theme": "image-only", "title": "", "cta": "",
                          "subtitle": "", "badge": ""}},
            )
            if retro.modified_count:
                logger.info(
                    "[publish] retro-fixed %d legacy marketing_studio slide(s) "
                    "to theme=image-only", retro.modified_count,
                )
        except Exception:
            logger.exception("retro-fix legacy hero slides failed")

        # Second retro-fix: rewrite any RELATIVE image URLs to absolute.
        # Legacy slides stored `image: "/api/website/marketing-media/..."`
        # which the browser resolves against tilestation.co.uk → broken
        # image icon. Idempotent by design (regex only matches relative).
        try:
            _backend_base_retro = (
                os.environ.get("BACKEND_PUBLIC_URL")
                or os.environ.get("RAILWAY_PUBLIC_DOMAIN")
                or "https://tile-station-production.up.railway.app"
            ).rstrip("/")
            if not _backend_base_retro.startswith("http"):
                _backend_base_retro = f"https://{_backend_base_retro}"
            legacy_slides = db.hero_slides.find(
                {"source": "marketing_studio",
                 "image": {"$regex": "^/", "$options": ""}}
            )
            count = 0
            async for s in legacy_slides:
                old_img = s.get("image") or ""
                if old_img.startswith("/"):
                    await db.hero_slides.update_one(
                        {"_id": s["_id"]},
                        {"$set": {"image": f"{_backend_base_retro}{old_img}"}},
                    )
                    count += 1
            if count:
                logger.info(
                    "[publish] rewrote %d legacy relative image URL(s) "
                    "to absolute backend URLs", count,
                )
        except Exception:
            logger.exception("retro rewrite relative-image-URL failed")
    else:  # promo_banner
        update = {
            "enabled": True,
            "image_url": asset["image_url"],
            "link_url": req.link_url or "",
            "alt_text": (asset.get("prompt") or "")[:180],
            "width": asset.get("width"),
            "height": asset.get("height"),
            "asset_id": asset_id,  # link for auto-unpublish bookkeeping
            "updated_at": now_iso,
            "updated_by": (current_user or {}).get("email"),
        }
        if req.auto_unpublish_at:
            # Reuse the existing schedule machinery — `_promo_active_now`
            # already hides the banner from the public endpoint once
            # scheduled_end passes. The new auto_unpublish background
            # task ALSO flips `enabled=False` and clears `published_to`
            # so the admin gallery reflects reality.
            update["schedule_enabled"] = True
            update["scheduled_start"] = update["scheduled_start"] = now_iso  # set/keep
            update["scheduled_end"] = req.auto_unpublish_at
        else:
            # Manual publish without a schedule — clear any leftover
            # schedule from a previous publish so it doesn't auto-end
            # accidentally.
            update["schedule_enabled"] = False
            update["scheduled_start"] = None
            update["scheduled_end"] = None
        await db.website_settings.update_one(
            {"key": "promo_banner"},
            {"$set": {"key": "promo_banner", **update}},
            upsert=True,
        )

    await db.marketing_assets.update_one(
        {"id": asset_id},
        {"$set": {"published_to": req.placement, "published_at": now_iso,
                  "auto_unpublish_at": req.auto_unpublish_at}},
    )
    # Bust the storefront cache so the new banner shows up within seconds
    # rather than waiting for the 15s short_ttl to expire.
    try:
        from utils.endpoint_cache import endpoint_cache
        endpoint_cache.invalidate("public_promo_banner")
        endpoint_cache.invalidate("homepage_content")
        endpoint_cache.invalidate("public_hero_slides")
    except Exception:
        pass
    return {"ok": True, "placement": req.placement, "auto_unpublish_at": req.auto_unpublish_at}


@router.post("/regenerate/{asset_id}")
async def regenerate_asset(
    asset_id: str,
    current_user: dict = Depends(get_current_user),
):
    """Re-run the same prompt that produced a pre-safe-zone banner
    through the updated service (which now adds the SAFE_ZONE_APPENDIX
    + aspect directive + biased centering). The old asset is NOT
    deleted — it's archived with `superseded_by` pointing to the new
    one. The new asset carries `replaces_asset_id` back-reference so
    the UI can render a side-by-side comparison.

    If the old asset was published (homepage_hero or promo_banner),
    the new asset inherits that placement automatically so the
    storefront hot-swaps to the improved version with no manual step.

    Returns: {old: <old doc>, new: <new doc>, swapped: bool}.
    """
    _require_admin(current_user)
    from services.marketing_studio import generate_banner_image
    from services.object_storage import put_object

    db = get_db()
    asset = await db.marketing_assets.find_one(
        {"id": asset_id, "deleted": {"$ne": True}}, {"_id": 0}
    )
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    if asset.get("superseded_by"):
        raise HTTPException(
            status_code=400,
            detail=f"Asset has already been regenerated (see {asset['superseded_by']})",
        )

    # Sanity: the ORIGINAL user prompt is stored as `prompt`; the
    # downstream-enriched one is `enriched_prompt`. We pass the user
    # prompt so the safe-zone rules get appended fresh on this call —
    # otherwise we'd double-append them.
    user_prompt = asset.get("prompt") or ""
    if not user_prompt:
        raise HTTPException(
            status_code=400,
            detail="Cannot regenerate — original user prompt is missing from the asset record",
        )
    model = asset.get("model") or "nano-banana"
    width = int(asset.get("width") or 1920)
    height = int(asset.get("height") or 640)

    try:
        result = await generate_banner_image(
            prompt=user_prompt, model=model, width=width, height=height,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Regenerate failed for asset %s", asset_id)
        raise HTTPException(status_code=502, detail=f"Generation failed: {str(exc)[:200]}")

    # Store the fresh bytes
    new_asset_id = uuid.uuid4().hex
    storage_path = f"tile-station/marketing/{new_asset_id}.png"
    try:
        put_object(storage_path, result["png_bytes"], "image/png")
    except Exception as exc:  # noqa: BLE001
        logger.exception("Regenerate — storage upload failed for %s", asset_id)
        raise HTTPException(status_code=502, detail=f"Storage upload failed: {str(exc)[:120]}")

    public_url = f"/api/website/marketing-media/{new_asset_id}.png"
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()

    new_doc = {
        "id": new_asset_id,
        "asset_kind": asset.get("asset_kind"),
        "preset": asset.get("preset"),
        "model": model,
        "prompt": user_prompt[:1000],
        "enriched_prompt": result["prompt"][:2000],
        "width": result["width"],
        "height": result["height"],
        "storage_path": storage_path,
        "image_url": public_url,
        "cost_usd": result["cost_usd"],
        "variant_group_id": asset.get("variant_group_id"),
        "variant_index": asset.get("variant_index"),
        "deleted": False,
        "published_to": None,  # may be set below via hot-swap
        "created_at": now_iso,
        "created_by": (current_user or {}).get("email"),
        # Regeneration provenance so admin can audit + render side-by-side
        "replaces_asset_id": asset_id,
        "regenerated_with": "safe_zone_v1",
    }
    await db.marketing_assets.insert_one(new_doc)
    new_doc.pop("_id", None)

    # Mark the old asset as superseded so it doesn't show up in the
    # default gallery anymore. Admin can still view it from the
    # archived panel if we add one later.
    await db.marketing_assets.update_one(
        {"id": asset_id},
        {"$set": {
            "superseded_by": new_asset_id,
            "superseded_at": now_iso,
            "superseded_by_email": (current_user or {}).get("email"),
        }},
    )

    # If the old asset was live on the storefront, inherit its
    # placement automatically — this is the killer feature that turns
    # a 30-minute audit into a one-click fix.
    swapped = False
    placement = asset.get("published_to")
    if placement == "homepage_hero":
        existing = await db.page_content.find_one({"page_key": "homepage"}, {"_id": 0})
        content = (existing or {}).get("content", {}) or {}
        content["hero_image"] = public_url
        content["hero_asset_id"] = new_asset_id
        await db.page_content.update_one(
            {"page_key": "homepage"},
            {"$set": {"page_key": "homepage", "content": content, "updated_at": now}},
            upsert=True,
        )
        # Swap the hero_slides row too (that's what the carousel reads)
        await db.hero_slides.update_one(
            {"asset_id": asset_id},
            {"$set": {
                "asset_id": new_asset_id,
                "image": public_url,
            }},
        )
        # Carry placement forward on the new asset doc
        await db.marketing_assets.update_one(
            {"id": new_asset_id},
            {"$set": {"published_to": placement, "published_at": now_iso}},
        )
        new_doc["published_to"] = placement
        swapped = True
    elif placement == "promo_banner":
        await db.website_settings.update_one(
            {"key": "promo_banner"},
            {"$set": {
                "image_url": public_url,
                "asset_id": new_asset_id,
                "updated_at": now_iso,
            }},
        )
        await db.marketing_assets.update_one(
            {"id": new_asset_id},
            {"$set": {"published_to": placement, "published_at": now_iso}},
        )
        new_doc["published_to"] = placement
        swapped = True

    # Clear the old asset's live-placement link so it's clean archive
    if placement:
        await db.marketing_assets.update_one(
            {"id": asset_id},
            {"$set": {"published_to": None}},
        )

    # Bust the storefront caches so the swap is instant.
    try:
        from utils.endpoint_cache import endpoint_cache
        endpoint_cache.invalidate("public_promo_banner")
        endpoint_cache.invalidate("homepage_content")
        endpoint_cache.invalidate("public_hero_slides")
    except Exception:
        pass

    # Re-load the old doc so the response includes its superseded_by
    old_doc = await db.marketing_assets.find_one({"id": asset_id}, {"_id": 0})
    return {
        "ok": True,
        "old": old_doc,
        "new": new_doc,
        "swapped": swapped,
        "placement": placement,
    }


@router.get("/stats")
async def stats(current_user: dict = Depends(get_current_user)):
    _require_admin(current_user)
    db = get_db()
    total = await db.marketing_assets.count_documents({"deleted": {"$ne": True}})
    spend_pipe = [
        {"$match": {"deleted": {"$ne": True}}},
        {"$group": {"_id": None, "total": {"$sum": "$cost_usd"}}},
    ]
    spend_doc = await db.marketing_assets.aggregate(spend_pipe).to_list(length=1)
    by_model_pipe = [
        {"$match": {"deleted": {"$ne": True}}},
        {"$group": {"_id": "$model", "n": {"$sum": 1}}},
    ]
    by_model = await db.marketing_assets.aggregate(by_model_pipe).to_list(length=None)

    # Month-to-date spend — useful as a "Universal Key burn rate" proxy
    # since Emergent does not expose a live-balance API.
    now = datetime.now(timezone.utc)
    month_start_iso = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat()
    mtd_pipe = [
        {"$match": {"deleted": {"$ne": True}, "created_at": {"$gte": month_start_iso}}},
        {"$group": {"_id": None, "total": {"$sum": "$cost_usd"}, "n": {"$sum": 1}}},
    ]
    mtd_doc = await db.marketing_assets.aggregate(mtd_pipe).to_list(length=1)
    mtd_spend = round(float(mtd_doc[0]["total"]) if mtd_doc else 0.0, 2)
    mtd_count = int(mtd_doc[0]["n"]) if mtd_doc else 0

    return {
        "total_assets": total,
        "total_spend_usd": round(float(spend_doc[0]["total"]) if spend_doc else 0.0, 2),
        "total_spend_gbp_estimate": round((float(spend_doc[0]["total"]) if spend_doc else 0.0) * 0.79, 2),
        "by_model": {row["_id"] or "unknown": row["n"] for row in by_model},
        "month_to_date": {
            "spend_usd": mtd_spend,
            "spend_gbp_estimate": round(mtd_spend * 0.79, 2),
            "render_count": mtd_count,
            "month_label": now.strftime("%B %Y"),
        },
    }


# ------------------------------------------------------------------
# Promo banner config (the new sitewide image-strip placement)
# ------------------------------------------------------------------

DEFAULT_PROMO_BANNER = {
    "enabled": False,
    "image_url": "",
    "link_url": "",
    "alt_text": "",
    "schedule_enabled": False,
    "scheduled_start": None,
    "scheduled_end": None,
}


def _promo_active_now(cfg: dict) -> bool:
    if not cfg.get("image_url"):
        return False
    manual_on = bool(cfg.get("enabled"))
    sched_on = bool(cfg.get("schedule_enabled"))
    start_iso = cfg.get("scheduled_start")
    end_iso = cfg.get("scheduled_end")
    in_window = False
    if sched_on and start_iso and end_iso:
        try:
            start = datetime.fromisoformat(str(start_iso).replace("Z", "+00:00"))
            end = datetime.fromisoformat(str(end_iso).replace("Z", "+00:00"))
            now = datetime.now(timezone.utc)
            in_window = start <= now <= end
        except Exception:
            in_window = False
    return manual_on or in_window


@router.get("/promo-banner")
async def get_promo_banner_admin(current_user: dict = Depends(get_current_user)):
    _require_admin(current_user)
    db = get_db()
    doc = await db.website_settings.find_one({"key": "promo_banner"}, {"_id": 0})
    cfg = {**DEFAULT_PROMO_BANNER, **(doc or {})}
    cfg["_now_visible"] = _promo_active_now(cfg)
    return cfg


@router.put("/promo-banner")
async def update_promo_banner(
    req: PromoBannerUpdate,
    current_user: dict = Depends(get_current_user),
):
    _require_admin(current_user)
    db = get_db()
    payload = {k: v for k, v in req.dict().items() if v is not None}
    payload["updated_at"] = datetime.now(timezone.utc).isoformat()
    payload["updated_by"] = (current_user or {}).get("email")
    await db.website_settings.update_one(
        {"key": "promo_banner"},
        {"$set": {"key": "promo_banner", **payload}},
        upsert=True,
    )
    doc = await db.website_settings.find_one({"key": "promo_banner"}, {"_id": 0})
    cfg = {**DEFAULT_PROMO_BANNER, **(doc or {})}
    cfg["_now_visible"] = _promo_active_now(cfg)
    return cfg


# ------------------------------------------------------------------
# Public — serve image bytes + read promo banner
# ------------------------------------------------------------------

@public_router.get("/marketing-media/{path:path}")
async def serve_marketing_media(path: str, download: int = 0):
    """Serve marketing-studio output bytes from R2. Path is the asset
    filename only (e.g. `<uuid>.png`); we always prefix
    `tile-station/marketing/`.

    When `?download=1` is set, we add a `Content-Disposition: attachment`
    header so the browser saves the file to disk instead of rendering it
    inline. The lightbox's Download button uses this to guarantee a real
    download (blob-URL approach was failing silently in Chrome when MIME
    type negotiation didn't match the filename extension — May 3 2026).
    """
    from services.object_storage import get_object
    full = f"tile-station/marketing/{path}"
    try:
        data, content_type = get_object(full)
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"Marketing media serve failed for {path}: {exc}")
        raise HTTPException(status_code=404, detail="Image not found")
    headers = {"Cache-Control": "public, max-age=86400"}
    if download:
        # Quote the filename so spaces/unicode don't break the header
        safe_name = path.replace('"', "").replace("\n", "")[:120] or "banner.png"
        headers["Content-Disposition"] = f'attachment; filename="tilestation-{safe_name}"'
    return Response(content=data, media_type=content_type or "image/png",
                    headers=headers)


@public_router.get("/promo-banner")
@bulletproof_endpoint(
    cache_namespace="public_promo_banner",
    # Empty/disabled banner is a VALID state — never hide it via LKG.
    # We only want LKG-on-error semantics here, not LKG-on-empty.
    empty_check=lambda r: False,
    empty_fallback={"enabled": False},
    short_ttl=15,  # short cache so schedule-window flips show up fast
)
async def get_promo_banner_public():
    """Customer-facing fetch — returns the active promo banner config or
    {enabled:false}. Schedule is computed at request time so toggles are
    instant."""
    db = get_db()
    doc = await db.website_settings.find_one({"key": "promo_banner"}, {"_id": 0})
    cfg = {**DEFAULT_PROMO_BANNER, **(doc or {})}
    if not _promo_active_now(cfg):
        return {"enabled": False}
    return {
        "enabled": True,
        "image_url": cfg.get("image_url"),
        "link_url": cfg.get("link_url") or "",
        "alt_text": cfg.get("alt_text") or "Special offer",
        "width": cfg.get("width"),
        "height": cfg.get("height"),
    }

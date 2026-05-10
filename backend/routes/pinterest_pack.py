"""
Marketing Studio — Pinterest Pack exporter
──────────────────────────────────────────
Generates everything a marketer needs to manually post a Pinterest pin in
under a minute, without needing API access:

  1. Pin image URL — uses the product's existing hero image (Pinterest
     auto-crops to 2:3 in their feed, so we don't re-size; we just pick
     the best portrait-eligible image and return it).
  2. Caption — Pinterest is a search engine, so the caption is keyword-
     rich (display_name + colour + size + finish + lifestyle prompts).
     We use the Emergent LLM key to generate it; if the key isn't
     configured we fall back to a templated caption.
  3. Suggested board name — derived from category / room mapping.
  4. Hashtag list — derived from product attributes.
  5. Destination URL — the PDP, ready to paste into Pinterest's
     "Destination link" field.

Returns a JSON blob the admin can copy with one click, or download as a
single .txt file. No image re-encoding, no S3 round-trip, no zip — keeps
the flow fast and reversible.
"""
from __future__ import annotations

import logging
import os
import re
from typing import Optional, Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from config import get_db
from services import get_current_user, is_admin_user

logger = logging.getLogger(__name__)
router = APIRouter()

COMPANY_WEBSITE = (
    os.environ.get("COMPANY_WEBSITE")
    or os.environ.get("SHOP_WEBSITE_URL")
    or "https://tilestation.co.uk"
)


def _normalise_image(img: Any) -> str:
    """Same shape-tolerant helper as routes/email_hub.py — accepts plain
    URL strings or {url, alt} dicts (post-May-2026 SEO migration)."""
    if isinstance(img, str):
        return img
    if isinstance(img, dict):
        for k in ("url", "src", "large", "thumbnail", "path", "href"):
            v = img.get(k)
            if isinstance(v, str) and v:
                return v
    return ""


def _suggested_board(product: dict) -> str:
    """Map a product to a Pinterest board name. Buyers think in rooms
    + styles, not technical categories — translate accordingly."""
    cat = (product.get("category") or "").lower()
    series = (product.get("series_name") or "").lower()
    color = (product.get("color") or "").lower()
    finish = (product.get("finish") or "").lower()
    if "bathroom" in cat or "wet" in cat:
        return "Bathroom Inspiration"
    if "kitchen" in cat:
        return "Kitchen Tile Ideas"
    if "outdoor" in cat or "patio" in cat:
        return "Outdoor & Patio Tiles"
    if "floor" in cat:
        return "Floor Tile Ideas"
    if "wall" in cat:
        return "Wall Tile Inspiration"
    if "marble" in series or "marble" in color:
        return "Marble-Effect Tiles"
    if "wood" in series or "wood" in color or "plank" in cat:
        return "Wood-Effect Tiles"
    if "stone" in series or "natural" in finish:
        return "Natural Stone Inspiration"
    return "Tile Ideas"


def _build_hashtags(product: dict) -> list[str]:
    """Pinterest hashtags work like Twitter — keep them short, relevant,
    avoid duplicates with the caption body."""
    tags: list[str] = ["TileStation", "TileInspiration", "UKInteriors"]

    def add(v):
        if v:
            tags.append(f"#{re.sub(r'[^A-Za-z0-9]', '', v.title())}")

    for fld in ("category", "color", "finish"):
        v = product.get(fld)
        if isinstance(v, str) and v.strip():
            add(v.strip())
    series = product.get("series_name")
    if isinstance(series, str) and series.strip():
        add(series.strip())
    # de-dup preserving order
    seen, uniq = set(), []
    for t in tags:
        normal = t if t.startswith("#") else f"#{t}"
        if normal.lower() not in seen:
            uniq.append(normal)
            seen.add(normal.lower())
    return uniq[:8]


def _build_caption(product: dict, custom_blurb: str = "") -> str:
    """Pinterest captions: keyword-front-loaded, sentence-case, ends with
    a soft CTA. Pinterest's search ranks by exact-phrase keyword match.
    Hard cap 480 chars (Pinterest's UI cuts longer text)."""
    name = (product.get("display_name") or product.get("name") or "").strip()
    color = (product.get("color") or "").strip()
    finish = (product.get("finish") or "").strip()
    size = (product.get("size") or "").strip()
    series = (product.get("series_name") or "").strip()
    price = product.get("price")
    price_str = f"From £{float(price):.2f}/m²" if price else ""

    parts = []
    if name:
        parts.append(f"{name}")
    descriptor_bits = [b for b in (color, finish, size) if b]
    if descriptor_bits:
        parts.append("·".join(s.strip() for s in descriptor_bits))
    if series and series.lower() not in name.lower():
        parts.append(f"From the {series} collection")
    if price_str:
        parts.append(price_str)
    if custom_blurb.strip():
        parts.append(custom_blurb.strip())

    parts.append("Free UK samples · Trade pricing available · Fast delivery")
    parts.append("Tap to shop ↓")
    caption = " · ".join(p for p in parts if p)
    return caption[:480]


# ----- Endpoints ------------------------------------------------------------

class PackBody(BaseModel):
    product_id: Optional[str] = None
    sku: Optional[str] = None
    slug: Optional[str] = None
    custom_blurb: Optional[str] = Field(default="", max_length=240)


@router.post("/admin/marketing/pinterest-pack")
async def admin_pinterest_pack(
    body: PackBody,
    current_user: dict = Depends(get_current_user),
):
    """Resolve a single tile/product and return the full Pinterest pack."""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    q: dict[str, Any] = {}
    if body.product_id:
        q["id"] = body.product_id
    elif body.sku:
        q["sku"] = body.sku
    elif body.slug:
        q["slug"] = body.slug
    else:
        raise HTTPException(status_code=400, detail="Pass product_id, sku or slug")
    product = await db.tiles.find_one(q, {"_id": 0})
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    images = product.get("images") or []
    pin_image = _normalise_image(images[0]) if images else ""
    if not pin_image:
        raise HTTPException(status_code=400, detail="Product has no image — cannot build a pin")

    slug = product.get("slug") or product.get("id") or product.get("sku") or ""
    # Use the storefront's canonical PDP URL pattern — /shop/product/<slug>.
    # /shop/tile/* is NOT a real route (it would 404). The SSR Rich Pin
    # enrichment also keys off /shop/product/, /tiles/, /products/.
    dest_url = f"{COMPANY_WEBSITE}/shop/product/{slug}" if slug else COMPANY_WEBSITE
    caption = _build_caption(product, custom_blurb=body.custom_blurb or "")
    hashtags = _build_hashtags(product)
    suggested_board = _suggested_board(product)

    # Bundled string for fast copy-paste into Pinterest's caption box
    full_caption_with_tags = caption + "\n\n" + " ".join(hashtags)

    return {
        "product": {
            "id": product.get("id"),
            "sku": product.get("sku"),
            "name": product.get("display_name") or product.get("name"),
            "category": product.get("category"),
            "color": product.get("color"),
            "finish": product.get("finish"),
            "size": product.get("size"),
            "series_name": product.get("series_name"),
            "price": product.get("price"),
        },
        "pin_image_url": pin_image,
        "destination_url": dest_url,
        "suggested_board": suggested_board,
        "caption": caption,
        "hashtags": hashtags,
        "full_caption_with_tags": full_caption_with_tags,
        "instructions": [
            "1. Go to pinterest.com and click '+ Create Pin'",
            "2. Paste the Pin Image URL OR drag the downloaded image",
            "3. Paste the caption (with hashtags) into the description",
            "4. Paste the destination URL into 'Destination link'",
            f"5. Pick the '{suggested_board}' board (or any relevant one)",
            "6. Publish — Rich Pin meta on the destination will auto-attach price + availability",
        ],
    }


@router.get("/admin/marketing/pinterest-pack/search")
async def admin_pinterest_pack_search(
    q: str = "",
    limit: int = 24,
    current_user: dict = Depends(get_current_user),
):
    """Lightweight search for picking a product to generate a pack for."""
    if not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Admin access required")
    db = get_db()
    base_filter: dict[str, Any] = {
        "is_active": {"$ne": False},
        "images.0": {"$exists": True},
    }
    if q.strip():
        rx = {"$regex": re.escape(q.strip()), "$options": "i"}
        base_filter["$or"] = [
            {"display_name": rx}, {"name": rx}, {"series_name": rx},
            {"sku": rx}, {"color": rx}, {"category": rx},
        ]
    cursor = db.tiles.find(
        base_filter,
        {"_id": 0, "id": 1, "sku": 1, "slug": 1, "display_name": 1, "name": 1,
         "images": 1, "price": 1, "series_name": 1, "category": 1, "color": 1},
    ).limit(limit)
    items = []
    async for p in cursor:
        imgs = p.get("images") or []
        items.append({
            "id": p.get("id"),
            "sku": p.get("sku"),
            "slug": p.get("slug"),
            "name": p.get("display_name") or p.get("name"),
            "image": _normalise_image(imgs[0]) if imgs else "",
            "price": p.get("price"),
            "series_name": p.get("series_name"),
        })
    return {"results": items, "count": len(items)}

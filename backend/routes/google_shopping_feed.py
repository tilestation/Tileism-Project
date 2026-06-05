"""
Google Shopping free product listings — XML feed
─────────────────────────────────────────────────

Generates the Google Merchant Center product feed at
`/api/feeds/google-shopping.xml`. Once submitted to Merchant Center
(merchants.google.com), products appear in:
  • The free "Shopping" tab of Google search
  • Google Image Search shopping carousel
  • Google Lens product matches
  • SGE / AI Overview shopping callouts

Submission is a one-off step:
  1. Open https://merchants.google.com → sign up (free)
  2. Verify ownership of tilestation.co.uk (DNS TXT or HTML tag)
  3. Settings → Feeds → Add primary feed → "Scheduled fetch"
  4. URL: https://tilestation.co.uk/api/feeds/google-shopping.xml
  5. Frequency: Daily 04:00 UK time

Google then crawls this URL, ingests our products, and they're live
in 24-72 hours. Updates are picked up daily.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from html import escape
from typing import Any

from fastapi import APIRouter, Response

from config import get_db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/feeds", tags=["Search Feeds"])


@router.get("/google-shopping.xml", response_class=Response)
async def google_shopping_xml() -> Response:
    """Generate a Google Shopping product feed in RSS 2.0 + g: namespace
    format. Hits MongoDB for active products, filters out heating/
    cable accessories, builds one <item> per product. Cacheable for
    1 hour at the CDN — Google polls daily so this is plenty."""
    db = get_db()
    base = (os.environ.get("FRONTEND_BASE_URL") or "https://www.tilestation.co.uk").rstrip("/")

    cur = db.tiles.find(
        {
            "is_active": {"$ne": False},
            "$or": [
                {"images": {"$exists": True, "$not": {"$size": 0}}},
                {"image_url": {"$exists": True, "$ne": ""}},
            ],
            "category": {"$nin": [
                "", "Cable Kit", "Foil 140W/m2", "Foil Kit 140W/m2",
                "Mesh 100W/m2", "Mesh 150W/m2", "Mesh 200W/m2",
                "Membrane Mat", "Overlay Board", "Screed Cable",
                "Screed Cable Accessories", "Ultimate Heating Cable 130W/m2",
                "Ultimate Low Wattage Cable", "TEST_CAT_1",
            ]},
        },
        {
            "_id": 0, "id": 1, "slug": 1, "name": 1, "description": 1,
            "category": 1, "images": 1, "image_url": 1, "price": 1,
            "stock": 1, "size": 1, "finish": 1, "color": 1, "collection": 1,
        },
    ).limit(5000)  # Google Merchant Center cap is 100k; we're well under

    items_xml: list[str] = []
    async for p in cur:
        item = _product_to_item_xml(p, base)
        if item:
            items_xml.append(item)

    now = datetime.now(timezone.utc).strftime("%a, %d %b %Y %H:%M:%S +0000")
    feed = f"""<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">
  <channel>
    <title>Tile Station — UK Tiles &amp; Stone</title>
    <link>{base}</link>
    <description>Premium UK tile retailer — porcelain, marble, terrazzo, stone, outdoor pavers.</description>
    <lastBuildDate>{now}</lastBuildDate>
{chr(10).join(items_xml)}
  </channel>
</rss>"""

    return Response(
        content=feed,
        media_type="application/xml; charset=utf-8",
        headers={
            "Cache-Control": "public, max-age=3600, s-maxage=3600",
            "X-Product-Count": str(len(items_xml)),
        },
    )


def _product_to_item_xml(p: dict[str, Any], base: str) -> str | None:
    """Build a single <item> for the feed. Returns None if the product
    is missing essential fields Google requires (id, title, link,
    image, price, availability)."""
    pid = p.get("id") or p.get("slug")
    name = (p.get("name") or "").strip()
    slug = (p.get("slug") or "").strip()
    if not pid or not name or not slug:
        return None

    desc = (p.get("description") or name).strip()[:5000]

    # Image — prefer first lifestyle, fall back to image_url
    images = p.get("images") or []
    if not isinstance(images, list):
        images = []
    img = next(
        (i for i in images if isinstance(i, str) and i.startswith("https://")),
        p.get("image_url") or "",
    )
    if not img or not img.startswith("https://"):
        return None

    # Additional images (Google accepts up to 10)
    extra_imgs = [
        i for i in images
        if isinstance(i, str) and i.startswith("https://") and i != img
    ][:9]

    price = p.get("price") or 0
    try:
        price_val = float(price)
    except Exception:
        price_val = 0.0
    if price_val <= 0:
        # Google requires a price > 0
        return None

    stock = p.get("stock")
    if isinstance(stock, dict):
        # If stock is per-warehouse dict, sum it
        try:
            stock_total = sum(int(v or 0) for v in stock.values())
        except Exception:
            stock_total = 0
    elif isinstance(stock, (int, float)):
        stock_total = int(stock)
    else:
        stock_total = 1  # assume in stock if not explicitly tracked

    availability = "in_stock" if stock_total > 0 else "out_of_stock"

    cat = (p.get("category") or "Tile").strip()
    google_cat = _google_product_category(cat)
    brand = "Tile Station"

    extras_xml = "\n".join(
        f"      <g:additional_image_link>{escape(i)}</g:additional_image_link>"
        for i in extra_imgs
    )

    # Optional product attributes
    optional_attrs = []
    if p.get("size"):
        optional_attrs.append(f"      <g:size>{escape(str(p['size']))}</g:size>")
    if p.get("color"):
        optional_attrs.append(f"      <g:color>{escape(str(p['color']))}</g:color>")
    if p.get("finish"):
        optional_attrs.append(f"      <g:material>{escape(str(p['finish']))}</g:material>")
    if p.get("collection"):
        optional_attrs.append(
            f"      <g:product_type>{escape(str(p['collection']))}</g:product_type>"
        )
    optional_xml = "\n".join(optional_attrs)

    link = f"{base}/shop/product/{slug}?utm_source=google_shopping&utm_medium=organic"

    return f"""    <item>
      <g:id>{escape(str(pid))}</g:id>
      <title>{escape(name[:150])}</title>
      <description>{escape(desc)}</description>
      <link>{escape(link)}</link>
      <g:image_link>{escape(img)}</g:image_link>
{extras_xml}
      <g:availability>{availability}</g:availability>
      <g:price>{price_val:.2f} GBP</g:price>
      <g:condition>new</g:condition>
      <g:brand>{escape(brand)}</g:brand>
      <g:google_product_category>{escape(google_cat)}</g:google_product_category>
      <g:identifier_exists>no</g:identifier_exists>
{optional_xml}
    </item>"""


def _google_product_category(cat: str) -> str:
    """Map our internal category to Google's official Product Taxonomy.
    Full list at https://www.google.com/basepages/producttype/taxonomy.en-GB.txt"""
    cat_l = (cat or "").lower()
    if "outdoor" in cat_l:
        return "Hardware > Building Materials > Hardscaping > Pavers & Stepping Stones"
    if "wall" in cat_l:
        return "Hardware > Building Materials > Tile"
    return "Hardware > Building Materials > Tile"

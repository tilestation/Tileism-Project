"""
Clearance Platform — one place to run clearance:
- Mark/unmark products as Clearance from any Manager or the Bulk Editor
  (auto-publishes drafts that aren't live yet, so nothing is "missing").
- Hub listing (GET /products) powering /admin/clearance.
- Branded PDF leaflet generator (poster 4-up / compact 8-up layouts).
- Published leaflet config so the storefront "Download Leaflet" button
  always serves fresh prices/stock.
"""
from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime, timezone
from io import BytesIO
import os
import logging
import requests

from pymongo import MongoClient
from services import get_current_user
from services.auth import require_admin_access

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/clearance", tags=["Clearance"])

CLEARANCE_VARIANTS = ["Clearance", "CLEARANCE", "clearance"]

_client = MongoClient(os.environ["MONGO_URL"])


def get_db():
    return _client[os.environ["DB_NAME"]]


def _clearance_query():
    return {"$or": [
        {"labels": {"$in": CLEARANCE_VARIANTS}},
        {"labels": {"$regex": r"^\s*clearance\s*$", "$options": "i"}},
        {"custom_labels": {"$in": CLEARANCE_VARIANTS}},
        {"custom_labels": {"$regex": r"^\s*clearance\s*$", "$options": "i"}},
    ]}


def _doc_key(doc: dict) -> str:
    return str(doc.get("sku") or doc.get("supplier_code") or "").strip()


def _skus_query(skus: List[str]):
    values = [str(s or "").strip() for s in (skus or []) if str(s or "").strip()]
    if not values:
        return {"_id": {"$exists": False}}
    return {"$or": [{"sku": {"$in": values}}, {"supplier_code": {"$in": values}}]}


def _product_refs_query(refs: List["ProductRef"]):
    clauses = []
    for ref in refs or []:
        raw = str((ref.sku if ref else "") or "").strip()
        if not raw:
            continue
        supplier = str((ref.supplier if ref else "") or "").strip()
        clauses.append({"sku": raw})
        clauses.append({"supplier_code": raw})
        if supplier:
            clauses.append({"supplier": supplier, "supplier_code": raw})
            clauses.append({"supplier_name": supplier, "supplier_code": raw})
            clauses.append({"supplier": supplier, "sku": raw})
            clauses.append({"supplier_name": supplier, "sku": raw})
    return {"$or": clauses} if clauses else {"_id": {"$exists": False}}


def _first_image(doc):
    imgs = doc.get("images")
    if isinstance(imgs, list):
        for i in imgs:
            if i:
                return i
    return doc.get("image")


@router.get("/products")
def get_clearance_products():
    """Hub list: every product marked Clearance, merged across draft + live."""
    db = get_db()
    tiles_by_sku = {}
    for t in db.tiles.find(_clearance_query(), {
        "_id": 0, "sku": 1, "supplier_code": 1, "name": 1, "display_name": 1, "images": 1, "image": 1,
        "price": 1, "was_price": 1, "discount_percentage": 1, "sale_active": 1,
        "stock_m2": 1, "stock": 1, "product_group": 1, "pricing_unit": 1,
        "supplier_name": 1, "attributes.size": 1, "size": 1,
    }):
        key = _doc_key(t)
        if key:
            tiles_by_sku[key] = t

    items, seen = [], set()
    for sp in db.supplier_products.find(_clearance_query(), {
        "_id": 0, "sku": 1, "supplier_code": 1, "supplier": 1, "product_name": 1,
        "our_product_name": 1, "name": 1, "images": 1, "list_price": 1, "price": 1,
        "was_price": 1, "discount_percentage": 1, "size": 1, "product_group": 1,
        "stock_m2": 1, "stock_quantity": 1, "pricing_unit": 1,
    }):
        sku = _doc_key(sp)
        if not sku or sku in seen:
            continue
        seen.add(sku)
        t = tiles_by_sku.pop(sku, None)
        items.append(_hub_item(sku, sp, t))

    # Clearance-labelled live tiles whose draft isn't labelled (edge case)
    for sku, t in tiles_by_sku.items():
        if sku in seen:
            continue
        items.append(_hub_item(sku, {}, t))

    items.sort(key=lambda x: (x["name"] or "").lower())
    return {"total": len(items), "items": items}


def _hub_item(sku, sp, t):
    live = t is not None
    price = (t or {}).get("price") or sp.get("list_price") or sp.get("price") or 0
    was = (t or {}).get("was_price") or sp.get("was_price")
    pct = (t or {}).get("discount_percentage") or sp.get("discount_percentage")
    # Inverted/legacy data guard — a WAS at or below NOW is meaningless
    if was and price and float(was) <= float(price):
        was = None
        pct = None
    if not pct and was and price and float(was) > float(price):
        pct = round((float(was) - float(price)) / float(was) * 100)
    return {
        "sku": sku,
        "supplier": sp.get("supplier") or (t or {}).get("supplier_name") or "",
        "name": (t or {}).get("display_name") or (t or {}).get("name")
                or sp.get("our_product_name") or sp.get("product_name") or sp.get("name") or sku,
        "image": (_first_image(t) if t else None) or _first_image(sp),
        "size": ((t or {}).get("attributes") or {}).get("size") or (t or {}).get("size") or sp.get("size") or "",
        "price": float(price) if price else 0,
        "was_price": float(was) if was else None,
        "discount_percentage": int(pct) if pct else None,
        "stock_m2": (t or {}).get("stock_m2") or sp.get("stock_m2") or (t or {}).get("stock") or 0,
        "pricing_unit": (t or {}).get("pricing_unit") or sp.get("pricing_unit") or "",
        "product_group": (t or {}).get("product_group") or sp.get("product_group") or "",
        "published": live,
    }


class ProductRef(BaseModel):
    sku: str
    supplier: Optional[str] = None


class MarkRequest(BaseModel):
    product_ids: List[ProductRef]
    on: bool = True


@router.post("/mark")
def mark_clearance(data: MarkRequest, current_user: dict = Depends(get_current_user)):
    """One-click Clearance toggle on the label ONLY — nothing is published.
    Admin reviews/edits drafts and publishes manually from the Clearance Hub."""
    require_admin_access(current_user)
    if not data.product_ids:
        raise HTTPException(status_code=400, detail="No products provided")
    db = get_db()
    refs = [p for p in data.product_ids if p and p.sku]
    skus = [str(p.sku).strip() for p in refs if str(p.sku).strip()]
    ref_q = _product_refs_query(refs)

    if data.on:
        update = {"$addToSet": {"labels": "Clearance"},
                  "$set": {"last_updated": datetime.now(timezone.utc)}}
    else:
        update = {"$pull": {"labels": {"$in": CLEARANCE_VARIANTS},
                            "custom_labels": {"$in": CLEARANCE_VARIANTS}},
                  "$set": {"last_updated": datetime.now(timezone.utc)}}

    r1 = db.supplier_products.update_many(ref_q, update)
    db.products.update_many(ref_q, update)
    r3 = db.tiles.update_many(ref_q, update)

    live_keys = {
        _doc_key(doc)
        for doc in db.tiles.find(ref_q, {"_id": 0, "sku": 1, "supplier_code": 1})
        if _doc_key(doc)
    }
    requested_keys = set(skus)
    live = len(requested_keys & live_keys)
    drafts = len(requested_keys - live_keys)

    return {
        "success": True,
        "marked": r1.modified_count,
        "tiles_updated": r3.modified_count,
        "live_count": live,
        "draft_count": max(drafts, 0),
        "message": (f"{'Marked' if data.on else 'Removed'} {len(skus)} product(s)"
                    + (f" · {live} already live" if data.on and live else "")
                    + (f" · {drafts} draft(s) — publish manually from the Clearance Hub when ready" if data.on and drafts > 0 else "")),
    }


class SkusRequest(BaseModel):
    skus: List[str]


@router.post("/publish")
def publish_clearance_products(data: SkusRequest, current_user: dict = Depends(get_current_user)):
    """Manual publish — admin explicitly pushes reviewed clearance drafts live."""
    require_admin_access(current_user)
    if not data.skus:
        raise HTTPException(status_code=400, detail="No SKUs provided")
    db = get_db()
    try:
        from routes.supplier_sync import publish_supplier_products_to_website
        res = publish_supplier_products_to_website(with_price_only=False, skus=",".join(data.skus))
    except Exception as e:
        logger.error(f"Clearance manual publish failed: {e}")
        raise HTTPException(status_code=500, detail=f"Publish failed: {e}")
    db.tiles.update_many(_skus_query(data.skus), {"$addToSet": {"labels": "Clearance"}})
    published = (res or {}).get("published", 0) + (res or {}).get("updated", 0)
    return {"success": True, "published": published,
            "message": f"Published {published} product(s) to the storefront"}


@router.post("/unpublish")
def unpublish_clearance_products(data: SkusRequest, current_user: dict = Depends(get_current_user)):
    """Take products OFF the live storefront (keeps the draft + Clearance label)."""
    require_admin_access(current_user)
    if not data.skus:
        raise HTTPException(status_code=400, detail="No SKUs provided")
    db = get_db()
    q = _skus_query(data.skus)
    r = db.tiles.delete_many(q)
    db.supplier_products.update_many(
        q,
        {"$set": {"published": False, "show_on_website": False}})
    db.products.update_many(q,
                            {"$set": {"show_on_website": False, "visibility": "draft"}})
    return {"success": True, "unpublished": r.deleted_count,
            "message": f"Removed {r.deleted_count} product(s) from the storefront (drafts kept)"}


# ============ PDF LEAFLET ============

class LeafletRequest(BaseModel):
    skus: Optional[List[str]] = None   # None/empty = all clearance products
    layout: str = "poster"             # 'poster' (4/page) | 'compact' (8/page)


def _leaflet_products(db, skus):
    requested = [str(s or "").strip() for s in (skus or []) if str(s or "").strip()][:60]
    q = {**_clearance_query(), **(_skus_query(requested) if requested else {})}

    tiles_docs = list(db.tiles.find(q, {
        "_id": 0, "sku": 1, "supplier_code": 1, "name": 1, "display_name": 1, "images": 1, "image": 1,
        "price": 1, "was_price": 1, "discount_percentage": 1,
        "stock_m2": 1, "stock": 1, "pricing_unit": 1, "attributes.size": 1, "size": 1,
        "supplier_name": 1, "product_group": 1,
    }))
    supplier_docs = list(db.supplier_products.find(q, {
        "_id": 0, "sku": 1, "supplier_code": 1, "supplier": 1, "product_name": 1,
        "our_product_name": 1, "name": 1, "images": 1, "image": 1, "list_price": 1, "price": 1,
        "was_price": 1, "discount_percentage": 1, "size": 1, "product_group": 1,
        "stock_m2": 1, "stock_quantity": 1, "pricing_unit": 1,
    }))

    tiles_by_key = { _doc_key(doc): doc for doc in tiles_docs if _doc_key(doc) }
    supplier_by_key = { _doc_key(doc): doc for doc in supplier_docs if _doc_key(doc) }

    keys = requested or sorted(set(tiles_by_key) | set(supplier_by_key))
    docs = []
    for key in keys:
        sp = supplier_by_key.get(key)
        t = tiles_by_key.get(key)
        if not sp and not t:
            continue
        docs.append(_hub_item(key, sp or {}, t))
    return docs


def _fetch_image(url, cache):
    if not url:
        return None
    if url in cache:
        return cache[url]
    try:
        r = requests.get(url, timeout=6)
        r.raise_for_status()
        from reportlab.lib.utils import ImageReader
        img = ImageReader(BytesIO(r.content))
        cache[url] = img
        return img
    except Exception:
        cache[url] = None
        return None


YELLOW = (0.898, 0.851, 0.094)   # #e5d918
FIRE_RED = (1.0, 0.165, 0.0)     # #FF2A00
BLACK = (0.04, 0.04, 0.04)


def _draw_header(c, W, H):
    c.setFillColorRGB(*BLACK)
    c.rect(0, H - 110, W, 110, fill=1, stroke=0)
    c.setFillColorRGB(*FIRE_RED)
    c.setFont("Helvetica-Bold", 52)
    c.drawString(42, H - 76, "CLEARANCE")
    c.setFillColorRGB(*YELLOW)
    c.drawString(40, H - 74, "CLEARANCE")
    c.setFillColorRGB(*FIRE_RED)
    c.rect(40, H - 100, 300, 17, fill=1, stroke=0)
    c.setFillColorRGB(1, 1, 1)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(48, H - 95.5, "WHILE STOCKS LAST  ·  FIRST COME, FIRST SERVED")
    c.setFillColorRGB(*YELLOW)
    c.setFont("Helvetica-Bold", 13)
    c.drawRightString(W - 40, H - 62, "TILE STATION")
    c.setFillColorRGB(0.7, 0.7, 0.7)
    c.setFont("Helvetica", 8)
    c.drawRightString(W - 40, H - 76, datetime.now(timezone.utc).strftime("%d %b %Y"))


def _draw_footer(c, W):
    c.setFillColorRGB(*YELLOW)
    c.rect(0, 0, W, 26, fill=1, stroke=0)
    c.setFillColorRGB(*BLACK)
    c.setFont("Helvetica-Bold", 9)
    c.drawCentredString(W / 2, 9, "FINAL REDUCTIONS — ONCE THEY'RE GONE, THEY'RE GONE")


def _price_label(p):
    unit = "" if (p.get("pricing_unit") == "unit") else "/m²"
    return f"£{float(p.get('price') or 0):.2f}{unit}"


def _draw_cell(c, p, x, y, w, h, img_cache, compact=False):
    name = p.get("display_name") or p.get("name") or p.get("sku") or ""
    size = (p.get("attributes") or {}).get("size") or p.get("size") or ""
    was = p.get("was_price")
    price = float(p.get("price") or 0)
    pct = p.get("discount_percentage")
    if not pct and was and float(was) > price > 0:
        pct = round((float(was) - price) / float(was) * 100)
    stock = p.get("stock_m2") or p.get("stock") or 0

    c.setStrokeColorRGB(0.85, 0.85, 0.85)
    c.setLineWidth(1)
    c.rect(x, y, w, h, fill=0, stroke=1)

    img = _fetch_image(_first_image(p), img_cache)
    if compact:
        iw, ih = 62, 62
        ix, iy = x + 8, y + h - ih - 8
    else:
        iw, ih = w - 20, h * 0.52
        ix, iy = x + 10, y + h - ih - 10
    if img:
        try:
            c.drawImage(img, ix, iy, width=iw, height=ih, preserveAspectRatio=True, anchor='c', mask='auto')
        except Exception:
            img = None
    if not img:
        c.setFillColorRGB(0.93, 0.93, 0.93)
        c.rect(ix, iy, iw, ih, fill=1, stroke=0)
        c.setFillColorRGB(0.6, 0.6, 0.6)
        c.setFont("Helvetica", 7)
        c.drawCentredString(ix + iw / 2, iy + ih / 2, "Image unavailable")

    tx = (x + 80) if compact else (x + 10)
    ty = (y + h - 20) if compact else (iy - 16)
    max_chars = 34 if compact else 40
    c.setFillColorRGB(*BLACK)
    c.setFont("Helvetica-Bold", 9 if compact else 11)
    line1 = name[:max_chars]
    line2 = name[max_chars:max_chars * 2] if len(name) > max_chars else ""
    c.drawString(tx, ty, line1)
    if line2:
        c.drawString(tx, ty - 11, line2.strip())
    if size:
        c.setFillColorRGB(0.45, 0.45, 0.45)
        c.setFont("Helvetica", 8)
        c.drawString(tx, ty - (23 if line2 else 12), size)

    py = (y + 14) if compact else (y + 30)
    if was and float(was) > price:
        c.setFillColorRGB(0.5, 0.5, 0.5)
        c.setFont("Helvetica", 9)
        was_txt = f"WAS £{float(was):.2f}"
        c.drawString(tx, py + (16 if compact else 22), was_txt)
        tw = c.stringWidth(was_txt, "Helvetica", 9)
        c.setStrokeColorRGB(*FIRE_RED)
        c.setLineWidth(1.2)
        c.line(tx - 1, py + (19 if compact else 25), tx + tw + 1, py + (19 if compact else 25))
    c.setFillColorRGB(*FIRE_RED)
    c.setFont("Helvetica-Bold", 15 if compact else 22)
    c.drawString(tx, py, f"NOW {_price_label(p)}")
    if pct:
        badge = f"{int(pct)}% OFF"
        c.setFont("Helvetica-Bold", 8 if compact else 10)
        bw = c.stringWidth(badge, "Helvetica-Bold", 8 if compact else 10) + 10
        bx = x + w - bw - 8
        c.setFillColorRGB(*BLACK)
        c.rect(bx, py - 2, bw, 14 if compact else 16, fill=1, stroke=0)
        c.setFillColorRGB(*YELLOW)
        c.drawString(bx + 5, py + (1 if compact else 2), badge)
    if not compact:
        c.setFillColorRGB(0.9, 0.45, 0.0)
        c.setFont("Helvetica-Bold", 8)
        note = f"Only {stock:g} m² left — while stocks last" if stock and float(stock) > 0 else "Limited stock — while stocks last"
        c.drawString(tx, y + 12, note)


def _build_leaflet_pdf(products, layout):
    from reportlab.pdfgen import canvas as rl_canvas
    from reportlab.lib.pagesizes import A4
    buf = BytesIO()
    c = rl_canvas.Canvas(buf, pagesize=A4)
    W, H = A4
    img_cache = {}
    compact = layout == "compact"
    cols = 2
    rows = 4 if compact else 2
    per_page = cols * rows
    top, bottom, side, gap = 125, 40, 32, 12
    cw = (W - side * 2 - gap * (cols - 1)) / cols
    ch = (H - top - bottom - gap * (rows - 1)) / rows

    for i, p in enumerate(products):
        pos = i % per_page
        if pos == 0:
            if i > 0:
                c.showPage()
            _draw_header(c, W, H)
            _draw_footer(c, W)
        col = pos % cols
        row = pos // cols
        x = side + col * (cw + gap)
        y = H - top - ch - row * (ch + gap)
        _draw_cell(c, p, x, y, cw, ch, img_cache, compact=compact)

    if not products:
        _draw_header(c, W, H)
        _draw_footer(c, W)
        c.setFillColorRGB(0.4, 0.4, 0.4)
        c.setFont("Helvetica", 14)
        c.drawCentredString(W / 2, H / 2, "No clearance products right now — check back soon!")
    c.save()
    buf.seek(0)
    return buf


@router.post("/leaflet/generate")
def generate_leaflet(data: LeafletRequest, current_user: dict = Depends(get_current_user)):
    """Generate the CLEARANCE leaflet PDF on demand (admin download)."""
    require_admin_access(current_user)
    if data.layout not in ("poster", "compact"):
        raise HTTPException(status_code=400, detail="layout must be 'poster' or 'compact'")
    db = get_db()
    products = _leaflet_products(db, data.skus or None)
    buf = _build_leaflet_pdf(products, data.layout)
    fname = f"clearance-leaflet-{datetime.now(timezone.utc).strftime('%Y%m%d')}.pdf"
    return StreamingResponse(buf, media_type="application/pdf",
                             headers={"Content-Disposition": f'inline; filename="{fname}"'})


class LeafletPublishRequest(BaseModel):
    skus: Optional[List[str]] = None
    layout: str = "poster"


@router.put("/leaflet/publish")
def publish_leaflet(data: LeafletPublishRequest, current_user: dict = Depends(get_current_user)):
    """Save the leaflet config the storefront download button serves."""
    require_admin_access(current_user)
    if data.layout not in ("poster", "compact"):
        raise HTTPException(status_code=400, detail="layout must be 'poster' or 'compact'")
    db = get_db()
    db.clearance_leaflet.update_one(
        {"_id": "current"},
        {"$set": {"skus": data.skus or [], "layout": data.layout,
                  "published_at": datetime.now(timezone.utc)}},
        upsert=True,
    )
    return {"success": True, "message": "Clearance leaflet published to the website"}


@router.get("/leaflet/config")
def get_leaflet_config():
    db = get_db()
    cfg = db.clearance_leaflet.find_one({"_id": "current"}, {"_id": 0}) or {}
    return {"skus": cfg.get("skus", []), "layout": cfg.get("layout", "poster"),
            "published_at": str(cfg.get("published_at") or "")}


@router.get("/leaflet/current.pdf")
def download_current_leaflet():
    """Storefront download — always fresh prices/stock. Falls back to ALL
    clearance products when no leaflet has been explicitly published."""
    db = get_db()
    cfg = db.clearance_leaflet.find_one({"_id": "current"}) or {}
    skus = cfg.get("skus") or None
    layout = cfg.get("layout", "poster")
    products = _leaflet_products(db, skus)
    if not products and skus:
        products = _leaflet_products(db, None)
    buf = _build_leaflet_pdf(products, layout)
    return StreamingResponse(buf, media_type="application/pdf",
                             headers={"Content-Disposition": 'inline; filename="clearance-leaflet.pdf"',
                                      "Cache-Control": "no-store"})

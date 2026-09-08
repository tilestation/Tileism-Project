"""
SEO Auto-Fixer — turns self-crawler findings into shippable repairs.

Where it sits in the pipeline
─────────────────────────────
   self_crawler.run_self_crawl()  →  per-URL issue rows
              │
              ▼
   auto_fix_from_latest_crawl()  ← THIS MODULE
              │
              ├─ writes `db.seo_overrides`  (consumed by server-seo.js
              │   every 5 min — same dynamic-config pattern as redirects)
              ├─ writes `db.seo_redirects`  (for 404 → 301 fixes)
              └─ writes `db.seo_noindex_flags` (for duplicate-title losers)
              │
              ▼
   /api/seo/overrides  ← server-seo.js polls this every 5 min
              │
              ▼
   Express SSR injects title/description/jsonld/canonical PER URL
   based on the override map — without a code deploy.

What it auto-fixes
──────────────────
  • fallback_title      → generate title from URL slug, write override
  • missing_title       → same path as fallback_title
  • missing_description → generate description from title + URL category
  • short_description   → regenerate to ≥120 chars
  • missing_canonical   → write self-referential canonical
  • missing_jsonld      → write generic WebPage JSON-LD
  • missing_h1          → covered by the SSR body-content injector
  • thin_content        → covered by the SSR body-content injector
  • duplicate_title     → for the lower-priority URL of each pair,
                          add ` · Page 2` to its override OR mark noindex
  • not_found / 5xx     → 404 autopilot (existing)

What it does NOT auto-fix (flags only — needs human)
────────────────────────────────────────────────────
  • redirect_from_canonical (could be intentional route change)
  • server_error / 5xx (real bug — alert admin instead)
  • html_parse_error (bigger issue)
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse

from config import get_db
from services.seo_autopilot import _log_action, _suggest_redirect_target

logger = logging.getLogger(__name__)

OVERRIDES_COLLECTION = "seo_overrides"
REDIRECTS_COLLECTION = "seo_redirects"
NOINDEX_FLAGS_COLLECTION = "seo_noindex_flags"
CRAWL_RESULTS_COLLECTION = "seo_self_crawl_results"

BRAND = "Tile Station"


# ─── Slug → human title heuristics ──────────────────────────────────


def _titlecase_slug(slug: str) -> str:
    """`brilliant-white-60x60cm` → `Brilliant White 60x60cm`."""
    if not slug:
        return ""
    raw = slug.replace("-", " ").replace("_", " ").strip()
    # Preserve obvious numeric tokens like 60x60cm
    return " ".join(
        w if re.match(r"^\d", w) else w.capitalize()
        for w in raw.split()
    )


def _title_for_path(path: str) -> str:
    """Derive a unique, descriptive title from a URL path."""
    parts = [p for p in (path or "").split("/") if p]
    if not parts:
        return f"Home · {BRAND}"

    # Collection PDPs: /shop/collection/<name>
    if len(parts) >= 3 and parts[0] == "shop" and parts[1] == "collection":
        return f"{_titlecase_slug(parts[2])} Collection · {BRAND}"

    # Product PDPs: /shop/product/<slug> | /shop/tiles/<slug> | /shop/products/<slug>
    if len(parts) >= 3 and parts[0] == "shop" and parts[1] in ("product", "products", "tiles"):
        return f"{_titlecase_slug(parts[2])} · {BRAND}"

    # Info pages: /shop/info/<slug>
    if len(parts) >= 3 and parts[0] == "shop" and parts[1] == "info":
        return f"{_titlecase_slug(parts[2])} · {BRAND}"

    # Tiles listing or city-landing: /tiles/<slug>
    if len(parts) >= 2 and parts[0] == "tiles":
        return f"{_titlecase_slug(parts[1])} Tiles · {BRAND}"

    # Last-segment fallback
    return f"{_titlecase_slug(parts[-1])} · {BRAND}"


def _description_for_path(path: str, title: str) -> str:
    """Generate a 120-160 char meta description from the path category."""
    parts = [p for p in (path or "").split("/") if p]
    if len(parts) >= 3 and parts[0] == "shop" and parts[1] == "collection":
        name = _titlecase_slug(parts[2])
        return (
            f"Explore the {name} tile collection at {BRAND} — free UK samples, "
            f"trade pricing and fast delivery on every order. Browse the full range and order today."
        )
    if len(parts) >= 3 and parts[0] == "shop" and parts[1] in ("product", "products", "tiles"):
        name = _titlecase_slug(parts[2])
        return (
            f"Buy {name} at {BRAND}. Premium UK tile retailer with three showrooms, "
            f"free samples and trade pricing. Fast delivery across England, Scotland & Wales."
        )
    if len(parts) >= 3 and parts[0] == "shop" and parts[1] == "info":
        name = _titlecase_slug(parts[2])
        return f"{name} — {BRAND} information page. UK tile, bathroom and flooring specialists with showrooms across Kent and Essex."
    if len(parts) >= 2 and parts[0] == "tiles":
        return (
            f"Browse {_titlecase_slug(parts[1])} tiles at {BRAND}. "
            f"Porcelain, marble, ceramic, vinyl and engineered wood — UK delivery, trade pricing and free samples."
        )
    # Fallback: derive from title
    base = (title or "").split("·")[0].strip() or "Tile Station"
    return (
        f"{base} at {BRAND}. UK tile, bathroom and flooring retailer with three showrooms, "
        f"free samples, trade pricing and fast delivery across the UK."
    )


def _jsonld_for_path(path: str, *, title: str, description: str) -> dict[str, Any]:
    """Generic WebPage JSON-LD — safe to inject on any page that doesn't
    already have a more specific schema (Product, ItemList, Article)."""
    full_url = f"https://www.tilestation.co.uk{path}"
    return {
        "@context": "https://schema.org",
        "@type": "WebPage",
        "name": title,
        "description": description,
        "url": full_url,
        "isPartOf": {
            "@type": "WebSite",
            "name": BRAND,
            "url": "https://www.tilestation.co.uk",
        },
        "publisher": {
            "@type": "Organization",
            "name": BRAND,
            "url": "https://www.tilestation.co.uk",
        },
        "inLanguage": "en-GB",
    }


# ─── Auto-fix orchestrator ──────────────────────────────────────────


async def _write_override(path: str, *, fields: dict[str, Any], reason: str) -> None:
    """Upsert into seo_overrides. `path` is the document _id so server.js
    can do O(1) lookup."""
    db = get_db()
    now = datetime.now(timezone.utc)
    await db[OVERRIDES_COLLECTION].update_one(
        {"_id": path},
        {
            "$set": {
                "_id": path,
                **fields,
                "auto_fix_reason": reason,
                "updated_at": now,
            },
            "$setOnInsert": {"created_at": now},
        },
        upsert=True,
    )


async def auto_fix_from_latest_crawl() -> dict[str, Any]:
    """Iterate over the latest crawl results and apply real auto-fixes.

    Returns a per-issue fix-count summary.
    """
    db = get_db()
    fixes: dict[str, int] = {
        "fallback_title_fixed": 0,
        "missing_title_fixed": 0,
        "missing_description_fixed": 0,
        "short_description_fixed": 0,
        "missing_jsonld_fixed": 0,
        "missing_canonical_fixed": 0,
        "duplicate_title_flagged": 0,
        "not_found_redirected": 0,
        "thin_content_flagged": 0,
        "redirect_canonical_flagged": 0,
        "server_error_flagged": 0,
    }

    # ── 1. Title-related fixes ───────────────────────────────────
    title_issues = {"fallback_title", "missing_title"}
    cursor = db[CRAWL_RESULTS_COLLECTION].find(
        {"issues.kind": {"$in": list(title_issues)}}
    )
    async for row in cursor:
        path = row.get("path") or urlparse(row.get("url", "")).path
        if not path:
            continue
        kind = "fallback_title" if any(
            i["kind"] == "fallback_title" for i in row.get("issues", [])
        ) else "missing_title"
        new_title = _title_for_path(path)
        new_desc = _description_for_path(path, new_title)
        await _write_override(
            path,
            fields={"title": new_title, "description": new_desc},
            reason=kind,
        )
        fixes[f"{kind}_fixed"] += 1
        await _log_action(
            "seo_override_written",
            path=path, field="title+description", kind=kind,
        )

    # ── 2. Description-only fixes (title was fine) ───────────────
    desc_issues = {"missing_description", "short_description"}
    cursor = db[CRAWL_RESULTS_COLLECTION].find(
        {"issues.kind": {"$in": list(desc_issues)}}
    )
    async for row in cursor:
        path = row.get("path") or urlparse(row.get("url", "")).path
        if not path:
            continue
        existing_title = (row.get("title") or "").strip()
        if not existing_title:
            continue  # skip — title fixer handles this
        # Skip if we already wrote a description in title-fix loop
        existing = await db[OVERRIDES_COLLECTION].find_one(
            {"_id": path}, {"description": 1}
        )
        if existing and existing.get("description"):
            continue
        kind = "missing_description" if any(
            i["kind"] == "missing_description" for i in row.get("issues", [])
        ) else "short_description"
        new_desc = _description_for_path(path, existing_title)
        await _write_override(
            path,
            fields={"description": new_desc},
            reason=kind,
        )
        fixes[f"{kind}_fixed"] += 1

    # ── 3. JSON-LD fixes ─────────────────────────────────────────
    cursor = db[CRAWL_RESULTS_COLLECTION].find({"issues.kind": "missing_jsonld"})
    async for row in cursor:
        path = row.get("path") or urlparse(row.get("url", "")).path
        if not path:
            continue
        title = (row.get("title") or _title_for_path(path)).strip()
        existing = await db[OVERRIDES_COLLECTION].find_one(
            {"_id": path}, {"description": 1}
        )
        desc = (existing or {}).get("description") or _description_for_path(path, title)
        jsonld = _jsonld_for_path(path, title=title, description=desc)
        await _write_override(
            path,
            fields={"jsonld": jsonld},
            reason="missing_jsonld",
        )
        fixes["missing_jsonld_fixed"] += 1

    # ── 4. Canonical fixes ───────────────────────────────────────
    cursor = db[CRAWL_RESULTS_COLLECTION].find({"issues.kind": "missing_canonical"})
    async for row in cursor:
        path = row.get("path") or urlparse(row.get("url", "")).path
        if not path:
            continue
        canonical = f"https://www.tilestation.co.uk{path}"
        await _write_override(
            path,
            fields={"canonical": canonical},
            reason="missing_canonical",
        )
        fixes["missing_canonical_fixed"] += 1

    # ── 5. Duplicate titles — flag the loser (longest URL) as noindex ──
    # This stops Google from picking the wrong one. The "winner" stays
    # indexed; the others get a one-click revert in admin.
    #
    # 5 Jun 2026 — added ALWAYS_INDEXABLE safe-list. The autofixer was
    # over-firing on category pages that legitimately share a title
    # pattern with the homepage; specifically /new-collection ended up
    # flagged as noindex even though it had 51 inlinks from the main
    # nav. Mirror the same safe-list lives in frontend/server-seo.js as
    # a belt-and-braces second layer.
    # 8 Sep 2026 — both ALWAYS_INDEXABLE_PATHS and the product-PDP regex
    # are now single module-level constants (see below in this file) so
    # this loop and the boot-time purges can never drift out of sync.
    dup_pipeline = [
        {"$match": {"title": {"$ne": ""}, "issues.kind": {"$ne": "fallback_title"}}},
        {"$group": {
            "_id": {"$toLower": "$title"},
            "urls": {"$push": "$url"},
            "n": {"$sum": 1},
        }},
        {"$match": {"n": {"$gte": 2}}},
    ]
    async for cluster in db[CRAWL_RESULTS_COLLECTION].aggregate(dup_pipeline):
        urls = cluster.get("urls") or []
        if len(urls) < 2:
            continue
        # Winner = shortest URL (most canonical-looking)
        urls_sorted = sorted(urls, key=lambda u: (len(u), u))
        losers = urls_sorted[1:]
        for url in losers:
            path = urlparse(url).path
            if not path:
                continue
            if path in ALWAYS_INDEXABLE_PATHS:
                continue  # Never auto-noindex critical landing pages
            if PRODUCT_PDP_PATTERN.match(path):
                continue  # Never auto-noindex real inventory — see note above
            await db[NOINDEX_FLAGS_COLLECTION].update_one(
                {"_id": path},
                {
                    "$set": {
                        "_id": path,
                        "reason": "duplicate_title_loser",
                        "winner": urls_sorted[0],
                        "set_at": datetime.now(timezone.utc),
                    },
                },
                upsert=True,
            )
            fixes["duplicate_title_flagged"] += 1
            await _log_action(
                "seo_noindex_set",
                path=path, winner=urls_sorted[0], reason="duplicate_title",
            )

    # ── 6. 404 → 301 redirects (existing logic) ──────────────────
    cursor = db[CRAWL_RESULTS_COLLECTION].find({"issues.kind": "not_found"})
    async for row in cursor:
        path = row.get("path") or urlparse(row.get("url", "")).path
        if not path or path == "/":
            continue
        if await db[REDIRECTS_COLLECTION].find_one({"_id": path}):
            continue
        target = await _suggest_redirect_target(path) or "/tiles"
        await db[REDIRECTS_COLLECTION].update_one(
            {"_id": path},
            {"$set": {
                "_id": path,
                "target": target,
                "status_code": 301,
                "reason": "self_crawl_auto_404",
                "created_at": datetime.now(timezone.utc),
            }},
            upsert=True,
        )
        fixes["not_found_redirected"] += 1
        await _log_action(
            "auto_redirect_created",
            from_path=path, to_path=target, source="self_crawl",
        )

    # ── 7. Soft flags (alert-only) ───────────────────────────────
    fixes["thin_content_flagged"] = await db[CRAWL_RESULTS_COLLECTION].count_documents(
        {"issues.kind": "thin_content"}
    )
    fixes["redirect_canonical_flagged"] = await db[CRAWL_RESULTS_COLLECTION].count_documents(
        {"issues.kind": "redirect_from_canonical"}
    )
    fixes["server_error_flagged"] = await db[CRAWL_RESULTS_COLLECTION].count_documents(
        {"issues.kind": "server_error"}
    )

    return {"ok": True, "fixes": fixes}


async def list_overrides(*, limit: int = 200) -> list[dict[str, Any]]:
    """Admin helper — list current overrides."""
    db = get_db()
    cursor = db[OVERRIDES_COLLECTION].find(
        {},
        {"_id": 1, "title": 1, "description": 1, "canonical": 1,
         "jsonld": 1, "auto_fix_reason": 1, "updated_at": 1},
    ).sort("updated_at", -1).limit(limit)
    out = []
    async for row in cursor:
        ts = row.get("updated_at")
        out.append({
            "path": row.get("_id"),
            "title": row.get("title"),
            "description": row.get("description"),
            "canonical": row.get("canonical"),
            "has_jsonld": bool(row.get("jsonld")),
            "auto_fix_reason": row.get("auto_fix_reason"),
            "updated_at": ts.isoformat() if isinstance(ts, datetime) else None,
        })
    return out


async def delete_override(path: str) -> int:
    """Remove an override (one-click revert from admin)."""
    db = get_db()
    res = await db[OVERRIDES_COLLECTION].delete_one({"_id": path})
    if res.deleted_count:
        await _log_action("seo_override_deleted", path=path)
    return res.deleted_count


async def delete_noindex_flag(path: str) -> int:
    """Un-flag a duplicate-title loser."""
    db = get_db()
    res = await db[NOINDEX_FLAGS_COLLECTION].delete_one({"_id": path})
    if res.deleted_count:
        await _log_action("seo_noindex_cleared", path=path)
    return res.deleted_count



# 5 Jun 2026 — keep the safe-list of always-indexable paths in a single
# module-level constant. Both the autofixer (`run_auto_fixer`) and the
# boot-time cleanup (`purge_safelist_noindex_flags`) read from this so
# they can never drift out of sync. Mirror in frontend/server-seo.js.
# 8 Sep 2026 — added the 5 /shop/info/* pages. Testing agent found they
# were being noindexed by the exact same truncated-title false-positive
# that hit product PDPs (they all shared a near-identical fallback title
# before per-URL overrides existed). FAQ/terms/privacy/returns/delivery
# are legitimate, valuable indexable pages — never auto-noindex them.
ALWAYS_INDEXABLE_PATHS = {
    "/", "/new-collection", "/clearance", "/shop", "/tiles",
    "/contact", "/about", "/showrooms", "/showroom-signup",
    "/blog", "/faq", "/shop/faq",
    "/shop/info/faq", "/shop/info/terms", "/shop/info/privacy",
    "/shop/info/returns", "/shop/info/delivery",
}


async def purge_safelist_noindex_flags() -> int:
    """Remove any noindex flags accidentally written for safe-listed
    paths. Called once on backend boot so production self-heals from
    the over-firing autofixer bug (Ahrefs reported /new-collection
    flagged noindex on 5 Jun 2026 despite 51 internal links).

    Idempotent — safe to call on every boot."""
    db = get_db()
    res = await db[NOINDEX_FLAGS_COLLECTION].delete_many(
        {"_id": {"$in": list(ALWAYS_INDEXABLE_PATHS)}}
    )
    if res.deleted_count:
        await _log_action(
            "seo_noindex_safelist_purged",
            count=res.deleted_count,
            paths=list(ALWAYS_INDEXABLE_PATHS),
        )
    return res.deleted_count


# 8 Sep 2026 — real product/collection PDPs must never be auto-noindexed
# (see the PRODUCT_PDP_RE note above `duplicate_title` fixing). This
# purge un-blocks any inventory pages that were already wrongly flagged
# by the pre-fix version of the duplicate-title heuristic. Idempotent —
# safe to call on every boot.
PRODUCT_PDP_PATTERN = re.compile(
    r"^/(?:tiles|products|collections)/[^/]+/?$"
    r"|^/shop/(?:product|products|tiles|collection)/[^/]+/?$"
)


async def purge_product_pdp_noindex_flags() -> int:
    """Un-flag any real product/collection page that was incorrectly
    auto-noindexed by the duplicate-title heuristic (truncated-title
    false positives). Idempotent — safe to call on every boot."""
    db = get_db()
    ids = [
        doc["_id"]
        async for doc in db[NOINDEX_FLAGS_COLLECTION].find({}, {"_id": 1})
        if PRODUCT_PDP_PATTERN.match(doc["_id"] or "")
    ]
    if not ids:
        return 0
    res = await db[NOINDEX_FLAGS_COLLECTION].delete_many({"_id": {"$in": ids}})
    if res.deleted_count:
        await _log_action(
            "seo_noindex_product_pdp_purged",
            count=res.deleted_count,
            paths=ids,
        )
    return res.deleted_count

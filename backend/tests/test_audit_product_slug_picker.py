"""
Regression test for the audit's product-slug picker.

Bug (23 May 2026): `_pick_real_product_slug` grabbed any `tiles` doc
with a `slug` field, but some legacy docs use short slugs like
`ardesia-slate-white-3` that don't resolve via the canonical
`/api/tiles/products/<slug>` endpoint. The audit then probed a 404'd
PDP, found no og:image, and incorrectly flagged the SSR pipeline as
broken. Now the picker prefers slugs that match the modern
"<name>-<size>x<size>cm-<finish>" schema.

Contract pinned:
  * Given a mix of legacy and modern slugs, the picker returns a
    modern slug (one containing `<digits>x<digits>`).
  * If NO modern slugs exist, falls back to any active slug
    (legacy data should still be auditable, not skipped).
"""
from __future__ import annotations

import pytest


class _Coll:
    def __init__(self, docs):
        self._docs = docs
    async def find_one(self, query, *_a, **_kw):
        # Minimal mongo-query emulation for the two queries the picker
        # actually issues: regex match on slug, and the fallback
        # "exists" check.
        regex = query.get("slug", {}).get("$regex") if isinstance(query.get("slug"), dict) else None
        if regex:
            import re
            pattern = re.compile(regex, re.IGNORECASE)
            for d in self._docs:
                if d.get("is_active") is not False and pattern.search(d.get("slug", "")):
                    return d
            return None
        # Fallback: any active with a slug.
        for d in self._docs:
            if d.get("is_active") is not False and d.get("slug"):
                return d
        return None


class _DB:
    def __init__(self, docs):
        self.tiles = _Coll(docs)


@pytest.mark.asyncio
async def test_picker_prefers_modern_slug_with_size():
    """A mix of legacy and modern slugs — picker MUST return the
    modern one so the SSR enrichment can actually look it up."""
    from services.seo_self_audit import _pick_real_product_slug
    docs = [
        {"slug": "ardesia-slate-white-3"},  # legacy
        {"slug": "ardesia-slate-white-30x60cm-matt"},  # modern
        {"slug": "old-style-2"},  # legacy
    ]
    db = _DB(docs)
    slug = await _pick_real_product_slug(db)
    assert "x" in slug.lower() and "cm" in slug.lower(), (
        f"Expected a modern slug with `<n>x<n>cm`, got legacy {slug!r}. "
        f"The audit must NOT probe stale slugs that 404 on the lookup endpoint."
    )


@pytest.mark.asyncio
async def test_picker_falls_back_to_legacy_if_no_modern_slugs():
    """Defensive — if a deployment only has legacy data, the audit
    should still find SOMETHING to probe, not return None and skip
    the entire PDP audit section."""
    from services.seo_self_audit import _pick_real_product_slug
    db = _DB([{"slug": "legacy-only"}, {"slug": "legacy-two"}])
    slug = await _pick_real_product_slug(db)
    assert slug in ("legacy-only", "legacy-two")


@pytest.mark.asyncio
async def test_picker_skips_inactive_rows():
    """Inactive tiles must NOT be picked — their PDPs return 404."""
    from services.seo_self_audit import _pick_real_product_slug
    db = _DB([
        {"slug": "inactive-30x60cm-matt", "is_active": False},
        {"slug": "active-30x60cm-matt", "is_active": True},
    ])
    slug = await _pick_real_product_slug(db)
    assert slug == "active-30x60cm-matt"

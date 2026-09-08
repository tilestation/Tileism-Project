"""
Tests for the 8 Sep 2026 SEO auto-fixer fix:
  1. PRODUCT_PDP_RE excludes product/collection PDPs from the
     duplicate-title-loser noindex heuristic (truncation false-positive).
  2. purge_product_pdp_noindex_flags() boot-time cleanup un-flags any
     inventory pages the pre-fix version wrongly noindexed.
  3. DEFAULT_COMPETITORS now includes righttiles.co.uk.
  4. Live /api/seo/overrides no longer contains the 4 specific product
     paths that were mis-flagged.
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import requests


def _load_backend_url() -> str:
    val = os.environ.get("REACT_APP_BACKEND_URL", "").strip()
    if val:
        return val.rstrip("/")
    env_path = Path("/app/frontend/.env")
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            if line.startswith("REACT_APP_BACKEND_URL="):
                return line.split("=", 1)[1].strip().rstrip("/")
    return ""


BASE_URL = _load_backend_url()


# ─── Live API check ────────────────────────────────────────────────
class TestSeoOverridesLive:
    def test_overrides_endpoint_shape(self):
        r = requests.get(f"{BASE_URL}/api/seo/overrides", timeout=30)
        assert r.status_code == 200
        data = r.json()
        for k in ("overrides", "noindex_paths", "count", "noindex_count", "version"):
            assert k in data, f"missing key: {k}"
        assert isinstance(data["overrides"], dict)
        assert isinstance(data["noindex_paths"], list)
        assert isinstance(data["count"], int)
        assert isinstance(data["noindex_count"], int)
        assert data["noindex_count"] == len(data["noindex_paths"])
        assert data["count"] == len(data["overrides"])

    def test_specific_mis_flagged_products_not_noindexed(self):
        r = requests.get(f"{BASE_URL}/api/seo/overrides", timeout=30)
        assert r.status_code == 200
        paths = r.json().get("noindex_paths", [])
        # The 4 previously wrongly-flagged products should be gone.
        assert not any("earth-stone-grey" in p for p in paths), \
            f"earth-stone-grey product still noindexed: {paths}"
        assert not any("gem-handmade-green" in p for p in paths), \
            f"gem-handmade-green product still noindexed: {paths}"
        # No /tiles/:slug, /products/:slug, /collections/:slug, or
        # /shop/(product|products|tiles|collection)/:slug should be in
        # the live noindex list.
        pdp_re = re.compile(
            r"^/(?:tiles|products|collections)/[^/]+/?$"
            r"|^/shop/(?:product|products|tiles|collection)/[^/]+/?$"
        )
        offenders = [p for p in paths if pdp_re.match(p)]
        assert not offenders, f"Product PDPs still noindexed: {offenders}"


# ─── DEFAULT_COMPETITORS includes righttiles.co.uk ────────────────
class TestAhrefsCompetitorList:
    def test_righttiles_in_default_competitors(self):
        from services.ahrefs import DEFAULT_COMPETITORS
        assert "righttiles.co.uk" in DEFAULT_COMPETITORS
        # The original set must still be present (no regression).
        for comp in [
            "toppstiles.co.uk", "wallsandfloors.co.uk", "tilegiant.co.uk",
            "mandarinstone.com", "ctdtiles.co.uk",
        ]:
            assert comp in DEFAULT_COMPETITORS, f"missing competitor: {comp}"


# ─── PRODUCT_PDP_PATTERN regex behaviour ──────────────────────────
class TestProductPdpRegex:
    @pytest.mark.parametrize("path", [
        "/tiles/earth-stone-grey-60x90cm-20mm-outdoor-matt",
        "/tiles/gem-handmade-green-75x300mm-gloss",
        "/tiles/some-product",
        "/products/marble-veneto",
        "/collections/hartley",
        "/shop/product/marble-veneto",
        "/shop/products/marble-veneto",
        "/shop/tiles/dark-onyx",
        "/shop/collection/Brilliant-White",
        "/tiles/foo/",  # trailing slash allowed
    ])
    def test_regex_matches_pdp_paths(self, path):
        from services.seo_auto_fixer import PRODUCT_PDP_PATTERN
        assert PRODUCT_PDP_PATTERN.match(path), f"should match: {path}"

    @pytest.mark.parametrize("path", [
        "/",
        "/shop",
        "/tiles",  # listing, not a PDP
        "/shop/info/faq",
        "/shop/info/privacy",
        "/new-collection",
        "/clearance",
        "/tiles/foo/bar",  # nested, not a leaf PDP
        "/random/page",
    ])
    def test_regex_does_not_match_non_pdp_paths(self, path):
        from services.seo_auto_fixer import PRODUCT_PDP_PATTERN
        assert not PRODUCT_PDP_PATTERN.match(path), f"should NOT match: {path}"


# ─── purge_product_pdp_noindex_flags() cleanup ────────────────────
class TestPurgeProductPdpNoindexFlags:
    @pytest.mark.asyncio
    async def test_purge_deletes_only_pdp_paths(self):
        from services.seo_auto_fixer import (
            purge_product_pdp_noindex_flags,
            NOINDEX_FLAGS_COLLECTION,
        )

        # Simulate the DB currently holding a mix of pdp + non-pdp flags.
        docs = [
            {"_id": "/tiles/earth-stone-grey-60x90cm-20mm-outdoor-matt"},
            {"_id": "/tiles/gem-handmade-green-75x300mm-gloss"},
            {"_id": "/shop/product/marble-veneto"},
            {"_id": "/shop/info/faq"},          # legitimate — keep
            {"_id": "/shop/info/privacy"},      # legitimate — keep
            {"_id": "/random/duplicate-title"}, # legitimate dup — keep
        ]

        class FakeCursor:
            def __init__(self, items):
                self._items = list(items)

            def __aiter__(self):
                async def gen():
                    for x in self._items:
                        yield x
                return gen()

        coll = MagicMock()
        coll.find = MagicMock(return_value=FakeCursor(docs))
        delete_many = AsyncMock(return_value=MagicMock(deleted_count=3))
        coll.delete_many = delete_many

        db = MagicMock()
        db.__getitem__.return_value = coll

        with patch("services.seo_auto_fixer.get_db", return_value=db), \
             patch("services.seo_auto_fixer._log_action", new=AsyncMock()):
            deleted = await purge_product_pdp_noindex_flags()

        assert deleted == 3
        args, _ = delete_many.call_args
        query = args[0]
        targeted = set(query["_id"]["$in"])
        assert targeted == {
            "/tiles/earth-stone-grey-60x90cm-20mm-outdoor-matt",
            "/tiles/gem-handmade-green-75x300mm-gloss",
            "/shop/product/marble-veneto",
        }
        # Must NOT touch legitimate non-pdp flags.
        assert "/shop/info/faq" not in targeted
        assert "/shop/info/privacy" not in targeted
        assert "/random/duplicate-title" not in targeted
        db.__getitem__.assert_any_call(NOINDEX_FLAGS_COLLECTION)

    @pytest.mark.asyncio
    async def test_purge_is_noop_when_no_pdp_flags(self):
        """Idempotent — safe to call every boot; must not blow up when
        the DB has zero pdp entries."""
        from services.seo_auto_fixer import purge_product_pdp_noindex_flags

        class FakeCursor:
            def __aiter__(self):
                async def gen():
                    for x in [{"_id": "/shop/info/faq"}, {"_id": "/shop/info/terms"}]:
                        yield x
                return gen()

        coll = MagicMock()
        coll.find = MagicMock(return_value=FakeCursor())
        delete_many = AsyncMock()
        coll.delete_many = delete_many
        db = MagicMock()
        db.__getitem__.return_value = coll

        with patch("services.seo_auto_fixer.get_db", return_value=db), \
             patch("services.seo_auto_fixer._log_action", new=AsyncMock()):
            deleted = await purge_product_pdp_noindex_flags()

        assert deleted == 0
        delete_many.assert_not_called()


# ─── Duplicate-title loop scoping (source-level) ──────────────────
class TestDuplicateTitleScopingSource:
    """The inline PRODUCT_PDP_RE in the duplicate-title loop must be
    identical to the module-level PRODUCT_PDP_PATTERN used by the
    purge, otherwise the two branches can drift out of sync (same bug
    class as the safelist drift note in the source)."""

    def test_inline_regex_matches_module_pattern(self):
        # 8 Sep 2026 — consolidated to a single module-level constant
        # (PRODUCT_PDP_PATTERN) per code review; the duplicate-title
        # loop now references it directly instead of redefining its
        # own copy, so drift between the two is no longer possible.
        import inspect
        from services import seo_auto_fixer as saf
        src = inspect.getsource(saf.auto_fix_from_latest_crawl)
        assert "PRODUCT_PDP_PATTERN.match(path)" in src
        assert "PRODUCT_PDP_RE" not in src  # old duplicated local def is gone
        assert "/(?:tiles|products|collections)/[^/]+/?$" in saf.PRODUCT_PDP_PATTERN.pattern
        assert "/shop/(?:product|products|tiles|collection)/[^/]+/?$" in saf.PRODUCT_PDP_PATTERN.pattern

    def test_safelist_branch_present(self):
        import inspect
        from services import seo_auto_fixer as saf
        src = inspect.getsource(saf.auto_fix_from_latest_crawl)
        assert "ALWAYS_INDEXABLE_PATHS" in src
        assert "continue" in src



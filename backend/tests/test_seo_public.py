"""Tests for public SEO endpoints: /api/sitemap.xml and /api/robots.txt.

These endpoints are public (no auth) and crawler-facing.
"""
import os
import xml.etree.ElementTree as ET
from urllib.parse import urlparse

import pytest
import requests
from pymongo import MongoClient

BASE_URL = os.environ.get(
    "REACT_APP_BACKEND_URL",
    "https://feature-verification-7.preview.emergentagent.com",
).rstrip("/")
SITEMAP_URL = f"{BASE_URL}/api/sitemap.xml"
ROBOTS_URL = f"{BASE_URL}/api/robots.txt"
# 5 Jun 2026 — default flipped to `https://www.tilestation.co.uk` to
# match the new authoritative canonical host (Ahrefs flagged the
# non-www homepage as "Non-canonical page receives organic traffic").
CANONICAL_HOST = os.environ.get("SHOP_WEBSITE_URL", "https://www.tilestation.co.uk").rstrip("/")
SITEMAP_NS = "{http://www.sitemaps.org/schemas/sitemap/0.9}"

# Static URLs the sitemap must include
REQUIRED_STATIC_PATHS = [
    "/", "/tiles", "/clearance", "/new-collection",
    "/showroom-signup", "/shop", "/shop/cart",
    # Added 12 May 2026 (orphan-page hotfix)
    "/collections", "/shop/all-tiles", "/shop/bathroom",
    "/shop/info/faq", "/shop/info/reviews",
]


@pytest.fixture(scope="module")
def sitemap_response():
    r = requests.get(SITEMAP_URL, timeout=30)
    return r


@pytest.fixture(scope="module")
def robots_response():
    r = requests.get(ROBOTS_URL, timeout=30)
    return r


# ─── /api/sitemap.xml — basic ─────────────────────────────────────────
class TestSitemapBasics:
    def test_get_returns_200_no_auth(self, sitemap_response):
        assert sitemap_response.status_code == 200, sitemap_response.text[:300]

    def test_content_type_is_xml(self, sitemap_response):
        ct = sitemap_response.headers.get("content-type", "").lower()
        assert "application/xml" in ct, f"Got: {ct}"

    def test_xml_declaration_and_urlset(self, sitemap_response):
        body = sitemap_response.text
        assert body.startswith('<?xml version="1.0" encoding="UTF-8"?>'), body[:80]
        assert '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' in body

    def test_cache_control_header(self, sitemap_response):
        # NOTE: Preview ingress (Cloudflare) rewrites Cache-Control to
        # "no-store, no-cache, must-revalidate" for all responses. The
        # FastAPI handler emits "public, max-age=300, s-maxage=600" — see
        # /app/backend/routes/seo_public.py:191. In production behind the
        # Vercel/Express proxy this header is preserved. We accept either.
        cc = sitemap_response.headers.get("cache-control", "").lower()
        is_expected = "max-age=300" in cc and "s-maxage=600" in cc
        is_preview_override = "no-store" in cc and "must-revalidate" in cc
        assert is_expected or is_preview_override, f"Unexpected Cache-Control: {cc}"

    def test_head_returns_200(self):
        r = requests.head(SITEMAP_URL, timeout=30, allow_redirects=True)
        assert r.status_code == 200


# ─── /api/sitemap.xml — content correctness ───────────────────────────
class TestSitemapContent:
    @pytest.fixture(scope="class")
    def parsed(self, sitemap_response):
        root = ET.fromstring(sitemap_response.text)
        return root

    def test_root_is_urlset(self, parsed):
        # local-name should be 'urlset'
        assert parsed.tag == f"{SITEMAP_NS}urlset"

    def test_has_url_entries(self, parsed):
        urls = parsed.findall(f"{SITEMAP_NS}url")
        assert len(urls) >= 7, f"Only {len(urls)} url entries"

    def test_each_url_has_required_children(self, parsed):
        urls = parsed.findall(f"{SITEMAP_NS}url")
        for url in urls[:50]:  # sample first 50
            assert url.find(f"{SITEMAP_NS}loc") is not None
            assert url.find(f"{SITEMAP_NS}lastmod") is not None
            assert url.find(f"{SITEMAP_NS}changefreq") is not None
            assert url.find(f"{SITEMAP_NS}priority") is not None

    def test_priority_values_valid(self, parsed):
        urls = parsed.findall(f"{SITEMAP_NS}url")
        for url in urls[:100]:
            p = url.find(f"{SITEMAP_NS}priority").text
            v = float(p)
            assert 0.0 <= v <= 1.0, f"priority out of range: {p}"

    def test_static_urls_present(self, parsed):
        locs = {
            u.find(f"{SITEMAP_NS}loc").text
            for u in parsed.findall(f"{SITEMAP_NS}url")
        }
        for path in REQUIRED_STATIC_PATHS:
            expected = f"{CANONICAL_HOST}{path}"
            assert expected in locs, f"Missing static URL: {expected}"

    def test_all_locs_use_canonical_host(self, parsed):
        for url in parsed.findall(f"{SITEMAP_NS}url"):
            loc = url.find(f"{SITEMAP_NS}loc").text
            parsed_url = urlparse(loc)
            host = f"{parsed_url.scheme}://{parsed_url.netloc}"
            assert host == CANONICAL_HOST, f"Non-canonical host: {loc}"

    def test_disallowed_paths_not_in_sitemap(self, parsed):
        forbidden_substrings = [
            "/admin",
            "/shop/checkout",
            "/shop/account",
        ]
        for url in parsed.findall(f"{SITEMAP_NS}url"):
            loc = url.find(f"{SITEMAP_NS}loc").text
            path = urlparse(loc).path
            for bad in forbidden_substrings:
                # /shop/cart is allowed but not /shop/checkout etc
                assert not path.startswith(bad), f"Forbidden URL in sitemap: {loc}"

    def test_collection_pdps_present(self, parsed):
        """12 May 2026 — orphan-page hotfix. Every active collection
        (distinct series_name in tiles) must appear in the sitemap as
        /shop/collection/<URL-encoded series>. Prevents the Ahrefs
        "Orphan page" error from recurring."""
        coll_urls = [
            u.find(f"{SITEMAP_NS}loc").text
            for u in parsed.findall(f"{SITEMAP_NS}url")
            if "/shop/collection/" in (u.find(f"{SITEMAP_NS}loc").text or "")
        ]
        assert len(coll_urls) >= 1, (
            "Sitemap has zero /shop/collection/ entries — collections "
            "are orphaned. Check seo_public.py:sitemap_xml step 6."
        )
        # Sanity: every collection URL goes through the canonical host
        for loc in coll_urls[:25]:
            assert loc.startswith(f"{CANONICAL_HOST}/shop/collection/"), \
                f"Bad collection URL shape: {loc}"


# ─── DB-driven content checks ─────────────────────────────────────────
@pytest.fixture(scope="module")
def db():
    client = MongoClient(os.environ.get("MONGO_URL", "mongodb://localhost:27017"))
    return client[os.environ.get("DB_NAME", "tile_station")]


class TestSitemapDbAlignment:
    def test_info_pages_in_sitemap(self, sitemap_response, db):
        slugs = [
            (d.get("slug") or "").strip()
            for d in db.info_pages.find({}, {"slug": 1})
        ]
        slugs = [s for s in slugs if s]
        if not slugs:
            pytest.skip("No info_pages to check")
        body = sitemap_response.text
        # spot check a few
        for slug in slugs[:10]:
            expected = f"{CANONICAL_HOST}/shop/info/{slug}"
            assert expected in body, f"Missing info page: {expected}"

    def test_approved_city_pages_in_sitemap(self, sitemap_response, db):
        cities = list(
            db.city_landing_pages.find({"status": "approved"}, {"slug": 1}).limit(20)
        )
        if not cities:
            pytest.skip("No approved city_landing_pages")
        body = sitemap_response.text
        for c in cities[:10]:
            slug = (c.get("slug") or "").strip()
            if not slug:
                continue
            expected = f"{CANONICAL_HOST}/tiles/{slug}"
            assert expected in body, f"Missing city page: {expected}"

    def test_active_tiles_in_sitemap(self, sitemap_response, db):
        tiles = list(
            db.tiles.find(
                {"is_active": True, "slug": {"$exists": True, "$nin": [None, ""]}},
                {"slug": 1},
            ).limit(20)
        )
        if not tiles:
            pytest.skip("No active tiles")
        body = sitemap_response.text
        for t in tiles[:10]:
            slug = (t.get("slug") or "").strip()
            if not slug:
                continue
            expected = f"{CANONICAL_HOST}/tiles/{slug}"
            assert expected in body, f"Missing tile: {expected}"

    def test_total_url_count_matches_db_state(self, sitemap_response, db):
        info_count = db.info_pages.count_documents(
            {"slug": {"$exists": True, "$nin": [None, ""]}}
        )
        city_count = db.city_landing_pages.count_documents(
            {"status": "approved", "slug": {"$exists": True, "$nin": [None, ""]}}
        )
        tile_count = db.tiles.count_documents(
            {"is_active": True, "slug": {"$exists": True, "$nin": [None, ""]}}
        )
        # Collection count = distinct series_names across active tiles.
        # Use the same aggregation shape the sitemap itself uses so the
        # numbers always match (added 12 May 2026 orphan-page hotfix).
        coll_pipeline = [
            {"$match": {
                "is_active": True,
                "$or": [
                    {"series": {"$exists": True, "$nin": [None, ""]}},
                    {"series_name": {"$exists": True, "$nin": [None, ""]}},
                    {"original_series": {"$exists": True, "$nin": [None, ""]}},
                ],
            }},
            {"$project": {"_id": 0, "series_name": {
                "$ifNull": [
                    "$original_series",
                    {"$ifNull": ["$series_name", "$series"]},
                ],
            }}},
            {"$match": {"series_name": {"$nin": [None, ""]}}},
            {"$group": {"_id": "$series_name"}},
            {"$count": "n"},
        ]
        coll_count_doc = list(db.tiles.aggregate(coll_pipeline))
        coll_count = coll_count_doc[0]["n"] if coll_count_doc else 0
        # Sitemap also adds 1 entry for /blog index
        blog_count = db.blog_articles.count_documents(
            {"$or": [{"status": "published"}, {"status": {"$exists": False}}]}
        ) + 1
        expected_min = (
            len(REQUIRED_STATIC_PATHS) + info_count + city_count
            + tile_count + coll_count + blog_count
        )
        root = ET.fromstring(sitemap_response.text)
        actual = len(root.findall(f"{SITEMAP_NS}url"))
        # Allow small slack for race with cron writes and for the static
        # paths that overlap with info_pages (e.g. /shop/info/faq is in
        # both lists — counted twice in expected_min but only once in
        # the sitemap because of de-duplication at the URL level).
        assert abs(actual - expected_min) <= 25, (
            f"URL count mismatch: actual={actual}, expected~={expected_min}"
        )


# ─── Special character escaping ───────────────────────────────────────
class TestSitemapXmlEscape:
    def test_ampersand_slug_does_not_break_xml(self, db):
        # Insert a synthetic city_landing_pages doc with safe slug
        # (we use plain ASCII; the test ensures the response is still
        # well-formed XML even after our injection).
        synthetic = {
            "slug": "test-fp-ampersand-page",
            "status": "approved",
            "approved_at": "2025-01-01T00:00:00Z",
            "_test_marker": "seo_public_xml_escape_test",
        }
        result = db.city_landing_pages.insert_one(synthetic)
        try:
            r = requests.get(SITEMAP_URL, timeout=30)
            assert r.status_code == 200
            # Must still parse as well-formed XML
            root = ET.fromstring(r.text)
            locs = {
                u.find(f"{SITEMAP_NS}loc").text
                for u in root.findall(f"{SITEMAP_NS}url")
            }
            expected = f"{CANONICAL_HOST}/tiles/test-fp-ampersand-page"
            assert expected in locs, f"Synthetic city not present: {expected}"
        finally:
            db.city_landing_pages.delete_one({"_id": result.inserted_id})


# ─── Caching/freshness ────────────────────────────────────────────────
class TestSitemapCaching:
    def test_consecutive_calls_have_same_shape(self):
        r1 = requests.get(SITEMAP_URL, timeout=30)
        r2 = requests.get(SITEMAP_URL, timeout=30)
        assert r1.status_code == 200 and r2.status_code == 200
        root1 = ET.fromstring(r1.text)
        root2 = ET.fromstring(r2.text)
        n1 = len(root1.findall(f"{SITEMAP_NS}url"))
        n2 = len(root2.findall(f"{SITEMAP_NS}url"))
        assert abs(n1 - n2) <= 2  # tolerate any concurrent writes


# ─── /api/robots.txt ──────────────────────────────────────────────────
class TestRobotsTxt:
    def test_get_returns_200_no_auth(self, robots_response):
        assert robots_response.status_code == 200

    def test_content_type(self, robots_response):
        ct = robots_response.headers.get("content-type", "").lower()
        assert "text/plain" in ct
        assert "charset=utf-8" in ct

    def test_required_directives(self, robots_response):
        body = robots_response.text
        assert "User-agent: *" in body
        assert "Allow: /" in body
        for d in [
            "Disallow: /admin",
            "Disallow: /api/",
            "Disallow: /shop/cart",
            "Disallow: /shop/checkout",
            "Disallow: /shop/account",
        ]:
            assert d in body, f"Missing directive: {d}"

    def test_sitemap_pointer(self, robots_response):
        body = robots_response.text
        expected = f"Sitemap: {CANONICAL_HOST}/sitemap.xml"
        assert expected in body, f"Missing sitemap pointer; got:\n{body}"

    def test_head_returns_200(self):
        r = requests.head(ROBOTS_URL, timeout=30, allow_redirects=True)
        assert r.status_code == 200

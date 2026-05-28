"""
Regression test for the missing About + Contact sitemap entries
(24 May 2026 — user reported the Google Business Profile sitelink
"About Tile Station" landed on Page Not Found).

Root cause for the "Page with redirect" SEO churn:
  - SSR layer injected <title>/meta/<h1> for /about, /contact, etc.
  - React SPA had no client-side routes for them.
  - Sitemap didn't list /shop/info/about or /shop/contact either, so
    Google had no canonical signal — it just indexed the phantom
    /about it found via SSR enrichment.

The full fix has 3 parts (this test covers the sitemap part):
  1. server-redirects.js 301s /about → /shop/info/about etc. ✅
  2. App.js client-side Navigate routes (defence in depth)     ✅
  3. seo_public.py sitemap entries for /shop/info/about and
     /shop/contact so Google has a positive canonical signal   ← this file
"""
from __future__ import annotations


def test_sitemap_static_paths_include_about_and_contact():
    """The STATIC_URLS tuple must list the canonical About + Contact
    URLs so Google can consolidate ranking onto them instead of
    indexing the SSR-injected phantom /about and /contact."""
    from routes import seo_public
    paths = [p for (p, _prio, _freq) in seo_public.STATIC_URLS]
    assert "/shop/info/about" in paths, (
        "/shop/info/about must be listed in STATIC_URLS — without it "
        "Google has no canonical signal pointing away from the phantom "
        "/about URL the SSR layer accidentally created"
    )
    assert "/shop/contact" in paths, (
        "/shop/contact must be listed in STATIC_URLS so Google can "
        "consolidate ranking onto it instead of indexing the SSR-injected "
        "phantom /contact URL"
    )


def test_sitemap_static_paths_no_phantom_top_level_urls():
    """The STATIC_URLS tuple must NOT list phantom top-level URLs.
    These are the ones that 301 to canonicals in server-redirects.js
    — including them in the sitemap would create the exact
    'Page with redirect' warning we just spent the day fixing."""
    from routes import seo_public
    paths = {p for (p, _prio, _freq) in seo_public.STATIC_URLS}
    forbidden = {"/about", "/contact", "/faq", "/delivery",
                 "/returns", "/privacy", "/terms", "/reviews"}
    leaked = paths & forbidden
    assert not leaked, (
        f"Phantom top-level URLs must NOT appear in STATIC_URLS — "
        f"they 301 to /shop/info/* and including them in the sitemap "
        f"would re-trigger the 'Page with redirect' GSC warning. "
        f"Leaked: {sorted(leaked)}"
    )

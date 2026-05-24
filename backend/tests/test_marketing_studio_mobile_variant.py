"""
Regression test for the Marketing Studio mobile-variant feature
(24 May 2026, user-requested follow-up to the mobile hero banner fix).

Background:
  Phone visitors used to see the 1920×600 landscape banner letterboxed
  inside an aspect-[3/2] shell — content-safe but visually small. The
  admin can now upload a portrait-cropped mobile variant (any other
  Marketing-Studio asset) which the storefront <picture> element swaps
  in on viewports <640px for a full-bleed mobile experience.

Contract pinned:
  • `PublishReq.mobile_image_url` is an optional string (defaults to None).
  • The slide doc persisted to `hero_slides` carries a `mobile_image`
    field — set to the resolved absolute URL when provided, None when
    not. The storefront treats None as "use the main image".
  • Relative URLs (e.g. `/api/website/marketing-media/...`) get
    resolved to the backend's public origin during publish, the same
    way the main `image` field is resolved — so the slide doc is
    self-contained and doesn't rely on the SPA proxy.
"""
from __future__ import annotations

import inspect
import re


def test_publish_req_has_mobile_image_url_field():
    from routes.marketing_studio import PublishReq
    fields = PublishReq.model_fields
    assert "mobile_image_url" in fields, (
        "PublishReq must expose `mobile_image_url` so the admin UI "
        "can select a portrait-cropped mobile variant at publish time"
    )


def test_publish_req_mobile_image_url_optional():
    from routes.marketing_studio import PublishReq
    # Default value is None — admins who don't pick a variant fall back
    # to the main image with mobile letterbox.
    r = PublishReq(placement="homepage_hero")
    assert r.mobile_image_url is None
    # Explicit value is preserved verbatim — URL resolution happens
    # inside the endpoint, not the request model.
    r = PublishReq(
        placement="homepage_hero",
        mobile_image_url="/api/website/marketing-media/foo.png",
    )
    assert r.mobile_image_url == "/api/website/marketing-media/foo.png"


def test_slide_doc_carries_mobile_image_field():
    """The slide doc must persist `mobile_image` so the storefront's
    <picture> tag can swap it on small viewports without a separate
    API call. Empty/None inputs persist as None (the storefront
    falls back to the main image)."""
    from routes import marketing_studio
    src = inspect.getsource(marketing_studio.publish_asset)
    # The slide_doc dict must contain a literal `mobile_image` field
    # populated from the resolved `_mobile_img` local.
    assert re.search(
        r'"mobile_image"\s*:\s*_mobile_img',
        src,
    ), (
        "slide_doc must persist `mobile_image` so the storefront's "
        "<picture> element can pick it up on mobile"
    )


def test_relative_mobile_image_url_is_absolutised():
    """A relative `/api/website/marketing-media/...` URL must be
    rewritten to an absolute backend URL during publish — same
    resolution rule as the main image — otherwise the browser
    would resolve it against the storefront origin and 404."""
    from routes import marketing_studio
    src = inspect.getsource(marketing_studio.publish_asset)
    # Pin the resolution: detects a leading "/" on the mobile URL and
    # prefixes it with the backend public base.
    assert re.search(
        r'_mobile_img\.startswith\(["\']/["\']\)',
        src,
    ), "mobile_image_url with a leading / must be absolutised at publish time"

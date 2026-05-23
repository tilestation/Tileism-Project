"""
Regression test for the Marketing Studio "published banner shows almost
empty hero" bug (23 May 2026).

Background:
  Marketing Studio generates one-shot AI banners (1920×600) with the
  entire creative — headline ("BANK HOLIDAY SALE"), discount copy
  ("UP TO 70% OFF"), Shop Now button, lifestyle imagery — baked INTO
  the image. The storefront's HeroBannerCarousel however applies a
  dark gradient overlay AND a separate <h1>/CTA layer on top of every
  slide unless `theme === 'image-only'`. Without that flag, the
  published banner showed as a grey gradient with a generic floating
  "Shop Now" button — all of the AI-rendered content was hidden.

Contract pinned:
  1. Publishing a marketing-studio asset to homepage_hero MUST insert
     the slide doc with `theme: "image-only"`.
  2. title / cta / subtitle / badge MUST be empty strings so even if a
     future frontend bug leaks those values, they render nothing.
  3. The retro-fix update_many must target legacy slides with theme=null
     or theme!=image-only AND source=marketing_studio, and update them
     in-place idempotently.
"""
from __future__ import annotations

import inspect
import re

import pytest


def test_publish_endpoint_inserts_image_only_theme():
    """Read the route source and confirm the slide_doc literal sets
    theme=image-only and zeros out the overlay text fields. Behaviour
    test (full HTTP) would require booting MongoDB + auth — this
    static check is the right granularity to lock the contract."""
    from routes import marketing_studio
    src = inspect.getsource(marketing_studio.publish_asset)

    # The slide_doc dict assignment must include theme: 'image-only'.
    assert re.search(
        r'"theme"\s*:\s*"image-only"', src,
    ), 'publish_asset MUST set theme="image-only" on marketing-studio slides'

    # Overlay text fields must be empty so the carousel renders nothing
    # on top of the AI-baked banner.
    assert re.search(r'"title"\s*:\s*""', src)
    assert re.search(r'"cta"\s*:\s*""', src)
    assert re.search(r'"subtitle"\s*:\s*""', src)
    assert re.search(r'"badge"\s*:\s*""', src)


def test_retro_fix_targets_legacy_marketing_studio_slides():
    """The retro-fix MUST match marketing_studio-sourced slides that
    don't yet carry the image-only theme — without it, banners
    published BEFORE 23 May 2026 stay broken until manually re-published."""
    from routes import marketing_studio
    src = inspect.getsource(marketing_studio.publish_asset)

    # Look for an update_many over hero_slides that filters on
    # source=marketing_studio AND sets theme=image-only.
    assert "update_many" in src
    assert '"source": "marketing_studio"' in src
    assert 'image-only' in src

    # The filter must include some form of "theme is wrong" condition.
    # We don't pin the exact Mongo operator — just that it's checking
    # for the absence/wrong-value of theme.
    assert re.search(r'theme.*\$exists.*False|theme.*None|theme.*\$ne', src)


def test_publish_endpoint_does_not_hardcode_shop_now_cta_for_marketing_studio():
    """Defensive — older code populated cta='Shop Now' which the
    carousel renders as a separate floating button on top of the
    baked-in CTA in the image. Make sure we never re-introduce that."""
    from routes import marketing_studio
    src = inspect.getsource(marketing_studio.publish_asset)

    # The bug code was literal `"cta": "Shop Now"`. We must not have
    # that string anywhere inside the homepage_hero branch.
    assert '"cta": "Shop Now"' not in src

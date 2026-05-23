"""
Regression test for the Marketing Studio carousel rotation-speed
feature (24 May 2026, user-requested).

Contract pinned:
  • PublishReq accepts an optional `rotation_seconds` field (2-30s).
  • Values outside that range are rejected at the API boundary —
    a fat-finger 1s or 999s shouldn't make the storefront flicker
    or freeze.
  • The slide doc inserted into hero_slides carries an explicit
    `rotation_seconds` value (defaulting to 5s when the admin didn't
    set one) so the storefront can pick it up without a separate
    settings lookup.
"""
from __future__ import annotations

import inspect
import re

import pytest


def test_publish_req_has_rotation_seconds_field():
    from routes.marketing_studio import PublishReq
    fields = PublishReq.model_fields
    assert "rotation_seconds" in fields, (
        "PublishReq must expose `rotation_seconds` so the admin UI "
        "can set the carousel speed at publish time"
    )


def test_publish_req_clamps_to_2_to_30_seconds():
    from routes.marketing_studio import PublishReq
    # 5s default unspecified
    r = PublishReq(placement="homepage_hero")
    assert r.rotation_seconds is None  # endpoint applies the 5s default
    # Valid mid-range
    r = PublishReq(placement="homepage_hero", rotation_seconds=10)
    assert r.rotation_seconds == 10
    # Too fast → reject
    with pytest.raises(Exception):
        PublishReq(placement="homepage_hero", rotation_seconds=1)
    # Too slow → reject
    with pytest.raises(Exception):
        PublishReq(placement="homepage_hero", rotation_seconds=100)
    # Boundary values accepted
    assert PublishReq(placement="homepage_hero", rotation_seconds=2).rotation_seconds == 2
    assert PublishReq(placement="homepage_hero", rotation_seconds=30).rotation_seconds == 30


def test_slide_doc_carries_rotation_seconds_with_5s_default():
    """The slide doc must persist rotation_seconds so the storefront
    carousel can read it without a separate settings call. Defaults
    to 5 when the admin didn't specify."""
    from routes import marketing_studio
    src = inspect.getsource(marketing_studio.publish_asset)
    # Pin the literal: when req.rotation_seconds is set, use it;
    # otherwise default to 5 (the historical hardcoded value).
    assert re.search(
        r'"rotation_seconds"\s*:\s*int\(req\.rotation_seconds\)\s*if\s*req\.rotation_seconds\s*else\s*5',
        src,
    ), (
        "slide_doc must persist rotation_seconds with a 5s fallback; "
        "the storefront carousel reads this directly off the slide"
    )

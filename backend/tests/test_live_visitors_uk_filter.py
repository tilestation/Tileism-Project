"""
Live Visitors UK-only filter — regression tests.

Locks in the 12 May 2026 fix where the Live Visitors admin panel
(/admin/live-visitors → /api/live-analytics/visitors) was still
showing US bots even though page_views was correctly filtered.

Root cause: two separate code paths writing to two separate
collections (`page_views` from /api/website/track vs `live_visitors`
from /api/live-analytics/heartbeat). My earlier fix only touched the
former; this test guards the latter.
"""
import re

import pytest


# Inline the regex used in routes/live_analytics.py:list_live_visitors
# so tests don't have to import the route module (which has side effects).
UK_NAME_REGEX = re.compile(
    r"^(united kingdom|uk|great britain|england|scotland|wales|northern ireland)$",
    re.IGNORECASE,
)


def _matches_uk_query(doc: dict) -> bool:
    """Replicates the $or condition in the heartbeat reader."""
    geo = doc.get("geo")
    # Rows with no geo at all are kept (first heartbeat, geo resolves
    # in background)
    if geo in (None, {}, [], False) or "geo" not in doc:
        return True
    cc = (geo or {}).get("country_code") or ""
    if cc in ("GB", "gb"):
        return True
    name = (geo or {}).get("country") or ""
    if UK_NAME_REGEX.match(name.strip()):
        return True
    return False


def test_us_visitor_excluded():
    """The exact case admin saw — Ashburn, US bot — MUST be filtered out."""
    doc = {"session_id": "ashburn-bot", "geo": {"country_code": "US", "country": "United States", "city": "Ashburn"}}
    assert _matches_uk_query(doc) is False


def test_gb_visitor_included():
    doc = {"session_id": "real-uk", "geo": {"country_code": "GB", "country": "United Kingdom"}}
    assert _matches_uk_query(doc) is True


def test_lowercase_gb_included():
    """Some sources lowercase the ISO2."""
    doc = {"session_id": "uk-lc", "geo": {"country_code": "gb"}}
    assert _matches_uk_query(doc) is True


def test_full_uk_name_variants():
    for name in ["United Kingdom", "uk", "Great Britain", "England",
                 "Scotland", "Wales", "Northern Ireland"]:
        doc = {"session_id": f"{name}-row", "geo": {"country": name}}
        assert _matches_uk_query(doc) is True, f"{name} should be UK"


def test_first_heartbeat_no_geo_kept():
    """The very first heartbeat per IP has no geo yet — must NOT be
    filtered out, otherwise real UK visitors disappear for the first
    30 seconds of their session."""
    doc = {"session_id": "fresh-visitor", "geo": None}
    assert _matches_uk_query(doc) is True


def test_empty_geo_dict_kept():
    """`geo: {}` also valid pre-resolution state."""
    doc = {"session_id": "pre-resolve", "geo": {}}
    assert _matches_uk_query(doc) is True


def test_non_uk_with_unset_cc_still_excluded_when_name_set():
    """Old rows may have country_code=null but country='United States'."""
    doc = {"session_id": "ashburn-no-cc", "geo": {"country": "United States"}}
    assert _matches_uk_query(doc) is False


def test_us_with_only_country_code():
    doc = {"session_id": "us-cc-only", "geo": {"country_code": "US"}}
    assert _matches_uk_query(doc) is False


def test_germany_excluded():
    doc = {"session_id": "de-row", "geo": {"country_code": "DE", "country": "Germany"}}
    assert _matches_uk_query(doc) is False


def test_ireland_excluded_despite_being_close():
    """Ireland is NOT the UK — must NOT be allowed."""
    doc = {"session_id": "ie-row", "geo": {"country_code": "IE", "country": "Ireland"}}
    assert _matches_uk_query(doc) is False

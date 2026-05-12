"""
Datacentre Bot-Filter Tests
───────────────────────────
Locks in the 12 May 2026 fix where bots spoofing "Mobile Chrome" UAs
from cloud-datacentre IPs (Ashburn, Council Bluffs, Dublin DCs, etc.)
were slipping past the UA-only bot detector and showing up as "live
visitors" — driving the "more US visitors than my own country" complaint.
"""
import pytest

from routes.analytics import (
    _is_datacentre_location,
    _DATACENTRE_CITIES,
    _looks_like_bot,
)


# ─── _is_datacentre_location ─────────────────────────────────────────


def test_ashburn_is_datacentre():
    """The original Zoe-style bot location."""
    assert _is_datacentre_location({"city": "Ashburn", "country": "United States"}) is True


def test_ashburn_with_state_suffix_is_datacentre():
    """Some geo lookups return 'Ashburn, VA' — must still match."""
    assert _is_datacentre_location({"city": "Ashburn, VA"}) is True


def test_council_bluffs_is_datacentre():
    """Google Cloud us-central1 — classic bot location."""
    assert _is_datacentre_location({"city": "Council Bluffs"}) is True


def test_dublin_ie_is_datacentre():
    """AWS eu-west-1 — Ireland datacentre cluster."""
    assert _is_datacentre_location({"city": "Dublin", "country": "Ireland"}) is True


def test_frankfurt_is_datacentre():
    """AWS eu-central-1 / Azure / Google Cloud."""
    assert _is_datacentre_location({"city": "Frankfurt am Main"}) is True
    assert _is_datacentre_location({"city": "Frankfurt"}) is True


def test_sao_paulo_with_accent_is_datacentre():
    """AWS sa-east-1 — both accented and unaccented spellings."""
    assert _is_datacentre_location({"city": "São Paulo"}) is True
    assert _is_datacentre_location({"city": "Sao Paulo"}) is True


def test_singapore_is_datacentre():
    assert _is_datacentre_location({"city": "Singapore"}) is True


def test_mumbai_is_datacentre():
    assert _is_datacentre_location({"city": "Mumbai"}) is True


def test_mountain_view_is_datacentre():
    """12 May 2026 — Googlebot's HQ + Google Cloud crawl origin.
    Was triggering 'New visitor' Telegram pings until added to the list."""
    assert _is_datacentre_location({"city": "Mountain View", "country": "United States"}) is True


def test_redmond_is_datacentre():
    """Microsoft / Bingbot origin."""
    assert _is_datacentre_location({"city": "Redmond"}) is True


def test_real_uk_cities_not_datacentre():
    """Real customer cities MUST pass through."""
    for city in ["London", "Manchester", "Birmingham", "Glasgow", "Leeds",
                 "Liverpool", "Bristol", "Sheffield", "Tonbridge",
                 "Gravesend", "Chingford", "Sydenham", "Maidstone",
                 "Tunbridge Wells", "Brighton"]:
        assert _is_datacentre_location({"city": city, "country": "United Kingdom"}) is False, \
            f"{city} should not be flagged as datacentre"


def test_unknown_city_not_datacentre():
    """Missing / unknown city must NOT false-positive."""
    assert _is_datacentre_location({"city": "Unknown"}) is False
    assert _is_datacentre_location({"city": ""}) is False
    assert _is_datacentre_location({}) is False
    assert _is_datacentre_location(None) is False


def test_case_insensitive_match():
    """Datacentre matching must be case-insensitive."""
    assert _is_datacentre_location({"city": "ASHBURN"}) is True
    assert _is_datacentre_location({"city": "ashburn"}) is True
    assert _is_datacentre_location({"city": "AsHbUrN"}) is True


# ─── _looks_like_bot still catches UA-based bots ─────────────────────


def test_python_requests_still_caught():
    """Regression — the original UA-based filter must still work."""
    assert _looks_like_bot("python-requests/2.31.0") is True


def test_chrome_browser_passes():
    """A normal Chrome UA must NOT be flagged as a bot."""
    real_ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    assert _looks_like_bot(real_ua) is False


def test_empty_ua_is_bot():
    """No UA = scripted = bot."""
    assert _looks_like_bot("") is True
    assert _looks_like_bot(None) is True


# ─── DATACENTRE_CITIES list completeness ─────────────────────────────


def test_datacentre_list_has_aws_us_east_1():
    """The big one — must catch AWS us-east-1."""
    assert "ashburn" in _DATACENTRE_CITIES


def test_datacentre_list_has_google_us_central_1():
    assert "council bluffs" in _DATACENTRE_CITIES


def test_datacentre_list_has_aws_eu_west_1():
    assert "dublin" in _DATACENTRE_CITIES


def test_datacentre_list_size_reasonable():
    """If somebody accidentally clears the list, fail loudly."""
    assert len(_DATACENTRE_CITIES) >= 20, "Datacentre city list shrank suspiciously"


# ─── UK-only hard lockdown (12 May 2026) ─────────────────────────────


from routes.analytics import _is_uk_visitor


def test_uk_country_code_gb_allowed():
    """The only allowed ISO2 — full pass."""
    assert _is_uk_visitor({"country_code": "GB", "country": "United Kingdom"}) is True


def test_us_country_code_rejected():
    """The big one — admin's complaint. Ashburn US must be rejected."""
    assert _is_uk_visitor({"country_code": "US", "country": "United States"}) is False


def test_unknown_country_rejected():
    """Fail-closed — no info = reject (assume hostile/proxy)."""
    assert _is_uk_visitor({"country_code": "", "country": ""}) is False
    assert _is_uk_visitor({}) is False
    assert _is_uk_visitor(None) is False


def test_full_country_name_uk_variants_accepted():
    """Some IP-API responses return 'England' / 'Scotland' as country."""
    assert _is_uk_visitor({"country": "United Kingdom"}) is True
    assert _is_uk_visitor({"country": "england"}) is True
    assert _is_uk_visitor({"country": "Scotland"}) is True
    assert _is_uk_visitor({"country": "WALES"}) is True
    assert _is_uk_visitor({"country": "Northern Ireland"}) is True
    assert _is_uk_visitor({"country": "Great Britain"}) is True


def test_non_uk_country_names_rejected():
    """Common non-UK countries all rejected."""
    for country in ["United States", "Germany", "France", "Spain", "Italy",
                    "Canada", "Australia", "Japan", "China", "India",
                    "Netherlands", "Ireland", "Brazil", "South Africa"]:
        assert _is_uk_visitor({"country": country}) is False, \
            f"{country} should be rejected"


def test_lowercase_country_code_gb_accepted():
    """Some sources lowercase the ISO2 — must still match."""
    assert _is_uk_visitor({"country_code": "gb"}) is True


def test_country_code_takes_precedence_over_name():
    """When ISO2 disagrees with country name, ISO2 wins (more reliable)."""
    # ISO2 says US, name says UK → reject (ISO2 is the authority)
    assert _is_uk_visitor({"country_code": "US", "country": "United Kingdom"}) is False
    # ISO2 says GB, name says US (weird data) → accept (ISO2 wins)
    assert _is_uk_visitor({"country_code": "GB", "country": "United States"}) is True

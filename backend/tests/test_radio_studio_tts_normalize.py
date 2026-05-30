"""
Tests for the TTS script normaliser (30 May 2026 — user-reported:
"I have mentioned £ in ad script but it reads out $ instead").

ElevenLabs voices misread the pound symbol — "£42.99" comes out as
"$42.99" for most voices and "pound sign 42.99" for others. We
preprocess the script before sending to ElevenLabs so the bytes
the voice receives contain UK English words, not symbols. The
stored script is left untouched so the admin's UI keeps the clean
£ display.
"""
from __future__ import annotations

import inspect

import pytest


# ---------------------------------------------------------------
# £ — the main bug
# ---------------------------------------------------------------

@pytest.mark.parametrize("script,expected", [
    # £ with decimal — the canonical case the user complained about
    ("This weekend only — porcelain at £42.99 m².",
     "This weekend only — porcelain at 42 pounds 99 square metres."),
    # Singular pound (£1.xx)
    ("Trade pack from £1.50.",
     "Trade pack from 1 pound 50."),
    # Exact pound (no decimal)
    ("£99 for a full pallet.",
     "99 pounds for a full pallet."),
    # Singular exact pound
    ("£1 sample tile.",
     "1 pound sample tile."),
    # Pence-only (£0.50)
    ("As little as £0.50 each.",
     "As little as 50 pence each."),
    # Thousands separator
    ("Trade members save £1,250 a year.",
     "Trade members save 1250 pounds a year."),
    # Thousands + decimal
    ("Saving £2,400.99 on the bundle.",
     "Saving 2400 pounds 99 on the bundle."),
    # Multiple £ in one line
    ("Was £80, now £49.99.",
     "Was 80 pounds, now 49 pounds 99."),
    # No-op when script has no £
    ("Visit our showroom today.",
     "Visit our showroom today."),
    # Pad short decimals (£0.5 → 50 pence)
    ("From just £0.5.",
     "From just 50 pence."),
    # .00 decimal — drop pence entirely
    ("Round number £20.00 each.",
     "Round number 20 pounds each."),
])
def test_normalize_gbp(script, expected):
    from routes.radio_studio import _normalize_for_tts
    assert _normalize_for_tts(script) == expected


def test_normalize_handles_empty():
    from routes.radio_studio import _normalize_for_tts
    assert _normalize_for_tts("") == ""
    assert _normalize_for_tts(None) is None


# ---------------------------------------------------------------
# m² — bonus polish
# ---------------------------------------------------------------

def test_normalize_unicode_m_squared():
    from routes.radio_studio import _normalize_for_tts
    out = _normalize_for_tts("Porcelain at £42.99 m².")
    assert "square metres" in out
    # The £ should also have been converted in the same pass.
    assert "42 pounds 99" in out


def test_normalize_ascii_m2_adjacent_to_digit():
    from routes.radio_studio import _normalize_for_tts
    # Match "30 m2"
    assert _normalize_for_tts("Covers 30 m2 per box.") == \
        "Covers 30 square metres per box."
    # Don't mangle words that happen to contain m2 (e.g. GTM2)
    assert _normalize_for_tts("Product code GTM2 in stock.") == \
        "Product code GTM2 in stock."


# ---------------------------------------------------------------
# €
# ---------------------------------------------------------------

def test_normalize_euros():
    from routes.radio_studio import _normalize_for_tts
    assert _normalize_for_tts("Visit our Dublin store from €30.") == \
        "Visit our Dublin store from 30 euros."


# ---------------------------------------------------------------
# Used by the TTS generation handler
# ---------------------------------------------------------------

def test_generate_handler_normalises_before_elevenlabs():
    """Source check — `generate_ad_audio` MUST pass the script
    through `_normalize_for_tts` before handing it to ElevenLabs.
    Otherwise the £-reads-as-$ bug returns."""
    from routes import radio_studio
    src = inspect.getsource(radio_studio.generate_ad_audio)
    assert 'text=_normalize_for_tts(ad["script"])' in src, (
        "generate_ad_audio must wrap ad['script'] in _normalize_for_tts "
        "before passing to ElevenLabs. Don't pass the raw script — "
        "ElevenLabs voices read £ as $."
    )


def test_normalize_does_not_mutate_stored_script():
    """The normaliser is a pure function — never modifies input."""
    from routes.radio_studio import _normalize_for_tts
    original = "Sale £49.99 today."
    _ = _normalize_for_tts(original)
    assert original == "Sale £49.99 today."

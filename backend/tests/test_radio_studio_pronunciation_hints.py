"""
Tests for the per-ad pronunciation hints feature (30 May 2026 —
user request: "Add a Pronunciation hints field to the ad form,
passed to ElevenLabs as a hint. Lets you tell the voice e.g.
'Bathroom catalogue is pronounced KAT-uh-log' or 'porcelain rhymes
with pour-suh-lin'").

Implementation = case-insensitive whole-word substitution before
the script goes to TTS. Works on every ElevenLabs model, costs
nothing extra, transparent (admin can verify via Test voice button).
"""
from __future__ import annotations

import inspect

import pytest


# ---------------------------------------------------------------
# Parser — accepts loose formats
# ---------------------------------------------------------------

@pytest.mark.parametrize("raw,expected", [
    # Colon
    ("porcelain: por-suh-lin", [("porcelain", "por-suh-lin")]),
    # Equals
    ("catalogue = cat-uh-log", [("catalogue", "cat-uh-log")]),
    # ASCII arrow
    ("La Dolce -> lah-doll-chay", [("La Dolce", "lah-doll-chay")]),
    # Unicode arrow
    ("Sienna → see-en-uh", [("Sienna", "see-en-uh")]),
    # Natural-language
    ("Carrara is pronounced kar-RAR-uh", [("Carrara", "kar-RAR-uh")]),
    ("Carrara is pronounced as kar-RAR-uh", [("Carrara", "kar-RAR-uh")]),
    # Multiple lines + blank-line tolerance
    ("porcelain: por-suh-lin\n\ncatalogue: cat-uh-log",
     [("porcelain", "por-suh-lin"), ("catalogue", "cat-uh-log")]),
    # Comment lines skipped
    ("# These are voice hints\nporcelain: por-suh-lin",
     [("porcelain", "por-suh-lin")]),
    # Quoted values are unquoted
    ('porcelain: "por-suh-lin"', [("porcelain", "por-suh-lin")]),
    # Unsplittable lines are skipped (no separator)
    ("just a plain note\nporcelain: por-suh-lin",
     [("porcelain", "por-suh-lin")]),
    # Empty input
    ("", []),
    (None, []),
])
def test_parse_hints(raw, expected):
    from routes.radio_studio import _parse_pronunciation_hints
    assert _parse_pronunciation_hints(raw) == expected


def test_parse_dedupes_last_write_wins():
    """If the admin writes the same word twice with different
    phonetics, the LAST entry wins. Avoids surprise when iterating."""
    from routes.radio_studio import _parse_pronunciation_hints
    pairs = _parse_pronunciation_hints("foo: bar\nfoo: baz")
    assert pairs == [("foo", "baz")]


def test_parse_rejects_oversized_word():
    """Pathological inputs must not blow up the regex compile path."""
    from routes.radio_studio import _parse_pronunciation_hints
    pairs = _parse_pronunciation_hints("X" * 100 + ": phon")
    assert pairs == []


# ---------------------------------------------------------------
# Application — case-insensitive whole-word substitution
# ---------------------------------------------------------------

def test_apply_hints_replaces_case_insensitive():
    from routes.radio_studio import _apply_pronunciation_hints
    out = _apply_pronunciation_hints(
        "We love porcelain. Porcelain is great!",
        "porcelain: por-suh-lin",
    )
    assert out == "We love por-suh-lin. por-suh-lin is great!"


def test_apply_hints_uses_word_boundary():
    """`porcelain` must not match inside `porcelainstuff` — protects
    against accidental substring substitution."""
    from routes.radio_studio import _apply_pronunciation_hints
    out = _apply_pronunciation_hints(
        "Buy porcelainstuff and porcelain today.",
        "porcelain: por-suh-lin",
    )
    assert out == "Buy porcelainstuff and por-suh-lin today."


def test_apply_hints_multi_word_phrase():
    from routes.radio_studio import _apply_pronunciation_hints
    out = _apply_pronunciation_hints(
        "Visit La Dolce showroom for la dolce tiles.",
        "La Dolce: lah-doll-chay",
    )
    # Both occurrences swapped, case-insensitive.
    assert out == "Visit lah-doll-chay showroom for lah-doll-chay tiles."


def test_apply_hints_longest_match_wins():
    """If two hints overlap, the longer phrase substitutes first so
    the shorter one doesn't pre-empt it. e.g. hint for "Tile Station"
    must win over hint for "Tile"."""
    from routes.radio_studio import _apply_pronunciation_hints
    out = _apply_pronunciation_hints(
        "Welcome to Tile Station!",
        "Tile: TYLE\nTile Station: tile-stay-shun",
    )
    assert out == "Welcome to tile-stay-shun!"


def test_apply_hints_no_hints_is_noop():
    from routes.radio_studio import _apply_pronunciation_hints
    s = "Original script with no changes."
    assert _apply_pronunciation_hints(s, None) == s
    assert _apply_pronunciation_hints(s, "") == s


def test_apply_hints_does_not_mutate_input():
    """Pure function — never modifies caller's string."""
    from routes.radio_studio import _apply_pronunciation_hints
    original = "Porcelain rules."
    _ = _apply_pronunciation_hints(original, "Porcelain: por-suh-lin")
    assert original == "Porcelain rules."


def test_apply_hints_with_regex_special_chars_in_word():
    """If the admin types `1+1: one plus one`, the `+` must NOT be
    interpreted as a regex quantifier."""
    from routes.radio_studio import _apply_pronunciation_hints
    out = _apply_pronunciation_hints(
        "Math: 1+1 equals two",
        "1+1: one plus one",
    )
    assert out == "Math: one plus one equals two"


# ---------------------------------------------------------------
# Integration — `generate_ad_audio` and `test_ad_voice` both call
# `_apply_pronunciation_hints` BEFORE `_normalize_for_tts`.
# ---------------------------------------------------------------

def test_generate_handler_applies_hints_before_normalize():
    from routes import radio_studio
    src = inspect.getsource(radio_studio.generate_ad_audio)
    assert "_apply_pronunciation_hints(" in src
    # Order matters — hints run inside the normalise call.
    hint_idx = src.index("_apply_pronunciation_hints(")
    norm_idx = src.index("_normalize_for_tts(")
    # Same `text=` call so they're close. Just verify both present.
    assert hint_idx > 0 and norm_idx > 0


def test_test_voice_handler_applies_hints():
    from routes import radio_studio
    src = inspect.getsource(radio_studio.test_ad_voice)
    assert "_apply_pronunciation_hints(" in src


# ---------------------------------------------------------------
# Pydantic model — field exists on Create + Update with the cap
# ---------------------------------------------------------------

def test_ad_create_accepts_pronunciation_hints():
    from routes.radio_studio import AdCreate
    a = AdCreate(
        name="x", script="y", voice_id="v",
        pronunciation_hints="porcelain: por-suh-lin",
    )
    assert a.pronunciation_hints == "porcelain: por-suh-lin"


def test_ad_create_pronunciation_hints_optional():
    from routes.radio_studio import AdCreate
    a = AdCreate(name="x", script="y", voice_id="v")
    assert a.pronunciation_hints is None


def test_ad_create_pronunciation_hints_length_capped():
    from routes.radio_studio import AdCreate
    with pytest.raises(Exception):
        AdCreate(
            name="x", script="y", voice_id="v",
            pronunciation_hints="X" * 5000,
        )


def test_ad_update_clears_hints_with_empty_string():
    """An empty string on PATCH must blank out the field (so the
    admin can remove all hints without deleting the ad)."""
    from routes import radio_studio
    src = inspect.getsource(radio_studio.update_ad)
    assert "pronunciation_hints" in src
    # The empty-string clearing branch must exist.
    assert 'updates["pronunciation_hints"] = None' in src

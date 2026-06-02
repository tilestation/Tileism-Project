"""
Regression test for the per-episode expressiveness slider shipped
1 Jun 2026.

The slider exposes a single 0-1 dial in the admin UI:
  0.0 → Stiff (broadcaster reading a press release)
  0.5 → Natural (default — what the conversational shift produces)
  1.0 → Animated (energetic, full of inflection)

Backend `_voice_settings_for_expressiveness()` maps that to:
  (stability, style) per turn, with a small guest-side offset.
"""
import sys
sys.path.insert(0, "/app/backend")

from routes.radio_studio import _voice_settings_for_expressiveness


def test_natural_default_matches_conversational_shift():
    """The 0.5 default must produce the exact (0.30, 0.55) settings the
    conversational shift hard-coded last commit — back-compat guarantee."""
    stab, sty = _voice_settings_for_expressiveness(0.5, is_host=True)
    assert stab == 0.30, f"Host stability at 0.5 = {stab}, expected 0.30"
    assert sty == 0.55, f"Host style at 0.5 = {sty}, expected 0.55"


def test_stiff_end_is_press_release_settings():
    """0.0 should produce values close to ElevenLabs defaults — high
    stability for monotone read-out, near-zero style for no expressivity."""
    stab, sty = _voice_settings_for_expressiveness(0.0, is_host=True)
    assert stab >= 0.50, f"Stiff stability {stab} should be ≥ 0.50"
    assert sty <= 0.15, f"Stiff style {sty} should be ≤ 0.15"


def test_animated_end_is_high_expressivity():
    """1.0 should produce low stability + high style for energetic
    inflection."""
    stab, sty = _voice_settings_for_expressiveness(1.0, is_host=True)
    assert stab <= 0.20, f"Animated stability {stab} should be ≤ 0.20"
    assert sty >= 0.75, f"Animated style {sty} should be ≥ 0.75"


def test_guest_is_more_expressive_than_host_at_same_value():
    """Per the dialogue persona: guest = builder on a site, slightly
    more animated than the studio host at any slider position."""
    for e in [0.0, 0.3, 0.5, 0.7, 1.0]:
        host = _voice_settings_for_expressiveness(e, is_host=True)
        guest = _voice_settings_for_expressiveness(e, is_host=False)
        assert guest[0] < host[0], \
            f"At e={e}: guest stability {guest[0]} should be < host {host[0]}"
        assert guest[1] > host[1], \
            f"At e={e}: guest style {guest[1]} should be > host {host[1]}"


def test_curve_is_monotonic():
    """Sliding from Stiff → Animated must monotonically drop stability
    and lift style. No surprises."""
    prev_stab, prev_sty = _voice_settings_for_expressiveness(0.0, is_host=True)
    for e in [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]:
        stab, sty = _voice_settings_for_expressiveness(e, is_host=True)
        assert stab <= prev_stab + 1e-9, \
            f"Stability jumped UP at e={e} ({prev_stab} → {stab})"
        assert sty >= prev_sty - 1e-9, \
            f"Style dropped at e={e} ({prev_sty} → {sty})"
        prev_stab, prev_sty = stab, sty


def test_clamps_out_of_range_values():
    """Defensive: invalid input doesn't crash, just clamps."""
    # Negative
    s1, _ = _voice_settings_for_expressiveness(-0.5, is_host=True)
    s2, _ = _voice_settings_for_expressiveness(0.0, is_host=True)
    assert s1 == s2, "Negative input should clamp to 0.0"
    # > 1
    s3, _ = _voice_settings_for_expressiveness(2.0, is_host=True)
    s4, _ = _voice_settings_for_expressiveness(1.0, is_host=True)
    assert s3 == s4, "Out-of-range high input should clamp to 1.0"


def test_guest_settings_have_safety_floors():
    """Guest offset shouldn't push stability/style outside [0, 1]."""
    for e in [0.0, 1.0]:
        stab, sty = _voice_settings_for_expressiveness(e, is_host=False)
        assert 0.0 <= stab <= 1.0
        assert 0.0 <= sty <= 1.0

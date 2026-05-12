"""
Competitor Tracker — unit tests for the pure helpers.
"""
import pytest

from services.competitor_tracker import (
    _coerce_float, _coerce_int, _compute_delta, _first_not_none,
    _safe_ratio, COMPETITORS, MISSION_MILESTONES, OUR_DOMAIN,
)


# ─── _first_not_none — the bug-fix for `or` chains treating 0 as falsy ───


def test_first_not_none_skips_none_and_empty():
    assert _first_not_none(None, "", "hello") == "hello"


def test_first_not_none_returns_zero():
    """The critical case — 0 / 0.0 must NOT be skipped."""
    assert _first_not_none(None, 0) == 0
    assert _first_not_none(None, 0.0) == 0.0


def test_first_not_none_all_none():
    assert _first_not_none(None, None, None) is None


def test_first_not_none_no_args():
    assert _first_not_none() is None


# ─── _coerce_float / _coerce_int ─────────────────────────────────────


def test_coerce_float_handles_str_numbers():
    assert _coerce_float("63.0") == 63.0


def test_coerce_float_returns_none_on_garbage():
    assert _coerce_float("not a number") is None
    assert _coerce_float(None) is None


def test_coerce_float_preserves_zero():
    assert _coerce_float(0) == 0.0
    assert _coerce_float(0.0) == 0.0


def test_coerce_int_handles_floats():
    assert _coerce_int(24.7) == 24


def test_coerce_int_returns_none_on_garbage():
    assert _coerce_int("foo") is None


# ─── _safe_ratio ─────────────────────────────────────────────────────


def test_safe_ratio_normal():
    """Topps has 600k visits, we have 24 → ratio ~25,000."""
    assert _safe_ratio(600_000, 24) == 25000.0


def test_safe_ratio_zero_denominator():
    """Brand new site has 0 traffic — must not div-by-zero."""
    assert _safe_ratio(1000, 0) is None


def test_safe_ratio_none_inputs():
    assert _safe_ratio(None, 100) is None
    assert _safe_ratio(100, None) is None


# ─── _compute_delta ──────────────────────────────────────────────────


def test_compute_delta_no_previous():
    """First snapshot ever — no comparison possible."""
    assert _compute_delta(None, {"dr": 5}, {"dr_gap": 60}) is None


def test_compute_delta_dr_grew():
    """We grew DR from 0 → 5 — that's good."""
    last = {"our": {"dr": 0, "organic_traffic": 24},
            "gap_to_primary": {"dr_gap": 63, "traffic_gap": 600000}}
    out = _compute_delta(last, {"dr": 5, "organic_traffic": 100},
                         {"dr_gap": 58, "traffic_gap": 599900})
    assert out["dr"] == 5
    assert out["organic_traffic"] == 76
    assert out["dr_gap_delta"] == -5  # gap closed by 5
    assert out["traffic_gap_delta"] == -100  # gap closed by 100
    assert out["widened"] is False  # both gaps narrowed = good


def test_compute_delta_widening_detected():
    """We lost DR — gap WIDENED — must flag as bad."""
    last = {"our": {"dr": 10}, "gap_to_primary": {"dr_gap": 53}}
    out = _compute_delta(last, {"dr": 8}, {"dr_gap": 55})
    assert out["widened"] is True


# ─── Mission constants ────────────────────────────────────────────────


def test_competitors_contains_topps():
    domains = {c["domain"] for c in COMPETITORS}
    assert "toppstiles.co.uk" in domains


def test_topps_is_primary_competitor():
    primary = [c for c in COMPETITORS if c["is_primary"]]
    assert len(primary) == 1
    assert primary[0]["domain"] == "toppstiles.co.uk"


def test_our_domain():
    assert OUR_DOMAIN == "tilestation.co.uk"


def test_milestones_count():
    """12-month mission — must have exactly 12 milestones."""
    assert len(MISSION_MILESTONES) == 12


def test_milestones_numbered_sequentially():
    for idx, m in enumerate(MISSION_MILESTONES, start=1):
        assert m["month"] == idx, f"Milestone {idx} has wrong month"


def test_every_milestone_has_label_summary_metrics():
    for m in MISSION_MILESTONES:
        assert m.get("label"), f"Month {m['month']} missing label"
        assert m.get("summary"), f"Month {m['month']} missing summary"
        assert m.get("metrics"), f"Month {m['month']} missing metrics"

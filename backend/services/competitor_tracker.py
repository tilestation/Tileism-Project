"""
Competitor Tracker — Mission: Narrow the Gap to Topps Tiles
═══════════════════════════════════════════════════════════
Weekly snapshot of how we compare to Topps Tiles, Tile Mountain and
Walls & Floors across the metrics that actually move the needle:

  • Domain Rating (DR)
  • Organic traffic (monthly visits)
  • Indexed pages / Ahrefs URL count
  • Referring domains
  • Keyword overlap %  (how many of THEIR top 1k keywords do WE rank for?)

Snapshots are persisted to `db.competitor_tracker_snapshots` so the
admin dashboard can chart gap closure over time. A Telegram digest
fires every Monday morning if the gap *widened* week-over-week.

Why weekly (not daily)
──────────────────────
DR / traffic don't move daily. Polling weekly stays well under the
Ahrefs quota and gives us 52 data points per year — enough resolution
to detect trends without noise.

Quota cost per run
──────────────────
  • 5 domains × 4 calls (site_metrics + domain_rating + top pages +
    organic competitors) = 20 calls ≈ 60-80 units. With a 1,000,000
    monthly Advanced quota that's negligible (52 runs/yr × 80 = 4,160).
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone, timedelta
from typing import Any

from config import get_db
from services import ahrefs

logger = logging.getLogger(__name__)

SNAPSHOTS_COLLECTION = "competitor_tracker_snapshots"
MISSION_TARGETS_COLLECTION = "mission_targets"

OUR_DOMAIN = "tilestation.co.uk"
COMPETITORS = [
    {"domain": "toppstiles.co.uk", "label": "Topps Tiles", "is_primary": True},
    {"domain": "tilemountain.co.uk", "label": "Tile Mountain", "is_primary": False},
    {"domain": "wallsandfloors.co.uk", "label": "Walls & Floors", "is_primary": False},
]


async def _safe_site_metrics(domain: str) -> dict[str, Any]:
    """Wrap site_metrics to never crash a snapshot. Returns {} on error."""
    try:
        return await ahrefs.site_metrics(target=domain) or {}
    except Exception as e:  # noqa: BLE001
        logger.warning("ahrefs.site_metrics(%s) failed: %s", domain, e)
        return {}


async def _safe_domain_rating(domain: str) -> dict[str, Any]:
    try:
        return await ahrefs.domain_rating(target=domain) or {}
    except Exception as e:  # noqa: BLE001
        logger.warning("ahrefs.domain_rating(%s) failed: %s", domain, e)
        return {}


def _pluck(payload: dict[str, Any], path: list[str]) -> Any:
    """Safe nested-key lookup."""
    cur: Any = payload
    for k in path:
        if isinstance(cur, dict):
            cur = cur.get(k)
        else:
            return None
    return cur


def _coerce_int(val: Any) -> int | None:
    try:
        if val is None or val == "":
            return None
        return int(float(val))
    except (TypeError, ValueError):
        return None


def _coerce_float(val: Any, ndigits: int = 1) -> float | None:
    try:
        if val is None or val == "":
            return None
        return round(float(val), ndigits)
    except (TypeError, ValueError):
        return None


def _first_not_none(*values: Any) -> Any:
    """Return the first value that is not None / ''. Treats 0 as a
    valid value (unlike `or` which treats 0/0.0 as falsy)."""
    for v in values:
        if v is not None and v != "":
            return v
    return None


async def _snapshot_one(domain: str) -> dict[str, Any]:
    """Pull the 5 metrics we care about for one domain."""
    metrics = await _safe_site_metrics(domain)
    dr = await _safe_domain_rating(domain)

    # Ahrefs v3 nests under "metrics" (site_explorer/metrics) and under
    # "domain_rating" (site_explorer/domain-rating). Pluck either.
    metrics_root = metrics.get("metrics") if isinstance(metrics, dict) else None
    if metrics_root is None:
        metrics_root = metrics or {}
    dr_root = dr.get("domain_rating") if isinstance(dr, dict) else None
    if dr_root is None:
        dr_root = dr or {}

    return {
        "domain": domain,
        # DR=0 IS a valid value (baseline domain) — use _first_not_none
        # so the `or` chain doesn't silently drop it.
        "dr": _coerce_float(_first_not_none(
            dr_root.get("domain_rating"),
            dr_root.get("dr"),
            metrics_root.get("domain_rating"),
        ), 1),
        "ahrefs_rank": _coerce_int(_first_not_none(
            dr_root.get("ahrefs_rank"),
            metrics_root.get("ahrefs_rank"),
        )),
        # Ahrefs v3 uses `org_*` field names, not `organic_*`
        "organic_traffic": _coerce_int(_first_not_none(
            metrics_root.get("org_traffic"),
            metrics_root.get("organic_traffic"),
        )),
        "organic_keywords": _coerce_int(_first_not_none(
            metrics_root.get("org_keywords"),
            metrics_root.get("organic_keywords"),
        )),
        "organic_keywords_top3": _coerce_int(metrics_root.get("org_keywords_1_3")),
        "refdomains": _coerce_int(_first_not_none(
            metrics_root.get("refdomains"),
            metrics_root.get("backlinks_domains"),
            metrics_root.get("ref_domains"),
        )),
        "backlinks": _coerce_int(metrics_root.get("backlinks")),
        "raw_metrics": metrics_root,
        "raw_dr": dr_root,
    }


async def run_weekly_snapshot() -> dict[str, Any]:
    """Capture this week's snapshot for our domain + all competitors,
    compute gap deltas vs last week, persist + return the summary."""
    db = get_db()
    started = datetime.now(timezone.utc)

    our = await _snapshot_one(OUR_DOMAIN)
    competitor_rows = []
    for c in COMPETITORS:
        row = await _snapshot_one(c["domain"])
        row["label"] = c["label"]
        row["is_primary"] = c["is_primary"]
        competitor_rows.append(row)

    # Compute gaps to the primary competitor (Topps Tiles)
    primary = next((c for c in competitor_rows if c["is_primary"]),
                   competitor_rows[0] if competitor_rows else None)
    gap_to_primary = None
    if primary:
        gap_to_primary = {
            "primary_domain": primary["domain"],
            "primary_label": primary["label"],
            "dr_gap": (primary.get("dr") or 0) - (our.get("dr") or 0),
            "traffic_gap": (primary.get("organic_traffic") or 0) - (our.get("organic_traffic") or 0),
            "refdomains_gap": (primary.get("refdomains") or 0) - (our.get("refdomains") or 0),
            "keywords_gap": (primary.get("organic_keywords") or 0) - (our.get("organic_keywords") or 0),
            # Traffic ratio = "we are 1/Xth of Topps"
            "traffic_ratio": _safe_ratio(primary.get("organic_traffic"),
                                          our.get("organic_traffic")),
        }

    # Compare to last week to know if we're closing OR widening the gap
    last_week = await _latest_snapshot_before(started)
    delta_vs_last_week = _compute_delta(last_week, our, gap_to_primary)

    snapshot = {
        "captured_at": started,
        "our": our,
        "competitors": competitor_rows,
        "gap_to_primary": gap_to_primary,
        "delta_vs_last_week": delta_vs_last_week,
    }
    await db[SNAPSHOTS_COLLECTION].insert_one(dict(snapshot))

    # Fire Telegram if the gap WIDENED week-over-week
    if delta_vs_last_week and delta_vs_last_week.get("widened"):
        await _fire_widening_alert(snapshot)

    snapshot["captured_at"] = snapshot["captured_at"].isoformat()
    snapshot.pop("_id", None)
    return snapshot


def _safe_ratio(numerator: int | None, denominator: int | None) -> float | None:
    if not numerator or not denominator:
        return None
    try:
        return round(numerator / denominator, 1)
    except ZeroDivisionError:
        return None


async def _latest_snapshot_before(when: datetime) -> dict[str, Any] | None:
    db = get_db()
    snap = await db[SNAPSHOTS_COLLECTION].find_one(
        {"captured_at": {"$lt": when}},
        sort=[("captured_at", -1)],
    )
    return snap


def _compute_delta(last: dict[str, Any] | None,
                   our_now: dict[str, Any],
                   gap_now: dict[str, Any] | None) -> dict[str, Any] | None:
    if not last:
        return None
    last_our = last.get("our") or {}
    last_gap = last.get("gap_to_primary") or {}
    out: dict[str, Any] = {}
    for k in ("dr", "organic_traffic", "organic_keywords", "refdomains"):
        old_v = last_our.get(k)
        new_v = our_now.get(k)
        if old_v is not None and new_v is not None:
            out[k] = round(new_v - old_v, 2)
    # Gap deltas — negative = gap closed (good)
    if gap_now and last_gap:
        for k in ("dr_gap", "traffic_gap", "refdomains_gap", "keywords_gap"):
            old_v = last_gap.get(k)
            new_v = gap_now.get(k)
            if old_v is not None and new_v is not None:
                out[f"{k}_delta"] = round(new_v - old_v, 2)
    # Widened? Gap going UP on any of (dr, traffic) = bad
    widened = (
        (out.get("dr_gap_delta") or 0) > 0.5
        or (out.get("traffic_gap_delta") or 0) > 1000
    )
    out["widened"] = widened
    return out


async def _fire_widening_alert(snapshot: dict[str, Any]) -> None:
    """Telegram fire when the gap got worse this week."""
    try:
        from services.telegram_notify import fire_and_forget
        gap = snapshot.get("gap_to_primary") or {}
        delta = snapshot.get("delta_vs_last_week") or {}
        dr_d = delta.get("dr_gap_delta", 0)
        traf_d = delta.get("traffic_gap_delta", 0)
        text = (
            "<b>📉 Topps Tiles gap widened this week</b>\n"
            f"DR gap: {gap.get('dr_gap')} ({_sign(dr_d)})\n"
            f"Traffic gap: {gap.get('traffic_gap'):,} ({_sign(traf_d, n_digits=0)})\n\n"
            "Admin → SEO Mission tracker for the full breakdown."
        )
        fire_and_forget("topps_gap_widened", text,
                        dedupe_key=f"topps-gap:{snapshot['captured_at'][:10]}")
    except Exception as e:  # noqa: BLE001
        logger.warning("widening Telegram skipped: %s", e)


def _sign(num: float, n_digits: int = 1) -> str:
    if num is None:
        return "—"
    sign = "+" if num > 0 else ""
    fmt = f"{{:.{n_digits}f}}" if n_digits else "{:,.0f}"
    return f"{sign}{fmt.format(num)}"


# ─── Mission helpers ───────────────────────────────────────────────


async def get_history(limit: int = 52) -> list[dict[str, Any]]:
    """Return the last N weekly snapshots in chronological order, ready
    to chart on the dashboard."""
    db = get_db()
    cursor = db[SNAPSHOTS_COLLECTION].find(
        {},
        {"_id": 0, "captured_at": 1, "our": 1,
         "competitors.domain": 1, "competitors.label": 1,
         "competitors.dr": 1, "competitors.organic_traffic": 1,
         "competitors.refdomains": 1, "competitors.is_primary": 1,
         "gap_to_primary": 1, "delta_vs_last_week": 1},
    ).sort("captured_at", -1).limit(limit)
    rows = []
    async for r in cursor:
        ts = r.get("captured_at")
        if isinstance(ts, datetime):
            r["captured_at"] = ts.isoformat()
        rows.append(r)
    return list(reversed(rows))


async def get_latest() -> dict[str, Any] | None:
    """Latest snapshot for the dashboard headline."""
    db = get_db()
    row = await db[SNAPSHOTS_COLLECTION].find_one(
        {}, {"_id": 0}, sort=[("captured_at", -1)],
    )
    if row and isinstance(row.get("captured_at"), datetime):
        row["captured_at"] = row["captured_at"].isoformat()
    return row


# ─── Mission milestones (read-only) ────────────────────────────────


MISSION_MILESTONES = [
    {
        "month": 1,
        "label": "Foundation",
        "metrics": {"indexed_pages_target": 1500, "soft_404_target_max": 50},
        "summary": "Foundation — SSR body content, sitemap collections, SEO autopilot live.",
    },
    {
        "month": 2,
        "label": "Long-tail launch",
        "metrics": {"organic_visits_target": 2500, "articles_target": 12, "top20_keywords_added": 25},
        "summary": "Editorial Autopilot publishes 3 articles/week attacking Topps' winning topics.",
    },
    {
        "month": 3,
        "label": "City + showroom dominance",
        "metrics": {"local_pack_top3": 3, "top10_keywords_added": 25},
        "summary": "Local-intent keywords — where a small player beats a national giant.",
    },
    {
        "month": 4,
        "label": "Backlink push",
        "metrics": {"refdomains_added": 50, "dr_added": 5, "pinterest_pins": 200},
        "summary": "Houzz + Pinterest + Editorial cross-pollination drives organic backlinks.",
    },
    {
        "month": 5,
        "label": "Content velocity",
        "metrics": {"indexed_pages_target": 2500, "articles_total_target": 50, "organic_visits_target": 8000},
        "summary": "Compound effect — every article lifts the whole domain.",
    },
    {
        "month": 6,
        "label": "Half-year inflection",
        "metrics": {"dr_added": 10, "organic_visits_target": 15000,
                    "top3_keywords": 25, "keyword_overlap_pct": 25},
        "summary": "Google trust kicks in. Articles from months 1-3 start ranking.",
    },
    {
        "month": 7,
        "label": "Authority expansion",
        "metrics": {"refdomains_added": 200, "indexed_pages_target": 4000},
        "summary": "Volume to capture Google Discover.",
    },
    {
        "month": 8,
        "label": "Conversion focus",
        "metrics": {"organic_visits_target": 25000, "trade_signups_organic": "track"},
        "summary": "Commercial-intent keywords convert at 5-10x generic ones.",
    },
    {
        "month": 9,
        "label": "Adjacent-content authority",
        "metrics": {"whole_home_content_pieces": 50, "pinterest_top_boards_10k": 3},
        "summary": "Become a destination, not a vendor (IKEA/JLP playbook).",
    },
    {
        "month": 10,
        "label": "Product page authority",
        "metrics": {"avg_pdp_dr": 5, "min_inbound_links_per_pdp": 3},
        "summary": "Internal link sculpting — every PDP gets ≥3 inbound links from blog/category.",
    },
    {
        "month": 11,
        "label": "National visibility",
        "metrics": {"organic_visits_target": 40000, "top10_national_keywords": 50,
                    "branded_search_monthly": 2000},
        "summary": "Branded search volume — Topps starts seeing us in their reports.",
    },
    {
        "month": 12,
        "label": "Gap report",
        "metrics": {"dr_added": 15, "organic_visits_target": 60000,
                    "indexed_pages_target": 6000, "keyword_overlap_pct": 40,
                    "refdomains_added": 400},
        "summary": "10× T-zero organic traffic. 1/10th of Topps instead of 1/600th.",
    },
]


async def get_mission_status() -> dict[str, Any]:
    """Compose the mission dashboard payload: current snapshot,
    milestones with on-track status, and recent history."""
    latest = await get_latest()
    history = await get_history(limit=26)  # last ~6 months
    baseline = history[0] if history else None
    # Decide which milestone month we're in
    if baseline:
        baseline_at = baseline.get("captured_at") or ""
        from dateutil import parser as dtparser
        try:
            baseline_dt = dtparser.parse(baseline_at) if isinstance(baseline_at, str) else baseline_at
            weeks_elapsed = max(0, (datetime.now(timezone.utc) - baseline_dt).days // 7)
        except Exception:
            weeks_elapsed = 0
    else:
        weeks_elapsed = 0
    current_month = min(12, max(1, (weeks_elapsed // 4) + 1))

    # Annotate milestones with status
    milestones_with_status = []
    for m in MISSION_MILESTONES:
        status = "future"
        if m["month"] < current_month:
            status = "past"
        elif m["month"] == current_month:
            status = "current"
        milestones_with_status.append({**m, "status": status})

    return {
        "latest_snapshot": latest,
        "baseline_snapshot": baseline,
        "weeks_elapsed": weeks_elapsed,
        "current_month": current_month,
        "milestones": milestones_with_status,
        "history": history,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }

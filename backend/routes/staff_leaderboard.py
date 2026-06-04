"""
Staff Leaderboard — gamification + competition tracking (3 Jun 2026).

User requested:
1. Staff attribution: QUOTE CREATOR wins on conversion (option 1a).
2. Expired-quote discount codes: admin-picked % per code (option 2c).
3. Showroom leaderboard banner: company-wide + per-showroom views,
   visible top of every admin page (option 3a, no public TV needed).
4. Monthly competition: bragging rights + trackable targets +
   optional cash bonus (option 4d).
5. Bonus features:
   - Daily streak tracking ("Tom on a 12-day quote-conversion streak")
   - Per-staff conversion-rate vs. their own historical avg
6. Sales metric definition (3 Jun 2026 clarification):
   "Sales" = invoices with order_type = "Special Order" only
   (tiles, bathroom, flooring, underfloor heating). "Store Order"
   (material/tools) is EXCLUDED.

Endpoints:
- GET /api/staff-leaderboard/banner — lightweight cycling banner data
  (no auth — used by the public banner that admin browser shows).
  Caches 30s via in-memory snapshot.
- GET /api/staff-leaderboard/full — full ranked list of every staff
  member with both quote-conversions and special-order sales for the
  current month (admin only).
- GET /api/staff-leaderboard/streak/{user_id} — daily-streak detail
  for a specific staff member.
- POST /api/staff-leaderboard/target — admin sets monthly target
  (count of conversions OR sales £) for the whole team or a specific
  staff member.
- POST /api/staff-leaderboard/bonus — admin records the cash bonus
  awarded to a winner (optional — purely for tracking, no payment).
"""
import logging
import time
from datetime import datetime, timezone, timedelta
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from config import get_db
from services import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/staff-leaderboard", tags=["Staff Leaderboard"])

# ----------------------------------------------------------------------
# In-memory cache so the banner endpoint, polled from every open admin
# page, doesn't hammer Mongo. 30-second TTL is fresh enough for the
# "Syed is leading" message without recomputing the heavy aggregation
# pipeline on every request.
# ----------------------------------------------------------------------
_BANNER_CACHE: dict = {"ts": 0.0, "data": None}
_BANNER_TTL_SECONDS = 30.0


def _month_window_utc(now: Optional[datetime] = None) -> tuple[datetime, datetime, str]:
    """Return (start_of_month, end_of_next_minute, month_label) UTC."""
    n = now or datetime.now(timezone.utc)
    start = n.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    label = start.strftime("%B %Y")  # e.g. "June 2026"
    return start, n, label


async def _compute_leaderboard(month_only: bool = True) -> dict:
    """Aggregate quote-conversions + special-order sales per staff.

    Returns a dict with `month`, `staff` (full ranked list), and
    `showrooms` (per-showroom top leader). Sales = Special Order
    invoices only (per user clarification 3 Jun 2026).
    """
    db = get_db()
    start, now, label = _month_window_utc()

    # ---- Quote-conversion attribution -------------------------------
    # Per user choice 1a: the QUOTE CREATOR wins. We group by
    # quote.created_by_user_id (preferred) falling back to
    # quote.created_by (email/name string) for legacy docs.
    #
    # Two counters per staff:
    #  * quotes_created — every quote authored this month
    #  * quotes_converted — that quote ended up with an invoice
    #
    # Conversion rate = converted / created (0 if no quotes).

    # Build the quote match: every quote authored in the current month
    # window. Conversion is detected via either:
    #   • the existing `converted_at` timestamp set when /convert is hit
    #   • or `converted_to_invoice` having a truthy value
    # Either flag means "this quote turned into an invoice".
    quote_match = {
        "$or": [
            {"created_at": {"$gte": start}},
            {"created_at": {"$gte": start.isoformat()}},
        ]
    } if month_only else {}

    quote_pipeline = [
        {"$match": quote_match},
        {
            "$project": {
                "_id": 0,
                "created_by_user_id": 1,
                "created_by": 1,
                "sales_person": 1,
                "showroom_id": 1,
                "showroom_name": 1,
                "converted_at": 1,
                "converted_to_invoice": 1,
                "converted_to_invoice_id": 1,
                "created_at": 1,
            }
        },
    ]
    quotes = await db.quotations.aggregate(quote_pipeline).to_list(length=20000)

    staff_map: dict = {}  # key = stable staff-id, value = aggregated dict

    def _staff_key(q: dict) -> tuple[str, str, str, str]:
        """Return (key, display_name, showroom_id, showroom_name).
        Prefers created_by_user_id; falls back to sales_person string
        for older quotes that pre-dated the user-id stamp."""
        uid = (q.get("created_by_user_id") or "").strip()
        sp = (q.get("sales_person") or q.get("created_by") or "").strip()
        showroom_id = (q.get("showroom_id") or "").strip()
        showroom_name = (q.get("showroom_name") or "").strip()
        if uid:
            return (uid, sp or "Unknown", showroom_id, showroom_name)
        if sp:
            return (f"name:{sp.lower()}", sp, showroom_id, showroom_name)
        return ("", "", showroom_id, showroom_name)

    for q in quotes:
        key, name, showroom_id, showroom_name = _staff_key(q)
        if not key:
            continue
        entry = staff_map.setdefault(key, {
            "user_id": key if not key.startswith("name:") else None,
            "name": name,
            "showroom_id": showroom_id,
            "showroom_name": showroom_name or "Unassigned",
            "quotes_created": 0,
            "quotes_converted": 0,
            "sales_count": 0,
            "sales_value_gbp": 0.0,
        })
        entry["quotes_created"] += 1
        if q.get("converted_at") or q.get("converted_to_invoice") or q.get("converted_to_invoice_id"):
            entry["quotes_converted"] += 1
        # Update name/showroom on the latest quote so renames propagate.
        if name and not entry["name"]:
            entry["name"] = name
        if showroom_name and not entry["showroom_name"]:
            entry["showroom_name"] = showroom_name

    # ---- Special-order sales (revenue) ------------------------------
    # Per user clarification 3 Jun 2026: ONLY invoices with
    # order_type = "Special Order" count toward the sales metric.
    # "Store Order" = material/tools, excluded.
    invoice_match = {
        "order_type": "Special Order",
    }
    if month_only:
        invoice_match["$or"] = [
            {"created_at": {"$gte": start}},
            {"created_at": {"$gte": start.isoformat()}},
        ]
    invoices = await db.invoices.aggregate([
        {"$match": invoice_match},
        {
            "$project": {
                "_id": 0,
                "created_by_user_id": 1,
                "created_by": 1,
                "sales_person": 1,
                "showroom_id": 1,
                "showroom_name": 1,
                "total": 1,
                "grand_total": 1,
                "total_amount": 1,
                "created_at": 1,
            }
        },
    ]).to_list(length=20000)

    for inv in invoices:
        key, name, showroom_id, showroom_name = _staff_key(inv)
        if not key:
            continue
        entry = staff_map.setdefault(key, {
            "user_id": key if not key.startswith("name:") else None,
            "name": name,
            "showroom_id": showroom_id,
            "showroom_name": showroom_name or "Unassigned",
            "quotes_created": 0,
            "quotes_converted": 0,
            "sales_count": 0,
            "sales_value_gbp": 0.0,
        })
        entry["sales_count"] += 1
        # Prefer grand_total; fall back to total; ignore Nones.
        amount = inv.get("grand_total") or inv.get("total") or inv.get("total_amount") or 0
        try:
            entry["sales_value_gbp"] += float(amount)
        except (TypeError, ValueError):
            pass

    # ---- Derive conversion_rate + showroom rollup -------------------
    staff_list: List[dict] = []
    for entry in staff_map.values():
        created = entry["quotes_created"]
        converted = entry["quotes_converted"]
        entry["conversion_rate"] = round((converted / created) * 100, 1) if created > 0 else 0.0
        entry["sales_value_gbp"] = round(entry["sales_value_gbp"], 2)
        staff_list.append(entry)

    # Sort by conversions DESC, then by sales DESC as tie-breaker.
    staff_list.sort(
        key=lambda x: (x["quotes_converted"], x["sales_value_gbp"], x["sales_count"]),
        reverse=True,
    )

    # Per-showroom top leader
    showroom_leaders: dict = {}
    for s in staff_list:
        sr_name = s["showroom_name"]
        if not sr_name:
            continue
        if sr_name not in showroom_leaders:
            showroom_leaders[sr_name] = s

    return {
        "month": label,
        "month_start": start.isoformat(),
        "staff": staff_list,
        "showroom_leaders": showroom_leaders,
    }


async def _compute_streak(user_key: str, name: str) -> dict:
    """Walk backwards day-by-day from today and count consecutive
    days with at least 1 quote conversion. Returns {streak_days,
    last_conversion_at}."""
    db = get_db()
    now = datetime.now(timezone.utc)

    # Look back at most 90 days — beyond that a "streak" is
    # historical noise more than current momentum.
    horizon = now - timedelta(days=90)
    match = {"converted_at": {"$exists": True, "$ne": None}}
    # Allow either user_id or sales_person string match.
    if user_key.startswith("name:"):
        match["sales_person"] = {"$regex": f"^{user_key[5:]}$", "$options": "i"}
    else:
        match["created_by_user_id"] = user_key
    match["$or"] = [
        {"created_at": {"$gte": horizon}},
        {"created_at": {"$gte": horizon.isoformat()}},
    ]
    quotes = await db.quotations.find(
        match,
        {"_id": 0, "converted_at": 1},
    ).to_list(length=2000)

    days_with_conversion: set = set()
    last_ts: Optional[datetime] = None
    for q in quotes:
        ts = q.get("converted_at")
        if not ts:
            continue
        if isinstance(ts, str):
            try:
                ts = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            except ValueError:
                continue
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        days_with_conversion.add(ts.date())
        if last_ts is None or ts > last_ts:
            last_ts = ts

    today = now.date()
    streak = 0
    cur = today
    while cur in days_with_conversion:
        streak += 1
        cur = cur - timedelta(days=1)

    return {
        "user_id": user_key,
        "name": name,
        "streak_days": streak,
        "last_conversion_at": last_ts.isoformat() if last_ts else None,
    }


async def _compute_personal_avg_rate(user_key: str) -> Optional[float]:
    """Return the staff member's lifetime conversion rate (excluding
    the current month) so the UI can render "Tom 62% this month vs
    his usual 48%". Returns None if there's no history."""
    db = get_db()
    month_start, _, _ = _month_window_utc()
    match = {
        "$or": [
            {"created_at": {"$lt": month_start}},
            {"created_at": {"$lt": month_start.isoformat()}},
        ]
    }
    if user_key.startswith("name:"):
        match["sales_person"] = {"$regex": f"^{user_key[5:]}$", "$options": "i"}
    else:
        match["created_by_user_id"] = user_key
    cursor = db.quotations.find(
        match,
        {"_id": 0, "converted_at": 1, "converted_to_invoice": 1, "converted_to_invoice_id": 1},
    )
    created = 0
    converted = 0
    async for q in cursor:
        created += 1
        if q.get("converted_at") or q.get("converted_to_invoice") or q.get("converted_to_invoice_id"):
            converted += 1
    if created == 0:
        return None
    return round((converted / created) * 100, 1)


# ----------------------------------------------------------------------
# Public banner endpoint — no auth, low-latency, in-memory cached.
# Polled by the AdminLayout banner component every 60s.
# ----------------------------------------------------------------------
@router.get("/banner")
async def get_leaderboard_banner():
    """Return the cycling-banner payload: company leader, showroom
    leader (per showroom), and streak headlines. Cached in-memory
    for 30s to avoid hammering Mongo while every open admin tab
    polls."""
    now_ts = time.time()
    if _BANNER_CACHE["data"] is not None and (now_ts - _BANNER_CACHE["ts"]) < _BANNER_TTL_SECONDS:
        return _BANNER_CACHE["data"]

    board = await _compute_leaderboard(month_only=True)
    staff = board["staff"]

    # Pick the headline leaders.
    # 1. Quote-conversion leader: top of `staff` (already sorted that way).
    conv_leader = staff[0] if staff else None
    runner_up = staff[1] if len(staff) > 1 else None

    # 2. Sales-revenue leader: re-sort by sales DESC.
    sales_sorted = sorted(staff, key=lambda x: x["sales_value_gbp"], reverse=True)
    sales_leader = sales_sorted[0] if sales_sorted else None
    sales_runner_up = sales_sorted[1] if len(sales_sorted) > 1 else None

    # 3. Top streak — compute streaks for the top 5 conversion leaders
    # only (cheap; running it for every staff would be expensive).
    streaks = []
    for s in staff[:5]:
        key = s["user_id"] or f"name:{s['name'].lower()}"
        st = await _compute_streak(key, s["name"])
        if st["streak_days"] >= 2:  # nothing dazzling about a 1-day "streak"
            streaks.append({**st, "showroom_name": s["showroom_name"]})
    streaks.sort(key=lambda x: x["streak_days"], reverse=True)
    top_streak = streaks[0] if streaks else None

    payload = {
        "month": board["month"],
        "conv_leader": conv_leader,
        "conv_runner_up": runner_up,
        "conv_gap": (
            (conv_leader["quotes_converted"] - runner_up["quotes_converted"])
            if (conv_leader and runner_up) else 0
        ),
        "sales_leader": sales_leader,
        "sales_runner_up": sales_runner_up,
        "sales_gap_gbp": (
            round(sales_leader["sales_value_gbp"] - sales_runner_up["sales_value_gbp"], 2)
            if (sales_leader and sales_runner_up) else 0.0
        ),
        "top_streak": top_streak,
        "showroom_leaders": board["showroom_leaders"],
        "total_staff": len(staff),
    }
    _BANNER_CACHE["ts"] = now_ts
    _BANNER_CACHE["data"] = payload
    return payload


# ----------------------------------------------------------------------
# Full leaderboard (admin only) — every staff ranked 1..N
# ----------------------------------------------------------------------
@router.get("/full")
async def get_full_leaderboard(
    current_user: dict = Depends(get_current_user),
):
    """Per user clarification: show ALL staff (not just top 5), ranked
    1..N for both quote-conversions and special-order sales."""
    if (current_user or {}).get("role") not in {"super_admin", "admin", "manager"}:
        raise HTTPException(status_code=403, detail="Admin role required.")
    board = await _compute_leaderboard(month_only=True)

    # Decorate each staff with personal avg + current streak.
    decorated = []
    for s in board["staff"]:
        key = s["user_id"] or f"name:{s['name'].lower()}"
        avg_rate = await _compute_personal_avg_rate(key)
        streak = await _compute_streak(key, s["name"])
        decorated.append({
            **s,
            "personal_avg_conversion_rate": avg_rate,
            "streak_days": streak["streak_days"],
            "rate_vs_avg_delta": (
                round(s["conversion_rate"] - avg_rate, 1) if avg_rate is not None else None
            ),
        })

    # Targets + bonuses are optional doc on `staff_leaderboard_targets`.
    db = get_db()
    targets_doc = await db.staff_leaderboard_targets.find_one(
        {"month": board["month"]}, {"_id": 0}
    )
    return {
        "month": board["month"],
        "staff": decorated,
        "showroom_leaders": board["showroom_leaders"],
        "team_target": (targets_doc or {}).get("team_target") or {},
        "per_staff_targets": (targets_doc or {}).get("per_staff_targets") or {},
        "bonuses": (targets_doc or {}).get("bonuses") or {},
    }


# ----------------------------------------------------------------------
# Streak detail (admin only)
# ----------------------------------------------------------------------
@router.get("/streak/{user_key}")
async def get_streak_for_user(
    user_key: str,
    current_user: dict = Depends(get_current_user),
):
    if (current_user or {}).get("role") not in {"super_admin", "admin", "manager"}:
        raise HTTPException(status_code=403, detail="Admin role required.")
    return await _compute_streak(user_key, "")


# ----------------------------------------------------------------------
# Monthly target — admin sets the team or per-staff goal
# ----------------------------------------------------------------------
class TargetReq(BaseModel):
    metric: str = Field(default="conversions", pattern="^(conversions|sales_gbp)$")
    # Team-level target applied to everyone if per_staff is empty
    team_target: Optional[float] = Field(default=None, ge=0)
    # Optional per-staff override: {user_key: target_value}
    per_staff_targets: Optional[dict] = None


@router.post("/target")
async def set_monthly_target(
    req: TargetReq,
    current_user: dict = Depends(get_current_user),
):
    if (current_user or {}).get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Only super admins can set targets.")
    db = get_db()
    _, _, month = _month_window_utc()
    doc = await db.staff_leaderboard_targets.find_one({"month": month}) or {}
    update = {
        "month": month,
        "metric": req.metric,
        "team_target": {
            "metric": req.metric,
            "value": req.team_target,
        } if req.team_target is not None else (doc.get("team_target") or {}),
        "per_staff_targets": req.per_staff_targets or doc.get("per_staff_targets") or {},
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "updated_by": (current_user or {}).get("email"),
    }
    # Preserve existing bonuses on the same doc.
    if doc.get("bonuses"):
        update["bonuses"] = doc["bonuses"]
    await db.staff_leaderboard_targets.update_one(
        {"month": month},
        {"$set": update},
        upsert=True,
    )
    return {"ok": True, "month": month, "target": update["team_target"]}


# ----------------------------------------------------------------------
# Bonus — admin records cash payout per winner (optional, just tracked)
# ----------------------------------------------------------------------
class BonusReq(BaseModel):
    user_key: str = Field(min_length=1)
    name: Optional[str] = None
    amount_gbp: float = Field(ge=0)
    note: Optional[str] = Field(default=None, max_length=200)


@router.post("/bonus")
async def record_bonus(
    req: BonusReq,
    current_user: dict = Depends(get_current_user),
):
    """Record (don't pay) a cash bonus for a staff member's monthly
    win. Lives on the same `staff_leaderboard_targets.{month}.bonuses`
    sub-doc for later PayrollIntegration."""
    if (current_user or {}).get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Only super admins can record bonuses.")
    db = get_db()
    _, _, month = _month_window_utc()
    doc = await db.staff_leaderboard_targets.find_one({"month": month}) or {}
    bonuses = doc.get("bonuses") or {}
    bonuses[req.user_key] = {
        "name": req.name,
        "amount_gbp": float(req.amount_gbp),
        "note": req.note,
        "recorded_at": datetime.now(timezone.utc).isoformat(),
        "recorded_by": (current_user or {}).get("email"),
    }
    await db.staff_leaderboard_targets.update_one(
        {"month": month},
        {"$set": {"bonuses": bonuses, "month": month}},
        upsert=True,
    )
    return {"ok": True, "month": month, "user_key": req.user_key, "bonus": bonuses[req.user_key]}

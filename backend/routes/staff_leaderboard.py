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

    # ---- Showroom resolution maps -----------------------------------
    # Quotations historically stamp only `showroom_id` (not name), and
    # some legacy quotes / invoices stamp neither. To stop the dashboard
    # showing every staff as "Unassigned", we resolve the showroom via
    # the staff member's user doc + the showrooms collection. (4 Jun
    # 2026 — user reported every staff card said "Unassigned" even
    # though they have showrooms set on their profile.)
    user_resolution: dict = {}  # key (uid/email-lower/name-lower) -> {showroom_id, showroom_name, name}
    # Pre-load every showroom doc {ObjectId-str: name} so we can map
    # user.showroom_id -> showroom_name in a single Mongo round trip.
    showroom_name_by_id: dict = {}
    async for sr in db.showrooms.find({}, {"name": 1}):
        sid = str(sr.get("_id") or "")
        nm = (sr.get("name") or "").strip()
        if sid and nm:
            showroom_name_by_id[sid] = nm

    # 2. Pre-load every user that could plausibly be a staff member
    # (everyone except customers). Build lookup maps by id, by email,
    # and by name (lowercased) so quote/invoice docs can be resolved
    # whatever stamp they carry (uid, created_by email, or sales_person
    # display name).
    async for u in db.users.find(
        {"role": {"$in": ["super_admin", "admin", "manager", "staff"]}},
        {"_id": 0, "id": 1, "email": 1, "name": 1, "showroom_id": 1, "showroom_name": 1},
    ):
        sid = (u.get("showroom_id") or "").strip()
        sname = (u.get("showroom_name") or "").strip()
        # If user has showroom_id but no cached name, hydrate from the
        # showrooms collection.
        if sid and not sname:
            sname = showroom_name_by_id.get(sid, "")
        record = {
            "showroom_id": sid,
            "showroom_name": sname,
            "name": (u.get("name") or "").strip(),
            "email": (u.get("email") or "").strip(),
        }
        uid = (u.get("id") or "").strip()
        if uid:
            user_resolution[uid] = record
        email_lc = record["email"].lower()
        if email_lc:
            user_resolution[f"email:{email_lc}"] = record
        name_lc = record["name"].lower()
        if name_lc:
            user_resolution[f"name:{name_lc}"] = record

    def _resolve_user(uid: str, sp: str, created_by: str) -> tuple[str, str, str, str]:
        """Return (canonical_key, display_name, showroom_id, showroom_name)
        by trying the user-resolution map by uid, then by email
        (created_by is usually the email), then by sales_person name.

        Returns the user's `id` as the canonical key whenever we
        successfully resolve — so two quotes from the same person, one
        stamped with `created_by` (email) and another with only
        `sales_person` (name), bucket into ONE leaderboard row instead
        of two duplicates."""
        # Try uid first
        if uid and uid in user_resolution:
            r = user_resolution[uid]
            return uid, r["name"] or sp, r["showroom_id"], r["showroom_name"]
        # Email fallback (most reliable — unique per user)
        if created_by:
            r = user_resolution.get(f"email:{created_by.lower()}")
            if r:
                # Walk the resolution map for the user's canonical uid.
                # Iterate once — small set, O(n) is fine.
                canonical_uid = next(
                    (k for k, v in user_resolution.items()
                     if not k.startswith(("email:", "name:"))
                     and v.get("email", "").lower() == created_by.lower()),
                    None,
                )
                return (
                    canonical_uid or f"email:{created_by.lower()}",
                    r["name"] or sp,
                    r["showroom_id"],
                    r["showroom_name"],
                )
        # Name fallback (last resort — display names can collide)
        if sp:
            r = user_resolution.get(f"name:{sp.lower()}")
            if r:
                canonical_uid = next(
                    (k for k, v in user_resolution.items()
                     if not k.startswith(("email:", "name:"))
                     and v.get("name", "").lower() == sp.lower()),
                    None,
                )
                return (
                    canonical_uid or f"name:{sp.lower()}",
                    sp,
                    r["showroom_id"],
                    r["showroom_name"],
                )
        return "", sp, "", ""

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

        Uses _resolve_user to find the canonical user-id whenever
        possible, so a staff member with mixed-format stamps (some
        quotes carrying `created_by_user_id`, others only `created_by`
        email, others only `sales_person` name) collapses into a
        single row on the leaderboard.

        Showroom: prefers the doc's own stamp; falls back to the
        showrooms collection via the doc's showroom_id; falls back to
        the user's stored showroom (4 Jun 2026 fix — quotations never
        stamp showroom_name, so without this fallback every card on
        the dashboard reads 'Unassigned')."""
        uid = (q.get("created_by_user_id") or "").strip()
        sp = (q.get("sales_person") or "").strip()
        cb = (q.get("created_by") or "").strip()
        showroom_id = (q.get("showroom_id") or "").strip()
        showroom_name = (q.get("showroom_name") or "").strip()

        # Hydrate name from showrooms collection if only id is on the doc.
        if showroom_id and not showroom_name:
            showroom_name = showroom_name_by_id.get(showroom_id, "")

        # Resolve canonical key + user info from the users collection.
        canonical_key, resolved_name, r_sid, r_sname = _resolve_user(uid, sp, cb)
        if not showroom_id and r_sid:
            showroom_id = r_sid
        if not showroom_name and r_sname:
            showroom_name = r_sname

        # Pick the best canonical key — fall back to email/name if the
        # user couldn't be resolved against the users collection.
        if canonical_key:
            key = canonical_key
        elif uid:
            key = uid
        elif cb:
            key = f"email:{cb.lower()}"
        elif sp:
            key = f"name:{sp.lower()}"
        else:
            return ("", "", showroom_id, showroom_name)

        display_name = resolved_name or sp or cb or "Unknown"
        return (key, display_name, showroom_id, showroom_name)

    for q in quotes:
        key, name, showroom_id, showroom_name = _staff_key(q)
        if not key:
            continue
        entry = staff_map.setdefault(key, {
            "user_id": key if not key.startswith(("name:", "email:")) else None,
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
        # Promote a real resolved showroom over a stale "Unassigned".
        if showroom_name and entry["showroom_name"] in ("", "Unassigned"):
            entry["showroom_name"] = showroom_name
        if showroom_id and not entry["showroom_id"]:
            entry["showroom_id"] = showroom_id
        # Update name on the latest quote so renames propagate.
        if name and (not entry["name"] or entry["name"] == "Unknown"):
            entry["name"] = name

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
            "user_id": key if not key.startswith(("name:", "email:")) else None,
            "name": name,
            "showroom_id": showroom_id,
            "showroom_name": showroom_name or "Unassigned",
            "quotes_created": 0,
            "quotes_converted": 0,
            "sales_count": 0,
            "sales_value_gbp": 0.0,
        })
        # Promote resolved showroom for entries first seen via invoices.
        if showroom_name and entry["showroom_name"] in ("", "Unassigned"):
            entry["showroom_name"] = showroom_name
        if showroom_id and not entry["showroom_id"]:
            entry["showroom_id"] = showroom_id
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
    last_conversion_at}.

    Handles three flavours of user_key:
    - bare uid (e.g. "a3f1-...") — matches quote.created_by_user_id
    - "email:<lower>" — matches quote.created_by (email)
    - "name:<lower>" — matches quote.sales_person (display name)

    Resolves an `email:` or bare-uid key to BOTH the uid AND the email
    via the users collection so historical quotes stamped only with
    `created_by` (email) still surface in the streak count."""
    db = get_db()
    now = datetime.now(timezone.utc)

    # Look back at most 90 days — beyond that a "streak" is
    # historical noise more than current momentum.
    horizon = now - timedelta(days=90)
    or_clauses: list = []
    if user_key.startswith("name:"):
        or_clauses.append({"sales_person": {"$regex": f"^{user_key[5:]}$", "$options": "i"}})
    elif user_key.startswith("email:"):
        or_clauses.append({"created_by": {"$regex": f"^{user_key[6:]}$", "$options": "i"}})
    else:
        # Bare uid — also pull the user's email + name so we catch
        # historical quotes stamped only with created_by/sales_person.
        u = await db.users.find_one({"id": user_key}, {"_id": 0, "email": 1, "name": 1})
        or_clauses.append({"created_by_user_id": user_key})
        if u:
            if u.get("email"):
                or_clauses.append({"created_by": {"$regex": f"^{u['email']}$", "$options": "i"}})
            if u.get("name"):
                or_clauses.append({"sales_person": {"$regex": f"^{u['name']}$", "$options": "i"}})

    match = {
        "converted_at": {"$exists": True, "$ne": None},
        "$and": [
            {"$or": or_clauses},
            {"$or": [
                {"created_at": {"$gte": horizon}},
                {"created_at": {"$gte": horizon.isoformat()}},
            ]},
        ],
    }
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
    his usual 48%". Returns None if there's no history.

    Mirrors _compute_streak's multi-stamp matching (uid + email +
    name) so the average reflects every historical quote regardless
    of which stamp the legacy doc carries."""
    db = get_db()
    month_start, _, _ = _month_window_utc()
    or_clauses: list = []
    if user_key.startswith("name:"):
        or_clauses.append({"sales_person": {"$regex": f"^{user_key[5:]}$", "$options": "i"}})
    elif user_key.startswith("email:"):
        or_clauses.append({"created_by": {"$regex": f"^{user_key[6:]}$", "$options": "i"}})
    else:
        u = await db.users.find_one({"id": user_key}, {"_id": 0, "email": 1, "name": 1})
        or_clauses.append({"created_by_user_id": user_key})
        if u:
            if u.get("email"):
                or_clauses.append({"created_by": {"$regex": f"^{u['email']}$", "$options": "i"}})
            if u.get("name"):
                or_clauses.append({"sales_person": {"$regex": f"^{u['name']}$", "$options": "i"}})

    match = {
        "$and": [
            {"$or": or_clauses},
            {"$or": [
                {"created_at": {"$lt": month_start}},
                {"created_at": {"$lt": month_start.isoformat()}},
            ]},
        ],
    }
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

    # Manual highlight override — if super-admin pinned a custom
    # "Highlight a hero" message, surface it on the banner so it
    # appears as the FIRST slide (the frontend gives it priority).
    db = get_db()
    highlight = await db.staff_highlight_broadcasts.find_one(
        {"expires_at": {"$gte": datetime.now(timezone.utc).isoformat()}},
        {"_id": 0},
        sort=[("created_at", -1)],
    )
    if highlight:
        payload["highlight"] = {
            "name": highlight.get("name"),
            "showroom_name": highlight.get("showroom_name"),
            "message": highlight.get("message"),
            "expires_at": highlight.get("expires_at"),
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


# ----------------------------------------------------------------------
# Competition dashboard — section endpoints (3 Jun 2026)
#
# `/competition` returns the full bundle the dashboard needs in one
# request: time-left countdown, hero champion, head-to-head trio,
# showroom-vs-showroom totals, active streaks, personal-best chasers,
# comeback kings. Hall-of-Fame archive comes from /hall-of-fame; the
# manual "highlight a hero" broadcast lives at /highlight.
# ----------------------------------------------------------------------
async def _showroom_totals_for_month() -> List[dict]:
    """Aggregate quote_conversions + Special-Order sales per showroom
    for the current month. Returns a list sorted by conversions desc."""
    board = await _compute_leaderboard(month_only=True)
    by_room: dict = {}
    for s in board["staff"]:
        sr = s.get("showroom_name") or "Unassigned"
        bucket = by_room.setdefault(sr, {
            "showroom_name": sr,
            "showroom_id": s.get("showroom_id"),
            "quotes_created": 0,
            "quotes_converted": 0,
            "sales_count": 0,
            "sales_value_gbp": 0.0,
            "staff_count": 0,
        })
        bucket["quotes_created"] += s["quotes_created"]
        bucket["quotes_converted"] += s["quotes_converted"]
        bucket["sales_count"] += s["sales_count"]
        bucket["sales_value_gbp"] += s["sales_value_gbp"]
        bucket["staff_count"] += 1
    rooms = list(by_room.values())
    for r in rooms:
        r["sales_value_gbp"] = round(r["sales_value_gbp"], 2)
        r["conversion_rate"] = (
            round((r["quotes_converted"] / r["quotes_created"]) * 100, 1)
            if r["quotes_created"] > 0 else 0.0
        )
    rooms.sort(key=lambda x: (x["quotes_converted"], x["sales_value_gbp"]), reverse=True)
    return rooms


async def _projection_at_pace(value_now: float, days_elapsed: int, days_total: int) -> float:
    """Linear projection of where the metric lands if today's pace
    holds: value_now * (days_total / days_elapsed). Days_elapsed
    floors at 1 so day-1-of-month doesn't divide-by-zero."""
    if days_elapsed <= 0:
        return value_now
    return round(value_now * (days_total / max(1, days_elapsed)), 2)


def _days_in_month(d: datetime) -> int:
    """Total days in d's calendar month."""
    next_month = (d.replace(day=28) + timedelta(days=4)).replace(day=1)
    return (next_month - d.replace(day=1)).days


@router.get("/competition")
async def get_competition_dashboard(
    current_user: dict = Depends(get_current_user),
):
    """One-shot endpoint that returns every section of the
    Competition dashboard. Cheaper than 6 separate calls + means
    the dashboard renders in a single network round-trip."""
    if (current_user or {}).get("role") not in {"super_admin", "admin", "manager"}:
        raise HTTPException(status_code=403, detail="Admin role required.")

    now = datetime.now(timezone.utc)
    month_start, _, month_label = _month_window_utc(now)
    total_days = _days_in_month(now)
    days_elapsed = max(1, (now - month_start).days + 1)
    days_left = max(0, total_days - days_elapsed)

    board = await _compute_leaderboard(month_only=True)
    staff = board["staff"]

    # ---- Decorate (streaks + personal avg) for every staff
    decorated = []
    for s in staff:
        key = s["user_id"] or f"name:{s['name'].lower()}"
        avg_rate = await _compute_personal_avg_rate(key)
        streak = await _compute_streak(key, s["name"])
        decorated.append({
            **s,
            "user_key": key,
            "personal_avg_conversion_rate": avg_rate,
            "streak_days": streak["streak_days"],
            "rate_vs_avg_delta": (
                round(s["conversion_rate"] - avg_rate, 1) if avg_rate is not None else None
            ),
        })

    # ---- Section 1: Hero champion + projection
    champion = decorated[0] if decorated else None
    target_doc = await get_db().staff_leaderboard_targets.find_one(
        {"month": month_label}, {"_id": 0}
    )
    team_target = (target_doc or {}).get("team_target") or {}
    target_value = team_target.get("value")
    target_metric = team_target.get("metric", "conversions")
    progress: List[dict] = []
    if target_value is not None:
        for s in decorated:
            current = (
                s["sales_value_gbp"] if target_metric == "sales_gbp"
                else s["quotes_converted"]
            )
            projected = await _projection_at_pace(current, days_elapsed, total_days)
            progress.append({
                **s,
                "current": current,
                "target": float(target_value),
                "pct": min(100, round((current / float(target_value)) * 100, 1)) if target_value else 0,
                "projected_eom": projected,
                "on_track": projected >= float(target_value),
            })

    # ---- Section 2: Top-3 head-to-head trio
    h2h = decorated[:3]

    # ---- Section 3: Showroom vs Showroom
    showrooms = await _showroom_totals_for_month()
    showroom_winners = {}
    if showrooms:
        showroom_winners["conversions"] = showrooms[0]
        showroom_winners["sales_gbp"] = max(showrooms, key=lambda r: r["sales_value_gbp"])
        rate_eligible = [r for r in showrooms if r["quotes_created"] >= 5]
        showroom_winners["conversion_rate"] = (
            max(rate_eligible, key=lambda r: r["conversion_rate"]) if rate_eligible else None
        )

    # ---- Section 4: Streaks, personal-best chasers, comebacks
    active_streaks = [s for s in decorated if s["streak_days"] >= 3]
    active_streaks.sort(key=lambda x: x["streak_days"], reverse=True)

    pb_chasers = [
        s for s in decorated
        if s["personal_avg_conversion_rate"] is not None
        and s["conversion_rate"] > s["personal_avg_conversion_rate"]
        and s["quotes_created"] >= 3  # avoid noise from 1-of-1
    ]
    pb_chasers.sort(key=lambda x: x["rate_vs_avg_delta"], reverse=True)

    # Comeback kings — staff with ≥5 conversions this month who had
    # 0 conversions last month. We check the previous month's
    # snapshot in `staff_leaderboard_history` (populated by the
    # month-end snapshot task), or fall back to a live count.
    comebacks: List[dict] = []
    if month_start.month == 1:
        prev_label = f"December {month_start.year - 1}"
    else:
        prev_label = (
            month_start.replace(day=1) - timedelta(days=1)
        ).strftime("%B %Y")
    prev_hof = await get_db().staff_leaderboard_history.find_one(
        {"month": prev_label}, {"_id": 0}
    )
    prev_conv_by_key: dict = {}
    if prev_hof:
        for s in (prev_hof.get("staff") or []):
            prev_conv_by_key[s.get("user_key") or f"name:{(s.get('name') or '').lower()}"] = s.get("quotes_converted", 0)
    for s in decorated:
        if s["quotes_converted"] < 5:
            continue
        prev_count = prev_conv_by_key.get(s["user_key"], 0)
        if prev_count == 0:
            comebacks.append({**s, "previous_month_conversions": prev_count})

    # ---- Section 7: Active highlight broadcast (banner override)
    db = get_db()
    highlight = await db.staff_highlight_broadcasts.find_one(
        {"expires_at": {"$gte": now.isoformat()}},
        {"_id": 0},
        sort=[("created_at", -1)],
    )

    return {
        "month": month_label,
        "month_start": month_start.isoformat(),
        "days_elapsed": days_elapsed,
        "days_total": total_days,
        "days_left": days_left,
        "champion": champion,
        "target": {
            "metric": target_metric,
            "value": float(target_value) if target_value is not None else None,
        },
        "progress": progress,
        "head_to_head": h2h,
        "showrooms": showrooms,
        "showroom_winners": showroom_winners,
        "active_streaks": active_streaks,
        "personal_best_chasers": pb_chasers,
        "comebacks": comebacks,
        "active_highlight": highlight,
        "total_staff": len(decorated),
    }


@router.get("/hall-of-fame")
async def get_hall_of_fame(
    limit: int = 24,
    current_user: dict = Depends(get_current_user),
):
    """Past months' champions (3 Jun 2026). Backed by
    `staff_leaderboard_history` snapshots taken on the 1st of each
    month by `snapshot_previous_month()` below. We start fresh from
    June 2026 per user direction — no backfill of older months."""
    if (current_user or {}).get("role") not in {"super_admin", "admin", "manager"}:
        raise HTTPException(status_code=403, detail="Admin role required.")
    db = get_db()
    cursor = db.staff_leaderboard_history.find(
        {}, {"_id": 0}
    ).sort("month_start", -1).limit(int(limit))
    rows = []
    async for r in cursor:
        rows.append(r)
    return {"history": rows, "count": len(rows)}


# ----------------------------------------------------------------------
# Manual "Highlight a hero" broadcast — super-admin can pin a custom
# message to the top banner for 24 h. Banner endpoint includes the
# highlight (if active) as the first slide so it pre-empts the
# automatic cycle.
# ----------------------------------------------------------------------
class HighlightReq(BaseModel):
    user_key: Optional[str] = Field(default=None, description="Staff key being celebrated")
    name: str = Field(min_length=1, max_length=80)
    message: str = Field(min_length=5, max_length=240)
    showroom_name: Optional[str] = Field(default=None, max_length=80)
    duration_hours: int = Field(default=24, ge=1, le=168)


@router.post("/highlight")
async def broadcast_highlight(
    req: HighlightReq,
    current_user: dict = Depends(get_current_user),
):
    """Super-admin only. Replaces (rather than queues) any previous
    active highlight so a typo can be corrected instantly without
    waiting 24 h."""
    if (current_user or {}).get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Only super admins can broadcast a highlight.")
    db = get_db()
    now = datetime.now(timezone.utc)
    doc = {
        "name": req.name,
        "message": req.message,
        "user_key": req.user_key,
        "showroom_name": req.showroom_name,
        "created_at": now.isoformat(),
        "created_by": (current_user or {}).get("email"),
        "expires_at": (now + timedelta(hours=req.duration_hours)).isoformat(),
    }
    # We use a fixed singleton id so a fresh broadcast supersedes the
    # previous one — simpler UX than building a queue.
    await db.staff_highlight_broadcasts.update_one(
        {"id": "active"},
        {"$set": {**doc, "id": "active"}},
        upsert=True,
    )
    # Force the banner cache to refresh so the new highlight appears
    # within seconds, not after the 30s TTL.
    _BANNER_CACHE["ts"] = 0.0
    _BANNER_CACHE["data"] = None
    return {"ok": True, "highlight": doc}


@router.delete("/highlight")
async def clear_highlight(
    current_user: dict = Depends(get_current_user),
):
    if (current_user or {}).get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Only super admins can clear the highlight.")
    db = get_db()
    await db.staff_highlight_broadcasts.delete_many({"id": "active"})
    _BANNER_CACHE["ts"] = 0.0
    _BANNER_CACHE["data"] = None
    return {"ok": True}


# ----------------------------------------------------------------------
# Hall-of-Fame snapshot — called automatically on the 1st of each
# month (via the existing scheduler in services/scheduler.py).
# Captures the FINAL leaderboard of the just-finished month into
# `staff_leaderboard_history` so the dashboard can render the
# year-long story without re-aggregating historical quotes.
# ----------------------------------------------------------------------
async def snapshot_previous_month() -> dict:
    """Idempotent — re-running on the same day re-stamps the doc.
    No-op when there's nothing to record (no conversions last month
    means no champion). Returns the snapshot for logging."""
    db = get_db()
    now = datetime.now(timezone.utc)
    # Compute the previous month's window.
    cur_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    prev_end = cur_start - timedelta(seconds=1)
    prev_start = prev_end.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    label = prev_start.strftime("%B %Y")

    # Aggregate the previous month directly (the live leaderboard
    # only knows about the current month).
    quote_pipeline = [
        {"$match": {
            "$or": [
                {"created_at": {"$gte": prev_start, "$lte": prev_end}},
                {"created_at": {"$gte": prev_start.isoformat(), "$lte": prev_end.isoformat()}},
            ]
        }},
        {"$project": {
            "_id": 0, "created_by_user_id": 1, "created_by": 1, "sales_person": 1,
            "showroom_id": 1, "showroom_name": 1, "converted_at": 1,
            "converted_to_invoice": 1, "converted_to_invoice_id": 1,
        }},
    ]
    quotes = await db.quotations.aggregate(quote_pipeline).to_list(length=50000)

    invoice_pipeline = [
        {"$match": {
            "order_type": "Special Order",
            "$or": [
                {"created_at": {"$gte": prev_start, "$lte": prev_end}},
                {"created_at": {"$gte": prev_start.isoformat(), "$lte": prev_end.isoformat()}},
            ]
        }},
        {"$project": {
            "_id": 0, "created_by_user_id": 1, "created_by": 1, "sales_person": 1,
            "showroom_id": 1, "showroom_name": 1, "grand_total": 1, "total": 1, "total_amount": 1,
        }},
    ]
    invoices = await db.invoices.aggregate(invoice_pipeline).to_list(length=50000)

    staff_map: dict = {}
    for q in quotes:
        uid = (q.get("created_by_user_id") or "").strip()
        sp = (q.get("sales_person") or q.get("created_by") or "").strip()
        key = uid or (f"name:{sp.lower()}" if sp else "")
        if not key:
            continue
        e = staff_map.setdefault(key, {
            "user_key": key,
            "name": sp or "Unknown",
            "showroom_name": q.get("showroom_name") or "Unassigned",
            "quotes_created": 0, "quotes_converted": 0,
            "sales_count": 0, "sales_value_gbp": 0.0,
        })
        e["quotes_created"] += 1
        if q.get("converted_at") or q.get("converted_to_invoice") or q.get("converted_to_invoice_id"):
            e["quotes_converted"] += 1

    for inv in invoices:
        uid = (inv.get("created_by_user_id") or "").strip()
        sp = (inv.get("sales_person") or inv.get("created_by") or "").strip()
        key = uid or (f"name:{sp.lower()}" if sp else "")
        if not key:
            continue
        e = staff_map.setdefault(key, {
            "user_key": key,
            "name": sp or "Unknown",
            "showroom_name": inv.get("showroom_name") or "Unassigned",
            "quotes_created": 0, "quotes_converted": 0,
            "sales_count": 0, "sales_value_gbp": 0.0,
        })
        amount = inv.get("grand_total") or inv.get("total") or inv.get("total_amount") or 0
        try:
            e["sales_value_gbp"] += float(amount)
            e["sales_count"] += 1
        except (TypeError, ValueError):
            pass

    rows = list(staff_map.values())
    for r in rows:
        r["sales_value_gbp"] = round(r["sales_value_gbp"], 2)
        r["conversion_rate"] = (
            round((r["quotes_converted"] / r["quotes_created"]) * 100, 1)
            if r["quotes_created"] > 0 else 0.0
        )
    rows.sort(key=lambda x: (x["quotes_converted"], x["sales_value_gbp"]), reverse=True)
    champion = rows[0] if rows else None
    sales_sorted = sorted(rows, key=lambda x: x["sales_value_gbp"], reverse=True)
    sales_champion = sales_sorted[0] if sales_sorted and sales_sorted[0]["sales_value_gbp"] > 0 else None

    if not rows:
        return {"ok": False, "month": label, "reason": "no_activity"}

    snapshot = {
        "month": label,
        "month_start": prev_start.isoformat(),
        "month_end": prev_end.isoformat(),
        "champion": champion,
        "sales_champion": sales_champion,
        "staff": rows,
        "snapshotted_at": now.isoformat(),
    }
    await db.staff_leaderboard_history.update_one(
        {"month": label},
        {"$set": snapshot},
        upsert=True,
    )
    return {"ok": True, "month": label, "champion": champion}


@router.post("/snapshot-previous-month")
async def trigger_snapshot(current_user: dict = Depends(get_current_user)):
    """Manual trigger for the month-end snapshot. Normally fires
    automatically via the scheduler; useful for backfilling a month
    that the scheduler missed (e.g. server was down on the 1st)."""
    if (current_user or {}).get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Only super admins can trigger a snapshot.")
    return await snapshot_previous_month()

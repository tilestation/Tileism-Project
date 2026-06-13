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


# ---------------------------------------------------------------------
# Rank-change tracking (added 13 Jun 2026 per user request:
# "If anyone goes up the leaderboard show ▲, if anyone goes down ▼").
#
# Strategy: every time the dashboard is rendered we snapshot today's
# ranks into `db.staff_rank_snapshots` (upsert by date). On each
# request we compare TODAY's freshly-computed ranks against the most
# recent PRIOR-day snapshot and attach a `_rank_change` field.
#
# Storage shape — one doc per (date, board):
#   {
#     "date": "2026-06-13",
#     "board": "sales_composite" | "quote_conversions",
#     "ranks": { "<user_key>": 1, ... },
#     "written_at": "<iso ts>",
#   }
# ---------------------------------------------------------------------
async def _load_previous_ranks(board: str, today_iso: str) -> dict:
    """Return {user_key: rank} from the most recent snapshot strictly
    before `today_iso`. Empty dict if no prior data."""
    doc = await get_db().staff_rank_snapshots.find_one(
        {"board": board, "date": {"$lt": today_iso}},
        {"_id": 0, "ranks": 1},
        sort=[("date", -1)],
    )
    return (doc or {}).get("ranks") or {}


async def _save_rank_snapshot(board: str, today_iso: str, ranks: dict) -> None:
    """Upsert today's snapshot. Idempotent — re-running just overwrites
    with the latest state. Tomorrow this becomes 'yesterday' for delta
    calculations."""
    await get_db().staff_rank_snapshots.update_one(
        {"board": board, "date": today_iso},
        {"$set": {
            "board": board,
            "date": today_iso,
            "ranks": ranks,
            "written_at": datetime.now(timezone.utc).isoformat(),
        }},
        upsert=True,
    )


def _compute_ranks(staff: list, sort_key) -> dict:
    """Return {user_key: rank} where rank=1 is best. Ties broken by
    sort order — first staff with equal score keeps the better rank.
    Staff with a zero/falsy score are EXCLUDED from ranking (it's
    misleading to say someone 'moved down' if they have no data).
    """
    scored = [s for s in staff if (sort_key(s) or 0) > 0]
    scored.sort(key=sort_key, reverse=True)
    return {s["user_key"]: i + 1 for i, s in enumerate(scored)}


async def attach_rank_changes_and_snapshot(staff: list) -> None:
    """Mutates `staff` in place: adds `sales_rank_change` and
    `quotes_rank_change` to every entry, then persists today's ranks
    for tomorrow's comparison.

    `*_rank_change` is `prev_rank - curr_rank` — POSITIVE means moved
    UP the table (lower rank number is better), NEGATIVE means dropped,
    0 means stable, None means no prior data (new staff, or first
    day the snapshot has run).
    """
    today_iso = datetime.now(timezone.utc).date().isoformat()

    sales_ranks = _compute_ranks(staff, lambda s: s.get("sales_composite_score") or 0)
    quote_ranks = _compute_ranks(staff, lambda s: s.get("quotes_converted") or 0)

    prev_sales = await _load_previous_ranks("sales_composite", today_iso)
    prev_quotes = await _load_previous_ranks("quote_conversions", today_iso)

    for s in staff:
        uk = s.get("user_key")
        curr_s = sales_ranks.get(uk)
        prev_s = prev_sales.get(uk)
        s["sales_rank_change"] = (prev_s - curr_s) if (curr_s and prev_s) else None
        curr_q = quote_ranks.get(uk)
        prev_q = prev_quotes.get(uk)
        s["quotes_rank_change"] = (prev_q - curr_q) if (curr_q and prev_q) else None

    await _save_rank_snapshot("sales_composite", today_iso, sales_ranks)
    await _save_rank_snapshot("quote_conversions", today_iso, quote_ranks)


async def _compute_weekly_climber(staff: list) -> dict | None:
    """Return the biggest week-on-week climber on the Sales composite
    board — i.e. the staff who rose the most places vs the snapshot
    from ~7 days ago.

    Returns None when:
      - no 7-day-old snapshot exists yet (first 7 days after deploy)
      - the biggest climb is < 2 places (not noteworthy)
      - no staff with positive movement

    Output is a small shape suitable for a 'celebration' callout:
      { user_key, name, showroom_name, places_climbed, current_rank }
    """
    today = datetime.now(timezone.utc).date()
    target_iso = (today - timedelta(days=7)).isoformat()
    # Use the snapshot closest to (but not after) 7 days ago — handles
    # any missed days gracefully.
    doc = await get_db().staff_rank_snapshots.find_one(
        {"board": "sales_composite", "date": {"$lte": target_iso}},
        {"_id": 0, "ranks": 1, "date": 1},
        sort=[("date", -1)],
    )
    if not doc:
        return None
    week_ago_ranks = doc.get("ranks") or {}

    current_ranks = _compute_ranks(staff, lambda s: s.get("sales_composite_score") or 0)
    staff_by_key = {s.get("user_key"): s for s in staff}

    best = None  # (places_climbed, current_rank_asc_tiebreak, payload)
    for uk, curr_rank in current_ranks.items():
        prev_rank = week_ago_ranks.get(uk)
        if not prev_rank:
            continue  # new staff this week — no comparison
        delta = prev_rank - curr_rank
        if delta < 2:
            continue
        s = staff_by_key.get(uk)
        if not s:
            continue
        payload = {
            "user_key": uk,
            "name": s.get("name"),
            "showroom_name": s.get("showroom_name"),
            "places_climbed": delta,
            "current_rank": curr_rank,
            "from_rank": prev_rank,
            "snapshot_date": doc.get("date"),
        }
        # Bigger climb wins; ties broken by who's higher on the board now.
        key = (delta, -curr_rank)
        if best is None or key > best[0]:
            best = (key, payload)
    return best[1] if best else None


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
        # 8 Jun 2026 — Prefer the CANONICAL name from `db.showrooms`
        # over the freetext `showroom_name` stamped on the user doc.
        # Without this, two users at the same physical store can
        # carry drifted labels (e.g. "Tonbridge" vs "Tile Station
        # Tonbridge") and the league table splits them into two
        # rows, halving the store's apparent sales.
        canonical_sname = showroom_name_by_id.get(sid, "") if sid else ""
        user_sname = (u.get("showroom_name") or "").strip()
        sname = canonical_sname or user_sname
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

    def _staff_key(q: dict) -> tuple[str, str, str, str, str]:
        """Return (key, display_name, showroom_id, showroom_name, canonical_uid).

        4 Jun 2026: GROUPING KEY is now `sales_person` (the freeform
        staff name typed into the EPOS form) — NOT the auth user id.
        Many showrooms share a single store login (e.g. one shared
        "Tile Station Gravesend" account that every staff uses), so
        grouping by uid collapses 4 different humans into one row.
        sales_person is the form-typed name on the printed quote —
        the canonical "who actually made this sale" attribution.

        Showroom name + canonical user-id are still resolved via
        the users collection so:
          - the dashboard can still link the row to a staff profile
          - the showroom column shows the right store even when the
            quote/invoice doc doesn't carry showroom_name

        Falls back to user-record name when sales_person is blank
        (rare — EPOS form usually requires it)."""
        uid = (q.get("created_by_user_id") or "").strip()
        sp = (q.get("sales_person") or "").strip()
        cb = (q.get("created_by") or "").strip()
        showroom_id = (q.get("showroom_id") or "").strip()
        # 8 Jun 2026 — Always prefer the CANONICAL store name from
        # `db.showrooms` when the doc has an id. The freetext
        # `showroom_name` stamped on legacy quotes/invoices can drift
        # (e.g. "Tonbridge" vs "Tile Station Tonbridge") and that
        # was splitting one store into two rows on the league table.
        canonical_sname = showroom_name_by_id.get(showroom_id, "") if showroom_id else ""
        stamped_sname = (q.get("showroom_name") or "").strip()
        showroom_name = canonical_sname or stamped_sname

        # Resolve canonical user info (name + showroom) from the
        # users collection — uid first, email fallback, name fallback.
        canonical_key, resolved_name, r_sid, r_sname = _resolve_user(uid, sp, cb)
        if not showroom_id and r_sid:
            showroom_id = r_sid
        if not showroom_name and r_sname:
            showroom_name = r_sname

        # Pick the display name — sales_person wins; otherwise fall
        # back to the user-record name, then the email, then Unknown.
        display_name = sp or resolved_name or cb or "Unknown"
        if not display_name or display_name == "Unknown":
            return ("", "", showroom_id, showroom_name, "")

        # Grouping key is the display name lowercased — that's how
        # multiple staff sharing one auth account each get their own
        # leaderboard row.
        key = f"sp:{display_name.lower()}"
        # canonical_uid is only kept when it doesn't start with the
        # email:/name: fallback prefixes.
        canonical_uid = canonical_key if canonical_key and not canonical_key.startswith(("email:", "name:")) else ""
        return (key, display_name, showroom_id, showroom_name, canonical_uid)

    for q in quotes:
        key, name, showroom_id, showroom_name, canonical_uid = _staff_key(q)
        if not key:
            continue
        entry = staff_map.setdefault(key, {
            "user_id": canonical_uid or None,
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
        # Promote canonical uid if we have one and the entry doesn't.
        if canonical_uid and not entry.get("user_id"):
            entry["user_id"] = canonical_uid
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
                "gross_total": 1,
                "total": 1,
                "grand_total": 1,
                "total_amount": 1,
                "subtotal": 1,
                "created_at": 1,
            }
        },
    ]).to_list(length=20000)

    for inv in invoices:
        key, name, showroom_id, showroom_name, canonical_uid = _staff_key(inv)
        if not key:
            continue
        entry = staff_map.setdefault(key, {
            "user_id": canonical_uid or None,
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
        if canonical_uid and not entry.get("user_id"):
            entry["user_id"] = canonical_uid
        entry["sales_count"] += 1
        # Invoices store the total as `gross_total`; the other field
        # names are legacy aliases. (4 Jun 2026 fix — sales £ totals
        # on the leaderboard were always 0 because we only checked
        # the alias fields.)
        amount = (
            inv.get("gross_total")
            or inv.get("grand_total")
            or inv.get("total_amount")
            or inv.get("total")
            or inv.get("subtotal")
            or 0
        )
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

    # 6 Jun 2026 — personal sales target.
    # Each staff now races against their OWN store's target (not the
    # aggregate of all stores — which the user found confusing).
    # `personal_sales_target` = that staff's showroom's monthly target.
    # If two staff share a store, they share the target — the
    # leaderboard sorts by % of target contribution.
    targets_by_showroom = await _showroom_targets_for_month()
    for entry in staff_list:
        sid = (entry.get("showroom_id") or "").strip()
        tgt = float(targets_by_showroom.get(sid) or 0)
        entry["personal_sales_target"] = tgt
        entry["personal_pct_of_target"] = (
            round((entry["sales_value_gbp"] / tgt) * 100, 1) if tgt > 0 else 0.0
        )

    # 6 Jun 2026 — composite SALES score.
    # User feedback (in order they were given):
    #  1. "competition needs to be based on targets / ratio out among
    #     all stores" — so VOLUME is measured as % of OWN store target,
    #     not raw £. This makes smaller stores fair against bigger ones.
    #  2. "number of sales are as important — staff put effort even on
    #     small sales" — so count contributes too.
    #  3. "Weight it Volume = 70% and count = 30%".
    #
    # Final formula:
    #   volume_score = (personal_pct_of_target / max_pct_of_target) × 100
    #     ↳ If a staff lacks a store target, fall back to peer-relative
    #       £ vs the top seller's £ so untargeted staff aren't zero-scored.
    #   count_score  = (sales_count / max_count) × 100
    #   composite    = volume × 0.70 + count × 0.30
    #
    # Range 0–100 with rare over-target staff legitimately above 100.
    # Worked example with real production data:
    #   Syed @ Gravesend (£10k of £75k = 13.4% of target, 9 sales)
    #     → volume 100, count 81.8 → composite 94.5
    #   Ali  @ Chingford (£4.5k of £65k = 6.9% of target, 11 sales)
    #     → volume 51.5 (6.9/13.4×100), count 100 → composite 66.1
    #     (was 61.3 under the peer-£-only formula — bumped up because
    #      his smaller store target gives him proportional credit)
    SALES_VOLUME_WEIGHT = 0.70
    SALES_COUNT_WEIGHT = 0.30
    max_sales = max((s["sales_value_gbp"] for s in staff_list), default=0) or 1
    max_count = max((s["sales_count"] for s in staff_list), default=0) or 1
    max_pct_target = max(
        (s["personal_pct_of_target"] for s in staff_list if s.get("personal_sales_target", 0) > 0),
        default=0,
    ) or 1
    for entry in staff_list:
        if entry.get("personal_sales_target", 0) > 0:
            # Target-relative — fair across stores of any size.
            volume_metric = (entry["personal_pct_of_target"] / max_pct_target) * 100
        else:
            # Peer-relative fallback — only triggers for staff whose
            # store has no monthly target set. Keeps them in the
            # ranking instead of zero-scoring them out of it.
            volume_metric = (entry["sales_value_gbp"] / max_sales) * 100
        pct_count = (entry["sales_count"] / max_count) * 100
        entry["sales_composite_score"] = round(
            (volume_metric * SALES_VOLUME_WEIGHT) + (pct_count * SALES_COUNT_WEIGHT), 1
        )

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
    if user_key.startswith("sp:"):
        # 4 Jun 2026 — primary grouping is by sales_person now.
        or_clauses.append({"sales_person": {"$regex": f"^{user_key[3:]}$", "$options": "i"}})
    elif user_key.startswith("name:"):
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
    if user_key.startswith("sp:"):
        or_clauses.append({"sales_person": {"$regex": f"^{user_key[3:]}$", "$options": "i"}})
    elif user_key.startswith("name:"):
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
        key = f"sp:{s['name'].lower()}"
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
    1..N for both quote-conversions and special-order sales.

    4 Jun 2026: opened to every authenticated user (staff included) —
    transparency is the entire point of the leaderboard; gating it
    behind admin made staff unable to see their own standing on
    mobile."""
    board = await _compute_leaderboard(month_only=True)

    # Decorate each staff with personal avg + current streak.
    decorated = []
    for s in board["staff"]:
        key = f"sp:{s['name'].lower()}"
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
    # 4 Jun 2026: read-only — visible to every authenticated user so
    # staff can see their own streak from the mobile dashboard.
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
async def _showroom_targets_for_month() -> dict:
    """Pull the active month's per-showroom `monthly_target` from
    `db.sales_targets` so the leaderboard can rank showrooms by
    PERCENTAGE OF TARGET HIT instead of raw £ sold.

    User request (6 Jun 2026): "Gravesend target £75k, Tonbridge
    target £55k — obviously Gravesend has more customers, so the
    competition needs to be based on targets". Returns a dict
    `{showroom_id: target_amount}` plus a special `_total` key
    summing every set target (used as the Race-to-Target fallback
    when no explicit competition target is set on staff_leaderboard_targets).
    """
    db = get_db()
    now = datetime.now(timezone.utc)
    targets: dict = {}
    total = 0.0
    cursor = db.sales_targets.find(
        {
            "month": now.month,
            "year": now.year,
            # Per-store sales targets only — skip company-level / bonus rows
            "showroom_id": {"$ne": None},
            # `target_type` may legitimately be missing on older docs;
            # only EXCLUDE explicit non-sales types.
            "$or": [
                {"target_type": "sales"},
                {"target_type": {"$exists": False}},
                {"target_type": None},
                {"target_type": ""},
            ],
        },
        {"_id": 0, "showroom_id": 1, "monthly_target": 1},
    )
    async for t in cursor:
        sid = (t.get("showroom_id") or "").strip()
        amt = float(t.get("monthly_target") or 0)
        if sid and amt > 0:
            targets[sid] = amt
            total += amt
    targets["_total"] = total
    return targets


async def _showroom_totals_for_month() -> List[dict]:
    """Aggregate quote_conversions + Special-Order sales per showroom
    for the current month. Each row carries the monthly sales target
    (from `db.sales_targets`) plus a fair-comparison `pct_of_target`
    field so we can rank showrooms by *target achievement*, not
    raw £ Sold.

    Default sort is `pct_of_target` desc (6 Jun 2026 — user request:
    "Tonbridge hitting 63% beats Gravesend hitting 53% even if
    Gravesend's raw £ is higher").

    8 Jun 2026 — Buckets by `showroom_id` (canonical UUID) rather
    than `showroom_name` so drifted label variants ("Tonbridge" vs
    "Tile Station Tonbridge") collapse into one row. The display
    name is sourced from `db.showrooms` and falls back to the first
    non-empty name seen if the id is genuinely missing."""
    board = await _compute_leaderboard(month_only=True)
    targets = await _showroom_targets_for_month()
    # Resolve canonical names {id -> name} so we can label buckets
    # consistently even if stamped names drift.
    db = get_db()
    canonical_names_by_id: dict = {}
    async for sr in db.showrooms.find({}, {"name": 1}):
        sid = str(sr.get("_id") or "")
        nm = (sr.get("name") or "").strip()
        if sid and nm:
            canonical_names_by_id[sid] = nm

    by_room: dict = {}
    for s in board["staff"]:
        sid = (s.get("showroom_id") or "").strip()
        # Bucket key: prefer the stable id; fall back to the lowercased
        # name when id is genuinely absent (legacy data only). Unassigned
        # rows still group together under the "unassigned" key.
        key = f"id:{sid}" if sid else f"name:{(s.get('showroom_name') or 'Unassigned').strip().lower()}"
        display = canonical_names_by_id.get(sid) or s.get("showroom_name") or "Unassigned"
        bucket = by_room.setdefault(key, {
            "showroom_name": display,
            "showroom_id": sid or None,
            "quotes_created": 0,
            "quotes_converted": 0,
            "sales_count": 0,
            "sales_value_gbp": 0.0,
            "staff_count": 0,
        })
        # If the first staff in this bucket had a drifted name but
        # a later one carries the canonical, upgrade the display.
        if canonical_names_by_id.get(sid) and bucket["showroom_name"] != canonical_names_by_id[sid]:
            bucket["showroom_name"] = canonical_names_by_id[sid]
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
        # Per-store monthly target
        sid = (r.get("showroom_id") or "").strip()
        target = float(targets.get(sid) or 0)
        r["monthly_target"] = target
        # Fair-comparison metric: % of monthly target hit.
        # Rounded to one decimal. 0 (not None) when target unset so
        # the frontend never sees null vs 0 inconsistency.
        r["pct_of_target"] = (
            round((r["sales_value_gbp"] / target) * 100, 1)
            if target > 0 else 0.0
        )
        r["remaining_to_target"] = round(max(target - r["sales_value_gbp"], 0), 2)
    # Rank by % of target hit (fair). Tie-break by raw £ so two
    # showrooms with the same % don't shuffle randomly.
    rooms.sort(key=lambda x: (x["pct_of_target"], x["sales_value_gbp"]), reverse=True)
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


@router.get("/staff/{user_key:path}/recent")
async def get_staff_recent_activity(
    user_key: str,
    limit: int = 5,
    current_user: dict = Depends(get_current_user),
):
    """Audit-trail drawer for a single staff member (6 Jun 2026).

    Returns this-month's recent quotes + invoices for the staff row
    the admin just clicked on the leaderboard, so they can verify
    e.g. "Syed's £9,607 — show me the 4 invoices".

    `user_key` follows the same grouping convention as the
    leaderboard rows:
      • `sp:<sales_person.lower()>`   ← primary (form-typed name)
      • `name:<sales_person.lower()>` ← legacy
      • `email:<created_by.lower()>`  ← legacy
      • `<uid>`                       ← legacy

    Builds a multi-stamp OR-clause via the users collection so
    legacy quotes stamped only with `created_by` (email) still
    surface — same logic _compute_streak uses.
    """
    db = get_db()
    month_start, _, _ = _month_window_utc()

    # Build the multi-stamp matcher
    or_clauses: list = []
    if user_key.startswith("sp:"):
        # %-escape the name so regex specials in display names (rare
        # but possible — "O'Brien") don't blow up.
        import re as _re
        escaped = _re.escape(user_key[3:])
        or_clauses.append({"sales_person": {"$regex": f"^{escaped}$", "$options": "i"}})
    elif user_key.startswith("name:"):
        import re as _re
        or_clauses.append({"sales_person": {"$regex": f"^{_re.escape(user_key[5:])}$", "$options": "i"}})
    elif user_key.startswith("email:"):
        import re as _re
        or_clauses.append({"created_by": {"$regex": f"^{_re.escape(user_key[6:])}$", "$options": "i"}})
    else:
        u = await db.users.find_one(
            {"id": user_key},
            {"_id": 0, "email": 1, "name": 1},
        )
        or_clauses.append({"created_by_user_id": user_key})
        if u:
            import re as _re
            if u.get("email"):
                or_clauses.append({"created_by": {"$regex": f"^{_re.escape(u['email'])}$", "$options": "i"}})
            if u.get("name"):
                or_clauses.append({"sales_person": {"$regex": f"^{_re.escape(u['name'])}$", "$options": "i"}})

    if not or_clauses:
        return {"quotes": [], "invoices": [], "total_quotes": 0, "total_invoices": 0}

    # Cap limit to a sane range so the drawer stays snappy
    limit = max(1, min(int(limit or 5), 25))

    month_match: dict = {
        "$and": [
            {"$or": or_clauses},
            {"$or": [
                {"created_at": {"$gte": month_start}},
                {"created_at": {"$gte": month_start.isoformat()}},
            ]},
        ],
    }

    # --- Quotes (this month) ---
    quote_cursor = db.quotations.find(
        month_match,
        {
            "_id": 0,
            "id": 1,
            "quotation_no": 1,
            "customer_name": 1,
            "gross_total": 1,
            "total": 1,
            "subtotal": 1,
            "showroom_name": 1,
            "status": 1,
            "created_at": 1,
            "converted_at": 1,
            "converted_to_invoice_id": 1,
        },
    ).sort("created_at", -1).limit(limit)
    quotes_rows = await quote_cursor.to_list(length=limit)

    quote_results = []
    for q in quotes_rows:
        amount = q.get("gross_total") or q.get("total") or q.get("subtotal") or 0
        is_converted = bool(
            q.get("converted_at")
            or q.get("converted_to_invoice_id")
            or q.get("status") == "converted",
        )
        quote_results.append({
            "id": q.get("id"),
            "quotation_no": q.get("quotation_no"),
            "customer_name": q.get("customer_name") or "—",
            "showroom_name": q.get("showroom_name"),
            "total": float(amount) if amount else 0.0,
            "status": q.get("status", "active"),
            "converted": is_converted,
            "created_at": q.get("created_at"),
            "converted_at": q.get("converted_at"),
        })

    # --- Invoices (this month, ONLY Special Orders to match the
    #     leaderboard's £ Sold column) ---
    invoice_match: dict = {
        "$and": [
            {"$or": or_clauses},
            {"order_type": "Special Order"},
            {"$or": [
                {"created_at": {"$gte": month_start}},
                {"created_at": {"$gte": month_start.isoformat()}},
            ]},
        ],
    }
    invoice_cursor = db.invoices.find(
        invoice_match,
        {
            "_id": 0,
            "id": 1,
            "invoice_no": 1,
            "customer_name": 1,
            "gross_total": 1,
            "total": 1,
            "grand_total": 1,
            "total_amount": 1,
            "subtotal": 1,
            "showroom_name": 1,
            "order_type": 1,
            "created_at": 1,
        },
    ).sort("created_at", -1).limit(limit)
    invoice_rows = await invoice_cursor.to_list(length=limit)

    invoice_results = []
    for inv in invoice_rows:
        amount = (
            inv.get("gross_total")
            or inv.get("grand_total")
            or inv.get("total_amount")
            or inv.get("total")
            or inv.get("subtotal")
            or 0
        )
        invoice_results.append({
            "id": inv.get("id"),
            "invoice_no": inv.get("invoice_no"),
            "customer_name": inv.get("customer_name") or "—",
            "showroom_name": inv.get("showroom_name"),
            "total": float(amount) if amount else 0.0,
            "order_type": inv.get("order_type", "Special Order"),
            "created_at": inv.get("created_at"),
        })

    # Totals for the drawer header — count ALL quotes / invoices
    # this month, not just the slice we returned, so the admin can
    # see "showing 5 of 12" hint.
    total_quotes = await db.quotations.count_documents(month_match)
    total_invoices = await db.invoices.count_documents(invoice_match)

    return {
        "quotes": quote_results,
        "invoices": invoice_results,
        "total_quotes": total_quotes,
        "total_invoices": total_invoices,
    }


@router.get("/competition")
async def get_competition_dashboard(
    current_user: dict = Depends(get_current_user),
):
    """One-shot endpoint that returns every section of the
    Competition dashboard. Cheaper than 6 separate calls + means
    the dashboard renders in a single network round-trip.

    4 Jun 2026: opened to every authenticated user (staff included)
    — staff couldn't see the dashboard on mobile because of the
    admin gate. The data is already public-by-design (the page is
    a leaderboard) and the mutating endpoints (set target,
    broadcast highlight, snapshot) keep their own role checks."""

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
        key = f"sp:{s['name'].lower()}"
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
    target_source = "competition" if target_value is not None else "none"

    # 6 Jun 2026 — TWO separate progress arrays so the UI can render
    # clearly distinct "Race to SALES target" and "Race to QUOTE-WIN
    # target" sections (user feedback: "Targets are looking all
    # mixed up Quotes and Sales — can you organise them in proper
    # two different sections").
    #
    # `progress_sales`        — every staff's £ progress vs THEIR
    #                            store's monthly_target. No aggregate;
    #                            staff at different stores have
    #                            different targets. Empty rows
    #                            (no store target set) carry tgt=0.
    # `progress_conversions`  — every staff's quote-conversion count
    #                            vs the optional team target set on
    #                            /admin/star-staff (count-based).
    #                            Only populated when an explicit
    #                            team_target with metric=conversions
    #                            is set — derived targets here are
    #                            meaningless.
    # `progress` (legacy)     — kept for back-compat; mirrors whichever
    #                            of the two has data, prefers sales.
    progress_sales: List[dict] = []
    for s in decorated:
        tgt = float(s.get("personal_sales_target") or 0)
        if tgt <= 0:
            continue  # No store target set → skip from the race
        current = s["sales_value_gbp"]
        projected = await _projection_at_pace(current, days_elapsed, total_days)
        progress_sales.append({
            **s,
            "current": current,
            "target": tgt,
            "pct": min(200, round((current / tgt) * 100, 1)),  # cap at 200% for chart sanity
            "projected_eom": projected,
            "on_track": projected >= tgt,
        })
    # Sort by % of target DESC so the leader is at the top of the race.
    progress_sales.sort(key=lambda x: x["pct"], reverse=True)

    progress_conversions: List[dict] = []
    if target_value is not None and target_metric == "conversions":
        for s in decorated:
            current = s["quotes_converted"]
            projected = await _projection_at_pace(current, days_elapsed, total_days)
            progress_conversions.append({
                **s,
                "current": current,
                "target": float(target_value),
                "pct": min(200, round((current / float(target_value)) * 100, 1)),
                "projected_eom": projected,
                "on_track": projected >= float(target_value),
            })
        progress_conversions.sort(key=lambda x: x["pct"], reverse=True)

    # Back-compat single `progress` array (older clients during deploy
    # window). Prefers sales since that's the primary view now.
    progress = progress_sales or progress_conversions

    # ---- Section 2: Top-3 head-to-head trio
    h2h = decorated[:3]

    # ---- Section 3: Showroom vs Showroom
    showrooms = await _showroom_totals_for_month()
    showroom_winners = {}
    if showrooms:
        # 6 Jun 2026 — winners block. "conversions" now correctly
        # picks the most wins (was wrongly using showrooms[0] which
        # used to be conversions-sorted, but is now pct_of_target-sorted).
        showroom_winners["conversions"] = max(showrooms, key=lambda r: r["quotes_converted"])
        showroom_winners["sales_gbp"] = max(showrooms, key=lambda r: r["sales_value_gbp"])
        rate_eligible = [r for r in showrooms if r["quotes_created"] >= 5]
        showroom_winners["conversion_rate"] = (
            max(rate_eligible, key=lambda r: r["conversion_rate"]) if rate_eligible else None
        )
        # Fair-comparison winner — highest % of monthly target hit.
        # Only includes showrooms that ACTUALLY have a target set
        # (otherwise zero-target stores would tie at 0% and the
        # winner would be picked arbitrarily).
        target_eligible = [r for r in showrooms if (r.get("monthly_target") or 0) > 0]
        if target_eligible:
            showroom_winners["pct_of_target"] = max(target_eligible, key=lambda r: r["pct_of_target"])

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

    # 13 Jun 2026 — Attach rank-movement deltas. Compares today's
    # composite-score / conversions ranking against the most recent
    # prior-day snapshot, then writes today's snapshot for tomorrow.
    await attach_rank_changes_and_snapshot(decorated)

    # 13 Jun 2026 — Biggest weekly climber callout. Computed AFTER
    # the snapshot write so the comparison reads the older 7-day-old
    # snapshot (not the one we just wrote).
    weekly_climber = await _compute_weekly_climber(decorated)

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
            # 6 Jun 2026 — `source` lets the UI tell the user where
            # the target came from. "competition" = explicit team
            # target set on /admin/star-staff; "sales_targets_sum"
            # = auto-computed from the per-store sales_targets they
            # already manage on the analytics dashboard.
            "source": target_source,
        },
        "progress": progress,
        # 6 Jun 2026 — split races: sales (per-store target) +
        # conversions (optional team target). Frontend renders these
        # as TWO clearly-separated sections so staff stop seeing
        # "your target is £195k" when their actual target is £75k.
        "progress_sales": progress_sales,
        "progress_conversions": progress_conversions,
        # 6 Jun 2026 — `progress` is populated ONLY when a team target
        # is set; the frontend Sales/Conversion leaderboard tables
        # need the FULL staff list regardless. Expose `staff` so the
        # tables stop showing "No Special-Order sales yet this month."
        # when the data clearly exists (head_to_head shows £9,607
        # while the table reads empty). Same data, no extra DB hit.
        "staff": decorated,
        "head_to_head": h2h,
        "showrooms": showrooms,
        "showroom_winners": showroom_winners,
        "active_streaks": active_streaks,
        "personal_best_chasers": pb_chasers,
        "comebacks": comebacks,
        "active_highlight": highlight,
        "weekly_climber": weekly_climber,
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
    June 2026 per user direction — no backfill of older months.

    4 Jun 2026: opened to all authenticated users (staff included)."""
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
            "showroom_id": 1, "showroom_name": 1,
            "gross_total": 1, "grand_total": 1, "total": 1, "total_amount": 1, "subtotal": 1,
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
        amount = (
            inv.get("gross_total")
            or inv.get("grand_total")
            or inv.get("total_amount")
            or inv.get("total")
            or inv.get("subtotal")
            or 0
        )
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

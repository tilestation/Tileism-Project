"""
Owner Monthly Digest (13 Jun 2026).

Fires on the 1st of each month (or whatever day the schedule says) and
sends a single Telegram message summarising what happened last month —
sales £, petty cash spend, accountant emails delivered, alerts needing
attention. Designed to be the only notification the owner actually
needs to read on the morning of the 1st.

User request: "Add a monthly Telegram digest for the owner — same
cadence as the auto-exports, showing 'Last month's totals: £X sales,
£Y petty cash, Z accountant emails delivered, N alerts that need
attention'."

Driven by the same `auto_export_schedules` collection (kind=
'owner_digest', scope='global') the invoice + petty-cash auto-exports
use, so the hourly cron in `server.py::_auto_exports_cron_loop` already
fires it without any new wiring.
"""
import logging
from calendar import monthrange
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)


def _month_bounds(year: int, month: int):
    """Inclusive start, exclusive end as both ISO strings (matching the
    way `invoices.created_at` etc. are stored) AND datetime objects
    (matching `petty_cash.created_at` which is a real datetime)."""
    start_dt = datetime(year, month, 1, tzinfo=timezone.utc)
    if month == 12:
        end_dt = datetime(year + 1, 1, 1, tzinfo=timezone.utc)
    else:
        end_dt = datetime(year, month + 1, 1, tzinfo=timezone.utc)
    return start_dt, end_dt, start_dt.isoformat(), end_dt.isoformat()


async def assemble_monthly_digest(year: int, month: int) -> dict:
    """Read everything we care about for the (year, month) window and
    return a compact dict the formatter turns into Telegram HTML.

    All queries are read-only — calling this twice is idempotent. Each
    sub-query is wrapped in try/except so one slow / missing collection
    can't take the whole digest down.
    """
    from config import get_db  # noqa: PLC0415
    db = get_db()
    start_dt, end_dt, start_iso, end_iso = _month_bounds(year, month)
    month_label = datetime(year, month, 1).strftime("%B %Y")

    summary: dict = {
        "year": year, "month": month, "month_label": month_label,
        "sales": {"count": 0, "total_gbp": 0.0, "by_showroom": []},
        "quotations": {"created": 0, "converted": 0, "conversion_rate": 0.0},
        "petty_cash": {"count": 0, "total_gbp": 0.0, "by_showroom": []},
        "auto_exports": {"sent_ok": 0, "sent_failed": 0, "schedules": []},
        "alerts": {"client_errors_30d": 0, "failed_schedules": 0},
        "top_staff": None,
    }

    # ─── Sales (invoices) ───────────────────────────────────────────
    try:
        # invoices.created_at is stored as ISO string (see Store
        # Dashboard) — string range comparison works because ISO 8601
        # sorts lexicographically.
        inv_cursor = db.invoices.find(
            {"created_at": {"$gte": start_iso, "$lt": end_iso}},
            {"_id": 0, "gross_total": 1, "showroom_id": 1},
        )
        sales_total = 0.0
        sales_count = 0
        per_showroom: dict = {}
        async for inv in inv_cursor:
            amt = float(inv.get("gross_total") or 0)
            sales_total += amt
            sales_count += 1
            sr = inv.get("showroom_id") or "unknown"
            per_showroom[sr] = round(per_showroom.get(sr, 0.0) + amt, 2)
        summary["sales"]["count"] = sales_count
        summary["sales"]["total_gbp"] = round(sales_total, 2)
        # Resolve showroom names for the breakdown (top 5 only)
        if per_showroom:
            ids = list(per_showroom.keys())
            name_map: dict = {}
            async for sr in db.showrooms.find({"id": {"$in": ids}}, {"_id": 0, "id": 1, "name": 1}):
                name_map[sr["id"]] = sr.get("name") or sr["id"]
            ranked = sorted(per_showroom.items(), key=lambda kv: kv[1], reverse=True)[:5]
            summary["sales"]["by_showroom"] = [
                {"name": name_map.get(sid, sid), "total_gbp": amt}
                for sid, amt in ranked
            ]
    except Exception:
        logger.exception("owner-digest: sales query failed")

    # ─── Quotations ─────────────────────────────────────────────────
    try:
        quotes_created = await db.quotations.count_documents({
            "created_at": {"$gte": start_iso, "$lt": end_iso},
        })
        quotes_converted = await db.quotations.count_documents({
            "created_at": {"$gte": start_iso, "$lt": end_iso},
            "status": {"$in": ["converted", "invoiced", "completed"]},
        })
        summary["quotations"]["created"] = quotes_created
        summary["quotations"]["converted"] = quotes_converted
        summary["quotations"]["conversion_rate"] = round(
            (quotes_converted / quotes_created * 100) if quotes_created else 0.0, 1,
        )
    except Exception:
        logger.exception("owner-digest: quotations query failed")

    # ─── Petty cash (uses datetime, not ISO string) ─────────────────
    try:
        pc_cursor = db.petty_cash.find(
            {"created_at": {"$gte": start_dt, "$lt": end_dt}},
            {"_id": 0, "amount": 1, "showroom_id": 1},
        )
        pc_total = 0.0
        pc_count = 0
        pc_per_showroom: dict = {}
        async for pc in pc_cursor:
            amt = float(pc.get("amount") or 0)
            pc_total += amt
            pc_count += 1
            sr = pc.get("showroom_id") or "unknown"
            pc_per_showroom[sr] = round(pc_per_showroom.get(sr, 0.0) + amt, 2)
        summary["petty_cash"]["count"] = pc_count
        summary["petty_cash"]["total_gbp"] = round(pc_total, 2)
        if pc_per_showroom:
            ids = list(pc_per_showroom.keys())
            name_map = {}
            async for sr in db.showrooms.find({"id": {"$in": ids}}, {"_id": 0, "id": 1, "name": 1}):
                name_map[sr["id"]] = sr.get("name") or sr["id"]
            ranked = sorted(pc_per_showroom.items(), key=lambda kv: kv[1], reverse=True)
            summary["petty_cash"]["by_showroom"] = [
                {"name": name_map.get(sid, sid), "total_gbp": amt}
                for sid, amt in ranked
            ]
    except Exception:
        logger.exception("owner-digest: petty_cash query failed")

    # ─── Auto-export schedules ──────────────────────────────────────
    try:
        # We treat 'last_sent_at within this calendar month' as 'sent
        # this cycle'. ISO string prefix match — same trick as the cron.
        month_key = f"{year:04d}-{month:02d}"
        sent_ok = 0
        sent_failed = 0
        rows = []
        async for sched in db.auto_export_schedules.find({}, {"_id": 0}):
            if sched.get("kind") == "owner_digest":
                continue  # don't report on ourselves
            last_at = (sched.get("last_sent_at") or "")[:7]
            status = sched.get("last_sent_status")
            if last_at == month_key and status == "ok":
                sent_ok += 1
            if status == "failed":
                sent_failed += 1
            rows.append({
                "kind": sched.get("kind"),
                "scope": sched.get("scope"),
                "enabled": sched.get("enabled", False),
                "last_sent_at": sched.get("last_sent_at"),
                "last_sent_status": status,
            })
        summary["auto_exports"]["sent_ok"] = sent_ok
        summary["auto_exports"]["sent_failed"] = sent_failed
        summary["auto_exports"]["schedules"] = rows
    except Exception:
        logger.exception("owner-digest: auto_export_schedules query failed")

    # ─── Alerts to triage ───────────────────────────────────────────
    try:
        from datetime import timedelta  # noqa: PLC0415
        thirty_ago = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
        summary["alerts"]["client_errors_30d"] = await db.client_errors.count_documents({
            "created_at": {"$gte": thirty_ago},
        })
    except Exception:
        logger.exception("owner-digest: client_errors query failed")
    summary["alerts"]["failed_schedules"] = summary["auto_exports"]["sent_failed"]

    # ─── Top staff (by sales £ for the month) ───────────────────────
    try:
        # Cheap: reuse staff_leaderboard data if it's there, else skip.
        snap = await db.staff_leaderboard_snapshots.find_one(
            {"year": year, "month": month}, {"_id": 0},
            sort=[("created_at", -1)],
        )
        if snap and snap.get("staff"):
            top = max(snap["staff"], key=lambda s: float(s.get("sales_value_gbp") or 0))
            if (top.get("sales_value_gbp") or 0) > 0:
                summary["top_staff"] = {
                    "name": top.get("name"),
                    "sales_value_gbp": round(float(top.get("sales_value_gbp") or 0), 2),
                    "showroom_name": top.get("showroom_name"),
                }
    except Exception:
        logger.exception("owner-digest: top_staff lookup failed (non-fatal)")

    return summary


def format_telegram_html(summary: dict) -> str:
    """Compact, scannable, single-screen-tall Telegram HTML — most
    important numbers first, breakdowns indented after."""
    def gbp(n):
        return f"£{n:,.2f}"

    s = summary
    sales = s.get("sales", {})
    quotes = s.get("quotations", {})
    pc = s.get("petty_cash", {})
    ax = s.get("auto_exports", {})
    al = s.get("alerts", {})
    ts = s.get("top_staff")

    lines = [
        f"📊 <b>Tile Station — {s['month_label']} recap</b>",
        "",
        f"💰 <b>Sales:</b> {gbp(sales.get('total_gbp', 0))} from {sales.get('count', 0)} invoice(s)",
    ]
    if sales.get("by_showroom"):
        # Top 3 showrooms shown inline
        for row in sales["by_showroom"][:3]:
            lines.append(f"   • {row['name']} — {gbp(row['total_gbp'])}")
    lines.append(
        f"📝 <b>Quotes:</b> {quotes.get('converted', 0)} won / "
        f"{quotes.get('created', 0)} created "
        f"({quotes.get('conversion_rate', 0)}%)"
    )
    lines.append(
        f"💸 <b>Petty cash:</b> {gbp(pc.get('total_gbp', 0))} across "
        f"{pc.get('count', 0)} receipt(s)"
    )
    if pc.get("by_showroom"):
        for row in pc["by_showroom"][:3]:
            lines.append(f"   • {row['name']} — {gbp(row['total_gbp'])}")
    lines.append("")
    lines.append(
        f"📧 <b>Accountant emails:</b> {ax.get('sent_ok', 0)} delivered this cycle"
    )
    if ts:
        lines.append(
            f"🏆 <b>Top staff:</b> {ts['name']} — {gbp(ts['sales_value_gbp'])}"
            + (f" ({ts['showroom_name']})" if ts.get("showroom_name") else "")
        )
    # ── Attention section — only render if something actually needs eyes
    attention_bits = []
    if al.get("failed_schedules"):
        attention_bits.append(f"{al['failed_schedules']} failed auto-export(s)")
    if al.get("client_errors_30d", 0) >= 20:
        attention_bits.append(f"{al['client_errors_30d']} customer errors in last 30d")
    if attention_bits:
        lines.append("")
        lines.append("⚠️ <b>Needs attention:</b> " + ", ".join(attention_bits))

    lines.append("")
    lines.append("<i>Auto-generated · disable in Auto-Exports admin</i>")
    return "\n".join(lines)


async def run_owner_monthly_digest_job(
    year: int,
    month: int,
    schedule_id: Optional[str] = None,
    chat_ids_override: Optional[list] = None,
) -> None:
    """Build the digest for (year, month) and send it via Telegram.

    Honours the global Telegram config (bot_token + default chat_ids
    from `notification_settings.telegram`) unless `chat_ids_override` is
    provided (used by the optional UI's per-schedule recipients box).

    Writes status to the schedule doc via `mark_schedule_result` so the
    UI's "Last sent" line stays fresh.
    """
    from routes.auto_exports import mark_schedule_result  # noqa: PLC0415
    from services.telegram_notify import send_telegram, get_config  # noqa: PLC0415

    try:
        summary = await assemble_monthly_digest(year, month)
        html = format_telegram_html(summary)
        cfg = await get_config()
        chat_ids = chat_ids_override or cfg.get("chat_ids") or []
        if not chat_ids:
            note = "Telegram not configured (no chat_ids) — digest assembled but not sent."
            logger.warning("owner-digest: %s", note)
            if schedule_id:
                await mark_schedule_result(schedule_id, status="failed", note=note)
            return
        result = await send_telegram(html, chat_ids=chat_ids)
        if result.get("sent"):
            status = "ok" if not result.get("errors") else "partial"
            note = (
                f"{summary['month_label']} digest sent to "
                f"{result['sent']} chat(s)"
                + (f" (errors: {len(result['errors'])})" if result.get('errors') else "")
            )
            if schedule_id:
                await mark_schedule_result(schedule_id, status=status, note=note)
        else:
            err = (result.get("errors") or ["unknown"])[0]
            if schedule_id:
                await mark_schedule_result(
                    schedule_id, status="failed",
                    note=f"Telegram refused all sends: {err}",
                )
    except Exception as exc:  # noqa: BLE001
        logger.exception("owner-digest: job crashed")
        if schedule_id:
            await mark_schedule_result(
                schedule_id, status="failed",
                note=f"Crash: {type(exc).__name__}: {str(exc)[:200]}",
            )
        raise

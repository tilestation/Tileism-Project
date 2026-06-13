"""
Tests for the Owner Monthly Telegram Digest (13 Jun 2026).
"""
import os
import asyncio
from datetime import datetime, timezone, timedelta
from unittest.mock import patch, AsyncMock, MagicMock

import pytest


@pytest.fixture(autouse=True)
def _env_setup():
    os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
    os.environ.setdefault("DB_NAME", "test_owner_digest")


class _AsyncIter:
    """Mimic motor async cursor: `async for x in db.foo.find(...)`."""
    def __init__(self, items): self._items = list(items)
    def __aiter__(self): self._iter = iter(self._items); return self
    async def __anext__(self):
        try: return next(self._iter)
        except StopIteration as e: raise StopAsyncIteration from e


def _db_stub(*, invoices=None, quotations_created=0, quotations_converted=0,
             petty_cash=None, showrooms=None, schedules=None,
             snapshot=None, client_errors=0):
    db = MagicMock()
    db.invoices.find = MagicMock(return_value=_AsyncIter(invoices or []))
    db.quotations.count_documents = AsyncMock(side_effect=[quotations_created, quotations_converted])
    db.petty_cash.find = MagicMock(return_value=_AsyncIter(petty_cash or []))
    db.showrooms.find = MagicMock(return_value=_AsyncIter(showrooms or []))
    db.auto_export_schedules.find = MagicMock(return_value=_AsyncIter(schedules or []))
    db.staff_leaderboard_snapshots.find_one = AsyncMock(return_value=snapshot)
    db.client_errors.count_documents = AsyncMock(return_value=client_errors)
    return db


# ---------------------------------------------------------------------
# assemble_monthly_digest
# ---------------------------------------------------------------------
def test_assemble_aggregates_sales_quotes_petty_cash_and_top_staff():
    from services.owner_monthly_digest import assemble_monthly_digest
    invoices = [
        {"gross_total": 1200.50, "showroom_id": "sr-tonbridge"},
        {"gross_total": 850.00,  "showroom_id": "sr-tonbridge"},
        {"gross_total": 2300.75, "showroom_id": "sr-chingford"},
    ]
    petty = [
        {"amount": 12.50, "showroom_id": "sr-tonbridge"},
        {"amount":  6.00, "showroom_id": "sr-tonbridge"},
        {"amount": 25.00, "showroom_id": "sr-chingford"},
    ]
    showrooms = [
        {"id": "sr-tonbridge",  "name": "Tonbridge"},
        {"id": "sr-chingford",  "name": "Chingford"},
    ]
    schedules = [
        {"kind": "invoices", "scope": "all", "enabled": True,
         "last_sent_at": "2026-05-01T08:00:00+00:00", "last_sent_status": "ok"},
        {"kind": "petty_cash", "scope": "sr-tonbridge", "enabled": True,
         "last_sent_at": "2026-05-01T08:01:00+00:00", "last_sent_status": "ok"},
        {"kind": "petty_cash", "scope": "sr-chingford", "enabled": True,
         "last_sent_at": "2026-04-15T08:00:00+00:00", "last_sent_status": "failed"},
    ]
    snapshot = {
        "year": 2026, "month": 5,
        "staff": [
            {"name": "Mia",  "sales_value_gbp": 4500.00, "showroom_name": "Tonbridge"},
            {"name": "John", "sales_value_gbp": 2300.75, "showroom_name": "Chingford"},
        ],
    }
    db = _db_stub(
        invoices=invoices, quotations_created=20, quotations_converted=7,
        petty_cash=petty, showrooms=showrooms * 2,  # consumed twice (sales + petty)
        schedules=schedules, snapshot=snapshot, client_errors=12,
    )
    with patch("config.get_db", return_value=db):
        summary = asyncio.run(assemble_monthly_digest(2026, 5))
    # Sales
    assert summary["sales"]["count"] == 3
    assert summary["sales"]["total_gbp"] == 4351.25
    assert summary["sales"]["by_showroom"][0]["name"] == "Chingford"  # 2300 > 2050
    # Quotations
    assert summary["quotations"]["created"] == 20
    assert summary["quotations"]["converted"] == 7
    assert summary["quotations"]["conversion_rate"] == 35.0
    # Petty cash
    assert summary["petty_cash"]["count"] == 3
    assert summary["petty_cash"]["total_gbp"] == 43.50
    # Auto-exports — only schedules sent THIS calendar month (2026-05) count
    # as "sent_ok". The Tonbridge petty-cash was sent on 2026-04, so it's NOT
    # counted; the Chingford one is "failed".
    assert summary["auto_exports"]["sent_ok"] == 2  # invoices + tonbridge petty cash sent in May
    assert summary["auto_exports"]["sent_failed"] == 1
    # Alerts
    assert summary["alerts"]["client_errors_30d"] == 12
    assert summary["alerts"]["failed_schedules"] == 1
    # Top staff
    assert summary["top_staff"]["name"] == "Mia"
    assert summary["top_staff"]["sales_value_gbp"] == 4500.00


def test_assemble_handles_empty_month_gracefully():
    """No data in the window → all totals zeroed, no crashes."""
    from services.owner_monthly_digest import assemble_monthly_digest
    db = _db_stub(invoices=[], petty_cash=[], showrooms=[], schedules=[])
    with patch("config.get_db", return_value=db):
        summary = asyncio.run(assemble_monthly_digest(2026, 5))
    assert summary["sales"]["count"] == 0
    assert summary["sales"]["total_gbp"] == 0.0
    assert summary["quotations"]["conversion_rate"] == 0.0
    assert summary["petty_cash"]["total_gbp"] == 0.0
    assert summary["top_staff"] is None


def test_assemble_survives_collection_query_crash():
    """If ONE sub-query crashes (e.g. missing collection), the rest of
    the digest still assembles."""
    from services.owner_monthly_digest import assemble_monthly_digest
    db = MagicMock()
    # Sales crashes
    db.invoices.find = MagicMock(side_effect=RuntimeError("collection missing"))
    # Quotations work
    db.quotations.count_documents = AsyncMock(side_effect=[5, 1])
    # Petty cash works (empty)
    db.petty_cash.find = MagicMock(return_value=_AsyncIter([]))
    db.showrooms.find = MagicMock(return_value=_AsyncIter([]))
    db.auto_export_schedules.find = MagicMock(return_value=_AsyncIter([]))
    db.staff_leaderboard_snapshots.find_one = AsyncMock(return_value=None)
    db.client_errors.count_documents = AsyncMock(return_value=0)
    with patch("config.get_db", return_value=db):
        summary = asyncio.run(assemble_monthly_digest(2026, 5))
    # Sales section stayed at defaults (zero)
    assert summary["sales"]["count"] == 0
    # Quotations still populated
    assert summary["quotations"]["created"] == 5


# ---------------------------------------------------------------------
# format_telegram_html
# ---------------------------------------------------------------------
def test_format_renders_compact_html_with_all_sections():
    from services.owner_monthly_digest import format_telegram_html
    summary = {
        "year": 2026, "month": 5, "month_label": "May 2026",
        "sales": {
            "count": 12, "total_gbp": 24567.50,
            "by_showroom": [{"name": "Tonbridge", "total_gbp": 15000.0},
                            {"name": "Chingford", "total_gbp": 9567.50}],
        },
        "quotations": {"created": 30, "converted": 11, "conversion_rate": 36.7},
        "petty_cash": {
            "count": 4, "total_gbp": 43.5,
            "by_showroom": [{"name": "Tonbridge", "total_gbp": 18.5}],
        },
        "auto_exports": {"sent_ok": 2, "sent_failed": 0, "schedules": []},
        "alerts": {"client_errors_30d": 3, "failed_schedules": 0},
        "top_staff": {"name": "Mia", "sales_value_gbp": 12000.0, "showroom_name": "Tonbridge"},
    }
    html = format_telegram_html(summary)
    assert "May 2026 recap" in html
    assert "£24,567.50" in html
    assert "Tonbridge" in html
    assert "11 won / 30 created" in html
    assert "36.7%" in html
    assert "£43.50" in html
    assert "Mia" in html
    assert "£12,000.00" in html
    # No "Needs attention" line when nothing's wrong
    assert "Needs attention" not in html


def test_format_surfaces_attention_section_when_problems():
    from services.owner_monthly_digest import format_telegram_html
    summary = {
        "year": 2026, "month": 5, "month_label": "May 2026",
        "sales": {"count": 0, "total_gbp": 0.0, "by_showroom": []},
        "quotations": {"created": 0, "converted": 0, "conversion_rate": 0.0},
        "petty_cash": {"count": 0, "total_gbp": 0.0, "by_showroom": []},
        "auto_exports": {"sent_ok": 0, "sent_failed": 2, "schedules": []},
        "alerts": {"client_errors_30d": 45, "failed_schedules": 2},
        "top_staff": None,
    }
    html = format_telegram_html(summary)
    assert "Needs attention" in html
    assert "2 failed" in html
    assert "45 customer errors" in html


# ---------------------------------------------------------------------
# run_owner_monthly_digest_job
# ---------------------------------------------------------------------
def test_job_sends_telegram_and_marks_schedule_ok():
    from services.owner_monthly_digest import run_owner_monthly_digest_job
    fake_assemble = AsyncMock(return_value={
        "year": 2026, "month": 5, "month_label": "May 2026",
        "sales": {"count": 1, "total_gbp": 100.0, "by_showroom": []},
        "quotations": {"created": 0, "converted": 0, "conversion_rate": 0.0},
        "petty_cash": {"count": 0, "total_gbp": 0.0, "by_showroom": []},
        "auto_exports": {"sent_ok": 0, "sent_failed": 0, "schedules": []},
        "alerts": {"client_errors_30d": 0, "failed_schedules": 0},
        "top_staff": None,
    })
    fake_send = AsyncMock(return_value={"sent": 1, "errors": []})
    fake_get_cfg = AsyncMock(return_value={"enabled": True, "chat_ids": ["123"]})
    fake_mark = AsyncMock()
    with patch("services.owner_monthly_digest.assemble_monthly_digest", fake_assemble), \
         patch("services.telegram_notify.send_telegram", fake_send), \
         patch("services.telegram_notify.get_config", fake_get_cfg), \
         patch("routes.auto_exports.mark_schedule_result", fake_mark):
        asyncio.run(run_owner_monthly_digest_job(2026, 5, schedule_id="sched-1"))
    fake_send.assert_awaited_once()
    sent_args = fake_send.call_args
    assert "May 2026 recap" in sent_args.args[0]
    assert sent_args.kwargs.get("chat_ids") == ["123"]
    fake_mark.assert_awaited_once()
    assert fake_mark.await_args.kwargs["status"] == "ok"


def test_job_marks_failed_when_telegram_not_configured():
    from services.owner_monthly_digest import run_owner_monthly_digest_job
    fake_assemble = AsyncMock(return_value={
        "month_label": "May 2026",
        "sales": {"count": 0, "total_gbp": 0.0, "by_showroom": []},
        "quotations": {"created": 0, "converted": 0, "conversion_rate": 0.0},
        "petty_cash": {"count": 0, "total_gbp": 0.0, "by_showroom": []},
        "auto_exports": {"sent_ok": 0, "sent_failed": 0, "schedules": []},
        "alerts": {"client_errors_30d": 0, "failed_schedules": 0},
        "top_staff": None,
    })
    fake_send = AsyncMock()
    fake_get_cfg = AsyncMock(return_value={"enabled": False, "chat_ids": []})
    fake_mark = AsyncMock()
    with patch("services.owner_monthly_digest.assemble_monthly_digest", fake_assemble), \
         patch("services.telegram_notify.send_telegram", fake_send), \
         patch("services.telegram_notify.get_config", fake_get_cfg), \
         patch("routes.auto_exports.mark_schedule_result", fake_mark):
        asyncio.run(run_owner_monthly_digest_job(2026, 5, schedule_id="sched-1"))
    # Telegram never called when no chat_ids configured
    fake_send.assert_not_awaited()
    fake_mark.assert_awaited_once()
    assert fake_mark.await_args.kwargs["status"] == "failed"
    assert "Telegram not configured" in fake_mark.await_args.kwargs["note"]


def test_job_respects_chat_ids_override():
    """Per-schedule chat IDs override the global config — useful for
    A/B testing the digest to a single test chat first."""
    from services.owner_monthly_digest import run_owner_monthly_digest_job
    fake_assemble = AsyncMock(return_value={
        "month_label": "May 2026",
        "sales": {"count": 0, "total_gbp": 0.0, "by_showroom": []},
        "quotations": {"created": 0, "converted": 0, "conversion_rate": 0.0},
        "petty_cash": {"count": 0, "total_gbp": 0.0, "by_showroom": []},
        "auto_exports": {"sent_ok": 0, "sent_failed": 0, "schedules": []},
        "alerts": {"client_errors_30d": 0, "failed_schedules": 0},
        "top_staff": None,
    })
    fake_send = AsyncMock(return_value={"sent": 1, "errors": []})
    # Global config says "777"; override should win.
    fake_get_cfg = AsyncMock(return_value={"chat_ids": ["777"]})
    fake_mark = AsyncMock()
    with patch("services.owner_monthly_digest.assemble_monthly_digest", fake_assemble), \
         patch("services.telegram_notify.send_telegram", fake_send), \
         patch("services.telegram_notify.get_config", fake_get_cfg), \
         patch("routes.auto_exports.mark_schedule_result", fake_mark):
        asyncio.run(run_owner_monthly_digest_job(
            2026, 5, schedule_id="sched-1", chat_ids_override=["override-chat"],
        ))
    assert fake_send.call_args.kwargs.get("chat_ids") == ["override-chat"]


# ---------------------------------------------------------------------
# Route-layer changes — owner_digest accepts empty recipients,
# scope is forced to 'global'
# ---------------------------------------------------------------------
def test_route_upsert_owner_digest_accepts_empty_recipients():
    """owner_digest is delivered via Telegram, so the email recipients
    list is optional."""
    from routes.auto_exports import upsert_auto_export, AutoExportScheduleIn
    payload = AutoExportScheduleIn(recipient_emails=[], enabled=True, day_of_month=1)
    db = MagicMock()
    db.auto_export_schedules.find_one = AsyncMock(return_value=None)
    db.auto_export_schedules.insert_one = AsyncMock()
    with patch("routes.auto_exports.get_db", return_value=db):
        out = asyncio.run(upsert_auto_export(
            kind="owner_digest", payload=payload,
            current_user={"role": "super_admin", "email": "q@x"},
        ))
    assert out["kind"] == "owner_digest"
    assert out["scope"] == "global"
    assert out["recipient_emails"] == []


def test_route_upsert_invoice_still_requires_recipients():
    """The empty-recipients carve-out is owner_digest-only — invoice and
    petty_cash schedules still need at least one accountant email."""
    from routes.auto_exports import upsert_auto_export, AutoExportScheduleIn
    from fastapi import HTTPException
    payload = AutoExportScheduleIn(recipient_emails=[])
    db = MagicMock()
    db.auto_export_schedules.find_one = AsyncMock(return_value=None)
    with patch("routes.auto_exports.get_db", return_value=db):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(upsert_auto_export(
                kind="invoices", payload=payload,
                current_user={"role": "super_admin", "email": "q@x"},
            ))
        assert exc.value.status_code == 400
        assert "recipient" in exc.value.detail.lower()

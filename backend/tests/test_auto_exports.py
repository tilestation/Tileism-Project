"""
Tests for the auto-export schedules CRUD + run-now trigger
(13 Jun 2026).
"""
import os
import asyncio
from unittest.mock import patch, AsyncMock, MagicMock

import pytest


@pytest.fixture(autouse=True)
def _env_setup():
    os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
    os.environ.setdefault("DB_NAME", "test_auto_exports")


SUPER = {"role": "super_admin", "email": "qasim@tilestation.co.uk", "name": "Qasim"}
ADMIN = {"role": "admin", "email": "a@b"}
STAFF = {"role": "staff", "email": "s@b"}


def _bt():
    from fastapi import BackgroundTasks
    return BackgroundTasks()


def _db_stub(existing_schedule=None):
    """Build a Mongo-shaped mock that the route code talks to."""
    db = MagicMock()
    # find().sort().to_list() chain
    chain = MagicMock()
    chain.sort = MagicMock(return_value=chain)
    chain.to_list = AsyncMock(return_value=[existing_schedule] if existing_schedule else [])
    db.auto_export_schedules.find = MagicMock(return_value=chain)
    db.auto_export_schedules.find_one = AsyncMock(return_value=existing_schedule)
    db.auto_export_schedules.insert_one = AsyncMock()
    db.auto_export_schedules.update_one = AsyncMock()
    db.auto_export_schedules.delete_one = AsyncMock(return_value=MagicMock(deleted_count=1))
    return db


# ---------------------------------------------------------------------
# Role gates
# ---------------------------------------------------------------------
def test_list_rejects_non_super_admin():
    from routes.auto_exports import list_auto_exports
    from fastapi import HTTPException
    for user in (STAFF, ADMIN, {"role": "manager"}, {}):
        with patch("routes.auto_exports.get_db", return_value=_db_stub()):
            with pytest.raises(HTTPException) as exc:
                asyncio.run(list_auto_exports(current_user=user))
            assert exc.value.status_code == 403


def test_upsert_rejects_non_super_admin():
    from routes.auto_exports import upsert_auto_export, AutoExportScheduleIn
    from fastapi import HTTPException
    payload = AutoExportScheduleIn(recipient_emails=["a@b.com"])
    with patch("routes.auto_exports.get_db", return_value=_db_stub()):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(upsert_auto_export(kind="invoices", payload=payload, current_user=ADMIN))
        assert exc.value.status_code == 403


def test_run_now_rejects_non_super_admin():
    from routes.auto_exports import run_auto_export_now
    from fastapi import HTTPException
    with patch("routes.auto_exports.get_db", return_value=_db_stub({"id": "s1", "kind": "invoices", "scope": "all"})):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(run_auto_export_now(
                schedule_id="s1", payload=None, background_tasks=_bt(), current_user=STAFF,
            ))
        assert exc.value.status_code == 403


# ---------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------
def test_upsert_creates_invoice_schedule_with_scope_all():
    """kind='invoices' forces scope='all' regardless of what the
    caller sent — invoices are a single company-wide stream."""
    from routes.auto_exports import upsert_auto_export, AutoExportScheduleIn
    payload = AutoExportScheduleIn(
        recipient_emails=["accountant@example.com"],
        enabled=True, day_of_month=1,
        scope="should-be-ignored",  # invoices ignore scope
    )
    db = _db_stub(existing_schedule=None)
    with patch("routes.auto_exports.get_db", return_value=db):
        out = asyncio.run(upsert_auto_export(kind="invoices", payload=payload, current_user=SUPER))
    assert out["kind"] == "invoices"
    assert out["scope"] == "all"
    assert out["enabled"] is True
    assert out["day_of_month"] == 1
    assert out["recipient_emails"] == ["accountant@example.com"]
    assert out["created_by"] == SUPER["email"]
    db.auto_export_schedules.insert_one.assert_awaited_once()


def test_upsert_requires_scope_for_petty_cash():
    """petty_cash without a scope is a programmer error — refuse."""
    from routes.auto_exports import upsert_auto_export, AutoExportScheduleIn
    from fastapi import HTTPException
    payload = AutoExportScheduleIn(recipient_emails=["a@b.com"])
    with patch("routes.auto_exports.get_db", return_value=_db_stub()):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(upsert_auto_export(kind="petty_cash", payload=payload, current_user=SUPER))
        assert exc.value.status_code == 400
        assert "scope" in exc.value.detail.lower()


def test_upsert_updates_existing_schedule_preserving_id():
    """Second PUT for the same (kind, scope) reuses the same id and
    updates fields — no duplicate rows."""
    from routes.auto_exports import upsert_auto_export, AutoExportScheduleIn
    existing = {
        "id": "existing-id-123",
        "kind": "petty_cash",
        "scope": "showroom-tonbridge",
        "recipient_emails": ["old@x.com"],
        "enabled": False, "day_of_month": 5,
        "subject": None, "message": None,
        "last_sent_at": "2026-05-01T08:00:00+00:00",
        "last_sent_status": "ok", "last_sent_note": "May 2026 sent",
        "created_by": SUPER["email"],
        "created_at": "2026-04-15T10:00:00+00:00",
        "updated_at": "2026-04-15T10:00:00+00:00",
    }
    db = _db_stub(existing_schedule=existing)
    payload = AutoExportScheduleIn(
        recipient_emails=["new-accountant@x.com"],
        enabled=True, day_of_month=1,
        scope="showroom-tonbridge",
    )
    with patch("routes.auto_exports.get_db", return_value=db):
        out = asyncio.run(upsert_auto_export(kind="petty_cash", payload=payload, current_user=SUPER))
    assert out["id"] == "existing-id-123"
    assert out["recipient_emails"] == ["new-accountant@x.com"]
    assert out["enabled"] is True
    assert out["day_of_month"] == 1
    # Last-sent metadata is preserved across the update
    assert out["last_sent_at"] == "2026-05-01T08:00:00+00:00"
    assert out["last_sent_status"] == "ok"
    db.auto_export_schedules.update_one.assert_awaited_once()
    db.auto_export_schedules.insert_one.assert_not_awaited()


def test_upsert_rejects_unknown_kind():
    from routes.auto_exports import upsert_auto_export, AutoExportScheduleIn
    from fastapi import HTTPException
    payload = AutoExportScheduleIn(recipient_emails=["a@b.com"])
    with patch("routes.auto_exports.get_db", return_value=_db_stub()):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(upsert_auto_export(kind="quotations", payload=payload, current_user=SUPER))
        assert exc.value.status_code == 400


def test_upsert_validates_day_of_month_range():
    """day_of_month is clamped to [1, 28] so it works every Feb."""
    from routes.auto_exports import AutoExportScheduleIn
    from pydantic import ValidationError
    for bad in (0, 29, 31, -1):
        with pytest.raises(ValidationError):
            AutoExportScheduleIn(recipient_emails=["a@b.com"], day_of_month=bad)
    # 1 and 28 are valid
    assert AutoExportScheduleIn(recipient_emails=["a@b.com"], day_of_month=1).day_of_month == 1
    assert AutoExportScheduleIn(recipient_emails=["a@b.com"], day_of_month=28).day_of_month == 28


def test_upsert_rejects_too_many_recipients():
    from routes.auto_exports import AutoExportScheduleIn, MAX_RECIPIENTS
    from pydantic import ValidationError
    too_many = [f"u{i}@x.com" for i in range(MAX_RECIPIENTS + 1)]
    with pytest.raises(ValidationError):
        AutoExportScheduleIn(recipient_emails=too_many)


def test_delete_removes_schedule():
    from routes.auto_exports import delete_auto_export
    db = _db_stub()
    with patch("routes.auto_exports.get_db", return_value=db):
        out = asyncio.run(delete_auto_export(schedule_id="abc", current_user=SUPER))
    assert out["ok"] is True
    db.auto_export_schedules.delete_one.assert_awaited_once_with({"id": "abc"})


def test_delete_returns_404_when_missing():
    from routes.auto_exports import delete_auto_export
    from fastapi import HTTPException
    db = _db_stub()
    db.auto_export_schedules.delete_one = AsyncMock(return_value=MagicMock(deleted_count=0))
    with patch("routes.auto_exports.get_db", return_value=db):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(delete_auto_export(schedule_id="nope", current_user=SUPER))
        assert exc.value.status_code == 404


# ---------------------------------------------------------------------
# Run-now (manual trigger)
# ---------------------------------------------------------------------
def test_run_now_returns_404_when_schedule_missing():
    from routes.auto_exports import run_auto_export_now
    from fastapi import HTTPException
    db = _db_stub(existing_schedule=None)
    with patch("routes.auto_exports.get_db", return_value=db):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(run_auto_export_now(
                schedule_id="nope", payload=None, background_tasks=_bt(), current_user=SUPER,
            ))
        assert exc.value.status_code == 404


def test_run_now_queues_invoice_job_for_previous_month_by_default():
    """No explicit year/month → default to last calendar month."""
    from routes.auto_exports import run_auto_export_now
    sched = {
        "id": "s-inv", "kind": "invoices", "scope": "all",
        "recipient_emails": ["accountant@x.com"],
        "subject": None, "message": None,
    }
    db = _db_stub(existing_schedule=sched)
    bt = _bt()
    with patch("routes.auto_exports.get_db", return_value=db):
        out = asyncio.run(run_auto_export_now(
            schedule_id="s-inv", payload=None, background_tasks=bt, current_user=SUPER,
        ))
    assert out["queued"] is True
    assert out["kind"] == "invoices"
    assert len(bt.tasks) == 1
    assert "Queued" in out["message"]


def test_run_now_queues_petty_cash_job_for_explicit_month():
    from routes.auto_exports import run_auto_export_now, RunNowRequest
    sched = {
        "id": "s-pc", "kind": "petty_cash", "scope": "showroom-1",
        "recipient_emails": ["accountant@x.com"],
        "subject": None, "message": None,
    }
    db = _db_stub(existing_schedule=sched)
    bt = _bt()
    with patch("routes.auto_exports.get_db", return_value=db):
        out = asyncio.run(run_auto_export_now(
            schedule_id="s-pc",
            payload=RunNowRequest(year=2026, month=4),
            background_tasks=bt, current_user=SUPER,
        ))
    assert out["target_year"] == 2026
    assert out["target_month"] == 4
    assert out["kind"] == "petty_cash"
    assert out["scope"] == "showroom-1"
    assert len(bt.tasks) == 1


# ---------------------------------------------------------------------
# Status helper
# ---------------------------------------------------------------------
def test_mark_schedule_result_writes_status_to_db():
    from routes.auto_exports import mark_schedule_result
    db = MagicMock()
    db.auto_export_schedules.update_one = AsyncMock()
    with patch("routes.auto_exports.get_db", return_value=db):
        asyncio.run(mark_schedule_result("sched-id", status="ok", note="all good"))
    db.auto_export_schedules.update_one.assert_awaited_once()
    call = db.auto_export_schedules.update_one.await_args
    assert call.args[0] == {"id": "sched-id"}
    set_ = call.args[1]["$set"]
    assert set_["last_sent_status"] == "ok"
    assert set_["last_sent_note"] == "all good"
    assert "last_sent_at" in set_


def test_mark_schedule_result_swallows_db_errors():
    """Bookkeeping must never break a successful delivery."""
    from routes.auto_exports import mark_schedule_result
    db = MagicMock()
    db.auto_export_schedules.update_one = AsyncMock(side_effect=RuntimeError("mongo down"))
    with patch("routes.auto_exports.get_db", return_value=db):
        # Should NOT raise
        asyncio.run(mark_schedule_result("sched-id", status="ok", note="x"))

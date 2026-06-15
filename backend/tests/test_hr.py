"""
Tests for HR module — employees, leave, documents, time tracking
(13 Jun 2026).

Designed as one file rather than four so the helpers (_db, _user stubs)
stay DRY and the test runner picks them up in one sweep.
"""
import os
import asyncio
import base64
from datetime import date, datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture(autouse=True)
def _env_setup():
    os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
    os.environ.setdefault("DB_NAME", "test_hr")


HR = {"role": "hr_admin", "id": "user-hr", "email": "hr@x.com", "name": "HR"}
SUPER = {"role": "super_admin", "id": "user-su", "email": "su@x.com", "name": "Su"}
STAFF = {"role": "staff", "id": "user-mia", "email": "mia@x.com", "name": "Mia"}
MANAGER = {"role": "manager", "id": "user-mgr", "email": "mgr@x.com", "name": "Mgr"}


class _AsyncIter:
    def __init__(self, items): self._items = list(items)
    def __aiter__(self): self._iter = iter(self._items); return self
    async def __anext__(self):
        try: return next(self._iter)
        except StopIteration as e: raise StopAsyncIteration from e


class _Cursor:
    """Mongo cursor: chainable .sort() then awaitable .to_list() OR
    async-iterable directly."""
    def __init__(self, items): self.items = list(items)
    def sort(self, *a, **k): return self
    async def to_list(self, _n=None): return list(self.items)
    def __aiter__(self): self._iter = iter(self.items); return self
    async def __anext__(self):
        try: return next(self._iter)
        except StopIteration as e: raise StopAsyncIteration from e


def _db(**collections):
    """Build a mock db where each named kwarg is a mongo collection
    whose .find()/.find_one()/etc. should already be wired."""
    db = MagicMock()
    for name, coll in (collections or {}).items():
        setattr(db, name, coll)
    return db


# ─────────────────────────────────────────────────────────────────────
# hr_security
# ─────────────────────────────────────────────────────────────────────
def test_security_encrypt_decrypt_round_trip():
    from services.hr_security import encrypt, decrypt
    secret = "AB123456C"
    enc = encrypt(secret)
    assert enc and enc != secret
    assert decrypt(enc) == secret
    # None / empty handling
    assert encrypt(None) is None
    assert encrypt("") is None
    assert decrypt(None) is None
    assert decrypt("") is None


def test_security_mask_keeps_only_last_n():
    from services.hr_security import mask
    assert mask("AB123456C") == "*****456C"
    assert mask("12345678", 4) == "****5678"
    assert mask("123", 4) == "***"
    assert mask("") == ""
    assert mask(None) == ""


# ─────────────────────────────────────────────────────────────────────
# hr_bank_holidays
# ─────────────────────────────────────────────────────────────────────
def test_working_days_excludes_weekends_and_bank_holidays():
    from services.hr_bank_holidays import working_days_between
    fake_holidays = [
        {"date": "2026-12-25", "name": "Christmas Day"},
        {"date": "2026-12-26", "name": "Boxing Day"},
    ]
    with patch("services.hr_bank_holidays._all_holidays", AsyncMock(return_value=fake_holidays)):
        # Mon 2026-12-21 → Mon 2026-12-28: 8 calendar days, minus
        # weekend (26-27) + 25 + 26 (christmas + boxing — overlaps Sat
        # so net only counts as 25-only), so working days = ?
        # Cal: Mon 21, Tue 22, Wed 23, Thu 24, Fri 25 (holiday), Sat 26
        # (weekend + boxing), Sun 27 (weekend), Mon 28. → 4 working
        # days (21, 22, 23, 24, 28)
        result = asyncio.run(working_days_between(date(2026, 12, 21), date(2026, 12, 28)))
        assert result == 5


def test_working_days_returns_zero_for_inverted_range():
    from services.hr_bank_holidays import working_days_between
    with patch("services.hr_bank_holidays._all_holidays", AsyncMock(return_value=[])):
        assert asyncio.run(working_days_between(date(2026, 7, 10), date(2026, 7, 5))) == 0


def test_working_days_single_working_day_returns_one():
    from services.hr_bank_holidays import working_days_between
    with patch("services.hr_bank_holidays._all_holidays", AsyncMock(return_value=[])):
        # Tue 2026-07-14 to Tue 2026-07-14 → 1
        assert asyncio.run(working_days_between(date(2026, 7, 14), date(2026, 7, 14))) == 1


# ─────────────────────────────────────────────────────────────────────
# hr_employees
# ─────────────────────────────────────────────────────────────────────
def test_list_employees_rejects_non_hr():
    from routes.hr_employees import list_employees
    from fastapi import HTTPException
    db = _db()
    with patch("routes.hr_employees.get_db", return_value=db):
        for user in (STAFF, MANAGER, {}):
            with pytest.raises(HTTPException) as exc:
                asyncio.run(list_employees(current_user=user))
            assert exc.value.status_code == 403


def test_create_employee_assigns_next_employee_number():
    """First create → TS-001, second → TS-002."""
    from routes.hr_employees import create_employee, EmployeeCreate
    coll = MagicMock()
    # No existing record → last is None
    coll.find_one = AsyncMock(side_effect=[None, None])  # no clash, no last seq
    coll.insert_one = AsyncMock()
    db = _db(hr_employees=coll)
    with patch("routes.hr_employees.get_db", return_value=db):
        out = asyncio.run(create_employee(
            EmployeeCreate(first_name="Mia", last_name="Sales"),
            current_user=HR,
        ))
    assert out["employee_number"] == "TS-001"
    coll.insert_one.assert_awaited_once()


def test_create_employee_rejects_duplicate_user_link():
    from routes.hr_employees import create_employee, EmployeeCreate
    from fastapi import HTTPException
    coll = MagicMock()
    coll.find_one = AsyncMock(return_value={"id": "existing", "user_id": "user-mia"})
    db = _db(hr_employees=coll)
    with patch("routes.hr_employees.get_db", return_value=db):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(create_employee(
                EmployeeCreate(first_name="Mia", last_name="Sales", user_id="user-mia"),
                current_user=HR,
            ))
        assert exc.value.status_code == 409


def test_create_employee_encrypts_ni_number():
    """The persisted doc must NOT contain `ni_number` in clear; the
    encrypted version lives under `ni_number_enc`."""
    from routes.hr_employees import create_employee, EmployeeCreate
    from services.hr_security import decrypt
    coll = MagicMock()
    coll.find_one = AsyncMock(side_effect=[None, None])
    captured = {}
    async def _cap(doc): captured.update(doc)
    coll.insert_one = AsyncMock(side_effect=_cap)
    db = _db(hr_employees=coll)
    with patch("routes.hr_employees.get_db", return_value=db):
        asyncio.run(create_employee(
            EmployeeCreate(first_name="Mia", last_name="Sales", ni_number="AB123456C"),
            current_user=HR,
        ))
    assert "ni_number" not in captured  # never persisted in clear
    assert decrypt(captured["ni_number_enc"]) == "AB123456C"


def test_get_my_employee_record_returns_masked_ni():
    """Self-service GET /me returns the staff's own data with masked NI."""
    from routes.hr_employees import get_my_employee_record
    from services.hr_security import encrypt
    enc = encrypt("AB123456C")
    coll = MagicMock()
    coll.find_one = AsyncMock(return_value={
        "id": "emp-1", "user_id": "user-mia", "first_name": "Mia",
        "ni_number_enc": enc,
    })
    db = _db(hr_employees=coll)
    with patch("routes.hr_employees.get_db", return_value=db):
        out = asyncio.run(get_my_employee_record(current_user=STAFF))
    assert out["first_name"] == "Mia"
    assert out["ni_number"] == "*****456C"  # masked, never raw to staff


def test_archive_employee_soft_deletes_not_hard():
    from routes.hr_employees import archive_employee
    coll = MagicMock()
    coll.find_one = AsyncMock(return_value={"id": "emp-1"})
    coll.update_one = AsyncMock()
    db = _db(hr_employees=coll)
    with patch("routes.hr_employees.get_db", return_value=db):
        out = asyncio.run(archive_employee("emp-1", current_user=HR))
    assert out["ok"] is True
    call = coll.update_one.await_args
    assert call.args[0] == {"id": "emp-1"}
    set_ = call.args[1]["$set"]
    assert set_["status"] == "left"
    assert "archived_at" in set_


def test_self_service_update_can_only_change_contact_fields():
    """The SelfServiceUpdate model deliberately excludes pay / role /
    dates. Pydantic should reject those via extra fields ignored."""
    from routes.hr_employees import SelfServiceUpdate
    # Allowed fields work
    ok = SelfServiceUpdate(preferred_name="M", personal_phone="07700900000")
    assert ok.preferred_name == "M"
    # Disallowed fields are silently dropped (no `extra=allow`) — model
    # has only the narrow set defined, so they don't appear in dump.
    raw = {
        "preferred_name": "M",
        "pay_amount": 99999,        # not in the model
        "job_title": "CEO",          # not in the model
    }
    parsed = SelfServiceUpdate(**raw)
    dumped = parsed.model_dump(exclude_unset=True)
    assert "pay_amount" not in dumped
    assert "job_title" not in dumped


# ─────────────────────────────────────────────────────────────────────
# hr_leave
# ─────────────────────────────────────────────────────────────────────
def test_create_leave_request_calculates_working_days():
    """Mon 2026-07-13 to Fri 2026-07-17 → 5 working days (no UK bank
    holidays in that window)."""
    from routes.hr_leave import create_leave_request, LeaveRequestIn
    emp_coll = MagicMock()
    emp_coll.find_one = AsyncMock(return_value={
        "id": "emp-1", "user_id": "user-mia",
        "first_name": "Mia", "last_name": "Sales",
    })
    req_coll = MagicMock()
    req_coll.insert_one = AsyncMock()
    db = _db(hr_employees=emp_coll, hr_leave_requests=req_coll)
    with patch("routes.hr_leave.get_db", return_value=db), \
         patch("services.hr_bank_holidays._all_holidays", AsyncMock(return_value=[])):
        out = asyncio.run(create_leave_request(
            LeaveRequestIn(type="holiday", start_date="2026-07-13", end_date="2026-07-17"),
            current_user=STAFF,
        ))
    assert out["working_days"] == 5
    assert out["status"] == "pending"
    assert out["employee_name"] == "Mia Sales"


def test_create_leave_rejects_inverted_date_range():
    from routes.hr_leave import create_leave_request, LeaveRequestIn
    from fastapi import HTTPException
    emp_coll = MagicMock()
    emp_coll.find_one = AsyncMock(return_value={"id": "emp-1", "user_id": "user-mia"})
    db = _db(hr_employees=emp_coll, hr_leave_requests=MagicMock())
    with patch("routes.hr_leave.get_db", return_value=db):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(create_leave_request(
                LeaveRequestIn(type="holiday", start_date="2026-07-20", end_date="2026-07-15"),
                current_user=STAFF,
            ))
        assert exc.value.status_code == 400


def test_create_leave_staff_cant_file_for_others():
    """Without HR admin role, you can only file leave for yourself."""
    from routes.hr_leave import create_leave_request, LeaveRequestIn
    from fastapi import HTTPException
    emp_coll = MagicMock()
    # Looked-up employee belongs to a DIFFERENT user
    emp_coll.find_one = AsyncMock(return_value={
        "id": "emp-other", "user_id": "user-other",
        "first_name": "X", "last_name": "Y",
    })
    db = _db(hr_employees=emp_coll, hr_leave_requests=MagicMock())
    with patch("routes.hr_leave.get_db", return_value=db):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(create_leave_request(
                LeaveRequestIn(
                    employee_id="emp-other", type="holiday",
                    start_date="2026-07-13", end_date="2026-07-17",
                ),
                current_user=STAFF,
            ))
        assert exc.value.status_code == 403


def test_approve_leave_request_requires_line_manager_or_admin():
    """Approver must be either an HR admin or the employee's line
    manager. Random staff member can't approve."""
    from routes.hr_leave import approve_leave_request, LeaveDecision
    from fastapi import HTTPException
    req_coll = MagicMock()
    req_coll.find_one = AsyncMock(return_value={
        "id": "req-1", "employee_id": "emp-1", "status": "pending",
    })
    req_coll.update_one = AsyncMock()
    emp_coll = MagicMock()
    emp_coll.find_one = AsyncMock(return_value={
        "id": "emp-1", "user_id": "user-mia",
        "line_manager_user_id": "user-mgr",
    })
    db = _db(hr_employees=emp_coll, hr_leave_requests=req_coll)
    # Random staff member tries → rejected
    with patch("routes.hr_leave.get_db", return_value=db):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(approve_leave_request(
                "req-1", LeaveDecision(note="ok"),
                current_user={"role": "staff", "id": "someone-else"},
            ))
        assert exc.value.status_code == 403
        # Line manager → accepted
        out = asyncio.run(approve_leave_request(
            "req-1", LeaveDecision(note="ok"), current_user=MANAGER,
        ))
        assert out["status"] == "approved"


def test_my_balance_subtracts_approved_and_pending():
    """Used = approved holiday working_days. Pending also subtracted
    so the staff can't accidentally double-book themselves."""
    from routes.hr_leave import my_balance
    emp_coll = MagicMock()
    emp_coll.find_one = AsyncMock(return_value={
        "id": "emp-1", "user_id": "user-mia",
        "holiday_entitlement_days": 28,
    })
    req_coll = MagicMock()
    # First find() → approved (sum 8); second find() → pending (sum 5)
    req_coll.find = MagicMock(side_effect=[
        _Cursor([{"working_days": 5}, {"working_days": 3}]),
        _Cursor([{"working_days": 5}]),
    ])
    db = _db(hr_employees=emp_coll, hr_leave_requests=req_coll)
    with patch("routes.hr_leave.get_db", return_value=db):
        out = asyncio.run(my_balance(year=2026, current_user=STAFF))
    assert out["entitlement_days"] == 28
    assert out["used_days"] == 8.0
    assert out["pending_days"] == 5.0
    assert out["remaining_days"] == 15.0


# ─────────────────────────────────────────────────────────────────────
# hr_documents
# ─────────────────────────────────────────────────────────────────────
def test_upload_document_rejects_non_hr():
    from routes.hr_documents import upload_document, DocumentUploadIn
    from fastapi import HTTPException
    payload = DocumentUploadIn(
        employee_id="emp-1", category="contract",
        title="X", file_name="x.pdf",
        file_base64=base64.b64encode(b"PDF").decode(),
    )
    with patch("routes.hr_documents.get_db", return_value=_db()):
        for user in (STAFF, MANAGER, {}):
            with pytest.raises(HTTPException) as exc:
                asyncio.run(upload_document(payload, current_user=user))
            assert exc.value.status_code == 403


def test_upload_document_rejects_invalid_category():
    from routes.hr_documents import upload_document, DocumentUploadIn
    from fastapi import HTTPException
    payload = DocumentUploadIn(
        employee_id="emp-1", category="weird-category",
        title="X", file_name="x.pdf",
        file_base64=base64.b64encode(b"PDF").decode(),
    )
    with patch("routes.hr_documents.get_db", return_value=_db()):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(upload_document(payload, current_user=HR))
        assert exc.value.status_code == 400


def test_upload_document_persists_size_and_strips_data_url_prefix():
    from routes.hr_documents import upload_document, DocumentUploadIn
    emp_coll = MagicMock()
    emp_coll.find_one = AsyncMock(return_value={"id": "emp-1"})
    docs_coll = MagicMock()
    captured = {}
    async def _cap(doc): captured.update(doc)
    docs_coll.insert_one = AsyncMock(side_effect=_cap)
    db = _db(hr_employees=emp_coll, hr_documents=docs_coll)
    pdf_bytes = b"%PDF-tiny-test-content"
    data_url = f"data:application/pdf;base64,{base64.b64encode(pdf_bytes).decode()}"
    payload = DocumentUploadIn(
        employee_id="emp-1", category="contract",
        title="Contract", file_name="contract.pdf",
        file_base64=data_url, mime_type="application/pdf",
    )
    with patch("routes.hr_documents.get_db", return_value=db):
        out = asyncio.run(upload_document(payload, current_user=HR))
    assert out["file_size"] == len(pdf_bytes)
    assert captured["file_size"] == len(pdf_bytes)
    # Stored b64 should NOT have the data: prefix
    assert not captured["file_b64"].startswith("data:")


def test_upload_document_rejects_oversize():
    """10MB cap — anything bigger returns 413."""
    from routes.hr_documents import upload_document, DocumentUploadIn, MAX_FILE_BYTES
    from fastapi import HTTPException
    emp_coll = MagicMock()
    emp_coll.find_one = AsyncMock(return_value={"id": "emp-1"})
    db = _db(hr_employees=emp_coll, hr_documents=MagicMock())
    big = base64.b64encode(b"X" * (MAX_FILE_BYTES + 1)).decode()
    payload = DocumentUploadIn(
        employee_id="emp-1", category="contract",
        title="Huge", file_name="huge.bin", file_base64=big,
    )
    with patch("routes.hr_documents.get_db", return_value=db):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(upload_document(payload, current_user=HR))
        assert exc.value.status_code == 413


def test_list_employee_documents_hides_hr_only_from_employee():
    from routes.hr_documents import list_employee_documents
    emp_coll = MagicMock()
    emp_coll.find_one = AsyncMock(return_value={"id": "emp-1", "user_id": "user-mia"})
    docs_coll = MagicMock()
    docs_coll.find = MagicMock(return_value=_Cursor([]))
    db = _db(hr_employees=emp_coll, hr_documents=docs_coll)
    with patch("routes.hr_documents.get_db", return_value=db):
        asyncio.run(list_employee_documents("emp-1", current_user=STAFF))
    query = docs_coll.find.call_args.args[0]
    # Employee viewing themselves → must filter for visible_to_employee
    assert query.get("visible_to_employee") is True


# ─────────────────────────────────────────────────────────────────────
# hr_time_tracking
# ─────────────────────────────────────────────────────────────────────
def test_clock_in_creates_open_entry_with_web_method():
    from routes.hr_time_tracking import clock_in, ClockInRequest
    emp_coll = MagicMock()
    emp_coll.find_one = AsyncMock(return_value={
        "id": "emp-1", "user_id": "user-mia",
        "first_name": "Mia", "last_name": "Sales",
    })
    time_coll = MagicMock()
    time_coll.find_one = AsyncMock(return_value=None)  # no open entry
    time_coll.insert_one = AsyncMock()
    db = _db(hr_employees=emp_coll, hr_time_entries=time_coll)
    with patch("routes.hr_time_tracking.get_db", return_value=db):
        out = asyncio.run(clock_in(ClockInRequest(showroom_id="sr-1"), current_user=STAFF))
    assert out["method"] == "web"
    assert out["clock_out_at"] is None
    assert out["showroom_id"] == "sr-1"
    assert out["employee_name"] == "Mia Sales"


def test_clock_in_rejects_double_clockin():
    from routes.hr_time_tracking import clock_in, ClockInRequest
    from fastapi import HTTPException
    emp_coll = MagicMock()
    emp_coll.find_one = AsyncMock(return_value={"id": "emp-1", "user_id": "user-mia"})
    time_coll = MagicMock()
    time_coll.find_one = AsyncMock(return_value={"id": "open-entry"})
    db = _db(hr_employees=emp_coll, hr_time_entries=time_coll)
    with patch("routes.hr_time_tracking.get_db", return_value=db):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(clock_in(ClockInRequest(showroom_id="sr-1"), current_user=STAFF))
        assert exc.value.status_code == 409


def test_clock_in_via_qr_resolves_showroom():
    """QR token wins over any client-supplied showroom_id — anti-spoof."""
    from routes.hr_time_tracking import clock_in, ClockInRequest
    emp_coll = MagicMock()
    emp_coll.find_one = AsyncMock(return_value={
        "id": "emp-1", "user_id": "user-mia",
        "first_name": "Mia", "last_name": "Sales",
    })
    time_coll = MagicMock()
    time_coll.find_one = AsyncMock(return_value=None)
    time_coll.insert_one = AsyncMock()
    qr_coll = MagicMock()
    qr_coll.find_one = AsyncMock(return_value={"showroom_id": "sr-tonbridge"})
    db = _db(hr_employees=emp_coll, hr_time_entries=time_coll, hr_showroom_qr_codes=qr_coll)
    with patch("routes.hr_time_tracking.get_db", return_value=db):
        out = asyncio.run(clock_in(
            ClockInRequest(showroom_id="sr-WRONG", qr_token="tok-abc"),
            current_user=STAFF,
        ))
    assert out["method"] == "qr_code"
    assert out["showroom_id"] == "sr-tonbridge"  # QR wins over client


def test_clock_in_via_qr_rejects_invalid_token():
    from routes.hr_time_tracking import clock_in, ClockInRequest
    from fastapi import HTTPException
    emp_coll = MagicMock()
    emp_coll.find_one = AsyncMock(return_value={"id": "emp-1", "user_id": "user-mia"})
    time_coll = MagicMock()
    time_coll.find_one = AsyncMock(return_value=None)
    qr_coll = MagicMock()
    qr_coll.find_one = AsyncMock(return_value=None)
    db = _db(hr_employees=emp_coll, hr_time_entries=time_coll, hr_showroom_qr_codes=qr_coll)
    with patch("routes.hr_time_tracking.get_db", return_value=db):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(clock_in(
                ClockInRequest(qr_token="bad-token"), current_user=STAFF,
            ))
        assert exc.value.status_code == 400


def test_clock_out_computes_duration_minus_break():
    """7 hours wall clock - 30 min break = 6.5 hour duration."""
    from routes.hr_time_tracking import clock_out, ClockOutRequest
    emp_coll = MagicMock()
    emp_coll.find_one = AsyncMock(return_value={"id": "emp-1", "user_id": "user-mia"})
    seven_hours_ago = (datetime.now(timezone.utc) - timedelta(hours=7)).isoformat()
    time_coll = MagicMock()
    time_coll.find_one = AsyncMock(return_value={
        "id": "entry-1", "clock_in_at": seven_hours_ago,
    })
    captured = {}
    async def _cap(_q, update): captured.update(update["$set"])
    time_coll.update_one = AsyncMock(side_effect=_cap)
    db = _db(hr_employees=emp_coll, hr_time_entries=time_coll)
    with patch("routes.hr_time_tracking.get_db", return_value=db):
        asyncio.run(clock_out(ClockOutRequest(break_minutes=30), current_user=STAFF))
    # 7h - 30m = 6h 30m = 390 min (within 5 min of computed)
    assert 385 <= captured["duration_minutes"] <= 395
    assert captured["break_minutes"] == 30


def test_manual_entry_requires_hr_admin():
    from routes.hr_time_tracking import manual_entry, ManualEntryIn
    from fastapi import HTTPException
    payload = ManualEntryIn(
        employee_id="emp-1",
        clock_in_at="2026-06-13T09:00:00+00:00",
        clock_out_at="2026-06-13T17:00:00+00:00",
    )
    with patch("routes.hr_time_tracking.get_db", return_value=_db()):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(manual_entry(payload, current_user=STAFF))
        assert exc.value.status_code == 403


def test_rotate_qr_deactivates_previous_secret():
    """When HR rotates the QR for a showroom, the OLD secret must be
    marked active=False so an already-printed sticker stops working."""
    from routes.hr_time_tracking import rotate_showroom_qr
    sr_coll = MagicMock()
    sr_coll.find_one = AsyncMock(return_value={"id": "sr-1", "name": "Tonbridge"})
    qr_coll = MagicMock()
    qr_coll.update_many = AsyncMock()
    qr_coll.insert_one = AsyncMock()
    db = _db(showrooms=sr_coll, hr_showroom_qr_codes=qr_coll)
    with patch("routes.hr_time_tracking.get_db", return_value=db):
        out = asyncio.run(rotate_showroom_qr("sr-1", current_user=HR))
    assert out["ok"] is True
    assert out["showroom_name"] == "Tonbridge"
    assert out["qr_secret"]
    # Old tokens deactivated
    qr_coll.update_many.assert_awaited_once()
    deactivate_set = qr_coll.update_many.await_args.args[1]["$set"]
    assert deactivate_set["active"] is False

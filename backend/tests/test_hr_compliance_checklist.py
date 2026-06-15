"""
Tests for HR Compliance Checklist (Feb 2026).
"""
import os
import asyncio
from datetime import date, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture(autouse=True)
def _env_setup():
    os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
    os.environ.setdefault("DB_NAME", "test_hr_compliance")


HR = {"role": "hr_admin", "id": "u-hr", "email": "hr@x.com"}
STAFF = {"role": "staff", "id": "u-mia", "email": "mia@x.com"}


class _AsyncIter:
    def __init__(self, items): self._items = list(items)
    def sort(self, *a, **k): return self
    def __aiter__(self): self._iter = iter(self._items); return self
    async def __anext__(self):
        try: return next(self._iter)
        except StopIteration as e: raise StopAsyncIteration from e


class _Cursor:
    def __init__(self, items): self.items = list(items)
    def sort(self, *a, **k): return self
    async def to_list(self, _n=None): return list(self.items)
    def __aiter__(self): self._iter = iter(self.items); return self
    async def __anext__(self):
        try: return next(self._iter)
        except StopIteration as e: raise StopAsyncIteration from e


# ─── Profile inference ───────────────────────────────────────────────
def test_profile_inference_uses_explicit_override_when_present():
    from routes.hr_compliance_checklist import _infer_profile
    emp = {"compliance_profile": "british_worker"}
    # Even though they have a visa doc, the override wins
    assert _infer_profile(emp, {"visa", "right_to_work"}) == "british_worker"


def test_profile_inference_falls_back_to_sponsored_when_visa_doc_present():
    from routes.hr_compliance_checklist import _infer_profile
    assert _infer_profile({}, {"visa", "id"}) == "sponsored_worker"


def test_profile_inference_falls_back_to_settled_when_only_rtw():
    from routes.hr_compliance_checklist import _infer_profile
    assert _infer_profile({}, {"right_to_work", "id"}) == "settled_worker"


def test_profile_inference_falls_back_to_british_when_no_docs():
    from routes.hr_compliance_checklist import _infer_profile
    assert _infer_profile({}, set()) == "british_worker"


def test_profile_inference_ignores_invalid_override():
    """If the field has a typo or stale enum value, we fall back to
    auto-detection rather than crashing or showing 'unknown'."""
    from routes.hr_compliance_checklist import _infer_profile
    assert _infer_profile({"compliance_profile": "nonsense"}, {"visa"}) == "sponsored_worker"


# ─── Doc classification ──────────────────────────────────────────────
def test_classify_missing_when_no_doc():
    from routes.hr_compliance_checklist import _classify_doc
    assert _classify_doc(None, expires=True) == "missing"
    assert _classify_doc(None, expires=False) == "missing"


def test_classify_ok_when_non_expiring_present():
    from routes.hr_compliance_checklist import _classify_doc
    assert _classify_doc({"id": "d1"}, expires=False) == "ok"


def test_classify_expired_when_past_expiry():
    from routes.hr_compliance_checklist import _classify_doc
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    assert _classify_doc({"expiry_date": yesterday}, expires=True) == "expired"


def test_classify_expiring_within_30_days():
    from routes.hr_compliance_checklist import _classify_doc
    in_15 = (date.today() + timedelta(days=15)).isoformat()
    assert _classify_doc({"expiry_date": in_15}, expires=True) == "expiring"


def test_classify_ok_when_expiry_far_future():
    from routes.hr_compliance_checklist import _classify_doc
    in_200 = (date.today() + timedelta(days=200)).isoformat()
    assert _classify_doc({"expiry_date": in_200}, expires=True) == "ok"


def test_classify_expiring_when_required_expiring_but_no_date_recorded():
    """If a doc category needs an expiry but the uploader forgot to set
    one, flag it as 'expiring' to draw attention without misclassifying
    as missing."""
    from routes.hr_compliance_checklist import _classify_doc
    assert _classify_doc({"id": "d1"}, expires=True) == "expiring"


# ─── End-to-end checklist ────────────────────────────────────────────
def _build_db(employees, docs):
    db = MagicMock()
    db.hr_employees = MagicMock()
    db.hr_employees.find = MagicMock(return_value=_Cursor(employees))
    db.hr_documents = MagicMock()
    db.hr_documents.find = MagicMock(return_value=_AsyncIter(docs))
    db.hr_settings = MagicMock()
    db.hr_settings.find_one = AsyncMock(return_value=None)
    return db


def test_checklist_marks_sponsored_worker_compliant_when_all_docs_present():
    from routes.hr_compliance_checklist import compliance_checklist
    in_180 = (date.today() + timedelta(days=180)).isoformat()
    employees = [{"id": "e1", "first_name": "Mia", "last_name": "X",
                  "employee_number": "TS-001"}]
    # Mia has every required sponsored-worker doc, all valid
    docs = [
        {"employee_id": "e1", "category": "contract",      "id": "d1", "title": "Contract.pdf",
         "uploaded_at": "2026-01-01T00:00:00"},
        {"employee_id": "e1", "category": "right_to_work", "id": "d2", "title": "Share code",
         "expiry_date": in_180, "uploaded_at": "2026-01-02T00:00:00"},
        {"employee_id": "e1", "category": "visa",          "id": "d3", "title": "BRP",
         "expiry_date": in_180, "uploaded_at": "2026-01-03T00:00:00"},
        {"employee_id": "e1", "category": "id",            "id": "d4", "title": "Passport",
         "expiry_date": in_180, "uploaded_at": "2026-01-04T00:00:00"},
        {"employee_id": "e1", "category": "certification", "id": "d5", "title": "Degree",
         "uploaded_at": "2026-01-05T00:00:00"},
    ]
    db = _build_db(employees, docs)
    with patch("routes.hr_compliance_checklist.get_db", return_value=db):
        out = asyncio.run(compliance_checklist(current_user=HR))
    assert len(out["rows"]) == 1
    row = out["rows"][0]
    assert row["profile"] == "sponsored_worker"
    assert row["verdict"] == "compliant"
    assert row["required_missing"] == 0
    assert row["required_expired"] == 0
    # P45 + policy_acknowledgement missing but optional → doesn't fail
    assert out["overall_counts"]["compliant"] == 1


def test_checklist_marks_non_compliant_when_required_doc_missing():
    from routes.hr_compliance_checklist import compliance_checklist
    employees = [{"id": "e1", "first_name": "John", "last_name": "Y",
                  "employee_number": "TS-002"}]
    # John has only a contract — no RTW evidence, no ID → british profile, missing RTW + ID
    docs = [
        {"employee_id": "e1", "category": "contract", "id": "d1",
         "uploaded_at": "2026-01-01T00:00:00"},
    ]
    db = _build_db(employees, docs)
    with patch("routes.hr_compliance_checklist.get_db", return_value=db):
        out = asyncio.run(compliance_checklist(current_user=HR))
    row = out["rows"][0]
    assert row["profile"] == "british_worker"  # no visa/RTW → defaults to british
    assert row["verdict"] == "non_compliant"
    assert row["required_missing"] >= 1
    assert out["overall_counts"]["non_compliant"] == 1


def test_checklist_marks_action_needed_when_doc_expiring_soon():
    from routes.hr_compliance_checklist import compliance_checklist
    in_180 = (date.today() + timedelta(days=180)).isoformat()
    in_10 = (date.today() + timedelta(days=10)).isoformat()
    employees = [{"id": "e1", "first_name": "Sara", "last_name": "Z",
                  "employee_number": "TS-003"}]
    docs = [
        {"employee_id": "e1", "category": "contract",      "id": "d1", "uploaded_at": "2026-01-01T00:00:00"},
        {"employee_id": "e1", "category": "right_to_work", "id": "d2", "expiry_date": in_180, "uploaded_at": "2026-01-02T00:00:00"},
        {"employee_id": "e1", "category": "visa",          "id": "d3", "expiry_date": in_10,  "uploaded_at": "2026-01-03T00:00:00"},
        {"employee_id": "e1", "category": "id",            "id": "d4", "expiry_date": in_180, "uploaded_at": "2026-01-04T00:00:00"},
        {"employee_id": "e1", "category": "certification", "id": "d5", "uploaded_at": "2026-01-05T00:00:00"},
    ]
    db = _build_db(employees, docs)
    with patch("routes.hr_compliance_checklist.get_db", return_value=db):
        out = asyncio.run(compliance_checklist(current_user=HR))
    row = out["rows"][0]
    assert row["verdict"] == "action_needed"
    assert row["required_expiring"] == 1
    assert row["required_missing"] == 0
    assert out["overall_counts"]["action_needed"] == 1


def test_checklist_uses_most_recent_doc_per_category():
    """When two RTW docs are uploaded, the LATEST one's expiry wins.
    Crucial — re-uploads on renewal must reset the status."""
    from routes.hr_compliance_checklist import compliance_checklist
    in_180 = (date.today() + timedelta(days=180)).isoformat()
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    employees = [{"id": "e1", "first_name": "Kas", "last_name": "X",
                  "employee_number": "TS-004"}]
    docs = [
        # NEWER (uploaded today) — valid
        {"employee_id": "e1", "category": "right_to_work", "id": "new",
         "expiry_date": in_180, "uploaded_at": "2026-06-15T00:00:00"},
        # OLDER (uploaded last year) — expired
        {"employee_id": "e1", "category": "right_to_work", "id": "old",
         "expiry_date": yesterday, "uploaded_at": "2025-01-01T00:00:00"},
    ]
    db = _build_db(employees, docs)
    with patch("routes.hr_compliance_checklist.get_db", return_value=db):
        out = asyncio.run(compliance_checklist(current_user=HR))
    row = out["rows"][0]
    rtw_req = next(r for r in row["requirements"] if r["category"] == "right_to_work")
    assert rtw_req["status"] == "ok"  # picked up the newer doc
    assert rtw_req["document"]["id"] == "new"


def test_checklist_rejects_non_hr():
    from routes.hr_compliance_checklist import compliance_checklist
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc:
        asyncio.run(compliance_checklist(current_user=STAFF))
    assert exc.value.status_code == 403


def test_checklist_skips_archived_employees():
    """`archived_at` set → don't include in the checklist."""
    from routes.hr_compliance_checklist import compliance_checklist
    # Build a db that filters by the archived_at clause itself
    employees_active = []  # the mock returns whatever it's seeded with
    docs = []
    db = _build_db(employees_active, docs)
    # Verify the find query CONTAINS the archived_at exclusion
    with patch("routes.hr_compliance_checklist.get_db", return_value=db):
        asyncio.run(compliance_checklist(current_user=HR))
    # First positional arg to find() is the query filter
    args, _ = db.hr_employees.find.call_args
    assert args[0]["archived_at"] == {"$exists": False}


# ─── PDF ──────────────────────────────────────────────────────────────
def test_checklist_pdf_emits_pdf_bytes():
    from routes.hr_compliance_checklist import compliance_checklist_pdf
    db = _build_db([], [])
    with patch("routes.hr_compliance_checklist.get_db", return_value=db):
        resp = asyncio.run(compliance_checklist_pdf(current_user=HR))
    assert resp.media_type == "application/pdf"
    assert resp.body[:5] == b"%PDF-"
    assert "personnel_file_completeness" in resp.headers["content-disposition"]
    assert len(resp.body) > 2000


def test_checklist_pdf_rejects_non_hr():
    from routes.hr_compliance_checklist import compliance_checklist_pdf
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc:
        asyncio.run(compliance_checklist_pdf(current_user=STAFF))
    assert exc.value.status_code == 403


def test_checklist_pdf_includes_action_list_when_workers_non_compliant():
    from routes.hr_compliance_checklist import compliance_checklist_pdf
    employees = [{"id": "e1", "first_name": "John", "last_name": "Y",
                  "employee_number": "TS-002"}]
    docs = []  # everything missing → non_compliant
    db = _build_db(employees, docs)
    with patch("routes.hr_compliance_checklist.get_db", return_value=db):
        resp = asyncio.run(compliance_checklist_pdf(current_user=HR))
    assert resp.body[:5] == b"%PDF-"
    # Substantive content includes the action list
    assert len(resp.body) > 3000

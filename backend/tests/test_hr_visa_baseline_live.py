"""Live API smoke tests for HR Settings + Visa Compliance baseline (Feb 2026).

Hits the deployed preview backend (REACT_APP_BACKEND_URL) — not unit tests.
"""
import os
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
ADMIN_EMAIL = "admin@test.com"
ADMIN_PASSWORD = "admin123"


@pytest.fixture(scope="module")
def admin_token():
    if not BASE_URL:
        pytest.skip("REACT_APP_BACKEND_URL not set")
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=15,
    )
    if r.status_code != 200:
        pytest.skip(f"login failed {r.status_code}: {r.text[:200]}")
    tok = r.json().get("access_token") or r.json().get("token")
    if not tok:
        pytest.skip(f"no token in response: {r.json()}")
    return tok


@pytest.fixture(scope="module")
def H(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


# ── HR Settings ─────────────────────────────────────────────────────
def test_get_hr_settings_returns_shape(H):
    r = requests.get(f"{BASE_URL}/api/hr/settings", headers=H, timeout=15)
    assert r.status_code == 200, r.text[:300]
    d = r.json()
    assert "company_name" in d
    assert "authorising_officer" in d
    assert isinstance(d["authorising_officer"], dict)
    assert "sponsor_licence_status" in d


def test_put_hr_settings_invalid_status_rejected(H):
    bad = {"company_name": "TEST_Co", "sponsor_licence_status": "bogus_xyz"}
    r = requests.put(f"{BASE_URL}/api/hr/settings", headers=H, json=bad, timeout=15)
    assert r.status_code == 400, f"expected 400, got {r.status_code}: {r.text[:200]}"


def test_put_hr_settings_invalid_date_rejected(H):
    bad = {
        "company_name": "TEST_Co",
        "sponsor_licence_status": "applying",
        "policy_effective_date": "31-12-2026",  # wrong format
    }
    r = requests.put(f"{BASE_URL}/api/hr/settings", headers=H, json=bad, timeout=15)
    assert r.status_code == 400


def test_put_hr_settings_saves_and_persists(H):
    payload = {
        "company_name": "Tile Station Ltd (TEST)",
        "sponsor_licence_status": "applying",
        "authorising_officer": {
            "name": "TEST Authorising Officer",
            "job_title": "Director",
            "email": "ao@test.com",
        },
    }
    r = requests.put(f"{BASE_URL}/api/hr/settings", headers=H, json=payload, timeout=15)
    assert r.status_code == 200, r.text[:300]
    saved = r.json()
    assert saved["company_name"] == payload["company_name"]
    # Auto-stamp on first save if missing
    assert saved.get("policy_effective_date"), "policy_effective_date should be auto-stamped"
    # GET to verify
    r2 = requests.get(f"{BASE_URL}/api/hr/settings", headers=H, timeout=15)
    assert r2.status_code == 200
    assert r2.json()["company_name"] == payload["company_name"]
    assert r2.json()["authorising_officer"]["name"] == "TEST Authorising Officer"


# ── Baseline status ─────────────────────────────────────────────────
def test_baseline_status_shape(H):
    r = requests.get(
        f"{BASE_URL}/api/hr/visa-compliance/baseline/status", headers=H, timeout=15
    )
    assert r.status_code == 200, r.text[:300]
    d = r.json()
    assert "completed" in d
    assert "latest" in d
    assert "active_employee_count" in d
    assert "sponsored_employee_count" in d
    assert isinstance(d["active_employee_count"], int)


# ── Baseline POST validation ─────────────────────────────────────────
def test_baseline_refuses_without_ack(H):
    payload = {
        "entries": [{"employee_id": "nonexistent-id-xyz", "review_method": "in_person"}],
        "overview_acknowledged": False,
    }
    r = requests.post(
        f"{BASE_URL}/api/hr/visa-compliance/baseline", headers=H, json=payload, timeout=15
    )
    assert r.status_code == 400


def test_baseline_refuses_unknown_employee(H):
    payload = {
        "entries": [{"employee_id": "TEST_unknown_emp_xyz", "review_method": "in_person"}],
        "overview_acknowledged": True,
    }
    r = requests.post(
        f"{BASE_URL}/api/hr/visa-compliance/baseline", headers=H, json=payload, timeout=15
    )
    assert r.status_code == 404


# ── Policy PDF ──────────────────────────────────────────────────────
def test_policy_pdf_returns_pdf(H):
    r = requests.get(
        f"{BASE_URL}/api/hr/visa-compliance/policy.pdf", headers=H, timeout=30
    )
    assert r.status_code == 200, r.text[:300]
    assert r.headers.get("content-type", "").startswith("application/pdf")
    assert r.content[:5] == b"%PDF-", f"PDF magic missing, got {r.content[:20]}"
    assert "visa_monitoring_policy.pdf" in r.headers.get("content-disposition", "")
    # Ensure non-trivial size
    assert len(r.content) > 1500


# ── Auth gating ─────────────────────────────────────────────────────
def test_settings_requires_auth():
    r = requests.get(f"{BASE_URL}/api/hr/settings", timeout=15)
    assert r.status_code in (401, 403)


def test_policy_pdf_requires_auth():
    r = requests.get(f"{BASE_URL}/api/hr/visa-compliance/policy.pdf", timeout=15)
    assert r.status_code in (401, 403)

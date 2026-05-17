"""iter181 — SEO endpoint regression tests after SSR + SeoHead dedupe fix.
Covers public SEO overrides, health, IndexNow, admin SEO routes, auto-fix gate, permissions.
"""
import os
import requests
import pytest

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://feature-verification-7.preview.emergentagent.com").rstrip("/")
ADMIN_EMAIL = "admin@test.com"
ADMIN_PASSWORD = "admin123"


@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def admin_token(session):
    r = session.post(f"{BASE_URL}/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=15)
    if r.status_code != 200:
        pytest.skip(f"Admin login failed: {r.status_code} {r.text[:200]}")
    data = r.json()
    token = data.get("token") or data.get("access_token") or (data.get("user") or {}).get("token")
    if not token:
        pytest.skip(f"No token in login response: {data}")
    return token


@pytest.fixture(scope="module")
def admin_session(session, admin_token):
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json", "Authorization": f"Bearer {admin_token}"})
    return s


# ===== Public SEO endpoints =====
def test_health(session):
    r = session.get(f"{BASE_URL}/api/health", timeout=15)
    assert r.status_code == 200, r.text
    body = r.json()
    # Healthy responses usually contain a status / ok marker
    assert any(k in body for k in ("status", "ok", "healthy", "service")), body


def test_seo_overrides_shape(session):
    r = session.get(f"{BASE_URL}/api/seo/overrides", timeout=20)
    assert r.status_code == 200, r.text
    body = r.json()
    for key in ("overrides", "noindex_paths", "count", "noindex_count", "version"):
        assert key in body, f"Missing key '{key}' in /api/seo/overrides response: {list(body.keys())}"
    assert isinstance(body["overrides"], (dict, list))
    assert isinstance(body["noindex_paths"], list)
    assert isinstance(body["count"], int)
    assert isinstance(body["noindex_count"], int)


def test_indexnow_key_file(session):
    # Key from backend/.env: INDEXNOW_KEY=e3cc1d619b64844648fa953fcadc0370
    key = "e3cc1d619b64844648fa953fcadc0370"
    r = session.get(f"{BASE_URL}/api/seo/indexnow/{key}.txt", timeout=15)
    assert r.status_code == 200, f"{r.status_code}: {r.text[:200]}"
    # body should echo the key
    assert key in r.text


# ===== Admin SEO endpoints =====
def test_admin_seo_health(admin_session):
    r = admin_session.get(f"{BASE_URL}/api/admin/seo/health", timeout=20)
    assert r.status_code == 200, r.text
    assert isinstance(r.json(), dict)


def test_admin_seo_snapshot(admin_session):
    r = admin_session.get(f"{BASE_URL}/api/admin/seo/snapshot", timeout=30)
    assert r.status_code == 200, r.text
    assert isinstance(r.json(), dict)


def test_admin_seo_health_requires_auth(session):
    r = session.get(f"{BASE_URL}/api/admin/seo/health", timeout=15)
    assert r.status_code in (401, 403), f"Expected 401/403 anon, got {r.status_code}"


# NOTE: actual mounted prefix is /api/admin/seo-autopilot-v2 (not -autopilot/).
# The review-request spec used the older non-v2 path which is no longer mounted.
AUTOFIX_PATH = "/api/admin/seo-autopilot-v2/run/auto-fix"


def test_seo_autopilot_autofix_gated(session):
    r = session.post(f"{BASE_URL}{AUTOFIX_PATH}", json={}, timeout=15)
    assert r.status_code in (401, 403), f"Expected 401/403 anon, got {r.status_code}: {r.text[:200]}"


def test_seo_autopilot_autofix_admin_responds(admin_session):
    r = admin_session.post(f"{BASE_URL}{AUTOFIX_PATH}", json={"dry_run": True}, timeout=60)
    assert r.status_code != 404, "Auto-fix route is missing!"
    assert r.status_code < 500, f"Server error: {r.status_code} {r.text[:300]}"


# ===== Regression: permissions/me =====
def test_permissions_me_admin(admin_session):
    r = admin_session.get(f"{BASE_URL}/api/permissions/me", timeout=15)
    assert r.status_code == 200, r.text
    body = r.json()
    assert isinstance(body, dict)
    # Should contain role or permissions info
    assert any(k in body for k in ("role", "permissions", "scopes", "is_admin", "user"))


def test_permissions_me_anon(session):
    r = session.get(f"{BASE_URL}/api/permissions/me", timeout=15)
    # Either 401/403 or a 200 with anon shape — accept either, just make sure it's not 5xx
    assert r.status_code < 500, r.text

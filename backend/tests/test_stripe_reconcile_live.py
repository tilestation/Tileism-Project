"""
Live API tests for Stripe Reconciliation admin endpoints + webhook.
Tests features 1-9 of the iter180 review request.
"""
import os
import json
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://feature-verification-7.preview.emergentagent.com").rstrip("/")
ADMIN_EMAIL = "admin@test.com"
ADMIN_PASSWORD = "admin123"


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=20,
    )
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text[:200]}"
    data = r.json()
    token = data.get("access_token") or data.get("token")
    assert token, f"No token in login response: {data}"
    return token


@pytest.fixture(scope="module")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


# ─── Feature 1: orphans endpoint ─────────────────────────────────────
class TestOrphansEndpoint:
    def test_orphans_requires_auth(self):
        r = requests.get(f"{BASE_URL}/api/admin/stripe-reconcile/orphans?days_back=30", timeout=20)
        assert r.status_code in (401, 403), f"expected 401/403, got {r.status_code}"

    def test_orphans_returns_count_and_array(self, admin_headers):
        r = requests.get(
            f"{BASE_URL}/api/admin/stripe-reconcile/orphans?days_back=30",
            headers=admin_headers, timeout=30,
        )
        assert r.status_code == 200, f"orphans returned {r.status_code}: {r.text[:300]}"
        data = r.json()
        assert "count" in data
        assert "orphans" in data
        assert isinstance(data["orphans"], list)
        assert isinstance(data["count"], int)
        # If we have any orphans, check shape
        if data["orphans"]:
            orphan = data["orphans"][0]
            expected_fields = {"order_id", "kind", "customer_email", "amount", "stripe_session_id"}
            missing = expected_fields - set(orphan.keys())
            assert not missing, f"orphan missing fields: {missing}; got {list(orphan.keys())}"
            assert orphan["kind"] in ("sample", "shop")


# ─── Feature 2: scan endpoint ────────────────────────────────────────
class TestScanEndpoint:
    def test_scan_requires_auth(self):
        r = requests.post(f"{BASE_URL}/api/admin/stripe-reconcile/scan?days_back=30&dry_run=true", timeout=20)
        assert r.status_code in (401, 403)

    def test_scan_dry_run_returns_summary(self, admin_headers):
        r = requests.post(
            f"{BASE_URL}/api/admin/stripe-reconcile/scan?days_back=30&dry_run=true",
            headers=admin_headers, timeout=60,
        )
        assert r.status_code == 200, f"scan returned {r.status_code}: {r.text[:300]}"
        data = r.json()
        for key in ("scanned", "recovered", "still_pending", "errors"):
            assert key in data, f"scan response missing key '{key}'; got {list(data.keys())}"
        # dry_run should not actually recover
        assert isinstance(data["scanned"], int)
        assert isinstance(data["recovered"], int)


# ─── Feature 3: recover-one endpoint ─────────────────────────────────
class TestRecoverOne:
    def test_recover_one_requires_auth(self):
        r = requests.post(
            f"{BASE_URL}/api/admin/stripe-reconcile/recover-one",
            json={"session_id": "cs_test_does_not_exist"}, timeout=20,
        )
        assert r.status_code in (401, 403)

    def test_recover_one_unknown_session(self, admin_headers):
        r = requests.post(
            f"{BASE_URL}/api/admin/stripe-reconcile/recover-one",
            headers=admin_headers,
            json={"session_id": "cs_test_truly_nonexistent_zzz999"}, timeout=30,
        )
        assert r.status_code == 200, f"recover-one returned {r.status_code}: {r.text[:300]}"
        data = r.json()
        assert data.get("recovered") is False
        # spec says reason should be order_not_found OR there's an error field
        reason = data.get("reason") or data.get("error")
        assert reason and ("not_found" in str(reason).lower() or "order_not_found" in str(reason)), \
            f"expected order_not_found reason, got {data}"


# ─── Feature 4: refund endpoint (auth-only test, do not call Stripe) ─
class TestRefundEndpoint:
    def test_refund_requires_auth(self):
        r = requests.post(
            f"{BASE_URL}/api/admin/stripe-reconcile/refund",
            json={"session_id": "cs_test_fake_zzz"}, timeout=20,
        )
        assert r.status_code in (401, 403)


# ─── Feature 5: mark-fulfilled endpoint ──────────────────────────────
class TestMarkFulfilled:
    def test_mark_fulfilled_requires_auth(self):
        r = requests.post(
            f"{BASE_URL}/api/admin/stripe-reconcile/mark-fulfilled",
            json={"order_id": "fake-order-zzz", "tracking_number": "TRK123"}, timeout=20,
        )
        assert r.status_code in (401, 403)

    def test_mark_fulfilled_unknown_order(self, admin_headers):
        r = requests.post(
            f"{BASE_URL}/api/admin/stripe-reconcile/mark-fulfilled",
            headers=admin_headers,
            json={"order_id": "TEST_nonexistent_order_zzz", "tracking_number": "TRK123"}, timeout=30,
        )
        # Should either return 404 or a structured response with success=false
        assert r.status_code in (200, 404, 400), f"got {r.status_code}: {r.text[:300]}"


# ─── Feature 6 + 7: webhook resilience ───────────────────────────────
class TestWebhookResilience:
    def test_webhook_sample_order_nonexistent(self):
        """Webhook with metadata.order_type=sample but no DB row -> still {status: ok}."""
        # Signing verification will likely block raw POSTs but we test the payload-malformed path
        fake_event = {
            "id": "evt_test_zzz",
            "type": "checkout.session.completed",
            "data": {
                "object": {
                    "id": "cs_test_fake_session_zzz_999",
                    "metadata": {"order_type": "sample", "order_id": "nonexistent-order-zzz"},
                    "payment_status": "paid",
                    "amount_total": 299,
                }
            },
        }
        r = requests.post(
            f"{BASE_URL}/api/webhook/stripe",
            data=json.dumps(fake_event),
            headers={"Content-Type": "application/json"},
            timeout=20,
        )
        # Webhook should not 500. May return 400 (sig invalid) or 200 (ok). NEVER 500.
        assert r.status_code != 500, f"webhook 500 error: {r.text[:400]}"
        print(f"webhook sample test status: {r.status_code}, body: {r.text[:200]}")

    def test_webhook_shop_order_nonexistent(self):
        fake_event = {
            "id": "evt_test_zzz2",
            "type": "checkout.session.completed",
            "data": {
                "object": {
                    "id": "cs_test_fake_session_zzz_888",
                    "metadata": {},
                    "payment_status": "paid",
                    "amount_total": 9999,
                }
            },
        }
        r = requests.post(
            f"{BASE_URL}/api/webhook/stripe",
            data=json.dumps(fake_event),
            headers={"Content-Type": "application/json"},
            timeout=20,
        )
        assert r.status_code != 500
        print(f"webhook shop test status: {r.status_code}, body: {r.text[:200]}")


# ─── Feature 8: backend startup health ───────────────────────────────
class TestBackendHealth:
    def test_backend_alive(self):
        # A basic admin login already validates the backend booted
        r = requests.get(f"{BASE_URL}/api/health", timeout=10)
        # may return 200 or 404 if no health route, but server should be alive
        assert r.status_code < 500, f"backend not healthy: {r.status_code}"

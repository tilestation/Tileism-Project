"""Bug fix verification — POST /api/warehouse/adjustments/{id}/reverse now
performs soft-delete + cascade cleanup (instead of booking compensating rows).

Focus scenarios (per Jan 2026 owner-reported bug):
  A) Regular row: soft-deletes, rolls back stock by -delta, disappears from
     default GET /adjustments, still returned by ?include_deleted=true.
  B) Repeat delete on the same row → 409.
  C) Rows COUNT decreases (never increases) after delete.
  D) Legacy pair (original row with reversed=true + reversed_adjustment_id):
     one call soft-deletes BOTH rows; stock unchanged (already netted).
  E) Compensating-only row (has reverses_adjustment_id): deleting it undoes
     the compensation AND un-reverses its target so the target reappears.
  F) PIN with can_manage_warehouse=false → /pin-session returns 403.
"""

import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
API = f"{BASE_URL}/api"

ADMIN_EMAIL = "admin@test.com"
ADMIN_PASSWORD = "admin123"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def _login(email, password):
    r = requests.post(f"{API}/auth/login", json={"email": email, "password": password})
    if r.status_code != 200:
        pytest.skip(f"login failed: {r.status_code} {r.text}")
    return r.json()["token"]


@pytest.fixture(scope="module")
def admin_hdr():
    tok = _login(ADMIN_EMAIL, ADMIN_PASSWORD)
    return {"Authorization": f"Bearer {tok}"}


def _random_pin(admin_hdr):
    r = requests.get(f"{API}/staff-pins", headers=admin_hdr)
    used = set()
    if r.status_code == 200:
        for row in (r.json() or []):
            if row.get("pin"):
                used.add(str(row["pin"]))
    import random
    start = random.randint(10000, 99990)
    for delta in range(90000):
        candidate = str((start + delta - 10000) % 90000 + 10000)
        if candidate not in used:
            return candidate
    raise RuntimeError("no free 5-digit PIN")


@pytest.fixture(scope="module")
def staff_pin(admin_hdr):
    """Create a PIN with can_manage_warehouse=True. Cleanup at teardown."""
    pin = _random_pin(admin_hdr)
    payload = {
        "name": f"TEST WH DEL PIN {uuid.uuid4().hex[:4]}",
        "pin": pin,
        "role": "admin",
        "active": True,
        "can_manage_warehouse": True,
    }
    r = requests.post(f"{API}/staff-pins", json=payload, headers=admin_hdr)
    assert r.status_code in (200, 201), f"pin create failed: {r.status_code} {r.text}"
    row = r.json()
    row["pin"] = pin
    yield row
    try:
        requests.delete(f"{API}/staff-pins/{row['id']}", headers=admin_hdr)
    except Exception:
        pass


@pytest.fixture(scope="module")
def unauth_pin(admin_hdr):
    """A PIN with can_manage_warehouse=False — should be denied at /pin-session."""
    pin = _random_pin(admin_hdr)
    payload = {
        "name": f"TEST WH UNAUTH PIN {uuid.uuid4().hex[:4]}",
        "pin": pin,
        "role": "staff",
        "active": True,
        "can_manage_warehouse": False,
    }
    r = requests.post(f"{API}/staff-pins", json=payload, headers=admin_hdr)
    assert r.status_code in (200, 201), r.text
    row = r.json()
    row["pin"] = pin
    yield row
    try:
        requests.delete(f"{API}/staff-pins/{row['id']}", headers=admin_hdr)
    except Exception:
        pass


@pytest.fixture(scope="module")
def pin_token(admin_hdr, staff_pin):
    r = requests.post(
        f"{API}/warehouse/pin-session",
        json={"pin": staff_pin["pin"]},
        headers=admin_hdr,
    )
    assert r.status_code == 200, f"pin-session failed: {r.status_code} {r.text}"
    return r.json()["session_token"]


@pytest.fixture(scope="module")
def product(admin_hdr, pin_token):
    """Fresh product each pytest run so the counts we assert are deterministic."""
    sku = f"TEST-DEL-{uuid.uuid4().hex[:8]}"
    payload = {
        "name": f"TEST Delete Product {sku}",
        "sku": sku,
        "tile_width": 300,
        "tile_height": 300,
        "tiles_per_box": 4,
        "pin_session_token": pin_token,
    }
    r = requests.post(f"{API}/warehouse/products/quick-add", json=payload, headers=admin_hdr)
    assert r.status_code == 200, r.text
    return r.json()["product"]


def _wh_stock(admin_hdr, product_id):
    """Look up the product's current warehouse stock via /warehouse/products."""
    r = requests.get(f"{API}/warehouse/products", params={"q": product_id[:8]}, headers=admin_hdr)
    if r.status_code != 200:
        return None
    # Search by ID prefix might not match; fall back to fetching by sku search
    return None


def _wh_stock_by_sku(admin_hdr, sku, product_id):
    r = requests.get(f"{API}/warehouse/products", params={"q": sku}, headers=admin_hdr)
    assert r.status_code == 200
    matched = next((p for p in r.json()["products"] if p["id"] == product_id), None)
    return matched["warehouse_stock"] if matched else None


def _list_adjustments(admin_hdr, product_id, include_deleted=False):
    params = {"product_id": product_id, "limit": 100}
    if include_deleted:
        params["include_deleted"] = "true"
    r = requests.get(f"{API}/warehouse/adjustments", params=params, headers=admin_hdr)
    assert r.status_code == 200, r.text
    return r.json().get("adjustments") or []


def _adjust(admin_hdr, pin_token, product_id, mode, qty, reason="delivery_received"):
    payload = {
        "product_id": product_id,
        "mode": mode,
        "quantity": qty,
        "reason": reason,
        "pin_session_token": pin_token,
    }
    r = requests.post(f"{API}/warehouse/adjust", json=payload, headers=admin_hdr)
    assert r.status_code == 200, r.text
    return r.json()["adjustment"]


def _reverse(admin_hdr, pin_token, adj_id):
    r = requests.post(
        f"{API}/warehouse/adjustments/{adj_id}/reverse",
        json={"pin_session_token": pin_token, "note": "TEST delete"},
        headers=admin_hdr,
    )
    return r


# ---------------------------------------------------------------------------
# Scenario A — Regular row soft-delete
# ---------------------------------------------------------------------------

class TestRegularRowSoftDelete:
    def test_delete_a_regular_adjustment_removes_row_and_rolls_back_stock(
        self, admin_hdr, pin_token, product,
    ):
        # Book +10 on the fresh product (stock 0 → 10).
        adj = _adjust(admin_hdr, pin_token, product["id"], "delta", 10)
        adj_id = adj["id"]
        assert adj["delta"] == 10
        assert _wh_stock_by_sku(admin_hdr, product["sku"], product["id"]) == 10

        before_rows = _list_adjustments(admin_hdr, product["id"])
        before_count = len(before_rows)
        assert any(r["id"] == adj_id for r in before_rows)

        # Delete
        r = _reverse(admin_hdr, pin_token, adj_id)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["success"] is True
        assert adj_id in body["deleted_ids"]
        assert body["stock_delta_applied"] == -10

        # After: row gone, stock rolled back to 0
        after_rows = _list_adjustments(admin_hdr, product["id"])
        assert not any(r["id"] == adj_id for r in after_rows), \
            "deleted row must not appear in default /adjustments"
        assert len(after_rows) <= before_count - 1, \
            f"count must decrease (before={before_count} after={len(after_rows)})"
        assert _wh_stock_by_sku(admin_hdr, product["sku"], product["id"]) == 0

        # Regression: no NEW 'Reversed adj' compensating row should appear
        for r_row in after_rows:
            note = (r_row.get("note") or "").lower()
            reason = (r_row.get("reason") or "").lower()
            assert "reversed adj" not in note, f"unexpected compensating row: {r_row}"
            assert "reversal" not in reason, f"unexpected reversal reason row: {r_row}"

    def test_repeat_delete_returns_409(self, admin_hdr, pin_token, product):
        adj = _adjust(admin_hdr, pin_token, product["id"], "delta", 5)
        r1 = _reverse(admin_hdr, pin_token, adj["id"])
        assert r1.status_code == 200, r1.text
        r2 = _reverse(admin_hdr, pin_token, adj["id"])
        assert r2.status_code == 409, r2.text
        assert "already been deleted" in r2.json().get("detail", "").lower()

    def test_include_deleted_returns_soft_deleted_rows(
        self, admin_hdr, pin_token, product,
    ):
        adj = _adjust(admin_hdr, pin_token, product["id"], "delta", 3)
        _reverse(admin_hdr, pin_token, adj["id"])

        default_rows = _list_adjustments(admin_hdr, product["id"], include_deleted=False)
        assert not any(r["id"] == adj["id"] for r in default_rows)

        forensic_rows = _list_adjustments(admin_hdr, product["id"], include_deleted=True)
        found = next((r for r in forensic_rows if r["id"] == adj["id"]), None)
        assert found is not None, "?include_deleted=true must return soft-deleted rows"
        assert found.get("deleted_at"), "soft-deleted row should have deleted_at stamp"


# ---------------------------------------------------------------------------
# Scenario D — Legacy compensating-pair cascade cleanup
# ---------------------------------------------------------------------------

class TestLegacyReversedPairCascade:
    """Simulate the OLD compensation state by manually inserting a pair of
    warehouse_adjustments docs where original has reversed=true and points
    to a compensating row. Then POST /reverse on the ORIGINAL should
    soft-delete BOTH rows in one call."""

    def test_cascade_deletes_both_original_and_compensator(
        self, admin_hdr, pin_token, product,
    ):
        """Directly seed a legacy pair (original+reversed=true and its
        compensator with reverses_adjustment_id) via mongo, then verify
        POST /reverse on the ORIGINAL cascades to both."""
        import sys
        from datetime import datetime, timezone
        sys.path.insert(0, "/app/backend")
        import asyncio
        from motor.motor_asyncio import AsyncIOMotorClient
        mongo_url = os.environ.get("MONGO_URL")
        if not mongo_url:
            # Load /app/backend/.env
            for line in open("/app/backend/.env").readlines():
                if line.startswith("MONGO_URL="):
                    mongo_url = line.split("=", 1)[1].strip()
                if line.startswith("DB_NAME="):
                    os.environ["DB_NAME"] = line.split("=", 1)[1].strip()
        db_name = os.environ.get("DB_NAME", "test_database")
        client = AsyncIOMotorClient(mongo_url)
        db = client[db_name]

        # First take an initial adjustment via API so warehouse+product exist.
        adj = _adjust(admin_hdr, pin_token, product["id"], "delta", 20)
        wh_id = adj["warehouse_id"]

        # Seed legacy pair by hand.
        original_id = str(uuid.uuid4())
        comp_id = str(uuid.uuid4())
        now_iso = datetime.now(timezone.utc).isoformat()

        async def _seed():
            await db.warehouse_adjustments.insert_many([
                {
                    "id": original_id,
                    "product_id": product["id"],
                    "product_name": product["name"],
                    "warehouse_id": wh_id,
                    "before_qty": 0, "after_qty": 49, "delta": 49,
                    "mode": "batch", "reason": "batch_added",
                    "note": "TEST legacy original",
                    "actor_email": ADMIN_EMAIL,
                    "created_at": now_iso,
                    "reversed": True,
                    "reversed_adjustment_id": comp_id,
                    "reversed_at": now_iso,
                    "reversed_by_pin": "TEST",
                },
                {
                    "id": comp_id,
                    "product_id": product["id"],
                    "product_name": product["name"],
                    "warehouse_id": wh_id,
                    "before_qty": 49, "after_qty": 0, "delta": -49,
                    "mode": "reversal", "reason": "reversal",
                    "note": "Reversed adj " + original_id[:8],
                    "actor_email": ADMIN_EMAIL,
                    "created_at": now_iso,
                    "reverses_adjustment_id": original_id,
                },
            ])
        asyncio.get_event_loop().run_until_complete(_seed())

        # Confirm both rows visible.
        rows_before = _list_adjustments(admin_hdr, product["id"])
        ids_before = {r["id"] for r in rows_before}
        assert original_id in ids_before and comp_id in ids_before

        # Delete original — should cascade to comp
        r = _reverse(admin_hdr, pin_token, original_id)
        assert r.status_code == 200, r.text
        body = r.json()
        deleted_ids = body.get("deleted_ids") or []
        assert original_id in deleted_ids
        assert comp_id in deleted_ids, f"compensator must cascade, got {deleted_ids}"
        assert body.get("stock_delta_applied") == 0, \
            f"pair should net to zero, got stock_delta_applied={body.get('stock_delta_applied')}"

        # Both gone from default view
        rows_after = _list_adjustments(admin_hdr, product["id"])
        ids_after = {r["id"] for r in rows_after}
        assert original_id not in ids_after
        assert comp_id not in ids_after

        client.close()

    def test_delete_compensator_only_unreverses_target(
        self, admin_hdr, pin_token, product,
    ):
        """Seed target(reversed=true) + compensator(reverses_adjustment_id),
        then delete THE COMPENSATOR only. Target should get its `reversed`
        flag unset and reappear in the default list."""
        import sys
        from datetime import datetime, timezone
        sys.path.insert(0, "/app/backend")
        import asyncio
        from motor.motor_asyncio import AsyncIOMotorClient
        mongo_url = os.environ.get("MONGO_URL")
        if not mongo_url:
            for line in open("/app/backend/.env").readlines():
                if line.startswith("MONGO_URL="):
                    mongo_url = line.split("=", 1)[1].strip()
                if line.startswith("DB_NAME="):
                    os.environ["DB_NAME"] = line.split("=", 1)[1].strip()
        db_name = os.environ.get("DB_NAME", "test_database")
        client = AsyncIOMotorClient(mongo_url)
        db = client[db_name]

        # Anchor a real adjustment for warehouse_id + stock context
        adj = _adjust(admin_hdr, pin_token, product["id"], "delta", 5)
        wh_id = adj["warehouse_id"]

        # Current stock BEFORE seeding legacy pair
        stock_pre = _wh_stock_by_sku(admin_hdr, product["sku"], product["id"])

        target_id = str(uuid.uuid4())
        comp_id = str(uuid.uuid4())
        now_iso = datetime.now(timezone.utc).isoformat()

        async def _seed():
            await db.warehouse_adjustments.insert_many([
                {
                    "id": target_id,
                    "product_id": product["id"],
                    "product_name": product["name"],
                    "warehouse_id": wh_id,
                    "before_qty": 0, "after_qty": 7, "delta": 7,
                    "mode": "delta", "reason": "delivery_received",
                    "note": "TEST target",
                    "actor_email": ADMIN_EMAIL,
                    "created_at": now_iso,
                    "reversed": True,
                    "reversed_adjustment_id": comp_id,
                },
                {
                    "id": comp_id,
                    "product_id": product["id"],
                    "product_name": product["name"],
                    "warehouse_id": wh_id,
                    "before_qty": 7, "after_qty": 0, "delta": -7,
                    "mode": "reversal", "reason": "reversal",
                    "note": "Reversed adj " + target_id[:8],
                    "actor_email": ADMIN_EMAIL,
                    "created_at": now_iso,
                    "reverses_adjustment_id": target_id,
                },
            ])
        asyncio.get_event_loop().run_until_complete(_seed())

        # Delete the compensator only
        r = _reverse(admin_hdr, pin_token, comp_id)
        assert r.status_code == 200, r.text
        body = r.json()
        # Only comp should be in deleted_ids (target un-reversed, not deleted)
        assert comp_id in body["deleted_ids"]
        assert target_id not in body["deleted_ids"], \
            "deleting compensator must NOT delete the target"
        # Stock: compensator delta was -7, roll back is +7
        assert body.get("stock_delta_applied") == 7, \
            f"expected +7 rollback, got {body.get('stock_delta_applied')}"

        # Target should be back in default list, un-reversed
        rows = _list_adjustments(admin_hdr, product["id"])
        target_row = next((r_ for r_ in rows if r_["id"] == target_id), None)
        assert target_row is not None, \
            "target must reappear in default /adjustments after compensator delete"
        assert not target_row.get("reversed"), \
            f"target.reversed must be unset, got: {target_row.get('reversed')}"
        assert not target_row.get("reversed_adjustment_id")

        # Stock rolled UP by 7
        stock_post = _wh_stock_by_sku(admin_hdr, product["sku"], product["id"])
        assert stock_post == stock_pre + 7, \
            f"stock should have rolled back +7 (was {stock_pre}, now {stock_post})"

        client.close()


# ---------------------------------------------------------------------------
# Scenario F — PIN gating on /pin-session
# ---------------------------------------------------------------------------

class TestPinGate:
    def test_unauth_pin_denied_at_pin_session(self, admin_hdr, unauth_pin):
        r = requests.post(
            f"{API}/warehouse/pin-session",
            json={"pin": unauth_pin["pin"]},
            headers=admin_hdr,
        )
        assert r.status_code == 403, r.text
        detail = r.json().get("detail", "")
        assert "warehouse" in detail.lower() or "permission" in detail.lower()


# ---------------------------------------------------------------------------
# Scenario C — Row count monotonically decreases (never increases)
# ---------------------------------------------------------------------------

class TestRowCountMonotonicity:
    def test_delete_decreases_visible_row_count(
        self, admin_hdr, pin_token, product,
    ):
        # Baseline
        before = _list_adjustments(admin_hdr, product["id"])
        # Book one adjustment
        adj = _adjust(admin_hdr, pin_token, product["id"], "delta", 1)
        after_add = _list_adjustments(admin_hdr, product["id"])
        assert len(after_add) == len(before) + 1

        # Delete the row we just added
        r = _reverse(admin_hdr, pin_token, adj["id"])
        assert r.status_code == 200
        after_del = _list_adjustments(admin_hdr, product["id"])
        # Count went DOWN by 1 vs. after_add (net = same as before or lower)
        assert len(after_del) == len(after_add) - 1
        assert len(after_del) <= len(before)

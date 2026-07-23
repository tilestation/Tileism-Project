"""Iter 197 backend verification — GET /api/warehouse/products/{id}/batches
now enriches each batch with `total_m2` when the product has either
`sqm_per_piece` or tile_width+tile_height.

Contract (per owner req 23 Jul 2026):
  • Batch total_m2 = round(total_pieces * sqm_per_piece, 2), OR fall back
    to tile_width*tile_height/1_000_000 when sqm_per_piece is missing.
  • When product has NEITHER sqm_per_piece NOR tile dims: endpoint still
    returns 200 with batches list; total_m2 must simply be absent.
  • Adjustments list must continue to filter deleted_at rows by default
    (regression from iter196).
"""

import os
import uuid
import pytest
import requests
import asyncio
from motor.motor_asyncio import AsyncIOMotorClient

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
API = f"{BASE_URL}/api"
ADMIN_EMAIL = "admin@test.com"
ADMIN_PASSWORD = "admin123"


def _login(email, password):
    r = requests.post(f"{API}/auth/login", json={"email": email, "password": password})
    if r.status_code != 200:
        pytest.skip(f"login failed: {r.status_code} {r.text}")
    return r.json()["token"]


@pytest.fixture(scope="module")
def admin_hdr():
    return {"Authorization": f"Bearer {_login(ADMIN_EMAIL, ADMIN_PASSWORD)}"}


def _random_pin(admin_hdr):
    r = requests.get(f"{API}/staff-pins", headers=admin_hdr)
    used = set()
    if r.status_code == 200:
        for row in (r.json() or []):
            if row.get("pin"):
                used.add(str(row["pin"]))
    import random
    for _ in range(2000):
        candidate = str(random.randint(10000, 99999))
        if candidate not in used:
            return candidate
    raise RuntimeError("no free 5-digit PIN")


@pytest.fixture(scope="module")
def staff_pin(admin_hdr):
    pin = _random_pin(admin_hdr)
    payload = {
        "name": f"TEST WH M2 PIN {uuid.uuid4().hex[:4]}",
        "pin": pin, "role": "admin", "active": True,
        "can_manage_warehouse": True,
    }
    r = requests.post(f"{API}/staff-pins", json=payload, headers=admin_hdr)
    assert r.status_code in (200, 201), r.text
    row = r.json(); row["pin"] = pin
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
    assert r.status_code == 200, r.text
    return r.json()["session_token"]


def _mongo_env():
    mongo_url = os.environ.get("MONGO_URL")
    db_name = os.environ.get("DB_NAME")
    if not mongo_url or not db_name:
        for line in open("/app/backend/.env"):
            if line.startswith("MONGO_URL="):
                mongo_url = mongo_url or line.split("=", 1)[1].strip()
            if line.startswith("DB_NAME="):
                db_name = db_name or line.split("=", 1)[1].strip()
    return mongo_url, db_name


def _quick_add(admin_hdr, pin_token, **overrides):
    sku = overrides.pop("sku", f"TEST-M2-{uuid.uuid4().hex[:8]}")
    payload = {
        "name": overrides.pop("name", f"TEST M2 Product {sku}"),
        "sku": sku,
        "pin_session_token": pin_token,
        **overrides,
    }
    r = requests.post(f"{API}/warehouse/products/quick-add", json=payload, headers=admin_hdr)
    assert r.status_code == 200, r.text
    return r.json()["product"]


def _add_batch(admin_hdr, pin_token, product_id, pieces, tiles_per_box=1, batch_number=None):
    payload = {
        "product_id": product_id,
        "batch_number": batch_number or f"BN-{uuid.uuid4().hex[:6]}",
        "boxes": 0,
        "tiles_per_box": tiles_per_box,
        "extra_pieces": pieces,
        "pin_session_token": pin_token,
    }
    r = requests.post(f"{API}/warehouse/batches", json=payload, headers=admin_hdr)
    assert r.status_code == 200, r.text
    return r.json()["batch"]


# ---------------------------------------------------------------------------
# Total m² enrichment
# ---------------------------------------------------------------------------

class TestBatchM2Enrichment:
    def test_total_m2_from_sqm_per_piece(self, admin_hdr, pin_token):
        """Product with sqm_per_piece=0.36 + batch of 10 pieces → total_m2 == 3.60."""
        product = _quick_add(admin_hdr, pin_token)
        pid = product["id"]

        # Attach sqm_per_piece directly via mongo — quick-add doesn't take it.
        mongo_url, db_name = _mongo_env()
        client = AsyncIOMotorClient(mongo_url)
        db = client[db_name]

        async def _set_sqm():
            await db.products.update_one(
                {"id": pid},
                {"$set": {"sqm_per_piece": 0.36}, "$unset": {"tile_width": "", "tile_height": ""}},
            )
        asyncio.get_event_loop().run_until_complete(_set_sqm())

        _add_batch(admin_hdr, pin_token, pid, pieces=10)
        r = requests.get(f"{API}/warehouse/products/{pid}/batches", headers=admin_hdr)
        assert r.status_code == 200, r.text
        batches = r.json()["batches"]
        assert len(batches) == 1
        b = batches[0]
        assert b["total_pieces"] == 10
        assert "total_m2" in b, f"total_m2 missing when sqm_per_piece is set: {b}"
        # Round to 2dp for floating-point tolerance
        assert round(float(b["total_m2"]), 2) == 3.60, f"expected 3.60, got {b['total_m2']}"

        client.close()

    def test_total_m2_from_tile_dimensions_fallback(self, admin_hdr, pin_token):
        """Product with tile_width=600, tile_height=600 (no sqm_per_piece)
        + batch of 10 pieces → total_m2 == 3.60 (0.36 per piece × 10)."""
        product = _quick_add(
            admin_hdr, pin_token,
            tile_width=600, tile_height=600,
        )
        pid = product["id"]

        # Ensure sqm_per_piece is unset so the fallback path is taken.
        mongo_url, db_name = _mongo_env()
        client = AsyncIOMotorClient(mongo_url)
        db = client[db_name]
        async def _unset():
            await db.products.update_one({"id": pid}, {"$unset": {"sqm_per_piece": ""}})
        asyncio.get_event_loop().run_until_complete(_unset())

        _add_batch(admin_hdr, pin_token, pid, pieces=10)
        r = requests.get(f"{API}/warehouse/products/{pid}/batches", headers=admin_hdr)
        assert r.status_code == 200, r.text
        b = r.json()["batches"][0]
        assert b["total_pieces"] == 10
        assert "total_m2" in b, f"total_m2 missing on tile_dims fallback: {b}"
        assert round(float(b["total_m2"]), 2) == 3.60, f"expected 3.60, got {b['total_m2']}"
        client.close()

    def test_no_sqm_no_dims_omits_total_m2(self, admin_hdr, pin_token):
        """Product with NEITHER sqm_per_piece NOR tile dims → endpoint 200,
        batch present, but total_m2 absent from batch dict."""
        product = _quick_add(admin_hdr, pin_token)
        pid = product["id"]

        # Explicitly strip both fields.
        mongo_url, db_name = _mongo_env()
        client = AsyncIOMotorClient(mongo_url)
        db = client[db_name]

        async def _strip():
            await db.products.update_one(
                {"id": pid},
                {"$unset": {
                    "sqm_per_piece": "", "tile_width": "", "tile_height": "",
                    "tile_m2_per_piece": "",
                }},
            )
        asyncio.get_event_loop().run_until_complete(_strip())

        _add_batch(admin_hdr, pin_token, pid, pieces=5)
        r = requests.get(f"{API}/warehouse/products/{pid}/batches", headers=admin_hdr)
        assert r.status_code == 200, r.text
        batches = r.json()["batches"]
        assert len(batches) == 1
        b = batches[0]
        assert b["total_pieces"] == 5
        assert "total_m2" not in b, f"total_m2 must be absent when product has no coverage info, got: {b}"

        client.close()

    def test_endpoint_never_500s_with_bad_sqm_value(self, admin_hdr, pin_token):
        """If sqm_per_piece is a non-numeric string, endpoint must not raise 500."""
        product = _quick_add(admin_hdr, pin_token)
        pid = product["id"]

        mongo_url, db_name = _mongo_env()
        client = AsyncIOMotorClient(mongo_url)
        db = client[db_name]
        async def _corrupt():
            await db.products.update_one(
                {"id": pid},
                {"$set": {"sqm_per_piece": "not_a_number"},
                 "$unset": {"tile_width": "", "tile_height": ""}},
            )
        asyncio.get_event_loop().run_until_complete(_corrupt())

        _add_batch(admin_hdr, pin_token, pid, pieces=3)
        r = requests.get(f"{API}/warehouse/products/{pid}/batches", headers=admin_hdr)
        assert r.status_code == 200, f"expected 200 despite bad sqm value, got {r.status_code}: {r.text}"
        b = r.json()["batches"][0]
        # total_m2 should be absent since coercion failed.
        assert "total_m2" not in b
        client.close()


# ---------------------------------------------------------------------------
# Iter198 — Search endpoint (/warehouse/products?q=) must also enrich
# embedded batches with total_m2, otherwise the BatchesPanel silently drops
# the m² subtotal because it reads product.batches from the search response.
# ---------------------------------------------------------------------------


class TestSearchEndpointBatchM2Enrichment:
    def test_search_batches_total_m2_from_sqm_per_piece(self, admin_hdr, pin_token):
        """Search endpoint: product with sqm_per_piece=0.36 + batch of 10 pieces
        → product.batches[0].total_m2 == 3.60."""
        product = _quick_add(admin_hdr, pin_token)
        pid = product["id"]
        sku = product["sku"]

        mongo_url, db_name = _mongo_env()
        client = AsyncIOMotorClient(mongo_url)
        db = client[db_name]
        async def _set_sqm():
            await db.products.update_one(
                {"id": pid},
                {"$set": {"sqm_per_piece": 0.36},
                 "$unset": {"tile_width": "", "tile_height": "", "tile_m2_per_piece": ""}},
            )
        asyncio.get_event_loop().run_until_complete(_set_sqm())

        _add_batch(admin_hdr, pin_token, pid, pieces=10)

        r = requests.get(f"{API}/warehouse/products", params={"q": sku}, headers=admin_hdr)
        assert r.status_code == 200, r.text
        products = r.json()["products"]
        assert products, f"search returned no products for q={sku}"
        target = next((p for p in products if p["id"] == pid), None)
        assert target, f"product {pid} missing from search results"
        assert target["batches"], "batches array empty on search response"
        b = target["batches"][0]
        assert b["total_pieces"] == 10
        assert "total_m2" in b, f"total_m2 missing from search-endpoint batch: {b}"
        assert round(float(b["total_m2"]), 2) == 3.60, (
            f"expected 3.60 m² on search-endpoint batch, got {b['total_m2']}"
        )
        client.close()

    def test_search_batches_total_m2_from_tile_dims_fallback(self, admin_hdr, pin_token):
        """Search endpoint: product with tile_width=600, tile_height=600
        (no sqm_per_piece) + batch of 5 pieces → total_m2 == 1.80."""
        product = _quick_add(
            admin_hdr, pin_token,
            tile_width=600, tile_height=600,
        )
        pid = product["id"]
        sku = product["sku"]

        mongo_url, db_name = _mongo_env()
        client = AsyncIOMotorClient(mongo_url)
        db = client[db_name]
        async def _unset():
            await db.products.update_one(
                {"id": pid},
                {"$unset": {"sqm_per_piece": "", "tile_m2_per_piece": ""}},
            )
        asyncio.get_event_loop().run_until_complete(_unset())

        _add_batch(admin_hdr, pin_token, pid, pieces=5)

        r = requests.get(f"{API}/warehouse/products", params={"q": sku}, headers=admin_hdr)
        assert r.status_code == 200, r.text
        target = next((p for p in r.json()["products"] if p["id"] == pid), None)
        assert target, f"product {pid} missing from search results"
        assert target["batches"], "batches array empty on search response"
        b = target["batches"][0]
        assert b["total_pieces"] == 5
        assert "total_m2" in b, f"total_m2 missing on tile-dim fallback: {b}"
        assert round(float(b["total_m2"]), 2) == 1.80, (
            f"expected 1.80 m², got {b['total_m2']}"
        )
        client.close()

    def test_search_batches_no_sqm_no_dims_endpoint_200(self, admin_hdr, pin_token):
        """Search endpoint: product with NEITHER sqm_per_piece NOR tile dims
        → endpoint returns 200; batches present without total_m2."""
        product = _quick_add(admin_hdr, pin_token)
        pid = product["id"]
        sku = product["sku"]

        mongo_url, db_name = _mongo_env()
        client = AsyncIOMotorClient(mongo_url)
        db = client[db_name]
        async def _strip():
            await db.products.update_one(
                {"id": pid},
                {"$unset": {
                    "sqm_per_piece": "", "tile_width": "", "tile_height": "",
                    "tile_m2_per_piece": "",
                }},
            )
        asyncio.get_event_loop().run_until_complete(_strip())

        _add_batch(admin_hdr, pin_token, pid, pieces=7)

        r = requests.get(f"{API}/warehouse/products", params={"q": sku}, headers=admin_hdr)
        assert r.status_code == 200, r.text
        target = next((p for p in r.json()["products"] if p["id"] == pid), None)
        assert target, f"product {pid} missing from search results"
        assert target["batches"], "batches empty"
        b = target["batches"][0]
        assert b["total_pieces"] == 7
        assert "total_m2" not in b, (
            f"total_m2 must be absent when product has no coverage info, got: {b}"
        )
        client.close()


# ---------------------------------------------------------------------------
# Regression: GET /adjustments filters deleted_at by default (iter196 fix)
# ---------------------------------------------------------------------------

class TestAdjustmentsSoftDeleteFilterRegression:
    def test_deleted_rows_hidden_by_default(self, admin_hdr, pin_token):
        product = _quick_add(admin_hdr, pin_token)
        pid = product["id"]

        # Create one adjustment then delete it.
        r = requests.post(
            f"{API}/warehouse/adjust",
            json={
                "product_id": pid, "mode": "delta", "quantity": 4,
                "reason": "delivery_received", "pin_session_token": pin_token,
            },
            headers=admin_hdr,
        )
        assert r.status_code == 200, r.text
        adj_id = r.json()["adjustment"]["id"]

        # Reverse (soft-delete)
        r = requests.post(
            f"{API}/warehouse/adjustments/{adj_id}/reverse",
            json={"pin_session_token": pin_token, "note": "cleanup"},
            headers=admin_hdr,
        )
        assert r.status_code == 200, r.text

        # Default GET must not contain the deleted row
        r = requests.get(f"{API}/warehouse/adjustments",
                         params={"product_id": pid, "limit": 100},
                         headers=admin_hdr)
        assert r.status_code == 200
        rows = r.json()["adjustments"]
        assert not any(r_["id"] == adj_id for r_ in rows), \
            "soft-deleted row must NOT appear by default"

        # include_deleted=true recovers it
        r = requests.get(f"{API}/warehouse/adjustments",
                         params={"product_id": pid, "limit": 100, "include_deleted": "true"},
                         headers=admin_hdr)
        assert r.status_code == 200
        rows = r.json()["adjustments"]
        assert any(r_["id"] == adj_id and r_.get("deleted_at") for r_ in rows), \
            "?include_deleted=true must return soft-deleted rows with deleted_at stamped"

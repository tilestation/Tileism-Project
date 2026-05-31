"""Tune-in heartbeat tests — Radio Studio.

Verifies:
  1. Public heartbeat upserts a device row keyed by device_id.
  2. Admin /status returns active count + device list within the
     90-second window, excludes stale heartbeats, and never crashes
     when the playlist is missing/empty.
  3. /reset wipes the collection.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from httpx import ASGITransport, AsyncClient

os.environ.setdefault("DB_NAME", "test_db_radio_tunein")

from server import app  # noqa: E402
from config import get_db  # noqa: E402


@pytest.mark.asyncio
async def test_heartbeat_upserts_device_row():
    db = get_db()
    device_id = f"test-dev-{uuid.uuid4().hex[:12]}"
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            r1 = await client.post(
                "/api/radio-studio/tune-in/heartbeat",
                json={"device_id": device_id, "device_label": "Tonbridge FOH"},
            )
            assert r1.status_code == 200, r1.text
            assert r1.json()["device_id"] == device_id

            # Second ping for the SAME device → still one row (upsert)
            r2 = await client.post(
                "/api/radio-studio/tune-in/heartbeat",
                json={"device_id": device_id, "device_label": "Tonbridge FOH"},
            )
            assert r2.status_code == 200
            count = await db.radio_tune_in_heartbeats.count_documents({"device_id": device_id})
            assert count == 1

            row = await db.radio_tune_in_heartbeats.find_one(
                {"device_id": device_id}, {"_id": 0}
            )
            assert row["device_label"] == "Tonbridge FOH"
            assert "last_seen_at" in row
            assert "first_seen_at" in row
    finally:
        await db.radio_tune_in_heartbeats.delete_many({"device_id": device_id})


@pytest.mark.asyncio
async def test_status_returns_active_devices_excludes_stale():
    """Insert one fresh + one stale heartbeat, ensure /status returns
    only the fresh one in active_count."""
    db = get_db()
    fresh_id = f"test-fresh-{uuid.uuid4().hex[:8]}"
    stale_id = f"test-stale-{uuid.uuid4().hex[:8]}"
    now_iso = datetime.now(timezone.utc).isoformat()
    long_ago = (datetime.now(timezone.utc) - timedelta(seconds=600)).isoformat()
    await db.radio_tune_in_heartbeats.insert_many([
        {
            "device_id": fresh_id,
            "device_label": "Fresh device",
            "last_seen_at": now_iso,
            "first_seen_at": now_iso,
        },
        {
            "device_id": stale_id,
            "device_label": "Stale device",
            "last_seen_at": long_ago,
            "first_seen_at": long_ago,
        },
    ])
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            login = await client.post(
                "/api/auth/login",
                json={"email": "admin@test.com", "password": "admin123"},
            )
            token = login.json()["token"]
            r = await client.get(
                "/api/admin/radio-studio/tune-in/status",
                headers={"Authorization": f"Bearer {token}"},
            )
            assert r.status_code == 200, r.text
            data = r.json()
            assert data["active_window_seconds"] == 90
            # active_count includes our fresh row; may include other concurrent
            # devices from other tests — but it MUST NOT include the stale one.
            assert data["active_count"] >= 1
            ids = [d["device_id"] for d in data["devices"]]
            assert fresh_id in ids
            assert stale_id not in ids
    finally:
        await db.radio_tune_in_heartbeats.delete_many(
            {"device_id": {"$in": [fresh_id, stale_id]}}
        )


@pytest.mark.asyncio
async def test_status_requires_admin():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        r = await client.get("/api/admin/radio-studio/tune-in/status")
        # 401 or 403 depending on auth middleware; just not 200
        assert r.status_code in (401, 403)


@pytest.mark.asyncio
async def test_reset_wipes_heartbeats():
    db = get_db()
    seed_id = f"test-reset-{uuid.uuid4().hex[:8]}"
    now_iso = datetime.now(timezone.utc).isoformat()
    await db.radio_tune_in_heartbeats.insert_one({
        "device_id": seed_id,
        "last_seen_at": now_iso,
        "first_seen_at": now_iso,
    })
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        login = await client.post(
            "/api/auth/login",
            json={"email": "admin@test.com", "password": "admin123"},
        )
        token = login.json()["token"]
        r = await client.post(
            "/api/admin/radio-studio/tune-in/reset",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 200
        assert r.json()["ok"] is True
    leftover = await db.radio_tune_in_heartbeats.count_documents({"device_id": seed_id})
    assert leftover == 0


@pytest.mark.asyncio
async def test_heartbeat_validation_rejects_short_device_id():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        r = await client.post(
            "/api/radio-studio/tune-in/heartbeat",
            json={"device_id": "x"},  # min_length=4
        )
        assert r.status_code == 422

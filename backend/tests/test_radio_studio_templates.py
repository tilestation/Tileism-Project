"""Save-as-Template + Recent visitor questions tests."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone, timedelta

import pytest
from httpx import ASGITransport, AsyncClient

os.environ.setdefault("DB_NAME", "test_db_radio_templates")

from server import app  # noqa: E402
from config import get_db  # noqa: E402


async def _login_admin(client: AsyncClient) -> str:
    r = await client.post(
        "/api/auth/login",
        json={"email": "admin@test.com", "password": "admin123"},
    )
    return r.json()["token"]


# ----------------------------------------------------------------- save-as-template


@pytest.mark.asyncio
async def test_save_qa_ad_as_template_strips_per_instance_fields():
    """Promoting a Q&A ad to a template must keep editorial content
    (script, question) but drop audio + voice IDs so each clone
    picks fresh voices."""
    db = get_db()
    ad_id = f"test_tpl_qa_{uuid.uuid4().hex[:8]}"
    now_iso = datetime.now(timezone.utc).isoformat()
    await db.radio_studio_ads.insert_one({
        "id": ad_id,
        "name": "Best grout for shower?",
        "kind": "qa",
        "script": "Use Mapei Ultracolor Plus FA — water-resistant + 26 colours.",
        "question": "What's the best grout for a shower?",
        "narrate_question": True,
        "voice_id": "21m00Tcm4TlvDq8ikWAM",
        "voice_name": "Rachel",
        "audio_filename": f"{ad_id}.mp3",
        "audio_blob": b"\xff\xfb" + b"\x00" * 200,
        "duration_seconds": 18,
        "created_at": now_iso,
    })
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            token = await _login_admin(client)
            r = await client.post(
                f"/api/admin/radio-studio/ads/{ad_id}/save-as-template",
                headers={"Authorization": f"Bearer {token}"},
            )
            assert r.status_code == 200, r.text
            data = r.json()
            assert data["ok"] is True
            assert data["kind"] == "qa"
            tpl_id = data["template_id"]
            tpl = await db.radio_studio_templates.find_one({"id": tpl_id}, {"_id": 0})
            assert tpl["script"].startswith("Use Mapei")
            assert tpl["question"] == "What's the best grout for a shower?"
            # Per-instance fields should NOT be present
            assert "audio_filename" not in tpl
            assert "audio_blob" not in tpl
            assert "voice_id" not in tpl
    finally:
        await db.radio_studio_ads.delete_many({"id": ad_id})
        await db.radio_studio_templates.delete_many({"source_ad_id": ad_id})


@pytest.mark.asyncio
async def test_save_as_template_is_idempotent():
    """Saving the same ad twice → only one template row (upsert on source_ad_id)."""
    db = get_db()
    ad_id = f"test_tpl_idem_{uuid.uuid4().hex[:8]}"
    await db.radio_studio_ads.insert_one({
        "id": ad_id,
        "name": "Idem test",
        "kind": "qa",
        "script": "test",
        "question": "test?",
    })
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            token = await _login_admin(client)
            for _ in range(3):
                r = await client.post(
                    f"/api/admin/radio-studio/ads/{ad_id}/save-as-template",
                    headers={"Authorization": f"Bearer {token}"},
                )
                assert r.status_code == 200
            count = await db.radio_studio_templates.count_documents({"source_ad_id": ad_id})
            assert count == 1, "Triple-save should yield exactly ONE template row"
    finally:
        await db.radio_studio_ads.delete_many({"id": ad_id})
        await db.radio_studio_templates.delete_many({"source_ad_id": ad_id})


@pytest.mark.asyncio
async def test_save_as_template_rejects_plain_ad_kind():
    """Only Q&A and Trade Talk can become templates — plain 'ad'
    items are too voice-specific to template usefully."""
    db = get_db()
    ad_id = f"test_tpl_ad_{uuid.uuid4().hex[:8]}"
    await db.radio_studio_ads.insert_one({
        "id": ad_id,
        "name": "Promo ad",
        "kind": "ad",
        "script": "Test promo",
    })
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            token = await _login_admin(client)
            r = await client.post(
                f"/api/admin/radio-studio/ads/{ad_id}/save-as-template",
                headers={"Authorization": f"Bearer {token}"},
            )
            assert r.status_code == 400
    finally:
        await db.radio_studio_ads.delete_many({"id": ad_id})


@pytest.mark.asyncio
async def test_apply_template_creates_fresh_ad_without_audio():
    """Applying a template must create a NEW ad doc with the editorial
    content but no voice_id / audio — the admin picks voices then
    clicks Generate."""
    db = get_db()
    tpl_id = uuid.uuid4().hex
    await db.radio_studio_templates.insert_one({
        "id": tpl_id,
        "source_ad_id": "src",
        "kind": "qa",
        "name": "Test template",
        "script": "The answer text.",
        "question": "The question text?",
        "narrate_question": True,
        "turns": [],
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    transport = ASGITransport(app=app)
    new_ad_id = None
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            token = await _login_admin(client)
            r = await client.post(
                f"/api/admin/radio-studio/templates/{tpl_id}/apply",
                headers={"Authorization": f"Bearer {token}"},
            )
            assert r.status_code == 200, r.text
            ad = r.json()["ad"]
            new_ad_id = ad["id"]
            assert ad["kind"] == "qa"
            assert ad["script"] == "The answer text."
            assert ad["voice_id"] == ""
            assert ad["audio_filename"] is None
            assert ad["from_template_id"] == tpl_id
    finally:
        await db.radio_studio_templates.delete_many({"id": tpl_id})
        if new_ad_id:
            await db.radio_studio_ads.delete_many({"id": new_ad_id})


# --------------------------------------------------------------- recent visitor questions


@pytest.mark.asyncio
async def test_recent_visitor_questions_filters_to_actual_questions():
    """Picks up real questions, ignores statements + non-question
    chatter ('hi', 'thanks')."""
    db = get_db()
    session_id = f"test-sess-{uuid.uuid4().hex[:8]}"
    base = datetime.now(timezone.utc)
    seed_msgs = [
        ("Hi there", False),
        ("Thanks!", False),
        ("What's the best adhesive for porcelain?", True),
        ("Can I tile onto plasterboard in a shower?", True),
        ("how do I cut a 20mm porcelain slab", True),  # no question mark; starts with "how"
        ("Sure, I'll come tomorrow.", False),
    ]
    docs = []
    for i, (msg, _is_q) in enumerate(seed_msgs):
        docs.append({
            "session_id": session_id,
            "sender": "visitor",
            "message": msg,
            "created_at": (base - timedelta(minutes=i)).isoformat(),
            "timestamp": (base - timedelta(minutes=i)).isoformat(),
        })
    await db.chat_messages.insert_many(docs)
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            token = await _login_admin(client)
            r = await client.get(
                "/api/admin/radio-studio/recent-visitor-questions",
                headers={"Authorization": f"Bearer {token}"},
            )
            assert r.status_code == 200, r.text
            data = r.json()
            texts = [q["text"] for q in data["questions"]]
            assert any("porcelain" in t.lower() and t.endswith("?") for t in texts)
            assert any("plasterboard" in t.lower() for t in texts)
            assert any(t.lower().startswith("how do i cut") for t in texts)
            # Non-questions should NOT appear
            assert all("hi there" != t.lower() for t in texts)
            assert all("thanks" not in t.lower() for t in texts)
    finally:
        await db.chat_messages.delete_many({"session_id": session_id})


@pytest.mark.asyncio
async def test_recent_visitor_questions_filters_out_existing_qa():
    """If a question is already saved as a Q&A name/question, it
    should NOT appear in the suggestion list (no duplicates)."""
    db = get_db()
    session_id = f"test-sess-dup-{uuid.uuid4().hex[:8]}"
    qa_id = f"test_qa_dup_{uuid.uuid4().hex[:8]}"
    base = datetime.now(timezone.utc)
    await db.chat_messages.insert_one({
        "session_id": session_id,
        "sender": "visitor",
        "message": "What's the best grout for a shower?",
        "created_at": base.isoformat(),
        "timestamp": base.isoformat(),
    })
    await db.radio_studio_ads.insert_one({
        "id": qa_id,
        "kind": "qa",
        "name": "What's the best grout for a shower",
        "question": "What's the best grout for a shower?",
        "script": "Mapei Ultracolor.",
    })
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            token = await _login_admin(client)
            r = await client.get(
                "/api/admin/radio-studio/recent-visitor-questions",
                headers={"Authorization": f"Bearer {token}"},
            )
            assert r.status_code == 200
            texts = [q["text"].lower() for q in r.json()["questions"]]
            assert all("best grout for a shower" not in t for t in texts), (
                "Duplicate Q&A should be filtered out"
            )
    finally:
        await db.chat_messages.delete_many({"session_id": session_id})
        await db.radio_studio_ads.delete_many({"id": qa_id})


@pytest.mark.asyncio
async def test_recent_visitor_questions_requires_admin():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        r = await client.get("/api/admin/radio-studio/recent-visitor-questions")
        assert r.status_code in (401, 403)

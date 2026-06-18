"""
Regression test for the "Missed online chat doesn't go to customers" bug
(18 Jun 2026).

Root cause:
    `live_chat.admin_reply` (and its WS twin) only pushed the admin's reply
    to the visitor over a WebSocket. When the visitor closed the tab — which
    is exactly what "missed chat" means — the reply was effectively swallowed
    and the customer never saw it.

Contract pinned by these tests:
    1. `send_admin_reply_to_visitor_email` exists and is importable.
    2. It is a no-op (sent=False, reason='no_visitor_email') when the chat
       session has no `visitor_email` on file — we never silently email a
       blank string.
    3. It is a no-op (reason='visitor_online') when the visitor has an
       active WebSocket connection — the WS already delivered the message.
    4. It is a no-op (reason='rate_limited') when called twice for the
       same session within 60s, so back-to-back admin replies coalesce.
    5. The HTTP `admin_reply` route schedules an email send via
       `asyncio.create_task(send_admin_reply_to_visitor_email(...))`.
    6. There is a manual `POST /sessions/{id}/email-last-reply` endpoint
       so staff can force-send the last reply to the visitor.
"""
from __future__ import annotations

import inspect
import re
import uuid
from datetime import datetime, timezone

import pytest


def test_helper_is_importable():
    from routes.live_chat import send_admin_reply_to_visitor_email
    assert callable(send_admin_reply_to_visitor_email)


def test_admin_reply_route_schedules_email():
    from routes import live_chat
    src = inspect.getsource(live_chat.admin_reply)
    assert re.search(
        r"asyncio\.create_task\(\s*send_admin_reply_to_visitor_email\(",
        src,
    ), (
        "admin_reply must schedule send_admin_reply_to_visitor_email so the "
        "customer receives an email when the visitor's WebSocket is gone"
    )


def test_ws_admin_reply_path_also_schedules_email():
    from routes import live_chat
    src = inspect.getsource(live_chat.websocket_admin)
    assert "send_admin_reply_to_visitor_email" in src, (
        "the WS /ws/admin reply branch must mirror the HTTP /reply behaviour "
        "and email the visitor on missed chats"
    )


def test_manual_resend_endpoint_exists():
    from routes import live_chat
    src = inspect.getsource(live_chat.email_last_admin_reply_to_visitor)
    # Forces past the rate-limit so staff can always re-send.
    assert "force=True" in src, (
        "manual resend endpoint should bypass the 60s rate-limit"
    )


@pytest.mark.asyncio
async def test_helper_skips_when_no_visitor_email():
    from routes.live_chat import send_admin_reply_to_visitor_email

    class _Cursor:
        async def find_one(self, *_args, **_kwargs):
            return None  # no last_visitor_message — not reached anyway

    class _StubDb:
        chat_messages = _Cursor()
        chat_sessions = _Cursor()

    session = {"session_id": "stub-no-email", "visitor_email": ""}
    admin_msg = {"id": "m1", "sender_name": "Bob", "message": "hello"}

    result = await send_admin_reply_to_visitor_email(session, admin_msg, _StubDb())
    assert result == {"sent": False, "reason": "no_visitor_email"}


@pytest.mark.asyncio
async def test_helper_skips_when_visitor_online():
    """Visitor is connected via WebSocket → reply already delivered live.
    Don't double up with an email."""
    from routes import live_chat
    from routes.live_chat import send_admin_reply_to_visitor_email

    class _FakeWs:
        pass

    sid = f"stub-online-{uuid.uuid4().hex[:6]}"
    live_chat._visitor_connections[sid] = _FakeWs()  # type: ignore[attr-defined]
    try:
        session = {"session_id": sid, "visitor_email": "alice@example.com"}
        admin_msg = {"id": "m2", "sender_name": "Bob", "message": "hi"}
        result = await send_admin_reply_to_visitor_email(session, admin_msg, None)
        assert result == {"sent": False, "reason": "visitor_online"}
    finally:
        live_chat._visitor_connections.pop(sid, None)


@pytest.mark.asyncio
async def test_helper_respects_rate_limit():
    """Two replies inside the 60s window → second one is suppressed."""
    from routes.live_chat import send_admin_reply_to_visitor_email

    session = {
        "session_id": "stub-rate",
        "visitor_email": "bob@example.com",
        # Pretend an email went out 5 seconds ago.
        "last_email_reply_at": datetime.now(timezone.utc).isoformat(),
    }
    admin_msg = {"id": "m3", "sender_name": "Bob", "message": "hi"}
    result = await send_admin_reply_to_visitor_email(session, admin_msg, None)
    assert result == {"sent": False, "reason": "rate_limited"}


@pytest.mark.asyncio
async def test_helper_force_skips_rate_limit_check():
    """The manual resend button passes force=True, which must bypass both
    the 'visitor online' guard and the rate-limit guard."""
    from routes.live_chat import send_admin_reply_to_visitor_email

    session = {
        "session_id": "stub-force",
        "visitor_email": "carol@example.com",
        "last_email_reply_at": datetime.now(timezone.utc).isoformat(),
    }
    admin_msg = {"id": "m4", "sender_name": "Bob", "message": "hi"}
    # force=True with no RESEND_API_KEY (preview env) → should fall through
    # to the resend.api_key check, NOT to rate-limited/visitor_online.
    import os
    saved = os.environ.pop("RESEND_API_KEY", None)
    try:
        result = await send_admin_reply_to_visitor_email(
            session, admin_msg, _MinimalDb(), force=True
        )
        assert result["sent"] is False
        assert result["reason"] not in ("rate_limited", "visitor_online")
    finally:
        if saved is not None:
            os.environ["RESEND_API_KEY"] = saved


class _MinimalDb:
    """Just enough surface to let the helper's `find_one` for the last
    visitor message succeed without touching MongoDB."""
    class _Coll:
        async def find_one(self, *_args, **_kwargs):
            return None

        async def update_one(self, *_args, **_kwargs):
            return None

    chat_messages = _Coll()
    chat_sessions = _Coll()

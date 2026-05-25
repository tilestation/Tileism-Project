"""
Regression test for the missing Telegram notification on live-chat
visitor messages (24 May 2026, user reported "Bot sends auto message,
customer replies but I don't get any messages on telegram which is
annoying as customer waits — I receive a notification through email
'unanswered chat' instead").

Root cause:
  - `live_chat.send_visitor_message` only called the email notifier
    (`send_instant_email_notification`). Telegram was never wired in.
  - The "unanswered chat" cron ran every few minutes and was the only
    way the support team ever found out about new messages, so live
    customers (Lenard Kuklis, 24 May 2026) waited 10+ minutes for the
    team to respond.

Contract pinned:
  1. The Telegram defaults must include a `new_chat_message` event
     toggle, defaulted to True (high-signal for live customers).
  2. `send_visitor_message` must fire `notify_event("new_chat_message",
     …)` via `fire_and_forget` so the chat write path stays snappy.
  3. The dedupe key must be the message_id (not the session_id) so
     every new message in a conversation gets through — sessions can
     stay open for hours.
  4. The offline-message endpoint (post-contact-form) also fires
     Telegram so the existing customers who already left contact
     details get the same fast response.
"""
from __future__ import annotations

import inspect
import re

import pytest


def test_telegram_defaults_include_new_chat_message():
    from services.telegram_notify import _default_config
    cfg = _default_config()
    events = cfg.get("events", {})
    assert "new_chat_message" in events, (
        "Default Telegram config must include a `new_chat_message` event "
        "toggle so admins can opt in/out from the notifications page"
    )
    assert events["new_chat_message"] is True, (
        "`new_chat_message` must default to True — live chat is one of "
        "the highest-signal events, customers wait in real time"
    )


def test_send_visitor_message_fires_telegram():
    from routes import live_chat
    src = inspect.getsource(live_chat.send_visitor_message)
    assert re.search(
        r"fire_and_forget\(\s*['\"]new_chat_message['\"]",
        src,
    ), (
        "send_visitor_message must call "
        "`fire_and_forget('new_chat_message', …)` — without it the "
        "support team only finds out via the slow 'unanswered chat' "
        "email cron"
    )


def test_send_visitor_message_dedupes_by_message_id():
    """The dedupe key has to be unique per message, not per session.
    Default dedupe window is 1 hour — keyed on session_id, the second
    message in a conversation would be silently dropped."""
    from routes import live_chat
    src = inspect.getsource(live_chat.send_visitor_message)
    assert re.search(
        r"dedupe_key\s*=\s*visitor_msg\[['\"]id['\"]\]",
        src,
    ), (
        "Dedupe key must be the visitor message id so multi-message "
        "conversations all come through"
    )


def test_offline_message_fires_telegram():
    """The post-contact-form path must also notify Telegram — that's
    the path Lenard Kuklis hit and which produced only the
    'Visitor left contact details' system message."""
    from routes import live_chat
    src = inspect.getsource(live_chat.submit_offline_message)
    assert re.search(
        r"fire_and_forget\(\s*['\"]new_chat_message['\"]",
        src,
    ), (
        "submit_offline_message must also fire Telegram so customers "
        "who go through the contact-form path get the same fast "
        "response as live-chat messages"
    )


def test_telegram_send_failure_is_non_fatal():
    """A Telegram outage or misconfig must never break the customer's
    chat flow — the visitor's message must still save and the AI
    response must still fire."""
    from routes import live_chat
    src = inspect.getsource(live_chat.send_visitor_message)
    # The Telegram block lives inside a try/except — confirm the
    # except branch logs but does NOT re-raise.
    assert re.search(
        r"except\s+Exception:\s*\n\s*#[^\n]*\n\s*logger\.exception",
        src,
    ), (
        "Telegram block must be wrapped in try/except that logs and "
        "swallows — the customer's chat message must save even if "
        "Telegram is down"
    )

"""
Test the GSC stale-token detection bug fix (16 May 2026).

Bug: After a refresh token was revoked by Google (`invalid_grant`), the
admin UI kept showing "Connected" with a Disconnect-only button, trapping
admins who couldn't reconnect without manually deleting the DB row.

Fix:
  1. `get_credentials_for_admin` now marks the doc with `token_invalid=True`
     when refresh fails with `invalid_grant`.
  2. `get_status` checks that flag and returns `connected=False` with
     `previously_connected=True, reason="token_revoked"` so the UI can
     surface a "Reconnect" button.
  3. A fresh OAuth flow uses `replace_one(upsert=True)` so the invalid
     flag is naturally cleared on reconnect — no explicit `$unset` needed.

These tests touch `services.gsc.get_status` only (the cheap, side-effect-free
branch) — `get_credentials_for_admin` requires Google's OAuth library and
network calls so we stub the DB and rely on the unit assertion that the
flag is honoured.
"""
from __future__ import annotations

import pytest

from config import get_db
from services import gsc as gsc_service

pytestmark = pytest.mark.asyncio

# A throwaway admin id we can scope our test docs by — kept stable so a
# crashed run leaves a known-key doc the next test can overwrite, not orphans.
_TEST_ADMIN_ID = "pytest-gsc-token-trap"


async def _seed_doc(doc: dict) -> None:
    """Idempotent seed — `replace_one(upsert=True)` so we don't trip on
    DuplicateKeyError if a prior test leaked state. pytest-asyncio
    doesn't natively wrap autouse async fixtures so we can't rely on
    cleanup between tests."""
    db = get_db()
    await db[gsc_service.TOKENS_COLLECTION].replace_one(
        {"_id": doc["_id"]}, doc, upsert=True,
    )


async def _cleanup_doc() -> None:
    db = get_db()
    await db[gsc_service.TOKENS_COLLECTION].delete_one({"_id": _TEST_ADMIN_ID})


async def test_status_returns_not_connected_when_no_doc():
    """Sanity baseline — fresh state == not connected."""
    await _cleanup_doc()
    res = await gsc_service.get_status(_TEST_ADMIN_ID)
    assert res["connected"] is False
    # `configured` reflects env credentials, not user state — just confirm
    # it's a bool and not crashing.
    assert isinstance(res.get("configured"), bool)


async def test_status_returns_connected_for_healthy_doc():
    """Normal happy path: a doc without `token_invalid` reads as connected."""
    await _seed_doc({
        "_id": _TEST_ADMIN_ID,
        "refresh_token": "ya29.fake",
        "access_token": "fake-at",
        "google_account_email": "admin@tilestation.co.uk",
        "scopes": gsc_service.GSC_SCOPES,
    })

    res = await gsc_service.get_status(_TEST_ADMIN_ID)
    assert res["connected"] is True
    assert res["google_account_email"] == "admin@tilestation.co.uk"
    # Refresh token must never leak back to the admin UI.
    assert "refresh_token" not in res
    assert "access_token" not in res
    await _cleanup_doc()


async def test_status_returns_token_revoked_when_flagged():
    """Core regression: a doc flagged as `token_invalid=True` must read
    as NOT connected with a `previously_connected=True, reason=token_revoked`
    hint so the UI shows the Reconnect button instead of a stale green badge.
    """
    await _seed_doc({
        "_id": _TEST_ADMIN_ID,
        "refresh_token": "ya29.revoked",
        "access_token": "stale-at",
        "google_account_email": "admin@tilestation.co.uk",
        "token_invalid": True,
        "token_invalid_reason": "token_revoked",
    })

    res = await gsc_service.get_status(_TEST_ADMIN_ID)

    assert res["connected"] is False, "revoked token must NOT read as connected"
    assert res["previously_connected"] is True
    assert res["reason"] == "token_revoked"
    # Surface the email so the UI can say "your previous connection (foo@) expired".
    assert res["google_account_email"] == "admin@tilestation.co.uk"
    await _cleanup_doc()


async def test_reconnect_clears_invalid_flag_via_replace_one():
    """A fresh OAuth save uses `replace_one(upsert=True)` so any prior
    `token_invalid` flag is wiped without needing an explicit `$unset`.
    This is the self-healing property we rely on.
    """
    # Pre-seed with a poisoned doc (mimics post-revocation state).
    await _seed_doc({
        "_id": _TEST_ADMIN_ID,
        "refresh_token": "ya29.revoked",
        "token_invalid": True,
        "token_invalid_reason": "token_revoked",
    })

    # Now simulate the OAuth callback's persistence step (lines 180-191 of gsc.py).
    fresh_doc = {
        "_id": _TEST_ADMIN_ID,
        "refresh_token": "ya29.fresh",
        "access_token": "fresh-at",
        "google_account_email": "admin@tilestation.co.uk",
        "scopes": gsc_service.GSC_SCOPES,
    }
    db = get_db()
    await db[gsc_service.TOKENS_COLLECTION].replace_one(
        {"_id": _TEST_ADMIN_ID}, fresh_doc, upsert=True,
    )

    res = await gsc_service.get_status(_TEST_ADMIN_ID)
    assert res["connected"] is True
    assert "token_invalid" not in res
    assert res.get("previously_connected") is None or res["previously_connected"] is False
    await _cleanup_doc()

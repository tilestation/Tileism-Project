"""
Credential Health Check
───────────────────────

Runs once on backend startup. Verifies every env var that production
business logic depends on is present and non-empty. If anything is
missing, fires ONE Telegram alert (event type: `missing_credentials`)
so the admin can patch Railway env vars before customers feel it.

Scope (intentionally narrow): only credentials whose absence WILL
break a live feature. Env vars that have sensible empty-string fallbacks
or only matter for optional features are not checked here.

Design notes:
  • Idempotent — safe to call on every startup; dedupe at Telegram
    layer prevents re-spamming if the issue persists across restarts.
  • Never raises — startup must never be blocked by this check.
  • Result is logged (WARNING) regardless of Telegram availability so
    admins can also spot it in Railway logs.
"""
from __future__ import annotations

import logging
import os
from typing import Iterable

logger = logging.getLogger(__name__)


# Env vars whose absence breaks production. Each tuple: (env_var, why).
# Keep this list focused — adding noise here teaches the admin to ignore
# the alert.
REQUIRED_CREDENTIALS: list[tuple[str, str]] = [
    # ── Admin + supplier portal logins ─────────────────────────────
    ("TILESTATION_ADMIN_PASSWORD",
        "Super-admin login (was hardcoded; supplier_sync + scrapers reference it)"),
    ("SPLENDOUR_PORTAL_PASSWORD",
        "Splendour Tiles portal login — supplier sync will fail without it"),
    ("CERAMICA_PORTAL_PASSWORD",
        "Ceramica Impex portal login — supplier sync will fail without it"),
    ("WALLCANO_PORTAL_PASSWORD",
        "Wallcano Tiles portal login — supplier sync will fail without it"),
    ("VERONA_PORTAL_PASSWORD",
        "Verona portal login — supplier sync will fail without it"),
    # ── Payment processing ─────────────────────────────────────────
    ("STRIPE_API_KEY",
        "Stripe payments — checkout, refunds, subscription billing all break"),
    # ── Transactional email ────────────────────────────────────────
    ("RESEND_API_KEY",
        "Resend transactional email — order confirmations, password reset, "
        "weekly digests all silently drop"),
    # ── R2 object storage (product images, marketing assets) ───────
    ("R2_ACCOUNT_ID",
        "Cloudflare R2 storage — image uploads + Marketing Studio fail"),
    ("R2_ACCESS_KEY_ID",
        "Cloudflare R2 storage — image uploads + Marketing Studio fail"),
    ("R2_SECRET_ACCESS_KEY",
        "Cloudflare R2 storage — image uploads + Marketing Studio fail"),
    ("R2_BUCKET_NAME",
        "Cloudflare R2 storage — image uploads + Marketing Studio fail"),
    ("R2_PUBLIC_URL",
        "Cloudflare R2 storage — public CDN URL for image serving"),
    # ── AI / LLM ───────────────────────────────────────────────────
    ("EMERGENT_LLM_KEY",
        "Emergent universal LLM key — Editorial Autopilot, Marketing "
        "Studio image gen, Sora 2 video, Pinterest copy all fail"),
    # ── Webhook routing (added after 2 May 2026 Zoe Ward incident) ──
    # Used by routes/shop.py::_resolve_webhook_url to build the absolute
    # URL Stripe must call. Falls back to SITE_URL, then BACKEND_URL,
    # then request.base_url (last is unreliable behind Railway's proxy).
    # Either SITE_URL or BACKEND_URL MUST be set in production.
]


def _scan() -> list[tuple[str, str]]:
    """Returns list of (env_var, reason) for every missing/empty var."""
    missing: list[tuple[str, str]] = []
    for var, reason in REQUIRED_CREDENTIALS:
        val = os.environ.get(var)
        if not val or not str(val).strip():
            missing.append((var, reason))

    # Special handling for webhook URL — accept SITE_URL OR BACKEND_URL.
    # We only complain if NEITHER is set, because both work equally well
    # (SITE_URL wins by priority in _resolve_webhook_url).
    if not (os.environ.get("SITE_URL") or "").strip() and \
       not (os.environ.get("BACKEND_URL") or "").strip():
        missing.append((
            "SITE_URL or BACKEND_URL",
            "Stripe webhook URL builder. One of these MUST be set to the "
            "public HTTPS origin (e.g. https://tile-station-production.up.railway.app). "
            "Without either, checkout sessions will refuse to start.",
        ))
    return missing


def _format_telegram(missing: list[tuple[str, str]]) -> str:
    """Human-readable message body. Plain HTML — Telegram-safe.

    Wording deliberately friendly and self-attributed so the admin can
    tell at a glance this is a self-check from THEIR own backend (not
    a third-party / dev instruction). Includes a one-line "stop these
    alerts" hint so the admin isn't left frustrated when the issue
    isn't urgent.
    """
    bullet_lines = "\n".join(
        f"• <b>{var}</b> — {reason}" for var, reason in missing
    )
    return (
        "🛠️ <b>Tile Station — self-check</b>\n"
        f"Your backend just restarted and noticed {len(missing)} env "
        "var(s) missing on Railway:\n\n"
        f"{bullet_lines}\n\n"
        "<b>Fix:</b> Railway dashboard → backend service → Variables → "
        "add the missing value(s) → redeploy. Takes ~30 seconds.\n\n"
        "<i>To stop these messages: either set the variables above, or "
        "open /admin/notification-settings on tilestation.co.uk and turn "
        "off the <b>Missing credentials</b> toggle.</i>"
    )


async def run_credential_check_on_startup() -> dict:
    """Backend startup hook. Fires Telegram if anything is missing.

    Returns a small dict so the caller can log structured info, but
    NEVER raises — protects startup.
    """
    try:
        missing = _scan()
        if not missing:
            logger.info(
                "credential_check: all %d required env vars present",
                len(REQUIRED_CREDENTIALS),
            )
            return {"ok": True, "missing": []}

        # Log with WARNING so it shows up in Railway logs even if Telegram
        # isn't configured.
        logger.warning(
            "credential_check: %d missing env var(s): %s",
            len(missing),
            ", ".join(var for var, _ in missing),
        )

        # Fire ONE Telegram alert. dedupe_key keyed on the missing-set so
        # if the issue persists across restarts within the dedupe window
        # the admin doesn't get N copies. If the set changes between
        # restarts, a new alert fires (good — different issue).
        try:
            from services import telegram_notify
            dedupe_key = "missing_creds:" + ",".join(sorted(v for v, _ in missing))
            await telegram_notify.notify_event(
                "missing_credentials",
                _format_telegram(missing),
                dedupe_key=dedupe_key,
            )
        except Exception:  # noqa: BLE001
            logger.exception("credential_check: Telegram dispatch failed (non-fatal)")

        return {"ok": False, "missing": [v for v, _ in missing]}
    except Exception:  # noqa: BLE001
        logger.exception("credential_check: unexpected error (non-fatal, swallowed)")
        return {"ok": False, "missing": [], "error": "internal"}

"""
Extension report alerts — the moment the Verona Chrome extension posts a
self-check report ("Send report to Tile Station"), ping the owner on Telegram
(event `extension_report`, honours the Telegram settings page) and by email
(Resend) so nobody has to chase. Never raises.
"""
import logging
import os
import threading

from services import telegram_notify

logger = logging.getLogger(__name__)

SYNC_HUB_URL = "https://www.tilestation.co.uk/admin/sync-hub"


def _flag(ok: bool) -> str:
    return "✅" if ok else "❌"


def _page_line(summary: dict) -> str:
    if summary.get("page_cloudflare"):
        return "Cloudflare security check showing"
    if summary.get("page_not_verona"):
        return "not on a Verona page"
    n = summary.get("page_products")
    return f"{n if n is not None else '?'} products found on the page"


def _headline(summary: dict) -> str:
    problems = []
    if not summary.get("worker_ok"):
        problems.append("extension engine not responding")
    if not summary.get("server_ok"):
        problems.append("cannot reach the server")
    if summary.get("page_cloudflare"):
        problems.append("Cloudflare check on Verona")
    elif summary.get("page_not_verona"):
        problems.append("not on a Verona page")
    elif (summary.get("page_products") or 0) == 0:
        problems.append("0 products found on the page")
    if summary.get("job_status") == "paused":
        problems.append("sync paused")
    return "; ".join(problems) if problems else "all checks green"


def _telegram_text(summary: dict) -> str:
    err = summary.get("last_error") or {}
    lines = [
        f"🧩 <b>Verona extension report</b> — v{summary.get('version') or '?'} · ref {summary.get('id')}",
        f"<b>{_headline(summary)}</b>",
        f"{_flag(summary.get('worker_ok'))} engine · {_flag(summary.get('server_ok'))} server · "
        f"{_flag(not summary.get('page_cloudflare') and not summary.get('page_not_verona') and (summary.get('page_products') or 0) > 0)} page: {_page_line(summary)}",
        f"Engine state: {summary.get('job_status') or 'idle'}"
        + (f" ({summary.get('job_synced')} sent, {summary.get('job_failed') or 0} failed)" if summary.get("job_synced") is not None else ""),
    ]
    if summary.get("job_last_status"):
        lines.append(f"↳ {summary['job_last_status']}")
    if err:
        lines.append(f"Last problem: {err.get('context')} — {str(err.get('detail') or '')[:220]}")
    if summary.get("page_url"):
        lines.append(f"Page: {summary['page_url'][:120]}")
    lines.append(f'<a href="{SYNC_HUB_URL}">Open Sync Hub → Verona</a> for the full report.')
    return "\n".join(lines)


def _send_email(summary: dict) -> bool:
    api_key = os.environ.get("RESEND_API_KEY")
    if not api_key:
        return False
    import resend
    resend.api_key = api_key
    sender = os.environ.get("SENDER_EMAIL", "online@tilestation.co.uk")
    to_addr = os.environ.get("ADMIN_EMAIL", "qasim@tilestation.co.uk")
    err = summary.get("last_error") or {}
    rows = [
        ("Version", f"v{summary.get('version') or '?'} · ref {summary.get('id')}"),
        ("Extension engine", "OK" if summary.get("worker_ok") else "NOT RESPONDING"),
        ("Tile Station server", "connected" if summary.get("server_ok") else "UNREACHABLE"),
        ("Verona page", _page_line(summary)),
        ("Engine state", f"{summary.get('job_status') or 'idle'} {summary.get('job_last_status') or ''}".strip()),
        ("Problems logged", str(summary.get("error_count") or 0)),
    ]
    if err:
        rows.append(("Last problem", f"{err.get('context')} — {str(err.get('detail') or '')[:300]}"))
    if summary.get("page_url"):
        rows.append(("Page", summary["page_url"][:160]))
    table = "".join(
        f'<tr><td style="padding:5px 0; color:#1e3a8a; width:150px; vertical-align:top;"><strong>{k}</strong></td><td style="padding:5px 0;">{v}</td></tr>'
        for k, v in rows
    )
    html = f"""
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #1d4ed8; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0; font-size: 22px;">🧩 Verona extension report</h1>
            <p style="margin: 5px 0 0 0; font-size: 14px;">{_headline(summary)}</p>
        </div>
        <div style="padding: 28px; background: #eff6ff;">
            <div style="background: white; border: 1px solid #bfdbfe; border-left: 4px solid #1d4ed8; border-radius: 8px; padding: 18px;">
                <table style="width:100%; font-size:14px; color:#1a1a2e;">{table}</table>
            </div>
            <p style="text-align:center; margin: 24px 0 0 0;">
                <a href="{SYNC_HUB_URL}" style="background:#1a1a2e; color:#f0c14b; padding:12px 26px; text-decoration:none; border-radius:8px; font-weight:bold; display:inline-block;">Open Sync Hub → Verona</a>
            </p>
        </div>
        <div style="background: #1a1a2e; color: #888; padding: 12px; text-align: center; font-size: 11px;">Sent the moment the extension's "Send report to Tile Station" button was pressed.</div>
    </div>"""
    resend.Emails.send({
        "from": f"Tile Station Sync Monitor <{sender}>",
        "to": [to_addr],
        "subject": f"🧩 Verona extension report {summary.get('id')} — {_headline(summary)}",
        "html": html,
    })
    logger.info(f"[EXT REPORT] Email sent to {to_addr} for report {summary.get('id')}")
    return True


def _email_thread(summary: dict):
    try:
        _send_email(summary)
    except Exception as e:
        logger.warning(f"[EXT REPORT] Email failed: {e}")


async def notify_extension_report(summary: dict) -> dict:
    """Fire Telegram (awaited, never raises) + email (background thread)."""
    out = {"telegram": None, "email_started": False}
    try:
        out["telegram"] = await telegram_notify.notify_event(
            "extension_report", _telegram_text(summary), dedupe_key=str(summary.get("id"))
        )
    except Exception as e:
        logger.warning(f"[EXT REPORT] Telegram failed: {e}")
        out["telegram"] = {"error": str(e)}
    if os.environ.get("RESEND_API_KEY"):
        threading.Thread(target=_email_thread, args=(summary,), daemon=True).start()
        out["email_started"] = True
    return out

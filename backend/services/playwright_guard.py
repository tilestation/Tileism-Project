"""Self-heals missing Playwright browsers (e.g. after a Railway rebuild loses /pw-browsers)."""
import logging
import subprocess
import sys
import threading

logger = logging.getLogger(__name__)
_lock = threading.Lock()


def ensure_chromium(timeout: int = 600) -> bool:
    """Idempotent `playwright install chromium` — fast no-op when browsers already exist."""
    with _lock:
        try:
            res = subprocess.run(
                [sys.executable, "-m", "playwright", "install", "chromium"],
                capture_output=True, text=True, timeout=timeout,
            )
            if res.returncode == 0:
                print("[pw-guard] chromium browsers verified/installed", flush=True)
                return True
            logger.error("[pw-guard] install failed rc=%s stderr=%s", res.returncode, (res.stderr or "")[-500:])
            return False
        except Exception as e:
            logger.error("[pw-guard] install error: %s", e)
            return False


def ensure_chromium_background():
    threading.Thread(target=ensure_chromium, name="pw-guard", daemon=True).start()

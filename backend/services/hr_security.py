"""
HR-level field encryption helpers (13 Jun 2026).

Sensitive employee fields — NI number and bank account/sort code — are
stored encrypted at rest. This module owns one key (Fernet AES-128
under the hood) loaded from `HR_ENCRYPTION_KEY` in the backend env.

The key is auto-generated on first import if missing, so dev environments
just-work; production should set `HR_ENCRYPTION_KEY` explicitly so the
key survives container restarts (otherwise rotating the key invalidates
every existing ciphertext).

Public surface:
    encrypt(plaintext: str) -> str | None
    decrypt(ciphertext: str) -> str | None
    mask(plaintext: str, keep_last: int = 4) -> str
        # Cheap visual masking for UI ("****1234"); NOT a security primitive.
"""
import logging
import os
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken

logger = logging.getLogger(__name__)


def _load_key() -> bytes:
    """Read the key from env, else generate one and log a warning so
    the operator knows to copy it into .env for persistence."""
    raw = os.environ.get("HR_ENCRYPTION_KEY", "").strip()
    if raw:
        try:
            # Validate by attempting to construct a Fernet
            Fernet(raw.encode())
            return raw.encode()
        except Exception:
            logger.error(
                "HR_ENCRYPTION_KEY in env is not a valid Fernet key. "
                "Falling back to an EPHEMERAL key — encrypted data "
                "WILL NOT survive a backend restart until you replace it."
            )
    generated = Fernet.generate_key()
    logger.warning(
        "HR_ENCRYPTION_KEY not set — generated an ephemeral one. "
        "Add this to backend/.env for production:\n"
        "HR_ENCRYPTION_KEY=%s",
        generated.decode(),
    )
    return generated


_FERNET = Fernet(_load_key())


def encrypt(plaintext: Optional[str]) -> Optional[str]:
    if plaintext is None or plaintext == "":
        return None
    try:
        return _FERNET.encrypt(str(plaintext).encode()).decode()
    except Exception:
        logger.exception("hr-security: encrypt failed")
        return None


def decrypt(ciphertext: Optional[str]) -> Optional[str]:
    if not ciphertext:
        return None
    try:
        return _FERNET.decrypt(ciphertext.encode()).decode()
    except InvalidToken:
        # Most often this means the data was stored with a DIFFERENT
        # key (someone reset HR_ENCRYPTION_KEY). Return None so the UI
        # can show a re-entry prompt rather than crashing.
        logger.warning("hr-security: ciphertext rejected — wrong key?")
        return None
    except Exception:
        logger.exception("hr-security: decrypt failed")
        return None


def mask(plaintext: Optional[str], keep_last: int = 4) -> str:
    """Return a UI-safe masked form like '****1234'. NOT a security
    primitive — only use this AFTER decrypting, when rendering."""
    if not plaintext:
        return ""
    s = str(plaintext)
    if len(s) <= keep_last:
        return "*" * len(s)
    return ("*" * (len(s) - keep_last)) + s[-keep_last:]

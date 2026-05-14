"""
Public version + schema-fingerprint endpoint (May 14, 2026)

GET /api/__version__   →   {
  "git_sha": "abc123def...",
  "git_branch": "main",
  "build_time": "2026-05-14T16:00:00Z",
  "env": "preview" | "production" | "local",
  "python": "3.11.6",
  "schema_fingerprint": "<16-hex>",       <-- aggregate hash
  "schema_endpoints": {                    <-- per-endpoint hashes
    "search_all":       "5e8c...",
    "tiles_collection": "9a01...",
    ...
  }
}

Purpose: any agent (or any human) can curl this against preview AND
production and compare the per-endpoint fingerprints in one shot. If
`schema_fingerprint` matches, the API contract is identical and bugs
report on one env will reproduce on the other. If they differ, the
report is most likely a "preview ≠ prod" deploy-drift issue and the
agent should curl prod directly before assuming code matches behaviour.

The endpoint is intentionally:
  * **unauthenticated** — anyone (uptime monitors, status badges,
    troubleshooting CLIs) can hit it without juggling tokens
  * **cheap** — fingerprints are computed at boot + cached in-memory;
    refresh on demand via ?refresh=1
  * **non-PII** — only schema metadata, no real data leaks
"""
from __future__ import annotations

import os
import platform
import subprocess
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from fastapi import APIRouter, Query

from services.schema_fingerprint import (
    CANARY_ENDPOINTS,
    compute_local_fingerprints,
    fingerprint,
)

router = APIRouter(tags=["Version"])

_CACHE: Dict[str, Any] = {
    "version_info": None,
    "computed_at": None,
}


def _git_sha() -> str:
    """Read the git SHA — env var takes priority (set during Railway
    build) then falls back to `git rev-parse HEAD`."""
    sha = (
        os.environ.get("RAILWAY_GIT_COMMIT_SHA")
        or os.environ.get("GIT_COMMIT")
        or os.environ.get("COMMIT_SHA")
        or ""
    )
    if sha:
        return sha[:12]
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd="/app",
            stderr=subprocess.DEVNULL,
            timeout=2,
        )
        return out.decode().strip()[:12]
    except Exception:
        return "unknown"


def _git_branch() -> str:
    branch = (
        os.environ.get("RAILWAY_GIT_BRANCH")
        or os.environ.get("GIT_BRANCH")
        or ""
    )
    if branch:
        return branch
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd="/app",
            stderr=subprocess.DEVNULL,
            timeout=2,
        )
        return out.decode().strip()
    except Exception:
        return "unknown"


def _build_time() -> str:
    """Build time from env (Railway sets RAILWAY_DEPLOYMENT_CREATED_AT)
    or process start time."""
    explicit = os.environ.get("BUILD_TIME") or os.environ.get("RAILWAY_DEPLOYMENT_CREATED_AT")
    if explicit:
        return explicit
    # Process start time as a sensible fallback
    try:
        with open("/proc/self/stat", "r") as f:
            parts = f.read().split()
            # field 22 = starttime in clock ticks since boot
            return f"<process-start ticks={parts[21]}>"
    except Exception:
        return "unknown"


def _environment() -> str:
    """Best-effort env label."""
    if os.environ.get("RAILWAY_ENVIRONMENT_NAME"):
        return os.environ["RAILWAY_ENVIRONMENT_NAME"]
    if "preview.emergentagent.com" in (os.environ.get("PUBLIC_URL") or ""):
        return "preview"
    if os.environ.get("TILESTATION_ENV"):
        return os.environ["TILESTATION_ENV"]
    if os.environ.get("ENV"):
        return os.environ["ENV"]
    return "local"


async def _build_payload(refresh: bool = False) -> Dict[str, Any]:
    """Returns the full /__version__ payload. Cached for 60 seconds
    unless refresh=True."""
    now = datetime.now(timezone.utc)
    cached = _CACHE.get("version_info")
    cached_at = _CACHE.get("computed_at")
    if (
        not refresh
        and cached
        and cached_at
        and (now - cached_at).total_seconds() < 60
    ):
        return cached

    # Compute schema fingerprints by hitting our own local API.
    import httpx
    local_base = f"http://localhost:{os.environ.get('PORT', '8001')}"
    async with httpx.AsyncClient(base_url=local_base, timeout=5.0) as client:
        endpoints = await compute_local_fingerprints(client)

    # Aggregate fingerprint = hash of (id → fp) so any endpoint change
    # bubbles up into one comparable scalar.
    aggregate = fingerprint(
        {cid: data.get("fp") for cid, data in endpoints.items()}
    )

    payload: Dict[str, Any] = {
        "service": "tile-station-backend",
        "git_sha": _git_sha(),
        "git_branch": _git_branch(),
        "build_time": _build_time(),
        "env": _environment(),
        "python": platform.python_version(),
        "computed_at": now.isoformat(),
        "schema_fingerprint": aggregate,
        "schema_endpoints": {
            cid: {"fp": data.get("fp"), "ok": bool(data.get("ok"))}
            for cid, data in endpoints.items()
        },
        "canary_paths": [c["path"] for c in CANARY_ENDPOINTS],
    }
    _CACHE["version_info"] = payload
    _CACHE["computed_at"] = now
    return payload


@router.get("/__version__")
async def version_info(refresh: bool = Query(False, description="Force recompute fingerprints, bypassing the 60-second cache.")):
    """Public version + schema-fingerprint endpoint.

    Curl two environments and `diff` their `schema_fingerprint` /
    `schema_endpoints` to instantly detect API contract drift.

    Example:
      curl https://preview.example.com/api/__version__
      curl https://prod.example.com/api/__version__
    """
    return await _build_payload(refresh=refresh)


# Optional: also expose the full shape (not just the hash) for one
# endpoint, useful when the fingerprint differs and you want to see
# WHICH key changed without writing a comparison script.
@router.get("/__version__/shape")
async def version_shape(endpoint_id: str = Query(..., description="Canary endpoint id (e.g. search_all, tiles_collection)")):
    """Return the canonical shape dict for one canary endpoint. Useful
    for spotting exactly which key flipped types when fingerprints
    diverge between environments."""
    import httpx
    from services.schema_fingerprint import shape_of

    match: Optional[Dict[str, str]] = None
    for c in CANARY_ENDPOINTS:
        if c["id"] == endpoint_id:
            match = c
            break
    if not match:
        return {"error": f"unknown endpoint_id '{endpoint_id}'", "known": [c["id"] for c in CANARY_ENDPOINTS]}

    local_base = f"http://localhost:{os.environ.get('PORT', '8001')}"
    async with httpx.AsyncClient(base_url=local_base, timeout=5.0) as client:
        r = await client.get(match["path"])
        if r.status_code != 200:
            return {"error": "endpoint returned non-200", "status": r.status_code}
        return {
            "endpoint_id": endpoint_id,
            "path": match["path"],
            "shape": shape_of(r.json()),
            "fp": fingerprint(r.json()),
        }

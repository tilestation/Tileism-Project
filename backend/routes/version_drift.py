"""
Admin: compare schema fingerprints across environments (May 14, 2026)
"""
from typing import Optional

from fastapi import APIRouter, Depends, Query

from services import get_current_user
from services.schema_fingerprint import (
    compare,
    compute_remote_fingerprints,
)

router = APIRouter(prefix="/admin", tags=["Version Drift"])


@router.get("/version-drift")
async def version_drift(
    left: str = Query(..., description="Base URL of the 'left' environment (e.g. preview)"),
    right: str = Query(..., description="Base URL of the 'right' environment (e.g. prod)"),
    current_user: dict = Depends(get_current_user),
):
    """Fingerprint every canary endpoint on BOTH URLs and return a
    structured diff. `drift=true` means the API contract diverges and
    bugs reported against one environment may not reproduce on the
    other (most common cause of false 'fixed in preview, broken in
    prod' reports)."""
    left_fps = await compute_remote_fingerprints(left)
    right_fps = await compute_remote_fingerprints(right)
    diff = compare(left_fps, right_fps)
    return {
        "left_url": left,
        "right_url": right,
        "left_fingerprints": left_fps,
        "right_fingerprints": right_fps,
        **diff,
    }


@router.get("/version-drift/probe")
async def version_drift_probe(
    url: str = Query(..., description="Single base URL to fingerprint (no comparison)"),
    current_user: Optional[dict] = Depends(get_current_user),
):
    """Compute all canary fingerprints for a single remote URL. Useful
    when adding a new endpoint to monitor or for one-shot diagnostics."""
    fps = await compute_remote_fingerprints(url)
    return {"url": url, "fingerprints": fps}

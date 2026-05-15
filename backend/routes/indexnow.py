"""
IndexNow key-file route.

The IndexNow protocol (Bing, Yandex, DuckDuckGo) verifies site ownership
by fetching a key file at `{keyLocation}` on the same host as the URLs
being submitted. We host that file through the FastAPI backend so the
key value is owned by env config — no static file to keep in sync.

Flow:
  1. `seo_recrawl.request_indexnow_ping()` POSTs to api.indexnow.org
     with `keyLocation = https://tilestation.co.uk/{INDEXNOW_KEY}.txt`.
  2. IndexNow's verifier fetches that URL.
  3. Express (`server.js`) proxies any `/<hex>.txt` at root to this
     route, which returns the env-configured key as plain text if the
     path matches — otherwise 404.

This means rotating the key only requires updating one env var; no code
or static-file deploy needed.
"""

import os

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse

router = APIRouter()


@router.get("/seo/indexnow/{key}.txt", response_class=PlainTextResponse, include_in_schema=False)
async def serve_indexnow_key_file(key: str) -> PlainTextResponse:
    """Return the IndexNow key as plain text if `{key}` matches the
    configured `INDEXNOW_KEY` env var. 404 otherwise so the verifier
    treats unknown keys as "ownership not proven"."""
    configured = (os.environ.get("INDEXNOW_KEY") or "").strip()
    if not configured:
        # No key configured yet — give the verifier a clean 404 rather
        # than leaking a generic error.
        raise HTTPException(status_code=404, detail="IndexNow not configured")
    if key != configured:
        raise HTTPException(status_code=404, detail="key mismatch")
    return PlainTextResponse(content=configured, media_type="text/plain")

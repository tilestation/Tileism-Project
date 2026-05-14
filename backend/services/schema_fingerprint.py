"""
Schema fingerprinting (May 14, 2026)

After the 4th "preview ≠ prod" production incident in a week (most
recent: the production backend returned image fields as `{url, alt,
alt_generated_at}` objects while preview returned bare strings — the
frontend never noticed and 100% of product images broke on prod) we
need a deterministic way to detect when API response *shapes* diverge
between environments.

This module computes a stable SHA-256 hash of the response shape for a
short, hand-picked set of canary endpoints. The hash CHANGES whenever:
  * a new key is added/removed
  * an existing key's value TYPE changes (string → object, etc.)
  * a list element's shape changes

The hash does NOT change for:
  * actual content (timestamps, ids, counts, prices)
  * key ordering
  * list length

So `{"image": "https://..."}` and `{"image": "https://other.jpg"}` hash
identically (same shape), but `{"image": {"url": "..."}}` hashes
differently (shape changed) — which is exactly the alarm we want.

Used by:
  - GET /api/__version__               (public, anonymous)
  - GET /api/admin/version-drift       (compare two env URLs)
  - services/uptime_monitor            (alert on shape drift in prod)
"""
from __future__ import annotations

import hashlib
import json
import logging
from typing import Any, Dict, List

logger = logging.getLogger(__name__)


def _value_shape(v: Any) -> Any:
    """Return a stable, content-free representation of a value's shape.

    Strings collapse to "str", numbers to "num", booleans to "bool",
    nulls to "null", dicts recurse into {key: shape} (keys sorted),
    lists collapse to the union of element shapes [`shape1`, `shape2`]
    deduped + sorted as JSON strings."""
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "bool"
    if isinstance(v, (int, float)):
        return "num"
    if isinstance(v, str):
        return "str"
    if isinstance(v, dict):
        return {k: _value_shape(v[k]) for k in sorted(v.keys())}
    if isinstance(v, list):
        if not v:
            return ["empty"]
        # Hash each element's shape, dedupe by JSON repr, sort for stability
        shapes = sorted({json.dumps(_value_shape(item), sort_keys=True) for item in v[:25]})
        return [json.loads(s) for s in shapes]
    # Anything else (datetime, bytes, custom obj) — last-resort name of type
    return type(v).__name__


def shape_of(data: Any) -> Dict[str, Any]:
    """Top-level convenience: return the canonical shape dict for an
    API response. Wraps lists in a sentinel so root-level lists and
    root-level dicts produce distinguishable fingerprints."""
    if isinstance(data, list):
        return {"__root__": "list", "__element__": _value_shape(data)}
    if isinstance(data, dict):
        return _value_shape(data)
    return {"__root__": _value_shape(data)}


def fingerprint(data: Any) -> str:
    """Stable 16-char SHA-256 hex fingerprint of the response shape."""
    canonical = json.dumps(shape_of(data), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


# ─── Canary endpoints — order matters for fingerprint stability ─────


CANARY_ENDPOINTS: List[Dict[str, str]] = [
    # The most-likely to drift, based on past incidents. Order is fixed
    # for fingerprint stability — if you add a new one, append to the
    # end rather than inserting in the middle so historical hashes
    # don't false-positive.
    #
    # Each path MUST return a 200 with stable JSON on a healthy server.
    {"id": "search_all", "path": "/api/shop/search-all?q=tile&page=1&limit=1"},
    {"id": "tiles_collection", "path": "/api/tiles/collection/Dolomite%20Onyx?limit=1"},
    {"id": "shop_products", "path": "/api/shop/products?limit=1"},
    {"id": "health", "path": "/api/health"},
]


async def compute_local_fingerprints(client) -> Dict[str, Any]:
    """For every canary endpoint, hit the LOCAL FastAPI instance and
    compute its shape fingerprint. Run at app boot + on demand.

    `client` is an httpx.AsyncClient pre-configured with the local
    backend's base URL (typically http://localhost:8001)."""
    results: Dict[str, Any] = {}
    for c in CANARY_ENDPOINTS:
        try:
            r = await client.get(c["path"], timeout=5.0)
            if r.status_code != 200:
                results[c["id"]] = {"ok": False, "status": r.status_code, "fp": None}
                continue
            try:
                data = r.json()
            except Exception:
                results[c["id"]] = {"ok": False, "status": r.status_code, "fp": "nonjson"}
                continue
            results[c["id"]] = {
                "ok": True,
                "status": 200,
                "fp": fingerprint(data),
                "shape": shape_of(data),
            }
        except Exception as e:  # noqa: BLE001
            results[c["id"]] = {"ok": False, "error": str(e)[:100], "fp": None}
    return results


async def compute_remote_fingerprints(base_url: str) -> Dict[str, Any]:
    """Same as compute_local_fingerprints but against a remote base
    URL (for comparing preview vs prod, or for the uptime monitor)."""
    import httpx
    base = base_url.rstrip("/")
    async with httpx.AsyncClient(timeout=10.0, headers={"User-Agent": "TileStation-VersionCheck/1.0"}) as client:
        results: Dict[str, Any] = {}
        for c in CANARY_ENDPOINTS:
            url = f"{base}{c['path']}"
            try:
                r = await client.get(url)
                if r.status_code != 200:
                    results[c["id"]] = {"ok": False, "status": r.status_code, "fp": None, "url": url}
                    continue
                try:
                    data = r.json()
                except Exception:
                    results[c["id"]] = {"ok": False, "status": r.status_code, "fp": "nonjson", "url": url}
                    continue
                results[c["id"]] = {
                    "ok": True,
                    "status": 200,
                    "fp": fingerprint(data),
                    "url": url,
                }
            except Exception as e:  # noqa: BLE001
                results[c["id"]] = {"ok": False, "error": str(e)[:100], "fp": None, "url": url}
        return results


def compare(a: Dict[str, Any], b: Dict[str, Any]) -> Dict[str, Any]:
    """Diff two fingerprint dicts (per-endpoint). Returns a structured
    summary with a top-level `drift` boolean and per-endpoint deltas."""
    deltas = {}
    drift = False
    ids = sorted(set(a.keys()) | set(b.keys()))
    for cid in ids:
        ar = a.get(cid) or {}
        br = b.get(cid) or {}
        afp = ar.get("fp")
        bfp = br.get("fp")
        ok_a = bool(ar.get("ok"))
        ok_b = bool(br.get("ok"))
        match = (afp == bfp) and ok_a and ok_b
        if not match and (ok_a or ok_b):
            drift = True
        deltas[cid] = {
            "match": match,
            "left": {"fp": afp, "ok": ok_a, "status": ar.get("status"), "error": ar.get("error")},
            "right": {"fp": bfp, "ok": ok_b, "status": br.get("status"), "error": br.get("error")},
        }
    return {"drift": drift, "endpoints": deltas}

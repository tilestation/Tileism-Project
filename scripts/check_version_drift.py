#!/usr/bin/env python3
"""
check_version_drift.py — quick CLI to compare schema fingerprints
between two Tile Station environments (typically preview vs prod).

Usage:
    python3 /app/scripts/check_version_drift.py

  # or with explicit URLs:
    python3 /app/scripts/check_version_drift.py \\
        https://feature-verification-7.preview.emergentagent.com \\
        https://tile-station-production.up.railway.app

When fingerprints differ, prints WHICH endpoints flipped and exits 1
so it can be wired into CI / pre-deploy checks.

Designed for "user reports X is broken — check this FIRST before
assuming preview matches prod". Recommended to run BEFORE diagnosing
any prod bug.
"""
import json
import sys
import urllib.request


DEFAULT_PREVIEW = "https://feature-verification-7.preview.emergentagent.com"
DEFAULT_PROD = "https://tile-station-production.up.railway.app"


def fetch_version(base: str) -> dict:
    url = base.rstrip("/") + "/api/__version__"
    try:
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 (TileStation-VersionCheck CLI)",
                "Accept": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        return {"error": f"{type(e).__name__}: {e}", "url": url}


def main() -> int:
    left = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PREVIEW
    right = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_PROD

    print(f"LEFT  : {left}")
    print(f"RIGHT : {right}")
    print()

    a = fetch_version(left)
    b = fetch_version(right)

    if "error" in a:
        print(f"  LEFT  fetch failed: {a['error']}")
    else:
        print(f"  LEFT  git={a.get('git_sha')}  env={a.get('env')}  fp={a.get('schema_fingerprint')}")
    if "error" in b:
        print(f"  RIGHT fetch failed: {b['error']}")
    else:
        print(f"  RIGHT git={b.get('git_sha')}  env={b.get('env')}  fp={b.get('schema_fingerprint')}")

    if "error" in a or "error" in b:
        return 2

    a_fp = a.get("schema_fingerprint")
    b_fp = b.get("schema_fingerprint")
    print()
    if a_fp == b_fp:
        print(f"✅  MATCH — both envs return the same shape for all canary endpoints ({a_fp}).")
        print("    Safe to assume preview behaviour mirrors prod.")
        return 0

    print(f"❌  DRIFT — aggregate fingerprints differ ({a_fp}  vs  {b_fp})")
    print()
    a_eps = a.get("schema_endpoints") or {}
    b_eps = b.get("schema_endpoints") or {}
    ids = sorted(set(a_eps.keys()) | set(b_eps.keys()))
    for cid in ids:
        ae = a_eps.get(cid) or {}
        be = b_eps.get(cid) or {}
        afp, bfp = ae.get("fp"), be.get("fp")
        ok_a, ok_b = ae.get("ok"), be.get("ok")
        if afp == bfp and ok_a and ok_b:
            print(f"  ✓  {cid:20s}  {afp}")
        else:
            tag = "FLIP" if (ok_a and ok_b) else "MISSING"
            print(f"  ⚠  {cid:20s}  L={afp} (ok={ok_a})   R={bfp} (ok={ok_b})   [{tag}]")

    print()
    print("Next step: curl <env>/api/__version__/shape?endpoint_id=<id>  on both")
    print("envs and diff the JSON. That tells you EXACTLY which key flipped.")
    return 1


if __name__ == "__main__":
    sys.exit(main())

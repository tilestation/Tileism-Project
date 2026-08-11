"""
Live → Preview data sync.

Endpoints:
  GET  /api/live-sync/export-snapshot  → paged export of one whitelisted collection
                                          (runs on the LIVE site, admin-auth)
  POST /api/live-sync/pull-from-live   → runs on the PREVIEW site only; logs into the
                                          live site, pulls every whitelisted collection
                                          and REPLACES the local copy (clean mirror).

Catalogue + navigation data only — orders/customers/users are never synced.
"""
import os
import logging

import httpx
from bson import json_util
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from pymongo import MongoClient

from services import get_current_user, has_permission, log_audit

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/live-sync", tags=["Live Sync"])

# Catalogue + site-structure collections only. NEVER add orders/customers/users here.
SYNC_COLLECTIONS = [
    "supplier_products",
    "tiles",
    "products",
    "page_banners",
    "navigation_menus",
    "collection_settings",
    "website_categories",
]

PAGE_SIZE = 500
PRODUCTION_HOSTS = ("tilestation.co.uk", "railway.app")


def get_db():
    mongo_url = os.environ.get("MONGO_URL")
    if not mongo_url:
        raise ValueError("MONGO_URL environment variable is required")
    client = MongoClient(mongo_url)
    return client[os.environ.get("DB_NAME", "tile_station")]


@router.get("/export-snapshot")
def export_snapshot(
    collection: str = Query(...),
    skip: int = Query(0, ge=0),
    limit: int = Query(PAGE_SIZE, ge=1, le=PAGE_SIZE),
    current_user: dict = Depends(get_current_user),
):
    """Paged export of one whitelisted collection as BSON extended JSON
    (datetimes/ObjectIds round-trip losslessly via bson.json_util)."""
    if not has_permission(current_user, "supplier_products"):
        raise HTTPException(403, "You need the Supplier Products permission to export data")
    if collection not in SYNC_COLLECTIONS:
        raise HTTPException(400, f"Collection '{collection}' is not syncable")
    db = get_db()
    total = db[collection].count_documents({})
    docs = list(db[collection].find({}).skip(skip).limit(limit))
    return {
        "collection": collection,
        "total": total,
        "skip": skip,
        "count": len(docs),
        "docs_ext_json": json_util.dumps(docs),
    }


class PullRequest(BaseModel):
    source_url: str
    live_email: str
    live_password: str
    confirm: bool = False


@router.post("/pull-from-live")
def pull_from_live(
    payload: PullRequest,
    request: Request,
    current_user: dict = Depends(get_current_user),
):
    if not has_permission(current_user, "supplier_products"):
        raise HTTPException(403, "You need the Supplier Products permission to sync data")
    if not payload.confirm:
        raise HTTPException(400, "Set confirm=true to replace the preview catalogue")

    # Hard guard: never allow this to run ON the live site itself.
    host = (request.headers.get("host") or "").lower()
    if any(p in host for p in PRODUCTION_HOSTS):
        raise HTTPException(403, "Live sync can only run on the preview environment — never on the live site")

    source = payload.source_url.rstrip("/")
    if source.split("//")[-1].split("/")[0] == host:
        raise HTTPException(400, "Source must be a different site (cannot self-sync)")

    with httpx.Client(timeout=60) as client:
        # 1. Log into the live site
        try:
            login = client.post(
                f"{source}/api/auth/login",
                json={"email": payload.live_email, "password": payload.live_password},
            )
        except httpx.HTTPError as e:
            raise HTTPException(502, f"Could not reach the live site: {e}")
        if login.status_code != 200:
            raise HTTPException(401, "Live site login failed — check the email/password")
        body = login.json()
        token = body.get("token") or body.get("access_token")
        if not token:
            raise HTTPException(502, "Live site login returned no token")
        headers = {"Authorization": f"Bearer {token}"}

        # 2. Fetch every collection fully BEFORE touching local data
        fetched: dict[str, list] = {}
        for coll in SYNC_COLLECTIONS:
            docs: list = []
            skip = 0
            while True:
                r = client.get(
                    f"{source}/api/live-sync/export-snapshot",
                    params={"collection": coll, "skip": skip, "limit": PAGE_SIZE},
                    headers=headers,
                )
                if r.status_code == 404:
                    raise HTTPException(
                        409,
                        "The live site doesn't have the sync endpoint yet — deploy the latest code to live first, then retry",
                    )
                if r.status_code != 200:
                    raise HTTPException(502, f"Live export of '{coll}' failed (HTTP {r.status_code})")
                data = r.json()
                docs.extend(json_util.loads(data["docs_ext_json"]))
                skip += data["count"]
                if skip >= data["total"] or data["count"] == 0:
                    break
            fetched[coll] = docs

    # 3. Replace local collections (clean mirror of live)
    db = get_db()
    results = {}
    for coll, docs in fetched.items():
        db[coll].delete_many({})
        if docs:
            db[coll].insert_many(docs)
        results[coll] = len(docs)

    # 4. Bust caches so the preview storefront shows the fresh data immediately
    try:
        from utils.endpoint_cache import endpoint_cache
        endpoint_cache.invalidate()
    except Exception:
        pass

    logger.info(f"Live sync complete from {source}: {results}")
    return {"ok": True, "source": source, "synced": results, "total_docs": sum(results.values())}

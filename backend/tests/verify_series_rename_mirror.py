"""Verify /apply mirrors renames into tiles + products collections, then restores."""
import asyncio
import os

import requests
from dotenv import dotenv_values
from motor.motor_asyncio import AsyncIOMotorClient

fe = dotenv_values("/app/frontend/.env")
be = dotenv_values("/app/backend/.env")
BASE = (os.environ.get("REACT_APP_BACKEND_URL") or fe["REACT_APP_BACKEND_URL"]).rstrip("/")
PNS = f"{BASE}/api/product-name-sanity"
SKU = "LP-1132"


async def main():
    db = AsyncIOMotorClient(be["MONGO_URL"])[be["DB_NAME"]]
    s = requests.Session()
    tok = s.post(f"{BASE}/api/auth/login", json={"email": "admin@test.com", "password": "admin123"}).json()["token"]
    s.headers.update({"Authorization": f"Bearer {tok}"})

    sp = await db.supplier_products.find_one({"sku": SKU})
    orig = sp.get("product_name")
    supplier = sp.get("supplier")
    tile_before = await db.tiles.find_one({"sku": SKU})
    prod_before = await db.products.find_one({"sku": SKU})
    print(f"orig supplier_products.product_name={orig!r} supplier={supplier!r}")
    print(f"tiles doc exists={tile_before is not None} name={tile_before and tile_before.get('name')!r}")
    print(f"products doc exists={prod_before is not None} name={prod_before and prod_before.get('name')!r}")

    new_name = f"{orig} MIRRORCHK"
    r = s.post(f"{PNS}/apply", json={"items": [{"sku": SKU, "supplier": supplier, "new_name": new_name}]})
    print("apply:", r.status_code, r.json())

    sp2 = await db.supplier_products.find_one({"sku": SKU})
    print("supplier_products:", {k: sp2.get(k) for k in ("product_name", "our_product_name", "display_name", "name")})
    t2 = await db.tiles.find_one({"sku": SKU})
    if t2:
        print("tiles:", {k: t2.get(k) for k in ("name", "display_name", "website_name")})
    p2 = await db.products.find_one({"sku": SKU})
    if p2:
        print("products:", {k: p2.get(k) for k in ("name", "product_name")})

    r = s.post(f"{PNS}/apply", json={"items": [{"sku": SKU, "supplier": supplier, "new_name": orig}]})
    print("restore:", r.status_code, r.json())
    sp3 = await db.supplier_products.find_one({"sku": SKU})
    t3 = await db.tiles.find_one({"sku": SKU})
    print("RESTORED sp:", sp3.get("product_name") == orig, "| tiles name:", t3 and t3.get("name"))


asyncio.run(main())

"""Final data-integrity sweep: no TESTRENAME/MIRRORCHK residue left after testing."""
import asyncio

from dotenv import dotenv_values
from motor.motor_asyncio import AsyncIOMotorClient

be = dotenv_values("/app/backend/.env")


async def main():
    db = AsyncIOMotorClient(be["MONGO_URL"])[be["DB_NAME"]]
    for coll, fields in [("supplier_products", ["product_name", "our_product_name", "display_name"]),
                         ("tiles", ["name", "display_name", "website_name"]),
                         ("products", ["name", "product_name"])]:
        q = {"$or": [{f: {"$regex": "TESTRENAME|MIRRORCHK|TESTRENAME2"}} for f in fields]}
        n = await db[coll].count_documents(q)
        print(f"{coll}: residue docs = {n}")
    sp = await db.supplier_products.find_one({"sku": "LP-1132"})
    t = await db.tiles.find_one({"sku": "LP-1132"})
    print("LP-1132 supplier_products:", {k: sp.get(k) for k in ("product_name", "our_product_name", "display_name", "name")})
    print("LP-1132 tiles:", {k: t.get(k) for k in ("name", "display_name", "website_name")} if t else None)
    lp = await db.supplier_products.find_one({"sku": "LP-3631"})
    print("LP-3631 product_name:", lp.get("product_name"))


asyncio.run(main())

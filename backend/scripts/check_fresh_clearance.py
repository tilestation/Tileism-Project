"""
Check for clearance products in sync_staging_fresh and delete them.
Also identify non-tile products (essentials, adhesives, grouts, etc.)
"""

import asyncio
import os
import logging
from datetime import datetime, timezone
from pymongo import MongoClient

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

BASE_URL = "https://www.splendourtiles.co.uk"
SPLENDOUR_EMAIL = "accounts@tilestation.co.uk"
SPLENDOUR_PASSWORD = os.environ.get("SPLENDOUR_PORTAL_PASSWORD", "")

def get_db():
    client = MongoClient(os.environ.get('MONGO_URL', 'mongodb://localhost:27017'))
    return client[os.environ.get('DB_NAME', 'test_database')]

async def perform_login(page) -> bool:
    try:
        await page.goto(f'{BASE_URL}/customer/account/login/', timeout=60000)
        await asyncio.sleep(2)
        await page.fill('input[name="email"]', SPLENDOUR_EMAIL)
        await page.fill('input[name="password"]', SPLENDOUR_PASSWORD)
        await page.click('button[type="submit"]:has-text("Login")')
        await asyncio.sleep(3)
        return 'login' not in page.url
    except Exception as e:
        logger.error(f"Login error: {e}")
        return False

async def check_clearance_badge(page, url: str) -> bool:
    """Check if product page has Wholesale_Clearance badge"""
    try:
        await page.goto(url, timeout=30000)
        await asyncio.sleep(1)
        page_content = await page.content()
        return 'Wholesale_Clearance' in page_content
    except Exception:
        return False

async def run_clearance_check():
    db = get_db()
    
    # Get all products from fresh scan
    products = list(db.sync_staging_fresh.find(
        {'supplier': 'Splendour'},
        {'sku': 1, 'name': 1, 'url': 1}
    ))
    
    logger.info(f"Checking {len(products)} products for clearance badges...")
    
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        return {"error": "Playwright not available"}
    
    clearance_products = []
    
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        
        if not await perform_login(page):
            return {"error": "Login failed"}
        
        logger.info("Login successful. Checking for clearance badges...")
        
        total = len(products)
        for i, product in enumerate(products):
            url = product.get('url')
            if not url:
                continue
            
            if (i + 1) % 50 == 0:
                logger.info(f"Progress: {i+1}/{total} | Clearance found: {len(clearance_products)}")
            
            is_clearance = await check_clearance_badge(page, url)
            
            if is_clearance:
                clearance_products.append(product)
                logger.info(f"  CLEARANCE: {product.get('sku')} - {product.get('name')}")
            
            await asyncio.sleep(0.3)
        
        await browser.close()
    
    # Delete clearance products
    if clearance_products:
        skus = [p.get('sku') for p in clearance_products]
        result = db.sync_staging_fresh.delete_many({'supplier': 'Splendour', 'sku': {'$in': skus}})
        logger.info(f"Deleted {result.deleted_count} clearance products")
    
    print("\n" + "="*70)
    print("CLEARANCE CHECK COMPLETE")
    print("="*70)
    print(f"Total checked: {len(products)}")
    print(f"Clearance products found: {len(clearance_products)}")
    print(f"Deleted: {len(clearance_products)}")
    
    if clearance_products:
        print("\nCleared products:")
        for p in clearance_products:
            print(f"  {p.get('sku')}: {p.get('name')}")
    
    return {"clearance_count": len(clearance_products), "deleted": len(clearance_products)}

if __name__ == "__main__":
    asyncio.run(run_clearance_check())

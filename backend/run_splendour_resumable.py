"""
Resumable Splendour scraper - tracks progress in DB to avoid re-scanning completed categories.
"""
import asyncio
import sys
import logging
import os
import re
from datetime import datetime, timezone

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('/app/splendour_sync.log'),
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)

sys.path.insert(0, '/app/backend')
os.chdir('/app/backend')

from playwright.async_api import async_playwright
from pymongo import MongoClient

client = MongoClient(os.environ.get('MONGO_URL'))
db = client[os.environ.get('DB_NAME', 'tile_station')]
products_col = db.supplier_products
progress_col = db.scraper_progress

CATEGORIES = {
    "wall-tiles": {"url": "/wall-tiles", "type": "ranges"},
    "floor-tiles": {"url": "/floor-tiles", "type": "ranges"},
    "new-collections": {"url": "/new-collections", "type": "ranges"},
    "outdoor-tiles": {"url": "/outdoor-tiles", "type": "ranges"},  # Was missing!
    "adhesive-grout": {"url": "/adhesive-grout", "type": "ranges"},  # Was missing!
    "clearance": {"url": "/clearance", "type": "products"},
    "essentials": {"url": "/essentials", "type": "ranges"},
}

BASE_URL = "https://www.splendourtiles.co.uk"
saved_count = 0


def is_category_done(category: str) -> bool:
    """Check if category was already fully scraped"""
    doc = progress_col.find_one({'supplier': 'splendour', 'category': category})
    return doc is not None and doc.get('status') == 'complete'


def mark_category_done(category: str):
    """Mark category as complete"""
    progress_col.update_one(
        {'supplier': 'splendour', 'category': category},
        {'$set': {'status': 'complete', 'completed_at': datetime.now(timezone.utc).isoformat()}},
        upsert=True
    )
    logger.info(f"CATEGORY {category} MARKED COMPLETE")


def save_product(data: dict) -> bool:
    """Save product immediately"""
    global saved_count
    try:
        sku = data.get('supplier_code')
        name = data.get('name')
        category = data.get('category', '')
        
        existing = None
        if sku:
            existing = products_col.find_one({'supplier': 'splendour', 'supplier_code': sku})
        else:
            existing = products_col.find_one({'supplier': 'splendour', 'name': name})
        
        if existing:
            # Update categories
            existing_cats = existing.get('category', '')
            if category and category not in existing_cats:
                new_cats = f"{existing_cats}, {category}" if existing_cats else category
                products_col.update_one({'_id': existing['_id']}, {'$set': {'category': new_cats}})
            return False
        
        data['supplier'] = 'splendour'
        data['supplier_name'] = 'Splendour'
        data['synced_at'] = datetime.now(timezone.utc).isoformat()
        products_col.insert_one(data)
        saved_count += 1
        return True
    except Exception as e:
        logger.error(f"Error saving: {e}")
        return False


async def run():
    global saved_count
    
    logger.info("=" * 60)
    logger.info("RESUMABLE SPLENDOUR SCRAPER")
    logger.info("=" * 60)
    
    # Check which categories are already done
    pending_categories = {}
    for cat_name, cat_info in CATEGORIES.items():
        if is_category_done(cat_name):
            logger.info(f"SKIPPING {cat_name} - already complete")
        else:
            pending_categories[cat_name] = cat_info
    
    if not pending_categories:
        logger.info("ALL CATEGORIES COMPLETE!")
        count = products_col.count_documents({'supplier': 'splendour'})
        logger.info(f"Total Splendour products: {count}")
        return
    
    logger.info(f"Categories to scrape: {list(pending_categories.keys())}")
    
    playwright = await async_playwright().start()
    browser = await playwright.chromium.launch(headless=True)
    context = await browser.new_context(
        viewport={'width': 1920, 'height': 1080},
        user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    )
    page = await context.new_page()
    
    try:
        # Login
        logger.info("Logging in...")
        await page.goto(f"{BASE_URL}/customer/account/login", timeout=60000)
        await page.wait_for_load_state("networkidle")
        await asyncio.sleep(2)
        
        await page.fill('input[name="email"]', 'accounts@tilestation.co.uk')
        await page.fill('input[name="password"]', os.environ.get("SPLENDOUR_PORTAL_PASSWORD", ""))
        await page.click('button:has-text("Login")')
        await asyncio.sleep(3)
        
        try:
            ok_btn = await page.query_selector('button:has-text("Ok")')
            if ok_btn and await ok_btn.is_visible():
                await ok_btn.click()
        except Exception:
            pass
        
        logger.info("Login successful!")
        
        # Process each pending category
        for cat_name, cat_info in pending_categories.items():
            logger.info(f"\n{'='*60}")
            logger.info(f"SCRAPING: {cat_name.upper()}")
            logger.info(f"{'='*60}")
            
            try:
                if cat_info["type"] == "ranges":
                    await scrape_ranges(page, cat_name, cat_info["url"])
                else:
                    await scrape_direct(page, cat_name, cat_info["url"])
                
                mark_category_done(cat_name)
            except Exception as e:
                logger.error(f"Error in category {cat_name}: {e}")
                continue
        
        count = products_col.count_documents({'supplier': 'splendour'})
        logger.info(f"\nFINAL COUNT: {count} Splendour products")
        
    finally:
        await browser.close()
        await playwright.stop()


async def scrape_ranges(page, category_name, category_path):
    """Scrape category with ranges"""
    url = f"{BASE_URL}{category_path}"
    await page.goto(url, timeout=60000)
    await page.wait_for_load_state("networkidle")
    await asyncio.sleep(3)
    
    # Load all ranges
    all_ranges = set()
    for _ in range(30):
        html = await page.content()
        pattern = rf'href="({category_path}/[a-z0-9-]+)"'
        ranges = re.findall(pattern, html)
        all_ranges.update(ranges)
        
        load_btn = await page.query_selector('button:has-text("LOAD NEXT")')
        if load_btn and await load_btn.is_visible():
            await load_btn.click()
            await asyncio.sleep(2)
        else:
            break
    
    logger.info(f"Found {len(all_ranges)} ranges in {category_name}")
    
    for i, range_url in enumerate(all_ranges):
        try:
            logger.info(f"[{i+1}/{len(all_ranges)}] {range_url}")
            await page.goto(f"{BASE_URL}{range_url}", timeout=60000)
            await page.wait_for_load_state("networkidle")
            await asyncio.sleep(1)
            
            html = await page.content()
            product_urls = list(set(re.findall(r'href="([^"]*-\d+x\d+[^"]*)"', html)))
            
            for prod_url in product_urls:
                if not prod_url.startswith('http'):
                    prod_url = BASE_URL + prod_url
                await scrape_product(page, prod_url, category_name)
                await asyncio.sleep(0.2)
        except Exception as e:
            logger.error(f"Error: {e}")


async def scrape_direct(page, category_name, category_path):
    """Scrape category with direct products"""
    url = f"{BASE_URL}{category_path}"
    await page.goto(url, timeout=60000)
    await page.wait_for_load_state("networkidle")
    await asyncio.sleep(3)
    
    all_products = set()
    for _ in range(30):
        html = await page.content()
        products = re.findall(r'href="(/[a-z0-9-]+-\d+[a-z0-9-x]*)"', html)
        
        skip = ['/wall-tiles', '/floor-tiles', '/clearance', '/new-collections', '/essentials', '/customer', '/i/', '/checkout']
        for p in products:
            if not any(s in p for s in skip) and len(p) > 5:
                all_products.add(p)
        
        load_btn = await page.query_selector('button:has-text("LOAD NEXT")')
        if load_btn and await load_btn.is_visible():
            await load_btn.click()
            await asyncio.sleep(2)
        else:
            break
    
    logger.info(f"Found {len(all_products)} products in {category_name}")
    
    for i, prod_url in enumerate(all_products):
        try:
            logger.info(f"[{i+1}/{len(all_products)}] {prod_url}")
            await scrape_product(page, f"{BASE_URL}{prod_url}", category_name)
            await asyncio.sleep(0.2)
        except Exception as e:
            logger.error(f"Error: {e}")


async def scrape_product(page, url, category_name):
    """Scrape single product"""
    try:
        await page.goto(url, timeout=30000)
        await page.wait_for_load_state("networkidle")
        await asyncio.sleep(0.5)
        
        body = await page.inner_text('body')
        
        sku_match = re.search(r'SKU[:\s]*(\d+)', body)
        sku = sku_match.group(1) if sku_match else ""
        
        h1 = await page.query_selector('h1')
        name = await h1.inner_text() if h1 else ""
        if not name.strip():
            return
        
        stock_match = re.search(r'(\d+(?:\.\d+)?)\s*SQM\s*[iI]n\s*[sS]tock', body)
        stock = float(stock_match.group(1)) if stock_match else 0
        
        price_match = re.search(r'£\s*([\d.]+)\s*/\s*SQM', body, re.I)
        price = float(price_match.group(1)) if price_match else 0
        
        size_match = re.search(r'(\d+)x(\d+)', name) or re.search(r'Size[:\s]*(\d+)x(\d+)', body, re.I)
        size = f"{size_match.group(1)}x{size_match.group(2)}" if size_match else ""
        
        images = []
        for img in await page.query_selector_all('img[src*="tiles"], img[src*="product"]'):
            src = await img.get_attribute('src')
            if src and 'logo' not in src.lower():
                images.append(src if src.startswith('http') else BASE_URL + src)
        
        data = {
            'supplier_code': sku,
            'name': name.strip(),
            'size': size,
            'room_lot_price': price,
            'stock_sqm': stock,
            'stock_status': "In Stock" if stock >= 20 else ("Low Stock" if stock > 0 else "Out of Stock"),
            'images': images[:5],
            'category': category_name,
            'extra_data': {'url': url}
        }
        
        if save_product(data):
            logger.info(f"SAVED: {name} ({sku}) - {category_name}")
        
    except Exception as e:
        logger.error(f"Error scraping {url}: {e}")


if __name__ == "__main__":
    asyncio.run(run())
    print("DONE")

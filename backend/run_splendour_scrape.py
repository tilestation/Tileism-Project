"""
Standalone Splendour scraper with RESUME capability.
Saves products incrementally to sync_staging for Sync Hub review.
If interrupted, can resume from where it left off without duplicating.
"""
import asyncio
import sys
import logging
import os
import re
from typing import Dict, List, Optional, Set
from datetime import datetime, timezone

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('/app/splendour_sync.log'),
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)

# Add backend to path
sys.path.insert(0, '/app/backend')
os.chdir('/app/backend')

from playwright.async_api import async_playwright, Page, Browser
from pymongo import MongoClient

# DB Connection
client = MongoClient(os.environ.get('MONGO_URL'))
db = client[os.environ.get('DB_NAME', 'tile_station')]
staging_collection = db.sync_staging
supplier_collection = db.supplier_products
progress_collection = db.scrape_progress  # Track progress for resume

# Categories to scrape
CATEGORIES = {
    "wall-tiles": {"url": "/wall-tiles", "type": "ranges"},
    "floor-tiles": {"url": "/floor-tiles", "type": "ranges"},
    "new-collections": {"url": "/new-collections", "type": "ranges"},
    "clearance": {"url": "/clearance", "type": "products"},
    "essentials": {"url": "/essentials", "type": "ranges"},
}

BASE_URL = "https://www.splendourtiles.co.uk"
LOGIN_URL = "https://www.splendourtiles.co.uk/customer/account/login"

# Track counts
saved_count = 0
skipped_count = 0
resumed_from = 0


def get_scrape_session():
    """Get or create a scrape session for tracking progress"""
    # Find active session or create new one
    session = progress_collection.find_one({
        "supplier": "Splendour",
        "status": {"$in": ["running", "paused"]}
    })
    
    if session:
        logger.info(f"RESUMING from previous session: {session.get('scraped_ranges', 0)} ranges already done")
        return session
    
    # Create new session
    session = {
        "supplier": "Splendour",
        "started_at": datetime.now(timezone.utc),
        "status": "running",
        "scraped_ranges": [],  # List of range URLs already scraped
        "scraped_categories": [],  # List of categories completed
        "products_saved": 0,
        "products_skipped": 0,
        "last_category": None,
        "last_range": None
    }
    progress_collection.insert_one(session)
    logger.info("Starting NEW scrape session")
    return session


def update_progress(session_id, **kwargs):
    """Update scrape progress"""
    progress_collection.update_one(
        {"_id": session_id},
        {"$set": {**kwargs, "updated_at": datetime.now(timezone.utc)}}
    )


def mark_range_scraped(session_id, range_url: str):
    """Mark a range as scraped"""
    progress_collection.update_one(
        {"_id": session_id},
        {"$addToSet": {"scraped_ranges": range_url}}
    )


def mark_category_complete(session_id, category: str):
    """Mark a category as complete"""
    progress_collection.update_one(
        {"_id": session_id},
        {"$addToSet": {"scraped_categories": category}}
    )


def is_range_scraped(session, range_url: str) -> bool:
    """Check if a range was already scraped"""
    return range_url in session.get("scraped_ranges", [])


def is_category_complete(session, category: str) -> bool:
    """Check if a category was already completed"""
    return category in session.get("scraped_categories", [])


def save_product_to_db(product_data: dict) -> bool:
    """Save a single product to sync_staging. Returns True if new product."""
    global saved_count, skipped_count
    
    try:
        sku = product_data.get('supplier_code')
        name = product_data.get('name')
        category = product_data.get('category', '')
        
        if not name:
            return False
        
        # Check if product exists in staging OR supplier_products
        existing_staging = None
        existing_supplier = None
        
        if sku:
            existing_staging = staging_collection.find_one({'supplier': 'Splendour', 'sku': sku})
            existing_supplier = supplier_collection.find_one({'supplier': 'Splendour', 'supplier_code': sku})
        if not existing_staging and not existing_supplier and name:
            existing_staging = staging_collection.find_one({'supplier': 'Splendour', 'name': name})
            existing_supplier = supplier_collection.find_one({'supplier': 'Splendour', 'name': name})
        
        # Prepare staging document
        staging_doc = {
            "supplier": "Splendour",
            "sku": sku or "",
            "name": name,
            "size": product_data.get('size', ''),
            "material": product_data.get('material', 'Porcelain'),
            "finish": product_data.get('finish', ''),
            "category": category,
            "stock_sqm": product_data.get('stock_sqm', 0),
            "stock_status": product_data.get('stock_status', 'Unknown'),
            "room_lot_price": product_data.get('room_lot_price', 0),
            "images": product_data.get('images', []),
            "extra_data": product_data.get('extra_data', {}),
            "last_synced": datetime.now(timezone.utc),
            "sync_source": "server_scraper",
            "status": "pending"
        }
        
        if existing_staging:
            # Update existing staging entry - add category if new
            existing_cats = existing_staging.get('category', '')
            if category and category not in existing_cats:
                new_cats = f"{existing_cats}, {category}" if existing_cats else category
                staging_doc['category'] = new_cats
            
            staging_collection.update_one(
                {'_id': existing_staging['_id']},
                {'$set': staging_doc}
            )
            skipped_count += 1
            return False
        elif existing_supplier:
            # Product exists in supplier_products, mark as "update"
            staging_doc["status"] = "update"
            staging_doc["existing_id"] = str(existing_supplier.get('_id', ''))
            
            # Add category if new
            existing_cats = existing_supplier.get('category', '')
            if category and category not in existing_cats:
                new_cats = f"{existing_cats}, {category}" if existing_cats else category
                staging_doc['category'] = new_cats
            
            staging_collection.update_one(
                {'supplier': 'Splendour', 'sku': sku} if sku else {'supplier': 'Splendour', 'name': name},
                {'$set': staging_doc},
                upsert=True
            )
            skipped_count += 1
            return False
        else:
            # New product - insert into staging
            staging_doc["status"] = "new"
            staging_collection.insert_one(staging_doc)
            saved_count += 1
            logger.info(f"SAVED: {name} ({sku}) - Category: {category} - Stock: {product_data.get('stock_sqm', 0)}m²")
            return True
        
    except Exception as e:
        logger.error(f"Error saving product {product_data.get('name')}: {e}")
        return False


async def run_scraper():
    """Main scraper function with resume capability"""
    global saved_count, skipped_count, resumed_from
    
    # Get or resume session
    session = get_scrape_session()
    session_id = session["_id"]
    
    # Count already scraped ranges
    resumed_from = len(session.get("scraped_ranges", []))
    if resumed_from > 0:
        logger.info(f"Resuming from {resumed_from} already-scraped ranges")
    
    logger.info("=" * 60)
    logger.info("SPLENDOUR SCRAPER WITH RESUME CAPABILITY")
    logger.info("=" * 60)
    
    # Initialize browser
    playwright = await async_playwright().start()
    browser = await playwright.chromium.launch(headless=True)
    context = await browser.new_context(
        viewport={'width': 1920, 'height': 1080},
        user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    )
    page = await context.new_page()
    
    try:
        # Login
        logger.info("Logging in to Splendour...")
        await page.goto(LOGIN_URL, timeout=60000)
        await page.wait_for_load_state("networkidle")
        await asyncio.sleep(2)
        
        await page.fill('input[name="email"]', 'accounts@tilestation.co.uk')
        await page.fill('input[name="password"]', os.environ.get("SPLENDOUR_PORTAL_PASSWORD", ""))
        await page.click('button:has-text("Login")')
        await asyncio.sleep(3)
        
        # Handle popup
        try:
            ok_btn = await page.query_selector('button:has-text("Ok")')
            if ok_btn and await ok_btn.is_visible():
                await ok_btn.click()
                await asyncio.sleep(1)
        except Exception:
            pass
        
        logger.info("Login successful!")
        
        # Process each category
        for cat_name, cat_info in CATEGORIES.items():
            # Skip completed categories
            if is_category_complete(session, cat_name):
                logger.info(f"SKIPPING category {cat_name} - already completed")
                continue
            
            logger.info(f"\n{'='*60}")
            logger.info(f"CATEGORY: {cat_name.upper()}")
            logger.info(f"{'='*60}")
            
            update_progress(session_id, last_category=cat_name)
            
            if cat_info["type"] == "ranges":
                await scrape_category_with_ranges(page, cat_name, cat_info["url"], session, session_id)
            else:
                await scrape_category_direct_products(page, cat_name, cat_info["url"], session, session_id)
            
            # Mark category complete
            mark_category_complete(session_id, cat_name)
            logger.info(f"Category {cat_name} complete. Total saved: {saved_count}, skipped: {skipped_count}")
        
        # Mark session complete
        update_progress(session_id, 
            status="completed",
            completed_at=datetime.now(timezone.utc),
            products_saved=saved_count,
            products_skipped=skipped_count
        )
        
        logger.info(f"\n{'='*60}")
        logger.info(f"SCRAPE COMPLETE")
        logger.info(f"Total new products saved: {saved_count}")
        logger.info(f"Total duplicates/updates skipped: {skipped_count}")
        logger.info(f"Ranges resumed from: {resumed_from}")
        
        # Final count
        final_count = staging_collection.count_documents({'supplier': 'Splendour'})
        logger.info(f"Total Splendour products in staging: {final_count}")
        logger.info(f"{'='*60}")
        
    except Exception as e:
        logger.error(f"Scraper error: {e}")
        # Mark session as paused so it can resume
        update_progress(session_id,
            status="paused",
            error=str(e),
            products_saved=saved_count,
            products_skipped=skipped_count
        )
        raise
        
    finally:
        await browser.close()
        await playwright.stop()


async def scrape_category_with_ranges(page: Page, category_name: str, category_path: str, session: dict, session_id):
    """Scrape a category that has range pages, with resume support"""
    category_url = f"{BASE_URL}{category_path}"
    
    # Get all ranges
    range_urls = await get_all_ranges(page, category_url, category_path)
    total_ranges = len(range_urls)
    logger.info(f"Found {total_ranges} ranges in {category_name}")
    
    # Filter out already scraped ranges
    ranges_to_scrape = [r for r in range_urls if not is_range_scraped(session, r)]
    skipped_ranges = total_ranges - len(ranges_to_scrape)
    
    if skipped_ranges > 0:
        logger.info(f"RESUMING: Skipping {skipped_ranges} already-scraped ranges")
    
    # Scrape each range
    for i, range_url in enumerate(ranges_to_scrape):
        range_num = skipped_ranges + i + 1
        logger.info(f"[{range_num}/{total_ranges}] Scraping range: {range_url}")
        
        update_progress(session_id, last_range=range_url)
        
        await scrape_range_products(page, category_name, range_url)
        
        # Mark range as scraped
        mark_range_scraped(session_id, range_url)
        
        await asyncio.sleep(1)


async def scrape_category_direct_products(page: Page, category_name: str, category_path: str, session: dict, session_id):
    """Scrape a category that lists products directly (like clearance)"""
    category_url = f"{BASE_URL}{category_path}"
    
    # Check if already scraped (treat whole category as one "range")
    if is_range_scraped(session, category_url):
        logger.info(f"SKIPPING direct category {category_name} - already scraped")
        return
    
    logger.info(f"Scraping direct products from {category_name}...")
    
    await page.goto(category_url, timeout=60000)
    await page.wait_for_load_state("networkidle")
    await asyncio.sleep(2)
    
    # Click Load More until no more
    await click_load_more_until_done(page)
    
    # Extract products
    products = await extract_products_from_page(page, category_name)
    logger.info(f"Found {len(products)} products in {category_name}")
    
    for product in products:
        save_product_to_db(product)
    
    # Mark as scraped
    mark_range_scraped(session_id, category_url)


async def get_all_ranges(page: Page, category_url: str, category_path: str) -> List[str]:
    """Get all range URLs from a category page, clicking Load More as needed"""
    await page.goto(category_url, timeout=60000)
    await page.wait_for_load_state("networkidle")
    await asyncio.sleep(2)
    
    # Click Load More until all ranges are loaded
    click_count = 0
    while True:
        try:
            load_more = await page.query_selector('button:has-text("LOAD NEXT"), button:has-text("Load More")')
            if load_more and await load_more.is_visible():
                await load_more.click()
                await asyncio.sleep(2)
                click_count += 1
                
                # Count current ranges
                links = await page.query_selector_all(f'a[href*="{category_path}/"]')
                logger.info(f"Category {category_path}: {len(links)} ranges loaded (click {click_count})")
            else:
                break
        except Exception as e:
            logger.debug(f"No more Load More button: {e}")
            break
    
    # Extract range URLs
    links = await page.query_selector_all(f'a[href*="{category_path}/"]')
    range_urls = set()
    
    for link in links:
        href = await link.get_attribute('href')
        if href and category_path in href:
            # Clean URL - just get the range path
            path = href.replace(BASE_URL, '').split('?')[0].split('#')[0]
            if path != category_path and len(path.split('/')) == 3:  # e.g., /wall-tiles/metro
                range_urls.add(path)
    
    return sorted(list(range_urls))


async def click_load_more_until_done(page: Page):
    """Click Load More button until no more products to load"""
    while True:
        try:
            load_more = await page.query_selector('button:has-text("LOAD NEXT"), button:has-text("Load More")')
            if load_more and await load_more.is_visible():
                await load_more.click()
                await asyncio.sleep(2)
            else:
                break
        except Exception:
            break


async def scrape_range_products(page: Page, category_name: str, range_path: str):
    """Scrape all products from a range page"""
    range_url = f"{BASE_URL}{range_path}"
    
    await page.goto(range_url, timeout=60000)
    await page.wait_for_load_state("networkidle")
    await asyncio.sleep(2)
    
    # Click Load More if present
    await click_load_more_until_done(page)
    
    # Extract products
    products = await extract_products_from_page(page, category_name)
    
    for product in products:
        save_product_to_db(product)


async def extract_products_from_page(page: Page, category_name: str) -> List[dict]:
    """Extract product data from current page"""
    products = []
    
    # Find all product cards/items
    product_elements = await page.query_selector_all('.product-item, .product-card, [class*="product"]')
    
    for elem in product_elements:
        try:
            # Extract name
            name_elem = await elem.query_selector('h2, h3, .product-name, .product-title, [class*="name"]')
            name = await name_elem.inner_text() if name_elem else None
            
            if not name or len(name) < 3:
                continue
            
            # Extract SKU (often in parentheses)
            sku_match = re.search(r'\((\d{5,7})\)', name)
            sku = sku_match.group(1) if sku_match else ""
            
            # Clean name (remove SKU from name)
            clean_name = re.sub(r'\s*\(\d+\)\s*', ' ', name).strip()
            
            # Extract size from name (e.g., "60x60", "600x600")
            size_match = re.search(r'(\d{2,4})[xX](\d{2,4})', clean_name)
            size = f"{size_match.group(1)}x{size_match.group(2)}" if size_match else ""
            
            # Extract price
            price = 0.0
            price_elem = await elem.query_selector('.price, [class*="price"]')
            if price_elem:
                price_text = await price_elem.inner_text()
                price_match = re.search(r'£\s*([\d.]+)', price_text)
                price = float(price_match.group(1)) if price_match else 0.0
            
            # Extract stock
            stock_sqm = 0.0
            stock_elem = await elem.query_selector('[class*="stock"], [class*="available"]')
            if stock_elem:
                stock_text = await stock_elem.inner_text()
                stock_match = re.search(r'([\d.]+)\s*(?:sqm|m2|m²)', stock_text, re.I)
                stock_sqm = float(stock_match.group(1)) if stock_match else 0.0
            
            # Extract image
            images = []
            img_elem = await elem.query_selector('img')
            if img_elem:
                src = await img_elem.get_attribute('src')
                if src and 'placeholder' not in src.lower():
                    if not src.startswith('http'):
                        src = BASE_URL + src
                    images.append(src)
            
            # Determine stock status
            stock_status = "In Stock" if stock_sqm >= 20 else ("Low Stock" if stock_sqm > 0 else "Out of Stock")
            
            products.append({
                "name": clean_name,
                "supplier_code": sku,
                "size": size,
                "material": "Porcelain",
                "finish": "",
                "category": category_name,
                "stock_sqm": stock_sqm,
                "stock_status": stock_status,
                "room_lot_price": price,
                "images": images,
                "extra_data": {"url": page.url}
            })
            
        except Exception as e:
            logger.debug(f"Error extracting product: {e}")
            continue
    
    return products


def reset_scrape_session():
    """Reset/clear the scrape session to start fresh"""
    progress_collection.delete_many({"supplier": "Splendour"})
    logger.info("Scrape session reset - will start fresh on next run")


if __name__ == "__main__":
    import sys
    
    # Check for reset flag
    if len(sys.argv) > 1 and sys.argv[1] == "--reset":
        reset_scrape_session()
        print("Session reset. Run again without --reset to start fresh scrape.")
    else:
        asyncio.run(run_scraper())
        print("SCRAPE COMPLETE")

#!/usr/bin/env python3
"""
FULL Splendour Production Sync - Comprehensive Crawler
This is the EXACT logic that needs to be in the browser extension.

1. Go to main category page (Wall Tiles or Floor Tiles)
2. Find ALL subcategories in ORDER
3. Within each subcategory, find ALL product URLs (those with dimensions like 600x600)
4. Visit EACH product detail page to extract: SKU, Price, Stock, Images
5. Sync each product to production API
"""

import asyncio
import os
import re
import httpx
from playwright.async_api import async_playwright
from datetime import datetime

# Configuration
PRODUCTION_API = "https://tile-station-production.up.railway.app"
SPLENDOUR_EMAIL = "accounts@tilestation.co.uk"
SPLENDOUR_PASSWORD = os.environ.get("SPLENDOUR_PORTAL_PASSWORD", "")
BASE_URL = "https://www.splendourtiles.co.uk"

# Stats
stats = {
    "categories_scanned": 0,
    "products_found": 0,
    "products_synced": 0,
    "products_failed": 0,
    "products_skipped": 0
}

async def sync_product_to_api(product):
    """Send single product to production API"""
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                f"{PRODUCTION_API}/api/supplier-sync/splendour/products",
                json={
                    "products": [product],
                    "source": "full_crawler_test"
                }
            )
            return response.status_code == 200
    except Exception as e:
        print(f"      API Error: {e}")
        return False

async def extract_from_product_page(page):
    """Extract product data from a product detail page"""
    product = {"url": page.url}
    
    # Get name
    try:
        h1 = await page.query_selector('h1')
        if h1:
            product['name'] = (await h1.inner_text()).strip()
    except Exception:
        pass
    
    if not product.get('name') or 'sorry' in product.get('name', '').lower():
        return None  # Invalid page
    
    # Get page text
    page_text = await page.inner_text('body')
    normalized = re.sub(r'\s+', ' ', page_text.replace('\n', ' '))
    
    # SKU - "SKU: XXXXX"
    sku_match = re.search(r'SKU[:\s]+([A-Z0-9]+)', normalized, re.I)
    if sku_match:
        product['sku'] = sku_match.group(1)
    
    # Price - "£XX.XX/SQM" or "£ XX.XX / SQM"
    price_match = re.search(r'£\s*([\d.]+)\s*/\s*SQM', normalized, re.I)
    if price_match:
        product['price'] = float(price_match.group(1))
    
    # Stock - "XXX SQM in Stock"
    if re.search(r'out\s*of\s*stock', normalized, re.I):
        product['stock_m2'] = 0
        product['in_stock'] = False
    else:
        stock_match = re.search(r'(\d[\d,]*)\s*SQM\s*[Ii]n\s*[Ss]tock', normalized)
        if stock_match:
            product['stock_m2'] = int(stock_match.group(1).replace(',', ''))
            product['in_stock'] = product['stock_m2'] > 0
        else:
            product['stock_m2'] = 0
            product['in_stock'] = False
    
    # Images
    images = []
    img_elements = await page.query_selector_all('img')
    for img in img_elements:
        src = await img.get_attribute('src')
        if src and 'm2wholesale' in src and '56x56' not in src and '48x48' not in src:
            # Extract real URL from proxy URL like /_ipx/.../https://m2wholesale...
            match = re.search(r'(https://m2wholesale[^\s&\?]+)', src)
            if match:
                real_url = match.group(1)
                if real_url not in images:
                    images.append(real_url)
    if images:
        product['images'] = images[:5]
    
    return product

async def main():
    print("=" * 70)
    print("SPLENDOUR FULL PRODUCTION SYNC")
    print("=" * 70)
    print(f"Started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"API: {PRODUCTION_API}")
    print()
    
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        
        # ===== STEP 1: LOGIN =====
        print("[1/5] Logging in to Splendour...")
        await page.goto(f'{BASE_URL}/customer/account/login/', timeout=60000)
        await asyncio.sleep(2)
        await page.fill('input[name="email"]', SPLENDOUR_EMAIL)
        await page.fill('input[name="password"]', SPLENDOUR_PASSWORD)
        await page.click('button[type="submit"]:has-text("Login")')
        await asyncio.sleep(3)
        
        if 'login' not in page.url:
            print("      ✓ Logged in successfully")
        else:
            print("      ✗ Login may have failed")
        
        # ===== STEP 2: GET WALL TILES SUBCATEGORIES =====
        print("\n[2/5] Finding Wall Tiles subcategories...")
        await page.goto(f'{BASE_URL}/wall-tiles', timeout=60000)
        await asyncio.sleep(2)
        
        # Get all subcategory links
        links = await page.query_selector_all('a')
        wall_subcategories = []
        
        for link in links:
            href = await link.get_attribute('href')
            if href:
                if href.startswith('/'):
                    href = BASE_URL + href
                # Match /wall-tiles/something but not /wall-tiles/something/something
                if re.match(r'^https://www\.splendourtiles\.co\.uk/wall-tiles/[a-z0-9-]+$', href, re.I):
                    if href not in wall_subcategories:
                        wall_subcategories.append(href)
        
        print(f"      Found {len(wall_subcategories)} Wall Tiles subcategories")
        
        # ===== STEP 3: GET FLOOR TILES SUBCATEGORIES =====
        print("\n[3/5] Finding Floor Tiles subcategories...")
        await page.goto(f'{BASE_URL}/floor-tiles', timeout=60000)
        await asyncio.sleep(2)
        
        links = await page.query_selector_all('a')
        floor_subcategories = []
        
        for link in links:
            href = await link.get_attribute('href')
            if href:
                if href.startswith('/'):
                    href = BASE_URL + href
                if re.match(r'^https://www\.splendourtiles\.co\.uk/floor-tiles/[a-z0-9-]+$', href, re.I):
                    if href not in floor_subcategories:
                        floor_subcategories.append(href)
        
        print(f"      Found {len(floor_subcategories)} Floor Tiles subcategories")
        
        # Combine all subcategories - Wall Tiles FIRST, then Floor Tiles
        all_subcategories = wall_subcategories + floor_subcategories
        print(f"\n      Total: {len(all_subcategories)} subcategories to crawl")
        
        # ===== STEP 4: CRAWL SUBCATEGORIES TO FIND PRODUCT URLS =====
        print("\n[4/5] Crawling subcategories to find products...")
        all_product_urls = []
        
        for i, subcat_url in enumerate(all_subcategories):
            subcat_name = subcat_url.split('/')[-1]
            print(f"\n      [{i+1}/{len(all_subcategories)}] {subcat_name}...")
            
            try:
                await page.goto(subcat_url, timeout=30000)
                await asyncio.sleep(1.5)
                
                # Find product URLs (those with dimensions like 600x600)
                links = await page.query_selector_all('a')
                subcat_products = []
                
                for link in links:
                    href = await link.get_attribute('href')
                    if href and re.search(r'\d+x\d+', href):
                        if href.startswith('/'):
                            href = BASE_URL + href
                        clean_url = href.split('?')[0]
                        if clean_url not in all_product_urls:
                            all_product_urls.append(clean_url)
                            subcat_products.append(clean_url)
                
                print(f"         → Found {len(subcat_products)} new products")
                stats['categories_scanned'] += 1
                
            except Exception as e:
                print(f"         ✗ Error: {str(e)[:50]}")
        
        stats['products_found'] = len(all_product_urls)
        print(f"\n      Total unique products found: {len(all_product_urls)}")
        
        # ===== STEP 5: VISIT EACH PRODUCT PAGE AND SYNC =====
        print("\n[5/5] Visiting each product page and syncing...")
        print("      (This will take a while - visiting each page individually)\n")
        
        for i, product_url in enumerate(all_product_urls):
            product_slug = product_url.split('/')[-1]
            short_name = product_slug[:40] + "..." if len(product_slug) > 40 else product_slug
            
            try:
                # Navigate to product page
                await page.goto(product_url, timeout=20000)
                await asyncio.sleep(1)
                
                # Extract data
                product = await extract_from_product_page(page)
                
                if product and product.get('name') and product.get('sku'):
                    # Sync to API
                    success = await sync_product_to_api(product)
                    
                    if success:
                        stats['products_synced'] += 1
                        stock_info = f"{product.get('stock_m2', 0)}m²"
                        price_info = f"£{product.get('price', 0)}"
                        print(f"   ✓ [{i+1}/{len(all_product_urls)}] {product['sku']}: {product['name'][:35]}... ({price_info}, {stock_info})")
                    else:
                        stats['products_failed'] += 1
                        print(f"   ✗ [{i+1}/{len(all_product_urls)}] API failed: {short_name}")
                else:
                    stats['products_skipped'] += 1
                    print(f"   - [{i+1}/{len(all_product_urls)}] Skipped (no data): {short_name}")
                
            except Exception as e:
                stats['products_failed'] += 1
                print(f"   ✗ [{i+1}/{len(all_product_urls)}] Error: {short_name} - {str(e)[:30]}")
            
            # Progress update every 20 products
            if (i + 1) % 20 == 0:
                print(f"\n   --- Progress: {i+1}/{len(all_product_urls)} ({stats['products_synced']} synced, {stats['products_failed']} failed) ---\n")
        
        await browser.close()
    
    # ===== FINAL REPORT =====
    print("\n" + "=" * 70)
    print("SYNC COMPLETE")
    print("=" * 70)
    print(f"Finished: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print()
    print(f"Categories Scanned:  {stats['categories_scanned']}")
    print(f"Products Found:      {stats['products_found']}")
    print(f"Products Synced:     {stats['products_synced']}")
    print(f"Products Failed:     {stats['products_failed']}")
    print(f"Products Skipped:    {stats['products_skipped']}")
    print()
    print(f"View results at: {PRODUCTION_API}")
    print("   → Products & Suppliers → Sync Hub → Splendour tab")
    print("=" * 70)

if __name__ == '__main__':
    asyncio.run(main())

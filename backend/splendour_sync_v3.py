#!/usr/bin/env python3
"""
Splendour Production Sync - Batch Mode with Correct SKU Extraction
"""

import asyncio
import os
import re
import httpx
from playwright.async_api import async_playwright

PRODUCTION_API = "https://tile-station-production.up.railway.app"
SPLENDOUR_EMAIL = "accounts@tilestation.co.uk"
SPLENDOUR_PASSWORD = os.environ.get("SPLENDOUR_PORTAL_PASSWORD", "")
BASE_URL = "https://www.splendourtiles.co.uk"

async def sync_batch(products):
    """Send a batch of products to production API"""
    if not products:
        return None
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                f"{PRODUCTION_API}/api/supplier-sync/splendour/products",
                json={"products": products, "source": "production_sync_v3"}
            )
            if response.status_code == 200:
                return response.json()
    except Exception as e:
        print(f"    Sync error: {e}")
    return None

async def get_product_details(page, url):
    """Extract product details with correct SKU and images"""
    try:
        await page.goto(url, wait_until='domcontentloaded', timeout=20000)
        await asyncio.sleep(1.5)
        
        product = {'url': url}
        page_text = await page.inner_text('body')
        
        # Get name
        try:
            name_el = await page.query_selector('h1')
            if name_el:
                product['name'] = (await name_el.inner_text()).strip()
        except Exception:
            pass
        
        if not product.get('name'):
            url_slug = url.rstrip('/').split('/')[-1]
            product['name'] = url_slug.replace('-', ' ').title()
        
        # Extract SKU - look for "SKU: XXXXX" pattern
        sku_match = re.search(r'SKU[:\s]+([A-Z0-9]+)', page_text, re.I)
        if sku_match:
            product['sku'] = sku_match.group(1)
        else:
            return None  # Skip products without proper SKU
        
        # Get price per m²
        price_match = re.search(r'£\s*([\d.]+)\s*/?\s*(?:sqm|SQM|per\s*m)', page_text, re.I)
        if price_match:
            product['price'] = float(price_match.group(1))
        
        # Get stock
        stock_match = re.search(r'(\d+)\s*SQM\s*In\s*Stock', page_text, re.I)
        if stock_match:
            product['stock_m2'] = int(stock_match.group(1))
            product['in_stock'] = product['stock_m2'] > 0
        elif re.search(r'out\s*of\s*stock', page_text, re.I):
            product['in_stock'] = False
            product['stock_m2'] = 0
        else:
            product['in_stock'] = True
            product['stock_m2'] = 0
        
        # Extract product images
        images = await page.query_selector_all('img')
        product_images = []
        seen_urls = set()
        
        for img in images:
            src = await img.get_attribute('src')
            if not src:
                continue
            
            # Extract real URL from the proxy URL pattern
            # /_ipx/.../https://m2wholesale...
            url_match = re.search(r'(https://m2wholesale[^\s&]+)', src)
            if url_match:
                real_url = url_match.group(1)
                # Skip thumbnails
                if 's_56x56' in src or 's_48x48' in src:
                    continue
                if real_url not in seen_urls:
                    seen_urls.add(real_url)
                    product_images.append(real_url)
        
        if product_images:
            product['images'] = product_images[:5]  # Max 5 images
        
        return product
    except Exception as e:
        return None

async def main():
    print("=" * 60)
    print("SPLENDOUR PRODUCTION SYNC v3 - Correct SKU Extraction")
    print("=" * 60)
    
    total_synced = 0
    total_new = 0
    total_updated = 0
    
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        
        # Login
        print("\n[1] Logging in...")
        await page.goto(f'{BASE_URL}/customer/account/login/', timeout=60000)
        await asyncio.sleep(2)
        await page.fill('input[name="email"]', SPLENDOUR_EMAIL)
        await page.fill('input[name="password"]', SPLENDOUR_PASSWORD)
        await page.click('button[type="submit"]:has-text("Login")')
        await asyncio.sleep(3)
        print("✅ Logged in")
        
        # Get collections
        print("\n[2] Finding tile collections...")
        await page.goto(f'{BASE_URL}/wall-tiles', timeout=60000)
        await asyncio.sleep(2)
        
        collection_links = await page.query_selector_all('a')
        collections = set()
        for link in collection_links:
            href = await link.get_attribute('href')
            if href:
                if href.startswith('/'):
                    href = BASE_URL + href
                if re.match(r'.*/(?:wall|floor)-tiles/[a-z0-9-]+$', href, re.I):
                    collections.add(href)
        
        await page.goto(f'{BASE_URL}/floor-tiles', timeout=60000)
        await asyncio.sleep(1)
        floor_links = await page.query_selector_all('a')
        for link in floor_links:
            href = await link.get_attribute('href')
            if href:
                if href.startswith('/'):
                    href = BASE_URL + href
                if re.match(r'.*/(?:wall|floor)-tiles/[a-z0-9-]+$', href, re.I):
                    collections.add(href)
        
        print(f"Found {len(collections)} collections")
        
        # Crawl collections and find products
        print("\n[3] Crawling and syncing...")
        all_product_urls = set()
        collections_list = list(collections)  # Process all collections
        
        for i, coll_url in enumerate(collections_list):
            coll_name = coll_url.split('/')[-1]
            print(f"\n  [{i+1}/{len(collections_list)}] {coll_name}")
            
            try:
                await page.goto(coll_url, timeout=25000)
                await asyncio.sleep(1.5)
                
                # Find product URLs
                links = await page.query_selector_all('a')
                product_urls = []
                for link in links:
                    href = await link.get_attribute('href')
                    if href and re.search(r'\d+x\d+', href):
                        if href.startswith('/'):
                            href = BASE_URL + href
                        if href not in all_product_urls:
                            product_urls.append(href)
                            all_product_urls.add(href)
                
                if not product_urls:
                    print(f"      No new products found")
                    continue
                
                print(f"      Found {len(product_urls)} new products")
                
                # Extract and sync batch
                batch = []
                for j, prod_url in enumerate(product_urls[:20]):  # Max 20 per collection
                    product = await get_product_details(page, prod_url)
                    if product and product.get('sku'):
                        batch.append(product)
                        img_count = len(product.get('images', []))
                        img_info = f", {img_count} imgs" if img_count > 0 else ""
                        print(f"      ✓ {product['sku']}: {product['name'][:35]}... (£{product.get('price', 'N/A')}{img_info})")
                
                # Sync batch
                if batch:
                    result = await sync_batch(batch)
                    if result:
                        total_synced += result.get('synced', 0)
                        total_new += result.get('new', 0)
                        total_updated += result.get('updated', 0)
                        print(f"      → Synced {result.get('synced', 0)} products")
                        
            except Exception as e:
                print(f"      ❌ Error: {str(e)[:50]}")
                continue
        
        await browser.close()
    
    print("\n" + "=" * 60)
    print("✅ SYNC COMPLETE")
    print("=" * 60)
    print(f"  Total synced: {total_synced}")
    print(f"  New: {total_new}")
    print(f"  Updated: {total_updated}")
    print(f"\n📍 View at: https://tile-station-production.up.railway.app")
    print("   → Products & Suppliers > Sync Hub > Splendour tab")

if __name__ == '__main__':
    asyncio.run(main())

#!/usr/bin/env python3
"""
Splendour Production Sync Test Script v2
- Logs into splendourtiles.co.uk
- Crawls tile collections and extracts individual products
- Syncs to production API
"""

import asyncio
import re
import json
import httpx
from playwright.async_api import async_playwright

# Production API
PRODUCTION_API = "https://tile-station-production.up.railway.app"

# Splendour credentials
SPLENDOUR_EMAIL = "accounts@tilestation.co.uk"
SPLENDOUR_PASSWORD = "Tilestation_133"
BASE_URL = "https://www.splendourtiles.co.uk"

async def get_product_details(page, url):
    """Visit product detail page and extract full details"""
    try:
        await page.goto(url, wait_until='domcontentloaded', timeout=30000)
        await asyncio.sleep(1.5)
        
        product = {'url': url}
        
        # Get page text for parsing
        page_text = await page.inner_text('body')
        
        # Get name from h1 or title
        try:
            name_el = await page.query_selector('h1')
            if name_el:
                product['name'] = (await name_el.inner_text()).strip()
        except Exception:
            pass
        
        if not product.get('name'):
            # Extract from URL
            url_parts = url.rstrip('/').split('/')[-1]
            product['name'] = url_parts.replace('-', ' ').title()
        
        # Extract SKU - look for "SKU: XXXXX" pattern in page text
        sku_match = re.search(r'SKU[:\s]+([A-Z0-9]+)', page_text, re.I)
        if sku_match:
            product['sku'] = sku_match.group(1)
        else:
            # Fallback to URL slug only if no SKU found
            url_slug = url.rstrip('/').split('/')[-1]
            product['sku'] = url_slug
        
        # Get price per m²
        price_match = re.search(r'£\s*([\d.]+)\s*/?\s*(?:sqm|SQM|per\s*m)', page_text, re.I)
        if price_match:
            product['price'] = float(price_match.group(1))
        
        # Get stock - look for "X SQM In Stock" or "In Stock: X"
        stock_patterns = [
            r'(\d+)\s*SQM\s*In\s*Stock',
            r'In\s*Stock[:\s]+(\d+)',
            r'(\d+)\s*(?:sqm|m²)\s*available',
        ]
        for pattern in stock_patterns:
            match = re.search(pattern, page_text, re.I)
            if match:
                product['stock_m2'] = int(match.group(1))
                product['in_stock'] = product['stock_m2'] > 0
                break
        
        # Check for "Out of Stock"
        if re.search(r'out\s*of\s*stock', page_text, re.I):
            product['in_stock'] = False
            product['stock_m2'] = 0
        
        # Default in_stock if not set
        if 'in_stock' not in product:
            product['in_stock'] = True
            product['stock_m2'] = 0
        
        return product
        
    except Exception as e:
        print(f"    Error getting details from {url}: {e}")
        return None

async def sync_to_production(products):
    """Send products to production API"""
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                f"{PRODUCTION_API}/api/supplier-sync/splendour/products",
                json={
                    "products": products,
                    "source": "production_test_crawler_v2"
                }
            )
            
            if response.status_code == 200:
                result = response.json()
                return result
            else:
                print(f"❌ API Error: {response.status_code} - {response.text}")
                return None
                
    except Exception as e:
        print(f"❌ Sync error: {e}")
        return None

async def main():
    print("=" * 60)
    print("SPLENDOUR PRODUCTION SYNC TEST v2")
    print("=" * 60)
    
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        )
        page = await context.new_page()
        
        # Step 1: Login to Splendour
        print("\n[1/5] Logging in to splendourtiles.co.uk...")
        await page.goto(f'{BASE_URL}/customer/account/login/', timeout=60000)
        await asyncio.sleep(3)
        
        await page.fill('input[name="email"]', SPLENDOUR_EMAIL)
        await page.fill('input[name="password"]', SPLENDOUR_PASSWORD)
        await page.click('button[type="submit"]:has-text("Login")')
        await asyncio.sleep(4)
        
        if 'login' not in page.url:
            print("✅ Login successful!")
        else:
            print("⚠️ Login may have failed, continuing anyway...")
        
        # Step 2: Get tile collections from Wall Tiles page
        print("\n[2/5] Finding tile collections...")
        await page.goto(f'{BASE_URL}/wall-tiles', timeout=60000)
        await asyncio.sleep(2)
        
        # Find all collection links (e.g., /wall-tiles/agora)
        collection_links = await page.query_selector_all('a')
        collections = set()
        
        for link in collection_links:
            href = await link.get_attribute('href')
            if href:
                if href.startswith('/'):
                    href = BASE_URL + href
                # Match collection URLs like /wall-tiles/agora or /floor-tiles/xyz
                if re.match(r'.*/(?:wall|floor)-tiles/[a-z0-9-]+$', href, re.I):
                    collections.add(href)
        
        # Also get floor tiles collections
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
        
        print(f"Found {len(collections)} tile collections")
        
        # Step 3: Crawl collections and find individual products
        print("\n[3/5] Crawling tile collections...")
        all_product_urls = set()
        
        # Process first 15 collections for larger test
        collections_list = list(collections)[:15]
        
        for i, collection_url in enumerate(collections_list):
            print(f"  [{i+1}/{len(collections_list)}] {collection_url.split('/')[-1]}")
            
            try:
                await page.goto(collection_url, timeout=30000)
                await asyncio.sleep(2)
                
                # Find product links (URLs with dimensions like 600x300)
                links = await page.query_selector_all('a')
                for link in links:
                    href = await link.get_attribute('href')
                    if href and re.search(r'\d+x\d+', href):
                        if href.startswith('/'):
                            href = BASE_URL + href
                        all_product_urls.add(href.split('?')[0])
                        
            except Exception as e:
                print(f"    ❌ Error: {e}")
                continue
        
        print(f"\n  Total unique products found: {len(all_product_urls)}")
        
        # Step 4: Extract details from each product
        print("\n[4/5] Extracting product details...")
        all_products = []
        
        # Process up to 100 products for larger test
        product_urls_list = list(all_product_urls)[:100]
        
        for i, prod_url in enumerate(product_urls_list):
            product = await get_product_details(page, prod_url)
            
            if product and product.get('name'):
                all_products.append(product)
                stock_info = f"Stock: {product.get('stock_m2', 0)}m²" if product.get('stock_m2') else "Stock: N/A"
                price_info = f"£{product.get('price', 0)}" if product.get('price') else "Price: N/A"
                print(f"  ✓ [{i+1}/{len(product_urls_list)}] {product.get('name', 'Unknown')[:45]}... ({price_info}, {stock_info})")
            else:
                print(f"  ✗ [{i+1}/{len(product_urls_list)}] Failed to extract from {prod_url.split('/')[-1]}")
        
        print(f"\n  Successfully extracted: {len(all_products)} products")
        
        # Step 5: Sync to production
        print("\n[5/5] Syncing to production Sync Hub...")
        
        if all_products:
            result = await sync_to_production(all_products)
            
            if result:
                print("\n" + "=" * 60)
                print("✅ SYNC COMPLETE!")
                print("=" * 60)
                print(f"  Products sent: {len(all_products)}")
                print(f"  Synced: {result.get('synced', 0)}")
                print(f"  New: {result.get('new', 0)}")
                print(f"  Updated: {result.get('updated', 0)}")
                print(f"  Errors: {result.get('errors', 0)}")
                print(f"\n📍 View results at:")
                print(f"   https://tile-station-production.up.railway.app")
                print(f"   Navigate to: Products & Suppliers > Sync Hub > Splendour tab")
            else:
                print("❌ Sync failed - check API logs")
        else:
            print("❌ No products to sync")
        
        await browser.close()
        
        return all_products

if __name__ == '__main__':
    asyncio.run(main())

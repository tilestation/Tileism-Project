"""
Missing Products Investigation Script
======================================
This script checks if products marked as "Missing from Sync" actually exist on the Splendour website.
If they exist, it extracts their data and adds them to the database.

The user reported that YTVINBLU and TEHMMETNERO are visible on the website but were missed by the sync.
This suggests the full sync may have missed certain categories or products.
"""

import asyncio
import json
import os
import re
import logging
from datetime import datetime, timezone
from pymongo import MongoClient
import pandas as pd

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Configuration
BASE_URL = "https://www.splendourtiles.co.uk"
SPLENDOUR_EMAIL = "accounts@tilestation.co.uk"
SPLENDOUR_PASSWORD = os.environ.get("SPLENDOUR_PORTAL_PASSWORD", "")

def get_db():
    client = MongoClient(os.environ.get('MONGO_URL', 'mongodb://localhost:27017'))
    return client[os.environ.get('DB_NAME', 'test_database')]

async def perform_login(page) -> bool:
    """Login to Splendour trade portal"""
    try:
        await page.goto(f'{BASE_URL}/customer/account/login/', timeout=60000)
        await asyncio.sleep(2)
        await page.fill('input[name="email"]', SPLENDOUR_EMAIL)
        await page.fill('input[name="password"]', SPLENDOUR_PASSWORD)
        await page.click('button[type="submit"]:has-text("Login")')
        await asyncio.sleep(3)
        
        if 'login' in page.url:
            return False
        return True
    except Exception as e:
        logger.error(f"Login error: {e}")
        return False

async def search_product(page, sku: str) -> dict:
    """
    Search for a product by SKU on Splendour website.
    Returns product data if found, None otherwise.
    """
    result = {
        'sku': sku,
        'found': False,
        'url': None,
        'name': None,
        'price': None,
        'stock_m2': None,
        'in_stock': False,
        'category': None,
        'error': None
    }
    
    try:
        # Use the search functionality
        search_url = f'{BASE_URL}/catalogsearch/result/?q={sku}'
        await page.goto(search_url, timeout=30000)
        await asyncio.sleep(2)
        
        # Check if we got results
        page_text = await page.inner_text('body')
        
        # Check for "no results" message
        if 'no results' in page_text.lower() or 'your search returned no results' in page_text.lower():
            result['found'] = False
            return result
        
        # Look for product cards in search results
        product_cards = await page.query_selector_all('[data-testid="product-card"], .product-card, .product-item')
        
        if product_cards:
            # Click the first product to get details
            first_card = product_cards[0]
            link = await first_card.query_selector('a')
            if link:
                href = await link.get_attribute('href')
                if href:
                    product_url = href if href.startswith('http') else BASE_URL + href
                    await page.goto(product_url, timeout=30000)
                    await asyncio.sleep(2)
                    
                    # Extract product data
                    product_data = await extract_product_data(page)
                    if product_data:
                        result.update(product_data)
                        result['found'] = True
                        result['url'] = page.url
                        
                        # Get category from breadcrumb
                        try:
                            breadcrumb = await page.query_selector('nav.breadcrumb, .breadcrumb, [aria-label="breadcrumb"]')
                            if breadcrumb:
                                bc_text = await breadcrumb.inner_text()
                                result['category'] = bc_text.strip()
                        except Exception:
                            pass
        else:
            # Maybe the search redirected directly to the product page
            if '/catalogsearch/' not in page.url:
                product_data = await extract_product_data(page)
                if product_data and product_data.get('name'):
                    result.update(product_data)
                    result['found'] = True
                    result['url'] = page.url
        
    except asyncio.TimeoutError:
        result['error'] = 'Timeout'
    except Exception as e:
        result['error'] = str(e)
    
    return result

async def extract_product_data(page) -> dict:
    """Extract product data from a product detail page"""
    try:
        product = {}
        
        # Get name
        h1 = await page.query_selector('h1')
        if h1:
            product['name'] = (await h1.inner_text()).strip()
        
        if not product.get('name'):
            return None
        
        # Get page text for regex extraction
        page_text = await page.inner_text('body')
        normalized = re.sub(r'\s+', ' ', page_text.replace('\n', ' '))
        
        # SKU
        sku_match = re.search(r'SKU[:\s]+([A-Z0-9]+)', normalized, re.I)
        if sku_match:
            product['extracted_sku'] = sku_match.group(1)
        
        # Product ID (sometimes different from SKU)
        pid_match = re.search(r'Product ID[:\s]+([A-Z0-9]+)', normalized, re.I)
        if pid_match:
            product['product_id'] = pid_match.group(1)
        
        # Price (per SQM)
        price_match = re.search(r'£\s*([\d.]+)\s*/\s*SQM', normalized, re.I)
        if price_match:
            product['price'] = float(price_match.group(1))
        
        # Stock
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
        
        # Size/Dimensions
        size_match = re.search(r'Size[:\s]+(\d+x\d+(?:x\d+)?mm)', normalized, re.I)
        if size_match:
            product['size'] = size_match.group(1)
        
        # Get images
        images = []
        a_elements = await page.query_selector_all('a[href*="m2wholesale"]')
        for a in a_elements:
            href = await a.get_attribute('href')
            if href and 'm2wholesale' in href and ('2300X2300' in href or '650X650' in href):
                if 'video_thumbnail' not in href and '100X100' not in href:
                    clean_url = href.split('?')[0]
                    if clean_url not in images:
                        images.append(clean_url)
        
        if images:
            product['images'] = images[:5]
            product['image'] = images[0]
        
        return product
        
    except Exception as e:
        logger.error(f"Error extracting product data: {e}")
        return None

async def run_missing_products_check():
    """Main function to check all missing products"""
    
    # Load missing SKUs from the comparison report
    df = pd.read_excel('/app/Splendour_Sync_Comparison_Report.xlsx', sheet_name='Missing from Sync', header=1)
    sku_col = df.columns[0]
    missing_skus = [str(s).strip() for s in df[sku_col].dropna() 
                    if str(s).strip() and str(s).strip().upper() != 'SKU/PRODUCT CODE' and str(s).strip() != 'nan']
    
    logger.info(f"Loaded {len(missing_skus)} 'missing' SKUs to check")
    
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        logger.error("Playwright not installed")
        return {"error": "Playwright not available"}
    
    results = {
        'found_products': [],
        'not_found_products': [],
        'errors': [],
        'total_checked': 0,
        'found_count': 0,
        'not_found_count': 0,
        'error_count': 0,
        'checked_at': datetime.now(timezone.utc).isoformat()
    }
    
    db = get_db()
    
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            page = await browser.new_page()
            
            # Login first
            logger.info("Logging in to Splendour...")
            if not await perform_login(page):
                logger.error("Login failed")
                return {"error": "Login failed"}
            
            logger.info("Login successful. Starting missing products check...")
            
            total = len(missing_skus)
            for i, sku in enumerate(missing_skus):
                if (i + 1) % 10 == 0 or i == 0:
                    logger.info(f"Progress: {i+1}/{total} | Found: {results['found_count']} | Not Found: {results['not_found_count']}")
                
                check_result = await search_product(page, sku)
                results['total_checked'] += 1
                
                if check_result.get('error'):
                    results['errors'].append(check_result)
                    results['error_count'] += 1
                elif check_result['found']:
                    results['found_products'].append(check_result)
                    results['found_count'] += 1
                    logger.info(f"  FOUND: {sku} -> {check_result.get('name', 'Unknown')}")
                    
                    # Add to database
                    product_data = {
                        "supplier": "Splendour",
                        "sku": sku,
                        "name": check_result.get('name'),
                        "url": check_result.get('url'),
                        "price": check_result.get('price'),
                        "stock_m2": check_result.get('stock_m2', 0),
                        "in_stock": check_result.get('in_stock', False),
                        "image": check_result.get('image'),
                        "images": check_result.get('images', []),
                        "size": check_result.get('size'),
                        "category": check_result.get('category'),
                        "synced_at": datetime.now(timezone.utc),
                        "sync_source": "missing_products_investigation",
                        "was_missing_from_sync": True
                    }
                    
                    db.sync_staging.update_one(
                        {"supplier": "Splendour", "sku": sku},
                        {"$set": product_data},
                        upsert=True
                    )
                else:
                    results['not_found_products'].append(check_result)
                    results['not_found_count'] += 1
                
                # Small delay between requests
                await asyncio.sleep(0.5)
            
            await browser.close()
    
    except Exception as e:
        logger.error(f"Error during check: {e}")
        results['error'] = str(e)
    
    # Save results to file
    output_path = '/app/missing_products_check_results.json'
    with open(output_path, 'w') as f:
        json.dump(results, f, indent=2, default=str)
    
    logger.info(f"Results saved to {output_path}")
    
    # Print summary
    print("\n" + "="*70)
    print("MISSING PRODUCTS CHECK - FINAL SUMMARY")
    print("="*70)
    print(f"Total SKUs checked: {results['total_checked']}")
    print(f"Products FOUND on website: {results['found_count']}")
    print(f"Products NOT found: {results['not_found_count']}")
    print(f"Errors: {results['error_count']}")
    print("="*70)
    
    if results['found_products']:
        print("\n" + "-"*70)
        print("PRODUCTS FOUND (added to database):")
        print("-"*70)
        for p in results['found_products']:
            print(f"  {p['sku']}: {p.get('name', 'Unknown')}")
            print(f"    URL: {p.get('url', 'N/A')}")
            print(f"    Category: {p.get('category', 'N/A')}")
            print()
    
    return results

if __name__ == "__main__":
    asyncio.run(run_missing_products_check())

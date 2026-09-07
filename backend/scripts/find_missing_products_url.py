"""
Missing Products Finder - URL Based Approach
=============================================
This script finds missing products by:
1. Getting product names from the spreadsheet
2. Converting names to URL slugs
3. Checking if those URLs exist on the website
4. Extracting product data and adding to database
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

def name_to_url_slug(name: str) -> str:
    """Convert product name to URL slug"""
    # Convert to lowercase
    slug = name.lower()
    # Replace special characters and spaces with hyphens
    slug = re.sub(r'[^a-z0-9]+', '-', slug)
    # Remove leading/trailing hyphens
    slug = slug.strip('-')
    # Replace multiple hyphens with single hyphen
    slug = re.sub(r'-+', '-', slug)
    return slug

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

async def check_url_and_extract(page, url: str, sku: str, name: str) -> dict:
    """Check if URL exists and extract product data"""
    result = {
        'sku': sku,
        'name': name,
        'found': False,
        'url': url,
        'extracted_data': None,
        'error': None
    }
    
    try:
        response = await page.goto(url, timeout=30000)
        await asyncio.sleep(1.5)
        
        # Check if page exists (not 404)
        if response and response.status == 200:
            # Check if it's a product page (not search results or error page)
            page_text = await page.inner_text('body')
            
            # Look for product indicators
            h1 = await page.query_selector('h1')
            if h1:
                h1_text = await h1.inner_text()
                
                # Make sure it's not an error page
                if 'not found' not in h1_text.lower() and 'sorry' not in h1_text.lower():
                    result['found'] = True
                    
                    # Extract product data
                    product = {'name': h1_text.strip()}
                    
                    normalized = re.sub(r'\s+', ' ', page_text.replace('\n', ' '))
                    
                    # SKU
                    sku_match = re.search(r'SKU[:\s]+([A-Z0-9]+)', normalized, re.I)
                    if sku_match:
                        product['extracted_sku'] = sku_match.group(1)
                    
                    # Product ID
                    pid_match = re.search(r'Product ID[:\s]+([A-Z0-9]+)', normalized, re.I)
                    if pid_match:
                        product['product_id'] = pid_match.group(1)
                    
                    # Price
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
                    
                    # Size
                    size_match = re.search(r'Size[:\s]+(\d+x\d+(?:x\d+)?mm)', normalized, re.I)
                    if size_match:
                        product['size'] = size_match.group(1)
                    
                    # Images
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
                    
                    # Category from breadcrumb
                    try:
                        breadcrumb = await page.query_selector('nav.breadcrumb, .breadcrumb, [aria-label="breadcrumb"]')
                        if breadcrumb:
                            bc_text = await breadcrumb.inner_text()
                            product['category'] = bc_text.strip()
                    except Exception:
                        pass
                    
                    result['extracted_data'] = product
        
    except asyncio.TimeoutError:
        result['error'] = 'Timeout'
    except Exception as e:
        result['error'] = str(e)
    
    return result

async def run_missing_products_finder():
    """Main function to find and add missing products"""
    
    # Load spreadsheet
    df = pd.read_excel('/app/supplier_data/Splendour_Pricelist.xlsx', header=2)
    sku_col = 'Sku No'
    name_col = 'Product Description'
    
    # Create lookup
    sku_to_name = {}
    for i, row in df.iterrows():
        sku = str(row[sku_col]).strip()
        name = str(row[name_col]).strip() if pd.notna(row[name_col]) else ''
        if sku and name and name != 'nan':
            sku_to_name[sku] = name
    
    # Load missing SKUs
    missing_df = pd.read_excel('/app/Splendour_Sync_Comparison_Report.xlsx', sheet_name='Missing from Sync', header=1)
    missing_sku_col = missing_df.columns[0]
    missing_skus = [str(s).strip() for s in missing_df[missing_sku_col].dropna() 
                    if str(s).strip() and str(s).strip().upper() != 'SKU/PRODUCT CODE' and str(s).strip() != 'nan']
    
    # Filter to only SKUs with names
    products_to_check = []
    for sku in missing_skus:
        if sku in sku_to_name:
            name = sku_to_name[sku]
            slug = name_to_url_slug(name)
            url = f"{BASE_URL}/{slug}"
            products_to_check.append({
                'sku': sku,
                'name': name,
                'slug': slug,
                'url': url
            })
    
    logger.info(f"Total missing SKUs: {len(missing_skus)}")
    logger.info(f"SKUs with product names: {len(products_to_check)}")
    
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
            
            logger.info("Login successful. Starting product check...")
            
            total = len(products_to_check)
            for i, product in enumerate(products_to_check):
                sku = product['sku']
                name = product['name']
                url = product['url']
                
                if (i + 1) % 10 == 0 or i == 0:
                    logger.info(f"Progress: {i+1}/{total} | Found: {results['found_count']} | Not Found: {results['not_found_count']}")
                
                check_result = await check_url_and_extract(page, url, sku, name)
                results['total_checked'] += 1
                
                if check_result.get('error'):
                    results['errors'].append(check_result)
                    results['error_count'] += 1
                elif check_result['found']:
                    results['found_products'].append(check_result)
                    results['found_count'] += 1
                    
                    extracted = check_result.get('extracted_data', {})
                    logger.info(f"  FOUND: {sku} -> {extracted.get('name', name)}")
                    
                    # Add to database
                    product_data = {
                        "supplier": "Splendour",
                        "sku": sku,
                        "name": extracted.get('name', name),
                        "url": url,
                        "price": extracted.get('price'),
                        "stock_m2": extracted.get('stock_m2', 0),
                        "in_stock": extracted.get('in_stock', False),
                        "image": extracted.get('image'),
                        "images": extracted.get('images', []),
                        "size": extracted.get('size'),
                        "category": extracted.get('category'),
                        "extracted_sku": extracted.get('extracted_sku'),
                        "product_id": extracted.get('product_id'),
                        "synced_at": datetime.now(timezone.utc),
                        "sync_source": "missing_products_recovery",
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
                
                await asyncio.sleep(0.3)
            
            await browser.close()
    
    except Exception as e:
        logger.error(f"Error: {e}")
        results['error'] = str(e)
    
    # Save results
    output_path = '/app/missing_products_found.json'
    with open(output_path, 'w') as f:
        json.dump(results, f, indent=2, default=str)
    
    logger.info(f"Results saved to {output_path}")
    
    # Print summary
    print("\n" + "="*70)
    print("MISSING PRODUCTS RECOVERY - FINAL SUMMARY")
    print("="*70)
    print(f"Total SKUs checked: {results['total_checked']}")
    print(f"Products FOUND and added to database: {results['found_count']}")
    print(f"Products NOT found on website: {results['not_found_count']}")
    print(f"Errors: {results['error_count']}")
    print("="*70)
    
    if results['found_products']:
        print("\n" + "-"*70)
        print("PRODUCTS FOUND AND ADDED:")
        print("-"*70)
        for p in results['found_products']:
            ext = p.get('extracted_data', {})
            print(f"  {p['sku']}: {ext.get('name', p['name'])}")
            print(f"    URL: {p['url']}")
            if ext.get('price'):
                print(f"    Price: £{ext['price']}/SQM")
            if ext.get('stock_m2'):
                print(f"    Stock: {ext['stock_m2']} SQM")
            print()
    
    return results

if __name__ == "__main__":
    asyncio.run(run_missing_products_finder())

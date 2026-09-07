"""
Clearance Badge Checker (Accurate Version)
===========================================
This script checks if the 317 "extra" products have the Wholesale_Clearance badge.

The ONLY reliable indicator of a clearance item on Splendour is:
- An image with src containing "Wholesale_Clearance.png" 

The navigation menu contains a "CLEARANCE" link on every page, so we must
NOT check for "clearance" text in page content.
"""

import asyncio
import json
import os
import logging
from datetime import datetime, timezone
from pymongo import MongoClient

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Configuration
BASE_URL = "https://www.splendourtiles.co.uk"
SPLENDOUR_EMAIL = "accounts@tilestation.co.uk"
SPLENDOUR_PASSWORD = os.environ.get("SPLENDOUR_PORTAL_PASSWORD", "")

# Load extra products
def load_extra_products():
    with open('/app/extra_products_to_check.json', 'r') as f:
        return json.load(f)

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

async def check_clearance_badge(page, url: str) -> dict:
    """
    Check if a product has the Wholesale_Clearance badge.
    This is the ONLY reliable indicator of a clearance item.
    """
    result = {
        'url': url,
        'is_clearance': False,
        'has_badge': False,
        'error': None
    }
    
    try:
        await page.goto(url, timeout=30000)
        await asyncio.sleep(1.0)
        
        # Get the page HTML
        page_content = await page.content()
        
        # Check for Wholesale_Clearance badge - this is the definitive indicator
        if 'Wholesale_Clearance' in page_content:
            result['is_clearance'] = True
            result['has_badge'] = True
        
        # Also check for the badge image element specifically
        try:
            badge_img = await page.query_selector('img[src*="Wholesale_Clearance"]')
            if badge_img:
                result['is_clearance'] = True
                result['has_badge'] = True
        except Exception:
            pass
        
    except asyncio.TimeoutError:
        result['error'] = 'Page load timeout'
    except Exception as e:
        result['error'] = str(e)
    
    return result

async def run_clearance_check():
    """Main function to check all extra products for clearance badge"""
    
    # Load the products to check
    products = load_extra_products()
    logger.info(f"Loaded {len(products)} products to check for clearance badge")
    
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        logger.error("Playwright not installed")
        return {"error": "Playwright not available"}
    
    results = {
        'clearance_products': [],
        'non_clearance_products': [],
        'errors': [],
        'total_checked': 0,
        'clearance_count': 0,
        'non_clearance_count': 0,
        'error_count': 0,
        'checked_at': datetime.now(timezone.utc).isoformat()
    }
    
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            page = await browser.new_page()
            
            # Login first
            logger.info("Logging in to Splendour...")
            if not await perform_login(page):
                logger.error("Login failed")
                return {"error": "Login failed"}
            
            logger.info("Login successful. Starting clearance badge check...")
            
            total = len(products)
            for i, product in enumerate(products):
                sku = product['sku']
                url = product['url']
                name = product.get('name', 'Unknown')
                
                if (i + 1) % 25 == 0 or i == 0:
                    logger.info(f"Progress: {i+1}/{total} | Clearance: {results['clearance_count']} | Regular: {results['non_clearance_count']}")
                
                check_result = await check_clearance_badge(page, url)
                check_result['sku'] = sku
                check_result['name'] = name
                
                results['total_checked'] += 1
                
                if check_result.get('error'):
                    results['errors'].append(check_result)
                    results['error_count'] += 1
                elif check_result['is_clearance']:
                    results['clearance_products'].append(check_result)
                    results['clearance_count'] += 1
                else:
                    results['non_clearance_products'].append(check_result)
                    results['non_clearance_count'] += 1
                
                # Small delay between requests
                await asyncio.sleep(0.3)
            
            await browser.close()
    
    except Exception as e:
        logger.error(f"Error during clearance check: {e}")
        results['error'] = str(e)
    
    # Save results to file
    output_path = '/app/clearance_badge_results.json'
    with open(output_path, 'w') as f:
        json.dump(results, f, indent=2)
    
    logger.info(f"Results saved to {output_path}")
    
    # Print summary
    print("\n" + "="*70)
    print("CLEARANCE BADGE CHECK - FINAL SUMMARY")
    print("="*70)
    print(f"Total products checked: {results['total_checked']}")
    print(f"Products WITH Wholesale_Clearance badge: {results['clearance_count']}")
    print(f"Products WITHOUT Clearance badge (Regular): {results['non_clearance_count']}")
    print(f"Errors: {results['error_count']}")
    print("="*70)
    
    if results['clearance_count'] > 0:
        percentage = (results['clearance_count'] / results['total_checked']) * 100
        print(f"\n{percentage:.1f}% of extra products are on CLEARANCE")
    
    print("\n" + "-"*70)
    print("CLEARANCE PRODUCTS (have Wholesale_Clearance badge):")
    print("-"*70)
    for p in results['clearance_products'][:30]:  # Show first 30
        print(f"  - {p['sku']}: {p['name']}")
    if len(results['clearance_products']) > 30:
        print(f"  ... and {len(results['clearance_products']) - 30} more")
    
    print("\n" + "-"*70)
    print("REGULAR PRODUCTS (no clearance badge - NEW items):")
    print("-"*70)
    for p in results['non_clearance_products'][:30]:  # Show first 30
        print(f"  - {p['sku']}: {p['name']}")
    if len(results['non_clearance_products']) > 30:
        print(f"  ... and {len(results['non_clearance_products']) - 30} more")
    
    return results

if __name__ == "__main__":
    asyncio.run(run_clearance_check())

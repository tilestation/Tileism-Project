"""
Clearance Products Checker
===========================
This script checks if the 317 "extra" products (found on the website but not in the user's spreadsheet)
are clearance items by looking for clearance badges/indicators on each product page.

Clearance indicators to check:
- "Wholesale_Clearance" badge
- "clearance" in page content
- Product being in /clearance category
- Any clearance-related labels or banners
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

async def check_clearance_status(page, url: str) -> dict:
    """
    Check if a product is on clearance by looking for clearance indicators.
    Returns a dict with clearance status and evidence.
    """
    result = {
        'url': url,
        'is_clearance': False,
        'evidence': [],
        'error': None
    }
    
    try:
        await page.goto(url, timeout=30000)
        await asyncio.sleep(1.5)
        
        # Get the page HTML and text
        page_content = await page.content()
        page_text = await page.inner_text('body')
        
        # Check 1: Look for "Wholesale_Clearance" badge class
        if 'wholesale_clearance' in page_content.lower() or 'wholesale-clearance' in page_content.lower():
            result['is_clearance'] = True
            result['evidence'].append('Wholesale_Clearance badge found in HTML')
        
        # Check 2: Look for clearance text/labels
        clearance_patterns = [
            'clearance',
            'clearance item',
            'clearance sale',
            'clearance price',
            'reduced to clear',
            'end of line',
            'discontinued'
        ]
        
        for pattern in clearance_patterns:
            if pattern in page_text.lower():
                result['is_clearance'] = True
                result['evidence'].append(f'Found "{pattern}" in page text')
                break
        
        # Check 3: Check if the URL path contains clearance
        if '/clearance' in url.lower():
            result['is_clearance'] = True
            result['evidence'].append('Product URL contains /clearance')
        
        # Check 4: Look for clearance-related CSS classes
        clearance_selectors = [
            '.clearance',
            '.clearance-badge',
            '.clearance-label',
            '[data-clearance]',
            '.sale-badge',
            '.reduced'
        ]
        
        for selector in clearance_selectors:
            try:
                element = await page.query_selector(selector)
                if element:
                    is_visible = await element.is_visible()
                    if is_visible:
                        result['is_clearance'] = True
                        result['evidence'].append(f'Found clearance element: {selector}')
                        break
            except Exception:
                pass
        
        # Check 5: Look for specific badge images or icons
        badge_images = await page.query_selector_all('img[alt*="clearance" i], img[src*="clearance" i]')
        if badge_images:
            result['is_clearance'] = True
            result['evidence'].append('Found clearance badge image')
        
        # Check 6: Check breadcrumbs for clearance category
        breadcrumb_text = ""
        try:
            breadcrumb = await page.query_selector('nav.breadcrumb, .breadcrumb, [aria-label="breadcrumb"]')
            if breadcrumb:
                breadcrumb_text = await breadcrumb.inner_text()
                if 'clearance' in breadcrumb_text.lower():
                    result['is_clearance'] = True
                    result['evidence'].append('Product is in Clearance category (breadcrumb)')
        except Exception:
            pass
        
        if not result['evidence']:
            result['evidence'].append('No clearance indicators found')
            
    except asyncio.TimeoutError:
        result['error'] = 'Page load timeout'
    except Exception as e:
        result['error'] = str(e)
    
    return result

async def run_clearance_check():
    """Main function to check all extra products for clearance status"""
    
    # Load the products to check
    products = load_extra_products()
    logger.info(f"Loaded {len(products)} products to check")
    
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
            
            logger.info("Login successful. Starting clearance check...")
            
            total = len(products)
            for i, product in enumerate(products):
                sku = product['sku']
                url = product['url']
                name = product.get('name', 'Unknown')
                
                logger.info(f"[{i+1}/{total}] Checking {sku}: {name}")
                
                check_result = await check_clearance_status(page, url)
                check_result['sku'] = sku
                check_result['name'] = name
                
                results['total_checked'] += 1
                
                if check_result.get('error'):
                    results['errors'].append(check_result)
                    results['error_count'] += 1
                elif check_result['is_clearance']:
                    results['clearance_products'].append(check_result)
                    results['clearance_count'] += 1
                    logger.info(f"  -> CLEARANCE: {check_result['evidence']}")
                else:
                    results['non_clearance_products'].append(check_result)
                    results['non_clearance_count'] += 1
                
                # Progress update every 50 products
                if (i + 1) % 50 == 0:
                    logger.info(f"Progress: {i+1}/{total} | Clearance: {results['clearance_count']} | Non-clearance: {results['non_clearance_count']} | Errors: {results['error_count']}")
                
                # Small delay between requests
                await asyncio.sleep(0.5)
            
            await browser.close()
    
    except Exception as e:
        logger.error(f"Error during clearance check: {e}")
        results['error'] = str(e)
    
    # Save results to file
    output_path = '/app/clearance_check_results.json'
    with open(output_path, 'w') as f:
        json.dump(results, f, indent=2)
    
    logger.info(f"Results saved to {output_path}")
    
    # Print summary
    print("\n" + "="*60)
    print("CLEARANCE CHECK SUMMARY")
    print("="*60)
    print(f"Total products checked: {results['total_checked']}")
    print(f"Clearance products: {results['clearance_count']}")
    print(f"Non-clearance products: {results['non_clearance_count']}")
    print(f"Errors: {results['error_count']}")
    print("="*60)
    
    if results['clearance_products']:
        print("\nClearance Products Found:")
        for p in results['clearance_products'][:20]:  # Show first 20
            print(f"  - {p['sku']}: {p['name']}")
            print(f"    Evidence: {', '.join(p['evidence'])}")
        if len(results['clearance_products']) > 20:
            print(f"  ... and {len(results['clearance_products']) - 20} more")
    
    return results

if __name__ == "__main__":
    asyncio.run(run_clearance_check())

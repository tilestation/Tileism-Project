"""
Wallcano Server-Side Sync Module
================================
This module performs automated sync of Wallcano products.

IMPORTANT NOTE: Wallcano does NOT have prices on their portal.
The sync captures: name, SKU, stock, images, size, material, finish
Prices will be manually set later by the user.

Portal: https://www.wallcanotiles.com
Login: Email/Password authentication

Navigation Flow:
1. Login -> /dealers/home
2. Go to /dealers/createOrder -> Shows CATEGORIES
3. Click category -> /dealers/product_list -> Shows PRODUCTS
4. Click product -> /dealers/product_details/{id} -> Shows DETAILS

Sync Mode:
- DEEP SYNC: Full crawl of ALL categories and products
  - Visits every product detail page
  - Extracts: name, SKU (generated), stock, images, size
  - Takes ~20-40 minutes depending on catalog size
  - Prices are NOT available on Wallcano portal
"""

import asyncio
import re
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Any, List
import os
from pymongo import MongoClient
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(__file__)), '.env'))

# Import non-tile exclusion rules
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from business_config.business_rules import is_non_tile_product, NON_TILE_EXCLUSION_RULES, get_display_name, construct_complete_name

# Import R2 uploader for automatic image upload
try:
    from services.storage.r2_uploader import process_product_images_for_deep_sync, R2ImageUploader
    R2_AVAILABLE = R2ImageUploader.is_configured()
except ImportError:
    R2_AVAILABLE = False
    process_product_images_for_deep_sync = None

logger = logging.getLogger(__name__)

# Configuration
BASE_URL = "https://www.wallcanotiles.com"
WALLCANO_EMAIL = "accounts@tilestation.co.uk"
WALLCANO_PASSWORD = os.environ.get("WALLCANO_PORTAL_PASSWORD", "")

# Delay between requests (seconds)
REQUEST_DELAY = 1.0

# Database connection
def get_db():
    client = MongoClient(os.environ.get('MONGO_URL'))
    return client[os.environ.get('DB_NAME', 'tile_station')]


# Sync state - shared across calls
sync_state = {
    "is_running": False,
    "stop_requested": False,
    "job_id": None,
    "phase": "idle",
    "progress": 0,
    "message": "Ready",
    "sync_mode": None,
    "categories_total": 0,
    "categories_scanned": 0,
    "products_found": 0,
    "products_synced": 0,
    "products_failed": 0,
    "products_skipped": 0,
    "started_at": None,
    "completed_at": None,
    "errors": [],
    "current_category": None,
    "current_product": None  # {name, sku, image, price, stock, url}
}


def get_sync_state() -> Dict[str, Any]:
    """Get current sync state"""
    return sync_state.copy()


def reset_sync_state():
    """Reset sync state"""
    global sync_state
    sync_state = {
        "is_running": False,
        "stop_requested": False,
        "job_id": None,
        "phase": "idle",
        "progress": 0,
        "message": "Ready",
        "sync_mode": None,
        "categories_total": 0,
        "categories_scanned": 0,
        "products_found": 0,
        "products_synced": 0,
        "products_failed": 0,
        "products_skipped": 0,
        "started_at": None,
        "completed_at": None,
        "errors": [],
        "current_category": None,
        "current_product": None
    }


def update_state(**kwargs):
    """Update sync state"""
    global sync_state
    sync_state.update(kwargs)
    if kwargs.get("phase") == "error":
        try:
            from services.sync_alerts import record_sync_failure
            record_sync_failure(
                "Wallcano",
                kwargs.get("message") or sync_state.get("message") or "Sync failed",
                sync_state.get("sync_mode") or "server",
            )
        except Exception:
            pass


def request_stop():
    """Request graceful stop of sync"""
    global sync_state
    sync_state["stop_requested"] = True
    sync_state["message"] = "Stop requested, finishing current product..."
    return {"status": "stop_requested"}


def generate_sku(name: str, product_id: str) -> str:
    """Generate SKU from product name and ID - Wallcano format: WLC + ID"""
    if product_id:
        return f"WLC{product_id}"
    # Fallback: use name
    clean_name = re.sub(r'[^a-zA-Z0-9]', '', name).upper()[:10]
    return f"WLC{clean_name}"


def parse_size_from_name(name: str) -> Optional[str]:
    """Extract size from product name like 'Hard Rock Black & White Matt 30X45 Cm'"""
    size_match = re.search(r'(\d+)\s*[xX×]\s*(\d+)(?:\s*[xX×]\s*(\d+))?\s*(?:cm|CM|mm|MM)?', name)
    if size_match:
        if size_match.group(3):
            return f"{size_match.group(1)}x{size_match.group(2)}x{size_match.group(3)}"
        return f"{size_match.group(1)}x{size_match.group(2)}"
    return None


def parse_finish_from_name(name: str) -> Optional[str]:
    """Extract finish from product name"""
    name_lower = name.lower()
    finishes = {
        'Matt': 'matt' in name_lower and 'high' not in name_lower,
        'Gloss': 'gloss' in name_lower and 'high' not in name_lower,
        'High Gloss': 'high gloss' in name_lower,
        'Polished': 'polish' in name_lower,
        'Lappato': 'lappato' in name_lower,
        'Satin': 'satin' in name_lower,
    }
    for finish, matches in finishes.items():
        if matches:
            return finish
    return None


def save_sync_progress(db, job_id: str, all_products: list, synced_skus: list, phase: str):
    """Save sync progress to database for resume capability"""
    try:
        # Only save product names/skus/categories, not full objects (too large)
        product_refs = [{"name": p.get("name", ""), "sku": p.get("sku", ""), "category": p.get("category", ""), "url": p.get("url", "")} for p in all_products]
        db.sync_progress.update_one(
            {"supplier": "Wallcano", "job_id": job_id},
            {"$set": {
                "supplier": "Wallcano",
                "job_id": job_id,
                "phase": phase,
                "mode": "deep",
                "synced_skus": synced_skus,
                "total_products": len(all_products),
                "synced_count": len(synced_skus),
                "updated_at": datetime.now(timezone.utc),
                "status": "running" if phase != "complete" else "complete"
            }},
            upsert=True
        )
    except Exception as e:
        logger.error(f"Error saving Wallcano sync progress: {e}")


def get_resume_data(db):
    """Get resume data only if a previous Wallcano sync was interrupted RECENTLY (<24h).
    Stale records make deep syncs skip product discovery entirely — delete them."""
    try:
        progress = db.sync_progress.find_one(
            {"supplier": "Wallcano", "status": "running"},
            sort=[("updated_at", -1)]
        )
        if not progress:
            return None
        updated_at = progress.get("updated_at")
        if updated_at:
            if updated_at.tzinfo is None:
                updated_at = updated_at.replace(tzinfo=timezone.utc)
            if datetime.now(timezone.utc) - updated_at > timedelta(hours=24):
                logger.warning(f"Ignoring STALE Wallcano resume data from {updated_at} — deleting it and running a full fresh sync")
                db.sync_progress.delete_many({"supplier": "Wallcano"})
                return None
        return {
            "job_id": progress.get("job_id"),
            "synced_skus": set(progress.get("synced_skus", [])),
            "synced_count": progress.get("synced_count", 0),
            "phase": progress.get("phase")
        }
    except Exception as e:
        logger.error(f"Error getting Wallcano resume data: {e}")
        return None


def clear_sync_progress(db):
    """Clear sync progress after successful completion"""
    try:
        db.sync_progress.delete_many({"supplier": "Wallcano"})
    except Exception as e:
        logger.error(f"Error clearing Wallcano sync progress: {e}")



async def perform_login(page) -> bool:
    """Login to Wallcano dealer portal"""
    try:
        await page.goto(f'{BASE_URL}/login', timeout=60000)
        await asyncio.sleep(2)
        
        await page.fill('input[name="email"]', WALLCANO_EMAIL)
        await page.fill('input[name="password"]', WALLCANO_PASSWORD)
        await page.click('button[type="submit"]')
        await asyncio.sleep(4)
        
        # Check if login was successful
        if '/dealers/' in page.url:
            logger.info(f"Login successful, redirected to: {page.url}")
            return True
        
        logger.error(f"Login may have failed, URL: {page.url}")
        return False
        
    except Exception as e:
        logger.error(f"Login error: {e}")
        return False


async def get_categories(page) -> List[Dict]:
    """Get all product categories from Create Order page"""
    categories = []
    
    try:
        await page.goto(f'{BASE_URL}/dealers/createOrder', timeout=60000)
        await asyncio.sleep(4)  # Increased wait time
        
        # Try multiple selectors for category cards
        cards = []
        card_selectors = ['.card', '.category-card', '.category-item', '[class*="category"]', '.col-md-4 .card', '.col-lg-4 .card']
        
        for selector in card_selectors:
            cards = await page.query_selector_all(selector)
            if len(cards) > 0:
                logger.info(f"Found {len(cards)} category elements with selector: {selector}")
                break
        
        if not cards:
            # Fallback - get all clickable links that might be categories
            cards = await page.query_selector_all('a[href*="category"], a.card, div.card')
            logger.info(f"Fallback found {len(cards)} potential category elements")
        
        for card in cards:
            try:
                text = await card.inner_text()
                text = text.strip()
                
                # Get first line only (in case of multi-line)
                text = text.split('\n')[0].strip()
                
                # Skip non-category cards
                if not text or len(text) < 2:
                    continue
                if any(skip in text.lower() for skip in ['request', 'sample', 'order now', 'cart', 'login', 'logout', 'account']):
                    continue
                
                # Avoid duplicates
                if any(c['name'].lower() == text.lower() for c in categories):
                    continue
                
                categories.append({
                    'name': text,
                    'element_text': text  # Used to find element later
                })
            except Exception as e:
                logger.debug(f"Error processing category card: {e}")
                continue
        
        logger.info(f"Found {len(categories)} categories: {[c['name'] for c in categories]}")
        
    except Exception as e:
        logger.error(f"Error getting categories: {e}")
    
    return categories


async def get_products_from_category(page, category_name: str) -> List[Dict]:
    """Click on category and get all products (handles pagination)"""
    products = []
    
    try:
        # First go to create order page
        await page.goto(f'{BASE_URL}/dealers/createOrder', timeout=60000)
        await asyncio.sleep(3)
        
        # Find and click the category - try multiple selectors
        cards = await page.query_selector_all('.card, .category-card, [class*="category"]')
        category_clicked = False
        
        for card in cards:
            try:
                text = await card.inner_text()
                # Match category name (case-insensitive, partial match)
                if category_name.lower() in text.lower() or text.lower() in category_name.lower():
                    logger.info(f"Clicking on category card with text: '{text[:50]}'")
                    await card.click()
                    category_clicked = True
                    break
            except Exception as e:
                continue
        
        if not category_clicked:
            # Try clicking by text content directly
            try:
                await page.click(f'text="{category_name}"')
                category_clicked = True
                logger.info(f"Clicked category using text selector: {category_name}")
            except:
                logger.warning(f"Could not find category: {category_name}")
                return products
        
        await asyncio.sleep(4)  # Wait for products to load
        
        # Log current URL for debugging
        current_url = page.url
        logger.info(f"After clicking {category_name}, now at: {current_url}")
        
        # Handle pagination - loop through all pages
        page_num = 1
        max_pages = 50  # Safety limit
        
        while page_num <= max_pages:
            logger.info(f"Scraping {category_name} - Page {page_num}")
            
            # Get all product cards on current page - try multiple selectors
            product_cards = []
            card_selectors = ['.card', '.product-card', '.product-item', '.product', '[class*="product"]', '.col-md-3', '.col-lg-3', '.item']
            
            for selector in card_selectors:
                product_cards = await page.query_selector_all(selector)
                if len(product_cards) > 0:
                    logger.info(f"Found {len(product_cards)} elements with selector: {selector}")
                    break
            
            if not product_cards:
                logger.warning(f"No product cards found in {category_name}")
                break
            
            page_products = 0
            seen_names = set()  # Avoid duplicates on same page
            
            for card in product_cards:
                try:
                    # Get product name - try multiple selectors
                    name = None
                    name_selectors = ['h5', '.card-title-1', '.card-title', '.product-name', '.title', 'h4', 'h6', '.name']
                    
                    for name_sel in name_selectors:
                        name_el = await card.query_selector(name_sel)
                        if name_el:
                            name = await name_el.inner_text()
                            name = name.strip()
                            if name:
                                break
                    
                    if not name:
                        # Fallback to full card text
                        name = await card.inner_text()
                        name = name.strip().split('\n')[0]  # Get first line only
                    
                    if not name:
                        continue
                    
                    # Skip if this looks like a category card (not a product)
                    if len(name) < 5 or 'view' in name.lower() or name.lower() in ['sample', 'request', 'order']:
                        continue
                    
                    # Skip duplicates
                    if name.lower() in seen_names:
                        continue
                    seen_names.add(name.lower())
                    
                    # Get image
                    img = await card.query_selector('img')
                    image_url = None
                    if img:
                        image_url = await img.get_attribute('src') or await img.get_attribute('data-src')
                    
                    products.append({
                        'name': name,
                        'category': category_name,
                        'image': image_url,
                        'size': parse_size_from_name(name),
                        'finish': parse_finish_from_name(name)
                    })
                    page_products += 1
                    
                except Exception as e:
                    logger.debug(f"Error parsing product card: {e}")
                    continue
            
            logger.info(f"Found {page_products} products on page {page_num} of {category_name}")
            
            # Look for "Next" button or pagination link - try multiple selectors
            next_button = None
            pagination_selectors = [
                'a.page-link:has-text("Next")',
                'button:has-text("Next")',
                '.pagination a:has-text("»")',
                '.pagination .next a',
                'a[rel="next"]',
                'li.page-item:not(.disabled) a:has-text("Next")',
                '.pagination li:last-child a',
                'a.next',
                'button.next',
                '[data-page="next"]',
                '.page-link[aria-label="Next"]',
                'nav[aria-label="pagination"] a:has-text("›")',
                'a:has-text("›")',
                # Number-based pagination - find next page number
            ]
            
            for selector in pagination_selectors:
                try:
                    next_button = await page.query_selector(selector)
                    if next_button:
                        # Verify button is visible and clickable
                        is_visible = await next_button.is_visible()
                        if is_visible:
                            logger.info(f"Found pagination with selector: {selector}")
                            break
                        else:
                            next_button = None
                except:
                    continue
            
            if next_button:
                # Check if next button is disabled
                is_disabled = await next_button.get_attribute('disabled')
                classes = await next_button.get_attribute('class') or ''
                parent_classes = ""
                try:
                    parent = await next_button.evaluate('el => el.parentElement?.className')
                    parent_classes = parent or ""
                except:
                    pass
                
                if is_disabled or 'disabled' in classes or 'disabled' in parent_classes:
                    logger.info(f"Reached last page of {category_name}")
                    break
                
                # Click next page
                try:
                    await next_button.click()
                    await asyncio.sleep(3)  # Increased delay for page load
                    page_num += 1
                except Exception as e:
                    logger.warning(f"Error clicking next: {e}")
                    break
            else:
                # No pagination found - try scrolling to see if infinite scroll
                old_count = len(products)
                await page.evaluate('window.scrollTo(0, document.body.scrollHeight)')
                await asyncio.sleep(2)
                
                # Check if new products appeared after scroll
                new_cards = await page.query_selector_all('.card')
                if len(new_cards) > old_count + page_products:
                    logger.info(f"Infinite scroll detected, continuing...")
                    page_num += 1
                else:
                    # No pagination and no infinite scroll, single page
                    logger.info(f"No pagination found for {category_name}, single page")
                    break
        
        logger.info(f"Total: Found {len(products)} products in category '{category_name}' across {page_num} pages")
        
    except Exception as e:
        logger.error(f"Error getting products from {category_name}: {e}")
    
    return products


# Known product series names to search for (auto-populated + manual additions)
# Import from centralized business rules
try:
    from business_config.business_rules import KNOWN_SERIES_NAMES, SUPPLIER_SPECIFIC_SERIES
    # Combine global series with Wallcano-specific series
    SEARCH_SERIES_NAMES = list(set(KNOWN_SERIES_NAMES + SUPPLIER_SPECIFIC_SERIES.get("Wallcano", [])))
except ImportError:
    # Fallback if import fails
    SEARCH_SERIES_NAMES = [
        "Brook", "Spectra", "Roma", "Milano", "Venezia", "Firenze", "Torino",
        "Carrara", "Calacatta", "Statuario", "Onyx", "Travertine", "Limestone",
        "Slate", "Granite", "Marble", "Wood", "Concrete", "Cement", "Stone",
        "Metro", "Subway", "Hexagon", "Mosaic", "Brick", "Terrazzo",
        "Arabesque", "Herringbone", "Chevron", "Diamond", "Scale", "Fish Scale",
        "Orvieto", "Cremona", "Bologna", "Verona", "Napoli", "Palermo",
        "Sahara", "Desert", "Ocean", "Forest", "Mountain", "River",
        "Pearl", "Crystal", "Diamond", "Gold", "Silver", "Bronze",
        "Arctic", "Nordic", "Alpine", "Coastal", "Urban", "Industrial",
        "Classic", "Modern", "Contemporary", "Traditional", "Rustic", "Vintage"
    ]


async def search_products(page, search_term: str) -> List[Dict]:
    """Search for products using the website's search feature"""
    products = []
    
    try:
        # Navigate to search page
        search_url = f'{BASE_URL}/dealers/search?query={search_term}'
        logger.info(f"Searching for: {search_term}")
        await page.goto(search_url, timeout=60000)
        await asyncio.sleep(3)
        
        # Get all product cards from search results - try multiple selectors
        product_cards = []
        card_selectors = ['.card', '.product-card', '.product-item', '.search-result', '[class*="product"]', '.col-md-3', '.col-lg-3']
        
        for selector in card_selectors:
            product_cards = await page.query_selector_all(selector)
            if len(product_cards) > 0:
                break
        
        if not product_cards:
            logger.info(f"No products found for search: {search_term}")
            return products
        
        seen_names = set()
        
        for card in product_cards:
            try:
                # Get product name
                name = None
                name_selectors = ['h5', '.card-title-1', '.card-title', '.product-name', '.title', 'h4', 'h6']
                
                for name_sel in name_selectors:
                    name_el = await card.query_selector(name_sel)
                    if name_el:
                        name = await name_el.inner_text()
                        name = name.strip()
                        if name:
                            break
                
                if not name:
                    name = await card.inner_text()
                    name = name.strip().split('\n')[0]
                
                if not name or len(name) < 5:
                    continue
                
                # Skip duplicates
                if name.lower() in seen_names:
                    continue
                seen_names.add(name.lower())
                
                # Get image
                img = await card.query_selector('img')
                image_url = None
                if img:
                    image_url = await img.get_attribute('src') or await img.get_attribute('data-src')
                
                products.append({
                    'name': name,
                    'category': f'Search: {search_term}',  # Mark as found via search
                    'image': image_url,
                    'size': parse_size_from_name(name),
                    'finish': parse_finish_from_name(name),
                    'search_term': search_term
                })
                
            except Exception as e:
                logger.debug(f"Error parsing search result card: {e}")
                continue
        
        logger.info(f"Found {len(products)} products for search: {search_term}")
        
        # Handle pagination in search results
        page_num = 1
        max_pages = 10
        
        while page_num < max_pages:
            # Try to find and click next page
            next_button = None
            pagination_selectors = [
                'a.page-link:has-text("Next")',
                '.pagination a:has-text("»")',
                'a[rel="next"]',
                '.pagination li:last-child a'
            ]
            
            for selector in pagination_selectors:
                try:
                    next_button = await page.query_selector(selector)
                    if next_button and await next_button.is_visible():
                        break
                    next_button = None
                except:
                    continue
            
            if not next_button:
                break
            
            try:
                await next_button.click()
                await asyncio.sleep(2)
                page_num += 1
                
                # Get more products from next page
                for selector in card_selectors:
                    more_cards = await page.query_selector_all(selector)
                    if len(more_cards) > 0:
                        for card in more_cards:
                            try:
                                name = None
                                for name_sel in name_selectors:
                                    name_el = await card.query_selector(name_sel)
                                    if name_el:
                                        name = await name_el.inner_text()
                                        name = name.strip()
                                        if name:
                                            break
                                
                                if not name or name.lower() in seen_names:
                                    continue
                                seen_names.add(name.lower())
                                
                                img = await card.query_selector('img')
                                image_url = await img.get_attribute('src') if img else None
                                
                                products.append({
                                    'name': name,
                                    'category': f'Search: {search_term}',
                                    'image': image_url,
                                    'size': parse_size_from_name(name),
                                    'finish': parse_finish_from_name(name),
                                    'search_term': search_term
                                })
                            except:
                                continue
                        break
            except:
                break
        
    except Exception as e:
        logger.error(f"Error searching for {search_term}: {e}")
    
    return products


async def search_sync_all_series(page, db, existing_skus: set = None) -> Dict:
    """
    Search for all known product series names and capture products.
    This is a backup method to catch products missed by category navigation.
    """
    all_products = []
    series_found = {}
    
    if existing_skus is None:
        existing_skus = set()
    
    logger.info(f"Starting search-based sync for {len(SEARCH_SERIES_NAMES)} series names")
    
    for series_name in SEARCH_SERIES_NAMES:
        try:
            products = await asyncio.wait_for(
                search_products(page, series_name),
                timeout=30  # 30s max per search
            )
            
            # Filter out products we already have
            new_products = []
            for p in products:
                # Generate SKU from name
                sku = generate_sku_from_name(p['name'], 'Wallcano')
                if sku not in existing_skus:
                    p['sku'] = sku
                    new_products.append(p)
                    existing_skus.add(sku)
            
            if new_products:
                all_products.extend(new_products)
                series_found[series_name] = len(new_products)
                logger.info(f"Series '{series_name}': Found {len(new_products)} NEW products")
            
            # Small delay between searches
            await asyncio.sleep(1)
            
        except asyncio.TimeoutError:
            logger.warning(f"Search timeout for series '{series_name}', skipping")
            continue
        except Exception as e:
            logger.error(f"Error searching series '{series_name}': {e}")
            continue
    
    logger.info(f"Search sync complete: Found {len(all_products)} total new products across {len(series_found)} series")
    
    return {
        'products': all_products,
        'series_found': series_found,
        'total_new': len(all_products)
    }


def generate_sku_from_name(name: str, supplier: str = 'Wallcano') -> str:
    """Generate a unique SKU from product name"""
    import hashlib
    # Create a hash of the name for uniqueness
    name_hash = hashlib.md5(name.lower().encode()).hexdigest()[:6].upper()
    # Get supplier prefix
    prefix = supplier[:3].upper()
    return f"{prefix}-{name_hash}"


async def get_product_details(page, product_name: str, category_name: str) -> Optional[Dict]:
    """Click on product to get full details from product detail page"""
    try:
        # Navigate to category first
        await page.goto(f'{BASE_URL}/dealers/createOrder', timeout=60000)
        await asyncio.sleep(2)
        
        # Click category
        cards = await page.query_selector_all('.card')
        for card in cards:
            text = await card.inner_text()
            if category_name.lower() in text.lower():
                await card.click()
                break
        await asyncio.sleep(2)
        
        # Find and click product
        product_cards = await page.query_selector_all('.card')
        product_clicked = False
        
        for card in product_cards:
            card_text = await card.inner_text()
            # Match product name (might have slight variations)
            if product_name.lower()[:20] in card_text.lower():
                await card.click()
                product_clicked = True
                break
        
        if not product_clicked:
            logger.warning(f"Could not find product: {product_name}")
            return None
        
        await asyncio.sleep(2)
        
        # Now on product details page - extract info
        url = page.url
        product_id = url.split('/')[-1] if '/product_details/' in url else None
        
        body_text = await page.inner_text('body')
        
        # Extract stock (Available Quantity)
        stock_m2 = 0
        # Try multiple patterns for different Wallcano page layouts
        stock_patterns = [
            r'Available\s*Quantity[:\s]*(\d+\.?\d*)\s*m2',
            r'Available[:\s]*(\d+\.?\d*)\s*m2',
            r'Quantity[:\s]*(\d+\.?\d*)\s*(?:m2|sqm|m²)',
            r'Stock[:\s]*(\d+\.?\d*)\s*(?:m2|sqm|m²)',
            r'(\d+\.?\d*)\s*m2\s*(?:available|in stock)',
            r'Available\s*Quantity[:\s]*(\d+\.?\d*)',
        ]
        for pattern in stock_patterns:
            stock_match = re.search(pattern, body_text, re.I)
            if stock_match:
                stock_m2 = float(stock_match.group(1))
                break
        
        # Extract tiles per box
        tiles_per_box = None
        tiles_match = re.search(r'Tiles\s*Per\s*Box[:\s]*(\d+)', body_text, re.I)
        if tiles_match:
            tiles_per_box = int(tiles_match.group(1))
        
        # Extract sqm per box
        sqm_per_box = None
        sqm_match = re.search(r'Sqm\s*Per\s*Box[:\s]*(\d+\.?\d*)', body_text, re.I)
        if sqm_match:
            sqm_per_box = float(sqm_match.group(1))
        
        # Get images
        images = []
        img_elements = await page.query_selector_all('img[src*="products"]')
        for img in img_elements:
            src = await img.get_attribute('src')
            if src and src not in images:
                images.append(src)
        
        product_data = {
            'product_id': product_id,
            'url': url,
            'stock_m2': stock_m2,
            'stock_quantity': stock_m2,  # Mirror stock_m2 to stock_quantity for has_stock check
            'in_stock': stock_m2 > 0,
            'tiles_per_box': tiles_per_box,
            'sqm_per_box': sqm_per_box,
            'images': images[:5] if images else []
        }
        
        return product_data
        
    except Exception as e:
        logger.error(f"Error getting product details for {product_name}: {e}")
        return None


async def run_deep_sync(db):
    """
    DEEP SYNC: Crawl all categories and extract complete product info.
    NOTE: Prices are NOT available on Wallcano - only product details.
    Supports resume: skips already-synced SKUs from previous interrupted runs.
    """
    global sync_state
    
    if sync_state["is_running"]:
        return {"error": "Sync already in progress"}
    
    # Check for resume data
    resume_data = get_resume_data(db)
    synced_skus = set()
    skip_discovery = False
    if resume_data and resume_data.get("synced_count", 0) > 0:
        synced_skus = resume_data.get("synced_skus", set())
        skip_discovery = len(synced_skus) > 0  # Skip re-discovery if we have progress
        logger.info(f"Resuming Wallcano sync: {len(synced_skus)} products already synced, skip_discovery={skip_discovery}")
    
    # Initialize state
    reset_sync_state()
    job_id = f"wallcano-deep-{datetime.now().strftime('%Y%m%d%H%M%S')}"
    
    update_state(
        is_running=True,
        job_id=job_id,
        phase="starting",
        sync_mode="deep",
        message="Starting Wallcano DEEP sync (no prices - manual pricing required)...",
        started_at=datetime.now(timezone.utc).isoformat()
    )
    
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        update_state(
            is_running=False,
            phase="error",
            message="Playwright not installed on server"
        )
        return {"error": "Playwright not available"}
    
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            page = await browser.new_page()
            
            # ===== STEP 1: LOGIN =====
            update_state(phase="login", message="Logging into Wallcano...")
            
            if not await perform_login(page):
                update_state(is_running=False, phase="error", message="Login failed - check credentials")
                await browser.close()
                return {"error": "Login failed"}
            
            update_state(message="Logged in successfully")
            
            # ===== STEP 2: GET CATEGORIES =====
            update_state(phase="finding_categories", message="Finding all categories...")
            
            categories = await get_categories(page)
            
            if not categories:
                update_state(phase="error", message="No categories found")
                await browser.close()
                return {"error": "No categories found"}
            
            update_state(
                categories_total=len(categories),
                message=f"Found {len(categories)} categories"
            )
            
            # ===== STEP 3: PROCESS EACH CATEGORY =====
            all_products = []
            
            if skip_discovery:
                # Resume mode: skip category scanning and search, go straight to syncing
                # We'll rediscover products from sync_staging
                existing_staged = list(db.sync_staging.find(
                    {"supplier": "Wallcano"},
                    {"_id": 0, "name": 1, "sku": 1, "category": 1, "url": 1}
                ))
                for staged in existing_staged:
                    all_products.append({
                        "name": staged.get("name", ""),
                        "sku": staged.get("sku", ""),
                        "category": staged.get("category", ""),
                        "url": staged.get("url", "")
                    })
                update_state(
                    categories_scanned=0,
                    products_found=len(all_products),
                    message=f"Resuming with {len(all_products)} known products, {len(synced_skus)} already synced"
                )
                logger.info(f"Resume mode: loaded {len(all_products)} products from staging, skipping discovery")
            else:
                for cat_idx, category in enumerate(categories):
                    if sync_state["stop_requested"]:
                        break
                    
                    cat_name = category['name']
                    update_state(
                        phase="scanning_category",
                        current_category=cat_name,
                        categories_scanned=cat_idx,
                        message=f"Scanning category: {cat_name} ({cat_idx + 1}/{len(categories)})"
                    )
                    
                    # Get products from this category
                    products = await get_products_from_category(page, cat_name)
                    
                    for product in products:
                        product['category'] = cat_name
                        all_products.append(product)
                    
                    update_state(products_found=len(all_products))
                    await asyncio.sleep(REQUEST_DELAY)
                
                update_state(
                    categories_scanned=len(categories),
                    products_found=len(all_products),
                    message=f"Found {len(all_products)} products across {len(categories)} categories"
                )
                
                # ===== STEP 3B: SEARCH-BASED SYNC (BACKUP) =====
                # Search for known product series to catch any missed by category navigation
                update_state(phase="search_sync", message="Running search-based sync for known series...")
                
                # Get existing SKUs to avoid duplicates
                existing_skus = {p.get('sku', '') for p in all_products if p.get('sku')}
                for p in all_products:
                    temp_sku = generate_sku_from_name(p['name'], 'Wallcano')
                    existing_skus.add(temp_sku)
                
                # Run search sync with timeout protection
                try:
                    search_results = await asyncio.wait_for(
                        search_sync_all_series(page, db, existing_skus),
                        timeout=300  # 5 min max for search phase
                    )
                    
                    if search_results['total_new'] > 0:
                        logger.info(f"Search sync found {search_results['total_new']} additional products!")
                        all_products.extend(search_results['products'])
                        update_state(
                            products_found=len(all_products),
                            message=f"Search sync added {search_results['total_new']} more products. Total: {len(all_products)}"
                        )
                    else:
                        logger.info("Search sync found no additional products (all already captured)")
                except asyncio.TimeoutError:
                    logger.warning("Search sync timed out after 5 minutes, continuing with category products only")
                except Exception as search_err:
                    logger.error(f"Search sync failed: {search_err}, continuing with category products only")
            
            # ===== STEP 4: GET DETAILS AND SYNC EACH PRODUCT =====
            update_state(
                phase="syncing", 
                message=f"Syncing products...{f' (resuming, {len(synced_skus)} already done)' if synced_skus else ''}"
            )
            
            total_products = len(all_products)
            
            for idx, product in enumerate(all_products):
                if sync_state["stop_requested"]:
                    save_sync_progress(db, job_id, all_products, list(synced_skus), "stopped")
                    update_state(
                        phase="stopped",
                        message=f"Sync stopped by user. {sync_state['products_synced']}/{total_products} products synced. Will resume on next run.",
                        can_resume=True
                    )
                    break
                
                progress = int((idx / total_products) * 100) if total_products > 0 else 0
                
                # Construct complete name with size and finish
                complete_name = construct_complete_name(
                    product.get('name'),
                    product.get('size'),
                    product.get('finish')
                )
                product['name'] = complete_name  # Update product name to complete version
                
                # Get the display name (transformed) and SAVE it to product
                display_name = get_display_name(complete_name, 'Wallcano', product.get('finish'))
                product['product_name'] = display_name  # Store the transformed name
                
                update_state(
                    progress=progress,
                    message=f"Syncing product {idx + 1}/{total_products}: {complete_name[:30]}...",
                    current_product={
                        "name": complete_name,
                        "display_name": display_name,
                        "sku": product.get('sku', ''),
                        "image": product.get('images', [None])[0] if product.get('images') else None,
                        "price": None,  # Wallcano doesn't have prices
                        "cost_price": None,
                        "stock_m2": product.get('stock_m2'),
                        "url": product.get('url', '')
                    }
                )
                
                try:
                    # Check if this is a non-tile product (adhesive, grout, etc.) - SKIP if so
                    should_skip, skip_reason = is_non_tile_product(
                        product.get('name', ''),
                        product.get('category', ''),
                        product.get('url', '')
                    )
                    if should_skip:
                        update_state(products_skipped=sync_state.get("products_skipped", 0) + 1)
                        logger.info(f"SKIPPED non-tile product: {product.get('name')} - {skip_reason}")
                        continue
                    
                    # Get detailed info for this product (with retry)
                    details = None
                    for retry in range(3):
                        try:
                            details = await get_product_details(page, product['name'], product['category'])
                            break
                        except Exception as detail_err:
                            if retry < 2:
                                logger.warning(f"Retry {retry + 1}/3 for product details {product['name']}: {detail_err}")
                                await asyncio.sleep(2)
                            else:
                                logger.error(f"Failed to get details for {product['name']} after 3 retries: {detail_err}")
                    
                    if details:
                        product.update(details)
                    
                    # Generate SKU
                    product_id = product.get('product_id', '')
                    product['sku'] = generate_sku(product['name'], product_id)
                    
                    # Skip if already synced (resume support)
                    if product['sku'] in synced_skus:
                        update_state(products_synced=sync_state["products_synced"] + 1)
                        continue
                    
                    # Get existing product for image change detection
                    existing_product = db.sync_staging.find_one({
                        "supplier": "Wallcano", 
                        "sku": product['sku']
                    })
                    
                    # Store original source URLs for future change detection
                    source_images = product.get('images', [])
                    product['image_source_urls'] = source_images.copy() if source_images else []
                    
                    # Upload images to R2 cloud storage (handles updates automatically)
                    if R2_AVAILABLE and process_product_images_for_deep_sync and source_images:
                        try:
                            product_display_name = product.get('name', product['sku'])
                            processed_images, uploaded_count, source_urls = await process_product_images_for_deep_sync(
                                source_images,
                                'Wallcano',
                                product_display_name,
                                existing_product  # Pass existing to detect image changes
                            )
                            product['images'] = processed_images
                            product['image_source_urls'] = source_urls  # Store for future change detection
                            if uploaded_count > 0:
                                product['images_uploaded_to_r2'] = True
                                logger.info(f"Uploaded/updated {uploaded_count} images to R2 for {product_display_name}")
                        except Exception as img_err:
                            logger.warning(f"Failed to upload images to R2: {img_err}")
                    
                    # Prepare for database
                    product['supplier'] = 'Wallcano'
                    product['synced_at'] = datetime.now(timezone.utc)
                    product['sync_source'] = 'server_side_deep_sync'
                    product['price'] = None  # No prices on Wallcano
                    product['cost_price'] = None
                    product['price_note'] = "Price not available on Wallcano portal - set manually"
                    
                    # Ensure stock fields always exist (even if extraction failed)
                    if 'stock_m2' not in product:
                        product['stock_m2'] = 0
                    if 'stock_quantity' not in product:
                        product['stock_quantity'] = product.get('stock_m2', 0)
                    if 'in_stock' not in product:
                        product['in_stock'] = (product.get('stock_m2') or 0) > 0
                    
                    # Upsert to sync_staging
                    db.sync_staging.update_one(
                        {"supplier": "Wallcano", "sku": product['sku']},
                        {"$set": product},
                        upsert=True
                    )
                    
                    update_state(products_synced=sync_state["products_synced"] + 1)
                    synced_skus.add(product['sku'])
                    logger.info(f"Synced: {product['name']} [{product['sku']}] - Stock: {product.get('stock_m2', 0)} m2")
                    
                    # Save progress every 10 products
                    if sync_state["products_synced"] % 10 == 0:
                        save_sync_progress(db, job_id, all_products, list(synced_skus), "syncing")
                    
                except Exception as e:
                    logger.error(f"Error syncing product {product.get('name', 'unknown')}: {e}")
                    update_state(products_failed=sync_state["products_failed"] + 1)
                    sync_state["errors"].append(f"{product.get('name', 'unknown')}: {str(e)[:50]}")
                    # If browser crashed, try to recover
                    try:
                        await page.evaluate("1")  # Simple check if page is still alive
                    except Exception:
                        logger.warning("Browser page crashed, attempting recovery...")
                        try:
                            page = await browser.new_page()
                            if not await perform_login(page):
                                logger.error("Failed to re-login after browser crash")
                                break
                            logger.info("Browser recovered successfully")
                        except Exception as recovery_err:
                            logger.error(f"Browser recovery failed: {recovery_err}")
                            break
                
                await asyncio.sleep(REQUEST_DELAY)
            
            await browser.close()
            
            # Mark as complete
            if sync_state["phase"] != "stopped":
                clear_sync_progress(db)
                update_state(
                    is_running=False,
                    phase="complete",
                    progress=100,
                    message=f"Sync complete! {sync_state['products_synced']} products synced. NOTE: Prices need to be set manually.",
                    completed_at=datetime.now(timezone.utc).isoformat()
                )
            else:
                save_sync_progress(db, job_id, all_products, list(synced_skus), "stopped")
                update_state(is_running=False)
            
            return get_sync_state()
            
    except Exception as e:
        logger.error(f"Sync error: {e}")
        # Save progress so we can resume
        try:
            save_sync_progress(db, job_id, [], list(synced_skus), "error")
        except Exception:
            pass
        update_state(
            is_running=False,
            phase="error",
            message=f"Sync error: {str(e)[:200]}. {len(synced_skus)} products saved. Will resume on next run.",
            can_resume=True
        )
        return {"error": str(e)}


_STOCK_PATTERNS = [
    r'Available\s*Quantity[:\s]*(\d+\.?\d*)\s*m2',
    r'Available[:\s]*(\d+\.?\d*)\s*m2',
    r'Quantity[:\s]*(\d+\.?\d*)\s*(?:m2|sqm|m²)',
    r'Stock[:\s]*(\d+\.?\d*)\s*(?:m2|sqm|m²)',
    r'(\d+\.?\d*)\s*m2\s*(?:available|in stock)',
    r'Available\s*Quantity[:\s]*(\d+\.?\d*)',
]


async def run_light_sync(db):
    """
    LIGHT SYNC: Stock-only refresh for existing Wallcano products.
    Visits known product_details URLs from sync_staging — no category crawl,
    no images, no details. NOTE: Wallcano has no prices on their portal.
    """
    global sync_state
    
    if sync_state["is_running"]:
        return {"error": "Sync already in progress"}
    
    existing = list(db.sync_staging.find(
        {"supplier": "Wallcano", "url": {"$regex": "product_details"}},
        {"url": 1, "sku": 1, "_id": 0}
    ))
    if not existing:
        return {"error": "No existing Wallcano products with URLs found. Run a DEEP sync first."}
    
    reset_sync_state()
    job_id = f"wallcano-light-{datetime.now().strftime('%Y%m%d%H%M%S')}"
    update_state(
        is_running=True,
        job_id=job_id,
        phase="starting",
        sync_mode="light",
        message=f"Starting LIGHT sync (stock only) for {len(existing)} products...",
        products_found=len(existing),
        started_at=datetime.now(timezone.utc).isoformat()
    )
    
    synced = failed = 0
    try:
        from playwright.async_api import async_playwright
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            page = await browser.new_page()
            
            update_state(phase="login", message="Logging into Wallcano...")
            if not await perform_login(page):
                await browser.close()
                update_state(is_running=False, phase="error", message="Login failed")
                return {"error": "Login failed"}
            
            update_state(phase="syncing")
            total = len(existing)
            for i, item in enumerate(existing):
                if sync_state.get("stop_requested"):
                    update_state(message="Stop requested — finishing up...")
                    break
                update_state(
                    progress=int((i / total) * 100),
                    message=f"[LIGHT] Updating stock {i+1}/{total}: {item.get('sku')}...",
                    products_synced=synced,
                    products_failed=failed
                )
                try:
                    await page.goto(item["url"], timeout=30000)
                    await asyncio.sleep(REQUEST_DELAY)
                    body_text = await page.inner_text('body')
                    stock_m2 = 0
                    for pattern in _STOCK_PATTERNS:
                        m = re.search(pattern, body_text, re.I)
                        if m:
                            stock_m2 = float(m.group(1))
                            break
                    db.sync_staging.update_one(
                        {"supplier": "Wallcano", "sku": item["sku"]},
                        {"$set": {
                            "stock_m2": stock_m2,
                            "stock_quantity": stock_m2,
                            "in_stock": stock_m2 > 0,
                            "synced_at": datetime.now(timezone.utc),
                            "sync_source": "light_stock_sync"
                        }}
                    )
                    synced += 1
                except Exception as e:
                    failed += 1
                    logger.error(f"[WALLCANO LIGHT] Error on {item.get('url')}: {e}")
            
            await browser.close()
        
        update_state(
            is_running=False,
            phase="complete",
            progress=100,
            message=f"LIGHT sync complete! {synced} updated, {failed} failed",
            products_synced=synced,
            products_failed=failed,
            completed_at=datetime.now(timezone.utc).isoformat()
        )
        return {"success": True, "synced": synced, "failed": failed}
    except Exception as e:
        logger.error(f"[WALLCANO LIGHT] Sync error: {e}")
        update_state(is_running=False, phase="error", message=f"LIGHT sync error: {str(e)[:200]}")
        return {"error": str(e)}


def start_sync_background(mode: str = "deep"):
    """Start sync in background thread"""
    import threading
    
    def run_async_sync():
        try:
            db = get_db()
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            if mode in ("light", "quick"):
                loop.run_until_complete(run_light_sync(db))
            else:
                loop.run_until_complete(run_deep_sync(db))
            loop.close()
        except Exception as e:
            logger.error(f"Background sync error: {e}")
            update_state(
                is_running=False,
                phase="error",
                message=f"Background sync error: {str(e)[:200]}"
            )
    
    thread = threading.Thread(target=run_async_sync, daemon=True)
    thread.start()
    
    return {
        "status": "started",
        "mode": mode,
        "job_id": sync_state.get("job_id"),
        "message": "Wallcano sync started. NOTE: Prices are NOT available on Wallcano portal - set manually after sync."
    }

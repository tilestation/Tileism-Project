"""
Splendour Server-Side Sync Module
=================================
This module performs automated sync of Splendour products with two modes:

1. DEEP FULL SYNC (one-time):
   - Crawls ALL categories and subcategories
   - Visits every product page
   - Extracts complete info: name, SKU, price, stock, images, dimensions
   - Takes ~40-60 minutes but captures everything
   - Run once to populate the database

2. LIGHT SYNC (regular) - See LIGHT_SYNC_RULES in business_rules.py:
   - Only syncs products already in database
   - Skips category crawling (uses known product URLs)
   - ONLY UPDATES: stock_m2, price, in_stock, synced_at, sync_source
   - PRESERVES: images, name, size, material, finish, and ALL other fields
   - Much faster (~10-15 minutes) and lower server load
   - Run daily/weekly for inventory updates

IMPORTANT: Light sync uses MongoDB $set on specific fields only.
           This ensures existing data (images, descriptions, etc.) is NEVER overwritten.
           See: business_config/business_rules.py -> LIGHT_SYNC_RULES

This is triggered via API endpoint and runs on the server.
"""

import asyncio
import re
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Any, List
import os
from pymongo import MongoClient

# Import non-tile exclusion rules
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from business_config.business_rules import is_non_tile_product, NON_TILE_EXCLUSION_RULES, get_display_name, construct_complete_name

logger = logging.getLogger(__name__)

# Configuration
BASE_URL = "https://www.splendourtiles.co.uk"
SPLENDOUR_EMAIL = "accounts@tilestation.co.uk"
SPLENDOUR_PASSWORD = os.environ.get("SPLENDOUR_PORTAL_PASSWORD", "")

# Max pagination clicks to prevent infinite loops
MAX_PAGINATION_CLICKS = 100

# Delay between requests to reduce server load (seconds)
REQUEST_DELAY = 1.0
REQUEST_DELAY_QUICK = 0.5  # Faster for quick sync


def extract_category_from_url(url: str) -> str:
    """
    Extract category name from Splendour product URL.
    URL format: https://www.splendourwholesale.com/tiles/category-name/product-name
    Returns: Category name (e.g., "Category Name") or empty string if not found
    """
    try:
        if not url:
            return ""
        # Remove base URL and split by /
        path = url.replace(BASE_URL, "").strip("/")
        parts = path.split("/")
        # Expected: tiles/category-name/product-name
        if len(parts) >= 2 and parts[0].lower() == "tiles":
            category_slug = parts[1]  # Get category part
            # Convert slug to readable name (replace - with space, title case)
            category_name = category_slug.replace("-", " ").title()
            return category_name
        return ""
    except Exception:
        return ""

# Database connection for progress tracking
def get_db():
    client = MongoClient(os.environ.get('MONGO_URL'))
    return client[os.environ.get('DB_NAME', 'tile_station')]

# Sync state - shared across calls
sync_state = {
    "is_running": False,
    "job_id": None,
    "phase": "idle",
    "progress": 0,
    "message": "Ready",
    "sync_mode": None,  # "deep" or "quick"
    "categories_scanned": 0,
    "subcategories_found": 0,
    "products_found": 0,
    "products_synced": 0,
    "products_failed": 0,
    "products_skipped": 0,
    "started_at": None,
    "completed_at": None,
    "errors": [],
    "can_resume": False,
    "resume_from_product": 0,
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
        "job_id": None,
        "phase": "idle",
        "progress": 0,
        "message": "Ready",
        "sync_mode": None,
        "categories_scanned": 0,
        "subcategories_found": 0,
        "products_found": 0,
        "products_synced": 0,
        "products_failed": 0,
        "products_skipped": 0,
        "started_at": None,
        "completed_at": None,
        "errors": [],
        "can_resume": False,
        "resume_from_product": 0,
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
                "Splendour",
                kwargs.get("message") or sync_state.get("message") or "Sync failed",
                sync_state.get("sync_mode") or "server",
            )
        except Exception:
            pass


def save_sync_progress(db, job_id: str, product_urls: List[str], synced_urls: List[str], phase: str, mode: str):
    """Save sync progress to database for resume capability"""
    try:
        db.sync_progress.update_one(
            {"supplier": "Splendour", "job_id": job_id},
            {"$set": {
                "supplier": "Splendour",
                "job_id": job_id,
                "phase": phase,
                "mode": mode,
                "all_product_urls": product_urls,
                "synced_urls": synced_urls,
                "total_products": len(product_urls),
                "synced_count": len(synced_urls),
                "updated_at": datetime.now(timezone.utc),
                "status": "running" if phase != "complete" else "complete"
            }},
            upsert=True
        )
    except Exception as e:
        logger.error(f"Error saving sync progress: {e}")


def get_resume_data(db) -> Optional[Dict]:
    """Get resume data only if a previous sync was interrupted RECENTLY (<24h).
    Stale records would reuse an outdated product list and silently skip
    discovering new portal products — they are deleted instead."""
    try:
        progress = db.sync_progress.find_one(
            {"supplier": "Splendour", "status": "running"},
            sort=[("updated_at", -1)]
        )
        if not progress:
            return None
        updated_at = progress.get("updated_at")
        if updated_at:
            if updated_at.tzinfo is None:
                updated_at = updated_at.replace(tzinfo=timezone.utc)
            if datetime.now(timezone.utc) - updated_at > timedelta(hours=24):
                logger.warning(f"Ignoring STALE Splendour resume data from {updated_at} — deleting it and running a full fresh sync")
                db.sync_progress.delete_many({"supplier": "Splendour"})
                return None
        return {
            "job_id": progress.get("job_id"),
            "mode": progress.get("mode", "deep"),
            "all_product_urls": progress.get("all_product_urls", []),
            "synced_urls": set(progress.get("synced_urls", [])),
            "phase": progress.get("phase"),
            "synced_count": progress.get("synced_count", 0)
        }
    except Exception as e:
        logger.error(f"Error getting resume data: {e}")
        return None


def clear_sync_progress(db):
    """Clear sync progress after successful completion"""
    try:
        db.sync_progress.delete_many({"supplier": "Splendour"})
    except Exception as e:
        logger.error(f"Error clearing sync progress: {e}")


async def extract_product_full(page) -> Optional[Dict]:
    """
    DEEP SYNC: Extract ALL product data from a product detail page.
    Includes: name, SKU, price, stock, images, dimensions, etc.
    """
    try:
        product = {"url": page.url}
        
        # Get name
        h1 = await page.query_selector('h1')
        if h1:
            product['name'] = (await h1.inner_text()).strip()
        
        if not product.get('name') or 'sorry' in product.get('name', '').lower():
            return None
        
        # Get page text for regex extraction
        page_text = await page.inner_text('body')
        normalized = re.sub(r'\s+', ' ', page_text.replace('\n', ' '))
        
        # SKU - try multiple patterns (include dots, hyphens in character class)
        sku_match = re.search(r'SKU[:\s]+([A-Z0-9.\-]+)', normalized, re.I)
        if sku_match:
            product['sku'] = sku_match.group(1)
        else:
            # Try Product ID
            pid_match = re.search(r'Product ID[:\s]+([A-Z0-9.\-]+)', normalized, re.I)
            if pid_match:
                product['sku'] = pid_match.group(1)
            else:
                # Generate SKU from URL as fallback
                url_slug = page.url.split('/')[-1].split('?')[0]
                product['sku'] = url_slug.upper().replace('-', '')[:20]
                product['sku_generated'] = True
        
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
        
        # Size/Dimensions (e.g., "600x600x10mm")
        size_match = re.search(r'Size[:\s]+(\d+x\d+(?:x\d+)?mm)', normalized, re.I)
        if size_match:
            product['size'] = size_match.group(1)
        else:
            # Try to extract from product name
            name_size = re.search(r'(\d+x\d+)', product.get('name', ''))
            if name_size:
                product['size'] = name_size.group(1)
        
        # Material Type
        material_match = re.search(r'Material Type[:\s]+(Porcelain|Ceramic|Stone|Marble)', normalized, re.I)
        if material_match:
            product['material'] = material_match.group(1)
        
        # Finish
        finish_match = re.search(r'Finish[:\s]+(Matt|Gloss|Polished|Satin|Lappato)', normalized, re.I)
        if finish_match:
            product['finish'] = finish_match.group(1)
        
        # Images - extract from both <a href="..."> links and <img src="..."> tags
        # The website uses multiple CDN patterns:
        # - https://m2wholesale... (old pattern)
        # - https://m2.wallsandfloors.co.uk/... (current pattern)
        # - https://www.splendourtiles.co.uk/_ipx/... (proxy URL wrapping actual images)
        images = []
        
        # First, try to get high-res images from <a> tags with m2wholesale or m2.wallsandfloors
        a_elements = await page.query_selector_all('a[href*="m2wholesale"], a[href*="m2.wallsandfloors"]')
        for a in a_elements:
            href = await a.get_attribute('href')
            if href and ('m2wholesale' in href or 'm2.wallsandfloors' in href):
                # Look for high-res sizes
                if '2300X2300' in href or '650X650' in href or '1000X1000' in href:
                    # Skip video thumbnails and small images
                    if 'video_thumbnail' not in href and '100X100' not in href and '56x56' not in href:
                        clean_url = href.split('?')[0]
                        if clean_url not in images:
                            images.append(clean_url)
        
        # Second attempt: Look for product images in img tags
        if not images:
            img_elements = await page.query_selector_all('img[src*="m2wholesale"], img[src*="m2.wallsandfloors"], img[src*="_ipx"]')
            for img in img_elements:
                src = await img.get_attribute('src')
                if not src:
                    continue
                    
                # Skip thumbnails and small images
                if any(skip in src for skip in ['56x56', '48x48', '100X100', 'video_thumbnail', 'placeholder']):
                    continue
                
                # Handle _ipx proxy URLs - extract the actual image URL
                if '_ipx' in src:
                    # Extract URL from _ipx proxy format: /_ipx/raw_v=xxx&w_xxx/https://m2...
                    match = re.search(r'(https://m2[^\s&\?]+\.(?:webp|jpg|png))', src)
                    if match:
                        clean_url = match.group(1)
                        if clean_url not in images:
                            images.append(clean_url)
                elif 'm2wholesale' in src or 'm2.wallsandfloors' in src:
                    # Direct URL pattern
                    match = re.search(r'(https://m2[^\s&\?]+\.(?:webp|jpg|png))', src)
                    if match:
                        clean_url = match.group(1)
                        if clean_url not in images:
                            images.append(clean_url)
        
        # Third attempt: Look for any large images with data-src (lazy loaded)
        if not images:
            img_elements = await page.query_selector_all('img[data-src*="m2wholesale"], img[data-src*="m2.wallsandfloors"]')
            for img in img_elements:
                data_src = await img.get_attribute('data-src')
                if data_src:
                    if any(skip in data_src for skip in ['56x56', '48x48', '100X100', 'video_thumbnail']):
                        continue
                    match = re.search(r'(https://m2[^\s&\?]+\.(?:webp|jpg|png))', data_src)
                    if match:
                        clean_url = match.group(1)
                        if clean_url not in images:
                            images.append(clean_url)
        
        # Fourth attempt: Look for swiper/gallery images
        if not images:
            gallery_selectors = [
                '.swiper-slide img',
                '.product-gallery img',
                '.product-images img', 
                '[class*="gallery"] img',
                '[class*="slider"] img'
            ]
            for selector in gallery_selectors:
                try:
                    gallery_imgs = await page.query_selector_all(selector)
                    for img in gallery_imgs:
                        src = await img.get_attribute('src') or await img.get_attribute('data-src')
                        if src and 'm2' in src:
                            if any(skip in src for skip in ['56x56', '48x48', '100X100', 'video_thumbnail']):
                                continue
                            match = re.search(r'(https://m2[^\s&\?]+\.(?:webp|jpg|png))', src)
                            if match:
                                clean_url = match.group(1)
                                if clean_url not in images:
                                    images.append(clean_url)
                except Exception:
                    pass
        
        if images:
            product['images'] = images[:5]
            logger.info(f"Extracted {len(images)} images for {product.get('name', 'Unknown')}")
        else:
            logger.warning(f"No images found for {product.get('name', 'Unknown')} at {page.url}")
        
        return product
        
    except Exception as e:
        logger.error(f"Error extracting product (full): {e}")
        return None


async def extract_product_quick(page) -> Optional[Dict]:
    """
    QUICK SYNC: Extract only stock and price from a product page.
    Much faster as it skips image extraction and other details.
    """
    try:
        product = {"url": page.url}
        
        # Get page text for regex extraction
        page_text = await page.inner_text('body')
        normalized = re.sub(r'\s+', ' ', page_text.replace('\n', ' '))
        
        # SKU (needed to match with existing product)
        sku_match = re.search(r'SKU[:\s]+([A-Z0-9.\-]+)', normalized, re.I)
        if sku_match:
            product['sku'] = sku_match.group(1)
        else:
            return None  # Can't match without SKU
        
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
        
        return product
        
    except Exception as e:
        logger.error(f"Error extracting product (quick): {e}")
        return None


async def click_load_more_until_done(page, button_selector: str, description: str, max_clicks: int = MAX_PAGINATION_CLICKS):
    """
    Repeatedly click a 'Load More' or 'Load Next' button until it's no longer visible.
    """
    clicks = 0
    while clicks < max_clicks:
        try:
            button = await page.query_selector(button_selector)
            if not button:
                break
            
            is_visible = await button.is_visible()
            if not is_visible:
                break
            
            await button.click()
            clicks += 1
            logger.info(f"{description}: Clicked pagination button ({clicks} times)")
            await asyncio.sleep(1.5)
            
        except Exception as e:
            logger.info(f"{description}: Pagination ended ({clicks} clicks): {e}")
            break
    
    return clicks


async def get_all_subcategories_from_category(page, category_url: str, category_name: str) -> List[str]:
    """
    Navigate to a main category page and extract ALL subcategory URLs,
    handling 'LOAD NEXT' pagination to get all subcategories.
    
    Also extracts products directly from the category page if it's a product listing.
    """
    subcategories = []
    
    try:
        await page.goto(category_url, timeout=60000)
        await asyncio.sleep(2)
        
        # Click "LOAD NEXT" repeatedly to load all subcategories
        load_next_selector = 'button:has-text("LOAD NEXT"), button:has-text("Load Next"), a:has-text("LOAD NEXT")'
        clicks = await click_load_more_until_done(page, load_next_selector, f"Subcategories for {category_name}")
        logger.info(f"Loaded all subcategories for {category_name} with {clicks} pagination clicks")
        
        # Extract subcategory cards/links
        # Look for category cards with images and titles (these are subcategory links)
        category_cards = await page.query_selector_all('[data-testid="category-card"], .category-card, .category-item, [class*="category-list"] a')
        
        for card in category_cards:
            # If it's a link directly, get href
            href = await card.get_attribute('href')
            if not href:
                # Try to find link inside the card
                link = await card.query_selector('a')
                if link:
                    href = await link.get_attribute('href')
            
            if href:
                if href.startswith('/'):
                    full_url = BASE_URL + href
                else:
                    full_url = href
                
                # Only include if it's under our category path
                cat_path = category_url.replace(BASE_URL, '')
                if cat_path in full_url and full_url not in subcategories:
                    subcategories.append(full_url)
        
        # Fallback: Original method - extract links that start with category path
        if not subcategories:
            links = await page.query_selector_all('a')
            for link in links:
                href = await link.get_attribute('href')
                if href:
                    cat_path = category_url.replace(BASE_URL, '')
                    # Include subcategories - don't filter by dimension pattern
                    # A subcategory won't have .html or product suffixes
                    if href.startswith(f'{cat_path}/'):
                        full_url = BASE_URL + href if href.startswith('/') else href
                        # Filter out product pages (they typically have more specific slugs)
                        # Subcategories tend to be shorter URLs
                        path_parts = full_url.replace(BASE_URL, '').strip('/').split('/')
                        if len(path_parts) <= 3:  # Category/Subcategory structure
                            if full_url not in subcategories:
                                subcategories.append(full_url)
        
        logger.info(f"Found {len(subcategories)} subcategories in {category_name}")
        
    except Exception as e:
        logger.error(f"Error getting subcategories from {category_url}: {e}")
    
    return subcategories


async def get_all_products_from_subcategory(page, subcategory_url: str, subcategory_name: str) -> List[str]:
    """
    Navigate to a subcategory page and extract ALL product URLs,
    handling pagination to get all products.
    
    IMPORTANT: Products are identified by product card elements, NOT by URL patterns.
    Many products don't have dimensions in their URL (e.g., "vintage-blue-wood-effect-tiles")
    """
    product_urls = []
    
    try:
        await page.goto(subcategory_url, timeout=60000)
        await asyncio.sleep(2)
        
        # Click pagination button if exists - try multiple selectors
        load_more_selectors = [
            'button:has-text("LOAD MORE")',
            'button:has-text("Load More")',
            'button:has-text("Show More")',
            'button:has-text("View More")',
            'a:has-text("LOAD MORE")',
            'button:has-text("LOAD NEXT")',
            'button:has-text("Load Next")',
        ]
        
        for selector in load_more_selectors:
            clicks = await click_load_more_until_done(page, selector, f"Products for {subcategory_name}")
            if clicks > 0:
                break
        
        # FIXED: Extract product URLs from PRODUCT CARDS, not just dimension-based URLs
        # Product cards have data-testid="product-card" or similar selectors
        product_cards = await page.query_selector_all('[data-testid="product-card"], .product-card, .product-item, article[class*="product"]')
        
        for card in product_cards:
            link = await card.query_selector('a')
            if link:
                href = await link.get_attribute('href')
                if href:
                    if href.startswith('/'):
                        href = BASE_URL + href
                    clean_url = href.split('?')[0]
                    # Exclude category/navigation links
                    if clean_url not in product_urls and not any(x in clean_url for x in ['/customer/', '/checkout/', '/cart/', '/account/']):
                        product_urls.append(clean_url)
        
        # Fallback: If no product cards found, try to get links from the page
        # Look for links that appear to be products (contain price indicators nearby)
        if not product_urls:
            # Try to find product links by looking at link containers with prices
            price_containers = await page.query_selector_all('[class*="price"], [data-price], .product-price')
            for container in price_containers:
                parent = await container.evaluate_handle('el => el.closest("a") || el.parentElement.querySelector("a")')
                if parent:
                    href = await parent.get_attribute('href')
                    if href:
                        if href.startswith('/'):
                            href = BASE_URL + href
                        clean_url = href.split('?')[0]
                        if clean_url not in product_urls and BASE_URL in clean_url:
                            product_urls.append(clean_url)
        
        # Final fallback: Original method - look for dimension-pattern URLs
        if not product_urls:
            links = await page.query_selector_all('a')
            for link in links:
                href = await link.get_attribute('href')
                if href and re.search(r'\d+x\d+', href):
                    if href.startswith('/'):
                        href = BASE_URL + href
                    clean_url = href.split('?')[0]
                    if clean_url not in product_urls:
                        product_urls.append(clean_url)
        
        logger.info(f"Found {len(product_urls)} products in {subcategory_name}")
        
    except Exception as e:
        logger.error(f"Error getting products from {subcategory_url}: {e}")
    
    return product_urls


async def discover_products_via_alphabet_search(page) -> List[str]:
    """
    Discover ALL products by searching through the alphabet and known series names.
    This catches products that might be missed by category crawling.
    """
    all_products = []
    
    # Import centralized series names
    try:
        from business_config.business_rules import KNOWN_SERIES_NAMES, SUPPLIER_SPECIFIC_SERIES
        extra_series = KNOWN_SERIES_NAMES + SUPPLIER_SPECIFIC_SERIES.get("Splendour", [])
    except ImportError:
        extra_series = [
            'marble', 'wood', 'stone', 'metro', 'terrazzo', 'vintage', 'signature',
            'porcelain', 'ceramic', 'travertine', 'limestone', 'slate', 'granite',
            'roma', 'milano', 'venezia', 'firenze', 'torino', 'verona', 'napoli',
            'carrara', 'calacatta', 'statuario', 'onyx', 'cremona', 'bologna',
            'hexagon', 'mosaic', 'brick', 'herringbone', 'chevron', 'arabesque',
            'modern', 'classic', 'rustic', 'industrial', 'contemporary',
            'ocean', 'forest', 'desert', 'arctic', 'pearl', 'crystal',
            'brook', 'spectra', 'orvieto', 'sahara', 'alpine', 'coastal', 'urban'
        ]
    
    # Search prefixes - letters, numbers, and known product series names
    search_terms = [
        'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
        'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
        '1', '2', '3', '4', '5', '6', '7', '8', '9', '0'
    ]
    
    # Add all series names (lowercase for search)
    search_terms.extend([s.lower() for s in extra_series if s.lower() not in search_terms])
    
    for term in search_terms:
        try:
            search_url = f'{BASE_URL}/search?q={term}'
            await page.goto(search_url, timeout=30000)
            await asyncio.sleep(1.5)
            
            # Click load more if exists
            load_more_selectors = [
                'button:has-text("LOAD MORE")',
                'button:has-text("Load More")',
            ]
            for selector in load_more_selectors:
                await click_load_more_until_done(page, selector, f"Search '{term}'", max_clicks=20)
            
            # Extract product URLs
            product_cards = await page.query_selector_all('[data-testid="product-card"], .product-card, .product-item')
            for card in product_cards:
                link = await card.query_selector('a')
                if link:
                    href = await link.get_attribute('href')
                    if href:
                        if href.startswith('/'):
                            href = BASE_URL + href
                        clean_url = href.split('?')[0]
                        if clean_url not in all_products and '/search' not in clean_url:
                            all_products.append(clean_url)
            
            logger.info(f"Search '{term}': Found {len(all_products)} total products so far")
            
        except Exception as e:
            logger.error(f"Error searching '{term}': {e}")
    
    return all_products


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


async def run_full_sync(db, categories: List[str] = None, resume: bool = True):
    """
    DEEP FULL SYNC: Crawl all categories and extract complete product info.
    
    Use this for:
    - Initial database population
    - Adding new products with full details and images
    
    Args:
        db: MongoDB database connection
        categories: List of categories to sync
        resume: Whether to resume from previous interrupted sync
    """
    global sync_state
    
    if sync_state["is_running"]:
        return {"error": "Sync already in progress"}
    
    # Check for resume data
    resume_data = None
    if resume:
        resume_data = get_resume_data(db)
        if resume_data and resume_data.get("mode") == "deep":
            logger.info(f"Found resume data: {resume_data['synced_count']} products already synced")
    
    # Default categories to sync
    if categories is None:
        categories = [
            '/wall-tiles',
            '/floor-tiles', 
            '/outdoor-tiles',
            '/new-collections',    # New collections - important for new products!
        ]
    
    # Initialize state
    reset_sync_state()
    job_id = f"splendour-deep-{datetime.now().strftime('%Y%m%d%H%M%S')}"
    
    update_state(
        is_running=True,
        job_id=job_id,
        phase="starting",
        sync_mode="deep",
        message="Starting DEEP full sync (with images)...",
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
    
    synced_urls = set()
    all_product_urls = []
    
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            page = await browser.new_page()
            
            # ===== STEP 1: LOGIN =====
            update_state(phase="login", message="Logging into Splendour...")
            
            if not await perform_login(page):
                update_state(is_running=False, phase="error", message="Login failed")
                await browser.close()
                return {"error": "Login failed"}
            
            update_state(message="Logged in successfully")
            
            # ===== Check if resuming =====
            if resume_data and resume_data.get("synced_count", 0) > 0:
                all_product_urls = resume_data.get("all_product_urls", [])
                synced_urls = resume_data.get("synced_urls", set())
                
                if all_product_urls:
                    update_state(
                        phase="syncing",
                        message=f"Resuming deep sync... {len(synced_urls)} already synced",
                        products_found=len(all_product_urls),
                        products_synced=len(synced_urls),
                        can_resume=True,
                        resume_from_product=len(synced_urls)
                    )
                    logger.info(f"Resuming sync: {len(synced_urls)}/{len(all_product_urls)} products")
                else:
                    # Had progress but no URLs saved — fall through to rediscovery
                    resume_data = None
            if not all_product_urls:
                # ===== STEP 2: FIND ALL SUBCATEGORIES =====
                update_state(phase="finding_subcategories", message="Finding all subcategories...")
                
                all_subcategories = []
                
                for i, cat in enumerate(categories):
                    cat_name = cat.strip('/').replace('-', ' ').title()
                    update_state(
                        message=f"Scanning {cat_name} for subcategories...",
                        categories_scanned=i + 1
                    )
                    
                    category_url = f'{BASE_URL}{cat}'
                    subcats = await get_all_subcategories_from_category(page, category_url, cat_name)
                    all_subcategories.extend(subcats)
                
                all_subcategories = list(set(all_subcategories))
                
                update_state(
                    message=f"Found {len(all_subcategories)} total subcategories",
                    subcategories_found=len(all_subcategories)
                )
                
                # ===== STEP 3: FIND ALL PRODUCT URLS =====
                update_state(phase="finding_products", message="Finding all products...")
                
                all_product_urls = []
                
                # Get clearance products
                try:
                    clearance_products = await get_all_products_from_subcategory(
                        page, f'{BASE_URL}/clearance', 'Clearance'
                    )
                    all_product_urls.extend(clearance_products)
                except Exception as e:
                    logger.error(f"Error getting clearance: {e}")
                
                # Crawl all subcategories
                total_subcats = len(all_subcategories)
                for i, subcat_url in enumerate(all_subcategories):
                    subcat_name = subcat_url.split('/')[-1]
                    progress = int((i / total_subcats) * 20) if total_subcats > 0 else 0
                    update_state(
                        progress=progress,
                        message=f"Scanning {subcat_name} ({i+1}/{total_subcats})...",
                        products_found=len(all_product_urls)
                    )
                    
                    try:
                        products = await get_all_products_from_subcategory(page, subcat_url, subcat_name)
                        all_product_urls.extend(products)
                    except Exception as e:
                        logger.error(f"Error scanning {subcat_name}: {e}")
                
                # ===== STEP 3b: DISCOVER ADDITIONAL PRODUCTS VIA SEARCH =====
                update_state(
                    phase="discovering_via_search",
                    progress=25,
                    message="Discovering additional products via search...",
                    products_found=len(all_product_urls)
                )
                
                try:
                    search_products = await asyncio.wait_for(
                        discover_products_via_alphabet_search(page),
                        timeout=300  # 5 min max for search phase
                    )
                    logger.info(f"Search discovery found {len(search_products)} product URLs")
                    all_product_urls.extend(search_products)
                except asyncio.TimeoutError:
                    logger.warning("Search discovery timed out after 5 minutes, continuing with category products only")
                except Exception as e:
                    logger.error(f"Error in search discovery: {e}")
                
                # Deduplicate
                all_product_urls = list(set(all_product_urls))
                
                update_state(
                    products_found=len(all_product_urls),
                    message=f"Found {len(all_product_urls)} total products to sync (category + search discovery)"
                )
                logger.info(f"Total products found after search discovery: {len(all_product_urls)}")
            
            # ===== STEP 4: VISIT EACH PRODUCT AND SYNC (DEEP) =====
            update_state(phase="syncing", message="Syncing products with full details...")
            
            synced = len(synced_urls)
            failed = 0
            skipped = 0  # Track non-tile products skipped
            total_products = len(all_product_urls)
            consecutive_failures = 0
            max_consecutive_failures = 50  # Increased tolerance for slow portals
            
            # Save initial progress
            save_sync_progress(db, job_id, all_product_urls, list(synced_urls), "syncing", "deep")
            
            for i, product_url in enumerate(all_product_urls):
                # Skip already synced products
                if product_url in synced_urls:
                    continue
                
                progress = 30 + int((i / total_products) * 70) if total_products > 0 else 30
                product_slug = product_url.split('/')[-1][:30]
                update_state(
                    progress=progress,
                    message=f"[DEEP] Syncing {synced+1}/{total_products}: {product_slug}...",
                    products_synced=synced,
                    products_failed=failed
                )
                
                try:
                    # Retry logic for individual products
                    max_retries = 3
                    for retry in range(max_retries):
                        try:
                            await page.goto(product_url, timeout=60000)  # 60s timeout for slow portals
                            await asyncio.sleep(REQUEST_DELAY)
                            break  # Success, exit retry loop
                        except Exception as retry_error:
                            if retry < max_retries - 1:
                                logger.warning(f"Retry {retry + 1}/{max_retries} for {product_url}: {retry_error}")
                                await asyncio.sleep(2)  # Wait before retry
                            else:
                                raise retry_error  # Final retry failed, raise the error
                    
                    product = await extract_product_full(page)
                    
                    # FIXED: Only require name, SKU is now always generated as fallback
                    if product and product.get('name'):
                        # Construct complete name with size and finish
                        complete_name = construct_complete_name(
                            product.get('name'),
                            product.get('size'),
                            product.get('finish')
                        )
                        
                        # Get the display name (transformed) - use complete name
                        display_name = get_display_name(complete_name, 'Splendour', product.get('finish'))
                        
                        # Update current product for live display
                        update_state(
                            current_product={
                                "name": complete_name,
                                "display_name": display_name,
                                "sku": product.get('sku'),
                                "image": product.get('images', [None])[0] if product.get('images') else None,
                                "price": product.get('price'),
                                "cost_price": product.get('cost_price'),
                                "stock_m2": product.get('stock_m2'),
                                "url": product.get('url')
                            }
                        )
                        
                        # Check if product should be excluded (non-tile)
                        should_skip, skip_reason = is_non_tile_product(
                            product_name=complete_name,
                            category=product.get('category', ''),
                            url=product_url
                        )
                        if should_skip:
                            skipped += 1
                            synced_urls.add(product_url)  # Mark as processed
                            logger.info(f"SKIPPED non-tile product: {complete_name} - {skip_reason}")
                            continue
                        
                        product_data = {
                            "supplier": "Splendour",
                            "sku": product['sku'],
                            "name": complete_name,  # Store complete name with size and finish
                            "product_name": display_name,  # Store the transformed name
                            "url": product['url'],
                            "category": extract_category_from_url(product_url),  # Extract category from URL
                            "price": product.get('price'),
                            "stock_m2": product.get('stock_m2', 0),
                            "in_stock": product.get('in_stock', False),
                            "image": product.get('images', [None])[0],
                            "images": product.get('images', []),
                            "size": product.get('size'),
                            "material": product.get('material'),
                            "finish": product.get('finish'),
                            "synced_at": datetime.now(timezone.utc),
                            "sync_source": "deep_full_sync",
                            "has_complete_data": True,
                            "sku_generated": product.get('sku_generated', False)
                        }
                        
                        db.sync_staging.update_one(
                            {"supplier": "Splendour", "sku": product['sku']},
                            {"$set": product_data},
                            upsert=True
                        )
                        synced += 1
                        synced_urls.add(product_url)
                        consecutive_failures = 0
                        
                        # Log image status
                        if product.get('images'):
                            logger.info(f"Synced {product['sku']} with {len(product['images'])} images")
                        
                        # Save progress every 10 products
                        if synced % 10 == 0:
                            save_sync_progress(db, job_id, all_product_urls, list(synced_urls), "syncing", "deep")
                    else:
                        failed += 1
                        consecutive_failures += 1
                        if product:
                            logger.warning(f"Product missing data: {product.get('name', 'unknown')} - sku: {product.get('sku')}")
                        
                except asyncio.TimeoutError:
                    failed += 1
                    consecutive_failures += 1
                    logger.error(f"Timeout loading {product_url}")
                except Exception as e:
                    failed += 1
                    consecutive_failures += 1
                    logger.error(f"Error processing {product_url}: {e}")
                
                # Check for too many consecutive failures — save progress but continue
                if consecutive_failures >= max_consecutive_failures:
                    logger.error(f"Hit {consecutive_failures} consecutive failures, saving progress and resetting counter")
                    save_sync_progress(db, job_id, all_product_urls, list(synced_urls), "syncing", "deep")
                    update_state(
                        message=f"Hit errors, continuing... {synced} synced, {failed} failed so far.",
                        can_resume=True
                    )
                    consecutive_failures = 0  # Reset and keep going
                    await asyncio.sleep(5)  # Cooldown
            
            await browser.close()
            
            # ===== COMPLETE =====
            clear_sync_progress(db)
            
            update_state(
                is_running=False,
                phase="complete",
                progress=100,
                message=f"DEEP sync complete! {synced} products synced with images, {failed} failed, {skipped} skipped",
                products_synced=synced,
                products_failed=failed,
                completed_at=datetime.now(timezone.utc).isoformat(),
                can_resume=False
            )
            
            # Log the sync
            db.sync_logs.insert_one({
                "supplier": "Splendour",
                "source": "deep_full_sync",
                "mode": "deep",
                "timestamp": datetime.now(timezone.utc),
                "synced": synced,
                "failed": failed,
                "total_found": len(all_product_urls),
                "status": "complete"
            })
            
            return {
                "success": True,
                "mode": "deep",
                "synced": synced,
                "failed": failed,
                "total_found": len(all_product_urls)
            }
            
    except Exception as e:
        logger.error(f"Sync error: {e}")
        if all_product_urls:
            save_sync_progress(db, job_id, all_product_urls, list(synced_urls), "syncing", "deep")
        
        update_state(
            is_running=False,
            phase="error",
            message=f"Error: {str(e)}. Can resume from {len(synced_urls)} products.",
            can_resume=True if synced_urls else False
        )
        return {"error": str(e)}


async def run_quick_sync(db):
    """
    QUICK STOCK/PRICE SYNC: Only update stock and price for existing products.
    
    Use this for:
    - Daily/weekly inventory updates
    - Quick price checks
    - Lower server load
    
    This skips:
    - Category crawling (uses known product URLs from database)
    - Image extraction
    - Product detail extraction (name, size, material, etc.)
    
    Args:
        db: MongoDB database connection
    """
    global sync_state
    
    if sync_state["is_running"]:
        return {"error": "Sync already in progress"}
    
    # Get existing product URLs from database
    existing_products = list(db.sync_staging.find(
        {"supplier": "Splendour", "url": {"$exists": True}},
        {"url": 1, "sku": 1, "_id": 0}
    ))
    
    if not existing_products:
        return {"error": "No existing Splendour products found. Run a DEEP sync first."}
    
    product_urls = [p['url'] for p in existing_products if p.get('url')]
    
    # Initialize state
    reset_sync_state()
    job_id = f"splendour-quick-{datetime.now().strftime('%Y%m%d%H%M%S')}"
    
    update_state(
        is_running=True,
        job_id=job_id,
        phase="starting",
        sync_mode="quick",
        message=f"Starting QUICK sync (stock & price only) for {len(product_urls)} products...",
        products_found=len(product_urls),
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
            
            # ===== LOGIN =====
            update_state(phase="login", message="Logging into Splendour...")
            
            if not await perform_login(page):
                update_state(is_running=False, phase="error", message="Login failed")
                await browser.close()
                return {"error": "Login failed"}
            
            update_state(message="Logged in successfully")
            
            # ===== SYNC STOCK & PRICE ONLY =====
            update_state(phase="syncing", message="Updating stock and prices...")
            
            synced = 0
            failed = 0
            skipped = 0
            total_products = len(product_urls)
            
            for i, product_url in enumerate(product_urls):
                progress = int((i / total_products) * 100) if total_products > 0 else 0
                product_slug = product_url.split('/')[-1][:30]
                update_state(
                    progress=progress,
                    message=f"[QUICK] Updating {i+1}/{total_products}: {product_slug}...",
                    products_synced=synced,
                    products_failed=failed,
                    products_skipped=skipped
                )
                
                try:
                    await page.goto(product_url, timeout=20000)
                    await asyncio.sleep(REQUEST_DELAY_QUICK)
                    
                    product = await extract_product_quick(page)
                    
                    if product and product.get('sku'):
                        # Only update stock and price fields
                        update_fields = {
                            "stock_m2": product.get('stock_m2', 0),
                            "in_stock": product.get('in_stock', False),
                            "synced_at": datetime.now(timezone.utc),
                            "sync_source": "quick_stock_price_sync"
                        }
                        
                        if product.get('price'):
                            update_fields["price"] = product['price']
                        
                        result = db.sync_staging.update_one(
                            {"supplier": "Splendour", "sku": product['sku']},
                            {"$set": update_fields}
                        )
                        
                        if result.modified_count > 0 or result.matched_count > 0:
                            synced += 1
                        else:
                            skipped += 1
                    else:
                        skipped += 1
                        
                except asyncio.TimeoutError:
                    failed += 1
                    logger.error(f"Timeout loading {product_url}")
                except Exception as e:
                    failed += 1
                    logger.error(f"Error processing {product_url}: {e}")
            
            await browser.close()
            
            # ===== COMPLETE =====
            update_state(
                is_running=False,
                phase="complete",
                progress=100,
                message=f"QUICK sync complete! {synced} updated, {skipped} skipped, {failed} failed",
                products_synced=synced,
                products_failed=failed,
                products_skipped=skipped,
                completed_at=datetime.now(timezone.utc).isoformat()
            )
            
            # Log the sync
            db.sync_logs.insert_one({
                "supplier": "Splendour",
                "source": "quick_stock_price_sync",
                "mode": "quick",
                "timestamp": datetime.now(timezone.utc),
                "synced": synced,
                "failed": failed,
                "skipped": skipped,
                "total_checked": len(product_urls)
            })
            
            return {
                "success": True,
                "mode": "quick",
                "synced": synced,
                "failed": failed,
                "skipped": skipped
            }
            
    except Exception as e:
        logger.error(f"Quick sync error: {e}")
        update_state(
            is_running=False,
            phase="error",
            message=f"Error: {str(e)}"
        )
        return {"error": str(e)}


# =============================================================================
# ALIAS: run_light_sync = run_quick_sync
# =============================================================================
# For consistency with other suppliers (Ceramica Impex, Wallcano, Verona),
# we provide an alias "light" sync that maps to the existing "quick" sync.
# This allows the same API interface across all suppliers.

async def run_light_sync(db):
    """
    LIGHT SYNC: Alias for run_quick_sync for API consistency.
    
    All suppliers now support:
    - run_deep_sync / run_full_sync: Full product details + images
    - run_light_sync / run_quick_sync: Stock + price updates only
    """
    return await run_quick_sync(db)


def calculate_list_price(cost: float) -> float:
    """
    Calculate list price using the business rule formula:
    List Price = ceil((Cost × 1.90) × 1.20) - 0.01
    
    Example: Cost £10.00 → £10 × 1.90 = £19 × 1.20 = £22.80 → ceil = £23 - 0.01 = £22.99
    """
    import math
    if cost and cost > 0:
        raw_price = cost * 1.90 * 1.20  # 90% markup + 20% VAT
        rounded_up = math.ceil(raw_price)
        return rounded_up - 0.01
    return 0


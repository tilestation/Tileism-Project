"""
Ceramica Impex Server-Side Sync Module
=======================================
This module performs automated sync of Ceramica Impex products with two modes:

1. DEEP FULL SYNC (one-time/monthly):
   - Crawls ALL categories and subcategories
   - Visits every product page
   - Extracts complete info: name, SKU, price, stock, images, dimensions
   - Takes ~30-45 minutes but captures everything
   - Run once to populate the database
   - Images automatically uploaded to Cloudflare R2

2. LIGHT SYNC (regular) - See LIGHT_SYNC_RULES in business_rules.py:
   - Only syncs products already in database
   - Skips category crawling (uses known product URLs from DB)
   - ONLY UPDATES: cost_price, price, stock_m2, in_stock, synced_at, sync_source
   - PRESERVES: images, name, size, material, finish, and ALL other fields
   - Much faster (~10-15 minutes) and lower server load
   - Run daily/weekly for inventory updates

IMPORTANT: Light sync uses MongoDB $set on specific fields only.
           This ensures existing data (images, descriptions, etc.) is NEVER overwritten.
           See: business_config/business_rules.py -> LIGHT_SYNC_RULES

Portal: https://portal.ceramicaimpex.co.uk
Login: ASP.NET form-based authentication
"""

import asyncio
import re
import logging
import math
from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Any, List
import os
from pymongo import MongoClient

# Import non-tile exclusion rules
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from business_config.business_rules import is_non_tile_product, NON_TILE_EXCLUSION_RULES, get_display_name

# Import R2 uploader for automatic image upload to cloud storage
try:
    from services.storage.r2_uploader import process_product_images_for_deep_sync, R2ImageUploader
    R2_AVAILABLE = R2ImageUploader.is_configured()
except ImportError:
    R2_AVAILABLE = False
    process_product_images_for_deep_sync = None

logger = logging.getLogger(__name__)

# Configuration from business_rules
BASE_URL = "https://portal.ceramicaimpex.co.uk"
CERAMICA_EMAIL = "qasim@tilestation.co.uk"
CERAMICA_PASSWORD = os.environ.get("CERAMICA_PORTAL_PASSWORD", "")

# Max pagination to prevent infinite loops
MAX_PAGINATION = 50

# Delay between requests to reduce server load (seconds)
REQUEST_DELAY = 1.0
REQUEST_DELAY_QUICK = 0.5


def extract_category_from_url(url: str) -> str:
    """
    Extract category name from Ceramica Impex product URL.
    URL format: https://portal.ceramicaimpex.co.uk/Catalogue/Tiles/Category-Name/Product-Name
    Returns: Category name (e.g., "Category Name") or empty string if not found
    """
    try:
        if not url:
            return ""
        # Remove base URL and split by /
        path = url.replace(BASE_URL, "").strip("/")
        parts = path.split("/")
        # Expected: Catalogue/Tiles/Category-Name/Product-Name
        if len(parts) >= 3 and parts[0].lower() == "catalogue":
            category_slug = parts[2]  # Get category part
            # Convert slug to readable name (replace - with space, title case)
            category_name = category_slug.replace("-", " ").title()
            return category_name
        return ""
    except Exception:
        return ""

# Database connection
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
    "sync_mode": None,  # "deep" or "light"
    "categories_scanned": 0,
    "products_found": 0,
    "products_synced": 0,
    "products_failed": 0,
    "products_skipped": 0,
    "started_at": None,
    "completed_at": None,
    "errors": [],
    "can_resume": False,
    "resume_from_product": 0,
    # Current product being synced (for live display)
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
                "Ceramica Impex",
                kwargs.get("message") or sync_state.get("message") or "Sync failed",
                sync_state.get("sync_mode") or "server",
            )
        except Exception:
            pass


def calculate_list_price(cost: float) -> float:
    """
    Calculate list price using the business rule formula:
    List Price = ceil((Cost × 1.90) × 1.20) - 0.01
    
    Example: Cost £10.00 → £10 × 1.90 = £19 × 1.20 = £22.80 → ceil = £23 - 0.01 = £22.99
    """
    if cost and cost > 0:
        raw_price = cost * 1.90 * 1.20  # 90% markup + 20% VAT
        rounded_up = math.ceil(raw_price)
        return rounded_up - 0.01
    return 0


def save_sync_progress(db, job_id: str, product_urls: List[str], synced_urls: List[str], phase: str, mode: str):
    """Save sync progress to database for resume capability"""
    try:
        db.sync_progress.update_one(
            {"supplier": "Ceramica Impex", "job_id": job_id},
            {"$set": {
                "supplier": "Ceramica Impex",
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
            {"supplier": "Ceramica Impex", "status": "running"},
            sort=[("updated_at", -1)]
        )
        if not progress:
            return None
        updated_at = progress.get("updated_at")
        if updated_at:
            if updated_at.tzinfo is None:
                updated_at = updated_at.replace(tzinfo=timezone.utc)
            if datetime.now(timezone.utc) - updated_at > timedelta(hours=24):
                logger.warning(f"Ignoring STALE Ceramica Impex resume data from {updated_at} — deleting it and running a full fresh sync")
                db.sync_progress.delete_many({"supplier": "Ceramica Impex"})
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
        db.sync_progress.delete_many({"supplier": "Ceramica Impex"})
    except Exception as e:
        logger.error(f"Error clearing sync progress: {e}")


async def extract_product_full(page) -> Optional[Dict]:
    """
    DEEP SYNC: Extract ALL product data from a product detail page.
    Includes: name, SKU, price, stock, images, dimensions, etc.
    """
    try:
        product = {"url": page.url}
        
        # Get product name from h1 or title element
        h1 = await page.query_selector('h1, .product-title, .product-name')
        if h1:
            product['name'] = (await h1.inner_text()).strip()
        
        if not product.get('name'):
            # Try getting from page title
            title = await page.title()
            if title:
                product['name'] = title.split('|')[0].strip()
        
        if not product.get('name') or 'error' in product.get('name', '').lower():
            return None
        
        # Get page text for regex extraction
        page_text = await page.inner_text('body')
        normalized = re.sub(r'\s+', ' ', page_text.replace('\n', ' '))
        
        # SKU/Stock Code
        sku_patterns = [
            r'Stock\s*Code[:\s]+([A-Z0-9.\-]+)',
            r'SKU[:\s]+([A-Z0-9.\-]+)',
            r'Product\s*Code[:\s]+([A-Z0-9.\-]+)',
            r'Item\s*Code[:\s]+([A-Z0-9.\-]+)'
        ]
        for pattern in sku_patterns:
            sku_match = re.search(pattern, normalized, re.I)
            if sku_match:
                product['sku'] = sku_match.group(1).strip()
                break
        
        if not product.get('sku'):
            # Generate from URL
            url_slug = page.url.split('/')[-1].split('?')[0]
            product['sku'] = url_slug.upper().replace('-', '')[:20]
            product['sku_generated'] = True
        
        # Price (cost price from supplier)
        # Ceramica Impex price break table format:
        # "Price ex VAT (20%): 0 + £29.90 46.08 + 11.1% £26.57"
        # The first price after "0 +" is the base price
        price_patterns = [
            # Ceramica Impex price break table: "0 + £29.90" or "0+ £29.90"
            r'0\s*\+\s*£\s*([\d,]+(?:\.\d{2})?)',
            # Price after "Price ex VAT (20%):" followed by number and then £price
            r'Price\s*(?:ex|exc|excl\.?)?\s*VAT\s*\(?\d*%?\)?[:\s]+\d+[\s+]*£\s*([\d,]+(?:\.\d{2})?)',
            # Direct £XX.XX after VAT percentage
            r'VAT\s*\(?\d+%?\)?[:\s]+.*?£\s*([\d,]+(?:\.\d{2})?)',
            # From price format
            r'From\s*£\s*([\d,]+(?:\.\d{2})?)\s*(?:ex|exc|excl)?\s*(?:VAT)?',
            # Standard ex VAT format
            r'£\s*([\d,]+(?:\.\d{2})?)\s*(?:ex|exc|excl)\s*VAT',
            # Per SQM/m² format
            r'£\s*([\d,]+(?:\.\d{2})?)\s*(?:per\s*)?(?:SQM|sqm|m²|sq\.?\s*m)',
            # Price label formats
            r'Price\s*(?:per\s*(?:SQM|sqm|m²))?\s*[:\s]*£\s*([\d,]+(?:\.\d{2})?)',
            r'Cost\s*[:\s]*£\s*([\d,]+(?:\.\d{2})?)',
            r'RRP\s*[:\s]*£\s*([\d,]+(?:\.\d{2})?)',
            r'Trade\s*Price\s*[:\s]*£\s*([\d,]+(?:\.\d{2})?)',
            # Any £XX.XX format (fallback)
            r'£\s*([\d,]+\.\d{2})'
        ]
        
        price_found = False
        for pattern in price_patterns:
            price_match = re.search(pattern, normalized, re.I)
            if price_match:
                price_str = price_match.group(1).replace(',', '')
                try:
                    cost_price = float(price_str)
                    if cost_price > 0:  # Only accept positive prices
                        product['cost_price'] = cost_price
                        product['price'] = calculate_list_price(cost_price)
                        price_found = True
                        logger.info(f"Price found for {product.get('name', 'unknown')}: £{cost_price} -> List: £{product['price']} (pattern: {pattern[:40]}...)")
                        break
                except ValueError:
                    continue
        
        if not price_found:
            logger.warning(f"No price found for {product.get('name', 'unknown')} - Page text sample: {normalized[:500]}")
        
        # Stock - Format: "612.86574 m² in stock" or similar with decimals
        if re.search(r'out\s*of\s*stock|unavailable|no\s*stock', normalized, re.I):
            product['stock_m2'] = 0
            product['in_stock'] = False
        else:
            stock_patterns = [
                # Decimal stock with m² or SQM: "612.86574 m² in stock"
                r'([\d,]+(?:\.\d+)?)\s*(?:SQM|sqm|m²|m2)\s*(?:in\s*stock|available|In Stock)',
                # Stock label with decimal: "Stock: 612.86574 m²"
                r'Stock[:\s]*([\d,]+(?:\.\d+)?)\s*(?:SQM|sqm|m²|m2)?',
                # Available label: "Available: 612.86574 m²"
                r'Available[:\s]*([\d,]+(?:\.\d+)?)\s*(?:SQM|sqm|m²|m2)?',
                # Just decimal followed by m²/SQM
                r'([\d,]+(?:\.\d+)?)\s*(?:SQM|sqm|m²|m2)',
                # Boxes in stock (integer)
                r'(\d[\d,]*)\s*(?:boxes?)\s*(?:in\s*stock|available)'
            ]
            for pattern in stock_patterns:
                stock_match = re.search(pattern, normalized, re.I)
                if stock_match:
                    stock_str = stock_match.group(1).replace(',', '')
                    try:
                        product['stock_m2'] = float(stock_str)
                        product['in_stock'] = product['stock_m2'] > 0
                        logger.info(f"Stock found for {product.get('name', 'unknown')}: {product['stock_m2']} m²")
                        break
                    except ValueError:
                        continue
            
            if 'stock_m2' not in product:
                # Check for "in stock" indicator without quantity
                if re.search(r'in\s*stock', normalized, re.I):
                    product['in_stock'] = True
                    product['stock_m2'] = 0  # Unknown quantity - don't assume 100
                    logger.warning(f"Stock indicator found but no quantity for {product.get('name', 'unknown')}")
                else:
                    product['stock_m2'] = 0
                    product['in_stock'] = False
        
        # Size/Dimensions
        size_patterns = [
            r'Size[:\s]+(\d+)\s*[xX]\s*(\d+)(?:\s*[xX]\s*(\d+))?(?:\s*mm)?',
            r'(\d+)\s*[xX]\s*(\d+)(?:\s*[xX]\s*(\d+))?(?:\s*mm)?'
        ]
        for pattern in size_patterns:
            size_match = re.search(pattern, normalized)
            if size_match:
                if size_match.group(3):
                    product['size'] = f"{size_match.group(1)}x{size_match.group(2)}x{size_match.group(3)}mm"
                else:
                    product['size'] = f"{size_match.group(1)}x{size_match.group(2)}"
                break
        
        # Material Type
        material_patterns = {
            'Porcelain': r'\bPorcelain\b',
            'Ceramic': r'\bCeramic\b',
            'Natural Stone': r'\b(?:Natural\s*)?Stone\b',
            'Marble': r'\bMarble\b',
            'Glass': r'\bGlass\b',
            'Mosaic': r'\bMosaic\b'
        }
        for material, pattern in material_patterns.items():
            if re.search(pattern, normalized, re.I):
                product['material'] = material
                break
        
        # Finish
        finish_patterns = {
            'Matt': r'\bMatt\b',
            'Gloss': r'\bGloss\b',
            'Polished': r'\bPolished\b',
            'Satin': r'\bSatin\b',
            'Lappato': r'\bLappato\b',
            'Textured': r'\bTextured\b',
            'Anti-Slip': r'\bAnti[- ]?Slip\b'
        }
        for finish, pattern in finish_patterns.items():
            if re.search(pattern, normalized, re.I):
                product['finish'] = finish
                break
        
        # Images - Extract product images, NOT logos or icons
        images = []
        
        # More specific selectors for Ceramica Impex product images
        image_selectors = [
            '.product-gallery img',
            '.product-images img',
            '.gallery-main img',
            '.main-image img',
            '[class*="ProductImage"] img',
            '[class*="product-image"] img',
            'img[src*="ProductImages"]',
            'img[src*="/products/"]',
            '.slick-slide img',  # Gallery slider
            '.carousel-item img',  # Carousel
        ]
        
        for selector in image_selectors:
            try:
                img_elements = await page.query_selector_all(selector)
                for img in img_elements:
                    src = await img.get_attribute('src')
                    if src:
                        # Convert relative to absolute
                        if src.startswith('/'):
                            src = BASE_URL + src
                        elif not src.startswith('http'):
                            src = BASE_URL + '/' + src
                        
                        # Skip logos, thumbnails, icons, and small images
                        skip_patterns = ['thumb', 'icon', '32x32', 'logo', 'brand', 'iica', 'header', 'footer', 'banner']
                        if any(pat in src.lower() for pat in skip_patterns):
                            continue
                        
                        if src not in images:
                            images.append(src)
                
                if images:
                    break  # Found images with this selector
            except:
                continue
        
        # Fallback: try any large product-related images
        if not images:
            try:
                all_imgs = await page.query_selector_all('img')
                for img in all_imgs:
                    src = await img.get_attribute('src')
                    if not src:
                        continue
                    
                    # Get image dimensions via JavaScript
                    try:
                        dims = await img.evaluate('(el) => ({ w: el.naturalWidth, h: el.naturalHeight })')
                        # Skip small images (likely logos) - product images should be at least 200x200
                        if dims.get('w', 0) < 200 or dims.get('h', 0) < 200:
                            continue
                    except:
                        pass
                    
                    # Convert relative to absolute
                    if src.startswith('/'):
                        src = BASE_URL + src
                    elif not src.startswith('http'):
                        src = BASE_URL + '/' + src
                    
                    # Skip known non-product patterns
                    skip_patterns = ['thumb', 'icon', 'logo', 'brand', 'iica', 'header', 'footer', 'banner', 'avatar', 'placeholder']
                    if any(pat in src.lower() for pat in skip_patterns):
                        continue
                    
                    if src not in images:
                        images.append(src)
            except:
                pass
        
        if images:
            product['images'] = images[:5]
            logger.info(f"Found {len(images)} images for {product.get('name', 'unknown')}: {images[0][:50]}...")
        
        return product
        
    except Exception as e:
        logger.error(f"Error extracting product (full): {e}")
        return None


async def extract_product_light(page) -> Optional[Dict]:
    """
    LIGHT SYNC: Extract only stock and price from a product page.
    Much faster as it skips image extraction and other details.
    """
    try:
        product = {"url": page.url}
        
        # Get page text for regex extraction
        page_text = await page.inner_text('body')
        normalized = re.sub(r'\s+', ' ', page_text.replace('\n', ' '))
        
        # Also get raw HTML for price elements that might be hidden/dynamic
        try:
            html_content = await page.content()
        except:
            html_content = ""
        
        # Log page content for debugging (first 500 chars)
        logger.debug(f"Page text sample: {normalized[:500]}")
        
        # SKU (needed to match with existing product)
        sku_patterns = [
            r'Stock\s*Code[:\s]+([A-Z0-9.-]+)',
            r'SKU[:\s]+([A-Z0-9.-]+)',
            r'Product\s*Code[:\s]+([A-Z0-9.-]+)'
        ]
        for pattern in sku_patterns:
            sku_match = re.search(pattern, normalized, re.I)
            if sku_match:
                product['sku'] = sku_match.group(1).strip()
                break
        
        if not product.get('sku'):
            return None  # Can't match without SKU
        
        # Price - Multiple extraction strategies
        price_found = False
        cost_price = None
        
        # Strategy 1: Try to get price from Playwright directly using JavaScript
        try:
            price_from_js = await page.evaluate('''() => {
                // Try different selectors for price elements
                const priceSelectors = [
                    '.PriceNumber',
                    '.Price',
                    '[data-item-property="Price.FormattedGross"]',
                    '.ProductPrice',
                    '.price-value',
                    'td:contains("£")'
                ];
                
                for (const selector of priceSelectors) {
                    try {
                        const elements = document.querySelectorAll(selector);
                        for (const el of elements) {
                            const text = el.textContent || el.innerText;
                            const match = text.match(/£\\s*([\\d,]+(?:\\.\\d{2})?)/);
                            if (match) {
                                return parseFloat(match[1].replace(',', ''));
                            }
                        }
                    } catch (e) {}
                }
                
                // Try to find any price in table cells
                const allTds = document.querySelectorAll('td');
                for (const td of allTds) {
                    const text = td.textContent || '';
                    const match = text.match(/£\\s*([\\d,]+(?:\\.\\d{2})?)/);
                    if (match) {
                        const val = parseFloat(match[1].replace(',', ''));
                        if (val > 0 && val < 1000) return val;  // Reasonable price range
                    }
                }
                
                return null;
            }''')
            
            if price_from_js and price_from_js > 0:
                cost_price = price_from_js
                product['cost_price'] = cost_price
                product['price'] = calculate_list_price(cost_price)
                price_found = True
                logger.info(f"Price found via JavaScript for {product.get('sku')}: £{cost_price}")
        except Exception as js_err:
            logger.debug(f"JavaScript price extraction failed: {js_err}")
        
        # Strategy 2: Try HTML regex patterns if JS failed
        if not price_found:
            # Look for price in HTML content
            html_price_patterns = [
                r'<[^>]*(?:Price|price)[^>]*>.*?£\s*([\d,]+(?:\.\d{2})?)',
                r'FormattedGross["\s:>]+£?\s*([\d,]+(?:\.\d{2})?)',
                r'data-price["\s=:]+["\']?([\d,]+(?:\.\d{2})?)',
            ]
            for pattern in html_price_patterns:
                match = re.search(pattern, html_content, re.DOTALL | re.I)
                if match:
                    try:
                        cost_price = float(match.group(1).replace(',', ''))
                        if cost_price > 0 and cost_price < 1000:
                            product['cost_price'] = cost_price
                            product['price'] = calculate_list_price(cost_price)
                            price_found = True
                            logger.info(f"Price found in HTML for {product.get('sku')}: £{cost_price}")
                            break
                    except ValueError:
                        continue
        
        # Strategy 3: Text pattern matching
        if not price_found:
            price_patterns = [
                # Ceramica Impex price break table: "0 + £29.90" or "0+ £29.90"
                r'0\s*\+\s*£\s*([\d,]+(?:\.\d{2})?)',
                # Price after "Price ex VAT (20%):" followed by number and then £price
                r'Price\s*(?:ex|exc|excl\.?)?\s*VAT\s*\(?\d*%?\)?[:\s]+\d+[\s+]*£\s*([\d,]+(?:\.\d{2})?)',
                # Direct £XX.XX after VAT percentage
                r'VAT\s*\(?\d+%?\)?[:\s]+.*?£\s*([\d,]+(?:\.\d{2})?)',
                # From price format
                r'From\s*£\s*([\d,]+(?:\.\d{2})?)\s*(?:ex|exc|excl)?\s*(?:VAT)?',
                # Standard ex VAT format
                r'£\s*([\d,]+(?:\.\d{2})?)\s*(?:ex|exc|excl)\s*VAT',
                # Any pound value in reasonable range
                r'£\s*([\d,]+\.\d{2})'
            ]
            
            for pattern in price_patterns:
                price_match = re.search(pattern, normalized, re.I)
                if price_match:
                    price_str = price_match.group(1).replace(',', '')
                    try:
                        cost_price = float(price_str)
                        if cost_price > 0 and cost_price < 500:  # Reasonable tile price range
                            product['cost_price'] = cost_price
                            product['price'] = calculate_list_price(cost_price)
                            price_found = True
                            logger.info(f"Price found in text for {product.get('sku')}: £{cost_price}")
                            break
                    except ValueError:
                        continue
        
        if not price_found:
            logger.warning(f"No price found for {product.get('sku')} - page text sample: {normalized[:200]}")
        
        # Stock - Format: "612.86574 m² in stock" or "612.86574 SQM in stock"
        if re.search(r'out\s*of\s*stock|unavailable', normalized, re.I):
            product['stock_m2'] = 0
            product['in_stock'] = False
        else:
            stock_patterns = [
                # Decimal stock with m² or SQM: "612.86574 m² in stock"
                r'([\d,]+(?:\.\d+)?)\s*(?:SQM|sqm|m²|m2)\s*(?:in\s*stock|available|In Stock)',
                # Stock label with decimal: "Stock: 612.86574"
                r'Stock[:\s]*([\d,]+(?:\.\d+)?)\s*(?:SQM|sqm|m²|m2)?',
                # Just decimal number followed by stock indicator
                r'([\d,]+(?:\.\d+)?)\s*(?:SQM|sqm|m²|m2)',
            ]
            for pattern in stock_patterns:
                stock_match = re.search(pattern, normalized, re.I)
                if stock_match:
                    stock_str = stock_match.group(1).replace(',', '')
                    try:
                        product['stock_m2'] = float(stock_str)
                        product['in_stock'] = product['stock_m2'] > 0
                        logger.info(f"Stock found for {product.get('sku')}: {product['stock_m2']} m²")
                        break
                    except ValueError:
                        continue
            
            if 'stock_m2' not in product:
                product['stock_m2'] = 0
                product['in_stock'] = False
        
        return product
        
    except Exception as e:
        logger.error(f"Error extracting product (light): {e}")
        return None


async def perform_login(page) -> bool:
    """Login to Ceramica Impex B2B portal"""
    try:
        login_url = f"{BASE_URL}/login/default.aspx"
        await page.goto(login_url, timeout=60000)
        await asyncio.sleep(3)
        
        # Close any cookie banners or popups first
        try:
            cookie_selectors = [
                'a.cookieConsentButton',
                '.cookieConsentButton',
                'button:has-text("Accept")',
                'button:has-text("OK")',
                '.cookie-accept',
                '#acceptCookies'
            ]
            for selector in cookie_selectors:
                elem = await page.query_selector(selector)
                if elem and await elem.is_visible():
                    await elem.click()
                    await asyncio.sleep(1)
                    logger.info("Closed cookie consent")
                    break
        except:
            pass
        
        # Fill login form - GOb2b ASP.NET form
        # Username field (name="uname")
        username_elem = await page.query_selector('input[name="uname"]')
        if username_elem:
            await username_elem.fill(CERAMICA_EMAIL)
            logger.info("Filled username field")
        else:
            logger.error("Username field not found")
            return False
        
        # Password field (name="pword")
        password_elem = await page.query_selector('input[name="pword"]')
        if password_elem:
            await password_elem.fill(CERAMICA_PASSWORD)
            logger.info("Filled password field")
        else:
            logger.error("Password field not found")
            return False
        
        await asyncio.sleep(1)
        
        # GOb2b uses JavaScript on .LoginBtn that triggers the hidden ActualLoginBtn
        # Method 1: Click the visible Login button (a.LoginBtn.TwoFactorLoginBtn)
        login_clicked = False
        
        login_btn = await page.query_selector('a.LoginBtn.TwoFactorLoginBtn, a.LoginBtn')
        if login_btn:
            try:
                await login_btn.click()
                login_clicked = True
                logger.info("Clicked LoginBtn anchor")
            except Exception as e:
                logger.warning(f"Failed to click LoginBtn: {e}")
        
        # Method 2: If anchor click didn't work, try JavaScript click on ActualLoginBtn
        if not login_clicked:
            try:
                await page.evaluate('''() => {
                    const btn = document.querySelector('input.ActualLoginBtn[type="submit"]');
                    if (btn) btn.click();
                }''')
                login_clicked = True
                logger.info("Clicked ActualLoginBtn via JavaScript")
            except:
                pass
        
        # Method 3: Press Enter on password field
        if not login_clicked:
            await password_elem.press('Enter')
            logger.info("Pressed Enter to submit form")
        
        await asyncio.sleep(5)  # Wait for ASP.NET postback
        
        # Check if login was successful
        current_url = page.url.lower()
        logger.info(f"After login, URL: {page.url}")
        
        # If we're redirected away from login page, success
        if 'login' not in current_url or 'catalogue' in current_url or 'home' in current_url:
            logger.info("Login successful - redirected away from login page")
            return True
        
        # Still on login page - check for error messages
        error_elem = await page.query_selector('.error, .alert-danger, .login-error, .validation-summary-errors')
        if error_elem:
            error_text = await error_elem.inner_text()
            logger.error(f"Login error message: {error_text}")
        
        # Check page content for success indicators
        page_text = await page.inner_text('body')
        if 'welcome' in page_text.lower() or 'logout' in page_text.lower() or 'my account' in page_text.lower():
            logger.info("Login successful - found welcome/logout text")
            return True
        
        logger.error("Login failed - still on login page")
        return False
        
    except Exception as e:
        logger.error(f"Login error: {e}")
        return False


async def get_all_categories(page) -> List[str]:
    """
    Get all category URLs from the B2B portal
    """
    categories = []
    try:
        # Go to main catalog page - GOb2b format
        catalog_url = f"{BASE_URL}/catalogue/default.aspx"
        logger.info(f"Navigating to catalog: {catalog_url}")
        await page.goto(catalog_url, timeout=60000)
        await asyncio.sleep(3)
        
        # Log page title for debugging
        title = await page.title()
        logger.info(f"Catalog page title: {title}")
        
        # Find all links on the page for debugging
        all_links = await page.query_selector_all('a')
        logger.info(f"Total links on catalog page: {len(all_links)}")
        
        # Find category links - look for various patterns
        for link in all_links:
            href = await link.get_attribute('href')
            if href:
                if href.startswith('/'):
                    full_href = BASE_URL + href
                else:
                    full_href = href
                    
                # Look for catalogue links
                if '/catalogue/' in full_href.lower() and full_href not in categories:
                    if 'login' not in full_href.lower() and 'cart' not in full_href.lower():
                        categories.append(full_href)
        
        logger.info(f"Found {len(categories)} category links: {categories[:10]}")
        
        # If no categories found, use default Tiles page which lists all tiles
        if not categories:
            logger.info("No categories found, using default Tiles URL")
            categories = [
                f"{BASE_URL}/Catalogue/Tiles"
            ]
        
        return categories
        
    except Exception as e:
        logger.error(f"Error getting categories: {e}")
        return [f"{BASE_URL}/Catalogue/Tiles"]  # Default fallback


async def get_products_from_category(page, category_url: str) -> List[str]:
    """
    Get all product URLs from a category page, handling pagination
    """
    product_urls = []
    
    try:
        await page.goto(category_url, timeout=60000)
        await asyncio.sleep(3)
        
        page_num = 1
        while page_num <= MAX_PAGINATION:
            # Scroll to bottom to trigger any lazy loading
            await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            await asyncio.sleep(1)
            
            # Find ALL links on the page first
            all_links = await page.query_selector_all('a[href*="/Catalogue/Tiles/"]')
            logger.info(f"Found {len(all_links)} links with /Catalogue/Tiles/ pattern")
            
            for link in all_links:
                href = await link.get_attribute('href')
                if href:
                    if href.startswith('/'):
                        href = BASE_URL + href
                    # Product URLs have format: /Catalogue/Tiles/PRODUCT-NAME-SKU
                    # Skip category/filter links (which just have /Catalogue/Tiles)
                    path = href.replace(BASE_URL, '').strip('/')
                    parts = path.split('/')
                    # A product link has at least: Catalogue/Tiles/ProductName
                    if len(parts) >= 3 and parts[0].lower() == 'catalogue' and parts[1].lower() == 'tiles' and parts[2]:
                        # Make sure it's not just the category page
                        if href not in product_urls and href != category_url and '?' not in href:
                            product_urls.append(href)
            
            logger.info(f"Page {page_num}: Found {len(product_urls)} unique products so far")
            
            # Check for next page - GOb2b uses numbered pagination
            next_found = False
            try:
                # Look for pagination links
                pagination = await page.query_selector_all('.pagination a, .paging a, a[href*="page="]')
                for pag_link in pagination:
                    link_text = await pag_link.inner_text()
                    if link_text.strip() == str(page_num + 1):
                        await pag_link.click()
                        await asyncio.sleep(2)
                        next_found = True
                        break
            except:
                pass
            
            if not next_found:
                # Try clicking "Next" or ">" button
                next_selectors = [
                    'a:has-text(">")',
                    'a:has-text("Next")',
                    '.pagination .next a',
                    'a.next'
                ]
                for selector in next_selectors:
                    try:
                        next_btn = await page.query_selector(selector)
                        if next_btn and await next_btn.is_visible():
                            await next_btn.click()
                            await asyncio.sleep(2)
                            next_found = True
                            break
                    except:
                        continue
            
            if not next_found:
                # Try "Load More" or "Show All" buttons (AJAX pagination)
                load_more_selectors = [
                    'button:has-text("Load More")',
                    'a:has-text("Load More")',
                    'button:has-text("Show All")',
                    'a:has-text("Show All")',
                    'button:has-text("View All")',
                    'a:has-text("View All")',
                    '.load-more',
                    '.show-all'
                ]
                for selector in load_more_selectors:
                    try:
                        btn = await page.query_selector(selector)
                        if btn and await btn.is_visible():
                            await btn.click()
                            await asyncio.sleep(3)
                            next_found = True
                            logger.info(f"Clicked load more button: {selector}")
                            break
                    except:
                        continue
            
            if not next_found:
                break
                
            page_num += 1
        
        logger.info(f"Category {category_url}: Found {len(product_urls)} total products")
        return product_urls
        
    except Exception as e:
        logger.error(f"Error getting products from {category_url}: {e}")
        return product_urls


# Known product series names to search for (covers most tile collections)
# Import from centralized business rules
try:
    from business_config.business_rules import KNOWN_SERIES_NAMES, SUPPLIER_SPECIFIC_SERIES
    # Combine global series with Ceramica Impex-specific series
    SEARCH_SERIES_NAMES = list(set(KNOWN_SERIES_NAMES + SUPPLIER_SPECIFIC_SERIES.get("Ceramica Impex", [])))
except ImportError:
    # Fallback if import fails
    SEARCH_SERIES_NAMES = [
        "brook", "roma", "milano", "venezia", "firenze", "torino", "verona",
        "napoli", "carrara", "calacatta", "statuario", "onyx", "cremona",
        "bologna", "orvieto", "palermo", "sicily", "tuscany",
        "marble", "travertine", "limestone", "slate", "granite", "sandstone",
        "porcelain", "ceramic", "terracotta", "quarry",
        "wood", "concrete", "cement", "stone", "terrazzo", "brick",
        "metro", "subway", "hexagon", "mosaic", "arabesque", "herringbone",
        "sahara", "desert", "ocean", "forest", "arctic", "alpine",
        "coastal", "mountain", "river", "pearl", "crystal",
        "white", "grey", "black", "beige", "cream", "ivory",
        "classic", "modern", "rustic", "vintage", "industrial", "contemporary",
        "spectra", "signature", "premium", "luxury", "elite", "select"
    ]


async def search_products_ceramica(page, search_term: str) -> List[str]:
    """Search for products on Ceramica Impex portal"""
    product_urls = []
    
    try:
        # Try to find search box on the page
        search_selectors = [
            'input[name*="search"]',
            'input[type="search"]',
            'input[placeholder*="Search"]',
            '#search',
            '.search-input',
            'input.SearchTextBox'
        ]
        
        search_box = None
        for selector in search_selectors:
            search_box = await page.query_selector(selector)
            if search_box:
                break
        
        if search_box:
            # Clear and fill search
            await search_box.fill('')
            await search_box.fill(search_term)
            await page.keyboard.press('Enter')
            await asyncio.sleep(3)
            
            # Get product links from results
            product_links = await page.query_selector_all('a[href*="/product/"], a[href*="/catalogue/"], a[href*="/Catalogue/"], .product-link a, .SearchResults a')
            
            for link in product_links:
                href = await link.get_attribute('href')
                if href and ('/product' in href.lower() or '/catalogue/' in href.lower()):
                    if href.startswith('/'):
                        href = BASE_URL + href
                    clean_url = href.split('?')[0]
                    if clean_url not in product_urls:
                        product_urls.append(clean_url)
            
            logger.info(f"Search '{search_term}': Found {len(product_urls)} products")
        else:
            # If no search box, try URL-based search
            search_url = f'{BASE_URL}/catalogue/search?q={search_term}'
            await page.goto(search_url, timeout=30000)
            await asyncio.sleep(2)
            
            # Get product links
            product_links = await page.query_selector_all('a[href*="/product/"], .product-item a')
            for link in product_links:
                href = await link.get_attribute('href')
                if href:
                    if href.startswith('/'):
                        href = BASE_URL + href
                    clean_url = href.split('?')[0]
                    if clean_url not in product_urls:
                        product_urls.append(clean_url)
            
            logger.info(f"Search URL '{search_term}': Found {len(product_urls)} products")
        
    except Exception as e:
        logger.error(f"Error searching for '{search_term}': {e}")
    
    return product_urls


async def discover_products_via_search(page, existing_urls: set = None) -> List[str]:
    """
    Discover products by searching for known series names.
    This catches products that might be missed by category navigation.
    """
    if existing_urls is None:
        existing_urls = set()
    
    all_new_products = []
    
    logger.info(f"Starting search-based discovery with {len(SEARCH_SERIES_NAMES)} series names")
    
    for series_name in SEARCH_SERIES_NAMES:
        try:
            product_urls = await search_products_ceramica(page, series_name)
            
            # Filter out already found products
            new_urls = [url for url in product_urls if url not in existing_urls]
            
            if new_urls:
                all_new_products.extend(new_urls)
                for url in new_urls:
                    existing_urls.add(url)
                logger.info(f"Series '{series_name}': Found {len(new_urls)} NEW products")
            
            await asyncio.sleep(0.5)  # Small delay between searches
            
        except Exception as e:
            logger.error(f"Error searching series '{series_name}': {e}")
            continue
    
    logger.info(f"Search discovery complete: Found {len(all_new_products)} additional products")
    return all_new_products


async def run_deep_sync(db, categories: List[str] = None, resume: bool = True):
    """
    DEEP FULL SYNC: Crawl all categories and extract complete product info.
    
    Use this for:
    - Initial database population
    - Adding new products with full details and images
    
    Args:
        db: MongoDB database connection
        categories: List of categories to sync (optional)
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
    
    # Initialize state
    reset_sync_state()
    job_id = f"ceramica-deep-{datetime.now().strftime('%Y%m%d%H%M%S')}"
    
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
            update_state(phase="login", message="Logging into Ceramica Impex B2B portal...")
            
            if not await perform_login(page):
                update_state(is_running=False, phase="error", message="Login failed")
                await browser.close()
                return {"error": "Login failed"}
            
            update_state(message="Logged in successfully")
            logger.info("Login completed successfully, now checking resume state...")
            
            # ===== Check if resuming =====
            if resume_data and resume_data.get("phase") == "syncing":
                logger.info("Resuming from previous sync...")
                all_product_urls = resume_data.get("all_product_urls", [])
                synced_urls = resume_data.get("synced_urls", set())
                
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
                # ===== STEP 2: FIND ALL CATEGORIES =====
                logger.info("Starting fresh sync - finding categories...")
                update_state(phase="finding_categories", message="Finding all categories...")
                
                if categories is None:
                    logger.info("No categories provided, discovering them...")
                    try:
                        categories = await get_all_categories(page)
                        logger.info(f"Discovered categories: {categories}")
                    except Exception as cat_err:
                        logger.error(f"Error in get_all_categories: {cat_err}")
                        categories = [f"{BASE_URL}/Catalogue/Tiles"]
                
                update_state(
                    message=f"Found {len(categories)} categories",
                    categories_scanned=len(categories)
                )
                
                # ===== STEP 3: FIND ALL PRODUCT URLS =====
                update_state(phase="finding_products", message="Finding all products...")
                
                for i, cat_url in enumerate(categories):
                    cat_name = cat_url.split('/')[-1]
                    update_state(
                        message=f"Scanning {cat_name} ({i+1}/{len(categories)})...",
                        categories_scanned=i + 1,
                        products_found=len(all_product_urls)
                    )
                    
                    try:
                        products = await get_products_from_category(page, cat_url)
                        all_product_urls.extend(products)
                    except Exception as e:
                        logger.error(f"Error scanning {cat_name}: {e}")
                
                # Deduplicate
                all_product_urls = list(set(all_product_urls))
                
                update_state(
                    products_found=len(all_product_urls),
                    message=f"Found {len(all_product_urls)} products from categories"
                )
                logger.info(f"Products from categories: {len(all_product_urls)}")
                
                # ===== STEP 3B: SEARCH-BASED DISCOVERY =====
                update_state(phase="search_discovery", message="Running search-based discovery for known series...")
                
                existing_urls = set(all_product_urls)
                search_products = await discover_products_via_search(page, existing_urls)
                
                if search_products:
                    all_product_urls.extend(search_products)
                    logger.info(f"Search discovery added {len(search_products)} additional products")
                    update_state(
                        products_found=len(all_product_urls),
                        message=f"Search added {len(search_products)} more. Total: {len(all_product_urls)}"
                    )
                
                logger.info(f"Total products found: {len(all_product_urls)}")
            
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
                    
                    # Wait for price elements to load (Ceramica Impex loads prices dynamically)
                    try:
                        await page.wait_for_selector('.Price, .PriceBreak, .ProductPrice, [data-item-property*="Price"]', timeout=5000)
                    except:
                        pass  # Continue even if price selector times out
                    
                    product = await extract_product_full(page)
                    
                    if product and product.get('name'):
                        # Get the display name (transformed) - pass finish from product data
                        display_name = get_display_name(product.get('name'), 'Ceramica Impex', product.get('finish'))
                        
                        # Update current product for live display
                        update_state(
                            current_product={
                                "name": product.get('name'),
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
                            product_name=product.get('name', ''),
                            category=product.get('category', ''),
                            url=product_url
                        )
                        if should_skip:
                            skipped += 1
                            synced_urls.add(product_url)  # Mark as processed
                            logger.info(f"SKIPPED non-tile product: {product.get('name')} - {skip_reason}")
                            continue
                        
                        # Get existing product for image change detection
                        existing_product = db.sync_staging.find_one({
                            "supplier": "Ceramica Impex",
                            "sku": product.get('sku')
                        })
                        
                        # Store original source URLs for future change detection
                        source_images = product.get('images', [])
                        
                        # Upload images to R2 cloud storage (uses product display name per business rules)
                        if R2_AVAILABLE and process_product_images_for_deep_sync and source_images:
                            try:
                                product_display_name = product.get('name', product.get('sku', 'product'))
                                processed_images, uploaded_count, returned_source_urls = await process_product_images_for_deep_sync(
                                    source_images,
                                    'Ceramica Impex',
                                    product_display_name,
                                    existing_product  # Pass existing to detect image changes
                                )
                                product['images'] = processed_images
                                product['image_source_urls'] = returned_source_urls
                                if uploaded_count > 0:
                                    product['images_uploaded_to_r2'] = True
                                    logger.info(f"Uploaded {uploaded_count} images to R2 for {product_display_name}")
                            except Exception as img_err:
                                logger.warning(f"Failed to upload images to R2: {img_err}")
                                product['image_source_urls'] = source_images
                        else:
                            product['image_source_urls'] = source_images
                        
                        product_data = {
                            "supplier": "Ceramica Impex",
                            "sku": product.get('sku'),
                            "name": product['name'],
                            "product_name": display_name,  # Store the transformed name
                            "url": product['url'],
                            "category": extract_category_from_url(product_url),  # Extract category from URL
                            "cost_price": product.get('cost_price'),
                            "price": product.get('price'),
                            "stock_m2": product.get('stock_m2', 0),
                            "in_stock": product.get('in_stock', False),
                            "image": product.get('images', [None])[0],
                            "images": product.get('images', []),
                            "image_source_urls": product.get('image_source_urls', []),
                            "images_uploaded_to_r2": product.get('images_uploaded_to_r2', False),
                            "size": product.get('size'),
                            "material": product.get('material'),
                            "finish": product.get('finish'),
                            "synced_at": datetime.now(timezone.utc),
                            "sync_source": "deep_full_sync",
                            "has_complete_data": True,
                            "sku_generated": product.get('sku_generated', False)
                        }
                        
                        db.sync_staging.update_one(
                            {"supplier": "Ceramica Impex", "sku": product.get('sku')},
                            {"$set": product_data},
                            upsert=True
                        )
                        synced += 1
                        synced_urls.add(product_url)
                        consecutive_failures = 0
                        
                        if product.get('images'):
                            logger.info(f"Synced {product.get('sku')} with {len(product['images'])} images")
                        
                        # Save progress every 10 products
                        if synced % 10 == 0:
                            save_sync_progress(db, job_id, all_product_urls, list(synced_urls), "syncing", "deep")
                    else:
                        failed += 1
                        consecutive_failures += 1
                        
                except asyncio.TimeoutError:
                    failed += 1
                    consecutive_failures += 1
                    logger.error(f"Timeout loading {product_url}")
                except Exception as e:
                    failed += 1
                    consecutive_failures += 1
                    logger.error(f"Error processing {product_url}: {e}")
                
                # Check for too many consecutive failures — save progress but continue with remaining
                if consecutive_failures >= max_consecutive_failures:
                    logger.error(f"Hit {consecutive_failures} consecutive failures, saving progress and resetting counter")
                    save_sync_progress(db, job_id, all_product_urls, list(synced_urls), "syncing", "deep")
                    update_state(
                        message=f"Hit errors, continuing... {synced} synced, {failed} failed so far.",
                        can_resume=True
                    )
                    consecutive_failures = 0  # Reset and keep going instead of breaking
                    await asyncio.sleep(5)  # Wait 5 seconds before continuing
            
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
                "supplier": "Ceramica Impex",
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


async def run_light_sync(db):
    """
    LIGHT (QUICK) STOCK/PRICE SYNC: Only update stock and price for existing products.
    
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
    
    # Known product URLs: staging + permanent supplier_products (survives staging clears)
    existing_products = list(db.sync_staging.find(
        {"supplier": "Ceramica Impex", "url": {"$exists": True, "$ne": ""}},
        {"url": 1, "sku": 1, "name": 1, "_id": 0}
    ))
    seen_urls = {p.get("url") for p in existing_products}
    for p in db.supplier_products.find(
        {"supplier": {"$regex": "^Ceramica Impex$", "$options": "i"}, "url": {"$exists": True, "$ne": ""}},
        {"url": 1, "sku": 1, "name": 1, "_id": 0}
    ):
        if p.get("url") not in seen_urls:
            existing_products.append({"url": p["url"], "sku": p.get("sku"), "name": p.get("name")})
            seen_urls.add(p["url"])

    if not existing_products:
        logger.warning("[CERAMICA LIGHT] No known product URLs anywhere — bootstrapping with a DEEP sync instead")
        return await run_deep_sync(db)
    
    product_urls = [p['url'] for p in existing_products if p.get('url')]
    
    # Initialize state
    reset_sync_state()
    job_id = f"ceramica-light-{datetime.now().strftime('%Y%m%d%H%M%S')}"
    
    update_state(
        is_running=True,
        job_id=job_id,
        phase="starting",
        sync_mode="light",
        message=f"Starting LIGHT sync (stock & price only) for {len(product_urls)} products...",
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
            update_state(phase="login", message="Logging into Ceramica Impex...")
            
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
                    message=f"[LIGHT] Updating {i+1}/{total_products}: {product_slug}...",
                    products_synced=synced,
                    products_failed=failed,
                    products_skipped=skipped
                )
                
                try:
                    await page.goto(product_url, timeout=30000)
                    await asyncio.sleep(REQUEST_DELAY)
                    
                    # Wait for price elements to load (Ceramica Impex loads prices dynamically)
                    # Try multiple selectors with longer timeout
                    try:
                        await page.wait_for_selector('.Price, .PriceBreak, .ProductPrice, [data-item-property*="Price"], td:has-text("£")', timeout=8000)
                    except:
                        # Give extra time for JS to load prices
                        await asyncio.sleep(2)
                    
                    product = await extract_product_light(page)
                    
                    if product and product.get('sku'):
                        # Only update stock and price fields
                        update_fields = {
                            "stock_m2": product.get('stock_m2', 0),
                            "in_stock": product.get('in_stock', False),
                            "synced_at": datetime.now(timezone.utc),
                            "sync_source": "light_stock_price_sync"
                        }
                        
                        if product.get('cost_price'):
                            update_fields["cost_price"] = product['cost_price']
                        if product.get('price'):
                            update_fields["price"] = product['price']
                        
                        result = db.sync_staging.update_one(
                            {"supplier": "Ceramica Impex", "sku": product['sku']},
                            {"$set": update_fields,
                             "$setOnInsert": {
                                 "supplier": "Ceramica Impex",
                                 "sku": product['sku'],
                                 "url": product_url,
                                 "name": product.get('name') or next((e.get('name') for e in existing_products if e.get('url') == product_url), None),
                                 "created_at": datetime.now(timezone.utc)
                             }},
                            upsert=True
                        )
                        
                        if result.modified_count > 0 or result.matched_count > 0 or result.upserted_id:
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
                message=f"LIGHT sync complete! {synced} updated, {skipped} skipped, {failed} failed",
                products_synced=synced,
                products_failed=failed,
                products_skipped=skipped,
                completed_at=datetime.now(timezone.utc).isoformat()
            )
            
            # Log the sync
            db.sync_logs.insert_one({
                "supplier": "Ceramica Impex",
                "source": "light_stock_price_sync",
                "mode": "light",
                "timestamp": datetime.now(timezone.utc),
                "synced": synced,
                "failed": failed,
                "skipped": skipped,
                "total_checked": len(product_urls)
            })
            
            return {
                "success": True,
                "mode": "light",
                "synced": synced,
                "failed": failed,
                "skipped": skipped
            }
            
    except Exception as e:
        logger.error(f"Light sync error: {e}")
        update_state(
            is_running=False,
            phase="error",
            message=f"Error: {str(e)}"
        )
        return {"error": str(e)}

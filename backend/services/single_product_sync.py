"""
Single Product Sync Module
===========================
Add a single product from ANY supplier's website using just the product URL.
Performs deep extraction of all product details including images.

Features:
- Auto-detects supplier from URL domain
- Adds new suppliers automatically if not in database
- Works with any tile/product website
- Extracts: name, SKU, price, stock, images, size, material, finish

Usage:
  POST /api/supplier-sync/single-product
  Body: {"url": "https://www.any-supplier.com/product/..."}
"""

import asyncio
import re
import logging
import math
import uuid
from datetime import datetime, timezone
from typing import Optional, Dict, Any
from urllib.parse import urlparse
import os
from pymongo import MongoClient

# Import R2 uploader for automatic image upload
try:
    from services.storage.r2_uploader import process_product_images_for_deep_sync, R2ImageUploader
    R2_AVAILABLE = R2ImageUploader.is_configured()
except ImportError:
    R2_AVAILABLE = False
    process_product_images_for_deep_sync = None

logger = logging.getLogger(__name__)

# Database connection
def get_db():
    client = MongoClient(os.environ.get('MONGO_URL'))
    return client[os.environ.get('DB_NAME', 'tile_station')]



# Known supplier URL patterns (for optimized extraction)
KNOWN_SUPPLIERS = {
    "Splendour": ["splendourtiles.co.uk", "splendour"],
    "Ceramica Impex": ["ceramicaimpex.co.uk", "portal.ceramicaimpex"],
    "Wallcano": ["wallcanotiles.com", "wallcano"],
    "Verona": ["veronaceramics.com", "verona"],
}


def detect_supplier(url: str) -> tuple[str, bool]:
    """
    Detect supplier from product URL.
    Returns: (supplier_name, is_known_supplier)
    
    For known suppliers, returns the standardized name.
    For unknown suppliers, extracts a clean name from the domain.
    """
    url_lower = url.lower()
    
    # Check known suppliers first
    for supplier, patterns in KNOWN_SUPPLIERS.items():
        for pattern in patterns:
            if pattern in url_lower:
                return supplier, True
    
    # Extract supplier name from domain for unknown suppliers
    try:
        parsed = urlparse(url)
        domain = parsed.netloc.lower()
        
        # Remove common prefixes
        domain = re.sub(r'^(www\.|portal\.|shop\.|store\.)', '', domain)
        
        # Get the main domain name (before .co.uk, .com, etc.)
        parts = domain.split('.')
        if len(parts) >= 2:
            # Handle .co.uk style domains
            if parts[-2] in ['co', 'com', 'org', 'net']:
                main_name = parts[-3] if len(parts) >= 3 else parts[0]
            else:
                main_name = parts[-2]
        else:
            main_name = parts[0]
        
        # Clean up and format the name
        # Remove 'tiles', 'ceramics', etc. for cleaner name
        clean_name = re.sub(r'(tiles?|ceramics?|flooring|stone)', '', main_name, flags=re.I)
        clean_name = clean_name.strip('-_')
        
        if clean_name:
            # Capitalize properly
            supplier_name = clean_name.title()
        else:
            supplier_name = main_name.title()
        
        return supplier_name, False
        
    except Exception as e:
        logger.error(f"Error extracting supplier from URL: {e}")
        return "Unknown Supplier", False


def ensure_supplier_exists(db, supplier_name: str, url: str) -> Dict:
    """
    Ensure supplier exists in database, create if not.
    Returns supplier info.
    """
    # Check if supplier already exists
    existing = db.suppliers.find_one({"name": supplier_name})
    
    if existing:
        return {
            "name": supplier_name,
            "is_new": False,
            "id": str(existing.get("_id"))
        }
    
    # Extract domain for new supplier
    parsed = urlparse(url)
    domain = parsed.netloc.lower()
    base_url = f"{parsed.scheme}://{parsed.netloc}"
    
    # Create new supplier
    new_supplier = {
        "name": supplier_name,
        "domain": domain,
        "base_url": base_url,
        "created_at": datetime.now(timezone.utc),
        "product_count": 0,
        "last_synced": None,
        "status": "active",
        "sync_type": "single_product",  # Indicates products added one by one
        "notes": f"Auto-created from URL: {url}"
    }
    
    result = db.suppliers.insert_one(new_supplier)
    
    logger.info(f"Created new supplier: {supplier_name} from {domain}")
    
    return {
        "name": supplier_name,
        "is_new": True,
        "id": str(result.inserted_id),
        "domain": domain
    }


async def extract_generic_product(page, url: str) -> Optional[Dict]:
    """
    Generic product extraction that works with any website.
    Uses common patterns found across tile/product websites.
    """
    try:
        product = {"url": url}
        
        # ===== PRODUCT NAME =====
        # Try multiple common selectors for product title
        name_selectors = [
            'h1.product-title',
            'h1.product_title', 
            'h1.product-name',
            'h1[class*="product"]',
            'h1[class*="title"]',
            '.product-title h1',
            '.product-name',
            '.product-header h1',
            'h1',
        ]
        
        for selector in name_selectors:
            try:
                elem = await page.query_selector(selector)
                if elem:
                    text = (await elem.inner_text()).strip()
                    # Skip if it looks like an error page
                    if text and 'not found' not in text.lower() and 'error' not in text.lower() and len(text) > 3:
                        product['name'] = text
                        break
            except Exception:
                continue
        
        if not product.get('name'):
            # Try page title
            title = await page.title()
            if title and '|' in title:
                product['name'] = title.split('|')[0].strip()
            elif title:
                product['name'] = title.strip()
        
        if not product.get('name') or 'not found' in product.get('name', '').lower():
            return None
        
        # ===== GET PAGE TEXT FOR REGEX =====
        try:
            page_text = await page.inner_text('body')
            normalized = re.sub(r'\s+', ' ', page_text)
        except Exception:
            normalized = ""
        
        # ===== SKU / PRODUCT CODE =====
        sku_patterns = [
            r'SKU[:\s]*([A-Z0-9\-_]+)',
            r'Stock\s*Code[:\s]*([A-Z0-9\-_]+)',
            r'Product\s*Code[:\s]*([A-Z0-9\-_]+)',
            r'Item\s*(?:Code|No|Number)[:\s]*([A-Z0-9\-_]+)',
            r'Code[:\s]*([A-Z0-9\-_]+)',
            r'Ref[:\s]*([A-Z0-9\-_]+)',
        ]
        
        for pattern in sku_patterns:
            match = re.search(pattern, normalized, re.I)
            if match:
                product['sku'] = match.group(1).strip()
                break
        
        # Generate SKU from URL if not found
        if not product.get('sku'):
            url_slug = url.split('/')[-1].split('?')[0]
            product['sku'] = re.sub(r'[^A-Z0-9]', '', url_slug.upper())[:15]
            product['sku_generated'] = True
        
        # ===== PRICE =====
        price_patterns = [
            r'£\s*([\d,]+\.?\d*)\s*(?:per\s*)?(?:m²|sqm|sq\.?\s*m)',
            r'£\s*([\d,]+\.?\d*)\s*/\s*(?:m²|sqm)',
            r'(?:Price|Cost)[:\s]*£\s*([\d,]+\.?\d*)',
            r'£\s*([\d,]+\.?\d*)',
            r'GBP\s*([\d,]+\.?\d*)',
        ]
        
        for pattern in price_patterns:
            match = re.search(pattern, normalized, re.I)
            if match:
                price_str = match.group(1).replace(',', '')
                try:
                    product['cost_price'] = float(price_str)
                    product['price'] = calculate_list_price(product['cost_price'])
                    break
                except Exception:
                    continue
        
        # ===== STOCK =====
        # Check for out of stock indicators
        out_of_stock_patterns = [
            r'out\s*of\s*stock',
            r'unavailable',
            r'sold\s*out',
            r'no\s*stock',
            r'currently\s*unavailable'
        ]
        
        is_out_of_stock = any(re.search(p, normalized, re.I) for p in out_of_stock_patterns)
        
        if is_out_of_stock:
            product['stock_m2'] = 0
            product['in_stock'] = False
        else:
            # Try to find stock quantity
            stock_patterns = [
                r'(\d+(?:\.\d+)?)\s*(?:m²|sqm|sq\.?\s*m)\s*(?:in\s*stock|available)',
                r'Stock[:\s]*(\d+(?:\.\d+)?)\s*(?:m²|sqm)',
                r'Available[:\s]*(\d+(?:\.\d+)?)',
                r'(\d+)\s*(?:boxes?|pcs?|pieces?)\s*(?:in\s*stock|available)',
            ]
            
            for pattern in stock_patterns:
                match = re.search(pattern, normalized, re.I)
                if match:
                    try:
                        product['stock_m2'] = float(match.group(1))
                        product['in_stock'] = product['stock_m2'] > 0
                        break
                    except Exception:
                        continue
            
            # Default to in stock if no indicators found
            if 'stock_m2' not in product:
                if re.search(r'in\s*stock|available|add\s*to\s*(?:cart|basket)', normalized, re.I):
                    product['in_stock'] = True
                    product['stock_m2'] = 100  # Default assumption
                else:
                    product['in_stock'] = True
                    product['stock_m2'] = 100
        
        # ===== SIZE / DIMENSIONS =====
        size_patterns = [
            r'(\d+)\s*[xX×]\s*(\d+)(?:\s*[xX×]\s*(\d+))?\s*(?:mm|cm)?',
            r'Size[:\s]*(\d+)\s*[xX×]\s*(\d+)',
            r'Dimensions?[:\s]*(\d+)\s*[xX×]\s*(\d+)',
        ]
        
        for pattern in size_patterns:
            match = re.search(pattern, normalized)
            if match:
                w, h = match.group(1), match.group(2)
                product['size'] = f"{w}x{h}"
                try:
                    product['width'] = int(w)
                    product['height'] = int(h)
                except Exception:
                    pass
                break
        
        # ===== MATERIAL =====
        material_patterns = {
            'Porcelain': r'\bPorcelain\b',
            'Ceramic': r'\bCeramic\b',
            'Natural Stone': r'\bNatural\s*Stone\b',
            'Marble': r'\bMarble\b',
            'Granite': r'\bGranite\b',
            'Slate': r'\bSlate\b',
            'Travertine': r'\bTravertine\b',
            'Limestone': r'\bLimestone\b',
            'Glass': r'\bGlass\b',
            'Mosaic': r'\bMosaic\b',
            'Quarry': r'\bQuarry\b',
            'Terracotta': r'\bTerracotta\b',
        }
        
        for material, pattern in material_patterns.items():
            if re.search(pattern, normalized, re.I):
                product['material'] = material
                break
        
        # ===== FINISH =====
        finish_patterns = {
            'Polished': r'\bPolish(?:ed)?\b',
            'Matt': r'\bMatt(?:e)?\b',
            'Gloss': r'\bGloss(?:y)?\b',
            'Satin': r'\bSatin\b',
            'Lappato': r'\bLappato\b',
            'Honed': r'\bHoned\b',
            'Textured': r'\bTexture[d]?\b',
            'Anti-Slip': r'\bAnti[- ]?Slip\b',
            'Rustic': r'\bRustic\b',
            'Natural': r'\bNatural\b',
            'Brushed': r'\bBrushed\b',
        }
        
        for finish, pattern in finish_patterns.items():
            if re.search(pattern, normalized, re.I):
                product['finish'] = finish
                break
        
        # ===== COLOR =====
        color_patterns = {
            'White': r'\bWhite\b',
            'Black': r'\bBlack\b',
            'Grey': r'\bGr[ae]y\b',
            'Beige': r'\bBeige\b',
            'Cream': r'\bCream\b',
            'Brown': r'\bBrown\b',
            'Blue': r'\bBlue\b',
            'Green': r'\bGreen\b',
            'Red': r'\bRed\b',
            'Yellow': r'\bYellow\b',
            'Orange': r'\bOrange\b',
            'Pink': r'\bPink\b',
            'Ivory': r'\bIvory\b',
            'Graphite': r'\bGraphite\b',
            'Anthracite': r'\bAnthracite\b',
        }
        
        for color, pattern in color_patterns.items():
            if re.search(pattern, normalized, re.I):
                product['color'] = color
                break
        
        # ===== USAGE (Indoor/Outdoor) =====
        if re.search(r'\boutdoor\b', normalized, re.I):
            product['usage'] = 'Indoor/Outdoor' if re.search(r'\bindoor\b', normalized, re.I) else 'Outdoor'
        elif re.search(r'\bindoor\b', normalized, re.I):
            product['usage'] = 'Indoor'
        
        # ===== SUITABILITY (Wall/Floor) =====
        is_wall = re.search(r'\bwall\s*tile', normalized, re.I)
        is_floor = re.search(r'\bfloor\s*tile', normalized, re.I)
        if is_wall and is_floor:
            product['suitability'] = 'Wall & Floor'
        elif is_wall:
            product['suitability'] = 'Wall'
        elif is_floor:
            product['suitability'] = 'Floor'
        
        # ===== IMAGES =====
        images = []
        
        img_selectors = [
            '.product-gallery img',
            '.product-image img',
            '.product-images img',
            '.woocommerce-product-gallery img',
            '[class*="gallery"] img',
            '[class*="product"] img[src*="product"]',
            '[class*="product"] img[src*="image"]',
            'img[src*="product"]',
            'img[data-src*="product"]',
            '.main-image img',
            '#product-image img',
        ]
        
        for selector in img_selectors:
            try:
                img_elements = await page.query_selector_all(selector)
                for img in img_elements:
                    src = await img.get_attribute('src') or await img.get_attribute('data-src') or await img.get_attribute('data-lazy-src')
                    if src:
                        # Make URL absolute
                        if src.startswith('//'):
                            src = 'https:' + src
                        elif src.startswith('/'):
                            parsed = urlparse(url)
                            src = f"{parsed.scheme}://{parsed.netloc}{src}"
                        
                        # Skip thumbnails and icons
                        if 'thumb' not in src.lower() and 'icon' not in src.lower() and '32x32' not in src and '50x50' not in src:
                            # Try to get full size image (remove size suffixes)
                            full_src = re.sub(r'-\d+x\d+\.', '.', src)
                            if full_src not in images and 'http' in full_src:
                                images.append(full_src)
                
                if images:
                    break
            except Exception:
                continue
        
        if images:
            product['images'] = images[:5]  # Limit to 5 images
        
        return product
        
    except Exception as e:
        logger.error(f"Error extracting product: {e}")
        return None



async def sync_single_product(url: str, supplier: str = None) -> Dict[str, Any]:
    """
    Sync a single product from ANY supplier website.
    
    Args:
        url: Product page URL
        supplier: Optional supplier name (auto-detected if not provided)
    
    Returns:
        Dict with success status and product data
    """
    # Detect supplier from URL
    detected_supplier, is_known = detect_supplier(url)
    
    if supplier:
        # Use provided supplier name
        final_supplier = supplier
    else:
        final_supplier = detected_supplier
    
    logger.info(f"Syncing single product from {final_supplier} (known: {is_known}): {url}")
    
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        return {"success": False, "error": "Playwright not available"}
    
    db = get_db()
    
    # Ensure supplier exists in database
    supplier_info = ensure_supplier_exists(db, final_supplier, url)
    
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            context = await browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            )
            page = await context.new_page()
            
            # Navigate to product page
            await page.goto(url, timeout=60000, wait_until="networkidle")
            await asyncio.sleep(2)
            
            # Extract product using generic extractor (works for all sites)
            product = await extract_generic_product(page, url)
            
            await browser.close()
            
            if not product:
                return {"success": False, "error": "Failed to extract product data"}
            
            if not product.get('name'):
                return {"success": False, "error": "Could not extract product name"}
            
            # Generate unique name
            original_name = product.get('name', '')
            product['supplier_product_name'] = original_name
            product['product_name'] = generate_unique_name(original_name, final_supplier)
            product['supplier'] = final_supplier
            
            # Check if already exists (for image change detection)
            existing = db.supplier_products.find_one({
                "supplier": final_supplier,
                "$or": [
                    {"sku": product.get('sku')},
                    {"url": url}
                ]
            })
            
            # Store original source URLs for future change detection
            source_images = product.get('images', [])
            product['image_source_urls'] = source_images.copy() if source_images else []
            
            # Upload images to R2 cloud storage (handles updates automatically)
            if R2_AVAILABLE and process_product_images_for_deep_sync and source_images:
                try:
                    product_display_name = product.get('product_name') or product.get('name', 'product')
                    processed_images, uploaded_count, source_urls = await process_product_images_for_deep_sync(
                        source_images,
                        final_supplier,
                        product_display_name,
                        existing  # Pass existing to detect image changes
                    )
                    product['images'] = processed_images
                    product['image_source_urls'] = source_urls
                    if uploaded_count > 0:
                        product['images_uploaded_to_r2'] = True
                        logger.info(f"Uploaded/updated {uploaded_count} images to R2 for {product_display_name}")
                except Exception as img_err:
                    logger.warning(f"Failed to upload images to R2: {img_err}")
            
            # Save to database
            now = datetime.now(timezone.utc)
            product_id = str(uuid.uuid4())
            
            if existing:
                # Update existing
                db.supplier_products.update_one(
                    {"_id": existing["_id"]},
                    {"$set": {
                        **product,
                        "synced_at": now,
                        "last_synced": now,
                        "sync_source": "single_product_sync"
                    }}
                )
                
                # Also update in products if exists
                if existing.get('products_db_id'):
                    db.products.update_one(
                        {"id": existing['products_db_id']},
                        {"$set": {
                            "name": product.get('product_name'),
                            "price": product.get('price'),
                            "cost": product.get('cost_price'),
                            "images": product.get('images', []),
                            "m2_quantity": product.get('stock_m2', 100)
                        }}
                    )
                
                return {
                    "success": True,
                    "action": "updated",
                    "supplier": final_supplier,
                    "supplier_info": supplier_info,
                    "product": {
                        "sku": product.get('sku'),
                        "original_name": original_name,
                        "display_name": product.get('product_name'),
                        "cost_price": product.get('cost_price'),
                        "list_price": product.get('price'),
                        "stock_m2": product.get('stock_m2'),
                        "in_stock": product.get('in_stock'),
                        "images_count": len(product.get('images', [])),
                        "size": product.get('size'),
                        "material": product.get('material'),
                        "finish": product.get('finish'),
                        "color": product.get('color')
                    }
                }
            else:
                # Insert new product
                supplier_product = {
                    **product,
                    "created_at": now,
                    "synced_at": now,
                    "last_synced": now,
                    "sync_source": "single_product_sync",
                    "in_products_db": True,
                    "products_db_id": product_id
                }
                
                db.supplier_products.insert_one(supplier_product)
                
                # Also insert to main products
                main_product = {
                    "id": product_id,
                    "name": product.get('product_name'),
                    "sku": product.get('sku'),
                    "category_name": "Tiles",
                    "stock": product.get('stock_m2', 100),
                    "m2_quantity": product.get('stock_m2', 100),
                    "tile_width": product.get('width'),
                    "tile_height": product.get('height'),
                    "price": product.get('price', 0),
                    "cost": product.get('cost_price', 0),
                    "images": product.get('images', []),
                    "material": product.get('material'),
                    "finish": product.get('finish'),
                    "color": product.get('color'),
                    "supplier": final_supplier,
                    "supplier_sku": product.get('sku'),
                    "supplier_product_name": original_name,
                    "created_at": now
                }
                
                # Remove None values
                main_product = {k: v for k, v in main_product.items() if v is not None}
                
                db.products.insert_one(main_product)
                
                # Update supplier product count
                db.suppliers.update_one(
                    {"name": final_supplier},
                    {
                        "$inc": {"product_count": 1},
                        "$set": {"last_synced": now}
                    }
                )
                
                return {
                    "success": True,
                    "action": "added",
                    "supplier": final_supplier,
                    "supplier_info": supplier_info,
                    "product": {
                        "id": product_id,
                        "sku": product.get('sku'),
                        "original_name": original_name,
                        "display_name": product.get('product_name'),
                        "cost_price": product.get('cost_price'),
                        "list_price": product.get('price'),
                        "stock_m2": product.get('stock_m2'),
                        "in_stock": product.get('in_stock'),
                        "images_count": len(product.get('images', [])),
                        "images": product.get('images', [])[:3],  # Return first 3 images
                        "size": product.get('size'),
                        "material": product.get('material'),
                        "finish": product.get('finish'),
                        "color": product.get('color')
                    }
                }
                
    except Exception as e:
        logger.error(f"Error syncing single product: {e}")
        return {"success": False, "error": str(e)}


# Pricing formula: List Price = ceil((Cost × 1.90) × 1.20) - 0.01
def calculate_list_price(cost: float) -> float:
    if cost and cost > 0:
        raw_price = cost * 1.90 * 1.20
        return math.ceil(raw_price) - 0.01
    return 0


# Naming logic for Ceramica Impex (Italian-themed)
CERAMICA_NAMING = {
    "SUPER WHITE": "Bianco",
    "GLOSSY WHITE": "Cristallo",
    "GLOSS WHITE": "Avorio",
    "OPAQUE WHITE": "Perla",
    "FLAT GLOSS WHITE": "Gelo",
    "RELIEF SUPER WHITE": "Neve",
    "GRAPHITE": "Ardesia",
    "GREY": "Cenere",
    "GRAY": "Cenere",
    "ALASKA": "Dolomiti",
    "MARBLE": "Pietrasanta",
    "TRAVERTINE": "Toscano",
    "LIMESTONE": "Umbria",
    "STONE": "Pietra",
    "WOOD": "Rovere",
    "TIMBER": "Acero",
    "POLISHED": "Specchio",
    "RUSTIC": "Rustico",
    "ANTIQUE": "Antico",
    "VINTAGE": "Classico",
    "AMALFI": "Positano",
    "GOLDEN": "Dorato",
}


def generate_unique_name(raw_name: str, supplier: str) -> str:
    """Generate unique product name based on supplier naming rules"""
    if not raw_name:
        return raw_name
    
    if supplier == "Ceramica Impex":
        # Apply Italian naming for Ceramica Impex
        name_upper = raw_name.upper()
        
        # Extract size
        size_match = re.search(r'(\d+)\s*[xX]\s*(\d+)', raw_name)
        size = f"{size_match.group(1)}x{size_match.group(2)}" if size_match else ""
        
        # Determine finish
        finish = ""
        if "POLISH" in name_upper:
            finish = "Polished"
        elif "GLOSS" in name_upper:
            finish = "Gloss"
        elif "MATT" in name_upper:
            finish = "Matt"
        elif "RELIEF" in name_upper:
            finish = "Relief"
        elif "RUSTIC" in name_upper:
            finish = "Rustic"
        
        # Determine color
        color = ""
        if "WHITE" in name_upper:
            color = "White"
        elif "GREY" in name_upper or "GRAY" in name_upper:
            color = "Grey"
        elif "GRAPHITE" in name_upper:
            color = "Graphite"
        elif "BLACK" in name_upper:
            color = "Black"
        elif "BEIGE" in name_upper:
            color = "Beige"
        
        # Find matching series name
        series_name = None
        for pattern, name in CERAMICA_NAMING.items():
            if pattern in name_upper:
                series_name = name
                break
        
        if not series_name:
            words = raw_name.split()
            for word in words:
                if not re.match(r'^[\d\-]+$', word) and len(word) > 2:
                    series_name = word.title()
                    break
        
        if not series_name:
            series_name = "Ceramica"
        
        parts = [series_name]
        if color:
            parts.append(color)
        if size:
            parts.append(size)
        if finish:
            parts.append(finish)
        
        return " ".join(parts)
    
    # For other suppliers, return cleaned name
    return raw_name.strip().title()


async def extract_splendour_product(page) -> Optional[Dict]:
    """Extract product details from Splendour product page"""
    try:
        product = {"url": page.url}
        
        # Product name
        h1 = await page.query_selector('h1.product-title, h1.product_title, h1')
        if h1:
            product['name'] = (await h1.inner_text()).strip()
        
        # Get page text for regex extraction
        page_text = await page.inner_text('body')
        normalized = re.sub(r'\s+', ' ', page_text)
        
        # SKU
        sku_match = re.search(r'SKU[:\s]*([A-Z0-9\-]+)', normalized, re.I)
        if sku_match:
            product['sku'] = sku_match.group(1).strip()
        
        # Price (cost from supplier)
        price_patterns = [
            r'£\s*([\d.]+)\s*(?:per\s*)?(?:m²|sqm)',
            r'Price[:\s]*£\s*([\d.]+)',
            r'£\s*([\d.]+)'
        ]
        for pattern in price_patterns:
            price_match = re.search(pattern, normalized, re.I)
            if price_match:
                product['cost_price'] = float(price_match.group(1))
                product['price'] = calculate_list_price(product['cost_price'])
                break
        
        # Stock
        stock_match = re.search(r'(\d+(?:\.\d+)?)\s*(?:m²|sqm)\s*(?:in\s*stock|available)', normalized, re.I)
        if stock_match:
            product['stock_m2'] = float(stock_match.group(1))
            product['in_stock'] = product['stock_m2'] > 0
        elif re.search(r'in\s*stock', normalized, re.I):
            product['in_stock'] = True
            product['stock_m2'] = 100
        else:
            product['in_stock'] = False
            product['stock_m2'] = 0
        
        # Size
        size_match = re.search(r'(\d+)\s*[xX]\s*(\d+)(?:\s*(?:mm|cm))?', normalized)
        if size_match:
            product['size'] = f"{size_match.group(1)}x{size_match.group(2)}"
            product['width'] = int(size_match.group(1))
            product['height'] = int(size_match.group(2))
        
        # Material
        if re.search(r'\bPorcelain\b', normalized, re.I):
            product['material'] = 'Porcelain'
        elif re.search(r'\bCeramic\b', normalized, re.I):
            product['material'] = 'Ceramic'
        
        # Finish
        if re.search(r'\bPolished\b', normalized, re.I):
            product['finish'] = 'Polished'
        elif re.search(r'\bMatt\b', normalized, re.I):
            product['finish'] = 'Matt'
        elif re.search(r'\bGloss\b', normalized, re.I):
            product['finish'] = 'Gloss'
        
        # Images
        images = []
        img_selectors = [
            '.product-gallery img',
            '.product-image img',
            '.woocommerce-product-gallery img',
            'img[src*="product"]'
        ]
        for selector in img_selectors:
            img_elements = await page.query_selector_all(selector)
            for img in img_elements:
                src = await img.get_attribute('src') or await img.get_attribute('data-src')
                if src and 'http' in src and 'thumb' not in src.lower():
                    # Get full size image
                    full_src = re.sub(r'-\d+x\d+\.', '.', src)
                    if full_src not in images:
                        images.append(full_src)
        
        if images:
            product['images'] = images[:5]
        
        return product
        
    except Exception as e:
        logger.error(f"Error extracting Splendour product: {e}")
        return None


async def extract_ceramica_product(page) -> Optional[Dict]:
    """Extract product details from Ceramica Impex product page"""
    try:
        product = {"url": page.url}
        
        # Product name
        h1 = await page.query_selector('h1, .product-title, .product-name')
        if h1:
            product['name'] = (await h1.inner_text()).strip()
        
        # Get page text
        page_text = await page.inner_text('body')
        normalized = re.sub(r'\s+', ' ', page_text)
        
        # SKU/Stock Code
        sku_patterns = [
            r'Stock\s*Code[:\s]+([A-Z0-9\-]+)',
            r'SKU[:\s]+([A-Z0-9\-]+)',
            r'Product\s*Code[:\s]+([A-Z0-9\-]+)'
        ]
        for pattern in sku_patterns:
            sku_match = re.search(pattern, normalized, re.I)
            if sku_match:
                product['sku'] = sku_match.group(1).strip()
                break
        
        # Price
        price_patterns = [
            r'£\s*([\d.]+)\s*(?:per\s*)?(?:SQM|sqm|m²)',
            r'Price[:\s]*£\s*([\d.]+)',
            r'£\s*([\d.]+)'
        ]
        for pattern in price_patterns:
            price_match = re.search(pattern, normalized, re.I)
            if price_match:
                product['cost_price'] = float(price_match.group(1))
                product['price'] = calculate_list_price(product['cost_price'])
                break
        
        # Stock
        if re.search(r'out\s*of\s*stock|unavailable', normalized, re.I):
            product['stock_m2'] = 0
            product['in_stock'] = False
        else:
            stock_match = re.search(r'(\d+)\s*(?:SQM|sqm|m²)\s*(?:in\s*stock|available)', normalized, re.I)
            if stock_match:
                product['stock_m2'] = int(stock_match.group(1))
                product['in_stock'] = True
            else:
                product['in_stock'] = True
                product['stock_m2'] = 100
        
        # Size
        size_match = re.search(r'(\d+)\s*[xX]\s*(\d+)', normalized)
        if size_match:
            product['size'] = f"{size_match.group(1)}x{size_match.group(2)}"
            product['width'] = int(size_match.group(1))
            product['height'] = int(size_match.group(2))
        
        # Material
        product['material'] = 'Porcelain'
        if re.search(r'\bCeramic\b', normalized, re.I):
            product['material'] = 'Ceramic'
        
        # Finish
        name_upper = (product.get('name', '') + ' ' + normalized).upper()
        if 'POLISH' in name_upper:
            product['finish'] = 'Polished'
        elif 'GLOSS' in name_upper:
            product['finish'] = 'Gloss'
        elif 'MATT' in name_upper:
            product['finish'] = 'Matt'
        elif 'RELIEF' in name_upper:
            product['finish'] = 'Relief'
        
        # Images
        images = []
        img_elements = await page.query_selector_all('img[src*="product"], img[src*="image"], .product-image img')
        for img in img_elements:
            src = await img.get_attribute('src')
            if src:
                if src.startswith('/'):
                    src = "https://portal.ceramicaimpex.co.uk" + src
                if 'thumb' not in src.lower() and 'icon' not in src.lower():
                    if src not in images:
                        images.append(src)
        
        if images:
            product['images'] = images[:5]
        
        return product
        
    except Exception as e:
        logger.error(f"Error extracting Ceramica product: {e}")
        return None


async def extract_wallcano_product(page) -> Optional[Dict]:
    """Extract product details from Wallcano product page"""
    try:
        product = {"url": page.url}
        
        # Product name
        h1 = await page.query_selector('h1.product-title, h1')
        if h1:
            product['name'] = (await h1.inner_text()).strip()
        
        # Get page text
        page_text = await page.inner_text('body')
        normalized = re.sub(r'\s+', ' ', page_text)
        
        # SKU
        sku_match = re.search(r'SKU[:\s]*([A-Z0-9\-]+)', normalized, re.I)
        if sku_match:
            product['sku'] = sku_match.group(1).strip()
        
        # Price
        price_match = re.search(r'£\s*([\d.]+)', normalized)
        if price_match:
            product['cost_price'] = float(price_match.group(1))
            product['price'] = calculate_list_price(product['cost_price'])
        
        # Stock
        product['in_stock'] = True
        product['stock_m2'] = 100
        if re.search(r'out\s*of\s*stock', normalized, re.I):
            product['in_stock'] = False
            product['stock_m2'] = 0
        
        # Size
        size_match = re.search(r'(\d+)\s*[xX]\s*(\d+)', normalized)
        if size_match:
            product['size'] = f"{size_match.group(1)}x{size_match.group(2)}"
            product['width'] = int(size_match.group(1))
            product['height'] = int(size_match.group(2))
        
        # Material & Finish
        product['material'] = 'Porcelain'
        if re.search(r'\bPolished\b', normalized, re.I):
            product['finish'] = 'Polished'
        elif re.search(r'\bMatt\b', normalized, re.I):
            product['finish'] = 'Matt'
        
        # Images
        images = []
        img_elements = await page.query_selector_all('.product-gallery img, .product-image img, img[src*="product"]')
        for img in img_elements:
            src = await img.get_attribute('src') or await img.get_attribute('data-src')
            if src and 'http' in src and 'thumb' not in src.lower():
                if src not in images:
                    images.append(src)
        
        if images:
            product['images'] = images[:5]
        
        return product
        
    except Exception as e:
        logger.error(f"Error extracting Wallcano product: {e}")
        return None


async def extract_verona_product(page) -> Optional[Dict]:
    """Extract product details from Verona product page"""
    try:
        product = {"url": page.url}
        
        # Product name
        h1 = await page.query_selector('h1')
        if h1:
            product['name'] = (await h1.inner_text()).strip()
        
        # Get page text
        page_text = await page.inner_text('body')
        normalized = re.sub(r'\s+', ' ', page_text)
        
        # SKU
        sku_match = re.search(r'(?:SKU|Code)[:\s]*([A-Z0-9\-]+)', normalized, re.I)
        if sku_match:
            product['sku'] = sku_match.group(1).strip()
        
        # Price
        price_match = re.search(r'£\s*([\d.]+)', normalized)
        if price_match:
            product['cost_price'] = float(price_match.group(1))
            product['price'] = calculate_list_price(product['cost_price'])
        
        # Stock
        product['in_stock'] = True
        product['stock_m2'] = 100
        
        # Size
        size_match = re.search(r'(\d+)\s*[xX]\s*(\d+)', normalized)
        if size_match:
            product['size'] = f"{size_match.group(1)}x{size_match.group(2)}"
            product['width'] = int(size_match.group(1))
            product['height'] = int(size_match.group(2))
        
        # Material
        product['material'] = 'Porcelain'
        
        # Images
        images = []
        img_elements = await page.query_selector_all('img[src*="product"], .gallery img')
        for img in img_elements:
            src = await img.get_attribute('src')
            if src and 'http' in src:
                if src not in images:
                    images.append(src)
        
        if images:
            product['images'] = images[:5]
        
        return product
        
    except Exception as e:
        logger.error(f"Error extracting Verona product: {e}")
        return None


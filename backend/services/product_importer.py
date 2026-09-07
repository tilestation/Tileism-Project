"""
Product Importer Service
Imports products from supplier portals and other websites using web scraping
"""
import os
import re
import uuid
import asyncio
import logging
import aiohttp
import json
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any
from urllib.parse import urljoin, urlparse
from bs4 import BeautifulSoup

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class SupplierImporter:
    """Base class for supplier product importers"""
    
    def __init__(self, base_url: str, credentials: Dict[str, str] = None):
        self.base_url = base_url
        self.credentials = credentials or {}
        self.session = None
        self.is_logged_in = False
        
    async def __aenter__(self):
        self.session = aiohttp.ClientSession(
            headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        )
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self.session:
            await self.session.close()
    
    async def login(self) -> bool:
        """Login to the supplier portal - override in subclass"""
        raise NotImplementedError
    
    async def get_categories(self) -> List[Dict]:
        """Get all product categories - override in subclass"""
        raise NotImplementedError
    
    async def get_products_from_category(self, category_url: str) -> List[Dict]:
        """Get all products from a category - override in subclass"""
        raise NotImplementedError
    
    async def get_product_details(self, product_url: str) -> Dict:
        """Get full product details - override in subclass"""
        raise NotImplementedError
    
    async def import_all_products(self, progress_callback=None) -> List[Dict]:
        """Import all products from the supplier"""
        raise NotImplementedError


class SplendourTilesImporter(SupplierImporter):
    """Importer for Splendour Tiles wholesale portal"""
    
    LOGIN_URL = "https://www.splendourtiles.co.uk/customer/account/login"
    CATEGORIES = [
        {"name": "Floor Tiles", "url": "https://www.splendourtiles.co.uk/floor-tiles"},
        {"name": "Wall Tiles", "url": "https://www.splendourtiles.co.uk/wall-tiles"},
        {"name": "Outdoor Tiles", "url": "https://www.splendourtiles.co.uk/outdoor-tiles"},
        {"name": "New Collections", "url": "https://www.splendourtiles.co.uk/new-collections"},
        {"name": "Clearance", "url": "https://www.splendourtiles.co.uk/clearance"},
        {"name": "Essentials", "url": "https://www.splendourtiles.co.uk/essentials"},
    ]
    
    async def login(self) -> bool:
        """Login to Splendour Tiles portal"""
        if not self.session:
            raise Exception("Session not initialized. Use async with.")
        
        try:
            # First, get the login page to retrieve any CSRF tokens
            async with self.session.get(self.LOGIN_URL) as response:
                if response.status != 200:
                    logger.error(f"Failed to load login page: {response.status}")
                    return False
                html = await response.text()
            
            soup = BeautifulSoup(html, 'html.parser')
            
            # Find form token if present (Magento uses form_key)
            form_key_input = soup.find('input', {'name': 'form_key'})
            form_key = form_key_input['value'] if form_key_input else ''
            
            # Prepare login data
            login_data = {
                'form_key': form_key,
                'login[username]': self.credentials.get('email', ''),
                'login[password]': self.credentials.get('password', ''),
                'send': '',
            }
            
            # Submit login form
            headers = {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Referer': self.LOGIN_URL,
            }
            
            async with self.session.post(
                'https://www.splendourtiles.co.uk/customer/account/loginPost/',
                data=login_data,
                headers=headers,
                allow_redirects=True
            ) as response:
                # Check if login was successful by looking for account page elements
                html = await response.text()
                
                # If redirected to account page or we see account elements, login succeeded
                if 'customer/account' in str(response.url) or 'My Account' in html or 'Log Out' in html:
                    self.is_logged_in = True
                    logger.info("Successfully logged in to Splendour Tiles")
                    return True
                else:
                    logger.error("Login failed - check credentials")
                    return False
                    
        except Exception as e:
            logger.error(f"Login error: {str(e)}")
            return False
    
    async def get_categories(self) -> List[Dict]:
        """Get all product categories"""
        return self.CATEGORIES
    
    async def _fetch_page(self, url: str) -> str:
        """Fetch a page and return HTML"""
        try:
            async with self.session.get(url) as response:
                if response.status == 200:
                    return await response.text()
                logger.error(f"Failed to fetch {url}: {response.status}")
                return ""
        except Exception as e:
            logger.error(f"Error fetching {url}: {str(e)}")
            return ""
    
    async def get_product_ranges_from_category(self, category_url: str) -> List[Dict]:
        """Get all product ranges (collections) from a category page"""
        ranges = []
        page_url = category_url
        
        while page_url:
            html = await self._fetch_page(page_url)
            if not html:
                break
                
            soup = BeautifulSoup(html, 'html.parser')
            
            # Find product range links (they link to /floor-tiles/range-name, /wall-tiles/range-name, etc.)
            range_links = soup.select('a[href*="/floor-tiles/"], a[href*="/wall-tiles/"], a[href*="/outdoor-tiles/"], a[href*="/new-collections/"], a[href*="/clearance/"], a[href*="/essentials/"]')
            
            for link in range_links:
                href = link.get('href', '')
                # Filter to only range pages (two path segments after category)
                path_parts = urlparse(href).path.strip('/').split('/')
                valid_categories = ['floor-tiles', 'wall-tiles', 'outdoor-tiles', 'new-collections', 'clearance', 'essentials']
                if len(path_parts) == 2 and path_parts[0] in valid_categories:
                    range_name = link.get_text(strip=True)
                    if range_name and href not in [r['url'] for r in ranges]:
                        ranges.append({
                            'name': range_name,
                            'url': urljoin(self.base_url, href),
                            'category': path_parts[0]
                        })
            
            # Check for pagination (Load More / Next)
            load_more = soup.select_one('button:contains("LOAD NEXT"), a:contains("LOAD NEXT")')
            if load_more:
                # This site uses infinite scroll/load more, would need to handle JS
                # For now, we'll work with initial load
                pass
            
            page_url = None  # Stop pagination for now
        
        return ranges
    
    async def get_products_from_range(self, range_url: str) -> List[Dict]:
        """Get all product tiles from a range/collection page"""
        products = []
        html = await self._fetch_page(range_url)
        
        if not html:
            return products
        
        soup = BeautifulSoup(html, 'html.parser')
        
        # Skip pages that are just category/navigation pages
        skip_paths = [
            'floor-tiles', 'wall-tiles', 'outdoor-tiles', 
            'customer', 'checkout', 'adhesives-and-grout',
            'about', 'contact', 'delivery',
            'returns', 'privacy', 'terms', 'account', 'cart', 'wishlist',
            'new-collections', 'clearance', 'essentials'
        ]
        
        # Find all links on the page
        product_cards = soup.find_all('a', href=True)
        
        for link in product_cards:
            href = link.get('href', '')
            if not href:
                continue
                
            path = urlparse(href).path.strip('/')
            
            # Skip category pages and navigation
            if '/' in path or not path:
                continue
            if any(skip in path.lower() for skip in skip_paths):
                continue
            
            full_url = urljoin(self.base_url, href)
            
            # Check if already added
            if full_url in [p.get('url') for p in products]:
                continue
            
            # Product URLs typically contain size info like 60x60, 1200x600, etc.
            # Or they have tile-related keywords
            url_text = path.lower()
            has_size_in_url = bool(re.search(r'\d+x\d+', url_text))
            has_tile_keyword = any(kw in url_text for kw in ['tile', 'slab', 'porcelain', 'ceramic', 'matt', 'gloss', 'polished'])
            
            # Accept if URL has size OR tile keyword
            if not has_size_in_url and not has_tile_keyword:
                # Check parent for size info as fallback
                parent = link.find_parent(['div', 'li', 'article'])
                if parent:
                    parent_text = parent.get_text()
                    if not re.search(r'\d+x\d+', parent_text):
                        continue
                else:
                    continue
            
            # Get the product name from link text or href
            name = link.get_text(strip=True)
            if not name or len(name) < 3:
                # Try to get name from href
                name = path.replace('-', ' ').title()
            
            # Filter out navigation text
            if any(x in name.lower() for x in ['log in', 'load', 'next', 'previous', 'view all', 'show more']):
                continue
            
            # Extract size from URL or name
            size_match = re.search(r'(\d+x\d+(?:x\d+)?(?:mm)?)', url_text + ' ' + name.lower())
            
            products.append({
                'url': full_url,
                'name': name,
                'size': size_match.group(1) if size_match else '',
            })
        
        return products
    
    async def get_product_details(self, product_url: str) -> Dict:
        """Get full product details from a product page"""
        html = await self._fetch_page(product_url)
        
        if not html:
            return {}
        
        soup = BeautifulSoup(html, 'html.parser')
        
        product = {
            'source_url': product_url,
            'imported_at': datetime.now(timezone.utc).isoformat(),
            'source': 'splendour_tiles',
        }
        
        # Extract product name (from h1 or title)
        h1 = soup.find('h1')
        product['name'] = h1.get_text(strip=True) if h1 else ''
        
        # Extract SKU
        sku_elem = soup.find(string=re.compile(r'SKU:'))
        if sku_elem:
            sku_match = re.search(r'SKU:\s*(\w+)', sku_elem.parent.get_text() if sku_elem.parent else str(sku_elem))
            product['sku'] = sku_match.group(1) if sku_match else ''
        else:
            # Try to find standalone SKU number
            product_id_elem = soup.find(string=re.compile(r'Product ID'))
            if product_id_elem:
                parent = product_id_elem.find_parent()
                if parent:
                    product['sku'] = parent.get_text().replace('Product ID', '').strip()
        
        # Extract size
        size_elem = soup.find(string=re.compile(r'Size:'))
        if size_elem:
            size_text = size_elem.parent.get_text() if size_elem.parent else str(size_elem)
            size_match = re.search(r'(\d+x\d+(?:x\d+)?mm)', size_text)
            product['size'] = size_match.group(1) if size_match else ''
        
        # Extract stock level
        stock_elem = soup.find(string=re.compile(r'\d+\s*SQM\s*in\s*Stock', re.I))
        if stock_elem:
            stock_match = re.search(r'(\d+)\s*SQM', stock_elem)
            product['stock_sqm'] = int(stock_match.group(1)) if stock_match else 0
        
        # Extract price (only visible when logged in)
        price_elem = soup.find(string=re.compile(r'£\d+'))
        if price_elem:
            price_match = re.search(r'£([\d.]+)', str(price_elem))
            product['cost_price'] = float(price_match.group(1)) if price_match else None
        else:
            product['cost_price'] = None
        
        # Extract product details table
        details = {}
        detail_rows = soup.select('div:contains("Product Details") ~ div, table tr')
        
        # Common detail fields
        detail_mappings = {
            'Weight': 'weight_kg',
            'Sale by': 'sale_unit',
            'Grade': 'grade',
            'Suitability': 'suitability',
            'Material Type': 'material',
            'Product color': 'color',
            'Underfloor Heating': 'underfloor_heating',
            'Finish': 'finish',
            'Thickness': 'thickness_mm',
            'Tiles Per SQM': 'tiles_per_sqm',
            'Space Usage': 'space_usage',
            'Shape': 'shape',
            'Style': 'style',
            'Boxes Per Pallet': 'boxes_per_pallet',
            'Pcs Per Pallet': 'pcs_per_pallet',
            'Box Quantity': 'tiles_per_box',
            'Rectified Edge': 'rectified',
        }
        
        for label, field in detail_mappings.items():
            elem = soup.find(string=re.compile(rf'^{label}', re.I))
            if elem:
                parent = elem.find_parent()
                if parent:
                    # Get the value (usually next sibling or in same container)
                    value_text = parent.get_text().replace(label, '').strip()
                    if value_text:
                        # Convert to appropriate type
                        if field in ['weight_kg', 'thickness_mm', 'tiles_per_sqm']:
                            try:
                                details[field] = float(re.search(r'[\d.]+', value_text).group())
                            except Exception:
                                details[field] = value_text
                        elif field in ['tiles_per_box', 'boxes_per_pallet', 'pcs_per_pallet', 'grade']:
                            try:
                                details[field] = int(re.search(r'\d+', value_text).group())
                            except Exception:
                                details[field] = value_text
                        elif field in ['underfloor_heating', 'rectified']:
                            details[field] = value_text.lower() in ['yes', 'true', '1']
                        else:
                            details[field] = value_text
        
        product.update(details)
        
        # Extract description
        desc_elem = soup.find('div', string=re.compile(r'Description', re.I))
        if desc_elem:
            desc_parent = desc_elem.find_parent()
            if desc_parent:
                product['description'] = desc_parent.get_text(strip=True).replace('Description', '').strip()
        else:
            # Try meta description
            meta_desc = soup.find('meta', {'name': 'description'})
            product['description'] = meta_desc.get('content', '') if meta_desc else ''
        
        # Extract images
        images = []
        img_elements = soup.select('img[src*="wallsandfloors.co.uk/media/catalog"]')
        for img in img_elements:
            src = img.get('src', '')
            # Get the highest resolution version
            if '2300X2300' in src or '650X650' in src:
                # Convert to full resolution URL
                full_src = re.sub(r'/\d+X\d+/', '/2300X2300/', src)
                if full_src not in images:
                    images.append(full_src)
        
        product['images'] = images[:5]  # Limit to 5 images
        
        return product
    
    async def import_all_products(self, progress_callback=None, limit: int = None) -> List[Dict]:
        """
        Import all products from Splendour Tiles
        
        Args:
            progress_callback: Optional async function to report progress
            limit: Optional limit on number of products to import
            
        Returns:
            List of product dictionaries
        """
        all_products = []
        
        if not self.is_logged_in:
            logged_in = await self.login()
            if not logged_in:
                logger.error("Cannot import without login")
                return []
        
        categories = await self.get_categories()
        total_categories = len(categories)
        
        for cat_idx, category in enumerate(categories):
            if progress_callback:
                await progress_callback({
                    'stage': 'categories',
                    'current': cat_idx + 1,
                    'total': total_categories,
                    'category': category['name']
                })
            
            logger.info(f"Processing category: {category['name']}")
            
            # Get all ranges in this category
            ranges = await self.get_product_ranges_from_category(category['url'])
            logger.info(f"Found {len(ranges)} ranges in {category['name']}")
            
            for range_idx, product_range in enumerate(ranges):
                if limit and len(all_products) >= limit:
                    break
                
                if progress_callback:
                    await progress_callback({
                        'stage': 'ranges',
                        'current': range_idx + 1,
                        'total': len(ranges),
                        'range': product_range['name']
                    })
                
                # Get products in this range
                products = await self.get_products_from_range(product_range['url'])
                
                for prod_idx, product in enumerate(products):
                    if limit and len(all_products) >= limit:
                        break
                    
                    if progress_callback:
                        await progress_callback({
                            'stage': 'products',
                            'current': prod_idx + 1,
                            'total': len(products),
                            'product': product['name']
                        })
                    
                    # Get full product details
                    details = await self.get_product_details(product['url'])
                    
                    if details and details.get('name'):
                        details['category'] = category['name']
                        details['range'] = product_range['name']
                        all_products.append(details)
                        logger.info(f"Imported: {details.get('name')}")
                    
                    # Small delay to be respectful to the server
                    await asyncio.sleep(0.5)
            
            if limit and len(all_products) >= limit:
                break
        
        logger.info(f"Total products imported: {len(all_products)}")
        return all_products


async def run_splendour_import(email: str, password: str, limit: int = None) -> List[Dict]:
    """
    Run Splendour Tiles import
    
    Args:
        email: Login email
        password: Login password
        limit: Optional limit on products
        
    Returns:
        List of imported products
    """
    async with SplendourTilesImporter(
        base_url="https://www.splendourtiles.co.uk",
        credentials={'email': email, 'password': password}
    ) as importer:
        
        logged_in = await importer.login()
        if not logged_in:
            return []
        
        products = await importer.import_all_products(limit=limit)
        return products


class TileStationWixImporter(SupplierImporter):
    """Importer for Tile Station's Wix website (one-time import, no sync)"""
    
    CATEGORY_URLS = [
        {"name": "All Tiles", "url": "https://www.tilestation.co.uk/category/all-tiles"},
        {"name": "Bathroom", "url": "https://www.tilestation.co.uk/bathroom"},
        {"name": "Materials", "url": "https://www.tilestation.co.uk/category/essentials"},
    ]
    
    def __init__(self, base_url: str = "https://www.tilestation.co.uk", credentials: Dict[str, str] = None):
        super().__init__(base_url, credentials)
        self.products_scraped = set()  # Track scraped products to avoid duplicates
    
    async def login(self) -> bool:
        """Wix public pages don't require login - just verify connectivity"""
        if not self.session:
            raise Exception("Session not initialized. Use async with.")
        
        try:
            async with self.session.get(self.base_url) as response:
                if response.status == 200:
                    logger.info("Successfully connected to Tile Station Wix site")
                    self.is_logged_in = True
                    return True
                else:
                    logger.error(f"Failed to connect to Wix site: {response.status}")
                    return False
        except Exception as e:
            logger.error(f"Connection error: {e}")
            return False
    
    async def get_categories(self) -> List[Dict]:
        """Return predefined category URLs for Wix site"""
        return self.CATEGORY_URLS
    
    async def get_product_urls_from_category(self, category_url: str, progress_callback=None) -> List[str]:
        """Get all product URLs from a category page"""
        product_urls = []
        
        try:
            async with self.session.get(category_url) as response:
                if response.status != 200:
                    logger.error(f"Failed to load category: {response.status}")
                    return product_urls
                
                html = await response.text()
            
            soup = BeautifulSoup(html, 'html.parser')
            
            # Find all product links (Wix uses /product-page/ URLs)
            links = soup.find_all('a', href=True)
            for link in links:
                href = link['href']
                if '/product-page/' in href:
                    full_url = href if href.startswith('http') else urljoin(self.base_url, href)
                    if full_url not in product_urls:
                        product_urls.append(full_url)
            
            logger.info(f"Found {len(product_urls)} products in category")
            
        except Exception as e:
            logger.error(f"Error getting products from category: {e}")
        
        return product_urls
    
    async def get_product_details(self, product_url: str) -> Optional[Dict]:
        """Scrape product details from a Wix product page"""
        
        if product_url in self.products_scraped:
            return None  # Skip duplicates
        
        try:
            async with self.session.get(product_url) as response:
                if response.status != 200:
                    logger.warning(f"Failed to load product page: {product_url}")
                    return None
                
                html = await response.text()
            
            soup = BeautifulSoup(html, 'html.parser')
            
            # Extract product name from title or h1
            name = ""
            title_tag = soup.find('title')
            if title_tag:
                name = title_tag.text.split('|')[0].strip()
            
            h1_tag = soup.find('h1')
            if h1_tag and not name:
                name = h1_tag.text.strip()
            
            # Get description from meta tag
            description = ""
            meta_desc = soup.find('meta', {'name': 'description'})
            if meta_desc and meta_desc.get('content'):
                description = meta_desc['content']
            
            # Extract prices - look for price patterns
            regular_price = None
            sale_price = None
            
            # Search for price text patterns
            text_content = soup.get_text()
            
            # Pattern for "Regular Price£XX.XX" or "£XX.XX"
            regular_match = re.search(r'Regular Price[^\d]*£?([\d,]+\.?\d*)', text_content)
            if regular_match:
                try:
                    regular_price = float(regular_match.group(1).replace(',', ''))
                except Exception:
                    pass
            
            sale_match = re.search(r'Sale Price[^\d]*£?([\d,]+\.?\d*)', text_content)
            if sale_match:
                try:
                    sale_price = float(sale_match.group(1).replace(',', ''))
                except Exception:
                    pass
            
            # If no regular/sale price found, look for simple price
            if not regular_price and not sale_price:
                price_match = re.search(r'£([\d,]+\.?\d*)', text_content)
                if price_match:
                    try:
                        regular_price = float(price_match.group(1).replace(',', ''))
                    except Exception:
                        pass
            
            # Extract images
            images = []
            img_tags = soup.find_all('img')
            for img in img_tags:
                src = img.get('src', '')
                if 'wixstatic.com' in src and 'media' in src:
                    # Get high-quality version
                    clean_url = re.sub(r'/v1/fill/[^/]+/', '/v1/fill/w_800,h_800,al_c,q_85,enc_avif,quality_auto/', src)
                    if clean_url not in images and len(images) < 10:
                        images.append(clean_url)
            
            # Extract specifications from table
            specs = {}
            tables = soup.find_all('table')
            for table in tables:
                rows = table.find_all('tr')
                for row in rows:
                    cells = row.find_all(['td', 'th'])
                    if len(cells) >= 2:
                        key = cells[0].get_text(strip=True).lower()
                        value = cells[1].get_text(strip=True)
                        specs[key] = value
            
            # Parse specs into standard fields
            thickness = specs.get('thickness', '')
            suitability = specs.get('suitability', '')
            material = specs.get('material', '')
            rectified = specs.get('rectified edges', '').lower() in ['yes', 'true']
            underfloor_heating = specs.get('underfloor heating', '').lower() in ['yes', 'true']
            
            # Extract size from name or specs
            size = ""
            size_match = re.search(r'(\d+)[xX×](\d+)', name)
            if size_match:
                size = f"{size_match.group(1)}x{size_match.group(2)}"
            
            # Generate a SKU from the product name
            sku = re.sub(r'[^a-zA-Z0-9]', '', name.upper()[:20])
            if not sku:
                sku = f"WIX-{str(uuid.uuid4())[:8].upper()}"
            
            # Use sale price as the main price, fallback to regular
            price = sale_price if sale_price else regular_price
            
            product = {
                "name": name,
                "sku": sku,
                "description": description,
                "size": size,
                "thickness": thickness,
                "material": material,
                "finish": "",  # Will be filled manually
                "color": "",  # Will be filled manually
                "cost_price": price,  # Using sale price as cost
                "regular_price": regular_price,
                "sale_price": sale_price,
                "stock_sqm": None,  # Not available on Wix
                "tiles_per_box": None,
                "tiles_per_sqm": None,
                "suitability": suitability,
                "underfloor_heating": underfloor_heating,
                "rectified": rectified,
                "images": images[:5],  # Limit to 5 images
                "category": "",  # Will be set based on import category
                "range": "",
                "source": "wix_tilestation",
                "source_url": product_url,
            }
            
            self.products_scraped.add(product_url)
            return product
            
        except Exception as e:
            logger.error(f"Error scraping product {product_url}: {e}")
            return None
    
    async def import_all_products(self, progress_callback=None, limit: int = None) -> List[Dict]:
        """Import all products from the Wix site"""
        all_products = []
        
        categories = await self.get_categories()
        total_categories = len(categories)
        
        for cat_idx, category in enumerate(categories):
            cat_name = category['name']
            cat_url = category['url']
            
            logger.info(f"Scraping category: {cat_name}")
            
            if progress_callback:
                await progress_callback({
                    "stage": "categories",
                    "current": cat_idx + 1,
                    "total": total_categories,
                    "category": cat_name
                })
            
            # Get product URLs from category
            product_urls = await self.get_product_urls_from_category(cat_url)
            
            logger.info(f"Found {len(product_urls)} products in {cat_name}")
            
            # Scrape each product
            for prod_idx, product_url in enumerate(product_urls):
                if limit and len(all_products) >= limit:
                    logger.info(f"Reached limit of {limit} products")
                    return all_products
                
                if progress_callback:
                    await progress_callback({
                        "stage": "products",
                        "current": prod_idx + 1,
                        "total": len(product_urls),
                        "product": product_url.split('/')[-1]
                    })
                
                product = await self.get_product_details(product_url)
                if product:
                    product['category'] = cat_name
                    all_products.append(product)
                    logger.info(f"Scraped: {product.get('name')}")
                
                # Rate limiting - be respectful
                await asyncio.sleep(0.5)
            
            # Pause between categories
            await asyncio.sleep(1)
        
        logger.info(f"Total products scraped: {len(all_products)}")
        return all_products


async def run_wix_import(limit: int = None) -> List[Dict]:
    """
    Run the Wix import (no credentials needed for public site)
    
    Args:
        limit: Maximum number of products to import (None for all)
    
    Returns:
        List of imported products
    """
    async with TileStationWixImporter(
        base_url="https://www.tilestation.co.uk"
    ) as importer:
        
        connected = await importer.login()
        if not connected:
            return []
        
        products = await importer.import_all_products(limit=limit)
        return products


# For testing
if __name__ == "__main__":
    import sys
    
    async def test_import():
        email = sys.argv[1] if len(sys.argv) > 1 else "test@example.com"
        password = sys.argv[2] if len(sys.argv) > 2 else "password"
        
        products = await run_splendour_import(email, password, limit=5)
        print(f"\nImported {len(products)} products")
        for p in products:
            print(f"  - {p.get('name')} ({p.get('sku')}): £{p.get('cost_price')}")
    
    asyncio.run(test_import())

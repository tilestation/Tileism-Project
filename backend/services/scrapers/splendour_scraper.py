"""
Splendour Tiles Scraper
Scrapes products, images, prices, and stock levels from splendourtiles.co.uk
Products are organized in ranges, stock info is on individual product pages.
IMPORTANT: Products can appear in multiple categories - we track all categories.
"""
import asyncio
import os
import re
import json
from typing import Dict, List, Optional, Set
import logging

# Optional Playwright import - may not be available on all deployments
try:
    from playwright.async_api import async_playwright, Page, Browser
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False
    async_playwright = None
    Page = None
    Browser = None

from .base_scraper import BaseScraper, SupplierProduct

logger = logging.getLogger(__name__)


class SplendourScraper(BaseScraper):
    """Scraper for Splendour Tiles B2B portal"""
    
    SUPPLIER_NAME = "Splendour"
    BASE_URL = "https://www.splendourtiles.co.uk"
    LOGIN_URL = "https://www.splendourtiles.co.uk/customer/account/login"
    
    # ALL categories to scrape - verified URLs from actual website
    CATEGORIES = {
        "wall-tiles": {"url": "/wall-tiles", "type": "ranges"},
        "floor-tiles": {"url": "/floor-tiles", "type": "ranges"},
        "new-collections": {"url": "/new-collections", "type": "ranges"},
        "clearance": {"url": "/clearance", "type": "products"},  # Direct product links
        "essentials": {"url": "/essentials", "type": "ranges"},
    }
    
    def __init__(self, email: str, password: str):
        super().__init__(email, password)
        self.browser: Optional[Browser] = None
        self.page: Optional[Page] = None
        self.playwright = None
        # Track products by SKU to handle duplicates across categories
        self.products_by_sku: Dict[str, SupplierProduct] = {}
        self.products_by_url: Dict[str, SupplierProduct] = {}
    
    async def _init_browser(self):
        """Initialize Playwright browser"""
        if not PLAYWRIGHT_AVAILABLE:
            raise ImportError("Playwright is not installed. Please install it with: pip install playwright && playwright install chromium")
        self.playwright = await async_playwright().start()
        self.browser = await self.playwright.chromium.launch(headless=True)
        context = await self.browser.new_context(
            viewport={'width': 1920, 'height': 1080},
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        )
        self.page = await context.new_page()
    
    async def _close_browser(self):
        """Close browser"""
        if self.browser:
            await self.browser.close()
        if self.playwright:
            await self.playwright.stop()
    
    async def login(self) -> bool:
        """Login to Splendour portal"""
        try:
            if not self.page:
                await self._init_browser()
            
            logger.info("Navigating to login page...")
            await self.page.goto(self.LOGIN_URL, timeout=60000)
            await self.page.wait_for_load_state("networkidle")
            await asyncio.sleep(2)
            
            # Fill login form
            logger.info(f"Logging in as {self.email}...")
            await self.page.fill('input[name="email"]', self.email)
            await self.page.fill('input[name="password"]', self.password)
            await self.page.click('button:has-text("Login")')
            await asyncio.sleep(3)
            
            # Handle "Ok" popup if present (indicates successful login)
            try:
                ok_btn = await self.page.query_selector('button:has-text("Ok")')
                if ok_btn and await ok_btn.is_visible():
                    await ok_btn.click()
                    await asyncio.sleep(1)
                    self.is_authenticated = True
                    logger.info("Successfully logged in to Splendour (popup confirmed)")
                    return True
            except Exception:
                pass
            
            # Alternative check - if redirected away from login page
            if "login" not in self.page.url.lower():
                self.is_authenticated = True
                logger.info("Successfully logged in to Splendour")
                return True
            
            # Check body text for logged in indicators
            body = await self.page.inner_text('body')
            if "logged in" in body.lower() or "account" in body.lower():
                self.is_authenticated = True
                logger.info("Successfully logged in to Splendour")
                return True
            
            logger.error("Failed to login to Splendour")
            return False
            
        except Exception as e:
            logger.error(f"Splendour login error: {e}")
            return False
    
    async def get_all_products(self) -> List[SupplierProduct]:
        """Fetch ALL products from ALL Splendour categories"""
        if not self.is_authenticated:
            if not await self.login():
                return []
        
        try:
            # Process each category
            for cat_name, cat_info in self.CATEGORIES.items():
                logger.info(f"\n{'='*60}")
                logger.info(f"SCRAPING CATEGORY: {cat_name.upper()}")
                logger.info(f"{'='*60}")
                
                if cat_info["type"] == "ranges":
                    await self._scrape_category_with_ranges(cat_name, cat_info["url"])
                else:
                    await self._scrape_category_direct_products(cat_name, cat_info["url"])
                
                logger.info(f"Category {cat_name} complete. Total unique products so far: {len(self.products_by_sku) + len(self.products_by_url)}")
                await asyncio.sleep(1)
            
            # Combine products - prefer products with SKU
            all_products = list(self.products_by_sku.values())
            # Add products without SKU (using URL as key)
            for url, product in self.products_by_url.items():
                if not product.supplier_code:
                    all_products.append(product)
            
            self.products = all_products
            logger.info(f"\n{'='*60}")
            logger.info(f"SCRAPING COMPLETE")
            logger.info(f"Total unique products: {len(all_products)}")
            logger.info(f"{'='*60}")
            
            return all_products
            
        except Exception as e:
            logger.error(f"Error fetching Splendour products: {e}")
            import traceback
            traceback.print_exc()
            return list(self.products_by_sku.values()) + [p for p in self.products_by_url.values() if not p.supplier_code]
        finally:
            await self._close_browser()
    
    async def _scrape_category_with_ranges(self, category_name: str, category_path: str):
        """Scrape a category that has range pages (wall-tiles, floor-tiles, etc.)"""
        category_url = f"{self.BASE_URL}{category_path}"
        
        # Get ALL ranges by clicking "Load Next" repeatedly
        range_urls = await self._get_all_ranges_from_category(category_url, category_path)
        logger.info(f"Found {len(range_urls)} ranges in {category_name}")
        
        # Scrape each range
        for i, range_url in enumerate(range_urls):
            try:
                full_url = f"{self.BASE_URL}{range_url}" if not range_url.startswith('http') else range_url
                logger.info(f"[{i+1}/{len(range_urls)}] Scraping range: {range_url}")
                await self._scrape_range(full_url, category_name)
                await asyncio.sleep(0.3)
            except Exception as e:
                logger.error(f"Error scraping range {range_url}: {e}")
                continue
    
    async def _scrape_category_direct_products(self, category_name: str, category_path: str):
        """Scrape a category that has direct product links (clearance)"""
        category_url = f"{self.BASE_URL}{category_path}"
        
        # Get ALL product URLs by clicking "Load Next" repeatedly
        product_urls = await self._get_all_products_from_category(category_url)
        logger.info(f"Found {len(product_urls)} direct products in {category_name}")
        
        # Scrape each product
        for i, product_url in enumerate(product_urls):
            try:
                full_url = f"{self.BASE_URL}{product_url}" if not product_url.startswith('http') else product_url
                logger.info(f"[{i+1}/{len(product_urls)}] Scraping product: {product_url}")
                await self._scrape_and_store_product(full_url, category_name)
                await asyncio.sleep(0.3)
            except Exception as e:
                logger.error(f"Error scraping product {product_url}: {e}")
                continue
    
    async def _get_all_ranges_from_category(self, category_url: str, category_path: str) -> List[str]:
        """
        Get ALL range URLs from a category by clicking 'Load Next' until all are loaded.
        """
        await self.page.goto(category_url, timeout=60000)
        await self.page.wait_for_load_state("networkidle")
        await asyncio.sleep(3)
        
        all_ranges = set()
        clicks = 0
        max_clicks = 30  # Safety limit
        
        while clicks < max_clicks:
            # Get current ranges from page
            html = await self.page.content()
            
            # Match range URLs like /wall-tiles/alaska, /floor-tiles/azuma
            pattern = rf'href="({category_path}/[a-z0-9-]+)"'
            ranges = re.findall(pattern, html)
            
            prev_count = len(all_ranges)
            all_ranges.update(ranges)
            
            logger.info(f"Category {category_path}: {len(all_ranges)} ranges loaded (click {clicks})")
            
            # If no new ranges found, we might be done
            if len(all_ranges) == prev_count and clicks > 0:
                # Double check by trying to click again
                pass
            
            # Try to click "Load Next" button
            load_btn = await self.page.query_selector('button:has-text("LOAD NEXT")')
            if load_btn:
                try:
                    is_visible = await load_btn.is_visible()
                    if is_visible:
                        await load_btn.click()
                        await asyncio.sleep(2)
                        clicks += 1
                    else:
                        logger.info("Load Next button not visible - all ranges loaded")
                        break
                except Exception as e:
                    logger.info(f"Could not click Load Next: {e}")
                    break
            else:
                logger.info("No Load Next button found - all ranges loaded")
                break
        
        return list(all_ranges)
    
    async def _get_all_products_from_category(self, category_url: str) -> List[str]:
        """
        Get ALL product URLs from a category (for clearance-type categories).
        """
        await self.page.goto(category_url, timeout=60000)
        await self.page.wait_for_load_state("networkidle")
        await asyncio.sleep(3)
        
        all_products = set()
        clicks = 0
        max_clicks = 30
        
        while clicks < max_clicks:
            html = await self.page.content()
            
            # Match product URLs - they usually contain size info like 60x60, 300x600
            # Or have specific patterns
            product_pattern = r'href="(/[a-z0-9-]+-\d+[a-z0-9-]*)"'
            products = re.findall(product_pattern, html)
            
            # Also try to match href patterns that look like product pages
            alt_pattern = r'href="(/[a-z0-9-]+)"(?=[^/])'
            alt_products = re.findall(alt_pattern, html)
            
            # Filter out category links
            categories = ['/wall-tiles', '/floor-tiles', '/clearance', '/new-collections', 
                         '/essentials', '/outdoor', '/customer', '/i/', '/checkout']
            
            for p in products + alt_products:
                # Skip if it's a category or system page
                is_category = any(p.startswith(cat) or cat in p for cat in categories)
                if not is_category and len(p) > 5:
                    all_products.add(p)
            
            prev_count = len(all_products)
            logger.info(f"Found {len(all_products)} products so far (click {clicks})")
            
            # Try to click "Load Next" button
            load_btn = await self.page.query_selector('button:has-text("LOAD NEXT")')
            if load_btn:
                try:
                    is_visible = await load_btn.is_visible()
                    if is_visible:
                        await load_btn.click()
                        await asyncio.sleep(2)
                        clicks += 1
                    else:
                        break
                except Exception:
                    break
            else:
                break
        
        return list(all_products)
    
    async def _scrape_range(self, range_url: str, category_name: str):
        """Scrape all products from a range page"""
        await self.page.goto(range_url, timeout=60000)
        await self.page.wait_for_load_state("networkidle")
        await asyncio.sleep(2)
        
        # Get product URLs from the range page
        html = await self.page.content()
        
        # Products often have size in URL like -60x60, -300x600, etc.
        product_pattern = r'href="([^"]*-\d+x\d+[^"]*)"'
        product_urls = list(set(re.findall(product_pattern, html)))
        
        # Also try matching by product page patterns
        alt_pattern = r'href="(/[a-z0-9-]+-[a-z0-9-]+)"'
        alt_urls = re.findall(alt_pattern, html)
        
        for url in alt_urls:
            if 'x' in url and url not in product_urls:
                product_urls.append(url)
        
        logger.debug(f"Found {len(product_urls)} products in range {range_url}")
        
        # Scrape each product
        for product_url in product_urls:
            try:
                if not product_url.startswith('http'):
                    product_url = self.BASE_URL + product_url
                
                await self._scrape_and_store_product(product_url, category_name)
                await asyncio.sleep(0.3)
            except Exception as e:
                logger.error(f"Error scraping product {product_url}: {e}")
                continue
    
    async def _scrape_and_store_product(self, url: str, category_name: str):
        """Scrape a product and store it, handling duplicates by merging categories"""
        try:
            await self.page.goto(url, timeout=30000)
            await self.page.wait_for_load_state("networkidle")
            await asyncio.sleep(1)
            
            body_text = await self.page.inner_text('body')
            
            # Extract SKU first to check for duplicates
            sku_match = re.search(r'SKU[:\s]*(\d+)', body_text)
            sku = sku_match.group(1) if sku_match else ""
            
            # Check if we already have this product
            existing_product = None
            if sku and sku in self.products_by_sku:
                existing_product = self.products_by_sku[sku]
            elif url in self.products_by_url:
                existing_product = self.products_by_url[url]
            
            if existing_product:
                # Add this category to existing product's categories
                if category_name not in existing_product.category:
                    if existing_product.category:
                        existing_product.category += f", {category_name}"
                    else:
                        existing_product.category = category_name
                logger.debug(f"Updated categories for existing product {sku or url}: {existing_product.category}")
                return
            
            # Extract product name from page title or heading
            h1 = await self.page.query_selector('h1')
            name = ""
            if h1:
                name = await h1.inner_text()
            if not name:
                name_match = re.search(r'^([A-Za-z0-9\s]+\d+x\d+)', body_text, re.M)
                name = name_match.group(1) if name_match else ""
            
            # Skip if no name found
            if not name.strip():
                logger.debug(f"Skipping product with no name: {url}")
                return
            
            # Extract stock (e.g., "90 SQM in Stock")
            stock_match = re.search(r'(\d+(?:\.\d+)?)\s*SQM\s*[iI]n\s*[sS]tock', body_text)
            stock_sqm = float(stock_match.group(1)) if stock_match else 0
            
            # Extract price per SQM
            price_match = re.search(r'£\s*([\d.]+)\s*/\s*SQM', body_text, re.I)
            room_lot_price = float(price_match.group(1)) if price_match else 0
            
            # Extract pallet rate
            pallet_match = re.search(r'PALLET RATE[:\s]*£\s*([\d.]+)', body_text, re.I)
            pallet_price = float(pallet_match.group(1)) if pallet_match else 0
            
            # Extract size from body or name
            size_match = re.search(r'Size[:\s]*(\d+)x(\d+)', body_text, re.I)
            if not size_match:
                size_match = re.search(r'(\d+)x(\d+)', name)
            size = f"{size_match.group(1)}x{size_match.group(2)}" if size_match else ""
            
            # Extract thickness
            thickness_match = re.search(r'Thickness[^:]*[:\s]*(\d+)\s*mm', body_text, re.I)
            thickness = f"{thickness_match.group(1)}mm" if thickness_match else ""
            
            # Extract material
            material_match = re.search(r'Material Type[:\s]*([A-Za-z]+)', body_text, re.I)
            material = material_match.group(1) if material_match else "Porcelain"
            
            # Extract finish
            finish_match = re.search(r'Finish[:\s]*([A-Za-z]+)', body_text, re.I)
            finish = finish_match.group(1) if finish_match else ""
            
            # Extract images
            images = []
            img_elements = await self.page.query_selector_all('img[src*="tiles"], img[src*="product"], img[src*="catalog"]')
            for img in img_elements[:5]:
                src = await img.get_attribute('src')
                if src and 'logo' not in src.lower() and 'icon' not in src.lower():
                    if not src.startswith('http'):
                        src = self.BASE_URL + src
                    images.append(src)
            
            # Extract additional specs
            tiles_per_sqm = 0
            tiles_match = re.search(r'Tiles Per SQM[:\s]*([\d.]+)', body_text, re.I)
            if tiles_match:
                tiles_per_sqm = float(tiles_match.group(1))
            
            boxes_per_pallet = 0
            boxes_match = re.search(r'Boxes Per Pallet[:\s]*(\d+)', body_text, re.I)
            if boxes_match:
                boxes_per_pallet = int(boxes_match.group(1))
            
            product = SupplierProduct(
                supplier_code=sku,
                supplier_name=self.SUPPLIER_NAME,
                name=name.strip(),
                size=size,
                material=material,
                finish=finish,
                thickness=thickness,
                room_lot_price=room_lot_price,
                pallet_price=pallet_price,
                stock_sqm=stock_sqm,
                stock_status="In Stock" if stock_sqm >= 20 else ("Low Stock" if stock_sqm > 0 else "Out of Stock"),
                images=images,
                pieces_per_sqm=tiles_per_sqm,
                boxes_per_pallet=boxes_per_pallet,
                category=category_name,
                extra_data={"url": url}
            )
            
            # Store product
            if sku:
                self.products_by_sku[sku] = product
            else:
                self.products_by_url[url] = product
            
            logger.info(f"Scraped: {name} ({sku}) - Category: {category_name} - Stock: {stock_sqm}m², Price: £{room_lot_price}/sqm")
            
        except Exception as e:
            logger.error(f"Error scraping product from {url}: {e}")
    
    async def get_product_details(self, product_id: str) -> Optional[SupplierProduct]:
        """Get detailed information for a single product by SKU"""
        pass
    
    async def get_stock_levels(self) -> Dict[str, float]:
        """Get current stock levels for all products"""
        stock_levels = {}
        for product in self.products:
            stock_levels[product.supplier_code] = product.stock_sqm
        return stock_levels


# Test function
async def test_splendour_scraper():
    """Test the Splendour scraper"""
    scraper = SplendourScraper(
        email="accounts@tilestation.co.uk",
        password=os.environ.get("SPLENDOUR_PORTAL_PASSWORD", "")
    )
    
    print("Testing Splendour scraper...")
    if await scraper.login():
        print("Login successful!")
        products = await scraper.get_all_products()
        print(f"Found {len(products)} products")
        
        # Count by category
        cat_counts = {}
        for p in products:
            for cat in p.category.split(", "):
                cat_counts[cat] = cat_counts.get(cat, 0) + 1
        
        print("\nProducts by category:")
        for cat, count in sorted(cat_counts.items()):
            print(f"  {cat}: {count}")
        
        print("\nSample products:")
        for p in products[:5]:
            print(f"\n{p.name}")
            print(f"  SKU: {p.supplier_code}")
            print(f"  Category: {p.category}")
            print(f"  Stock: {p.stock_sqm}m²")
            print(f"  Price: £{p.room_lot_price}/sqm")
    else:
        print("Login failed")


if __name__ == "__main__":
    asyncio.run(test_splendour_scraper())

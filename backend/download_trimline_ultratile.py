#!/usr/bin/env python3
"""
Download Trimline & Ultra Tile product images to Cloudflare R2.
Uses Shopify search API and web scraping to find product images.
"""
import asyncio
import aiohttp
import boto3
from botocore.config import Config
import os
import json
import logging
import re
from datetime import datetime, timezone
from pymongo import MongoClient
from PIL import Image
from io import BytesIO
from bs4 import BeautifulSoup
from urllib.parse import quote

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Load environment
env_file = '/app/backend/.env'
if os.path.exists(env_file):
    with open(env_file) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                os.environ[key] = value.strip('"').strip("'")

# R2 Configuration
R2_ACCOUNT_ID = os.environ.get('R2_ACCOUNT_ID')
R2_ACCESS_KEY_ID = os.environ.get('R2_ACCESS_KEY_ID')
R2_SECRET_ACCESS_KEY = os.environ.get('R2_SECRET_ACCESS_KEY')
R2_BUCKET_NAME = os.environ.get('R2_BUCKET_NAME', 'tilestation-images')
R2_PUBLIC_URL = os.environ.get('R2_PUBLIC_URL', 'https://images.tilestation.co.uk')

# Production MongoDB
PROD_MONGO = 'mongodb+srv://tilestation:Tile2026@cluster0.htgdzwj.mongodb.net/tile_station?appName=Cluster0'

# Website configs
TRIMLINE_BASE = 'https://shop.trimlinegroup.com'
ULTRATILE_BASE = 'https://www.instarmac.co.uk'

PROGRESS_FILE = '/app/trimline_ultratile_progress.json'


class SupplierImageDownloader:
    def __init__(self):
        self.r2_client = boto3.client(
            's3',
            endpoint_url=f'https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
            aws_access_key_id=R2_ACCESS_KEY_ID,
            aws_secret_access_key=R2_SECRET_ACCESS_KEY,
            config=Config(signature_version='s3v4')
        )
        self.db_client = MongoClient(PROD_MONGO)
        self.db = self.db_client['tile_station']
        self.progress = self._load_progress()
        
    def _load_progress(self):
        if os.path.exists(PROGRESS_FILE):
            try:
                with open(PROGRESS_FILE, 'r') as f:
                    return json.load(f)
            except Exception:
                pass
        return {
            'completed_skus': [],
            'failed_skus': [],
            'stats': {'uploaded': 0, 'failed': 0, 'skipped': 0}
        }
    
    def _save_progress(self):
        with open(PROGRESS_FILE, 'w') as f:
            json.dump(self.progress, f, indent=2)
    
    async def _search_trimline_product(self, session, product_name):
        """Search for product on Trimline website"""
        # Clean product name for search
        search_terms = product_name.lower()
        search_terms = re.sub(r'\d+mm', '', search_terms)  # Remove sizes
        search_terms = re.sub(r'\d+m', '', search_terms)
        search_terms = search_terms.replace('aluminium', '').replace('tile', '').replace('trim', '')
        search_terms = ' '.join(search_terms.split()[:3])  # First 3 words
        
        search_url = f"{TRIMLINE_BASE}/search?q={quote(search_terms)}&type=product"
        
        try:
            async with session.get(search_url, timeout=aiohttp.ClientTimeout(total=30)) as response:
                if response.status == 200:
                    html = await response.text()
                    # Find product images in search results
                    matches = re.findall(r'cdn/shop/(?:files|products)/[^"\s?]+\.(?:jpg|png|webp)', html)
                    if matches:
                        # Filter out logos and category images
                        product_images = [m for m in matches if 'Logo' not in m and 'Category' not in m and 'favicon' not in m]
                        if product_images:
                            return f"https://shop.trimlinegroup.com/{product_images[0]}"
        except Exception as e:
            logger.debug(f"Search error: {e}")
        return None
    
    async def _search_ultratile_product(self, session, product_name):
        """Search for product on Instarmac/Ultra Tile website"""
        search_terms = product_name.lower()
        # Extract key product terms
        if 'progrout' in search_terms.lower():
            search_terms = 'progrout'
        elif 'propave' in search_terms.lower():
            search_terms = 'propave'
        elif 'proclean' in search_terms.lower():
            search_terms = 'proclean'
        else:
            search_terms = ' '.join(product_name.split()[:2])
        
        search_url = f"{ULTRATILE_BASE}/products?search={quote(search_terms)}"
        
        try:
            async with session.get(search_url, timeout=aiohttp.ClientTimeout(total=30)) as response:
                if response.status == 200:
                    html = await response.text()
                    # Find product images
                    matches = re.findall(r'(?:src|data-src)="([^"]+ultra[^"]*\.(?:jpg|png|webp))"', html, re.I)
                    if matches:
                        return matches[0] if matches[0].startswith('http') else f"{ULTRATILE_BASE}{matches[0]}"
        except Exception as e:
            logger.debug(f"Search error: {e}")
        return None
    
    async def _download_image(self, session, url):
        """Download image from URL"""
        try:
            headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=30), headers=headers) as response:
                if response.status == 200:
                    return await response.read()
        except Exception as e:
            logger.debug(f"Download error: {e}")
        return None
    
    def _optimize_image(self, image_data):
        try:
            img = Image.open(BytesIO(image_data))
            if img.mode in ('RGBA', 'P'):
                img = img.convert('RGB')
            max_size = 800
            if max(img.size) > max_size:
                ratio = max_size / max(img.size)
                new_size = tuple(int(dim * ratio) for dim in img.size)
                img = img.resize(new_size, Image.Resampling.LANCZOS)
            output = BytesIO()
            img.save(output, format='JPEG', quality=85, optimize=True)
            return output.getvalue()
        except Exception:
            return image_data
    
    def _upload_to_r2(self, image_data, key):
        try:
            self.r2_client.put_object(
                Bucket=R2_BUCKET_NAME,
                Key=key,
                Body=image_data,
                ContentType='image/jpeg',
                CacheControl='public, max-age=31536000'
            )
            return f'{R2_PUBLIC_URL}/{key}'
        except Exception as e:
            logger.error(f'R2 upload failed: {e}')
            return None
    
    async def download_trimline_images(self):
        """Download all Trimline product images"""
        logger.info('=' * 60)
        logger.info('TRIMLINE IMAGE DOWNLOAD')
        logger.info('=' * 60)
        
        products = list(self.db.products.find(
            {'sku': {'$regex': '^TRI-', '$options': 'i'}},
            {'_id': 1, 'sku': 1, 'name': 1, 'images': 1}
        ))
        
        logger.info(f'Found {len(products)} Trimline products')
        
        products_to_process = [p for p in products if p['sku'] not in self.progress['completed_skus']]
        logger.info(f'Products to process: {len(products_to_process)}')
        
        async with aiohttp.ClientSession() as session:
            for i, product in enumerate(products_to_process):
                sku = product['sku']
                name = product['name']
                
                # Search for product image
                image_url = await self._search_trimline_product(session, name)
                
                if image_url:
                    image_data = await self._download_image(session, image_url)
                    
                    if image_data:
                        optimized = self._optimize_image(image_data)
                        r2_key = f'products/Trimline/{sku}.jpg'
                        r2_url = self._upload_to_r2(optimized, r2_key)
                        
                        if r2_url:
                            self.db.products.update_one(
                                {'_id': product['_id']},
                                {'$set': {
                                    'images': [r2_url],
                                    'images_source': 'shop.trimlinegroup.com',
                                    'images_updated_at': datetime.now(timezone.utc)
                                }}
                            )
                            self.progress['completed_skus'].append(sku)
                            self.progress['stats']['uploaded'] += 1
                            logger.info(f'[{i+1}/{len(products_to_process)}] ✓ {sku}')
                        else:
                            self.progress['failed_skus'].append(sku)
                            self.progress['stats']['failed'] += 1
                    else:
                        self.progress['failed_skus'].append(sku)
                        self.progress['stats']['failed'] += 1
                else:
                    self.progress['failed_skus'].append(sku)
                    self.progress['stats']['failed'] += 1
                    if (i+1) % 20 == 0:
                        logger.info(f'[{i+1}/{len(products_to_process)}] Progress: {self.progress["stats"]}')
                
                if (i + 1) % 20 == 0:
                    self._save_progress()
                
                await asyncio.sleep(0.5)  # Rate limiting
        
        self._save_progress()
        logger.info(f'TRIMLINE COMPLETE: {self.progress["stats"]}')
        return self.progress['stats']
    
    async def download_ultratile_images(self):
        """Download all Ultra Tile product images"""
        logger.info('=' * 60)
        logger.info('ULTRA TILE IMAGE DOWNLOAD')
        logger.info('=' * 60)
        
        products = list(self.db.products.find(
            {'sku': {'$regex': '^ULT-', '$options': 'i'}},
            {'_id': 1, 'sku': 1, 'name': 1, 'images': 1}
        ))
        
        logger.info(f'Found {len(products)} Ultra Tile products')
        
        products_to_process = [p for p in products if p['sku'] not in self.progress['completed_skus']]
        logger.info(f'Products to process: {len(products_to_process)}')
        
        async with aiohttp.ClientSession() as session:
            for i, product in enumerate(products_to_process):
                sku = product['sku']
                name = product['name']
                
                # Search for product image
                image_url = await self._search_ultratile_product(session, name)
                
                if image_url:
                    image_data = await self._download_image(session, image_url)
                    
                    if image_data:
                        optimized = self._optimize_image(image_data)
                        r2_key = f'products/UltraTile/{sku}.jpg'
                        r2_url = self._upload_to_r2(optimized, r2_key)
                        
                        if r2_url:
                            self.db.products.update_one(
                                {'_id': product['_id']},
                                {'$set': {
                                    'images': [r2_url],
                                    'images_source': 'instarmac.co.uk',
                                    'images_updated_at': datetime.now(timezone.utc)
                                }}
                            )
                            self.progress['completed_skus'].append(sku)
                            self.progress['stats']['uploaded'] += 1
                            logger.info(f'[{i+1}/{len(products_to_process)}] ✓ {sku}')
                        else:
                            self.progress['failed_skus'].append(sku)
                            self.progress['stats']['failed'] += 1
                    else:
                        self.progress['failed_skus'].append(sku)
                        self.progress['stats']['failed'] += 1
                else:
                    self.progress['failed_skus'].append(sku)
                    self.progress['stats']['failed'] += 1
                
                if (i + 1) % 10 == 0:
                    self._save_progress()
                    logger.info(f'Progress: {self.progress["stats"]}')
                
                await asyncio.sleep(0.5)
        
        self._save_progress()
        logger.info(f'ULTRA TILE COMPLETE: {self.progress["stats"]}')
        return self.progress['stats']


async def main():
    downloader = SupplierImageDownloader()
    
    # Download Trimline first
    await downloader.download_trimline_images()
    
    # Then Ultra Tile
    await downloader.download_ultratile_images()
    
    logger.info('=' * 60)
    logger.info('ALL DOWNLOADS COMPLETE')
    logger.info(f'Final stats: {downloader.progress["stats"]}')
    logger.info('=' * 60)


if __name__ == '__main__':
    asyncio.run(main())

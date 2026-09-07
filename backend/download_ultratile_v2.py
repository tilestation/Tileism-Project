#!/usr/bin/env python3
"""
Download Ultra Tile product images with proper name matching.
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

PROGRESS_FILE = '/app/ultratile_progress.json'


def scrape_all_ultratile_images():
    """Scrape all Ultra Tile images from Instarmac website"""
    import requests
    
    pages = [
        "https://www.instarmac.co.uk/products/ultratile/adhesives/",
        "https://www.instarmac.co.uk/products/ultratile/grouts-and-silicones/",
        "https://www.instarmac.co.uk/products/ultratile/levelling-compounds/",
        "https://www.instarmac.co.uk/products/ultratile/tile-stone-cleaning-range/",
        "https://www.instarmac.co.uk/products/ultratile/tiling-ancillaries/",
        "https://www.instarmac.co.uk/products/ultratile/external-tiling/",
    ]
    
    all_images = {}
    
    for page_url in pages:
        try:
            resp = requests.get(page_url, timeout=30)
            # Find all UT_ product images
            images = re.findall(r'https://www\.instarmac\.co\.uk/core/wp-content/uploads/[^\s"?]+\.(?:jpg|png)', resp.text)
            for img in images:
                # Extract product name from URL - look for UT_ pattern
                match = re.search(r'UT_([A-Za-z_]+?)(?:_\d|_web|-\d)', img)
                if match:
                    product_key = match.group(1).lower().replace('_', '')
                    if product_key not in all_images:
                        all_images[product_key] = img
        except Exception as e:
            logger.warning(f"Error scraping {page_url}: {e}")
    
    return all_images


def match_product_to_image(product_name, images_dict):
    """Try to match a product name to an image URL"""
    # Clean product name
    name_lower = product_name.lower()
    
    # Try various matching strategies
    # 1. Direct match
    clean_name = re.sub(r'[^a-z]', '', name_lower)
    if clean_name in images_dict:
        return images_dict[clean_name]
    
    # 2. Key product words
    keywords = ['progrout', 'proflex', 'propave', 'proclean', 'proprime', 'prosuper', 
                'prorapi', 'proaqua', 'progripfx', 'proeco', 'prossflex']
    
    for keyword in keywords:
        if keyword in name_lower:
            # Try to find matching image
            for img_key, img_url in images_dict.items():
                if keyword.replace('pro', '') in img_key:
                    return img_url
    
    # 3. Partial match - check if any product word exists in image keys
    words = re.findall(r'[a-z]+', name_lower)
    for word in words:
        if len(word) > 4:  # Skip short words
            for img_key, img_url in images_dict.items():
                if word in img_key:
                    return img_url
    
    return None


class UltraTileDownloader:
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
        return {'completed_skus': [], 'failed_skus': [], 'stats': {'uploaded': 0, 'failed': 0}}
    
    def _save_progress(self):
        with open(PROGRESS_FILE, 'w') as f:
            json.dump(self.progress, f, indent=2)
    
    async def _download_image(self, session, url):
        try:
            headers = {'User-Agent': 'Mozilla/5.0'}
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=30), headers=headers) as response:
                if response.status == 200:
                    return await response.read()
        except Exception:
            pass
        return None
    
    def _optimize_image(self, image_data):
        try:
            img = Image.open(BytesIO(image_data))
            if img.mode in ('RGBA', 'P'):
                img = img.convert('RGB')
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
    
    async def download_all(self):
        logger.info('=' * 60)
        logger.info('ULTRA TILE IMAGE DOWNLOAD')
        logger.info('=' * 60)
        
        # First, scrape all available images from website
        logger.info("Scraping Instarmac website for product images...")
        images_dict = scrape_all_ultratile_images()
        logger.info(f"Found {len(images_dict)} unique product images")
        
        # Get all Ultra Tile products
        products = list(self.db.products.find(
            {'sku': {'$regex': '^ULT-', '$options': 'i'}},
            {'_id': 1, 'sku': 1, 'name': 1}
        ))
        
        logger.info(f'Found {len(products)} Ultra Tile products')
        
        products_to_process = [p for p in products if p['sku'] not in self.progress['completed_skus']]
        logger.info(f'Products to process: {len(products_to_process)}')
        
        async with aiohttp.ClientSession() as session:
            for i, product in enumerate(products_to_process):
                sku = product['sku']
                name = product['name']
                
                # Try to match product to an image
                image_url = match_product_to_image(name, images_dict)
                
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
                            logger.info(f'[{i+1}/{len(products_to_process)}] ✓ {sku} - {name[:30]}')
                        else:
                            self.progress['failed_skus'].append(sku)
                            self.progress['stats']['failed'] += 1
                    else:
                        self.progress['failed_skus'].append(sku)
                        self.progress['stats']['failed'] += 1
                        logger.warning(f'[{i+1}/{len(products_to_process)}] ✗ {sku} - Download failed')
                else:
                    self.progress['failed_skus'].append(sku)
                    self.progress['stats']['failed'] += 1
                    logger.warning(f'[{i+1}/{len(products_to_process)}] ✗ {sku} - No matching image found for: {name[:40]}')
                
                if (i + 1) % 10 == 0:
                    self._save_progress()
        
        self._save_progress()
        logger.info('=' * 60)
        logger.info(f'ULTRA TILE COMPLETE: {self.progress["stats"]}')
        logger.info('=' * 60)
        
        return self.progress['stats']


async def main():
    downloader = UltraTileDownloader()
    await downloader.download_all()


if __name__ == '__main__':
    asyncio.run(main())

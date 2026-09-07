#!/usr/bin/env python3
"""
Download Tile Rite product images to Cloudflare R2.
Uses the URL pattern: https://www.tilerite.co.uk/images/product//303x182-{CODE}-1.jpg
"""
import asyncio
import aiohttp
import boto3
from botocore.config import Config
import os
import json
import logging
from datetime import datetime, timezone
from pymongo import MongoClient
from PIL import Image
from io import BytesIO

# Setup logging
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
                value = value.strip('"').strip("'")
                os.environ[key] = value

# R2 Configuration
R2_ACCOUNT_ID = os.environ.get('R2_ACCOUNT_ID')
R2_ACCESS_KEY_ID = os.environ.get('R2_ACCESS_KEY_ID')
R2_SECRET_ACCESS_KEY = os.environ.get('R2_SECRET_ACCESS_KEY')
R2_BUCKET_NAME = os.environ.get('R2_BUCKET_NAME', 'tilestation-images')
R2_PUBLIC_URL = os.environ.get('R2_PUBLIC_URL', 'https://images.tilestation.co.uk')

# Production MongoDB
PROD_MONGO = 'mongodb+srv://tilestation:Tile2026@cluster0.htgdzwj.mongodb.net/tile_station?appName=Cluster0'

# Tile Rite image URL pattern
TILERITE_IMAGE_BASE = 'https://www.tilerite.co.uk/images/product/'

# Progress tracking
PROGRESS_FILE = '/app/tilerite_image_progress.json'


class TileRiteImageDownloader:
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
    
    def _extract_code(self, sku):
        """Extract Tile Rite code from SKU like TIL-PRO930 -> PRO930"""
        if sku and sku.startswith('TIL-'):
            return sku[4:]  # Remove 'TIL-' prefix
        return sku
    
    def _get_image_url(self, code):
        """Build Tile Rite image URL from code"""
        # Try multiple image sizes/formats
        return f'{TILERITE_IMAGE_BASE}/303x182-{code}-1.jpg'
    
    def _get_r2_key(self, sku):
        """Generate R2 storage key"""
        return f'products/TileRite/{sku}.jpg'
    
    async def _download_image(self, session, url):
        """Download image from URL"""
        try:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=30)) as response:
                if response.status == 200:
                    return await response.read()
                else:
                    logger.debug(f'HTTP {response.status} for {url}')
                    return None
        except Exception as e:
            logger.debug(f'Download error for {url}: {e}')
            return None
    
    def _optimize_image(self, image_data):
        """Optimize image for web"""
        try:
            img = Image.open(BytesIO(image_data))
            if img.mode in ('RGBA', 'P'):
                img = img.convert('RGB')
            
            # Resize if too large
            max_size = 800
            if max(img.size) > max_size:
                ratio = max_size / max(img.size)
                new_size = tuple(int(dim * ratio) for dim in img.size)
                img = img.resize(new_size, Image.Resampling.LANCZOS)
            
            output = BytesIO()
            img.save(output, format='JPEG', quality=85, optimize=True)
            return output.getvalue()
        except Exception as e:
            logger.warning(f'Optimization failed: {e}')
            return image_data
    
    def _upload_to_r2(self, image_data, key):
        """Upload image to R2"""
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
            logger.error(f'R2 upload failed for {key}: {e}')
            return None
    
    async def download_all_images(self):
        """Download all Tile Rite images"""
        logger.info('=' * 60)
        logger.info('TILE RITE IMAGE DOWNLOAD')
        logger.info('=' * 60)
        
        # Get all Tile Rite products
        products = list(self.db.products.find(
            {'sku': {'$regex': '^TIL-', '$options': 'i'}},
            {'_id': 1, 'sku': 1, 'name': 1, 'images': 1}
        ))
        
        logger.info(f'Found {len(products)} Tile Rite products')
        
        # Filter out already completed
        products_to_process = [
            p for p in products 
            if p['sku'] not in self.progress['completed_skus']
        ]
        
        logger.info(f'Products to process: {len(products_to_process)}')
        logger.info(f'Already completed: {len(self.progress["completed_skus"])}')
        
        async with aiohttp.ClientSession() as session:
            for i, product in enumerate(products_to_process):
                sku = product['sku']
                code = self._extract_code(sku)
                
                if not code:
                    logger.warning(f'Could not extract code from SKU: {sku}')
                    continue
                
                # Build image URL
                image_url = self._get_image_url(code)
                
                # Download image
                image_data = await self._download_image(session, image_url)
                
                if image_data:
                    # Optimize
                    optimized = self._optimize_image(image_data)
                    
                    # Upload to R2
                    r2_key = self._get_r2_key(sku)
                    r2_url = self._upload_to_r2(optimized, r2_key)
                    
                    if r2_url:
                        # Update product in database
                        self.db.products.update_one(
                            {'_id': product['_id']},
                            {'$set': {
                                'images': [r2_url],
                                'images_source': 'tilerite.co.uk',
                                'images_updated_at': datetime.now(timezone.utc)
                            }}
                        )
                        
                        self.progress['completed_skus'].append(sku)
                        self.progress['stats']['uploaded'] += 1
                        logger.info(f'[{i+1}/{len(products_to_process)}] ✓ {sku}')
                    else:
                        self.progress['failed_skus'].append(sku)
                        self.progress['stats']['failed'] += 1
                        logger.warning(f'[{i+1}/{len(products_to_process)}] ✗ {sku} - R2 upload failed')
                else:
                    self.progress['failed_skus'].append(sku)
                    self.progress['stats']['failed'] += 1
                    logger.warning(f'[{i+1}/{len(products_to_process)}] ✗ {sku} - Download failed')
                
                # Save progress every 50 products
                if (i + 1) % 50 == 0:
                    self._save_progress()
                    logger.info(f'Progress saved: {self.progress["stats"]}')
        
        # Final save
        self._save_progress()
        
        logger.info('=' * 60)
        logger.info('TILE RITE DOWNLOAD COMPLETE')
        logger.info(f'Stats: {self.progress["stats"]}')
        logger.info('=' * 60)
        
        return self.progress['stats']


async def main():
    downloader = TileRiteImageDownloader()
    await downloader.download_all_images()


if __name__ == '__main__':
    asyncio.run(main())

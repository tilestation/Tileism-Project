"""
Cloudflare R2 Image Storage Service
Downloads images from supplier URLs and uploads to Cloudflare R2.
Supports:
- Batch downloading with progress tracking
- Resume capability for interrupted downloads
- Automatic retry on failures
- Image optimization before upload
"""
import asyncio
import aiohttp
import boto3
from botocore.config import Config
import os
import json
import hashlib
import logging
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple
from pathlib import Path
from pymongo import MongoClient
from PIL import Image
from io import BytesIO
import mimetypes

logger = logging.getLogger(__name__)

# R2 Configuration - loaded from environment
R2_ACCOUNT_ID = os.environ.get('R2_ACCOUNT_ID', '')
R2_ACCESS_KEY_ID = os.environ.get('R2_ACCESS_KEY_ID', '')
R2_SECRET_ACCESS_KEY = os.environ.get('R2_SECRET_ACCESS_KEY', '')
R2_BUCKET_NAME = os.environ.get('R2_BUCKET_NAME', 'tilestation-images')
R2_PUBLIC_URL = os.environ.get('R2_PUBLIC_URL', '')  # e.g., https://pub-xxxxx.r2.dev

# Progress tracking
PROGRESS_FILE = "/app/image_download_progress.json"
BATCH_SIZE = 20  # Download 20 images at a time
MAX_RETRIES = 3
TIMEOUT_SECONDS = 30


class R2StorageService:
    """Manages Cloudflare R2 storage operations"""
    
    def __init__(self):
        if not all([R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY]):
            logger.warning("R2 credentials not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY")
            self.client = None
            return
            
        self.client = boto3.client(
            's3',
            endpoint_url=f'https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
            aws_access_key_id=R2_ACCESS_KEY_ID,
            aws_secret_access_key=R2_SECRET_ACCESS_KEY,
            config=Config(
                signature_version='s3v4',
                retries={'max_attempts': 3}
            )
        )
        self.bucket = R2_BUCKET_NAME
    
    def is_configured(self) -> bool:
        """Check if R2 is properly configured"""
        return self.client is not None
    
    def upload_image(self, image_data: bytes, key: str, content_type: str = 'image/jpeg') -> Optional[str]:
        """
        Upload image to R2 and return public URL
        
        Args:
            image_data: Image bytes
            key: Object key (path in bucket)
            content_type: MIME type
            
        Returns:
            Public URL or None on failure
        """
        if not self.client:
            logger.error("R2 client not configured")
            return None
            
        try:
            self.client.put_object(
                Bucket=self.bucket,
                Key=key,
                Body=image_data,
                ContentType=content_type,
                CacheControl='public, max-age=31536000'  # Cache for 1 year
            )
            
            # Return public URL
            if R2_PUBLIC_URL:
                return f"{R2_PUBLIC_URL}/{key}"
            return f"https://{self.bucket}.{R2_ACCOUNT_ID}.r2.dev/{key}"
            
        except Exception as e:
            logger.error(f"Failed to upload {key}: {e}")
            return None
    
    def delete_image(self, key: str) -> bool:
        """Delete image from R2"""
        if not self.client:
            return False
            
        try:
            self.client.delete_object(Bucket=self.bucket, Key=key)
            return True
        except Exception as e:
            logger.error(f"Failed to delete {key}: {e}")
            return False
    
    def image_exists(self, key: str) -> bool:
        """Check if image exists in R2"""
        if not self.client:
            return False
            
        try:
            self.client.head_object(Bucket=self.bucket, Key=key)
            return True
        except Exception:
            return False


class ImageDownloadProgress:
    """Tracks image download progress for resume capability"""
    
    def __init__(self, progress_file: str = PROGRESS_FILE):
        self.progress_file = progress_file
        self.data = self._load()
    
    def _load(self) -> Dict:
        if os.path.exists(self.progress_file):
            try:
                with open(self.progress_file, 'r') as f:
                    return json.load(f)
            except Exception:
                pass
        return {
            "session_id": None,
            "started_at": None,
            "completed_images": [],
            "failed_images": [],
            "suppliers_completed": [],
            "stats": {
                "total_processed": 0,
                "total_uploaded": 0,
                "total_failed": 0,
                "total_skipped": 0
            }
        }
    
    def _save(self):
        try:
            with open(self.progress_file, 'w') as f:
                json.dump(self.data, f, indent=2, default=str)
        except Exception as e:
            logger.error(f"Failed to save progress: {e}")
    
    def start_session(self, session_id: str):
        self.data["session_id"] = session_id
        self.data["started_at"] = datetime.now(timezone.utc).isoformat()
        self._save()
    
    def mark_completed(self, image_url: str, r2_url: str):
        self.data["completed_images"].append({
            "original_url": image_url,
            "r2_url": r2_url,
            "timestamp": datetime.now(timezone.utc).isoformat()
        })
        self.data["stats"]["total_uploaded"] += 1
        self.data["stats"]["total_processed"] += 1
        self._save()
    
    def mark_failed(self, image_url: str, error: str):
        self.data["failed_images"].append({
            "url": image_url,
            "error": error,
            "timestamp": datetime.now(timezone.utc).isoformat()
        })
        self.data["stats"]["total_failed"] += 1
        self.data["stats"]["total_processed"] += 1
        self._save()
    
    def mark_skipped(self):
        self.data["stats"]["total_skipped"] += 1
        self.data["stats"]["total_processed"] += 1
        self._save()
    
    def is_completed(self, image_url: str) -> bool:
        return any(img["original_url"] == image_url for img in self.data["completed_images"])
    
    def complete_supplier(self, supplier: str):
        if supplier not in self.data["suppliers_completed"]:
            self.data["suppliers_completed"].append(supplier)
            self._save()
    
    def is_supplier_completed(self, supplier: str) -> bool:
        return supplier in self.data["suppliers_completed"]
    
    def get_stats(self) -> Dict:
        return self.data["stats"]


class ImageDownloadService:
    """
    Downloads images from supplier URLs and uploads to R2.
    Handles batch processing with progress tracking.
    """
    
    def __init__(self, db_url: str = None, db_name: str = None):
        self.db_url = db_url or os.environ.get('MONGO_URL', 'mongodb://localhost:27017')
        self.db_name = db_name or 'tile_station'
        self.r2 = R2StorageService()
        self.progress = ImageDownloadProgress()
    
    def _get_db(self):
        client = MongoClient(self.db_url)
        return client[self.db_name]
    
    def _generate_key(self, supplier: str, product_code: str, image_index: int, url: str) -> str:
        """Generate a unique key for the image in R2"""
        # Get file extension from URL
        ext = Path(url.split('?')[0]).suffix.lower()
        if ext not in ['.jpg', '.jpeg', '.png', '.webp', '.gif']:
            ext = '.jpg'
        
        # Create a clean filename
        clean_code = product_code.replace('/', '_').replace(' ', '_')
        return f"products/{supplier}/{clean_code}_{image_index}{ext}"
    
    async def _download_image(self, session: aiohttp.ClientSession, url: str) -> Optional[Tuple[bytes, str]]:
        """Download image from URL with retry logic"""
        for attempt in range(MAX_RETRIES):
            try:
                async with session.get(url, timeout=aiohttp.ClientTimeout(total=TIMEOUT_SECONDS)) as response:
                    if response.status == 200:
                        content = await response.read()
                        content_type = response.headers.get('Content-Type', 'image/jpeg')
                        return content, content_type
                    else:
                        logger.warning(f"Failed to download {url}: HTTP {response.status}")
            except asyncio.TimeoutError:
                logger.warning(f"Timeout downloading {url} (attempt {attempt + 1})")
            except Exception as e:
                logger.warning(f"Error downloading {url}: {e} (attempt {attempt + 1})")
            
            if attempt < MAX_RETRIES - 1:
                await asyncio.sleep(1 * (attempt + 1))  # Exponential backoff
        
        return None
    
    def _optimize_image(self, image_data: bytes, max_size: int = 1200) -> bytes:
        """Optimize image for web (resize if too large, compress)"""
        try:
            img = Image.open(BytesIO(image_data))
            
            # Convert to RGB if necessary (for PNG with transparency)
            if img.mode in ('RGBA', 'P'):
                img = img.convert('RGB')
            
            # Resize if larger than max_size
            if max(img.size) > max_size:
                ratio = max_size / max(img.size)
                new_size = tuple(int(dim * ratio) for dim in img.size)
                img = img.resize(new_size, Image.Resampling.LANCZOS)
            
            # Save with compression
            output = BytesIO()
            img.save(output, format='JPEG', quality=85, optimize=True)
            return output.getvalue()
            
        except Exception as e:
            logger.warning(f"Failed to optimize image: {e}")
            return image_data
    
    async def download_all_images(self, suppliers: List[str] = None) -> Dict:
        """
        Download all images from specified suppliers.
        
        Args:
            suppliers: List of supplier names. If None, downloads from all.
            
        Returns:
            Summary of download operation
        """
        if not self.r2.is_configured():
            return {
                "success": False,
                "error": "R2 storage not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_PUBLIC_URL"
            }
        
        session_id = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        self.progress.start_session(session_id)
        
        logger.info("=" * 60)
        logger.info(f"STARTING IMAGE DOWNLOAD - Session: {session_id}")
        logger.info("=" * 60)
        
        db = self._get_db()
        
        # Get suppliers to process
        if suppliers is None:
            suppliers = db.supplier_products.distinct("supplier_name")
        
        total_uploaded = 0
        total_failed = 0
        total_skipped = 0
        
        async with aiohttp.ClientSession() as session:
            for supplier in suppliers:
                if self.progress.is_supplier_completed(supplier):
                    logger.info(f"Skipping {supplier} - already completed")
                    continue
                
                logger.info(f"\nProcessing {supplier}...")
                
                # Get all products with images
                products = list(db.supplier_products.find(
                    {"supplier_name": supplier, "images": {"$exists": True, "$ne": []}},
                    {"supplier_code": 1, "images": 1, "_id": 1}
                ))
                
                logger.info(f"Found {len(products)} products with images")
                
                for product in products:
                    product_code = product.get("supplier_code", "unknown")
                    images = product.get("images", [])
                    new_image_urls = []
                    
                    for idx, url in enumerate(images):
                        if not url or not url.startswith('http'):
                            continue
                        
                        # Skip if already processed
                        if self.progress.is_completed(url):
                            # Find the R2 URL from progress
                            for completed in self.progress.data["completed_images"]:
                                if completed["original_url"] == url:
                                    new_image_urls.append(completed["r2_url"])
                                    break
                            total_skipped += 1
                            continue
                        
                        # Download image
                        result = await self._download_image(session, url)
                        
                        if result:
                            image_data, content_type = result
                            
                            # Optimize image
                            optimized_data = self._optimize_image(image_data)
                            
                            # Generate R2 key
                            key = self._generate_key(supplier, product_code, idx, url)
                            
                            # Upload to R2
                            r2_url = self.r2.upload_image(optimized_data, key, 'image/jpeg')
                            
                            if r2_url:
                                new_image_urls.append(r2_url)
                                self.progress.mark_completed(url, r2_url)
                                total_uploaded += 1
                                logger.debug(f"Uploaded: {key}")
                            else:
                                new_image_urls.append(url)  # Keep original on failure
                                self.progress.mark_failed(url, "Upload failed")
                                total_failed += 1
                        else:
                            new_image_urls.append(url)  # Keep original on failure
                            self.progress.mark_failed(url, "Download failed")
                            total_failed += 1
                    
                    # Update product with new image URLs
                    if new_image_urls and new_image_urls != images:
                        db.supplier_products.update_one(
                            {"_id": product["_id"]},
                            {"$set": {
                                "images": new_image_urls,
                                "images_migrated": True,
                                "images_migrated_at": datetime.now(timezone.utc)
                            }}
                        )
                
                self.progress.complete_supplier(supplier)
                logger.info(f"Completed {supplier}")
        
        summary = {
            "success": True,
            "session_id": session_id,
            "stats": {
                "total_uploaded": total_uploaded,
                "total_failed": total_failed,
                "total_skipped": total_skipped
            }
        }
        
        logger.info("=" * 60)
        logger.info(f"DOWNLOAD COMPLETE: {summary}")
        logger.info("=" * 60)
        
        return summary


async def run_image_download():
    """Entry point for image download script"""
    logging.basicConfig(level=logging.INFO)
    service = ImageDownloadService()
    return await service.download_all_images()


if __name__ == "__main__":
    asyncio.run(run_image_download())

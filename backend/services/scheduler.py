"""
Import Scheduler Service
Handles scheduled automatic product imports from supplier portals.
All imported images are automatically uploaded to Cloudflare R2.
"""
import os
import asyncio
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Any
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger
from apscheduler.jobstores.memory import MemoryJobStore
from motor.motor_asyncio import AsyncIOMotorClient

from services.product_importer import SplendourTilesImporter
from config import get_db

# Import R2 uploader for automatic image upload
try:
    from services.storage.r2_uploader import process_product_images_for_deep_sync, R2ImageUploader
    R2_AVAILABLE = R2ImageUploader.is_configured()
except ImportError:
    R2_AVAILABLE = False
    process_product_images_for_deep_sync = None

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Global scheduler instance
scheduler: Optional[AsyncIOScheduler] = None

# Track scheduled job results
scheduled_job_history: Dict[str, Any] = {}

# Track series description regeneration history
description_regeneration_history: list = []


async def check_and_regenerate_series_descriptions():
    """
    Background job that checks for series with new products added since last description generation.
    Auto-regenerates descriptions for series that are configured for auto-update.
    """
    logger.info("Starting series description auto-regeneration check...")
    
    try:
        db = get_db()
        
        # Get auto-regeneration settings
        settings = await db.description_regen_settings.find_one({"_id": "global"})
        if not settings or not settings.get("enabled", False):
            logger.info("Series description auto-regeneration is disabled")
            return
        
        # Get all series that are tracked for auto-regeneration
        tracked_series = await db.series_description_tracking.find({
            "auto_regenerate": True
        }).to_list(500)
        
        if not tracked_series:
            logger.info("No series configured for auto-regeneration")
            return
        
        regenerated_count = 0
        
        for series_info in tracked_series:
            series_name = series_info.get("series_name")
            last_generated = series_info.get("last_generated")
            
            if not series_name:
                continue
            
            # Check if there are new products in this series since last generation
            query = {
                "$or": [
                    {"product_name": {"$regex": f"^{series_name}", "$options": "i"}},
                    {"name": {"$regex": f"^{series_name}", "$options": "i"}},
                    {"series": {"$regex": f"^{series_name}", "$options": "i"}}
                ]
            }
            
            if last_generated:
                # Find products created or updated after last generation
                query["$or"] = [
                    {"created_at": {"$gt": last_generated}},
                    {"updated_at": {"$gt": last_generated}},
                    {"last_imported": {"$gt": last_generated}}
                ]
                
                # Also check if the series has products newer than last generation
                new_products_count = await db.supplier_products.count_documents({
                    "$and": [
                        {"$or": [
                            {"product_name": {"$regex": f"^{series_name}", "$options": "i"}},
                            {"name": {"$regex": f"^{series_name}", "$options": "i"}},
                            {"series": {"$regex": f"^{series_name}", "$options": "i"}}
                        ]},
                        {"$or": [
                            {"created_at": {"$gt": last_generated}},
                            {"updated_at": {"$gt": last_generated}},
                            {"last_imported": {"$gt": last_generated}}
                        ]}
                    ]
                })
                
                if new_products_count == 0:
                    continue  # No new products, skip regeneration
            
            # Regenerate description for this series
            logger.info(f"Auto-regenerating description for series: {series_name}")
            
            try:
                description = await generate_series_description_internal(
                    series_name=series_name,
                    length=settings.get("default_length", "standard"),
                    seo_keywords=settings.get("default_seo_keywords", "")
                )
                
                if description:
                    # Update tracking record
                    await db.series_description_tracking.update_one(
                        {"series_name": series_name},
                        {"$set": {
                            "last_generated": datetime.now(timezone.utc).isoformat(),
                            "last_description": description,
                            "auto_regenerated_count": series_info.get("auto_regenerated_count", 0) + 1
                        }}
                    )
                    
                    # Log to history
                    description_regeneration_history.append({
                        "series_name": series_name,
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "status": "success",
                        "description_preview": description[:200] + "..." if len(description) > 200 else description
                    })
                    
                    regenerated_count += 1
                    logger.info(f"Successfully regenerated description for {series_name}")
                    
            except Exception as gen_err:
                logger.error(f"Failed to regenerate description for {series_name}: {gen_err}")
                description_regeneration_history.append({
                    "series_name": series_name,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "status": "failed",
                    "error": str(gen_err)
                })
        
        # Keep only last 100 history entries
        if len(description_regeneration_history) > 100:
            description_regeneration_history[:] = description_regeneration_history[-100:]
        
        # Update last run in settings
        await db.description_regen_settings.update_one(
            {"_id": "global"},
            {"$set": {
                "last_run": datetime.now(timezone.utc).isoformat(),
                "last_run_regenerated": regenerated_count
            }},
            upsert=True
        )
        
        logger.info(f"Series description auto-regeneration complete. Regenerated: {regenerated_count}")
        
    except Exception as e:
        logger.error(f"Series description auto-regeneration failed: {e}")


async def generate_series_description_internal(series_name: str, length: str = "standard", seo_keywords: str = ""):
    """
    Internal function to generate a series description.
    Used by the scheduler for auto-regeneration.
    """
    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage
        import uuid as uuid_module
        import re
        
        api_key = os.environ.get('EMERGENT_LLM_KEY') or os.environ.get('OPENAI_API_KEY')
        if not api_key:
            raise Exception("API key not configured")
        
        db = get_db()
        
        # Query products for this series
        query = {
            "$or": [
                {"product_name": {"$regex": f"^{re.escape(series_name)}", "$options": "i"}},
                {"name": {"$regex": f"^{re.escape(series_name)}", "$options": "i"}},
                {"series": {"$regex": f"^{re.escape(series_name)}", "$options": "i"}}
            ]
        }
        
        products = await db.supplier_products.find(query).to_list(500)
        if not products:
            products = await db.tiles.find(query).to_list(500)
        
        if not products:
            return None
        
        # Aggregate attributes
        all_colors = set()
        all_sizes = set()
        all_finishes = set()
        all_materials = set()
        
        for p in products:
            color = p.get('color') or p.get('attributes', {}).get('color', '')
            if color:
                all_colors.add(color)
            size = p.get('size') or p.get('attributes', {}).get('size', '')
            if size:
                all_sizes.add(size)
            finish = p.get('finish') or p.get('attributes', {}).get('finish', '')
            if finish:
                all_finishes.add(finish)
            material = p.get('material') or p.get('attributes', {}).get('material', '')
            if material:
                all_materials.add(material)
        
        # Build details
        details_parts = []
        if all_colors:
            details_parts.append(f"Colors: {', '.join(sorted(all_colors))}")
        if all_sizes:
            details_parts.append(f"Sizes: {', '.join(sorted(all_sizes))}")
        if all_finishes:
            details_parts.append(f"Finishes: {', '.join(sorted(all_finishes))}")
        if all_materials:
            details_parts.append(f"Material: {', '.join(sorted(all_materials))}")
        
        details_text = '\n'.join(details_parts) if details_parts else 'Premium tile collection'
        
        # Length instruction
        if length == 'brief':
            length_instruction = "Write 1-2 paragraphs (80-120 words)."
        elif length == 'detailed':
            length_instruction = "Write 4-5 paragraphs (300-400 words)."
        else:
            length_instruction = "Write 2-3 paragraphs (150-250 words)."
        
        prompt = f"""Write a unified product collection description for the "{series_name}" tile series.

Collection: {series_name} ({len(products)} products)
{details_text}

SEO Keywords: {seo_keywords or 'tiles, porcelain tiles, interior design'}
{length_instruction}

Write a professional e-commerce description in flowing paragraphs. Mention the variety of options available."""

        chat = LlmChat(
            api_key=api_key,
            session_id=f"auto-regen-{uuid_module.uuid4()}",
            system_message="You are an expert tile copywriter. Write compelling collection descriptions."
        ).with_model("openai", "gpt-4o")
        
        user_message = UserMessage(text=prompt)
        description = await chat.send_message(user_message)
        
        return description.strip()
        
    except Exception as e:
        logger.error(f"Error generating description for {series_name}: {e}")
        raise


def get_scheduler() -> AsyncIOScheduler:
    """Get the global scheduler instance"""
    global scheduler
    if scheduler is None:
        scheduler = AsyncIOScheduler(
            jobstores={'default': MemoryJobStore()},
            timezone='UTC'
        )
    return scheduler


async def run_scheduled_import(schedule_id: str):
    """
    Execute a scheduled import job
    This runs as a background task triggered by the scheduler
    """
    logger.info(f"Starting scheduled import for schedule: {schedule_id}")
    
    try:
        db = get_db()
        
        # Get schedule configuration
        schedule = await db.import_schedules.find_one({"id": schedule_id})
        if not schedule:
            logger.error(f"Schedule {schedule_id} not found")
            return
        
        if not schedule.get("enabled", True):
            logger.info(f"Schedule {schedule_id} is disabled, skipping")
            return
        
        supplier = schedule.get("supplier", "splendour_tiles")
        credentials = schedule.get("credentials", {})
        email = credentials.get("email", "")
        password = credentials.get("password", "")
        
        if not email or not password:
            logger.error(f"Schedule {schedule_id} missing credentials")
            await db.import_schedules.update_one(
                {"id": schedule_id},
                {"$set": {
                    "last_run": datetime.now(timezone.utc).isoformat(),
                    "last_run_status": "failed",
                    "last_run_error": "Missing credentials"
                }}
            )
            return
        
        # Create import job record
        import uuid
        job_id = str(uuid.uuid4())[:8]
        
        job_record = {
            "id": job_id,
            "schedule_id": schedule_id,
            "status": "running",
            "supplier": supplier,
            "dry_run": False,
            "scheduled": True,
            "started_at": datetime.now(timezone.utc).isoformat(),
            "started_by": "scheduler",
            "progress": {
                "stage": "initializing",
                "current": 0,
                "total": 0,
                "message": "Starting scheduled import..."
            },
            "products_found": 0,
            "products_imported": 0,
            "products_updated": 0,
            "products_skipped": 0,
            "errors": [],
            "completed_at": None
        }
        
        # Store in scheduled_job_history for tracking
        scheduled_job_history[job_id] = job_record
        
        # Run the actual import
        products = []
        
        if supplier == "splendour_tiles":
            async with SplendourTilesImporter(
                base_url="https://www.splendourtiles.co.uk",
                credentials={'email': email, 'password': password}
            ) as importer:
                
                logged_in = await importer.login()
                if not logged_in:
                    job_record["status"] = "failed"
                    job_record["errors"].append("Login failed - check credentials")
                    job_record["completed_at"] = datetime.now(timezone.utc).isoformat()
                    
                    await db.import_schedules.update_one(
                        {"id": schedule_id},
                        {"$set": {
                            "last_run": datetime.now(timezone.utc).isoformat(),
                            "last_run_status": "failed",
                            "last_run_error": "Login failed"
                        }}
                    )
                    return
                
                async def progress_callback(progress):
                    job_record["progress"] = {
                        "stage": progress.get("stage", ""),
                        "current": progress.get("current", 0),
                        "total": progress.get("total", 0),
                        "message": progress.get("product") or progress.get("range") or progress.get("category", "")
                    }
                
                products = await importer.import_all_products(
                    progress_callback=progress_callback,
                    limit=None  # Import all for scheduled jobs
                )
        
        job_record["products_found"] = len(products)
        
        # Save products to database
        saved = 0
        updated = 0
        skipped = 0
        images_uploaded = 0
        
        for product in products:
            try:
                # Get existing product for image change detection
                existing = await db.products.find_one({"sku": product.get("sku")})
                
                # Upload images to R2 cloud storage (handles updates automatically)
                product_images = product.get("images", [])
                product_name = product.get("name", "product")
                supplier_name = product.get("source", supplier)
                
                # Store original source URLs
                product["image_source_urls"] = product_images.copy() if product_images else []
                
                if R2_AVAILABLE and process_product_images_for_deep_sync and product_images:
                    try:
                        processed_images, uploaded_count, source_urls = await process_product_images_for_deep_sync(
                            product_images,
                            supplier_name,
                            product_name,
                            existing  # Pass existing to detect image changes
                        )
                        product["images"] = processed_images
                        product["image_source_urls"] = source_urls
                        if uploaded_count > 0:
                            product["images_uploaded_to_r2"] = True
                            images_uploaded += uploaded_count
                            logger.info(f"Uploaded/updated {uploaded_count} images to R2 for {product_name}")
                    except Exception as img_err:
                        logger.warning(f"Failed to upload images to R2 for {product_name}: {img_err}")
                
                if existing:
                    # Update existing product - also update images if they changed
                    update_data = {
                        "cost_price": product.get("cost_price"),
                        "stock_sqm": product.get("stock_sqm", 0),
                        "supplier_data": product,
                        "last_imported": datetime.now(timezone.utc).isoformat(),
                        "image_source_urls": product.get("image_source_urls", [])
                    }
                    # Update images if new ones were uploaded to R2
                    if product.get("images_uploaded_to_r2"):
                        update_data["images"] = product.get("images", [])
                        update_data["images_uploaded_to_r2"] = True
                    
                    await db.products.update_one(
                        {"sku": product.get("sku")},
                        {"$set": update_data}
                    )
                    updated += 1
                else:
                    # Create new product
                    new_product = {
                        "id": str(uuid.uuid4()),
                        "sku": product.get("sku", ""),
                        "name": product.get("name", ""),
                        "description": product.get("description", ""),
                        "size": product.get("size", ""),
                        "material": product.get("material", ""),
                        "finish": product.get("finish", ""),
                        "color": product.get("color", ""),
                        "cost_price": product.get("cost_price"),
                        "price_per_sqm": (product.get("cost_price") or 0) * 1.5,
                        "price_per_box": None,
                        "tiles_per_box": product.get("tiles_per_box"),
                        "tiles_per_sqm": product.get("tiles_per_sqm"),
                        "coverage_per_box": None,
                        "stock_sqm": product.get("stock_sqm", 0),
                        "stock_boxes": 0,
                        "images": product.get("images", []),
                        "images_uploaded_to_r2": product.get("images_uploaded_to_r2", False),
                        "category_id": None,
                        "supplier_category": product.get("category"),
                        "supplier_range": product.get("range"),
                        "suitability": product.get("suitability"),
                        "underfloor_heating": product.get("underfloor_heating", False),
                        "rectified": product.get("rectified", False),
                        "supplier_data": product,
                        "source": product.get("source", "imported"),
                        "source_url": product.get("source_url"),
                        "imported_at": datetime.now(timezone.utc).isoformat(),
                        "created_at": datetime.now(timezone.utc).isoformat(),
                        "is_active": False,
                        "is_featured": False,
                        "clearance": False
                    }
                    
                    await db.products.insert_one(new_product)
                    saved += 1
                    
            except Exception as e:
                logger.error(f"Error saving product {product.get('name')}: {str(e)}")
                skipped += 1
        
        # Update job record
        job_record["status"] = "completed"
        job_record["products_imported"] = saved
        job_record["products_updated"] = updated
        job_record["products_skipped"] = skipped
        job_record["completed_at"] = datetime.now(timezone.utc).isoformat()
        job_record["progress"]["message"] = f"Completed: {saved} new, {updated} updated"
        
        # Calculate next run time
        frequency = schedule.get("frequency", "daily")
        next_run = calculate_next_run(frequency, schedule.get("time", "03:00"))
        
        # Update schedule with last run info
        await db.import_schedules.update_one(
            {"id": schedule_id},
            {"$set": {
                "last_run": datetime.now(timezone.utc).isoformat(),
                "last_run_status": "completed",
                "last_run_error": None,
                "last_run_products_found": len(products),
                "last_run_products_imported": saved,
                "last_run_products_updated": updated,
                "next_run": next_run.isoformat() if next_run else None
            }}
        )
        
        logger.info(f"Scheduled import {schedule_id} completed: {saved} new, {updated} updated")
        
    except Exception as e:
        logger.error(f"Scheduled import {schedule_id} failed: {str(e)}")
        
        try:
            db = get_db()
            await db.import_schedules.update_one(
                {"id": schedule_id},
                {"$set": {
                    "last_run": datetime.now(timezone.utc).isoformat(),
                    "last_run_status": "failed",
                    "last_run_error": str(e)
                }}
            )
        except:
            pass


def calculate_next_run(frequency: str, time_str: str) -> Optional[datetime]:
    """Calculate the next run time based on frequency"""
    try:
        hour, minute = map(int, time_str.split(":"))
    except:
        hour, minute = 3, 0  # Default to 3 AM
    
    now = datetime.now(timezone.utc)
    
    if frequency == "daily":
        next_run = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if next_run <= now:
            next_run += timedelta(days=1)
        return next_run
    
    elif frequency == "weekly":
        next_run = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        days_until_monday = (7 - now.weekday()) % 7
        if days_until_monday == 0 and next_run <= now:
            days_until_monday = 7
        next_run += timedelta(days=days_until_monday)
        return next_run
    
    elif frequency == "monthly":
        next_run = now.replace(day=1, hour=hour, minute=minute, second=0, microsecond=0)
        if next_run <= now:
            # Move to next month
            if now.month == 12:
                next_run = next_run.replace(year=now.year + 1, month=1)
            else:
                next_run = next_run.replace(month=now.month + 1)
        return next_run
    
    return None


def get_cron_trigger(frequency: str, time_str: str) -> CronTrigger:
    """Create a CronTrigger based on frequency and time"""
    try:
        hour, minute = map(int, time_str.split(":"))
    except:
        hour, minute = 3, 0
    
    if frequency == "daily":
        return CronTrigger(hour=hour, minute=minute)
    elif frequency == "weekly":
        return CronTrigger(day_of_week='mon', hour=hour, minute=minute)
    elif frequency == "monthly":
        return CronTrigger(day=1, hour=hour, minute=minute)
    else:
        return CronTrigger(hour=hour, minute=minute)


async def add_scheduled_job(schedule_id: str, frequency: str, time_str: str):
    """Add a new scheduled job to the scheduler"""
    sched = get_scheduler()
    
    # Create the job function wrapper
    def job_wrapper():
        asyncio.create_task(run_scheduled_import(schedule_id))
    
    trigger = get_cron_trigger(frequency, time_str)
    
    # Remove existing job if any
    try:
        sched.remove_job(f"import_{schedule_id}")
    except:
        pass
    
    # Add the new job
    sched.add_job(
        job_wrapper,
        trigger=trigger,
        id=f"import_{schedule_id}",
        name=f"Scheduled Import: {schedule_id}",
        replace_existing=True
    )
    
    logger.info(f"Added scheduled job: {schedule_id} with frequency {frequency} at {time_str}")


async def remove_scheduled_job(schedule_id: str):
    """Remove a scheduled job from the scheduler"""
    sched = get_scheduler()
    try:
        sched.remove_job(f"import_{schedule_id}")
        logger.info(f"Removed scheduled job: {schedule_id}")
    except Exception as e:
        logger.warning(f"Could not remove job {schedule_id}: {e}")


async def initialize_scheduler():
    """Initialize the scheduler and load existing schedules from database"""
    global scheduler
    
    sched = get_scheduler()
    
    if sched.running:
        logger.info("Scheduler already running")
        return
    
    try:
        db = get_db()
        
        # Load all enabled schedules from database
        schedules = await db.import_schedules.find({"enabled": True}).to_list(100)
        
        for schedule in schedules:
            schedule_id = schedule.get("id")
            frequency = schedule.get("frequency", "daily")
            time_str = schedule.get("time", "03:00")
            
            await add_scheduled_job(schedule_id, frequency, time_str)
            
            # Update next_run in database
            next_run = calculate_next_run(frequency, time_str)
            if next_run:
                await db.import_schedules.update_one(
                    {"id": schedule_id},
                    {"$set": {"next_run": next_run.isoformat()}}
                )
        
        # Add chat notification check job (runs every 2 minutes)
        try:
            from routes.live_chat import check_unanswered_chats
            sched.add_job(
                check_unanswered_chats,
                trigger=IntervalTrigger(minutes=2),
                id="chat_notification_check",
                name="Check for unanswered chats",
                replace_existing=True,
                misfire_grace_time=60
            )
            logger.info("Added chat notification check job (every 2 minutes)")
        except Exception as chat_job_err:
            logger.warning(f"Could not add chat notification job: {chat_job_err}")
        
        # Add series description auto-regeneration job (runs every 6 hours)
        try:
            sched.add_job(
                check_and_regenerate_series_descriptions,
                trigger=IntervalTrigger(hours=6),
                id="series_description_regeneration",
                name="Auto-regenerate series descriptions",
                replace_existing=True,
                misfire_grace_time=300
            )
            logger.info("Added series description auto-regeneration job (every 6 hours)")
        except Exception as regen_job_err:
            logger.warning(f"Could not add description regeneration job: {regen_job_err}")

        # Add abandoned-cart reminder job (runs every 15 minutes)
        try:
            from routes.abandoned_carts import process_reminders as abandoned_process_reminders

            async def _abandoned_cart_tick():
                try:
                    await abandoned_process_reminders()
                except Exception as e:
                    logger.warning(f"abandoned-cart tick failed: {e}")

            sched.add_job(
                _abandoned_cart_tick,
                trigger=IntervalTrigger(minutes=15),
                id="abandoned_cart_reminders",
                name="Send abandoned-cart day-0 / day-1 reminders",
                replace_existing=True,
                misfire_grace_time=300,
            )
            logger.info("Added abandoned-cart reminder job (every 15 minutes)")
        except Exception as ac_err:
            logger.warning(f"Could not add abandoned-cart reminder job: {ac_err}")

        # Add weekly-digest job (Mon 09:00 UTC by default; honours per-tick settings)
        try:
            from routes.weekly_digest import send_digest_now, _load_settings as load_digest_settings

            async def _weekly_digest_tick():
                try:
                    db_local = get_db()
                    settings = await load_digest_settings(db_local)
                    # Only fire when the wall-clock matches configured weekday/hour AND it's enabled.
                    now_utc = datetime.now(timezone.utc)
                    if not settings.get("enabled"):
                        return
                    if now_utc.weekday() != int(settings.get("weekday", 0)):
                        return
                    if now_utc.hour != int(settings.get("hour_utc", 9)):
                        return
                    await send_digest_now()
                except Exception as e:
                    logger.warning(f"weekly-digest tick failed: {e}")

            # Tick once an hour — exact day/hour gate is inside the function above.
            sched.add_job(
                _weekly_digest_tick,
                trigger=CronTrigger(minute=5),
                id="weekly_digest",
                name="Weekly recovery digest",
                replace_existing=True,
                misfire_grace_time=600,
            )
            logger.info("Added weekly-digest job (hourly probe)")
        except Exception as wd_err:
            logger.warning(f"Could not add weekly-digest job: {wd_err}")

        # Add daily reconciliation email job (hourly probe; gates on configured hour_utc + enabled)
        try:
            from routes.invoices import run_scheduled_reconciliation_tick

            async def _reconciliation_tick():
                try:
                    await run_scheduled_reconciliation_tick()
                except Exception as e:
                    logger.warning(f"reconciliation-email tick failed: {e}")

            sched.add_job(
                _reconciliation_tick,
                trigger=CronTrigger(minute=2),
                id="daily_reconciliation_email",
                name="Daily reconciliation email",
                replace_existing=True,
                misfire_grace_time=600,
            )
            logger.info("Added daily-reconciliation-email job (hourly probe)")
        except Exception as rec_err:
            logger.warning(f"Could not add daily-reconciliation job: {rec_err}")

        # Add nightly co-purchase index rebuild — feeds "Frequently Bought
        # Together" on every PDP. Runs at 03:00 UTC, off-peak.
        try:
            from services.recommendations_builder import rebuild_co_purchase_cache

            async def _co_purchase_tick():
                try:
                    res = await rebuild_co_purchase_cache()
                    logger.info(f"co-purchase cache rebuilt: {res}")
                except Exception as e:
                    logger.warning(f"co-purchase rebuild failed: {e}")

            sched.add_job(
                _co_purchase_tick,
                trigger=CronTrigger(hour=3, minute=15),
                id="co_purchase_cache_rebuild",
                name="Nightly frequently-bought-together rebuild",
                replace_existing=True,
                misfire_grace_time=3600,
            )
            logger.info("Added co-purchase cache rebuild job (03:15 UTC)")
        except Exception as cp_err:
            logger.warning(f"Could not add co-purchase rebuild job: {cp_err}")

        # Whole-site maintenance auto-window — every minute, flip the public
        # storefront on / off based on the configured start/end.
        try:
            from routes.website_admin import run_site_maintenance_schedule_tick

            async def _site_maint_tick():
                try:
                    await run_site_maintenance_schedule_tick()
                except Exception as e:
                    logger.warning(f"site-maintenance tick failed: {e}")

            sched.add_job(
                _site_maint_tick,
                trigger=CronTrigger(second=10),  # ~once a minute, off the hot 0s mark
                id="site_maintenance_window",
                name="Whole-site maintenance auto-window",
                replace_existing=True,
                misfire_grace_time=120,
            )
            logger.info("Added site-maintenance auto-window job (every minute)")
        except Exception as sm_err:
            logger.warning(f"Could not add site-maintenance job: {sm_err}")

        # Daily UI health PDF report — runs the registered Critical UI checks
        # via headless Chromium and emails a PDF to admins. Hour configurable
        # via website_settings.ui_health_schedule (default 03:00 UTC).
        try:
            await _add_ui_health_job(sched)
            logger.info("Added daily UI health report job")
        except Exception as uih_err:
            logger.warning(f"Could not add UI health daily job: {uih_err}")

        # Daily customer-error digest email (09:00 UTC) — bundles every
        # red toast / 5xx / JS crash a customer hit in the last 24h.
        try:
            from routes.client_errors import run_customer_errors_digest_tick

            async def _customer_errors_tick():
                try:
                    await run_customer_errors_digest_tick()
                except Exception as ce_err:
                    logger.warning(f"Customer errors digest tick failed: {ce_err}")

            sched.add_job(
                _customer_errors_tick,
                trigger=CronTrigger(minute=15),
                id="customer_errors_digest",
                name="Daily customer-error digest (hourly probe)",
                replace_existing=True,
                misfire_grace_time=600,
            )
            logger.info("Added daily customer-error digest job (hourly probe)")
        except Exception as ce_err:
            logger.warning(f"Could not add customer-error digest job: {ce_err}")

        # Daily 🔥 Hot Sessions digest email (09:00 UTC) — yesterday's
        # high-buying-intent visitors for the sales team to follow up on.
        try:
            from routes.analytics import run_hot_sessions_digest_tick

            async def _hot_sessions_digest_tick():
                try:
                    await run_hot_sessions_digest_tick()
                except Exception as hs_err:
                    logger.warning(f"Hot sessions digest tick failed: {hs_err}")

            sched.add_job(
                _hot_sessions_digest_tick,
                trigger=CronTrigger(minute=20),
                id="hot_sessions_digest",
                name="Daily hot-sessions digest (hourly probe)",
                replace_existing=True,
                misfire_grace_time=600,
            )
            logger.info("Added daily hot-sessions digest job (hourly probe)")
        except Exception as hs_err:
            logger.warning(f"Could not add hot-sessions digest job: {hs_err}")

        # Nightly SEO Self-Audit at 04:00 BST — runs all 19 critical
        # SEO subsystem checks in one pass and persists a graded
        # report. Surfaces on /admin/seo so admin sees the score
        # every morning without having to dig.
        try:
            from services.seo_self_audit import run_seo_audit as _seo_audit_run

            async def _seo_audit_tick():
                try:
                    res = await _seo_audit_run(persist=True)
                    logger.info(
                        "SEO Self-Audit ran: score=%s grade=%s pass/warn/fail=%s/%s/%s",
                        res.get("score"), res.get("grade"),
                        res.get("pass_count"), res.get("warn_count"), res.get("fail_count"),
                    )
                except Exception as audit_err:
                    logger.warning(f"SEO Self-Audit failed: {audit_err}")

            sched.add_job(
                _seo_audit_tick,
                trigger=CronTrigger(hour=4, minute=0, timezone="Europe/London"),
                id="seo_self_audit_nightly",
                name="SEO Self-Audit — nightly subsystem health probe",
                replace_existing=True,
                misfire_grace_time=3600,
            )
            logger.info("Added SEO Self-Audit nightly job")
        except Exception as audit_err:
            logger.warning(f"Could not add SEO Self-Audit job: {audit_err}")

        # Monthly trade-credit statement email — fires only on the 1st of
        # each month at 10:00 UTC. Hourly probe is idempotent via marker.
        try:
            from routes.trade_credit_statements import run_monthly_credit_statements_tick

            async def _monthly_credit_statements_tick():
                try:
                    await run_monthly_credit_statements_tick()
                except Exception as mcs_err:
                    logger.warning(f"Monthly credit statements tick failed: {mcs_err}")

            sched.add_job(
                _monthly_credit_statements_tick,
                trigger=CronTrigger(minute=15),
                id="monthly_credit_statements",
                name="Monthly trade-credit statements (hourly probe)",
                replace_existing=True,
                misfire_grace_time=600,
            )
            logger.info("Added monthly trade-credit statements job (hourly probe)")
        except Exception as mcs_err:
            logger.warning(f"Could not add monthly credit statements job: {mcs_err}")

        # Weekly trade-credit balance reminder — punchy "you've got £X
        # waiting" nudge. Fires Mondays at 10:00 UTC by default; hourly
        # probe checks weekday+hour and idempotency-guards by ISO week.
        try:
            from routes.trade_credit_statements import run_weekly_trade_balance_tick

            async def _weekly_trade_balance_tick():
                try:
                    await run_weekly_trade_balance_tick()
                except Exception as wkly_err:
                    logger.warning(f"Weekly trade balance tick failed: {wkly_err}")

            sched.add_job(
                _weekly_trade_balance_tick,
                trigger=CronTrigger(minute=20),
                id="weekly_trade_balance",
                name="Weekly trade-credit balance reminder (hourly probe)",
                replace_existing=True,
                misfire_grace_time=600,
            )
            logger.info("Added weekly trade-credit balance reminder job (hourly probe)")
        except Exception as wkly_err:
            logger.warning(f"Could not add weekly trade balance job: {wkly_err}")

        # Email Hub — fires any scheduled campaigns whose `scheduled_for`
        # has elapsed. Hourly probe is fine because admin only schedules to
        # the nearest hour from the UI.
        try:
            from routes.email_hub import run_email_hub_schedule_tick

            async def _email_hub_tick():
                try:
                    await run_email_hub_schedule_tick()
                except Exception as eh_err:
                    logger.warning(f"Email hub schedule tick failed: {eh_err}")

            sched.add_job(
                _email_hub_tick,
                trigger=CronTrigger(minute=5),
                id="email_hub_schedule",
                name="Email hub — fire scheduled campaigns",
                replace_existing=True,
                misfire_grace_time=600,
            )
            logger.info("Added email-hub scheduler tick (hourly probe)")
        except Exception as eh_err:
            logger.warning(f"Could not add email-hub scheduler tick: {eh_err}")

        # Daily Stripe orphan-order reconciliation. Runs every day at
        # 08:00 UTC. Scans for any pending order with a Stripe session
        # ID, re-queries Stripe, auto-flips to paid if Stripe says paid,
        # and emails the admin a digest of anything still pending.
        # This was BUILT in response to the 2 May 2026 silent-failure
        # incident — see routes/stripe_reconcile.py.
        try:
            from routes.stripe_reconcile import run_daily_orphan_alert_tick

            async def _stripe_reconcile_tick():
                try:
                    await run_daily_orphan_alert_tick()
                except Exception as sr_err:
                    logger.warning(f"Stripe reconcile daily tick failed: {sr_err}")

            sched.add_job(
                _stripe_reconcile_tick,
                trigger=CronTrigger(hour=8, minute=0),
                id="stripe_orphan_reconcile_daily",
                name="Daily Stripe orphan-order reconciliation",
                replace_existing=True,
                misfire_grace_time=3600,
            )
            logger.info("Added daily Stripe orphan-reconcile job (08:00 UTC)")
        except Exception as sr_err:
            logger.warning(f"Could not add Stripe orphan-reconcile job: {sr_err}")

        # Monthly hall-of-fame snapshot (3 Jun 2026 — per user
        # request to start tracking from June 2026 onwards).
        # Fires at 00:30 on day-1 of each month so the just-finished
        # month's final leaderboard is preserved before any new
        # quotes for the new month can be filed.
        try:
            from routes.staff_leaderboard import snapshot_previous_month

            async def _staff_hof_snapshot_tick():
                try:
                    result = await snapshot_previous_month()
                    if result.get("ok"):
                        logger.info(
                            "Staff Hall-of-Fame snapshot taken for %s: champion=%s",
                            result.get("month"),
                            (result.get("champion") or {}).get("name"),
                        )
                except Exception as snap_err:
                    logger.warning("Staff HoF snapshot failed: %s", snap_err)

            sched.add_job(
                _staff_hof_snapshot_tick,
                trigger=CronTrigger(day=1, hour=0, minute=30),
                id="staff_leaderboard_hof_snapshot",
                name="Monthly Staff Hall-of-Fame snapshot",
                replace_existing=True,
                misfire_grace_time=3600,
            )
            logger.info("Added monthly Staff HoF snapshot job (1st @ 00:30 UTC)")
        except Exception as snap_err:
            logger.warning("Could not add Staff HoF snapshot job: %s", snap_err)

        # Nightly announcement-ribbon leak scrubber — belt + braces safety
        # net after the 30-Apr-2026 TEST_PRESERVE_fields incident. Even if
        # a future test file forgets to clean up, any `TEST_*` / `_E1_TEST_*`
        # string will be purged from the live ribbon within 24h. Runs at
        # 02:30 UTC (off-peak; before the 03:00 import wave).
        try:
            from tests.cleanup_ribbon_test_leaks import cleanup_ribbon_test_leaks  # noqa: PLC0415
            from services.telegram_notify import notify_event  # noqa: PLC0415

            async def _ribbon_leak_tick():
                try:
                    db_local = get_db()
                    result = await cleanup_ribbon_test_leaks(
                        db=db_local, dry_run=False, logger=logger
                    )
                    if result["docs_cleaned"] or result["history_entries_pruned"]:
                        logger.warning(
                            "Ribbon leak cleanup scrubbed test data: %s", result
                        )
                        # Telegram ping so the admin knows within seconds
                        # instead of hunting through logs. The
                        # `notify_event` helper honours the admin's
                        # ribbon_leak event toggle + dedupe window.
                        try:
                            docs = result.get("docs_cleaned", 0)
                            hist = result.get("history_entries_pruned", 0)
                            await notify_event(
                                "ribbon_leak",
                                (
                                    "🚨 <b>Ribbon leak scrubbed</b>\n"
                                    f"Cleaned {docs} doc(s), pruned {hist} history entr"
                                    f"{'y' if hist == 1 else 'ies'}.\n"
                                    "Check tests for a missing cleanup."
                                ),
                                dedupe_key="nightly",
                            )
                        except Exception as tg_err:  # noqa: BLE001
                            logger.warning(f"Telegram ping for ribbon leak failed: {tg_err}")
                    else:
                        logger.info("Ribbon leak cleanup: nothing to clean")
                except Exception as e:  # noqa: BLE001
                    logger.warning(f"ribbon-leak-cleanup tick failed: {e}")

            sched.add_job(
                _ribbon_leak_tick,
                trigger=CronTrigger(hour=2, minute=30),
                id="ribbon_leak_cleanup",
                name="Nightly announcement-ribbon leak scrubber",
                replace_existing=True,
                misfire_grace_time=3600,
            )
            logger.info("Added nightly ribbon-leak-cleanup job (02:30 UTC)")
        except Exception as rl_err:
            logger.warning(f"Could not add ribbon-leak-cleanup job: {rl_err}")

        # Nightly SEO drafts scanner — finds products with missing
        # descriptions, asks the LLM for a draft, stages it in
        # `seo_description_drafts` for admin review. Never writes to the
        # live storefront on its own — see routes/seo_drafts.py for the
        # approve-to-publish flow. Runs at 04:30 UTC (after UI-health +
        # co-purchase rebuild, before showroom opening) so failures have
        # hours of admin attention before peak.
        try:
            from routes.seo_drafts import scan_for_missing_descriptions

            async def _seo_drafts_tick():
                try:
                    result = await scan_for_missing_descriptions(force=False)
                    logger.info(f"seo-drafts nightly scan: {result}")
                except Exception as e:  # noqa: BLE001
                    logger.warning(f"seo-drafts nightly scan failed: {e}")

            sched.add_job(
                _seo_drafts_tick,
                trigger=CronTrigger(hour=4, minute=30),
                id="seo_drafts_nightly_scan",
                name="Nightly SEO drafts scanner",
                replace_existing=True,
                misfire_grace_time=3600,
            )
            logger.info("Added nightly SEO drafts scanner job (04:30 UTC)")
        except Exception as sd_err:  # noqa: BLE001
            logger.warning(f"Could not add SEO drafts scanner job: {sd_err}")

        # Weekly SEO impact digest — Mondays 09:00 Europe/London. Bundles
        # last 7 days of search insights into an admin email so the team
        # has eyes on the SEO loop even when no one's logged into admin.
        try:
            from services.seo_digest import run_seo_digest_tick

            async def _seo_digest_tick():
                try:
                    result = await run_seo_digest_tick(force=False)
                    logger.info(f"seo-digest weekly tick: {result}")
                except Exception as e:  # noqa: BLE001
                    logger.warning(f"seo-digest weekly tick failed: {e}")

            sched.add_job(
                _seo_digest_tick,
                trigger=CronTrigger(day_of_week="mon", hour=9, minute=0, timezone="Europe/London"),
                id="seo_digest_weekly",
                name="Weekly SEO impact digest (Mon 09:00 Europe/London)",
                replace_existing=True,
                misfire_grace_time=3600,
            )
            logger.info("Added weekly SEO digest job (Mon 09:00 Europe/London)")
        except Exception as sdig_err:  # noqa: BLE001
            logger.warning(f"Could not add weekly SEO digest job: {sdig_err}")

        # Weekly ticket-print digest — Mondays 09:15 Europe/London.
        # Slots between SEO digest (09:00) and GSC digest (09:30) so
        # admins get a clean stack of three Monday-morning Telegrams.
        # See `services/ticket_digest.py` for the aggregation logic.
        try:
            from services.ticket_digest import run_ticket_digest_tick

            async def _ticket_digest_tick():
                try:
                    res = await run_ticket_digest_tick(force=False)
                    logger.info(f"ticket-print weekly digest tick: {res}")
                except Exception as e:  # noqa: BLE001
                    logger.warning(f"ticket-print weekly digest tick failed: {e}")

            sched.add_job(
                _ticket_digest_tick,
                trigger=CronTrigger(day_of_week="mon", hour=9, minute=15, timezone="Europe/London"),
                id="ticket_digest_weekly",
                name="Weekly ticket-print Telegram digest (Mon 09:15 Europe/London)",
                replace_existing=True,
                misfire_grace_time=3600,
            )
            logger.info("Added weekly ticket-print digest job (Mon 09:15 Europe/London)")
        except Exception as tdig_err:  # noqa: BLE001
            logger.warning(f"Could not add weekly ticket-print digest job: {tdig_err}")

        # GSC weekly digest — Phase 4 — every Monday 09:30 Europe/London.
        # Sits 30 minutes after the storefront-search digest so an admin
        # gets two cleanly-separated emails, internal then external.
        try:
            from services.gsc_digest import run_gsc_weekly_digest, run_gsc_ctr_drop_check

            async def _gsc_digest_tick():
                try:
                    res = await run_gsc_weekly_digest(force=False)
                    logger.info(f"gsc weekly digest tick: {res}")
                except Exception as e:  # noqa: BLE001
                    logger.warning(f"gsc weekly digest tick failed: {e}")

            sched.add_job(
                _gsc_digest_tick,
                trigger=CronTrigger(hour=9, minute=30, timezone="Europe/London"),
                id="gsc_weekly_digest",
                name="GSC daily digest (every day 09:30 Europe/London)",
                replace_existing=True,
                misfire_grace_time=3600,
            )
            logger.info("Added GSC daily digest job (every day 09:30 Europe/London)")

            async def _gsc_ctr_drop_tick():
                try:
                    res = await run_gsc_ctr_drop_check(force=False)
                    logger.info(f"gsc CTR-drop tick: {res}")
                except Exception as e:  # noqa: BLE001
                    logger.warning(f"gsc CTR-drop tick failed: {e}")

            sched.add_job(
                _gsc_ctr_drop_tick,
                trigger=CronTrigger(hour=8, minute=0, timezone="Europe/London"),
                id="gsc_ctr_drop_daily",
                name="GSC CTR-drop alerts (daily 08:00 Europe/London)",
                replace_existing=True,
                misfire_grace_time=3600,
            )
            logger.info("Added daily GSC CTR-drop alert job (08:00 Europe/London)")
        except Exception as gsc_err:  # noqa: BLE001
            logger.warning(f"Could not add GSC digest/CTR-drop jobs: {gsc_err}")

        # Uptime probe — every 5 minutes, fires HTTP+DB+Stripe+Telegram
        # checks and stores one row per service in `uptime_probes`.
        # Powers the 30-day sparkline widget on the maintenance dashboard.
        try:
            from services.uptime import run_uptime_probe_tick

            async def _uptime_probe_tick():
                try:
                    res = await run_uptime_probe_tick()
                    failed = [s for s, v in res.get("results", {}).items() if not v.get("ok")]
                    if failed:
                        logger.warning(f"uptime probe: {len(failed)} failure(s) — {failed}")
                except Exception as e:  # noqa: BLE001
                    logger.warning(f"uptime probe tick failed: {e}")

            sched.add_job(
                _uptime_probe_tick,
                trigger=IntervalTrigger(minutes=5),
                id="uptime_probe_5min",
                name="Uptime probe (every 5 min)",
                replace_existing=True,
                misfire_grace_time=300,
                # Kick off ~10s after boot so we don't pile on the
                # cold-start request burst.
                next_run_time=datetime.now(timezone.utc) + timedelta(seconds=10),
            )
            logger.info("Added uptime probe job (every 5 min)")
        except Exception as up_err:  # noqa: BLE001
            logger.warning(f"Could not add uptime probe job: {up_err}")

        # Deep-content uptime monitor with Telegram alerts — every 5 min,
        # offset by 2 min from the basic probe above so the two don't
        # share an HTTP burst. This one validates the storefront returns
        # real content (search returns results, homepage contains the
        # brand name, etc.) and pings Telegram on every state transition.
        try:
            from services.uptime_monitor import run_uptime_tick as run_uptime_monitor_tick

            async def _uptime_monitor_tick():
                try:
                    res = await run_uptime_monitor_tick()
                    if res.get("alerts"):
                        logger.warning(
                            f"uptime-monitor: {len(res['alerts'])} alert(s) sent — "
                            f"{[a['id'] for a in res['alerts']]}"
                        )
                except Exception as e:  # noqa: BLE001
                    logger.warning(f"uptime-monitor tick failed: {e}")

            sched.add_job(
                _uptime_monitor_tick,
                trigger=IntervalTrigger(minutes=5),
                id="uptime_monitor_5min",
                name="Uptime monitor with Telegram alerts (every 5 min)",
                replace_existing=True,
                misfire_grace_time=300,
                # Offset 2 minutes from `uptime_probe_5min` so they don't
                # collide. First run ~120s after boot.
                next_run_time=datetime.now(timezone.utc) + timedelta(seconds=120),
            )
            logger.info("Added uptime-monitor + Telegram alerts job (every 5 min)")
        except Exception as um_err:  # noqa: BLE001
            logger.warning(f"Could not add uptime-monitor job: {um_err}")

        # Radio off-air alerts — every 60 s, pages super-admin via
        # Telegram if a labelled showroom device hasn't pinged in
        # 5+ minutes during opening hours. Cheap (one Mongo find,
        # zero HTTP). See services/radio_offair_alerts.py.
        try:
            from services.radio_offair_alerts import run_radio_offair_tick

            async def _radio_offair_tick():
                try:
                    res = await run_radio_offair_tick()
                    if res.get("fired") or res.get("recovered"):
                        logger.info(f"radio off-air tick: {res}")
                except Exception as e:  # noqa: BLE001
                    logger.warning(f"radio off-air tick failed: {e}")

            sched.add_job(
                _radio_offair_tick,
                trigger=IntervalTrigger(minutes=1),
                id="radio_offair_alerts_1min",
                name="Radio off-air Telegram alerts (every 1 min)",
                replace_existing=True,
                misfire_grace_time=60,
                next_run_time=datetime.now(timezone.utc) + timedelta(seconds=180),
            )
            logger.info("Added radio off-air alert job (every 1 min)")
        except Exception as ro_err:  # noqa: BLE001
            logger.warning(f"Could not add radio off-air alert job: {ro_err}")

        # Daily Ahrefs snapshot — pulls fresh competitor DR + your domain
        # metrics every morning so the SEO Command Centre always renders
        # instantly without a cold-cache hit. Cheap (~50-100 units/day,
        # well under the 1M monthly Advanced-tier allowance).
        try:
            from services.ahrefs import snapshot_seo_data

            async def _ahrefs_tick():
                from config import get_db
                try:
                    res = await snapshot_seo_data(get_db())
                    logger.info(f"ahrefs daily snapshot: ok={res.get('ok')} errors={len(res.get('errors',[]))}")
                except Exception as e:  # noqa: BLE001
                    logger.warning(f"ahrefs daily snapshot failed: {e}")

            sched.add_job(
                _ahrefs_tick,
                trigger=CronTrigger(hour=6, minute=15, timezone="Europe/London"),
                id="ahrefs_daily_snapshot",
                name="Daily Ahrefs snapshot (06:15 Europe/London)",
                replace_existing=True,
                misfire_grace_time=3600,
            )
            logger.info("Added daily Ahrefs snapshot job (06:15 Europe/London)")
        except Exception as ah_err:  # noqa: BLE001
            logger.warning(f"Could not add daily Ahrefs snapshot job: {ah_err}")

        # Ads-savings monthly snapshot — captures current-month totals
        # from GSC into `ads_savings_snapshots` (one doc per YYYY-MM,
        # upserted daily). Powers the "↗ +X% vs last month" growth
        # tracker on /admin/ads-savings. Cheap (one GSC call).
        try:
            from services.ads_savings_snapshot import run_ads_savings_snapshot_tick

            async def _ads_savings_snapshot_tick():
                try:
                    res = await run_ads_savings_snapshot_tick(source="auto")
                    logger.info(f"ads-savings snapshot tick: {res}")
                except Exception as e:  # noqa: BLE001
                    logger.warning(f"ads-savings snapshot tick failed: {e}")

            sched.add_job(
                _ads_savings_snapshot_tick,
                trigger=CronTrigger(hour=6, minute=30, timezone="Europe/London"),
                id="ads_savings_monthly_snapshot",
                name="Ads-savings monthly snapshot (06:30 Europe/London)",
                replace_existing=True,
                misfire_grace_time=3600,
            )
            logger.info("Added ads-savings monthly snapshot job (06:30 Europe/London)")
        except Exception as as_err:  # noqa: BLE001
            logger.warning(f"Could not add ads-savings snapshot job: {as_err}")

        # Monthly SEO P&L digest — fires on the 1st of every month at
        # 08:00 Europe/London. Uses the snapshot collection for the
        # previous-month figure, computes top-5 + fell-off-page-1 fresh
        # from GSC. Idempotent on YYYY-MM via website_settings.
        try:
            from services.seo_pnl_digest import run_seo_pnl_monthly_digest

            async def _seo_pnl_monthly_tick():
                try:
                    res = await run_seo_pnl_monthly_digest(force=False)
                    logger.info(f"seo P&L monthly tick: {res}")
                except Exception as e:  # noqa: BLE001
                    logger.warning(f"seo P&L monthly tick failed: {e}")

            sched.add_job(
                _seo_pnl_monthly_tick,
                trigger=CronTrigger(day=1, hour=8, minute=0, timezone="Europe/London"),
                id="seo_pnl_monthly_digest",
                name="SEO P&L monthly digest (1st of month, 08:00 Europe/London)",
                replace_existing=True,
                misfire_grace_time=12 * 3600,  # generous — owner just cares it lands SOMETIME on the 1st
            )
            logger.info("Added SEO P&L monthly digest job (1st @ 08:00 Europe/London)")
        except Exception as pn_err:  # noqa: BLE001
            logger.warning(f"Could not add SEO P&L monthly digest job: {pn_err}")

        # Quarterly board-deck PDF auto-email — fires on Jan/Apr/Jul/Oct
        # 1st at 09:00 Europe/London, attaches the freshly-rendered
        # quarterly PDF so the board deck lands in admins' inboxes
        # before their Monday-morning quarterly review meeting.
        # Idempotent on Q-YYYY via website_settings.
        try:
            from services.quarterly_pdf_email import run_quarterly_pdf_email

            async def _quarterly_pdf_email_tick():
                try:
                    res = await run_quarterly_pdf_email(force=False)
                    logger.info(f"quarterly PDF email tick: {res}")
                except Exception as e:  # noqa: BLE001
                    logger.warning(f"quarterly PDF email tick failed: {e}")

            sched.add_job(
                _quarterly_pdf_email_tick,
                trigger=CronTrigger(
                    month="1,4,7,10", day=1, hour=9, minute=0,
                    timezone="Europe/London",
                ),
                id="quarterly_pdf_board_deck_email",
                name="Quarterly PDF board-deck email (1 Jan/Apr/Jul/Oct, 09:00 Europe/London)",
                replace_existing=True,
                misfire_grace_time=12 * 3600,
            )
            logger.info("Added quarterly PDF board-deck email job (1 Jan/Apr/Jul/Oct @ 09:00 Europe/London)")
        except Exception as qpe_err:  # noqa: BLE001
            logger.warning(f"Could not add quarterly PDF email job: {qpe_err}")

        # ── SEO Autopilot suite — fully autonomous SEO maintenance ────
        try:
            from services import seo_autopilot as ap, auto_alt_text, web_vitals as wv

            async def _ap_cannibal_tick():
                try: logger.info(f"cannibalization tick: {await ap.run_cannibalization_autopilot()}")
                except Exception as e: logger.warning(f"cannibal tick failed: {e}")

            async def _ap_stale_tick():
                try: logger.info(f"stale page tick: {await ap.run_stale_page_autopilot()}")
                except Exception as e: logger.warning(f"stale tick failed: {e}")

            async def _ap_404_tick():
                try: logger.info(f"404 redirect tick: {await ap.run_404_autopilot()}")
                except Exception as e: logger.warning(f"404 tick failed: {e}")

            async def _ap_algo_tick():
                try: logger.info(f"algo update tick: {await ap.run_algorithm_update_detector()}")
                except Exception as e: logger.warning(f"algo tick failed: {e}")

            async def _ap_brand_tick():
                try: logger.info(f"brand SERP tick: {await ap.run_brand_serp_tracker()}")
                except Exception as e: logger.warning(f"brand SERP tick failed: {e}")

            async def _alt_backfill_tick():
                try: logger.info(f"alt-text backfill: {await auto_alt_text.run_alt_text_backfill_tick(50)}")
                except Exception as e: logger.warning(f"alt backfill failed: {e}")

            async def _wv_aggregate_tick():
                try: logger.info(f"web-vitals aggregate: {await wv.run_web_vitals_aggregation_tick()}")
                except Exception as e: logger.warning(f"web vitals aggregate failed: {e}")

            async def _wv_alert_tick():
                try: logger.info(f"web-vitals alert: {await wv.run_web_vitals_alert_tick()}")
                except Exception as e: logger.warning(f"web vitals alert failed: {e}")

            sched.add_job(_ap_cannibal_tick, CronTrigger(hour=7, minute=0, timezone="Europe/London"),
                          id="seo_autopilot_cannibalization", replace_existing=True, misfire_grace_time=3600)
            sched.add_job(_ap_404_tick, CronTrigger(hour=7, minute=15, timezone="Europe/London"),
                          id="seo_autopilot_404_redirects", replace_existing=True, misfire_grace_time=3600)
            sched.add_job(_ap_stale_tick, CronTrigger(day_of_week="sun", hour=7, minute=30, timezone="Europe/London"),
                          id="seo_autopilot_stale_pages", replace_existing=True, misfire_grace_time=12*3600)
            sched.add_job(_ap_brand_tick, CronTrigger(day_of_week="mon", hour=7, minute=45, timezone="Europe/London"),
                          id="seo_autopilot_brand_serp", replace_existing=True, misfire_grace_time=12*3600)
            sched.add_job(_ap_algo_tick, CronTrigger(hour=8, minute=0, timezone="Europe/London"),
                          id="seo_autopilot_algorithm_detector", replace_existing=True, misfire_grace_time=3600)
            sched.add_job(_alt_backfill_tick, CronTrigger(hour=4, minute=0, timezone="Europe/London"),
                          id="seo_autopilot_alt_text_backfill", replace_existing=True, misfire_grace_time=12*3600)
            sched.add_job(_wv_aggregate_tick, CronTrigger(hour="*/6", timezone="Europe/London"),
                          id="seo_autopilot_web_vitals_aggregate", replace_existing=True, misfire_grace_time=3600)
            sched.add_job(_wv_alert_tick, CronTrigger(hour=9, minute=15, timezone="Europe/London"),
                          id="seo_autopilot_web_vitals_alert", replace_existing=True, misfire_grace_time=12*3600)

            # Weekly summary email — peace-of-mind "what the autopilot did this week"
            from services.seo_autopilot_summary import run_seo_autopilot_weekly_summary

            async def _ap_weekly_summary_tick():
                try: logger.info(f"autopilot weekly summary: {await run_seo_autopilot_weekly_summary()}")
                except Exception as e: logger.warning(f"autopilot weekly summary failed: {e}")

            sched.add_job(_ap_weekly_summary_tick,
                          CronTrigger(day_of_week="mon", hour=8, minute=30, timezone="Europe/London"),
                          id="seo_autopilot_weekly_summary", replace_existing=True, misfire_grace_time=12*3600)
            logger.info("Added 9 SEO Autopilot jobs (8 fixers + weekly summary)")

            # ────────────────────────────────────────────────────────
            # FULL AUTOPILOT — Self-Crawler + GSC Indexing Scanner
            # (added 12 May 2026 after admin made it categorically clear
            # the SEO engine MUST audit + auto-fix without manual touch.)
            #
            # Schedule:
            #   • Self-crawl + auto-fix + regression alert: every Mon-Fri 03:00 London
            #     (off-peak so we don't compete with customer traffic; weekend
            #     gaps are fine because we already have 6 day-of-week runs).
            #   • GSC indexing scan: every Mon-Fri 03:30 (after self-crawl
            #     so the inspection picks suspect URLs from the latest crawl).
            #     Inspects 200 URLs/day → full 1,000-URL sitemap covered
            #     every ~5 working days, well under GSC's 2k/day quota.
            # ────────────────────────────────────────────────────────
            try:
                from services.seo_self_crawler import run_full_autopilot_cycle
                from services.gsc_indexing_scanner import run_gsc_indexing_scan

                async def _full_self_crawl_tick():
                    try:
                        res = await run_full_autopilot_cycle()
                        logger.info(
                            f"seo self-crawl: {res.get('crawl', {}).get('urls_crawled')} crawled, "
                            f"auto-fix: {res.get('auto_fix', {}).get('fixes')}"
                        )
                    except Exception as e:
                        logger.warning(f"seo self-crawl tick failed: {e}")

                async def _gsc_indexing_scan_tick():
                    try:
                        res = await run_gsc_indexing_scan(limit=200)
                        logger.info(f"gsc indexing scan: {res}")
                    except Exception as e:
                        logger.warning(f"gsc indexing scan failed: {e}")

                sched.add_job(
                    _full_self_crawl_tick,
                    CronTrigger(day_of_week="mon-fri", hour=3, minute=0,
                                timezone="Europe/London"),
                    id="seo_self_crawl_full_cycle",
                    replace_existing=True, misfire_grace_time=3600,
                )
                sched.add_job(
                    _gsc_indexing_scan_tick,
                    CronTrigger(day_of_week="mon-fri", hour=3, minute=30,
                                timezone="Europe/London"),
                    id="seo_gsc_indexing_scan",
                    replace_existing=True, misfire_grace_time=3600,
                )
                logger.info("Added Self-Crawler + GSC Indexing Scan jobs (autopilot)")

                # ─── Topps Tiles Mission tracker — weekly ───
                # Captures DR/traffic/refdomains/keywords for our domain
                # and Topps/Tile Mountain/W&F every Monday 06:30 BST,
                # 30 min before the editorial autopilot's 07:00 run so
                # the Monday digest has the freshest gap numbers.
                from services.competitor_tracker import run_weekly_snapshot

                async def _competitor_tracker_tick():
                    try:
                        res = await run_weekly_snapshot()
                        our = (res or {}).get("our") or {}
                        gap = (res or {}).get("gap_to_primary") or {}
                        logger.info(
                            f"competitor-tracker: our_dr={our.get('dr')} "
                            f"our_traffic={our.get('organic_traffic')} "
                            f"dr_gap={gap.get('dr_gap')} traffic_gap={gap.get('traffic_gap')}"
                        )
                    except Exception as e:
                        logger.warning(f"competitor tracker tick failed: {e}")

                sched.add_job(
                    _competitor_tracker_tick,
                    CronTrigger(day_of_week="mon", hour=6, minute=30,
                                timezone="Europe/London"),
                    id="seo_topps_competitor_tracker",
                    replace_existing=True, misfire_grace_time=12*3600,
                )
                logger.info("Added Competitor Tracker (Topps mission) job")
            except Exception as crawl_err:  # noqa: BLE001
                logger.warning(f"Could not wire self-crawler jobs: {crawl_err}")
        except Exception as ap_err:  # noqa: BLE001
            logger.warning(f"Could not add SEO Autopilot jobs: {ap_err}")

        # Daily auto-generator for AI City Landing Pages — drains the
        # pending queue at the configured UTC hour (default 04:00). Hourly
        # probe with internal hour gate so changes to the settings doc
        # take effect without a scheduler restart. Sends a "queue drained"
        # email once when there's nothing left to generate.
        try:
            from services.city_pages_autogen import run_city_pages_autogen_tick

            async def _city_pages_autogen_tick():
                try:
                    res = await run_city_pages_autogen_tick(force=False)
                    if res.get("ran"):
                        logger.info(f"city-pages autogen tick: {res}")
                except Exception as e:  # noqa: BLE001
                    logger.warning(f"city-pages autogen tick failed: {e}")

            sched.add_job(
                _city_pages_autogen_tick,
                trigger=CronTrigger(minute=25),  # 25 past every hour
                id="city_pages_daily_autogen",
                name="Daily AI City Landing Pages auto-generator",
                replace_existing=True,
                misfire_grace_time=3600,
            )
            logger.info("Added daily city-pages auto-generator job (hourly probe)")
        except Exception as cpa_err:  # noqa: BLE001
            logger.warning(f"Could not add city-pages auto-generator job: {cpa_err}")

        # Weekly SEO Quality digest — Mondays 09:30 Europe/London. Audits
        # the AI city-page factory for the previous 7 days: auto-approved
        # vs manual vs low-confidence rejects + top failure reasons.
        try:
            from services.seo_quality_digest import run_seo_quality_digest_tick

            async def _seo_quality_digest_tick():
                try:
                    res = await run_seo_quality_digest_tick(force=False)
                    logger.info(f"seo-quality-digest weekly tick: {res}")
                except Exception as e:  # noqa: BLE001
                    logger.warning(f"seo-quality-digest weekly tick failed: {e}")

            sched.add_job(
                _seo_quality_digest_tick,
                trigger=CronTrigger(day_of_week="mon", hour=9, minute=30, timezone="Europe/London"),
                id="seo_quality_digest_weekly",
                name="Weekly SEO quality digest (Mon 09:30 Europe/London)",
                replace_existing=True,
                misfire_grace_time=3600,
            )
            logger.info("Added weekly SEO quality digest job (Mon 09:30 Europe/London)")
        except Exception as sqd_err:  # noqa: BLE001
            logger.warning(f"Could not add weekly SEO quality digest job: {sqd_err}")

        # Daily A/B winner auto-promoter for AI City Landing Pages — the
        # final step in the SEO factory. After both variants gather
        # `min_impressions` (default 200) AND the test has run for
        # `min_days` (default 14), pick whichever has higher CTR and
        # promote it. Hourly probe with internal hour gate. Opt-in.
        try:
            from services.city_pages_ab_autopromote import run_ab_autopromote_tick

            async def _ab_autopromote_tick():
                try:
                    res = await run_ab_autopromote_tick(force=False)
                    if res.get("ran"):
                        logger.info(f"city-pages ab-autopromote tick: {res}")
                except Exception as e:  # noqa: BLE001
                    logger.warning(f"city-pages ab-autopromote tick failed: {e}")

            sched.add_job(
                _ab_autopromote_tick,
                trigger=CronTrigger(minute=35),  # 35 past every hour
                id="city_pages_ab_autopromote",
                name="Daily A/B winner auto-promoter for AI City Landing Pages",
                replace_existing=True,
                misfire_grace_time=3600,
            )
            logger.info("Added daily A/B winner auto-promoter job (hourly probe)")
        except Exception as abap_err:  # noqa: BLE001
            logger.warning(f"Could not add A/B autopromote job: {abap_err}")

        # Editorial Autopilot — weekly competitor-driven content engine.
        # Mondays 07:00 BST so the digest email lands in your inbox by
        # the time you grab a coffee. Idempotent: if the autopilot is
        # paused or the monthly cap is exceeded, the run is a no-op.
        try:
            from services.editorial_autopilot import run_weekly_autopilot

            async def _editorial_weekly_tick():
                try:
                    res = await run_weekly_autopilot()
                    logger.info(f"Editorial Autopilot weekly run: {res}")
                except Exception as e:  # noqa: BLE001
                    logger.exception(f"editorial autopilot weekly run failed: {e}")

            sched.add_job(
                _editorial_weekly_tick,
                trigger=CronTrigger(day_of_week="mon", hour=7, minute=0, timezone="Europe/London"),
                id="editorial_autopilot_weekly",
                name="Editorial Autopilot — weekly competitor-driven article publishing",
                replace_existing=True,
                misfire_grace_time=3600,
            )
            logger.info("Added Editorial Autopilot weekly job (Mon 07:00 BST)")

            # CATCH-UP: Railway / Kubernetes redeploys reset the in-memory
            # scheduler. If today is Monday and we missed the 07:00 BST
            # tick (i.e. service started up later in the day), run it
            # 5 minutes after startup so the autopilot doesn't skip a
            # whole week.
            try:
                from datetime import datetime as _dt
                from zoneinfo import ZoneInfo
                bst_now = _dt.now(ZoneInfo("Europe/London"))
                # Monday = weekday 0; only catch up on Monday and only
                # if we're past 07:30 BST (giving the regular tick a
                # chance to fire normally if the deploy was earlier).
                if bst_now.weekday() == 0 and bst_now.hour >= 7 and (bst_now.hour > 7 or bst_now.minute >= 30):
                    catchup_at = _dt.now(timezone.utc) + timedelta(minutes=5)
                    sched.add_job(
                        _editorial_weekly_tick,
                        trigger="date",
                        run_date=catchup_at,
                        id="editorial_autopilot_catchup",
                        name="Editorial Autopilot — Monday catch-up after deploy",
                        replace_existing=True,
                        misfire_grace_time=3600,
                    )
                    logger.info("Added Editorial Autopilot Monday catch-up at %s", catchup_at)
            except Exception as catchup_err:  # noqa: BLE001
                logger.warning(f"Could not schedule Editorial Autopilot catch-up: {catchup_err}")
        except Exception as eap_err:  # noqa: BLE001
            logger.warning(f"Could not add Editorial Autopilot job: {eap_err}")

        # Stealth-Keyword Performance digest — Mon 08:00 BST, one hour
        # after Editorial Autopilot so the two digests don't land in
        # the same minute. Idempotent: skips if disabled, recently
        # sent, or there's nothing to report yet.
        try:
            from services.stealth_seo_digest import run_weekly_digest_if_due

            async def _stealth_digest_tick():
                try:
                    res = await run_weekly_digest_if_due()
                    logger.info(f"Stealth digest weekly run: {res}")
                except Exception as e:  # noqa: BLE001
                    logger.exception(f"stealth digest weekly run failed: {e}")

            sched.add_job(
                _stealth_digest_tick,
                trigger=CronTrigger(day_of_week="mon", hour=8, minute=0, timezone="Europe/London"),
                id="stealth_keyword_digest_weekly",
                name="Stealth-Keyword Performance — weekly digest email",
                replace_existing=True,
                misfire_grace_time=3600,
            )
            logger.info("Added Stealth-Keyword digest weekly job (Mon 08:00 BST)")
        except Exception as sd_err:  # noqa: BLE001
            logger.warning(f"Could not add Stealth-Keyword digest job: {sd_err}")

        # Stealth-Keyword Attribution Timeline — daily cache refresh
        # at 09:00 BST (after GSC has finalised yesterday's data).
        # Pulls per-query-per-day GSC rows and writes matched
        # keyword-date rows to `seo_stealth_kw_timeline`.
        try:
            from services.stealth_seo_kw_attribution import rebuild_timeline_cache

            async def _attribution_cache_tick():
                try:
                    res = await rebuild_timeline_cache(days=28)
                    logger.info(f"Stealth attribution cache refresh: {res}")
                except Exception as e:  # noqa: BLE001
                    logger.exception(f"attribution cache refresh failed: {e}")

            sched.add_job(
                _attribution_cache_tick,
                trigger=CronTrigger(hour=9, minute=0, timezone="Europe/London"),
                id="stealth_keyword_attribution_daily",
                name="Stealth-Keyword Attribution — daily timeline cache rebuild",
                replace_existing=True,
                misfire_grace_time=3600,
            )
            logger.info("Added Stealth-Keyword attribution daily job (09:00 BST)")
        except Exception as ak_err:  # noqa: BLE001
            logger.warning(f"Could not add Stealth-Keyword attribution daily job: {ak_err}")

        # NOTE: Sample → Order Followup is intentionally MANUAL-ONLY.
        # The owner reviews each candidate in the admin "Pending Sample
        # Followups" panel and clicks Send. No daily cron auto-emails.

        # Start the scheduler
        sched.start()
        logger.info(f"Scheduler started with {len(schedules)} scheduled jobs")
        
    except Exception as e:
        logger.error(f"Failed to initialize scheduler: {e}")


async def shutdown_scheduler():
    """Shutdown the scheduler gracefully"""
    global scheduler
    
    if scheduler and scheduler.running:
        scheduler.shutdown(wait=False)
        logger.info("Scheduler shutdown complete")


def get_scheduler_status() -> Dict[str, Any]:
    """Get the current status of the scheduler"""
    sched = get_scheduler()
    
    jobs = []
    if sched.running:
        for job in sched.get_jobs():
            jobs.append({
                "id": job.id,
                "name": job.name,
                "next_run": job.next_run_time.isoformat() if job.next_run_time else None,
                "trigger": str(job.trigger)
            })
    
    return {
        "running": sched.running,
        "job_count": len(jobs),
        "jobs": jobs
    }


# ----- UI Health daily job helpers (used by initialize_scheduler + admin PUT) -----
UI_HEALTH_JOB_ID = "ui_health_daily_report"


async def _ui_health_daily_tick():
    """Hourly probe — only fires when wall-clock UTC hour matches the
    configured hour AND the job is enabled. We use an hourly probe so the
    schedule update endpoint doesn't need to restart the scheduler."""
    try:
        db_local = get_db()
        doc = await db_local.website_settings.find_one(
            {"_id": "ui_health_schedule"}, {"_id": 0}
        )
        settings = doc or {}
        if not settings.get("enabled", True):
            return  # explicitly disabled

        target_hour = int(settings.get("hour_utc", 3))
        now_utc = datetime.now(timezone.utc)
        if now_utc.hour != target_hour:
            return

        from routes.website_admin import run_ui_health_now_and_email
        result = await run_ui_health_now_and_email(triggered_by="daily-cron")
        logger.info(f"UI health daily run: {result}")
    except Exception as e:
        logger.warning(f"UI health daily tick failed: {e}")


async def _add_ui_health_job(sched):
    """Adds (or re-adds) the daily UI health hourly-probe job."""
    sched.add_job(
        _ui_health_daily_tick,
        trigger=CronTrigger(minute=10),  # 10 past every hour, off-peak
        id=UI_HEALTH_JOB_ID,
        name="Daily UI health PDF report",
        replace_existing=True,
        misfire_grace_time=600,
    )


async def reschedule_ui_health_job():
    """Called from the admin schedule PUT endpoint — no-op since the job
    already probes hourly and self-gates on the configured hour. Kept as
    an indirection so the route never imports scheduler internals."""
    sched = get_scheduler()
    if not sched.running:
        return
    await _add_ui_health_job(sched)


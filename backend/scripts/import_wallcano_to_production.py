"""
Wallcano Products Import Script for Production
===============================================
Run this script on your Railway production environment to import the processed Wallcano products.

Usage:
    python import_wallcano_to_production.py

This script will:
1. Clear existing Wallcano products (optional - set CLEAR_EXISTING=True)
2. Import all 79 Wallcano products with:
   - New unique product names (product_name field)
   - Cost prices from supplier price list
   - Calculated list prices (cost x 2.28, rounded to .99)
   - Stock levels from latest sync
"""

import json
import os
from datetime import datetime, timezone
from pymongo import MongoClient

# Configuration
CLEAR_EXISTING = True  # Set to True to delete existing Wallcano products first
MONGO_URL = os.environ.get('MONGO_URL', 'mongodb://localhost:27017')
DB_NAME = os.environ.get('DB_NAME', 'test_database')

# Product data - embedded for easy deployment
WALLCANO_PRODUCTS = """REPLACE_WITH_DATA"""

def import_products():
    """Import Wallcano products to production database"""
    
    # Connect to database
    client = MongoClient(MONGO_URL)
    db = client[DB_NAME]
    
    # Load product data
    if WALLCANO_PRODUCTS == "REPLACE_WITH_DATA":
        # Try to load from file
        try:
            with open('wallcano_products_export.json', 'r') as f:
                products = json.load(f)
        except FileNotFoundError:
            print("ERROR: Product data not found. Please download wallcano_products_export.json")
            return
    else:
        products = json.loads(WALLCANO_PRODUCTS)
    
    print(f"Found {len(products)} Wallcano products to import")
    
    # Clear existing if configured
    if CLEAR_EXISTING:
        existing = db.supplier_products.count_documents({'supplier': 'Wallcano'})
        if existing > 0:
            result = db.supplier_products.delete_many({'supplier': 'Wallcano'})
            print(f"Cleared {result.deleted_count} existing Wallcano products")
    
    # Import products
    imported = 0
    updated = 0
    errors = 0
    
    for product in products:
        try:
            # Convert ISO date strings back to datetime
            for date_field in ['created_at', 'last_synced', 'last_processed']:
                if product.get(date_field) and isinstance(product[date_field], str):
                    try:
                        product[date_field] = datetime.fromisoformat(product[date_field].replace('Z', '+00:00'))
                    except Exception:
                        pass
            
            # Upsert the product
            result = db.supplier_products.update_one(
                {'supplier': 'Wallcano', 'sku': product.get('sku')},
                {'$set': product},
                upsert=True
            )
            
            if result.upserted_id:
                imported += 1
            elif result.modified_count > 0:
                updated += 1
            else:
                imported += 1  # Count as imported even if no change
                
        except Exception as e:
            print(f"Error importing {product.get('sku')}: {e}")
            errors += 1
    
    # Log the import
    db.sync_logs.insert_one({
        'supplier': 'Wallcano',
        'source': 'production_import',
        'timestamp': datetime.now(timezone.utc),
        'products_imported': imported,
        'products_updated': updated,
        'errors': errors,
        'note': 'Imported processed products with pricing from preview environment'
    })
    
    print()
    print("=" * 50)
    print("IMPORT COMPLETE")
    print("=" * 50)
    print(f"Imported: {imported}")
    print(f"Updated: {updated}")
    print(f"Errors: {errors}")
    print()
    
    # Verify
    final_count = db.supplier_products.count_documents({'supplier': 'Wallcano'})
    with_pricing = db.supplier_products.count_documents({'supplier': 'Wallcano', 'price': {'$gt': 0}})
    print(f"Total Wallcano products in database: {final_count}")
    print(f"Products with pricing: {with_pricing}")

if __name__ == '__main__':
    import_products()

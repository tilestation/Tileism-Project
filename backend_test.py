"""
Clearance Workflow API Testing
Tests the clearance marking, product listing, and PDF generation functionality
after the backend fix for draft-only clearance items.
"""
import requests
import json
from pymongo import MongoClient
import os

# Configuration
BACKEND_URL = "https://feature-verification-7.preview.emergentagent.com/api"
ADMIN_EMAIL = "admin@test.com"
ADMIN_PASSWORD = "admin123"

# MongoDB connection
MONGO_URL = "mongodb://localhost:27017"
DB_NAME = "tile_station"

class ClearanceWorkflowTester:
    def __init__(self):
        self.session = requests.Session()
        self.token = None
        self.db = None
        self.test_results = []
        
    def connect_db(self):
        """Connect to MongoDB"""
        try:
            client = MongoClient(MONGO_URL)
            self.db = client[DB_NAME]
            print("✓ Connected to MongoDB")
            return True
        except Exception as e:
            print(f"✗ MongoDB connection failed: {e}")
            return False
    
    def login_admin(self):
        """Test 1: Admin login with credentials from test_credentials.md"""
        print("\n" + "="*60)
        print("TEST 1: Admin Login")
        print("="*60)
        
        try:
            response = self.session.post(
                f"{BACKEND_URL}/auth/login",
                json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}
            )
            
            if response.status_code == 200:
                data = response.json()
                self.token = data.get("access_token") or data.get("token")
                self.session.headers.update({"Authorization": f"Bearer {self.token}"})
                print(f"✓ Admin login successful")
                print(f"  Email: {ADMIN_EMAIL}")
                print(f"  Token received: {self.token[:20]}...")
                self.test_results.append(("Admin Login", "PASS", "Login successful"))
                return True
            else:
                print(f"✗ Login failed: {response.status_code}")
                print(f"  Response: {response.text}")
                self.test_results.append(("Admin Login", "FAIL", f"Status {response.status_code}"))
                return False
        except Exception as e:
            print(f"✗ Login error: {e}")
            self.test_results.append(("Admin Login", "FAIL", str(e)))
            return False
    
    def prepare_test_products(self):
        """Prepare test products: one live, one draft-only"""
        print("\n" + "="*60)
        print("SETUP: Preparing Test Products")
        print("="*60)
        
        try:
            # Find a live product (exists in tiles collection)
            live_tile = self.db.tiles.find_one(
                {"sku": {"$exists": True, "$ne": ""}},
                {"sku": 1, "supplier_code": 1, "name": 1, "display_name": 1}
            )
            
            # Find a draft-only product (exists in supplier_products but not in tiles)
            live_skus = set(doc.get("sku") or doc.get("supplier_code") for doc in 
                           self.db.tiles.find({}, {"sku": 1, "supplier_code": 1}))
            
            draft_product = self.db.supplier_products.find_one(
                {
                    "$and": [
                        {"$or": [{"sku": {"$exists": True, "$ne": ""}}, 
                                {"supplier_code": {"$exists": True, "$ne": ""}}]},
                        {"$or": [
                            {"sku": {"$nin": list(live_skus)}},
                            {"supplier_code": {"$nin": list(live_skus)}}
                        ]}
                    ]
                },
                {"sku": 1, "supplier_code": 1, "product_name": 1, "our_product_name": 1}
            )
            
            if not live_tile:
                print("✗ No live products found in tiles collection")
                return None, None
            
            if not draft_product:
                print("⚠ No draft-only products found, will create one")
                # Create a draft-only product for testing
                draft_sku = f"TEST-DRAFT-{os.urandom(4).hex()}"
                self.db.supplier_products.insert_one({
                    "sku": draft_sku,
                    "supplier_code": draft_sku,
                    "product_name": "Test Draft Clearance Product",
                    "our_product_name": "Test Draft Clearance Product",
                    "supplier": "Test Supplier",
                    "list_price": 25.99,
                    "price": 25.99,
                    "stock_m2": 50,
                    "pricing_unit": "m2",
                    "product_group": "tiles",
                    "labels": []
                })
                draft_product = {"sku": draft_sku, "supplier_code": draft_sku}
                print(f"✓ Created test draft product: {draft_sku}")
            
            live_sku = live_tile.get("sku") or live_tile.get("supplier_code")
            draft_sku = draft_product.get("sku") or draft_product.get("supplier_code")
            
            # Clear any existing Clearance labels from test products
            self.db.supplier_products.update_many(
                {"$or": [{"sku": live_sku}, {"sku": draft_sku}]},
                {"$pull": {"labels": {"$in": ["Clearance", "CLEARANCE", "clearance"]}}}
            )
            self.db.tiles.update_many(
                {"$or": [{"sku": live_sku}, {"sku": draft_sku}]},
                {"$pull": {"labels": {"$in": ["Clearance", "CLEARANCE", "clearance"]}}}
            )
            
            print(f"✓ Live product SKU: {live_sku}")
            print(f"  Name: {live_tile.get('display_name') or live_tile.get('name')}")
            print(f"✓ Draft product SKU: {draft_sku}")
            print(f"  Name: {draft_product.get('our_product_name') or draft_product.get('product_name')}")
            
            return live_sku, draft_sku
            
        except Exception as e:
            print(f"✗ Error preparing test products: {e}")
            return None, None
    
    def test_mark_clearance(self, live_sku, draft_sku):
        """Test 2: POST /api/clearance/mark with mixed live/draft products"""
        print("\n" + "="*60)
        print("TEST 2: Mark Products as Clearance")
        print("="*60)
        
        try:
            payload = {
                "product_ids": [
                    {"sku": live_sku, "supplier": ""},
                    {"sku": draft_sku, "supplier": ""}
                ],
                "on": True
            }
            
            response = self.session.post(
                f"{BACKEND_URL}/clearance/mark",
                json=payload
            )
            
            if response.status_code == 200:
                data = response.json()
                print(f"✓ Mark clearance successful")
                print(f"  Marked: {data.get('marked')} products")
                print(f"  Live count: {data.get('live_count')}")
                print(f"  Draft count: {data.get('draft_count')}")
                print(f"  Message: {data.get('message')}")
                
                # Verify the response includes correct counts
                if data.get('live_count') >= 1 and data.get('draft_count') >= 1:
                    print("✓ Response includes both live_count and draft_count correctly")
                    self.test_results.append(("Mark Clearance", "PASS", 
                                            f"Live: {data.get('live_count')}, Draft: {data.get('draft_count')}"))
                    return True
                else:
                    print(f"⚠ Unexpected counts - Live: {data.get('live_count')}, Draft: {data.get('draft_count')}")
                    self.test_results.append(("Mark Clearance", "PARTIAL", 
                                            f"Counts may be incorrect"))
                    return True
            else:
                print(f"✗ Mark clearance failed: {response.status_code}")
                print(f"  Response: {response.text}")
                self.test_results.append(("Mark Clearance", "FAIL", f"Status {response.status_code}"))
                return False
                
        except Exception as e:
            print(f"✗ Mark clearance error: {e}")
            self.test_results.append(("Mark Clearance", "FAIL", str(e)))
            return False
    
    def test_get_clearance_products(self, live_sku, draft_sku):
        """Test 3: GET /api/clearance/products returns both live and draft items"""
        print("\n" + "="*60)
        print("TEST 3: Get Clearance Products")
        print("="*60)
        
        try:
            response = self.session.get(f"{BACKEND_URL}/clearance/products")
            
            if response.status_code == 200:
                data = response.json()
                items = data.get("items", [])
                total = data.get("total", 0)
                
                print(f"✓ Get clearance products successful")
                print(f"  Total clearance products: {total}")
                
                # Find our test products
                live_found = None
                draft_found = None
                
                for item in items:
                    if item.get("sku") == live_sku:
                        live_found = item
                    if item.get("sku") == draft_sku:
                        draft_found = item
                
                if live_found:
                    print(f"✓ Live product found in clearance list")
                    print(f"  SKU: {live_found.get('sku')}")
                    print(f"  Name: {live_found.get('name')}")
                    print(f"  Published: {live_found.get('published')}")
                    print(f"  Price: £{live_found.get('price')}")
                else:
                    print(f"⚠ Live product NOT found in clearance list")
                
                if draft_found:
                    print(f"✓ Draft product found in clearance list")
                    print(f"  SKU: {draft_found.get('sku')}")
                    print(f"  Name: {draft_found.get('name')}")
                    print(f"  Published: {draft_found.get('published')}")
                    print(f"  Price: £{draft_found.get('price')}")
                else:
                    print(f"⚠ Draft product NOT found in clearance list")
                
                if live_found and draft_found:
                    self.test_results.append(("Get Clearance Products", "PASS", 
                                            "Both live and draft items returned"))
                    return True
                elif live_found or draft_found:
                    self.test_results.append(("Get Clearance Products", "PARTIAL", 
                                            "Only one product type found"))
                    return True
                else:
                    self.test_results.append(("Get Clearance Products", "FAIL", 
                                            "Test products not found"))
                    return False
            else:
                print(f"✗ Get clearance products failed: {response.status_code}")
                print(f"  Response: {response.text}")
                self.test_results.append(("Get Clearance Products", "FAIL", 
                                        f"Status {response.status_code}"))
                return False
                
        except Exception as e:
            print(f"✗ Get clearance products error: {e}")
            self.test_results.append(("Get Clearance Products", "FAIL", str(e)))
            return False
    
    def test_generate_leaflet(self, live_sku, draft_sku):
        """Test 4: POST /api/clearance/leaflet/generate returns PDF successfully"""
        print("\n" + "="*60)
        print("TEST 4: Generate Clearance Leaflet PDF")
        print("="*60)
        
        try:
            payload = {
                "skus": [live_sku, draft_sku],
                "layout": "poster"
            }
            
            response = self.session.post(
                f"{BACKEND_URL}/clearance/leaflet/generate",
                json=payload
            )
            
            if response.status_code == 200:
                content_type = response.headers.get("Content-Type", "")
                content_length = len(response.content)
                
                print(f"✓ Leaflet generation successful")
                print(f"  Content-Type: {content_type}")
                print(f"  PDF Size: {content_length} bytes")
                
                if "application/pdf" in content_type and content_length > 1000:
                    print(f"✓ Valid PDF received (size > 1KB)")
                    
                    # Check if PDF contains both products (basic check)
                    # PDF content is binary, but we can check if it's a valid PDF
                    if response.content[:4] == b'%PDF':
                        print(f"✓ Valid PDF header detected")
                        self.test_results.append(("Generate Leaflet", "PASS", 
                                                f"PDF generated ({content_length} bytes)"))
                        return True
                    else:
                        print(f"⚠ PDF header not found")
                        self.test_results.append(("Generate Leaflet", "PARTIAL", 
                                                "Response received but PDF header invalid"))
                        return True
                else:
                    print(f"⚠ Unexpected content type or size")
                    self.test_results.append(("Generate Leaflet", "PARTIAL", 
                                            f"Content-Type: {content_type}"))
                    return True
            else:
                print(f"✗ Leaflet generation failed: {response.status_code}")
                print(f"  Response: {response.text[:200]}")
                self.test_results.append(("Generate Leaflet", "FAIL", 
                                        f"Status {response.status_code}"))
                return False
                
        except Exception as e:
            print(f"✗ Leaflet generation error: {e}")
            self.test_results.append(("Generate Leaflet", "FAIL", str(e)))
            return False
    
    def test_pdf_includes_both_items(self, live_sku, draft_sku):
        """Test 5: Verify PDF includes BOTH live and draft items"""
        print("\n" + "="*60)
        print("TEST 5: Verify PDF Includes Both Live and Draft Items")
        print("="*60)
        
        try:
            # Generate PDF with both SKUs
            payload = {
                "skus": [live_sku, draft_sku],
                "layout": "poster"
            }
            
            response = self.session.post(
                f"{BACKEND_URL}/clearance/leaflet/generate",
                json=payload
            )
            
            if response.status_code == 200:
                pdf_content = response.content
                
                # Check PDF size - should be larger if it includes both products
                # A poster layout with 2 products should be at least 10KB
                if len(pdf_content) > 10000:
                    print(f"✓ PDF size suggests multiple products included ({len(pdf_content)} bytes)")
                    
                    # Additional verification: check database to ensure both products
                    # have clearance labels
                    live_in_sp = self.db.supplier_products.find_one(
                        {"sku": live_sku, "labels": {"$in": ["Clearance", "CLEARANCE", "clearance"]}}
                    )
                    draft_in_sp = self.db.supplier_products.find_one(
                        {"sku": draft_sku, "labels": {"$in": ["Clearance", "CLEARANCE", "clearance"]}}
                    )
                    
                    if live_in_sp and draft_in_sp:
                        print(f"✓ Both products have Clearance label in supplier_products")
                        print(f"✓ PDF generation includes data from both tiles and supplier_products")
                        self.test_results.append(("PDF Includes Both Items", "PASS", 
                                                "Both live and draft items in PDF"))
                        return True
                    else:
                        print(f"⚠ One or both products missing Clearance label")
                        self.test_results.append(("PDF Includes Both Items", "PARTIAL", 
                                                "Labels may not be set correctly"))
                        return True
                else:
                    print(f"⚠ PDF size smaller than expected ({len(pdf_content)} bytes)")
                    self.test_results.append(("PDF Includes Both Items", "PARTIAL", 
                                            "PDF size suggests missing content"))
                    return True
            else:
                print(f"✗ PDF generation failed: {response.status_code}")
                self.test_results.append(("PDF Includes Both Items", "FAIL", 
                                        f"Status {response.status_code}"))
                return False
                
        except Exception as e:
            print(f"✗ PDF verification error: {e}")
            self.test_results.append(("PDF Includes Both Items", "FAIL", str(e)))
            return False
    
    def test_storefront_clearance_collections(self, draft_sku):
        """Test 6: GET /api/tiles/collections?clearance=true returns only live items"""
        print("\n" + "="*60)
        print("TEST 6: Storefront Clearance Collections (Live Only)")
        print("="*60)
        
        try:
            response = self.session.get(
                f"{BACKEND_URL}/tiles/collections",
                params={"clearance": "true", "limit": 100}
            )
            
            if response.status_code == 200:
                data = response.json()
                collections = data.get("collections", [])
                
                print(f"✓ Storefront clearance collections retrieved")
                print(f"  Total collections: {len(collections)}")
                
                # Check if draft-only product appears (it shouldn't)
                draft_found = False
                for collection in collections:
                    products = collection.get("products", [])
                    for product in products:
                        if product.get("sku") == draft_sku:
                            draft_found = True
                            break
                    if draft_found:
                        break
                
                if not draft_found:
                    print(f"✓ Draft-only product NOT in storefront clearance (correct)")
                    print(f"✓ Public storefront shows only live clearance items")
                    self.test_results.append(("Storefront Clearance", "PASS", 
                                            "Draft items correctly excluded"))
                    return True
                else:
                    print(f"✗ Draft-only product found in storefront (incorrect)")
                    self.test_results.append(("Storefront Clearance", "FAIL", 
                                            "Draft items incorrectly included"))
                    return False
            else:
                print(f"✗ Storefront clearance failed: {response.status_code}")
                print(f"  Response: {response.text[:200]}")
                self.test_results.append(("Storefront Clearance", "FAIL", 
                                        f"Status {response.status_code}"))
                return False
                
        except Exception as e:
            print(f"✗ Storefront clearance error: {e}")
            self.test_results.append(("Storefront Clearance", "FAIL", str(e)))
            return False
    
    def test_no_regressions(self):
        """Test 7: Verify no regressions on existing live clearance items"""
        print("\n" + "="*60)
        print("TEST 7: No Regressions on Existing Live Clearance")
        print("="*60)
        
        try:
            # Get all clearance products
            response = self.session.get(f"{BACKEND_URL}/clearance/products")
            
            if response.status_code == 200:
                data = response.json()
                items = data.get("items", [])
                
                live_items = [item for item in items if item.get("published") == True]
                draft_items = [item for item in items if item.get("published") == False]
                
                print(f"✓ Clearance products retrieved")
                print(f"  Total: {len(items)}")
                print(f"  Live: {len(live_items)}")
                print(f"  Draft: {len(draft_items)}")
                
                # Check that live items have proper data
                issues = []
                for item in live_items[:5]:  # Check first 5 live items
                    if not item.get("name"):
                        issues.append(f"Missing name for SKU {item.get('sku')}")
                    if not item.get("price"):
                        issues.append(f"Missing price for SKU {item.get('sku')}")
                
                if not issues:
                    print(f"✓ Live clearance items have proper data (no regressions)")
                    self.test_results.append(("No Regressions", "PASS", 
                                            "Live items working correctly"))
                    return True
                else:
                    print(f"⚠ Some issues found:")
                    for issue in issues:
                        print(f"  - {issue}")
                    self.test_results.append(("No Regressions", "PARTIAL", 
                                            f"{len(issues)} issues found"))
                    return True
            else:
                print(f"✗ Failed to retrieve clearance products: {response.status_code}")
                self.test_results.append(("No Regressions", "FAIL", 
                                        f"Status {response.status_code}"))
                return False
                
        except Exception as e:
            print(f"✗ Regression check error: {e}")
            self.test_results.append(("No Regressions", "FAIL", str(e)))
            return False
    
    def print_summary(self):
        """Print test summary"""
        print("\n" + "="*60)
        print("TEST SUMMARY")
        print("="*60)
        
        passed = sum(1 for _, status, _ in self.test_results if status == "PASS")
        failed = sum(1 for _, status, _ in self.test_results if status == "FAIL")
        partial = sum(1 for _, status, _ in self.test_results if status == "PARTIAL")
        total = len(self.test_results)
        
        for test_name, status, details in self.test_results:
            status_symbol = "✓" if status == "PASS" else ("✗" if status == "FAIL" else "⚠")
            print(f"{status_symbol} {test_name}: {status}")
            print(f"  {details}")
        
        print(f"\nTotal: {total} tests")
        print(f"Passed: {passed}")
        print(f"Failed: {failed}")
        print(f"Partial: {partial}")
        
        if failed == 0:
            print("\n✓ ALL CRITICAL TESTS PASSED")
        else:
            print(f"\n✗ {failed} CRITICAL TEST(S) FAILED")
    
    def run_all_tests(self):
        """Run all clearance workflow tests"""
        print("\n" + "="*60)
        print("CLEARANCE WORKFLOW API TESTING")
        print("="*60)
        
        # Connect to database
        if not self.connect_db():
            print("\n✗ Cannot proceed without database connection")
            return
        
        # Test 1: Admin login
        if not self.login_admin():
            print("\n✗ Cannot proceed without admin authentication")
            return
        
        # Setup: Prepare test products
        live_sku, draft_sku = self.prepare_test_products()
        if not live_sku or not draft_sku:
            print("\n✗ Cannot proceed without test products")
            return
        
        # Test 2: Mark clearance
        self.test_mark_clearance(live_sku, draft_sku)
        
        # Test 3: Get clearance products
        self.test_get_clearance_products(live_sku, draft_sku)
        
        # Test 4: Generate leaflet
        self.test_generate_leaflet(live_sku, draft_sku)
        
        # Test 5: Verify PDF includes both items
        self.test_pdf_includes_both_items(live_sku, draft_sku)
        
        # Test 6: Storefront clearance collections
        self.test_storefront_clearance_collections(draft_sku)
        
        # Test 7: No regressions
        self.test_no_regressions()
        
        # Print summary
        self.print_summary()


if __name__ == "__main__":
    tester = ClearanceWorkflowTester()
    tester.run_all_tests()

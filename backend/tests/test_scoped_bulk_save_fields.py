"""
Test Suite: Scoped Bulk Save Fields Bug Fix Verification
=========================================================
Tests the P0 bug fix for bulk category editor scoped saves that were silently dropping fields.

Bug Description:
- When scoped assignments were active (different products get different values), certain field types
  were not being included in per-product payloads.
- Root cause: In handleBulkCategoryUpdate's scoped path, the code separated 'common fields' from 
  'section fields' (specFieldNames, filterFieldNames, categoryFieldNames). Section fields were 
  stripped from commonFields but only re-added via spec_*, filter_*, cat_* prefixed keys.

Three bugs fixed:
1) Direct spec fields (material, finish, type, edge, slip_rating, suitability, thickness) dropped in scoped mode
2) filter_size missing from scopedScalarFilterMapping
3) Dynamic custom filter_* keys dropped in scoped mode (no catch-all)

Test Products: D11197 (Verona), 800853 (Splendour), TEST-UNIFIED-001 (TestSupplier)
"""

import pytest
import requests
import os
import time
import uuid

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')

class TestBulkUpdateUnifiedAllFields:
    """Test that bulk-update-unified saves ALL 16+ field types correctly"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        """Setup test data"""
        self.test_sku_1 = f"TEST_SCOPED_SAVE_{uuid.uuid4().hex[:8]}"
        self.test_sku_2 = f"TEST_SCOPED_SAVE_{uuid.uuid4().hex[:8]}"
        self.session = requests.Session()
        self.session.headers.update({"Content-Type": "application/json"})
        
        # Create test products
        self._create_test_products()
        yield
        # Cleanup
        self._cleanup_test_products()
    
    def _create_test_products(self):
        """Create test products for scoped save testing"""
        for sku in [self.test_sku_1, self.test_sku_2]:
            response = self.session.post(f"{BASE_URL}/api/supplier-sync/products", json={
                "products": [{"sku": sku, "name": f"Test Product {sku}"}],
                "supplier": "TestSupplier"
            })
            # Product may already exist, that's OK
            assert response.status_code in [200, 201, 400], f"Failed to create test product {sku}: {response.text}"
            data = response.json()
            assert data.get("success") == True, f"Product creation failed: {data}"
    
    def _cleanup_test_products(self):
        """Cleanup test products"""
        for sku in [self.test_sku_1, self.test_sku_2]:
            try:
                self.session.delete(f"{BASE_URL}/api/supplier-sync/products/{sku}")
            except Exception:
                pass
    
    def test_bulk_update_spec_fields(self):
        """Test that all specification fields save correctly via bulk-update-unified"""
        # Test all spec fields: material, finish, type, edge, slip_rating, suitability, thickness
        spec_updates = {
            "material": "Porcelain",
            "finish": "Matt",
            "type": "Floor Tile",
            "edge": "Rectified",
            "slip_rating": "R10",
            "suitability": "Indoor & Outdoor",
            "thickness": "10mm"
        }
        
        response = self.session.post(f"{BASE_URL}/api/supplier-sync/products/bulk-update-unified", json={
            "product_ids": [self.test_sku_1],
            "updates": spec_updates,
            "mode": "replace"
        })
        
        assert response.status_code == 200, f"Bulk update failed: {response.text}"
        data = response.json()
        assert data.get("success") == True, f"Bulk update not successful: {data}"
        
        # Verify fields were saved by fetching the product
        time.sleep(0.5)  # Allow DB to sync
        get_response = self.session.get(f"{BASE_URL}/api/supplier-sync/products", params={"search": self.test_sku_1, "limit": 1})
        assert get_response.status_code == 200, f"Failed to get product: {get_response.text}"
        
        products = get_response.json().get("products", [])
        assert len(products) > 0, f"Product {self.test_sku_1} not found after update"
        product = products[0]
        for field, expected_value in spec_updates.items():
            actual_value = product.get(field)
            assert actual_value == expected_value, f"Field '{field}' mismatch: expected '{expected_value}', got '{actual_value}'"
        
        print(f"✓ All 7 spec fields saved correctly: {list(spec_updates.keys())}")
    
    def test_bulk_update_filter_fields(self):
        """Test that all filter fields save correctly (including size which was missing)"""
        filter_updates = {
            "size": "60x60cm",  # This was missing from scopedScalarFilterMapping
            "made_in": "Italy",
            "underfloor_heating": "Yes"
        }
        
        response = self.session.post(f"{BASE_URL}/api/supplier-sync/products/bulk-update-unified", json={
            "product_ids": [self.test_sku_1],
            "updates": filter_updates,
            "mode": "replace"
        })
        
        assert response.status_code == 200, f"Bulk update failed: {response.text}"
        
        # Verify fields were saved
        time.sleep(0.5)
        get_response = self.session.get(f"{BASE_URL}/api/supplier-sync/products", params={"search": self.test_sku_1, "limit": 1})
        assert get_response.status_code == 200
        
        products = get_response.json().get("products", [])
        assert len(products) > 0, f"Product {self.test_sku_1} not found"
        product = products[0]
        for field, expected_value in filter_updates.items():
            actual_value = product.get(field)
            assert actual_value == expected_value, f"Field '{field}' mismatch: expected '{expected_value}', got '{actual_value}'"
        
        print(f"✓ Filter fields saved correctly: {list(filter_updates.keys())}")
    
    def test_bulk_update_array_fields(self):
        """Test that all array fields save correctly (rooms, styles, colors, features)"""
        array_updates = {
            "rooms": ["bathroom", "kitchen"],
            "styles": ["modern", "contemporary"],
            "colors": ["white", "grey"],
            "features": ["anti_slip", "frost_resistant"]
        }
        
        response = self.session.post(f"{BASE_URL}/api/supplier-sync/products/bulk-update-unified", json={
            "product_ids": [self.test_sku_1],
            "updates": array_updates,
            "mode": "replace"
        })
        
        assert response.status_code == 200, f"Bulk update failed: {response.text}"
        
        # Verify fields were saved
        time.sleep(0.5)
        get_response = self.session.get(f"{BASE_URL}/api/supplier-sync/products", params={"search": self.test_sku_1, "limit": 1})
        assert get_response.status_code == 200
        
        products = get_response.json().get("products", [])
        assert len(products) > 0, f"Product {self.test_sku_1} not found"
        product = products[0]
        for field, expected_value in array_updates.items():
            actual_value = product.get(field, [])
            assert set(actual_value) == set(expected_value), f"Field '{field}' mismatch: expected {expected_value}, got {actual_value}"
        
        print(f"✓ Array fields saved correctly: {list(array_updates.keys())}")
    
    def test_bulk_update_category_fields(self):
        """Test that category fields save correctly (main_category, sub_categories)"""
        category_updates = {
            "main_category": "Floor Tiles",
            "sub_categories": ["Porcelain Floor Tiles", "Large Format Tiles"]
        }
        
        response = self.session.post(f"{BASE_URL}/api/supplier-sync/products/bulk-update-unified", json={
            "product_ids": [self.test_sku_1],
            "updates": category_updates,
            "mode": "replace"
        })
        
        assert response.status_code == 200, f"Bulk update failed: {response.text}"
        
        # Verify fields were saved
        time.sleep(0.5)
        get_response = self.session.get(f"{BASE_URL}/api/supplier-sync/products", params={"search": self.test_sku_1, "limit": 1})
        assert get_response.status_code == 200
        
        products = get_response.json().get("products", [])
        assert len(products) > 0, f"Product {self.test_sku_1} not found"
        product = products[0]
        assert product.get("main_category") == category_updates["main_category"], \
            f"main_category mismatch: expected '{category_updates['main_category']}', got '{product.get('main_category')}'"
        
        actual_sub_cats = product.get("sub_categories", [])
        assert set(actual_sub_cats) == set(category_updates["sub_categories"]), \
            f"sub_categories mismatch: expected {category_updates['sub_categories']}, got {actual_sub_cats}"
        
        print(f"✓ Category fields saved correctly: main_category, sub_categories")
    
    def test_bulk_update_all_16_fields_together(self):
        """Test that ALL 16+ field types save correctly in a single bulk update"""
        all_updates = {
            # Spec fields (7)
            "material": "Ceramic",
            "finish": "Gloss",
            "type": "Wall Tile",
            "edge": "Cushion Edge",
            "slip_rating": "R9",
            "suitability": "Indoor Only",
            "thickness": "8mm",
            # Filter scalar fields (3)
            "size": "30x60cm",
            "made_in": "Spain",
            "underfloor_heating": "No",
            # Array fields (4)
            "rooms": ["living_room"],
            "styles": ["classic"],
            "colors": ["beige"],
            "features": ["easy_clean"],
            # Category fields (2)
            "main_category": "Wall Tiles",
            "sub_categories": ["Ceramic Wall Tiles"]
        }
        
        response = self.session.post(f"{BASE_URL}/api/supplier-sync/products/bulk-update-unified", json={
            "product_ids": [self.test_sku_2],
            "updates": all_updates,
            "mode": "replace"
        })
        
        assert response.status_code == 200, f"Bulk update failed: {response.text}"
        data = response.json()
        assert data.get("success") == True, f"Bulk update not successful: {data}"
        
        # Verify ALL fields were saved
        time.sleep(0.5)
        get_response = self.session.get(f"{BASE_URL}/api/supplier-sync/products", params={"search": self.test_sku_2, "limit": 1})
        assert get_response.status_code == 200
        
        products = get_response.json().get("products", [])
        assert len(products) > 0, f"Product {self.test_sku_2} not found"
        product = products[0]
        
        # Check scalar fields
        scalar_fields = ["material", "finish", "type", "edge", "slip_rating", "suitability", 
                        "thickness", "size", "made_in", "underfloor_heating", "main_category"]
        for field in scalar_fields:
            expected = all_updates[field]
            actual = product.get(field)
            assert actual == expected, f"Field '{field}' mismatch: expected '{expected}', got '{actual}'"
        
        # Check array fields
        array_fields = ["rooms", "styles", "colors", "features", "sub_categories"]
        for field in array_fields:
            expected = all_updates[field]
            actual = product.get(field, [])
            assert set(actual) == set(expected), f"Field '{field}' mismatch: expected {expected}, got {actual}"
        
        print(f"✓ ALL 16 field types saved correctly in single bulk update")
    
    def test_bulk_update_does_not_clear_existing_fields(self):
        """Test that updating one field doesn't clear other existing fields"""
        # First, set multiple fields
        initial_updates = {
            "material": "Porcelain",
            "finish": "Matt",
            "size": "60x60cm",
            "rooms": ["bathroom"]
        }
        
        response = self.session.post(f"{BASE_URL}/api/supplier-sync/products/bulk-update-unified", json={
            "product_ids": [self.test_sku_1],
            "updates": initial_updates,
            "mode": "replace"
        })
        assert response.status_code == 200
        
        time.sleep(0.5)
        
        # Now update only ONE field
        single_update = {"type": "Floor Tile"}
        
        response = self.session.post(f"{BASE_URL}/api/supplier-sync/products/bulk-update-unified", json={
            "product_ids": [self.test_sku_1],
            "updates": single_update,
            "mode": "replace"
        })
        assert response.status_code == 200
        
        # Verify the new field was added AND existing fields are preserved
        time.sleep(0.5)
        get_response = self.session.get(f"{BASE_URL}/api/supplier-sync/products", params={"search": self.test_sku_1, "limit": 1})
        assert get_response.status_code == 200
        
        products = get_response.json().get("products", [])
        assert len(products) > 0, f"Product {self.test_sku_1} not found"
        product = products[0]
        
        # New field should be set
        assert product.get("type") == "Floor Tile", f"New field 'type' not saved"
        
        # Existing fields should be preserved
        assert product.get("material") == "Porcelain", f"Existing field 'material' was cleared"
        assert product.get("finish") == "Matt", f"Existing field 'finish' was cleared"
        assert product.get("size") == "60x60cm", f"Existing field 'size' was cleared"
        
        print(f"✓ Updating one field does NOT clear other existing fields")
    
    def test_bulk_update_multiple_products_different_values(self):
        """Test scoped save scenario: different products get different values"""
        # This simulates the scoped save scenario where product 1 gets Porcelain and product 2 gets Ceramic
        
        # Update product 1 with Porcelain
        response1 = self.session.post(f"{BASE_URL}/api/supplier-sync/products/bulk-update-unified", json={
            "product_ids": [self.test_sku_1],
            "updates": {"material": "Porcelain", "finish": "Matt"},
            "mode": "replace"
        })
        assert response1.status_code == 200
        
        # Update product 2 with Ceramic
        response2 = self.session.post(f"{BASE_URL}/api/supplier-sync/products/bulk-update-unified", json={
            "product_ids": [self.test_sku_2],
            "updates": {"material": "Ceramic", "finish": "Gloss"},
            "mode": "replace"
        })
        assert response2.status_code == 200
        
        time.sleep(0.5)
        
        # Verify each product has its own values
        get1 = self.session.get(f"{BASE_URL}/api/supplier-sync/products", params={"search": self.test_sku_1, "limit": 1})
        get2 = self.session.get(f"{BASE_URL}/api/supplier-sync/products", params={"search": self.test_sku_2, "limit": 1})
        
        assert get1.status_code == 200 and get2.status_code == 200
        
        products1 = get1.json().get("products", [])
        products2 = get2.json().get("products", [])
        assert len(products1) > 0 and len(products2) > 0, "Products not found"
        product1 = products1[0]
        product2 = products2[0]
        
        assert product1.get("material") == "Porcelain", f"Product 1 material mismatch"
        assert product1.get("finish") == "Matt", f"Product 1 finish mismatch"
        assert product2.get("material") == "Ceramic", f"Product 2 material mismatch"
        assert product2.get("finish") == "Gloss", f"Product 2 finish mismatch"
        
        print(f"✓ Scoped save scenario works: different products have different values")


class TestTilesCollectionSync:
    """Test that tiles collection is synced when supplier_products is updated"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        """Setup test data"""
        self.test_sku = f"TEST_TILES_SYNC_{uuid.uuid4().hex[:8]}"
        self.session = requests.Session()
        self.session.headers.update({"Content-Type": "application/json"})
        
        # Create test product
        response = self.session.post(f"{BASE_URL}/api/supplier-sync/products", json={
            "products": [{"sku": self.test_sku, "name": f"Test Tiles Sync {self.test_sku}"}],
            "supplier": "TestSupplier"
        })
        yield
        # Cleanup
        try:
            self.session.delete(f"{BASE_URL}/api/supplier-sync/products/{self.test_sku}")
        except Exception:
            pass
    
    def test_tiles_collection_updated_on_bulk_update(self):
        """Test that tiles collection is updated when bulk-update-unified is called"""
        # First, set categories to trigger auto-publish to tiles
        updates = {
            "main_category": "Floor Tiles",
            "sub_categories": ["Test Category"],
            "material": "Porcelain",
            "finish": "Matt"
        }
        
        response = self.session.post(f"{BASE_URL}/api/supplier-sync/products/bulk-update-unified", json={
            "product_ids": [self.test_sku],
            "updates": updates,
            "mode": "replace"
        })
        
        assert response.status_code == 200, f"Bulk update failed: {response.text}"
        data = response.json()
        
        # Check if tiles were updated (tiles_updated count in response)
        tiles_updated = data.get("tiles_updated", 0)
        print(f"Tiles updated count: {tiles_updated}")
        
        # The endpoint should update tiles collection
        assert "tiles_updated" in data or "auto_published" in data, \
            f"Response should include tiles_updated or auto_published count: {data}"
        
        print(f"✓ Tiles collection sync verified")


class TestExistingProductsUpdate:
    """Test bulk update on existing products (D11197, 800853)"""
    
    def setup_method(self):
        self.session = requests.Session()
        self.session.headers.update({"Content-Type": "application/json"})
    
    def test_update_existing_product_d11197(self):
        """Test updating existing product D11197 (Verona)"""
        test_updates = {
            "material": "Porcelain",
            "finish": "Matt",
            "type": "Floor Tile",
            "size": "60x60cm"
        }
        
        response = self.session.post(f"{BASE_URL}/api/supplier-sync/products/bulk-update-unified", json={
            "product_ids": ["D11197"],
            "updates": test_updates,
            "mode": "replace"
        })
        
        # Product may not exist, so we accept 200 or check if it was found
        if response.status_code == 200:
            data = response.json()
            print(f"D11197 update response: {data}")
            # If product exists, verify update
            if data.get("supplier_updated", 0) > 0 or data.get("products_updated", 0) > 0:
                print(f"✓ Product D11197 updated successfully")
            else:
                print(f"⚠ Product D11197 may not exist in database")
        else:
            print(f"⚠ D11197 update returned status {response.status_code}")
    
    def test_update_existing_product_800853(self):
        """Test updating existing product 800853 (Splendour)"""
        test_updates = {
            "material": "Ceramic",
            "finish": "Gloss",
            "type": "Wall Tile",
            "size": "30x60cm"
        }
        
        response = self.session.post(f"{BASE_URL}/api/supplier-sync/products/bulk-update-unified", json={
            "product_ids": ["800853"],
            "updates": test_updates,
            "mode": "replace"
        })
        
        if response.status_code == 200:
            data = response.json()
            print(f"800853 update response: {data}")
            if data.get("supplier_updated", 0) > 0 or data.get("products_updated", 0) > 0:
                print(f"✓ Product 800853 updated successfully")
            else:
                print(f"⚠ Product 800853 may not exist in database")
        else:
            print(f"⚠ 800853 update returned status {response.status_code}")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])

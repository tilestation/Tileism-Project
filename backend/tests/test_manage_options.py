"""
Test for Manage Options Modal functionality in Bulk Category Editor
Testing:
1. Update/Rename an existing option (PUT /api/supplier-sync/website-category-options/{category}/{option_id})
2. Add a new custom option (POST /api/supplier-sync/website-category-options)
3. Delete an option (DELETE /api/supplier-sync/website-category-options/{category}/{option_id})
"""

import pytest
import requests
import os
import time
import uuid

# Get the backend URL from environment - must include /api prefix for proper routing
BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')
if not BASE_URL:
    raise ValueError("REACT_APP_BACKEND_URL environment variable is required")

API_URL = f"{BASE_URL}/api/supplier-sync"


class TestWebsiteCategoryOptions:
    """Test suite for website category options CRUD operations"""
    
    # Generate unique test identifiers to avoid conflicts
    test_id = str(uuid.uuid4())[:8]
    
    def test_get_all_category_options(self):
        """Test GET /website-category-options returns all category options"""
        response = requests.get(f"{API_URL}/website-category-options")
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        
        data = response.json()
        
        # Verify expected categories exist
        expected_categories = ['rooms', 'types', 'materials', 'finishes', 'styles', 'colors', 'features']
        for category in expected_categories:
            assert category in data, f"Expected category '{category}' in response"
            assert isinstance(data[category], list), f"Expected '{category}' to be a list"
        
        # Verify each option has id and label
        for opt in data.get('materials', []):
            assert 'id' in opt or isinstance(opt, str), f"Option missing 'id': {opt}"
            if isinstance(opt, dict):
                assert 'label' in opt, f"Option missing 'label': {opt}"
        
        print(f"✓ GET /website-category-options returned {len(data)} categories")
        print(f"  Materials: {len(data.get('materials', []))} options")
        print(f"  Finishes: {len(data.get('finishes', []))} options")
    
    def test_add_custom_option(self):
        """Test POST /website-category-options - Add new custom option to a category"""
        unique_label = f"TestOption_{self.test_id}"
        unique_id = unique_label.lower().replace(' ', '_')
        
        payload = {
            "category_type": "materials",
            "id": unique_id,
            "label": unique_label,
            "color": "bg-gray-500"
        }
        
        response = requests.post(
            f"{API_URL}/website-category-options",
            json=payload
        )
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        
        data = response.json()
        assert data.get('success') is True or 'id' in data, f"Expected success response: {data}"
        
        print(f"✓ POST /website-category-options - Added '{unique_label}' to materials")
        
        # Verify the option exists in the list
        time.sleep(0.5)  # Small delay for DB write
        verify_response = requests.get(f"{API_URL}/website-category-options")
        verify_data = verify_response.json()
        
        materials = verify_data.get('materials', [])
        option_found = any(
            (isinstance(opt, dict) and opt.get('id') == unique_id) or
            (isinstance(opt, dict) and opt.get('label') == unique_label)
            for opt in materials
        )
        
        assert option_found, f"Added option '{unique_label}' not found in materials list"
        print(f"  ✓ Verified: '{unique_label}' exists in materials list")
        
        return unique_id, unique_label
    
    def test_update_rename_option(self):
        """Test PUT /website-category-options/{category}/{option_id} - Rename/update an option"""
        # First, add a test option to update
        unique_base = f"ToRename_{self.test_id}"
        unique_id = unique_base.lower().replace(' ', '_')
        
        # Add the option
        add_payload = {
            "category_type": "finishes",
            "id": unique_id,
            "label": unique_base,
            "color": "bg-gray-500"
        }
        
        add_response = requests.post(
            f"{API_URL}/website-category-options",
            json=add_payload
        )
        assert add_response.status_code == 200, f"Failed to add test option: {add_response.text}"
        print(f"✓ Created test option '{unique_base}' in finishes for update test")
        
        time.sleep(0.5)
        
        # Now update/rename the option using the FIXED endpoint with path params
        new_label = f"{unique_base}_RENAMED"
        
        update_response = requests.put(
            f"{API_URL}/website-category-options/finishes/{unique_id}",
            json={"label": new_label}
        )
        
        assert update_response.status_code == 200, f"Expected 200, got {update_response.status_code}: {update_response.text}"
        
        update_data = update_response.json()
        assert update_data.get('success') is True, f"Expected success=True in response: {update_data}"
        
        print(f"✓ PUT /website-category-options/finishes/{unique_id} - Renamed to '{new_label}'")
        
        # Verify the update persisted
        time.sleep(0.5)
        verify_response = requests.get(f"{API_URL}/website-category-options")
        verify_data = verify_response.json()
        
        finishes = verify_data.get('finishes', [])
        option_found = any(
            isinstance(opt, dict) and opt.get('label') == new_label
            for opt in finishes
        )
        
        assert option_found, f"Renamed option '{new_label}' not found in finishes list"
        print(f"  ✓ Verified: Option renamed to '{new_label}' in finishes list")
        
        return unique_id, new_label
    
    def test_update_default_option(self):
        """Test updating a DEFAULT option (not custom) - should create override"""
        # 'matt' is a default finish option
        default_option_id = "matt"
        new_label = f"Matt_Test_{self.test_id}"
        
        update_response = requests.put(
            f"{API_URL}/website-category-options/finishes/{default_option_id}",
            json={"label": new_label}
        )
        
        # This should work - creates an override for the default option
        assert update_response.status_code == 200, f"Expected 200, got {update_response.status_code}: {update_response.text}"
        
        update_data = update_response.json()
        assert update_data.get('success') is True, f"Expected success=True: {update_data}"
        
        print(f"✓ PUT updated default option 'matt' to '{new_label}'")
        
        # Verify the update
        time.sleep(0.5)
        verify_response = requests.get(f"{API_URL}/website-category-options")
        verify_data = verify_response.json()
        
        finishes = verify_data.get('finishes', [])
        option_found = any(
            isinstance(opt, dict) and opt.get('label') == new_label
            for opt in finishes
        )
        
        assert option_found, f"Updated default option '{new_label}' not found"
        print(f"  ✓ Verified: Default option 'matt' updated to '{new_label}'")
        
        # Revert the change back to original
        revert_response = requests.put(
            f"{API_URL}/website-category-options/finishes/{default_option_id}",
            json={"label": "Matt"}
        )
        print(f"  ✓ Reverted 'matt' back to 'Matt'")
    
    def test_delete_custom_option(self):
        """Test DELETE /website-category-options/{category}/{option_id} - Delete an option"""
        # First, add a test option to delete
        unique_label = f"ToDelete_{self.test_id}"
        unique_id = unique_label.lower().replace(' ', '_')
        
        # Add the option
        add_payload = {
            "category_type": "styles",
            "id": unique_id,
            "label": unique_label,
            "color": "bg-gray-500"
        }
        
        add_response = requests.post(
            f"{API_URL}/website-category-options",
            json=add_payload
        )
        assert add_response.status_code == 200, f"Failed to add test option: {add_response.text}"
        print(f"✓ Created test option '{unique_label}' in styles for delete test")
        
        time.sleep(0.5)
        
        # Verify option exists before delete
        verify_before = requests.get(f"{API_URL}/website-category-options")
        styles_before = verify_before.json().get('styles', [])
        option_exists_before = any(
            isinstance(opt, dict) and opt.get('id') == unique_id
            for opt in styles_before
        )
        assert option_exists_before, f"Test option '{unique_id}' should exist before delete"
        
        # Now delete the option
        delete_response = requests.delete(
            f"{API_URL}/website-category-options/styles/{unique_id}"
        )
        
        assert delete_response.status_code == 200, f"Expected 200, got {delete_response.status_code}: {delete_response.text}"
        
        delete_data = delete_response.json()
        assert delete_data.get('success') is True, f"Expected success=True: {delete_data}"
        
        print(f"✓ DELETE /website-category-options/styles/{unique_id} - Deleted option")
        
        # Verify the delete persisted (option should be gone)
        time.sleep(0.5)
        verify_after = requests.get(f"{API_URL}/website-category-options")
        styles_after = verify_after.json().get('styles', [])
        
        option_exists_after = any(
            isinstance(opt, dict) and opt.get('id') == unique_id
            for opt in styles_after
        )
        
        assert not option_exists_after, f"Deleted option '{unique_id}' should not exist after delete"
        print(f"  ✓ Verified: Option '{unique_id}' no longer exists in styles list")
    
    def test_update_with_invalid_category(self):
        """Test PUT with non-existent category - should handle gracefully"""
        response = requests.put(
            f"{API_URL}/website-category-options/invalid_category_xyz/some_option",
            json={"label": "Test"}
        )
        
        # Should return success=False or 4xx error, not crash
        if response.status_code == 200:
            data = response.json()
            # If 200, success should be False
            assert data.get('success') is False, f"Expected success=False for invalid category"
        else:
            # 4xx is also acceptable
            assert response.status_code in [400, 404], f"Expected 4xx for invalid category, got {response.status_code}"
        
        print(f"✓ Invalid category handled gracefully (status={response.status_code})")
    
    def test_update_with_invalid_option_id(self):
        """Test PUT with non-existent option_id - should return success=False"""
        response = requests.put(
            f"{API_URL}/website-category-options/materials/nonexistent_option_xyz",
            json={"label": "Test"}
        )
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        
        data = response.json()
        assert data.get('success') is False, f"Expected success=False for invalid option: {data}"
        
        print(f"✓ Invalid option_id handled gracefully (success=False)")
    
    def test_update_without_label(self):
        """Test PUT without label field - should return 400 error"""
        response = requests.put(
            f"{API_URL}/website-category-options/materials/porcelain",
            json={}  # No label field
        )
        
        assert response.status_code == 400, f"Expected 400 for missing label, got {response.status_code}"
        
        print(f"✓ Missing label returns 400 as expected")


class TestManageOptionsE2E:
    """End-to-end test simulating the Manage Options modal workflow"""
    
    test_id = str(uuid.uuid4())[:8]
    
    def test_full_crud_workflow(self):
        """Test the complete Add → Update → Delete workflow"""
        
        # Step 1: Get initial options
        print("\n=== E2E Test: Full CRUD Workflow ===")
        
        initial_response = requests.get(f"{API_URL}/website-category-options")
        assert initial_response.status_code == 200
        initial_data = initial_response.json()
        initial_materials_count = len(initial_data.get('materials', []))
        print(f"Step 0: Initial materials count = {initial_materials_count}")
        
        # Step 1: ADD a new option (simulates "Add Option" in modal)
        new_option_label = f"E2E_Test_Material_{self.test_id}"
        new_option_id = new_option_label.lower().replace(' ', '_').replace('e2e_', '')
        
        add_response = requests.post(
            f"{API_URL}/website-category-options",
            json={
                "category_type": "materials",
                "id": new_option_id,
                "label": new_option_label,
                "color": "bg-purple-500"
            }
        )
        assert add_response.status_code == 200, f"Add failed: {add_response.text}"
        print(f"Step 1: Added '{new_option_label}' to materials ✓")
        
        time.sleep(0.3)
        
        # Step 2: VERIFY the option was added
        after_add_response = requests.get(f"{API_URL}/website-category-options")
        after_add_data = after_add_response.json()
        after_add_count = len(after_add_data.get('materials', []))
        
        # Find the added option
        added_option = next(
            (opt for opt in after_add_data.get('materials', []) 
             if isinstance(opt, dict) and opt.get('label') == new_option_label),
            None
        )
        assert added_option is not None, f"Added option not found in materials list"
        print(f"Step 2: Verified option exists (count: {initial_materials_count} → {after_add_count}) ✓")
        
        # Step 3: UPDATE/RENAME the option (simulates editing in modal)
        renamed_label = f"{new_option_label}_RENAMED"
        
        update_response = requests.put(
            f"{API_URL}/website-category-options/materials/{new_option_id}",
            json={"label": renamed_label}
        )
        assert update_response.status_code == 200, f"Update failed: {update_response.text}"
        update_data = update_response.json()
        assert update_data.get('success') is True, f"Update success=False: {update_data}"
        print(f"Step 3: Renamed to '{renamed_label}' ✓")
        
        time.sleep(0.3)
        
        # Step 4: VERIFY the rename persisted
        after_update_response = requests.get(f"{API_URL}/website-category-options")
        after_update_data = after_update_response.json()
        
        renamed_option = next(
            (opt for opt in after_update_data.get('materials', [])
             if isinstance(opt, dict) and opt.get('label') == renamed_label),
            None
        )
        assert renamed_option is not None, f"Renamed option '{renamed_label}' not found"
        print(f"Step 4: Verified rename persisted ✓")
        
        # Step 5: DELETE the option (simulates delete in modal)
        delete_response = requests.delete(
            f"{API_URL}/website-category-options/materials/{new_option_id}"
        )
        assert delete_response.status_code == 200, f"Delete failed: {delete_response.text}"
        delete_data = delete_response.json()
        assert delete_data.get('success') is True, f"Delete success=False: {delete_data}"
        print(f"Step 5: Deleted option ✓")
        
        time.sleep(0.3)
        
        # Step 6: VERIFY the delete persisted
        after_delete_response = requests.get(f"{API_URL}/website-category-options")
        after_delete_data = after_delete_response.json()
        final_count = len(after_delete_data.get('materials', []))
        
        deleted_option = next(
            (opt for opt in after_delete_data.get('materials', [])
             if isinstance(opt, dict) and opt.get('id') == new_option_id),
            None
        )
        assert deleted_option is None, f"Deleted option should not exist"
        print(f"Step 6: Verified delete persisted (count: {after_add_count} → {final_count}) ✓")
        
        print(f"\n=== E2E Test PASSED ===")


# Cleanup test data after tests run
@pytest.fixture(autouse=True, scope="module")
def cleanup_test_options():
    """Cleanup any test options created during testing"""
    yield
    # After all tests, try to clean up test options
    try:
        response = requests.get(f"{API_URL}/website-category-options")
        if response.status_code == 200:
            data = response.json()
            for category, options in data.items():
                for opt in options:
                    if isinstance(opt, dict):
                        opt_id = opt.get('id', '')
                        opt_label = opt.get('label', '')
                        # Delete test options
                        if 'test_' in opt_id.lower() or 'e2e_' in opt_id.lower() or 'torename_' in opt_id.lower() or 'todelete_' in opt_id.lower():
                            try:
                                requests.delete(f"{API_URL}/website-category-options/{category}/{opt_id}")
                            except Exception:
                                pass
    except Exception:
        pass


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

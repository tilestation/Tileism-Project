"""
Test Collection Organizer API endpoints
Tests for drag-and-drop collection organizer feature in Site Map & Link Manager
"""
import pytest
import requests
import os
import time

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', 'https://feature-verification-7.preview.emergentagent.com')

class TestCollectionOrganizerSuppliers:
    """Tests for GET /api/website-admin/collection-organizer/suppliers"""
    
    def test_get_suppliers_returns_list(self):
        """Verify suppliers endpoint returns a list of suppliers with series counts"""
        response = requests.get(f"{BASE_URL}/api/website-admin/collection-organizer/suppliers")
        assert response.status_code == 200
        
        data = response.json()
        assert "suppliers" in data
        assert isinstance(data["suppliers"], list)
        assert len(data["suppliers"]) > 0
        
        # Verify supplier structure
        supplier = data["suppliers"][0]
        assert "name" in supplier
        assert "total_products" in supplier
        assert "series_count" in supplier
        assert isinstance(supplier["total_products"], int)
        assert isinstance(supplier["series_count"], int)
    
    def test_suppliers_sorted_by_product_count(self):
        """Verify suppliers are sorted by total_products descending"""
        response = requests.get(f"{BASE_URL}/api/website-admin/collection-organizer/suppliers")
        assert response.status_code == 200
        
        suppliers = response.json()["suppliers"]
        if len(suppliers) > 1:
            for i in range(len(suppliers) - 1):
                assert suppliers[i]["total_products"] >= suppliers[i+1]["total_products"]
    
    def test_plus39_supplier_has_series(self):
        """Verify Plus39 supplier exists and has series data"""
        response = requests.get(f"{BASE_URL}/api/website-admin/collection-organizer/suppliers")
        assert response.status_code == 200
        
        suppliers = response.json()["suppliers"]
        plus39 = next((s for s in suppliers if s["name"] == "Plus39"), None)
        assert plus39 is not None, "Plus39 supplier should exist"
        assert plus39["series_count"] > 0, "Plus39 should have series"


class TestCollectionOrganizerSeries:
    """Tests for GET /api/website-admin/collection-organizer/series"""
    
    def test_get_series_for_supplier(self):
        """Verify series endpoint returns series for a supplier"""
        response = requests.get(
            f"{BASE_URL}/api/website-admin/collection-organizer/series",
            params={"supplier": "Plus39"}
        )
        assert response.status_code == 200
        
        data = response.json()
        assert "supplier" in data
        assert data["supplier"] == "Plus39"
        assert "series" in data
        assert "total" in data
        assert isinstance(data["series"], list)
    
    def test_series_structure(self):
        """Verify series data structure includes required fields"""
        response = requests.get(
            f"{BASE_URL}/api/website-admin/collection-organizer/series",
            params={"supplier": "Plus39"}
        )
        assert response.status_code == 200
        
        series_list = response.json()["series"]
        assert len(series_list) > 0
        
        series = series_list[0]
        assert "name" in series
        assert "count" in series
        assert "sample_image" in series
        assert "product_groups" in series
        assert "main_categories" in series
        assert "sub_categories" in series
        assert "assignments" in series
        assert isinstance(series["count"], int)
        assert isinstance(series["sub_categories"], list)
    
    def test_series_includes_known_series(self):
        """Verify Plus39 has expected series (Travertine, Burlington, Artisan, Moonlight)"""
        response = requests.get(
            f"{BASE_URL}/api/website-admin/collection-organizer/series",
            params={"supplier": "Plus39"}
        )
        assert response.status_code == 200
        
        series_names = [s["name"] for s in response.json()["series"]]
        expected_series = ["Travertine", "Burlington", "Artisan", "Moonlight"]
        for expected in expected_series:
            assert expected in series_names, f"Expected series '{expected}' not found"


class TestCollectionOrganizerCategoryTree:
    """Tests for GET /api/website-admin/collection-organizer/category-tree"""
    
    def test_get_category_tree(self):
        """Verify category tree endpoint returns groups with categories"""
        response = requests.get(f"{BASE_URL}/api/website-admin/collection-organizer/category-tree")
        assert response.status_code == 200
        
        data = response.json()
        assert "groups" in data
        assert isinstance(data["groups"], list)
        assert len(data["groups"]) > 0
    
    def test_category_group_structure(self):
        """Verify category group structure"""
        response = requests.get(f"{BASE_URL}/api/website-admin/collection-organizer/category-tree")
        assert response.status_code == 200
        
        groups = response.json()["groups"]
        group = groups[0]
        
        assert "id" in group
        assert "name" in group
        assert "slug" in group
        assert "color" in group
        assert "icon" in group
        assert "categories" in group
        assert isinstance(group["categories"], list)
    
    def test_tiles_group_exists(self):
        """Verify Tiles group exists with categories"""
        response = requests.get(f"{BASE_URL}/api/website-admin/collection-organizer/category-tree")
        assert response.status_code == 200
        
        groups = response.json()["groups"]
        tiles_group = next((g for g in groups if g["slug"] == "tiles"), None)
        assert tiles_group is not None, "Tiles group should exist"
        assert len(tiles_group["categories"]) > 0, "Tiles group should have categories"
    
    def test_expected_groups_exist(self):
        """Verify expected category groups exist"""
        response = requests.get(f"{BASE_URL}/api/website-admin/collection-organizer/category-tree")
        assert response.status_code == 200
        
        group_slugs = [g["slug"] for g in response.json()["groups"]]
        expected_groups = ["tiles", "underfloor-heating", "materials", "tools", "accessories"]
        for expected in expected_groups:
            assert expected in group_slugs, f"Expected group '{expected}' not found"


class TestCollectionOrganizerAssign:
    """Tests for POST /api/website-admin/collection-organizer/assign"""
    
    def test_assign_series_to_category(self):
        """Test assigning a series to a category"""
        payload = {
            "supplier": "Plus39",
            "series": "Burlington",
            "group_slug": "tiles",
            "main_category": "Tiles",
            "sub_categories": ["Floor Tiles"]
        }
        response = requests.post(
            f"{BASE_URL}/api/website-admin/collection-organizer/assign",
            json=payload
        )
        assert response.status_code == 200
        
        data = response.json()
        assert data["success"] is True
        assert "message" in data
        assert "products_updated" in data
        assert "total_in_series" in data
        assert data["products_updated"] > 0
        
        # Verify assignment was applied
        verify_response = requests.get(
            f"{BASE_URL}/api/website-admin/collection-organizer/series",
            params={"supplier": "Plus39"}
        )
        assert verify_response.status_code == 200
        series_list = verify_response.json()["series"]
        burlington = next((s for s in series_list if s["name"] == "Burlington"), None)
        assert burlington is not None
        assert "Floor Tiles" in burlington["sub_categories"]
    
    def test_assign_requires_all_fields(self):
        """Test that assign endpoint requires all required fields"""
        # Missing series
        payload = {
            "supplier": "Plus39",
            "group_slug": "tiles",
            "main_category": "Tiles"
        }
        response = requests.post(
            f"{BASE_URL}/api/website-admin/collection-organizer/assign",
            json=payload
        )
        assert response.status_code == 400
    
    def test_assign_nonexistent_series_returns_404(self):
        """Test assigning a non-existent series returns 404"""
        payload = {
            "supplier": "Plus39",
            "series": "NonExistentSeries12345",
            "group_slug": "tiles",
            "main_category": "Tiles",
            "sub_categories": []
        }
        response = requests.post(
            f"{BASE_URL}/api/website-admin/collection-organizer/assign",
            json=payload
        )
        assert response.status_code == 404


class TestCollectionOrganizerUnassign:
    """Tests for POST /api/website-admin/collection-organizer/unassign"""
    
    def test_unassign_sub_category(self):
        """Test unassigning a specific sub-category from a series"""
        # First ensure Burlington is assigned
        assign_payload = {
            "supplier": "Plus39",
            "series": "Burlington",
            "group_slug": "tiles",
            "main_category": "Tiles",
            "sub_categories": ["Floor Tiles"]
        }
        requests.post(f"{BASE_URL}/api/website-admin/collection-organizer/assign", json=assign_payload)
        
        # Now unassign the sub-category
        unassign_payload = {
            "supplier": "Plus39",
            "series": "Burlington",
            "main_category": "Tiles",
            "sub_categories": ["Floor Tiles"]
        }
        response = requests.post(
            f"{BASE_URL}/api/website-admin/collection-organizer/unassign",
            json=unassign_payload
        )
        assert response.status_code == 200
        
        data = response.json()
        assert data["success"] is True
        assert "message" in data
        assert "products_updated" in data
        
        # Verify sub-category was removed
        verify_response = requests.get(
            f"{BASE_URL}/api/website-admin/collection-organizer/series",
            params={"supplier": "Plus39"}
        )
        series_list = verify_response.json()["series"]
        burlington = next((s for s in series_list if s["name"] == "Burlington"), None)
        assert burlington is not None
        assert "Floor Tiles" not in burlington["sub_categories"]
    
    def test_unassign_entire_category(self):
        """Test unassigning entire category (clearing main_category)"""
        # First assign
        assign_payload = {
            "supplier": "Plus39",
            "series": "Artisan",
            "group_slug": "tiles",
            "main_category": "Tiles",
            "sub_categories": []
        }
        requests.post(f"{BASE_URL}/api/website-admin/collection-organizer/assign", json=assign_payload)
        
        # Unassign without sub_categories (clears entire assignment)
        unassign_payload = {
            "supplier": "Plus39",
            "series": "Artisan",
            "main_category": "Tiles"
        }
        response = requests.post(
            f"{BASE_URL}/api/website-admin/collection-organizer/unassign",
            json=unassign_payload
        )
        assert response.status_code == 200
        
        data = response.json()
        assert data["success"] is True
        
        # Verify main_category was cleared
        verify_response = requests.get(
            f"{BASE_URL}/api/website-admin/collection-organizer/series",
            params={"supplier": "Plus39"}
        )
        series_list = verify_response.json()["series"]
        artisan = next((s for s in series_list if s["name"] == "Artisan"), None)
        assert artisan is not None
        assert len(artisan["main_categories"]) == 0
    
    def test_unassign_requires_supplier_and_series(self):
        """Test that unassign requires supplier and series"""
        payload = {"supplier": "Plus39"}  # Missing series
        response = requests.post(
            f"{BASE_URL}/api/website-admin/collection-organizer/unassign",
            json=payload
        )
        assert response.status_code == 400


class TestCollectionOrganizerIntegration:
    """Integration tests for full assign/unassign workflow"""
    
    def test_full_assign_unassign_workflow(self):
        """Test complete workflow: assign to multiple categories, then unassign"""
        # 1. Assign Moonlight to Tiles > Wall Tiles
        assign1 = {
            "supplier": "Plus39",
            "series": "Moonlight",
            "group_slug": "tiles",
            "main_category": "Tiles",
            "sub_categories": ["Wall Tiles"]
        }
        r1 = requests.post(f"{BASE_URL}/api/website-admin/collection-organizer/assign", json=assign1)
        assert r1.status_code == 200
        
        # 2. Verify assignment
        verify1 = requests.get(
            f"{BASE_URL}/api/website-admin/collection-organizer/series",
            params={"supplier": "Plus39"}
        )
        moonlight = next((s for s in verify1.json()["series"] if s["name"] == "Moonlight"), None)
        assert "Wall Tiles" in moonlight["sub_categories"]
        
        # 3. Unassign
        unassign = {
            "supplier": "Plus39",
            "series": "Moonlight",
            "main_category": "Tiles",
            "sub_categories": ["Wall Tiles"]
        }
        r2 = requests.post(f"{BASE_URL}/api/website-admin/collection-organizer/unassign", json=unassign)
        assert r2.status_code == 200
        
        # 4. Verify unassignment
        verify2 = requests.get(
            f"{BASE_URL}/api/website-admin/collection-organizer/series",
            params={"supplier": "Plus39"}
        )
        moonlight2 = next((s for s in verify2.json()["series"] if s["name"] == "Moonlight"), None)
        assert "Wall Tiles" not in moonlight2["sub_categories"]


# Cleanup fixture to reset test data after tests
@pytest.fixture(scope="module", autouse=True)
def cleanup_test_assignments():
    """Cleanup any test assignments after all tests complete"""
    yield
    # Cleanup: unassign all Plus39 series
    for series_name in ["Travertine", "Burlington", "Artisan", "Moonlight"]:
        try:
            requests.post(
                f"{BASE_URL}/api/website-admin/collection-organizer/unassign",
                json={"supplier": "Plus39", "series": series_name, "main_category": "Tiles"}
            )
        except Exception:
            pass

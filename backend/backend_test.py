import requests
import sys
from datetime import datetime
import json

class StockFlowAPITester:
    def __init__(self, base_url="https://feature-verification-7.preview.emergentagent.com"):
        self.base_url = base_url
        self.admin_token = None
        self.customer_token = None
        self.tests_run = 0
        self.tests_passed = 0
        self.created_category_id = None
        self.created_product_id = None
        self.created_order_id = None

    def run_test(self, name, method, endpoint, expected_status, data=None, token=None):
        """Run a single API test"""
        url = f"{self.base_url}/api/{endpoint}"
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['Authorization'] = f'Bearer {token}'

        self.tests_run += 1
        print(f"\n🔍 Testing {name}...")
        print(f"   URL: {url}")
        
        try:
            if method == 'GET':
                response = requests.get(url, headers=headers, timeout=10)
            elif method == 'POST':
                response = requests.post(url, json=data, headers=headers, timeout=10)
            elif method == 'PUT':
                response = requests.put(url, json=data, headers=headers, timeout=10)
            elif method == 'DELETE':
                response = requests.delete(url, headers=headers, timeout=10)

            success = response.status_code == expected_status
            if success:
                self.tests_passed += 1
                print(f"✅ Passed - Status: {response.status_code}")
                try:
                    return success, response.json()
                except Exception:
                    return success, {}
            else:
                print(f"❌ Failed - Expected {expected_status}, got {response.status_code}")
                try:
                    error_detail = response.json()
                    print(f"   Error: {error_detail}")
                except Exception:
                    print(f"   Response text: {response.text}")
                return False, {}

        except Exception as e:
            print(f"❌ Failed - Error: {str(e)}")
            return False, {}

    def test_admin_registration(self):
        """Test admin registration"""
        success, response = self.run_test(
            "Admin Registration",
            "POST",
            "auth/register",
            200,
            data={
                "email": "admin@test.com",
                "password": "admin123",
                "name": "Admin User",
                "role": "admin"
            }
        )
        if success and 'token' in response:
            self.admin_token = response['token']
            print(f"   Admin token obtained: {self.admin_token[:20]}...")
            return True
        return False

    def test_customer_registration(self):
        """Test customer registration"""
        success, response = self.run_test(
            "Customer Registration",
            "POST",
            "auth/register",
            200,
            data={
                "email": "customer@test.com",
                "password": "customer123",
                "name": "John Doe",
                "role": "customer"
            }
        )
        if success and 'token' in response:
            self.customer_token = response['token']
            print(f"   Customer token obtained: {self.customer_token[:20]}...")
            return True
        return False

    def test_admin_login(self):
        """Test admin login"""
        success, response = self.run_test(
            "Admin Login",
            "POST",
            "auth/login",
            200,
            data={
                "email": "admin@test.com",
                "password": "admin123"
            }
        )
        if success and 'token' in response:
            self.admin_token = response['token']
            return True
        return False

    def test_customer_login(self):
        """Test customer login"""
        success, response = self.run_test(
            "Customer Login",
            "POST",
            "auth/login",
            200,
            data={
                "email": "customer@test.com",
                "password": "customer123"
            }
        )
        if success and 'token' in response:
            self.customer_token = response['token']
            return True
        return False

    def test_get_me_admin(self):
        """Test get current user (admin)"""
        success, response = self.run_test(
            "Get Current User (Admin)",
            "GET",
            "auth/me",
            200,
            token=self.admin_token
        )
        return success

    def test_get_me_customer(self):
        """Test get current user (customer)"""
        success, response = self.run_test(
            "Get Current User (Customer)",
            "GET",
            "auth/me",
            200,
            token=self.customer_token
        )
        return success

    def test_create_category(self):
        """Test creating a category"""
        success, response = self.run_test(
            "Create Category (Electronics)",
            "POST",
            "categories",
            200,
            data={
                "name": "Electronics",
                "description": "Electronic devices and components"
            },
            token=self.admin_token
        )
        if success and 'id' in response:
            self.created_category_id = response['id']
            print(f"   Category ID: {self.created_category_id}")
            return True
        return False

    def test_create_second_category(self):
        """Test creating a second category"""
        success, response = self.run_test(
            "Create Category (Hardware)",
            "POST",
            "categories",
            200,
            data={
                "name": "Hardware",
                "description": "Hardware tools and equipment"
            },
            token=self.admin_token
        )
        return success

    def test_get_categories(self):
        """Test getting all categories"""
        success, response = self.run_test(
            "Get Categories",
            "GET",
            "categories",
            200,
            token=self.admin_token
        )
        if success:
            print(f"   Found {len(response)} categories")
        return success

    def test_create_product_low_stock(self):
        """Test creating a product with low stock"""
        success, response = self.run_test(
            "Create Product (Low Stock)",
            "POST",
            "products",
            200,
            data={
                "name": "Laptop Computer",
                "sku": "LAP001",
                "description": "High-performance laptop",
                "category_id": self.created_category_id,
                "stock": 5,
                "price": 999.99,
                "reorder_level": 10
            },
            token=self.admin_token
        )
        if success and 'id' in response:
            self.created_product_id = response['id']
            print(f"   Product ID: {self.created_product_id}")
            return True
        return False

    def test_create_product_normal_stock(self):
        """Test creating a product with normal stock"""
        success, response = self.run_test(
            "Create Product (Normal Stock)",
            "POST",
            "products",
            200,
            data={
                "name": "Wireless Mouse",
                "sku": "MOU001",
                "description": "Ergonomic wireless mouse",
                "category_id": self.created_category_id,
                "stock": 50,
                "price": 29.99,
                "reorder_level": 10
            },
            token=self.admin_token
        )
        return success

    def test_get_products(self):
        """Test getting all products"""
        success, response = self.run_test(
            "Get All Products",
            "GET",
            "products",
            200,
            token=self.admin_token
        )
        if success:
            print(f"   Found {len(response)} products")
        return success

    def test_get_products_with_search(self):
        """Test getting products with search"""
        success, response = self.run_test(
            "Search Products (Laptop)",
            "GET",
            "products?search=Laptop",
            200,
            token=self.admin_token
        )
        if success:
            print(f"   Found {len(response)} products matching 'Laptop'")
        return success

    def test_get_products_by_category(self):
        """Test getting products by category"""
        success, response = self.run_test(
            "Get Products by Category",
            "GET",
            f"products?category_id={self.created_category_id}",
            200,
            token=self.admin_token
        )
        if success:
            print(f"   Found {len(response)} products in Electronics category")
        return success

    def test_get_single_product(self):
        """Test getting a single product"""
        success, response = self.run_test(
            "Get Single Product",
            "GET",
            f"products/{self.created_product_id}",
            200,
            token=self.admin_token
        )
        return success

    def test_update_product(self):
        """Test updating a product"""
        success, response = self.run_test(
            "Update Product",
            "PUT",
            f"products/{self.created_product_id}",
            200,
            data={
                "stock": 15,
                "price": 899.99
            },
            token=self.admin_token
        )
        return success

    def test_create_order_customer(self):
        """Test creating an order as customer"""
        success, response = self.run_test(
            "Create Order (Customer)",
            "POST",
            "orders",
            200,
            data={
                "items": [
                    {
                        "product_id": self.created_product_id,
                        "product_name": "Laptop Computer",
                        "quantity": 2,
                        "price": 899.99
                    }
                ]
            },
            token=self.customer_token
        )
        if success and 'id' in response:
            self.created_order_id = response['id']
            print(f"   Order ID: {self.created_order_id}")
            return True
        return False

    def test_get_orders_customer(self):
        """Test getting orders as customer"""
        success, response = self.run_test(
            "Get Orders (Customer)",
            "GET",
            "orders",
            200,
            token=self.customer_token
        )
        if success:
            print(f"   Customer has {len(response)} orders")
        return success

    def test_get_orders_admin(self):
        """Test getting all orders as admin"""
        success, response = self.run_test(
            "Get All Orders (Admin)",
            "GET",
            "orders",
            200,
            token=self.admin_token
        )
        if success:
            print(f"   Total orders in system: {len(response)}")
        return success

    def test_update_order_status(self):
        """Test updating order status"""
        success, response = self.run_test(
            "Update Order Status",
            "PUT",
            f"orders/{self.created_order_id}/status",
            200,
            data={
                "status": "processing"
            },
            token=self.admin_token
        )
        return success

    def test_dashboard_stats(self):
        """Test getting dashboard statistics"""
        success, response = self.run_test(
            "Get Dashboard Stats",
            "GET",
            "dashboard/stats",
            200,
            token=self.admin_token
        )
        if success:
            print(f"   Stats: Products={response.get('total_products')}, Low Stock={response.get('low_stock_count')}, Orders={response.get('total_orders')}, Revenue=${response.get('total_revenue')}")
        return success

    def test_delete_product(self):
        """Test deleting a product"""
        success, response = self.run_test(
            "Delete Product",
            "DELETE",
            f"products/{self.created_product_id}",
            200,
            token=self.admin_token
        )
        return success

    def test_unauthorized_access(self):
        """Test unauthorized access"""
        success, response = self.run_test(
            "Unauthorized Access (No Token)",
            "GET",
            "products",
            401
        )
        return success

    def test_customer_admin_access(self):
        """Test customer trying to access admin endpoint"""
        success, response = self.run_test(
            "Customer Access Admin Endpoint",
            "POST",
            "categories",
            403,
            data={"name": "Test Category"},
            token=self.customer_token
        )
        return success

def main():
    print("🚀 Starting StockFlow API Tests...")
    print("=" * 50)
    
    tester = StockFlowAPITester()
    
    # Authentication Tests
    print("\n📋 AUTHENTICATION TESTS")
    print("-" * 30)
    
    if not tester.test_admin_registration():
        print("❌ Admin registration failed, trying login...")
        if not tester.test_admin_login():
            print("❌ Admin login also failed, stopping tests")
            return 1
    
    if not tester.test_customer_registration():
        print("❌ Customer registration failed, trying login...")
        if not tester.test_customer_login():
            print("❌ Customer login also failed, stopping tests")
            return 1
    
    tester.test_get_me_admin()
    tester.test_get_me_customer()
    
    # Category Tests
    print("\n📂 CATEGORY TESTS")
    print("-" * 30)
    
    if not tester.test_create_category():
        print("❌ Category creation failed, stopping tests")
        return 1
    
    tester.test_create_second_category()
    tester.test_get_categories()
    
    # Product Tests
    print("\n📦 PRODUCT TESTS")
    print("-" * 30)
    
    if not tester.test_create_product_low_stock():
        print("❌ Product creation failed, stopping tests")
        return 1
    
    tester.test_create_product_normal_stock()
    tester.test_get_products()
    tester.test_get_products_with_search()
    tester.test_get_products_by_category()
    tester.test_get_single_product()
    tester.test_update_product()
    
    # Order Tests
    print("\n🛒 ORDER TESTS")
    print("-" * 30)
    
    if not tester.test_create_order_customer():
        print("❌ Order creation failed, stopping tests")
        return 1
    
    tester.test_get_orders_customer()
    tester.test_get_orders_admin()
    tester.test_update_order_status()
    
    # Dashboard Tests
    print("\n📊 DASHBOARD TESTS")
    print("-" * 30)
    
    tester.test_dashboard_stats()
    
    # Security Tests
    print("\n🔒 SECURITY TESTS")
    print("-" * 30)
    
    tester.test_unauthorized_access()
    tester.test_customer_admin_access()
    
    # Cleanup Tests
    print("\n🗑️ CLEANUP TESTS")
    print("-" * 30)
    
    tester.test_delete_product()
    
    # Print final results
    print("\n" + "=" * 50)
    print(f"📊 FINAL RESULTS: {tester.tests_passed}/{tester.tests_run} tests passed")
    
    if tester.tests_passed == tester.tests_run:
        print("🎉 All tests passed!")
        return 0
    else:
        print(f"❌ {tester.tests_run - tester.tests_passed} tests failed")
        return 1

if __name__ == "__main__":
    sys.exit(main())
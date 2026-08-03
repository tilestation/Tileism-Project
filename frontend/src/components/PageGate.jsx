import React from 'react';
import { useLocation, Link } from 'react-router-dom';
import { ShieldOff, ArrowLeft } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { usePermissions } from '../contexts/PermissionsContext';

/**
 * PageGate — route-level permission guard for /admin/* pages.
 *
 * Wraps the <Outlet> inside Layout.js. Reads the current pathname,
 * looks up the required permission key from `ROUTE_PERMISSIONS`, and:
 *   - super_admin → always allowed
 *   - perms still loading → renders children optimistically (avoids flicker)
 *   - route not in the map → renders children (unguarded by design)
 *   - user has the page permission → renders children
 *   - else → renders a friendly "Access denied" panel with a link home
 *
 * 17 May 2026 — closes the bypass where un-ticking a permission on the
 * Staff role only hid the sidebar link but did NOT block direct URL access
 * (typing /admin/sync-hub still worked).
 *
 * Pattern: longest-prefix match. Order doesn't matter as long as more
 * specific paths come before more generic ones if they overlap.
 */

// Map admin route paths → PAGE_REGISTRY keys (see backend/routes/permissions.py).
// If a route isn't listed here, it's left unguarded — used for the
// dashboard root and a handful of pages that intentionally inherit from
// just the /admin role gate.
const ROUTE_PERMISSIONS = {
  // Hubs
  '/admin/products-hub': 'products_hub',
  '/admin/stock-hub': 'stock_hub',
  '/admin/sales-hub': 'sales_hub',
  '/admin/customers-hub': 'customers_hub',
  '/admin/communication-hub': 'communication_hub',
  '/admin/reports-hub': 'reports_hub',
  '/admin/settings-hub': 'general_settings',
  '/admin/website-hub': 'website_preview',

  // Sales & EPOS
  '/admin/epos': 'epos',
  '/admin/cash-counter': 'cash_counter',
  '/admin/showroom-dashboard': 'showroom_dashboard',
  '/admin/invoices': 'invoice_history',
  '/admin/invoice': 'invoice',
  '/admin/quotations': 'quotation',
  '/admin/quotation': 'quotation',
  '/admin/cash-quotation': 'cash_quotation',
  '/admin/cash-quotations': 'cash_quotation_history',
  '/admin/refunds': 'refund',
  '/admin/refund': 'refund',
  '/admin/credit-notes': 'credit_note',
  '/admin/credit-note': 'credit_note',
  '/admin/orders': 'orders',
  '/admin/order-management': 'order_management',
  '/admin/delivery-management': 'delivery_management',
  '/admin/online-orders': 'online_orders',
  '/admin/sample-orders': 'online_orders',
  '/admin/deposit-orders': 'orders',

  // Products & Suppliers
  '/admin/products': 'supplier_products',
  '/admin/supplier-products': 'supplier_products',
  '/admin/tiles': 'supplier_products',
  '/admin/materials': 'supplier_products',
  '/admin/custom-manager': 'supplier_products',
  '/admin/supplier-health': 'supplier_health',
  '/admin/sync-hub': 'sync_hub',
  '/admin/suppliers': 'suppliers',
  '/admin/supplier-sync': 'supplier_sync',
  '/admin/price-tickets': 'supplier_products',
  '/admin/tiles-info': 'supplier_products',
  '/admin/image-scraper': 'image_scraper',
  '/admin/scraping-portal': 'scraping_portal',
  '/admin/categories': 'manage_categories',

  // Stock
  '/admin/stock-allocation': 'stock_allocation',
  '/admin/bulk-stock': 'bulk_stock',
  '/admin/stock-import': 'stock_import',
  '/admin/delivery-check-in': 'delivery_check_in',
  '/admin/stock-transfers': 'stock_transfers',
  '/admin/reorder-suggestions': 'reorder_suggestions',
  '/admin/batch-tracking': 'batch_tracking',
  '/admin/to-order': 'to_order_report',
  '/admin/stock-cost': 'stock_cost',
  '/admin/stocktake-report': 'stocktake_report',
  '/admin/stock-analytics': 'analytics',

  // Customers
  '/admin/trade-accounts': 'trade_accounts',
  '/admin/pricing': 'customer_pricing',
  '/admin/invites': 'customer_invites',
  '/admin/inquiries': 'bulk_inquiries',
  '/admin/trade-list': 'trade_list',
  '/admin/customer-orders': 'orders',
  '/admin/customer-history': 'customers_hub',

  // Communication
  '/admin/chat': 'staff_chat',
  '/admin/tasks': 'tasks',
  '/admin/inbox': 'inbox',
  '/admin/email': 'email_composer',
  '/admin/email-hub': 'marketing',
  '/admin/notifications': 'notifications',
  '/admin/whatsapp': 'whatsapp',
  '/admin/documents': 'product_documents',

  // Marketing & SEO
  '/admin/seo': 'marketing',
  '/admin/seo-autopilot-v2': 'marketing',
  '/admin/marketing': 'marketing',
  '/admin/marketing-studio': 'marketing',
  '/admin/visualizer': 'marketing',
  '/admin/promo-codes': 'marketing',
  '/admin/abandoned-baskets': 'marketing',
  '/admin/pinterest-pack': 'marketing',
  '/admin/trade-credit-emails': 'marketing',
  '/admin/failed-payments': 'marketing',
  '/admin/stripe-reconcile': 'marketing',
  '/admin/mission-topps': 'marketing',
  '/admin/weekly-digest': 'marketing',
  '/admin/health': 'marketing',

  // Reports
  '/admin/analytics': 'analytics',
  '/admin/reports': 'reports',
  '/admin/audit-trail': 'audit_trail',
  '/admin/revenue-reports': 'reports',
  '/admin/product-performance': 'analytics',
  '/admin/daily-summary': 'reports',
  '/admin/export-reports': 'reports',

  // Settings / Admin
  '/admin/showrooms': 'showrooms',
  '/admin/users': 'user_management',
  '/admin/permissions': 'permissions_admin',
  '/admin/notification-permissions': 'permissions_admin',
  '/admin/storefront-features': 'storefront_features',
  '/admin/staff-pins': 'staff_pins',
  '/admin/staff-invites': 'staff_invites',
  '/admin/trash': 'trash',
  '/admin/settings': 'general_settings',
  '/admin/backup': 'backup',
  '/admin/pricing-settings': 'pricing_settings',
};

const resolveRequiredPermission = (pathname) => {
  if (!pathname) return null;
  // Exact match first
  if (ROUTE_PERMISSIONS[pathname]) return ROUTE_PERMISSIONS[pathname];
  // Longest prefix match — strips trailing path segments (IDs, sub-pages)
  // until we hit a registered route or run out of segments.
  let p = pathname;
  while (p.includes('/')) {
    p = p.substring(0, p.lastIndexOf('/'));
    if (!p) break;
    if (ROUTE_PERMISSIONS[p]) return ROUTE_PERMISSIONS[p];
  }
  return null;
};

export default function PageGate({ children }) {
  const { user } = useAuth();
  const { hasPage, loading: permsLoading } = usePermissions();
  const { pathname } = useLocation();

  const isSuperAdmin = user?.role === 'super_admin';
  if (isSuperAdmin) return children;

  // While perms are loading on first paint, render the children
  // optimistically. The gate kicks in once /me responds — if the user
  // genuinely doesn't have access they'll see the denied panel after
  // ~200ms. Better than flashing a denied panel on every navigation
  // for users who DO have access.
  if (permsLoading) return children;

  const required = resolveRequiredPermission(pathname);

  // Routes not in the map are intentionally unguarded — the /admin top-level
  // route gate already requires an admin/manager/staff/super_admin role.
  if (!required) return children;

  if (hasPage(required)) return children;

  return (
    <div className="max-w-2xl mx-auto mt-12 p-8 bg-amber-50 border border-amber-200 rounded-xl text-center" data-testid="page-gate-denied">
      <ShieldOff className="h-14 w-14 text-amber-500 mx-auto mb-4" />
      <h2 className="text-2xl font-semibold text-slate-900 mb-2">Access restricted</h2>
      <p className="text-slate-600 mb-1">
        Your current role doesn't include access to this page.
      </p>
      <p className="text-xs text-slate-500 mb-6">
        Missing permission: <code className="bg-amber-100 px-1.5 py-0.5 rounded text-amber-900">{required}</code>
      </p>
      <Link
        to="/admin"
        className="inline-flex items-center gap-2 px-4 py-2 bg-slate-900 text-white rounded-md hover:bg-slate-800 transition-colors"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Dashboard
      </Link>
    </div>
  );
}

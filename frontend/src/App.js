import React, { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { PermissionsProvider } from './contexts/PermissionsContext';
import { CompareProvider } from './contexts/CompareContext';
import { ShopAuthProvider } from './contexts/ShopAuthContext';
import { Toaster } from './components/ui/sonner';
import { InstallPWA } from './components/InstallPWA';
import { useAppUpdate } from './hooks/useAppUpdate';
import { ScrollToTop, BackToTopButton } from './components/ScrollToTop';
import VisitorBeacon from './components/VisitorBeacon';
import NewOrderNotifier from './components/NewOrderNotifier';
import { installWebVitalsBeacon } from './lib/webVitalsBeacon';
import AdminLiveMessage from './components/AdminLiveMessage';
// PushOptIn import retained but unused — banner removed from storefront 04 May 2026.
// eslint-disable-next-line no-unused-vars
import PushOptIn from './components/PushOptIn';
import { AuthPage } from './pages/AuthPage';
import { Layout } from './components/Layout';
import { AdminDashboard } from './pages/admin/Dashboard';
import { ProductForm } from './pages/admin/ProductForm';
import { AdminCategories } from './pages/admin/Categories';
import { AdminOrders } from './pages/admin/Orders';
import { AdminReports } from './pages/admin/Reports';
import { CustomerPricing } from './pages/admin/CustomerPricing';
import { BulkInquiries } from './pages/admin/BulkInquiries';
import { CustomerInvites } from './pages/admin/CustomerInvites';
import { Marketing } from './pages/admin/Marketing';
import SeoCommandCentre from './pages/admin/SeoCommandCentre';
import GoogleBusinessProfile from './pages/admin/GoogleBusinessProfile';
import VisualizerAdmin from './pages/admin/VisualizerAdmin';
import MarketingStudio from './pages/admin/MarketingStudio';
import TradeCreditEmails from './pages/admin/TradeCreditEmails';
import EmailHub from './pages/admin/EmailHub';
import PinterestPack from './pages/admin/PinterestPack';
import UnsubscribePage from './pages/public/UnsubscribePage';
import VideoStudio from './pages/admin/VideoStudio';
import BlogIndexPage from './pages/shop/BlogIndexPage';
import BlogArticlePage from './pages/shop/BlogArticlePage';
import HealthMonitor from './pages/admin/HealthMonitor';
import GoogleAdsSavings from './pages/admin/GoogleAdsSavings';
import SeoAutopilot from './pages/admin/SeoAutopilot';
import { Showrooms } from './pages/admin/Showrooms';
import { UserManagement } from './pages/admin/UserManagement';
import Invoice from './pages/admin/Invoice';
import { InvoiceHistory } from './pages/admin/InvoiceHistory';
import Quotation from './pages/admin/Quotation';
import QuotationHistory from './pages/admin/QuotationHistory';
import { CashQuotation } from './pages/admin/CashQuotation';
import { CashQuotationHistory } from './pages/admin/CashQuotationHistory';
import { Refund } from './pages/admin/Refund';
import { RefundHistory } from './pages/admin/RefundHistory';
import { CreditNote } from './pages/admin/CreditNote';
import { CreditNoteHistory } from './pages/admin/CreditNoteHistory';
import { ClearanceProducts } from './pages/admin/ClearanceProducts';
import { NewCollectionProducts } from './pages/admin/NewCollectionProducts';
import { StaffPins } from './pages/admin/StaffPins';
import { Epos } from './pages/admin/Epos';
import { StaffInvites } from './pages/admin/StaffInvites';
import { StaffRegister } from './pages/StaffRegister';
import { Analytics } from './pages/admin/Analytics';
import { AuditTrail } from './pages/admin/AuditTrail';
import { EmailComposer } from './pages/admin/EmailComposer';
import { EmailInbox } from './pages/admin/EmailInbox';
import { NotificationSettings } from './pages/admin/NotificationSettings';
import { SettingsPage } from './pages/admin/SettingsPage';
import { PriceTickets } from './pages/admin/PriceTickets';
import { ShowroomDashboard } from './pages/admin/ShowroomDashboard';
import { StockAllocation } from './pages/admin/StockAllocation';
import { DeliveryCheckIn } from './pages/admin/DeliveryCheckIn';
import OrderManagement from './pages/admin/OrderManagement';
import DeliveryManagement from './pages/admin/DeliveryManagement';
import { ShowroomEpos } from './pages/admin/ShowroomEpos';
import { ShowroomInvoiceHistory } from './pages/admin/ShowroomInvoiceHistory';
import { StaffChat } from './pages/admin/StaffChat';
import { TilesInfo } from './pages/admin/TilesInfo';
import { TradeList } from './pages/admin/TradeList';
import TradeAccounts from './pages/admin/TradeAccounts';
import TradeAccountSettings from './pages/admin/TradeAccountSettings';
import CheckoutSettings from './pages/admin/CheckoutSettings';
import OnlineOrders from './pages/admin/OnlineOrders';
import LiveVisitors from './pages/admin/LiveVisitors';
import CustomerAccountSettings from './pages/admin/CustomerAccountSettings';
import TasksNotes from './pages/admin/TasksNotes';
import ProductImport from './components/ProductImport';
import Trash from './pages/admin/Trash';
import { StockCostReport } from './pages/admin/StockCostReport';
import CashCounter from './pages/admin/CashCounter';
import ImageScraper from './pages/admin/ImageScraper';
import Plus39Images from './pages/admin/Plus39Images';
import LeporceImages from './pages/admin/LeporceImages';
import SupplierImages from './pages/admin/SupplierImages';
import ToOrderReport from './pages/admin/ToOrderReport';
import StockImport from './pages/admin/StockImport';
import BulkStockEdit from './pages/admin/BulkStockEdit';
import Suppliers from './pages/admin/Suppliers';
import StocktakeReport from './pages/admin/StocktakeReport';
import SupplierSyncDashboard from './pages/admin/SupplierSyncDashboard';
import SupplierProducts from './pages/admin/SupplierProducts';
import SupplierHealthDashboard from './pages/admin/SupplierHealthDashboard';
import WallcanoPriceImport from './pages/admin/WallcanoPriceImport';
import PublishSupplierProducts from './pages/admin/PublishSupplierProducts';
import ScrapingPortal from './pages/admin/ScrapingPortal';
import SyncHub from './pages/admin/SyncHub';
import ProductsHub from './pages/admin/ProductsHub';
import SalesHub from './pages/admin/SalesHub';
import StaffPerformanceDashboard from './pages/admin/StaffPerformanceDashboard';
import LoyaltyDashboard from './pages/admin/LoyaltyDashboard';
import ManageCategories from './pages/admin/ManageCategories';
import ReorderSuggestions from './pages/admin/ReorderSuggestions';
import StockTransfers from './pages/admin/StockTransfers';
import QuoteRequests from './pages/admin/QuoteRequests';
import BatchTracking from './pages/admin/BatchTracking';
import StockHub from './pages/admin/StockHub';
import CustomersHub from './pages/admin/CustomersHub';
import CommunicationHub from './pages/admin/CommunicationHub';
import DocumentStorage from './pages/admin/DocumentStorage';
import ReportsHub from './pages/admin/ReportsHub';
import SettingsHub from './pages/admin/SettingsHub';
import PermissionsAdmin from './pages/admin/PermissionsAdmin';
import NotificationAuthorizations from './pages/admin/NotificationAuthorizations';
import MySubscriptions from './pages/admin/MySubscriptions';
import AbandonedCartsAdmin from './pages/admin/AbandonedCartsAdmin';
import PromoCodesAdmin from './pages/admin/PromoCodesAdmin';
import WeeklyDigestAdmin from './pages/admin/WeeklyDigestAdmin';
import StorefrontFeaturesAdmin from './pages/admin/StorefrontFeaturesAdmin';
import ReferAFriendPage from './pages/shop/ReferAFriendPage';
import ComparePage from './pages/shop/ComparePage';
import CompareTray from './components/shop/CompareTray';
import { SecuritySettings } from './pages/admin/SecuritySettings';
import PricingSettings from './pages/admin/PricingSettings';
import WebsiteHub from './pages/admin/WebsiteHub';
import MaintenanceTasks from './pages/admin/MaintenanceTasks';
import ImageMigration from './pages/admin/ImageMigration';
import TileCalculatorSettings from './pages/admin/TileCalculatorSettings';
import WebsiteSalesDashboard from './pages/admin/WebsiteSalesDashboard';
// Website Admin imports
import WebsiteCategoriesManager from './pages/admin/WebsiteCategoriesManager';
import WebsiteFiltersManager from './pages/admin/WebsiteFiltersManager';
import WebsiteProductsEditor from './pages/admin/WebsiteProductsEditor';
import HomepageContentEditor from './pages/admin/HomepageContentEditor';
import HomepageManager from './pages/admin/HomepageManager';
import BathroomPageAdmin from './pages/admin/BathroomPageAdmin';
import WhatsAppManager from './pages/admin/WhatsAppManager';
import WebsiteSettingsEditor from './pages/admin/WebsiteSettingsEditor';
import AnnouncementRibbonAdmin from './pages/admin/AnnouncementRibbonAdmin';
import NavigationMenuEditor from './pages/admin/NavigationMenuEditor';
import NavigationStructureManager from './pages/admin/NavigationStructureManager';
import CollectionManager from './pages/admin/CollectionManager';
import CollectionMappingManager from './pages/admin/CollectionMappingManager';
import CollectionDetailSettings from './pages/admin/CollectionDetailSettings';
import CollectionsPageSettings from './pages/admin/CollectionsPageSettings';
import CollectionsHub from './pages/admin/CollectionsHub';
import ShowroomsManager from './pages/admin/ShowroomsManager';
import WebsitePreview from './pages/admin/WebsitePreview';
import SiteMapManager from './pages/admin/SiteMapManager';
import WebsiteAnalytics from './pages/admin/WebsiteAnalytics';
import LiveChatAdmin from './pages/admin/LiveChatAdmin';
import PageMaintenanceAdmin from './pages/admin/PageMaintenanceAdmin';
import WelcomePopupAdmin from './pages/admin/WelcomePopupAdmin';
import { CustomerProducts } from './pages/customer/Products';
import { CustomerOrders } from './pages/customer/Orders';
import ForgotPassword from './pages/auth/ForgotPassword';
import ResetPassword from './pages/auth/ResetPassword';
// Shop (E-commerce) imports
import { ShopLayout } from './components/shop/ShopLayout';
import { ShopHome } from './pages/shop/ShopHome';
import { ShopProducts } from './pages/shop/ShopProducts';
import { ShopProductDetail } from './pages/shop/ShopProductDetail';
import { ShopCart } from './pages/shop/ShopCart';
import { ShopCheckout } from './pages/shop/ShopCheckout';
import CheckoutRecover from './pages/shop/CheckoutRecover';
import FailedPayments from './pages/admin/FailedPayments';
import { ShopLogin } from './pages/shop/ShopLogin';
import { ShopRegister } from './pages/shop/ShopRegister';
import { ShopOrderSuccess } from './pages/shop/ShopOrderSuccess';
import { ShopOrders } from './pages/shop/ShopOrders';
import { ShopStores } from './pages/shop/ShopStores';
import { OrderTracking } from './pages/shop/OrderTracking';
import TileStationHome from './pages/shop/TileStationHome';
import ContactPage from './pages/shop/ContactPage';
import InfoPage from './pages/shop/InfoPage';
import ClearancePage from './pages/shop/ClearancePage';
import NewCollectionPage from './pages/shop/NewCollectionPage';
import TileListingPage from './pages/shop/TileListingPage';
import TileCollectionsPage from './pages/shop/TileCollectionsPage';
import ShopSearchResultsPage from './pages/shop/ShopSearchResultsPage';
import CollectionDetailPage from './pages/shop/CollectionDetailPage';
import StorefrontErrorBoundary from './components/shop/StorefrontErrorBoundary';
import TileScalePrintPage from './pages/shop/TileScalePrintPage';
import TileDetailPage from './pages/shop/TileDetailPage';
import TileProductRedirect from './pages/shop/TileProductRedirect';
import TileCartPage from './pages/shop/TileCartPage';
import BathroomPage from './pages/shop/BathroomPage';
import TileCheckoutPage from './pages/shop/TileCheckoutPage';
import OrderSuccessPage from './pages/shop/OrderSuccessPage';
import TileWishlistPage from './pages/shop/TileWishlistPage';
import TileOrderSuccessPage from './pages/shop/TileOrderSuccessPage';
import TileLoginPage from './pages/shop/TileLoginPage';
import TileRegisterPage from './pages/shop/TileRegisterPage';
import TileAccountPage from './pages/shop/TileAccountPage';
import TileSampleCartPage from './pages/shop/TileSampleCartPage';
import TileVisualizerPage from './pages/shop/TileVisualizerPage';
import VisualizerSharePage from './pages/shop/VisualizerSharePage';
import StatusPage from './pages/shop/StatusPage';
import TileSampleSuccessPage from './pages/shop/TileSampleSuccessPage';
import TileSampleServicePage from './pages/shop/TileSampleServicePage';
import TradeSignupPage from './pages/shop/TradeSignupPage';
import TradeRegisterPage from './pages/shop/TradeRegisterPage';
import TradeLoginPage from './pages/shop/TradeLoginPage';
import ShowroomSignupPage from './pages/shop/ShowroomSignupPage';
import TradeAccountPage from './pages/shop/TradeAccountPage';
import CustomerRegisterPage from './pages/shop/CustomerRegisterPage';
import CustomerAccountPage from './pages/shop/CustomerAccountPage';
import TileCalculatorPage from './pages/shop/TileCalculatorPage';
import SampleServiceContent from './pages/admin/SampleServiceContent';
import SampleFollowupsPage from './pages/admin/SampleFollowupsPage';
import PalletPricingSettingsPage from './pages/admin/PalletPricingSettingsPage';
import CategorySystemDemo from './pages/admin/CategorySystemDemo';
import TrainingBookletEditor from './pages/admin/TrainingBookletEditor';
import TelegramNotifications from './pages/admin/TelegramNotifications';
import { TileCartProvider } from './contexts/TileCartContext';
import { WishlistProvider } from './contexts/WishlistContext';
import { SampleCartProvider } from './contexts/SampleCartContext';
import { MaintenanceProvider } from './contexts/MaintenanceContext';
import MaintenanceGuard from './components/MaintenanceGuard';
import GlobalMaintenanceGate from './components/GlobalMaintenanceGate';
import { api } from './lib/api';
import { initCustomerErrorWatch } from './lib/clientErrorWatch';
import { initPinterestTag, trackPinterestPage } from './lib/pinterest';
import './App.css';

// One-shot init at module load
initCustomerErrorWatch();
initPinterestTag();

// Redirect the old Railway preview URL to the canonical custom domain.
// Both URLs serve the same React build, so visitors landing on the
// `*.railway.app` URL (via stale bookmarks, social shares or screenshots)
// are bounced to `www.tilestation.co.uk` keeping the path + query intact.
// SEO benefit: collapses duplicate content under a single canonical host.
(function redirectToCanonicalDomain() {
  if (typeof window === 'undefined') return;
  const host = window.location.hostname;
  // Only redirect the FRONTEND auto URL — the backend Railway URL stays as
  // it is because the frontend bundle hits it for /api/* calls.
  if (host === 'carefree-friendship-production-ee2b.up.railway.app') {
    const target = `https://www.tilestation.co.uk${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.location.replace(target);
  }
})();

// App Loading Screen - waits for backend to be ready
const AppLoader = ({ children }) => {
  // Use a ref to remember if we were ever ready - survives re-renders from error recovery
  const wasReady = React.useRef(sessionStorage.getItem('backendReady') === 'true');
  const [backendReady, setBackendReady] = useState(wasReady.current);
  const [retryCount, setRetryCount] = useState(0);
  const maxRetries = 30; // 30 seconds max wait

  useEffect(() => {
    const checkBackend = async () => {
      try {
        const response = await api.healthCheck();
        if (response.data.status === 'healthy') {
          setBackendReady(true);
          sessionStorage.setItem('backendReady', 'true');
        } else {
          throw new Error('Backend unhealthy');
        }
      } catch (error) {
        if (retryCount < maxRetries) {
          setTimeout(() => setRetryCount(c => c + 1), 1000);
        }
      }
    };
    
    checkBackend();
  }, [retryCount]);

  if (!backendReady) {
    return (
      <div className="flex items-center justify-center h-screen bg-gradient-to-br from-slate-900 to-slate-800">
        <div className="text-center">
          <div className="relative mb-6">
            <div className="animate-spin rounded-full h-16 w-16 border-4 border-primary/30 border-t-primary mx-auto"></div>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-2xl">🏪</span>
            </div>
          </div>
          <h1 className="text-2xl font-bold text-white mb-2">Tile Station</h1>
          <p className="text-slate-400 mb-4">Starting up...</p>
          <div className="w-48 h-1 bg-slate-700 rounded-full mx-auto overflow-hidden">
            <div 
              className="h-full bg-primary rounded-full transition-all duration-300"
              style={{ width: `${Math.min((retryCount / maxRetries) * 100, 95)}%` }}
            />
          </div>
          <p className="text-xs text-slate-500 mt-2">
            {retryCount > 5 ? 'Almost ready...' : 'Connecting to server...'}
          </p>
        </div>
      </div>
    );
  }

  return children;
};

const ProtectedRoute = ({ children, requiredRole }) => {
  const { user, loading } = useAuth();
  const location = window.location;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    // Redirect to admin login with return URL so user comes back after login
    const returnPath = location.pathname + location.search;
    const loginUrl = returnPath && returnPath !== '/' 
      ? `/admin/login?returnUrl=${encodeURIComponent(returnPath)}`
      : '/admin/login';
    return <Navigate to={loginUrl} replace />;
  }

  // Check if user has required role
  const adminRoles = ['admin', 'super_admin', 'manager', 'staff', 'ADMIN', 'SUPER_ADMIN'];
  const isAdminUser = adminRoles.includes(user.role);
  
  if (requiredRole === 'admin' && !isAdminUser) {
    return <Navigate to="/customer" replace />;
  }
  
  if (requiredRole === 'customer' && isAdminUser) {
    return <Navigate to="/admin" replace />;
  }

  return children;
};

// ErrorBoundary to prevent admin page crashes from killing the entire app
class AdminErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    console.error('Admin page error caught:', error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center h-screen bg-gray-50">
          <div className="text-center max-w-md p-8">
            <div className="text-5xl mb-4">&#9888;&#65039;</div>
            <h2 className="text-xl font-bold text-gray-900 mb-2">Something went wrong</h2>
            <p className="text-gray-600 mb-6">An error occurred on this page. Your data is safe.</p>
            <div className="flex gap-3 justify-center">
              <button
                onClick={() => this.setState({ hasError: false, error: null })}
                className="px-4 py-2 bg-amber-500 text-white rounded-lg hover:bg-amber-600 font-medium"
              >
                Try Again
              </button>
              <button
                onClick={() => window.location.href = '/admin'}
                className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 font-medium"
              >
                Go to Dashboard
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  // Check for app updates
  useAppUpdate();
  // Install Core Web Vitals beacon once per page load (skips /admin paths internally)
  useEffect(() => { installWebVitalsBeacon(); }, []);
  
  return (
    <AppLoader>
      <AuthProvider>
        <PermissionsProvider>
        <CompareProvider max={3}>
        <MaintenanceProvider>
        <BrowserRouter>
          <ScrollToTop />
          <VisitorBeacon />
          <AdminLiveMessage />
          <NewOrderNotifier />
          <BackToTopButton />
          {/* PushOptIn removed from storefront on 04 May 2026 (user request).
              Component file kept at /components/PushOptIn.jsx for future
              re-enable. Backend /api/push/* and admin broadcast card
              remain functional — existing subscribers (if any) still receive
              broadcasts. */}
          <GlobalMaintenanceGate>
          <Routes>
            {/* Public Shop Homepage at root */}
            <Route path="/" element={
              <MaintenanceGuard>
              <TileCartProvider>
                <WishlistProvider>
                  <SampleCartProvider>
                    <TileStationHome />
                  </SampleCartProvider>
                </WishlistProvider>
              </TileCartProvider>
              </MaintenanceGuard>
            } />
            
            {/* Admin Auth Routes */}
            <Route path="/admin/login" element={<AuthPage />} />
            <Route path="/register" element={<AuthPage />} />
            <Route path="/staff-register/:code" element={<StaffRegister />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
          {/* Shop alias — login/trade pages link here with ?email= prefill */}
          <Route path="/shop/tile-forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/unsubscribe" element={<UnsubscribePage />} />

            {/* Public blog (Editorial Autopilot output) — wrapped in
                the same Cart/Wishlist providers as the rest of the
                storefront so ShopHeader's useCart() works. */}
            <Route path="/blog" element={
              <TileCartProvider>
                <WishlistProvider>
                  <SampleCartProvider>
                    <BlogIndexPage />
                  </SampleCartProvider>
                </WishlistProvider>
              </TileCartProvider>
            } />
            <Route path="/blog/:slug" element={
              <TileCartProvider>
                <WishlistProvider>
                  <SampleCartProvider>
                    <BlogArticlePage />
                  </SampleCartProvider>
                </WishlistProvider>
              </TileCartProvider>
            } />

            <Route path="/admin" element={
              <ProtectedRoute requiredRole="admin">
                <AdminErrorBoundary>
                  <Layout />
                </AdminErrorBoundary>
              </ProtectedRoute>
            }>
              <Route index element={<AdminDashboard />} />
            <Route path="products/new" element={<ProductForm />} />
            <Route path="products/edit/:id" element={<ProductForm />} />
            <Route path="products/import" element={<ProductImport />} />
            <Route path="categories" element={<AdminCategories />} />
            <Route path="orders" element={<AdminOrders />} />
            <Route path="order-management" element={<OrderManagement />} />
            <Route path="delivery-management" element={<DeliveryManagement />} />
            <Route path="epos" element={<Epos />} />
            <Route path="pricing" element={<CustomerPricing />} />
            <Route path="inquiries" element={<BulkInquiries />} />
            <Route path="invites" element={<CustomerInvites />} />
            <Route path="marketing" element={<Marketing />} />
            <Route path="seo" element={<SeoCommandCentre />} />
            <Route path="gbp" element={<GoogleBusinessProfile />} />
            <Route path="visualizer" element={<VisualizerAdmin />} />
            <Route path="marketing-studio" element={<MarketingStudio />} />
            <Route path="trade-credit-emails" element={<TradeCreditEmails />} />
            <Route path="email-hub" element={<EmailHub />} />
            <Route path="pinterest-pack" element={<PinterestPack />} />
            <Route path="marketing-studio/videos" element={<VideoStudio />} />
            <Route path="health" element={<HealthMonitor />} />
            <Route path="ads-savings" element={<GoogleAdsSavings />} />
            <Route path="seo-autopilot" element={<SeoAutopilot />} />
            <Route path="showrooms" element={<Showrooms />} />
            <Route path="users" element={<UserManagement />} />
            <Route path="staff-invites" element={<StaffInvites />} />
            <Route path="analytics" element={<Analytics />} />
            <Route path="staff-performance" element={<StaffPerformanceDashboard />} />
            <Route path="loyalty" element={<LoyaltyDashboard />} />
            <Route path="reorder-suggestions" element={<ReorderSuggestions />} />
            <Route path="stock-transfers" element={<StockTransfers />} />
            <Route path="batch-tracking" element={<BatchTracking />} />
            <Route path="audit-trail" element={<AuditTrail />} />
            <Route path="trash" element={<Trash />} />
            <Route path="email" element={<EmailComposer />} />
            <Route path="inbox" element={<EmailInbox />} />
            <Route path="notifications" element={<NotificationSettings />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="security" element={<SecuritySettings />} />
            <Route path="price-tickets" element={<PriceTickets />} />
            <Route path="showroom-dashboard" element={<ShowroomDashboard />} />
            <Route path="stock-allocation" element={<StockAllocation />} />
            <Route path="delivery-check-in" element={<DeliveryCheckIn />} />
            <Route path="invoice" element={<Invoice />} />
            <Route path="invoice-history" element={<InvoiceHistory />} />
            <Route path="quotation" element={<Quotation />} />
            <Route path="quotation-history" element={<QuotationHistory />} />
            <Route path="cash-quotation" element={<CashQuotation />} />
            <Route path="cash-quotation-history" element={<CashQuotationHistory />} />
            <Route path="refund" element={<Refund />} />
            <Route path="refund-history" element={<RefundHistory />} />
            <Route path="credit-note" element={<CreditNote />} />
            <Route path="credit-note-history" element={<CreditNoteHistory />} />
            <Route path="clearance-products" element={<ClearanceProducts />} />
            <Route path="new-collection-products" element={<NewCollectionProducts />} />
            <Route path="staff-pins" element={<StaffPins />} />
            <Route path="reports" element={<AdminReports />} />
            <Route path="stock-cost" element={<StockCostReport />} />
            <Route path="chat" element={<StaffChat />} />
            <Route path="tiles-info" element={<TilesInfo />} />
            <Route path="trade-list" element={<TradeList />} />
            <Route path="trade-accounts" element={<TradeAccounts />} />
            <Route path="quote-requests" element={<QuoteRequests />} />
            <Route path="tasks" element={<TasksNotes />} />
            <Route path="training-booklet" element={<TrainingBookletEditor />} />
            <Route path="notifications/telegram" element={<TelegramNotifications />} />
            <Route path="cash-counter" element={<CashCounter />} />
            <Route path="image-scraper" element={<ImageScraper />} />
            <Route path="plus39-images" element={<Plus39Images />} />
            <Route path="leporce-images" element={<LeporceImages />} />
            <Route path="supplier-images/:supplier" element={<SupplierImages />} />
            <Route path="to-order" element={<ToOrderReport />} />
            <Route path="stock-import" element={<StockImport />} />
            <Route path="bulk-stock" element={<BulkStockEdit />} />
            <Route path="suppliers" element={<Suppliers />} />
            <Route path="supplier-sync" element={<SupplierSyncDashboard />} />
            <Route path="supplier-products" element={<SupplierProducts />} />
            <Route path="supplier-health" element={<SupplierHealthDashboard />} />
            <Route path="manage-categories" element={<ManageCategories />} />
            <Route path="wallcano-prices" element={<WallcanoPriceImport />} />
            <Route path="scraping-portal" element={<ScrapingPortal />} />
            <Route path="scraping" element={<ScrapingPortal />} />
            <Route path="sync-hub" element={<SyncHub />} />
            <Route path="products-hub" element={<ProductsHub />} />
            <Route path="sales-hub" element={<SalesHub />} />
            <Route path="stock-hub" element={<StockHub />} />
            <Route path="customers-hub" element={<CustomersHub />} />
            <Route path="communication-hub" element={<CommunicationHub />} />
            <Route path="documents" element={<DocumentStorage />} />
            <Route path="reports-hub" element={<ReportsHub />} />
            <Route path="settings-hub" element={<SettingsHub />} />
            <Route path="pricing-settings" element={<PricingSettings />} />
            <Route path="website-hub" element={<WebsiteHub />} />
            <Route path="image-migration" element={<ImageMigration />} />
            <Route path="stocktake-report" element={<StocktakeReport />} />
            <Route path="showroom/:showroomSlug/epos" element={<ShowroomEpos />} />
            <Route path="showroom/:showroomSlug/invoices" element={<ShowroomInvoiceHistory />} />
            <Route path="sample-service-content" element={<SampleServiceContent />} />
            <Route path="sample-followups" element={<SampleFollowupsPage />} />
            <Route path="pallet-pricing-settings" element={<PalletPricingSettingsPage />} />
            <Route path="website-preview" element={<WebsitePreview />} />
            <Route path="sitemap" element={<SiteMapManager />} />
            <Route path="maintenance" element={<MaintenanceTasks />} />
            <Route path="website-categories" element={<WebsiteCategoriesManager />} />
            <Route path="website-filters" element={<WebsiteFiltersManager />} />
            <Route path="website-products" element={<WebsiteProductsEditor />} />
            <Route path="publish-products" element={<PublishSupplierProducts />} />
            <Route path="homepage-content" element={<HomepageContentEditor />} />
            <Route path="homepage-manager" element={<HomepageManager />} />
            <Route path="bathroom-page" element={<BathroomPageAdmin />} />
            <Route path="whatsapp" element={<WhatsAppManager />} />
            <Route path="website-settings" element={<WebsiteSettingsEditor />} />
            <Route path="announcement-ribbon" element={<AnnouncementRibbonAdmin />} />
            <Route path="navigation-menu" element={<NavigationMenuEditor />} />
            <Route path="navigation-structure" element={<NavigationStructureManager />} />
            <Route path="collection-manager" element={<CollectionManager />} />
            <Route path="collection-mapping" element={<CollectionMappingManager />} />
            <Route path="collection-detail-settings" element={<CollectionDetailSettings />} />
            <Route path="collections-page-settings" element={<CollectionsPageSettings />} />
            <Route path="collections" element={<CollectionsHub />} />
            <Route path="trade-account-settings" element={<TradeAccountSettings />} />
            <Route path="checkout-settings" element={<CheckoutSettings />} />
            <Route path="online-orders" element={<OnlineOrders />} />
            <Route path="live-visitors" element={<LiveVisitors />} />
            <Route path="customer-account-settings" element={<CustomerAccountSettings />} />
            <Route path="contact-page-settings" element={<ShowroomsManager />} />
            <Route path="tile-calculator-settings" element={<TileCalculatorSettings />} />
            <Route path="website-sales-dashboard" element={<WebsiteSalesDashboard />} />
            <Route path="website-analytics" element={<WebsiteAnalytics />} />
            <Route path="live-chat" element={<LiveChatAdmin />} />
            <Route path="page-maintenance" element={<PageMaintenanceAdmin />} />
            <Route path="welcome-popup" element={<WelcomePopupAdmin />} />
            <Route path="category-demo" element={<CategorySystemDemo />} />
            <Route path="permissions" element={<PermissionsAdmin />} />
            <Route path="notification-permissions" element={<NotificationAuthorizations />} />
            <Route path="me/subscriptions" element={<MySubscriptions />} />
            <Route path="abandoned-baskets" element={<AbandonedCartsAdmin />} />
            <Route path="promo-codes" element={<PromoCodesAdmin />} />
            <Route path="weekly-digest" element={<WeeklyDigestAdmin />} />
            <Route path="storefront-features" element={<StorefrontFeaturesAdmin />} />
            <Route path="failed-payments" element={<FailedPayments />} />
          </Route>

          <Route path="/customer" element={
            <ProtectedRoute requiredRole="customer">
              <Layout />
            </ProtectedRoute>
          }>
            <Route index element={<Navigate to="/customer/products" replace />} />
            <Route path="products" element={<CustomerProducts />} />
            <Route path="orders" element={<CustomerOrders />} />
          </Route>

          {/* Redirect /shop to root homepage */}
          <Route path="/shop" element={<Navigate to="/" replace />} />
          
          {/* Redirect old /shop/products to /tiles */}
          <Route path="/shop/products" element={<Navigate to="/tiles" replace />} />
          <Route path="/shop/products/:productId" element={
            <ShopAuthProvider>
              <ShopProductDetail />
            </ShopAuthProvider>
          } />
          
          <Route path="/shop/cart" element={
            <ShopAuthProvider>
              <TileCartProvider>
                <ShopLayout />
              </TileCartProvider>
            </ShopAuthProvider>
          }>
            <Route index element={<ShopCart />} />
          </Route>
          
          <Route path="/shop/checkout" element={
            <ShopAuthProvider>
              <TileCartProvider>
                <ShopLayout />
              </TileCartProvider>
            </ShopAuthProvider>
          }>
            <Route index element={<ShopCheckout />} />
            <Route path="recover/:token" element={<CheckoutRecover />} />
          </Route>
          
          <Route path="/shop/login" element={
            <ShopAuthProvider>
              <TileCartProvider>
                <ShopLayout />
              </TileCartProvider>
            </ShopAuthProvider>
          }>
            <Route index element={<ShopLogin />} />
          </Route>
          
          <Route path="/shop/register" element={
            <TileCartProvider>
              <WishlistProvider>
                <SampleCartProvider>
                  <CustomerRegisterPage />
                </SampleCartProvider>
              </WishlistProvider>
            </TileCartProvider>
          } />
          
          <Route path="/shop/account" element={
            <TileCartProvider>
              <WishlistProvider>
                <SampleCartProvider>
                  <CustomerAccountPage />
                </SampleCartProvider>
              </WishlistProvider>
            </TileCartProvider>
          } />
          
          <Route path="/shop/trade/register" element={
            <TileCartProvider>
              <WishlistProvider>
                <SampleCartProvider>
                  <TradeRegisterPage />
                </SampleCartProvider>
              </WishlistProvider>
            </TileCartProvider>
          } />
          
          <Route path="/shop/trade/account" element={
            <TileCartProvider>
              <WishlistProvider>
                <SampleCartProvider>
                  <TradeAccountPage />
                </SampleCartProvider>
              </WishlistProvider>
            </TileCartProvider>
          } />
          
          <Route path="/shop/order-success" element={
            <TileCartProvider>
              <WishlistProvider>
                <SampleCartProvider>
                  <OrderSuccessPage />
                </SampleCartProvider>
              </WishlistProvider>
            </TileCartProvider>
          } />
          
          <Route path="/shop/orders" element={
            <ShopAuthProvider>
              <ShopLayout />
            </ShopAuthProvider>
          }>
            <Route index element={<ShopOrders />} />
          </Route>
          
          <Route path="/shop/track" element={
            <TileCartProvider>
              <ShopAuthProvider>
                <ShopLayout />
              </ShopAuthProvider>
            </TileCartProvider>
          }>
            <Route index element={<OrderTracking />} />
          </Route>
          
          <Route path="/shop/stores" element={<Navigate to="/shop/contact" replace />} />
          
          <Route path="/shop/bathroom" element={
            <MaintenanceGuard>
            <TileCartProvider>
              <WishlistProvider>
                <SampleCartProvider>
                  <BathroomPage />
                </SampleCartProvider>
              </WishlistProvider>
            </TileCartProvider>
            </MaintenanceGuard>
          } />
          
          {/* New Tile Station E-commerce Routes */}
          {/* Main Collections Page (Claybrook style) */}
          <Route path="/shop/tiles" element={
            <TileCartProvider>
              <WishlistProvider>
                <SampleCartProvider>
                  <TileCollectionsPage />
                </SampleCartProvider>
              </WishlistProvider>
            </TileCartProvider>
          } />
          {/* Collection Detail Page — use splat to allow slashes in the series name (e.g. "70 x 350 x 20/5mm") */}
          <Route path="/shop/collection/*" element={
            <TileCartProvider>
              <WishlistProvider>
                <SampleCartProvider>
                  <StorefrontErrorBoundary routeName="collection-detail">
                    <CollectionDetailPage />
                  </StorefrontErrorBoundary>
                </SampleCartProvider>
              </WishlistProvider>
            </TileCartProvider>
          } />
          {/* Printable to-scale tile cheat-sheet (opens in new tab, browser handles PDF export) */}
          <Route path="/shop/tile-scale-print/:size" element={<TileScalePrintPage />} />
          {/* All Products List (traditional view) */}
          <Route path="/shop/all-tiles" element={
            <TileCartProvider>
              <WishlistProvider>
                <SampleCartProvider>
                  <TileListingPage />
                </SampleCartProvider>
              </WishlistProvider>
            </TileCartProvider>
          } />
          <Route path="/shop/tiles/:slug" element={
            <TileCartProvider>
              <WishlistProvider>
                <SampleCartProvider>
                  <TileProductRedirect />
                </SampleCartProvider>
              </WishlistProvider>
            </TileCartProvider>
          } />
          <Route path="/shop/tile-cart" element={
            <TileCartProvider>
              <WishlistProvider>
                <SampleCartProvider>
                  <TileCartPage />
                </SampleCartProvider>
              </WishlistProvider>
            </TileCartProvider>
          } />
          <Route path="/shop/refer" element={<ReferAFriendPage />} />
          <Route path="/shop/compare" element={<ComparePage />} />
          <Route path="/shop/tile-checkout" element={
            <TileCartProvider>
              <WishlistProvider>
                <SampleCartProvider>
                  <TileCheckoutPage />
                </SampleCartProvider>
              </WishlistProvider>
            </TileCartProvider>
          } />
          <Route path="/shop/tile-wishlist" element={
            <TileCartProvider>
              <WishlistProvider>
                <SampleCartProvider>
                  <TileWishlistPage />
                </SampleCartProvider>
              </WishlistProvider>
            </TileCartProvider>
          } />
          <Route path="/shop/tile-order-success" element={
            <TileCartProvider>
              <WishlistProvider>
                <SampleCartProvider>
                  <TileOrderSuccessPage />
                </SampleCartProvider>
              </WishlistProvider>
            </TileCartProvider>
          } />
          <Route path="/shop/tile-login" element={
            <TileCartProvider>
              <WishlistProvider>
                <SampleCartProvider>
                  <TileLoginPage />
                </SampleCartProvider>
              </WishlistProvider>
            </TileCartProvider>
          } />
          <Route path="/shop/tile-register" element={
            <TileCartProvider>
              <WishlistProvider>
                <SampleCartProvider>
                  <TileRegisterPage />
                </SampleCartProvider>
              </WishlistProvider>
            </TileCartProvider>
          } />
          <Route path="/shop/tile-account" element={
            <TileCartProvider>
              <WishlistProvider>
                <SampleCartProvider>
                  <TileAccountPage />
                </SampleCartProvider>
              </WishlistProvider>
            </TileCartProvider>
          } />
          <Route path="/visualizer" element={
            <TileCartProvider>
              <WishlistProvider>
                <SampleCartProvider>
                  <TileVisualizerPage />
                </SampleCartProvider>
              </WishlistProvider>
            </TileCartProvider>
          } />
          <Route path="/visualizer/share/:token" element={
            <TileCartProvider>
              <WishlistProvider>
                <SampleCartProvider>
                  <VisualizerSharePage />
                </SampleCartProvider>
              </WishlistProvider>
            </TileCartProvider>
          } />
          <Route path="/status" element={
            <TileCartProvider>
              <WishlistProvider>
                <SampleCartProvider>
                  <StatusPage />
                </SampleCartProvider>
              </WishlistProvider>
            </TileCartProvider>
          } />
          <Route path="/shop/tile-samples" element={
            <TileCartProvider>
              <WishlistProvider>
                <SampleCartProvider>
                  <TileSampleCartPage />
                </SampleCartProvider>
              </WishlistProvider>
            </TileCartProvider>
          } />
          <Route path="/shop/tile-sample-success" element={
            <TileCartProvider>
              <WishlistProvider>
                <SampleCartProvider>
                  <TileSampleSuccessPage />
                </SampleCartProvider>
              </WishlistProvider>
            </TileCartProvider>
          } />
          <Route path="/shop/sample-service" element={
            <TileCartProvider>
              <WishlistProvider>
                <SampleCartProvider>
                  <TileSampleServicePage />
                </SampleCartProvider>
              </WishlistProvider>
            </TileCartProvider>
          } />
          <Route path="/shop/trade" element={<Navigate to="/shop/trade/register" replace />} />
          <Route path="/showroom-signup" element={<ShowroomSignupPage />} />
          <Route path="/shop/trade/login" element={
            <TileCartProvider>
              <WishlistProvider>
                <SampleCartProvider>
                  <TradeLoginPage />
                </SampleCartProvider>
              </WishlistProvider>
            </TileCartProvider>
          } />
          <Route path="/shop/calculator" element={
            <TileCartProvider>
              <WishlistProvider>
                <SampleCartProvider>
                  <TileCalculatorPage />
                </SampleCartProvider>
              </WishlistProvider>
            </TileCartProvider>
          } />
          <Route path="/tiles" element={
            <MaintenanceGuard>
            <TileCartProvider>
              <WishlistProvider>
                <SampleCartProvider>
                  <TileCollectionsPage />
                </SampleCartProvider>
              </WishlistProvider>
            </TileCartProvider>
            </MaintenanceGuard>
          } />
          <Route path="/shop/search" element={
            <MaintenanceGuard>
            <TileCartProvider>
              <WishlistProvider>
                <SampleCartProvider>
                  <ShopSearchResultsPage />
                </SampleCartProvider>
              </WishlistProvider>
            </TileCartProvider>
            </MaintenanceGuard>
          } />
          <Route path="/tiles/:slug" element={
            <MaintenanceGuard>
            <TileCartProvider>
              <WishlistProvider>
                <SampleCartProvider>
                  <TileProductRedirect />
                </SampleCartProvider>
              </WishlistProvider>
            </TileCartProvider>
            </MaintenanceGuard>
          } />
          <Route path="/clearance" element={
            <MaintenanceGuard>
            <TileCartProvider>
              <WishlistProvider>
                <SampleCartProvider>
                  <ClearancePage />
                </SampleCartProvider>
              </WishlistProvider>
            </TileCartProvider>
            </MaintenanceGuard>
          } />
          <Route path="/new-collection" element={
            <MaintenanceGuard>
            <TileCartProvider>
              <WishlistProvider>
                <SampleCartProvider>
                  <NewCollectionPage />
                </SampleCartProvider>
              </WishlistProvider>
            </TileCartProvider>
            </MaintenanceGuard>
          } />
          <Route path="/shop/contact" element={
            <MaintenanceGuard>
            <ShopAuthProvider>
            <TileCartProvider>
              <WishlistProvider>
                <SampleCartProvider>
                  <ShopLayout />
                </SampleCartProvider>
              </WishlistProvider>
            </TileCartProvider>
            </ShopAuthProvider>
            </MaintenanceGuard>
          }>
            <Route index element={<ContactPage />} />
          </Route>

          {/* Dynamic Info Pages (delivery, returns, faq, privacy, terms, etc.) */}
          <Route path="/shop/info/:slug" element={
            <MaintenanceGuard>
            <ShopAuthProvider>
            <TileCartProvider>
              <WishlistProvider>
                <SampleCartProvider>
                  <ShopLayout />
                </SampleCartProvider>
              </WishlistProvider>
            </TileCartProvider>
            </ShopAuthProvider>
            </MaintenanceGuard>
          }>
            <Route index element={<InfoPage />} />
          </Route>

          {/* Legacy/flat info-page paths — redirect to canonical /shop/info/:slug.
             Added as part of launch-day link audit (P0 fix). */}
          <Route path="/shop/privacy" element={<Navigate to="/shop/info/privacy" replace />} />
          <Route path="/shop/terms" element={<Navigate to="/shop/info/terms" replace />} />
          <Route path="/shop/faq" element={<Navigate to="/shop/info/faq" replace />} />
          <Route path="/shop/returns" element={<Navigate to="/shop/info/returns" replace />} />
          <Route path="/shop/delivery" element={<Navigate to="/shop/info/delivery" replace />} />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </GlobalMaintenanceGate>
        <CompareTray />
      </BrowserRouter>
      </MaintenanceProvider>
      <InstallPWA />
      <Toaster position="top-right" />
      </CompareProvider>
      </PermissionsProvider>
      </AuthProvider>
    </AppLoader>
  );
}

export default App;

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
const AdminDashboard = React.lazy(() => import('./pages/admin/Dashboard').then(m => ({ default: m.AdminDashboard })));
const ProductForm = React.lazy(() => import('./pages/admin/ProductForm').then(m => ({ default: m.ProductForm })));
const AdminCategories = React.lazy(() => import('./pages/admin/Categories').then(m => ({ default: m.AdminCategories })));
const AdminOrders = React.lazy(() => import('./pages/admin/Orders').then(m => ({ default: m.AdminOrders })));
const AdminReports = React.lazy(() => import('./pages/admin/Reports').then(m => ({ default: m.AdminReports })));
const CustomerPricing = React.lazy(() => import('./pages/admin/CustomerPricing').then(m => ({ default: m.CustomerPricing })));
const BulkInquiries = React.lazy(() => import('./pages/admin/BulkInquiries').then(m => ({ default: m.BulkInquiries })));
const CustomerInvites = React.lazy(() => import('./pages/admin/CustomerInvites').then(m => ({ default: m.CustomerInvites })));
const Marketing = React.lazy(() => import('./pages/admin/Marketing').then(m => ({ default: m.Marketing })));
const SeoCommandCentre = React.lazy(() => import('./pages/admin/SeoCommandCentre'));
const GoogleBusinessProfile = React.lazy(() => import('./pages/admin/GoogleBusinessProfile'));
const GoogleSearchConsole = React.lazy(() => import('./pages/admin/GoogleSearchConsole'));
const VisualizerAdmin = React.lazy(() => import('./pages/admin/VisualizerAdmin'));
const MarketingStudio = React.lazy(() => import('./pages/admin/MarketingStudio'));
const RadioStudio = React.lazy(() => import('./pages/admin/RadioStudio'));
const TradeCreditEmails = React.lazy(() => import('./pages/admin/TradeCreditEmails'));
const EmailHub = React.lazy(() => import('./pages/admin/EmailHub'));
const PinterestPack = React.lazy(() => import('./pages/admin/PinterestPack'));
const StripeReconcile = React.lazy(() => import('./pages/admin/StripeReconcile'));
const UnsubscribePage = React.lazy(() => import('./pages/public/UnsubscribePage'));
const PublicRadioPage = React.lazy(() => import('./pages/public/PublicRadioPage'));
const VideoStudio = React.lazy(() => import('./pages/admin/VideoStudio'));
const BlogIndexPage = React.lazy(() => import('./pages/shop/BlogIndexPage'));
const BlogArticlePage = React.lazy(() => import('./pages/shop/BlogArticlePage'));
const HealthMonitor = React.lazy(() => import('./pages/admin/HealthMonitor'));
const GoogleAdsSavings = React.lazy(() => import('./pages/admin/GoogleAdsSavings'));
const SeoAutopilot = React.lazy(() => import('./pages/admin/SeoAutopilot'));
const SeoAutopilotV2 = React.lazy(() => import('./pages/admin/SeoAutopilotV2'));
const MissionTopps = React.lazy(() => import('./pages/admin/MissionTopps'));
const Showrooms = React.lazy(() => import('./pages/admin/Showrooms').then(m => ({ default: m.Showrooms })));
const UserManagement = React.lazy(() => import('./pages/admin/UserManagement').then(m => ({ default: m.UserManagement })));
const Invoice = React.lazy(() => import('./pages/admin/Invoice'));
const InvoiceHistory = React.lazy(() => import('./pages/admin/InvoiceHistory').then(m => ({ default: m.InvoiceHistory })));
const Quotation = React.lazy(() => import('./pages/admin/Quotation'));
const QuotationHistory = React.lazy(() => import('./pages/admin/QuotationHistory'));
const CashQuotation = React.lazy(() => import('./pages/admin/CashQuotation').then(m => ({ default: m.CashQuotation })));
const CashQuotationHistory = React.lazy(() => import('./pages/admin/CashQuotationHistory').then(m => ({ default: m.CashQuotationHistory })));
const Refund = React.lazy(() => import('./pages/admin/Refund').then(m => ({ default: m.Refund })));
const RefundHistory = React.lazy(() => import('./pages/admin/RefundHistory').then(m => ({ default: m.RefundHistory })));
const CreditNote = React.lazy(() => import('./pages/admin/CreditNote').then(m => ({ default: m.CreditNote })));
const CreditNoteHistory = React.lazy(() => import('./pages/admin/CreditNoteHistory').then(m => ({ default: m.CreditNoteHistory })));
const ClearanceProducts = React.lazy(() => import('./pages/admin/ClearanceProducts').then(m => ({ default: m.ClearanceProducts })));
const NewCollectionProducts = React.lazy(() => import('./pages/admin/NewCollectionProducts').then(m => ({ default: m.NewCollectionProducts })));
const StaffPins = React.lazy(() => import('./pages/admin/StaffPins').then(m => ({ default: m.StaffPins })));
const Epos = React.lazy(() => import('./pages/admin/Epos').then(m => ({ default: m.Epos })));
const StaffInvites = React.lazy(() => import('./pages/admin/StaffInvites').then(m => ({ default: m.StaffInvites })));
import { StaffRegister } from './pages/StaffRegister';
const Analytics = React.lazy(() => import('./pages/admin/Analytics').then(m => ({ default: m.Analytics })));
const AuditTrail = React.lazy(() => import('./pages/admin/AuditTrail').then(m => ({ default: m.AuditTrail })));
const EmailComposer = React.lazy(() => import('./pages/admin/EmailComposer').then(m => ({ default: m.EmailComposer })));
const EmailInbox = React.lazy(() => import('./pages/admin/EmailInbox').then(m => ({ default: m.EmailInbox })));
const NotificationSettings = React.lazy(() => import('./pages/admin/NotificationSettings').then(m => ({ default: m.NotificationSettings })));
const SettingsPage = React.lazy(() => import('./pages/admin/SettingsPage').then(m => ({ default: m.SettingsPage })));
const PriceTickets = React.lazy(() => import('./pages/admin/PriceTickets').then(m => ({ default: m.PriceTickets })));
const ShowroomDashboard = React.lazy(() => import('./pages/admin/ShowroomDashboard').then(m => ({ default: m.ShowroomDashboard })));
const StockAllocation = React.lazy(() => import('./pages/admin/StockAllocation').then(m => ({ default: m.StockAllocation })));
const DeliveryCheckIn = React.lazy(() => import('./pages/admin/DeliveryCheckIn').then(m => ({ default: m.DeliveryCheckIn })));
const OrderManagement = React.lazy(() => import('./pages/admin/OrderManagement'));
const DeliveryManagement = React.lazy(() => import('./pages/admin/DeliveryManagement'));
const ShowroomEpos = React.lazy(() => import('./pages/admin/ShowroomEpos').then(m => ({ default: m.ShowroomEpos })));
const ShowroomInvoiceHistory = React.lazy(() => import('./pages/admin/ShowroomInvoiceHistory').then(m => ({ default: m.ShowroomInvoiceHistory })));
const StaffChat = React.lazy(() => import('./pages/admin/StaffChat').then(m => ({ default: m.StaffChat })));
const TilesInfo = React.lazy(() => import('./pages/admin/TilesInfo').then(m => ({ default: m.TilesInfo })));
const TradeList = React.lazy(() => import('./pages/admin/TradeList').then(m => ({ default: m.TradeList })));
const TradeAccounts = React.lazy(() => import('./pages/admin/TradeAccounts'));
const TradeAccountSettings = React.lazy(() => import('./pages/admin/TradeAccountSettings'));
const CheckoutSettings = React.lazy(() => import('./pages/admin/CheckoutSettings'));
const OnlineOrders = React.lazy(() => import('./pages/admin/OnlineOrders'));
const SampleOrders = React.lazy(() => import('./pages/admin/SampleOrders'));
const LiveVisitors = React.lazy(() => import('./pages/admin/LiveVisitors'));
const CustomerAccountSettings = React.lazy(() => import('./pages/admin/CustomerAccountSettings'));
const TasksNotes = React.lazy(() => import('./pages/admin/TasksNotes'));
import ProductImport from './components/ProductImport';
const Trash = React.lazy(() => import('./pages/admin/Trash'));
const StockCostReport = React.lazy(() => import('./pages/admin/StockCostReport').then(m => ({ default: m.StockCostReport })));
const CashCounter = React.lazy(() => import('./pages/admin/CashCounter'));
const ImageScraper = React.lazy(() => import('./pages/admin/ImageScraper'));
const ToOrderReport = React.lazy(() => import('./pages/admin/ToOrderReport'));
const StockImport = React.lazy(() => import('./pages/admin/StockImport'));
const BulkStockEdit = React.lazy(() => import('./pages/admin/BulkStockEdit'));
const Suppliers = React.lazy(() => import('./pages/admin/Suppliers'));
const StocktakeReport = React.lazy(() => import('./pages/admin/StocktakeReport'));
const SupplierSyncDashboard = React.lazy(() => import('./pages/admin/SupplierSyncDashboard'));
const SupplierProducts = React.lazy(() => import('./pages/admin/SupplierProducts'));
const ProductNameSanity = React.lazy(() => import('./pages/admin/ProductNameSanity'));
const MaterialsManager = React.lazy(() => import('./pages/admin/MaterialsManager'));
const TilesManager = React.lazy(() => import('./pages/admin/TilesManager'));
const ClearanceHub = React.lazy(() => import('./pages/admin/ClearanceHub'));
const FlooringManager = React.lazy(() => import('./pages/admin/FlooringManager'));
const BathroomManager = React.lazy(() => import('./pages/admin/BathroomManager'));
const UnderfloorHeatingManager = React.lazy(() => import('./pages/admin/UnderfloorHeatingManager'));
const ToolsManager = React.lazy(() => import('./pages/admin/ToolsManager'));
const CustomManager = React.lazy(() => import('./pages/admin/CustomManager'));
const SupplierHealthDashboard = React.lazy(() => import('./pages/admin/SupplierHealthDashboard'));
const WallcanoPriceImport = React.lazy(() => import('./pages/admin/WallcanoPriceImport'));
const PublishSupplierProducts = React.lazy(() => import('./pages/admin/PublishSupplierProducts'));
const ScrapingPortal = React.lazy(() => import('./pages/admin/ScrapingPortal'));
const SyncHub = React.lazy(() => import('./pages/admin/SyncHub'));
const ProductsHub = React.lazy(() => import('./pages/admin/ProductsHub'));
const SalesHub = React.lazy(() => import('./pages/admin/SalesHub'));
const StaffPerformanceDashboard = React.lazy(() => import('./pages/admin/StaffPerformanceDashboard'));
const StarStaffPage = React.lazy(() => import('./pages/admin/StarStaffPage'));
const ExpiredQuotesPage = React.lazy(() => import('./pages/admin/ExpiredQuotesPage'));
const StaffCompetitionDashboard = React.lazy(() => import('./pages/admin/StaffCompetitionDashboard'));
const DataHygiene = React.lazy(() => import('./pages/admin/DataHygiene'));
const HRPortal = React.lazy(() => import('./pages/admin/HRPortal'));
const TelephonyAdmin = React.lazy(() => import('./pages/admin/Telephony'));
const MyHR = React.lazy(() => import('./pages/staff/MyHR'));
const ClockInOut = React.lazy(() => import('./pages/staff/ClockInOut'));
const LoyaltyDashboard = React.lazy(() => import('./pages/admin/LoyaltyDashboard'));
const ManageCategories = React.lazy(() => import('./pages/admin/ManageCategories'));
const ReorderSuggestions = React.lazy(() => import('./pages/admin/ReorderSuggestions'));
const StockTransfers = React.lazy(() => import('./pages/admin/StockTransfers'));
const QuoteRequests = React.lazy(() => import('./pages/admin/QuoteRequests'));
const BatchTracking = React.lazy(() => import('./pages/admin/BatchTracking'));
const StockHub = React.lazy(() => import('./pages/admin/StockHub'));
const Warehouse = React.lazy(() => import('./pages/admin/Warehouse'));
const CustomersHub = React.lazy(() => import('./pages/admin/CustomersHub'));
const CommunicationHub = React.lazy(() => import('./pages/admin/CommunicationHub'));
const DocumentStorage = React.lazy(() => import('./pages/admin/DocumentStorage'));
const ReportsHub = React.lazy(() => import('./pages/admin/ReportsHub'));
const SettingsHub = React.lazy(() => import('./pages/admin/SettingsHub'));
const EmailHealthPage = React.lazy(() => import('./pages/admin/EmailHealthPage'));
const PermissionsAdmin = React.lazy(() => import('./pages/admin/PermissionsAdmin'));
const NotificationAuthorizations = React.lazy(() => import('./pages/admin/NotificationAuthorizations'));
const MySubscriptions = React.lazy(() => import('./pages/admin/MySubscriptions'));
const AbandonedCartsAdmin = React.lazy(() => import('./pages/admin/AbandonedCartsAdmin'));
const PendingMarketingEmails = React.lazy(() => import('./pages/admin/PendingMarketingEmails'));
const PromoCodesAdmin = React.lazy(() => import('./pages/admin/PromoCodesAdmin'));
const WeeklyDigestAdmin = React.lazy(() => import('./pages/admin/WeeklyDigestAdmin'));
const StorefrontFeaturesAdmin = React.lazy(() => import('./pages/admin/StorefrontFeaturesAdmin'));
const ReferAFriendPage = React.lazy(() => import('./pages/shop/ReferAFriendPage'));
const ComparePage = React.lazy(() => import('./pages/shop/ComparePage'));
import CompareTray from './components/shop/CompareTray';
const SecuritySettings = React.lazy(() => import('./pages/admin/SecuritySettings').then(m => ({ default: m.SecuritySettings })));
const PricingSettings = React.lazy(() => import('./pages/admin/PricingSettings'));
const WebsiteHub = React.lazy(() => import('./pages/admin/WebsiteHub'));
const MaintenanceTasks = React.lazy(() => import('./pages/admin/MaintenanceTasks'));
const ImageMigration = React.lazy(() => import('./pages/admin/ImageMigration'));
const TileCalculatorSettings = React.lazy(() => import('./pages/admin/TileCalculatorSettings'));
const WebsiteSalesDashboard = React.lazy(() => import('./pages/admin/WebsiteSalesDashboard'));
// Website Admin imports
const WebsiteCategoriesManager = React.lazy(() => import('./pages/admin/WebsiteCategoriesManager'));
const WebsiteFiltersManager = React.lazy(() => import('./pages/admin/WebsiteFiltersManager'));
const WebsiteProductsEditor = React.lazy(() => import('./pages/admin/WebsiteProductsEditor'));
const HomepageContentEditor = React.lazy(() => import('./pages/admin/HomepageContentEditor'));
const HomepageManager = React.lazy(() => import('./pages/admin/HomepageManager'));
const BathroomPageAdmin = React.lazy(() => import('./pages/admin/BathroomPageAdmin'));
const WhatsAppManager = React.lazy(() => import('./pages/admin/WhatsAppManager'));
const WebsiteSettingsEditor = React.lazy(() => import('./pages/admin/WebsiteSettingsEditor'));
const AnnouncementRibbonAdmin = React.lazy(() => import('./pages/admin/AnnouncementRibbonAdmin'));
const NavigationMenuEditor = React.lazy(() => import('./pages/admin/NavigationMenuEditor'));
const NavigationStructureManager = React.lazy(() => import('./pages/admin/NavigationStructureManager'));
const WebsiteGlobalManager = React.lazy(() => import('./pages/admin/WebsiteGlobalManager'));
const CollectionManager = React.lazy(() => import('./pages/admin/CollectionManager'));
const CollectionMappingManager = React.lazy(() => import('./pages/admin/CollectionMappingManager'));
const CollectionDetailSettings = React.lazy(() => import('./pages/admin/CollectionDetailSettings'));
const CollectionsPageSettings = React.lazy(() => import('./pages/admin/CollectionsPageSettings'));
const CollectionsHub = React.lazy(() => import('./pages/admin/CollectionsHub'));
const ShowroomsManager = React.lazy(() => import('./pages/admin/ShowroomsManager'));
const WebsitePreview = React.lazy(() => import('./pages/admin/WebsitePreview'));
const SiteMapManager = React.lazy(() => import('./pages/admin/SiteMapManager'));
const WebsiteAnalytics = React.lazy(() => import('./pages/admin/WebsiteAnalytics'));
const LiveChatAdmin = React.lazy(() => import('./pages/admin/LiveChatAdmin'));
const PageMaintenanceAdmin = React.lazy(() => import('./pages/admin/PageMaintenanceAdmin'));
const WelcomePopupAdmin = React.lazy(() => import('./pages/admin/WelcomePopupAdmin'));
const CustomerProducts = React.lazy(() => import('./pages/customer/Products').then(m => ({ default: m.CustomerProducts })));
const CustomerOrders = React.lazy(() => import('./pages/customer/Orders').then(m => ({ default: m.CustomerOrders })));
import ForgotPassword from './pages/auth/ForgotPassword';
import ResetPassword from './pages/auth/ResetPassword';
// Shop (E-commerce) imports
import { ShopLayout } from './components/shop/ShopLayout';
const ShopHome = React.lazy(() => import('./pages/shop/ShopHome').then(m => ({ default: m.ShopHome })));
const ShopProducts = React.lazy(() => import('./pages/shop/ShopProducts').then(m => ({ default: m.ShopProducts })));
const ShopProductDetail = React.lazy(() => import('./pages/shop/ShopProductDetail').then(m => ({ default: m.ShopProductDetail })));
const ShopCart = React.lazy(() => import('./pages/shop/ShopCart').then(m => ({ default: m.ShopCart })));
const ShopCheckout = React.lazy(() => import('./pages/shop/ShopCheckout').then(m => ({ default: m.ShopCheckout })));
const CheckoutRecover = React.lazy(() => import('./pages/shop/CheckoutRecover'));
const FailedPayments = React.lazy(() => import('./pages/admin/FailedPayments'));
const ShopLogin = React.lazy(() => import('./pages/shop/ShopLogin').then(m => ({ default: m.ShopLogin })));
const ShopRegister = React.lazy(() => import('./pages/shop/ShopRegister').then(m => ({ default: m.ShopRegister })));
const ShopOrderSuccess = React.lazy(() => import('./pages/shop/ShopOrderSuccess').then(m => ({ default: m.ShopOrderSuccess })));
const ShopOrders = React.lazy(() => import('./pages/shop/ShopOrders').then(m => ({ default: m.ShopOrders })));
const ShopStores = React.lazy(() => import('./pages/shop/ShopStores').then(m => ({ default: m.ShopStores })));
const OrderTracking = React.lazy(() => import('./pages/shop/OrderTracking').then(m => ({ default: m.OrderTracking })));
import TileStationHome from './pages/shop/TileStationHome';
const ContactPage = React.lazy(() => import('./pages/shop/ContactPage'));
const InfoPage = React.lazy(() => import('./pages/shop/InfoPage'));
const ClearancePage = React.lazy(() => import('./pages/shop/ClearancePage')); // retired — /clearance now redirects to /tiles?clearance=true
const NewCollectionPage = React.lazy(() => import('./pages/shop/NewCollectionPage'));
const TileListingPage = React.lazy(() => import('./pages/shop/TileListingPage'));
const TileCollectionsPage = React.lazy(() => import('./pages/shop/TileCollectionsPage'));
const ShopSearchResultsPage = React.lazy(() => import('./pages/shop/ShopSearchResultsPage'));
const CollectionDetailPage = React.lazy(() => import('./pages/shop/CollectionDetailPage'));
import StorefrontErrorBoundary from './components/shop/StorefrontErrorBoundary';
const TileScalePrintPage = React.lazy(() => import('./pages/shop/TileScalePrintPage'));
const TileDetailPage = React.lazy(() => import('./pages/shop/TileDetailPage'));
const TileProductRedirect = React.lazy(() => import('./pages/shop/TileProductRedirect'));
const TileCartPage = React.lazy(() => import('./pages/shop/TileCartPage'));
const BathroomPage = React.lazy(() => import('./pages/shop/BathroomPage'));
const CategoryShopPage = React.lazy(() => import('./pages/shop/CategoryShopPage'));
const TileCheckoutPage = React.lazy(() => import('./pages/shop/TileCheckoutPage'));
const OrderSuccessPage = React.lazy(() => import('./pages/shop/OrderSuccessPage'));
const TileWishlistPage = React.lazy(() => import('./pages/shop/TileWishlistPage'));
const TileOrderSuccessPage = React.lazy(() => import('./pages/shop/TileOrderSuccessPage'));
const TileLoginPage = React.lazy(() => import('./pages/shop/TileLoginPage'));
const TileRegisterPage = React.lazy(() => import('./pages/shop/TileRegisterPage'));
const TileAccountPage = React.lazy(() => import('./pages/shop/TileAccountPage'));
const TileSampleCartPage = React.lazy(() => import('./pages/shop/TileSampleCartPage'));
const TileVisualizerPage = React.lazy(() => import('./pages/shop/TileVisualizerPage'));
const VisualizerSharePage = React.lazy(() => import('./pages/shop/VisualizerSharePage'));
const StatusPage = React.lazy(() => import('./pages/shop/StatusPage'));
const TileSampleSuccessPage = React.lazy(() => import('./pages/shop/TileSampleSuccessPage'));
const TileSampleServicePage = React.lazy(() => import('./pages/shop/TileSampleServicePage'));
const TradeSignupPage = React.lazy(() => import('./pages/shop/TradeSignupPage'));
const TradeRegisterPage = React.lazy(() => import('./pages/shop/TradeRegisterPage'));
const TradeLoginPage = React.lazy(() => import('./pages/shop/TradeLoginPage'));
const ShowroomSignupPage = React.lazy(() => import('./pages/shop/ShowroomSignupPage'));
const TradeAccountPage = React.lazy(() => import('./pages/shop/TradeAccountPage'));
const TraderCreditStatementPage = React.lazy(() => import('./pages/shop/TraderCreditStatementPage'));
const CustomerRegisterPage = React.lazy(() => import('./pages/shop/CustomerRegisterPage'));
const CustomerAccountPage = React.lazy(() => import('./pages/shop/CustomerAccountPage'));
const TileCalculatorPage = React.lazy(() => import('./pages/shop/TileCalculatorPage'));
const SampleServiceContent = React.lazy(() => import('./pages/admin/SampleServiceContent'));
const SampleFollowupsPage = React.lazy(() => import('./pages/admin/SampleFollowupsPage'));
const PalletPricingSettingsPage = React.lazy(() => import('./pages/admin/PalletPricingSettingsPage'));
const CategorySystemDemo = React.lazy(() => import('./pages/admin/CategorySystemDemo'));
const TrainingBookletEditor = React.lazy(() => import('./pages/admin/TrainingBookletEditor'));
const TelegramNotifications = React.lazy(() => import('./pages/admin/TelegramNotifications'));
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
          <React.Suspense fallback={
            <div className="flex items-center justify-center min-h-screen">
              <div className="animate-spin h-10 w-10 rounded-full border-4 border-gray-200 border-t-gray-800" data-testid="route-suspense-fallback" />
            </div>
          }>
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
            <Route path="/clock" element={<ClockInOut />} />
            <Route path="/my-hr" element={<MyHR />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
          {/* Shop alias — login/trade pages link here with ?email= prefill */}
          <Route path="/shop/tile-forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/unsubscribe" element={<UnsubscribePage />} />
            <Route path="/radio" element={<PublicRadioPage />} />

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
            <Route path="gsc" element={<GoogleSearchConsole />} />
            <Route path="visualizer" element={<VisualizerAdmin />} />
            <Route path="marketing-studio" element={<MarketingStudio />} />
            <Route path="radio-studio" element={<RadioStudio />} />
            <Route path="trade-credit-emails" element={<TradeCreditEmails />} />
            <Route path="email-hub" element={<EmailHub />} />
            <Route path="pinterest-pack" element={<PinterestPack />} />
            <Route path="stripe-reconcile" element={<StripeReconcile />} />
            <Route path="marketing-studio/videos" element={<VideoStudio />} />
            <Route path="health" element={<HealthMonitor />} />
            <Route path="ads-savings" element={<GoogleAdsSavings />} />
            <Route path="seo-autopilot" element={<SeoAutopilot />} />
            <Route path="seo-autopilot-v2" element={<SeoAutopilotV2 />} />
            <Route path="mission-topps" element={<MissionTopps />} />
            <Route path="showrooms" element={<Showrooms />} />
            <Route path="users" element={<UserManagement />} />
            <Route path="staff-invites" element={<StaffInvites />} />
            <Route path="analytics" element={<Analytics />} />
            <Route path="staff-performance" element={<StaffPerformanceDashboard />} />
            <Route path="star-staff" element={<StarStaffPage />} />
            <Route path="expired-quotes" element={<ExpiredQuotesPage />} />
            <Route path="staff-competition" element={<StaffCompetitionDashboard />} />
            <Route path="data-hygiene" element={<DataHygiene />} />
            <Route path="hr" element={<HRPortal />} />
            <Route path="telephony" element={<TelephonyAdmin />} />
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
            <Route path="to-order" element={<ToOrderReport />} />
            <Route path="stock-import" element={<StockImport />} />
            <Route path="bulk-stock" element={<BulkStockEdit />} />
            <Route path="suppliers" element={<Suppliers />} />
            <Route path="supplier-sync" element={<SupplierSyncDashboard />} />
            <Route path="supplier-products" element={<SupplierProducts />} />
            <Route path="product-name-sanity" element={<ProductNameSanity />} />
            <Route path="materials" element={<MaterialsManager />} />
            <Route path="tiles" element={<TilesManager />} />
            <Route path="clearance" element={<ClearanceHub />} />
            <Route path="flooring" element={<FlooringManager />} />
            <Route path="bathroom" element={<BathroomManager />} />
            <Route path="underfloor-heating" element={<UnderfloorHeatingManager />} />
            <Route path="tools" element={<ToolsManager />} />
            <Route path="custom-manager/:slug" element={<CustomManager />} />
            <Route path="supplier-health" element={<SupplierHealthDashboard />} />
            <Route path="manage-categories" element={<ManageCategories />} />
            <Route path="wallcano-prices" element={<WallcanoPriceImport />} />
            <Route path="scraping-portal" element={<ScrapingPortal />} />
            <Route path="scraping" element={<ScrapingPortal />} />
            <Route path="sync-hub" element={<SyncHub />} />
            <Route path="products-hub" element={<ProductsHub />} />
            <Route path="sales-hub" element={<SalesHub />} />
            <Route path="stock-hub" element={<StockHub />} />
            <Route path="warehouse" element={<Warehouse />} />
            <Route path="customers-hub" element={<CustomersHub />} />
            <Route path="communication-hub" element={<CommunicationHub />} />
            <Route path="documents" element={<DocumentStorage />} />
            <Route path="reports-hub" element={<ReportsHub />} />
            <Route path="settings-hub" element={<SettingsHub />} />
            <Route path="email-health" element={<EmailHealthPage />} />
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
            <Route path="website-structure" element={<WebsiteGlobalManager />} />
            <Route path="collection-manager" element={<CollectionManager />} />
            <Route path="collection-mapping" element={<CollectionMappingManager />} />
            <Route path="collection-detail-settings" element={<CollectionDetailSettings />} />
            <Route path="collections-page-settings" element={<CollectionsPageSettings />} />
            <Route path="collections" element={<CollectionsHub />} />
            <Route path="trade-account-settings" element={<TradeAccountSettings />} />
            <Route path="checkout-settings" element={<CheckoutSettings />} />
            <Route path="online-orders" element={<OnlineOrders />} />
            <Route path="sample-orders" element={<SampleOrders />} />
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
            <Route path="marketing/pending-emails" element={<PendingMarketingEmails />} />
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

          {/* /shop is the legacy Wix landing — redirect to /tiles for
              both UX consistency and SEO (avoids the GSC "Page with
              redirect" warning that fired on 12 May 2026). Production
              also has a real HTTP 301 in frontend/server.js. */}
          <Route path="/shop" element={<Navigate to="/tiles" replace />} />
          
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
                  <StorefrontErrorBoundary routeName="trade-account">
                    <TradeAccountPage />
                  </StorefrontErrorBoundary>
                </SampleCartProvider>
              </WishlistProvider>
            </TileCartProvider>
          } />
          
          <Route path="/shop/trade/credit-statement" element={
            <TraderCreditStatementPage />
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
          
          {/* Universal category shop page — filters + product grid for any category
             (bathroom, flooring, materials, underfloor-heating, tools, or custom Manager slug) */}
          <Route path="/shop/browse/:category" element={
            <MaintenanceGuard>
            <TileCartProvider>
              <WishlistProvider>
                <SampleCartProvider>
                  <CategoryShopPage />
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
                  <StorefrontErrorBoundary routeName="tile-cart">
                    <TileCartPage />
                  </StorefrontErrorBoundary>
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
                  <StorefrontErrorBoundary routeName="tile-checkout">
                    <TileCheckoutPage />
                  </StorefrontErrorBoundary>
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
          <Route path="/clearance" element={<Navigate to="/tiles?clearance=true" replace />} />
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

          {/* ─────────────────────────────────────────────────────────
              Top-level "phantom URL" hotfix — 24 May 2026
              User reported the Google Business Profile sitelink
              "About Tile Station" landed on Page Not Found. Root
              cause: the SSR layer (server-seo-enrich.js) was
              injecting <title>/meta/<h1> tags for /about, /contact,
              /faq, /delivery, /returns, /privacy, /terms, /reviews
              — so Google indexed them — but the React SPA had no
              client-side routes for any of them. Real users hit the
              SPA's NotFound fallback. These redirects:
                • Fix the broken UX immediately (real users land on
                  the working canonical page).
                • Let Google consolidate ranking signals onto
                  /shop/info/:slug as it recrawls.
                • Keep the SSR-injected SEO content intact so search
                  rankings aren't disrupted. */}
          <Route path="/about" element={<Navigate to="/shop/info/about" replace />} />
          <Route path="/contact" element={<Navigate to="/shop/contact" replace />} />
          <Route path="/faq" element={<Navigate to="/shop/info/faq" replace />} />
          <Route path="/delivery" element={<Navigate to="/shop/info/delivery" replace />} />
          <Route path="/returns" element={<Navigate to="/shop/info/returns" replace />} />
          <Route path="/privacy" element={<Navigate to="/shop/info/privacy" replace />} />
          <Route path="/terms" element={<Navigate to="/shop/info/terms" replace />} />
          <Route path="/reviews" element={<Navigate to="/shop/info/reviews" replace />} />

          {/* ─────────────────────────────────────────────────────────
              GSC "Page with redirect" hotfix — 12 May 2026
              Google Search Console flagged 19 URLs as "Page with
              redirect" because React Router's catch-all sent them to /.
              These Routes catch the legacy URLs FIRST and redirect to
              the correct current page. Real server-side 301s are in
              frontend/server.js for production SEO — these client-side
              routes cover the dev environment + any SPA navigation. */}
          <Route path="/product-page/hartley-collection" element={<Navigate to="/shop/collection/Hartley" replace />} />
          <Route path="/shop/reviews" element={<Navigate to="/shop/info/reviews" replace />} />
          <Route path="/shop/track-order" element={<Navigate to="/shop/track" replace />} />
          <Route path="/track" element={<Navigate to="/shop/track" replace />} />
          <Route path="/track-order" element={<Navigate to="/shop/track" replace />} />
          <Route path="/bathroom" element={<Navigate to="/shop/bathroom" replace />} />
          <Route path="/category/ceramic-tiles" element={<Navigate to="/tiles?material=ceramic" replace />} />
          <Route path="/category/porcelain-tiles" element={<Navigate to="/tiles?material=porcelain" replace />} />
          <Route path="/category/marble-tiles" element={<Navigate to="/tiles?material=marble" replace />} />
          <Route path="/category/stone-tiles" element={<Navigate to="/tiles?material=stone" replace />} />
          <Route path="/category/spanish-tiles" element={<Navigate to="/tiles?origin=spain" replace />} />
          <Route path="/category/polish-tiles" element={<Navigate to="/tiles?finish=polished" replace />} />
          <Route path="/category/metro-tiles" element={<Navigate to="/tiles?shape=metro" replace />} />
          <Route path="/category/wood-tiles" element={<Navigate to="/tiles?effect=wood" replace />} />
          <Route path="/category/*" element={<Navigate to="/tiles" replace />} />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </React.Suspense>
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

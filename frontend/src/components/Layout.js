import React, { useState, useEffect, useRef } from 'react';
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { usePermissions } from '../contexts/PermissionsContext';
import { cn } from '../lib/utils';
import { api } from '../lib/api';
import PageGate from './PageGate';
import OutageBanner from './admin/OutageBanner';
import SchemaDriftBanner from './admin/SchemaDriftBanner';
import CommandPalette from './admin/CommandPalette';
import RadioStatusPill from './admin/RadioStatusPill';
import LeaderboardBanner from './admin/LeaderboardBanner';
import { 
  Package, 
  LayoutDashboard, 
  ShoppingCart, 
  FolderOpen, 
  BarChart3, 
  LogOut, 
  BellRing,
  Menu, 
  X,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  Users,
  ClipboardList,
  MessageSquare,
  UserPlus,
  Mail,
  Send,
  Monitor,
  Building2,
  Shield,
  Link2,
  TrendingUp,
  FileText,
  FilePen,
  History,
  Megaphone,
  Trophy,
  Bell,
  Settings,
  Tag,
  Store,
  Boxes,
  CalendarDays,
  Truck,
  RotateCcw,
  Receipt,
  Activity,
  MessageCircle,
  Grid3X3,
  Handshake,
  Upload,
  Banknote,
  KeyRound,
  Trash2,
  PoundSterling,
  ImageIcon,
  PackageSearch,
  Layers,
  ArrowLeftRight,
  ShoppingBag,
  Warehouse,
  Contact,
  Radio,
  Globe,
  FileEdit,
  LayoutGrid,
  Filter,
  Palette,
  Home,
  Menu as MenuIcon,
  Eye,
  ExternalLink,
  RefreshCw,
  User,
  Phone,
  AlertTriangle,
  Sparkles,
  Wand2,
  ShieldAlert,
  ShieldCheck,
  Target,
  Crown,
  Clock,
  Search as SearchIcon,
  Database
} from 'lucide-react';
import { Button } from '../components/ui/button';

export const Layout = () => {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState(['sales', 'products', 'stock', 'marketing-growth']);
  const [showScrollIndicator, setShowScrollIndicator] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // ── Sidebar activity snippets (Feb 26, 2026) ────────────────────────
  // Quiet status indicators under specific sidebar items so staff can
  // see at a glance whether the last ticket run / stocktake / reorder
  // check was done today. Fetched once on mount + every 5 min so the
  // numbers stay fresh without flooding the backend.
  const [sidebarActivity, setSidebarActivity] = useState({
    price_tickets: null,
    reorder_suggestions: null,
    stocktake_report: null,
  });
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api.get('/sidebar-activity')
        .then((res) => { if (!cancelled && res?.data) setSidebarActivity(res.data); })
        .catch(() => { /* silent — sidebar still works without the snippet */ });
    };
    load();
    const t = setInterval(load, 5 * 60 * 1000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);
  const mainRef = useRef(null);
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Handle scroll indicator visibility
  useEffect(() => {
    const mainElement = mainRef.current;
    if (!mainElement) return;

    const handleScroll = () => {
      const scrollTop = mainElement.scrollTop;
      const scrollHeight = mainElement.scrollHeight;
      const clientHeight = mainElement.clientHeight;
      
      // Hide indicator if scrolled more than 50px or near bottom
      const hasMoreContent = scrollHeight > clientHeight + 100;
      const hasScrolled = scrollTop > 50;
      const nearBottom = scrollTop + clientHeight >= scrollHeight - 50;
      
      setShowScrollIndicator(hasMoreContent && !hasScrolled && !nearBottom);
    };

    // Check initially with a small delay for content to render
    const timer = setTimeout(handleScroll, 300);
    mainElement.addEventListener('scroll', handleScroll, { passive: true });
    
    return () => {
      mainElement.removeEventListener('scroll', handleScroll);
      clearTimeout(timer);
    };
  }, [location.pathname]);

  // Global keyboard shortcut: ⌘K / Ctrl+K opens the command palette.
  // "/" also opens it, but only when the user isn't already typing
  // into an input/textarea/contenteditable — otherwise we'd hijack
  // every slash key on the EPOS / product editor screens.
  useEffect(() => {
    const onKey = (e) => {
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (e.key === '/' && !isMod) {
        const t = e.target;
        const tag = t?.tagName?.toLowerCase();
        if (
          tag === 'input' ||
          tag === 'textarea' ||
          tag === 'select' ||
          t?.isContentEditable
        ) {
          return;
        }
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleLogout = () => {
    logout();
    navigate('/');
  };

  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin' || user?.role === 'manager' || user?.role === 'staff';
  const isSuperAdmin = user?.role === 'super_admin';

  // 17 May 2026 — Sidebar is STRICTLY role-based now (via /api/permissions/me).
  //
  // We used to also accept a legacy `user.permissions[]` array as a
  // fallback grant. That broke the admin's ability to revoke permissions:
  // un-ticking "Sync Hub" from the Staff role had no effect because every
  // staff user still had `'products'` in their old user.permissions array
  // from when they were created via the legacy modal, and the fallback
  // kept granting them Sync Hub anyway.
  //
  // The role-based system now has comprehensive defaults (Staff: 50 pages,
  // Showroom Lead: 49 pages, Admin: 93, Super Admin: full registry) that
  // any showroom user gets more from than the old grouped keys ever
  // granted — so dropping the fallback is safe.
  //
  // While the perms context is loading on first paint we render
  // optimistically (return true) so the sidebar doesn't briefly empty
  // out. The actual permission check kicks in once /me responds.
  const { hasPage, loading: permsLoading } = usePermissions();

  const hasPermission = (newKey) => {
    if (isSuperAdmin) return true;
    if (permsLoading) return true;             // optimistic on first paint
    if (!newKey) return true;                  // unguarded item
    return hasPage(newKey);
  };

  const toggleGroup = (groupId) => {
    setExpandedGroups(prev => 
      prev.includes(groupId) 
        ? prev.filter(g => g !== groupId)
        : [...prev, groupId]
    );
  };

  // Navigation structure with groups.
  //
  // Each item carries TWO permission keys:
  //   `permission`       — granular page key matching PAGE_REGISTRY in
  //                        /app/backend/routes/permissions.py (new system,
  //                        managed via /admin/permissions)
  //   `legacyPermission` — old grouped key that was checked against
  //                        user.permissions[] before May 16, 2026.
  //                        Kept as a fallback so historical staff users
  //                        with the old keys still see their menu.
  //
  // `hasPermission(newKey, legacyKey)` returns true if EITHER passes.
  const navGroups = [
    {
      id: 'main',
      label: null,
      items: [
        { to: '/admin', icon: LayoutDashboard, label: 'Dashboard', end: true, permission: 'dashboard', legacyPermission: 'dashboard' },
        // One-click "open the in-store radio" link. Opens in a new
        // tab so the showroom can leave it running on a 2nd screen /
        // Bluetooth-connected device while keeping admin open.
        // Visible to EVERY staff role (uses `dashboard` permission)
        // so morning openers can tap it without admin help.
        {
          to: '/radio',
          icon: Radio,
          label: 'Play Store Radio',
          permission: 'dashboard',
          legacyPermission: 'dashboard',
          external: true,
          accent: true,
        },
        // Top-level staff-recognition shortcuts (3 Jun 2026 — user
        // report "where is the champions dashboard?"; previously
        // these lived under Admin Settings → easy to miss). Visible
        // to every role with dashboard access so the whole team can
        // see who's leading.
        { to: '/admin/staff-competition', icon: Trophy, label: '🏆 Staff Competition', permission: 'dashboard', legacyPermission: 'dashboard', accent: true },
        { to: '/admin/star-staff', icon: Crown, label: '⭐ Star Staff', permission: 'dashboard', legacyPermission: 'dashboard' },
      ]
    },
    {
      id: 'sales',
      label: 'Sales & EPOS',
      icon: ShoppingBag,
      hubLink: '/admin/sales-hub',
      items: [
        { to: '/admin/epos', icon: Monitor, label: 'EPOS', permission: 'epos', legacyPermission: 'epos' },
        { to: '/admin/cash-counter', icon: Banknote, label: 'Cash Counter', permission: 'cash_counter', legacyPermission: 'dashboard' },
        { to: '/admin/showroom-dashboard', icon: Store, label: 'Store Dashboard', permission: 'showroom_dashboard', legacyPermission: 'dashboard' },
      ]
    },
    {
      id: 'products',
      label: 'Products & Suppliers',
      icon: Package,
      hubLink: '/admin/products-hub',
      items: [
        { to: '/admin/supplier-products', icon: Package, label: 'Products', permission: 'supplier_products', legacyPermission: 'products' },
        { to: '/admin/price-tickets', icon: Tag, label: 'Price Tickets', permission: 'supplier_products', legacyPermission: 'products' },
        { to: '/admin/supplier-health', icon: Activity, label: 'Supplier Health', permission: 'supplier_health', legacyPermission: 'products' },
        { to: '/admin/sync-hub', icon: RefreshCw, label: 'Sync Hub', permission: 'sync_hub', legacyPermission: 'products' },
        { to: '/admin/suppliers', icon: Building2, label: 'Supplier Contacts', permission: 'suppliers', legacyPermission: 'products' },
      ]
    },
    {
      id: 'stock',
      label: 'Stock Management',
      icon: Warehouse,
      hubLink: '/admin/stock-hub',
      items: [
        { to: '/admin/stock-allocation', icon: Boxes, label: 'Stock Allocation', permission: 'stock_allocation', legacyPermission: 'products' },
        { to: '/admin/bulk-stock', icon: Layers, label: 'Bulk Stock Edit', permission: 'bulk_stock', legacyPermission: 'products' },
        { to: '/admin/stock-import', icon: Upload, label: 'Stock Import', permission: 'stock_import', legacyPermission: 'products', superAdminOnly: true },
        { to: '/admin/delivery-check-in', icon: Truck, label: 'Delivery Check-In', permission: 'delivery_check_in', legacyPermission: 'products' },
        { to: '/admin/stock-transfers', icon: ArrowLeftRight, label: 'Stock Transfers', permission: 'stock_transfers', legacyPermission: 'products' },
        { to: '/admin/reorder-suggestions', icon: TrendingUp, label: 'Reorder Suggestions', permission: 'reorder_suggestions', legacyPermission: 'products' },
        { to: '/admin/batch-tracking', icon: Package, label: 'Batch Tracking', permission: 'batch_tracking', legacyPermission: 'products' },
        { to: '/admin/to-order', icon: PackageSearch, label: 'To Order Report', permission: 'to_order_report', legacyPermission: 'reports' },
        { to: '/admin/stock-cost', icon: PoundSterling, label: 'Stock Value', permission: 'stock_cost', legacyPermission: 'reports' },
        { to: '/admin/stocktake-report', icon: ClipboardList, label: 'Stocktake Report', permission: 'stocktake_report', legacyPermission: 'reports' },
      ]
    },
    {
      id: 'customers',
      label: 'Customers',
      icon: Contact,
      hubLink: '/admin/customers-hub',
      items: [
        { to: '/admin/trade-accounts', icon: Building2, label: 'Trade Accounts', permission: 'trade_accounts', legacyPermission: 'customers' },
        { to: '/admin/pricing', icon: Users, label: 'Customer Pricing', permission: 'customer_pricing', legacyPermission: 'customer_pricing' },
        { to: '/admin/invites', icon: UserPlus, label: 'Invite Customers', permission: 'customer_invites', legacyPermission: 'customer_invites' },
        { to: '/admin/inquiries', icon: MessageSquare, label: 'Bulk Inquiries', permission: 'bulk_inquiries', legacyPermission: 'bulk_inquiries' },
        { to: '/admin/trade-list', icon: Handshake, label: 'Trade List (Legacy)', permission: 'trade_list', legacyPermission: 'customers' },
      ]
    },
    {
      id: 'communication',
      label: 'Communication',
      icon: Radio,
      hubLink: '/admin/communication-hub',
      items: [
        { to: '/admin/chat', icon: MessageCircle, label: 'Staff Chat', permission: 'staff_chat', legacyPermission: 'dashboard' },
        { to: '/admin/tasks', icon: ClipboardList, label: 'Tasks & Notes', permission: 'tasks', legacyPermission: 'dashboard' },
        { to: '/admin/inbox', icon: Mail, label: 'Inbox', permission: 'inbox', legacyPermission: 'marketing' },
        { to: '/admin/email', icon: Send, label: 'Send Email', permission: 'email_composer', legacyPermission: 'marketing' },
        { to: '/admin/notifications', icon: Bell, label: 'Notifications', permission: 'notifications', legacyPermission: 'marketing', superAdminOnly: true },
      ]
    },
    {
      id: 'marketing-growth',
      label: 'Marketing & Growth',
      icon: TrendingUp,
      hubLink: '/admin/seo',
      items: [
        { to: '/admin/seo', icon: Trophy, label: 'SEO Command Centre', permission: 'marketing', legacyPermission: 'marketing' },
        { to: '/admin/marketing-studio', icon: Wand2, label: 'Marketing Studio', permission: 'marketing', legacyPermission: 'marketing' },
        { to: '/admin/radio-studio', icon: Radio, label: 'Radio Studio (in-store)', permission: 'marketing', legacyPermission: 'marketing' },
        { to: '/admin/visualizer', icon: Sparkles, label: 'Tile Visualizer', permission: 'marketing', legacyPermission: 'marketing' },
        { to: '/admin/marketing', icon: Megaphone, label: 'Marketing Campaigns', permission: 'marketing', legacyPermission: 'marketing' },
        { to: '/admin/promo-codes', icon: Tag, label: 'Promo Codes', permission: 'marketing', legacyPermission: 'marketing' },
        { to: '/admin/abandoned-baskets', icon: ShoppingCart, label: 'Abandoned Baskets', permission: 'marketing', legacyPermission: 'marketing' },
        { to: '/admin/email-hub', icon: Mail, label: 'Email Hub', permission: 'marketing', legacyPermission: 'marketing' },
        { to: '/admin/pinterest-pack', icon: ImageIcon, label: 'Pinterest Pack', permission: 'marketing', legacyPermission: 'marketing' },
        { to: '/admin/trade-credit-emails', icon: Mail, label: 'Trade Credit Emails', permission: 'marketing', legacyPermission: 'marketing' },
        { to: '/admin/failed-payments', icon: AlertTriangle, label: 'Failed Payments', permission: 'marketing', legacyPermission: 'marketing' },
        { to: '/admin/stripe-reconcile', icon: ShieldAlert, label: 'Stripe Reconcile', permission: 'marketing', legacyPermission: 'marketing' },
        { to: '/admin/seo-autopilot-v2', icon: ShieldCheck, label: 'SEO Autopilot (Full)', permission: 'marketing', legacyPermission: 'marketing' },
        { to: '/admin/mission-topps', icon: Target, label: 'Mission: Catch Topps', permission: 'marketing', legacyPermission: 'marketing' },
        { to: '/admin/weekly-digest', icon: CalendarDays, label: 'Weekly Digest', permission: 'marketing', legacyPermission: 'marketing', superAdminOnly: true },
        { to: '/admin/health', icon: ShieldAlert, label: 'Health Monitor', permission: 'marketing', legacyPermission: 'admin' },
      ]
    },
    {
      id: 'reports',
      label: 'Reports',
      icon: BarChart3,
      hubLink: '/admin/reports-hub',
      items: [
        { to: '/admin/analytics', icon: TrendingUp, label: 'Analytics', permission: 'analytics', legacyPermission: 'reports' },
        { to: '/admin/reports', icon: BarChart3, label: 'Sales Reports', permission: 'reports', legacyPermission: 'reports' },
        { to: '/admin/audit-trail', icon: History, label: 'Audit Trail', permission: 'audit_trail', legacyPermission: 'user_management', superAdminOnly: true },
      ]
    },
    {
      id: 'admin',
      label: 'Admin Settings',
      icon: Settings,
      hubLink: '/admin/settings-hub',
      items: [
        { to: '/admin/showrooms', icon: Building2, label: 'Stores', permission: 'showrooms', legacyPermission: 'showrooms' },
        { to: '/admin/users', icon: Shield, label: 'User Management', permission: 'user_management', legacyPermission: 'user_management', superAdminOnly: true },
        { to: '/admin/permissions', icon: Shield, label: 'Permissions', permission: 'permissions_admin', legacyPermission: 'user_management', superAdminOnly: true },
        { to: '/admin/staff-pins', icon: KeyRound, label: 'Staff PINs', permission: 'staff_pins', legacyPermission: 'user_management', superAdminOnly: true },
        { to: '/admin/expired-quotes', icon: Clock, label: 'Expired Quotes', permission: 'quotations', legacyPermission: 'quotes' },
        { to: '/admin/staff-invites', icon: Link2, label: 'Staff Invites', permission: 'staff_invites', legacyPermission: 'user_management', superAdminOnly: true },
        { to: '/admin/trash', icon: Trash2, label: 'Trash', permission: 'trash', legacyPermission: 'user_management', superAdminOnly: true },
        { to: '/admin/data-hygiene', icon: Database, label: 'Data Hygiene', permission: 'user_management', legacyPermission: 'user_management', superAdminOnly: true },
        { to: '/admin/settings', icon: Settings, label: 'Settings', permission: 'general_settings', legacyPermission: 'dashboard' },
      ]
    },
    {
      id: 'website',
      label: 'Website',
      icon: Globe,
      hubLink: '/admin/website-hub',
      superAdminOnly: true, // Only visible to super admins
      items: [
        { to: '/admin/website-preview', icon: Eye, label: 'Preview Website', permission: 'website_preview', legacyPermission: 'products', superAdminOnly: true },
        { to: '/admin/homepage-content', icon: Home, label: 'Homepage', permission: 'homepage_content', legacyPermission: 'products', superAdminOnly: true },
        { to: '/admin/collections', icon: Layers, label: 'Collections', permission: 'collections', legacyPermission: 'products', superAdminOnly: true },
        { to: '/admin/trade-account-settings', icon: Building2, label: 'Trade Account', permission: 'trade_account_settings', legacyPermission: 'products', superAdminOnly: true },
        { to: '/admin/customer-account-settings', icon: User, label: 'Customer Account', permission: 'customer_account_settings', legacyPermission: 'products', superAdminOnly: true },
        { to: '/admin/checkout-settings', icon: ShoppingCart, label: 'Checkout Page', permission: 'checkout_settings', legacyPermission: 'products', superAdminOnly: true },
        { to: '/admin/navigation-menu', icon: MenuIcon, label: 'Navigation Menu', permission: 'navigation_menu', legacyPermission: 'products', superAdminOnly: true },
        { to: '/admin/website-categories', icon: LayoutGrid, label: 'Website Categories', permission: 'website_categories', legacyPermission: 'products', superAdminOnly: true },
        { to: '/admin/manage-categories', icon: FolderOpen, label: 'Product Categories', permission: 'manage_categories', legacyPermission: 'categories', superAdminOnly: true },
        { to: '/admin/website-filters', icon: Filter, label: 'Filters', permission: 'website_filters', legacyPermission: 'products', superAdminOnly: true },
        { to: '/admin/website-products', icon: ShoppingBag, label: 'Products Editor', permission: 'website_products', legacyPermission: 'products', superAdminOnly: true },
        { to: '/admin/sample-service-content', icon: FileEdit, label: 'Sample Service', permission: 'sample_service_content', legacyPermission: 'products', superAdminOnly: true },
        { to: '/admin/website-settings', icon: Palette, label: 'Settings & Branding', permission: 'website_settings', legacyPermission: 'products', superAdminOnly: true },
        { to: '/admin/website-analytics', icon: BarChart3, label: 'Website Analytics', permission: 'website_analytics', legacyPermission: 'reports', superAdminOnly: true },
        { to: '/admin/live-chat', icon: MessageCircle, label: 'Live Chat', permission: 'live_chat', legacyPermission: 'reports', superAdminOnly: true },
        { to: '/admin/whatsapp', icon: Phone, label: 'WhatsApp Messages', permission: 'whatsapp', legacyPermission: 'products', superAdminOnly: true },
      ]
    },
  ];

  // Filter items based on permissions. Each item is shown if EITHER its
  // new granular key OR its legacy grouped key grants access — see
  // `hasPermission()` above for the resolution order.
  const filteredGroups = navGroups.map(group => ({
    ...group,
    items: group.items.filter(item => {
      if (item.superAdminOnly && !isSuperAdmin) return false;
      return hasPermission(item.permission);
    })
  })).filter(group => group.items.length > 0);

  // Check if any item in a group is active
  const isGroupActive = (group) => {
    return group.items.some(item => {
      if (item.end) {
        return location.pathname === item.to;
      }
      return location.pathname.startsWith(item.to);
    });
  };

  const customerNavItems = [
    { to: '/customer/products', icon: Package, label: 'Products' },
    { to: '/customer/orders', icon: ClipboardList, label: 'My Orders' },
  ];

  // Build the small "last activity" snippet for select sidebar items.
  // Returns null when there's nothing to show OR the item is collapsed.
  // Uses relative-time formatting in human language ("2 hr ago").
  const _fmtRelative = (iso) => {
    if (!iso) return '';
    try {
      const then = new Date(iso).getTime();
      if (!Number.isFinite(then)) return '';
      const diffMs = Date.now() - then;
      const m = Math.round(diffMs / 60000);
      if (m < 1) return 'just now';
      if (m < 60) return `${m}m ago`;
      const h = Math.round(m / 60);
      if (h < 24) return `${h}h ago`;
      const d = Math.round(h / 24);
      if (d < 30) return `${d}d ago`;
      const mo = Math.round(d / 30);
      return `${mo}mo ago`;
    } catch (_e) { return ''; }
  };

  const sidebarSnippet = (item) => {
    if (collapsed) return null;
    if (item.to === '/admin/price-tickets') {
      const a = sidebarActivity.price_tickets;
      if (!a || !a.last_at) return null;
      return `Last batch · ${a.count} ticket${a.count === 1 ? '' : 's'} · ${_fmtRelative(a.last_at)}`;
    }
    if (item.to === '/admin/reorder-suggestions') {
      const a = sidebarActivity.reorder_suggestions;
      if (!a || !a.critical_count) return null;
      return `${a.critical_count} ${a.critical_count === 1 ? 'item' : 'items'} need ordering`;
    }
    if (item.to === '/admin/stocktake-report') {
      const a = sidebarActivity.stocktake_report;
      if (!a || !a.last_at) return null;
      return `Last count · ${_fmtRelative(a.last_at)}`;
    }
    return null;
  };

  // Render a single nav item
  const renderNavItem = (item) => {
    // External items (e.g. Play Store Radio → /radio public page)
    // open in a new tab so the admin session stays put and the
    // showroom can park the radio on a 2nd screen.
    if (item.external) {
      return (
        <a
          key={item.to}
          href={item.to}
          target="_blank"
          rel="noopener noreferrer"
          data-testid={`nav-${item.label.toLowerCase().replace(/\s+/g, '-')}`}
          className={cn(
            'flex items-center gap-3 px-4 py-2.5 rounded-md font-medium duration-200 text-sm',
            item.accent
              ? 'bg-gradient-to-r from-amber-500/20 to-fuchsia-500/15 text-amber-200 hover:from-amber-500/30 hover:to-fuchsia-500/25 ring-1 ring-amber-400/30'
              : 'text-primary-foreground/80 hover:bg-white/10 hover:text-primary-foreground',
            collapsed && 'justify-center px-2'
          )}
        >
          <item.icon className="h-4 w-4 flex-shrink-0" strokeWidth={1.5} />
          {!collapsed && (
            <>
              <span className="truncate flex-1">{item.label}</span>
              <ExternalLink className="h-3 w-3 opacity-60" strokeWidth={1.5} />
            </>
          )}
        </a>
      );
    }

    const snippet = sidebarSnippet(item);

    return (
      <NavLink
        key={item.to}
        to={item.to}
        end={item.end}
        data-testid={`nav-${item.label.toLowerCase().replace(/\s+/g, '-')}`}
        className={({ isActive }) =>
          cn(
            // When there's a snippet we switch to a stacked column layout
            // so the small status line wraps nicely under the label.
            snippet ? 'flex items-start gap-3 px-4 py-2 rounded-md font-medium duration-200 text-sm'
                    : 'flex items-center gap-3 px-4 py-2.5 rounded-md font-medium duration-200 text-sm',
            isActive
              ? 'bg-accent text-accent-foreground shadow-md'
              : 'text-primary-foreground/80 hover:bg-white/10 hover:text-primary-foreground',
            collapsed && 'justify-center px-2'
          )
        }
      >
        <item.icon className={cn('h-4 w-4 flex-shrink-0', snippet && 'mt-0.5')} strokeWidth={1.5} />
        {!collapsed && (
          <span className="flex flex-col min-w-0 leading-tight">
            <span className="truncate">{item.label}</span>
            {snippet && (
              <span
                className="text-[10px] font-normal opacity-65 truncate"
                data-testid={`nav-snippet-${item.label.toLowerCase().replace(/\s+/g, '-')}`}
              >
                {snippet}
              </span>
            )}
          </span>
        )}
      </NavLink>
    );
  };

  // Render a collapsible group
  const renderGroup = (group) => {
    const isExpanded = expandedGroups.includes(group.id);
    const groupActive = isGroupActive(group);

    // Check if group requires super admin and user is not super admin
    if (group.superAdminOnly && !isSuperAdmin) {
      return null;
    }

    // If no label, render items directly (for main/dashboard)
    if (!group.label) {
      return (
        <div key={group.id} className="space-y-1">
          {group.items.map(renderNavItem)}
        </div>
      );
    }

    // If group has hubLink, render the label as a direct link to the hub
    // page AND a separate chevron button that expands the child items
    // below. This way the hub page is still one click away, but every
    // child route (Radio Studio, Marketing Studio, SEO, etc.) is also
    // discoverable from the sidebar — not just by typing the URL.
    if (group.hubLink) {
      return (
        <div key={group.id} className="space-y-1">
          <div
            className={cn(
              'w-full flex items-center rounded-md font-medium duration-200 text-sm',
              groupActive
                ? 'bg-white/10 text-primary-foreground'
                : 'text-primary-foreground/80 hover:bg-white/10 hover:text-primary-foreground',
              collapsed && 'justify-center'
            )}
          >
            <NavLink
              to={group.hubLink}
              data-testid={`nav-group-${group.id}`}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 py-2.5 flex-1 min-w-0',
                  collapsed ? 'justify-center px-2' : 'pl-4',
                  isActive && 'text-primary-foreground'
                )
              }
            >
              <group.icon className="h-4 w-4 flex-shrink-0" strokeWidth={1.5} />
              {!collapsed && (
                <span className="flex-1 text-left truncate">{group.label}</span>
              )}
            </NavLink>
            {!collapsed && group.items && group.items.length > 0 && (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  toggleGroup(group.id);
                }}
                aria-label={`Toggle ${group.label} menu`}
                data-testid={`nav-group-toggle-${group.id}`}
                className="p-2 mr-1 rounded-md hover:bg-white/10 text-primary-foreground/70 hover:text-primary-foreground"
              >
                <ChevronDown
                  className={cn(
                    'h-4 w-4 transition-transform duration-200',
                    isExpanded && 'rotate-180'
                  )}
                />
              </button>
            )}
          </div>

          {!collapsed && isExpanded && (
            <div className="ml-4 pl-2 border-l border-white/10 space-y-1">
              {group.items.map(renderNavItem)}
            </div>
          )}
        </div>
      );
    }

    return (
      <div key={group.id} className="space-y-1">
        <button
          onClick={() => !collapsed && toggleGroup(group.id)}
          data-testid={`nav-group-${group.id}`}
          className={cn(
            'w-full flex items-center gap-3 px-4 py-2.5 rounded-md font-medium duration-200 text-sm',
            groupActive && !isExpanded
              ? 'bg-white/10 text-primary-foreground'
              : 'text-primary-foreground/80 hover:bg-white/10 hover:text-primary-foreground',
            collapsed && 'justify-center px-2'
          )}
        >
          <group.icon className="h-4 w-4 flex-shrink-0" strokeWidth={1.5} />
          {!collapsed && (
            <>
              <span className="flex-1 text-left truncate">{group.label}</span>
              <ChevronDown 
                className={cn(
                  'h-4 w-4 transition-transform duration-200',
                  isExpanded && 'rotate-180'
                )} 
              />
            </>
          )}
        </button>
        
        {!collapsed && isExpanded && (
          <div className="ml-4 pl-2 border-l border-white/10 space-y-1">
            {group.items.map(renderNavItem)}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-screen overflow-hidden bg-secondary">
      <div className={cn('flex-1 flex flex-col duration-300 min-w-0', collapsed ? 'md:mr-20' : 'md:mr-64')}>
        {/* Leaderboard banner — visible only on admin layouts (the whole
            file is gated behind `isAdmin` shape anyway). Sits ABOVE
            the topbar so it's the first thing the eye lands on when
            anyone opens any admin page. (3 Jun 2026 — user req.) */}
        {isAdmin && <LeaderboardBanner />}
        <header className="h-14 md:h-16 bg-card border-b border-border flex items-center justify-between px-4 md:px-6 sticky top-0 z-30" data-testid="topbar">
          <div className="text-xs md:text-sm font-mono text-muted-foreground">
            {new Date().toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}
          </div>
          <div className="flex-1" />
          {isAdmin && <RadioStatusPill />}
          {isAdmin && (
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              data-testid="command-palette-trigger"
              className="hidden md:inline-flex items-center gap-2 px-3 py-1.5 mr-3 rounded-md border border-border bg-secondary/60 text-sm text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
              aria-label="Search admin pages"
            >
              <SearchIcon className="h-4 w-4" />
              <span>Search pages…</span>
              <kbd className="ml-1 px-1.5 py-0.5 text-[10px] font-mono bg-background border border-border rounded">
                {typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform) ? '⌘K' : 'Ctrl K'}
              </kbd>
            </button>
          )}
          {isAdmin && (
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              data-testid="command-palette-trigger-mobile"
              className="md:hidden p-2 mr-1 rounded-md hover:bg-secondary active:bg-secondary/80"
              aria-label="Search admin pages"
            >
              <SearchIcon className="h-5 w-5" />
            </button>
          )}
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="md:hidden p-2 rounded-md hover:bg-secondary active:bg-secondary/80"
            data-testid="mobile-menu-toggle"
          >
            {mobileOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
          </button>
        </header>
        {/* Outage / snooze banner sits BELOW the top nav so the
            "Tile Station · Sun May 3" strip is never obscured — users
            know where they are before they know what's broken. */}
        <OutageBanner />
        <SchemaDriftBanner />

        <main ref={mainRef} className="flex-1 overflow-auto p-4 md:p-8 lg:p-10 relative" data-testid="main-content">
          <div className="max-w-[1600px] mx-auto w-full min-w-0">
            <PageGate>
              <Outlet />
            </PageGate>
          </div>
          
          {/* Mobile Scroll Indicator */}
          <div 
            className={cn(
              'md:hidden fixed bottom-6 left-1/2 -translate-x-1/2 z-20 transition-all duration-500',
              showScrollIndicator 
                ? 'opacity-100 translate-y-0' 
                : 'opacity-0 translate-y-4 pointer-events-none'
            )}
            data-testid="scroll-indicator"
          >
            <div className="flex flex-col items-center gap-1 bg-primary/90 text-primary-foreground px-4 py-2 rounded-full shadow-lg backdrop-blur-sm">
              <span className="text-xs font-medium">Scroll</span>
              <ChevronsDown className="h-4 w-4 animate-bounce" />
            </div>
          </div>
        </main>
      </div>

      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setMobileOpen(false)}
          data-testid="mobile-overlay"
        />
      )}

      <aside
        className={cn(
          'fixed inset-y-0 right-0 z-50 bg-primary text-primary-foreground duration-300 ease-in-out',
          collapsed ? 'w-20' : 'w-64',
          mobileOpen ? 'translate-x-0' : 'translate-x-full md:translate-x-0'
        )}
        data-testid="sidebar"
      >
        <div className="flex h-full flex-col">
          <div className="flex h-16 items-center justify-between px-4 border-b border-white/10">
            {!collapsed && (
              <div className="flex items-center gap-2">
                <Package className="h-8 w-8" strokeWidth={1.5} />
                <span className="text-xl font-heading font-bold tracking-tightest">Tile Station</span>
              </div>
            )}
            {collapsed && <Package className="h-8 w-8 mx-auto" strokeWidth={1.5} />}
            <button
              onClick={() => setCollapsed(!collapsed)}
              className="hidden md:flex p-1.5 rounded-md hover:bg-white/10"
              data-testid="collapse-sidebar-btn"
            >
              <ChevronLeft className={cn('h-5 w-5 duration-300', collapsed && 'rotate-180')} />
            </button>
          </div>

          <nav className="flex-1 space-y-2 px-3 py-4 overflow-y-auto" data-testid="nav-menu">
            {isAdmin ? (
              filteredGroups.map(renderGroup)
            ) : (
              customerNavItems.map(renderNavItem)
            )}
          </nav>

          <div className="border-t border-white/10 p-4">
            {!collapsed && (
              <div className="mb-3 px-2">
                <p className="text-xs font-mono uppercase tracking-widest text-primary-foreground/60 mb-1">
                  {user?.role}
                </p>
                <p className="text-sm font-medium truncate">{user?.name}</p>
                <p className="text-xs text-primary-foreground/70 truncate">{user?.email}</p>
              </div>
            )}
            <Button
              onClick={() => navigate('/admin/me/subscriptions')}
              data-testid="my-subscriptions-button"
              variant="outline"
              className={cn(
                'w-full mb-2 border-white/20 text-primary-foreground hover:bg-white/10 hover:text-primary-foreground',
                collapsed && 'p-2'
              )}
            >
              <BellRing className="h-5 w-5" strokeWidth={1.5} />
              {!collapsed && <span className="ml-2">My subscriptions</span>}
            </Button>
            <Button
              onClick={handleLogout}
              data-testid="logout-button"
              variant="outline"
              className={cn(
                'w-full border-white/20 text-primary-foreground hover:bg-white/10 hover:text-primary-foreground',
                collapsed && 'p-2'
              )}
            >
              <LogOut className="h-5 w-5" strokeWidth={1.5} />
              {!collapsed && <span className="ml-2">Logout</span>}
            </Button>
          </div>
        </div>
      </aside>

      {isAdmin && (
        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          groups={filteredGroups}
          hubLinks={filteredGroups
            .filter((g) => g.hubLink && g.label)
            .map((g) => ({ hubLink: g.hubLink, label: g.label, icon: g.icon }))}
        />
      )}
    </div>
  );
};

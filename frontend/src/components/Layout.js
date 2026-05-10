import React, { useState, useEffect, useRef } from 'react';
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { cn } from '../lib/utils';
import OutageBanner from './admin/OutageBanner';
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
  ShieldAlert
} from 'lucide-react';
import { Button } from '../components/ui/button';

export const Layout = () => {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState(['sales', 'products', 'stock']);
  const [showScrollIndicator, setShowScrollIndicator] = useState(true);
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

  const handleLogout = () => {
    logout();
    navigate('/');
  };

  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin' || user?.role === 'manager' || user?.role === 'staff';
  const isSuperAdmin = user?.role === 'super_admin';
  const userPermissions = user?.permissions || [];

  const hasPermission = (permission) => {
    if (isSuperAdmin) return true;
    return userPermissions.includes(permission);
  };

  const toggleGroup = (groupId) => {
    setExpandedGroups(prev => 
      prev.includes(groupId) 
        ? prev.filter(g => g !== groupId)
        : [...prev, groupId]
    );
  };

  // Navigation structure with groups
  const navGroups = [
    {
      id: 'main',
      label: null,
      items: [
        { to: '/admin', icon: LayoutDashboard, label: 'Dashboard', end: true, permission: 'dashboard' },
      ]
    },
    {
      id: 'sales',
      label: 'Sales & EPOS',
      icon: ShoppingBag,
      hubLink: '/admin/sales-hub',
      items: [
        { to: '/admin/epos', icon: Monitor, label: 'EPOS', permission: 'epos' },
        { to: '/admin/cash-counter', icon: Banknote, label: 'Cash Counter', permission: 'dashboard' },
        { to: '/admin/showroom-dashboard', icon: Store, label: 'Store Dashboard', permission: 'dashboard' },
      ]
    },
    {
      id: 'products',
      label: 'Products & Suppliers',
      icon: Package,
      hubLink: '/admin/products-hub',
      items: [
        { to: '/admin/supplier-products', icon: Package, label: 'Products', permission: 'products' },
        { to: '/admin/supplier-health', icon: Activity, label: 'Supplier Health', permission: 'products' },
        { to: '/admin/sync-hub', icon: RefreshCw, label: 'Sync Hub', permission: 'products' },
        { to: '/admin/suppliers', icon: Building2, label: 'Supplier Contacts', permission: 'products' },
      ]
    },
    {
      id: 'stock',
      label: 'Stock Management',
      icon: Warehouse,
      hubLink: '/admin/stock-hub',
      items: [
        { to: '/admin/stock-allocation', icon: Boxes, label: 'Stock Allocation', permission: 'products' },
        { to: '/admin/bulk-stock', icon: Layers, label: 'Bulk Stock Edit', permission: 'products' },
        { to: '/admin/stock-import', icon: Upload, label: 'Stock Import', permission: 'products', superAdminOnly: true },
        { to: '/admin/delivery-check-in', icon: Truck, label: 'Delivery Check-In', permission: 'products' },
        { to: '/admin/stock-transfers', icon: ArrowLeftRight, label: 'Stock Transfers', permission: 'products' },
        { to: '/admin/reorder-suggestions', icon: TrendingUp, label: 'Reorder Suggestions', permission: 'products' },
        { to: '/admin/batch-tracking', icon: Package, label: 'Batch Tracking', permission: 'products' },
        { to: '/admin/to-order', icon: PackageSearch, label: 'To Order Report', permission: 'reports' },
        { to: '/admin/stock-cost', icon: PoundSterling, label: 'Stock Value', permission: 'reports' },
        { to: '/admin/stocktake-report', icon: ClipboardList, label: 'Stocktake Report', permission: 'reports' },
      ]
    },
    {
      id: 'customers',
      label: 'Customers',
      icon: Contact,
      hubLink: '/admin/customers-hub',
      items: [
        { to: '/admin/trade-accounts', icon: Building2, label: 'Trade Accounts', permission: 'customers' },
        { to: '/admin/pricing', icon: Users, label: 'Customer Pricing', permission: 'customer_pricing' },
        { to: '/admin/invites', icon: UserPlus, label: 'Invite Customers', permission: 'customer_invites' },
        { to: '/admin/inquiries', icon: MessageSquare, label: 'Bulk Inquiries', permission: 'bulk_inquiries' },
        { to: '/admin/trade-list', icon: Handshake, label: 'Trade List (Legacy)', permission: 'customers' },
      ]
    },
    {
      id: 'communication',
      label: 'Communication',
      icon: Radio,
      hubLink: '/admin/communication-hub',
      items: [
        { to: '/admin/chat', icon: MessageCircle, label: 'Staff Chat', permission: 'dashboard' },
        { to: '/admin/tasks', icon: ClipboardList, label: 'Tasks & Notes', permission: 'dashboard' },
        { to: '/admin/inbox', icon: Mail, label: 'Inbox', permission: 'marketing' },
        { to: '/admin/email', icon: Send, label: 'Send Email', permission: 'marketing' },
        { to: '/admin/notifications', icon: Bell, label: 'Notifications', permission: 'marketing', superAdminOnly: true },
      ]
    },
    {
      id: 'marketing-growth',
      label: 'Marketing & Growth',
      icon: TrendingUp,
      hubLink: '/admin/seo',
      items: [
        { to: '/admin/seo', icon: Trophy, label: 'SEO Command Centre', permission: 'marketing' },
        { to: '/admin/pinterest-queue', icon: Sparkles, label: 'Pinterest Queue', permission: 'marketing' },
        { to: '/admin/marketing-studio', icon: Wand2, label: 'Marketing Studio', permission: 'marketing' },
        { to: '/admin/visualizer', icon: Sparkles, label: 'Tile Visualizer', permission: 'marketing' },
        { to: '/admin/marketing', icon: Megaphone, label: 'Marketing Campaigns', permission: 'marketing' },
        { to: '/admin/promo-codes', icon: Tag, label: 'Promo Codes', permission: 'marketing' },
        { to: '/admin/abandoned-baskets', icon: ShoppingCart, label: 'Abandoned Baskets', permission: 'marketing' },
        { to: '/admin/trade-credit-emails', icon: Mail, label: 'Trade Credit Emails', permission: 'marketing' },
        { to: '/admin/failed-payments', icon: AlertTriangle, label: 'Failed Payments', permission: 'marketing' },
        { to: '/admin/weekly-digest', icon: CalendarDays, label: 'Weekly Digest', permission: 'marketing', superAdminOnly: true },
        { to: '/admin/health', icon: ShieldAlert, label: 'Health Monitor', permission: 'admin' },
      ]
    },
    {
      id: 'reports',
      label: 'Reports',
      icon: BarChart3,
      hubLink: '/admin/reports-hub',
      items: [
        { to: '/admin/analytics', icon: TrendingUp, label: 'Analytics', permission: 'reports' },
        { to: '/admin/reports', icon: BarChart3, label: 'Sales Reports', permission: 'reports' },
        { to: '/admin/audit-trail', icon: History, label: 'Audit Trail', permission: 'user_management', superAdminOnly: true },
      ]
    },
    {
      id: 'admin',
      label: 'Admin Settings',
      icon: Settings,
      hubLink: '/admin/settings-hub',
      items: [
        { to: '/admin/showrooms', icon: Building2, label: 'Stores', permission: 'showrooms' },
        { to: '/admin/users', icon: Shield, label: 'User Management', permission: 'user_management', superAdminOnly: true },
        { to: '/admin/staff-pins', icon: KeyRound, label: 'Staff PINs', permission: 'user_management', superAdminOnly: true },
        { to: '/admin/staff-invites', icon: Link2, label: 'Staff Invites', permission: 'user_management', superAdminOnly: true },
        { to: '/admin/trash', icon: Trash2, label: 'Trash', permission: 'user_management', superAdminOnly: true },
        { to: '/admin/settings', icon: Settings, label: 'Settings', permission: 'dashboard' },
      ]
    },
    {
      id: 'website',
      label: 'Website',
      icon: Globe,
      hubLink: '/admin/website-hub',
      superAdminOnly: true, // Only visible to super admins
      items: [
        { to: '/admin/website-preview', icon: Eye, label: 'Preview Website', permission: 'products', superAdminOnly: true },
        { to: '/admin/homepage-content', icon: Home, label: 'Homepage', permission: 'products', superAdminOnly: true },
        { to: '/admin/collections', icon: Layers, label: 'Collections', permission: 'products', superAdminOnly: true },
        { to: '/admin/trade-account-settings', icon: Building2, label: 'Trade Account', permission: 'products', superAdminOnly: true },
        { to: '/admin/customer-account-settings', icon: User, label: 'Customer Account', permission: 'products', superAdminOnly: true },
        { to: '/admin/checkout-settings', icon: ShoppingCart, label: 'Checkout Page', permission: 'products', superAdminOnly: true },
        { to: '/admin/navigation-menu', icon: MenuIcon, label: 'Navigation Menu', permission: 'products', superAdminOnly: true },
        { to: '/admin/website-categories', icon: LayoutGrid, label: 'Website Categories', permission: 'products', superAdminOnly: true },
        { to: '/admin/manage-categories', icon: FolderOpen, label: 'Product Categories', permission: 'categories', superAdminOnly: true },
        { to: '/admin/website-filters', icon: Filter, label: 'Filters', permission: 'products', superAdminOnly: true },
        { to: '/admin/website-products', icon: ShoppingBag, label: 'Products Editor', permission: 'products', superAdminOnly: true },
        { to: '/admin/sample-service-content', icon: FileEdit, label: 'Sample Service', permission: 'products', superAdminOnly: true },
        { to: '/admin/website-settings', icon: Palette, label: 'Settings & Branding', permission: 'products', superAdminOnly: true },
        { to: '/admin/website-analytics', icon: BarChart3, label: 'Website Analytics', permission: 'reports', superAdminOnly: true },
        { to: '/admin/live-chat', icon: MessageCircle, label: 'Live Chat', permission: 'reports', superAdminOnly: true },
        { to: '/admin/whatsapp', icon: Phone, label: 'WhatsApp Messages', permission: 'products', superAdminOnly: true },
      ]
    },
  ];

  // Filter items based on permissions
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

  // Render a single nav item
  const renderNavItem = (item) => (
    <NavLink
      key={item.to}
      to={item.to}
      end={item.end}
      data-testid={`nav-${item.label.toLowerCase().replace(/\s+/g, '-')}`}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 px-4 py-2.5 rounded-md font-medium duration-200 text-sm',
          isActive
            ? 'bg-accent text-accent-foreground shadow-md'
            : 'text-primary-foreground/80 hover:bg-white/10 hover:text-primary-foreground',
          collapsed && 'justify-center px-2'
        )
      }
    >
      <item.icon className="h-4 w-4 flex-shrink-0" strokeWidth={1.5} />
      {!collapsed && <span className="truncate">{item.label}</span>}
    </NavLink>
  );

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

    // If group has hubLink, render as a direct link to the hub page
    if (group.hubLink) {
      return (
        <div key={group.id} className="space-y-1">
          <NavLink
            to={group.hubLink}
            data-testid={`nav-group-${group.id}`}
            className={({ isActive }) =>
              cn(
                'w-full flex items-center gap-3 px-4 py-2.5 rounded-md font-medium duration-200 text-sm',
                isActive || groupActive
                  ? 'bg-white/10 text-primary-foreground'
                  : 'text-primary-foreground/80 hover:bg-white/10 hover:text-primary-foreground',
                collapsed && 'justify-center px-2'
              )
            }
          >
            <group.icon className="h-4 w-4 flex-shrink-0" strokeWidth={1.5} />
            {!collapsed && (
              <span className="flex-1 text-left truncate">{group.label}</span>
            )}
          </NavLink>
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
        <header className="h-14 md:h-16 bg-card border-b border-border flex items-center justify-between px-4 md:px-6 sticky top-0 z-30" data-testid="topbar">
          <div className="text-xs md:text-sm font-mono text-muted-foreground">
            {new Date().toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}
          </div>
          <div className="flex-1" />
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

        <main ref={mainRef} className="flex-1 overflow-auto p-4 md:p-8 lg:p-10 relative" data-testid="main-content">
          <div className="max-w-[1600px] mx-auto w-full min-w-0">
            <Outlet />
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
    </div>
  );
};

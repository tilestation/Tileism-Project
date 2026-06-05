import React, { useState } from 'react';
import HubPage from '../../components/HubPage';
import { toast } from 'sonner';
import { 
  Globe, Eye, Home, Menu, LayoutGrid, Filter, Zap,
  ShoppingBag, FileEdit, Palette, Image, Upload, Cloud, Calculator, LayoutDashboard, Settings, Compass, Layers, MapPin, Building2, User, ShoppingCart, RefreshCw, FileText, Wrench, Megaphone, MessageCircle, Mail, Beaker
} from 'lucide-react';

export default function WebsiteHub() {
  const [migrating, setMigrating] = useState(false);
  const API_URL = process.env.REACT_APP_BACKEND_URL;

  const runLinkMigration = async () => {
    if (!window.confirm('This will update all saved links from /shop/tiles to /tiles across navigation, hero slides, banners, and settings. Continue?')) return;
    setMigrating(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/migrate-links`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (data.success) {
        toast.success(`Updated ${data.total_links_updated} links successfully!`);
      } else {
        toast.error('Migration failed');
      }
    } catch {
      toast.error('Migration failed');
    } finally {
      setMigrating(false);
    }
  };

  // Organize cards into logical sections
  const sections = [
    {
      title: 'Quick Actions',
      icon: Zap,
      iconColor: 'text-amber-500',
      cards: [
        {
          title: 'Site Map & Links',
          description: 'All pages, URLs & where they link — copy & link in one click',
          icon: Globe,
          link: '/admin/sitemap',
          color: 'bg-indigo-600',
          tabs: ['Shop Pages', 'Collections', 'Products', 'Info Pages', 'Categories']
        },
        {
          title: 'Maintenance Tasks',
          description: 'One-shot data migrators — hyphen URL fix, tools+accessories merge, legacy path rewrite',
          icon: Wrench,
          link: '/admin/maintenance',
          color: 'bg-amber-600',
          tabs: ['Run Migrators', 'Last-Run History']
        },
        {
          title: 'Preview Website',
          description: 'View your live website',
          icon: Eye,
          link: '/admin/website-preview',
          color: 'bg-blue-600',
          tabs: ['Website Preview', 'Publish Products']
        },
        {
          title: 'Sales Dashboard',
          description: 'View sales, orders & profits',
          icon: LayoutDashboard,
          link: '/admin/website-sales-dashboard',
          color: 'bg-green-600',
          tabs: ['Revenue', 'Orders', 'Profit Tracking']
        },
        {
          title: 'Online Orders',
          description: 'Website checkout orders — view, fulfill, update status',
          icon: ShoppingBag,
          link: '/admin/online-orders',
          color: 'bg-emerald-600',
          tabs: ['All Orders', 'Pending', 'Processing', 'Shipped', 'Delivered']
        },
        {
          title: 'Sample Orders',
          description: 'Paid sample-postage orders (SMP-…) — dispatch, tracking & notes',
          icon: Beaker,
          link: '/admin/sample-orders',
          color: 'bg-emerald-500',
          tabs: ['Paid', 'Ready', 'Shipped', 'Delivered']
        },
        {
          title: 'Live Visitors',
          description: 'Real-time who\'s on your site & what page they\'re on',
          icon: MessageCircle,
          link: '/admin/live-visitors',
          color: 'bg-rose-600',
          tabs: ['Live Total', 'Active by Page', 'Recent Activity']
        },
        {
          title: 'Live Chat',
          description: 'View & reply to customer chats in real-time',
          icon: MessageCircle,
          link: '/admin/live-chat',
          color: 'bg-blue-500',
          tabs: ['Active Chats', 'Chat Settings']
        },
      ]
    },
    {
      title: 'Navigation & Structure',
      icon: Compass,
      iconColor: 'text-purple-500',
      cards: [
        {
          title: 'Navigation & Structure',
          description: 'Manage menus, categories, shop tabs & filters in one place',
          icon: Compass,
          link: '/admin/navigation-structure',
          color: 'bg-purple-600',
          tabs: ['Navigation', 'Shop Tabs', 'Categories', 'Filters', 'Labels', 'Specifications']
        },
        {
          title: 'Collections',
          description: 'Manage images, mappings, page content & detail settings',
          icon: Layers,
          link: '/admin/collections',
          color: 'bg-indigo-600',
          tabs: ['Collection Manager', 'Collection Mapping', 'Page Settings', 'Detail Page']
        },
        {
          title: 'Contact Page Settings',
          description: 'Manage showroom locations for Contact page',
          icon: MapPin,
          link: '/admin/contact-page-settings',
          color: 'bg-rose-600',
          tabs: ['Showroom Locations']
        },
      ]
    },
    {
      title: 'Content',
      icon: FileEdit,
      iconColor: 'text-green-500',
      cards: [
        {
          title: 'Homepage Manager',
          description: 'All homepage sections in one place with preview',
          icon: Home,
          link: '/admin/homepage-manager',
          color: 'bg-amber-600',
          tabs: ['Hero Carousel', 'Benefits Bar', 'Shop Categories', 'Shop by Styles', 'Trade Banner', 'Shopping With Us', 'Collections Banners', 'Footer']
        },
        {
          title: 'Bathroom Page',
          description: 'Catalogue downloads, pricing tiers & download analytics',
          icon: FileText,
          link: '/admin/bathroom-page',
          color: 'bg-cyan-600',
          tabs: ['Hero', 'Catalogue', 'Pricing', 'How to Order', 'Analytics']
        },
        {
          title: 'Trade Account',
          description: 'Trade banner, benefits & credit back tiers',
          icon: Building2,
          link: '/admin/trade-account-settings',
          color: 'bg-teal-600',
          tabs: ['Homepage Banner', 'Benefits List', 'Trade Pricing', 'Account Tiers', 'Account Dashboard']
        },
        {
          title: 'Customer Account',
          description: 'Registration page & account portal settings',
          icon: User,
          link: '/admin/customer-account-settings',
          color: 'bg-indigo-600',
          tabs: ['Registration Page', 'Account Portal', 'Dashboard Content']
        },
        {
          title: 'Checkout Settings',
          description: 'Delivery zones, fees, time slots & checkout page text',
          icon: ShoppingCart,
          link: '/admin/checkout-settings',
          color: 'bg-orange-600',
          tabs: ['Delivery & Zones', 'Click & Collect', 'Time Slots', 'Checkout Text']
        },
        {
          title: 'Homepage (Legacy)',
          description: 'Hero, featured products, banners',
          icon: Home,
          link: '/admin/homepage-content',
          color: 'bg-green-600',
          tabs: ['Hero Slides', 'Featured Products', 'Banners']
        },
        {
          title: 'Sample Service',
          description: 'Sample ordering page',
          icon: FileEdit,
          link: '/admin/sample-service-content',
          color: 'bg-slate-600',
          tabs: ['How It Works', 'Why Order Samples', 'Sample Details']
        },
        {
          title: 'Sample Followups',
          description: 'Review samples ready for follow-up emails',
          icon: Mail,
          link: '/admin/sample-followups',
          color: 'bg-amber-600',
          tabs: ['Pending Review', 'Send With Discount', 'Sent History']
        },
        {
          title: 'Tile Calculator',
          description: 'Calculator widget settings',
          icon: Calculator,
          link: '/admin/tile-calculator-settings',
          color: 'bg-amber-600',
          tabs: ['Calculator Config']
        },
      ]
    },
    {
      title: 'Settings & Media',
      icon: Settings,
      iconColor: 'text-gray-500',
      cards: [
        {
          title: 'Page Maintenance',
          description: 'Temporarily disable pages with an Under Maintenance notice',
          icon: Wrench,
          link: '/admin/page-maintenance',
          color: 'bg-amber-600',
          tabs: ['Toggle Pages']
        },
        {
          title: 'Welcome Popup',
          description: 'Customise the popup shown to new visitors',
          icon: Megaphone,
          link: '/admin/welcome-popup',
          color: 'bg-purple-600',
          tabs: ['Content', 'Email Capture', 'Display']
        },
        {
          title: 'Announcement Ribbon',
          description: 'Slow-scrolling banner above the homepage header',
          icon: Megaphone,
          link: '/admin/announcement-ribbon',
          color: 'bg-amber-600',
          tabs: ['Content', 'Speed', 'Theme']
        },
        {
          title: 'Branding',
          description: 'Logo, colors, theme',
          icon: Palette,
          link: '/admin/website-settings',
          color: 'bg-red-600',
          tabs: ['Logo & Theme']
        },
        {
          title: 'Media Library',
          description: 'Upload & manage images',
          icon: Image,
          link: '/admin/media-library',
          color: 'bg-indigo-600',
          tabs: ['Image Gallery']
        },
        {
          title: 'Image Migration',
          description: 'Migrate to cloud storage',
          icon: Cloud,
          link: '/admin/image-migration',
          color: 'bg-sky-600',
          tabs: ['Migration Tool']
        },
        {
          title: migrating ? 'Migrating...' : 'Fix /shop Links',
          description: 'Update all /shop/tiles links to /tiles',
          icon: RefreshCw,
          onClick: runLinkMigration,
          color: 'bg-orange-600',
          disabled: migrating
        },
      ]
    },
  ];

  return (
    <HubPage 
      title="Website" 
      subtitle="Manage your customer-facing website"
      icon={Globe}
      sections={sections}
    />
  );
}

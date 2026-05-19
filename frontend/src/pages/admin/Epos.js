import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { Monitor, FileText, History, FileQuestion, Receipt, RotateCcw, CreditCard, ExternalLink, Building2, ArrowRight, Tag, Sparkles, FileBadge } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { Card, CardContent } from '../../components/ui/card';
import { api } from '../../lib/api';
import { useAuth } from '../../contexts/AuthContext';
import Invoice from './Invoice';
import { InvoiceHistory } from './InvoiceHistory';
import { Quotation } from './Quotation';
import { QuotationHistory } from './QuotationHistory';
import CashQuotation from './CashQuotation';
import { CashQuotationHistory } from './CashQuotationHistory';
import { ProformaInvoice } from './ProformaInvoice';
import { ProformaInvoiceHistory } from './ProformaInvoiceHistory';
import { Refund } from './Refund';
import { RefundHistory } from './RefundHistory';
import { CreditNote } from './CreditNote';
import { CreditNoteHistory } from './CreditNoteHistory';
import { ClearanceProducts } from './ClearanceProducts';
import { NewCollectionProducts } from './NewCollectionProducts';
import { OutstandingBalancesWidget } from '../../components/admin/OutstandingBalancesWidget';

// Valid tab IDs for validation
const VALID_TABS = ['invoice', 'history', 'quotation', 'quotation-history', 'cash-quotation', 'cash-quotation-history', 'proforma-invoice', 'proforma-invoice-history', 'refund', 'refund-history', 'credit-note', 'credit-note-history', 'clearance', 'new-collection'];

export const Epos = () => {
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  
  // Get initial tab from URL query params, location state, or default to 'invoice'
  const getInitialTab = useCallback(() => {
    // First priority: URL query parameter
    const urlTab = searchParams.get('tab');
    if (urlTab && VALID_TABS.includes(urlTab)) {
      return urlTab;
    }
    // Second priority: navigation state (fromQuotation)
    if (location.state?.fromQuotation) {
      return 'invoice';
    }
    // Default
    return 'invoice';
  }, [searchParams, location.state]);

  const [activeTab, setActiveTab] = useState(getInitialTab);
  const [showrooms, setStores] = useState([]);
  const [showStorePicker, setShowStorePicker] = useState(false);
  const navigate = useNavigate();
  const { user } = useAuth();

  // Update URL when tab changes
  const handleTabChange = useCallback((newTab) => {
    setActiveTab(newTab);
    // Update URL with the new tab
    setSearchParams({ tab: newTab }, { replace: true });
  }, [setSearchParams]);

  // Sync tab with URL on initial load and URL changes
  useEffect(() => {
    const urlTab = searchParams.get('tab');
    if (urlTab && VALID_TABS.includes(urlTab) && urlTab !== activeTab) {
      setActiveTab(urlTab);
    } else if (!urlTab && activeTab !== 'invoice') {
      // If no tab in URL but we have a non-default tab, update URL
      setSearchParams({ tab: activeTab }, { replace: true });
    } else if (!urlTab && activeTab === 'invoice') {
      // Set default tab in URL for consistency
      setSearchParams({ tab: 'invoice' }, { replace: true });
    }
  }, [searchParams, activeTab, setSearchParams]);

  useEffect(() => {
    const fetchStores = async () => {
      try {
        const res = await api.getStores();

        setStores(res.data || []);
      } catch (error) {
        console.error('Failed to load showrooms', error);
      }
    };
    fetchStores();
  }, []);

  const tabs = [
    { id: 'invoice', label: 'New Invoice', icon: FileText, route: '/admin/invoice' },
    { id: 'history', label: 'Invoice History', icon: History, route: '/admin/invoice-history' },
    { id: 'quotation', label: 'New Quotation', icon: FileQuestion, route: '/admin/quotation' },
    { id: 'quotation-history', label: 'Quotation History', icon: History, route: '/admin/quotation-history' },
    { id: 'refund', label: 'New Refund', icon: RotateCcw, route: '/admin/refund' },
    { id: 'refund-history', label: 'Refund History', icon: History, route: '/admin/refund-history' },
    { id: 'credit-note', label: 'New Credit Note', icon: CreditCard, route: '/admin/credit-note' },
    { id: 'credit-note-history', label: 'Credit Note History', icon: History, route: '/admin/credit-note-history' },
    { id: 'cash-quotation', label: 'Cash Quotation', icon: Receipt, route: '/admin/cash-quotation' },
    { id: 'cash-quotation-history', label: 'Cash Quote History', icon: History, route: '/admin/cash-quotation-history' },
    { id: 'proforma-invoice', label: 'Proforma Invoice', icon: FileBadge, route: '/admin/proforma-invoice' },
    { id: 'proforma-invoice-history', label: 'Proforma History', icon: History, route: '/admin/proforma-invoice-history' },
    { id: 'clearance', label: 'Clearance Products', icon: Tag, route: '/admin/clearance-products' },
    { id: 'new-collection', label: 'New Collection', icon: Sparkles, route: '/admin/new-collection-products' },
  ];

  // Open current document type in a new tab
  const openInNewTab = (route) => {
    window.open(route, '_blank');
  };

  const getStoreSlug = (name) => name.toLowerCase().replace(/\s+/g, '-');
  
  const getStorePrefix = (showroomName) => {
    const prefixes = {
      'gravesend': 'GRV',
      'tonbridge': 'TNB',
      'chingford': 'CHG',
      'sydenham': 'SYD'
    };
    return prefixes[showroomName?.toLowerCase()] || showroomName?.substring(0, 3).toUpperCase() || 'INV';
  };

  const navigateToStoreEpos = (showroom) => {
    const slug = getStoreSlug(showroom.name);
    navigate(`/admin/showroom/${slug}/epos`);
  };

  const renderContent = () => {
    switch (activeTab) {
      case 'invoice':
        return <Invoice />;
      case 'history':
        return <InvoiceHistory />;
      case 'quotation':
        return <Quotation />;
      case 'quotation-history':
        return <QuotationHistory />;
      case 'cash-quotation':
        return <CashQuotation />;
      case 'cash-quotation-history':
        return <CashQuotationHistory />;
      case 'proforma-invoice':
        return <ProformaInvoice />;
      case 'proforma-invoice-history':
        return <ProformaInvoiceHistory />;
      case 'refund':
        return <Refund />;
      case 'refund-history':
        return <RefundHistory />;
      case 'credit-note':
        return <CreditNote />;
      case 'credit-note-history':
        return <CreditNoteHistory />;
      case 'clearance':
        return <ClearanceProducts />;
      case 'new-collection':
        return <NewCollectionProducts />;
      default:
        return <Invoice />;
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header with Tabs */}
      <div className="bg-card border-b border-border px-6 pt-6 pb-0">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <Monitor className="h-8 w-8 text-primary" />
            <div>
              <h1 className="text-2xl font-heading font-bold">EPOS</h1>
              <p className="text-sm text-muted-foreground">Point of Sale & Invoice Management</p>
            </div>
          </div>
          <Button 
            variant="outline" 
            onClick={() => setShowStorePicker(!showStorePicker)}
            className="flex items-center gap-2"
            data-testid="showroom-epos-toggle"
          >
            <Building2 className="h-4 w-4" />
            Store EPOS
          </Button>
        </div>

        {/* Store Quick Launch */}
        {showStorePicker && showrooms.length > 0 && (
          <div className="mb-4 p-4 bg-primary/5 rounded-lg border border-primary/20" data-testid="showroom-picker">
            <p className="text-sm font-medium mb-3 text-primary">Launch Store-Specific EPOS</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {showrooms
                .filter(showroom => {
                  // Staff/Manager can only see their assigned showroom
                  const isStaffOrManager = user?.role === 'staff' || user?.role === 'manager';
                  if (isStaffOrManager && user?.showroom_id) {
                    return showroom.id === user.showroom_id;
                  }
                  return true; // Admin/Super Admin see all
                })
                .map((showroom) => (
                <Card 
                  key={showroom.id} 
                  className="cursor-pointer hover:border-primary hover:shadow-md transition-all"
                  onClick={() => navigateToStoreEpos(showroom)}
                  data-testid={`showroom-card-${getStoreSlug(showroom.name)}`}
                >
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-medium">{showroom.name}</p>
                        <p className="text-xs text-muted-foreground font-mono">
                          {getStorePrefix(showroom.name)}-XXXXXX
                        </p>
                      </div>
                      <ArrowRight className="h-4 w-4 text-primary" />
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )}
        
        {/* Tabs - Horizontally scrollable on mobile */}
        <div 
          className="flex gap-1 overflow-x-auto scrollbar-hide pb-1 -mx-6 px-6 touch-pan-x"
          style={{ 
            WebkitOverflowScrolling: 'touch',
            scrollbarWidth: 'none',
            msOverflowStyle: 'none'
          }}
          data-testid="epos-tabs"
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => handleTabChange(tab.id)}
              data-testid={`epos-tab-${tab.id}`}
              className={cn(
                'flex items-center gap-2 px-4 py-3 font-medium transition-all border-b-2 -mb-px whitespace-nowrap flex-shrink-0 text-sm',
                activeTab === tab.id
                  ? 'border-primary text-primary bg-background rounded-t-lg'
                  : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50'
              )}
            >
              <tab.icon className="h-4 w-4" />
              <span>{tab.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Action Bar - Open in New Tab */}
      <div className="bg-muted/30 border-b px-6 py-2 flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          Working on: <span className="font-medium text-foreground">{tabs.find(t => t.id === activeTab)?.label}</span>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => openInNewTab(tabs.find(t => t.id === activeTab)?.route)}
          className="flex items-center gap-2"
          data-testid="open-new-tab-btn"
        >
          <ExternalLink className="h-4 w-4" />
          Open in New Tab
        </Button>
      </div>

      {/* Outstanding Balances — surfaces the 5 oldest unpaid balances so
          staff see them without leaving EPOS. Auto-hides when nothing
          is outstanding. Click "Take Payment" to settle in one tap
          (server stamps today's date). */}
      <OutstandingBalancesWidget />

      {/* Tab Content */}
      <div className="flex-1 overflow-auto">
        {renderContent()}
      </div>
    </div>
  );
};

export default Epos;

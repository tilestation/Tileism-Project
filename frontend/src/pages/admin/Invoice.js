import React, { useState, useRef, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { api } from '../../lib/api';
import { toast } from 'sonner';
import { FileText, Plus, Trash2, Printer, Save, Search, Lock, CheckCircle, History, ArrowLeft, ClipboardList, Truck, RotateCcw, RefreshCw, ArrowLeftRight, ExternalLink, Check, Mail, Loader2 } from 'lucide-react';
import { EMAIL_CONFIG } from '../../config/emailConfig';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card } from '../../components/ui/card';
import { Checkbox } from '../../components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { InvoiceLineItemsTable, InvoiceDepositsSection, InvoicePrintPreview, InvoiceCreditPaymentCard } from '../../components/invoice';
import { CustomerDetailsSection } from '../../components/CustomerDetailsSection';
// import { LoyaltyBadge } from '../../components/LoyaltyBadge'; // Hidden 29-Apr-2026 per user request — re-enable when loyalty tiers are launched
import TradeCustomerChip from '../../components/admin/TradeCustomerChip';

const defaultCompanyInfo = {
  name: 'Tile Station',
  address: 'Unit 3 Trade City Coldharbour Road',
  city: 'Northfleet Gravesend DA11 8AB',
  telephone: '01474 878 989',
  email: 'gravesend@tilestation.co.uk',
  companyNo: '11982550',
  vatNo: '324 251 828'
};

const paymentMethodOptions = ['Card', 'Cash', 'Bank Transfer', 'Link Payment', 'Cheque'];
const orderTypes = ['Store Order', 'Special Order'];

const defaultTerms = `TERMS & CONDITIONS - PLEASE READ

REFUNDS
• Any unwanted Full packs of STOCKED TILES will occur a 20% restocking charge. Only 10% of total tiles purchased will be refunded within 28 days from collection or delivery date.
• Any unwanted Full packs of SPECIAL-ORDER TILES will occur a 50% restocking charge. Only 10% of total tiles purchased will be refunded within 28 days from collection or delivery date.
• BATHROOM PRODUCTS are non-refundable.
• Powered and chemical base products are non-refundable.
• Refunds will not be processed without original invoice.

CANCELLATIONS POLICY
• Any cancellations of STOCKED TILES will occur 20% cancellation charge within 28 days of invoice date.
• Any cancellation of SPECIAL-ORDER TILES will occur a 30% cancellation charge within 28 days of invoice.
• Any cancellations of BATHROOM PRODUCTS will occur a 50% restocking charge within 28 days of invoice.

DELIVERY INFORMATION
We offer a delivery service; charges vary based on location.
• All deliveries are KERBSIDE DELIVERY only, delivery driver(s) are not insured to go into properties.
• Assistance required to unload.
• Re-delivery will occur additional charges.
• Any broken tiles need to be Reported within 48 hours of delivery or collection with photo proof to be replaced.

BY PURCHASING A PRODUCT FROM TILE STATION, YOU AGREE TO THESE TERMS & CONDITIONS.`;

const emptyLineItem = {
  qty: '',
  m2: '',
  product: '',
  price: '',        // Original/List price
  duePrice: '',     // Custom/Negotiated/Due price (editable)
  discount: 0,
  productId: '',
  sku: '',
  stock: 0,
  tile_m2_per_piece: null,  // m² per piece for auto-calculation
  max_discount: null  // Maximum discount % allowed for this product
};

export const Invoice = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const printRef = useRef();
  const { user } = useAuth();
  const [products, setProducts] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [showrooms, setStores] = useState([]);
  const [suppliers, setSuppliers] = useState([]);  // Add suppliers for supplier stock display
  const [selectedStore, setSelectedStore] = useState(null);
  const storeSetFromQuotationRef = useRef(false);  // Track if store was set from quotation conversion
  const [showroomLocked, setStoreLocked] = useState(false);
  const [showStorePinDialog, setShowStorePinDialog] = useState(false);
  const [showroomPin, setStorePin] = useState('');
  const [pendingStoreId, setPendingStoreId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [activeLineIndex, setActiveLineIndex] = useState(null);
  
  // VAT toggle state - defaults to true (with VAT), can be set to false for cash quotation conversions
  const [applyVat, setApplyVat] = useState(true);
  
  // Check if user can freely switch showrooms (only super_admin can)
  const canFreelySwitchStores = user?.role === 'super_admin';
  // Check if user is assigned to a specific showroom
  const hasAssignedStore = !!user?.showroom_id;
  
  // Customer search state
  const [customerSearchTerm, setCustomerSearchTerm] = useState('');
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false);
  
  // Edit mode state
  const [editMode, setEditMode] = useState(false);
  const [editInvoiceId, setEditInvoiceId] = useState(null);
  
  // Cash Quotation conversion tracking - locks payment method to "Cash" only
  const [isFromCashQuotation, setIsFromCashQuotation] = useState(false);
  const [pendingCashQuotationId, setPendingCashQuotationId] = useState(null); // Store cash quotation ID for conversion after save
  const [pendingQuotationId, setPendingQuotationId] = useState(null); // Store regular quotation ID for conversion after save

  // EPOS feature flags — super-admin toggle for the opt-in "Apply trade
  // pricing" button. Defaults to false so the button stays hidden until the
  // toggle is flipped from Trade Accounts → EPOS Settings.
  const [eposFeatureFlags, setEposFeatureFlags] = useState({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.getEposFeatureFlags();
        if (!cancelled) setEposFeatureFlags(r.data?.flags || {});
      } catch {
        // Non-fatal — buttons just stay hidden, which is the safe default.
      }
    })();
    return () => { cancelled = true; };
  }, []);
  
  // Unsaved changes tracking
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);
  const [pendingAction, setPendingAction] = useState(null); // 'new', 'navigate', 'history'
  const [pendingNavigatePath, setPendingNavigatePath] = useState(null);
  const [justSaved, setJustSaved] = useState(false); // Flag to prevent useEffect from resetting after save
  
  // PIN verification state
  const [showPinDialog, setShowPinDialog] = useState(false);
  const [staffPin, setStaffPin] = useState('');
  const [verifiedStaff, setVerifiedStaff] = useState(null);
  const [verifyingPin, setVerifyingPin] = useState(false);
  
  // Email confirmation dialog state
  const [showEmailDialog, setShowEmailDialog] = useState(false);
  const [savedInvoiceId, setSavedInvoiceId] = useState(null);
  const savedInvoiceIdRef = useRef(null); // Ref to store invoice ID synchronously for email sending
  const [sendingEmail, setSendingEmail] = useState(false);
  
  // Discount authorization state
  const [showDiscountAuthDialog, setShowDiscountAuthDialog] = useState(false);
  const [discountAuthPin, setDiscountAuthPin] = useState('');
  const [pendingDiscountLineIndex, setPendingDiscountLineIndex] = useState(null);
  const [pendingDiscountValue, setPendingDiscountValue] = useState(null);
  const [authorizedDiscounts, setAuthorizedDiscounts] = useState({}); // Track authorized overrides per line item
  const [verifyingDiscountAuth, setVerifyingDiscountAuth] = useState(false);
  
  // Refund mode state
  const [refundMode, setRefundMode] = useState(false);
  const [refundType, setRefundType] = useState('partial'); // partial, full, exchange
  const [selectedRefundItems, setSelectedRefundItems] = useState({}); // { index: { selected: bool, quantity: number } }
  const [showRefundConfirmDialog, setShowRefundConfirmDialog] = useState(false);
  const [refundReason, setRefundReason] = useState('');
  const [refundMethod, setRefundMethod] = useState('original_payment');
  const [processingRefund, setProcessingRefund] = useState(false);
  
  const [invoiceData, setInvoiceData] = useState({
    invoiceNo: `INV-${Date.now().toString().slice(-6)}`,
    date: new Date().toLocaleDateString('en-GB'),
    time: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    customerName: '',
    customerPhone: '',
    customerAddress: '',
    customerEmail: '',
    notes: '',
    salesPerson: '',
    orderType: '',
    deposits: [{ date: new Date().toLocaleDateString('en-GB'), amount: '', method: '', note: '' }],
    lineItems: [{ ...emptyLineItem }],
    companyInfo: { ...defaultCompanyInfo },
    termsAndConditions: defaultTerms
  });

  // Per-product credit-back preview for the TradeCustomerChip pill.
  // Mirrors the backend `_compute_per_line_credit` so the staff sees the
  // exact £ figure that will accrue to the trade customer when this invoice
  // is saved (looking up each line's `credit_back_rate` from the catalogue
  // with a 2% global fallback).
  const [creditPreview, setCreditPreview] = useState({ total_credit: 0, blended_rate: 0, breakdown: [] });

  // Check for locked showroom on component mount
  useEffect(() => {
    const checkLockedStore = () => {
      const stored = localStorage.getItem('lockedStore');
      if (stored) {
        try {
          const { showroomId, date } = JSON.parse(stored);
          const today = new Date().toLocaleDateString('en-GB');
          if (date === today && showroomId) {
            return showroomId;
          } else {
            // Clear expired lock
            localStorage.removeItem('lockedStore');
          }
        } catch (e) {
          localStorage.removeItem('lockedStore');
        }
      }
      return null;
    };
    
    const lockedId = checkLockedStore();
    if (lockedId) {
      setStoreLocked(true);
      // Will be applied after showrooms are loaded
    }
  }, []);

  // Check for edit mode from navigation state
  useEffect(() => {
    if (location.state?.editInvoice) {
      const invoice = location.state.editInvoice;
      setEditMode(true);
      setEditInvoiceId(invoice.id);
      
      // Convert line items to the format used in the form
      const lineItems = invoice.line_items?.map(item => ({
        productId: item.product_id,
        product: toTitleCase(item.product_name),
        sku: item.sku || '',
        qty: item.quantity.toString(),
        m2: item.m2 || '',
        price: item.price.toString(),
        duePrice: item.due_price !== undefined && item.due_price !== null ? item.due_price.toString() : item.price.toString(),
        discount: item.discount || 0,
        stock: 0 // Will be updated after products load
      })) || [{ ...emptyLineItem }];
      
      setInvoiceData({
        invoiceNo: invoice.invoice_no,
        date: invoice.date,
        time: invoice.time,
        customerName: invoice.customer_name || '',
        customerPhone: invoice.customer_phone || '',
        customerAddress: invoice.customer_address || '',
        customerEmail: invoice.customer_email || '',
        notes: invoice.notes || '',
        salesPerson: invoice.sales_person || '',
        orderType: invoice.order_type || 'Store Order',
        deposits: invoice.deposits?.length > 0 
          ? invoice.deposits.map((d, idx) => ({
              date: d.date,
              amount: d.amount,
              // For method: first try deposit.method, then deposit.note, then invoice's payment_method (for legacy data)
              method: d.method || d.note || (idx === 0 ? invoice.payment_method : '') || '',
              note: d.note || '',
              customNote: d.customNote || ''
            }))
          : [{ date: new Date().toLocaleDateString('en-GB'), amount: '', method: '', note: '' }],
        lineItems,
        companyInfo: { ...defaultCompanyInfo },
        termsAndConditions: defaultTerms
      });
      
      // Restore showroom from saved invoice to ensure edits don't change the showroom
      if (invoice.showroom_id && invoice.showroom_name) {
        console.log('[Invoice] Restoring showroom from saved invoice:', invoice.showroom_id, invoice.showroom_name);
        setSelectedStore({
          id: invoice.showroom_id,
          name: invoice.showroom_name
        });
        storeSetFromQuotationRef.current = true; // Use same mechanism to prevent override
      }
      
      // IMPORTANT: Restore VAT setting from saved invoice
      // Cash quotation conversions have apply_vat: false
      // Also check for legacy invoices converted before apply_vat was saved
      const isCashQuotationConversion = invoice.apply_vat === false || 
        (invoice.notes && invoice.notes.toLowerCase().includes('cash quotation')) ||
        (invoice.order_type && invoice.order_type.toLowerCase().includes('cash'));
      
      if (isCashQuotationConversion) {
        console.log('[Invoice] Detected cash quotation conversion - setting applyVat=FALSE');
        setApplyVat(false);
        setIsFromCashQuotation(true);
      }
      
      // Set verified staff if invoice had one
      if (invoice.staff_name) {
        setVerifiedStaff({
          staff_name: invoice.staff_name,
          staff_id: invoice.staff_id
        });
      }
      
      // Clear the navigation state
      window.history.replaceState({}, document.title);
    }
    
    // Handle conversion from Quotation
    if (location.state?.fromQuotation) {
      const quotation = location.state.fromQuotation;
      console.log('[Invoice] Converting from quotation:', quotation);
      console.log('[Invoice] isCashQuotation flag:', quotation.isCashQuotation);
      console.log('[Invoice] Quotation showroom_id:', quotation.showroom_id, 'showroom_name:', quotation.showroom_name);
      
      // Convert quotation line items to invoice format
      const lineItems = quotation.lineItems?.map(item => ({
        productId: item.productId || '',
        product: toTitleCase(item.product) || '',
        sku: item.sku || '',
        qty: item.qty || '',
        m2: item.m2 || '',
        price: item.price || '',
        duePrice: item.duePrice || item.price || '',
        discount: item.discount || 0,
        stock: item.stock || 0,
        tile_m2_per_piece: item.tile_m2_per_piece || null,
        tiles_per_box: item.tiles_per_box || null,
        box_m2_coverage: item.box_m2_coverage || null,
        max_discount: item.max_discount || null
      })) || [{ ...emptyLineItem }];
      
      setInvoiceData(prev => {
        // Use the date passed by the conversion handler (today's date, from
        // 24 Feb 2026 onward). Fallback to existing form date if absent —
        // never reuse the quotation's original date, that broke daily
        // revenue totals when customers came back weeks later.
        const newDate = quotation.date || prev.date;
        const newTime = quotation.time || prev.time;
        // Sync any auto-defaulted deposit rows to the new (today's) date so
        // payment date matches the invoice date for revenue attribution.
        const syncedDeposits = (prev.deposits || []).map(dep =>
          (!dep.date || dep.date === prev.date) ? { ...dep, date: newDate } : dep
        );
        return {
          ...prev,
          date: newDate,
          time: newTime,
          customerName: quotation.customerName || '',
          customerPhone: quotation.customerPhone || '',
          customerEmail: quotation.customerEmail || '',
          customerAddress: quotation.customerAddress || '',
          salesPerson: quotation.salesPerson || user?.name || '',
          notes: quotation.notes || '',
          lineItems,
          deposits: syncedDeposits,
          companyInfo: quotation.companyInfo || { ...defaultCompanyInfo }
        };
      });
      
      // CRITICAL FIX: Set the showroom from the quotation to ensure invoice is saved to the correct showroom
      // This fixes the bug where converted invoices were being saved to wrong showroom
      if (quotation.showroom_id && quotation.showroom_name) {
        console.log('[Invoice] Setting selectedStore from quotation:', quotation.showroom_id, quotation.showroom_name);
        setSelectedStore({
          id: quotation.showroom_id,
          name: quotation.showroom_name
        });
        // Mark that store was set from quotation - prevents fetchData from overriding
        storeSetFromQuotationRef.current = true;
        // Lock the store to prevent accidental change during conversion
        setStoreLocked(true);
      }
      
      // Cash quotations have NO VAT - preserve this setting when converting to invoice
      if (quotation.isCashQuotation || quotation.noVat) {
        console.log('[Invoice] Setting applyVat to FALSE for cash quotation');
        setApplyVat(false);
        
        // Set flag to lock payment method to Cash only
        setIsFromCashQuotation(true);
        console.log('[Invoice] Cash Quotation conversion detected - Payment method locked to Cash');
        
        // Store quotation ID for marking as converted AFTER invoice is saved
        if (quotation.quotationId) {
          console.log('[Invoice] *** SETTING pendingCashQuotationId ***:', quotation.quotationId);
          setPendingCashQuotationId(quotation.quotationId);
        } else {
          console.error('[Invoice] WARNING: quotation.quotationId is missing! Cannot track conversion.');
          console.log('[Invoice] Full quotation object:', JSON.stringify(quotation));
        }
        
        // Pre-fill the first deposit with Cash payment method, using the invoice date
        // (which may be backdated from the cash quotation) so the payment is attributed
        // to the correct day on Invoice History.
        setInvoiceData(prev => ({
          ...prev,
          deposits: [{ 
            date: prev.date || new Date().toLocaleDateString('en-GB'), 
            amount: '', 
            method: 'Cash', 
            note: 'Cash' 
          }]
        }));
      } else {
        console.log('[Invoice] Keeping applyVat as TRUE (not a cash quotation)');
        setIsFromCashQuotation(false);
        
        // Store regular quotation ID for marking as converted AFTER invoice is saved.
        // Matches the cash-quotation pattern: only mark as converted once the invoice
        // is actually persisted, preventing orphaned "converted" quotations with no matching invoice.
        if (quotation.quotationId) {
          console.log('[Invoice] *** SETTING pendingQuotationId ***:', quotation.quotationId);
          setPendingQuotationId(quotation.quotationId);
        }
      }
      
      toast.success('Quotation loaded - Complete the invoice details to save');
      
      // Clear the navigation state
      window.history.replaceState({}, document.title);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close customer dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (!e.target.closest('[data-testid="customer-search-input"]') && 
          !e.target.closest('.customer-dropdown')) {
        setShowCustomerDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Check if invoice has any data (to track unsaved changes)
  const checkHasData = () => {
    const hasLineItems = invoiceData.lineItems.some(item => 
      item.productId || item.product || item.qty || item.price
    );
    const hasCustomerData = invoiceData.customerName || invoiceData.customerPhone || 
                           invoiceData.customerEmail || invoiceData.customerAddress;
    return hasLineItems || hasCustomerData;
  };

  // Track unsaved changes when invoice data changes
  useEffect(() => {
    if (!loading) {
      // Don't set unsaved if we just saved - reset the flag after a moment
      if (justSaved) {
        setJustSaved(false);
        return;
      }
      setHasUnsavedChanges(checkHasData());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoiceData, loading]);

  // ── Debounced per-product credit-back preview ─────────────────────────
  // Fires `POST /api/invoices/credit-back-rates` whenever the line items
  // settle. Uses a SKU+qty+price signature as the dependency so we don't
  // refire on unrelated state changes (e.g. customer name typing). The
  // result feeds the `<TradeCustomerChip earnedCredit={…} />` preview pill.
  const lineItemsCreditSig = JSON.stringify(
    (invoiceData.lineItems || []).map(li => [
      li.productId || '',
      li.sku || '',
      Number(li.qty) || 0,
      Number(li.duePrice !== '' && li.duePrice !== null && li.duePrice !== undefined ? li.duePrice : li.price) || 0,
      !!li.isReturn,
    ])
  );
  useEffect(() => {
    let alive = true;
    const handle = setTimeout(async () => {
      try {
        const validItems = (invoiceData.lineItems || [])
          .filter(li => !li.isReturn && (Number(li.qty) || 0) > 0)
          .map(li => ({
            product_id: li.productId || null,
            sku: li.sku || null,
            product_name: li.product || null,
            quantity: Number(li.qty) || 0,
            price: Number(li.price) || 0,
            due_price: li.duePrice !== '' && li.duePrice !== null && li.duePrice !== undefined
              ? Number(li.duePrice)
              : null,
          }));
        if (validItems.length === 0) {
          if (alive) setCreditPreview({ total_credit: 0, blended_rate: 0, breakdown: [] });
          return;
        }
        const res = await api.post('/invoices/credit-back-rates', {
          line_items: validItems,
          apply_vat: applyVat,
        });
        if (!alive) return;
        setCreditPreview({
          total_credit: Number(res.data?.total_credit || 0),
          blended_rate: Number(res.data?.blended_rate || 0),
          breakdown: Array.isArray(res.data?.breakdown) ? res.data.breakdown : [],
        });
      } catch {
        if (alive) setCreditPreview({ total_credit: 0, blended_rate: 0, breakdown: [] });
      }
    }, 350);
    return () => {
      alive = false;
      clearTimeout(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineItemsCreditSig, applyVat]);

  // Browser beforeunload warning
  useEffect(() => {
    const handleBeforeUnload = (e) => {
      if (hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = 'You have unsaved changes. Are you sure you want to leave?';
        return e.returnValue;
      }
    };
    
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnsavedChanges]);

  // Handle navigation with unsaved changes check
  const handleNavigateWithCheck = (path, action = 'navigate') => {
    if (hasUnsavedChanges) {
      setPendingAction(action);
      setPendingNavigatePath(path);
      setShowUnsavedDialog(true);
    } else {
      if (path) navigate(path);
    }
  };

  // Confirm discard changes
  const confirmDiscardChanges = () => {
    setHasUnsavedChanges(false);
    setShowUnsavedDialog(false);
    
    if (pendingAction === 'new') {
      performNewInvoice();
    } else if (pendingAction === 'history') {
      navigate('/admin/invoice-history');
    } else if (pendingNavigatePath) {
      navigate(pendingNavigatePath);
    }
    
    setPendingAction(null);
    setPendingNavigatePath(null);
  };

  // Cancel discard
  const cancelDiscard = () => {
    setShowUnsavedDialog(false);
    setPendingAction(null);
    setPendingNavigatePath(null);
  };

  const fetchData = async () => {
    // PERFORMANCE FIX (21 May 2026 — in-store EPOS pages stuck on "Loading
    // products..." for several seconds, blocking staff from taking payments).
    //
    // Old flow: fetched 5000 supplier products + main products + customers +
    // showrooms + suppliers in ONE Promise.all, blocked render until ALL done.
    // The 5000-row supplier-products fetch was the killer (~3-5s on cold cache).
    //
    // New flow:
    //   1) Fast first paint — fetch ONLY the small, critical lists in parallel
    //      (main products + customers + showrooms + suppliers). Page becomes
    //      interactive in ~500ms.
    //   2) Background fetch — supplier products load AFTER first paint and
    //      get merged into the autocomplete pool when they arrive. Staff can
    //      already start typing main-product SKUs while supplier rows stream in.
    try {
      const [productsRes, customersRes, showroomsRes, suppliersRes] = await Promise.all([
        api.getProducts().catch((err) => { console.error('Products load error:', err?.response?.status, err?.response?.data?.detail || err.message); return { data: [] }; }),
        api.getCustomers().catch(() => ({ data: [] })),
        api.getStores().catch(() => ({ data: [] })),
        api.getSuppliers().catch(() => ({ data: [] })),
      ]);
      
      const mainProducts = productsRes.data || [];
      
      // Helper to clean None patterns from strings
      const cleanNonePatterns = (str) => {
        if (!str) return '';
        return str
          .replace(/\s*NonexNone\s*/gi, ' ')
          .replace(/\s*NoneXNone\s*/gi, ' ')
          .replace(/\s*None\s*x\s*None\s*/gi, ' ')
          .replace(/\s*xNone\s*/gi, ' ')
          .replace(/\s*Nonex\s*/gi, ' ')
          .replace(/\s*\(None\)\s*/gi, ' ')
          .replace(/\s*\(None\d*[Kk]?g?\)\s*/gi, ' ')
          .replace(/\s*None\s*[Kk]g\s*/gi, ' ')
          .replace(/\s+None\s*$/gi, '')
          .replace(/\s+/g, ' ')
          .trim();
      };

      // Helper to build complete product name from available fields
      const buildProductName = (sp) => {
        // Start with product_name or name - clean None patterns first
        let baseName = cleanNonePatterns(sp.product_name || sp.name || '');
        
        // Extract components - filter out "None" string values, handle array types
        const rawColor = Array.isArray(sp.color) ? sp.color[0] : sp.color;
        const rawFinish = Array.isArray(sp.finish) ? sp.finish[0] : sp.finish;
        const rawSize = Array.isArray(sp.size) ? sp.size[0] : sp.size;
        const color = (rawColor && rawColor !== 'None' && rawColor !== 'null') ? String(rawColor) : '';
        const finish = (rawFinish && rawFinish !== 'None' && rawFinish !== 'null') ? String(rawFinish) : '';
        const size = (rawSize && rawSize !== 'None' && rawSize !== 'null' && !String(rawSize).includes('None')) ? String(rawSize) : '';
        
        // Check if name already contains color/finish/size
        const nameUpper = baseName.toUpperCase();
        const hasColor = color && nameUpper.includes(color.toUpperCase());
        const hasFinish = finish && nameUpper.includes(finish.toUpperCase());
        const hasSize = size && (nameUpper.includes(size.toUpperCase()) || nameUpper.includes(size.replace('x', 'X')));
        
        // Build parts to add
        let parts = baseName.split(' ').filter(p => p && p !== 'None');
        
        // If color not in name, try to insert it after the range name (first word)
        if (color && !hasColor && parts.length > 0) {
          // Insert color after first word (range name)
          parts.splice(1, 0, color);
        }
        
        // If finish not in name, add at end
        if (finish && !hasFinish) {
          // Check if name ends with size pattern (e.g., "60x120")
          const lastPart = parts[parts.length - 1];
          const isSizePattern = /^\d+x\d+/i.test(lastPart);
          if (isSizePattern) {
            // Add finish after size
            parts.push(finish);
          } else {
            parts.push(finish);
          }
        }
        
        return cleanNonePatterns(parts.join(' ').trim());
      };
      
      // Convert supplier products to match main product format.
      // Extracted into a stable function so the deferred background fetch
      // (below) can reuse it without rebuilding the helper closures.
      const convertSupplierProducts = (supplierList, existingSKUs) => supplierList
        .filter(sp => sp.sku && !existingSKUs.has(sp.sku))
        .map(sp => ({
          id: sp.products_db_id || `sp_${sp.sku}`,
          name: buildProductName(sp),
          sku: sp.sku,
          price: sp.price || sp.trade_price || 0,
          cost_price: sp.cost_price || sp.trade_price || 0,
          stock: sp.stock_quantity || sp.stock_m2 || 0,
          description: sp.description || '',
          supplier_name: sp.supplier || '',
          supplier_product_name: sp.name,
          color: Array.isArray(sp.color) ? sp.color[0] : (sp.color || ''),
          finish: Array.isArray(sp.finish) ? sp.finish[0] : (sp.finish || ''),
          size: Array.isArray(sp.size) ? sp.size[0] : (sp.size || ''),
          images: sp.image ? [sp.image] : (sp.images || []),
          source: 'supplier_products'
        }));

      // FIRST PAINT — set main products only, so the page becomes interactive.
      setProducts(mainProducts);
      setCustomers(customersRes.data || []);
      setStores(showroomsRes.data || []);
      setSuppliers(suppliersRes.data || []);

      // BACKGROUND — fetch supplier products without blocking. When done,
      // merge them in. Wrapped in setTimeout(0) so React has a tick to
      // commit the first paint before this kicks off the network call.
      setTimeout(() => {
        api.getSupplierProducts({ limit: 5000 })
          .then((supplierProductsRes) => {
            const supplierProducts = supplierProductsRes.data?.products || [];
            if (!supplierProducts.length) return;
            const existingSKUs = new Set(mainProducts.map(p => p.sku));
            const converted = convertSupplierProducts(supplierProducts, existingSKUs);
            setProducts([...mainProducts, ...converted]);
          })
          .catch((err) => {
            console.error('Supplier products background load failed (non-fatal):', err?.message);
          });
      }, 0);
      
      // Check for locked showroom first (only for users with specific showroom or day lock)
      const stored = localStorage.getItem('lockedStore');
      let lockedStoreId = null;
      if (stored && !canFreelySwitchStores) {
        try {
          const { showroomId, date } = JSON.parse(stored);
          const today = new Date().toLocaleDateString('en-GB');
          if (date === today && showroomId) {
            lockedStoreId = showroomId;
          }
        } catch (e) {
          // ignore
        }
      }
      
      // Set showroom based on user's assignment
      // IMPORTANT: Don't override if store was already set from quotation conversion
      if (showroomsRes.data?.length > 0 && !selectedStore && !storeSetFromQuotationRef.current) {
        let defaultStore;
        
        // If user is assigned to a specific showroom, use that (and lock it)
        if (user?.showroom_id) {
          defaultStore = showroomsRes.data.find(s => s.id === user.showroom_id);
          if (defaultStore) {
            setStoreLocked(true);
          }
        }
        // Otherwise, check for day lock (only for non-super-admin users)
        else if (lockedStoreId && !canFreelySwitchStores) {
          defaultStore = showroomsRes.data.find(s => s.id === lockedStoreId);
          if (defaultStore) {
            setStoreLocked(true);
          }
        }
        // Default to first showroom (but don't lock for non-super-admin - they need to confirm with PIN)
        if (!defaultStore) {
          defaultStore = showroomsRes.data[0];
          // For non-super-admin users without a locked showroom, prompt for PIN
          if (!canFreelySwitchStores && !user?.showroom_id) {
            // Set a flag to prompt for PIN to lock showroom on first action
            setPendingStoreId(defaultStore.id);
            setShowStorePinDialog(true);
          }
        }
        
        setSelectedStore(defaultStore);
        
        // Parse the showroom address properly
        const addressParts = defaultStore.address?.split(',').map(p => p.trim()) || [];
        const firstLine = addressParts.slice(0, 2).join(', '); // First two parts as address
        const restLine = addressParts.slice(2).join(', '); // Rest as city/postcode
        
        // Update company info with showroom details
        setInvoiceData(prev => ({
          ...prev,
          companyInfo: {
            ...prev.companyInfo,
            name: `Tile Station - ${defaultStore.name}`,
            address: firstLine || prev.companyInfo.address,
            city: restLine || prev.companyInfo.city,
            telephone: defaultStore.phone || prev.companyInfo.telephone,
            email: defaultStore.email || prev.companyInfo.email
          }
        }));
      }
      
      // If in edit mode, update stock values for line items
      if (editMode && invoiceData.lineItems) {
        const updatedLineItems = invoiceData.lineItems.map(item => {
          if (item.productId) {
            const product = allProducts.find(p => p.id === item.productId);
            if (product) {
              // Add back the quantity that was deducted for this invoice
              return { ...item, stock: product.stock + parseInt(item.qty || 0) };
            }
          }
          return item;
        });
        setInvoiceData(prev => ({ ...prev, lineItems: updatedLineItems }));
      }
    } catch (error) {
      console.error('EPOS fetchData error:', error);
      if (error?.response?.status === 401) {
        toast.error('Session expired. Please log in again.');
      } else {
        toast.error('Failed to load some data. Try refreshing the page.');
      }
    } finally {
      setLoading(false);
    }
  };

  // Handle showroom change - requires PIN for any change (for non-super-admin users)
  const handleStoreChange = (showroomId) => {
    // Super admin and users with all showrooms access can change freely
    if (canFreelySwitchStores) {
      applyStoreChange(showroomId, false); // Don't lock for super admin
      return;
    }
    
    // If user is assigned to a specific showroom, they can't change
    if (user?.showroom_id) {
      toast.error('You can only use your assigned showroom');
      return;
    }
    
    // Check localStorage directly for lock status
    const stored = localStorage.getItem('lockedStore');
    let isCurrentlyLocked = false;
    let lockedStoreId = null;
    
    if (stored) {
      try {
        const { showroomId: storedId, date } = JSON.parse(stored);
        const today = new Date().toLocaleDateString('en-GB');
        if (date === today && storedId) {
          isCurrentlyLocked = true;
          lockedStoreId = storedId;
        }
      } catch (e) {
        // ignore
      }
    }
    
    // If selecting same showroom that's already locked, no PIN needed
    if (isCurrentlyLocked && lockedStoreId === showroomId) {
      return;
    }
    
    // Always require PIN for showroom selection/change (first time or change)
    setPendingStoreId(showroomId);
    setShowStorePinDialog(true);
  };
  
  // Apply showroom change and lock it
  const applyStoreChange = (showroomId, shouldLock = true) => {
    const showroom = showrooms.find(s => s.id === showroomId);
    if (showroom) {
      setSelectedStore(showroom);
      
      // Parse the showroom address properly
      // Format: "Unit X, Street, Area, City, Postcode"
      const addressParts = showroom.address?.split(',').map(p => p.trim()) || [];
      const firstLine = addressParts.slice(0, 2).join(', '); // First two parts as address
      const restLine = addressParts.slice(2).join(', '); // Rest as city/postcode
      
      // Update company info with showroom details
      setInvoiceData(prev => ({
        ...prev,
        companyInfo: {
          ...prev.companyInfo,
          name: `Tile Station - ${showroom.name}`,
          address: firstLine || defaultCompanyInfo.address,
          city: restLine || defaultCompanyInfo.city,
          telephone: showroom.phone || defaultCompanyInfo.telephone,
          email: showroom.email || defaultCompanyInfo.email
        }
      }));
      
      // Lock the showroom for the day
      if (shouldLock) {
        const today = new Date().toLocaleDateString('en-GB');
        localStorage.setItem('lockedStore', JSON.stringify({
          showroomId: showroom.id,
          showroomName: showroom.name,
          date: today
        }));
        setStoreLocked(true);
        toast.success(`Store set to ${showroom.name} for today`);
      }
    }
  };
  
  // Verify PIN for showroom change
  const handleStorePinVerify = async () => {
    if (!showroomPin || showroomPin.length < 4) {
      toast.error('Please enter a valid PIN');
      return;
    }
    
    setVerifyingPin(true);
    try {
      await api.verifyStaffPin(showroomPin);
      // PIN verified, apply the showroom change
      applyStoreChange(pendingStoreId, true);
      setShowStorePinDialog(false);
      setStorePin('');
      setPendingStoreId(null);
    } catch (error) {
      toast.error('Invalid PIN');
    } finally {
      setVerifyingPin(false);
    }
  };

  // Filter products based on search (by SKU or name)
  // Supports word-by-word matching in any order (e.g., "chrome tin" matches "Tin Chrome Edge")
  // Also searches by original supplier product name (e.g., "Tenby White" finds "Sparta White")
  const filteredProducts = products.filter(p => {
    if (!searchTerm) return true;
    
    const searchLower = searchTerm.toLowerCase().trim();
    const nameLower = (p.name || '').toLowerCase();
    const skuLower = (p.sku || '').toLowerCase();
    const descLower = (p.description || '').toLowerCase();
    const supplierLower = (p.supplier_name || '').toLowerCase();
    // Allow searching by original supplier product name (flexible search)
    const supplierProductNameLower = (p.supplier_product_name || '').toLowerCase();
    
    // First check if exact substring match (original behavior)
    if (nameLower.includes(searchLower) || skuLower.includes(searchLower)) {
      return true;
    }
    
    // Check if search matches original supplier product name
    if (supplierProductNameLower && supplierProductNameLower.includes(searchLower)) {
      return true;
    }
    
    // Split search into words and check if ALL words are found in product (any order)
    const searchWords = searchLower.split(/\s+/).filter(w => w.length > 0);
    
    // If single word, just check contains
    if (searchWords.length === 1) {
      return nameLower.includes(searchWords[0]) || 
             skuLower.includes(searchWords[0]) ||
             descLower.includes(searchWords[0]) ||
             supplierLower.includes(searchWords[0]) ||
             supplierProductNameLower.includes(searchWords[0]);
    }
    
    // For multiple words, ALL words must be found somewhere in the product (including supplier product name)
    const combinedText = `${nameLower} ${skuLower} ${descLower} ${supplierLower} ${supplierProductNameLower}`;
    return searchWords.every(word => combinedText.includes(word));
  });

  // Capitalize first letter of every word (Title Case)
  const toTitleCase = (str) => {
    if (!str) return '';
    return str.replace(/\b\w/g, char => char.toUpperCase());
  };

  // Filter customers based on search (by name, email, phone, address, postcode)
  const filteredCustomers = customers.filter(c => {
    if (!customerSearchTerm) return true;
    const search = customerSearchTerm.toLowerCase();
    const addressStr = c.address ? 
      `${c.address.line1 || ''} ${c.address.line2 || ''} ${c.address.city || ''} ${c.address.postcode || ''}`.toLowerCase() : '';
    
    return (
      (c.name && c.name.toLowerCase().includes(search)) ||
      (c.email && c.email.toLowerCase().includes(search)) ||
      (c.phone && c.phone.toLowerCase().includes(search)) ||
      addressStr.includes(search)
    );
  });

  // Select product for a line item
  const selectProduct = (index, product) => {
    const newItems = [...invoiceData.lineItems];
    // Build product display name with size/color if available
    let productDisplayName = toTitleCase(product.name);
    if (product.description) {
      const sizeMatch = product.description.match(/Size:\s*([^|]+)/i);
      const colorMatch = product.description.match(/Color:\s*([^|]+)/i);
      const extras = [];
      if (sizeMatch) extras.push(sizeMatch[1].trim());
      // Only add color if it's not already in the product name
      if (colorMatch) {
        const colorValue = colorMatch[1].trim();
        if (!product.name.toLowerCase().includes(colorValue.toLowerCase())) {
          extras.push(colorValue);
        }
      }
      if (extras.length > 0) {
        productDisplayName += ` (${extras.join(', ')})`;
      }
    }
    // Get showroom-specific stock instead of total stock
    const showroomStock = selectedStore?.id && product.showroom_stock 
      ? (product.showroom_stock[selectedStore.id] || 0)
      : product.stock;
    
    newItems[index] = {
      ...newItems[index],
      productId: product.id,
      product: productDisplayName,
      sku: product.sku || '',
      price: product.price,
      duePrice: product.price,  // Initialize duePrice to match original price
      stock: showroomStock,  // Use showroom-specific stock
      totalStock: product.stock,  // Keep total stock for reference
      showroom_stock: product.showroom_stock,  // Pass showroom stock data for "Other Stores" feature
      tile_m2_per_piece: product.tile_m2_per_piece || null,
      tiles_per_box: product.tiles_per_box || null,
      box_m2_coverage: product.box_m2_coverage || null,
      max_discount: product.max_discount || null  // Maximum discount limit for this product
    };
    // If product has m² per piece and qty is already set, calculate m²
    if (product.tile_m2_per_piece && newItems[index].qty) {
      const qty = parseFloat(newItems[index].qty) || 0;
      newItems[index].m2 = (qty * product.tile_m2_per_piece).toFixed(2);
    }
    setInvoiceData({ ...invoiceData, lineItems: newItems });
    setActiveLineIndex(null);
    setSearchTerm('');
  };

  // Round up quantity to nearest full box
  const roundUpToBox = (index) => {
    const item = invoiceData.lineItems[index];
    if (!item.tiles_per_box || !item.qty) return;
    
    const currentQty = parseFloat(item.qty) || 0;
    const tilesPerBox = parseInt(item.tiles_per_box);
    const boxes = Math.ceil(currentQty / tilesPerBox);
    const roundedQty = boxes * tilesPerBox;
    
    updateLineItem(index, 'qty', roundedQty.toString());
  };

  // Calculate box info for line item
  const getBoxInfo = (item) => {
    if (!item.tiles_per_box || !item.qty) return null;
    const qty = parseFloat(item.qty) || 0;
    const tilesPerBox = parseInt(item.tiles_per_box);
    const boxes = qty / tilesPerBox;
    const fullBoxes = Math.floor(boxes);
    const remainder = qty % tilesPerBox;
    const isFullBoxes = remainder === 0;
    
    // Calculate box price correctly:
    // Box Price = Box Coverage (m²) × Price per m²
    // Box Coverage = Tiles per box × m² per piece
    const m2PerPiece = parseFloat(item.tile_m2_per_piece) || 0;
    const boxCoverage = tilesPerBox * m2PerPiece;
    const boxPrice = boxCoverage * (parseFloat(item.price) || 0);
    
    return {
      boxes: boxes.toFixed(2),
      fullBoxes,
      remainder,
      isFullBoxes,
      boxCoverage: boxCoverage.toFixed(3),
      boxPrice: boxPrice.toFixed(2),
      totalBoxPrice: (boxes * boxPrice).toFixed(2)
    };
  };

  // Select customer from search
  const selectCustomer = (customer) => {
    setInvoiceData({
      ...invoiceData,
      customerName: customer.name,
      customerEmail: customer.email,
      customerPhone: customer.phone || '',
      customerAddress: customer.address ? 
        `${customer.address.line1}${customer.address.line2 ? ', ' + customer.address.line2 : ''}, ${customer.address.city}, ${customer.address.postcode}` : ''
    });
    setCustomerSearchTerm('');
    setShowCustomerDropdown(false);
  };

  const updateLineItem = (index, field, value, syncDuePrice = false) => {
    const newItems = [...invoiceData.lineItems];
    const item = newItems[index];
    
    // Handle duePrice changes with max discount enforcement
    if (field === 'duePrice' && item.max_discount !== null && item.max_discount !== undefined) {
      const originalPrice = parseFloat(item.price) || 0;
      const newDuePrice = parseFloat(value) || originalPrice;
      const maxDiscount = parseFloat(item.max_discount);
      const minAllowedPrice = originalPrice * (1 - maxDiscount / 100);
      
      // Check if user is trying to exceed the max discount
      if (newDuePrice < minAllowedPrice) {
        // Super admin can always override
        if (user?.role === 'super_admin') {
          // Allow the change for super admin
          newItems[index] = { ...item, [field]: value };
        } else if (authorizedDiscounts[index]) {
          // Already authorized for this line item
          newItems[index] = { ...item, [field]: value };
        } else {
          // Show authorization dialog
          setPendingDiscountLineIndex(index);
          setPendingDiscountValue(value);
          setShowDiscountAuthDialog(true);
          return; // Don't update yet
        }
      } else {
        newItems[index] = { ...item, [field]: value };
      }
    } else if (field === 'price' && syncDuePrice) {
      // When updating price with syncDuePrice flag, update both in single state update
      // This prevents focus loss from multiple re-renders
      const shouldSync = !item.duePrice || item.duePrice === '' || item.duePrice === item.price;
      if (shouldSync) {
        newItems[index] = { ...item, price: value, duePrice: value };
      } else {
        newItems[index] = { ...item, [field]: value };
      }
    } else {
      newItems[index] = { ...item, [field]: value };
    }
    
    // Auto-calculate m² when qty changes and product has tile_m2_per_piece
    if (field === 'qty' && newItems[index].tile_m2_per_piece) {
      const qty = parseFloat(value) || 0;
      newItems[index].m2 = (qty * newItems[index].tile_m2_per_piece).toFixed(2);
    }
    
    // Auto-calculate qty (round UP) when m² changes and product has tile_m2_per_piece
    if (field === 'm2' && newItems[index].tile_m2_per_piece) {
      const m2 = parseFloat(value) || 0;
      const tilesNeeded = m2 / newItems[index].tile_m2_per_piece;
      // Round UP to the nearest whole tile
      newItems[index].qty = Math.ceil(tilesNeeded).toString();
      // Recalculate actual m² based on rounded qty
      newItems[index].m2 = (Math.ceil(tilesNeeded) * newItems[index].tile_m2_per_piece).toFixed(2);
    }
    
    setInvoiceData({ ...invoiceData, lineItems: newItems });
  };
  
  // Calculate minimum allowed price based on max discount
  const getMinAllowedPrice = (item) => {
    if (!item.max_discount || item.max_discount === null) return 0;
    const originalPrice = parseFloat(item.price) || 0;
    return originalPrice * (1 - item.max_discount / 100);
  };
  
  // Check if the current due price exceeds max discount (for non-authorized users)
  const isDiscountExceeded = (item, index) => {
    if (!item.max_discount || item.max_discount === null) return false;
    if (user?.role === 'super_admin') return false;
    if (authorizedDiscounts[index]) return false;
    
    const originalPrice = parseFloat(item.price) || 0;
    const duePrice = parseFloat(item.duePrice) || originalPrice;
    const minAllowedPrice = getMinAllowedPrice(item);
    
    return duePrice < minAllowedPrice;
  };
  
  // Handle discount authorization with PIN
  const handleDiscountAuthorization = async () => {
    if (!discountAuthPin || discountAuthPin.length < 4) {
      toast.error('Please enter a valid PIN');
      return;
    }
    
    setVerifyingDiscountAuth(true);
    try {
      // Verify the PIN is a valid manager/admin PIN
      const response = await api.verifyStaffPin(discountAuthPin);
      if (response.data && response.data.staff_name) {
        // Mark this line item as authorized
        setAuthorizedDiscounts(prev => ({
          ...prev,
          [pendingDiscountLineIndex]: {
            authorizedBy: response.data.staff_name,
            authorizedAt: new Date().toISOString()
          }
        }));
        
        // Apply the pending discount
        const newItems = [...invoiceData.lineItems];
        newItems[pendingDiscountLineIndex] = {
          ...newItems[pendingDiscountLineIndex],
          duePrice: pendingDiscountValue
        };
        setInvoiceData({ ...invoiceData, lineItems: newItems });
        
        toast.success(`Discount authorized by ${response.data.staff_name}`);
        setShowDiscountAuthDialog(false);
        setDiscountAuthPin('');
        setPendingDiscountLineIndex(null);
        setPendingDiscountValue(null);
      }
    } catch (error) {
      toast.error('Invalid PIN. Authorization denied.');
    } finally {
      setVerifyingDiscountAuth(false);
    }
  };

  const addLineItem = () => {
    setInvoiceData({
      ...invoiceData,
      lineItems: [...invoiceData.lineItems, { ...emptyLineItem }]
    });
  };

  const removeLineItem = (index) => {
    if (invoiceData.lineItems.length === 1) return;
    const newItems = invoiceData.lineItems.filter((_, i) => i !== index);
    setInvoiceData({ ...invoiceData, lineItems: newItems });
  };

  const calculateLineTotal = (item) => {
    const qty = parseFloat(item.qty) || 0;
    const originalPrice = parseFloat(item.price) || 0;
    // Use duePrice if set, otherwise fall back to original price
    const duePrice = item.duePrice !== '' && item.duePrice !== null && item.duePrice !== undefined 
      ? parseFloat(item.duePrice) 
      : originalPrice;
    
    const originalTotal = qty * originalPrice;
    const dueTotal = qty * duePrice;
    const savings = originalTotal - dueTotal;
    
    return {
      subtotal: originalTotal,      // Original price total (for reference)
      due: dueTotal,                // Actual amount due (using due price)
      savings: savings > 0 ? savings : 0,  // Savings (difference)
      discountAmount: savings > 0 ? savings : 0,
      originalPrice,
      duePrice,
      discountPercent: originalPrice > 0 ? ((originalPrice - duePrice) / originalPrice * 100) : 0
    };
  };

  const calculateTotals = () => {
    let subtotal = 0;
    let totalSavings = 0;
    let totalDue = 0;
    let totalReturns = 0;

    invoiceData.lineItems.forEach(item => {
      const calc = calculateLineTotal(item);
      if (item.isReturn) {
        // Return items are credits - deduct from total
        totalReturns += calc.due;
      } else {
        subtotal += calc.subtotal;
        totalSavings += calc.savings;
        totalDue += calc.due;
      }
    });

    // Net total after returns
    const netTotal = totalDue - totalReturns;

    // Apply VAT only if applyVat is true (defaults to true, but false for cash quotation conversions)
    const vat = applyVat ? netTotal * 0.2 : 0; // 20% VAT or 0
    const grossTotal = netTotal + vat;
    
    // Calculate total deposits
    const totalDeposits = invoiceData.deposits.reduce((sum, d) => sum + (parseFloat(d.amount) || 0), 0);
    // Trade credit redemption is a payment lane too — must reduce outstanding
    const creditRedeemed = parseFloat(invoiceData.creditRedeemedAmount) || 0;
    // Round to 2dp to avoid floating-point residuals (e.g. 13.99-inclusive VAT splits produce 1e-14)
    // that cause false-positive "Deposit Order" flags when outstanding visually reads £0.00.
    const rawOutstanding = grossTotal - totalDeposits - creditRedeemed;
    const amountOutstanding = Math.abs(rawOutstanding) < 0.005 ? 0 : Math.round(rawOutstanding * 100) / 100;

    return { subtotal, totalSavings, totalDue, totalReturns, vat, grossTotal, totalDeposits, creditRedeemed, amountOutstanding };
  };

  // Deposit management functions
  const addDeposit = () => {
    // For Cash Quotation conversions, new deposits are also locked to Cash
    const newDeposit = isFromCashQuotation
      ? { date: new Date().toLocaleDateString('en-GB'), amount: '', method: 'Cash', note: 'Cash' }
      : { date: new Date().toLocaleDateString('en-GB'), amount: '', method: '', note: '' };
    
    setInvoiceData({
      ...invoiceData,
      deposits: [...invoiceData.deposits, newDeposit]
    });
  };

  const updateDeposit = (index, field, value) => {
    const newDeposits = [...invoiceData.deposits];
    newDeposits[index] = { ...newDeposits[index], [field]: value };
    setInvoiceData({ ...invoiceData, deposits: newDeposits });
  };

  const removeDeposit = (index) => {
    if (invoiceData.deposits.length === 1) {
      // Keep at least one deposit row, just clear it
      // For Cash Quotation conversions, reset to Cash method
      const emptyDeposit = isFromCashQuotation
        ? { date: new Date().toLocaleDateString('en-GB'), amount: '', method: 'Cash', note: 'Cash' }
        : { date: new Date().toLocaleDateString('en-GB'), amount: '', method: '', note: '' };
      
      setInvoiceData({
        ...invoiceData,
        deposits: [emptyDeposit]
      });
    } else {
      const newDeposits = invoiceData.deposits.filter((_, i) => i !== index);
      setInvoiceData({ ...invoiceData, deposits: newDeposits });
    }
  };

  // ============ REFUND FUNCTIONS ============
  
  // Toggle refund mode
  const toggleRefundMode = () => {
    if (!editMode) {
      toast.error('Refund mode is only available when editing an existing invoice');
      return;
    }
    setRefundMode(!refundMode);
    if (!refundMode) {
      // Entering refund mode - initialize selection state
      const initialSelection = {};
      invoiceData.lineItems.forEach((item, index) => {
        if (item.product && item.qty) {
          initialSelection[index] = { selected: false, quantity: parseInt(item.qty) || 1 };
        }
      });
      setSelectedRefundItems(initialSelection);
      setRefundType('partial');
      setRefundReason('');
    } else {
      // Exiting refund mode - clear state
      setSelectedRefundItems({});
    }
  };

  // Toggle item selection for refund
  const toggleRefundItemSelection = (index) => {
    setSelectedRefundItems(prev => ({
      ...prev,
      [index]: {
        ...prev[index],
        selected: !prev[index]?.selected
      }
    }));
  };

  // Update refund quantity for an item
  const updateRefundQuantity = (index, quantity) => {
    const maxQty = parseInt(invoiceData.lineItems[index]?.qty) || 1;
    const newQty = Math.min(Math.max(1, parseInt(quantity) || 1), maxQty);
    setSelectedRefundItems(prev => ({
      ...prev,
      [index]: {
        ...prev[index],
        quantity: newQty
      }
    }));
  };

  // Select all items for full refund
  const selectAllForRefund = () => {
    const allSelected = {};
    invoiceData.lineItems.forEach((item, index) => {
      if (item.product && item.qty) {
        allSelected[index] = { selected: true, quantity: parseInt(item.qty) || 1 };
      }
    });
    setSelectedRefundItems(allSelected);
    setRefundType('full');
  };

  // Clear all selections
  const clearRefundSelections = () => {
    const clearedSelection = {};
    invoiceData.lineItems.forEach((item, index) => {
      if (item.product && item.qty) {
        clearedSelection[index] = { selected: false, quantity: parseInt(item.qty) || 1 };
      }
    });
    setSelectedRefundItems(clearedSelection);
  };

  // Calculate refund total
  const calculateRefundTotal = () => {
    let total = 0;
    Object.entries(selectedRefundItems).forEach(([index, item]) => {
      if (item.selected) {
        const lineItem = invoiceData.lineItems[index];
        const price = parseFloat(lineItem.duePrice) || parseFloat(lineItem.price) || 0;
        total += price * item.quantity;
      }
    });
    return total;
  };

  // Get selected items count
  const getSelectedItemsCount = () => {
    return Object.values(selectedRefundItems).filter(item => item.selected).length;
  };

  // Process the refund
  const processRefund = async () => {
    const selectedItems = Object.entries(selectedRefundItems)
      .filter(([_, item]) => item.selected)
      .map(([index, item]) => ({
        ...invoiceData.lineItems[index],
        refund_quantity: item.quantity
      }));

    if (selectedItems.length === 0) {
      toast.error('Please select at least one item to refund');
      return;
    }

    setProcessingRefund(true);
    try {
      const subtotal = calculateRefundTotal();
      const vatAmount = subtotal * 0.2;
      const grossTotal = subtotal + vatAmount;

      // Generate refund number
      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
      const refundNo = `RF-${dateStr}-${now.getTime().toString().slice(-4)}`;

      const refundData = {
        refund_no: refundNo,
        date: now.toLocaleDateString('en-GB'),
        time: now.toTimeString().slice(0, 5),
        original_invoice_id: editInvoiceId,
        original_invoice_no: invoiceData.invoiceNo,
        customer_name: invoiceData.customerName || '',
        customer_email: invoiceData.customerEmail,
        customer_phone: invoiceData.customerPhone,
        customer_address: invoiceData.customerAddress,
        line_items: selectedItems.map(item => {
          const unitPrice = parseFloat(item.duePrice) || parseFloat(item.price) || 0;
          return {
            product_id: item.productId,
            product_name: item.product,
            sku: item.sku || '',
            quantity: item.refund_quantity,
            original_price: parseFloat(item.price) || 0,
            refund_price: unitPrice,
            total: unitPrice * item.refund_quantity,
            reason: refundReason || ''
          };
        }),
        subtotal: subtotal,
        vat: vatAmount,
        gross_total: grossTotal,
        notes: refundReason,
        refund_method: refundMethod,
        refund_type: refundType === 'full' ? 'Full Refund' : refundType === 'exchange' ? 'Exchange' : 'Partial Refund',
        showroom_id: selectedStore?.id,
        showroom_name: selectedStore?.name,
        restocking_fee: 0
      };

      const refundResp = await api.createRefund(refundData);
      const reversed = refundResp?.data?.credits_reversed;
      let msg = `Refund ${refundNo} created successfully!`;
      if (reversed && (reversed.earned_reversed > 0 || reversed.redeemed_reversed > 0)) {
        const parts = [];
        if (reversed.earned_reversed > 0) parts.push(`-£${Number(reversed.earned_reversed).toFixed(2)} earned`);
        if (reversed.redeemed_reversed > 0) parts.push(`+£${Number(reversed.redeemed_reversed).toFixed(2)} redeemed refunded`);
        msg += ` · Trade credit: ${parts.join(', ')}`;
      }
      toast.success(msg, { duration: 6000 });
      
      setShowRefundConfirmDialog(false);
      setRefundMode(false);
      setSelectedRefundItems({});
      setRefundReason('');
      
      // Navigate to refund history or stay on page
      toast.info('View refund in Refund History');
    } catch (error) {
      console.error('Refund error:', error);
      toast.error(error.response?.data?.detail || 'Failed to process refund');
    } finally {
      setProcessingRefund(false);
    }
  };

  // Handle sending invoice email to customer
  const handleSendEmail = async () => {
    // Use ref first (synchronously available), then fall back to state and editInvoiceId
    const invoiceIdToUse = savedInvoiceIdRef.current || savedInvoiceId || editInvoiceId;
    
    if (!invoiceIdToUse || !invoiceData.customerEmail) {
      console.error('[Invoice] Email send error:', { 
        refId: savedInvoiceIdRef.current, 
        savedInvoiceId, 
        editInvoiceId, 
        customerEmail: invoiceData.customerEmail 
      });
      toast.error('No invoice or email to send');
      setShowEmailDialog(false);
      return;
    }
    
    setSendingEmail(true);
    try {
      await api.emailInvoicePdf(invoiceIdToUse, invoiceData.customerEmail.trim(), 'Thank you for your business. Please find your invoice attached.');
      toast.success(`Invoice emailed to ${invoiceData.customerEmail}`);
      setShowEmailDialog(false);
    } catch (error) {
      console.error('Email error:', error);
      toast.error(error.response?.data?.detail || 'Failed to send email');
    } finally {
      setSendingEmail(false);
    }
  };

  const handlePrint = () => {
    // Prevent printing if document is not saved
    if (!editMode) {
      toast.error('Please save the invoice before printing');
      return;
    }
    
    const printContent = printRef.current;
    const printWindow = window.open('', '_blank');
    
    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Invoice ${invoiceData.invoiceNo}</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
          body { font-family: Arial, sans-serif; padding: 20px; font-size: 12px; }
          .invoice-container { max-width: 800px; margin: 0 auto; }
          .header { display: flex; justify-content: space-between; margin-bottom: 20px; }
          .logo { font-size: 28px; font-weight: bold; letter-spacing: 3px; }
          .title { text-align: center; font-size: 24px; margin-bottom: 20px; }
          .company-details { text-align: right; font-size: 11px; line-height: 1.5; }
          table { width: 100%; border-collapse: collapse; margin: 20px 0; }
          th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
          th { background-color: #000 !important; color: #fff !important; font-weight: bold; }
          thead tr { background-color: #000 !important; }
          thead th { background-color: #000 !important; color: #fff !important; }
          .text-right { text-align: right; }
          .text-center { text-align: center; }
          .customer-section { margin-top: 20px; }
          .customer-row { display: flex; margin-bottom: 5px; }
          .customer-label { width: 80px; font-weight: bold; }
          .terms { margin-top: 20px; font-size: 10px; color: #666; }
          .totals-row { font-weight: bold; background-color: #f9f9f9; }
          @media print { 
            * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
            body { print-color-adjust: exact; -webkit-print-color-adjust: exact; } 
            th { background-color: #000 !important; color: #fff !important; }
            thead tr { background-color: #000 !important; }
          }
        </style>
      </head>
      <body>
        ${printContent.innerHTML}
      </body>
      </html>
    `);
    
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => {
      printWindow.print();
      printWindow.close();
    }, 250);
  };

  // Download Collection Note PDF
  const handleDownloadCollectionNote = async () => {
    if (!editInvoiceId) {
      toast.error('Please save the invoice first');
      return;
    }
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`${process.env.REACT_APP_BACKEND_URL}/api/orders/${editInvoiceId}/collection-note`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      if (!response.ok) throw new Error('Failed to generate PDF');
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `collection_note_${invoiceData.invoiceNo}.pdf`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      toast.success('Collection Note downloaded');
    } catch (err) {
      toast.error('Failed to download Collection Note');
    }
  };

  // Download Delivery Note PDF
  const handleDownloadDeliveryNote = async () => {
    if (!editInvoiceId) {
      toast.error('Please save the invoice first');
      return;
    }
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`${process.env.REACT_APP_BACKEND_URL}/api/orders/${editInvoiceId}/delivery-note`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      if (!response.ok) throw new Error('Failed to generate PDF');
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `delivery_note_${invoiceData.invoiceNo}.pdf`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      toast.success('Delivery Note downloaded');
    } catch (err) {
      toast.error('Failed to download Delivery Note');
    }
  };

  // Save invoice and update stock
  const handleSaveInvoice = async () => {
    // Name and Phone are optional for Invoice - only validate format if provided
    if (invoiceData.customerPhone && invoiceData.customerPhone.trim()) {
      const phoneDigits = invoiceData.customerPhone.replace(/\D/g, '');
      if (phoneDigits.length < 10) {
        toast.error('Phone number must be at least 10 digits. Please enter a valid UK phone number.');
        return;
      }
    }
    
    // Validate email has valid format (only if provided)
    if (invoiceData.customerEmail && invoiceData.customerEmail.trim()) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(invoiceData.customerEmail.trim())) {
        toast.error('Please enter a valid email address.');
        return;
      }
    }
    
    // Validate at least one payment with AMOUNT is required - BEFORE PIN dialog
    const hasValidPayment = invoiceData.deposits.some(d => d.amount && parseFloat(d.amount) > 0);
    
    if (!hasValidPayment) {
      toast.error('At least one payment with amount is required. Please enter the payment amount in "Payments Received" section.');
      return;
    }
    
    // Validate each deposit entry - if date is filled, amount must also be filled
    for (let i = 0; i < invoiceData.deposits.length; i++) {
      const deposit = invoiceData.deposits[i];
      // Skip empty rows (no date and no amount)
      if (!deposit.date && (!deposit.amount || parseFloat(deposit.amount) <= 0)) {
        continue;
      }
      // If date is filled but amount is empty, show error
      if (deposit.date && (!deposit.amount || parseFloat(deposit.amount) <= 0)) {
        toast.error(`Amount is required for payment entry ${i + 1}. Please enter an amount or remove the entry.`);
        return;
      }
    }
    
    // Validate EVERY payment with amount has a payment METHOD selected
    // This is critical - payment method is mandatory for ALL payments
    for (let i = 0; i < invoiceData.deposits.length; i++) {
      const deposit = invoiceData.deposits[i];
      const amount = parseFloat(deposit.amount) || 0;
      
      // If payment has an amount, it MUST have a method
      if (amount > 0) {
        const hasMethod = deposit.method && deposit.method.trim() !== '';
        if (!hasMethod) {
          toast.error(`Please select a Payment Method for payment entry ${i + 1} (£${amount.toFixed(2)})`);
          return;
        }
      }
    }
    
    // Double-check: at least one payment has both amount AND method
    const completePayments = invoiceData.deposits?.filter(d => 
      d.amount && parseFloat(d.amount) > 0 && d.method && d.method.trim() !== ''
    );
    
    if (!completePayments || completePayments.length === 0) {
      toast.error('Please select a Payment Method for each payment in the "Payments Received" section.');
      return;
    }
    
    if (!invoiceData.orderType || !invoiceData.orderType.trim()) {
      toast.error('Order type is required');
      return;
    }
    
    // Check if staff PIN is required
    if (!verifiedStaff) {
      setShowPinDialog(true);
      return;
    }
    
    await proceedWithSave();
  };

  // Verify staff PIN
  const handleVerifyPin = async () => {
    if (!staffPin || staffPin.length < 4) {
      toast.error('Please enter a valid PIN');
      return;
    }
    
    setVerifyingPin(true);
    try {
      const verifiedPin = staffPin; // Store PIN before clearing
      const res = await api.verifyStaffPin(staffPin);
      // Map the response to use staff_name
      const staffData = {
        ...res.data,
        staff_name: res.data.name || res.data.staff_name
      };
      setVerifiedStaff(staffData);
      setShowPinDialog(false);
      setStaffPin('');
      toast.success(`PIN verified: ${staffData.staff_name}`);
      
      // Proceed with save after PIN verification, passing the PIN
      await proceedWithSave(staffData, verifiedPin);
    } catch (error) {
      toast.error('Invalid PIN. Please try again.');
      setStaffPin('');
    } finally {
      setVerifyingPin(false);
    }
  };

  // Clear verified staff (for new invoices)
  const clearVerifiedStaff = () => {
    setVerifiedStaff(null);
  };

  // Actual save logic
  const proceedWithSave = async (staffData = verifiedStaff, pinUsed = null) => {
    // Validate showroom is locked for non-super-admin users
    if (!canFreelySwitchStores && !showroomLocked && !user?.showroom_id) {
      toast.error('Please lock a showroom before saving invoice. Select a showroom and verify with PIN.');
      setPendingStoreId(selectedStore?.id);
      setShowStorePinDialog(true);
      return;
    }
    
    // Validate sales person - must have PIN verification
    if (!staffData?.staff_name) {
      toast.error('Staff PIN verification is required to save. Please enter your PIN.');
      setShowStorePinDialog(true);
      return;
    }

    // Note: Payment amount validation is now done in handleSaveInvoice() BEFORE PIN dialog

    // Validate line items have products and quantities
    // Allow items with either productId (selected from list) OR product name (manual entry)
    const validItems = invoiceData.lineItems.filter(item => 
      (item.productId || (item.product && item.product.trim())) && item.qty && parseFloat(item.qty) > 0
    );
    
    if (validItems.length === 0) {
      toast.error('Please add at least one product with quantity');
      return;
    }

    // Show warning if stock is low/zero but allow saving (only for items with productId)
    for (const item of validItems) {
      const qty = parseFloat(item.qty) || 0;
      if (item.productId && item.stock && qty > item.stock) {
        toast.warning(`Low stock warning: ${item.product} (Available: ${item.stock}, Requested: ${qty})`);
      }
    }

    // Calculate totals to check for outstanding amount
    const currentTotals = calculateTotals();
    
    // Validate phone number format (if provided)
    if (invoiceData.customerPhone && invoiceData.customerPhone.trim()) {
      const phoneDigits = invoiceData.customerPhone.replace(/\D/g, ''); // Remove non-digits
      if (phoneDigits.length < 10) {
        toast.error('Phone number must be at least 10 digits. Please enter a valid UK phone number.');
        return;
      }
    }
    
    // Validate customer details only for Deposit Orders (deposits taken but still outstanding)
    const isDepositOrder = currentTotals.totalDeposits > 0 && currentTotals.amountOutstanding > 0;
    if (isDepositOrder) {
      if (!invoiceData.customerName || !invoiceData.customerName.trim()) {
        toast.error('Customer Name is required for Deposit Orders (outstanding amount to be paid).');
        return;
      }
      if (!invoiceData.customerPhone || !invoiceData.customerPhone.trim()) {
        toast.error('Customer Phone is required for Deposit Orders (outstanding amount to be paid).');
        return;
      }
    }

    setSaving(true);
    try {
      const totals = calculateTotals();
      
      // Extract payment methods from deposits for backward compatibility
      const depositsWithPayment = invoiceData.deposits
        .filter(d => d.amount && parseFloat(d.amount) > 0)
        .map(d => ({
          method: d.method || '', // Only use method field, not note
          amount: parseFloat(d.amount) || 0
        }));
      
      // For backward compatibility, save the primary payment method
      const primaryPaymentMethod = depositsWithPayment.length > 0 
        ? depositsWithPayment[0].method 
        : '';
      
      // Save invoice with staff PIN if verified
      const invoicePayload = {
        invoice_no: invoiceData.invoiceNo,
        date: invoiceData.date,
        time: invoiceData.time,
        customer_name: invoiceData.customerName,
        customer_phone: invoiceData.customerPhone,
        customer_email: invoiceData.customerEmail,
        customer_address: invoiceData.customerAddress,
        notes: invoiceData.notes,
        sales_person: staffData?.staff_name,
        payment_method: primaryPaymentMethod,
        payment_methods: depositsWithPayment,
        apply_vat: applyVat, // Save VAT setting - false for cash quotation conversions
        order_type: invoiceData.orderType,
        showroom_id: selectedStore?.id || null,
        showroom_name: selectedStore?.name || null,
        deposits: invoiceData.deposits
          .filter(d => d.amount && parseFloat(d.amount) > 0)
          .map(d => ({
            date: d.date,
            amount: parseFloat(d.amount),
            method: d.method || '', // Only use method field, not note
            note: d.customNote || ''
          })),
        line_items: validItems.map(item => {
          const calc = calculateLineTotal(item);
          return {
            product_id: item.productId,
            product_name: item.product,
            sku: item.sku,
            quantity: parseFloat(item.qty),
            m2: parseFloat(item.m2) || 0,
            price: parseFloat(item.price),
            due_price: calc.duePrice,
            total: calc.due,
            discount: parseFloat(item.discount) || 0
          };
        }),
        subtotal: totals.totalDue,
        vat: totals.vat,
        gross_total: totals.grossTotal,
        total_savings: totals.totalSavings,
        // Trade-credit redemption — backend deducts atomically and logs a
        // `redeemed_in_store` credit transaction. Treated as a payment line
        // (not a discount), so VAT/gross_total stay unaffected.
        credit_redeemed_amount: parseFloat(invoiceData.creditRedeemedAmount) || 0,
        credit_redeemed_account: invoiceData.creditRedeemedAccount || null,
        // Cross-channel link — when present, the customer was picked from
        // their online account so this in-store invoice will appear in their
        // shop "My Orders" page and contribute to the unified trade-spend
        // total.
        linked_shop_customer_id: invoiceData.linkedShopCustomerId || null,
        linked_trade_account_number: invoiceData.linkedTradeAccountNumber || null,
        linked_business_name: invoiceData.linkedBusinessName || null,
        staff_pin: staffData ? (pinUsed || staffPin || invoiceData.staffPin) : null
      };

      let result;
      if (editMode && editInvoiceId) {
        // Update existing invoice
        result = await api.updateInvoice(editInvoiceId, invoicePayload);
        toast.success(`Invoice updated by ${result.data.staff_name || 'Admin'}!`);
        
        // Show email dialog for updates if customer has email (only if email is enabled)
        if (EMAIL_CONFIG.EMAIL_ENABLED && invoiceData.customerEmail && invoiceData.customerEmail.trim()) {
          savedInvoiceIdRef.current = editInvoiceId; // Set ref immediately
          setSavedInvoiceId(editInvoiceId);
          setShowEmailDialog(true);
        }
      } else {
        // Create new invoice
        result = await api.saveInvoice(invoicePayload);
        
        // If this was from a cash quotation, mark it as converted NOW (after invoice saved successfully)
        if (pendingCashQuotationId) {
          console.log('[Invoice] Invoice saved successfully, now marking cash quotation as converted...');
          console.log('[Invoice] pendingCashQuotationId:', pendingCashQuotationId);
          try {
            const convertResult = await api.convertCashQuotationToInvoice(pendingCashQuotationId);
            console.log('[Invoice] Cash quotation conversion API response:', convertResult);
            console.log('[Invoice] Cash quotation marked as converted:', pendingCashQuotationId);
            toast.success('Invoice saved & Cash Quotation marked as converted!');
            setPendingCashQuotationId(null); // Clear after successful conversion
          } catch (conversionError) {
            console.error('[Invoice] Failed to mark cash quotation as converted:', conversionError);
            console.error('[Invoice] Conversion error details:', conversionError.response?.data);
            toast.warning('Invoice saved but failed to mark quotation as converted. Please check Cash Quote History.');
            // Don't fail the whole operation - invoice was saved, quotation conversion is secondary
          }
        } else {
          console.log('[Invoice] No pendingCashQuotationId - this is a regular invoice');
          
          // If this was from a REGULAR quotation, mark it as converted NOW (after invoice saved successfully)
          if (pendingQuotationId) {
            console.log('[Invoice] Invoice saved, now marking regular quotation as converted:', pendingQuotationId);
            try {
              const newInvoiceId = result.data.invoice_id || result.data.id;
              await api.convertQuotationToInvoice(pendingQuotationId, newInvoiceId);
              console.log('[Invoice] Regular quotation marked as converted:', pendingQuotationId, '→ invoice', newInvoiceId);
              toast.success('Invoice saved & Quotation marked as converted!');
              setPendingQuotationId(null);
            } catch (conversionError) {
              console.error('[Invoice] Failed to mark quotation as converted:', conversionError);
              toast.warning('Invoice saved but failed to mark quotation as converted. Please check Quote History.');
              // Don't fail — invoice was saved, quotation conversion is secondary
            }
          } else {
            // Show loyalty points message if earned (only for regular invoices, not from quote)
            if (result.data.loyalty_points_earned && result.data.loyalty_points_earned > 0) {
              toast.success(`Invoice saved! ${result.data.loyalty_points_earned} loyalty points awarded to customer.`, { duration: 5000 });
            } else {
              toast.success(`Invoice saved by ${result.data.staff_name || 'Admin'}! Stock updated.`);
            }
          }
        }
        
        // Enable edit mode and store invoice ID so Print button becomes available
        // Backend returns invoice_id, not id
        const newInvoiceId = result.data.invoice_id || result.data.id;
        setEditInvoiceId(newInvoiceId);
        setEditMode(true);
        
        // Show email dialog for new invoices if customer has email (only if email is enabled)
        if (EMAIL_CONFIG.EMAIL_ENABLED && invoiceData.customerEmail && invoiceData.customerEmail.trim()) {
          savedInvoiceIdRef.current = newInvoiceId; // Set ref immediately
          setSavedInvoiceId(newInvoiceId);
          setShowEmailDialog(true);
        }
      }
      
      // Mark as saved (no unsaved changes)
      setHasUnsavedChanges(false);
      setJustSaved(true); // Prevent useEffect from resetting unsaved state
      
      // Refresh products to get updated stock
      const productsRes = await api.getProducts();
      setProducts(productsRes.data);
      
      // Update line items with new stock values
      const newItems = invoiceData.lineItems.map(item => {
        if (item.productId) {
          const updatedProduct = productsRes.data.find(p => p.id === item.productId);
          if (updatedProduct) {
            return { ...item, stock: updatedProduct.stock };
          }
        }
        return item;
      });
      setInvoiceData({ ...invoiceData, lineItems: newItems });
      
      // Trigger cross-page data sync for Dashboard and Invoice History
      // localStorage triggers 'storage' event in OTHER tabs
      localStorage.setItem('dataSync', Date.now().toString());
      // Custom event triggers in SAME tab (for components already mounted)
      window.dispatchEvent(new CustomEvent('dataSync'));
      
    } catch (error) {
      // Handle Pydantic validation errors (array of objects) or string messages
      const detail = error.response?.data?.detail;
      let errorMessage = 'Failed to save invoice';
      if (typeof detail === 'string') {
        errorMessage = detail;
      } else if (Array.isArray(detail) && detail.length > 0) {
        // Pydantic validation error - extract the first message
        errorMessage = detail[0]?.msg || detail[0]?.message || 'Validation error';
      } else if (detail?.msg) {
        errorMessage = detail.msg;
      }
      toast.error(errorMessage);
    } finally {
      setSaving(false);
    }
  };

  // Reset invoice for new entry - internal function
  const performNewInvoice = () => {
    setInvoiceData({
      invoiceNo: `INV-${Date.now().toString().slice(-6)}`,
      date: new Date().toLocaleDateString('en-GB'),
      time: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      customerName: '',
      customerPhone: '',
      customerAddress: '',
      customerEmail: '',
      linkedShopCustomerId: null,
      linkedTradeAccountNumber: null,
      linkedBusinessName: null,
      linkedTradeTier: null,
      linkedTradeDiscount: null,
      notes: '',
      salesPerson: '',
      orderType: 'Store Order',
      deposits: [{ date: new Date().toLocaleDateString('en-GB'), amount: '', method: '', note: '' }],
      lineItems: [{ ...emptyLineItem }],
      companyInfo: { ...defaultCompanyInfo },
      termsAndConditions: defaultTerms
    });
    // Clear verified staff and edit mode for new invoice
    setVerifiedStaff(null);
    setEditMode(false);
    setEditInvoiceId(null);
    setHasUnsavedChanges(false);
    // Reset Cash Quotation conversion flag (allow all payment methods for normal invoices)
    setIsFromCashQuotation(false);
    setApplyVat(true);
    toast.success('New invoice created');
  };

  // Public handler that checks for unsaved changes first
  const handleNewInvoice = () => {
    if (hasUnsavedChanges) {
      setPendingAction('new');
      setShowUnsavedDialog(true);
    } else {
      performNewInvoice();
    }
  };

  // Handler for History button
  const handleGoToHistory = () => {
    if (hasUnsavedChanges) {
      setPendingAction('history');
      setShowUnsavedDialog(true);
    } else {
      navigate('/admin/invoice-history');
    }
  };

  const totals = calculateTotals();

  if (loading) {
    return <div className="flex items-center justify-center h-64">Loading products...</div>;
  }

  return (
    <div className="space-y-4 md:space-y-6" data-testid="invoice-page">
      <div className="flex flex-col gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2 md:gap-3 mb-2">
            {editMode && (
              <Button variant="ghost" size="sm" onClick={handleGoToHistory} className="h-8 px-2">
                <ArrowLeft className="h-4 w-4 mr-1" />
                Back
              </Button>
            )}
            <h1 className="text-2xl md:text-4xl font-heading font-bold tracking-tightest">
              {refundMode ? 'Process Refund' : (editMode ? 'Edit Invoice' : 'Invoice')}
            </h1>
            {editMode && !refundMode && (
              <span className="px-2 md:px-3 py-1 bg-amber-100 text-amber-800 rounded-full text-xs md:text-sm font-medium">
                {invoiceData.invoiceNo}
              </span>
            )}
            {refundMode && (
              <span className="px-2 py-1 bg-orange-100 text-orange-800 rounded-full text-xs font-medium flex items-center gap-1">
                <RotateCcw className="h-3 w-3" />
                Refund
              </span>
            )}
            {/* Saved/Unsaved Changes Indicator */}
            {!refundMode && (
              hasUnsavedChanges ? (
                <span className="px-2 py-1 bg-orange-100 text-orange-800 rounded text-xs font-medium flex items-center gap-1">
                  <span className="w-2 h-2 bg-orange-500 rounded-full animate-pulse"></span>
                  Unsaved
                </span>
              ) : checkHasData() ? (
                <span className="px-2 py-1 bg-green-100 text-green-800 rounded text-xs font-medium flex items-center gap-1">
                  <Check className="h-3 w-3" />
                  Saved
                </span>
              ) : null
            )}
          </div>
          <p className="text-sm text-muted-foreground hidden md:block">
            {refundMode 
              ? 'Select items to refund, choose refund type, and process the refund'
              : (editMode ? 'Update invoice details and save changes' : 'Create and print professional invoices with synced products')
            }
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Refund Mode Toggle - Only show in edit mode */}
          {editMode && !refundMode && (
            <Button 
              variant="outline" 
              size="sm"
              className="text-orange-600 border-orange-200 hover:bg-orange-50 h-8"
              onClick={toggleRefundMode}
              data-testid="refund-mode-btn"
            >
              <RotateCcw className="h-4 w-4 mr-1 md:mr-2" />
              <span className="hidden sm:inline">Refund</span>
            </Button>
          )}
          {refundMode && (
            <Button 
              variant="outline"
              size="sm"
              onClick={toggleRefundMode}
              className="h-8"
              data-testid="exit-refund-mode-btn"
            >
              <ArrowLeft className="h-4 w-4 mr-1" />
              <span className="hidden sm:inline">Exit Refund</span>
            </Button>
          )}
          {/* Verified Staff Indicator */}
          {verifiedStaff && (
            <div className="flex items-center gap-1 md:gap-2 px-2 md:px-3 py-1 md:py-1.5 bg-green-100 text-green-800 rounded-full text-xs md:text-sm" data-testid="verified-staff-indicator">
              <CheckCircle className="h-3 w-3 md:h-4 md:w-4" />
              <span className="font-medium truncate max-w-[80px] md:max-w-none">{verifiedStaff.staff_name}</span>
              <button 
                onClick={clearVerifiedStaff}
                className="ml-1 hover:text-green-600"
                title="Clear verified staff"
              >
                ×
              </button>
            </div>
          )}
          <Button variant="outline" onClick={handleGoToHistory} data-testid="view-history-btn">
            <History className="h-4 w-4 mr-2" />
            History
          </Button>
          <Button variant="outline" onClick={handleNewInvoice}>
            <Plus className="h-4 w-4 mr-2" />
            New Invoice
          </Button>
          <Button 
            variant="outline" 
            onClick={() => window.open('/admin/invoice', '_blank')}
            title="Open new invoice in separate tab"
            data-testid="open-invoice-new-tab-btn"
          >
            <ExternalLink className="h-4 w-4" />
          </Button>
          {invoiceData.orderType === 'Special Order' && editInvoiceId && (
            <>
              <Button variant="outline" onClick={handleDownloadCollectionNote} data-testid="collection-note-btn">
                <ClipboardList className="h-4 w-4 mr-2" />
                Collection Note
              </Button>
              <Button variant="outline" onClick={handleDownloadDeliveryNote} data-testid="delivery-note-btn">
                <Truck className="h-4 w-4 mr-2" />
                Delivery Note
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Store Change PIN Dialog */}
      <Dialog open={showStorePinDialog} onOpenChange={setShowStorePinDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock className="h-5 w-5 text-primary" />
              {showroomLocked ? 'PIN Required to Change Store' : 'PIN Required to Lock Store'}
            </DialogTitle>
            <DialogDescription>
              {showroomLocked 
                ? 'The showroom is locked for today. Enter your staff PIN to change it.'
                : 'Enter your staff PIN to confirm and lock this showroom for today.'}
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className={`border rounded-lg p-3 text-sm ${showroomLocked ? 'bg-amber-50 border-amber-200' : 'bg-blue-50 border-blue-200'}`}>
              {showroomLocked ? (
                <>
                  <p className="text-amber-800 mb-2">
                    Current: <strong>{selectedStore?.name}</strong>
                  </p>
                  <div>
                    <label className="text-xs text-amber-700">Change to:</label>
                    <select
                      className="w-full mt-1 px-3 py-2 border border-amber-300 rounded-md text-sm"
                      value={pendingStoreId || ''}
                      onChange={(e) => setPendingStoreId(e.target.value)}
                    >
                      <option value="">-- Select showroom --</option>
                      {showrooms.filter(s => s.id !== selectedStore?.id).map(showroom => (
                        <option key={showroom.id} value={showroom.id}>{showroom.name}</option>
                      ))}
                    </select>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-blue-800">
                    Store: <strong>{showrooms.find(s => s.id === pendingStoreId)?.name}</strong>
                  </p>
                  <p className="text-blue-600 text-xs mt-1">
                    Lock your store for today.
                  </p>
                </>
              )}
            </div>
            <div>
              <label className="text-sm font-medium">Enter PIN</label>
              <Input
                type="password"
                value={showroomPin}
                onChange={(e) => setStorePin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="Enter 4-6 digit PIN"
                maxLength={6}
                className="text-center text-2xl tracking-widest"
                onKeyPress={(e) => e.key === 'Enter' && handleStorePinVerify()}
                autoFocus
                data-testid="showroom-pin-input"
              />
            </div>
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={() => { 
              setShowStorePinDialog(false); 
              setStorePin(''); 
              setPendingStoreId(null);
            }}>
              Cancel
            </Button>
            <Button 
              onClick={handleStorePinVerify} 
              disabled={verifyingPin || showroomPin.length < 4 || (showroomLocked && !pendingStoreId)}
              data-testid="verify-showroom-pin-btn"
            >
              {verifyingPin ? 'Verifying...' : (showroomLocked ? 'Verify & Change' : 'Verify & Lock')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Staff PIN Verification Dialog */}
      <Dialog open={showPinDialog} onOpenChange={(open) => {
        setShowPinDialog(open);
        if (!open) setStaffPin(''); // Clear PIN when dialog closes
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock className="h-5 w-5 text-primary" />
              Staff PIN Required
            </DialogTitle>
            <DialogDescription>
              Enter your confidential PIN to save this invoice. This ensures accountability for all transactions.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div>
              <label className="text-sm font-medium">Enter PIN</label>
              <Input
                type="password"
                value={staffPin}
                onChange={(e) => setStaffPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="Enter 4-6 digit PIN"
                maxLength={6}
                className="text-center text-2xl tracking-widest"
                onKeyPress={(e) => e.key === 'Enter' && handleVerifyPin()}
                autoFocus
                autoComplete="off"
                data-testid="pin-input"
              />
            </div>
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowPinDialog(false); setStaffPin(''); }}>
              Cancel
            </Button>
            <Button onClick={handleVerifyPin} disabled={verifyingPin || staffPin.length < 4} data-testid="verify-pin-btn">
              {verifyingPin ? 'Verifying...' : 'Verify & Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Unsaved Changes Warning Dialog */}
      <Dialog open={showUnsavedDialog} onOpenChange={setShowUnsavedDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-orange-600">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              Unsaved Invoice
            </DialogTitle>
            <DialogDescription>
              You have unsaved changes on this invoice. You must save the invoice before {
                pendingAction === 'new' ? 'creating a new one' : 
                pendingAction === 'history' ? 'viewing invoice history' : 
                'leaving this page'
              }.
            </DialogDescription>
          </DialogHeader>
          
          <div className="py-4">
            <div className="bg-orange-50 border border-orange-200 rounded-lg p-4 text-sm">
              <p className="font-medium text-orange-800 mb-2">Current Invoice: {invoiceData.invoiceNo}</p>
              <ul className="text-orange-700 space-y-1">
                {invoiceData.customerName && <li>• Customer: {invoiceData.customerName}</li>}
                {invoiceData.lineItems.filter(i => i.product).length > 0 && (
                  <li>• Items: {invoiceData.lineItems.filter(i => i.product).length} product(s)</li>
                )}
                {totals.grossTotal > 0 && <li>• Total: £{totals.grossTotal.toFixed(2)}</li>}
              </ul>
            </div>
          </div>
          
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={cancelDiscard} className="w-full sm:w-auto">
              Go Back & Save
            </Button>
            <Button 
              variant="destructive" 
              onClick={confirmDiscardChanges}
              className="w-full sm:w-auto"
              data-testid="discard-changes-btn"
            >
              Discard Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Discount Authorization Dialog */}
      <Dialog open={showDiscountAuthDialog} onOpenChange={(open) => {
        if (!open) {
          setShowDiscountAuthDialog(false);
          setDiscountAuthPin('');
          setPendingDiscountLineIndex(null);
          setPendingDiscountValue(null);
        }
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-600">
              <Lock className="h-5 w-5" />
              Authorization Required
            </DialogTitle>
            <DialogDescription>
              The discount you&apos;re trying to apply exceeds the maximum allowed ({invoiceData.lineItems[pendingDiscountLineIndex]?.max_discount}%).
              A manager or admin must authorize this discount.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-4">
              <div className="text-sm text-amber-800">
                <p className="font-medium">Discount Details:</p>
                <p>• Product: {invoiceData.lineItems[pendingDiscountLineIndex]?.product}</p>
                <p>• Original Price: £{parseFloat(invoiceData.lineItems[pendingDiscountLineIndex]?.price || 0).toFixed(2)}</p>
                <p>• Requested Price: £{parseFloat(pendingDiscountValue || 0).toFixed(2)}</p>
                <p>• Max Allowed: {invoiceData.lineItems[pendingDiscountLineIndex]?.max_discount}% off</p>
              </div>
            </div>
            <label className="text-sm font-medium">Manager/Admin PIN</label>
            <Input
              type="password"
              placeholder="Enter authorization PIN"
              value={discountAuthPin}
              onChange={(e) => setDiscountAuthPin(e.target.value)}
              className="mt-2"
              data-testid="discount-auth-pin-input"
              maxLength={6}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setShowDiscountAuthDialog(false);
              setDiscountAuthPin('');
              setPendingDiscountLineIndex(null);
              setPendingDiscountValue(null);
            }}>
              Cancel
            </Button>
            <Button 
              onClick={handleDiscountAuthorization}
              disabled={verifyingDiscountAuth || !discountAuthPin}
              className="bg-amber-600 hover:bg-amber-700"
            >
              {verifyingDiscountAuth ? 'Verifying...' : 'Authorize Discount'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Refund Confirmation Dialog */}
      <Dialog open={showRefundConfirmDialog} onOpenChange={setShowRefundConfirmDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-orange-700">
              <RotateCcw className="h-5 w-5" />
              Confirm Refund
            </DialogTitle>
            <DialogDescription>
              Please review the refund details before processing.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="bg-orange-50 p-4 rounded-lg space-y-2">
              <div className="flex justify-between">
                <span className="text-sm text-muted-foreground">Invoice:</span>
                <span className="font-medium">{invoiceData.invoiceNo}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-muted-foreground">Customer:</span>
                <span className="font-medium">{invoiceData.customerName || 'N/A'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-muted-foreground">Refund Type:</span>
                <span className="font-medium capitalize">{refundType} Refund</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-muted-foreground">Items:</span>
                <span className="font-medium">{getSelectedItemsCount()} selected</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-muted-foreground">Refund Method:</span>
                <span className="font-medium">{refundMethod}</span>
              </div>
              <div className="border-t pt-2 mt-2">
                <div className="flex justify-between">
                  <span className="text-sm text-muted-foreground">Subtotal:</span>
                  <span className="font-medium">£{calculateRefundTotal().toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-muted-foreground">VAT (20%):</span>
                  <span className="font-medium">£{(calculateRefundTotal() * 0.2).toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-lg font-bold text-orange-700 mt-1">
                  <span>Total Refund:</span>
                  <span>£{(calculateRefundTotal() * 1.2).toFixed(2)}</span>
                </div>
              </div>
            </div>
            {refundReason && (
              <div>
                <span className="text-sm text-muted-foreground">Reason:</span>
                <p className="text-sm mt-1">{refundReason}</p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRefundConfirmDialog(false)}>
              Cancel
            </Button>
            <Button 
              className="bg-orange-600 hover:bg-orange-700"
              onClick={processRefund}
              disabled={processingRefund}
            >
              {processingRefund ? 'Processing...' : 'Confirm Refund'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Email Confirmation Dialog */}
      <Dialog open={showEmailDialog} onOpenChange={setShowEmailDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-blue-600">
              <Mail className="h-5 w-5" />
              Send Invoice Email
            </DialogTitle>
            <DialogDescription>
              Would you like to send this invoice to the customer via email?
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <div className="bg-blue-50 rounded-lg p-4 space-y-2">
              <p className="text-sm text-gray-600">
                <span className="font-medium">To:</span> {invoiceData.customerEmail}
              </p>
              {invoiceData.customerName && (
                <p className="text-sm text-gray-600">
                  <span className="font-medium">Customer:</span> {invoiceData.customerName}
                </p>
              )}
              <p className="text-sm text-gray-600">
                <span className="font-medium">Invoice:</span> {invoiceData.invoiceNo}
              </p>
            </div>
          </div>
          <DialogFooter className="flex gap-2">
            <Button 
              variant="outline" 
              onClick={() => setShowEmailDialog(false)}
              disabled={sendingEmail}
            >
              No, Skip
            </Button>
            <Button 
              onClick={handleSendEmail}
              disabled={sendingEmail}
              className="bg-blue-600 hover:bg-blue-700"
            >
              {sendingEmail ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Sending...
                </>
              ) : (
                <>
                  <Mail className="h-4 w-4 mr-2" />
                  Yes, Send Email
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Editable Invoice Form */}
      <Card className="p-6">
        <div className="grid md:grid-cols-2 gap-6 mb-6">
          {/* Invoice Details */}
          <div className="space-y-4">
            <h3 className="font-semibold text-lg">Invoice Details</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm text-muted-foreground flex items-center gap-2">
                  Store <span className="text-red-500">*</span>
                  {!canFreelySwitchStores && showroomLocked && (
                    <span className="inline-flex items-center text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">
                      <Lock className="h-3 w-3 mr-1" />
                      {user?.showroom_id ? 'Your showroom' : 'Locked for today'}
                    </span>
                  )}
                </label>
                <div className="relative">
                  {/* If user is assigned to a specific showroom, show as read-only */}
                  {user?.showroom_id ? (
                    <div className="w-full px-3 py-2 border rounded-md bg-gray-50 flex items-center justify-between">
                      <span>{selectedStore?.name || 'Loading...'}</span>
                      <Lock className="h-4 w-4 text-green-600" />
                    </div>
                  ) : (
                    <>
                      <select
                        className={`w-full px-3 py-2 border rounded-md ${!canFreelySwitchStores && showroomLocked ? 'pr-10 bg-gray-100' : ''}`}
                        value={selectedStore?.id || ''}
                        onChange={(e) => handleStoreChange(e.target.value)}
                        disabled={!canFreelySwitchStores && showroomLocked}
                        data-testid="showroom-select"
                      >
                        {showrooms.map(showroom => (
                          <option key={showroom.id} value={showroom.id}>{showroom.name}</option>
                        ))}
                      </select>
                      {!canFreelySwitchStores && showroomLocked && (
                        <div className="flex items-center gap-1 mt-1">
                          <Lock className="h-3 w-3 text-green-600" />
                          <span className="text-xs text-green-600">Locked for today</span>
                          <button
                            type="button"
                            onClick={() => setShowStorePinDialog(true)}
                            className="ml-2 text-xs text-blue-600 hover:underline"
                          >
                            Change (PIN required)
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
                {!canFreelySwitchStores && !showroomLocked && !user?.showroom_id && (
                  <p className="text-xs text-muted-foreground mt-1">Lock your store for today</p>
                )}
              </div>
              <div>
                <label className="text-sm text-muted-foreground">Invoice No.</label>
                <Input
                  value={invoiceData.invoiceNo}
                  onChange={(e) => setInvoiceData({ ...invoiceData, invoiceNo: e.target.value })}
                />
              </div>
              <div>
                <label className="text-sm text-muted-foreground">Date</label>
                <Input
                  value={invoiceData.date}
                  onChange={(e) => {
                    const newDate = e.target.value;
                    setInvoiceData(prev => {
                      const oldDate = prev.date;
                      // Sync any deposit date that still matches the invoice's previous date
                      // so a manual backdate propagates to the payment. Deposits that were
                      // intentionally set to a different date are left alone.
                      const syncedDeposits = (prev.deposits || []).map(dep =>
                        (!dep.date || dep.date === oldDate) ? { ...dep, date: newDate } : dep
                      );
                      return { ...prev, date: newDate, deposits: syncedDeposits };
                    });
                  }}
                  data-testid="invoice-date-input"
                />
              </div>
              <div>
                <label className="text-sm text-muted-foreground">Time</label>
                <Input
                  value={invoiceData.time}
                  onChange={(e) => setInvoiceData({ ...invoiceData, time: e.target.value })}
                />
              </div>
              <div>
                <label className="text-sm text-muted-foreground">Order Type <span className="text-red-500">*</span></label>
                <select
                  className="w-full px-3 py-2 border rounded-md"
                  value={invoiceData.orderType}
                  onChange={(e) => setInvoiceData({ ...invoiceData, orderType: e.target.value })}
                  required
                  data-testid="order-type-select"
                >
                  <option value="">Select Order Type</option>
                  {orderTypes.map(type => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Customer Details */}
          <div className="space-y-4">
            <CustomerDetailsSection
              name={invoiceData.customerName}
              phone={invoiceData.customerPhone}
              email={invoiceData.customerEmail}
              address={invoiceData.customerAddress}
              onNameChange={(val) => setInvoiceData({ ...invoiceData, customerName: val })}
              onPhoneChange={(val) => setInvoiceData({ ...invoiceData, customerPhone: val })}
              onEmailChange={(val) => setInvoiceData({ ...invoiceData, customerEmail: val })}
              onAddressChange={(val) => setInvoiceData({ ...invoiceData, customerAddress: val })}
              onSelectCustomer={(customer) => {
                setInvoiceData(prev => ({
                  ...prev,
                  customerName: customer.name || '',
                  customerPhone: customer.phone || '',
                  customerEmail: customer.email || '',
                  customerAddress: customer.address || '',
                  // Link to online account if this came from shop_customers,
                  // so the invoice doc is stamped with linked_shop_customer_id
                  // + trade fields. Cleared if not an online pick.
                  linkedShopCustomerId: customer.shop_customer_id || null,
                  linkedTradeAccountNumber: customer.trade_account_number || null,
                  linkedBusinessName: customer.business_name || null,
                  linkedTradeTier: customer.trade_tier || null,
                  linkedTradeDiscount: typeof customer.trade_discount === 'number' ? customer.trade_discount : null,
                }));
              }}
              onClear={() => {
                setInvoiceData(prev => ({
                  ...prev,
                  customerName: '',
                  customerPhone: '',
                  customerEmail: '',
                  customerAddress: '',
                  linkedShopCustomerId: null,
                  linkedTradeAccountNumber: null,
                  linkedBusinessName: null,
                  linkedTradeTier: null,
                  linkedTradeDiscount: null,
                }));
              }}
              nameRequired={totals.totalDeposits > 0 && totals.amountOutstanding > 0}
              phoneRequired={totals.totalDeposits > 0 && totals.amountOutstanding > 0}
              emailRequired={false}
              toTitleCase={toTitleCase}
            />

            {/* Linked online account indicator */}
            {invoiceData.linkedShopCustomerId && (
              <div
                className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 mt-2 flex items-center justify-between gap-2 flex-wrap"
                data-testid="linked-online-account-chip"
              >
                <div className="text-xs text-sky-900">
                  <span className="inline-flex items-center text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-sky-200 text-sky-900 mr-1.5">🌐 Online</span>
                  This invoice will appear in <strong>{invoiceData.customerName || 'their'}</strong>'s online order history
                  {invoiceData.linkedTradeAccountNumber && (
                    <> · trade account <strong>{invoiceData.linkedTradeAccountNumber}</strong></>
                  )}
                  {invoiceData.linkedBusinessName && (
                    <> · {invoiceData.linkedBusinessName}</>
                  )}
                  {/* Tier label hidden 29-Apr-2026 per user request — re-enable when loyalty/tier launch is ready
                  {invoiceData.linkedTradeTier && invoiceData.linkedTradeDiscount > 0 && (
                    <> · <strong className="text-emerald-700">{toTitleCase(invoiceData.linkedTradeTier)} -{invoiceData.linkedTradeDiscount}%</strong></>
                  )}
                  */}
                  .
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {/* Opt-in "Apply trade pricing" button — gated by the
                      super-admin feature flag so it stays invisible until
                      explicitly enabled in Trade Accounts → EPOS Settings.
                      Only fires when the linked customer has a real trade
                      discount %. */}
                  {eposFeatureFlags.trade_pricing_apply_button
                    && invoiceData.linkedTradeDiscount > 0
                    && invoiceData.lineItems.some(li => li.productId) && (
                    <button
                      type="button"
                      className="text-[11px] font-medium px-2 py-1 rounded border border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
                      onClick={() => {
                        const pct = parseFloat(invoiceData.linkedTradeDiscount) || 0;
                        if (pct <= 0) return;
                        let appliedCount = 0;
                        let cappedCount = 0;
                        const newItems = invoiceData.lineItems.map(item => {
                          if (!item.productId || !item.price) return item;
                          const original = parseFloat(item.price) || 0;
                          // Respect each product's max_discount cap, so
                          // clearance items never go below their floor.
                          const cap = (item.max_discount !== null && item.max_discount !== undefined)
                            ? parseFloat(item.max_discount)
                            : null;
                          let effectivePct = pct;
                          if (cap !== null && pct > cap) {
                            effectivePct = cap;
                            cappedCount += 1;
                          }
                          const newDuePrice = +(original * (1 - effectivePct / 100)).toFixed(2);
                          if (newDuePrice >= original) return item; // no-op
                          appliedCount += 1;
                          return {
                            ...item,
                            duePrice: newDuePrice,
                            trade_discount_applied: effectivePct,
                          };
                        });
                        setInvoiceData(prev => ({ ...prev, lineItems: newItems }));
                        if (appliedCount === 0) {
                          toast.info('No lines were updated — discount would not improve any price.');
                        } else {
                          toast.success(
                            `Applied ${pct}% trade pricing to ${appliedCount} line${appliedCount === 1 ? '' : 's'}`
                            + (cappedCount > 0 ? ` (${cappedCount} capped at product max-discount)` : '')
                          );
                        }
                      }}
                      data-testid="apply-trade-pricing-btn"
                      title={`Set Due Price to ${invoiceData.linkedTradeDiscount}% off original on every line item with a product. Per-product max-discount caps respected. You can manually override any line afterwards.`}
                    >
                      Apply trade pricing
                    </button>
                  )}
                  <button
                    type="button"
                    className="text-[11px] text-sky-700 hover:text-sky-900 underline shrink-0"
                    onClick={() => setInvoiceData(prev => ({
                      ...prev,
                      linkedShopCustomerId: null,
                      linkedTradeAccountNumber: null,
                      linkedBusinessName: null,
                      linkedTradeTier: null,
                      linkedTradeDiscount: null,
                    }))}
                    data-testid="unlink-online-account-btn"
                  >
                    Unlink
                  </button>
                </div>
              </div>
            )}

            {/* Loyalty Status Badge — temporarily hidden per request (tier
                medals: Bronze / Silver / Gold / Platinum). Keep the import
                and component intact so it can be re-enabled in one line.
            <LoyaltyBadge 
              email={invoiceData.customerEmail}
              name={invoiceData.customerName}
              showEnrollButton={true}
              className="mt-2"
            />
            */}

            {/* Live trade-buyer chip — silent until email/phone matches a trade account */}
            <TradeCustomerChip
              email={invoiceData.customerEmail}
              phone={invoiceData.customerPhone}
              applied={invoiceData.creditRedeemedAmount || 0}
              maxRedeemable={totals.grossTotal}
              netSubtotal={totals.totalDue}
              earnedCredit={creditPreview.total_credit}
              blendedRate={creditPreview.blended_rate}
              creditBreakdown={creditPreview.breakdown}
              onApplyCredit={({ amount, account }) => {
                setInvoiceData(prev => ({
                  ...prev,
                  creditRedeemedAmount: amount,
                  creditRedeemedAccount: account,
                }));
              }}
            />
            
            <div>
              <label className="text-sm text-muted-foreground">Notes</label>
              <Input
                value={invoiceData.notes}
                onChange={(e) => setInvoiceData({ ...invoiceData, notes: e.target.value })}
                onBlur={(e) => setInvoiceData({ ...invoiceData, notes: toTitleCase(e.target.value) })}
                placeholder="Additional notes"
              />
            </div>
          </div>
        </div>

        {/* Line Items - Using Component OR Refund Panel */}
        {refundMode ? (
          /* Refund Mode Panel */
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-lg flex items-center gap-2">
                <RotateCcw className="h-5 w-5 text-orange-600" />
                Select Items to Refund
              </h3>
              <div className="flex items-center gap-2">
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={selectAllForRefund}
                  data-testid="select-all-refund"
                >
                  Select All (Full Refund)
                </Button>
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={clearRefundSelections}
                  data-testid="clear-refund-selections"
                >
                  Clear All
                </Button>
              </div>
            </div>

            {/* Refund Type Selection */}
            <div className="flex items-center gap-4 p-3 bg-gray-50 rounded-lg">
              <span className="font-medium text-sm">Refund Type:</span>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="refundType"
                  value="partial"
                  checked={refundType === 'partial'}
                  onChange={(e) => setRefundType(e.target.value)}
                  className="text-orange-600"
                />
                <span className="text-sm">Partial Refund</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="refundType"
                  value="full"
                  checked={refundType === 'full'}
                  onChange={(e) => { setRefundType(e.target.value); selectAllForRefund(); }}
                  className="text-orange-600"
                />
                <span className="text-sm">Full Refund</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="refundType"
                  value="exchange"
                  checked={refundType === 'exchange'}
                  onChange={(e) => setRefundType(e.target.value)}
                  className="text-orange-600"
                />
                <ArrowLeftRight className="h-4 w-4" />
                <span className="text-sm">Exchange</span>
              </label>
            </div>

            {/* Items Table for Refund Selection */}
            <div className="border rounded-lg overflow-hidden">
              <table className="w-full">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="px-4 py-3 text-left text-sm font-medium">Select</th>
                    <th className="px-4 py-3 text-left text-sm font-medium">Product</th>
                    <th className="px-4 py-3 text-left text-sm font-medium">SKU</th>
                    <th className="px-4 py-3 text-center text-sm font-medium">Orig. Qty</th>
                    <th className="px-4 py-3 text-center text-sm font-medium">Refund Qty</th>
                    <th className="px-4 py-3 text-right text-sm font-medium">Unit Price</th>
                    <th className="px-4 py-3 text-right text-sm font-medium">Refund Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {invoiceData.lineItems.map((item, index) => {
                    if (!item.product || !item.qty) return null;
                    const isSelected = selectedRefundItems[index]?.selected || false;
                    const refundQty = selectedRefundItems[index]?.quantity || parseInt(item.qty) || 1;
                    const unitPrice = parseFloat(item.duePrice) || parseFloat(item.price) || 0;
                    const refundAmount = isSelected ? unitPrice * refundQty : 0;
                    
                    return (
                      <tr 
                        key={index} 
                        className={`border-t ${isSelected ? 'bg-orange-50' : ''}`}
                        data-testid={`refund-item-row-${index}`}
                      >
                        <td className="px-4 py-3">
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={() => toggleRefundItemSelection(index)}
                            data-testid={`refund-checkbox-${index}`}
                          />
                        </td>
                        <td className="px-4 py-3 font-medium">{toTitleCase(item.product)}</td>
                        <td className="px-4 py-3 text-sm text-muted-foreground font-mono">{item.sku || '-'}</td>
                        <td className="px-4 py-3 text-center">{item.qty}</td>
                        <td className="px-4 py-3 text-center">
                          <Input
                            type="number"
                            min="1"
                            max={parseInt(item.qty) || 1}
                            value={refundQty}
                            onChange={(e) => updateRefundQuantity(index, e.target.value)}
                            disabled={!isSelected}
                            className="w-20 text-center mx-auto"
                            data-testid={`refund-qty-${index}`}
                          />
                        </td>
                        <td className="px-4 py-3 text-right">£{unitPrice.toFixed(2)}</td>
                        <td className="px-4 py-3 text-right font-medium">
                          {isSelected ? `£${refundAmount.toFixed(2)}` : '-'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Refund Summary */}
            <div className="bg-orange-50 border border-orange-200 rounded-lg p-4">
              <div className="flex justify-between items-start">
                <div>
                  <h4 className="font-semibold text-orange-800">Refund Summary</h4>
                  <p className="text-sm text-orange-600 mt-1">
                    {getSelectedItemsCount()} item(s) selected for {refundType === 'full' ? 'full refund' : refundType === 'exchange' ? 'exchange' : 'partial refund'}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm text-muted-foreground">Subtotal</p>
                  <p className="text-xl font-bold text-orange-800">£{calculateRefundTotal().toFixed(2)}</p>
                  <p className="text-sm text-muted-foreground mt-1">+ VAT: £{(calculateRefundTotal() * 0.2).toFixed(2)}</p>
                  <p className="text-lg font-bold text-orange-900 mt-1">Total: £{(calculateRefundTotal() * 1.2).toFixed(2)}</p>
                </div>
              </div>

              {/* Refund Reason */}
              <div className="mt-4">
                <label className="block text-sm font-medium text-orange-800 mb-1">Reason for Refund</label>
                <textarea
                  value={refundReason}
                  onChange={(e) => setRefundReason(e.target.value)}
                  placeholder="Enter reason for refund (optional)"
                  className="w-full px-3 py-2 border border-orange-200 rounded-md text-sm"
                  rows={2}
                  data-testid="refund-reason"
                />
              </div>

              {/* Refund Method */}
              <div className="mt-4">
                <label className="block text-sm font-medium text-orange-800 mb-1">Refund Method</label>
                <select
                  value={refundMethod}
                  onChange={(e) => setRefundMethod(e.target.value)}
                  className="w-full px-3 py-2 border border-orange-200 rounded-md text-sm"
                  data-testid="refund-method"
                >
                  <option value="original_payment">Original Payment Method</option>
                  <option value="Cash">Cash</option>
                  <option value="Card">Card</option>
                  <option value="Bank Transfer">Bank Transfer</option>
                  <option value="Store Credit">Store Credit</option>
                </select>
              </div>

              {/* Process Refund Button */}
              <div className="mt-4 flex justify-end gap-2">
                <Button 
                  variant="outline" 
                  onClick={toggleRefundMode}
                >
                  Cancel
                </Button>
                <Button 
                  className="bg-orange-600 hover:bg-orange-700"
                  onClick={() => setShowRefundConfirmDialog(true)}
                  disabled={getSelectedItemsCount() === 0 || processingRefund}
                  data-testid="process-refund-btn"
                >
                  <RotateCcw className="h-4 w-4 mr-2" />
                  {processingRefund ? 'Processing...' : 'Process Refund'}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <InvoiceLineItemsTable
            lineItems={invoiceData.lineItems}
            products={products}
            searchTerm={searchTerm}
            activeLineIndex={activeLineIndex}
            authorizedDiscounts={authorizedDiscounts}
            user={user}
            showrooms={showrooms}
            userShowroomId={user?.showroom_id || selectedStore?.id}
            suppliers={suppliers}
            onSearchTermChange={setSearchTerm}
            onActiveLineIndexChange={setActiveLineIndex}
            onSelectProduct={selectProduct}
            onUpdateLineItem={updateLineItem}
            onAddLineItem={addLineItem}
            onRemoveLineItem={removeLineItem}
            onRoundUpToBox={roundUpToBox}
            calculateLineTotal={calculateLineTotal}
            getMinAllowedPrice={getMinAllowedPrice}
            isDiscountExceeded={isDiscountExceeded}
            getBoxInfo={getBoxInfo}
            totals={totals}
            creditRedeemedAmount={invoiceData.creditRedeemedAmount || 0}
            creditRedeemedAccount={invoiceData.creditRedeemedAccount || null}
          />
        )}
      </Card>

      {/* Print Preview */}
      <Card className="p-6">
        <h3 className="font-semibold text-lg mb-4 flex items-center gap-2">
          <FileText className="h-5 w-5" />
          Print Preview
        </h3>
        
        <InvoicePrintPreview
          printRef={printRef}
          invoiceData={invoiceData}
          totals={totals}
          calculateLineTotal={calculateLineTotal}
        />

        {/* Pay with Trade Credit — only renders when a trade match has balance */}
        <InvoiceCreditPaymentCard
          customerEmail={invoiceData.customerEmail}
          customerPhone={invoiceData.customerPhone}
          applied={invoiceData.creditRedeemedAmount || 0}
          maxRedeemable={totals.grossTotal}
          onApplyCredit={({ amount, account }) => {
            setInvoiceData(prev => ({
              ...prev,
              creditRedeemedAmount: amount,
              creditRedeemedAccount: account,
            }));
          }}
        />

        {/* Amount Taken (Multiple Deposits) - Using Component */}
        <InvoiceDepositsSection
          deposits={invoiceData.deposits}
          totals={totals}
          onAddDeposit={addDeposit}
          onUpdateDeposit={updateDeposit}
          onRemoveDeposit={removeDeposit}
          applyVat={applyVat}
          onToggleVat={setApplyVat}
          cashOnly={isFromCashQuotation}
          isSuperAdmin={user?.role === 'super_admin'}
        />

        {/* Action Buttons */}
        <div className="flex justify-end gap-3 py-4 border-t border-b mb-6">
          <Button 
            variant="outline" 
            onClick={handlePrint}
            disabled={!editMode}
            title={!editMode ? 'Save the invoice first to enable printing' : 'Print invoice'}
            data-testid="print-invoice-btn"
          >
            <Printer className="h-4 w-4 mr-2" />
            Print
          </Button>
          <Button 
            className="bg-green-600 hover:bg-green-700" 
            onClick={handleSaveInvoice}
            disabled={saving}
            data-testid="save-invoice-btn"
          >
            <Save className="h-4 w-4 mr-2" />
            {saving ? 'Saving...' : (editMode ? 'Update Invoice' : 'Save & Update Stock')}
          </Button>
        </div>

        {/* Terms and Conditions - Editable */}
        <div className="mb-6">
          <h3 className="font-semibold text-lg mb-2">Terms and Conditions</h3>
          <textarea
            className="w-full px-3 py-2 border rounded-md min-h-[100px] text-sm"
            value={invoiceData.termsAndConditions}
            onChange={(e) => setInvoiceData({ ...invoiceData, termsAndConditions: e.target.value })}
            placeholder="Enter terms and conditions..."
          />
        </div>
      </Card>
    </div>
  );
};

export default Invoice;


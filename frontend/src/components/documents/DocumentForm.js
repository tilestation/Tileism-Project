import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { api } from '../../lib/api';
import { toast } from 'sonner';
import { RotateCcw, Plus, Trash2, Printer, Save, Search, History, ArrowLeft, Receipt, Building2, Lock, CalendarIcon, Clock, Mail, Loader2 } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card } from '../../components/ui/card';
import { Calendar } from '../../components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { DocumentPrintPreview } from '../../components/invoice/DocumentPrintPreview';
import { CustomerDetailsSection } from '../CustomerDetailsSection';

const defaultCompanyInfo = {
  name: 'Tile Station',
  address: 'Unit 3 Trade City Coldharbour Road',
  city: 'Northfleet Gravesend DA11 8AB',
  telephone: '01474 878 989',
  email: 'gravesend@tilestation.co.uk',
  companyNo: '11982550',
  vatNo: '324 251 828'
};

const documentMethods = ['Cash', 'Card', 'Bank Transfer', 'Store Credit'];
const restockingRates = {
  'Stocked Tiles': 20,
  'Special Order Tiles': 50,
  'Bathroom Products': 100,
  'Other': 0
};

const emptyLineItem = {
  qty: '',
  product: '',
  originalPrice: '',
  amount: '', // Will be mapped to refundPrice or creditAmount
  productId: '',
  sku: '',
  reason: ''
};

/**
 * Shared Document Form Component for Refunds and Credit Notes
 * @param {Object} props
 * @param {'refund' | 'creditNote'} props.documentType - Type of document
 */
export const DocumentForm = ({ documentType = 'refund' }) => {
  const navigate = useNavigate();
  const printRef = useRef();
  const { user } = useAuth();
  const [products, setProducts] = useState([]);
  const [showrooms, setStores] = useState([]);
  const [selectedStore, setSelectedStore] = useState(null);
  const [saving, setSaving] = useState(false);
  const [isSaved, setIsSaved] = useState(false); // Track if document has been saved
  const [searchTerm, setSearchTerm] = useState('');
  const [activeLineIndex, setActiveLineIndex] = useState(null);
  
  // Staff PIN states
  const [staffPin, setStaffPin] = useState('');
  const [verifiedStaff, setVerifiedStaff] = useState(null);
  const [showPinDialog, setShowPinDialog] = useState(false);
  const [verifyingPin, setVerifyingPin] = useState(false);
  
  // Email confirmation dialog state
  const [showEmailDialog, setShowEmailDialog] = useState(false);
  const [savedDocumentId, setSavedDocumentId] = useState(null);
  const [sendingEmail, setSendingEmail] = useState(false);
  
  // Invoice search for linking
  const [invoiceSearchTerm, setInvoiceSearchTerm] = useState('');
  const [invoiceSearchResults, setInvoiceSearchResults] = useState([]);
  const [showInvoiceSearch, setShowInvoiceSearch] = useState(false);

  // 24 Feb 2026 — no-invoice override flow (super-admin only)
  // Staff cannot issue a refund without a linked original invoice. If a
  // Super Admin needs to override that rule, this dialog collects a
  // mandatory written reason and confirmation. Telegram alert fires
  // on the backend so absentee Super Admin gets notified of every override.
  const [showNoInvoiceDialog, setShowNoInvoiceDialog] = useState(false);
  const [noInvoiceReason, setNoInvoiceReason] = useState('');
  const isSuperAdmin = user?.role === 'super_admin';

  // Configuration based on document type
  const isRefund = documentType === 'refund';
  const config = {
    title: isRefund ? 'Refund Note' : 'Credit Note',
    titleShort: isRefund ? 'Refund' : 'Credit Note',
    icon: isRefund ? RotateCcw : Receipt,
    numberPrefix: isRefund ? 'REF' : 'CN',
    numberField: isRefund ? 'refundNo' : 'creditNoteNo',
    priceField: isRefund ? 'refundPrice' : 'creditAmount',
    priceLabel: isRefund ? 'Refund Price' : 'Credit Amount',
    methodField: isRefund ? 'refundMethod' : 'creditNoteMethod',
    methodLabel: isRefund ? 'Refund Method' : 'Credit Note Method',
    typeField: isRefund ? 'refundType' : 'creditNoteType',
    typeLabel: isRefund ? 'Refund Type' : 'Credit Note Type',
    types: isRefund 
      ? ['Full Refund', 'Partial Refund', 'Exchange']
      : ['Full Credit Note', 'Partial Credit Note', 'Exchange'],
    netField: isRefund ? 'netRefund' : 'netCreditNote',
    netLabel: isRefund ? 'Net Refund' : 'Net Credit Note',
    historyRoute: isRefund ? '/admin/refund-history' : '/admin/credit-note-history',
    apiEndpoint: isRefund ? 'refunds' : 'credit-notes',
    summaryTitle: isRefund ? 'Refund Summary' : 'Credit Note Summary',
  };

  // Generate document number
  const generateDocumentNo = () => {
    const timestamp = Date.now().toString().slice(-12);
    return `${config.numberPrefix}-${timestamp}`;
  };

  // Document data state
  const [documentData, setDocumentData] = useState({
    [config.numberField]: generateDocumentNo(),
    date: new Date().toLocaleDateString('en-GB'),
    time: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    originalInvoiceNo: '',
    originalInvoiceId: '',
    customerName: '',
    customerPhone: '',
    customerEmail: '',
    customerAddress: '',
    salesPerson: user?.name || '',
    [config.methodField]: '',
    [config.typeField]: '',
    notes: '',
    lineItems: [{ ...emptyLineItem }],
    companyInfo: { ...defaultCompanyInfo },
    restockingFeePercent: 0
  });

  // Check if user can switch showrooms
  const canFreelySwitchStores = user?.role === 'super_admin' || user?.role === 'admin' || user?.role === 'manager';
  
  // Filter showrooms based on user role
  const availableStores = showrooms.filter(showroom => {
    if (user?.role === 'super_admin' || user?.role === 'admin' || user?.role === 'manager') {
      return true;
    }
    if (user?.showroom_id) {
      return showroom.id === user.showroom_id;
    }
    return false;
  });

  // Load data
  useEffect(() => {
    const fetchData = async () => {
      try {
        const [productsRes, showroomsRes] = await Promise.all([
          api.getProducts(),
          api.getStores()
        ]);
        setProducts(productsRes.data);
        setStores(showroomsRes.data);
        
        if (user?.showroom_id) {
          const userStore = showroomsRes.data.find(s => s.id === user.showroom_id);
          if (userStore) {
            setSelectedStore(userStore);
            setDocumentData(prev => ({
              ...prev,
              companyInfo: {
                ...prev.companyInfo,
                address: userStore.address?.split(',')[0] || prev.companyInfo.address,
                city: userStore.address?.split(',').slice(1).join(',').trim() || prev.companyInfo.city,
                telephone: userStore.phone || prev.companyInfo.telephone,
                email: userStore.email || prev.companyInfo.email
              }
            }));
          }
        } else if (showroomsRes.data?.length > 0) {
          setSelectedStore(showroomsRes.data[0]);
        }
      } catch (error) {
        console.error('Failed to load data', error);
      }
    };
    fetchData();
  }, [user?.showroom_id]);

  // Search invoices for linking
  const searchInvoices = async (term) => {
    if (term.length < 2) {
      setInvoiceSearchResults([]);
      return;
    }
    try {
      const res = await api.getInvoices({ search: term });
      setInvoiceSearchResults(res.data.slice(0, 10));
    } catch (error) {
      console.error('Failed to search invoices', error);
    }
  };

  // Select invoice to link
  const selectInvoice = (invoice) => {
    setDocumentData(prev => ({
      ...prev,
      originalInvoiceNo: invoice.invoice_no,
      originalInvoiceId: invoice.id,
      customerName: invoice.customer_name || '',
      customerPhone: invoice.customer_phone || '',
      customerEmail: invoice.customer_email || '',
      customerAddress: invoice.customer_address || ''
    }));
    setShowInvoiceSearch(false);
    setInvoiceSearchTerm('');
    setInvoiceSearchResults([]);
    toast.success(`Linked to invoice ${invoice.invoice_no}`);
  };

  // Calculate totals
  const calculateTotals = () => {
    const priceField = config.priceField;
    const validItems = documentData.lineItems.filter(item => 
      item.product && parseFloat(item.qty) > 0 && parseFloat(item[priceField]) >= 0
    );
    
    const subtotal = validItems.reduce((sum, item) => {
      const qty = parseFloat(item.qty) || 0;
      const price = parseFloat(item[priceField]) || 0;
      return sum + (qty * price);
    }, 0);
    
    const vat = subtotal * 0.2;
    const grossTotal = subtotal + vat;
    const restockingFee = grossTotal * (documentData.restockingFeePercent / 100);
    const netAmount = grossTotal - restockingFee;
    
    return { 
      subtotal, 
      vat, 
      grossTotal, 
      restockingFee, 
      [config.netField]: netAmount,
      // For backwards compatibility with print preview
      netRefund: isRefund ? netAmount : undefined,
      netCreditNote: !isRefund ? netAmount : undefined
    };
  };

  const totals = calculateTotals();

  // Line item handlers
  const updateLineItem = (index, field, value) => {
    setDocumentData(prev => {
      const newItems = [...prev.lineItems];
      newItems[index] = { ...newItems[index], [field]: value };
      return { ...prev, lineItems: newItems };
    });
  };

  // Batch update multiple fields at once to prevent focus loss
  const updateLineItemBatch = (index, updates) => {
    setDocumentData(prev => {
      const newItems = [...prev.lineItems];
      newItems[index] = { ...newItems[index], ...updates };
      return { ...prev, lineItems: newItems };
    });
  };

  const addLineItem = () => {
    setDocumentData(prev => ({
      ...prev,
      lineItems: [...prev.lineItems, { ...emptyLineItem }]
    }));
  };

  const removeLineItem = (index) => {
    if (documentData.lineItems.length > 1) {
      setDocumentData(prev => ({
        ...prev,
        lineItems: prev.lineItems.filter((_, i) => i !== index)
      }));
    }
  };

  // Product search
  const filteredProducts = products.filter(p =>
    p.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    p.sku?.toLowerCase().includes(searchTerm.toLowerCase())
  ).slice(0, 10);

  const selectProduct = (product, index) => {
    // Batch update all product fields at once to prevent multiple re-renders
    updateLineItemBatch(index, {
      product: product.name,
      productId: product.id,
      sku: product.sku || '',
      originalPrice: product.price?.toString() || '',
      [config.priceField]: product.price?.toString() || ''
    });
    setActiveLineIndex(null);
    setSearchTerm('');
  };

  // Print handler
  const handlePrint = () => {
    // Prevent printing if document is not saved
    if (!isSaved) {
      toast.error(`Please save the ${config.titleShort.toLowerCase()} before printing`);
      return;
    }
    
    const printContent = printRef.current;
    if (!printContent) return;
    
    const printWindow = window.open('', '', 'width=900,height=700');
    printWindow.document.write(`
      <html>
        <head>
          <title>${config.title} - ${documentData[config.numberField]}</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 0; padding: 20px; }
            table { border-collapse: collapse; width: 100%; }
            th, td { border: 1px solid #ccc; padding: 6px; text-align: left; }
            th { background-color: #000; color: #fff; }
            .text-right { text-align: right; }
            .text-center { text-align: center; }
            .font-bold { font-weight: bold; }
          </style>
        </head>
        <body>${printContent.innerHTML}</body>
      </html>
    `);
    printWindow.document.close();
    printWindow.print();
  };

  // PIN verification
  const verifyPin = async () => {
    if (!staffPin || staffPin.length < 4) {
      toast.error('Please enter a valid PIN');
      return;
    }
    
    setVerifyingPin(true);
    try {
      const res = await api.verifyStaffPin(staffPin);
      // API returns staff data on success, throws error on failure
      setVerifiedStaff(res.data);
      setShowPinDialog(false);
      setStaffPin('');
      toast.success(`PIN verified for ${res.data.name || res.data.staff_name}`);
      // Proceed to save
      await saveDocument(res.data);
    } catch (error) {
      toast.error('Invalid PIN');
      setStaffPin('');
    } finally {
      setVerifyingPin(false);
    }
  };

  // Save document.
  //
  // Optional `overrideReason` lets the Super Admin no-invoice override
  // dialog re-trigger this function after collecting a reason. Without
  // a reason, refunds without a linked original invoice are rejected at
  // the API (and earlier at the UI pre-flight check below).
  const saveDocument = async (staffData, overrideReason = null) => {
    // Pre-flight: refunds (not credit notes) MUST link to an original
    // invoice unless a Super Admin explicitly overrides. Staff get a
    // clear error; Super Admins get the override dialog so they can
    // record a reason (audited + Telegram-notified backend-side).
    const hasInvoiceLink = !!((documentData.originalInvoiceId || documentData.originalInvoiceNo || '').toString().trim());
    if (isRefund && !hasInvoiceLink && !overrideReason) {
      if (!isSuperAdmin) {
        toast.error(
          'Refunds must be linked to the original invoice. Use the "Search invoice" button above, ' +
          'or ask a Super Admin to issue this refund.',
          { duration: 7000 },
        );
        return;
      }
      // Super Admin → open the override dialog
      setShowNoInvoiceDialog(true);
      return;
    }

    setSaving(true);
    try {
      // Build line items with correct field names for API
      // The price field name depends on the document type:
      // - Refunds use 'refund_price'
      // - Credit Notes use 'credit_note_price'
      const priceFieldName = isRefund ? 'refund_price' : 'credit_note_price';
      const lineItems = documentData.lineItems
        .filter(item => item.product && parseFloat(item.qty) > 0)
        .map(item => ({
          product_id: item.productId || null,
          product_name: item.product || 'Unknown Product',
          sku: item.sku || '',
          quantity: parseFloat(item.qty) || 1,
          original_price: parseFloat(item.originalPrice) || 0,
          [priceFieldName]: parseFloat(item[config.priceField]) || 0,
          total: (parseFloat(item.qty) || 1) * (parseFloat(item[config.priceField]) || 0),
          reason: item.reason || ''
        }));

      if (lineItems.length === 0) {
        toast.error('Please add at least one item');
        setSaving(false);
        return;
      }

      const payload = {
        [config.numberField === 'refundNo' ? 'refund_no' : 'credit_note_no']: documentData[config.numberField],
        date: documentData.date,
        time: documentData.time,
        original_invoice_no: documentData.originalInvoiceNo || '',
        original_invoice_id: documentData.originalInvoiceId || null,
        customer_name: documentData.customerName || '',
        customer_email: documentData.customerEmail || '',
        customer_phone: documentData.customerPhone || '',
        customer_address: documentData.customerAddress || '',
        line_items: lineItems,
        subtotal: totals.subtotal || 0,
        vat: totals.vat || 0,
        gross_total: totals.grossTotal || 0,
        restocking_fee: totals.restockingFee || 0,
        notes: documentData.notes || '',
        [config.methodField === 'refundMethod' ? 'refund_method' : 'credit_note_method']: documentData[config.methodField] || 'Cash',
        [config.typeField === 'refundType' ? 'refund_type' : 'credit_note_type']: documentData[config.typeField] || 'Full Refund',
        staff_id: staffData?.staff_id || staffData?.id || null,
        staff_name: staffData?.staff_name || staffData?.name || null,
        showroom_id: selectedStore?.id || null,
        showroom_name: selectedStore?.name || '',
        // Super-admin no-invoice override — only ever sent when this
        // is a refund without a linked invoice AND a Super Admin has
        // confirmed via the override dialog. Backend will reject
        // override=true from non-super-admins.
        ...(isRefund && !hasInvoiceLink && overrideReason ? {
          no_invoice_override: true,
          no_invoice_reason: overrideReason,
        } : {}),
      };
      
      console.log('Saving document:', payload);
      
      // Call the appropriate API endpoint
      let response;
      if (isRefund) {
        response = await api.createRefund(payload);
      } else {
        response = await api.createCreditNote(payload);
      }
      
      console.log('Save response:', response.data);
      setIsSaved(true);
      toast.success(`${config.title} saved successfully`);
      
      // Show email dialog if customer has email
      // Backend returns 'refund_id' for refunds and 'credit_note_id' for credit notes
      const savedId = isRefund ? response.data?.refund_id : response.data?.credit_note_id;
      if (documentData.customerEmail && documentData.customerEmail.trim() && savedId) {
        setSavedDocumentId(savedId);
        setShowEmailDialog(true);
      } else {
        navigate(config.historyRoute);
      }
    } catch (error) {
      console.error('Save error:', error);
      console.error('Error response:', error.response?.data);
      toast.error(error.response?.data?.detail || error.message || `Failed to save ${config.titleShort.toLowerCase()}`);
    } finally {
      setSaving(false);
    }
  };

  // Handle sending document email to customer
  const handleSendEmail = async () => {
    if (!savedDocumentId || !documentData.customerEmail) {
      toast.error('No document or email to send');
      setShowEmailDialog(false);
      navigate(config.historyRoute);
      return;
    }
    
    setSendingEmail(true);
    try {
      // Use manual email API to send the document
      await api.sendManualEmail({
        to: documentData.customerEmail.trim(),
        subject: `Your ${config.title} - ${documentData[config.numberField]}`,
        body: `Dear ${documentData.customerName || 'Customer'},\n\nPlease find your ${config.titleShort.toLowerCase()} attached.\n\n${config.title} Number: ${documentData[config.numberField]}\nTotal: £${totals.grossTotal.toFixed(2)}\n\nThank you for your business.\n\nTile Station`
      });
      toast.success(`${config.title} emailed to ${documentData.customerEmail}`);
    } catch (error) {
      console.error('Email error:', error);
      toast.error(error.response?.data?.detail || 'Failed to send email');
    } finally {
      setSendingEmail(false);
      setShowEmailDialog(false);
      navigate(config.historyRoute);
    }
  };

  // Handle save button click
  const handleSave = () => {
    if (!selectedStore) {
      toast.error('Please select a store');
      return;
    }
    
    // Validate mandatory customer fields BEFORE PIN dialog
    if (!documentData.customerName || !documentData.customerName.trim()) {
      toast.error('Customer Name is required. Please enter the customer name.');
      return;
    }
    
    if (!documentData.customerPhone || !documentData.customerPhone.trim()) {
      toast.error('Phone Number is required. Please enter the customer phone number.');
      return;
    }
    
    // Validate phone number format (at least 10 digits)
    const phoneDigits = documentData.customerPhone.replace(/\D/g, '');
    if (phoneDigits.length < 10) {
      toast.error('Phone number must be at least 10 digits. Please enter a valid UK phone number.');
      return;
    }
    
    // Validate email is provided and has valid format
    if (!documentData.customerEmail || !documentData.customerEmail.trim()) {
      toast.error('Email is required. Please enter the customer email address.');
      return;
    }
    
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(documentData.customerEmail.trim())) {
      toast.error('Please enter a valid email address.');
      return;
    }
    
    const priceField = config.priceField;
    
    // Validate items have qty and product
    const itemsWithProduct = documentData.lineItems.filter(item =>
      item.product && parseFloat(item.qty) > 0
    );
    
    if (itemsWithProduct.length === 0) {
      toast.error('Please add at least one item with product and quantity');
      return;
    }
    
    // Validate that items have a price/amount entered
    const itemsWithPrice = itemsWithProduct.filter(item =>
      item[priceField] !== '' && item[priceField] !== null && item[priceField] !== undefined && parseFloat(item[priceField]) >= 0
    );
    
    if (itemsWithPrice.length === 0) {
      toast.error(`Please enter the ${config.priceLabel.toLowerCase()} for at least one item`);
      return;
    }
    
    // Check for items without price (warn but allow)
    const itemsWithoutPrice = itemsWithProduct.filter(item =>
      item[priceField] === '' || item[priceField] === null || item[priceField] === undefined
    );
    
    if (itemsWithoutPrice.length > 0) {
      toast.error(`Please enter the ${config.priceLabel.toLowerCase()} for all items`);
      return;
    }
    
    if (!documentData[config.methodField]) {
      toast.error(`Please select a ${config.methodLabel.toLowerCase()}`);
      return;
    }
    
    setShowPinDialog(true);
  };

  // Reset form
  const handleReset = () => {
    setDocumentData({
      [config.numberField]: generateDocumentNo(),
      date: new Date().toLocaleDateString('en-GB'),
      time: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      originalInvoiceNo: '',
      originalInvoiceId: '',
      customerName: '',
      customerPhone: '',
      customerEmail: '',
      customerAddress: '',
      salesPerson: user?.name || '',
      [config.methodField]: '',
      [config.typeField]: '',
      notes: '',
      lineItems: [{ ...emptyLineItem }],
      companyInfo: { ...defaultCompanyInfo },
      restockingFeePercent: 0
    });
    setVerifiedStaff(null);
    toast.success('Form reset');
  };

  const IconComponent = config.icon;

  return (
    <div className="p-6 max-w-7xl mx-auto" data-testid={`${documentType}-page`}>
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-4 w-4 mr-1" /> Back
          </Button>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <IconComponent className="h-6 w-6" />
            {config.title}
          </h1>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleReset}>
            <RotateCcw className="h-4 w-4 mr-1" /> Reset
          </Button>
          <Button variant="outline" onClick={() => navigate(config.historyRoute)}>
            <History className="h-4 w-4 mr-1" /> History
          </Button>
          <Button 
            variant="outline" 
            onClick={handlePrint}
            disabled={!isSaved}
            title={!isSaved ? `Save the ${config.titleShort.toLowerCase()} first to enable printing` : `Print ${config.titleShort.toLowerCase()}`}
            data-testid={`print-${documentType}-btn`}
          >
            <Printer className="h-4 w-4 mr-1" /> Print
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            <Save className="h-4 w-4 mr-1" />
            {saving ? 'Saving...' : `Save ${config.titleShort}`}
          </Button>
        </div>
      </div>

      {/* Main Form */}
      <div className="grid lg:grid-cols-3 gap-6">
        {/* Left Column - Document Details & Items */}
        <div className="lg:col-span-2 space-y-6">
          {/* Document Info */}
          <Card className="p-6">
            <h3 className="font-bold mb-4">{config.title} Details</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <label className="text-sm text-muted-foreground">{config.titleShort} No.</label>
                <Input
                  value={documentData[config.numberField]}
                  onChange={(e) => setDocumentData(prev => ({ ...prev, [config.numberField]: e.target.value }))}
                  data-testid={`${documentType}-number-input`}
                />
              </div>
              <div>
                <label className="text-sm text-muted-foreground">Date</label>
                <Popover>
                  <PopoverTrigger asChild>
                    <div className="relative">
                      <Input 
                        value={documentData.date} 
                        onChange={(e) => setDocumentData(prev => ({ ...prev, date: e.target.value }))}
                        data-testid={`${documentType}-date-input`}
                        className="pr-10"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                      >
                        <CalendarIcon className="h-4 w-4 text-muted-foreground" />
                      </Button>
                    </div>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={(() => {
                        // Parse DD/MM/YYYY format
                        const parts = documentData.date?.split('/');
                        if (parts?.length === 3) {
                          const d = new Date(parts[2], parts[1] - 1, parts[0]);
                          return isNaN(d.getTime()) ? undefined : d;
                        }
                        return undefined;
                      })()}
                      onSelect={(date) => {
                        if (date) {
                          const formatted = date.toLocaleDateString('en-GB');
                          setDocumentData(prev => ({ ...prev, date: formatted }));
                        }
                      }}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>
              <div>
                <label className="text-sm text-muted-foreground">Time</label>
                <div className="relative">
                  <Input 
                    type="time"
                    value={documentData.time} 
                    onChange={(e) => setDocumentData(prev => ({ ...prev, time: e.target.value }))}
                    data-testid={`${documentType}-time-input`}
                    className="pr-10"
                  />
                  <Clock className="absolute right-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                </div>
              </div>
              <div>
                <label className="text-sm text-muted-foreground">
                  Original Invoice
                  {isRefund && <span className="text-red-600 ml-1" title="Required for refunds">*</span>}
                </label>
                <div className="relative">
                  <Input
                    value={documentData.originalInvoiceNo}
                    onChange={(e) => setDocumentData(prev => ({ ...prev, originalInvoiceNo: e.target.value }))}
                    placeholder="Search invoice..."
                    onFocus={() => setShowInvoiceSearch(true)}
                    data-testid="original-invoice-input"
                    className={
                      isRefund && !documentData.originalInvoiceNo && !documentData.originalInvoiceId
                        ? 'border-red-300 focus-visible:ring-red-400'
                        : ''
                    }
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="absolute right-1 top-1"
                    onClick={() => setShowInvoiceSearch(true)}
                  >
                    <Search className="h-4 w-4" />
                  </Button>
                </div>
                {isRefund && !documentData.originalInvoiceNo && !documentData.originalInvoiceId && (
                  <p
                    className="text-xs mt-1 text-red-700"
                    data-testid="refund-no-invoice-warning"
                  >
                    {isSuperAdmin
                      ? '⚠ Refund without invoice — you (Super Admin) will be prompted to confirm and provide a reason on Save.'
                      : '⚠ Required. Staff cannot issue refunds without a linked invoice — ask a Super Admin.'}
                  </p>
                )}
              </div>
            </div>
          </Card>

          {/* Invoice Search Modal */}
          {showInvoiceSearch && (
            <Card className="p-4 border-2 border-blue-200">
              <div className="flex justify-between items-center mb-3">
                <h4 className="font-bold">Link to Original Invoice</h4>
                <Button variant="ghost" size="sm" onClick={() => setShowInvoiceSearch(false)}>×</Button>
              </div>
              <Input
                placeholder="Search by invoice number or customer name..."
                value={invoiceSearchTerm}
                onChange={(e) => {
                  setInvoiceSearchTerm(e.target.value);
                  searchInvoices(e.target.value);
                }}
                autoFocus
                data-testid="invoice-search-input"
              />
              {invoiceSearchResults.length > 0 && (
                <div className="mt-2 max-h-48 overflow-y-auto border rounded">
                  {invoiceSearchResults.map(invoice => (
                    <div
                      key={invoice.id}
                      className="p-2 hover:bg-gray-100 cursor-pointer border-b last:border-b-0"
                      onClick={() => selectInvoice(invoice)}
                    >
                      <div className="font-medium">{invoice.invoice_no}</div>
                      <div className="text-sm text-muted-foreground">
                        {invoice.customer_name} - {invoice.date}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}

          {/* Customer Details */}
          <Card className="p-6">
            <CustomerDetailsSection
              name={documentData.customerName}
              phone={documentData.customerPhone}
              email={documentData.customerEmail}
              address={documentData.customerAddress}
              onNameChange={(val) => setDocumentData(prev => ({ ...prev, customerName: val }))}
              onPhoneChange={(val) => setDocumentData(prev => ({ ...prev, customerPhone: val }))}
              onEmailChange={(val) => setDocumentData(prev => ({ ...prev, customerEmail: val }))}
              onAddressChange={(val) => setDocumentData(prev => ({ ...prev, customerAddress: val }))}
              onSelectCustomer={(customer) => {
                setDocumentData(prev => ({
                  ...prev,
                  customerName: customer.name || '',
                  customerPhone: customer.phone || '',
                  customerEmail: customer.email || '',
                  customerAddress: customer.address || ''
                }));
              }}
              onClear={() => {
                setDocumentData(prev => ({
                  ...prev,
                  customerName: '',
                  customerPhone: '',
                  customerEmail: '',
                  customerAddress: ''
                }));
              }}
              nameRequired={true}
              phoneRequired={true}
              emailRequired={true}
            />
            <div className="grid grid-cols-2 gap-4 mt-4">
              <div>
                <label className="text-sm text-muted-foreground">{config.typeLabel}</label>
                <select
                  className="w-full px-3 py-2 border rounded-md"
                  value={documentData[config.typeField]}
                  onChange={(e) => setDocumentData(prev => ({ ...prev, [config.typeField]: e.target.value }))}
                  data-testid={`${documentType}-type-select`}
                >
                  <option value="">Select Type</option>
                  {config.types.map(type => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-sm text-muted-foreground">{config.methodLabel}</label>
                <select
                  className="w-full px-3 py-2 border rounded-md"
                  value={documentData[config.methodField]}
                  onChange={(e) => setDocumentData(prev => ({ ...prev, [config.methodField]: e.target.value }))}
                  data-testid={`${documentType}-method-select`}
                >
                  <option value="">Select Method</option>
                  {documentMethods.map(method => (
                    <option key={method} value={method}>{method}</option>
                  ))}
                </select>
              </div>
            </div>
          </Card>

          {/* Line Items */}
          <Card className="p-6 overflow-x-auto">
            <h3 className="font-bold mb-4">Items</h3>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="py-2 text-left w-16">Qty</th>
                  <th className="py-2 text-left min-w-[200px]">Product</th>
                  <th className="py-2 text-left w-24">SKU</th>
                  <th className="py-2 text-right w-24">Orig. Price</th>
                  <th className="py-2 text-right w-24">{config.priceLabel}</th>
                  <th className="py-2 text-left w-32">Reason</th>
                  <th className="py-2 text-right w-20">Total</th>
                  <th className="py-2 w-10"></th>
                </tr>
              </thead>
              <tbody>
                {documentData.lineItems.map((item, index) => (
                  <tr key={index} className="border-b">
                    <td className="py-2">
                      <Input
                        type="number"
                        min="0"
                        value={item.qty}
                        onChange={(e) => updateLineItem(index, 'qty', e.target.value)}
                        className="w-16"
                        data-testid={`line-item-qty-${index}`}
                      />
                    </td>
                    <td className="py-2 relative">
                      <Input
                        value={item.product}
                        onChange={(e) => {
                          updateLineItem(index, 'product', e.target.value);
                          setSearchTerm(e.target.value);
                          setActiveLineIndex(index);
                        }}
                        onFocus={() => setActiveLineIndex(index)}
                        placeholder="Search product..."
                        data-testid={`line-item-product-${index}`}
                      />
                      {activeLineIndex === index && searchTerm && filteredProducts.length > 0 && (
                        <div className="absolute z-10 w-full bg-white border rounded-md shadow-lg max-h-48 overflow-y-auto">
                          {filteredProducts.map(product => (
                            <div
                              key={product.id}
                              className="p-2 hover:bg-gray-100 cursor-pointer"
                              onClick={() => selectProduct(product, index)}
                            >
                              <div className="font-medium">{product.name}</div>
                              <div className="text-xs text-muted-foreground">
                                {product.sku} - £{product.price}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="py-2">
                      <Input value={item.sku} readOnly className="w-24 bg-gray-50" />
                    </td>
                    <td className="py-2">
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={item.originalPrice}
                        onChange={(e) => updateLineItem(index, 'originalPrice', e.target.value)}
                        className="w-24 text-right"
                      />
                    </td>
                    <td className="py-2">
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={item[config.priceField]}
                        onChange={(e) => updateLineItem(index, config.priceField, e.target.value)}
                        className="w-24 text-right"
                        data-testid={`line-item-price-${index}`}
                      />
                    </td>
                    <td className="py-2">
                      <select
                        className="w-full px-2 py-1 border rounded-md text-sm"
                        value={item.reason}
                        onChange={(e) => updateLineItem(index, 'reason', e.target.value)}
                      >
                        <option value="">Select reason</option>
                        <option value="Wrong item">Wrong item</option>
                        <option value="Damaged">Damaged</option>
                        <option value="Not needed">Not needed</option>
                        <option value="Quality issue">Quality issue</option>
                        <option value="Other">Other</option>
                      </select>
                    </td>
                    <td className="py-2 text-right font-medium">
                      £{((parseFloat(item.qty) || 0) * (parseFloat(item[config.priceField]) || 0)).toFixed(2)}
                    </td>
                    <td className="py-2">
                      <Button 
                        variant="ghost" 
                        size="sm"
                        onClick={() => removeLineItem(index)}
                        disabled={documentData.lineItems.length === 1}
                      >
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Button variant="outline" className="mt-4" onClick={addLineItem}>
              <Plus className="h-4 w-4 mr-1" /> Add Item
            </Button>
          </Card>

          {/* Notes */}
          <Card className="p-6">
            <h3 className="font-bold mb-4">Notes</h3>
            <textarea
              className="w-full p-3 border rounded-md text-sm"
              rows={3}
              value={documentData.notes}
              onChange={(e) => setDocumentData(prev => ({ ...prev, notes: e.target.value }))}
              placeholder={`Add any notes about this ${config.titleShort.toLowerCase()}...`}
              data-testid="notes-textarea"
            />
          </Card>
        </div>

        {/* Right Column - Summary */}
        <div className="space-y-6">
          {/* Store Selection */}
          <Card className="p-6">
            <h3 className="font-bold mb-4 flex items-center gap-2">
              <Building2 className="h-5 w-5" /> Store
              {!canFreelySwitchStores && user?.showroom_id && (
                <span className="text-xs text-muted-foreground flex items-center gap-1">
                  <Lock className="h-3 w-3" /> Your showroom
                </span>
              )}
            </h3>
            <select
              className="w-full px-3 py-2 border rounded-md"
              value={selectedStore?.id || ''}
              onChange={(e) => {
                const showroom = showrooms.find(s => s.id === e.target.value);
                setSelectedStore(showroom || null);
                if (showroom) {
                  setDocumentData(prev => ({
                    ...prev,
                    companyInfo: {
                      ...prev.companyInfo,
                      address: showroom.address?.split(',')[0] || prev.companyInfo.address,
                      city: showroom.address?.split(',').slice(1).join(',').trim() || prev.companyInfo.city,
                      telephone: showroom.phone || prev.companyInfo.telephone,
                      email: showroom.email || prev.companyInfo.email
                    }
                  }));
                }
              }}
              disabled={!canFreelySwitchStores && user?.showroom_id}
              data-testid="store-select"
            >
              <option value="">Select Store</option>
              {availableStores.map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </Card>

          {/* Restocking Fee */}
          <Card className="p-6">
            <h3 className="font-bold mb-4">Restocking Fee</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm">Fee Percentage</span>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    value={documentData.restockingFeePercent}
                    onChange={(e) => setDocumentData(prev => ({ 
                      ...prev, 
                      restockingFeePercent: Math.min(100, Math.max(0, parseFloat(e.target.value) || 0))
                    }))}
                    className="w-20 text-center"
                    min="0"
                    max="100"
                    data-testid="restocking-fee-input"
                  />
                  <span className="text-sm">%</span>
                </div>
              </div>
              <div className="text-xs text-muted-foreground space-y-1">
                <p>• Stocked Tiles: 20%</p>
                <p>• Special Order: 50%</p>
                <p>• Bathroom Products: Non-refundable</p>
              </div>
            </div>
          </Card>

          {/* Summary */}
          <Card className="p-6 bg-red-50 border-red-200">
            <h3 className="font-bold mb-4 text-red-800">{config.summaryTitle}</h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span>Subtotal</span>
                <span>£{totals.subtotal.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span>VAT (20%)</span>
                <span>£{totals.vat.toFixed(2)}</span>
              </div>
              <div className="flex justify-between font-medium">
                <span>Gross Total</span>
                <span>£{totals.grossTotal.toFixed(2)}</span>
              </div>
              {totals.restockingFee > 0 && (
                <div className="flex justify-between text-orange-600">
                  <span>Restocking Fee ({documentData.restockingFeePercent}%)</span>
                  <span>-£{totals.restockingFee.toFixed(2)}</span>
                </div>
              )}
              <div className="border-t pt-2 mt-2">
                <div className="flex justify-between text-lg font-bold text-red-700">
                  <span>{config.netLabel}</span>
                  <span>£{totals[config.netField].toFixed(2)}</span>
                </div>
              </div>
            </div>
          </Card>

          {/* Staff Verification */}
          <Card className="p-6">
            <h3 className="font-bold mb-4">Staff Verification</h3>
            {verifiedStaff ? (
              <div className="text-green-600 text-sm">
                ✓ Verified: {verifiedStaff.name || verifiedStaff.staff_name}
              </div>
            ) : (
              <Button variant="outline" className="w-full" onClick={() => setShowPinDialog(true)}>
                Verify Staff PIN
              </Button>
            )}
          </Card>
        </div>
      </div>

      {/* Print Preview Section */}
      <div className="mt-8 print:mt-0">
        <h2 className="text-lg font-bold mb-4 print:hidden">Print Preview</h2>
        <DocumentPrintPreview 
          printRef={printRef}
          documentData={documentData}
          totals={totals}
          documentType={documentType}
        />
      </div>

      {/* Staff PIN Dialog */}
      <Dialog open={showPinDialog} onOpenChange={(open) => {
        setShowPinDialog(open);
        if (!open) setStaffPin(''); // Clear PIN when dialog closes
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enter Staff PIN</DialogTitle>
            <DialogDescription>Verify your identity to process this {config.titleShort.toLowerCase()}.</DialogDescription>
          </DialogHeader>
          <Input
            type="password"
            value={staffPin}
            onChange={(e) => setStaffPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="Enter PIN"
            className="text-center text-2xl tracking-widest"
            onKeyPress={(e) => e.key === 'Enter' && verifyPin()}
            autoFocus
            autoComplete="off"
            data-testid="staff-pin-input"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowPinDialog(false); setStaffPin(''); }}>Cancel</Button>
            <Button onClick={verifyPin} disabled={verifyingPin}>
              {verifyingPin ? 'Verifying...' : 'Verify'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Email Confirmation Dialog */}
      <Dialog open={showEmailDialog} onOpenChange={(open) => {
        if (!open) {
          setShowEmailDialog(false);
          navigate(config.historyRoute);
        }
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-blue-600">
              <Mail className="h-5 w-5" />
              Send {config.title} Email
            </DialogTitle>
            <DialogDescription>
              Would you like to send this {config.titleShort.toLowerCase()} to the customer via email?
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <div className="bg-blue-50 rounded-lg p-4 space-y-2">
              <p className="text-sm text-gray-600">
                <span className="font-medium">To:</span> {documentData.customerEmail}
              </p>
              {documentData.customerName && (
                <p className="text-sm text-gray-600">
                  <span className="font-medium">Customer:</span> {documentData.customerName}
                </p>
              )}
              <p className="text-sm text-gray-600">
                <span className="font-medium">{config.title}:</span> {documentData[config.numberField]}
              </p>
            </div>
          </div>
          <DialogFooter className="flex gap-2">
            <Button 
              variant="outline" 
              onClick={() => {
                setShowEmailDialog(false);
                navigate(config.historyRoute);
              }}
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

      {/* No-Invoice Override Dialog (Super Admin only) ─────────────
          Triggered when a Super Admin clicks Save on a refund that
          isn't linked to an original invoice. Collects a written
          reason (≥6 chars) so the audit trail records WHY policy
          was bypassed. Backend stamps the doc + Telegram-alerts. */}
      <Dialog open={showNoInvoiceDialog} onOpenChange={(open) => {
        if (!open && !saving) {
          setShowNoInvoiceDialog(false);
          setNoInvoiceReason('');
        }
      }}>
        <DialogContent className="sm:max-w-md" data-testid="no-invoice-override-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-700">
              <Lock className="h-5 w-5" />
              Super Admin Override Required
            </DialogTitle>
            <DialogDescription>
              This refund is not linked to an original invoice. Issuing it
              bypasses our standard fraud-prevention policy and will:
            </DialogDescription>
          </DialogHeader>

          <ul className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded p-3 space-y-1 list-disc pl-5 my-2">
            <li>Be permanently flagged in the audit log</li>
            <li>Send a Telegram alert to all Super Admins</li>
            <li>Record your account ({user?.email || 'you'}) as the approver</li>
            <li>Require the reason you write below to be retained</li>
          </ul>

          <div className="py-2">
            <label className="text-sm font-medium block mb-1">
              Reason for issuing without an original invoice <span className="text-red-600">*</span>
            </label>
            <textarea
              value={noInvoiceReason}
              onChange={(e) => setNoInvoiceReason(e.target.value)}
              placeholder="e.g. Customer lost original receipt; verified purchase via Stripe charge ID #ch_xyz."
              maxLength={500}
              rows={3}
              className="w-full rounded border border-input bg-background px-3 py-2 text-sm"
              data-testid="no-invoice-reason-input"
              disabled={saving}
              autoFocus
            />
            <p className="text-xs text-muted-foreground mt-1">
              {noInvoiceReason.trim().length}/500 characters (minimum 6).
            </p>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => { setShowNoInvoiceDialog(false); setNoInvoiceReason(''); }}
              disabled={saving}
              data-testid="no-invoice-override-cancel"
            >
              Cancel
            </Button>
            <Button
              onClick={async () => {
                if (noInvoiceReason.trim().length < 6) {
                  toast.error('Please write a reason of at least 6 characters');
                  return;
                }
                setShowNoInvoiceDialog(false);
                await saveDocument(verifiedStaff, noInvoiceReason.trim());
                setNoInvoiceReason('');
              }}
              disabled={saving || noInvoiceReason.trim().length < 6}
              className="bg-amber-600 hover:bg-amber-700 text-white"
              data-testid="no-invoice-override-confirm"
            >
              Approve & Issue Refund
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default DocumentForm;

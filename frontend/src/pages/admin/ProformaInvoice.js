import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { FileText, Printer, Save, Plus, Trash2, ArrowLeft, Download, Mail, FileBadge, Building, Search, Eye } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../../components/ui/dialog';
import { Textarea } from '../../components/ui/textarea';
import { useAuth } from '../../contexts/AuthContext';
import { api } from '../../lib/api';
import { CustomerDetailsSection } from '../../components/CustomerDetailsSection';
import TradeCustomerChip from '../../components/admin/TradeCustomerChip';
import { ProformaInvoicePrintPreview } from '../../components/invoice';
import { EMAIL_CONFIG } from '../../config/emailConfig';

const API_URL = process.env.REACT_APP_BACKEND_URL || '';

// Bank Details for Proforma Invoice
const BANK_DETAILS = {
  name: 'TILE STATION LTD',
  accountType: 'Business',
  accountNumber: '33604637',
  sortCode: '23-05-80'
};

const defaultCompanyInfo = {
  name: 'Tile Station',
  address: 'Unit 3 Trade City, Coldharbour Road',
  city: 'Northfleet Gravesend DA11 8AB',
  telephone: '01234 567 890',
  email: 'info@tilestation.co.uk',
  companyNo: '00000000',
  vatNo: '000 0000 00'
};

const emptyLineItem = {
  qty: '1',
  m2: '',
  product: '',
  price: '',
  duePrice: '',
  productId: '',
  sku: ''
};

export const ProformaInvoice = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const printRef = useRef();
  const previewRef = useRef();
  const [products, setProducts] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [showrooms, setStores] = useState([]);
  const [selectedStore, setSelectedStore] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editInvoiceId, setEditInvoiceId] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [activeLineIndex, setActiveLineIndex] = useState(null);
  
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  
  // Email dialog state
  const [showEmailDialog, setShowEmailDialog] = useState(false);
  const [emailTo, setEmailTo] = useState('');
  const [emailMessage, setEmailMessage] = useState('');
  const [sendingEmail, setSendingEmail] = useState(false);

  const canFreelySwitchStores = user?.role === 'super_admin' || user?.role === 'admin' || user?.role === 'manager';
  
  const availableStores = showrooms.filter(showroom => {
    if (user?.role === 'super_admin' || user?.role === 'admin' || user?.role === 'manager') {
      return true;
    }
    if (user?.showroom_id) {
      return showroom.id === user.showroom_id;
    }
    return false;
  });

  // Generate proforma invoice number
  const generateProformaNo = () => {
    const now = new Date();
    const dateStr = now.toISOString().slice(2, 10).replace(/-/g, '');
    const timeStr = now.getHours().toString().padStart(2, '0') + now.getMinutes().toString().padStart(2, '0');
    const random = Math.floor(Math.random() * 100).toString().padStart(2, '0');
    return `PI${dateStr}${timeStr}${random}`;
  };

  const [invoiceData, setInvoiceData] = useState({
    proformaNo: generateProformaNo(),
    date: new Date().toLocaleDateString('en-GB'),
    time: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    customerName: '',
    customerPhone: '',
    customerEmail: '',
    customerAddress: '',
    salesPerson: user?.name || '',
    validityDays: 30,
    notes: '',
    lineItems: [{ ...emptyLineItem }],
    companyInfo: { ...defaultCompanyInfo }
  });

  // Load edit data from navigation state
  useEffect(() => {
    if (location.state?.editInvoice) {
      const invoice = location.state.editInvoice;
      setEditMode(true);
      setEditInvoiceId(invoice.id);
      
      const lineItems = invoice.line_items?.map(item => ({
        productId: item.product_id,
        product: item.product_name,
        sku: item.sku || '',
        qty: item.quantity.toString(),
        m2: item.m2?.toString() || '',
        price: item.price.toString(),
        duePrice: item.due_price?.toString() || item.price.toString()
      })) || [{ ...emptyLineItem }];
      
      setInvoiceData({
        proformaNo: invoice.proforma_no,
        date: invoice.date,
        time: invoice.time,
        customerName: invoice.customer_name || '',
        customerPhone: invoice.customer_phone || '',
        customerEmail: invoice.customer_email || '',
        customerAddress: invoice.customer_address || '',
        salesPerson: invoice.sales_person || '',
        validityDays: invoice.validity_days || 30,
        notes: invoice.notes || '',
        lineItems,
        companyInfo: invoice.company_info || { ...defaultCompanyInfo }
      });
    }
  }, [location.state]);

  // Fetch products and showrooms
  useEffect(() => {
    const fetchData = async () => {
      try {
        const [productsRes, customersRes, showroomsRes] = await Promise.all([
          api.getProducts(),
          api.getCustomers().catch(() => ({ data: [] })),
          api.getStores().catch(() => ({ data: [] }))
        ]);
        setProducts(productsRes.data || []);
        setCustomers(customersRes.data || []);
        // Warehouses aren't retail stores — hide from Proforma Invoice store dropdown.
        setStores((showroomsRes.data || []).filter(s => !s.is_warehouse));
      } catch (error) {
        console.error('Error fetching data:', error);
        toast.error('Failed to load data');
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  // Calculate totals WITH VAT
  const calculateTotals = () => {
    const subtotal = invoiceData.lineItems.reduce((sum, item) => {
      const qty = parseFloat(item.qty) || 0;
      const price = parseFloat(item.duePrice) || parseFloat(item.price) || 0;
      return sum + (qty * price);
    }, 0);
    
    const vat = subtotal * 0.20;
    const grossTotal = subtotal + vat;
    
    // Calculate savings
    const totalSavings = invoiceData.lineItems.reduce((sum, item) => {
      const qty = parseFloat(item.qty) || 0;
      const listPrice = parseFloat(item.price) || 0;
      const duePrice = parseFloat(item.duePrice) || listPrice;
      return sum + (qty * (listPrice - duePrice));
    }, 0);
    
    return { subtotal, vat, grossTotal, totalSavings };
  };

  const { subtotal, vat, grossTotal, totalSavings } = calculateTotals();

  // Handle line item changes
  const handleLineItemChange = (index, field, value) => {
    const newItems = [...invoiceData.lineItems];
    newItems[index] = { ...newItems[index], [field]: value };
    
    // Auto-set duePrice to price if not set
    if (field === 'price' && !newItems[index].duePrice) {
      newItems[index].duePrice = value;
    }
    
    setInvoiceData(prev => ({ ...prev, lineItems: newItems }));
  };

  // Select product for a line
  const selectProduct = (index, product) => {
    const newItems = [...invoiceData.lineItems];
    newItems[index] = {
      ...newItems[index],
      productId: product.id,
      product: product.name,
      sku: product.sku || '',
      price: product.price?.toString() || '',
      duePrice: product.price?.toString() || ''
    };
    setInvoiceData(prev => ({ ...prev, lineItems: newItems }));
    setActiveLineIndex(null);
    setSearchTerm('');
  };

  const addLineItem = () => {
    setInvoiceData(prev => ({
      ...prev,
      lineItems: [...prev.lineItems, { ...emptyLineItem }]
    }));
  };

  const removeLineItem = (index) => {
    if (invoiceData.lineItems.length > 1) {
      setInvoiceData(prev => ({
        ...prev,
        lineItems: prev.lineItems.filter((_, i) => i !== index)
      }));
    }
  };

  // Filter products based on search
  const filteredProducts = products.filter(p => {
    if (!searchTerm) return false;
    const term = searchTerm.toLowerCase();
    return (
      p.name?.toLowerCase().includes(term) ||
      p.sku?.toLowerCase().includes(term)
    );
  });

  // Save proforma invoice
  const handleSave = async () => {
    if (invoiceData.lineItems.every(item => !item.product)) {
      toast.error('Please add at least one product');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        proforma_no: invoiceData.proformaNo,
        date: invoiceData.date,
        time: invoiceData.time,
        showroom_id: selectedStore?.id || null,
        showroom_name: selectedStore?.name || null,
        customer_name: invoiceData.customerName,
        customer_phone: invoiceData.customerPhone,
        customer_email: invoiceData.customerEmail,
        customer_address: invoiceData.customerAddress,
        sales_person: invoiceData.salesPerson,
        validity_days: invoiceData.validityDays,
        notes: invoiceData.notes,
        line_items: invoiceData.lineItems
          .filter(item => item.product)
          .map(item => ({
            product_id: item.productId,
            product_name: item.product,
            sku: item.sku,
            quantity: parseFloat(item.qty) || 0,
            m2: parseFloat(item.m2) || 0,
            price: parseFloat(item.price) || 0,
            due_price: parseFloat(item.duePrice) || parseFloat(item.price) || 0,
            total: (parseFloat(item.qty) || 0) * (parseFloat(item.duePrice) || parseFloat(item.price) || 0)
          })),
        subtotal,
        vat,
        gross_total: grossTotal,
        total_savings: totalSavings,
        company_info: invoiceData.companyInfo
      };

      let response;
      if (editMode && editInvoiceId) {
        response = await fetch(`${API_URL}/api/proforma-invoices/${editInvoiceId}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${localStorage.getItem('token')}`
          },
          body: JSON.stringify(payload)
        });
      } else {
        response = await fetch(`${API_URL}/api/proforma-invoices`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${localStorage.getItem('token')}`
          },
          body: JSON.stringify(payload)
        });
      }

      if (!response.ok) throw new Error('Failed to save');
      
      const result = await response.json();
      toast.success(editMode ? 'Proforma Invoice updated!' : 'Proforma Invoice saved!');
      
      if (!editMode) {
        setEditMode(true);
        setEditInvoiceId(result.id);
      }
      
      // Trigger data sync event
      window.dispatchEvent(new CustomEvent('data-sync-event'));
      
    } catch (error) {
      console.error('Error saving:', error);
      toast.error('Failed to save proforma invoice');
    } finally {
      setSaving(false);
    }
  };

  // Download PDF
  const handleDownloadPdf = async () => {
    if (!editInvoiceId) {
      toast.error('Please save the invoice first');
      return;
    }

    setDownloadingPdf(true);
    try {
      const response = await fetch(`${API_URL}/api/proforma-invoices/${editInvoiceId}/pdf`, {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        }
      });

      if (!response.ok) throw new Error('Failed to download PDF');

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ProformaInvoice_${invoiceData.proformaNo}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
      
      toast.success('PDF downloaded!');
    } catch (error) {
      console.error('Error downloading PDF:', error);
      toast.error('Failed to download PDF');
    } finally {
      setDownloadingPdf(false);
    }
  };

  // Reset form
  const handleNew = () => {
    setEditMode(false);
    setEditInvoiceId(null);
    setInvoiceData({
      proformaNo: generateProformaNo(),
      date: new Date().toLocaleDateString('en-GB'),
      time: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      customerName: '',
      customerPhone: '',
      customerEmail: '',
      customerAddress: '',
      salesPerson: user?.name || '',
      validityDays: 30,
      notes: '',
      lineItems: [{ ...emptyLineItem }],
      companyInfo: { ...defaultCompanyInfo }
    });
  };

  // Calculate line total for preview
  const calculateLineTotal = (item) => {
    const qty = parseFloat(item.qty) || 0;
    const listPrice = parseFloat(item.price) || 0;
    const duePrice = parseFloat(item.duePrice) || listPrice;
    const due = qty * duePrice;
    const savings = qty * (listPrice - duePrice);
    const discountPercent = listPrice > 0 ? ((listPrice - duePrice) / listPrice) * 100 : 0;
    return { due, duePrice, savings, discountPercent };
  };

  // Scroll to preview section
  const scrollToPreview = () => {
    previewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Print preview
  const handlePrint = () => {
    const printContent = printRef.current;
    if (!printContent) return;
    
    const printWindow = window.open('', '_blank');
    printWindow.document.write(`
      <html>
        <head>
          <title>Proforma Invoice - ${invoiceData.proformaNo}</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 0; padding: 20px; }
            table { border-collapse: collapse; width: 100%; }
            th, td { border: 1px solid #ccc; padding: 8px; text-align: left; }
            @media print { body { margin: 0; } }
          </style>
        </head>
        <body>
          ${printContent.innerHTML}
        </body>
      </html>
    `);
    printWindow.document.close();
    printWindow.print();
  };

  // Open email dialog
  const handleOpenEmailDialog = () => {
    if (!editInvoiceId) {
      toast.error('Please save the invoice first');
      return;
    }
    setEmailTo(invoiceData.customerEmail || '');
    setEmailMessage('');
    setShowEmailDialog(true);
  };

  // Send email
  const handleSendEmail = async () => {
    if (!emailTo || !emailTo.includes('@')) {
      toast.error('Please enter a valid email address');
      return;
    }
    
    setSendingEmail(true);
    try {
      const response = await fetch(`${API_URL}/api/proforma-invoices/${editInvoiceId}/email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify({
          email_to: emailTo,
          message: emailMessage
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || 'Failed to send email');
      }

      toast.success(`Proforma Invoice sent to ${emailTo}`);
      setShowEmailDialog(false);
      setEmailTo('');
      setEmailMessage('');
    } catch (error) {
      toast.error(error.message || 'Failed to send email');
    } finally {
      setSendingEmail(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => navigate('/admin/epos?tab=proforma-invoice-history')}>
            <ArrowLeft className="h-4 w-4 mr-1" /> History
          </Button>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FileBadge className="h-6 w-6 text-blue-600" />
            {editMode ? 'Edit Proforma Invoice' : 'New Proforma Invoice'}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={handleNew} size="sm">
            <Plus className="h-4 w-4 mr-1" /> New
          </Button>
          <Button variant="outline" onClick={scrollToPreview} size="sm" className="text-blue-600 border-blue-300 hover:bg-blue-50">
            <Eye className="h-4 w-4 mr-1" /> Preview
          </Button>
          <Button variant="outline" onClick={handlePrint} size="sm">
            <Printer className="h-4 w-4 mr-1" /> Print
          </Button>
          <Button onClick={handleSave} disabled={saving} size="sm">
            <Save className="h-4 w-4 mr-1" /> {saving ? 'Saving...' : 'Save'}
          </Button>
          {editInvoiceId && (
            <Button variant="outline" onClick={handleDownloadPdf} disabled={downloadingPdf} size="sm">
              <Download className="h-4 w-4 mr-1" /> {downloadingPdf ? 'Downloading...' : 'PDF'}
            </Button>
          )}
          {editInvoiceId && (
            <Button 
              variant="outline" 
              onClick={handleOpenEmailDialog} 
              size="sm"
              className="text-green-600 border-green-300 hover:bg-green-50"
              data-testid="proforma-email-btn"
            >
              <Mail className="h-4 w-4 mr-1" /> Email
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Invoice Details */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">Invoice Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="text-sm font-medium block mb-2">Proforma No</label>
                <Input
                  value={invoiceData.proformaNo}
                  onChange={(e) => setInvoiceData(prev => ({ ...prev, proformaNo: e.target.value }))}
                  className="h-11 text-base font-mono"
                  data-testid="proforma-no-input"
                />
              </div>
              <div>
                <label className="text-sm font-medium block mb-2">Date</label>
                <Input
                  value={invoiceData.date}
                  onChange={(e) => setInvoiceData(prev => ({ ...prev, date: e.target.value }))}
                  className="h-11 text-base"
                  data-testid="proforma-date-input"
                />
              </div>
              <div>
                <label className="text-sm font-medium block mb-2">Valid For (Days)</label>
                <Input
                  type="number"
                  value={invoiceData.validityDays}
                  onChange={(e) => setInvoiceData(prev => ({ ...prev, validityDays: parseInt(e.target.value) || 30 }))}
                  className="h-11 text-base"
                  data-testid="proforma-validity-input"
                />
              </div>
            </div>

            {/* Store Selection */}
            {canFreelySwitchStores && availableStores.length > 0 && (
              <div>
                <label className="text-sm font-medium block mb-2">Showroom</label>
                <select
                  value={selectedStore?.id || ''}
                  onChange={(e) => {
                    const store = availableStores.find(s => s.id === e.target.value);
                    setSelectedStore(store || null);
                  }}
                  className="w-full px-3 py-3 border rounded-md text-base h-11"
                  data-testid="proforma-showroom-select"
                >
                  <option value="">Select Showroom</option>
                  {availableStores.map(store => (
                    <option key={store.id} value={store.id}>{store.name}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Customer Details */}
            <CustomerDetailsSection
              name={invoiceData.customerName}
              phone={invoiceData.customerPhone}
              email={invoiceData.customerEmail}
              address={invoiceData.customerAddress}
              onNameChange={(value) => setInvoiceData(prev => ({ ...prev, customerName: value }))}
              onPhoneChange={(value) => setInvoiceData(prev => ({ ...prev, customerPhone: value }))}
              onEmailChange={(value) => setInvoiceData(prev => ({ ...prev, customerEmail: value }))}
              onAddressChange={(value) => setInvoiceData(prev => ({ ...prev, customerAddress: value }))}
              onSelectCustomer={(customer) => {
                setInvoiceData(prev => ({
                  ...prev,
                  customerName: customer.name || '',
                  customerPhone: customer.phone || '',
                  customerEmail: customer.email || '',
                  customerAddress: customer.address || ''
                }));
              }}
              nameRequired={true}
              phoneRequired={true}
            />

            {/* Live trade-buyer chip — silent unless email/phone matches a trade account */}
            <TradeCustomerChip email={invoiceData.customerEmail} phone={invoiceData.customerPhone} />

            {/* Notes */}
            <div>
              <label className="text-sm font-medium block mb-2">Notes</label>
              <Textarea
                value={invoiceData.notes}
                onChange={(e) => setInvoiceData(prev => ({ ...prev, notes: e.target.value }))}
                placeholder="Add any notes or special instructions..."
                className="min-h-[100px] text-base"
                rows={3}
                data-testid="proforma-notes-textarea"
              />
            </div>
          </CardContent>
        </Card>

        {/* Bank Details & Summary */}
        <div className="space-y-4">
          {/* Bank Details Card */}
          <Card className="bg-blue-50 border-blue-200">
            <CardHeader className="pb-2">
              <CardTitle className="text-lg flex items-center gap-2 text-blue-800">
                <Building className="h-5 w-5" />
                Payment Details
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="grid grid-cols-2 gap-1">
                <span className="font-medium text-blue-700">Account Name:</span>
                <span className="text-blue-900">{BANK_DETAILS.name}</span>
              </div>
              <div className="grid grid-cols-2 gap-1">
                <span className="font-medium text-blue-700">Account Type:</span>
                <span className="text-blue-900">{BANK_DETAILS.accountType}</span>
              </div>
              <div className="grid grid-cols-2 gap-1">
                <span className="font-medium text-blue-700">Account No:</span>
                <span className="text-blue-900 font-mono">{BANK_DETAILS.accountNumber}</span>
              </div>
              <div className="grid grid-cols-2 gap-1">
                <span className="font-medium text-blue-700">Sort Code:</span>
                <span className="text-blue-900 font-mono">{BANK_DETAILS.sortCode}</span>
              </div>
            </CardContent>
          </Card>

          {/* Summary Card */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-lg">Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex justify-between">
                <span>Subtotal:</span>
                <span>£{subtotal.toFixed(2)}</span>
              </div>
              {totalSavings > 0 && (
                <div className="flex justify-between text-green-600">
                  <span>Savings:</span>
                  <span>£{totalSavings.toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between text-gray-600">
                <span>VAT (20%):</span>
                <span>£{vat.toFixed(2)}</span>
              </div>
              <hr />
              <div className="flex justify-between text-lg font-bold">
                <span>Total:</span>
                <span>£{grossTotal.toFixed(2)}</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Line Items */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">Line Items</CardTitle>
            <Button variant="outline" size="sm" onClick={addLineItem} data-testid="add-line-item-btn">
              <Plus className="h-4 w-4 mr-1" /> Add Item
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50">
                  <th className="text-left p-2 w-10">#</th>
                  <th className="text-left p-2 min-w-[200px]">Product</th>
                  <th className="text-left p-2 w-28">SKU</th>
                  <th className="text-right p-2 w-24">Qty</th>
                  <th className="text-right p-2 w-28">Price</th>
                  <th className="text-right p-2 w-28">Due Price</th>
                  <th className="text-right p-2 w-28">Total</th>
                  <th className="text-right p-2 w-16">Action</th>
                </tr>
              </thead>
              <tbody>
                {invoiceData.lineItems.map((item, index) => (
                  <tr key={index} className="border-b">
                    <td className="p-2 text-gray-500 font-medium">{index + 1}</td>
                    <td className="p-2 relative">
                      <Input
                        value={item.product}
                        onChange={(e) => {
                          handleLineItemChange(index, 'product', e.target.value);
                          setSearchTerm(e.target.value);
                          setActiveLineIndex(index);
                        }}
                        onFocus={() => setActiveLineIndex(index)}
                        placeholder="Search product..."
                        className="h-11 text-base"
                        data-testid={`line-item-product-${index}`}
                      />
                      {activeLineIndex === index && filteredProducts.length > 0 && (
                        <div className="absolute top-full left-0 right-0 bg-white border rounded-md shadow-lg z-50 max-h-60 overflow-y-auto">
                          {filteredProducts.slice(0, 10).map(p => (
                            <div
                              key={p.id}
                              className="p-3 hover:bg-gray-100 cursor-pointer"
                              onClick={() => selectProduct(index, p)}
                            >
                              <div className="font-medium">{p.name}</div>
                              <div className="text-xs text-gray-500">SKU: {p.sku} | £{p.price?.toFixed(2)}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="p-2">
                      <Input
                        value={item.sku}
                        onChange={(e) => handleLineItemChange(index, 'sku', e.target.value)}
                        placeholder="SKU"
                        className="h-11 text-base"
                        data-testid={`line-item-sku-${index}`}
                      />
                    </td>
                    <td className="p-2">
                      <Input
                        type="number"
                        value={item.qty}
                        onChange={(e) => handleLineItemChange(index, 'qty', e.target.value)}
                        className="text-right h-11 text-base"
                        min="0"
                        data-testid={`line-item-qty-${index}`}
                      />
                    </td>
                    <td className="p-2">
                      <Input
                        type="number"
                        value={item.price}
                        onChange={(e) => handleLineItemChange(index, 'price', e.target.value)}
                        className="text-right h-11 text-base"
                        step="0.01"
                        min="0"
                        data-testid={`line-item-price-${index}`}
                      />
                    </td>
                    <td className="p-2">
                      <Input
                        type="number"
                        value={item.duePrice}
                        onChange={(e) => handleLineItemChange(index, 'duePrice', e.target.value)}
                        className="text-right h-11 text-base"
                        step="0.01"
                        min="0"
                        data-testid={`line-item-due-price-${index}`}
                      />
                    </td>
                    <td className="p-2 text-right font-medium text-base">
                      £{((parseFloat(item.qty) || 0) * (parseFloat(item.duePrice) || parseFloat(item.price) || 0)).toFixed(2)}
                    </td>
                    <td className="p-2 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => removeLineItem(index)}
                        disabled={invoiceData.lineItems.length === 1}
                        data-testid={`remove-line-item-${index}`}
                      >
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Print Preview Section */}
      <Card className="mt-6" ref={previewRef}>
        <CardHeader>
          <CardTitle className="text-lg text-blue-800 flex items-center gap-2">
            <Eye className="h-5 w-5" />
            Print Preview
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ProformaInvoicePrintPreview
            printRef={printRef}
            invoiceData={invoiceData}
            totals={{ subtotal, vat, grossTotal, totalSavings }}
            calculateLineTotal={calculateLineTotal}
          />
        </CardContent>
      </Card>

      {/* Email Dialog */}
      <Dialog open={showEmailDialog} onOpenChange={setShowEmailDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Mail className="h-5 w-5 text-green-600" />
              Email Proforma Invoice
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <label className="text-sm font-medium block mb-2">Recipient Email</label>
              <Input
                type="email"
                value={emailTo}
                onChange={(e) => setEmailTo(e.target.value)}
                placeholder="customer@example.com"
                className="h-11"
                data-testid="proforma-email-to-input"
              />
            </div>
            <div>
              <label className="text-sm font-medium block mb-2">Message (Optional)</label>
              <Textarea
                value={emailMessage}
                onChange={(e) => setEmailMessage(e.target.value)}
                placeholder="Add a personal message to the email..."
                rows={3}
                className="min-h-[100px]"
                data-testid="proforma-email-message-input"
              />
            </div>
            <div className="bg-blue-50 p-3 rounded-lg border border-blue-200 text-sm">
              <p className="text-blue-800 font-medium mb-1">Email will include:</p>
              <ul className="text-blue-700 text-xs space-y-1">
                <li>• Proforma Invoice PDF attachment</li>
                <li>• Order summary with line items</li>
                <li>• Bank payment details for transfer</li>
                <li>• Invoice validity period ({invoiceData.validityDays} days)</li>
              </ul>
            </div>
            {!EMAIL_CONFIG.EMAIL_ENABLED && (
              <div className="bg-amber-50 p-3 rounded-lg border border-amber-200 text-sm">
                <p className="text-amber-700 font-medium">
                  ⚠️ {EMAIL_CONFIG.EMAIL_DISABLED_MESSAGE}
                </p>
              </div>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowEmailDialog(false)}>
              Cancel
            </Button>
            <Button 
              onClick={handleSendEmail} 
              disabled={sendingEmail || !EMAIL_CONFIG.EMAIL_ENABLED}
              className="bg-green-600 hover:bg-green-700"
              data-testid="proforma-send-email-btn"
            >
              <Mail className="h-4 w-4 mr-2" />
              {sendingEmail ? 'Sending...' : 'Send Email'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ProformaInvoice;

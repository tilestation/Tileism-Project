import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { FileText, Printer, Save, Plus, Trash2, Lock, ArrowLeft, Copy, Download, Mail, ExternalLink } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../../components/ui/dialog';
import { useAuth } from '../../contexts/AuthContext';
import { api } from '../../lib/api';
import { InvoiceLineItemsTable, QuotationPrintPreview } from '../../components/invoice';
import { StaffPinDialog } from '../../components/documents';
import { CustomerDetailsSection } from '../../components/CustomerDetailsSection';
import { EMAIL_CONFIG } from '../../config/emailConfig';

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
  qty: '',
  m2: '',
  product: '',
  price: '',
  duePrice: '',
  discount: 0,
  productId: '',
  sku: '',
  stock: 0,
  tile_m2_per_piece: null,
  max_discount: null
};

export const Quotation = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const printRef = useRef();
  const { user } = useAuth();
  const [products, setProducts] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [showrooms, setStores] = useState([]);
  const [suppliers, setSuppliers] = useState([]);  // Add suppliers for supplier stock display
  const [selectedStore, setSelectedStore] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [activeLineIndex, setActiveLineIndex] = useState(null);
  const [editMode, setEditMode] = useState(false);
  const [editQuotationId, setEditQuotationId] = useState(null);
  
  // PIN verification state
  const [showPinDialog, setShowPinDialog] = useState(false);
  const [staffPin, setStaffPin] = useState('');
  const [verifiedStaff, setVerifiedStaff] = useState(null);
  const [verifyingPin, setVerifyingPin] = useState(false);
  
  // Email dialog state
  const [showEmailDialog, setShowEmailDialog] = useState(false);
  const [emailTo, setEmailTo] = useState('');
  const [emailMessage, setEmailMessage] = useState('');
  const [sendingEmail, setSendingEmail] = useState(false);
  const [downloadingPdf, setDownloadingPdf] = useState(false);

  const canFreelySwitchStores = user?.role === 'super_admin' || user?.role === 'admin' || user?.role === 'manager';
  
  // Filter showrooms based on user role and assignment
  const availableStores = showrooms.filter(showroom => {
    // Super admin, admin, manager can see all showrooms
    if (user?.role === 'super_admin' || user?.role === 'admin' || user?.role === 'manager') {
      return true;
    }
    // Staff can only see their assigned showroom
    if (user?.showroom_id) {
      return showroom.id === user.showroom_id;
    }
    // If no showroom assigned, show none
    return false;
  });

  // Generate quotation number
  const generateQuotationNo = () => {
    const now = new Date();
    const dateStr = now.toISOString().slice(2, 10).replace(/-/g, '');
    const timeStr = now.getHours().toString().padStart(2, '0') + now.getMinutes().toString().padStart(2, '0');
    const random = Math.floor(Math.random() * 100).toString().padStart(2, '0');
    return `QT${dateStr}${timeStr}${random}`;
  };

  const [quotationData, setQuotationData] = useState({
    quotationNo: generateQuotationNo(),
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

  // Load edit quotation from navigation state
  useEffect(() => {
    if (location.state?.editQuotation) {
      const quotation = location.state.editQuotation;
      setEditMode(true);
      setEditQuotationId(quotation.id);
      
      const lineItems = quotation.line_items?.map(item => ({
        productId: item.product_id,
        product: item.product_name,
        sku: item.sku || '',
        qty: item.quantity.toString(),
        m2: item.m2?.toString() || '',
        price: item.price.toString(),
        duePrice: item.due_price?.toString() || item.price.toString(),
        discount: item.discount || 0,
        stock: 0,
        tile_m2_per_piece: null,
        max_discount: null
      })) || [{ ...emptyLineItem }];
      
      setQuotationData({
        quotationNo: quotation.quotation_no,
        date: quotation.date,
        time: quotation.time,
        customerName: quotation.customer_name || '',
        customerPhone: quotation.customer_phone || '',
        customerEmail: quotation.customer_email || '',
        customerAddress: quotation.customer_address || '',
        salesPerson: quotation.sales_person || '',
        validityDays: quotation.validity_days || 30,
        notes: quotation.notes || '',
        lineItems,
        companyInfo: quotation.company_info || { ...defaultCompanyInfo }
      });
    }
    
    // Handle conversion from invoice
    if (location.state?.convertFromInvoice) {
      const invoiceData = location.state.convertFromInvoice;
      
      // Generate new quotation number
      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '').slice(2);
      const timeStr = now.toTimeString().slice(0, 5).replace(':', '');
      const newQuotationNo = `QT${dateStr}${timeStr}`;
      
      const lineItems = invoiceData.lineItems?.map(item => ({
        productId: item.productId || '',
        product: item.product || '',
        sku: item.sku || '',
        qty: item.qty || '1',
        m2: item.m2 || '0',
        price: item.price || '0',
        duePrice: item.duePrice || item.price || '0',
        discount: item.discount || '0',
        stock: 0,
        tile_m2_per_piece: null,
        max_discount: null
      })) || [{ ...emptyLineItem }];
      
      setQuotationData(prev => ({
        ...prev,
        quotationNo: newQuotationNo,
        date: now.toLocaleDateString('en-GB'),
        time: now.toTimeString().slice(0, 5),
        customerName: invoiceData.customerName || '',
        customerPhone: invoiceData.customerPhone || '',
        customerEmail: invoiceData.customerEmail || '',
        customerAddress: invoiceData.customerAddress || '',
        notes: invoiceData.notes ? `Converted from Invoice ${invoiceData.fromInvoice}\n${invoiceData.notes}` : `Converted from Invoice ${invoiceData.fromInvoice}`,
        lineItems
      }));
      
      // Set store if provided
      if (invoiceData.showroom_id) {
        setSelectedStore({ id: invoiceData.showroom_id, name: invoiceData.showroom_name });
      }
      
      toast.info(`Quotation created from Invoice ${invoiceData.fromInvoice}`);
    }
  }, [location.state]);

  // Fetch products and showrooms
  useEffect(() => {
    const fetchData = async () => {
      try {
        const [productsRes, customersRes, showroomsRes, suppliersRes] = await Promise.all([
          api.getProducts(),
          api.getCustomers().catch(() => ({ data: [] })),
          api.getStores().catch(() => ({ data: [] })),
          api.getSuppliers().catch(() => ({ data: [] }))  // Fetch suppliers for stock display
        ]);
        setProducts(productsRes.data);
        setCustomers(customersRes.data || []);
        // Warehouses aren't retail stores — hide from Quotation store dropdown.
        const retailStores = (showroomsRes.data || []).filter(s => !s.is_warehouse);
        setStores(retailStores);
        setSuppliers(suppliersRes.data || []);
        
        if (retailStores.length > 0 && !selectedStore) {
          let defaultStore;
          if (user?.showroom_id) {
            defaultStore = retailStores.find(s => s.id === user.showroom_id);
          }
          if (!defaultStore) {
            defaultStore = retailStores[0];
          }
          
          setSelectedStore(defaultStore);
          
          // Parse the showroom address properly
          const addressParts = defaultStore.address?.split(',').map(p => p.trim()) || [];
          const firstLine = addressParts.slice(0, 2).join(', ');
          const restLine = addressParts.slice(2).join(', ');
          
          setQuotationData(prev => ({
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
      } catch (error) {
        toast.error('Failed to load data');
      } finally {
        setLoading(false);
      }
    };
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Calculate line item total
  const calculateLineTotal = (item) => {
    const qty = parseFloat(item.qty) || 0;
    const price = parseFloat(item.price) || 0;
    const duePrice = parseFloat(item.duePrice) || price;
    const listTotal = qty * price;
    const due = qty * duePrice;
    const savings = listTotal - due;
    const discountPercent = price > 0 ? ((price - duePrice) / price) * 100 : 0;
    
    return { listTotal, due, savings, discountPercent, duePrice };
  };

  // Capitalize first letter of every word (Title Case)
  const toTitleCase = (str) => {
    if (!str) return '';
    return str.replace(/\b\w/g, char => char.toUpperCase());
  };

  // Calculate totals
  const calculateTotals = () => {
    let totalDue = 0;
    let totalList = 0;
    
    quotationData.lineItems.forEach(item => {
      const calc = calculateLineTotal(item);
      totalDue += calc.due;
      totalList += calc.listTotal;
    });
    
    const totalSavings = totalList - totalDue;
    const vat = totalDue * 0.2;
    const grossTotal = totalDue + vat;
    
    return { totalDue, totalList, totalSavings, vat, grossTotal };
  };

  const totals = calculateTotals();

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

  // Select product for a line item
  const selectProduct = (index, product) => {
    const newItems = [...quotationData.lineItems];
    // Build product display name with size/color if available
    let productDisplayName = cleanNonePatterns(toTitleCase(product.name));
    if (product.description) {
      const sizeMatch = product.description.match(/Size:\s*([^|]+)/i);
      const colorMatch = product.description.match(/Color:\s*([^|]+)/i);
      const extras = [];
      if (sizeMatch && !sizeMatch[1].includes('None')) extras.push(sizeMatch[1].trim());
      // Only add color if it's not already in the product name
      if (colorMatch && !colorMatch[1].includes('None')) {
        const colorValue = colorMatch[1].trim();
        if (!product.name.toLowerCase().includes(colorValue.toLowerCase())) {
          extras.push(colorValue);
        }
      }
      if (extras.length > 0) {
        productDisplayName += ` (${extras.join(', ')})`;
      }
    }
    // Get showroom-specific stock
    const showroomStock = selectedStore?.id && product.showroom_stock 
      ? (product.showroom_stock[selectedStore.id] || 0)
      : product.stock;
    
    newItems[index] = {
      ...newItems[index],
      productId: product.id,
      product: productDisplayName,
      sku: product.sku || '',
      price: product.price,
      duePrice: product.price,
      stock: showroomStock,
      totalStock: product.stock,
      showroom_stock: product.showroom_stock,
      tile_m2_per_piece: product.tile_m2_per_piece || null,
      tiles_per_box: product.tiles_per_box || null,
      box_m2_coverage: product.box_m2_coverage || null,
      max_discount: product.max_discount || null
    };
    if (product.tile_m2_per_piece && newItems[index].qty) {
      const qty = parseFloat(newItems[index].qty) || 0;
      newItems[index].m2 = (qty * product.tile_m2_per_piece).toFixed(2);
    }
    setQuotationData({ ...quotationData, lineItems: newItems });
    setActiveLineIndex(null);
    setSearchTerm('');
  };

  // Update line item
  const updateLineItem = (index, field, value, syncDuePrice = false) => {
    const newItems = [...quotationData.lineItems];
    const item = newItems[index];
    
    // Handle price with duePrice sync to prevent focus loss
    if (field === 'price' && syncDuePrice) {
      const shouldSync = !item.duePrice || item.duePrice === '' || item.duePrice === item.price;
      if (shouldSync) {
        newItems[index] = { ...item, price: value, duePrice: value };
      } else {
        newItems[index] = { ...item, [field]: value };
      }
    } else {
      newItems[index] = { ...item, [field]: value };
    }
    
    // Auto-calculate m² when qty changes
    if (field === 'qty' && newItems[index].tile_m2_per_piece) {
      const qty = parseFloat(value) || 0;
      newItems[index].m2 = (qty * newItems[index].tile_m2_per_piece).toFixed(2);
    }
    
    // Auto-calculate qty (round UP) when m² changes
    if (field === 'm2' && newItems[index].tile_m2_per_piece) {
      const m2 = parseFloat(value) || 0;
      const tilesNeeded = m2 / newItems[index].tile_m2_per_piece;
      // Round UP to the nearest whole tile
      newItems[index].qty = Math.ceil(tilesNeeded).toString();
      // Recalculate actual m² based on rounded qty
      newItems[index].m2 = (Math.ceil(tilesNeeded) * newItems[index].tile_m2_per_piece).toFixed(2);
    }
    
    setQuotationData({ ...quotationData, lineItems: newItems });
  };

  // Add line item
  const addLineItem = () => {
    setQuotationData({
      ...quotationData,
      lineItems: [...quotationData.lineItems, { ...emptyLineItem }]
    });
  };

  // Remove line item
  const removeLineItem = (index) => {
    if (quotationData.lineItems.length === 1) return;
    const newItems = quotationData.lineItems.filter((_, i) => i !== index);
    setQuotationData({ ...quotationData, lineItems: newItems });
  };

  // Get box info for line item
  const getBoxInfo = (item) => {
    if (!item.tiles_per_box || !item.qty) return null;
    const qty = parseFloat(item.qty) || 0;
    const tilesPerBox = parseInt(item.tiles_per_box);
    const fullBoxes = Math.floor(qty / tilesPerBox);
    const looseTiles = qty % tilesPerBox;
    return { fullBoxes, looseTiles, tilesPerBox };
  };

  // Round up to box
  const roundUpToBox = (index) => {
    const item = quotationData.lineItems[index];
    if (!item.tiles_per_box || !item.qty) return;
    const currentQty = parseFloat(item.qty) || 0;
    const tilesPerBox = parseInt(item.tiles_per_box);
    const boxes = Math.ceil(currentQty / tilesPerBox);
    const roundedQty = boxes * tilesPerBox;
    updateLineItem(index, 'qty', roundedQty.toString());
  };

  // Select customer
  // Handle showroom change
  const handleStoreChange = (showroomId) => {
    const showroom = showrooms.find(s => s.id === showroomId);
    if (showroom) {
      setSelectedStore(showroom);
      
      // Parse the showroom address properly
      const addressParts = showroom.address?.split(',').map(p => p.trim()) || [];
      const firstLine = addressParts.slice(0, 2).join(', ');
      const restLine = addressParts.slice(2).join(', ');
      
      setQuotationData(prev => ({
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
    }
  };

  // Print quotation
  const handlePrint = () => {
    // Prevent printing if document is not saved
    if (!editMode) {
      toast.error('Please save the quotation before printing');
      return;
    }
    
    const printContent = printRef.current;
    const printWindow = window.open('', '_blank');
    
    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Quotation ${quotationData.quotationNo}</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
          body { font-family: Arial, sans-serif; padding: 20px; font-size: 12px; }
          table { width: 100%; border-collapse: collapse; margin: 20px 0; }
          th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
          th { background-color: #1e40af !important; color: #fff !important; font-weight: bold; }
          thead tr { background-color: #1e40af !important; }
          thead th { background-color: #1e40af !important; color: #fff !important; }
          .text-right { text-align: right; }
          .text-center { text-align: center; }
          @media print { 
            * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
            th { background-color: #1e40af !important; color: #fff !important; }
            thead tr { background-color: #1e40af !important; }
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

  // Verify staff PIN
  const verifyPin = async () => {
    if (staffPin.length < 4) {
      toast.error('Please enter a valid PIN');
      return;
    }
    setVerifyingPin(true);
    try {
      const res = await api.verifyStaffPin(staffPin);
      setVerifiedStaff(res.data);
      setShowPinDialog(false);
      setStaffPin('');
      toast.success(`Verified: ${res.data.name || res.data.staff_name}. Saving...`);
      // Proceed to save after verification
      setTimeout(() => handleSaveAfterVerification(res.data), 100);
    } catch (error) {
      toast.error('Invalid PIN');
      setStaffPin('');
    } finally {
      setVerifyingPin(false);
    }
  };

  // Save quotation after PIN verification
  const handleSaveAfterVerification = async (staffData) => {
    // Validate line items
    const validItems = quotationData.lineItems.filter(item => 
      (item.productId || (item.product && item.product.trim())) && item.qty && parseFloat(item.qty) > 0
    );
    
    if (validItems.length === 0) {
      toast.error('Please add at least one product with quantity');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        quotation_no: quotationData.quotationNo,
        date: quotationData.date,
        time: quotationData.time,
        showroom_id: selectedStore?.id,
        customer_name: quotationData.customerName || null,
        customer_phone: quotationData.customerPhone || null,
        customer_email: quotationData.customerEmail || null,
        customer_address: quotationData.customerAddress || null,
        sales_person: staffData?.name || staffData?.staff_name || null,
        validity_days: quotationData.validityDays,
        notes: quotationData.notes || null,
        line_items: validItems.map(item => {
          const calc = calculateLineTotal(item);
          return {
            product_id: item.productId || null,
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
        company_info: quotationData.companyInfo
      };

      if (editMode && editQuotationId) {
        await api.put(`/quotations/${editQuotationId}`, payload);
        toast.success('Quotation updated successfully');
      } else {
        const response = await api.post('/quotations', payload);
        setEditQuotationId(response.data.quotation_id);
        setEditMode(true);
        toast.success('Quotation saved successfully');
      }
    } catch (error) {
      console.error('Save error:', error);
      toast.error(error.response?.data?.detail || 'Failed to save quotation');
    } finally {
      setSaving(false);
    }
  };

  // Save quotation
  const handleSave = async () => {
    // Validate mandatory fields BEFORE PIN dialog
    if (!quotationData.customerName || !quotationData.customerName.trim()) {
      toast.error('Customer Name is required. Please enter the customer name.');
      return;
    }
    
    if (!quotationData.customerPhone || !quotationData.customerPhone.trim()) {
      toast.error('Phone Number is required. Please enter the customer phone number.');
      return;
    }
    
    // Validate phone number format (at least 10 digits)
    const phoneDigits = quotationData.customerPhone.replace(/\D/g, '');
    if (phoneDigits.length < 10) {
      toast.error('Phone number must be at least 10 digits. Please enter a valid UK phone number.');
      return;
    }
    
    // Email is optional for Quotations - only validate format if provided
    if (quotationData.customerEmail && quotationData.customerEmail.trim()) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(quotationData.customerEmail.trim())) {
        toast.error('Please enter a valid email address.');
        return;
      }
    }
    
    // Require PIN verification
    if (!verifiedStaff) {
      setShowPinDialog(true);
      return;
    }
    
    // If already verified, proceed to save
    handleSaveAfterVerification(verifiedStaff);
  };

  // Convert to Invoice
  const handleConvertToInvoice = async () => {
    // Mark the quotation as converted in the backend
    if (editQuotationId) {
      try {
        await api.convertQuotationToInvoice(editQuotationId);
      } catch (error) {
        console.error('Failed to mark quotation as converted:', error);
      }
    }
    
    // Navigate to invoice page with quotation data
    const invoiceData = {
      quotationId: editQuotationId,
      quotationNo: quotationData.quotationNo,
      customerName: quotationData.customerName,
      customerPhone: quotationData.customerPhone,
      customerEmail: quotationData.customerEmail,
      customerAddress: quotationData.customerAddress,
      salesPerson: quotationData.salesPerson,
      lineItems: quotationData.lineItems,
      notes: `Converted from Quotation: ${quotationData.quotationNo}`,
      companyInfo: quotationData.companyInfo
    };
    navigate('/admin/epos', { state: { fromQuotation: invoiceData } });
  };

  // Download PDF
  const handleDownloadPdf = async () => {
    if (!editQuotationId) {
      toast.error('Please save the quotation first');
      return;
    }
    
    setDownloadingPdf(true);
    try {
      const response = await api.downloadQuotationPdf(editQuotationId);
      const blob = new Blob([response.data], { type: 'application/pdf' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `Quotation_${quotationData.quotationNo}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
      toast.success('PDF downloaded successfully');
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to download PDF');
    } finally {
      setDownloadingPdf(false);
    }
  };

  // Open email dialog
  const handleOpenEmailDialog = () => {
    if (!editQuotationId) {
      toast.error('Please save the quotation first');
      return;
    }
    setEmailTo(quotationData.customerEmail || '');
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
      await api.emailQuotationPdf(editQuotationId, emailTo, emailMessage);
      toast.success(`Quotation sent to ${emailTo}`);
      setShowEmailDialog(false);
      setEmailTo('');
      setEmailMessage('');
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to send email');
    } finally {
      setSendingEmail(false);
    }
  };

  // New quotation
  const handleNewQuotation = () => {
    setEditMode(false);
    setEditQuotationId(null);
    setQuotationData({
      quotationNo: generateQuotationNo(),
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
      companyInfo: selectedStore ? {
        name: 'Tile Station',
        address: selectedStore.address?.split(',')[0] || defaultCompanyInfo.address,
        city: selectedStore.address?.split(',').slice(1).join(',').trim() || defaultCompanyInfo.city,
        telephone: selectedStore.phone || defaultCompanyInfo.telephone,
        email: selectedStore.email || defaultCompanyInfo.email,
        companyNo: defaultCompanyInfo.companyNo,
        vatNo: defaultCompanyInfo.vatNo
      } : { ...defaultCompanyInfo }
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-8">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" onClick={() => navigate('/admin')}>
            <ArrowLeft className="h-4 w-4 mr-1" /> Back
          </Button>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FileText className="h-6 w-6 text-blue-600" />
            {editMode ? 'Edit Quotation' : 'New Quotation'}
          </h1>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button variant="outline" onClick={handleNewQuotation} data-testid="new-quotation-btn">
            <Plus className="h-4 w-4 mr-1" /> New
          </Button>
          <Button 
            variant="outline" 
            onClick={() => window.open('/admin/quotation', '_blank')}
            title="Open new quotation in separate tab"
            data-testid="open-quotation-new-tab-btn"
          >
            <ExternalLink className="h-4 w-4" />
          </Button>
          <Button 
            variant="outline" 
            onClick={handlePrint} 
            disabled={!editMode}
            title={!editMode ? 'Save the quotation first to enable printing' : 'Print quotation'}
            data-testid="print-quotation-btn"
          >
            <Printer className="h-4 w-4 mr-1" /> Print
          </Button>
          {editMode && (
            <>
              <Button 
                variant="outline" 
                onClick={handleDownloadPdf} 
                disabled={downloadingPdf}
                data-testid="download-pdf-btn"
              >
                <Download className="h-4 w-4 mr-1" /> {downloadingPdf ? 'Downloading...' : 'PDF'}
              </Button>
              {EMAIL_CONFIG.EMAIL_ENABLED && (
                <Button 
                  variant="outline" 
                  onClick={handleOpenEmailDialog}
                  className="text-green-600 border-green-300 hover:bg-green-50"
                  data-testid="email-quotation-btn"
                >
                  <Mail className="h-4 w-4 mr-1" /> Email
                </Button>
              )}
            </>
          )}
          <Button onClick={handleSave} disabled={saving} className="bg-blue-600 hover:bg-blue-700" data-testid="save-quotation-btn">
            <Save className="h-4 w-4 mr-1" /> {saving ? 'Saving...' : 'Save'}
          </Button>
          {editMode && (
            <Button variant="secondary" onClick={handleConvertToInvoice} data-testid="convert-to-invoice-btn">
              <Copy className="h-4 w-4 mr-1" /> Convert to Invoice
            </Button>
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column - Form */}
        <div className="lg:col-span-2 space-y-6">
          {/* Quotation Details Card */}
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="text-lg">Quotation Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <label className="text-sm font-medium mb-1 block">Quotation No</label>
                  <Input
                    value={quotationData.quotationNo}
                    onChange={(e) => setQuotationData({ ...quotationData, quotationNo: e.target.value })}
                    className="font-mono"
                    data-testid="quotation-no-input"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium mb-1 block">Date</label>
                  <Input
                    value={quotationData.date}
                    onChange={(e) => setQuotationData({ ...quotationData, date: e.target.value })}
                    data-testid="quotation-date-input"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium mb-1 block">Valid For (Days)</label>
                  <Input
                    type="number"
                    min="1"
                    value={quotationData.validityDays}
                    onChange={(e) => setQuotationData({ ...quotationData, validityDays: parseInt(e.target.value) || 30 })}
                    data-testid="validity-days-input"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium mb-1 block flex items-center gap-2">
                    Store
                    {!canFreelySwitchStores && user?.showroom_id && (
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Lock className="h-3 w-3" /> Your showroom
                      </span>
                    )}
                  </label>
                  <select
                    className="w-full px-3 py-2 border rounded-md"
                    value={selectedStore?.id || ''}
                    onChange={(e) => handleStoreChange(e.target.value)}
                    disabled={!canFreelySwitchStores && user?.showroom_id}
                    data-testid="quotation-showroom-select"
                  >
                    {availableStores.map(showroom => (
                      <option key={showroom.id} value={showroom.id}>{showroom.name}</option>
                    ))}
                  </select>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Customer Details Card */}
          <Card>
            <CardContent className="pt-6">
              <CustomerDetailsSection
                name={quotationData.customerName}
                phone={quotationData.customerPhone}
                email={quotationData.customerEmail}
                address={quotationData.customerAddress}
                onNameChange={(val) => setQuotationData({ ...quotationData, customerName: val })}
                onPhoneChange={(val) => setQuotationData({ ...quotationData, customerPhone: val })}
                onEmailChange={(val) => setQuotationData({ ...quotationData, customerEmail: val })}
                onAddressChange={(val) => setQuotationData({ ...quotationData, customerAddress: val })}
                onSelectCustomer={(customer) => {
                  setQuotationData(prev => ({
                    ...prev,
                    customerName: customer.name || '',
                    customerPhone: customer.phone || '',
                    customerEmail: customer.email || '',
                    customerAddress: customer.address || ''
                  }));
                }}
                onClear={() => {
                  setQuotationData(prev => ({
                    ...prev,
                    customerName: '',
                    customerPhone: '',
                    customerEmail: '',
                    customerAddress: ''
                  }));
                }}
                nameRequired={true}
                phoneRequired={true}
                toTitleCase={toTitleCase}
              />
            </CardContent>
          </Card>

          {/* Line Items */}
          <Card>
            <CardContent className="pt-6">
              <InvoiceLineItemsTable
                lineItems={quotationData.lineItems}
                products={products}
                searchTerm={searchTerm}
                activeLineIndex={activeLineIndex}
                authorizedDiscounts={{}}
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
                getMinAllowedPrice={() => 0}
                isDiscountExceeded={() => false}
                getBoxInfo={getBoxInfo}
                totals={totals}
                showReturnColumn={false}
              />
            </CardContent>
          </Card>

          {/* Notes */}
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="text-lg">Quotation Notes</CardTitle>
            </CardHeader>
            <CardContent>
              <textarea
                className="w-full px-3 py-2 border rounded-md min-h-[100px]"
                value={quotationData.notes}
                onChange={(e) => setQuotationData({ ...quotationData, notes: e.target.value })}
                onBlur={(e) => setQuotationData({ ...quotationData, notes: toTitleCase(e.target.value) })}
                placeholder="Add any notes or special conditions for this quotation..."
                data-testid="quotation-notes-textarea"
              />
            </CardContent>
          </Card>
        </div>

        {/* Right Column - Summary & Preview */}
        <div className="space-y-6">
          {/* Summary Card */}
          <Card className="sticky top-4">
            <CardHeader className="pb-4 bg-blue-50">
              <CardTitle className="text-lg text-blue-800">Quotation Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 pt-4">
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>Subtotal (excl. VAT)</span>
                  <span>£{totals.totalDue.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span>VAT (20%)</span>
                  <span>£{totals.vat.toFixed(2)}</span>
                </div>
                <div className="flex justify-between font-bold text-lg border-t pt-2">
                  <span>Total (incl. VAT)</span>
                  <span className="text-blue-600">£{totals.grossTotal.toFixed(2)}</span>
                </div>
                {totals.totalSavings > 0 && (
                  <div className="flex justify-between text-sm text-green-600 bg-green-50 p-2 rounded">
                    <span>Customer Saves</span>
                    <span>£{totals.totalSavings.toFixed(2)}</span>
                  </div>
                )}
              </div>
              
              <div className="border-t pt-4 text-sm text-gray-600">
                <p className="flex items-center gap-1">
                  <span className="font-medium">Valid for:</span> {quotationData.validityDays} days
                </p>
                {quotationData.lineItems.filter(i => i.product).length > 0 && (
                  <p>• Items: {quotationData.lineItems.filter(i => i.product).length} product(s)</p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Print Preview */}
      <Card className="mt-8">
        <CardHeader>
          <CardTitle className="text-lg text-blue-800">Print Preview</CardTitle>
        </CardHeader>
        <CardContent>
          <QuotationPrintPreview
            printRef={printRef}
            quotationData={quotationData}
            totals={totals}
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
              Email Quotation
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Quotation</label>
              <div className="text-sm text-muted-foreground bg-gray-50 p-2 rounded">
                {quotationData.quotationNo} - £{totals.grossTotal.toFixed(2)}
              </div>
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Send to Email *</label>
              <Input
                type="email"
                placeholder="customer@example.com"
                value={emailTo}
                onChange={(e) => setEmailTo(e.target.value)}
                data-testid="email-to-input"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Personal Message (optional)</label>
              <textarea
                className="w-full px-3 py-2 border rounded-md min-h-[80px] text-sm"
                placeholder="Add a personal message to the email..."
                value={emailMessage}
                onChange={(e) => setEmailMessage(e.target.value)}
                data-testid="email-message-input"
              />
            </div>
            <div className="text-xs text-muted-foreground bg-blue-50 p-2 rounded">
              📎 The quotation PDF will be attached to the email automatically.
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEmailDialog(false)}>
              Cancel
            </Button>
            <Button 
              onClick={handleSendEmail} 
              disabled={sendingEmail || !emailTo}
              className="bg-green-600 hover:bg-green-700"
              data-testid="send-email-btn"
            >
              <Mail className="h-4 w-4 mr-1" />
              {sendingEmail ? 'Sending...' : 'Send Email'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Staff PIN Dialog */}
      <StaffPinDialog
        open={showPinDialog}
        onOpenChange={setShowPinDialog}
        staffPin={staffPin}
        onPinChange={setStaffPin}
        verifiedStaff={verifiedStaff}
        verifyingPin={verifyingPin}
        onVerify={verifyPin}
        description="Enter your staff PIN to save this quotation. Your name will be recorded as the sales person."
      />
    </div>
  );
};

export default Quotation;

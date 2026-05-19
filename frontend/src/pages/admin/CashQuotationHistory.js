import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { 
  FileText, 
  Search, 
  Edit, 
  Trash2, 
  Copy, 
  Eye,
  ArrowLeft,
  Filter,
  Calendar,
  CheckCircle,
  Clock,
  XCircle,
  RotateCcw,
  Download,
  Mail,
  MessageCircle
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { Textarea } from '../../components/ui/textarea';
import { api } from '../../lib/api';
import { useAuth } from '../../contexts/AuthContext';

// Capitalize first letter of every word (Title Case)
const toTitleCase = (str) => {
  if (!str) return '';
  return str.replace(/\b\w/g, char => char.toUpperCase());
};

export const CashQuotationHistory = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';
  const [quotations, setQuotations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [quotationToDelete, setQuotationToDelete] = useState(null);
  const [viewDialogOpen, setViewDialogOpen] = useState(false);
  const [selectedQuotation, setSelectedQuotation] = useState(null);
  
  // Email dialog state
  const [showEmailDialog, setShowEmailDialog] = useState(false);
  const [emailQuotation, setEmailQuotation] = useState(null);
  const [emailAddress, setEmailAddress] = useState('');
  const [emailMessage, setEmailMessage] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    fetchQuotations();
    
    // Listen for data sync events from other pages
    const handleDataSync = () => {
      console.log('[CashQuotationHistory] Data sync event received');
      fetchQuotations();
    };
    
    window.addEventListener('data-sync-event', handleDataSync);
    window.addEventListener('dataSync', handleDataSync);
    
    return () => {
      window.removeEventListener('data-sync-event', handleDataSync);
      window.removeEventListener('dataSync', handleDataSync);
    };
  }, []);

  const fetchQuotations = async () => {
    try {
      const response = await api.getCashQuotations();
      setQuotations(response.data || []);
    } catch (error) {
      toast.error('Failed to load quotations');
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = (quotation) => {
    navigate('/admin/cash-quotation', { state: { editQuotation: quotation } });
  };

  const handleConvertToInvoice = async (quotation) => {
    try {
      // DO NOT mark as converted here - will be marked AFTER invoice is saved
      // This prevents orphaned "converted" quotations when user doesn't complete the invoice

      // Invoice date = TODAY (see QuotationHistory.handleConvertToInvoice for full rationale).
      // The cash quotation is just an offer; the sale happens on the day the
      // customer pays cash and walks out with the goods.
      const today = new Date().toLocaleDateString('en-GB');
      const now = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

      // Prepare invoice data from cash quotation - Cash quotations are typically fully paid
      const invoiceData = {
        quotationId: quotation.id,  // Pass ID so Invoice.js can mark as converted after save
        quotationNo: quotation.quotation_no,
        // Today's date — cash takings should land on the day they're physically received.
        date: today,
        time: now,
        originalQuotationDate: quotation.date,
        customerName: quotation.customer_name,
        customerPhone: quotation.customer_phone,
        customerEmail: quotation.customer_email,
        customerAddress: quotation.customer_address,
        salesPerson: quotation.sales_person,
        showroom_id: quotation.showroom_id,
        showroom_name: quotation.showroom_name,
        paymentMethod: 'Cash', // Cash quotations default to cash payment
        lineItems: quotation.line_items?.map(item => ({
          productId: item.product_id || '',
          product: item.product_name || '',
          sku: item.sku || '',
          qty: item.quantity?.toString() || '',
          m2: item.m2?.toString() || '',
          price: item.price?.toString() || '',
          duePrice: item.due_price?.toString() || item.price?.toString() || '',
          discount: item.discount || 0
        })) || [],
        notes: `Converted from Cash Quotation: ${quotation.quotation_no} (originally dated ${quotation.date})`,
        companyInfo: quotation.company_info,
        isCashQuotation: true, // Flag to indicate this is from a cash quotation - NO VAT
        noVat: true // Explicit no VAT flag
      };
      
      console.log('[CashQuotationHistory] Converting to invoice with data:', invoiceData);
      console.log('[CashQuotationHistory] isCashQuotation:', invoiceData.isCashQuotation);
      console.log('[CashQuotationHistory] quotationId for post-save conversion:', invoiceData.quotationId);
      
      // Navigate to invoice page with pre-filled data for user to review and save
      // Quotation will be marked as converted ONLY when invoice is successfully saved
      navigate('/admin/invoice', { state: { fromQuotation: invoiceData } });
      toast.info('Cash quotation loaded - Save the invoice to complete conversion');
      
    } catch (error) {
      console.error('Convert error:', error);
      const errorMessage = error.response?.data?.detail || 'Failed to convert quotation';
      toast.error(errorMessage);
    }
  };

  const handleDelete = async () => {
    if (!quotationToDelete) return;
    
    const deletedId = quotationToDelete.id;
    
    try {
      await api.deleteCashQuotation(deletedId);
      toast.success('Quotation deleted');
      
      // Immediately update local state for instant UI feedback
      setQuotations(prev => prev.filter(q => q.id !== deletedId));
      
      // Dispatch data sync events for other components
      window.dispatchEvent(new CustomEvent('data-sync-event'));
      window.dispatchEvent(new CustomEvent('dataSync'));
      localStorage.setItem('dataSync', Date.now().toString());
      
      // Refetch for consistency
      fetchQuotations();
    } catch (error) {
      toast.error('Failed to delete quotation');
    } finally {
      setDeleteDialogOpen(false);
      setQuotationToDelete(null);
    }
  };

  // Revert converted cash quotation back to active (Super Admin only)
  const handleRevertToActive = async (quotation) => {
    try {
      await api.revertCashQuotationToActive(quotation.id);
      toast.success(`Cash quotation ${quotation.quotation_no} reverted to active`);
      fetchQuotations();
      
      // Dispatch data sync events
      window.dispatchEvent(new CustomEvent('data-sync-event'));
      window.dispatchEvent(new CustomEvent('dataSync'));
    } catch (error) {
      const errorMessage = error.response?.data?.detail || 'Failed to revert quotation';
      toast.error(errorMessage);
    }
  };

  const getStatusBadge = (quotation) => {
    const isExpired = new Date(quotation.expiry_date) < new Date();
    
    if (quotation.status === 'converted') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
          <CheckCircle className="h-3 w-3" /> Converted
        </span>
      );
    } else if (isExpired) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-red-100 text-red-800">
          <XCircle className="h-3 w-3" /> Expired
        </span>
      );
    } else {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
          <Clock className="h-3 w-3" /> Active
        </span>
      );
    }
  };

  // Download PDF
  const handleDownloadPdf = async (quotation) => {
    try {
      const response = await api.downloadCashQuotationPdf(quotation.id);
      const blob = new Blob([response.data], { type: 'application/pdf' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${quotation.quotation_no}.pdf`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      toast.success('PDF downloaded');
    } catch (error) {
      toast.error('Failed to download PDF');
    }
  };

  // Open email dialog
  const handleEmailClick = (quotation) => {
    setEmailQuotation(quotation);
    setEmailAddress(quotation.customer_email || '');
    setEmailMessage('');
    setShowEmailDialog(true);
  };

  // Send email
  const handleSendEmail = async () => {
    if (!emailAddress) {
      toast.error('Please enter an email address');
      return;
    }
    setSending(true);
    try {
      await api.emailCashQuotationPdf(emailQuotation.id, emailAddress, emailMessage);
      toast.success('Cash quotation sent via email');
      setShowEmailDialog(false);
      setEmailAddress('');
      setEmailMessage('');
    } catch (error) {
      toast.error('Failed to send email');
    } finally {
      setSending(false);
    }
  };

  // Share via WhatsApp
  const handleShareWhatsApp = async (quotation) => {
    try {
      const message = `Cash Quotation ${quotation.quotation_no}\n` +
        `Customer: ${quotation.customer_name || 'N/A'}\n` +
        `Total: £${quotation.total?.toFixed(2) || quotation.subtotal?.toFixed(2) || '0.00'}\n` +
        `Valid until: ${quotation.expiry_date ? new Date(quotation.expiry_date).toLocaleDateString('en-GB') : 'N/A'}`;
      
      let phoneForWA = quotation.customer_phone?.replace(/\D/g, '');
      if (phoneForWA && phoneForWA.startsWith('0')) {
        phoneForWA = '44' + phoneForWA.slice(1);
      }
      
      const whatsappUrl = phoneForWA 
        ? `https://wa.me/${phoneForWA}?text=${encodeURIComponent(message)}`
        : `https://wa.me/?text=${encodeURIComponent(message)}`;
      
      window.open(whatsappUrl, '_blank');
      toast.success('Opening WhatsApp...');
    } catch (error) {
      toast.error('Failed to share via WhatsApp');
    }
  };

  const filteredQuotations = quotations.filter(q => {
    const matchesSearch = 
      q.quotation_no?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      q.customer_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      q.customer_phone?.includes(searchTerm);
    
    if (statusFilter === 'all') return matchesSearch;
    if (statusFilter === 'active') {
      const isExpired = new Date(q.expiry_date) < new Date();
      return matchesSearch && q.status !== 'converted' && !isExpired;
    }
    if (statusFilter === 'converted') return matchesSearch && q.status === 'converted';
    if (statusFilter === 'expired') {
      const isExpired = new Date(q.expiry_date) < new Date();
      return matchesSearch && isExpired && q.status !== 'converted';
    }
    return matchesSearch;
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" onClick={() => navigate('/admin')}>
            <ArrowLeft className="h-4 w-4 mr-1" /> Back
          </Button>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FileText className="h-6 w-6 text-blue-600" />
            Cash Quotation History
          </h1>
        </div>
        <Button onClick={() => navigate('/admin/cash-quotation')} className="bg-blue-600 hover:bg-blue-700">
          <FileText className="h-4 w-4 mr-1" /> New Quotation
        </Button>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col md:flex-row gap-4">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <Input
                placeholder="Search by quotation number, customer name or phone..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
              />
            </div>
            <div className="flex gap-2">
              <select
                className="px-3 py-2 border rounded-md text-sm"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="all">All Status</option>
                <option value="active">Active</option>
                <option value="converted">Converted</option>
                <option value="expired">Expired</option>
              </select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-center">
              <p className="text-2xl font-bold text-blue-600">{quotations.length}</p>
              <p className="text-sm text-gray-600">Total Quotations</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-center">
              <p className="text-2xl font-bold text-green-600">
                {quotations.filter(q => q.status !== 'converted' && new Date(q.expiry_date) >= new Date()).length}
              </p>
              <p className="text-sm text-gray-600">Active</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-center">
              <p className="text-2xl font-bold text-purple-600">
                {quotations.filter(q => q.status === 'converted').length}
              </p>
              <p className="text-sm text-gray-600">Converted</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-center">
              <p className="text-2xl font-bold text-red-600">
                {quotations.filter(q => new Date(q.expiry_date) < new Date() && q.status !== 'converted').length}
              </p>
              <p className="text-sm text-gray-600">Expired</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Quotations Table */}
      <Card>
        <CardContent className="pt-6">
          {filteredQuotations.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              <FileText className="h-12 w-12 mx-auto mb-4 opacity-30" />
              <p className="text-lg font-medium">No quotations found</p>
              <p className="text-sm mt-1">Create your first quotation to get started</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b bg-gray-50">
                    <th className="text-left py-3 px-4 font-medium text-sm">Quotation No</th>
                    <th className="text-left py-3 px-4 font-medium text-sm">Date</th>
                    <th className="text-left py-3 px-4 font-medium text-sm">Customer</th>
                    <th className="text-left py-3 px-4 font-medium text-sm">Created By</th>
                    <th className="text-left py-3 px-4 font-medium text-sm">Items</th>
                    <th className="text-right py-3 px-4 font-medium text-sm">Total</th>
                    <th className="text-center py-3 px-4 font-medium text-sm">Expires</th>
                    <th className="text-center py-3 px-4 font-medium text-sm">Status</th>
                    <th className="text-center py-3 px-4 font-medium text-sm">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredQuotations.map((quotation) => (
                    <tr key={quotation.id} className="border-b hover:bg-gray-50">
                      <td className="py-3 px-4">
                        <span className="font-mono text-sm font-medium text-blue-600">
                          {quotation.quotation_no}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-sm">{quotation.date}</td>
                      <td className="py-3 px-4">
                        <div>
                          <p className="font-medium text-sm">{quotation.customer_name || '-'}</p>
                          <p className="text-xs text-gray-500">{quotation.customer_phone || ''}</p>
                        </div>
                      </td>
                      <td className="py-3 px-4 text-sm">
                        {quotation.staff_name || quotation.sales_person || quotation.created_by || '-'}
                      </td>
                      <td className="py-3 px-4 text-sm">
                        {quotation.line_items?.length || 0} item(s)
                      </td>
                      <td className="py-3 px-4 text-right font-medium">
                        £{quotation.total?.toFixed(2) || quotation.subtotal?.toFixed(2) || '0.00'}
                      </td>
                      <td className="py-3 px-4 text-center text-sm">
                        {quotation.expiry_date ? new Date(quotation.expiry_date).toLocaleDateString('en-GB') : '-'}
                      </td>
                      <td className="py-3 px-4 text-center">
                        {getStatusBadge(quotation)}
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center justify-center gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setSelectedQuotation(quotation);
                              setViewDialogOpen(true);
                            }}
                            title="View Details"
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDownloadPdf(quotation)}
                            title="Download PDF"
                          >
                            <Download className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleEmailClick(quotation)}
                            title="Send via Email"
                          >
                            <Mail className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleShareWhatsApp(quotation)}
                            title="Share via WhatsApp"
                            className="text-green-600 hover:text-green-700"
                          >
                            <MessageCircle className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleEdit(quotation)}
                            title="Edit"
                            disabled={quotation.status === 'converted'}
                          >
                            <Edit className="h-4 w-4" />
                          </Button>
                          {quotation.status !== 'converted' && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleConvertToInvoice(quotation)}
                              title="Convert to Invoice"
                              className="text-blue-600 hover:text-blue-700"
                            >
                              <Copy className="h-4 w-4" />
                            </Button>
                          )}
                          {quotation.status === 'converted' && isSuperAdmin && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleRevertToActive(quotation)}
                              title="Revert to Active (Super Admin)"
                              className="text-orange-600 hover:text-orange-700"
                            >
                              <RotateCcw className="h-4 w-4" />
                            </Button>
                          )}
                          {isSuperAdmin && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setQuotationToDelete(quotation);
                              setDeleteDialogOpen(true);
                            }}
                            title="Delete (Super Admin only)"
                            className="text-red-600 hover:text-red-700"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Quotation</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete quotation <strong>{quotationToDelete?.quotation_no}</strong>? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* View Quotation Dialog */}
      <Dialog open={viewDialogOpen} onOpenChange={setViewDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-blue-600" />
              Quotation: {selectedQuotation?.quotation_no}
            </DialogTitle>
          </DialogHeader>
          
          {selectedQuotation && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-gray-500">Date</p>
                  <p className="font-medium">{selectedQuotation.date} {selectedQuotation.time}</p>
                </div>
                <div>
                  <p className="text-gray-500">Status</p>
                  {getStatusBadge(selectedQuotation)}
                </div>
                <div>
                  <p className="text-gray-500">Customer</p>
                  <p className="font-medium">{selectedQuotation.customer_name || '-'}</p>
                </div>
                <div>
                  <p className="text-gray-500">Phone</p>
                  <p className="font-medium">{selectedQuotation.customer_phone || '-'}</p>
                </div>
                <div>
                  <p className="text-gray-500">Valid Until</p>
                  <p className="font-medium">
                    {selectedQuotation.expiry_date 
                      ? new Date(selectedQuotation.expiry_date).toLocaleDateString('en-GB')
                      : '-'}
                  </p>
                </div>
                <div>
                  <p className="text-gray-500">Sales Person</p>
                  <p className="font-medium">{selectedQuotation.sales_person || '-'}</p>
                </div>
              </div>

              <div className="border-t pt-4">
                <p className="font-medium mb-2">Line Items</p>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-gray-50">
                      <th className="text-left py-2 px-2 min-w-[200px]">Product</th>
                      <th className="text-center py-2 px-2 w-20">Qty</th>
                      <th className="text-right py-2 px-2 w-24">Price</th>
                      <th className="text-right py-2 px-2 w-24">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedQuotation.line_items?.map((item, idx) => (
                      <tr key={idx} className="border-b">
                        <td className="py-2 px-2">{toTitleCase(item.product_name)}</td>
                        <td className="py-2 px-2 text-center">{item.quantity}</td>
                        <td className="py-2 px-2 text-right">£{item.due_price?.toFixed(2) || item.price?.toFixed(2)}</td>
                        <td className="py-2 px-2 text-right">£{item.total?.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="border-t pt-4 flex justify-end">
                <div className="text-right space-y-1">
                  <p className="text-sm">Subtotal: £{selectedQuotation.subtotal?.toFixed(2)}</p>
                  <p className="text-sm">VAT (20%): £{selectedQuotation.vat?.toFixed(2)}</p>
                  <p className="text-lg font-bold text-blue-600">
                    Total: £{selectedQuotation.gross_total?.toFixed(2)}
                  </p>
                </div>
              </div>

              {selectedQuotation.notes && (
                <div className="border-t pt-4">
                  <p className="text-gray-500 text-sm">Notes</p>
                  <p className="text-sm mt-1">{selectedQuotation.notes}</p>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setViewDialogOpen(false)}>
              Close
            </Button>
            <Button variant="outline" onClick={() => handleDownloadPdf(selectedQuotation)}>
              <Download className="h-4 w-4 mr-1" /> Download
            </Button>
            <Button variant="outline" onClick={() => handleEmailClick(selectedQuotation)}>
              <Mail className="h-4 w-4 mr-1" /> Email
            </Button>
            <Button variant="outline" className="text-green-600" onClick={() => handleShareWhatsApp(selectedQuotation)}>
              <MessageCircle className="h-4 w-4 mr-1" /> WhatsApp
            </Button>
            {selectedQuotation?.status !== 'converted' && (
              <>
                <Button variant="outline" onClick={() => {
                  handleEdit(selectedQuotation);
                  setViewDialogOpen(false);
                }}>
                  <Edit className="h-4 w-4 mr-1" /> Edit
                </Button>
                <Button 
                  className="bg-blue-600 hover:bg-blue-700"
                  onClick={() => {
                    handleConvertToInvoice(selectedQuotation);
                    setViewDialogOpen(false);
                  }}
                >
                  <Copy className="h-4 w-4 mr-1" /> Convert to Invoice
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Email Dialog */}
      <Dialog open={showEmailDialog} onOpenChange={setShowEmailDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send Cash Quotation via Email</DialogTitle>
            <DialogDescription>
              Send {emailQuotation?.quotation_no} to customer via email
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">Email Address</label>
              <Input
                type="email"
                placeholder="customer@email.com"
                value={emailAddress}
                onChange={(e) => setEmailAddress(e.target.value)}
              />
            </div>
            <div>
              <label className="text-sm font-medium">Message (Optional)</label>
              <Textarea
                placeholder="Add a personal message..."
                value={emailMessage}
                onChange={(e) => setEmailMessage(e.target.value)}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEmailDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleSendEmail} disabled={sending}>
              {sending ? 'Sending...' : 'Send Email'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default CashQuotationHistory;

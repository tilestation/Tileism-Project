import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
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
  MessageCircle,
  AlertTriangle,
  Link2,
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

export const QuotationHistory = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';
  const [quotations, setQuotations] = useState([]);
  const [loading, setLoading] = useState(true);
  // 6 Jun 2026 — deep-link support. When the page mounts with
  // `?search=QT-XXXX` (e.g. from a Staff Competition Dashboard
  // drawer row), seed the search term so the admin lands directly
  // on the quote they clicked.
  const [searchTerm, setSearchTerm] = useState(() => {
    try {
      const params = new URLSearchParams(location?.search || window.location.search);
      return params.get('search') || '';
    } catch { return ''; }
  });
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
  
  // Orphan audit state: quotes marked "converted" but with no linked invoice
  const [orphanAudit, setOrphanAudit] = useState({ count: 0, orphans: [] });
  const [showOrphanList, setShowOrphanList] = useState(false);
  // Link-invoice modal state (4 Jun 2026 — manual invoice linking
  // for orphan quotes when the invoice EXISTS but under a different
  // number. Reverting in that case would force the staff to redo a
  // sale they've already saved).
  const [linkDialog, setLinkDialog] = useState({ open: false, quote: null });
  const [linkSearch, setLinkSearch] = useState('');
  const [linkResults, setLinkResults] = useState([]);
  const [linkSearching, setLinkSearching] = useState(false);
  const [linking, setLinking] = useState(false);

  useEffect(() => {
    fetchQuotations();
    fetchOrphanAudit();
    
    // Listen for data sync events from other pages
    const handleDataSync = () => {
      console.log('[QuotationHistory] Data sync event received');
      fetchQuotations();
      fetchOrphanAudit();
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
      const response = await api.getQuotations();
      setQuotations(response.data || []);
    } catch (error) {
      toast.error('Failed to load quotations');
    } finally {
      setLoading(false);
    }
  };

  const fetchOrphanAudit = async () => {
    try {
      const response = await api.getOrphanConvertedQuotations();
      setOrphanAudit(response.data || { count: 0, orphans: [] });
    } catch (error) {
      // Non-fatal — banner just won't show
      console.warn('[QuotationHistory] Orphan audit unavailable:', error?.message);
    }
  };

  // Open the "link existing invoice" modal for a single orphan quote.
  const openLinkDialog = (orphan) => {
    setLinkDialog({ open: true, quote: orphan });
    // Pre-seed the search with the customer's name — typical case is
    // the admin recognises the invoice by customer + total.
    const seed = (orphan?.customer_name || '').slice(0, 40);
    setLinkSearch(seed);
    setLinkResults([]);
    if (seed.length >= 2) {
      runInvoiceSearch(seed);
    }
  };

  const runInvoiceSearch = async (term) => {
    if (!term || term.trim().length < 2) {
      setLinkResults([]);
      return;
    }
    setLinkSearching(true);
    try {
      const res = await api.searchInvoicesForLinking(term.trim(), 30);
      setLinkResults(res.data?.invoices || []);
    } catch (err) {
      toast.error(`Couldn't search invoices: ${err?.response?.data?.detail || err.message}`);
      setLinkResults([]);
    } finally {
      setLinkSearching(false);
    }
  };

  const handleLinkInvoice = async (invoice) => {
    if (!linkDialog.quote || !invoice) return;
    setLinking(true);
    try {
      await api.linkInvoiceToQuotation(linkDialog.quote.id, invoice.id);
      toast.success(
        `Linked ${linkDialog.quote.quotation_no} → ${invoice.invoice_no}`,
        { description: 'Sales totals will reflect this on the next refresh.' },
      );
      setLinkDialog({ open: false, quote: null });
      setLinkSearch('');
      setLinkResults([]);
      await fetchOrphanAudit();
      await fetchQuotations();
    } catch (err) {
      toast.error(`Couldn't link: ${err?.response?.data?.detail || err.message}`);
    } finally {
      setLinking(false);
    }
  };

  // Debounced search as the admin types.
  useEffect(() => {
    if (!linkDialog.open) return undefined;
    const t = setTimeout(() => runInvoiceSearch(linkSearch), 300);
    return () => clearTimeout(t);
  }, [linkSearch, linkDialog.open]);

  const handleEdit = (quotation) => {
    navigate('/admin/quotation', { state: { editQuotation: quotation } });
  };

  const handleConvertToInvoice = async (quotation) => {
    try {
      // DO NOT mark as converted here — will be marked AFTER invoice is saved.
      // This prevents orphaned "converted" quotations when the user doesn't complete
      // (or closes) the invoice form, which would otherwise hide the quote from the
      // active list and never record a matching invoice/sale.

      // Invoice date = TODAY, not the quotation date.
      // 24 Feb 2026 — quotations are valid for ~30 days but the SALE only
      // happens when the customer accepts. Carrying the quote's date forward
      // attributed revenue to the wrong day (sometimes weeks in the past)
      // and broke daily/weekly sales totals. Customer can manually backdate
      // on the invoice form if a different date is genuinely needed.
      const today = new Date().toLocaleDateString('en-GB');
      const now = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

      // Prepare invoice data from quotation
      const invoiceData = {
        quotationId: quotation.id,      // Invoice.js will call convert-to-invoice after save
        quotationNo: quotation.quotation_no,
        // Today's date — sales revenue lands on the day the order is placed.
        date: today,
        time: now,
        originalQuotationDate: quotation.date,  // surfaced in the invoice for reference
        customerName: quotation.customer_name,
        customerPhone: quotation.customer_phone,
        customerEmail: quotation.customer_email,
        customerAddress: quotation.customer_address,
        salesPerson: quotation.sales_person,
        showroom_id: quotation.showroom_id,
        showroom_name: quotation.showroom_name,
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
        notes: `Converted from Quotation: ${quotation.quotation_no} (originally dated ${quotation.date})`,
        companyInfo: quotation.company_info
      };
      
      // Navigate to invoice page with pre-filled data for user to review and save
      // Quotation will be marked as converted ONLY when invoice is successfully saved
      navigate('/admin/invoice', { state: { fromQuotation: invoiceData } });
      toast.info('Quotation loaded — save the invoice to complete conversion');
      
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
      await api.deleteQuotation(deletedId);
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

  // Revert converted quotation back to active (Super Admin only)
  const handleRevertToActive = async (quotation) => {
    try {
      await api.revertQuotationToActive(quotation.id);
      toast.success(`Quotation ${quotation.quotation_no} reverted to active`);
      fetchQuotations();
      fetchOrphanAudit();
      
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
      const response = await api.downloadQuotationPdf(quotation.id);
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
      await api.emailQuotationPdf(emailQuotation.id, emailAddress, emailMessage);
      toast.success('Quotation sent via email');
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
      // First download the PDF to get a shareable version
      const response = await api.downloadQuotationPdf(quotation.id);
      const blob = new Blob([response.data], { type: 'application/pdf' });
      const url = window.URL.createObjectURL(blob);
      
      // Create message with quotation details
      const message = `Quotation ${quotation.quotation_no}\n` +
        `Customer: ${quotation.customer_name || 'N/A'}\n` +
        `Total: £${quotation.gross_total?.toFixed(2) || '0.00'}\n` +
        `Valid until: ${quotation.expiry_date ? new Date(quotation.expiry_date).toLocaleDateString('en-GB') : 'N/A'}`;
      
      // Clean phone number for WhatsApp
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
      toast.error('Failed to prepare WhatsApp share');
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
            Quotation History
          </h1>
        </div>
        <Button onClick={() => navigate('/admin/quotation')} className="bg-blue-600 hover:bg-blue-700">
          <FileText className="h-4 w-4 mr-1" /> New Quotation
        </Button>
      </div>

      {/* Orphan Audit Banner — surfaces quotes marked "Converted" with no linked invoice */}
      {orphanAudit.count > 0 && (
        <div
          className="rounded-lg border border-amber-300 bg-amber-50 p-4"
          data-testid="orphan-audit-banner"
        >
          <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
              <div>
                <p className="font-semibold text-amber-900">
                  {orphanAudit.count} quotation{orphanAudit.count === 1 ? '' : 's'} marked "Converted" but missing a linked invoice
                </p>
                <p className="text-sm text-amber-800 mt-0.5">
                  These quotes were flipped to Converted but no matching invoice was saved —
                  so their revenue is NOT counted in sales numbers. Review them and either
                  revert to Active (to redo the conversion) or check if the invoice was saved under a different number.
                </p>
              </div>
            </div>
            <div className="flex gap-2 shrink-0">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowOrphanList((v) => !v)}
                data-testid="orphan-audit-toggle-btn"
              >
                {showOrphanList ? 'Hide' : 'Review'} ({orphanAudit.count})
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={fetchOrphanAudit}
                title="Re-run audit"
                data-testid="orphan-audit-refresh-btn"
              >
                <RotateCcw className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {showOrphanList && (
            <div className="mt-3 border-t border-amber-200 pt-3">
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="text-left text-amber-900 border-b border-amber-200">
                      <th className="py-1.5 pr-3 font-medium">Quotation</th>
                      <th className="py-1.5 pr-3 font-medium">Customer</th>
                      <th className="py-1.5 pr-3 font-medium">Total</th>
                      <th className="py-1.5 pr-3 font-medium">Converted At</th>
                      <th className="py-1.5 pr-3 font-medium">Staff</th>
                      <th className="py-1.5 pr-3 font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orphanAudit.orphans.map((o) => (
                      <tr
                        key={o.id}
                        className="border-b border-amber-100 last:border-0"
                        data-testid={`orphan-row-${o.quotation_no}`}
                      >
                        <td className="py-1.5 pr-3 font-mono text-amber-900">{o.quotation_no}</td>
                        <td className="py-1.5 pr-3">{o.customer_name || '—'}</td>
                        <td className="py-1.5 pr-3">£{(o.total || 0).toFixed(2)}</td>
                        <td className="py-1.5 pr-3 text-gray-600">
                          {o.converted_at ? new Date(o.converted_at).toLocaleString('en-GB') : '—'}
                        </td>
                        <td className="py-1.5 pr-3">{o.sales_person || '—'}</td>
                        <td className="py-1.5 pr-3">
                          <div className="flex flex-wrap gap-1.5">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-xs border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                              onClick={() => openLinkDialog(o)}
                              data-testid={`orphan-link-btn-${o.quotation_no}`}
                              title="Link to an EXISTING invoice that was saved under a different number"
                            >
                              <Link2 className="h-3 w-3 mr-1" /> Link Invoice
                            </Button>
                            {isSuperAdmin && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 px-2 text-xs"
                                onClick={() => handleRevertToActive({ id: o.id, quotation_no: o.quotation_no })}
                                data-testid={`orphan-revert-btn-${o.quotation_no}`}
                                title="Revert to Active so the staff can redo the conversion"
                              >
                                <RotateCcw className="h-3 w-3 mr-1" /> Revert to Active
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Link-existing-invoice modal (4 Jun 2026) */}
      <Dialog
        open={linkDialog.open}
        onOpenChange={(open) => {
          if (!open) {
            setLinkDialog({ open: false, quote: null });
            setLinkSearch('');
            setLinkResults([]);
          }
        }}
      >
        <DialogContent className="max-w-2xl" data-testid="link-invoice-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Link2 className="h-5 w-5 text-emerald-600" />
              Link an existing invoice
            </DialogTitle>
            <DialogDescription>
              {linkDialog.quote ? (
                <>
                  Pairing quotation <span className="font-mono font-bold">{linkDialog.quote.quotation_no}</span>
                  {linkDialog.quote.customer_name && <> (<span className="font-semibold">{linkDialog.quote.customer_name}</span>)</>}
                  {' '}with the invoice that was already saved. Sales totals will update on the next refresh. The pairing is reversible via &quot;Revert to Active&quot;.
                </>
              ) : 'Pick an invoice to link to this orphan quotation.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <Input
                autoFocus
                value={linkSearch}
                onChange={(e) => setLinkSearch(e.target.value)}
                placeholder="Search invoice number or customer name (min 2 chars)…"
                className="pl-10"
                data-testid="link-invoice-search"
              />
            </div>

            <div className="border border-gray-200 rounded-md max-h-80 overflow-y-auto" data-testid="link-invoice-results">
              {linkSearching ? (
                <div className="p-4 text-center text-sm text-gray-500">Searching…</div>
              ) : linkResults.length === 0 ? (
                <div className="p-4 text-center text-sm text-gray-500">
                  {linkSearch.trim().length < 2
                    ? 'Type at least 2 characters to search.'
                    : 'No matching unlinked invoices found. Try a different term, or revert the quote and re-create the invoice.'}
                </div>
              ) : (
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 text-xs text-gray-600 uppercase tracking-wider sticky top-0">
                    <tr>
                      <th className="py-1.5 px-2 text-left font-medium">Invoice</th>
                      <th className="py-1.5 px-2 text-left font-medium">Customer</th>
                      <th className="py-1.5 px-2 text-right font-medium">Total</th>
                      <th className="py-1.5 px-2 text-left font-medium">Date</th>
                      <th className="py-1.5 px-2 text-left font-medium">Staff</th>
                      <th className="py-1.5 px-2 text-right font-medium"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {linkResults.map((inv) => (
                      <tr
                        key={inv.id}
                        className="border-t border-gray-100 hover:bg-emerald-50/40"
                        data-testid={`link-invoice-row-${inv.invoice_no}`}
                      >
                        <td className="py-1.5 px-2 font-mono">{inv.invoice_no || '—'}</td>
                        <td className="py-1.5 px-2">{inv.customer_name || '—'}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums">£{Number(inv.total || 0).toLocaleString('en-GB', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}</td>
                        <td className="py-1.5 px-2 text-xs text-gray-600">
                          {inv.date ? (typeof inv.date === 'string' && inv.date.includes('/') ? inv.date : new Date(inv.date).toLocaleDateString('en-GB')) : '—'}
                        </td>
                        <td className="py-1.5 px-2 text-xs">{inv.sales_person || '—'}</td>
                        <td className="py-1.5 px-2 text-right">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-xs border-emerald-300 text-emerald-700 hover:bg-emerald-100"
                            disabled={linking}
                            onClick={() => handleLinkInvoice(inv)}
                            data-testid={`link-invoice-confirm-${inv.invoice_no}`}
                          >
                            {linking ? '…' : 'Link'}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <p className="text-[11px] text-gray-500 leading-relaxed">
              Tip: invoices already linked to another quote are hidden so you can&apos;t accidentally double-link the same one.
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setLinkDialog({ open: false, quote: null })}
              data-testid="link-invoice-cancel"
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>


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
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
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
        <Card className="bg-gradient-to-br from-purple-50 to-blue-50 border-purple-200">
          <CardContent className="pt-6">
            <div className="text-center">
              <p className="text-2xl font-bold text-purple-700">
                {quotations.length > 0 
                  ? ((quotations.filter(q => q.status === 'converted').length / quotations.length) * 100).toFixed(1)
                  : '0.0'}%
              </p>
              <p className="text-sm text-purple-600 font-medium">Conversion Rate</p>
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
                        £{quotation.gross_total?.toFixed(2) || '0.00'}
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
            <DialogTitle>Send Quotation via Email</DialogTitle>
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

export default QuotationHistory;

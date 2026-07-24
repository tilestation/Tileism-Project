import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { 
  RotateCcw, 
  Search, 
  Eye, 
  Edit2,
  Trash2, 
  ArrowLeft,
  Calendar,
  TrendingDown,
  Receipt,
  Download
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
import { api } from '../../lib/api';
import { useAuth } from '../../contexts/AuthContext';

export const CreditNoteHistory = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';
  const [creditNotes, setCreditNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [stats, setStats] = useState(null);
  const [selectedCreditNote, setSelectedCreditNote] = useState(null);
  const [showDetailDialog, setShowDetailDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [creditNoteToDelete, setCreditNoteToDelete] = useState(null);

  useEffect(() => {
    fetchData();
    
    // Listen for data sync events from other pages
    const handleDataSync = () => {
      console.log('[CreditNoteHistory] Data sync event received');
      fetchData();
    };
    
    window.addEventListener('data-sync-event', handleDataSync);
    window.addEventListener('dataSync', handleDataSync);
    
    return () => {
      window.removeEventListener('data-sync-event', handleDataSync);
      window.removeEventListener('dataSync', handleDataSync);
    };
  }, []);

  const fetchData = async () => {
    try {
      const [creditNotesRes, statsRes] = await Promise.all([
        api.getCreditNotes(),
        api.getCreditNoteStats({ period: 'month' })
      ]);
      setCreditNotes(creditNotesRes.data);
      setStats(statsRes.data);
    } catch (error) {
      toast.error('Failed to load creditNotes');
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const filteredCreditNotes = creditNotes.filter(r =>
    (r.creditNote_no?.toLowerCase() || '').includes(searchTerm.toLowerCase()) ||
    (r.customer_name?.toLowerCase() || '').includes(searchTerm.toLowerCase()) ||
    (r.original_invoice_no?.toLowerCase() || '').includes(searchTerm.toLowerCase())
  );

  const handleViewCreditNote = (creditNote) => {
    setSelectedCreditNote(creditNote);
    setShowDetailDialog(true);
  };

  // 24 Jul 2026 — parity with RefundHistory. `DocumentForm` already
  // reads `location.state.editCreditNote` and routes the save through
  // `api.updateCreditNote(id, payload)`, so this just wires the pencil
  // icon on the row to that flow. The route uses kebab-case in App.js
  // (`credit-note`, not `creditNote`).
  const handleEditCreditNote = (creditNote) => {
    navigate('/admin/credit-note', { state: { editCreditNote: creditNote } });
  };

  const handleDeleteClick = (creditNote) => {
    setCreditNoteToDelete(creditNote);
    setShowDeleteDialog(true);
  };

  const handleDeleteConfirm = async () => {
    if (!creditNoteToDelete) return;
    
    const deletedId = creditNoteToDelete.id;
    
    try {
      await api.deleteCreditNote(deletedId);
      toast.success('Credit Note deleted');
      
      // Immediately update local state for instant UI feedback
      setCreditNotes(prev => prev.filter(cn => cn.id !== deletedId));
      
      setShowDeleteDialog(false);
      setCreditNoteToDelete(null);
      
      // Dispatch data sync events for other components
      window.dispatchEvent(new CustomEvent('data-sync-event'));
      window.dispatchEvent(new CustomEvent('dataSync'));
      localStorage.setItem('dataSync', Date.now().toString());
      
      // Refetch for consistency (will also update stats)
      fetchData();
    } catch (error) {
      toast.error('Failed to delete credit note');
    }
  };

  const handleDownloadPdf = async (creditNote) => {
    try {
      const response = await api.downloadCreditNotePdf(creditNote.id);
      
      // Create blob from response
      const blob = new Blob([response.data], { type: 'application/pdf' });
      const url = window.URL.createObjectURL(blob);
      
      // Create download link
      const link = document.createElement('a');
      link.href = url;
      link.download = `CreditNote_${creditNote.creditNote_no || creditNote.credit_note_no}.pdf`;
      document.body.appendChild(link);
      link.click();
      
      // Cleanup
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
      
      toast.success('Credit Note downloaded');
    } catch (error) {
      console.error('Download error:', error);
      toast.error('Failed to download credit note');
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
    <div className="space-y-6 pb-8" data-testid="creditNote-history-page">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" onClick={() => navigate('/admin/epos')}>
            <ArrowLeft className="h-4 w-4 mr-1" /> Back to EPOS
          </Button>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <RotateCcw className="h-6 w-6 text-red-500" />
            CreditNote History
          </h1>
        </div>
        <Button onClick={() => navigate('/admin/credit-note')} className="bg-red-600 hover:bg-red-700">
          <RotateCcw className="h-4 w-4 mr-1" /> New CreditNote
        </Button>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="py-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Total CreditNotes</p>
                  <p className="text-2xl font-bold">{stats.total_creditNotes}</p>
                </div>
                <Receipt className="h-8 w-8 text-red-500/20" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Gross CreditNotes</p>
                  <p className="text-2xl font-bold text-red-600">£{stats.total_gross_creditNotes?.toFixed(2)}</p>
                </div>
                <TrendingDown className="h-8 w-8 text-red-500/20" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Net CreditNotes</p>
                  <p className="text-2xl font-bold text-red-600">£{stats.total_net_creditNotes?.toFixed(2)}</p>
                </div>
                <TrendingDown className="h-8 w-8 text-red-500/20" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Restocking Fees</p>
                  <p className="text-2xl font-bold text-green-600">+£{stats.total_restocking_fees?.toFixed(2)}</p>
                </div>
                <Calendar className="h-8 w-8 text-green-500/20" />
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Search */}
      <Card>
        <CardContent className="py-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by creditNote no, customer name, or invoice no..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10"
              data-testid="search-creditNote-input"
            />
          </div>
        </CardContent>
      </Card>

      {/* CreditNotes Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Receipt className="h-5 w-5" />
            CreditNotes ({filteredCreditNotes.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {filteredCreditNotes.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <RotateCcw className="h-12 w-12 mx-auto mb-4 opacity-20" />
              <p>No creditNotes found</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b text-left text-sm text-muted-foreground">
                    <th className="pb-3 font-medium">Credit Note No</th>
                    <th className="pb-3 font-medium">Date</th>
                    <th className="pb-3 font-medium">Original Invoice</th>
                    <th className="pb-3 font-medium">Customer</th>
                    <th className="pb-3 font-medium">Created By</th>
                    <th className="pb-3 font-medium">Method</th>
                    <th className="pb-3 font-medium">Store</th>
                    <th className="pb-3 font-medium text-right">Net Credit Note</th>
                    <th className="pb-3 font-medium text-center">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCreditNotes.map((creditNote) => (
                    <tr 
                      key={creditNote.id} 
                      className="border-b hover:bg-muted/50 cursor-pointer"
                      onClick={() => handleViewCreditNote(creditNote)}
                    >
                      <td className="py-3">
                        <span className="font-mono font-medium text-red-600">
                          {creditNote.creditNote_no}
                        </span>
                      </td>
                      <td className="py-3 text-sm">{creditNote.date}</td>
                      <td className="py-3 text-sm font-mono">
                        {creditNote.original_invoice_no || '-'}
                      </td>
                      <td className="py-3">
                        <div>
                          <p className="font-medium">{creditNote.customer_name || '-'}</p>
                          {creditNote.customer_phone && (
                            <p className="text-xs text-muted-foreground">{creditNote.customer_phone}</p>
                          )}
                        </div>
                      </td>
                      <td className="py-3 text-sm">
                        {creditNote.staff_name || creditNote.processed_by || creditNote.created_by || '-'}
                      </td>
                      <td className="py-3 text-sm">{creditNote.creditNote_method || '-'}</td>
                      <td className="py-3 text-sm">{creditNote.showroom_name || '-'}</td>
                      <td className="py-3 text-right font-medium text-red-600">
                        £{(creditNote.net_creditNote || 0).toFixed(2)}
                      </td>
                      <td className="py-3">
                        <div className="flex justify-center gap-1" onClick={(e) => e.stopPropagation()}>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleViewCreditNote(creditNote)}
                            title="View details"
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleEditCreditNote(creditNote)}
                            title="Edit credit note"
                            data-testid={`credit-note-edit-${creditNote.id}`}
                          >
                            <Edit2 className="h-4 w-4 text-amber-600" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDownloadPdf(creditNote)}
                            title="Download PDF"
                          >
                            <Download className="h-4 w-4 text-blue-500" />
                          </Button>
                          {isSuperAdmin && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDeleteClick(creditNote)}
                            title="Delete (Super Admin only)"
                          >
                            <Trash2 className="h-4 w-4 text-red-500" />
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

      {/* CreditNote Detail Dialog */}
      <Dialog open={showDetailDialog} onOpenChange={setShowDetailDialog}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <RotateCcw className="h-5 w-5" />
              CreditNote: {selectedCreditNote?.creditNote_no}
            </DialogTitle>
            <DialogDescription>
              {selectedCreditNote?.date} {selectedCreditNote?.time && `at ${selectedCreditNote.time}`}
            </DialogDescription>
          </DialogHeader>
          
          {selectedCreditNote && (
            <div className="space-y-6">
              {/* Customer Info */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <h4 className="font-medium mb-2">Customer Details</h4>
                  <div className="text-sm space-y-1 text-muted-foreground">
                    <p><strong>Name:</strong> {selectedCreditNote.customer_name || '-'}</p>
                    <p><strong>Phone:</strong> {selectedCreditNote.customer_phone || '-'}</p>
                    <p><strong>Email:</strong> {selectedCreditNote.customer_email || '-'}</p>
                  </div>
                </div>
                <div>
                  <h4 className="font-medium mb-2">CreditNote Info</h4>
                  <div className="text-sm space-y-1 text-muted-foreground">
                    <p><strong>Original Invoice:</strong> {selectedCreditNote.original_invoice_no || '-'}</p>
                    <p><strong>Method:</strong> {selectedCreditNote.creditNote_method || '-'}</p>
                    <p><strong>Type:</strong> {selectedCreditNote.creditNote_type || '-'}</p>
                    <p><strong>Store:</strong> {selectedCreditNote.showroom_name || '-'}</p>
                  </div>
                </div>
              </div>

              {/* Line Items */}
              <div>
                <h4 className="font-medium mb-2">CreditNoteed Items</h4>
                <div className="border rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-muted">
                      <tr>
                        <th className="px-3 py-2 text-left min-w-[200px]">Product</th>
                        <th className="px-3 py-2 text-right w-16">Qty</th>
                        <th className="px-3 py-2 text-right w-24">Price</th>
                        <th className="px-3 py-2 text-left w-32">Reason</th>
                        <th className="px-3 py-2 text-right w-24">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedCreditNote.line_items?.map((item, idx) => (
                        <tr key={idx} className="border-t">
                          <td className="px-3 py-2">
                            <p className="font-medium">{item.product_name}</p>
                            {item.sku && <p className="text-xs text-muted-foreground">{item.sku}</p>}
                          </td>
                          <td className="px-3 py-2 text-right">{item.quantity}</td>
                          <td className="px-3 py-2 text-right">£{(item.creditNote_price || 0).toFixed(2)}</td>
                          <td className="px-3 py-2 text-sm">{item.reason || '-'}</td>
                          <td className="px-3 py-2 text-right font-medium">£{(item.total || 0).toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Totals */}
              <div className="flex justify-end">
                <div className="w-64 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span>Subtotal</span>
                    <span>£{(selectedCreditNote.subtotal || 0).toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>VAT (20%)</span>
                    <span>£{(selectedCreditNote.vat || 0).toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between font-medium">
                    <span>Gross Total</span>
                    <span>£{(selectedCreditNote.gross_total || 0).toFixed(2)}</span>
                  </div>
                  {selectedCreditNote.restocking_fee > 0 && (
                    <div className="flex justify-between text-orange-600">
                      <span>Restocking Fee</span>
                      <span>-£{(selectedCreditNote.restocking_fee || 0).toFixed(2)}</span>
                    </div>
                  )}
                  <div className="flex justify-between font-bold text-lg text-red-600 border-t pt-2">
                    <span>Net CreditNote</span>
                    <span>£{(selectedCreditNote.net_creditNote || 0).toFixed(2)}</span>
                  </div>
                </div>
              </div>

              {selectedCreditNote.notes && (
                <div className="p-3 bg-muted rounded-lg">
                  <p className="text-sm font-medium">Notes:</p>
                  <p className="text-sm text-muted-foreground">{selectedCreditNote.notes}</p>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete CreditNote</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete creditNote {creditNoteToDelete?.creditNote_no}? 
              This will reverse the stock adjustments.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDeleteConfirm}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default CreditNoteHistory;

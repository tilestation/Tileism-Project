import React, { useState, useEffect } from 'react';
import { ArrowRightLeft, Plus, Package, Clock, CheckCircle, XCircle, Truck } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { toast } from 'sonner';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const StockTransfers = () => {
  const [transfers, setTransfers] = useState([]);
  const [showrooms, setShowrooms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [selectedTransfer, setSelectedTransfer] = useState(null);
  const [statusFilter, setStatusFilter] = useState('');
  
  // Form state
  const [fromShowroom, setFromShowroom] = useState('');
  const [toShowroom, setToShowroom] = useState('');
  const [items, setItems] = useState([{ product_id: '', sku: '', name: '', quantity: 1 }]);
  const [notes, setNotes] = useState('');
  const [productSearch, setProductSearch] = useState('');
  const [searchResults, setSearchResults] = useState([]);

  useEffect(() => {
    fetchTransfers();
    fetchShowrooms();
  }, [statusFilter]);

  const fetchTransfers = async () => {
    try {
      const url = statusFilter 
        ? `${API_URL}/api/stock-transfers/list?status=${statusFilter}`
        : `${API_URL}/api/stock-transfers/list`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setTransfers(data.transfers || []);
      }
    } catch (e) {
      console.error('Error:', e);
    } finally {
      setLoading(false);
    }
  };

  const fetchShowrooms = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/showrooms`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setShowrooms(data || []);
      }
    } catch (e) {
      console.error('Error:', e);
    }
  };

  const searchProducts = async (query) => {
    if (query.length < 2) {
      setSearchResults([]);
      return;
    }
    try {
      const res = await fetch(`${API_URL}/api/barcode/search?q=${encodeURIComponent(query)}&limit=10`);
      if (res.ok) {
        const data = await res.json();
        setSearchResults(data.results || []);
      }
    } catch (e) {
      console.error('Search error:', e);
    }
  };

  const handleCreateTransfer = async () => {
    if (!fromShowroom || !toShowroom) {
      toast.error('Please select both source and destination showrooms');
      return;
    }
    
    const validItems = items.filter(i => i.product_id && i.quantity > 0);
    if (validItems.length === 0) {
      toast.error('Please add at least one product');
      return;
    }
    
    try {
      const res = await fetch(`${API_URL}/api/stock-transfers/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from_showroom_id: fromShowroom,
          to_showroom_id: toShowroom,
          items: validItems,
          notes
        })
      });
      
      if (res.ok) {
        toast.success('Transfer created successfully');
        setShowCreateDialog(false);
        fetchTransfers();
        resetForm();
      } else {
        const error = await res.json();
        toast.error(error.detail?.message || 'Failed to create transfer');
      }
    } catch (e) {
      console.error('Error:', e);
      toast.error('Failed to create transfer');
    }
  };

  const handleDispatch = async (transferId) => {
    try {
      const res = await fetch(`${API_URL}/api/stock-transfers/${transferId}/dispatch`, {
        method: 'PATCH'
      });
      if (res.ok) {
        toast.success('Transfer dispatched');
        fetchTransfers();
      }
    } catch (e) {
      toast.error('Failed to dispatch');
    }
  };

  const handleReceive = async (transferId) => {
    try {
      const res = await fetch(`${API_URL}/api/stock-transfers/${transferId}/receive`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      if (res.ok) {
        toast.success('Transfer received - stock updated');
        fetchTransfers();
      }
    } catch (e) {
      toast.error('Failed to receive');
    }
  };

  const resetForm = () => {
    setFromShowroom('');
    setToShowroom('');
    setItems([{ product_id: '', sku: '', name: '', quantity: 1 }]);
    setNotes('');
  };

  const getStatusBadge = (status) => {
    const styles = {
      pending: 'bg-yellow-100 text-yellow-700',
      in_transit: 'bg-blue-100 text-blue-700',
      received: 'bg-green-100 text-green-700',
      cancelled: 'bg-red-100 text-red-700'
    };
    return <span className={`px-2 py-1 rounded text-xs font-medium ${styles[status] || 'bg-gray-100'}`}>
      {status?.replace('_', ' ').toUpperCase()}
    </span>;
  };

  return (
    <div className="space-y-6" data-testid="stock-transfers">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Stock Transfers</h2>
          <p className="text-gray-500">Move inventory between showrooms</p>
        </div>
        <div className="flex gap-3">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="border rounded-lg px-3 py-2"
          >
            <option value="">All Status</option>
            <option value="pending">Pending</option>
            <option value="in_transit">In Transit</option>
            <option value="received">Received</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <Button onClick={() => setShowCreateDialog(true)}>
            <Plus className="h-4 w-4 mr-2" />
            New Transfer
          </Button>
        </div>
      </div>

      {/* Transfers List */}
      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-4 border-blue-500 border-t-transparent"></div>
        </div>
      ) : transfers.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <ArrowRightLeft className="h-12 w-12 text-gray-300 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900">No transfers yet</h3>
            <p className="text-gray-500">Create your first stock transfer to move inventory between locations.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {transfers.map((transfer) => (
            <Card key={transfer.id}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-3">
                      <span className="font-mono font-medium">{transfer.transfer_number}</span>
                      {getStatusBadge(transfer.status)}
                    </div>
                    <div className="flex items-center gap-2 mt-2 text-sm text-gray-600">
                      <span className="font-medium">{transfer.from_showroom_name}</span>
                      <ArrowRightLeft className="h-4 w-4" />
                      <span className="font-medium">{transfer.to_showroom_name}</span>
                    </div>
                    <p className="text-sm text-gray-500 mt-1">
                      {transfer.total_items} items • {transfer.total_qty} units
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {transfer.status === 'pending' && (
                      <>
                        <Button size="sm" variant="outline" onClick={() => handleDispatch(transfer.id)}>
                          <Truck className="h-4 w-4 mr-1" />
                          Dispatch
                        </Button>
                        <Button size="sm" onClick={() => handleReceive(transfer.id)}>
                          <CheckCircle className="h-4 w-4 mr-1" />
                          Direct Receive
                        </Button>
                      </>
                    )}
                    {transfer.status === 'in_transit' && (
                      <Button size="sm" onClick={() => handleReceive(transfer.id)}>
                        <CheckCircle className="h-4 w-4 mr-1" />
                        Mark Received
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create Transfer Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create Stock Transfer</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium">From Showroom</label>
                <select
                  value={fromShowroom}
                  onChange={(e) => setFromShowroom(e.target.value)}
                  className="w-full border rounded-lg px-3 py-2 mt-1"
                >
                  <option value="">Select source...</option>
                  {showrooms.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-sm font-medium">To Showroom</label>
                <select
                  value={toShowroom}
                  onChange={(e) => setToShowroom(e.target.value)}
                  className="w-full border rounded-lg px-3 py-2 mt-1"
                >
                  <option value="">Select destination...</option>
                  {showrooms.filter(s => s.id !== fromShowroom).map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="text-sm font-medium">Products</label>
              <div className="relative mt-1">
                <Input
                  placeholder="Search products..."
                  value={productSearch}
                  onChange={(e) => {
                    setProductSearch(e.target.value);
                    searchProducts(e.target.value);
                  }}
                />
                {searchResults.length > 0 && (
                  <div className="absolute z-10 w-full mt-1 bg-white border rounded-lg shadow-lg max-h-40 overflow-auto">
                    {searchResults.map((product, idx) => (
                      <button
                        key={idx}
                        className="w-full px-3 py-2 text-left hover:bg-gray-50 text-sm"
                        onClick={() => {
                          setItems([...items.filter(i => i.product_id), {
                            product_id: product.id,
                            sku: product.sku,
                            name: product.name,
                            quantity: 1
                          }]);
                          setProductSearch('');
                          setSearchResults([]);
                        }}
                      >
                        {product.name} ({product.sku})
                      </button>
                    ))}
                  </div>
                )}
              </div>
              
              {items.filter(i => i.product_id).length > 0 && (
                <div className="mt-2 space-y-2">
                  {items.filter(i => i.product_id).map((item, idx) => (
                    <div key={idx} className="flex items-center gap-2 p-2 bg-gray-50 rounded">
                      <span className="flex-1 text-sm">{item.name}</span>
                      <Input
                        type="number"
                        min="1"
                        value={item.quantity}
                        onChange={(e) => {
                          const newItems = [...items];
                          newItems[idx].quantity = parseInt(e.target.value) || 1;
                          setItems(newItems);
                        }}
                        className="w-20"
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setItems(items.filter((_, i) => i !== idx))}
                      >
                        <XCircle className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <label className="text-sm font-medium">Notes</label>
              <Input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional notes..."
                className="mt-1"
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowCreateDialog(false)}>Cancel</Button>
              <Button onClick={handleCreateTransfer}>Create Transfer</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default StockTransfers;

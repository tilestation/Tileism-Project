import React, { useState, useEffect, useCallback } from 'react';
import { Calendar, momentLocalizer } from 'react-big-calendar';
import moment from 'moment';
import 'react-big-calendar/lib/css/react-big-calendar.css';
import { api } from '../../lib/api';
import { toast } from 'sonner';
import { useAuth } from '../../contexts/AuthContext';
import { 
  Calendar as CalendarIcon, 
  Clock, 
  AlertTriangle, 
  Package, 
  ChevronLeft, 
  ChevronRight,
  Filter,
  RefreshCw,
  X,
  Phone,
  MapPin,
  FileText,
  Check,
  Truck,
  CheckCircle,
  XCircle,
  Eye,
  Edit2,
  Download,
  ClipboardList,
  Receipt
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';

const localizer = momentLocalizer(moment);
const API_URL = process.env.REACT_APP_BACKEND_URL;

// Status icons mapping
const statusIcons = {
  pending: Clock,
  confirmed: Check,
  processing: Package,
  ready: CheckCircle,
  out_for_delivery: Truck,
  completed: CheckCircle,
  cancelled: XCircle,
};

const OrderManagement = () => {
  const { user } = useAuth();
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showrooms, setStores] = useState([]);
  const [selectedStore, setSelectedStore] = useState('all');
  const [selectedStatus, setSelectedStatus] = useState('all');
  const [statuses, setStatuses] = useState({});
  const [summary, setSummary] = useState(null);
  const [overdueOrders, setOverdueOrders] = useState([]);
  const [currentDate, setCurrentDate] = useState(new Date());
  const [view, setView] = useState('month');
  
  // Dialog states
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [showOrderDialog, setShowOrderDialog] = useState(false);
  const [showRescheduleDialog, setShowRescheduleDialog] = useState(false);
  const [showOverdueDialog, setShowOverdueDialog] = useState(false);
  const [rescheduleDate, setRescheduleDate] = useState('');
  const [rescheduleNotes, setRescheduleNotes] = useState('');
  const [editStatus, setEditStatus] = useState('');
  const [editNotes, setEditNotes] = useState('');
  // 2 Oct 2026 — one-off date/time picker shown before a Delivery/Collection
  // note PDF downloads, so staff can set the date printed on it without it
  // being tied to the order's actual scheduled delivery_date.
  const [noteDatePicker, setNoteDatePicker] = useState({ open: false, noteType: '', value: '' });
  // Fetch showrooms
  useEffect(() => {
    const fetchStores = async () => {
      try {
        const res = await api.get('/showrooms');
        setStores(res.data);
      } catch (err) {
        console.error('Error fetching showrooms:', err);
      }
    };
    fetchStores();
  }, []);

  // Fetch order statuses
  useEffect(() => {
    const fetchStatuses = async () => {
      try {
        const res = await api.get('/orders/statuses');
        setStatuses(res.data);
      } catch (err) {
        console.error('Error fetching statuses:', err);
      }
    };
    fetchStatuses();
  }, []);

  // Fetch summary
  const fetchSummary = useCallback(async () => {
    try {
      const params = selectedStore !== 'all' ? { showroom_id: selectedStore } : {};
      const res = await api.get('/orders/summary', { params });
      setSummary(res.data);
    } catch (err) {
      console.error('Error fetching summary:', err);
    }
  }, [selectedStore]);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  // Fetch calendar events
  const fetchEvents = useCallback(async () => {
    setLoading(true);
    try {
      // Calculate date range based on current view
      let startDate, endDate;
      if (view === 'month') {
        startDate = moment(currentDate).startOf('month').subtract(7, 'days').toISOString();
        endDate = moment(currentDate).endOf('month').add(7, 'days').toISOString();
      } else if (view === 'week') {
        startDate = moment(currentDate).startOf('week').toISOString();
        endDate = moment(currentDate).endOf('week').toISOString();
      } else {
        startDate = moment(currentDate).startOf('day').toISOString();
        endDate = moment(currentDate).endOf('day').toISOString();
      }

      const params = {
        start_date: startDate,
        end_date: endDate,
      };
      
      if (selectedStore !== 'all') {
        params.showroom_id = selectedStore;
      }
      if (selectedStatus !== 'all') {
        params.status = selectedStatus;
      }

      const res = await api.get('/orders/calendar', { params });
      
      // Convert to calendar events
      const calendarEvents = res.data.map(order => ({
        ...order,
        start: new Date(order.start),
        end: new Date(order.end),
        resource: order,
      }));
      
      setEvents(calendarEvents);
    } catch (err) {
      console.error('Error fetching events:', err);
      toast.error('Failed to load orders');
    } finally {
      setLoading(false);
    }
  }, [currentDate, view, selectedStore, selectedStatus]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  // Fetch overdue orders
  const fetchOverdueOrders = useCallback(async () => {
    try {
      const params = selectedStore !== 'all' ? { showroom_id: selectedStore } : {};
      const res = await api.get('/orders/overdue/list', { params });
      setOverdueOrders(res.data);
    } catch (err) {
      console.error('Error fetching overdue orders:', err);
    }
  }, [selectedStore]);

  useEffect(() => {
    fetchOverdueOrders();
  }, [fetchOverdueOrders]);

  // Handle event click
  const handleSelectEvent = async (event) => {
    try {
      const res = await api.get(`/orders/${event.id}`);
      setSelectedOrder(res.data);
      setEditStatus(res.data.status || 'pending');
      setEditNotes(res.data.notes || '');
      setShowOrderDialog(true);
    } catch (err) {
      toast.error('Failed to load order details');
    }
  };

  // Update order status
  const handleUpdateStatus = async () => {
    if (!selectedOrder) return;
    
    try {
      await api.put(`/orders/${selectedOrder.id}`, {
        status: editStatus,
        notes: editNotes,
      });
      toast.success('Order updated successfully');
      setShowOrderDialog(false);
      fetchEvents();
      fetchSummary();
      fetchOverdueOrders();
    } catch (err) {
      toast.error('Failed to update order');
    }
  };

  // Reschedule order
  const handleReschedule = async () => {
    if (!selectedOrder || !rescheduleDate) return;
    
    try {
      await api.post(`/orders/${selectedOrder.id}/reschedule`, {
        delivery_date: new Date(rescheduleDate).toISOString(),
        notes: rescheduleNotes,
      });
      toast.success('Order rescheduled successfully');
      setShowRescheduleDialog(false);
      setRescheduleDate('');
      setRescheduleNotes('');
      fetchEvents();
      fetchOverdueOrders();
    } catch (err) {
      toast.error('Failed to reschedule order');
    }
  };

  // Download Collection Note PDF
  const handleDownloadCollectionNote = async (orderId, dateTimeValue) => {
    try {
      const token = localStorage.getItem('token');
      const qs = dateTimeValue ? `?collection_date=${encodeURIComponent(dateTimeValue)}` : '';
      const response = await fetch(`${API_URL}/api/orders/${orderId}/collection-note${qs}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      if (!response.ok) throw new Error('Failed to generate PDF');
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `collection_note_${orderId.slice(0, 8)}.pdf`;
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
  const handleDownloadDeliveryNote = async (orderId, dateTimeValue) => {
    try {
      const token = localStorage.getItem('token');
      const qs = dateTimeValue ? `?delivery_date_override=${encodeURIComponent(dateTimeValue)}` : '';
      const response = await fetch(`${API_URL}/api/orders/${orderId}/delivery-note${qs}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      if (!response.ok) throw new Error('Failed to generate PDF');
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `delivery_note_${orderId.slice(0, 8)}.pdf`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      toast.success('Delivery Note downloaded');
    } catch (err) {
      toast.error('Failed to download Delivery Note');
    }
  };

  // 2 Oct 2026 — opens the date/time picker; the actual download fires once
  // staff confirms a value.
  const openNoteDatePicker = (noteType) => {
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    setNoteDatePicker({ open: true, noteType, value: d.toISOString().slice(0, 16) });
  };
  const confirmNoteDatePicker = () => {
    const { noteType, value } = noteDatePicker;
    setNoteDatePicker({ open: false, noteType: '', value: '' });
    if (noteType === 'collection') handleDownloadCollectionNote(selectedOrder?.id, value);
    else handleDownloadDeliveryNote(selectedOrder?.id, value);
  };


  // Custom event styling
  const eventStyleGetter = (event) => {
    let backgroundColor = event.status_color || '#3b82f6';
    let borderColor = backgroundColor;
    
    if (event.is_overdue) {
      borderColor = '#ef4444';
      backgroundColor = `${backgroundColor}dd`;
    }

    return {
      style: {
        backgroundColor,
        borderRadius: '4px',
        border: event.is_overdue ? `2px solid ${borderColor}` : 'none',
        color: 'white',
        fontSize: '12px',
        padding: '2px 4px',
      },
    };
  };

  // Custom toolbar
  // eslint-disable-next-line react/no-unstable-nested-components
  const CustomToolbar = ({ label, onNavigate, onView }) => (
    <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-4 p-4 bg-slate-50 rounded-lg">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => onNavigate('PREV')}>
          <ChevronLeft className="w-4 h-4" />
        </Button>
        <Button variant="outline" size="sm" onClick={() => onNavigate('TODAY')}>
          Today
        </Button>
        <Button variant="outline" size="sm" onClick={() => onNavigate('NEXT')}>
          <ChevronRight className="w-4 h-4" />
        </Button>
        <span className="text-lg font-semibold ml-2">{label}</span>
      </div>
      
      <div className="flex items-center gap-2">
        <Select value={view} onValueChange={(v) => { setView(v); onView(v); }}>
          <SelectTrigger className="w-[120px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="month">Month</SelectItem>
            <SelectItem value="week">Week</SelectItem>
            <SelectItem value="day">Day</SelectItem>
            <SelectItem value="agenda">Agenda</SelectItem>
          </SelectContent>
        </Select>
        
        <Button variant="outline" size="sm" onClick={fetchEvents} disabled={loading}>
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>
    </div>
  );

  return (
    <div className="p-4 md:p-6 space-y-6" data-testid="order-management-page">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <CalendarIcon className="w-7 h-7 text-blue-600" />
            Order Management
          </h1>
          <p className="text-slate-500 mt-1">Calendar-based order tracking and management</p>
        </div>
        
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2">
          <Select value={selectedStore} onValueChange={setSelectedStore}>
            <SelectTrigger className="w-[180px]">
              <Filter className="w-4 h-4 mr-2" />
              <SelectValue placeholder="All Stores" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Stores</SelectItem>
              {showrooms.map((s) => (
                <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          
          <Select value={selectedStatus} onValueChange={setSelectedStatus}>
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="All Statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              {Object.entries(statuses).map(([key, val]) => (
                <SelectItem key={key} value={key}>
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: val.color }} />
                    {val.label}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="bg-gradient-to-br from-blue-500 to-blue-600 text-white">
          <CardContent className="p-4">
            <div className="flex justify-between items-start">
              <div>
                <p className="text-blue-100 text-sm">Today&apos;s Orders</p>
                <p className="text-3xl font-bold mt-1">{summary?.today?.total || 0}</p>
              </div>
              <Package className="w-8 h-8 text-blue-200" />
            </div>
            <p className="text-blue-100 text-sm mt-2">
              £{(summary?.today?.revenue || 0).toFixed(2)} revenue
            </p>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-emerald-500 to-emerald-600 text-white">
          <CardContent className="p-4">
            <div className="flex justify-between items-start">
              <div>
                <p className="text-emerald-100 text-sm">This Week</p>
                <p className="text-3xl font-bold mt-1">{summary?.this_week || 0}</p>
              </div>
              <CalendarIcon className="w-8 h-8 text-emerald-200" />
            </div>
            <p className="text-emerald-100 text-sm mt-2">orders scheduled</p>
          </CardContent>
        </Card>

        <Card 
          className={`cursor-pointer transition-all hover:scale-[1.02] ${
            (summary?.overdue || 0) > 0 
              ? 'bg-gradient-to-br from-red-500 to-red-600' 
              : 'bg-gradient-to-br from-slate-400 to-slate-500'
          } text-white`}
          onClick={() => summary?.overdue > 0 && setShowOverdueDialog(true)}
        >
          <CardContent className="p-4">
            <div className="flex justify-between items-start">
              <div>
                <p className="text-red-100 text-sm">Overdue</p>
                <p className="text-3xl font-bold mt-1">{summary?.overdue || 0}</p>
              </div>
              <AlertTriangle className="w-8 h-8 text-red-200" />
            </div>
            <p className="text-red-100 text-sm mt-2">
              {(summary?.overdue || 0) > 0 ? 'Click to view' : 'No overdue orders'}
            </p>
          </CardContent>
        </Card>

        <Card className="bg-white border">
          <CardContent className="p-4">
            <p className="text-slate-500 text-sm mb-2">Today&apos;s Status</p>
            <div className="flex flex-wrap gap-2">
              {summary?.today?.by_status && Object.entries(summary.today.by_status).map(([status, count]) => (
                <Badge 
                  key={status} 
                  style={{ backgroundColor: statuses[status]?.color || '#64748b' }}
                  className="text-white"
                >
                  {statuses[status]?.label || status}: {count}
                </Badge>
              ))}
              {(!summary?.today?.by_status || Object.keys(summary.today.by_status).length === 0) && (
                <span className="text-slate-400 text-sm">No orders today</span>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Status Legend */}
      <div className="flex flex-wrap items-center gap-3 px-4 py-2 bg-slate-50 rounded-lg">
        <span className="text-sm text-slate-500 font-medium">Status:</span>
        {Object.entries(statuses).map(([key, val]) => (
          <div key={key} className="flex items-center gap-1">
            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: val.color }} />
            <span className="text-xs text-slate-600">{val.label}</span>
          </div>
        ))}
      </div>

      {/* Calendar */}
      <Card>
        <CardContent className="p-2 md:p-4">
          <div style={{ height: 600 }}>
            <Calendar
              localizer={localizer}
              events={events}
              startAccessor="start"
              endAccessor="end"
              style={{ height: '100%' }}
              onSelectEvent={handleSelectEvent}
              eventPropGetter={eventStyleGetter}
              views={['month', 'week', 'day', 'agenda']}
              view={view}
              onView={setView}
              date={currentDate}
              onNavigate={setCurrentDate}
              components={{
                toolbar: CustomToolbar,
              }}
              popup
              selectable={false}
            />
          </div>
        </CardContent>
      </Card>

      {/* Order Details Dialog */}
      <Dialog open={showOrderDialog} onOpenChange={setShowOrderDialog}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {selectedOrder?.source === 'invoice' ? (
                <Receipt className="w-5 h-5 text-blue-600" />
              ) : (
                <Package className="w-5 h-5" />
              )}
              {selectedOrder?.source === 'invoice' 
                ? `Invoice ${selectedOrder?.invoice_no || selectedOrder?.id?.slice(0, 8)}`
                : `Order #${selectedOrder?.id?.slice(0, 8)}`
              }
            </DialogTitle>
            <DialogDescription>
              {selectedOrder?.source === 'invoice' 
                ? 'Special Order - View and manage invoice details'
                : 'View and manage order details'
              }
            </DialogDescription>
          </DialogHeader>
          
          {selectedOrder && (
            <div className="space-y-4">
              {/* Source & Type Badge */}
              {selectedOrder.source === 'invoice' && (
                <div className="flex gap-2">
                  <Badge variant="secondary" className="bg-blue-100 text-blue-700">
                    Special Order
                  </Badge>
                  {selectedOrder.delivery_type && (
                    <Badge variant="outline" className={selectedOrder.delivery_type === 'delivery' ? 'border-orange-500 text-orange-600' : 'border-cyan-500 text-cyan-600'}>
                      {selectedOrder.delivery_type === 'delivery' ? '🚚 Delivery' : '📦 Collection'}
                    </Badge>
                  )}
                </div>
              )}

              {/* Customer Info */}
              <div className="p-3 bg-slate-50 rounded-lg space-y-2">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{selectedOrder.customer_name}</span>
                  <Badge style={{ backgroundColor: statuses[selectedOrder.status]?.color || '#64748b' }} className="text-white">
                    {statuses[selectedOrder.status]?.label || selectedOrder.status}
                  </Badge>
                </div>
                <div className="flex items-center gap-2 text-sm text-slate-600">
                  <Phone className="w-4 h-4" />
                  {selectedOrder.customer_phone || 'No phone'}
                </div>
                {(selectedOrder.delivery_address || selectedOrder.customer_address) && (
                  <div className="flex items-center gap-2 text-sm text-slate-600">
                    <MapPin className="w-4 h-4" />
                    {selectedOrder.delivery_address || selectedOrder.customer_address}
                  </div>
                )}
                {selectedOrder.showroom_name && (
                  <div className="flex items-center gap-2 text-sm text-slate-600">
                    <FileText className="w-4 h-4" />
                    Store: {selectedOrder.showroom_name}
                  </div>
                )}
              </div>

              {/* Order Items */}
              <div>
                <h4 className="font-medium mb-2">Items</h4>
                <div className="space-y-1 max-h-32 overflow-y-auto">
                  {(selectedOrder.items || selectedOrder.line_items || []).map((item, idx) => (
                    <div key={idx} className="flex justify-between text-sm p-2 bg-slate-50 rounded">
                      <span>{item.product_name} x{item.quantity}</span>
                      <span className="font-medium">£{((item.price || item.unit_price || 0) * item.quantity).toFixed(2)}</span>
                    </div>
                  ))}
                </div>
                <div className="flex justify-between font-bold mt-2 pt-2 border-t">
                  <span>Total</span>
                  <span>£{(selectedOrder.total || selectedOrder.total_amount || selectedOrder.gross_total || 0).toFixed(2)}</span>
                </div>
              </div>

              {/* Status Update */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Update Status</label>
                <Select value={editStatus} onValueChange={setEditStatus}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(statuses).map(([key, val]) => (
                      <SelectItem key={key} value={key}>
                        <div className="flex items-center gap-2">
                          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: val.color }} />
                          {val.label}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Notes */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Notes</label>
                <Textarea 
                  value={editNotes} 
                  onChange={(e) => setEditNotes(e.target.value)}
                  placeholder="Add notes about this order..."
                  rows={2}
                />
              </div>

              {/* Dates */}
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-slate-500">Created:</span>
                  <p className="font-medium">{moment(selectedOrder.created_at).format('DD MMM YYYY HH:mm')}</p>
                </div>
                <div>
                  <span className="text-slate-500">Delivery:</span>
                  <p className="font-medium">
                    {selectedOrder.delivery_date 
                      ? moment(selectedOrder.delivery_date).format('DD MMM YYYY')
                      : 'Not set'}
                  </p>
                </div>
              </div>
            </div>
          )}

          <DialogFooter className="flex-col sm:flex-row gap-2">
            <div className="flex gap-2 mr-auto">
              <Button 
                variant="outline" 
                size="sm"
                onClick={() => openNoteDatePicker('collection')}
                data-testid="download-collection-note"
              >
                <ClipboardList className="w-4 h-4 mr-2" />
                Collection Note
              </Button>
              <Button 
                variant="outline" 
                size="sm"
                onClick={() => openNoteDatePicker('delivery')}
                data-testid="download-delivery-note"
              >
                <Truck className="w-4 h-4 mr-2" />
                Delivery Note
              </Button>
            </div>
            <Button 
              variant="outline" 
              onClick={() => {
                setShowOrderDialog(false);
                setShowRescheduleDialog(true);
              }}
            >
              <CalendarIcon className="w-4 h-4 mr-2" />
              Reschedule
            </Button>
            <Button onClick={handleUpdateStatus}>
              <Check className="w-4 h-4 mr-2" />
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Collection/Delivery date picker — opens before the note PDF downloads */}
      <Dialog open={noteDatePicker.open} onOpenChange={(open) => !open && setNoteDatePicker({ open: false, noteType: '', value: '' })}>
        <DialogContent data-testid="note-date-picker-dialog">
          <DialogHeader>
            <DialogTitle>{noteDatePicker.noteType === 'collection' ? 'Collection date' : 'Delivery date'}</DialogTitle>
            <DialogDescription>
              Set the {noteDatePicker.noteType} date/time shown on the PDF.
            </DialogDescription>
          </DialogHeader>
          <Input
            type="datetime-local"
            autoFocus
            value={noteDatePicker.value}
            onChange={(e) => setNoteDatePicker((p) => ({ ...p, value: e.target.value }))}
            data-testid="note-date-picker-input"
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setNoteDatePicker({ open: false, noteType: '', value: '' })}
              data-testid="note-date-picker-cancel-btn"
            >
              Cancel
            </Button>
            <Button
              onClick={confirmNoteDatePicker}
              disabled={!noteDatePicker.value}
              data-testid="note-date-picker-confirm-btn"
            >
              Download
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reschedule Dialog */}
      <Dialog open={showRescheduleDialog} onOpenChange={setShowRescheduleDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reschedule Order</DialogTitle>
            <DialogDescription>
              Select a new delivery date for order #{selectedOrder?.id?.slice(0, 8)}
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">New Delivery Date</label>
              <Input 
                type="datetime-local"
                value={rescheduleDate}
                onChange={(e) => setRescheduleDate(e.target.value)}
              />
            </div>
            
            <div className="space-y-2">
              <label className="text-sm font-medium">Reason for Rescheduling</label>
              <Textarea 
                value={rescheduleNotes}
                onChange={(e) => setRescheduleNotes(e.target.value)}
                placeholder="Customer requested change, stock unavailable, etc."
                rows={2}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRescheduleDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleReschedule} disabled={!rescheduleDate}>
              Confirm Reschedule
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Overdue Orders Dialog */}
      <Dialog open={showOverdueDialog} onOpenChange={setShowOverdueDialog}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <AlertTriangle className="w-5 h-5" />
              Overdue Orders ({overdueOrders.length})
            </DialogTitle>
            <DialogDescription>
              These orders are past their delivery date and need attention
            </DialogDescription>
          </DialogHeader>
          
          <div className="max-h-96 overflow-y-auto space-y-2">
            {overdueOrders.map((order) => (
              <div 
                key={order.id} 
                className="p-3 border rounded-lg hover:bg-slate-50 cursor-pointer"
                onClick={() => {
                  setShowOverdueDialog(false);
                  setSelectedOrder(order);
                  setEditStatus(order.status || 'pending');
                  setEditNotes(order.notes || '');
                  setShowOrderDialog(true);
                }}
              >
                <div className="flex justify-between items-start">
                  <div>
                    <p className="font-medium">#{order.id.slice(0, 8)} - {order.customer_name}</p>
                    <p className="text-sm text-slate-500">
                      {order.showroom_name || 'No showroom'} • £{(order.total || order.total_amount || 0).toFixed(2)}
                    </p>
                  </div>
                  <Badge variant="destructive">
                    {order.days_overdue} day{order.days_overdue !== 1 ? 's' : ''} overdue
                  </Badge>
                </div>
              </div>
            ))}
            {overdueOrders.length === 0 && (
              <p className="text-center text-slate-500 py-8">No overdue orders</p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowOverdueDialog(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default OrderManagement;

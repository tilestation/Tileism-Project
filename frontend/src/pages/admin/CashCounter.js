import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { api } from '../../lib/api';
import { toast } from 'sonner';
import { 
  Banknote, 
  Plus, 
  Minus, 
  Clock, 
  CheckCircle, 
  AlertCircle,
  Building2,
  User,
  Receipt,
  Landmark,
  Calculator,
  History,
  FileText,
  Upload,
  X,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  KeyRound
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '../../components/ui/dialog';
import { Textarea } from '../../components/ui/textarea';
import AutoExportSchedulerCard from '../../components/AutoExportSchedulerCard';

const CashCounter = () => {
  const { user } = useAuth();
  const [showrooms, setShowrooms] = useState([]);
  const [selectedShowroom, setSelectedShowroom] = useState('');
  const [currentSession, setCurrentSession] = useState(null);
  const [expectedCash, setExpectedCash] = useState(null);
  const [loading, setLoading] = useState(true);
  
  // Dialog states
  const [showOpenDialog, setShowOpenDialog] = useState(false);
  const [showCloseDialog, setShowCloseDialog] = useState(false);
  const [showPettyDialog, setShowPettyDialog] = useState(false);
  const [showBankingDialog, setShowBankingDialog] = useState(false);
  const [showAdjustmentDialog, setShowAdjustmentDialog] = useState(false);
  const [showHistoryDialog, setShowHistoryDialog] = useState(false);
  const [showPinDialog, setShowPinDialog] = useState(false);
  
  // Form states
  const [openingFloat, setOpeningFloat] = useState('');
  const [actualCash, setActualCash] = useState('');
  const [pettyAmount, setPettyAmount] = useState('');
  const [pettyCategory, setPettyCategory] = useState('');
  const [pettyDescription, setPettyDescription] = useState('');
  const [pettyReceipt, setPettyReceipt] = useState(null);
  const [bankingAmount, setBankingAmount] = useState('');
  const [bankingNotes, setBankingNotes] = useState('');
  const [adjustmentAmount, setAdjustmentAmount] = useState('');
  const [adjustmentReason, setAdjustmentReason] = useState('');
  const [closingNotes, setClosingNotes] = useState('');
  
  // Categories
  const [categories, setCategories] = useState([]);
  const [newCategory, setNewCategory] = useState('');
  const [showAddCategory, setShowAddCategory] = useState(false);
  
  // History
  const [sessionHistory, setSessionHistory] = useState([]);
  const [eodReports, setEodReports] = useState([]);
  
  // PIN action tracking
  const [pendingAction, setPendingAction] = useState(null);
  const [staffPin, setStaffPin] = useState('');
  
  // Denominations for cash counting
  const [denominations, setDenominations] = useState({
    '50': 0, '20': 0, '10': 0, '5': 0, '2': 0, '1': 0, '0.50': 0, '0.20': 0, '0.10': 0, '0.05': 0, '0.02': 0, '0.01': 0
  });
  const [showDenominations, setShowDenominations] = useState(false);

  // Load showrooms
  useEffect(() => {
    const loadShowrooms = async () => {
      try {
        const res = await api.getShowrooms();
        setShowrooms(res.data || []);
        if (res.data && res.data.length > 0) {
          // Default to user's showroom or first one
          const defaultShowroom = user?.showroom_id || res.data[0].id;
          setSelectedShowroom(defaultShowroom);
        }
      } catch (error) {
        console.error('Error loading showrooms:', error);
      }
    };
    loadShowrooms();
  }, [user]);

  // Load current session when showroom changes
  const loadCurrentSession = useCallback(async () => {
    if (!selectedShowroom) return;
    
    setLoading(true);
    try {
      const res = await api.get(`/cash/sessions/current/${selectedShowroom}`);
      setCurrentSession(res.data.session);
      setExpectedCash(res.data.expected);
    } catch (error) {
      console.error('Error loading session:', error);
      setCurrentSession(null);
      setExpectedCash(null);
    } finally {
      setLoading(false);
    }
  }, [selectedShowroom]);

  useEffect(() => {
    loadCurrentSession();
  }, [loadCurrentSession]);

  // Load categories
  useEffect(() => {
    const loadCategories = async () => {
      try {
        const res = await api.get('/cash/petty-cash-categories');
        setCategories(res.data || []);
      } catch (error) {
        console.error('Error loading categories:', error);
      }
    };
    loadCategories();
  }, []);

  // Calculate total from denominations
  const calculateFromDenominations = () => {
    let total = 0;
    Object.entries(denominations).forEach(([denom, count]) => {
      total += parseFloat(denom) * count;
    });
    return total.toFixed(2);
  };

  // Update actual cash when denominations change
  useEffect(() => {
    if (showDenominations) {
      let total = 0;
      Object.entries(denominations).forEach(([denom, count]) => {
        total += parseFloat(denom) * count;
      });
      setActualCash(total.toFixed(2));
    }
  }, [denominations, showDenominations]);

  // Handle PIN confirmation
  const handlePinConfirm = async (pin) => {
    setStaffPin(pin);
    setShowPinDialog(false);
    
    if (pendingAction) {
      await pendingAction(pin);
      setPendingAction(null);
    }
  };

  // Open session
  const handleOpenSession = async (pin) => {
    try {
      await api.post('/cash/sessions/open', {
        showroom_id: selectedShowroom,
        opening_float: parseFloat(openingFloat),
        staff_pin: pin,
        notes: ''
      });
      toast.success('Cash session opened successfully');
      setShowOpenDialog(false);
      setOpeningFloat('');
      loadCurrentSession();
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to open session');
    }
  };

  // Close session
  const handleCloseSession = async (pin) => {
    try {
      await api.post(`/cash/sessions/close?showroom_id=${selectedShowroom}`, {
        actual_cash_counted: parseFloat(actualCash),
        staff_pin: pin,
        notes: closingNotes,
        denominations: showDenominations ? denominations : null
      });
      toast.success('Cash session closed successfully');
      setShowCloseDialog(false);
      setActualCash('');
      setClosingNotes('');
      setDenominations({ '50': 0, '20': 0, '10': 0, '5': 0, '2': 0, '1': 0, '0.50': 0, '0.20': 0, '0.10': 0, '0.05': 0, '0.02': 0, '0.01': 0 });
      loadCurrentSession();
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to close session');
    }
  };

  // Record petty cash
  const handleRecordPetty = async (pin) => {
    try {
      await api.post('/cash/petty-cash', {
        showroom_id: selectedShowroom,
        amount: parseFloat(pettyAmount),
        category: pettyCategory,
        description: pettyDescription,
        staff_pin: pin,
        receipt_image: pettyReceipt
      });
      toast.success('Petty cash recorded');
      setShowPettyDialog(false);
      setPettyAmount('');
      setPettyCategory('');
      setPettyDescription('');
      setPettyReceipt(null);
      loadCurrentSession();
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to record petty cash');
    }
  };

  // Record banking
  const handleRecordBanking = async (pin) => {
    try {
      await api.post('/cash/banking', {
        showroom_id: selectedShowroom,
        amount: parseFloat(bankingAmount),
        staff_pin: pin,
        notes: bankingNotes
      });
      toast.success('Banking recorded');
      setShowBankingDialog(false);
      setBankingAmount('');
      setBankingNotes('');
      loadCurrentSession();
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to record banking');
    }
  };

  // Record adjustment
  const handleRecordAdjustment = async (pin) => {
    try {
      await api.post('/cash/adjustments', {
        showroom_id: selectedShowroom,
        amount: parseFloat(adjustmentAmount),
        reason: adjustmentReason,
        staff_pin: pin
      });
      toast.success('Adjustment recorded');
      setShowAdjustmentDialog(false);
      setAdjustmentAmount('');
      setAdjustmentReason('');
      loadCurrentSession();
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to record adjustment');
    }
  };

  // Add category
  const handleAddCategory = async () => {
    if (!newCategory.trim()) return;
    try {
      await api.post('/cash/petty-cash-categories', { name: newCategory });
      toast.success('Category added');
      setNewCategory('');
      setShowAddCategory(false);
      const res = await api.get('/cash/petty-cash-categories');
      setCategories(res.data || []);
    } catch (error) {
      toast.error('Failed to add category');
    }
  };

  // Load history
  const loadHistory = async () => {
    try {
      const [sessionsRes, reportsRes] = await Promise.all([
        api.get(`/cash/sessions/history/${selectedShowroom}?limit=30`),
        api.get(`/cash/eod-reports/${selectedShowroom}?limit=30`)
      ]);
      setSessionHistory(sessionsRes.data || []);
      setEodReports(reportsRes.data || []);
      setShowHistoryDialog(true);
    } catch (error) {
      toast.error('Failed to load history');
    }
  };

  // Handle receipt upload
  const handleReceiptUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setPettyReceipt(reader.result);
      };
      reader.readAsDataURL(file);
    }
  };

  // Format currency
  const formatCurrency = (amount) => {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(amount || 0);
  };

  // Format date
  const formatDate = (dateStr) => {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const currentShowroom = showrooms.find(s => s.id === selectedShowroom);

  return (
    <div className="space-y-6" data-testid="cash-counter-page">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-4xl font-heading font-bold tracking-tightest mb-2">Cash Counter</h1>
          <p className="text-muted-foreground">End of day cash management and reconciliation</p>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={selectedShowroom}
            onChange={(e) => setSelectedShowroom(e.target.value)}
            className="h-10 px-3 rounded-md border border-input bg-background text-sm"
            data-testid="showroom-select"
          >
            {showrooms.map(showroom => (
              <option key={showroom.id} value={showroom.id}>{showroom.name}</option>
            ))}
          </select>
          <Button variant="outline" onClick={loadHistory} data-testid="history-btn">
            <History className="h-4 w-4 mr-2" />
            History
          </Button>
        </div>
      </div>

      {/* 13 Jun 2026 — Auto-monthly petty cash receipts export to the
          accountant. Super-admin only (the card silently no-ops for
          other roles via the 403 on /api/auto-exports). Per-showroom
          schedule: each store can email its own accountant on its own
          day of the month. */}
      {user?.role === 'super_admin' && selectedShowroom && (
        <AutoExportSchedulerCard
          kind="petty_cash"
          scope={selectedShowroom}
          title={`Auto-email petty cash receipts — ${currentShowroom?.name || 'this showroom'}`}
          description="On the chosen day each month, last month's petty cash receipts (images + a summary CSV) are emailed straight to your accountant — no clicks required."
          testIdPrefix={`auto-export-petty-cash-${selectedShowroom}`}
        />
      )}

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : !currentSession ? (
        /* No Active Session */
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16">
            <div className="w-16 h-16 rounded-full bg-amber-100 flex items-center justify-center mb-4">
              <AlertCircle className="h-8 w-8 text-amber-600" />
            </div>
            <h2 className="text-xl font-semibold mb-2">No Active Session</h2>
            <p className="text-muted-foreground mb-6 text-center max-w-md">
              Start a new cash session for {currentShowroom?.name || 'this showroom'} by entering your opening float.
            </p>
            <Button 
              size="lg" 
              onClick={() => setShowOpenDialog(true)}
              data-testid="open-session-btn"
            >
              <Plus className="h-5 w-5 mr-2" />
              Start Day / Open Session
            </Button>
          </CardContent>
        </Card>
      ) : (
        /* Active Session */
        <>
          {/* Session Status Card */}
          <Card className="border-green-200 bg-green-50">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CheckCircle className="h-5 w-5 text-green-600" />
                  <CardTitle className="text-green-800">Session Active</CardTitle>
                </div>
                <span className="text-sm text-green-600">
                  Opened by {currentSession.opened_by} at {formatDate(currentSession.opened_at)}
                </span>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-white rounded-lg p-4">
                  <div className="text-sm text-muted-foreground mb-1">Opening Float</div>
                  <div className="text-2xl font-bold">{formatCurrency(currentSession.opening_float)}</div>
                </div>
                <div className="bg-white rounded-lg p-4">
                  <div className="text-sm text-muted-foreground mb-1">Cash Sales</div>
                  <div className="text-2xl font-bold text-green-600">+{formatCurrency(expectedCash?.cash_sales)}</div>
                </div>
                <div className="bg-white rounded-lg p-4">
                  <div className="text-sm text-muted-foreground mb-1">Cash Deposits</div>
                  <div className="text-2xl font-bold text-green-600">+{formatCurrency(expectedCash?.cash_deposits)}</div>
                </div>
                <div className="bg-white rounded-lg p-4">
                  <div className="text-sm text-muted-foreground mb-1">Expected Cash</div>
                  <div className="text-2xl font-bold text-blue-600">{formatCurrency(expectedCash?.expected_cash)}</div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Actions Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Petty Cash Card */}
            <Card className="hover:shadow-md transition-shadow cursor-pointer" onClick={() => setShowPettyDialog(true)}>
              <CardContent className="pt-6">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
                    <Minus className="h-5 w-5 text-red-600" />
                  </div>
                  <div>
                    <div className="font-semibold">Petty Cash</div>
                    <div className="text-sm text-muted-foreground">Record paid out</div>
                  </div>
                </div>
                <div className="text-xl font-bold text-red-600">-{formatCurrency(expectedCash?.petty_cash_total)}</div>
              </CardContent>
            </Card>

            {/* Banking Card */}
            <Card className="hover:shadow-md transition-shadow cursor-pointer" onClick={() => setShowBankingDialog(true)}>
              <CardContent className="pt-6">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center">
                    <Landmark className="h-5 w-5 text-blue-600" />
                  </div>
                  <div>
                    <div className="font-semibold">Banking</div>
                    <div className="text-sm text-muted-foreground">Record cash banked</div>
                  </div>
                </div>
                <div className="text-xl font-bold text-blue-600">-{formatCurrency(expectedCash?.banking_total)}</div>
              </CardContent>
            </Card>

            {/* Adjustment Card */}
            <Card className="hover:shadow-md transition-shadow cursor-pointer" onClick={() => setShowAdjustmentDialog(true)}>
              <CardContent className="pt-6">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-full bg-purple-100 flex items-center justify-center">
                    <Calculator className="h-5 w-5 text-purple-600" />
                  </div>
                  <div>
                    <div className="font-semibold">Adjustment</div>
                    <div className="text-sm text-muted-foreground">Add/remove cash</div>
                  </div>
                </div>
                <div className="text-xl font-bold text-purple-600">{formatCurrency(expectedCash?.adjustments_total)}</div>
              </CardContent>
            </Card>

            {/* End Day Card */}
            <Card className="hover:shadow-md transition-shadow cursor-pointer border-amber-200 bg-amber-50" onClick={() => setShowCloseDialog(true)}>
              <CardContent className="pt-6">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-full bg-amber-200 flex items-center justify-center">
                    <Clock className="h-5 w-5 text-amber-700" />
                  </div>
                  <div>
                    <div className="font-semibold text-amber-800">End Day</div>
                    <div className="text-sm text-amber-600">Cash up & close</div>
                  </div>
                </div>
                <div className="text-xl font-bold text-amber-700">Close Session</div>
              </CardContent>
            </Card>
          </div>

          {/* Refresh Button */}
          <div className="flex justify-center">
            <Button variant="outline" onClick={loadCurrentSession}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh Totals
            </Button>
          </div>
        </>
      )}

      {/* Open Session Dialog */}
      <Dialog open={showOpenDialog} onOpenChange={setShowOpenDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start Day - Open Cash Session</DialogTitle>
            <DialogDescription>Enter the opening float for {currentShowroom?.name}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Opening Float (£)</label>
              <Input
                type="number"
                step="0.01"
                placeholder="0.00"
                value={openingFloat}
                onChange={(e) => setOpeningFloat(e.target.value)}
                data-testid="opening-float-input"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowOpenDialog(false)}>Cancel</Button>
            <Button 
              onClick={() => {
                setPendingAction(() => handleOpenSession);
                setShowPinDialog(true);
              }}
              disabled={!openingFloat || parseFloat(openingFloat) < 0}
            >
              Open Session
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Close Session Dialog */}
      <Dialog open={showCloseDialog} onOpenChange={setShowCloseDialog}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>End Day - Close Cash Session</DialogTitle>
            <DialogDescription>Count your cash and close the session</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {/* Summary */}
            <div className="bg-gray-50 rounded-lg p-4">
              <h4 className="font-medium mb-3">Session Summary</h4>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>Opening Float:</div>
                <div className="text-right">{formatCurrency(expectedCash?.opening_float)}</div>
                <div>Cash Sales:</div>
                <div className="text-right text-green-600">+{formatCurrency(expectedCash?.cash_sales)}</div>
                <div>Cash Deposits:</div>
                <div className="text-right text-green-600">+{formatCurrency(expectedCash?.cash_deposits)}</div>
                <div>Petty Cash:</div>
                <div className="text-right text-red-600">-{formatCurrency(expectedCash?.petty_cash_total)}</div>
                <div>Banking:</div>
                <div className="text-right text-red-600">-{formatCurrency(expectedCash?.banking_total)}</div>
                <div>Adjustments:</div>
                <div className="text-right">{formatCurrency(expectedCash?.adjustments_total)}</div>
                <div className="font-bold border-t pt-2">Expected Cash:</div>
                <div className="text-right font-bold border-t pt-2 text-blue-600">{formatCurrency(expectedCash?.expected_cash)}</div>
              </div>
            </div>

            {/* Cash Counting */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium">Actual Cash Counted (£)</label>
                <Button 
                  variant="ghost" 
                  size="sm"
                  onClick={() => setShowDenominations(!showDenominations)}
                >
                  {showDenominations ? <ChevronUp className="h-4 w-4 mr-1" /> : <ChevronDown className="h-4 w-4 mr-1" />}
                  Count by Denomination
                </Button>
              </div>
              
              {showDenominations ? (
                <div className="bg-gray-50 rounded-lg p-4">
                  <div className="grid grid-cols-4 gap-3">
                    {Object.keys(denominations).map(denom => (
                      <div key={denom} className="flex items-center gap-2">
                        <span className="text-sm font-medium w-12">£{denom}</span>
                        <Input
                          type="number"
                          min="0"
                          className="h-8 w-16 text-center"
                          value={denominations[denom]}
                          onChange={(e) => setDenominations(prev => ({
                            ...prev,
                            [denom]: parseInt(e.target.value) || 0
                          }))}
                        />
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 pt-3 border-t">
                    <div className="text-sm text-muted-foreground">Total from denominations:</div>
                    <div className="text-2xl font-bold">{formatCurrency(calculateFromDenominations())}</div>
                  </div>
                </div>
              ) : (
                <Input
                  type="number"
                  step="0.01"
                  placeholder="0.00"
                  value={actualCash}
                  onChange={(e) => setActualCash(e.target.value)}
                  data-testid="actual-cash-input"
                />
              )}
            </div>

            {/* Variance */}
            {actualCash && (
              <div className={`rounded-lg p-4 ${
                parseFloat(actualCash) === expectedCash?.expected_cash ? 'bg-green-50' :
                parseFloat(actualCash) > expectedCash?.expected_cash ? 'bg-blue-50' : 'bg-red-50'
              }`}>
                <div className="text-sm mb-1">Variance</div>
                <div className={`text-2xl font-bold ${
                  parseFloat(actualCash) === expectedCash?.expected_cash ? 'text-green-600' :
                  parseFloat(actualCash) > expectedCash?.expected_cash ? 'text-blue-600' : 'text-red-600'
                }`}>
                  {parseFloat(actualCash) >= expectedCash?.expected_cash ? '+' : ''}
                  {formatCurrency(parseFloat(actualCash) - (expectedCash?.expected_cash || 0))}
                  {parseFloat(actualCash) === expectedCash?.expected_cash && ' (Balanced)'}
                  {parseFloat(actualCash) > expectedCash?.expected_cash && ' (Over)'}
                  {parseFloat(actualCash) < expectedCash?.expected_cash && ' (Short)'}
                </div>
              </div>
            )}

            {/* Notes */}
            <div>
              <label className="text-sm font-medium mb-2 block">Notes (optional)</label>
              <Textarea
                placeholder="Any notes about this cash up..."
                value={closingNotes}
                onChange={(e) => setClosingNotes(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCloseDialog(false)}>Cancel</Button>
            <Button 
              onClick={() => {
                setPendingAction(() => handleCloseSession);
                setShowPinDialog(true);
              }}
              disabled={!actualCash || parseFloat(actualCash) < 0}
              className="bg-amber-600 hover:bg-amber-700"
            >
              Close Session
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Petty Cash Dialog */}
      <Dialog open={showPettyDialog} onOpenChange={setShowPettyDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record Petty Cash / Paid Out</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Amount (£)</label>
              <Input
                type="number"
                step="0.01"
                placeholder="0.00"
                value={pettyAmount}
                onChange={(e) => setPettyAmount(e.target.value)}
              />
            </div>
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium">Category</label>
                <Button variant="ghost" size="sm" onClick={() => setShowAddCategory(!showAddCategory)}>
                  <Plus className="h-4 w-4 mr-1" /> Add New
                </Button>
              </div>
              {showAddCategory && (
                <div className="flex gap-2 mb-2">
                  <Input
                    placeholder="New category name"
                    value={newCategory}
                    onChange={(e) => setNewCategory(e.target.value)}
                  />
                  <Button size="sm" onClick={handleAddCategory}>Add</Button>
                </div>
              )}
              <select
                className="w-full h-10 px-3 rounded-md border border-input bg-background"
                value={pettyCategory}
                onChange={(e) => setPettyCategory(e.target.value)}
              >
                <option value="">Select category...</option>
                {categories.map(cat => (
                  <option key={cat.id} value={cat.name}>{cat.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Description</label>
              <Textarea
                placeholder="What was this expense for?"
                value={pettyDescription}
                onChange={(e) => setPettyDescription(e.target.value)}
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Receipt (optional)</label>
              <div className="flex items-center gap-3">
                <Input
                  type="file"
                  accept="image/*"
                  onChange={handleReceiptUpload}
                  className="flex-1"
                />
                {pettyReceipt && (
                  <Button variant="ghost" size="sm" onClick={() => setPettyReceipt(null)}>
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </div>
              {pettyReceipt && (
                <img src={pettyReceipt} alt="Receipt" className="mt-2 max-h-32 rounded" />
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPettyDialog(false)}>Cancel</Button>
            <Button 
              onClick={() => {
                setPendingAction(() => handleRecordPetty);
                setShowPinDialog(true);
              }}
              disabled={!pettyAmount || !pettyCategory || !pettyDescription}
              className="bg-red-600 hover:bg-red-700"
            >
              Record Paid Out
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Banking Dialog */}
      <Dialog open={showBankingDialog} onOpenChange={setShowBankingDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record Banking</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Amount Banked (£)</label>
              <Input
                type="number"
                step="0.01"
                placeholder="0.00"
                value={bankingAmount}
                onChange={(e) => setBankingAmount(e.target.value)}
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Notes (optional)</label>
              <Textarea
                placeholder="Any notes..."
                value={bankingNotes}
                onChange={(e) => setBankingNotes(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBankingDialog(false)}>Cancel</Button>
            <Button 
              onClick={() => {
                setPendingAction(() => handleRecordBanking);
                setShowPinDialog(true);
              }}
              disabled={!bankingAmount || parseFloat(bankingAmount) <= 0}
            >
              Record Banking
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Adjustment Dialog */}
      <Dialog open={showAdjustmentDialog} onOpenChange={setShowAdjustmentDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record Cash Adjustment</DialogTitle>
            <DialogDescription>Use positive amounts for cash in, negative for cash out</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Amount (£)</label>
              <Input
                type="number"
                step="0.01"
                placeholder="e.g., 50 or -20"
                value={adjustmentAmount}
                onChange={(e) => setAdjustmentAmount(e.target.value)}
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Reason</label>
              <Textarea
                placeholder="Why is this adjustment needed?"
                value={adjustmentReason}
                onChange={(e) => setAdjustmentReason(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdjustmentDialog(false)}>Cancel</Button>
            <Button 
              onClick={() => {
                setPendingAction(() => handleRecordAdjustment);
                setShowPinDialog(true);
              }}
              disabled={!adjustmentAmount || !adjustmentReason}
            >
              Record Adjustment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* History Dialog */}
      <Dialog open={showHistoryDialog} onOpenChange={setShowHistoryDialog}>
        <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Cash Session History</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {eodReports.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">No history available</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2">Date</th>
                    <th className="text-right py-2">Opening</th>
                    <th className="text-right py-2">Sales</th>
                    <th className="text-right py-2">Petty</th>
                    <th className="text-right py-2">Banking</th>
                    <th className="text-right py-2">Expected</th>
                    <th className="text-right py-2">Actual</th>
                    <th className="text-right py-2">Variance</th>
                    <th className="text-left py-2">Closed By</th>
                  </tr>
                </thead>
                <tbody>
                  {eodReports.map(report => (
                    <tr key={report.id} className="border-b hover:bg-gray-50">
                      <td className="py-2">{report.date}</td>
                      <td className="text-right">{formatCurrency(report.opening_float)}</td>
                      <td className="text-right text-green-600">{formatCurrency(report.cash_sales + report.cash_deposits)}</td>
                      <td className="text-right text-red-600">-{formatCurrency(report.petty_cash_total)}</td>
                      <td className="text-right text-blue-600">-{formatCurrency(report.banking_total)}</td>
                      <td className="text-right font-medium">{formatCurrency(report.expected_cash)}</td>
                      <td className="text-right font-medium">{formatCurrency(report.actual_cash)}</td>
                      <td className={`text-right font-medium ${
                        report.variance === 0 ? 'text-green-600' :
                        report.variance > 0 ? 'text-blue-600' : 'text-red-600'
                      }`}>
                        {report.variance >= 0 ? '+' : ''}{formatCurrency(report.variance)}
                      </td>
                      <td className="py-2">{report.closed_by}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Staff PIN Dialog */}
      <Dialog open={showPinDialog} onOpenChange={(open) => {
        setShowPinDialog(open);
        if (!open) {
          setPendingAction(null);
          setStaffPin('');
        }
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5" />
              Confirm with Staff PIN
            </DialogTitle>
            <DialogDescription>
              Enter your staff PIN to confirm this action
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Input
              type="password"
              placeholder="Enter PIN"
              value={staffPin}
              onChange={(e) => setStaffPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
              className="text-center text-2xl tracking-widest"
              maxLength={6}
              autoFocus
              onKeyPress={(e) => {
                if (e.key === 'Enter' && staffPin.length >= 4 && pendingAction) {
                  pendingAction(staffPin);
                  setShowPinDialog(false);
                  setStaffPin('');
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setShowPinDialog(false);
              setPendingAction(null);
              setStaffPin('');
            }}>
              Cancel
            </Button>
            <Button 
              onClick={() => {
                if (pendingAction) {
                  pendingAction(staffPin);
                  setShowPinDialog(false);
                  setStaffPin('');
                }
              }}
              disabled={staffPin.length < 4}
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default CashCounter;

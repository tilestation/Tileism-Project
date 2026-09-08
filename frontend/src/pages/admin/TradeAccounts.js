import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { 
  Building2, 
  Plus, 
  Search, 
  Phone, 
  Mail, 
  MapPin, 
  Edit, 
  Trash2, 
  ChevronDown,
  ChevronUp,
  Award,
  Users,
  PoundSterling,
  ShoppingBag,
  Filter,
  X,
  MessageCircle,
  Send,
  CheckCircle,
  Loader2,
  Clock,
  XCircle,
  KeyRound,
  History
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card, CardHeader, CardTitle, CardContent } from '../../components/ui/card';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import CreditStatementPreviewButton from '../../components/admin/CreditStatementPreviewButton';
import { TraderDrawer } from './trade/TraderDrawer';
import { ChannelBadge, LoginStatusBadge } from './trade/TradeBadges';

// Tier badge component
const TierBadge = ({ tier, tierInfo }) => {
  const colors = {
    bronze: 'bg-amber-700 text-white',
    silver: 'bg-gray-400 text-white',
    gold: 'bg-yellow-500 text-black',
    platinum: 'bg-gray-200 text-gray-800'
  };
  
  return (
    <span className={`px-2 py-1 rounded-full text-xs font-semibold ${colors[tier] || colors.bronze}`}>
      {tierInfo?.name || tier} ({tierInfo?.discount || 5}% off)
    </span>
  );
};

// Trade Account Form Modal
const TradeAccountModal = ({ isOpen, onClose, account, tradeTypes, onSave }) => {
  const [formData, setFormData] = useState({
    business_name: '',
    trading_name: '',
    contact_name: '',
    contact_phone: '',
    contact_email: '',
    address_line1: '',
    address_line2: '',
    city: '',
    county: '',
    postcode: '',
    vat_number: '',
    company_reg_number: '',
    trade_type: 'Builder',
    notes: '',
    pricing_tier: 'bronze',
    custom_discount: '',
    status: 'active'
  });
  const [loading, setLoading] = useState(false);
  const [useCustomDiscount, setUseCustomDiscount] = useState(false);
  
  useEffect(() => {
    if (account) {
      const hasCustom = account.custom_discount != null && account.pricing_tier_override;
      setUseCustomDiscount(hasCustom);
      setFormData({
        business_name: account.business_name || '',
        trading_name: account.trading_name || '',
        contact_name: account.contact_name || '',
        contact_phone: account.contact_phone || '',
        contact_email: account.contact_email || '',
        address_line1: account.address_line1 || '',
        address_line2: account.address_line2 || '',
        city: account.city || '',
        county: account.county || '',
        postcode: account.postcode || '',
        vat_number: account.vat_number || '',
        company_reg_number: account.company_reg_number || '',
        trade_type: account.trade_type || 'Builder',
        notes: account.notes || '',
        pricing_tier: account.pricing_tier || 'bronze',
        custom_discount: hasCustom ? account.custom_discount : '',
        status: account.status || 'active'
      });
    } else {
      setUseCustomDiscount(false);
      setFormData({
        business_name: '',
        trading_name: '',
        contact_name: '',
        contact_phone: '',
        contact_email: '',
        address_line1: '',
        address_line2: '',
        city: '',
        county: '',
        postcode: '',
        vat_number: '',
        company_reg_number: '',
        trade_type: 'Builder',
        notes: '',
        pricing_tier: 'bronze',
        custom_discount: '',
        status: 'active'
      });
    }
  }, [account, isOpen]);
  
  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    
    try {
      const submitData = { ...formData };
      if (useCustomDiscount && submitData.custom_discount !== '') {
        submitData.custom_discount = parseFloat(submitData.custom_discount);
      } else {
        delete submitData.custom_discount;
      }
      
      if (account) {
        await api.updateTradeAccount(account.id, submitData);
        toast.success('Trade account updated');
      } else {
        const { data } = await api.createTradeAccount(submitData);
        const ll = data?.login_link;
        toast.success(
          ll?.email_sent
            ? `Trade account ${data.trade_account_number || ''} created — set-password email sent to ${data.contact_email}`
            : `Trade account ${data.trade_account_number || ''} created`,
          ll && !ll.email_sent ? { description: `Email not sent (${ll.email_error || 'email service unavailable'}) — use the key button to copy a login link.` } : undefined
        );
      }
      onSave();
      onClose();
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to save trade account');
    } finally {
      setLoading(false);
    }
  };
  
  if (!isOpen) return null;
  
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto m-4">
        <div className="sticky top-0 bg-white border-b px-6 py-4 flex justify-between items-center">
          <h2 className="text-xl font-semibold">
            {account ? 'Edit Trade Account' : 'New Trade Account'}
          </h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-full">
            <X className="h-5 w-5" />
          </button>
        </div>
        
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* Business Details */}
          <div className="space-y-4">
            <h3 className="font-medium text-gray-700 border-b pb-2">Business Details</h3>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Business Name *</label>
                <Input
                  value={formData.business_name}
                  onChange={(e) => setFormData({...formData, business_name: e.target.value})}
                  placeholder="e.g., Smith Building Ltd"
                  required
                  data-testid="business-name-input"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Trading Name</label>
                <Input
                  value={formData.trading_name}
                  onChange={(e) => setFormData({...formData, trading_name: e.target.value})}
                  placeholder="Trading as (if different)"
                  data-testid="trading-name-input"
                />
              </div>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">VAT Number</label>
                <Input
                  value={formData.vat_number}
                  onChange={(e) => setFormData({...formData, vat_number: e.target.value})}
                  placeholder="GB123456789"
                  data-testid="vat-number-input"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Company Reg. Number</label>
                <Input
                  value={formData.company_reg_number}
                  onChange={(e) => setFormData({...formData, company_reg_number: e.target.value})}
                  placeholder="12345678"
                  data-testid="company-reg-input"
                />
              </div>
            </div>
            
            <div>
              <label className="block text-sm font-medium mb-1">Trade Type *</label>
              <select
                value={formData.trade_type}
                onChange={(e) => setFormData({...formData, trade_type: e.target.value})}
                className="w-full px-3 py-2 border rounded-md"
                required
                data-testid="trade-type-select"
              >
                {tradeTypes.map(type => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
            </div>
          </div>
          
          {/* Contact Details */}
          <div className="space-y-4">
            <h3 className="font-medium text-gray-700 border-b pb-2">Contact Details</h3>
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Contact Name *</label>
                <Input
                  value={formData.contact_name}
                  onChange={(e) => setFormData({...formData, contact_name: e.target.value})}
                  placeholder="John Smith"
                  required
                  data-testid="contact-name-input"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Phone *</label>
                <Input
                  value={formData.contact_phone}
                  onChange={(e) => setFormData({...formData, contact_phone: e.target.value})}
                  placeholder="07123456789"
                  required
                  data-testid="contact-phone-input"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Email *</label>
                <Input
                  type="email"
                  value={formData.contact_email}
                  onChange={(e) => setFormData({...formData, contact_email: e.target.value})}
                  placeholder="john@smithbuilding.co.uk"
                  required
                  data-testid="contact-email-input"
                />
              </div>
            </div>
          </div>
          
          {/* Address */}
          <div className="space-y-4">
            <h3 className="font-medium text-gray-700 border-b pb-2">Address</h3>
            
            <div>
              <label className="block text-sm font-medium mb-1">Address Line 1 *</label>
              <Input
                value={formData.address_line1}
                onChange={(e) => setFormData({...formData, address_line1: e.target.value})}
                placeholder="123 High Street"
                required
                data-testid="address-line1-input"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Address Line 2</label>
              <Input
                value={formData.address_line2}
                onChange={(e) => setFormData({...formData, address_line2: e.target.value})}
                placeholder="Unit 5"
                data-testid="address-line2-input"
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">City *</label>
                <Input
                  value={formData.city}
                  onChange={(e) => setFormData({...formData, city: e.target.value})}
                  placeholder="London"
                  required
                  data-testid="city-input"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">County</label>
                <Input
                  value={formData.county}
                  onChange={(e) => setFormData({...formData, county: e.target.value})}
                  placeholder="Kent"
                  data-testid="county-input"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Postcode *</label>
                <Input
                  value={formData.postcode}
                  onChange={(e) => setFormData({...formData, postcode: e.target.value.toUpperCase()})}
                  placeholder="DA1 1AB"
                  required
                  data-testid="postcode-input"
                />
              </div>
            </div>
          </div>
          
          {/* Notes */}
          <div>
            <label className="block text-sm font-medium mb-1">Notes</label>
            <textarea
              value={formData.notes}
              onChange={(e) => setFormData({...formData, notes: e.target.value})}
              placeholder="Any additional notes..."
              className="w-full px-3 py-2 border rounded-md"
              rows={3}
              data-testid="notes-input"
            />
          </div>

          {/* Pricing & Status (only when editing) */}
          {account && (
            <div className="space-y-4">
              <h3 className="font-medium text-gray-700 border-b pb-2 flex items-center gap-2">
                <Award className="h-4 w-4" /> Pricing & Status
              </h3>
              
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Account Status</label>
                  <select
                    value={formData.status}
                    onChange={(e) => setFormData({...formData, status: e.target.value})}
                    className="w-full px-3 py-2 border rounded-md"
                    data-testid="status-select"
                  >
                    <option value="active">Active</option>
                    <option value="pending">Pending Approval</option>
                    <option value="suspended">Suspended</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Current account discount</label>
                  <p className="px-3 py-2 bg-gray-50 border rounded-md text-gray-700 font-medium">
                    {account.trade_discount || 0}% off
                  </p>
                  <p className="text-[11px] text-gray-500 mt-1">Used by EPOS "apply trade pricing". Website trade prices are set per product in the Pricing Hub.</p>
                </div>
              </div>

              {/* Manual discount — no tiers, you decide per tradesman */}
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                <label className="flex items-center gap-2 cursor-pointer mb-3">
                  <input
                    type="checkbox"
                    checked={useCustomDiscount}
                    onChange={(e) => {
                      setUseCustomDiscount(e.target.checked);
                      if (!e.target.checked) {
                        setFormData(prev => ({...prev, custom_discount: ''}));
                      }
                    }}
                    className="w-4 h-4 text-amber-500 rounded"
                    data-testid="custom-discount-toggle"
                  />
                  <span className="font-medium text-amber-800">Manual trade discount</span>
                  <span className="text-xs text-amber-600">(set individually — there are no automatic tiers)</span>
                </label>
                {useCustomDiscount && (
                  <div className="flex items-center gap-3">
                    <div className="relative flex-1 max-w-[200px]">
                      <Input
                        type="number"
                        min="0"
                        max="50"
                        step="0.5"
                        value={formData.custom_discount}
                        onChange={(e) => setFormData({...formData, custom_discount: e.target.value})}
                        placeholder="e.g. 7.5"
                        className="pr-8"
                        data-testid="custom-discount-input"
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-amber-600 font-bold">%</span>
                    </div>
                    <span className="text-sm text-amber-700">This tradesman gets this rate on EPOS trade pricing.</span>
                  </div>
                )}
              </div>
            </div>
          )}
          
          <div className="flex justify-end gap-3 pt-4 border-t">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading} data-testid="save-trade-account-btn">
              {loading ? 'Saving...' : (account ? 'Update Account' : 'Create Account')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
};

// Main Trade Accounts Page (also rendered as the "Traders" tab inside Trade Hub)
const TradeAccounts = ({ embedded = false }) => {
  const [accounts, setAccounts] = useState([]);
  const [tradeTypes, setTradeTypes] = useState([]);
  const [pricingTiers, setPricingTiers] = useState({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterTradeType, setFilterTradeType] = useState('');
  const [filterTier, setFilterTier] = useState('');
  const [filterLogin, setFilterLogin] = useState('');
  const [filterChannel, setFilterChannel] = useState('');
  const [filterActivity, setFilterActivity] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editingAccount, setEditingAccount] = useState(null);
  const [expandedAccount, setExpandedAccount] = useState(null);
  const [drawerId, setDrawerId] = useState(null);
  const [bulkLinksSending, setBulkLinksSending] = useState(false);
  // WhatsApp states
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [sendingTo, setSendingTo] = useState(null); // customer ID currently sending to
  const [showCustomMsg, setShowCustomMsg] = useState(false);
  const [customMessage, setCustomMessage] = useState('');
  const [sendingCustom, setSendingCustom] = useState(false);
  const [bulkSending, setBulkSending] = useState(false);
  const [messageHistory, setMessageHistory] = useState({});

  // Super-admin only: EPOS feature flags. The UI panel renders only when
  // `user?.role === 'super_admin'` so other admins never see (or can flip)
  // experimental EPOS toggles. Default state: empty object → all flags
  // resolve to their hardcoded defaults (false).
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';
  const [eposFeatureFlags, setEposFeatureFlags] = useState({});
  const [eposFlagsLoading, setEposFlagsLoading] = useState(false);
  const [eposFlagsSaving, setEposFlagsSaving] = useState(false);

  useEffect(() => {
    if (!isSuperAdmin) return;
    let cancelled = false;
    setEposFlagsLoading(true);
    api.getEposFeatureFlags()
      .then(r => { if (!cancelled) setEposFeatureFlags(r.data?.flags || {}); })
      .catch(() => { /* non-fatal */ })
      .finally(() => { if (!cancelled) setEposFlagsLoading(false); });
    return () => { cancelled = true; };
  }, [isSuperAdmin]);

  const toggleEposFlag = async (key, next) => {
    if (eposFlagsSaving) return;
    setEposFlagsSaving(true);
    // Optimistic update
    setEposFeatureFlags(prev => ({ ...prev, [key]: next }));
    try {
      const r = await api.updateEposFeatureFlags({ [key]: next });
      setEposFeatureFlags(r.data?.flags || {});
      toast.success(next ? `${key} enabled` : `${key} disabled`);
    } catch (e) {
      // Revert on failure
      setEposFeatureFlags(prev => ({ ...prev, [key]: !next }));
      toast.error('Could not save toggle');
    } finally {
      setEposFlagsSaving(false);
    }
  };
  
  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [accountsRes, typesRes, tiersRes] = await Promise.all([
        api.getTradeAccounts({ search, trade_type: filterTradeType, tier: filterTier, login_status: filterLogin, channel: filterChannel, activity: filterActivity, limit: 300 }),
        api.getTradeTypes(),
        api.getPricingTiers()
      ]);
      setAccounts(accountsRes.data.accounts || []);
      setTradeTypes(typesRes.data || []);
      setPricingTiers(tiersRes.data || {});
    } catch (error) {
      console.error('Failed to fetch trade accounts:', error);
      toast.error('Failed to load trade accounts');
    } finally {
      setLoading(false);
    }
  }, [search, filterTradeType, filterTier, filterLogin, filterChannel, filterActivity]);
  
  useEffect(() => {
    fetchData();
  }, [fetchData]);
  
  const handleDelete = async (account) => {
    if (!window.confirm(`Are you sure you want to deactivate "${account.business_name}"?`)) return;
    
    try {
      await api.deleteTradeAccount(account.id);
      toast.success('Trade account deactivated');
      fetchData();
    } catch (error) {
      toast.error('Failed to deactivate account');
    }
  };
  
  const handleEdit = (account) => {
    setEditingAccount(account);
    setShowModal(true);
  };
  
  const handleCreate = () => {
    setEditingAccount(null);
    setShowModal(true);
  };
  
  const clearFilters = () => {
    setSearch('');
    setFilterTradeType('');
    setFilterTier('');
    setFilterLogin('');
    setFilterChannel('');
    setFilterActivity('');
  };

  // WhatsApp handlers
  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === accounts.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(accounts.map(a => a.id)));
    }
  };

  const [sendingLinkTo, setSendingLinkTo] = useState(null);

  const sendLoginLink = async (account) => {
    setSendingLinkTo(account.id);
    try {
      const { data } = await api.sendTradeLoginLink(account.id);
      const copy = () => navigator.clipboard?.writeText(data.link).then(() => toast.success('Link copied'));
      toast.success(
        data.email_sent ? `Login link emailed to ${data.email}` : `Link created — email not sent (${data.email_error || 'email service unavailable'})`,
        { description: 'Valid for 7 days. Copy it to send by WhatsApp or read out over the phone.', action: { label: 'Copy link', onClick: copy }, duration: 12000 }
      );
      fetchData();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to send login link');
    } finally {
      setSendingLinkTo(null);
    }
  };

  const bulkSendLoginLinks = async () => {
    const targets = selectedIds.size > 0 ? [...selectedIds] : accounts.map((a) => a.id);
    if (targets.length === 0) { toast.error('No accounts to send to'); return; }
    const scope = selectedIds.size > 0 ? `${targets.length} selected` : `all ${targets.length} shown`;
    if (!window.confirm(`Email set-password login links to ${scope} trade account(s)?`)) return;
    setBulkLinksSending(true);
    try {
      const { data } = await api.bulkSendTradeLoginLinks(targets);
      toast.success(`Login links: sent ${data.sent}, failed ${data.failed.length}`, {
        description: data.failed.length ? data.failed.slice(0, 3).map((f) => `${f.email || f.id}: ${f.error}`).join(' · ') : 'Links are valid for 7 days.',
        duration: 10000,
      });
      setSelectedIds(new Set());
      fetchData();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Bulk send failed');
    } finally {
      setBulkLinksSending(false);
    }
  };

  const sendWhatsAppToOne = async (account) => {
    if (!account.contact_phone && !account.phone && !account.mobile) {
      toast.error(`No phone number for ${account.business_name || account.name}`);
      return;
    }
    setSendingTo(account.id);
    try {
      await api.sendWhatsAppToCustomer(account.id);
      toast.success(`WhatsApp sent to ${account.contact_name || account.name}`);
      fetchData(); // Refresh to update badges
    } catch (err) {
      const detail = err.response?.data?.detail || 'Failed to send';
      toast.error(detail);
    } finally {
      setSendingTo(null);
    }
  };

  const bulkSendWelcome = async () => {
    if (selectedIds.size === 0) return;
    setBulkSending(true);
    try {
      const res = await api.bulkSendWhatsApp([...selectedIds]);
      const { sent, failed, skipped } = res.data;
      toast.success(`Sent: ${sent}, Failed: ${failed}, Skipped: ${skipped}`);
      setSelectedIds(new Set());
      fetchData(); // Refresh to update badges
    } catch (err) {
      toast.error('Bulk send failed');
    } finally {
      setBulkSending(false);
    }
  };

  const sendCustomMsg = async () => {
    if (!customMessage.trim()) { toast.error('Enter a message'); return; }
    const targets = selectedIds.size > 0 ? [...selectedIds] : [];
    if (targets.length === 0) { toast.error('Select at least one customer'); return; }
    setSendingCustom(true);
    try {
      const res = await api.sendCustomWhatsApp(targets, customMessage.trim());
      const { sent, failed, skipped } = res.data;
      toast.success(`Custom message — Sent: ${sent}, Failed: ${failed}, Skipped: ${skipped}`);
      setShowCustomMsg(false);
      setCustomMessage('');
      setSelectedIds(new Set());
      fetchData(); // Refresh to update badges
    } catch (err) {
      const detail = err.response?.data?.detail || 'Failed to send custom message';
      toast.error(detail);
    } finally {
      setSendingCustom(false);
    }
  };
  
  // Summary stats
  const totalAccounts = accounts.length;
  const totalSpend = accounts.reduce((sum, a) => sum + (a.total_spend || 0), 0);
  const neverLoggedIn = accounts.filter((a) => ['never', 'link_sent'].includes(a.login_status || 'never')).length;
  const activeFilterCount = [filterTradeType, filterLogin, filterChannel, filterActivity].filter(Boolean).length;
  
  return (
    <div className="space-y-6" data-testid="trade-accounts-page">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          {!embedded && (
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Building2 className="h-7 w-7" />
              Trade Accounts
            </h1>
          )}
          <p className="text-gray-500 text-sm mt-1">
            Every trade account, online and in store — trade prices are set per product in the Pricing Hub, credit back is earned on every purchase
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button variant="outline" onClick={bulkSendLoginLinks} disabled={bulkLinksSending} className="text-amber-700 border-amber-300 hover:bg-amber-50" data-testid="bulk-login-links-btn">
            {bulkLinksSending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <KeyRound className="h-4 w-4 mr-2" />}
            Send login links {selectedIds.size > 0 ? `(${selectedIds.size})` : '(all shown)'}
          </Button>
          <Button variant="outline" onClick={() => { if (selectedIds.size > 0) setShowCustomMsg(true); else toast.error('Select customers first'); }} data-testid="custom-msg-btn">
            <MessageCircle className="h-4 w-4 mr-2" />
            Custom Message
          </Button>
          <Button onClick={handleCreate} data-testid="new-trade-account-btn">
            <Plus className="h-4 w-4 mr-2" />
            New Trade Account
          </Button>
        </div>
      </div>

      {/* Super-admin only: EPOS feature flags. Hidden for everyone else.
          When all flags are false the panel still renders so super-admin
          knows where to find them — but each row stays subtle. */}
      {isSuperAdmin && (
        <Card data-testid="epos-feature-flags-panel">
          <CardContent className="pt-5 pb-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
                  EPOS Settings <span className="text-[10px] font-medium uppercase px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200">Super Admin</span>
                </div>
                <p className="text-xs text-gray-500 mt-0.5">
                  Experimental EPOS features. Off by default — flip on only when the till team is briefed and ready.
                </p>
              </div>
              {eposFlagsLoading && <Loader2 className="w-4 h-4 animate-spin text-gray-400" />}
            </div>
            <div className="mt-4 divide-y divide-gray-100 border-t border-gray-100">
              {/* Trade pricing apply button */}
              <div className="py-3 flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-medium text-gray-900">Apply trade pricing button on Invoice</div>
                  <p className="text-xs text-gray-500 mt-0.5 max-w-xl">
                    Adds an opt-in button next to the linked-online-account chip on the EPOS Invoice. When clicked, sets each line's Due Price to the customer's tier discount (e.g. Silver -10%), respecting per-product max-discount caps. Staff can manually override afterwards.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={!!eposFeatureFlags.trade_pricing_apply_button}
                  disabled={eposFlagsSaving}
                  onClick={() => toggleEposFlag('trade_pricing_apply_button', !eposFeatureFlags.trade_pricing_apply_button)}
                  className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                    eposFeatureFlags.trade_pricing_apply_button ? 'bg-emerald-500' : 'bg-gray-300'
                  } ${eposFlagsSaving ? 'opacity-50 cursor-wait' : ''}`}
                  data-testid="toggle-trade-pricing-apply-button"
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow ${
                      eposFeatureFlags.trade_pricing_apply_button ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
      
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-100 rounded-lg">
                <Users className="h-5 w-5 text-blue-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{totalAccounts}</p>
                <p className="text-xs text-gray-500">Total Accounts</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-green-100 rounded-lg">
                <PoundSterling className="h-5 w-5 text-green-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">£{totalSpend.toLocaleString()}</p>
                <p className="text-xs text-gray-500">Total Spend</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-rose-100 rounded-lg">
                <KeyRound className="h-5 w-5 text-rose-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{neverLoggedIn}</p>
                <p className="text-xs text-gray-500">No usable login yet</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-purple-100 rounded-lg">
                <ShoppingBag className="h-5 w-5 text-purple-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{accounts.reduce((sum, a) => sum + (a.order_count || 0), 0)}</p>
                <p className="text-xs text-gray-500">Total Orders</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
      
      {/* Search and Filters */}
      <Card>
        <CardContent className="pt-4">
          <div className="flex flex-col md:flex-row gap-4">
            <div className="flex items-center gap-3 flex-1">
              <input
                type="checkbox"
                checked={accounts.length > 0 && selectedIds.size === accounts.length}
                onChange={toggleSelectAll}
                className="w-4 h-4 rounded border-gray-300 accent-green-600"
                data-testid="select-all-checkbox"
                title="Select all"
              />
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <Input
                  placeholder="Search by name, email, phone, postcode, account # (e.g. T-00042)..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-10"
                  data-testid="search-input"
                />
              </div>
            </div>
            <Button 
              variant="outline" 
              onClick={() => setShowFilters(!showFilters)}
              className={showFilters ? 'bg-gray-100' : ''}
            >
              <Filter className="h-4 w-4 mr-2" />
              Filters
              {activeFilterCount > 0 && (
                <span className="ml-2 bg-primary text-white rounded-full px-2 py-0.5 text-xs">
                  {activeFilterCount}
                </span>
              )}
            </Button>
          </div>
          
          <div className="mt-3 flex flex-wrap gap-1.5" data-testid="login-status-chips">
            {[['', 'All'], ['never', 'No login yet'], ['link_sent', 'Link sent · not activated'], ['ready', 'Has password · no sign-in tracked'], ['active', 'Signed in online']].map(([v, label]) => (
              <button key={v || 'all'} type="button" onClick={() => setFilterLogin(v)}
                className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${filterLogin === v ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                data-testid={`login-chip-${v || 'all'}`}>{label}</button>
            ))}
          </div>

          {showFilters && (
            <div className="mt-4 pt-4 border-t flex flex-wrap gap-4 items-end">
              <div>
                <label className="block text-sm font-medium mb-1">Trade Type</label>
                <select
                  value={filterTradeType}
                  onChange={(e) => setFilterTradeType(e.target.value)}
                  className="px-3 py-2 border rounded-md min-w-[150px]"
                >
                  <option value="">All Types</option>
                  {tradeTypes.map(type => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Registered</label>
                <select value={filterChannel} onChange={(e) => setFilterChannel(e.target.value)} className="px-3 py-2 border rounded-md min-w-[170px]" data-testid="filter-channel">
                  <option value="">Anywhere</option>
                  <option value="online">Online (own device)</option>
                  <option value="in_store">In store (showroom)</option>
                  <option value="staff_created">Staff created</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Activity</label>
                <select value={filterActivity} onChange={(e) => setFilterActivity(e.target.value)} className="px-3 py-2 border rounded-md min-w-[170px]" data-testid="filter-activity">
                  <option value="">Everyone</option>
                  <option value="new">New (last 30 days)</option>
                  <option value="dormant">Dormant (60+ days)</option>
                  <option value="never_purchased">Never purchased</option>
                </select>
              </div>
              {activeFilterCount > 0 && (
                <Button variant="ghost" onClick={clearFilters} size="sm">
                  <X className="h-4 w-4 mr-1" />
                  Clear
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      
      {/* Accounts List */}
      <div className="space-y-3">
        {loading ? (
          <div className="text-center py-12 text-gray-500">Loading trade accounts...</div>
        ) : accounts.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Building2 className="h-12 w-12 mx-auto text-gray-300 mb-4" />
              <h3 className="text-lg font-medium text-gray-600">No trade accounts found</h3>
              <p className="text-gray-400 mt-1">
                {search || filterTradeType || filterTier 
                  ? 'Try adjusting your search or filters' 
                  : 'Create your first trade account to get started'}
              </p>
              {!search && !filterTradeType && !filterTier && (
                <Button className="mt-4" onClick={handleCreate}>
                  <Plus className="h-4 w-4 mr-2" />
                  Create Trade Account
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          accounts.map(account => (
            <Card key={account.id} className={`hover:shadow-md transition-shadow ${selectedIds.has(account.id) ? 'ring-2 ring-green-400' : ''}`}>
              <CardContent className="pt-4">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div className="flex items-start gap-3 flex-1">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(account.id)}
                      onChange={() => toggleSelect(account.id)}
                      className="w-4 h-4 rounded border-gray-300 accent-green-600 mt-1.5"
                      data-testid={`select-${account.id}`}
                    />
                    <div className="flex-1">
                      <div className="flex items-center gap-3 flex-wrap">
                        <h3 className="font-semibold text-lg">{account.business_name}</h3>
                        {(account.trade_account_number || account.account_number) && (
                          <span
                            className="text-xs font-mono font-semibold text-gray-700 bg-gray-100 border border-gray-200 px-2 py-0.5 rounded select-all"
                            title="Customer-facing trade reference — shown on their dashboard and statements"
                            data-testid={`account-number-${account.id}`}
                          >
                            #{account.trade_account_number || account.account_number}
                          </span>
                        )}
                        <ChannelBadge account={account} />
                        <LoginStatusBadge account={account} />
                        {Number(account.credit_balance) > 0 && (
                          <span className="text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full" data-testid={`credit-badge-${account.id}`}>
                            £{Number(account.credit_balance).toFixed(2)} credit{account.credit_expires_at ? ` · exp ${new Date(account.credit_expires_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}
                          </span>
                        )}
                      </div>
                      {account.trading_name && (
                        <p className="text-sm text-gray-500">Trading as: {account.trading_name}</p>
                      )}
                      <div className="flex flex-wrap items-center gap-4 mt-2 text-sm text-gray-600">
                        <span className="flex items-center gap-1">
                          <Users className="h-4 w-4" />
                          {account.contact_name}
                        </span>
                        <span className="flex items-center gap-1">
                          <Phone className="h-4 w-4" />
                          {account.contact_phone}
                        </span>
                        <span className="flex items-center gap-1">
                          <Mail className="h-4 w-4" />
                          {account.contact_email}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 mt-1 text-sm text-gray-500">
                        <MapPin className="h-4 w-4" />
                        {account.city}, {account.postcode}
                      </div>
                      {account.last_whatsapp_sent ? (
                        <div className="flex items-center gap-1.5 mt-1.5">
                          <span className="inline-flex items-center gap-1 text-xs bg-green-50 text-green-700 border border-green-200 px-2 py-0.5 rounded-full" data-testid={`wa-badge-${account.id}`}>
                            <CheckCircle className="h-3 w-3" />
                            WhatsApp sent {new Date(account.last_whatsapp_sent).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                            {account.whatsapp_count > 1 && ` (${account.whatsapp_count}x)`}
                          </span>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1.5 mt-1.5">
                          <span className="inline-flex items-center gap-1 text-xs bg-gray-50 text-gray-400 border border-gray-200 px-2 py-0.5 rounded-full" data-testid={`wa-badge-${account.id}`}>
                            <Clock className="h-3 w-3" />
                            No WhatsApp sent
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-6">
                    <div className="text-right">
                      <p className="text-sm text-gray-500">Total Spend</p>
                      <p className="text-lg font-semibold">£{(account.total_spend || 0).toLocaleString()}</p>
                      <p className="text-xs text-gray-400">{account.order_count || 0} orders</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="default"
                        size="sm"
                        onClick={() => setDrawerId(account.id)}
                        title="Open 360° view — timeline, credit ledger, notes"
                        data-testid={`open-360-${account.id}`}
                      >
                        <History className="h-4 w-4 mr-1" /> 360°
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => sendLoginLink(account)}
                        disabled={sendingLinkTo === account.id}
                        className={account.login_status === 'never' || account.login_status === 'link_sent' ? 'text-amber-700 border-amber-300 bg-amber-50 hover:bg-amber-100' : 'text-gray-600'}
                        title={account.last_login_at
                          ? `Send login / reset link (last login ${new Date(account.last_login_at).toLocaleDateString('en-GB')})`
                          : account.login_status === 'ready'
                            ? 'Registered with their own password — only send a link if they have forgotten it'
                            : account.login_link_sent_at
                              ? `Resend login link (sent ${new Date(account.login_link_sent_at).toLocaleDateString('en-GB')}) — customer has not activated yet`
                              : 'No usable password on this account — send them a set-password link'}
                        data-testid={`send-login-link-${account.id}`}
                      >
                        {sendingLinkTo === account.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <KeyRound className="h-4 w-4" />
                        )}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => sendWhatsAppToOne(account)}
                        disabled={sendingTo === account.id}
                        className="text-green-600 border-green-200 hover:bg-green-50"
                        title="Send WhatsApp"
                        data-testid={`wa-send-${account.id}`}
                      >
                        {sendingTo === account.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <MessageCircle className="h-4 w-4" />
                        )}
                      </Button>
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => setExpandedAccount(expandedAccount === account.id ? null : account.id)}
                      >
                        {expandedAccount === account.id ? (
                          <ChevronUp className="h-4 w-4" />
                        ) : (
                          <ChevronDown className="h-4 w-4" />
                        )}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => handleEdit(account)}>
                        <Edit className="h-4 w-4" />
                      </Button>
                      <CreditStatementPreviewButton
                        email={account.contact_email}
                        businessName={account.business_name}
                        testIdSuffix={account.id}
                      />
                      <Button variant="outline" size="sm" onClick={() => handleDelete(account)}>
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    </div>
                  </div>
                </div>
                
                {/* Expanded Details */}
                {expandedAccount === account.id && (
                  <div className="mt-4 pt-4 border-t grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                      <h4 className="font-medium text-sm text-gray-500 mb-2">Business Details</h4>
                      <p className="text-sm"><strong>Trade Type:</strong> {account.trade_type}</p>
                      {account.vat_number && (
                        <p className="text-sm"><strong>VAT:</strong> {account.vat_number}</p>
                      )}
                      {account.company_reg_number && (
                        <p className="text-sm"><strong>Company Reg:</strong> {account.company_reg_number}</p>
                      )}
                    </div>
                    <div>
                      <h4 className="font-medium text-sm text-gray-500 mb-2">Full Address</h4>
                      <p className="text-sm">{account.address_line1}</p>
                      {account.address_line2 && <p className="text-sm">{account.address_line2}</p>}
                      <p className="text-sm">{account.city}{account.county ? `, ${account.county}` : ''}</p>
                      <p className="text-sm">{account.postcode}</p>
                    </div>
                    <div>
                      <h4 className="font-medium text-sm text-gray-500 mb-2">Account & credit</h4>
                      <div className="space-y-1 text-xs text-gray-600">
                        <p>Manual discount: <span className="font-semibold">{account.trade_discount || 0}%</span> (EPOS)</p>
                        <p>Credit balance: <span className="font-semibold">£{Number(account.credit_balance || 0).toFixed(2)}</span>{account.credit_expires_at ? ` · expires ${new Date(account.credit_expires_at).toLocaleDateString('en-GB')}` : ''}</p>
                        <p>Registered: {account.registration_source?.channel === 'in_store' ? `In store${account.registration_source?.showroom_name ? ` · ${account.registration_source.showroom_name}` : ''}${account.registration_source?.staff_name ? ` · by ${account.registration_source.staff_name}` : ''}` : account.registration_source?.channel === 'staff_created' ? `Staff created${account.registration_source?.staff_name ? ` by ${account.registration_source.staff_name}` : ''}` : account.registration_source?.channel === 'online' ? `Online · ${account.registration_source?.device || 'device unknown'}` : 'Unknown (before tracking)'}</p>
                        <p>Last login: {account.last_login_at ? new Date(account.last_login_at).toLocaleDateString('en-GB') : 'never'}{account.trade_rep ? ` · Rep: ${account.trade_rep}` : ''}</p>
                      </div>
                    </div>
                    {account.notes && (
                      <div className="md:col-span-3">
                        <h4 className="font-medium text-sm text-gray-500 mb-2">Notes</h4>
                        <p className="text-sm text-gray-600">{account.notes}</p>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))
        )}
      </div>
      
      {/* Bulk WhatsApp Action Bar */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t shadow-lg z-50 px-6 py-3" data-testid="bulk-action-bar">
          <div className="max-w-5xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-gray-700">
                {selectedIds.size} customer{selectedIds.size > 1 ? 's' : ''} selected
              </span>
              <Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set())}>
                <X className="h-3 w-3 mr-1" /> Clear
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowCustomMsg(true)}
                className="border-green-200 text-green-700 hover:bg-green-50"
                data-testid="bulk-custom-msg-btn"
              >
                <MessageCircle className="h-4 w-4 mr-1" />
                Custom Message
              </Button>
              <Button
                size="sm"
                onClick={bulkSendWelcome}
                disabled={bulkSending}
                className="bg-green-600 hover:bg-green-700"
                data-testid="bulk-send-welcome-btn"
              >
                {bulkSending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Send className="h-4 w-4 mr-1" />}
                Send Welcome ({selectedIds.size})
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Custom Message Modal */}
      {showCustomMsg && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" data-testid="custom-msg-modal">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg">
            <div className="flex items-center justify-between p-4 border-b">
              <div className="flex items-center gap-2">
                <MessageCircle className="h-5 w-5 text-green-600" />
                <h3 className="font-semibold text-gray-900">Send Custom WhatsApp Message</h3>
              </div>
              <button onClick={() => setShowCustomMsg(false)} className="p-1 rounded hover:bg-gray-100">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-4 space-y-4">
              <div className="bg-green-50 rounded-lg p-3">
                <p className="text-sm text-green-800">
                  Sending to <strong>{selectedIds.size}</strong> customer{selectedIds.size > 1 ? 's' : ''}
                </p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {accounts.filter(a => selectedIds.has(a.id)).slice(0, 5).map(a => (
                    <span key={a.id} className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">
                      {a.contact_name || a.business_name}
                    </span>
                  ))}
                  {selectedIds.size > 5 && (
                    <span className="text-xs text-green-600">+{selectedIds.size - 5} more</span>
                  )}
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Message</label>
                <textarea
                  value={customMessage}
                  onChange={e => setCustomMessage(e.target.value)}
                  placeholder="Type your message here..."
                  className="w-full border rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-green-400"
                  rows={5}
                  data-testid="custom-msg-input"
                />
                <p className="text-xs text-gray-400 mt-1">
                  This will be sent using the <code className="bg-gray-100 px-1 rounded">custom_message</code> template on Meta.
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 p-4 border-t">
              <Button variant="outline" onClick={() => setShowCustomMsg(false)}>Cancel</Button>
              <Button
                onClick={sendCustomMsg}
                disabled={sendingCustom || !customMessage.trim()}
                className="bg-green-600 hover:bg-green-700"
                data-testid="send-custom-msg-btn"
              >
                {sendingCustom ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Send className="h-4 w-4 mr-1" />}
                Send Message
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Modal */}
      <TradeAccountModal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        account={editingAccount}
        tradeTypes={tradeTypes}
        onSave={fetchData}
      />
      <TraderDrawer traderId={drawerId} open={!!drawerId} onOpenChange={(o) => !o && setDrawerId(null)} onChanged={fetchData} />
    </div>
  );
};

export default TradeAccounts;

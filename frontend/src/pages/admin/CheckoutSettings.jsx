import React, { useState, useEffect } from 'react';
import {
  Save, Eye, Truck, CreditCard, Package, MapPin, 
  Settings, Loader2, Plus, Trash2, Edit2, ChevronUp, ChevronDown, Info
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { toast } from 'sonner';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const DEFAULT_SETTINGS = {
  // Delivery options
  delivery: {
    enabled: true,
    free_threshold: 500,
    default_fee: 49.99,
    label: 'Home Delivery',
    description: 'Delivered within 3-5 working days',
    congestion_charge: { enabled: true, amount: 15.00, label: 'Congestion Charge (Central London)' },
    express: { enabled: true, extra_fee: 25.00, label: 'Express Delivery', description: '2-3 working days', standard_label: 'Standard Delivery', standard_description: '5-7 working days' },
    zones: [
      { id: '1', name: 'Local (TN, ME, BR, DA)', postcodes: 'TN,ME,BR,DA', fee: 29.99, is_congestion_zone: false },
      { id: 'cz', name: 'Central London (Congestion Zone)', postcodes: 'EC1,EC2,EC3,EC4,WC1,WC2,W1,SW1,SE1', fee: 49.99, is_congestion_zone: true },
      { id: '2', name: 'Greater London', postcodes: 'E,N,NW,SE,SW,W,WC', fee: 49.99, is_congestion_zone: false },
      { id: '3', name: 'South East', postcodes: 'CT,SS,RM,CM,BN,RH,GU,KT,CR,SM,SL', fee: 59.99, is_congestion_zone: false },
      { id: '4', name: 'Rest of UK', postcodes: '', fee: 79.99, is_congestion_zone: false },
    ],
  },
  // Click & collect
  collection: {
    enabled: true,
    label: 'Click & Collect',
    description: 'FREE - Collect from our store',
    ready_time: 'We will notify you via email or call, once your order is ready from your selected store',
    stores: [
      { id: '1', name: 'Tile Station - Tonbridge', address: 'Unit 5, Cannon Lane, Tonbridge TN9 1PP', active: true },
    ],
  },
  // Delivery time slots
  time_slots: [
    { id: 'morning', label: 'Morning (8am - 12pm)', description: 'Best for early risers', enabled: true },
    { id: 'afternoon', label: 'Afternoon (12pm - 5pm)', description: 'Most popular slot', enabled: true },
    { id: 'evening', label: 'Evening (5pm - 8pm)', description: 'For after work', enabled: true },
  ],
  // Checkout text
  text: {
    step1_title: 'Your Details',
    step2_title: 'Delivery Method',
    step3_title: 'Payment',
    secure_message: 'Your payment information is encrypted and secure.',
    order_notes_placeholder: 'Special instructions for delivery...',
    success_message: 'Thank you! Your order has been placed.',
  },
  // Minimum order
  min_order: 0,
  // Free sample upsell — shown as a nudge banner on the cart. When the cart
  // subtotal >= threshold, the shopper is told to note their chosen sample at
  // checkout; fulfillment team adds it before dispatch.
  free_sample: {
    enabled: false,
    threshold: 100,
    label: 'Add a FREE sample',
    // Fulfillment mode — controls copy + whether the offer shows for supplier-direct carts:
    //   pack_with_order  = pack sample in the main box (warehouse-only orders)
    //   separate_parcel  = post the sample separately via Royal Mail (universal — works for direct-drop)
    //   smart            = pack if cart is warehouse-only, post separately if ANY item is supplier-direct
    //   hide_on_direct   = hide the offer entirely if ANY item is supplier-direct
    fulfillment_mode: 'separate_parcel',
    // Supplier names that bypass your warehouse (drop-ship direct to the customer).
    // Used by `smart` and `hide_on_direct` modes to decide what to do per cart.
    direct_ship_suppliers: [],
    locked_text: 'Spend <strong>£{remaining}</strong> more to unlock a <strong>FREE sample</strong> with your order',
    unlocked_text_pack: "🎁 You've unlocked a FREE sample — add your sample choice in the order notes at checkout.",
    unlocked_text_separate: "🎁 You've unlocked a FREE sample — we'll post it to you separately by Royal Mail. Add your sample choice in the order notes at checkout.",
  },
  // Payments (BNPL toggles — Stripe-native)
  payments: {
    klarna_enabled: false,      // Show Klarna as a payment option at checkout (Stripe-native)
    klarna_osm_enabled: false,  // Show "From £X/mo with Klarna" on product cards/PDPs
    klarna_client_id: '',       // Free Klarna OSM Client ID (no merchant account required)
    paypal_enabled: false,      // Show PayPal as a payment option at checkout (Stripe-native)
    wallet_express_enabled: false, // Show Apple Pay / Google Pay Express button on basket page
  },
};

const CheckoutSettings = () => {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [activeTab, setActiveTab] = useState('delivery');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/checkout-settings`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.settings && Object.keys(data.settings).length) {
          setSettings(prev => ({
            ...prev,
            ...data.settings,
            delivery: { ...prev.delivery, ...(data.settings.delivery || {}) },
            collection: { ...prev.collection, ...(data.settings.collection || {}) },
            time_slots: data.settings.time_slots || prev.time_slots,
            text: { ...prev.text, ...(data.settings.text || {}) },
            payments: { ...prev.payments, ...(data.settings.payments || {}) },
          }));
        }
      }
    } catch (e) {
      console.error('Failed to load checkout settings:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/checkout-settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ settings })
      });
      if (res.ok) toast.success('Checkout settings saved!');
      else toast.error('Failed to save settings');
    } catch (e) {
      toast.error('Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const tabs = [
    { id: 'delivery', label: 'Delivery & Zones', icon: Truck },
    { id: 'collection', label: 'Click & Collect', icon: MapPin },
    { id: 'slots', label: 'Time Slots', icon: Package },
    { id: 'payments', label: 'Payments', icon: CreditCard },
    { id: 'text', label: 'Checkout Text', icon: Settings },
    { id: 'preview', label: 'Preview', icon: Eye },
  ];

  const updateZone = (id, field, value) => {
    setSettings(prev => ({
      ...prev,
      delivery: {
        ...prev.delivery,
        zones: prev.delivery.zones.map(z => z.id === id ? { ...z, [field]: value } : z)
      }
    }));
  };

  const addZone = () => {
    const newZone = { id: Date.now().toString(), name: 'New Zone', postcodes: '', fee: 0, is_congestion_zone: false };
    setSettings(prev => ({
      ...prev,
      delivery: { ...prev.delivery, zones: [...prev.delivery.zones, newZone] }
    }));
  };

  const removeZone = (id) => {
    setSettings(prev => ({
      ...prev,
      delivery: { ...prev.delivery, zones: prev.delivery.zones.filter(z => z.id !== id) }
    }));
  };

  if (loading) return (
    <div className="flex items-center justify-center py-16">
      <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Checkout Settings</h1>
          <p className="text-sm text-gray-500 mt-1">Manage delivery zones, fees, time slots and checkout text</p>
        </div>
        <Button onClick={handleSave} disabled={saving} data-testid="save-checkout-settings">
          {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
          Save Settings
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-lg overflow-x-auto">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium whitespace-nowrap transition-colors ${activeTab === tab.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Delivery & Zones Tab */}
      {activeTab === 'delivery' && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl shadow-sm p-6">
            <h2 className="text-lg font-bold text-gray-900 mb-4">Delivery Options</h2>
            <div className="grid grid-cols-2 gap-6 mb-6">
              <div>
                <Label>Free Delivery Threshold (£)</Label>
                <p className="text-xs text-gray-500 mb-1">Orders above this amount get free delivery</p>
                <Input
                  type="number"
                  value={settings.delivery.free_threshold}
                  onChange={(e) => setSettings(prev => ({
                    ...prev,
                    delivery: { ...prev.delivery, free_threshold: parseFloat(e.target.value) || 0 }
                  }))}
                />
              </div>
              <div>
                <Label>Default Delivery Fee (£)</Label>
                <p className="text-xs text-gray-500 mb-1">Used when no zone matches</p>
                <Input
                  type="number"
                  value={settings.delivery.default_fee}
                  onChange={(e) => setSettings(prev => ({
                    ...prev,
                    delivery: { ...prev.delivery, default_fee: parseFloat(e.target.value) || 0 }
                  }))}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-6">
              <div>
                <Label>Delivery Label</Label>
                <Input
                  value={settings.delivery.label}
                  onChange={(e) => setSettings(prev => ({
                    ...prev,
                    delivery: { ...prev.delivery, label: e.target.value }
                  }))}
                />
              </div>
              <div>
                <Label>Description</Label>
                <Input
                  value={settings.delivery.description}
                  onChange={(e) => setSettings(prev => ({
                    ...prev,
                    delivery: { ...prev.delivery, description: e.target.value }
                  }))}
                />
              </div>
            </div>
          </div>

          {/* Congestion Charge Settings */}
          <div className="bg-white rounded-xl shadow-sm p-6 border-l-4 border-red-400">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-bold text-gray-900">Congestion Charge</h2>
                <p className="text-sm text-gray-500">Additional charge for deliveries to congestion zones (e.g. Central London). Applies even on free delivery orders.</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm text-gray-500">{settings.delivery.congestion_charge?.enabled ? 'Enabled' : 'Disabled'}</span>
                <button
                  onClick={() => setSettings(prev => ({
                    ...prev,
                    delivery: { ...prev.delivery, congestion_charge: { ...prev.delivery.congestion_charge, enabled: !prev.delivery.congestion_charge?.enabled } }
                  }))}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${settings.delivery.congestion_charge?.enabled ? 'bg-red-500' : 'bg-gray-300'}`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${settings.delivery.congestion_charge?.enabled ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </div>
            </div>
            {settings.delivery.congestion_charge?.enabled && (
              <div className="grid grid-cols-2 gap-6">
                <div>
                  <Label>Congestion Charge Amount (£)</Label>
                  <p className="text-xs text-gray-500 mb-1">Current London congestion charge is £15</p>
                  <Input
                    type="number"
                    step="0.01"
                    value={settings.delivery.congestion_charge?.amount ?? 15}
                    onChange={(e) => setSettings(prev => ({
                      ...prev,
                      delivery: { ...prev.delivery, congestion_charge: { ...prev.delivery.congestion_charge, amount: parseFloat(e.target.value) || 0 } }
                    }))}
                  />
                </div>
                <div>
                  <Label>Charge Label</Label>
                  <p className="text-xs text-gray-500 mb-1">Displayed on checkout</p>
                  <Input
                    value={settings.delivery.congestion_charge?.label ?? 'Congestion Charge (Central London)'}
                    onChange={(e) => setSettings(prev => ({
                      ...prev,
                      delivery: { ...prev.delivery, congestion_charge: { ...prev.delivery.congestion_charge, label: e.target.value } }
                    }))}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Express Delivery Settings */}
          <div className="bg-white rounded-xl shadow-sm p-6 border-l-4 border-amber-400">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-bold text-gray-900">Express Delivery</h2>
                <p className="text-sm text-gray-500">Offer faster delivery for an extra charge on top of the standard delivery fee.</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm text-gray-500">{settings.delivery.express?.enabled ? 'Enabled' : 'Disabled'}</span>
                <button
                  onClick={() => setSettings(prev => ({
                    ...prev,
                    delivery: { ...prev.delivery, express: { ...prev.delivery.express, enabled: !prev.delivery.express?.enabled } }
                  }))}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${settings.delivery.express?.enabled ? 'bg-amber-500' : 'bg-gray-300'}`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${settings.delivery.express?.enabled ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </div>
            </div>
            {settings.delivery.express?.enabled && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-6">
                  <div>
                    <Label>Express Extra Fee (£)</Label>
                    <p className="text-xs text-gray-500 mb-1">Added on top of zone delivery fee</p>
                    <Input
                      type="number"
                      step="0.01"
                      value={settings.delivery.express?.extra_fee ?? 25}
                      onChange={(e) => setSettings(prev => ({
                        ...prev,
                        delivery: { ...prev.delivery, express: { ...prev.delivery.express, extra_fee: parseFloat(e.target.value) || 0 } }
                      }))}
                    />
                  </div>
                  <div>
                    <Label>Express Label</Label>
                    <p className="text-xs text-gray-500 mb-1">Shown to customer</p>
                    <Input
                      value={settings.delivery.express?.label ?? 'Express Delivery'}
                      onChange={(e) => setSettings(prev => ({
                        ...prev,
                        delivery: { ...prev.delivery, express: { ...prev.delivery.express, label: e.target.value } }
                      }))}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-6">
                  <div>
                    <Label>Express Description</Label>
                    <Input
                      value={settings.delivery.express?.description ?? '2-3 working days'}
                      onChange={(e) => setSettings(prev => ({
                        ...prev,
                        delivery: { ...prev.delivery, express: { ...prev.delivery.express, description: e.target.value } }
                      }))}
                    />
                  </div>
                  <div>
                    <Label>Standard Delivery Label</Label>
                    <p className="text-xs text-gray-500 mb-1">Label for the non-express option</p>
                    <Input
                      value={settings.delivery.express?.standard_label ?? 'Standard Delivery'}
                      onChange={(e) => setSettings(prev => ({
                        ...prev,
                        delivery: { ...prev.delivery, express: { ...prev.delivery.express, standard_label: e.target.value } }
                      }))}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-6">
                  <div>
                    <Label>Standard Description</Label>
                    <Input
                      value={settings.delivery.express?.standard_description ?? '5-7 working days'}
                      onChange={(e) => setSettings(prev => ({
                        ...prev,
                        delivery: { ...prev.delivery, express: { ...prev.delivery.express, standard_description: e.target.value } }
                      }))}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Free Sample Upsell — shown as a nudge on the cart for low-value baskets */}
          <div className="bg-white rounded-xl shadow-sm p-6" data-testid="free-sample-config">
            <div className="flex items-center justify-between mb-1">
              <div>
                <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                  <Package className="w-5 h-5 text-emerald-600" />
                  Free Sample Upsell
                </h2>
                <p className="text-sm text-gray-500 mt-1">A friendly nudge on the cart: "Spend £X more for a FREE sample." High-ROI AOV booster — typically adds £5–15 per cart.</p>
              </div>
              <button
                onClick={() => setSettings(prev => ({
                  ...prev,
                  free_sample: { ...prev.free_sample, enabled: !prev.free_sample?.enabled }
                }))}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${settings.free_sample?.enabled ? 'bg-emerald-500' : 'bg-gray-300'}`}
                data-testid="free-sample-toggle"
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${settings.free_sample?.enabled ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            </div>

            {settings.free_sample?.enabled && (
              <div className="space-y-4 mt-4 pt-4 border-t border-gray-100">
                <div className="grid grid-cols-2 gap-6">
                  <div>
                    <Label>Unlock Threshold (£)</Label>
                    <Input
                      type="number"
                      step="1"
                      min="0"
                      value={settings.free_sample?.threshold ?? 100}
                      onChange={(e) => setSettings(prev => ({
                        ...prev,
                        free_sample: { ...prev.free_sample, threshold: parseFloat(e.target.value) || 0 }
                      }))}
                      data-testid="free-sample-threshold"
                    />
                    <p className="text-[11px] text-gray-500 mt-1">Shoppers see the nudge below this amount; it turns into an unlock at/above.</p>
                  </div>
                  <div>
                    <Label>Short Label (for mobile / badge)</Label>
                    <Input
                      value={settings.free_sample?.label ?? 'Add a FREE sample'}
                      onChange={(e) => setSettings(prev => ({
                        ...prev,
                        free_sample: { ...prev.free_sample, label: e.target.value }
                      }))}
                    />
                  </div>
                </div>
                <div>
                  <Label>Progress Text (use <code className="text-xs bg-gray-100 px-1 rounded">{'{remaining}'}</code> for the £ amount left)</Label>
                  <Input
                    value={settings.free_sample?.locked_text ?? ''}
                    onChange={(e) => setSettings(prev => ({
                      ...prev,
                      free_sample: { ...prev.free_sample, locked_text: e.target.value }
                    }))}
                    placeholder="Spend £{remaining} more to unlock a FREE sample"
                  />
                  <p className="text-[11px] text-gray-500 mt-1">You can use <code className="text-xs bg-gray-100 px-1 rounded">&lt;strong&gt;</code> tags for bold.</p>
                </div>

                {/* Fulfillment mode — controls what happens for supplier-direct carts */}
                <div className="bg-[#FFFDF5] border border-amber-200 rounded-lg p-4">
                  <Label className="text-sm font-semibold text-gray-900 mb-2 block">How should the sample be fulfilled?</Label>
                  <p className="text-[11px] text-gray-500 mb-3">Some items ship <strong>direct from the supplier</strong> (you never touch the box), so you can't pack a sample in those orders. Pick the policy below.</p>
                  <div className="space-y-2" data-testid="free-sample-mode-group">
                    {[
                      { id: 'pack_with_order', title: 'Pack sample with the main order', desc: 'Best if ALL your orders ship from your warehouse. Zero extra cost.' },
                      { id: 'separate_parcel', title: 'Post sample separately (Royal Mail)', desc: 'Universal — works for warehouse + supplier-direct orders. ~£1.50 postage per sample.' },
                      { id: 'smart', title: 'Smart: auto-decide per order', desc: 'Pack with order when possible, post separately if the cart contains a supplier-direct item.' },
                      { id: 'hide_on_direct', title: 'Hide offer on supplier-direct carts', desc: 'Skip the upsell entirely when any cart item is supplier-direct.' },
                    ].map(opt => {
                      const isActive = (settings.free_sample?.fulfillment_mode || 'separate_parcel') === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => setSettings(prev => ({
                            ...prev,
                            free_sample: { ...prev.free_sample, fulfillment_mode: opt.id }
                          }))}
                          className={`w-full text-left border rounded-lg p-3 transition-all ${isActive ? 'border-emerald-500 bg-emerald-50/60 ring-1 ring-emerald-400' : 'border-gray-200 hover:border-gray-300 bg-white'}`}
                          data-testid={`free-sample-mode-${opt.id}`}
                        >
                          <div className="flex items-start gap-2.5">
                            <span className={`mt-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full border-2 flex-shrink-0 ${isActive ? 'border-emerald-500 bg-emerald-500' : 'border-gray-300 bg-white'}`}>
                              {isActive && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                            </span>
                            <div>
                              <div className="text-[13px] font-semibold text-gray-900">{opt.title}</div>
                              <div className="text-[11px] text-gray-600 mt-0.5">{opt.desc}</div>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Direct-ship supplier list — only relevant for smart + hide_on_direct modes */}
                {['smart', 'hide_on_direct'].includes(settings.free_sample?.fulfillment_mode || 'separate_parcel') && (
                  <div>
                    <Label>Supplier-direct suppliers</Label>
                    <p className="text-[11px] text-gray-500 mb-2">One supplier name per line — must match the supplier name on the product exactly.</p>
                    <textarea
                      value={(settings.free_sample?.direct_ship_suppliers || []).join('\n')}
                      onChange={(e) => setSettings(prev => ({
                        ...prev,
                        free_sample: {
                          ...prev.free_sample,
                          direct_ship_suppliers: e.target.value.split('\n').map(s => s.trim()).filter(Boolean),
                        }
                      }))}
                      rows={4}
                      className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#F7EA1C]"
                      placeholder="Ultra Tile&#10;Porcel-Thin&#10;Bosco"
                      data-testid="free-sample-direct-suppliers"
                    />
                  </div>
                )}

                <div className="grid grid-cols-1 gap-4">
                  <div>
                    <Label>Unlocked text — <span className="text-emerald-700">pack-with-order</span></Label>
                    <Input
                      value={settings.free_sample?.unlocked_text_pack ?? ''}
                      onChange={(e) => setSettings(prev => ({
                        ...prev,
                        free_sample: { ...prev.free_sample, unlocked_text_pack: e.target.value }
                      }))}
                      placeholder="🎁 You've unlocked a FREE sample — add your choice in the order notes."
                    />
                  </div>
                  <div>
                    <Label>Unlocked text — <span className="text-amber-700">separate parcel</span></Label>
                    <Input
                      value={settings.free_sample?.unlocked_text_separate ?? ''}
                      onChange={(e) => setSettings(prev => ({
                        ...prev,
                        free_sample: { ...prev.free_sample, unlocked_text_separate: e.target.value }
                      }))}
                      placeholder="🎁 Free sample unlocked — we'll post it separately."
                    />
                  </div>
                </div>

                <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 flex items-start gap-2">
                  <Info className="w-4 h-4 text-emerald-700 mt-0.5 flex-shrink-0" />
                  <p className="text-[12px] text-emerald-900">
                    <strong>How fulfillment works:</strong> When a shopper's cart hits the threshold, they're told to add their sample choice in the <em>Order Notes</em> field at checkout. Your team reads the note and either packs the sample with the main box (warehouse orders) or posts it separately by Royal Mail (supplier-direct orders) — based on the mode picked above.
                  </p>
                </div>
              </div>
            )}
          </div>

          <div className="bg-white rounded-xl shadow-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-bold text-gray-900">Delivery Zones</h2>
                <p className="text-sm text-gray-500">Set delivery fees by postcode area. Comma-separated postcode prefixes.</p>
              </div>
              <Button variant="outline" size="sm" onClick={addZone}>
                <Plus className="w-4 h-4 mr-1" /> Add Zone
              </Button>
            </div>
            <div className="space-y-3">
              {settings.delivery.zones.map((zone) => (
                <div key={zone.id} className={`border rounded-lg p-4 ${zone.is_congestion_zone ? 'border-red-300 bg-red-50/30' : ''}`}>
                  <div className="grid grid-cols-12 gap-3 items-end">
                    <div className="col-span-3">
                      <Label className="text-xs">Zone Name</Label>
                      <Input value={zone.name} onChange={(e) => updateZone(zone.id, 'name', e.target.value)} className="mt-1" />
                    </div>
                    <div className="col-span-4">
                      <Label className="text-xs">Postcode Prefixes (comma separated)</Label>
                      <Input value={zone.postcodes} onChange={(e) => updateZone(zone.id, 'postcodes', e.target.value)} placeholder="TN,ME,BR,DA" className="mt-1" />
                    </div>
                    <div className="col-span-2">
                      <Label className="text-xs">Delivery Fee (£)</Label>
                      <Input type="number" step="0.01" value={zone.fee} onChange={(e) => updateZone(zone.id, 'fee', parseFloat(e.target.value) || 0)} className="mt-1" />
                    </div>
                    <div className="col-span-2 flex items-center gap-2">
                      <button
                        onClick={() => updateZone(zone.id, 'is_congestion_zone', !zone.is_congestion_zone)}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0 ${zone.is_congestion_zone ? 'bg-red-500' : 'bg-gray-300'}`}
                        title="Congestion charge zone"
                      >
                        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${zone.is_congestion_zone ? 'translate-x-4' : 'translate-x-0.5'}`} />
                      </button>
                      <span className="text-xs text-gray-500 leading-tight">{zone.is_congestion_zone ? 'CC Zone' : 'No CC'}</span>
                    </div>
                    <div className="col-span-1">
                      <Button variant="ghost" size="sm" onClick={() => removeZone(zone.id)} className="text-red-500 hover:text-red-700 hover:bg-red-50">
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                  {zone.is_congestion_zone && settings.delivery.congestion_charge?.enabled && (
                    <p className="text-xs text-red-600 mt-2 font-medium">+ £{(settings.delivery.congestion_charge?.amount ?? 15).toFixed(2)} congestion charge applies to this zone (even on free delivery orders)</p>
                  )}
                </div>
              ))}
              {settings.delivery.zones.length === 0 && (
                <p className="text-center text-gray-400 py-6">No delivery zones. All orders will use the default fee.</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Click & Collect Tab */}
      {activeTab === 'collection' && (
        <div className="bg-white rounded-xl shadow-sm p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-lg font-bold text-gray-900">Click & Collect</h2>
            <div className="flex items-center gap-3">
              <span className="text-sm text-gray-500">{settings.collection.enabled ? 'Enabled' : 'Disabled'}</span>
              <button
                onClick={() => setSettings(prev => ({
                  ...prev,
                  collection: { ...prev.collection, enabled: !prev.collection.enabled }
                }))}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${settings.collection.enabled ? 'bg-green-500' : 'bg-gray-300'}`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${settings.collection.enabled ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-6 mb-6">
            <div>
              <Label>Label</Label>
              <Input value={settings.collection.label} onChange={(e) => setSettings(prev => ({ ...prev, collection: { ...prev.collection, label: e.target.value } }))} />
            </div>
            <div>
              <Label>Description</Label>
              <Input value={settings.collection.description} onChange={(e) => setSettings(prev => ({ ...prev, collection: { ...prev.collection, description: e.target.value } }))} />
            </div>
          </div>
          <div className="mb-6">
            <Label>Ready Time Text</Label>
            <Input value={settings.collection.ready_time} onChange={(e) => setSettings(prev => ({ ...prev, collection: { ...prev.collection, ready_time: e.target.value } }))} />
          </div>
          <div>
            <h3 className="font-semibold text-gray-900 mb-3">Collection Stores</h3>
            <div className="space-y-3">
              {settings.collection.stores.map((store, idx) => (
                <div key={store.id} className="border rounded-lg p-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label className="text-xs">Store Name</Label>
                      <Input value={store.name} onChange={(e) => {
                        const stores = [...settings.collection.stores];
                        stores[idx] = { ...stores[idx], name: e.target.value };
                        setSettings(prev => ({ ...prev, collection: { ...prev.collection, stores } }));
                      }} className="mt-1" />
                    </div>
                    <div>
                      <Label className="text-xs">Address</Label>
                      <Input value={store.address} onChange={(e) => {
                        const stores = [...settings.collection.stores];
                        stores[idx] = { ...stores[idx], address: e.target.value };
                        setSettings(prev => ({ ...prev, collection: { ...prev.collection, stores } }));
                      }} className="mt-1" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Time Slots Tab */}
      {activeTab === 'slots' && (
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h2 className="text-lg font-bold text-gray-900 mb-4">Delivery Time Slots</h2>
          <div className="space-y-3">
            {settings.time_slots.map((slot, idx) => (
              <div key={slot.id} className="border rounded-lg p-4 flex items-center gap-4">
                <button
                  onClick={() => {
                    const slots = [...settings.time_slots];
                    slots[idx] = { ...slots[idx], enabled: !slots[idx].enabled };
                    setSettings(prev => ({ ...prev, time_slots: slots }));
                  }}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ${slot.enabled ? 'bg-green-500' : 'bg-gray-300'}`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${slot.enabled ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
                <div className="flex-1 grid grid-cols-2 gap-4">
                  <div>
                    <Label className="text-xs">Slot Label</Label>
                    <Input value={slot.label} onChange={(e) => {
                      const slots = [...settings.time_slots];
                      slots[idx] = { ...slots[idx], label: e.target.value };
                      setSettings(prev => ({ ...prev, time_slots: slots }));
                    }} className="mt-1" />
                  </div>
                  <div>
                    <Label className="text-xs">Description</Label>
                    <Input value={slot.description} onChange={(e) => {
                      const slots = [...settings.time_slots];
                      slots[idx] = { ...slots[idx], description: e.target.value };
                      setSettings(prev => ({ ...prev, time_slots: slots }));
                    }} className="mt-1" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Payments Tab */}
      {activeTab === 'payments' && (
        <div className="space-y-6">
          <div className="bg-white rounded-lg p-6 border border-gray-200">
            <div className="flex items-start gap-3 mb-4">
              <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-pink-100 to-rose-100 flex items-center justify-center flex-shrink-0">
                <CreditCard className="w-5 h-5 text-rose-600" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Klarna — Buy Now, Pay Later</h3>
                <p className="text-sm text-gray-500 mt-0.5">
                  Stripe-native integration. Customers split purchases into 3 interest-free payments.
                  Uses your existing Stripe account — no separate Klarna merchant approval needed.
                </p>
              </div>
            </div>

            <div className="space-y-4">
              {/* Toggle 1: Klarna at checkout */}
              <label className="flex items-start gap-3 p-4 border border-gray-200 rounded-lg hover:bg-gray-50 cursor-pointer transition-colors" data-testid="klarna-checkout-toggle">
                <input
                  type="checkbox"
                  checked={!!settings.payments?.klarna_enabled}
                  onChange={(e) => setSettings(prev => ({
                    ...prev,
                    payments: { ...prev.payments, klarna_enabled: e.target.checked }
                  }))}
                  className="mt-1 w-4 h-4 text-rose-600 rounded border-gray-300 focus:ring-rose-500"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900">Show Klarna at checkout</span>
                    {settings.payments?.klarna_enabled && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-medium">ACTIVE</span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    Adds Klarna as a payment option alongside cards. Only shown on orders <strong>≥ £30</strong> (Klarna UK minimum).
                    You must first enable Klarna in your Stripe dashboard:
                    <a href="https://dashboard.stripe.com/settings/payment_methods" target="_blank" rel="noopener noreferrer" className="text-rose-600 hover:underline ml-1">
                      Settings → Payment methods → Klarna
                    </a>.
                  </p>
                </div>
              </label>

              {/* Toggle 2: Klarna On-Site Messaging */}
              <label className="flex items-start gap-3 p-4 border border-gray-200 rounded-lg hover:bg-gray-50 cursor-pointer transition-colors" data-testid="klarna-osm-toggle">
                <input
                  type="checkbox"
                  checked={!!settings.payments?.klarna_osm_enabled}
                  onChange={(e) => setSettings(prev => ({
                    ...prev,
                    payments: { ...prev.payments, klarna_osm_enabled: e.target.checked }
                  }))}
                  className="mt-1 w-4 h-4 text-rose-600 rounded border-gray-300 focus:ring-rose-500"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900">Show "From £X/mo with Klarna" on product pages</span>
                    {settings.payments?.klarna_osm_enabled && !!settings.payments?.klarna_client_id && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-medium">ACTIVE</span>
                    )}
                    {settings.payments?.klarna_osm_enabled && !settings.payments?.klarna_client_id && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">MISSING CLIENT ID</span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    Adds Klarna's native "From £X/mo" widget on product cards + product detail pages.
                    Requires a free Klarna Client ID (no merchant account needed — 10 min signup).
                  </p>
                </div>
              </label>

              {/* Klarna Client ID input (visible when OSM toggle is on) */}
              {settings.payments?.klarna_osm_enabled && (
                <div className="ml-7 p-4 bg-gray-50 rounded-lg border border-gray-200" data-testid="klarna-client-id-panel">
                  <Label htmlFor="klarna-client-id" className="text-sm font-medium">
                    Klarna OSM Client ID
                  </Label>
                  <Input
                    id="klarna-client-id"
                    data-testid="klarna-client-id-input"
                    type="text"
                    value={settings.payments?.klarna_client_id || ''}
                    onChange={(e) => setSettings(prev => ({
                      ...prev,
                      payments: { ...prev.payments, klarna_client_id: e.target.value.trim() }
                    }))}
                    placeholder="e.g. 9b32b123-4567-8901-2345-6789abcdef01"
                    className="mt-1 font-mono text-xs"
                  />
                  <div className="flex items-start gap-2 mt-2 text-[11px] text-gray-500">
                    <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                    <div>
                      Get your free Client ID from{' '}
                      <a href="https://portal.klarna.com" target="_blank" rel="noopener noreferrer" className="text-rose-600 hover:underline font-medium">
                        portal.klarna.com
                      </a>{' '}
                      → On-Site Messaging → Placements. You can set this up even if you don't have a full merchant account.
                    </div>
                  </div>
                </div>
              )}

              {/* Help callout */}
              <div className="mt-4 p-3 bg-blue-50 rounded-lg border border-blue-100">
                <p className="text-xs text-blue-900 leading-relaxed">
                  <strong>How Stripe-native Klarna works:</strong> when a customer picks Klarna at checkout, Stripe hosts the Klarna
                  flow, takes the risk, and settles the full amount to your normal Stripe payout.
                  Refunds work through your usual Stripe refund flow. Fees are Stripe's standard Klarna rate.
                </p>
              </div>
            </div>
          </div>

          {/* ======== PayPal — Stripe-native ======== */}
          <div className="bg-white rounded-lg p-6 border border-gray-200" data-testid="paypal-settings-panel">
            <div className="flex items-start gap-3 mb-4">
              <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-sky-100 to-blue-100 flex items-center justify-center flex-shrink-0">
                <CreditCard className="w-5 h-5 text-[#003087]" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">PayPal</h3>
                <p className="text-sm text-gray-500 mt-0.5">
                  Stripe-native integration. Let customers pay with their PayPal balance, linked bank,
                  or card-on-file. Uses your existing Stripe account — no separate PayPal merchant setup
                  needed beyond enabling PayPal in Stripe.
                </p>
              </div>
            </div>

            <div className="space-y-4">
              <label className="flex items-start gap-3 p-4 border border-gray-200 rounded-lg hover:bg-gray-50 cursor-pointer transition-colors" data-testid="paypal-checkout-toggle">
                <input
                  type="checkbox"
                  checked={!!settings.payments?.paypal_enabled}
                  onChange={(e) => setSettings(prev => ({
                    ...prev,
                    payments: { ...prev.payments, paypal_enabled: e.target.checked }
                  }))}
                  className="mt-1 w-4 h-4 text-[#003087] rounded border-gray-300 focus:ring-[#003087]"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900">Show PayPal at checkout</span>
                    {settings.payments?.paypal_enabled && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-medium">ACTIVE</span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    Adds PayPal as a payment option alongside cards. Also enables a one-tap
                    <strong> PayPal Express</strong> button on the basket page (skips our checkout form).
                    You must first enable PayPal in your Stripe dashboard:
                    <a href="https://dashboard.stripe.com/settings/payment_methods" target="_blank" rel="noopener noreferrer" className="text-[#003087] hover:underline ml-1">
                      Settings → Payment methods → PayPal
                    </a>.
                  </p>
                </div>
              </label>

              <div className="mt-4 p-3 bg-blue-50 rounded-lg border border-blue-100">
                <p className="text-xs text-blue-900 leading-relaxed">
                  <strong>How Stripe-native PayPal works:</strong> when a customer picks PayPal, Stripe hosts the PayPal
                  flow, takes the risk, and settles the full amount to your normal Stripe payout.
                  Refunds work through your usual Stripe refund flow. Fees are Stripe's standard PayPal rate.
                </p>
              </div>
            </div>
          </div>


          {/* ======== Apple Pay / Google Pay — Wallet Express ======== */}
          <div className="bg-white rounded-lg p-6 border border-gray-200" data-testid="wallet-express-panel">
            <div className="flex items-start gap-3 mb-4">
              <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-slate-900 to-slate-700 flex items-center justify-center flex-shrink-0">
                <CreditCard className="w-5 h-5 text-white" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Apple Pay &amp; Google Pay</h3>
                <p className="text-sm text-gray-500 mt-0.5">
                  Native wallet buttons on the basket page. Apple Pay shows on Safari/iOS; Google Pay shows on Chrome/Android.
                  One-tap checkout using the customer's saved card + shipping details.
                  Button hides automatically when the browser doesn't support either wallet.
                </p>
              </div>
            </div>

            <div className="space-y-4">
              <label className="flex items-start gap-3 p-4 border border-gray-200 rounded-lg hover:bg-gray-50 cursor-pointer transition-colors" data-testid="wallet-express-toggle">
                <input
                  type="checkbox"
                  checked={!!settings.payments?.wallet_express_enabled}
                  onChange={async (e) => {
                    const enabled = e.target.checked;
                    setSettings(prev => ({
                      ...prev,
                      payments: { ...prev.payments, wallet_express_enabled: enabled }
                    }));
                    // When turning ON, save first, then auto-register the domain
                    // with Stripe for Apple Pay. This is a silent background call —
                    // toast on failure only.
                    if (enabled) {
                      try {
                        const token = localStorage.getItem('token');
                        const authHeaders = { 'Authorization': `Bearer ${token}` };
                        const merged = {
                          ...settings,
                          payments: { ...(settings.payments || {}), wallet_express_enabled: true }
                        };
                        await fetch(`${API_URL}/api/website-admin/checkout-settings`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json', ...authHeaders },
                          body: JSON.stringify({ settings: merged })
                        });
                        const reg = await fetch(`${API_URL}/api/shop/wallet-express/register-apple-domain`, {
                          method: 'POST', headers: authHeaders
                        });
                        if (reg.ok) {
                          toast.success('Apple Pay domain registered with Stripe');
                        } else {
                          const err = await reg.json().catch(() => ({}));
                          toast.warning(`Apple Pay registration note: ${err.detail || 'manual step may be needed'}`);
                        }
                      } catch (err) {
                        console.warn('Apple Pay auto-register:', err);
                      }
                    }
                  }}
                  className="mt-1 w-4 h-4 text-slate-900 rounded border-gray-300 focus:ring-slate-900"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900">Show Apple Pay / Google Pay on basket</span>
                    {settings.payments?.wallet_express_enabled && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-medium">ACTIVE</span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    Requires: (1) Apple Pay and Google Pay enabled in your
                    <a href="https://dashboard.stripe.com/settings/payment_methods" target="_blank" rel="noopener noreferrer" className="text-slate-900 hover:underline ml-1 font-medium">
                      Stripe Dashboard
                    </a>;
                    (2) the backend serves the Apple Pay domain association file at <code className="text-[11px] bg-gray-100 px-1 rounded">/.well-known/apple-developer-merchantid-domain-association</code> (auto-bundled);
                    (3) your publishable key <code className="text-[11px] bg-gray-100 px-1 rounded">REACT_APP_STRIPE_PUBLISHABLE_KEY</code> is set in frontend .env.
                    Turning this toggle on will automatically register this domain with Stripe for Apple Pay.
                  </p>
                </div>
              </label>

              <div className="mt-4 p-3 bg-blue-50 rounded-lg border border-blue-100">
                <p className="text-xs text-blue-900 leading-relaxed">
                  <strong>How it works:</strong> we create a Stripe PaymentIntent server-side with the server-computed total.
                  The browser's ExpressCheckoutElement shows the appropriate native wallet button. When the customer authenticates
                  (Face ID / Touch ID / fingerprint), Stripe confirms the payment in-page and the order is marked paid via webhook.
                </p>
              </div>
            </div>
          </div>



          {/* ======== Klarna Test Sandbox ======== */}
          <div className="bg-white rounded-lg p-6 border border-gray-200" data-testid="klarna-sandbox-panel">
            <div className="flex items-start gap-3 mb-4">
              <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-violet-100 to-indigo-100 flex items-center justify-center flex-shrink-0">
                <Settings className="w-5 h-5 text-violet-600" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Klarna Test Sandbox</h3>
                <p className="text-sm text-gray-500 mt-0.5">
                  Test the customer journey for approved, declined, and 3DS-challenge Klarna purchases
                  without spending real money.
                </p>
              </div>
            </div>

            <div className="space-y-3">
              {/* Scenario cards — documentation-driven; launches real Stripe LIVE session but uses Klarna's test personas */}
              {[
                {
                  id: 'approved',
                  title: 'Approved purchase',
                  description: 'Customer sails through Klarna underwriting. Outcome: payment_intent succeeds, order marked paid.',
                  persona: 'Email: customer@example.com · DOB: 1970-01-01 · Any UK address',
                  pillColor: 'bg-emerald-100 text-emerald-700 border-emerald-200',
                  pillLabel: 'APPROVED',
                  iconColor: 'text-emerald-500',
                },
                {
                  id: 'declined',
                  title: 'Declined at Klarna underwriting',
                  description: "Klarna rejects the customer — common when affordability / credit checks fail. Outcome: customer returned to cart, card fallback offered.",
                  persona: 'Email: declined@example.com · Any UK address',
                  pillColor: 'bg-rose-100 text-rose-700 border-rose-200',
                  pillLabel: 'DECLINED',
                  iconColor: 'text-rose-500',
                },
                {
                  id: '3ds',
                  title: '3DS / strong customer authentication',
                  description: "Customer must complete an additional SCA step on their card's 3D-Secure page before Klarna accepts.",
                  persona: 'Card behind Klarna: 4000 0025 0000 3155 · Any CVC/expiry',
                  pillColor: 'bg-amber-100 text-amber-700 border-amber-200',
                  pillLabel: '3DS CHALLENGE',
                  iconColor: 'text-amber-500',
                },
                {
                  id: 'refund',
                  title: 'Full refund',
                  description: "After an approved order, trigger a full refund via Stripe Dashboard → Payments → click payment → Refund. Money returned to customer, Klarna instalments cancelled.",
                  persona: 'Runs through the usual Stripe Dashboard refund flow',
                  pillColor: 'bg-indigo-100 text-indigo-700 border-indigo-200',
                  pillLabel: 'REFUND',
                  iconColor: 'text-indigo-500',
                },
              ].map(scenario => (
                <div
                  key={scenario.id}
                  data-testid={`klarna-scenario-${scenario.id}`}
                  className="flex items-start gap-3 p-4 border border-gray-200 rounded-lg bg-gradient-to-br from-white to-gray-50"
                >
                  <div className={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${scenario.iconColor.replace('text-', 'bg-')}`}></div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="font-medium text-gray-900 text-sm">{scenario.title}</span>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${scenario.pillColor}`}>
                        {scenario.pillLabel}
                      </span>
                    </div>
                    <p className="text-xs text-gray-600 mb-2">{scenario.description}</p>
                    <div className="text-[11px] font-mono bg-gray-900 text-gray-100 rounded px-2 py-1.5 break-all">
                      {scenario.persona}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-5 p-3 bg-amber-50 border border-amber-200 rounded-lg">
              <p className="text-xs text-amber-900 leading-relaxed">
                <strong>⚠️ Using live Stripe keys:</strong> You're currently running on Stripe LIVE mode, so any
                checkout attempt charges real money. To run the scenarios above without charges,
                rotate to Stripe test keys temporarily (Stripe Dashboard → top-right toggle → "Test mode" → Developers → API keys → copy
                <code className="mx-1 font-mono bg-amber-100 px-1 rounded">sk_test_...</code>).
                Contact your developer to swap <code className="mx-1 font-mono bg-amber-100 px-1 rounded">STRIPE_API_KEY</code> in the backend env for the test session,
                then swap back once QA is done.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Checkout Text Tab */}
      {activeTab === 'text' && (
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h2 className="text-lg font-bold text-gray-900 mb-4">Checkout Page Text</h2>
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <div>
                <Label>Step 1 Title</Label>
                <Input value={settings.text.step1_title} onChange={(e) => setSettings(prev => ({ ...prev, text: { ...prev.text, step1_title: e.target.value } }))} className="mt-1" />
              </div>
              <div>
                <Label>Step 2 Title</Label>
                <Input value={settings.text.step2_title} onChange={(e) => setSettings(prev => ({ ...prev, text: { ...prev.text, step2_title: e.target.value } }))} className="mt-1" />
              </div>
              <div>
                <Label>Step 3 Title</Label>
                <Input value={settings.text.step3_title} onChange={(e) => setSettings(prev => ({ ...prev, text: { ...prev.text, step3_title: e.target.value } }))} className="mt-1" />
              </div>
            </div>
            <div>
              <Label>Secure Payment Message</Label>
              <Input value={settings.text.secure_message} onChange={(e) => setSettings(prev => ({ ...prev, text: { ...prev.text, secure_message: e.target.value } }))} className="mt-1" />
            </div>
            <div>
              <Label>Order Notes Placeholder</Label>
              <Input value={settings.text.order_notes_placeholder} onChange={(e) => setSettings(prev => ({ ...prev, text: { ...prev.text, order_notes_placeholder: e.target.value } }))} className="mt-1" />
            </div>
            <div>
              <Label>Success Message</Label>
              <Input value={settings.text.success_message} onChange={(e) => setSettings(prev => ({ ...prev, text: { ...prev.text, success_message: e.target.value } }))} className="mt-1" />
            </div>
            <div>
              <Label>Minimum Order Amount (£) — 0 = no minimum</Label>
              <Input type="number" value={settings.min_order} onChange={(e) => setSettings(prev => ({ ...prev, min_order: parseFloat(e.target.value) || 0 }))} className="mt-1 max-w-[200px]" />
            </div>
          </div>
        </div>
      )}

      {/* Preview Tab */}
      {activeTab === 'preview' && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl shadow-sm p-6">
            <h2 className="text-lg font-bold text-gray-900 mb-4">Checkout Page Preview</h2>

            {/* Step Progress */}
            <div className="flex items-center justify-center mb-8">
              {[settings.text.step1_title, settings.text.step2_title, settings.text.step3_title].map((label, idx) => (
                <React.Fragment key={idx}>
                  <div className="flex items-center gap-2">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${idx === 0 ? 'bg-[#333333] text-[#F7EA1C]' : 'bg-gray-200 text-gray-500'}`}>
                      {idx + 1}
                    </div>
                    <span className="font-medium text-sm">{label}</span>
                  </div>
                  {idx < 2 && <div className="w-16 h-0.5 mx-2 bg-gray-200" />}
                </React.Fragment>
              ))}
            </div>

            {/* Delivery Options Preview */}
            <div className="border rounded-xl p-6 bg-gray-50 mb-6">
              <h3 className="font-semibold text-gray-900 mb-4">Delivery Options Preview</h3>
              <div className="space-y-3 max-w-md">
                {settings.delivery.enabled && (
                  <div className="flex items-start gap-4 p-4 border rounded-lg bg-white border-[#F7EA1C]">
                    <Truck className="h-5 w-5 text-[#F7EA1C] mt-0.5" />
                    <div>
                      <span className="font-medium">{settings.delivery.label}</span>
                      <p className="text-sm text-gray-500 mt-1">{settings.delivery.description}</p>
                    </div>
                  </div>
                )}
                {settings.collection.enabled && (
                  <div className="flex items-start gap-4 p-4 border rounded-lg bg-white">
                    <MapPin className="h-5 w-5 text-[#F7EA1C] mt-0.5" />
                    <div>
                      <span className="font-medium">{settings.collection.label}</span>
                      <p className="text-sm text-gray-500 mt-1">{settings.collection.description}</p>
                      <p className="text-xs text-gray-400 mt-1">{settings.collection.ready_time}</p>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Delivery Zones Summary */}
            <div className="border rounded-xl p-6 bg-gray-50 mb-6">
              <h3 className="font-semibold text-gray-900 mb-4">Delivery Pricing by Zone</h3>
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4 text-sm text-amber-700">
                Free delivery on orders over £{settings.delivery.free_threshold}
              </div>
              <div className="space-y-2">
                {settings.delivery.zones.map(zone => (
                  <div key={zone.id} className={`flex items-center justify-between p-3 bg-white rounded-lg border ${zone.is_congestion_zone ? 'border-red-200' : ''}`}>
                    <div>
                      <span className="font-medium text-sm">{zone.name}</span>
                      <span className="text-xs text-gray-400 ml-2">({zone.postcodes || 'All other'})</span>
                      {zone.is_congestion_zone && settings.delivery.congestion_charge?.enabled && (
                        <span className="ml-2 text-xs text-red-600 font-medium bg-red-50 px-1.5 py-0.5 rounded">+ CC</span>
                      )}
                    </div>
                    <div className="text-right">
                      <span className="font-bold text-sm">£{zone.fee.toFixed(2)}</span>
                      {zone.is_congestion_zone && settings.delivery.congestion_charge?.enabled && (
                        <span className="text-xs text-red-600 font-medium ml-1">+ £{(settings.delivery.congestion_charge.amount ?? 15).toFixed(2)}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Order Summary Preview */}
            <div className="border rounded-xl p-6 bg-gray-50">
              <h3 className="font-semibold text-gray-900 mb-4">Order Summary Preview</h3>
              <div className="max-w-xs bg-white rounded-lg shadow-sm p-4 border">
                <h4 className="font-semibold mb-3 text-sm">Order Summary</h4>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between"><span className="text-gray-500">Subtotal</span><span>£120.00</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Delivery</span><span className="text-gray-400 italic">Calculated at next step</span></div>
                  <div className="border-t pt-2 flex justify-between font-semibold"><span>Total</span><span className="text-[#F7EA1C]">£120.00</span></div>
                  <p className="text-xs text-gray-400 text-center mt-2">Delivery calculated after postcode entry</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CheckoutSettings;

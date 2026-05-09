import React, { useState, useEffect } from 'react';
import { Megaphone, Loader2, Save, Eye, EyeOff, Image, Link2, Mail, Clock, Type, MessageSquare, MousePointer } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { toast } from 'sonner';
import { normaliseImageUrl } from '../../utils/safeStr';

const API_URL = process.env.REACT_APP_BACKEND_URL || '';

export default function WelcomePopupAdmin() {
  const [config, setConfig] = useState({
    enabled: false,
    heading: '',
    message: '',
    image_url: '',
    cta_text: '',
    cta_link: '',
    show_email_capture: false,
    email_placeholder: 'Enter your email',
    email_button_text: 'Subscribe',
    frequency: 'once',
    delay_seconds: 2,
    coupon_enabled: false,
    coupon_percent: 10,
    coupon_expires_days: 30,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => { fetchConfig(); }, []);

  const fetchConfig = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/welcome-popup`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setConfig(prev => ({ ...prev, ...data }));
      }
    } catch (e) {
      console.error('Error:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/welcome-popup`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(config)
      });
      if (res.ok) toast.success('Popup settings saved');
      else toast.error('Failed to save');
    } catch (e) {
      toast.error('Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const update = (field, value) => setConfig(prev => ({ ...prev, [field]: value }));

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto p-6" data-testid="welcome-popup-admin">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 bg-purple-100 rounded-xl flex items-center justify-center">
            <Megaphone className="w-6 h-6 text-purple-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Welcome Popup</h1>
            <p className="text-gray-500">Customise the popup shown to visitors when they land on your site</p>
          </div>
        </div>
        <Button onClick={handleSave} disabled={saving} data-testid="save-popup-btn">
          {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
          Save Changes
        </Button>
      </div>

      <div className="grid lg:grid-cols-5 gap-8">
        {/* Settings Column */}
        <div className="lg:col-span-3 space-y-6">
          {/* Enable Toggle */}
          <div className="bg-white border border-gray-200 rounded-xl p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {config.enabled ? <Eye className="w-5 h-5 text-green-600" /> : <EyeOff className="w-5 h-5 text-gray-400" />}
                <div>
                  <p className="font-semibold text-gray-900">Popup Status</p>
                  <p className="text-sm text-gray-500">{config.enabled ? 'Visible to visitors' : 'Hidden from visitors'}</p>
                </div>
              </div>
              <button
                onClick={() => update('enabled', !config.enabled)}
                className={`relative w-12 h-7 rounded-full transition-colors ${config.enabled ? 'bg-green-500' : 'bg-gray-300'}`}
                data-testid="popup-enabled-toggle"
              >
                <div className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow transition-transform ${config.enabled ? 'translate-x-5.5 left-[calc(100%-26px)]' : 'left-0.5'}`} />
              </button>
            </div>
          </div>

          {/* Content */}
          <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
            <h3 className="font-semibold text-gray-900 flex items-center gap-2">
              <Type className="w-4 h-4" /> Content
            </h3>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Heading</label>
              <Input
                value={config.heading}
                onChange={(e) => update('heading', e.target.value)}
                placeholder="e.g., Welcome to Tile Station!"
                data-testid="popup-heading-input"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Message</label>
              <textarea
                value={config.message}
                onChange={(e) => update('message', e.target.value)}
                placeholder="e.g., Get 10% off your first order when you sign up to our newsletter."
                rows={3}
                className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:ring-2 focus:ring-purple-500 focus:border-purple-500 transition-colors resize-none text-sm"
                data-testid="popup-message-input"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Banner Image URL</label>
              <Input
                value={config.image_url}
                onChange={(e) => update('image_url', e.target.value)}
                placeholder="https://... (optional)"
                data-testid="popup-image-input"
              />
              <p className="text-xs text-gray-400 mt-1">Leave empty for no image. Recommended: 600x250px</p>
            </div>
          </div>

          {/* CTA Button */}
          <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
            <h3 className="font-semibold text-gray-900 flex items-center gap-2">
              <MousePointer className="w-4 h-4" /> Call to Action Button
            </h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Button Text</label>
                <Input
                  value={config.cta_text}
                  onChange={(e) => update('cta_text', e.target.value)}
                  placeholder="e.g., Shop Now"
                  data-testid="popup-cta-text"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Button Link</label>
                <Input
                  value={config.cta_link}
                  onChange={(e) => update('cta_link', e.target.value)}
                  placeholder="e.g., /tiles"
                  data-testid="popup-cta-link"
                />
              </div>
            </div>
            <p className="text-xs text-gray-400">Leave both empty to hide the button</p>
          </div>

          {/* Email Capture */}
          <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                <Mail className="w-4 h-4" /> Email Capture
              </h3>
              <button
                onClick={() => update('show_email_capture', !config.show_email_capture)}
                className={`relative w-12 h-7 rounded-full transition-colors ${config.show_email_capture ? 'bg-green-500' : 'bg-gray-300'}`}
                data-testid="popup-email-toggle"
              >
                <div className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow transition-transform ${config.show_email_capture ? 'left-[calc(100%-26px)]' : 'left-0.5'}`} />
              </button>
            </div>

            {config.show_email_capture && (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Placeholder Text</label>
                  <Input
                    value={config.email_placeholder}
                    onChange={(e) => update('email_placeholder', e.target.value)}
                    placeholder="Enter your email"
                    data-testid="popup-email-placeholder"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Submit Button Text</label>
                  <Input
                    value={config.email_button_text}
                    onChange={(e) => update('email_button_text', e.target.value)}
                    placeholder="Subscribe"
                    data-testid="popup-email-btn-text"
                  />
                </div>
              </div>
            )}

            {/* Coupon code reward */}
            {config.show_email_capture && (
              <div className="border-t pt-4 mt-2">
                <div className="flex items-center justify-between">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Email a coupon code on signup</label>
                    <p className="text-xs text-gray-500 mt-0.5">Sends a single-use WELCOME-XXXXXX code to the visitor's inbox and nudges them to register.</p>
                  </div>
                  <button
                    onClick={() => update('coupon_enabled', !config.coupon_enabled)}
                    className={`relative w-12 h-7 rounded-full transition-colors ${config.coupon_enabled ? 'bg-amber-500' : 'bg-gray-300'}`}
                    data-testid="popup-coupon-toggle"
                  >
                    <div className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow transition-transform ${config.coupon_enabled ? 'left-[calc(100%-26px)]' : 'left-0.5'}`} />
                  </button>
                </div>
                {config.coupon_enabled && (
                  <div className="grid grid-cols-2 gap-4 mt-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Discount %</label>
                      <Input
                        type="number" min={1} max={50}
                        value={config.coupon_percent}
                        onChange={(e) => update('coupon_percent', e.target.value)}
                        data-testid="popup-coupon-percent"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Code expiry (days)</label>
                      <Input
                        type="number" min={1} max={120}
                        value={config.coupon_expires_days}
                        onChange={(e) => update('coupon_expires_days', e.target.value)}
                        data-testid="popup-coupon-expiry"
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Display Settings */}
          <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
            <h3 className="font-semibold text-gray-900 flex items-center gap-2">
              <Clock className="w-4 h-4" /> Display Settings
            </h3>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Show Frequency</label>
                <select
                  value={config.frequency}
                  onChange={(e) => update('frequency', e.target.value)}
                  className="w-full px-3 py-2.5 rounded-lg border border-gray-200 focus:ring-2 focus:ring-purple-500 focus:border-purple-500 text-sm"
                  data-testid="popup-frequency"
                >
                  <option value="once">Once per visitor (remembered forever)</option>
                  <option value="session">Once per session</option>
                  <option value="always">Every page load</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Delay Before Showing</label>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min="0"
                    max="30"
                    value={config.delay_seconds}
                    onChange={(e) => update('delay_seconds', parseInt(e.target.value) || 0)}
                    data-testid="popup-delay"
                  />
                  <span className="text-sm text-gray-500 whitespace-nowrap">seconds</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Live Preview */}
        <div className="lg:col-span-2">
          <div className="sticky top-6">
            <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">Live Preview</h3>
            <div className="bg-gray-900/5 rounded-2xl p-6 flex items-center justify-center min-h-[400px]">
              <div className="bg-white rounded-2xl shadow-xl overflow-hidden max-w-sm w-full">
                {config.image_url && (
                  <div className="w-full h-36 overflow-hidden bg-gray-100">
                    <img src={normaliseImageUrl(config.image_url)} alt="" className="w-full h-full object-cover" onError={(e) => { e.target.style.display = 'none'; }} />
                  </div>
                )}
                <div className="p-5">
                  {config.heading && (
                    <h4 className="text-lg font-bold text-gray-900 mb-1">{config.heading}</h4>
                  )}
                  {config.message && (
                    <p className="text-sm text-gray-600 mb-4 whitespace-pre-line">{config.message}</p>
                  )}
                  {config.show_email_capture && (
                    <div className="flex gap-2 mb-3">
                      <input
                        type="text"
                        disabled
                        placeholder={config.email_placeholder || 'Enter your email'}
                        className="flex-1 px-3 py-2 rounded-lg border border-gray-200 text-xs bg-gray-50"
                      />
                      <button className="bg-gray-900 text-white px-3 py-2 rounded-lg text-xs font-semibold">
                        {config.email_button_text || 'Subscribe'}
                      </button>
                    </div>
                  )}
                  {config.cta_text && (
                    <button className="w-full bg-amber-500 text-white font-bold py-2.5 px-4 rounded-lg text-sm">
                      {config.cta_text} &rarr;
                    </button>
                  )}
                  {!config.heading && !config.message && !config.cta_text && !config.show_email_capture && (
                    <p className="text-center text-gray-400 text-sm py-6">Fill in the fields to see a preview</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

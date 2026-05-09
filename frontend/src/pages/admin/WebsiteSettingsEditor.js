import React, { useState, useEffect } from 'react';
import { Save, RefreshCw, Upload, Globe, Mail, Phone, MapPin, Facebook, Instagram, Twitter } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Textarea } from '../../components/ui/textarea';
import { toast } from 'sonner';
import { normaliseImageUrl } from '../../utils/safeStr';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const defaultSettings = {
  site_name: "Tile Station",
  tagline: "Premium Quality Tiles",
  logo_url: "",
  favicon_url: "",
  primary_color: "#333333",
  secondary_color: "#F7EA1C",
  contact_email: "info@tilestation.co.uk",
  contact_phone: "01732 424242",
  address: "Tonbridge, Kent",
  social_facebook: "",
  social_instagram: "",
  social_twitter: "",
  footer_text: "© 2026 Tile Station Ltd. All rights reserved.",
  google_analytics_id: ""
};

const WebsiteSettingsEditor = () => {
  const [settings, setSettings] = useState(defaultSettings);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/settings`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (data && Object.keys(data).length > 0) {
        setSettings({ ...defaultSettings, ...data });
      }
    } catch (e) {
      console.log('Using default settings');
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (field, value) => {
    setSettings(prev => ({ ...prev, [field]: value }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/settings`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(settings)
      });

      if (!res.ok) throw new Error('Failed to save');

      toast.success('Settings saved!');
    } catch (e) {
      toast.error('Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setSettings(defaultSettings);
    toast.info('Settings reset to defaults (not saved yet)');
  };

  const handleImageUpload = async (e, field) => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);
    formData.append('folder', 'branding');

    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/upload-image`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      });

      if (!res.ok) throw new Error('Upload failed');

      const data = await res.json();
      handleChange(field, data.url);
      toast.success('Image uploaded!');
    } catch (e) {
      toast.error('Failed to upload image');
    }
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-spin w-8 h-8 border-4 border-gray-400 border-t-transparent rounded-full mx-auto"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Header */}
      <div className="bg-white shadow-sm border-b sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">Website Settings</h1>
            <p className="text-sm text-gray-500">Configure your website branding and contact info</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={handleReset}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Reset
            </Button>
            <Button onClick={handleSave} disabled={saving} className="bg-amber-500 hover:bg-amber-600">
              <Save className="h-4 w-4 mr-2" />
              {saving ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
        {/* Branding */}
        <div className="bg-white rounded-lg shadow-sm p-6">
          <h2 className="text-lg font-semibold mb-4 pb-2 border-b flex items-center gap-2">
            <Globe className="h-5 w-5" />
            Branding
          </h2>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Site Name</Label>
                <Input
                  value={settings.site_name}
                  onChange={(e) => handleChange('site_name', e.target.value)}
                  className="mt-1"
                />
              </div>
              <div>
                <Label>Tagline</Label>
                <Input
                  value={settings.tagline}
                  onChange={(e) => handleChange('tagline', e.target.value)}
                  className="mt-1"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Logo URL</Label>
                <div className="mt-1 flex gap-2">
                  <Input
                    value={settings.logo_url}
                    onChange={(e) => handleChange('logo_url', e.target.value)}
                    placeholder="Logo image URL"
                    className="flex-1"
                  />
                  <label className="cursor-pointer">
                    <input type="file" accept="image/*" onChange={(e) => handleImageUpload(e, 'logo_url')} className="hidden" />
                    <Button type="button" variant="outline" asChild>
                      <span><Upload className="h-4 w-4" /></span>
                    </Button>
                  </label>
                </div>
                {settings.logo_url && (
                  <img src={settings.logo_url} alt="Logo" className="mt-2 h-12 object-contain bg-gray-800 p-2 rounded" />
                )}
              </div>
              <div>
                <Label>Favicon URL</Label>
                <div className="mt-1 flex gap-2">
                  <Input
                    value={settings.favicon_url}
                    onChange={(e) => handleChange('favicon_url', e.target.value)}
                    placeholder="Favicon URL"
                    className="flex-1"
                  />
                  <label className="cursor-pointer">
                    <input type="file" accept="image/*" onChange={(e) => handleImageUpload(e, 'favicon_url')} className="hidden" />
                    <Button type="button" variant="outline" asChild>
                      <span><Upload className="h-4 w-4" /></span>
                    </Button>
                  </label>
                </div>
                {settings.favicon_url && (
                  <img src={normaliseImageUrl(settings.favicon_url)} alt="Favicon" className="mt-2 h-8 w-8 object-contain" />
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Primary Color</Label>
                <div className="mt-1 flex gap-2">
                  <Input
                    value={settings.primary_color}
                    onChange={(e) => handleChange('primary_color', e.target.value)}
                    placeholder="#333333"
                    className="flex-1"
                  />
                  <input
                    type="color"
                    value={settings.primary_color}
                    onChange={(e) => handleChange('primary_color', e.target.value)}
                    className="w-10 h-10 rounded cursor-pointer"
                  />
                </div>
              </div>
              <div>
                <Label>Secondary Color (Accent)</Label>
                <div className="mt-1 flex gap-2">
                  <Input
                    value={settings.secondary_color}
                    onChange={(e) => handleChange('secondary_color', e.target.value)}
                    placeholder="#F7EA1C"
                    className="flex-1"
                  />
                  <input
                    type="color"
                    value={settings.secondary_color}
                    onChange={(e) => handleChange('secondary_color', e.target.value)}
                    className="w-10 h-10 rounded cursor-pointer"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Contact Info */}
        <div className="bg-white rounded-lg shadow-sm p-6">
          <h2 className="text-lg font-semibold mb-4 pb-2 border-b flex items-center gap-2">
            <Mail className="h-5 w-5" />
            Contact Information
          </h2>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="flex items-center gap-2">
                  <Mail className="h-4 w-4" />
                  Email Address
                </Label>
                <Input
                  value={settings.contact_email}
                  onChange={(e) => handleChange('contact_email', e.target.value)}
                  className="mt-1"
                  type="email"
                />
              </div>
              <div>
                <Label className="flex items-center gap-2">
                  <Phone className="h-4 w-4" />
                  Phone Number
                </Label>
                <Input
                  value={settings.contact_phone}
                  onChange={(e) => handleChange('contact_phone', e.target.value)}
                  className="mt-1"
                />
              </div>
            </div>
            <div>
              <Label className="flex items-center gap-2">
                <MapPin className="h-4 w-4" />
                Address
              </Label>
              <Textarea
                value={settings.address}
                onChange={(e) => handleChange('address', e.target.value)}
                className="mt-1"
                rows={2}
              />
            </div>
          </div>
        </div>

        {/* Social Media */}
        <div className="bg-white rounded-lg shadow-sm p-6">
          <h2 className="text-lg font-semibold mb-4 pb-2 border-b">Social Media</h2>
          <div className="space-y-4">
            <div>
              <Label className="flex items-center gap-2">
                <Facebook className="h-4 w-4 text-blue-600" />
                Facebook URL
              </Label>
              <Input
                value={settings.social_facebook}
                onChange={(e) => handleChange('social_facebook', e.target.value)}
                className="mt-1"
                placeholder="https://facebook.com/yourpage"
              />
            </div>
            <div>
              <Label className="flex items-center gap-2">
                <Instagram className="h-4 w-4 text-pink-600" />
                Instagram URL
              </Label>
              <Input
                value={settings.social_instagram}
                onChange={(e) => handleChange('social_instagram', e.target.value)}
                className="mt-1"
                placeholder="https://instagram.com/yourpage"
              />
            </div>
            <div>
              <Label className="flex items-center gap-2">
                <Twitter className="h-4 w-4 text-blue-400" />
                Twitter/X URL
              </Label>
              <Input
                value={settings.social_twitter}
                onChange={(e) => handleChange('social_twitter', e.target.value)}
                className="mt-1"
                placeholder="https://twitter.com/yourpage"
              />
            </div>
          </div>
        </div>

        {/* Footer & Analytics */}
        <div className="bg-white rounded-lg shadow-sm p-6">
          <h2 className="text-lg font-semibold mb-4 pb-2 border-b">Footer & Analytics</h2>
          <div className="space-y-4">
            <div>
              <Label>Footer Text</Label>
              <Input
                value={settings.footer_text}
                onChange={(e) => handleChange('footer_text', e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <Label>Google Analytics ID</Label>
              <Input
                value={settings.google_analytics_id}
                onChange={(e) => handleChange('google_analytics_id', e.target.value)}
                className="mt-1"
                placeholder="G-XXXXXXXXXX or UA-XXXXXXX-X"
              />
              <p className="text-xs text-gray-500 mt-1">Leave empty to disable tracking</p>
            </div>
          </div>
        </div>

        {/* Color Preview */}
        <div className="bg-white rounded-lg shadow-sm p-6">
          <h2 className="text-lg font-semibold mb-4 pb-2 border-b">Color Preview</h2>
          <div className="flex gap-4">
            <div 
              className="flex-1 h-20 rounded flex items-center justify-center text-white font-medium"
              style={{ backgroundColor: settings.primary_color }}
            >
              Primary: {settings.primary_color}
            </div>
            <div 
              className="flex-1 h-20 rounded flex items-center justify-center font-medium"
              style={{ backgroundColor: settings.secondary_color, color: settings.primary_color }}
            >
              Secondary: {settings.secondary_color}
            </div>
          </div>
          <div 
            className="mt-4 p-4 rounded flex items-center justify-between"
            style={{ backgroundColor: settings.primary_color }}
          >
            <span className="font-bold text-lg" style={{ color: settings.secondary_color }}>
              {settings.site_name}
            </span>
            <button 
              className="px-4 py-2 rounded font-medium"
              style={{ backgroundColor: settings.secondary_color, color: settings.primary_color }}
            >
              Sample Button
            </button>
          </div>
        </div>

        {/* Save Button */}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={handleReset}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Reset to Defaults
          </Button>
          <Button onClick={handleSave} disabled={saving} className="bg-amber-500 hover:bg-amber-600">
            <Save className="h-4 w-4 mr-2" />
            {saving ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default WebsiteSettingsEditor;

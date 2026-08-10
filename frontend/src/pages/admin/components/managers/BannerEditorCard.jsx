/**
 * BannerEditorCard — self-contained editor for ONE page banner.
 * scope = 'default' (site-wide fallback banner) or a group slug
 * (e.g. 'materials' → the banner on the Materials shop page).
 * Uses the same /api/website-admin/page-banners upsert the old
 * Navigation & Structure page used, so data stays 100% compatible.
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { Image as ImageIcon, Upload, Save, Trash2, RefreshCw } from 'lucide-react';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const OVERLAYS = [
  { label: 'Light', value: 'rgba(0,0,0,0.15)' },
  { label: 'Medium', value: 'rgba(0,0,0,0.3)' },
  { label: 'Dark', value: 'rgba(0,0,0,0.5)' },
];

const emptyBanner = { title: '', subtitle: '', image: '', overlay: 'rgba(0,0,0,0.3)' };

const BannerEditorCard = ({ scope = 'default', pageLabel = 'this page', testPrefix = 'banner' }) => {
  const [form, setForm] = useState(emptyBanner);
  const [bannerId, setBannerId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/page-banners`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const banners = await res.json();
        const match = (banners || []).find(b =>
          scope === 'default' ? b.is_default : b.group_slug === scope
        );
        if (match) {
          setForm({ title: match.title || '', subtitle: match.subtitle || '', image: match.image || '', overlay: match.overlay || 'rgba(0,0,0,0.3)' });
          setBannerId(match.id || match._id || 'exists');
        } else {
          setForm(emptyBanner);
          setBannerId(null);
        }
      }
    } catch {
      // silent — empty editor still usable
    } finally {
      setLoading(false);
    }
  }, [scope]);

  useEffect(() => { load(); }, [load]);

  const onUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { toast.error('Image too large — max 10MB'); return; }
    setUploading(true);
    try {
      const token = localStorage.getItem('token');
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`${API_URL}/api/website-admin/upload-banner-image`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); toast.error(err.detail || 'Upload failed'); return; }
      const data = await res.json();
      setForm(prev => ({ ...prev, image: data.url }));
      toast.success('Image uploaded');
    } catch { toast.error('Upload failed'); }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const onSave = async () => {
    if (!form.title.trim()) { toast.error('Give the banner a title first'); return; }
    setSaving(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/page-banners`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          title: form.title, subtitle: form.subtitle, image: form.image, overlay: form.overlay,
          category_slug: '', group_slug: scope === 'default' ? '' : scope,
          is_default: scope === 'default', is_active: true,
        }),
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); toast.error(err.detail || 'Save failed'); return; }
      toast.success('Banner saved');
      await load();
    } catch { toast.error('Save failed'); }
    finally { setSaving(false); }
  };

  const onRemove = async () => {
    if (!bannerId || bannerId === 'exists' || scope === 'default') return;
    if (!window.confirm(`Remove the custom banner for ${pageLabel}? The page will fall back to the site default banner.`)) return;
    try {
      const token = localStorage.getItem('token');
      await fetch(`${API_URL}/api/website-admin/page-banners/${bannerId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      toast.success('Banner removed — page now uses the default banner');
      await load();
    } catch { toast.error('Remove failed'); }
  };

  if (loading) {
    return <div className="py-6 text-center text-sm text-gray-400"><RefreshCw className="w-4 h-4 animate-spin inline mr-2" />Loading banner…</div>;
  }

  return (
    <div className="space-y-3" data-testid={`${testPrefix}-editor`}>
      {/* Live preview */}
      <div className="h-32 rounded-lg overflow-hidden relative border bg-gray-100" data-testid={`${testPrefix}-preview`}>
        {form.image ? (
          <div className="absolute inset-0" style={{ backgroundImage: `url(${form.image})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-gray-300"><ImageIcon className="w-8 h-8" /></div>
        )}
        <div className="absolute inset-0" style={{ backgroundColor: form.overlay }} />
        <div className="absolute inset-0 flex items-center justify-center text-center px-4">
          <div>
            <p className="text-white text-lg font-light drop-shadow-lg">{form.title || 'Banner title appears here'}</p>
            {form.subtitle && <p className="text-white/90 text-sm drop-shadow-md mt-1">{form.subtitle}</p>}
          </div>
        </div>
        {!bannerId && scope !== 'default' && (
          <span className="absolute top-2 right-2 px-2 py-0.5 bg-amber-500 text-white text-[10px] font-bold uppercase rounded-full shadow">Using default banner</span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-[11px] font-medium text-gray-600 mb-1">Title</label>
          <Input value={form.title} onChange={(e) => setForm(p => ({ ...p, title: e.target.value }))} placeholder="e.g. Adhesives, Grouts & Levelling" className="h-8 text-sm" data-testid={`${testPrefix}-title`} />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-gray-600 mb-1">Subtitle (optional)</label>
          <Input value={form.subtitle} onChange={(e) => setForm(p => ({ ...p, subtitle: e.target.value }))} placeholder="e.g. Trade-quality materials, delivered fast" className="h-8 text-sm" data-testid={`${testPrefix}-subtitle`} />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-gray-600 mb-1">Image</label>
          <div className="flex gap-2">
            <Input value={form.image} onChange={(e) => setForm(p => ({ ...p, image: e.target.value }))} placeholder="Paste an image URL or upload →" className="h-8 text-xs font-mono flex-1" data-testid={`${testPrefix}-image-url`} />
            <input ref={fileRef} type="file" accept="image/*" onChange={onUpload} className="hidden" id={`${testPrefix}-file`} />
            <Button type="button" variant="outline" size="sm" disabled={uploading} onClick={() => fileRef.current?.click()} data-testid={`${testPrefix}-upload-btn`}>
              <Upload className={`w-3.5 h-3.5 mr-1 ${uploading ? 'animate-pulse' : ''}`} /> {uploading ? 'Uploading…' : 'Upload'}
            </Button>
          </div>
        </div>
        <div>
          <label className="block text-[11px] font-medium text-gray-600 mb-1">Darkness over the image</label>
          <div className="flex gap-1.5">
            {OVERLAYS.map(o => (
              <button
                key={o.value}
                type="button"
                onClick={() => setForm(p => ({ ...p, overlay: o.value }))}
                className={`px-3 py-1.5 rounded border text-xs font-medium ${form.overlay === o.value ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}
                data-testid={`${testPrefix}-overlay-${o.label.toLowerCase()}`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <Button type="button" size="sm" onClick={onSave} disabled={saving} className="bg-emerald-600 hover:bg-emerald-700 text-white" data-testid={`${testPrefix}-save-btn`}>
          <Save className="w-3.5 h-3.5 mr-1" /> {saving ? 'Saving…' : 'Save Banner'}
        </Button>
        {bannerId && bannerId !== 'exists' && scope !== 'default' && (
          <Button type="button" variant="outline" size="sm" className="text-red-500 hover:text-red-700 hover:bg-red-50" onClick={onRemove} data-testid={`${testPrefix}-remove-btn`}>
            <Trash2 className="w-3.5 h-3.5 mr-1" /> Remove (use default)
          </Button>
        )}
      </div>
    </div>
  );
};

export default BannerEditorCard;

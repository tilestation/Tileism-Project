/**
 * CustomManagerBuilder — modal for creating a new custom Manager (Paint,
 * Lighting, Grout Extras…). Simple form: name, slug (auto), theme colour,
 * icon, sub-category keywords used to auto-classify products.
 *
 * Field definitions (custom edit-form fields) are optional at creation and
 * can be edited later on the Custom Manager page itself.
 */

import React, { useState } from 'react';
import { toast } from 'sonner';
import { useNavigate } from 'react-router-dom';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '../../../../components/ui/dialog';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Badge } from '../../../../components/ui/badge';
import { Sparkles, X, Plus, RefreshCw } from 'lucide-react';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const THEME_OPTIONS = [
  { key: 'purple',  swatch: 'bg-purple-500' },
  { key: 'pink',    swatch: 'bg-pink-500' },
  { key: 'emerald', swatch: 'bg-emerald-500' },
  { key: 'amber',   swatch: 'bg-amber-500' },
  { key: 'cyan',    swatch: 'bg-cyan-500' },
  { key: 'red',     swatch: 'bg-red-500' },
  { key: 'slate',   swatch: 'bg-slate-600' },
];

const slugify = (v) => (v || '').toString().trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const CustomManagerBuilder = ({ open, onOpenChange, onCreated }) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [theme, setTheme] = useState('purple');
  const [subCatInput, setSubCatInput] = useState('');
  const [subCategories, setSubCategories] = useState([]);
  const [saving, setSaving] = useState(false);
  const navigate = useNavigate();

  const slug = slugify(name);

  const addSubCat = () => {
    const v = subCatInput.trim();
    if (!v) return;
    if (subCategories.some(s => s.toLowerCase() === v.toLowerCase())) {
      toast.error(`"${v}" already in the list`);
      return;
    }
    setSubCategories(prev => [...prev, v]);
    setSubCatInput('');
  };
  const removeSubCat = (v) => setSubCategories(prev => prev.filter(s => s !== v));

  const reset = () => {
    setName(''); setDescription(''); setTheme('purple');
    setSubCatInput(''); setSubCategories([]);
  };

  const handleCreate = async () => {
    if (!name.trim()) { toast.error('Give your Manager a name'); return; }
    setSaving(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/manager-definitions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          name: name.trim(),
          slug,
          description: description.trim() || null,
          theme,
          sub_categories: subCategories,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const def = await res.json();
      toast.success(`Created "${def.name}" — it now appears in your workspace tabs`);
      reset();
      onOpenChange(false);
      if (onCreated) onCreated(def);
      navigate(`/admin/custom-manager/${def.slug}`);
    } catch (err) {
      toast.error(`Failed to create Manager: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="custom-manager-builder">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-purple-600" />
            New Custom Manager
          </DialogTitle>
          <p className="text-xs text-gray-500">
            Create a dedicated tab for a product category we don&rsquo;t hardcode yet — e.g. Paint, Lighting, Grout Extras.
          </p>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Name</label>
            <Input
              placeholder="e.g. Paint"
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="custom-manager-name"
            />
            {slug && (
              <p className="text-[10px] text-gray-400 mt-0.5">
                URL will be <code className="bg-gray-100 px-1 rounded">/admin/custom-manager/{slug}</code>
              </p>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Description (optional)</label>
            <Input
              placeholder="One-line description shown on the Manager page"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              data-testid="custom-manager-description"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Theme colour</label>
            <div className="flex gap-2" role="radiogroup">
              {THEME_OPTIONS.map(t => (
                <button
                  key={t.key}
                  role="radio"
                  aria-checked={theme === t.key}
                  onClick={() => setTheme(t.key)}
                  className={`w-8 h-8 rounded-full ${t.swatch} ring-offset-2 transition-all ${theme === t.key ? 'ring-2 ring-gray-800 scale-110' : 'hover:scale-105'}`}
                  data-testid={`custom-manager-theme-${t.key}`}
                  title={t.key}
                />
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Sub-category keywords <span className="text-gray-400 font-normal">(products matching these are auto-classified into this Manager)</span>
            </label>
            <div className="flex gap-2">
              <Input
                placeholder="e.g. paint, primer, undercoat…"
                value={subCatInput}
                onChange={(e) => setSubCatInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSubCat(); } }}
                data-testid="custom-manager-subcat-input"
              />
              <Button type="button" onClick={addSubCat} variant="outline" data-testid="custom-manager-subcat-add">
                <Plus className="w-4 h-4 mr-1" /> Add
              </Button>
            </div>
            {subCategories.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {subCategories.map(sc => (
                  <Badge key={sc} variant="outline" className="text-xs pr-1">
                    {sc}
                    <button onClick={() => removeSubCat(sc)} className="ml-1 text-gray-400 hover:text-red-500">
                      <X className="w-3 h-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </div>

          <p className="text-[11px] text-gray-500 bg-blue-50 border border-blue-100 rounded p-2">
            💡 After creating, you can start adding products in this Manager and later fine-tune the custom fields (e.g. finish, coverage, size) directly on the Manager page.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button
            onClick={handleCreate}
            disabled={saving || !name.trim()}
            className="bg-purple-600 hover:bg-purple-700 text-white"
            data-testid="custom-manager-create-btn"
          >
            {saving ? <RefreshCw className="w-4 h-4 mr-1 animate-spin" /> : <Sparkles className="w-4 h-4 mr-1" />}
            Create Manager
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default CustomManagerBuilder;

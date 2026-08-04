/**
 * ManagerPresetsBar — a slim bar rendered inside `ManagerConfigModal` that lets
 * admins:
 *   1. Save the current Manager's config as a reusable Preset (name + include-all-3 arrays)
 *   2. Load a Preset onto the current Manager (Replace or Append mode)
 *
 * Backed by /api/manager-config-templates (see manager_config_templates.py).
 */
import React, { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Badge } from '../../../../components/ui/badge';
import {
  Bookmark, BookmarkPlus, Trash2, RefreshCw, X, Layers, Filter, Wrench,
} from 'lucide-react';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const ManagerPresetsBar = ({ slug, config, onApplied, themeColor = 'slate' }) => {
  const [presets, setPresets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busySlug, setBusySlug] = useState(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [newName, setNewName] = useState('');

  const themeBtn = {
    orange: 'bg-orange-600 hover:bg-orange-700',
    blue:   'bg-blue-600   hover:bg-blue-700',
    amber:  'bg-amber-600  hover:bg-amber-700',
    cyan:   'bg-cyan-600   hover:bg-cyan-700',
    red:    'bg-red-600    hover:bg-red-700',
    slate:  'bg-slate-700  hover:bg-slate-800',
    purple: 'bg-purple-600 hover:bg-purple-700',
  }[themeColor] || 'bg-slate-700 hover:bg-slate-800';

  const fetchPresets = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/manager-config-templates`);
      const data = await res.json();
      setPresets(data.templates || []);
    } catch (_err) {
      // silent — bar is optional
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchPresets(); }, [fetchPresets]);

  const savePreset = async () => {
    const name = newName.trim();
    if (!name) { toast.error('Preset name is required'); return; }
    setBusySlug('__saving');
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/manager-config-templates`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          name,
          theme: themeColor,
          source_slug: slug,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      toast.success(`Preset "${name}" saved`);
      setSaveOpen(false);
      setNewName('');
      fetchPresets();
    } catch (err) {
      toast.error(`Save preset failed: ${err.message}`);
    } finally {
      setBusySlug(null);
    }
  };

  const applyPreset = async (preset, mode) => {
    if (!window.confirm(`Apply preset "${preset.name}" to ${config?.name || slug} in ${mode.toUpperCase()} mode?\n\n${mode === 'replace' ? 'Existing filters, sub-tabs, and spec fields will be overwritten.' : 'New rows will be added — existing rows kept.'}`)) return;
    setBusySlug(preset.slug);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/manager-config-templates/${encodeURIComponent(preset.slug)}/apply`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ target_slug: slug, mode }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const data = await res.json();
      toast.success(`Preset applied — ${data.changed?.join(', ') || 'ok'}`);
      onApplied && onApplied(data.target);
    } catch (err) {
      toast.error(`Apply failed: ${err.message}`);
    } finally {
      setBusySlug(null);
    }
  };

  const deletePreset = async (preset) => {
    if (!window.confirm(`Delete preset "${preset.name}"? This cannot be undone.`)) return;
    setBusySlug(preset.slug);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/manager-config-templates/${encodeURIComponent(preset.slug)}`, {
        method: 'DELETE',
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success(`Preset "${preset.name}" deleted`);
      fetchPresets();
    } catch (err) {
      toast.error(`Delete failed: ${err.message}`);
    } finally {
      setBusySlug(null);
    }
  };

  return (
    <div className="border border-slate-200 rounded-md bg-slate-50 p-2 space-y-2" data-testid="manager-presets-bar">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-slate-700 font-medium">
          <Bookmark className="w-3.5 h-3.5" />
          Manager Presets
          <Badge variant="outline" className="text-[10px] py-0 px-1.5">{presets.length}</Badge>
        </div>
        <div className="flex items-center gap-1">
          <Button size="xs" variant="outline" className="h-7 text-[11px]" onClick={fetchPresets} disabled={loading} data-testid="presets-refresh">
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          </Button>
          <Button size="xs" className={`h-7 text-[11px] text-white ${themeBtn}`} onClick={() => setSaveOpen(true)} data-testid="presets-save-current">
            <BookmarkPlus className="w-3 h-3 mr-1" /> Save current as preset
          </Button>
        </div>
      </div>

      {saveOpen && (
        <div className="flex items-center gap-2 bg-white border border-slate-200 rounded p-2" data-testid="presets-save-form">
          <Input
            placeholder="Preset name (e.g. Hardware Base)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="h-8 text-xs"
            autoFocus
            data-testid="presets-save-name"
          />
          <Button size="xs" className={`h-8 text-white ${themeBtn}`} onClick={savePreset} disabled={busySlug === '__saving'} data-testid="presets-save-confirm">
            {busySlug === '__saving' ? <RefreshCw className="w-3 h-3 animate-spin" /> : 'Save'}
          </Button>
          <Button size="xs" variant="outline" className="h-8" onClick={() => { setSaveOpen(false); setNewName(''); }}>
            <X className="w-3 h-3" />
          </Button>
        </div>
      )}

      {presets.length === 0 ? (
        <div className="text-[11px] text-slate-400 py-2 text-center">
          No presets yet. Save this Manager&apos;s setup as a preset and re-use it on any other Manager.
        </div>
      ) : (
        <div className="space-y-1 max-h-40 overflow-y-auto">
          {presets.map((p) => (
            <div key={p.slug} className="flex items-center justify-between gap-2 bg-white border border-slate-200 rounded px-2 py-1.5" data-testid={`preset-row-${p.slug}`}>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-slate-800 truncate">{p.name}</div>
                <div className="flex items-center gap-2 text-[10px] text-slate-500">
                  <span className="flex items-center gap-0.5"><Filter className="w-2.5 h-2.5" />{(p.filter_facets || []).length}</span>
                  <span className="flex items-center gap-0.5"><Layers className="w-2.5 h-2.5" />{(p.sub_tabs || []).length}</span>
                  <span className="flex items-center gap-0.5"><Wrench className="w-2.5 h-2.5" />{(p.spec_fields || []).length}</span>
                  {p.source_slug && <span className="italic">from {p.source_slug}</span>}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button size="xs" variant="outline" className="h-7 text-[10px]" onClick={() => applyPreset(p, 'append')} disabled={busySlug === p.slug} data-testid={`preset-apply-append-${p.slug}`} title="Append preset rows — existing rows kept">
                  Append
                </Button>
                <Button size="xs" className={`h-7 text-[10px] text-white ${themeBtn}`} onClick={() => applyPreset(p, 'replace')} disabled={busySlug === p.slug} data-testid={`preset-apply-replace-${p.slug}`} title="Replace all filters/tabs/specs with preset">
                  {busySlug === p.slug ? <RefreshCw className="w-3 h-3 animate-spin" /> : 'Replace'}
                </Button>
                <Button size="xs" variant="ghost" className="h-7 text-red-500 hover:text-red-700 hover:bg-red-50" onClick={() => deletePreset(p)} disabled={busySlug === p.slug} data-testid={`preset-delete-${p.slug}`} title="Delete preset">
                  <Trash2 className="w-3 h-3" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ManagerPresetsBar;

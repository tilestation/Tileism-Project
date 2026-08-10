/**
 * WebsiteGlobalManager — the "🌐 Website" tab of the Managers workspace.
 * Holds the GLOBAL storefront settings that don't belong to one category:
 *   1 · Main Menu        — top navigation bar links (every page)
 *   2 · Labels & Stamps  — NEW / SALE / custom stamps on collection cards
 *   3 · Default Banner   — fallback hero for pages without their own banner
 * Category-specific bits (shop tabs + that page's banner) live inside each
 * Manager via its Storefront button. Same APIs as the old Navigation &
 * Structure page, so data stays fully compatible.
 */
import React, { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { Globe, Menu, Tag, Image as ImageIcon, Trash2, Plus, Store } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import ManagerTabsBar from './components/managers/ManagerTabsBar';
import NavLinksEditor from './components/managers/NavLinksEditor';
import BannerEditorCard from './components/managers/BannerEditorCard';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const LABEL_COLORS = ['emerald', 'red', 'amber', 'purple', 'blue', 'orange', 'green', 'gray'];
const LABEL_CHIP = {
  emerald: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  red: 'bg-red-100 text-red-800 border-red-200',
  amber: 'bg-amber-100 text-amber-800 border-amber-200',
  purple: 'bg-purple-100 text-purple-800 border-purple-200',
  blue: 'bg-blue-100 text-blue-800 border-blue-200',
  orange: 'bg-orange-100 text-orange-800 border-orange-200',
  green: 'bg-green-100 text-green-800 border-green-200',
  gray: 'bg-gray-100 text-gray-800 border-gray-200',
};

const SECTION_ACCENTS = {
  blue:   { box: 'border-blue-100',   head: 'bg-blue-50 border-blue-100',     num: 'bg-blue-600',   icon: 'text-blue-600',   title: 'text-blue-900',   hint: 'text-blue-500' },
  amber:  { box: 'border-amber-100',  head: 'bg-amber-50 border-amber-100',   num: 'bg-amber-600',  icon: 'text-amber-600',  title: 'text-amber-900',  hint: 'text-amber-500' },
  purple: { box: 'border-purple-100', head: 'bg-purple-50 border-purple-100', num: 'bg-purple-600', icon: 'text-purple-600', title: 'text-purple-900', hint: 'text-purple-500' },
};

const Section = ({ number, icon: Icon, title, hint, accent, children, testid }) => {
  const a = SECTION_ACCENTS[accent] || SECTION_ACCENTS.blue;
  return (
    <div className={`border rounded-xl overflow-hidden bg-white ${a.box}`} data-testid={testid}>
      <div className={`px-4 py-3 border-b flex items-center gap-2 ${a.head}`}>
        <span className={`w-6 h-6 rounded-full text-white text-xs font-bold flex items-center justify-center flex-shrink-0 ${a.num}`}>{number}</span>
        <Icon className={`w-4 h-4 ${a.icon}`} />
        <span className={`text-sm font-semibold ${a.title}`}>{title}</span>
        <span className={`text-[11px] ${a.hint}`}>— {hint}</span>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
};

export default function WebsiteGlobalManager() {
  const [mainNav, setMainNav] = useState([]);
  const [navSaving, setNavSaving] = useState(false);
  const [labels, setLabels] = useState({ predefined: [], custom: [] });
  const [newLabel, setNewLabel] = useState({ value: '', label: '', color: 'gray', description: '' });
  const [labelSaving, setLabelSaving] = useState(false);

  const authHeaders = () => {
    const token = localStorage.getItem('token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  const loadAll = async () => {
    try {
      const [navRes, labelsRes] = await Promise.all([
        fetch(`${API_URL}/api/website-admin/navigation/main`, { headers: authHeaders() }),
        fetch(`${API_URL}/api/tiles/labels/available`),
      ]);
      if (navRes.ok) {
        const data = await navRes.json();
        const items = Array.isArray(data) ? data : (data.items || []);
        setMainNav(items.map(it => ({ ...it, url: it.link_url || it.url })));
      }
      if (labelsRes.ok) setLabels(await labelsRes.json());
    } catch {
      toast.error('Failed to load website settings');
    }
  };

  useEffect(() => { loadAll(); }, []);

  const saveMainNav = async () => {
    setNavSaving(true);
    try {
      const formatted = mainNav.map((item, index) => ({
        id: item.id || Date.now().toString() + index,
        label: item.label,
        link_url: item.url || item.link_url,
        display_order: index,
        is_active: item.is_active !== false,
        highlight: item.highlight || false,
        highlight_color: item.highlight_color || null,
      }));
      const res = await fetch(`${API_URL}/api/website-admin/navigation/main`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(formatted),
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); toast.error(err.detail || 'Save failed'); return; }
      toast.success('Main menu saved — live on the website now');
    } catch { toast.error('Save failed'); }
    finally { setNavSaving(false); }
  };

  const addLabel = async () => {
    if (!newLabel.value.trim()) { toast.error('Give the label a name (e.g. BESTSELLER)'); return; }
    setLabelSaving(true);
    try {
      const res = await fetch(`${API_URL}/api/tiles/labels/custom`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(newLabel),
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); toast.error(err.detail || 'Failed to add label'); return; }
      toast.success(`Label "${newLabel.value}" added`);
      setNewLabel({ value: '', label: '', color: 'gray', description: '' });
      await loadAll();
    } catch { toast.error('Failed to add label'); }
    finally { setLabelSaving(false); }
  };

  const deleteLabel = async (value) => {
    if (!window.confirm(`Delete the "${value}" label? Products using it will simply stop showing it.`)) return;
    try {
      await fetch(`${API_URL}/api/tiles/labels/custom/${encodeURIComponent(value)}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      toast.success('Label deleted');
      await loadAll();
    } catch { toast.error('Delete failed'); }
  };

  return (
    <div className="min-h-screen bg-gray-50" data-testid="website-global-manager">
      <ManagerTabsBar active="website" />
      <div className="max-w-5xl mx-auto px-4 py-6 space-y-4">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-emerald-100 text-emerald-600 flex items-center justify-center">
            <Globe className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Website</h1>
            <p className="text-xs text-gray-500">Global site settings — these apply to every page of the website</p>
          </div>
        </div>

        {/* How this works */}
        <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-sm text-emerald-800" data-testid="website-how-it-works">
          <p className="font-medium mb-1">How this page works</p>
          <ul className="list-disc list-inside space-y-0.5 text-[13px]">
            <li><b>Global</b> things live here: the top menu, product labels, and the default banner.</li>
            <li><b>Category</b> things (a page's tabs + its banner) live inside each Manager — open the Manager and hit its <b className="inline-flex items-center gap-1"><Store className="w-3 h-3" />Storefront</b> button.</li>
            <li>Nothing saves until you press a Save button — feel free to explore.</li>
          </ul>
        </div>

        {/* 1 · Main Menu */}
        <Section number={1} icon={Menu} title="Main Menu" hint="the top navigation bar shown on every page" accent="blue" testid="website-main-menu-section">
          <NavLinksEditor items={mainNav} onChange={setMainNav} onSave={saveMainNav} saving={navSaving} noun="link" testPrefix="website-nav" />
        </Section>

        {/* 2 · Labels & Stamps */}
        <Section number={2} icon={Tag} title="Product Labels & Stamps" hint="NEW / SALE stamps shown on collection cards" accent="amber" testid="website-labels-section">
          <div className="space-y-4">
            <div>
              <p className="text-[11px] uppercase tracking-wider font-semibold text-gray-500 mb-2">Built-in labels (always available)</p>
              <div className="flex flex-wrap gap-2">
                {(labels.predefined || []).map(l => (
                  <span key={l.value} className={`px-3 py-1 text-xs font-semibold border rounded ${LABEL_CHIP[l.color] || LABEL_CHIP.gray}`} title={l.description}>
                    {l.value}
                  </span>
                ))}
              </div>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wider font-semibold text-gray-500 mb-2">Your custom labels</p>
              {(labels.custom || []).length === 0 ? (
                <p className="text-sm text-gray-400 italic">No custom labels yet — add one below (e.g. BESTSELLER, TRADE ONLY).</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {labels.custom.map(l => (
                    <span key={l.value} className={`pl-3 pr-1 py-1 text-xs font-semibold border rounded inline-flex items-center gap-1.5 ${LABEL_CHIP[l.color] || 'bg-gray-900 text-white border-gray-900'}`} data-testid={`website-label-${l.value}`}>
                      {l.value}
                      <button type="button" onClick={() => deleteLabel(l.value)} className="p-0.5 hover:bg-black/10 rounded" title="Delete label" data-testid={`website-label-delete-${l.value}`}>
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-end gap-2 pt-2 border-t border-dashed">
              <div>
                <label className="block text-[11px] font-medium text-gray-600 mb-1">Label text</label>
                <Input value={newLabel.value} onChange={(e) => setNewLabel(p => ({ ...p, value: e.target.value.toUpperCase() }))} placeholder="BESTSELLER" className="h-8 text-sm w-36" data-testid="website-new-label-value" />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-gray-600 mb-1">Colour</label>
                <select value={newLabel.color} onChange={(e) => setNewLabel(p => ({ ...p, color: e.target.value }))} className="h-8 text-sm border border-gray-300 rounded px-2 bg-white" data-testid="website-new-label-color">
                  {LABEL_COLORS.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="flex-1 min-w-[160px]">
                <label className="block text-[11px] font-medium text-gray-600 mb-1">Description (optional)</label>
                <Input value={newLabel.description} onChange={(e) => setNewLabel(p => ({ ...p, description: e.target.value }))} placeholder="For our best-selling ranges" className="h-8 text-sm" data-testid="website-new-label-description" />
              </div>
              <Button type="button" size="sm" onClick={addLabel} disabled={labelSaving} className="bg-amber-600 hover:bg-amber-700 text-white" data-testid="website-add-label-btn">
                <Plus className="w-3.5 h-3.5 mr-1" /> Add Label
              </Button>
            </div>
            <p className="text-[11px] text-gray-400">You apply labels to products from the Managers or Supplier Products bulk bar — this list just controls which labels exist.</p>
          </div>
        </Section>

        {/* 3 · Default Banner */}
        <Section number={3} icon={ImageIcon} title="Default Page Banner" hint="fallback hero for any page without its own banner" accent="purple" testid="website-default-banner-section">
          <BannerEditorCard scope="default" pageLabel="the site" testPrefix="website-default-banner" />
          <p className="text-[11px] text-gray-400 mt-2">Each category page can override this — open that category's Manager → <b>Storefront</b> → Page Banner.</p>
        </Section>
      </div>
    </div>
  );
}

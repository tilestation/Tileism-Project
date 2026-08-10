/**
 * NavLinksEditor — tiny reusable list editor for navigation links / shop tabs.
 * Rows: reorder ↑↓ · Label · URL · Active · Delete. Parent owns the items
 * array + save; this stays a pure presentational list.
 */
import React from 'react';
import { ArrowUp, ArrowDown, Trash2, Plus, Save } from 'lucide-react';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Switch } from '../../../../components/ui/switch';

const NavLinksEditor = ({ items, onChange, onSave, saving, noun = 'link', testPrefix = 'nav' }) => {
  const move = (index, dir) => {
    const next = [...items];
    const target = dir === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  const upd = (index, patch) => onChange(items.map((it, i) => (i === index ? { ...it, ...patch } : it)));
  const remove = (index) => onChange(items.filter((_, i) => i !== index));
  const add = () => onChange([...items, { id: Date.now().toString(), label: `New ${noun}`, url: '/', is_active: true }]);

  return (
    <div className="space-y-2" data-testid={`${testPrefix}-links-editor`}>
      {items.length === 0 && (
        <p className="text-sm text-gray-400 italic py-3 text-center">No {noun}s yet — click "+ Add {noun}" below.</p>
      )}
      {items.map((item, index) => (
        <div key={item.id || index} className="flex items-center gap-2 p-2.5 bg-gray-50 rounded-lg border border-gray-100" data-testid={`${testPrefix}-row-${index}`}>
          <div className="flex flex-col flex-shrink-0">
            <button type="button" onClick={() => move(index, 'up')} disabled={index === 0} className="p-0.5 text-gray-400 hover:text-gray-700 disabled:opacity-30" data-testid={`${testPrefix}-up-${index}`}>
              <ArrowUp className="w-3 h-3" />
            </button>
            <button type="button" onClick={() => move(index, 'down')} disabled={index === items.length - 1} className="p-0.5 text-gray-400 hover:text-gray-700 disabled:opacity-30" data-testid={`${testPrefix}-down-${index}`}>
              <ArrowDown className="w-3 h-3" />
            </button>
          </div>
          <Input
            value={item.label || ''}
            onChange={(e) => upd(index, { label: e.target.value })}
            placeholder="Label (what customers see)"
            className="w-40 h-8 text-sm"
            data-testid={`${testPrefix}-label-${index}`}
          />
          <Input
            value={item.url || item.link_url || ''}
            onChange={(e) => upd(index, { url: e.target.value, link_url: e.target.value })}
            placeholder="/shop or /tiles?group=materials"
            className="flex-1 h-8 text-sm font-mono"
            data-testid={`${testPrefix}-url-${index}`}
          />
          <label className="flex items-center gap-1.5 text-xs text-gray-500 flex-shrink-0" title="Off = hidden from customers without deleting it">
            <Switch
              checked={item.is_active !== false}
              onCheckedChange={(v) => upd(index, { is_active: v })}
              data-testid={`${testPrefix}-active-${index}`}
            />
            Live
          </label>
          <button type="button" onClick={() => remove(index)} className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded flex-shrink-0" title="Delete" data-testid={`${testPrefix}-delete-${index}`}>
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2 pt-1">
        <Button type="button" variant="outline" size="sm" onClick={add} data-testid={`${testPrefix}-add-btn`}>
          <Plus className="w-3.5 h-3.5 mr-1" /> Add {noun}
        </Button>
        <Button type="button" size="sm" onClick={onSave} disabled={saving} className="bg-emerald-600 hover:bg-emerald-700 text-white" data-testid={`${testPrefix}-save-btn`}>
          <Save className="w-3.5 h-3.5 mr-1" /> {saving ? 'Saving…' : `Save ${noun}s`}
        </Button>
        <span className="text-[11px] text-gray-400">Changes go live only after you press Save.</span>
      </div>
    </div>
  );
};

export default NavLinksEditor;

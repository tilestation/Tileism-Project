/**
 * DataHealthCard — admin-dashboard card for catalogue data hygiene:
 *   • products with no photos, per group, deep-linking to the matching
 *     Manager with the "no photos" filter pre-enabled (?noimages=1)
 *   • one-click "Trim stray spaces" cleanup across all name fields
 */
import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ImageOff, CheckCircle2, Eraser, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const GROUP_ROUTES = {
  tiles: '/admin/tiles',
  materials: '/admin/materials',
  flooring: '/admin/flooring',
  bathroom: '/admin/bathroom',
  underfloor_heating: '/admin/underfloor-heating',
  'underfloor-heating': '/admin/underfloor-heating',
  tools: '/admin/tools',
};

export const DataHealthCard = () => {
  const [data, setData] = useState(null);
  const [trimming, setTrimming] = useState(false);

  const load = useCallback(() => {
    fetch(`${API_URL}/api/supplier-sync/products/data-health`)
      .then(res => (res.ok ? res.json() : null))
      .then(setData)
      .catch(() => setData(null));
  }, []);

  useEffect(() => { load(); }, [load]);

  const runTrim = async () => {
    setTrimming(true);
    try {
      const res = await fetch(`${API_URL}/api/supplier-sync/products/trim-names`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const r = await res.json();
      toast.success(
        r.total_fixed > 0
          ? `Cleaned ${r.total_fixed} record${r.total_fixed !== 1 ? 's' : ''}${r.examples?.length ? ` — e.g. ${r.examples[0]}` : ''}`
          : 'No stray spaces found — names are already clean'
      );
      load();
    } catch (err) {
      toast.error(`Cleanup failed: ${err.message}`);
    } finally {
      setTrimming(false);
    }
  };

  if (!data) return null;

  const allClean = data.missing_images_total === 0 && data.untrimmed_names === 0;
  if (allClean) {
    return (
      <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-50 border border-emerald-200 text-sm text-emerald-700" data-testid="data-health-card">
        <CheckCircle2 className="w-4 h-4" />
        Catalogue data healthy — every product has photos and clean names.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-rose-200 bg-rose-50/60 px-4 py-3" data-testid="data-health-card">
      {data.missing_images_total > 0 && (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            <ImageOff className="w-4 h-4 text-rose-600 flex-shrink-0" />
            <span className="text-sm font-semibold text-rose-900" data-testid="data-health-missing-images">
              {data.missing_images_total} of {data.total_products} products have no photos
            </span>
            <span className="text-xs text-rose-500">— click a category, then use Edit to drop images in:</span>
          </div>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {data.missing_images_by_group.map(({ group, count }) => {
              const route = GROUP_ROUTES[group];
              const label = `${group.replace(/[_-]/g, ' ')} · ${count}`;
              return route ? (
                <Link
                  key={group}
                  to={`${route}?noimages=1`}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white border border-rose-300 text-rose-800 text-xs font-medium hover:bg-rose-100 transition-colors capitalize"
                  data-testid={`noimages-link-${group}`}
                >
                  <ImageOff className="w-3 h-3" />
                  {label}
                </Link>
              ) : (
                <span key={group} className="inline-flex px-2.5 py-1 rounded-full bg-white/60 border border-rose-200 text-rose-600 text-xs capitalize" title="Manage from All Products" data-testid={`noimages-chip-${group}`}>
                  {label}
                </span>
              );
            })}
          </div>
        </>
      )}
      {data.untrimmed_names > 0 && (
        <div className={`flex items-center gap-2 flex-wrap ${data.missing_images_total > 0 ? 'mt-3 pt-3 border-t border-rose-200/60' : ''}`}>
          <Eraser className="w-4 h-4 text-rose-600 flex-shrink-0" />
          <span className="text-sm text-rose-900" data-testid="data-health-untrimmed">
            <b>{data.untrimmed_names}</b> product name{data.untrimmed_names !== 1 ? 's have' : ' has'} stray spaces (e.g. &quot;&nbsp;Xtreme Cleaner&quot;)
          </span>
          <button
            type="button"
            onClick={runTrim}
            disabled={trimming}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-rose-600 text-white text-xs font-semibold hover:bg-rose-700 transition-colors disabled:opacity-50"
            data-testid="trim-names-btn"
          >
            {trimming ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Eraser className="w-3 h-3" />}
            {trimming ? 'Cleaning…' : 'Trim stray spaces'}
          </button>
        </div>
      )}
    </div>
  );
};

export default DataHealthCard;

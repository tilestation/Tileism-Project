import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { useCompare } from '../../contexts/CompareContext';
import { Button } from '../ui/button';
import { X, GitCompare } from 'lucide-react';
import { normaliseImageUrl } from '../../utils/safeStr';

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;

/** Read-only feature flag — hidden if compare is disabled in the storefront-features admin. */
function useCompareEnabled() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    axios.get(`${API}/storefront-features/public`)
      .then(res => { if (!cancelled) setEnabled(!!res.data?.compare_enabled); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return enabled;
}

export default function CompareTray() {
  const { items, remove, clear, max } = useCompare();
  const enabled = useCompareEnabled();

  if (!enabled) return null;
  if (!items || items.length === 0) return null;

  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-40 bg-white border-t border-gray-200 shadow-lg"
      data-testid="compare-tray"
    >
      <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3">
        <div className="flex items-center gap-2 text-gray-700 shrink-0">
          <GitCompare className="w-4 h-4 text-emerald-600" />
          <span className="font-semibold text-sm">Compare</span>
          <span className="text-xs text-gray-400">({items.length} of {max})</span>
        </div>

        <div className="flex-1 flex items-center gap-2 overflow-x-auto">
          {items.map(t => (
            <div
              key={t.slug}
              className="flex items-center gap-2 bg-gray-50 border rounded-lg pl-2 pr-1 py-1 shrink-0"
              data-testid={`compare-tray-item-${t.slug}`}
            >
              {t.image
                ? <img src={normaliseImageUrl(t.image)} alt="" className="w-9 h-9 rounded object-cover" />
                : <div className="w-9 h-9 rounded bg-gray-200" />}
              <span className="text-xs font-medium text-gray-700 max-w-[140px] truncate">{t.name}</span>
              <button
                onClick={() => remove(t.slug)}
                className="text-gray-400 hover:text-red-600 p-1"
                aria-label="Remove"
                data-testid={`compare-tray-remove-${t.slug}`}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={clear}
            className="text-xs text-gray-500 hover:text-gray-800 underline"
            data-testid="compare-tray-clear"
          >
            Clear
          </button>
          <Button asChild size="sm" disabled={items.length < 2} data-testid="compare-tray-go">
            <Link to="/shop/compare">Compare {items.length} →</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}

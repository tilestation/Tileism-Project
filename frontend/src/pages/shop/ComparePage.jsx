import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { useCompare } from '../../contexts/CompareContext';
import { Button } from '../../components/ui/button';
import { Card, CardContent } from '../../components/ui/card';
import { GitCompare, X, ArrowLeft } from 'lucide-react';
import { normaliseImageUrl } from '../../utils/safeStr';

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;

const SPECS = [
  { key: 'price', label: 'Price', format: (v) => v ? `£${Number(v).toFixed(2)}` : '—' },
  { key: 'size', label: 'Size' },
  { key: 'finish', label: 'Finish' },
  { key: 'material', label: 'Material' },
  { key: 'color', label: 'Colour' },
  { key: 'usage', label: 'Suitable for' },
  { key: 'thickness', label: 'Thickness' },
  { key: 'pcs_per_box', label: 'Per box' },
  { key: 'm2_per_box', label: 'm² per box' },
  { key: 'weight_per_box', label: 'Weight / box (kg)' },
  { key: 'rectified', label: 'Rectified', format: (v) => v === true ? 'Yes' : v === false ? 'No' : '—' },
  { key: 'slip_rating', label: 'Slip rating' },
  { key: 'origin', label: 'Origin' },
];

function valueOf(tile, key) {
  if (!tile) return '';
  // Try several common shapes
  return (
    tile[key]
    ?? tile.attributes?.[key]
    ?? tile.specs?.[key]
    ?? tile.specifications?.[key]
    ?? ''
  );
}

export default function ComparePage() {
  const { items, remove, clear, max } = useCompare();
  const [tiles, setTiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    axios.get(`${API}/storefront-features/public`)
      .then(res => setEnabled(!!res.data?.compare_enabled))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (items.length === 0) { setTiles([]); setLoading(false); return; }
    setLoading(true);
    Promise.all(items.map(i =>
      axios.get(`${API}/tiles/products/${encodeURIComponent(i.slug)}`)
        .then(r => r.data)
        .catch(() => i) // fallback to the lite tray data
    )).then(results => { if (!cancelled) setTiles(results); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [items]);

  if (!enabled) {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-500">
        Compare is currently disabled.
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-32" data-testid="compare-page">
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between gap-3 mb-6 flex-wrap">
          <div className="flex items-center gap-3">
            <GitCompare className="w-7 h-7 text-emerald-600" />
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Compare tiles</h1>
              <p className="text-sm text-gray-500">{items.length} of {max} side-by-side</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" data-testid="compare-back">
              <Link to="/shop/tiles"><ArrowLeft className="w-4 h-4 mr-1" /> Keep browsing</Link>
            </Button>
            {items.length > 0 && (
              <Button variant="outline" onClick={clear} data-testid="compare-clear">Clear all</Button>
            )}
          </div>
        </div>

        {loading && <p className="text-sm text-gray-400 p-6">Loading…</p>}

        {!loading && items.length === 0 && (
          <Card>
            <CardContent className="p-12 text-center">
              <GitCompare className="w-10 h-10 mx-auto text-gray-300 mb-3" />
              <h2 className="text-lg font-semibold mb-1">Nothing to compare yet</h2>
              <p className="text-sm text-gray-500 mb-4">Browse tiles and tap the Compare button to add up to {max} side-by-side.</p>
              <Button asChild>
                <Link to="/shop/tiles">Browse tiles</Link>
              </Button>
            </CardContent>
          </Card>
        )}

        {!loading && tiles.length > 0 && (
          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className="text-left p-4 w-44 bg-gray-50 sticky left-0 z-10"></th>
                    {tiles.map((t, i) => (
                      <th key={i} className="p-4 align-top min-w-[220px] border-l">
                        <div className="relative">
                          <button
                            onClick={() => remove(items[i].slug)}
                            className="absolute -top-2 -right-2 w-7 h-7 bg-white border rounded-full text-gray-400 hover:text-red-600 flex items-center justify-center shadow-sm"
                            aria-label="Remove"
                            data-testid={`compare-remove-${items[i].slug}`}
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                          <Link
                            to={`/shop/tiles/${items[i].slug}`}
                            className="block group"
                            data-testid={`compare-tile-link-${items[i].slug}`}
                          >
                            {(t.image_url || t.image || items[i].image)
                              ? <img src={normaliseImageUrl(t.image_url || t.image || items[i].image)} alt="" className="w-full aspect-square object-cover rounded-lg group-hover:opacity-90" />
                              : <div className="w-full aspect-square rounded-lg bg-gray-200" />}
                            <p className="font-semibold text-gray-900 mt-3 text-left">{t.product_name || t.name || items[i].name}</p>
                            {(t.price || items[i].price) && (
                              <p className="text-emerald-700 font-bold text-base text-left mt-1">£{Number(t.price || items[i].price).toFixed(2)}</p>
                            )}
                          </Link>
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {SPECS.map(spec => (
                    <tr key={spec.key} className="border-t">
                      <td className="p-3 font-medium text-gray-600 bg-gray-50/50 sticky left-0 z-10">{spec.label}</td>
                      {tiles.map((t, i) => {
                        const raw = valueOf(t, spec.key);
                        const display = spec.format ? spec.format(raw) : (raw || '—');
                        return (
                          <td key={i} className="p-3 border-l text-gray-800">
                            {display === '' ? '—' : display}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

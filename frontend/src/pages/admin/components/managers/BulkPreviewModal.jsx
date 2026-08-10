/**
 * BulkPreviewModal — live storefront preview of the selected products'
 * landing pages, opened from the Manager bulk bar next to Publish.
 * Shows this PREVIEW environment's storefront in an iframe (same origin),
 * with a series switcher when the selection spans multiple series and
 * desktop / tablet / mobile device toggles.
 */
import React, { useState, useMemo, useEffect } from 'react';
import { Eye, Monitor, Tablet, Smartphone, RefreshCw, ExternalLink, AlertTriangle } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '../../../../components/ui/dialog';
import { getSeriesName } from '../../lib/series';

const DEVICES = [
  { key: 'desktop', width: '100%', Icon: Monitor, label: 'Desktop' },
  { key: 'tablet', width: '768px', Icon: Tablet, label: 'Tablet' },
  { key: 'mobile', width: '375px', Icon: Smartphone, label: 'Mobile' },
];

const BulkPreviewModal = ({ open, onOpenChange, selectedProducts = [] }) => {
  // Unique landing pages from the selection (one per series).
  const seriesList = useMemo(() => {
    const map = new Map();
    selectedProducts.forEach(p => {
      const series = (getSeriesName(p) || p.display_name || p.name || '').trim();
      if (series && !map.has(series.toLowerCase())) {
        // The storefront resolves collections by the RAW series name (spaces
        // intact, URI-encoded) — never dash-slugified.
        map.set(series.toLowerCase(), { name: series, slug: series });
      }
    });
    return [...map.values()];
  }, [selectedProducts]);

  const unpublished = useMemo(
    () => selectedProducts.filter(p => !p.published),
    [selectedProducts]
  );

  const [activeSlug, setActiveSlug] = useState(null);
  const [device, setDevice] = useState('desktop');
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (open) {
      setActiveSlug(seriesList[0]?.slug || null);
      setDevice('desktop');
      setLoading(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const url = activeSlug ? `${window.location.origin}/shop/collection/${encodeURIComponent(activeSlug)}?preview=1` : null;
  const deviceWidth = DEVICES.find(d => d.key === device)?.width || '100%';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl w-[95vw] h-[90vh] flex flex-col p-0 gap-0" data-testid="bulk-preview-modal">
        <DialogHeader className="px-4 pt-4 pb-2 flex-shrink-0">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Eye className="w-4 h-4 text-indigo-600" />
            Landing Page Preview
            <span className="ml-auto flex items-center gap-1">
              <span className="flex items-center bg-gray-100 rounded-lg p-0.5">
                {DEVICES.map(({ key, Icon, label }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setDevice(key)}
                    className={`p-1.5 rounded-md transition-colors ${device === key ? 'bg-white shadow-sm text-indigo-600' : 'text-gray-400 hover:text-gray-600'}`}
                    title={label}
                    data-testid={`bulk-preview-device-${key}`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                  </button>
                ))}
              </span>
              <button
                type="button"
                onClick={() => { setRefreshKey(k => k + 1); setLoading(true); }}
                className="p-1.5 rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                title="Refresh"
                data-testid="bulk-preview-refresh"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
              {url && (
                <a href={url} target="_blank" rel="noopener noreferrer" className="p-1.5 rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-600" title="Open in new tab" data-testid="bulk-preview-open-tab">
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              )}
            </span>
          </DialogTitle>
          <DialogDescription className="text-xs">
            This is <b>this preview environment's</b> storefront — exactly what customers will get once you deploy.
            Unpublished products won't appear until you hit Publish.
          </DialogDescription>
        </DialogHeader>

        {/* Unpublished changes warning */}
        {unpublished.length > 0 && (
          <div className="mx-4 mb-2 px-3 py-2 rounded-lg border border-amber-200 bg-amber-50 flex-shrink-0" data-testid="bulk-preview-unpublished-badge">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-800">
              <AlertTriangle className="w-3.5 h-3.5" />
              {unpublished.length} selected {unpublished.length === 1 ? 'product has' : 'products have'} changes not yet published — {unpublished.length === 1 ? 'it' : 'they'} won't appear in this preview
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1" data-testid="bulk-preview-unpublished-list">
              {unpublished.slice(0, 8).map(p => (
                <span
                  key={p.sku || p.supplier_code || p._id}
                  className="px-2 py-0.5 rounded-full bg-white border border-amber-200 text-[11px] text-amber-700"
                >
                  {p.our_product_name || p.product_name || p.display_name || p.name || p.sku}
                </span>
              ))}
              {unpublished.length > 8 && (
                <span className="px-2 py-0.5 text-[11px] text-amber-600 font-medium">+{unpublished.length - 8} more</span>
              )}
            </div>
          </div>
        )}

        {/* Series switcher */}
        {seriesList.length > 1 && (
          <div className="px-4 pb-2 flex flex-wrap gap-1.5 flex-shrink-0" data-testid="bulk-preview-series-chips">
            {seriesList.map(s => (
              <button
                key={s.slug}
                type="button"
                onClick={() => { setActiveSlug(s.slug); setLoading(true); }}
                className={`px-2.5 py-1 rounded-full border text-xs font-medium transition-colors ${activeSlug === s.slug ? 'bg-indigo-600 border-indigo-600 text-white' : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50'}`}
                data-testid={`bulk-preview-series-${s.slug}`}
              >
                {s.name}
              </button>
            ))}
          </div>
        )}

        {/* Iframe area */}
        <div className="flex-1 bg-gray-100 flex items-start justify-center overflow-auto p-2 min-h-0">
          {!url ? (
            <p className="text-sm text-gray-400 mt-10">No series detected in the selection.</p>
          ) : (
            <div className="bg-white shadow-lg rounded-lg overflow-hidden h-full relative transition-all duration-300" style={{ width: deviceWidth, maxWidth: '100%' }}>
              {loading && (
                <div className="absolute inset-0 flex items-center justify-center bg-white z-10">
                  <RefreshCw className="w-5 h-5 animate-spin text-indigo-400" />
                </div>
              )}
              <iframe
                key={`${activeSlug}-${refreshKey}`}
                src={url}
                className="w-full h-full border-0 block"
                title="Landing page preview"
                onLoad={() => setLoading(false)}
                data-testid="bulk-preview-iframe"
              />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default BulkPreviewModal;

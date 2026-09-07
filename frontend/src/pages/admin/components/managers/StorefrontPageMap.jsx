/**
 * StorefrontPageMap — plain-English "where do these products appear on the
 * website?" card shown on each Manager page. Reads the live shop-tab
 * destinations plus the products already loaded by the Manager, so every
 * number is real (how many sit under each tab, how many have no tab, how
 * many are live / featured / on clearance).
 */
import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Map, ChevronDown, ChevronRight, ExternalLink, Star, Flame, Tag, EyeOff, Layers, Search } from 'lucide-react';
import { filterShopTabPagesForManager, resolveShopGroupSlug } from '../../lib/shopTabDestinations';
import { getSeriesName } from '../../lib/series';

const subcats = (p) => (Array.isArray(p?.sub_categories) ? p.sub_categories : []).map(s => String(s).toLowerCase());
const hasLabel = (p, name) => [...(p?.labels || []), ...(p?.custom_labels || [])]
  .some(l => String(l?.name ?? l).toLowerCase() === name);

const StorefrontPageMap = ({ managerSlug, managerTitle, products = [], pages = null, onShowGaps, themeCls }) => {
  const storageKey = `tsm_pagemap_open_${managerSlug}`;
  const [open, setOpen] = useState(() => localStorage.getItem(storageKey) === '1');
  const toggle = () => { setOpen(o => { localStorage.setItem(storageKey, o ? '0' : '1'); return !o; }); };

  const groupSlug = resolveShopGroupSlug(managerSlug);
  const page = useMemo(() => filterShopTabPagesForManager(pages || [], managerSlug)[0] || null, [pages, managerSlug]);
  const pageUrl = groupSlug === 'tiles' ? '/tiles' : `/tiles?group=${groupSlug}`;
  const pageName = page?.group_name || (managerTitle || '').replace(/ Manager$/i, '');

  const stats = useMemo(() => {
    const tabs = (page?.tabs || []).filter(t => t.assignable && t.category_name);
    const tabKeys = new Set(tabs.map(t => t.category_name.toLowerCase()));
    const tabCounts = tabs.map(t => ({
      ...t,
      count: products.filter(p => subcats(p).includes(t.category_name.toLowerCase())).length,
    }));
    const noTab = tabs.length ? products.filter(p => !subcats(p).some(sc => tabKeys.has(sc))).length : 0;
    const live = products.filter(p => p.published || p.show_on_website).length;
    const featured = products.filter(p => p.is_featured).length;
    const clearance = products.filter(p => hasLabel(p, 'clearance')).length;
    const sale = products.filter(p => p.sale_active).length;
    const series = new Set(products.map(p => String(getSeriesName(p) || '').trim()).filter(Boolean));
    const sample = products.find(p => (p.published || p.show_on_website) && getSeriesName(p));
    return { tabCounts, noTab, live, featured, clearance, sale, seriesCount: series.size, sampleSeries: sample ? String(getSeriesName(sample)) : null };
  }, [products, page]);

  const total = products.length;
  const Ext = ({ to, children, testid }) => (
    <a href={to} target="_blank" rel="noopener noreferrer" data-testid={testid}
      className="inline-flex items-center gap-1 font-semibold underline underline-offset-2 decoration-dotted hover:decoration-solid">
      {children}<ExternalLink className="w-3 h-3 opacity-60" />
    </a>
  );

  return (
    <div className={`rounded-lg border text-sm ${themeCls?.banner || 'bg-slate-50 border-slate-200 text-slate-800'}`} data-testid={`${managerSlug}-page-map`}>
      <button type="button" onClick={toggle} className="w-full flex items-center gap-2 p-3 text-left" data-testid={`${managerSlug}-page-map-toggle`} aria-expanded={open}>
        <Map className="w-4 h-4 flex-shrink-0" />
        <span className="font-medium">Where these products appear on the website</span>
        <span className="ml-auto text-xs opacity-80 hidden sm:inline" data-testid={`${managerSlug}-page-map-summary`}>
          {pageName} page · {stats.tabCounts.length} tab{stats.tabCounts.length !== 1 ? 's' : ''} · {stats.live} of {total} live
        </span>
        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
      </button>

      {open && (
        <ol className="px-3 pb-3 space-y-3 text-xs" data-testid={`${managerSlug}-page-map-body`}>
          <li className="flex gap-2.5">
            <span className="w-5 h-5 rounded-full bg-white/80 border flex items-center justify-center font-bold flex-shrink-0">1</span>
            <div className="space-y-1.5 min-w-0">
              <p>
                Every <strong>published</strong> product here lands on the{' '}
                <Ext to={pageUrl} testid={`${managerSlug}-page-map-shop-link`}>{pageName} page</Ext>.
                {stats.tabCounts.length > 0 && ' Customers narrow it down with the tabs across the top of that page:'}
              </p>
              {stats.tabCounts.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {stats.tabCounts.map(t => (
                    <a key={t.category_name} href={t.url || pageUrl} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white border border-black/15 hover:border-black/50"
                      data-testid={`${managerSlug}-page-map-tab-${t.category_slug}`}>
                      {t.label}<span className="font-bold">{t.count}</span>
                    </a>
                  ))}
                </div>
              )}
              {stats.tabCounts.length > 0 && (
                <p className="opacity-90">
                  A product shows under a tab when that tab is ticked in <strong>Shop Tabs</strong> (Edit → Shop Tabs, or tick rows → Shop Tabs).{' '}
                  {stats.noTab > 0 ? (
                    <>
                      <strong data-testid={`${managerSlug}-page-map-notab-count`}>{stats.noTab}</strong> product{stats.noTab !== 1 ? 's' : ''} {stats.noTab !== 1 ? 'have' : 'has'} no tab yet — customers only find {stats.noTab !== 1 ? 'them' : 'it'} via "All" or search.{' '}
                      {onShowGaps && (
                        <button type="button" onClick={onShowGaps} className="underline font-semibold" data-testid={`${managerSlug}-page-map-show-gaps`}>Show them</button>
                      )}
                    </>
                  ) : <span data-testid={`${managerSlug}-page-map-notab-count`}>Every product is on at least one tab.</span>}
                </p>
              )}
            </div>
          </li>

          <li className="flex gap-2.5">
            <span className="w-5 h-5 rounded-full bg-white/80 border flex items-center justify-center font-bold flex-shrink-0">2</span>
            <p className="min-w-0">
              <Layers className="w-3 h-3 inline mr-1 -mt-0.5" />
              Products that share a <strong>Series</strong> are grouped into ONE card and ONE product page (<code className="bg-white/70 px-1 rounded">/shop/collection/&lt;Series&gt;</code>) with colour, finish and size swatches —{' '}
              <strong>{stats.seriesCount}</strong> series in this manager.
              {stats.sampleSeries && <> Example: <Ext to={`/shop/collection/${encodeURIComponent(stats.sampleSeries)}`} testid={`${managerSlug}-page-map-sample-series`}>{stats.sampleSeries}</Ext>.</>}
              {' '}Change a row's Series to move it onto a different card.
            </p>
          </li>

          <li className="flex gap-2.5">
            <span className="w-5 h-5 rounded-full bg-white/80 border flex items-center justify-center font-bold flex-shrink-0">3</span>
            <div className="min-w-0">
              <p className="mb-1">Also appears in:</p>
              <ul className="space-y-0.5">
                <li><Star className="w-3 h-3 inline mr-1 -mt-0.5 text-amber-500" /><Ext to="/" >Homepage</Ext> → Featured Collections when <strong>Featured</strong> is ticked — <strong>{stats.featured}</strong> featured.</li>
                <li><Flame className="w-3 h-3 inline mr-1 -mt-0.5 text-red-500" /><Ext to="/tiles?clearance=true">Clearance page</Ext> when labelled Clearance <em>and</em> published — <strong>{stats.clearance}</strong> labelled (manage in <Link to="/admin/clearance" className="underline font-semibold">Clearance Hub</Link>).</li>
                <li><Tag className="w-3 h-3 inline mr-1 -mt-0.5 text-rose-500" /><Ext to="/tiles?sale=true">Sale filter</Ext> when <strong>Sale is active</strong> — <strong>{stats.sale}</strong> on sale.</li>
                <li><Search className="w-3 h-3 inline mr-1 -mt-0.5" />Site search, "Recently Viewed" strips and Google — every published product.</li>
              </ul>
            </div>
          </li>

          <li className="flex gap-2.5">
            <span className="w-5 h-5 rounded-full bg-white/80 border flex items-center justify-center font-bold flex-shrink-0">4</span>
            <p className="min-w-0">
              <EyeOff className="w-3 h-3 inline mr-1 -mt-0.5" />
              <strong>Drafts are invisible to customers.</strong> <span data-testid={`${managerSlug}-page-map-live-count`}>{stats.live} of {total}</span> products here are live right now
              {total - stats.live > 0 && <> — the other <strong>{total - stats.live}</strong> only exist in this manager until you tick them and hit <strong>Publish</strong> in the bulk bar</>}.
            </p>
          </li>
        </ol>
      )}
    </div>
  );
};

export default StorefrontPageMap;

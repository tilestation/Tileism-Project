import React, { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Search as SearchIcon, ArrowLeft, AlertTriangle } from 'lucide-react';
import { ShopHeader, ShopFooter } from './TileStationHome';
import SeoHead from '../../components/seo/SeoHead';

const API_URL = process.env.REACT_APP_BACKEND_URL;
// 14 May 2026 — hard ceiling so search never appears to hang. The
// backend usually responds in 200-400ms; if a cold start (Railway) or
// network blip takes it past 15s we surface a friendly retry state
// rather than spinning forever ("Searching the catalogue…" hang
// reported by user on 14 May 2026).
const SEARCH_TIMEOUT_MS = 15000;

/**
 * ShopSearchResultsPage — the storefront's unified "All Products" search view.
 *
 * Prior to this page, every header search navigated to `/tiles?search=…`
 * (the collection-grouped Tile Collections page). Tiles + flooring are the
 * only product types that live inside "collections" — tools, grouts,
 * accessories, underfloor-heating kits etc. never surfaced. Customers
 * searching "grout", "spacers", "backer board" saw "0 collections found".
 *
 * This page hits `GET /api/shop/search-all` which searches BOTH `tiles`
 * and `products` and returns a flat result set with a `type` discriminator
 * so we can render one grid while still routing clicks to the correct
 * product detail page per type.
 */
const ShopSearchResultsPage = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const q = (searchParams.get('q') || searchParams.get('search') || '').trim();
  const page = parseInt(searchParams.get('page') || '1', 10) || 1;

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  // Tracks fetch failure / timeout so we can show a retry banner
  // instead of an indefinite spinner. Reset on every new query.
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!q) { setData(null); return; }
    let alive = true;
    setLoading(true);
    setError(null);
    // Abort the request if the backend takes longer than the ceiling.
    // Without this, a stuck fetch left the UI permanently on
    // "Searching the catalogue…".
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    (async () => {
      try {
        const res = await fetch(
          `${API_URL}/api/shop/search-all?q=${encodeURIComponent(q)}&page=${page}&limit=24`,
          { signal: controller.signal }
        );
        const json = await res.json();
        if (alive) setData(json);
        // Log the search for admin insights / SEO keyword mining.
        // Fire-and-forget; never block the UI on this call.
        try {
          let sid = sessionStorage.getItem('ts_search_sid');
          if (!sid) {
            sid = Math.random().toString(36).slice(2, 18);
            sessionStorage.setItem('ts_search_sid', sid);
          }
          const body = JSON.stringify({
            q,
            total: json?.total || 0,
            tile_count: json?.counts_by_type?.tile || 0,
            product_count: json?.counts_by_type?.product || 0,
            suggestions: json?.suggestions || [],
            session_id: sid,
          });
          if (navigator.sendBeacon) {
            navigator.sendBeacon(
              `${API_URL}/api/shop/search-log`,
              new Blob([body], { type: 'application/json' }),
            );
          } else {
            fetch(`${API_URL}/api/shop/search-log`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body,
              keepalive: true,
            }).catch(() => {});
          }
        } catch (_) { /* analytics must never break UX */ }
      } catch (e) {
        if (alive) {
          // AbortError = timeout; everything else = network/fetch error.
          // Either way, show the retry state instead of a stuck spinner.
          setError(e?.name === 'AbortError' ? 'timeout' : 'network');
          setData({ results: [], total: 0, total_pages: 0, counts_by_type: { tile: 0, product: 0 }, suggestions: [] });
        }
      } finally {
        clearTimeout(timeoutId);
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; controller.abort(); clearTimeout(timeoutId); };
  }, [q, page]);

  const results = data?.results || [];
  const total = data?.total || 0;
  const totalPages = data?.total_pages || 0;
  const counts = data?.counts_by_type || { tile: 0, product: 0 };

  const goToPage = (p) => {
    const next = new URLSearchParams(searchParams);
    next.set('page', String(p));
    setSearchParams(next, { replace: false });
  };

  const pageWindow = useMemo(() => {
    if (totalPages <= 1) return [];
    const start = Math.max(1, page - 2);
    const end = Math.min(totalPages, page + 2);
    const out = [];
    for (let i = start; i <= end; i += 1) out.push(i);
    return out;
  }, [page, totalPages]);

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <SeoHead
        title={q ? `${q} — Search Results` : 'Search · Tile Station'}
        description={
          q
            ? `Search results for "${q}" at Tile Station — premium tiles, accessories and tools with free UK delivery on orders over £500.`
            : 'Search the full Tile Station catalogue — tiles, grout, adhesives, underfloor heating and tools.'
        }
        canonical="/shop/search"
        noindex
      />
      <ShopHeader />
      <main className="flex-1 container mx-auto px-4 sm:px-6 py-8" data-testid="shop-search-page">
        <div className="mb-6">
          <Link
            to="/tiles"
            className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900"
            data-testid="search-back-to-tiles"
          >
            <ArrowLeft className="w-4 h-4" /> Back to all tiles
          </Link>
          <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-3xl sm:text-4xl font-heading font-bold text-gray-900 flex items-center gap-2">
                <SearchIcon className="w-7 h-7 text-[#F7EA1C]" />
                All Products
              </h1>
              {q && (
                <p className="text-sm text-gray-600 mt-1">
                  Results for “<span className="font-semibold text-gray-900">{q}</span>”
                  {!loading && data && (
                    <span className="text-gray-500">
                      {' '}· {total} item{total === 1 ? '' : 's'}
                      {counts.tile > 0 && <> · {counts.tile} tile{counts.tile === 1 ? '' : 's'}</>}
                      {counts.product > 0 && <> · {counts.product} accessor{counts.product === 1 ? 'y' : 'ies'}</>}
                    </span>
                  )}
                </p>
              )}
            </div>
          </div>
        </div>

        {!q && (
          <div className="py-20 text-center text-gray-500" data-testid="search-empty-query">
            <SearchIcon className="w-10 h-10 mx-auto mb-2 text-gray-300" />
            <p>Type a search term in the header above to find tiles, tools, accessories and more.</p>
          </div>
        )}

        {q && error && (
          <div
            className="mb-6 flex items-center gap-3 p-4 rounded-lg bg-amber-50 border border-amber-300"
            data-testid="search-error-banner"
          >
            <AlertTriangle className="w-5 h-5 text-amber-700 flex-shrink-0" />
            <div className="flex-1 text-sm text-amber-900">
              {error === 'timeout'
                ? 'The catalogue is taking longer than usual to respond. Please try again.'
                : 'We couldn’t reach the catalogue just now. Check your connection and try again.'}
            </div>
            <button
              type="button"
              onClick={() => {
                // Trigger a re-fetch by bumping a meaningless URL param
                // — simpler than threading a refetch callback.
                const next = new URLSearchParams(searchParams);
                next.set('r', Date.now().toString());
                setSearchParams(next, { replace: true });
              }}
              className="px-3 py-1.5 rounded-full bg-amber-900 text-white text-xs font-semibold hover:bg-amber-800"
              data-testid="search-retry-btn"
            >
              Retry
            </button>
          </div>
        )}

        {q && loading && !data && (
          // Skeleton grid (14 May 2026) — replaces the centred
          // "Searching the catalogue…" text. Feels MUCH faster because
          // the page paints something immediately rather than a single
          // spinner. Same shape as the real result grid so there's no
          // layout shift when results land.
          <div
            className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 sm:gap-6"
            data-testid="search-skeleton-grid"
            aria-busy="true"
            aria-label="Searching the catalogue"
          >
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="rounded-lg overflow-hidden border border-gray-200 bg-white">
                <div className="aspect-square bg-gray-100 animate-pulse" />
                <div className="p-3 space-y-2">
                  <div className="h-3 w-3/4 bg-gray-100 animate-pulse rounded" />
                  <div className="h-3 w-1/2 bg-gray-100 animate-pulse rounded" />
                  <div className="h-4 w-1/3 bg-gray-100 animate-pulse rounded mt-3" />
                </div>
              </div>
            ))}
          </div>
        )}

        {q && !loading && total === 0 && !error && (
          <div className="py-20 text-center" data-testid="search-no-results">
            <SearchIcon className="w-10 h-10 mx-auto mb-2 text-gray-300" />
            <h2 className="text-lg font-semibold text-gray-900">No products match “{q}”</h2>
            <p className="text-gray-500 mt-1 max-w-md mx-auto text-sm">
              Try a shorter term, check the spelling, or browse our full range via the top navigation.
            </p>
            {(data?.suggestions?.length > 0) && (
              <div className="mt-6 max-w-lg mx-auto" data-testid="search-suggestions">
                <p className="text-sm text-gray-600 mb-2">Did you mean:</p>
                <div className="flex flex-wrap gap-2 justify-center">
                  {data.suggestions.map((s) => (
                    <button
                      key={s}
                      onClick={() => {
                        // Attribute the click to the most-recent log row.
                        try {
                          const sid = sessionStorage.getItem('ts_search_sid');
                          const body = JSON.stringify({ from_query: q, clicked: s, session_id: sid });
                          if (navigator.sendBeacon) {
                            navigator.sendBeacon(
                              `${API_URL}/api/shop/search-log/click-suggestion`,
                              new Blob([body], { type: 'application/json' }),
                            );
                          } else {
                            fetch(`${API_URL}/api/shop/search-log/click-suggestion`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body,
                              keepalive: true,
                            }).catch(() => {});
                          }
                        } catch (_) { /* never block UX */ }
                        const next = new URLSearchParams();
                        next.set('q', s);
                        setSearchParams(next, { replace: false });
                      }}
                      className="px-3 py-1.5 rounded-full bg-white border border-gray-300 text-gray-800 hover:bg-[#F7EA1C] hover:border-gray-900 hover:text-gray-900 transition text-sm font-medium"
                      data-testid={`search-suggestion-${s.toLowerCase().replace(/\s+/g, '-')}`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <Link
              to="/tiles"
              className="inline-block mt-6 px-5 py-2 bg-[#F7EA1C] text-gray-900 rounded-full font-semibold hover:bg-yellow-300 transition"
            >
              Browse all tiles
            </Link>
          </div>
        )}

        {results.length > 0 && (
          <div
            className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 sm:gap-6"
            data-testid="search-results-grid"
          >
            {results.map((r) => (
              <ResultCard key={`${r.type}-${r.id}`} r={r} />
            ))}
          </div>
        )}

        {totalPages > 1 && (
          <div className="mt-10 flex items-center justify-center gap-1 flex-wrap" data-testid="search-pagination">
            <button
              disabled={page <= 1}
              onClick={() => goToPage(page - 1)}
              className="px-3 py-1.5 border rounded disabled:opacity-40 hover:bg-gray-50"
            >
              Prev
            </button>
            {pageWindow.map((p) => (
              <button
                key={p}
                onClick={() => goToPage(p)}
                className={`px-3 py-1.5 rounded border ${
                  p === page ? 'bg-gray-900 text-white border-gray-900' : 'hover:bg-gray-50'
                }`}
              >
                {p}
              </button>
            ))}
            <button
              disabled={page >= totalPages}
              onClick={() => goToPage(page + 1)}
              className="px-3 py-1.5 border rounded disabled:opacity-40 hover:bg-gray-50"
            >
              Next
            </button>
          </div>
        )}
      </main>
      <ShopFooter />
    </div>
  );
};


const ResultCard = ({ r }) => {
  const priceLabel = typeof r.price === 'number' && r.price > 0
    ? `£${r.price.toFixed(2)}${r.price_unit ? ` ${r.price_unit}` : ''}`
    : null;
  const typeLabel = r.type === 'tile' ? 'Tile' : 'Accessory';
  const typeColor = r.type === 'tile'
    ? 'bg-indigo-100 text-indigo-900'
    : 'bg-amber-100 text-amber-900';

  return (
    <Link
      to={r.url}
      className="group block bg-white border border-gray-200 rounded-lg overflow-hidden hover:shadow-lg hover:border-gray-300 transition"
      data-testid={`search-result-${r.type}-${r.id}`}
    >
      <div className="aspect-square bg-gray-100 overflow-hidden">
        {r.image ? (
          <img
            src={r.image}
            alt={r.name}
            loading="lazy"
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
            onError={(e) => { e.currentTarget.style.display = 'none'; }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-300 text-xs">
            No image
          </div>
        )}
      </div>
      <div className="p-3">
        <div className="flex items-center gap-1 mb-1">
          <span className={`text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide font-semibold ${typeColor}`}>
            {typeLabel}
          </span>
          {r.category && (
            <span className="text-[10px] text-gray-500 truncate">· {r.category}</span>
          )}
        </div>
        <p className="font-medium text-sm text-gray-900 line-clamp-2 min-h-[2.5rem]">{r.name}</p>
        {priceLabel && (
          <p className="mt-1 text-[#333] font-semibold text-sm">{priceLabel}</p>
        )}
      </div>
    </Link>
  );
};

export default ShopSearchResultsPage;

import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Clock, Package, ArrowRight } from 'lucide-react';
import { CollectionCard } from '../../pages/shop/TileCollectionsPage';
import { normaliseImageUrl } from '../../utils/safeStr';

const API_URL = process.env.REACT_APP_BACKEND_URL;
const STORAGE_KEY = 'tile_station_recently_viewed';
const MAX_STORED = 20;

// Cross-group mapping: what to recommend based on current group
const CROSS_GROUP_MAP = {
  tiles: [
    { slug: 'materials', label: 'Adhesives & Grout', reason: 'Essential for installation' },
    { slug: 'tools', label: 'Tiling Tools', reason: 'For professional results' },
    { slug: 'accessories', label: 'Trims & Spacers', reason: 'Perfect finishing touches' },
    { slug: 'underfloor-heating', label: 'Underfloor Heating', reason: 'Upgrade your comfort' },
  ],
  flooring: [
    { slug: 'underfloor-heating', label: 'Underfloor Heating', reason: 'Works great with flooring' },
    { slug: 'materials', label: 'Adhesives & Underlay', reason: 'Essential for fitting' },
    { slug: 'tools', label: 'Flooring Tools', reason: 'Get the job done right' },
    { slug: 'accessories', label: 'Trims & Profiles', reason: 'Neat edge finishing' },
  ],
  materials: [
    { slug: 'tiles', label: 'Tiles', reason: 'Browse our tile range' },
    { slug: 'flooring', label: 'Flooring', reason: 'Explore flooring options' },
    { slug: 'tools', label: 'Application Tools', reason: 'Apply with precision' },
  ],
  tools: [
    { slug: 'materials', label: 'Adhesives & Grout', reason: 'Stock up on essentials' },
    { slug: 'tiles', label: 'Tiles', reason: 'Browse our tile range' },
    { slug: 'accessories', label: 'Accessories', reason: 'Complete your toolkit' },
  ],
  accessories: [
    { slug: 'tiles', label: 'Tiles', reason: 'Find matching tiles' },
    { slug: 'flooring', label: 'Flooring', reason: 'Explore flooring options' },
    { slug: 'materials', label: 'Adhesives & Grout', reason: 'Installation essentials' },
  ],
  'underfloor-heating': [
    { slug: 'tiles', label: 'Tiles', reason: 'Best paired with tiles' },
    { slug: 'flooring', label: 'Flooring', reason: 'Compatible flooring options' },
    { slug: 'tools', label: 'Installation Tools', reason: 'For professional fitting' },
  ],
};

// --- LocalStorage utilities ---
export const getRecentlyViewed = () => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
};

export const trackRecentView = (product) => {
  if (!product?.slug && !product?.id) return;
  try {
    const existing = getRecentlyViewed();
    const key = product.slug || product.id;
    const entry = {
      id: product.id,
      slug: product.slug,
      display_name: product.display_name || product.name || product.series_name,
      image: normaliseImageUrl(product.images?.[0] || product.hero_image || product.image),
      price: product.price || product.prices_from,
      product_group: product.product_group || 'tiles',
      is_surface_product: product.is_surface_product !== false,
      viewed_at: Date.now(),
    };
    const filtered = existing.filter(
      (item) => (item.slug || item.id) !== key
    );
    const updated = [entry, ...filtered].slice(0, MAX_STORED);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch (e) {
    console.error('Error tracking view:', e);
  }
};





// --- RecentlyViewedSection ---
// Renders cards in the same rich format as the "Trending Now" carousel by
// reusing <CollectionCard>. Fetches the full collection objects on mount
// from /api/tiles/collection/{series_name} so prices/sale flags stay fresh.
export const RecentlyViewedSection = ({
  currentProductSlug,
  maxItems = 6,
}) => {
  const [collections, setCollections] = useState([]);

  useEffect(() => {
    let cancelled = false;
    const all = getRecentlyViewed()
      .filter((p) => (p.slug || p.id) !== currentProductSlug)
      .slice(0, maxItems);
    if (all.length === 0) {
      setCollections([]);
      return;
    }
    (async () => {
      const fetched = await Promise.all(all.map(async (item) => {
        const seriesName = item.display_name || item.series_name;
        if (!seriesName) return null;
        try {
          const res = await fetch(`${API_URL}/api/tiles/collection/${encodeURIComponent(seriesName)}`);
          if (!res.ok) return null;
          const data = await res.json();
          // Backend returns { collection: {...}, products: [...] } OR the flat shape;
          // handle both safely.
          return data.collection || data;
        } catch {
          return null;
        }
      }));
      if (!cancelled) setCollections(fetched.filter(Boolean));
    })();
    return () => { cancelled = true; };
  }, [currentProductSlug, maxItems]);

  if (collections.length === 0) return null;

  return (
    <section
      className="py-12 border-t border-gray-100"
      data-testid="recently-viewed-section"
    >
      <div className="container mx-auto px-4">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-9 h-9 rounded-lg bg-gray-900 flex items-center justify-center">
            <Clock className="w-4 h-4 text-amber-400" />
          </div>
          <div>
            <h2 className="text-xl font-semibold text-gray-900 tracking-tight">
              Recently Viewed
            </h2>
            <p className="text-sm text-gray-500">Pick up where you left off</p>
          </div>
        </div>
        <div
          className="flex gap-6 overflow-x-auto pb-4 scrollbar-hide -mx-4 px-4"
          style={{ scrollSnapType: 'x mandatory' }}
        >
          {collections.map((col, idx) => (
            <div
              key={col.series_name || idx}
              className="flex-shrink-0 w-72"
              style={{ scrollSnapAlign: 'start' }}
              data-testid={`recently-viewed-item-${col.series_name}`}
            >
              <CollectionCard
                collection={col}
                useLifestyleImages={false}
                gridCols={4}
              />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

// --- YouMayAlsoNeed ---
// Cross-group cards rendered in the same rich format as Trending Now.
// We pass the API's full collection objects (with sizes, swatches, sale
// flags etc) straight into <CollectionCard> so the visual is identical.
export const YouMayAlsoNeed = ({
  currentGroup = 'tiles',
  maxItems = 6,
  pinnedItems = [],
}) => {
  const [items, setItems] = useState([]);  // [{ collection, group_label, reason }]
  const [loading, setLoading] = useState(true);
  const pinnedKey = (pinnedItems || []).map((p) => p.series_name).join('|');

  useEffect(() => {
    const fetchCrossGroup = async () => {
      setLoading(true);
      try {
        // Admin hand-picked pins render first, as full collection cards.
        const pinnedFetches = (pinnedItems || []).slice(0, maxItems).map(async (pin) => {
          if (!pin.series_name) return null;
          try {
            const res = await fetch(
              `${API_URL}/api/tiles/collection/${encodeURIComponent(pin.series_name)}`
            );
            if (!res.ok) return null;
            const data = await res.json();
            const col = data.collection || data;
            if (!col || !col.series_name) return null;
            return {
              collection: col,
              group_label: 'Hand-Picked',
              reason: 'Recommended for this product',
            };
          } catch {
            return null;
          }
        });

        const related = CROSS_GROUP_MAP[currentGroup] || CROSS_GROUP_MAP.tiles;
        const fetches = related.slice(0, 3).map(async (group) => {
          const res = await fetch(
            `${API_URL}/api/tiles/collections?group=${group.slug}&limit=4`
          );
          if (!res.ok) return { group, collections: [] };
          const data = await res.json();
          return { group, collections: data.collections || [] };
        });
        const [pinnedResolved, results] = await Promise.all([
          Promise.all(pinnedFetches),
          Promise.all(fetches),
        ]);

        const collected = pinnedResolved.filter(Boolean);
        const pinnedNames = new Set(
          collected.map((i) => (i.collection.series_name || '').toLowerCase())
        );
        for (const { group, collections } of results) {
          for (const col of collections) {
            if (collected.length >= maxItems) break;
            if (pinnedNames.has((col.series_name || '').toLowerCase())) continue;
            collected.push({
              collection: col,
              group_label: group.label,
              reason: group.reason,
            });
          }
        }
        setItems(collected);
      } catch (e) {
        console.error('Error fetching cross-group recommendations:', e);
      } finally {
        setLoading(false);
      }
    };
    fetchCrossGroup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentGroup, maxItems, pinnedKey]);

  if (loading || items.length === 0) return null;

  return (
    <section
      className="py-12 border-t border-gray-100 bg-gradient-to-b from-amber-50/30 to-transparent"
      data-testid="you-may-also-need-section"
    >
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-amber-500 flex items-center justify-center">
              <Package className="w-4 h-4 text-white" />
            </div>
            <div>
              <h2 className="text-xl font-semibold text-gray-900 tracking-tight">
                You May Also Need
              </h2>
              <p className="text-sm text-gray-500">
                Complete your project with these essentials
              </p>
            </div>
          </div>
        </div>

        <div
          className="flex gap-6 overflow-x-auto pb-4 scrollbar-hide -mx-4 px-4"
          style={{ scrollSnapType: 'x mandatory' }}
        >
          {items.map(({ collection, group_label, reason }, idx) => (
            <div
              key={`${collection.series_name || idx}-${idx}`}
              className="flex-shrink-0 w-72 relative"
              style={{ scrollSnapAlign: 'start' }}
              data-testid={`cross-sell-item-${collection.series_name || idx}`}
            >
              {/* Group-label pill — sits above the card and identifies which
                  cross-sell category this recommendation belongs to.
                  14 May 2026 — was overflowing the card on long labels
                  like "ADHESIVES & UNDERLAY" because `tracking-wider`
                  + uppercase + no max-width = ~10% extra width than
                  the card. Capped at card width minus the left offset,
                  dropped tracking, and allowed natural word-wrap. */}
              <span
                className="absolute -top-2 left-3 z-20 px-2.5 py-1 bg-amber-500 text-white text-[10px] font-bold uppercase rounded-full shadow-sm max-w-[calc(100%-1.5rem)] leading-tight"
                style={{ wordBreak: 'normal', overflowWrap: 'anywhere' }}
                data-testid={`cross-sell-label-${collection.series_name || idx}`}
                title={group_label}
              >
                {group_label}
              </span>
              <CollectionCard
                collection={collection}
                useLifestyleImages={false}
                gridCols={4}
              />
              {reason && (
                <p className="text-xs text-gray-500 mt-2 px-1 italic">{reason}</p>
              )}
            </div>
          ))}
        </div>

        {/* Browse all groups CTA */}
        <div className="flex flex-wrap gap-3 mt-8">
          {(CROSS_GROUP_MAP[currentGroup] || []).map((group) => (
            <Link
              key={group.slug}
              to={`/tiles?group=${group.slug}`}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-gray-200 text-sm font-medium text-gray-700 hover:border-amber-400 hover:text-amber-600 transition-all group/cta"
              data-testid={`browse-group-${group.slug}`}
            >
              {group.label}
              <ArrowRight className="w-3.5 h-3.5 group-hover/cta:translate-x-0.5 transition-transform" />
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
};

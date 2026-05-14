import React from 'react';

/**
 * ProductGridSkeleton (14 May 2026)
 *
 * Reusable skeleton placeholder for storefront list pages. Replaces the
 * old centred `<div class="animate-spin">` spinner pattern that showed
 * a single dot in the middle of the page while the catalogue loaded —
 * which felt MUCH slower than progressive skeleton placeholders that
 * match the final grid shape.
 *
 * Used by:
 *   • ShopSearchResultsPage (in-place pattern, not yet ported)
 *   • ClearancePage
 *   • NewCollectionPage
 *   • TileListingPage
 *   • (future) collection PDPs
 *
 * Props:
 *   count          number of placeholder cards (default 8)
 *   cols           tailwind grid-cols classes for sm: / lg: breakpoints
 *   gridClassName  optional override of the entire grid wrapper class
 */
const ProductGridSkeleton = ({
  count = 8,
  cols = 'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 sm:gap-6',
  gridClassName,
  testId = 'product-grid-skeleton',
}) => {
  return (
    <div
      className={gridClassName || cols}
      data-testid={testId}
      aria-busy="true"
      aria-label="Loading products"
    >
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="rounded-lg overflow-hidden border border-gray-200 bg-white"
        >
          <div className="aspect-square bg-gray-100 animate-pulse" />
          <div className="p-3 space-y-2">
            <div className="h-3 w-3/4 bg-gray-100 animate-pulse rounded" />
            <div className="h-3 w-1/2 bg-gray-100 animate-pulse rounded" />
            <div className="h-4 w-1/3 bg-gray-100 animate-pulse rounded mt-3" />
          </div>
        </div>
      ))}
    </div>
  );
};

export default ProductGridSkeleton;

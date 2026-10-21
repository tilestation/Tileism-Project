import React, { useState, useEffect, useRef } from 'react';
import { ChevronDown, Package, Check } from 'lucide-react';
import { useSampleCart } from '../../contexts/SampleCartContext';
import {
  classifySampleForProduct,
  SAMPLE_TIER_LABELS,
  FULL_SIZE_SAMPLE_PRICE_GBP,
} from '../../lib/sampleTier';

/**
 * Single "Order Sample" button that auto-detects which sample tiers
 * a tile is eligible for and presents them as a dropdown.
 *
 * Tiers (auto-detected from product.tile_width / tile_height):
 *   • free_small  — tile IS the sample (small mosaics / metros)
 *   • free_cut    — standard 10×10 cm cut piece
 *   • full_size   — 300×600 mm cut from large-format tiles, £5 each
 *
 * Hidden entirely when:
 *   • product.samples_hidden === true (per-product opt-out)
 *   • globalEnabled === false (passed in by parent — global toggle)
 *
 * Props:
 *   product          { id, slug, display_name, tile_width, tile_height, ... }
 *   className        Extra classes for outer wrapper
 *   buttonClassName  Extra classes for the trigger button
 *   buttonLabel      Override default "Order Sample" label
 *   globalEnabled    bool — false hides the button entirely
 *   onAdded          callback(tier) when a sample is added (optional)
 *   compact          bool — smaller variant for collection cards
 */
const OrderSampleButton = ({
  product,
  className = '',
  buttonClassName = '',
  buttonLabel = 'Order Sample',
  globalEnabled = true,
  onAdded,
  compact = false,
}) => {
  const { addSample, isInSamples, canAddFree } = useSampleCart();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);

  // Click-outside to close — declared before any early returns so the
  // hook runs on every render in the same order (React rules-of-hooks).
  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // Hide entirely when explicitly disabled (per-product samples_hidden
  // OR global toggle off). Render nothing — no placeholder gap.
  if (!product || product.samples_hidden === true || globalEnabled === false) {
    return null;
  }

  // Clearance tiles: don't post samples. Customers see a small
  // showroom-only notice instead of the order button. Reason: clearance
  // is end-of-line stock, often a single batch — losing tiles to sample
  // cuts isn't viable, and shade/finish must be inspected in person
  // anyway. The notice nudges them to a showroom rather than dead-ending.
  if (product.clearance === true) {
    return (
      <div
        className={`inline-flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-xs leading-snug max-w-xs ${className}`}
        data-testid="clearance-no-samples-notice"
      >
        <Package className="w-4 h-4 mt-0.5 flex-shrink-0" />
        <span>
          <strong>No samples for clearance tiles.</strong> Visit any showroom
          (Tonbridge / Gravesend / Sydenham) to view this tile in person.
        </span>
      </div>
    );
  }

  const tiers = classifySampleForProduct(product);
  const offers = tiers.offers || ['free_cut'];

  // If only one tier is on offer, skip the dropdown — single click adds.
  const isSingleTier = offers.length === 1;

  const pickTier = (tier) => {
    setOpen(false);
    const ok = addSample(product, { sampleType: tier });
    if (ok && onAdded) onAdded(tier);
  };

  const handleTriggerClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (isSingleTier) {
      pickTier(offers[0]);
    } else {
      setOpen((v) => !v);
    }
  };

  const baseBtn = compact
    ? 'inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md transition'
    : 'inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-lg transition';

  // Visual state: "added" (any tier in basket) shows a check; otherwise
  // the standard amber CTA.
  const anyInBasket = isInSamples(product.id);
  const triggerClass = anyInBasket
    ? `${baseBtn} bg-emerald-600 hover:bg-emerald-700 text-white ${buttonClassName}`
    : `${baseBtn} bg-amber-500 hover:bg-amber-600 text-white ${buttonClassName}`;

  return (
    <div ref={wrapperRef} className={`relative inline-block ${className}`}>
      <button
        type="button"
        onClick={handleTriggerClick}
        className={triggerClass}
        data-testid="order-sample-btn"
        aria-haspopup={!isSingleTier}
        aria-expanded={open}
      >
        {anyInBasket ? <Check className="w-4 h-4" /> : <Package className="w-4 h-4" />}
        <span>{anyInBasket ? 'Sample in basket' : buttonLabel}</span>
        {!isSingleTier && (
          <ChevronDown className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} />
        )}
      </button>

      {open && !isSingleTier && (
        <div
          className="absolute z-50 mt-2 w-80 max-w-[90vw] right-0 sm:right-auto sm:left-0 bg-white border border-gray-200 rounded-lg shadow-xl p-2"
          data-testid="order-sample-dropdown"
        >
          {offers.includes('free_small') && (
            <TierOption
              testId="tier-free-small"
              title="Free Sample"
              subtitle="Actual tile, posted to your door"
              priceLine="FREE + £2.99 delivery"
              note="This tile is small enough to send whole — you receive the actual tile, not a cut piece."
              disabled={!canAddFree}
              onClick={() => pickTier('free_small')}
            />
          )}
          {offers.includes('free_cut') && (
            <TierOption
              testId="tier-free-cut"
              title="Free Sample"
              subtitle="10×10 cm cut piece"
              priceLine="FREE + £2.99 delivery"
              note="A cut piece large enough to see colour, finish and texture in your space."
              disabled={!canAddFree}
              disabledNote={!canAddFree ? '3 free-sample limit reached — choose a Full Size Sample instead.' : null}
              onClick={() => pickTier('free_cut')}
            />
          )}
          {offers.includes('full_size') && (
            <TierOption
              testId="tier-full-size"
              title="Full Size Sample"
              subtitle="300×600 mm cut piece"
              priceLine={`£${FULL_SIZE_SAMPLE_PRICE_GBP.toFixed(2)} + £2.99 delivery`}
              highlight
              note={
                tiers.fullSizeNote ||
                'A larger 300×600 mm cut piece — easier to see pattern, shade variation and how it sits in a room.'
              }
              onClick={() => pickTier('full_size')}
            />
          )}
          <p className="px-3 py-2 text-[11px] text-gray-500 border-t border-gray-100 mt-1">
            All samples free to collect from any showroom (Tonbridge / Gravesend / Sydenham).
          </p>
        </div>
      )}
    </div>
  );
};

const TierOption = ({
  testId,
  title,
  subtitle,
  priceLine,
  note,
  disabled,
  disabledNote,
  highlight,
  onClick,
}) => {
  const inBasket = false; // TierOption doesn't track per-tier — keep simple
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      data-testid={testId}
      className={`block w-full text-left p-3 rounded-md transition ${
        disabled
          ? 'opacity-50 cursor-not-allowed'
          : highlight
            ? 'hover:bg-amber-50 border border-amber-200'
            : 'hover:bg-gray-50'
      } ${SAMPLE_TIER_LABELS && inBasket ? '' : ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm text-gray-900">{title}</div>
          <div className="text-xs text-gray-600 mt-0.5">{subtitle}</div>
        </div>
        <div className={`text-xs font-semibold whitespace-nowrap ${highlight ? 'text-amber-700' : 'text-gray-700'}`}>
          {priceLine}
        </div>
      </div>
      {note && <p className="text-[11px] text-gray-500 mt-1.5 leading-snug">{note}</p>}
      {disabledNote && (
        <p className="text-[11px] text-rose-600 mt-1.5 leading-snug">{disabledNote}</p>
      )}
    </button>
  );
};

export default OrderSampleButton;

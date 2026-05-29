/**
 * Regression test for the PDP m²/Boxes default-unit bug
 * (24 May 2026 — user reported "By default it shows 1 for box which
 * should actually show the quantity (m2) per box").
 *
 * Root cause:
 *   The CollectionDetailPage quantity selector defaulted to
 *   `quantityUnit = 'sqm'` with `quantity = 1`. The m² input showed
 *   "1" (the literal quantity) and the Boxes input showed
 *   `Math.ceil(1 / 1.26) = 1` — two boxes labelled "1" with no
 *   visual indication that 1 box actually covers 1.26 m². Customers
 *   couldn't tell whether they were buying 1 box or 1 m².
 *
 * Fixed behaviour:
 *   Default `quantityUnit = 'box'` with `quantity = 1`. Now:
 *     • Boxes input renders `quantity = 1`
 *     • m² input renders `Math.round(1 * sqm_per_box * 100) / 100`
 *       = 1.26 (the actual coverage), matching the "1 box = 1.26 m²
 *       actual coverage" hint right below.
 *   The cart calculation is unaffected because getEffectiveSqmQuantity
 *   already converts either unit correctly.
 *
 * Contract pinned:
 *   The initial `quantityUnit` state must be 'box' so first-render
 *   shows the actual m² coverage in the m² input, not the placeholder
 *   "1".
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
  path.join(__dirname, 'src/pages/shop/CollectionDetailPage.js'),
  'utf8',
);

// 1. Initial state — quantity = 1, quantityUnit = 'box'.
assert.match(
  src,
  /const\s+\[quantity,\s+setQuantity\]\s+=\s+useState\(1\)\s*;/,
  '`quantity` must default to 1',
);
assert.match(
  src,
  /const\s+\[quantityUnit,\s+setQuantityUnit\]\s+=\s+useState\('box'\)\s*;/,
  "`quantityUnit` must default to 'box' so the m² input renders " +
    'actual box coverage (e.g. 1.26) instead of the placeholder "1"',
);

// 2. The OLD default ('sqm') must NOT come back — that was the bug.
assert.doesNotMatch(
  src,
  /\[quantityUnit,\s+setQuantityUnit\]\s+=\s+useState\('sqm'\)/,
  "`quantityUnit` must NOT default to 'sqm' — that was the bug " +
    'reported on 24 May 2026 ("by default it shows 1 for box which ' +
    'should actually show the quantity per box")',
);

// 3. The input rendering logic must still branch on quantityUnit so
//    both modes work (the fix flips the default, not the conversion
//    logic). Specifically the m² input value expression and the Boxes
//    input value expression must both stay intact.
assert.match(
  src,
  /value=\{quantityUnit\s*===\s*'sqm'\s*\?\s*quantity\s*:\s*Math\.round\(quantity\s*\*\s*sqmPerBox\s*\*\s*100\)\s*\/\s*100\}/,
  'm² input render must still convert from box quantity when in box mode ' +
    '(quantity × sqmPerBox, rounded to 2dp)',
);
assert.match(
  src,
  /value=\{quantityUnit\s*===\s*'box'\s*\?\s*quantity\s*:\s*Math\.ceil\(quantity\s*\/\s*sqmPerBox\)\}/,
  'Boxes input render must still convert from m² quantity when in sqm mode',
);

console.log('✓ pdp-quantity-default-unit.test.js — all assertions passed');

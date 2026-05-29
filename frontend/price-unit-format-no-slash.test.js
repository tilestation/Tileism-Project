/**
 * Regression test for the price-unit display format
 * (24 May 2026 — user reported "remove / between price and m2 it
 * should look like £42.99m2 ... WAS £50.99m2 ... Save £8m2 ...
 * similarly for unit items show (each)").
 *
 * Contract pinned:
 *   1. NO `/m²` or `/each` slash-prefixed unit anywhere in the two
 *      product-detail pages — both should now use attached `m²`
 *      (no slash, no space) and ` each` (no slash, leading space).
 *   2. The SAVE amount in the sale banner ALSO carries the unit so
 *      the customer can see "you save £8.00m²", not the ambiguous
 *      "you save £8.00".
 *   3. The WAS price ALSO carries the unit so customers don't have
 *      to scan their eyes between two different-format prices.
 *   4. For pricing_unit === 'unit' products the suffix reads
 *      ` each` (with leading space) — matches the user's specified
 *      example "(each)".
 *
 * Why this matters:
 *   - "/m²" reads as "per square metre" which is technically right
 *     but visually noisy and AI-generated copy on the storefront
 *     felt cluttered.
 *   - "Save £8.00" without the unit confused customers — was it
 *     £8 saved total, or £8 per square metre? Now explicit.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const cdp = fs.readFileSync(
  path.join(__dirname, 'src/pages/shop/CollectionDetailPage.js'),
  'utf8',
);
const tdp = fs.readFileSync(
  path.join(__dirname, 'src/pages/shop/TileDetailPage.js'),
  'utf8',
);

// 1. Strip code comments before scanning for the bad pattern — we
//    only care about JSX-rendered occurrences.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')  // block comments
    .replace(/^\s*\/\/[^\n]*$/gm, ''); // single-line comments
}

for (const [label, src] of [
  ['CollectionDetailPage.js', cdp],
  ['TileDetailPage.js', tdp],
]) {
  const cleaned = stripComments(src);
  // 1a. No slash-prefixed `/m²` ATTACHED TO A PRICE in rendered
  //     output. Labels like "Price/m²" / "Trade Price/m²" stay —
  //     they read as "per square metre" and aren't the bug.
  //     The bad pattern is `}/m²` (closing JSX expression for a
  //     price followed by a slash unit) or `)}/m²`.
  const slashM2 = cleaned.match(/\}\/m²/g);
  assert.equal(
    slashM2,
    null,
    `${label} must NOT contain "}/m²" — a price expression directly ` +
      `followed by /m² is the bug. Use attached "m²" (no slash) ` +
      `instead`,
  );
  const slashEach = cleaned.match(/\}\/each/g);
  assert.equal(
    slashEach,
    null,
    `${label} must NOT contain "}/each" — use " each" (with ` +
      `leading space) instead`,
  );
  const slashUnit = cleaned.match(/\}\/unit/g);
  assert.equal(
    slashUnit,
    null,
    `${label} must NOT contain "}/unit" — use "unit" or " each" instead`,
  );
}

// 2. The CollectionDetailPage SALE banner now carries the unit on
//    SAVE.
assert.match(
  cdp,
  /SAVE £\{totalSavings\.toFixed\(2\)\}\{isSurfaceProduct\s*\?\s*['"]m²['"]\s*:\s*['"]\s+each['"]\}/,
  'SAVE amount in the sale banner must carry the unit (m² or each) ' +
    'so customers know whether the saving is per-m² or total',
);

// 3. The WAS price carries the unit.
assert.match(
  cdp,
  /WAS £\{safeToFixed\(wasPrice, 2\)\}\{isSurfaceProduct\s*\?\s*['"]m²['"]\s*:\s*['"]\s+each['"]\}/,
  'WAS price in the sale banner must carry the unit so customers ' +
    'can compare WAS and NOW with consistent formatting',
);

// 4. NOW price has the unit attached, no slash, no separator <span>.
assert.match(
  cdp,
  /NOW £\{safeToFixed\(nowPrice, 2\)\}\{isSurfaceProduct\s*\?\s*['"]m²['"]\s*:\s*['"]\s+each['"]\}/,
  'NOW price must have the unit attached directly to the figure, ' +
    'not split into a separate <span> with a slash prefix',
);

// 5. The "/m²" separator <span> from the OLD layout must not return.
assert.doesNotMatch(
  cdp,
  /<span className="text-white\/70 text-sm font-medium">\{isSurfaceProduct/,
  'The legacy separator <span> with "/m²" must not return — its ' +
    'extra horizontal whitespace was exactly the "/ between price ' +
    'and m2" the user objected to',
);

console.log('✓ price-unit-format-no-slash.test.js — all assertions passed');

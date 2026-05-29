/**
 * Regression test for "Unified Mode" in the Quick-Generate-All-Series-
 * Descriptions modal (24 May 2026 — user reported: "It's giving me
 * separate descriptions for each colour but I said unified — One La
 * Dolce collection").
 *
 * Background:
 *   The auto-detector splits a 25-product collection into 6 detected
 *   sub-series (e.g. "La Dolce", "La Dolce Sabbia", "La Dolce
 *   Antracite", "La Dolce Sabbia 2CM"). Inline-renaming all 6 to the
 *   same name worked (the backend merges) but required typing the
 *   same name into 6 inputs — tedious. Admin clearly wanted ONE
 *   unified description for the whole range.
 *
 * Definitive fix:
 *   Added a top-level "Unified / Per-series" radio toggle that
 *   defaults to UNIFIED. In unified mode:
 *     • Single editable "Collection name" input (seeded from the
 *       longest common prefix of selected products' display names)
 *     • All selected detected series are collapsed into one group
 *       via series_name_overrides where every key maps to the same
 *       target — backend then merges them
 *     • Generate button label changes to
 *       "Generate 1 unified 'La Dolce' description"
 *     • Per-series inline renames are suppressed (would be confusing)
 *
 * Contract pinned:
 *   1. `batchUnifiedMode` state exists and defaults to true on modal
 *      open.
 *   2. `batchUnifiedCollectionName` state exists and is seeded from
 *      the longest common prefix of selected products' admin names.
 *   3. Generate-call rewrites series_name_overrides so every selected
 *      auto-detected name maps to the unified collection name.
 *   4. Generate button label adapts to mode.
 *   5. Generate button is disabled when unified mode is on but the
 *      collection-name input is empty (otherwise admin gets a useless
 *      description titled "Collection").
 *   6. The per-series rename hint is suppressed in unified mode.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
  path.join(__dirname, 'src/pages/admin/SupplierProducts.js'),
  'utf8',
);

// 1. State exists and defaults to UNIFIED on modal open.
assert.match(
  src,
  /const\s+\[batchUnifiedMode,\s+setBatchUnifiedMode\]\s+=\s+useState\(true\)/,
  'batchUnifiedMode state must exist and default to true — admin ' +
    'intent is almost always "one collection description"',
);
assert.match(
  src,
  /const\s+\[batchUnifiedCollectionName,\s+setBatchUnifiedCollectionName\]\s+=\s+useState\(['"]['"]\)/,
  'batchUnifiedCollectionName state must exist',
);

// 2. Unified mode is re-applied (true) every time the modal opens,
//    and the collection name is seeded from longest common prefix.
assert.match(
  src,
  /setBatchUnifiedMode\(true\)/,
  'Modal open must (re-)default unified mode to true',
);
assert.match(
  src,
  /setBatchUnifiedCollectionName\(commonPrefixTokens\.join\(' '\)\.trim\(\)\)/,
  'Modal open must seed collection name from longest common prefix ' +
    'of selected products\' admin names',
);

// 3. Generate-call collapses overrides under unified mode.
assert.match(
  src,
  /if\s+\(batchUnifiedMode\)\s*\{[\s\S]{0,600}selectedSeriesData\.forEach\(\(s\)\s*=>\s*\{\s*overridesToSend\[s\.series_name\]\s*=\s*collectionName/,
  'When batchUnifiedMode is on, the generate-call must rewrite ' +
    'series_name_overrides so every selected auto-detected name maps ' +
    'to the same collection name (which the backend will then merge)',
);

// 4. Generate button label adapts to mode.
assert.match(
  src,
  /batchUnifiedMode\s*\?\s*`Generate 1 unified "\$\{[^`]*\}" description`\s*:\s*`Generate \$\{selectedSeriesForBatch\.size\} Descriptions`/,
  'Generate button label must change between "Generate 1 unified " + ' +
    'collection name + " description" and "Generate N Descriptions"',
);

// 5. Generate button is disabled in unified mode when collection name
//    is empty.
assert.match(
  src,
  /batchUnifiedMode\s+&&\s+!\(batchUnifiedCollectionName\s*\|\|\s*['"]['"]\)\.trim\(\)/,
  'Generate button must be disabled when unified mode is on and ' +
    "collection name is empty — otherwise admin gets a useless " +
    '"Collection" placeholder description',
);

// 6. Per-series rename hint is suppressed in unified mode.
assert.match(
  src,
  /\{!batchUnifiedMode\s*&&\s*\(\s*<p[\s\S]{0,500}tap any series name below to rename/,
  'The per-series inline-rename hint must be hidden in unified mode ' +
    "since renames don't apply there — would be confusing",
);

// 7. Unified mode shows its own informative hint instead.
assert.match(
  src,
  /\{batchUnifiedMode\s*&&\s*\(\s*<p[\s\S]{0,500}these[\s\S]{0,200}groups will all be[\s\S]{0,80}combined into ONE description/,
  'Unified mode must show its own hint explaining that the detected ' +
    'groups will be merged into one description',
);

// 8. The radio toggle has both options accessible.
assert.match(
  src,
  /data-testid="batch-mode-unified-radio"/,
  'Unified-mode radio button must have a stable data-testid',
);
assert.match(
  src,
  /data-testid="batch-mode-per-series-radio"/,
  'Per-series radio button must have a stable data-testid',
);
assert.match(
  src,
  /data-testid="batch-unified-collection-name-input"/,
  'Collection-name input must have a stable data-testid',
);

console.log('✓ batch-series-unified-mode.test.js — all assertions passed');

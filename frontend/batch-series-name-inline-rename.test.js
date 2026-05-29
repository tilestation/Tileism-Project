/**
 * Regression test for the inline series-name editor in the
 * Quick-Generate-All-Series-Descriptions modal
 * (24 May 2026 — user repeatedly reported "Pietra Ligure" appearing
 * instead of "La Dolce" even after the priority-chain fix; asked for
 * a definitive solution).
 *
 * Definitive fix:
 *   The auto-detected series names are now rendered as editable
 *   text inputs inside the modal. The admin can type "La Dolce"
 *   directly into the field that shows "Pietra Ligure" before
 *   clicking Generate. Renames are kept in a per-modal-session
 *   `seriesNameOverrides` state map and sent to the backend as
 *   `series_name_overrides: {auto: edited}` for re-grouping.
 *
 * Contract pinned:
 *   1. `seriesNameOverrides` state exists and is reset to {} when
 *      the modal opens (fresh start every time).
 *   2. The auto-detected name is rendered inside an `<input>` whose
 *      `value` honours the override map.
 *   3. The generate call sends `series_name_overrides` in the body.
 *   4. The hint text explicitly tells the user they can rename
 *      (so the feature is discoverable, not a hidden affordance).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
  path.join(__dirname, 'src/pages/admin/SupplierProducts.js'),
  'utf8',
);

// 1. seriesNameOverrides state exists.
assert.match(
  src,
  /const\s+\[seriesNameOverrides,\s+setSeriesNameOverrides\]\s+=\s+useState\(\{\}\)/,
  'seriesNameOverrides state must exist and default to an empty object',
);

// 2. The state is reset when the modal opens.
assert.match(
  src,
  /setSeriesNameOverrides\(\{\}\)/,
  'seriesNameOverrides must be reset to {} when handleOpenBatchSeriesModal runs',
);

// 3. The auto-detected name is rendered inside an <input> with a value
//    that honours the override map.
assert.match(
  src,
  /value=\{editedName\}/,
  'The series-name <input> must use editedName (=override ?? original) as its value',
);
assert.match(
  src,
  /seriesNameOverrides\[originalName\]\s*\?\?\s*originalName/,
  'editedName must be sourced from seriesNameOverrides[originalName] ?? originalName',
);

// 4. The onChange handler updates the override map. Empty input
//    falls back to the original auto-detected name (delete from map).
assert.match(
  src,
  /onChange=\{\(e\)\s*=>\s*\{[\s\S]{0,400}setSeriesNameOverrides/,
  'onChange must update seriesNameOverrides',
);

// 5. The generate call sends `series_name_overrides`. The value
//    expression was refactored to `overridesToSend` to support
//    unified-mode collapsing, so we accept either the literal state
//    variable OR the computed local.
assert.match(
  src,
  /series_name_overrides:\s*(seriesNameOverrides|overridesToSend)/,
  'The /products/generate-batch-series-descriptions POST body must ' +
    'include series_name_overrides so the backend can re-label groups',
);

// 6. There's a visible hint telling the admin they can rename.
assert.match(
  src,
  /tap any series name below to rename it/i,
  'Modal must show a hint pointing out the inline-rename capability ' +
    "— otherwise admins won't discover the feature",
);

// 7. One of the documented examples is the exact "Pietra Ligure" →
//    "La Dolce" rename the user reported.
assert.match(
  src,
  /Pietra Ligure[\s\S]{0,50}La Dolce/,
  'Hint text should reference the actual reported scenario ' +
    '(supplier "Pietra Ligure" → collection "La Dolce") so the user ' +
    'recognises it immediately',
);

console.log('✓ batch-series-name-inline-rename.test.js — all assertions passed');

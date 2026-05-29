/**
 * Regression test for the "Save Now button overflows on mobile" bug
 * (24 May 2026 — user reported in the Bulk Category Editor that
 * after selecting scoped sizes, the green Save Now button flowed
 * off-screen on mobile and was unclickable).
 *
 * Root cause:
 *   Each attribute section (filter / spec / cat-group / made_in)
 *   used a parent row with `flex items-center` (NO `flex-wrap`).
 *   When the inner badge stack (Size + value count + "8 selected" +
 *   "4 scoped" + "1 scoped" + "Mixed") grew wider than the modal,
 *   the trailing Save Now button was pushed past the right edge of
 *   the viewport on mobile and could not be reached.
 *
 * Contract pinned:
 *   1. Every Save-Now-bearing parent row uses `flex flex-wrap` so
 *      badges wrap to a second line on narrow viewports.
 *   2. Save Now buttons carry `flex-shrink-0` so they never shrink
 *      below their natural width — they remain a tap target.
 *   3. The filter section's collapse button uses `min-w-0` so it
 *      can shrink below its content size, freeing horizontal space
 *      for the trailing Save Now to sit beside it.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
  path.join(
    __dirname,
    'src/pages/admin/components/supplier-products/BulkCategoryEditorSections.jsx',
  ),
  'utf8',
);

// 1. The four Save Now buttons all carry flex-shrink-0 so they can't
//    be squashed off-screen by a long badge row. We count occurrences
//    inside JSX (next to a string-template `: 'Save Now'`) to avoid
//    matching the documentation comment in the source.
const saveNowJsxCount = (src.match(/:\s*'Save Now'/g) || []).length;
assert.equal(
  saveNowJsxCount,
  4,
  `Expected exactly 4 Save Now buttons (filter, spec, cat-group, made_in); got ${saveNowJsxCount}`,
);

// Every Save Now button block must include flex-shrink-0 in its className.
// Match a window of ~1500 chars before each ": 'Save Now'" location
// (the cat-group button has a fat onClick handler between className
// and the text node).
const occurrences = [...src.matchAll(/:\s*'Save Now'/g)];
for (const m of occurrences) {
  const before = src.slice(Math.max(0, m.index - 1500), m.index);
  assert.ok(
    /flex-shrink-0/.test(before),
    `Save Now button near char ${m.index} must use flex-shrink-0 so it ` +
      `can't be squashed off-screen on mobile`,
  );
}

// 2. Each Save-Now-bearing parent row uses flex flex-wrap so badges
//    can wrap to a second line on mobile.
const expectedWrapMarkers = [
  // filter row
  '<div className="flex items-stretch bg-gray-50 gap-1">',
  // filter inner badges
  '<div className="flex flex-wrap items-center gap-2 min-w-0">',
  // spec row
  '<div className="flex flex-wrap items-center gap-2 mb-1">',
  // cat-group row
  '<div className="text-xs font-semibold text-gray-600 mb-2 flex flex-wrap items-center gap-1">',
  // made_in label
  '<label className="text-xs font-semibold text-gray-600 mb-2 flex flex-wrap items-center gap-1">',
];
for (const marker of expectedWrapMarkers) {
  assert.ok(
    src.includes(marker),
    `Expected wrap-safe row marker in source: ${marker}`,
  );
}

// 3. The filter collapse button carries min-w-0 so it can shrink to
//    leave room for the trailing Save Now button.
assert.match(
  src,
  /className="flex-1 min-w-0 flex items-center justify-between p-2 hover:bg-gray-100 transition-colors"/,
  'Filter collapse button must use `flex-1 min-w-0` so it can shrink ' +
    'below its content size, freeing horizontal space for the Save Now',
);

console.log('✓ bulk-editor-save-now-mobile.test.js — all assertions passed');

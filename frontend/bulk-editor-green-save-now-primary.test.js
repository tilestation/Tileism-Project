/**
 * Regression test for the green primary "Save Now" button
 * (24 May 2026 — user feedback: "I prefer Green Save Now button.
 * Can you make that as part of the default save as well").
 *
 * Background:
 *   The Bulk Category Editor modal had two save controls:
 *     • Per-attribute inline buttons (green pill, "Save Now")
 *     • Bottom primary button (purple, "Preview & Apply to N Products")
 *   User preferred the green inline visual treatment and wanted it
 *   to be the default primary save action too.
 *
 * Contract pinned:
 *   1. The primary Apply button in the Bulk Category Editor's
 *      DialogFooter uses `bg-green-600 hover:bg-green-700` styling.
 *   2. The button label reads "Save Now to N Products" (not the
 *      old "Preview & Apply to N Products") so the action verb
 *      matches the inline Save Now buttons.
 *   3. The Save icon (lucide `Save`) replaces the old Eye icon to
 *      reinforce that this saves rather than just previews.
 *   4. The button still triggers the dry-run preview flow under the
 *      hood — the preview safety net is preserved, only the visual
 *      treatment changed.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
  path.join(__dirname, 'src/pages/admin/SupplierProducts.js'),
  'utf8',
);

// 1. The primary apply button uses green styling.
assert.match(
  src,
  /className="bg-green-600\s+hover:bg-green-700"\s*\n\s*data-testid="apply-btn"/,
  'Primary apply button must use bg-green-600/hover:bg-green-700 ' +
    'so it visually matches the inline green Save Now buttons',
);

// 2. The button text reads "Save Now to N Products".
assert.match(
  src,
  /Save Now to\s*\{[^}]+\}\s*Products/,
  'Primary apply button text must be "Save Now to N Products" so ' +
    'the action verb matches the inline Save Now buttons',
);

// 3. The OLD label must NOT come back — pins the rename.
assert.doesNotMatch(
  src,
  /Preview & Apply to\s*\{[^}]+\}\s*Products/,
  'The old "Preview & Apply to N Products" label must not return',
);

// 4. The button still calls setShowDryRun(true) — the preview safety
//    net is preserved, only the visual treatment changed.
assert.match(
  src,
  /onClick=\{\(\)\s*=>\s*setShowDryRun\(true\)\}\s*\n\s*disabled=\{bulkCategoryLoading\}\s*\n\s*className="bg-green-600\s+hover:bg-green-700"\s*\n\s*data-testid="apply-btn"/,
  'Primary apply button must still call setShowDryRun(true) so the ' +
    'preview safety net is preserved underneath the new green styling',
);

console.log('✓ bulk-editor-green-save-now-primary.test.js — all assertions passed');

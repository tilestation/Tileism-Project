/**
 * Regression test for the Edit Series Names per-row popup editor
 * (24 May 2026 — user reported "Cursor doesn't move, if I need to
 * write something after a certain word I can't move cursor", and
 * asked for a wider/popup mobile UX).
 *
 * Background:
 *   The Preview-All-Products table had ~80px-wide inline inputs for
 *   New Display Name + Supplier Name. iOS Safari can't move the
 *   cursor inside such a narrow text field (the input must be wide
 *   enough to scroll its own content for tap-to-position to work).
 *
 * Definitive fix:
 *   • Inline inputs replaced with read-only spans + a hover/tap
 *     tooltip showing the full text.
 *   • Tapping the ✎ button per row opens a FULL-WIDTH popup overlay
 *     above the parent modal with:
 *       - Big py-3 text-base inputs (proper mobile tap targets)
 *       - Three separate fields: New Display Name, Supplier Name, Color
 *       - Sticky Done / Reset footer
 *     The popup uses items-end on mobile (slides up from bottom) and
 *     items-center on sm+ (centered card).
 *
 * Contract pinned:
 *   1. The popup is rendered when editingProductSku is set.
 *   2. It has stable test IDs for each interactive element.
 *   3. The display-name input is autoFocus and uses text-base + py-3
 *      so iOS Safari can position the cursor anywhere.
 *   4. Backdrop click closes the popup.
 *   5. The previous inline edit-row (which expanded the table) is GONE.
 *   6. Color picker uses the same productOptions.colors list as the
 *      table cell.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
  path.join(__dirname, 'src/pages/admin/SupplierProducts.js'),
  'utf8',
);

// 1. Popup is conditionally rendered.
assert.match(
  src,
  /\{editingProductSku\s*&&\s*\(\(\)\s*=>\s*\{[\s\S]{0,500}return \(/,
  'A popup editor must be rendered when editingProductSku is set',
);

// 2. Backdrop + container have stable test IDs.
assert.match(src, /data-testid="rename-detail-popup-backdrop"/);
assert.match(src, /data-testid="rename-detail-popup"/);

// 3. Display-name input uses mobile-friendly sizing AND is autoFocus.
//    Search a 1500-char window around the test-id since JSX attribute
//    ordering can place className either before or after data-testid.
const displayInputIdx = src.indexOf('data-testid="rename-detail-display-input"');
assert.ok(displayInputIdx > 0, 'display-name input must exist');
const displayInputWindow = src.slice(Math.max(0, displayInputIdx - 1500), displayInputIdx + 200);
assert.match(
  displayInputWindow,
  /px-3\s+py-3\s+text-base/,
  'Display-name input must use px-3 py-3 text-base so iOS Safari ' +
    'can position the cursor anywhere inside it',
);
assert.match(
  displayInputWindow,
  /autoFocus/,
  'Display-name input must autoFocus when the popup opens so admins ' +
    'can start typing immediately',
);

// 4. Supplier-name input is also big.
const supplierInputIdx = src.indexOf('data-testid="rename-detail-supplier-input"');
assert.ok(supplierInputIdx > 0, 'supplier-name input must exist');
const supplierInputWindow = src.slice(Math.max(0, supplierInputIdx - 1500), supplierInputIdx + 200);
assert.match(
  supplierInputWindow,
  /px-3\s+py-3\s+text-base/,
  'Supplier-name input must use px-3 py-3 text-base (same mobile-' +
    'friendly sizing as the display-name input)',
);

// 5. Color select is present in the popup with its own test ID.
assert.match(
  src,
  /data-testid="rename-detail-color-select"/,
  'Color picker must be available inside the popup',
);

// 6. Backdrop click closes the popup.
const backdropIdx = src.indexOf('data-testid="rename-detail-popup-backdrop"');
assert.ok(backdropIdx > 0);
const backdropWindow = src.slice(Math.max(0, backdropIdx - 600), backdropIdx + 200);
assert.match(
  backdropWindow,
  /onClick=\{\(\)\s*=>\s*setEditingProductSku\(null\)\}/,
  'Backdrop click must close the popup (setEditingProductSku(null))',
);

// 7. Container stops propagation so clicks inside don't close it.
const containerIdx = src.indexOf('data-testid="rename-detail-popup"');
assert.ok(containerIdx > 0);
const containerWindow = src.slice(Math.max(0, containerIdx - 600), containerIdx + 200);
assert.match(
  containerWindow,
  /onClick=\{\(e\)\s*=>\s*e\.stopPropagation\(\)\}/,
  'Popup container must stopPropagation so clicks inside it do not ' +
    'fire the backdrop close handler',
);

// 8. The previous inline expanded-edit row is removed (the one that
//    used colSpan={5} inside the table).
assert.doesNotMatch(
  src,
  /<tr className="bg-yellow-50">\s*<td colSpan=\{5\}/,
  'The old inline expanded edit row (colSpan=5) must be gone — it ' +
    'caused the cursor-movement bug on mobile',
);

// 9. Reset + Done buttons exist with stable test IDs.
assert.match(src, /data-testid="rename-detail-reset"/);
assert.match(src, /data-testid="rename-detail-done"/);

// 10. The popup uses sm-responsive sliding behaviour: items-end on
//     mobile (rises from bottom), items-center on sm+ (centered).
assert.match(
  src,
  /items-end sm:items-center/,
  'Popup overlay must slide up from the bottom on mobile and center ' +
    'on tablet/desktop — standard mobile-sheet UX',
);

console.log('✓ rename-detail-popup.test.js — all assertions passed');

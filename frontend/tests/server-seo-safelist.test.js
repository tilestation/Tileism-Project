/**
 * Regression test for the 5 Jun 2026 Ahrefs Health-Score fixes:
 *   1. Critical landing pages stay indexable even when the autofixer
 *      (db.seo_noindex_flags) tries to noindex them.
 *   2. All canonicals point to the www host (not the non-www apex).
 *
 * Run: `node tests/server-seo-safelist.test.js`
 * Plain Node script (matches the project convention).
 */
const path = require('path');

// Ensure clean import — the production server-seo.js relies on
// server-seo-overrides keeping in-memory state. We seed it for tests.
const { _setNoindexForTest } = require('../server-seo-overrides');
const { resolveSeo } = require('../server-seo');

let passed = 0;
let failed = 0;
function check(label, ok) {
  if (ok) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    failed++;
  }
}

console.log('5 Jun 2026 — Ahrefs Health Score fixes:');

// ─── Safelist: critical paths must stay indexable ───────────────
_setNoindexForTest(['/new-collection', '/clearance', '/', '/random-thin-page']);

const newCol = resolveSeo('/new-collection');
check('Safelist: /new-collection NEVER noindex even if flagged',
      !newCol.noindex);

const clearance = resolveSeo('/clearance');
check('Safelist: /clearance NEVER noindex even if flagged',
      !clearance.noindex);

const home = resolveSeo('/');
check('Safelist: / (homepage) NEVER noindex even if flagged',
      !home.noindex);

const randomThin = resolveSeo('/random-thin-page');
check('Safelist: /random-thin-page CAN still be noindex\'d by autofixer',
      randomThin.noindex === true);

// ─── Canonicals: all www, no apex ───────────────────────────────
check('Canonical: homepage uses www. host',
      home.canonical === 'https://www.tilestation.co.uk/');

check('Canonical: /new-collection uses www. host',
      newCol.canonical === 'https://www.tilestation.co.uk/new-collection');

check('Canonical: /clearance uses www. host',
      clearance.canonical === 'https://www.tilestation.co.uk/clearance');

const pdp = resolveSeo('/tiles/brilliant-white');
check('Canonical: PDP uses www. host',
      pdp && pdp.canonical && pdp.canonical.startsWith('https://www.tilestation.co.uk/'));

const collection = resolveSeo('/shop/collection/Hartley');
check('Canonical: collection page uses www. host',
      collection && collection.canonical && collection.canonical.startsWith('https://www.tilestation.co.uk/'));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

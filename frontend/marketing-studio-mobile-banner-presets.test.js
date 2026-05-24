/**
 * Regression test for the Marketing Studio Tile-Mountain-style
 * banner upgrades (24 May 2026 v5).
 *
 * Contract pinned:
 *   1. PRESETS array exposes a `hero-mobile` entry at 1080×1440
 *      (3:4 portrait) — the recommended size for the mobile <picture>
 *      swap on the homepage carousel.
 *   2. Publish modal renders "Quick targets" preset chips so admins
 *      can one-click route a banner to /tiles?sale=true,
 *      /shop/bathroom, /tiles?group=outdoor etc.
 *   3. The mobile-variant label nudges admins toward the new portrait
 *      preset and explains the Tile-Mountain swap.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
  path.join(__dirname, 'src/pages/admin/MarketingStudio.jsx'),
  'utf8',
);

// 1. hero-mobile preset (1080×1440, 3:4 portrait) exists in PRESETS.
assert.match(
  src,
  /key:\s*['"]hero-mobile['"][^}]*w:\s*1080[^}]*h:\s*1440[^}]*kind:\s*['"]hero['"]/,
  'PRESETS must include a `hero-mobile` entry at 1080×1440 so admins ' +
    'can generate the portrait mobile variant in one click',
);
assert.match(
  src,
  /key:\s*['"]hero-mobile['"][^}]*label:\s*['"][^'"]*1080×1440[^'"]*['"]/,
  'hero-mobile label must mention the 1080×1440 dimensions so admins ' +
    'understand the aspect ratio without opening the docs',
);

// 2. Quick-target chips for collection routing live inside the publish
//    modal — each chip pastes a path into the link_url input.
const expectedTargets = [
  { label: 'Sale', path: '/tiles?sale=true' },
  { label: 'Bathroom', path: '/shop/bathroom' },
  { label: 'Outdoor', path: '/tiles?group=outdoor' },
  { label: 'Flooring', path: '/tiles?group=flooring' },
  { label: 'All tiles', path: '/tiles' },
  { label: 'Clearance', path: '/tiles?clearance=true' },
];
for (const t of expectedTargets) {
  assert.ok(
    src.includes(`{ label: '${t.label}', path: '${t.path}' }`),
    `Quick-targets chip "${t.label}" → ${t.path} must be present so ` +
      'admins can route banners to common collections in one click',
  );
}

// 3. Each chip uses setLinkUrl to populate the input.
assert.match(
  src,
  /onClick=\{\(\)\s*=>\s*setLinkUrl\(c\.path\)\}/,
  'Quick-target chips must call setLinkUrl(path) so the click-through ' +
    'URL input picks up the value',
);

// 4. Mobile-variant label calls out the Tile-Mountain pattern so
//    admins understand WHY they should bother uploading a variant.
assert.match(
  src,
  /Tile-Mountain-style portrait banner for phones/,
  'Mobile-variant label must reference Tile-Mountain so admins ' +
    'understand the recommended workflow',
);

// 5. The publish-modal comment block explicitly points to the
//    hero-mobile preset so the workflow is discoverable.
assert.match(
  src,
  /"Hero mobile portrait \(1080×1440\)" preset/,
  'Publish-modal helper text must name the hero-mobile preset so ' +
    'admins know which size to generate',
);

console.log('✓ marketing-studio-mobile-banner-presets.test.js — all assertions passed');

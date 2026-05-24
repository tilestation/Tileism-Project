/**
 * Regression test for the mobile-banner cropping bug
 * (24 May 2026 — user reported "fix the mobile view urgently",
 * then "make it look like tilemountain.co.uk", and finally — when
 * production STILL cropped — "you are really taking the piss now").
 *
 * History of fixes:
 *   v1 (`h-[50vh]` + `object-cover`)   → chopped 50%+ of the headline.
 *   v2 (`aspect-[1920/600]` everywhere)→ collapsed to a 122px strip.
 *   v3 (`aspect-[3/2]`)                → ~70px navy bars top+bottom.
 *   v4 (`aspect-[2/1]` + blurred fill) → bars camouflaged.
 *   v5 (Tile-Mountain `aspect-[3/4]`   → only fires when every slide
 *       when `allHaveMobileVariant`)     has a portrait variant.
 *   v6 (CURRENT — user reported crop returned on production):
 *       Root cause of the v5 regression: the gate was
 *       `theme === 'image-only'` via `.every()`. Production had ONE
 *       Marketing-Studio banner mixed with seeded default/sale slides,
 *       so the gate failed and everything fell back to legacy h-[50vh]
 *       + object-cover. v6:
 *         • Detects baked-in banners via `theme === 'image-only' OR
 *           source === 'marketing_studio'` (helper `isBakedBanner`).
 *         • Switches the section-shell gate from `.every()` to
 *           `.some()` — ONE baked banner triggers the new shell so
 *           legacy seeded slides can't poison the carousel.
 *         • Themed overlays (sale/default text + CTA button) suppress
 *           themselves for baked banners — protects against admins
 *           leaving stale theme="sale" on a Marketing-Studio asset.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const homeSource = fs.readFileSync(
  path.join(__dirname, 'src/pages/shop/TileStationHome.js'),
  'utf8',
);

// 1. The `isBakedBanner` helper exists and tests BOTH theme and
//    source — this is the v6 root-cause fix.
assert.match(
  homeSource,
  /const\s+isBakedBanner\s*=\s*\(s\)\s*=>\s*[\s\S]{0,160}theme\s*===\s*['"]image-only['"][\s\S]{0,80}source\s*===\s*['"]marketing_studio['"]/,
  'isBakedBanner helper must test BOTH theme==="image-only" AND ' +
    'source==="marketing_studio" — admins shouldn\'t need a perfectly ' +
    'tagged theme for the storefront to do the right thing',
);

// 2. The section-shell gate uses `.some()`, not `.every()`, so a
//    single baked banner triggers the new shell.
assert.match(
  homeSource,
  /const\s+anyBakedBanner\s*=\s*slides\.length\s*>\s*0\s*&&\s*slides\.some\(isBakedBanner\)/,
  'Section-shell gate must use `.some(isBakedBanner)` so a single ' +
    'baked banner switches the section to the mobile-safe shell — ' +
    'v5 used `.every()` which broke when mixed with seeded slides',
);

// 3. The section-shell logic still has the variant-gated Tile-Mountain
//    branch and the v4 letterbox+blur fallback.
assert.match(
  homeSource,
  /anyBakedBanner[\s\S]{0,400}allHaveMobileVariant\s*\?\s*['"]aspect-\[3\/4\]\s+sm:aspect-\[1920\/600\][^'"]*['"]\s*:\s*['"]aspect-\[2\/1\]\s+sm:aspect-\[1920\/600\][^'"]*['"]/,
  'sectionHeightClass must branch on allHaveMobileVariant inside the ' +
    'anyBakedBanner branch: aspect-[3/4] when every slide has a ' +
    'variant, aspect-[2/1] as the v4 fallback',
);

// 4. Themed text overlays (sale + default) must NOT render for baked
//    banners — admins occasionally leave theme="sale" on a Marketing-
//    Studio asset, and the overlay would bury the baked-in headline.
assert.match(
  homeSource,
  /slide\.theme\s*===\s*['"]sale['"]\s*&&\s*!isBakedBanner\(slide\)/,
  'Sale-theme overlay must short-circuit when isBakedBanner(slide) ' +
    'is true so the Marketing-Studio banner isn\'t buried under a ' +
    'gradient + headline',
);
assert.match(
  homeSource,
  /\(slide\.theme\s*===\s*['"]default['"][^)]*\)\)\s*&&\s*!isBakedBanner\(slide\)/,
  'Default-theme overlay must short-circuit when isBakedBanner(slide) is true',
);

// 5. The dark gradient overlay also gates on !isBakedBanner.
assert.match(
  homeSource,
  /\{!isBakedBanner\(slide\)\s*&&\s*\(\s*<div\s+className="absolute\s+inset-0\s+z-10"/,
  'Dark gradient overlay must only render when !isBakedBanner(slide)',
);

// 6. The blurred backdrop now keys off isBakedBanner instead of the
//    old `theme === 'image-only'` predicate.
assert.match(
  homeSource,
  /isBakedBanner\(slide\)\s*&&\s*!slide\.mobile_image\s*&&\s*\(\s*<div/,
  'Blurred letterbox backdrop must use isBakedBanner(slide), not ' +
    'theme==="image-only", so legacy seeded mistakes still get the ' +
    'graceful fallback',
);

// 7. <img> object-fit also uses isBakedBanner.
assert.match(
  homeSource,
  /isBakedBanner\(slide\)\s*\?\s*\(\s*slide\.mobile_image\s*\?\s*['"]object-cover\s+sm:object-contain['"]\s*:\s*['"]object-contain['"]\s*\)\s*:\s*['"]object-cover['"]/,
  '<img> object-fit must use isBakedBanner(slide) — baked banners ' +
    'get contain (no crop), themed slides get cover (full-bleed)',
);

// 8. Legacy fallback shell (when no baked banner exists at all) keeps
//    the dramatic 50-70vh height for themed seeded slides.
assert.match(
  homeSource,
  /h-\[50vh\]\s+sm:h-\[60vh\]\s+md:h-\[70vh\]/,
  'When NO baked banner exists, the section must keep the legacy ' +
    'full-bleed height for themed seeded slides',
);

// 9. Eager-load the first slide for LCP, lazy-load the rest.
assert.match(
  homeSource,
  /loading=\{[^}]*idx\s*===\s*0\s*\?\s*['"]eager['"]\s*:\s*['"]lazy['"]/,
  'First hero image should be eager-loaded (LCP), rest lazy',
);

console.log('✓ mobile-hero-banner-no-crop.test.js — all assertions passed');

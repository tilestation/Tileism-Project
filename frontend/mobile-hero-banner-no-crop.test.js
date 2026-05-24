/**
 * Regression test for the mobile-banner cropping bug
 * (24 May 2026 — user-reported "fix the mobile view urgently",
 * followed by "make it look like tilemountain.co.uk").
 *
 * History of fixes:
 *   v1 (`h-[50vh]` + `object-cover`)   → chopped 50%+ of the headline.
 *   v2 (`aspect-[1920/600]` everywhere)→ banner collapsed to a 122px
 *       strip on mobile — content-safe but visually tiny.
 *   v3 (`aspect-[3/2]` mobile shell)   → user reported "too small on
 *       empty sides on mobile view" (~70px navy bars top+bottom).
 *   v4 (`aspect-[2/1]` + blurred backdrop)
 *       → reduced empty bars from ~70px to ~37px and filled them with
 *         a blurred Netflix-style backdrop. Acceptable fallback.
 *   v5 (CURRENT, Tile-Mountain-style):
 *       • When EVERY active slide carries a `mobile_image` variant,
 *         the mobile shell switches to `aspect-[3/4]` (≈520px tall on
 *         a 390px phone, matching Tile Mountain) so portrait variants
 *         fill edge-to-edge with no letterbox at all.
 *       • When ANY slide is missing a variant we keep the v4 compact
 *         2:1 shell + blurred backdrop as a graceful fallback.
 *       • Desktop (sm+) always renders the natural 1920:600 ratio
 *         capped at 70vh — variants are mobile-only.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const homeSource = fs.readFileSync(
  path.join(__dirname, 'src/pages/shop/TileStationHome.js'),
  'utf8',
);

// 1. The component must detect whether ALL active slides carry a
//    mobile variant — that gate decides between the tall Tile-Mountain
//    shell and the compact letterbox-with-blur fallback.
assert.match(
  homeSource,
  /const\s+allHaveMobileVariant\s*=\s*slides\.length\s*>\s*0\s*&&\s*slides\.every\(\(s\)\s*=>\s*!!s\.mobile_image\)/,
  'Component must compute `allHaveMobileVariant` so the section can ' +
    'switch between Tile-Mountain tall mobile shell (every slide has a ' +
    'variant) and the compact letterbox+blur fallback (any slide missing)',
);

// 2. Tall mobile shell when ALL slides have variants — aspect-[3/4]
//    matches Tile Mountain's tall mobile hero.
assert.match(
  homeSource,
  /allHaveMobileVariant\s*\?\s*['"]aspect-\[3\/4\]\s+sm:aspect-\[1920\/600\][^'"]*['"]/,
  'When every slide has a mobile_image, the mobile shell must be ' +
    'aspect-[3/4] so portrait variants fill edge-to-edge like Tile Mountain',
);

// 3. Compact fallback shell when ANY slide is missing a variant —
//    aspect-[2/1] + blurred backdrop (v4).
assert.match(
  homeSource,
  /:\s*['"]aspect-\[2\/1\]\s+sm:aspect-\[1920\/600\][^'"]*['"]/,
  'When any slide lacks a mobile variant, the shell must fall back ' +
    'to aspect-[2/1] (paired with the blurred letterbox backdrop)',
);

// 4. Desktop branch capped at 70vh in BOTH branches.
const allImageOnlyBlock = homeSource.match(/allImageOnly[\s\S]{0,500}h-\[50vh\]/);
assert.ok(allImageOnlyBlock, 'allImageOnly conditional block must exist');
assert.ok(
  (allImageOnlyBlock[0].match(/sm:max-h-\[70vh\]/g) || []).length >= 2,
  'Both mobile-variant and fallback branches must cap height at 70vh on desktop',
);

// 5. Legacy fallback keeps the dramatic 50-70vh height.
assert.match(
  homeSource,
  /h-\[50vh\]\s+sm:h-\[60vh\]\s+md:h-\[70vh\]/,
  'Legacy slide theme must keep the full-bleed height',
);

// 6. <img> object-fit on image-only slides:
//    • mobile variant present  → `object-cover sm:object-contain`
//    • mobile variant absent   → `object-contain`
assert.match(
  homeSource,
  /slide\.theme\s*===\s*['"]image-only['"]\s*\?\s*\(\s*slide\.mobile_image\s*\?\s*['"]object-cover\s+sm:object-contain['"]\s*:\s*['"]object-contain['"]\s*\)\s*:\s*['"]object-cover['"]/,
  'Image-only <img> must pick object-cover sm:object-contain with a ' +
    'mobile variant, fall back to object-contain otherwise; themed ' +
    'slides use object-cover',
);

// 7. Blurred letterbox backdrop is rendered for image-only slides
//    WITHOUT a mobile variant, mobile-only — preserved from v4 as the
//    graceful fallback.
assert.match(
  homeSource,
  /slide\.theme\s*===\s*['"]image-only['"]\s*&&\s*!slide\.mobile_image\s*&&\s*\(\s*<div/,
  'Blurred backdrop layer must still render for image-only slides ' +
    'that lack a mobile variant (v4 fallback retained)',
);

// 8. The blurred backdrop is mobile-only (sm:hidden), uses the slide
//    image as background, and applies a heavy blur with darken.
assert.match(
  homeSource,
  /data-testid="hero-mobile-blur-backdrop"/,
  'Blurred backdrop must carry a data-testid for QA targeting',
);
assert.match(
  homeSource,
  /sm:hidden[\s\S]{0,400}backgroundImage:\s*`url\(\$\{slide\.image\}\)`/,
  'Blurred backdrop must be hidden on sm+ and use slide.image',
);
assert.match(
  homeSource,
  /filter:\s*['"][^'"]*blur\([^'"]+\)[^'"]*brightness\(0\.55\)/,
  'Blurred backdrop must apply blur + brightness(0.55)',
);

// 9. Eager-load the first slide for LCP, lazy-load the rest.
assert.match(
  homeSource,
  /loading=\{[^}]*idx\s*===\s*0\s*\?\s*['"]eager['"]\s*:\s*['"]lazy['"]/,
  'First hero image should be eager-loaded (LCP), rest lazy',
);

console.log('✓ mobile-hero-banner-no-crop.test.js — all assertions passed');

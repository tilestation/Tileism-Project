/**
 * Regression test for the mobile-banner cropping bug
 * (24 May 2026 — user-reported "fix the mobile view urgently").
 *
 * History of fixes:
 *   v1 (`h-[50vh]` + `object-cover`)   → chopped 50%+ of the headline.
 *   v2 (`aspect-[1920/600]` everywhere)→ banner collapsed to a 122px
 *       strip on mobile — content-safe but visually tiny.
 *   v3 (`aspect-[3/2]` mobile shell)   → user reported "too small on
 *       empty sides on mobile view" (~70px navy bars top+bottom).
 *   v4 (CURRENT, this test):
 *       • `aspect-[2/1]` mobile shell → bars shrink to ~37px each.
 *       • A heavily-blurred copy of the banner is painted BEHIND the
 *         letterboxed image (mobile-only, image-only slides without
 *         an admin-uploaded mobile variant) so the remaining bars
 *         feel like a Netflix-style frame instead of dead space.
 *       • Desktop (sm+) keeps the natural 1920:600 ratio capped at 70vh.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const homeSource = fs.readFileSync(
  path.join(__dirname, 'src/pages/shop/TileStationHome.js'),
  'utf8',
);

// 1. Mobile shell uses aspect-[2/1] (banner has breathing room
//    without huge bars); sm+ reverts to natural 1920:600 ratio.
assert.match(
  homeSource,
  /allImageOnly[^?]*\?\s*['"]aspect-\[2\/1\]\s+sm:aspect-\[1920\/600\][^'"]*['"]/,
  'When all active slides are image-only, the section must use ' +
    'aspect-[2/1] on mobile + sm:aspect-[1920/600] on tablet/desktop ' +
    '— the v3 aspect-[3/2] left too much empty navy space on mobile',
);

// 2. Desktop branch capped at 70vh.
assert.match(
  homeSource,
  /allImageOnly[^?]*\?\s*['"][^'"]*sm:max-h-\[70vh\][^'"]*['"]/,
  'Image-only branch must cap height at 70vh on desktop',
);

// 3. Legacy fallback keeps the dramatic 50-70vh height.
assert.match(
  homeSource,
  /h-\[50vh\]\s+sm:h-\[60vh\]\s+md:h-\[70vh\]/,
  'Legacy slide theme must keep the full-bleed height',
);

// 4. <img> object-fit on image-only slides:
//    • mobile variant present  → `object-cover sm:object-contain`
//    • mobile variant absent   → `object-contain`
//    Legacy themed slides keep `object-cover`.
assert.match(
  homeSource,
  /slide\.theme\s*===\s*['"]image-only['"]\s*\?\s*\(\s*slide\.mobile_image\s*\?\s*['"]object-cover\s+sm:object-contain['"]\s*:\s*['"]object-contain['"]\s*\)\s*:\s*['"]object-cover['"]/,
  'Image-only <img> must pick object-cover sm:object-contain with a ' +
    'mobile variant, fall back to object-contain otherwise; themed ' +
    'slides use object-cover',
);

// 5. Blurred letterbox backdrop is rendered for image-only slides
//    WITHOUT a mobile variant, mobile-only.
assert.match(
  homeSource,
  /slide\.theme\s*===\s*['"]image-only['"]\s*&&\s*!slide\.mobile_image\s*&&\s*\(\s*<div/,
  'A blurred backdrop layer must be rendered for image-only slides ' +
    'that lack a mobile variant, so the ~37px letterbox bars do not ' +
    'look like empty navy slabs on mobile',
);

// 6. The blurred backdrop is mobile-only (sm:hidden), uses the slide
//    image as background, and applies a heavy blur with darken so
//    the foreground banner stays the focal point.
assert.match(
  homeSource,
  /data-testid="hero-mobile-blur-backdrop"/,
  'Blurred backdrop must carry a data-testid for QA targeting',
);
assert.match(
  homeSource,
  /sm:hidden[\s\S]{0,400}backgroundImage:\s*`url\(\$\{slide\.image\}\)`/,
  'Blurred backdrop must be hidden on sm+ and use slide.image as the ' +
    'background-image (a heavily-blurred copy of the same banner)',
);
assert.match(
  homeSource,
  /filter:\s*['"][^'"]*blur\([^'"]+\)[^'"]*brightness\(0\.55\)/,
  'Blurred backdrop must apply blur + brightness(0.55) so the foreground ' +
    'banner remains the visual focal point',
);

// 7. Eager-load the first slide for LCP, lazy-load the rest.
assert.match(
  homeSource,
  /loading=\{[^}]*idx\s*===\s*0\s*\?\s*['"]eager['"]\s*:\s*['"]lazy['"]/,
  'First hero image should be eager-loaded (LCP), rest lazy',
);

console.log('✓ mobile-hero-banner-no-crop.test.js — all assertions passed');

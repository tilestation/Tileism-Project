/**
 * Regression test for the mobile-banner cropping bug
 * (24 May 2026 — user-reported "fix the mobile view urgently").
 *
 * Background:
 *   Marketing-Studio AI banners are designed at 1920×600 (3.2:1
 *   landscape) with the headline, sale copy, CTA button and lifestyle
 *   imagery ALL baked into the image.
 *
 *   v1 of this fix used `object-cover` + `h-[50vh]` — that cropped
 *   huge swathes off the banner sides ("AY SALE / 70% OFF" instead of
 *   "BANK HOLIDAY SALE / UP TO 70% OFF").
 *
 *   v2 tried `aspect-[1920/600]` for every viewport — content was
 *   intact but the banner collapsed to a 122px-tall strip on a 390px
 *   mobile, unreadable.
 *
 *   v3 (CURRENT contract): mobile uses a taller `aspect-[3/2]` shell
 *   with `object-contain` — banner displays at its natural ratio
 *   inside a slate-900 letterbox, giving the hero ~260px of presence
 *   above the fold. Desktop (sm+) reverts to the banner's natural
 *   1920:600 ratio capped at 70vh.
 *
 * Contract pinned:
 *   1. When ALL slides are `theme === 'image-only'`, the section
 *      uses `aspect-[3/2]` on mobile and `sm:aspect-[1920/600]` on
 *      tablet/desktop — banner content is NEVER cropped.
 *   2. Image-only slides MUST use `object-contain` so even an
 *      atypical aspect-ratio banner stays whole.
 *   3. Legacy themed slides (sale/general) keep `object-cover` +
 *      `h-[50vh]` so their overlay text renders against a full-bleed
 *      backdrop.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const homeSource = fs.readFileSync(
  path.join(__dirname, 'src/pages/shop/TileStationHome.js'),
  'utf8',
);

// 1. Image-only branch uses a mobile-friendly aspect ratio FIRST and
//    upgrades to the natural 1920:600 on sm+ so the banner is
//    readable on phones AND prominent on desktop.
assert.match(
  homeSource,
  /allImageOnly[^?]*\?\s*['"]aspect-\[3\/2\]\s+sm:aspect-\[1920\/600\][^'"]*['"]/,
  'When all active slides are image-only, the section must use ' +
    'aspect-[3/2] on mobile + sm:aspect-[1920/600] on tablet/desktop ' +
    'so the marketing-studio banner is readable on phones and natural on desktop',
);

// 2. Desktop branch is capped at 70vh so the banner stays prominent
//    on laptops without dominating large monitors.
assert.match(
  homeSource,
  /allImageOnly[^?]*\?\s*['"][^'"]*sm:max-h-\[70vh\][^'"]*['"]/,
  'Image-only branch must cap height at 70vh on desktop so the banner ' +
    'never dominates large monitors',
);

// 3. The legacy fallback keeps the dramatic 50-70vh height.
assert.match(
  homeSource,
  /h-\[50vh\]\s+sm:h-\[60vh\]\s+md:h-\[70vh\]/,
  'Legacy slide theme must keep the full-bleed height',
);

// 4. <img> object-fit on image-only slides:
//    • mobile variant present  → `object-cover sm:object-contain`
//      (variant fills the shell on mobile, main image letterboxes on sm+).
//    • mobile variant absent   → `object-contain` (letterbox everywhere).
//    Legacy themed slides keep `object-cover` for full-bleed overlay text.
assert.match(
  homeSource,
  /slide\.theme\s*===\s*['"]image-only['"]\s*\?\s*\(\s*slide\.mobile_image\s*\?\s*['"]object-cover\s+sm:object-contain['"]\s*:\s*['"]object-contain['"]\s*\)\s*:\s*['"]object-cover['"]/,
  'Image-only <img> must pick object-cover sm:object-contain when a ' +
    'mobile variant is present, fall back to object-contain otherwise, ' +
    'and legacy themed slides must still use object-cover',
);

// 5. Eager-load the first slide for LCP, lazy-load the rest.
assert.match(
  homeSource,
  /loading=\{[^}]*idx\s*===\s*0\s*\?\s*['"]eager['"]\s*:\s*['"]lazy['"]/,
  'First hero image should be eager-loaded (LCP), rest lazy',
);

console.log('✓ mobile-hero-banner-no-crop.test.js — all assertions passed');

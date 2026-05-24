/**
 * Regression test for the storefront <picture> swap for the optional
 * mobile banner variant (24 May 2026, user-requested).
 *
 * Contract pinned:
 *   1. The hero carousel wraps every slide image in a <picture>
 *      element so the browser can pick the best source.
 *   2. When `slide.mobile_image` is truthy, a <source> element with
 *      `media="(max-width: 639px)"` and `srcSet={slide.mobile_image}`
 *      is rendered — phones <640px get the mobile variant, larger
 *      viewports fall through to the main <img>.
 *   3. The <img> fallback always uses `slide.image` so legacy slides
 *      and slides without a mobile variant keep working.
 *   4. When a mobile variant IS present on an image-only slide, the
 *      <img> switches to `object-cover sm:object-contain` — the
 *      variant was designed to fill the aspect-[3/2] shell on mobile,
 *      so we drop the letterbox bars there but keep object-contain
 *      on tablet/desktop where the main landscape image is used.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const homeSource = fs.readFileSync(
  path.join(__dirname, 'src/pages/shop/TileStationHome.js'),
  'utf8',
);

// 1. There IS a <picture> element wrapping the carousel image.
assert.match(
  homeSource,
  /<picture>[\s\S]*<\/picture>/,
  'Hero carousel must wrap the image in a <picture> element so the ' +
    'browser can swap in the mobile variant on small viewports',
);

// 2. <source media="(max-width: 639px)"> is gated on slide.mobile_image
//    and uses srcSet={slide.mobile_image}.
assert.match(
  homeSource,
  /\{slide\.mobile_image\s*&&\s*\(\s*<source\s+media="\(max-width:\s*639px\)"\s+srcSet=\{slide\.mobile_image\}\s*\/>\s*\)\s*\}/,
  'A <source media="(max-width: 639px)" srcSet={slide.mobile_image} /> ' +
    'must be rendered ONLY when slide.mobile_image is set so legacy ' +
    'slides keep working with a bare <img>',
);

// 3. <img> always falls back to slide.image.
assert.match(
  homeSource,
  /<img\s+src=\{slide\.image\}/,
  'The fallback <img> must use slide.image so browsers without ' +
    '<picture> support and legacy slides keep working',
);

// 4. Image-only + mobile_image → object-cover on mobile, object-contain on sm+.
assert.match(
  homeSource,
  /slide\.mobile_image\s*\?\s*['"]object-cover\s+sm:object-contain['"]\s*:\s*['"]object-contain['"]/,
  'When an image-only slide carries a mobile variant, the <img> ' +
    'must use object-cover on mobile (variant fills the shell) and ' +
    'object-contain on sm+ (main landscape image, letterbox safe)',
);

console.log('✓ hero-carousel-mobile-variant.test.js — all assertions passed');

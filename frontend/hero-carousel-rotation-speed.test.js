/**
 * Regression test for the homepage HeroBannerCarousel rotation-speed
 * feature (24 May 2026, user-requested).
 *
 * Contract pinned (via static source-text checks on TileStationHome.js):
 *   1. The auto-advance setInterval MUST read a per-slide
 *      `rotation_seconds` value (multiplied by 1000 for ms) instead
 *      of the historical hardcoded 5000ms.
 *   2. The effect must fall back to 5s if no slide provides a value
 *      so admins who don't touch the new control see no change.
 *   3. The effect MUST clamp to 2-30s defensively — bad data should
 *      not crash the carousel.
 *
 * Run: `cd /app/frontend && node hero-carousel-rotation-speed.test.js`
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const heroSource = fs.readFileSync(
  path.join(__dirname, 'src/pages/shop/TileStationHome.js'),
  'utf8',
);

// 1. Must NOT use the literal 5000 anymore.
assert.equal(
  /setInterval\([^,]+,\s*5000\s*\)/.test(heroSource),
  false,
  'HeroBannerCarousel must not hardcode 5000ms — it must read ' +
    'rotation_seconds from the slide. Old behaviour: setInterval(..., 5000).',
);

// 2. Must read `rotation_seconds` from at least one slide.
assert.match(
  heroSource,
  /rotation_seconds/,
  'Carousel must consume slide.rotation_seconds',
);

// 3. Must convert seconds → milliseconds (* 1000).
assert.match(
  heroSource,
  /\*\s*1000/,
  'Rotation seconds must be multiplied by 1000 for setInterval',
);

// 4. Fallback to 5s when nothing is set.
assert.match(
  heroSource,
  /\|\|\s*5\)\s*\*\s*1000/,
  'Must fall back to 5s when slides carry no rotation_seconds',
);

// 5. Defensive clamp to 2-30s on the frontend too.
assert.match(
  heroSource,
  /n\s*>=\s*2\s*&&\s*n\s*<=\s*30/,
  'Must clamp rotation_seconds to 2-30s to handle bad data',
);

console.log('✓ hero-carousel-rotation-speed.test.js — all assertions passed');

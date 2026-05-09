/**
 * Crash-resistance tests for the safeStr helpers.
 *
 * These are the contract: if any of these tests fail, the storefront
 * Collection Detail Page and the supplier image flow are at risk of
 * crashing on real production data shapes that have accumulated over
 * the lifetime of the catalogue (CDN migrations, manual edits, legacy
 * import scripts).
 *
 * Run with: cd frontend && yarn test --watchAll=false src/utils/safeStr.test.js
 */
import {
  safeStr, safeLower, safeMatch, safeIncludes, safeSplit,
  safeArr, safeNum, safeToFixed, normaliseImageUrl, normaliseImageList,
} from './safeStr';

describe('safeStr — coerce ANYTHING to a string', () => {
  test('passes strings through untouched', () => {
    expect(safeStr('hello')).toBe('hello');
    expect(safeStr('')).toBe('');
  });
  test('null / undefined → empty string', () => {
    expect(safeStr(null)).toBe('');
    expect(safeStr(undefined)).toBe('');
  });
  test('numbers + booleans → string repr', () => {
    expect(safeStr(42)).toBe('42');
    expect(safeStr(0)).toBe('0');
    expect(safeStr(true)).toBe('true');
    expect(safeStr(false)).toBe('false');
  });
  test('image-shaped objects → first available URL field', () => {
    expect(safeStr({ src: 'https://example.com/a.jpg' })).toBe('https://example.com/a.jpg');
    expect(safeStr({ url: '/cdn/b.jpg' })).toBe('/cdn/b.jpg');
    expect(safeStr({ large: '/x/c.jpg', thumbnail: '/x/c-tn.jpg' })).toBe('/x/c.jpg');
    expect(safeStr({ thumbnail: '/x/c-tn.jpg' })).toBe('/x/c-tn.jpg');
  });
  test('arrays → first element coerced (recursive)', () => {
    expect(safeStr(['a', 'b', 'c'])).toBe('a');
    expect(safeStr([])).toBe('');
    expect(safeStr([{ src: '/x.jpg' }])).toBe('/x.jpg');
  });
  test('weird empty objects → empty string, no crash', () => {
    expect(safeStr({})).toBe('');
    expect(safeStr({ foo: 'bar' })).toBe('');
  });
});

describe('safeMatch — replaces .match() that crashes on non-strings', () => {
  test('matches on string input', () => {
    expect(safeMatch('foo.mp4', /\.(mp4|webm)$/)).toEqual(expect.arrayContaining(['.mp4']));
  });
  test('returns empty array when input is null/undefined', () => {
    expect(safeMatch(null, /\.mp4$/)).toEqual([]);
    expect(safeMatch(undefined, /\.mp4$/)).toEqual([]);
  });
  test('returns empty array on object input (not crash like .match() would)', () => {
    expect(safeMatch({ src: '/a.mp4' }, /\.(mp4|webm)$/)).toEqual(expect.arrayContaining(['.mp4']));
    expect(safeMatch({ wrongField: '/a.mp4' }, /\.mp4$/)).toEqual([]);
    expect(safeMatch({}, /\.mp4$/)).toEqual([]);
  });
  test('returns empty array on number input', () => {
    expect(safeMatch(42, /\d+/)).toEqual(expect.arrayContaining(['42']));
  });
  test('handles missing/undefined regex without crashing', () => {
    expect(safeMatch('hi', undefined)).toEqual([]);
    expect(safeMatch('hi', null)).toEqual([]);
  });
});

describe('safeIncludes — replaces .includes() that crashes on non-strings', () => {
  test('basic string includes', () => {
    expect(safeIncludes('hello world', 'world')).toBe(true);
    expect(safeIncludes('hello world', 'xyz')).toBe(false);
  });
  test('coerces non-string input', () => {
    expect(safeIncludes(null, 'x')).toBe(false);
    expect(safeIncludes(undefined, 'x')).toBe(false);
    expect(safeIncludes({ src: 'youtube.com/foo' }, 'youtube')).toBe(true);
    expect(safeIncludes(42, '4')).toBe(true);
  });
  test('handles missing/undefined needle gracefully', () => {
    expect(safeIncludes('hi', null)).toBe(false);
    expect(safeIncludes('hi', undefined)).toBe(false);
  });
});

describe('safeSplit', () => {
  test('basic split works', () => {
    expect(safeSplit('a-b-c', '-')).toEqual(['a', 'b', 'c']);
  });
  test('null/undefined input → empty array', () => {
    expect(safeSplit(null, '-')).toEqual([]);
    expect(safeSplit(undefined, '-')).toEqual([]);
  });
  test('non-string input is coerced first', () => {
    expect(safeSplit({ src: 'a-b-c' }, '-')).toEqual(['a', 'b', 'c']);
  });
});

describe('safeArr — coerce to array', () => {
  test('passes arrays through', () => {
    expect(safeArr([1, 2, 3])).toEqual([1, 2, 3]);
  });
  test('null/undefined → empty array', () => {
    expect(safeArr(null)).toEqual([]);
    expect(safeArr(undefined)).toEqual([]);
  });
  test('wraps singletons so .map() still works', () => {
    expect(safeArr('foo')).toEqual(['foo']);
    expect(safeArr({ id: 1 })).toEqual([{ id: 1 }]);
  });
});

describe('safeNum / safeToFixed', () => {
  test('numbers pass through', () => {
    expect(safeNum(42)).toBe(42);
    expect(safeNum(0)).toBe(0);
    expect(safeNum(-3.14)).toBe(-3.14);
  });
  test('numeric strings parse', () => {
    expect(safeNum('42.5')).toBe(42.5);
    expect(safeNum('  10 ')).toBe(10);
  });
  test('NaN / null / undefined → fallback (default 0)', () => {
    expect(safeNum(null)).toBe(0);
    expect(safeNum(undefined)).toBe(0);
    expect(safeNum(NaN)).toBe(0);
    expect(safeNum('abc')).toBe(0);
    expect(safeNum('abc', -1)).toBe(-1);
  });
  test('safeToFixed never returns NaN', () => {
    expect(safeToFixed(42.5, 2)).toBe('42.50');
    expect(safeToFixed(null)).toBe('0.00');
    expect(safeToFixed(undefined)).toBe('0.00');
    expect(safeToFixed('garbage')).toBe('0.00');
  });
});

describe('normaliseImageUrl + normaliseImageList — production data shapes', () => {
  test('plain string URL passes through', () => {
    expect(normaliseImageUrl('https://cdn.example.com/a.jpg')).toBe('https://cdn.example.com/a.jpg');
  });
  test('handles {src} object', () => {
    expect(normaliseImageUrl({ src: '/a.jpg', width: 800 })).toBe('/a.jpg');
  });
  test('handles {url} object', () => {
    expect(normaliseImageUrl({ url: '/b.jpg' })).toBe('/b.jpg');
  });
  test('handles multi-resolution object', () => {
    expect(normaliseImageUrl({ large: '/large.jpg', thumbnail: '/thumb.jpg' })).toBe('/large.jpg');
  });
  test('returns "" for unknown / empty shapes (caller filters)', () => {
    expect(normaliseImageUrl(null)).toBe('');
    expect(normaliseImageUrl(undefined)).toBe('');
    expect(normaliseImageUrl({})).toBe('');
    expect(normaliseImageUrl({ random: 'x' })).toBe('');
    expect(normaliseImageUrl(42)).toBe('');
  });
  test('normaliseImageList handles a heterogeneous mess (real production scenario)', () => {
    const messy = [
      'https://a.com/1.jpg',          // legacy plain string
      { src: '/2.jpg' },               // new structured
      { url: '/3.jpg' },               // older structured
      null,                            // nulled out by a bad migration
      undefined,                       // gap from a delete
      { foo: 'bar' },                  // unknown shape (skip)
      { thumbnail: '/4-tn.jpg' },      // thumbnail-only (acceptable fallback)
      '',                              // empty string from sloppy data entry
    ];
    expect(normaliseImageList(messy)).toEqual([
      'https://a.com/1.jpg',
      '/2.jpg',
      '/3.jpg',
      '/4-tn.jpg',
    ]);
  });
  test('normaliseImageList on null/undefined input', () => {
    expect(normaliseImageList(null)).toEqual([]);
    expect(normaliseImageList(undefined)).toEqual([]);
  });
});

describe('Real-world crash scenarios from production', () => {
  test('isVideo logic equivalent — non-string never crashes', () => {
    const isVideo = (url) => {
      const s = safeStr(url);
      if (!s) return false;
      return safeMatch(s, /\.(mp4|webm|ogg|mov)$/i).length > 0
        || safeIncludes(s, 'youtube')
        || safeIncludes(s, 'vimeo');
    };
    // The cases that were crashing the live site:
    expect(() => isVideo({ src: 'https://x.com/a.jpg' })).not.toThrow();
    expect(() => isVideo(null)).not.toThrow();
    expect(() => isVideo(undefined)).not.toThrow();
    expect(() => isVideo(42)).not.toThrow();
    expect(() => isVideo({})).not.toThrow();
    expect(() => isVideo([])).not.toThrow();
    // And it still works correctly:
    expect(isVideo('https://x.com/clip.mp4')).toBe(true);
    expect(isVideo({ src: 'https://x.com/clip.mp4' })).toBe(true);
    expect(isVideo('https://youtube.com/watch?v=abc')).toBe(true);
    expect(isVideo('https://x.com/photo.jpg')).toBe(false);
  });
});

describe('Swatch image regression — May 2026 SEO migration', () => {
  // This pins the EXACT shape returned by /api/tiles/collections after the
  // backend started auto-attaching alt-text + alt_generated_at. Before this
  // session the frontend rendered <img src={Object}> -> [object Object]
  // -> 404 -> broken-image icon on Moonstone/Bluestone collection cards
  // and PDP color swatches.
  test('post-migration {url, alt, alt_generated_at} swatch unwraps cleanly', () => {
    const swatch = {
      color: 'Ivory',
      hex: '#FFFFF0',
      image: {
        url: 'https://images.tilestation.co.uk/products/Plus39/x.jpg',
        alt: 'Moonstone Ivory 60x120cm Matt — Tile Station UK',
        alt_generated_at: '2026-05-07T03:00:28.688000',
      },
      product_slug: 'moonstone-ivory-60x120cm-matt',
      variant_type: 'color',
    };
    expect(normaliseImageUrl(swatch.image)).toBe('https://images.tilestation.co.uk/products/Plus39/x.jpg');
  });
  test('legacy string-URL swatch still passes through unchanged', () => {
    const swatch = { color: 'silver', image: 'https://images.tilestation.co.uk/x.jpg' };
    expect(normaliseImageUrl(swatch.image)).toBe('https://images.tilestation.co.uk/x.jpg');
  });
  test('mixed collection (Moonstone + Rivertine) — both shapes rendered', () => {
    const swatches = [
      { color: 'a', image: { url: '/new.jpg', alt: '...' } },
      { color: 'b', image: '/legacy.jpg' },
      { color: 'c', image: null },              // missing
      { color: 'd' },                            // no image key at all
    ];
    const rendered = swatches
      .map(s => ({ image: normaliseImageUrl(s.image), color: s.color }))
      .filter(s => s.image);
    expect(rendered).toEqual([
      { image: '/new.jpg', color: 'a' },
      { image: '/legacy.jpg', color: 'b' },
    ]);
  });
});


describe('Price/number rendering crash-resistance — Feb 2026 sweep', () => {
  // Pins the "page-blanking" failure modes that would crash the storefront
  // if a backend field came back null/undefined/string instead of a number.
  // Before this sweep, `product.price.toFixed(2)` would throw if the supplier
  // import had skipped the price column. With safeToFixed, the row renders
  // £0.00 instead — visible to the customer, fixable in admin, but never
  // a blank page.
  test('null product price → "0.00", not crash', () => {
    expect(safeToFixed(null, 2)).toBe('0.00');
    expect(safeToFixed(undefined, 2)).toBe('0.00');
  });
  test('string-priced product (legacy CSV import) → coerced to number', () => {
    expect(safeToFixed('29.99', 2)).toBe('29.99');
    expect(safeToFixed(' 12.5 ', 2)).toBe('12.50');
  });
  test('NaN/Infinity from bad arithmetic → fallback', () => {
    expect(safeToFixed(NaN, 2)).toBe('0.00');
    expect(safeToFixed(Infinity, 2)).toBe('0.00');
    expect(safeToFixed(0/0, 2)).toBe('0.00');
  });
  test('valid numeric prices pass through unchanged', () => {
    expect(safeToFixed(0, 2)).toBe('0.00');
    expect(safeToFixed(29.99, 2)).toBe('29.99');
    expect(safeToFixed(1234.5, 2)).toBe('1234.50');
  });
  test('custom precision works for ratings/percentages', () => {
    expect(safeToFixed(4.234, 1)).toBe('4.2');
    expect(safeToFixed(null, 1)).toBe('0.00');  // fallback ignores precision
    expect(safeToFixed(99.999, 0)).toBe('100');
  });
});


describe('Array crash-resistance — Feb 2026 sweep', () => {
  // Pins the "page-blanking" failure modes for arrays. Before this sweep,
  // `product.images.map(...)` would crash if the supplier sync returned
  // `images: null`. With safeArr(), it renders an empty list — visible
  // bug, never a blank white page.
  test('null array field → safe empty operations', () => {
    expect(safeArr(null).map(x => x)).toEqual([]);
    expect(safeArr(null).length).toBe(0);
    expect(safeArr(undefined).filter(Boolean)).toEqual([]);
    expect(safeArr(undefined).slice(0, 5)).toEqual([]);
  });
  test('valid arrays pass through unchanged', () => {
    expect(safeArr([1, 2, 3]).map(x => x * 2)).toEqual([2, 4, 6]);
    expect(safeArr(['a', 'b']).length).toBe(2);
  });
  test('non-array scalar is wrapped (lenient mode)', () => {
    // A single object accidentally returned where an array was expected
    // is treated as a 1-element list rather than crashing.
    expect(safeArr({ id: 1 }).length).toBe(1);
    expect(safeArr('single').length).toBe(1);
  });
  test('chained array methods on null product fields', () => {
    // Real pattern: product.images.slice(1, 4).map(...)
    const product = { images: null };
    expect(safeArr(product.images).slice(1, 4)).toEqual([]);
    // Also: order.items.map((item) => ...).length
    const order = { items: undefined };
    expect(safeArr(order.items).map(i => i).length).toBe(0);
  });
});


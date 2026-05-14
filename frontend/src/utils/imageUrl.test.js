/**
 * Regression test for the image URL helpers (May 14, 2026)
 *
 * Documents the contract: helpers must accept BOTH the legacy string
 * shape AND the new {url, alt, alt_generated_at} object shape returned
 * by the production backend after the alt-text generator was wired in.
 *
 * Reported three times before being correctly diagnosed — keeping this
 * test means the contract is locked.
 */
import { imageUrl, firstImageUrl, imageAlt } from './imageUrl';

describe('imageUrl helpers — prod object-shape compatibility', () => {
  test('imageUrl: string passthrough', () => {
    expect(imageUrl('https://images.tilestation.co.uk/a.jpg')).toBe(
      'https://images.tilestation.co.uk/a.jpg'
    );
  });
  test('imageUrl: prod object shape returns the url', () => {
    expect(
      imageUrl({
        url: 'https://images.tilestation.co.uk/b.jpg',
        alt: 'X',
        alt_generated_at: 'Y',
      })
    ).toBe('https://images.tilestation.co.uk/b.jpg');
  });
  test('imageUrl: empties → empty string', () => {
    expect(imageUrl(null)).toBe('');
    expect(imageUrl(undefined)).toBe('');
    expect(imageUrl('')).toBe('');
    expect(imageUrl({})).toBe('');
  });
  test('imageUrl: object without url → empty string', () => {
    expect(imageUrl({ alt: 'only alt' })).toBe('');
  });
  test('firstImageUrl: array of strings', () => {
    expect(firstImageUrl(['https://a.jpg', 'https://b.jpg'])).toBe('https://a.jpg');
  });
  test('firstImageUrl: prod array of objects', () => {
    expect(
      firstImageUrl([
        { url: 'https://a.jpg', alt: 'A' },
        { url: 'https://b.jpg', alt: 'B' },
      ])
    ).toBe('https://a.jpg');
  });
  test('firstImageUrl: mixed array skips empties', () => {
    expect(firstImageUrl([{}, { url: 'https://c.jpg' }, 'https://d.jpg'])).toBe('https://c.jpg');
  });
  test('firstImageUrl: empty/null array → empty string', () => {
    expect(firstImageUrl([])).toBe('');
    expect(firstImageUrl(null)).toBe('');
    expect(firstImageUrl(undefined)).toBe('');
  });
  test('imageAlt: extracts alt from object', () => {
    expect(imageAlt({ url: 'x', alt: 'Tile X' }, 'fallback')).toBe('Tile X');
  });
  test('imageAlt: falls back when string', () => {
    expect(imageAlt('https://a.jpg', 'fallback')).toBe('fallback');
  });
});

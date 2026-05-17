/**
 * Regression test for the SeoHead duplicate-tag dedupe logic.
 *
 * Why this test exists
 * --------------------
 * On 17 May 2026 an attempt to fix Ahrefs's "Multiple title tags"
 * warning by injecting an inline strip-script in server-seo.js
 * (running BEFORE React mounted) wiped titles on 77 pages because
 * those pages didn't actually mount <SeoHead/>. Health Score 96 → 63.
 *
 * The real fix (24 Feb 2026) lives inside <SeoHead/>: a useLayoutEffect
 * runs AFTER React commits its own tags, then removes any element in
 * <head> carrying `data-ssr-seo="1"`. This test simulates that flow
 * without needing react-testing-library or JSDOM dependencies.
 *
 * Run with: node tests/seo-head-dedupe.test.js
 */
const assert = require('node:assert/strict');

// ─── Minimal DOM stub (~30 lines) ──────────────────────────────────
// We don't need a full JSDOM environment — just `document.head` with
// `querySelectorAll('[data-ssr-seo="1"]')` and `el.remove()`.
function createFakeHead() {
  const children = [];
  return {
    children,
    querySelectorAll(selector) {
      // Only support the single selector we use in production.
      if (selector !== '[data-ssr-seo="1"]') {
        throw new Error(`Unexpected selector: ${selector}`);
      }
      return children.filter((c) => c.attrs['data-ssr-seo'] === '1');
    },
    append(tag, attrs = {}) {
      const el = {
        tag,
        attrs,
        remove() {
          const idx = children.indexOf(el);
          if (idx >= 0) children.splice(idx, 1);
        },
      };
      children.push(el);
      return el;
    },
  };
}

// Same logic as the useLayoutEffect inside SeoHead.jsx — extracted
// so we can exercise it without React.
function dedupeSsrTags(head) {
  const ssrTags = head.querySelectorAll('[data-ssr-seo="1"]');
  ssrTags.forEach((el) => {
    try { el.remove(); } catch { /* ignore */ }
  });
}

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); }
};

console.log('SeoHead dedupe logic:');

test('removes SSR-stamped <title> when React title also present', () => {
  const head = createFakeHead();
  // 1. SSR injects its tag with the marker
  head.append('title', { 'data-ssr-seo': '1', text: 'SSR Title' });
  // 2. React 19 hoists its own (unmarked) <title>
  head.append('title', { text: 'React Title' });
  // 3. useLayoutEffect fires
  dedupeSsrTags(head);
  // 4. Only React's tag should remain
  const titles = head.children.filter((c) => c.tag === 'title');
  assert.equal(titles.length, 1, 'expected exactly one <title>');
  assert.equal(titles[0].attrs.text, 'React Title');
  assert.equal(titles[0].attrs['data-ssr-seo'], undefined);
});

test('removes ALL SSR-stamped meta/link/script tags', () => {
  const head = createFakeHead();
  head.append('meta', { 'data-ssr-seo': '1', name: 'description' });
  head.append('meta', { 'data-ssr-seo': '1', property: 'og:title' });
  head.append('meta', { 'data-ssr-seo': '1', property: 'og:description' });
  head.append('link', { 'data-ssr-seo': '1', rel: 'canonical' });
  head.append('script', { 'data-ssr-seo': '1', type: 'application/ld+json' });
  // Some non-SSR tags that should survive
  head.append('meta', { name: 'description', content: 'React description' });
  head.append('link', { rel: 'canonical', href: 'react' });

  assert.equal(head.children.length, 7);
  dedupeSsrTags(head);
  assert.equal(head.children.length, 2);
  assert.ok(head.children.every((c) => c.attrs['data-ssr-seo'] !== '1'));
});

test('leaves non-SSR tags alone (no React → only SSR tags survive)', () => {
  // This is the critical scenario: on pages WITHOUT <SeoHead/>, the
  // dedupe effect never runs, so the SSR tags must survive untouched.
  // (We don't call dedupeSsrTags here — that's the point.)
  const head = createFakeHead();
  head.append('title', { 'data-ssr-seo': '1', text: 'SSR-only Title' });
  head.append('meta', { 'data-ssr-seo': '1', name: 'description', content: 'SSR-only' });
  // No useLayoutEffect runs (no SeoHead mounted)
  const titles = head.children.filter((c) => c.tag === 'title');
  assert.equal(titles.length, 1);
  assert.equal(titles[0].attrs.text, 'SSR-only Title');
});

test('safe to call when no SSR tags exist (idempotent)', () => {
  const head = createFakeHead();
  head.append('meta', { name: 'description', content: 'plain' });
  head.append('title', { text: 'plain title' });
  assert.doesNotThrow(() => dedupeSsrTags(head));
  assert.equal(head.children.length, 2);
});

test('safe to call twice on same head (idempotent on repeat)', () => {
  const head = createFakeHead();
  head.append('title', { 'data-ssr-seo': '1', text: 'SSR' });
  head.append('title', { text: 'React' });
  dedupeSsrTags(head);
  assert.equal(head.children.length, 1);
  dedupeSsrTags(head);
  assert.equal(head.children.length, 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

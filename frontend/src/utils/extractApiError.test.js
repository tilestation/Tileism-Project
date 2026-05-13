/**
 * Unit tests for extractApiError.
 * Run: cd /app/frontend && node src/utils/extractApiError.test.js
 */
const assert = require('node:assert/strict');
const { extractApiError } = require('/tmp/extractApiError.cjs.js');

let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name} — ${e.message}`); }
}

console.log('extractApiError:');

t('returns string detail as-is', () => {
  const err = { response: { data: { detail: 'Email already registered' } } };
  assert.equal(extractApiError(err), 'Email already registered');
});

t('joins array of Pydantic validation errors', () => {
  const err = { response: { data: { detail: [
    { loc: ['body', 'email'], msg: 'field required', type: 'value_error' },
    { loc: ['body', 'password'], msg: 'too short', type: 'value_error' },
  ] } } };
  const msg = extractApiError(err);
  assert.match(msg, /email: field required/);
  assert.match(msg, /password: too short/);
});

t('falls back when detail is empty list', () => {
  const err = { response: { data: { detail: [] } } };
  assert.equal(extractApiError(err, 'fallback msg'), 'fallback msg');
});

t('handles nested object detail with message key', () => {
  const err = { response: { data: { detail: { message: 'X is broken', code: 5 } } } };
  assert.equal(extractApiError(err), 'X is broken');
});

t('falls back to error.message when no response', () => {
  const err = { message: 'Network Error' };
  assert.equal(extractApiError(err), 'Network Error');
});

t('uses response.data.message if detail is missing', () => {
  const err = { response: { data: { message: 'Service unavailable' } } };
  assert.equal(extractApiError(err), 'Service unavailable');
});

t('uses statusText when nothing else available', () => {
  const err = { response: { status: 503, statusText: 'Service Unavailable', data: {} } };
  assert.equal(extractApiError(err), '503: Service Unavailable');
});

t('uses default fallback for null', () => {
  assert.equal(extractApiError(null, 'default'), 'default');
});

t('uses default fallback for undefined', () => {
  assert.equal(extractApiError(undefined, 'default'), 'default');
});

t('handles plain string error', () => {
  assert.equal(extractApiError('Something broke'), 'Something broke');
});

console.log(`\nextractApiError — ${pass} passed, ${fail} failed`);
assert.equal(fail, 0);

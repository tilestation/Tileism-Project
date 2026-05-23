/**
 * Regression test for the Device-Approval magic-link proxy.
 *
 * Bug (23 May 2026):
 *   Production emails carried buttons pointing at
 *     https://tilestation.co.uk/api/device-approvals/{id}/approve?token=…
 *   Without an Express proxy rule, those requests hit the SPA fallback,
 *   React Router bounced unknown paths to "/", and the admin always
 *   landed on the homepage instead of the approve/deny handler.
 *
 * Contract this test pins:
 *   1. /api/device-approvals MUST be registered as a proxy mount point
 *      in server.js (literal string match against the source file —
 *      cheap, no need to boot Express).
 *   2. The proxy MUST forward to the FastAPI backend (BACKEND_URL),
 *      not be rewritten or redirected.
 *
 * Run: `cd /app/frontend && node device-approval-proxy.test.js`
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverSource = fs.readFileSync(
  path.join(__dirname, 'server.js'),
  'utf8',
);

// 1. The mount path MUST exist as an app.use(...) registration.
assert.match(
  serverSource,
  /app\.use\(\s*['"]\/api\/device-approvals['"]\s*,\s*deviceApprovalProxy\s*\)/,
  '/api/device-approvals must be proxied to the FastAPI backend — ' +
    'without this rule, clicking Approve/Deny in the email lands on /',
);

// 2. The proxy config MUST target BACKEND_URL (not a hardcoded host).
const proxyBlock = serverSource.slice(
  serverSource.indexOf('const deviceApprovalProxy'),
  serverSource.indexOf('app.use(\'/api/device-approvals\''),
);
assert.match(
  proxyBlock,
  /target:\s*BACKEND_URL/,
  'device-approval proxy must forward to BACKEND_URL — never hardcode a host',
);

// 3. changeOrigin should be true so the FastAPI side sees the right Host.
assert.match(
  proxyBlock,
  /changeOrigin:\s*true/,
  'proxy must set changeOrigin:true to avoid CORS / SNI issues',
);

console.log('✓ device-approval-proxy.test.js — all assertions passed');

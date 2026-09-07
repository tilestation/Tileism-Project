// Writes public/build-info.json at build time so the live site can be checked at
// https://www.tilestation.co.uk/build-info.json (commit + build time) after a deploy.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let commit = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.SOURCE_COMMIT || '';
if (!commit) {
  try { commit = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (_) { commit = 'unknown'; }
}
const info = {
  commit,
  short: commit.slice(0, 7),
  branch: process.env.RAILWAY_GIT_BRANCH || '',
  built_at: new Date().toISOString(),
};
fs.writeFileSync(path.join(__dirname, '..', 'public', 'build-info.json'), JSON.stringify(info, null, 2));
console.log(`build-info.json → ${info.short} @ ${info.built_at}`);

#!/usr/bin/env node
// Auto-build dist/ when missing. Lets `npm test` work cold without the user
// having to remember the `npm run build` step.
import { existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const DIST = 'dist';
const SRC = 'src';

function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    const m = entry.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs;
    if (m > newest) newest = m;
  }
  return newest;
}

let needsBuild = false;
if (!existsSync(DIST) || !existsSync(join(DIST, 'index.html'))) {
  console.log('• dist/ missing — building first');
  needsBuild = true;
} else if (existsSync(SRC)) {
  // Stale check: any source file newer than dist/index.html → rebuild
  const distMtime = statSync(join(DIST, 'index.html')).mtimeMs;
  const srcMtime = newestMtime(SRC);
  if (srcMtime > distMtime) {
    console.log('• dist/ stale (src/ has newer files) — rebuilding');
    needsBuild = true;
  }
}

if (needsBuild) {
  execSync('npm run build', { stdio: 'inherit' });
}

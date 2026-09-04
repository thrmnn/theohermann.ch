#!/usr/bin/env node
// Install an opt-in git pre-push hook that runs `npm run preflight` so a
// broken build can't reach origin. Run once per clone:
//
//   npm run install-hooks
//
// Removing: just delete .git/hooks/pre-push.
import { existsSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const HOOK = '.git/hooks/pre-push';
const BODY = `#!/usr/bin/env bash
# Auto-installed by \`npm run install-hooks\`. Runs the same checks that gate
# the deploy pipeline. Skip with \`git push --no-verify\` if you must.
set -e
echo "→ pre-push: running npm run preflight"
npm run preflight
`;

if (!existsSync('.git')) {
  console.error('✗ not a git repo (no .git/ at cwd)');
  process.exit(1);
}

if (existsSync(HOOK)) {
  const current = readFileSync(HOOK, 'utf8');
  if (!current.includes('npm run preflight')) {
    console.error('✗ a different pre-push hook already exists at ' + HOOK);
    console.error('  Inspect it, then either merge our snippet in or delete the file and re-run.');
    process.exit(1);
  }
  console.log('✓ pre-push hook already installed; nothing to do');
  process.exit(0);
}

writeFileSync(HOOK, BODY, 'utf8');
chmodSync(HOOK, 0o755);
console.log('✓ installed pre-push hook at ' + HOOK);
console.log('  every `git push` will now run `npm run preflight` first.');
console.log('  bypass with `git push --no-verify` when you genuinely need to.');

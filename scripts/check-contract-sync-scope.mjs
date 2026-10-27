// The automated `contract-sync` pull request merges itself and publishes, so CI
// checks that it only brings a new contract and a new version: no other file,
// and nothing else in package.json or package-lock.json.
// Usage: node scripts/check-contract-sync-scope.mjs <base-ref>
import { execFileSync } from 'node:child_process';

const base = process.argv[2];
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const ALLOWED = new Set(['openapi/openapi.public.json', 'package.json', 'package-lock.json']);

// In a pull request HEAD is its merge into main: the diff is the PR's change.
const changed = git('diff', '--name-only', base, 'HEAD').split('\n').filter(Boolean);
const outside = changed.filter((file) => !ALLOWED.has(file));

/** The JSON file at `ref` without its version fields (package.json and lockfile). */
function withoutVersion(ref, file) {
  const json = JSON.parse(git('show', `${ref}:${file}`));
  delete json.version;
  if (json.packages?.['']) delete json.packages[''].version;
  return JSON.stringify(json);
}
const reshaped = ['package.json', 'package-lock.json'].filter(
  (file) => changed.includes(file) && withoutVersion(base, file) !== withoutVersion('HEAD', file)
);

if (outside.length > 0 || reshaped.length > 0) {
  for (const file of outside) console.error(`::error::contract-sync may not change ${file}`);
  for (const file of reshaped)
    console.error(`::error::contract-sync may only change the version in ${file}`);
  process.exit(1);
}
console.log(`contract-sync scope ok: ${changed.join(', ') || 'no changes'}`);

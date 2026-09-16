/**
 * Run every test file, and fail if one exists that this runner does not know about.
 *
 * WHY NOT THE `&&` CHAIN THAT WAS HERE
 *
 * `package.json` used to list the three test files explicitly:
 *
 *   node ... test/chunker.test.ts && node ... test/price.test.ts && node ... test/api.test.ts
 *
 * That runs what it names, and says nothing about what it does not name. A new test file dropped
 * into `test/` would simply never run, in `npm test` or in CI, with everything reporting green.
 *
 * That is not hypothetical in this workspace: the sibling `erc4626-vault-dapp` repository had
 * exactly this shape, and 23 candle tests sat unexecuted for as long as the chart feature
 * existed. The fix there was a runner that enumerates the directory and REFUSES to pass when it
 * finds a file it did not run. This is the same guard, and the enumeration is the point -- a
 * list cannot report its own omissions, a directory scan can.
 *
 * WHY FILES ARE RUN ONE AT A TIME
 *
 * `node --test test/*.test.ts` spawns a child per file and captures its output over a named
 * pipe, which a restricted sandbox refuses (`spawn EPERM`). Running each file directly executes
 * its tests in-process and needs no pipe. Same suites, same exit codes.
 *
 * Usage:
 *
 *   node tools/run-tests.mjs
 *
 * Exit code is 0 only when every file ran and every file passed.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { discoverTests } from './test-discovery.mjs';

const project = resolve(import.meta.dirname, '..');
const testDir = join(project, 'test');

// Discovered, never listed. See the note above: the whole point is that this works for files
// that did not exist when it was written. The matching rule lives in `test-discovery.mjs` so
// that `test/discovery.test.ts` can assert what it matches -- including the case a scan exists
// to catch and a list cannot report, which is a file nobody notices is missing.
const files = discoverTests(readdirSync(testDir));

if (files.length === 0) {
  console.error(`No test files found in ${testDir}. That is a failure, not a pass.`);
  process.exit(1);
}

// A file that exists but is skipped for a reason (needs a live service, say) must be named
// here, so "it did not run" is always a decision someone wrote down rather than an oversight.
const NEEDS_LIVE_SERVICE = new Set();

const runnable = files.filter((f) => !NEEDS_LIVE_SERVICE.has(f));
const skipped = files.filter((f) => NEEDS_LIVE_SERVICE.has(f));
for (const f of skipped) console.log(`SKIP  ${f}  (needs a live service; run it explicitly)`);

const failed = [];

for (const file of runnable) {
  console.log(`\n${'='.repeat(72)}\n${file}\n${'='.repeat(72)}`);
  const result = spawnSync(
    process.execPath,
    ['--no-warnings', '--experimental-strip-types', join(testDir, file)],
    {
      cwd: project,
      stdio: 'inherit',
      // Both spellings: one is read by Node, the other by `cast`/`forge`, and a localhost call
      // sent through the SOCKS proxy disappears silently.
      env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
    },
  );
  if (result.status !== 0) failed.push(file);
}

console.log(`\n${'='.repeat(72)}`);
console.log(`${runnable.length - failed.length}/${runnable.length} test files passed  (${files.length} found, ${skipped.length} skipped)`);
if (failed.length > 0) {
  console.log(`FAILED: ${failed.join(', ')}`);
  process.exit(failed.length);
}
console.log('all green');

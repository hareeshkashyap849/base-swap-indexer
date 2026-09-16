/**
 * Tests for the rule that decides which files run.
 *
 * WHY THIS FILE EXISTS
 *
 * `tools/run-tests.mjs` discovers test files by scanning `test/` instead of listing them, so a
 * new file runs without anyone remembering to add it. That fixes one failure mode and opens
 * another: narrow the matching rule, or break the scan, and files silently stop running with
 * every command still reporting green.
 *
 * So the rule is its own module and this asserts it. Without this file the runner's guard could
 * only ever pass, and a guard that can only pass is not a guard.
 *
 * The last test is the one that matters. It asks the REAL directory what it contains and
 * cross-checks that against what the runner will execute, so a file that appears in `test/` and
 * is not discovered is a failure here rather than an invisible omission at run time.
 *
 * Run: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { discoverTests, isTestFile } from '../tools/test-discovery.mjs';

const REPO = resolve(import.meta.dirname, '..');
const TEST_DIR = join(REPO, 'test');

test('a file ending in .test.ts is a test', () => {
  assert.equal(isTestFile('price.test.ts'), true);
  assert.equal(isTestFile('api.test.ts'), true);
});

test('a file ending in .test.mjs is a test', () => {
  assert.equal(isTestFile('something.test.mjs'), true);
});

test('a source file is not a test', () => {
  assert.equal(isTestFile('price.ts'), false);
  assert.equal(isTestFile('helpers.ts'), false);
  assert.equal(isTestFile('fixtures.json'), false);
});

test('a name that merely contains "test" is not a test', () => {
  // `test-data.ts` and `latest.ts` both contain the word. Matching on the word rather than on
  // the extension is a plausible way to write this rule and would run the wrong files.
  assert.equal(isTestFile('test-data.ts'), false);
  assert.equal(isTestFile('latest.ts'), false);
  assert.equal(isTestFile('contest.mjs'), false);
});

test('a claimed extension that is not executed is not a test', () => {
  // `.js` and `.tsx` are not run by this project. If the rule is widened to accept them, the
  // runner would try to execute files it cannot strip types from -- so a change here should be
  // a deliberate one that updates this assertion too.
  assert.equal(isTestFile('legacy.test.js'), false);
  assert.equal(isTestFile('component.test.tsx'), false);
});

test('discovery returns a sorted list and preserves everything it matched', () => {
  const found = discoverTests(['price.test.ts', 'api.test.ts', 'chunker.test.ts']);
  assert.deepEqual(found, ['api.test.ts', 'chunker.test.ts', 'price.test.ts']);
});

test('EVERY file in test/ that looks like a test is actually discovered', () => {
  // The guard. It reads the real directory, so a new test file that the rule does not match
  // fails here instead of never running.
  const present = readdirSync(TEST_DIR);
  const looksLikeATest = present.filter((f) => /\.test\./.test(f));
  const discovered = discoverTests(present);

  const missed = looksLikeATest.filter((f) => !discovered.includes(f));
  assert.deepEqual(
    missed,
    [],
    `these files look like tests but the runner would not execute them: ${missed.join(', ')}. ` +
      'Either fix tools/test-discovery.mjs or -- if they are deliberately excluded -- name them ' +
      'in NEEDS_LIVE_SERVICE so the exclusion is written down rather than silent.',
  );

  // And the other direction: nothing is executed that does not exist.
  for (const f of discovered) assert.ok(present.includes(f), `discovered a file that is not there: ${f}`);

  // A discovery rule that matches nothing would otherwise pass the comparison above trivially
  // if the directory were empty.
  assert.ok(discovered.length >= 3, `expected at least 3 test files, discovered ${discovered.length}`);
});

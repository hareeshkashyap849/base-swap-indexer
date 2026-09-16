/**
 * Which files in `test/` count as tests.
 *
 * WHY THIS IS ITS OWN MODULE
 *
 * `tools/run-tests.mjs` discovers test files by scanning the directory rather than by listing
 * them, because a list cannot report its own omissions -- the sibling `erc4626-vault-dapp`
 * repository had 23 tests that never ran for exactly that reason.
 *
 * But a directory scan has the opposite failure: if the matching rule is ever narrowed, files
 * stop being discovered and nothing says so. Extracting the rule here lets a test assert what it
 * matches, so the guard can fail. A guard that can only pass is not a guard.
 *
 * This module has no imports and no side effects: it is a predicate.
 */

/** Extensions that are executed. `.ts` needs `--experimental-strip-types`, `.mjs` does not. */
const TEST_FILE = /\.test\.(ts|mjs)$/;

/** Files that match the extension but are not tests, by name. Kept explicit and short. */
const NOT_A_TEST = new Set(['test/helpers.ts', 'test/fixtures.ts']);

/**
 * @param {string} name a bare file name, as `readdirSync` returns it
 * @returns {boolean} whether this runner should execute it
 */
export function isTestFile(name) {
  return TEST_FILE.test(name) && !NOT_A_TEST.has(`test/${name}`);
}

/** The full list a directory listing should produce, sorted. */
export function discoverTests(names) {
  return names.filter(isTestFile).sort();
}

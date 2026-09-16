/**
 * Types for `tools/test-discovery.mjs`.
 *
 * The tool is `.mjs` because it runs without a build step, and this repository has no bundler
 * by design. `tsc --noEmit` still type-checks `test/discovery.test.ts`, which imports it, so the
 * shape has to be declared somewhere. A `.d.mts` next to the module is the smallest way to do
 * that, and keeping it beside the implementation means the two are read together.
 */

/** Whether `name` is a file this project's test runner should execute. */
export declare function isTestFile(name: string): boolean;

/** The test files in a directory listing, sorted. */
export declare function discoverTests(names: readonly string[]): string[];

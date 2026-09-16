/**
 * Tests for the two pieces of configuration a bulk historical backfill depends on.
 *
 * WHY THESE EXIST, AND WHY THEY ARE WORTH A FILE
 *
 * Both were added after measuring that a 200,000-block backfill is only possible against one of the
 * three default endpoints (`tools/probe-rpc-range.mjs`: publicnode refuses archive ranges, drpc
 * refuses ranges over 10,000 blocks, mainnet.base.org served a 2,000-block window 250,000 blocks
 * back). Both are also the kind of configuration that fails QUIETLY:
 *
 *   - An endpoint list parsed wrongly gives a pool that fails on every call, which reads as a
 *     network outage rather than as a typo.
 *   - A chunk size of `NaN` or `0` reaches the chunker's clamp, becomes the minimum, and turns a
 *     bulk run into a crawl one block at a time -- with no error anywhere to explain it.
 *
 * So the assertions below are mostly about REFUSALS: the cases where the right behaviour is to
 * throw rather than to proceed with something plausible.
 *
 * Run: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rpcUrlsFrom } from '../src/config.ts';
import { AdaptiveChunker } from '../src/indexer/chunker.ts';

const DEFAULTS = ['https://a.example', 'https://b.example'];

test('an unset override keeps the default endpoints', () => {
  assert.deepEqual(rpcUrlsFrom(undefined, DEFAULTS), DEFAULTS);
});

test('a single endpoint is accepted -- the case that matters for a historical backfill', () => {
  assert.deepEqual(rpcUrlsFrom('https://mainnet.base.org', DEFAULTS), ['https://mainnet.base.org']);
});

test('surrounding whitespace and a trailing comma are tolerated', () => {
  // Not hypothetical: a comma-separated list pasted from a shell command picks these up, and a URL
  // with a leading space fails on every call.
  assert.deepEqual(rpcUrlsFrom(' https://a.example , https://b.example ,', DEFAULTS), [
    'https://a.example',
    'https://b.example',
  ]);
});

test('an override that parses to nothing falls back instead of producing an empty pool', () => {
  // `RpcPool` throws on an empty endpoint list, so an empty override would abort the run with a
  // message about the pool rather than about the empty value.
  assert.deepEqual(rpcUrlsFrom('', DEFAULTS), DEFAULTS);
  assert.deepEqual(rpcUrlsFrom('  ,  , ', DEFAULTS), DEFAULTS);
});

test('a URL with no scheme is refused rather than passed to the transport', () => {
  assert.throws(() => rpcUrlsFrom('mainnet.base.org', DEFAULTS), /not an http\(s\) URL/);
  assert.throws(() => rpcUrlsFrom('https://ok.example,ftp://no.example', DEFAULTS), /ftp:\/\/no\.example/);
});

test('an http endpoint is allowed, because a local proxy is a legitimate endpoint', () => {
  assert.deepEqual(rpcUrlsFrom('http://127.0.0.1:8545', DEFAULTS), ['http://127.0.0.1:8545']);
});

// ---- the chunker options the backfill passes ----------------------------------------------

test('a chunk max is honoured from the first chunk, without a growth ramp', () => {
  // This is the whole point of the flag: at the default max of 500 a 200,000-block window needs at
  // least 400 calls, and reaching 500 from 50 costs ~45 chunks of growth first. With the measured
  // limit passed in, the first chunk is already at it.
  const chunker = new AdaptiveChunker({ initial: 2_000, min: 1, max: 2_000, growthStep: 10 });
  assert.equal(chunker.currentSize, 2_000);
  chunker.onSuccess(1n);
  assert.equal(chunker.currentSize, 2_000, 'growth must not exceed the maximum');
  assert.equal(chunker.adjustments.length, 0, 'no adjustment is needed when already at the maximum');
});

test('a chunk that is too large still shrinks below a raised maximum', () => {
  // Raising the maximum must not disarm the adaptation: if the endpoint refuses the bigger range,
  // the run has to survive it. A max that could not be shrunk from would turn a wrong guess about
  // the endpoint into a failed run.
  const chunker = new AdaptiveChunker({ initial: 2_000, min: 1, max: 2_000, growthStep: 10 });
  const next = chunker.onSizeFailure(2_000n, 'RANGE_REJECTED');
  assert.equal(next, 1_000);
  assert.equal(chunker.currentSize, 1_000);
});

test('an initial size above the maximum is clamped to it, not used as given', () => {
  // Documented behaviour rather than a surprise: the CLI refuses this combination, so nothing
  // reaches here from the command line, but the class itself must not produce a chunk larger than
  // its own stated maximum.
  const chunker = new AdaptiveChunker({ initial: 5_000, min: 1, max: 2_000, growthStep: 10 });
  assert.equal(chunker.currentSize, 2_000);
});

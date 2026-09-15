/**
 * Tests for adaptive chunking and coverage.
 *
 * These are pure-logic tests: no network, no database. That is on purpose —
 * chunking is where a silent gap would corrupt every downstream number, so it
 * must be testable without the chain being up.
 *
 * Run: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AdaptiveChunker,
  assertContiguousCoverage,
  nextChunk,
  rangeSize,
  DEFAULT_CHUNKER,
  type BlockRange,
} from '../src/indexer/chunker.ts';

test('nextChunk returns the whole span when it fits', () => {
  const c = nextChunk(100n, 120n, 50);
  assert.deepEqual(c, { from: 100n, to: 120n });
});

test('nextChunk clamps the last chunk to the end of the span', () => {
  const c = nextChunk(100n, 210n, 50);
  assert.deepEqual(c, { from: 100n, to: 149n });
});

test('nextChunk returns null for an empty span', () => {
  assert.equal(nextChunk(100n, 99n, 10), null);
});

test('nextChunk of a single block', () => {
  assert.deepEqual(nextChunk(7n, 7n, 10), { from: 7n, to: 7n });
});

test('rangeSize is inclusive at both ends', () => {
  assert.equal(rangeSize({ from: 10n, to: 10n }), 1n);
  assert.equal(rangeSize({ from: 10n, to: 19n }), 10n);
});

test('walking with nextChunk covers the span exactly once', () => {
  // This is the loop the indexer actually runs. If it ever double-counts or
  // drops a block, volume totals break in a way that is invisible by eye.
  const from = 1000n;
  const to = 1234n;
  const ranges: BlockRange[] = [];
  let cursor = from;
  while (cursor <= to) {
    const c = nextChunk(cursor, to, 37);
    assert.ok(c, 'nextChunk must not be null while cursor <= to');
    ranges.push(c);
    cursor = c.to + 1n;
  }
  assertContiguousCoverage(ranges, from, to);
  const total = ranges.reduce((n, r) => n + rangeSize(r), 0n);
  assert.equal(total, to - from + 1n);
});

test('chunker grows additively on success and is capped', () => {
  const ch = new AdaptiveChunker({ initial: 10, min: 1, max: 25, growthStep: 5 });
  assert.equal(ch.currentSize, 10);
  ch.onSuccess(0n);
  assert.equal(ch.currentSize, 15);
  ch.onSuccess(0n);
  assert.equal(ch.currentSize, 20);
  ch.onSuccess(0n);
  assert.equal(ch.currentSize, 25);
  ch.onSuccess(0n);
  assert.equal(ch.currentSize, 25, 'must not exceed max');
});

test('chunker halves on a size failure', () => {
  const ch = new AdaptiveChunker({ initial: 100, min: 1, max: 500, growthStep: 10 });
  assert.equal(ch.onSizeFailure(0n, 'TOO_LARGE'), 50);
  assert.equal(ch.onSizeFailure(0n, 'TOO_LARGE'), 25);
  assert.equal(ch.currentSize, 25);
});

test('chunker throws instead of shrinking below the minimum', () => {
  // The important behaviour: at the floor we must surface the error rather
  // than spin forever retrying an impossible request, and we must never skip
  // the range to make progress.
  const ch = new AdaptiveChunker({ initial: 4, min: 2, max: 100, growthStep: 1 });
  assert.equal(ch.onSizeFailure(0n, 'RANGE_REJECTED'), 2);
  assert.throws(() => ch.onSizeFailure(0n, 'RANGE_REJECTED'), /already at minimum/);
});

test('a success resets the failure streak', () => {
  const ch = new AdaptiveChunker({ initial: 40, min: 1, max: 100, growthStep: 0 });
  ch.onSizeFailure(0n, 'RATE_LIMIT');
  assert.equal(ch.failureStreak, 1);
  ch.onSuccess(0n);
  assert.equal(ch.failureStreak, 0);
});

test('growthStep of 0 keeps the size stable (useful when tuning)', () => {
  const ch = new AdaptiveChunker({ initial: 20, min: 1, max: 100, growthStep: 0 });
  ch.onSuccess(0n);
  assert.equal(ch.currentSize, 20);
});

test('adjustments record both directions with reasons', () => {
  const ch = new AdaptiveChunker({ initial: 50, min: 1, max: 500, growthStep: 10 });
  ch.onSuccess(1n);
  ch.onSizeFailure(2n, 'TOO_LARGE');
  const reasons = ch.adjustments.map((a) => a.reason);
  assert.deepEqual(reasons, ['growth', 'TOO_LARGE']);
  assert.equal(ch.adjustments[0]!.from, 50);
  assert.equal(ch.adjustments[0]!.to, 60);
  assert.equal(ch.adjustments[1]!.to, 30);
});

test('DEFAULT_CHUNKER bounds are sane', () => {
  assert.ok(DEFAULT_CHUNKER.min >= 1);
  assert.ok(DEFAULT_CHUNKER.initial >= DEFAULT_CHUNKER.min);
  assert.ok(DEFAULT_CHUNKER.initial <= DEFAULT_CHUNKER.max);
  assert.ok(DEFAULT_CHUNKER.growthStep >= 0);
});

// --------------------------------------------------------------------------
// INV-2: coverage must be exact. assertContiguousCoverage is the executable
// form of that invariant, so it needs to actually reject bad coverage.
// --------------------------------------------------------------------------

test('INV-2 accepts exact contiguous coverage', () => {
  assertContiguousCoverage(
    [
      { from: 10n, to: 19n },
      { from: 20n, to: 29n },
    ],
    10n,
    29n,
  );
});

test('INV-2 rejects a gap', () => {
  assert.throws(
    () =>
      assertContiguousCoverage(
        [
          { from: 10n, to: 19n },
          { from: 21n, to: 29n }, // 20 missing
        ],
        10n,
        29n,
      ),
    /gap at block 20/,
  );
});

test('INV-2 rejects an overlap', () => {
  // Note the message names block 20, not 19: block 19 is already covered, so
  // the next block the checker expects is 20, and the range starting at 19 is
  // what violates that expectation.
  assert.throws(
    () =>
      assertContiguousCoverage(
        [
          { from: 10n, to: 19n },
          { from: 19n, to: 29n }, // 19 covered twice
        ],
        10n,
        29n,
      ),
    /overlap at block 20/,
  );
});

test('INV-2 rejects coverage that stops early', () => {
  assert.throws(() => assertContiguousCoverage([{ from: 10n, to: 19n }], 10n, 29n), /gap at end/);
});

test('INV-2 rejects empty coverage of a non-empty span', () => {
  assert.throws(() => assertContiguousCoverage([], 10n, 29n), /got nothing/);
});

test('INV-2 accepts out-of-order ranges', () => {
  assertContiguousCoverage(
    [
      { from: 20n, to: 29n },
      { from: 10n, to: 19n },
    ],
    10n,
    29n,
  );
});

test('INV-2 accepts an empty span with no ranges', () => {
  assertContiguousCoverage([], 10n, 9n);
});

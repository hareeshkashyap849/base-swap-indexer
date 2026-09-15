/**
 * Adaptive block-range chunking.
 *
 * The problem this solves, measured on real Base mainnet data:
 *
 *   - Pulling 2,000 blocks of Uniswap V3 Swap logs in one eth_getLogs call
 *     exceeded the RPC response limit and threw ResponseBodyTooLargeError.
 *   - Pulling a wide range is also rejected outright by many public endpoints.
 *   - Log density is wildly uneven over time: probing 300 blocks in 50-block
 *     chunks returned 55 logs for one chunk and 9,616 for another — a 175x
 *     spread over the same span of chain.
 *
 * So neither "always one call" nor "always N blocks" works. The range size has
 * to react to what the endpoint actually tolerates.
 *
 * Strategy:
 *   - On success: grow slowly (additive), so we do not immediately re-trigger
 *     the limit we just escaped.
 *   - On TOO_LARGE / RANGE_REJECTED / RATE_LIMIT: shrink hard (halve), because
 *     retrying the same size is what burns time and quota.
 *   - Never shrink below `minChunk`; if even that fails, surface the error
 *     instead of looping forever. A silent skip would be worse than a crash,
 *     because the missing logs would be invisible in the output.
 *
 * This module is deliberately free of I/O so INV-2 (no block is ever skipped
 * or duplicated) can be unit-tested directly.
 */

export interface ChunkerOptions {
  /** Initial range size in blocks. */
  initial: number;
  /** Never go below this; failing here is an error, not a reason to shrink. */
  min: number;
  /** Never exceed this (also protects against absurd growth after many successes). */
  max: number;
  /** How many blocks to add after a successful chunk (additive growth). */
  growthStep: number;
}

export const DEFAULT_CHUNKER: ChunkerOptions = {
  initial: 50,
  min: 1,
  max: 2_000,
  growthStep: 10,
};

/** A single [from, to] inclusive block range. */
export interface BlockRange {
  from: bigint;
  to: bigint;
}

/**
 * Split `[from, to]` into the first chunk of at most `size` blocks.
 * Returns null when the range is empty, which makes the caller's loop trivial.
 */
export function nextChunk(from: bigint, to: bigint, size: number): BlockRange | null {
  if (from > to) return null;
  const last = from + BigInt(size) - 1n;
  return { from, to: last > to ? to : last };
}

/** Inclusive size of a range. */
export function rangeSize(r: BlockRange): bigint {
  return r.to - r.from + 1n;
}

/**
 * Tracks the current chunk size and adjusts it based on outcomes.
 *
 * Kept as a class because the size is stateful across the whole run: the point
 * is to learn what this particular endpoint tolerates and stay near it, rather
 * than rediscovering the limit on every chunk.
 */
export class AdaptiveChunker {
  private size: number;
  private readonly opts: ChunkerOptions;
  private consecutiveFailures = 0;
  readonly adjustments: Array<{ at: bigint; from: number; to: number; reason: string }> = [];

  constructor(opts: Partial<ChunkerOptions> = {}) {
    this.opts = { ...DEFAULT_CHUNKER, ...opts };
    this.size = clamp(this.opts.initial, this.opts.min, this.opts.max);
  }

  get currentSize(): number {
    return this.size;
  }

  /** Call after a chunk succeeded. Grows additively, capped at `max`. */
  onSuccess(atBlock: bigint): void {
    this.consecutiveFailures = 0;
    const next = clamp(this.size + this.opts.growthStep, this.opts.min, this.opts.max);
    if (next !== this.size) {
      this.adjustments.push({ at: atBlock, from: this.size, to: next, reason: 'growth' });
      this.size = next;
    }
  }

  /**
   * Call after a chunk failed with a size/rate related error.
   *
   * Returns the new size, or throws if we are already at the minimum — in that
   * case the caller must surface the failure, because there is no safe smaller
   * request left to try.
   */
  onSizeFailure(atBlock: bigint, reason: string): number {
    this.consecutiveFailures++;
    if (this.size <= this.opts.min) {
      throw new Error(
        `chunk size already at minimum (${this.opts.min}) and block ${atBlock} still fails: ${reason}`,
      );
    }
    const next = Math.max(this.opts.min, Math.floor(this.size / 2));
    this.adjustments.push({ at: atBlock, from: this.size, to: next, reason });
    this.size = next;
    return next;
  }

  get failureStreak(): number {
    return this.consecutiveFailures;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Verify that a list of processed ranges covers exactly `[from, to]` with no
 * gaps and no overlaps.
 *
 * This is INV-2 as an executable check. It runs after every indexing pass:
 * a gap would silently drop trades from the dashboard, and an overlap would
 * double-count volume, and both are hard to notice by eye.
 */
export function assertContiguousCoverage(
  ranges: readonly BlockRange[],
  from: bigint,
  to: bigint,
): void {
  if (from > to) {
    if (ranges.length !== 0) throw new Error(`expected no ranges for empty span, got ${ranges.length}`);
    return;
  }
  if (ranges.length === 0) throw new Error(`expected coverage of ${from}..${to}, got nothing`);

  const sorted = [...ranges].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  let expected = from;
  for (const r of sorted) {
    if (r.from !== expected) {
      const kind = r.from > expected ? 'gap' : 'overlap';
      throw new Error(`INV-2 violated: ${kind} at block ${expected} (next range starts at ${r.from})`);
    }
    if (r.to < r.from) throw new Error(`invalid range ${r.from}..${r.to}`);
    expected = r.to + 1n;
  }
  if (expected !== to + 1n) {
    throw new Error(`INV-2 violated: gap at end, coverage stopped at ${expected - 1n}, expected ${to}`);
  }
}

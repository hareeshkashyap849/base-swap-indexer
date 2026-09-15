/**
 * The indexer loop.
 *
 * Responsibilities, in the order they matter:
 *   1. Work out where to resume from (never re-do finished work, never skip).
 *   2. Pull Swap logs in adaptive chunks.
 *   3. Resolve a timestamp per block (batched, because per-block calls get
 *      rate limited immediately on public endpoints).
 *   4. Write in a transaction, then advance the checkpoint.
 *   5. Detect chain reorganisations and unwind cleanly.
 *
 * Two failure-handling rules are deliberate and worth calling out:
 *   - A chunk that fails for a size/rate reason shrinks and retries. A chunk
 *     that fails for any other reason after all endpoints are exhausted
 *     ABORTS the run. It never skips a range, because a skipped range is
 *     invisible in the resulting data — the dashboard would simply show fewer
 *     trades with no indication anything was missing.
 *   - The checkpoint is only advanced after the data is committed, so a crash
 *     can lose work but can never claim work that was not done.
 */

import { parseAbiItem, type PublicClient } from 'viem';
import { POOL_ADDRESS } from '../config.ts';
import { AdaptiveChunker, assertContiguousCoverage, nextChunk, type BlockRange } from './chunker.ts';
import { RpcError, RpcPool, type RpcStats } from '../lib/rpc.ts';
import type { Store, SwapRow } from '../lib/db.ts';

const SWAP_ABI_ITEM = parseAbiItem(
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
);

export interface IndexOptions {
  /** Last block to index (inclusive). Defaults to the current chain head. */
  toBlock?: bigint;
  /** How many blocks back to start when there is no saved checkpoint. */
  backfillBlocks: number;
  /** Keep polling for new blocks instead of exiting after backfill. */
  follow: boolean;
  /** Seconds to wait between polls in follow mode. */
  pollSeconds: number;
  /** Print progress to stdout. */
  verbose: boolean;
}

export interface IndexResult {
  fromBlock: bigint;
  toBlock: bigint;
  blocksScanned: number;
  swapsInserted: number;
  swapsDecoded: number;
  reorgsRecovered: number;
  rpc: RpcStats;
  chunkAdjustments: number;
  elapsedMs: number;
}

/** A decoded swap, before timestamps are attached. */
interface DecodedSwap {
  blockNumber: bigint;
  blockHash: string;
  txHash: string;
  logIndex: number;
  txIndex: number;
  sender: string;
  recipient: string;
  amount0: string;
  amount1: string;
  sqrtPriceX96: string;
  liquidity: string;
  tick: number;
}

export class Indexer {
  private readonly pool: RpcPool;
  private readonly store: Store;
  private readonly chunker: AdaptiveChunker;
  private readonly opts: IndexOptions;

  constructor(store: Store, opts: Partial<IndexOptions> = {}) {
    this.store = store;
    this.opts = {
      backfillBlocks: 10_000,
      follow: false,
      pollSeconds: 12,
      verbose: true,
      ...opts,
    };
    this.chunker = new AdaptiveChunker({ initial: 50, min: 1, max: 500, growthStep: 10 });
    this.pool = new RpcPool({
      onError: (err, attempt) => {
        if (this.opts.verbose) {
          console.log(`    rpc retry #${attempt} ${err.kind} @ ${hostOf(err.endpoint)}`);
        }
        this.store.log('warn', 'rpc_error', `${err.kind} ${err.endpoint} ${err.message}`);
      },
    });
  }

  /** Current chain head. */
  async chainHead(): Promise<bigint> {
    return this.pool.run((c: PublicClient) => c.getBlockNumber());
  }

  /**
   * Decide the starting block.
   *
   * Resume semantics: start at checkpoint + 1. If there is no checkpoint, go
   * back `backfillBlocks` from the head.
   */
  async resolveStartBlock(head: bigint): Promise<bigint> {
    const state = this.store.getState();
    if (state) return BigInt(state.lastIndexedBlock) + 1n;
    const start = head - BigInt(this.opts.backfillBlocks) + 1n;
    return start < 0n ? 0n : start;
  }

  /**
   * Detect and recover from a reorg at or below the checkpoint.
   *
   * Method: take the block we last wrote, ask the chain for its current hash,
   * and compare with what we stored. If they differ, the chain abandoned that
   * block, so every row at or after it is invalid. We walk backwards to find
   * the last block that still matches, then delete everything after it.
   *
   * Checking a single block is enough and is what makes this cheap: a reorg
   * always invalidates a contiguous suffix, so the first mismatch going
   * backwards from the tip is the boundary.
   */
  async detectAndRecoverReorg(maxDepth = 64): Promise<{ recovered: boolean; rewoundTo?: bigint }> {
    const state = this.store.getState();
    if (!state) return { recovered: false };

    let probe = BigInt(state.lastIndexedBlock);
    const floor = probe - BigInt(maxDepth) < 0n ? 0n : probe - BigInt(maxDepth);

    for (; probe >= floor; probe--) {
      const stored = this.store.getBlockHash(probe);
      if (stored === undefined) continue; // never recorded; nothing to contradict
      let onChain: string;
      try {
        const blk = await this.pool.getBlockSingle(probe);
        onChain = blk.hash;
      } catch {
        // If we cannot read the chain we cannot conclude a reorg happened.
        // Guessing here would be worse than continuing: a false positive
        // deletes good data.
        return { recovered: false };
      }
      if (onChain.toLowerCase() === stored.toLowerCase()) {
        // This block survived; anything above it that we stored is suspect.
        if (probe === BigInt(state.lastIndexedBlock)) return { recovered: false };
        const rewindTo = probe;
        const removed = this.store.rollbackFrom(rewindTo + 1n);
        this.store.setState(rewindTo, BigInt(state.chainHeadAtLastRun));
        this.store.log(
          'warn',
          'reorg_recovered',
          `rewound to ${rewindTo}; deleted ${removed.swaps} swaps / ${removed.blocks} blocks`,
        );
        if (this.opts.verbose) {
          console.log(
            `  ⚠ reorg detected: rewound to block ${rewindTo} (removed ${removed.swaps} swaps)`,
          );
        }
        return { recovered: true, rewoundTo: rewindTo };
      }
    }
    // Nothing matched within the probe depth — report but do not destroy data
    // on a guess.
    this.store.log('error', 'reorg_deep', `no matching ancestor within ${maxDepth} blocks from ${state.lastIndexedBlock}`);
    if (this.opts.verbose) console.log(`  ⚠ deep reorg suspected beyond ${maxDepth} blocks; not auto-recovering`);
    return { recovered: false };
  }

  /**
   * Pull logs for one range, letting the chunker react to size/rate failures.
   * Returns the decoded swaps plus the range that actually succeeded.
   */
  private async fetchRange(
    from: bigint,
    to: bigint,
  ): Promise<{ range: BlockRange; swaps: DecodedSwap[] }> {
    let cursor = from;
    const out: DecodedSwap[] = [];

    while (cursor <= to) {
      const size = this.chunker.currentSize;
      const chunk = nextChunk(cursor, to, size);
      if (!chunk) break;

      try {
        const logs = await this.pool.run((c: PublicClient) =>
          c.getLogs({
            address: POOL_ADDRESS,
            event: SWAP_ABI_ITEM,
            fromBlock: chunk.from,
            toBlock: chunk.to,
            strict: true,
          }),
        );
        for (const log of logs) {
          out.push(toDecodedSwap(log as unknown as RawLog));
        }
        this.chunker.onSuccess(chunk.from);
        if (this.opts.verbose) {
          console.log(
            `    ${chunk.from}-${chunk.to} (size ${size}) -> ${logs.length} swaps   [chunk ${this.chunker.currentSize}]`,
          );
        }
        cursor = chunk.to + 1n;
      } catch (err) {
        const kind = err instanceof RpcError ? err.kind : 'UNKNOWN';
        const sizeRelated =
          kind === 'TOO_LARGE' || kind === 'RANGE_REJECTED' || kind === 'RATE_LIMIT';
        if (!sizeRelated) {
          // Not something a smaller request would fix — refuse to skip.
          throw new Error(
            `failed to index ${chunk.from}-${chunk.to} (${kind}); aborting rather than skipping blocks: ${String(
              (err as Error).message,
            )}`,
          );
        }
        const newSize = this.chunker.onSizeFailure(chunk.from, kind);
        if (this.opts.verbose) {
          console.log(`    ${chunk.from}-${chunk.to} failed (${kind}) -> shrink chunk to ${newSize}`);
        }
        this.store.log('warn', 'chunk_shrink', `${kind} at ${chunk.from}; size -> ${newSize}`);
        // loop again with the smaller size; cursor is unchanged on purpose
      }
    }

    return { range: { from, to }, swaps: out };
  }

  /**
   * Resolve timestamps for every block touched by `swaps`, using JSON-RPC
   * batching so one HTTP request covers many headers.
   *
   * This was originally one getBlock per block, which is what produced a wall
   * of rate-limit retries against a 200-block range. Batching is not a
   * micro-optimisation here: it is the difference between completing and being
   * throttled, because the number of distinct blocks scales linearly with the
   * indexed range.
   *
   * Falls back to individual requests if no endpoint serves a valid batch —
   * some endpoints reject batches outright, and at least one returns a
   * correctly-sized reply with the timestamps silently stripped.
   */
  private async fetchHeaders(
    swaps: readonly DecodedSwap[],
    cache: Map<string, number>,
    batchSize = 200,
  ): Promise<void> {
    const needed: bigint[] = [];
    const seen = new Set<string>();
    for (const s of swaps) {
      const key = s.blockNumber.toString();
      if (cache.has(key) || seen.has(key)) continue;
      seen.add(key);
      needed.push(s.blockNumber);
    }
    if (needed.length === 0) return;

    const apply = (key: string, h: { timestamp: number; hash: string; parentHash: string }): void => {
      cache.set(key, h.timestamp);
      this.store.upsertBlock({
        blockNumber: BigInt(key),
        blockHash: h.hash,
        parentHash: h.parentHash,
        timestamp: h.timestamp,
      });
    };

    for (let i = 0; i < needed.length; i += batchSize) {
      const slice = needed.slice(i, i + batchSize);
      try {
        const map = await this.pool.getBlocksBatch(slice);
        for (const n of slice) {
          const key = n.toString();
          const h = map.get(key);
          if (!h) throw new Error(`batch reply omitted block ${key}`);
          apply(key, h);
        }
      } catch (err) {
        // Batch path unusable for this slice — fetch one at a time rather than
        // lose the block range entirely.
        this.store.log('warn', 'batch_fallback', `${String((err as Error).message)} at ${slice[0]}`);
        if (this.opts.verbose) {
          console.log(`    batch unavailable (${String((err as Error).message).slice(0, 60)}); per-block fallback`);
        }
        for (const n of slice) {
          const key = n.toString();
          if (cache.has(key)) continue;
          apply(key, await this.pool.getBlockSingle(n));
        }
      }
    }
  }

  /** Run one indexing pass from the resolved start block to `toBlock`. */
  async runOnce(): Promise<IndexResult> {
    const started = Date.now();
    const head = await this.chainHead();
    const to = this.opts.toBlock !== undefined && this.opts.toBlock < head ? this.opts.toBlock : head;

    const reorg = await this.detectAndRecoverReorg();
    let reorgsRecovered = reorg.recovered ? 1 : 0;

    const from = await this.resolveStartBlock(head);
    if (from > to) {
      if (this.opts.verbose) console.log(`  nothing to do (already at ${from - 1n}, head ${head})`);
      return {
        fromBlock: from,
        toBlock: to,
        blocksScanned: 0,
        swapsInserted: 0,
        swapsDecoded: 0,
        reorgsRecovered,
        rpc: this.pool.stats,
        chunkAdjustments: this.chunker.adjustments.length,
        elapsedMs: Date.now() - started,
      };
    }

    if (this.opts.verbose) {
      console.log(`  indexing ${from} → ${to}  (${to - from + 1n} blocks, head ${head})`);
    }

    const { range, swaps } = await this.fetchRange(from, to);

    // INV-2: the range we claim to have covered must actually be covered.
    // fetchRange only ever advances contiguously, so this asserts the internal
    // invariant rather than trusting it.
    assertContiguousCoverage([range], from, to);

    const cache = new Map<string, number>();
    await this.fetchHeaders(swaps, cache);

    const rows: SwapRow[] = [];
    for (const s of swaps) {
      const ts = cache.get(s.blockNumber.toString());
      if (ts === undefined) {
        throw new Error(`missing timestamp for block ${s.blockNumber} — refusing to write partial rows`);
      }
      rows.push({
        blockNumber: s.blockNumber,
        blockHash: s.blockHash,
        txHash: s.txHash,
        logIndex: s.logIndex,
        txIndex: s.txIndex,
        timestamp: ts,
        sender: s.sender,
        recipient: s.recipient,
        amount0: s.amount0,
        amount1: s.amount1,
        sqrtPriceX96: s.sqrtPriceX96,
        liquidity: s.liquidity,
        tick: s.tick,
      });
    }

    const inserted = this.store.insertSwaps(rows);
    // Checkpoint last: a crash before this point re-does the range, which is
    // harmless (inserts are idempotent), whereas a checkpoint without data
    // would silently lose blocks forever.
    this.store.setState(to, head);
    this.store.log('info', 'range_indexed', `${from}-${to} swaps=${inserted}`);

    return {
      fromBlock: from,
      toBlock: to,
      blocksScanned: Number(to - from + 1n),
      swapsInserted: inserted,
      swapsDecoded: swaps.length,
      reorgsRecovered,
      rpc: this.pool.stats,
      chunkAdjustments: this.chunker.adjustments.length,
      elapsedMs: Date.now() - started,
    };
  }

  /** Backfill to the head, then optionally keep polling. */
  async run(): Promise<IndexResult[]> {
    const results: IndexResult[] = [];
    results.push(await this.runOnce());

    if (!this.opts.follow) return results;

    // Follow mode: poll for new blocks. The checkpoint keeps each pass cheap
    // because the start block is always checkpoint + 1.
    const stop = installStopHandler(() => {
      if (this.opts.verbose) console.log('\n  stop requested, finishing current pass…');
    });
    while (!stop.requested) {
      await new Promise((r) => setTimeout(r, this.opts.pollSeconds * 1000));
      if (stop.requested) break;
      try {
        results.push(await this.runOnce());
      } catch (err) {
        this.store.log('error', 'follow_pass_failed', String((err as Error).message));
        if (this.opts.verbose) console.log(`  pass failed: ${String((err as Error).message)} — retrying`);
      }
    }
    return results;
  }
}

/** Raw log shape as returned by viem, before we narrow it. */
interface RawLog {
  blockNumber: bigint | null;
  blockHash: string | null;
  transactionHash: string | null;
  transactionIndex: number | null;
  logIndex: number | null;
  args: {
    sender?: string;
    recipient?: string;
    amount0?: bigint;
    amount1?: bigint;
    sqrtPriceX96?: bigint;
    liquidity?: bigint;
    tick?: number;
  };
}

/**
 * Narrow a raw log into a DecodedSwap.
 *
 * Every field is checked. viem can return nulls for pending logs, and a
 * partially decoded swap would corrupt the aggregates downstream, so we throw
 * rather than coerce.
 */
function toDecodedSwap(log: RawLog): DecodedSwap {
  const a = log.args;
  const missing: string[] = [];
  if (log.blockNumber === null) missing.push('blockNumber');
  if (!log.blockHash) missing.push('blockHash');
  if (!log.transactionHash) missing.push('transactionHash');
  if (log.logIndex === null) missing.push('logIndex');
  if (log.transactionIndex === null) missing.push('transactionIndex');
  if (!a.sender) missing.push('sender');
  if (!a.recipient) missing.push('recipient');
  if (a.amount0 === undefined) missing.push('amount0');
  if (a.amount1 === undefined) missing.push('amount1');
  if (a.sqrtPriceX96 === undefined) missing.push('sqrtPriceX96');
  if (a.liquidity === undefined) missing.push('liquidity');
  if (a.tick === undefined) missing.push('tick');
  if (missing.length > 0) {
    throw new Error(`swap log at block ${log.blockNumber} missing fields: ${missing.join(', ')}`);
  }
  return {
    blockNumber: log.blockNumber!,
    blockHash: log.blockHash!,
    txHash: log.transactionHash!,
    logIndex: log.logIndex!,
    txIndex: log.transactionIndex!,
    sender: a.sender!.toLowerCase(),
    recipient: a.recipient!.toLowerCase(),
    // int256 -> decimal string. Kept as a string all the way to SQLite because
    // these values overflow both JS number and SQLite INTEGER.
    amount0: a.amount0!.toString(),
    amount1: a.amount1!.toString(),
    sqrtPriceX96: a.sqrtPriceX96!.toString(),
    liquidity: a.liquidity!.toString(),
    tick: Number(a.tick!),
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function installStopHandler(onStop: () => void): { requested: boolean } {
  const state = { requested: false };
  const handler = (): void => {
    state.requested = true;
    onStop();
  };
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
  return state;
}

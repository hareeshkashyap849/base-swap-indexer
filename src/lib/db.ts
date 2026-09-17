/**
 * SQLite storage layer.
 *
 * Design decisions (frozen in S2 section 3, repeated here because they matter
 * to anyone reading this file first):
 *
 *   - Raw fields are stored; derived values (price, side, volume) are computed
 *     at query time. If the price formula turns out to be wrong we can fix the
 *     code and re-read the same rows, instead of having the bug baked into the
 *     table. amount0/amount1 are kept as TEXT because they are int256 and
 *     would overflow SQLite's 64-bit INTEGER.
 *
 *   - blockHash is stored so chain reorganisations are detectable: if the hash
 *     we recorded no longer matches the chain, every row from that block on is
 *     deleted and re-indexed (INV-4).
 *
 *   - Reproducibility is enforced structurally by PRIMARY KEY (block_number,
 *     log_index) plus INSERT OR IGNORE, which makes re-indexing a range
 *     idempotent (INV-1) rather than something we merely hope for.
 *
 *   - No ORM. Hand-written SQL is part of what this project is meant to
 *     demonstrate, and an ORM would hide the index and query-plan decisions
 *     that dominate indexer performance.
 *
 *   - Storage uses Node's built-in `node:sqlite`, not better-sqlite3.
 *     better-sqlite3 is a native module: installing it runs node-gyp, which
 *     needs a compiler toolchain (and was blocked outright in the environment
 *     this was built in). Using the builtin means a reviewer needs nothing but
 *     Node itself — no compiler, no Python, no extra dependency — which is the
 *     whole point of the "one command to run" requirement.
 *     Trade-off, stated plainly: on Node 24 `node:sqlite` is marked
 *     experimental and prints a startup warning, and its API is smaller than
 *     better-sqlite3's. `openStore()` is the only place the driver is chosen,
 *     so swapping back is a small, contained change.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SwapRow {
  blockNumber: bigint;
  blockHash: string;
  txHash: string;
  logIndex: number;
  txIndex: number;
  timestamp: number;
  sender: string;
  recipient: string;
  /** Signed int256 as a decimal string — never a JS number. */
  amount0: string;
  amount1: string;
  sqrtPriceX96: string;
  liquidity: string;
  tick: number;
}

export interface BlockRow {
  blockNumber: bigint;
  blockHash: string;
  parentHash: string;
  timestamp: number;
}

export interface IndexerState {
  lastIndexedBlock: number;
  chainHeadAtLastRun: number;
  updatedAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS swaps (
  block_number   INTEGER NOT NULL,
  log_index      INTEGER NOT NULL,
  block_hash     TEXT    NOT NULL,
  tx_hash        TEXT    NOT NULL,
  tx_index       INTEGER NOT NULL,
  timestamp      INTEGER NOT NULL,
  sender         TEXT    NOT NULL,
  recipient      TEXT    NOT NULL,
  amount0        TEXT    NOT NULL,   -- signed int256, decimal string
  amount1        TEXT    NOT NULL,   -- signed int256, decimal string
  sqrt_price_x96 TEXT    NOT NULL,
  liquidity      TEXT    NOT NULL,
  tick           INTEGER NOT NULL,
  PRIMARY KEY (block_number, log_index)
);

-- Dashboard queries are almost always "latest N" or "this time window",
-- so block_number ordering is the access path that matters.
CREATE INDEX IF NOT EXISTS idx_swaps_block     ON swaps (block_number DESC);
CREATE INDEX IF NOT EXISTS idx_swaps_timestamp ON swaps (timestamp DESC);
-- Used to compute unique traders and to filter by participant.
CREATE INDEX IF NOT EXISTS idx_swaps_recipient ON swaps (recipient);

CREATE TABLE IF NOT EXISTS blocks (
  block_number INTEGER PRIMARY KEY,
  block_hash   TEXT NOT NULL,
  parent_hash  TEXT NOT NULL,
  timestamp    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS indexer_state (
  id                     INTEGER PRIMARY KEY CHECK (id = 1),
  last_indexed_block     INTEGER NOT NULL,
  chain_head_at_last_run INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

-- Append-only log so a reviewer can see what the indexer actually did,
-- including every reorg it recovered from.
CREATE TABLE IF NOT EXISTS indexer_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     INTEGER NOT NULL,
  level  TEXT    NOT NULL,
  event  TEXT    NOT NULL,
  detail TEXT
);
`;

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(path);
    // WAL keeps reads fast while the indexer is writing; the dashboard is a
    // separate process reading the same file.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  /**
   * Run `fn` inside a transaction.
   *
   * Written by hand rather than with a helper: `node:sqlite` has no
   * Transaction wrapper, and being explicit here makes the rollback path
   * obvious — which matters because a half-written block is exactly the kind
   * of corruption this project must not produce.
   */
  private txn<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Insert swaps for one block range. Idempotent: re-running changes nothing (INV-1). */
  insertSwaps(rows: readonly SwapRow[]): number {
    if (rows.length === 0) return 0;
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO swaps (
        block_number, log_index, block_hash, tx_hash, tx_index, timestamp,
        sender, recipient, amount0, amount1, sqrt_price_x96, liquidity, tick
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return this.txn(() => {
      let inserted = 0;
      for (const r of rows) {
        const res = stmt.run(
          Number(r.blockNumber),
          r.logIndex,
          r.blockHash,
          r.txHash,
          r.txIndex,
          r.timestamp,
          r.sender,
          r.recipient,
          r.amount0,
          r.amount1,
          r.sqrtPriceX96,
          r.liquidity,
          r.tick,
        );
        inserted += Number(res.changes);
      }
      return inserted;
    });
  }

  upsertBlock(b: BlockRow): void {
    this.db
      .prepare(
        `INSERT INTO blocks (block_number, block_hash, parent_hash, timestamp)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(block_number) DO UPDATE SET
           block_hash  = excluded.block_hash,
           parent_hash = excluded.parent_hash,
           timestamp   = excluded.timestamp`,
      )
      .run(Number(b.blockNumber), b.blockHash, b.parentHash, b.timestamp);
  }

  /**
   * Delete everything at or after a block, and any recorded block headers.
   * Used by reorg recovery.
   */
  rollbackFrom(blockNumber: bigint): { swaps: number; blocks: number } {
    const n = Number(blockNumber);
    return this.txn(() => {
      const swaps = Number(this.db.prepare('DELETE FROM swaps WHERE block_number >= ?').run(n).changes);
      const blocks = Number(this.db.prepare('DELETE FROM blocks WHERE block_number >= ?').run(n).changes);
      return { swaps, blocks };
    });
  }

  /** Recorded hash for a block, or undefined if we never stored it. */
  getBlockHash(blockNumber: bigint): string | undefined {
    const row = this.db
      .prepare('SELECT block_hash FROM blocks WHERE block_number = ?')
      .get(Number(blockNumber)) as { block_hash: string } | undefined;
    return row?.block_hash;
  }

  /**
   * Recorded timestamps for a set of blocks, keyed as `String(blockNumber)`.
   *
   * WHY THIS EXISTS: A TIMESTAMP IS IMMUTABLE, SO FETCHING IT TWICE IS PURE WASTE.
   *
   * Every header this project has ever fetched is already in the `blocks` table -- `upsertBlock`
   * puts it there, and `rollbackFrom` is the only thing that removes it. But a run needs one header
   * per distinct block containing a swap: an **estimated** ~120,000 headers for a 200,000-block
   * window, which the window this project actually indexed turned out to hold 53,467 of -- 2.2x fewer
   * (README, "Scale"). Until this method existed the run re-fetched every one of them on every pass
   * because the cache started empty each time.
   *
   * The cost is not theoretical: measured on the public endpoints, a header batch that lands on a
   * rate-limited endpoint waits out its timeout, so the header phase ran at ~1.7 swap-bearing
   * blocks/s -- that attempt's own figure, attributed rather than recorded, as the estimate above is
   * -- and the repeated work extrapolates to about twenty hours, which is exactly `~120,000 / 1.7`.
   * The twenty hours moves with the estimate; the rate it divides by does not, and the window's real
   * 53,467 headers at 1.7/s is 8.7 hours of that repeat work rather than twenty.
   *
   * Batched through a temporary table rather than an `IN (...)` list: a parameter list of that size
   * exceeds SQLite's variable limit, and the failure ("too many SQL variables") would arrive
   * only on the large runs this exists to make possible.
   */
  getBlockTimestamps(blockNumbers: readonly bigint[]): Map<string, number> {
    const out = new Map<string, number>();
    if (blockNumbers.length === 0) return out;
    return this.txn(() => {
      this.db.exec('CREATE TEMP TABLE IF NOT EXISTS _wanted (block_number INTEGER PRIMARY KEY)');
      this.db.exec('DELETE FROM _wanted');
      const insert = this.db.prepare('INSERT OR IGNORE INTO _wanted (block_number) VALUES (?)');
      for (const n of blockNumbers) insert.run(Number(n));
      const rows = this.db
        .prepare(
          'SELECT b.block_number AS n, b.timestamp AS t FROM blocks b JOIN _wanted w ON w.block_number = b.block_number',
        )
        .all() as Array<{ n: number; t: number }>;
      for (const row of rows) out.set(String(row.n), row.t);
      this.db.exec('DELETE FROM _wanted');
      return out;
    });
  }

  getState(): IndexerState | undefined {
    const row = this.db
      .prepare(
        'SELECT last_indexed_block, chain_head_at_last_run, updated_at FROM indexer_state WHERE id = 1',
      )
      .get() as
      | { last_indexed_block: number; chain_head_at_last_run: number; updated_at: number }
      | undefined;
    if (!row) return undefined;
    return {
      lastIndexedBlock: row.last_indexed_block,
      chainHeadAtLastRun: row.chain_head_at_last_run,
      updatedAt: row.updated_at,
    };
  }

  setState(lastIndexedBlock: bigint, chainHead: bigint): void {
    this.db
      .prepare(
        `INSERT INTO indexer_state (id, last_indexed_block, chain_head_at_last_run, updated_at)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           last_indexed_block     = excluded.last_indexed_block,
           chain_head_at_last_run = excluded.chain_head_at_last_run,
           updated_at             = excluded.updated_at`,
      )
      .run(Number(lastIndexedBlock), Number(chainHead), Date.now());
  }

  log(level: 'info' | 'warn' | 'error', event: string, detail?: string): void {
    this.db
      .prepare('INSERT INTO indexer_log (ts, level, event, detail) VALUES (?, ?, ?, ?)')
      .run(Date.now(), level, event, detail ?? null);
  }

  countSwaps(): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM swaps').get() as { n: number };
    return r.n;
  }

  minBlock(): bigint | null {
    const r = this.db.prepare('SELECT MIN(block_number) AS m FROM swaps').get() as { m: number | null };
    return r.m === null ? null : BigInt(r.m);
  }

  maxBlock(): bigint | null {
    const r = this.db.prepare('SELECT MAX(block_number) AS m FROM swaps').get() as { m: number | null };
    return r.m === null ? null : BigInt(r.m);
  }

  close(): void {
    this.db.close();
  }
}

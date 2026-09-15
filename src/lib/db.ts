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

/**
 * Read-side queries for the API.
 *
 * Notes on the shape of this layer:
 *
 *   - Every statement is parameterised. There is no string interpolation of
 *     user input anywhere, which removes SQL injection as a category.
 *   - Prices are computed here from the stored raw fields rather than being
 *     read from a precomputed column, so a bug in the price formula can be
 *     fixed and immediately reflected without a re-index.
 *   - OHLC aggregation is done in JavaScript, not SQL. SQL *can* do it with
 *     window functions, but the price needs a sqrtPriceX96 -> float transform
 *     that SQLite cannot express cleanly, and having one implementation of
 *     that transform (src/lib/price.ts) is worth more than pushing the group-by
 *     into the database. Buckets are bounded, so the memory cost is small and
 *     explicit.
 */

import type { DatabaseSync } from 'node:sqlite';
import { priceFromSqrtPriceX96, swapEconomics, type SwapEconomics } from './price.ts';

export interface SwapDto {
  blockNumber: number;
  logIndex: number;
  timestamp: number;
  txHash: string;
  sender: string;
  recipient: string;
  /** WETH amount, signed and human-scaled. Positive = pool received WETH. */
  amount0: number;
  /** USDC amount, signed and human-scaled. Positive = pool received USDC. */
  amount1: number;
  side: 'buy_token0' | 'sell_token0';
  /** Convenience label for the dashboard: what the trader did with WETH. */
  action: 'buy' | 'sell';
  /** Trade size in USDC (absolute). */
  volumeUsdc: number;
  /** Pool price after the swap, in USDC per WETH. */
  price: number;
  tick: number;
}

export interface StatsDto {
  trades: number;
  volumeUsdc: number;
  vwap: number;
  priceNow: number;
  priceFirst: number;
  /** Fractional change over the indexed window, e.g. 0.012 = +1.2%. */
  changePct: number;
  uniqueTraders: number;
  firstBlock: number | null;
  lastBlock: number | null;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  /** Min/max price in the window — shows the range the price actually covered. */
  low: number;
  high: number;
}

export interface CandleDto {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsdc: number;
  trades: number;
}

interface SwapDbRow {
  block_number: number;
  log_index: number;
  timestamp: number;
  tx_hash: string;
  sender: string;
  recipient: string;
  amount0: string;
  amount1: string;
  sqrt_price_x96: string;
  tick: number;
}

export const DECIMALS0 = 18; // WETH
export const DECIMALS1 = 6; // USDC

/** Map a database row to the API shape, doing all derived maths once. */
export function toSwapDto(r: SwapDbRow): SwapDto {
  const amount0 = BigInt(r.amount0);
  const amount1 = BigInt(r.amount1);
  const econ: SwapEconomics = swapEconomics({
    amount0,
    amount1,
    decimals0: DECIMALS0,
    decimals1: DECIMALS1,
  });
  return {
    blockNumber: r.block_number,
    logIndex: r.log_index,
    timestamp: r.timestamp,
    txHash: r.tx_hash,
    sender: r.sender,
    recipient: r.recipient,
    amount0: econ.side === 'sell_token0' ? econ.amount0Abs : -econ.amount0Abs,
    amount1: econ.side === 'sell_token0' ? -econ.amount1Abs : econ.amount1Abs,
    side: econ.side,
    action: econ.side === 'buy_token0' ? 'buy' : 'sell',
    volumeUsdc: econ.volumeToken1,
    price: priceFromSqrtPriceX96(BigInt(r.sqrt_price_x96), DECIMALS0, DECIMALS1),
    tick: r.tick,
  };
}

export class Repo {
  // Declared and assigned explicitly rather than as a constructor parameter
  // property: parameter properties need real codegen, so Node's strip-only
  // TypeScript loader rejects them (and `erasableSyntaxOnly` flags them at
  // typecheck time, which is where this was caught).
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * Most recent swaps, newest first.
   *
   * Ordering is (block_number DESC, log_index DESC) rather than timestamp,
   * because several swaps share a block and only log_index gives a total order
   * within it. Ordering by timestamp alone would shuffle same-second trades
   * non-deterministically, which makes pagination unsound.
   */
  recentSwaps(limit: number): SwapDto[] {
    const rows = this.db
      .prepare(
        `SELECT block_number, log_index, timestamp, tx_hash, sender, recipient,
                amount0, amount1, sqrt_price_x96, tick
         FROM swaps
         ORDER BY block_number DESC, log_index DESC
         LIMIT ?`,
      )
      .all(limit) as unknown as SwapDbRow[];
    return rows.map(toSwapDto);
  }

  /**
   * Swaps before a cursor, for "load more" pagination.
   * The cursor encodes the exact (block, logIndex) of the last row the client
   * saw, so pages cannot overlap or skip even under concurrent inserts.
   */
  swapsBefore(blockNumber: number, logIndex: number, limit: number): SwapDto[] {
    const rows = this.db
      .prepare(
        `SELECT block_number, log_index, timestamp, tx_hash, sender, recipient,
                amount0, amount1, sqrt_price_x96, tick
         FROM swaps
         WHERE (block_number < ?) OR (block_number = ? AND log_index < ?)
         ORDER BY block_number DESC, log_index DESC
         LIMIT ?`,
      )
      .all(blockNumber, blockNumber, logIndex, limit) as unknown as SwapDbRow[];
    return rows.map(toSwapDto);
  }

  /** All swaps in a time window, oldest first (the order OHLC aggregation needs). */
  swapsBetween(fromTs: number, toTs: number, cap = 200_000): SwapDto[] {
    const rows = this.db
      .prepare(
        `SELECT block_number, log_index, timestamp, tx_hash, sender, recipient,
                amount0, amount1, sqrt_price_x96, tick
         FROM swaps
         WHERE timestamp >= ? AND timestamp <= ?
         ORDER BY block_number ASC, log_index ASC
         LIMIT ?`,
      )
      .all(fromTs, toTs, cap) as unknown as SwapDbRow[];
    return rows.map(toSwapDto);
  }

  /**
   * Aggregate statistics for a time window.
   *
   * VWAP is volume-weighted by USDC volume, which is the meaningful weight for
   * a WETH/USDC pool: it answers "at what average price did USDC actually
   * change hands", not "what was the average of the printed prices".
   */
  stats(fromTs: number, toTs: number): StatsDto {
    const swaps = this.swapsBetween(fromTs, toTs);
    if (swaps.length === 0) {
      return {
        trades: 0,
        volumeUsdc: 0,
        vwap: 0,
        priceNow: 0,
        priceFirst: 0,
        changePct: 0,
        uniqueTraders: 0,
        firstBlock: null,
        lastBlock: null,
        firstTimestamp: null,
        lastTimestamp: null,
        low: 0,
        high: 0,
      };
    }

    let volume = 0;
    let notional = 0;
    let low = Infinity;
    let high = -Infinity;
    const traders = new Set<string>();
    for (const s of swaps) {
      volume += s.volumeUsdc;
      notional += s.volumeUsdc * s.price;
      low = Math.min(low, s.price);
      high = Math.max(high, s.price);
      traders.add(s.recipient);
    }
    const first = swaps[0]!;
    const last = swaps[swaps.length - 1]!;
    const priceFirst = first.price;
    const priceNow = last.price;

    return {
      trades: swaps.length,
      volumeUsdc: volume,
      vwap: volume > 0 ? notional / volume : 0,
      priceNow,
      priceFirst,
      changePct: priceFirst > 0 ? (priceNow - priceFirst) / priceFirst : 0,
      uniqueTraders: traders.size,
      firstBlock: first.blockNumber,
      lastBlock: last.blockNumber,
      firstTimestamp: first.timestamp,
      lastTimestamp: last.timestamp,
      low: Number.isFinite(low) ? low : 0,
      high: Number.isFinite(high) ? high : 0,
    };
  }

  /**
   * Build OHLCV candles.
   *
   * `intervalSeconds` must be one of the allowed values (validated by the
   * route) so the bucket boundaries stay aligned with what clients expect;
   * arbitrary intervals make candles impossible to compare across requests.
   */
  ohlcv(fromTs: number, toTs: number, intervalSeconds: number, maxCandles = 500): CandleDto[] {
    const swaps = this.swapsBetween(fromTs, toTs);
    if (swaps.length === 0) return [];

    const buckets = new Map<number, CandleDto>();
    for (const s of swaps) {
      const ts = Math.floor(s.timestamp / intervalSeconds) * intervalSeconds;
      const existing = buckets.get(ts);
      if (!existing) {
        buckets.set(ts, {
          ts,
          open: s.price,
          high: s.price,
          low: s.price,
          close: s.price,
          volumeUsdc: s.volumeUsdc,
          trades: 1,
        });
      } else {
        // swaps are iterated oldest-first, so the first write is the open and
        // each subsequent write moves the close.
        existing.high = Math.max(existing.high, s.price);
        existing.low = Math.min(existing.low, s.price);
        existing.close = s.price;
        existing.volumeUsdc += s.volumeUsdc;
        existing.trades += 1;
      }
    }

    const out = [...buckets.values()].sort((a, b) => a.ts - b.ts);
    // Keep the most recent `maxCandles` buckets: a chart wants the recent tail,
    // and this bounds the response size for any requested window.
    return out.length > maxCandles ? out.slice(out.length - maxCandles) : out;
  }

  /** Distinct recipients over a window, used as a trader-count proxy. */
  uniqueTraders(fromTs: number, toTs: number): number {
    const r = this.db
      .prepare('SELECT COUNT(DISTINCT recipient) AS n FROM swaps WHERE timestamp >= ? AND timestamp <= ?')
      .get(fromTs, toTs) as { n: number };
    return r.n;
  }
}

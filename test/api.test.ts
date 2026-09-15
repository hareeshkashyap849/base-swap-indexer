/**
 * API tests.
 *
 * These run against a temporary SQLite database seeded with synthetic swaps
 * that reproduce the real shapes: signed int256 amounts stored as strings, a
 * real pool sqrtPriceX96, and 6/18 decimals. No network access, so the suite is
 * meaningful offline.
 *
 * The requirement driving most of these cases is F12: bad input must produce a
 * 4xx with a clear message, never a 500. A 500 on malformed input means the
 * first thing an integrator sees is a stack trace.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/api/server.ts';
import { Store, type SwapRow } from '../src/lib/db.ts';
import { priceFromSqrtPriceX96 } from '../src/lib/price.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ABI_DEC0 = 18; // WETH
const ABI_DEC1 = 6; // USDC

/** Real pool price, so derived numbers look like the real thing. */
const SQRT_PRICE = 3916385922366450481262234n;

function makeSwap(i: number, buyWeth: boolean, baseTs: number, price?: bigint): SwapRow {
  const weth = 10n ** 18n; // 1 WETH
  const usdc = 2443n * 10n ** 6n;
  return {
    blockNumber: 1000n + BigInt(i),
    blockHash: `0xblock${i}`,
    txHash: `0xtx${i}`,
    logIndex: i,
    txIndex: i,
    timestamp: baseTs + i * 60,
    sender: `0xsender${i % 3}`,
    recipient: `0xtrader${i % 4}`,
    // A WETH sell means the pool RECEIVES weth (+amount0) and PAYS usdc (-amount1).
    amount0: (buyWeth ? -weth : weth).toString(),
    amount1: (buyWeth ? usdc : -usdc).toString(),
    sqrtPriceX96: (price ?? SQRT_PRICE).toString(),
    liquidity: '1505864926519222278',
    tick: -198309,
  };
}

interface Harness {
  app: ReturnType<typeof buildServer>['app'];
}

/**
 * Seed a temp database, boot the API on it, and guarantee both are torn down.
 *
 * Closing the store explicitly is required on Windows: an open SQLite handle
 * keeps the file locked, so deleting the temp directory afterwards fails with
 * EPERM. Centralising teardown here means no test can forget it.
 */
async function withServer(fn: (h: Harness) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'bsi-test-'));
  const dbPath = join(dir, 'test.sqlite');
  try {
    const store = new Store(dbPath);
    const now = Math.floor(Date.now() / 1000);
    const rows: SwapRow[] = [];
    for (let i = 0; i < 20; i++) rows.push(makeSwap(i, i % 2 === 0, now - 1200));
    store.insertSwaps(rows);
    store.upsertBlock({ blockNumber: 1000n, blockHash: '0xblock0', parentHash: '0xp', timestamp: now - 1200 });
    store.setState(1019n, 1020n);
    store.close();

    const { app, close } = buildServer({ dbPath, skipChainHead: true });
    try {
      await fn({ app });
    } finally {
      await close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('GET / serves the dashboard when present, or describes the API when not', async () => {
  await withServer(async ({ app }) => {
    const res = await app.inject({ method: 'GET', url: '/' });
    assert.equal(res.statusCode, 200);
    // Two acceptable shapes:
    //   - dashboard/index.html exists  -> HTML (the normal case)
    //   - partial checkout, no file    -> JSON service description
    // Asserting only one of them would make the suite depend on which files the
    // person running it happened to check out.
    if (res.headers['content-type']?.includes('text/html')) {
      assert.match(res.body, /<!doctype html>/i);
      assert.match(res.body, /<title>[^<]*WETH\/USDC[^<]*<\/title>/i);
    } else {
      const body = res.json();
      assert.equal(body.pair, 'WETH/USDC');
      assert.equal(body.chainId, 8453);
      assert.ok(Array.isArray(body.endpoints));
    }
  });
});

test('GET /api/swaps returns newest first and a working cursor', async () => {
  await withServer(async ({ app }) => {
    const res = await app.inject({ method: 'GET', url: '/api/swaps?limit=5' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.count, 5);

    const blocks = body.swaps.map((x: { blockNumber: number }) => x.blockNumber);
    for (let i = 1; i < blocks.length; i++) {
      assert.ok(blocks[i] < blocks[i - 1], `expected descending blocks, got ${blocks.join(',')}`);
    }
    assert.ok(body.nextCursor, 'a full page must return a cursor');

    const c = body.nextCursor;
    const res2 = await app.inject({
      method: 'GET',
      url: `/api/swaps?limit=5&beforeBlock=${c.beforeBlock}&beforeLogIndex=${c.beforeLogIndex}`,
    });
    assert.equal(res2.statusCode, 200);
    const firstPage = new Set(
      body.swaps.map((x: { blockNumber: number; logIndex: number }) => `${x.blockNumber}:${x.logIndex}`),
    );
    for (const row of res2.json().swaps as Array<{ blockNumber: number; logIndex: number }>) {
      assert.ok(!firstPage.has(`${row.blockNumber}:${row.logIndex}`), 'pages must not overlap');
    }
  });
});

test('swaps carry a derived price close to the real pool price', async () => {
  await withServer(async ({ app }) => {
    const sw = (await app.inject({ method: 'GET', url: '/api/swaps?limit=1' })).json().swaps[0];
    const expected = priceFromSqrtPriceX96(SQRT_PRICE, ABI_DEC0, ABI_DEC1);
    assert.ok(Math.abs(sw.price - expected) < 1e-6, `price ${sw.price} vs ${expected}`);
    // Direction check: an inverted token order would land near 4e-4.
    assert.ok(sw.price > 2000 && sw.price < 3000, `expected ~2443 USDC/WETH, got ${sw.price}`);
    assert.ok(['buy', 'sell'].includes(sw.action));
    assert.ok(sw.volumeUsdc > 0, 'volume must be positive regardless of direction');
  });
});

test('GET /api/ohlcv aggregates into well-formed candles', async () => {
  await withServer(async ({ app }) => {
    const body = (await app.inject({ method: 'GET', url: '/api/ohlcv?interval=5m&hours=1' })).json();
    assert.ok(body.count > 0, 'expected at least one candle');
    for (const c of body.candles) {
      assert.ok(c.high >= c.low, 'high must be >= low');
      assert.ok(c.high >= c.open && c.high >= c.close, 'high must bound open/close');
      assert.ok(c.low <= c.open && c.low <= c.close, 'low must bound open/close');
      assert.ok(c.trades >= 1);
      assert.ok(c.volumeUsdc > 0);
    }
    for (let i = 1; i < body.candles.length; i++) {
      assert.ok(body.candles[i].ts > body.candles[i - 1].ts, 'candles must ascend in time');
    }
  });
});

test('GET /api/stats aggregates consistently with the rows (INV-5)', async () => {
  await withServer(async ({ app }) => {
    const stats = (await app.inject({ method: 'GET', url: '/api/stats?hours=1' })).json();
    const swaps = (await app.inject({ method: 'GET', url: '/api/swaps?limit=500' })).json().swaps;
    assert.equal(stats.trades, swaps.length, 'stats.trades must equal the row count');
    const vol = swaps.reduce((n: number, x: { volumeUsdc: number }) => n + x.volumeUsdc, 0);
    assert.ok(Math.abs(stats.volumeUsdc - vol) < 0.01, 'volume must match the sum of rows');
    assert.ok(stats.vwap > 0);
    assert.ok(stats.high >= stats.low);
    assert.ok(stats.uniqueTraders > 0);
  });
});

// --------------------------------------------------------------------------
// F12: malformed input must be a 4xx, never a 500.
// --------------------------------------------------------------------------

test('F12: limit out of range is rejected with 4xx', async () => {
  await withServer(async ({ app }) => {
    for (const url of [
      '/api/swaps?limit=0',
      '/api/swaps?limit=-5',
      '/api/swaps?limit=99999',
      '/api/swaps?limit=abc',
      '/api/swaps?limit=2.5',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      assert.ok(res.statusCode >= 400 && res.statusCode < 500, `${url} -> ${res.statusCode}`);
      assert.notEqual(res.statusCode, 500, `${url} must not 500`);
    }
  });
});

test('F12: unknown or malformed interval is rejected with 4xx', async () => {
  await withServer(async ({ app }) => {
    for (const url of ['/api/ohlcv?interval=7m', '/api/ohlcv?interval=', '/api/ohlcv?interval=1H']) {
      const res = await app.inject({ method: 'GET', url });
      assert.ok(res.statusCode >= 400 && res.statusCode < 500, `${url} -> ${res.statusCode}`);
      assert.notEqual(res.statusCode, 500);
    }
  });
});

test('F12: out-of-range hours and maxCandles are rejected', async () => {
  await withServer(async ({ app }) => {
    for (const url of [
      '/api/ohlcv?hours=0',
      '/api/ohlcv?hours=99999',
      '/api/stats?hours=-1',
      '/api/ohlcv?maxCandles=0',
      '/api/ohlcv?maxCandles=999999',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      assert.ok(res.statusCode >= 400 && res.statusCode < 500, `${url} -> ${res.statusCode}`);
    }
  });
});

test('F12: unknown query parameters are rejected rather than silently ignored', async () => {
  await withServer(async ({ app }) => {
    const res = await app.inject({ method: 'GET', url: '/api/swaps?limitt=5' });
    assert.ok(res.statusCode >= 400 && res.statusCode < 500, `typo should be rejected, got ${res.statusCode}`);
  });
});

test('F12: unknown route returns JSON 404, not an HTML error page', async () => {
  await withServer(async ({ app }) => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, 'not_found');
  });
});

test('F12: a half-supplied cursor falls back to the newest page', async () => {
  await withServer(async ({ app }) => {
    const res = await app.inject({ method: 'GET', url: '/api/swaps?limit=3&beforeBlock=1010' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().swaps[0].blockNumber, 1019);
  });
});

test('GET /api/health reports freshness and tolerates an unreachable chain', async () => {
  await withServer(async ({ app }) => {
    const body = (await app.inject({ method: 'GET', url: '/api/health' })).json();
    assert.equal(body.ok, true);
    assert.equal(body.lastIndexedBlock, 1019);
    assert.equal(body.swaps, 20);
    assert.equal(body.chainHead, null, 'with chain head skipped, lag is unknown rather than wrong');
    assert.equal(body.lag, null);
  });
});

test('responses expose data freshness via headers', async () => {
  await withServer(async ({ app }) => {
    const res = await app.inject({ method: 'GET', url: '/api/stats' });
    assert.equal(res.headers['x-last-indexed-block'], '1019');
    assert.ok(res.headers['x-indexer-updated-at']);
  });
});

test('empty database degrades gracefully instead of throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bsi-empty-'));
  const dbPath = join(dir, 'empty.sqlite');
  try {
    new Store(dbPath).close();
    const { app, close } = buildServer({ dbPath, skipChainHead: true });
    try {
      for (const url of ['/api/swaps', '/api/ohlcv', '/api/stats', '/api/health']) {
        const res = await app.inject({ method: 'GET', url });
        assert.equal(res.statusCode, 200, `${url} should still be 200 on an empty db`);
      }
      const stats = (await app.inject({ method: 'GET', url: '/api/stats' })).json();
      assert.equal(stats.trades, 0);
      assert.equal(stats.vwap, 0);
      assert.equal(stats.priceNow, 0);
    } finally {
      await close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

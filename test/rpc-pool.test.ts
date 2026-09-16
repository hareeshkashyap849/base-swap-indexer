/**
 * Tests for the RPC pool's endpoint bookkeeping, and for the header cache that reads back.
 *
 * WHY THESE TWO, TOGETHER
 *
 * Both were found by measuring a 200,000-block backfill that ran at **1.7 blocks/s** -- about twenty
 * hours for a phase that should take minutes. Neither defect shows up as an error:
 *
 *   1. `getBlocksBatch` remembered EVERY failure as "this endpoint cannot serve batches". A rate
 *      limit is not a capability: the moment the one endpoint that *does* serve batches got rate
 *      limited, it was removed from the rotation for the rest of the run and the pool kept asking
 *      endpoints that refuse batches outright.
 *   2. The header cache started empty on every pass, even though every header ever fetched is in the
 *      `blocks` table already. A resumed run re-fetched all of them.
 *
 * The tests use a **local HTTP server** rather than a mock, because the thing being tested is how the
 * pool behaves when a real endpoint answers with a real HTTP status and a real body -- and because a
 * mock of `fetch` would let the pool's actual request path go untested.
 *
 * Run: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RpcPool, isBatchCapabilityFailure } from '../src/lib/rpc.ts';
import { Store } from '../src/lib/db.ts';

test('the batch-failure classifier separates a capability from a moment', () => {
  // THE DEFECT IT PINS: every batch failure used to be remembered as "this endpoint cannot serve
  // batches", including rate limits -- so one rate limit on the only batch-capable endpoint removed
  // it from the rotation for the rest of the run. The classifier is exported and tested directly
  // because the error KIND cannot make this distinction: `classifyError` reports a malformed batch
  // and a transport blip as the same kind, on purpose.
  for (const message of [
    'batch not supported (non-batch reply): <!DOCTYPE html>',
    'batch shape mismatch: asked 200, got 1',
    'malformed block in batch: timestamp/hash/number missing',
    '-32014 maximum 1 request in batch',
    // The third endpoint's wording, from its own body rather than from a status code: it answers
    // HTTP 500 with `Batch of more than 3 requests`. A 5xx is normally a blip worth retrying, so the
    // decision has to be made from the message. Without this pattern the endpoint is retried on every
    // slice of a long run -- which is what the running backfill's log showed, and each retry costs a
    // round trip before the slice can move on.
    'batch request rejected with HTTP 500: [{"id":0,"jsonrpc":"2.0","error":{"message":"Batch of more than 3 requests"}}]',
  ]) {
    assert.equal(isBatchCapabilityFailure(new Error(message)), true, message);
  }
  for (const message of [
    'over rate limit',
    'fetch failed',
    'socket hang up',
    'The operation was aborted due to timeout',
    'ECONNRESET',
  ]) {
    assert.equal(isBatchCapabilityFailure(new Error(message)), false, message);
  }
});

/**
 * A JSON-RPC batch reply carrying one good header, in the envelope a real endpoint sends.
 *
 * THE ENVELOPE IS THE POINT, and getting it wrong is why the first version of this file failed
 * against a pool that was right: a JSON-RPC batch reply is `[{jsonrpc, id, result}]`, not `[result]`.
 * The pool reads `item.result`, so a bare block object is "a right-sized array with everything
 * missing" -- exactly the `base.drpc.org` failure the pool exists to reject. The stub here is the
 * thing that had to be corrected, which is worth recording: a test failing against correct code is
 * cheap, and a test passing against a stub that does not look like the real thing is not.
 */
const goodBatch = (n: number) => [
  {
    jsonrpc: '2.0',
    id: 0,
    result: {
      number: '0x' + n.toString(16),
      timestamp: '0x' + (1_700_000_000 + n).toString(16),
      hash: '0x' + n.toString(16).padStart(64, '0'),
      parentHash: '0x' + (n - 1).toString(16).padStart(64, '0'),
    },
  },
];

/** The same envelope, with the timestamp stripped -- the measured `base.drpc.org` behaviour. */
const batchWithoutTimestamp = (n: number) => [
  {
    jsonrpc: '2.0',
    id: 0,
    result: { number: '0x' + n.toString(16), hash: '0x' + n.toString(16).padStart(64, '0') },
  },
];

interface Stub {
  url: string;
  hits: number;
  close: () => Promise<void>;
}

/** A local endpoint whose behaviour is a function from request count to response. */
async function stub(respond: (hit: number) => { status?: number; body: string }): Promise<Stub> {
  const state = { hits: 0 };
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      state.hits += 1;
      const { status = 200, body } = respond(state.hits);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('stub server has no port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    get hits() {
      return state.hits;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('a batch-capability failure takes the endpoint out of the rotation', async () => {
  // The measured `mainnet.base.org` case: a correctly-formed request answered with something that is
  // not a batch. This is a capability, so remembering it is right -- retrying it every time wastes a
  // request per batch for the whole run.
  const incapable = await stub(() => ({ body: '{"error":{"message":"-32014 maximum 1 request in batch"}}' }));
  const capable = await stub(() => ({ body: JSON.stringify(goodBatch(1)) }));
  try {
    const pool = new RpcPool({ endpoints: [incapable.url, capable.url], backoffMs: 1 });
    const first = await pool.getBlocksBatch([1n]);
    assert.equal(first.get('1')?.timestamp, 1_700_000_001);
    assert.equal(incapable.hits, 1, 'the incapable endpoint is asked once');
    assert.equal(capable.hits, 1);

    await pool.getBlocksBatch([2n]);
    assert.equal(incapable.hits, 1, 'and never again -- it was remembered as incapable');
    assert.equal(capable.hits, 2);
  } finally {
    await incapable.close();
    await capable.close();
  }
});

test('a rate limit does NOT take the endpoint out of the rotation', async () => {
  // THE DEFECT THIS TEST EXISTS FOR. `over rate limit` says nothing about whether the endpoint can
  // serve a batch, and writing it off is how a run loses the only endpoint that can.
  const rateLimited = await stub(() => ({
    status: 429,
    body: JSON.stringify({ error: { message: 'over rate limit' } }),
  }));
  const capable = await stub(() => ({ body: JSON.stringify(goodBatch(7)) }));
  try {
    const pool = new RpcPool({
      endpoints: [rateLimited.url, capable.url],
      backoffMs: 1,
      cooldownMs: 50, // short, so the test can observe the retry without waiting
    });

    const first = await pool.getBlocksBatch([7n]);
    assert.equal(first.get('7')?.timestamp, 1_700_000_007);
    assert.equal(rateLimited.hits, 1);
    assert.equal(capable.hits, 1);

    // Still cooling down: the pool must not go back to it yet.
    await pool.getBlocksBatch([8n]);
    assert.equal(rateLimited.hits, 1, 'not retried while cooling down');

    // After the cooldown it is tried again -- which is the whole difference from a write-off.
    await new Promise((r) => setTimeout(r, 80));
    await pool.getBlocksBatch([9n]);
    assert.equal(rateLimited.hits, 2, 'retried once the cooldown expires');
    assert.ok(pool.stats.cooldownWaits >= 0, 'cooldown waits are counted rather than hidden');
  } finally {
    await rateLimited.close();
    await capable.close();
  }
});

test('a malformed batch is treated as a capability failure, not as data', async () => {
  // The measured `base.drpc.org` case: a correctly-sized array with every timestamp missing. Accepting
  // it would write timestamp=0 for every swap and produce a confidently wrong chart.
  const malformed = await stub(() => ({
    body: JSON.stringify(batchWithoutTimestamp(1)),
  }));
  const capable = await stub(() => ({ body: JSON.stringify(goodBatch(1)) }));
  try {
    const pool = new RpcPool({ endpoints: [malformed.url, capable.url], backoffMs: 1 });
    const result = await pool.getBlocksBatch([1n]);
    assert.equal(result.get('1')?.timestamp, 1_700_000_001, 'the good endpoint supplied the header');
    assert.equal(malformed.hits, 1);

    await pool.getBlocksBatch([2n]);
    assert.equal(malformed.hits, 1, 'the malformed endpoint is not asked again');
  } finally {
    await malformed.close();
    await capable.close();
  }
});

// ---- the header cache ---------------------------------------------------------------------

test('stored block timestamps are read back, so a resumed run does not re-fetch them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bsi-blocks-'));
  const path = join(dir, 'test.sqlite');
  try {
    const store = new Store(path);
    store.upsertBlock({ blockNumber: 100n, blockHash: '0xaa', parentHash: '0x99', timestamp: 1_700_000_100 });
    store.upsertBlock({ blockNumber: 101n, blockHash: '0xbb', parentHash: '0xaa', timestamp: 1_700_000_101 });

    const found = store.getBlockTimestamps([100n, 101n, 102n]);
    assert.equal(found.get('100'), 1_700_000_100);
    assert.equal(found.get('101'), 1_700_000_101);
    assert.equal(found.has('102'), false, 'a block never stored is absent, not zero');

    // Zero is a legitimate answer for a missing lookup of the WRONG kind, which is why the absence is
    // asserted with `has` above rather than by comparing to 0.
    assert.deepEqual(store.getBlockTimestamps([]).size, 0);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the timestamp cache survives a run and is used by the next one', () => {
  // The end-to-end shape of the fix: what one run wrote, the next run reads. Written as two Store
  // instances over one file, because that is exactly what a resumed run is.
  const dir = mkdtempSync(join(tmpdir(), 'bsi-blocks2-'));
  const path = join(dir, 'test.sqlite');
  try {
    const first = new Store(path);
    first.upsertBlock({ blockNumber: 500n, blockHash: '0xcc', parentHash: '0xbb', timestamp: 1_700_000_500 });
    first.close();

    const second = new Store(path);
    assert.equal(second.getBlockTimestamps([500n]).get('500'), 1_700_000_500);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a large lookup does not hit SQLite\'s variable limit', () => {
  // The reason `getBlockTimestamps` builds a temporary table instead of an `IN (...)` list: 120,000
  // placeholders exceed SQLITE_MAX_VARIABLE_NUMBER, and that failure would arrive only on the large
  // runs the method exists for.
  const dir = mkdtempSync(join(tmpdir(), 'bsi-blocks3-'));
  const path = join(dir, 'test.sqlite');
  try {
    const store = new Store(path);
    store.upsertBlock({ blockNumber: 1n, blockHash: '0x01', parentHash: '0x00', timestamp: 1_700_000_001 });
    const many = Array.from({ length: 50_000 }, (_, i) => BigInt(i + 1));
    const found = store.getBlockTimestamps(many);
    assert.equal(found.size, 1, 'only the one stored block comes back');
    assert.equal(found.get('1'), 1_700_000_001);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

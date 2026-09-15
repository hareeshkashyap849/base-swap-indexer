/**
 * Read-only HTTP API over the indexed swaps.
 *
 * Deliberate choices:
 *
 *   - Fastify rather than Express: its schema validation is what lets every
 *     bad-input case in the requirements (F12) return a 4xx with a useful
 *     message instead of a 500. That is a correctness feature here, not a
 *     performance one.
 *   - Read-only. There is no POST/PUT/DELETE anywhere, so there is no
 *     authentication surface to get wrong.
 *   - The database is opened read-only. The API must not be able to corrupt
 *     what the indexer wrote, and read-only means it structurally cannot.
 *   - Responses carry `lastIndexedBlock` and `lag` so a client can tell how
 *     stale the data is instead of assuming it is current.
 */

import Fastify from 'fastify';
import { DatabaseSync } from 'node:sqlite';
import { Repo } from '../lib/repo.ts';
import { RpcPool } from '../lib/rpc.ts';
import { POOL_ADDRESS, SYMBOL0, SYMBOL1, FEE } from '../config.ts';

const DEFAULT_DB = 'data/swaps.sqlite';
const MAX_LIMIT = 500;
const ALLOWED_INTERVALS: Record<string, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3_600,
  '4h': 14_400,
  '1d': 86_400,
};

export interface ServerOptions {
  dbPath?: string;
  port?: number;
  host?: string;
  /**
   * Skip the live chain-head lookup. Used by tests so they do not depend on
   * network access.
   */
  skipChainHead?: boolean;
}

export function buildServer(opts: ServerOptions = {}): {
  app: ReturnType<typeof Fastify>;
  repo: Repo;
  /** Exposed so callers (and tests) can release the file handle deterministically. */
  close: () => Promise<void>;
} {
  const dbPath = opts.dbPath ?? DEFAULT_DB;
  // readonly: the API is a consumer of the indexer's output, never a writer.
  // Read-only also means the API cannot corrupt what the indexer wrote, which
  // is a property worth having structurally rather than by convention.
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const repo = new Repo(db);
  const skipChainHead = opts.skipChainHead ?? false;

  // Fastify's default AJV config sets `removeAdditional: 'all'`, which SILENTLY
  // DELETES unknown query parameters instead of rejecting them. For a public
  // API that is the wrong default: a client that misspells `limit` as `limitt`
  // gets a 200 with defaulted data and no indication anything was wrong.
  // Turning it off makes typos a 400. `coerceTypes` and `useDefaults` are kept
  // so `?limit=5` still arrives as a number and defaults still apply.
  const app = Fastify({
    logger: false,
    ajv: {
      customOptions: {
        removeAdditional: false,
        coerceTypes: 'array',
        useDefaults: true,
        allErrors: false,
      },
    },
  });

  // Shared response header so every endpoint reports data freshness.
  app.addHook('onSend', async (_req, reply, payload) => {
    const state = (() => {
      try {
        return db
          .prepare('SELECT last_indexed_block, updated_at FROM indexer_state WHERE id = 1')
          .get() as { last_indexed_block: number; updated_at: number } | undefined;
      } catch {
        return undefined;
      }
    })();
    if (state) {
      reply.header('x-last-indexed-block', String(state.last_indexed_block));
      reply.header('x-indexer-updated-at', String(state.updated_at));
    }
    return payload;
  });

  app.get('/', async () => ({
    name: 'base-swap-indexer',
    pool: POOL_ADDRESS,
    pair: `${SYMBOL0}/${SYMBOL1}`,
    feeBps: FEE,
    chainId: 8453,
    endpoints: ['/api/health', '/api/swaps', '/api/ohlcv', '/api/stats'],
  }));

  app.get('/api/health', async () => {
    const state = db
      .prepare('SELECT last_indexed_block, chain_head_at_last_run, updated_at FROM indexer_state WHERE id = 1')
      .get() as { last_indexed_block: number; chain_head_at_last_run: number; updated_at: number } | undefined;
    const rows = repo.stats(0, Number.MAX_SAFE_INTEGER).trades;

    let chainHead: number | null = null;
    if (!skipChainHead) {
      try {
        chainHead = Number(await new RpcPool().run((c) => c.getBlockNumber()));
      } catch {
        // A public endpoint being unreachable is normal and must not make the
        // API look broken; it just means we cannot report lag right now.
        chainHead = null;
      }
    }

    const lastIndexed = state?.last_indexed_block ?? null;
    return {
      ok: lastIndexed !== null,
      lastIndexedBlock: lastIndexed,
      chainHead,
      lag: chainHead !== null && lastIndexed !== null ? chainHead - lastIndexed : null,
      updatedAt: state?.updated_at ?? null,
      swaps: rows,
    };
  });

  app.get(
    '/api/swaps',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: 50 },
            // Cursor pagination: block + logIndex identify the last row seen.
            beforeBlock: { type: 'integer', minimum: 0 },
            beforeLogIndex: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
    async (req) => {
      const q = req.query as { limit: number; beforeBlock?: number; beforeLogIndex?: number };
      const useCursor = q.beforeBlock !== undefined && q.beforeLogIndex !== undefined;
      const swaps = useCursor
        ? repo.swapsBefore(q.beforeBlock!, q.beforeLogIndex!, q.limit)
        : repo.recentSwaps(q.limit);
      const last = swaps[swaps.length - 1];
      return {
        count: swaps.length,
        swaps,
        nextCursor:
          swaps.length === q.limit && last
            ? { beforeBlock: last.blockNumber, beforeLogIndex: last.logIndex }
            : null,
      };
    },
  );

  app.get(
    '/api/ohlcv',
    {
      schema: {
        type: 'object',
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            interval: { type: 'string', enum: Object.keys(ALLOWED_INTERVALS), default: '1h' },
            hours: { type: 'number', minimum: 0.05, maximum: 24 * 30, default: 24 },
            maxCandles: { type: 'integer', minimum: 1, maximum: 2000, default: 500 },
          },
        },
      },
    },
    async (req) => {
      const q = req.query as { interval: keyof typeof ALLOWED_INTERVALS; hours: number; maxCandles: number };
      const intervalSeconds = ALLOWED_INTERVALS[q.interval]!;
      const now = Math.floor(Date.now() / 1000);
      const from = now - Math.floor(q.hours * 3600);
      const candles = repo.ohlcv(from, now, intervalSeconds, q.maxCandles);
      return {
        interval: q.interval,
        intervalSeconds,
        from,
        to: now,
        count: candles.length,
        candles,
      };
    },
  );

  app.get(
    '/api/stats',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            hours: { type: 'number', minimum: 0.05, maximum: 24 * 30, default: 24 },
          },
        },
      },
    },
    async (req) => {
      const q = req.query as { hours: number };
      const now = Math.floor(Date.now() / 1000);
      const from = now - Math.floor(q.hours * 3600);
      const stats = repo.stats(from, now);
      return { windowHours: q.hours, from, to: now, ...stats };
    },
  );

  // Unknown routes get a JSON 404 rather than Fastify's default, so a client
  // written against this API never has to parse an HTML error page.
  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: 'not_found', path: req.url });
  });

  /**
   * Shut down the HTTP server AND release the sqlite handle.
   *
   * Closing the database explicitly matters on Windows: an open handle keeps
   * the file locked, so a caller that deletes the database afterwards fails
   * with EPERM. Fastify's own close() does not touch our connection.
   */
  const close = async (): Promise<void> => {
    await app.close();
    try {
      db.close();
    } catch {
      // already closed
    }
  };

  return { app, repo, close };
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3001);
  const host = process.env.HOST ?? '127.0.0.1';
  const { app } = buildServer({ dbPath: process.env.DB ?? DEFAULT_DB });
  try {
    await app.listen({ port, host });
    console.log(`base-swap-indexer api`);
    console.log(`  listening : http://${host}:${port}`);
    console.log(`  endpoints : /api/health  /api/swaps  /api/ohlcv  /api/stats`);
  } catch (err) {
    console.error('failed to start:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}

// Only auto-start when run directly, so tests can import buildServer.
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  void main();
}

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
import { pathToFileURL } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/**
 * Locate the dashboard file.
 *
 * The contents are deliberately NOT cached. An earlier version read the file
 * once at module load and served that string forever, which meant editing the
 * dashboard changed nothing until the API was restarted — a stale-code trap
 * that cost real debugging time (the fix appeared not to work because the
 * running server was still serving the old page).
 *
 * Re-reading per request is the right trade here. The file is ~20 KB, it is
 * served to one person running this locally, and the alternative is a class of
 * bug where your edits silently do not apply. Correctness over a micro-optimism
 * nobody can measure.
 */
const DASHBOARD_PATH: string = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/api -> project root -> dashboard/index.html
  return join(here, '..', '..', 'dashboard', 'index.html');
})();

function readDashboard(): string | null {
  try {
    return existsSync(DASHBOARD_PATH) ? readFileSync(DASHBOARD_PATH, 'utf8') : null;
  } catch {
    return null;
  }
}

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

  app.get('/', async (_req, reply) => {
    // Serve the bundled single-file dashboard when it is present.
    //
    // The dashboard is one self-contained HTML file with no build step, so
    // serving it is a readFileSync rather than a static-file plugin plus a
    // dependency. Opening http://127.0.0.1:3001/ then shows real data with no
    // npm install, no bundler and no toolchain — which matters because the
    // first thing a reviewer does is try to look at the output.
    const dashboard = readDashboard();
    if (dashboard !== null) {
      reply.header('content-type', 'text/html; charset=utf-8');
      // Edits take effect on refresh; no restart required, and no stale copy
      // can be served from a browser cache either.
      reply.header('cache-control', 'no-store');
      return dashboard;
    }
    // Dashboard missing (e.g. a partial checkout): still describe the API.
    return {
      name: 'base-swap-indexer',
      pool: POOL_ADDRESS,
      pair: `${SYMBOL0}/${SYMBOL1}`,
      feeBps: FEE,
      chainId: 8453,
      note: 'dashboard/index.html not found; API endpoints are available below',
      endpoints: ['/api/health', '/api/swaps', '/api/ohlcv', '/api/stats'],
    };
  });

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
//
// The obvious `import.meta.url === \`file://${process.argv[1]}\`` check is
// wrong on Windows: argv[1] is `D:\path\server.ts` while import.meta.url is
// `file:///D:/path/server.ts` (three slashes, and a different drive-letter
// case). The comparison silently fails, main() never runs, and the process
// exits 0 with no output — which is exactly how this shipped once already.
// pathToFileURL does the mapping correctly on every platform.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}

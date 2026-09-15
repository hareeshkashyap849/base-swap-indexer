/**
 * Resilient JSON-RPC access over multiple public endpoints.
 *
 * Why this exists (all three observed on real calls, see S2 section 0):
 *   1. A single public endpoint rate-limits quickly — 6 concurrent eth_call
 *      requests returned "over rate limit".
 *   2. eth_getLogs over a wide block range is rejected outright.
 *   3. A response body above ~10 MB throws ResponseBodyTooLargeError before we
 *      ever see the data.
 *
 * Consequences that shape this module:
 *   - We rotate across every configured endpoint on failure instead of
 *     hammering one.
 *   - We classify errors, because the correct reaction differs: RATE_LIMIT and
 *     TOO_LARGE should make the caller shrink its request, while NETWORK should
 *     just be retried elsewhere.
 *   - Nothing is ever silently skipped. If every endpoint fails we throw.
 */

import { createPublicClient, http, type PublicClient } from 'viem';
import { base } from 'viem/chains';
import { RPC_URLS } from '../config.ts';

export type RpcErrorKind =
  | 'RATE_LIMIT'
  | 'TOO_LARGE'
  | 'RANGE_REJECTED'
  | 'NETWORK'
  | 'UNKNOWN';

export class RpcError extends Error {
  readonly kind: RpcErrorKind;
  readonly endpoint: string;
  override readonly cause?: unknown;

  constructor(kind: RpcErrorKind, endpoint: string, message: string, cause?: unknown) {
    super(`[${kind}] ${endpoint}: ${message}`);
    this.name = 'RpcError';
    this.kind = kind;
    this.endpoint = endpoint;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Map an arbitrary thrown value onto a kind we can act on.
 *
 * Deliberately matches on several spellings: public RPC providers return
 * inconsistent wording, and viem wraps provider errors in its own classes.
 */
export function classifyError(err: unknown): RpcErrorKind {
  const msg = String((err as { message?: unknown })?.message ?? err ?? '').toLowerCase();
  if (/rate limit|too many requests|429|over rate/.test(msg)) return 'RATE_LIMIT';
  if (/responsebodytoolarge|exceeded the size limit|body exceeded/.test(msg)) return 'TOO_LARGE';
  if (/block range|range is too large|query returned more than|limit exceeded|invalid params/.test(msg))
    return 'RANGE_REJECTED';
  if (/fetch failed|econnreset|etimedout|socket|timeout|abort/.test(msg)) return 'NETWORK';
  // Public endpoints often answer with an HTML error page (HTTP 5xx) or strip
  // fields out of a batch reply. Both surface as parse/shape failures rather
  // than transport errors, but the right reaction is the same: stop trusting
  // this endpoint and try another.
  if (/non-json|non-batch|unexpected token|doctype|json at position|malformed/.test(msg)) return 'NETWORK';
  return 'UNKNOWN';
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface RpcPoolOptions {
  /** Endpoints to rotate through. Defaults to the configured public list. */
  endpoints?: readonly string[];
  /** Max attempts across all endpoints before giving up. */
  maxAttempts?: number;
  /** Base backoff in ms; multiplied by the attempt number. */
  backoffMs?: number;
  /** Called for every failure, useful for progress output and metrics. */
  onError?: (err: RpcError, attempt: number) => void;
}

export interface RpcStats {
  calls: number;
  failures: number;
  /** Failures per endpoint — makes rate limiting visible instead of mysterious. */
  failuresByEndpoint: Record<string, number>;
}

/**
 * A client that walks the endpoint list on failure.
 *
 * A new viem client is constructed per attempt on purpose: tying one client to
 * one transport is what makes endpoint rotation impossible, and the per-client
 * state we would lose (request batching) is irrelevant to our workload.
 */
export class RpcPool {
  private readonly endpoints: readonly string[];
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly onError?: (err: RpcError, attempt: number) => void;
  private cursor = 0;

  readonly stats: RpcStats = { calls: 0, failures: 0, failuresByEndpoint: {} };

  /**
   * Endpoints that have demonstrated they cannot serve a batch request.
   *
   * Learned from the first rejection rather than configured, because the
   * behaviour is a property of the provider, not something we can read from
   * documentation. Measured: `mainnet.base.org` answers a batch with
   * `-32014 maximum 1 request in batch`, while `base.drpc.org` accepts the
   * batch but returns blocks with `timestamp` missing.
   *
   * Without this memo, every batch attempt walks the whole endpoint list,
   * sleeping on each failure — which is exactly how a 10k-block backfill ended
   * up making 123 calls with 59 failures before this was added.
   */
  private readonly batchIncapable = new Set<string>();

  constructor(opts: RpcPoolOptions = {}) {
    this.endpoints = opts.endpoints ?? RPC_URLS;
    this.maxAttempts = opts.maxAttempts ?? this.endpoints.length * 3;
    this.backoffMs = opts.backoffMs ?? 400;
    if (opts.onError) this.onError = opts.onError;
    if (this.endpoints.length === 0) throw new Error('RpcPool requires at least one endpoint');
  }

  /** Number of distinct endpoints available (used for diagnostics). */
  get endpointCount(): number {
    return this.endpoints.length;
  }

  /**
   * Run `fn` against successive endpoints until one succeeds.
   *
   * Backoff grows linearly with the attempt count. RATE_LIMIT failures back off
   * harder than others because retrying a rate-limited endpoint immediately is
   * how you get banned.
   */
  async run<T>(fn: (client: PublicClient) => Promise<T>): Promise<T> {
    let lastErr: RpcError | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const endpoint = this.endpoints[this.cursor % this.endpoints.length]!;
      this.cursor++;
      this.stats.calls++;

      const client = createPublicClient({
        chain: base,
        transport: http(endpoint, { timeout: 45_000, retryCount: 0 }),
      }) as PublicClient;

      try {
        return await fn(client);
      } catch (raw) {
        const kind = classifyError(raw);
        const err = new RpcError(kind, endpoint, String((raw as Error)?.message ?? raw), raw);
        lastErr = err;
        this.stats.failures++;
        this.stats.failuresByEndpoint[endpoint] = (this.stats.failuresByEndpoint[endpoint] ?? 0) + 1;
        this.onError?.(err, attempt);

        const isLast = attempt === this.maxAttempts;
        if (isLast) break;

        const base = kind === 'RATE_LIMIT' ? this.backoffMs * 3 : this.backoffMs;
        await sleep(base * attempt);
      }
    }

    throw lastErr ?? new Error('RpcPool: exhausted attempts with no recorded error');
  }

  /** Convenience wrapper for `eth_getLogs` shaped calls. */
  async getLogs<T>(fn: (client: PublicClient) => Promise<T>): Promise<T> {
    return this.run(fn);
  }

  /**
   * Fetch many block headers in one HTTP request using JSON-RPC batching.
   *
   * Why batching matters: indexing 10,000 blocks touches thousands of distinct
   * blocks, and one request per header is both slow and the quickest way to get
   * rate limited. Batching turns hundreds of round trips into one.
   *
   * Why this VALIDATES instead of counting: not every endpoint implements
   * batching honestly. Measured here, `base.drpc.org` returns a correctly-sized
   * array with every `timestamp` field silently missing. Counting results would
   * accept that and write timestamp=0 for every swap — a chart that is
   * confidently wrong. So each element is checked for the fields we need, and a
   * malformed batch is treated as an endpoint failure, which makes the pool
   * rotate to the next endpoint automatically.
   *
   * Throws if no endpoint can serve a valid batch; the caller then falls back
   * to individual requests rather than dropping the block range.
   */
  async getBlocksBatch(
    blockNumbers: readonly bigint[],
  ): Promise<Map<string, { timestamp: number; hash: string; parentHash: string }>> {
    const out = new Map<string, { timestamp: number; hash: string; parentHash: string }>();
    if (blockNumbers.length === 0) return out;

    const payload = blockNumbers.map((n, i) => ({
      jsonrpc: '2.0' as const,
      id: i,
      method: 'eth_getBlockByNumber' as const,
      params: ['0x' + n.toString(16), false] as [string, boolean],
    }));

    const usable = this.endpoints.filter((e) => !this.batchIncapable.has(e));
    if (usable.length === 0) {
      throw new RpcError(
        'UNKNOWN',
        '(all)',
        `no endpoint can serve batches (tried and rejected: ${[...this.batchIncapable].join(', ')})`,
      );
    }

    let lastErr: RpcError | undefined;
    // Two passes over usable endpoints: the first rejection of a given
    // endpoint marks it incapable and we immediately move on, so a batch costs
    // at most one failure per endpoint rather than a full retry cycle each.
    for (let attempt = 1; attempt <= usable.length * 2; attempt++) {
      const endpoint = usable[(this.cursor + attempt - 1) % usable.length]!;
      if (this.batchIncapable.has(endpoint)) continue;
      this.stats.calls++;

      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(90_000),
        });
        const text = (await res.text()).trim();
        if (!text.startsWith('[')) {
          throw new Error(`batch not supported (non-batch reply): ${text.slice(0, 120)}`);
        }
        const arr = JSON.parse(text) as Array<{ error?: unknown; result?: unknown }>;
        if (!Array.isArray(arr) || arr.length !== payload.length) {
          throw new Error(`batch shape mismatch: asked ${payload.length}, got ${Array.isArray(arr) ? arr.length : 'non-array'}`);
        }
        const m = new Map<string, { timestamp: number; hash: string; parentHash: string }>();
        for (const item of arr) {
          if (item.error) throw new Error(`batch item error: ${JSON.stringify(item.error).slice(0, 120)}`);
          const blk = item.result as
            | { number?: string; timestamp?: string; hash?: string; parentHash?: string }
            | null;
          if (!blk || blk.number === undefined || blk.timestamp === undefined || blk.hash === undefined) {
            // This is the base.drpc.org case: right-sized reply, missing fields.
            throw new Error('malformed block in batch: timestamp/hash/number missing');
          }
          m.set(BigInt(blk.number).toString(), {
            timestamp: Number(BigInt(blk.timestamp)),
            hash: blk.hash,
            parentHash: blk.parentHash ?? '',
          });
        }
        for (const [k, v] of m) out.set(k, v);
        this.cursor++;
        return out;
      } catch (raw) {
        const kind = classifyError(raw);
        const err = new RpcError(kind, endpoint, String((raw as Error)?.message ?? raw), raw);
        lastErr = err;
        this.stats.failures++;
        this.stats.failuresByEndpoint[endpoint] = (this.stats.failuresByEndpoint[endpoint] ?? 0) + 1;
        // Remember it and move on; retrying a provider that cannot do batches
        // only wastes time and quota.
        this.batchIncapable.add(endpoint);
        this.onError?.(err, attempt);
      }
    }

    throw (
      lastErr ??
      new RpcError('UNKNOWN', '(all)', 'exhausted every batch-capable endpoint with no recorded error')
    );
  }

  /** Fetch a single header (used for reorg probes). */
  async getBlockSingle(
    blockNumber: bigint,
  ): Promise<{ timestamp: number; hash: string; parentHash: string }> {
    return this.run(async (c) => {
      const blk = await c.getBlock({ blockNumber });
      return {
        timestamp: Number(blk.timestamp),
        hash: blk.hash ?? '',
        parentHash: blk.parentHash ?? '',
      };
    });
  }
}

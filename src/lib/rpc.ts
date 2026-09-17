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

/**
 * Is this batch failure a fact about the ENDPOINT, or about this moment?
 *
 * THE DISTINCTION IS THE WHOLE POINT, AND THE ERROR KIND CANNOT MAKE IT.
 *
 * `classifyError` maps a malformed batch to `NETWORK` on purpose -- from the caller's side, an
 * endpoint that answers an HTML error page and an endpoint that answers a right-sized array with the
 * timestamps stripped look the same, and the reaction to both is "stop trusting this endpoint".
 * But `NETWORK` also covers a genuine transport blip, and a rate limit is its own kind entirely.
 *
 * So for the batch path the decision is made from the MESSAGE, which is where the fact actually is:
 *
 *   non-batch reply / batch shape mismatch / malformed block  -> the endpoint cannot serve batches.
 *                                                                Remember it and stop asking.
 *   over rate limit / 429                                    -> temporary. Cool down and come back.
 *   socket / timeout / aborted                               -> temporary. Try elsewhere, retry later.
 *
 * Getting this wrong in the "remember it" direction is the expensive mistake: a run that writes off
 * the only endpoint that serves batches spends the rest of its life asking endpoints that refuse.
 */
export function isBatchCapabilityFailure(err: unknown): boolean {
  const msg = String((err as { message?: unknown })?.message ?? err ?? '').toLowerCase();
  return /batch not supported|non-batch reply|batch shape mismatch|malformed block in batch|maximum 1 request in batch|batch of more than/.test(
    msg,
  );
}

export interface RpcPoolOptions {
  /** Endpoints to rotate through. Defaults to the configured public list. */
  endpoints?: readonly string[];
  /** Max attempts across all endpoints before giving up. */
  maxAttempts?: number;
  /** Base backoff in ms; multiplied by the attempt number. */
  backoffMs?: number;
  /** How long a rate-limited endpoint is left alone, in ms (default 15000). */
  cooldownMs?: number;
  /** Called for every failure, useful for progress output and metrics. */
  onError?: (err: RpcError, attempt: number) => void;
}

export interface RpcStats {
  calls: number;
  failures: number;
  /** Failures per endpoint — makes rate limiting visible instead of mysterious. */
  failuresByEndpoint: Record<string, number>;
  /** How many times the pool had to wait for a cooling-down endpoint, and for how long. */
  cooldownWaits: number;
  cooldownWaitMs: number;
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

  readonly stats: RpcStats = { calls: 0, failures: 0, failuresByEndpoint: {}, cooldownWaits: 0, cooldownWaitMs: 0 };

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

  /**
   * How long to leave a rate-limited endpoint alone.
   *
   * 15 s is a guess calibrated to the only thing measurable here: the endpoint's documented pattern is
   * a burst allowance that refills within seconds, and the alternative to waiting is either hammering
   * it (which extends the limit) or writing it off (which is the defect this replaces). It is a
   * constant with a reason rather than a magic number, and a run that reports long cooldowns is
   * telling you the value is wrong for that endpoint.
   */
  private readonly cooldownMs: number;
  private readonly cooldownUntil = new Map<string, number>();

  constructor(opts: RpcPoolOptions = {}) {
    this.endpoints = opts.endpoints ?? RPC_URLS;
    this.maxAttempts = opts.maxAttempts ?? this.endpoints.length * 3;
    this.backoffMs = opts.backoffMs ?? 400;
    this.cooldownMs = opts.cooldownMs ?? 15_000;
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

    /**
     * Endpoints that are cooling down after a rate limit.
     *
     * WHY A COOLDOWN AND NOT A WRITE-OFF. There are only three endpoints here, and the one that
     * serves batches is also the one most likely to be rate-limited (it is the only one that serves
     * historical ranges, so every large request goes to it). Dropping it from the rotation for the
     * rest of the run is how a 200,000-block header fetch ended up at 1.7 **swap-bearing** blocks/s --
     * the headers that phase fetches, not the 200,000 the window spans, and that attempt's own figure
     * rather than one this repository can re-measure (its log is not committed): the pool kept asking
     * endpoints that cannot serve a batch at all, and never went back to the one that can.
     *
     * Waiting is not free either, so the wait is bounded and only applied when there is nothing else
     * to try. An endpoint that is merely rate-limited is worth retrying; an endpoint that answered
     * "batches are not supported" is not.
     */
    const now = () => Date.now();
    const cooling = (endpoint: string): boolean => (this.cooldownUntil.get(endpoint) ?? 0) > now();

    let usable = this.endpoints.filter((e) => !this.batchIncapable.has(e) && !cooling(e));

    if (usable.length === 0) {
      // Everything is either incapable or cooling. If anything is cooling, wait for the first one to
      // come back and use it -- the alternative is throwing, and throwing here means the caller
      // re-fetches 200 blocks one at a time.
      const coolingEndpoints = this.endpoints.filter((e) => !this.batchIncapable.has(e) && cooling(e));
      if (coolingEndpoints.length === 0) {
        throw new RpcError(
          'UNKNOWN',
          '(all)',
          `no endpoint can serve batches (tried and rejected: ${[...this.batchIncapable].join(', ')})`,
        );
      }
      const soonest = Math.min(...coolingEndpoints.map((e) => this.cooldownUntil.get(e) ?? 0));
      const waitMs = Math.max(0, soonest - now());
      this.stats.cooldownWaits++;
      this.stats.cooldownWaitMs += waitMs;
      await sleep(waitMs);
      usable = coolingEndpoints.filter((e) => !cooling(e));
      if (usable.length === 0) usable = coolingEndpoints;
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
          /**
           * 30 s, not 90 s.
           *
           * A rate-limited public endpoint often accepts the connection and then simply does not
           * answer, so the timeout IS the cost of finding out. At 90 s, one hung endpoint per batch
           * put an arithmetic ceiling of about 2 blocks/s on the whole header phase: 200 headers in a
           * batch against a 90 s wait, and 200 / 90 = 2.2. That is a division, not a second
           * measurement -- the rate that attempt measured is the 1.7 swap-bearing blocks/s the README
           * and `db.ts` carry for it. 30 s is still far above the ~1 s a served batch takes.
           */
          signal: AbortSignal.timeout(30_000),
        });
        const text = (await res.text()).trim();

        /**
         * STATUS FIRST, THEN SHAPE.
         *
         * A rate-limited endpoint answers `429` -- sometimes with a JSON-RPC error body, sometimes
         * with HTML. Reading the body first and calling it "a non-batch reply" turns a rate limit
         * into a statement about the endpoint's capabilities, and the endpoint then gets written off
         * for the rest of the run. Found by a test: the stub that returns `429` with
         * `{"error":{"message":"over rate limit"}}` was classified as incapable.
         *
         * The distinction matters in both directions. `429` is transient (`classifyError` maps it to
         * RATE_LIMIT, so the endpoint cools down and comes back), a `5xx` is a blip (NETWORK, retried
         * elsewhere), and only a `200` whose body is not a batch is a statement about what this
         * endpoint can do.
         */
        if (!res.ok) {
          throw new Error(`batch request rejected with HTTP ${res.status}: ${text.slice(0, 120)}`);
        }

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
        /**
         * ONLY A CAPABILITY FAILURE IS REMEMBERED.
         *
         * This used to memoise every failure, which was wrong in the expensive direction: a
         * RATE_LIMIT or a NETWORK blip says nothing about whether the endpoint can serve batches, but
         * marking it incapable removed it from the rotation for the rest of the run. Measured
         * consequence on a 200,000-block backfill: one transient rate limit on the endpoint that
         * *does* serve batches left the header fetch relying on endpoints that refuse them, and the
         * phase ran at 1.7 swap-bearing blocks/s instead of the 20 then 40 blocks/s it measured once
         * the pool rotated (README, "Scale").
         *
         * A rate-limited endpoint should be tried again later, not written off. Retrying it costs one
         * request; writing it off costs the whole run.
         */
        /**
         * A CAPABILITY FAILURE IS REMEMBERED; A TRANSIENT ONE IS NOT.
         *
         * See `isBatchCapabilityFailure` above for why the decision is made from the message rather
         * than from `kind`: a malformed batch is classified NETWORK, and a transport blip is
         * classified NETWORK too, and they need opposite handling.
         */
        if (isBatchCapabilityFailure(raw)) {
          this.batchIncapable.add(endpoint);
        } else if (kind === 'RATE_LIMIT') {
          // Come back to it, but not immediately: hammering a rate-limited endpoint is how a pool
          // gets banned, and the cooldown is the only thing that turns "rate limited" into "slower
          // for a while" rather than "unusable for the rest of the run".
          this.cooldownUntil.set(endpoint, Date.now() + this.cooldownMs);
        }
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

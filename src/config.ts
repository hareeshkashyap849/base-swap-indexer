/**
 * Pool constants for Uniswap V3 WETH/USDC 0.05% on Base mainnet.
 *
 * Every value here was read from chain, not copied from docs or memory.
 * See REQUIREMENTS.md §0 for the verification record.
 *
 * CRITICAL — token order:
 *   token0 = WETH (18 decimals)
 *   token1 = USDC (6 decimals)
 * Reading this backwards inverts every price in the project.
 * The indexer therefore also reads token0/token1 from chain at startup and
 * refuses to run if they disagree with this file (fail loud, not silently wrong).
 */

export const CHAIN_ID = 8453; // Base mainnet

export const POOL_ADDRESS = '0xd0b53D9277642d899DF5C87A3966A349A798F224' as const;

/** Expected token order — asserted against chain at startup. */
export const EXPECTED_TOKEN0 = '0x4200000000000000000000000000000000000006' as const; // WETH
export const EXPECTED_TOKEN1 = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const; // USDC
export const EXPECTED_DECIMALS0 = 18;
export const EXPECTED_DECIMALS1 = 6;

/** Pool fee in hundredths of a bip. 500 = 0.05%. */
export const FEE = 500;

/** Human-readable labels. token0/token1 are addresses; these are for display only. */
export const SYMBOL0 = 'WETH';
export const SYMBOL1 = 'USDC';

/**
 * The Uniswap V3 Swap event.
 * amount0/amount1 are int256 and SIGNED: positive means the pool RECEIVED
 * that token, negative means the pool PAID it out.
 */
export const SWAP_EVENT = {
  type: 'event',
  name: 'Swap',
  inputs: [
    { name: 'sender', type: 'address', indexed: true },
    { name: 'recipient', type: 'address', indexed: true },
    { name: 'amount0', type: 'int256', indexed: false },
    { name: 'amount1', type: 'int256', indexed: false },
    { name: 'sqrtPriceX96', type: 'uint160', indexed: false },
    { name: 'liquidity', type: 'uint128', indexed: false },
    { name: 'tick', type: 'int24', indexed: false },
  ],
} as const;

/** Minimal pool ABI: only what we read for identity checks and live price. */
export const POOL_ABI = [
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'token1', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'fee', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint24' }] },
  {
    type: 'function',
    name: 'slot0',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' },
      { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' },
      { name: 'feeProtocol', type: 'uint8' },
      { name: 'unlocked', type: 'bool' },
    ],
  },
  { type: 'function', name: 'liquidity', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint128' }] },
] as const;

export const ERC20_ABI = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

/**
 * Public Base RPC endpoints, in priority order.
 *
 * Chosen by measurement, not by reputation. All public endpoints were probed
 * for (a) head + 5 sequential getBlock calls and (b) JSON-RPC batch support:
 *
 *   base-rpc.publicnode.com   5/5 ok, 2.9s      batch 300/300 with timestamps
 *   base.drpc.org             5/5 ok, 2.3s      batch replies but DROPS timestamp  <-- see note
 *   mainnet.base.org          5/5 ok, 2.0s      batch limited to 1 (error -32014)
 *   base.meowrpc.com          4/5, 17.7s        HTTP 429 rate limited
 *   1rpc.io/base              4/5, 11.8s        empty errors
 *   base.llamarpc.com         HTTP 525 (TLS)
 *   base.blockpi.network      HTTP 521
 *
 * NOTE on base.drpc.org: it accepts a batch request and returns the right
 * NUMBER of results, but every `timestamp` field comes back missing. It fails
 * quietly rather than loudly, which is the worst failure mode available here —
 * trusting it would have written timestamp=0 for every swap and produced a
 * chart that is confidently wrong. It is listed last for that reason and the
 * batch path validates results instead of counting them.
 *
 * DEEPER MEASUREMENT (2026-09-15, blocks 51363073..51363372 — near the head):
 *
 *   endpoint            getLogs(300 blocks)  ts batch(64 blocks)  ts single
 *   publicnode                 205 ms              437 ms          177 ms/call
 *   mainnet.base.org           406 ms         NOT supported (array) 317 ms/call
 *   drpc.org                   157 ms   ERR "ranges over 10000 blocks not supported"
 *
 * Two conclusions that the earlier ranking missed:
 *
 *   1. publicnode is ~1.7x faster at batched block fetches AND is the only
 *      endpoint that serves batches at all, so it must stay first for the
 *      timestamp path. This is the path that dominates a large backfill.
 *   2. Every endpoint is fast for getLogs NEAR THE HEAD (200-500 ms for 300
 *      blocks). The earlier "it is slow" reading came from indexing blocks
 *      ~4,000 behind the head, and the real cause was publicnode refusing
 *      those with `-32602 Archive requests require a personal token` — not
 *      raw latency. See the archive note below.
 *
 * ARCHIVE RANGES ARE A SEPARATE REQUIREMENT. Measured on a range ~11,000
 * blocks behind the head: publicnode answers `-32602 Archive requests require a
 * personal token`, drpc.org refuses ranges over 10,000 blocks, and only
 * mainnet.base.org served the historical range. Any component that indexes
 * blocks well behind the head therefore depends on mainnet.base.org being
 * reachable; the near-head path does not. This is why the indexer is designed
 * to resume from a checkpoint instead of re-scanning history.
 *
 * Free endpoints rate-limit aggressively (measured: 6 concurrent eth_call
 * calls trip the limiter), so more than one is mandatory.
 *
 * OVERRIDABLE, BECAUSE THE RIGHT LIST DEPENDS ON THE RUN
 *
 * `BASE_RPC_URLS` (comma-separated) replaces this list for one run. That exists because of the
 * measurement above: a historical backfill can ONLY use mainnet.base.org, so leaving the other two
 * in the rotation costs a failed call and a backoff sleep per chunk before every chunk that
 * succeeds. Measured 2026-09-16 with `tools/probe-rpc-range.mjs`, 2,000-block windows:
 *
 *   mainnet.base.org          logged 840-1,578 swaps per window at head-1k, -50k, -100k and -250k
 *   base-rpc.publicnode.com   "Archive requests require a personal token" past ~50k blocks
 *   base.drpc.org             "ranges over 10000 blocks are not supported on free plan" (it refused
 *                             a 2,000-block range with that message too)
 *
 * So a 200k backfill against the default list spends most of its first attempts on endpoints that
 * cannot answer. `BASE_RPC_URLS=https://mainnet.base.org node --experimental-strip-types
 * src/indexer/cli.ts --blocks 200000` is the run that works, and the probe is how you re-check
 * whether it still does.
 *
 * WHICH ENDPOINTS CAN BATCH, WHICH IS WHAT THE HEADER PHASE NEEDS
 *
 * The log scan is 100 requests for a 200,000-block window; the header fetch is one per distinct
 * block containing a swap (~86,000 of them), so **the header phase is the expensive one and only a
 * batching endpoint makes it affordable**. `tools/probe-endpoints.mjs` measured every candidate host
 * on 2026-09-16, asking for 200 headers in one request:
 *
 *   base-rpc.publicnode.com              OK 200   (10.5 s)
 *   base.publicnode.com                  OK 200   (10.0 s)   <- same operator, different host
 *   base-mainnet.public.blastapi.io       OK 200    (6.3 s)
 *   mainnet.base.org                     "maximum 10 calls in 1 batch"  -- batches, but only 10
 *   base.drpc.org                        HTTP 500, right-sized reply with fields missing
 *   gateway.tenderly.co/public/base      HTTP 429
 *   1rpc.io/base, base.meowrpc.com       usage limit / bad request
 *   base.llamarpc.com, base.blockpi.network   HTML, not JSON-RPC
 *   base.api.onfinality.io/public        needs an API key
 *
 * That measurement is why the list below is four long rather than three: **the ceiling on a large
 * backfill is the number of batch-capable endpoints, not the batch size.** One host delivered ~20
 * headers/s and the phase crawled once that host throttled; three usable hosts are roughly three
 * times the ceiling.
 *
 * `mainnet.base.org`'s limit of 10 is recorded rather than exploited: it is the only endpoint that
 * serves historical log ranges, and it already carries that load. An adaptive batch size that parsed
 * "maximum N calls" and retried smaller would let it help with headers too, and it is not implemented
 * because the two new hosts cover the need at 200 per request -- machinery beyond the measured need
 * is its own kind of defect.
 */
const DEFAULT_RPC_URLS: readonly string[] = [
  'https://base-rpc.publicnode.com',
  'https://mainnet.base.org',
  'https://base.drpc.org',
  'https://base.publicnode.com',
  'https://base-mainnet.public.blastapi.io',
];

/**
 * The endpoint list for this run.
 *
 * Parsed rather than trusted: a trailing comma, a stray space or an empty value would otherwise
 * become an endpoint that fails on every call, and the failure would look like a network problem.
 * An override that parses to nothing falls back to the defaults instead of producing an empty pool,
 * which `RpcPool` would reject outright.
 */
export function rpcUrlsFrom(env: string | undefined, fallback: readonly string[] = DEFAULT_RPC_URLS): readonly string[] {
  if (env === undefined) return fallback;
  const parsed = env
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (parsed.length === 0) return fallback;
  for (const url of parsed) {
    if (!/^https?:\/\//.test(url)) {
      throw new Error(
        `BASE_RPC_URLS entry ${JSON.stringify(url)} is not an http(s) URL. ` +
          'An endpoint without a scheme fails on every call and reads as a network outage.',
      );
    }
  }
  return parsed;
}

export const RPC_URLS: readonly string[] = rpcUrlsFrom(process.env.BASE_RPC_URLS);

/** Approximate Base block time in seconds — used only for time estimates. */
export const SECONDS_PER_BLOCK = 2;

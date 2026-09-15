/**
 * Pool constants for Uniswap V3 WETH/USDC 0.05% on Base mainnet.
 *
 * Every value here was read from chain, not copied from docs or memory.
 * See docs/architecture (S2) section 0 for the verification record.
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
 * Free endpoints rate-limit aggressively (measured: 6 concurrent eth_call
 * calls trip the limiter), so more than one is mandatory.
 */
export const RPC_URLS: readonly string[] = [
  'https://base-rpc.publicnode.com',
  'https://mainnet.base.org',
  'https://base.drpc.org',
];

/** Approximate Base block time in seconds — used only for time estimates. */
export const SECONDS_PER_BLOCK = 2;

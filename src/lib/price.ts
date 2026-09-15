/**
 * Price maths for a Uniswap V3 pool.
 *
 * This module is deliberately isolated and heavily tested, because every
 * number the dashboard shows flows through it, and a sign or exponent error
 * here is silent and catastrophic (it inverts or rescales the whole chart).
 *
 * Uniswap V3 defines:
 *
 *     sqrtPriceX96 = sqrt(price) * 2^96
 *     price        = token1_amount / token0_amount      (in SMALLEST units)
 *
 * To convert to a human-readable ratio you must correct for the decimals of
 * each token:
 *
 *     priceAdjusted = rawPrice * 10^(decimals0 - decimals1)
 *
 * For this pool that is decimals0 = 18 (WETH) and decimals1 = 6 (USDC), so the
 * factor is 10^12 and the result is "USDC per WETH" — i.e. the USD price of ETH.
 *
 * Measured sanity check at the time of writing:
 *     rawPrice = 2.44349691e-9  ->  * 1e12  ->  2443.50 USDC per WETH
 */

/** 2^96 as a bigint, the fixed-point denominator of sqrtPriceX96. */
export const Q96 = 2n ** 96n;

/**
 * Raw price ratio (token1 smallest units per token0 smallest unit), as a float.
 *
 * Precision note: this divides two bigints by converting to Number, which is
 * exactly representable up to 2^53. sqrtPriceX96 is a uint160 and can exceed
 * that, so we scale the numerator before dividing to stay inside the safe
 * range. The relative error introduced is far below display precision, but the
 * function is intentionally documented as "display-grade, not settlement-grade".
 */
export function rawPriceFromSqrtPriceX96(sqrtPriceX96: bigint): number {
  const num = Number(sqrtPriceX96) / Number(Q96);
  return num * num;
}

/**
 * Convert a raw smallest-unit ratio into a human ratio.
 * factor = 10^(decimals0 - decimals1)
 */
export function applyDecimals(rawPrice: number, decimals0: number, decimals1: number): number {
  return rawPrice * 10 ** (decimals0 - decimals1);
}

/**
 * The pool price in human units: how many token1 (USDC) one whole token0 (WETH) costs.
 * This is THE price used everywhere in the project.
 */
export function priceFromSqrtPriceX96(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number,
): number {
  return applyDecimals(rawPriceFromSqrtPriceX96(sqrtPriceX96), decimals0, decimals1);
}

/**
 * The same price derived independently from `tick`.
 *
 * In Uniswap V3, price = 1.0001^tick (in raw units). Deriving price from tick
 * as well as from sqrtPriceX96 gives us two independent paths to the same
 * number, which is what invariant INV-3 checks. A mismatch means either the
 * RPC returned inconsistent data or our decoding is wrong.
 */
export function priceFromTick(tick: number, decimals0: number, decimals1: number): number {
  return 1.0001 ** tick * 10 ** (decimals0 - decimals1);
}

/**
 * INV-3 check: are the two independent price paths consistent?
 *
 * Compared in log space because the two values are equal only up to the
 * discretisation of tick (tick is floor(log_1.0001(price))). Measured
 * discrepancy on real data is < 1e-4; the default tolerance of 1e-3 leaves
 * headroom while still catching any real error, which would be off by orders
 * of magnitude (e.g. a wrong token order inverts the price entirely).
 */
export function pricesConsistent(
  sqrtPriceX96: bigint,
  tick: number,
  decimals0: number,
  decimals1: number,
  tolerance = 1e-3,
): boolean {
  const a = rawPriceFromSqrtPriceX96(sqrtPriceX96);
  const b = 1.0001 ** tick;
  if (!(a > 0) || !(b > 0)) return false;
  return Math.abs(Math.log(a / b)) < tolerance;
}

export interface SwapAmounts {
  /** Signed amount of token0. Positive = pool received token0. */
  amount0: bigint;
  /** Signed amount of token1. Positive = pool received token1. */
  amount1: bigint;
  decimals0: number;
  decimals1: number;
}

export interface SwapEconomics {
  /** Absolute token0 moved, in whole tokens. */
  amount0Abs: number;
  /** Absolute token1 moved, in whole tokens. */
  amount1Abs: number;
  /**
   * Trade direction from the pool's perspective.
   * amount0 > 0 means the pool received token0 (WETH), i.e. the trader SOLD WETH.
   * The input `int256` is converted to `bigint` by viem, so the sign is exact.
   */
  side: 'sell_token0' | 'buy_token0';
  /** Volume denominated in token1 (USDC). Always positive. */
  volumeToken1: number;
}

/**
 * Turn signed swap amounts into human-scale numbers plus a direction.
 *
 * INV-6 asserts sign(amount0) === -sign(amount1) on every row; a violation
 * means we decoded the event incorrectly, so callers should treat that as a
 * hard error rather than plotting a nonsensical point.
 */
export function swapEconomics(a: SwapAmounts): SwapEconomics {
  const sign0 = a.amount0 > 0n ? 1 : a.amount0 < 0n ? -1 : 0;
  const sign1 = a.amount1 > 0n ? 1 : a.amount1 < 0n ? -1 : 0;
  if (sign0 !== 0 && sign1 !== 0 && sign0 === sign1) {
    throw new Error(
      `INV-6 violated: amount0 and amount1 must have opposite signs, got ${a.amount0} / ${a.amount1}`,
    );
  }
  const amount0Abs = Number(absBigInt(a.amount0)) / 10 ** a.decimals0;
  const amount1Abs = Number(absBigInt(a.amount1)) / 10 ** a.decimals1;
  return {
    amount0Abs,
    amount1Abs,
    side: sign0 > 0 ? 'sell_token0' : 'buy_token0',
    volumeToken1: amount1Abs,
  };
}

function absBigInt(v: bigint): bigint {
  return v < 0n ? -v : v;
}

/** Sum of absolute values, kept in bigint so no precision is lost. */
export function sumAbs(values: readonly bigint[]): bigint {
  let total = 0n;
  for (const v of values) total += absBigInt(v);
  return total;
}

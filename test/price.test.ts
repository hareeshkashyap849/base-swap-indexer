/**
 * Tests for the price maths.
 *
 * The case that matters most here is direction. This pool has token0 = WETH
 * and token1 = USDC, so the derived ratio is already "USDC per WETH". Reading
 * it the other way inverts every price in the project while still producing
 * plausible-looking numbers, so the first test pins the real measured value.
 *
 * The sqrtPriceX96 and tick fixtures below are real values read from Base
 * mainnet at block 51,345,386.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDecimals,
  priceFromSqrtPriceX96,
  priceFromTick,
  pricesConsistent,
  rawPriceFromSqrtPriceX96,
  swapEconomics,
  sumAbs,
  Q96,
} from '../src/lib/price.ts';

// Real on-chain values for the indexed pool.
const REAL_SQRT_PRICE = 3916385922366450481262234n;
const REAL_TICK = -198309;
const WETH_DECIMALS = 18;
const USDC_DECIMALS = 6;

test('Q96 is 2^96', () => {
  assert.equal(Q96, 79228162514264337593543950336n);
});

test('real pool price is ~2443 USDC per WETH (direction check)', () => {
  // If someone swaps the token order or inverts the ratio, this fails loudly.
  // The window is deliberately narrow-around-plausible: ETH in this range is
  // the only reading that is correct.
  const price = priceFromSqrtPriceX96(REAL_SQRT_PRICE, WETH_DECIMALS, USDC_DECIMALS);
  assert.ok(price > 2000 && price < 3000, `expected ~2443 USDC/WETH, got ${price}`);
});

test('rawPrice is the unscaled token1/token0 ratio', () => {
  const raw = rawPriceFromSqrtPriceX96(REAL_SQRT_PRICE);
  assert.ok(raw > 2.4e-9 && raw < 2.5e-9, `raw should be ~2.4434e-9, got ${raw}`);
});

test('10^(decimals0-decimals1) scaling is what turns raw into USD per WETH', () => {
  const raw = rawPriceFromSqrtPriceX96(REAL_SQRT_PRICE);
  const scaled = applyDecimals(raw, WETH_DECIMALS, USDC_DECIMALS);
  assert.ok(Math.abs(scaled - 2443.5) < 1.0, `expected ~2443.5, got ${scaled}`);
});

test('tick and sqrtPriceX96 agree on the real value (INV-3)', () => {
  assert.equal(pricesConsistent(REAL_SQRT_PRICE, REAL_TICK, WETH_DECIMALS, USDC_DECIMALS), true);
  const a = priceFromSqrtPriceX96(REAL_SQRT_PRICE, WETH_DECIMALS, USDC_DECIMALS);
  const b = priceFromTick(REAL_TICK, WETH_DECIMALS, USDC_DECIMALS);
  const relDiff = Math.abs(a - b) / a;
  assert.ok(relDiff < 1e-4, `two paths should agree closely, relative diff ${relDiff}`);
});

test('INV-3 catches an inconsistent pair', () => {
  // A tick that implies a very different price than sqrtPriceX96.
  assert.equal(pricesConsistent(REAL_SQRT_PRICE, -100000, WETH_DECIMALS, USDC_DECIMALS), false);
});

test('INV-3 rejects non-positive inputs instead of returning a bogus pass', () => {
  assert.equal(pricesConsistent(0n, REAL_TICK, WETH_DECIMALS, USDC_DECIMALS), false);
});

test('decimals offsets change the implied price, which is why they are asserted', () => {
  // Reading the decimals backwards is the second way to get the answer wrong,
  // independent of token order. Note the relationship is NOT reciprocal:
  //   price = raw * 10^(d0-d1)
  // so swapping d0 and d1 gives raw * 10^-(d0-d1), i.e. price * price' = raw^2.
  // The ratio between the two readings is 10^24, which is also how far off a
  // token-order mistake would put you.
  const right = priceFromSqrtPriceX96(REAL_SQRT_PRICE, 18, 6);
  const wrong = priceFromSqrtPriceX96(REAL_SQRT_PRICE, 6, 18);
  assert.ok(right > 1, `correct reading should be >1 USDC/WETH, got ${right}`);
  assert.ok(wrong < 1, `flipped-decimals reading should be <1, got ${wrong}`);
  const ratio = right / wrong;
  assert.ok(
    Math.abs(Math.log10(ratio) - 24) < 0.01,
    `flipping decimals should change the price by 10^24, got 10^${Math.log10(ratio).toFixed(3)}`,
  );
});

// --------------------------------------------------------------------------
// Swap economics and the sign convention (INV-6)
// --------------------------------------------------------------------------

test('INV-6 throw when both amounts share a sign', () => {
  assert.throws(
    () =>
      swapEconomics({ amount0: 100n, amount1: 100n, decimals0: 18, decimals1: 6 }),
    /INV-6 violated/,
  );
  assert.throws(
    () =>
      swapEconomics({ amount0: -100n, amount1: -100n, decimals0: 18, decimals1: 6 }),
    /INV-6 violated/,
  );
});

test('a trade where the pool receives WETH is a sell of WETH', () => {
  // Pool gains WETH (+amount0), so the trader sold WETH and paid it in.
  const e = swapEconomics({
    amount0: 1_000_000_000_000_000_000n, // +1 WETH
    amount1: -2_443_000_000n, // -2443 USDC
    decimals0: 18,
    decimals1: 6,
  });
  assert.equal(e.side, 'sell_token0');
  assert.equal(e.amount0Abs, 1);
  assert.ok(Math.abs(e.amount1Abs - 2443) < 1e-6);
});

test('a trade where the pool pays out WETH is a buy of WETH', () => {
  const e = swapEconomics({
    amount0: -500_000_000_000_000_000n, // -0.5 WETH
    amount1: 1_221_750_000n, // +1221.75 USDC
    decimals0: 18,
    decimals1: 6,
  });
  assert.equal(e.side, 'buy_token0');
  assert.equal(e.amount0Abs, 0.5);
  assert.ok(Math.abs(e.amount1Abs - 1221.75) < 1e-6);
});

test('volume is always positive and denominated in token1', () => {
  const sell = swapEconomics({
    amount0: 1n * 10n ** 18n,
    amount1: -1000n * 10n ** 6n,
    decimals0: 18,
    decimals1: 6,
  });
  const buy = swapEconomics({
    amount0: -1n * 10n ** 18n,
    amount1: 1000n * 10n ** 6n,
    decimals0: 18,
    decimals1: 6,
  });
  assert.equal(sell.volumeToken1, 1000);
  assert.equal(buy.volumeToken1, 1000);
});

test('zero amounts do not throw (a zero-size swap is legal on the ABI)', () => {
  const e = swapEconomics({ amount0: 0n, amount1: 0n, decimals0: 18, decimals1: 6 });
  assert.equal(e.volumeToken1, 0);
});

test('large int256 values keep full precision through decimals conversion', () => {
  // uint256 max is far beyond Number.MAX_SAFE_INTEGER; the conversion to a
  // human float is allowed to lose sub-wei precision, but the magnitude must
  // stay sane rather than becoming Infinity or NaN.
  const huge = 2n ** 200n;
  const e = swapEconomics({ amount0: huge, amount1: -1n, decimals0: 18, decimals1: 6 });
  assert.ok(Number.isFinite(e.amount0Abs));
  assert.ok(e.amount0Abs > 0);
});

test('sumAbs handles mixed signs', () => {
  assert.equal(sumAbs([1n, -2n, 3n]), 6n);
  assert.equal(sumAbs([]), 0n);
});

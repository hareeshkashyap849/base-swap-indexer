// Independent check of the stored data against the chain and against the
// price formula. Run after indexing: if this disagrees with the DB, the
// dashboard would be lying and we want to know before looking at it.
//
// Exits non-zero if any invariant fails, so it can gate a pipeline. Printing
// FAIL and exiting 0 would make it useless as a check.
import { DatabaseSync } from 'node:sqlite';
import {
  priceFromSqrtPriceX96,
  priceFromTick,
  pricesConsistent,
  swapEconomics,
} from './src/lib/price.ts';

const DEC0 = 18; // WETH
const DEC1 = 6; // USDC

let failures = 0;
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  ${label}: ${ok ? 'PASS' : 'FAIL'}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
};

const db = new DatabaseSync('data/swaps.sqlite', { readOnly: true });
const n = db.prepare('SELECT COUNT(*) AS n FROM swaps').get().n;
console.log(`rows in db: ${n}`);
if (n === 0) {
  console.log('nothing indexed yet — run `npm run index` first');
  db.close();
  process.exit(1);
}

// INV-3: price derived two independent ways must agree.
const sample = db.prepare('SELECT * FROM swaps ORDER BY RANDOM() LIMIT 300').all() as Array<{
  sqrt_price_x96: string;
  tick: number;
  block_number: number;
}>;
let bad = 0;
let minP = Infinity;
let maxP = -Infinity;
for (const r of sample) {
  const sqrt = BigInt(r.sqrt_price_x96);
  const p1 = priceFromSqrtPriceX96(sqrt, DEC0, DEC1);
  if (!pricesConsistent(sqrt, Number(r.tick), DEC0, DEC1)) {
    if (bad < 3) {
      console.log(`      mismatch at block ${r.block_number}: sqrt->${p1} tick->${priceFromTick(Number(r.tick), DEC0, DEC1)}`);
    }
    bad += 1;
  }
  minP = Math.min(minP, p1);
  maxP = Math.max(maxP, p1);
}
check(`INV-3 price cross-check on ${sample.length} rows`, bad === 0, bad ? `${bad} mismatches` : '');
console.log(`      price range seen: ${minP.toFixed(2)} .. ${maxP.toFixed(2)} USDC per WETH`);
// A magnitude check catches an inverted token order, which otherwise produces
// perfectly self-consistent but completely wrong numbers.
check('price magnitude is plausible for this pair', minP > 100 && maxP < 100000, `${minP.toFixed(0)}..${maxP.toFixed(0)}`);

// INV-6: signs must oppose.
const signBad = db
  .prepare(
    `SELECT COUNT(*) AS n FROM swaps
     WHERE (CAST(amount0 AS REAL) > 0 AND CAST(amount1 AS REAL) > 0)
        OR (CAST(amount0 AS REAL) < 0 AND CAST(amount1 AS REAL) < 0)`,
  )
  .get().n;
check('INV-6 sign consistency', signBad === 0, signBad ? `${signBad} rows` : '');

// Timestamps must be plausible epoch seconds within a recent window.
const tsBad = db
  .prepare('SELECT COUNT(*) AS n FROM swaps WHERE timestamp < 1600000000 OR timestamp > 2000000000')
  .get().n;
check('timestamp sanity', tsBad === 0, tsBad ? `${tsBad} implausible` : '');

const bounds = db.prepare('SELECT MIN(timestamp) AS a, MAX(timestamp) AS b FROM swaps').get() as {
  a: number;
  b: number;
};
console.log(
  `      time span: ${new Date(bounds.a * 1000).toISOString()} .. ${new Date(bounds.b * 1000).toISOString()}`,
);

// A healthy pool trades in both directions; a one-sided result usually means
// the sign convention was misread.
const sides = db
  .prepare(
    `SELECT CASE WHEN CAST(amount0 AS REAL) > 0 THEN 'sell WETH' ELSE 'buy WETH' END AS side,
            COUNT(*) AS n
     FROM swaps GROUP BY side`,
  )
  .all() as Array<{ side: string; n: number }>;
check('both trade directions present', sides.length === 2, sides.map((s) => `${s.side}=${s.n}`).join(', '));

// INV-5: the SQL aggregate and an independent JS recomputation must agree.
const rows = db.prepare('SELECT amount0, amount1 FROM swaps').all() as Array<{
  amount0: string;
  amount1: string;
}>;
let vol = 0;
for (const r of rows) {
  vol += swapEconomics({
    amount0: BigInt(r.amount0),
    amount1: BigInt(r.amount1),
    decimals0: DEC0,
    decimals1: DEC1,
  }).volumeToken1;
}
const sqlVol = (
  db.prepare('SELECT SUM(ABS(CAST(amount1 AS REAL))) / 1000000.0 AS v FROM swaps').get() as { v: number }
).v;
check('INV-5 SQL vs JS volume agreement', Math.abs(vol - sqlVol) < 0.01, `JS ${vol.toFixed(2)} vs SQL ${sqlVol.toFixed(2)}`);

// Coverage: the indexer writes a checkpoint, so we can state the window.
const state = db.prepare('SELECT last_indexed_block FROM indexer_state WHERE id = 1').get() as
  | { last_indexed_block: number }
  | undefined;
if (state) console.log(`      indexed up to block ${state.last_indexed_block}`);

db.close();

console.log('');
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('all data checks passed');

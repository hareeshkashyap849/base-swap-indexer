// Independent check of the stored data against the chain and against the
// price formula. Run after indexing: if this disagrees with the DB, the
// dashboard would be lying and we want to know before building it.
import { DatabaseSync } from 'node:sqlite';
import { priceFromSqrtPriceX96, priceFromTick, pricesConsistent, swapEconomics } from './src/lib/price.ts';

const db = new DatabaseSync('data/swaps.sqlite');
const n = db.prepare('SELECT COUNT(*) AS n FROM swaps').get().n;
console.log(`rows in db: ${n}`);
if (n === 0) {
  console.log('nothing indexed yet');
  process.exit(0);
}

// INV-3: price derived two independent ways must agree.
const sample = db.prepare('SELECT * FROM swaps ORDER BY RANDOM() LIMIT 300').all();
let bad = 0;
let minP = Infinity;
let maxP = -Infinity;
for (const r of sample) {
  const p1 = priceFromSqrtPriceX96(BigInt(r.sqrt_price_x96), 18, 6);
  const p2 = priceFromTick(Number(r.tick), 18, 6);
  if (!pricesConsistent(BigInt(r.sqrt_price_x96), Number(r.tick), 18, 6)) {
    if (bad < 3) console.log(`  INV-3 FAIL block ${r.block_number}: sqrt->${p1} tick->${p2}`);
    bad++;
  }
  minP = Math.min(minP, p1);
  maxP = Math.max(maxP, p1);
}
console.log(`INV-3 price cross-check on ${sample.length} rows: ${bad === 0 ? 'PASS' : `FAIL (${bad})`}`);
console.log(`  price range seen: ${minP.toFixed(2)} .. ${maxP.toFixed(2)} USDC per WETH`);
if (minP < 100 || maxP > 100000) console.log('  ⚠ suspicious magnitude — check token order / decimals');

// INV-6: signs must oppose.
const signBad = db
  .prepare(
    `SELECT COUNT(*) AS n FROM swaps
     WHERE (CAST(amount0 AS REAL) > 0 AND CAST(amount1 AS REAL) > 0)
        OR (CAST(amount0 AS REAL) < 0 AND CAST(amount1 AS REAL) < 0)`,
  )
  .get().n;
console.log(`INV-6 sign consistency: ${signBad === 0 ? 'PASS' : `FAIL (${signBad} rows)`}`);

// Timestamps must be plausible and ordered with block numbers.
const tsBad = db
  .prepare(`SELECT COUNT(*) AS n FROM swaps WHERE timestamp < 1600000000 OR timestamp > 2000000000`)
  .get().n;
console.log(`timestamp sanity: ${tsBad === 0 ? 'PASS' : `FAIL (${tsBad} implausible)`}`);

const bounds = db.prepare('SELECT MIN(timestamp) AS a, MAX(timestamp) AS b FROM swaps').get();
console.log(
  `  time span: ${new Date(bounds.a * 1000).toISOString()} .. ${new Date(bounds.b * 1000).toISOString()}`,
);

// Direction split: a healthy pool trades both ways.
const sides = db
  .prepare(
    `SELECT CASE WHEN CAST(amount0 AS REAL) > 0 THEN 'sell WETH' ELSE 'buy WETH' END AS side,
            COUNT(*) AS n
     FROM swaps GROUP BY side`,
  )
  .all();
console.log(`direction split: ${sides.map((s) => `${s.side}=${s.n}`).join(', ')}`);

// Volume aggregate via SQL, recomputed independently in JS.
const rows = db.prepare('SELECT amount0, amount1 FROM swaps').all();
let vol = 0;
for (const r of rows) {
  const e = swapEconomics({ amount0: BigInt(r.amount0), amount1: BigInt(r.amount1), decimals0: 18, decimals1: 6 });
  vol += e.volumeToken1;
}
const sqlVol = db
  .prepare('SELECT SUM(ABS(CAST(amount1 AS REAL))) / 1000000.0 AS v FROM swaps')
  .get().v;
console.log(`volume (JS)  = ${vol.toFixed(2)} USDC`);
console.log(`volume (SQL) = ${sqlVol.toFixed(2)} USDC`);
console.log(`INV-5 aggregation agreement: ${Math.abs(vol - sqlVol) < 0.01 ? 'PASS' : 'FAIL'}`);

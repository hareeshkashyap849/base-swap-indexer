// Data audit for an indexed database.
//
// WHAT THIS ACTUALLY CHECKS, AND WHAT IT USED TO CLAIM
//
// The first version of this file said it checked "the stored data against the chain". It did not:
// every check was internal consistency (two price derivations agreeing, signs opposing, timestamps
// plausible, SQL and JS volume agreeing). Those are worth having -- they catch an inverted token
// order and a misread sign convention among other things -- but a database that is consistently
// wrong about the same fact passes all of them. The claim was bigger than the code, so now the
// chain check exists and is opt-in:
//
//   default            internal consistency only; no network, so it is deterministic
//   --against-chain N  additionally re-read N sampled blocks from a public RPC and compare every
//                      stored field against what the chain returns for the same log
//
// Run after indexing: if this disagrees with the DB, the dashboard would be lying and we want to
// know before looking at it.
//
// Exits non-zero if any invariant fails, so it can gate a pipeline. Printing FAIL and exiting 0
// would make it useless as a check.
import { DatabaseSync } from 'node:sqlite';
import { decodeEventLog } from 'viem';
import {
  priceFromSqrtPriceX96,
  priceFromTick,
  pricesConsistent,
  swapEconomics,
} from './src/lib/price.ts';
import { POOL_ADDRESS, SWAP_EVENT } from './src/config.ts';
import { RpcPool } from './src/lib/rpc.ts';

const DEC0 = 18; // WETH
const DEC1 = 6; // USDC

const argv = process.argv.slice(2);
const flagValue = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const DB_PATH = flagValue('db') ?? 'data/swaps.sqlite';
const AGAINST_CHAIN = Number(flagValue('against-chain') ?? '0');

let failures = 0;
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  ${label}: ${ok ? 'PASS' : 'FAIL'}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
};

console.log(`database: ${DB_PATH}`);
const db = new DatabaseSync(DB_PATH, { readOnly: true });
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

// ---- the chain cross-check (opt-in) --------------------------------------------------------
//
// EXTERNAL GROUND TRUTH, which is the one kind of evidence the checks above cannot provide: they
// compare the database with itself and with a formula written from the same understanding of the
// pool. This compares it with the chain.
//
// It decodes with viem directly rather than reusing our own decoder, on purpose: running our
// decoder twice proves the decoder is deterministic, not that it is right. An independent decode
// of the same log is the check that would catch a wrong event signature or a misread word offset.
if (AGAINST_CHAIN > 0) {
  console.log(`\n  chain cross-check on ${AGAINST_CHAIN} sampled blocks (external ground truth)`);
  const rows = db
    .prepare(
      `SELECT block_number, tx_hash, log_index, sender, recipient, amount0, amount1,
              sqrt_price_x96, liquidity, tick
         FROM swaps GROUP BY block_number ORDER BY RANDOM() LIMIT ?`,
    )
    .all(AGAINST_CHAIN) as Array<{
    block_number: number;
    tx_hash: string;
    log_index: number;
    sender: string;
    recipient: string;
    amount0: string;
    amount1: string;
    sqrt_price_x96: string;
    liquidity: string;
    tick: number;
  }>;

  const pool = new RpcPool({});
  let compared = 0;
  let mismatched = 0;
  const samples: string[] = [];

  for (const row of rows) {
    const block = BigInt(row.block_number);
    const logs = await pool.getLogs((client) =>
      client.getLogs({
        address: POOL_ADDRESS,
        // `fromBlock === toBlock` so the request is one block: the public endpoint refuses wide
        // ranges, and a cross-check that fails for a range reason reads as a data defect.
        fromBlock: block,
        toBlock: block,
        events: [SWAP_EVENT],
      }),
    );

    // Every stored swap in this block must exist on chain with identical fields. Comparing the
    // stored row against the chain and NOT the other way round: the question is whether what we
    // wrote down is what happened, not whether we caught every log (that is INV-2's job, and it
    // is checked by the indexer itself).
    const storedInBlock = db
      .prepare('SELECT tx_hash, log_index, sender, recipient, amount0, amount1, sqrt_price_x96, liquidity, tick FROM swaps WHERE block_number = ?')
      .all(row.block_number) as Array<Record<string, unknown>>;

    for (const stored of storedInBlock) {
      const onChain = logs.find(
        (l) =>
          String(l.transactionHash).toLowerCase() === String(stored.tx_hash).toLowerCase() &&
          Number(l.logIndex) === Number(stored.log_index),
      );
      compared += 1;
      if (onChain === undefined) {
        mismatched += 1;
        if (samples.length < 3) samples.push(`block ${row.block_number} log ${stored.log_index}: not on chain`);
        continue;
      }
      let decoded: { args: Record<string, unknown> };
      try {
        decoded = decodeEventLog({ abi: [SWAP_EVENT], data: onChain.data, topics: onChain.topics }) as {
          args: Record<string, unknown>;
        };
      } catch (cause) {
        mismatched += 1;
        if (samples.length < 3) samples.push(`block ${row.block_number}: viem could not decode (${String(cause).slice(0, 60)})`);
        continue;
      }
      const a = decoded.args;
      const same =
        String(a.amount0) === String(stored.amount0) &&
        String(a.amount1) === String(stored.amount1) &&
        String(a.sqrtPriceX96) === String(stored.sqrt_price_x96) &&
        String(a.liquidity) === String(stored.liquidity) &&
        Number(a.tick) === Number(stored.tick) &&
        String(a.sender).toLowerCase() === String(stored.sender).toLowerCase() &&
        String(a.recipient).toLowerCase() === String(stored.recipient).toLowerCase();
      if (!same) {
        mismatched += 1;
        if (samples.length < 3) {
          samples.push(
            `block ${row.block_number} log ${stored.log_index}: stored amount0=${stored.amount0} amount1=${stored.amount1} tick=${stored.tick} vs chain ${a.amount0}/${a.amount1}/${a.tick}`,
          );
        }
      }
    }
  }

  check(
    `every stored field matches the chain on ${compared} swaps across ${rows.length} blocks`,
    mismatched === 0,
    mismatched ? `${mismatched} mismatch(es): ${samples.join(' | ')}` : 'amounts, sqrtPriceX96, liquidity, tick, sender and recipient',
  );
  console.log(`      rpc: ${pool.stats.calls} call(s), ${pool.stats.failures} failure(s)`);
}

db.close();

console.log('');
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('all data checks passed');

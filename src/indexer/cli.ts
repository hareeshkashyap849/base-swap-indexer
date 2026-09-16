/**
 * Indexer CLI.
 *
 *   npm run index                 backfill 10,000 blocks and exit
 *   npm run index -- --blocks 500 backfill a smaller window
 *   npm run index:follow          backfill, then keep polling for new blocks
 *
 * Flags:
 *   --blocks <n>     how many blocks to backfill when there is no checkpoint
 *   --to <n>         stop at this block (inclusive)
 *   --db <path>      database file (default data/swaps.sqlite)
 *   --follow         keep running and poll for new blocks
 *   --poll <sec>     poll interval in follow mode (default 12)
 *   --quiet          less output
 *   --reindex        ignore any saved checkpoint and re-backfill
 */

import { Store } from '../lib/db.ts';
import { Indexer, type IndexOptions } from './indexer.ts';
import { POOL_ADDRESS, RPC_URLS, SYMBOL0, SYMBOL1, FEE } from '../config.ts';
import { RpcPool } from '../lib/rpc.ts';
import { POOL_ABI, ERC20_ABI } from '../config.ts';
import type { PublicClient } from 'viem';

interface CliArgs {
  blocks: number;
  to?: bigint;
  db: string;
  follow: boolean;
  poll: number;
  quiet: boolean;
  reindex: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);
  const to = get('to');
  const args: CliArgs = {
    blocks: Number(get('blocks') ?? 10_000),
    db: get('db') ?? 'data/swaps.sqlite',
    follow: has('follow'),
    poll: Number(get('poll') ?? 12),
    quiet: has('quiet'),
    reindex: has('reindex'),
  };
  if (to !== undefined) args.to = BigInt(to);
  if (!Number.isFinite(args.blocks) || args.blocks <= 0) throw new Error(`--blocks must be a positive number`);
  return args;
}

/**
 * Confirm the pool identity before indexing anything.
 *
 * This exists because the single most damaging mistake available in this
 * project is assuming the token order. token0 is WETH and token1 is USDC here;
 * if that were reversed, every price would be its reciprocal — the dashboard
 * would still render, and every number on it would be wrong. So we read the
 * order from chain and refuse to run on a mismatch, instead of trusting a
 * constant in a source file.
 */
async function assertPoolIdentity(): Promise<{ decimals0: number; decimals1: number }> {
  const pool = new RpcPool();
  const info = await pool.run(async (c: PublicClient) => {
    const [token0, token1, fee] = await Promise.all([
      c.readContract({ address: POOL_ADDRESS, abi: POOL_ABI, functionName: 'token0' }),
      c.readContract({ address: POOL_ADDRESS, abi: POOL_ABI, functionName: 'token1' }),
      c.readContract({ address: POOL_ADDRESS, abi: POOL_ABI, functionName: 'fee' }),
    ]);
    const [d0, d1, s0, s1] = await Promise.all([
      c.readContract({ address: token0, abi: ERC20_ABI, functionName: 'decimals' }),
      c.readContract({ address: token1, abi: ERC20_ABI, functionName: 'decimals' }),
      c.readContract({ address: token0, abi: ERC20_ABI, functionName: 'symbol' }),
      c.readContract({ address: token1, abi: ERC20_ABI, functionName: 'symbol' }),
    ]);
    return { token0, token1, fee, d0: Number(d0), d1: Number(d1), s0, s1 };
  });

  if (Number(info.fee) !== FEE) {
    throw new Error(`pool fee mismatch: chain says ${info.fee}, config says ${FEE}`);
  }
  console.log(
    `  pool verified: ${info.s0}(${info.d0}) / ${info.s1}(${info.d1})  fee=${Number(info.fee) / 10_000}%`,
  );
  console.log(`    token0=${info.token0}  token1=${info.token1}`);
  if (info.d0 !== 18 || info.d1 !== 6) {
    console.log(
      `  ⚠ unexpected decimals (expected token0=18, token1=6); price maths assumes 10^${info.d0 - info.d1}`,
    );
  }
  return { decimals0: info.d0, decimals1: info.d1 };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log('base-swap-indexer');
  console.log(`  rpc endpoints : ${RPC_URLS.length}`);
  console.log(`  database      : ${args.db}`);
  console.log(`  mode          : ${args.follow ? 'backfill + follow' : 'backfill only'}`);

  const { decimals0, decimals1 } = await assertPoolIdentity();

  const store = new Store(args.db);
  if (args.reindex) {
    const state = store.getState();
    if (state) {
      console.log(`  --reindex: clearing checkpoint (was ${state.lastIndexedBlock})`);
      store.db.exec('DELETE FROM indexer_state');
    }
  }

  const opts: Partial<IndexOptions> = {
    backfillBlocks: args.blocks,
    follow: args.follow,
    pollSeconds: args.poll,
    verbose: !args.quiet,
  };
  if (args.to !== undefined) opts.toBlock = args.to;

  const indexer = new Indexer(store, opts);

  const started = Date.now();
  const results = await indexer.run();
  const elapsed = Date.now() - started;

  const total = results.reduce((n, r) => n + r.swapsInserted, 0);
  const decoded = results.reduce((n, r) => n + r.swapsDecoded, 0);
  const reorgs = results.reduce((n, r) => n + r.reorgsRecovered, 0);
  const last = results[results.length - 1];

  console.log('\n  ── summary ─────────────────────────────────');
  console.log(`  passes           : ${results.length}`);
  console.log(`  swaps decoded    : ${decoded}`);
  console.log(`  swaps inserted   : ${total}`);
  console.log(`  reorgs recovered : ${reorgs}`);
  console.log(`  chunk adjustments: ${last?.chunkAdjustments ?? 0}`);
  console.log(`  rpc calls        : ${last?.rpc.calls ?? 0} (failures ${last?.rpc.failures ?? 0})`);
  console.log(`  rows in db       : ${store.countSwaps()}`);
  const min = store.minBlock();
  const max = store.maxBlock();
  if (min !== null && max !== null) console.log(`  block range      : ${min} .. ${max}`);
  console.log(`  price decimals   : token0=10^${decimals0} token1=10^${decimals1} (${SYMBOL0}/${SYMBOL1})`);
  console.log(`  elapsed          : ${(elapsed / 1000).toFixed(1)}s`);
  console.log('  ────────────────────────────────────────────');
  console.log(`\n  next: npm run api   (then open http://127.0.0.1:3001/)`);

  store.close();
}

main().catch((err: unknown) => {
  console.error('\n  ✖ indexer failed:');
  console.error(`    ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) {
    console.error(
      err.stack
        .split('\n')
        .slice(1, 4)
        .map((l) => `    ${l.trim()}`)
        .join('\n'),
    );
  }
  process.exitCode = 1;
});

/**
 * Which public Base RPC endpoints exist, which answer, and which will serve a batch?
 *
 * WHY THIS EXISTS
 *
 * A 200,000-block backfill measured at **0.2 blocks/s** in its header phase, against a probe that said
 * the one usable endpoint delivers ~20 headers/second. The gap was not in the code: `mainnet.base.org`
 * refuses batches outright and `base.drpc.org` refuses anything over three requests, so every header
 * in the window went through a single host, and when that host throttled there was nothing to rotate
 * to. **The lever on a large index is the number of batch-capable endpoints, not the batch size.**
 *
 * So this asks the question directly: for each candidate host, does it answer, is it on the right
 * chain, and does it serve a batch of 200 block headers with the fields we need?
 *
 * A `chainId` check is not ceremony. Pointing an indexer at the wrong chain produces rows that look
 * perfectly well-formed and describe different tokens -- the same class of silent failure as reading
 * the token order backwards, which this project already has one defence against.
 *
 * Usage:
 *
 *   node tools/probe-endpoints.mjs
 *   node tools/probe-endpoints.mjs --batch 200 --json
 */
import { CHAIN_ID, RPC_URLS } from '../src/config.ts';

/**
 * Candidate public Base mainnet RPCs, collected from the providers' own documentation.
 *
 * Kept as a list rather than added straight to the config: most of them will fail (wrong chain, no
 * batching, an archive restriction), and a config entry is a claim that this endpoint works. The
 * probe decides which ones earn a place.
 */
const CANDIDATES = [
  ...RPC_URLS,
  'https://base.llamarpc.com',
  'https://base.meowrpc.com',
  'https://1rpc.io/base',
  'https://base.blockpi.network/v1/rpc/public',
  'https://base-mainnet.public.blastapi.io',
  'https://gateway.tenderly.co/public/base',
  'https://base.api.onfinality.io/public',
  'https://base.publicnode.com',
  'https://base-rpc.publicnode.com',
];

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const BATCH = Number(flag('--batch', '200'));
const AS_JSON = args.includes('--json');

const post = async (url, body, timeoutMs = 20_000) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, text: await res.text() };
};

/** One block header per batch element, at a fixed historical block so all endpoints answer the same. */
const HEAD_BLOCK = 51_000_000;
const batchPayload = (count) =>
  Array.from({ length: count }, (_, i) => ({
    jsonrpc: '2.0',
    id: i,
    method: 'eth_getBlockByNumber',
    params: ['0x' + (HEAD_BLOCK + i).toString(16), false],
  }));

const results = [];

for (const url of [...new Set(CANDIDATES)]) {
  const row = { url, chainId: null, head: null, batch: 'not tried', ms: {} };

  // 1. single request: does it answer at all, and on which chain?
  try {
    const t0 = Date.now();
    const { status, text } = await post(url, { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] });
    row.ms.chainId = Date.now() - t0;
    const parsed = JSON.parse(text);
    row.chainId = parsed.result ? Number.parseInt(parsed.result, 16) : null;
    row.chainHttp = status;
    if (row.chainId !== CHAIN_ID) row.batch = `wrong chain (${row.chainId ?? parsed.error?.message ?? status})`;
  } catch (err) {
    row.batch = `unreachable: ${String(err.message).slice(0, 40)}`;
  }

  // 2. a batch of headers, only if the chain is right
  if (row.batch === 'not tried') {
    try {
      const t0 = Date.now();
      const { status, text } = await post(url, batchPayload(BATCH), 35_000);
      row.ms.batch = Date.now() - t0;
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) {
        row.batch = `no batch: ${String(parsed.error?.message ?? text).slice(0, 50)}`;
      } else if (parsed.length !== BATCH) {
        row.batch = `short batch: ${parsed.length}/${BATCH}`;
      } else {
        const bad = parsed.find((item) => !item?.result?.timestamp || !item?.result?.hash);
        row.batch = bad ? 'batch missing fields' : `OK ${BATCH}`;
      }
      if (status !== 200) row.batch = `HTTP ${status}: ${row.batch}`;
    } catch (err) {
      row.batch = `batch failed: ${String(err.message).slice(0, 40)}`;
    }
  }

  results.push(row);
  if (!AS_JSON) {
    const batchOk = row.batch.startsWith('OK');
    console.log(
      `${batchOk ? 'YES' : 'no '}  ${url.padEnd(50)} chain=${String(row.chainId ?? '-').padEnd(6)} batch=${row.batch}`,
    );
  }
}

if (AS_JSON) {
  console.log(JSON.stringify({ batchSize: BATCH, results }, null, 2));
} else {
  const usable = results.filter((r) => r.batch.startsWith('OK'));
  console.log(`\n${usable.length} of ${results.length} candidate endpoints serve a batch of ${BATCH} headers:`);
  for (const r of usable) console.log(`  ${r.url}  (${r.ms.batch}ms)`);
  console.log(
    '\nEach one added to RPC_URLS multiplies the header-fetch ceiling. The measured single-endpoint rate\n' +
      'is ~20 headers/s, so three usable hosts is roughly 60/s and a 200,000-block window finishes in\n' +
      'about 25 minutes instead of two hours.',
  );
}

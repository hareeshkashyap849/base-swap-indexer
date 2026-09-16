/**
 * Can the configured endpoints serve `eth_getLogs` for a HISTORICAL window?
 *
 * WHY THIS PROBE COMES FIRST
 *
 * A scale run indexes hundreds of thousands of blocks, which is days of chain history. The
 * fragile part is not our code: `src/config.ts` records what was measured here --
 * `base-rpc.publicnode.com` answers `-32602 Archive requests require a personal token`,
 * `base.drpc.org` refuses ranges over 10,000 blocks, and only `mainnet.base.org` served a
 * historical range. Whether that still holds a week later is not knowable from the source, and a
 * run that dies twenty minutes in because receipts were pruned is twenty minutes and an ambiguous
 * failure: "the endpoint refused" and "the decoder broke" produce similar log noise.
 *
 * So this asks the endpoints directly, over several windows, in about ten seconds. It is the
 * difference between "the range is not available" and "our code is wrong", and it has to be
 * established before the long run rather than inferred from it.
 *
 * Usage:
 *
 *   node tools/probe-rpc-range.mjs                        # 2,000 blocks at four distances from the head
 *   node tools/probe-rpc-range.mjs --blocks 500 --back 1000,2000000
 *   node tools/probe-rpc-range.mjs --json                 # machine-readable, for the evidence file
 */
import { encodeEventTopics } from 'viem';
import { POOL_ADDRESS, SWAP_EVENT, RPC_URLS } from '../src/config.ts';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

const RANGE = Number(flag('--blocks', '2000'));
const BACKS = flag('--back', '1000,50000,100000,250000')
  .split(',')
  .map((n) => Number(n.trim()));
const AS_JSON = args.includes('--json');

const topic0 = encodeEventTopics({ abi: [SWAP_EVENT], eventName: 'Swap' })[0];

async function post(url, body, timeoutMs = 25_000) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, text: await res.text() };
}

const headBody = { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] };
const headRes = await post(RPC_URLS[0], headBody);
const head = BigInt(JSON.parse(headRes.text).result);

const results = [];
if (!AS_JSON) console.log(`head ${head}  (read from ${RPC_URLS[0]})\n`);

for (const endpoint of RPC_URLS) {
  if (!AS_JSON) console.log(`--- ${endpoint} ---`);
  for (const back of BACKS) {
    const to = head - BigInt(back);
    const from = to - BigInt(RANGE) + 1n;
    const t0 = Date.now();
    const row = { endpoint, backFromHead: back, from: from.toString(), to: to.toString() };
    try {
      const { status, text } = await post(endpoint, {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getLogs',
        params: [
          {
            address: POOL_ADDRESS,
            topics: [topic0],
            fromBlock: '0x' + from.toString(16),
            toBlock: '0x' + to.toString(16),
          },
        ],
      });
      row.httpStatus = status;
      row.ms = Date.now() - t0;
      const parsed = JSON.parse(text);
      if (parsed.error) {
        row.error = String(parsed.error.message).slice(0, 160);
      } else {
        row.logs = Array.isArray(parsed.result) ? parsed.result.length : null;
        row.malformed = !Array.isArray(parsed.result);
      }
    } catch (err) {
      row.ms = Date.now() - t0;
      row.error = String(err.cause?.code ?? err.message).slice(0, 160);
    }
    results.push(row);
    if (!AS_JSON) {
      const outcome =
        row.logs !== undefined
          ? `${String(row.logs).padStart(5)} logs`
          : `ERROR ${row.error}`;
      console.log(`  head-${String(back).padEnd(8)} ${outcome}  ${row.ms}ms`);
    }
  }
  if (!AS_JSON) console.log('');
}

if (AS_JSON) {
  console.log(JSON.stringify({ head: head.toString(), range: RANGE, blockRange: `${RANGE} blocks`, results }, null, 2));
} else {
  const usable = results.filter((r) => typeof r.logs === 'number' && r.logs > 0);
  const furthest = usable.reduce((best, r) => (best === null || r.backFromHead > best.backFromHead ? r : best), null);
  console.log(
    furthest === null
      ? 'No endpoint returned logs at any probed distance.'
      : `Furthest window that answered with logs: ${furthest.endpoint} at head-${furthest.backFromHead} (${furthest.logs} logs)`,
  );
}

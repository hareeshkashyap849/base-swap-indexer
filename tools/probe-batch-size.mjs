/**
 * How large a JSON-RPC batch will each endpoint actually serve?
 *
 * WHY THIS IS THE QUESTION WORTH ASKING
 *
 * The header fetch is the expensive half of a backfill: one header per distinct block containing a
 * swap, which for a 200,000-block window is ~120,000 headers. The batch path exists to make that
 * cheap -- but the batch size in the code was **200**, a number with no measurement behind it, and at
 * 200 blocks per request the window needs 600 requests. If the endpoint would serve 1,000, the same
 * work is 120 requests.
 *
 * The endpoints do not document this and they do not agree: `mainnet.base.org` answers a batch with
 * `-32014 maximum 1 request in batch`. So it gets measured, once, in about thirty seconds.
 *
 * Usage:
 *
 *   node tools/probe-batch-size.mjs
 *   node tools/probe-batch-size.mjs --sizes 50,200,500,1000 --block 51000000
 */
import { RPC_URLS } from '../src/config.ts';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const SIZES = flag('--sizes', '50,200,500,1000,2000')
  .split(',')
  .map((n) => Number(n.trim()));
const BLOCK = Number(flag('--block', '51000000'));

const payload = (count) =>
  JSON.stringify(
    Array.from({ length: count }, (_, i) => ({
      jsonrpc: '2.0',
      id: i,
      method: 'eth_getBlockByNumber',
      params: ['0x' + (BLOCK + i).toString(16), false],
    })),
  );

/** Valid only if every element carries a timestamp and a hash -- a right-sized reply is not enough. */
function judge(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, why: `not JSON: ${text.slice(0, 60)}` };
  }
  if (!Array.isArray(parsed)) return { ok: false, why: `not an array: ${text.slice(0, 60)}` };
  if (parsed.length === 0) return { ok: false, why: 'empty array' };
  const bad = parsed.find(
    (item) => item?.error || !item?.result?.timestamp || !item?.result?.hash,
  );
  if (bad) {
    const detail = bad.error ? JSON.stringify(bad.error).slice(0, 70) : 'result missing timestamp/hash';
    return { ok: false, why: detail };
  }
  return { ok: true, count: parsed.length };
}

console.log(`probing batches of ${SIZES.join(', ')} headers, starting at block ${BLOCK}\n`);

for (const endpoint of RPC_URLS) {
  console.log(`--- ${endpoint} ---`);
  for (const size of SIZES) {
    const t0 = Date.now();
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload(size),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      const ms = Date.now() - t0;
      if (!res.ok) {
        console.log(`  ${String(size).padStart(5)}  HTTP ${res.status}  ${ms}ms  ${text.slice(0, 70)}`);
        continue;
      }
      const verdict = judge(text);
      console.log(
        `  ${String(size).padStart(5)}  ${verdict.ok ? 'OK  ' : 'BAD '}  ${ms}ms  ${verdict.ok ? `${verdict.count} headers` : verdict.why}`,
      );
    } catch (err) {
      console.log(`  ${String(size).padStart(5)}  FAILED  ${Date.now() - t0}ms  ${String(err.message).slice(0, 70)}`);
    }
  }
  console.log('');
}

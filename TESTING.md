# Testing guide

How to check that this project actually works. Four levels, from "30 seconds"
to "I do not trust your README".

---

## Level 1 — the test suite (30 seconds)

```bash
npm ci --ignore-scripts     # --ignore-scripts: nothing here needs a postinstall
npm run verify              # typecheck + all tests
```

Expected:

```
chunker.test.ts   20 pass
price.test.ts     15 pass
api.test.ts       14 pass
```

No network access is required and no shared state is used, so this is
deterministic. **If you only do one thing, do this.**

`npm test` runs the same three files. Individual files:

```bash
node --experimental-strip-types test/price.test.ts
```

> `node --test <file>` and `node --test` (auto-discovery) both spawn a child
> process per file, which is why `npm test` invokes the files directly. That
> detail is invisible here but matters in restricted environments.

---

## Level 2 — end-to-end with real chain data (~1 minute)

```bash
npm run index -- --blocks 500
node --experimental-strip-types verify-data.ts
```

`npm run index` first **verifies the pool identity against the chain** and
aborts if it disagrees with `src/config.ts`. Expected output:

```
pool verified: WETH(18) / USDC(6)  fee=0.05%
  token0=0x4200000000000000000000000000000000000006  token1=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
  indexing 51347589 → 51347888  (300 blocks, head ...)
    51347589-51347638 (size 50) -> 27 swaps   [chunk 60]
    ...
  swaps decoded    : 318
  swaps inserted   : 318
```

Then the data audit:

```
  INV-3 price cross-check on 300 rows: PASS
      price range seen: 2411.77 .. 2486.20 USDC per WETH
  price magnitude is plausible for this pair: PASS
  INV-6 sign consistency: PASS
  timestamp sanity: PASS
  both trade directions present: PASS
  INV-5 SQL vs JS volume agreement: PASS
all data checks passed
```

**The number to sanity-check is the price.** It must be in the low thousands
(USDC per WETH). If you see something near `0.0004`, the token order has been
read backwards — that is the specific failure mode this project was built to
make impossible, and the reason `verify-data.ts` asserts on magnitude rather
than only on self-consistency.

### Test that the checks can actually fail

A check that cannot fail is not a check. Try these:

```bash
# Price direction: temporarily swap the decimals and watch INV-3 magnitude fail
#   src/lib/price.ts is where the derivation lives; the tests pin the real value.

# Empty database: the audit must exit non-zero, not print nothing and succeed
mv data/swaps.sqlite data/swaps.hidden
node --experimental-strip-types verify-data.ts   # expect exit 1
mv data/swaps.hidden data/swaps.sqlite
```

---

## Level 3 — the API and dashboard (~1 minute)

```bash
npm run api          # serves http://127.0.0.1:3001
```

| Check | Command | Expected |
|---|---|---|
| Dashboard | open `http://127.0.0.1:3001/` | charts with real prices, ~16 KB HTML |
| Freshness | `curl http://127.0.0.1:3001/api/health` | `{"ok":true,...,"lag":<small>}` |
| Stats | `curl 'http://127.0.0.1:3001/api/stats?hours=6'` | non-zero `vwap`, `trades`, `uniqueTraders` |
| Candles | `curl 'http://127.0.0.1:3001/api/ohlcv?interval=5m&hours=2'` | `count > 0`, `high >= low` |
| Trades | `curl 'http://127.0.0.1:3001/api/swaps?limit=3'` | newest first |
| Bad input | `curl 'http://127.0.0.1:3001/api/swaps?limitt=5'` | **400**, not 200 |
| Bad route | `curl http://127.0.0.1:3001/api/nope` | **404 JSON**, not HTML |

### What to look for in the dashboard

1. **The price is plausible** (low thousands, not `0.0004`) — this is the
   direction check, visible without reading any code.
2. **The freshness strip reports a small lag.** A large or growing lag means the
   indexer is behind, and the UI says so rather than hiding it.
3. **Buy and sell both appear** in the trade table. A one-sided table means the
   sign convention was misread.
4. **The freshness strip is honest**: if you stop the indexer and wait, `lag`
   grows. Data that silently stays "fresh" would be a bug.

---

## Level 4 — adversarial checks

If you want to try to break it, these are the places it is most likely to fail,
and each corresponds to a real measured constraint:

| Try this | What should happen |
|---|---|
| `npm run index -- --blocks 100000` | Chunk size should visibly shrink on large responses, then recover. No block is ever skipped. |
| Run `npm run index` twice in a row | Second run inserts 0 new rows (idempotent, INV-1). Row count unchanged. |
| Kill the indexer mid-run (Ctrl+C), then rerun | It resumes from the checkpoint; row count only grows. |
| Delete `data/` and rerun | Clean rebuild. Nothing in the repo depends on generated data. |
| Point `RPC_URLS` at one dead endpoint | Errors are classified and reported; the run aborts rather than skipping ranges. |
| Read a range so large it exceeds the response limit | The error is classified as `TOO_LARGE`, the chunk halves, and the run continues. |

### The failure mode that is hardest to see

Delete a block range from the middle of `swaps`, then query `/api/stats`. The
aggregates will still look entirely reasonable — which is the point. A skipped
range is invisible in the output. That is why the indexer aborts on an
unrecoverable error instead of skipping, and why `assertContiguousCoverage`
exists as an executable check rather than a comment.

---

## What is *not* covered

Being explicit, because a testing guide that claims completeness is not useful:

- **No test against a real chain reorganisation.** Reorg recovery is exercised
  by logic about stored block hashes, not by observing one happen. The 64-block
  probe depth is a design choice, not a measured bound.
- **The React dashboard's production build is unverified.** `web/` typechecks but
  `vite build` was not run in the environment this was written in (esbuild
  cannot start there). The static `dashboard/` **was** verified end to end.
- **No load test.** The API is exercised at single-request scale; 9,000 rows is
  not a stress test.
- **No testnet/mainnet deployment test.** There is nothing deployed and nothing
  to deploy — the project is read-only.

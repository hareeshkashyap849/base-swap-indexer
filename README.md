# base-swap-indexer

[![CI](https://github.com/hareeshkashyap849/base-swap-indexer/actions/workflows/ci.yml/badge.svg)](https://github.com/hareeshkashyap849/base-swap-indexer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Indexes every swap on a Uniswap V3 WETH/USDC pool on **Base mainnet**, stores
them in SQLite, and serves them through a REST API and a dashboard.

**Pool:** `0xd0b53D9277642d899DF5C87A3966A349A798F224` (WETH/USDC, 0.05% fee)
**Chain:** Base mainnet (8453) · **Access:** read-only, no wallet, no keys

```bash
npm install
npm run index      # backfill 10,000 blocks (~2 min)
npm run api        # http://127.0.0.1:3001
```

Then open **http://127.0.0.1:3001/** for the dashboard, or `npm run web` for the
React version on http://127.0.0.1:5173.

Requires **Node 22.6+**. No compiler, no Docker, no database server.

### Starting and stopping the API on Windows

`npm run api` goes through `npm.cmd`, a batch wrapper. On Windows, Ctrl+C is
delivered to that batch file rather than to the node process it started, so npm
exits while node keeps running and keeps the port. The next start then fails with
`EADDRINUSE`, and the terminal looks impossible to stop.

Three ways to avoid that:

```powershell
tools\serve.cmd                 # starts node directly; Ctrl+C reaches the server
node --no-warnings --experimental-strip-types src/api/server.ts   # same thing
$env:PORT=3002; npm run api     # or just use another port
```

If a process is already holding the port:

```powershell
node tools/kill-api.ps1         # stops whatever holds 3001
```

Closing the terminal window also works — it terminates the window's child
processes, which Ctrl+C does not reliably do here.

---

## What this actually does

```
Base RPC ──getLogs──▶ Indexer ──decode──▶ SQLite ──SQL──▶ API ──▶ Dashboard
   │                     │
   │              adaptive chunking
   │              checkpoint / resume
   │              reorg detection
   └─ multi-endpoint rotation with learned capabilities
```

A measured run over 10,000 blocks: **8,668 swaps** indexed in ~4.6 minutes,
priced between **$2,436 and $2,486** per WETH.

---

## Why it is built this way

### Public RPC endpoints are hostile, so the code assumes it

Every constraint below was measured against live Base mainnet, not assumed:

| Observation | Consequence in the code |
|---|---|
| A ~10 MB response fails outright; wide `eth_getLogs` ranges are rejected | Chunk size **adapts** instead of being fixed |
| Log density varies **175×** over the same span of chain (55 logs in one 50-block chunk, 9,616 in another) | Growth is additive on success, halving on failure — a fixed size cannot work |
| 6 concurrent `eth_call` requests trip the rate limiter | Multi-endpoint rotation with backoff |
| `base.drpc.org` returns a correctly-sized batch reply with every `timestamp` field **silently missing** | Batch replies are **validated field-by-field**, not counted |
| `mainnet.base.org` rejects batches with `-32014` | The pool **learns** which endpoints cannot batch and stops asking them |

That last pair is the interesting one. Counting results would have accepted
drpc's reply and written `timestamp = 0` for every swap — a chart that renders
fine and is confidently wrong. And without the learned-capability memo, a
10,000-block backfill burned **123 RPC calls with 59 failures**; after the fix
it used **85 calls with 21 failures** and took **half the wall-clock time**.

### Errors are never swallowed

A range that fails for a size-related reason shrinks and retries. A range that
fails for any other reason **aborts the run**. It is never skipped, because a
skipped range is invisible downstream: the dashboard would simply show fewer
trades, with nothing to indicate data was missing.

The checkpoint advances only after the data is committed, so a crash can lose
work but can never claim work that was not done.

### The token order is the whole ballgame

This pool has **token0 = WETH (18 decimals)** and **token1 = USDC (6 decimals)**.
The raw ratio `token1/token0` is therefore already *USDC per WETH*. Reading it
the other way inverts every number in the project while still producing
plausible-looking output.

Three defences:

1. `token0`/`token1` are **read from chain at startup**, not trusted from a constant.
2. Price is derived **two independent ways** — from `sqrtPriceX96` and from
   `tick` — and the two are cross-checked on every row.
3. The test suite pins the real measured value (`~2443 USDC/WETH`), so an
   inverted reading fails loudly instead of quietly.

### Zero build toolchain

Node runs the TypeScript directly via `--experimental-strip-types`.
`erasableSyntaxOnly` in `tsconfig.json` guarantees the source stays strippable.

Two dependencies were removed for the reviewer's sake, not ours:

- **`better-sqlite3` → `node:sqlite`.** The native module installs through
  node-gyp, which needs a compiler toolchain; requiring one would defeat
  "clone and run".
- **`tsx` → `node --experimental-strip-types`.** tsx spawns an esbuild service.

Runtime dependencies are **viem** and **fastify**, nothing else. Tests use the
built-in `node:test` runner, so there is no test framework either.

### The dashboard needs no build

The default dashboard is a single self-contained HTML file with hand-drawn
canvas charts, served by the API at `/`. Opening it requires no `npm install`,
no bundler and no toolchain. The React + Vite app under `web/` is the primary
implementation and is what demonstrates framework work; the static file is what
makes the output immediately visible.

---

## Verified behaviour

Run it yourself:

```bash
npm run verify          # typecheck + 49 tests
```

```
typecheck              strict, plus noUncheckedIndexedAccess and exactOptionalPropertyTypes
chunker.test.ts   20   adaptive sizing, and exact coverage (INV-2)
price.test.ts     15   derivation maths, the direction trap, sign convention (INV-6)
api.test.ts       14   response shapes, aggregation agreement (INV-5), malformed input (F12)
```

Plus a data audit against the indexed database:

```bash
node --experimental-strip-types verify-data.ts
```

```
INV-3 price cross-check on 300 rows: PASS
  price range seen: 2436.10 .. 2486.20 USDC per WETH
INV-6 sign consistency: PASS
timestamp sanity: PASS
INV-5 aggregation agreement: PASS   (JS 5682828.51 == SQL 5682828.51)
```

And a headless smoke test for the dashboard, which needs the API running:

```bash
npm run api &
npm run smoke:dashboard
```

It renders the dashboard's real script against a minimal DOM, records every
canvas call, and asserts the geometry is not degenerate. That check exists
because of a real bug: the chart code read `.price` and `.volume` from candles
that only had `.close` and `.volumeUsdc`, so every Y coordinate was `NaN` and
both charts silently drew nothing — no exception, no console error. Neither the
typechecker nor the unit tests can see that, since the dashboard is plain JS
inside an HTML page. It is now covered in CI.

### Invariants the tests encode

| # | Invariant | Why it matters |
|---|---|---|
| INV-1 | Re-indexing a range changes nothing | A non-idempotent indexer double-counts volume |
| INV-2 | Chunking covers the span exactly, no gaps or overlaps | A gap is a **silent** error |
| INV-3 | `sqrtPriceX96` and `tick` derivations agree | Catches a token-order or RPC-data error |
| INV-4 | No rows survive from an abandoned block after a reorg | Reorgs are the most commonly ignored correctness problem |
| INV-5 | Aggregates equal the rows they summarise | Catches a wrong `WHERE` or `GROUP BY` |
| INV-6 | `sign(amount0) = -sign(amount1)` | A violation means the event was decoded wrong |

---

## API

| Endpoint | Purpose |
|---|---|
| `GET /` | Dashboard (or a JSON service description if the file is absent) |
| `GET /api/health` | Indexer freshness: last indexed block, chain head, lag |
| `GET /api/swaps?limit=&beforeBlock=&beforeLogIndex=` | Recent swaps, newest first |
| `GET /api/ohlcv?interval=&hours=&maxCandles=` | OHLCV candles |
| `GET /api/stats?hours=` | VWAP, volume, trade count, unique traders, range |

```bash
curl 'http://127.0.0.1:3001/api/stats?hours=6'
curl 'http://127.0.0.1:3001/api/ohlcv?interval=5m&hours=2'
```

Malformed input returns `4xx`, never `500`:

```
GET /api/swaps?limitt=5      → 400  querystring must NOT have additional properties
GET /api/swaps?limit=99999   → 400  querystring/limit must be <= 500
```

That first case is deliberate. Fastify's default AJV configuration sets
`removeAdditional: 'all'`, which **silently deletes** unknown parameters — a
client misspelling `limit` would get a `200` with defaulted data and no signal
that anything was wrong. Disabling it turns typos into errors.

---

## Indexer CLI

```
npm run index                     backfill 10,000 blocks and exit
npm run index -- --blocks 500     smaller window
npm run index -- --reindex        ignore the saved checkpoint
npm run index:follow              backfill, then keep polling
```

---

## Layout

```
src/indexer/     chunker (adaptive sizing) · indexer (fetch, decode, reorg) · cli
src/lib/         price maths · RPC pool · SQLite store · read queries
src/api/         fastify server and routes
dashboard/       single-file zero-build dashboard
web/             React + Vite dashboard
test/            49 cases, no network, no shared state
docs/            requirements spec (S0) and architecture (S2)
verify-data.ts   data audit run against a populated database
```

---

## Known limitations

Stated plainly, because a portfolio project that claims none is not credible:

- **Timestamps come from block headers, not events.** Uniswap V3's `Swap` event
  carries no timestamp, so one header fetch per distinct block is required.
  Those fetches are batched.
- **Reorg handling is bounded.** Detection walks back at most 64 blocks. A
  deeper reorg is reported, not silently recovered — the code refuses to delete
  data on a guess.
- **`node:sqlite` is marked experimental** on Node 24 and prints a startup
  warning. Its API is smaller than `better-sqlite3`'s. `Store` in
  `src/lib/db.ts` is the only place the driver is used, so swapping is
  contained.
- **Public RPC endpoints have no SLA.** They rate-limit and occasionally return
  malformed data. Correctness is defended by validation and cross-checks; it is
  not guaranteed by the provider.
- **Not deployed anywhere.** This runs locally by design — there is no hosted
  instance. Saying otherwise would be a lie.
- **One pool, one chain, indexed window only.** Not a general-purpose indexer.
- **No reorg or partition test against a live chain.** Reorg recovery is
  exercised by unit-level reasoning about stored hashes, not by observing a real
  reorg. That is a genuine gap in the evidence.
- **The React dashboard was not built in the environment this was written in**,
  because esbuild cannot start there. It typechecks, but its production build is
  unverified. The static dashboard *was* verified end to end.

---

## Design documents

- [`TESTING.md`](TESTING.md) — how to verify this project, in four levels, plus
  what is deliberately **not** covered
- [`docs/01-requirements-spec.md`](docs/01-requirements-spec.md) — scope, acceptance
  criteria, explicit non-goals
- [`docs/02-architecture.md`](docs/02-architecture.md) — component design, CROPS
  review, frozen decisions with rejected alternatives, failure-mode analysis,
  invariant definitions

These are written in Chinese: they are working documents, and the reasoning in
them was done in the author's first language.

---

## Licence

MIT

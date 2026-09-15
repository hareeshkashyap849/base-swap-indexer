# Requirements — base-swap-indexer

What this project is supposed to do, how each requirement is judged, and what it
deliberately does not do.

Every acceptance criterion below is written so it can be checked by running
something, not by reading the code and forming an impression. Where a requirement
was later found to be unrealistic, that is recorded rather than quietly dropped.

---

## 0. Verified facts this project is built on

These were measured against Base mainnet before any code was written. They are
the reason several design decisions look the way they do.

| Fact | Value | How it was checked |
|---|---|---|
| Target pool | `0xd0b53D9277642d899DF5C87A3966A349A798F224` | RPC `eth_call` |
| Protocol | Uniswap V3, `fee()` = 500 (0.05%) | `fee()` |
| **token0** | **WETH** `0x4200...0006`, **18 decimals** | `token0()` + `decimals()` |
| **token1** | **USDC** `0x8335...2913`, **6 decimals** | `token1()` + `decimals()` |
| `sqrtPriceX96` | `3916385922366450481262234` | `slot0()` |
| `tick` | `-198309` | `slot0()` |
| `liquidity` | `1505864926519222278` | `liquidity()` |
| Price self-consistency | `sqrtPriceX96` and `tick` agree (error < 0.001) | derived independently from both |
| Event density | **936 `Swap` events / 500 blocks** (near Base block 51,345,386) | `eth_getLogs` |
| Density is uneven | one 50-block span returned 55 logs, a neighbouring one **9,616** | measured |
| Single-response limit | above ~10 MB, viem throws `ResponseBodyTooLargeError` | measured (a 2,000-block pull failed) |
| Rate limiting | 6 concurrent `eth_call` requests trip the limiter | measured |
| `eth_getLogs` range limit | a 50,000-block range is rejected by the endpoint | measured |

> ⚠️ **The entire price derivation depends on `token0` being WETH.**
> Before checking, the assumption was that `token0` was USDC — which would have
> produced the *reciprocal* of the real price and made every number on the
> dashboard wrong while still rendering perfectly.
> That near-miss is why token order is read from the chain at runtime and
> cross-checked (see `ARCHITECTURE.md`, INV-3) instead of being a constant.

---

## 1. Functional requirements

Each row is a user story with an acceptance criterion that can be tested.

### 1.1 Indexer (the core)

| # | Story | Acceptance criterion | Priority |
|---|---|---|---|
| F1 | As a user I want historical `Swap` events fetched so there is data to query | Backfill the last 10,000 blocks; rows > 0; every row carries `blockNumber` / `txHash` / `logIndex` / `sender` / `recipient` / `amount0` / `amount1` / `sqrtPriceX96` / `liquidity` / `tick` | Must |
| F2 | As a user I want indexing to resume rather than restart | Kill the process and re-run: already-indexed blocks are not re-fetched (resumes from `lastIndexedBlock`); running twice leaves the row count unchanged (idempotent) | Must |
| F3 | As a user I want one failing range not to fail the whole run | A failing `getLogs` shrinks the range and retries; after a failure threshold it stops with an **explicit error** — never a silent skip | Must |
| F4 | As a user I want indexing to survive sudden log-density changes | Chunk size adapts: halves on oversized responses or rate limits, grows gradually on success, with a configurable ceiling | Must |
| F5 | As a user I want indexing to keep up with the chain head | `--follow` keeps indexing new blocks and advances `lastIndexedBlock` | Should |
| F6 | As a user I want reorganisations detected | When a stored `blockHash` disagrees with the chain, that block and everything after it is **rolled back and re-indexed**, with a warning | Should |
| F7 | As a user I want tolerance of multiple RPC endpoints | On rate limit or error, fall through to the next endpoint; only fail when all are exhausted | Must |

### 1.2 API

| # | Story | Acceptance criterion | Priority |
|---|---|---|---|
| F8 | As an integrator I want paged trades | `GET /api/swaps?limit=&cursor=` returns trades ordered by `blockNumber, logIndex` descending; `limit` is server-capped and cannot be made arbitrarily large | Must |
| F9 | As an integrator I want a price series | `GET /api/ohlcv?interval=1h&limit=` returns OHLC in USDC with fields `ts, open, high, low, close, volumeUsdc, trades` | Must |
| F10 | As an integrator I want summary metrics | `GET /api/stats` returns `vwap` / `volumeUsdc` / `trades` / `uniqueTraders` / `lastIndexedBlock` / `priceNow` | Must |
| F11 | As an integrator I want to know index health | `GET /api/health` returns `ok` / `lastIndexedBlock` / `chainHead` / `lag` | Should |
| F12 | As a user I want bad input handled | Invalid `interval`, non-numeric `limit`, out-of-range parameters → 4xx with a clear message, **never a 500** | Must |

### 1.3 Dashboard

| # | Story | Acceptance criterion | Priority |
|---|---|---|---|
| F13 | As a visitor I want the pool's state at a glance | First screen shows current price, volume, trade count, unique trader count | Must |
| F14 | As a visitor I want price and volume over time | Price line/area chart plus a volume bar chart, switchable between intervals (1h / 1d) | Must |
| F15 | As a visitor I want recent trades | Table of time, direction (buy/sell), amounts (USDC and WETH), price | Must |
| F16 | As a visitor I want to know how fresh the data is | The page shows "data up to block X / updated at Y" and flags staleness visually | Should |

### 1.4 Deliverables

| # | Acceptance criterion | Priority |
|---|---|---|
| F17 | A standalone git repository whose README covers: what it is, an architecture diagram, how to run it in one command, methodology, known limitations | Must |
| F18 | Every command in the README has actually been run (the documentation is itself a test) | Must |
| F19 | Tests exist and `npm test` passes (price maths, chunking, reorg, API validation) | Must |

---

## 2. Non-functional requirements

### 2.1 Runtime and deployment

| Item | Answer | Note |
|---|---|---|
| Chain | **Base mainnet** (chainId 8453) | Real mainnet data, read-only, no funds at risk |
| Writes to chain | **No** | Read-only indexer: no transactions, no private keys, no funds |
| Database | **SQLite** | No configuration, single file, a reviewer can clone and run |
| Postgres | **Migration path documented only** | Deliberately not a prerequisite |
| Docker | **Not required** | A deliberate decision: it would put a barrier in front of reviewers |
| Node | >= 20 (verified on 24.9.0) | Uses the built-in `node --test`, so no extra test dependency |

### 2.2 Scale

| Item | Magnitude | Consequence |
|---|---|---|
| Blocks indexed | 10,000 (~5.5 h of chain time at Base's 2 s blocks) | ~18,000 `Swap` rows at the measured 936 / 500 blocks |
| Database size | Estimated < 10 MB | SQLite is more than sufficient |
| Concurrent users | 1 (a reviewer) | No load balancing needed |
| Upstream dependency | Public RPC (free, rate-limited, no SLA) | **Fault tolerance is mandatory** — see F3 / F7 |

### 2.3 Tokens and compliance

- **No token is issued.** No token economics are involved.
- Read-only indexing of public chain data: no custody, no users, no payments,
  no personal data collected. Chain addresses are pseudonymous public data.
- This is a personal project on public data. It makes **no claim** of production
  or financial track record.

### 2.4 Performance and cost

| Item | Target | How it is checked |
|---|---|---|
| 10k-block backfill duration | Recorded, no hard target | the indexer's own timing output |
| API P95 latency | < 200 ms locally, ~18k rows | measured |
| Cost | **$0** | free public RPC, no hosting (runs locally) |
| RPC call count | Recorded (it documents the trade-offs made under rate limiting) | the indexer's statistics output |

---

## 3. Explicit non-goals

The scope boundary. Each of these was considered and rejected on purpose.

| # | Not doing | Why not |
|---|---|---|
| N1 | Multiple pools / protocols | One pool already exercises the full path — indexing, decoding, aggregation, API, UI. More pools is duplicated labour, not more evidence. |
| N2 | Multiple chains | Same reasoning. |
| N3 | Writing to chain, sending transactions, wallet connection | This project is a **read-only indexer**. Wallet integration belongs in a different project (see the ERC-4626 vault), not mixed in here. |
| N4 | WebSocket push | Polling satisfies the dashboard; push would be an enhancement. |
| N5 | Docker / Kubernetes | Deliberately avoids putting a barrier in front of reviewers. |
| N6 | An ORM (Prisma / Drizzle) | Hand-written parameterised SQL. Writing it by hand shows understanding of indexes and query plans; an ORM hides exactly the parts worth seeing. |
| N7 | Full history from genesis | 10k blocks demonstrates the capability; full history needs a paid RPC endpoint and hours. |
| N8 | Auth, multi-user, rate-limit middleware | There is no user system. |
| N9 | Hosting / domain | Zero-cost constraint; running locally is sufficient. **No deployment is claimed.** |
| N10 | Oracles or trading strategies | Out of scope. |

---

## 4. How this is judged

| Item | Detail |
|---|---|
| Form | A standalone git repository: TypeScript indexer + API + dashboard |
| Acceptance | ① `npm install && npm run index && npm run dev` works end to end ② `npm test` passes ③ the dashboard shows real prices and real trades |
| Reviewer model | Written to be self-checked from the perspective of **an engineer skimming the code for 15 minutes** |
| Round | First round: the minimal complete loop |

**First-round deliverables**

1. `src/indexer/` — adaptive chunking, resume, RPC rotation, reorg recovery
2. `src/api/` — REST API (`swaps` / `ohlcv` / `stats` / `health`)
3. a dashboard
4. `test/` — including fixtures built from **real captured data**
5. `README.md` — what it is, architecture, one-command run, methodology, known limitations

> The dashboard is `dashboard/index.html`, a single self-contained file with no
> build step. A React + Vite implementation also exists under `web/`; see the
> README's known limitations for its verification status.

---

## 5. Deviations from this specification

Recorded because a specification nobody updates is worse than none — it makes
the project look like it still matches a plan it has outgrown.

| Original | What shipped | Why |
|---|---|---|
| `better-sqlite3` | **`node:sqlite`** (Node built-in) | The native module needs a compile toolchain. On a machine without one it fails at `npm install`, which puts exactly the barrier in front of a reviewer that N5 was written to avoid. The built-in driver has no install step at all. Cost: a smaller API and an experimental warning on Node 24. |
| React + Vite + Recharts as the dashboard | **A single-file canvas dashboard** is what is served and verified | A zero-build single HTML file means a reviewer opens the URL and sees data. The React version remains in `web/` and is the more conventional choice, but it could not be built in the environment this was written in, so it is **not** the default. |
| Runtime dependencies: 4 | **2** (`fastify`, `viem`) | React/Vite/Recharts are dev-only and are not on the path the API serves. |
| `npm run dev` as the single entry point | `npm run index && npm run api` | The indexer is a one-shot backfill, not a watcher. Making `dev` mean "index then serve" would hide the two distinct steps. |

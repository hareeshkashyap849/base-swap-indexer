# Architecture — base-swap-indexer

How the pieces fit together, the trust boundary, the decisions that would be
expensive to reverse, the maths that everything else depends on, and the
invariants the tests encode.

Written to be checkable: every claim about behaviour here can be verified by
reading the named file or running the named command.

---

## 0. Shape of the system

```
                    ┌──── outside the trust boundary ────┐
                    │  Base mainnet RPC (public)         │  ← the only real external dependency
                    │  · eth_getLogs / getBlockByNumber  │     free, rate-limited, no SLA
                    └───────────┬────────────────────────┘
                                │ ① logs + block headers
                                ▼
   ┌────────────────────────────────────────────────────┐
   │  Indexer  (Node + TypeScript + viem)               │
   │  · adaptive chunking   · RPC rotation              │
   │  · resume from checkpoint   · reorg detection      │
   └───────────┬────────────────────────────────────────┘
               │ ② decode (parseAbiItem + viem) and keep raw fields
               ▼
   ┌────────────────────────────────────────────────────┐
   │  SQLite  (node:sqlite, built in)                   │
   │  swaps / blocks / indexer_state / indexer_log      │
   │  indexes on (block_number, log_index)              │
   └───────────┬────────────────────────────────────────┘
               │ ③ aggregation queries
               ▼
   ┌────────────────────────────────────────────────────┐
   │  API  (Fastify + TypeScript)                       │
   │  /api/swaps  /api/ohlcv  /api/stats  /api/health   │
   └───────────┬────────────────────────────────────────┘
               │ ④ HTTP JSON
               ▼
   ┌────────────────────────────────────────────────────┐
   │  Dashboard  (single file, no build step)           │
   │  headline figures · price/volume charts · trades   │
   └────────────────────────────────────────────────────┘
```

**There is exactly one trust boundary: Indexer → RPC.**
Crossing it means believing the endpoint's data. The endpoint is third-party and
may return stale or incorrect data. The mitigation is that price is derived by
two independent paths (`sqrtPriceX96` and `tick`) and cross-checked — see INV-3.

### 0.1 Components

| Component | Kind | Responsibility | Runs on | Who can change it |
|---|---|---|---|---|
| `Indexer` | local process (CLI) | fetch logs, decode, write, resume, reorg recovery | the user's machine | open source, anyone |
| SQLite file | data store | swaps, block headers, index cursor | local file | the user |
| `API` | local HTTP server | queries and aggregation | the user's machine | open source |
| Dashboard | static page | visualisation | the user's browser | open source |
| **Base RPC** | **external dependency** | supplies chain data | third party | **not under our control** |

The indexer does not import the API, the API does not shell out to the indexer,
and the dashboard talks to the API over HTTP. They share one SQLite file and
nothing else.

---

## 1. Security posture

> This project is a **read-only indexer**. It holds no assets, sends no
> transactions, and has no user accounts, so the usual "who can move the funds"
> question does not have an answer here — and inventing one would be misleading.
> What follows is what *is* true, plus the risks that do exist.

| Question | Answer |
|---|---|
| Where do user funds live? | **Not applicable** — no assets are held, no deposits or withdrawals exist |
| Who can move funds unilaterally? | **Not applicable** — the code contains no signing, no private keys, and no `eth_sendRawTransaction` call |
| Can an admin change balances or pause anything? | **Not applicable** — there is no admin, no upgrade path, and no on-chain contract |
| What data is processed? | **Public** Base mainnet `Swap` events and public block headers |
| Is any personal data collected? | **No** — addresses are pseudonymous public data; no IP logging, no analytics, no tracking |
| Is data sent to third parties? | **No** — the dashboard calls the local API; there is no telemetry and no external script |

**The property worth stating plainly: this project cannot lose anyone's money.**
It calls only read-only RPC methods (`eth_getLogs`, `eth_getBlockByNumber`,
`eth_call`), and there is no key material anywhere in the repository. A reviewer
can clone and run it without any risk of "running it and getting drained".

### 1.1 Single points of failure

| # | Single point | Consequence if it fails | Mitigation | Accepted |
|---|---|---|---|---|
| 1 | **Public RPC endpoint** | indexing stalls; rate limits slow it down | multiple endpoints with rotation and exponential backoff (F7/F3) | yes |
| 2 | RPC returns **wrong or stale data** | prices and aggregates are wrong | dual-path cross-check of `sqrtPriceX96` vs `tick` (INV-3); `blockHash` is stored so rows can be re-checked | yes |
| 3 | Local disk / process | indexing stops | resume from checkpoint (F2); SQLite transactions prevent partial writes | yes |
| 4 | Single data source (one pool) | if the pool migrated, no data | the address is configuration; a different pool is a config change | yes |

**Both real single points are external** (RPC availability and RPC data
integrity), and both have explicit mitigations written into the functional
requirements. Internally there is no server, no database service, no queue, and
no orchestration to fail.

### 1.2 Censorship and exit

- **Who can stop this running?** The RPC provider, by rate limiting or blocking.
  That is the most realistic failure mode and it has already been observed.
  Mitigation is endpoint rotation. The underlying data is permanently public on
  Base, so nothing can be withheld — only access to it can be made slower.
- **How does a user exit?** `Ctrl+C` the process; delete `data/` to remove
  everything. There is no daemon, no service registration, and no auto-start.
- **Is there lock-in?** No. SQLite is a standard file format readable by the
  `sqlite3` CLI, and the schema lives in the repository.

### 1.3 Known gap in the evidence

Reorg recovery is exercised by unit-level reasoning about stored hashes, not by
observing a real chain reorganisation. Detection walks back at most 64 blocks; a
deeper reorg is reported rather than auto-recovered, because the code refuses to
delete data on a guess. **This is a genuine gap, not a covered case.**

---

## 2. Decisions that would be expensive to reverse

Each row records what was chosen, what was rejected, and why — so a later reader
can tell a deliberate choice from an accident.

| Decision | Chosen | Rejected | Why rejected |
|---|---|---|---|
| **Index target** | Uniswap V3 WETH/USDC 0.05% pool on Base | ① USDC `Transfer` ② Morpho ③ Aerodrome | ① too generic, no analytical meaning (transfers only) ②③ **measured: the RPC rejects the range**; Morpho's events are too sparse to be useful. The chosen pool has 936 swaps / 500 blocks and carries price fields. |
| **Language** | **TypeScript** | JavaScript | The target skill set is TypeScript, and types are the first line of defence for decode correctness. |
| **Chain library** | **viem** | ethers.js | Stricter type inference and `parseAbi`. Measured working against real logs. |
| **Storage** | **SQLite via `node:sqlite`** | ① `better-sqlite3` ② Postgres ③ in-memory then flush | ① needs a native compile toolchain — it puts a barrier in front of a reviewer ② requires the reviewer to run a service ③ cannot resume after a crash. See the deviation note in `REQUIREMENTS.md` §5. |
| **Raw int256 kept as strings** | `amount0` / `amount1` / `sqrtPriceX96` / `liquidity` stored as decimal strings end to end | store as INTEGER / REAL | These values overflow both a JS `number` and a SQLite `INTEGER`. Converting early would silently lose precision in exactly the values the whole analysis depends on. |
| **No ORM** | hand-written parameterised SQL | Prisma / Drizzle | The interesting part of an indexer is query and index design; an ORM hides it. Hand-written SQL is also the skill being demonstrated. |
| **Store decoded columns, not raw log JSON** | structured columns | store raw `log` and parse later | Columns can be aggregated directly in SQL and indexed. Cost: a schema change needs a migration — acceptable because the event shape is fixed. |
| **Store raw price fields, convert at query time** | raw fields + derivation on read | precompute price at insert | If the conversion formula turns out to be wrong, the raw data is still there to recompute. Avoids freezing an error into the database. |
| **Polling, not WebSocket** | polling | WebSocket | Dashboard refresh is seconds-scale; push would add reconnection complexity for no visible gain. |
| **API framework** | **Fastify** | Express / Hono | Built-in schema validation, which is exactly what F12 needs (bad input → 4xx, never 500). |
| **Front end** | **single-file zero-build dashboard** | Next.js | The dashboard is a purely client-side view; SSR and routing buy nothing here. A file the reviewer can open is worth more than a build pipeline. |
| **Tests** | **built-in `node --test`** | Jest / Vitest | Node 24's runner is sufficient and removes a dependency. `npm test` works with no configuration. |
| **Reorg strategy** | store `blockHash`, roll back and re-index on mismatch | ① ignore reorgs ② only index blocks older than a confirmation depth | ① ignoring is simply wrong — the data stays incorrect forever ② waiting that long adds significant lag. Rollback is the correct, implementable middle. |

### 2.1 Why not a subgraph or an indexing framework?

| Option | Why not |
|---|---|
| The Graph hosted subgraph | ① requires deploying to a hosted service, adding an account and a quota ② **it outsources the indexing itself**, which is the capability this project exists to demonstrate |
| Ponder | A good framework, but ① it encapsulates chunking, reorg handling and resume, so a reviewer cannot see how those problems were solved ② hand-writing them is the point |

> This is an explicit trade-off: a hand-written indexer is **slower to build and
> easier to get wrong**. It was chosen because it makes the engineering visible.
> The README says so, so the choice reads as deliberate rather than naive.

---

## 3. Standards and interfaces

| Item | Content | Status | Checked |
|---|---|---|---|
| Uniswap V3 `Swap` event | `Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)` | decoded from chain (10,176 rows) | against the chain |
| Uniswap V3 `slot0` | `(uint160 sqrtPriceX96, int24 tick, ...)` | read from chain | against the chain |
| ERC-20 `decimals` / `symbol` | used for price scaling | read from chain (WETH 18, USDC 6) | against the chain |
| REST / JSON | the API contract | — | — |
| **Not applicable** | ERC-4626, EIP-1967, EIP-712, any on-chain contract standard | — | this project deploys no contract |

> No contract is deployed here, so no contract standard applies. On-chain
> contract work lives in the separate ERC-4626 vault project.

---

## 4. Price derivation (the core maths)

Everything the dashboard shows depends on this section being right.

### 4.1 From `sqrtPriceX96`

Uniswap V3 defines:

```
sqrtPriceX96 = sqrt(price) × 2^96
where price = amount of token1 / amount of token0      (both in smallest units)
```

Therefore:

```
rawPrice      = (sqrtPriceX96 / 2^96)²                    // token1 units per token0 unit
priceAdjusted = rawPrice × 10^(decimals0 - decimals1)     // human-unit ratio
```

With the measured values (`decimals0 = 18` WETH, `decimals1 = 6` USDC):

```
priceAdjusted = rawPrice × 10^(18 - 6) = rawPrice × 10^12
              = token1 amount / token0 amount = USDC / WETH
              = the price of WETH in USDC      ✅
```

Measured: `rawPrice = 2.44349691e-9` → × 10¹² = `2443.50` → **WETH ≈ $2,443.5**.

> ⚠️ **The direction trap.** Assuming `token0` was USDC would have produced the
> reciprocal, `0.000409`, and every price on the dashboard would have been wrong
> while still looking plausible. Two defences:
> 1. `token0` / `token1` are **read from the chain**, never assumed;
> 2. the direction is backed by the INV-3 cross-check.

### 4.2 Volume

`Swap`'s `amount0` / `amount1` are `int256` and **signed**:

| Field | Sign | Meaning |
|---|---|---|
| `amount0 > 0` | the pool **received** WETH | the user sold WETH |
| `amount0 < 0` | the pool **paid out** WETH | the user bought WETH |
| `amount1` | always the **opposite** sign to `amount0` | the USDC side |

Volume is quoted in USDC: `volumeUsdc = |amount1| / 10^6`.
Direction is decided by the sign of `amount0`.

### 4.3 From `tick` (independent path, used for cross-checking)

```
priceFromTick = 1.0001^tick × 10^(decimals0 - decimals1)
```

Measured: `tick = -198309` → `1.0001^-198309 × 10^12 = 2443.32`, against
`2443.50` from the `sqrtPriceX96` path — a difference explained by `tick` being a
discrete logarithm approximation of the price.

That agreement is asserted as INV-3: `|ln(rawPrice / 1.0001^tick)| < 0.001`.

---

## 5. Invariants the tests encode

> "The tests pass" is not evidence. "These specific invariants hold" is.

### INV-1 — Idempotency
> Re-indexing the same block range leaves the `swaps` table unchanged in both row
> count and content.

Test: index twice, compare `COUNT(*)` and a hash of key fields.
**Why it matters:** resuming and retrying are normal operation for an indexer. A
non-idempotent one produces duplicate trades and doubles every aggregate.

### INV-2 — Chunk coverage is exact
> Adaptive chunking never skips a block and never processes one twice.

Test: inject a failing range and assert the final set of covered blocks is
exactly the requested interval.
**Why it matters:** chunking is where indexers break, and **a skipped range is a
silent error** — the data looks fine and is quietly missing a section.

### INV-3 — Price agrees across two independent paths
> For every swap, the price derived from `sqrtPriceX96` and the price derived
> from `tick` agree (log difference < 0.001).

Test: assert over every stored swap; the count of disagreements must be zero.
**Why it matters:** it catches a wrong token-order assumption, catches an RPC
returning bad data, and is executable evidence that the protocol is understood.

### INV-4 — Data is self-consistent after a reorg
> After a detected reorg and rollback, no rows remain that came from discarded
> blocks.

Test: inject a `blockHash` mismatch and assert the affected blocks and everything
after them are removed and re-indexed.
**Why it matters:** this is the most commonly ignored correctness problem in
indexers, and handling it is a signal of experience.

### INV-5 — Aggregates match the detail
> `/api/stats`' `trades` equals the number of `swaps` rows in the window, and
> `volumeUsdc` equals the sum of `|amount1|` over those rows.

Test: recompute with independent SQL and compare against the API response.
**Why it matters:** it catches mistakes in the aggregation SQL's `WHERE` and
`GROUP BY` — bugs that make the headline numbers disagree with the table below
them.

### INV-6 — Sign convention
> Every swap satisfies `sign(amount0) = -sign(amount1)`.

Test: assert across all rows.
**Why it matters:** it directly validates the direction logic in §4.3; reversed,
it would flip every buy/sell label.

---

## 6. Failure modes

| # | Scenario | Trigger | System behaviour | Impact | Plan |
|---|---|---|---|---|---|
| 1 | RPC rate limiting | concurrency or high frequency | rotate endpoint + exponential backoff | slower, not stopped | F7; **observed in practice** |
| 2 | Response too large | too many logs in one range (>10 MB) | catch, **halve** the range, retry | that span is slower, nothing lost | F4; **observed in practice** |
| 3 | `getLogs` range rejected | range too wide | shrink the range; after repeated failures raise an explicit error | never silently skipped | F3 |
| 4 | Process interrupted | Ctrl+C / crash | committed transactions survive; a re-run resumes from `lastIndexedBlock` | none | F2; SQLite transactions |
| 5 | Chain reorganisation | Base produces blocks fast, short reorgs happen | detect hash mismatch → roll back, re-index, warn | brief rollback | F6 + INV-4 |
| 6 | RPC returns bad data | faulty or malicious endpoint | INV-3 cross-check fails → surfaced | detectable | INV-3 |
| 7 | Partial database write | disk full / killed mid-write | transaction rolls back; no half-written state | none | all writes are transactional |
| 8 | Chain congestion | Base congestion | slower reads, higher latency | time only | none needed (read-only) |
| 9 | Pool address retired | protocol upgrade | no new data | project stale | address is configuration |
| 10 | API not running | user only started the dashboard | dashboard shows an explicit error | diagnosable | error state in the UI |

---

## 7. Anti-over-engineering check

**Three services** (indexer / API / dashboard) because their lifecycles and
failure modes genuinely differ: the indexer is batch-plus-long-running, the API
is request/response, the dashboard is static assets. Merging them would cost
testability.

**Abstractions deliberately removed:**

- ❌ a multi-chain adapter — one chain is in scope (N2)
- ❌ a multi-protocol adapter — one pool is in scope (N1)
- ❌ an ORM — hand-written SQL (§2)
- ❌ Redis or a cache layer — ~18k rows, SQLite answers directly
- ❌ a WebSocket layer — polling is enough (§2)
- ❌ Docker / compose — deliberately lowers the barrier (N5)

**Reuse over invention:**

- `viem` handles RPC, ABI items, big integers and decimals — not written here
- `node:sqlite` handles storage and transactions — not written here
- `fastify` handles HTTP and schema validation — not written here
- **The only hand-written core logic**: adaptive chunking, reorg rollback, price
  conversion, aggregation SQL. **Those four are exactly what the project exists
  to demonstrate.**

**Dependency count:** 2 runtime dependencies (`fastify`, `viem`). No ORM, no test
framework, no container.

> The reverse test: a project with fifteen modules, a multi-chain abstraction and
> container orchestration is the problem — it shows the author cannot tell
> "demonstrating capability" from "accumulating technology".

---

## 8. Where this specification is known to be incomplete

- **No reorg has been observed on a live chain.** Recovery is verified by
  reasoning about stored hashes, not by catching a real reorg. §1.3.
- **The React dashboard under `web/` is unbuilt.** It typechecks; its production
  build was never produced in the environment this was written in. The static
  dashboard is what is served and what was verified.
- **`node:sqlite` is experimental** on Node 24. `Store` in `src/lib/db.ts` is the
  only place the driver is touched, so replacing it is contained.
- **Public RPC endpoints have no SLA.** Correctness is defended by validation and
  cross-checks; it is not guaranteed by the provider.

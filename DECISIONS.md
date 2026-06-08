# DECISIONS.md

## What I Composed vs. What I Wrote

**Composed (off-the-shelf):**

- **viem** (`getLogs`, `getBlock`, `getBlockNumber`, `getCode`) — all chain interaction. Zero custom RPC code.
- **Zama SDK v3.1.0-alpha.5** — `ZamaSDK`, `sdk.decryption.userDecrypt()`, `createConfig` (viem flavour), `node()` relayer.
- **Drizzle ORM + better-sqlite3** — schema definition, typed queries, auto-migrations, foreign keys with CASCADE.
- **Nest.js** — API framework for `/transfers`, `/health`.

**Wrote myself:**

- Polling loop with reorg detection (`src/indexer/poll.ts`, ~310 lines). Explicit `getLogs` for 3 event types (ConfidentialTransfer, Wrap, UnwrapFinalized), chunked catch-up, rate-limit retry (HTTP 429 + JSON-RPC -32005), hash checkpoint comparison.
- Decrypt worker (`src/worker/worker.ts`, ~130 lines). Backoff-aware queue drain, parallel decrypt via `Promise.allSettled`, three-outcome handling per job, comprehensive logging.
- Sweep (`src/worker/sweep.ts`, ~40 lines). SQL query for orphaned pending transfers, re-enqueue.
- Decrypt queue CRUD (`src/db/queue.ts`, ~115 lines). Backoff timing, lock-based concurrency control, orphan detection query.
- Env config layer (`src/index.ts`). Single `readEnv()` → typed `Env` object, passed to all modules.

The core insight: **a custom polling loop + queue is ~500 lines but avoids framework impedance mismatch.** Ponder/Envio would each bring their own DB, schema management, and lifecycle. Decoupling 5-15s Gateway decryption from block ingestion is the critical architectural decision, and a bespoke loop makes that trivial rather than fighting a framework's threading model.

---

## Trade-offs

### 1. Custom polling loop vs. indexing framework (Ponder/Envio)

**Chose:** custom viem polling.
**Why:** The Gateway decryption latency (5-15s per handle) creates an impedance mismatch. Indexing frameworks typically assume synchronous block processing — you ingest a block, transform it, done. Decryption is async and slow. A framework would force either dual-database joins (indexer's Postgres + our SQLite) or complex threading to keep the framework's ingestion pipeline from stalling. A custom loop lets us insert rows immediately and drain the queue at our own pace.

**Cost:** We lose framework features like GraphQL auto-generation, built-in reorg handling, and managed migrations. The reorg detection we wrote is 20 lines and the 5-block assumption is documented.

### 2. SQLite vs. Postgres

**Chose:** SQLite (better-sqlite3 + Drizzle).
**Why:** Zero ops — no `docker-compose`, no connection pooling, no credentials. Reviewer clones the repo and runs `pnpm dev`. For a single-process indexer with read-heavy API traffic (no concurrent writes), SQLite is more than sufficient. WAL mode handles concurrent reads during writes.

**Cost:** No horizontal scaling, no replication. If the partner needs 10+ API instances, each would need its own DB copy (or switch to Postgres later). This is a config change, not a schema change — Drizzle abstracts the dialect.

### 3. Queue model: same-process vs. separate worker process

**Chose:** same-process `setTimeout` loop.
**Why:** The worker yields the event loop (async/await), so API requests interleave with decryption. Separate process adds deployment complexity, IPC, and a second DB connection to manage. At this scope, the overhead isn't worth it.

**Cost:** If the worker crashes (unhandled exception in SDK), it takes down the API. The `try/catch` in `tick()` and `poll()` mitigate this — both loops catch errors and continue.

### 4. Reorg detection via hash checkpoint vs. block history

**Chose:** single hash checkpoint, 5-block rollback.
**Why:** Sepolia testnet reorgs are shallow (1-2 blocks). Storing a rolling window of block hashes would be more robust but adds complexity. The hash checkpoint is stored after each successful index cycle — if it mismatches on the next poll, we roll back 5 blocks and re-index. CASCADE on the FK handles queue cleanup.

**Cost:** A reorg deeper than 5 blocks would be missed. For testnet, this is acceptable. For mainnet L1 (post-Merge, ~6s block times), 12 blocks (2 minutes) is more realistic. This is a documented assumption.

### 5. ACL detection: periodic sweep + manual retry vs. event watching

**Chose:** 10-minute sweep on `pending` orphans + manual `POST /api/v1/admin/retry-no-rights` endpoint.
**Why:** Watching `DelegationGranted` events on the ACL contract adds complexity (another contract to monitor, another ABI, more state) for a feature that fires rarely. The sweep catches reorg orphans and missed enqueues. The manual endpoint lets the partner trigger bulk retry exactly when they grant new delegations — no wasteful automatic retries on transfers the indexer will never have rights for. The partner knows when delegation happens; the indexer doesn't need to guess.

**Cost:** The partner must call the endpoint after granting delegation. Up to 10 minutes of staleness for orphan recovery from reorgs.

### 6. Shield/Unshield handling

**Chose:** parse all three event types, store Shield/Unshield with `decrypt_status = 'plain'` and cleartext amounts.
**Why:** Shield (mint) and Unshield (burn) events carry cleartext amounts. They affect balances just as much as ConfidentialTransfer. The ERC-7984 contract emits all three, and a wallet partner needs all three to compute correct balances.

### 7. Blind decrypt of all transfers

**Chose:** enqueue every `ConfidentialTransfer` for decryption regardless of whether the indexer has rights.
**Why:** It's the simplest model — no address tracking, no pre-flight checks. The worker tries everything, marks `no_rights` on failure (1 attempt per `DelegationNotFoundError`), and the admin endpoint handles recovery.
**Cost:** Every unrelated transfer wastes 1 Gateway decrypt call. For a contract with thousands of users and a wallet partner serving dozens, 95%+ of decrypt attempts fail permanently. This scales poorly.
**Better options (not implemented):** (1) **Address whitelist** — maintain a set of known wallet users, only enqueue their transfers. (2) **Pre-flight delegation check** via `sdk.delegations.isActive()` before enqueuing — trades blockchain RPC calls for Gateway calls. (3) **User-driven pull** — decrypt on-demand in the API rather than in the background worker.

### 8. Start block: mandatory env var vs. auto-detection

**Chose:** mandatory `START_BLOCK` env var, no binary search.
**Why:** The chunked binary search with `eth_getLogs` was correct but impractical — Sepolia at 11M blocks required ~200+ RPC calls just to find the contract deployment block. On free RPCs with aggressive rate limits, this could hang for minutes. The deploy block is known and setting it in `.env` is trivial. `resolveContractCreationBlock` and `hasEventInRange` were removed entirely.
**Cost:** Cannot start from a fresh DB without `START_BLOCK`. The process exits on startup if it's missing or invalid.

## Pushback on the Brief

### 1. The "indexing library" suggestion

The task says "Use an existing indexing library to track the events." For this specific use case (confidential tokens with slow async decryption), I believe a custom loop is the right call. Indexing frameworks assume synchronous block processing. Adding async Gateway calls into an Envio/Ponder handler would either block the pipeline or require writing a queue anyway — at which point the framework adds complexity without benefit.

### 2. "Auto-decrypts all transfer amounts the indexer holder has decryption rights on"

The current implementation decrypts amounts as a background worker, not inline during indexing. This is deliberate: inline decryption would couple block ingestion speed to Gateway latency (5-15s per handle), making catch-up on a Sepolia full history (~3M blocks) take months. The queue model means indexing finishes in hours and decryption catches up independently.

### 3. Sepolia-only scope

The task says "Sepolia testnet or local fhEVM." I chose Sepolia only. Supporting local fhEVM would require a second chain config, different relayer URL, and different contract addresses — all for a setup the partner likely doesn't use. The chain config is isolated in `sdk.ts` and `poll.ts`; adding mainnet or local would be a config change, not an architecture change.

---

## What Would Break First Under Partner Load

**The decrypt queue under many concurrent pending transfers (>1000).**

Current `dequeueBatch` selects candidates (limit × 3 = 15), filters by backoff readiness client-side, then locks them with `UPDATE SET locked_at`. Two issues:

1. **Linear backoff scan**: As the queue grows, scanning 15 candidates to find 5 ready jobs is fast, but if many jobs are in backoff, we repeatedly scan the same blocked jobs. A `WHERE` clause that skips jobs within their backoff window would be more efficient but requires computing the backoff in SQL (the `getBackoffMs` function would need to become a SQL expression).

2. **Lock contention at scale**: `locked_at` prevents dual processing but relies on single-writer SQLite. If the worker is slow (Gateway latency spikes to 30s), a second instance would see locked jobs and spin. Fine for one process; would need advisory locks or a different queue backend for multi-process.

**How I'd prove it:** Insert 1000 pending queue rows with varied backoff states, run the worker in a tight loop, and measure: (a) time to dequeue 5 jobs as queue grows, (b) CPU on `dequeueBatch` calls when most jobs are in backoff, (c) behavior when Gateway latency doubles.

---

## SDK Feedback

### 1. Missing API: batch decrypt with partial failure

**Current:** `sdk.decryption.userDecrypt(inputs)` returns `Record<hex, bigint>` on success or throws on the first failure. If one of 5 handles fails with `DelegationNotFoundError`, all 5 fail.

**Suggestion:** A batch-decrypt variant that returns per-handle results with per-handle errors: `Promise<{ success: Record<hex, bigint>; failures: Record<hex, Error> }>`. This would let the worker process 5 handles in one SDK call and individually handle `DelegationNotFoundError` (→ `no_rights`), `DelegationNotPropagatedError` (→ longer backoff), and network errors (→ standard backoff).

**Priority:** High. The current workaround (5 separate calls via `Promise.allSettled`) works but is chatty and doesn't leverage the SDK's internal batching.

### 2. Confusing naming: `DelegationNotPropagatedError` vs. `DelegationNotFoundError`

**Current:** Two error classes that sound similar but have opposite retry semantics — one is permanent, one is temporary.

**Suggestion:** Rename to `DelegationNotFoundError` (permanent — no rights) and `DelegationPropagationPendingError` (transient — Gateway hasn't synced). Alternatively, add a `.retriable` boolean property to all SDK errors so callers don't need to `instanceof`-check specific classes.

**Priority:** Medium. Once you know the difference it's fine, but the first encounter is confusing — both sound like "you don't have rights."

### 3. Doc gap: `EncryptedInput` shape and handle source

**Current:** The SDK docs/examples show `sdk.decryption.userDecrypt()` with handles from `confidentialBalanceOf()` and `confidentialTransfer()` (SDK methods that return encrypted values). But the indexer gets handles from raw `eth_getLogs` — the bytes32 from `ConfidentialTransfer` events. The question "can I pass event-derived handles to `userDecrypt`?" is not explicitly answered in docs.

**Suggestion:** Add a section to the SDK docs titled "Decrypting event logs" that shows: (a) fetching `ConfidentialTransfer` events via viem/ethers, (b) passing `log.args.encryptedAmount` directly to `userDecrypt()`, (c) the expected return shape. This is the primary integration pattern for indexers, bridges, and wallets.

**Priority:** High. Every indexer/watcher in the ecosystem will hit this.

---

## AI Assistance

This project was built with DeepSeek V4 Pro (via opencode zen) and Big Pickle (free opencode model). The process:

- The AI wrote all code files, tests, and documentation based on the spec in `docs/spec.md` and the task description.
- I provided direction on scope, conventions (no comments, env var pattern, existing code style), and corrections for specific issues.
- The AI handled the full implementation: schema changes, poller rewrite, worker, sweep, queue CRUD, tests, migration, and documentation.

### Places the AI Got It Wrong

1. **`Promise.allSettled` indexed access in TypeScript 6.0.3**: The AI wrote `results[i].status` without a null guard. TS 6's strict indexed access types `results[i]` as `T | undefined`. Required adding `if (!job || !result) continue` before the discriminant. This came up twice — once in the worker and once the AI tried to "fix" it incorrectly before I pointed out the actual TS version.

2. **`vi.mock` hoisting with module-level variables**: The AI defined `class DelegationNotFoundError` at module scope and referenced it in a `vi.mock()` factory. The factory is hoisted above the class definition, causing `Cannot access before initialization`. The fix was `vi.hoisted()` — the AI initially tried `async importOriginal()` which also failed.

3. **`sqliteTable` deprecation ignored**: The AI used the old callback-returning-object syntax `(t) => ({ idx: ... })` instead of the new array syntax `(t) => [ ... ]`. I caught this and asked for the fix.

4. **Env vars read inside modules**: The AI's initial implementation had `initSdk()` and `resolveStartBlock()` reading `process.env` directly. I asked for a restructure to read once in `index.ts` and pass values as parameters.

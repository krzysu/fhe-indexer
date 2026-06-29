# DECISIONS.md

## What I Composed vs. What I Wrote

**Composed (off-the-shelf):** viem, Zama SDK v3.1.0-alpha.5, Drizzle ORM + better-sqlite3, Nest.js.

**Wrote myself:** polling loop with reorg detection (~400 lines), decrypt worker (~160 lines), sweep (~40 lines), queue CRUD (~120 lines), env config layer, balance tracking (~110 lines).

**Core insight:** a ~700-line custom loop + queue avoids the framework impedance mismatch. Ponder/Envio handlers run sequentially in original order and (for Envio) twice via Preload Optimization; a 5–15s Gateway call per event would multiply into 10–30s of ingestion pause per log, and decryption results are external state the framework DB can't roll back on reorg. A bespoke loop stores events immediately and drains the queue in a separate process.

---

## Trade-offs

**1. Custom polling vs. indexing framework (Ponder/Envio).** Chose custom viem polling. Both support async handlers, but three architectural choices make them a poor fit for FHE decryption:

- **In-order processing** — events are processed sequentially in original order (deterministic state derivation). A slow handler blocks every subsequent event.
- **Envio Preload Optimization** — every handler runs twice by default, so a 5–15s call becomes 10–30s per log.
- **Reorg rollback scope** — frameworks roll back their own DB; decryption results are external state. Storing them in the framework DB breaks reorg safety; storing them outside creates a dual-DB sync problem. Envio's Effect API cache explicitly doesn't support reorg rollbacks yet.

Cost: no auto-generated GraphQL, no built-in reorg handling (our 20-line hash checkpoint covers it). See Pushback §1.

**2. SQLite vs. Postgres.** Zero ops — clone and `pnpm dev`. WAL mode handles concurrent reads. Cost: no horizontal scaling. Drizzle abstracts the dialect, so switching is a config change.

**3. Same-process worker vs. separate process.** The async worker loop yields the event loop, so API requests interleave. Separate process adds IPC and a second DB connection without benefit at this scope. Cost: an unhandled worker exception takes down the API — `try/catch` in both loops mitigates this.

**4. Hash checkpoint reorg detection vs. block history.** Single hash, 5-block rollback. Sepolia reorgs are shallow. CASCADE on FK handles queue cleanup. Cost: reorgs deeper than 5 blocks are missed; acceptable for testnet.

**5. ACL detection: periodic sweep + manual retry vs. event watching.** Watching `DelegationGranted` adds another contract to monitor for a feature that fires rarely. The 10-minute sweep catches orphans; the manual `/admin/retry-no-rights` endpoint lets the partner trigger retry exactly when they grant rights. Cost: up to 10m staleness for orphan recovery.

**6. Shield/Unshield handling.** Parse all three event types. Shield/Unshield carry cleartext amounts and affect balances — a wallet partner needs all three for correct balance computation.

**7. Blind decrypt of all transfers.** Enqueue every `ConfidentialTransfer`. Simplest model — no address tracking, no pre-flight checks. Cost: ~95% of Gateway calls fail with `DelegationNotFoundError` on contracts with broad usage. Better options (not implemented): address whitelist, pre-flight delegation check, user-driven pull.

**8. Mandatory `START_BLOCK` vs. auto-detection.** Binary search with `eth_getLogs` required ~200+ RPC calls on Sepolia and could hang on free RPCs. The deploy block is known. Cost: fresh DB without `START_BLOCK` = process exit.

---

## Pushback on the Brief

**1. "Use an existing indexing library."** A custom loop is the right call here. Ponder/Envio process events in-order (sequential by design), Envio runs every handler twice via Preload Optimization, and decryption results are external state that the framework DB can't roll back on reorg. Awaiting a 5–15s `delegatedDecrypt` per event inside a handler stalls the pipeline and creates a dual-DB problem. Adding an internal queue just pushes the bottleneck one layer down without buying anything.

**2. "Auto-decrypts all transfer amounts."** Decryption is a background worker, not inline. Inline decryption would couple ingestion speed to Gateway latency, making catch-up on Sepolia's ~3M blocks take months. The queue model decouples them.

**3. "Sepolia or local fhEVM."** Sepolia only. Local fhEVM needs a second chain config, different relayer, and different addresses — all for a setup the partner won't use. Adding it would be a config change, not an architecture change.

---

## What Would Break First Under Partner Load

**The decrypt queue under >1000 pending transfers.** Current `dequeueBatch` selects 15 candidates, filters by backoff readiness client-side, then locks 5 with `UPDATE`. Two issues:

1. **Linear backoff scan** — repeatedly scanning the same blocked jobs as the queue grows. Fix: push backoff logic into the SQL `WHERE` clause.
2. **Lock contention** — `locked_at` works for single-process but a second instance sees locked jobs and spins. Fix: advisory locks or a different queue backend.

**How I'd prove it:** Insert 1000 pending queue rows with varied backoff states, run the worker tightly, and measure dequeue time, CPU, and behavior under Gateway latency spikes.

---

## What I Cut / What I'd Do With 4 More Hours

1. **Consistent API error shape** (§4.6 in spec). A Nest.js exception filter returning `{ error: { code, message, details } }`. Lower priority — the API is consumed by the partner's backend, not end-users.
2. **Address whitelist for decrypt filtering.** Only enqueue transfers involving known wallet-user addresses. Eliminates ~95% of wasted Gateway calls. Highest-leverage perf improvement.
3. **ACL event watching.** Watch `DelegationGranted` on the ACL contract for sub-second reaction to new delegations. Cut because monitoring a second contract adds complexity disproportionate to the benefit for testnet.
4. **GraphQL endpoint.** Nice-to-have for partner flexibility; REST covers the required queries.
5. **`/metrics` endpoint.** Queue depth, last indexed block age, decrypt success rate. 20-line addition with `prom-client`.

---

## SDK Feedback

**1. Missing API: batch decrypt with partial failure.** `userDecrypt(inputs)` throws on the first failure — if one of 5 handles fails, all fail. Suggestion: `Promise<{ success: Record<hex, bigint>; failures: Record<hex, Error> }>` for per-handle error handling. **Priority: High.** Current workaround (5 separate `delegatedDecrypt` calls via `Promise.allSettled`) is chatty and doesn't leverage SDK batching.

**2. Confusing naming: `DelegationNotPropagatedError` vs `DelegationNotFoundError`.** Both sound like "you don't have rights" but have opposite retry semantics (permanent vs transient). Suggestion: rename to `DelegationPropagationPendingError` or add a `.retriable` boolean to SDK errors. **Priority: Medium.**

**3. Doc gap: event-derived handles.** SDK examples show `userDecrypt` with handles from `confidentialBalanceOf()`. The question "can I pass event-log handles?" is not explicitly answered. Suggestion: a "Decrypting event logs" section showing passing `log.args.encryptedAmount` directly to `userDecrypt`. **Priority: High.** Every indexer/bridge/wallet hits this.

---

## AI Assistance

This project was built with opencode as a harness using several models from the opencode zen provider, including DeepSeek V4 Pro and Flash, Big Pickle (free opencode model), and Qwen 3.7. The process:

- Brainstorm with AI about solutions for the task
- Prepare specification
- Research implementation details and iterate on spec
- Scaffold the project
- Define stages for implementation
- Ask AI to implement each stage
- Test manually, review the code, iterate on individual solutions per file
- Run e2e manual tests, iterate on issues found
- Continue to the next stage
- Between stages, ask AI to write tests, update the spec, and record decisions and lessons learned
- At each checkpoint (stage completed), use AI to review the written code

### Places the AI Got It Wrong

1. **`Promise.allSettled` indexed access in TS 6.0.3:** Wrote `results[i].status` without a null guard. TS 6 types `results[i]` as `T | undefined`. Fix: added `if (!job || !result) continue` before the discriminant.
2. **`vi.mock` hoisting:** Defined error classes at module scope and referenced them in `vi.mock()`. The factory is hoisted above the class definition, causing `Cannot access before initialization`. Fix: `vi.hoisted()`.
3. **`sqliteTable` deprecated syntax:** Used old callback-returning-object syntax `(t) => ({ idx: ... })` instead of new array syntax `(t) => [ ... ]`.
4. **Env vars read inside modules:** `initSdk()` and `resolveStartBlock()` read `process.env` directly. Fix: single `readEnv()` at entry point, typed `Env` object passed down.

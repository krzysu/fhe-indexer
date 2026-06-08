# Lessons Learned

## Public RPC Rate Limits

- Publicnode.com has aggressive rate limits (~1 req/s for `eth_getLogs` on free tier).
- Chunking into 50k-block ranges isn't enough — you also need:
  - Serial (not concurrent) poll cycles — use `setTimeout` + guard flag, not `setInterval`.
  - 2s+ delay between chunks during initial catch-up.
  - Exponential backoff for rate-limit errors (code `-32005`).
- **Fix**: Use a personal RPC key (Alchemy/Infura) for production. Public RPCs are OK for testing after catch-up.

## Viem Batching

- `http(..., { batch: true })` enables transport-level batching of concurrent requests.
- Combine with `Promise.all` for parallel `getBlock` calls — viem batches them into a single HTTP request.
- `Map` for bigint-keyed lookups (`Object.fromEntries` doesn't support bigint keys).

## ESM + Nest.js

- `"module": "NodeNext"` and `"moduleResolution": "NodeNext"` require `.js` extensions in all local imports.
- `experimentalDecorators: true` is required for Nest.js decorators.

## Drizzle Migration Conflicts

- `drizzle-kit generate` produces `CREATE TABLE` statements. If the tables already exist (from a previous raw SQL bootstrap), `migrate()` fails with `SQLITE_ERROR: table already exists`.
- **Fix**: Delete the old DB (`rm -rf data/`) after switching from raw SQL to Drizzle migrations, or use a fresh project clone.
- Better to adopt Drizzle migrations from the start rather than mixing raw DDL + Drizzle queries.

## Drizzle ORM `sqliteTable` API Change (v0.45)

- The third parameter (extra config callback) changed return type from an object to an array.
- Old: `(t) => ({ idx: uniqueIndex("name").on(t.col) })`
- New: `(t) => [ uniqueIndex("name").on(t.col) ]`
- The old form is deprecated and shows a TS warning.

## Vitest `vi.mock` Hoisting

- `vi.mock()` factory is hoisted to the top of the file. Any variable it references must be defined inside `vi.hoisted()` or the mock will fail with `Cannot access before initialization`.
- This is especially relevant when mocking SDK error classes that need to be used in both the mock definition and the test assertions.

## TypeScript 6 Strict Indexed Access + `Promise.allSettled`

- With strict indexed access, `Promise.allSettled` results at index `i` have type `PromiseSettledResult<T> | undefined`.
- Must explicitly guard `if (!job || !result) continue` before narrowing on `result.status`, otherwise TypeScript rejects the discriminant check.
- TS 6 is stricter than TS 5 on this — previonsly `results[i]` was always defined.

## Env Var Pattern: Read Once, Pass Down

- Avoid reading `process.env` inside library/module code. Read all env vars in a single `readEnv()` function at the entry point and pass the typed `Env` object to functions that need values.
- This makes testing easier (no `process.env` manipulation) and keeps env concerns in one place.
- `initSdk(rpcUrl, privateKey)` is cleaner than `initSdk()` + side-reading `process.env`.

## Reorg Detection via Hash Checkpoint

- Store block hash at each index cycle's safe head, compare against chain on next poll.
- On mismatch: roll back `CONFIRMATION_DEPTH` blocks, delete transfers + queue (CASCADE), reset checkpoint, retry next cycle.
- Simpler than storing recent block hashes and works fine for Sepolia (shallow reorgs).
- Must also persist `start_block` so rollback never goes below the contract's first event.

## Zama SDK: What Worked Well

- `sdk.decryption.userDecrypt([{ encryptedValue, contractAddress }])` accepts event-derived handles directly.
- `MemoryStorage` avoids filesystem state for a testnet indexer.
- Viem-flavoured `createConfig` composes cleanly with existing viem clients.
- `DelegationNotFoundError` is catchable and distinguishable from transient failures.

## DelegationNotPropagatedError Needs Longer Backoff

- Gateway propagation takes 1–2 minutes after a delegation is granted.
- The standard exponential backoff (10s→30s→90s) can exhaust all 3 attempts before propagation completes.
- A dedicated handler with a 60-second first-retry delay would avoid this. Currently treated as a generic transient error.

## Start Block Resolution: Chunked Binary Search with `eth_getLogs`

The indexer must find the first block where the ERC-7984 contract emitted a `ConfidentialTransfer` event — this is the starting point for indexing.

**Algorithm:** binary search (O(log n)) with `hasEventInRange(low, mid)` that internally chunks into 50K-block `getLogs` calls. Each binary search step scans [low, mid] in 50K increments and returns `true` on the first chunk with events.

**Why `eth_getLogs` and not `eth_getCode`:**
- `eth_getLogs` queries log bloom indexes — available for any block on free RPCs.
- `eth_getCode` requires historical state which free RPCs prune (`historical state not available`).
- The 50K block range limit per `eth_getLogs` call is handled by `hasEventInRange`'s internal chunking.

**Trade-off:** ~200 `getLogs` calls for a 10M-block chain (vs ~24 for pure binary search without the range limit). This is a one-time cost at first startup; subsequent runs use the persisted `start_block`. Users can skip auto-detection entirely by setting `START_BLOCK` in `.env`.

## Wasted Decrypt Calls for Non-Wallet Transfers

Most `ConfidentialTransfer` events on the contract won't involve the wallet partner's users. The indexer currently enqueues every transfer and tries to decrypt all of them — each failing with `DelegationNotFoundError` (1 wasted Gateway call per unrelated transfer).

**Better options (not implemented):**

1. **Address whitelist** — maintain a set of known wallet user addresses. Only enqueue decrypt jobs for transfers involving those addresses. Everything else gets `decrypt_status = 'no_rights'` (no queue entry, no decrypt attempt). The admin endpoint covers recovery when users are added later.

2. **Pre-flight delegation check** — before enqueuing, call `sdk.delegations.isActive({ delegatorAddress })`. If false, skip decrypt entirely. Trades blockchain RPC calls for Gateway calls — much cheaper.

3. **User-driven pull** — don't auto-decrypt at all. The wallet API triggers decryption on-demand when serving transfer history. Avoids all background waste but adds latency to API responses.

The current approach (try everything, mark `no_rights`) is the simplest and ensures no transfer is missed, but scales poorly as the contract gains unrelated activity. For a production indexer serving a specific wallet partner, option 1 (whitelist) is the pragmatic choice.

## `userDecrypt` vs `delegatedDecrypt` in the Zama SDK

`userDecrypt` only works for **direct parties** to a transfer — if the calling EOA is the `from` or `to` address. It does not use ACL delegations. The indexer, being a third party, must use `delegatedDecrypt(handle, delegatorAddress)` with the `from` or `to` address as the delegator.

**Fix applied:** the worker now tries `delegatedDecrypt` with `from_address` first, falls back to `to_address` on `DelegationNotFoundError`.

## On-Chain Event Signatures Must Match the Contract

The ERC-7984 wrapper contract on Sepolia emits:
- `ConfidentialTransfer(address indexed, address indexed, bytes32 indexed)` — all state changes
- `Wrap(address indexed from, uint256 clearAmount, bytes32 encryptedAmount)` — shields with cleartext
- `UnwrapFinalized(address indexed receiver, bytes32 indexed requestId, bytes32 encryptedAmount, uint64 cleartextAmount)` — finalized unshields

Our initial `Shield(address,uint256,bytes32)` and `Unshield(address,uint256,bytes32)` ABIs **never matched** — the contract doesn't emit those events. Always verify event signatures against on-chain logs with `cast logs`.

## Event Count Discrepancy: Raw Logs vs Stored Events

The `fetched blocks` line reports raw logs from the RPC. The `storing` line reports the count after filtering.

- **transfers (raw)** — all `ConfidentialTransfer` logs; includes ones emitted during shield/unwrap where `from` or `to` is `zeroAddress`
- `parseConfidentialTransfer` at `src/indexer/poll.ts` filters out logs where `from === zeroAddress || to === zeroAddress`
- Formula: `stored = (raw transfers − filtered) + wraps + unwraps`

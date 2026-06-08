# Lessons Learned

## RPC & Batching

- Publicnode.com free tier: ~1 req/s for `eth_getLogs`. Mitigations: serial poll cycles (`setTimeout` + guard flag, not `setInterval`), 2s+ chunk delay during catch-up, exponential backoff for code `-32005`. Use a personal RPC key for production.
- `Promise.all` for parallel `getBlock` calls in batches of 10 — each call is a separate HTTP request (no transport-level batching configured, but the batch size keeps it manageable).
- `Map` for bigint-keyed lookups (`Object.fromEntries` doesn't support bigint keys).

## Tooling

- `"module": "NodeNext"` + `"moduleResolution": "NodeNext"` require `.js` extensions in local imports.
- Drizzle migration conflict: `migrate()` fails if tables already exist from raw SQL bootstrap. Delete the old DB or use Drizzle migrations from the start.
- `sqliteTable` v0.45+: third parameter changed from object to array `(t) => [ uniqueIndex("name").on(t.col) ]`.

## Testing & TypeScript

- `vi.mock()` factory is hoisted above module scope. Variables it references must be defined inside `vi.hoisted()`.
- TS 6 strict indexed access: `Promise.allSettled` results at index `i` are `T | undefined`. Guard with `if (!job || !result) continue` before narrowing on `result.status`.

## Env Var Pattern

Read all env vars once in `readEnv()` at the entry point, pass the typed `Env` object down. No module reads `process.env` directly. Makes testing easier and keeps env concerns in one place.

## Reorg Detection

Store block hash at the safe head after each cycle, compare on the next poll. Mismatch → roll back `CONFIRMATION_DEPTH` (5) blocks, CASCADE deletes queue entries, reset checkpoint. Must persist `start_block` so rollback never goes below the first indexed event.

## SDK Notes

- `userDecrypt` only works for **direct parties** to a transfer (the calling EOA is `from` or `to`). A third-party indexer must use `delegatedDecrypt(handle, delegatorAddress)`.
- `sdk.decryption.userDecrypt([{ encryptedValue, contractAddress }])` accepts event-derived handles (`log.args.encryptedAmount`) directly.
- `MemoryStorage` avoids filesystem state; viem-flavoured `createConfig` composes cleanly.
- `DelegationNotPropagatedError` needs longer backoff — Gateway propagation takes 1-2 minutes. The standard 10s→30s→90s can exhaust all 3 attempts before propagation completes. Currently treated as a generic transient error; a dedicated 60s first-retry delay would fix this.

## Event Parsing

- The Sepolia wrapper emits `ConfidentialTransfer`, `Wrap` (shield cleartext), and `UnwrapFinalized` (unshield cleartext). Our initial `Shield/Unshield` ABIs never matched — always verify event signatures with `cast logs`.
- Raw log count ≠ stored count. `parseConfidentialTransfer` filters logs where `from === zeroAddress || to === zeroAddress` (these are the duplicate ConfidentialTransfers emitted during shield/unshield). Formula: `stored = (raw transfers − filtered) + wraps + unwraps`.
- When `token.shield()` is called, the contract emits **two events** in the same tx: `ConfidentialTransfer(from=zeroAddress)` and `Wrap`. We filter the zero-address CT and store only the Wrap.

## Balance Tracking

Encrypted transfers get a two-phase balance update: (1) at index time, `delta=0` + `pending_transfers_count++`; (2) after decryption, `markTransferDecrypted` applies the real amount with the correct sign. Avoids blocking ingestion for Gateway decryption or replaying all transfers on every API read.

Bug caught: initial `markTransferDecrypted` only decremented the pending count without applying `cleartext_amount`. Always verify both the metadata (status/counts) _and_ the value (amount).

## On-Chain Token Metadata

`publicClient.readContract({ abi: [{ name: "decimals", ... }] })` works reliably on ERC-7984 wrappers — they inherit ERC-20 metadata functions. Avoids env var configuration for decimals/symbol. The wrapper symbol (`cUSDCMock`) differs from the underlying (`USDC`); decimals match (both 6).

## Drizzle Migrations in Tests

Pass `:memory:` to better-sqlite3 + `migrate()` from `drizzle-orm/better-sqlite3/migrator` to apply all schema changes in-memory. Avoids maintaining raw `CREATE TABLE` statements in test files and keeps them in sync with production schema.

## Wasted Decrypt Calls

Every `ConfidentialTransfer` is enqueued. On a contract with thousands of users and a wallet partner serving dozens, ~95% of Gateway calls fail with `DelegationNotFoundError`. Best fix: address whitelist — only enqueue transfers involving known wallet user addresses. Covered in DECISIONS.md trade-off §7.

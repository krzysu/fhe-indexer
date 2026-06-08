# Confidential Token Indexer — Implementation Spec

## Overview

A TypeScript Node service that indexes a single ERC-7984 confidential token contract on Sepolia, auto-decrypts transfer amounts via the Zama SDK, and exposes a cleartext read API for a wallet partner.

---

## References

### Contract Addresses (Sepolia)

| Contract                      | Address                                      |
| ----------------------------- | -------------------------------------------- |
| cUSDCMock (ERC-7984)          | `0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639` |
| Underlying USDC Mock (ERC-20) | `0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF` |
| Wrappers Registry             | `0x2f0750Bbb0A246059d80e94c454586a7F27a128e` |
| ACL Contract                  | `0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D` |
| KMS Contract                  | `0xbE0E383937d564D7FF0BC3b46c51f0bF8d5C311A` |
| Relayer URL                   | `https://relayer.testnet.zama.org/v2`        |
| Chain ID                      | 11155111                                     |
| Gateway Chain ID              | 10901                                        |

### SDK Reference

Detailed Zama SDK v3.1.0-alpha.5 API reference in [`docs/zama-sdk.md`](./zama-sdk.md) — separate document, source of truth for SDK integration.

---

## 1. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Single Process: src/index.ts                                     │
│                                                                    │
│  ┌──────────────────┐     ┌────────────────────────────────────┐  │
│  │ Poller            │────▶│ transfers table                    │  │
│  │ (viem getLogs)    │     │                                    │  │
│  │                   │     │ • 3 event types (transfer/shield/  │  │
│  │ • 3 event types   │     │   unshield)                        │  │
│  │ • reorg detection │     │ • decrypt_status tracks lifecycle  │  │
│  │ • decrypt queue   │     └───────────┬────────────────────────┘  │
│  │ • WAL mode SQLite─│────▶│  to ──┐                 │             │
│  └──────────────────┘     │ decrypt_queue │         │             │
│                            │ table         │         │             │
│  ┌──────────────────┐     │               │         │             │
│  │ Worker (1s loop)  │◀────│               ├────▶ balances table  │
│  │ Zama SDK decrypt  │────▶│               │         │             │
│  │                   │     └───────────┬───┘         │             │
│  │ • DelegationNot-  │                 │             │             │
│  │   FoundError→retry│     ┌───────────▼────────┐    │             │
│  │ • backlog sweep   │     │ decrypt_status      │    │             │
│  └──────────────────┘     │ pending→decrypted    │    │             │
│                            │ markTransferDecrypted──┘              │
│  ┌──────────────────────┐  └────────────────────┘                  │
│  │ Nest.js API          │── reads transfers + balances             │
│  │ port 3000            │                                          │
│  │                      │                                          │
│  │ • GET /api/v1/transfers/:address                                │
│  │ • GET /api/v1/transfers (all, debug)                            │
│  │ • GET /api/v1/balance/:address                                  │
│  │ • GET /api/v1/health                                            │
│  └──────────────────────┘                                          │
└──────────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

| Decision           | Choice                                  | Rationale                                                                                                                                                                                                                                                                            |
| ------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Indexing framework | **None (explicit viem polling)**        | Ponder manages its own database and schema; Gateway decryption (5–15s per handle) would stall block ingestion or require dual-database joins. Explicit `getLogs` + SQLite checkpoint is ~80 lines and avoids the mismatch.                                                           |
| Chain              | **Sepolia testnet**                     | cUSDCMock (`0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639`) is deployed, publicly mintable, no deployment needed.                                                                                                                                                                       |
| Database           | **SQLite via better-sqlite3 + Drizzle** | Zero ops, single file, TypeScript-native types. Postgres would be more "production" but adds docker-compose overhead for reviewers.                                                                                                                                                  |
| API framework      | **Nest.js**                             | As specified. Matches partner's likely stack.                                                                                                                                                                                                                                        |
| API response keys  | **camelCase**                           | Standard JS/TS convention for JSON APIs. Columns stay `snake_case` in SQL.                                                                                                                                                                                                           |
| Decryption model   | **Queue + worker** (implemented)        | Events are stored immediately (never dropped), then a background worker drains the decrypt queue. Decouples indexing speed from Gateway latency.                                                                                                                                     |
| Reorg handling     | **Shallow (5-block confirmation)**      | On each poll, verify last checkpointed block hash against chain. If mismatch, roll back CONFIRMATION_DEPTH blocks (transfers + queue via CASCADE). Implemented.                                                                                                                      |
| ACL grant backfill | **Periodic retry sweep** (every 10 min) | Finds `pending` transfers with no queue entry (orphaned by reorg or missed enqueue) and re-enqueues them. Not as tight as watching ACL events, but honest about the tradeoff. Implemented.                                                                                           |
| Migrations         | **Auto on startup**                     | `drizzle-orm/better-sqlite3/migrator` applies pending migrations from `drizzle/` folder every time the server starts. Generate via `pnpm db:generate` (drizzle-kit).                                                                                                                 |
| Balance tracking   | **Event-driven delta updates**          | Balance is maintained as a running total: `updateBalanceForTransfer` during indexing (delta=0 for encrypted transfers, full amount for plaintext), then `markTransferDecrypted` applies the actual amount after successful decryption. Avoids full-replay computation on every read. |

### Open Questions (resolved)

| #   | Question                                                                    | Answer                                                                                                                                                                                                                              |
| --- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Can `sdk.decryption.userDecrypt()` decrypt event-derived encrypted handles? | **Yes.** It takes `EncryptedInput[]` with `{ encryptedValue: bytes32, contractAddress: Address }`. The encrypted handle from `ConfidentialTransfer` events is the same type returned by `confidentialBalanceOf()`.                  |
| 2   | How does the indexer EOA get decryption rights?                             | Two ways: (a) it's a party to the transfer (from/to matches indexer EOA), or (b) via ACL delegation from the token holder via `token.delegateDecryption()`. The periodic retry sweep covers case (b) when rights are granted later. |
| 3   | Background worker lifecycle in Nest.js?                                     | **Same-process loop with `setTimeout`.** The async worker loop yields the event loop so API requests interleave. Separate process adds complexity without benefit at this scope.                                                    |
| 4   | Confirmation depth?                                                         | **5 blocks.** Sepolia testnet can reorg a few blocks. The indexer waits for 5 confirmations before processing.                                                                                                                      |
| 5   | Start block?                                                                | **Configurable via `START_BLOCK` env var.** Auto-detected via chunked binary search if not set.                                                                                                                                     |

---

## 2. Data Model

Tables are defined in `src/db/schema.ts` via Drizzle ORM and applied via `drizzle-orm/better-sqlite3/migrator` on startup.

### 2.1 `transfers` Table (implemented)

Stores every event emitted by the ERC-7984 contract — `ConfidentialTransfer`, `Shield`, and `Unshield`. No event is silently dropped.

Schema: `src/db/schema.ts`

- `event_type` — `"transfer"`, `"shield"`, or `"unshield"`
- `encrypted_handle` — the `bytes32` from the event (nullable for shield/unshield with cleartext only)
- `cleartext_amount` — populated directly for shield/unshield; populated by the worker for decrypted transfers
- `decrypt_status` — tracks the lifecycle of each event
- Unique constraint on `(tx_hash, log_index)` prevents duplicate indexing

**`decrypt_status` semantics:**

- `plain` — shield/unshield event where amount was emitted in cleartext. No SDK call needed.
- `pending` — encrypted event, not yet attempted decryption (or retry pending).
- `decrypted` — successfully decrypted, `cleartext_amount` is populated.
- `no_rights` — SDK returned `DelegationNotFoundError` or attempts exhausted; indexer lacks rights for this handle.

### 2.2 `balances` Table (implemented)

Running total per address, updated as events are indexed and decrypted. Defined in `src/db/schema.ts` via Drizzle ORM.

- `address` — primary key, one row per address
- `cleartext_balance` — running cleartext balance (may be `null` if unknown)
- `balance_status` — `"complete"` (no pending transfers), `"partial"` (pending transfers), `"unknown"` (no events yet)
- `last_updated_block` — highest block number that affected this balance
- `pending_transfers_count` — number of encrypted transfers not yet decrypted
- `updated_at` — last update timestamp

**Balance update flow:**

1. `storeLogs` in `poll.ts` calls `updateBalanceForTransfer` for every event:
   - Shield → `to_address` gets `+amount`, `pending_transfers_count` unchanged (plaintext)
   - Unshield → `from_address` gets `-amount`, `pending_transfers_count` unchanged (plaintext)
   - ConfidentialTransfer → both addresses get `delta=0` (no cleartext yet), `pending_transfers_count++`
2. Worker decrypts successfully → calls `markTransferDecrypted`:
   - Applies the decrypted amount with correct sign (`from` negative, `to` positive)
   - Decrements `pending_transfers_count`
   - Sets `balance_status = "complete"` if count reaches 0

### 2.3 `decrypt_queue` Table (implemented)

Job queue for pending decryption work. One row per `ConfidentialTransfer` event that needs decryption.

- `transfer_id` references `transfers.id` with `ON DELETE CASCADE` — reorg deletions automatically purge queue entries
- `attempts` / `max_attempts` — retry tracking (default max 3)
- `locked_at` — prevents concurrent processing of the same job
- `last_attempted_at` — drives exponential backoff timing (10s, 30s, 90s cap)

### 2.4 `indexer_state` Table (implemented)

Key-value checkpoint store for resumability.

**Keys:**

- `last_indexed_block` — block number of the last fully processed block.
- `last_indexed_hash` — block hash of the last processed block (for reorg detection).
- `chain_head_block` — latest known chain head (for health endpoint).
- `start_block` — the configured start block (persisted).

---

## 3. SDK Integration

### 3.1 Initialization (implemented)

SDK singleton in `src/worker/sdk.ts`. Created once at startup using viem-flavoured `createConfig` with `MemoryStorage` and the Zama node relayer. `initSdk(rpcUrl, privateKey)` takes env vars as parameters (not read internally). Worker only starts when `INDEXER_PRIVATE_KEY` is set.

### 3.2 Decryption Call (implemented)

Worker calls `sdk.decryption.userDecrypt([{ encryptedValue, contractAddress }])` for each job. Returns cleartext `bigint` on success.

- `DelegationNotFoundError` → `decrypt_status = "no_rights"`, delete queue row
- Transient errors → requeue with exponential backoff up to `max_attempts` (3), then `no_rights`
- `DelegationNotPropagatedError` is not yet handled separately — it currently follows the standard transient backoff path rather than a longer 60s delay. This gap means Gateway propagation delays may exhaust retries before the delegation is visible.

### 3.3 ACL Delegation Detection (implemented)

Not implemented as event watching (cut for scope). Instead, two mechanisms cover the recovery case:

1. **Periodic sweep** (every 10 minutes) finds `pending` transfers with no queue entry (orphans from reorgs or missed enqueues) and re-enqueues them.
2. **Manual admin endpoint** `POST /api/v1/admin/retry-no-rights?address=0x...` resets `no_rights` transfers back to `pending` and re-enqueues them. The partner calls this after granting the indexer EOA decryption rights for a wallet user. Accepts an optional `address` query param to scope the retry to a specific user's transfers.

This avoids wasteful automatic re-decryption of transfers the indexer will never have rights for (the wallet partner's users are a subset of the contract's users).

---

## 4. API Design

### 4.1 `GET /api/v1/transfers?page=1&limit=20` (implemented)

**Purpose:** All transfers with pagination (debug/testing).

**Response 200:**

```json
{
  "data": [
    {
      "txHash": "0xabcd...",
      "blockNumber": 7346000,
      "timestamp": 1700000000,
      "eventType": "transfer",
      "from": "0x1234...",
      "to": "0x5678...",
      "amount": null,
      "decryptStatus": "pending"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 150,
    "totalPages": 8
  }
}
```

### 4.2 `GET /api/v1/transfers/:address?page=1&limit=20` (implemented)

**Purpose:** Paginated transfer history for an address.

**Response 200:** same shape as §4.1.

**Direction inference:** The address in the path is the "subject." If `from === address` it's an outbound (negative balance impact), if `to === address` it's inbound (positive). The caller can compute net from the data.

**Event types:** Shield events emit `from = 0x0000000000000000000000000000000000000000` (mint from nothing) with `eventType: "shield"`. Unshield events emit `to = 0x0000000000000000000000000000000000000000` (burn to nothing) with `eventType: "unshield"`. Both have `decryptStatus: "plain"` with cleartext amounts in `amount`.

### 4.3 `GET /api/v1/balance/:address` (implemented)

**Purpose:** Current cleartext balance for an address. Reads from `balances` table (§2.2) and token metadata from `indexer_state`. Implemented in `src/api/balance.controller.ts`.

**Response 200:**

```json
{
  "address": "0x1234...",
  "balance": "1000000",
  "status": "complete",
  "pendingTransfers": 0,
  "decimals": 6,
  "symbol": "cUSDCMock"
}
```

**Balance semantics:**

- `status = "complete"` — all transfers involving this address have been decrypted (no pending). Balance is accurate.
- `status = "partial"` — some encrypted transfers are still pending decryption. Balance reflects only processed events.
- `status = "unknown"` — no events have been indexed for this address.
- `decimals` and `symbol` are fetched from the on-chain contract at startup and cached in `indexer_state`.

### 4.4 `GET /api/v1/health` (implemented)

**Purpose:** Liveness check and indexer progress.

**Response 200 (healthy):**

```json
{
  "status": "healthy",
  "lastIndexedBlock": 7346000,
  "chainHeadBlock": 7346010,
  "lag": 10,
  "uptimeSeconds": 3600
}
```

**Health thresholds:**

- `healthy` — lag < 50 blocks
- `degraded` — lag 50–500 blocks
- `unhealthy` — lag > 500 blocks

### 4.5 `POST /api/v1/admin/retry-no-rights?address=0x...` (implemented)

**Purpose:** Manually re-enqueue all `no_rights` transfers (optionally filtered by address) back to `pending` so the worker re-attempts decryption. Called by the partner after granting the indexer EOA new decryption rights for a wallet user.

**Response 200:**

```json
{
  "retried": 42
}
```

Avoids wasteful automatic retries on transfers the indexer will never have rights for. The partner knows when delegation is granted and triggers the retry at the right moment.

### 4.6 Consistent Error Shape (not implemented — lower priority)

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "address must be a valid hex string",
    "details": { "field": "address", "value": "invalid" }
  }
}
```

Error codes: `VALIDATION_ERROR`, `INTERNAL_ERROR`, `RATE_LIMITED`.

---

## 5. Implementation Stages

### Stage 1+2: Minimal Scaffold with Drizzle ORM (✅ Complete)

End-to-end TypeScript project with polling indexer, SQLite via Drizzle ORM, and Nest.js API — no Zama SDK decryption.

### Stage 3: Indexer Polling Loop (✅ Complete)

Full event coverage, reorg detection, and decrypt queue integration.

**What was built:**

- Three event types fetched in parallel per chunk (`ConfidentialTransfer`, `Shield`, `Unshield`) — merged and sorted by `(blockNumber, logIndex)`
- Reorg detection: stores block hash at each checkpoint; compares against chain on next cycle. Mismatch → roll back `CONFIRMATION_DEPTH` (5) blocks, delete transfers (CASCADE deletes queue entries), reset checkpoint
- Shield events: `from = zeroAddress`, `to = event.args.from`, `decrypt_status = 'plain'` with cleartext amount from the event
- Unshield events: `from = event.args.to`, `to = zeroAddress`, `decrypt_status = 'plain'` with cleartext amount from the event
- ConfidentialTransfer events: `decrypt_status = 'pending'`, no cleartext amount, enqueued into `decrypt_queue`
- Start block resolution: persisted to `indexer_state`, chunked binary search on chain if not configured
- Rate-limit retry with up to 5 attempts (10s delay) for RPC code `-32005`
- Chunked catch-up (max 50k blocks per chunk, 2s delay between chunks)

**New files:** `src/indexer/types.ts`, `src/db/queue.ts`

**Modified files:** `src/indexer/poll.ts`, `src/indexer/events.ts`, `src/db/schema.ts`, `src/db/state.ts`, `src/db/transfers.ts`

### Stage 4: Decrypt Worker (✅ Complete)

Background worker draining the decrypt queue, plus periodic sweep for orphaned entries.

**What was built:**

- SDK singleton in `src/worker/sdk.ts` — viem-flavoured `createConfig` with `MemoryStorage` and Zama node relayer. `initSdk(rpcUrl, privateKey)` takes parameters, doesn't read env vars internally
- Worker loop (1s interval): dequeues up to 5 ready jobs (backoff-aware — skips locked jobs and those within backoff window), decrypts in parallel via `Promise.allSettled`
- Three outcomes per job: success → `decrypted` + cleartext + delete queue row; `DelegationNotFoundError` → `no_rights` + delete; transient error → requeue with backoff or exhaust to `no_rights`
- Exponential backoff: 0 attempts = immediate, 1st = 10s, 2nd = 30s, 3rd+ = 90s (capped)
- Sweep (10 min interval): finds `pending` transfers with no `decrypt_queue` row and re-enqueues them

**New files:** `src/worker/sdk.ts`, `src/worker/worker.ts`, `src/worker/sweep.ts`

**Modified files:** `src/index.ts` (wires poller + worker + sweep + server)

### Stage 5: Balance Endpoint (✅ Complete)

Balance tracking with per-address `cleartext_balance`, `balance_status`, and `pending_transfers_count`.

**What was built:**

- `balances` table in `src/db/schema.ts` — Drizzle ORM definition with migration `0002_unknown_tomorrow_man.sql`
- `src/db/balances.ts` — `getBalance`, `updateBalanceForTransfer` (called during indexing), `markTransferDecrypted` (called after successful decryption)
- `src/api/balance.controller.ts` — `GET /api/v1/balance/:address` with token metadata from on-chain
- `src/db/state.ts` — `getTokenDecimals`/`setTokenDecimals`/`getTokenSymbol`/`setTokenSymbol`
- `src/index.ts` — fetches `decimals()` and `symbol()` from on-chain at startup, stores in `indexer_state`
- Poller integration: `storeLogs` calls `updateBalanceForTransfer` for every event
- Worker integration: `processBatch` calls `markTransferDecrypted` after successful decrypt

**Files created:** `src/api/balance.controller.ts`, `src/db/balances.ts`

**Admin endpoint** (`POST /api/v1/admin/retry-no-rights`) is already implemented — see §4.5.

### Stage 6: Integration + E2E Tests (✅ Complete)

Two test files covering the full flow:

**`src/e2e.test.ts`** — Real on-chain end-to-end test. Required by the task specification.

```
Test setup (runs once):
  1. Creates an in-memory SQLite database
  2. Applies all Drizzle migrations (same as production)
  3. Creates a viem publicClient connected to Sepolia
  4. Starts the real poller from `currentBlock - 1000`

Test body:
  1. Waits 30s for the poller to catch up and index events
  2. Queries transfers for the configured test address
  3. Logs sample transfers with event type, amount, and decrypt status
  4. Asserts all shield events have `decrypt_status = "plain"` with `cleartext_amount > 0`
  5. Queries the balance table and logs the result
```

**Requirements to run:** `TEST_WALLET_KEY`, `INDEXER_PRIVATE_KEY`, `CONTRACT_ADDRESS` in `.env`.
The test EOA must have existing shield events on-chain (from previous `token.shield()` calls) for the assertions to be meaningful.

**Skipped by default** — `describe.skipIf(!CONTRACT_ADDR || !TEST_ADDRESS)`.

**`src/integration.test.ts`** — Unit-level integration tests with mocked SDK:

- Happy path: shield → balance updated immediately with cleartext amount
- Happy path: encrypted transfer → worker decrypts → `markTransferDecrypted` applies amount → balance reflects cleartext
- Negative: `DelegationNotFoundError` → `no_rights` status → balance stays `partial` with `cleartext_balance = 0`

These run as part of the normal `pnpm test` suite (no env vars needed).

Unit tests total 58 across 7 test files.

### Stage 7: Documentation (partially done)

- ✅ `README.md` — setup, run, test instructions, core logic overview
- ❌ `DECISIONS.md` — not yet written
- ✅ `.env.example`

---

**Files yet to create:**

- `DECISIONS.md` (in root — covers trade-offs, pushbacks, and AI assistance notes)
- §4.6 Consistent Error Shape (API error format — lower priority)

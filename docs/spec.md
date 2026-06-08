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

Detailed Zama SDK v3.1.0-alpha.4 API reference in [`docs/zama-sdk.md`](./zama-sdk.md) — separate document, source of truth for SDK integration.

---

## 1. Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Single Process: src/index.ts                            │
│                                                           │
│  ┌──────────────────┐     ┌───────────────────────────┐  │
│  │ Polling Loop      │────▶│ transfers table           │  │
│  │ (viem getLogs)    │     │ (via Drizzle ORM)         │  │
│  │                   │     └───────────────────────────┘  │
│  │ • chunked catch-up│                                    │
│  │ • rate-limit retry│     ┌───────────────────────────┐  │
│  │ • WAL mode SQLite──────▶│ indexer_state table        │  │
│  └──────────────────┘      │ (via Drizzle ORM)          │  │
│                             └───────────────────────────┘  │
│                                                           │
│  ┌──────────────────────┐                                 │
│  │ Nest.js API          │── reads transfers               │
│  │ port 3000            │                                 │
│  │                      │                                 │
│  │ • GET /api/v1/transfers/:address                       │
│  │ • GET /api/v1/transfers (all, debug)                   │
│  │ • GET /api/v1/health                                   │
│  └──────────────────────┘                                 │
└─────────────────────────────────────────────────────────┘
```

### Key Design Decisions

| Decision           | Choice                                  | Rationale                                                                                                                                                                                                                  |
| ------------------ | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Indexing framework | **None (explicit viem polling)**        | Ponder manages its own database and schema; Gateway decryption (5–15s per handle) would stall block ingestion or require dual-database joins. Explicit `getLogs` + SQLite checkpoint is ~80 lines and avoids the mismatch. |
| Chain              | **Sepolia testnet**                     | cUSDCMock (`0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639`) is deployed, publicly mintable, no deployment needed.                                                                                                             |
| Database           | **SQLite via better-sqlite3 + Drizzle** | Zero ops, single file, TypeScript-native types. Postgres would be more "production" but adds docker-compose overhead for reviewers.                                                                                        |
| API framework      | **Nest.js**                             | As specified. Matches partner's likely stack.                                                                                                                                                                              |
| API response keys  | **camelCase**                           | Standard JS/TS convention for JSON APIs. Columns stay `snake_case` in SQL.                                                                                                                                                 |
| Decryption model   | **Inline + queue** (Stage 4)            | Events are stored immediately (never dropped), then a background worker drains the decrypt queue. Decouples indexing speed from Gateway latency. Not yet implemented.                                                      |
| Reorg handling     | **Shallow (5-block confirmation)**      | On each poll, verify last checkpointed block hash. If mismatch, roll back transfers >= fork block. Documented assumption. Not yet implemented.                                                                             |
| ACL grant backfill | **Periodic retry sweep** (every 10 min) | Re-enqueues `pending` rows past `max_attempts`. Not as tight as watching ACL events, but honest about the tradeoff. Not yet implemented.                                                                                   |
| Migrations         | **Auto on startup**                     | `drizzle-orm/better-sqlite3/migrator` applies pending migrations from `drizzle/` folder every time the server starts. Generate via `pnpm db:generate` (drizzle-kit).                                                       |

### Open Questions (resolved)

| #   | Question                                                                    | Answer                                                                                                                                                                                                                              |
| --- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Can `sdk.decryption.userDecrypt()` decrypt event-derived encrypted handles? | **Yes.** It takes `EncryptedInput[]` with `{ encryptedValue: bytes32, contractAddress: Address }`. The encrypted handle from `ConfidentialTransfer` events is the same type returned by `confidentialBalanceOf()`.                  |
| 2   | How does the indexer EOA get decryption rights?                             | Two ways: (a) it's a party to the transfer (from/to matches indexer EOA), or (b) via ACL delegation from the token holder via `token.delegateDecryption()`. The periodic retry sweep covers case (b) when rights are granted later. |
| 3   | Background worker lifecycle in Nest.js?                                     | **Same-process `@Injectable()` with `OnModuleInit`.** The async worker loop yields the event loop so API requests interleave. Separate process adds complexity without benefit at this scope.                                       |
| 4   | Confirmation depth?                                                         | **5 blocks.** Sepolia testnet can reorg a few blocks. The indexer waits for 5 confirmations before processing.                                                                                                                      |
| 5   | Start block?                                                                | **Configurable via `START_BLOCK` env var.** Look up contract deployment block (approx 7345000 for cUSDCMock) but let the partner override.                                                                                          |

---

## 2. Data Model

Tables are defined in `src/db/schema.ts` via Drizzle ORM and applied via `drizzle-orm/better-sqlite3/migrator` on startup.

### 2.1 `transfers` Table (implemented)

Stores every `ConfidentialTransfer` event emitted by the ERC-7984 contract. No event is silently dropped.

Schema: `src/db/schema.ts:4-23`

```sql
-- Generated from Drizzle schema; executed via migration
CREATE TABLE `transfers` (
  `id`                integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `tx_hash`           text    NOT NULL,
  `log_index`         integer NOT NULL,
  `block_number`      integer NOT NULL,
  `block_timestamp`   integer NOT NULL,
  `event_type`        text    NOT NULL,       -- validated at app layer
  `from_address`      text    NOT NULL,
  `to_address`        text    NOT NULL,
  `encrypted_handle`  text,
  `cleartext_amount`  integer,
  `decrypt_status`    text    DEFAULT 'pending' NOT NULL,
  `created_at`        text    DEFAULT (datetime('now')) NOT NULL
);

CREATE UNIQUE INDEX `unq_tx_hash_log_index` ON `transfers` (`tx_hash`,`log_index`);
```

**`decrypt_status` semantics:**

- `plain` — shield/unshield event where amount was emitted in cleartext. No SDK call needed.
- `pending` — encrypted event, not yet attempted decryption (or retry pending).
- `decrypted` — successfully decrypted, `cleartext_amount` is populated.
- `no_rights` — SDK returned `DelegationNotFoundError` or similar; indexer lacks rights for this handle.

### 2.2 `balances` Table (not yet implemented)

Running total per address, updated as events are indexed and decrypted.

```sql
CREATE TABLE balances (
  address               TEXT    PRIMARY KEY,
  cleartext_balance     INTEGER,
  balance_status        TEXT    NOT NULL DEFAULT 'unknown'
                            CHECK(balance_status IN ('complete', 'partial', 'unknown')),
  last_updated_block    INTEGER NOT NULL DEFAULT 0,
  pending_transfers_count INTEGER NOT NULL DEFAULT 0,
  updated_at            TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

### 2.3 `decrypt_queue` Table (not yet implemented)

Simple job queue for pending decryption work.

```sql
CREATE TABLE decrypt_queue (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  transfer_id         INTEGER NOT NULL UNIQUE REFERENCES transfers(id),
  encrypted_handle    TEXT    NOT NULL,
  contract_address    TEXT    NOT NULL,
  attempts            INTEGER NOT NULL DEFAULT 0,
  max_attempts        INTEGER NOT NULL DEFAULT 3,
  last_error          TEXT,
  last_attempted_at   TEXT,
  locked_at           TEXT,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

### 2.4 `indexer_state` Table (implemented)

Key-value checkpoint store for resumability.

```sql
CREATE TABLE indexer_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

**Keys:**

- `last_indexed_block` — block number of the last fully processed block.
- `last_indexed_hash` — block hash of the last processed block (for reorg detection).
- `chain_head_block` — latest known chain head (for health endpoint).
- `contract_address` — the ERC-7984 contract being indexed.
- `start_block` — the configured start block.

---

## 3. SDK Integration

### 3.1 Initialization

> **SDK reference:** [`docs/zama-sdk.md`](./zama-sdk.md) is the detailed v3.1.0-alpha.4 API reference. This section is a summary — the separate document is the source of truth.

Happens once at process startup, before polling or worker loops begin.

```typescript
import { MemoryStorage, ZamaSDK } from "@zama-fhe/sdk";
import { sepolia, type FheChain } from "@zama-fhe/sdk/chains";
import { createConfig } from "@zama-fhe/sdk/viem";
import { node } from "@zama-fhe/sdk/node";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia as viemSepolia } from "viem/chains";

const transport = http(SEPOLIA_RPC_URL);
const account = privateKeyToAccount(INDEXER_PRIVATE_KEY);
const publicClient = createPublicClient({ chain: viemSepolia, transport });
const walletClient = createWalletClient({
  account,
  chain: viemSepolia,
  transport,
});

const zamaSepolia = {
  ...sepolia,
  network: SEPOLIA_RPC_URL,
} as const satisfies FheChain;

const sdk = new ZamaSDK(
  createConfig({
    chains: [zamaSepolia],
    publicClient,
    walletClient,
    storage: new MemoryStorage(),
    relayers: { [zamaSepolia.id]: node() },
  }),
);

const token = sdk.createToken(CONFIDENTIAL_TOKEN_ADDRESS);
```

### 3.2 Decryption Call

Called by the worker for each encrypted handle found in the queue.

```typescript
import {
  DecryptionFailedError,
  DelegationNotFoundError,
  DelegationNotPropagatedError,
} from "@zama-fhe/sdk";

async function decryptHandle(
  handle: string,
  contractAddress: string,
): Promise<bigint | null> {
  try {
    const result = await sdk.decryption.userDecrypt([
      {
        encryptedValue: handle as `0x${string}`,
        contractAddress: contractAddress as `0x${string}`,
      },
    ]);
    return result[handle] as bigint;
  } catch (err) {
    if (err instanceof DelegationNotFoundError) return null; // → 'no_rights'
    if (err instanceof DelegationNotPropagatedError) {
      // Gateway sync takes 1–2 min (§7.1 in zama-sdk.md). This error is retriable,
      // but needs a longer backoff (e.g. 60s) to avoid exhausting the attempt cap
      // before propagation completes.
      throw err; // → retry (should use longer backoff than network errors)
    }
    throw err; // → retry with standard backoff
  }
}
```

### 3.3 ACL Delegation Detection

Not implemented as event watching (cut for scope). Instead, a periodic sweep re-attempts all `pending` rows that have exceeded `max_attempts`. When delegation is granted later, the sweep picks it up within 10 minutes.

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

**Direction inference:** The address in the path is the "subject." If `from === address` it's an outbound (negative balance impact), if `to === address` it's inbound (positive). The caller can compute net from the data.

**Shield/unshield note:** Shield events emit `from = 0x0000000000000000000000000000000000000000` (mint from nothing), and `event_type: "shield"`. Unshield events emit `to = 0x0000000000000000000000000000000000000000` (burn to nothing), and `event_type: "unshield"`. Not yet parsed — current code hardcodes `event_type = 'transfer'`.

### 4.3 `GET /api/v1/balance/:address` (not yet implemented)

**Purpose:** Current cleartext balance for an address.

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

**Response 200 (degraded):**

```json
{
  "status": "degraded",
  "lastIndexedBlock": 7345000,
  "chainHeadBlock": 7346010,
  "lag": 1010,
  "uptimeSeconds": 3600
}
```

**Health thresholds:**

- `healthy` — lag < 50 blocks
- `degraded` — lag 50–500 blocks
- `unhealthy` — lag > 500 blocks

### 4.5 Consistent Error Shape (not yet implemented)

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

End-to-end TypeScript project that compiles, runs a polling indexer against Sepolia cUSDCMock, stores `ConfidentialTransfer` events in SQLite via Drizzle ORM, and serves them via a Nest.js API — **no Zama SDK decryption yet**.

**What was built:**

- Polling indexer using `viem getLogs` with chunked catch-up and rate-limit retry
- SQLite database via `better-sqlite3` + **Drizzle ORM** for type-safe queries
- Tables: `transfers`, `indexer_state` — defined in `src/db/schema.ts`
- Migrations via `drizzle-orm/better-sqlite3/migrator`, applied automatically on startup
- Drizzle config at `drizzle.config.ts`, migration files in `drizzle/`
- `GET /api/v1/health` — liveness with lag detection
- `GET /api/v1/transfers` — all transfers with pagination
- `GET /api/v1/transfers/:address` — transfers by address with pagination
- API responses use **camelCase** keys

**Scope cut (future stages):**

- No Zama SDK — `cleartext_amount` is always `null`
- No balances table or endpoint
- No decrypt queue or worker
- Hardcoded `event_type = 'transfer'` (no shield/unshield parsing)
- No reorg detection (assumes stable head)

### Stage 3: Indexer Polling Loop

Replaces the current stub (single event type, no reorg detection) with full event coverage, reorg detection, and decrypt queue integration.

**Files (new):**

- `src/indexer/types.ts` — TypeScript types for parsed events

**Files (replaced from Stage 1):**

- `src/indexer/poll.ts` — Main polling loop
  - Read checkpoint from `indexer_state`
  - Call `publicClient.getLogs()` for each event type from `checkpoint + 1` to `chain_head - CONFIRMATION_DEPTH`
  - Detect reorgs by verifying `last_indexed_hash` matches chain
  - On reorg: roll back CONFIRMATION_DEPTH blocks and re-index
  - Parse events, write to `transfers`, enqueue decrypt jobs for non-plain events
  - Update checkpoint
- `src/indexer/events.ts` — Event signature definitions for all three event types instead of just ConfidentialTransfer

**Event signatures (ERC-7984):**

```solidity
event ConfidentialTransfer(address indexed from, address indexed to, bytes32 encryptedAmount);
event Shield(address indexed from, uint256 clearAmount, bytes32 encryptedAmount);
event Unshield(address indexed to, uint256 clearAmount, bytes32 encryptedAmount);
```

**Polling loop pseudo:**

```
while (running) {
  chainHead = await publicClient.getBlockNumber() - CONFIRMATION_DEPTH
  checkpoint = state.get('last_indexed_block')

  if (chainHead <= checkpoint) { sleep(12s); continue }

  // Reorg check
  checkpointHash = state.get('last_indexed_hash')
  actualHash = await publicClient.getBlock({ blockNumber: checkpoint }).hash
  if (actualHash !== checkpointHash) {
    // Reorg detected. Roll back CONFIRMATION_DEPTH and re-index.
    // Sepolia shallow reorgs rarely exceed 1-2 blocks; this is safe.
    // Deeper reorgs would require storing recent block hashes.
    safeBlock = max(checkpoint - CONFIRMATION_DEPTH, startBlock)
    rollbackTo(safeBlock)
    continue
  }

  // Fetch logs
  for eventType of [ConfidentialTransfer, Shield, Unshield] {
    logs = await publicClient.getLogs({
      address: contractAddress,
      event: eventAbi[eventType],
      fromBlock: checkpoint + 1,
      toBlock: chainHead,
    })
    for log of logs {
      parseAndStore(log)
    }
  }

  state.set('last_indexed_block', chainHead)
  state.set('last_indexed_hash', await getBlockHash(chainHead))
}
```

### Stage 4: Decrypt Worker

New files, no overlap with earlier stages. Depends on Stage 3's decrypt queue entries.

**Files:**

- `src/worker/sdk.ts` — Zama SDK singleton initialization + disposal
- `src/worker/worker.ts` — Queue drain loop
- `src/worker/sweep.ts` — Periodic retry sweep

**Worker loop pseudo:**

```
async function processBatch() {
  // Get up to 5 unlocked jobs
  jobs = db.dequeueBatch(5)
  if (jobs.length === 0) return

  results = await Promise.allSettled(
    jobs.map(job => decryptHandle(job.encrypted_handle, job.contract_address))
  )

  for each (job, result) {
    if result.status === 'fulfilled' && result.value !== null {
      db.updateDecryptSuccess(job.transfer_id, result.value)
      db.updateBalance(job.transfer_id, result.value)
    } else if result.status === 'fulfilled' && result.value === null {
      db.updateDecryptNoRights(job.transfer_id)
    } else {
      // Retry logic
      if (job.attempts < job.max_attempts) {
        db.requeueWithBackoff(job.id)
      } else {
        db.updateDecryptFailed(job.transfer_id, result.reason)
      }
    }
  }
}

async function workerLoop() {
  while (running) {
    await processBatch()
    await sleep(1000) // 1s between batches
  }
}
```

**Retry backoff:** exponential — 10s, 30s, 90s (between attempts, not poll intervals).

**Periodic sweep (every 10 minutes):**

```sql
-- Re-enqueue pending rows that have exhausted max_attempts
-- or have been in 'pending' state for > 30 minutes without being queued
INSERT INTO decrypt_queue (transfer_id, encrypted_handle, contract_address)
SELECT t.id, t.encrypted_handle, c.contract_address
FROM transfers t
CROSS JOIN (SELECT value as contract_address FROM indexer_state WHERE key = 'contract_address') c
WHERE t.decrypt_status = 'pending'
  AND NOT EXISTS (SELECT 1 FROM decrypt_queue dq WHERE dq.transfer_id = t.id)
```

### Stage 5: API (Nest.js)

Extends Stage 1 API. Adds balance endpoint and DTO interfaces.

**Files (new):**

- `src/api/balance.controller.ts` — `GET /api/v1/balance/:address`
- `src/api/dto.ts` — Response interfaces

**Files (extended from Stage 1):**

- `src/api/app.module.ts` — Register new controller
- `src/api/transfers.controller.ts` — Wire real DB queries (was stub)
- `src/api/health.controller.ts` — Wire real `pending_decrypt_jobs` count
- `src/api/main.ts` — Pass `DatabaseService` provider

**Controller patterns:**

```typescript
@Controller("/api/v1")
export class BalanceController {
  constructor(private db: DatabaseService) {}

  @Get("/balance/:address")
  async getBalance(@Param("address") address: string) {
    isValidAddress(address); // otherwise throw ValidationException
    const balance = await this.db.getBalance(address);
    return {
      address,
      balance: balance.cleartext_balance?.toString() ?? null,
      status: balance.balance_status,
      pending_transfers: balance.pending_transfers_count,
      decimals: 6,
      symbol: "cUSDCMock",
      ...(balance.balance_status === "partial" && {
        warning: `${balance.pending_transfers_count} transfers awaiting decryption`,
      }),
    };
  }
}
```

### Stage 6: Tests

**Files:**

- `src/tests/happy-path.test.ts`
- `src/tests/negative.test.ts`

**Happy path test:**

```
Given a mock ConfidentialTransfer event with known encrypted amount
When the indexer processes it
And the decrypt worker successfully decrypts the amount
Then GET /api/v1/balance/:from returns the incremented balance
And GET /api/v1/transfers/:from returns the transfer with cleartext amount
```

Strategy: Mock the viem `getLogs` call to return a known event log with a pre-computed encrypted handle. Mock the Zama SDK `sdk.decryption.userDecrypt` to return a known cleartext value. Assert the API response contains the correct cleartext.

| Step | Action                                             | Expected                                                         |
| ---- | -------------------------------------------------- | ---------------------------------------------------------------- |
| 1    | Insert mock event into transfers table via indexer | Row exists with decrypt_status = 'pending'                       |
| 2    | Worker processes the queue entry                   | cleartext_amount = 1000000, decrypt_status = 'decrypted'         |
| 3    | GET /api/v1/balance/:from                          | balance = "1000000", status = "complete"                         |
| 4    | GET /api/v1/transfers/:from                        | data[0].amount = "1000000", data[0].decrypt_status = "decrypted" |

**Negative test — no decryption rights:**

```
Given a ConfidentialTransfer event where the indexer EOA has no decryption rights
When the indexer processes it
And the decrypt worker attempts decryption and gets DelegationNotFoundError
Then the transfer is stored with decrypt_status = 'no_rights'
And GET /api/v1/transfers/:from returns amount = null with decrypt_status = 'no_rights'
And the balance status is 'partial' or 'unknown'
```

This test proves the brief's requirement that "events the holder is not currently entitled to decrypt must not be silently dropped."

### Stage 7: Documentation

**Files:**

- `README.md` — Setup, run, test instructions
- `DECISIONS.md` — Trade-off documentation
- `.env.example`

---

## 6. Project Structure (current state)

```
zama-fhe-indexer/
├── docs/
│   ├── spec.md              # This file
│   └── zama-sdk.md          # Zama SDK v3.1.0-alpha.4 reference
├── drizzle/                 # Migration files (auto-generated by drizzle-kit)
│   ├── 0000_initial.sql
│   └── meta/
├── scripts/
│   └── api-test.sh          # curl examples for manual API testing
├── src/
│   ├── api/
│   │   ├── app.module.ts
│   │   ├── constants.ts
│   │   ├── health.controller.ts
│   │   ├── main.ts
│   │   ├── providers.ts
│   │   └── transfers.controller.ts
│   ├── db/
│   │   ├── connection.ts    # DB singleton, auto-migrates on startup
│   │   ├── schema.ts        # Drizzle table definitions
│   │   ├── state.ts         # Checkpoint read/write
│   │   └── transfers.ts     # Transfer CRUD
│   ├── indexer/
│   │   ├── events.ts        # ConfidentialTransfer ABI + log type
│   │   └── poll.ts          # Polling loop with chunked catch-up
│   └── index.ts             # Entry point
├── .env.example
├── .gitignore
├── .node-version
├── .prettierrc
├── AGENTS.md
├── DECISIONS.md
├── README.md
├── drizzle.config.ts
├── package.json
├── pnpm-lock.yaml
└── tsconfig.json
```

**Files yet to create (future stages):**

- `src/api/balance.controller.ts`, `src/api/dto.ts`
- `src/db/balances.ts`, `src/db/queue.ts`
- `src/indexer/types.ts`
- `src/worker/` (sdk.ts, worker.ts, sweep.ts)
- `src/tests/`

---

## 7. Open Questions (for future stages)

1. **SDK `sdk.decryption.userDecrypt` on event handles** — verify event-derived handles work with `sdk.decryption.userDecrypt()`. The research suggests yes, but test when implementing Stage 4.
2. **Relayer API key** — optional on Sepolia. If required, add to `.env.example` and handle `401` from relayer gracefully.
3. **Batch `userDecrypt`** — does the SDK support decrypting multiple handles in one call? The signature `sdk.decryption.userDecrypt(encryptedInputs: EncryptedInput[])` suggests yes. If so, batch 5 handles per call in the worker.
4. **Caching** — the SDK has a built-in `DecryptCache`. Use it but clear on startup for safety.

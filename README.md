# Zama FHE Indexer

Indexes ERC-7984 confidential token events on Sepolia and exposes a cleartext REST API.

## Prerequisites

- **Node.js** >= 22
- **pnpm** 11.3.0 (install via `corepack enable && corepack prepare pnpm@11.3.0 --activate`)
- A Sepolia RPC URL (e.g. from Infura, Alchemy, or the public endpoint)

## Setup

```bash
pnpm install
cp .env.example .env
```

Edit `.env` to set your RPC URL (or keep the default public endpoint) and optionally adjust the contract address or port. The indexing start block is auto-detected from the chain via chunked binary search; `START_BLOCK` can be set as an optional override.

### Database

The SQLite database is auto-created on startup at `data/indexer.db`. Tables are managed via Drizzle ORM migrations:

```bash
pnpm db:generate   # generate migration SQL from schema changes (run after schema edits)
```

Migrations run automatically when the server starts — no manual step needed.

SQLite WAL files (`-wal`, `-shm`) are gitignored.

## Run

```bash
pnpm dev
```

Starts the indexer on `http://localhost:3000`.

## Commands

| Command             | Description                            |
| ------------------- | -------------------------------------- |
| `pnpm dev`          | Run indexer in dev mode (tsx watch)    |
| `pnpm build`        | Compile TypeScript to `dist/`          |
| `pnpm start`        | Run compiled JS from `dist/`           |
| `pnpm typecheck`    | Type-check without emitting            |
| `pnpm format`       | Format code with Prettier              |
| `pnpm format:check` | Check formatting                       |
| `pnpm db:generate`  | Generate Drizzle migration from schema |
| `pnpm test`         | Run unit tests (vitest)                |
| `pnpm test:watch`   | Run tests in watch mode                |

## API Endpoints

| Method | Path                                | Description                     |
| ------ | ----------------------------------- | ------------------------------- |
| GET    | `/api/v1/health`                    | Indexer liveness and progress   |
| GET    | `/api/v1/transfers?page=1&limit=20` | All transfers (debug/testing)   |
| GET    | `/api/v1/transfers/:address?...`    | Transfers by address, paginated |
| GET    | `/api/v1/balance/:address`          | Cleartext balance (stub — WIP)  |
| POST   | `/api/v1/admin/retry-no-rights`     | Re-enqueue no_rights transfers  |
|        | `?address=0x...`                    | Optional: scope to address      |

Quick test:

```bash
./scripts/api-test.sh
```

## How It Works

The indexer has three independent loops running in the same process:

### Poller (`src/indexer/poll.ts`)

Runs every **30 seconds**. Fetches all three ERC-7984 event types — `ConfidentialTransfer`, `Shield`, `Unshield` — in parallel for each chunk range (max 50k blocks per chunk). Events are merged, sorted by `(blockNumber, logIndex)`, and stored.

| Event                  | `from`        | `to`          | `decrypt_status` | Enqueued? |
| ---------------------- | ------------- | ------------- | ---------------- | --------- |
| `ConfidentialTransfer` | `args.from`   | `args.to`     | `pending`        | Yes       |
| `Shield` (mint)        | `zeroAddress` | `args.from`   | `plain`          | No        |
| `Unshield` (burn)      | `args.to`     | `zeroAddress` | `plain`          | No        |

Shield/Unshield carry a cleartext amount in the event, stored directly. ConfidentialTransfer events carry an encrypted handle — the poller inserts a row into `decrypt_queue` and moves on.

**Reorg detection**: after indexing to the safe head (chain head - 5 confirmations), the poller stores that block's hash. Next cycle it compares the stored hash against the chain. Mismatch = reorg → deletes transfers back to `max(lastBlock - 5, startBlock)` (CASCADE purges queue entries too), resets the checkpoint, and retries on the next cycle.

**Start block resolution** (runs once): `last_indexed_block` from DB > stored `start_block` > `START_BLOCK` env var > **chunked binary search** on chain to find the first block with a `ConfidentialTransfer` event. The resolved block is persisted and never changes.

### Worker (`src/worker/worker.ts`)

Runs every **1 second**, draining up to **5 jobs** from `decrypt_queue`. Each job calls the Zama SDK's `userDecrypt(encryptedHandle, contractAddress)` using the private key from `INDEXER_PRIVATE_KEY`.

| Decrypt outcome                    | `decrypt_status` | Queue row             |
| ---------------------------------- | ---------------- | --------------------- |
| Success → cleartext value          | `"decrypted"`    | Deleted               |
| `DelegationNotFoundError`          | `"no_rights"`    | Deleted               |
| Transient error, retries < max (3) | `"pending"`      | Requeued with backoff |
| Transient error, retries exhausted | `"no_rights"`    | Deleted               |

**Backoff** is exponential: 0 attempts = immediate, 1st = 10s, 2nd = 30s, 3rd = 90s (capped). Jobs skip the cycle if `locked_at` is set (being processed) or backoff hasn't elapsed.

Worker only starts when `INDEXER_PRIVATE_KEY` is set — it's optional.

**No-rights recovery:** When the partner onboards a new wallet user and grants the indexer EOA decryption rights, they call `POST /api/v1/admin/retry-no-rights?address=0x...` to reset those transfers back to `pending` and re-enqueue them. The worker picks them up on the next cycle. No automatic wasteful retries.

### Sweep (`src/worker/sweep.ts`)

Runs every **10 minutes**. Finds `transfers` where `decrypt_status = 'pending'` but **no row exists** in `decrypt_queue` — these are orphans from missed enqueues or reorgs. Re-enqueues them.

### Data flow

```
chain events ──▶ poller ──▶ transfers table ──▶ API
                    │
                    ▼ (ConfidentialTransfer only)
            decrypt_queue table
                    │
                    ▼
              worker (1s loop) ──▶ sdk.decryption.userDecrypt()
                    │
                    ▼
            transfers.decrypt_status = "decrypted" | "no_rights"
```

### Env vars

Read once in `src/index.ts` and passed down. No module reads `process.env` directly except `readEnv()`.

| Variable              | Required          | Purpose                            |
| --------------------- | ----------------- | ---------------------------------- |
| `SEPOLIA_RPC_URL`     | Yes               | RPC endpoint                       |
| `CONTRACT_ADDRESS`    | Yes               | ERC-7984 token contract            |
| `INDEXER_PRIVATE_KEY` | No                | EOA key for Zama SDK decryption    |
| `START_BLOCK`         | No                | Override auto-detected start block |
| `PORT`                | No (default 3000) | HTTP server port                   |

## Docs

- [`docs/spec.md`](docs/spec.md) — full implementation spec (7 stages)
- [`DECISIONS.md`](DECISIONS.md) — trade-offs, pushbacks, and design rationale
- [`docs/lessons.md`](docs/lessons.md) — lessons learned during development
- [`scripts/api-test.sh`](scripts/api-test.sh) — curl examples for manual API testing

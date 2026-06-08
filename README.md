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

Edit `.env` to set your RPC URL (or keep the default public endpoint) and optionally adjust the contract address or port. The indexing start block is auto-detected from the chain via binary search; `START_BLOCK` can be set as an optional override.

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
| GET    | `/api/v1/balance/:address`          | Cleartext balance (stub)        |

Quick test:

```bash
./scripts/api-test.sh
```

## Docs

- [`docs/spec.md`](docs/spec.md) — full implementation spec (7 stages)
- [`docs/lessons.md`](docs/lessons.md) — lessons learned during development
- [`scripts/api-test.sh`](scripts/api-test.sh) — curl examples for manual API testing

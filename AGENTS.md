# AGENTS.md — for AI coding assistants

## Project

TypeScript Nest.js service that indexes ERC-7984 confidential token events on Sepolia.

## Commands

- `pnpm dev` — run in dev mode (tsx watch)
- `pnpm typecheck` — type-check without emitting (run this before every commit)
- `pnpm build` — compile to dist/
- `pnpm test` — no test framework configured yet (update when added)

## Conventions

- **No comments** in source code unless the code's intent is truly unclear
- **Experimental decorators** enabled (`experimentalDecorators: true` in tsconfig)
- **verbatimModuleSyntax** — use `import type` for type-only imports
- **NodeNext** module resolution — always include `.js` extension in local imports (e.g. `./db/connection.js`)
- **Formatting** managed by Prettier (see `.prettierrc`)

## Project structure

- `src/index.ts` — entry point, wires DB + poller + Nest server
- `src/db/` — SQLite via better-sqlite3
- `src/indexer/` — viem-based event polling loop
- `src/api/` — Nest.js controllers (health, transfers, balance)
- `src/worker/` — Zama SDK decrypt worker (Stage 4+)
- `docs/spec.md` — full implementation spec

## Environment

- Copy `.env.example` → `.env`
- Required: `SEPOLIA_RPC_URL`, `CONTRACT_ADDRESS`
- Optional: `PORT` (default 3000), `START_BLOCK` (default 7345000)

## Implementation stages (from spec)

1. Minimal scaffold (current) — compile, poll, store, serve — **no decryption**
2. Drizzle ORM layer
3. Full polling with reorg detection + decrypt queue
4. Zama SDK decrypt worker
5. Balance endpoint
6. Tests
7. Docs

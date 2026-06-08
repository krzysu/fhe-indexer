# AGENTS.md — for AI coding assistants

## Project

TypeScript Nest.js service that indexes ERC-7984 confidential token events on Sepolia.

## Setup

```bash
pnpm install
cp .env.example .env
# edit .env with SEPOLIA_RPC_URL and CONTRACT_ADDRESS
```

DB is auto-created on first run (migrations run automatically at startup).

## Commands

- `pnpm dev` — run in dev mode (tsx watch)
- `pnpm typecheck` — type-check without emitting (run this before every commit)
- `pnpm build` — compile to dist/
- `pnpm db:generate` — generate migration SQL after schema changes
- `pnpm test` — run unit tests (vitest)
- `pnpm test:watch` — run tests in watch mode

## Conventions

- **No comments** in source code unless the code's intent is truly unclear
- **Experimental decorators** enabled (`experimentalDecorators: true` in tsconfig)
- **verbatimModuleSyntax** — use `import type` for type-only imports
- **NodeNext** module resolution — always include `.js` extension in local imports (e.g. `./db/connection.js`)
- **Formatting** managed by Prettier (see `.prettierrc`)

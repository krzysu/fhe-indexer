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

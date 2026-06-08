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

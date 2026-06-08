# DECISIONS.md

## Stack choices

### viem polling over Ponder

Ponder owns its database and ORM. Its handler model assumes self-contained, fast operations. The Zama decryption flow (5–15s cross-chain Gateway round-trip per handle) breaks this — a 50-handle batch would stall block ingestion for minutes. You either decrypt inline (indexer stalls if Gateway is down) or enqueue externally (now two databases, Ponder's store + yours, needing joins). Explicit `viem getLogs` polling with a SQLite checkpoint row is ~80 lines and avoids the framework mismatch entirely.

### SQLite over Postgres

Zero ops, no docker-compose for reviewers. Adequate for test task.

### Drizzle ORM over raw SQL

Type-safe queries, auto-generated migration files, and a single source of truth for the schema. The initial implementation used raw SQL DDL (`CREATE TABLE IF NOT EXISTS` in `connection.ts`), but this was replaced by Drizzle migrations to avoid drift between the schema definition and actual DB state.

### Drizzle migrations applied on startup

`drizzle-orm/better-sqlite3/migrator` runs pending migrations every time the server starts. No manual `migrate` step needed for local dev. Migration files (`drizzle/`) are committed to git as the schema changelog.

### camelCase API responses

JSON API keys use `camelCase` (JS/TS convention) while database columns use `snake_case` (SQL convention). The mapping happens in the controller's response transformer.

# DECISIONS.md

## Stack choices

### viem polling over Ponder

Ponder owns its database and ORM. Its handler model assumes self-contained, fast operations. The Zama decryption flow (5–15s cross-chain Gateway round-trip per handle) breaks this — a 50-handle batch would stall block ingestion for minutes. You either decrypt inline (indexer stalls if Gateway is down) or enqueue externally (now two databases, Ponder's store + yours, needing joins). Explicit `viem getLogs` polling with a SQLite checkpoint row is ~80 lines and avoids the framework mismatch entirely.

### SQLite over Postgres

Zero ops, no docker-compose for reviewers. Adequate for test task.

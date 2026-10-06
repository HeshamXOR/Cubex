# Database and migrations reference

Examples use PostgreSQL syntax; the principles apply to other relational databases.

## Contents
1. Schema design
2. Data types
3. Indexing
4. Query habits
5. Transactions and isolation
6. Locking and concurrency
7. Migrations without downtime
8. Backfills
9. Connection pooling and operations
10. Choosing other stores

## 1. Schema design
- Model the domain first; normalize to 3NF by default, denormalize deliberately for measured read performance.
- Every table has a primary key. Use surrogate keys (`bigint identity`, UUIDv7 or ULID for time-ordered ids) unless a natural key is truly immutable and unique.
- Enforce integrity in the database: `NOT NULL` by default, `FOREIGN KEY` with explicit `ON DELETE` behavior, `UNIQUE` (including partial unique indexes such as "one active subscription per user"), `CHECK` for ranges and enums.
- Store `created_at` and `updated_at` (`timestamptz`, default `now()`); add `deleted_at` only if you truly need soft delete, and then remember every query and unique constraint must account for it (partial indexes `WHERE deleted_at IS NULL`).
- Prefer join tables to arrays or comma-separated values for relationships you query.
- Use JSONB for genuinely semi-structured attributes, not to avoid modeling; index with GIN when querying inside.
- Multi-tenant: `tenant_id` on every tenant table, included in composite indexes and unique constraints; consider Postgres row-level security as defense in depth.
- Audit trails for sensitive changes: append-only history table or event log.

## 2. Data types
- Time: `timestamptz` (UTC) always; never `timestamp` without zone for instants. Store user time zone separately if needed.
- Money: integer minor units (`bigint`) or `numeric(p,s)`; never floating point.
- Text: `text` with a `CHECK` on length when limits matter; `citext` or lower-cased functional index for case-insensitive uniqueness (emails).
- Enums: a lookup table or `text` + `CHECK` is easier to evolve than native enum types.
- Booleans as `boolean`; identifiers as `uuid` or `bigint`; IPs as `inet`; ranges as `tstzrange`.
- Avoid `SELECT *` in application code, and avoid storing large blobs in rows (use object storage with references).

## 3. Indexing
- Index foreign keys, columns used in `WHERE`, `JOIN`, and `ORDER BY` on hot queries.
- **Composite index order**: equality columns first, then range, then sort (`(tenant_id, status, created_at DESC)`). An index on `(a, b)` serves `a` and `a,b` but not `b` alone.
- **Partial indexes** for hot subsets (`WHERE status = 'pending'`). **Covering indexes** (`INCLUDE`) to enable index-only scans. **Expression indexes** for `lower(email)`.
- Choose the type: B-tree default; GIN for JSONB, arrays, full-text; GiST/SP-GiST for geometry and ranges; BRIN for huge append-only time series; hash rarely.
- Every index costs writes and space: drop unused ones (`pg_stat_user_indexes`).
- In production, create with `CREATE INDEX CONCURRENTLY` (cannot run inside a transaction block).
- Validate with `EXPLAIN (ANALYZE, BUFFERS)` on realistic data volumes; watch for sequential scans on big tables, row estimate mismatches (run `ANALYZE`), and sort spills.

## 4. Query habits
- Parameterize every query. Never interpolate user input.
- Avoid N+1: fetch related rows with a join, `IN (...)` batch, or `selectinload`/`include` equivalents; log query counts per request in tests.
- Paginate with keyset (`WHERE (created_at, id) < ($1, $2) ORDER BY created_at DESC, id DESC LIMIT 50`) for large tables.
- Use `EXISTS` instead of `COUNT(*) > 0`; `UNION ALL` when duplicates are impossible; `INSERT ... ON CONFLICT DO UPDATE` for upserts; `RETURNING` to avoid extra round trips.
- Keep functions off indexed columns in predicates (`WHERE date(created_at) = ...` defeats the index; use a range).
- Window functions and CTEs for analytics; materialize heavy results in summary tables or materialized views refreshed on schedule.
- Set `statement_timeout` and `lock_timeout` per role or per session to protect the database.

## 5. Transactions and isolation
- ACID via transactions: group writes that must succeed together; keep them short; never do network calls inside.
- Default isolation `READ COMMITTED` (Postgres) allows non-repeatable reads and write skew. Use `REPEATABLE READ` or `SERIALIZABLE` (with retry on serialization failure `40001`) for invariants spanning multiple rows, or enforce with constraints or explicit locks.
- Make retry loops for deadlocks and serialization failures at the transaction boundary.
- Be careful with ORM sessions: one transaction per request or per use case, commit or rollback explicitly, never share a session across threads or tasks.

## 6. Locking and concurrency
- **Optimistic**: `version` column; `UPDATE ... WHERE id = $1 AND version = $2`; zero rows updated means conflict (return 409/412).
- **Pessimistic**: `SELECT ... FOR UPDATE` (add `NOWAIT` or `SKIP LOCKED`). `FOR UPDATE SKIP LOCKED` implements simple job queues.
- **Atomic counters**: `UPDATE t SET n = n + 1`, not read-modify-write in application code.
- **Uniqueness races**: rely on unique constraints and handle the violation, do not check-then-insert.
- **Advisory locks** (`pg_advisory_xact_lock`) for cross-row critical sections such as scheduled-job leader election.
- Lock ordering: always acquire locks in a consistent order to avoid deadlocks.

## 7. Migrations without downtime
Use a migration tool (Alembic, Django migrations, Flyway, Liquibase, Prisma Migrate, Knex, golang-migrate, Atlas). Migrations are code-reviewed, versioned, tested against a copy of production-like data, and never edited after being applied.

**Expand and contract** for breaking changes:
1. **Expand**: add the new column/table/index in a backward-compatible way (nullable or with a default that does not rewrite the table; new indexes concurrently).
2. **Deploy code** that writes to both old and new (dual write) and reads the new with fallback to old.
3. **Backfill** existing rows in batches (section 8).
4. **Switch reads** to the new structure; verify.
5. **Contract**: after a full release cycle, deploy code that no longer touches the old structure, then drop it in a later migration.

Dangerous operations and safer alternatives:
| Risky | Safer |
|---|---|
| `ADD COLUMN ... NOT NULL DEFAULT <volatile>` on a huge table (older versions rewrite) | Add nullable, backfill in batches, add `CHECK ... NOT VALID` then `VALIDATE CONSTRAINT`, then set `NOT NULL` |
| `CREATE INDEX` | `CREATE INDEX CONCURRENTLY` |
| Adding a foreign key | `ADD CONSTRAINT ... NOT VALID` then `VALIDATE CONSTRAINT` |
| Renaming a column or table | Add new, dual write, migrate, drop old |
| Changing a column type | New column, backfill, swap |
| Long `ALTER` blocking traffic | Set `lock_timeout` (for example 3 s) and retry; run off-peak |
| Dropping a column still read by old code | Deploy code that stops using it first |

Every migration should state its rollback story (a down migration, or a forward-fix plan), because data-destroying migrations cannot be undone.

## 8. Backfills
- Run as a separate, resumable job, not inside the schema migration transaction.
- Batch by primary key range (for example 1,000 to 10,000 rows), commit per batch, sleep briefly between batches, monitor replication lag and lock waits.
- Make idempotent (`WHERE new_col IS NULL`), log progress, allow pause and resume, and verify counts after.

## 9. Connection pooling and operations
- Applications use a bounded pool (size roughly cores x 2 to 4 per app instance, and total across instances must stay under `max_connections`). Use PgBouncer (transaction mode) for many short-lived clients; note that transaction pooling breaks session-level features (`SET`, advisory session locks, prepared statements in some configs).
- Set connection, statement, and idle-in-transaction timeouts. Detect leaks by monitoring pool wait time.
- Use read replicas only for staleness-tolerant reads; route explicitly and handle replica lag (read-your-writes).
- Backups: automated, tested restores, point-in-time recovery; define RPO and RTO; store copies in another region or account.
- Monitor: slow query log / `pg_stat_statements`, table and index bloat, autovacuum health, replication lag, disk, connections, lock waits.
- Encrypt in transit (TLS) and at rest; restrict network access; separate roles for app, migrations, and read-only analytics.

## 10. Choosing other stores
| Need | Consider |
|---|---|
| Relational integrity, transactions, ad hoc queries | PostgreSQL (default choice) |
| Caching, rate limits, ephemeral sessions, leaderboards | Redis / Valkey (with TTLs; not the source of truth unless configured for durability) |
| Full-text search, faceting, log search | OpenSearch / Elasticsearch, or Postgres full-text at small scale |
| Vector similarity for RAG | pgvector for moderate scale, dedicated vector DB when scale or features demand |
| Time series metrics | TimescaleDB, ClickHouse, Prometheus |
| Analytical scans and aggregations | ClickHouse, BigQuery, Snowflake, DuckDB |
| Massive key-value with predictable access | DynamoDB / Cassandra (design around access patterns first) |
| Document-shaped aggregates with flexible schema | MongoDB, or Postgres JSONB |
| Blob storage | S3-compatible object storage |

---
name: backend-engineering
description: Designs and implements reliable, secure, maintainable backend services and APIs (REST, JSON over HTTP, background jobs, databases, caching, auth, queues) in any stack such as FastAPI, Django, Node/Express/NestJS, Go, or Spring. Use whenever the task involves an API endpoint, service layer, database schema or query, migration, authentication or authorization, validation, error handling, background workers, webhooks, rate limiting, idempotency, observability, or server-side architecture, even if the user only says "add an endpoint" or "store this in the database".
license: MIT
metadata:
  category: engineering
  version: "1.0"
---

# Backend Engineering

Build services that behave correctly under bad input, partial failure, retries, and concurrency. Follow the existing stack and conventions; apply these defaults where the project is silent.

## 0. Before writing code

1. Read the existing code for one comparable endpoint or use case end to end (route, validation, service, data access, tests, docs). Copy its shape.
2. Identify: framework and version, ORM or query layer, migration tool, auth mechanism, error format, logging and tracing setup, config system, how tests run.
3. Clarify the contract first: inputs, outputs, error cases, who may call it, expected volume, idempotency needs, consistency needs.
4. Decide what is synchronous (user waits) and what is asynchronous (queue, job).

## 1. Layered structure

```
transport (HTTP handler, gRPC, CLI, consumer)   thin: parse, authenticate, call use case, map result
   -> application / service (use cases)         orchestrates: transactions, authorization, workflows
      -> domain (entities, rules, value objects) pure logic; no I/O
      -> data access (repositories, queries)     SQL/ORM details, hidden behind functions
   -> integrations (payment, email, LLM APIs)    wrapped in adapters with timeouts and retries
```

- Handlers contain no business rules. Services contain no HTTP concepts (no `request`, no status codes).
- Domain errors are typed (`OrderNotFound`, `InsufficientStock`); the transport layer maps them to status codes in one place.
- Dependencies (DB session, clock, HTTP clients, config) are injected, so tests can substitute them.
- Keep modules organized by feature/bounded context. Start as a **modular monolith**; split into services only for real scaling, team, or isolation reasons.

## 2. Request lifecycle checklist

For every endpoint or consumer:

1. **Authenticate** (who is calling) then **authorize** (may they do *this* to *this object*). Check object-level ownership on every access by id.
2. **Validate** input at the boundary with a schema (Pydantic, Zod, Bean Validation, JSON Schema). Reject unknown or malformed fields; bound sizes, lengths, page sizes, and nesting.
3. **Execute** the use case inside a transaction where multiple writes must succeed or fail together.
4. **Respond** with a stable, documented shape; do not leak internals (stack traces, SQL, internal ids you do not intend to expose).
5. **Observe**: structured log with request id, latency metric, error metric, trace span.
6. **Test**: happy path, validation failures, auth failures, not found, conflict, and at least one failure of a dependency.

## 3. Error handling model

- Three classes: **client errors** (4xx: fix your request), **server errors** (5xx: our fault, retry may help), **dependency errors** (translate to 502/503/504 with retry hints).
- Return machine-readable errors, ideally RFC 9457 Problem Details (`application/problem+json` with `type`, `title`, `status`, `detail`, `instance`, plus extension fields such as `errors` for field-level validation).
- Never expose exception text or stack traces to clients; log them with a correlation id and return the id.
- Do not catch broad exceptions to hide them. Catch what you can handle; let the rest reach the global handler that logs and returns a 500 problem response.
- **Fail closed** on security decisions: if the authorization check errors, deny.
- Details: `references/api-design.md`.

## 4. Data and transactions

- The database is the source of truth for integrity: use primary keys, foreign keys, `NOT NULL`, `UNIQUE`, and `CHECK` constraints; do not rely on application code alone.
- Wrap multi-step writes in one transaction. Keep transactions short; never call external APIs inside one.
- Prevent lost updates: optimistic locking (version column) or `SELECT ... FOR UPDATE` where contention is expected.
- Avoid N+1 queries: eager load or batch. Inspect generated SQL in development.
- Use parameterized queries only. Never build SQL by string concatenation.
- Every schema change ships as a migration; use expand and contract for zero downtime.
- Index for the queries you actually run; verify with `EXPLAIN (ANALYZE, BUFFERS)`.
- Details: `references/database-and-migrations.md`.

## 5. Idempotency, retries, and asynchronous work

- Assume every request and message may be delivered more than once and out of order.
- `PUT` and `DELETE` are idempotent by design; make `POST` creation safe with an `Idempotency-Key` header stored with the result for a retention window.
- Queues give at-least-once delivery: make consumers idempotent (unique constraint on message id, upsert, or processed-events table).
- Use the **transactional outbox** pattern to publish events atomically with the database write.
- Long work goes to a background job: return `202 Accepted` with a status resource; jobs are retried with exponential backoff and jitter, have timeouts, and land in a dead-letter queue after max attempts.
- Scheduled jobs must tolerate overlap and missed runs (locks, leases, idempotent bodies).

## 6. Security defaults (short form; full list in `security-review`)

- Least privilege everywhere: DB users, IAM roles, API scopes.
- Secrets from environment or a secret manager; never in code, images, logs, or URLs.
- Hash passwords with Argon2id (or bcrypt or scrypt); never roll your own crypto.
- Rate limit authentication and expensive endpoints; cap payload sizes and request timeouts.
- Set CORS to an explicit allowlist; do not use `*` with credentials.
- Log security events (login failures, permission denials); never log secrets or full personal data.
- Details: `references/auth-and-sessions.md`.

## 7. Configuration and deployment readiness

- Config from environment variables, validated at startup (fail fast with clear messages). Same build artifact across environments (12-factor).
- Provide `/healthz` (liveness: process is up) and `/readyz` (readiness: dependencies reachable).
- Handle `SIGTERM`: stop accepting work, finish in-flight requests, close pools, then exit.
- Set explicit timeouts on every outbound call and on the server. Bound connection pools and worker concurrency.
- Log to stdout as structured JSON. Include `service`, `env`, `version`, `request_id`, `trace_id`.
- Details: `references/reliability-and-observability.md`.

## 8. Performance habits

- Paginate every list endpoint (cursor pagination for large or changing data). Cap `limit`.
- Select only needed columns; add covering or partial indexes for hot paths.
- Cache read-heavy, slow-changing data with explicit TTLs and invalidation rules; never cache per-user data under a shared key.
- Use connection pooling; avoid opening a connection per request.
- Do CPU-heavy or blocking work off the request path (worker, thread pool, process pool). In async runtimes never block the event loop.
- Measure before optimizing (see `performance-optimization`).

## 9. Definition of done

- [ ] Contract documented (OpenAPI or equivalent) and matches behavior
- [ ] Input validated and bounded; authz checked at object level
- [ ] Errors mapped consistently; no internals leaked
- [ ] Transactions, constraints, and idempotency considered
- [ ] Migrations reversible or safe (expand and contract); backfills batched
- [ ] Timeouts and retries on every outbound call
- [ ] Structured logs, metrics, and tracing for the new path
- [ ] Tests: unit for rules, integration against a real database, and contract tests for external interfaces
- [ ] No secrets in code or logs; dependencies pinned and scanned

## 10. Reference files

- `references/api-design.md`: resource modeling, methods and status codes, pagination, errors, versioning, webhooks, idempotency keys
- `references/database-and-migrations.md`: schema design, indexing, transactions, locking, zero-downtime migrations, connection pooling
- `references/auth-and-sessions.md`: authn vs authz, passwords, sessions vs tokens, OAuth2/OIDC, CSRF/CORS, multi-tenancy, API keys
- `references/reliability-and-observability.md`: timeouts, retries, circuit breakers, SLOs, logs/metrics/traces, incident basics

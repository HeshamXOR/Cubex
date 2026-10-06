# API design reference

## Contents
1. Resource modeling
2. Methods and semantics
3. Status codes
4. Request and response conventions
5. Pagination, filtering, sorting
6. Errors (RFC 9457)
7. Idempotency keys
8. Versioning and compatibility
9. Rate limiting and quotas
10. Webhooks
11. Documentation and contracts
12. When not to use REST

## 1. Resource modeling
- Nouns, plural, lowercase, hyphenated: `/orders`, `/orders/{orderId}/items`. Actions that do not fit CRUD become sub-resources or explicit action endpoints: `POST /orders/{id}/cancel`.
- Limit nesting to two levels; use query filters otherwise (`/items?orderId=...`).
- Identifiers are opaque strings (UUIDv4/v7, ULID, or prefixed ids like `ord_...`); never expose sequential ids that leak volume or invite enumeration.
- Use consistent field naming (`snake_case` or `camelCase`, choose one). Timestamps in RFC 3339 UTC (`2026-09-29T12:00:00Z`). Money as integer minor units plus a currency code, or a decimal string. Booleans as real booleans, not `"yes"`.
- Make responses self-describing: include ids, `created_at`, `updated_at`; consider `links` for related resources if clients navigate.

## 2. Methods and semantics

| Method | Safe | Idempotent | Use |
|---|---|---|---|
| GET | yes | yes | Read; never changes state; cacheable |
| HEAD / OPTIONS | yes | yes | Metadata / CORS preflight |
| POST | no | no (unless Idempotency-Key) | Create, or non-idempotent action |
| PUT | no | yes | Replace the whole resource at a known URL |
| PATCH | no | not guaranteed | Partial update (JSON Merge Patch or JSON Patch) |
| DELETE | no | yes | Remove; repeated delete returns 204 or 404 consistently |

## 3. Status codes

| Code | Meaning and use |
|---|---|
| 200 OK | Success with body |
| 201 Created | Resource created; include `Location` header and body |
| 202 Accepted | Work queued; return a status URL |
| 204 No Content | Success without body (DELETE, some PUT/PATCH) |
| 301/308 | Permanent redirects |
| 304 Not Modified | Conditional GET (ETag/If-None-Match) |
| 400 Bad Request | Malformed syntax or invalid parameters |
| 401 Unauthorized | Missing or invalid authentication (include `WWW-Authenticate`) |
| 403 Forbidden | Authenticated but not allowed |
| 404 Not Found | Resource does not exist (also to hide existence from unauthorized callers) |
| 405 Method Not Allowed | Include `Allow` header |
| 409 Conflict | State conflict: duplicate, version mismatch |
| 410 Gone | Permanently removed |
| 412 Precondition Failed | `If-Match` failed (optimistic concurrency) |
| 413 Content Too Large | Body exceeds limit |
| 415 Unsupported Media Type | Wrong `Content-Type` |
| 422 Unprocessable Content | Well-formed but semantically invalid (validation) |
| 429 Too Many Requests | Rate limited; include `Retry-After` |
| 500 Internal Server Error | Unexpected server fault |
| 502/503/504 | Bad upstream / unavailable (with `Retry-After`) / upstream timeout |

Pick 400 or 422 for validation and use it consistently across the API.

## 4. Request and response conventions
- `Content-Type: application/json; charset=utf-8`; accept only what you support. Ignore or reject unknown fields consistently (strict for writes is safer).
- Envelope or not: pick one. Lists as `{ "data": [...], "next_cursor": "..." }` leave room for metadata; a bare array cannot grow.
- Use `ETag` and `If-Match` for optimistic concurrency on updates; `If-None-Match` for cache validation.
- Compress responses (gzip/br). Set `Cache-Control` appropriately (`private, no-store` for sensitive data).
- Return the created or updated resource so clients avoid a second call.
- Use `null` versus absent consistently; document it. In PATCH, absent means "no change" and `null` means "clear".
- Bound everything: max body size, max array length, max string length, max query complexity.

## 5. Pagination, filtering, sorting
- **Cursor (keyset) pagination** for large or frequently changing collections: `?limit=50&cursor=opaque`. Response returns `next_cursor` (null at the end). Cursor encodes the last sort key plus a tie-breaker id, and is signed or opaque.
- Offset pagination (`?page=3&per_page=50`) only for small, stable sets or admin UIs; deep offsets are slow and unstable under inserts.
- Always enforce a default and maximum `limit` (for example 50 and 200).
- Filtering: simple equality as query params (`?status=paid&customer_id=...`); ranges `created_at[gte]=`; avoid inventing a query language unless needed.
- Sorting: `?sort=-created_at,name` with an allowlist of sortable fields (all indexed).
- Total counts are expensive; make them optional or approximate.

## 6. Errors (RFC 9457)
RFC 9457 (Problem Details for HTTP APIs, obsoletes RFC 7807) defines `application/problem+json`:
```json
HTTP/1.1 422 Unprocessable Content
Content-Type: application/problem+json

{
  "type": "https://api.example.com/problems/validation-error",
  "title": "Your request parameters didn't validate.",
  "status": 422,
  "detail": "One or more fields are invalid.",
  "instance": "/orders/123",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "errors": [
    { "pointer": "/items/0/quantity", "message": "must be at least 1" }
  ]
}
```
- `type` is a stable URI identifying the problem class (clients switch on it, not on `title` or `detail`); `title` is a short human summary; `detail` is instance-specific.
- Add extension members for machine handling (`errors`, `balance`, `retry_after`).
- Do not put sensitive information in `detail`. Use the same shape for every error, including 404, 401, and 500.

## 7. Idempotency keys
For non-idempotent `POST` (payments, orders):
1. Client sends `Idempotency-Key: <uuid>` and retries with the same key and same body.
2. Server stores `(key, request fingerprint, response, status)` atomically with the operation, scoped per tenant/user, retained 24 hours or longer.
3. Same key + same request: return the stored response. Same key + different body: 422 or 409. Concurrent duplicate while in progress: 409 or wait.
4. Use a unique constraint on the key so races resolve in the database.

## 8. Versioning and compatibility
- Prefer additive evolution: add optional fields, add endpoints; never remove or repurpose fields, change types, or tighten validation silently.
- Clients must ignore unknown response fields (document this); servers must ignore unknown headers.
- When breaking changes are unavoidable: new version in the URL (`/v2`) or header, run both, publish a deprecation timeline with `Deprecation` and `Sunset` headers, monitor usage per version, then remove.
- Contract tests (Pact, schemathesis, Dredd) and OpenAPI diff tools (`oasdiff`) in CI catch accidental breaks.
- Enums: treat as open sets; clients must handle unknown values.

## 9. Rate limiting and quotas
- Limit per identity (API key or user), falling back to IP for anonymous traffic; separate stricter buckets for login, password reset, and expensive search.
- Algorithms: token bucket or sliding window, stored in Redis or the gateway.
- Respond `429` with `Retry-After`; expose `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (IETF draft headers) if useful.
- Also cap concurrency and request cost (page size, GraphQL depth) to prevent resource exhaustion.

## 10. Webhooks
- Sign payloads (HMAC-SHA256 over timestamp plus body); include timestamp and reject old ones (5 minutes) to stop replay; provide a secret rotation path.
- Deliver at least once with retries and exponential backoff for days; include a unique event id so receivers dedupe.
- Receivers: verify signature on the raw body, respond `2xx` quickly, process asynchronously, and be idempotent.
- Provide event replay and a delivery log UI or API.
- Guard outbound webhook calls against SSRF (block private and link-local ranges, resolve then connect, limit redirects).

## 11. Documentation and contracts
- OpenAPI 3.1 as the source of truth (design-first or generated, but always verified). Include examples, error responses, auth schemes, and rate limits.
- Generate clients and server stubs where useful; lint the spec (Spectral).
- Provide a changelog and a getting-started example with `curl`.

## 12. When not to use REST
- **GraphQL**: many client shapes over a graph of data, mobile bandwidth concerns; requires query cost limits, depth limits, persisted queries, and field-level authorization.
- **gRPC**: internal service to service, strong typing, streaming, low latency.
- **WebSocket / SSE**: server push, live updates (SSE is simpler for one-way streams).
- **Async messaging** (queues, events): decoupled workflows and fan-out.

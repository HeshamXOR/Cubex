# Reliability and observability

## Contents
1. Failure is normal: design principles
2. Timeouts, retries, backoff
3. Circuit breakers, bulkheads, load shedding
4. Graceful degradation and fallbacks
5. Queues and backpressure
6. Deployments and change safety
7. SLIs, SLOs, error budgets
8. The three pillars: logs, metrics, traces
9. Alerting
10. Incident response
11. Checklist

## 1. Failure is normal: design principles
- Every network call can be slow, fail, or return garbage. Every dependency will have an outage. Design for partial failure.
- Prefer **fail fast** over hanging; prefer **degrade** over collapse; prefer **idempotent** operations so retries are safe.
- Make state recoverable: durable queues, transactional outbox, checkpointing.
- Keep blast radius small: feature flags, cell-based deployments, per-tenant limits.

## 2. Timeouts, retries, backoff
- **Set a timeout on every outbound call** (connect and read/total). No default infinite timeouts. Budget them: the caller's timeout must exceed the callee's plus margin; propagate deadlines.
- **Retry only when safe**: idempotent operations or those with idempotency keys; only on transient errors (timeouts, connection reset, 429, 502, 503, 504), never on 4xx validation errors.
- **Exponential backoff with jitter** (for example `sleep = random(0, min(cap, base * 2^attempt))`); cap attempts (3 to 5); respect `Retry-After`.
- Beware **retry amplification**: retries at each layer multiply load (3 layers x 3 retries = 27x). Retry at one layer, use retry budgets (for example at most 10% extra traffic).
- Hedged requests only for read paths with idempotency and tail-latency problems.

## 3. Circuit breakers, bulkheads, load shedding
- **Circuit breaker**: after N failures or a failure rate threshold, open (fail immediately), then half-open to probe. Avoids piling on a struggling dependency and frees resources.
- **Bulkhead**: separate pools (threads, connections, concurrency limits) per dependency so one slow service cannot exhaust all capacity.
- **Load shedding**: when saturated, reject early (429/503) for low-priority traffic instead of queueing unboundedly. Use concurrency limits and bounded queues.
- **Rate limiting** protects the service; **backpressure** propagates saturation upstream.

## 4. Graceful degradation and fallbacks
- Decide per feature: what does the product do when this dependency is down? Serve cached/stale data, hide the widget, queue the action, show a clear message.
- Distinguish critical path (checkout) from optional path (recommendations); optional failures must not fail requests.
- Fallbacks must be tested; untested fallbacks fail when needed.

## 5. Queues and backpressure
- Queues decouple, buffer bursts, and enable retries, but unbounded queues hide overload. Monitor queue depth and age of the oldest message.
- Consumers: idempotent, bounded concurrency, visibility timeout longer than processing time, poison-message handling with dead-letter queues and alerts.
- Ordering only where needed (partition/key per entity); global ordering does not scale.
- Exactly-once processing is achieved by at-least-once delivery plus idempotent handling.

## 6. Deployments and change safety
- Small, frequent, reversible releases. Roll out with canary or progressive delivery; automated rollback on SLO regression.
- Feature flags decouple deploy from release; clean them up after rollout.
- Database changes follow expand and contract so the previous version keeps working during rollout.
- Health checks: readiness gates traffic; liveness restarts stuck processes; startup probes for slow boots. Do not include downstream dependency checks in liveness (causes restart storms).
- Graceful shutdown: on `SIGTERM`, fail readiness, drain in-flight requests within a grace period, close resources.

## 7. SLIs, SLOs, error budgets
- **SLI**: measurable indicator (proportion of requests that succeed; proportion under 300 ms). **SLO**: target over a window (99.9% over 30 days). **Error budget**: `1 - SLO`; spend it on releases and risk; when exhausted, prioritize reliability work.
- Choose SLIs from the user's perspective: availability, latency (p50, p95, p99), correctness/freshness, throughput where relevant.
- Use percentiles, not averages. Track error rate by route and customer tier.

## 8. The three pillars: logs, metrics, traces
Use **OpenTelemetry** SDKs and the OTLP protocol to stay vendor neutral, with auto-instrumentation for HTTP, DB, and queue clients.

**Logs** (events, high detail)
- Structured JSON to stdout; one event per line; consistent keys: `timestamp`, `level`, `message`, `service`, `env`, `version`, `request_id`, `trace_id`, `user_id` (id, not PII), `duration_ms`, `error.type`, `error.stack`.
- Log at boundaries (request start/end, external calls, state transitions), not inside hot loops. Sample verbose logs.
- Never log secrets, tokens, passwords, full card numbers, or unnecessary personal data; scrub at the logger.

**Metrics** (numbers over time, cheap)
- Golden signals: **latency, traffic, errors, saturation** (Google SRE). For resources use USE (utilization, saturation, errors); for services use RED (rate, errors, duration).
- Use histograms for latency; keep label cardinality low (route template, status class, not raw user ids or full URLs).
- Business metrics too: signups, payments, jobs completed.

**Traces** (request path across services)
- Propagate context (W3C `traceparent`) through HTTP headers, message headers, and job payloads.
- Add spans around meaningful work; attach attributes (route, db.statement sanitized, peer service); sample smartly (tail-based for errors and slow requests).
- Correlate: put `trace_id` into logs so an alert leads to the trace and then to logs.

## 9. Alerting
- Alert on **symptoms users feel** (SLO burn rate, error rate, latency) rather than every cause (CPU 80%).
- Multi-window burn-rate alerts (fast burn pages, slow burn tickets) reduce noise.
- Every page has: a runbook link, dashboard link, owner, and clear action. Delete or downgrade alerts that are routinely ignored.
- Add synthetic probes for critical journeys and external dependency checks.

## 10. Incident response
1. **Detect and declare**: assign an incident commander and a communications lead.
2. **Mitigate first**: roll back, disable the flag, fail over, scale, shed load. Diagnose after users are safe.
3. **Communicate**: status page, stakeholders, regular updates with the next update time.
4. **Investigate** with the timeline of deploys, config changes, traffic, and dependency status.
5. **Blameless postmortem** within days: timeline, impact, root causes and contributing factors (five whys), what went well, action items with owners and dates. Track completion.

## 11. Checklist
- [ ] Timeouts on all outbound calls and server side
- [ ] Retries only for idempotent/transient failures, with backoff, jitter, and caps
- [ ] Circuit breaker or concurrency limit on critical dependencies
- [ ] Health, readiness, and graceful shutdown implemented
- [ ] Structured logs with request and trace ids; secrets scrubbed
- [ ] RED/golden-signal metrics and dashboards per service
- [ ] Traces propagate across services and jobs
- [ ] SLOs defined; alerts on burn rate; runbooks linked
- [ ] Load tested at expected peak plus headroom; failure injection tried for key dependencies
- [ ] Backups restored in a drill; rollback rehearsed

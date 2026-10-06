---
name: performance-optimization
description: Finds and removes performance bottlenecks in code, databases, services, and pipelines using a measure-first method: define targets, benchmark, profile, form a hypothesis, change one thing, and verify. Covers algorithmic complexity, memory, I/O, concurrency, caching, database query tuning, and latency percentiles, with tools per language. Use whenever the user reports slowness, high latency, timeouts, high CPU or memory, poor throughput, slow builds or queries, or asks to optimize, profile, benchmark, or scale something.
license: MIT
metadata:
  category: engineering
  version: "1.0"
---

# Performance Optimization

Premature optimization wastes time and harms clarity; unmeasured optimization is guessing. The discipline is: **measure, find the bottleneck, fix the biggest one, measure again**.

## 1. Method

1. **Define the goal** as a user-visible number with a percentile and conditions: "p95 of `GET /search` under 300 ms at 200 rps on the production dataset", not "make it faster". Know the budget and whether it is latency, throughput, memory, cost, or startup time.
2. **Reproduce and baseline.** Build a repeatable benchmark or load test using realistic data sizes and access patterns. Record environment, versions, and results before changing anything.
3. **Profile to find where time goes.** Use the right profiler (CPU, wall-clock, memory, I/O, locks). Look at the top of the flame graph and cumulative time by function. Trust measurements over intuition; the bottleneck is often surprising.
4. **Apply Amdahl's law.** Optimizing a part that is 5% of total time yields at most 5% gain. Attack the largest contributor.
5. **Hypothesize, change one thing, measure.** Keep only changes that show a statistically meaningful improvement. Revert the rest.
6. **Guard against regressions** with benchmarks or performance tests in CI, budgets, and production monitoring (SLOs, RUM for frontend).
7. **Stop when the goal is met.** Record what was learned and the trade-offs accepted.

## 2. Order of attack (largest wins first)

1. **Do less work**: remove unnecessary calls, queries, renders, and data. Avoid recomputation and redundant serialization.
2. **Better algorithm and data structure**: reduce complexity (O(n^2) to O(n log n) or O(n)); use hash maps and sets for lookups, heaps for top-k, sorting plus binary search, streaming instead of materializing, indexes instead of scans.
3. **Batch and reduce round trips**: one query instead of N, bulk inserts, pipelining, connection reuse, HTTP/2, request coalescing.
4. **Cache** results that are expensive and repeatedly requested (see caching rules below).
5. **Parallelize or go async** for independent I/O (async, thread pools) or CPU work (processes, native code, vectorization).
6. **Reduce memory pressure and allocation**: reuse buffers, avoid copies, stream, choose compact types; lower GC pause and cache-miss cost.
7. **Micro-optimize** hot loops last, only after profiling says so.

## 3. Layer-specific guidance

### Application code
- Watch for accidental quadratic behavior: nested loops over collections, repeated `list.index`/`in list`, string concatenation in loops, repeated regex compilation, repeated parsing of the same data.
- Prefer vectorized operations (NumPy, Polars, pandas built-ins) over Python loops for numeric data; avoid `apply` with row-wise Python functions on big frames.
- Serialization is often hot: use efficient formats (orjson, msgpack, protobuf), avoid re-encoding, and trim payloads.
- Watch lock contention and shared mutable state; prefer immutable data, sharding, or lock-free structures.
- In async runtimes never block the event loop with CPU work or synchronous I/O; offload to workers.

### Databases
- Find the slow queries first (`pg_stat_statements`, slow query log, APM traces), then run `EXPLAIN (ANALYZE, BUFFERS)`.
- Typical fixes: add or correct an index (composite order, partial, covering), remove functions on indexed columns, replace OFFSET with keyset pagination, fix N+1, select fewer columns, batch writes, shorten transactions, vacuum/analyze, denormalize or precompute for hot reads, partition large tables, add read replicas.
- Beware over-indexing (write cost) and stale statistics (bad plans).
- See `backend-engineering/references/database-and-migrations.md`.

### Network and services
- Reduce chattiness and payload size; enable compression; use keep-alive and connection pools; colocate services; use CDNs for static and cacheable content.
- Tail latency dominates user experience: track p95/p99, limit fan-out (the slowest of N calls sets latency), use timeouts, hedging, and load shedding.
- Queueing theory matters: latency grows sharply as utilization approaches 100%. Keep headroom (target roughly 60 to 70% utilization at peak).

### Frontend
- Follow Core Web Vitals targets and fixes in `frontend-engineering/references/performance.md`: ship less JS, prioritize the LCP resource, break up long tasks, reserve layout space.

### Memory
- Detect leaks by watching resident memory over time under steady load, then diff heap snapshots. Common causes: unbounded caches or maps, retained closures and listeners, global registries, unclosed resources, accumulating logs/metrics labels.
- Cap caches (LRU with size limits); stream large files; use generators/iterators; tune GC only after reducing allocation.

### Build and CI speed
- Cache dependencies and build outputs, parallelize tests, skip unaffected work (affected-only builds), use incremental compilers, prune the dependency graph, and profile the pipeline itself.

## 4. Caching rules

- Cache only after measuring; ask whether the computation can simply be made cheaper or avoided.
- Define key, value, TTL, size bound, and invalidation before writing code. "There are only two hard things: cache invalidation and naming things."
- Include all inputs that change the result in the key (tenant, user, locale, version, permissions). Never share personalized data under a shared key.
- Patterns: cache-aside (app populates on miss), read-through, write-through/behind (carefully), CDN edge caching, memoization for pure functions, HTTP caching (`Cache-Control`, `ETag`), stale-while-revalidate.
- Prevent stampedes: request coalescing/single-flight, jittered TTLs, background refresh, locks.
- Monitor hit ratio, evictions, latency, and staleness. Ensure correctness when the cache is cold or down.

## 5. Benchmark hygiene

- Use realistic data volumes, distributions, and concurrency; empty tables lie.
- Warm up (JIT, caches, connection pools) and discard warmup samples.
- Run multiple iterations; report median and spread (p50/p95/p99, std dev) instead of a single number; use tools that handle statistics (`hyperfine`, `pytest-benchmark`, `criterion`, JMH, `benchstat`, `k6`, `wrk2`, `vegeta`, Locust).
- Avoid coordinated omission in load tests: use open-loop generators (fixed arrival rate) to measure latency under load properly.
- Isolate noise: dedicated machine, pinned CPU frequency, no background jobs, same build type (release, optimizations on).
- Compare like with like: same input, same environment, one change at a time.
- Benchmarks of microcode can mislead (compiler optimizations, cache effects); validate improvements on end-to-end workloads.

## 6. Profiling toolbox

| Ecosystem | Tools |
|---|---|
| Python | `cProfile` + `snakeviz`, `py-spy` (sampling, attach to running process, flame graphs), `scalene` (CPU/memory), `pyinstrument`, `tracemalloc`, `memray`, `line_profiler` |
| Node.js | `node --prof`, `--cpu-prof`, `clinic.js` (doctor, flame, bubbleprof), Chrome DevTools via `--inspect`, heap snapshots, `0x` |
| Browser | DevTools Performance and Lighthouse, Performance Insights, React Profiler, `web-vitals` RUM |
| Go | `pprof` (CPU, heap, goroutine, mutex, block), `go test -bench -benchmem`, `trace` |
| JVM | JFR (Java Flight Recorder), async-profiler, JMH, VisualVM |
| Rust/C/C++ | `perf`, flamegraph, `valgrind --tool=callgrind`, `heaptrack`, `criterion` |
| System | `top/htop`, `vmstat`, `iostat`, `pidstat`, `strace -c`, `perf top`, `bpftrace`, `ss`, eBPF-based continuous profilers (Parca, Pyroscope) |
| Database | `EXPLAIN ANALYZE`, `pg_stat_statements`, slow query logs, `auto_explain`, `pgBadger` |
| Distributed | OpenTelemetry traces, APM (Datadog, New Relic, Honeycomb, Grafana Tempo) |

Prefer sampling profilers in production (low overhead) and continuous profiling for regressions.

## 7. Common pitfalls

- Optimizing without a baseline, or measuring in a debug build, cold cache, or tiny dataset
- Micro-optimizing the wrong layer while a single slow query dominates
- Trading correctness or clarity for a gain that does not matter
- Adding caches that hide bugs or serve stale or cross-tenant data
- Ignoring tail latency and reporting only averages
- Raising concurrency until downstream systems (database, third-party APIs) fall over; respect their limits
- Over-parallelizing small tasks (overhead exceeds gains)
- Forgetting cost: faster but 5x more expensive may not be a win

## 8. Report template

```
Goal: <metric, percentile, target, conditions>
Baseline: <numbers, environment, how measured>
Findings: <profile summary: where time goes, top bottleneck with evidence>
Changes: <what changed and why, one per item>
Results: <before/after with variance>
Trade-offs: <memory, complexity, staleness, cost>
Guardrails: <benchmarks/alerts/budgets added>
Next: <remaining opportunities ranked by expected gain>
```

---
name: debugging
description: A systematic, evidence-driven method for finding and fixing bugs, crashes, wrong output, flaky tests, performance regressions, race conditions, memory leaks, and environment-specific failures. Use whenever something is broken, throws an error, behaves differently than expected, works locally but fails elsewhere, fails intermittently, or the user pastes a stack trace or error log, even if they only say "this doesn't work" or "why is this happening".
license: MIT
metadata:
  category: engineering
  version: "1.0"
---

# Debugging

Debugging is applied science: observe, hypothesize, test, conclude. Guessing and shotgun edits waste time and hide root causes.

## The method

1. **Read the evidence first.** Read the entire error message and stack trace, from the bottom (root cause, first frame in your code) to the top. Note exact text, exit codes, versions, timestamps, and inputs. Do not paraphrase errors from memory.
2. **Reproduce reliably.** Get a command or test that fails every time. Record the exact environment (OS, runtime, dependency versions, config, data). If intermittent, find what varies (timing, ordering, data, concurrency, environment) and make it deterministic (fixed seeds, fake clocks, single thread) or increase the failure rate (loops, stress).
3. **Minimize.** Shrink the input, code, and configuration until the smallest case still fails. Delete things that do not matter. A minimal reproduction often reveals the cause on its own.
4. **Localize.** Narrow where it goes wrong:
   - Trace data flow: where is the first place a value becomes wrong? Print or inspect at boundaries.
   - **Binary search** code paths, inputs, commits (`git bisect run`), or config (disable half).
   - Compare a working case with a failing case (diff inputs, environments, versions, requests).
5. **Hypothesize.** Write a specific, falsifiable hypothesis: "The cache returns stale data because the key omits the tenant id." List a few competing hypotheses and rank by likelihood and cost to test.
6. **Test the hypothesis** with the cheapest decisive experiment (a log line, an assertion, a debugger breakpoint, a unit test, changing one variable). Change **one thing at a time**. Predict the outcome before running.
7. **Fix the root cause,** not the symptom. Ask "why" until the answer is a change you can make (five whys). Avoid try/except that hides the error, retries that mask races, or sleeps that hide ordering bugs.
8. **Prove the fix.** Add a regression test that fails before and passes after. Run the wider suite. Re-run the original reproduction.
9. **Look for siblings.** Search for the same pattern elsewhere. Consider whether tooling (lint rule, type, assertion) could prevent the class of bug.
10. **Report** the cause, the fix, and how it was verified.

## Instrumentation toolbox

- **Assertions and invariants** at boundaries catch bad state close to its origin.
- **Logging**: log inputs, decisions, and outputs with identifiers; use levels; add temporary logs but remove them (or downgrade to debug) afterward.
- **Debugger**: breakpoints, conditional breakpoints, watch expressions, step into or over, inspect the call stack, post-mortem on crash (`pdb.post_mortem`, `node --inspect`, `dlv`, IDE debuggers).
- **REPL / scratch script** to call the suspicious function with the failing input directly.
- **Network and system**: browser DevTools Network tab, `curl -v`, `tcpdump`/Wireshark, `strace`/`dtruss`, `lsof`, `ss -tulpn`.
- **Diff tools**: `git diff`, `git bisect`, dependency diffs (`pip freeze`, lockfile diffs), config diffs, environment diffs (`env | sort`).
- **Profilers / tracers**: see `performance-optimization`; distributed traces for cross-service issues.

## Symptom playbook

**Works locally, fails in CI or production**
Compare: OS and architecture, runtime and dependency versions (lockfile respected?), environment variables and secrets, file paths and case sensitivity, locale and time zone, network access and DNS, resource limits (memory, file descriptors), build vs dev mode (minification, tree shaking, env-specific flags), data differences, permissions, clock skew.

**Intermittent or flaky**
Suspect: race conditions, shared mutable state across tests, test order dependence, time and date assumptions, randomness, external services, resource exhaustion, unawaited promises or tasks, eventual consistency. Run in a loop, randomize order, add timestamps and thread ids to logs, use deterministic clocks and seeds, and check for leaked state between tests.

**Race conditions and concurrency**
Look for check-then-act, read-modify-write, unsynchronized shared data, missing awaits, callbacks ordering, transactions with insufficient isolation, duplicate message delivery. Fix with atomic operations, locks or queues, database constraints, idempotency, or by eliminating shared state. Use race detectors (`go test -race`, ThreadSanitizer) and stress tests.

**Wrong output, no error**
Print intermediate values along the pipeline to find the first divergence. Check types and coercion, off-by-one and boundary values, integer overflow, float rounding, encoding (UTF-8 vs others), time zones and DST, mutation of shared objects, sort stability, default arguments, and integer vs float division.

**Null or undefined errors**
Find where the value originated, not where it crashed. Check optional data from APIs, uninitialized state, async timing (used before loaded), and mismatched keys or casing.

**Performance regression**
Reproduce with a benchmark, bisect commits, profile (CPU, allocations, I/O), check query plans and N+1s, cache misses, payload size growth, and dependency upgrades. Never optimize without measuring.

**Memory leak or growth**
Take heap snapshots over time and diff (Chrome DevTools, `tracemalloc`, `heapdump`, `pprof`), look for unbounded caches, listeners never removed, closures retaining large objects, global collections, unclosed resources.

**Build or dependency problems**
Read the first error, not the last. Clean caches and rebuild, check version constraints and lockfile drift, peer dependency conflicts, platform-specific binaries, and toolchain versions. Search the exact error with the library name and version.

**Flaky UI or end-to-end tests**
Replace fixed sleeps with waits on observable conditions; ensure selectors are stable (role/label based); isolate test data; check animations, network mocking, and viewport differences; capture traces and videos on failure.

**"It was working yesterday"**
Find what changed: `git log`, deploys, config, dependency updates (unpinned versions), certificate or token expiry, data growth, feature flags, upstream API changes, time-based conditions. Bisect.

## Reading stack traces well

- Find the innermost frame in *your* code; the bug is usually there or one call above.
- Note the exception type and message text; search the exact message in quotes with the library version.
- Check "caused by" chains; the root cause is at the end.
- For async traces, the origin may be lost; enable async stack traces (`--async-stack-traces`, longer stack options) or add context.
- Minified frontend stacks need source maps.

## Anti-patterns

- Changing several things at once, then not knowing which fixed it
- Fixing where the error surfaced instead of where the bad state began
- Adding retries, sleeps, or broad try/except to make errors disappear
- Assuming instead of verifying: "that can't be null", "the config is loaded"
- Trusting comments, names, or documentation over actual behavior
- Debugging in production without safeguards or a way to roll back
- Declaring victory without a regression test
- Blaming the compiler, library, or hardware before ruling out your own code (rare, but confirm with a minimal repro before concluding)

## When stuck

- Explain the problem step by step aloud or in writing (rubber duck); state what you know for certain versus assume.
- List assumptions and test each one directly.
- Take a break or change the angle: look at the system from the data side, network side, or version-history side.
- Simplify: revert to the last known good state and reapply changes gradually.
- Ask with a minimal reproducible example, exact versions, expected versus actual behavior, and what you already tried.

## Root-cause report template

```
Symptom: what users/tests saw, when it started, scope
Reproduction: exact steps or command
Root cause: the specific defect and why it produced the symptom
Fix: what changed and why this addresses the root cause
Verification: regression test added, suites run, manual checks
Prevention: tests, alerts, types, lint, docs, process changes
```

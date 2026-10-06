---
name: testing-strategy
description: Designs and writes effective automated tests (unit, integration, contract, end-to-end, property-based) and decides what to test, how, and at which level. Covers test structure, doubles and mocking policy, determinism, flaky tests, test data, TDD, coverage and mutation testing, and framework patterns for pytest, Jest/Vitest, Testing Library, and Playwright. Use whenever the user asks to add tests, improve coverage, fix flaky tests, practice TDD, review a test suite, or when implementing a feature or bug fix that needs proof it works.
license: MIT
metadata:
  category: engineering
  version: "1.0"
---

# Testing Strategy

Tests exist to give fast, trustworthy feedback that behavior still works, and to document intent. Value comes from confidence per unit of maintenance cost.

## 1. What to test (and what not)

Test **behavior through public interfaces**, not implementation details. A good test survives refactoring and fails only when observable behavior breaks.

Prioritize by risk = probability of bugs x impact:
- Core business rules and calculations (pricing, permissions, state machines)
- Boundaries and edge cases (empty, one, many, max, negative, zero, duplicates, unicode, time zones, leap days)
- Failure paths (invalid input, timeouts, dependency errors, partial failure, retries)
- Security-critical logic (authorization, input validation, tenant isolation)
- Integrations you own (DB queries, migrations, serialization, message handlers)
- Regressions: every fixed bug gets a test that fails without the fix
- Critical user journeys end to end (a handful)

Usually skip: trivial getters and setters, framework internals, generated code, pure configuration, third-party library behavior (test your usage at the boundary instead).

## 2. Test levels (use a balanced shape)

| Level | Scope | Speed | Use for |
|---|---|---|---|
| Unit | One function, class, or component; no I/O | milliseconds | Logic, rules, transformations, edge cases |
| Integration | Several units with real collaborators (real DB, real HTTP layer, in-memory queue) | tens to hundreds of ms | Data access, API handlers, wiring, serialization, migrations |
| Contract | Consumer and provider agree on an interface | fast | Service boundaries, third-party APIs, webhooks |
| End-to-end (E2E) | Full system through UI or public API | seconds | A few critical journeys; smoke tests after deploy |
| Non-functional | Load, security, accessibility, visual | varies | Targeted, in CI or scheduled |

Shape guidance: many fast unit tests for logic, a solid layer of integration tests (often the best value for services and frontends), few E2E tests. For UI-heavy apps the "testing trophy" (mostly integration-style component tests) often fits; for algorithm-heavy code the classic pyramid does. Choose by where bugs actually occur.

## 3. Test anatomy

- **Arrange, Act, Assert** (or Given, When, Then). One behavior per test; a few related assertions are fine, unrelated ones are not.
- **Names describe behavior and condition**: `test_refund_rejected_when_order_is_older_than_30_days`; `it("shows an error when the email is invalid")`.
- Keep tests **independent**: no shared mutable state, no required order; each test sets up and cleans up its own data.
- Keep tests **readable**: the test explains the scenario without reading helpers. Prefer explicit inline data for the values that matter and builders/factories for the rest.
- Use **table-driven / parametrized tests** for many input-output cases (`pytest.mark.parametrize`, `it.each`).
- Assertions should be specific and helpful: compare whole values, check error types and messages, avoid `assert result` on truthiness when equality is meant.
- Avoid logic (loops, conditionals) in tests; it hides bugs in the test itself.

## 4. Test doubles policy

- Prefer **real collaborators** when cheap and deterministic (pure functions, in-memory implementations, real database in a container).
- Use **fakes** (working lightweight implementations) for slow or external systems you control the interface to (in-memory repository, fake clock, fake email sender).
- Use **stubs** to feed canned responses; **spies/mocks** to verify a side effect that is itself the requirement (email was sent once). Avoid verifying internal call sequences; it locks in implementation.
- **Mock at the boundary you own**, not third-party internals: wrap the SDK in an adapter and fake the adapter. For HTTP use recorded fixtures or servers (`responses`, `respx`, `nock`, MSW, WireMock).
- Do not mock the thing under test. If setup requires mocking many things, the design has too many dependencies.
- Keep doubles honest with contract tests against the real service occasionally.

## 5. Determinism and flakiness

A flaky test is worse than none; it teaches people to ignore failures. Eliminate root causes:
- **Time**: inject a clock; freeze time (`freezegun`, `time-machine`, `vi.useFakeTimers`); never depend on wall-clock or time zone.
- **Randomness**: seed it or inject it; log the seed on failure.
- **Order**: run in random order in CI (`pytest-randomly`); fix hidden dependencies.
- **Concurrency/async**: await conditions, not sleeps. Poll with timeouts (`waitFor`, `expect.poll`, `tenacity`), use synchronization primitives, avoid arbitrary `sleep`.
- **External services**: replace with local fakes; never call real third parties in unit or integration tests.
- **Shared state**: isolate DB per test (transaction rollback, truncate, unique schemas, or containers per worker); unique data (random suffixes) for shared environments.
- **Environment**: pin versions; avoid reliance on file system locations, ports (use ephemeral ports), or machine speed.
- Quarantine known-flaky tests with a ticket and deadline; do not silently retry forever. Retries in CI can mask real bugs; track retry rates.

## 6. Test data

- Use **builders/factories** (`factory_boy`, `fishery`, custom functions) with sensible defaults and overrides for the fields the test cares about.
- Avoid giant shared fixtures with mystery data; prefer small, local, obvious data.
- Anonymize any production-derived data; never commit real personal data.
- For DB tests, apply real migrations to build the schema so tests catch migration bugs.

## 7. TDD and bug-fix workflow

**Red, Green, Refactor**: write a failing test for the next small behavior, make it pass with the simplest code, then refactor with tests green. Excellent for well-defined logic and bug fixes; use judgment for exploratory UI or spikes (write tests after once the design settles).

**Bug fix**: reproduce with a failing test first, fix, watch it pass, keep the test.

## 8. Coverage and quality signals

- Coverage shows what is *not* tested; it does not prove tests are good. Use it to find gaps, not as a target to game. Reasonable guardrails: no coverage decrease on changed lines, high coverage on core logic.
- **Mutation testing** (mutmut, cosmic-ray, Stryker, PIT) measures whether tests detect injected bugs; run on critical modules periodically.
- **Property-based testing** (Hypothesis, fast-check) generates inputs to check invariants: round-trip (`decode(encode(x)) == x`), idempotence, ordering, "never crashes", model vs implementation. Great for parsers, serializers, math, and state machines. Shrinking gives minimal counterexamples.
- Snapshot tests are brittle if large or unreviewed: keep them small and intentional, review diffs, and never approve blindly.
- Track test suite duration and flake rate; keep the feedback loop under a few minutes for the main gate.

## 9. Frontend and E2E specifics

- Component tests: render, interact with `userEvent`, assert on what the user sees; query by role, label, and text (accessible queries). Mock the network with MSW.
- E2E (Playwright, Cypress): few, stable journeys; use auto-waiting locators (`getByRole`), isolate data per test, avoid dependence on animations, run in CI with traces/screenshots/videos on failure; parallelize with independent test data; run against a production-like build.
- Visual regression for design-system components with stable rendering environments.
- Accessibility checks (`axe`) inside component and E2E tests.

## 10. Backend and data specifics

- Test API handlers through the HTTP layer with a test client (`TestClient`, `supertest`, `httpx`), including auth, validation errors, and error format.
- Use a real database (containers via Testcontainers or a service in CI) for repository and migration tests; SQLite in place of Postgres hides dialect differences.
- Test transactions, constraints, concurrency-sensitive paths, and idempotency (send the same message twice).
- Contract tests for consumed and provided APIs; schema validation of responses against OpenAPI.
- For pipelines and data code: test transformations on small fixtures, schema expectations, null and duplicate handling, and idempotent reruns (`great_expectations`, `pandera`, dbt tests).
- For LLM features: see `llm-application-engineering` (evals rather than exact-match tests).

## 11. Review checklist for a test suite

- [ ] Each test fails for one reason and has a name that says which
- [ ] Bugs would be caught: try deleting or altering production logic (mutation thinking) and see tests fail
- [ ] No sleeps, no real network, no order dependence, no leaked state
- [ ] Failure output is diagnosable without a debugger
- [ ] Fast enough to run before every commit
- [ ] Tests do not duplicate implementation logic in the assertions
- [ ] Edge cases and error paths are covered, not only the happy path

## Reference files

- `references/test-patterns.md`: concrete pytest, Vitest/Jest, Testing Library, and Playwright examples plus patterns for time, HTTP, databases, and async

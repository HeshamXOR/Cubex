# Test patterns and examples

## Contents
1. pytest patterns
2. Vitest / Jest patterns
3. React Testing Library
4. Playwright end-to-end
5. Time, randomness, and async
6. HTTP and API tests
7. Database tests
8. Property-based tests
9. Golden files and snapshots

## 1. pytest patterns
```python
import pytest

# parametrization
@pytest.mark.parametrize(
    "amount, tier, expected",
    [(100, "gold", 90), (100, "basic", 100), (0, "gold", 0)],
    ids=["gold-discount", "no-discount", "zero-amount"],
)
def test_apply_discount(amount, tier, expected):
    assert apply_discount(amount, tier) == expected

# expected exceptions with message check
def test_rejects_negative_amount():
    with pytest.raises(ValueError, match="amount must be non-negative"):
        apply_discount(-1, "gold")

# fixtures: small, explicit, composable
@pytest.fixture
def order(make_order):            # make_order is a factory fixture
    return make_order(items=[("A", 2), ("B", 1)], customer_tier="gold")

# factory fixture
@pytest.fixture
def make_order():
    def _make(items, customer_tier="basic"):
        return Order(items=[Item(sku=s, qty=q) for s, q in items],
                     customer=Customer(tier=customer_tier))
    return _make

# tmp files and monkeypatching environment
def test_reads_config(tmp_path, monkeypatch):
    (tmp_path / "app.toml").write_text('name = "x"')
    monkeypatch.setenv("APP_CONFIG", str(tmp_path / "app.toml"))
    assert load_config().name == "x"
```
Tips: keep `conftest.py` fixtures shallow; use `pytest.approx` for floats; mark slow tests (`@pytest.mark.slow`) and run the fast set by default; `-x -q` while iterating; `--lf` reruns last failures; `-p no:randomly` only for debugging order issues.

## 2. Vitest / Jest patterns
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("retry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("retries transient failures with backoff and then succeeds", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce("ok");
    const p = retry(fn, { maxAttempts: 3, baseDelayMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it.each([
    [0, "free"], [1, "basic"], [10, "pro"],
  ])("maps %i seats to plan %s", (seats, plan) => {
    expect(planFor(seats)).toBe(plan);
  });
});
```
Tips: prefer `toEqual` for structures and `toStrictEqual` when `undefined` fields matter; use `expect.objectContaining` sparingly; reset mocks between tests (`restoreMocks: true`); never leave `.only` in committed tests (lint rule `no-only-tests`).

## 3. React Testing Library
```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../test/server";

it("shows a validation error and keeps input on failed submit", async () => {
  server.use(http.post("/api/signup", () =>
    HttpResponse.json({ errors: [{ pointer: "/email", message: "already taken" }] }, { status: 422 })));
  const user = userEvent.setup();
  render(<SignupForm />);

  await user.type(screen.getByLabelText(/email/i), "a@b.com");
  await user.click(screen.getByRole("button", { name: /create account/i }));

  expect(await screen.findByRole("alert")).toHaveTextContent(/already taken/i);
  expect(screen.getByLabelText(/email/i)).toHaveValue("a@b.com");
});
```
Rules: query priority is `getByRole` > `getByLabelText` > `getByPlaceholderText` (avoid) > `getByText` > `getByTestId` (last resort). Use `findBy` for async appearance, `queryBy` to assert absence. Do not test implementation (state, hook internals). Wrap providers (router, query client, theme) in a `renderWithProviders` helper with a fresh QueryClient per test and retries disabled.

## 4. Playwright end-to-end
```ts
import { test, expect } from "@playwright/test";

test("user can check out with a saved card", async ({ page }) => {
  await page.goto("/shop");
  await page.getByRole("button", { name: "Add to cart" }).first().click();
  await page.getByRole("link", { name: "Cart" }).click();
  await page.getByRole("button", { name: "Checkout" }).click();
  await expect(page.getByRole("heading", { name: "Order confirmed" })).toBeVisible();
});
```
Guidelines: use web-first assertions (they auto-retry); never `waitForTimeout` except for debugging; seed data via API or fixtures rather than clicking through UI; use `storageState` to log in once; isolate tests with unique data; enable `trace: "on-first-retry"`; run against a production build; tag smoke tests (`@smoke`) for post-deploy checks; add `@axe-core/playwright` for accessibility scans.

## 5. Time, randomness, and async
- Inject a clock: `def create_token(now: Callable[[], datetime] = utcnow)`; tests pass a fixed clock.
- Freeze time in Python with `time-machine` or `freezegun`; in JS `vi.useFakeTimers()` / `jest.useFakeTimers()`; set system time explicitly.
- Randomness: pass a seeded `random.Random(42)` or an injected id generator.
- Async: `await` everything; in pytest use `pytest-asyncio` or `anyio`; assert that promises reject with `await expect(p).rejects.toThrow(...)`; avoid unhandled rejections (fail the test on them).
- Waiting for conditions: poll with timeout instead of `sleep` (`await expect.poll(() => getStatus()).toBe("done")`, `waitFor`, `tenacity`).

## 6. HTTP and API tests
```python
# FastAPI example
from fastapi.testclient import TestClient
client = TestClient(app)

def test_get_order_returns_404_problem_json(auth_headers):
    r = client.get("/orders/does-not-exist", headers=auth_headers)
    assert r.status_code == 404
    assert r.headers["content-type"].startswith("application/problem+json")
    assert r.json()["status"] == 404

def test_user_cannot_read_another_users_order(make_user, make_order, login):
    alice, bob = make_user("alice"), make_user("bob")
    order = make_order(owner=alice)
    r = client.get(f"/orders/{order.id}", headers=login(bob))
    assert r.status_code in (403, 404)       # authorization regression test
```
Outbound HTTP: use `respx`/`responses`/`nock`/MSW to stub the external server and assert on the request you send (URL, headers, body), and include failure cases (timeouts, 500, malformed JSON, 429 with `Retry-After`).

## 7. Database tests
- Run real migrations against a real engine in a container (Testcontainers) or CI service.
- Isolate per test: wrap in a transaction and roll back, or truncate tables in teardown, or use a schema per test worker.
- Assert on outcomes (rows, constraints) and on query counts for N+1 protection (`django_assert_num_queries`, SQLAlchemy event counters).
- Test constraint violations and concurrent updates (two sessions, optimistic lock conflict).
- Test the migration itself: apply up on a database with representative data, verify data preserved, and test down or forward-fix.

## 8. Property-based tests
```python
from hypothesis import given, strategies as st

@given(st.lists(st.integers()))
def test_sort_is_idempotent_and_ordered(xs):
    once = sorted(xs)
    assert sorted(once) == once
    assert all(a <= b for a, b in zip(once, once[1:]))

@given(st.text())
def test_slugify_round_trip_is_stable(s):
    assert slugify(slugify(s)) == slugify(s)
```
```ts
import fc from "fast-check";
it("decode(encode(x)) === x", () => {
  fc.assert(fc.property(fc.string(), (s) => decode(encode(s)) === s));
});
```
Good properties: round trip, idempotence, commutativity, invariants preserved, comparison with a simple reference implementation, "does not throw".

## 9. Golden files and snapshots
- Golden-file tests compare output to a checked-in file for generators, formatters, and compilers; provide an `UPDATE_GOLDEN=1` mode and review diffs in PRs.
- Inline snapshots for small values (`toMatchInlineSnapshot`); avoid huge component snapshots that nobody reads.
- Normalize non-deterministic fields (ids, timestamps) before comparing.

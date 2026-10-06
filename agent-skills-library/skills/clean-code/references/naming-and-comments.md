# Naming and comments

## Contents
1. Naming principles
2. Casing by language
3. Naming patterns
4. Names to avoid
5. Comments that earn their keep
6. Docstring and API doc templates
7. Error and log messages

## 1. Naming principles
- Reveal intent: the name answers why it exists, what it does, how it is used.
- Use the domain's ubiquitous language. If the business says "policy holder", do not call it `user` in code.
- Be precise: `activeSubscriptions` beats `subs`; `parseInvoiceDate` beats `process`.
- Be consistent: choose `remove` or `delete`, `get` or `fetch`, and use it everywhere for the same idea.
- Scope-proportional length: short in tiny scopes, descriptive in wide scopes.
- Searchable: avoid single letters and unexplained numbers outside small loops or math.
- Don't be cute. Don't encode type (`strName`) or scope (`m_`) unless the language convention requires it.

## 2. Casing by language

| Language | Variables and functions | Types | Constants | Files |
|---|---|---|---|---|
| Python | `snake_case` | `PascalCase` | `UPPER_SNAKE` | `snake_case.py` |
| JavaScript / TypeScript | `camelCase` | `PascalCase` | `UPPER_SNAKE` or `camelCase` for module consts (follow project) | `kebab-case.ts` or `PascalCase.tsx` for components |
| Go | `camelCase` unexported, `PascalCase` exported | `PascalCase` | `PascalCase`/`camelCase` | `snake_case.go` |
| Rust | `snake_case` | `PascalCase` | `UPPER_SNAKE` | `snake_case.rs` |
| Java / C# | `camelCase` (Java) / `PascalCase` methods (C#) | `PascalCase` | `UPPER_SNAKE` (Java) | `PascalCase` |
| SQL | `snake_case` tables and columns, plural or singular consistently | | | |
| CSS | `kebab-case` classes and custom properties | | | |

Follow the project's existing convention when it differs.

## 3. Naming patterns
- **Booleans**: `isX`, `hasX`, `canX`, `shouldX`; never negatives like `isNotValid` (leads to double negation).
- **Functions**: verb first. `getX` returns without side effects; `fetchX` performs I/O; `computeX`/`calculateX` is pure; `createX`/`buildX` makes objects; `toX`/`fromX` converts; `validateX` returns errors or throws; `ensureX` idempotently creates or verifies.
- **Collections**: plural nouns (`users`); maps as `userById`, `usersByEmail`.
- **Counts and indexes**: `userCount`, `numRetries`, `maxRetries`, `retryIndex`.
- **Handlers and callbacks**: `handleSubmit` (definition), `onSubmit` (prop).
- **Units**: `delayMs`, `sizeBytes`, `ratePerSecond`, `priceMinor`.
- **Time**: `createdAt` (timestamp), `startDate` (date), `expiresInSeconds` (duration).
- **Private**: language conventions (`_x` in Python, `#x` or `private` in TypeScript).
- **Test names**: describe behavior: `test_rejects_expired_token`, `it("returns 404 when the order does not exist")`.

## 4. Names to avoid
`data`, `info`, `item`, `thing`, `stuff`, `tmp`, `foo`, `obj`, `val`, `res`, `handle`, `process`, `do`, `manager`, `helper`, `util(s)`, `common`, `misc`, `base` (unless real base class). Also avoid abbreviations that are not universal (`cfg` and `ctx` are common; `usrMgr` is not), and names that differ only by number or case.

## 5. Comments that earn their keep
Write comments for:
- **Why** a non-obvious decision was made and what alternatives were rejected.
- **Constraints and invariants** the type system cannot express ("must be called with the lock held").
- **Warnings** about consequences ("resetting clears all user sessions").
- **Workarounds** for external bugs, with links and removal conditions.
- **Regex, bit tricks, algorithms**: intent and a sample.
- **Public API contracts**: docstrings.
- **TODOs** with an owner or ticket and, ideally, a condition.
Skip comments that repeat the code, narrate obvious steps, mark closing braces, record history, or apologize.

## 6. Docstring and API doc templates
Python (Google style):
```python
def transfer(src: Account, dst: Account, amount: Money) -> Receipt:
    """Move money between accounts atomically.

    Args:
        src: Account to debit; must have sufficient available balance.
        dst: Account to credit; must be in the same currency as ``amount``.
        amount: Positive amount to transfer.

    Returns:
        Receipt with the transaction id and resulting balances.

    Raises:
        InsufficientFunds: If ``src`` cannot cover ``amount``.
        CurrencyMismatch: If the accounts and amount do not share a currency.
    """
```
TypeScript (TSDoc):
```ts
/**
 * Retries an async operation with exponential backoff and jitter.
 * @param fn - Operation to run; must be idempotent.
 * @param opts.maxAttempts - Total attempts including the first (default 5).
 * @throws The last error once attempts are exhausted.
 * @example
 * const user = await retry(() => api.getUser(id), { maxAttempts: 3 });
 */
```

## 7. Error and log messages
- Errors: what failed, with which identifier or value, why, and what to do. "Cannot read config: file '/etc/app.toml' not found. Set APP_CONFIG or create the file."
- Never include secrets, tokens, full card numbers, or raw personal data in messages.
- Logs: a stable event message plus structured fields (`logger.info("order_paid", order_id=..., amount=...)`), not string concatenation; use levels consistently (ERROR needs action, WARN is recoverable anomaly, INFO is business event, DEBUG is diagnostic).

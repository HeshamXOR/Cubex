---
name: code-review
description: Reviews code changes, pull requests, diffs, and AI-generated code for correctness, security, design, tests, readability, and performance, and writes clear, prioritized, actionable feedback. Use whenever the user asks to review, critique, audit, or sanity-check code or a PR, asks "is this good", "what's wrong with this", or "can you look over this diff", and also to self-review your own changes before reporting them as done.
license: MIT
metadata:
  category: engineering
  version: "1.0"
---

# Code Review

The goal is to ship correct, secure, maintainable changes while helping the author learn. Review the code, not the person.

## Process

1. **Understand intent.** Read the PR description, linked issue, and tests first. What problem is being solved? What is the expected behavior? If intent is unclear, ask before critiquing.
2. **Get the big picture.** Skim the file list and diff stat. Is the change scoped and coherent? Is it too large to review well (suggest splitting)?
3. **Review design first,** then details: is this the right place, the right abstraction, the right approach? Design feedback late is expensive.
4. **Review line by line** in an order that follows the data flow: tests first (they state intent), then interfaces, then implementation.
5. **Run it when risk warrants**: check out the branch, run tests and linters, exercise the feature, and try to break it.
6. **Summarize** with a verdict and the top issues.

## What to look for (in priority order)

1. **Correctness**: does it do what it claims? Off-by-one, null and empty handling, boundary values, error paths, wrong conditions, integer overflow, time zones, encoding, mutation of shared data, resource leaks, incorrect assumptions about inputs.
2. **Security**: authn and authz on every path (object-level checks), input validation, injection (SQL, command, template, XSS), SSRF, path traversal, unsafe deserialization, secrets in code or logs, weak crypto, CSRF/CORS, dependency risk, PII handling. See `security-review`.
3. **Concurrency and data integrity**: races, transactions, idempotency, retries, ordering, partial failure, locking, migrations that lock tables or lose data.
4. **API and compatibility**: breaking changes to public interfaces, contracts, schemas, config, or persisted formats; deprecation path; versioning.
5. **Design and maintainability**: single responsibility, coupling, layering violations, duplication of knowledge, premature abstraction, naming, complexity. See `clean-code`.
6. **Tests**: do they cover behavior, edge cases, and failure paths? Would they fail if the code were broken? Are they deterministic and readable? Is a regression test present for bug fixes?
7. **Performance and scalability**: algorithmic complexity, N+1 queries, unbounded loops or memory, missing pagination, blocking calls in async paths, cache correctness. Flag only if plausible at real scale; do not micro-optimize.
8. **Observability and operations**: logging with context (no secrets), metrics, error handling, feature flags, config, rollout and rollback, documentation and changelog.
9. **Readability and style**: consistency with the codebase, comments explaining why, dead code. Automate style with formatters and linters; do not spend review energy on what a tool can enforce.
10. **Accessibility and UX** for UI changes: keyboard, labels, contrast, states, responsive behavior. See `frontend-engineering`.

## Reviewing AI-generated code (extra scrutiny)

- **Hallucinated APIs**: functions, flags, config keys, or package names that do not exist or differ in the installed version. Verify imports and signatures. Watch for look-alike package names (supply chain risk).
- **Plausible but wrong logic**: confident code that mishandles edge cases; check with tests, not by reading alone.
- **Over-engineering**: unnecessary abstractions, extra layers, defensive code for impossible cases, verbose comments narrating the obvious.
- **Silent error swallowing**: broad `except`/`catch`, fallbacks that hide failure, fake data on error.
- **Inconsistency with the codebase**: new patterns, duplicate helpers that already exist, different error conventions.
- **Security shortcuts**: disabled TLS verification, `eval`, permissive CORS, hardcoded secrets, string-built SQL.
- **Tests that assert nothing** or mirror the implementation; snapshot tests approved blindly.
- **Scope creep**: unrelated files touched, reformatting, dependency changes.

## Writing feedback

Label severity so the author knows what blocks merging:
- **[blocker]** must fix: bug, security issue, data loss, broken contract
- **[major]** should fix before merge: significant design or maintainability concern, missing tests for risky logic
- **[minor]** improve if cheap: clarity, small refactor
- **[nit]** trivial preference; author may ignore
- **[question]** seeking understanding; no change implied
- **[praise]** call out good work; it reinforces good patterns

Principles:
- Be specific and actionable: point to the line, state the problem, explain the impact, suggest a fix (code snippet when short).
- Explain *why*, referencing a principle, doc, or observed failure scenario.
- Ask questions instead of asserting when unsure ("What happens if `items` is empty here?").
- Separate opinion from requirement; avoid bikeshedding; offer alternatives, not ultimatums.
- Keep tone kind and neutral. Say "this function" not "you".
- Limit the number of comments; group repeated patterns ("same issue in 4 places; see line 42").
- If the approach is fundamentally wrong, say so early at a high level rather than nit-picking lines.

Example:
```
[major] src/billing/refund.py:57 - `amount` comes from the request body and is never
compared to the order total, so a client can refund more than was paid. Suggest
validating `0 < amount <= order.refundable_balance` inside the transaction and adding
a test for over-refund and double-refund.
```

## Output template

```
## Summary
One or two sentences on what the change does and overall assessment.
Verdict: approve / approve with comments / request changes

## Blockers
- file:line - problem, impact, suggested fix

## Major
- ...

## Minor / Nits
- ...

## Questions
- ...

## What is good
- ...

## Test and verification notes
- What I ran or could not run
```

## Self-review checklist (before asking others)

- [ ] I re-read my whole diff and removed debugging leftovers and unrelated edits
- [ ] The PR description explains context, approach, tests, risks
- [ ] Tests cover new behavior and failure cases; CI is green
- [ ] No secrets, credentials, or personal data added
- [ ] Docs, migrations, configs, and changelog updated
- [ ] Backward compatibility and rollout plan considered
- [ ] Size is reviewable; large mechanical changes are separated from logic changes

## When receiving reviews

- Assume good intent; treat feedback as information about the code.
- Respond to every comment: fix, explain, or propose a follow-up ticket.
- Disagree with reasons and evidence; escalate to a quick call when threads run long.
- Do not push large unrelated changes during review; keep history reviewable.

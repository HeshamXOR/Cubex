---
name: clean-code
description: Guides writing, reviewing, and refactoring code so it is readable, simple, and easy to change, in any language. Covers naming, function and module design, duplication, error handling, comments, code smells, SOLID used pragmatically, and safe step-by-step refactoring. Use whenever the user asks to clean up, refactor, simplify, restructure, review code quality, reduce complexity, fix code smells, improve naming, or when writing any non-trivial new code that other people will maintain.
license: MIT
metadata:
  category: engineering
  version: "1.0"
---

# Clean Code

Code is read far more often than it is written. Optimize for the next reader, who is usually you in six months, and for the next change.

## Prime directives (in priority order)

1. **Follow the codebase.** Existing conventions beat personal taste and beat this document. Consistency is a feature.
2. **Make it correct, then clear, then small, then fast.** Do not skip steps or reorder them without evidence.
3. **Do the simplest thing that works and is easy to change.** Solve today's problem, not imagined future ones (YAGNI).
4. **Leave the code slightly better than you found it,** within the scope of the task. Do not smuggle unrelated refactors into a functional change; propose them separately.

## What clean code looks like

### Names
- A name states intent and domain meaning: `overdueInvoices`, not `list2`; `retryCount`, not `n`.
- Functions are verbs (`calculateTax`), values and classes are nouns, booleans read as questions (`isExpired`, `hasAccess`, `canRetry`).
- Use one word per concept across the codebase (`fetch` or `get`, not both for the same thing).
- Put units and constraints in names when the type does not say it: `timeoutMs`, `priceCents`, `angleRad`.
- Avoid encodings, noise words (`Manager`, `Helper`, `Util`, `Data`, `Info`), and misleading names. If you cannot name it, the design is probably unclear.
- Length is proportional to scope: `i` in a three-line loop is fine; a module-level constant needs a full name.
- Details in `references/naming-and-comments.md`.

### Functions
- Do one thing at one level of abstraction. If you can extract a meaningful sub-function with a descriptive name, the original was doing more than one thing.
- Small: typically under 20 to 30 lines. Length is a smell, not a rule; a flat 40-line table mapping can be fine.
- Few parameters: 0 to 3. Group related parameters into a typed object. Avoid boolean flag parameters (`render(true)`); split into two functions or use a named option.
- Avoid output parameters and hidden mutation. Prefer returning values. Separate commands (change state) from queries (return data).
- Prefer pure functions: same input, same output, no side effects. Push I/O and side effects to the edges (functional core, imperative shell).
- Use **guard clauses** and early returns to flatten nesting. Aim for at most 2 to 3 levels of indentation.
- Make the happy path read straight down the page.

### Structure
- High cohesion inside modules, low coupling between them. A module has one reason to change.
- Dependencies point inward toward stable domain logic; details (framework, database, HTTP) sit at the edges behind small interfaces.
- Depend on abstractions at real seams (I/O, time, randomness, external services), not everywhere. An interface with one implementation and no test seam is noise.
- Prefer composition over inheritance. Keep inheritance shallow (one level) and only for true "is-a" substitution.
- Group by feature or domain, not only by technical layer, when the codebase grows.
- Do not expose internals: minimize public surface, keep fields private, return copies or immutable views.
- Make illegal states unrepresentable with types (enums, discriminated unions, value objects) instead of comments and runtime checks.

### Duplication and abstraction
- Duplication of *knowledge* is the enemy (the same business rule in two places). Duplication of incidental *code shape* is often cheaper than the wrong abstraction.
- **Rule of three**: tolerate duplication twice; abstract on the third occurrence when the shared shape is clear.
- Abstractions must earn their place. Prefer deleting an abstraction over adding a configuration flag to bend it.
- Avoid premature generalization: no plugin systems, factories, or generic frameworks for a single use case.

### Errors and edge cases
- Fail fast at boundaries: validate inputs where they enter the system, then trust typed internal data.
- Never swallow exceptions silently. Handle, add context and rethrow, or let it propagate. An empty `catch` is a bug.
- Use specific error types or error codes. Error messages say what happened, with which values, and what to do.
- Do not use exceptions for normal control flow. Do not return `null` when a typed alternative (`Option`, empty collection, `Result`) communicates better.
- Clean up resources deterministically (`with`, `using`, `try/finally`, `defer`).
- Consider the edge cases explicitly: empty, one, many, huge, negative, zero, duplicate, unicode, time zones, concurrency, partial failure.

### Comments
- Code says *what* and *how*; comments say *why*: the business rule, the constraint, the trade-off, the bug being worked around (with link).
- Delete comments that restate the code or excuse bad naming; delete commented-out code (version control remembers).
- Keep public API docs (docstrings, JSDoc, godoc) accurate: purpose, parameters, returns, errors, examples.
- TODOs carry an owner or ticket: `TODO(#123): ...`.

### Formatting and tooling
- Do not hand-format. Use the project's formatter and linter (Prettier, Black or Ruff, gofmt, rustfmt) and treat their output as final.
- Keep related code vertically close; order by call hierarchy (caller above callee) or by convention of the language.

## Smell thresholds (signals to investigate, not commandments)

| Signal | Typical threshold | Common remedy |
|---|---|---|
| Function length | over ~30 lines | Extract function |
| Parameters | over 3 to 4 | Parameter object |
| Nesting depth | over 3 | Guard clauses, extract |
| Cyclomatic complexity | over ~10 | Split branches, lookup table, polymorphism |
| File or class size | over ~300 to 500 lines | Split by responsibility |
| Same change touches many files | shotgun surgery | Consolidate the concept |
| One file changes for unrelated reasons | divergent change | Split module |
| Long chains `a.b().c().d()` | Demeter violation | Tell, do not ask; add a method |
| Switch on type repeated | duplicated conditionals | Polymorphism or strategy table |

Full catalog with before and after examples: `references/refactoring-catalog.md`.

## Safe refactoring procedure

1. **Establish a safety net.** Run existing tests. If coverage is thin around the target, write characterization tests that pin current behavior (including its quirks) before changing anything.
2. **State the goal** in one sentence ("extract tax calculation from `checkout()` so it can be unit tested"). Refactoring changes structure, not behavior.
3. **Take tiny steps.** One named refactoring at a time (rename, extract, inline, move). Run tests after each step. If a step breaks tests and the cause is not obvious, revert the step rather than debugging a large diff.
4. **Separate commits**: refactor commits contain no behavior changes; feature commits contain no mass renames. Reviewers can then verify each independently.
5. **Use the tools**: IDE rename and extract refactorings, codemods, `git diff -w`, type checker, and compiler as guides.
6. **Stop when the goal is met.** Note further improvements as follow-ups instead of expanding scope.

## Review questions before finishing any code

- Could a new teammate understand each function from its name and body without asking me?
- Is anything here needed only for a hypothetical future?
- Is any logic duplicated that should live in one place?
- Are failure modes handled, and do error messages help?
- Are there tests that would fail if the behavior broke?
- Did I follow this project's naming, structure, and error-handling conventions?

## Pragmatic SOLID

- **Single responsibility**: a unit has one reason to change; split by *who asks for changes*, not by line count.
- **Open/closed**: add behavior by adding code (new strategy) where variation is genuinely expected; do not pre-build extension points.
- **Liskov substitution**: subtypes must honor the base contract; if you override to throw "not supported", the hierarchy is wrong.
- **Interface segregation**: small, role-specific interfaces; clients should not depend on methods they do not use.
- **Dependency inversion**: high-level policy does not import low-level detail; pass dependencies in (constructor or function args).

## Reference files

- `references/refactoring-catalog.md`: smells mapped to refactorings with examples
- `references/naming-and-comments.md`: naming conventions per language, boolean and function naming, comment and docstring guidance

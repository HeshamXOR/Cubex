---
name: software-engineering-workflow
description: The default end-to-end workflow for any software task: clarify the goal, explore the codebase, plan small steps, implement incrementally, verify with tests and tooling, review the diff, and report honestly. Use whenever starting any coding, bug-fix, feature, migration, or repository task, especially in an unfamiliar codebase, when the request is vague, when a change touches multiple files, when adding dependencies, or when deciding whether to ask a question or proceed on assumptions.
license: MIT
metadata:
  category: engineering
  version: "1.0"
---

# Software Engineering Workflow

A disciplined loop that prevents the common failures: building the wrong thing, breaking existing behavior, guessing APIs, unbounded scope, and reporting success without proof.

## The loop

1. Clarify
2. Explore
3. Plan
4. Implement (small increments)
5. Verify
6. Review your own diff
7. Report

Scale the ceremony to the task. A one-line typo fix needs steps 4 to 7 in a moment; a cross-cutting feature needs a written plan.

## 1. Clarify

State the goal in one sentence and list what "done" means (observable behavior, not code). Identify constraints: language and framework versions, performance, compatibility, deadlines, style.

**Ask or assume?**
| Situation | Action |
|---|---|
| Missing info changes the design materially, or a wrong guess is expensive (data loss, public API, security, cost) | Ask, with a specific question and a recommended default |
| Missing info is minor and reversible | State the assumption explicitly and proceed |
| The answer is discoverable in the repo, docs, or tests | Look it up; do not ask |
| Multiple interpretations, cheap to do both | Pick the most likely, mention the alternative |

Ask at most a few focused questions at once. Never stall on trivia.

## 2. Explore (read before you write)

- Map the repo: `README`, `CONTRIBUTING`, top-level layout, build and test commands (`Makefile`, `package.json` scripts, `pyproject.toml`, CI config).
- Locate the entry point for the behavior you are changing: search for route names, error strings, UI text, function names (`rg`/`grep`), then follow call sites and tests.
- Read the tests near the code to learn intended behavior and conventions.
- Check git history for the file (`git log -p --follow`, `git blame`) when intent is unclear.
- Note conventions: naming, error handling, logging, folder structure, import style, dependency injection, formatting tools.
- Run the existing test suite (or the relevant part) first to know the baseline; note pre-existing failures so they are not blamed on you.
- **Verify APIs against the installed version.** Check the lockfile and the library's docs or source; do not rely on memory for signatures, config keys, or CLI flags that change between versions. Search official docs when unsure.

## 3. Plan

- Break the work into steps that each leave the system working (buildable, tests green).
- Prefer the smallest change that satisfies the goal. Identify the files to touch and the tests to add.
- For non-trivial changes write the plan first (bullets are fine): approach, alternatives rejected, risks, rollout, test strategy.
- Identify the riskiest assumption and test it first (spike).
- Call out breaking changes, migrations, and anything requiring a human decision.

## 4. Implement

- Make one logical change at a time; keep the build green between steps.
- Follow the existing style. Do not reformat unrelated code or upgrade unrelated dependencies.
- Write or update tests with the code (or before it for bug fixes: reproduce with a failing test first).
- Handle errors and edge cases now, not later: empty inputs, nulls, timeouts, concurrency, large inputs, permissions.
- Do not leave debugging output, commented-out code, or stray TODOs without owners.
- Add a dependency only when it clearly beats a small amount of code. Evaluate: maintenance activity, license, security advisories, size, transitive dependencies, API stability, and whether the platform already provides the feature. Pin versions via the lockfile.
- Never commit secrets. Use environment variables and `.env.example`.
- Keep commits focused (see `references/git-and-commits.md`).

## 5. Verify

Run everything that can fail, in order of speed:
1. Format and lint
2. Type check
3. Unit tests for changed areas, then the full suite
4. Build
5. Manual or scripted exercise of the actual behavior (run the app, call the endpoint, click through the flow). Tests passing is not the same as the feature working.
6. For bug fixes: confirm the new test fails without the fix and passes with it.

**Evidence rule:** never say something works, passes, or is fixed unless you ran it and saw the result. If you could not run something, say so plainly and say what remains unverified.

## 6. Review your own diff

Read `git diff` as a reviewer would (see `code-review`):
- Does every changed line serve the goal? Remove drive-by edits.
- Any leftover debugging, secrets, or accidental files (build artifacts, `.DS_Store`)?
- Are names, comments, and error messages clear?
- Are edge cases, failure paths, and backwards compatibility handled?
- Are docs, changelog, types, migrations, and configuration updated?

## 7. Report

Summarize concisely for a busy reader:
- **What changed and why** (behavior level, then key files)
- **How it was verified** (commands run and results)
- **What is not done or not verified**, known limitations, and follow-ups
- **Decisions and assumptions** worth confirming
- **Risks and rollout notes** (migrations, flags, config, breaking changes)

Do not overstate. If something failed and you worked around it, say so.

## Working in unfamiliar or legacy code

- Get the app running locally before changing it. If it will not run, that is your first task.
- Add **characterization tests** around code you must change to pin current behavior.
- Prefer small, reversible steps; use the strangler pattern (route new behavior through new code, retire old code gradually).
- Do not "fix" surprising behavior you do not understand without asking or verifying it is a bug (it may be load-bearing).
- Record discoveries (where things live, gotchas) in docs or comments for the next person.

## Scope control

- Keep a "found along the way" list instead of fixing everything now. Fix only what is required for the goal; propose the rest as separate changes.
- If the task grows beyond the original estimate, stop, re-plan, and tell the requester.
- When blocked (missing access, ambiguous requirement, failing environment), report the blocker with what you tried and the smallest thing needed to unblock.

## Decision records

For choices that will outlive the task (frameworks, data models, protocols), capture a short ADR: context, decision, alternatives, consequences (see `system-design`).

## Related skills

`debugging` for defects, `testing-strategy` for test design, `code-review` for reviewing diffs, `clean-code` for structure, `security-review` for risky changes, `technical-writing` for docs.

## Reference files

- `references/git-and-commits.md`: branching, commit messages, PR hygiene, recovery commands

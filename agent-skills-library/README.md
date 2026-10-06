# Agent Skills Library

A detailed, ready-to-load set of **18 skills** for an agent harness, written in the open Agent Skills format (`SKILL.md` with YAML frontmatter, plus optional `references/`, `assets/`, `scripts/`). Skills load on demand through progressive disclosure, so the agent carries only a short catalog until a task needs the details.

## What is inside

| Area | Skill | Covers |
|---|---|---|
| Core workflow | `software-engineering-workflow` | Clarify, explore, plan, implement, verify, review, report; ask-vs-assume rules; git and commit hygiene |
| | `debugging` | Reproduce, minimize, localize, hypothesize, fix root cause; symptom playbooks; root-cause template |
| | `testing-strategy` | Test levels, doubles policy, flakiness, TDD, property tests; pytest, Vitest, Testing Library, Playwright patterns |
| | `code-review` | Prioritized review checklist, severity labels, reviewing AI-generated code, output template |
| Code quality | `clean-code` | Naming, functions, structure, errors, comments, smell thresholds, safe refactoring, catalog of refactorings |
| | `python-engineering` | uv, Ruff, typing, asyncio, logging, config, FastAPI and Django notes |
| | `typescript-engineering` | Strict tsconfig, type design, Zod at boundaries, async and error handling, migration path |
| Frontend | `frontend-engineering` | Build order, component and state rules, forms, design quality; WCAG 2.2 AA, Core Web Vitals, React patterns, modern CSS and RTL |
| Backend | `backend-engineering` | Layering, request lifecycle, errors (RFC 9457), transactions, idempotency; API design, database and migrations, auth, reliability and observability |
| Architecture and ops | `system-design` | Requirements, estimation, style selection, trade-offs, diagrams; ADR and design-doc templates |
| | `devops-and-ci-cd` | Pipelines, DORA metrics, release strategies, IaC; hardened GitHub Actions, Docker |
| | `performance-optimization` | Measure-first method, layer-specific fixes, caching rules, benchmark hygiene, profilers |
| Security | `security-review` | Threat modeling, OWASP Top 10:2025 map, checklists, severity guide; LLM and agent security |
| Knowledge work | `deep-research` | Scoping, search planning, source evaluation (SIFT), verification, cited reports; report templates |
| | `data-analysis` | Profiling and cleaning, method selection, pandas/Polars/SQL idioms, honest charts, communication |
| | `technical-writing` | Diataxis, READMEs, runbooks, changelogs, PR descriptions; README template |
| AI | `llm-application-engineering` | Prompting, structured output, tools, RAG, agents, evals, cost and latency; classical ML essentials |
| Meta | `skill-authoring` | How to write, test, and secure new skills; template |

## Layout

```
agent-skills-library/
  README.md
  LICENSE
  index.json                 generated catalog (name, description, files, sizes)
  skills/<skill-name>/SKILL.md
  skills/<skill-name>/references/*.md   loaded only when needed
  skills/<skill-name>/assets/*.md       templates
  tools/skill_loader.py      reference loader (no dependencies)
  tools/validate_skills.py   validator + index generator
  evals/trigger-tests.jsonl  prompts with the skills that should trigger
```

## Integrating with your harness

Three levels of loading (progressive disclosure):

1. **Catalog (always in context, ~100 tokens per skill).** Put every skill's `name` and `description` in the system prompt. `tools/skill_loader.py` produces this as an `<available_skills>` block.
2. **Instructions (on demand).** When the model decides a skill applies, return the `SKILL.md` body (a `read_skill` tool, or let the model read the file with your file tool).
3. **Resources (on demand).** SKILL.md names reference and asset files; the model reads them only when relevant. Run scripts rather than loading their source.

```python
from tools.skill_loader import discover_skills, catalog_prompt, read_skill, read_resource

skills = discover_skills()                      # parse frontmatter of every skill
system_prompt = BASE_PROMPT + "\n\n" + catalog_prompt(skills)
# expose two tools to the model:
#   load_skill(name)            -> read_skill(skills, name)
#   read_skill_file(name, path) -> read_resource(skills, name, path)   # rejects path traversal
```

Notes:
- The catalog block includes absolute file paths in `<location>`. If your harness maps paths differently, change `catalog_prompt`.
- Instruct the model in your base prompt: "Before starting a task, check the skill catalog. If a skill matches, load it and follow it. Several skills can apply; load each that is relevant."
- Skills describe *how to work*; they do not grant permissions. Keep your sandbox, approval gates, and credential handling in the harness (see `security-review/references/llm-and-agent-security.md`).
- `evals/trigger-tests.jsonl` lists prompts and which skills should load, including negatives with an empty list. Run them against your model with the catalog in the prompt and compare which skills it loads. Tune descriptions if it under- or over-triggers.

## Validate and extend

```bash
python tools/validate_skills.py        # checks every skill and regenerates index.json
python tools/skill_loader.py catalog   # print the Level-1 catalog
python tools/skill_loader.py show clean-code
python tools/skill_loader.py resource frontend-engineering references/accessibility.md
```

To add a skill, copy `skills/skill-authoring/assets/skill-template.md` to `skills/<new-name>/SKILL.md`, follow `skills/skill-authoring/SKILL.md`, then run the validator. Rules enforced: name matches directory (lowercase, digits, hyphens, max 64 characters), description non-empty and at most 1024 characters with no angle brackets, SKILL.md body at most 500 lines, all referenced files exist.

## Sources and currency

The content follows widely used public standards and documentation: the Agent Skills specification and skill-authoring best practices, OWASP Top 10:2025 and OWASP guidance for LLM and agentic applications, WCAG 2.2, web.dev Core Web Vitals, react.dev guidance on effects, RFC 9457, GitHub Actions security hardening guidance, the SIFT lateral-reading method, DORA research, and Anthropic's published guidance on building effective agents.

Some facts change over time (framework and language versions, threshold values, OWASP and WCAG revisions, tool names). Skills tell the agent to check the project's installed versions and current docs for these. Review the time-sensitive material (Core Web Vitals thresholds, OWASP lists, language and tool versions) on a regular schedule.

## License

MIT (see `LICENSE`).

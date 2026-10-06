---
name: skill-authoring
description: Creates, reviews, and improves agent skills (SKILL.md folders following the Agent Skills format) for an agent harness: choosing scope, writing effective names and trigger-rich descriptions, structuring instructions with progressive disclosure, adding references, scripts, and assets, setting the right degree of freedom, and testing skills with evaluations. Use whenever the user wants to add a new skill to this library, edit or split an existing skill, debug why a skill does not trigger or is ignored, or validate the skills folder.
license: MIT
metadata:
  category: meta
  version: "1.0"
---

# Skill Authoring

A skill is a folder of instructions and resources that an agent loads **on demand**. It turns a general model into a specialist for one kind of work without bloating every prompt.

## 1. Format (Agent Skills specification)

```
skill-name/
  SKILL.md            required: YAML frontmatter + Markdown instructions
  references/         optional: extra docs loaded only when needed
  scripts/            optional: executable helpers (run, don't read into context)
  assets/             optional: templates, boilerplate, static files
```

Frontmatter fields:

| Field | Required | Rules |
|---|---|---|
| `name` | yes | 1 to 64 chars; lowercase letters, digits, hyphens; no leading/trailing/consecutive hyphens; **must equal the directory name**; avoid reserved words (`anthropic`, `claude`) |
| `description` | yes | 1 to 1024 chars, non-empty, no XML angle brackets; says **what it does and when to use it** |
| `license` | no | License name or bundled file |
| `compatibility` | no | Up to 500 chars: environment needs (tools, network, packages) |
| `metadata` | no | String-to-string map for custom fields (category, version, owner) |
| `allowed-tools` | no | Experimental: space-separated pre-approved tools |

Validate with `python tools/validate_skills.py` from the library root.

## 2. Progressive disclosure (why structure matters)

1. **Level 1, metadata** (~100 tokens per skill): `name` and `description` are always in the system prompt so the agent knows what exists.
2. **Level 2, instructions**: the SKILL.md body loads only when the skill is relevant. Keep it under **500 lines** (about 5,000 tokens).
3. **Level 3, resources**: reference files, scripts, assets load or run only when the instructions point to them. Scripts run without their source entering context.

Consequences:
- Everything in a loaded SKILL.md competes with the conversation for attention; every token must earn its place.
- Put the essentials and the decision logic in SKILL.md; move deep detail, long examples, and large tables to `references/`.
- Link references **one level deep** from SKILL.md (references should not chain to other references); name the file and say when to read it.
- Give reference files longer than ~100 lines a table of contents so a partial read still shows the full scope.
- Use forward slashes in paths; name files by content (`database-and-migrations.md`), not `doc2.md`.

## 3. Writing the description (most important line)

The description is the only thing the agent sees when deciding to load the skill. It must include **what the skill does** and **when to use it**, with the words users actually use.

- Write in **third person** ("Reviews code changes...", not "I review" or "You can use this to...").
- Front-load the capability, then list triggers: task types, file types, keywords, situations, and near-miss phrasings ("even if the user only says X").
- Be specific enough to avoid false triggers and broad enough to catch real ones. Agents tend to **under-trigger**, so lean slightly pushy: include adjacent contexts where the skill helps.
- Avoid vague summaries ("helps with code") and internal jargon.

Weak: `Helps with backend stuff.`
Strong: `Designs and implements reliable, secure backend services and APIs... Use whenever the task involves an API endpoint, database schema or query, migration, authentication, background job, or server-side architecture, even if the user only says "add an endpoint".`

## 4. Scoping and naming

- One skill = one coherent job or domain that a specialist would recognize. Too broad (everything about software) loads noise; too narrow (one function) clutters the catalog.
- Split when a skill exceeds ~500 lines, when sections are used independently, or when triggers differ. Merge when two skills always load together.
- Names: lowercase-hyphenated; a noun phrase or gerund describing the domain (`code-review`, `debugging`, `testing-strategy`); specific and consistent across the library. Avoid vague names (`helper`, `utils`, `tools`).
- Cross-reference sibling skills by name in a "Related skills" line; do not duplicate their content.

## 5. Writing the body

- **Assume the model is smart.** Add only what it does not already know: your conventions, decisions, checklists, pitfalls, formats, and non-obvious procedures. Cut explanations of well-known basics.
- **Set the degree of freedom to match fragility.**
  - *High freedom* (heuristics, principles, checklists) where many approaches are valid (code review, research).
  - *Medium* (templates, parameterized patterns, pseudocode) where a preferred pattern exists.
  - *Low* (exact commands, scripts, "do not deviate") where operations are fragile or safety-critical (migrations, deployments, destructive git operations).
- **Prefer procedures and decision tables** over prose: numbered workflows, "if X then Y" tables, definition-of-done checklists, and templates for outputs.
- **Show, don't only tell**: short input/output examples of the desired format, before/after code, and sample reports.
- **Use consistent terminology** throughout (one term per concept).
- **Avoid time-sensitive facts** that will silently go stale ("after August 2025 use..."). Where facts must be version-specific, say so and tell the agent to verify against the installed version or current docs; keep dated material in a clearly marked section.
- **Don't offer a menu of equal options.** Give a default and mention an escape hatch only when needed.
- **Be explicit about scripts**: whether to *run* them (usually) or *read* them; document arguments, outputs, and error handling. Scripts should solve problems, handle errors with helpful messages, avoid magic constants (document why values are set), and declare required packages.
- **Include verification steps** for outputs (validators, tests, checklists) so the agent can self-check.
- **Keep instructions imperative and unambiguous**; explain the reason behind non-obvious rules so the agent generalizes correctly.

## 6. Skeleton

See `assets/skill-template.md` for a copy-paste starting point. A good body usually has:
1. One-paragraph purpose and scope
2. When to use / not use (if boundaries are subtle)
3. Core workflow (numbered)
4. Rules, defaults, and decision tables
5. Pitfalls and anti-patterns
6. Definition of done / checklist
7. Output template (if a deliverable has a format)
8. Related skills and reference files (one level deep)

## 7. Build and improve skills with evaluations

1. **Find the gap first.** Run the agent on 3 to 5 realistic tasks *without* the skill. Note where it fails or needs repeated guidance. Write the skill to fix those specific gaps.
2. **Write the minimal skill,** then test against the same tasks. Read the transcripts, not just the outputs: did it load the skill? Which sections did it follow, skip, or misread?
3. **Test triggering** with a set of prompts: ones that should trigger (including indirect phrasings) and near-misses that should not. Adjust the description until both behave.
4. **Test across model sizes** you plan to use; smaller models may need more explicit structure, larger ones less.
5. **Iterate from observation:** add guidance where the agent stumbles, delete guidance it never uses, and tighten anything that inflates length without changing behavior.
6. **Regression-check** existing tasks after edits, and keep a small eval file in your repo (`evals/<skill>.jsonl`) with prompts, expected behaviors, and pass criteria.
7. **Version and review** skills like code: PRs, changelog notes in `metadata.version`, and an owner.

## 8. Security review of skills

Skills are executable influence over an agent (instructions and scripts). Treat third-party skills like third-party code:
- Read every file, especially scripts and any instruction that fetches or executes remote content.
- Watch for hidden instructions (exfiltrating data, disabling safeguards, network calls to unknown hosts), and overly broad `allowed-tools`.
- Pin, review, and sign internal skills; load only from trusted paths; sandbox script execution with limited network and file access; never auto-approve tools declared by a skill without policy checks.
- Keep secrets out of skills; use the harness's credential injection.

## 9. Maintenance checklist

- [ ] `name` matches the directory; `description` says what and when, third person, under 1024 chars
- [ ] SKILL.md under 500 lines; deep detail in `references/` one level deep with a table of contents where long
- [ ] Every referenced file exists; no orphan files; forward-slash paths
- [ ] Terminology consistent; no time-sensitive claims without a verify instruction
- [ ] Degrees of freedom appropriate; examples and templates present
- [ ] Tested on realistic tasks; trigger tests written; validated with `tools/validate_skills.py`

## Asset files

- `assets/skill-template.md`: starting point for a new SKILL.md

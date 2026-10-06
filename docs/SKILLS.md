# Skills

Cubex uses the 18 workflows supplied in [`agent-skills-library`](../agent-skills-library/README.md). A skill is a Markdown workflow the model loads for a relevant task. It adds guidance without installing a package, granting permissions, or automatically running a script.

The library holds one `SKILL.md` per skill and 25 supporting references and templates, with an index, an MIT license, a reference loader and validator in Python, and trigger examples under `evals/`. Development builds and the packaged app read the same `agent-skills-library/skills/` folder directly.

Only names, descriptions and sources enter the system prompt. Full instructions and supporting text enter the conversation through the read-only `skill` tool when the model asks for them. Descriptions, including their task triggers, are kept whole up to 1,024 characters.

## Run a skill yourself

Typing `/` in the composer lists the built-in commands and every skill the model could use, each with a one-line description and where it comes from. Type after the `/` to narrow the list. Choosing a skill, or typing its name and a request — `/debugging the save button does nothing` — applies that skill to this turn without the model deciding: Cubex reads the skill's instructions and gives them to the model with your message. A skill whose name matches a built-in command is listed as `/skill:<name>` and run through that spelling. A name that is neither command nor skill keeps the usual "unknown command" behaviour. The thread shows the skill it applied as a card, and the message itself is kept as you typed it.

## Included library

| Skill | Intended use |
| --- | --- |
| `software-engineering-workflow` | Plan, implement, verify, and report software work. |
| `debugging` | Investigate failures, race conditions, and environment-specific bugs. |
| `testing-strategy` | Choose and implement useful automated checks. |
| `code-review` | Review changes and prioritize actionable findings. |
| `clean-code` | Improve naming, structure, and maintainability. |
| `python-engineering` | Python projects, types, async code, and services. |
| `typescript-engineering` | TypeScript types, boundaries, errors, and migration. |
| `frontend-engineering` | Product UI, components, accessibility, layout, and performance. |
| `backend-engineering` | APIs, databases, migrations, auth, and reliable services. |
| `system-design` | Architecture, tradeoffs, capacity, and design documents. |
| `devops-and-ci-cd` | Build pipelines, containers, infrastructure, and releases. |
| `performance-optimization` | Measure and address performance bottlenecks. |
| `security-review` | Defensive review, threat modeling, and agent security. |
| `deep-research` | Source evaluation, research, and cited reports. |
| `data-analysis` | Data cleaning, analysis, validation, and charts. |
| `technical-writing` | Documentation, READMEs, runbooks, and change descriptions. |
| `llm-application-engineering` | Tools, agents, retrieval, prompts, and evaluations. |
| `skill-authoring` | Create, validate, and improve skill packs. |

For example, ask: "Use $frontend-engineering to improve this settings screen" or "Use $debugging to investigate the intermittent save failure." The model may also select a skill from a normal task description. Selection remains model behavior; inspect the skill tool activity to confirm it was loaded. A skill naming a browser, deployment service, or external tool does not make that capability available.

## Discovery and context

Bundled skills are available to agentic chats even when no project folder is selected. Project skills require a task workspace and enabled file tools. Cubex discovers direct child folders containing `SKILL.md` in this order:

1. `<workspace>/.cubex/skills/`
2. `<workspace>/.agents/skills/`
3. `<workspace>/.claude/skills/`
4. The bundled `agent-skills-library/skills/` library

The first discovered definition for a name wins. Discovery does not search the user's home directory or fetch remote packages. The **Skills** group in Settings shows the resolved catalog for the selected folder, labelled by source (Built in, .cubex, .agents or .claude), and lets you read a skill without editing it. Choose **Refresh** after changing project skills.

The catalog is capped at 64 skills, and discovery scans at most 512 directory entries per source; packs beyond a source's scan cap may be omitted. Descriptions shown to the model are capped at 1,024 Unicode characters. Instruction files are bounded at 128 KiB, frontmatter at 8 KiB, and supporting text reads at 64 KiB. Files must be valid UTF-8 text; links, junctions, and paths escaping the selected skill folder are rejected. Metadata changes after discovery require a refreshed catalog.

The context breakdown includes the catalog within system instructions. Loaded instructions and resources count as tool results. The model is instructed to load the smallest useful set of workflows and follow the user's task, active mode, and tool permissions. Research subagents use the same read-only loader within their existing restrictions.

## Supporting resources

Read a resource within a skill by its relative path:

```json
{ "name": "frontend-engineering", "resource": "references/accessibility.md" }
```

The supplied workflows also reference other skills. For `backend-engineering/references/api-design.md`, select that skill explicitly:

```json
{ "name": "backend-engineering", "resource": "references/api-design.md" }
```

The model should not use `../` to cross skill folders. Selecting the referenced skill respects project overrides. Script files read through this tool are returned as text and never executed. The supplied Python loader, validator, and trigger examples remain development resources; they are not required or run by Cubex at startup.

The packaged runtime loads skill instructions and their supporting references/templates. Library maintenance commands such as `python tools/validate_skills.py` in `skill-authoring`, and the `evals/` examples, require the source-library checkout; they are not installed executable tools or paths in an unrelated active project. The model must verify that the referenced files and dependencies exist in its task workspace and that command execution is available and permitted before using them. If they are unavailable, it must explain that limit without claiming validation ran.

## Add or customize a skill

Create `.cubex/skills/your-skill/SKILL.md` in the selected project:

```markdown
---
name: your-skill
description: Explain the specific work this skill helps with and when to select it.
---

# Your workflow

Describe the decisions, constraints, and verification that improve this task.
Preserve the user's scope and use only tools available in the current session.
```

Use a short lowercase hyphenated name. Keep discovery descriptions clear and at most 1,024 characters. Quote a description containing a colon followed by a space. Put substantial examples in supporting files and state when they should be read. Use an existing skill's name to override it for a project.

Edit `agent-skills-library/skills/` to change the bundled source, then rebuild Cubex to update the packaged application. The package includes the supplied instruction folders, README, index, and [MIT license](../agent-skills-library/LICENSE). Cubex discovers the actual files rather than trusting the generated index as a source of paths.

Review imported guidance, provenance, scope, and commands before adding it. This supplied library is integrated as provided; its README documents its standards and references. Cubex does not use the Python keyword matcher as a production router, and does not claim that every configured model selects skills identically. The library's `evals/trigger-tests.jsonl` contains positive and negative examples for model-specific routing evaluation.

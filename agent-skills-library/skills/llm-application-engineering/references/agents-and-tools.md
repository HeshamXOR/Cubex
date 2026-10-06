# Agents and tools

## Contents
1. The agent loop
2. When to build an agent
3. Tool design principles
4. Prompting agents
5. Context management for long tasks
6. Planning, reflection, and verification
7. Multi-agent patterns
8. Guardrails and human oversight
9. Error handling and recovery
10. Testing and observability
11. Harness architecture checklist
12. Anti-patterns

## 1. The agent loop
```
messages = [system, user_task]
for step in range(MAX_STEPS):
    response = model(messages, tools)
    messages.append(response)
    if response has no tool calls: return final answer
    for call in response.tool_calls:
        result = execute_with_policy(call)      # validate, authorize, sandbox, time-limit
        messages.append(tool_result(call.id, result))
    messages = manage_context(messages)         # trim, summarize, cache
raise StepLimitExceeded
```
Model = decides; harness = executes, enforces policy, tracks state and budgets. Keep the loop simple and transparent; log every message and tool call.

## 2. When to build an agent
Build agents for open-ended tasks with unpredictable steps where the value justifies higher cost and latency (coding, research, data investigation, customer support with actions). Use fixed workflows for tasks with known steps. Start with the simplest design and add autonomy only when evals show a gain. Define what "done" means and how the agent can verify it (tests pass, record exists, checklist satisfied).

## 3. Tool design principles
- **Name and describe for the model**: `search_orders`, `create_ticket`; the description states purpose, when to use, when not to, side effects, and returned shape; parameter descriptions include format, units, allowed values, and examples.
- **Right-sized granularity**: a few high-value tools that map to how a person would do the task; consolidate chatty multi-step APIs into one tool that does the workflow (`schedule_meeting` rather than list, check, create, notify), but keep tools focused enough to be safe.
- **Return useful, token-efficient results**: human-readable names alongside ids; relevant fields only; pagination, filtering, and truncation with hints ("showing 20 of 340; refine with `status`"); optional `response_format` (concise vs detailed).
- **Actionable errors**: say what went wrong and how to fix it ("`date` must be YYYY-MM-DD; got '3/4/26'"); avoid stack traces.
- **Prevent mistakes by design (poka-yoke)**: absolute paths instead of relative, enums instead of free text, required confirmations for destructive actions, dry-run modes, idempotency keys.
- **Namespacing**: prefix by service or resource (`github_create_issue`) when many tools exist.
- **Security**: authorize as the end user; least-privilege credentials; validate all arguments server-side; path and URL allowlists; rate limits; audit logs. Tool descriptions from third parties are untrusted prompt input.
- **Test tools with the model**: run realistic tasks, read transcripts, and refine descriptions and schemas where the model misuses them. Track tool-call error rates.

## 4. Prompting agents
- Describe the role, environment, available tools and their purposes, constraints, and definition of done. Give guidance on when to ask the user for clarification vs proceed.
- Encourage **exploration before action** (read files, search, inspect state), **verification after action** (run tests, re-query), and concise reporting.
- Set expectations on effort: simple tasks need few steps; complex tasks may warrant planning first. Specify when to stop and what to output.
- State safety rules positively and specifically: which actions require approval, what data must not be exposed, what to do on ambiguity or conflicting instructions.
- Provide examples of good tool sequences for tricky workflows.

## 5. Context management for long tasks
- Keep a **working memory file/notes** (plan, decisions, progress, open questions) the agent updates and re-reads; this survives context resets.
- **Compaction**: when nearing limits, summarize history preserving decisions, file paths, identifiers, unresolved issues, and next steps; drop raw tool output that has been processed.
- **Tool result clearing**: replace old bulky results with short stubs referencing how to re-fetch them.
- **Just-in-time retrieval**: hold lightweight references (paths, ids, URLs) and load details on demand instead of preloading.
- **Sub-agents**: delegate deep exploration to a fresh context and receive a concise summary (a few hundred tokens) back.
- Use prompt caching for the stable prefix (system prompt and tool definitions); keep it byte-identical between calls and put dynamic content after it.

## 6. Planning, reflection, and verification
- For non-trivial tasks: have the agent write a short plan, execute step by step, and update it as facts change. Plans are hypotheses.
- Add **verification steps**: run tests/linters, validate output schemas, cross-check numbers, re-read requirements, diff against expected. External verifiers beat self-assessment.
- **Reflection/critic loops** help when criteria are clear (evaluator-optimizer); cap iterations.
- Detect loops (repeated identical tool calls, no state change) and break with a change of strategy or escalation.

## 7. Multi-agent patterns
- **Orchestrator-workers**: lead agent plans and spawns workers for independent subtasks in parallel (research across sources, files, hypotheses), then synthesizes. Give each worker a clear objective, output format, tools, and boundaries to avoid duplicate work.
- **Specialists with handoffs**: routing to domain-specific agents with their own prompts and tools.
- **Generator-critic**: separate agents (or prompts) for producing and reviewing.
- Costs multiply (multi-agent runs can use several times more tokens); use for high-value, parallelizable work. Pass structured messages, keep shared state explicit (files, databases), and avoid agents writing to the same resource concurrently without coordination.
- Do not add agents to compensate for a poorly designed single agent or tools.

## 8. Guardrails and human oversight
- Deterministic policy layer between model and tools: allowlists, argument validation, budgets, rate limits, path/domain restrictions.
- **Human-in-the-loop** approvals for irreversible, costly, or externally visible actions; show the exact action and parameters. Provide undo where possible.
- Sandboxing for code execution and browsing; separate credentials per task; no secrets in context.
- Limits: max steps, tokens, time, spend, and concurrent tool calls; kill switch.
- Input/output classifiers and moderation as secondary defenses; do not treat them as the primary control.
- See `security-review/references/llm-and-agent-security.md`.

## 9. Error handling and recovery
- Return errors to the model as tool results so it can adapt; distinguish retryable (timeouts, 429) from non-retryable (validation, permission) errors; retry transient ones in the harness with backoff.
- Make actions resumable: persist state (task, plan, completed steps, artifacts) so crashes or restarts continue rather than restart; use idempotency keys for side effects.
- On repeated failure, escalate to the user with a concise summary of what was tried.
- Handle context overflow, model refusals, truncated outputs (`max_tokens`), and malformed tool calls explicitly.

## 10. Testing and observability
- Unit-test tools like normal code; integration-test agent tasks in sandboxed environments with deterministic fixtures; evaluate with outcome graders (`llm-application-engineering/references/evals.md`).
- Record full transcripts, tool calls, timing, tokens, cost, and outcomes; provide a replay viewer; review failures regularly and convert them into eval cases.
- Monitor real-world metrics: task success rate, steps per task, cost per task, tool error rates, approval rates, escalations, and safety events.

## 11. Harness architecture checklist
- [ ] Model interface abstracted (provider, model id, parameters configurable and logged)
- [ ] Tool registry with schemas, descriptions, permissions, and versioning
- [ ] Skill loader (progressive disclosure: metadata in prompt, full instructions on demand, resources on demand)
- [ ] Policy engine and approval workflow
- [ ] Sandbox for code and file operations with resource and network limits
- [ ] State store for runs (messages, plan, artifacts), resumable
- [ ] Context manager (compaction, caching, tool-result clearing)
- [ ] Budgeting and rate limiting; retries and timeouts
- [ ] Tracing, logging with redaction, evaluation hooks
- [ ] User interface for streaming, interrupts, approvals, and feedback

## 12. Anti-patterns
- Giving an agent every tool "just in case" (confusion and risk)
- Vague tool descriptions and free-form string parameters
- No step, cost, or time limits
- Relying on the prompt alone to prevent dangerous actions
- Dumping huge tool outputs into context
- Building multi-agent systems before proving a single agent fails
- Skipping evals; judging from a few impressive demos
- Letting untrusted content (web pages, emails, documents) issue instructions to privileged tools

---
name: llm-application-engineering
description: Builds, evaluates, and hardens applications powered by large language models: prompt design, structured outputs, tool use, retrieval-augmented generation (RAG), agents and workflows, context management, evaluation suites, cost and latency optimization, observability, and safety. Also covers core ML engineering practice such as data splits, leakage, baselines, and experiment tracking. Use whenever the task involves an LLM API, prompts, embeddings, vector search, chatbots, agents, tool calling, fine-tuning decisions, evals, or shipping any AI feature to production.
license: MIT
metadata:
  category: ai
  version: "1.0"
---

# LLM Application Engineering

Treat an LLM as a powerful but probabilistic, untrusted component. Reliability comes from good task design, clear interfaces, evaluation, and guardrails, not from hoping the prompt is perfect.

## 1. Choose the simplest thing that works

Climb the ladder only when the level below fails on your evals:
1. **Single LLM call** with a good prompt and a few examples
2. **Prompt chaining / workflow**: fixed sequence of calls with programmatic checks between them
3. **Routing**: classify the input, then dispatch to a specialized prompt, model, or tool
4. **Parallelization**: run independent subtasks or multiple samples and aggregate (voting, sectioning)
5. **Orchestrator-workers**: a model decomposes a task dynamically and delegates to workers
6. **Evaluator-optimizer loop**: generate, critique, revise against clear criteria
7. **Autonomous agent**: model chooses tools and steps in a loop until done

Workflows (predefined code paths) are more predictable, cheaper, and easier to test than agents; use agents only for open-ended problems where the steps cannot be predicted and you can tolerate higher cost and error compounding, with sandboxing and stopping conditions. Prefer direct API use and thin abstractions so prompts and tool results stay visible and debuggable; add frameworks only when they earn their complexity.

Also ask: does this need an LLM at all? Deterministic code, regex, classical ML, or search may be faster, cheaper, and more reliable for part of the task.

## 2. Prompt design

- **State the task, audience, and success criteria** plainly, as if briefing a capable new colleague with no context. Provide the background the model cannot infer: domain rules, definitions, constraints, what "good" looks like, and what to do when unsure.
- **Be specific and explicit** about format, length, tone, language, and what to include or exclude. Give the reason behind rules; models generalize better from reasons than from bare commands.
- **Structure the prompt** with clear sections; XML-style tags (`<document>`, `<instructions>`, `<examples>`) or Markdown headers separate instructions from data and reduce confusion. Put long reference documents first and the question or task last.
- **Use examples** (few-shot): 3 to 5 diverse, realistic, correct examples covering edge cases, wrapped in tags; make sure they do not accidentally teach unwanted patterns.
- **Let the model think when reasoning matters**: allow intermediate reasoning (extended or adaptive thinking features, or a scratchpad section) for multi-step problems, then a clean final answer. Keep reasoning out of user-facing fields via structured output fields.
- **Constrain outputs** with schemas (see section 3), enumerated labels, or prefilled/anchored formats rather than free text you must parse.
- **Handle uncertainty**: permit "unknown" or "insufficient information" and specify the fallback; instruct to quote evidence for extractive tasks.
- **Separate roles**: system prompt for durable behavior and policy; user turn for the task and data; keep secrets and authorization logic out of prompts.
- **Iterate with evals**, not vibes: change one thing, run the eval set, compare. Keep prompts in version control with tests.
- Avoid: vague adjectives ("good", "professional") without criteria, contradictory instructions, shouting in capitals, huge unstructured dumps, negative-only instructions ("don't do X") without saying what to do instead, and relying on the prompt to enforce security.
- Prompts are model-specific; re-evaluate when changing models or versions, and read the provider's current prompting guidance.

Prompt skeleton:
```
<role_and_goal>You are ... Your goal is ... for <audience>.</role_and_goal>
<context>Background facts, definitions, policies.</context>
<instructions>
1. ...
2. If information is missing, say what is missing instead of guessing.
</instructions>
<output_format>JSON matching the schema / sections / length.</output_format>
<examples><example><input>...</input><output>...</output></example></examples>
<input>{{user_or_document_content}}</input>
```

## 3. Structured outputs and parsing

- Use the provider's structured-output or tool-schema features to get schema-conformant JSON; validate with Pydantic/Zod anyway. Handle refusals, truncation (`stop_reason`/`finish_reason` of max tokens), and empty results.
- Keep schemas small and unambiguous: enums instead of free strings, descriptions on each field, required vs optional clear, no deeply nested structures if avoidable.
- On validation failure: retry with the error message once or twice, then fall back or escalate; never `eval` model output.
- Put reasoning or "evidence" fields before the answer field when you want the model to justify before concluding.

## 4. Tools and function calling

- Design tools like a good API for a new teammate: clear name (verb_noun), a description that says what it does, when to use it, and when not to, typed parameters with descriptions and examples, and informative error messages that suggest the fix.
- Few, well-differentiated tools beat many overlapping ones. Return concise, relevant results (trim large payloads; support pagination and filters); include stable identifiers for follow-up calls.
- Make tools idempotent or two-phase (dry run then commit) for side effects; enforce authorization in the tool code as the end user; validate arguments strictly.
- Cap tool calls per task, set timeouts, and handle failures gracefully (return the error to the model rather than crashing).
- Details and agent-loop design: `references/agents-and-tools.md`.

## 5. Retrieval-augmented generation (RAG)

Use RAG to ground answers in private, large, or fast-changing knowledge. Quality is decided mostly by retrieval. See `references/rag.md` for chunking, hybrid search, reranking, citations, and RAG evaluation.

## 6. Context and memory management

- Context is a finite, expensive resource: include what the model needs for this step, not everything available. Long contexts degrade attention on details ("context rot"); place key instructions and the current question clearly, and prune stale material.
- Techniques: summarize older turns, keep a structured scratchpad or notes file for long tasks, retrieve on demand instead of preloading, use sub-agents with clean contexts that return concise results, and clear old tool results.
- Use **prompt caching** for stable prefixes (system prompt, tools, large documents) to cut cost and latency; keep the stable part first and identical across calls.
- Persistent memory must be validated, scoped per user, and treated as untrusted input (it can be poisoned).

## 7. Evaluation

You cannot improve or safely change what you do not measure. Start small and early: 20 to 50 real, varied examples beat none. See `references/evals.md` for datasets, graders, LLM-as-judge practices, regression testing, and online monitoring.

## 8. Cost, latency, and reliability

- **Right-size the model**: use a smaller/faster model for classification, routing, extraction; a stronger one for hard reasoning; validate on evals. Cascade: try cheap first, escalate on low confidence.
- **Reduce tokens**: concise prompts, trimmed retrieval, structured outputs, caching, and batch APIs for non-urgent bulk work (often discounted).
- **Latency**: stream tokens to the UI, run independent calls in parallel, reduce round trips, prefetch, keep prompts short, and set `max_tokens` sensibly.
- **Resilience**: timeouts, retries with exponential backoff and jitter for 429/5xx/overloaded errors, respect `retry-after`, circuit breakers, fallbacks (alternate model/provider, cached or degraded answer), idempotency for actions.
- **Budgets**: per-user and per-tenant token and cost limits, max agent steps, alerts on spend anomalies.
- **Determinism**: lower temperature for extraction/classification; do not expect bitwise reproducibility; pin model versions and snapshot model IDs; re-run evals before upgrading.

## 9. Observability

Log (with PII redaction): prompt template version, model and parameters, inputs, retrieved documents with ids and scores, tool calls and results, outputs, token counts, latency, cost, errors, user feedback. Trace multi-step runs as spans (OpenTelemetry GenAI semantic conventions or tools like Langfuse, LangSmith, Arize Phoenix, Braintrust, Helicone). Sample production traces into an evaluation queue; turn failures into new test cases.

## 10. Safety and security

Treat all model inputs from outside as untrusted and all model outputs as untrusted; enforce permissions in code. Apply the OWASP Top 10 for LLM Applications (prompt injection, sensitive information disclosure, improper output handling, excessive agency, unbounded consumption, and others). Full guidance: `security-review/references/llm-and-agent-security.md`. Also:
- Provide user-facing transparency (AI disclosure, source citations, feedback controls) and human escalation for high-stakes domains (medical, legal, financial).
- Test for harmful outputs, bias, and privacy leakage relevant to your domain; add content moderation where needed.
- Comply with data-handling rules: no training on customer data without consent; retention limits; regional data requirements.

## 11. Fine-tuning and training decisions

Before fine-tuning, exhaust: better prompts and examples, retrieval, tool use, and a stronger base model. Fine-tune for consistent style/format, latency/cost reduction via smaller models, or narrow domain behavior with plenty of high-quality labeled data. Prefer parameter-efficient methods (LoRA/QLoRA) for open models. Keep a clean evaluation set separate from training data, track the base-model baseline, and watch for regressions in general capability and safety. For open-model workflows record dataset versions, hyperparameters, seeds, hardware, and evaluation results in an experiment tracker (Weights & Biases, MLflow), and publish model cards with intended use, limits, and licenses.

## 12. Classical ML engineering essentials

- Define the metric that reflects business value; establish a **naive baseline** (majority class, last value, simple linear model) before complex models.
- **Split data correctly**: train/validation/test; by time for temporal data; by group/user for repeated entities; stratify for imbalance. Fit all preprocessing on training data only (pipelines) to avoid **leakage**.
- Use cross-validation for small datasets; keep a final test set untouched until the end.
- Choose metrics for the problem: precision/recall/F1/PR-AUC for imbalance, ROC-AUC with caution, calibration, RMSE/MAE for regression, ranking metrics (NDCG, MRR) for retrieval, and slice metrics across subgroups.
- Error analysis over hyperparameter fiddling: inspect misclassified examples, find data issues, then decide whether to improve data, features, or models.
- Reproducibility: seeds, pinned environments, versioned data and code, tracked experiments; package models with their preprocessing; monitor drift and performance in production; plan retraining triggers and rollbacks.

## Definition of done for an LLM feature

- [ ] Task success criteria and failure modes defined; eval set with realistic and adversarial cases
- [ ] Simplest architecture that meets the eval bar; model and prompt versions pinned
- [ ] Structured outputs validated; errors, refusals, and truncation handled
- [ ] Retrieval and tools authorized as the end user; tool actions safe and bounded
- [ ] Cost, latency, and rate limits measured against budget; caching and fallbacks in place
- [ ] Tracing, feedback capture, and monitoring live; regressions caught in CI
- [ ] Prompt-injection, data-leak, and abuse testing done; human oversight where stakes are high

## Reference files

- `references/evals.md`: building datasets and graders, LLM-as-judge, regression testing, online evals
- `references/rag.md`: ingestion, chunking, embeddings, hybrid retrieval, reranking, prompting for grounded answers, RAG evals
- `references/agents-and-tools.md`: agent loop design, tool design, context strategies, multi-agent patterns, guardrails

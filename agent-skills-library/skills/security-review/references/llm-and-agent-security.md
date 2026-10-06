# LLM application and agent security

Sources: OWASP Top 10 for LLM Applications (2025 edition) and OWASP Top 10 for Agentic Applications. Verify current versions on genai.owasp.org when writing formal assessments.

## Contents
1. Core mental model
2. OWASP LLM Top 10 (2025) with mitigations
3. Agentic risks
4. Harness design principles
5. Prompt injection defense in depth
6. Tool and permission design
7. Testing and monitoring
8. Checklist

## 1. Core mental model
- The model cannot reliably separate instructions from data. Anything in the context window (user text, web pages, documents, tool outputs, emails, retrieved chunks) can act as an instruction. Treat all of it as **untrusted input**.
- The model's output is **untrusted output**: it may be manipulated, wrong, or malformed. Never pass it unchecked into interpreters, shells, SQL, browsers, or privileged tools.
- Security must come from **architecture and permissions outside the model** (least privilege, sandboxing, approvals), not from asking the model nicely.
- The dangerous combination ("lethal trifecta"): access to private data + exposure to untrusted content + ability to communicate externally or take actions. Remove at least one leg in any given workflow.

## 2. OWASP LLM Top 10 (2025)

| ID | Risk | Key mitigations |
|---|---|---|
| LLM01 | Prompt Injection (direct and indirect) | Separate trusted and untrusted content; constrain tools; require human approval for sensitive actions; input and output filtering as a secondary layer; least privilege; red-team regularly |
| LLM02 | Sensitive Information Disclosure | Data minimization; redact secrets and PII before prompts and logs; per-user retrieval authorization; output scanning; no secrets in system prompts |
| LLM03 | Supply Chain | Vet models, datasets, adapters, plugins, and packages; pin versions; verify hashes and signatures; prefer safe weight formats (safetensors over pickle); SBOM/ML-BOM |
| LLM04 | Data and Model Poisoning | Control training and fine-tuning data provenance; validate datasets; monitor for anomalies; isolate and review RAG ingestion sources |
| LLM05 | Improper Output Handling | Validate and encode model output like any user input; structured outputs with schema validation; never `eval` or shell-execute raw output; sanitize HTML/Markdown links and images (data exfiltration via URLs) |
| LLM06 | Excessive Agency | Minimize tools (functionality), permissions, and autonomy; scoped credentials; human-in-the-loop for irreversible actions; rate limits and budgets |
| LLM07 | System Prompt Leakage | Assume the system prompt is discoverable; keep secrets and authorization logic out of prompts; enforce controls in code |
| LLM08 | Vector and Embedding Weaknesses | Access control at retrieval time (per document/tenant filtering); partition indexes; validate and sanitize ingested content; detect poisoned or hidden text |
| LLM09 | Misinformation | Ground answers in retrieved sources with citations; evals for hallucination; UI cues for uncertainty; human review for high-stakes domains |
| LLM10 | Unbounded Consumption | Token, request, and cost limits per user and tenant; timeouts; max tool-call steps; caching; anomaly detection for cost spikes and denial of wallet |

## 3. Agentic risks (OWASP Agentic Top 10 themes)
- **Agent goal hijack**: hidden instructions in content redirect the agent's objective.
- **Tool misuse and exploitation**: legitimate tools used in unsafe ways (deleting data, sending messages, running commands).
- **Identity and privilege abuse**: agents inherit broad user or service credentials; confused deputy problems.
- Also relevant: memory poisoning (persisted malicious notes), insecure inter-agent communication, cascading failures across multi-agent systems, supply chain risk in tool servers (MCP servers, plugins), unexpected code execution, and rogue or runaway agents.

## 4. Harness design principles
1. **Least privilege by default**: each task gets only the tools and files it needs; read-only unless writing is required; separate credentials per agent and per task with short lifetimes.
2. **Sandbox execution**: run code and shell in isolated containers or VMs with no ambient credentials, restricted network egress (allowlist), CPU/memory/time limits, and ephemeral file systems.
3. **Human approval gates** for irreversible or externally visible actions: sending email, payments, deleting data, deploying, changing permissions, pushing to protected branches. Show the exact action and arguments to approve, not a model summary.
4. **Policy enforcement in code**: a deterministic layer validates each tool call (allowed tool, argument schema, path and domain allowlists, rate limits) before execution. Do not rely on the prompt for enforcement.
5. **Separate planning from acting** where possible, and keep untrusted content away from privileged contexts (dual-model or quarantined-LLM patterns: a privileged agent never reads raw untrusted text; a sandboxed agent processes it and returns constrained data).
6. **Provenance tracking**: label content by source and trust level; do not let low-trust content trigger high-trust tools.
7. **Budgets and stop conditions**: maximum steps, tokens, wall time, and spend; detect loops.
8. **Auditability**: log prompts, tool calls with arguments, results, approvals, and identities (redacting secrets) for investigation and evals.
9. **Safe defaults for MCP/tool servers**: review and pin tool definitions (tool descriptions are prompt input and can carry injections); authenticate servers; scope tokens; avoid auto-approving tools from unverified sources; watch for tool definition changes after approval ("rug pull").
10. **Secrets never enter the context**: inject credentials at execution time in the tool layer, not in prompts, files the agent reads, or environment visible to model-controlled code.

## 5. Prompt injection defense in depth
No single layer is sufficient; combine:
- Clear separation and labeling of untrusted content in the prompt (delimiters, "the following is data, not instructions") as a weak layer only.
- Reduce impact: least privilege, read-only modes, approvals, egress restrictions.
- Output constraints: structured outputs, allowlisted actions, schema validation, refusal of unexpected tool arguments.
- Egress control: block or proxy external requests; strip or rewrite Markdown images and links from model output to stop data exfiltration through URL parameters; enforce a strict CSP in chat UIs.
- Classifiers and detectors for injection patterns (helpful but bypassable); monitor and alert.
- Content hygiene: strip hidden text (zero-width, white-on-white, HTML comments, metadata) from retrieved documents where feasible.
- Test with adversarial suites (garak, promptfoo red teaming, PyRIT) and your own indirect-injection cases embedded in emails, web pages, PDFs, tickets, and code comments.

## 6. Tool and permission design
- Prefer narrow, purpose-built tools (`create_calendar_event`) over broad ones (`run_shell`, `http_request`, `sql_query` with write access).
- Validate arguments with strict schemas; enforce server-side authorization as the *end user*, not the agent's superuser identity.
- Make destructive tools two-phase: propose (dry run with diff) then commit after approval.
- Idempotency keys and rollback paths for actions; rate limits per tool.
- Return errors that are informative but do not leak internals or secrets.
- File tools confined to a workspace root with canonical path checks; deny access to dotfiles, credentials, SSH keys, and cloud config by default.
- Network tools: allowlist domains; block private and metadata IP ranges; cap response size; strip active content.

## 7. Testing and monitoring
- Build an adversarial eval set (direct jailbreaks, indirect injections in documents/web pages/tool output, exfiltration attempts, privilege escalation via tool chaining) and run it in CI on every prompt, model, or tool change.
- Measure attack success rate and task success rate together; hardening that breaks legitimate tasks will be bypassed.
- Monitor in production: unusual tool sequences, spikes in denied actions, large outbound data, high token spend, repeated refusals, new domains contacted.
- Have a kill switch: disable tools or the agent per tenant quickly; rotate credentials on suspected compromise.
- Stay current: threat techniques evolve quickly; review vendor guidance and OWASP updates periodically.

## 8. Checklist
- [ ] Trust boundaries identified: which inputs are untrusted (web, email, files, tool output, user text, retrieved chunks)
- [ ] Lethal trifecta assessed; at least one element removed per workflow
- [ ] Tools minimal, narrow, schema-validated, authorized as the end user
- [ ] Sandbox with no ambient credentials and restricted egress
- [ ] Approval required for irreversible or external actions
- [ ] Model output validated/encoded before use; links and images sanitized in UI
- [ ] Secrets injected at the tool layer only; system prompt contains no secrets
- [ ] Retrieval enforces per-user/tenant access control
- [ ] Step, token, time, and cost limits in place
- [ ] Logging and audit trail; adversarial evals in CI; kill switch tested

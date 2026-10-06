---
name: security-review
description: Performs defensive security review and threat modeling of code, architecture, configuration, dependencies, CI/CD pipelines, and LLM or agent systems, mapped to the OWASP Top 10:2025, and produces prioritized findings with concrete fixes. Use whenever the user asks for a security audit, vulnerability check, secure coding guidance, threat model, secrets or dependency review, hardening advice, or when code handles authentication, authorization, user input, files, payments, personal data, external requests, or untrusted content, even if security is not mentioned. Defensive use only; does not build malware or exploits.
license: MIT
metadata:
  category: security
  version: "1.0"
---

# Security Review

Find and fix weaknesses before attackers do. Think like an attacker, act like an engineer: every finding gets a realistic impact, a proof or clear reasoning, and a specific remediation.

**Scope note:** this skill is for defensive work (reviews, hardening, secure design, detection, remediation, authorized testing guidance). Do not produce working malware, weaponized exploits, or help against systems the user is not authorized to test.

## 1. Approach

1. **Understand the system**: assets (what is valuable), actors (users, admins, services, attackers), entry points (routes, queues, files, webhooks, CLI, UI), trust boundaries (browser to server, service to service, tenant to tenant, app to third party), and data flows for sensitive data.
2. **Threat model** quickly with STRIDE per boundary: Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, Elevation of privilege. Ask: what is the worst thing that could happen here, and who could make it happen?
3. **Review by risk**, not by file order: authentication and session handling, authorization checks, input handling and parsers, secrets, data storage and transport, third-party calls, file and process operations, admin functions, CI/CD.
4. **Verify** suspected issues by tracing the data from source (untrusted input) to sink (dangerous operation) and confirming no effective validation, encoding, or authorization sits between them.
5. **Report** with severity, evidence, impact, and fix. Prefer fixing the class of bug (central control) over one instance.

## 2. OWASP Top 10:2025 review map

The current list (released late 2025) and what to look for in code and config. Details in `references/owasp-top10-2025-checklist.md`.

| ID | Category | Look for |
|---|---|---|
| A01 | Broken Access Control (includes SSRF) | Missing object-level checks (BOLA), missing function-level checks (BFLA), IDOR, mass assignment, path traversal, CORS misconfiguration, forced browsing, tenant leaks, server-side requests to user-supplied URLs |
| A02 | Security Misconfiguration | Default credentials, debug mode in production, open cloud storage, permissive IAM, missing security headers, verbose errors, unnecessary services and ports, insecure defaults in frameworks and IaC |
| A03 | Software Supply Chain Failures | Unpinned or unvetted dependencies, typosquatting, compromised build pipeline, unsigned artifacts, floating CI action tags, missing lockfiles, no SBOM, no provenance |
| A04 | Cryptographic Failures | Plaintext sensitive data, weak algorithms (MD5, SHA-1, DES, ECB), hardcoded keys, missing TLS, poor randomness, custom crypto, bad key management |
| A05 | Injection | SQL, NoSQL, OS command, LDAP, template, header injection, XSS, unsafe deserialization, unsanitized prompt or query construction |
| A06 | Insecure Design | Missing threat model, absent rate limits or business-logic checks, trust in client-side controls, no abuse-case tests, unsafe workflows (refund, reset) |
| A07 | Authentication Failures | Weak or missing MFA, credential stuffing exposure, weak password storage, session fixation, predictable tokens, insecure reset flows, long-lived tokens |
| A08 | Software or Data Integrity Failures | Unsigned updates, insecure deserialization, untrusted CDN scripts without SRI, CI pipelines that run unreviewed code, unverified plugins |
| A09 | Security Logging and Alerting Failures | No audit log for auth and admin events, logs missing context, secrets in logs, no alerting or response path, logs injectable |
| A10 | Mishandling of Exceptional Conditions | Failing open on errors, unhandled exceptions leaking data, inconsistent error handling, resource exhaustion, missing timeouts, partial transactions left in inconsistent state |

## 3. Fast review checklists

### Input and output
- [ ] All external input validated by allowlist (type, length, format, range) at the boundary
- [ ] Parameterized queries / ORM bindings; no string-built SQL, shell commands, or templates from input
- [ ] Output encoded for its context (HTML, attribute, JS, URL, CSS); frameworks' auto-escaping not bypassed (`dangerouslySetInnerHTML`, `|safe`, `v-html`, `innerHTML`)
- [ ] File uploads: allowlist types by content not extension, size limits, random storage names, stored outside webroot, scanned, served with `Content-Disposition` and `nosniff`
- [ ] Paths built with canonicalization and base-directory checks (no `../` traversal)
- [ ] Deserialization uses safe formats (JSON) with schema validation; never `pickle`, `yaml.load`, Java native serialization on untrusted data
- [ ] Outbound requests from user-supplied URLs use allowlists, block private, loopback, link-local, and metadata ranges, resolve then connect (DNS rebinding), and limit redirects and response size

### Authentication, authorization, session
- [ ] Every route has an explicit authn and authz decision; deny by default
- [ ] Ownership/tenant checked per object on read, update, delete, and in bulk and export paths
- [ ] Client cannot set privileged fields (role, owner, price)
- [ ] Passwords hashed with Argon2id/bcrypt/scrypt; reset tokens single-use, short-lived, stored hashed
- [ ] Cookies `HttpOnly; Secure; SameSite`; CSRF protection for cookie-authenticated writes
- [ ] Rate limiting and lockout on login, reset, OTP, and expensive endpoints

### Secrets and configuration
- [ ] No secrets in code, history, images, client bundles, or logs; secret scanning enabled
- [ ] Production config separated from dev; debug off; least-privilege service accounts
- [ ] Security headers: CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, frame protection
- [ ] TLS everywhere; certificate validation not disabled (`verify=False`, `rejectUnauthorized: false` are findings)

### Data protection
- [ ] Sensitive data classified; minimized; encrypted in transit and at rest; retention defined
- [ ] PII and secrets redacted in logs, traces, error reports, analytics
- [ ] Backups encrypted and access controlled; deletion honors privacy obligations

### Dependencies and pipeline
- [ ] Lockfiles committed; dependency audit in CI (`npm audit`, `pip-audit`, `osv-scanner`, Dependabot/Renovate); SBOM for releases
- [ ] New dependencies vetted (maintainers, downloads, name spelling, install scripts)
- [ ] CI actions pinned to full commit SHAs; minimal `GITHUB_TOKEN` permissions; OIDC instead of long-lived cloud keys; no untrusted input interpolated into shell steps (see `devops-and-ci-cd`)
- [ ] Artifacts built in clean environments, signed, provenance recorded (SLSA)

### Availability and resilience
- [ ] Request size, timeout, concurrency, and pagination limits
- [ ] Regex reviewed for catastrophic backtracking on user input (ReDoS)
- [ ] Expensive operations (exports, search, uploads, LLM calls) rate limited and quota controlled
- [ ] Errors fail closed; exception paths do not leak stack traces or leave partial state

## 4. LLM and agent applications

Treat model output and retrieved content as untrusted input, and treat tools as privileged capabilities. Use `references/llm-and-agent-security.md` for the OWASP Top 10 for LLM Applications (2025) and agentic risks, including prompt injection, excessive agency, improper output handling, system prompt leakage, and unbounded consumption.

## 5. Severity guide

| Severity | Typical criteria |
|---|---|
| Critical | Remote unauthenticated code execution, full data breach, auth bypass to admin, exposed production secrets with broad access |
| High | Exploitable injection, broken access control exposing other users' data, stored XSS on privileged pages, SSRF to internal network or metadata service |
| Medium | Requires user interaction or specific conditions: CSRF on sensitive action, reflected XSS, weak session management, missing rate limits on sensitive endpoints |
| Low | Limited impact or hard to exploit: verbose errors, missing headers, minor information disclosure |
| Info | Hardening advice, defense in depth, no direct exploit |

Adjust by exploitability (authentication needed? network position?), impact (confidentiality, integrity, availability, blast radius), and exposure (internet-facing? sensitive data?). Where useful, cite CWE ids and CVSS vectors.

## 6. Report format

```
## Executive summary
Scope, method, overall risk, top 3 issues.

## Findings
### [High] Broken object-level authorization in GET /invoices/{id}  (CWE-639, OWASP A01:2025)
Where: api/invoices.py:41
Evidence: handler loads invoice by id without checking tenant_id; tested with user B token against user A invoice id -> 200.
Impact: any authenticated user can read any tenant's invoices (PII, amounts).
Fix: scope query by tenant (`WHERE id = :id AND tenant_id = :tenant`); add authorization test; consider row-level security.
Effort: small. Verification: regression test added.

## Hardening recommendations
## Out of scope / not verified
```

Report only what you can support; state assumptions and what was not tested. Recommend fixes that fit the stack and centralize controls (middleware, policy layer, secure defaults).

## 7. Secure-by-default habits when writing code

- Validate at boundaries, authorize at every object access, encode on output, parameterize queries.
- Least privilege for credentials, tokens, IAM roles, DB users, and containers (non-root, read-only filesystem, dropped capabilities).
- Prefer well-maintained libraries and platform features over custom security code.
- Fail closed, log security events, and never log secrets.
- Add security tests for authorization boundaries, injection payloads, and abuse cases; run SAST (Semgrep, CodeQL), dependency scanning, and secret scanning in CI; use DAST and periodic penetration tests for internet-facing systems.

## Reference files

- `references/owasp-top10-2025-checklist.md`: per-category detection cues, code smells, and remediation
- `references/llm-and-agent-security.md`: OWASP LLM Top 10 (2025) mapping and guardrail design for agent harnesses

# OWASP Top 10:2025: detection cues and remediation

The 2025 edition added Software Supply Chain Failures (A03) and Mishandling of Exceptional Conditions (A10), folded SSRF into Broken Access Control (A01), moved Security Misconfiguration up to A02, and renamed A09 to "Security Logging and Alerting Failures". Confirm the latest version at owasp.org/Top10 before citing in formal reports.

## Contents
- A01 Broken Access Control
- A02 Security Misconfiguration
- A03 Software Supply Chain Failures
- A04 Cryptographic Failures
- A05 Injection
- A06 Insecure Design
- A07 Authentication Failures
- A08 Software or Data Integrity Failures
- A09 Security Logging and Alerting Failures
- A10 Mishandling of Exceptional Conditions
- Grep-able patterns

## A01 Broken Access Control
**Cues:** handlers that fetch by id from path or body with no owner or tenant filter; role checks only in the UI; admin routes protected by obscurity; `PUT /users/{id}` accepting `role`; `Access-Control-Allow-Origin` reflecting the request origin; file download endpoints joining user input to paths; server fetching user-supplied URLs (SSRF).
**Fix:** central authorization layer with deny by default; query scoping by principal; separate DTOs for input (no mass assignment); tests with two users and two tenants; URL fetching through an egress proxy or allowlist that blocks link-local (169.254.169.254), loopback, and private ranges after DNS resolution; require IMDSv2 on cloud instances.

## A02 Security Misconfiguration
**Cues:** `DEBUG=True`, stack traces in responses, default admin credentials, public S3/GCS buckets, `0.0.0.0` bound admin panels, wildcard IAM (`*:*`), permissive security groups, missing headers, directory listing, verbose banners, Kubernetes privileged pods or `hostPath`, containers as root, unpatched base images, sample apps left deployed, unrestricted CORS.
**Fix:** hardened baseline images and IaC modules; policy as code (OPA/Conftest, Checkov, tfsec, kube-linter); separate configs per environment; automated configuration scanning; remove unused features; least privilege; regular drift detection.

## A03 Software Supply Chain Failures
**Cues:** no lockfile; `latest` tags; `curl | bash` installers; dependencies added by name without vetting (typosquats); CI actions on floating tags (`@v3`, `@main`); `pull_request_target` running PR code; build secrets exposed to forks; no provenance; install scripts running with credentials; abandoned packages; vendored code without tracking.
**Fix:** commit lockfiles and use deterministic installs (`npm ci`, `pip install --require-hashes`, `uv sync --frozen`); pin base images by digest; pin CI actions by SHA; review new dependencies (maintainers, activity, install scripts, download history); private registry or proxy with allowlist; SBOM (CycloneDX/SPDX); artifact signing and provenance (Sigstore/cosign, SLSA); automated update PRs with tests; two-person review for pipeline changes; monitor advisories (OSV, GHSA).

## A04 Cryptographic Failures
**Cues:** MD5/SHA-1 for passwords or signatures; AES-ECB; static IVs; hardcoded keys; `Math.random()`/`random` for tokens; TLS verification off; sensitive data over HTTP or in URLs; password reversible encryption; own crypto protocols; missing at-rest encryption for sensitive fields; long-lived unrotated keys.
**Fix:** TLS 1.2+ (prefer 1.3) with HSTS; Argon2id/bcrypt/scrypt for passwords; AEAD ciphers (AES-GCM, ChaCha20-Poly1305) via high-level libraries (libsodium, Tink, `cryptography`); CSPRNG (`secrets`, `crypto.randomBytes`, `crypto/rand`); KMS/HSM for keys with rotation; classify data and minimize what is stored.

## A05 Injection
**Cues:** string-built SQL (`f"... WHERE id = {x}"`); `os.system`, `subprocess(..., shell=True)`, `child_process.exec` with input; `eval`, `Function`, template string rendering of user input (SSTI); NoSQL operators from JSON bodies (`{"$ne": null}`); LDAP/XPath queries; unescaped HTML output; header values containing CRLF; log injection; prompt injection (see LLM reference).
**Fix:** parameterized queries; ORM with bound parameters; avoid shells (pass argument arrays, allowlist commands); contextual output encoding and framework auto-escaping; strict content security policy; input validation by schema; disallow operator keys in NoSQL inputs; sanitize HTML with a vetted library (DOMPurify, bleach, nh3) and an allowlist.

## A06 Insecure Design
**Cues:** no rate limit on password reset or coupon redemption; price or quantity trusted from the client; workflow steps skippable; no limit on resource creation per user; race conditions in balance updates (double spend); security relying on secrecy of an id; missing abuse cases.
**Fix:** threat modeling during design; abuse-case and misuse tests; server-side enforcement of business rules and state machines; transactional integrity and idempotency; quotas and rate limits; secure design patterns and reference architectures; segregate tenants.

## A07 Authentication Failures
**Cues:** no brute-force protection; accepting weak or default passwords; session id in URL; no session regeneration on login; JWT `alg: none` or unverified signature; long-lived tokens; user enumeration through messages or timing; MFA bypass through recovery paths; insecure "remember me".
**Fix:** MFA/passkeys; breached-password checks; generic errors; rate limiting and progressive delays; secure cookie flags; session rotation and revocation; short-lived tokens with rotation; use a proven identity provider or library.

## A08 Software or Data Integrity Failures
**Cues:** `pickle.loads`, `yaml.load`, Java `ObjectInputStream`, PHP `unserialize` on untrusted data; auto-update without signature verification; third-party `<script src>` without SRI; CI pipeline pulling and executing unreviewed scripts; cache poisoning; plugins loaded from user-writable paths; unsigned container images.
**Fix:** safe data formats plus schema validation; verify signatures and checksums; Subresource Integrity and CSP; protected branches and reviewed pipeline changes; sign and verify images (cosign, admission policies); isolate build steps.

## A09 Security Logging and Alerting Failures
**Cues:** no audit trail for logins, permission changes, data exports, admin actions; logs without user, IP, request id, outcome; logs stored only on the host; secrets or full PII in logs; no alert on repeated failures or anomalies; no incident runbook; log injection through unsanitized newlines.
**Fix:** central structured logging with integrity protection and retention; log security-relevant events with context but without secrets; alert on suspicious patterns (credential stuffing, privilege changes, unusual exports); test detections; define incident response and practice it.

## A10 Mishandling of Exceptional Conditions
**Cues:** `except: pass`; authorization code that returns allow when an exception occurs (failing open); unhandled exceptions revealing stack traces; missing `finally`/cleanup leaving locks or partial state; unchecked return values; no timeouts or size limits (resource exhaustion); inconsistent error handling across layers; retry loops without bounds.
**Fix:** a global exception handler that logs internally and returns generic problem responses; fail closed on security decisions; validate return values and preconditions; transactions with rollback; timeouts, limits, and circuit breakers; tests for error paths and fault injection; monitor for unhandled exceptions.

## Grep-able patterns (starting points, not proof)
```
# secrets
rg -n --hidden -i '(api[_-]?key|secret|passwd|password|token|private[_-]?key)\s*[:=]\s*["\x27][^"\x27]{8,}'
rg -n 'BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE KEY'
# injection sinks
rg -n 'execute\(f?["\x27].*(\+|%|\{)' ; rg -n 'shell=True|os\.system|child_process\.exec|eval\(|new Function\('
rg -n 'dangerouslySetInnerHTML|innerHTML\s*=|v-html|\|\s*safe\b'
# crypto and TLS
rg -n -i 'md5|sha1\(|DES|ECB|verify\s*=\s*False|rejectUnauthorized:\s*false|InsecureSkipVerify'
# deserialization
rg -n 'pickle\.load|yaml\.load\(|ObjectInputStream|unserialize\('
# CORS / debug
rg -n -i 'Access-Control-Allow-Origin.*\*|DEBUG\s*=\s*True|allow_origins=\["\*"\]'
```
Use SAST tools (Semgrep, CodeQL, Bandit, ESLint security plugins, gosec), secret scanners (gitleaks, trufflehog), dependency scanners (osv-scanner, pip-audit, npm audit, Trivy, Grype), and IaC scanners (Checkov, tfsec, Trivy config) to complement manual review.

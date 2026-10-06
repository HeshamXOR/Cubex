# Authentication, authorization, and sessions

## Contents
1. Vocabulary
2. Passwords
3. Sessions vs tokens
4. OAuth 2.0 and OpenID Connect
5. Multi-factor and passkeys
6. Authorization models
7. Browser protections: CSRF, CORS, cookies
8. Multi-tenancy
9. API keys and service credentials
10. Account lifecycle and abuse defenses
11. Checklist

## 1. Vocabulary
- **Authentication (authn)**: proving who the caller is. **Authorization (authz)**: deciding what they may do. Most severe API flaws are authorization bugs (broken object-level authorization, "BOLA", and function-level authorization "BFLA"; both sit under Broken Access Control, OWASP A01:2025).
- Prefer a mature identity provider or library (Auth0, Clerk, Keycloak, Cognito, Ory, Authlib, django-allauth, NextAuth/Auth.js) over custom implementations.

## 2. Passwords
- Hash with **Argon2id** (recommended) or scrypt or bcrypt with a high cost factor; unique salt per hash (built in); use the library's defaults tuned so hashing takes roughly 100 to 500 ms on your hardware. Optionally add a server-side pepper stored outside the database.
- Never store plaintext, reversible encryption, or fast hashes (MD5, SHA-1, plain SHA-256).
- Enforce length (minimum 8, allow at least 64, prefer 12+), allow all characters and spaces, allow paste, do not force periodic rotation; check against breached-password lists (k-anonymity API of Have I Been Pwned).
- Login: generic failure messages ("Invalid credentials"), uniform timing, rate limit by account and IP, temporary lockout or progressive delay, alert on anomalies.
- Reset: single-use, short-lived (15 to 60 min), high-entropy tokens stored hashed; invalidate sessions after reset; never reveal whether an email exists.

## 3. Sessions vs tokens
| Approach | Good for | Cautions |
|---|---|---|
| Server-side session (opaque id in cookie, data in Redis or DB) | Browser apps, easy revocation | Session store availability; sticky or shared store needed |
| Signed JWT access token (short-lived) | Service to service, APIs consumed by SPAs/mobile, stateless verification | Hard to revoke before expiry; large; do not store sensitive data in it; validate `iss`, `aud`, `exp`, `nbf`, signature algorithm (pin it, reject `none`) |
| Refresh token | Renew access tokens | Rotate on each use; detect reuse and revoke the family; store hashed server-side; bind to device where possible |

- Access tokens: 5 to 15 minutes. Refresh tokens: days to weeks, rotated. Absolute session lifetime plus idle timeout for sensitive apps.
- Browser cookies: `HttpOnly`, `Secure`, `SameSite=Lax` (or `Strict`), narrow `Path`/`Domain`, `__Host-` prefix when possible. Avoid keeping tokens in `localStorage` (readable by any XSS).
- Regenerate the session id on login and privilege change (prevents fixation). Provide "log out everywhere".
- Verify JWTs with a maintained library and a JWKS endpoint with key rotation (`kid`).

## 4. OAuth 2.0 and OpenID Connect
- Use **Authorization Code flow with PKCE** for all public clients (SPAs, mobile) and confidential web apps. Do not use the Implicit or Resource Owner Password flows.
- OIDC adds identity: validate the ID token (`iss`, `aud`, `exp`, `nonce`), use `sub` as the stable user key (not email).
- Validate `state` (CSRF) and exact-match registered redirect URIs.
- Request the minimum scopes; treat scopes as coarse permissions, still enforce fine-grained authorization server-side.
- Machine to machine: Client Credentials grant with short-lived tokens; mTLS or private-key JWT for high assurance.
- For workloads on cloud platforms prefer workload identity / OIDC federation over long-lived static keys.

## 5. Multi-factor and passkeys
- Offer and encourage MFA; require it for admins. Prefer **passkeys / WebAuthn** and TOTP over SMS (SIM swap, interception). Provide recovery codes, stored hashed.
- Step-up authentication for sensitive actions (change email, payout details).
- Accessible authentication (WCAG 3.3.8): do not force cognitive tests; allow password managers and paste.

## 6. Authorization models
- **RBAC** (roles): simple; roles map to permissions. **ABAC/PBAC** (attributes/policies): rules using user, resource, and context attributes. **ReBAC** (relationships, Zanzibar style: OpenFGA, SpiceDB): sharing and hierarchy ("editors of the folder can edit files inside").
- Enforce **deny by default**. Centralize policy in one layer (middleware, policy functions, or a policy engine like OPA/Cedar) rather than scattering `if user.role == ...`.
- **Object-level checks on every request**: load the resource scoped to the caller (`WHERE id = $1 AND owner_id = $2`) or verify ownership after loading; never trust an id from the client.
- **Property-level checks**: prevent mass assignment (whitelist writable fields; ignore `is_admin`, `role`, `owner_id` from clients) and excessive data exposure (explicit response schemas).
- **Function-level checks**: admin endpoints require admin authorization; do not rely on hidden URLs.
- Log authorization denials; test with at least two users to prove one cannot read or modify the other's data.

## 7. Browser protections: CSRF, CORS, cookies
- **CSRF** applies when browsers send credentials automatically (cookies). Defenses: `SameSite` cookies, anti-CSRF tokens (synchronizer or double-submit signed), checking `Origin`/`Sec-Fetch-Site` on state-changing requests, and requiring custom headers or JSON content types. APIs using bearer tokens in headers are not CSRF-prone.
- **CORS** is a browser relaxation, not a security control for your server. Use an explicit origin allowlist; never reflect arbitrary `Origin`; never combine `Access-Control-Allow-Origin: *` with credentials; restrict methods and headers.
- Security headers for HTML responses: `Content-Security-Policy` (start with report-only), `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, and frame protection via CSP `frame-ancestors`.

## 8. Multi-tenancy
- Every query filters by tenant; make it structural (repository layer requires tenant context; Postgres row-level security with a session variable) so forgetting is not possible.
- Include the tenant id in cache keys, object storage paths, search indexes, logs, and job payloads.
- Test tenant isolation explicitly, including background jobs and exports.
- Rate limits and quotas per tenant to contain noisy neighbors.

## 9. API keys and service credentials
- Generate long random keys (at least 128 bits of entropy) with a recognizable prefix (`sk_live_...`) so secret scanners can detect leaks.
- Show once; store only a hash (SHA-256 is fine for high-entropy keys) plus a non-secret prefix or id for lookup.
- Scope keys (read-only, per-resource), allow multiple keys, rotation, expiry, last-used timestamps, and immediate revocation.
- Never place keys in URLs (they leak in logs and referrers); use headers.
- Store server secrets in a secret manager, rotate regularly, and enable secret scanning and push protection in the repository.

## 10. Account lifecycle and abuse defenses
- Email verification before trust; re-verify on change; notify the old address of changes.
- Rate limits and bot defense on signup, login, reset, and OTP endpoints; CAPTCHA only as an accessible fallback.
- Session and device management page; alerts for new-device logins.
- Deletion and export flows (privacy laws), with data retention policies.
- Audit log of security events: logins, MFA changes, permission changes, key creation.

## 11. Checklist
- [ ] Passwords hashed with Argon2id/bcrypt/scrypt; no plaintext anywhere
- [ ] Tokens short-lived; refresh rotation; revocation path
- [ ] Cookies `HttpOnly; Secure; SameSite`; CSRF handled
- [ ] Authorization enforced server-side per object, per property, per function; deny by default
- [ ] Mass assignment prevented; response schemas explicit
- [ ] Tenant isolation structural and tested
- [ ] Rate limiting on auth and expensive endpoints
- [ ] Secrets in a manager; keys hashed at rest; scanning enabled
- [ ] Security events logged; no secrets or tokens in logs

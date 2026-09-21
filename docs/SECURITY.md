# Security

Cubex is a desktop client that holds API keys and runs model output. These are the measures that
keep that safe.

## Credential storage

- Secrets are encrypted with the **OS keychain** via Electron `safeStorage`
  (`src/main/credentials.ts`): DPAPI on Windows, Keychain on macOS, libsecret on Linux.
- Provider configs store only an opaque **`credentialRef`** — never the key itself. The plaintext
  key never touches `config.json` or SQLite.
- If OS encryption is unavailable (e.g. some headless Linux), Cubex **refuses to persist plaintext**
  and falls back to environment variables (`CUBEX_OPENAI_API_KEY`, `CUBEX_ANTHROPIC_API_KEY`, …).
- Deleting a provider deletes its stored secret.

## Secret redaction

All logging and the developer Inspector run through redaction helpers
(`packages/core/src/redaction`). Keys matching `authorization`, `api-key`, `x-api-key`, `cookie`,
`token`, `secret`, `password`, etc. are replaced, and value patterns that look like secrets
(`sk-…`, `sk-ant-…`, `Bearer …`, `hf_…`, `ghp_…`) are scrubbed from free text. Headers, request
bodies, and errors are redacted **before** they are written or displayed. Nothing sensitive reaches
the renderer.

## Electron hardening

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` — the renderer has no Node
  access and talks to the main process only through the typed `window.cubex` bridge.
- A **Content-Security-Policy** restricts the renderer to its own origin.
- External links open in the OS browser; in-app navigation away from the app origin is blocked.
- Native modules are unpacked from the asar (`asarUnpack: **/*.node`).

## Tool permission model

Tools never run without an explicit decision. Each `ExecutableTool` has a default permission of
`ask` / `allow` / `deny`; the `ToolRunner` requests a decision before executing an `ask` tool and
refuses `deny`. The built-in **subagent** tool only performs model inference (no side effects).
Model output is treated as **untrusted** — Cubex does not execute shell commands, scripts, or file
operations on the model's say-so, and local models are not granted arbitrary filesystem access.

## Official access only

Cubex uses officially documented APIs, SDKs, and OAuth flows exclusively. It does **not** scrape web
UIs, reuse session cookies, reverse-engineer private endpoints, or bypass rate limits or
subscription restrictions. A consumer subscription is not treated as API access; when a service
offers no official third-party access, the app says so and stops.

## Privacy

- Telemetry is **off by default**; Cubex makes no outbound calls except to the providers you
  configure.
- **Local Only mode** blocks all cloud providers and runs entirely on local runtimes.
- Conversations, logs, and settings are stored locally under the app data directory.

## Reporting a vulnerability

Please report security issues privately via a GitHub **Security Advisory** on the repository (or the
contact listed there) rather than a public issue. Include repro steps and affected versions; we'll
acknowledge and coordinate a fix and disclosure timeline.

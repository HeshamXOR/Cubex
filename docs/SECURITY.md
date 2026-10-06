# Security

Cubex is a desktop client that holds API keys, reads and edits your files, and runs commands on a model's behalf. This page lists what protects you, and states plainly what it does not cover.

## Credential storage

- Secrets are encrypted with the operating system's credential store through Electron `safeStorage` (DPAPI on Windows, Keychain on macOS, libsecret on Linux). The encrypted values are kept in `credentials.enc.json` in the data folder, and the file is written atomically.
- A provider's saved configuration holds only an opaque `credentialRef`, never the key. The plaintext key is never written to `config.json` or the database. Deleting a provider deletes its stored secret.
- If operating-system encryption is unavailable (some Linux setups without a keyring), Cubex refuses to store a secret in plaintext and says so. You can supply keys through environment variables instead (`CUBEX_OPENAI_API_KEY`, `CUBEX_ANTHROPIC_API_KEY`, `CUBEX_GEMINI_API_KEY`, `CUBEX_OPENAI_COMPAT_API_KEY`), which are read only when no stored key exists for that kind of provider.
- A secret variable on an MCP server entry is stored the same way, under a reference Cubex derives from the server and variable names. A settings file cannot point a server at another credential.
- Shell commands, hooks and MCP servers start with a cleaned environment: variables whose names look like credentials (`CUBEX_*`, `*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_PAT`, `*_CREDENTIAL`, `DATABASE_URL`, `ANTHROPIC_*`, `OPENAI_*`) are not passed on. A key a tool needs must be set on its own entry, such as an MCP server's environment variables.

## Secret redaction

Logs, error messages and the request inspector pass through the redaction helpers in `packages/core/src/redaction`. Values under keys such as `authorization`, `api-key`, `x-api-key`, `cookie`, `token`, `secret`, `password` and `credential` are replaced. Text that looks like a secret is scrubbed wherever it appears: OpenAI-style `sk-` keys, `sk-ant-` keys, `Bearer` tokens, GitHub `ghp_` tokens, Hugging Face `hf_` tokens and Google `AIza` keys. Output captured from hooks and MCP servers is redacted too, and an MCP server's own secret values are scrubbed from whatever it prints.

This is not a promise that arbitrary content is scrubbed. Source files, chat text and command output are shown as task data and may contain secrets.

## Electron hardening

- `contextIsolation` is on, `nodeIntegration` is off and the renderer is sandboxed. It has no Node access and reaches the main process only through the typed `window.cubex` bridge. Every handler treats its arguments as untrusted and validates ids, paths and sizes.
- A Content-Security-Policy limits the renderer to its own origin. Requests for `file:` URLs outside the renderer bundle are cancelled, so markup in a model reply cannot reach a network share or an arbitrary local file.
- Camera, microphone, location, notification and similar permission requests from the page are denied. Only writing to the clipboard is allowed.
- Links open in the system browser only for `http`, `https` and `mailto`. Navigating the window away from the app is blocked, and new windows are denied.
- Developer tools are disabled in the packaged app, and so are reload shortcuts. The packaged app allows one running instance.
- On Windows, Cubex sets `NoDefaultCurrentDirectoryInExePath` so that a program placed in a project folder cannot replace `git` or another tool that Cubex starts.
- Native modules are unpacked from the app archive (`asarUnpack: **/*.node`).

## Tool permissions

Every tool has a default permission of allow, ask or deny, and the mode you choose (Ask before edits, Accept edits, Plan mode or Bypass permissions) decides which asks are skipped. [HARNESS_WORKFLOW.md](HARNESS_WORKFLOW.md#permission-modes) has the full table. The points that matter for security:

- Plan mode blocks everything that would change something. Writes to protected folders (`.git`, `.cubex`, `.claude`, `.agents`, `.codex`, `.vscode`, `.husky`) ask in every mode except Bypass. A call recovered from model text instead of arriving as a real tool call always asks, even in Bypass.
- File tools reject paths that leave the project folder, including through symbolic links and junctions, and on Windows paths spelled in ways the file system would read differently. A file must have been read in the current turn before it is changed, and a change is refused if the file changed after that read. Searches skip symbolic links.
- `web_fetch` only reaches public addresses. It rejects private, loopback and link-local ranges, checks the address it actually connects to on each redirect, rejects URLs with embedded credentials, and asks before contacting a host that is not on a short list of documentation sites.
- The research subagent has a fixed read-only toolset. It cannot edit files, run commands, use the network, ask you questions or start another subagent.
- "Always allow" rules are created only from an ask Cubex raised, matched against the live call each time, and never offered for deletions, shells, interpreters, network tools, commands with shell syntax or calls carrying a risk notice.
- Approval does not override the operating system. An access-denied result is reported, and the model is told not to retry unchanged or switch shells to avoid it.

## What is not sandboxed

Cubex does not isolate commands, hooks or MCP servers. `run_command`, hooks and MCP server processes run under your operating-system account, with your files and your network access. Permission modes decide when Cubex asks, but a command you approve can do anything you can. A hook runs a command on every matching event without asking, including in Bypass mode. A background task keeps running until it ends or is stopped. Review what you approve, keep Plan mode and Ask before edits for work you do not yet trust, and treat MCP servers and hooks as code you are choosing to run.

Local-only mode (below) is a model-routing setting. It is not a network firewall.

## Data on disk

Conversations, plans, review copies, command output and settings live in the data folder and are not encrypted by Cubex. Credential encryption is separate. A command's text and output can contain source code, personal data or secrets printed by the command, and these logs are not redacted like request diagnostics.

- Saved command output is limited to 2 MiB per command and 50 outputs per task, stored under generated ids in task-hashed folders, read only through bounded checked reads, and only by the task that owns it.
- The review panel keeps copies of the original files a task changed, up to 5 MiB per file and 64 MiB per task.
- Message display metadata is limited to 1 MiB and 128 blocks per message, and the complete message text is stored separately. Imported transcript data cannot reach another task's saved output and is never replayed as tool calls.
- Drafts and file checkpoints stay in memory and are gone after a restart.
- Logs are kept locally (turn them off with **Local logging** in Settings) and are redacted before they are written.

## Provider access

Provider adapters use each vendor's documented API or SDK. They do not scrape web interfaces, reuse session cookies, reverse-engineer private endpoints, or get around rate limits or subscription terms. A consumer subscription is not treated as API access: when a service offers no official third-party access, Cubex says so and stops.

## Privacy

- Cubex sends no telemetry and has no analytics. The `telemetry` flag in the settings schema is not read by any code.
- Network traffic comes from what you configure and use: requests to your model providers, `web_search` (which sends the query to DuckDuckGo's HTML search page), `web_fetch` pages, the Ollama registry lookup that sizes a download, the model catalog at `https://models.dev/api.json` (downloaded at most every six hours, carrying nothing about you, cached on disk, and never called in local-only mode), and whatever your MCP servers, hooks and shell commands do.
- **Local-only mode** is checked before every model request, retry and fallback, including for a provider that was already created. It also blocks model-list refreshes and connection tests for cloud providers. Turning it on does not stop requests already in flight. The offline demo, Ollama, LM Studio and llama.cpp stay available, and a custom or OpenAI-compatible endpoint stays available only if you declare it local. Azure OpenAI and the native OpenAI, Anthropic and Gemini adapters are always treated as cloud, whatever they are labelled. A local declaration is trusted configuration, not an address check, so a remote address labelled local passes. The setting does not restrict tools, hooks, downloads, MCP servers or child processes.
- Tool results and recovered command output that the model asks for are sent to the active provider as part of the conversation, under that provider's terms.

## Reporting a vulnerability

Please report security issues privately, using GitHub's "Report a vulnerability" option on the repository's Security tab, and not in a public issue. Include steps to reproduce and the versions affected. We will acknowledge the report and agree a timeline for a fix and disclosure with you.

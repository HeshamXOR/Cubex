# Testing

Cubex uses [Vitest](https://vitest.dev). The suite has several thousand tests and needs no API keys, no GPU and no network. That works because the provider core is plain TypeScript with a mock provider, because the network adapters are tested against mocked `fetch` calls and fake streams, and because local runtimes have a mock too.

```bash
npm test                                   # run everything once
npm run test:watch                         # re-run on change
npx vitest run packages/core/src/gateway   # one folder or file
npx vitest run -t "Local Only"             # tests whose name matches
npm run test:cov                           # coverage report (see the note below)
```

`vitest.config.ts` runs the tests in a Node environment, enables globals, and picks up `packages/**/*.test.ts`, `src/**/*.test.ts` and `scripts/**/*.test.mjs`. The aliases `@core`, `@local` and `@shared` resolve as they do in the app. There are no DOM or component tests: the renderer is tested through its plain TypeScript (store logic, view models, helpers), not by mounting React.

Coverage uses the V8 provider, which needs the `@vitest/coverage-v8` package. It is not listed in `package.json`, so run `npm install -D @vitest/coverage-v8` before the first `npm run test:cov`.

## Mocks

- **`MockAIProvider`** (`packages/core/src/providers/mock`) never touches the network. It can simulate a normal reply, a slow stream, a timeout, a 429 with `Retry-After`, a 500, an invalid request, an authentication error, a tool call, and a failure that succeeds on the next attempt. Gateway, retry and fallback tests use it to stay deterministic.
- **`MockLocalRuntime`** (`packages/local/src/runtimes`) simulates detection, model listing, download progress, start and stop, and running out of memory. The app registers it when you start with `CUBEX_MOCK_LOCAL=1`.
- **Network adapters** are tested by replacing `globalThis.fetch` or the injected `fetch`, or by feeding fake `ReadableStream`s (server-sent events for the OpenAI-compatible, Gemini and Custom adapters, newline-delimited JSON for Ollama). The adapters built on the OpenAI and Anthropic SDKs are tested with a mocked SDK or a stubbed `fetch`, and through their pure translation helpers, which build requests and map responses on their own.
- **SQLite** cannot load under plain Node, because `better-sqlite3` is built for Electron's ABI by the `postinstall` script. The `db.*.test.ts` files bundle a small script with esbuild into a temporary folder in the repository root and run it with the installed Electron in Node mode (`ELECTRON_RUN_AS_NODE=1`). Run `npm test` from the repository root so that works, and expect a short-lived `.cubex-*-db-*` folder while they run.
- **Git** tests create throwaway repositories and skip themselves when `git` is not installed.

## What the tests cover

| Area | Where to look |
|---|---|
| Retry engine, backoff, error normalization | `packages/core/src/retry`, `packages/core/src/errors` |
| Gateway: streaming, retry, explicit fallback, cancellation, first-response and silence limits | `packages/core/src/gateway`, `packages/core/src/util/timeout.ts` |
| Provider metadata: catalog merge, declared 1M context models | `src/main/modelMetadata.ts`, `src/shared/longContext.ts` |
| Streaming: SSE parser, stream accumulator, tool-call assembly | `packages/core/src/streaming` |
| Redaction of keys, headers and token-shaped values | `packages/core/src/redaction` |
| Provider adapters: request translation, stream mapping, error mapping | `packages/core/src/providers/*` |
| Reasoning effort per provider and model | `packages/core/src/providers/effort.test.ts`, `nativeEffort.test.ts` |
| Provider presets, input validation, Local Only routing, connection checks | `src/shared/providerPresets.test.ts`, `src/main/providerInput.test.ts`, `src/main/ProviderManager*.test.ts`, `src/main/ipc.providers.test.ts` |
| Tool loop, permission modes, approvals, rules, parallel read-only calls | `src/main/ChatService*.test.ts`, `src/main/permissionRules.test.ts`, `src/main/parallelTools.test.ts` |
| File tools: read, glob, search, edit, multi-edit, patch, remove, path safety | `src/main/tools/*.test.ts` |
| Shell, background tasks and process-tree termination | `src/main/tools/shell*.test.ts`, `src/main/processManager.test.ts`, `src/main/shell` |
| Saved command output | `src/main/commandOutput.test.ts`, `src/main/ChatService.commandOutput.test.ts` |
| Git tools, commit and status | `src/main/tools/git*.test.ts`, `src/main/gitCommit.test.ts`, `src/main/gitStatus.test.ts` |
| Plans, checkpoints, restore | `src/main/plans.test.ts`, `src/main/checkpoints.test.ts`, `src/main/restoreCoordinator.test.ts` |
| Change review: hunks, revert, comments | `src/main/sessionChanges*.test.ts`, `src/main/reviewModel.test.ts`, `src/main/ipcModules/review.test.ts` |
| Type-check diagnostics after edits | `src/main/diagnostics` |
| Context accounting, summarizing, pruning, budget, usage and cost | `src/main/context*.test.ts`, `src/main/compaction*.test.ts`, `src/main/budget.test.ts`, `src/main/cost.test.ts`, `src/shared/*Policy.test.ts` |
| Skills and subagents | `src/main/skills.test.ts`, `packages/core/src/gateway/SubagentTool.test.ts` |
| Hooks and MCP (client, launch, environment and secrets, tool names) | `src/main/hooks.test.ts`, `src/main/mcp` |
| Notifications | `src/main/notifications` |
| Updates: reading a release, the feed, download, verification, install, scheduling | `src/main/updates`, `src/shared/updates.test.ts`, `src/shared/version.test.ts`, `src/main/ipcModules/updates.test.ts` |
| Other agents: settings checks, the tool, starting programs, reading output | `src/shared/peers.test.ts`, `src/main/peers`, `src/main/ChatService.peers.test.ts` |
| Release tooling: the changelog, the tag check, the release text, the local feed | `scripts/*.test.mjs` |
| Persistence and transcripts | `src/main/db.*.test.ts`, `src/shared/messageTranscript.test.ts` |
| IPC contract | `src/main/ipcContract.test.ts`, `src/main/ipcModules/registry.test.ts` |
| Local: estimation, compatibility, benchmark runner, download queue and guards, Ollama runtime | `packages/local/src` |
| Renderer logic: store, queue, restore, review, tasks, formatting | `src/renderer/src/state`, `src/renderer/src/lib` |

`src/main/ipcContract.test.ts` guards the seam between the window and the main process. It fails when a channel in `src/shared/ipc.ts` has no handler in main, is not bridged in the preload script, is handled twice, or when an API method is missing from the preload bridge. The browser preview answers every call with a stub, so this is the test that catches a feature that only works there.

## Tests that depend on the platform

- Tests that start real processes (the shell tool, background tasks, hooks, MCP servers) end process trees with `taskkill` on Windows and process-group signals elsewhere. A locked-down sandbox can deny `taskkill`, and those tests then fail for that reason, not because of your change.
- Some tests only run on one platform: Windows shells and Windows path rules run only on Windows, and signal and process-group tests run only on POSIX. They skip elsewhere, so a skip is not a failure. Record skips separately from passes when you report results.
- When the whole suite runs in parallel on a busy machine, a few tests that create and delete many files can fail with `EPERM` or timeouts. They pass when run alone, so re-run the failing file before suspecting a regression.
- Cubex approval does not override an operating-system access denial, and no test claims it does.

## Writing tests

- Put `*.test.ts` next to the code it covers.
- For a new provider adapter, cover request translation, stream-event mapping and one error case of each kind (a transient one and a permanent one). `packages/core/src/providers/openai/translate.test.ts` and `ollama/OllamaProvider.test.ts` are good models.
- For gateway behavior, drive `AIGateway` with `MockAIProvider` scenarios and pass a no-op `sleep` through `retryHooks` so retries do not wait.
- Take the clock, the file system and the network as parameters where you can. Most modules accept injected `fetch`, `now` or host objects for this reason.
- A new IPC channel needs a handler, a preload bridge and an entry in the `IPC` object. The contract test then checks it.

## Visual checks

For a quick look at the interface without launching Electron, start the browser preview:

```bash
npm run dev:web
```

It serves the renderer at `http://localhost:5199` (the port is fixed, and the command fails if it is taken). Without Electron there is no `window.cubex`, so the renderer uses a stub that returns empty data. Add `?seed=1` for sample data: providers, conversations grouped by project, local models and a hardware profile. Open `http://localhost:5199/?seed=1&done=1` for a finished turn.

Flags go in the query string and combine with `seed`:

| Flag | Effect |
|---|---|
| `thread` | A turn paused on a permission request |
| `done` | A finished turn |
| `pendingplan` | A turn waiting for plan review |
| `compacted` | A conversation whose older messages were summarized |
| `stream` | Plays a live reply through the real store |
| `review`, `tab=changes`, `plan`, `details`, `tasks` or `files` | Open the right-hand panel on that tab |
| `review=hunks` with `rv=fresh`, `empty`, `none`, `slow`, `error`, `working` or `sendfail` | Hunk review in different situations |
| `tasks`, `files`, `diagnostics`, `policy`, `usage`, `budget=warn` or `over`, `compact=ok`, `fail` or `hold` | Sample data and failure cases for those features |
| `restore`, `history`, `queue=N`, `queuehold` | Restore points, prompt history and the message queue |
| `pull=hold`, `queue`, `stall`, `nospace`, `fail` or `slow`, `runtime=down`, `hw=slow`, `error`, `none`, `nogpu`, `long` or `analyzefail` | Local model downloads and the Hardware screen |
| `providers=empty`, `many`, `nokey`, `testfail`, `testslow` or `savefail`, `presets=many` or `fail` | Providers and Presets screens |
| `about=error`, `openfail` or `source` | The About page |
| `update=available`, `downloading`, `ready`, `error`, `portable`, `noinstaller`, `skipped`, `uptodate`, `checking`, `failed`, `long`, `cut`, `empty` or `none`, with `busy=1` | The update card, window and Settings page in each state. `window.__updates` drives the simulation from a script |
| `agents=none`, `configured` or `thread`, `agentstest=fail` or `slow` | Other agents in Settings and in a chat |

Each seed file in `src/renderer/src/lib/seeds` describes its own flags in the comment at the top. The preview also exposes `window.__store`, the app's zustand store, so you can switch screens from the console, for example `__store.getState().setView('hardware')`.

The seed data is development-only. It is excluded from production builds, so the packaged app never contains it. The preview shows what the renderer does with data it is given. It does not prove that persistence, tool execution or the IPC bridge work. Check those in Electron with `npm run dev`.

## CI

`.github/workflows/ci.yml` runs on every push and pull request to `main`, in one Windows job: `npm ci`, `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`. It does not build installers. Run the same four commands locally before opening a pull request. `.github/workflows/release.yml` runs when a version tag is pushed: it repeats lint, type check and tests, builds the installer and publishes it ([RELEASING.md](RELEASING.md)).

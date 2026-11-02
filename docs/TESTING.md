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
| Hooks, including Stop hooks that keep the agent working, and MCP (client, launch, environment and secrets, tool names) | `src/main/hooks.test.ts`, `src/main/ChatService.hooks.test.ts`, `src/main/mcp` |
| Goals: the rules, the check command, the judging, the `goal_update` tool, the loop in the window | `src/shared/goal.test.ts`, `src/main/goal`, `src/main/tools/goalTool.test.ts`, `src/main/ChatService.goal.test.ts`, `src/renderer/src/state/goal.test.ts`, `src/renderer/src/lib/goalText.test.ts` |
| Keeping the PC awake | `src/main/power` |
| Notifications | `src/main/notifications` |
| Updates: reading a release, the feed, download, verification, install, scheduling | `src/main/updates`, `src/shared/updates.test.ts`, `src/shared/version.test.ts`, `src/main/ipcModules/updates.test.ts` |
| Other agents: settings checks, the tool, starting programs and their environment, reading output | `src/shared/peers.test.ts`, `src/main/peers/consultTool.test.ts`, `src/main/peers/peerRunner.test.ts`, `src/main/peers/environment.test.ts`, `src/main/peers/output.test.ts`, `src/main/peers/framing.test.ts`, `src/main/ChatService.peers.test.ts` |
| Finding agents on this PC: the list of known agents, versions, accounts, the sign-in window, what a row says | `src/shared/agentCatalog.test.ts`, `src/main/peers/detect.test.ts`, `src/main/peers/signIn.test.ts`, `src/renderer/src/lib/agentRows.test.ts` |
| ACP agents: the protocol, signing in, permissions, modes and whether an agent can take a task, sessions kept between messages | `src/main/peers/acp` |
| Claude Code behind a bridge: how it is started, its tools in the protocol's terms, its questions as permission requests, the messages it sends, and the real program | `src/main/peers/claude`, `src/main/peers/appPrograms.test.ts` |
| Antigravity: the pinned release, the installer and its checks, the archive reader, the profile and the environment, starting and holding the runtime, signing in and out, the filter, the shape of its tool calls, what Settings is told | `src/main/peers/antigravity`, `src/main/ipcModules/antigravity.test.ts`, `src/shared/antigravity.ts`, `src/renderer/src/lib/antigravityRows.test.ts` |
| Tasks handed to another agent: the policy for each permission mode, one run, the folder comparison, the tool and its questions, and the words on the row | `src/main/peers/acp/delegatePolicy.test.ts`, `src/main/peers/delegate.test.ts`, `src/main/peers/manifest.test.ts`, `src/main/peers/delegateTool.test.ts`, `src/main/ChatService.delegate.test.ts`, `src/renderer/src/lib/delegateText.test.ts` |
| Release tooling: the changelog, the tag check, the release text, the local feed | `scripts/*.test.mjs` |
| Persistence and transcripts | `src/main/db.*.test.ts`, `src/shared/messageTranscript.test.ts` |
| IPC contract | `src/main/ipcContract.test.ts`, `src/main/ipcModules/registry.test.ts` |
| Local: estimation, compatibility, benchmark runner, download queue and guards, Ollama runtime | `packages/local/src` |
| Renderer logic: store, queue, restore, review, tasks, formatting | `src/renderer/src/state`, `src/renderer/src/lib` |

ACP is tested without a real agent. `src/main/peers/acp/testing/mockAgent.cjs` is a scripted agent that speaks the protocol on its standard input and output. Environment variables make it demand a sign-in, offer modes (as modes or as a configuration option), print noise, hang or exit, and lines in the prompt make it ask for a permission, reply in chunks, change its own mode, edit or delete a file only when it was allowed, ask to run a command, report steps, or write a file without asking, as an agent that does not keep to the policy would. The tests start it as a real process, so they cover the framing, the handshake, the policy and the stopping of processes, but not how any real agent behaves. The tests of a task run it in a temporary project folder. The adapters named in the presets for Codex and the others have not been run against the vendors' agents, so choose **Test** on your own agent. It is plain JavaScript (`.cjs`), so the type check and the linter skip it.

Claude Code has two stand-ins. `src/main/peers/claude/testing/mockClaude.cjs` speaks Claude Code's `stream-json` protocol and is scripted the same way, with `@claude` lines in the message. `src/main/peers/claude/real.test.ts` goes further and starts the real Claude Code, from `PATH` or from the Claude desktop app, when this PC has one. Claude Code is pointed at `testing/anthropicMock.ts`, a scripted stand-in for the model service, so no account is used and nothing leaves the computer. That test proves what the first stand-in cannot: that the options Cubex starts it with are accepted, that its questions and answers have the shape it speaks, and that the rules Cubex gives it hold against a person's own settings. Set `CUBEX_SKIP_REAL_CLAUDE=1` to leave it out, or `CUBEX_TEST_CLAUDE` to the path of the program to try. It skips itself when there is no Claude Code.

Antigravity is tested without Google's runtime, which is a download of 125 MB and a Google sign-in. `src/main/peers/antigravity/testing/mockAgy.cjs` stands in for it: it needs `authenticate` before a session, reports the address of a sign-in page the way the real runtime does (by starting the program the `BROWSER` variable names), names its tool fields its own way and sends questions for the person as permission requests. Its header lists the lines it understands (`@agy say`, `tool`, `question`, `expire`, `hang`, `exit`) and the variables that set the rest (`MOCK_SIGNIN`, `MOCK_AUTH_URL`, `MOCK_USE_BROWSER`, `MOCK_NO_REPORT`, `MOCK_DEFAULT_SAY`, `MOCK_CONTROL` and others). The installer tests build their archives in memory (`testing/makeZip.ts`) and serve them from a fake `fetch`, so the checks of the size, the hash and the members are tested with archives that are wrong in each way. A test that wants a runtime installed on disk uses `testing/fixtures.ts`, which installs the stand-in in a temporary data folder.

The packaged app was also driven end to end against these stand-ins, with the runtime replaced by a small compiled program that starts the stand-in the way the real one is started: the install, the sign-in, a page that is not Google's, a sign-in that ends in the middle of an answer, tasks that were allowed and denied, sign-out, removal while a session is kept, local-only mode, the scrubbed environment, and that no process or temporary folder is left behind. None of that touches Google.

`src/main/ipcContract.test.ts` guards the seam between the window and the main process. It fails when a channel in `src/shared/ipc.ts` has no handler in main, is not bridged in the preload script, is handled twice, or when an API method is missing from the preload bridge. The browser preview answers every call with a stub, so this is the test that catches a feature that only works there.

## Tests that depend on the platform

- Tests that start real processes (the shell tool, background tasks, hooks, MCP servers) end process trees with `taskkill` on Windows and process-group signals elsewhere. A locked-down sandbox can deny `taskkill`, and those tests then fail for that reason, not because of your change.
- Some tests only run on one platform: Windows shells and Windows path rules run only on Windows, and signal and process-group tests run only on POSIX. They skip elsewhere, so a skip is not a failure. Record skips separately from passes when you report results.
- When the whole suite runs in parallel on a busy machine, a few tests that create and delete many files can fail with `EPERM`, `EBUSY` or timeouts. They pass when run alone, so re-run the failing file before suspecting a regression.
- Cubex approval does not override an operating-system access denial, and no test claims it does.

## Writing tests

- Put `*.test.ts` next to the code it covers.
- A test that starts a program in a folder it made removes the folder with `removeFolder` (`src/main/testing/removeFolder.ts`), not with `rmSync`. On Windows a program that was stopped a moment ago still holds its working directory for a while, the removal fails with `EBUSY`, and `rmSync` does not try that error again whatever `maxRetries` is. `removeFolder` waits for the program to let go, for about eight seconds at most, and leaves the folder to the system's temporary-folder cleanup after that.
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
| `agents=none`, `configured` or `thread`, `agentstest=fail`, `slow` or `notasks`, `detect=mixed`, `none`, `nonode`, `localonly`, `desktop`, `slow` or `error`, `signin=fail` | Other agents in Settings and in a chat, with an ACP agent among them, and what **Found on this PC** reports. `detect=desktop` is a PC with the Claude desktop app and nothing else |
| `agy=none`, `nodesktop`, `downloading`, `extracting`, `verifying`, `failed`, `cancelled`, `installed`, `waiting`, `signinfailed`, `signedin`, `update`, `unsupported` or `localonly`, with `agyhold=1`, `agyfail=1` or `agyrefuse=1` | The Antigravity row of **Found on this PC** in each state. Install and sign-in run as a short simulation, so the whole path can be walked. Nothing is downloaded and no browser is opened |
| `delegate=done`, `running`, `task`, `edit`, `command`, `review`, `failed` or `cancelled` | A task handed to another agent: the row in the thread, opened or not, and the questions about the task, an edit and a command. They ride on `thread=1` |
| `goal=working`, `checking`, `idle`, `paused`, `blocked`, `stalled`, `limit` or `complete`, `goalcheck=none`, `goalthread=1` | The goal bar in each state, and the divider where the agent was sent back to work. They ride on `done=1` or `thread=1` |

Each seed file in `src/renderer/src/lib/seeds` describes its own flags in the comment at the top. The preview also exposes `window.__store`, the app's zustand store, so you can switch screens from the console, for example `__store.getState().setView('hardware')`.

The seed data is development-only. It is excluded from production builds, so the packaged app never contains it. The preview shows what the renderer does with data it is given. It does not prove that persistence, tool execution or the IPC bridge work. Check those in Electron with `npm run dev`.

## CI

`.github/workflows/ci.yml` runs on every push and pull request to `main`, in one Windows job: `npm ci`, `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`. It does not build installers. Run the same four commands locally before opening a pull request. `.github/workflows/release.yml` runs when a version tag is pushed: it repeats lint, type check and tests, builds the installer and publishes it ([RELEASING.md](RELEASING.md)).

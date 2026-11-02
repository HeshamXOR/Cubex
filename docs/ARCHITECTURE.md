# Architecture

Cubex keeps the provider-agnostic core free of Electron and the UI. That boundary is what lets the whole cloud pipeline run in tests against a mock provider, with no credentials and no GPU.

```text
Renderer (React)
      |   window.cubex, a typed bridge exposed by the preload script
      v
Main process (Electron, Node)
      |   ChatService, LocalService, ProviderManager, tools, storage
      v
AIGateway: retry, and fallback when targets are configured
      |
      v
Provider adapter: OpenAI, Anthropic, Gemini, OpenAI-compatible, Azure,
                  Custom, Ollama, mock
```

Chat requests always go through the gateway and a provider adapter. A local model is just a provider (Ollama, LM Studio or llama.cpp). Managing local models (detect, list, download, delete) is separate and goes through `LocalService` and the `LocalRuntime` interface.

## Layers

| Layer | Location | Responsibility |
|---|---|---|
| Core | `packages/core` | Unified request, response and stream types, `AIGateway`, the retry engine, stream and error normalization, secret redaction, the model registry, the provider adapters, the subagent tool, and a generic tool-loop runner. Pure TypeScript with no Electron or DOM imports. |
| Local | `packages/local` | Hardware profiling, memory and speed estimates, the compatibility check, the benchmark runner, the download queue, the local runtimes (Ollama and a mock) and a short model catalog. |
| Main | `src/main` | The Electron main process: IPC handlers, `ProviderManager`, `ChatService` (the agent loop, tools, permissions, plans, summarizing, budget, hooks), `LocalService`, credentials, SQLite, settings, logging, the MCP client, shell and background tasks, type-check diagnostics, change review, notifications, the update service (`src/main/updates`), the judging of goals (`src/main/goal`), keeping the PC awake (`src/main/power`) and the other agents a model can consult or hand a task to, and the finding of them on this PC (`src/main/peers`, with the ACP agents in `src/main/peers/acp`). |
| Preload | `src/preload` | The typed `window.cubex` bridge. Context isolation and the sandbox are on, so the renderer has no Node access. |
| Renderer | `src/renderer` | The React UI, built with Vite, with state in zustand. |
| Shared | `src/shared` | The IPC contract (`ipc.ts`), the settings types, and pure helpers used by both processes (policies, provider presets, attachment rules). |

`packages/core` and `packages/local` never import Electron or the DOM, and compile and test on their own.

## The provider contract

Every provider implements one interface (`packages/core/src/types/provider.ts`):

```ts
interface AIProvider {
  readonly id: string
  readonly name: string
  readonly kind: ProviderKind
  getModels(): Promise<ModelInfo[]>
  sendMessage(req: AIRequest, opts?: RequestOptions): Promise<AIResponse>
  streamMessage(req: AIRequest, opts?: RequestOptions): AsyncIterable<AIStreamEvent>
  supports(capability: Capability): boolean
  validateConfiguration(): Promise<ValidationResult>
}
```

`createProvider(config, secret)` in `packages/core/src/providers/factory.ts` is the one place that maps a `ProviderKind` to an adapter. The kinds are `openai`, `anthropic`, `gemini`, `openai-compat`, `custom`, `ollama`, `llamacpp`, `lmstudio` and `mock`. LM Studio and llama.cpp reuse the OpenAI-compatible adapter, and Azure OpenAI is the OpenAI-compatible kind in its `azure` mode. [PROVIDERS.md](PROVIDERS.md) covers each adapter.

## Requests, responses and streaming

Requests and responses are provider-agnostic. Message content is an array of parts (text, image, file, audio, video, tool use, tool result and reasoning), never a bare string, so images and tool calls have a first-class form. Each adapter translates to and from its provider's wire format. The request carries sampling parameters for programmatic callers, but the app exposes no temperature control. The one tuning control is reasoning effort, which each provider maps to its own parameter.

Adapters turn their native streams (server-sent events or newline-delimited JSON) into one event union:

```text
start, text_delta, reasoning_delta, tool_call_delta, tool_call,
usage, metadata, stop, completed, error
```

`StreamAccumulator` folds the events into a final response, so the UI renders the same events for every provider.

## Gateway, retry and fallback

`AIGateway.send()` and `.stream()` resolve the target, wrap each provider call in the retry engine, and report progress as events (`attempt_start`, `attempt_error`, `retry_wait`, `fallback`, `final`) that feed the routing trail in the Details panel.

- Errors are normalized to a `NormalizedAIError` with a category and a transient, permanent or unknown classification. Only transient errors, and unknown ones when the policy says so, are retried. Authentication, invalid-request and model-not-found errors never are. Backoff is exponential with jitter and honors `Retry-After`. The defaults are three attempts, a 500 ms first delay and a 30 second ceiling, and Settings exposes them.
- A stream is retried only before anything has streamed. Once text, reasoning or tool-call data has gone out, an error ends the turn and the partial response is kept. A request is cut only when it is stuck, never because it is slow: the wait for the response to begin has its own limit (ten minutes by default, matching the Anthropic and OpenAI SDKs), a response that has begun is cut only after five minutes of silence, and an optional overall limit (off by default) is the only ceiling that can end a request while it is still sending. Every limit is set in minutes under **Waiting and timeouts** in Settings.
- Fallback is an engine capability only. The gateway can try an ordered list of further targets when fallback is enabled, but the desktop app always passes an empty list and no screen configures one.

## Errors

`normalizeHttpError` and `normalizeUnknownError`, plus provider-specific mappers, turn every provider's failures into a `NormalizedAIError` (`AUTHENTICATION_ERROR`, `RATE_LIMIT_ERROR`, `CONTEXT_LENGTH`, `TIMEOUT`, `LOCAL_RUNTIME_ERROR` and others). This is what makes retry and the error messages provider-independent.

## How a turn runs

1. The window sends a start request over IPC with the routing policy, the message, attachments and the permission mode.
2. `ChatService` builds the tool set for the turn (file, shell, task, git, web, skill, subagent and MCP tools, as the project and settings allow), builds the system prompt from the tools that were actually registered, and loads the task's history. A summary of older turns stands in for them when the task has been summarized.
3. It loops: check the budget, prune or summarize if the context is nearly full, send the request through the gateway, stream events to the window, and run the tool calls the model made. Read-only calls can run in parallel. Anything that needs approval waits for you, and a task handed to another agent always runs alone. The loop ends when the model stops calling tools, when you stop it, or after 50 requests.
4. The main process numbers the events of each stream. The renderer applies them in order and ignores older or replayed events.
5. Usage and cost are recorded in the main process as each response completes. When the turn ends, the window saves the conversation through IPC: every message in full, with display metadata for tool rows beside it.

[HARNESS_WORKFLOW.md](HARNESS_WORKFLOW.md) describes the tools, permissions, plans and review in detail.

## Other agents

A chat reaches other coding agents in two ways, and Settings finds them. All of it is in `src/main/peers` ([OTHER_AGENTS.md](OTHER_AGENTS.md) describes what a person sees).

- **`consult_agent`** sends a message and reads an opinion. A program answers one message and exits. An ACP agent keeps a session open between messages (`acp/sessions.ts`), over JSON-RPC on the program's standard input and output (`acp/connection.ts`, `acp/agent.ts`).
- **`delegate_task`** hands over a whole task. `delegate.ts` starts a fresh ACP agent in the project folder, gives it the task and answers each permission request through `acp/delegatePolicy.ts`, which reads the chat's permission mode at that moment. When a request has to be put to the person, the policy calls back into `ChatService`, which sends it to the window as a permission card and waits. The project folder is listed before and after (`manifest.ts`), and what the agent changed is handed to the same change tracking that the file tools use, so **Changes** and **Rewind** cover it. The tool and its approval text are in `delegateTool.ts`.
- **Finding agents.** `detect.ts` looks for the programs listed in `src/shared/agentCatalog.ts`, asks each for its version and, for two of them, for the account it is signed in with. `appPrograms.ts` adds the places a desktop app keeps a program that is not on `PATH`: the copy of Claude Code that the Claude desktop app brings, found by folder and file names only, newest version first, and looked for again each time because the app updates itself. `signIn.ts` opens a terminal window that runs an agent's own sign-in command. None of this reads a saved login. Every program Cubex starts for these gets the environment built in `peerRunner.ts`, which removes anything that looks like a key or token.
- **How an agent's process is started.** The preset decides (`acp/starters.ts`). Most agents are a program that speaks the protocol and is started as written in the list. Two have a starter of their own, and each hands the rest of Cubex an `AcpProcess`, so the session pool, the policy and the cards that show the work do not know the difference:
  - **Claude Code** (`claude/`). `start.ts` starts the program with the rules of `launch.ts` in its own `stream-json` mode, and `bridge.ts` translates between that and the protocol: a tool's question (`can_use_tool`) becomes a permission request, and the answer goes back as allow or deny. `tools.ts` describes each tool in the protocol's terms (a kind, the places it touches, the change as a diff) so the policy can judge it.
  - **Antigravity** (`antigravity/`). Google's runtime is a separate download, so there is a lifecycle around it. `release.ts` pins the release and `install.ts` installs it (`zip.ts` reads the archive), keeping an "active" pointer, so a release is replaced only after the new one passed every check. `profile.ts` gives the runtime a profile and an environment of its own, `runtime.ts` starts it, and `signin.ts` signs in and out. `filter.ts` stands between Cubex and the runtime on the lines they send each other: it keeps the runtime from asking for a sign-in inside a chat, answers its questions for the person with "cancelled", and uses `wire.ts` to put its tool calls in the shape the rest of Cubex reads. `ipcModules/antigravity.ts` serves the Settings row and pushes its state.
- **What a process holds.** A runtime holds a lease on the release it runs from, and its run's folders, until it is gone. The filter tells the client the process ended as soon as it is stopped, and gives up the lease and the folders when the runtime reports that it ended, so a release is not removed from under a runtime that is still dying and a folder is not removed while the runtime works in it. A runtime that has not ended after three seconds has them taken from it anyway.

The agent is offered no file access and no terminal by Cubex, so everything it does to the project is something it asks about or something Cubex finds by comparing the folder afterwards.

## Extension points

Several folders are scanned with `import.meta.glob`, so a feature adds a file and edits no central list.

| To add | Do this |
|---|---|
| A provider | Implement `AIProvider` (extend `BaseProvider`) in `packages/core/src/providers/<kind>/` and register the kind in `factory.ts`. See [PROVIDERS.md](PROVIDERS.md). |
| A local runtime | Implement `LocalRuntime` in `packages/local/src/runtimes` and register it in `LocalService`. |
| An agent Cubex knows by name | Add an entry to `KNOWN_AGENTS` in `src/shared/agentCatalog.ts` (the program to look for, how to read its account, how to sign in, what adding it sets up), and an ACP preset in `src/shared/peers.ts` when it speaks ACP. |
| A tool | Create an `ExecutableTool` (a definition, a default permission of allow, ask or deny, and `execute`) and register it in `ChatService.start`. Mutating tools should ask. `ToolRunner` in core is a reusable loop for other callers. |
| IPC handlers | Add a module in `src/main/ipcModules/` that exports `register(ctx)`. Declare the channel in `IPC` and the method in `CubexAPI` in `src/shared/ipc.ts`, and bridge it in `src/preload/index.ts`. `src/main/ipcContract.test.ts` fails when a channel has no handler or no bridge, or is handled twice. |
| A settings section | Add a file in `src/renderer/src/views/settings/sections/` that exports `section` (an id, a title, the page it belongs to, an order and a component). The pages are listed in `views/settings/pages.ts`, and a new feature needs no new page unless it wants one. |
| A right-hand panel tab | Add `<Name>Tab.tsx` in `src/renderer/src/components/panelTabs/` that exports `tab`. |
| Preview sample data | Add a file in `src/renderer/src/lib/seeds/` that exports `seed`. Seeds load only in development and are left out of production builds. |
| Model metadata | `ModelRegistry` merges what an adapter's `getModels()` returns with manual entries. |

## Data and persistence

Everything is stored under one data folder (see [DEVELOPMENT.md](DEVELOPMENT.md#where-data-lives)). SQLite holds providers, conversations, messages, presets, usage and logs. Settings are a JSON file with no secrets, and secrets are in the encrypted credential file. Plans, saved command output and review copies are files in their own folders.

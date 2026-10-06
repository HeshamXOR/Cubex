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
| Main | `src/main` | The Electron main process: IPC handlers, `ProviderManager`, `ChatService` (the agent loop, tools, permissions, plans, summarizing, budget, hooks), `LocalService`, credentials, SQLite, settings, logging, the MCP client, shell and background tasks, type-check diagnostics, change review and notifications. |
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
3. It loops: check the budget, prune or summarize if the context is nearly full, send the request through the gateway, stream events to the window, and run the tool calls the model made. Read-only calls can run in parallel. Anything that needs approval waits for you. The loop ends when the model stops calling tools, when you stop it, or after 50 requests.
4. The main process numbers the events of each stream. The renderer applies them in order and ignores older or replayed events.
5. Usage and cost are recorded in the main process as each response completes. When the turn ends, the window saves the conversation through IPC: every message in full, with display metadata for tool rows beside it.

[HARNESS_WORKFLOW.md](HARNESS_WORKFLOW.md) describes the tools, permissions, plans and review in detail.

## Extension points

Several folders are scanned with `import.meta.glob`, so a feature adds a file and edits no central list.

| To add | Do this |
|---|---|
| A provider | Implement `AIProvider` (extend `BaseProvider`) in `packages/core/src/providers/<kind>/` and register the kind in `factory.ts`. See [PROVIDERS.md](PROVIDERS.md). |
| A local runtime | Implement `LocalRuntime` in `packages/local/src/runtimes` and register it in `LocalService`. |
| A tool | Create an `ExecutableTool` (a definition, a default permission of allow, ask or deny, and `execute`) and register it in `ChatService.start`. Mutating tools should ask. `ToolRunner` in core is a reusable loop for other callers. |
| IPC handlers | Add a module in `src/main/ipcModules/` that exports `register(ctx)`. Declare the channel in `IPC` and the method in `CubexAPI` in `src/shared/ipc.ts`, and bridge it in `src/preload/index.ts`. `src/main/ipcContract.test.ts` fails when a channel has no handler or no bridge, or is handled twice. |
| A settings section | Add a file in `src/renderer/src/views/settings/sections/` that exports `section` (an id, a title, an order and a component). |
| A right-hand panel tab | Add `<Name>Tab.tsx` in `src/renderer/src/components/panelTabs/` that exports `tab`. |
| Preview sample data | Add a file in `src/renderer/src/lib/seeds/` that exports `seed`. Seeds load only in development and are left out of production builds. |
| Model metadata | `ModelRegistry` merges what an adapter's `getModels()` returns with manual entries. |

## Data and persistence

Everything is stored under one data folder (see [DEVELOPMENT.md](DEVELOPMENT.md#where-data-lives)). SQLite holds providers, conversations, messages, presets, usage and logs. Settings are a JSON file with no secrets, and secrets are in the encrypted credential file. Plans, saved command output and review copies are files in their own folders.

# Architecture

Cubex is layered so the provider-agnostic core is completely decoupled from Electron and the UI.
That boundary is what lets the entire cloud pipeline be tested with mock providers — no
credentials, no GPU.

```
Renderer (React)  ──IPC──►  Main (Node/Electron)
                                │
                                ▼
                          AI Gateway  ──►  Routing (+ retry, + fallback)
                                                    │
                                                    ▼
                                      Provider / Runtime Adapter
                                                    │
                                    ┌───────────────┴───────────────┐
                                    ▼                               ▼
                              Cloud API                       Local runtime
                       (OpenAI, Anthropic, …)              (Ollama, …)
```

## Layers

| Layer | Location | Responsibility |
|---|---|---|
| **Core** (pure TS) | `packages/core` | Unified types, `AIGateway`, retry engine, fallback router, streaming normalization, error normalization, secret redaction, model registry, 6 provider adapters, subagent + tool runner |
| **Local** | `packages/local` | Hardware profiling, memory/speed estimation, compatibility scoring, benchmark runner, local runtimes (Ollama, Mock), curated model catalog |
| **Main** (Node) | `src/main` | Electron main process: IPC handlers, `ProviderManager`, `ChatService`, `LocalService`, credentials, SQLite, cost, logging |
| **Preload** | `src/preload` | The typed `window.cubex` bridge (contextIsolation, sandboxed — no Node in the renderer) |
| **Renderer** | `src/renderer` | React UI (Vite): chat, providers, local models, hardware, benchmarks, presets, settings |
| **Shared** | `src/shared` | IPC contract (`ipc.ts`) and app settings types |

`packages/core` has **no Electron or DOM imports**. It compiles and tests standalone.

## The unified provider contract

Every cloud provider and local runtime implements one interface (`packages/core/src/types/provider.ts`):

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

`createProvider(config, secret)` in `providers/factory.ts` is the single place that maps a
`ProviderKind` to a concrete adapter. `llamacpp` and `lmstudio` reuse the `OpenAICompatProvider`.

## Unified request / response model

Requests and responses are provider-agnostic. Message content is an array of **parts**
(text / image / file / audio / video / tool_use / tool_result / reasoning), never a bare string,
so multimodal input and tool calls have a first-class representation. Adapters translate to and
from each provider's native wire format.

## Normalized streaming

Adapters translate native SSE/NDJSON events into one `AIStreamEvent` union:

```
start · text_delta · reasoning_delta · tool_call_delta · tool_call ·
usage · metadata · stop · completed · error
```

`StreamAccumulator` folds these into a final `AIResponse`, so the UI only ever renders normalized
events and the same code path drives every provider.

## Gateway, retry, and fallback

`AIGateway.send()` / `.stream()` wrap each provider call in the **RetryEngine** and, only when the
user explicitly enables it, the **FallbackRouter**. Lifecycle events (`attempt_start`,
`attempt_error`, `retry_wait`, `fallback`, `final`) are emitted for the UI's routing trail.

- **Retry**: errors are normalized to a `NormalizedAIError` with a category and a
  transient/permanent/unknown classification. Only transient (and, per policy, unknown) errors
  retry — never auth, invalid-request, model-not-found, etc. Backoff is exponential with jitter and
  honors `Retry-After`.
- **Streaming retry** happens only *before the first token*; once bytes have streamed we surface the
  error rather than silently restart.
- **Fallback** is off by default. The gateway never switches providers unless the user opts in.

## Errors

`normalizeHttpError` / `normalizeUnknownError` map every provider's failures to a
`NormalizedAIError` (`AUTHENTICATION_ERROR`, `RATE_LIMIT_ERROR`, `CONTEXT_LENGTH`, `TIMEOUT`,
`LOCAL_RUNTIME_ERROR`, …). This is what makes retry and fallback provider-agnostic.

## Extension points

- **New provider** → implement `AIProvider` (extend `BaseProvider`), register in `factory.ts`.
  See [PROVIDERS.md](PROVIDERS.md).
- **New local runtime** → implement `LocalRuntime` (`packages/local/src/runtimes`).
- **New tool** → an `ExecutableTool` with a permission; the `ToolRunner` drives the loop.
- **New model metadata** → the `ModelRegistry` merges dynamic (`getModels()`) and manual entries.

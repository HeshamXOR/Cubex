# Providers

Cubex talks to every provider through one interface. Adding or configuring a provider never
touches the UI or the gateway.

## Built-in provider kinds

| Kind | Adapter | Transport |
|---|---|---|
| `openai` | `OpenAIProvider` | official `openai` SDK — Responses API (default) or Chat Completions |
| `anthropic` | `AnthropicProvider` | official `@anthropic-ai/sdk` — **native** Messages API |
| `openai-compat` | `OpenAICompatProvider` | raw `fetch` + SSE, OpenAI Chat Completions wire format |
| `custom` | `CustomProvider` | raw `fetch`, declarative request/response mapping |
| `ollama` | `OllamaProvider` | raw `fetch`, `/api/chat` NDJSON (local) |
| `llamacpp`, `lmstudio` | `OpenAICompatProvider` | their servers speak the OpenAI-compatible API |
| `mock` | `MockAIProvider` | in-process; no network — used for dev and tests |

Anthropic is **not** routed through an OpenAI shape — it translates the unified request into the
native Messages format (system prompt lifted out, `tool_result` blocks in user messages, adaptive
thinking + `output_config.effort`).

## ProviderConfig

Stored in SQLite; contains **no secrets** — only a `credentialRef` pointing at the OS keychain.

```ts
interface ProviderConfig {
  id: string
  kind: ProviderKind
  name: string
  accessType: 'api' | 'oauth' | 'subscription' | 'local'
  baseUrl?: string
  apiMode?: string          // e.g. 'responses' | 'chat_completions'
  apiVersion?: string
  auth: AuthMethod
  credentialRef?: string    // opaque ref into the encrypted store — never the key
  headers?: Record<string,string>
  capabilities?: Capability[]   // manual override / capability flags
  defaultModel?: string
  mapping?: CustomProviderMapping   // custom kind only
  enabled: boolean
}
```

## Adding an OpenAI-compatible endpoint

In the app: **Providers → OpenAI-Compatible**, set the base URL, API key, and default model. Under
the hood that's a `ProviderConfig` with `kind: 'openai-compat'`. Capability flags (`capabilities`)
let you declare what the endpoint supports; the adapter performs **capability detection with
graceful fallback** — e.g. sending an image to a text-only model raises a clear
`This model does not support image input.` *before* the request goes out.

## The Custom provider (declarative mapping)

For REST/JSON APIs that aren't OpenAI-shaped, `CustomProviderMapping` maps the request and response:

```ts
interface CustomProviderMapping {
  method?: 'POST' | 'GET'
  shape?: 'openai' | 'anthropic' | 'rest'   // 'rest' = fully custom
  promptField?: string        // dot-path where the prompt text goes, e.g. "input.prompt"
  modelField?: string
  streamField?: string
  responseTextPath?: string   // dot-path to extract text, e.g. "result.text"
  sse?: boolean
}
```

`shape: 'openai'` / `'anthropic'` reuse those wire formats; `'rest'` uses the dot-paths to build the
body and extract the reply.

## Authentication

Cubex distinguishes four access types and uses **official methods only**:

| Access | Meaning |
|---|---|
| `api` | Developer API key (`api_key` / `bearer` / `env` / `custom_headers`) |
| `oauth` | Officially supported OAuth flow |
| `subscription` | A consumer plan — **does not** imply API access |
| `local` | A self-hosted runtime; no secret |

Guardrail: **a consumer subscription is not API access.** Cubex never scrapes web UIs, never reuses
session cookies, never reverse-engineers private endpoints, and never bypasses rate limits or auth.
If a subscription doesn't officially expose third-party model access, the app says so and stops.

Secrets are stored via `setSecret(ref, value)` (OS keychain) and referenced by `credentialRef`.
A developer `env` fallback (`CUBEX_OPENAI_API_KEY`, `CUBEX_ANTHROPIC_API_KEY`, …) is supported.

## Reasoning effort is provider-specific

`packages/core/src/providers/effort.ts` returns the effort options for a provider kind:

- **Anthropic** → `low / medium / high / xhigh / max` → adaptive thinking + `output_config.effort`
- **OpenAI** → `minimal / low / medium / high / xhigh / max` → `reasoning_effort`
  (`minimal` only on the GPT-5 family; `xhigh`/`max` only on GPT-6 / GPT-5.6, else clamped to `high`)
- **Ollama / others** → no effort control (hidden in the UI)

## Models are auto-fetched

Both cloud adapters call the provider's live models endpoint (`models.list()`) and fall back to a
built-in static catalogue if it's unavailable. Current lineups are included as the fallback
(Claude Fable 5.1 / Opus 5 / Sonnet 5 / Haiku 4.5; GPT-6 / GPT-5.6 family). Models whose 1M context
is gated behind a provider beta are flagged `longContextBeta`, exposing a **1M context** toggle.

## Writing a new adapter

1. Extend `BaseProvider` in `packages/core/src/providers/<kind>/`.
2. Implement `getModels`, `streamMessage`, `validateConfiguration` (and `sendMessage` if you don't
   want the default stream-draining implementation).
3. Emit normalized `AIStreamEvent`s; wrap errors with `normalizeHttpError` / `normalizeUnknownError`.
4. Register the kind in `providers/factory.ts`.
5. Add translation + streaming unit tests (see `openai/translate.test.ts`, `ollama/OllamaProvider.test.ts`).

# Providers

Cubex talks to every provider through one interface (see [ARCHITECTURE.md](ARCHITECTURE.md)). The rest of the app, including the gateway and the interface, only ever holds an `AIProvider`.

## Adapters

| Kind | Adapter | Transport |
|---|---|---|
| `openai` | `OpenAIProvider` | The official `openai` SDK. Uses the Responses API by default, or Chat Completions when `apiMode` is `chat_completions`. |
| `anthropic` | `AnthropicProvider` | The official `@anthropic-ai/sdk`, speaking the native Messages API. |
| `gemini` | `GeminiProvider` | Raw `fetch` and server-sent events against the native `generateContent` and `streamGenerateContent` endpoints. |
| `openai-compat` | `OpenAICompatProvider` | Raw `fetch` and server-sent events in the OpenAI Chat Completions format, against any base URL. |
| `openai-compat` with `apiMode: 'azure'` | `AzureOpenAIProvider` | The same wire format, routed by Azure deployment. |
| `custom` | `CustomProvider` | Raw `fetch` with a declarative request and response mapping, or a hand-off to the OpenAI-compatible or Anthropic adapter. |
| `ollama` | `OllamaProvider` | Raw `fetch` against `/api/chat`, newline-delimited JSON. Local. |
| `llamacpp`, `lmstudio` | `OpenAICompatProvider` | Their local servers speak the OpenAI-compatible API. |
| `mock`, `mock-local` | `MockAIProvider` | In process, no network. Shown as the Offline demo, and used by tests and the mock local runtime. |

The OpenAI-compatible adapter covers most hosted services. The Providers screen has presets for OpenRouter, Groq, Together, DeepSeek, Mistral, xAI and NVIDIA, and a Custom endpoint for anything else that speaks the Chat Completions format, such as Moonshot or a self-hosted vLLM server. `src/shared/providerPresets.ts` is the list.

Each adapter declares what it supports (tools, images, reasoning and so on), and the interface shows or hides controls to match. Content an adapter cannot take is rejected before any request goes out. The OpenAI-compatible adapter assumes text, tools and streaming, and not images or reasoning, so attaching an image to such a provider fails with "This model does not support image input." A stored configuration can override the declared capabilities with `capabilities`, but the Providers screen has no field for it. A Custom JSON endpoint is text only.

## ProviderConfig

Stored in the database. It holds no secrets, only a `credentialRef` that points into the operating system's credential store.

```ts
interface ProviderConfig {
  id: string
  kind: ProviderKind
  name: string
  accessType: 'api' | 'oauth' | 'subscription' | 'local'
  baseUrl?: string
  apiMode?: string          // 'responses' | 'chat_completions' for OpenAI; 'azure' for Azure OpenAI
  apiVersion?: string       // Gemini: path version (default 'v1beta'); Azure: 'v1' or a dated version
  azureResource?: string    // Azure OpenAI: the {resource} in https://{resource}.openai.azure.com
  azureDeployments?: string[]   // Azure OpenAI: deployment names offered as models
  auth: AuthMethod
  credentialRef?: string    // opaque reference into the encrypted store, never the key
  headers?: Record<string, string>   // static extra headers; the Providers screen does not edit them
  capabilities?: Capability[]   // declared capabilities, overriding the adapter's defaults
  defaultModel?: string
  mapping?: CustomProviderMapping   // custom kind only
  promptCaching?: boolean   // Anthropic: set to false to turn automatic prompt caching off
  enabled: boolean
}
```

## Adding a provider in the app

Open **Providers** and choose **Add provider**. The list of presets opens by itself while no provider exists. Presets are grouped as Cloud, On this PC and Other, and each one fills in the address, the default model and the way the key is sent:

- **Cloud:** OpenAI, Anthropic, Google Gemini, Azure OpenAI, OpenRouter, Groq, Together, DeepSeek, Mistral, xAI and NVIDIA.
- **On this PC:** Ollama, LM Studio and llama.cpp. They need no key.
- **Other:** Custom endpoint (any OpenAI-compatible address, key optional), Custom JSON API and the Offline demo.

The form asks for what the preset cannot fill in: a display name, an address, a default model and the API key, plus a few fields for some kinds. OpenAI has an API mode (Responses API or Chat Completions). Azure OpenAI asks for the resource name, the deployment names and an API version. Providers that use the OpenAI-compatible adapter (OpenRouter, Groq, Together, DeepSeek, Mistral, xAI, NVIDIA and Custom endpoint) and Custom JSON API have a **Where it runs** menu. Custom JSON API also asks for its field mapping. The key field is write-only: a saved key is never shown, leaving the field empty keeps it, and pasting a new one replaces it. **Save provider** stores the provider and, if it is enabled, tests it straight away.

Each provider is a row with an on and off switch, a status (Connected, Could not connect, Needs a key, Off or Not tested), its type, address and model, and whether a key is saved. **Test connection** reports what was checked, how long the provider took to answer and how many models it offers, or on failure what to try next. What is checked depends on the kind:

| Kind | The test |
|---|---|
| OpenAI, Gemini | Lists the models the key can use. |
| Anthropic | Sends a one-token message with the key, which uses a few tokens of quota. |
| OpenAI-compatible, LM Studio, llama.cpp | Asks the endpoint for its model list. |
| Azure OpenAI | Asks the resource for its models with the key. |
| Ollama | Asks the server for its version. |
| Custom JSON API | Reaches the address. The field mapping is not tested. |
| Offline demo | Nothing to check. |

A successful test replaces the known model list, and **Refresh models** fetches it again later. If the default model is not among the models the provider offers, the result says so. Removing a provider asks for confirmation and deletes its saved key, and conversations that used it stay. Turning off or removing the selected provider clears the model selection, and Cubex does not pick another provider for you.

The model menu in the composer lists each provider's models. A provider whose list has not loaded shows **Load models**, and one whose list failed or came back empty shows **Retry**. The default model you set is always offered, even when the server's list leaves it out.

**Local-only mode.** A provider counts as local when its kind is Ollama, LM Studio, llama.cpp or Offline demo, or when an OpenAI-compatible or Custom provider has **Where it runs** set to "On this PC or my network". While Local-only mode is on, requests to any other provider fail with a message that says so, and those providers cannot be selected. It is a routing rule, not a firewall: it does not check where an address actually points, and it does not block tools, downloads or MCP servers. The switch is in the Privacy group in Settings and in the Details panel. See [SECURITY.md](SECURITY.md).

## Native adapters

**OpenAI.** The Responses API is the default. Reasoning summaries stream as reasoning text, and token usage is mapped. Chat Completions mode sends `max_completion_tokens`.

**Anthropic.** The unified request is translated to the native Messages format: the system prompt is lifted out and tool results go in user messages. When you choose an effort level, the request carries adaptive thinking with summaries and `output_config.effort`. With Default it carries neither. If the API rejects a history that cannot carry thinking blocks (for example after a switch from another provider), the request is retried once without thinking. Prompt caching adds one top-level cache breakpoint that advances with the conversation. The adapter sends it only when the provider has no base URL stored, because a proxy may reject the extra field, and only when `promptCaching` is not false. The Anthropic preset stores the default address, so a provider added from it does not send the breakpoint today.

**Long context.** Several models have a 1M-token window, and most providers list them at their ordinary 200K size whether or not the big window needs asking for. The **1M context models** field in the provider form is where you name them: type a model id and add it, or pick one of the models the endpoint itself reports at 1M. A listed model keeps its ordinary window until you open the **+** menu in the composer and turn on **1M context**, or use the **1M context (beta)** switch in the Details panel. Turning it on sends the header the provider needs — for Anthropic, `context-1m-2025-08-07` — and lets the context meter use the full window; without it the meter assumes at most 200K. A model you declared but the endpoint does not list is offered in the picker too, so you can select it before loading a model list.

**Gemini.** The native API at `generativelanguage.googleapis.com`, with an optional `baseUrl` override (a proxy) and an `apiVersion` (default `v1beta`). An API key goes in the `x-goog-api-key` header, never in a URL, an error message or a log line.

- Tools are sent as `functionDeclarations`. Schemas are converted to the OpenAPI subset Gemini accepts: references are inlined, unsupported keywords dropped, and constraints the subset cannot express are moved into the description. Gemma models take no tools on this API, and a request with tools to one fails with a clear message.
- Thought summaries stream as reasoning. Thought signatures are kept with the reasoning parts and replayed on the next request, which Gemini 3 requires for function calls. A signature written by another provider is never sent to Gemini.
- Errors are normalized. A bad key (a 400 on this API) is an authentication error. A rate-limit error carries the retry delay, and a daily quota is not retried. Blocked prompts and responses surface as content-policy errors that name the safety category.

**Azure OpenAI.** The OpenAI-compatible kind in its `azure` mode, with `azureResource` (or a `baseUrl`) and the deployment names in `azureDeployments`. A request's model is the deployment name, and deployments cannot be listed with an API key, so the models are the ones you entered. With `apiVersion` unset or `v1` it calls `https://{resource}.openai.azure.com/openai/v1/chat/completions`. With a dated version such as `2024-10-21` it calls `.../openai/deployments/{deployment}/chat/completions?api-version=...`. A key goes in the `api-key` header. The adapter also accepts a bearer or OAuth credential for a Microsoft Entra ID token, but the Providers screen sets up key authentication only.

**OpenAI-compatible hosts.** Some hosts reject request fields that others need, so the adapter decides a few extras per host and model: stream usage (on for every host except Mistral), `metadata` (OpenAI only), `reasoning_content` echoed back on assistant turns (DeepSeek and Moonshot hosts, and models named like them), and `reasoning_effort`. If a server answers 400 or 422 naming one of these fields as unknown, the request is repeated once without it and the refusal is remembered for that model. Reasoning text in `reasoning_content` or `reasoning` fields streams as reasoning, and an error sent in the middle of a stream is raised as an error instead of being shown as a finished answer.

**Ollama.** Chat goes to `/api/chat` and the model list comes from `/api/tags`. The reasoning text of thinking models is shown, and images are passed through to the model. Ollama has no effort control. See [LOCAL_MODELS.md](LOCAL_MODELS.md) for downloads and management.

## The Custom provider

For REST APIs that are not OpenAI-shaped, `CustomProviderMapping` maps the request and the response:

```ts
interface CustomProviderMapping {
  method?: 'POST' | 'GET'
  shape?: 'openai' | 'anthropic' | 'rest'
  promptField?: string        // dot path in the request body for the prompt, e.g. "input.prompt"
  modelField?: string
  streamField?: string
  responseTextPath?: string   // dot path to the reply text, e.g. "result.text"
  sse?: boolean
}
```

The Providers screen offers three formats. **OpenAI-compatible** and **Anthropic Messages** (`shape: 'openai'` and `'anthropic'`) hand the request to those adapters unchanged. **Custom JSON** (`'rest'`) flattens the conversation into one prompt string, puts it and the model at the dot paths you give, and reads the reply from `responseTextPath`. The form needs a prompt field, a response text path and a default model, and offers a model field. `method`, `streamField` and `sse` exist in the stored mapping and the adapter honors them, but the screen does not offer them, so a Custom JSON provider added in the app makes one request and reads the whole JSON response, with no streaming. Paths cannot use `__proto__`, `constructor` or `prototype`. A Custom JSON provider supports text only, with no tools or images.

## Authentication

| Access type | Meaning |
|---|---|
| `api` | A developer API key. A preset sets how it is sent: a bearer token, an `x-api-key` header, or the raw key in a named header such as Azure's `api-key`. Gemini sends the key in `x-goog-api-key`. |
| `local` | A server on your PC or network, with no key. |
| `oauth`, `subscription` | Present in the data model. No sign-in flow is built, and the Providers screen creates only `api` and `local` providers. |

Cubex uses documented provider access only. It does not scrape web interfaces, reuse session cookies, reverse-engineer private endpoints or get around rate limits. A chat subscription is not API access, and the OpenAI and Anthropic presets say so.

Keys are stored through `setSecret` in the operating system's credential store and referenced by `credentialRef`. As a development fallback, `CUBEX_OPENAI_API_KEY`, `CUBEX_ANTHROPIC_API_KEY`, `CUBEX_GEMINI_API_KEY` and `CUBEX_OPENAI_COMPAT_API_KEY` supply a key for a provider of that kind when none is stored. See [SECURITY.md](SECURITY.md).

## Reasoning effort and output length

Effort and the maximum output length are the only generation controls in the interface, and there is no temperature control. The request type still carries temperature, top-p and similar sampling parameters for programmatic callers.

The effort slider in the composer and the Details panel offers the options that `packages/core/src/providers/effort.ts` returns for the selected provider and model, and hides itself when there are none. The stored value is a unified level, and each adapter maps it to the provider's own parameter. Choosing a model that offers effort sets the slider to Medium, except for Gemini, which starts at Default because its own default depends on the model. **Default** sends no effort parameter at all.

| Provider | Options | Sent as |
|---|---|---|
| Anthropic | Low, Medium, High, Extra High and Max, for models that support reasoning | Adaptive thinking and `output_config.effort` |
| OpenAI | Low, Medium and High, plus Minimal (GPT-5 family only) and Extra High and Max (GPT-6 and GPT-5.6 only) | `reasoning.effort` (Responses) or `reasoning_effort` (Chat Completions) |
| Gemini | Gemini 3 and later: Minimal, Low, Medium and High, limited to what each model accepts. Gemini 2.5: a thinking budget in tokens. Pro offers Minimum, Low, Medium, High and Max, Flash offers Off, Low, Medium and High, and Flash-Lite offers Low, Dynamic and High. | `thinkingLevel` or `thinkingBudget` |
| OpenAI-compatible, LM Studio, llama.cpp | Low, Medium and High, for models that look like reasoning models | `reasoning_effort` |
| Ollama, Custom, Offline demo | None | |

An OpenAI-compatible endpoint reports no reasoning flag of its own. A model counts as reasoning there when the configuration declares it or when its id matches a known family (DeepSeek R1, Qwen3, QwQ, gpt-oss, Nemotron, GLM 4.5 and later, MiniMax, Magistral, o-series models behind a gateway, and ids that contain "thinking" or "reasoning").

The selection is checked again when a message is sent. A level the model does not offer is replaced (Minimal with Low, Extra High and Max with High) or dropped when nothing fits, so a stale selection or an old preset never reaches the provider. Gemini picks the closest level or budget it has. Writing the word `ultrathink` in a message raises that request to the highest level the model accepts, which is Max where it is offered.

The **Details** panel also has a **Max output tokens** box and slider, and **AI defaults** in Settings sets the default. The slider goes up to 32,768 tokens and the box accepts up to 200,000.

## Models

Each adapter reads the provider's live model list and has its own fallback when that fails:

| Adapter | List comes from | When that fails |
|---|---|---|
| OpenAI | `models.list()` | A short built-in list |
| Anthropic | The live models endpoint, merged with built-in metadata | The built-in list |
| Gemini | `GET /models`, read page by page and limited to chat models | A short built-in list |
| OpenAI-compatible, LM Studio, llama.cpp | `GET /models` | Only the default model you set, or none |
| Azure OpenAI | The deployment names you entered | Not applicable |
| Ollama | `/api/tags` | An empty list, or the last known list if the server is unreachable |
| Custom | The matching adapter's list, or for Custom JSON only the default model | Not applicable |

The context window and output limit are known only where the adapter has them: Anthropic from its built-in metadata and Gemini from the models endpoint. Elsewhere the Details panel shows a dash.

## Writing a new adapter

1. Add the kind to `ProviderKind` in `packages/core/src/types/provider.ts`. The typed record in `src/main/providerInput.ts` then fails to compile until the new kind is allowed there as well.
2. Extend `BaseProvider` in `packages/core/src/providers/<kind>/`. Implement `getModels`, `streamMessage` and `validateConfiguration`, and declare capabilities with `setCapabilities`. `sendMessage` has a default that drains the stream.
3. Emit normalized `AIStreamEvent`s and wrap failures with `normalizeHttpError` or `normalizeUnknownError`, so retry and error messages work unchanged.
4. If the provider has reasoning controls, add its options to `effortOptionsFor` in `providers/effort.ts`, and call `requestWithSupportedEffort` before building the request so an unsupported level is dropped.
5. Register the kind in `providers/factory.ts`. If the service speaks the OpenAI Chat Completions format, add a preset to `src/shared/providerPresets.ts` instead of a new adapter.
6. Add tests for translation, streaming and errors, with `fetch` or the SDK mocked. `openai/translate.test.ts` and `ollama/OllamaProvider.test.ts` are good models.

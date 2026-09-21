# Testing

Cubex uses **Vitest**. The whole cloud pipeline is testable with **no credentials and no GPU**
because the core is pure TypeScript and ships a mock provider + mock local runtime.

```bash
npm test                              # run everything (126 tests)
npm run test:watch                    # watch mode
node_modules/.bin/vitest run packages/core/src/gateway   # a subset
npm run test:cov                      # coverage
```

## Coverage

| Area | Tests |
|---|---|
| Retry engine | classification, backoff + jitter, `Retry-After`, per-condition toggles, give-up |
| Error normalization | HTTP status → category, 429 + Retry-After, 401 permanent, abort/network mapping |
| Redaction | header/value/object redaction, circular refs |
| Streaming | SSE parser (split byte boundaries, `[DONE]`), accumulator, tool-call assembly |
| Gateway | normal + streaming, retry-then-succeed, permanent no-retry, fallback on/off, cancel |
| Tool runner | model→tool→model loop, permission gate (allow/deny), unregistered tool |
| Subagent | delegation returns result, error surfacing, cheaper-target routing |
| OpenAI translate | messages/tools/response_format mapping, finish_reason, effort mapping |
| Anthropic translate | native shape, system extraction, tool_result mapping, max_tokens, effort |
| openai-compat | SSE stream → normalized events, 429 normalization, capability gating |
| Ollama | NDJSON stream parse, `/api/tags` model list, runtime detect/pull |
| Custom | dot-path get/set, REST request build + response extraction |
| Effort | provider-specific option sets, OpenAI/Anthropic effort mapping |
| Local estimation | bytes/param, weights/KV/total, VRAM vs CPU speed, confidence rules |
| Compatibility | fits_vram / offload / insufficient / unsupported, goal ranking |
| Benchmark | stats (mean/median/variance/stddev), run loop, early cancel |

## Mocks

- **`MockAIProvider`** (`packages/core/src/providers/mock`) simulates normal / slow / timeout /
  429 (with Retry-After) / 500 / invalid-request / auth-error / tool-call / fail-then-succeed
  scenarios — it drives the gateway, retry, and fallback tests deterministically.
- **`MockLocalRuntime`** (`packages/local/src/runtimes`) simulates detection, model listing,
  synthetic pull progress, start/stop, insufficient-memory, and a token-generating provider for
  benchmark tests. Enable it in the app with `CUBEX_MOCK_LOCAL=1`.

Network adapters mock `globalThis.fetch` / feed fake `ReadableStream`s (SSE and NDJSON); SDK
adapters test the pure translation helpers, so no test makes a real API call.

## Writing tests

Colocate `*.test.ts` next to the code. For a new provider, cover request translation, stream-event
mapping, and one error-normalization case (a transient + a permanent). For gateway behavior, drive
it with `MockAIProvider` scenarios and pass a no-op `sleep` via `retryHooks` to keep tests fast.

## CI

`.github/workflows/ci.yml` runs `npm run typecheck` and `npm test` on every push/PR, then builds
installers on Windows/macOS/Linux for tagged releases.

# Local Models

Cubex runs open-source models locally through modular runtimes and treats a local model exactly
like a cloud provider once it's registered — same gateway, same chat UI, same streaming.

## Runtimes

| Runtime | Status | Notes |
|---|---|---|
| **Ollama** | First-class | Detection, model list, resumable pull, delete, chat streaming (`/api/chat` NDJSON) |
| **llama.cpp** | Via OpenAI-compat | Its server exposes an OpenAI-compatible API; add it as a provider |
| **LM Studio** | Via OpenAI-compat | Same — point a provider at its local server URL |
| **Mock** | For testing | Simulates detection, pulls, and token generation with no runtime installed |

Runtimes implement the `LocalRuntime` interface (`packages/local/src/runtimes`):
`detect()`, `listModels()`, optional `start()/stop()`, `pull(onProgress, signal)`, `deleteModel()`.
Cubex **never assumes a runtime is installed** — each is probed independently and reports
installed / running / version / endpoint.

## Detecting & managing runtimes

The **Local Models** view lists each runtime's status. For Ollama, "reachable" is treated as
"running" (HTTP alone can't distinguish installed-but-stopped).

## Download manager

For Ollama, entering a model tag (e.g. `llama3.1:8b`) starts a `POST /api/pull` stream. Progress is
parsed from the NDJSON status lines and surfaced as completed/total bytes, transfer speed, and ETA,
with a cancel button. Pulls run off the UI thread and resume Ollama's own layer caching, so
re-pulling an existing model is cheap.

## Model browser & catalog

The **Model Browser** shows a curated catalog (`packages/local/src/catalog.ts`) with factual
metadata: organization, family, parameter count, quantization, context window, license,
download/disk size, supported runtimes, and popularity. Filter by task
(coding / vision / reasoning / embeddings). Licenses are shown **as declared by the model authors** —
Cubex never claims a model is free for commercial use; verify the model card first.

## Honest limitations (v1)

- **Ollama is the complete download path.** Direct Hugging Face / GGUF download with checksum
  verification and pause/resume is scaffolded via the runtime interfaces but not fully wired.
- **llama.cpp / LM Studio** are supported through the OpenAI-compatible adapter (chat works today);
  deep runtime *management* (start/stop/auto-detect binaries) is thin.
- Live **GPU-utilization** sampling is best-effort and depends on OS/runtime exposure.

## Testing without a runtime

Set `CUBEX_MOCK_LOCAL=1` to register the **Mock local runtime**, which simulates detection, a model
list, synthetic pull progress, and deterministic token generation — enough to exercise the whole
local flow (including benchmarking) with nothing installed.

<div align="center">

# Cubex

**Intelligence. Open. Limitless.**

A universal desktop AI harness — one unified interface for many cloud providers and local runtimes.

[Features](#features) · [Install](#install) · [Development](#development) · [Architecture](#architecture) · [Docs](#documentation)

</div>

---

Cubex is a provider-agnostic desktop client for AI models. Add OpenAI, Anthropic, any
OpenAI-compatible endpoint, or a local Ollama runtime, then chat, stream, call tools, and
compare — all through one interface. The core principle: **the app never cares whether a
response came from the cloud or your own GPU.**

```
App → AI Gateway → Routing → Provider / Runtime Adapter → Cloud API or Local Model
```

## Features

**Cloud AI**
- Unified adapters for **OpenAI** (Responses + Chat Completions), **Anthropic** (native Messages
  API), any **OpenAI-compatible** server, and a fully declarative **Custom** provider.
- **Auto-fetched model lists** with a static fallback, and current lineups built in
  (Claude Fable 5.1 / Opus 5 / Sonnet 5 / Haiku 4.5; GPT-6 / GPT-5.6 family).
- **Provider-specific reasoning effort** — Anthropic's `low→max` (adaptive thinking +
  `output_config.effort`), OpenAI's `minimal→max` (`reasoning_effort`), hidden where unsupported.
- **1M-context toggle** for models whose long window is gated behind a provider beta.
- **Retry engine** — transient/permanent/unknown classification, exponential backoff + jitter,
  honors `Retry-After`, never retries auth/invalid-request errors.
- **Fallback routing** — explicit opt-in only; the app never silently switches providers.
- Real-time **streaming**, **cancellation**, configurable **timeouts**, and normalized errors.
- **Subagents** — let the model delegate scoped subtasks to isolated sub-conversations.
- Tool calling with a **permission model**; secrets stored in the **OS keychain**, never plaintext.

**Local AI**
- **Hardware Analyzer** — detects CPU/RAM/GPU/VRAM/storage and answers *"what can I run?"*
  with honest, **ranged** estimates labeled Theoretical / Runtime / **Measured**.
- **Ollama** runtime detection, a resumable **download manager**, and a real **benchmark runner**
  (TTFT, tokens/sec, mean/median/variance) that replaces estimates with measurements.
- **Local Only / Privacy Mode** — block all cloud calls and run entirely on your machine.

**Harness UX**
- Frameless window, chat tabs, a right-hand **Parameters + Inspector** panel.
- Live **activity animations** (Thinking / Working / Editing / Streaming) with an elapsed timer.
- **Slash commands** (`/new`, `/clear`, `/compact`, `/system`, `/retry`, `/model`, …).
- Markdown + syntax highlighting, SQLite conversation history with search & export
  (JSON / Markdown / TXT), presets, cost tracking, and a redacted request **Inspector**.

## Install

Download the installer for your platform from [Releases](../../releases), or build from source
(below). Cubex runs on **Windows, macOS, and Linux**.

> Cubex stores API keys in your OS keychain (Windows Credential Manager / macOS Keychain /
> libsecret). It makes no network calls except to the providers you configure; telemetry is off.

## Development

Requires **Node.js 20+**. The project lives on any local disk; an SSD is recommended for
`node_modules` and local model files.

```bash
npm install          # installs deps + rebuilds native modules for Electron
npm run dev          # launch the app in development
npm test             # run the Vitest suite (no credentials or GPU required)
npm run typecheck    # strict type check (node + web)
```

Try it with **zero setup**: add the built-in **Mock** provider (no API key, works offline) and
start chatting — it exercises the full streaming / retry / tool pipeline.

## Build

```bash
npm run build        # compile main + preload + renderer
npm run dist:win     # Windows installer (NSIS)
npm run dist:linux   # Linux AppImage + .deb
npm run dist:mac     # macOS dmg
```

Installers are written to `release/`. Cross-OS installers must be built on (or via CI for) the
target OS.

## Architecture

| Layer | Location | Responsibility |
|---|---|---|
| Core (pure TS) | `packages/core` | Types, gateway, retry, fallback, streaming, errors, redaction, 6 provider adapters |
| Local | `packages/local` | Hardware profiling, memory/speed estimation, compatibility, benchmarks, runtimes |
| Main (Node) | `src/main` | Electron main: IPC, credentials, SQLite, cost, logging |
| Preload | `src/preload` | Typed `window.cubex` bridge (contextIsolation, sandboxed) |
| Renderer | `src/renderer` | React UI (Vite) |

The core package has **no Electron or DOM imports**, so the entire cloud pipeline is testable with
mock providers — no credentials, no GPU.

## Documentation

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — layers, data flow, extension points
- [PROVIDERS.md](docs/PROVIDERS.md) — adding a provider / OpenAI-compatible endpoint
- [LOCAL_MODELS.md](docs/LOCAL_MODELS.md) — runtimes, downloads, model catalog
- [HARDWARE_ANALYZER.md](docs/HARDWARE_ANALYZER.md) — detection & estimation methodology
- [BENCHMARKS.md](docs/BENCHMARKS.md) — benchmark method and how to read results
- [SECURITY.md](docs/SECURITY.md) — credential storage, sandboxing, tool permissions
- [DEVELOPMENT.md](docs/DEVELOPMENT.md) — setup, scripts, project layout
- [TESTING.md](docs/TESTING.md) — test suite and mocks

## A note on performance numbers

Every local performance figure is an **estimate shown as a range** and labeled with its basis
(Theoretical / Runtime / Measured). Cubex never presents an estimate as a guaranteed result — run a
benchmark to get measured values for your hardware.

## License

[MIT](LICENSE) © Cubex contributors. Open-source model licenses are shown in the app as declared by
their authors — always verify a model's license before commercial use.

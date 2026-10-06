# Local models

Cubex can chat with models that run on your own computer. A local model is an ordinary provider once you add it: it uses the same gateway, the same chat screen and the same streaming path as a cloud model. What local runtimes add is a place to see what is installed and to download and delete models.

## Runtimes

| Runtime | What Cubex does with it |
|---|---|
| Ollama | Full support. Cubex detects it, lists installed models, downloads and deletes models, and chats through its `/api/chat` endpoint. |
| LM Studio | Chat only, through its OpenAI-compatible server. Add it from **Providers** (the preset points at `http://127.0.0.1:1234/v1`). |
| llama.cpp | Chat only, through `llama-server`'s OpenAI-compatible endpoint (the preset points at `http://127.0.0.1:8080/v1`). |
| Offline demo | A simulated provider for trying the app without a model. See [Testing without a runtime](#testing-without-a-runtime). |

Cubex never assumes a runtime is installed. Each one is probed on its own, and the Local models screen reports whether it is reachable, its version and its endpoint.

Runtimes implement the `LocalRuntime` interface in `packages/local/src/runtimes`: `detect()`, `listModels()`, and the optional `pull(modelId, onProgress, signal)`, `deleteModel()`, `estimatePull()`, `modelsDir()`, `start()` and `stop()`. Only Ollama (and the mock runtime) are registered today. Cubex connects to an Ollama server that is already running. It does not start or stop Ollama, and for Ollama "reachable" is treated as "running", because an HTTP check cannot tell a stopped server from an uninstalled one. If Ollama is not running, start it and choose **Refresh**.

The Ollama address is the **Ollama base URL** field in the Local AI group in Settings (default `http://127.0.0.1:11434`).

## The Local models screen

- **Runtimes** shows one card per runtime with its status.
- **Download a model** takes a model name and starts a download. Names follow Ollama's notation, for example `llama3.1:8b`, `someone/model:tag` or `hf.co/owner/repo:Q4_K_M`. Cubex passes the name to Ollama and does not check that it exists in a registry before asking.
- **Downloads** lists what is running or waiting, with bytes, speed, estimated time left, and a Cancel button.
- **Installed** lists the models the runtime reports, with size, quantization and parameter count where known, and a Delete action that asks for confirmation.

Models are stored by Ollama, in its own folder, which Cubex takes to be the one named by the `OLLAMA_MODELS` environment variable when that is set, and `.ollama/models` in your home folder otherwise. The **Models directory** field in the Local AI group in Settings does not move them. It only chooses which drive the Hardware screen reports free space for. The download disk check looks at Ollama's own folder.

## Downloads

Each runtime has one line of downloads. A runtime fetches one model at a time and the rest wait their turn in order, labelled "Queued, 2nd" and so on. Asking for a model that is already downloading or waiting returns the existing download instead of adding another.

Progress comes from Ollama's `/api/pull` stream. Cubex sums the layers it has seen so far and derives speed and time left from a sliding window. Cancelling stops the request. Ollama keeps the layers it already has, so a download that is cancelled, fails or loses its connection picks up where it stopped when you start it again.

Before the first byte, Cubex runs these checks:

1. The runtime must answer. If it does not, the download fails at once with the reason.
2. The size is looked up from the Ollama registry (`registry.ollama.ai`) when the name is one it knows, and from the built-in catalog otherwise. Layers already on disk are not counted again.
3. The free space on the drive that holds Ollama's models folder must cover the remaining bytes plus a 512 MiB reserve. The check repeats while the download runs, because a name the registry did not know cannot be sized up front.

Steps 2 and 3 run only when the Ollama address points at this PC (`localhost`, `::1` or `127.x.x.x`), because Cubex cannot see the drives of another machine. For an Ollama server elsewhere on the network, Cubex skips the size lookup and the disk check.

A download that receives no bytes for 30 seconds is shown as stalled, with a hint to check the connection or cancel and retry. Failures carry a reason (runtime unreachable, disk space, unsupported runtime, or other) and a Try again action.

The registry lookup is the only request Cubex makes to the Ollama registry. The download itself is made by Ollama.

## Model catalog

`packages/local/src/catalog.ts` holds a short list of popular open models with factual metadata: organization, family, parameter count, quantization, context window, license, approximate download size and the runtimes that can run each one. It is reference data, not a model browser. The Hardware screen ranks it for the **What can I run?** check, and the download guard uses its sizes when a runtime cannot report one. See [HARDWARE_ANALYZER.md](HARDWARE_ANALYZER.md).

Licenses are shown as the model authors declare them. Cubex never claims a model is free for commercial use, so check the model card first.

## Limitations

- Ollama is the only download path. `packages/local/src/download` also contains a resumable Hugging Face GGUF downloader that verifies SHA-256 checksums and checks disk space. It has tests but is not connected to the app, because no runtime Cubex manages loads GGUF files directly. To get a Hugging Face model today, use an `hf.co/...` name with Ollama.
- LM Studio and llama.cpp are supported for chat only. Cubex does not detect, start or manage them, and they do not appear on the Local models screen.
- The catalog and the estimates are not a model browser or a quality ranking.
- Live GPU utilization is not sampled.

## Local-only mode

The **Local-only mode** switch in the Privacy group in Settings makes Cubex refuse model requests to cloud providers. Ollama, LM Studio, llama.cpp and the offline demo stay available. A custom or OpenAI-compatible endpoint counts as local only when you declare it so. See [SECURITY.md](SECURITY.md) for exactly what the setting does and does not cover.

## Testing without a runtime

Set `CUBEX_MOCK_LOCAL=1` before starting the app to register the mock local runtime, which appears on the Local models screen as a runtime named **Mock Local Runtime**. It reports itself as installed and running, lists two sample models and simulates a download with synthetic progress, with nothing installed. The class also has options that simulate a failed start and an out-of-memory download, but nothing in the app switches them on.

# Benchmarks

A benchmark measures how fast a local model generates on your machine. Its numbers are measurements, not estimates, and each result is stored with the exact settings that produced it, so runs at different settings are never compared as if they were equal.

## Status

The benchmark engine is implemented and tested, but the desktop app has no Benchmarks screen at the moment, so nothing in the interface starts a run. The runner in `packages/local/src/benchmark`, its storage in the `benchmarks` table of the app database, and the IPC channels remain in place: `bench:run`, `bench:cancel`, `bench:list` and `bench:progress`, exposed on `window.cubex` as `runBenchmark`, `cancelBenchmark`, `listBenchmarks` and `onBenchmarkProgress`. Results are not yet shown anywhere, and they do not feed back into the estimates on the Hardware screen. See [HARDWARE_ANALYZER.md](HARDWARE_ANALYZER.md).

## Method

`BenchmarkRunner` (`packages/local/src/benchmark/runner.ts`) takes a configuration and any `AIProvider`:

1. It sends the same prompt `runs` times, one run after another. The setting `local.benchmarkRuns` defaults to 3.
2. For each run it streams the reply and measures:
   - **Time to first token (TTFT):** from sending the request to the first `text_delta`.
   - **Generation time:** from the first token to the end of the stream.
   - **Generated tokens:** the provider's reported output tokens when it reports them, otherwise an approximation of 1.3 tokens per whitespace-separated word.
   - **Tokens per second:** generated tokens divided by generation seconds.
3. Across runs, `computeStats` reports the mean, median, minimum, maximum, variance and standard deviation (population statistics) for tokens per second and for TTFT.
4. The result stores the full `BenchmarkConfig`: model, runtime, prompt, maximum output tokens, number of runs, and optionally a context size and temperature.

Stopping a benchmark keeps the runs that had already finished and aggregates them.

## Reading results

- **Generation speed** is the sustained decode rate in tokens per second, with its median and spread.
- **TTFT** is prompt processing plus the first token. It grows with prompt length and with a cold model load.
- **Standard deviation and variance** show run-to-run consistency. High variance suggests thermal throttling, background load or cold caches.

## Comparing results

- Compare only runs with the same runtime, model, quantization and settings. The stored configuration is there so you can check.
- A benchmark describes your machine at that moment. It is not a portable guarantee.
- The result type has fields for peak VRAM and peak RAM, but the runner does not fill them in yet.

## Tests

`benchmark/stats.test.ts` and `benchmark/runner.test.ts` check the statistics and the run loop against the mock provider, so the whole pipeline is covered without a GPU or a runtime.

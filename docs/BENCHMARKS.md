# Benchmarks

Benchmarks replace *estimates* with *measurements*. When you run one, the resulting tokens/sec and
TTFT are labeled **Measured** and stored with the exact configuration that produced them.

## Method

`packages/local/src/benchmark/runner.ts`:

1. A controlled prompt is sent to the selected local model `N` times (default 3).
2. Each run measures:
   - **TTFT** — time to the first `text_delta`.
   - **Generation time** — first token → completion.
   - **Generated tokens** — from the model's `usage` when reported, else a whitespace-token
     approximation of the output.
   - **tokens/sec** = generated tokens ÷ generation seconds.
3. Across runs, `computeStats` reports **mean, median, min, max, variance, and standard deviation**
   for tokens/sec and TTFT.
4. The result stores its full `BenchmarkConfig` (model, runtime, prompt, max tokens, run count,
   temperature). **Runs at different settings are never compared as equivalent** — the config
   travels with the numbers.

Results are persisted (SQLite, `benchmarks` table) and shown in the Benchmarks view with the config
inline.

## Running a benchmark

1. Install a model (**Local Models** → pull, e.g. `llama3.1:8b`), or set `CUBEX_MOCK_LOCAL=1`.
2. Open **Benchmarks**, pick the model, set the run count, click **Run**.
3. Progress streams as each run completes; **Stop** cancels and aggregates what finished.

## Reading results

- **Generation** — sustained decode speed (tok/s), with median and spread.
- **Time to first token** — prompt-processing + first-token latency.
- **σ (stddev) / variance** — run-to-run consistency; high variance means thermal throttling,
  background load, or cold caches.

## Honest comparisons

- Only compare benchmarks with the **same runtime, model, quantization, and settings**.
- Peak VRAM / GPU-utilization capture is best-effort and may be absent depending on the platform.
- A benchmark measures *your* machine at that moment; results are not portable guarantees.

## Deterministic tests

`benchmark/stats.test.ts` and `benchmark/runner.test.ts` verify the statistics and the run loop
against the Mock local runtime (a `MockAIProvider` with a configurable tokens/sec), so the
benchmark pipeline is covered without a GPU.

# Hardware analyzer

The Hardware screen answers one question: which local models can this PC run, and roughly how fast? Cubex scans the machine, estimates memory and speed for each model in a short built-in list, and sorts the list by how well each one fits. Every figure is a range with a stated basis, and none of them is a promise. The code lives in `packages/local` and does not import Electron.

Sizes in this document are binary gigabytes, so 1 GB is 1,073,741,824 bytes, the same unit the screen uses.

## What the screen shows

- **Your system** has cards for CPU, memory, GPU, storage, system and acceleration, and a **Re-scan** button. The scan runs when the screen opens and the result is kept until you re-scan.
- **What can I run?** has a goal menu and a **Check my PC** button. Each result is a card with the model name, its parameter count and quantization, a fit status, a one-sentence reason with real numbers, the estimated memory as a range, the estimated speed as a range with its confidence, and the share of the model that fits on the GPU.
- The GPU card shows the first GPU the scan found, while the estimates use the GPU with the most memory. On a machine with two GPUs these can differ.
- The check uses the **Context size** setting in the Local AI group in Settings (4096 tokens by default). It considers only runtimes that are running at that moment.

## What the scan reads

`scanSystem` in `packages/local/src/hardware/profiler.ts` uses the `systeminformation` package, with Node's `os` module as a fallback. Each probe is wrapped on its own, so a failure in one leaves a partial profile and never throws.

| Part | What is read |
|---|---|
| CPU | Model, vendor, architecture, physical cores, threads, base clock, and SIMD flags (AVX-512, AVX2, AVX, SSE4.2, SSE4.1, FMA, NEON) |
| Memory | Total and available RAM. Memory bandwidth is not detected. |
| GPU | Model, vendor (NVIDIA, AMD, Intel, Apple or unknown), dedicated memory, driver version |
| Storage | Size and free space of the drive that holds the **Models directory** from Settings, or the largest drive when that field is blank. SSD or HDD when the system says which. |
| System | Platform, distribution, release, architecture |

Acceleration backends are inferred from the GPU vendor and the operating system. They are not probed, so they show what the hardware can usually do, not what is installed.

| Vendor | Backends listed |
|---|---|
| NVIDIA | CUDA and Vulkan, plus DirectML on Windows |
| AMD | ROCm and Vulkan, plus DirectML on Windows |
| Intel | Vulkan and OpenCL, plus DirectML on Windows |
| Apple | Metal |
| Other | Vulkan |

The CPU is always listed as well.

## Memory estimate

`packages/local/src/estimation/memory.ts` is pure and deterministic. The total is the sum of three ranges.

**Weights** are the parameter count times the effective bits per weight of the quantization, divided by eight. The bits come from published file sizes rather than the nominal bit width, because common formats keep some tensors at higher precision and add per-block scales.

| Quantization | Bits per weight |
|---|---|
| FP16, BF16 | 16 |
| Q8_0 | 8.5 |
| Q6_K | 6.56 |
| Q5_K_M | 5.69 |
| Q4_K_M | 4.89 |
| Q3_K_M | 4.0 |
| Q2_K | 3.17 |
| Unknown | 5.6 |

`estimation/quant.ts` has the full table, including the IQ series, MXFP4, INT4, AWQ and GPTQ. The range around the weights is 3 percent for a known quantization and 15 percent when the quantization is a guess. If the size of the file on disk is known, the estimator uses it with a 1 percent band instead. The compatibility check does not pass a file size today, so it always works from parameters and bits.

**KV cache** holds one key vector and one value vector per layer for each token of context:

```text
bytes = 2 * layers * kv_heads * head_dim * bytes_per_element * tokens
```

An f16 cache uses 2 bytes per element, q8_0 about 1.06 and q4_0 about 0.56. Layers that attend only to a sliding window keep that window plus 512 tokens. When a model's attention shape is not known, the nearest entry in a table of typical shapes (0.5B to 405B parameters, matched on a log scale) supplies it, and the result is a range from 0.85 to 1.25 times that guess. The compatibility check passes no attention shape, so it always uses the guess.

**Overhead** covers the GPU runtime context and compute buffers. It runs from 0.4 GB plus 2 percent of the weights up to 0.7 GB plus 6 percent of the weights.

The estimate also returns notes that say which assumptions it made.

## Speed estimate

`estimation/speed.ts` treats decoding as limited by memory bandwidth: each generated token reads roughly all the weights once, so tokens per second is about the bandwidth divided by the size of the weights in GB. It uses the upper end of the weights estimate and never divides by less than 0.25 GB.

| Case | Bandwidth used | Range around the result | Confidence |
|---|---|---|---|
| Weights fit in VRAM (99 percent or more) | The GPU tier below | 0.65 to 1.35 times | High, or medium when the parameter count is unknown |
| Partly in VRAM | GPU and RAM bandwidth, weighted by the share on the GPU | 0.4 to 0.9 times | Low |
| No GPU memory reported | RAM bandwidth, 50 GB/s unless a value is supplied | 0.35 to 0.85 times | Low |

GPU bandwidth is a rough tier, not a spec sheet value:

| GPU | Bandwidth |
|---|---|
| NVIDIA or AMD with 24 GB or more | 900 GB/s |
| NVIDIA or AMD with 16 GB or more | 700 GB/s |
| NVIDIA or AMD with 12 GB or more | 500 GB/s |
| NVIDIA or AMD with 8 GB or more | 400 GB/s |
| NVIDIA or AMD with 6 GB or more | 300 GB/s |
| Other NVIDIA or AMD | 220 GB/s |
| Apple, by chip name | Ultra 800, Max 400, Pro 200, any other 100 GB/s |
| Intel or unknown vendor | 250 GB/s with 8 GB or more, otherwise 120 GB/s |

The estimator also computes a time-to-first-token range, 50 to 400 ms with the weights on the GPU and 200 to 2,000 ms otherwise, but the screen does not show it. Speed does not depend on context length, batch size, CPU core count or instruction sets.

## Fit status

`packages/local/src/compatibility/analyze.ts` returns a factual category, not a quality score. The rules run in this order.

| Order | Status | Label on screen | Rule |
|---|---|---|---|
| 1 | `unsupported_runtime` | No compatible runtime | At least one runtime is running and none supports the model. Skipped while no runtime is running. |
| 2 | `fits_vram` | Fits in VRAM | The high end of the memory estimate is no more than the VRAM. |
| 3 | `may_be_slow` | May be slow | The estimate fits in system RAM and no GPU memory was reported, so the model runs on the CPU. |
| 3 | `offload_required` | Needs CPU and RAM offload | The estimate exceeds the VRAM but fits in VRAM plus RAM. |
| 4 | `insufficient_memory` | Not enough memory | Even the low end of the estimate exceeds VRAM plus RAM. |
| 5 | `may_be_slow` | May be slow | The low end fits in VRAM plus RAM but the high end does not. The model is borderline and may swap. |

RAM here is the total installed, not what is free right now. Each result carries a reason sentence with the actual numbers, for example:

```text
Model likely requires ~18.0 GB, while your GPU has 12.0 GB VRAM (RAM: 32.0 GB). About 66% fits on GPU; the rest offloads to CPU/RAM, so expect ~8–15 tok/s.
```

**Share on GPU** is the VRAM divided by the size of the weights, capped at 100 percent. The status compares VRAM with the full estimate (weights, cache and overhead), so a model whose weights just fit can show 100 percent on the GPU and still be marked as needing offload. The speed range is hidden for models that do not fit or have no runtime.

## Goals and ranking

`recommendModels` sorts the results by status (fits, offload, slow, not enough memory, no runtime) and then breaks ties by the goal. It reorders by fit and by what each model declares. It does not score quality.

| Goal | Effect |
|---|---|
| General chat | Faster models first |
| Coding | Models with "code" or "coder" in the name first, then faster |
| Reasoning | Keeps models that report reasoning, have 7B parameters or more, or have no stated size; faster first |
| Fast responses | Highest estimated speed first |
| Long context | Largest context window first |
| Vision | Keeps only models that accept images, faster first |
| Low memory | Smallest estimated memory first |
| Maximum quality | Most parameters first |

The list being ranked is the curated catalog in `packages/local/src/catalog.ts`: popular open models with their parameter counts, quantizations, context windows, licenses and supported runtimes. It is reference data, not a model hub, and the sizes are approximate.

## Estimate labels

Every memory and speed estimate carries a basis, and the screen prints it next to the number:

| Basis | Screen text | Meaning |
|---|---|---|
| `theoretical` | calculated from specs | Computed from the formulas above |
| `runtime` | reported by the runtime | A figure the runtime itself gave |
| `measured` | measured on this PC | A benchmark result |

Today the estimators produce only the first. Nothing reported by a runtime or measured by a benchmark reaches the screen yet. The benchmark engine described in [BENCHMARKS.md](BENCHMARKS.md) measures real speed, but it does not feed these estimates.

## Limits

- The catalog is short, and the check covers only those models, not the ones you have installed.
- The compatibility check passes parameters and quantization only. The estimator can use a file size and an exact attention shape, but they are not supplied yet.
- The result type has room for a recommended context length and a tight-fit flag, and the screen displays them when present, but the estimator does not produce them yet.
- A GPU that reports no memory counts as no GPU, so the model is treated as CPU only.
- VRAM and RAM are added together when deciding whether a model fits with offload, and other programs using that memory are not taken into account.
- Speed depends on the runtime, drivers, context length and thermal limits. Treat the range as a guide for choosing which models to try.

## Tests

`estimation/quant.test.ts`, `estimation/memory.test.ts`, `estimation/speed.test.ts` and `compatibility/analyze.test.ts` cover the quantization table, the memory and speed arithmetic and the status rules against fixed hardware profiles, so no GPU is needed. The profiler reads the real machine and has no unit test of its own. See [TESTING.md](TESTING.md).

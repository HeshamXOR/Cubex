# Hardware Analyzer

The Hardware Analyzer answers a practical question — *"what models can my PC actually run, and
roughly how fast?"* — using detected hardware, model metadata, and **transparent, ranged
estimates**. Every performance figure is labeled with its basis and is never presented as a
guarantee.

## What's detected

Via `systeminformation` with Node `os` fallbacks (`packages/local/src/hardware/profiler.ts`). Each
probe is wrapped in try/catch so a partial failure still yields a usable profile — it never throws.

| Component | Fields |
|---|---|
| **CPU** | model, vendor, architecture, physical cores, logical threads, base clock, SIMD (avx/avx2/avx512/neon) |
| **Memory** | total, available |
| **GPU** | model, vendor (nvidia/amd/intel/apple), VRAM, driver, acceleration backends (cuda/rocm/metal/vulkan/directml/opencl) |
| **Storage** | total/free for the models drive, SSD/HDD best-effort |
| **OS** | platform, distro, release, arch |
| **Accelerators** | union of all detected GPU backends + `cpu` |

## Memory estimation

`packages/local/src/estimation/memory.ts` — pure, deterministic:

- **Weights** = `params(B) × 1e9 × bytesPerParam(quant)`, ±8%. `bytesPerParam` is an *effective
  average* per format (FP16=2, Q8=1, Q6≈0.82, Q5≈0.7, Q4/INT4/AWQ/GPTQ≈0.55, Q3≈0.43, Q2≈0.33;
  unknown≈0.7). GGUF k-quants carry metadata + partial higher-precision tensors, hence "effective".
- **KV cache** ≈ `contextTokens × 2 (K&V) × layers × hidden × 2 bytes` (fp16 cache). Layers/hidden
  are inferred from parameter count when the model card is silent. The low end reflects GQA models
  (~1/5 of full), the high end the full estimate.
- **Overhead** ≈ 10–20% of weights + a fixed ~0.5 GB runtime overhead.
- **Total** is the summed range, `basis: 'theoretical'`, with `notes[]` listing the assumptions.

## Speed estimation

`estimation/speed.ts` — local decode is overwhelmingly **memory-bandwidth bound**: each generated
token reads (roughly) the active weights once, so `tok/s ≈ bandwidth / weightsGB`.

- **Fully in VRAM** → bound by GPU bandwidth (tiered by vendor/VRAM class; Apple by chip tier).
  Range ≈ ±35%, confidence up to `high`.
- **Partial (GPU+CPU offload)** → effective bandwidth weighted by the fraction on GPU; the slow
  CPU/RAM portion dominates. Wide range, `low` confidence.
- **CPU-only** → bound by RAM bandwidth (assumed ~50 GB/s if unknown). Wide range, `low` confidence.
- Also estimates a **time-to-first-token** range. `basis: 'theoretical'`, and a theoretical estimate
  is **always a range** (never `low === high`).

## Compatibility categories

`compatibility/analyze.ts` returns a **factual** category — not a subjective quality score:

| Status | Meaning |
|---|---|
| ✅ `fits_vram` | Fits fully in VRAM |
| ⚠ `offload_required` | Larger than VRAM but fits with CPU/RAM offload |
| ⚠ `may_be_slow` | Fits (often CPU-only) but likely slow |
| ❌ `insufficient_memory` | Exceeds VRAM + RAM |
| ❌ `unsupported_runtime` | No installed runtime supports it |

Each result carries a specific reason with real GB numbers, e.g. *"Model likely requires ~18.0 GB,
while your GPU has 12.0 GB VRAM (RAM: 32.0 GB). About 66% fits on GPU; the rest offloads to CPU/RAM,
so expect ~8–15 tok/s."*

## "Analyze My PC"

Pick a goal (General / Coding / Reasoning / Fast / Long Context / Vision / Low Memory / Max Quality)
and Cubex ranks the catalog by hardware fit + capabilities for that goal (`recommendModels`).
Ranking is fit- and capability-based, not an invented quality metric.

## Estimate labels

Every number is tagged:

- **Theoretical** — from the formulas above (before you run anything).
- **Runtime** — refined once a runtime reports (where available).
- **Measured** — replaced by a real [benchmark](BENCHMARKS.md).

The UI shows a range plus a confidence level; run a benchmark to get measured values for *your*
hardware and settings.

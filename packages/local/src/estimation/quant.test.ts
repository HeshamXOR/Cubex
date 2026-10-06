import { describe, expect, it } from 'vitest'
import { bitsPerWeight, isKnownQuant, normalizeQuant, QUANT_BITS_PER_WEIGHT } from './quant'
import { kvBytesPerToken, kvCacheBytes, fallbackAttention, KV_CACHE_TYPES } from './attention'

const GIB = 1024 ** 3

describe('normalizeQuant', () => {
  it.each([
    ['q4_k_m', 'Q4_K_M'],
    ['Q4_K_M', 'Q4_K_M'],
    ['UD-Q4_K_XL', 'Q4_K_XL'],
    ['f16', 'FP16'],
    ['F16', 'FP16'],
    ['bf16', 'BF16'],
    ['f32', 'FP32'],
    ['Q4_K', 'Q4_K_M'],
    ['Q5_K', 'Q5_K_M'],
    ['Q8', 'Q8_0'],
    ['mxfp4', 'MXFP4'],
    ['iq4_xs', 'IQ4_XS'],
    ['int4', 'INT4']
  ])('maps %s to %s', (input, expected) => {
    expect(normalizeQuant(input)).toBe(expected)
  })

  it('returns undefined for missing or placeholder values', () => {
    expect(normalizeQuant(undefined)).toBeUndefined()
    expect(normalizeQuant('')).toBeUndefined()
    expect(normalizeQuant('unknown')).toBeUndefined()
  })
})

describe('bitsPerWeight', () => {
  it('knows the effective bits per weight of common GGUF quantizations', () => {
    // Derived from published GGUF sizes: Llama 3.1 8B Q4_K_M is 4.92 GB for 8.03B weights = 4.9 bits.
    expect(bitsPerWeight('Q4_K_M')).toBeCloseTo(4.89, 2)
    expect(bitsPerWeight('Q8_0')).toBe(8.5)
    expect(bitsPerWeight('Q6_K')).toBeCloseTo(6.56, 2)
    expect(bitsPerWeight('Q5_K_M')).toBeCloseTo(5.69, 2)
    expect(bitsPerWeight('Q2_K')).toBeCloseTo(3.17, 2)
    expect(bitsPerWeight('FP16')).toBe(16)
    expect(bitsPerWeight('BF16')).toBe(16)
    expect(bitsPerWeight('FP32')).toBe(32)
    expect(bitsPerWeight('MXFP4')).toBeCloseTo(4.25, 2)
  })

  it('accepts any casing and Ollama-style names', () => {
    expect(bitsPerWeight('q4_k_m')).toBe(bitsPerWeight('Q4_K_M'))
    expect(bitsPerWeight('F16')).toBe(16)
  })

  it('orders quantizations by size', () => {
    const order = ['Q2_K', 'Q3_K_M', 'Q4_K_M', 'Q5_K_M', 'Q6_K', 'Q8_0', 'FP16', 'FP32']
    const bits = order.map(bitsPerWeight)
    expect([...bits].sort((a, b) => a - b)).toEqual(bits)
  })

  it('falls back to a cautious 5.6 bits for an unknown quantization', () => {
    expect(bitsPerWeight(undefined)).toBe(5.6)
    expect(bitsPerWeight('some-future-quant')).toBe(5.6)
    expect(isKnownQuant('some-future-quant')).toBe(false)
    expect(isKnownQuant('q4_k_m')).toBe(true)
  })

  it('has a positive value for every table entry', () => {
    for (const [name, bits] of Object.entries(QUANT_BITS_PER_WEIGHT)) {
      expect(bits, name).toBeGreaterThan(1)
      expect(bits, name).toBeLessThanOrEqual(32)
    }
  })
})

describe('kvBytesPerToken', () => {
  // bytes per token = 2 (K and V) x layers x kvHeads x headDim x bytes per element.
  it.each([
    ['Llama 3.1 8B (GQA 8 of 32 heads)', { layers: 32, kvHeads: 8, headDim: 128 }, 131_072],
    ['Llama 3.1 70B', { layers: 80, kvHeads: 8, headDim: 128 }, 327_680],
    ['Qwen2.5 7B (GQA 4)', { layers: 28, kvHeads: 4, headDim: 128 }, 57_344],
    ['Llama 2 7B (full multi-head)', { layers: 32, kvHeads: 32, headDim: 128 }, 524_288]
  ])('%s', (_name, attn, expected) => {
    expect(kvBytesPerToken(attn, 'f16')).toBe(expected)
  })

  it('uses less cache for 8-bit and 4-bit cache types', () => {
    const attn = { layers: 32, kvHeads: 8, headDim: 128 }
    expect(kvBytesPerToken(attn, 'q8_0')).toBeCloseTo(131_072 * (8.5 / 16), 0)
    expect(kvBytesPerToken(attn, 'q4_0')).toBeCloseTo(131_072 * (4.5 / 16), 0)
    expect(KV_CACHE_TYPES).toEqual(['f16', 'q8_0', 'q4_0'])
  })
})

describe('kvCacheBytes', () => {
  it('is context length times bytes per token: Llama 3.1 8B at 8192 tokens is exactly 1 GiB', () => {
    expect(kvCacheBytes({ layers: 32, kvHeads: 8, headDim: 128 }, 8192)).toBe(GIB)
  })

  it('Llama 2 7B at 4096 tokens is 2 GiB (no grouped-query savings)', () => {
    expect(kvCacheBytes({ layers: 32, kvHeads: 32, headDim: 128 }, 4096)).toBe(2 * GIB)
  })

  it('grouped-query attention needs a quarter of the cache of full multi-head attention', () => {
    const gqa = kvCacheBytes({ layers: 32, kvHeads: 8, headDim: 128 }, 4096)
    const mha = kvCacheBytes({ layers: 32, kvHeads: 32, headDim: 128 }, 4096)
    expect(mha / gqa).toBe(4)
  })

  it('keeps only the window for sliding-window layers (Gemma-style 5 local : 1 global)', () => {
    const full = { layers: 48, kvHeads: 8, headDim: 256 }
    const swa = { ...full, slidingLayers: 40, slidingWindow: 1024 }
    const ctx = 32768
    const fullBytes = kvCacheBytes(full, ctx)
    const swaBytes = kvCacheBytes(swa, ctx)
    expect(swaBytes).toBeLessThan(fullBytes * 0.25)
    // 8 global layers at full context + 40 local layers at a window plus one batch of slack.
    const perLayerToken = 2 * 8 * 256 * 2
    expect(swaBytes).toBe(perLayerToken * (8 * ctx + 40 * (1024 + 512)))
  })

  it('never lets the sliding window exceed the context', () => {
    const swa = { layers: 10, kvHeads: 2, headDim: 64, slidingLayers: 10, slidingWindow: 4096 }
    expect(kvCacheBytes(swa, 1000)).toBe(kvCacheBytes({ layers: 10, kvHeads: 2, headDim: 64 }, 1000))
  })

  it('is zero for a zero context', () => {
    expect(kvCacheBytes({ layers: 32, kvHeads: 8, headDim: 128 }, 0)).toBe(0)
  })
})

describe('fallbackAttention', () => {
  it('assumes grouped-query attention with 8 KV heads for mid-size models', () => {
    const a = fallbackAttention(8)
    expect(a).toMatchObject({ layers: 32, kvHeads: 8, headDim: 128 })
  })

  it('gives bigger models more layers', () => {
    expect(fallbackAttention(70).layers).toBeGreaterThan(fallbackAttention(8).layers)
    expect(fallbackAttention(8).layers).toBeGreaterThan(fallbackAttention(1).layers)
  })

  it('returns something sensible for absurd inputs', () => {
    expect(fallbackAttention(0).layers).toBeGreaterThan(0)
    expect(fallbackAttention(10_000).layers).toBeGreaterThan(0)
  })

  it('matches the real Llama 3.1 8B and 70B shapes within a small tolerance of cache size', () => {
    const real8 = kvCacheBytes({ layers: 32, kvHeads: 8, headDim: 128 }, 8192)
    const real70 = kvCacheBytes({ layers: 80, kvHeads: 8, headDim: 128 }, 8192)
    expect(kvCacheBytes(fallbackAttention(8), 8192) / real8).toBeCloseTo(1, 1)
    expect(kvCacheBytes(fallbackAttention(70), 8192) / real70).toBeCloseTo(1, 1)
  })
})

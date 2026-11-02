import { describe, expect, it } from 'vitest'
import { bitsPerWeight, normalizeQuant } from './quant'
import { kvCacheBytes } from './attention'

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
})

describe('kvCacheBytes', () => {
  it('is context length times bytes per token: Llama 3.1 8B at 8192 tokens is exactly 1 GiB', () => {
    expect(kvCacheBytes({ layers: 32, kvHeads: 8, headDim: 128 }, 8192)).toBe(GIB)
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
})

import { describe, expect, it } from 'vitest'
import {
  bytesPerParam,
  estimateKvCacheBytes,
  estimateMemory,
  estimateOverheadBytes,
  estimateWeightsBytes
} from './memory'

const GIB = 1024 ** 3
const GB = 1e9

describe('bytesPerParam', () => {
  it('is bits per weight divided by eight', () => {
    expect(bytesPerParam('FP16')).toBe(2)
    expect(bytesPerParam('BF16')).toBe(2)
    expect(bytesPerParam('Q8_0')).toBe(1.0625)
    expect(bytesPerParam('Q4_K_M')).toBeCloseTo(4.89 / 8, 5)
    expect(bytesPerParam('FP32')).toBe(4)
  })
  it('assumes about 5.6 bits for an unknown quantization', () => {
    expect(bytesPerParam(undefined)).toBe(0.7)
    expect(bytesPerParam('some-future-quant')).toBe(0.7)
  })
})

describe('estimateWeightsBytes against published GGUF file sizes', () => {
  // [model, billions of parameters, quantization, published file size in decimal GB]
  const table: Array<[string, number, string, number]> = [
    ['Llama 3.1 8B', 8.03, 'Q4_K_M', 4.92],
    ['Llama 3.1 8B', 8.03, 'Q8_0', 8.54],
    ['Llama 3.1 8B', 8.03, 'F16', 16.07],
    ['Llama 3.1 8B', 8.03, 'Q2_K', 3.18],
    ['Llama 3.3 70B', 70.55, 'Q4_K_M', 42.52],
    ['Mistral 7B v0.3', 7.25, 'Q4_K_M', 4.37],
    ['Qwen2.5 14B', 14.77, 'Q4_K_M', 8.99],
    ['Qwen2.5 32B', 32.76, 'Q4_K_M', 19.85],
    ['Phi-4', 14.66, 'Q4_K_M', 9.05],
    ['Gemma 3 27B', 27.43, 'Q4_K_M', 16.55]
  ]
  it.each(table)('%s %s %s is about %f GB', (_name, params, quant, published) => {
    const r = estimateWeightsBytes(params, quant)
    const mid = (r.low + r.high) / 2
    expect(Math.abs(mid / GB - published) / published).toBeLessThan(0.03)
    expect(r.low / GB).toBeLessThanOrEqual(published)
    expect(r.high / GB).toBeGreaterThanOrEqual(published)
  })

  it('puts Llama 3.1 8B at Q4_K_M at roughly 4.9 GB of weights', () => {
    const r = estimateWeightsBytes(8.03, 'Q4_K_M')
    expect((r.low + r.high) / 2 / GB).toBeCloseTo(4.9, 1)
  })

  it('keeps the old 7B bounds: 3.2 to 4.5 GiB', () => {
    const r = estimateWeightsBytes(7, 'Q4_K_M')
    expect(r.low / GIB).toBeGreaterThan(3.2)
    expect(r.high / GIB).toBeLessThan(4.5)
    expect(r.low).toBeLessThan(r.high)
  })
})

describe('estimateKvCacheBytes (kept for compatibility)', () => {
  it('grows with context length', () => {
    const small = estimateKvCacheBytes(2048, 7)
    const large = estimateKvCacheBytes(8192, 7)
    expect(large.high).toBeGreaterThan(small.high)
  })
  it('is grouped-query aware: an 8B model at 8192 tokens is about 1 GiB, not 4', () => {
    const r = estimateKvCacheBytes(8192, 8)
    expect(r.high / GIB).toBeLessThan(1.3)
    expect(r.low / GIB).toBeGreaterThan(0.8)
  })
})

describe('estimateOverheadBytes', () => {
  it('is a fixed runtime cost plus a share of the weights', () => {
    const small = estimateOverheadBytes(1 * GB)
    const big = estimateOverheadBytes(40 * GB)
    expect(small.low).toBeGreaterThan(0.3 * GIB)
    expect(big.high).toBeGreaterThan(small.high)
    expect(small.low).toBeLessThan(small.high)
  })
})

describe('estimateMemory', () => {
  const llama8b = {
    parameterCount: 8.03,
    quantization: 'Q4_K_M',
    attention: { layers: 32, kvHeads: 8, headDim: 128 }
  }

  it('sums weights + KV cache + overhead into the total', () => {
    const m = estimateMemory({ parameterCount: 7, quantization: 'Q4_K_M' }, 4096)
    expect(m.basis).toBe('theoretical')
    expect(m.totalBytes.low).toBeCloseTo(m.weightsBytes.low + m.kvCacheBytes.low + m.overheadBytes.low, -6)
    expect(m.totalBytes.high).toBeCloseTo(m.weightsBytes.high + m.kvCacheBytes.high + m.overheadBytes.high, -6)
    expect(m.notes.length).toBeGreaterThan(0)
  })

  it('notes when the parameter count is unknown', () => {
    const m = estimateMemory({ quantization: 'Q4_K_M' }, 4096)
    expect(m.notes.join(' ')).toMatch(/unknown/i)
  })

  it('uses the exact KV cache when the attention shape is known: Llama 3.1 8B at 8192 is 1 GiB', () => {
    const m = estimateMemory(llama8b, 8192)
    expect(m.kvCacheBytes.low).toBe(GIB)
    expect(m.kvCacheBytes.high).toBe(GIB)
  })

  it('widens the KV range when the shape is only a size-class guess', () => {
    const m = estimateMemory({ parameterCount: 8, quantization: 'Q4_K_M' }, 8192)
    expect(m.kvCacheBytes.high).toBeGreaterThan(m.kvCacheBytes.low)
    expect(m.notes.join(' ')).toMatch(/guess|size/i)
  })

  it('totals Llama 3.1 8B Q4_K_M at 8192 tokens in the 6 to 7 GiB band seen on real GPUs', () => {
    const m = estimateMemory(llama8b, 8192)
    expect(m.totalBytes.low / GIB).toBeGreaterThan(5.5)
    expect(m.totalBytes.low / GIB).toBeLessThan(6.3)
    expect(m.totalBytes.high / GIB).toBeGreaterThan(6.3)
    expect(m.totalBytes.high / GIB).toBeLessThan(7.3)
  })

  it('prefers a known file size over parameters times bits', () => {
    const m = estimateMemory({ parameterCount: 8.03, quantization: 'Q4_K_M', diskSizeBytes: 5.2 * GB }, 2048)
    expect((m.weightsBytes.low + m.weightsBytes.high) / 2 / GB).toBeCloseTo(5.2, 1)
    expect(m.weightsBytes.high - m.weightsBytes.low).toBeLessThan(0.05 * 5.2 * GB)
  })

  it('shrinks with a quantized KV cache', () => {
    const f16 = estimateMemory(llama8b, 32768)
    const q8 = estimateMemory(llama8b, 32768, { kvCacheType: 'q8_0' })
    expect(q8.kvCacheBytes.high).toBeLessThan(f16.kvCacheBytes.high * 0.6)
  })

  it('grows with the context length', () => {
    const a = estimateMemory(llama8b, 4096).totalBytes.high
    const b = estimateMemory(llama8b, 32768).totalBytes.high
    expect(b).toBeGreaterThan(a)
  })

  it('needs more for a bigger quantization of the same model', () => {
    const q4 = estimateMemory({ ...llama8b, quantization: 'Q4_K_M' }, 4096).totalBytes.high
    const q8 = estimateMemory({ ...llama8b, quantization: 'Q8_0' }, 4096).totalBytes.high
    expect(q8).toBeGreaterThan(q4)
  })
})

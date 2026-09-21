import { describe, expect, it } from 'vitest'
import { bytesPerParam, estimateKvCacheBytes, estimateMemory, estimateWeightsBytes } from './memory'

const GB = 1024 * 1024 * 1024

describe('bytesPerParam', () => {
  it('returns known values', () => {
    expect(bytesPerParam('FP16')).toBe(2)
    expect(bytesPerParam('Q8_0')).toBe(1)
    expect(bytesPerParam('Q4_K_M')).toBe(0.55)
    expect(bytesPerParam('FP32')).toBe(4)
  })
  it('assumes ~5-bit for unknown quant', () => {
    expect(bytesPerParam(undefined)).toBe(0.7)
    expect(bytesPerParam('some-future-quant')).toBe(0.7)
  })
})

describe('estimateWeightsBytes', () => {
  it('estimates a 7B Q4 model in the 3.3–4.5 GB range', () => {
    const r = estimateWeightsBytes(7, 'Q4_K_M')
    expect(r.low / GB).toBeGreaterThan(3.2)
    expect(r.high / GB).toBeLessThan(4.5)
    expect(r.low).toBeLessThan(r.high)
  })
})

describe('estimateKvCacheBytes', () => {
  it('grows with context length', () => {
    const small = estimateKvCacheBytes(2048, 7)
    const large = estimateKvCacheBytes(8192, 7)
    expect(large.high).toBeGreaterThan(small.high)
  })
})

describe('estimateMemory', () => {
  it('sums weights + kv + overhead into total', () => {
    const m = estimateMemory({ parameterCount: 7, quantization: 'Q4_K_M' }, 4096)
    expect(m.basis).toBe('theoretical')
    expect(m.totalBytes.low).toBeCloseTo(
      m.weightsBytes.low + m.kvCacheBytes.low + m.overheadBytes.low,
      -6
    )
    expect(m.notes.length).toBeGreaterThan(0)
  })
  it('notes when parameter count is unknown', () => {
    const m = estimateMemory({ quantization: 'Q4_K_M' }, 4096)
    expect(m.notes.join(' ')).toMatch(/unknown/i)
  })
})

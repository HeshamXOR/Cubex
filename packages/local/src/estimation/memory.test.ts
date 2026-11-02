import { describe, expect, it } from 'vitest'
import { estimateMemory, estimateWeightsBytes } from './memory'

const GIB = 1024 ** 3
const GB = 1e9

describe('estimateWeightsBytes against published GGUF file sizes', () => {
  it('puts Llama 3.1 8B at Q4_K_M at roughly 4.9 GB of weights', () => {
    const r = estimateWeightsBytes(8.03, 'Q4_K_M')
    expect((r.low + r.high) / 2 / GB).toBeCloseTo(4.9, 1)
  })
})

describe('estimateMemory', () => {
  const llama8b = {
    parameterCount: 8.03,
    quantization: 'Q4_K_M',
    attention: { layers: 32, kvHeads: 8, headDim: 128 }
  }

  it('uses the exact KV cache when the attention shape is known: Llama 3.1 8B at 8192 is 1 GiB', () => {
    const m = estimateMemory(llama8b, 8192)
    expect(m.kvCacheBytes.low).toBe(GIB)
    expect(m.kvCacheBytes.high).toBe(GIB)
  })

  it('totals Llama 3.1 8B Q4_K_M at 8192 tokens in the 6 to 7 GiB band seen on real GPUs', () => {
    const m = estimateMemory(llama8b, 8192)
    expect(m.totalBytes.low / GIB).toBeGreaterThan(5.5)
    expect(m.totalBytes.low / GIB).toBeLessThan(6.3)
    expect(m.totalBytes.high / GIB).toBeGreaterThan(6.3)
    expect(m.totalBytes.high / GIB).toBeLessThan(7.3)
  })
})

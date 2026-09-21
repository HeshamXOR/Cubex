import { describe, expect, it } from 'vitest'
import { estimateSpeed } from './speed'
import { estimateMemory } from './memory'
import type { SystemProfile } from '../../../core/src/types/hardware'

const GB = 1024 * 1024 * 1024

function profile(vramGb: number, ramGb = 32): SystemProfile {
  return {
    cpu: { model: 'Test CPU', architecture: 'x64', physicalCores: 8, logicalThreads: 16 },
    memory: { totalBytes: ramGb * GB, availableBytes: (ramGb - 4) * GB },
    gpus:
      vramGb > 0
        ? [{ model: 'Test GPU 4090', vendor: 'nvidia', vramBytes: vramGb * GB, backends: ['cuda', 'vulkan'] }]
        : [],
    storage: { totalBytes: 500 * GB, freeBytes: 200 * GB },
    os: { platform: 'win32', arch: 'x64' },
    accelerators: vramGb > 0 ? ['cuda', 'vulkan', 'cpu'] : ['cpu'],
    detectedAt: Date.now()
  }
}

const model7bQ4 = { parameterCount: 7, quantization: 'Q4_K_M' as const }

describe('estimateSpeed', () => {
  it('fully-in-VRAM is faster than CPU-only for the same model', () => {
    const mem = estimateMemory(model7bQ4, 4096)
    const gpu = estimateSpeed(model7bQ4, profile(24), mem, 4096)
    const cpu = estimateSpeed(model7bQ4, profile(0), mem, 4096)
    expect(gpu.tokensPerSecond.high).toBeGreaterThan(cpu.tokensPerSecond.high)
  })

  it('always returns a range (low < high) for theoretical estimates', () => {
    const mem = estimateMemory(model7bQ4, 4096)
    const s = estimateSpeed(model7bQ4, profile(24), mem, 4096)
    expect(s.basis).toBe('theoretical')
    expect(s.tokensPerSecond.low).toBeLessThan(s.tokensPerSecond.high)
  })

  it('reports high confidence only when fully in VRAM with known params + vram', () => {
    const mem = estimateMemory(model7bQ4, 4096)
    expect(estimateSpeed(model7bQ4, profile(24), mem, 4096).confidence).toBe('high')
    // CPU-only → low confidence
    expect(estimateSpeed(model7bQ4, profile(0), mem, 4096).confidence).toBe('low')
    // Unknown params → not high
    const memU = estimateMemory({ quantization: 'Q4_K_M' }, 4096)
    expect(estimateSpeed({ quantization: 'Q4_K_M' }, profile(24), memU, 4096).confidence).not.toBe('high')
  })
})

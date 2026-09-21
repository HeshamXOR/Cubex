import { describe, expect, it } from 'vitest'
import { analyzeCompatibility, recommendModels } from './analyze'
import type { SystemProfile } from '../../../core/src/types/hardware'
import type { ModelInfo } from '../../../core/src/types/model'

const GB = 1024 * 1024 * 1024

function profile(vramGb: number, ramGb = 32): SystemProfile {
  return {
    cpu: { model: 'CPU', architecture: 'x64', physicalCores: 8, logicalThreads: 16 },
    memory: { totalBytes: ramGb * GB, availableBytes: (ramGb - 4) * GB },
    gpus: vramGb > 0 ? [{ model: 'GPU', vendor: 'nvidia', vramBytes: vramGb * GB, backends: ['cuda'] }] : [],
    storage: { totalBytes: 500 * GB, freeBytes: 200 * GB },
    os: { platform: 'win32', arch: 'x64' },
    accelerators: vramGb > 0 ? ['cuda', 'cpu'] : ['cpu'],
    detectedAt: Date.now()
  }
}

function model(params: number, runtimes = ['ollama']): ModelInfo {
  return {
    id: `m-${params}b`,
    providerId: 'ollama',
    displayName: `Model ${params}B`,
    location: 'local',
    capabilities: ['text'],
    modalities: { input: ['text'], output: ['text'] },
    supportsTools: false,
    supportsStructuredOutput: false,
    supportsReasoning: false,
    parameterCount: params,
    quantization: 'Q4_K_M',
    supportedRuntimes: runtimes
  }
}

describe('analyzeCompatibility', () => {
  it('small model on a big GPU → fits_vram', () => {
    const r = analyzeCompatibility(model(3), profile(24), 4096, ['ollama'])
    expect(r.status).toBe('fits_vram')
    expect(r.reason).toMatch(/GB/)
  })

  it('huge model beyond VRAM+RAM → insufficient_memory', () => {
    const r = analyzeCompatibility(model(70), profile(8, 16), 4096, ['ollama'])
    expect(r.status).toBe('insufficient_memory')
    expect(r.reason).toMatch(/\d/)
  })

  it('mid model larger than VRAM but fits with RAM → offload_required', () => {
    const r = analyzeCompatibility(model(14), profile(6, 32), 4096, ['ollama'])
    expect(r.status).toBe('offload_required')
    expect(r.reason).toMatch(/offload/i)
  })

  it('no matching installed runtime → unsupported_runtime', () => {
    const r = analyzeCompatibility(model(7, ['vllm']), profile(24), 4096, ['ollama'])
    expect(r.status).toBe('unsupported_runtime')
  })
})

describe('recommendModels', () => {
  const models = [model(3), model(8), model(14), model(70)]

  it('ranks fitting models before non-fitting ones', () => {
    const results = recommendModels(models, profile(12, 32), 'general', ['ollama'])
    const statuses = results.map((r) => r.status)
    const firstBad = statuses.findIndex((s) => s === 'insufficient_memory')
    const lastGood = statuses.lastIndexOf('fits_vram')
    if (firstBad !== -1 && lastGood !== -1) expect(lastGood).toBeLessThan(firstBad)
  })

  it('low_memory goal prefers the smallest model first', () => {
    const results = recommendModels(models, profile(24, 64), 'low_memory', ['ollama'])
    expect(results[0]!.model.parameterCount).toBe(3)
  })
})

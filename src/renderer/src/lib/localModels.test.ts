import { describe, expect, it } from 'vitest'
import { acceleratorSummary, formatEta, plainError, pullStage } from './localModels'

describe('hardware labels', () => {

  it('lists GPU backends first and the CPU last', () => {
    expect(acceleratorSummary(['cpu', 'cuda', 'vulkan'])).toBe('CUDA, Vulkan, CPU')
    expect(acceleratorSummary(['metal'])).toBe('Metal')
  })

})

describe('formatEta', () => {
  it('reads seconds, minutes and hours', () => {
    expect(formatEta(0.4)).toBe('1 s')
    expect(formatEta(45)).toBe('45 s')
    expect(formatEta(150)).toBe('3 min')
    expect(formatEta(3600)).toBe('1 h')
    expect(formatEta(3900)).toBe('1 h 5 min')
  })

})

describe('plainError', () => {
  it('drops the error class main puts in front of a message', () => {
    expect(plainError('TypeError: fetch failed')).toBe('fetch failed')
    expect(plainError(new Error('Error: disk full'))).toBe('disk full')
  })

})

describe('pullStage', () => {
  it.each([
    [{ phase: 'queued', status: 'queued', queuePosition: 1 }, 'Queued, 2nd'],
    [{ phase: 'preparing', status: 'pulling manifest' }, 'Resolving'],
    [{ phase: 'downloading', status: 'downloading' }, 'Downloading'],
    [{ phase: 'verifying', status: 'verifying' }, 'Verifying'],
    [{ phase: 'finalizing', status: 'writing manifest' }, 'Finishing'],
    [{ phase: 'done', status: 'success' }, 'Done'],
    [{ phase: 'cancelled', status: 'cancelled' }, 'Cancelled'],
    [{ phase: 'error', status: 'error' }, 'Failed']
  ])('names %j', (progress, expected) => {
    expect(pullStage(progress)).toBe(expected)
  })

  it('falls back to the status text when a runtime reports no phase', () => {
    expect(pullStage({ status: 'verifying sha256 digest' })).toBe('Verifying')
    expect(pullStage({ status: 'pulling manifest' })).toBe('Preparing')
  })
})

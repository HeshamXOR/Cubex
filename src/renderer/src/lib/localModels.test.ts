import { describe, expect, it } from 'vitest'
import {
  acceleratorLabel,
  acceleratorSummary,
  basisLabel,
  formatEta,
  ordinal,
  plainError,
  platformLabel,
  pullFileLine,
  pullStage,
  pullStageLabel,
  pullWaitingText,
  queueLabel,
  runtimeName,
  stalledText
} from './localModels'

describe('hardware labels', () => {
  it('names acceleration backends the way their vendors do', () => {
    expect(acceleratorLabel('cuda')).toBe('CUDA')
    expect(acceleratorLabel('rocm')).toBe('ROCm')
    expect(acceleratorLabel('directml')).toBe('DirectML')
    expect(acceleratorLabel('something-new')).toBe('something-new')
  })

  it('lists GPU backends first and the CPU last', () => {
    expect(acceleratorSummary(['cpu', 'cuda', 'vulkan'])).toBe('CUDA, Vulkan, CPU')
    expect(acceleratorSummary(['metal'])).toBe('Metal')
  })

  it('says CPU only when nothing else is available', () => {
    expect(acceleratorSummary(['cpu'])).toBe('CPU only')
    expect(acceleratorSummary([])).toBe('CPU only')
  })

  it('names platforms and keeps unknown ones as reported', () => {
    expect(platformLabel('win32')).toBe('Windows')
    expect(platformLabel('darwin')).toBe('macOS')
    expect(platformLabel('freebsd')).toBe('freebsd')
  })

  it('says where an estimate came from', () => {
    expect(basisLabel('theoretical')).toBe('calculated from specs')
    expect(basisLabel('measured')).toBe('measured on this PC')
    expect(basisLabel('guess')).toBe('guess')
  })
})

describe('pullStageLabel', () => {
  it.each([
    ['pulling manifest', 'Preparing'],
    ['downloading', 'Downloading'],
    ['pulling 6a0746a1ec1a', 'Downloading'],
    ['verifying sha256 digest', 'Verifying'],
    ['writing manifest', 'Finishing'],
    ['removing any unused layers', 'Finishing'],
    ['success', 'Done'],
    ['cancelled', 'Cancelled'],
    ['error', 'Failed']
  ])('turns %j into %j', (status, label) => {
    expect(pullStageLabel(status)).toBe(label)
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

  it('is empty when the time is unknown', () => {
    expect(formatEta(undefined)).toBe('')
    expect(formatEta(0)).toBe('')
    expect(formatEta(Number.NaN)).toBe('')
  })
})

describe('runtimeName', () => {
  it('uses the product name, and the id for runtimes it does not know', () => {
    expect(runtimeName('ollama')).toBe('Ollama')
    expect(runtimeName('lmstudio')).toBe('LM Studio')
    expect(runtimeName('vllm')).toBe('vllm')
  })
})

describe('plainError', () => {
  it('drops the error class main puts in front of a message', () => {
    expect(plainError('TypeError: fetch failed')).toBe('fetch failed')
    expect(plainError(new Error('Error: disk full'))).toBe('disk full')
  })

  it('leaves a message without a class alone', () => {
    expect(plainError(new Error('Ollama is not running.'))).toBe('Ollama is not running.')
    expect(plainError('plain')).toBe('plain')
  })
})

describe('ordinal', () => {
  it.each([
    [1, '1st'],
    [2, '2nd'],
    [3, '3rd'],
    [4, '4th'],
    [10, '10th'],
    [11, '11th'],
    [12, '12th'],
    [13, '13th'],
    [21, '21st'],
    [22, '22nd'],
    [23, '23rd'],
    [101, '101st'],
    [111, '111th']
  ])('writes %d as %s', (n, expected) => {
    expect(ordinal(n)).toBe(expected)
  })
})

describe('queueLabel', () => {
  it('counts the running download as first, so the next one up is second', () => {
    expect(queueLabel(1)).toBe('Queued, 2nd')
    expect(queueLabel(2)).toBe('Queued, 3rd')
    expect(queueLabel(3)).toBe('Queued, 4th')
  })

  it('still says queued when the place is not known', () => {
    expect(queueLabel(undefined)).toBe('Queued')
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

describe('pullFileLine', () => {
  it('says which part of a split model is being fetched', () => {
    expect(pullFileLine({ fileName: 'model-00002-of-00003.gguf', fileIndex: 2, fileCount: 3 })).toBe('Part 2 of 3, model-00002-of-00003.gguf')
    expect(pullFileLine({ fileIndex: 1, fileCount: 2 })).toBe('Part 1 of 2')
  })

  it('names a single file and is empty when there is nothing to say', () => {
    expect(pullFileLine({ fileName: 'Q4_K_M.gguf', fileIndex: 1, fileCount: 1 })).toBe('Q4_K_M.gguf')
    expect(pullFileLine({})).toBe('')
  })
})

describe('stalledText', () => {
  it('says how long nothing has arrived and what to do', () => {
    expect(stalledText(30)).toBe('No data received for 30 s. Check your connection or cancel and retry.')
    expect(stalledText(185)).toBe('No data received for 3 min. Check your connection or cancel and retry.')
  })

  it('still reads well when the time is not known', () => {
    expect(stalledText(0)).toBe('No data is arriving. Check your connection or cancel and retry.')
  })
})

describe('pullWaitingText', () => {
  it('describes the stage when the runtime reports no byte count', () => {
    expect(pullWaitingText(undefined)).toBe('Checking the model and free disk space.')
    expect(pullWaitingText('preparing')).toBe('Checking the model and free disk space.')
    expect(pullWaitingText('verifying')).toBe('Checking the downloaded files.')
    expect(pullWaitingText('finalizing')).toBe('Saving the model.')
  })
})

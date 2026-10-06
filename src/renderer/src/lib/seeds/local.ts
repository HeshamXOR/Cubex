import type { CubexAPI, PullProgress } from '../../../../shared/ipc'
import type { PreviewSeed } from './index'

/**
 * Sample data for the Local models and Hardware views in the browser preview. Open a view with
 * `window.__store.getState().setView('local' | 'hardware')`. Flags (all with `?seed=1`):
 *   pull=hold      the first download stops at 38 percent
 *   pull=queue     three downloads at once: one running, two waiting
 *   pull=stall     the download stops receiving bytes, so the stalled hint shows
 *   pull=nospace   the download is refused for lack of disk space
 *   pull=fail      Ollama cannot be reached
 *   pull=slow      progress moves slowly, to watch a download
 *   runtime=down   Ollama is not running (downloads fail the same way as pull=fail)
 *   hw=slow|error|none|analyzefail|nogpu|long   the Hardware view's loading, error, empty and unusual cases
 */

type PullEvent = PullProgress & { pullId: string }

const GB = 1024 ** 3
const MB = 1024 ** 2
const RUNTIME = 'ollama'

const SIZES: Record<string, number> = {
  'qwen3:8b': 5.2 * GB,
  'llama3.1:8b': 4.9 * GB,
  'gemma3:4b': 3.3 * GB,
  'deepseek-r1:14b': 9 * GB,
  'phi4:14b': 9.1 * GB
}
const sizeOf = (modelId: string): number => SIZES[modelId] ?? 4.9 * GB

const formatSize = (bytes: number): string => `${(bytes / GB).toFixed(1)} GB`

type Job = { pullId: string; modelId: string; timer?: number }

function createPullSimulator(flag: string | null, runtimeDown: boolean) {
  const listeners = new Set<(p: PullEvent) => void>()
  const queue: Job[] = []
  let active: Job | undefined
  const emit = (p: PullEvent): void => listeners.forEach((listener) => listener(p))
  const send = (job: Job, p: Omit<PullProgress, 'modelId'>): void => emit({ pullId: job.pullId, modelId: job.modelId, runtime: RUNTIME, ...p })
  const mode = runtimeDown && !flag ? 'fail' : (flag ?? 'run')

  const announceQueue = (): void =>
    queue.forEach((job, i) => send(job, { status: 'queued', phase: 'queued', queuePosition: i + 1, done: false }))

  const finish = (job: Job): void => {
    if (active === job) active = undefined
    next()
  }

  const run = (job: Job): void => {
    const total = sizeOf(job.modelId)
    const speed = 38.5 * MB
    const after = (ms: number, fn: () => void): void => {
      job.timer = window.setTimeout(fn, ms)
    }
    const progress = (done: number): void =>
      send(job, {
        status: 'downloading',
        phase: 'downloading',
        completedBytes: done,
        totalBytes: total,
        speedBps: speed,
        etaSeconds: Math.round((total - done) / speed),
        done: false
      })

    send(job, { status: 'preparing', phase: 'preparing', done: false })
    if (mode === 'fail') {
      after(500, () => {
        send(job, {
          status: 'error',
          phase: 'error',
          errorCode: 'runtime_unreachable',
          done: true,
          error: 'Could not reach Ollama at http://127.0.0.1:11434. Make sure Ollama is running, then try again.'
        })
        finish(job)
      })
      return
    }
    if (mode === 'nospace') {
      after(500, () => {
        send(job, {
          status: 'error',
          phase: 'error',
          errorCode: 'disk_space',
          done: true,
          error: `This model needs about ${formatSize(total)} and C: has 2.1 GB free. Free up space, or move Ollama's models to a larger drive with the OLLAMA_MODELS setting.`
        })
        finish(job)
      })
      return
    }
    if (mode === 'hold' || mode === 'queue') {
      after(400, () => progress(total * 0.38))
      return
    }
    if (mode === 'stall') {
      after(400, () => progress(total * 0.41))
      after(1200, () =>
        send(job, {
          status: 'downloading',
          phase: 'downloading',
          completedBytes: total * 0.41,
          totalBytes: total,
          stalledForSeconds: 34,
          done: false
        })
      )
      return
    }
    let done = 0
    const step = mode === 'slow' ? 0.02 : 0.12
    const tick = (): void => {
      done = Math.min(total, done + total * step)
      progress(done)
      if (done < total) {
        after(450, tick)
        return
      }
      // Ollama repeats the running total through the last two stages, so the bar stays full.
      send(job, { status: 'verifying', phase: 'verifying', completedBytes: total, totalBytes: total, done: false })
      after(700, () => {
        send(job, { status: 'writing manifest', phase: 'finalizing', completedBytes: total, totalBytes: total, done: false })
        after(500, () => {
          void import('../previewSeed').then(({ seedLocalModels }) => {
            if (!seedLocalModels.some((m) => m.id === job.modelId)) {
              seedLocalModels.push({ id: job.modelId, name: job.modelId, runtime: RUNTIME, sizeBytes: total, quantization: 'Q4_K_M' })
            }
            send(job, { status: 'success', phase: 'done', done: true })
            finish(job)
          })
        })
      })
    }
    after(500, tick)
  }

  function next(): void {
    if (active || queue.length === 0) return
    active = queue.shift()!
    announceQueue()
    run(active)
  }

  const enqueue = (modelId: string): string => {
    const existing = [active, ...queue].find((job) => job?.modelId === modelId)
    if (existing) return existing.pullId
    const job: Job = { pullId: `seed-${Math.random().toString(36).slice(2, 8)}`, modelId }
    queue.push(job)
    if (active) announceQueue()
    else next()
    return job.pullId
  }

  const cancel = (pullId: string): void => {
    if (active?.pullId === pullId) {
      window.clearTimeout(active.timer)
      const job = active
      send(job, { status: 'cancelled', phase: 'cancelled', done: true })
      finish(job)
      return
    }
    const index = queue.findIndex((job) => job.pullId === pullId)
    if (index < 0) return
    const [job] = queue.splice(index, 1)
    send(job!, { status: 'cancelled', phase: 'cancelled', done: true })
    announceQueue()
  }

  return { listeners, enqueue, cancel }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export const seed: PreviewSeed = {
  api: (flags) => {
    const pullFlag = flags.get('pull')
    const sim = createPullSimulator(pullFlag, flags.get('runtime') === 'down')
    const hw = flags.get('hw')
    const methods: Partial<CubexAPI> = {
      onPullProgress: (cb) => {
        const first = sim.listeners.size === 0
        sim.listeners.add(cb)
        // The queue scenario starts on its own, so the three downloads are there when the view opens.
        if (first && pullFlag === 'queue') {
          window.setTimeout(() => {
            for (const modelId of ['qwen3:8b', 'phi4:14b', 'gemma3:4b']) sim.enqueue(modelId)
          }, 60)
        }
        return () => {
          sim.listeners.delete(cb)
        }
      },
      pullModel: async (req) => ({ pullId: sim.enqueue(req.modelId) }),
      cancelPull: async (pullId) => sim.cancel(pullId)
    }
    if (hw === 'slow') {
      methods.scanHardware = async () => {
        await sleep(6000)
        return (await import('../previewSeed')).seedHardware
      }
    }
    if (hw === 'error') {
      methods.scanHardware = async () => {
        throw new Error('Error: systeminformation could not read the graphics adapters (access denied).')
      }
    }
    if (hw === 'nogpu') {
      methods.scanHardware = async () => {
        const { seedHardware } = await import('../previewSeed')
        return {
          ...seedHardware,
          cpu: { ...seedHardware.cpu, model: 'Intel Core i5-8250U CPU @ 1.60GHz', physicalCores: 4, logicalThreads: 8, simd: ['avx2'] },
          memory: { totalBytes: 8 * GB, availableBytes: 3.1 * GB },
          gpus: [],
          storage: { ...seedHardware.storage, freeBytes: 38 * GB, isSSD: false },
          accelerators: ['cpu']
        }
      }
    }
    if (hw === 'long') {
      methods.scanHardware = async () => {
        const { seedHardware } = await import('../previewSeed')
        return {
          ...seedHardware,
          cpu: { ...seedHardware.cpu, model: 'Intel(R) Xeon(R) Platinum 8480+ Sapphire Rapids Processor with extended instruction sets' },
          gpus: [{ model: 'NVIDIA RTX 6000 Ada Generation Workstation Edition (professional visualization board)', vendor: 'nvidia' as const, vramBytes: 48 * GB, backends: ['cuda' as const, 'vulkan' as const] }],
          storage: { ...seedHardware.storage, modelsDir: 'D:\\Shared\\Machine Learning\\Local Model Weights and Checkpoints\\Ollama\\models' }
        }
      }
      methods.analyzeModels = async () => {
        const { seedCompatibility } = await import('../previewSeed')
        const [first] = seedCompatibility()
        return [
          {
            ...first!,
            model: { ...first!.model, displayName: 'Llama 3.1 Nemotron Ultra 253B Instruct Reasoning Mixture-of-Experts (long context)', quantization: 'Q4_K_M' as const },
            reason: 'Needs about 148 GB. This PC has 48 GB of VRAM and 128 GB of RAM, so most of the model runs from system memory and generation is limited by memory bandwidth.'
          }
        ]
      }
    }
    if (hw === 'none') methods.analyzeModels = async () => []
    if (hw === 'analyzefail') {
      methods.analyzeModels = async () => {
        throw new Error('Error: The model catalog could not be read.')
      }
    }
    return methods
  }
}

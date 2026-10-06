import { parentPort, workerData } from 'node:worker_threads'
import { loadTypeScript, ProjectChecker } from './tsHost'
import type { CheckOutcome, WorkerInit, WorkerRequest, WorkerResponse } from './tsProtocol'

if (parentPort && workerData) {
  const port = parentPort
  const init = workerData as WorkerInit
  const loaded = loadTypeScript(init.root, init.fallbackDir)

  if ('reason' in loaded) {
    port.postMessage({ kind: 'unavailable', reason: loaded.reason } satisfies WorkerResponse)
  } else {
    port.postMessage({ kind: 'ready', version: loaded.version, source: loaded.source } satisfies WorkerResponse)

    const cancelArray = new Int32Array(init.cancel)
    let running = -1
    const checker = new ProjectChecker({
      ts: loaded.ts,
      root: init.root,
      cancelled: () => Atomics.load(cancelArray, 0) === running
    })

    const run = (request: WorkerRequest): CheckOutcome => {
      switch (request.kind) {
        case 'check': return checker.check(request.abs, request.before, request.after)
        case 'current': return checker.current(request.abs)
        case 'warm': return checker.warm()
        default: return { status: 'failed', reason: 'Unknown request.' }
      }
    }

    port.on('message', (request: WorkerRequest) => {
      running = request.id
      let outcome: CheckOutcome
      try {
        outcome = run(request)
      } catch (error) {
        outcome = { status: 'failed', reason: error instanceof Error ? error.message : String(error) }
      }
      port.postMessage({ kind: 'result', id: request.id, outcome } satisfies WorkerResponse)
    })

    port.on('close', () => checker.dispose())
  }
}

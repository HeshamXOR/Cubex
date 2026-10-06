// A stand-in for the real worker that speaks the same protocol, so the manager's queue, timeouts and recovery can
// be exercised in milliseconds. Its behaviour is read from fake.json in the workspace root on every request.
const { parentPort, workerData } = require('node:worker_threads')
const fs = require('node:fs')
const path = require('node:path')

const cancel = new Int32Array(workerData.cancel)
const read = () => JSON.parse(fs.readFileSync(path.join(workerData.root, 'fake.json'), 'utf8'))
const log = (line) => fs.appendFileSync(path.join(workerData.root, 'fake.log'), line + '\n')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const first = read()
log('start')
if (first.startup === 'unavailable') {
  parentPort.postMessage({ kind: 'unavailable', reason: 'fake: this compiler has no language service' })
} else if (first.startup === 'crash') {
  throw new Error('fake startup crash')
} else {
  parentPort.postMessage({ kind: 'ready', version: '9.9.9', source: 'workspace' })
  parentPort.on('message', async (request) => {
    const config = read()
    log(request.kind + (request.abs ? ':' + path.basename(request.abs) : ''))
    if (config.behavior === 'deaf') return
    if (config.behavior === 'crash') process.exit(3)
    if (config.behavior === 'hang') {
      // CPU-bound like a real check: only a stop for this request's id can end it.
      const started = Date.now()
      while (Atomics.load(cancel, 0) !== request.id && Date.now() - started < 20000) { /* spin */ }
      parentPort.postMessage({ kind: 'result', id: request.id, outcome: { status: 'cancelled' } })
      return
    }
    await sleep(config.delayMs || 0)
    const outcome = request.kind === 'warm'
      ? { status: 'ok' }
      : { status: 'ok', before: config.before || [], after: config.after || [] }
    parentPort.postMessage({ kind: 'result', id: request.id, outcome })
  })
}

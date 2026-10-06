import type { BackgroundTask, ChatEvent, CommandOutputArtifact, CommandOutputPage } from '../../../../shared/ipc'
import type { PreviewSeed } from './index'

/**
 * Background tasks for the browser preview (`?seed=1&done=1&review=1&tab=tasks&tasks=1`): a dev server whose
 * output ticks every second, a watcher that stays quiet, a finished test run with over 300 lines, a failed build,
 * a watcher that hit its time limit and a task that was stopped. Extra flags: `taskstop=warn|fail` makes Stop
 * report a warning or an error, `taskoutput=truncated` marks the dev server's saved output as cut at its limit.
 */

const SEED_WORKSPACE = 'C:\\Users\\dev\\code\\lumen-web'
const CONVERSATION = 'c1'
const SECOND = 1000
const MINUTE = 60 * SECOND

const hms = (ms: number): string => new Date(ms).toLocaleTimeString('en-GB', { hour12: false })

interface Seeded {
  task: BackgroundTask
  /** The saved output as text, given the current time (a running task's output keeps growing). */
  output: (now: number) => string
}

const REQUESTS = [
  'GET /api/uploads 200 in 12ms',
  'GET /src/upload/client.ts 304',
  '[vite] hmr update /src/upload/client.ts',
  'POST /api/uploads/chunk 429 in 3ms',
  'POST /api/uploads/chunk 200 in 48ms',
  'GET /api/session 200 in 6ms'
]

function devServerOutput(startedAt: number, now: number): string {
  const banner = [
    '',
    '  \u001b[32m\u001b[1mVITE\u001b[22m v6.0.7\u001b[39m  ready in \u001b[1m412\u001b[22m ms',
    '',
    '  \u001b[32m➜\u001b[39m  \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m',
    '  \u001b[32m➜\u001b[39m  \u001b[1mNetwork\u001b[22m: use \u001b[1m--host\u001b[22m to expose'
  ]
  const ticks = Math.max(0, Math.floor((now - startedAt) / SECOND) - 1)
  const lines = Array.from({ length: ticks }, (_, index) => `${hms(startedAt + (index + 1) * SECOND)} ${REQUESTS[index % REQUESTS.length]}`)
  return [...banner, ...lines].join('\n') + '\n'
}

function watchOutput(startedAt: number, now: number): string {
  const head = [`[${hms(startedAt)}] Starting compilation in watch mode...`, '', `[${hms(startedAt + 3 * SECOND)}] Found 0 errors. Watching for file changes.`]
  const changes = Math.max(0, Math.floor((now - startedAt) / (20 * SECOND)))
  const lines = Array.from({ length: Math.min(changes, 40) }, (_, index) => {
    const at = startedAt + (index + 1) * 20 * SECOND
    return [`[${hms(at)}] File change detected. Starting incremental compilation...`, '', `[${hms(at + 2 * SECOND)}] Found 0 errors. Watching for file changes.`]
  }).flat()
  return [...head, ...lines].join('\n') + '\n'
}

function testOutput(): string {
  const files = ['upload/client', 'upload/backoff', 'upload/auth', 'upload/types', 'checkout/cart', 'checkout/totals', 'checkout/coupons', 'session/store']
  const lines = [' RUN  v2.1.9 C:/Users/dev/code/lumen-web', '']
  for (let index = 0; index < 320; index++) {
    const file = files[index % files.length]
    lines.push(` \u2713 src/${file}.test.ts > case ${index + 1} ${index % 7 === 0 ? 'retries after a 429 and honors Retry-After' : 'resolves with the parsed body'} ${(index % 9) + 1}ms`)
  }
  lines.push('', ' Test Files  8 passed (8)', '      Tests  320 passed (320)', '   Start at  10:41:02', '   Duration  8.40s (transform 612ms, collect 1.2s, tests 6.1s)')
  return lines.join('\n') + '\n'
}

const BUILD_OUTPUT = [
  '> lumen-web@2.4.0 build',
  '> tsc -b && vite build',
  '',
  "src/upload/client.ts(41,18): error TS2345: Argument of type 'number | null' is not assignable to parameter of type 'number'.",
  "  Type 'null' is not assignable to type 'number'.",
  "src/upload/client.ts(58,7): error TS2322: Type 'Promise<Response | undefined>' is not assignable to type 'Promise<Response>'.",
  "src/upload/backoff.ts(12,31): error TS7006: Parameter 'error' implicitly has an 'any' type.",
  '',
  'Found 3 errors in 2 files.',
  '',
  'Errors  Files',
  '     2  src/upload/client.ts:41',
  '     1  src/upload/backoff.ts:12'
].join('\n') + '\n'

function watcherOutput(startedAt: number): string {
  const lines = ['watch-assets: watching public/assets (poll 250 ms)']
  for (let index = 0; index < 36; index++) lines.push(`${hms(startedAt + (index + 1) * 50 * SECOND)} changed public/assets/hero-${index % 4}.webp, rebuilt 3 variants`)
  lines.push(`${hms(startedAt + 30 * MINUTE)} time limit reached, stopping`)
  return lines.join('\n') + '\n'
}

function seedOutput(): string {
  return ['Connecting to staging (acme-corp)', 'Seeding tenants 10%\rSeeding tenants 40%\rSeeding tenants 100%', 'Seeding users batch 1 of 12', 'Seeding users batch 2 of 12', 'Seeding users batch 3 of 12'].join('\n') + '\n'
}

function build(now: number): Seeded[] {
  const base = (partial: Omit<BackgroundTask, 'conversationId' | 'shell' | 'cwd'> & Partial<Pick<BackgroundTask, 'shell'>>): BackgroundTask =>
    ({ conversationId: CONVERSATION, shell: 'git-bash', cwd: SEED_WORKSPACE, ...partial })
  const devStart = now - (4 * MINUTE + 12 * SECOND)
  const watchStart = now - 9 * MINUTE
  const testStart = now - 3 * MINUTE
  const buildStart = now - 22 * MINUTE
  const timedStart = now - 41 * MINUTE
  const seedStart = now - 13 * MINUTE
  return [
    {
      task: base({
        id: 'p_dev001', command: 'npm run dev -- --port 5173', status: 'running', startedAt: devStart, pid: 14820, outputId: 'out-dev001',
        readyHint: { url: 'http://localhost:5173/', port: 5173, line: 'Local:   http://localhost:5173/' }
      }),
      output: (at) => devServerOutput(devStart, at)
    },
    {
      task: base({ id: 'p_tsc002', command: 'npx tsc --noEmit --watch --preserveWatchOutput', status: 'running', startedAt: watchStart, pid: 9312, outputId: 'out-tsc002', shell: 'powershell' }),
      output: (at) => watchOutput(watchStart, at)
    },
    {
      task: base({ id: 'p_test003', command: 'npm test -- --run src/upload', status: 'exited', exitCode: 0, startedAt: testStart, endedAt: testStart + 8_400, pid: 20144, outputId: 'out-test003' }),
      output: testOutput
    },
    {
      task: base({ id: 'p_build004', command: 'npm run build', status: 'failed', exitCode: 1, startedAt: buildStart, endedAt: buildStart + 6_700, pid: 7716, outputId: 'out-build004' }),
      output: () => BUILD_OUTPUT
    },
    {
      task: base({
        id: 'p_watch005', status: 'timed_out', exitCode: 1, startedAt: timedStart, endedAt: timedStart + 30 * MINUTE, pid: 3380, outputId: 'out-watch005',
        command: 'node scripts/watch-assets.mjs --poll 250 --ignore node_modules,dist,.git,coverage --out C:\\Users\\dev\\code\\lumen-web\\public\\assets --variants 320,640,1280 --format webp'
      }),
      output: () => watcherOutput(timedStart)
    },
    {
      task: base({
        id: 'p_seed006', status: 'killed', exitCode: 1, startedAt: seedStart, endedAt: seedStart + 2 * MINUTE + 41 * SECOND, pid: 11568, outputId: 'out-seed006',
        command: 'node scripts/seed-database.mjs --env staging --tenant acme-corp --verbose --retry 5 --batch-size 500 --skip-existing'
      }),
      output: seedOutput
    }
  ]
}

function artifactOf(seeded: Seeded, bytes: number, truncated: boolean): CommandOutputArtifact {
  const { task } = seeded
  const status: CommandOutputArtifact['status'] = task.status === 'running' ? 'running' : task.status === 'exited' ? 'completed'
    : task.status === 'failed' ? 'failed' : task.status === 'timed_out' ? 'timed_out' : 'cancelled'
  return {
    id: task.outputId, conversationId: task.conversationId, command: task.command, createdAt: task.startedAt, status,
    capturedBytes: bytes, totalBytes: bytes, truncated,
    ...(task.endedAt !== undefined ? { completedAt: task.endedAt } : {}),
    ...(task.status === 'exited' || task.status === 'failed' ? { exitCode: task.exitCode } : {})
  }
}

/** The main process's paging, byte offsets included: a page never ends inside a character. */
function pageOf(artifact: CommandOutputArtifact, text: string, offset: number, limit: number): CommandOutputPage {
  const bytes = new TextEncoder().encode(text)
  if (offset > bytes.length) throw new Error('Output offset is beyond the saved output.')
  if (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) throw new Error('Output offset splits a UTF-8 character. Use the previous page\u2019s nextOffset.')
  let end = Math.min(offset + limit, bytes.length)
  while (end > offset && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--
  return {
    artifact, text: new TextDecoder().decode(bytes.subarray(offset, end)), offset,
    ...(end < bytes.length ? { nextOffset: end } : {}), eof: end === bytes.length
  }
}

export const seed: PreviewSeed = {
  api: (flags) => {
    if (!flags.has('tasks')) return {}
    const now = Date.now()
    const items = build(now)
    const typed = new Map<string, string>()
    const emit = (task: BackgroundTask): void => {
      const event: ChatEvent = { streamId: 'seed-tasks', kind: 'task', task: { ...task }, conversationId: task.conversationId }
      ;(window as unknown as { __emit?: (e: ChatEvent) => void }).__emit?.(event)
    }
    const find = (taskId: string): Seeded | undefined => items.find((item) => item.task.id === taskId)
    const textOf = (item: Seeded): string => item.output(Date.now()) + (typed.get(item.task.id) ?? '')
    let settings: Record<string, unknown> | undefined

    return {
      listTasks: async (conversationId) => items.filter((item) => !conversationId || item.task.conversationId === conversationId).map((item) => ({ ...item.task })),
      stopTask: async (taskId) => {
        const item = find(taskId)
        if (!item) return { ok: false, error: `Task ${taskId} not found.` }
        const mode = flags.get('taskstop')
        if (mode === 'fail') return { ok: false, error: 'Could not terminate the process tree: spawn taskkill.exe ENOENT' }
        if (item.task.status !== 'running') return { ok: true }
        item.task.status = 'killed'
        emit(item.task)
        window.setTimeout(() => { item.task.endedAt = Date.now(); item.task.exitCode = 1; emit(item.task) }, 350)
        return mode === 'warn' ? { ok: true, error: 'Process-tree termination exited with code 128. ERROR: The process "14820" not found.' } : { ok: true }
      },
      sendTaskInput: async (taskId, input) => {
        const item = find(taskId)
        if (!item) return { ok: false, error: `Task ${taskId} not found.` }
        if (item.task.status !== 'running') return { ok: false, error: `Task ${taskId} is not running.` }
        if (input.trim() === 'fail') return { ok: false, error: `Could not write to task ${taskId} standard input: write EPIPE` }
        typed.set(taskId, `${typed.get(taskId) ?? ''}${input.endsWith('\n') ? input : `${input}\n`}`)
        return { ok: true }
      },
      readCommandOutput: async (conversationId, outputId, offset = 0, limit = 16 * 1024) => {
        const item = items.find((entry) => entry.task.outputId === outputId && entry.task.conversationId === conversationId)
        if (!item) throw new Error('Saved command output is unavailable. Older outputs may have expired.')
        const text = textOf(item)
        const truncated = flags.get('taskoutput') === 'truncated' && item.task.id === 'p_dev001'
        return pageOf(artifactOf(item, new TextEncoder().encode(text).length, truncated), text, offset, limit)
      },
      revealCommandOutput: async () => undefined,
      listShells: async () => [
        { id: 'git-bash', label: 'Git Bash', path: 'C:\\Program Files\\Git\\bin\\bash.exe', available: true },
        { id: 'pwsh', label: 'PowerShell 7', path: '', available: false },
        { id: 'powershell', label: 'Windows PowerShell', path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', available: true },
        { id: 'cmd', label: 'Command Prompt', path: 'C:\\Windows\\System32\\cmd.exe', available: true }
      ],
      // The preview keeps what the Shell setting saves, so the picker can be tried.
      updateSettings: async (patch) => {
        const { DEFAULT_SETTINGS } = await import('../../../../shared/settings')
        settings = { ...settings, ...patch }
        return {
          ...DEFAULT_SETTINGS,
          general: { ...DEFAULT_SETTINGS.general, workspacePath: SEED_WORKSPACE, recentWorkspaces: [SEED_WORKSPACE, 'C:\\Users\\dev\\code\\aurora-site'] },
          ...settings
        }
      }
    }
  }
}

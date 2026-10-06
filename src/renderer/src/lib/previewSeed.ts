import type {
  ContextUsageSnapshot,
  Conversation,
  ConversationSummary,
  LocalModelEntry,
  ModelCompatibility,
  PermissionAsk,
  PlanAsk,
  RuntimeStatus,
  SessionFileChange,
  TodoItem,
  ToolActivity,
  WorkspaceGitStatus
} from '../../../shared/ipc'
import type { MessageTranscriptBlock } from '../../../shared/messageTranscript'
import type { CompatibilityStatus, EstimateBasis, ModelInfo, ProviderConfig, Quantization, SystemProfile } from '@core/types'
import { useStore, type LiveMessage } from '../state/store'
import { seededState } from './seeds'
import { seedDiagnostics } from './seeds/diagnostics'

/**
 * Design-review seed data. Only used by the browser preview harness
 * (`vite.web.config.ts`, `?seed=1`) and never in the packaged Electron app, where
 * `window.cubex` is always present. Lets the real components render with
 * representative content so the layout can be reviewed with eyes, not guesses.
 *
 * URL flags (all optional, combined with `?seed=1`):
 *   thread       open the session that is mid-turn, waiting for a permission answer
 *   done         the same session after the turn finished
 *   pendingplan  the session is waiting for its plan to be approved instead
 *   compacted    earlier messages were summarized, so the thread shows where
 *   review       open the review panel (tab=changes|plan|details picks the tab)
 *   stream       play a bursty live answer through the real store
 */

export const SEED_WORKSPACE = 'C:\\Users\\dev\\code\\lumen-web'
const WS_DOCS = 'C:\\Users\\dev\\code\\docs-site'
const WS_ML = 'C:\\Users\\dev\\code\\ml-pipeline'

export const seedProviders: ProviderConfig[] = [
  {
    id: 'anthropic',
    kind: 'anthropic',
    name: 'Anthropic',
    accessType: 'api',
    auth: { type: 'api_key' },
    defaultModel: 'claude-opus-5-5',
    enabled: true
  },
  {
    id: 'openai',
    kind: 'openai',
    name: 'OpenAI',
    accessType: 'api',
    auth: { type: 'api_key' },
    defaultModel: 'gpt-5.5',
    enabled: true
  },
  {
    id: 'nvidia',
    kind: 'openai-compat',
    name: 'NVIDIA',
    accessType: 'api',
    auth: { type: 'api_key' },
    defaultModel: 'deepseek-ai/deepseek-r1',
    enabled: true
  },
  {
    id: 'ollama',
    kind: 'ollama',
    name: 'Ollama',
    accessType: 'local',
    auth: { type: 'none' },
    defaultModel: 'qwen3-coder:30b',
    enabled: true
  }
]

const model = (providerId: string, id: string, displayName: string, location: ModelInfo['location'], contextWindow: number, reasoning: boolean): ModelInfo => ({
  id,
  providerId,
  displayName,
  location,
  capabilities: [],
  contextWindow,
  modalities: { input: ['text', 'image'], output: ['text'] } as ModelInfo['modalities'],
  supportsTools: true,
  supportsStructuredOutput: true,
  supportsReasoning: reasoning
})

export const seedModels: Record<string, ModelInfo[]> = {
  anthropic: [
    model('anthropic', 'claude-opus-5-5', 'Claude Opus 5.5', 'cloud', 200000, true),
    model('anthropic', 'claude-sonnet-5-5', 'Claude Sonnet 5.5', 'cloud', 200000, true),
    model('anthropic', 'claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 'cloud', 200000, true)
  ],
  openai: [model('openai', 'gpt-5.5', 'GPT-5.5', 'cloud', 400000, true)],
  // A compatible endpoint reports no reasoning flag, which is exactly the case
  // the effort control has to infer. Long enough to exercise menu scrolling.
  nvidia: [
    model('nvidia', 'deepseek-ai/deepseek-r1', 'DeepSeek R1', 'cloud', 128000, false),
    model('nvidia', 'nvidia/llama-3.3-nemotron-super-49b-v1', 'Nemotron Super 49B', 'cloud', 128000, false),
    model('nvidia', 'qwen/qwen3-235b-a22b', 'Qwen3 235B A22B', 'cloud', 131072, false),
    model('nvidia', 'openai/gpt-oss-120b', 'GPT-OSS 120B', 'cloud', 131072, false),
    model('nvidia', 'moonshotai/kimi-k2-thinking', 'Kimi K2 Thinking', 'cloud', 262144, false),
    model('nvidia', 'zai-org/glm-4.6', 'GLM 4.6', 'cloud', 200000, false),
    model('nvidia', 'meta/llama-3.1-405b-instruct', 'Llama 3.1 405B', 'cloud', 128000, false),
    model('nvidia', 'meta/llama-3.1-70b-instruct', 'Llama 3.1 70B', 'cloud', 128000, false),
    model('nvidia', 'meta/llama-3.1-8b-instruct', 'Llama 3.1 8B', 'cloud', 128000, false),
    model('nvidia', 'mistralai/mistral-large-2-instruct', 'Mistral Large 2', 'cloud', 128000, false),
    model('nvidia', 'mistralai/magistral-small-2506', 'Magistral Small', 'cloud', 40000, false),
    model('nvidia', 'google/gemma-3-27b-it', 'Gemma 3 27B', 'cloud', 131072, false),
    model('nvidia', 'microsoft/phi-4-reasoning', 'Phi-4 Reasoning', 'cloud', 32768, false),
    model('nvidia', 'nvidia/nemotron-4-340b-instruct', 'Nemotron 4 340B', 'cloud', 4096, false)
  ],
  ollama: [model('ollama', 'qwen3-coder:30b', 'Qwen3 Coder 30B', 'local', 262144, false)]
}

const now = Date.now()
const min = 60_000
const hour = 60 * min
const day = 24 * hour

function summary(
  id: string,
  title: string,
  updatedAt: number,
  workspacePath: string | undefined,
  messageCount: number,
  flags: { pinned?: boolean; archived?: boolean } = {}
): ConversationSummary {
  return {
    id,
    title,
    createdAt: updatedAt - hour,
    updatedAt,
    providerId: 'anthropic',
    model: 'claude-opus-5-5',
    execution: 'cloud',
    ...(workspacePath ? { workspacePath } : {}),
    ...(flags.pinned ? { pinned: true } : {}),
    ...(flags.archived ? { archived: true } : {}),
    messageCount
  }
}

export const seedConversations: ConversationSummary[] = [
  summary('c1', 'Retry uploads on 429', now - 20_000, SEED_WORKSPACE, 2),
  summary('c2', 'Fix flaky checkout test', now - 2 * min, SEED_WORKSPACE, 14),
  summary('c3', 'Migrate to Vite 7', now - 2 * hour, SEED_WORKSPACE, 31),
  summary('c4', 'Dark mode tokens', now - 3 * day, SEED_WORKSPACE, 18),
  summary('d1', 'Rewrite the install guide', now - 26 * hour, WS_DOCS, 22),
  summary('d2', 'Fix broken anchors', now - 3 * day, WS_DOCS, 9),
  summary('d3', 'Add a changelog page', now - 6 * day, WS_DOCS, 12),
  summary('m1', 'Profile the data loader', now - 5 * hour, WS_ML, 27),
  summary('n1', 'Explain Rust lifetimes', now - 4 * hour, undefined, 6),
  summary('a1', 'Old spike, abandoned SSE parser', now - 20 * day, SEED_WORKSPACE, 7, { archived: true })
]

// ---------------------------------------------------------------------------
// The story: retry uploads on 429, as far as it got when the command needs a decision.
// ---------------------------------------------------------------------------

const BACKOFF_DIFF = [
  '+export interface BackoffOptions { retries: number; baseMs: number; maxMs?: number }',
  '+',
  '+const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))',
  '+',
  '+/** Retry `task` with exponential backoff and jitter. `delayFor` returns a server-requested delay in ms, or null to give up. */',
  '+export async function withBackoff<T>(',
  '+  task: () => Promise<T>,',
  '+  delayFor: (error: unknown) => number | null,',
  '+  { retries, baseMs, maxMs = 8000 }: BackoffOptions',
  '+): Promise<T> {',
  '+  for (let attempt = 0; ; attempt++) {',
  '+    try {',
  '+      return await task()',
  '+    } catch (error) {',
  '+      const requested = delayFor(error)',
  '+      if (requested === null || attempt >= retries) throw error',
  '+      const backoff = Math.min(maxMs, baseMs * 2 ** attempt)',
  '+      await sleep(Math.max(requested, backoff * (0.5 + Math.random() / 2)))',
  '+    }',
  '+  }',
  '+}'
].join('\n')

const CLIENT_DIFF = [
  " import { fetchWithAuth } from './auth'",
  "+import { withBackoff } from './backoff'",
  " import { UploadError, type Chunk } from './types'",
  ' ',
  ' export async function uploadChunk(chunk: Chunk) {',
  '-  const res = await put(chunk)',
  '-  if (!res.ok) throw new UploadError(res.status)',
  '-  return res.json()',
  '+  return withBackoff(async () => {',
  '+    const res = await put(chunk)',
  "+    const wait = res.headers.get('retry-after')",
  '+    if (!res.ok) throw new UploadError(res.status, wait)',
  '+    return res.json()',
  '+  }, retryAfter, { retries: 4, baseMs: 250 })',
  ' }',
  '+',
  '+function retryAfter(error: unknown): number | null {',
  '+  if (!(error instanceof UploadError)) return null',
  '+  if (error.status !== 429 && error.status < 500) return null',
  '+  const seconds = Number(error.retryAfter)',
  '+  return Number.isFinite(seconds) ? seconds * 1000 : 0',
  '+}',
  '@⋯ 34 unchanged lines'
].join('\n')

const TEST_DIFF = [
  " import { describe, expect, it, vi } from 'vitest'",
  " import { uploadChunk } from './client'",
  '@⋯ 12 unchanged lines',
  " describe('uploadChunk', () => {",
  "+  it('retries a 429 and honors Retry-After', async () => {",
  '+    vi.useFakeTimers()',
  "+    const put = vi.fn().mockResolvedValueOnce(reply(429, { 'retry-after': '2' })).mockResolvedValueOnce(reply(200))",
  '+    const done = uploadChunk(chunk, { put })',
  '+    await vi.advanceTimersByTimeAsync(2000)',
  '+    await expect(done).resolves.toBeDefined()',
  '+    expect(put).toHaveBeenCalledTimes(2)',
  '+  })',
  '+',
  "+  it('gives up after four retries', async () => {",
  '+    const put = vi.fn().mockResolvedValue(reply(503))',
  '+    await expect(uploadChunk(chunk, { put, baseMs: 0 })).rejects.toThrow(UploadError)',
  '+    expect(put).toHaveBeenCalledTimes(5)',
  '+  })',
  '+',
  "+  it('does not retry a 400', async () => {",
  '+    const put = vi.fn().mockResolvedValue(reply(400))',
  '+    await expect(uploadChunk(chunk, { put })).rejects.toThrow(UploadError)',
  '+    expect(put).toHaveBeenCalledTimes(1)',
  '+  })',
  ' })'
].join('\n')

function count(diff: string): { added: number; removed: number } {
  const lines = diff.split('\n')
  return { added: lines.filter((line) => line[0] === '+').length, removed: lines.filter((line) => line[0] === '-').length }
}

const tool = (id: string, name: string, title: string, extra: Partial<ToolActivity> = {}): MessageTranscriptBlock => ({
  type: 'tool',
  tool: { id, name, phase: 'done', title, ...extra }
})

function storyBlocks(finished: boolean): MessageTranscriptBlock[] {
  return [
    {
      type: 'reasoning',
      text: 'The failure is in `uploadChunk`. Any non-OK response throws `UploadError` and nothing retries it. A backoff helper that takes a delay function keeps the policy in one place: 429 and 5xx retry, other 4xx fail at once. `Retry-After` is seconds or a date, so it has to be parsed before it is trusted.',
      durationMs: 6200
    },
    {
      type: 'text',
      text: 'The failure is in `uploadChunk`: any non-OK response throws `UploadError` and nothing retries it. I’ll add a small backoff helper, carry the status and `Retry-After` on the error, and retry only 429 and 5xx.'
    },
    tool('t1', 'read_file', 'Read src/upload/client.ts'),
    tool('t2', 'read_file', 'Read src/upload/client.test.ts'),
    tool('t3', 'read_file', 'Read src/upload/types.ts'),
    tool('t4', 'todo_write', 'Update the plan'),
    tool('t5', 'write_file', 'Write src/upload/backoff.ts', { ...count(BACKOFF_DIFF), diff: BACKOFF_DIFF, ...seedDiagnostics('t5') }),
    tool('t6', 'edit_file', 'Edit src/upload/client.ts', { ...count(CLIENT_DIFF), diff: CLIENT_DIFF, ...seedDiagnostics('t6') }),
    tool('t7', 'edit_file', 'Edit src/upload/client.test.ts', { ...count(TEST_DIFF), diff: TEST_DIFF, ...seedDiagnostics('t7') }),
    tool('t8', 'run_command', 'Run npm test -- upload', finished ? { detail: 'Exit 0, 5 tests passed' } : { phase: 'running' }),
    ...(finished ? [{
      type: 'text' as const,
      text: 'Uploads now retry **429** and **5xx** with exponential backoff and jitter, capped at 8 seconds, and wait for `Retry-After` when the server sends it. A **400** still fails on the first attempt.\n\n| Case | Result |\n| --- | --- |\n| 429 with `Retry-After: 2` | waits 2 s, then succeeds |\n| 503 five times | gives up after four retries |\n| 400 | fails immediately |\n\nAll five upload tests pass.'
    }] : [])
  ]
}

export function seedStory(finished: boolean): LiveMessage[] {
  return [
    {
      id: 'm1',
      role: 'user',
      text: 'Uploads drop files when the API answers 429. Add retry with exponential backoff, respect Retry-After, and cover it with tests.',
      createdAt: now - 70_000
    },
    {
      id: 'm2',
      role: 'assistant',
      text: '',
      createdAt: now - 60_000,
      streaming: !finished,
      blocks: storyBlocks(finished),
      toolCalls: storyBlocks(finished).flatMap((block) => (block.type === 'tool' ? [block.tool] : []))
    }
  ]
}

/** Messages from before the request above, left out of new requests once the task is summarized. */
function earlierTurns(): LiveMessage[] {
  const reply = (id: string, text: string, createdAt: number): LiveMessage => ({ id, role: 'assistant', text, createdAt, blocks: [{ type: 'text', text }] })
  return [
    { id: 'e1', role: 'user', text: 'The upload client loses files when the network blips. Where would a retry go?', createdAt: now - 9 * min },
    reply('e2', 'Nowhere yet. `uploadChunk` in `src/upload/client.ts` sends each chunk once and throws `UploadError` on any non-OK response, so one failure aborts the whole upload.', now - 9 * min + 4_000),
    { id: 'e3', role: 'user', text: 'Keep it small, add no dependencies, and put tests next to the code.', createdAt: now - 6 * min },
    reply('e4', 'Understood. The change stays inside `src/upload/` and uses the vitest setup that is already there.', now - 6 * min + 3_000)
  ]
}

/** What the summary of those earlier messages says, as the main process writes it. */
const seedSummary = [
  '## Goal',
  'Make the upload client survive transient failures. Files are lost today because one failed chunk aborts the upload.',
  '',
  '## Decisions',
  '- Retry only 429 and 5xx. Other 4xx fail on the first attempt.',
  '- Keep the retry policy in one helper instead of inlining it in each caller.',
  '',
  '## Files',
  '- `src/upload/client.ts` sends chunks and throws `UploadError`.',
  '- `src/upload/types.ts` defines `UploadError`.',
  '',
  '## Preferences',
  'Small diffs, no new dependencies, tests next to the code.'
].join('\n')

export const seedTodos = (finished: boolean): TodoItem[] => [
  { content: 'Add a `withBackoff` helper with jitter, capped at 8 s', status: 'completed' },
  { content: 'Carry the status and `Retry-After` on `UploadError`', status: 'completed' },
  { content: 'Retry 429 and 5xx only; other 4xx fail on the first attempt', status: 'completed' },
  { content: 'Cover 429, `Retry-After`, giving up, and 400 in tests', status: 'completed' },
  { content: 'Run `npm test -- upload`', status: finished ? 'completed' : 'in_progress', activeForm: 'Running `npm test -- upload`' }
]

export const seedAsk: PermissionAsk = {
  id: 'ask-1',
  toolName: 'run_command',
  title: 'Run npm test -- upload',
  detail: '$ npm test -- upload\n(timeout 120000 ms)',
  rule: { tool: 'run_command', pattern: 'npm test', label: 'npm test' }
}

export const seedPlan: PlanAsk = {
  id: 'plan-1',
  title: 'Retry uploads on 429',
  conversationId: 'c1',
  status: 'pending',
  createdAt: now - 80_000,
  plan: [
    '# Retry uploads on 429',
    '',
    'Uploads fail permanently when the API answers 429. The fix keeps the retry policy in one helper.',
    '',
    '## Changes',
    '',
    '1. Add `src/upload/backoff.ts` with `withBackoff`: exponential delay, jitter, capped at 8 s.',
    '2. Carry the HTTP status and `Retry-After` on `UploadError`.',
    '3. Retry 429 and 5xx only. Other 4xx fail on the first attempt.',
    '4. Cover 429, `Retry-After`, giving up, and 400 in `client.test.ts`.',
    '',
    '## Verification',
    '',
    'Run `npm test -- upload`.'
  ].join('\n')
}

/** Net changes of the story, as the main process would report them. Revert removes entries. */
const seedChangeList: SessionFileChange[] = [
  { path: 'src/upload/backoff.ts', status: 'added', ...count(BACKOFF_DIFF), diff: BACKOFF_DIFF, updatedAt: now - 52_000 },
  { path: 'src/upload/client.ts', status: 'modified', ...count(CLIENT_DIFF), diff: CLIENT_DIFF, updatedAt: now - 40_000 },
  { path: 'src/upload/client.test.ts', status: 'modified', ...count(TEST_DIFF), diff: TEST_DIFF, updatedAt: now - 28_000 }
]

export function seedChanges(): SessionFileChange[] {
  return seedChangeList.map((change) => ({ ...change }))
}

export function seedRevert(paths?: string[]): { restored: string[]; skipped: Array<{ path: string; reason: string }> } {
  // `revert=error` fails outright and `revert=skip` restores the first file only, to review both notices.
  if (/[?&]revert=error\b/.test(location.search)) throw new Error('Cubex could not read its saved copy of src/upload/client.ts. Close any program that has the file open and try again.')
  const partial = /[?&]revert=skip\b/.test(location.search)
  const targets = paths ?? seedChangeList.map((change) => change.path)
  const restored: string[] = []
  const skipped: Array<{ path: string; reason: string }> = []
  for (const path of targets) {
    const index = seedChangeList.findIndex((change) => change.path === path)
    if (index < 0) continue
    if (partial && restored.length > 0) {
      skipped.push({ path, reason: 'It changed outside Cubex after the edit, so it was left as it is.' })
      continue
    }
    seedChangeList.splice(index, 1)
    restored.push(path)
  }
  return { restored, skipped }
}

export const seedGit: WorkspaceGitStatus = { isRepo: true, branch: 'main', head: 'a1b2c3d', ahead: 0, behind: 0, changedFiles: 3 }

/** A commit in the seeded repository: fewer uncommitted files, HEAD moves and one commit is ready to push. */
export function seedCommitted(files: number): void {
  seedGit.changedFiles = Math.max(0, seedGit.changedFiles - files)
  seedGit.head = 'e4f7a21'
  seedGit.ahead = (seedGit.ahead ?? 0) + 1
}

/** What a failing pre-commit hook returns, for the commit sheet's error state (`commit=fail`). */
export const seedCommitFailure = [
  'The pre-commit hook rejected the commit.',
  '',
  '> lint-staged',
  '[STARTED] Running tasks for staged files',
  '[FAILED] eslint --max-warnings=0',
  '',
  'src/upload/client.ts',
  "  41:9  error  'attempt' is assigned a value but never used  @typescript-eslint/no-unused-vars",
  '',
  '1 problem (1 error, 0 warnings)'
].join('\n')

/** What the context meter shows once a request has been assembled. */
export const seedContext: ContextUsageSnapshot = {
  sections: [
    { id: 'system', label: 'System instructions', estimatedTokens: 4200 },
    { id: 'conversation', label: 'Conversation', estimatedTokens: 21800, count: 2 },
    { id: 'toolResults', label: 'Tool results', estimatedTokens: 9400, count: 8 },
    { id: 'tools', label: 'Tool definitions', estimatedTokens: 2600, count: 14 }
  ],
  estimatedTokens: 38000,
  // Anchored: the provider reported 37412 for the last request, and a little
  // has been appended since, so the meter shows a measured number not a guess.
  contextTokens: 39180,
  contextBasis: 'anchored',
  anchorTokens: 37412,
  appendedTokens: 1768,
  contextWindow: 200000,
  inputBudget: 182000,
  outputReserve: 16000,
  outputReserveKnown: true,
  measuredInputTokens: 37412,
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  updatedAt: now
}

/** Representative workspace file list for the @-mention popup in preview. */
export const seedFiles: Array<{ path: string }> = [
  { path: 'package.json' },
  { path: 'README.md' },
  { path: 'src/upload/backoff.ts' },
  { path: 'src/upload/client.ts' },
  { path: 'src/upload/client.test.ts' },
  { path: 'src/upload/types.ts' },
  { path: 'src/upload/auth.ts' },
  { path: 'src/checkout/cart.ts' },
  { path: 'src/checkout/cart.test.ts' },
  { path: 'vite.config.ts' },
  { path: 'tsconfig.json' }
]

export function seedConversation(id: string): Conversation {
  const s = seedConversations.find((c) => c.id === id) ?? seedConversations[0]!
  return {
    id: s.id,
    title: s.title,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    providerId: s.providerId,
    model: s.model,
    execution: s.execution,
    ...(s.workspacePath ? { workspacePath: s.workspacePath } : {}),
    messages: seedStory(false).map((m) => ({ id: m.id, role: m.role, text: m.text, createdAt: m.createdAt }))
  }
}

// ---------------------------------------------------------------------------
// Hardware, local runtimes and installed models
// ---------------------------------------------------------------------------

const GB = 1024 ** 3
const MB = 1024 ** 2

/** A Windows desktop with a mid-range GPU: enough to land on every fit verdict. */
export const seedHardware: SystemProfile = {
  cpu: { model: 'AMD Ryzen 7 7700X 8-Core Processor', vendor: 'AuthenticAMD', architecture: 'x64', physicalCores: 8, logicalThreads: 16, baseClockGHz: 4.5, simd: ['avx2', 'avx512'] },
  memory: { totalBytes: 32 * GB, availableBytes: 19.4 * GB, bandwidthGBs: 83 },
  gpus: [{ model: 'NVIDIA GeForce RTX 4070', vendor: 'nvidia', vramBytes: 12 * GB, driverVersion: '561.09', backends: ['cuda', 'vulkan'] }],
  storage: { totalBytes: 1000 * GB, freeBytes: 412 * GB, modelsDir: 'C:\\Users\\dev\\.ollama\\models', isSSD: true },
  os: { platform: 'win32', distro: 'Microsoft Windows 11 Pro', release: '10.0.22631', arch: 'x64' },
  accelerators: ['cuda', 'vulkan', 'cpu'],
  detectedAt: now
}

/** `?runtime=down` shows Ollama unreachable, which is what a machine without it running reports. */
export function seedRuntimes(down: boolean): RuntimeStatus[] {
  return down
    ? [{ id: 'ollama', name: 'Ollama', installed: false, running: false, endpoint: 'http://127.0.0.1:11434', error: 'Ollama not reachable at http://127.0.0.1:11434' }]
    : [{ id: 'ollama', name: 'Ollama', installed: true, running: true, version: '0.5.7', endpoint: 'http://127.0.0.1:11434' }]
}

export const seedLocalModels: LocalModelEntry[] = [
  { id: 'qwen3-coder:30b', name: 'qwen3-coder:30b', runtime: 'ollama', sizeBytes: 18.6 * GB, quantization: 'Q4_K_M', parameterCount: 30, family: 'qwen3moe' },
  { id: 'llama3.1:8b', name: 'llama3.1:8b', runtime: 'ollama', sizeBytes: 4.9 * GB, quantization: 'Q4_K_M', parameterCount: 8, family: 'llama' },
  { id: 'nomic-embed-text:latest', name: 'nomic-embed-text:latest', runtime: 'ollama', sizeBytes: 274 * MB, quantization: 'F16', family: 'nomic-bert' }
]

function fit(
  id: string,
  displayName: string,
  parameterCount: number,
  quantization: Quantization,
  status: CompatibilityStatus,
  reason: string,
  memoryGB: [number, number],
  tokensPerSecond: [number, number],
  confidence: 'low' | 'medium' | 'high',
  basis: EstimateBasis,
  gpuFraction: number
): ModelCompatibility {
  const range = (low: number, high: number, unit: string) => ({ low, high, unit })
  const total = range(memoryGB[0] * GB, memoryGB[1] * GB, 'bytes')
  return {
    model: { ...model('ollama', id, displayName, 'local', 131072, false), parameterCount, quantization },
    status,
    reason,
    gpuFraction,
    memory: { totalBytes: total, weightsBytes: total, kvCacheBytes: range(0, 0, 'bytes'), overheadBytes: range(0, 0, 'bytes'), basis, notes: [] },
    speed: { tokensPerSecond: range(tokensPerSecond[0], tokensPerSecond[1], 'tok/s'), basis, confidence, notes: [] }
  }
}

export function seedCompatibility(): ModelCompatibility[] {
  return [
    fit('llama3.1:8b', 'Llama 3.1 8B Instruct', 8, 'Q4_K_M', 'fits_vram', 'The whole model fits in 12 GB of VRAM with room for a 16K context.', [5.4, 6.4], [62, 88], 'high', 'measured', 1),
    fit('qwen3-coder:30b', 'Qwen3 Coder 30B', 30, 'Q4_K_M', 'offload_required', 'Needs about 19 GB. 12 GB of VRAM holds 62% of it and the rest runs from system RAM.', [17.8, 21.2], [14, 22], 'medium', 'theoretical', 0.62),
    fit('gemma3:27b', 'Gemma 3 27B', 27, 'Q4_K_M', 'may_be_slow', 'Fits only with most layers in system RAM, so generation is limited by memory bandwidth.', [16.5, 19.8], [5, 9], 'low', 'theoretical', 0.4),
    fit('llama3.1:70b', 'Llama 3.1 70B Instruct', 70, 'Q4_K_M', 'insufficient_memory', 'Needs about 43 GB. This PC has 32 GB of RAM and 12 GB of VRAM.', [41, 46], [0, 0], 'high', 'theoretical', 0)
  ]
}

/** Put the store into the state a URL flag asks for. Runs once, after the initial loads. */
export function applyPreviewSeed(search: string): void {
  const flags = new URLSearchParams(search)
  const finished = flags.has('done')
  const planWaits = flags.has('pendingplan') && !finished
  const summarized = flags.has('compacted')
  const approved: PlanAsk = { ...seedPlan, status: 'approved', decision: 'default', resolvedAt: now - 55_000 }
  const state: Record<string, unknown> = {}
  if (flags.has('thread') || finished || planWaits || summarized) {
    Object.assign(state, {
      activeConversation: {
        ...seedConversation('c1'),
        ...(summarized ? { contextStartMessageId: 'm1', contextSummary: seedSummary, contextSummaryAt: now - 5 * min } : {})
      },
      liveMessages: summarized ? [...earlierTurns(), ...seedStory(finished)] : seedStory(finished),
      todos: seedTodos(finished),
      view: 'chat',
      status: finished ? 'idle' : 'awaiting_input',
      statusDetail: finished ? undefined : planWaits ? 'Plan ready for review' : 'Permission required',
      pendingPermission: finished || planWaits ? undefined : seedAsk,
      pendingPlan: planWaits ? seedPlan : undefined,
      activePlan: planWaits ? seedPlan : approved,
      plans: [planWaits ? seedPlan : approved],
      contextUsage: seedContext,
      // Another session is mid-turn, so the sidebar shows both identity glyphs.
      conversationRuns: { c2: { status: 'running_tool' } }
    })
  }
  if (flags.has('review') || flags.has('tab')) {
    const tab = flags.get('tab')
    Object.assign(state, { panelOpen: true, panelTab: tab && ['plan', 'details', 'tasks', 'files'].includes(tab) ? tab : 'changes', reviewFile: 'src/upload/client.ts' })
  }
  Object.assign(state, seededState(flags))
  useStore.setState(state as never)
}

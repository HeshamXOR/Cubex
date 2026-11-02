import type { PermissionAsk, ToolActivity } from '../../../../shared/ipc'
import type { DelegateActivity } from '../../../../shared/peers'
import type { MessageTranscriptBlock } from '../../../../shared/messageTranscript'
import type { PreviewSeed } from './index'

/**
 * A task handed to another agent, in the thread. Add `thread=1` for the chat itself.
 *   ?seed=1&thread=1&delegate=done          Claude Code finished: steps, three files (one not kept) and its report
 *   ?seed=1&thread=1&delegate=running       it is working: the step in progress shows on the row
 *   ?seed=1&thread=1&delegate=task          the question about handing the task over
 *   ?seed=1&thread=1&delegate=edit          it asks to edit a file, with the change
 *   ?seed=1&thread=1&delegate=command       it asks to run a command
 *   ?seed=1&thread=1&delegate=review        a task that only reads, finished
 *   ?seed=1&thread=1&delegate=failed        it could not do the task
 *   ?seed=1&thread=1&delegate=cancelled     the turn was stopped while it worked
 */

const MIN = 60_000
const now = Date.now()

const TASK = 'Fix the flaky test in src/checkout/cart.test.ts. It fails about one run in five on the "applies the coupon once" case, which looks like a timing problem. Keep the change to the test and the code it covers, and run the checkout tests when you are done.'

const STEPS: DelegateActivity['steps'] = [
  { title: 'Read src/checkout/cart.test.ts', kind: 'read', state: 'done' },
  { title: 'Read src/checkout/cart.ts', kind: 'read', state: 'done' },
  { title: 'Search for setTimeout in src/checkout', kind: 'search', state: 'done' },
  { title: 'Edit src/checkout/cart.test.ts', kind: 'edit', state: 'done' },
  { title: 'Run npx vitest run src/checkout', kind: 'execute', state: 'done' }
]
const FILES: DelegateActivity['files'] = [
  { path: 'src/checkout/cart.test.ts', change: 'edited', tracked: true },
  { path: 'src/checkout/__snapshots__/cart.test.ts.snap', change: 'deleted', tracked: true },
  { path: 'coverage/lcov.info', change: 'created', tracked: false }
]

const done = (over: Partial<DelegateActivity> = {}): DelegateActivity => ({
  name: 'Claude Code', role: 'implement', status: 'done', seconds: 187, asked: TASK, steps: STEPS, files: FILES, ...over
})

/** A task that has not finished: its time is not known yet, so the row counts it. */
const live = (status: 'working' | 'waiting', steps: DelegateActivity['steps'], files: DelegateActivity['files'] = []): DelegateActivity => ({
  name: 'Claude Code', role: 'implement', status, asked: TASK, steps, files
})
const running = (title: string, kind: string): DelegateActivity['steps'][number] => ({ title, kind, state: 'running' })

const REPORT = [
  'The test raced a real `setTimeout` in `applyCoupon`: the debounce fired after the assertion about one run in five. I replaced the timer with fake timers and advanced them explicitly, so the order no longer depends on the machine.',
  '',
  '- `cart.test.ts`: uses `vi.useFakeTimers()` and `vi.advanceTimersByTime(250)` before the assertion.',
  '- The snapshot file is gone because the test no longer needs it.',
  '',
  'I ran `npx vitest run src/checkout` ten times in a row: 14 passed each time.'
].join('\n')

const tool = (phase: ToolActivity['phase'], delegate: DelegateActivity, over: Partial<ToolActivity> = {}): ToolActivity => ({
  id: 'd1', name: 'delegate_task', phase, title: 'Delegate to Claude Code', delegate, ...over
})

const message = (blocks: MessageTranscriptBlock[], streaming: boolean): unknown => ({
  id: 'a-delegate', role: 'assistant', text: '', createdAt: now - 4 * MIN, streaming,
  blocks, toolCalls: blocks.flatMap((block) => (block.type === 'tool' ? [block.tool] : []))
})

const thread = (blocks: MessageTranscriptBlock[], streaming: boolean): unknown[] => [
  { id: 'u-delegate', role: 'user', text: 'The checkout cart test is flaky. Have Claude Code fix it and run the checkout tests.', createdAt: now - 5 * MIN },
  message(blocks, streaming)
]

const lead: MessageTranscriptBlock = { type: 'text', text: 'I will hand the flaky test to Claude Code, then read what it changed before I tell you it is fixed.' }

const taskAsk: PermissionAsk = {
  id: 'ask-task', toolName: 'delegate_task', title: 'Delegate to Claude Code',
  detail: `To Claude Code (implement):\n\n${TASK}`,
  risks: [
    'Starts "npx --yes @agentclientprotocol/claude-agent-acp@0.89.0" on this computer. The first time, npx downloads the package from npm.',
    'It works in this project and can ask to change files and run commands. Your permission mode decides what you are asked, and it cannot change anything outside the project.'
  ]
}
const editAsk: PermissionAsk = {
  id: 'ask-edit', toolName: 'delegate_task', title: 'Claude Code wants to edit src/checkout/cart.test.ts',
  detail: ' import { describe, expect, it, vi } from \'vitest\'\n@40 unchanged lines\n-  await new Promise((resolve) => setTimeout(resolve, 250))\n+  vi.useFakeTimers()\n+  vi.advanceTimersByTime(250)\n   expect(cart.coupons).toEqual([\'SPRING\'])',
  delegate: { agent: 'Claude Code', action: 'edit', target: 'src/checkout/cart.test.ts' }
}
const commandAsk: PermissionAsk = {
  id: 'ask-run', toolName: 'delegate_task', title: 'Claude Code wants to run a command',
  detail: 'npx vitest run src/checkout', risks: ['Cubex cannot limit what a command touches.'],
  delegate: { agent: 'Claude Code', action: 'run', command: 'npx vitest run src/checkout' }
}

interface Scenario {
  blocks: MessageTranscriptBlock[]
  streaming: boolean
  ask?: PermissionAsk
  status: string
}

const scenarios: Record<string, () => Scenario> = {
  done: () => ({
    blocks: [lead, { type: 'tool', tool: tool('done', done(), { detail: REPORT }) }, { type: 'text', text: 'Claude Code fixed the timing in the test and ran the checkout tests ten times. I read the diff: only `cart.test.ts` changed, plus a coverage file it generated, which is not part of the project.' }],
    streaming: false, status: 'idle'
  }),
  running: () => ({
    blocks: [lead, { type: 'tool', tool: { id: 'd1', name: 'delegate_task', phase: 'running', title: 'Delegate to Claude Code', delegate: live('working', [...STEPS.slice(0, 3), running('Edit src/checkout/cart.test.ts', 'edit')]) } }],
    streaming: true, status: 'running_tool'
  }),
  task: () => ({
    blocks: [lead, { type: 'tool', tool: { id: 'd1', name: 'delegate_task', phase: 'running', title: 'Delegate to Claude Code' } }],
    streaming: true, ask: taskAsk, status: 'awaiting_input'
  }),
  edit: () => ({
    blocks: [lead, { type: 'tool', tool: { id: 'd1', name: 'delegate_task', phase: 'running', title: 'Delegate to Claude Code', delegate: live('waiting', [...STEPS.slice(0, 3), running('Edit src/checkout/cart.test.ts', 'edit')]) } }],
    streaming: true, ask: editAsk, status: 'awaiting_input'
  }),
  command: () => ({
    blocks: [lead, { type: 'tool', tool: { id: 'd1', name: 'delegate_task', phase: 'running', title: 'Delegate to Claude Code', delegate: live('waiting', [...STEPS.slice(0, 4), running('Run npx vitest run src/checkout', 'execute')], [FILES[0]!]) } }],
    streaming: true, ask: commandAsk, status: 'awaiting_input'
  }),
  review: () => ({
    blocks: [lead, {
      type: 'tool',
      tool: tool('done', done({ role: 'review', seconds: 64, files: [], asked: 'Review the retry helper in src/upload/retry.ts for races and for the cases where Retry-After is missing.', steps: [{ title: 'Read src/upload/retry.ts', kind: 'read', state: 'done' }, { title: 'Read src/upload/client.ts', kind: 'read', state: 'done' }] }), {
        detail: 'Two things to change.\n\n1. `retry.ts` reads `Retry-After` as seconds only. The header may be an HTTP date.\n2. The delay is not capped, so a server that answers `3600` stalls the upload for an hour.\n\nNothing else raced.'
      })
    }, { type: 'text', text: 'The review found two real problems. I will fix both and add a test for each.' }],
    streaming: false, status: 'idle'
  }),
  failed: () => ({
    blocks: [lead, {
      type: 'tool',
      tool: tool('error', done({ status: 'failed', seconds: 9, files: [], steps: [] }), {
        detail: 'Claude Code is not signed in. Sign in under Settings, Other agents, then hand it the task again.'
      })
    }, { type: 'text', text: 'Claude Code could not start because it is signed out, so nothing changed. Sign in under Settings and I will try again.' }],
    streaming: false, status: 'idle'
  }),
  cancelled: () => ({
    blocks: [lead, {
      type: 'tool',
      tool: tool('error', done({ status: 'cancelled', seconds: 41, steps: [...STEPS.slice(0, 3), running('Edit src/checkout/cart.test.ts', 'edit')], files: [FILES[0]!] }), {
        detail: 'The task was cancelled after 41 seconds.'
      })
    }],
    streaming: false, status: 'idle'
  })
}

export const seed: PreviewSeed = {
  state: (flags) => {
    const name = flags.get('delegate')
    const build = name ? scenarios[name] : undefined
    if (!build) return undefined
    const scenario = build()
    return {
      liveMessages: thread(scenario.blocks, scenario.streaming),
      status: scenario.status,
      statusDetail: scenario.ask ? 'Permission required' : undefined,
      pendingPermission: scenario.ask,
      todos: []
    }
  }
}

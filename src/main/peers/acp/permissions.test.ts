import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { canonicalPath, decidePermission, isInside } from './permissions'

let base: string
let root: string
let outside: string

beforeAll(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'cubex-acp-policy-')))
  root = join(base, 'project')
  outside = join(base, 'elsewhere')
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(root, 'src', 'a.ts'), 'export {}')
  writeFileSync(join(outside, 'secret.txt'), 'secret')
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

const OPTIONS = [
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'no', name: 'Reject', kind: 'reject_once' },
  { optionId: 'never', name: 'Always reject', kind: 'reject_always' }
]
const ask = (kind: string | undefined, locations?: unknown, options: unknown = OPTIONS): unknown => ({ sessionId: 's', toolCall: { toolCallId: 't', ...(kind ? { kind } : {}), ...(locations !== undefined ? { locations } : {}) }, options })
const chose = (decision: ReturnType<typeof decidePermission>): string => (decision.reply.outcome.outcome === 'selected' ? decision.reply.outcome.optionId : 'cancelled')

describe('what an agent may look at', () => {
  it.each(['read', 'search', 'think'])('allows %s, once, without a place', (kind) => {
    const decision = decidePermission(ask(kind), root)
    expect(decision.allow).toBe(true)
    expect(chose(decision)).toBe('once')
  })

  it('allows reading a file inside the folder, by an absolute or a relative path', () => {
    expect(chose(decidePermission(ask('read', [{ path: join(root, 'src', 'a.ts') }]), root))).toBe('once')
    expect(chose(decidePermission(ask('read', [{ path: join('src', 'a.ts') }]), root))).toBe('once')
    expect(chose(decidePermission(ask('search', [{ path: root }]), root))).toBe('once')
  })

  it('allows a place that does not exist yet inside the folder', () => {
    expect(decidePermission(ask('read', [{ path: join(root, 'src', 'new', 'file.ts') }]), root).allow).toBe(true)
  })

  it('refuses a place outside the folder, however it is written', () => {
    for (const path of [join(outside, 'secret.txt'), join('..', 'elsewhere', 'secret.txt'), join(root, '..', 'elsewhere'), join(root, 'missing', '..', '..', 'elsewhere', 'secret.txt'), base]) {
      const decision = decidePermission(ask('read', [{ path }]), root)
      expect(decision.allow, path).toBe(false)
      expect(chose(decision)).toBe('no')
    }
  })

  it('refuses when any one of several places is outside', () => {
    const decision = decidePermission(ask('read', [{ path: join(root, 'src', 'a.ts') }, { path: join(outside, 'secret.txt') }]), root)
    expect(decision.allow).toBe(false)
  })

  it('refuses a place that is not a path', () => {
    for (const locations of [[{}], [{ path: '' }], [{ path: 5 }], [null], ['x']]) {
      expect(decidePermission(ask('read', locations), root).allow).toBe(false)
    }
  })

  it('does not follow a link out of the folder', () => {
    const link = join(root, 'link')
    try {
      symlinkSync(outside, link, 'junction')
    } catch {
      return // links cannot be made here
    }
    try {
      expect(isInside(join(link, 'secret.txt'), root)).toBe(false)
      expect(decidePermission(ask('read', [{ path: join(link, 'secret.txt') }]), root).allow).toBe(false)
      // Where the system follows a link before "..", "link/.." is where the link points, not where it looks: this is
      // next to the link's target, outside the folder. Windows tidies ".." away first, so there it is inside, as for the agent.
      if (process.platform !== 'win32') expect(isInside(`${link}${sep}..${sep}elsewhere${sep}secret.txt`, root)).toBe(false)
    } finally {
      unlinkSync(link)
    }
  })
})

describe('what an agent may not do', () => {
  it.each(['edit', 'delete', 'move', 'execute', 'fetch', 'switch_mode', 'other', 'something_new', undefined])('refuses %s, and says no with the agent\'s own choice', (kind) => {
    const decision = decidePermission(ask(kind, [{ path: join(root, 'src', 'a.ts') }]), root)
    expect(decision.allow).toBe(false)
    expect(chose(decision)).toBe('no')
  })

  it('never picks an option that is remembered', () => {
    // Allowing always would be written to the person\'s own settings for the agent.
    expect(chose(decidePermission(ask('read', undefined, [{ optionId: 'always', name: 'Always', kind: 'allow_always' }, { optionId: 'no', name: 'No', kind: 'reject_once' }]), root))).toBe('cancelled')
    expect(chose(decidePermission(ask('edit', undefined, [{ optionId: 'once', name: 'Yes', kind: 'allow_once' }, { optionId: 'never', name: 'Never', kind: 'reject_always' }]), root))).toBe('cancelled')
  })

  it('cancels when the agent offers nothing to choose', () => {
    expect(chose(decidePermission(ask('read', undefined, []), root))).toBe('cancelled')
    expect(chose(decidePermission(ask('edit', undefined, null), root))).toBe('cancelled')
  })

  it('refuses a request that is not shaped like one', () => {
    for (const params of [null, undefined, 'x', 4, [], {}, { toolCall: 'x' }]) {
      const decision = decidePermission(params, root)
      expect(decision.allow).toBe(false)
      expect(chose(decision)).toBe('cancelled')
    }
  })
})

describe('real paths', () => {
  it('resolves the part that exists and keeps the rest', () => {
    expect(canonicalPath(join(root, 'src', 'a.ts'))).toBe(join(root, 'src', 'a.ts'))
    expect(canonicalPath(join(root, 'src', 'nothing', 'here.ts'))).toBe(join(root, 'src', 'nothing', 'here.ts'))
  })
})

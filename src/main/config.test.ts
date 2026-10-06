import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppSettings } from '@shared/settings'

const paths = vi.hoisted(() => ({ file: '' }))
vi.mock('./paths', () => ({ configPath: () => paths.file }))

let folder = ''
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'cubex-config-'))
  paths.file = join(folder, 'config.json')
  // The module keeps the settings it loaded; each test starts from the file it just wrote.
  vi.resetModules()
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

const load = async (): Promise<typeof import('./config')> => import('./config')
const stored = (): { ai: AppSettings['ai'] } => JSON.parse(readFileSync(paths.file, 'utf8')) as { ai: AppSettings['ai'] }

describe('compaction and budget settings', () => {
  it('start with automatic summarizing at 80 percent, pruning on, and no caps', async () => {
    const { getSettings } = await load()
    const { ai } = getSettings()
    expect(ai.compaction).toEqual({ auto: true, threshold: 0.8, prune: true })
    expect(ai.autoCompact).toBe(true)
    expect(ai.budget).toBeUndefined()
  })

  it('keep the choice of an install that only has the older autoCompact key', async () => {
    writeFileSync(paths.file, JSON.stringify({ ai: { autoCompact: false } }))
    const { getSettings } = await load()
    expect(getSettings().ai.autoCompact).toBe(false)
    expect(getSettings().ai.compaction?.auto).toBe(false)
  })

  it('leave one switch: a save that changes only compaction.auto moves autoCompact with it', async () => {
    const { getSettings, updateSettings } = await load()
    // The renderer spreads its whole ai object, so the stale older key travels along with the change.
    const next = updateSettings({ ai: { ...getSettings().ai, compaction: { auto: false } } })
    expect(next.ai.compaction?.auto).toBe(false)
    expect(next.ai.autoCompact).toBe(false)
    expect(stored().ai.autoCompact).toBe(false)
    expect(stored().ai.compaction).toEqual({ auto: false, threshold: 0.8, prune: true })
  })

  it('clamp the threshold into 50 to 95 percent', async () => {
    const { getSettings, updateSettings } = await load()
    expect(updateSettings({ ai: { ...getSettings().ai, compaction: { threshold: 0.3 } } }).ai.compaction?.threshold).toBe(0.5)
    expect(updateSettings({ ai: { ...getSettings().ai, compaction: { threshold: 0.99 } } }).ai.compaction?.threshold).toBe(0.95)
    expect(updateSettings({ ai: { ...getSettings().ai, compaction: { threshold: 0.65 } } }).ai.compaction?.threshold).toBe(0.65)
  })

  it('store caps in whole cents and remove one when the field is cleared with 0', async () => {
    const { getSettings, updateSettings } = await load()
    const ai = (): AppSettings['ai'] => getSettings().ai
    updateSettings({ ai: { ...ai(), budget: { dailyUsd: 5, perSessionUsd: 2.345, perTurnUsd: 0.5, action: 'stop' } } })
    expect(getSettings().ai.budget).toEqual({ dailyUsd: 5, perSessionUsd: 2.35, perTurnUsd: 0.5, action: 'stop' })
    updateSettings({ ai: { ...ai(), budget: { perTurnUsd: 0 } } })
    expect(getSettings().ai.budget).toEqual({ dailyUsd: 5, perSessionUsd: 2.35, action: 'stop' })
    expect(stored().ai.budget).toEqual({ dailyUsd: 5, perSessionUsd: 2.35, action: 'stop' })
  })

  it('keep the caps through an unrelated save', async () => {
    const { getSettings, updateSettings } = await load()
    updateSettings({ ai: { ...getSettings().ai, budget: { dailyUsd: 8, action: 'warn' } } })
    updateSettings({ general: { ...getSettings().general, theme: 'light' } })
    expect(getSettings().general.theme).toBe('light')
    expect(getSettings().ai.budget).toEqual({ dailyUsd: 8, action: 'warn' })
  })

  it('repair damaged stored values instead of failing', async () => {
    writeFileSync(paths.file, JSON.stringify({ ai: { compaction: { threshold: 'high', prune: 'yes', auto: 'no' }, budget: { dailyUsd: -4, perTurnUsd: 'free', action: 'halt' } } }))
    const { getSettings } = await load()
    expect(getSettings().ai.compaction).toEqual({ auto: true, threshold: 0.8, prune: true })
    expect(getSettings().ai.budget).toEqual({ action: 'warn' })
  })
})

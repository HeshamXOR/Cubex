import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAgentProfiles } from './agents'

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cubex-agents-'))
  const dir = join(root, '.cubex', 'agents')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'reviewer.md'),
    '---\nname: reviewer\ndescription: Reviews code for bugs\n---\nYou are a meticulous code reviewer. Report issues by severity.'
  )
  writeFileSync(join(dir, 'empty.md'), '---\nname: broken\n---\n   ') // no body → skipped
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('agent profiles', () => {
  it('loads profiles with name/description/systemPrompt from the body', () => {
    const profiles = loadAgentProfiles(root)
    expect(profiles).toHaveLength(1)
    expect(profiles[0]).toMatchObject({ name: 'reviewer', description: 'Reviews code for bugs' })
    expect(profiles[0]!.systemPrompt).toContain('meticulous code reviewer')
  })

  it('returns nothing when there is no agents dir', () => {
    expect(loadAgentProfiles(join(root, 'nope'))).toEqual([])
  })
})

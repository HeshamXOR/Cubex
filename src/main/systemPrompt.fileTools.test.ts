import { describe, expect, it } from 'vitest'
import { buildHarnessSystemPrompt } from './systemPrompt'

const tools = (names: string[]) => names.map((name) => ({ name, inputSchema: { type: 'object' as const } }))

describe('system guidance for multi-edit and patch tools', () => {
  it('explains when to use multi_edit and apply_patch only when they are registered', () => {
    const none = buildHarnessSystemPrompt({ tools: tools(['read_file', 'edit_file']), mode: 'default', workspace: 'I:\\Cubex' })
    expect(none).not.toContain('multi_edit')
    expect(none).not.toContain('apply_patch')

    const prompt = buildHarnessSystemPrompt({ tools: tools(['read_file', 'edit_file', 'multi_edit', 'apply_patch']), mode: 'default', workspace: 'I:\\Cubex' })
    expect(prompt).toContain('Use multi_edit')
    expect(prompt).toMatch(/multi_edit[^\n]*one file[^\n]*nothing is written/i)
    expect(prompt).toContain('Use apply_patch')
    expect(prompt).toContain('*** Begin Patch')
    expect(prompt).toMatch(/apply_patch[^\n]*all or nothing/i)
    // The read-before-edit rule applies to both.
    expect(prompt).toMatch(/apply_patch[^\n]*read[^\n]*(first|before)/i)
  })
})

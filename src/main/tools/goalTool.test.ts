import { describe, expect, it } from 'vitest'
import { GOAL_LIMITS, GOAL_TOOL, type GoalClaim } from '@shared/goal'
import { createGoalTool } from './goalTool'

function tool() {
  const claims: GoalClaim[] = []
  return { claims, tool: createGoalTool((claim) => claims.push(claim)) }
}

describe('goal_update', () => {
  it('is named for the shared constant, needs no permission, and requires a status and a note', () => {
    const { tool: t } = tool()
    expect(t.definition.name).toBe(GOAL_TOOL)
    expect(t.defaultPermission).toBe('allow')
    expect(t.definition.inputSchema).toMatchObject({ required: ['status', 'note'], additionalProperties: false })
  })

  it('records a complete claim with its evidence', async () => {
    const { tool: t, claims } = tool()
    const result = await t.execute({ status: 'complete', note: '  ran npm test: 12 passed  ' }, undefined as never)
    expect(result.isError).toBeUndefined()
    expect(String(result.content)).toContain('Cubex will now check the goal')
    expect(claims).toEqual([{ status: 'complete', note: 'ran npm test: 12 passed' }])
  })

  it('records a blocked claim', async () => {
    const { tool: t, claims } = tool()
    await t.execute({ status: 'blocked', note: 'Needs the staging API key.' }, undefined as never)
    expect(claims).toEqual([{ status: 'blocked', note: 'Needs the staging API key.' }])
  })

  it('refuses a claim with no evidence, and says what to add', async () => {
    const { tool: t, claims } = tool()
    const complete = await t.execute({ status: 'complete', note: '   ' }, undefined as never)
    expect(complete.isError).toBe(true)
    expect(String(complete.content)).toContain('what you ran')
    const blocked = await t.execute({ status: 'blocked' }, undefined as never)
    expect(blocked.isError).toBe(true)
    expect(String(blocked.content)).toContain('what you need')
    expect(claims).toEqual([])
  })

  it('refuses any other status, and tells the agent to keep working instead', async () => {
    const { tool: t, claims } = tool()
    for (const input of [{ status: 'working', note: 'x' }, { note: 'x' }, null, 'complete']) {
      const result = await t.execute(input as never, undefined as never)
      expect(result.isError).toBe(true)
      expect(String(result.content)).toContain('keep working')
    }
    expect(claims).toEqual([])
  })

  it('bounds a long note', async () => {
    const { tool: t, claims } = tool()
    await t.execute({ status: 'complete', note: 'n'.repeat(GOAL_LIMITS.note * 2) }, undefined as never)
    expect(claims[0]?.note).toHaveLength(GOAL_LIMITS.note)
  })
})

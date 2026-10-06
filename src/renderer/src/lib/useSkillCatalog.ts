import { useCallback, useEffect, useMemo } from 'react'
import type { SkillSummary } from '../../../shared/ipc'
import { skillCatalogKey, useSkills } from '../state/skills'
import { useStore } from '../state/store'
import { skillInvocation, type SkillInvocation } from './slashCommands'

/**
 * The skills the open task can use. The list is fetched when the task or its folder changes, so it is ready before
 * the person types "/", and `refresh` fetches it again when the menu opens so a skill added meanwhile shows up.
 */
export function useSkillCatalog(conversationId: string | undefined, workspace: string | undefined): {
  skills: readonly SkillSummary[] | undefined
  loading: boolean
  refresh: () => void
} {
  const key = skillCatalogKey(conversationId, workspace)
  const skills = useSkills((state) => state.lists[key])
  const loading = useSkills((state) => !!state.loading[key])
  const refresh = useCallback(() => { void useSkills.getState().load(conversationId, workspace) }, [conversationId, workspace])
  useEffect(refresh, [refresh])
  return { skills, loading, refresh }
}

/** The skill a message in the open thread named, for the chip beside it. Undefined for any other message. */
export function useSkillInvocation(text: string): SkillInvocation | undefined {
  const conversationId = useStore((state) => state.activeConversation?.id)
  const workspace = useStore((state) => state.activeConversation?.workspacePath)
  const skills = useSkills((state) => state.lists[skillCatalogKey(conversationId, workspace)])
  return useMemo(() => skillInvocation(text, skills), [text, skills])
}

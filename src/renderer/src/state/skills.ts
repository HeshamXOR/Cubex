import { create } from 'zustand'
import type { SkillSummary } from '../../../shared/ipc'
import { api } from '../lib/api'
import { isCommandName, parseSlash, skillInvocation, type SkillInvocation } from '../lib/slashCommands'

type Catalog = readonly SkillSummary[]

/** What a task can use depends on the task and on its project folder, so a list is kept for that pair. */
export function skillCatalogKey(conversationId: string | undefined, workspace: string | undefined): string {
  return `${conversationId ?? ''}\n${workspace ?? ''}`
}

/** Lists kept for this run. The least recently loaded go first, so a long session does not collect one per task. */
const KEPT_LISTS = 24

interface SkillsState {
  lists: Record<string, Catalog>
  /** Keys whose list is on its way. */
  loading: Record<string, true>
  /** Why the last turn that named a skill did not start, per task, until the person changes the message. */
  failures: Record<string, string>
  /** Fetch a task's list again. Calls made while one is on its way share it. Undefined when it could not be read and none is kept. */
  load: (conversationId: string | undefined, workspace: string | undefined) => Promise<Catalog | undefined>
  /** The list the task already has, or a fetched one. */
  ensure: (conversationId: string | undefined, workspace: string | undefined) => Promise<Catalog | undefined>
  fail: (conversationId: string, message: string) => void
  clearFailure: (conversationId: string) => void
}

const inFlight = new Map<string, Promise<Catalog | undefined>>()

function remember(lists: Record<string, Catalog>, key: string, skills: Catalog): Record<string, Catalog> {
  const kept = Object.entries(lists).filter(([other]) => other !== key)
  kept.push([key, skills])
  return Object.fromEntries(kept.slice(-KEPT_LISTS))
}

/**
 * The skills each task can use, shared by the "/" menu, the message that names a skill and the thread's chips, so
 * all three agree. The list comes from the main process, which finds skills in the Cubex library and in the
 * project's .cubex, .agents and .claude folders.
 */
export const useSkills = create<SkillsState>((set, get) => ({
  lists: {},
  loading: {},
  failures: {},
  load: (conversationId, workspace) => {
    const key = skillCatalogKey(conversationId, workspace)
    const running = inFlight.get(key)
    if (running) return running
    set((state) => ({ loading: { ...state.loading, [key]: true } }))
    const request = api.listSkills(conversationId).then(
      (skills): Catalog | undefined => {
        set((state) => ({ lists: remember(state.lists, key, skills) }))
        return skills
      },
      // A list that could not be read leaves the one already kept in place.
      (): Catalog | undefined => get().lists[key]
    ).finally(() => {
      inFlight.delete(key)
      set((state) => ({ loading: Object.fromEntries(Object.entries(state.loading).filter(([other]) => other !== key)) }))
    })
    inFlight.set(key, request)
    return request
  },
  ensure: (conversationId, workspace) => {
    const kept = get().lists[skillCatalogKey(conversationId, workspace)]
    return kept ? Promise.resolve(kept) : get().load(conversationId, workspace)
  },
  fail: (conversationId, message) => set((state) => ({ failures: { ...state.failures, [conversationId]: message } })),
  clearFailure: (conversationId) => set((state) => conversationId in state.failures
    ? { failures: Object.fromEntries(Object.entries(state.failures).filter(([id]) => id !== conversationId)) }
    : state)
}))

/**
 * The skill a message names, found in the task's skills. A command or an ordinary message never asks for the
 * list, so sending one costs nothing extra.
 */
export async function namedSkill(text: string, conversationId: string, workspace: string | undefined): Promise<SkillInvocation | undefined> {
  const parsed = parseSlash(text)
  if (!parsed || (!parsed.explicit && isCommandName(parsed.name))) return undefined
  return skillInvocation(text, await useSkills.getState().ensure(conversationId, workspace))
}

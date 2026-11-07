import { create } from 'zustand'
import { nanoid } from 'nanoid'
import type { PermissionMode, WorktreeCommandResult, WorktreePlan } from '../../../shared/ipc'
import { useStore } from '../state/store'
import { api } from './api'

export type ReadyPlan = Extract<WorktreePlan, { ok: true }>

export interface RaceModel {
  providerId: string
  model: string
  label: string
}

/** A race can run at most this many at once: it is that many times the cost, and that many approvals to answer. */
export const MAX_RACE_MODELS = 4

interface WorktreeUi {
  /** The dialog on screen: a new task in a worktree, or the same work on several models. */
  dialog?: 'worktree' | 'race'
  openDialog: (kind: 'worktree' | 'race') => void
  closeDialog: () => void
  /** The race on the compare page. */
  raceId?: string
  /** What a race is busy with before its first message goes out. */
  raceStage?: string
  /** What the setup said, when it did not work. */
  raceProblems: string[]
  showRace: (raceId: string) => void
}

export const useWorktreeUi = create<WorktreeUi>((set) => ({
  openDialog: (kind) => set({ dialog: kind }),
  closeDialog: () => set({ dialog: undefined }),
  raceProblems: [],
  showRace: (raceId) => {
    set({ raceId })
    useStore.getState().setView('race')
  }
}))

function firstFailure(results: WorktreeCommandResult[]): WorktreeCommandResult | undefined {
  return results.find((result) => !result.ok)
}

export function setupProblem(results: WorktreeCommandResult[]): string | undefined {
  const failed = firstFailure(results)
  return failed ? `"${failed.command}" failed${failed.exitCode !== null ? ` with exit code ${failed.exitCode}` : ''}.` : undefined
}

/** A new task in a worktree of its own, opened and ready for the first message. Throws when the worktree cannot be made. */
export async function startWorktreeTask(plan: ReadyPlan, workspace: string, setup: string[]): Promise<string | undefined> {
  const state = useStore.getState()
  const execution = state.providers.find((provider) => provider.id === state.activeProviderId)?.accessType === 'local' ? 'local' : 'cloud'
  const made = await api.createConversation({
    title: 'New Chat',
    ...(state.activeProviderId ? { providerId: state.activeProviderId } : {}),
    ...(state.activeModel ? { model: state.activeModel } : {}),
    workspacePath: workspace,
    execution
  })
  try {
    await api.worktreeAttach(made.id, { workspace, copy: plan.copy })
  } catch (error) {
    await api.deleteConversation(made.id).catch(() => undefined)
    throw error
  }
  await state.loadConversations()
  await useStore.getState().openConversation(made.id)
  return setup.length ? setupProblem(await api.worktreeSetup(made.id, setup)) : undefined
}

export interface RaceRequest {
  plan: ReadyPlan
  workspace: string
  text: string
  models: RaceModel[]
  setup: string[]
  mode: PermissionMode
}

/**
 * The same message on several models, each in a worktree of its own. Every worktree is made and set up first, so no model starts
 * ahead of the others or runs its tests before the dependencies are there. A model whose setup fails does not run.
 */
export async function startRace(request: RaceRequest): Promise<void> {
  const raceId = nanoid(10)
  const ui = useWorktreeUi
  ui.setState({ raceId, raceProblems: [], raceStage: 'Creating the worktrees', dialog: undefined })
  useStore.getState().setView('race')
  const opening = request.text.replace(/\s+/g, ' ').trim().slice(0, 40)
  const problems: string[] = []
  const runs: Array<{ id: string; label: string }> = []
  // One at a time: git locks the repository while it adds a worktree.
  for (const model of request.models) {
    const execution = useStore.getState().providers.find((provider) => provider.id === model.providerId)?.accessType === 'local' ? 'local' : 'cloud'
    const made = await api.createConversation({
      title: `${model.label}: ${opening}`,
      providerId: model.providerId,
      model: model.model,
      workspacePath: request.workspace,
      execution
    })
    try {
      await api.worktreeAttach(made.id, { workspace: request.workspace, copy: request.plan.copy, raceId, title: model.label })
      runs.push({ id: made.id, label: model.label })
    } catch (error) {
      problems.push(`${model.label}: ${error instanceof Error ? error.message : String(error)}`)
      await api.deleteConversation(made.id).catch(() => undefined)
    }
  }
  await useStore.getState().loadConversations()

  let ready = runs
  if (request.setup.length && runs.length) {
    ui.setState({ raceStage: `Setting up: ${request.setup.join(', ')}` })
    const outcomes = await Promise.all(runs.map(async (run) => {
      try {
        return { run, problem: setupProblem(await api.worktreeSetup(run.id, request.setup)) }
      } catch (error) {
        return { run, problem: error instanceof Error ? error.message : String(error) }
      }
    }))
    ready = outcomes.filter((outcome) => !outcome.problem).map((outcome) => outcome.run)
    for (const outcome of outcomes) if (outcome.problem) problems.push(`${outcome.run.label}: ${outcome.problem}`)
  }

  ui.setState({ raceStage: 'Sending the message' })
  // Sending goes through the chat that is open, which is the only thing that can start a turn.
  for (const run of ready) {
    await useStore.getState().openConversation(run.id)
    useStore.getState().setPermissionMode(request.mode)
    const sent = await useStore.getState().sendMessage(request.text)
    if (!sent) problems.push(`${run.label}: the message could not be sent.`)
  }
  ui.setState({ raceStage: undefined, raceProblems: problems })
  useStore.getState().setView('race')
}

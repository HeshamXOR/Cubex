/**
 * What the mocked parts of the app (see run.eval.ts) read and write during a run. The mocks of ChatService's
 * neighbours (data folder, task records, usage) are shared by every run in the process, so each run is told
 * apart by its conversation id.
 */
export interface UsageRow {
  conversationId?: string
  usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; cacheWriteInputTokens?: number }
}

export const state = {
  dataRoot: '',
  /** Conversation id -> the workspace of that run. */
  workspaces: new Map<string, string>(),
  usage: [] as UsageRow[]
}

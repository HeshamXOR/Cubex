import type { SessionFileChange } from '../../../shared/ipc'
import { useFileProblems } from '../lib/problems'
import { useStore } from '../state/store'
import { ProblemsChip } from './ProblemsChip'

/**
 * Extra, quiet detail on a changed file's row in the review list, after its +/- counts: how many compiler problems
 * the file has right now. Renders nothing when the file is clean, and while checking is off or unavailable.
 */
export function FileRowExtras({ file }: { file: SessionFileChange }): JSX.Element | null {
  const conversationId = useStore((s) => s.activeConversation?.id)
  const checking = useStore((s) => s.settings?.diagnostics?.afterEdit === 'errors')
  const counts = useFileProblems(conversationId, file.path, file.updatedAt, checking && file.status !== 'deleted')
  return counts ? <ProblemsChip {...counts} title="Problems in this file now" /> : null
}

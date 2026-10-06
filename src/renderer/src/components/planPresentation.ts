import type { PlanAsk } from '../../../shared/ipc'

// Optional metadata also keeps older, text-only plan events readable.
export type PlanDocument = PlanAsk & {
  title?: string
  path?: string
  createdAt?: number
  status?: 'pending' | 'approved' | 'rejected' | 'cancelled'
  feedback?: string
}

export function planTitle(plan: PlanDocument): string {
  return plan.title?.trim() || /^#\s+(.+)$/m.exec(plan.plan)?.[1]?.trim() || 'Implementation plan'
}

export function planFileName(plan: PlanDocument): string {
  return plan.path?.split(/[\\/]/).pop() || 'implementation-plan.md'
}

export function planStatusLabel(plan: PlanDocument, pending: boolean): string {
  if (pending) return 'Needs review'
  if (plan.status === 'approved') return 'Approved'
  if (plan.status === 'rejected') return plan.feedback ? 'Changes requested' : 'Rejected'
  if (plan.status === 'cancelled') return 'Cancelled'
  return 'Saved plan'
}

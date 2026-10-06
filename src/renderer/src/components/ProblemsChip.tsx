import { CircleAlert, TriangleAlert } from 'lucide-react'
import { describeProblems, type ProblemCounts } from '../lib/problemCounts'
import './problems.css'

/**
 * What a file's problems come to, in words: "2 errors", "1 warning", "2 errors, 1 warning". The icon is the only
 * color, red for errors and amber when there are warnings alone. Renders nothing when there is nothing to say, and
 * is never interactive: it sits inside rows that are buttons.
 */
export function ProblemsChip({ errors, warnings, title }: ProblemCounts & { title?: string }): JSX.Element | null {
  if (errors + warnings === 0) return null
  const Icon = errors > 0 ? CircleAlert : TriangleAlert
  return (
    <span className={`prob ${errors > 0 ? 'prob--error' : 'prob--warn'}`} title={title}>
      <Icon size={13} aria-hidden="true" />
      {describeProblems({ errors, warnings })}
    </span>
  )
}

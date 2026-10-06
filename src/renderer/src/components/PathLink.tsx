import { useMemo, type ReactNode } from 'react'
import { parsePathReference } from '../lib/pathLinks'
import { usePathStat } from '../lib/usePathStat'
import { openFile, openFolder } from '../state/files'
import './pathlink.css'

/**
 * Makes `children` open a file in the Files tab when `text` names a file or folder that exists in the
 * workspace (`src/app.ts`, `src/app.ts:42`). Anything else is shown exactly as it was, so a guess
 * that does not pan out costs nothing on screen.
 */
export function PathLink({ text, children, className = '' }: { text: string; children: ReactNode; className?: string }): JSX.Element {
  const reference = useMemo(() => parsePathReference(text), [text])
  const stat = usePathStat(reference?.path)
  if (!reference || !stat || stat.kind === 'missing') return <>{children}</>
  const place = reference.line ? `${stat.path} at line ${reference.line}` : stat.path
  return (
    <button
      type="button"
      className={`pathlink ${className}`.trim()}
      title={`Open ${place} in Files`}
      onClick={() => (stat.kind === 'directory' ? openFolder(stat.path) : openFile(stat.path, reference.line))}
    >
      {children}
    </button>
  )
}

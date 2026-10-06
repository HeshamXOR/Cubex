/** The +added and −removed line counts of a change, in the diff colors. */
export function Stat({ added, removed }: { added: number; removed: number }): JSX.Element | null {
  if (!added && !removed) return null
  return (
    <span className="stat">
      {added > 0 && <span className="p">+{added}</span>}
      {removed > 0 && <span className="m">−{removed}</span>}
    </span>
  )
}

import { useId, type ReactNode } from 'react'

export function Group({ title, id, children }: { title: string; /** Lets a link elsewhere in the app land on this group (see lib/settingsLink). */ id?: string; children: ReactNode }): JSX.Element {
  const titleId = useId()
  return (
    <section className="card setgroup" id={id ? `settings-${id}` : undefined} aria-labelledby={titleId}>
      <h2 className="setgroup__title" id={titleId}>{title}</h2>
      <div>{children}</div>
    </section>
  )
}

export function RowShell({ label, hint, children }: { label: string; hint?: string; children: ReactNode }): JSX.Element {
  return (
    <div className="field setrow">
      <div>
        <div className="setrow__label">{label}</div>
        {hint && <div className="setrow__hint">{hint}</div>}
      </div>
      {children}
    </div>
  )
}

export function ToggleRow({ label, hint, on, onChange }: { label: string; hint?: string; on: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <RowShell label={label} hint={hint}>
      <button className={`switch ${on ? 'switch--on' : ''}`} onClick={() => onChange(!on)} aria-label={label} aria-pressed={on} />
    </RowShell>
  )
}

export function NumRow({ label, hint, value, step, onChange }: { label: string; hint?: string; value: number; step?: number; onChange: (v: number) => void }): JSX.Element {
  return (
    <RowShell label={label} hint={hint}>
      <input className="numbox" type="number" aria-label={label} step={step ?? 1} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </RowShell>
  )
}

export function TextRow({ label, hint, placeholder, value, onChange }: { label: string; hint?: string; placeholder?: string; value: string; onChange: (v: string) => void }): JSX.Element {
  return (
    <RowShell label={label} hint={hint}>
      <input className="input" aria-label={label} style={{ width: 300 }} value={value} placeholder={placeholder} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
    </RowShell>
  )
}

export function SelectRow({ label, hint, value, options, onChange }: { label: string; hint?: string; value: string; options: Array<[string, string]>; onChange: (v: string) => void }): JSX.Element {
  return (
    <RowShell label={label} hint={hint}>
      <select className="select" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} style={{ width: 180 }}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>{l}</option>
        ))}
      </select>
    </RowShell>
  )
}

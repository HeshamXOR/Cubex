import { useId, type ReactNode } from 'react'

export function Group({ title, id, hideTitle, children }: { title: string; /** Lets a link elsewhere in the app land on this group (see lib/settingsLink). */ id?: string; /** The page already says what this group is, so the title stays for assistive technology only. */ hideTitle?: boolean; children: ReactNode }): JSX.Element {
  const titleId = useId()
  // A group the page already names is not a second region of the same name; its heading stays for assistive technology.
  return (
    <section className="card setgroup" id={id ? `settings-${id}` : undefined} aria-labelledby={hideTitle ? undefined : titleId}>
      <h3 className={hideTitle ? 'setgroup__title setgroup__title--hidden' : 'setgroup__title'} id={titleId}>{title}</h3>
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

/** A switch is on or off, so it is announced as one: the label stays the same and `aria-checked` carries the state. */
export function Switch({ label, on, disabled, onChange }: { label: string; on: boolean; disabled?: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <button type="button" role="switch" className={`switch ${on ? 'switch--on' : ''}`} aria-label={label} aria-checked={on} disabled={disabled} onClick={() => onChange(!on)} />
  )
}

export function ToggleRow({ label, hint, on, disabled, onChange }: { label: string; hint?: string; on: boolean; disabled?: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <RowShell label={label} hint={hint}>
      <Switch label={label} on={on} disabled={disabled} onChange={onChange} />
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

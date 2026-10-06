import { useId } from 'react'
import { Flame } from 'lucide-react'
import type { EffortOption } from '@core/providers'
import type { ReasoningEffort } from '@core/types'
import './effort.css'

/**
 * Reasoning effort as a slider instead of a row of buttons: the stops are
 * discrete, but reading them as a scale is what makes the cost of the top end
 * legible. Only the last stop changes character (amber, and it keeps moving),
 * because that is the one that spends the most tokens per turn.
 */
export function EffortSlider({ options, selected, onChange }: {
  options: EffortOption[]
  selected: ReasoningEffort | undefined
  onChange: (value: ReasoningEffort | undefined) => void
}): JSX.Element | null {
  const id = useId()
  if (options.length < 2) return null

  const index = Math.max(0, options.findIndex((option) => option.value === selected))
  const current = options[index]!
  const last = options.length - 1
  const atMax = index === last
  // 0 at the left stop, 1 at the right: places the fill and the pulse that leaves the thumb.
  const ratio = last > 0 ? index / last : 0

  return (
    <div className={`eslider ${atMax ? 'is-max' : ''}`} style={{ ['--eff-t' as string]: ratio }}>
      <div className="eslider__head">
        <label className="eslider__label" htmlFor={id}>Reasoning effort</label>
        <span className="eslider__value">
          {atMax && <Flame className="eslider__flame" size={13} strokeWidth={2} aria-hidden="true" />}
          {current.label}
        </span>
      </div>
      <div className="eslider__track">
        <div className="eslider__fill" />
        <div className="eslider__ticks" aria-hidden="true">
          {options.map((option) => <span key={option.value ?? 'default'} className="eslider__tick" />)}
        </div>
        {atMax && <span className="eslider__beacon" aria-hidden="true" />}
        <input
          id={id}
          className="eslider__input"
          type="range"
          min={0}
          max={last}
          step={1}
          value={index}
          aria-valuetext={atMax ? `${current.label}, highest token use` : current.label}
          aria-describedby={atMax ? `${id}-hint ${id}-cost` : `${id}-hint`}
          onChange={(event) => onChange(options[Number(event.target.value)]?.value)}
        />
      </div>
      <p className="eslider__hint" id={`${id}-hint`}>{current.hint}</p>
      {atMax && <p className="eslider__cost" id={`${id}-cost`}>Spends the most tokens per turn.</p>}
    </div>
  )
}

import { useId } from 'react'
import type { EffortOption } from '@core/providers'
import type { ReasoningEffort } from '@core/types'
import { CubexMark } from '../../theme/Logo'
import './effort.css'

/** Floating constellation of Cubex compass stars inside the thick slider bar at Max effort. */
const MAX_STARS: readonly {
  size: number
  x: string
  y: string
  dx: string
  dy: string
  dur: string
  delay: string
}[] = [
  { size: 11, x: '7%', y: '-3px', dx: '5px', dy: '4px', dur: '2.4s', delay: '0s' },
  { size: 15, x: '17%', y: '2px', dx: '-4px', dy: '-4px', dur: '2.8s', delay: '-0.5s' },
  { size: 9, x: '27%', y: '-4px', dx: '6px', dy: '3px', dur: '2.2s', delay: '-1.1s' },
  { size: 14, x: '37%', y: '3px', dx: '-5px', dy: '-3px', dur: '2.6s', delay: '-0.3s' },
  { size: 10, x: '47%', y: '-2px', dx: '4px', dy: '4px', dur: '2.3s', delay: '-1.5s' },
  { size: 16, x: '57%', y: '1px', dx: '-6px', dy: '-3px', dur: '2.9s', delay: '-0.8s' },
  { size: 9, x: '67%', y: '-4px', dx: '5px', dy: '4px', dur: '2.1s', delay: '-1.7s' },
  { size: 14, x: '76%', y: '3px', dx: '-4px', dy: '-4px', dur: '2.5s', delay: '-0.6s' },
  { size: 11, x: '85%', y: '-2px', dx: '4px', dy: '3px', dur: '2.4s', delay: '-1.2s' }
]

/**
 * Reasoning effort as a thick tactile capsule slider: normal stops use Atelier's
 * neutral-inverse monochrome palette, and pushing to Max ignites a floating,
 * shining constellation of Cubex compass stars across the interior of the bar.
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
  // 0 at the left stop, 1 at the right: places the fill, detents, and star dial thumb.
  const ratio = last > 0 ? index / last : 0

  return (
    <div className={`eslider ${atMax ? 'is-max' : ''}`} style={{ ['--eff-t' as string]: ratio }}>
      <div className="eslider__head">
        <label className="eslider__label" htmlFor={id}>Reasoning effort</label>
        <span className="eslider__value">
          {atMax && <CubexMark size={12} className="eslider__star" />}
          {current.label}
        </span>
      </div>
      <div className="eslider__track">
        <div className="eslider__rail" aria-hidden="true">
          <div className="eslider__fill">
            <div className="eslider__stars">
              {MAX_STARS.map((star, idx) => (
                <span
                  key={idx}
                  className="eslider__inner-star"
                  style={{
                    left: star.x,
                    ['--star-y' as string]: star.y,
                    ['--star-dx' as string]: star.dx,
                    ['--star-dy' as string]: star.dy,
                    ['--star-dur' as string]: star.dur,
                    ['--star-delay' as string]: star.delay
                  }}
                >
                  <CubexMark size={star.size} />
                </span>
              ))}
            </div>
          </div>
          <div className="eslider__ticks">
            {options.map((option, idx) => {
              const isPassed = idx < index
              const isCurrent = idx === index
              const tickCls = `eslider__tick${isPassed ? ' is-passed' : ''}${isCurrent ? ' is-current' : ''}`
              return <span key={option.value ?? 'default'} className={tickCls} />
            })}
          </div>
        </div>
        <span className="eslider__beacon" aria-hidden="true" />
        <span className="eslider__thumb" aria-hidden="true">
          <CubexMark size={13} className="eslider__thumb-star" />
        </span>
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

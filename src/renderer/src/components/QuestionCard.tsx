import { useEffect, useId, useState } from 'react'
import { ArrowRight, Check, MessageCircleQuestion } from 'lucide-react'
import type { QuestionAsk } from '../../../shared/ipc'
import './question.css'

/** Choosing an option is reversible until the user sends the answer. */
export function QuestionCard({
  ask,
  onResolve
}: {
  ask: QuestionAsk
  onResolve: (answers: string[]) => void
}): JSX.Element {
  const id = useId()
  const [selected, setSelected] = useState<string[]>([])
  const [other, setOther] = useState('')
  useEffect(() => { setSelected([]); setOther('') }, [ask.id])

  const pick = (label: string): void => {
    if (ask.multiSelect) {
      setSelected((s) => (s.includes(label) ? s.filter((x) => x !== label) : [...s, label]))
    } else {
      setSelected([label])
      setOther('')
    }
  }
  const submit = (): void => {
    const answers = [...selected]
    if (other.trim()) answers.push(other.trim())
    if (answers.length) onResolve(answers)
  }
  return (
    <form className="question-review" aria-labelledby={`${id}-question`} onSubmit={(event) => { event.preventDefault(); submit() }}>
      <div className="question-review__heading">
        <MessageCircleQuestion size={17} strokeWidth={1.6} aria-hidden="true" />
        <div><span className="question-review__eyebrow">Your input</span><h3 id={`${id}-question`}>{ask.question}</h3></div>
      </div>
      <div className="question-review__options" role="group" aria-label={ask.multiSelect ? 'Choose one or more options' : 'Choose an option'}>
        {ask.options.map((o, index) => (
          <button
            type="button"
            key={o.label}
            className={`question-review__option ${selected.includes(o.label) ? 'is-selected' : ''}`}
            onClick={() => pick(o.label)}
            aria-pressed={selected.includes(o.label)}
          >
            <span className="question-review__option-heading"><span className="question-review__number" aria-hidden="true">{selected.includes(o.label) ? <Check size={12} /> : index + 1}</span><span>{o.label}</span></span>
            {o.description && <span className="question-review__description">{o.description}</span>}
          </button>
        ))}
      </div>
      {ask.allowOther && (
        <div className="question-review__custom">
          <label htmlFor={`${id}-other`}>{ask.multiSelect ? 'Add context or another answer' : 'Or write your own answer'}</label>
          <textarea id={`${id}-other`} placeholder="Tell the model what you have in mind…" value={other} rows={2} onChange={(event) => { setOther(event.target.value); if (!ask.multiSelect && event.target.value.trim()) setSelected([]) }} />
        </div>
      )}
      <div className="question-review__actions">
        <span>{ask.multiSelect ? 'Select all that apply' : 'Choose one answer'}</span>
        <button type="button" className="question-review__skip" onClick={() => onResolve([])}>Skip</button>
        <button type="submit" className="question-review__submit" disabled={!selected.length && !other.trim()}>Send answer<ArrowRight size={14} /></button>
      </div>
    </form>
  )
}

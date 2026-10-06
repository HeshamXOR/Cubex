import { describe, expect, it } from 'vitest'
import { createSmoother, stepSmoother, type SmootherState } from './smoothText'

const FRAME = 1000 / 60

/** Drive the smoother at 60 fps while the text grows in bursts. */
function run(opts: { chunk: string; every: number; count: number; tail?: number; flush?: number }) {
  let text = ''
  let now = 0
  let nextArrival = 0
  let arrivals = 0
  const st = createSmoother(0, 0, 0)
  const jumps: number[] = []
  const samples: Array<{ at: number; shown: number; length: number }> = []
  const horizon = opts.every * opts.count + (opts.tail ?? 0)
  let previous = 0
  for (; now < horizon; now += FRAME) {
    if (now >= nextArrival && arrivals < opts.count) {
      text += opts.chunk
      arrivals++
      nextArrival += opts.every
    }
    stepSmoother(st, text, now, true)
    jumps.push(st.shown - previous)
    previous = st.shown
    samples.push({ at: now, shown: st.shown, length: text.length })
  }
  // The stream ends: how long until everything is visible?
  let flushed = -1
  for (let t = 0; t < 2000; t += FRAME) {
    now += FRAME
    stepSmoother(st, text, now, false)
    if (st.shown >= text.length) { flushed = t; break }
  }
  return { st, text, jumps, samples, flushed }
}

const WORDS = 'the quick brown fox jumps over the lazy dog '

describe('stepSmoother', () => {
  it('never moves backwards and never passes the text', () => {
    const { jumps, samples } = run({ chunk: WORDS.repeat(2), every: 150, count: 30 })
    expect(Math.min(...jumps)).toBeGreaterThanOrEqual(0)
    for (const s of samples) expect(s.shown).toBeLessThanOrEqual(s.length)
  })

  it('spreads a burst over many frames instead of jumping', () => {
    // About 175 characters per second arriving in 26-character bursts.
    const { jumps, samples } = run({ chunk: WORDS.repeat(2).slice(0, 26), every: 150, count: 30 })
    const steady = jumps.slice(60)
    expect(Math.max(...steady)).toBeLessThanOrEqual(16)
    // A burst is never revealed in one frame.
    expect(steady.filter((jump) => jump >= 26)).toHaveLength(0)
    // The display keeps up: little is left hidden once the stream is flowing.
    const last = samples.at(-1)!
    expect(last.length - last.shown).toBeLessThan(120)
  })

  it('reveals only whole words while text is arriving', () => {
    const st = createSmoother(0, 0, 0)
    const text = 'hello world and wor'
    for (let now = 0; now < 300; now += FRAME) stepSmoother(st, text, now, true)
    expect(st.shown).toBeLessThanOrEqual('hello world and '.length)
    expect(text.slice(st.shown - 1, st.shown)).toBe(' ')
  })

  it('shows a half-received word once the stream pauses', () => {
    const st = createSmoother(0, 0, 0)
    const text = 'hello wor'
    for (let now = 0; now < 1200; now += FRAME) stepSmoother(st, text, now, true)
    expect(st.shown).toBe(text.length)
  })

  it('finishes quickly once the text is final', () => {
    const { flushed, st, text } = run({ chunk: WORDS.repeat(3), every: 100, count: 20 })
    expect(flushed).toBeGreaterThanOrEqual(0)
    expect(flushed).toBeLessThan(700)
    expect(st.shown).toBe(text.length)
  })

  it('catches up fast after a huge backlog', () => {
    const st = createSmoother(0, 0, 0)
    const text = WORDS.repeat(120)
    let done = -1
    for (let now = 0; now < 4000; now += FRAME) {
      stepSmoother(st, text, now, false)
      if (st.shown >= text.length) { done = now; break }
    }
    expect(done).toBeGreaterThan(0)
    expect(done).toBeLessThan(1200)
  })

  it('starts instantly when asked to start at the end', () => {
    const text = WORDS.repeat(10)
    const st = createSmoother(text.length, text.length, 0)
    expect(stepSmoother(st, text, 16, false)).toBe(false)
    expect(st.shown).toBe(text.length)
  })

  it('clamps when the text is rewritten shorter', () => {
    const st: SmootherState = createSmoother(50, 50, 0)
    stepSmoother(st, 'short text', 16, true)
    expect(st.shown).toBe(10)
  })

  it('keeps asking for frames while live, then stops when caught up and final', () => {
    const st = createSmoother(0, 0, 0)
    expect(stepSmoother(st, '', 16, true)).toBe(true)
    const text = 'a b c'
    let more = true
    for (let now = 16; now < 2000 && more; now += FRAME) more = stepSmoother(st, text, now, false)
    expect(more).toBe(false)
    expect(st.shown).toBe(text.length)
  })
})

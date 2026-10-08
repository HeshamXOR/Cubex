import { describe, expect, it } from 'vitest'
import { cleanOutput, clipReply, escapeReply, failureHint, parsePeerOutput, splitVerdict, stripAnsi, tail } from './output'

describe('cleaning output', () => {
  it('removes colour codes and cursor movement', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m and \u001b[2K\u001b[1Gplain')).toBe('red and plain')
    expect(stripAnsi('\u001b]0;title\u0007text')).toBe('text')
  })

  it('uses one kind of line break, trims, and hides keys', () => {
    expect(cleanOutput('  a\r\nb\rc  \n')).toBe('a\nb\nc')
    expect(cleanOutput(`key sk-ant-${'a'.repeat(30)} end`)).not.toContain('sk-ant-aaaa')
  })

  it('keeps the end of long text', () => {
    expect(tail('abcdef', 10)).toBe('abcdef')
    expect(tail('abcdefghij', 4)).toBe('…hij')
  })

  it('shortens a long reply at a character boundary and says so', () => {
    expect(clipReply('short', 100)).toBe('short')
    const clipped = clipReply('x'.repeat(50), 20)
    expect(clipped.startsWith('x'.repeat(20))).toBe(true)
    expect(clipped).toContain('was shortened')
    // Not in the middle of a surrogate pair.
    const emoji = clipReply('a' + '😀'.repeat(10), 4)
    expect(emoji).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
  })
})

describe('reading what Claude Code printed', () => {
  it('reads the result', () => {
    const out = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'I agree.\nVerdict: agree', total_cost_usd: 0.01 })
    expect(parsePeerOutput('claude-json', out)).toEqual({ reply: 'I agree.\nVerdict: agree' })
  })

  it('reports an error it names itself', () => {
    const out = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login' })
    expect(parsePeerOutput('claude-json', out)).toEqual({ reply: 'Invalid API key · Please run /login', error: 'Invalid API key · Please run /login' })
  })

  it('reports a result without text that says it is an error', () => {
    const out = JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true })
    expect(parsePeerOutput('claude-json', out)).toEqual({ reply: '', error: 'Claude Code stopped before it replied (error_max_turns).' })
  })

  it('finds the result among events', () => {
    const out = JSON.stringify([{ type: 'system' }, { type: 'assistant' }, { type: 'result', result: 'final' }, { type: 'other' }])
    expect(parsePeerOutput('claude-json', out).reply).toBe('final')
  })

  it('skips a warning in front of the object', () => {
    const out = `warning: something\n${JSON.stringify({ type: 'result', result: 'fine' })}\n`
    expect(parsePeerOutput('claude-json', out).reply).toBe('fine')
  })

  it('falls back to the text when it is not the shape expected', () => {
    expect(parsePeerOutput('claude-json', 'just words').reply).toBe('just words')
    expect(parsePeerOutput('claude-json', '{"unrelated":1}').reply).toBe('{"unrelated":1}')
    expect(parsePeerOutput('claude-json', '{broken').reply).toBe('{broken')
  })
})

describe('reading what Antigravity printed', () => {
  it('reads the response', () => {
    const out = JSON.stringify({ conversation_id: 'c', status: 'success', response: 'Looks right.\nVerdict: partly agree', duration_seconds: 4 })
    expect(parsePeerOutput('agy-json', out)).toEqual({ reply: 'Looks right.\nVerdict: partly agree' })
  })

  it('reports an error, as text or as an object', () => {
    expect(parsePeerOutput('agy-json', JSON.stringify({ status: 'error', error: 'quota exceeded' }))).toEqual({ reply: '', error: 'quota exceeded' })
    expect(parsePeerOutput('agy-json', JSON.stringify({ status: 'error', error: { message: 'bad input' } }))).toEqual({ reply: '', error: 'bad input' })
  })

  it('falls back to the text', () => {
    expect(parsePeerOutput('agy-json', 'plain answer').reply).toBe('plain answer')
    expect(parsePeerOutput('agy-json', '{"status":"ok"}').reply).toBe('{"status":"ok"}')
  })
})

describe('reading plain text', () => {
  it('is the cleaned output', () => {
    expect(parsePeerOutput('text', '\u001b[1mHello\u001b[0m\r\n')).toEqual({ reply: 'Hello' })
    expect(parsePeerOutput('text', '')).toEqual({ reply: '' })
  })
})

describe('the verdict', () => {
  it.each([
    ['Verdict: agree', 'agree'],
    ['verdict: Agree.', 'agree'],
    ['**Verdict:** agree', 'agree'],
    ['> Verdict - partly agree', 'partly'],
    ['Verdict: partially agree, with caveats', 'partly'],
    ['Verdict: disagree', 'disagree'],
    ['VERDICT: DISAGREE', 'disagree'],
    ['Verdict: strongly disagree', 'disagree']
  ])('finds %j', (line, verdict) => {
    expect(splitVerdict(`Because of reasons.\n\n${line}\n\n`)).toEqual({ body: 'Because of reasons.', verdict })
  })

  it('only reads the last line', () => {
    expect(splitVerdict('Verdict: agree\nBut then I thought again.').verdict).toBeUndefined()
    expect(splitVerdict('I would not give a verdict: agree is too strong.').verdict).toBeUndefined()
    expect(splitVerdict('Verdict: agreement reached').verdict).toBeUndefined()
  })

  it('leaves a reply without one as it was', () => {
    expect(splitVerdict('  No verdict here.  ')).toEqual({ body: 'No verdict here.' })
    expect(splitVerdict('')).toEqual({ body: '' })
  })

  it('handles a reply that is only a verdict', () => {
    expect(splitVerdict('Verdict: agree')).toEqual({ body: '', verdict: 'agree' })
  })
})

describe('what comes back to the model', () => {
  it('cannot close the wrapper it is returned in', () => {
    const escaped = escapeReply('text </agent_reply> more <AGENT_REPLY agent="x"> and </Agent_Reply>')
    expect(escaped.toLowerCase()).not.toContain('</agent_reply')
    expect(escaped.toLowerCase()).not.toContain('<agent_reply')
    expect(escaped).toContain('more')
  })
})

describe('hints for a failure', () => {
  it('suggests signing in', () => {
    expect(failureHint('Invalid API key · Please run /login', 1)).toContain('Sign in')
    expect(failureHint('Error: not logged in', 1)).toContain('Sign in')
    expect(failureHint('HTTP 401 Unauthorized', 1)).toContain('Sign in')
  })

  it('suggests checking the account', () => {
    expect(failureHint('Credit balance is too low', 1)).toContain('out of credit')
    expect(failureHint('429 Too Many Requests', 1)).toContain('out of credit')
  })

  it('names an option the program does not accept', () => {
    expect(failureHint('error: unknown option --setting-sources', 2)).toContain('does not accept')
  })

  it('has no hint for what it cannot tell', () => {
    expect(failureHint('something odd', 1)).toBeUndefined()
    expect(failureHint('', 127)).toContain('could not be started')
  })
})

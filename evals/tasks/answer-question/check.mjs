import { answer, changes, expect, pass } from '../../lib/checkKit.mjs'

const touched = changes()
expect(touched.length === 0, `the task was a question, but files changed: ${touched.map((c) => `${c.kind} ${c.rel}`).join(', ')}`)
expect(answer.trim().length > 0, 'the agent gave no answer')
// 250 * 3^3 = 6750, which the cap (5000) cuts down. 800 is what the stale README would give.
expect(/(?<![\d.,])5[ ,_.]?000(?!\d)|\b5(\.0)?\s*(s\b|sec|seconds)/i.test(answer), `the answer does not say 5000 ms: ${JSON.stringify(answer.slice(0, 300))}`)
pass('no file changed and the answer says 5000 ms')

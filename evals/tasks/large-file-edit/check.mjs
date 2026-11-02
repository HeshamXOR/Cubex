import { expect, fixture, pass, read } from '../../lib/checkKit.mjs'

const was = read('src/messages.mjs', fixture).split('\n')
const now = read('src/messages.mjs').split('\n')
expect(now.length === was.length, `the file has ${now.length} lines, it had ${was.length}`)
const differing = []
for (let i = 0; i < was.length; i++) if (was[i] !== now[i]) differing.push(i + 1)
expect(differing.length > 0, 'src/messages.mjs was not changed')
expect(differing.length === 1, `${differing.length} lines differ (lines ${differing.slice(0, 8).join(', ')}), exactly one should`)
const line = now[differing[0] - 1]
expect(line.trim().startsWith('E_QUOTA_117:'), `the wrong line changed: ${line}`)
expect(line === "  E_QUOTA_117: 'Storage quota exceeded. Free up space or upgrade your plan.',", `the new line is ${line}`)
pass('only the E_QUOTA_117 line changed, and it says the right thing')

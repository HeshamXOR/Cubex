import { addHidden, mustPass, pass, run, scratchCopy } from '../../lib/checkKit.mjs'

const dir = scratchCopy()
addHidden(dir)
mustPass('python -m unittest', run('python', ['-m', 'unittest', '-v'], { cwd: dir }))
pass('merge_intervals satisfies its docstring')

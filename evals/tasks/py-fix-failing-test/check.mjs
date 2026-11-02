import { addHidden, mustPass, pass, run, scratchCopy, unchanged } from '../../lib/checkKit.mjs'

unchanged('test_textstats.py')
const dir = scratchCopy()
addHidden(dir)
mustPass('python -m unittest', run('python', ['-m', 'unittest', '-v'], { cwd: dir }))
pass('the unit tests and the hidden ones pass, and the existing tests are untouched')

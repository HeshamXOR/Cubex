import { describe, expect, it } from 'vitest'
import { isProtectedPath, windowsNameProblem } from './workspacePaths'

/** The Windows name rules are pure string checks, so they are verified on every platform. */
describe('windowsNameProblem', () => {
  it.each([
    'CON', 'con', 'Prn', 'AUX', 'NUL', 'COM1', 'com9', 'LPT1', 'lpt9', 'CONIN$', 'conout$',
    'nul.txt', 'aux.tar.gz', 'COM3.log', 'nul .txt', 'con.', 'CON ', String.fromCharCode(0x43, 0x4f, 0x4d, 0xb9), String.fromCharCode(0x4c, 0x50, 0x54, 0xb2)
  ])('flags the reserved device name %j', (name) => {
    expect(windowsNameProblem(name)).toMatch(/reserved windows device name/i)
  })

  it.each(['console', 'nullable.ts', 'com0', 'com10', 'com', 'lpt', 'lpt0', 'auxiliary', 'a.con', 'readme', 'xcon', 'conx.txt', 'COM1x', 'conin'])('allows %j', (name) => {
    expect(windowsNameProblem(name)).toBeUndefined()
  })

  it.each(['a.txt:stream', 'a.txt::$DATA', ':hidden', 'dir::$INDEX_ALLOCATION', 'x:'])('flags the stream spelling %j', (name) => {
    expect(windowsNameProblem(name)).toMatch(/alternate data stream/i)
  })

  it.each(['a.txt.', 'a.txt..', 'a ', 'dir.', '...', ' ', '. '])('flags the trailing dot or space in %j', (name) => {
    expect(windowsNameProblem(name)).toMatch(/ends in a dot or space/i)
  })

  it.each(['a?', 'a*b', '<a>', 'a|b', 'a"b', 'tab\tname', `nul${String.fromCharCode(0)}byte`])('flags the forbidden character in %j', (name) => {
    expect(windowsNameProblem(name)).toMatch(/not allowed in a windows path/i)
  })

  it.each(['a.txt', '.git', '.gitignore', '.hidden', 'a b.txt', 'a-b_c.d', 'src', 'x.y.z', 'notes~1.txt', 'ünï.txt', '日本語.md', 'a'])('allows the ordinary name %j', (name) => {
    expect(windowsNameProblem(name)).toBeUndefined()
  })
})

describe('isProtectedPath', () => {
  it.each(['.git/config', '.git', 'sub/.git/hooks/pre-commit', '.GIT\\config', '.claude/settings.json', '.vscode/tasks.json', '.husky/pre-commit', '.cubex/x', '.agents/a', '.codex/b'])('protects %j', (path) => {
    expect(isProtectedPath(path)).toBe(true)
  })

  it.each(['src/a.ts', '.gitignore', '.github/workflows/ci.yml', 'my.git/config', 'dot.claude/x', '.vscode-test/x', 'docs/.cubexrc'])('does not protect %j', (path) => {
    expect(isProtectedPath(path)).toBe(false)
  })
})

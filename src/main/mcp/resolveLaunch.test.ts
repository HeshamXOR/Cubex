import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveLaunch, LaunchError, type LaunchHost } from './resolveLaunch'

const key = (p: string): string => p.replace(/\//g, '\\').toLowerCase()

/** A fake Windows filesystem: only the listed files exist. */
function winHost(files: Record<string, string>): LaunchHost {
  const map = new Map(Object.entries(files).map(([p, text]) => [key(p), text]))
  return { platform: 'win32', isFile: (p) => map.has(key(p)), readText: (p) => map.get(key(p)) }
}

const NODE_DIR = 'C:\\Program Files\\nodejs'
const nodeInstall: Record<string, string> = {
  [`${NODE_DIR}\\node.exe`]: '',
  [`${NODE_DIR}\\npx.cmd`]: '@ECHO OFF\r\n"%NODE_EXE%" "%NPX_CLI_JS%" %*\r\n',
  [`${NODE_DIR}\\npx`]: '#!/bin/sh\n',
  [`${NODE_DIR}\\npm.cmd`]: '@ECHO OFF\r\n"%NODE_EXE%" "%NPM_CLI_JS%" %*\r\n',
  [`${NODE_DIR}\\node_modules\\npm\\bin\\npx-cli.js`]: '',
  [`${NODE_DIR}\\node_modules\\npm\\bin\\npm-cli.js`]: ''
}
const env = { Path: `C:\\Windows\\System32;${NODE_DIR};C:\\Users\\me\\.local\\bin`, PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\System32\\cmd.exe' }

const MODERN_SHIM = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\pnpm\\bin\\pnpm.cjs" %*', ''
].join('\r\n')
const OLD_SHIM = [
  '@IF EXIST "%~dp0\\node.exe" (', '  "%~dp0\\node.exe"  "%~dp0\\node_modules\\yarn\\bin\\yarn.js" %*', ') ELSE (',
  '  @SETLOCAL', '  @SET PATHEXT=%PATHEXT:;.JS;=;%', '  node  "%~dp0\\node_modules\\yarn\\bin\\yarn.js" %*', ')', ''
].join('\r\n')

describe('resolveLaunch on Windows (injected platform)', () => {
  it('runs npx through the bundled JS entry with node, never a shell', () => {
    const plan = resolveLaunch({ command: 'npx', args: ['-y', '@scope/pkg', '--flag', 'two words'], env }, winHost(nodeInstall))
    expect(plan).toMatchObject({
      file: `${NODE_DIR}\\node.exe`,
      args: [`${NODE_DIR}\\node_modules\\npm\\bin\\npx-cli.js`, '-y', '@scope/pkg', '--flag', 'two words'],
      windowsVerbatimArguments: false,
      mode: 'node-script'
    })
  })

  it('does the same for npm and for explicit npx.cmd names or absolute paths', () => {
    const host = winHost(nodeInstall)
    expect(resolveLaunch({ command: 'npm', args: ['run', 'x'], env }, host).args[0]).toBe(`${NODE_DIR}\\node_modules\\npm\\bin\\npm-cli.js`)
    expect(resolveLaunch({ command: 'npx.cmd', args: [], env }, host).mode).toBe('node-script')
    expect(resolveLaunch({ command: `${NODE_DIR}\\npx.cmd`, args: [], env: {} }, host).mode).toBe('node-script')
    expect(resolveLaunch({ command: `${NODE_DIR}\\npx`, args: [], env: {} }, host).mode).toBe('node-script')
  })

  it('passes awkward arguments untouched on the node route (no cmd.exe parsing involved)', () => {
    const args = ['--json={"a":"b c"}', '100%', '%PATH%', 'a&b|c', 'say "hi"', '']
    expect(resolveLaunch({ command: 'npx', args, env }, winHost(nodeInstall)).args.slice(1)).toEqual(args)
  })

  it('finds node by PATH when it is not beside the shim', () => {
    const files = { ...nodeInstall }
    delete files[`${NODE_DIR}\\node.exe`]
    files['C:\\Tools\\node.exe'] = ''
    const plan = resolveLaunch({ command: 'npx', args: [], env: { ...env, Path: `C:\\Tools;${NODE_DIR}` } }, winHost(files))
    expect(plan.file).toBe('C:\\Tools\\node.exe')
  })

  it('reads a modern npm cmd-shim (pnpm) and runs its script with node', () => {
    const host = winHost({ ...nodeInstall, 'C:\\npm\\pnpm.cmd': MODERN_SHIM, 'C:\\npm\\node_modules\\pnpm\\bin\\pnpm.cjs': '', 'C:\\npm\\node.exe': '' })
    const plan = resolveLaunch({ command: 'pnpm', args: ['dlx', 'server'], env: { ...env, Path: 'C:\\npm' } }, host)
    expect(plan).toMatchObject({ file: 'C:\\npm\\node.exe', args: ['C:\\npm\\node_modules\\pnpm\\bin\\pnpm.cjs', 'dlx', 'server'], mode: 'node-script' })
  })

  it('reads an older cmd-shim (yarn) and uses node from PATH when none sits beside it', () => {
    const host = winHost({ ...nodeInstall, 'C:\\yarn\\bin\\yarn.cmd': OLD_SHIM, 'C:\\yarn\\bin\\node_modules\\yarn\\bin\\yarn.js': '' })
    const plan = resolveLaunch({ command: 'yarn', args: ['dlx', 'x'], env: { ...env, Path: `C:\\yarn\\bin;${NODE_DIR}` } }, host)
    expect(plan).toMatchObject({ file: `${NODE_DIR}\\node.exe`, args: ['C:\\yarn\\bin\\node_modules\\yarn\\bin\\yarn.js', 'dlx', 'x'], mode: 'node-script' })
  })

  it('resolves shims in node_modules/.bin that point up a directory', () => {
    const shim = '@ECHO off\r\n"%_prog%"  "%dp0%\\..\\tool\\bin\\cli.js" %*\r\nSET "_prog=node"\r\n'
    const host = winHost({ ...nodeInstall, 'C:\\proj\\node_modules\\.bin\\tool.cmd': shim, 'C:\\proj\\node_modules\\tool\\bin\\cli.js': '' })
    const plan = resolveLaunch({ command: 'C:\\proj\\node_modules\\.bin\\tool', args: ['a'], env }, host)
    expect(plan).toMatchObject({ mode: 'node-script', args: ['C:\\proj\\node_modules\\tool\\bin\\cli.js', 'a'] })
  })

  it('starts real executables directly (uvx, bunx, node)', () => {
    const host = winHost({ ...nodeInstall, 'C:\\Users\\me\\.local\\bin\\uvx.exe': '', 'C:\\Users\\me\\.local\\bin\\bunx.exe': '' })
    expect(resolveLaunch({ command: 'uvx', args: ['mcp-server-git'], env }, host)).toEqual({
      file: 'C:\\Users\\me\\.local\\bin\\uvx.exe', args: ['mcp-server-git'], windowsVerbatimArguments: false, mode: 'direct'
    })
    expect(resolveLaunch({ command: 'bunx', args: ['x'], env }, host).mode).toBe('direct')
    expect(resolveLaunch({ command: 'node', args: ['server.js'], env }, host).file).toBe(`${NODE_DIR}\\node.exe`)
  })

  it('runs bunx shipped as a cmd-shim through its script', () => {
    const shim = '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\bun\\bin\\bunx.js" %*\r\nSET "_prog=%dp0%\\node.exe"\r\n'
    const host = winHost({ ...nodeInstall, 'C:\\npm\\bunx.cmd': shim, 'C:\\npm\\node_modules\\bun\\bin\\bunx.js': '' })
    expect(resolveLaunch({ command: 'bunx', args: ['x'], env: { ...env, Path: `C:\\npm;${NODE_DIR}` } }, host).mode).toBe('node-script')
  })

  it('never uses the extensionless file that sits beside a .cmd shim', () => {
    const host = winHost({ 'C:\\only\\npx': '#!/bin/sh' })
    expect(() => resolveLaunch({ command: 'npx', args: [], env: { Path: 'C:\\only', PATHEXT: '.EXE;.CMD' } }, host)).toThrow(LaunchError)
  })

  it('reports a missing command clearly', () => {
    expect(() => resolveLaunch({ command: 'nonesuch', args: [], env }, winHost(nodeInstall))).toThrow(/"nonesuch" was not found/)
  })

  it('ignores relative PATH entries and the working directory (workspace planted binaries)', () => {
    const host = winHost({ 'C:\\work\\evil.exe': '', 'C:\\work\\bin\\evil2.exe': '' })
    const launch = (command: string) => resolveLaunch({ command, args: [], cwd: 'C:\\work', env: { Path: '.;bin;;C:\\Windows' } }, host)
    expect(() => launch('evil')).toThrow(LaunchError)
    expect(() => launch('evil2')).toThrow(LaunchError)
  })

  it('resolves explicit relative paths against the given working directory', () => {
    const host = winHost({ 'C:\\work\\bin\\server.exe': '' })
    expect(resolveLaunch({ command: '.\\bin\\server', args: [], cwd: 'C:\\work', env }, host).file).toBe('C:\\work\\bin\\server.exe')
  })

  it('honours PATHEXT and case-insensitive environment names', () => {
    const host = winHost({ 'C:\\t\\thing.CMD': '@echo hi', 'C:\\t\\thing.exe': '' })
    const plan = resolveLaunch({ command: 'thing', args: [], env: { PATH: 'C:\\t', pathext: '.CMD;.EXE', comspec: 'D:\\sys\\cmd.exe' } }, host)
    expect(plan.mode).toBe('cmd-shell')
    expect(plan.file).toBe('D:\\sys\\cmd.exe')
  })

  it('falls back to cmd.exe for an unrecognised batch file with a safely quoted command line', () => {
    const host = winHost({ 'C:\\My Tools\\run tool.cmd': '@echo off\r\ncall other.bat %*\r\n' })
    const plan = resolveLaunch({ command: 'C:\\My Tools\\run tool.cmd', args: ['--name', 'two words', 'a&b', 'trail\\', 'plain', ''], env }, host)
    expect(plan.mode).toBe('cmd-shell')
    expect(plan.windowsVerbatimArguments).toBe(true)
    expect(plan.file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(plan.args).toEqual(['/d', '/v:off', '/s', '/c', '""C:\\My Tools\\run tool.cmd" --name "two words" "a&b" trail\\ plain """'])
  })

  it('doubles trailing backslashes inside quoted arguments', () => {
    const host = winHost({ 'C:\\t\\x.cmd': '@echo off\r\n' })
    const plan = resolveLaunch({ command: 'C:\\t\\x.cmd', args: ['C:\\Program Files\\dir\\'], env }, host)
    expect(plan.args[4]).toBe('""C:\\t\\x.cmd" "C:\\Program Files\\dir\\\\""')
  })

  it('refuses characters cmd.exe would reinterpret rather than guessing', () => {
    const host = winHost({ 'C:\\t\\x.cmd': '@echo off\r\n' })
    for (const bad of ['say "hi"', '%PATH%', 'line\nbreak', 'nul\u0000byte']) {
      expect(() => resolveLaunch({ command: 'C:\\t\\x.cmd', args: [bad], env }, host)).toThrow(LaunchError)
    }
  })

  it('falls back to cmd.exe when the shim names a script that does not exist', () => {
    const shim = '@ECHO off\r\n"%_prog%"  "%dp0%\\missing.js" %*\r\nSET "_prog=node"\r\n'
    const plan = resolveLaunch({ command: 'C:\\t\\y.cmd', args: [], env }, winHost({ 'C:\\t\\y.cmd': shim, ...nodeInstall }))
    expect(plan.mode).toBe('cmd-shell')
  })

  it('does not trust a shim whose program is not node', () => {
    const shim = '@ECHO off\r\nSET "_prog=python"\r\n"%_prog%"  "%dp0%\\x.py" %*\r\n'
    const plan = resolveLaunch({ command: 'C:\\t\\z.cmd', args: [], env }, winHost({ 'C:\\t\\z.cmd': shim, 'C:\\t\\x.py': '', ...nodeInstall }))
    expect(plan.mode).toBe('cmd-shell')
  })

  it('refuses things Windows cannot start directly', () => {
    const host = winHost({ 'C:\\t\\run.ps1': '', 'C:\\t\\a.js': '' })
    expect(() => resolveLaunch({ command: 'C:\\t\\run.ps1', args: [], env }, host)).toThrow(/interpreter/)
    expect(() => resolveLaunch({ command: 'C:\\t\\a.js', args: [], env }, host)).toThrow(/interpreter/)
  })

  it('rejects an empty command and control characters', () => {
    expect(() => resolveLaunch({ command: '  ', args: [], env }, winHost({}))).toThrow(LaunchError)
    expect(() => resolveLaunch({ command: 'a\u0000b', args: [], env }, winHost({}))).toThrow(LaunchError)
  })
})

describe('resolveLaunch on other platforms (injected platform)', () => {
  it('passes the command and arguments through for spawn to resolve', () => {
    const host: LaunchHost = { platform: 'linux', isFile: () => false, readText: () => undefined }
    expect(resolveLaunch({ command: 'npx', args: ['-y', 'pkg'], env: {} }, host)).toEqual({
      file: 'npx', args: ['-y', 'pkg'], windowsVerbatimArguments: false, mode: 'direct'
    })
  })
})

describe.runIf(process.platform === 'win32')('resolveLaunch with the real Windows shell', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cubex launch '))
  const bin = join(dir, 'tool bin')
  mkdirSync(join(bin, 'node_modules', 'echoer', 'bin'), { recursive: true })
  const script = join(bin, 'node_modules', 'echoer', 'bin', 'cli.js')
  writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n')
  // A real npm-style shim, and a batch file the shim reader does not recognise.
  writeFileSync(join(bin, 'echoer.cmd'), MODERN_SHIM.replace('pnpm\\bin\\pnpm.cjs', 'echoer\\bin\\cli.js'))
  writeFileSync(join(bin, 'plain.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`)
  const childEnv = { ...process.env, Path: `${bin};${dirname(process.execPath)};${process.env.Path ?? process.env.PATH ?? ''}` }

  const run = (command: string, args: string[]): string => {
    const plan = resolveLaunch({ command, args, env: childEnv })
    const result = spawnSync(plan.file, plan.args, { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: plan.windowsVerbatimArguments, env: childEnv })
    if (result.error) throw result.error
    return result.stdout
  }

  it('really starts the installed npx (the case that used to fail with ENOENT or EINVAL)', () => {
    expect(run('npx', ['--version']).trim()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('runs an npm-style shim from a directory with spaces and keeps every argument intact', () => {
    const args = ['plain', 'two words', 'a&b', 'x|y', '<in>', 'caret^', '(paren)', '100%', 'say "hi"', 'unicode \u00e9\u4e2d', '--json={"a":1}']
    expect(JSON.parse(run('echoer', args))).toEqual(args)
  })

  it('runs an unrecognised batch file through cmd.exe with spaces and shell characters preserved', () => {
    const args = ['plain', 'two words', 'a&b', 'x|y', '<in>', 'caret^', '(paren)', 'trail\\']
    const plan = resolveLaunch({ command: 'plain', args, env: childEnv })
    expect(plan.mode).toBe('cmd-shell')
    expect(JSON.parse(run('plain', args))).toEqual(args)
  })

  it('refuses an argument cmd.exe would expand', () => {
    expect(() => resolveLaunch({ command: 'plain', args: ['%PATH%'], env: childEnv })).toThrow(LaunchError)
  })

  it('cleans up', () => {
    rmSync(dir, { recursive: true, force: true })
  })
})

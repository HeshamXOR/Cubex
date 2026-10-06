import { describe, expect, it } from 'vitest'
import {
  ShellCommandTooLongError, listShells, normalizeShellPreference, pathScan, resolveShell, type ShellDeps
} from './shellProvider'

const GIT_ROOT = 'C:\\Program Files\\Git'
const GIT_BASH = `${GIT_ROOT}\\bin\\bash.exe`
const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const WINPS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const CMD = 'C:\\Windows\\System32\\cmd.exe'

/** A fake Windows machine: `files` is the set of paths that exist, `onPath` maps a program name to its PATH hits. */
function windows(files: string[], onPath: Record<string, string[]> = {}, env: NodeJS.ProcessEnv = {}): ShellDeps {
  const present = new Set(files.map((file) => file.toLowerCase()))
  return {
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', ...env },
    which: (name) => onPath[name] ?? [],
    exists: (path) => present.has(path.toLowerCase())
  }
}

function decodeEncoded(argv: string[]): string {
  const index = argv.indexOf('-EncodedCommand')
  expect(index).toBeGreaterThan(-1)
  return Buffer.from(argv[index + 1]!, 'base64').toString('utf16le')
}

describe('shell detection on Windows', () => {
  it('prefers Git Bash found through git.exe on PATH (cmd directory layout)', () => {
    const deps = windows([GIT_BASH, PWSH, WINPS, CMD], { git: [`${GIT_ROOT}\\cmd\\git.exe`], pwsh: [PWSH] })
    const spec = resolveShell('auto', deps)
    expect(spec.id).toBe('git-bash')
    expect(spec.exe).toBe(GIT_BASH)
  })

  it('finds the Git root from mingw64\\bin\\git.exe too', () => {
    const deps = windows([GIT_BASH, CMD], { git: [`${GIT_ROOT}\\mingw64\\bin\\git.exe`] })
    expect(resolveShell('auto', deps).exe).toBe(GIT_BASH)
  })

  it('falls back to the standard install roots when git is not on PATH', () => {
    expect(resolveShell('auto', windows([GIT_BASH, CMD])).exe).toBe(GIT_BASH)
    const portable = windows(['D:\\tools\\PortableGit\\bin\\bash.exe', CMD], {}, { GIT_INSTALL_ROOT: 'D:\\tools\\PortableGit' })
    expect(resolveShell('auto', portable).exe).toBe('D:\\tools\\PortableGit\\bin\\bash.exe')
  })

  it('never asks PATH for bash, which can be the WSL launcher in System32', () => {
    const deps = windows(['C:\\Windows\\System32\\bash.exe', PWSH, CMD], { bash: ['C:\\Windows\\System32\\bash.exe'], pwsh: [PWSH] })
    const spec = resolveShell('auto', deps)
    expect(spec.id).toBe('pwsh')
  })

  it('uses pwsh, then Windows PowerShell, then cmd when Git is absent', () => {
    expect(resolveShell('auto', windows([PWSH, WINPS, CMD], { pwsh: [PWSH] })).id).toBe('pwsh')
    expect(resolveShell('auto', windows([WINPS, CMD])).id).toBe('powershell')
    expect(resolveShell('auto', windows([WINPS, CMD])).exe).toBe(WINPS)
    const bare = resolveShell('auto', windows([], {}, { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }))
    expect(bare.id).toBe('cmd')
    expect(bare.exe.toLowerCase()).toBe(CMD.toLowerCase())
  })

  it('skips relative PATH entries and a ComSpec that is not cmd.exe', () => {
    const files = ['.\\git.exe', 'bin\\git.exe', 'C:\\Tools\\git.exe']
    const scanned = pathScan('git', {
      platform: 'win32', env: { Path: '.;bin;;"C:\\Tools"' }, exists: (path) => files.includes(path)
    })
    expect(scanned).toEqual(['C:\\Tools\\git.exe'])
    const evil = windows([CMD], {}, { ComSpec: 'C:\\work\\repo\\evil.exe' })
    expect(resolveShell('cmd', evil).exe.toLowerCase()).toBe(CMD.toLowerCase())
  })

  it('honors an explicit preference and says so when it had to fall back', () => {
    const deps = windows([GIT_BASH, WINPS, CMD], { git: [`${GIT_ROOT}\\cmd\\git.exe`] })
    expect(resolveShell('cmd', deps).id).toBe('cmd')
    expect(resolveShell('powershell', deps).id).toBe('powershell')
    const missing = resolveShell('pwsh', deps)
    expect(missing.id).toBe('git-bash')
    expect(missing.fallbackFrom).toBe('pwsh')
    expect(resolveShell('posix', deps).fallbackFrom).toBe('posix')
    expect(resolveShell('auto', deps).fallbackFrom).toBeUndefined()
  })

  it('treats an unknown preference as auto', () => {
    const deps = windows([GIT_BASH, CMD], { git: [`${GIT_ROOT}\\cmd\\git.exe`] })
    expect(resolveShell('nushell' as never, deps).id).toBe('git-bash')
    expect(normalizeShellPreference('nushell')).toBe('auto')
    expect(normalizeShellPreference(undefined)).toBe('auto')
    expect(normalizeShellPreference({})).toBe('auto')
    expect(normalizeShellPreference('pwsh')).toBe('pwsh')
    expect(normalizeShellPreference('auto')).toBe('auto')
  })

  it('lists every Windows shell with its availability', () => {
    const deps = windows([GIT_BASH, WINPS, CMD], { git: [`${GIT_ROOT}\\cmd\\git.exe`] })
    const listed = listShells(deps)
    expect(listed.map((shell) => shell.id)).toEqual(['git-bash', 'pwsh', 'powershell', 'cmd'])
    expect(listed.map((shell) => shell.available)).toEqual([true, false, true, true])
    expect(listed[0]).toMatchObject({ path: GIT_BASH, label: 'Git Bash' })
    expect(listed[1]).toMatchObject({ path: '', available: false })
  })
})

describe('shell detection off Windows', () => {
  const linux: ShellDeps = { platform: 'linux', env: {}, which: () => [], exists: (path) => path === '/bin/sh' }

  it('always uses sh -c', () => {
    const spec = resolveShell('auto', linux)
    expect(spec).toMatchObject({ id: 'posix', exe: '/bin/sh' })
    expect(spec.argv('echo "a b"; ls')).toEqual(['-c', 'echo "a b"; ls'])
    expect(resolveShell('git-bash', linux).id).toBe('posix')
    expect(listShells(linux)).toEqual([{ id: 'posix', label: 'sh', path: '/bin/sh', available: true }])
  })
})

describe('Git Bash argv', () => {
  const spec = resolveShell('git-bash', windows([GIT_BASH, CMD], { git: [`${GIT_ROOT}\\cmd\\git.exe`] }))

  it('passes the command as one -c argument with no extra quoting layer', () => {
    const command = `echo "a \\"q\\" %PATH% ^ & b" 'x y' héllo`
    expect(spec.argv(command)).toEqual(['-c', command])
    expect(spec.script(command)).toBe(command)
    expect(spec.verbatimArguments).toBeUndefined()
  })

  it('describes Bash syntax to the model', () => {
    expect(spec.syntaxNote).toMatch(/Git Bash/)
    expect(spec.syntaxNote).toMatch(/Bash syntax/)
  })
})

describe('PowerShell argv', () => {
  const deps = windows([WINPS, CMD])
  const spec = resolveShell('powershell', deps)

  it('uses -EncodedCommand with the profile and prompts disabled', () => {
    const argv = spec.argv('Get-ChildItem')
    expect(argv.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
    expect(argv).toHaveLength(5)
    expect(argv.join(' ')).not.toMatch(/-Command\b/)
  })

  it.each([
    'Write-Output "she said \\"hi\\""',
    "Write-Output 'it''s 100% ^ & fine'",
    'Get-ChildItem "C:\\Program Files\\My App" | Select-Object -First 1',
    'Write-Output "héllo wörld 日本語 ✓"',
    'echo a; echo "b `"c`""\necho multi-line',
    'cmd /c "rmdir /s /q ""C:\\a b"""'
  ])('round-trips %j unchanged inside the encoded script', (command) => {
    const decoded = decodeEncoded(spec.argv(command))
    expect(decoded).toBe(spec.script(command))
    expect(decoded).toContain(command)
  })

  it('forces UTF-8 output, silences progress, and keeps native exit codes', () => {
    const script = spec.script('node -e "process.exit(3)"')
    expect(script).toMatch(/\[Console\]::OutputEncoding = \[System\.Text\.UTF8Encoding\]::new\(\$false\)/)
    expect(script).toMatch(/\$ProgressPreference = 'SilentlyContinue'/)
    expect(script).toMatch(/exit \$cubexCode/)
    // The user's command sits between the preamble and the epilogue, on its own lines.
    expect(script).toMatch(/\nnode -e "process.exit\(3\)"\n/)
  })

  it('keeps a trailing comment from swallowing the epilogue', () => {
    const script = spec.script('Get-Date # now')
    expect(script.indexOf('# now')).toBeLessThan(script.indexOf('exit $cubexCode'))
    expect(script.slice(script.indexOf('# now'))).toMatch(/^# now\n/)
  })

  it('says PowerShell 5.1 has no && or ||', () => {
    expect(spec.syntaxNote).toMatch(/5\.1/)
    expect(spec.syntaxNote).toMatch(/&&/)
  })

  it('names pwsh as PowerShell 7 and allows &&', () => {
    const pwsh = resolveShell('pwsh', windows([PWSH, CMD], { pwsh: [PWSH] }))
    expect(pwsh.id).toBe('pwsh')
    expect(pwsh.exe).toBe(PWSH)
    expect(pwsh.argv('x')[3]).toBe('-EncodedCommand')
    expect(pwsh.syntaxNote).toMatch(/PowerShell 7/)
  })

  it('refuses a command whose encoded form cannot fit on a Windows command line', () => {
    expect(() => spec.argv('x'.repeat(20_000))).toThrow(ShellCommandTooLongError)
    expect(() => spec.argv('x'.repeat(5_000))).not.toThrow()
    try { spec.argv('x'.repeat(20_000)) } catch (error) {
      expect((error as Error).message).toMatch(/write_file/)
    }
  })
})

describe('cmd argv', () => {
  const spec = resolveShell('cmd', windows([CMD]))

  it('wraps the command once for /s /c, switches to UTF-8 and passes the line untouched', () => {
    const command = 'echo "a & b" %PATH% ^ & dir'
    expect(spec.argv(command)).toEqual(['/d', '/s', '/c', `"chcp 65001>nul&${command}"`])
    expect(spec.verbatimArguments).toBe(true)
    expect(spec.script(command)).toBe(`chcp 65001>nul&${command}`)
  })

  it('refuses a command longer than the cmd.exe limit', () => {
    expect(() => spec.argv('x'.repeat(8_500))).toThrow(ShellCommandTooLongError)
  })

  it('tells the model this is cmd.exe', () => {
    expect(spec.syntaxNote).toMatch(/cmd\.exe/)
    expect(spec.syntaxNote).toMatch(/not Bash or PowerShell/)
  })
})

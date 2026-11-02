import { describe, expect, it } from 'vitest'
import { LaunchError, type LaunchInput, type LaunchPlan } from '../mcp/resolveLaunch'
import { agyDefaultPaths, antigravityDesktopApp, claudeDesktopRoots, claudeInDesktopApp, compareVersions, findAppProgram, launchProgram, locateProgram, type AppHost } from './appPrograms'

/** A host that is a list of files: folders are whatever the paths imply. */
function host(platform: NodeJS.Platform, files: string[], home = platform === 'win32' ? 'C:\\Users\\Ada' : '/home/ada'): AppHost {
  const sep = platform === 'win32' ? '\\' : '/'
  const norm = (path: string): string => (platform === 'win32' ? path.toLowerCase() : path)
  const all = files.map(norm)
  return {
    platform,
    home,
    list(directory) {
      const prefix = `${norm(directory).replace(/[\\/]+$/, '')}${sep}`
      const names = new Set<string>()
      for (const file of files) {
        if (!norm(file).startsWith(prefix)) continue
        const first = file.slice(prefix.length).split(/[\\/]/)[0]
        if (first) names.add(first)
      }
      return names.size > 0 ? [...names] : undefined
    },
    isFile: (path) => all.includes(norm(path))
  }
}

const ENV = { APPDATA: 'C:\\Users\\Ada\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local' }

describe('versions', () => {
  it('compares the numbers, not the text', () => {
    expect(compareVersions('2.1.181', '2.1.289')).toBeLessThan(0)
    expect(compareVersions('2.10.0', '2.9.9')).toBeGreaterThan(0)
    expect(compareVersions('2.1.181', '2.1.181')).toBe(0)
    expect(compareVersions('v3.0.0', '2.9.9')).toBeGreaterThan(0)
  })

  it('puts a name that is not a version before every version', () => {
    expect(compareVersions('latest', '0.0.1')).toBeLessThan(0)
    expect(compareVersions('0.0.1', 'latest')).toBeGreaterThan(0)
    expect(compareVersions('latest', 'stable')).toBe(0)
  })
})

describe('where the Claude desktop app keeps Claude Code', () => {
  it('names the folders of the standard app and of the 3p build on Windows, macOS and Linux', () => {
    expect(claudeDesktopRoots(ENV, host('win32', []))).toEqual([
      'C:\\Users\\Ada\\AppData\\Roaming\\Claude\\claude-code',
      'C:\\Users\\Ada\\AppData\\Local\\Claude\\claude-code',
      'C:\\Users\\Ada\\AppData\\Roaming\\Claude-3p\\claude-code',
      'C:\\Users\\Ada\\AppData\\Local\\Claude-3p\\claude-code'
    ])
    expect(claudeDesktopRoots({}, host('darwin', []))[0]).toBe('/home/ada/Library/Application Support/Claude/claude-code')
    expect(claudeDesktopRoots({}, host('linux', []))[1]).toBe('/home/ada/.config/Claude-3p/claude-code')
    expect(claudeDesktopRoots({ XDG_CONFIG_HOME: '/cfg' }, host('linux', []))[0]).toBe('/cfg/Claude/claude-code')
  })

  it('falls back to the profile folder when the variables are missing', () => {
    expect(claudeDesktopRoots({}, host('win32', []))[0]).toBe('C:\\Users\\Ada\\AppData\\Roaming\\Claude\\claude-code')
  })

  it('finds the program the standard app keeps, one folder per version', () => {
    const files = ['C:\\Users\\Ada\\AppData\\Roaming\\Claude\\claude-code\\2.1.181\\claude.exe']
    expect(claudeInDesktopApp(ENV, host('win32', files))).toEqual({ path: files[0], version: '2.1.181', app: 'the Claude desktop app' })
  })

  it('finds the program the 3p build keeps, one folder down under a hash', () => {
    const files = ['C:\\Users\\Ada\\AppData\\Local\\Claude-3p\\claude-code\\2.1.293\\83cb0bd7fed4\\claude.exe']
    expect(claudeInDesktopApp(ENV, host('win32', files))?.path).toBe(files[0])
  })

  it('takes the newest version of all of them', () => {
    const files = [
      'C:\\Users\\Ada\\AppData\\Roaming\\Claude\\claude-code\\2.1.181\\claude.exe',
      'C:\\Users\\Ada\\AppData\\Local\\Claude-3p\\claude-code\\2.1.289\\e1f0154146bb\\claude.exe',
      'C:\\Users\\Ada\\AppData\\Local\\Claude-3p\\claude-code\\2.1.293\\83cb0bd7fed4\\claude.exe'
    ]
    const found = claudeInDesktopApp(ENV, host('win32', files))
    expect(found?.version).toBe('2.1.293')
    expect(found?.path).toBe(files[2])
  })

  it('prefers the standard app when two have the same version', () => {
    const files = [
      'C:\\Users\\Ada\\AppData\\Local\\Claude-3p\\claude-code\\2.1.200\\aaaa\\claude.exe',
      'C:\\Users\\Ada\\AppData\\Roaming\\Claude\\claude-code\\2.1.200\\claude.exe'
    ]
    expect(claudeInDesktopApp(ENV, host('win32', files))?.path).toBe(files[1])
  })

  it('skips a version folder that has no program in it', () => {
    const files = [
      'C:\\Users\\Ada\\AppData\\Roaming\\Claude\\claude-code\\2.1.300\\readme.txt',
      'C:\\Users\\Ada\\AppData\\Roaming\\Claude\\claude-code\\2.1.181\\claude.exe'
    ]
    expect(claudeInDesktopApp(ENV, host('win32', files))?.version).toBe('2.1.181')
  })

  it('finds nothing when the app is not installed', () => {
    expect(claudeInDesktopApp(ENV, host('win32', []))).toBeUndefined()
  })

  it('looks for claude, with no extension, outside Windows', () => {
    const files = ['/home/ada/Library/Application Support/Claude/claude-code/2.0.5/claude']
    expect(claudeInDesktopApp({}, host('darwin', files))?.path).toBe(files[0])
  })
})

describe('the Antigravity desktop app and command line', () => {
  it('finds the desktop app where its installer puts it', () => {
    const files = ['C:\\Users\\Ada\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe']
    expect(antigravityDesktopApp(ENV, host('win32', files))).toEqual({ path: files[0], app: 'the Antigravity desktop app' })
    expect(antigravityDesktopApp(ENV, host('win32', []))).toBeUndefined()
  })

  it('names the default folder of the agy command line, which setup has not put on PATH yet', () => {
    expect(agyDefaultPaths(ENV, host('win32', []))).toEqual(['C:\\Users\\Ada\\AppData\\Local\\agy\\bin\\agy.exe'])
  })
})

describe('a program of a known name', () => {
  const files = [
    'C:\\Users\\Ada\\AppData\\Roaming\\Claude\\claude-code\\2.1.181\\claude.exe',
    'C:\\Users\\Ada\\AppData\\Local\\agy\\bin\\agy.exe'
  ]
  const win = host('win32', files)

  it('is looked for under the name a person types, with or without its extension', () => {
    expect(findAppProgram('claude', ENV, win)?.app).toBe('the Claude desktop app')
    expect(findAppProgram('Claude.exe', ENV, win)?.app).toBe('the Claude desktop app')
    expect(findAppProgram('agy', ENV, win)?.path).toBe(files[1])
  })

  it('is nothing for any other name, so a lookup of "codex" never returns something else', () => {
    expect(findAppProgram('codex', ENV, win)).toBeUndefined()
    expect(findAppProgram('', ENV, win)).toBeUndefined()
    expect(findAppProgram('C:\\tools\\claude-evil.exe', ENV, win)).toBeUndefined()
  })
})

describe('where a program is', () => {
  const files = ['C:\\Users\\Ada\\AppData\\Roaming\\Claude\\claude-code\\2.1.181\\claude.exe']
  const win = host('win32', files)
  const noPath = { ...ENV, PATH: '' }

  it('is in an app\'s folder when PATH has none', () => {
    expect(locateProgram('claude', noPath, win)).toEqual({ path: files[0], app: 'the Claude desktop app', version: '2.1.181' })
  })

  it('is nothing when neither has it', () => {
    expect(locateProgram('claude', noPath, host('win32', []))).toBeUndefined()
    expect(locateProgram('codex', noPath, win)).toBeUndefined()
  })
})

describe('starting a program by its name', () => {
  const files = ['C:\\Users\\Ada\\AppData\\Roaming\\Claude\\claude-code\\2.1.181\\claude.exe']
  const win = host('win32', files)
  const plan = (file: string): LaunchPlan => ({ file, args: [], windowsVerbatimArguments: false, mode: 'direct' })

  it('is by the name when that is found', () => {
    const asked: string[] = []
    const result = launchProgram((input) => { asked.push(input.command); return plan(input.command) }, { command: 'claude', env: ENV }, win)
    expect(result.file).toBe('claude')
    expect(asked).toEqual(['claude'])
  })

  it('is from where the app keeps it when the name is not found, with everything else as it was', () => {
    const inputs: LaunchInput[] = []
    const result = launchProgram((input) => {
      inputs.push(input)
      if (input.command === 'claude') throw new LaunchError('"claude" was not found on PATH.')
      return plan(input.command)
    }, { command: 'claude', args: ['--version'], cwd: 'C:\\work', env: ENV }, win)
    expect(result.file).toBe(files[0])
    expect(inputs[1]).toEqual({ command: files[0], args: ['--version'], cwd: 'C:\\work', env: ENV })
  })

  it('fails as it first failed when the app has it and it still cannot start', () => {
    expect(() => launchProgram((input) => { throw new LaunchError(`${input.command} is not found`) }, { command: 'claude', env: ENV }, win)).toThrow('claude is not found')
  })

  it('does not try an app for a failure that is not a program missing', () => {
    let calls = 0
    expect(() => launchProgram(() => { calls++; throw new Error('disk on fire') }, { command: 'claude', env: ENV }, win)).toThrow('disk on fire')
    expect(calls).toBe(1)
  })

  it('does not look in an app for a name no app brings', () => {
    let calls = 0
    expect(() => launchProgram(() => { calls++; throw new LaunchError('codex was not found') }, { command: 'codex', env: ENV }, win)).toThrow('codex was not found')
    expect(calls).toBe(1)
  })
})

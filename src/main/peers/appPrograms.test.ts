import { describe, expect, it } from 'vitest'
import { LaunchError, type LaunchInput, type LaunchPlan } from '../mcp/resolveLaunch'
import { claudeInDesktopApp, compareVersions, findAppProgram, launchProgram, type AppHost } from './appPrograms'

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
})

describe('where the Claude desktop app keeps Claude Code', () => {

  it('finds the program the standard app keeps, one folder per version', () => {
    const files = ['C:\\Users\\Ada\\AppData\\Roaming\\Claude\\claude-code\\2.1.181\\claude.exe']
    expect(claudeInDesktopApp(ENV, host('win32', files))).toEqual({ path: files[0], version: '2.1.181', app: 'the Claude desktop app' })
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
})

import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { childEnvironment } from '../childEnv'
import { listShells, resolveShell, type ShellId } from './shellProvider'
import { spawnShell } from './spawnShell'

/** Real shells on a real Windows machine: quoting, exit codes, encoding and the "rmdir with a space" incident. */
const windows = process.platform === 'win32'
const installed = windows ? new Set(listShells().filter((shell) => shell.available).map((shell) => shell.id)) : new Set<ShellId>()
const SHELLS: ShellId[] = ['git-bash', 'powershell', 'pwsh', 'cmd']

let root = ''
let script = ''
let spaced = ''

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cubex-shell-'))
  spaced = join(root, 'dir with spaces é')
  mkdirSync(spaced)
  script = join(spaced, 'echo args.js')
  writeFileSync(script, 'console.log(JSON.stringify(process.argv.slice(2)))\n')
})
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

async function run(id: ShellId, command: string, cwd = root): Promise<{ code: number | null; out: string; err: string }> {
  const spec = resolveShell(id)
  expect(spec.id).toBe(id)
  const child = spawnShell(spec, command, { cwd, env: childEnvironment() })
  let out = ''
  let err = ''
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { out += chunk })
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { err += chunk })
  const code = await new Promise<number | null>((resolve) => child.once('close', resolve))
  return { code, out, err }
}

/** One literal argument for `id`'s own syntax. Values avoid what a shell cannot carry (double quotes in cmd). */
function quote(id: ShellId, value: string): string {
  if (id === 'git-bash') return `'${value.replace(/'/g, `'\\''`)}'`
  if (id === 'cmd') return `"${value}"`
  return `'${value.replace(/'/g, "''")}'`
}

function invoke(id: ShellId, values: string[]): string {
  const node = quote(id, process.execPath)
  const file = quote(id, script)
  const args = values.map((value) => quote(id, value)).join(' ')
  return id === 'powershell' || id === 'pwsh' ? `& ${node} ${file} ${args}` : `${node} ${file} ${args}`
}

const VALUES: Record<'plain' | 'cmd', string[]> = {
  plain: ['a b', "it's", 'p&q', 'x^y', '100%', 'héllo wörld 日本語 ✓', 'C:\\Program Files\\x'],
  // cmd cannot carry a double quote or %VAR% inside one argument.
  cmd: ['a b', 'p&q', 'x^y', '100%', 'héllo wörld 日本語 ✓', 'C:\\Program Files\\x']
}

describe.skipIf(!windows)('real Windows shells (skipped off Windows: they need cmd.exe, Git Bash or PowerShell)', () => {
  for (const id of SHELLS) {
    describe.skipIf(!installed.has(id))(id, () => {
      it('passes quotes, %, ^, &, spaces and non-ASCII to a program unchanged, from a path with spaces', async () => {
        const values = id === 'cmd' ? VALUES.cmd : VALUES.plain
        const result = await run(id, invoke(id, values), spaced)
        expect(result.err).toBe('')
        expect(result.code).toBe(0)
        expect(JSON.parse(result.out.trim())).toEqual(values)
      })

      it.skipIf(id === 'cmd')('prints non-ASCII from its own built-ins as UTF-8', async () => {
        const text = 'héllo wörld 日本語'
        const command = id === 'git-bash' ? `echo '${text}'` : `Write-Output '${text}'`
        const result = await run(id, command)
        expect(result.out.trim()).toBe(text)
      })

      // cmd.exe built-ins (echo, dir) write OEM bytes to a pipe whatever chcp says, so only programs that
      // follow the console code page switch to UTF-8. The switch itself is what the argv guarantees.
      it.skipIf(id !== 'cmd')('switches the console code page to UTF-8 before the command runs', async () => {
        const result = await run(id, 'chcp')
        expect(result.out).toContain('65001')
      })

      it('reports the exit code of the last native command', async () => {
        const exit = (code: number): string => id === 'powershell' || id === 'pwsh'
          ? `& ${quote(id, process.execPath)} -e ${quote(id, `process.exit(${code})`)}`
          : `${quote(id, process.execPath)} -e ${id === 'cmd' ? `"process.exit(${code})"` : `'process.exit(${code})'`}`
        expect((await run(id, exit(3))).code).toBe(3)
        expect((await run(id, exit(0))).code).toBe(0)
      })

      it('removes only the quoted directory when a path contains a space', async () => {
        const base = mkdtempSync(join(root, 'incident-'))
        mkdirSync(join(base, 'a b'))
        mkdirSync(join(base, 'a'))
        writeFileSync(join(base, 'a b', 'file.txt'), 'x')
        writeFileSync(join(base, 'a', 'keep.txt'), 'y')
        const target = join(base, 'a b')
        const command = id === 'git-bash' ? `rm -rf ${quote(id, target)}`
          : id === 'cmd' ? `rmdir /s /q "${target}"`
            : `Remove-Item -Recurse -Force -LiteralPath ${quote(id, target)}`
        const result = await run(id, command)
        expect(result.code).toBe(0)
        expect(existsSync(target)).toBe(false)
        expect(existsSync(join(base, 'a', 'keep.txt'))).toBe(true)
      })
    })
  }

  describe.skipIf(!installed.has('powershell') && !installed.has('pwsh'))('PowerShell exit codes', () => {
    const id: ShellId = installed.has('pwsh') ? 'pwsh' : 'powershell'

    it('is 1 for a failing cmdlet and 0 for a native command that only wrote to stderr', async () => {
      expect((await run(id, 'Get-Item C:\\definitely\\not\\here')).code).toBe(1)
      const noisy = `& ${quote(id, process.execPath)} -e ${quote(id, "console.error('warn'); process.exit(0)")} 2>&1`
      expect((await run(id, noisy)).code).toBe(0)
      expect((await run(id, 'exit 5')).code).toBe(5)
      expect((await run(id, "throw 'boom'")).code).toBe(1)
      expect((await run(id, 'Write-Output ok')).code).toBe(0)
    }, 20_000)

    it('does not leak progress records or the profile into stdout', async () => {
      const result = await run(id, 'Write-Output ok')
      expect(result.out.trim()).toBe('ok')
      expect(result.err).toBe('')
    })
  })
})

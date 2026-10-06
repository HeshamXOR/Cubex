import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findProjectConfig } from './projectConfig'

const temps: string[] = []
function folder(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'cubex-config-'))
  temps.push(root)
  for (const name of files) {
    const file = join(root, name)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '{}')
  }
  return root
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('findProjectConfig', () => {
  it('finds a tsconfig.json or a jsconfig.json at the root', () => {
    const ts = folder(['tsconfig.json'])
    const js = folder(['jsconfig.json'])
    expect(findProjectConfig(ts)).toBe(join(ts, 'tsconfig.json'))
    expect(findProjectConfig(js)).toBe(join(js, 'jsconfig.json'))
  })

  it('prefers the root config over one in a package below it', () => {
    const root = folder(['tsconfig.json', 'packages/app/tsconfig.json'])
    expect(findProjectConfig(root)).toBe(join(root, 'tsconfig.json'))
  })

  it('looks two folders down, for a monorepo whose root has no config', () => {
    const near = folder(['apps/web/tsconfig.json'])
    expect(findProjectConfig(near)).toBe(join(near, 'apps', 'web', 'tsconfig.json'))
    const far = folder(['a/b/c/tsconfig.json'])
    expect(findProjectConfig(far)).toBeUndefined()
  })

  it('ignores dependencies, build output and hidden folders', () => {
    const root = folder(['node_modules/pkg/tsconfig.json', 'dist/tsconfig.json', '.cache/tsconfig.json', 'src/index.ts'])
    expect(findProjectConfig(root)).toBeUndefined()
  })

  it('answers undefined for a folder that does not exist', () => {
    expect(findProjectConfig(join(tmpdir(), 'cubex-config-missing-folder'))).toBeUndefined()
  })
})

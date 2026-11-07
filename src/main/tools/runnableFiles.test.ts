import { describe, expect, it } from 'vitest'
import { isRunnableFile } from './runnableFiles'

describe('isRunnableFile', () => {
  it.each([
    'package.json', 'packages/core/package.json', 'C:\\repo\\Makefile', 'conftest.py', 'tests/conftest.py', 'vitest.config.ts',
    'electron-builder.config.js', '.github/workflows/ci.yml', '.github\\workflows\\ci.yml', 'pyproject.toml', '.npmrc', '.envrc'
  ])('stops for %s', (path) => expect(isRunnableFile(path)).toBe(true))

  it.each([
    'src/app.ts', 'README.md', 'package.json.bak', 'src/package.ts', 'docs/makefile.md', '.github/CODEOWNERS', 'tsconfig.json', ''
  ])('does not stop for %s', (path) => expect(isRunnableFile(path)).toBe(false))
})

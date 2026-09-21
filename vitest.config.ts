import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@core': resolve(root, 'packages/core/src'),
      '@local': resolve(root, 'packages/local/src'),
      '@shared': resolve(root, 'src/shared')
    }
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/**/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts', '**/types/**']
    }
  }
})

import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = dirname(fileURLToPath(import.meta.url))

/**
 * The eval suite (evals/). Kept apart from vitest.config.ts on purpose: `npm test` includes only packages/, src/
 * and scripts/, so a run that calls a paid model is never started by accident.
 */
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
    include: ['evals/**/*.eval.ts'],
    // Each run has its own deadline (task.json timeoutSec) and the suite its own (CUBEX_EVAL_SUITE_TIMEOUT_MIN).
    testTimeout: 0,
    hookTimeout: 60_000,
    // Runs go one after another inside the file; the files themselves share one process.
    fileParallelism: false
  }
})

import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const root = dirname(fileURLToPath(import.meta.url))
const alias = {
  '@core': resolve(root, 'packages/core/src'),
  '@local': resolve(root, 'packages/local/src'),
  '@shared': resolve(root, 'src/shared'),
  '@main': resolve(root, 'src/main'),
  '@renderer': resolve(root, 'src/renderer/src')
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      rollupOptions: {
        // The diagnostics checker is its own chunk: DiagnosticsManager starts
        // out/main/tsWorker.js as a worker thread.
        input: {
          index: resolve(root, 'src/main/index.ts'),
          tsWorker: resolve(root, 'src/main/diagnostics/tsWorker.ts')
        },
        output: { entryFileNames: '[name].js' }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'src/preload/index.ts') },
        // Sandboxed preload scripts must be CommonJS (.js), not ESM (.mjs).
        output: { format: 'cjs', entryFileNames: '[name].js' }
      }
    }
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    resolve: { alias },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'src/renderer/index.html') },
        // Preview seeds are sample data for the browser preview. Nothing in the packaged app reaches them, so they
        // count as free of side effects, which lets the bundler leave them out instead of keeping their setup code.
        treeshake: { moduleSideEffects: (id) => !/[\\/]renderer[\\/]src[\\/]lib[\\/](seeds[\\/]|previewSeed|previewStream)/.test(id) }
      }
    }
  }
})

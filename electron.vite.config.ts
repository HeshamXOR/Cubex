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
        input: { index: resolve(root, 'src/main/index.ts') }
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
        input: { index: resolve(root, 'src/renderer/index.html') }
      }
    }
  }
})

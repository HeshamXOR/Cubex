import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Standalone renderer dev server (browser preview / renderer-only development).
// The Electron app itself uses electron.vite.config.ts.
const root = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: resolve(root, 'src/renderer'),
  resolve: {
    alias: {
      '@core': resolve(root, 'packages/core/src'),
      '@local': resolve(root, 'packages/local/src'),
      '@shared': resolve(root, 'src/shared'),
      '@renderer': resolve(root, 'src/renderer/src')
    }
  },
  plugins: [react()],
  server: { port: 5199, strictPort: true }
})

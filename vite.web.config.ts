import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Renderer-only web config for DESIGN REVIEW. Runs the exact React renderer in a
 * plain browser (no Electron), where `window.cubex` is undefined so the app uses
 * `browserStub()`. Append `?seed=1` to the URL for representative mock data
 * (conversations grouped by project, a chat with reasoning + tool cards).
 *
 * This is a dev-only harness — it never ships and never touches the Electron build.
 */
const root = dirname(fileURLToPath(import.meta.url))
const alias = {
  '@core': resolve(root, 'packages/core/src'),
  '@local': resolve(root, 'packages/local/src'),
  '@shared': resolve(root, 'src/shared'),
  '@main': resolve(root, 'src/main'),
  '@renderer': resolve(root, 'src/renderer/src')
}

export default defineConfig({
  root: resolve(root, 'src/renderer'),
  resolve: { alias },
  plugins: [react()],
  server: { port: 5199, strictPort: true }
})

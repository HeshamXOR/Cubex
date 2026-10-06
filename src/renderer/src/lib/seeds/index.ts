import type { CubexAPI } from '../../../../shared/ipc'

/**
 * What a preview seed contributes to the browser preview (`?seed=1`). A file in this folder that exports
 * `seed` is picked up automatically, so a feature adds its own sample data without editing previewSeed.ts or api.ts.
 *
 * Both parts are optional and neither may import `../previewSeed` or the store statically: those import
 * this folder, so a static import would be a cycle. Use `await import('../previewSeed')` inside an API
 * method when it needs shared sample data.
 */
export interface PreviewSeed {
  /** Store state for the URL flags, as plain data. Runs once, after the first loads. */
  state?: (flags: URLSearchParams) => Record<string, unknown> | undefined
  /** Preview-only replacements for API methods. They win over the defaults. */
  api?: (flags: URLSearchParams) => Partial<CubexAPI>
}

// Only the dev server and the browser preview load seeds. `import.meta.env.DEV` is replaced at build time, so the
// packaged app contains none of this sample data.
const modules: Record<string, { seed?: PreviewSeed }> = import.meta.env.DEV
  ? import.meta.glob<{ seed: PreviewSeed }>(['./*.ts', '!./index.ts', '!./*.test.ts'], { eager: true })
  : {}

const seeds: PreviewSeed[] = Object.entries(modules)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, mod]) => mod.seed)
  .filter((seed): seed is PreviewSeed => !!seed)

export const seededState = (flags: URLSearchParams): Record<string, unknown> =>
  Object.assign({}, ...seeds.map((seed) => seed.state?.(flags)))

export const seededApi = (flags: URLSearchParams): Partial<CubexAPI> =>
  Object.assign({}, ...seeds.map((seed) => seed.api?.(flags)))

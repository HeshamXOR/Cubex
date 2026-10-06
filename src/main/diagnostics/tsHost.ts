import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as nodePath from 'node:path'
import type * as TS from 'typescript'

/** The TypeScript compiler API, as typed by the repo's own typescript package. Loaded at runtime from elsewhere. */
export type TypeScriptApi = typeof TS

export interface LoadedTypeScript {
  ts: TypeScriptApi
  version: string
  /** `workspace`: the project's own package (what its editor uses); `app`: a package the app can find. */
  source: 'workspace' | 'app'
}

/** Why no checker can run, written so the reader knows what to do about it. */
export const NO_TYPESCRIPT_REASON =
  'TypeScript was not found for this folder, so errors are not checked after edits. Run npm install -D typescript in the project to turn it on.'

function resolverFor(from: string): NodeRequire {
  return createRequire(nodePath.join(from, 'cubex-resolve.js'))
}

function tryLoad(from: string): TypeScriptApi | undefined {
  try {
    const mod = resolverFor(from)('typescript') as TypeScriptApi
    return typeof mod?.createLanguageService === 'function' && typeof mod.version === 'string' ? mod : undefined
  } catch {
    return undefined
  }
}

/** The manifest of the typescript package `from` resolves. Packages that do not export it are found through their entry point. */
function manifestPath(resolver: NodeRequire): string | undefined {
  try {
    return resolver.resolve('typescript/package.json')
  } catch { /* not exported, or not installed: try the entry point */ }
  try {
    let dir = nodePath.dirname(resolver.resolve('typescript'))
    for (let level = 0; level < 4; level++, dir = nodePath.dirname(dir)) {
      const candidate = nodePath.join(dir, 'package.json')
      if (existsSync(candidate)) return candidate
    }
  } catch { /* not installed */ }
  return undefined
}

function probeVersion(from: string): string | undefined {
  try {
    const path = manifestPath(resolverFor(from))
    if (!path) return undefined
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve `typescript` the way Node does from the workspace root (its node_modules and its parents), so the
 * project is checked by the compiler version it builds with. Without one, fall back to `fallbackDir`'s package
 * (the app's own install, if any). A package without the language service API (a native-port stub) is skipped.
 * This executes the compiler, which takes hundreds of milliseconds and tens of megabytes: only the worker calls it.
 */
export function loadTypeScript(root: string, fallbackDir?: string): LoadedTypeScript | { reason: string } {
  const own = tryLoad(root)
  if (own) return { ts: own, version: own.version, source: 'workspace' }
  const app = fallbackDir ? tryLoad(fallbackDir) : undefined
  if (app) return { ts: app, version: app.version, source: 'app' }
  return { reason: NO_TYPESCRIPT_REASON }
}

/**
 * Which typescript package `loadTypeScript` would pick, found by reading its manifest instead of running it, so the
 * main thread can answer "is a checker possible here" without loading a compiler. A stub that the worker later
 * refuses is reported by the worker.
 */
export function probeTypeScript(root: string, fallbackDir?: string): { version: string; source: 'workspace' | 'app' } | { reason: string } {
  const own = probeVersion(root)
  if (own) return { version: own, source: 'workspace' }
  const app = fallbackDir ? probeVersion(fallbackDir) : undefined
  if (app) return { version: app, source: 'app' }
  return { reason: NO_TYPESCRIPT_REASON }
}

export { ProjectChecker } from './tsChecker'
export type { CheckerOptions } from './tsChecker'

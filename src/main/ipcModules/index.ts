import type { IpcContext, IpcModule } from './context'

// Every module in this folder registers itself. Tests and the registry itself are not modules.
const modules = import.meta.glob<IpcModule>(['./*.ts', '!./index.ts', '!./context.ts', '!./*.test.ts'], { eager: true })

/** Run each module's `register`; returns the cleanups modules asked for. */
export function registerIpcModules(ctx: IpcContext): Array<() => void> {
  const cleanups: Array<() => void> = []
  for (const [file, mod] of Object.entries(modules).sort(([a], [b]) => a.localeCompare(b))) {
    if (typeof mod.register !== 'function') throw new Error(`IPC module ${file} must export a register function.`)
    const cleanup = mod.register(ctx)
    if (typeof cleanup === 'function') cleanups.push(cleanup)
  }
  return cleanups
}

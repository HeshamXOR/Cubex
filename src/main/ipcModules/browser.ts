import { IPC, type BrowserBounds } from '@shared/ipc'
import { BrowserHost } from '../browser/BrowserHost'
import type { IpcContext } from './context'

function parseBounds(value: unknown): BrowserBounds {
  const box = value as Partial<BrowserBounds> | null
  const whole = (n: unknown): number => {
    if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 100_000) throw new Error('Invalid browser bounds.')
    return Math.round(n)
  }
  const bounds = { x: whole(box?.x), y: whole(box?.y), width: whole(box?.width), height: whole(box?.height) }
  if (bounds.width < 0 || bounds.height < 0) throw new Error('Invalid browser bounds.')
  return bounds
}

/** The agent's browser, and the pane that lets the person watch and use it. */
export function register(ctx: IpcContext): () => void {
  const host = new BrowserHost({
    getWindow: ctx.getWindow,
    onState: (state) => ctx.send(IPC.browserStateChanged, state)
  })
  ctx.chat.setBrowser(host)
  ctx.handle(IPC.browserState, (id: unknown) => host.state(ctx.taskIdArg(id)))
  ctx.handle(IPC.browserAttach, (id: unknown, bounds: unknown) => {
    // The renderer measures in its own zoomed pixels, and the window in unzoomed ones.
    const zoom = ctx.getWindow()?.webContents.getZoomFactor() ?? 1
    const box = parseBounds(bounds)
    host.attach(ctx.taskIdArg(id), { x: Math.round(box.x * zoom), y: Math.round(box.y * zoom), width: Math.round(box.width * zoom), height: Math.round(box.height * zoom) })
  })
  ctx.handle(IPC.browserDetach, () => host.detach())
  ctx.handle(IPC.browserOpen, (id: unknown, url: unknown) => {
    if (typeof url !== 'string') throw new Error('Give the address to open.')
    return host.openByPerson(ctx.taskIdArg(id), url)
  })
  ctx.handle(IPC.browserBack, (id: unknown) => host.goBack(ctx.taskIdArg(id)))
  ctx.handle(IPC.browserReload, (id: unknown) => host.reload(ctx.taskIdArg(id)))
  return () => {
    ctx.chat.setBrowser(undefined)
    host.dispose()
  }
}

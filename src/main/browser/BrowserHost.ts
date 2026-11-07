import { BaseWindow, session as electronSession, WebContentsView, type BrowserWindow, type Rectangle, type Session, type WebContents } from 'electron'
import { checkUrlSyntax } from '../tools/netGuard'
import type { BrowserDriver, ConsoleEntry, PageState, Screenshot } from './browserTool'
import { clickScript, hasTextScript, snapshotScript, typeScript, type ActionOutcome, type PageSnapshot } from './pageScripts'
import { isLocalHost, normalHost, parseBrowserUrl, sameSite } from './urls'
import type { BrowserState } from '@shared/ipc'

/** The size a page has while nobody is looking at it. */
const WIDTH = 1280
const HEIGHT = 800
const MAX_TABS = 6
const MAX_CONSOLE = 200
const LOAD_TIMEOUT_MS = 30_000
/** A page is settled when nothing has loaded for this long, or when this much time has passed regardless. */
const QUIET_MS = 250
const SETTLE_LIMIT_MS = 3_000
const WAIT_FOR_MS = 10_000
/** How long a page that has just come to the top takes to draw. */
const CAPTURE_SETTLE_MS = 150
/** A navigation this soon after the person clicked in the page is theirs, not the agent's. */
const PERSON_MS = 1_000
/** The world code from pageScripts runs in. Any number that is not 0, which is the page's own. */
const WORLD = 1_917

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface Tab {
  conversationId: string
  view: WebContentsView
  /** Hosts this task may reach, besides this machine. */
  allowed: Set<string>
  console: ConsoleEntry[]
  errors: number
  inFlight: Set<number>
  lastLoad: number
  blocked?: string
  lastPersonInput: number
  opened: boolean
  usedAt: number
}

export interface BrowserHostOptions {
  getWindow: () => BrowserWindow | null
  onState: (state: BrowserState) => void
}

/**
 * The browser the agent uses, and the person can watch. A task has a page of its own, in a session of its own that is kept in
 * memory: it holds none of the person's sign-ins, and nothing is written to disk. It cannot download, open windows, ask for
 * permissions, or wander off to a host nobody approved.
 *
 * A page renders only inside a window on screen, so a page nobody is looking at lives in a window that is shown but cannot be
 * seen: transparent, off every display and off the taskbar. Each page has its own, side by side, because a page covered by
 * another one stops drawing. The pane moves the page into the main window and back.
 */
export class BrowserHost implements BrowserDriver {
  private readonly tabs = new Map<string, Tab>()
  private readonly ghosts = new Map<string, BaseWindow>()
  private ghostSlot = 0
  private watchingMainWindow = false
  private attached: Tab | undefined
  private disposed = false

  constructor(private readonly options: BrowserHostOptions) {}

  // --- The window nobody sees ------------------------------------------------------------------

  private ghostWindow(tab: Tab): BaseWindow {
    const existing = this.ghosts.get(tab.conversationId)
    if (existing && !existing.isDestroyed()) return existing
    const x = -32000 + (this.ghostSlot++ % (MAX_TABS + 1)) * (WIDTH + 20)
    const ghost = new BaseWindow({
      show: false, x, y: -32000, width: WIDTH, height: HEIGHT, frame: false, opacity: 0, skipTaskbar: true, focusable: false, resizable: false, hasShadow: false, title: 'Cubex browser'
    })
    ghost.setIgnoreMouseEvents(true)
    ghost.showInactive()
    this.ghosts.set(tab.conversationId, ghost)
    if (!this.watchingMainWindow) {
      // These windows must not keep the app alive after the real one closes.
      this.watchingMainWindow = true
      this.options.getWindow()?.once('closed', () => this.dispose())
    }
    return ghost
  }

  private parkInGhost(tab: Tab): void {
    const ghost = this.ghostWindow(tab)
    ghost.contentView.addChildView(tab.view)
    tab.view.setBounds({ x: 0, y: 0, width: WIDTH, height: HEIGHT })
  }

  // --- Tabs ------------------------------------------------------------------------------------

  private makeSession(conversationId: string): Session {
    // No `persist:` prefix: in memory only, and gone when the app quits.
    const session = electronSession.fromPartition(`cubex-browser-${conversationId}`)
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    session.setPermissionCheckHandler(() => false)
    session.on('will-download', (event) => event.preventDefault())
    return session
  }

  private tabFor(conversationId: string): Tab {
    const existing = this.tabs.get(conversationId)
    if (existing) {
      existing.usedAt = Date.now()
      return existing
    }
    this.closeOldest()
    const session = this.makeSession(conversationId)
    const view = new WebContentsView({
      webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false, devTools: false }
    })
    const tab: Tab = {
      conversationId, view, allowed: new Set(), console: [], errors: 0, inFlight: new Set(), lastLoad: Date.now(), lastPersonInput: 0, opened: false, usedAt: Date.now()
    }
    this.tabs.set(conversationId, tab)
    this.watch(tab, session)
    this.parkInGhost(tab)
    return tab
  }

  private closeOldest(): void {
    if (this.tabs.size < MAX_TABS) return
    const oldest = [...this.tabs.values()].filter((tab) => tab !== this.attached).sort((a, b) => a.usedAt - b.usedAt)[0]
    if (oldest) this.close(oldest.conversationId)
  }

  private mayVisit(tab: Tab, url: string): boolean {
    const parsed = parseBrowserUrl(url)
    if (!parsed.ok) return false
    const host = parsed.url.hostname
    return isLocalHost(host) || [...tab.allowed].some((allowed) => sameSite(allowed, host))
  }

  private note(tab: Tab, entry: ConsoleEntry): void {
    tab.console.push(entry)
    if (tab.console.length > MAX_CONSOLE) tab.console.shift()
    tab.errors++
  }

  private watch(tab: Tab, session: Session): void {
    const contents = tab.view.webContents
    const push = (): void => this.pushState(tab)

    const guard = (event: { preventDefault: () => void }, url: string): void => {
      if (this.mayVisit(tab, url)) return
      if (Date.now() - tab.lastPersonInput < PERSON_MS) {
        // The person clicked a link in the page they are watching: that is their approval.
        const parsed = parseBrowserUrl(url)
        if (parsed.ok) { tab.allowed.add(normalHost(parsed.url.hostname)); return }
      }
      event.preventDefault()
      tab.blocked = url.slice(0, 300)
      push()
    }
    contents.on('will-navigate', (event) => guard(event, event.url))
    contents.on('will-frame-navigate', (event) => { if (event.isMainFrame) guard(event, event.url) })
    contents.on('will-redirect', (event) => guard(event, event.url))
    // A link that wants a new window opens here instead, under the same rule.
    contents.setWindowOpenHandler(({ url }) => {
      if (this.mayVisit(tab, url)) void contents.loadURL(url).catch(() => undefined)
      else tab.blocked = url.slice(0, 300)
      return { action: 'deny' }
    })
    contents.on('input-event', (_event, input) => {
      if (input.type === 'mouseDown' || input.type === 'keyDown') tab.lastPersonInput = Date.now()
    })

    // Positional arguments: the object form of this event arrives in a later Electron.
    contents.on('console-message', (_event, level, message, line, source) => {
      if (level < 2 || /^%?c?Electron Security Warning/.test(message)) return
      const at = source && !source.startsWith('data:') ? `${source}:${line}` : undefined
      if (level === 3) this.note(tab, { level: 'error', text: message.slice(0, 2000), ...(at ? { at } : {}) })
      else { tab.console.push({ level: 'warning', text: message.slice(0, 2000), ...(at ? { at } : {}) }); if (tab.console.length > MAX_CONSOLE) tab.console.shift() }
    })
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      // -3 is a navigation that was stopped or replaced, which is not a failure of the page.
      if (code !== -3 && isMainFrame) this.note(tab, { level: 'request', text: `${description} loading ${url}` })
    })
    contents.on('did-start-navigation', (event) => {
      if (event.isMainFrame && !event.isSameDocument) { tab.console = []; tab.errors = 0 }
    })
    for (const signal of ['did-start-loading', 'did-stop-loading', 'page-title-updated', 'did-navigate', 'did-navigate-in-page'] as const) contents.on(signal as 'did-stop-loading', push)

    session.webRequest.onBeforeRequest((details, callback) => {
      // A page out on the web has no business talking to this machine or the local network. Names are checked by their spelling,
      // so a public name that resolves to a private address gets past this: the session still holds nothing to steal.
      const from = details.webContents?.getURL() ?? ''
      const fromLocal = !from || isInternal(from)
      if (!fromLocal && details.resourceType !== 'mainFrame' && isInternal(details.url)) return callback({ cancel: true })
      if (details.resourceType !== 'webSocket') { tab.inFlight.add(details.id); tab.lastLoad = Date.now() }
      callback({})
    })
    session.webRequest.onCompleted((details) => {
      tab.inFlight.delete(details.id)
      tab.lastLoad = Date.now()
      if (details.statusCode >= 400) this.note(tab, { level: 'request', text: `${details.statusCode} ${details.method} ${details.url.slice(0, 500)}` })
    })
    session.webRequest.onErrorOccurred((details) => {
      tab.inFlight.delete(details.id)
      tab.lastLoad = Date.now()
      if (details.error !== 'net::ERR_ABORTED') this.note(tab, { level: 'request', text: `${details.error} ${details.method} ${details.url.slice(0, 500)}` })
    })
  }

  private pushState(tab: Tab): void {
    if (this.disposed) return
    this.options.onState(this.stateOf(tab))
  }

  private stateOf(tab: Tab): BrowserState {
    const contents = tab.view.webContents
    return {
      conversationId: tab.conversationId,
      open: tab.opened,
      url: contents.isDestroyed() ? '' : contents.getURL(),
      title: contents.isDestroyed() ? '' : contents.getTitle(),
      loading: contents.isDestroyed() ? false : contents.isLoading(),
      canGoBack: contents.isDestroyed() ? false : contents.navigationHistory.canGoBack()
    }
  }

  // --- What the tool calls ---------------------------------------------------------------------

  private async settle(tab: Tab, signal?: AbortSignal): Promise<void> {
    const contents = tab.view.webContents
    const until = Date.now() + SETTLE_LIMIT_MS
    await wait(60)
    while (Date.now() < until && !signal?.aborted && !contents.isDestroyed()) {
      if (!contents.isLoading() && tab.inFlight.size === 0 && Date.now() - tab.lastLoad >= QUIET_MS) return
      await wait(50)
    }
  }

  private run<T>(contents: WebContents, code: string): Promise<T> {
    return contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]) as Promise<T>
  }

  private async snapshot(tab: Tab, maxChars: number): Promise<PageState> {
    const page = await this.run<PageSnapshot>(tab.view.webContents, snapshotScript(maxChars))
    const blocked = tab.blocked
    delete tab.blocked
    return { ...page, errorCount: tab.errors, ...(blocked ? { blocked } : {}) }
  }

  async navigate(conversationId: string, url: URL, maxChars: number, signal?: AbortSignal): ReturnType<BrowserDriver['navigate']> {
    const tab = this.tabFor(conversationId)
    // The ask gate has already stopped for this host, if it needed the person.
    if (!isLocalHost(url.hostname)) tab.allowed.add(normalHost(url.hostname))
    const contents = tab.view.webContents
    tab.opened = true
    tab.console = []
    tab.errors = 0
    delete tab.blocked
    try {
      await Promise.race([
        contents.loadURL(url.href),
        wait(LOAD_TIMEOUT_MS).then(() => { contents.stop(); throw new Error(`The page did not finish loading in ${LOAD_TIMEOUT_MS / 1000} seconds.`) })
      ])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Redirects and scripts replacing the page reject the original load, and the page that replaced it is fine.
      if (!/ERR_ABORTED/.test(message)) {
        this.pushState(tab)
        if (/ERR_CONNECTION_REFUSED/.test(message)) return { ok: false, reason: `Nothing is answering at ${url.origin}. Is the server running?` }
        return { ok: false, reason: `Could not open ${url.href}: ${message.replace(/^.*?(ERR_[A-Z_]+).*$/s, '$1')}` }
      }
    }
    await this.settle(tab, signal)
    this.pushState(tab)
    return { ok: true, state: await this.snapshot(tab, maxChars) }
  }

  async read(conversationId: string, maxChars: number, waitForText?: string, signal?: AbortSignal): Promise<PageState | undefined> {
    const tab = this.tabs.get(conversationId)
    if (!tab?.opened) return undefined
    const contents = tab.view.webContents
    if (waitForText) {
      const until = Date.now() + WAIT_FOR_MS
      while (Date.now() < until && !signal?.aborted) {
        if (await this.run<boolean>(contents, hasTextScript(waitForText))) break
        await wait(150)
      }
    }
    await this.settle(tab, signal)
    return this.snapshot(tab, maxChars)
  }

  async act(conversationId: string, action: Parameters<BrowserDriver['act']>[1], maxChars: number, signal?: AbortSignal): ReturnType<BrowserDriver['act']> {
    const tab = this.tabs.get(conversationId)
    if (!tab?.opened) return { outcome: { ok: false, reason: 'No page is open. Call this with action "navigate" first.' } }
    const contents = tab.view.webContents
    const code = action.kind === 'click' ? clickScript(action.ref) : typeScript(action.ref, action.text, action.submit)
    const outcome = await this.run<ActionOutcome>(contents, code)
    if (!outcome.ok) return { outcome }
    await this.settle(tab, signal)
    return { outcome, state: await this.snapshot(tab, maxChars) }
  }

  console(conversationId: string): ConsoleEntry[] | undefined {
    const tab = this.tabs.get(conversationId)
    return tab?.opened ? [...tab.console] : undefined
  }

  async screenshot(conversationId: string): Promise<Screenshot | undefined> {
    const tab = this.tabs.get(conversationId)
    if (!tab?.opened) return undefined
    const contents = tab.view.webContents
    const showing = this.attached === tab
    let image = await contents.capturePage().catch(() => undefined)
    if (!image || image.isEmpty()) {
      // The pane is showing it in a minimized window, say. Borrow it back for a moment.
      this.parkInGhost(tab)
      await wait(CAPTURE_SETTLE_MS * 2)
      image = await contents.capturePage()
      if (showing && this.attached === tab && this.attachedBounds) this.attach(conversationId, this.attachedBounds)
    }
    if (image.isEmpty()) throw new Error('The page could not be captured.')
    const size = image.getSize()
    return { mediaType: 'image/jpeg', data: image.toJPEG(70).toString('base64'), width: size.width, height: size.height }
  }

  // --- What the pane calls ---------------------------------------------------------------------

  private attachedBounds: Rectangle | undefined

  state(conversationId: string): BrowserState {
    const tab = this.tabs.get(conversationId)
    return tab ? this.stateOf(tab) : { conversationId, open: false, url: '', title: '', loading: false, canGoBack: false }
  }

  /** Show this task's page in the main window at these bounds. */
  attach(conversationId: string, bounds: Rectangle): void {
    const window = this.options.getWindow()
    if (!window || window.isDestroyed()) return
    const tab = this.tabFor(conversationId)
    if (this.attached && this.attached !== tab) this.parkInGhost(this.attached)
    window.contentView.addChildView(tab.view)
    tab.view.setBounds(bounds)
    this.attached = tab
    this.attachedBounds = bounds
  }

  /** Put the page away, because the pane closed or something has to draw above it. It keeps running. */
  detach(conversationId?: string): void {
    const tab = this.attached
    if (!tab || (conversationId && tab.conversationId !== conversationId)) return
    this.parkInGhost(tab)
    this.attached = undefined
    this.attachedBounds = undefined
  }

  /** The person typed an address, which approves its host. */
  async openByPerson(conversationId: string, input: string): Promise<BrowserState> {
    const parsed = parseBrowserUrl(input)
    if (!parsed.ok) throw new Error(parsed.reason)
    const tab = this.tabFor(conversationId)
    if (!isLocalHost(parsed.url.hostname)) tab.allowed.add(normalHost(parsed.url.hostname))
    tab.opened = true
    await tab.view.webContents.loadURL(parsed.url.href).catch(() => undefined)
    return this.stateOf(tab)
  }

  goBack(conversationId: string): void {
    const contents = this.tabs.get(conversationId)?.view.webContents
    if (contents?.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
  }

  reload(conversationId: string): void {
    this.tabs.get(conversationId)?.view.webContents.reload()
  }

  /** Forget a task's page. */
  close(conversationId: string): void {
    const tab = this.tabs.get(conversationId)
    if (!tab) return
    if (this.attached === tab) { this.attached = undefined; this.attachedBounds = undefined }
    this.tabs.delete(conversationId)
    try {
      tab.view.webContents.close()
    } catch { /* already gone */ }
    const ghost = this.ghosts.get(conversationId)
    this.ghosts.delete(conversationId)
    if (ghost && !ghost.isDestroyed()) ghost.destroy()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const id of [...this.tabs.keys()]) this.close(id)
  }
}

/** Whether a URL points at this machine or a private network, judged by how it is written. */
function isInternal(url: string): boolean {
  const parsed = parseBrowserUrl(url)
  if (!parsed.ok) return false
  return isLocalHost(parsed.url.hostname) || !checkUrlSyntax(parsed.url.href).ok
}

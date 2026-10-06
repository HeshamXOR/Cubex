import { app, BrowserWindow, Menu, session, shell } from 'electron'
import { join, relative, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { registerIpc } from './ipc'
import { initDb, closeDb } from './db'
import { getSettings } from './config'
import { installContextMenu } from './contextMenu'
import { logger } from './logger'
import { loadWindowState, trackWindow, windowPlacement } from './windowShell'

// Windows resolves bare program names from the current directory before PATH.
// Every child Cubex spawns has a workspace cwd, so a repository's `git.exe` or
// `ls.bat` would run instead of the real tool. libuv and cmd.exe honour this.
if (process.platform === 'win32') process.env.NoDefaultCurrentDirectoryInExePath = '1'

// Windows ties toast notifications and the taskbar button to this id. The installer's shortcut carries the same one.
if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? 'dev.cubex.harness' : process.execPath)

let mainWindow: BrowserWindow | null = null
let ipc: { dispose: () => void; cancelChats: () => void } | null = null

/**
 * The renderer may only load files from its own bundle. Model-controlled
 * markup must never reach a UNC share (NTLM hash leak) or arbitrary local
 * files through a `file:` URL, whatever the CSP thinks `'self'` means.
 */
function lockDownSession(): void {
  const rendererRoot = join(__dirname, '../renderer')
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (!details.url.startsWith('file:')) return callback({})
    try {
      const url = new URL(details.url)
      const rel = relative(rendererRoot, fileURLToPath(url))
      const inside = !url.host && rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
      callback({ cancel: !inside })
    } catch {
      callback({ cancel: true })
    }
  })
  // Camera, microphone, geolocation, notifications…: nothing in Cubex needs them.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'clipboard-sanitized-write'))
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write')
}

function createWindow(): void {
  const settings = getSettings()
  const saved = loadWindowState()
  const placed = windowPlacement(saved)
  mainWindow = new BrowserWindow({
    width: placed.width,
    height: placed.height,
    ...(placed.x !== undefined && placed.y !== undefined ? { x: placed.x, y: placed.y } : {}),
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#1f1f21',
    title: 'Cubex',
    // Window / taskbar icon (dev + packaged; resources/ is bundled via files config).
    icon: join(__dirname, '../../resources/icon.png'),
    // Frameless: Cubex draws its own title bar, tabs and window controls.
    frame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition: process.platform === 'darwin' ? { x: 14, y: 15 } : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Security hardening: renderer is sandboxed and has no Node access.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged
    }
  })

  // A reload orphans the running turn in main and drops the live transcript.
  if (app.isPackaged) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      const key = input.key.toLowerCase()
      if (key === 'f5' || ((input.control || input.meta) && key === 'r')) event.preventDefault()
    })
  }

  mainWindow.on('closed', () => {
    // macOS keeps the app alive without a window: stop turns that have no UI
    // left to show permission prompts to, and never send to a destroyed window.
    ipc?.cancelChats()
    mainWindow = null
  })

  mainWindow.on('ready-to-show', () => {
    if (settings.general.startMaximized || saved.maximized) mainWindow?.maximize()
    mainWindow?.show()
  })

  installContextMenu(mainWindow)
  trackWindow(mainWindow, saved)

  // Open external links in the OS browser — but ONLY http(s)/mailto. Chat
  // responses are model-controlled markdown; without this allowlist a link like
  // file://, smb://, or a custom protocol handler would be handed straight to
  // the OS (a classic Electron RCE/SSRF vector).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const scheme = new URL(url).protocol
      if (scheme === 'https:' || scheme === 'http:' || scheme === 'mailto:') {
        void shell.openExternal(url)
      }
    } catch {
      // Malformed URL — ignore.
    }
    return { action: 'deny' }
  })

  // Block in-app navigation away from the app's own origin. Allow only the dev
  // server (in dev) or the packaged index.html (never arbitrary file:// URLs,
  // which would escape the app origin and its CSP).
  const appIndexUrl = pathToFileURL(join(__dirname, '../renderer/index.html')).toString()
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (devUrl && url.startsWith(devUrl)) return
    if (url === appIndexUrl || url.split('#')[0] === appIndexUrl) return
    event.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Two copies would share one database and one set of settings while each keeps its own
// idea of what is open. A second launch brings the first window forward instead.
// Development builds are exempt, so a dev run can sit beside an installed copy.
const primaryInstance = app.isPackaged ? app.requestSingleInstanceLock() : true
if (!primaryInstance) app.quit()

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

app.whenReady().then(() => {
  if (!primaryInstance) return
  initDb()
  lockDownSession()
  // Frameless window with its own chrome; the default menu only adds reload/devtools accelerators.
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
  ipc = registerIpc(() => mainWindow)
  logger.info('Cubex started', { status: 'ok' })
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    ipc?.dispose()
    closeDb()
    app.quit()
  }
})

app.on('before-quit', () => {
  // `window-all-closed` may have disposed already; both paths are idempotent,
  // and teardown is synchronous because Electron exits once this returns.
  ipc?.dispose()
  closeDb()
})

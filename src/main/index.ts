import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { registerIpc } from './ipc'
import { initDb } from './db'
import { getSettings } from './config'
import { logger } from './logger'

let mainWindow: BrowserWindow | null = null
let disposeIpc: (() => void) | null = null

function createWindow(): void {
  const settings = getSettings()
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#08080a',
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
      webSecurity: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    if (settings.general.startMaximized) mainWindow?.maximize()
    mainWindow?.show()
  })

  // Open external links in the OS browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Block in-app navigation away from the app origin.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const isDev = !!process.env.ELECTRON_RENDERER_URL
    if (isDev && url.startsWith(process.env.ELECTRON_RENDERER_URL as string)) return
    if (url.startsWith('file://')) return
    event.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  initDb()
  disposeIpc = registerIpc(() => mainWindow)
  logger.info('Cubex started', { status: 'ok' })
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    disposeIpc?.()
    app.quit()
  }
})

app.on('before-quit', () => disposeIpc?.())

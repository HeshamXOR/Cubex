import { join } from 'node:path'
import { app, Notification, nativeImage, type BrowserWindow, type NativeImage } from 'electron'
import { IPC } from '@shared/ipc'
import { renderBadge } from './badge'
import type { WindowState } from './decide'
import type { NotifyHost, Toast, ToastHandle } from './Notifier'

interface ElectronHostDeps {
  getWindow: () => BrowserWindow | null
  send: (channel: string, payload: unknown) => void
  /** The window came to the front. */
  onFocus: () => void
  /** The window lost focus, was minimized or was hidden. */
  onBlur: () => void
}

/** The few Electron calls the notifier makes. Each one fails quietly: a missing feature must never break a turn. */
export function createElectronHost(deps: ElectronHostDeps): NotifyHost {
  const watched = new WeakSet<BrowserWindow>()
  // Electron drops a notification's click handler when it is garbage collected, so live ones are kept.
  const live = new Set<Notification>()
  let icon: NativeImage | undefined

  const currentWindow = (): BrowserWindow | null => {
    const window = deps.getWindow()
    return window && !window.isDestroyed() ? window : null
  }

  // The window does not exist yet when handlers are registered, so listeners are added the first time it is seen.
  const watch = (window: BrowserWindow): void => {
    if (watched.has(window)) return
    watched.add(window)
    window.on('focus', deps.onFocus)
    window.on('blur', deps.onBlur)
    window.on('minimize', deps.onBlur)
    window.on('hide', deps.onBlur)
  }

  const appIcon = (): NativeImage | undefined => {
    if (!icon) {
      const image = nativeImage.createFromPath(join(__dirname, '../../resources/icon.png'))
      icon = image.isEmpty() ? undefined : image.resize({ width: 128, height: 128 })
    }
    return icon
  }

  return {
    windowState(): WindowState {
      const window = currentWindow()
      if (!window) return { focused: false, minimized: true, visible: false }
      watch(window)
      return { focused: window.isFocused(), minimized: window.isMinimized(), visible: window.isVisible() }
    },

    show(toast: Toast, onClick: () => void): ToastHandle | undefined {
      try {
        if (!Notification.isSupported()) return undefined
        const picture = appIcon()
        const notification = new Notification({ title: toast.title, body: toast.body, silent: toast.silent, ...(picture ? { icon: picture } : {}) })
        live.add(notification)
        notification.on('click', () => {
          live.delete(notification)
          onClick()
        })
        notification.on('close', () => live.delete(notification))
        notification.on('failed', () => live.delete(notification))
        notification.show()
        return { close: () => { live.delete(notification); notification.close() } }
      } catch {
        return undefined
      }
    },

    flash(on: boolean): void {
      try { currentWindow()?.flashFrame(on) } catch { /* the taskbar may not support it */ }
    },

    badge(count: number): void {
      try {
        if (process.platform === 'win32') {
          const window = currentWindow()
          if (!window) return
          if (count <= 0) {
            window.setOverlayIcon(null, '')
            return
          }
          const { width, height, scaleFactor, bitmap } = renderBadge(count)
          window.setOverlayIcon(nativeImage.createFromBitmap(bitmap, { width, height, scaleFactor }), `${count} ${count === 1 ? 'session needs' : 'sessions need'} you`)
        } else if (process.platform === 'darwin') {
          app.dock?.setBadge(count > 0 ? String(count) : '')
        } else {
          app.setBadgeCount(count)
        }
      } catch { /* no badge on this desktop */ }
    },

    showWindow(): void {
      const window = currentWindow()
      if (!window) return
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    },

    openConversation(conversationId: string): void {
      deps.send(IPC.notifyOpenConversation, conversationId)
    }
  }
}

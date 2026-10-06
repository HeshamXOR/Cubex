/**
 * Electron rejects a failed `ipcRenderer.invoke` with
 * `Error invoking remote method 'channel:name': Error: the real message`.
 * The channel name means nothing to a person reading an error, so the bridge
 * strips it and the renderer sees what the handler actually threw.
 */
const REMOTE_METHOD_PREFIX = /^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/

export function cleanIpcErrorMessage(message: string): string {
  const cleaned = message.replace(REMOTE_METHOD_PREFIX, '')
  return cleaned.length > 0 ? cleaned : message
}

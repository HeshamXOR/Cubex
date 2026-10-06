import { app, clipboard, Menu, shell, type BrowserWindow } from 'electron'
import { contextMenuTemplate } from './contextMenuTemplate'

/**
 * Cubex draws its own chrome and has no application menu, so without this a right-click
 * does nothing: no Paste in the composer, no Copy on selected text, no spelling help.
 */
export function installContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    const template = contextMenuTemplate(
      {
        isEditable: params.isEditable,
        selectionText: params.selectionText,
        linkURL: params.linkURL,
        misspelledWord: params.misspelledWord,
        dictionarySuggestions: params.dictionarySuggestions,
        editFlags: params.editFlags,
        x: params.x,
        y: params.y
      },
      {
        replaceMisspelling: (word) => win.webContents.replaceMisspelling(word),
        addToDictionary: (word) => { win.webContents.session.addWordToSpellCheckerDictionary(word) },
        openLink: (url) => { void shell.openExternal(url) },
        copyLink: (url) => clipboard.writeText(url),
        inspect: (x, y) => win.webContents.inspectElement(x, y)
      },
      { inspectable: !app.isPackaged }
    )
    if (template.length > 0) Menu.buildFromTemplate(template).popup({ window: win })
  })
}

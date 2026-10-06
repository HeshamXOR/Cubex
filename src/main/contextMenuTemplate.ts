import type { MenuItemConstructorOptions } from 'electron'

/** The parts of Electron's context-menu parameters the menu depends on, so the menu can be built and tested without a window. */
export interface ContextTarget {
  isEditable: boolean
  selectionText: string
  linkURL: string
  misspelledWord: string
  dictionarySuggestions: readonly string[]
  editFlags: { canUndo: boolean; canRedo: boolean; canCut: boolean; canCopy: boolean; canPaste: boolean }
  x: number
  y: number
}

export interface ContextActions {
  replaceMisspelling: (word: string) => void
  addToDictionary: (word: string) => void
  openLink: (url: string) => void
  copyLink: (url: string) => void
  inspect: (x: number, y: number) => void
}

/** The same schemes the main process opens externally for links in the thread. */
const SAFE_LINK = /^(?:https?:|mailto:)/i
const MAX_SUGGESTIONS = 5

/**
 * What a right-click offers. Text fields get editing commands (and spelling help on
 * a misspelled word), selected text in the thread gets Copy, a link gets Open and
 * Copy address. Anything else has no menu, because an empty menu is just noise.
 */
export function contextMenuTemplate(target: ContextTarget, actions: ContextActions, options: { inspectable: boolean }): MenuItemConstructorOptions[] {
  const sections: MenuItemConstructorOptions[][] = []

  if (target.isEditable && target.misspelledWord) {
    const suggestions = target.dictionarySuggestions.slice(0, MAX_SUGGESTIONS)
    sections.push([
      ...(suggestions.length > 0
        ? suggestions.map((word): MenuItemConstructorOptions => ({ label: word, click: () => actions.replaceMisspelling(word) }))
        : [{ label: 'No suggestions', enabled: false } satisfies MenuItemConstructorOptions]),
      { label: 'Add to dictionary', click: () => actions.addToDictionary(target.misspelledWord) }
    ])
  }

  if (target.linkURL && SAFE_LINK.test(target.linkURL)) {
    sections.push([
      { label: 'Open link in browser', click: () => actions.openLink(target.linkURL) },
      { label: 'Copy link address', click: () => actions.copyLink(target.linkURL) }
    ])
  }

  if (target.isEditable) {
    sections.push(
      [{ role: 'undo', enabled: target.editFlags.canUndo }, { role: 'redo', enabled: target.editFlags.canRedo }],
      [{ role: 'cut', enabled: target.editFlags.canCut }, { role: 'copy', enabled: target.editFlags.canCopy }, { role: 'paste', enabled: target.editFlags.canPaste }],
      [{ role: 'selectAll' }]
    )
  } else if (target.selectionText) {
    sections.push([{ role: 'copy' }, { role: 'selectAll' }])
  }

  if (options.inspectable) sections.push([{ label: 'Inspect element', click: () => actions.inspect(target.x, target.y) }])

  return sections.flatMap((items, index) => (index === 0 ? items : [{ type: 'separator' } satisfies MenuItemConstructorOptions, ...items]))
}

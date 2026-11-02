import { describe, expect, it, vi } from 'vitest'
import { contextMenuTemplate, type ContextActions, type ContextTarget } from './contextMenuTemplate'

const noActions = (): ContextActions => ({
  replaceMisspelling: vi.fn(), addToDictionary: vi.fn(), openLink: vi.fn(), copyLink: vi.fn(), inspect: vi.fn()
})

const target = (overrides: Partial<ContextTarget> = {}): ContextTarget => ({
  isEditable: false,
  selectionText: '',
  linkURL: '',
  misspelledWord: '',
  dictionarySuggestions: [],
  editFlags: { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: true },
  x: 10,
  y: 20,
  ...overrides
})

const names = (items: ReturnType<typeof contextMenuTemplate>): string[] => items.map((item) => item.type === 'separator' ? '|' : (item.role ?? item.label ?? '?'))

describe('contextMenuTemplate', () => {

  it('puts spelling suggestions first, capped at five, with an add-to-dictionary action', () => {
    const actions = noActions()
    const items = contextMenuTemplate(
      target({ isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'tea', 'ten', 'tech', 'tee', 'tel'] }),
      actions,
      { inspectable: false }
    )
    expect(names(items).slice(0, 7)).toEqual(['the', 'tea', 'ten', 'tech', 'tee', 'Add to dictionary', '|'])
    items[0]?.click?.({} as never, undefined, {} as never)
    expect(actions.replaceMisspelling).toHaveBeenCalledWith('the')
    items[5]?.click?.({} as never, undefined, {} as never)
    expect(actions.addToDictionary).toHaveBeenCalledWith('teh')
  })

  it('offers open and copy for web and mail links only', () => {
    const actions = noActions()
    const web = contextMenuTemplate(target({ linkURL: 'https://example.com/docs' }), actions, { inspectable: false })
    expect(names(web)).toEqual(['Open link in browser', 'Copy link address'])
    web[0]?.click?.({} as never, undefined, {} as never)
    web[1]?.click?.({} as never, undefined, {} as never)
    expect(actions.openLink).toHaveBeenCalledWith('https://example.com/docs')
    expect(actions.copyLink).toHaveBeenCalledWith('https://example.com/docs')

    expect(names(contextMenuTemplate(target({ linkURL: 'mailto:a@b.co' }), noActions(), { inspectable: false }))).toContain('Open link in browser')
    for (const unsafe of ['file:///C:/Windows/system.ini', 'javascript:alert(1)', 'smb://host/share', '#user-content-fn-1']) {
      expect(contextMenuTemplate(target({ linkURL: unsafe }), noActions(), { inspectable: false }), unsafe).toEqual([])
    }
  })
})

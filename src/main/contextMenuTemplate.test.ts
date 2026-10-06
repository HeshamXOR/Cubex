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
  it('offers nothing on plain content, so no empty menu opens', () => {
    expect(contextMenuTemplate(target(), noActions(), { inspectable: false })).toEqual([])
  })

  it('gives a text field the editing commands, with Cut and Copy following the selection', () => {
    const items = contextMenuTemplate(target({ isEditable: true, editFlags: { canUndo: true, canRedo: false, canCut: false, canCopy: false, canPaste: true } }), noActions(), { inspectable: false })
    expect(names(items)).toEqual(['undo', 'redo', '|', 'cut', 'copy', 'paste', '|', 'selectAll'])
    const byRole = Object.fromEntries(items.filter((i) => i.role).map((i) => [i.role, i.enabled]))
    expect(byRole).toMatchObject({ undo: true, redo: false, cut: false, copy: false, paste: true })
  })

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

  it('says so when a misspelled word has no suggestions', () => {
    const items = contextMenuTemplate(target({ isEditable: true, misspelledWord: 'zzxq' }), noActions(), { inspectable: false })
    expect(items[0]).toMatchObject({ label: 'No suggestions', enabled: false })
  })

  it('does not offer spelling help outside a text field', () => {
    const items = contextMenuTemplate(target({ isEditable: false, misspelledWord: 'teh', dictionarySuggestions: ['the'] }), noActions(), { inspectable: false })
    expect(items).toEqual([])
  })

  it('offers Copy for selected text in the thread', () => {
    expect(names(contextMenuTemplate(target({ selectionText: 'some words' }), noActions(), { inspectable: false }))).toEqual(['copy', 'selectAll'])
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

  it('adds Inspect element only when the build is inspectable, and then always', () => {
    const actions = noActions()
    const dev = contextMenuTemplate(target(), actions, { inspectable: true })
    expect(names(dev)).toEqual(['Inspect element'])
    dev[0]?.click?.({} as never, undefined, {} as never)
    expect(actions.inspect).toHaveBeenCalledWith(10, 20)
    expect(names(contextMenuTemplate(target({ selectionText: 'x' }), noActions(), { inspectable: true }))).toEqual(['copy', 'selectAll', '|', 'Inspect element'])
  })
})

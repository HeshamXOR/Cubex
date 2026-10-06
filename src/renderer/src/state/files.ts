import { create } from 'zustand'
import { api } from '../lib/api'
import { ancestorsOf } from '../lib/pathLinks'
import { flattenTree, type Listing } from '../lib/fileTree'
import { useStore } from './store'

const HIDDEN_KEY = 'cubex.files.hidden'

function storedShowHidden(): boolean {
  try { return localStorage.getItem(HIDDEN_KEY) === '1' } catch { return false }
}

/** The task whose files the panel shows: its own folder, or the selected folder when no task is open. */
interface FilesTask {
  /** Changes whenever the tree has to start over. */
  owner: string
  conversationId: string | undefined
  workspace: string | undefined
}

export function currentTask(state = useStore.getState()): FilesTask {
  const conversationId = state.activeConversation?.id
  const workspace = state.activeConversation ? state.activeConversation.workspacePath : state.settings?.general.workspacePath
  return { owner: `${conversationId ?? ''}|${workspace ?? ''}`, conversationId, workspace }
}

interface FilesState {
  owner: string
  conversationId: string | undefined
  showHidden: boolean
  listings: Record<string, Listing>
  expanded: Record<string, true>
  /** The file open in the preview. */
  selected: string | undefined
  /** The line to scroll to and mark in it. */
  line: number | undefined
  /** The row the keyboard is on in the tree. */
  cursor: string | undefined
  /** Counts every request to look at something, so asking for the same line twice scrolls twice. */
  focus: number
  /** In a narrow panel, which half is showing. */
  pane: 'tree' | 'file'
  /** Markdown and SVG files show as written instead of rendered. */
  source: boolean

  bind: (task: Pick<FilesTask, 'owner' | 'conversationId'>) => void
  load: (dir: string) => Promise<void>
  toggle: (dir: string) => void
  setShowHidden: (show: boolean) => void
  refresh: () => void
  select: (path: string, line?: number) => Promise<void>
  showFolder: (path: string) => Promise<void>
  closeFile: () => void
  setCursor: (path: string | undefined) => void
  setSource: (source: boolean) => void
}

/** Answers from before the tree started over are dropped. */
let generation = 0

export const useFiles = create<FilesState>()((set, get) => ({
  owner: '',
  conversationId: undefined,
  showHidden: storedShowHidden(),
  listings: {},
  expanded: {},
  selected: undefined,
  line: undefined,
  cursor: undefined,
  focus: 0,
  pane: 'tree',
  source: false,

  bind: ({ owner, conversationId }) => {
    if (get().owner === owner) return
    generation++
    set({ owner, conversationId, listings: {}, expanded: {}, selected: undefined, line: undefined, cursor: undefined, pane: 'tree', source: false })
  },

  load: async (dir) => {
    const { conversationId, showHidden, listings } = get()
    const token = generation
    // A folder that is being reloaded keeps showing what it had until the new answer arrives.
    if (!listings[dir] || listings[dir]!.status === 'error') set({ listings: { ...listings, [dir]: { status: 'loading', entries: [], omitted: 0 } } })
    try {
      const { entries, omitted } = await api.listWorkspaceDir(dir, conversationId, { showHidden })
      if (token !== generation || showHidden !== get().showHidden) return
      set((state) => ({ listings: { ...state.listings, [dir]: { status: 'ready', entries, omitted } } }))
    } catch (cause) {
      if (token !== generation) return
      const error = cause instanceof Error ? cause.message : 'This folder could not be read.'
      set((state) => ({ listings: { ...state.listings, [dir]: { status: 'error', entries: [], omitted: 0, error } } }))
    }
  },

  toggle: (dir) => {
    const { expanded, listings } = get()
    if (expanded[dir]) {
      const rest = { ...expanded }
      delete rest[dir]
      set({ expanded: rest })
      return
    }
    set({ expanded: { ...expanded, [dir]: true } })
    if (!listings[dir] || listings[dir]!.status === 'error') void get().load(dir)
  },

  setShowHidden: (show) => {
    if (show === get().showHidden) return
    try { localStorage.setItem(HIDDEN_KEY, show ? '1' : '0') } catch { /* the choice just will not persist */ }
    generation++
    // The same folders stay open and are listed afresh under the new rule; what was on screen stays until the answers arrive.
    set({ showHidden: show })
    get().refresh()
  },

  refresh: () => {
    const { listings, expanded } = get()
    const open = flattenTree(listings, new Set(Object.keys(expanded))).flatMap((row) => (row.kind === 'dir' && row.open ? [row.path] : []))
    for (const dir of ['', ...open]) void get().load(dir)
  },

  select: async (path, line) => {
    const parents = ancestorsOf(path)
    set((state) => ({
      selected: path,
      line,
      cursor: path,
      focus: state.focus + 1,
      pane: 'file',
      expanded: { ...state.expanded, ...Object.fromEntries(parents.map((parent) => [parent, true as const])) }
    }))
    await Promise.all(['', ...parents].filter((dir) => !get().listings[dir] || get().listings[dir]!.status === 'error').map((dir) => get().load(dir)))
  },

  showFolder: async (path) => {
    const chain = [...ancestorsOf(path), path]
    set((state) => ({
      cursor: path,
      focus: state.focus + 1,
      pane: 'tree',
      expanded: { ...state.expanded, ...Object.fromEntries(chain.map((dir) => [dir, true as const])) }
    }))
    await Promise.all(['', ...chain].filter((dir) => !get().listings[dir] || get().listings[dir]!.status === 'error').map((dir) => get().load(dir)))
  },

  closeFile: () => set({ selected: undefined, line: undefined, pane: 'tree' }),
  setCursor: (cursor) => set({ cursor }),
  setSource: (source) => set({ source })
}))

function bindToCurrentTask(): void {
  const task = currentTask()
  useFiles.getState().bind(task)
}

/** Open the Files tab on a file, at a line when one is known. Used by every path link in the conversation. */
export function openFile(path: string, line?: number): void {
  bindToCurrentTask()
  useStore.setState({ panelOpen: true, panelTab: 'files' })
  void useFiles.getState().select(path, line)
}

/** Open the Files tab with a folder revealed in the tree. */
export function openFolder(path: string): void {
  bindToCurrentTask()
  useStore.setState({ panelOpen: true, panelTab: 'files' })
  void useFiles.getState().showFolder(path)
}
